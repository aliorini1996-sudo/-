/**
 * «تقرير الضرائب» (طلب المالك ١٨ نوفمبر ٢٠٢٦) — ضريبة المخرجات وضريبة المدخلات وصافي المستحق، مجمّعةً بالشهر أو بالربع (فترة الإقرار)
 * أو بنسبة الضريبة. قراءةٌ خالصة: لا كتابة ولا قفل.
 *
 * ═══ المصادر ═══
 * - **المخرجات:** فواتير البيع المؤكَّدة (CONFIRMED) والإشعار المدين (type CREDIT + documentKind DEBIT_NOTE) تُضاف، والمرتجع والإشعار
 *   الدائن (type RETURN — services/netSales.ts) يُطرحان. الملغاة والمسودة خارجة بالحالة.
 *   الوعاء والضريبة من **رأس المستند** (total − taxAmt، وtaxAmt) كما يقرؤهما تقرير المبيعات وكشف الحساب، وتوزيعهما على نسب الضريبة
 *   بأوزان البنود (lineTotal − taxAmt للبند، وضريبة البند) — فمجموع التقرير يطابق رؤوس الفواتير بالهللة حتى لفاتورةٍ قديمة كان خصمها
 *   الكلّي يُطرح بعد الضريبة (lib/invoiceCalc.ts «ما كان قبل التصحيح»).
 * - **المدخلات:** فواتير الموردين **المصنَّفة** وحدها (warehouse_entries.paymentMode غير فارغ، مسعَّرة) من وارد RECEIVE ومرتجع RETURN
 *   (يُطرح). الصافي والضريبة من لقطتَي الحركة (netMilli/taxMilli — مصدر كشف المورّد والقيود) وتوزيعهما على النسب بأسطرها.
 *   - vatTreatment RECOVERABLE (والفارغ = RECOVERABLE كـentryBillTotals) ⇒ ضريبة مدخلات تُطرح من المستحق.
 *   - NON_RECOVERABLE ⇒ تُعرض منفصلةً ولا تُطرح (مرسمَلة في تكلفة البضاعة — services/suppliers/warehouseBills.ts).
 *   - NONE ⇒ وعاءٌ بلا ضريبة في سلّة «٠٪».
 *   - **الإلغاء مرتجعٌ لا حذف:** الوارد الملغى (status CANCELLED) يُلغى بحركة RETURN كاملة للمتبقّي بتاريخ الإلغاء (reverseEntryTx) —
 *     فيدخل الوارد بأي حالة ومعه مرتجعاته كلها، كلٌّ بتاريخه (billDate): مدىً يشملهما يصفو صفراً، ومدىً يفصل بينهما يُبقي ضريبة الفترة
 *     الأصلية كما قُدِّم إقرارها ويُظهر العكس في فترة الإلغاء — ككشف المورّد والدفاتر (gl/builders/purchase) وتقرير المشتريات. والمرتجع
 *     الملغى نفسه (إن وُجد) خارج بالحالة.
 * - **الصفرية والمعفاة:** وعاءٌ بلا ضريبة في سلّتها: Z صفرية، E معفاة، O خارج النطاق (ومنها مستندٌ مختوم «بلا ضريبة» taxFree صدر
 *   والشركة غير مسجّلة)، و«0» نسبةٌ صفرية بلا فئة.
 *
 * ═══ الحساب ═══ بوحدات العملة الصغرى (عدد صحيح: الهللة/الفلس) بعد تقريبٍ نصف-لأعلى بمنازل عملة الشركة (lib/money roundHalfUp)، والتوزيع
 * بأكبر الباقي — فمجموع الصفوف يساوي الإجمالي حرفاً، وصافي المستحق = ضريبة المخرجات − ضريبة المدخلات القابلة للاسترداد (سالبٌ = رصيدٌ مسترد).
 *
 * ═══ المدى ═══ بأيام الشركة (tenantTz) على تاريخ الفاتورة، وعلى تاريخ فاتورة المورّد (billDate، @db.Date يوماً تقويمياً) للمشتريات.
 * الطرف الغائب بلا حدّ، وغيابهما معاً ⇒ من أول الربع السابق حتى اليوم (الإقرار القادم والربع الجاري) مُعلَناً في meta.appliedRange.
 *
 * ═══ النطاق والصلاحيات ═══ حرّاس موجّه التقارير قبله (authenticate + requireAdmin + canViewReports)، والمحاسبة المطفأة صراحةً
 * (Tenant.accountingEnabled === false) ⇒ ٤٠٣ ACCOUNTING_NOT_ALLOWED من المعالج نفسه كتقرير الربح. المستخدم المقيَّد (scopedRecordWhere —
 * قوائم أو فرق) يرى مخرجات فواتير نطاقه وحدها، ولا تُقرأ المشتريات له أصلاً (مستوى الشركة لا عميل لها ولا مندوب). ومن مُنع صفحات
 * المستودع والمشتريات (canManageVanStock === false) لا تُقرأ له المشتريات كذلك — وعاء المدخلات تكلفة شراء. كلاهما: input/nonRecoverable/net
 * = null، و`inputHidden` يقول لماذا ('SCOPE' | 'PERMISSION').
 *
 * ═══ «إزالة الضريبة» ═══ الشركة «بلا ضريبة» (CompanySettings.taxDisabled) ⇒ لا تقرير: بيانٌ فارغ صريح `taxDisabled: true` بلا أي رقم.
 */
import type { Response, NextFunction } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { isOwnerSession, tenantId } from '../../middleware/auth';
import { scopedRecordWhere, SHAPE_INVOICE_RECEIPT } from '../adminScope';
import type { AuthRequest } from '../../types';
import { tenantTz } from '../invoiceExpiry';
import { tenantCurrencyDecimals } from '../warehouseStock';
import { isTaxOff } from '../taxMode';
import { isReturnInvoice } from '../netSales';
import { roundHalfUp } from '../../lib/money';
import {
  addDays, daysInMonth, formatLocalDate, fromDbDate, isLocalDate, localDate, parseLocalDate, todayLocal, toDbDate, zonedStartOfDay,
} from '../gl/dates';

// ═══ الأنواع ═══

export const TAX_GROUP_BYS = ['month', 'quarter', 'rate'] as const;
export type TaxGroupBy = (typeof TAX_GROUP_BYS)[number];

/** التجميع من الاستعلام: month | quarter | rate، وغيره (غائب أو مجهول) ⇒ month */
export function taxGroupByOf(v: unknown): TaxGroupBy {
  return typeof v === 'string' && (TAX_GROUP_BYS as readonly string[]).includes(v) ? (v as TaxGroupBy) : 'month';
}

/** فئة سلّة النسبة: S نسبةٌ موجبة، Z صفرية، E معفاة، O خارج النطاق، '0' نسبةٌ صفرية بلا فئة */
export type TaxCategory = 'S' | 'Z' | 'E' | 'O' | '0';

/** مستند بيعٍ كما يقرؤه البناء الصرف — المبالغ موجبة كما تُخزَّن (المرتجع موجب ويُطرح بنوعه) */
export interface TaxSaleDoc {
  id: string;
  type: string;
  documentKind?: string | null;
  /** يوم المستند بتوقيت الشركة YYYY-MM-DD */
  date: string;
  taxFree?: boolean | null;
  total: number;
  taxAmt: number;
  /** بنود المستند مجمَّعةً (أو مفردة) بنسبتها وفئتها: lineTotal شاملٌ الضريبة دائماً (lib/invoiceCalc.ts) */
  lines: ReadonlyArray<{ taxPct: number | null; vatCategory?: string | null; lineTotal: number; taxAmt: number }>;
}

/** حركة مستودعٍ مصنَّفة (فاتورة مورّد أو مرتجعها) كما يقرؤها البناء الصرف */
export interface TaxPurchaseDoc {
  id: string;
  type: 'RECEIVE' | 'RETURN' | string;
  date: string;
  vatTreatment?: string | null;
  costsIncludeTax?: boolean | null;
  /** الصافي والضريبة بالملّي (لقطة الحركة) — موجبان للوارد والمرتجع معاً */
  netMilli: bigint | number;
  taxMilli: bigint | number | null;
  lines: ReadonlyArray<{ taxPct: number | null; qty: number; unitCost: number | null; enteredUnitCost: number | null }>;
}

export interface TaxAmounts { base: number; tax: number }
export interface TaxCounted extends TaxAmounts { count: number }

export interface TaxRowOutput { salesBase: number; salesTax: number; returnsBase: number; returnsTax: number; base: number; tax: number }
export interface TaxRowInput { purchasesBase: number; purchasesTax: number; returnsBase: number; returnsTax: number; base: number; tax: number }

/** صفّ التقرير: فترةٌ (شهر/ربع) أو سلّة نسبة */
export interface TaxRow {
  /** '2026-10' | '2026-Q4' | '15' | 'Z' | 'E' | 'O' | '0' */
  key: string;
  kind: TaxGroupBy;
  /** حدّا الفترة (أول يومها وآخره) — null لصفّ النسبة */
  start: string | null;
  end: string | null;
  /** النسبة ٪ لصفّ النسبة (صفرٌ للسلال الصفرية) — null لصفّ الفترة */
  rate: number | null;
  category: TaxCategory | null;
  /** المخرجات: المبيعات والإشعار المدين، والمرتجع والإشعار الدائن (موجبَين، يُطرحان)، والصافي */
  output: TaxRowOutput;
  /** المدخلات القابلة للاسترداد (وNONE بوعائها) — null للمستخدم المقيَّد */
  input: TaxRowInput | null;
  /** غير القابلة للاسترداد صافيةً من مرتجعاتها — تُعرض ولا تُطرح؛ null للمستخدم المقيَّد */
  nonRecoverable: TaxAmounts | null;
  /** ضريبة المخرجات − ضريبة المدخلات؛ null للمستخدم المقيَّد */
  net: number | null;
}

export interface TaxSummary {
  output: { sales: TaxCounted; debitNotes: TaxCounted; returns: TaxCounted; base: number; tax: number; zeroBase: number };
  input: { purchases: TaxCounted; returns: TaxCounted; base: number; tax: number } | null;
  nonRecoverable: TaxCounted | null;
  net: number | null;
  /** PAYABLE مستحقٌ للسداد، REFUNDABLE رصيدٌ مسترد، NIL صفر — null للمستخدم المقيَّد */
  position: 'PAYABLE' | 'REFUNDABLE' | 'NIL' | null;
}

/** لماذا غابت المدخلات والصافي: SCOPE مستخدمٌ مقيَّد النطاق، PERMISSION ممنوعٌ من المشتريات (canManageVanStock) */
export type TaxInputHidden = 'SCOPE' | 'PERMISSION';

export interface TaxReportData {
  taxDisabled: boolean;
  groupBy: TaxGroupBy;
  decimals: number;
  /** المستخدم مقيَّد النطاق: المخرجات لفواتير نطاقه وحدها */
  scoped: boolean;
  /** null ⇒ المدخلات والصافي حاضرة؛ وإلا سبب غيابها */
  inputHidden: TaxInputHidden | null;
  rows: TaxRow[];
  summary: TaxSummary | null;
}

// ═══ المدى بأيام الشركة ═══

export type TaxRangeResult =
  | { ok: true; from: string | null; to: string | null; defaulted: boolean }
  | { ok: false; message: string };

/** يومٌ صالح بسنة 1900–2099 (كـisReportDay في routes/reports.ts) */
const isReportDay = (v: unknown): v is string => typeof v === 'string' && /^(19|20)\d\d-/.test(v) && isLocalDate(v);

/** أول يوم في الربع التقويمي لليوم */
export function quarterStart(day: string): string {
  const { y, m } = parseLocalDate(day);
  return formatLocalDate(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
}

/**
 * مدى التقرير: الطرف الغائب بلا حدّ، وغيابهما ⇒ من أول الربع السابق حتى اليوم (defaulted). تاريخٌ بغير YYYY-MM-DD أو خارج
 * 1900–2099 أو قيمةٌ غير نصّية (مصفوفة/كائن qs) ⇒ رفضٌ صريح لا إسقاطٌ صامت للفلتر، و«من» بعد «إلى» كذلك.
 */
export function taxReportRange(rawFrom: unknown, rawTo: unknown, tz: string, now: Date = new Date()): TaxRangeResult {
  const given = (v: unknown) => v !== undefined && v !== '';
  if ((given(rawFrom) && !isReportDay(rawFrom)) || (given(rawTo) && !isReportDay(rawTo))) return { ok: false, message: 'تاريخ غير صالح' };
  const from = given(rawFrom) ? (rawFrom as string) : null;
  const to = given(rawTo) ? (rawTo as string) : null;
  if (from && to && from > to) return { ok: false, message: 'تاريخ البداية بعد تاريخ النهاية' };
  if (from || to) return { ok: true, from, to, defaulted: false };
  const today = todayLocal(now, tz);
  const prevQuarter = quarterStart(addDays(quarterStart(today), -1));
  return { ok: true, from: prevQuarter, to: today, defaulted: true };
}

// ═══ الحساب الصرف ═══

const ZERO_KEYS = new Set(['0', 'Z', 'E', 'O']);

/** سلّة بند البيع: نسبةٌ موجبة ⇒ نسبتها نصّاً ('15')؛ وصفرٌ في مستندٍ «بلا ضريبة» ⇒ O؛ وإلا فئته Z/E/O، وبلا فئة '0' */
export function saleBucketKey(taxPct: number | null | undefined, vatCategory: string | null | undefined, docTaxFree: boolean): string {
  const pct = Number(taxPct);
  if (Number.isFinite(pct) && pct > 0) return String(roundHalfUp(pct, 2));
  if (docTaxFree) return 'O';
  const c = typeof vatCategory === 'string' ? vatCategory.trim().toUpperCase() : '';
  return c === 'Z' || c === 'E' || c === 'O' ? c : '0';
}

/** فئة السلّة ونسبتها للعرض */
export function bucketMeta(key: string): { rate: number; category: TaxCategory } {
  if (ZERO_KEYS.has(key)) return { rate: 0, category: key as TaxCategory };
  const r = Number(key);
  return { rate: Number.isFinite(r) ? r : 0, category: 'S' };
}

/**
 * توزيع مبلغٍ صحيح (وحدات صغرى) على أوزان بأكبر الباقي — المجموع يساوي المبلغ حرفاً. الأوزان غير الموجبة صفر، وأوزانٌ كلها صفر ⇒
 * المبلغ كله على `fallback`. ويحفظ إشارة المبلغ.
 */
export function splitMinor(total: number, weights: readonly number[], fallback = 0): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const out = new Array<number>(n).fill(0);
  if (total === 0) return out;
  if (n === 1) { out[0] = total; return out; }
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sw = w.reduce((s, x) => s + x, 0);
  if (sw <= 0) { out[Math.min(Math.max(0, fallback), n - 1)] = total; return out; }
  const raw = w.map((x) => (x / sw) * abs);
  const floors = raw.map((r) => Math.floor(r));
  let rem = abs - floors.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && rem > 0; k++, rem--) floors[order[k].i] += 1;
  return floors.map((x) => sign * x);
}

/** مفتاح فترة اليوم: الشهر 'YYYY-MM' أو الربع 'YYYY-Qn' */
export function periodKeyOf(day: string, kind: 'month' | 'quarter'): string {
  const { y, m } = parseLocalDate(day);
  return kind === 'month' ? `${y}-${String(m).padStart(2, '0')}` : `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** حدّا الفترة من مفتاحها */
export function periodBounds(key: string): { start: string; end: string } {
  const q = /^(\d{4})-Q([1-4])$/.exec(key);
  if (q) {
    const y = +q[1];
    const m1 = (+q[2] - 1) * 3 + 1;
    return { start: formatLocalDate(y, m1, 1), end: formatLocalDate(y, m1 + 2, daysInMonth(y, m1 + 2)) };
  }
  const y = +key.slice(0, 4);
  const m = +key.slice(5, 7);
  return { start: formatLocalDate(y, m, 1), end: formatLocalDate(y, m, daysInMonth(y, m)) };
}

/** فترات المدى المحدود من أوله إلى آخره (لتظهر الفترة الخالية صفراً) — سقف ٢٤٠ فترة، وما فوقه بلا ملء */
export function periodKeysBetween(from: string, to: string, kind: 'month' | 'quarter'): string[] {
  const out: string[] = [];
  let { y, m } = parseLocalDate(from);
  const end = periodKeyOf(to, kind);
  if (kind === 'quarter') m = Math.floor((m - 1) / 3) * 3 + 1;
  for (let i = 0; i < 240; i++) {
    const key = periodKeyOf(formatLocalDate(y, m, 1), kind);
    out.push(key);
    if (key === end) return out;
    m += kind === 'month' ? 1 : 3;
    if (m > 12) { m -= 12; y += 1; }
  }
  return [];
}

interface Acc {
  salesBase: number; salesTax: number; retBase: number; retTax: number;
  inBase: number; inTax: number; inRetBase: number; inRetTax: number;
  nrBase: number; nrTax: number; nrRetBase: number; nrRetTax: number;
}
const freshAcc = (): Acc => ({
  salesBase: 0, salesTax: 0, retBase: 0, retTax: 0, inBase: 0, inTax: 0, inRetBase: 0, inRetTax: 0, nrBase: 0, nrTax: 0, nrRetBase: 0, nrRetTax: 0,
});

/** سلّةٌ واحدة من مستند: وعاؤها وضريبتها بالوحدات الصغرى */
interface Piece { key: string; base: number; tax: number }

/**
 * يبني التقرير من المستندات — صرفٌ ليُختبر وحده. `purchases` null ⇒ لا مدخلات ولا صافٍ (`inputHidden`: SCOPE للمقيَّد — الافتراضي
 * حين لا يُمرَّر `scoped` — وPERMISSION لغير المقيَّد). `range` لملء الفترات الخالية حين يكون المدى محدوداً من الطرفين.
 */
export function buildTaxReport(input: {
  sales: readonly TaxSaleDoc[];
  purchases: readonly TaxPurchaseDoc[] | null;
  groupBy: TaxGroupBy;
  decimals: number;
  range?: { from: string | null; to: string | null };
  /** المستخدم مقيَّد النطاق — غيابه ⇒ purchases === null */
  scoped?: boolean;
}): TaxReportData {
  const dec = Number.isInteger(input.decimals) && input.decimals >= 0 && input.decimals <= 3 ? input.decimals : 2;
  const unit = Math.pow(10, dec);
  const toMinor = (x: unknown): number => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.round(roundHalfUp(n, dec) * unit) : 0;
  };
  const fromMinor = (m: number): number => roundHalfUp(m / unit, dec) || 0;
  const milli = (m: bigint | number | null | undefined): number => toMinor(Number(m ?? 0) / 1000);
  const hidden = input.purchases === null;
  const scoped = input.scoped ?? hidden;
  const { groupBy } = input;

  const rows = new Map<string, Acc>();
  const accOf = (key: string): Acc => {
    let a = rows.get(key);
    if (!a) rows.set(key, (a = freshAcc()));
    return a;
  };
  const rowKeyOf = (date: string, bucket: string): string => (groupBy === 'rate' ? bucket : periodKeyOf(date, groupBy));

  const sum = {
    sales: { count: 0, base: 0, tax: 0 }, debit: { count: 0, base: 0, tax: 0 }, ret: { count: 0, base: 0, tax: 0 },
    purch: { count: 0, base: 0, tax: 0 }, purchRet: { count: 0, base: 0, tax: 0 },
    nr: { count: 0, base: 0, tax: 0 }, zeroBase: 0,
  };

  // ── المخرجات ──
  for (const d of input.sales) {
    const free = d.taxFree === true;
    const headTax = toMinor(d.taxAmt);
    const headBase = toMinor(d.total) - headTax;
    // سلال البنود (مجمّعةً بالمفتاح) وأوزانها
    const byKey = new Map<string, { base: number; tax: number }>();
    for (const l of d.lines) {
      const k = saleBucketKey(l.taxPct, l.vatCategory, free);
      const b = byKey.get(k) ?? { base: 0, tax: 0 };
      const lt = Number(l.taxAmt) || 0;
      b.base += (Number(l.lineTotal) || 0) - lt;
      b.tax += lt;
      byKey.set(k, b);
    }
    if (byKey.size === 0) {
      // مستندٌ بلا بنود: نسبته الضمنية من رأسه
      const k = headTax !== 0 && headBase !== 0 ? String(roundHalfUp((headTax / headBase) * 100, 2)) : free ? 'O' : '0';
      byKey.set(k, { base: headBase, tax: headTax });
    }
    const keys = [...byKey.keys()];
    const baseW = keys.map((k) => byKey.get(k)!.base);
    // ضريبةٌ في الرأس وبنودها بلا ضريبة (بيانات شاذّة): على أكبر سلّةٍ موجبة النسبة، وإلا أكبر سلّة
    let taxFallback = 0;
    let best = -Infinity;
    keys.forEach((k, i) => {
      const score = (ZERO_KEYS.has(k) ? 0 : 1e15) + baseW[i];
      if (score > best) { best = score; taxFallback = i; }
    });
    const bases = splitMinor(headBase, baseW, taxFallback);
    const taxes = splitMinor(headTax, keys.map((k) => byKey.get(k)!.tax), taxFallback);
    const pieces: Piece[] = keys.map((key, i) => ({ key, base: bases[i], tax: taxes[i] }));

    const isRet = isReturnInvoice(d);
    const isDebit = !isRet && d.documentKind === 'DEBIT_NOTE';
    const bucket = isRet ? sum.ret : isDebit ? sum.debit : sum.sales;
    bucket.count++;
    for (const p of pieces) {
      const a = accOf(rowKeyOf(d.date, p.key));
      if (isRet) { a.retBase += p.base; a.retTax += p.tax; } else { a.salesBase += p.base; a.salesTax += p.tax; }
      bucket.base += p.base;
      bucket.tax += p.tax;
      if (ZERO_KEYS.has(p.key)) sum.zeroBase += isRet ? -p.base : p.base;
    }
  }

  // ── المدخلات ──
  for (const e of input.purchases ?? []) {
    const vt = (e.vatTreatment ?? 'RECOVERABLE').toUpperCase();
    const none = vt === 'NONE';
    const nonRec = vt === 'NON_RECOVERABLE';
    const net = milli(e.netMilli);
    const tax = none ? 0 : milli(e.taxMilli);
    const byKey = new Map<string, { base: number; taxW: number }>();
    for (const l of e.lines) {
      const pct = none ? 0 : Math.max(0, Number.isFinite(Number(l.taxPct)) ? Number(l.taxPct) : 0);
      const qty = Math.abs(Number(l.qty) || 0);
      const entered = l.enteredUnitCost;
      // صافي السطر قبل الضريبة: المُدخل (يُردّ إلى صافيه إن كان شاملاً)، وإلا التكلفة المخزَّنة (مرسمَلةٌ بالضريبة في غير المستردة)
      const unitNet = entered != null && Number.isFinite(Number(entered))
        ? (e.costsIncludeTax ? Number(entered) / (1 + pct / 100) : Number(entered))
        : nonRec ? (Number(l.unitCost) || 0) / (1 + pct / 100) : Number(l.unitCost) || 0;
      const k = pct > 0 ? String(roundHalfUp(pct, 2)) : '0';
      const b = byKey.get(k) ?? { base: 0, taxW: 0 };
      b.base += qty * unitNet;
      b.taxW += qty * unitNet * pct;
      byKey.set(k, b);
    }
    if (byKey.size === 0) {
      const k = tax !== 0 && net !== 0 ? String(roundHalfUp((tax / net) * 100, 2)) : '0';
      byKey.set(k, { base: net, taxW: tax });
    }
    const keys = [...byKey.keys()];
    const baseW = keys.map((k) => byKey.get(k)!.base);
    let fb = 0;
    let best = -Infinity;
    keys.forEach((k, i) => {
      const score = (k === '0' ? 0 : 1e15) + baseW[i];
      if (score > best) { best = score; fb = i; }
    });
    const bases = splitMinor(net, baseW, fb);
    const taxes = splitMinor(tax, keys.map((k) => byKey.get(k)!.taxW), fb);
    const isRet = e.type === 'RETURN';
    if (nonRec) { if (!isRet) sum.nr.count++; } else if (isRet) sum.purchRet.count++; else sum.purch.count++;
    keys.forEach((key, i) => {
      const a = accOf(rowKeyOf(e.date, key));
      const b = bases[i];
      const t = taxes[i];
      if (nonRec) {
        if (isRet) { a.nrRetBase += b; a.nrRetTax += t; sum.nr.base -= b; sum.nr.tax -= t; } else { a.nrBase += b; a.nrTax += t; sum.nr.base += b; sum.nr.tax += t; }
      } else if (isRet) {
        a.inRetBase += b; a.inRetTax += t; sum.purchRet.base += b; sum.purchRet.tax += t;
      } else {
        a.inBase += b; a.inTax += t; sum.purch.base += b; sum.purch.tax += t;
      }
    });
  }

  // ── الفترات الخالية في مدىً محدود (الشهر/الربع) ──
  if (groupBy !== 'rate' && input.range?.from && input.range?.to) {
    for (const k of periodKeysBetween(input.range.from, input.range.to, groupBy)) accOf(k);
  }

  // ── الصفوف ──
  const rateOrder = (k: string): number => (ZERO_KEYS.has(k) ? -1 - ['0', 'Z', 'E', 'O'].indexOf(k) : Number(k));
  const keys = [...rows.keys()].sort((x, y) => (groupBy === 'rate' ? rateOrder(y) - rateOrder(x) : x.localeCompare(y)));
  const outRows: TaxRow[] = keys.map((key) => {
    const a = rows.get(key)!;
    const outBase = a.salesBase - a.retBase;
    const outTax = a.salesTax - a.retTax;
    const inBase = a.inBase - a.inRetBase;
    const inTax = a.inTax - a.inRetTax;
    const meta = groupBy === 'rate' ? bucketMeta(key) : null;
    const bounds = groupBy === 'rate' ? null : periodBounds(key);
    return {
      key,
      kind: groupBy,
      start: bounds?.start ?? null,
      end: bounds?.end ?? null,
      rate: meta?.rate ?? null,
      category: meta?.category ?? null,
      output: {
        salesBase: fromMinor(a.salesBase), salesTax: fromMinor(a.salesTax),
        returnsBase: fromMinor(a.retBase), returnsTax: fromMinor(a.retTax),
        base: fromMinor(outBase), tax: fromMinor(outTax),
      },
      input: hidden ? null : {
        purchasesBase: fromMinor(a.inBase), purchasesTax: fromMinor(a.inTax),
        returnsBase: fromMinor(a.inRetBase), returnsTax: fromMinor(a.inRetTax),
        base: fromMinor(inBase), tax: fromMinor(inTax),
      },
      nonRecoverable: hidden ? null : { base: fromMinor(a.nrBase - a.nrRetBase), tax: fromMinor(a.nrTax - a.nrRetTax) },
      net: hidden ? null : fromMinor(outTax - inTax),
    };
  });

  // ── الملخّص ──
  const counted = (c: { count: number; base: number; tax: number }): TaxCounted => ({ count: c.count, base: fromMinor(c.base), tax: fromMinor(c.tax) });
  const outBase = sum.sales.base + sum.debit.base - sum.ret.base;
  const outTax = sum.sales.tax + sum.debit.tax - sum.ret.tax;
  const inBase = sum.purch.base - sum.purchRet.base;
  const inTax = sum.purch.tax - sum.purchRet.tax;
  const netMinor = outTax - inTax;
  const summary: TaxSummary = {
    output: {
      sales: counted(sum.sales), debitNotes: counted(sum.debit), returns: counted(sum.ret),
      base: fromMinor(outBase), tax: fromMinor(outTax), zeroBase: fromMinor(sum.zeroBase),
    },
    input: hidden ? null : { purchases: counted(sum.purch), returns: counted(sum.purchRet), base: fromMinor(inBase), tax: fromMinor(inTax) },
    nonRecoverable: hidden ? null : counted(sum.nr),
    net: hidden ? null : fromMinor(netMinor),
    position: hidden ? null : netMinor > 0 ? 'PAYABLE' : netMinor < 0 ? 'REFUNDABLE' : 'NIL',
  };
  return { taxDisabled: false, groupBy, decimals: dec, scoped, inputHidden: hidden ? (scoped ? 'SCOPE' : 'PERMISSION') : null, rows: outRows, summary };
}

/** البيان الفارغ الصريح لشركة «إزالة الضريبة» — لا رقم ولا صفّ */
export const taxDisabledReport = (groupBy: TaxGroupBy, decimals: number): TaxReportData =>
  ({ taxDisabled: true, groupBy, decimals, scoped: false, inputHidden: null, rows: [], summary: null });

// ═══ القراءة من القاعدة (تجميعات بلا N+1) ═══

/** ما يلزم القراءة من Prisma — ليُمرَّر مزيّفاً في الاختبار */
export type TaxReportDb = Pick<typeof prisma, 'invoice' | 'invoiceItem' | 'warehouseEntry'>;

export interface TaxLoadParams {
  tenantId: string;
  tz: string;
  from: string | null;
  to: string | null;
  /** قيد نطاق المستخدم على الفاتورة (scopedRecordWhere) — {} لغير المقيَّد */
  scope: Record<string, unknown>;
  /** false ⇒ لا تُقرأ المشتريات (مقيَّد النطاق أو ممنوعٌ منها) ويعود purchases: null */
  withPurchases: boolean;
}

/**
 * يقرأ المستندات بثلاثة استعلامات ثابتة العدد مهما طال المدى: رؤوس الفواتير، وتجميع بنودها بالقاعدة (فاتورة × نسبة × فئة)، وحركات
 * المستودع المصنَّفة بأسطرها (الوارد بأي حالة، والمرتجع غير الملغى). كلٌّ مقيَّدٌ بالشركة.
 */
export async function loadTaxDocs(db: TaxReportDb, p: TaxLoadParams): Promise<{ sales: TaxSaleDoc[]; purchases: TaxPurchaseDoc[] | null }> {
  const instant: { gte?: Date; lt?: Date } = {
    ...(p.from ? { gte: zonedStartOfDay(p.from, p.tz) } : {}),
    ...(p.to ? { lt: zonedStartOfDay(addDays(p.to, 1), p.tz) } : {}),
  };
  const billDay: { gte?: Date; lte?: Date } = {
    ...(p.from ? { gte: toDbDate(p.from) } : {}),
    ...(p.to ? { lte: toDbDate(p.to) } : {}),
  };
  // مفاتيح النطاق (AND) تُنثر أولاً ثم شروط التقرير — فلا يمحو مفتاحٌ مثيله
  const invoiceWhere: Prisma.InvoiceWhereInput = {
    ...(p.scope as Prisma.InvoiceWhereInput),
    tenantId: p.tenantId,
    status: 'CONFIRMED',
    invoiceDate: instant,
  };
  const [docs, lineGroups, entries] = await Promise.all([
    db.invoice.findMany({
      where: invoiceWhere,
      select: { id: true, type: true, documentKind: true, invoiceDate: true, taxFree: true, total: true, taxAmt: true },
    }),
    db.invoiceItem.groupBy({
      by: ['invoiceId', 'taxPct', 'vatCategory'],
      where: { invoice: invoiceWhere },
      _sum: { lineTotal: true, taxAmt: true },
    }),
    !p.withPurchases
      ? Promise.resolve(null)
      : db.warehouseEntry.findMany({
        where: {
          tenantId: p.tenantId,
          paymentMode: { not: null },
          netMilli: { not: null },
          AND: [
            // الوارد بأي حالة (الملغى يعكسه مرتجع إلغائه بتاريخه)، والمرتجع الملغى نفسه خارج
            { OR: [{ type: 'RECEIVE' }, { type: 'RETURN', status: { not: 'CANCELLED' } }] },
            { OR: [{ billDate: billDay }, { billDate: null, createdAt: instant }] },
          ],
        },
        select: {
          id: true, type: true, billDate: true, createdAt: true, vatTreatment: true, costsIncludeTax: true,
          netMilli: true, taxMilli: true,
          items: { select: { taxPct: true, qty: true, unitCost: true, enteredUnitCost: true } },
        },
      }),
  ]);

  const linesOf = new Map<string, TaxSaleDoc['lines'][number][]>();
  for (const g of lineGroups) {
    const arr = linesOf.get(g.invoiceId) ?? [];
    arr.push({ taxPct: g.taxPct, vatCategory: g.vatCategory, lineTotal: Number(g._sum.lineTotal ?? 0), taxAmt: Number(g._sum.taxAmt ?? 0) });
    linesOf.set(g.invoiceId, arr);
  }
  const sales: TaxSaleDoc[] = docs.map((d) => ({
    id: d.id, type: d.type, documentKind: d.documentKind, date: localDate(d.invoiceDate, p.tz), taxFree: d.taxFree,
    total: Number(d.total), taxAmt: Number(d.taxAmt), lines: linesOf.get(d.id) ?? [],
  }));
  if (!entries) return { sales, purchases: null };

  const purchases: TaxPurchaseDoc[] = entries
    .map((e) => ({
      id: e.id, type: e.type,
      date: e.billDate ? fromDbDate(e.billDate) : localDate(e.createdAt, p.tz),
      vatTreatment: e.vatTreatment, costsIncludeTax: e.costsIncludeTax,
      netMilli: e.netMilli ?? 0n, taxMilli: e.taxMilli,
      lines: e.items.map((i) => ({ taxPct: i.taxPct, qty: i.qty, unitCost: i.unitCost, enteredUnitCost: i.enteredUnitCost })),
    }));
  return { sales, purchases };
}

// ═══ معالج Express — GET /api/reports/tax ═══

/**
 * يرى المستخدم تكلفة الشراء؟ ضريبة المدخلات مجاميع فواتير الموردين (وعاء المدخلات = تكلفة الشراء)، وتكلفة كل صنفٍ في تقرير الربح
 * تكشف تكلفة شراء الوحدة — فبالصلاحية نفسها التي يحرس بها تقرير المشتريات وصفحات المستودع (canManageVanStock — افتراضيّها مسموح):
 * جلسة مالك المنصة تمرّ، والمعطَّلة صراحةً أو الحساب غير النشط لا. يستعمله تقريرا الضرائب والربح (services/reports/profitReport).
 */
export async function canSeePurchaseCost(req: AuthRequest): Promise<boolean> {
  if (isOwnerSession(req)) return true;
  const id = req.user?.id;
  if (!id) return false;
  const admin = await prisma.admin.findUnique({ where: { id }, select: { isActive: true, canManageVanStock: true } });
  return admin?.isActive === true && admin.canManageVanStock !== false;
}

/**
 * GET /api/reports/tax?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=month|quarter|rate
 * يُركَّب بسطرٍ واحد خلف حرّاس موجّه التقارير (authenticate + requireAdmin + canViewReports): `router.get('/tax', taxReportHandler)`.
 * ٤٠٣ ACCOUNTING_NOT_ALLOWED للمحاسبة المطفأة صراحةً (كتقرير الربح)، و٤٠٠ لتاريخٍ غير صالح أو «من» بعد «إلى».
 * الردّ: { success, data: TaxReportData, meta: { appliedRange: { from, to, defaulted }, timezone } }.
 */
export async function taxReportHandler(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const tid = tenantId(req);
    const groupBy = taxGroupByOf(req.query.groupBy);
    const [tenant, tz, decimals, company] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tid }, select: { accountingEnabled: true } }),
      tenantTz(tid),
      tenantCurrencyDecimals(tid),
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { taxDisabled: true } }),
    ]);
    if (tenant?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    const range = taxReportRange(req.query.from, req.query.to, tz);
    if (!range.ok) { res.status(400).json({ success: false, message: range.message }); return; }
    const meta = { appliedRange: { from: range.from, to: range.to, defaulted: range.defaulted }, timezone: tz };
    // «إزالة الضريبة»: لا تقرير — بيانٌ فارغ صريح بلا أي رقم
    if (isTaxOff(company)) { res.json({ success: true, data: taxDisabledReport(groupBy, decimals), meta }); return; }

    const scope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const scoped = Object.keys(scope).length > 0;
    const withPurchases = !scoped && (await canSeePurchaseCost(req));
    const docs = await loadTaxDocs(prisma, { tenantId: tid, tz, from: range.from, to: range.to, scope, withPurchases });
    const data = buildTaxReport({ ...docs, groupBy, decimals, range: { from: range.from, to: range.to }, scoped });
    res.json({ success: true, data, meta });
  } catch (err) { next(err); }
}
