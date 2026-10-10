/**
 * حمولة تكامل ERP — صرفة بلا Prisma ولا شبكة، فيختبرها backend ويبني منها الاختبار الحيّ على Odoo 17
 * (.github/workflows/odoo-connector.yml) الحمولةَ نفسها التي يرسلها الخادم.
 *
 * العقد (integrations/odoo/fieldsales_connector/mapping.py):
 *   POST <الرابط> {source:'field-sales', resource, exportedAt, count, data:[صفوف بأسماء حقول Prisma]}
 * والصفوف كما في القاعدة مع حقول مشتقة صريحة حيث يلزم المستقبِل، وبلا الثقيل الذي لا يلزمه (صور المنتجات
 * ولقطة الفوترة الإلكترونية) — صورةٌ واحدة بـbase64 كانت تكفي لتجاوز سقف ١٢ ميغابايت في Odoo.
 */
import { netFromInclusive, roundHalfUp } from '../lib/money';

export type ErpResource = 'customers' | 'products' | 'invoices' | 'receipts';
/** ترتيب التبعية: العميل قبل فاتورته وسنده، والمنتج قبل بند فاتورته */
export const ERP_RESOURCES: readonly ErpResource[] = Object.freeze(['customers', 'products', 'invoices', 'receipts'] as ErpResource[]);
/** صفوف كل طلب: دفعات صغيرة تبقى تحت سقف الحجم والمهلة في المستقبِل */
export const ERP_PAGE_SIZE = 200;
/** مهلة الطلب الواحد — مستقبِلٌ معلّق لا يحبس المزامنة إلى الأبد */
export const ERP_REQUEST_TIMEOUT_MS = 120_000;
/** تداخل المؤشر: ما تغيّر قبيل بدء آخر مزامنة نظيفة بدقيقتين يُعاد إرساله (الترحيل upsert فلا تكرار) */
export const ERP_WATERMARK_OVERLAP_MS = 2 * 60_000;
/**
 * المزامنات «الناجحة» قبل هذا الإصدار لا تُعتمد مؤشراً: كانت ترسل آخر ٥٠٠ صفّ فقط وتُسجَّل نجاحاً ولو رفض
 * المستقبِل كل فواتير البيع — فأول مزامنة بعده ترسل كل السجلات.
 */
export const ERP_SYNC_V2_SINCE = new Date('2026-10-10T00:00:00Z');

/** منطقة الشركة الزمنية لتواريخها المحلية — إعدادات الدفاتر إن وُجدت، وإلا بلدها */
export const COUNTRY_TIMEZONE: Readonly<Record<string, string>> = Object.freeze({
  SA: 'Asia/Riyadh', AE: 'Asia/Dubai', KW: 'Asia/Kuwait', QA: 'Asia/Qatar', BH: 'Asia/Bahrain', OM: 'Asia/Muscat',
  YE: 'Asia/Aden', IQ: 'Asia/Baghdad', JO: 'Asia/Amman', SY: 'Asia/Damascus', LB: 'Asia/Beirut', PS: 'Asia/Gaza',
  EG: 'Africa/Cairo', SD: 'Africa/Khartoum', LY: 'Africa/Tripoli', TN: 'Africa/Tunis', DZ: 'Africa/Algiers',
  MA: 'Africa/Casablanca', MR: 'Africa/Nouakchott', TR: 'Europe/Istanbul',
});

export function companyTimeZone(ledgerTimeZone: string | null | undefined, countryCode: string | null | undefined): string {
  if (ledgerTimeZone) return ledgerTimeZone;
  return COUNTRY_TIMEZONE[String(countryCode ?? '').toUpperCase()] ?? 'Asia/Riyadh';
}

/** التاريخ المحلي YYYY-MM-DD للحظةٍ بمنطقة الشركة — اقتطاع UTC يُرجع فواتير ما بعد منتصف الليل يوماً */
export function localDateIn(d: Date | string | null | undefined, timeZone: string): string | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
}

type Rec = Record<string, unknown>;

/** المنتج بلا صورته (base64): لا يلزم المستقبِل ويُضخّم الحمولة */
export function productPayloadRow<T extends Rec>(p: T): Omit<T, 'image'> {
  const { image: _image, ...rest } = p as T & { image?: unknown };
  void _image;
  return rest;
}

export function customerPayloadRow<T extends Rec>(c: T): T {
  return c;
}

export interface ErpInvoiceItemInput extends Rec {
  unitPrice: number;
  taxPct: number;
  taxAmt: number;
  lineTotal: number;
  product?: Rec | null;
}

export interface ErpInvoiceInput extends Rec {
  invoiceDate: Date | string;
  pricesIncludeTax?: boolean | null;
  total: number;
  taxAmt: number;
  items: ErpInvoiceItemInput[];
  originalInvoice?: { number: string } | null;
}

/**
 * الفاتورة كما في القاعدة مع حقول مشتقة صريحة (payloadVersion 2):
 *  - `unitPriceNet`: سعر الوحدة **صافياً قبل الضريبة** — المستقبِل (كأي نظام محاسبي) يحسب الضريبة فوق السعر،
 *    وفواتير تطبيق المندوب تخزّنه شاملاً.
 *  - `netAmount`: صافي البند بعد خصم البند **وحصّته من خصم الفاتورة الكلّي** قبل الضريبة (lineTotal − taxAmt).
 *  - `invoiceDateLocal`: تاريخ الفاتورة بمنطقة الشركة. `originalInvoiceNumber`: مرجع الإشعار.
 * وبلا لقطة الفوترة الإلكترونية ورمز QR (لا يلزمان المستقبِل) وبلا صور منتجات البنود.
 */
export function invoicePayloadRow(inv: ErpInvoiceInput, timeZone: string): Rec {
  const { einvoiceSnapshot: _snap, einvoiceQr: _qr, originalInvoice, items, ...rest } = inv as ErpInvoiceInput & { einvoiceSnapshot?: unknown; einvoiceQr?: unknown };
  void _snap; void _qr;
  const incl = inv.pricesIncludeTax === true;
  return {
    ...rest,
    payloadVersion: 2,
    invoiceDateLocal: localDateIn(inv.invoiceDate, timeZone),
    // الوعاء الخاضع للضريبة — صحيح في الوضعين (الإجمالي ناقص الضريبة)
    taxableBase: roundHalfUp(inv.total - inv.taxAmt, 3),
    originalInvoiceNumber: originalInvoice?.number ?? null,
    items: items.map((it) => ({
      ...it,
      product: it.product ? productPayloadRow(it.product) : null,
      unitPriceNet: incl ? roundHalfUp(netFromInclusive(it.unitPrice, it.taxPct), 4) : it.unitPrice,
      netAmount: roundHalfUp(it.lineTotal - it.taxAmt, 3),
    })),
  };
}

export interface ErpReceiptInput extends Rec {
  receiptDate: Date | string;
  invoiceItems?: { invoiceId: string; amount: number; invoice?: { number: string } | null }[];
}

/** السند مع الفواتير التي دُفع مقابلها (allocations) وتاريخه المحلي — بلا كائنات الفواتير كاملة */
export function receiptPayloadRow(r: ErpReceiptInput, timeZone: string): Rec {
  const { invoiceItems, ...rest } = r;
  return {
    ...rest,
    // الصيغة القديمة باقية لمستقبِلٍ عام يقرؤها (ERP غير Odoo) — بأرقام الفواتير لا كائناتها كاملة
    invoiceItems: (invoiceItems ?? []).map((a) => ({ invoiceId: a.invoiceId, amount: a.amount, invoice: a.invoice ? { number: a.invoice.number } : null })),
    receiptDateLocal: localDateIn(r.receiptDate, timeZone),
    allocations: (invoiceItems ?? []).map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: a.invoice?.number ?? null, amount: a.amount })),
  };
}

export function erpEnvelope(resource: ErpResource | 'ping', data: readonly unknown[], now = new Date()) {
  return { source: 'field-sales', resource, exportedAt: now.toISOString(), count: data.length, data };
}

// ═══ ردّ المستقبِل ═══

export interface ErpChunkResult {
  ok: boolean;
  httpStatus: number;
  created: number;
  updated: number;
  errors: number;
  errorDetails: { id: string | null; error: string }[];
  message: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * يقرأ ردّ المستقبِل: غير 2xx أو {ok:false} ⇒ فشل؛ و2xx بجسم Odoo ⇒ أعداد المنشأ والمحدَّث والأخطاء وتفاصيلها
 * (كانت المزامنة تُسجَّل «نجحت» ولو رفض Odoo صفوفاً)؛ و2xx بغير JSON (ERP عام) ⇒ نجاح بلا تفاصيل.
 */
export function parseErpResponse(httpStatus: number, text: string): ErpChunkResult {
  const base = { httpStatus, created: 0, updated: 0, errors: 0, errorDetails: [] as { id: string | null; error: string }[] };
  if (httpStatus < 200 || httpStatus >= 300) {
    let detail = text;
    try { const j = JSON.parse(text); if (j && typeof j.error === 'string') detail = j.error; } catch { /* نصّ خام */ }
    return { ...base, ok: false, message: `فشل ERP ${httpStatus}${detail ? ` - ${detail.slice(0, 300)}` : ''}` };
  }
  let body: Rec | null = null;
  try { body = JSON.parse(text) as Rec; } catch { body = null; }
  if (!body || typeof body !== 'object') return { ...base, ok: true, message: 'تمت المزامنة' };
  if (body.ok === false) return { ...base, ok: false, message: `رفض ERP: ${String(body.error ?? 'خطأ غير معروف').slice(0, 300)}` };
  const details = Array.isArray(body.error_details)
    ? (body.error_details as Rec[]).map((e) => ({ id: e?.id == null ? null : String(e.id), error: String(e?.error ?? '') }))
    : [];
  return {
    ...base, ok: true,
    created: num(body.created), updated: num(body.updated), errors: num(body.errors), errorDetails: details,
    message: 'تمت المزامنة',
  };
}

export interface ErpRunTotals { sent: number; created: number; updated: number; errors: number; errorDetails: { id: string | null; error: string }[]; failed: string | null }

/** حالة التشغيل ورسالته: فشل نقلٍ ⇒ FAILED؛ أخطاء صفوف ⇒ PARTIAL (لا يُقدَّم المؤشر)؛ وإلا SUCCESS */
export function summarizeErpRun(t: ErpRunTotals): { status: 'SUCCESS' | 'PARTIAL' | 'FAILED'; message: string } {
  const counts = `أُرسل ${t.sent}، أُنشئ ${t.created}، حُدّث ${t.updated}`;
  const firstErrors = t.errorDetails.slice(0, 5).map((e) => `${e.id ? e.id.slice(0, 8) : '—'}: ${e.error}`).join(' | ');
  if (t.failed) return { status: 'FAILED', message: `${t.failed}${t.sent ? ` (${counts} قبل الفشل)` : ''}`.slice(0, 1000) };
  if (t.errors > 0) return { status: 'PARTIAL', message: `${counts}، وتعذّر ${t.errors}: ${firstErrors}`.slice(0, 1000) };
  return { status: 'SUCCESS', message: t.sent ? `تمت المزامنة: ${counts}` : 'لا جديد منذ آخر مزامنة' };
}

/** الرابط: https وحده (المفتاح يُرسل في الترويسة)، وبلا اسم مستخدم/كلمة مرور فيه */
export function erpUrlProblem(raw: string | null | undefined): string | null {
  if (!raw) return 'رابط ERP مطلوب';
  let u: URL;
  try { u = new URL(raw); } catch { return 'رابط ERP غير صالح'; }
  if (u.protocol !== 'https:') return 'رابط ERP يجب أن يبدأ بـ https:// — المفتاح يُرسل مع كل طلب';
  if (u.username || u.password) return 'لا تضع اسم المستخدم أو كلمة المرور داخل الرابط — استعمل حقول المصادقة';
  if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local') || u.hostname.endsWith('.internal')) {
    return 'رابط ERP يشير إلى شبكة داخلية — غير مسموح';
  }
  return null;
}
