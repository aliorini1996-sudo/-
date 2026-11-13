// ============================================================================
// سندات صرف الموردين — /api/supplier-payments («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦)
// ----------------------------------------------------------------------------
// القائمة والسند (للطباعة SP-000123) والإنشاء والإلغاء. الكتابة كلها في services/suppliers/payments.ts داخل معاملة المسار:
// السند وتخصيصاته وقيد PAYMENT في كشف المورّد، والإلغاء بحالة CANCELLED وقيد PAYMENT_REV — لا حذف، ولا شيء في gl_*.
//   • الحرّاس حرّاس الموردين نفسها (useSupplierGuards من routes/suppliers.ts = حرّاس المستودع)، ومفتاح «قراءة فقط» يُرفض في
//     الكتابة من authenticate (API_KEY_FORBIDDEN).
//   • المبالغ أرقامٌ بوحدة العملة في الطلب والردّ، وتُحوَّل إلى ملّي بمنازل عملة الشركة (نصف-لأعلى) قبل الخدمة؛ BigInt لا يخرج.
//   • clientRef المكرَّر: الخدمة تقفل المرجع أول المعاملة ثم تبحث به — القائم يُردّ 200 (replay) بلا أي كتابة، ولو تزامن الطلبان.
//   • السند الآلي لشراءٍ نقدي (autoForEntryId) لا يُنشأ من هنا (الجسم لا يقبله) ولا يُلغى من هنا (409 AUTO_PAYMENT_CANCEL_VIA_ENTRY).
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { isOwnerSession, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { canAccessRep } from '../services/adminScope';
import { hiddenRepIds } from '../services/suppliers/repCustody';
import { tenantCurrencyDecimals } from '../services/warehouseStock';
import { CLIENT_REF_SCHEMA } from '../services/stockClientRef';
import { dayString, milliToNumber, parseDay, SUPPLIER_PAYMENT_METHODS, toMilliAmount } from '../services/suppliers/core';
import { cancelSupplierPaymentTx, createSupplierPaymentTx, SupplierError, supplierPaymentDisplayNumber } from '../services/suppliers/payments';
import { SUPPLIER_TX, optionalText, pageOf, queryDay, queryText, supplierFail, useSupplierGuards, zodFail } from './suppliers';

// ═══ المخطّطات ═══

/** أقصى مبلغ (وحدة عملة): ١٠^١٢ ⇒ ١٠^١٥ ملّي — دون حدّ الدقّة في JSON (٢^٥٣) بهامشٍ واسع */
const MAX_AMOUNT = 1_000_000_000_000;

/** مبلغ بوحدة العملة: رقمٌ أو نصٌّ رقمي (أنظمة الربط ترسل "150.25") — منتهٍ ومحدود */
const amount = z.preprocess(
  (v) => (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v),
  z.number({ required_error: 'المبلغ مطلوب', invalid_type_error: 'المبلغ رقم' }).finite('المبلغ رقم').max(MAX_AMOUNT, 'المبلغ أكبر من المسموح'),
);

const createSchema = z.object({
  supplierId: z.string({ required_error: 'المورّد مطلوب' }).trim().min(1, 'المورّد مطلوب').max(64),
  amount: amount.refine((v) => v > 0, { message: 'مبلغ السند يجب أن يكون أكبر من صفر' }),
  method: z.enum(SUPPLIER_PAYMENT_METHODS, { errorMap: () => ({ message: 'طريقة الدفع CASH أو BANK_TRANSFER أو CHEQUE أو REP_CUSTODY' }) }),
  salesRepId: z.string().trim().max(64).nullish(),
  paidAt: z.string({ required_error: 'تاريخ الدفع مطلوب' }).refine((s) => parseDay(s) !== null, { message: 'تاريخ الدفع YYYY-MM-DD' }),
  reference: optionalText(120),
  note: optionalText(500),
  // مرجع منع التكرار (uuid يكفي) — الفارغ كالغائب
  clientRef: z.preprocess((v) => (v === '' ? null : v), CLIENT_REF_SCHEMA.nullish()),
  allocations: z.array(z.object({
    warehouseEntryId: z.string().trim().min(1, 'الفاتورة مطلوبة').max(64),
    amount: amount.refine((v) => v >= 0, { message: 'مبلغ التخصيص لا يكون سالباً' }),
  })).max(500, 'التخصيص حتى 500 فاتورة').optional(),
  autoAllocate: z.boolean({ invalid_type_error: 'autoAllocate قيمة منطقية' }).optional(),
});

const cancelSchema = z.object({ reason: optionalText(500) });

const STATUSES = ['POSTED', 'CANCELLED'] as const;

// ═══ العرض ═══

const PAYMENT_SELECT = {
  id: true, number: true, vendorId: true, amountMilli: true, method: true, salesRepId: true, paidAt: true, reference: true, note: true,
  status: true, cancelledAt: true, cancelReason: true, autoForEntryId: true, createdBy: true, createdAt: true,
  vendor: { select: { name: true } },
  allocations: { select: { warehouseEntryId: true, amountMilli: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} as const satisfies Prisma.SupplierPaymentSelect;

type PaymentRow = Prisma.SupplierPaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

/**
 * السندات بشكل العقد SupplierPaymentView — باستعلامين ثابتين مهما كثرت (أسماء المناديب وأرقام فواتير المورّد في التخصيص)،
 * كلاهما بـtenantId. مندوبٌ حُذف بعد السند: salesRepName null والمعرّف باقٍ.
 * `hidden`: مناديب خارج نطاق المستخدم المقيَّد (hiddenRepIds) — معرّفهم واسمهم null (يبقى أن الدفع من عهدة مندوب)، كقائمة
 * /api/warehouse/reps المقيَّدة بنطاقه: لا تُكشف مناديب لا يراها.
 */
async function paymentViews(tid: string, rows: readonly PaymentRow[], hidden: ReadonlySet<string> = new Set()) {
  const shown = (id: string | null): string | null => (id && !hidden.has(id) ? id : null);
  const repIds = [...new Set(rows.map((r) => shown(r.salesRepId)).filter((x): x is string => !!x))];
  const entryIds = [...new Set(rows.flatMap((r) => r.allocations.map((a) => a.warehouseEntryId)))];
  const [reps, entries] = await Promise.all([
    repIds.length ? prisma.salesRep.findMany({ where: { tenantId: tid, id: { in: repIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    entryIds.length ? prisma.warehouseEntry.findMany({ where: { tenantId: tid, id: { in: entryIds } }, select: { id: true, supplierRef: true } }) : Promise.resolve([]),
  ]);
  const repName = new Map(reps.map((r) => [r.id, r.name]));
  const refOf = new Map(entries.map((e) => [e.id, e.supplierRef]));
  return rows.map((p) => ({
    id: p.id,
    number: p.number,
    displayNumber: supplierPaymentDisplayNumber(p.number),
    supplierId: p.vendorId,
    supplierName: p.vendor.name,
    amount: milliToNumber(p.amountMilli),
    method: p.method,
    salesRepId: shown(p.salesRepId),
    salesRepName: shown(p.salesRepId) ? repName.get(p.salesRepId as string) ?? null : null,
    paidAt: dayString(p.paidAt),
    reference: p.reference,
    note: p.note,
    status: p.status,
    cancelledAt: p.cancelledAt ? p.cancelledAt.toISOString() : null,
    cancelReason: p.cancelReason,
    autoForEntryId: p.autoForEntryId,
    allocations: p.allocations.map((a) => ({
      warehouseEntryId: a.warehouseEntryId,
      supplierRef: refOf.get(a.warehouseEntryId) ?? null,
      amount: milliToNumber(a.amountMilli),
    })),
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
  }));
}

/** السندات للعرض بنطاق المستخدم: مناديب خارج نطاق المقيَّد محجوبون (غير المقيَّد بلا استعلامٍ زائد) */
async function scopedPaymentViews(req: AuthRequest, tid: string, rows: readonly PaymentRow[]) {
  return paymentViews(tid, rows, await hiddenRepIds(req, tid, rows.map((r) => r.salesRepId)));
}

/** سندٌ واحد للعرض بعد الكتابة (أو null لغير الموجود في الشركة) — بنطاق المستخدم */
async function paymentView(req: AuthRequest, tid: string, id: string) {
  const row = await prisma.supplierPayment.findFirst({ where: { id, tenantId: tid }, select: PAYMENT_SELECT });
  return row ? (await scopedPaymentViews(req, tid, [row]))[0] : null;
}

/**
 * من أنشأ السند أو ألغاه (اسمٌ يُطبع على السند): اسم المستخدم، وجلسة «دخول» المالك أو موظف المنصة ومفتاحٌ أصدره الدعم تُنسب
 * لـ«الدعم الفني» لا باسم مدير الشركة الذي يحمله توكنها — كمرفقات حركة المستودع.
 */
function actorName(req: AuthRequest): string | null {
  if (isOwnerSession(req) || req.user?.ownerIssuedKey === true) return 'الدعم الفني';
  const n = req.user?.name;
  return typeof n === 'string' && n ? n.slice(0, 120) : null;
}

const notFound = () => new SupplierError('SUPPLIER_PAYMENT_NOT_FOUND', 'السند غير موجود', 404);

// ═══ المسارات ═══

const router = Router();
useSupplierGuards(router);

// قائمة السندات: المورّد والفترة (تاريخ الدفع) والحالة، الأحدث أولاً
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const from = queryDay(req.query.from);
    const to = queryDay(req.query.to);
    if (from === undefined || to === undefined) {
      res.status(400).json({ success: false, code: 'SUPPLIER_PAYMENT_INVALID', message: 'التاريخ غير صالح (YYYY-MM-DD)' });
      return;
    }
    const rawStatus = queryText(req.query.status)?.toUpperCase();
    const status = rawStatus && rawStatus !== 'ALL' ? rawStatus : undefined;
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      res.status(400).json({ success: false, code: 'SUPPLIER_PAYMENT_INVALID', message: 'الحالة POSTED أو CANCELLED' });
      return;
    }
    const supplierId = queryText(req.query.supplierId);
    const { page, limit, skip } = pageOf(req.query);
    const where: Prisma.SupplierPaymentWhereInput = {
      tenantId: tid,
      ...(supplierId && { vendorId: supplierId }),
      ...(status && { status }),
      ...((from || to) && { paidAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
    };
    const [total, rows] = await Promise.all([
      prisma.supplierPayment.count({ where }),
      prisma.supplierPayment.findMany({ where, orderBy: [{ paidAt: 'desc' }, { number: 'desc' }], skip, take: limit, select: PAYMENT_SELECT }),
    ]);
    res.json({ success: true, data: { items: await scopedPaymentViews(req, tid, rows), total, page, limit } });
  } catch (err) { next(err); }
});

// السند للعرض والطباعة — سند شركةٍ أخرى 404 كغير الموجود
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const view = await paymentView(req, tenantId(req), String(req.params.id));
    if (!view) throw notFound();
    res.json({ success: true, data: view });
  } catch (err) { supplierFail(err, res, next); }
});

// سند صرف جديد: التخصيص الصريح (لكل فاتورة ≤ متبقّيها وΣ ≤ المبلغ) و/أو autoAllocate على الأقدم استحقاقاً، والزائد دفعة مقدّمة
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) { zodFail(res, parsed.error, 'SUPPLIER_PAYMENT_INVALID'); return; }
    const d = parsed.data;
    const dec = await tenantCurrencyDecimals(tid);
    const amountMilli = toMilliAmount(d.amount, dec);
    // مبلغٌ دون أصغر وحدة في العملة (0.001 ريال) يصير صفراً بالتقريب — رفضٌ صريح لا سند بصفر
    if (amountMilli <= 0n) throw new SupplierError('SUPPLIER_PAYMENT_INVALID', 'مبلغ السند يجب أن يكون أكبر من صفر');
    // نطاق المستخدم: الدفع من عهدة مندوبٍ لا يراه المستخدم المقيّد يُرفض برسالة غير الموجود نفسها (لا يُكشف وجوده)
    if (d.method === 'REP_CUSTODY' && d.salesRepId && !(await canAccessRep(req, tid, d.salesRepId))) {
      throw new SupplierError('SUPPLIER_PAYMENT_INVALID', 'المندوب غير موجود في الشركة', undefined, { salesRepId: d.salesRepId });
    }
    const out = await prisma.$transaction((tx) => createSupplierPaymentTx(tx, {
      tenantId: tid,
      vendorId: d.supplierId,
      amountMilli,
      method: d.method,
      salesRepId: d.salesRepId ?? null,
      paidAt: parseDay(d.paidAt) as Date,
      reference: d.reference ?? null,
      note: d.note ?? null,
      createdBy: actorName(req),
      clientRef: d.clientRef ?? null,
      allocations: (d.allocations ?? []).map((a) => ({ warehouseEntryId: a.warehouseEntryId, amountMilli: toMilliAmount(a.amount, dec) })),
      autoAllocate: d.autoAllocate === true,
    }), SUPPLIER_TX);
    const view = await paymentView(req, tid, out.id);
    if (out.replay) { res.status(200).json({ success: true, data: view, replay: true, idempotent: true }); return; }
    res.status(201).json({ success: true, data: view });
  } catch (err) { supplierFail(err, res, next); }
});

// إلغاء السند مرّة واحدة: الحالة CANCELLED وقيد PAYMENT_REV بيوم الشركة (لا يسبق تاريخ الدفع)؛ تخصيصاته تبقى أثراً ولا تُحسب
router.post('/:id/cancel', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const parsed = cancelSchema.safeParse(req.body ?? {});
    if (!parsed.success) { zodFail(res, parsed.error, 'SUPPLIER_PAYMENT_INVALID'); return; }
    // نطاق المستخدم كالإنشاء: إلغاء سندٍ من عهدة مندوبٍ خارج نطاق المقيَّد يعيد المبلغ إلى عهدة مندوبٍ لا يملكه — 404 كغير الموجود
    const target = await prisma.supplierPayment.findFirst({ where: { id, tenantId: tid }, select: { method: true, salesRepId: true } });
    if (target?.method === 'REP_CUSTODY' && target.salesRepId && !(await canAccessRep(req, tid, target.salesRepId))) throw notFound();
    await prisma.$transaction(
      (tx) => cancelSupplierPaymentTx(tx, tid, id, { by: actorName(req), reason: parsed.data.reason ?? null }),
      SUPPLIER_TX,
    );
    const view = await paymentView(req, tid, id);
    if (!view) throw notFound();
    res.json({ success: true, data: view });
  } catch (err) { supplierFail(err, res, next); }
});

export default router;
