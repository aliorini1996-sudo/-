/**
 * التعرّف على أسماء اللغات في نصوص الموقع — لقاعدة ui-languages في حارس الحقائق (scripts/verify-facts.mjs).
 *
 * لماذا وحدة مستقلة (١١ نوفمبر ٢٠٢٦): كان الحارس يعرف أسماء اللغات بالإنجليزية والفرنسية والتركية والصينية والعربية
 * وحدها، فقرأ «Ingles» الفلبينية (tl) فلم يعدّها الإنجليزية، وعدّ جملة الواجهة الصحيحة «Arabic, Ingles, French, Turkish,
 * at Chinese» قائمةً من أربع لغات تناقض الحقائق (٧ مواضع زائفة في tl/). والإصلاح ليس استثناء tl: الطبقة متعددة
 * اللغات تنشر أكثر من مئة وخمسين لغة، فالأسماء تُبنى لكل لغة منشورة من مصدرين:
 *   ١) Intl.DisplayNames بلغة الصفحة لكل رمز مكشوف (الخمس وأشهر غيرها) — «Ingles» و«árabe» و«Arabisch»…
 *   ٢) قائمة لغات الواجهة كما كُتبت في محتوى اللغة نفسه (_derived.uiLanguages في src/i18n/marketing/<code>.json —
 *      يملؤها المستورد من القاموس أو من Intl.ListFormat) مقسومةً إلى خمسة أسماء بترتيب ar en fr tr zh.
 *      ICU لا يعرف أسماء لغات كثيرة (الكريولية والإفريقية وغيرها: «Arábík Lángwej» أو الرمز نفسه)، والقائمة المكتوبة
 *      هي ما يقرؤه الزائر فعلاً.
 *
 * والأسماء المحلية **محصورة بصفحات لغتها** (البادئة /tl/ ونحوها): «angle» الموريسية و«Arab» الإندونيسية كلمتان عاديتان
 * في نصّ إنجليزي («from every angle» و«United Arab Emirates»)، فلو عُمّمتا لاخترعتا لغات في جمل لا تذكرها.
 * والأسماء العامة (الإنجليزية والفرنسية والتركية والصينية والعربية) سارية في كل صفحة كما كانت.
 *
 * والاسم المعروف سيفٌ ذو حدّين: يكشف اللغة الزائدة («…et espagnol» تُكشف ما دام اسمها معروفاً بلغة صفحتها)، لكنه
 * **قد يُخفي الناقصة** إن عُدّت صفةٌ لغةً: «L’application pour le monde arabe est disponible en anglais, français, turc et
 * chinois» تُسقط العربية، و«arabe» الموصوفة بـ«monde» كانت تكمّلها خمساً فتمرّ — كان قيد الصفة على «arabe» العامة وحدها،
 * والمحلية («arabe» في fr/ و«árabe» في es/ و«Arab» في id/) بلا قيد (١١ نوفمبر ٢٠٢٦). فقيد الصفة واحد للأسماء العامة
 * والمحلية معاً (ADJ_NOUNS_BEFORE وADJ_NOUNS_AFTER): الاسم بعد موصوف («monde arabe» · «mundo árabe» · «regione araba» ·
 * «dunia Arab» · «świat arabski») أو قبله («arabiska världen» · «arab világ» · «Arab Saudi») صفةٌ لا لغة.
 *
 * وحدة نقية: بلا fs. البيانات (اللغات المنشورة وقوائمها) تُمرَّر إلى createLangDetector، فيستعملها الحارس والاختبار
 * src/content/factsLangs.test.ts بالمنطق نفسه.
 */
import { UI_LANGS } from '../src/content/entity-facts.mjs';

/** الرموز التي تُكشف أسماؤها: لغات الواجهة الخمس وأشهر غيرها (لكشف «يدعم الإسبانية» ونحوها) */
export const DETECT_CODES = Object.freeze(['ar', 'en', 'fr', 'tr', 'zh', 'es', 'pt', 'de', 'ru', 'ja', 'ko', 'hi', 'ur', 'fa', 'he', 'id', 'it']);

// ————————————————————————————————————————————————————————————————————————————————
// الأسماء العامة (سارية في كل صفحة)
// ————————————————————————————————————————————————————————————————————————————————

/** أسماء اللغات بكل لغة كتابة — لكشف قوائم اللغات (الخمس وأشهر غيرها) */
const LATIN_LANGS = {
  ar: ['Arabic', 'arabe', 'Arapça'],
  en: ['English', 'anglais', '[İI]ngilizce'],
  fr: ['French', 'fran[çc]ais', 'Fransızca'],
  tr: ['Turkish', 'turc', 'Türkçe'],
  zh: ['Chinese', 'Mandarin', 'chinois', 'Çince'],
  es: ['Spanish', 'espagnol', '[İI]spanyolca'],
  pt: ['Portuguese', 'portugais', 'Portekizce'],
  de: ['German', 'allemand', 'Almanca'],
  ru: ['Russian', 'russe', 'Rusça'],
  ja: ['Japanese', 'japonais', 'Japonca'],
  ko: ['Korean', 'cor[ée]en', 'Korece'],
  hi: ['Hindi', 'Hintçe'],
  ur: ['Urdu', 'ourdou', 'Urduca'],
  fa: ['Persian', 'Farsi', 'persan', 'Farsça'],
  he: ['Hebrew', 'h[ée]breu', '[İI]branice'],
  id: ['Indonesian', 'indon[ée]sien', 'Endonezce'],
  it: ['Italian', 'italien', '[İI]talyanca'],
};
const CJK_LANGS = {
  ar: ['阿拉伯语', '阿拉伯文'], en: ['英语', '英文'], fr: ['法语', '法文'], tr: ['土耳其语', '土耳其文'],
  zh: ['中文', '汉语', '华语'], es: ['西班牙语'], pt: ['葡萄牙语'], de: ['德语'], ru: ['俄语'], ja: ['日语', '日文'],
  ko: ['韩语', '朝鲜语'], hi: ['印地语'], ur: ['乌尔都语'], fa: ['波斯语'], he: ['希伯来语'], id: ['印尼语'], it: ['意大利语'],
};
/** الاسم العربي للغة صفةٌ بعد «ال»؛ ولا يُعدّ لغةً إن تلا اسماً مثل «الأسواق العربية» و«الجمهورية التركية» */
export const AR_STEMS = {
  ar: 'عربي[ةه]', en: '[إا]ن[جك]ليزي[ةه]', fr: 'فرنسي[ةه]', tr: 'تركي[ةه]', zh: 'صيني[ةه]', es: '[إا]سباني[ةه]',
  pt: 'برتغالي[ةه]', de: '[أا]لماني[ةه]', ru: 'روسي[ةه]', ja: 'ياباني[ةه]', ko: 'كوري[ةه]', hi: 'هندي[ةه]',
  ur: '[أا]ردي[ةه]', fa: 'فارسي[ةه]', he: 'عبري[ةه]', id: '[إا]ندونيسي[ةه]', it: '[إا]يطالي[ةه]',
};
const AR_NOUN_BEFORE = '(?:[أا]سواق|سوق|دول|بلدان|منطق[ةه]|جامع[ةه]|مملك[ةه]|[إا]مارات|جمهوري[ةه]|شركات|شرك[ةه]|مدن|لير[ةه]|عمل[ةه]|حكوم[ةه]|هيئ[ةه]|منتجات|بضائع)';
/**
 * قيد الصفة: اسم اللغة بالحرف اللاتيني صفةٌ لا اسم لغة إن تلا موصوفاً في اللغات التي تؤخّر الصفة (الفرنسية والإسبانية
 * والبرتغالية والإيطالية والقطلونية والرومانية والإندونيسية والملايوية والبولندية): «monde arabe» و«pays arabe» و«Ligue
 * arabe» و«mundo árabe» و«Liga Árabe» و«região árabe» و«regione araba» و«lumea arabă» و«dunia Arab» و«świat arabski».
 * يسري على الأسماء العامة («arabe» الفرنسية وأخواتها) والمحلية (لكل لغة منشورة) معاً.
 */
const ADJ_NOUNS_BEFORE = [...new Set([
  // fr
  'monde', 'pays', 'march[ée]s?', 'r[ée]gions?', 'Ligue', '[ÉE]tats?', 'monarchies?', 'p[ée]ninsule', 'golfe', 'nations?',
  'communaut[ée]s?', 'diaspora', 'peuples?', 'r[ée]publique', 'entreprises?', 'soci[ée]t[ée]s?', '[ÉE]mirats',
  // es · pt · gl · ca
  'mundo', 'pa[íi]s(?:es)?', 'mercados?', 'regi[óo]n(?:es)?', 'regi(?:ão|ões|ao|oes)', 'Liga', 'Estados?', 'monarqu[íi]as?',
  'pen[íi]nsula', 'golfo', 'naci[óo]n(?:es)?', 'na(?:ção|ções|cao|coes)', 'comunidad(?:es)?', 'comunidades?', 'pueblos?', 'povos?',
  'rep[úu]blica', 'empresas?', 'Emiratos', 'Emirados', 'm[óo]n', 'pa[ïi]sos', 'mercats?',
  // it
  'mondo', 'paes[ei]', 'mercat[oi]', 'region[ei]', 'Lega', 'Stat[oi]', 'monarchi[ae]', 'penisola', 'nazion[ei]', 'comunit[àa]',
  'popol[oi]', 'repubblica', 'aziend[ae]', 'Emirati',
  // ro
  'lumea', 'lume', '[țţ][ăa]r(?:ile|i|a)', 'tar(?:ile|i)', 'pia[țţ]a', 'piata', 'regiunea',
  // id · ms · jv · su
  'dunia', 'negara(?:-negara)?', 'pasar', 'wilayah', 'kawasan', 'Emirat', 'jazirah', 'semenanjung', 'bangsa', 'Teluk',
  // pl
  '[śs]wiat', 'kraj(?:e|ów|ow)?', 'rynek', 'region', 'p[óo][łl]wysep',
])];
/**
 * والمقابل في اللغات التي تقدّم الصفة (السويدية والدنماركية والنرويجية والهولندية والأفريكانية والمجرية والكرواتية
 * والبوسنية والسلوفينية): «arabiska världen» و«arabisk verden» و«Arabisch wereld» و«arab világ» و«arapski svijet» —
 * ومعها «Arab Saudi» الإندونيسية والملايوية (اسم الدولة لا اللغة).
 */
const ADJ_NOUNS_AFTER = [...new Set([
  // sv · da · no · is · fo
  'v[äe]rlden', 'verden(?:en)?', 'l[äa]nder(?:na)?', 'lande(?:ne)?', 'land(?:a|ene)', 'ligaen', 'ligan', 'regionen',
  'marknad(?:en|er)?', 'marked(?:et|er)?', 'halv[öø]n', 'halv[øo]ya', 'halv[øo]en', 'emirater(?:ne)?', 'emiraten',
  // nl · af · fy · lb
  'wereld', 'landen', 'liga', 'regio', 'markt(?:en)?', 'staten', 'schiereiland',
  // hu
  'vil[áa]g\\p{L}*', 'orsz[áa]g\\p{L}*', 'lig[áa]\\p{L}*', 'r[ée]gi[óo]\\p{L}*', 'piac\\p{L}*', 'f[ée]lsziget\\p{L}*', 'emir[áa]tus\\p{L}*',
  // hr · bs · sr · sl
  'svijet\\p{L}*', 'svet\\p{L}*', 'zemlj\\p{L}*', 'dr[žz]av\\p{L}*', 'regij\\p{L}*', 'tr[žz]i[šs]t\\p{L}*', 'poluotok\\p{L}*',
  // id · ms
  'Saudi',
])];
/** نظرة خلفية للأسماء العامة: لا اسم لغة بعد موصوف (والموصوف كلمة كاملة) */
const ADJ_LOOKBEHIND = `(?<!(?<![\\p{L}\\p{N}])(?:${ADJ_NOUNS_BEFORE.join('|')})\\s{1,3})`;
/** ونظرة أمامية: لا اسم لغة قبل موصوف */
const ADJ_LOOKAHEAD = `(?!\\s{1,3}(?:${ADJ_NOUNS_AFTER.join('|')})(?![\\p{L}]))`;
const ADJ_BEFORE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${ADJ_NOUNS_BEFORE.join('|')})\\s{1,3}$`, 'iu');
const ADJ_AFTER_RE = new RegExp(`^\\s{1,3}(?:${ADJ_NOUNS_AFTER.join('|')})(?![\\p{L}])`, 'iu');
/** الاسم اللاتيني بين start وend في s صفةٌ لموصوف قبله أو بعده — قيد الصفة نفسه للأسماء المحلية */
export const adjectiveUse = (s, start, end) => ADJ_BEFORE_RE.test(String(s).slice(Math.max(0, start - 40), start))
  || ADJ_AFTER_RE.test(String(s).slice(end, end + 40));
const GLOBAL_PARTS = Object.fromEntries(DETECT_CODES.map((code) => [code, [
  `(?<![\\p{L}\\p{N}])${ADJ_LOOKBEHIND}(?:${LATIN_LANGS[code].join('|')})(?![\\p{L}])${ADJ_LOOKAHEAD}`,
  CJK_LANGS[code].join('|'),
  `(?<!${AR_NOUN_BEFORE}\\s{1,3})(?<!\\p{L})[وف]?(?:بال|لل|ال)${AR_STEMS[code]}(?!\\p{L})`,
  // «بواجهة عربية» و«الواجهة عربية»: اسم اللغة صفةٌ للواجهة نفسها
  `واجه[ةه]\\s+(?:ال)?${AR_STEMS[code]}(?!\\p{L})`,
]]));
/** نمط كل رمز بالأسماء العامة — يُجمَّع مرّة واحدة (كما كان LANG_RES في الحارس) */
const GLOBAL_RES = Object.fromEntries(DETECT_CODES.map((code) => [code, new RegExp(GLOBAL_PARTS[code].join('|'), 'iu')]));
/** كلمات أسماء اللغات اللاتينية العامة — CLAUSE_SPLIT لا يقطع «Arabic, English, and French» عند «and» */
const LATIN_LANG_WORDS = Object.values(LATIN_LANGS).flat().join('|');

// ————————————————————————————————————————————————————————————————————————————————
// الأسماء المحلية (لكل لغة منشورة، محصورة بصفحاتها)
// ————————————————————————————————————————————————————————————————————————————————

/** كتابات بلا مسافات بين الكلمات (中文版 وภาษาจีน وཏུར་ཀི་ཡིག་དང་) */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;
/** بلا حدود كلمة: الكتابات بلا مسافات، والحبشية تلصق حروف الجرّ بأول الاسم (በአረብኛ) */
const LOOSE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\p{Script=Ethiopic}]/u;
/** الحدّ من أول الاسم وحده: الكورية تلصق الأداة بآخره (영어로)، والهندية وأخواتها اللواحق (चीनीमे وचिनियाँमा) */
const PREFIX_ONLY_SCRIPT = /[\p{Script=Hangul}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}]/u;
/** العبرية واليديشية تلصقان أدوات «ו ב ל ה מ ש כ» بأول الاسم (וסינית) */
const HEBREW = /\p{Script=Hebrew}/u;
const LATIN = /\p{Script=Latin}/u;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const HEBREW_PREFIX = 'ובלהמשכ';
/** آخر محرف قبل الموضع i وأول محرف عنده (بنقاط الترميز لا بوحدات UTF-16) */
const charBefore = (s, i) => (i > 0 ? Array.from(s.slice(Math.max(0, i - 2), i)).pop() || '' : '');
const charAt = (s, i) => (i < s.length ? String.fromCodePoint(s.codePointAt(i)) : '');
/**
 * حدّ الكلمة حول اسم بحسب كتابته (العلامات المركّبة \p{M} جزء من الكلمة في الهندية وأخواتها). يُفحص في JavaScript
 * لا بنظرة خلفية في النمط: نمطٌ بـ\p{L} وعلم i لكل اسم في كل لغة منشورة كان يكلّف تجميعه ١٥ ثانية في كل تشغيل.
 */
function boundaryOk(name, s, start, end) {
  if (LOOSE_SCRIPT.test(name)) return true;
  let left = start;
  if (HEBREW.test(name)) while (left > 0 && start - left < 2 && HEBREW_PREFIX.includes(s[left - 1])) left--;
  if (WORD_CHAR.test(charBefore(s, left))) return false;
  if (PREFIX_ONLY_SCRIPT.test(name)) return true;
  return !LETTER_OR_MARK.test(charAt(s, end));
}
/** الاسم بلا علامات التشكيل اللاتينية («Inglés» ⇒ «Ingles») — الكتابة الشائعة بلا لوحة مفاتيح محلية */
const stripLatinMarks = (s) => (LATIN.test(s) ? s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC') : s);

/** فواصل القوائم بكل الكتابات المنشورة: اللاتينية والعربية والصينية والحبشية والميانمارية والتبتية، والفاصلة المنقوطة */
const LIST_SEP = /\s*[,،、，፣၊།;]\s*/u;
/** أدوات العطف التي كتبتها القواميس ولا يعطيها Intl.ListFormat (لغات لا يعرفها ICU أو صيغ القاموس) */
const EXTRA_CONJ = [
  'and', 'et', 've', 'y', 'e', 'i', 'a', 'o', 'u', 'und', 'en', 'og', 'och', 'és', 'ja', 'ir', 'un', 'at', 'dan', 'lan', 'jeung',
  'thiab', 'va', 'na', 'ne', 'ni', 'ak', 'ek', 'mo', 'ma', 'me', 'kple', 'ani', 'da', 'iyo', 'fi', 'ary', 'ha', 'no', 'ki', 'mpe', 'ye',
  'kɛ', 'ɛn', 'we', 'àti', 'ati', 'aamma', 'жана', 'және', 'һәм', 'ва', 'и', 'та', 'і', '۽', 'û', 'و', 'ۋە', 'اور', 'او', 'ہور',
  'आणि', 'और', 'आ', 'र', 'અને', 'ਅਤੇ', 'ଓ', 'আৰু', 'এবং', 'ও', 'மற்றும்', 'እና', 'አና', 'און', 'އަދި', 'ⴷ', 'kaj', 'eta', 'ag',
  'agus', 'ac', 'le', 'nā', 'mā', '和', '与', '及', 'と', '및', '그리고', 'และ', 'ແລະ', 'និង', 'နှင့်', 'དང་',
];
/** أداة العطف الملتصقة بالاسم التالي (الكينيارواندية «n'Igishinwa»، والعبرية «וסינית») */
const ATTACHED_CONJ = /^(.+?)\s+(?:n['’]|ו)(\S.*)$/u;

/** أدوات العطف في لغة من Intl.ListFormat (الجزء الحرفي بين آخر عنصرين) — مصفوفة فارغة إن لم يعرف ICU اللغة */
function listConjunctions(intl) {
  const out = new Set();
  for (const type of ['conjunction', 'unit']) {
    try {
      if (!Intl.ListFormat.supportedLocalesOf([intl]).length) continue;
      const parts = new Intl.ListFormat(intl, { type }).formatToParts(['A', 'B', 'C']);
      const lit = parts.filter((p) => p.type === 'literal').map((p) => p.value.trim()).filter(Boolean);
      for (const l of lit) if (!/^[,،、，፣၊།;]$/u.test(l)) out.add(l.replace(/^[,،、，]\s*/u, ''));
    } catch { /* رمز لا يعرفه ICU */ }
  }
  return [...out];
}

/**
 * يقسم قائمة لغات الواجهة كما كُتبت بلغة ما («arab, angle, franse, tirk ek sinwa») إلى خمسة أسماء بترتيبها، أو null
 * إن لم ينقسم إلى خمسة بالضبط (يكفي اللغةَ حينها Intl). الصيغ المعروفة في المحتوى المنشور:
 *   «A, B, C, D and E» · «A, B, C, D, E» · «A، B، C، D و E» · «A、B、C、D和E» · «A B C D และE» (التايلندية بالمسافة)
 *   · «A B C Dདང་E» (التبتية) · «Dን Eን» (التغرينية: لاحقة العطف على الاسمين) · «D n'E» (الكينيارواندية).
 */
export function splitUiLanguages(list, intl = 'en') {
  const str = String(list || '').trim();
  const conj = [...new Set([...listConjunctions(intl), ...EXTRA_CONJ])].sort((a, b) => b.length - a.length);
  let items = str.split(LIST_SEP).map((x) => x.trim()).filter(Boolean);
  // قوائم تفصل بالمسافة لا بالفاصلة (التايلندية والخميرية والتبتية)
  if (items.length < 4) {
    const t = str.split(/\s+/u).filter(Boolean);
    if (t.length >= 4 && t.length <= 6) items = t;
  }
  // «… D و E» بالمسافة: الأداة عنصر سادس
  if (items.length === 6 && conj.includes(items[4])) items = [...items.slice(0, 4), items[5]];
  if (items.length === 5) {
    // «…และจีน»: أداة ملتصقة بأول الاسم الأخير في الكتابات بلا مسافات
    const c = conj.find((x) => NO_SPACE_SCRIPT.test(x) && items[4].startsWith(x) && items[4].length > x.length);
    if (c) items[4] = items[4].slice(c.length);
    return items;
  }
  if (items.length !== 4) return null;
  const last = items[3];
  for (const c of conj) {
    // الصينية والتبتية بلا مسافة حول الأداة («土耳其语和中文»)
    const sp = NO_SPACE_SCRIPT.test(c) ? '\\s*' : '\\s+';
    const m = last.match(new RegExp(`^(.+?)${sp}${escapeRe(c)}${sp}(.+)$`, 'u'));
    if (m) return [...items.slice(0, 3), m[1].trim(), m[2].trim()];
  }
  const a = last.match(ATTACHED_CONJ);
  if (a) return [...items.slice(0, 3), a[1].trim(), a[2].trim()];
  // أداة لم تُعرف: «D x E» ثلاث كلمات وسطاها الأداة، أو «Dን Eን» كلمتان
  const toks = last.split(/\s+/u).filter(Boolean);
  if (toks.length === 3) return [...items.slice(0, 3), toks[0], toks[2]];
  if (toks.length === 2) return [...items.slice(0, 3), toks[0], toks[1]];
  return null;
}

/**
 * أسماء اللغات بلغة واحدة منشورة: { رمز: [أسماء] }.
 *   intl: رمز Intl للغة (intlLocale في السجل) · uiLanguages: قائمة الخمس كما كُتبت في محتواها (اختيارية)
 */
export function localeLangNames(intl, uiLanguages = '') {
  const names = Object.fromEntries(DETECT_CODES.map((c) => [c, new Set()]));
  const add = (code, raw) => {
    if (typeof raw !== 'string') return; // fallback: 'none' ⇒ undefined لاسم لا يعرفه ICU
    for (const part of String(raw || '').split(/\s*,\s*/u)) {
      const n = part.trim();
      // ICU يعيد الرمز نفسه للغة لا يعرف اسمها («tr») — كلمة من حرفين تطابق «en» الفرنسية و«a» و«e»…
      if (!n || n.toLowerCase() === code || n.toLowerCase() === code.split('-')[0]) continue;
      if (LATIN.test(n) && n.replace(/\P{L}/gu, '').length < 3) continue;
      names[code].add(n);
      const bare = stripLatinMarks(n);
      if (bare !== n) names[code].add(bare);
    }
  };
  try {
    const dn = new Intl.DisplayNames([intl], { type: 'language', fallback: 'none' });
    for (const code of DETECT_CODES) {
      try { add(code, dn.of(code)); } catch { /* اسم غير معروف */ }
    }
  } catch { /* رمز لا يعرفه ICU: تكفي القائمة المكتوبة */ }
  const split = uiLanguages ? splitUiLanguages(uiLanguages, intl) : null;
  if (split) split.forEach((n, i) => add(UI_LANGS[i], n));
  return Object.fromEntries(Object.entries(names).map(([c, s]) => [c, [...s]]));
}

// ————————————————————————————————————————————————————————————————————————————————
// الجمل والعبارات ومفردات الموصوف
// ————————————————————————————————————————————————————————————————————————————————

/** مفردات الواجهة والتطبيق، والإتاحة، والمحتوى (موقع ومقالات)، ولغات المستند المطبوع */
const APP_KW = /(?<![\p{L}])(?:apps?|application|applications|interfaces?|UI|dashboards?|software|platform|system|product|appli|logiciel|plateforme|syst[èe]me|tableau\s+de\s+bord)(?![\p{L}])|uygulama\p{L}*|arayüz\p{L}*|yazılım\p{L}*|(?<![\p{L}])platform\p{L}*|(?<![\p{L}])sistem\p{L}*|应用|界面|软件|平台|系统|(?:ال)?تطبيق(?:ات)?|(?:ال)?واجه[ةه]|(?:ال)?نظام|(?:ال)?منص[ةه]|(?:ال)?برنامج|(?:ال)?لوح[ةه]/iu;
const AVAIL_KW = /\b(?:available|runs?|works?|offered)\s+in\b|disponible\s+en|fonctionne\s+en|propos[ée]e?s?\s+en|kullanılabilir|mevcut|çalışır|支持|提供|متاح[ةه]?|متوفر[ةه]?|يعمل|تعمل|يدعم|تدعم|بلغات|باللغات/iu;
const CONTENT_KW = /(?<![\p{L}])(?:website|web\s*site|site|blog|pages?|guides?|articles?|posts?|content|home\s*pages?)(?![\p{L}])|web\s*sitesi|sayfa\p{L}*|rehber\p{L}*|makale\p{L}*|网站|博客|页面|首页|指南|文章|(?:ال)?موقع|(?:ال)?مدون[ةه]|صفح[ةه]|صفحات|[أا]دل[ةه]|دليل|مقال(?:ات)?/iu;
const DOC_KW = /bilingual|invoic\w*|receipts?|vouchers?|print\w*|templates?|\bPDF\b|statements?|\bquotes?\b|فاتور|فواتير|سند|ثنائي|طباع|يطبع|تطبع|نموذج|نماذج|كشف|عرض\s*سعر|factur\w*|re[çc]us?|bilingue|imprim\w*|mod[èe]les?|devis|fatura\p{L}*|makbuz\p{L}*|şablon\p{L}*|yazdır\p{L}*|发票|收据|双语|打印|模板|报价/iu;
const ONLY_KW = /\bonly\b|\bexclusively\b|uniquement|seulement|sadece|yalnızca|仅|只有|فقط|وحده|وحدها/iu;
/**
 * ما يجعل ذكرَ بعض الخمس بعد جملتها **تفصيلاً** لا قائمةً بديلة (استثناء states5 في languageClaims): نفيٌ أو استدراكٌ أو
 * تضمينٌ صريح. صيغة المحتوى المنشور (ff): «Interface Pulaar alaa, kono Farayseere e Engeleere ina e majje» — «alaa» نفي
 * و«kono» استدراك و«e majje» «منها». وعبارة بلا شيء منها («ولوحة الإدارة متاحة بالعربية والإنجليزية») قائمةٌ تُدان.
 * لا «no» ولا «ma» ولا «mas» ولا «ni» ولا «pas» المفردة: «no» البرتغالية «في الـ» و«ma» عطفٌ في الماورية والملغاشية
 * و«pas» الهولندية «فقط»، فتعذر عبارات ليست تفصيلاً.
 */
const QUALIFIER_KW = new RegExp([
  // نفي
  "(?<![\\p{L}])(?:not|none|neither|nor|without|never|aucune?|sans|jamais|sin|ning[úu]n[oa]?|nunca|n[ãa]o|nenhum[ao]?|non|senza|nessun[oa]?|nicht|kein\\p{L}*|ohne|yok|de[ğg]il|olmadan|tidak|bukan|tanpa|alaa)(?![\\p{L}])",
  "n['’]t(?![\\p{L}])|(?<![\\p{L}])(?:ne|n['’])\\s*\\p{L}+\\s+(?:pas|plus|jamais)(?![\\p{L}])|(?<![\\p{L}])pas\\s+d['’e]",
  // استدراك
  '(?<![\\p{L}])(?:but|however|although|though|mais|cependant|toutefois|pourtant|pero|sin\\s+embargo|por[ée]m|contudo|per[òo]|tuttavia|aber|jedoch|ama|ancak|fakat|lakin|tetapi|namun|kono)(?![\\p{L}])',
  // تضمين صريح
  '(?<![\\p{L}])(?:among\\s+(?:them|these|those)|including|included|includes|parmi\\s+(?:elles|eux|celles-ci|ceux-ci|lesquelles)|y\\s+compris|notamment|entre\\s+(?:ellas|ellos|elas|eles|estas|estos|estes)|incluid[oa]s|inclu[íi]d[oa]s|incluindo|incluyendo|tra\\s+cui|tra\\s+queste|darunter|unter\\s+ihnen|aras[ıi]nda|dahil|termasuk|di\\s+antaranya|e\\s+majje)(?![\\p{L}])',
  // الصينية واليابانية والكورية
  '包括|其中|之一|在内|但是|不过|然而|没有|不支持|不提供|ありません|ではない|含む|含まれ|ただし|しかし|포함|하지만|그러나|없습니다|없으며|않습니다',
  // العربية (بواو العطف أو فائه)
  '(?<![\\p{L}])[وف]?(?:منها|بينها|ضمنها|لا|ليس|ليست|لم|لن|بلا|دون|بدون|لكن|لكنّ|لكنها|لكنه|من\\s+بينها|من\\s+ضمنها)(?![\\p{L}])',
].join('|'), 'iu');
/** الاستدراك الذي يبتلعه CLAUSE_SPLIT («…، لكن الفرنسية…» · «…, ancak…») — يُقرأ من آخر ما قبل العبارة في جملتها */
const CONCESSIVE_TAIL = /(?<![\p{L}])(?:but|mais|ama|ancak|fakat|لكن|غير\s+[أا]ن)[\s,،]*$/iu;
/** «لا … إلا» و«except» حصرٌ لا تفصيل: النفي فيها لا يعذر العبارة */
const RESTRICT_KW = /(?<![\p{L}])(?:[إا]لا|سوى|except|excepting|sauf|excepto|exceto|tranne|au[sß]er|hari[çc]|d[ıi][şs][ıi]nda|kecuali|maliban)(?![\p{L}])|除了|以外|외에/iu;
/** العبارة c من الجملة s فيها نفي أو استدراك أو تضمين صريح، بلا حصر */
const qualified = (s, c) => {
  if (RESTRICT_KW.test(c)) return false;
  if (QUALIFIER_KW.test(c)) return true;
  const i = s.indexOf(c);
  return i > 0 && CONCESSIVE_TAIL.test(s.slice(Math.max(0, i - 24), i));
};

export const sentences = (text) => String(text)
  .split(/(?<=[.!?؟])\s+|(?<=[。！？])\s*|\n+|\s+[·•|]\s+/u)
  .map((s) => s.trim().replace(/^(?:[-*>•]\s*)+/, ''))
  .filter(Boolean);

const CLAUSE_SPLIT = new RegExp([
  // «…, and the apps are…» تُقطع، و«Arabic, English, and French» لا تُقطع (يليها اسم لغة)
  `,\\s*(?:and|while|but|whereas|et|mais|tandis\\s+que|ve|ama|ancak|fakat)\\s+(?!(?:also\\s+|aussi\\s+|ayrıca\\s+)?(?:${LATIN_LANG_WORDS})(?![\\p{L}]))`,
  '\\s+(?:while|whereas|tandis\\s+que|ancak|fakat)\\s+',
  '\\s+(?:بينما|لكن|غير\\s+[أا]ن)\\s+',
  '[，；;]',
  // «Title: description» في llms، و«Languages: …»: النقطتان بمسافة بعدهما (لا «https://»)
  '[:：]\\s+',
  // «…، والتطبيقات…» تُقطع، و«بالعربية، والإنجليزية» لا تُقطع
  `،\\s*(?=و(?!(?:بال|لل|ال)(?:${Object.values(AR_STEMS).join('|')})))`,
].join('|'), 'iu');
export const clauses = (sentence) => sentence.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);

export const setStr = (s) => `{${[...s].sort().join(', ')}}`;
export const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
export const UI = new Set(UI_LANGS);

/** أقرب مسافة بين موضع i وأي مطابقة للنمط (Infinity إن لم يطابق) */
const nearest = (re, s, i) => {
  let best = Infinity;
  for (const m of s.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
    best = Math.min(best, Math.abs(m.index - i), Math.abs(m.index + m[0].length - i));
  }
  return best;
};

// ————————————————————————————————————————————————————————————————————————————————
// الكاشف
// ————————————————————————————————————————————————————————————————————————————————

/**
 * كاشف لغات بأسماء كل لغة منشورة.
 *   locales: [{ code, intl, uiLanguages }] — code رمز البادئة (/tl/)، intl رمز Intl (intlLocale)، uiLanguages قائمة
 *   الخمس بلغتها (_derived.uiLanguages). loc في الدوال أدناه رمز لغة الصفحة (null أو غير منشور ⇒ الأسماء العامة وحدها).
 */
export function createLangDetector(locales = []) {
  const byCode = new Map((locales || []).filter((l) => l && l.code && l.code !== 'ar').map((l) => [l.code, l]));
  const cache = new Map();
  /**
   * الأسماء المحلية للغة الصفحة نمطاً واحداً بلا نظرات (مجموعة التقاط لكل اسم، الأطول أولاً) — والحدود في boundaryOk.
   * null لصفحة بلا لغة منشورة (العربية والجذر) أو لغة بلا أسماء محلية.
   */
  const localMatcher = (loc) => {
    if (!byCode.has(loc)) return null;
    if (cache.has(loc)) return cache.get(loc);
    const l = byCode.get(loc);
    const names = localeLangNames(l.intl || l.code, l.uiLanguages || '');
    const entries = DETECT_CODES.flatMap((code) => names[code].map((name) => ({ code, name })))
      .sort((a, b) => b.name.length - a.name.length);
    const m = entries.length
      ? { entries, re: new RegExp(entries.map((e) => `(${escapeRe(e.name).replace(/\s+/g, '\\s+')})`).join('|'), 'giu') }
      : null;
    cache.set(loc, m);
    return m;
  };
  /** مطابقات الأسماء المحلية بحدودها: [{ code, index }] */
  const localHits = (s, loc) => {
    const m = localMatcher(loc);
    if (!m) return [];
    const out = [];
    m.re.lastIndex = 0;
    let x;
    while ((x = m.re.exec(s))) {
      const gi = x.findIndex((g, i) => i > 0 && g !== undefined);
      const e = m.entries[gi - 1];
      const end = x.index + x[0].length;
      // قيد الصفة كالأسماء العامة: «monde arabe» في fr/ و«dunia Arab» في id/ صفةٌ لا لغة
      if (boundaryOk(e.name, s, x.index, end) && !(LATIN.test(e.name) && adjectiveUse(s, x.index, end))) {
        out.push({ code: e.code, index: x.index });
      }
      m.re.lastIndex = x.index + 1; // مطابقة رُفضت حدودها لا تبتلع ما يبدأ داخلها
    }
    return out;
  };
  const mentionedLangs = (s, loc = null) => {
    const found = new Set(DETECT_CODES.filter((code) => GLOBAL_RES[code].test(s)));
    for (const h of localHits(s, loc)) found.add(h.code);
    return found;
  };
  /** موضع أول اسم لغة في النص (أو -1) */
  const firstLangIndex = (s, loc = null) => {
    let best = -1;
    const take = (i) => { if (i >= 0 && (best < 0 || i < best)) best = i; };
    for (const code of DETECT_CODES) take(s.search(GLOBAL_RES[code]));
    for (const h of localHits(s, loc)) take(h.index);
    return best;
  };
  /**
   * جمل تذكر لغات الواجهة بقائمة تخالف الحقائق.
   * استثناء واحد ضيّق: بعضٌ من الخمس (بلا لغة غيرها ولا «فقط») في عبارةٍ **فيها نفي أو استدراك أو تضمين صريح**
   * (qualified)، في جملةٍ فيها عبارةٌ تعدّ الخمس كلها أو في الجملة التي تليها مباشرةً، تفصيلٌ لا قائمة — «…بالعربية
   * والإنجليزية والفرنسية والتركية والصينية. لا واجهة بالفولانية، لكن الفرنسية والإنجليزية منها» (ff). وبلا هذا الشرط
   * كانت «تطبيقات FieldSales بالخمس. ولوحة الإدارة متاحة بالعربية والإنجليزية.» تمرّ (١١ نوفمبر ٢٠٢٦)، وهي قائمة
   * ناقصة لا تفصيل. والعبارة لا الجملة: «الواجهة عربية ومعها الإنجليزية والفرنسية، وللموقع صفحات بالتركية والصينية»
   * تذكر الخمس في جملتها موزّعةً على عبارتين فلا تُعذر. واللغة الزائدة و«فقط» والحصر («لا … إلا») لا تُعذر أبداً.
   */
  const languageClaims = (text, loc = null) => {
    const out = [];
    const all = sentences(text);
    // يُحسب عند الحاجة وحدها (قبل إدانة عبارة): حسابه لكل جملة كان يضاعف زمن الحارس على dist كله
    const memo = new Map();
    const states5 = (i) => {
      if (i < 0) return false;
      if (!memo.has(i)) memo.set(i, all[i].length <= 1200 && clauses(all[i]).some((c) => sameSet(mentionedLangs(c, loc), UI)));
      return memo.get(i);
    };
    for (const [si, s] of all.entries()) {
      if (s.length > 1200) continue; // كتلة بلا ترقيم (قائمة روابط) لا جملة
      for (const c of clauses(s)) {
        const langs = mentionedLangs(c, loc);
        if (!langs.size) continue;
        const at = firstLangIndex(c, loc);
        const app = nearest(APP_KW, c, at);
        const content = nearest(CONTENT_KW, c, at);
        // قائمة اللغات تتبع أقرب موصوف لها: «guides in Arabic, English and French» لغات محتوى ولو ذُكرت المنصة قبلها
        if (content < app) continue;
        if (app === Infinity && !AVAIL_KW.test(c)) continue; // لا موصوف: تكفي عبارة إتاحة («Disponible en…»)
        if (DOC_KW.test(c)) continue; // لغات المستند المطبوع لا لغات الواجهة
        if (langs.size < 2 && !ONLY_KW.test(c)) continue;
        if (sameSet(langs, UI)) continue;
        if ([...langs].every((l) => UI.has(l)) && !ONLY_KW.test(c) && qualified(s, c) && (states5(si) || states5(si - 1))) continue;
        out.push({ match: c, note: `اللغات ${setStr(langs)} ≠ الحقائق ${setStr(UI)}` });
      }
    }
    return out;
  };
  /** الأسماء المحلية للغة (للتشخيص في --probe) */
  const localNames = (loc) => {
    const l = byCode.get(loc);
    return l ? localeLangNames(l.intl || l.code, l.uiLanguages || '') : null;
  };
  return { mentionedLangs, firstLangIndex, languageClaims, localNames, has: (loc) => byCode.has(loc) };
}

/** رمز لغة الصفحة من مسارها النسبي («tl/about/index.html» ⇒ tl) إن كان لغة منشورة، وإلا null */
export function docLocale(name, detector) {
  const m = String(name).match(/^([a-z]{2,3}(?:-[a-z0-9]+)?)\//i);
  return m && detector.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}
