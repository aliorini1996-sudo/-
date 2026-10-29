/**
 * تكامل ERP — دفع العملاء والمنتجات والفواتير والسندات إلى نظامٍ خارجي (Odoo عبر وحدة fieldsales_connector أو أي REST).
 *
 * - **كل السجلات على دفعات** (ERP_PAGE_SIZE) لا آخر ٥٠٠: أول مزامنة كل شيء، وبعدها ما تغيّر منذ بدء آخر مزامنة
 *   نظيفة (SUCCESS) بتداخل دقيقتين. المزامنة الجزئية (أخطاء صفوف) أو الفاشلة لا تُقدّم المؤشر — فيُعاد إرسال ما لم
 *   يصل (الترحيل upsert بمعرّف Field Sales فلا تكرار).
 * - **نتيجة صادقة**: ردّ Odoo يُقرأ (المنشأ والمحدَّث والأخطاء وتفاصيلها) — SUCCESS / PARTIAL / FAILED بسجلّ واحد لكل قسم.
 * - **في الخلفية** (startErpSync) بقفلٍ لكل شركة، ومهلة لكل طلب — لا مزامنة معلّقة داخل طلب HTTP.
 * - **رابطٌ آمن**: https وحده، ولا عنوان داخلي (تُحلّ الأسماء ويُفحص كل عنوان)، والمفاتيح مشفّرة في القاعدة (erpSecrets).
 * - مع Odoo يُرسل كل شيء إلى الرابط نفسه (/fieldsales/sync) والقسم في الجسم؛ ومع غيره رابط لكل قسم كما ضُبط.
 */
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import prisma from '../config/database';
import { isPublicIp } from './geoLink';
import { openErpSecret } from './erpSecrets';
import { readPaymentMethodsConfig, type PaymentMethodsConfigV1 } from './paymentMethodsCore';
import {
  ERP_PAGE_SIZE, ERP_REQUEST_TIMEOUT_MS, ERP_RESOURCES, ERP_SYNC_V2_SINCE, ERP_WATERMARK_OVERLAP_MS,
  companyTimeZone, customerPayloadRow, erpEnvelope, erpUrlProblem, invoicePayloadRow, parseErpResponse, productPayloadRow,
  receiptPayloadRow, summarizeErpRun, type ErpChunkResult, type ErpInvoiceInput, type ErpReceiptInput, type ErpResource,
  type ErpRunTotals,
} from './erpPayload';

type ErpIntegration = NonNullable<Awaited<ReturnType<typeof prisma.erpIntegration.findUnique>>>;
export type { ErpResource } from './erpPayload';

const endpointField: Record<ErpResource, 'customersEndpoint' | 'productsEndpoint' | 'invoicesEndpoint' | 'receiptsEndpoint'> = {
  customers: 'customersEndpoint',
  products: 'productsEndpoint',
  invoices: 'invoicesEndpoint',
  receipts: 'receiptsEndpoint',
};

const syncField: Record<ErpResource, 'syncCustomers' | 'syncProducts' | 'syncInvoices' | 'syncReceipts'> = {
  customers: 'syncCustomers',
  products: 'syncProducts',
  invoices: 'syncInvoices',
  receipts: 'syncReceipts',
};

function joinUrl(baseUrl: string, endpoint?: string | null) {
  if (!endpoint) return baseUrl;
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
}

/** رابط القسم: وحدة Odoo تستقبل كل الأقسام على الرابط نفسه (القسم في الجسم)، فمسارات الأقسام لا تُضاف إليه */
export function erpResourceUrl(config: Pick<ErpIntegration, 'provider' | 'baseUrl' | 'customersEndpoint' | 'productsEndpoint' | 'invoicesEndpoint' | 'receiptsEndpoint'>, resource: ErpResource): string {
  if (!config.baseUrl) throw new Error('رابط ERP مطلوب');
  return config.provider === 'ODOO' ? config.baseUrl : joinUrl(config.baseUrl, config[endpointField[resource]]);
}

function headers(config: ErpIntegration) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = config.tenantId;
  if (config.authType === 'API_KEY' && config.apiKey) h['X-API-Key'] = openErpSecret(t, config.apiKey);
  if (config.authType === 'BEARER' && config.bearerToken) h.Authorization = `Bearer ${openErpSecret(t, config.bearerToken)}`;
  if (config.authType === 'BASIC' && config.basicUsername && config.basicPassword) {
    h.Authorization = `Basic ${Buffer.from(`${config.basicUsername}:${openErpSecret(t, config.basicPassword)}`).toString('base64')}`;
  }
  return h;
}

/** https وحده، ولا عنوانَ داخلياً بعد حلّ الاسم — وإلا صار التكامل نافذةً إلى شبكة الخادم الداخلية */
export async function assertSafeErpUrl(raw: string): Promise<void> {
  const problem = erpUrlProblem(raw);
  if (problem) throw new Error(problem);
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error('تعذّر الوصول إلى عنوان ERP — تحقّق من الرابط');
  if (addrs.some((a) => !isPublicIp(a))) throw new Error('رابط ERP يشير إلى شبكة داخلية — غير مسموح');
}

async function postJson(url: string, config: ErpIntegration, body: unknown): Promise<ErpChunkResult> {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: headers(config), body: JSON.stringify(body),
      signal: AbortSignal.timeout(ERP_REQUEST_TIMEOUT_MS), redirect: 'error',
    });
    const text = await response.text().catch(() => '');
    return parseErpResponse(response.status, text);
  } catch (err) {
    const e = err as Error;
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      ok: false, httpStatus: 0, created: 0, updated: 0, unchanged: 0, errors: 0, errorDetails: [],
      message: timeout ? `انتهت مهلة ERP (${ERP_REQUEST_TIMEOUT_MS / 1000} ث)` : `تعذّر الاتصال بـERP: ${e?.message ?? e}`,
    };
  }
}

/** بداية ما يُرسل: بدء آخر مزامنة نظيفة لهذا القسم ناقص التداخل — ولا شيء قبل الإصدار الثاني (يُرسل الكل) */
async function watermark(tenantId: string, resource: ErpResource): Promise<Date | null> {
  const last = await prisma.erpSyncLog.findFirst({
    where: { tenantId, resource, status: 'SUCCESS', startedAt: { gte: ERP_SYNC_V2_SINCE } },
    orderBy: { startedAt: 'desc' }, select: { startedAt: true },
  });
  return last ? new Date(last.startedAt.getTime() - ERP_WATERMARK_OVERLAP_MS) : null;
}

async function tenantTimeZone(tenantId: string): Promise<string> {
  const [gl, company] = await Promise.all([
    prisma.glSettings.findUnique({ where: { tenantId }, select: { timezone: true } }).catch(() => null),
    prisma.companySettings.findUnique({ where: { tenantId }, select: { countryCode: true } }).catch(() => null),
  ]);
  return companyTimeZone(gl?.timezone, company?.countryCode);
}

type PageCursor = { updatedAt: Date; id: string };

/**
 * صفحةٌ من القسم بترتيب ثابت (آخر تعديل ثم المعرّف) بعد مؤشّرٍ ثابت لا برقم صفحة: سجلٌّ يُعدَّل أثناء المزامنة
 * ينتقل إلى آخر الترتيب، فلو كانت الصفحات بالإزاحة (skip) لانزاح ما بعده خانةً وسقط جاره من المزامنة إلى الأبد.
 */
/**
 * إعداد «إدارة طرق الدفع» للشركة (null = الأسماء الافتراضية). تعذّر القراءة لا يوقف المزامنة: الاسم الافتراضي يُرسل.
 * والاسم لقطةُ لحظة التصدير: علامة المزامنة updatedAt، فإعادة تسمية طريقة لا تعيد إرسال سنداتٍ قديمة.
 */
async function tenantPaymentMethods(tenantId: string): Promise<PaymentMethodsConfigV1 | null> {
  const row = await prisma.companySettings.findUnique({ where: { tenantId }, select: { paymentMethodsConfig: true } }).catch(() => null);
  return readPaymentMethodsConfig(row?.paymentMethodsConfig ?? null);
}

async function readPage(tenantId: string, resource: ErpResource, since: Date | null, after: PageCursor | null, timeZone: string, methods: PaymentMethodsConfigV1 | null = null): Promise<unknown[]> {
  const where = {
    tenantId,
    ...(since ? { updatedAt: { gt: since } } : {}),
    ...(after ? { OR: [{ updatedAt: { gt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { gt: after.id } }] } : {}),
  };
  const page = { orderBy: [{ updatedAt: 'asc' as const }, { id: 'asc' as const }], take: ERP_PAGE_SIZE };
  if (resource === 'customers') {
    return (await prisma.customer.findMany({ where, ...page })).map((c) => customerPayloadRow(c as unknown as Record<string, unknown>));
  }
  if (resource === 'products') {
    // المؤرشف (deletedAt) يُرسل أيضاً فيُؤرشف في ERP — لا يبقى نشطاً هناك إلى الأبد
    // ووحداته (كرتون = ٢٤ حبة) بترتيب العقد — تعديلها يحدّث updatedAt الصنف فيُعاد إرساله معها
    const rows = await prisma.product.findMany({
      where, include: { category: true, priceTiers: true, units: { orderBy: [{ sortOrder: 'asc' }, { factor: 'asc' }] } }, ...page,
    });
    return rows.map((p) => productPayloadRow(p as unknown as Record<string, unknown>));
  }
  if (resource === 'invoices') {
    const rows = await prisma.invoice.findMany({
      where,
      include: {
        customer: { select: { id: true, code: true, name: true } },
        salesRep: { select: { id: true, name: true, phone: true } },
        // unit (اسم الأساس) وunitCode (رمزه) يصفان البند المحوَّل إلى الأساس في الحمولة (erpPayload.invoiceItemPayloadRow)
        items: { include: { product: { select: { id: true, code: true, name: true, unit: true, unitCode: true, barcode: true, taxPct: true } } } },
        originalInvoice: { select: { number: true } },
      },
      ...page,
    });
    return rows.map((inv) => invoicePayloadRow(inv as unknown as ErpInvoiceInput, timeZone));
  }
  const rows = await prisma.receipt.findMany({
    where,
    include: {
      customer: { select: { id: true, code: true, name: true } },
      salesRep: { select: { id: true, name: true, phone: true } },
      invoiceItems: { select: { invoiceId: true, amount: true, invoice: { select: { number: true } } } },
    },
    ...page,
  });
  return rows.map((r) => receiptPayloadRow(r as unknown as ErpReceiptInput, timeZone, methods));
}

/** اختبار الاتصال: مع Odoo طلب ping بالمفتاح (يتحقّق من الرابط والمفتاح معاً)، ومع غيره GET على الرابط */
export async function testErpConnection(config: ErpIntegration) {
  if (!config.baseUrl) throw new Error('رابط ERP مطلوب');
  await assertSafeErpUrl(config.baseUrl);
  const startedAt = new Date();
  if (config.provider === 'ODOO') {
    const r = await postJson(config.baseUrl, config, erpEnvelope('ping', []));
    return { ok: r.ok, status: r.httpStatus, message: r.ok ? 'تم الاتصال بنجاح — الرابط والمفتاح صحيحان' : r.message, startedAt, finishedAt: new Date() };
  }
  const response = await fetch(config.baseUrl, { method: 'GET', headers: headers(config), signal: AbortSignal.timeout(30_000), redirect: 'error' });
  return {
    ok: response.ok, status: response.status,
    message: response.ok ? 'تم الاتصال بنجاح' : `فشل الاتصال ${response.status}`,
    startedAt, finishedAt: new Date(),
  };
}

/** يزامن قسماً واحداً كاملاً على دفعات ويكتب سجلاً واحداً بنتيجته الصادقة */
export async function syncErpResource(tenantId: string, resource: ErpResource) {
  const config = await prisma.erpIntegration.findUnique({ where: { tenantId } });
  if (!config?.enabled) throw new Error('تكامل ERP غير مفعل');
  if (!config.baseUrl) throw new Error('رابط ERP مطلوب');
  if (!config[syncField[resource]]) throw new Error('مزامنة هذا القسم غير مفعلة');

  const startedAt = new Date();
  const totals: ErpRunTotals = { sent: 0, created: 0, updated: 0, unchanged: 0, errors: 0, errorDetails: [], failed: null };
  try {
    const url = erpResourceUrl(config, resource);
    await assertSafeErpUrl(url);
    const [since, timeZone, methods] = await Promise.all([
      watermark(tenantId, resource), tenantTimeZone(tenantId),
      // «إدارة طرق الدفع»: أسماء الشركة لطرق سنداتها — للسندات وحدها
      resource === 'receipts' ? tenantPaymentMethods(tenantId) : Promise.resolve(null),
    ]);
    let after: PageCursor | null = null;
    for (;;) {
      const rows = await readPage(tenantId, resource, since, after, timeZone, methods);
      if (!rows.length) break;
      const last = rows[rows.length - 1] as { updatedAt: Date; id: string };
      after = { updatedAt: last.updatedAt, id: last.id };
      const r = await postJson(url, config, erpEnvelope(resource, rows));
      if (!r.ok) { totals.failed = r.message; break; }
      totals.sent += rows.length;
      totals.created += r.created;
      totals.updated += r.updated;
      totals.unchanged = (totals.unchanged ?? 0) + r.unchanged;
      totals.errors += r.errors;
      totals.errorDetails.push(...r.errorDetails);
      if (rows.length < ERP_PAGE_SIZE) break;
    }
  } catch (err) {
    totals.failed = (err as Error).message || 'تعذرت المزامنة';
  }

  const { status, message } = summarizeErpRun(totals);
  await prisma.erpSyncLog.create({
    data: { tenantId, resource, status, count: totals.sent, message, startedAt, finishedAt: new Date() },
  });
  if (status !== 'FAILED') await prisma.erpIntegration.update({ where: { tenantId }, data: { lastSyncAt: new Date() } });
  return { resource, status, count: totals.sent, created: totals.created, updated: totals.updated, errors: totals.errors, message };
}

/** الأقسام المفعّلة بترتيب التبعية (العملاء والمنتجات قبل الفواتير والسندات) */
export async function syncErpAll(tenantId: string, only?: ErpResource) {
  const config = await prisma.erpIntegration.findUnique({ where: { tenantId } });
  const resources = (only ? [only] : ERP_RESOURCES).filter((r) => !!config?.[syncField[r]]);
  const results = [];
  for (const resource of resources) {
    try {
      results.push(await syncErpResource(tenantId, resource));
    } catch (err) {
      results.push({ resource, status: 'FAILED', count: 0, message: (err as Error).message });
    }
  }
  return results;
}

const running = new Set<string>();

export function isErpSyncRunning(tenantId: string): boolean {
  return running.has(tenantId);
}

/**
 * يبدأ المزامنة في الخلفية ويعود فوراً (أول مزامنة قد تطول دقائق مع آلاف الفواتير — لا تُحبس داخل طلب HTTP).
 * false إن كانت مزامنة الشركة جارية. والنتيجة في سجلّ المزامنة.
 */
export function startErpSync(tenantId: string, only?: ErpResource): boolean {
  if (running.has(tenantId)) return false;
  running.add(tenantId);
  void syncErpAll(tenantId, only)
    .catch((err) => console.error('erp sync error:', (err as Error)?.message))
    .finally(() => running.delete(tenantId));
  return true;
}
