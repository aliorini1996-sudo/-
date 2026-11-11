/**
 * قواعد نصوص الطبقة متعددة اللغات (spec-b §١١ G4/G5) — مشتركة بين المستورد (import-i18n.mjs) والحارس
 * (verify-i18n.mjs) وgen-llms-i18n.mjs، فلا ينشر المستورد ما يرفضه الحارس، ولا تنحرف نسختان.
 *
 * لماذا وحدة منفصلة عن claims-rules.mjs: أنماط ذلك الملف لا تغطي إلا لغات الموقع الخمس (العربية والإنجليزية
 * والفرنسية والتركية والصينية). هنا ما يُضاف للغات الجديدة: مفردات الاعتماد والشهادة بكل لغة، ومنع السنوات
 * (لا مواعيد)، ومنع أسعار الباقات وأي رقم ملاصق لرمز عملة (قرار المالك: لا سعر ظاهر)، وفحص لغة النص ونظام كتابته.
 * القواعد العامة (RULES في claims-rules.mjs) تُطبَّق معها بلا تغيير.
 *
 * ⚠️ المصدر الإنجليزي خالٍ من كل مفردات الاعتماد، فالمنع الشامل آمن: أي ظهور في ترجمة يُراجَع لا يُستثنى.
 */
import crypto from 'node:crypto';

/** مفردات الاعتماد والشهادة لكل لغة (حساسة لحالة الأحرف بلا تمييز). ZWNJ مقبول بين الكلمتين في الفارسية والأردية */
const CERT_GROUPS = [
  [['es', 'pt', 'ca', 'gl'], 'certificad|homologad|acreditad|aprobad[oa]s?\\s+por|oficialmente\\s+reconocid'],
  [['fr'], 'certifi|homologu|agréé'],
  [['it'], 'certificat|omologat|accreditat'],
  [['ro'], 'certificat|acreditat|aprobat\\s+de'],
  [['de'], 'zertifiziert|akkreditiert|zugelassen\\s+von|amtlich\\s+anerkannt'],
  [['nl'], 'gecertificeerd|geaccrediteerd'],
  [['sv', 'da', 'no'], 'certifierad|certificeret|sertifisert|godkänd\\s+av|godkendt\\s+af|godkjent\\s+av'],
  [['fi', 'et'], 'sertifioitu|sertifitseeritud'],
  [['pl'], 'certyfikowan|akredytowan|zatwierdzon'],
  [['cs', 'sk'], 'certifikovan'],
  [['sl', 'hr', 'bs', 'sr'], 'certificiran|certifikovan|сертификован'],
  [['hu'], 'tanúsított|minősített'],
  [['lt', 'lv'], 'sertifikuot|sertificēt'],
  [['ru', 'uk', 'bg', 'sr', 'mk', 'kk', 'be'], 'сертифицирован|аккредитован|сертифікован|акредитован|сертифициран|одобрен[аоы]?\\s+(?:ZATCA|налог)'],
  [['el'], 'πιστοποιημέν'],
  [['id', 'ms'], 'bersertifikat|tersertifikasi|diperakui|bertauliah|terakreditasi'],
  [['tl'], 'sertipikado'],
  [['vi'], 'chứng\\s+nhận'],
  [['th'], 'ได้รับการรับรอง'],
  [['ja'], '認証済|認定'],
  [['ko'], '인증'],
  [['zh-hant'], '認證|認可'],
  [['zh'], '认证|认可'],
  [['hi', 'mr', 'ne'], 'प्रमाणित'],
  [['bn'], 'প্রত্যয়িত|সার্টিফাইড'],
  [['ur'], 'تصدیق[\\s\\u200c]*شدہ|منظور[\\s\\u200c]*شدہ'],
  [['fa'], 'تأیید[\\s\\u200c]*شده|گواهی[\\s\\u200c]*شده'],
  [['he'], 'מוסמך|מאושר\\s+על\\s+ידי'],
  [['tr'], 'onaylı|sertifikalı'],
  [['af'], 'gesertifiseer'],
  [['sw'], 'imethibitishwa'],
];

// <cert-stems-ai> مولَّدة — مفردات «معتمد/مرخّص» من وكلاء الترجمة والمراجعة (١١ نوفمبر ٢٠٢٦)، كل جذع مُتحقَّق
// أنه لا يظهر في ترجمة اللغة المنشورة. نص حرفي؛ المسافة تصير \s+ عند البناء.
const CERT_STEMS_AI = {
  ach: ["layisin","certifi"],
  ak: ["tumi krataa","adansedie krataa","apene so","certif","accredit","licens"],
  am: ["የተረጋገጠ","ዕውቅና ያለው","እውቅና ያለው","ሰርተፍኬት","የምስክር ወረቀት","የጸደቀ"],
  as: ["প্ৰমাণিত","প্ৰমাণপত্ৰ","চাৰ্টিফাইড","স্বীকৃতিপ্ৰাপ্ত"],
  ay: ["certifica","acredita","homologa","autoriza","aprobad"],
  az: ["sertifikatl","akkredit","lisenziyal"],
  bem: ["laisensi","satifiketi","certif","licens"],
  bho: ["प्रमाणित","प्रमाणपत्र","सर्टिफाइड","मान्यता प्राप्त","मान्यताप्राप्त"],
  bi: ["setifaed","setifiket","laesens"],
  bm: ["lakodɔnnen","yamaruyasɛbɛn","yamaruya sɛbɛn","yamaruya sɔrɔ"],
  bo: ["ཆོག་མཆན","ལག་ཁྱེར","ཆོག་འཐུས","དཔང་ཡིག"],
  br: ["testeniek","sertifi","aprouet","akreditet"],
  ceb: ["sertipik","sertifik","akredit","lisensyado","aprobado sa"],
  ckb: ["بڕوانامەدار","مۆڵەتدار"],
  co: ["certifi","omologat","accreditat"],
  crs: ["sertif","akredit","lisansye","aprouve par"],
  cy: ["ardystiedig","ardystio","achred","trwyddedig"],
  dv: ["ސެޓިފައިޑް","ސެޓްފައިޑް","ފިކެޓް","ތަޞްދީޤު","ސަރުކާރުން ހުއްދަ","އެކްރެޑިޓ"],
  dz: ["ཆ་འཇོག","ཆོག་ཐམ","ཆོག་མཆན","ངོས་ལེན་ཐོབ","ལག་ཁྱེར་ཐོབ"],
  ee: ["kpeɖodzigbal","mɔɖegbal"],
  eu: ["ziurtagiri","akreditat","homologat"],
  ff: ["certifi","homolog","accrédit","agrément","approuv"],
  fo: ["góðken","sertifi","løggild","viðurkend","akkrediter"],
  fy: ["sertifisear","sertifikaat","akkreditear","goedkard"],
  ga: ["deimhniúchán","creidiúnaith","ceadúnaithe","faofa ag"],
  gaa: ["certif","accredit","licensed","approved","akpɛlɛ nɔ"],
  gd: ["teisteana","barantaich","barantachadh","cead oifigeil"],
  gn: ["certific","homolog","oñemoneĩ"],
  gu: ["પ્રમાણિત","સર્ટિફાઇડ","માન્યતાપ્રાપ્ત","માન્યતા પ્રાપ્ત"],
  ha: ["takardar shaida","lasisi","an amince","hukuma ta amince","satifiket"],
  hmn: ["certif","accredit","licens"],
  ht: ["sètifi","akredit","lisansye","apwouve pa"],
  hy: ["հավաստագրված","սերտիֆիկաց","հավատարմագրված","լիցենզավոր"],
  ig: ["asambodo","akwụkwọ ikike","nkwado gọọmentị","ikike gọọmentị"],
  is: ["vottað","vottuð","vottun","faggil"],
  jv: ["sertifik","akredit","dilisensi"],
  ka: ["სერტიფიცირ","აკრედიტ","ლიცენზირ"],
  kg: ["certifi","homologu","accrédit"],
  kl: ["akuerisa","akuerineqar","akuersissut","certifi","godkend","autoriser"],
  km: ["វិញ្ញាបនបត្រ","ទទួលស្គាល់ជាផ្លូវការ"],
  kn: ["ಪ್ರಮಾಣೀಕೃತ","ಪ್ರಮಾಣೀಕರಿಸಲ್ಪಟ್ಟ","ಪ್ರಮಾಣಪತ್ರ","ಮಾನ್ಯತೆ ಪಡೆದ","ಸರ್ಟಿಫೈಡ್"],
  kri: ["sɛtifay","sɛtifik","certifi","akrɛdit"],
  ku: ["sertîfîk","sertifîk","akredît","akredit","lîsansdar"],
  ky: ["сертификатта","аккредит","лицензиял"],
  lb: ["zertifi","akkredit","homolog","lizenzéiert","konform"],
  lg: ["satifikeeti","satifiketi"],
  ln: ["certifi","accrédit","homologu"],
  lo: ["ໄດ້ຮັບການຮັບຮອງ","ໃບຢັ້ງຢືນ","ຖືກຮັບຮອງ"],
  loz: ["laisensi","lumelezwa ki","lumelezwi ki","tifike"],
  lua: ["certifi","homolog","accrédit","agrément"],
  mai: ["प्रमाणित","प्रमाणपत्र","सर्टिफाइड","मान्यता प्राप्त","मान्यताप्राप्त"],
  mfe: ["sertifi","akredit","lisansie","aprouve par"],
  mg: ["sertifika","nankatoavin","mari-pankatoavana"],
  mi: ["whakamanatia","raihana","tiwhikete"],
  ml: ["സാക്ഷ്യപ്പെടുത്തിയ","സാക്ഷ്യപത്രം","സർട്ടിഫൈഡ്","അംഗീകാരമുള്ള","അംഗീകാരം നേടിയ"],
  mn: ["гэрчилгээжсэн","магадлан итгэмж","сертификаттай","тусгай зөвшөөрөлтэй"],
  mt: ["ċertifikat","certifikat","akkreditat","liċenzjat","approvat minn"],
  my: ["အသိအမှတ်ပြု"],
  nso: ["setifikeiti"],
  ny: ["satifiketi","laisensi"],
  nyn: ["layisensi","layisinsi","satifikeeti","sitifikeeti","certifi"],
  oc: ["certific","omologa","acredit","aprovat"],
  om: ["sertifikeetii","beekamtii argate","hayyama mootummaa","seeraan hayyamame","waraqaa ragaa"],
  or: ["ପ୍ରମାଣିତ","ପ୍ରମାଣପତ୍ର","ସାର୍ଟିଫାଏଡ","ସ୍ୱୀକୃତିପ୍ରାପ୍ତ"],
  pa: ["ਪ੍ਰਮਾਣਿਤ","ਸਰਟੀਫਾਈਡ","ਮਾਨਤਾ ਪ੍ਰਾਪਤ","ਮਾਨਤਾ-ਪ੍ਰਾਪਤ"],
  pcm: ["certifi","accredit","approved by","licensed"],
  ps: ["تصدیق شوی","جواز لرونکی"],
  qu: ["certific","homolog","aprobado","aprobasqa"],
  rm: ["certifi","omologà","conformitad"],
  rn: ["yemewe na","vyemewe na","zemewe na","bwemewe na","yemejwe na","uruhusha rwa Leta"],
  rw: ["seritifika","yemewe na","byemewe na"],
  sd: ["تصديق ٿيل","سند يافته","لائسنس يافته"],
  si: ["සහතිකලත්","සහතිකගත","ප්‍රතීතන"],
  sm: ["fa'amaonia","faamaonia","laisene"],
  sn: ["chitifiketi","setifiketi","satifiketi","rezinesi"],
  so: ["ansixiy","ansixin","shahaad","rukhsad","liisan"],
  sq: ["certifikuar","akredituar","licencuar","miratuar nga"],
  ss: ["sitifiketi"],
  st: ["setifikeiti"],
  su: ["sertifik","akredit","dilisensi"],
  ta: ["சான்றளிக்கப்பட்ட","சான்றிதழ் பெற்ற","அங்கீகாரம் பெற்ற"],
  te: ["సర్టిఫైడ్","ధృవీకరణ పత్రం","ధృవీకరణ పొందిన","గుర్తింపు పొందిన"],
  tet: ["sertifika","akreditasaun","aprovadu","homologadu"],
  tg: ["сертификатдор","сертификатсия","аккредит","иҷозатномадор"],
  ti: ["ምስክር ወረቐት","ዕውቅና ዝረኸበ","ዕውቅና ዘለዎ","ሕጋዊ ፍቓድ","ሰርቲፊኬት"],
  tk: ["sertifikatla","sertifikatly","akkredit","ygtyýarnamaly"],
  tn: ["setifikeiti"],
  to: ["fakamo'oni'i","laiseni","fakangofua'i","sētifiketi","tohi fakamo'oni"],
  tpi: ["setifi","apruvim","apruvol","laisens"],
  ts: ["xitifikheti","satifikheti"],
  tt: ["сертификатлан","аккредит","лицензияле"],
  tum: ["satifiketi","laisensi","layisensi"],
  ug: ["گۇۋاھنامە","ئىجازەتنامىلىك","ئېتىراپ قىلىنغان"],
  uz: ["sertifikatlan","sertifikatga ega","akkredit","litsenziyalangan"],
  wo: ["certifi","homolog","accrédit"],
  xh: ["satifikethi"],
  yi: ["באַגלייביק","ליצענזיר","סערטיפֿיציר","אַקרעדיטיר","אויטאָריזיר"],
  yo: ["ìfọwọ́sí","ìwé-ẹ̀rí"],
  yue: ["認證","認可","持牌"],
  zgh: ["certifi","homologu","accrédit"],
  zu: ["sitifiketi"],
};
for (const [code, stems] of Object.entries(CERT_STEMS_AI)) {
  CERT_GROUPS.push([[code], stems.map((s) => s.replace(/\s+/g, '\\s+')).join('|')]);
}
// </cert-stems-ai>

/** لغات بلا قاعدة اعتماد بعد (فارغة منذ ١١ نوفمبر: لكل لغة منشورة قاعدة) — تحذير «لا قاعدة اعتماد للغة X» */
export const NO_CERT_RULE = Object.freeze([]);

/** مصدر نمط الاعتماد لكل رمز (تجتمع المجموعات التي يظهر فيها الرمز، مثل sr) */
export const CERT_BY_LANG = Object.freeze(CERT_GROUPS.reduce((acc, [codes, src]) => {
  for (const c of codes) acc[c] = acc[c] ? `${acc[c]}|${src}` : src;
  return acc;
}, {}));

/** كريول معجمها إنجليزي (البيدجن النيجيري، الكريو، توك بيسين، البيسلاما) — انظر englishCopies */
export const ENGLISH_LEXIFIER = Object.freeze(['pcm', 'kri', 'tpi', 'bi']);

/**
 * مفاتيح تطابق الإنجليزية حرفياً فتُعدّ نسخاً لا ترجمة (تمنع النشر في المستورد وتُفشل G1 في الحارس).
 * في كريول المعجم الإنجليزي العنوان القصير المطابق («Currency»، «About FieldSales») طبيعيّ لا نسخ: يُقبل حتى
 * ٥ كلمات ما دام المطابق لا يتجاوز ٢٠٪ من القيم — والجمل الأطول تبقى نسخاً. slugHint مستثنى دائماً.
 */
export function englishCopies(code, strings, enStrings) {
  const same = Object.keys(strings).filter((k) => k !== 'tierB.category.slugHint'
    && typeof enStrings[k] === 'string' && strings[k] === enStrings[k]);
  if (!ENGLISH_LEXIFIER.includes(code) || same.length > Object.keys(strings).length * 0.2) return same;
  return same.filter((k) => String(strings[k]).trim().split(/\s+/).length > 5);
}

/** ممنوع في كل اللغات */
export const CERT_ALL = /\b(?:certified|accredited|approved\s+by)\b/i;

/** نمط الاعتماد الخاص بلغة، أو null (لا قاعدة لها) */
export function certRuleFor(code) {
  const src = CERT_BY_LANG[code];
  return src ? new RegExp(`(?:${src})`, 'iu') : null;
}

/**
 * حدود طول وصف meta بالمحارف (G1 في verify-i18n، تحذير). الكتابات المكثّفة — الصينية بنوعيها (zh وzh-hant) واليابانية
 * والكورية والكانتونية — تقول في المحرف ما تقوله اللاتينية في كلمة، فوصفٌ صيني صحيح من ٤٠–٦٠ محرفاً يعادل ١٢٠–١٧٠
 * لاتينياً، وجوجل يقتطعها قرب ٨٠–١٠٠ محرف. فحدّها 25–90 بدل 50–170 (كانت أوصاف zh الصحيحة تُحذَّر قصيرةً، ١١ نوفمبر
 * ٢٠٢٦). اللغات الأخرى على 50–170 كما كانت. الرمز بلغته الأساسية (zh-hant ⇒ zh).
 */
export const DENSE_DESC_LANGS = Object.freeze(['zh', 'ja', 'ko', 'yue']);
export const DESC_BOUNDS = Object.freeze({ default: Object.freeze([50, 170]), dense: Object.freeze([25, 90]) });
export function metaDescBounds(code) {
  const base = String(code ?? '').toLowerCase().split('-')[0];
  return DENSE_DESC_LANGS.includes(base) ? DESC_BOUNDS.dense : DESC_BOUNDS.default;
}

/** أرقام أي نظام عشري (٢٠٢٦ · ۲۰۲۶ · २०२६) إلى لاتينية — كي لا تفلت سنة أو سعر بأرقام محلية */
export function toAsciiDigits(s) {
  return String(s).replace(/\p{Nd}/gu, (d) => {
    const cp = d.codePointAt(0);
    // كل كتلة أرقام عشرية في يونيكود متصلة من الصفر إلى التسعة: نبحث عن صفرها بالرجوع حتى يتوقف النمط
    let zero = cp;
    while (zero > cp - 9 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
    return String((cp - zero) % 10);
  });
}

/** سنة 19xx أو 20xx بحدود رقمية — لا مواعيد في نص جديد إلا سنة التأسيس في مفتاحيها */
export const YEAR_RE = /(?<!\d)(?:19|20)\d{2}(?!\d)/;
export const YEAR_KEYS = Object.freeze(['tierB.about.description', 'tierB.about.body.0']);

/** رقم سعر باقة حيّ أو مضاعفه ×10 (السنوي)، بفاصل آلاف اختياري، بحدود رقمية */
export function livePriceRe(livePrices) {
  const nums = new Set();
  for (const p of livePrices || []) {
    const s = String(p).trim();
    if (!/^\d+$/.test(s)) continue;
    nums.add(s);
    nums.add(`${s}0`);
  }
  if (!nums.size) return null;
  const alt = [...nums].sort((a, b) => b.length - a.length).map((n) => (n.length > 3
    ? `${n.slice(0, -3)}[,.\\u00a0\\u202f\\u2009 ]?${n.slice(-3)}`
    : n));
  return new RegExp(`(?<![\\d.,])(?:${alt.join('|')})(?![\\d])`);
}

let currencyCodesCache = null;
function currencyCodes() {
  if (currencyCodesCache) return currencyCodesCache;
  let list = [];
  try { list = Intl.supportedValuesOf('currency'); } catch { /* Node قديم — قائمة احتياطية */ }
  if (!list.length) list = ['SAR', 'AED', 'USD', 'EUR', 'GBP', 'EGP', 'KWD', 'QAR', 'OMR', 'BHD', 'JOD', 'TRY', 'CNY', 'INR', 'PKR', 'IDR', 'MYR', 'BRL', 'MXN', 'RUB'];
  currencyCodesCache = list.filter((c) => /^[A-Z]{3}$/.test(c));
  return currencyCodesCache;
}

/** رقم ملاصق (حتى 3 أحرف) لرمز عملة ISO 4217 أو لرمز $ € £ ¥ ₹ ₺ ﷼ ر.س — قبله أو بعده */
let currencyReCache = null;
export function currencyNumberRe() {
  if (currencyReCache) return currencyReCache;
  const cur = `(?:(?<![A-Za-z])(?:${currencyCodes().join('|')})(?![A-Za-z])|[$€£¥₹₺﷼]|ر\\.س)`;
  currencyReCache = new RegExp(`\\d[^\\n\\d]{0,3}?${cur}|${cur}[^\\n\\d]{0,3}?\\d`, 'u');
  return currencyReCache;
}

/** وصف كل قاعدة بالعربية — يطبعه المستورد والحارس */
export const I18N_RULE_WHY = Object.freeze({
  'i18n-certification': 'مفردات اعتماد أو شهادة — ZATCA لا تعتمد مزوّدي البرمجيات، ولا شهادة نملكها',
  'i18n-year': 'سنة في نص جديد — لا مواعيد (المسموح سنة التأسيس في وصف «من نحن» وفقرته الأولى)',
  'i18n-live-price': 'سعر باقة حيّ أو سنويّ — قرار المالك: لا سعر ظاهر (طلب عرض سعر مكانه)',
  'i18n-currency-number': 'رقم ملاصق لرمز عملة — لا أسعار في صفحات الطبقة',
});

/**
 * مخالفات قواعد الطبقة في نصّ واحد.
 * opts.code: رمز اللغة (لقاعدة الاعتماد الخاصة بها) · opts.livePrices: أسعار الباقات الحيّة ·
 * opts.allowYear: لا يُفحص السنة (مفتاحا سنة التأسيس، أو صفحة «من نحن») · opts.skipCurrency: لا يُفحص الرقم الملاصق للعملة.
 */
export function findI18nViolations(text, opts = {}) {
  const out = [];
  const raw = String(text ?? '');
  const t = toAsciiDigits(raw);
  const hit = (id, m) => out.push({ id, match: String(m).slice(0, 60), why: I18N_RULE_WHY[id] });
  let m = raw.match(CERT_ALL);
  if (m) hit('i18n-certification', m[0]);
  const cert = opts.code ? certRuleFor(opts.code) : null;
  if (cert && (m = raw.match(cert))) hit('i18n-certification', m[0]);
  if (!opts.allowYear && (m = t.match(YEAR_RE))) hit('i18n-year', m[0]);
  const pr = livePriceRe(opts.livePrices);
  if (pr && (m = t.match(pr))) hit('i18n-live-price', m[0]);
  if (!opts.skipCurrency && (m = t.match(currencyNumberRe()))) hit('i18n-currency-number', m[0]);
  return out;
}

/** مخالفات قيم ملف محتوى، كلّ مفتاح وحده (سنة التأسيس مسموحة في مفتاحيها وحدهما) */
export function checkMarketingStrings(strings, opts = {}) {
  const out = [];
  for (const [key, value] of Object.entries(strings || {})) {
    if (key === 'tierB.category.slugHint') continue;
    for (const v of findI18nViolations(value, { ...opts, allowYear: YEAR_KEYS.includes(key) })) out.push({ ...v, key });
  }
  return out;
}

// ─── لغة النص ونظام كتابته (G4) ────────────────────────────────────────────────────────────

/** العلامات المسموحة بأي لغة — تُحذف قبل حساب النسبة (الأطول أولاً) */
export const BRAND_TOKENS = Object.freeze([
  'FieldSales', 'Field Sales', 'WhatsApp', 'ZATCA', 'Fatoora', 'Android', 'iPhone', 'iOS', 'Google Play', 'App Store',
  'Bluetooth', 'ERP', 'API', 'GPS', 'QR', 'VAT', 'DSD', 'FMCG', 'PDF', 'Excel',
]);
const BRAND_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...BRAND_TOKENS].sort((a, b) => b.length - a.length)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
export const stripBrands = (s) => String(s ?? '').replace(BRAND_RE, ' ');

/** الاسم العربي للعلامة — مسموح مرة في نص «من نحن» بكل اللغات */
export const AR_BRAND = 'فيلد سيلز';

/** نظام الكتابة في السجل ⇒ خصائص يونيكود (Script_Extensions) */
export const SCRIPT_PROPS = Object.freeze({
  Latn: ['Latin'], Cyrl: ['Cyrillic'], Arab: ['Arabic'], Hebr: ['Hebrew'], Grek: ['Greek'], Thai: ['Thai'],
  Deva: ['Devanagari'], Beng: ['Bengali'], Geor: ['Georgian'], Armn: ['Armenian'], Gujr: ['Gujarati'], Guru: ['Gurmukhi'],
  Taml: ['Tamil'], Telu: ['Telugu'], Knda: ['Kannada'], Mlym: ['Malayalam'], Sinh: ['Sinhala'], Ethi: ['Ethiopic'],
  Mymr: ['Myanmar'], Khmr: ['Khmer'], Laoo: ['Lao'], Tibt: ['Tibetan'], Thaa: ['Thaana'], Orya: ['Oriya'],
  Hans: ['Han'], Hant: ['Han'], Jpan: ['Han', 'Hiragana', 'Katakana'], Kore: ['Hangul', 'Han'], Tfng: ['Tifinagh'],
});

/** الحروف المميزة: صفحة عربية لا تمرّ بديلاً عن الأردية أو الفارسية */
export const DISTINCT_LETTERS = Object.freeze({ ur: 'پچژگکیےٹڈڑںھ', fa: 'پچژگکی' });
export const DISTINCT_MIN = 20;
/** علامات ثابتة للتمييز بين الصينية المبسّطة والتقليدية */
export const HANS_MARKERS = '们这为发时与对会后国销业务库关们';
export const HANT_MARKERS = '們這為發時與對會後國銷業務庫關';

const countIn = (text, set) => {
  let n = 0;
  for (const ch of text) if (set.includes(ch)) n++;
  return n;
};
const countRe = (text, re) => (text.match(re) || []).length;

/**
 * مشكلات لغة النص لصفحة أو لمجموعة نصوص لغة واحدة (فارغة = سليم).
 * opts: { script, code, hreflang, minRatio? }. يُحذف من النص قبل الحساب: العلامات المسموحة، و«فيلد سيلز» لغير العربية.
 */
export function scriptProblems(text, opts = {}) {
  const problems = [];
  const { script, code } = opts;
  let t = stripBrands(text);
  if (script !== 'Arab') t = t.split(AR_BRAND).join(' ');
  const letters = countRe(t, /\p{L}/gu);
  if (!letters) return problems;
  const props = SCRIPT_PROPS[script];
  if (!props) {
    problems.push(`نظام كتابة غير معروف «${script}» — لا فحص نسبة`);
    return problems;
  }
  const inScript = countRe(t, new RegExp(`(?=\\p{L})(?:${props.map((p) => `\\p{scx=${p}}`).join('|')})`, 'gu'));
  const ratio = inScript / letters;
  const min = opts.minRatio ?? (script === 'Latn' ? 0.9 : 0.6);
  if (ratio < min) problems.push(`نسبة حروف ${script} ${(ratio * 100).toFixed(1)}٪ أقل من ${Math.round(min * 100)}٪`);
  if (script !== 'Arab') {
    const ar = t.match(/(?=\p{L})\p{Script=Arabic}+/u);
    if (ar) problems.push(`حرف عربي النص في صفحة ${script}: «${ar[0].slice(0, 20)}»`);
  }
  const distinct = DISTINCT_LETTERS[code];
  if (distinct) {
    const n = countIn(t, distinct);
    if (n < DISTINCT_MIN) problems.push(`${n} حرفاً مميزاً للغة ${code} فقط (الحد ${DISTINCT_MIN}) — قد يكون النص عربياً لا ${code}`);
  }
  if (script === 'Hans' || script === 'Hant') {
    const right = countIn(t, script === 'Hans' ? HANS_MARKERS : HANT_MARKERS);
    const wrong = countIn(t, script === 'Hans' ? HANT_MARKERS : HANS_MARKERS);
    const han = countRe(t, /\p{Script=Han}/gu);
    if (wrong > 0 && wrong * 10 >= right) problems.push(`${script === 'Hans' ? 'صفحة مبسّطة' : 'صفحة تقليدية'} فيها ${wrong} علامة من الكتابة الأخرى مقابل ${right}`);
    else if (han >= 40 && right === 0) problems.push(`لا علامة ${script === 'Hans' ? 'مبسّطة' : 'تقليدية'} في ${han} حرفاً صينياً`);
  }
  if (script === 'Jpan') {
    const kana = countRe(t, /[\p{scx=Hiragana}\p{scx=Katakana}]/gu);
    if (kana / letters < 0.05) problems.push('صفحة يابانية بلا كانا تقريباً — قد يكون النص صينياً');
  }
  if (script === 'Kore') {
    const hangul = countRe(t, /\p{scx=Hangul}/gu);
    if (hangul / letters < 0.3) problems.push('صفحة كورية بلا هانغول كافٍ');
  }
  return problems;
}

// ─── أدوات مشتركة للمستورد والحارس ─────────────────────────────────────────────────────

/** بصمة المحتوى: sha256 لـJSON.stringify(strings) بترتيب مفاتيحه في الملف */
export function contentHashOf(strings) {
  return crypto.createHash('sha256').update(JSON.stringify(strings ?? {})).digest('hex');
}

/** المفاتيح النائبة في قيمة ({uiLanguages} · {countriesCount} · {year}) مجموعةً مرتبة */
export const placeholdersOf = (s) => [...new Set(String(s ?? '').match(/\{[A-Za-z0-9_]+\}/g) || [])].sort();

/**
 * سطر published.json لكل لغة منشورة في locales.json — المستورد يكتبه والحارس (G0) يعيد اشتقاقه ويقارن.
 * waLabel من نصّ زرّ واتساب في ملف محتوى اللغة.
 */
export function publishedEntry(loc, waLabel) {
  return {
    code: loc.code, hreflang: loc.hreflang, name: loc.name, nativeName: loc.nativeName, dir: loc.dir,
    legacy: !!loc.legacy, tier: loc.tier, ogLocale: loc.ogLocale, intlLocale: loc.intlLocale, slug: loc.slug,
    pages: [...(loc.pages || [])], waLabel: String(waLabel ?? ''), contentDate: loc.contentDate,
    // تواريخ النشر الأول (lastmod عناقيد hreflang في gen-sitemap) — حين تخالف contentDate وحدها
    ...(loc.since ? { since: loc.since } : {}),
    ...(loc.pagesSince && Object.keys(loc.pagesSince).length ? { pagesSince: { ...loc.pagesSince } } : {}),
  };
}
