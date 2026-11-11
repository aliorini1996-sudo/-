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
  'i18n-year-self': 'سنة أو تاريخ في جملة عن FieldSales نفسها (الاسم أو المتكلم أو صيغه) — لا موعد قرب FieldSales، والربط خارج السعودية «عند الطلب» بلا موعد (التاريخ مسموح في جمل حقائق الدولة وعناوين المصادر)',
  'i18n-gov-link': 'ادّعاء ربط أو تأهيل حكومي لـFieldSales خارج السعودية — الربط الحيّ في السعودية وحدها، وغيرها «عند الطلب» بلا وعد',
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

// ─── صفحات الدول (نوع «country») ────────────────────────────────────────────────────────────
//
// قاعدة السنة على صفحة الدولة على مستوى **الجملة** في الصفحة كلها (قرار المنسّق ١١ نوفمبر، متّسق مع قاعدة الكتالوج
// وقرار المالك «لا موعد ولا رقم قرب جملة الربط»): السنة أو التاريخ محجوب في كل جملة عن FieldSales نفسها (الاسم،
// أو ضمير المتكلم/المتكلمين وملكيّته، أو صيغ المتكلمين، أو «التطبيق» مشاراً إليه — selfYearViolations)، ومسموح في
// الجمل التي تصف الدولة وقوانينها وسوقها (حقائق بمصدر) وفي عناوين المصادر (أسماء وثائق) — أيّ قسم كانت فيه.
// استثناءان:
//   · H1 حاجبٌ للسنة كله: يُعاد نشره خارج صفحته (قائمة صفحات اللغة في كل صفحة أخرى، وllms.txt اللغة) حيث السنة
//     محجوبة بلا استثناء — فلا يُنشر ما يُسقط تلك الصفحات.
//   · ختم «آخر تحقق»: عنصر يفرضه القالب بتاريخ basedOnFactsVerifiedAt، فلا تمرّ فيه إلا سنة ذلك التاريخ نفسها.
// قاعدة رقم+عملة والاعتماد والسعر الحيّ حاجبة في كل الصفحة بلا استثناء (عناوين المصادر منها)، وادّعاء الربط الحكومي كذلك.

/**
 * نصوص محتوى لغة واحدة من ملف الدولة، كلٌّ بمساره ونطاق السنة فيه:
 * year = 'sentence' (السنة/التاريخ محجوب في جملة عن FieldSales وحدها) · 'block' (H1: السنة محجوبة كلها) ·
 * 'stamp' (ختم آخر تحقق: سنة التحقق وحدها).
 * slugHint والروابط (url) خارج الفحص: الأول يُطبَّع إلى مسار، والثانية عناوين لا نصّ.
 */
export function countryContentTexts(c) {
  const out = [];
  const add = (p, v, year = 'sentence') => { if (typeof v === 'string' && v.trim()) out.push({ path: p, text: v, year }); };
  if (!c || typeof c !== 'object') return out;
  add('title', c.title); add('description', c.description); add('h1', c.h1, 'block'); add('intro', c.intro);
  (Array.isArray(c.sections) ? c.sections : []).forEach((s, i) => {
    add(`sections.${s && s.id ? s.id : i}.title`, s && s.title);
    add(`sections.${s && s.id ? s.id : i}.body`, s && s.body);
  });
  (Array.isArray(c.faq) ? c.faq : []).forEach((f, i) => { add(`faq.${i}.q`, f && f.q); add(`faq.${i}.a`, f && f.a); });
  const si = c.sampleInvoice || {};
  add('sampleInvoice.title', si.title); add('sampleInvoice.note', si.note);
  (Array.isArray(si.fields) ? si.fields : []).forEach((f, i) => { add(`sampleInvoice.fields.${i}.label`, f && f.label); add(`sampleInvoice.fields.${i}.example`, f && f.example); });
  (Array.isArray(c.sources) ? c.sources : []).forEach((s, i) => {
    for (const k of ['title', 'label', 'name']) add(`sources.${i}.${k}`, s && s[k]);
  });
  add('sourcesTitle', c.sourcesTitle);
  add('lastVerifiedLabel', c.lastVerifiedLabel, 'stamp');
  return out;
}

/**
 * ختم «آخر تحقق»: لا يحمل إلا سنة تاريخ التحقق (أو لا سنة)، ولا رقماً آخر غير يوم/شهر/سنة ذلك التاريخ.
 * يعيد null إن سلِم، وإلا وصف الخلل.
 */
export function stampProblem(text, verifiedAt) {
  const m = String(verifiedAt ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return `تاريخ التحقق «${verifiedAt}» ليس YYYY-MM-DD`;
  const [, y, mo, d] = m;
  const allowed = new Set([y, mo, d, String(Number(mo)), String(Number(d))]);
  const nums = toAsciiDigits(text).match(/\d+/g) || [];
  const bad = nums.filter((n) => !allowed.has(n));
  if (bad.length) return `رقم «${bad[0]}» في ختم آخر تحقق ليس من تاريخ التحقق ${verifiedAt}`;
  return null;
}

/**
 * مخالفات قواعد الطبقة في محتوى لغة من ملف الدولة — يطبّقها المستورد (import-country-i18n) والحارس (verify-i18n G5)
 * والاختبارات. opts: { code, livePrices, verifiedAt }.
 */
export function checkCountryContent(c, opts = {}) {
  const out = [];
  if (!hasCountryClaimRules(opts.code)) {
    out.push({ id: 'i18n-gov-link', match: String(opts.code), path: '(lang)', why: `لا قاعدة جملة (ادّعاء الربط والسنة قرب FieldSales) للغة «${opts.code}» — لا تُنشر صفحة دولة بها قبل إضافتها في COUNTRY_CLAIMS` });
    return out;
  }
  for (const t of countryContentTexts(c)) {
    // الاعتماد والسعر الحيّ ورقم+عملة في كل نصّ؛ والسنة كلها في H1 وحده
    for (const v of findI18nViolations(t.text, { code: opts.code, livePrices: opts.livePrices, allowYear: t.year !== 'block' })) {
      out.push({ ...v, path: t.path });
    }
    // السنة أو التاريخ محجوب في كل جملة عن FieldSales نفسها — أيّ قسم كانت فيه (والأسئلة ومثال الفاتورة وعناوين المصادر)
    if (t.year !== 'stamp') {
      for (const v of selfYearViolations(t.text, opts.code)) out.push({ ...v, path: t.path });
      for (const v of govLinkViolations(t.text, opts.code)) out.push({ ...v, path: t.path });
    }
    if (t.year === 'stamp') {
      const p = stampProblem(t.text, opts.verifiedAt);
      if (p) out.push({ id: 'i18n-year', match: t.text.slice(0, 60), why: `${I18N_RULE_WHY['i18n-year']} — ${p}`, path: t.path });
    }
  }
  return out;
}

// ─── قواعد الجملة لصفحات الدول: السنة أو التاريخ قرب FieldSales، وادّعاء الربط الحكومي ─────────────────────
//
// تعمل على الجملة (لا على نافذة أحرف): النافذة حول الاسم تلتقط تاريخاً حكومياً صحيحاً في الجملة السابقة لجملة
// الإفصاح («…obligatoria desde 2014. FieldSales no emite CFDI») فتحجب حقيقة مسموحة، والجملة لا.
// الجملة تنتهي بـ. ! ? … (وما يليها من علامة إغلاق) يليها فراغ ثم حرف ليس صغيراً، أو بسطر جديد (الفقرة)؛ و«4.0»
// و«1/12/2026» لا تقطعانها، ولا نقطة اختصار («S.A. de C.V.» · «EE. UU.» · «art.» — انظر sentencesOf).

/**
 * لكل لغة صفحة دولة:
 *  self   — ما يجعل الجملة كلاماً عن FieldSales نفسها: الاسم، وضمير المتكلم وملكيّته، وصيغ المتكلمين (كل فعل
 *           بصيغة المتكلمين في es · pt — FIRST_PLURAL — والمستقبل وأفعال الربط)، و«التطبيق» مشاراً إليه («la app»).
 *  months — أسماء الشهور (التاريخ بلا سنة في جملة عن FieldSales موعدٌ أيضاً).
 *  link   — أفعال الربط والإرسال والتأهيل لدى جهة.
 *  auth   — الجهة الحكومية أو مستندها (لا ادّعاء ربط بلا جهة: «conectado a internet» ليس ادّعاءً).
 *  neg    — النفي وصيغة «عند الطلب» (الجملة الصادقة اليوم: «لا ربط»، أو «متاح عند الطلب بلا موعد»).
 *  saudi  — الربط الحيّ الوحيد (السعودية) — ذكرها صادق.
 * لغةٌ بلا مدخل هنا لا تُنشر لها صفحة دولة (checkCountryContent يحجبها).
 */
const COUNTRY_CLAIMS = Object.freeze({
  es: {
    self: [
      'FieldSales', 'nosotr[oa]s', 'nuestr[oa]s?', '\\p{L}+(?:aremos|eremos|iremos)', 'vamos', 'conectamos', 'integramos', 'transmitimos', 'timbramos', 'enviamos', 'reportamos', 'somos',
      '(?:la|esta)\\s+app(?!\\s+del?(?![\\p{L}\\p{N}]))',
    ],
    months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'se?ptiembre', 'octubre', 'noviembre', 'diciembre'],
    link: [
      'conectad[oa]s?\\s+(?:directamente\\s+)?(?:con|a|al)', '(?:se\\s+)?conecta(?:mos|n)?\\s+(?:directamente\\s+)?(?:con|a|al)',
      'integrad[oa]s?\\s+(?:directamente\\s+)?(?:con|a|al)', '(?:se\\s+)?integra(?:mos|n)?\\s+(?:directamente\\s+)?(?:con|a|al)',
      'transmit\\p{L}*', 'habilitad[oa]s?\\s+(?:por|ante)', 'autorizad[oa]s?\\s+(?:por|ante)', 'registrad[oa]s?\\s+ante',
      '(?:es|somos)\\s+(?:un\\s+)?(?:proveedor(?:es)?\\s+tecnol[oó]gicos?|PAC)', 'timbra(?:mos|n)?',
    ],
    auth: ['DIAN', 'SAT', 'SFE', 'RADIAN', 'CFDI', 'PAC', 'Hacienda', 'autoridad(?:es)?\\s+(?:tributaria|fiscal)(?:es)?', 'gobierno', 'gubernamental(?:es)?', 'factura(?:s|ción)?\\s+electr[oó]nicas?'],
    neg: ['no', 'nunca', 'ni', 'tampoco', 'bajo\\s+solicitud', 'a\\s+solicitud', 'previa\\s+solicitud'],
    saudi: ['Arabia\\s+Saud(?:ita|í)', 'ZATCA'],
  },
  pt: {
    self: [
      'FieldSales', 'nós', 'noss[oa]s?', '\\p{L}+(?:aremos|eremos|iremos)', 'vamos', 'conectamos', 'integramos', 'transmitimos', 'enviamos', 'somos',
      '(?:o|a|este|esta)\\s+(?:app|aplicativo)(?!\\s+d[eoa]s?(?![\\p{L}\\p{N}]))',
    ],
    months: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
    link: [
      'conectad[oa]s?\\s+(?:diretamente\\s+)?(?:com|[àa]o?s?)', '(?:se\\s+)?conecta(?:mos|m)?(?:-se)?\\s+(?:diretamente\\s+)?(?:com|[àa]o?s?)',
      'integrad[oa]s?\\s+(?:diretamente\\s+)?(?:com|[àa]o?s?)', '(?:se\\s+)?integra(?:mos|m)?(?:-se)?\\s+(?:diretamente\\s+)?(?:com|[àa]o?s?)',
      'transmit\\p{L}*', 'credenciad[oa]s?', 'habilitad[oa]s?\\s+(?:pel[oa]s?|junto)', 'autorizad[oa]s?\\s+(?:pel[oa]s?|junto)',
      '(?:é|somos)\\s+(?:um\\s+)?provedor(?:es)?\\s+(?:tecnol[oó]gicos?|autorizad[oa]s?|credenciad[oa]s?)',
    ],
    auth: ['SEFAZ', 'Receita(?:\\s+Federal)?', 'fisco', 'CGIBS', 'prefeituras?', 'NF-?e', 'NFC-?e', 'NFS-?e', 'notas?\\s+fisca(?:l|is)', 'autoridade(?:s)?\\s+(?:fiscal|fiscais|tribut[aá]ria)', 'governo', 'governamenta(?:l|is)'],
    neg: ['não', 'nunca', 'nem', 'tampouco', 'sob\\s+demanda', 'sob\\s+consulta', 'mediante\\s+solicitação', 'a\\s+pedido'],
    saudi: ['Ar[aá]bia\\s+Saudita', 'ZATCA'],
  },
  id: {
    self: ['FieldSales', 'kami', 'kita', 'aplikasi\\s+ini'],
    months: ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'],
    link: [
      'terhubung\\s+(?:langsung\\s+)?(?:ke|dengan)', 'terintegrasi\\s+(?:langsung\\s+)?(?:ke|dengan)', 'terkoneksi', 'tersambung\\s+(?:ke|dengan)',
      'mengirim(?:kan)?\\s+(?:faktur|data)', '(?:adalah|sebagai|merupakan)\\s+(?:PJAP|penyedia\\s+jasa\\s+aplikasi\\s+perpajakan|mitra\\s+resmi)',
      'terdaftar\\s+(?:sebagai|di)', 'resmi\\s+(?:bermitra|terdaftar)',
    ],
    auth: ['DJP', 'Coretax', 'e-?Faktur', 'faktur\\s+pajak', 'pemerintah', 'otoritas\\s+pajak', 'PJAP', 'Direktorat\\s+Jenderal\\s+Pajak'],
    neg: ['tidak', 'belum', 'bukan', 'atas\\s+permintaan'],
    saudi: ['Arab\\s+Saudi', 'ZATCA'],
  },
});

/**
 * صيغة المتكلمين في es · pt (حاضر وماضٍ ومضارع التزامي وشرطي): كلمة تنتهي بـ-amos/-emos/-imos بلا حرف منبَّر
 * («ofrecemos» · «estudiamos» · «temos»)، أو بنهايات المتكلمين المنبَّرة («teníamos» · «estávamos» · «pudiéramos»).
 * المنبَّر غير ذلك صفةٌ أو اسم لا فعل («mínimos» · «últimos» · «próximos» · «préstamos»)، والأسماء غير المنبَّرة
 * بالنهاية نفسها مستثناة بالاسم (FIRST_PLURAL_NOT).
 */
const FIRST_PLURAL_NOT = ['ramos', 'tramos', '\\p{L}*gramos', 'reclamos', 'amos', 'gamos', 'extremos', 'supremos', 'remos', 'memos', 'primos', 'racimos'];
const FIRST_PLURAL = `(?!(?:${FIRST_PLURAL_NOT.join('|')})(?![\\p{L}\\p{N}]))`
  + '(?:[^\\P{L}áéíóúâêôãõ]+(?:amos|emos|imos)|\\p{L}+(?:íamos|ábamos|ávamos|áramos|éramos|êramos|íramos|ásemos|ésemos|ássemos|êssemos|íssemos|ôssemos|ínhamos))';
const FIRST_PLURAL_LANGS = Object.freeze(['es', 'pt']);

const word = (alts) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const claimReCache = new Map();
function claimRes(code) {
  if (!COUNTRY_CLAIMS[code]) return null;
  if (!claimReCache.has(code)) {
    const r = COUNTRY_CLAIMS[code];
    claimReCache.set(code, {
      self: word([...r.self, ...(FIRST_PLURAL_LANGS.includes(code) ? [FIRST_PLURAL] : [])]),
      months: word(r.months), link: word(r.link), auth: word(r.auth), neg: word(r.neg), saudi: word(r.saudi),
    });
  }
  return claimReCache.get(code);
}

/** هل للغة قواعد جملة صفحات الدول */
export const hasCountryClaimRules = (code) => !!COUNTRY_CLAIMS[code];

/** هل الجملة كلامٌ عن FieldSales نفسها (الاسم أو المتكلم أو صيغه أو «التطبيق» مشاراً إليه) — false للغة بلا قاعدة */
export const isSelfSentence = (s, code) => {
  const R = claimRes(code);
  return !!(R && R.self.test(s));
};

/** نقاط اختصار لا تُنهي جملة (والحرف الواحد قبل النقطة كذلك: «S.A.» · «C.V.» · «p. ej.») */
const ABBREV = new Set(['ee', 'uu', 'art', 'arts', 'núm', 'núms', 'nº', 'pág', 'págs', 'sr', 'sra', 'sres', 'dr', 'dra', 'lic', 'ing', 'ltda', 'cía', 'cia', 'tbk', 'dll', 'dsb', 'dst', 'aprox', 'vs', 'inc']);

/**
 * جمل نصّ: تنتهي بـ. ! ? … (وعلامة إغلاق اختيارية) يليها فراغ ثم حرف ليس صغيراً، أو بسطر جديد. النقطة بعد حرف واحد
 * أو اختصار معروف لا تُنهي جملة: قطعها كان سيعزل السنة عن FieldSales في جملة واحدة («FieldSales factura a S.A. de
 * C.V. desde 2027»)، والجملة الأطول أحوط.
 */
export function sentencesOf(text) {
  const t = String(text ?? '');
  const out = [];
  let from = 0;
  for (const m of t.matchAll(/([.!?…])["'»”’)\]]*\s+(?=[^\s\p{Ll}])|\n+/gu)) {
    if (m[1] === '.') {
      const before = t.slice(from, m.index).match(/([\p{L}º]+)$/u);
      if (before && (before[1].length === 1 || ABBREV.has(before[1].toLowerCase()))) continue;
    }
    out.push(t.slice(from, m.index + m[0].length));
    from = m.index + m[0].length;
  }
  out.push(t.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * أول سنة أو تاريخ في جملة (السنة، ومنها «1/12/2026» · أو اسم شهر بلغة الصفحة) أو null.
 * «يوم/شهر» رقمياً بلا سنة لا يُعدّ تاريخاً: يطابق الكسر حرفاً بحرف («DPP nilai lain (11/12)» في صفحة إندونيسيا
 * المنشورة) و«24/7»، والتاريخ في النثر يُكتب باسم الشهر.
 */
export function dateIn(s, code) {
  const R = claimRes(code);
  const m = toAsciiDigits(s).match(YEAR_RE) || (R ? String(s).match(R.months) : null);
  return m ? m[0] : null;
}

/**
 * السنة أو التاريخ في جملة عن FieldSales نفسها — في كل نصوص صفحة الدولة (عدا ختم «آخر تحقق»): لا موعد قرب
 * FieldSales. الجملة التي تصف الدولة وقوانينها وسوقها تمرّ بتاريخها، ولو سبقت أو تلت مباشرة جملة عن FieldSales.
 */
export function selfYearViolations(text, code) {
  const R = claimRes(code);
  if (!R) return [];
  const out = [];
  for (const s of sentencesOf(text)) {
    if (R.self.test(s) && dateIn(s, code)) out.push({ id: 'i18n-year-self', match: s.slice(0, 60), why: I18N_RULE_WHY['i18n-year-self'] });
  }
  return out;
}

/**
 * ادّعاء ربط حكومي: جملة عن FieldSales نفسها + فعل ربط أو تأهيل + جهة حكومية، بلا نفي ولا «عند الطلب» ولا ذكر
 * السعودية. السؤال (ينتهي بـ?) ليس ادّعاءً.
 */
export function govLinkViolations(text, code) {
  const R = claimRes(code);
  if (!R) return [];
  const out = [];
  for (const s of sentencesOf(text)) {
    if (/[?？]["'»”’)\]]*$/.test(s)) continue;
    if (R.self.test(s) && R.link.test(s) && R.auth.test(s) && !R.neg.test(s) && !R.saudi.test(s)) {
      out.push({ id: 'i18n-gov-link', match: s.slice(0, 60), why: I18N_RULE_WHY['i18n-gov-link'] });
    }
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
  };
}
