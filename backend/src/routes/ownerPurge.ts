/**
 * «الحذف النهائي» — لمالك المنصة وحده داخل جلسة «دخول» أصدرها هو (لا موظف المنصة، ولا مدير الشركة، ولا مفتاح API).
 * المحرّك في services/ownerPurge.ts. كل حذفٍ سطرٌ في سجل نشاط المنصة (PlatformAuditLog) بما حُذف.
 */
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import {
  assertPurgeAllowedForBooks, assertPurgeKeepsSupplierBills, buildPurgePlan, delegateOf, labelFieldsOf, purgeInTx, PurgeRefused, targetableModels,
  type PurgePlan,
} from '../services/ownerPurge';
import { findArchivedProducts, mergeArchivedProduct, MergeRefused } from '../services/productTwins';
import { asLotBusy } from '../services/lots';
// «رقم العميل» (طلب المالك ٢٣ نوفمبر ٢٠٢٦): بحث العميل برقمه التسلسليّ مطابقةً تامّة، والتسمية «#12 · …»
import { customerNumberQuery, hoistExactCustomer } from '../services/customerNumber';
// «أرشيف العميل — السجل الزمني» (طلب المالك ٢٦ نوفمبر ٢٠٢٦): ما يحذفه المالك نهائياً من العميل أو له يبقى أثره في سجلّ العميل
import {
  activityMeta, catalogOrderCustomers, countByCustomer, hasActivityTable, perCustomerEvents, productCustomerPriceEvents, recordActivityInTx,
  repDeleteEvents, type ActivityInput, type ActivityMeta,
} from '../services/customerActivityEvents';
import { balanceEffect, invoiceEventInput, receiptEventInput } from '../services/customerActivityDocs';

const router = Router();

/** جلسة المالك نفسه: توكن «دخول» مُصدِره المالك (byKind OWNER) — authenticate تحقّق أن المُصدِر حيّ */
export function isPlatformOwnerSession(req: AuthRequest): boolean {
  const u = req.user as unknown as { impersonated?: boolean; byKind?: string; staffFull?: boolean; apiKeyId?: string } | undefined;
  // وموظف المنصة بكل الصلاحيات (staffFull حيّ من authenticate) كالمالك تماماً — أمر المالك ٩ نوفمبر ٢٠٢٦
  return u?.impersonated === true && (u?.byKind === 'OWNER' || (u?.byKind === 'STAFF' && u?.staffFull === true)) && !u?.apiKeyId;
}

router.use(authenticate);
router.use((req: AuthRequest, res: Response, next: NextFunction) => {
  if (!isPlatformOwnerSession(req)) { res.status(403).json({ success: false, code: 'OWNER_ONLY', message: 'الحذف النهائي لمالك المنصة وحده' }); return; }
  next();
});

const MODEL = z.string().min(1).max(64).regex(/^[A-Z][A-Za-z0-9]*$/);

/** أنواع السجلات القابلة للحذف */
router.get('/models', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: targetableModels().map((m) => ({ model: m, fields: labelFieldsOf(m) })) });
});

/** بحث بالرقم/الاسم/الرمز أو المعرّف — ٢٠ نتيجة */
router.get('/search', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const model = MODEL.parse(req.query.model);
    const q = String(req.query.q ?? '').trim().slice(0, 120);
    if (!targetableModels().includes(model)) { res.status(400).json({ success: false, message: 'نوع غير معروف' }); return; }
    const fields = labelFieldsOf(model);
    const or: Array<Record<string, unknown>> = q ? fields.map((f) => ({ [f]: { contains: q, mode: 'insensitive' } })) : [];
    if (q) or.push({ id: q });
    const select: Record<string, true> = { id: true };
    for (const f of fields) select[f] = true;
    // العميل: رقمه التسلسليّ يُقرأ دائماً للتسمية، ويُطابَق تامّاً حين يكون البحث رقماً صالحاً («12» أو «#١٢»)
    const isCustomer = model === 'Customer';
    const n = isCustomer ? customerNumberQuery(q) : null;
    if (isCustomer) {
      select.number = true;
      if (n != null) or.push({ number: n });
    }
    type Row = Record<string, unknown> & { id: unknown };
    const d = (prisma as unknown as Record<string, { findMany(a: unknown): Promise<Row[]> }>)[delegateOf(model)];
    let rows = await d.findMany({
      where: { tenantId: tenantId(req), ...(or.length && { OR: or }) },
      select, take: 20,
    }).catch(() => d.findMany({ where: { tenantId: tenantId(req), ...(q && { id: q }) }, select: { id: true }, take: 20 }));
    // صاحب الرقم أوّل النتائج — وإلا قد تملأ العشرين أسماءٌ وأكوادٌ تحوي الأرقام نفسها قبله (بلا ترتيب)
    if (n != null) {
      const exact = await prisma.customer.findFirst({ where: { tenantId: tenantId(req), number: n }, select }).catch(() => null);
      rows = hoistExactCustomer(rows, exact as Row | null, 20);
    }
    res.json({ success: true, data: rows.map((r) => ({ id: String(r.id), label: purgeSearchLabel(r, fields, isCustomer) })) });
  } catch (err) { next(err); }
});

/** تسمية نتيجة البحث: حقول التسمية بـ« · » (أو المعرّف)، والعميل المرقَّم تسبقها «#رقمه · » */
export function purgeSearchLabel(r: Record<string, unknown>, fields: string[], isCustomer: boolean): string {
  const label = fields.map((f) => r[f]).filter((v) => v != null && v !== '').join(' · ') || String(r.id);
  return isCustomer && typeof r.number === 'number' ? `#${r.number} · ${label}` : label;
}

/**
 * ردّ رفض المحرّك: حالته ورمزه منه — 404 بلا رمز كما كان (غير موجود/غير معروف)، و409 BOOKS_LINKED_NO_DELETE للشركة المربوطة
 * ومعه النماذج المرحَّلة التي كانت الخطة ستمسّها
 */
function refusePurge(res: Response, err: PurgeRefused): void {
  res.status(err.status).json({
    success: false,
    ...(err.code && { code: err.code }),
    message: err.message,
    ...(err.models.length > 0 && { models: err.models }),
  });
}

const ID = z.string().min(1).max(100);
/** سجلٌّ واحد (id) أو عدّة سجلات من النوع نفسه (ids — التحديد الجماعي في القوائم، حتى ٥٠٠) */
const TARGET = z.object({ model: MODEL, id: ID.optional(), ids: z.array(ID).min(1).max(500).optional() })
  .refine((v) => !!v.id || !!v.ids?.length, { message: 'حدد سجلاً' })
  .transform((v) => ({ model: v.model, ids: v.ids?.length ? v.ids : [v.id!] }));

/** المعاينة: ما سيُحذف وما يُفرَّغ مفتاحه — بلا كتابة */
router.post('/preview', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { model, ids } = TARGET.parse(req.body);
    const tid = tenantId(req);
    const plan = await buildPurgePlan(prisma, tid, model, ids);
    // «ربط الدفاتر» (OD1): الشركة المربوطة تُرفض في المعاينة نفسها إن مسّت الخطة مستنداً مرحَّلاً — قبل أن يضغط المالك «حذف»
    await assertPurgeAllowedForBooks(prisma, tid, plan);
    // «ربط الدفاتر» L1: وحذفٌ يبتر فاتورة مورّد أو يُفرغها بحذف غيرها (الصنف) يُرفض في المعاينة نفسها لكل شركة
    await assertPurgeKeepsSupplierBills(prisma, tid, plan);
    res.json({ success: true, data: { counts: plan.counts, nullCounts: plan.nullCounts } });
  } catch (err) {
    if (err instanceof PurgeRefused) { refusePurge(res, err); return; }
    next(err);
  }
});

type Tx = Prisma.TransactionClient;
const asNum = (v: unknown): number | null => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; };
const ID_CHUNK = 1000;
const chunks = <T>(xs: readonly T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += ID_CHUNK) out.push(xs.slice(i, i + ID_CHUNK)); return out; };
const PURGED = 'OWNER_PURGE';

/**
 * نماذج قابلة للحذف النهائي تحمل عميلاً ولا حدث لحذفها في سجلّه — كلٌّ بسببه. يفرض اختبار التغطية أن كل نموذجٍ قابلٍ للاستهداف
 * يحمل customerId (أو يشير إليه العميل) له حالةٌ في purgeActivityEvents أو سببٌ هنا
 */
export const PURGE_WITHOUT_CUSTOMER_EVENT: Readonly<Record<string, string>> = {
  Notification: 'إشعارٌ لمستخدمي الشركة يذكر العميل — رسالة تنبيه لا إجراء على العميل نفسه',
  AiEstimateSnapshot: 'لقطة تقدير المندوب الذكي (حلقة التعلّم) — بيانات تحليلية لا إجراء على العميل',
};

/**
 * المستندات المالية التي تحذفها الخطة (القرار: الفاتورة تسحب سنداتها المخصَّصة لها) — حدثٌ لكل مستندٍ برقمه ومبلغه: INVOICE_DELETED
 * لكل فاتورة، وRECEIPT_DELETED لكل سند بتوزيعه (رقم كل فاتورة، وrestored لما يعود مبلغه إلى فاتورةٍ باقية — كما يفعل المحرّك). ما
 * لم يُستهدف بذاته بل سُحب مع غيره cascade: true. عميلٌ يُحذف في الخطة نفسها يُجمَع في حدث حذفه (لا حدثاً لكل مستند)
 */
async function moneyDocDeletedEvents(
  tx: Tx, tid: string, model: string, ids: readonly string[], meta: ActivityMeta, plan: Pick<PurgePlan, 'invoiceIds' | 'receiptIds' | 'batches'>,
): Promise<ActivityInput[]> {
  const goneCustomers = new Set(plan.batches.filter((b) => b.model === 'Customer').flatMap((b) => b.keys.map((k) => String(k.id))));
  const targeted = new Set(ids);
  const goneInvoices = new Set(plan.invoiceIds);
  const out: ActivityInput[] = [];
  const doc = { actor: meta.actor, source: meta.source };
  for (const part of chunks([...new Set(plan.invoiceIds)])) {
    const rows = await tx.invoice.findMany({
      where: { id: { in: part }, tenantId: tid },
      select: { id: true, customerId: true, number: true, type: true, documentKind: true, total: true, status: true },
    });
    for (const r of rows) {
      if (goneCustomers.has(r.customerId)) continue;
      out.push(invoiceEventInput({
        tenantId: tid, action: 'INVOICE_DELETED', meta: doc, invoice: r,
        data: { reason: PURGED, status: r.status, ...(!(model === 'Invoice' && targeted.has(r.id)) && { cascade: true }) },
      }));
    }
  }
  for (const part of chunks([...new Set(plan.receiptIds)])) {
    const rows = await tx.receipt.findMany({
      where: { id: { in: part }, tenantId: tid },
      select: {
        id: true, customerId: true, number: true, amount: true, status: true, paymentMethod: true, paymentMethodKey: true,
        chequeNumber: true, bankName: true, clientRef: true,
        invoiceItems: { select: { invoiceId: true, amount: true, invoice: { select: { number: true } } } },
      },
    });
    for (const r of rows) {
      if (goneCustomers.has(r.customerId)) continue;
      out.push(receiptEventInput({
        tenantId: tid, action: 'RECEIPT_DELETED', meta: doc, receipt: { ...r, notes: null },
        allocations: r.invoiceItems.map((a) => ({
          invoiceId: a.invoiceId, invoiceNo: a.invoice?.number ?? null, amount: Number(a.amount),
          // المحرّك يعيد مبالغ تخصيص السند **القائم** إلى فواتيره الباقية (restoreAllocations) — والمحذوفة معه لا يعنيها
          restored: r.status === 'ACTIVE' && !goneInvoices.has(a.invoiceId),
        })),
        data: { reason: PURGED, status: r.status, ...(!(model === 'Receipt' && targeted.has(r.id)) && { cascade: true }) },
      }));
    }
  }
  return out;
}

/**
 * «أرشيف العميل»: أثر الحذف النهائي على سجلّ كل عميلٍ يمسّه — يُقرأ بالخطة نفسها قبل أي كتابة في معاملة الحذف (purgeInTx
 * beforeWrite) فيلتزم معه أو يُلغى معه. الفاعل المالك (أو موظف المنصة بكل الصلاحيات) وسببه OWNER_PURGE دائماً:
 *  • المستندات المالية في الخطة كلها (الهدف وما سُحب معه): moneyDocDeletedEvents.
 *  • العميل نفسه: لا حدث — سجلّه كله يُحذف معه في معاملة الحذف (قرار المالك ٢٧ نوفمبر ٢٠٢٦: «بعد حذف العميل يحذف سجله معه»).
 *  • ما سواه بحالته: الزيارة والوثيقة والإسناد ونطاق المستخدم ومحطّة الخط وخطّه وطلب المنيو ونوع السعر والموقع والفريق والقيد والتسوية
 *    ورابط الدفع وعملية البطاقة والمكالمة والمراجعة المعلّقة، والصنف (أسعار العملاء الخاصة) والمندوب (كحذف المدير له).
 */
export async function purgeActivityEvents(
  tx: Tx, tid: string, model: string, ids: readonly string[], meta: ActivityMeta,
  plan: Pick<PurgePlan, 'invoiceIds' | 'receiptIds' | 'batches'> = { invoiceIds: [], receiptIds: [], batches: [] },
): Promise<ActivityInput[]> {
  if (!hasActivityTable(tx)) return [];
  const money = model === 'Customer' ? [] : await moneyDocDeletedEvents(tx, tid, model, ids, meta, plan);
  return [...money, ...await targetPurgeEvents(tx, tid, model, ids, meta)];
}

/** أحداث الهدف المباشر (ما عدا الفاتورة والسند: تغطّيهما moneyDocDeletedEvents من الخطة) */
async function targetPurgeEvents(tx: Tx, tid: string, model: string, ids: readonly string[], meta: ActivityMeta): Promise<ActivityInput[]> {
  const where = { id: { in: [...ids] }, tenantId: tid };
  const base = { actor: meta.actor, source: meta.source };
  const other = (customerId: string | null | undefined, refType: ActivityInput['refType'] | undefined, refId: string, data: Record<string, unknown>, extra: Partial<ActivityInput> = {}): ActivityInput | null =>
    (customerId ? { tenantId: tid, customerId, action: 'OTHER', ...base, ...(refType && { refType }), refId, ...extra, data: { kind: PURGED, model, ...data } } : null);
  const list = (xs: readonly (ActivityInput | null)[]): ActivityInput[] => xs.filter((x): x is ActivityInput => !!x);
  switch (model) {
    case 'Customer':
      // قرار المالك (٢٧ نوفمبر ٢٠٢٦): «بعد حذف العميل يحذف سجله معه» — لا حدث حذفٍ له ولا لمستنداته المحذوفة معه: سجلّه كله
      // يُحذف في معاملة الحذف نفسها (services/ownerPurge.ts purgeInTx)
      return [];
    case 'Invoice':
    case 'Receipt':
      return []; // من الخطة (moneyDocDeletedEvents) — الهدف وما سُحب معه
    case 'RepVisit': {
      const rows = await tx.repVisit.findMany({ where, select: { id: true, customerId: true, createdAt: true, salesRepId: true } });
      return rows.map((r) => ({
        tenantId: tid, customerId: r.customerId, action: 'VISIT_DELETED' as const, ...base, refType: 'VISIT' as const, refId: r.id,
        data: { reason: 'OWNER_PURGE', visitedAt: r.createdAt, salesRepId: r.salesRepId },
      }));
    }
    case 'CustomerDocument': {
      const rows = await tx.customerDocument.findMany({ where, select: { id: true, customerId: true, kind: true, sizeBytes: true, createdAt: true } });
      return rows.map((r) => ({
        tenantId: tid, customerId: r.customerId, action: 'DOCUMENT_REMOVED' as const, ...base, refType: 'DOCUMENT' as const, refId: r.id,
        data: { reason: 'OWNER_PURGE', kind: r.kind, sizeBytes: r.sizeBytes, uploadedAt: r.createdAt },
      }));
    }
    case 'CustomerPaymentLink': {
      // الرابط المحذوف لا يُدفع بعده — «إلغاء رابط» بحالته قبل الحذف (والمسدَّد يبقى سنده: له حدثه إن حُذف)
      const rows = await tx.customerPaymentLink.findMany({
        where, select: { id: true, tenantId: true, customerId: true, invoiceId: true, amount: true, status: true, invoice: { select: { number: true } } },
      });
      return rows.map((r) => ({
        tenantId: tid, customerId: r.customerId, action: 'PAYLINK_CANCELLED' as const, ...base, refType: 'PAYLINK' as const, refId: r.id,
        refNo: r.invoice?.number ?? null, amount: asNum(r.amount),
        data: { reason: PURGED, purged: true, previousStatus: r.status, invoiceId: r.invoiceId, ...(r.invoice?.number && { invoiceNo: r.invoice.number }) },
      }));
    }
    case 'CardPayment': {
      const rows = await tx.cardPayment.findMany({ where, select: { id: true, customerId: true, amount: true, status: true, reference: true, invoiceId: true } });
      return list(rows.map((r) => other(r.customerId, 'CARD_PAYMENT', r.id, { previousStatus: r.status, invoiceId: r.invoiceId }, { refNo: r.reference ?? null, amount: asNum(r.amount) })));
    }
    case 'CallLog': {
      const rows = await tx.callLog.findMany({ where, select: { id: true, customerId: true, startedAt: true, direction: true, durationSec: true } });
      return list(rows.map((r) => other(r.customerId, 'CALL', r.id, { startedAt: r.startedAt, direction: r.direction, durationSec: r.durationSec })));
    }
    case 'AccountEntry': {
      // قيدٌ في كشف حساب العميل يُحذف: أثره على الرصيد يُطرح — المبلغ سالب (مدين − دائن) بعُرف السجلّ
      const rows = await tx.accountEntry.findMany({ where, select: { id: true, customerId: true, debit: true, credit: true, type: true, description: true } });
      return rows.map((r) => ({
        tenantId: tid, customerId: r.customerId, action: 'ADJUSTMENT_UPDATED' as const, ...base, refType: 'ADJUSTMENT' as const, refId: r.id,
        amount: -balanceEffect(r.debit, r.credit) || 0,
        data: { reason: PURGED, newStatus: 'DELETED', entryType: r.type, debit: asNum(r.debit), credit: asNum(r.credit), description: r.description },
      }));
    }
    case 'CustomerAdjustment': {
      // مستند التسوية وحده (قيدها في كشف الحساب صفٌّ آخر يبقى ما لم يُحذف بذاته) — لا أثر على الرصيد فلا مبلغ للحدث، وقيمة المستند
      // في data.amount (مفتاح مالٍ يُحجب بالصلاحية)
      const rows = await tx.customerAdjustment.findMany({ where, select: { id: true, customerId: true, kind: true, amount: true, status: true } });
      return rows.map((r) => ({
        tenantId: tid, customerId: r.customerId, action: 'ADJUSTMENT_UPDATED' as const, ...base, refType: 'ADJUSTMENT' as const, refId: r.id,
        data: { reason: PURGED, kind: r.kind, amount: asNum(r.amount), oldStatus: r.status, newStatus: 'DELETED' },
      }));
    }
    case 'CustomerAssignment': {
      const rows = await tx.customerAssignment.findMany({ where, select: { customerId: true, salesRepId: true, salesRep: { select: { name: true } } } });
      return rows.map((r) => ({
        tenantId: tid, customerId: r.customerId, action: 'CUSTOMER_UNASSIGNED' as const, ...base, refType: 'ASSIGNMENT' as const, refId: r.salesRepId,
        data: { reason: PURGED, salesRepId: r.salesRepId, ...(r.salesRep?.name && { repName: r.salesRep.name }) },
      }));
    }
    case 'AdminCustomerScope':
    case 'Admin': {
      // نطاق مستخدم الشركة على العميل يُنزع (بحذفه هو أو حذف المستخدم — نطاقه يُحذف معه) — بشكل حدث النطاق نفسه (services/adminScope.ts)
      const scopes = await tx.adminCustomerScope.findMany({
        where: model === 'Admin' ? { tenantId: tid, adminId: { in: [...ids] } } : where,
        select: { customerId: true, adminId: true, admin: { select: { name: true } } },
      });
      return scopes.map((s) => ({
        tenantId: tid, customerId: s.customerId, action: 'CUSTOMER_UNASSIGNED' as const, ...base,
        data: { kind: 'ADMIN_SCOPE', adminId: s.adminId, ...(s.admin?.name && { adminName: s.admin.name }), reason: PURGED },
      }));
    }
    case 'RepRouteStop': {
      const rows = await tx.repRouteStop.findMany({ where, select: { customerId: true, routeId: true, route: { select: { name: true, salesRepId: true } } } });
      return rows.map((s) => ({
        tenantId: tid, customerId: s.customerId, action: 'ROUTE_STOP_REMOVED' as const, ...base, refType: 'ROUTE' as const, refId: s.routeId,
        data: { reason: PURGED, routeName: s.route?.name ?? null, salesRepId: s.route?.salesRepId ?? null },
      }));
    }
    case 'CatalogOrder': {
      // طلب المنيو بلا customerId: عميله بالقاعدة الواحدة (catalogOrderCustomers — عميل أوّل سطرٍ لطلبه في السجلّ، وإلا المطابقة
      // الفريدة لحظة الطلب)، وطلبٌ بلا عميلٍ بها يُنسب لعميل فاتورة إغلاقه وحده — وطلبٌ لا عميل له لا حدث له
      const rows = await tx.catalogOrder.findMany({ where, select: { id: true, status: true, phoneKey: true, customerName: true, invoiceId: true, createdAt: true } });
      const owners = await catalogOrderCustomers(tx, tid, rows);
      const out: ActivityInput[] = [];
      for (const o of rows) {
        const viaInvoice = !owners.has(o.id) && o.invoiceId
          ? await tx.invoice.findFirst({ where: { id: o.invoiceId, tenantId: tid }, select: { customerId: true } })
          : null;
        const customerId = owners.get(o.id) ?? viaInvoice?.customerId ?? null;
        if (!customerId) continue;
        out.push({
          tenantId: tid, customerId, action: 'CATALOG_ORDER_UPDATED', ...base, refType: 'CATALOG_ORDER', refId: o.id,
          data: { reason: PURGED, oldStatus: o.status, newStatus: 'DELETED', customerName: o.customerName },
        });
      }
      return out;
    }
    case 'PriceList': {
      // العملاء على القائمة يعودون إلى السعر الأساسي (Customer.priceListId SetNull) — كحذف القائمة من شاشتها (routes/priceLists.ts)
      const lists = await tx.priceList.findMany({ where, select: { id: true, name: true } });
      const nameOf = new Map(lists.map((l) => [l.id, l.name]));
      const affected = await tx.customer.findMany({ where: { tenantId: tid, priceListId: { in: [...ids] } }, select: { id: true, priceListId: true } });
      return affected.map((c) => ({
        tenantId: tid, customerId: c.id, action: 'CUSTOMER_PRICE_LIST_CHANGED' as const, ...base, refType: 'CUSTOMER' as const, refId: c.id,
        data: { from: c.priceListId, ...(c.priceListId && nameOf.get(c.priceListId) && { fromName: nameOf.get(c.priceListId) }), to: null, reason: PURGED },
      }));
    }
    case 'SalesLocation': {
      // فواتير كل عميلٍ تفقد ختم الموقع (Invoice.locationId يُفرَّغ) — كحذف الموقع من شاشته (routes/locations.ts)
      const out: ActivityInput[] = [];
      for (const loc of await tx.salesLocation.findMany({ where, select: { id: true, name: true } })) {
        const byCustomer = await tx.invoice.groupBy({ by: ['customerId'], where: { tenantId: tid, locationId: loc.id }, _count: { _all: true } });
        out.push(...perCustomerEvents(tid, countByCustomer(byCustomer), 'INVOICE_UPDATED', meta, {
          kind: 'LOCATION_UNLINKED', locationId: loc.id, locationName: loc.name,
          changes: [{ field: 'locationId', from: loc.name, to: null }], reason: PURGED,
        }, 'INVOICE'));
      }
      return out;
    }
    case 'Team': {
      // مستندات كل عميلٍ وزياراته تخرج من الفريق (teamId يُفرَّغ) — كحذف الفريق من شاشته (routes/teams.ts)
      const out: ActivityInput[] = [];
      for (const team of await tx.team.findMany({ where, select: { id: true, name: true } })) {
        const tagged = { tenantId: tid, teamId: team.id };
        const moved = { kind: 'TEAM', fromTeamId: team.id, fromTeam: team.name, toTeam: null, reason: PURGED };
        const inv = await tx.invoice.groupBy({ by: ['customerId'], where: tagged, _count: { _all: true } });
        const rec = await tx.receipt.groupBy({ by: ['customerId'], where: tagged, _count: { _all: true } });
        const vis = await tx.repVisit.groupBy({ by: ['customerId'], where: tagged, _count: { _all: true } });
        out.push(
          ...perCustomerEvents(tid, countByCustomer(inv), 'INVOICE_REASSIGNED', meta, moved, 'INVOICE'),
          ...perCustomerEvents(tid, countByCustomer(rec), 'RECEIPT_REASSIGNED', meta, moved, 'RECEIPT'),
          ...perCustomerEvents(tid, countByCustomer(vis), 'VISIT_REASSIGNED', meta, moved, 'VISIT'),
        );
      }
      return out;
    }
    case 'ZatcaCutoverReview': {
      // مستندٌ رُفع دون اتصال ينتظر قرار الانتقال للفوترة الإلكترونية — حذفه يُسقط إصداره
      const rows = await tx.zatcaCutoverReview.findMany({ where, select: { id: true, customerId: true, status: true, reason: true, amount: true } });
      return list(rows.map((r) => other(r.customerId, undefined, r.id, { previousStatus: r.status, reviewReason: r.reason }, { amount: asNum(r.amount) })));
    }
    case 'Product': {
      const out: ActivityInput[] = [];
      for (const id of ids) out.push(...await productCustomerPriceEvents(tx, tid, id, meta, { action: 'CUSTOMER_PRICE_REMOVED', reason: 'OWNER_PURGE' }));
      return out;
    }
    case 'SalesRep': {
      const reps = await tx.salesRep.findMany({ where, select: { id: true, name: true } });
      const out: ActivityInput[] = [];
      for (const r of reps) out.push(...await repDeleteEvents(tx, tid, r, meta, 'OWNER_PURGE'));
      return out;
    }
    case 'RepRoute': {
      const stops = await tx.repRouteStop.findMany({
        where: { tenantId: tid, routeId: { in: [...ids] }, route: { isActive: true } },
        select: { customerId: true, routeId: true, route: { select: { name: true, salesRepId: true } } },
      });
      const seen = new Set<string>();
      return stops.filter((s) => { const k = `${s.customerId}|${s.routeId}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .map((s) => ({
          tenantId: tid, customerId: s.customerId, action: 'ROUTE_STOP_REMOVED' as const, ...base, refType: 'ROUTE' as const, refId: s.routeId,
          data: { reason: 'OWNER_PURGE', routeName: s.route?.name ?? null, salesRepId: s.route?.salesRepId ?? null },
        }));
    }
    default:
      return [];
  }
}

/** الحذف النهائي */
router.post('/delete', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { model, ids } = TARGET.parse(req.body);
    const tid = tenantId(req);
    // معاملة المحرّك نفسها (executePurge بمهلته) و«أرشيف العميل» بالخطة نفسها بعد حارسَي الرفض وقبل أي كتابة فيها (beforeWrite) —
    // الأثر يلتزم مع الحذف أو يُلغى معه، ويرى ما يسحبه الحذف (سندات الفاتورة وتخصيصاتها) لا الهدف وحده
    const meta = activityMeta(req);
    const result = await prisma.$transaction(async (tx) => purgeInTx(tx, tid, model, ids, {
      beforeWrite: async (plan) => { await recordActivityInTx(tx, await purgeActivityEvents(tx, tid, model, ids, meta, plan)); },
    }), { timeout: 120_000, maxWait: 15_000 });
    const u = req.user as unknown as { by?: string; id?: string };
    await prisma.platformAuditLog.create({
      data: {
        actorType: 'OWNER', actorId: String(u.by ?? ''), action: 'owner.purge', method: 'POST', path: '/api/owner-purge/delete', status: 200,
        targetId: ids[0], detail: JSON.stringify({ tenantId: tid, model, ids: ids.slice(0, 50), n: ids.length, counts: result.counts, nullCounts: result.nullCounts }).slice(0, 4000),
        ip: req.ip ?? null,
      },
    }).catch(() => { /* السجل لا يُسقط حذفاً تمّ */ });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof PurgeRefused) { refusePurge(res, err); return; }
    next(err);
  }
});

/**
 * «التوائم المؤرشفة» (services/productTwins.ts): الأصناف المؤرشفة قبل الحذف الحقيقي (٥ نوفمبر ٢٠٢٦) مع توأمها القائم المقترح
 * ورصيدها الباقي في السيارات وعدد حركاتها — قراءةٌ فقط
 */
router.get('/archived-products', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await findArchivedProducts(prisma, tenantId(req)) });
  } catch (err) { next(err); }
});

const MERGE = z.object({ pairs: z.array(z.object({ fromId: ID, toId: ID })).min(1).max(200) });

/**
 * دمج المؤرشف في توأمه: كل زوجٍ في معاملته — حركات A وتاريخه إلى B ثم حذف A نهائياً. فشل زوجٍ لا يوقف غيره (failed[])،
 * وكل دمجٍ تمّ سطرٌ في سجل نشاط المنصة
 */
router.post('/archived-products/merge', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { pairs } = MERGE.parse(req.body ?? {});
    const tid = tenantId(req);
    const u = req.user as unknown as { by?: string };
    const merged: Array<{ fromId: string; toId: string; moved: Record<string, number> }> = [];
    const failed: Array<{ fromId: string; toId: string; code: string; message: string }> = [];
    const seen = new Set<string>();
    for (const { fromId, toId } of pairs) {
      if (seen.has(fromId)) { failed.push({ fromId, toId, code: 'DUPLICATE', message: 'الصنف مكرر في الطلب' }); continue; }
      seen.add(fromId);
      try {
        // «أرشيف العميل»: أسعار العملاء الخاصة للمؤرشف تُحذف معه بالدمج (إعدادٌ لا يُنقل) — حدثٌ لكل عميلٍ في معاملة الدمج نفسها
        const r = await prisma.$transaction(async (tx) => {
          await recordActivityInTx(tx, await productCustomerPriceEvents(tx, tid, fromId, activityMeta(req), { action: 'CUSTOMER_PRICE_REMOVED', reason: 'PRODUCT_MERGED', mergedInto: toId }));
          return mergeArchivedProduct(tx, tid, fromId, toId);
        }, { maxWait: 10_000, timeout: 60_000 });
        merged.push({ fromId, toId, moved: r.moved });
        await prisma.platformAuditLog.create({
          data: {
            actorType: 'OWNER', actorId: String(u.by ?? ''), action: 'owner.mergeArchivedProduct', method: 'POST',
            path: '/api/owner-purge/archived-products/merge', status: 200, targetId: fromId,
            detail: JSON.stringify({ tenantId: tid, toId, moved: r.moved, deleted: r.deleted }).slice(0, 4000),
            ip: req.ip ?? null,
          },
        }).catch(() => { /* السجل لا يُسقط دمجاً تمّ */ });
      } catch (err) {
        if (err instanceof MergeRefused) failed.push({ fromId, toId, code: err.code, message: err.message });
        else if (asLotBusy(err)) failed.push({ fromId, toId, code: 'BUSY', message: 'الصنف مشغول بحركة أخرى أعد المحاولة بعد لحظات' });
        else {
          console.error('[owner-purge] merge archived product failed', fromId, toId, err);
          failed.push({ fromId, toId, code: 'ERROR', message: `تعذر الدمج: ${String((err as Error)?.message ?? err).slice(0, 300)}` });
        }
      }
    }
    res.json({ success: true, data: { merged, failed } });
  } catch (err) { next(err); }
});

/**
 * العملاء المحذوفون قبل ٥ نوفمبر ٢٠٢٦ (status DELETED — نسخة مخفية بأثرها المالي). قرار المالك (٧ نوفمبر): «يُحذفون مع فواتيرهم»
 * — يُعرضون هنا بعدد مستنداتهم، ويحذفها المالك بـPOST /delete { model: 'Customer', ids } (المحرّك يحذف الفواتير والسندات والقيود)
 */
router.get('/archived-customers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rows = await prisma.customer.findMany({
      where: { tenantId: tid, status: 'DELETED' },
      select: { id: true, name: true, code: true, number: true, phone: true, balance: true },
      orderBy: { name: 'asc' }, take: 5000,
    });
    const ids = rows.map((r) => r.id);
    const [inv, rec] = ids.length ? await Promise.all([
      prisma.invoice.groupBy({ by: ['customerId'], where: { tenantId: tid, customerId: { in: ids } }, _count: { _all: true } }),
      prisma.receipt.groupBy({ by: ['customerId'], where: { tenantId: tid, customerId: { in: ids } }, _count: { _all: true } }),
    ]) : [[], []];
    const invOf = new Map(inv.map((x) => [x.customerId, x._count._all]));
    const recOf = new Map(rec.map((x) => [x.customerId, x._count._all]));
    res.json({
      success: true,
      data: rows.map((r) => ({ id: r.id, name: r.name, code: r.code, number: r.number ?? null, phone: r.phone, balance: Number(r.balance), invoices: invOf.get(r.id) ?? 0, receipts: recOf.get(r.id) ?? 0 })),
    });
  } catch (err) { next(err); }
});

export default router;
