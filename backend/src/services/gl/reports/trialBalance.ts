/**
 * ميزان المراجعة (M4، DESIGN.md §7.2، TB‑01…TB‑03، وخيارات §7.1 RPT‑04/06/07/14/15).
 *
 * **صرفة تماماً**: تستقبل حسابات وأرصدة (مخرَج `composeBalances`) وتُعيد صفوف تقرير، وتُختبر بلا
 * قاعدة بيانات. قراءة القاعدة كلّها في `reports/load.ts` وحده (§7.1، ADR‑9).
 *
 * الأعمدة الأربعة لكل فترة (§7.2): الرصيد الافتتاحي | مدين | دائن | الرصيد النهائي، وتتكرر مع
 * كل عمود مقارنة (RPT‑04) داخل خلايا الصف نفسه، ومعه فرق ونسبة على الرصيد النهائي.
 *
 * قواعد §7.2 المطبَّقة هنا حرفياً:
 * 1. **الافتتاحي لحسابات الميزانية** = Σ كل ما قبل `from`، **ولحسابات قائمة الدخل** = حركة
 *    [FYStart(from), from) وحدها. محسوبٌ أصلاً في `AccountBalance.openingMilli` (balances.ts).
 * 2. **صف «أرباح سنوات سابقة غير موزعة»** (صف افتراضي لا حساب): افتتاحيه = Σ رصيد حسابات قائمة
 *    الدخل قبل `FYStart(from)` (`preFyMilli`) مضافاً إليه رصيد حسابات `equity_unaffected` (319001).
 *    ولأنّ رصيد 319001 **يُضاف** إلى هذا الصف فإنّ حسابه **لا يظهر صفاً مستقلاً** (وإلا احتُسب
 *    مرتين وانكسر شرط Σ الافتتاحي = 0). حركته صفر إلا من بنود الإقفال (البند 3) ومن حركة 319001 نفسه.
 * 3. **بنود قيد إقفال السنة (`YYYY-CL`)**: على حسابات قائمة الدخل لا تدخل قسمها ولا افتتاحها،
 *    بل تُعرض في صف «أرباح سنوات سابقة» — حركةً إن وقع تاريخ الإقفال داخل الفترة، وضمن افتتاحيه
 *    إن وقع قبلها. وعلى حسابات الميزانية (313001) تبقى في صف حسابها بالقاعدة نفسها، فيبقى صف
 *    الإجمالي متوازناً قبل الإقفال وبعده.
 * 4. **النهائي** = الافتتاحي + المدين − الدائن.
 * 5. **صف الإجمالي**: Σ الافتتاحي = 0، وΣ المدين = Σ الدائن، وΣ النهائي = 0 — من القيد المزدوج (I1)
 *    على **كل** الحسابات. الخرق يُوسم في `imbalance` و`balanced` لتعرضه الواجهة أحمر.
 *
 * ملاحظة إشارة: ميزان المراجعة **لا يقلب** إشارة الالتزامات والملكية والإيرادات (`displaySign`)،
 * فشرط Σ = 0 قائم على `debit − credit` الخام. القلب لقائمة الدخل والميزانية (§7.3، §7.4).
 *
 * **عقد المبالغ الموحّد**: الحساب كلّه بالملّي BigInt (§2.3)، و`serializeTrialBalance` لا تغيّر مقداره
 * بل شكله فقط: كل مفتاح ينتهي بـ`Milli` يخرج **نصّ عدد صحيح بالملّي** (`'63000000'`) فيصلح لـ
 * `res.json` بلا BigInt وبلا فقد دقة. لا تنسيق ولا تقريب ولا وحدة عرض على الخادم: وحدة العرض
 * (RPT‑06) في `unit` ومنازل العملة في `currencyDecimals` تُعادان بياناً وصفياً تصيّر به الواجهة
 * (والمتصفح يبني XLSX وPDF منه، §7.1 RPT‑01)، فلا يمرّ مبلغ بمسارين ولا يكسر تقريبُ عرضٍ تسويات §7.2.
 */
import { SA_6D_ACCOUNT_GROUPS } from '../coa/sa';
import type { AccountType, Milli } from '../types';
import { endingMilli, isProfitLossType, matchesAccountSearch, zeroBalance } from './balances';
import type { AccountBalance, ReportAccount, ReportOptions, ReportPeriod, ReportUnit } from './types';

// ═══ ثوابت التقرير ═══

/** مفتاح التقرير في `GET /api/ledger/reports/:key` ومسار الواجهة `reports/trial-balance` (§8.2، ملحق أ). */
export const TRIAL_BALANCE_KEY = 'trial-balance';

/** معرّف الصف الافتراضي «أرباح سنوات سابقة غير موزعة» (§7.2) — ليس معرّف حساب. */
export const UNALLOCATED_EARNINGS_ROW_ID = 'unallocated-earnings';

export const UNALLOCATED_EARNINGS_NAME = 'أرباح سنوات سابقة غير موزعة';

/** أسماء الصف الافتراضي بخمس لغات (§8.7) — لا فواصل عليا ASCII. */
export const UNALLOCATED_EARNINGS_NAME_I18N: Readonly<Record<string, string>> = Object.freeze({
  ar: UNALLOCATED_EARNINGS_NAME,
  en: 'Unallocated Earnings',
  fr: 'Résultats non affectés',
  tr: 'Dağıtılmamış Kârlar',
  zh: '未分配利润',
});

/** رؤوس الأعمدة الأربعة (§7.2) — تستعملها الواجهة والتصدير. */
export const TRIAL_BALANCE_COLUMN_LABELS = Object.freeze({
  opening: 'الرصيد الافتتاحي',
  debit: 'مدين',
  credit: 'دائن',
  ending: 'الرصيد النهائي',
});

/** أطوال بادئات الهرمية التي تُضاف دائماً (RPT‑07 «التجميع ببادئة الرمز»). */
export const DEFAULT_HIERARCHY_PREFIX_LENGTHS: readonly number[] = [1, 2, 3];

/** بادئة معرّف عقدة المجموعة، فلا تختلط بمعرّفات الحسابات. */
export const GROUP_ROW_ID_PREFIX = 'group:';

/** نوع الحساب الذي يُدمج في الصف الافتراضي (319001، §7.2). */
export const UNAFFECTED_ACCOUNT_TYPE: AccountType = 'equity_unaffected';

// ═══ الأشكال ═══

export type TrialBalanceRowKind = 'group' | 'account' | 'unallocated';

/** خانة عمود واحد في صف: الأعمدة الأربعة، ومع أعمدة المقارنة فرقٌ ونسبة على الرصيد النهائي (RPT‑04). */
export interface TrialBalanceCell {
  openingMilli: Milli;
  debitMilli: Milli;
  creditMilli: Milli;
  /** = الافتتاحي + المدين − الدائن (§7.2) */
  endingMilli: Milli;
  /** عمود المقارنة: النهائي الأساسي − النهائي المقارَن (null للعمود الأساسي) */
  deltaMilli: Milli | null;
  /** النسبة المئوية بمنزلتين (null للعمود الأساسي أو حين يكون المقارَن صفراً) */
  percent: number | null;
}

export interface TrialBalanceRow {
  /** معرّف الحساب، أو `group:<بادئة>`، أو `unallocated-earnings` */
  id: string;
  kind: TrialBalanceRowKind;
  /** معرّف `GlAccount` للتعمّق وقائمة ⋮ (RPT‑10/11) — null للمجموعة والصف الافتراضي */
  accountId: string | null;
  code: string;
  name: string;
  nameI18n: Readonly<Record<string, string>> | null;
  type: AccountType | null;
  /** عمق الصف في الشجرة (0 في الوضع المسطّح) */
  level: number;
  parentId: string | null;
  childIds: readonly string[];
  hasChildren: boolean;
  /** حسابات `equity_unaffected` المدمجة في الصف الافتراضي (فارغة لغيره) — للتعمّق */
  mergedAccountIds: readonly string[];
  /** بترتيب `columns`: [0] الفترة الأساسية ثم أعمدة المقارنة */
  cells: readonly TrialBalanceCell[];
}

/** مجموعة عرض ببادئة الرمز. الافتراض `DEFAULT_TRIAL_BALANCE_GROUPS` (بيانات قالب صرفة، لا I/O). */
export interface TrialBalanceGroup {
  code: string;
  name: string;
  nameI18n?: Readonly<Record<string, string>> | null;
}

/** عمود: فترة وأرصدتها المحسوبة على حدة (‏`loadBalanceSources` مستقل لكل فترة، §7.1). */
export interface TrialBalanceColumnInput {
  period: ReportPeriod;
  balances: readonly AccountBalance[];
}

/** الاسم الذي يستعمله المسار لأعمدة المقارنة (`StatementPeriodBalances`). */
export type TrialBalancePeriodBalances = TrialBalanceColumnInput;

/**
 * مدخل البناء بصيغتين متكافئتين:
 * 1. `columns: [الأساسية, ...المقارنات]` — الصيغة المباشرة.
 * 2. `period` و`balances` و`comparisons` — الصيغة نفسها التي يمرّرها جسر `StatementInput`
 *    في `routes/ledger/reports.ts` (ومعها `reportKey` و`settings` وتُتجاهلان هنا).
 */
export interface TrialBalanceInput {
  /** حسابات الشركة كاملةً (المصدر نفسه الذي مرّ على `composeBalances`) */
  accounts: readonly ReportAccount[];
  /** الصيغة 1: الأعمدة صراحةً، [0] الفترة الأساسية */
  columns?: readonly TrialBalanceColumnInput[];
  /** الصيغة 2: الفترة الأساسية */
  period?: ReportPeriod;
  /** الصيغة 2: أرصدة الفترة الأساسية */
  balances?: readonly AccountBalance[];
  /** الصيغة 2: أعمدة المقارنة، الأقرب أولاً (RPT‑04) */
  comparisons?: readonly TrialBalanceColumnInput[];
  /** خيارات §7.1 الموحّدة بعد `normalizeReportOptions`؛ الحقول المفردة أدناه تتقدّم عليها */
  options?: Partial<ReportOptions>;
  /** RPT‑07: التجميع ببادئة الرمز */
  hierarchy?: boolean;
  /** RPT‑07 / RPT‑14: إخفاء الصفوف الصفرية */
  hideZero?: boolean;
  /** RPT‑15: بحث داخل التقرير — يصفّي الصفوف ولا يمسّ صف الإجمالي */
  search?: string;
  /** RPT‑06: يُعاد كما هو ولا يُطبَّق على المبالغ أصلاً — وحدة العرض شأن الواجهة */
  unit?: ReportUnit;
  /** أسماء مجموعات البادئات؛ الافتراض مجموعات القالب (‏`[]` يعطي بادئات عارية) */
  groups?: readonly TrialBalanceGroup[];
  /** بادئات تُضاف دائماً فوق رموز `groups` (الافتراض 1 و2 و3 أرقام) */
  hierarchyPrefixLengths?: readonly number[];
  /** عدد قيود المسودة في المدى (RPT‑08) — يُعاد كما هو */
  draftMoveCount?: number;
  /** يُقبل ويُتجاهل — يمرّره جسر `StatementInput` */
  reportKey?: string;
  /** يُقبل ويُتجاهل هنا (العملة ومنازلها بيانٌ وصفي يمرّره `serializeTrialBalance` كما هو) */
  settings?: unknown;
}

export interface TrialBalanceColumnMeta {
  period: ReportPeriod;
  kind: 'base' | 'comparison';
  index: number;
}

/** خرق توازن عمود (§7.2 صف الإجمالي) — الثلاثة أصفار من I1، وغير ذلك يُعرض أحمر. */
export interface TrialBalanceImbalance {
  openingMilli: Milli;
  /** Σ المدين − Σ الدائن */
  movementMilli: Milli;
  endingMilli: Milli;
  balanced: boolean;
}

export interface TrialBalanceReport {
  key: typeof TRIAL_BALANCE_KEY;
  period: ReportPeriod;
  columns: TrialBalanceColumnMeta[];
  /** الصفوف بترتيب العرض (عمق أولاً في الوضع الهرمي، والصف الافتراضي آخراً) */
  rows: TrialBalanceRow[];
  /** إجمالي **كل** الحسابات لكل عمود — صف الإجمالي الذي تنطبق عليه شروط §7.2 الثلاثة */
  totals: TrialBalanceCell[];
  /** إجمالي الصفوف المعروضة وحدها (يخالف `totals` حين يضيّق البحث النتيجة) */
  visibleTotals: TrialBalanceCell[];
  imbalance: TrialBalanceImbalance[];
  balanced: boolean;
  hierarchy: boolean;
  hideZero: boolean;
  search: string;
  searchApplied: boolean;
  unit: ReportUnit;
  postedOnly: boolean;
  includeDrafts: boolean;
  draftMoveCount: number;
  /** صفوف الحسابات المعروضة + الصف الافتراضي (بلا عُقد الشجرة) — سطور التصدير (RPT‑01) */
  accountRowCount: number;
}

// ═══ أدوات داخلية ═══

interface RawCell {
  opening: Milli;
  debit: Milli;
  credit: Milli;
}

const emptyRaw = (): RawCell => ({ opening: 0n, debit: 0n, credit: 0n });

function addRaw(target: RawCell, src: RawCell): void {
  target.opening += src.opening;
  target.debit += src.debit;
  target.credit += src.credit;
}

/** نسبة مئوية بمنزلتين بلا float: نصف-لأعلى بعيداً عن الصفر (§2.3). */
export function percentChange(delta: Milli, base: Milli): number | null {
  if (base === 0n) return null;
  const absBase = base < 0n ? -base : base;
  const scaled = delta * 10_000n;
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const q = abs / absBase;
  const out = (abs % absBase) * 2n >= absBase ? q + 1n : q;
  return Number(neg ? -out : out) / 100;
}

/** يحوّل الخانات الخام إلى خانات التقرير مع الفرق والنسبة مقابل العمود الأساسي. */
function toCells(raw: readonly RawCell[]): TrialBalanceCell[] {
  const ends = raw.map((r) => r.opening + r.debit - r.credit);
  return raw.map((r, i) => ({
    openingMilli: r.opening,
    debitMilli: r.debit,
    creditMilli: r.credit,
    endingMilli: ends[i],
    deltaMilli: i === 0 ? null : ends[0] - ends[i],
    percent: i === 0 ? null : percentChange(ends[0] - ends[i], ends[i]),
  }));
}

function isZeroCells(cells: readonly TrialBalanceCell[]): boolean {
  return cells.every(
    (c) => c.openingMilli === 0n && c.debitMilli === 0n && c.creditMilli === 0n && c.endingMilli === 0n,
  );
}

/**
 * خانة حساب في عمود واحد (§7.2):
 * - قائمة الدخل: الافتتاحي والحركة كما هما، وبنود الإقفال مستبعدة (تذهب للصف الافتراضي).
 * - الميزانية: بنود الإقفال تبقى في صف الحساب — السابقة في افتتاحه، والواقعة داخل الفترة حركةً
 *   (صافيها يُقسَّم على عمودي مدين/دائن حسب إشارته)، فيساوي نهائيه `endingWithClosingMilli`.
 */
function accountRaw(b: AccountBalance, pl: boolean): RawCell {
  if (pl) return { opening: b.openingMilli, debit: b.debitMilli, credit: b.creditMilli };
  const cl = b.closingMilli;
  return {
    opening: b.openingMilli + b.closingOpeningMilli,
    debit: b.debitMilli + (cl > 0n ? cl : 0n),
    credit: b.creditMilli + (cl < 0n ? -cl : 0n),
  };
}

/** مجموعات القالب أسماءً عربية افتراضية (‏`SA_6D_ACCOUNT_GROUPS` تخدم القالبين، §4.2). */
export const DEFAULT_TRIAL_BALANCE_GROUPS: readonly TrialBalanceGroup[] = SA_6D_ACCOUNT_GROUPS.map((g) => ({
  code: g.code,
  name: g.names.ar,
  nameI18n: g.names,
}));

const pseudoUnallocatedAccount: ReportAccount = {
  id: UNALLOCATED_EARNINGS_ROW_ID,
  code: '',
  name: UNALLOCATED_EARNINGS_NAME,
  nameI18n: UNALLOCATED_EARNINGS_NAME_I18N,
  type: UNAFFECTED_ACCOUNT_TYPE,
};

/**
 * بادئات الحساب في الشجرة تصاعدياً بالطول: كل رمز مجموعة هو بادئة للحساب وأقصر منه، ومعها
 * البادئات الافتراضية (1 و2 و3 أرقام) فلا يسقط حساب خارج الشجرة حين تنقص المجموعات.
 */
export function accountPrefixes(
  code: string,
  groupCodes: ReadonlySet<string>,
  lengths: readonly number[],
): string[] {
  const out = new Set<string>();
  for (const len of lengths) {
    if (len > 0 && len < code.length) out.add(code.slice(0, len));
  }
  for (const g of groupCodes) {
    if (g.length < code.length && code.startsWith(g)) out.add(g);
  }
  return [...out].sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
}

function pick<K extends keyof ReportOptions>(
  input: TrialBalanceInput, flat: ReportOptions[K] | undefined, key: K, fallback: ReportOptions[K],
): ReportOptions[K] {
  if (flat !== undefined) return flat;
  const v = input.options?.[key];
  return v === undefined ? fallback : (v as ReportOptions[K]);
}

// ═══ البناء ═══

/**
 * يبني ميزان المراجعة من الحسابات والأرصدة. صرفة وحتمية.
 *
 * حراس (أخطاء برمجية لا أخطاء مستخدم): بلا فترة أساسية، أو رصيد على حساب غير موجود في `accounts`.
 */
export function buildTrialBalance(input: TrialBalanceInput): TrialBalanceReport {
  const { accounts } = input;
  const columnsIn: TrialBalanceColumnInput[] = input.columns && input.columns.length > 0
    ? [...input.columns]
    : input.period
      ? [{ period: input.period, balances: input.balances ?? [] }, ...(input.comparisons ?? [])]
      : [];
  if (columnsIn.length === 0) {
    throw new Error('buildTrialBalance: لا أعمدة — مرّر columns أو period مع balances');
  }
  const n = columnsIn.length;

  const hierarchy = pick(input, input.hierarchy, 'hierarchy', false);
  const hideZero = pick(input, input.hideZero, 'hideZero', false);
  const unit = pick(input, input.unit, 'unit', 1);
  const search = String(pick(input, input.search, 'search', '')).trim();
  const includeDrafts = pick(input, undefined, 'includeDrafts', false);
  const postedOnly = pick(input, undefined, 'postedOnly', !includeDrafts);

  const known = new Set(accounts.map((a) => a.id));
  const byColumn: Map<string, AccountBalance>[] = columnsIn.map((col) => {
    const map = new Map<string, AccountBalance>();
    for (const b of col.balances) {
      if (!known.has(b.accountId)) {
        throw new Error(`buildTrialBalance: رصيد على حساب غير معروف في قائمة الحسابات: ${b.accountId}`);
      }
      map.set(b.accountId, b);
    }
    return map;
  });

  // ترتيب ثابت: الرمز ثم المعرّف (كترتيب composeBalances و loadReportAccounts)
  const sorted = [...accounts].sort((a, b) => (
    a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  ));

  // ── 1) الخانات الخام لكل حساب، وتجميع الصف الافتراضي (§7.2 البندان 2 و3) ──
  const perAccount = new Map<string, RawCell[]>();
  const unallocated: RawCell[] = Array.from({ length: n }, emptyRaw);
  const unallocatedClosing: Milli[] = Array.from({ length: n }, () => 0n);
  const mergedAccountIds: string[] = [];
  const accountList: ReportAccount[] = [];

  for (const a of sorted) {
    const pl = isProfitLossType(a.type);
    const unaff = a.type === UNAFFECTED_ACCOUNT_TYPE;
    if (unaff) mergedAccountIds.push(a.id);

    const cells: RawCell[] = [];
    for (let i = 0; i < n; i++) {
      const b = byColumn[i].get(a.id) ?? zeroBalance(a.id);
      if (unaff) {
        // رصيد 319001 كلّه ينتقل إلى الصف الافتراضي: افتتاحه وحركته وبنود إقفاله
        unallocated[i].opening += b.openingMilli + b.closingOpeningMilli;
        unallocated[i].debit += b.debitMilli;
        unallocated[i].credit += b.creditMilli;
        unallocatedClosing[i] += b.closingMilli;
        continue;
      }
      if (pl) {
        // بنود الإقفال على حسابات قائمة الدخل وأرصدة ما قبل السنة تذهب للصف الافتراضي
        unallocated[i].opening += b.preFyMilli + b.closingOpeningMilli;
        unallocatedClosing[i] += b.closingMilli;
      }
      cells.push(accountRaw(b, pl));
    }
    if (!unaff) {
      perAccount.set(a.id, cells);
      accountList.push(a);
    }
  }

  // صافي بنود الإقفال داخل الفترة يُقسَّم على عمودي مدين/دائن في الصف الافتراضي
  for (let i = 0; i < n; i++) {
    const cl = unallocatedClosing[i];
    if (cl > 0n) unallocated[i].debit += cl;
    else if (cl < 0n) unallocated[i].credit += -cl;
  }

  // ── 2) الإجمالي على كل الحسابات (§7.2 شروط صف الإجمالي الثلاثة) ──
  const totalsRaw: RawCell[] = Array.from({ length: n }, emptyRaw);
  for (const a of accountList) {
    const cells = perAccount.get(a.id) as RawCell[];
    for (let i = 0; i < n; i++) addRaw(totalsRaw[i], cells[i]);
  }
  for (let i = 0; i < n; i++) addRaw(totalsRaw[i], unallocated[i]);

  const totals = toCells(totalsRaw);
  const imbalance: TrialBalanceImbalance[] = totals.map((t) => {
    const movement = t.debitMilli - t.creditMilli;
    return {
      openingMilli: t.openingMilli,
      movementMilli: movement,
      endingMilli: t.endingMilli,
      balanced: t.openingMilli === 0n && movement === 0n && t.endingMilli === 0n,
    };
  });

  // ── 3) الترشيح: البحث (RPT‑15) ثم إخفاء الأصفار (RPT‑07) ──
  const searchApplied = search.length > 0;
  const visibleAccounts: ReportAccount[] = [];
  const cellsOf = new Map<string, TrialBalanceCell[]>();
  for (const a of accountList) {
    if (searchApplied && !matchesAccountSearch(a, search)) continue;
    const cells = toCells(perAccount.get(a.id) as RawCell[]);
    if (hideZero && isZeroCells(cells)) continue;
    cellsOf.set(a.id, cells);
    visibleAccounts.push(a);
  }

  const unallocatedCells = toCells(unallocated);
  const showUnallocated = (!searchApplied || matchesAccountSearch(pseudoUnallocatedAccount, search))
    && !(hideZero && isZeroCells(unallocatedCells));

  // ── 4) الشجرة (RPT‑07) أو القائمة المسطّحة ──
  const rows: TrialBalanceRow[] = [];

  if (hierarchy) {
    const groupList = input.groups ?? DEFAULT_TRIAL_BALANCE_GROUPS;
    const groupByCode = new Map(groupList.map((g) => [g.code, g]));
    const groupCodes = new Set(groupByCode.keys());
    const lengths = [...(input.hierarchyPrefixLengths ?? DEFAULT_HIERARCHY_PREFIX_LENGTHS)].sort((a, b) => a - b);

    const stack: string[] = [];
    const groupRowIndex = new Map<string, number>();
    const groupTotals = new Map<string, RawCell[]>();
    const groupChildren = new Map<string, string[]>();

    for (const a of visibleAccounts) {
      const chain = accountPrefixes(a.code, groupCodes, lengths);
      let common = 0;
      while (common < stack.length && common < chain.length && stack[common] === chain[common]) common++;
      stack.length = common;
      for (let i = common; i < chain.length; i++) {
        const code = chain[i];
        const id = `${GROUP_ROW_ID_PREFIX}${code}`;
        const parentId = i > 0 ? `${GROUP_ROW_ID_PREFIX}${chain[i - 1]}` : null;
        const tpl = groupByCode.get(code);
        groupRowIndex.set(id, rows.length);
        groupTotals.set(id, Array.from({ length: n }, emptyRaw));
        groupChildren.set(id, []);
        if (parentId) groupChildren.get(parentId)?.push(id);
        rows.push({
          id,
          kind: 'group',
          accountId: null,
          code,
          name: tpl?.name ?? code,
          nameI18n: tpl?.nameI18n ?? null,
          type: null,
          level: i,
          parentId,
          childIds: [],
          hasChildren: true,
          mergedAccountIds: [],
          cells: [],
        });
        stack.push(code);
      }

      const parentId = chain.length > 0 ? `${GROUP_ROW_ID_PREFIX}${chain[chain.length - 1]}` : null;
      if (parentId) groupChildren.get(parentId)?.push(a.id);
      const raw = perAccount.get(a.id) as RawCell[];
      for (const code of chain) {
        const bucket = groupTotals.get(`${GROUP_ROW_ID_PREFIX}${code}`);
        if (bucket) for (let i = 0; i < n; i++) addRaw(bucket[i], raw[i]);
      }
      rows.push({
        id: a.id,
        kind: 'account',
        accountId: a.id,
        code: a.code,
        name: a.name,
        nameI18n: a.nameI18n,
        type: a.type,
        level: chain.length,
        parentId,
        childIds: [],
        hasChildren: false,
        mergedAccountIds: [],
        cells: cellsOf.get(a.id) as TrialBalanceCell[],
      });
    }

    // خانات العُقد بعد اكتمال تجميع أبنائها، وقائمة أبنائها بترتيب العرض
    for (const [id, index] of groupRowIndex) {
      rows[index] = {
        ...rows[index],
        childIds: groupChildren.get(id) ?? [],
        cells: toCells(groupTotals.get(id) as RawCell[]),
      };
    }
  } else {
    for (const a of visibleAccounts) {
      rows.push({
        id: a.id,
        kind: 'account',
        accountId: a.id,
        code: a.code,
        name: a.name,
        nameI18n: a.nameI18n,
        type: a.type,
        level: 0,
        parentId: null,
        childIds: [],
        hasChildren: false,
        mergedAccountIds: [],
        cells: cellsOf.get(a.id) as TrialBalanceCell[],
      });
    }
  }

  // الصف الافتراضي في المستوى الأعلى وفي آخر الصفوف دائماً (لا رمز له فلا موضع له في الشجرة)
  if (showUnallocated) {
    rows.push({
      id: UNALLOCATED_EARNINGS_ROW_ID,
      kind: 'unallocated',
      accountId: null,
      code: '',
      name: UNALLOCATED_EARNINGS_NAME,
      nameI18n: UNALLOCATED_EARNINGS_NAME_I18N,
      type: null,
      level: 0,
      parentId: null,
      childIds: [],
      hasChildren: false,
      mergedAccountIds,
      cells: unallocatedCells,
    });
  }

  // ── 5) إجمالي المعروض ──
  const visibleRaw: RawCell[] = Array.from({ length: n }, emptyRaw);
  for (const a of visibleAccounts) {
    const raw = perAccount.get(a.id) as RawCell[];
    for (let i = 0; i < n; i++) addRaw(visibleRaw[i], raw[i]);
  }
  if (showUnallocated) for (let i = 0; i < n; i++) addRaw(visibleRaw[i], unallocated[i]);

  return {
    key: TRIAL_BALANCE_KEY,
    period: columnsIn[0].period,
    columns: columnsIn.map((c, i) => ({ period: c.period, kind: i === 0 ? 'base' : 'comparison', index: i })),
    rows,
    totals,
    visibleTotals: toCells(visibleRaw),
    imbalance,
    balanced: imbalance.every((x) => x.balanced),
    hierarchy,
    hideZero,
    search,
    searchApplied,
    unit,
    postedOnly,
    includeDrafts,
    draftMoveCount: input.draftMoveCount ?? 0,
    accountRowCount: visibleAccounts.length + (showUnallocated ? 1 : 0),
  };
}

// ═══ مشتقّات للقراءة ═══

/** عدد أسطر التصدير (بلا عُقد الشجرة وبلا صف الإجمالي) — لسقفي RPT‑01. */
export function trialBalanceLineCount(report: TrialBalanceReport): number {
  return report.accountRowCount;
}

/** صف بمعرّفه (للتعمّق والاختبارات). */
export function trialBalanceRow(report: TrialBalanceReport, id: string): TrialBalanceRow | undefined {
  return report.rows.find((r) => r.id === id);
}

/**
 * الرصيد النهائي لحساب واحد بقاعدة §7.2 (تستعمله الميزانية ودفتر الأستاذ لتطابق الميزان):
 * حسابات قائمة الدخل بلا بنود الإقفال، وحسابات الميزانية بها.
 */
export function accountEndingMilli(b: AccountBalance, type: AccountType | string): Milli {
  return isProfitLossType(type) ? endingMilli(b) : endingMilli(b) + b.closingOpeningMilli + b.closingMilli;
}

// ═══ التسلسل إلى ردّ JSON (عقد المبالغ: نصّ عدد صحيح بالملّي) ═══

/**
 * ما يُمرَّر إلى الردّ بياناً وصفياً للعرض. **لا يمسّ المبالغ**: لا تقريب ولا وحدة ولا تنسيق هنا.
 * وحدة العرض (RPT‑06) تأتي من التقرير نفسه (`report.unit`) وتُعاد كما هي لتطبّقها الواجهة.
 */
export interface TrialBalanceSerializeOptions {
  /** منازل العملة من `loadReportSettings` — تُعاد لتصيّر بها الواجهة، ولا يُقرَّب بها شيء على الخادم */
  currencyDecimals: number;
  /** رمز العملة للعرض */
  currency?: string;
}

/**
 * خانة في الردّ: كل مفتاح ينتهي بـ`Milli` **نصّ عدد صحيح بالملّي** (`'-7000000'`) بلا فاصلة عشرية
 * ولا فواصل آلاف ولا وحدة عرض. و`percent` وحده عدد (نسبة بمنزلتين، RPT‑04) لأنه ليس مبلغاً.
 */
export interface TrialBalanceCellPayload {
  openingMilli: string;
  debitMilli: string;
  creditMilli: string;
  endingMilli: string;
  deltaMilli: string | null;
  percent: number | null;
}

export interface TrialBalanceRowPayload {
  id: string;
  kind: TrialBalanceRowKind;
  accountId: string | null;
  code: string;
  name: string;
  nameI18n: Readonly<Record<string, string>> | null;
  type: AccountType | null;
  level: number;
  parentId: string | null;
  childIds: readonly string[];
  hasChildren: boolean;
  mergedAccountIds: readonly string[];
  cells: TrialBalanceCellPayload[];
}

export interface TrialBalancePayload {
  key: typeof TRIAL_BALANCE_KEY;
  period: ReportPeriod;
  columns: { from: string; to: string; fyStart: string; kind: 'base' | 'comparison'; index: number }[];
  columnLabels: typeof TRIAL_BALANCE_COLUMN_LABELS;
  currency: string;
  currencyDecimals: number;
  unit: ReportUnit;
  hierarchy: boolean;
  hideZero: boolean;
  search: string;
  searchApplied: boolean;
  postedOnly: boolean;
  includeDrafts: boolean;
  draftMoveCount: number;
  rows: TrialBalanceRowPayload[];
  totals: TrialBalanceCellPayload[];
  visibleTotals: TrialBalanceCellPayload[];
  imbalance: { openingMilli: string; movementMilli: string; endingMilli: string; balanced: boolean }[];
  balanced: boolean;
  lineCount: number;
  unallocatedRowId: string;
}

/**
 * مبلغ الردّ: المقدار نفسه بالملّي نصّاً (`63000000n` ⇐ `'63000000'`) — لا قسمة ولا تقريب ولا فاصلة،
 * فما يقرؤه المصيّر في الواجهة هو رقم المحرّك حرفاً بحرف، وشروط التوازن في §7.2 تبقى قابلة للتحقق.
 */
function milliText(milli: Milli): string {
  return milli.toString();
}

function cellPayload(c: TrialBalanceCell): TrialBalanceCellPayload {
  return {
    openingMilli: milliText(c.openingMilli),
    debitMilli: milliText(c.debitMilli),
    creditMilli: milliText(c.creditMilli),
    endingMilli: milliText(c.endingMilli),
    deltaMilli: c.deltaMilli === null ? null : milliText(c.deltaMilli),
    percent: c.percent,
  };
}

/**
 * يحوّل التقرير إلى ردّ JSON (لا BigInt ولا float في المبالغ) — يستعمله
 * `GET /reports/trial-balance` و`POST /reports/trial-balance/export`.
 */
export function serializeTrialBalance(
  report: TrialBalanceReport,
  opts: TrialBalanceSerializeOptions,
): TrialBalancePayload {
  const unit = report.unit;
  const d = opts.currencyDecimals;
  return {
    key: report.key,
    period: report.period,
    columns: report.columns.map((c) => ({
      from: c.period.from, to: c.period.to, fyStart: c.period.fyStart, kind: c.kind, index: c.index,
    })),
    columnLabels: TRIAL_BALANCE_COLUMN_LABELS,
    currency: opts.currency ?? 'SAR',
    currencyDecimals: d,
    unit,
    hierarchy: report.hierarchy,
    hideZero: report.hideZero,
    search: report.search,
    searchApplied: report.searchApplied,
    postedOnly: report.postedOnly,
    includeDrafts: report.includeDrafts,
    draftMoveCount: report.draftMoveCount,
    rows: report.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      nameI18n: r.nameI18n,
      type: r.type,
      level: r.level,
      parentId: r.parentId,
      childIds: r.childIds,
      hasChildren: r.hasChildren,
      mergedAccountIds: r.mergedAccountIds,
      cells: r.cells.map(cellPayload),
    })),
    totals: report.totals.map(cellPayload),
    visibleTotals: report.visibleTotals.map(cellPayload),
    imbalance: report.imbalance.map((x) => ({
      openingMilli: milliText(x.openingMilli),
      movementMilli: milliText(x.movementMilli),
      endingMilli: milliText(x.endingMilli),
      balanced: x.balanced,
    })),
    balanced: report.balanced,
    lineCount: trialBalanceLineCount(report),
    unallocatedRowId: UNALLOCATED_EARNINGS_ROW_ID,
  };
}
