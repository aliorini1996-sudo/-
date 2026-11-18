/**
 * «تقرير المشتريات» في صفحة التقارير (طلب المالك ١٧ نوفمبر ٢٠٢٦) — GET /api/reports/purchases.
 *
 * ═══ المصدر ═══
 *   حركات المستودع warehouse_entries من نوعين: الوارد RECEIVE (شراءٌ من مورّد) والمرتجع للمورّد RETURN. لا تدخل التسويات (ADJUST)
 *   ولا التصفير (STOCK_ZERO) ولا «المخزون الافتتاحي» (OPENING_IMPORT بعموده، أو حركة استيرادٍ سبقت العمود بدفعتها —
 *   legacyOpeningImportIds) ولا مرتجعُ واردٍ افتتاحي — كبطاقة «المشتريات الشهرية» (services/warehouseStock monthPurchasesOf).
 *   والوارد الملغى (CANCELLED) يدخل ومعه حركة إلغائه (RETURN كاملة بتاريخ الإلغاء) فيصفو صفراً — كالكشف والبطاقة: الإلغاء
 *   مرتجعٌ لا حذف. ولا يُعدّ في «عدد الفواتير».
 *
 * ═══ القيمة ═══
 *   المسعَّر المصنَّف (نقدي/آجل، والمرتجع المسعَّر): netMilli/taxMilli/totalMilli المحفوظة كما هي — مصدر كشف المورّد والقيود.
 *   وغير المصنَّف: Σ |الكمية| × تكلفة الوحدة (صافية قبل الضريبة دائماً، بوحدة السطر) مقرَّبةً نصف-لأعلى بمنازل عملة الشركة، بلا
 *   ضريبة. كل الجمع بالملّي (BigInt) فلا ضجيج فاصلة عائمة، والتحويل للرقم عند الإرسال.
 *   «إزالة الضريبة» (CompanySettings.taxDisabled): لا ذكر للضريبة — مبلغ كل حركة إجماليُّها (ما دُفع للمورّد، والضريبة
 *   كلفةٌ على منشأةٍ غير مسجّلة)، ومفاتيح الضريبة تغيب من الردّ (taxHidden).
 *
 * ═══ التاريخ ═══
 *   تاريخ الحركة = تاريخ فاتورة المورّد (billDate، يومٌ محلي) إن وُجد، وإلا يوم الاستلام بتوقيت الشركة (لا UTC). والمدى
 *   «من/إلى» أيامٌ محلية شاملة؛ وبلا مدى آخر ٩٠ يوماً حتى اليوم ويُعلَن (meta.appliedRange.defaulted) كتقرير المبيعات.
 *
 * ═══ الأعمدة (لكل صفّ وللإجمالي) ═══
 *   net/tax/total: الوارد قبل المرتجع (صافٍ قبل الضريبة، ضريبته، إجماليه).  returns/returnsTax/returnsTotal: المرتجع للمورّد.
 *   netPurchases = net − returns («صافي المشتريات» قبل الضريبة)، netTax = tax − returnsTax، netTotal = netPurchases + netTax.
 *   cash/credit/unclassified: netTotal مقسوماً بنوع الشراء — والمرتجع ينقص نوع وارده الأصلي (returnOfEntryId)، ومرتجعٌ بلا أصل
 *   (وارد سالب) بنوعه هو. paid/remaining: المدفوع والمتبقّي لفواتير الآجل الواردة في الفترة **بحالها اليوم**
 *   (services/suppliers/statement loadBillSettlements — مصدر الفواتير المفتوحة نفسه)، وnull في تجميع الصنف (لا تُقسَم دفعةٌ على أصناف).
 *   مثال: وارد ١٠٠ × ٢٠ بضريبة ١٥٪ آجل ثم مرتجع ١٠ ⇒ net ٢٠٠٠، returns ٢٠٠، netPurchases ١٨٠٠، netTax ٢٧٠، netTotal ٢٠٧٠.
 *
 * ═══ التجميع ═══
 *   vendor (المورّد: سجلّ الموردين، وإلا نصّ المورّد الحرّ، وإلا «بلا مورّد» name=null) | product (الصنف: الكمية بوحدة الأساس، ومال
 *   الحركة موزَّعٌ على أسطرها بأكبر الباقي فيطابق مجموعُ الأصناف إجماليَّ الحركات حرفاً) | day | month.
 *
 * ═══ الحرّاس والعزل ═══
 *   يُركَّب تحت موجّه التقارير (authenticate + requireAdmin + canViewReports)، ويضيف حرّاس المستودع والموردين نفسها: لا مندوب،
 *   وcanManageVanStock (تكلفة الشراء = هامش ربح الشركة)، والنظام المحاسبي غير مطفأ، ومخزون الشركة مفعّل. المشتريات على مستوى
 *   الشركة لا عميل لها ولا مندوب، فنطاق المستخدم المقيَّد لا يقصّها (كسجلّ المستودع) — ولا يحمل الردّ «مصدر الدفع» ولا مندوباً.
 *   كل استعلام يحمل tenantId، وعدد الاستعلامات ثابت لا يتبع عدد الحركات (لا N+1).
 */
import type { Response, NextFunction } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireAdminPermission, tenantId } from '../../middleware/auth';
import type { AuthRequest } from '../../types';
import { currencyDecimalsOf } from '../../config/countries';
import { companyTimeZone } from '../erpPayload';
import { addDays, fromDbDate, isLocalDate, localDate, todayLocal, toDbDate, zonedStartOfDay } from '../gl/dates';
import type { LocalDate } from '../gl/types';
import { baseQtyOf, roundQty } from '../units';
import { milliToNumber, toMilliAmount } from '../suppliers/core';
import { loadBillSettlements, type SupplierReadDb } from '../suppliers/statement';
import { legacyOpeningImportIds } from '../suppliers/warehouseBills';
import { isTaxOff } from '../taxMode';

// ═══ الثوابت والأنواع ═══

export const PURCHASE_GROUP_BYS = ['vendor', 'product', 'day', 'month'] as const;
export type PurchaseGroupBy = (typeof PURCHASE_GROUP_BYS)[number];

/** نافذة التقرير بلا مدى — كتقرير المبيعات */
export const PURCHASES_DEFAULT_DAYS = 90;
/** سقف الحركات المقروءة (أحدثها) — يُعلَن meta.truncated إن بُلغ؛ قاعدةٌ صغيرة لا تبلغه عملياً */
export const PURCHASES_ENTRY_LIMIT = 20_000;
/** مصادر لا تُعدّ شراءً: المخزون الافتتاحي (جردٌ أُدخل) والتصفير (تسوية) */
const EXCLUDED_SOURCES = ['OPENING_IMPORT', 'STOCK_ZERO'] as const;
const CHUNK = 1000;

/** وحدة صنفٍ للعرض («٢ كرتون و٣ حبة») — شكل ReportUnit في routes/reports.ts */
export interface PurchaseUnit { id?: string; name: string; factor: number }

export interface PurchaseItemRow {
  productId: string;
  qty: number;
  baseQty?: number | null;
  unitFactor?: number | null;
  unitName?: string | null;
  unitCost: number | null;
  taxPct?: number | null;
  product?: { id: string; name: string; code: string | null; unit: string | null; primaryUnitId?: string | null } | null;
}

export interface PurchaseEntryRow {
  id: string;
  type: string;
  status: string;
  source?: string | null;
  note?: string | null;
  vendorId: string | null;
  vendor?: { name: string } | null;
  supplier: string | null;
  paymentMode: string | null;
  billDate: Date | null;
  createdAt: Date;
  netMilli: bigint | null;
  taxMilli: bigint | null;
  totalMilli: bigint | null;
  returnOfEntryId: string | null;
  items: PurchaseItemRow[];
}

/** تسوية فاتورة آجلة: المدفوع والمتبقّي بالملّي */
export interface PurchaseSettlement { paidMilli: bigint; outstandingMilli: bigint }

export interface BuildPurchasesOpts {
  groupBy: PurchaseGroupBy;
  timeZone: string;
  decimals: number;
  taxHidden: boolean;
  /** نوع الدفع للوارد الأصلي لكل مرتجع (returnOfEntryId ⇒ paymentMode) — المرتجع ينقص نوع وارده */
  originModes?: ReadonlyMap<string, string | null>;
  /** تسويات فواتير الآجل (معرّف الوارد ⇒ المدفوع والمتبقّي) */
  settlements?: ReadonlyMap<string, PurchaseSettlement>;
  /** وحدات الأصناف النشطة (تجميع الصنف) */
  units?: ReadonlyMap<string, PurchaseUnit[]>;
}

/** أعمدة المال في الصفّ والإجمالي — مفاتيح الضريبة تغيب مع «إزالة الضريبة» */
export interface PurchaseMoneyJson {
  net: number;
  tax?: number;
  total: number;
  returns: number;
  returnsTax?: number;
  returnsTotal: number;
  netPurchases: number;
  netTax?: number;
  netTotal: number;
  cash: number;
  credit: number;
  unclassified: number;
  /** المدفوع والمتبقّي من فواتير الآجل (اليوم) — null في تجميع الصنف */
  paid: number | null;
  remaining: number | null;
}

export interface PurchaseRowJson extends PurchaseMoneyJson {
  /** مفتاح ثابت: v:<vendorId> | s:<نصّ المورّد> | none | p:<productId> | YYYY-MM-DD | YYYY-MM */
  key: string;
  /** الاسم: المورّد أو الصنف أو اليوم أو الشهر؛ null = «بلا مورّد» */
  name: string | null;
  /** تجميع الصنف وحده */
  code?: string | null;
  unit?: string | null;
  units?: PurchaseUnit[];
  primaryUnitId?: string | null;
  /** فواتير الوارد غير الملغاة (للصنف: الفواتير التي فيها الصنف) */
  bills: number;
  /** حركات المرتجع للمورّد */
  returnsCount: number;
  /** تجميع الصنف: الكمية بوحدة الأساس — الوارد والمرتجع والصافي؛ null لغيره */
  qty: number | null;
  receivedQty: number | null;
  returnedQty: number | null;
}

export interface PurchaseSummaryJson extends PurchaseMoneyJson {
  bills: number;
  returnsCount: number;
  vendors: number;
  products: number;
  /** وارد بلا تكلفة في أيٍّ من أسطره ولا تصنيف — قيمته صفر في التقرير */
  unpricedEntries: number;
}

export interface PurchasesReportJson {
  groupBy: PurchaseGroupBy;
  taxHidden: boolean;
  rows: PurchaseRowJson[];
  summary: PurchaseSummaryJson;
}

// ═══ أدوات المال ═══

interface Money { net: bigint; tax: bigint; total: bigint }
const ZERO: Money = { net: 0n, tax: 0n, total: 0n };

/**
 * يوزّع مبلغاً بالملّي على أوزان بأكبر الباقي بوحدة العملة (unit ملّي = ١٠^(٣−المنازل)) — Σ الحصص = المبلغ حرفياً.
 * أوزانٌ كلها صفر ⇒ بالتساوي. وكسرُ ما دون وحدة العملة (لا يقع: المبالغ مقرَّبة) يذهب لأثقل وزن.
 */
export function splitMilli(total: bigint, weights: readonly number[], unit: bigint): bigint[] {
  const n = weights.length;
  if (!n) return [];
  if (total === 0n) return weights.map(() => 0n);
  let safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  let sum = safe.reduce((s, w) => s + w, 0);
  if (sum <= 0) { safe = weights.map(() => 1); sum = n; }
  const neg = total < 0n;
  const abs = neg ? -total : total;
  const u = unit > 0n ? unit : 1n;
  const units = abs / u;
  const rest = abs % u;
  const raw = safe.map((w) => (w / sum) * Number(units));
  const out = raw.map((r) => BigInt(Math.floor(r)));
  let left = units - out.reduce((s, v) => s + v, 0n);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0n && n > 0; k = (k + 1) % n, left--) out[order[k].i] += 1n;
  const res = out.map((v) => v * u);
  if (rest > 0n) {
    let heavy = 0;
    for (let i = 1; i < n; i++) if (safe[i] > safe[heavy]) heavy = i;
    res[heavy] += rest;
  }
  return neg ? res.map((v) => -v) : res;
}

/** وحدة العملة بالملّي لمنازلها (٢ ⇒ ١٠) */
const unitMilliOf = (decimals: number): bigint => 10n ** BigInt(3 - Math.max(0, Math.min(3, decimals)));

/** قيمة الحركة: المحفوظة للمسعَّر، وإلا Σ |الكمية| × التكلفة مقرَّبة بلا ضريبة. priced = لها قيمة معروفة */
export function entryMoney(e: PurchaseEntryRow, decimals: number, taxHidden: boolean): { money: Money; priced: boolean } {
  let m: Money;
  let priced: boolean;
  if (e.totalMilli != null) {
    const tax = e.taxMilli ?? 0n;
    m = { net: e.netMilli ?? e.totalMilli - tax, tax, total: e.totalMilli };
    priced = true;
  } else {
    let sum = 0;
    priced = false;
    for (const i of e.items) {
      if (i.unitCost == null || !Number.isFinite(i.unitCost)) continue;
      const q = Math.abs(Number(i.qty));
      if (!Number.isFinite(q)) continue;
      sum += q * i.unitCost;
      priced = true;
    }
    const net = priced ? toMilliAmount(sum, Math.max(0, Math.min(3, decimals))) : 0n;
    m = { net, tax: 0n, total: net };
  }
  if (taxHidden) m = { net: m.total, tax: 0n, total: m.total };
  return { money: m, priced };
}

/** يوم الحركة المحلي: billDate (يومٌ مخزَّن) وإلا يوم الاستلام بتوقيت الشركة */
export function entryDay(e: Pick<PurchaseEntryRow, 'billDate' | 'createdAt'>, timeZone: string): LocalDate {
  return e.billDate ? fromDbDate(e.billDate) : localDate(e.createdAt, timeZone);
}

type Mode = 'CASH' | 'CREDIT' | null;
const modeOf = (m: string | null | undefined): Mode => (m === 'CASH' || m === 'CREDIT' ? m : null);

// ═══ الحساب (صرفٌ بلا قاعدة) ═══

interface Bucket {
  key: string;
  name: string | null;
  product?: PurchaseItemRow['product'];
  sortKey: string;
  rec: Money;
  ret: Money;
  cash: bigint;
  credit: bigint;
  unclassified: bigint;
  paid: bigint;
  remaining: bigint;
  bills: Set<string>;
  returns: Set<string>;
  receivedQty: number;
  returnedQty: number;
}

const newBucket = (key: string, name: string | null, sortKey: string): Bucket => ({
  key, name, sortKey, rec: { ...ZERO }, ret: { ...ZERO }, cash: 0n, credit: 0n, unclassified: 0n, paid: 0n, remaining: 0n,
  bills: new Set(), returns: new Set(), receivedQty: 0, returnedQty: 0,
});

function vendorKeyOf(e: PurchaseEntryRow): { key: string; name: string | null } {
  if (e.vendorId) return { key: `v:${e.vendorId}`, name: e.vendor?.name ?? e.supplier?.trim() ?? null };
  const s = e.supplier?.trim();
  if (s) return { key: `s:${s.toLowerCase()}`, name: s };
  return { key: 'none', name: null };
}

function moneyJson(rec: Money, ret: Money, b: { cash: bigint; credit: bigint; unclassified: bigint }, paid: bigint | null, remaining: bigint | null, taxHidden: boolean): PurchaseMoneyJson {
  const netPurchases = rec.net - ret.net;
  const netTax = rec.tax - ret.tax;
  const out: PurchaseMoneyJson = {
    net: milliToNumber(rec.net),
    total: milliToNumber(rec.total),
    returns: milliToNumber(ret.net),
    returnsTotal: milliToNumber(ret.total),
    netPurchases: milliToNumber(netPurchases),
    netTotal: milliToNumber(netPurchases + netTax),
    cash: milliToNumber(b.cash),
    credit: milliToNumber(b.credit),
    unclassified: milliToNumber(b.unclassified),
    paid: paid == null ? null : milliToNumber(paid),
    remaining: remaining == null ? null : milliToNumber(remaining),
  };
  if (!taxHidden) {
    out.tax = milliToNumber(rec.tax);
    out.returnsTax = milliToNumber(ret.tax);
    out.netTax = milliToNumber(netTax);
  }
  return out;
}

/**
 * يبني التقرير من حركاتٍ مقروءة (بعد الاستبعاد: افتتاحي/تسوية/تصفير — المستدعي يمرّر الوارد والمرتجع وحدهما).
 * الإجمالي من الحركات نفسها لا من الصفوف، وتوزيع الصنف بأكبر الباقي فيطابق مجموعُ صفوفه الإجماليَّ حرفاً.
 */
export function buildPurchasesReport(entries: readonly PurchaseEntryRow[], opts: BuildPurchasesOpts): PurchasesReportJson {
  const { groupBy, timeZone, decimals, taxHidden } = opts;
  const unit = unitMilliOf(decimals);
  const buckets = new Map<string, Bucket>();
  const total = newBucket('__all', null, '');
  const vendors = new Set<string>();
  const products = new Set<string>();
  let unpriced = 0;

  const bucketOf = (key: string, name: string | null, sortKey: string): Bucket => {
    let b = buckets.get(key);
    if (!b) { b = newBucket(key, name, sortKey); buckets.set(key, b); }
    return b;
  };

  const add = (b: Bucket, e: PurchaseEntryRow, m: Money, mode: Mode, qty: number, isReceive: boolean) => {
    const target = isReceive ? b.rec : b.ret;
    target.net += m.net; target.tax += m.tax; target.total += m.total;
    const signed = isReceive ? m.total : -m.total;
    if (mode === 'CASH') b.cash += signed; else if (mode === 'CREDIT') b.credit += signed; else b.unclassified += signed;
    if (isReceive) {
      if (e.status !== 'CANCELLED') b.bills.add(e.id);
      b.receivedQty += qty;
    } else {
      b.returns.add(e.id);
      b.returnedQty += qty;
    }
  };

  for (const e of entries) {
    const isReceive = e.type === 'RECEIVE';
    if (!isReceive && e.type !== 'RETURN') continue;
    const { money, priced } = entryMoney(e, decimals, taxHidden);
    if (isReceive && !priced) unpriced++;
    const mode: Mode = isReceive
      ? modeOf(e.paymentMode)
      : modeOf(e.returnOfEntryId && opts.originModes?.has(e.returnOfEntryId) ? opts.originModes.get(e.returnOfEntryId) : e.paymentMode);
    const settle = isReceive && mode === 'CREDIT' ? opts.settlements?.get(e.id) : undefined;
    const vk = vendorKeyOf(e);
    vendors.add(vk.key);
    const qtyAll = e.items.reduce((s, i) => s + Math.abs(baseQtyOf(i)), 0);
    for (const i of e.items) products.add(i.productId);

    add(total, e, money, mode, qtyAll, isReceive);
    if (settle) { total.paid += settle.paidMilli; total.remaining += settle.outstandingMilli; }

    if (groupBy === 'product') {
      if (!e.items.length) {
        const b = bucketOf('none', null, '');
        add(b, e, money, mode, 0, isReceive);
        continue;
      }
      const w = e.items.map((i) => (i.unitCost != null && Number.isFinite(i.unitCost) ? Math.abs(Number(i.qty)) * i.unitCost : 0));
      const tw = e.items.map((i, k) => w[k] * Math.max(0, Number(i.taxPct) || 0));
      const nets = splitMilli(money.net, w, unit);
      const taxes = splitMilli(money.tax, tw.some((x) => x > 0) ? tw : w, unit);
      e.items.forEach((i, k) => {
        const p = i.product;
        const b = bucketOf(`p:${i.productId}`, p?.name ?? null, p?.name ?? '');
        if (p && !b.product) b.product = p;
        add(b, e, { net: nets[k], tax: taxes[k], total: nets[k] + taxes[k] }, mode, Math.abs(baseQtyOf(i)), isReceive);
      });
      continue;
    }

    let b: Bucket;
    if (groupBy === 'vendor') b = bucketOf(vk.key, vk.name, vk.name ?? '');
    else {
      const day = entryDay(e, timeZone);
      const key = groupBy === 'month' ? day.slice(0, 7) : day;
      b = bucketOf(key, key, key);
    }
    add(b, e, money, mode, qtyAll, isReceive);
    if (settle) { b.paid += settle.paidMilli; b.remaining += settle.outstandingMilli; }
  }

  const isProduct = groupBy === 'product';
  const rows: PurchaseRowJson[] = [...buckets.values()].map((b) => {
    const money = moneyJson(b.rec, b.ret, b, isProduct ? null : b.paid, isProduct ? null : b.remaining, taxHidden);
    const row: PurchaseRowJson = {
      key: b.key,
      name: b.name,
      ...money,
      bills: b.bills.size,
      returnsCount: b.returns.size,
      qty: isProduct ? roundQty(b.receivedQty - b.returnedQty) || 0 : null,
      receivedQty: isProduct ? roundQty(b.receivedQty) : null,
      returnedQty: isProduct ? roundQty(b.returnedQty) : null,
    };
    if (isProduct) {
      const pid = b.product?.id ?? (b.key.startsWith('p:') ? b.key.slice(2) : null);
      row.code = b.product?.code ?? null;
      row.unit = b.product?.unit ?? null;
      row.units = (pid && opts.units?.get(pid)) || [];
      row.primaryUnitId = b.product?.primaryUnitId ?? null;
    }
    return row;
  });
  const chrono = groupBy === 'day' || groupBy === 'month';
  rows.sort((a, b) => chrono
    ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    : b.netTotal - a.netTotal || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ar') || (a.key < b.key ? -1 : 1));

  const summary: PurchaseSummaryJson = {
    ...moneyJson(total.rec, total.ret, total, total.paid, total.remaining, taxHidden),
    bills: total.bills.size,
    returnsCount: total.returns.size,
    vendors: vendors.size,
    products: products.size,
    unpricedEntries: unpriced,
  };
  return { groupBy, taxHidden, rows, summary };
}

// ═══ المدى ═══

export interface PurchasesRange {
  from: LocalDate | null;
  to: LocalDate | null;
  defaulted: boolean;
}

/** المدى من الاستعلام: يومان محليان اختياريان؛ بلا أيٍّ منهما آخر ٩٠ يوماً حتى اليوم. null = معاملٌ غير صالح */
export function purchasesRange(from: unknown, to: unknown, timeZone: string, now: Date = new Date()): PurchasesRange | null {
  const f = from === undefined || from === '' ? null : from;
  const t = to === undefined || to === '' ? null : to;
  if ((f != null && !isLocalDate(f)) || (t != null && !isLocalDate(t))) return null;
  if (f && t && f > t) return null;
  if (!f && !t) {
    const today = todayLocal(now, timeZone);
    return { from: addDays(today, -(PURCHASES_DEFAULT_DAYS - 1)), to: today, defaulted: true };
  }
  return { from: (f as LocalDate | null) ?? null, to: (t as LocalDate | null) ?? null, defaulted: false };
}

/** شرط المدى: billDate يومٌ محلي مخزَّن، وبلاه createdAt بحدود يوم الشركة */
export function purchasesDateWhere(range: PurchasesRange, timeZone: string): Prisma.WarehouseEntryWhereInput {
  const billDate: Prisma.DateTimeNullableFilter = {
    ...(range.from ? { gte: toDbDate(range.from) } : {}),
    ...(range.to ? { lte: toDbDate(range.to) } : {}),
  };
  const createdAt: Prisma.DateTimeFilter = {
    ...(range.from ? { gte: zonedStartOfDay(range.from, timeZone) } : {}),
    ...(range.to ? { lt: zonedStartOfDay(addDays(range.to, 1), timeZone) } : {}),
  };
  return { OR: [{ billDate }, { billDate: null, createdAt }] };
}

// ═══ القراءة من القاعدة ═══

/** ما يلزم التقرير من عميل Prisma (العميل العام أو مزيّف الاختبار) */
export type PurchasesDb = Pick<Prisma.TransactionClient, 'warehouseEntry' | 'productUnit' | 'importBatch'> & SupplierReadDb;

const ENTRY_SELECT = {
  id: true, type: true, status: true, source: true, note: true, vendorId: true, supplier: true, paymentMode: true,
  billDate: true, createdAt: true, netMilli: true, taxMilli: true, totalMilli: true, returnOfEntryId: true,
  vendor: { select: { name: true } },
  items: {
    select: {
      productId: true, qty: true, baseQty: true, unitFactor: true, unitName: true, unitCost: true, taxPct: true,
      product: { select: { id: true, name: true, code: true, unit: true, primaryUnitId: true } },
    },
  },
} as const;

function chunks<T>(arr: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
}

export interface LoadPurchasesOpts {
  groupBy: PurchaseGroupBy;
  range: PurchasesRange;
  timeZone: string;
  decimals: number;
  taxHidden: boolean;
  limit?: number;
}

/** يقرأ حركات المدى ويستبعد الافتتاحي ثم يجلب أنواع الأصول وتسويات الآجل ووحدات الأصناف — بعدد استعلامات ثابت */
export async function loadPurchasesReport(db: PurchasesDb, tid: string, opts: LoadPurchasesOpts): Promise<{ report: PurchasesReportJson; truncated: boolean }> {
  const limit = opts.limit ?? PURCHASES_ENTRY_LIMIT;
  const raw = (await db.warehouseEntry.findMany({
    where: {
      tenantId: tid,
      type: { in: ['RECEIVE', 'RETURN'] },
      source: { notIn: [...EXCLUDED_SOURCES] },
      AND: [purchasesDateWhere(opts.range, opts.timeZone)],
    },
    select: ENTRY_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })) as unknown as PurchaseEntryRow[];
  const truncated = raw.length > limit;
  const read = truncated ? raw.slice(0, limit) : raw;

  // أصول المرتجعات: نوع دفعها (المرتجع ينقص نوع وارده) ومصدرها (مرتجع واردٍ افتتاحي لا يُعدّ)
  const originIds = [...new Set(read.map((e) => (e.type === 'RETURN' ? e.returnOfEntryId : null)).filter((x): x is string => !!x))];
  const origins: { id: string; type: string; source: string | null; note: string | null; paymentMode: string | null }[] = [];
  for (const part of chunks(originIds)) {
    origins.push(...(await db.warehouseEntry.findMany({
      where: { tenantId: tid, id: { in: part } },
      select: { id: true, type: true, source: true, note: true, paymentMode: true },
    })));
  }
  const legacy = await legacyOpeningImportIds(db, tid, [
    ...read.map((e) => ({ id: e.id, type: e.type, source: e.source ?? null, note: e.note ?? null })),
    ...origins,
  ]);
  const openingOrigin = new Set(origins.filter((o) => o.source === 'OPENING_IMPORT' || legacy.has(o.id)).map((o) => o.id));
  const entries = read.filter((e) => !legacy.has(e.id) && !(e.returnOfEntryId && openingOrigin.has(e.returnOfEntryId)));
  const originModes = new Map(origins.map((o) => [o.id, o.paymentMode]));

  // فواتير الآجل في الفترة: المدفوع والمتبقّي بحالها اليوم (مصدر الفواتير المفتوحة نفسه)
  const creditIds = entries.filter((e) => e.type === 'RECEIVE' && e.paymentMode === 'CREDIT' && e.totalMilli != null).map((e) => e.id);
  const settlements = new Map<string, PurchaseSettlement>();
  if (creditIds.length) {
    for (const s of await loadBillSettlements(db, tid, { billIds: creditIds })) {
      settlements.set(s.bill.id, { paidMilli: s.paidMilli, outstandingMilli: s.outstandingMilli });
    }
  }

  const units = new Map<string, PurchaseUnit[]>();
  if (opts.groupBy === 'product') {
    const pids = [...new Set(entries.flatMap((e) => e.items.map((i) => i.productId)))];
    for (const part of chunks(pids)) {
      const rows = await db.productUnit.findMany({
        where: { tenantId: tid, productId: { in: part }, isActive: true },
        select: { id: true, productId: true, name: true, factor: true },
        orderBy: { factor: 'desc' },
      });
      for (const r of rows) {
        const list = units.get(r.productId) ?? [];
        list.push({ id: r.id, name: r.name, factor: Number(r.factor) });
        units.set(r.productId, list);
      }
    }
  }

  const report = buildPurchasesReport(entries, {
    groupBy: opts.groupBy, timeZone: opts.timeZone, decimals: opts.decimals, taxHidden: opts.taxHidden,
    originModes, settlements, units,
  });
  return { report, truncated };
}

// ═══ معالج Express ═══

const vanStockGuard = requireAdminPermission('canManageVanStock');

/** منازل عملة الشركة: إعدادات الدفاتر إن صلحت (٠–٣)، وإلا من عملة الشركة — كـtenantCurrencyDecimals */
function decimalsOf(gl: { currencyDecimals: number | null } | null, currency: string | null | undefined): number {
  const d = gl?.currencyDecimals;
  if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 3) return d;
  return Math.max(0, Math.min(3, currencyDecimalsOf(currency)));
}

/**
 * GET /api/reports/purchases?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=vendor|product|day|month
 * يُركَّب في routes/reports.ts: `router.get('/purchases', purchasesReportHandler)` (بعد حرّاس الموجّه).
 */
export async function purchasesReportHandler(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    // المندوب لا يرى تكلفة الشراء (requireAdminPermission يمرّره بلا فحص) — والموجّه يرفضه أصلاً بـrequireAdmin
    if (req.user?.role === 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
    // canManageVanStock بحارسه نفسه (جلسة المالك تمرّ، والمعطَّل يُرفض): ما لم يمرّ فقد أُرسل الرفض
    let passed = false;
    let failure: unknown = null;
    await vanStockGuard(req, res, (err?: unknown) => { if (err) failure = err; else passed = true; });
    if (failure) throw failure;
    if (!passed) return;

    const tid = tenantId(req);
    const q = req.query as Record<string, unknown>;
    const groupBy = (q.groupBy === undefined || q.groupBy === '' ? 'vendor' : q.groupBy) as PurchaseGroupBy;
    if (!PURCHASE_GROUP_BYS.includes(groupBy)) {
      res.status(400).json({ success: false, code: 'INVALID_GROUP_BY', message: 'معامل غير صالح' });
      return;
    }

    const [tenant, gl, company] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tid }, select: { warehouseEnabled: true, accountingEnabled: true } }),
      prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { timezone: true, currencyDecimals: true } }),
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { countryCode: true, currency: true, taxDisabled: true } }),
    ]);
    if (tenant?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    if (!tenant?.warehouseEnabled) {
      res.status(403).json({ success: false, code: 'WAREHOUSE_NOT_ENABLED', message: 'ميزة مخزون الشركة غير مفعلة لهذه الشركة' });
      return;
    }

    const timeZone = companyTimeZone(gl?.timezone, company?.countryCode);
    const range = purchasesRange(q.from, q.to, timeZone);
    if (!range) { res.status(400).json({ success: false, code: 'INVALID_RANGE', message: 'معامل غير صالح' }); return; }

    const { report, truncated } = await loadPurchasesReport(prisma, tid, {
      groupBy, range, timeZone, decimals: decimalsOf(gl, company?.currency), taxHidden: isTaxOff(company),
    });
    res.json({
      success: true,
      data: report,
      meta: {
        appliedRange: { from: range.from, to: range.to, defaulted: range.defaulted },
        timezone: timeZone,
        truncated,
        limit: PURCHASES_ENTRY_LIMIT,
        paymentsAsOf: todayLocal(new Date(), timeZone),
      },
    });
  } catch (err) { next(err); }
}
