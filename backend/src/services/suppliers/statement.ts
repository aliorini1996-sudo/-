/**
 * قراءات الموردين («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦): كشف الحساب، الفواتير المفتوحة، أعمار الذمم الدائنة، أرصدة الموردين.
 * قراءةٌ فقط: لا كتابة هنا إطلاقاً (gl_vendors يُقرأ وحده، ولا شيء في بقية gl_*). كل استعلام يحمل tenantId (عزل الشركة)، وعدد
 * الاستعلامات ثابت لا يتبع عدد الموردين أو الفواتير (لا N+1) — والقوائم الطويلة تُقسَّم دفعاتٍ ثابتة الحجم (CHUNK).
 * الحساب نفسه في core.ts (buildSupplierStatement، billOutstandingMilli، agingBucketOf) — هنا جلب الصفوف وتجميعها فقط.
 *
 * ═══ متبقّي الفاتورة الآجلة — مصدرٌ واحد لكل الشاشات ولتحقّق التخصيص في payments.ts (billOutstandingTx) ═══
 *   المتبقّي = الإجمالي − تخصيصات الدفعات السارية − «المرتجعات المطبَّقة»، عبر billOutstandingMilli (لا يقلّ عن صفر،
 *   والفاتورة الملغاة صفر).
 *   «المرتجع المطبَّق» = إجمالي حركة RETURN المرتبطة (returnOfEntryId) − ما ردّه المورّد عنها نقداً (REFUND_IN): المرتجع المردود
 *   نقداً سُوِّي بالنقد لا بالفاتورة. لو خُصم كاملاً لنقصت الفواتير المفتوحة عن رصيد الكشف بقدر الاسترداد
 *   (الكشف: +فاتورة −مرتجع +استرداد = الفاتورة كما هي).
 *
 * ═══ «حتى تاريخ» (asOf) لأعمار الذمم ═══
 *   الأعمار تقرير محاسبي يُستخرج لتاريخٍ مضى (إقفال الشهر)، فيُعاد بناء الحال كما كانت يومها: الفاتورة بتاريخها (billDate)،
 *   والتخصيص بتاريخ دفعته (paidAt) ما لم يُلغَ سندها بقيد PAYMENT_REV مؤرَّخ حتى asOf، والمرتجع والاسترداد بتاريخ قيدهما، والفاتورة
 *   الملغاة ملغاةٌ من تاريخ آخر مرتجعاتها (الإلغاء مرتجعٌ كامل). أما الفواتير المفتوحة وتحقّق التخصيص فبالحال الراهنة (كل ما سُجّل،
 *   ولو بتاريخٍ لاحق) — وإلا عرضت شاشة الدفع متبقّياً يرفضه التخصيص.
 */
import type { Prisma } from '@prisma/client';
import {
  AGING_BUCKETS,
  agingBucketOf,
  billOutstandingMilli,
  buildSupplierStatement,
  dayString,
  milliToNumber,
  type AgingBucket,
  type StatementLine,
} from './core';

// ═══ الأنواع والأدوات ═══

/** ما تحتاجه القراءات من عميل Prisma — العميل العام أو عميل معاملة */
export type SupplierReadDb = Pick<
  Prisma.TransactionClient,
  'glVendor' | 'supplierLedgerEntry' | 'supplierPayment' | 'supplierPaymentAllocation' | 'warehouseEntry' | 'warehouseEntryAttachment'
>;

/** حجم دفعة القوائم في `in` — بعيدٌ عن حدّ معاملات PostgreSQL (٣٢٧٦٧) ويبقي الاستعلامات ثابتة العدد عملياً */
const CHUNK = 1000;
const DAY_MS = 86_400_000;

function chunks<T>(arr: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function uniq(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

/** يوم UTC (منتصف الليل) — صيغة @db.Date نفسها، فالمقارنات يومٌ بيوم */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function absMilli(a: bigint): bigint {
  return a < 0n ? -a : a;
}

// ═══ تسوية الفواتير (صرفة) ═══

/** صفّ فاتورة المورّد (حركة وارد) كما يُقرأ */
export interface SettlementBill {
  id: string;
  vendorId: string | null;
  type: string;
  paymentMode: string | null;
  status: string;
  supplierRef: string | null;
  billDate: Date | null;
  dueDate: Date | null;
  createdAt: Date;
  totalMilli: bigint | null;
}

export interface SettlementAllocation {
  warehouseEntryId: string;
  amountMilli: bigint;
  paymentStatus: string;
  /** تاريخ الدفعة (paidAt) */
  paidAt: Date | null;
  /** تاريخ قيد PAYMENT_REV للسند الملغى (null = غير ملغى أو بلا قيد) */
  reversedOn: Date | null;
}

export interface SettlementReturn {
  id: string;
  returnOfEntryId: string;
  totalMilli: bigint | null;
  /** التاريخ المحاسبي للمرتجع: قيد RETURN، وإلا billDate الحركة، وإلا يوم كتابتها */
  day: Date;
}

export interface SettlementRefund {
  /** حركة RETURN التي رُدّ عنها المال (أو الفاتورة نفسها) */
  warehouseEntryId: string;
  amountMilli: bigint;
  day: Date;
}

export interface BillSettlement {
  bill: SettlementBill;
  /** تاريخ الفاتورة الفعلي: billDate وإلا يوم كتابة الحركة */
  billDay: Date;
  /** الاستحقاق الفعلي: dueDate وإلا تاريخ الفاتورة */
  dueDay: Date;
  totalMilli: bigint;
  paidMilli: bigint;
  /** المرتجعات المطبَّقة على الفاتورة (بعد طرح ما رُدّ نقداً) */
  returnedMilli: bigint;
  outstandingMilli: bigint;
  /** ملغاةٌ حتى التاريخ المطلوب */
  cancelled: boolean;
}

/**
 * تسوية كل فاتورة: المدفوع والمرتجع المطبَّق والمتبقّي (billOutstandingMilli). asOf = null ⇒ الحال الراهنة كما سُجّلت؛
 * asOf (يوم UTC) ⇒ الحال كما كانت يومها (انظر رأس الملف). الفاتورة بعد asOf لا تُعاد أصلاً.
 */
export function settleBills(
  bills: readonly SettlementBill[],
  allocations: readonly SettlementAllocation[],
  returns: readonly SettlementReturn[],
  refunds: readonly SettlementRefund[],
  asOf?: Date | null,
): BillSettlement[] {
  const cut = asOf ? utcDay(asOf).getTime() : null;
  const upTo = (d: Date | null) => cut == null || (d != null && d.getTime() <= cut);

  const allocByBill = new Map<string, SettlementAllocation[]>();
  for (const a of allocations) {
    const list = allocByBill.get(a.warehouseEntryId) ?? [];
    list.push(a);
    allocByBill.set(a.warehouseEntryId, list);
  }
  const returnsByBill = new Map<string, SettlementReturn[]>();
  for (const r of returns) {
    const list = returnsByBill.get(r.returnOfEntryId) ?? [];
    list.push(r);
    returnsByBill.set(r.returnOfEntryId, list);
  }
  const refundByEntry = new Map<string, bigint>();
  for (const f of refunds) {
    if (!upTo(f.day)) continue;
    refundByEntry.set(f.warehouseEntryId, (refundByEntry.get(f.warehouseEntryId) ?? 0n) + absMilli(f.amountMilli));
  }

  const out: BillSettlement[] = [];
  for (const bill of bills) {
    const billDay = bill.billDate ? utcDay(bill.billDate) : utcDay(bill.createdAt);
    if (!upTo(billDay)) continue;
    const dueDay = bill.dueDate ? utcDay(bill.dueDate) : billDay;
    const total = bill.type === 'RECEIVE' && bill.totalMilli != null ? bill.totalMilli : null;

    // الدفعة سارية حتى asOf: مؤرَّخة حتى asOf، ولم يُلغَ سندها بقيدٍ عكسيّ حتى asOf (الملغى بلا قيدٍ عكسيّ يُعدّ ملغىً)
    const counted = (allocByBill.get(bill.id) ?? []).filter((a) => {
      if (cut == null) return a.paymentStatus !== 'CANCELLED';
      if (!upTo(a.paidAt)) return false;
      return !(a.paymentStatus === 'CANCELLED' && (a.reversedOn == null || a.reversedOn.getTime() <= cut));
    });
    let paid = 0n;
    for (const a of counted) paid += a.amountMilli;

    const billReturns = returnsByBill.get(bill.id) ?? [];
    let returned = 0n;
    for (const r of billReturns) {
      if (!upTo(r.day)) continue;
      const applied = (r.totalMilli ?? 0n) - (refundByEntry.get(r.id) ?? 0n);
      if (applied > 0n) returned += applied;
    }
    // استردادٌ نقديّ رُبط بالفاتورة نفسها لا بحركة مرتجعها: يُطرح من مرتجعاتها (لا تنزل تحت الصفر)
    const billRefund = refundByEntry.get(bill.id) ?? 0n;
    returned = returned > billRefund ? returned - billRefund : 0n;

    // الإلغاء مرتجعٌ كامل للمتبقّي: ملغاةٌ حتى asOf إن وقعت كل مرتجعاتها حتى asOf (وبلا مرتجعات: ملغاة)
    const cancelled = bill.status === 'CANCELLED' && billReturns.every((r) => upTo(r.day));
    const outstanding = total == null
      ? 0n
      : billOutstandingMilli(
        { totalMilli: total, status: cancelled ? 'CANCELLED' : 'POSTED' },
        [{ amountMilli: paid, paymentStatus: 'POSTED' }],
        [{ totalMilli: returned }],
      );
    out.push({ bill, billDay, dueDay, totalMilli: total ?? 0n, paidMilli: paid, returnedMilli: returned, outstandingMilli: outstanding, cancelled });
  }
  return out;
}

// ═══ تسوية الفواتير (من القاعدة) ═══

const BILL_SELECT = {
  id: true, vendorId: true, type: true, paymentMode: true, status: true, supplierRef: true,
  billDate: true, dueDate: true, createdAt: true, totalMilli: true,
} as const;

export interface BillScope {
  /** فواتير بعينها (أي حالة أو نوع — غير الوارد المسعَّر متبقّيه صفر) */
  billIds?: readonly string[];
  /** فواتير الآجل لهؤلاء الموردين؛ غياب billIds وvendorIds ⇒ كل فواتير الآجل في الشركة */
  vendorIds?: readonly string[];
  /** يوم UTC: الحال كما كانت يومها (الأعمار)؛ غيابه ⇒ الحال الراهنة */
  asOf?: Date | null;
}

/**
 * يجلب الفواتير وتخصيصاتها ودفعاتها ومرتجعاتها واستردادها بعدد استعلامات ثابت، ثم settleBills.
 * بلا asOf تُستبعد الفواتير الملغاة من نطاق الموردين في الاستعلام (متبقّيها صفر)؛ ومع asOf تُجلب (ربما كانت مفتوحة يومها).
 */
export async function loadBillSettlements(db: SupplierReadDb, tenantId: string, scope: BillScope): Promise<BillSettlement[]> {
  const asOf = scope.asOf ? utcDay(scope.asOf) : null;

  const bills: SettlementBill[] = [];
  if (scope.billIds) {
    for (const part of chunks(uniq(scope.billIds))) {
      bills.push(...(await db.warehouseEntry.findMany({ where: { tenantId, id: { in: part } }, select: BILL_SELECT })) as SettlementBill[]);
    }
  } else {
    const base: Prisma.WarehouseEntryWhereInput = {
      tenantId,
      type: 'RECEIVE',
      paymentMode: 'CREDIT',
      totalMilli: { not: null },
      ...(asOf
        ? { OR: [{ billDate: { lte: asOf } }, { billDate: null, createdAt: { lt: addDays(asOf, 1) } }] }
        : { status: { not: 'CANCELLED' } }),
    };
    const vendorParts = scope.vendorIds ? chunks(uniq(scope.vendorIds)) : [null];
    for (const part of vendorParts) {
      if (part && !part.length) continue;
      const where: Prisma.WarehouseEntryWhereInput = { ...base, vendorId: part ? { in: part } : { not: null } };
      bills.push(...(await db.warehouseEntry.findMany({ where, select: BILL_SELECT })) as SettlementBill[]);
    }
  }
  if (!bills.length) return [];
  const billIds = bills.map((b) => b.id);

  // التخصيصات ثم حالة دفعاتها وتاريخها (والملغاة حتى asOf: تاريخ قيدها العكسيّ)
  const allocRows: { paymentId: string; warehouseEntryId: string; amountMilli: bigint }[] = [];
  for (const part of chunks(billIds)) {
    allocRows.push(...(await db.supplierPaymentAllocation.findMany({
      where: { tenantId, warehouseEntryId: { in: part } },
      select: { paymentId: true, warehouseEntryId: true, amountMilli: true },
    })));
  }
  const payments = new Map<string, { status: string; paidAt: Date }>();
  for (const part of chunks(uniq(allocRows.map((a) => a.paymentId)))) {
    for (const p of await db.supplierPayment.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, status: true, paidAt: true } })) {
      payments.set(p.id, { status: p.status, paidAt: p.paidAt });
    }
  }
  const reversedOn = new Map<string, Date>();
  if (asOf) {
    const cancelledIds = [...payments].filter(([, p]) => p.status === 'CANCELLED').map(([id]) => id);
    for (const part of chunks(cancelledIds)) {
      const revs = await db.supplierLedgerEntry.findMany({
        where: { tenantId, kind: 'PAYMENT_REV', supplierPaymentId: { in: part } },
        select: { supplierPaymentId: true, docDate: true },
      });
      for (const r of revs) {
        if (!r.supplierPaymentId) continue;
        const d = utcDay(r.docDate);
        const prev = reversedOn.get(r.supplierPaymentId);
        if (!prev || d < prev) reversedOn.set(r.supplierPaymentId, d);
      }
    }
  }
  // سند مفقود (لا يقع: التخصيص يُحذف مع سنده) يُعدّ سارياً — يحمي من تخصيصٍ يتجاوز المتبقّي لا العكس
  const allocations: SettlementAllocation[] = allocRows.map((a) => {
    const p = payments.get(a.paymentId);
    return {
      warehouseEntryId: a.warehouseEntryId,
      amountMilli: a.amountMilli,
      paymentStatus: p?.status ?? 'POSTED',
      paidAt: p ? utcDay(p.paidAt) : null,
      reversedOn: reversedOn.get(a.paymentId) ?? null,
    };
  });

  // المرتجعات المرتبطة (غير الملغاة) وقيودها: تاريخ RETURN المحاسبي وما رُدّ نقداً REFUND_IN
  const retRows: { id: string; returnOfEntryId: string | null; totalMilli: bigint | null; billDate: Date | null; createdAt: Date }[] = [];
  for (const part of chunks(billIds)) {
    retRows.push(...(await db.warehouseEntry.findMany({
      where: { tenantId, type: 'RETURN', returnOfEntryId: { in: part }, status: { not: 'CANCELLED' } },
      select: { id: true, returnOfEntryId: true, totalMilli: true, billDate: true, createdAt: true },
    })));
  }
  const retDay = new Map<string, Date>();
  const refunds: SettlementRefund[] = [];
  if (retRows.length) {
    const linkIds = uniq([...retRows.map((r) => r.id), ...retRows.map((r) => r.returnOfEntryId)]);
    for (const part of chunks(linkIds)) {
      const rows = await db.supplierLedgerEntry.findMany({
        where: { tenantId, kind: { in: ['RETURN', 'REFUND_IN'] }, warehouseEntryId: { in: part } },
        select: { kind: true, warehouseEntryId: true, amountMilli: true, docDate: true },
      });
      for (const r of rows) {
        if (!r.warehouseEntryId) continue;
        const d = utcDay(r.docDate);
        if (r.kind === 'RETURN') {
          const prev = retDay.get(r.warehouseEntryId);
          if (!prev || d < prev) retDay.set(r.warehouseEntryId, d);
        } else {
          refunds.push({ warehouseEntryId: r.warehouseEntryId, amountMilli: r.amountMilli, day: d });
        }
      }
    }
  }
  const returns: SettlementReturn[] = retRows
    .filter((r): r is typeof r & { returnOfEntryId: string } => !!r.returnOfEntryId)
    .map((r) => ({
      id: r.id,
      returnOfEntryId: r.returnOfEntryId,
      totalMilli: r.totalMilli,
      day: retDay.get(r.id) ?? utcDay(r.billDate ?? r.createdAt),
    }));

  return settleBills(bills, allocations, returns, refunds, asOf);
}

/** ترتيب «الأقدم استحقاقاً أولاً» الحتمي: الاستحقاق ثم تاريخ الفاتورة ثم لحظة الكتابة ثم المعرّف */
export function compareByDue(a: BillSettlement, b: BillSettlement): number {
  return a.dueDay.getTime() - b.dueDay.getTime()
    || a.billDay.getTime() - b.billDay.getTime()
    || a.bill.createdAt.getTime() - b.bill.createdAt.getTime()
    || (a.bill.id < b.bill.id ? -1 : a.bill.id > b.bill.id ? 1 : 0);
}

// ═══ كشف الحساب ═══

const VENDOR_SELECT = {
  id: true, name: true, nameEn: true, code: true, vatNumber: true, crNumber: true, phone: true, email: true, address: true,
  city: true, countryCode: true, iban: true, bankName: true, paymentDays: true, isActive: true, notes: true, createdAt: true,
} as const;

export interface SupplierVendorRow {
  id: string; name: string; nameEn: string | null; code: string | null; vatNumber: string | null; crNumber: string | null;
  phone: string | null; email: string | null; address: string | null; city: string | null; countryCode: string;
  iban: string | null; bankName: string | null; paymentDays: number | null; isActive: boolean; notes: string | null; createdAt: Date;
}

export interface SupplierLedgerRow {
  id: string;
  kind: string;
  amountMilli: bigint;
  netMilli: bigint | null;
  taxMilli: bigint | null;
  docDate: Date;
  dueDate: Date | null;
  createdAt: Date;
  ref: string | null;
  note: string | null;
  warehouseEntryId: string | null;
  supplierPaymentId: string | null;
  reversesId: string | null;
}

const LEDGER_SELECT = {
  id: true, kind: true, amountMilli: true, netMilli: true, taxMilli: true, docDate: true, dueDate: true, createdAt: true,
  ref: true, note: true, warehouseEntryId: true, supplierPaymentId: true, reversesId: true,
} as const;

export interface SupplierStatementData {
  vendor: SupplierVendorRow;
  from: Date | null;
  to: Date | null;
  openingMilli: bigint;
  closingMilli: bigint;
  totalDebitMilli: bigint;
  totalCreditMilli: bigint;
  lines: (StatementLine<SupplierLedgerRow> & { attachmentsCount: number })[];
}

/**
 * كشف حساب مورّد لفترة [from, to] (يوما UTC، كلاهما اختياري): الافتتاحي = Σ ما قبل from بتجميعٍ في القاعدة، والسطور في الفترة
 * بالترتيب الحتمي ورصيدٍ جارٍ (buildSupplierStatement مُزاحاً بالافتتاحي)، ولكل سطر عدد مرفقات حركته. مورّد خارج الشركة ⇒ null.
 * الاستعلامات: المورّد + الافتتاحي + السطور + المرفقات — أربعة مهما طال الكشف.
 */
export async function loadSupplierStatement(
  db: SupplierReadDb,
  tenantId: string,
  vendorId: string,
  from?: Date | null,
  to?: Date | null,
): Promise<SupplierStatementData | null> {
  const fromDay = from ? utcDay(from) : null;
  const toDay = to ? utcDay(to) : null;
  const vendor = (await db.glVendor.findFirst({ where: { id: vendorId, tenantId }, select: VENDOR_SELECT })) as SupplierVendorRow | null;
  if (!vendor) return null;

  let opening = 0n;
  if (fromDay) {
    const agg = await db.supplierLedgerEntry.aggregate({ where: { tenantId, vendorId, docDate: { lt: fromDay } }, _sum: { amountMilli: true } });
    opening = agg._sum.amountMilli ?? 0n;
  }
  const docDate: Prisma.DateTimeFilter = {};
  if (fromDay) docDate.gte = fromDay;
  if (toDay) docDate.lte = toDay;
  const rows = (await db.supplierLedgerEntry.findMany({
    where: { tenantId, vendorId, ...((fromDay || toDay) && { docDate }) },
    orderBy: [{ docDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: LEDGER_SELECT,
  })) as SupplierLedgerRow[];

  // السطور في الفترة أصلاً (القاعدة رشّحتها)، فالبناء بلا حدود ثم إزاحة الرصيد الجاري بالافتتاحي — الجمع خطّي فالإزاحة دقيقة
  const built = buildSupplierStatement(rows);
  const entryIds = uniq(rows.map((r) => r.warehouseEntryId));
  const attachments = new Map<string, number>();
  for (const part of chunks(entryIds)) {
    const groups = await db.warehouseEntryAttachment.groupBy({
      by: ['entryId'],
      where: { tenantId, entryId: { in: part } },
      _count: { _all: true },
    });
    for (const g of groups) attachments.set(g.entryId, g._count._all);
  }
  return {
    vendor,
    from: fromDay,
    to: toDay,
    openingMilli: opening,
    closingMilli: opening + built.closingMilli,
    totalDebitMilli: built.totalDebitMilli,
    totalCreditMilli: built.totalCreditMilli,
    lines: built.lines.map((l) => ({
      ...l,
      balanceMilli: l.balanceMilli + opening,
      attachmentsCount: l.row.warehouseEntryId ? attachments.get(l.row.warehouseEntryId) ?? 0 : 0,
    })),
  };
}

// ═══ الفواتير المفتوحة ═══

export interface OpenBillRow {
  warehouseEntryId: string;
  supplierRef: string | null;
  /** تاريخ الفاتورة الفعلي (billDate وإلا يوم الحركة) */
  billDate: Date;
  /** الاستحقاق الفعلي (dueDate وإلا تاريخ الفاتورة) */
  dueDate: Date;
  totalMilli: bigint;
  paidMilli: bigint;
  returnedMilli: bigint;
  outstandingMilli: bigint;
  /** أيام التأخير بعد الاستحقاق حتى asOf (صفر لغير المتأخّرة) */
  daysOverdue: number;
}

function daysOverdueOf(dueDay: Date, asOf: Date): number {
  const d = Math.floor((utcDay(asOf).getTime() - dueDay.getTime()) / DAY_MS);
  return d > 0 ? d : 0;
}

/**
 * فواتير المورّد الآجلة غير الملغاة ذات متبقٍّ > 0، الأقدم استحقاقاً أولاً. بالحال الراهنة (كما يراها تحقّق التخصيص)،
 * وasOf (يوم الشركة) لأيام التأخير وحدها.
 */
export async function loadOpenBills(db: SupplierReadDb, tenantId: string, vendorId: string, asOf: Date): Promise<OpenBillRow[]> {
  const settled = await loadBillSettlements(db, tenantId, { vendorIds: [vendorId] });
  return settled
    .filter((s) => s.outstandingMilli > 0n)
    .sort(compareByDue)
    .map((s) => ({
      warehouseEntryId: s.bill.id,
      supplierRef: s.bill.supplierRef,
      billDate: s.billDay,
      dueDate: s.dueDay,
      totalMilli: s.totalMilli,
      paidMilli: s.paidMilli,
      returnedMilli: s.returnedMilli,
      outstandingMilli: s.outstandingMilli,
      daysOverdue: daysOverdueOf(s.dueDay, asOf),
    }));
}

// ═══ أعمار الذمم الدائنة ═══

export type AgingBuckets = Record<AgingBucket, bigint>;

function emptyBuckets(): AgingBuckets {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0n])) as AgingBuckets;
}

export interface AgingRow {
  vendorId: string;
  name: string;
  code: string | null;
  isActive: boolean;
  buckets: AgingBuckets;
  /** Σ الشرائح = متبقّي الفواتير المفتوحة حتى asOf */
  totalMilli: bigint;
  /** رصيد كشف المورّد حتى asOf (Σ القيود بتاريخ ≤ asOf) */
  balanceMilli: bigint;
  /**
   * الرصيد − متبقّي الفواتير: ما ليس على فاتورة — سالبٌ لدفعةٍ مقدّمة غير مخصَّصة أو مرتجعٍ زاد على المتبقّي (رصيد مدين للمورّد)،
   * وموجبٌ لرصيدٍ افتتاحي دائن. يجعل التقرير يطابق الكشف بفرق صفر.
   */
  unappliedMilli: bigint;
  openBillsCount: number;
}

export interface AgingResult {
  asOf: Date;
  rows: AgingRow[];
  totals: { buckets: AgingBuckets; totalMilli: bigint; balanceMilli: bigint; unappliedMilli: bigint };
}

/**
 * أعمار الذمم الدائنة للشركة حتى asOf (يوم UTC): لكل مورّدٍ له فاتورة مفتوحة أو رصيد غير صفري حتى asOf صفٌّ بشرائح
 * agingBucketOf على الاستحقاق، ورصيد الكشف، والفرق غير المخصَّص. المورّد المؤرشف يظهر ما دام عليه شيء. مرتّبة بالاسم.
 */
export async function loadAging(db: SupplierReadDb, tenantId: string, asOf: Date): Promise<AgingResult> {
  const day = utcDay(asOf);
  const settled = await loadBillSettlements(db, tenantId, { asOf: day });
  const balances = new Map<string, bigint>();
  const groups = await db.supplierLedgerEntry.groupBy({
    by: ['vendorId'],
    where: { tenantId, docDate: { lte: day } },
    _sum: { amountMilli: true },
  });
  for (const g of groups) balances.set(g.vendorId, g._sum.amountMilli ?? 0n);

  const byVendor = new Map<string, { buckets: AgingBuckets; total: bigint; count: number }>();
  for (const s of settled) {
    if (s.outstandingMilli <= 0n || !s.bill.vendorId) continue;
    const v = byVendor.get(s.bill.vendorId) ?? { buckets: emptyBuckets(), total: 0n, count: 0 };
    v.buckets[agingBucketOf(s.dueDay, day)] += s.outstandingMilli;
    v.total += s.outstandingMilli;
    v.count += 1;
    byVendor.set(s.bill.vendorId, v);
  }
  const vendorIds = uniq([...byVendor.keys(), ...[...balances].filter(([, b]) => b !== 0n).map(([id]) => id)]);
  const vendors = new Map<string, { name: string; code: string | null; isActive: boolean }>();
  for (const part of chunks(vendorIds)) {
    for (const v of await db.glVendor.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, name: true, code: true, isActive: true } })) {
      vendors.set(v.id, { name: v.name, code: v.code, isActive: v.isActive });
    }
  }

  const totals = { buckets: emptyBuckets(), totalMilli: 0n, balanceMilli: 0n, unappliedMilli: 0n };
  const rows: AgingRow[] = [];
  for (const id of vendorIds) {
    const meta = vendors.get(id);
    if (!meta) continue; // قيدٌ لمورّدٍ ليس في الشركة لا يقع (العزل في كل استعلام) — لا يُعرض صفّ بلا اسم
    const open = byVendor.get(id) ?? { buckets: emptyBuckets(), total: 0n, count: 0 };
    const balance = balances.get(id) ?? 0n;
    const row: AgingRow = {
      vendorId: id, name: meta.name, code: meta.code, isActive: meta.isActive,
      buckets: open.buckets, totalMilli: open.total, balanceMilli: balance, unappliedMilli: balance - open.total, openBillsCount: open.count,
    };
    rows.push(row);
    for (const b of AGING_BUCKETS) totals.buckets[b] += row.buckets[b];
    totals.totalMilli += row.totalMilli;
    totals.balanceMilli += row.balanceMilli;
    totals.unappliedMilli += row.unappliedMilli;
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'ar') || (a.vendorId < b.vendorId ? -1 : a.vendorId > b.vendorId ? 1 : 0));
  return { asOf: day, rows, totals };
}

// ═══ أرصدة الموردين (لقائمة الموردين وبطاقة المورّد) ═══

export interface SupplierBalanceInfo {
  /** Σ قيود الكشف (موجب = مستحقّ للمورّد) — كل ما سُجّل */
  balanceMilli: bigint;
  /** فواتير آجلة غير ملغاة متبقّيها > 0 (بالحال الراهنة) */
  openBillsCount: number;
  /** Σ متبقّي تلك الفواتير */
  openBillsMilli: bigint;
}

/** رصيد كل مورّد وعدد فواتيره المفتوحة — لكل معرّفٍ مطلوب مدخلٌ (أصفار لمن لا حركة له). استعلامات ثابتة العدد للصفحة كلها */
export async function loadSupplierBalances(db: SupplierReadDb, tenantId: string, vendorIds: readonly string[]): Promise<Map<string, SupplierBalanceInfo>> {
  const ids = uniq(vendorIds);
  const out = new Map<string, SupplierBalanceInfo>(ids.map((id) => [id, { balanceMilli: 0n, openBillsCount: 0, openBillsMilli: 0n }]));
  if (!ids.length) return out;
  for (const part of chunks(ids)) {
    const groups = await db.supplierLedgerEntry.groupBy({
      by: ['vendorId'],
      where: { tenantId, vendorId: { in: part } },
      _sum: { amountMilli: true },
    });
    for (const g of groups) {
      const info = out.get(g.vendorId);
      if (info) info.balanceMilli = g._sum.amountMilli ?? 0n;
    }
  }
  for (const s of await loadBillSettlements(db, tenantId, { vendorIds: ids })) {
    if (s.outstandingMilli <= 0n || !s.bill.vendorId) continue;
    const info = out.get(s.bill.vendorId);
    if (!info) continue;
    info.openBillsCount += 1;
    info.openBillsMilli += s.outstandingMilli;
  }
  return out;
}

// ═══ تحويل JSON (BigInt لا يمرّ في res.json — كل ملّي إلى رقم بوحدة العملة) ═══

/** سطور الكشف بشكل العقد: {id, date, kind, ref, description, debit, credit, balance, dueDate, warehouseEntryId, supplierPaymentId, attachmentsCount} */
export function statementJson(data: SupplierStatementData) {
  return {
    from: data.from ? dayString(data.from) : null,
    to: data.to ? dayString(data.to) : null,
    opening: milliToNumber(data.openingMilli),
    closing: milliToNumber(data.closingMilli),
    totalDebit: milliToNumber(data.totalDebitMilli),
    totalCredit: milliToNumber(data.totalCreditMilli),
    lines: data.lines.map((l) => ({
      id: l.row.id,
      date: dayString(l.row.docDate),
      kind: l.row.kind,
      ref: l.row.ref,
      description: l.row.note,
      debit: milliToNumber(l.debitMilli),
      credit: milliToNumber(l.creditMilli),
      balance: milliToNumber(l.balanceMilli),
      dueDate: l.row.dueDate ? dayString(l.row.dueDate) : null,
      warehouseEntryId: l.row.warehouseEntryId,
      supplierPaymentId: l.row.supplierPaymentId,
      attachmentsCount: l.attachmentsCount,
    })),
  };
}

/** فاتورة مفتوحة بشكل العقد: {warehouseEntryId, supplierRef, billDate, dueDate, total, paid, returned, outstanding, daysOverdue} */
export function openBillJson(r: OpenBillRow) {
  return {
    warehouseEntryId: r.warehouseEntryId,
    supplierRef: r.supplierRef,
    billDate: dayString(r.billDate),
    dueDate: dayString(r.dueDate),
    total: milliToNumber(r.totalMilli),
    paid: milliToNumber(r.paidMilli),
    returned: milliToNumber(r.returnedMilli),
    outstanding: milliToNumber(r.outstandingMilli),
    daysOverdue: r.daysOverdue,
  };
}

function bucketsJson(b: AgingBuckets) {
  return { current: milliToNumber(b.current), d1_30: milliToNumber(b.d1_30), d31_60: milliToNumber(b.d31_60), d61_90: milliToNumber(b.d61_90), d90_plus: milliToNumber(b.d90_plus) };
}

/** الأعمار بشكل العقد: {asOf, rows:[{supplierId, name, current…d90_plus, total}], totals} + balance وunapplied إضافةً */
export function agingJson(a: AgingResult) {
  return {
    asOf: dayString(a.asOf),
    rows: a.rows.map((r) => ({
      supplierId: r.vendorId,
      name: r.name,
      code: r.code,
      isActive: r.isActive,
      ...bucketsJson(r.buckets),
      total: milliToNumber(r.totalMilli),
      balance: milliToNumber(r.balanceMilli),
      unapplied: milliToNumber(r.unappliedMilli),
      openBillsCount: r.openBillsCount,
    })),
    totals: {
      ...bucketsJson(a.totals.buckets),
      total: milliToNumber(a.totals.totalMilli),
      balance: milliToNumber(a.totals.balanceMilli),
      unapplied: milliToNumber(a.totals.unappliedMilli),
    },
  };
}
