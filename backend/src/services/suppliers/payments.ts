/**
 * سندات صرف الموردين («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦) — الكتابة داخل معاملة المستدعي (لا تفتح معاملةً بنفسها):
 * المسار routes/supplierPayments.ts للسند اليدوي، وroutes/warehouse.ts للسند الآلي لاستلامٍ نقدي (autoForEntryId) ولإلغائه مع الحركة.
 * يكتب supplier_payments وتخصيصاته وقيد كشف المورّد (PAYMENT / PAYMENT_REV) — ولا شيء في gl_* (gl_vendors يُقرأ وحده).
 *
 * ═══ ترتيب الأقفال (ثابت في كل مسار — لا حلقة انتظار) ═══
 *   ١. قفل مرجع العميل clientRef (استشاري لكل (شركة، مرجع)) — أول المعاملة، كأقفال مراجع المخزون (stockClientRef).
 *   ٢. صفوف الفواتير المخصَّص لها FOR UPDATE في استعلامٍ واحد مرتّب بالمعرّف — فلا يتجاوز سندان متزامنان متبقّي فاتورة،
 *      ولا يتعطّل سندان على فاتورتين متقاطعتين.
 *   ٣. قفل الترقيم الاستشاري لكل شركة — آخرها: من يمسكه لا ينتظر صفاً بعده، فمسار الحركة (أقفال المستودع واللوط ثم السند الآلي)
 *      لا يتعطّل مع سندٍ يدوي ينتظر صفوف فواتيره.
 *
 * ═══ لماذا قفل الترقيم لا «max+1 وإعادة المحاولة عند P2002» ═══
 *   تعارض @@unique([tenantId, number]) داخل معاملة PostgreSQL يُجهض المعاملة كلها («current transaction is aborted»)، والمعاملة
 *   هنا معاملة المستدعي (حركة المستودع بأقفالها وكتاباتها) — فلا إعادة محاولة داخلها. القفل الاستشاري (نمط المشروع: warehouse-stock:،
 *   van-load-ref:، gl-post:) يجعل max+1 بلا سباق وبلا فجوات (يتراجع مع المعاملة)، ويبقى القيد الفريد شبكة أمانٍ أخيرة.
 */
import type { Prisma } from '@prisma/client';
import { CLIENT_REF_SCHEMA } from '../stockClientRef';
import { companyTimeZone, localDateIn } from '../erpPayload';
import {
  milliToNumber,
  parseDay,
  signedLedgerAmount,
  SUPPLIER_PAYMENT_METHODS,
  type SupplierPaymentMethod,
} from './core';
import { compareByDue, loadBillSettlements, utcDay, type BillSettlement } from './statement';

// ═══ الأخطاء ═══

/** رموز أخطاء الموردين وحالتها — المسار يحوّل SupplierError إلى JSON بـsupplierErrorBody */
export const SUPPLIER_ERROR_STATUS = Object.freeze({
  SUPPLIER_PAYMENT_INVALID: 400,
  SUPPLIER_NOT_FOUND: 404,
  SUPPLIER_PAYMENT_NOT_FOUND: 404,
  ALLOCATION_EXCEEDS_OUTSTANDING: 409,
  CLIENT_REF_REUSED: 409,
  AUTO_PAYMENT_EXISTS: 409,
  SUPPLIER_PAYMENT_ALREADY_CANCELLED: 409,
  AUTO_PAYMENT_CANCEL_VIA_ENTRY: 409,
} as const);
export type SupplierErrorCode = keyof typeof SUPPLIER_ERROR_STATUS;

/**
 * خطأ عمليات الموردين: رمزٌ إنجليزي ثابت وحالة HTTP ورسالة عربية للمستخدم. مفتوحٌ لرموز مسار الموردين نفسه
 * (SUPPLIER_CODE_EXISTS…) بتمرير الحالة صراحةً.
 */
export class SupplierError extends Error {
  readonly status: number;
  constructor(
    readonly code: SupplierErrorCode | (string & {}),
    message: string,
    status?: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SupplierError';
    this.status = status ?? (SUPPLIER_ERROR_STATUS as Record<string, number>)[code] ?? 400;
  }
}

export function isSupplierError(e: unknown): e is SupplierError {
  return e instanceof SupplierError;
}

/** جسم الردّ: {success:false, code, message, details?} */
export function supplierErrorBody(e: SupplierError): { success: false; code: string; message: string; details?: Record<string, unknown> } {
  return { success: false, code: e.code, message: e.message, ...(e.detail && { details: e.detail }) };
}

const invalid = (message: string, detail?: Record<string, unknown>) => new SupplierError('SUPPLIER_PAYMENT_INVALID', message, undefined, detail);

// ═══ الترقيم والعرض ═══

/** رقم العرض والطباعة: SP-000123 — وهو مرجع قيد الكشف (ref) فيطابق السندُ المطبوع سطرَ الكشف */
export function supplierPaymentDisplayNumber(n: number): string {
  return `SP-${String(n).padStart(6, '0')}`;
}

export const SUPPLIER_PAYMENT_NUMBER_LOCK_PREFIX = 'supplier-payment-number:';
export const SUPPLIER_PAYMENT_REF_LOCK_PREFIX = 'supplier-payment-ref:';

type LockTx = Pick<Prisma.TransactionClient, '$executeRaw'>;

/** قفل الترقيم لكل شركة (قفل معاملة لا جلسة؛ $executeRaw لأن الدالة تُرجع void) — آخر أقفال السند */
async function lockPaymentNumbering(tx: LockTx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SUPPLIER_PAYMENT_NUMBER_LOCK_PREFIX + tenantId}::text))`;
}

/** قفل مرجع العميل — أول المعاملة؛ يجعل «ابحث بالمرجع ثم أنشئ» بلا سباق (لا @@unique على clientRef) */
async function lockPaymentClientRef(tx: LockTx, tenantId: string, clientRef: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${SUPPLIER_PAYMENT_REF_LOCK_PREFIX}${tenantId}:${clientRef}`}::text))`;
}

// ═══ الإنشاء ═══

export interface CreateSupplierPaymentInput {
  tenantId: string;
  vendorId: string;
  amountMilli: bigint;
  method: SupplierPaymentMethod;
  /** مطلوب لـREP_CUSTODY ومن الشركة؛ يُهمل لغيرها */
  salesRepId?: string | null;
  /** تاريخ الدفع — يُحفظ يوماً (UTC) وهو تاريخ قيد الكشف */
  paidAt: Date;
  reference?: string | null;
  note?: string | null;
  createdBy?: string | null;
  /** مفتاح منع التكرار: المكرَّر لنفس المورّد والمبلغ ⇒ السند القائم (replay) بلا كتابة؛ لغيرهما ⇒ 409 CLIENT_REF_REUSED */
  clientRef?: string | null;
  /** السند الآلي لاستلامٍ نقدي: يُخصَّص كاملاً لحركته وحدها (وحده يُخصَّص لفاتورة نقدية) */
  autoForEntryId?: string | null;
  /** التخصيص على فواتير آجلة للمورّد نفسه: لكل فاتورة ≤ متبقّيها، وΣ ≤ المبلغ — والصفر يُهمل */
  allocations: { warehouseEntryId: string; amountMilli: bigint }[];
  /** يخصّص ما بقي من المبلغ (بعد التخصيص الصريح) على فواتير المورّد المفتوحة الأقدم استحقاقاً أولاً؛ الزائد دفعة مقدّمة */
  autoAllocate?: boolean;
}

export interface CreateSupplierPaymentResult {
  id: string;
  number: number;
  /** true = سندٌ قائم بالمرجع نفسه (لا كتابة) — المسار يردّه 200 */
  replay: boolean;
  /** التخصيص النهائي كما كُتب (بعد autoAllocate) */
  allocations: { warehouseEntryId: string; amountMilli: bigint }[];
}

function cleanText(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** يوم UTC من تاريخ صالح — وإلا خطأ إدخال */
function validDay(d: Date, message: string): Date {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw invalid(message);
  return utcDay(d);
}

/**
 * ينشئ سند صرف المورّد في المعاملة المعطاة: السند (الرقم التالي للشركة) وتخصيصاته وقيد PAYMENT (−المبلغ بتاريخ الدفع، ومرجعه
 * SP-<n>). يتحقق: المورّد من الشركة (المؤرشف يُدفع له — ذممه قائمة)، المبلغ > 0، الطريقة، مندوب العهدة من الشركة، وكل تخصيص لفاتورة
 * وارد آجلة غير ملغاة لنفس المورّد ومن الشركة وبما لا يتجاوز متبقّيها، وΣ التخصيص ≤ المبلغ.
 */
export async function createSupplierPaymentTx(tx: Prisma.TransactionClient, input: CreateSupplierPaymentInput): Promise<CreateSupplierPaymentResult> {
  // ── ١. تحقّق الإدخال (صرف، قبل أي قفل) ──
  const tenantId = input.tenantId;
  if (typeof tenantId !== 'string' || !tenantId) throw new RangeError('createSupplierPaymentTx: tenantId مطلوب');
  if (typeof input.vendorId !== 'string' || !input.vendorId) throw invalid('المورّد مطلوب');
  const amount = input.amountMilli;
  if (typeof amount !== 'bigint' || amount <= 0n) throw invalid('مبلغ السند يجب أن يكون أكبر من صفر');
  if (!(SUPPLIER_PAYMENT_METHODS as readonly string[]).includes(input.method)) throw invalid('طريقة الدفع غير معروفة');
  const salesRepId = input.method === 'REP_CUSTODY' ? cleanText(input.salesRepId) : null;
  if (input.method === 'REP_CUSTODY' && !salesRepId) throw invalid('الدفع من عهدة مندوب يتطلب اختيار المندوب');
  const paidAt = validDay(input.paidAt, 'تاريخ الدفع غير صالح');
  const clientRef = cleanText(input.clientRef);
  if (clientRef && !CLIENT_REF_SCHEMA.safeParse(clientRef).success) throw invalid('مرجع العميل clientRef غير صالح');
  const autoFor = cleanText(input.autoForEntryId);

  const explicit = new Map<string, bigint>();
  for (const a of input.allocations ?? []) {
    const id = cleanText(a?.warehouseEntryId);
    if (!id) throw invalid('تخصيص بلا فاتورة');
    if (typeof a.amountMilli !== 'bigint' || a.amountMilli < 0n) throw invalid('مبلغ التخصيص غير صالح', { warehouseEntryId: id });
    if (a.amountMilli === 0n) continue;
    if (explicit.has(id)) throw invalid('الفاتورة مكرّرة في التخصيص', { warehouseEntryId: id });
    explicit.set(id, a.amountMilli);
  }
  let explicitSum = 0n;
  for (const v of explicit.values()) explicitSum += v;
  if (explicitSum > amount) {
    throw invalid('مجموع التخصيص أكبر من مبلغ السند', { allocated: milliToNumber(explicitSum), amount: milliToNumber(amount) });
  }
  // السند الآلي: لحركته وحدها وبكامل مبلغه (بلا تخصيصٍ ممرَّر ⇒ يُخصَّص لها كاملاً)
  if (autoFor) {
    if (!explicit.size) explicit.set(autoFor, amount);
    else if (explicit.size !== 1 || !explicit.has(autoFor) || explicit.get(autoFor) !== amount) {
      throw invalid('السند الآلي يُخصَّص كاملاً لحركته وحدها', { autoForEntryId: autoFor });
    }
  }
  const autoAllocate = input.autoAllocate === true && !autoFor;

  // ── ٢. المرجع المكرَّر ⇒ السند القائم بلا كتابة ──
  if (clientRef) {
    await lockPaymentClientRef(tx, tenantId, clientRef);
    const prior = await tx.supplierPayment.findFirst({
      where: { tenantId, clientRef },
      select: { id: true, number: true, vendorId: true, amountMilli: true, allocations: { select: { warehouseEntryId: true, amountMilli: true } } },
    });
    if (prior) {
      if (prior.vendorId !== input.vendorId || prior.amountMilli !== amount) {
        throw new SupplierError('CLIENT_REF_REUSED', 'مرجع العميل مستعمل لسندٍ آخر', undefined, { paymentId: prior.id });
      }
      return { id: prior.id, number: prior.number, replay: true, allocations: prior.allocations.map((a) => ({ warehouseEntryId: a.warehouseEntryId, amountMilli: a.amountMilli })) };
    }
  }

  // ── ٣. المورّد ومندوب العهدة من الشركة ──
  const vendor = await tx.glVendor.findFirst({ where: { id: input.vendorId, tenantId }, select: { id: true } });
  if (!vendor) throw new SupplierError('SUPPLIER_NOT_FOUND', 'المورّد غير موجود');
  if (salesRepId) {
    const rep = await tx.salesRep.findFirst({ where: { id: salesRepId, tenantId }, select: { id: true } });
    if (!rep) throw invalid('المندوب غير موجود في الشركة', { salesRepId });
  }
  if (autoFor) {
    const dup = await tx.supplierPayment.findFirst({ where: { tenantId, autoForEntryId: autoFor, status: 'POSTED' }, select: { id: true } });
    if (dup) throw new SupplierError('AUTO_PAYMENT_EXISTS', 'للحركة سند صرف آلي قائم', undefined, { paymentId: dup.id, autoForEntryId: autoFor });
  }

  // ── ٤. قفل صفوف الفواتير (استعلام واحد مرتّب) ثم التحقق والمتبقّي تحت القفل ──
  // التخصيص الآلي يرشّح المفتوحة أولاً بلا قفل (لا تُقفل فواتير المورّد المسدَّدة كلها — FOR UPDATE يكتب في كل صفّ)، ثم يُعاد
  // حسابها تحت القفل: ما سُدّد في الأثناء يُتخطّى، وما فُتح في الأثناء ينتظر سنداً تالياً — والحدّ «≤ المتبقّي» محفوظ دائماً
  const explicitIds = [...explicit.keys()];
  const autoIds = autoAllocate
    ? (await loadBillSettlements(tx, tenantId, { vendorIds: [input.vendorId] })).filter((s) => s.outstandingMilli > 0n).map((s) => s.bill.id)
    : [];
  const lockIds = [...new Set([...explicitIds, ...autoIds])];
  let locked: string[] = [];
  if (lockIds.length) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM warehouse_entries
      WHERE "tenantId" = ${tenantId} AND id = ANY(${lockIds}::text[])
      ORDER BY id
      FOR UPDATE`;
    locked = rows.map((r) => r.id);
  }
  const settled = locked.length ? await loadBillSettlements(tx, tenantId, { billIds: locked }) : [];
  const byId = new Map<string, BillSettlement>(settled.map((s) => [s.bill.id, s]));

  const final = new Map<string, bigint>();
  for (const [id, amt] of explicit) {
    const s = byId.get(id);
    // فاتورة شركةٍ أخرى أو غير موجودة: الرسالة نفسها (لا يُكشف وجودها)
    if (!s) throw invalid('الفاتورة غير موجودة', { warehouseEntryId: id });
    const b = s.bill;
    if (b.type !== 'RECEIVE' || b.totalMilli == null) throw invalid('الحركة ليست فاتورة مورّد مسعَّرة', { warehouseEntryId: id });
    if (b.vendorId !== input.vendorId) throw invalid('الفاتورة لمورّد آخر', { warehouseEntryId: id });
    if (b.status === 'CANCELLED') throw invalid('الفاتورة ملغاة', { warehouseEntryId: id });
    if (b.paymentMode === 'CASH') {
      if (autoFor !== id) throw invalid('الفاتورة النقدية مدفوعة بسندها الآلي ولا يُخصَّص لها', { warehouseEntryId: id });
    } else if (b.paymentMode !== 'CREDIT') {
      throw invalid('الحركة غير مصنَّفة (نقدي/آجل) — صنّفها أولاً', { warehouseEntryId: id });
    } else if (autoFor === id) {
      throw invalid('السند الآلي لحركة نقدية وحدها', { warehouseEntryId: id });
    }
    if (amt > s.outstandingMilli) {
      throw new SupplierError('ALLOCATION_EXCEEDS_OUTSTANDING', 'مبلغ التخصيص أكبر من المتبقّي على الفاتورة', undefined, {
        warehouseEntryId: id,
        supplierRef: b.supplierRef,
        outstanding: milliToNumber(s.outstandingMilli),
        requested: milliToNumber(amt),
      });
    }
    final.set(id, amt);
  }
  if (autoAllocate) {
    let remaining = amount - explicitSum;
    const pre = new Set(autoIds);
    const candidates = settled
      .filter((s) => pre.has(s.bill.id) && s.bill.vendorId === input.vendorId && s.bill.type === 'RECEIVE' && s.bill.paymentMode === 'CREDIT' && s.bill.status !== 'CANCELLED')
      .sort(compareByDue);
    for (const s of candidates) {
      if (remaining <= 0n) break;
      const room = s.outstandingMilli - (final.get(s.bill.id) ?? 0n);
      if (room <= 0n) continue;
      const take = room < remaining ? room : remaining;
      final.set(s.bill.id, (final.get(s.bill.id) ?? 0n) + take);
      remaining -= take;
    }
  }

  // ── ٥. الترقيم تحت قفل الشركة ثم الكتابة ──
  await lockPaymentNumbering(tx, tenantId);
  const last = await tx.supplierPayment.findFirst({ where: { tenantId }, orderBy: { number: 'desc' }, select: { number: true } });
  const number = (last?.number ?? 0) + 1;
  const note = cleanText(input.note);
  const createdBy = cleanText(input.createdBy);
  const payment = await tx.supplierPayment.create({
    data: {
      tenantId,
      vendorId: input.vendorId,
      number,
      amountMilli: amount,
      method: input.method,
      salesRepId,
      paidAt,
      reference: cleanText(input.reference),
      note,
      status: 'POSTED',
      autoForEntryId: autoFor,
      clientRef,
      createdBy,
    },
    select: { id: true },
  });
  const allocations = [...final].map(([warehouseEntryId, amountMilli]) => ({ warehouseEntryId, amountMilli }));
  if (allocations.length) {
    await tx.supplierPaymentAllocation.createMany({
      data: allocations.map((a) => ({ tenantId, paymentId: payment.id, warehouseEntryId: a.warehouseEntryId, amountMilli: a.amountMilli })),
    });
  }
  await tx.supplierLedgerEntry.create({
    data: {
      tenantId,
      vendorId: input.vendorId,
      kind: 'PAYMENT',
      amountMilli: signedLedgerAmount('PAYMENT', amount),
      supplierPaymentId: payment.id,
      docDate: paidAt,
      ref: supplierPaymentDisplayNumber(number),
      note,
      createdBy,
    },
  });
  return { id: payment.id, number, replay: false, allocations };
}

// ═══ الإلغاء ═══

export interface CancelSupplierPaymentOpts {
  by?: string | null;
  reason?: string | null;
  /** يسمح بإلغاء السند الآلي لاستلامٍ نقدي — لإلغاء الحركة وحده (routes/warehouse.ts) */
  allowAuto?: boolean;
  /**
   * تاريخ قيد العكس (يوم الشركة لحظة الإلغاء) — يمرّره المستدعي إن عرفه (إلغاء الحركة يمرّر تاريخ مرتجعها)، وإلا يُحسب بمنطقة
   * الشركة. لا يسبق تاريخ الدفعة: عكسٌ قبل أصله يُظهر في الكشف رصيداً لا وجود له بينهما.
   */
  docDate?: Date | null;
}

/** يوم الشركة الآن بأسبقية المنطقة نفسها في المشروع (إعدادات الدفاتر ثم البلد) — قراءةٌ فقط */
async function companyToday(tx: Prisma.TransactionClient, tenantId: string): Promise<Date> {
  const [gl, company] = await Promise.all([
    tx.glSettings.findUnique({ where: { tenantId }, select: { timezone: true } }),
    tx.companySettings.findUnique({ where: { tenantId }, select: { countryCode: true } }),
  ]);
  const day = parseDay(localDateIn(new Date(), companyTimeZone(gl?.timezone, company?.countryCode)));
  return day ?? utcDay(new Date());
}

/**
 * يلغي سند الصرف مرّة واحدة: قفل صفّه FOR UPDATE ثم الحالة CANCELLED (مع من ومتى ولماذا) وقيد PAYMENT_REV (+المبلغ، عكس قيد
 * PAYMENT حرفياً وreversesId إليه). تخصيصاته تبقى أثراً، ولا تُحسب في المتبقّي بعد الإلغاء. السند الآلي لا يُلغى إلا بـallowAuto.
 */
export async function cancelSupplierPaymentTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentId: string,
  opts: CancelSupplierPaymentOpts = {},
): Promise<void> {
  if (typeof tenantId !== 'string' || !tenantId) throw new RangeError('cancelSupplierPaymentTx: tenantId مطلوب');
  if (typeof paymentId !== 'string' || !paymentId) throw new SupplierError('SUPPLIER_PAYMENT_NOT_FOUND', 'السند غير موجود');
  const lockedRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM supplier_payments WHERE id = ${paymentId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (!lockedRows.length) throw new SupplierError('SUPPLIER_PAYMENT_NOT_FOUND', 'السند غير موجود');
  // القراءة بعد القفل: ترى ما التزم به إلغاءٌ سبقها
  const p = await tx.supplierPayment.findFirst({
    where: { id: paymentId, tenantId },
    select: { id: true, vendorId: true, number: true, amountMilli: true, status: true, autoForEntryId: true, paidAt: true },
  });
  if (!p) throw new SupplierError('SUPPLIER_PAYMENT_NOT_FOUND', 'السند غير موجود');
  if (p.status === 'CANCELLED') throw new SupplierError('SUPPLIER_PAYMENT_ALREADY_CANCELLED', 'السند ملغى مسبقاً', undefined, { paymentId });
  if (p.autoForEntryId && !opts.allowAuto) {
    throw new SupplierError('AUTO_PAYMENT_CANCEL_VIA_ENTRY', 'سند الصرف الآلي لاستلامٍ نقدي يُلغى بإلغاء حركة الاستلام', undefined, { autoForEntryId: p.autoForEntryId });
  }

  const requested = opts.docDate ? validDay(opts.docDate, 'تاريخ الإلغاء غير صالح') : await companyToday(tx, tenantId);
  const paidDay = utcDay(p.paidAt);
  const revDay = requested.getTime() < paidDay.getTime() ? paidDay : requested;
  const by = cleanText(opts.by);
  const reason = cleanText(opts.reason);

  const upd = await tx.supplierPayment.updateMany({
    where: { id: p.id, tenantId, status: 'POSTED' },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: by, cancelReason: reason },
  });
  if (upd.count !== 1) throw new SupplierError('SUPPLIER_PAYMENT_ALREADY_CANCELLED', 'السند ملغى مسبقاً', undefined, { paymentId });

  // عكس القيد الأصلي حرفياً (−قيمته)؛ وبلا قيدٍ أصلي (لا يقع) ⇒ عكس مبلغ السند
  const original = await tx.supplierLedgerEntry.findFirst({
    where: { tenantId, supplierPaymentId: p.id, kind: 'PAYMENT' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, amountMilli: true },
  });
  await tx.supplierLedgerEntry.create({
    data: {
      tenantId,
      vendorId: p.vendorId,
      kind: 'PAYMENT_REV',
      amountMilli: original ? -original.amountMilli : signedLedgerAmount('PAYMENT_REV', p.amountMilli),
      supplierPaymentId: p.id,
      reversesId: original?.id ?? null,
      docDate: revDay,
      ref: supplierPaymentDisplayNumber(p.number),
      note: reason,
      createdBy: by,
    },
  });
}

// ═══ المتبقّي ═══

/**
 * المتبقّي الراهن لكل فاتورة (billOutstandingMilli عبر loadBillSettlements): الدفعات الملغاة لا تُخصم، والمرتجعات المرتبطة
 * (returnOfEntryId) تُخصم بعد طرح ما رُدّ عنها نقداً، والملغاة صفر. معرّفٌ ليس في الشركة لا يظهر في الخريطة.
 * داخل معاملة كتابة: اقفل صفوف الفواتير قبلها (كما يفعل createSupplierPaymentTx) وإلا فالقراءة لحظية.
 */
export async function billOutstandingTx(tx: Prisma.TransactionClient, tenantId: string, warehouseEntryIds: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!warehouseEntryIds.length) return out;
  for (const s of await loadBillSettlements(tx, tenantId, { billIds: warehouseEntryIds })) out.set(s.bill.id, s.outstandingMilli);
  return out;
}
