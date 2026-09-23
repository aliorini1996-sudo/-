/**
 * تجميع أرصدة الحسابات — المحرّك المشترك لكل تقارير §7 (M4، DESIGN.md §7.1، §7.2، §2.5).
 *
 * **صرفة تماماً**: تستقبل مصفوفات (أرصدة شهرية + بنود) وتُعيد أرصدة، وتُختبر بلا قاعدة بيانات.
 * قراءة القاعدة كلّها في `reports/load.ts` وحده.
 *
 * المصادر الأربعة (§7.1):
 *   1. `gl_period_balances` للشهور الكاملة ضمن المدى وقبله.
 *   2. بنود الشهور الجزئية على الحواف (`[tenantId, accountId, date]`).
 *   3. المسودات من البنود إذا اختير `includeDrafts`.
 *   4. بنود قيد إقفال السنة (`YYYY-CL`) تُعاد **منفصلة** ولا تُدمج في أي شهر.
 *
 * الإشارة: `balance = debit − credit` (§7.1)؛ والعرض يقلبها للالتزامات والملكية والإيرادات.
 * الافتتاحي: حسابات الميزانية كل ما قبل `from`، وحسابات قائمة الدخل من بداية السنة المالية فقط (§7.2).
 */
import { monthKey } from '../dates';
import { roundMilli } from '../money';
import type { AccountType, Milli } from '../types';
import { monthKeyEnd, monthKeyStart } from './period';
import type {
  AccountBalance, BalanceLineRow, BalanceSources, BalanceWindow, PeriodBalanceRow, ReportAccount, ReportPeriod,
  ReportUnit,
} from './types';

// ═══ قواعد النوع (§4.1، §7.1، §7.2) ═══

/** حساب قائمة دخل (`income*` أو `expense*`) — §7.2 قاعدة الافتتاحي. */
export function isProfitLossType(type: AccountType | string): boolean {
  return type.startsWith('income') || type.startsWith('expense');
}

/** حساب ميزانية (كل ما عدا قائمة الدخل، ومنه `off_balance`). */
export function isBalanceSheetType(type: AccountType | string): boolean {
  return !isProfitLossType(type);
}

/**
 * إشارة العرض (§7.1): الأصول والمصروفات بإشارة `debit − credit` نفسها،
 * والالتزامات وحقوق الملكية والإيرادات بالإشارة المعكوسة. `off_balance` بلا قلب.
 */
export function displaySign(type: AccountType | string): 1 | -1 {
  if (type.startsWith('liability') || type.startsWith('equity') || type.startsWith('income')) return -1;
  return 1;
}

/** المبلغ كما يُعرض في التقرير (بعد قاعدة الإشارة). */
export function displayMilli(type: AccountType | string, milli: Milli): Milli {
  return displaySign(type) === -1 ? -milli : milli;
}

// ═══ النوافذ ═══

/** النافذة التي يقع فيها تاريخ بالنسبة إلى الفترة (§7.2). */
export function windowOf(date: string, period: ReportPeriod): BalanceWindow {
  if (date < period.fyStart) return 'PRE_FY';
  if (date < period.from) return 'FY_OPENING';
  if (date <= period.to) return 'PERIOD';
  return 'AFTER';
}

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ═══ التجميع ═══

export interface ComposeBalancesInput {
  period: ReportPeriod;
  /** كل حسابات الشركة (أو المجموعة المطلوبة) — تحدّد قاعدة الافتتاحي وتضمن صفاً لكل حساب */
  accounts: readonly ReportAccount[];
  /** أرصدة الشهور الكاملة؛ لا تحوي مفاتيح 'YYYY-CL' ولا شهراً مقسوماً */
  periods?: readonly PeriodBalanceRow[];
  /** الحواف والمسودات وبنود الإقفال (وكل البنود في وضع المسح) */
  lines?: readonly BalanceLineRow[];
  /** الشهور المقروءة بنوداً — حارس الازدواج مع `periods` */
  splitMonths?: readonly string[];
  /** RPT‑05 */
  includeDrafts?: boolean;
}

interface Bucket {
  preFy: Milli;
  fyOpening: Milli;
  debit: Milli;
  credit: Milli;
  closingBefore: Milli;
  closingIn: Milli;
}

function emptyBucket(): Bucket {
  return { preFy: 0n, fyOpening: 0n, debit: 0n, credit: 0n, closingBefore: 0n, closingIn: 0n };
}

/**
 * يجمع المصادر الأربعة في رصيد لكل حساب. صرفة وحتمية (مرتّبة برمز الحساب).
 *
 * حراس الاتساق (أخطاء برمجية لا أخطاء مستخدم):
 * - `periodKey` غير 'YYYY-MM' (ومنه 'YYYY-CL') في `periods` ⇒ خطأ: بنود الإقفال تأتي بنوداً لا أرصدةً.
 * - شهر مجمّع يقع داخله حدّ ⇒ خطأ: كان يجب إدراجه في `splitMonths` وقراءته بنوداً.
 * - بند مرحّل غير إقفالي في شهر خارج `splitMonths` مع وجود أرصدة مجمّعة ⇒ خطأ ازدواج.
 * - بند على حساب غير موجود في `accounts` ⇒ خطأ (قاعدة الافتتاحي تعتمد على نوع الحساب).
 */
export function composeBalances(input: ComposeBalancesInput): AccountBalance[] {
  const { period, accounts } = input;
  const periods = input.periods ?? [];
  const lines = input.lines ?? [];
  const splitMonths = new Set(input.splitMonths ?? []);
  const includeDrafts = input.includeDrafts === true;

  const typeOf = new Map<string, AccountType>();
  for (const a of accounts) typeOf.set(a.id, a.type);

  const buckets = new Map<string, Bucket>();
  const bucketOf = (accountId: string): Bucket => {
    if (!typeOf.has(accountId)) {
      throw new Error(`composeBalances: حساب غير معروف في قائمة الحسابات: ${accountId}`);
    }
    let b = buckets.get(accountId);
    if (!b) { b = emptyBucket(); buckets.set(accountId, b); }
    return b;
  };

  // (1) الشهور الكاملة
  for (const row of periods) {
    if (!MONTH_KEY_RE.test(row.periodKey)) {
      throw new Error(`composeBalances: مفتاح فترة غير شهري في الأرصدة المجمّعة: "${row.periodKey}" (بنود الإقفال تُقرأ بنوداً)`);
    }
    if (splitMonths.has(row.periodKey)) {
      throw new Error(`composeBalances: الشهر ${row.periodKey} مقسوم وقُرئت بنوده، فلا يُجمع رصيده المخزَّن أيضاً`);
    }
    const start = windowOf(monthKeyStart(row.periodKey), period);
    const end = windowOf(monthKeyEnd(row.periodKey), period);
    if (start !== end) {
      throw new Error(`composeBalances: الشهر ${row.periodKey} يقع على حدّ فترة ولم يُدرج في splitMonths`);
    }
    if (start === 'AFTER') continue;
    const b = bucketOf(row.accountId);
    if (start === 'PRE_FY') b.preFy += row.debitMilli - row.creditMilli;
    else if (start === 'FY_OPENING') b.fyOpening += row.debitMilli - row.creditMilli;
    else { b.debit += row.debitMilli; b.credit += row.creditMilli; }
  }

  // (2)(3)(4) البنود
  const hasAggregates = periods.length > 0;
  for (const line of lines) {
    if (line.draft && !includeDrafts) continue;
    const w = windowOf(line.date, period);
    if (w === 'AFTER') continue;
    const b = bucketOf(line.accountId);
    if (line.closing) {
      // (4) بنود YYYY-CL منفصلة تماماً — لا تدخل الافتتاحي ولا حركة الفترة (§2.5)
      if (w === 'PERIOD') b.closingIn += line.debitMilli - line.creditMilli;
      else b.closingBefore += line.debitMilli - line.creditMilli;
      continue;
    }
    if (hasAggregates && !line.draft && !splitMonths.has(monthKey(line.date))) {
      throw new Error(`composeBalances: بند مرحّل بتاريخ ${line.date} خارج الشهور المقسومة مع وجود أرصدة مجمّعة (ازدواج)`);
    }
    if (w === 'PRE_FY') b.preFy += line.debitMilli - line.creditMilli;
    else if (w === 'FY_OPENING') b.fyOpening += line.debitMilli - line.creditMilli;
    else { b.debit += line.debitMilli; b.credit += line.creditMilli; }
  }

  const sorted = [...accounts].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return sorted.map((a) => {
    const b = buckets.get(a.id) ?? emptyBucket();
    const pl = isProfitLossType(a.type);
    return {
      accountId: a.id,
      openingMilli: pl ? b.fyOpening : b.preFy + b.fyOpening,
      debitMilli: b.debit,
      creditMilli: b.credit,
      closingMilli: b.closingIn,
      closingOpeningMilli: b.closingBefore,
      preFyMilli: b.preFy,
    };
  });
}

/** اختصار: `composeBalances` من مخرَج `loadBalanceSources` مباشرةً. */
export function composeBalancesFromSources(
  sources: BalanceSources,
  accounts: readonly ReportAccount[],
  includeDrafts = false,
): AccountBalance[] {
  return composeBalances({
    period: sources.period,
    accounts,
    periods: sources.periods,
    lines: sources.lines,
    splitMonths: sources.splitMonths,
    includeDrafts,
  });
}

// ═══ مشتقّات ═══

/** الرصيد النهائي = الافتتاحي + المدين − الدائن (§7.2). بنود الإقفال خارجه عمداً. */
export function endingMilli(b: AccountBalance): Milli {
  return b.openingMilli + b.debitMilli - b.creditMilli;
}

/** صافي حركة الفترة = المدين − الدائن (بلا بنود الإقفال). */
export function periodNetMilli(b: AccountBalance): Milli {
  return b.debitMilli - b.creditMilli;
}

/** رصيد الحساب في حدّ ذاته بضمّ بنود الإقفال (قاعدة حسابات الميزانية: 313001 يبقى في صف حسابه، §7.2). */
export function endingWithClosingMilli(b: AccountBalance): Milli {
  return endingMilli(b) + b.closingOpeningMilli + b.closingMilli;
}

/** هل للحساب حركة في الفترة؟ (RPT‑14: حسابات قائمة الدخل بلا حركة لا تظهر) */
export function hasMovement(b: AccountBalance): boolean {
  return b.debitMilli !== 0n || b.creditMilli !== 0n || b.closingMilli !== 0n;
}

/** هل الصف صفري تماماً؟ (RPT‑07 «إخفاء الأصفار») */
export function isZeroRow(b: AccountBalance): boolean {
  return b.openingMilli === 0n && b.debitMilli === 0n && b.creditMilli === 0n
    && b.closingMilli === 0n && b.closingOpeningMilli === 0n && b.preFyMilli === 0n;
}

export interface BalanceTotals {
  openingMilli: Milli;
  debitMilli: Milli;
  creditMilli: Milli;
  closingMilli: Milli;
  closingOpeningMilli: Milli;
  preFyMilli: Milli;
  endingMilli: Milli;
}

export function sumBalances(rows: readonly AccountBalance[]): BalanceTotals {
  const t: BalanceTotals = {
    openingMilli: 0n, debitMilli: 0n, creditMilli: 0n, closingMilli: 0n, closingOpeningMilli: 0n,
    preFyMilli: 0n, endingMilli: 0n,
  };
  for (const r of rows) {
    t.openingMilli += r.openingMilli;
    t.debitMilli += r.debitMilli;
    t.creditMilli += r.creditMilli;
    t.closingMilli += r.closingMilli;
    t.closingOpeningMilli += r.closingOpeningMilli;
    t.preFyMilli += r.preFyMilli;
    t.endingMilli += endingMilli(r);
  }
  return t;
}

/** خريطة سريعة من معرّف الحساب إلى رصيده. */
export function balanceIndex(rows: readonly AccountBalance[]): Map<string, AccountBalance> {
  return new Map(rows.map((r) => [r.accountId, r]));
}

/** رصيد فارغ لحساب (لملء الفجوات بلا فروع شرطية في التقارير). */
export function zeroBalance(accountId: string): AccountBalance {
  return { accountId, openingMilli: 0n, debitMilli: 0n, creditMilli: 0n, closingMilli: 0n, closingOpeningMilli: 0n, preFyMilli: 0n };
}

// ═══ حراس التوازن (§7.2 صف الإجمالي) ═══

/**
 * خرق توازن الافتتاحي: Σ كل ما قبل `from` = 0 من القيد المزدوج (I1).
 * الجمع يضمّ `preFyMilli` لحسابات قائمة الدخل (خارج افتتاحيها) وبنود الإقفال السابقة.
 */
export function openingImbalance(rows: readonly AccountBalance[], accounts: readonly ReportAccount[]): Milli {
  const typeOf = new Map(accounts.map((a) => [a.id, a.type]));
  let sum = 0n;
  for (const r of rows) {
    const type = typeOf.get(r.accountId);
    const pl = type !== undefined && isProfitLossType(type);
    sum += r.openingMilli + r.closingOpeningMilli + (pl ? r.preFyMilli : 0n);
  }
  return sum;
}

/** خرق توازن الحركة: Σ المدين − Σ الدائن = 0. */
export function movementImbalance(rows: readonly AccountBalance[]): Milli {
  let sum = 0n;
  for (const r of rows) sum += r.debitMilli - r.creditMilli;
  return sum;
}

/** خرق توازن بنود الإقفال داخل الفترة: Σ = 0 (قيد الإقفال متوازن بذاته). */
export function closingImbalance(rows: readonly AccountBalance[]): Milli {
  let sum = 0n;
  for (const r of rows) sum += r.closingMilli;
  return sum;
}

// ═══ خيارات العرض المشتركة ═══

/** بحث RPT‑15: مطابقة الرمز بالبادئة، والاسم بأي لغة بالاحتواء (بلا حساسية حالة). */
export function matchesAccountSearch(account: ReportAccount, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  if (account.code.toLowerCase().startsWith(q)) return true;
  if (account.name.toLowerCase().includes(q)) return true;
  const i18n = account.nameI18n;
  if (i18n) for (const v of Object.values(i18n)) if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
  return false;
}

/**
 * وحدة العرض RPT‑06: قسمة على 1 أو ألف أو مليون **بالملّي** (بلا float)،
 * بتقريب نصف-لأعلى بعيداً عن الصفر كبقية المحرك (§2.3).
 */
export function toUnitMilli(milli: Milli, unit: ReportUnit): Milli {
  if (unit === 1) return milli;
  const u = BigInt(unit);
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  const q = abs / u;
  const out = abs % u * 2n >= u ? q + 1n : q;
  return neg ? -out : out;
}

/** تقريب مبلغ العرض إلى منازل العملة (يعيد استعمال `money.ts` ولا يكرّره). */
export function roundToCurrency(milli: Milli, currencyDecimals: number): Milli {
  return roundMilli(milli, currencyDecimals);
}
