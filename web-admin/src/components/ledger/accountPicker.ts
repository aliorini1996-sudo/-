import { ledgerName } from '../../lib/ledger/format';
import type { AccountType } from '../../api/ledgerConfig';

/**
 * منطق منتقي الحساب في سطر القيد — دوالّ صرفة بلا React لتُختبر وحدةً (م‑1 وم‑4 من
 * مراجعة الخبير المحاسبي 18 سبتمبر 2026، `docs/accounting/expert-review-2026-09-18.md`).
 *
 * العلّة التي تعالجها: المنتقي كان يعرض بلا كتابة `accounts.slice(0, 50)` مرتّبةً بالرمز،
 * وأول ٥٠ حساباً في القالب السعودي كلها أصول (رموزها تبدأ بـ1) من أصل ١٣٧، فقال الخبير
 * «كل الموجود هنا أصول فقط» وظنّ أن النظام بلا حسابات مصروفات. العلاج هنا:
 * 1. **التجميع بالنوع** (`pickerBuckets`): أوائل **كل** مجموعة لا أوائل الشجرة كلها.
 * 2. **التطبيع العربي** (`normalizeArabic`): الألف والهمزة والتاء المربوطة والتشكيل
 *    والأرقام الهندية و«ال» التعريف — فـ«الوقود» و«وقود» و«ٱلوُقود» سواء.
 * 3. **المطابقة المتساهلة** (`filterAccounts`): كلمات الاستعلام كلّها (AND) في الرمز
 *    أو الاسم بأي لغة أو **الوصف** أو **المرادفات**، مع ترتيبٍ يقدّم مطابقة الرمز.
 *
 * المرادفات (بنزين ⇐ 611003) يملكها القالب في الخادم ويطبّقها بحث `GET /ledger/accounts`؛
 * وتُقبل هنا وسيطاً اختيارياً لا ثابتاً مدفوناً، ويمرّرها المنتقي من `accountSynonyms.ts`
 * (نسخة مرآة يحرس تطابقها مع القالب اختبارُها).
 */

// ═══ مجموعات العرض ═══

/** رؤوس المنتقي الثمانية — بترتيب القوائم المالية كما طلبها الخبير. */
export type AccountGroupKey = 'asset' | 'liability' | 'equity' | 'income' | 'cost' | 'opex' | 'other' | 'system';

export const ACCOUNT_GROUP_ORDER: readonly AccountGroupKey[] = ['asset', 'liability', 'equity', 'income', 'cost', 'opex', 'other', 'system'];

/**
 * أنواع الحسابات العشرون موزّعة على الرؤوس الثمانية — **تغطية تامة بلا تكرار**،
 * يحرسها `accountPicker.test.ts` بمقابلتها بمفاتيح `accountTypeLabels`.
 */
export const ACCOUNT_GROUP_TYPES: Record<AccountGroupKey, readonly AccountType[]> = {
  asset: ['asset_cash', 'asset_receivable', 'asset_current', 'asset_prepayments', 'asset_fixed', 'asset_non_current'],
  liability: ['liability_payable', 'liability_credit_card', 'liability_current', 'liability_non_current'],
  equity: ['equity', 'equity_unaffected'],
  income: ['income', 'income_other'],
  cost: ['expense_direct_cost'],
  opex: ['expense', 'expense_depreciation'],
  other: ['expense_other', 'expense_zakat'],
  system: ['off_balance'],
};

const TYPE_TO_GROUP: ReadonlyMap<string, AccountGroupKey> = new Map(
  ACCOUNT_GROUP_ORDER.flatMap(g => ACCOUNT_GROUP_TYPES[g].map(t => [t as string, g] as const)),
);

/** رأس المجموعة لنوع الحساب؛ النوع غير المعروف يسقط إلى «حسابات النظام» (ويكشفه حارس الاختبار). */
export function accountGroupOf(type: string): AccountGroupKey {
  return TYPE_TO_GROUP.get(type) ?? 'system';
}

/** أنواع مجموعةٍ نصاً مفصولاً بفواصل — وسيط `type` في `GET /ledger/accounts`. */
export function accountTypesOfGroup(group: AccountGroupKey): string {
  return ACCOUNT_GROUP_TYPES[group].join(',');
}

/** تسميات الرؤوس — **بنداءات `tr()` حرفية** (حارس langs.test لا يلتقط `tr(متغير)`). */
export const accountGroupLabels = (tr: (ar: string) => string): Record<AccountGroupKey, string> => ({
  asset: tr('الأصول'),
  liability: tr('الالتزامات'),
  equity: tr('حقوق الملكية'),
  income: tr('الإيرادات'),
  cost: tr('تكلفة الإيرادات'),
  opex: tr('المصروفات التشغيلية'),
  other: tr('مصروفات أخرى وزكاة'),
  system: tr('حسابات النظام'),
});

// ═══ التطبيع العربي ═══

/** التشكيل والتطويل وعلامات الاتجاه — تُحذف قبل المقارنة. */
const MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ​-‏؜]/g;
const AR_DIGITS = /[٠-٩۰-۹]/g;
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * يطبّع نصاً عربياً للمقارنة: حروف صغيرة، بلا تشكيل ولا تطويل، ألف واحدة، «ى»⇒«ي»،
 * «ة»⇒«ه»، الهمزة المفردة تُحذف، الأرقام الهندية تصير لاتينية، وما ليس حرفاً ولا رقماً
 * مسافةٌ واحدة، ثم تُنزع «ال» التعريف من الكلمات الطويلة (٤ أحرف فأكثر) كي لا يختفي
 * اسم قصير مثل «آلة». يُطبَّق على الطرفين معاً فيبقى المطابَقة متّسقة.
 */
export function normalizeArabic(input: string | null | undefined): string {
  if (!input) return '';
  const s = input
    .toLowerCase()
    .replace(MARKS, '')
    .replace(AR_DIGITS, d => String(d.codePointAt(0)! - (d >= '۰' ? 0x06F0 : 0x0660)))
    .replace(/[آأإٱٲٳ]/g, 'ا')
    .replace(/[ىئ]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ء/g, '')
    .replace(/ة/g, 'ه')
    .replace(NON_WORD, ' ')
    .trim();
  if (!s) return '';
  return s.split(' ').filter(Boolean).map(w => (w.length >= 4 && w.startsWith('ال') ? w.slice(2) : w)).join(' ');
}

/** كلمات الاستعلام المطبَّعة (بلا فراغات) — المطابقة تشترطها كلّها. */
export function queryTokens(query: string | null | undefined): string[] {
  const n = normalizeArabic(query);
  return n ? n.split(' ').filter(Boolean) : [];
}

// ═══ المطابقة ═══

/** أقلّ ما يحتاجه المنتقي من الحساب — `GlAccount` يحققه، والاختبار يبني أخفّ منه. */
export interface PickerAccount {
  id: string;
  code: string;
  name: string;
  nameEn?: string | null;
  nameI18n?: Partial<Record<string, string>> | null;
  description?: string | null;
  type: AccountType;
  isActive?: boolean;
}

/** خريطة المرادفات: رمز الحساب ⇒ كلمات بديلة عربية (يصدّرها القالب باسم SA_6D_ACCOUNT_SYNONYMS). */
export type AccountSynonyms = Record<string, readonly string[]>;

/** كل ما يُبحث فيه للحساب مطبَّعاً: الرمز والأسماء بكل اللغات والوصف والمرادفات. */
export function accountSearchText(a: PickerAccount, synonyms?: AccountSynonyms): string {
  const names = [a.name, a.nameEn ?? '', ...Object.values(a.nameI18n ?? {})].filter((x): x is string => !!x);
  return normalizeArabic([a.code, ...names, a.description ?? '', ...(synonyms?.[a.code] ?? [])].join(' '));
}

const byCode = (a: PickerAccount, b: PickerAccount) => a.code.localeCompare(b.code, 'en');

/**
 * رتبة المطابقة (الأصغر أقرب): الرمز تاماً ⇐ بادئة الرمز ⇐ بداية الاسم ⇐ داخل الاسم
 * ⇐ الوصف أو المرادف وحده. فكتابة «6110» تقدّم الحساب على وصفٍ ذكر الرقم عرَضاً.
 */
function matchRank(a: PickerAccount, q: string, lang: string): number {
  const code = a.code.toLowerCase();
  if (code === q) return 0;
  if (code.startsWith(q)) return 1;
  const name = normalizeArabic(ledgerName(a, lang));
  // الاسم المعرَّف («الإيجار») يُقاس كذلك بلا «ال» فلا يُعاقَب أمام «إيجار مدفوع مقدماً» — يطابق ترجيح الخادم
  if (name.startsWith(q) || stripArticle(name).startsWith(q)) return 2;
  if (name.includes(q)) return 3;
  return 4;
}

/** «ال» التعريف في أوّل الكلمة — تُنزع للمقارنة وحدها. */
const stripArticle = (s: string): string => (s.startsWith('ال') && s.length > 3 ? s.slice(2) : s);

/**
 * تطابق تامّ: الاستعلام يساوي الرمز أو أحد أسماء الحساب (بـ«ال» وبدونها) أو أحد مرادفاته.
 * يفصل التساوي في الرتبة قبل الرمز، كما في `backend/src/services/gl/coa/search.ts`
 * (وحارس التطابق في accountPicker.test.ts يمنع افتراق القاعدتين).
 */
function isExactMatch(a: PickerAccount, q: string, synonyms?: AccountSynonyms): boolean {
  if (a.code.toLowerCase() === q) return true;
  const names = [a.name, a.nameEn ?? '', ...Object.values(a.nameI18n ?? {})].filter((x): x is string => !!x);
  for (const n of names) {
    const v = normalizeArabic(n);
    if (v === q || stripArticle(v) === q) return true;
  }
  return (synonyms?.[a.code] ?? []).some(w => {
    const v = normalizeArabic(w);
    return v === q || stripArticle(v) === q;
  });
}

export interface FilterOptions {
  /** لغة العرض — تُستعمل في الترتيب لا في التصفية (التصفية تشمل اللغات كلها) */
  lang?: string;
  synonyms?: AccountSynonyms;
  /** حصر النتائج في رأسٍ واحد */
  group?: AccountGroupKey | null;
  limit?: number;
}

/** أقصى ما يعرضه المنتقي المنسدل دفعةً (وما فوقه في نافذة «عرض المزيد»). */
export const MAX_INLINE_MATCHES = 50;
/** أوائل كل رأس في العرض المجمَّع بلا بحث. */
export const DEFAULT_PER_GROUP = 6;

/**
 * تصفية الحسابات باستعلامٍ متساهل: كلمات الاستعلام كلّها (AND) داخل نصّ البحث المطبَّع،
 * ثم الترتيب بالرتبة فالرمز. الاستعلام الفارغ ⇒ القائمة مرتّبةً بالرمز (مع حدّ `limit`).
 */
export function filterAccounts<T extends PickerAccount>(accounts: readonly T[], query: string, opts: FilterOptions = {}): T[] {
  const { lang = 'ar', synonyms, group = null, limit = MAX_INLINE_MATCHES } = opts;
  const pool = group ? accounts.filter(a => accountGroupOf(a.type) === group) : accounts;
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [...pool].sort(byCode).slice(0, limit);
  const q = tokens.join(' ');
  const hits: { a: T; rank: number; exact: boolean }[] = [];
  for (const a of pool) {
    const hay = accountSearchText(a, synonyms);
    if (!tokens.every(t => hay.includes(t))) continue;
    hits.push({ a, rank: matchRank(a, q, lang), exact: isExactMatch(a, q, synonyms) });
  }
  // نوع أفضل تطابق تامّ يرجّح أنداده: «مرتبات» تُصدِّر حسابَي المصروف على التزام الرواتب المستحقّة
  const bestExact = hits.filter(h => h.exact).sort((x, y) => byCode(x.a, y.a))[0];
  const nearType = (h: { a: T }) => (bestExact && h.a.type === bestExact.a.type ? 0 : 1);
  hits.sort((x, y) => x.rank - y.rank || Number(y.exact) - Number(x.exact) || nearType(x) - nearType(y) || byCode(x.a, y.a));
  return hits.map(h => h.a).slice(0, limit);
}

/** عدد حسابات كل رأس — لشريط الفلاتر (الرأس الفارغ لا يُعرض). */
export function countByGroup(accounts: readonly PickerAccount[]): Record<AccountGroupKey, number> {
  const out = Object.fromEntries(ACCOUNT_GROUP_ORDER.map(g => [g, 0])) as Record<AccountGroupKey, number>;
  for (const a of accounts) out[accountGroupOf(a.type)]++;
  return out;
}

export interface AccountBucket<T> {
  key: AccountGroupKey;
  /** كل حسابات الرأس (لا المعروض منها) — لعدّاد «يُعرض ن من م» */
  total: number;
  items: T[];
}

export interface BucketOptions {
  /** رأسٌ محدَّد من شريط الفلاتر ⇒ سلّة واحدة موسَّعة */
  group?: AccountGroupKey | null;
  /** أوائل كل رأس في العرض المجمَّع */
  perGroup?: number;
  /** سقف السلّة الواحدة حين يُختار رأس */
  groupLimit?: number;
}

/**
 * سلال العرض بلا بحث: بلا رأسٍ محدَّد ⇒ كل رأس موجود بأوائله (فترى المصروفات من أول
 * نظرة)، ومع رأسٍ محدَّد ⇒ سلّة واحدة بسقفٍ أوسع. الرؤوس الفارغة تُحذف.
 */
export function pickerBuckets<T extends PickerAccount>(accounts: readonly T[], opts: BucketOptions = {}): AccountBucket<T>[] {
  const { group = null, perGroup = DEFAULT_PER_GROUP, groupLimit = MAX_INLINE_MATCHES } = opts;
  const sorted = [...accounts].sort(byCode);
  if (group) {
    const items = sorted.filter(a => accountGroupOf(a.type) === group);
    return items.length ? [{ key: group, total: items.length, items: items.slice(0, groupLimit) }] : [];
  }
  const out: AccountBucket<T>[] = [];
  for (const key of ACCOUNT_GROUP_ORDER) {
    const items = sorted.filter(a => accountGroupOf(a.type) === key);
    if (items.length) out.push({ key, total: items.length, items: items.slice(0, perGroup) });
  }
  return out;
}

/** صفّ السلال في قائمة واحدة — ترتيب التنقّل بالسهام. */
export function flattenBuckets<T>(buckets: readonly AccountBucket<T>[]): T[] {
  return buckets.flatMap(b => b.items);
}

/**
 * صفّ عرضٍ في القائمة المنسدلة: رأس مجموعة (غير قابل للاختيار) أو حساب بفهرس تنقّله.
 * الفهرس يعدّ الحسابات وحدها فتبقى السهام تقفز بين الحسابات لا بين الرؤوس.
 */
export type PickerRow<T> =
  | { kind: 'head'; key: AccountGroupKey; total: number }
  | { kind: 'item'; account: T; index: number };

/** صفوف العرض المجمَّع: رأسٌ ثم حساباته، لكل سلّة. */
export function pickerRows<T extends PickerAccount>(buckets: readonly AccountBucket<T>[]): PickerRow<T>[] {
  const out: PickerRow<T>[] = [];
  let index = 0;
  for (const b of buckets) {
    out.push({ kind: 'head', key: b.key, total: b.total });
    for (const account of b.items) out.push({ kind: 'item', account, index: index++ });
  }
  return out;
}

/** صفوف نتائج البحث — بلا رؤوس (القائمة مسطّحة كما في أودو). */
export function flatRows<T extends PickerAccount>(items: readonly T[]): PickerRow<T>[] {
  return items.map((account, index) => ({ kind: 'item', account, index }));
}

/** يعوّض عناصر نصٍّ مترجَم — `tr('يُعرض {shown} من {total} حساباً')`. */
export function fillCount(template: string, values: Record<string, number | string>): string {
  return Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), template);
}
