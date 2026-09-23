/**
 * دفتر الأستاذ العام (M4، DESIGN.md §7.5 ORPT‑02، §7.1 «الأداء» و«التصدير»).
 *
 * **صرفة تماماً**: تستقبل حسابات وأرصدة مُجمَّعة (من `composeBalances`) وسطوراً، وتُعيد أقساماً
 * جاهزة للعرض — بلا prisma وبلا I/O. قراءة السطور في طبقة رقيقة منفصلة (`routes/ledger/reports.ts`،
 * دالة `loadLedgerLines`)، كما أنّ أرصدة الافتتاح تأتي من `reports/load.ts` + `reports/balances.ts`.
 *
 * لكل حساب (§7.5): صفّ افتتاحي بقاعدة الافتتاح في الميزان (§7.2)، ثم السطور بترتيب التاريخ
 * بأعمدة: التاريخ، الرقم، الدفتر، الشريك، المندوب، البيان، مدين، دائن، **رصيد جارٍ مشتق**، ثم الإجمالي.
 *
 * **الترقيم (§7.1):** 500 سطر لكل حساب **في العرض وحده**؛ التصدير يمرّ بـ`pageSize: null` فيأخذ
 * كل السطور بلا ترقيم ولا طيّ. الرصيد الجاري يُحسب على **كل** سطور الفترة ثم تُقتطع الصفحة، فلا
 * يتغيّر رقمٌ بتغيّر الصفحة، وكل صفحة تحمل **«رصيد مُرحَّل»** (`carriedForwardMilli`) = الرصيد الجاري
 * قبل أول سطر فيها (هو نفسه الافتتاحي في الصفحة الأولى)، وهو ما يكرّره PDF أعلى كل صفحة.
 *
 * **بنود قيد إقفال السنة (`moveType='FY_CLOSING'`) — قاعدة §7.2 حرفياً**: سطورٌ حقيقية على الحساب،
 * فتظهر دائماً في دفتر الأستاذ موسومة `closing:true` (لا يجوز أن يخفي دفتر الأستاذ قيداً مرحّلاً على
 * الحساب). أمّا أثرها في الأرقام فبقاعدة الميزان نفسها لا بغيرها، وإلا تناقض التقريران:
 * - **حسابات قائمة الدخل** (`income*`/`expense*`): «لا تدخل قسمها ولا افتتاحه، بل تُعرض في صف
 *   أرباح سنوات سابقة» (§7.2). فتُفصَل هنا كما تُفصَل هناك: `excluded:true` على السطر، والرصيد
 *   الجاري لا يتحرّك عنده، ومجاميعها في `closingDebitMilli`/`closingCreditMilli`/`closingMilli`
 *   صفَّ إقفالٍ مستقلاً تعرضه الواجهة تحت الحساب («منقول إلى أرباح سنوات سابقة»).
 * - **حسابات الميزانية** (313001 وغيره): «تبقى في صف حسابها» (§7.2)، فتدخل الافتتاح والحركة
 *   والرصيد الجاري كأي سطر.
 *
 * ولذلك `endingMilli` هنا = `accountEndingMilli(balance, type)` في ميزان المراجعة **بالملّي**،
 * و`openingMilli` = افتتاحُ الميزان نفسه. والرقم «الفعلي» للحساب بضمّ الإقفال باقٍ معروضاً في
 * `openingBalanceMilli`/`endingBalanceMilli` فلا يضيع على من يريد رصيد 411001 بعد إقفاله (صفراً).
 *
 * **فلتر الشركاء (§7.5)**: يُطبَّق على السطور في طبقة القراءة. إن لم يُطبَّق على الأرصدة أيضاً
 * (‏`partners` في `reports/load.ts`) فالافتتاح والرصيد الجاري والإجمالي للحساب كلّه لا للشريك،
 * وهذا **لا يمرّ صامتاً**: يعلنه `openingScope` ويرفع تنبيه `PARTNER_FILTER_OPENING_IGNORED`.
 *
 * **المُزاح (ADR‑7)**: السطر يُعرض بتاريخ قيده مع `shifted:true` و`originalDate`، كما في §7.6.
 *
 * **عقد المبالغ**: كل مبلغ يخرج من هنا **ملّي صحيح** (BigInt) تحت مفتاح ينتهي بـ`Milli` — بلا
 * تنسيق ولا تقريب ولا وحدة عرض؛ الوحدة (`unit`) ومنازل العملة شأن الواجهة (§7.1 RPT‑06).
 */
import { compareLocalDate } from '../dates';
import type { AccountType, LocalDate, Milli } from '../types';
import { isProfitLossType, matchesAccountSearch } from './balances';
import type { AccountBalance, ReportAccount, ReportPeriod } from './types';

/** ترقيم العرض: 500 سطر لكل حساب (§7.1). التصدير يتجاوزه بـ`pageSize: null`. */
export const GENERAL_LEDGER_PAGE_SIZE = 500;

/** لا تقبل الواجهة صفحةً أكبر من ترقيم العرض (حماية من طلب صفحة ضخمة بدل التصدير). */
export const GENERAL_LEDGER_MAX_PAGE_SIZE = GENERAL_LEDGER_PAGE_SIZE;

/**
 * سطر أستاذ كما تقرأه الطبقة الرقيقة (أعمدة §7.5 وحدها، لا صفّ `GlMoveLine` كاملاً).
 * `partnerId` عميلٌ أو مورّد، و`partnerName` لقطة الاسم المخزَّنة في السطر أو اسم الشريك.
 */
export interface LedgerLineInput {
  id: string;
  moveId: string;
  accountId: string;
  /** التاريخ المحاسبي للقيد (ADR‑7: قد يخالف `originalDate`) */
  date: LocalDate;
  originalDate: LocalDate | null;
  lateArrival: boolean;
  seq: number;
  moveNumber: string | null;
  /** 'DRAFT' | 'POSTED' */
  moveState: string;
  moveType: string;
  journalId: string;
  journalCode: string | null;
  journalName: string | null;
  partnerId: string | null;
  partnerName: string | null;
  salesRepId: string | null;
  salesRepName: string | null;
  analyticAccountId: string | null;
  label: string | null;
  debitMilli: Milli;
  creditMilli: Milli;
}

/** سطر بعد الاشتقاق: الرصيد الجارٍ ووسما المسودة والإقفال والإزاحة. */
export interface GeneralLedgerRow extends LedgerLineInput {
  /**
   * الرصيد الجارٍ بعد هذا السطر = الافتتاحي + Σ(مدين − دائن) للسطور المحتسَبة حتى هنا.
   * على سطر `excluded` يبقى كما كان (السطر معروض ولا أثر له في رصيد الحساب في هذا التقرير).
   */
  runningMilli: Milli;
  draft: boolean;
  closing: boolean;
  /**
   * بند إقفال **مفصول** عن أرقام القسم بقاعدة §7.2 (حسابات قائمة الدخل وحدها): معروضٌ وموسوم،
   * ومبلغه في صفّ الإقفال أسفل الحساب لا في حركته. `false` لكل سطر آخر.
   */
  excluded: boolean;
  /** ADR‑7: تاريخ القيد يخالف تاريخ الأثر */
  shifted: boolean;
}

export interface GeneralLedgerSection {
  account: ReportAccount;
  /**
   * الافتتاحي بقاعدة الميزان §7.2 — وهو **بذرة الرصيد الجاري**:
   * قائمة الدخل = حركة [fyStart, from) بلا بنود الإقفال، والميزانية = كل ما قبل `from` ومعه إقفاله.
   */
  openingMilli: Milli;
  /** صافي بنود الإقفال قبل `from` (§7.1 المصدر 4) — داخل `openingMilli` لحسابات الميزانية وحدها */
  closingOpeningMilli: Milli;
  /** رصيد الحساب الفعلي قبل `from` بضمّ بنود إقفاله السابقة (يساوي `openingMilli` لحسابات الميزانية) */
  openingBalanceMilli: Milli;
  /** إجمالي مدين سطور الفترة **المحتسَبة** (كلها لا الصفحة؛ بلا بنود الإقفال المفصولة) */
  debitMilli: Milli;
  /** إجمالي دائن سطور الفترة المحتسَبة */
  creditMilli: Milli;
  /** هل فُصلت بنود الإقفال عن الحركة؟ (حسابات قائمة الدخل، §7.2) */
  closingExcluded: boolean;
  /** إجمالي مدين بنود الإقفال المفصولة داخل الفترة (صفر حين لا فصل) */
  closingDebitMilli: Milli;
  /** إجمالي دائن بنود الإقفال المفصولة داخل الفترة */
  closingCreditMilli: Milli;
  /** صافي بنود الإقفال المفصولة داخل الفترة = مدينها − دائنها (صفّ «منقول إلى أرباح سنوات سابقة») */
  closingMilli: Milli;
  /** الإجمالي بقاعدة الميزان = الافتتاحي + مدين − دائن (= `accountEndingMilli` في `trialBalance.ts`) */
  endingMilli: Milli;
  /** رصيد الحساب الفعلي بعد `to` بضمّ كل بنود إقفاله = `openingBalanceMilli` + كل المعروض */
  endingBalanceMilli: Milli;
  /** عدد سطور الفترة كلها قبل الترقيم (ومنها بنود الإقفال المعروضة) */
  lineCount: number;
  /** رقم الصفحة (1 فما فوق؛ 1 دائماً بلا ترقيم) */
  page: number;
  /** حجم الصفحة، و`null` بلا ترقيم (التصدير) */
  pageSize: number | null;
  /** عدد الصفحات (1 على الأقل) */
  pageCount: number;
  /** إزاحة أول سطر معروض */
  offset: number;
  /** **رصيد مُرحَّل**: الرصيد الجاري قبل أول سطر في هذه الصفحة (يكرَّر أعلى كل صفحة PDF، §7.1) */
  carriedForwardMilli: Milli;
  /** الرصيد الجاري بعد آخر سطر معروض */
  carriedOutMilli: Milli;
  hasMore: boolean;
  lines: GeneralLedgerRow[];
}

export interface GeneralLedgerTotals {
  accountCount: number;
  /** Σ الافتتاحي بقاعدة الميزان (قابل للمقارنة بـΣ افتتاحي الميزان على الحسابات نفسها) */
  openingMilli: Milli;
  debitMilli: Milli;
  creditMilli: Milli;
  /** Σ بنود الإقفال المفصولة داخل الفترة (ما ينتقل إلى صف «أرباح سنوات سابقة» في الميزان) */
  closingMilli: Milli;
  endingMilli: Milli;
  /** Σ رصيد الحسابات الفعلي قبل/بعد الفترة بضمّ بنود الإقفال */
  openingBalanceMilli: Milli;
  endingBalanceMilli: Milli;
  /** مجموع سطور كل الحسابات قبل الترقيم — سقفا التصدير يُقاسان عليه */
  lineCount: number;
  /** المعروض فعلاً بعد الترقيم (= lineCount بلا ترقيم) */
  displayedLineCount: number;
}

/** نطاق الأرصدة الافتتاحية التي بُني عليها التقرير (يعلنه المستدعي، فلا يُخمَّن هنا). */
export type GeneralLedgerOpeningScope =
  /** الأرصدة للحساب كلّه (لم يُمرَّر فلتر الشركاء إلى طبقة القراءة) */
  | 'account'
  /** الأرصدة مفلترة بالشركاء أنفسهم الذين فُلترت بهم السطور */
  | 'partners';

/** تنبيه من المحرّك الصرف، بالشكل الذي تنشره النقطة في `warnings` (§7.1 RPT‑08). */
export interface GeneralLedgerWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** فلتر شركاء مطبَّق على السطور وأرصدته للحساب كلّه — لا إسقاط صامت (§7.5). */
export const PARTNER_FILTER_OPENING_IGNORED = 'PARTNER_FILTER_OPENING_IGNORED';

export const PARTNER_FILTER_OPENING_MESSAGE =
  'فلتر الشركاء طُبّق على السطور وحدها: الرصيد الافتتاحي والرصيد الجاري والإجمالي محسوبة للحساب كلّه';

export interface GeneralLedgerResult {
  period: ReportPeriod;
  sections: GeneralLedgerSection[];
  totals: GeneralLedgerTotals;
  /** ترقيم مطبَّق؟ (`false` في التصدير) */
  paginated: boolean;
  pageSize: number | null;
  page: number;
  /** فلتر الشركاء المطبَّق على السطور (فارغ بلا فلتر) */
  partners: readonly string[];
  /** نطاق الأرصدة الافتتاحية كما أعلنه المستدعي */
  openingScope: GeneralLedgerOpeningScope;
  /** تنبيهات المحرّك — تنشرها النقطة مع تنبيهات RPT‑08 */
  warnings: GeneralLedgerWarning[];
}

export interface GeneralLedgerOptions {
  /** حجم صفحة العرض؛ `null` ⇒ بلا ترقيم (التصدير، §7.1) */
  pageSize?: number | null;
  /** رقم الصفحة (1 فما فوق) */
  page?: number;
  /** RPT‑07/14: إخفاء حساب بلا سطور ورصيده صفر */
  hideZero?: boolean;
  /** RPT‑15: بحث على رمز الحساب واسمه */
  search?: string;
  /** فلتر الشركاء الذي فُلترت به السطور (§7.5) */
  partners?: readonly string[];
  /**
   * نطاق `balances` الممرَّرة. الافتراض `'account'` (المحافظ): مع فلتر شركاء يرفع تنبيهاً صريحاً.
   * يُعلَن `'partners'` حين تُمرَّر `partners` إلى `loadBalanceSources` أيضاً فيصير الافتتاح مفلتراً.
   */
  openingScope?: GeneralLedgerOpeningScope;
}

export interface BuildGeneralLedgerInput {
  period: ReportPeriod;
  /** الحسابات المطلوبة (مرتّبة برمزها كما تعيدها `loadReportAccounts`) */
  accounts: readonly ReportAccount[];
  /** أرصدة `composeBalances` لهذه الحسابات — مصدر الافتتاحي وحده */
  balances: readonly AccountBalance[];
  /** سطور [from, to] بعد الفلاتر (غير مرتّبة) */
  lines: readonly LedgerLineInput[];
  options?: GeneralLedgerOptions;
}

const isDraft = (l: LedgerLineInput): boolean => l.moveState === 'DRAFT';
const isClosing = (l: LedgerLineInput): boolean => l.moveType === 'FY_CLOSING';

// ═══ قاعدة §7.2 في دالّة واحدة (كل طبقة تبني أقسام أستاذ تستدعيها، فلا يتفرّق رقمان) ═══

/**
 * هل تُفصَل بنود قيد الإقفال عن أرقام هذا الحساب؟ (§7.2)
 * حسابات قائمة الدخل: نعم — تُعرض في صف «أرباح سنوات سابقة» في الميزان، وفي صفّ إقفال هنا.
 * حسابات الميزانية (313001): لا — تبقى في صف حسابها.
 */
export function separatesClosing(type: AccountType | string): boolean {
  return isProfitLossType(type);
}

/** افتتاح قسم الأستاذ بقاعدة §7.2 (وهو بذرة الرصيد الجاري)، ومعه رصيد الحساب الفعلي قبل `from`. */
export interface GeneralLedgerOpening {
  closingExcluded: boolean;
  /** افتتاح الميزان = بذرة الرصيد الجاري */
  openingMilli: Milli;
  /** رصيد الحساب الفعلي قبل `from` بضمّ بنود إقفاله السابقة */
  openingBalanceMilli: Milli;
  closingOpeningMilli: Milli;
}

/**
 * الافتتاح بقاعدة §7.2 لحساب واحد. صرفة.
 * الرصيد الغائب يُقرأ صفراً (حساب بلا حركة قبل الفترة).
 */
export function generalLedgerOpening(
  type: AccountType | string,
  balance: Pick<AccountBalance, 'openingMilli' | 'closingOpeningMilli'> | undefined,
): GeneralLedgerOpening {
  const accountOpeningMilli = balance?.openingMilli ?? 0n;
  const closingOpeningMilli = balance?.closingOpeningMilli ?? 0n;
  const closingExcluded = separatesClosing(type);
  return {
    closingExcluded,
    openingMilli: closingExcluded ? accountOpeningMilli : accountOpeningMilli + closingOpeningMilli,
    openingBalanceMilli: accountOpeningMilli + closingOpeningMilli,
    closingOpeningMilli,
  };
}

/**
 * صفّ العرض من سطر: الوسوم والرصيد الجاري بعده. `runningBefore` هو الرصيد الجاري قبل السطر،
 * ولا يتحرّك على سطر إقفال مفصول (يبقى معروضاً وموسوماً `excluded`).
 */
export function generalLedgerRow(
  l: LedgerLineInput,
  runningBefore: Milli,
  closingExcluded: boolean,
): GeneralLedgerRow {
  const closing = isClosing(l);
  const excluded = closing && closingExcluded;
  return {
    ...l,
    runningMilli: excluded ? runningBefore : runningBefore + l.debitMilli - l.creditMilli,
    draft: isDraft(l),
    closing,
    excluded,
    shifted: isShiftedLine(l),
  };
}

/** إزاحة ADR‑7: تاريخ القيد يخالف تاريخ الأثر الأصلي. */
export function isShiftedLine(l: LedgerLineInput): boolean {
  return l.originalDate !== null && l.originalDate !== l.date;
}

/**
 * ترتيب سطور الأستاذ: التاريخ، ثم رقم القيد (المسودة بلا رقم تأتي بعد المرقَّمة في اليوم نفسه)،
 * ثم القيد، ثم تسلسل السطر، ثم المعرّف. حتمي تماماً فلا يختلف الترقيم بين طلبين.
 */
export function compareLedgerLines(a: LedgerLineInput, b: LedgerLineInput): number {
  const d = compareLocalDate(a.date, b.date);
  if (d !== 0) return d;
  const an = a.moveNumber;
  const bn = b.moveNumber;
  if (an !== bn) {
    if (an === null) return 1;
    if (bn === null) return -1;
    return an < bn ? -1 : 1;
  }
  if (a.moveId !== b.moveId) return a.moveId < b.moveId ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** نسخة مرتّبة من السطور (لا تعدّل المدخل). */
export function sortLedgerLines(lines: readonly LedgerLineInput[]): LedgerLineInput[] {
  return [...lines].sort(compareLedgerLines);
}

/**
 * حجم صفحة صالح: 1..500، و`null` **وحده** يعني «بلا ترقيم» (التصدير).
 * صفرٌ أو سالبٌ أو غير رقم من العميل يعود إلى ترقيم العرض، فلا يتسلّل طلبُ عرضٍ بلا ترقيم.
 */
export function normalizePageSize(v: number | null | undefined): number | null {
  if (v === null) return null;
  if (v === undefined || !Number.isFinite(v)) return GENERAL_LEDGER_PAGE_SIZE;
  const n = Math.trunc(v);
  if (n <= 0) return GENERAL_LEDGER_PAGE_SIZE;
  return Math.min(n, GENERAL_LEDGER_MAX_PAGE_SIZE);
}

/** رقم صفحة صالح (1 فما فوق). */
export function normalizePage(v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return 1;
  return Math.max(1, Math.trunc(v));
}

/**
 * يبني أقسام دفتر الأستاذ العام. صرفة وحتمية.
 *
 * حراس (أخطاء برمجية لا أخطاء مستخدم):
 * - سطر على حساب غير موجود في `accounts` ⇒ خطأ (القسم يحتاج نوع الحساب ورمزه).
 * - سطر خارج `[period.from, period.to]` ⇒ خطأ (الطبقة الرقيقة تقرأ المدى وحده؛ ما قبله في الافتتاحي).
 */
export function buildGeneralLedger(input: BuildGeneralLedgerInput): GeneralLedgerResult {
  const { period, accounts, balances, lines } = input;
  const opts = input.options ?? {};
  const pageSize = normalizePageSize(opts.pageSize);
  const page = normalizePage(opts.page);
  const search = typeof opts.search === 'string' ? opts.search.trim() : '';

  const accountById = new Map<string, ReportAccount>();
  for (const a of accounts) accountById.set(a.id, a);
  const balanceById = new Map<string, AccountBalance>();
  for (const b of balances) balanceById.set(b.accountId, b);

  const byAccount = new Map<string, LedgerLineInput[]>();
  for (const line of lines) {
    if (!accountById.has(line.accountId)) {
      throw new Error(`buildGeneralLedger: سطر على حساب غير مطلوب: ${line.accountId}`);
    }
    if (compareLocalDate(line.date, period.from) < 0 || compareLocalDate(line.date, period.to) > 0) {
      throw new Error(`buildGeneralLedger: سطر بتاريخ ${line.date} خارج الفترة [${period.from}, ${period.to}]`);
    }
    const bucket = byAccount.get(line.accountId);
    if (bucket) bucket.push(line);
    else byAccount.set(line.accountId, [line]);
  }

  const sections: GeneralLedgerSection[] = [];
  const totals: GeneralLedgerTotals = {
    accountCount: 0, openingMilli: 0n, debitMilli: 0n, creditMilli: 0n, closingMilli: 0n, endingMilli: 0n,
    openingBalanceMilli: 0n, endingBalanceMilli: 0n, lineCount: 0, displayedLineCount: 0,
  };

  for (const account of accounts) {
    if (search && !matchesAccountSearch(account, search)) continue;
    // §7.2: بنود الإقفال تُفصَل عن حسابات قائمة الدخل وتبقى في صف حسابات الميزانية
    const { closingExcluded, openingMilli, openingBalanceMilli, closingOpeningMilli } =
      generalLedgerOpening(account.type, balanceById.get(account.id));
    const accountLines = sortLedgerLines(byAccount.get(account.id) ?? []);

    let debitMilli = 0n;
    let creditMilli = 0n;
    let closingDebitMilli = 0n;
    let closingCreditMilli = 0n;
    let running = openingMilli;
    const rows: GeneralLedgerRow[] = accountLines.map((l) => {
      const r = generalLedgerRow(l, running, closingExcluded);
      if (r.excluded) {
        closingDebitMilli += l.debitMilli;
        closingCreditMilli += l.creditMilli;
      } else {
        debitMilli += l.debitMilli;
        creditMilli += l.creditMilli;
      }
      running = r.runningMilli;
      return r;
    });

    const closingMilli = closingDebitMilli - closingCreditMilli;
    const endingMilli = openingMilli + debitMilli - creditMilli;
    const endingBalanceMilli = openingBalanceMilli + debitMilli - creditMilli + closingMilli;
    const lineCount = rows.length;
    if (
      opts.hideZero === true && lineCount === 0
      && openingMilli === 0n && endingMilli === 0n
      && openingBalanceMilli === 0n && endingBalanceMilli === 0n
    ) continue;

    const pageCount = pageSize === null ? 1 : Math.max(1, Math.ceil(lineCount / pageSize));
    const effectivePage = pageSize === null ? 1 : Math.min(page, pageCount);
    const offset = pageSize === null ? 0 : (effectivePage - 1) * pageSize;
    const slice = pageSize === null ? rows : rows.slice(offset, offset + pageSize);
    const carriedForwardMilli = offset === 0 ? openingMilli : rows[offset - 1].runningMilli;
    const carriedOutMilli = slice.length > 0 ? slice[slice.length - 1].runningMilli : carriedForwardMilli;

    sections.push({
      account,
      openingMilli,
      closingOpeningMilli,
      openingBalanceMilli,
      debitMilli,
      creditMilli,
      closingExcluded,
      closingDebitMilli,
      closingCreditMilli,
      closingMilli,
      endingMilli,
      endingBalanceMilli,
      lineCount,
      page: effectivePage,
      pageSize,
      pageCount,
      offset,
      carriedForwardMilli,
      carriedOutMilli,
      hasMore: pageSize !== null && offset + slice.length < lineCount,
      lines: slice,
    });

    totals.accountCount += 1;
    totals.openingMilli += openingMilli;
    totals.debitMilli += debitMilli;
    totals.creditMilli += creditMilli;
    totals.closingMilli += closingMilli;
    totals.endingMilli += endingMilli;
    totals.openingBalanceMilli += openingBalanceMilli;
    totals.endingBalanceMilli += endingBalanceMilli;
    totals.lineCount += lineCount;
    totals.displayedLineCount += slice.length;
  }

  const partners = opts.partners && opts.partners.length > 0 ? [...opts.partners] : [];
  const openingScope: GeneralLedgerOpeningScope = opts.openingScope === 'partners' ? 'partners' : 'account';
  const warnings: GeneralLedgerWarning[] = [];
  if (partners.length > 0 && openingScope !== 'partners') {
    warnings.push({
      code: PARTNER_FILTER_OPENING_IGNORED,
      message: PARTNER_FILTER_OPENING_MESSAGE,
      details: { partners },
    });
  }

  return {
    period, sections, totals, paginated: pageSize !== null, pageSize, page, partners, openingScope, warnings,
  };
}

/** عدد سطور المجموعة كاملةً قبل الترقيم — ما يُقاس عليه سقفا التصدير (§7.1). */
export function generalLedgerExportLines(result: GeneralLedgerResult): number {
  // صفّ افتتاحي + صفّ إجمالي لكل حساب، مع سطوره: هذا ما يكتبه الملف فعلاً
  return result.totals.lineCount + result.sections.length * 2;
}

/** مسار التعمّق من مبلغ في تقرير إلى دفتر الأستاذ (§7.1 «التعمّق»). */
export function generalLedgerDrilldownPath(accountId: string, period: { from: LocalDate; to: LocalDate }): string {
  const q = new URLSearchParams({ accounts: accountId, mode: 'custom', from: period.from, to: period.to });
  return `/app/ledger/reports/general-ledger?${q.toString()}`;
}
