/**
 * بحث شجرة الحسابات (مراجعة الخبير م‑1 وم‑4، DESIGN.md §4.2، §8.2 تبويب «الحسابات»).
 *
 * دوال صرفة بلا I/O ولا قاعدة: يستعملها `GET /ledger/accounts` بعد جلب المرشّحين، ويستعملها
 * بحث الواجهة نفسه، فيتطابق ما يراه المحاسب في المنتقي مع ما يعيده الخادم.
 *
 * لماذا في الذاكرة لا في SQL: التطبيع العربي (الألف والهمزة والتاء المربوطة والتشكيل و«ال»
 * التعريف) لا يقدر عليه `contains` في Postgres على النصّ المخزَّن كما هو، فلا تطابق «الايجار»
 * حسابَ «الإيجار». والشجرة ١٣٧ حساباً للشركة (بسقف `ACCOUNT_SEARCH_SCAN_LIMIT` في المسار)،
 * فالمسح والترتيب في الذاكرة أرخص من دوالّ قاعدة وفهارس خاصة.
 *
 * المرادفات: مصدرها القالب (`SA_6D_ACCOUNT_SYNONYMS`: رمز الحساب ⇒ كلمات المحاسب البديلة مثل
 * «بنزين» لـ611003). تُقرأ قراءةً مرنة كي لا يرتبط هذا الملف بلحظة إضافتها إلى القالب.
 */
import * as saTemplate from './sa';

export type SynonymMap = Readonly<Record<string, readonly string[]>>;

/** مرادفات القالب — `{}` ما لم يُصدّرها القالب بعد. */
export const ACCOUNT_SYNONYMS: SynonymMap =
  ((saTemplate as unknown as Record<string, unknown>).SA_6D_ACCOUNT_SYNONYMS as SynonymMap | undefined) ?? {};

// ═══ التطبيع العربي ═══

/** التشكيل والعلامات فوق الحروف وتحتها (§ لا أثر لها في البحث). */
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
/** التطويل ـــ */
const TATWEEL = /ـ/g;
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * تطبيع نصّ للبحث: تشكيل وتطويل يُحذفان، الألف بأشكالها ⇒ ا، الهمزات ⇒ حروفها، ى ⇒ ي،
 * ة ⇒ ه، الأرقام العربية‑الهندية والفارسية ⇒ لاتينية، الأحرف اللاتينية صغيرة، وكل ما ليس
 * حرفاً ولا رقماً يصير فراغاً واحداً.
 */
export function normalizeArabicSearch(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKC')
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) & 0x0f))
    .replace(/[أإآٱٲٳ]/g, 'ا') // أ إ آ ٱ ⇒ ا
    .replace(/ؤ/g, 'و')                                  // ؤ ⇒ و
    .replace(/[ئى]/g, 'ي')                          // ئ ى ⇒ ي
    .replace(/ة/g, 'ه')                                  // ة ⇒ ه
    .replace(/ء/g, '')                                        // ء تُحذف
    .toLowerCase()
    .replace(NON_WORD, ' ')
    .trim();
}

/** «الإيجار» و«إيجار» سواء: تُنزع «ال» من أول الكلمة إن بقي بعدها حرفان فأكثر. */
export function stripDefiniteArticle(token: string): string {
  return token.startsWith('ال') && token.length >= 4 ? token.slice(2) : token;
}

/**
 * كلمات البحث: كل كلمة تعطي احتمالاتها (بـ«ال» وبدونها). الحساب يطابق البحث إذا طابق
 * **كل** كلماته (AND) — «وقود سيارات» لا تعيد كل ما فيه «وقود».
 */
export function searchNeedles(query: string | null | undefined): string[][] {
  const norm = normalizeArabicSearch(query);
  if (!norm) return [];
  return norm.split(' ').filter(Boolean).map((tok) => {
    const bare = stripDefiniteArticle(tok);
    return bare === tok ? [tok] : [tok, bare];
  });
}

// ═══ الترتيب بالصلة ═══

/**
 * مراتب المطابقة (شكوى الخبير: الترتيب بالرمز وحده يجعل الأصول دائماً في الصدارة).
 * الأعلى أولاً: الرمز، ثم بداية الاسم، ثم الاسم، ثم المرادف، ثم الوصف.
 */
export const ACCOUNT_SEARCH_RANK = {
  CODE_EXACT: 100,
  CODE_PREFIX: 90,
  CODE_CONTAINS: 80,
  NAME_PREFIX: 70,
  NAME_CONTAINS: 60,
  SYNONYM: 40,
  DESCRIPTION: 30,
  NONE: 0,
} as const;

export interface SearchableAccount {
  code: string;
  name: string;
  nameEn?: string | null;
  /** `{ar,en,fr,tr,zh}` من القالب — أي قيمة نصّية فيه تدخل البحث */
  nameI18n?: unknown;
  description?: string | null;
  /** نوع الحساب — لا يدخل المطابقة، يُرجِّح عند تساوي الدرجة وحده (انظر `rankAccounts`) */
  type?: string | null;
}

/** أسماء الحساب بكل اللغات المتاحة (العربي والإنجليزي وقيم nameI18n النصّية). */
export function accountNameStrings(a: SearchableAccount): string[] {
  const out = [a.name, a.nameEn ?? ''];
  const i18n = a.nameI18n;
  if (i18n && typeof i18n === 'object' && !Array.isArray(i18n)) {
    for (const v of Object.values(i18n as Record<string, unknown>)) if (typeof v === 'string') out.push(v);
  }
  return out.filter(Boolean);
}

const synCache = new WeakMap<object, Map<string, string[]>>();

/** المرادفات مطبَّعة مرة واحدة لكل خريطة (الخريطة ثابتة، فالتخزين آمن). */
function normalizedSynonyms(map: SynonymMap): Map<string, string[]> {
  const cached = synCache.get(map as object);
  if (cached) return cached;
  const built = new Map<string, string[]>();
  for (const [code, words] of Object.entries(map)) {
    const norm = (words ?? []).map((w) => normalizeArabicSearch(w)).filter(Boolean);
    if (norm.length) built.set(code, norm);
  }
  synCache.set(map as object, built);
  return built;
}

/** رموز الحسابات التي تطابق كلمةً بمرادفاتها — «بنزين» ⇒ {611003}. */
export function synonymCodesFor(query: string, synonyms: SynonymMap = ACCOUNT_SYNONYMS): Set<string> {
  const needles = searchNeedles(query);
  const syn = normalizedSynonyms(synonyms);
  const out = new Set<string>();
  if (!needles.length) return out;
  for (const [code, words] of syn) {
    if (needles.every((alts) => words.some((w) => alts.some((nd) => w.includes(nd))))) out.add(code);
  }
  return out;
}

/** نصوص الحساب مطبَّعة مرة واحدة قبل مقابلتها بكلمات البحث كلها. */
interface NormalizedAccount {
  code: string;
  names: string[];
  description: string;
  synonyms: readonly string[];
  /** الصيغ التي تُعدّ «تطابقاً كاملاً» مع البحث: الرمز والأسماء والمرادفات، بـ«ال» وبدونها */
  exact: ReadonlySet<string>;
}

/** كل نصّ ومعه صيغته بلا «ال» التعريف في أوله — فـ«الإيجار» يبدأ بـ«إيجار» ويساويه. */
function withBareArticle(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    out.add(v);
    out.add(stripDefiniteArticle(v));
  }
  return [...out];
}

function normalizeAccount(a: SearchableAccount, syn: Map<string, string[]>): NormalizedAccount {
  const code = normalizeArabicSearch(a.code);
  // الاسم المعرَّف لا يُعاقَب في NAME_PREFIX: «الإيجار» يُقابَل أيضاً بصيغته «إيجار»
  const names = withBareArticle(accountNameStrings(a).map((s) => normalizeArabicSearch(s)).filter(Boolean));
  const synonyms = syn.get(a.code) ?? [];
  return {
    code,
    names,
    description: normalizeArabicSearch(a.description),
    synonyms,
    exact: new Set([code, ...names, ...withBareArticle(synonyms)]),
  };
}

/** صيغ البحث كاملةً للتطابق التام: النصّ المطبَّع، ونفسه بعد نزع «ال» من كل كلمة. */
function queryForms(query: string | null | undefined): string[] {
  const norm = normalizeArabicSearch(query);
  if (!norm) return [];
  const bare = norm.split(' ').map(stripDefiniteArticle).join(' ');
  return norm === bare ? [norm] : [norm, bare];
}

function rankToken(a: NormalizedAccount, alts: readonly string[]): number {
  const R = ACCOUNT_SEARCH_RANK;
  let best: number = R.NONE;
  const bump = (v: number) => { if (v > best) best = v; };
  for (const nd of alts) {
    if (a.code === nd) return R.CODE_EXACT;
    if (a.code.startsWith(nd)) bump(R.CODE_PREFIX);
    else if (a.code.includes(nd)) bump(R.CODE_CONTAINS);
  }
  if (best >= R.CODE_CONTAINS) return best;
  for (const n of a.names) {
    for (const nd of alts) {
      if (n.startsWith(nd)) bump(R.NAME_PREFIX);
      else if (n.includes(nd)) bump(R.NAME_CONTAINS);
    }
  }
  if (best >= R.NAME_CONTAINS) return best;
  if (a.synonyms.some((w) => alts.some((nd) => w.includes(nd)))) return R.SYNONYM;
  if (a.description && alts.some((nd) => a.description.includes(nd))) return R.DESCRIPTION;
  return best;
}

/**
 * درجة الحساب في بحثٍ ما: 0 لا يطابق. كل كلمة يجب أن تطابق شيئاً، والدرجة أضعف مطابقة
 * (فالحساب الذي طابقت كلماته كلها في اسمه يعلو الذي طابقت إحداها في وصفه).
 */
export function accountSearchScore(
  a: SearchableAccount,
  query: string,
  opts: { synonyms?: SynonymMap } = {},
): number {
  const needles = searchNeedles(query);
  if (!needles.length) return ACCOUNT_SEARCH_RANK.NONE;
  return scoreWithNeedles(a, needles, normalizedSynonyms(opts.synonyms ?? ACCOUNT_SYNONYMS));
}

function scoreNormalized(norm: NormalizedAccount, needles: string[][]): number {
  let worst = Number.POSITIVE_INFINITY;
  for (const alts of needles) {
    const r = rankToken(norm, alts);
    if (r === ACCOUNT_SEARCH_RANK.NONE) return ACCOUNT_SEARCH_RANK.NONE;
    if (r < worst) worst = r;
  }
  return worst === Number.POSITIVE_INFINITY ? ACCOUNT_SEARCH_RANK.NONE : worst;
}

function scoreWithNeedles(a: SearchableAccount, needles: string[][], syn: Map<string, string[]>): number {
  return scoreNormalized(normalizeAccount(a, syn), needles);
}

/** ترتيب الرموز نصّياً — ثابت لا يتبع محليّة التشغيل. */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * المطابقون وحدهم مرتَّبين: الدرجة، ثم التطابق التام، ثم قرب النوع، ثم الرمز تصاعدياً
 * (ترتيب ثابت لا يتغيّر بين نداءين).
 *
 * الترجيحان عند تساوي الدرجة (شكوى الخبير: «الايجار» كانت تُصدِّر `115002 إيجار مدفوع مقدماً`
 * على `621004 الإيجار` لأن الرمز أصغر):
 *  1) **التطابق التام**: الحساب الذي ساوت الكلمةُ اسمَه أو مرادفه كاملاً يعلو من احتواه ضمن جملة.
 *  2) **قرب النوع**: دلالة الكلمة تُقرأ من القالب لا من قاموس — نوع أفضل حساب طابقها تماماً يرجّح
 *     أنداده. «مرتبات» تساوي مرادف `621001` (مصروف)، فيعلو `611001` المصروفُ التزامَ `213001`.
 */
export function rankAccounts<T extends SearchableAccount>(
  rows: readonly T[],
  query: string,
  opts: { synonyms?: SynonymMap } = {},
): T[] {
  const needles = searchNeedles(query);
  if (!needles.length) return [...rows];
  const syn = normalizedSynonyms(opts.synonyms ?? ACCOUNT_SYNONYMS);
  const forms = queryForms(query);
  const scored = rows
    .map((row) => {
      const norm = normalizeAccount(row, syn);
      return { row, score: scoreNormalized(norm, needles), exact: forms.some((f) => norm.exact.has(f)) };
    })
    .filter((x) => x.score > ACCOUNT_SEARCH_RANK.NONE);
  const anchorType = scored
    .filter((x) => x.exact)
    .sort((x, y) => y.score - x.score || byCode(x.row.code, y.row.code))[0]?.row.type ?? null;
  const near = (t: string | null | undefined): number => (anchorType && t === anchorType ? 1 : 0);
  return scored
    .sort((x, y) => y.score - x.score
      || Number(y.exact) - Number(x.exact)
      || near(y.row.type) - near(x.row.type)
      || byCode(x.row.code, y.row.code))
    .map((x) => x.row);
}

/** صفحة من نتائج مرتّبة (الترقيم بعد الترتيب بالصلة، فـtotal = كل المطابقين). */
export function pageOfRanked<T>(rows: readonly T[], offset: number, limit: number): T[] {
  const from = Math.max(0, offset);
  return rows.slice(from, from + Math.max(0, limit));
}

/** عدّاد الأنواع للنتائج (بديل groupBy في القاعدة حين يكون البحث في الذاكرة). */
export function countByType<T extends { type: string }>(rows: readonly T[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([type, count]) => ({ type, count }));
}
