/**
 * قواعد حارس الادّعاءات — مفصولة عن verify-claims.mjs كي يختبرها
 * src/content/claimsGuard.test.ts بالقواعد نفسها التي تحرس dist (لا نسخة موازية تنحرف).
 *
 * كل قاعدة: نمط + سبب + استثناء اختياري يمنع الإنذار الكاذب.
 *  - unless + unlessBefore/unlessAfter: نفي صريح في نافذة حول المطابقة يُعفيها (الافتراضي ±220).
 *  - requireNear: لا تُعدّ المطابقة إصابة إلا إن وُجد نمط آخر قربها (مثل موعد أو رقم).
 *  - severity: 'warn' تحذير يُطبع ولا يُفشل البناء؛ غيابها = حاجبة.
 *  - cmsWarn: حاجبة لنصوص المستودع وتحذير لنصوص CMS — verify-claims يسند كل مطابقة بسياقها (fromCmsContext).
 *  - scope: 'head' (العنوان والوصف وH1) · 'raw' (HTML الخام) · الافتراضي النصّ المرئي.
 *  - paths / exceptPaths: تقصر القاعدة في verify-claims على ملفات dist التي يطابق مسارها النسبي paths ولا يطابق
 *    exceptPaths (الفاصل / أو \). checkText في الاختبارات يطبّقها على أي نصّ بلا مسار.
 *
 * ⚠️ كل نصّ يُطبَّع بـnorm (حذف التشكيل والتطويل) قبل الفحص، والأنماط مكتوبة بلا تشكيل:
 *    كان النمط «مُفعّل» لا يطابق «مفعّل» ولا «مفعل»، و«مُعتمَد» يفلت من «معتمد».
 *  - keywords: verify-claims يُلحق بالنطاق محتوى <meta name="keywords"> (قواعد القاموس: الاستهداف لا المتن).
 *  - glossary: رمز لغة قاعدة من قاموس المصطلحات (src/i18n/glossary) — تُستثنى من checkText (انظر checkGlossary).
 */
import { RESERVED_SEGMENTS } from '../src/i18n/i18nRoutes.mjs';

/** حذف التشكيل (U+064B–U+0652) والألف الخنجرية (U+0670) والتطويل (U+0640) */
export const norm = (s) => String(s).replace(/[ً-ْٰـ]/g, '');

/**
 * ⚠️ خطوة ما بعد تحرير نفي CMS الواحدة: اقلب هذا العلم إلى true.
 * فتصير قاعدة النفي القديم حاجبة، واختبار claimsGuard.test.ts يقرأ العلم نفسه فلا يفشل
 * (كان التعليق يقول «احذف severity» والاختبار يثبّت 'warn' ⇒ الخطوة الموثّقة تُفشل web-ci).
 * بنود CMS التي تُحرَّر قبل القلب: docs/owner-actions.md §٨.
 * قبل القلب: verify-claims يحجب النفي القديم الآتي من **نصوص المستودع** (الربط حيّ، فلا عذر له)،
 * ويُبقي الآتي من **CMS** وحده تحذيراً (الإسناد: cmsCorpus/fromCms أدناه). بعد القلب: كله حاجب.
 */
export const PHASE2_CMS_CLEANED = false;

/** حدود الكلمة العربية: \b في JS لاتيني فقط، فـ«مارس» كانت ستطابق داخل «ممارسة» */
const AR = '\\u0600-\\u06FF';

/**
 * مصطلح المرحلة الثانية بلغات الموقع الخمس. يطابق «للمرحلة» (اللام تُسقط ألف «ال»)
 * و«المرحله الثانيه» (التاء المربوطة هاءً) — كانت «جاهز للمرحلة الثانية منذ 2026»
 * و«المرحله الثانيه مفعله» تفلتان من المصطلح نفسه.
 */
export const PHASE2 = '(?:(?:ال|لل)مرحل[ةه]\\s*(?:الثاني[ةه]|2|٢)|Phase\\s*(?:2|II|two)\\b|phase\\s*deux|2\\.\\s*Aşama|第二阶段)';
/** المرحلة الأولى — بأل وبلاها («مرحلة أولى» في مقال CMS كانت تفلت) وبالهمزة وبلاها */
export const PHASE1 = '(?:(?:ال|لل)مرحل[ةه]\\s*ال[أا]ول[ىي]|مرحل[ةه]\\s*[أا]ول[ىي]|Phase[\\s-]*(?:1|one|un)\\b)';

/**
 * ⚠️ الفارق الحاكم: **ادّعاء دعم** ما لم يُبنَ ممنوع، و**الذكر التعليمي** مشروع بل مطلوب.
 * مقال يشرح لائحة المرحلة الثانية أو نظام ETA المصري محتوى نافع. لذا تُطابَق أفعال الدعم
 * على مقربة من المصطلح، لا المصطلح وحده — وإلا صرخ الحارس على محتوانا الصحيح فعُطّل،
 * وهو أسوأ من غيابه.
 */
export const SUPPORT_VERB = '(?:ندعم|يدعم|تدعم|مدعوم|مدعومة|متوافق|متوافقة|نوفر|يوفر|جاهز(?:ون|ة)?\\s*لـ?|نلتزم|مفعل|مفعلة|فعلنا|مربوط|مرتبط|we\\s+support|supports?|supported|compliant\\s+with|ready\\s+for|enabled|is\\s+live|prend\\s+en\\s+charge|prenons\\s+en\\s+charge|prise?s?\\s+en\\s+charge|activ[ée]e?|destekl|etkin|支持|已启用|已上线)';

/**
 * أفعال إعلان ربط المرحلة الثانية — أوسع من SUPPORT_VERB: «تم تفعيل ربط المرحلة الثانية في
 * سبتمبر 2026» و«أطلقنا…» و«جاهزة منذ…» و«went live in…» كانت تمرّ بموعدها لأن فعلها غائب.
 * لا تُضاف إلى SUPPORT_VERB نفسها: قاعدة ETA تستعملها، و«منظومة ETA متاحة للشركات» شرحٌ لا ادّعاء.
 */
export const PHASE2_VERB = `(?:${SUPPORT_VERB}|تفعيل|فعلناه|فعلناها|أطلقنا|اطلقنا|ربطنا|متاح|متاحة|جاهز|جاهزة|جاهزون|مفعله|launched|went\\s+live|now\\s+live|live\\s+(?:for|since|in|with|now)|available|disponible|kullanıma\\s+sunuldu|已推出)`;

/** عبارة المنتج نفسها — تُحجب مع الموعد أو الرقم ولو بلا فعل («ربط المرحلة الثانية لمئات الشركات») */
export const PHASE2_INTEGRATION = '(?:ربط\\s*(?:ال|لل)?مرحل[ةه]\\s*(?:الثاني[ةه]|2|٢)|Phase\\s*(?:2|II|two)\\s*integration|integration\\s+(?:for\\s+|of\\s+)?Phase\\s*(?:2|II|two)\\b|int[ée]gration\\s*(?:de\\s*la\\s*)?phase\\s*(?:2|deux)|2\\.\\s*Aşama\\s*entegrasyon|第二阶段(?:的)?对接)';

const nearWith = (verb, term) => new RegExp(`(${verb}[^.،؛\\n]{0,60}${term})|(${term}[^.،؛\\n]{0,60}${verb})`, 'i');
export const near = (term) => nearWith(SUPPORT_VERB, term);

// موعد أو رقم — «منذ سبتمبر 2026» · «قبل الموجة 25» · «لـ16 شركة» · «في رمضان ١٤٤٨» · «لمئات الشركات» ·
// «متوافق 100%» · «خلال أيام» · «سندعم… قريباً».
// أُخرجت % العامّة والعملة والمليمترات عمداً: «ضريبة 15%» و«58مم» و«299 ر.س» ليست مواعيد.
const MONTHS_AR = 'يناير|فبراير|مارس|أبريل|ابريل|إبريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر'
  + '|محرم|رجب|شعبان|رمضان|شوال|ذو\\s*القعد[ةه]|ذو\\s*الحج[ةه]|ربيع\\s*(?:الأول|الاول|الآخر|الاخر|الثاني)|جمادى\\s*(?:الأولى|الاولى|الآخرة|الاخرة|الأول|الاول|الآخر|الاخر)|صفر\\s*[\\d٠-٩]{4}';
const MONTHS_FR = 'janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre';
const MONTHS_EN = 'January|February|March|April|May|June|July|August|September|October|November|December';
const COUNT_UNIT = 'شرك[ةه]|شركات|عميل|عملاء|منشأ[ةه]|منشآت|مؤسس[ةه]|مؤسسات|تاجر|تجار|موزع|موزعين|موزعا|فاتور[ةه]|فواتير'
  + '|companies|company|customers|clients|businesses|distributors|merchants|invoices|firms|entreprises|şirket|家企业|家公司';
export const DATE_OR_NUMBER = new RegExp([
  'منذ|بحلول|ابتداء\\s*من|اعتبارا\\s*من',
  'خلال\\s*(?:[\\d٠-٩]+|أيام|ايام|يوم|ساعات|ساعة|أسابيع|اسابيع|أسبوع|اسبوع|دقائق|دقيقة|أشهر|اشهر|شهر)',
  '(?:ال)?موج[ةه]\\s*[\\d٠-٩]+|\\b(?:wave|vague|dalga)\\s*[\\d٠-٩]+',
  '\\b(?:19|20)\\d{2}\\b|[١٢][٠٩][٠-٩]{2}',
  '(?<![\\d٠-٩])(?:1[34]\\d{2}|١[٣٤][٠-٩]{2})(?![\\d٠-٩])', // السنة الهجرية
  `[\\d٠-٩][\\d٠-٩,.٬]*\\s*\\+?\\s*(?:${COUNT_UNIT})`,
  `(?<![${AR}])[وبل]?(?:مئات|عشرات|آلاف|الاف)(?![${AR}])|\\b(?:dozens|hundreds|thousands)\\b|des\\s+(?:centaines|dizaines|milliers)`,
  '(?<![\\d٠-٩])(?:100|١٠٠)\\s*[%٪]|[\\d٠-٩]+\\s*[%٪]\\s*(?:مع|متوافق|compliant|conforme)|(?:متوافق[ةه]?|compliant|conforme)\\s*(?:بنسب[ةه]\\s*)?[\\d٠-٩]+\\s*[%٪]',
  `(?<![${AR}])(?:${MONTHS_AR})(?![${AR}])`,
  `\\b(?:${MONTHS_FR})\\b`,
  `\\b(?:since|as\\s+of|starting|from|by|in|until|before)\\s+(?:${MONTHS_EN}|\\d)`,
  '\\bwithin\\s+(?:\\d+|days|hours|weeks|minutes|a\\s+(?:day|week))\\b|\\bin\\s+minutes\\b|en\\s+quelques\\s+(?:jours|minutes|heures)',
  // وعد مستقبلي: «ندعم» تطابق داخل «سندعم» فكان الوعد يمرّ صيغةَ دعم
  `قريبا(?!\\s*من)|\\bsoon\\b|bientôt|yakında|即将|(?<![${AR}])(?:سن|ست|سي|سوف\\s*[نتي])(?:دعم|ربط|وفر|فعل)|\\bwill\\s+(?:soon\\s+)?(?:support|be\\s+(?:available|enabled|live|supported))`,
  'depuis|à\\s+partir\\s+d|itibaren|起',
].join('|'), 'i');

/** جهة الادّعاء: الهيئة أو منصتها (مع «منصة فاتورة» — كانت «معتمد في منصة فاتورة» تفلت) */
const ZATCA_BODY_AR = '(?:الزكاة|ZATCA|زاتكا|الهيئة|منص[ةه]\\s*«?فاتور[ةه]»?)';

/** نفي قديم بعد المصطلح: «المرحلة الثانية غير مبنية/قيد التطوير/قريباً» · «Phase 2 is not supported yet» */
const STALE_AFTER = '(?:غير\\s*(?:مبني|مبنية|متاح|متاحة|مدعوم|مدعومة)|لم\\s*(?:نبنها|نبنه|نبن|تبن|يبن|ندعمها|ندعمه)|قيد\\s*(?:التطوير|البناء|الإنشاء|الانشاء)|قريبا(?!\\s*من)'
  + '|not\\s*(?:yet\\s*)?(?:built|available|supported|live)|isn.t\\s*(?:yet\\s*)?(?:built|available|supported|live)|coming\\s*soon|(?:in|under)\\s*development|on\\s*(?:our|the)\\s*roadmap'
  + '|n.est\\s*pas\\s*(?:encore\\s*)?(?:disponible|d[ée]velopp[ée]e|prise\\s*en\\s*charge)|bientôt|henüz\\s*(?:hazır\\s*değil|desteklenmiyor|mevcut\\s*değil)|yakında|尚未(?:上线|支持)|即将)';
/** نفي قديم قبل المصطلح: «لا ندعم المرحلة الثانية» · «what is honestly not built (Phase 2)» · «We don't support Phase 2 yet» */
const STALE_BEFORE = '(?:لا\\s*(?:ندعم|نربط|يدعم|تدعم|نوفر|يوفر)|لم\\s*(?:نبن|نبني|ندعم)|do\\s*not\\s*support|don.t\\s*support|does\\s*not\\s*support|doesn.t\\s*support'
  + '|not\\s*(?:yet\\s*)?(?:built|supported|available)|ne\\s*(?:prenons|prend)\\s*pas\\s*en\\s*charge|desteklemiyoruz|desteklemiyor|尚不支持|不支持)';
/** تموضع «المرحلة الأولى» منتجاً: «يُصدر فاتورة… وفق متطلبات المرحلة الأولى» · «supports phase one» · «فواتير ZATCA (مرحلة أولى)» */
const PHASE1_VERB = '(?:نصدر|يصدر|تصدر|ندعم|يدعم|تدعم|نوفر|يوفر|توفر|نغطي|يغطي|supports?|issues?|covers?|émet|prend\\s*en\\s*charge|prenons\\s*en\\s*charge)';
const PHASE1_NOUN = '(?:فاتور[ةه]|فواتير|فوترة|invoices?|invoicing|factures?|facturation)';
/**
 * صيغ تموضع «المرحلة الأولى» بلا فعل دعم قبلها — كلها حيّة في CMS (قِيس 4 أكتوبر 2026) وكانت تفلت:
 *   «فاتورة مبسطة برمز QR وفق المرحلة الأولى» · «أوف-لاين برمز QR (المرحلة الأولى)» ·
 *   «ZATCA Phase-1 QR invoices» · «What ships today is the complete Phase-1 van sales cycle» ·
 *   «ما نقدمه اليوم هو دورة المرحلة الأولى الميدانية الكاملة».
 * تُطبَّق عليها استثناءات بديل الفعل نفسها: لا إدانة إن ذُكرت المرحلة الثانية في الجملة، ولا على سؤال.
 * والذكر التعليمي («رمز QR متطلب أساسي في المرحلة الأولى») لا يطابق أياً منها.
 */
const PHASE1_STALE_FORM = [
  'Phase[\\s-]*(?:1|one)\\s*QR',
  '\\(\\s*(?:(?:ال|لل)?مرحل[ةه]\\s*ال[أا]ول[ىي]|مرحل[ةه]\\s*[أا]ول[ىي]|Phase[\\s-]*(?:1|one))\\s*\\)',
  'وفق\\s*(?:متطلبات\\s*)?(?:ال|لل)?مرحل[ةه]\\s*ال[أا]ول[ىي]',
  'complete\\s+Phase[\\s-]*(?:1|one)\\b',
  'What\\s+ships\\s+today[^.؛\\n]{0,60}?Phase[\\s-]*(?:1|one)\\b',
  'دور[ةه]\\s*(?:ال)?مرحل[ةه]\\s*ال[أا]ول[ىي]',
].join('|');

/**
 * أسماء المنافسين لقاعدة competitor-name (حاجبة مطلقاً). الأصل من السوق العربي، ووُسّعت (٨ نوفمبر ٢٠٢٦) بما ظهر
 * في بحث الأسواق العالمية لخطة SEO متعدد اللغات، قبل أي صفحة بلغة جديدة — تصحيح نقد الخطة:
 * الأسماء لا تدخل القواميس ولا تعليمات الترجمة، والحارس يمنع تسرّبها من نصّ مترجم أو CMS.
 * المستبعد عمداً (يلتبس بكلمات عامة أو بأنظمة ERP تُذكر تكاملاً): Odoo · SAP · Sage وحدها · Tally · Priority · Logo ·
 * Mikro · Bling · Venda · Fast · Sapo · 1C/ERPNext — والنموذج يُقارن بالنماذج لا بالأسماء.
 * فُحصت قبل الإضافة على مصادر المستودع (src وscripts وpublic وindex.html) ونصوص CMS الحيّة: صفر مطابقة.
 */
const COMPETITORS_LATIN = [
  // السوق العربي (الأصل)
  'MEST\\s*SE', 'mestsoft', 'Daftra', 'Qoyod', 'qoyod\\.com', 'daftra\\.com', 'Delta\\s*Sales\\s*App', 'deltasalesapp', 'PepUpSales', 'pepupsales',
  'ALZERP', 'Star\\s*Business\\s*ERP', 'Mandob\\s*Optimum', 'Plugin-ERP', 'BI-Technologies', 'UpGrowth',
  // أفريقيا الفرنكوفونية والمغرب والشرق الأفريقي وجنوبه وغربه
  'Kolonell', 'FieldPro', 'Optimetriks', 'BeatRoute', 'Field\\s*Assist', 'Predictiv', 'Massist', 'Skynamo', 'MACmobile', 'bMobile\\s*Route',
  'Sodapp', 'LaceUp', 'MarketForce\\s*360', 'Matiyas', 'SmartBiashara', 'UzaPoint', 'Levanda\\s*POS', 'CloudApper', 'InfoVera', 'Sales\\s*Diary',
  // أمريكا اللاتينية وإيبيريا
  'M[áa]xima\\s*Tech', 'maxPedido', 'MaxMotorista', 'Omie', 'Conta\\s*Azul', 'PagVendas', 'Mobilvendor', 'CPG\\s*Soft', 'YoFacturo', 'Ofima',
  'Cegid', 'GotelGest', 'FarAndSoft', 'Sage\\s*Sales\\s*Management', 'ForceManager',
  // أوروبا
  'Azuvio', 'Ediconnect', 'Senior\\s*SFA', 'Dynamics\\s*Mobile', 'App4Sales', 'inSitu\\s*Sales', 'Comarch', 'Asseco', 'WAPRO', 'Comax2Go',
  'osapiens',
  // آسيا
  'Bizom', 'Botree', 'Trackolap', 'SalesOn', 'SAMS\\s*Online', 'Softvirtue', 'Moneypex', 'HysabOne', 'Tarkie', 'Ivy\\s*Mobility', 'SimpliDOTS',
  'MileApp', 'Salesmania', 'HashMicro', 'iReap', 'MountainTop\\s*OrderIT', 'MySales\\s*Buddy', 'Ak[ıi]nsoft', 'MobiWork', 'MISA\\s*AMIS',
  'DMS\\s*NextX', 'Mobisale', 'Ecount',
];
/** بلا \b (حدّ الكلمة في JS لاتيني فقط): الصينية والكورية والروسية */
const COMPETITORS_OTHER = ['勤策', '外勤365', '舟谱云', '纷享销客', '易订货', '易指快销', '세일즈덕', '샤플', '모두의거래', 'Агент\\s*Плюс'];

/* ─── قاموس المصطلحات: كلمات تنقلب نيّتها فتُتجنّب منفردة (بند ٢٢ في خطة SEO، و١٤ جزئياً في خطة GEO) ─── */

// <glossary-avoid> مولَّدة من src/i18n/glossary/{ar,en,fr,tr,zh}.json (حقل avoid) بالأمر: node scripts/gen-glossary-guard.mjs
// لا تُحرَّر يدوياً — المصدر الواحد هو القواميس، واختبار src/i18n/glossary.test.ts يفشل إن انحرفت النسخة عنها.
export const GLOSSARY_AVOID = {
  ar: [
    {"term":"مندوب مبيعات","why":"نيّتها إعلانات وظائف حين تكون هي العنوان أو بند الكلمات المفتاحية وحدها (نتائج naukrigulf في المغرب والجزائر، ويُرجَّح النمط نفسه في الخليج). تأتي مركّبة: «تطبيق مندوب مبيعات للشركات» أو «نظام إدارة المناديب». داخل عبارة إدارة («صلاحيات مندوب المبيعات»، «غش مندوب المبيعات») نيّتها إدارية فتمرّ","scope":"alone"},
    {"term":"البيع من السيارة","why":"انقلاب نيّة تامّ: قياس SERP في مصر والخليج أرجع ١٠ مواقع سيارات مستعملة من ١٠ (ملاحظة catalog.mjs على van-sales-app). تأتي مع سياق التوزيع أو مرادفاً شارحاً بعد «الكاش فان»","unlessWith":["برنامج","تطبيق","نظام","مندوب","مناديب","التوزيع","كاش فان","البيع المسبق"]},
    {"term":"كاش فان","why":"وحدها لم تُقَس (بحث نوفمبر أرجع برامج الدعم النقدي ولا منتجاً واحداً)، والصيغة العاملة المقيسة «كاش فان» مع «مناديب التوزيع» (catalog.mjs). في العنوان والوصف والكلمات المفتاحية تأتي مركّبة («برنامج كاش فان»، «تطبيق كاش فان») أو مع سياق التوزيع، وفي المتن مرادفاً حرّاً","unlessWith":["برنامج","تطبيق","نظام","منصة","التوزيع","مناديب","مندوب","عهدة","البيع المسبق"]},
    {"term":"تتبع المركبات","why":"فئة تتبّع الأساطيل بالـGPS لا إدارة المناديب","unlessWith":["التوزيع","مناديب","مندوب"]},
    {"term":"إدارة الأسطول","why":"فئة تتبّع الأساطيل بالـGPS لا إدارة المناديب","unlessWith":["التوزيع","مناديب","مندوب"]},
  ],
  en: [
    {"term":"van sales","why":"منفردةً تجلب أرقام مبيعات الفانات التجارية وتجار الفانات المستعملة (goodcarbadcar.net وcazoo.co.uk). تأتي مركّبة «van sales software/app» أو مع الموزّعين والتوزيع أو وظيفة يؤديها البرنامج (invoicing، van stock، collections، route)","unlessWith":["software","app","apps","application","system","platform","solution","tool","management","route accounting","distributor","distributors","distribution","wholesale","wholesalers","FMCG","pre-sales","presales","presell","pre-selling","cash van","invoicing","invoices","van stock","collections","route"]},
    {"term":"van sales rep","why":"نيّتها وظائف حين تكون وحدها عنواناً أو بنداً في الكلمات المفتاحية (إعلان «Van Sales Representatives» على Jobberman في غانا، و«van sales rep» في نيجيريا وكينيا)؛ داخل عبارة أداة («E-Invoicing for Van Sales Reps») تمرّ","scope":"alone"},
    {"term":"van sales representative","why":"نيّتها وظائف حين تكون وحدها عنواناً أو بنداً (Jobberman في أكرا وتيما)","scope":"alone"},
    {"term":"order booking","why":"منفردةً تجلب تطبيقات شركات الشحن على Shopify (Oshi وM&P وCourierify)؛ تُقرن دائماً بالموزّع أو FMCG أو salesman","unlessWith":["distributor","distributors","distribution","FMCG","salesman","salesmen","order booker","field","rep","reps"]},
    {"term":"order booker","why":"اسم الوظيفة نفسه في باكستان (إعلانات Rozee.pk وQureos)؛ وحدها عنواناً أو بنداً تجلب الوظائف، ومركّبة «order booker app» هي المعتمدة","scope":"alone"},
    {"term":"DMS","why":"الاختصار وحده يُستعمل لبرامج وكالات السيارات (Dealer Management System) — فرضية لم تُختبر، والخطة تكتب «distributor management system» كاملة. المركّب «DMS software» يمرّ: طلبه مثبت في Search Console (استعلام صاعد، ملاحظة catalog.mjs ٢٥ يوليو ٢٠٢٦)","unlessWith":["distributor management system","distribution management system","distributor","distributors","distribution","FMCG","software","system","platform","app"]},
  ],
  fr: [
    {"term":"application van sales","why":"مصطلح إنجليزي داخل صفحة فرنسية؛ الخطة تحذفه من الصفحة الفرنسية ويحلّ محله «application de vente terrain» و«application prévente»","scope":"text"},
    {"term":"vente en camion","why":"تُوقف حتى تُقاس في Search Console (يُرجَّح أنها تعطي بيع الشاحنات)؛ مقبولة مركّبة «logiciel/application de vente en camion» أو مع الشرح «(van sales)»","unlessWith":["logiciel","application","(van sales)"]},
    {"term":"vente au camion","why":"مثل «vente en camion»: لم تُقس، وتُقرأ بيع شاحنات؛ مركّبة مع logiciel/application أو مع «(van sales)» فقط","unlessWith":["logiciel","application","(van sales)"]},
    {"term":"vente en tournée","why":"منفردةً تنقلب إلى حفلات وجولات فنية وباعة متجولين (passetonbillet.fr وdreets.gouv.fr)؛ تأتي مركّبة «logiciel/application de vente en tournée» أو في سياق التوزيع","unlessWith":["logiciel","application","système","outil","distributeur","distributeurs","distribution","grossiste","grossistes"]},
    {"term":"autovente","why":"لم تثبت في أسواق المغرب العربي وأفريقيا الفرنكوفونية وقد تُقرأ بيع سيارات"},
    {"term":"vente ambulante","why":"باعة متجولون في الشارع لا توزيع بين الشركات"},
    {"term":"porte-à-porte","why":"بيع للمستهلك في البيوت لا بين الشركات"},
    {"term":"prévendeur","why":"مسمّى وظيفي (إعلانات emploitic في الجزائر)؛ وحدها عنواناً أو بنداً في الكلمات المفتاحية تجلب الوظائف","scope":"alone"},
    {"term":"commerciaux terrain","why":"وحدها عنواناً أو بنداً يُرجَّح أنها تُرجع إعلانات وظائف (فرضية)؛ تأتي مع «application/logiciel/gestion des»","scope":"alone"},
    {"term":"VRP","why":"صفة قانونية لعقد عمل المندوب في فرنسا، لا اسم فئة برمجيات"},
  ],
  tr: [
    {"term":"araç satış","why":"تعني بيع السيارات وبرامج معارضها (فرضية لم يُتحقق منها ببحث، والمصنع يتجنّبها)؛ الصحيح «araçtan satış» مقروناً بـ«plasiyer»","scope":"text"},
    {"term":"araç takip","why":"تتبّع الأساطيل بالـGPS لا البيع الميداني","unlessWith":["plasiyer","saha satış","temsilci"]},
    {"term":"sıcak satış","why":"في المبيعات العامة تعني العميل الدافئ؛ لا تُذكر إلا في سياق التوزيع (plasiyer، araçtan، ön sipariş)","unlessWith":["plasiyer","araçtan","ön sipariş","soğuk satış","sipariş","dağıtım","distribütör","toptan","saha satış","fatura"]},
    {"term":"soğuk satış","why":"في المبيعات العامة تعني الاتصال البارد؛ لا تُذكر إلا في سياق التوزيع","unlessWith":["plasiyer","araçtan","ön sipariş","sıcak satış","sipariş","dağıtım","distribütör","toptan","saha satış"]},
    {"term":"plasiyer","why":"وحدها عنواناً أو بنداً في الكلمات المفتاحية نيّتها إعلانات توظيف (iş ilanları)؛ تأتي «plasiyer programı/uygulaması»، وداخل جملة («Plasiyerlerinizi… yönetin») تمرّ","scope":"alone"},
    {"term":"satış temsilcisi","why":"وحدها عنواناً أو بنداً نيّتها إعلانات توظيف","scope":"alone"},
    {"term":"satış öncesi","why":"تعني «ما قبل البيع» لا البيع المسبق التوزيعي؛ الصحيح «ön sipariş» أو «sipariş toplama»","scope":"text"},
    {"term":"veresiye","why":"عامّية؛ الصحيح «vadeli satış»"},
  ],
  zh: [
    {"term":"车销","why":"منفردةً تجلب تجارة السيارات (车销客 تطبيق لتجار السيارات المستعملة)؛ تأتي مع «访销/经销商/快消/业务员/外勤» أو «管理软件»","unlessWith":["访销","经销","快消","业务员","外勤","分销","批发","库存","软件","管理","系统","APP"]},
    {"term":"车销客","why":"اسم تطبيق لتجار السيارات المستعملة (华夏二手车网)","scope":"text"},
    {"term":"汽车销售","why":"بيع السيارات نفسها","scope":"text"},
    {"term":"卖车","why":"بيع السيارات","scope":"text"},
    {"term":"预售","why":"في البر الرئيسي تعني البيع المسبق للسلع في التجارة الإلكترونية؛ pre-sales التوزيعي «访销»","scope":"text"},
    {"term":"增值税发票","why":"في البر الرئيسي تشير إلى الفاتورة الضريبية الرسمية عبر نظام الضرائب (金税/数电票)، فاستهدافها في العنوان أو الوصف أو الكلمات المفتاحية يجلب باحثي الفابياو الصيني ويُفهم ربطاً بمصلحة الضرائب الصينية. ذكرها في المتن وصفاً لفاتورة ضريبة القيمة المضافة السعودية (وهي ترجمة «فاتورة ضريبية» في واجهة التطبيق) مقبول؛ والمفضّل «发票» العامة"},
    {"term":"增值税专用发票","why":"فاتورة ضريبة القيمة المضافة الخاصة في نظام الضرائب الصيني — تُفهم ربطاً به","scope":"text"},
    {"term":"税控","why":"أجهزة ونظام الرقابة الضريبية الصيني — تُفهم ربطاً به","scope":"text"},
    {"term":"全电发票","why":"الفاتورة الإلكترونية الكاملة في نظام الضرائب الصيني — تُفهم ربطاً به","scope":"text"},
    {"term":"数电票","why":"الفاتورة الرقمية في نظام الضرائب الصيني — تُفهم ربطاً به","scope":"text"},
  ],
};
// </glossary-avoid>

/**
 * قواعد القاموس — واحدة لكل كلمة في avoid، مقصورة على صفحات لغتها (paths)، وحاجبة لنصوص المستودع وتحذير لنصوص CMS
 * (cmsWarn: مقالات CMS يحرّرها المالك من اللوحة، لا من المستودع).
 *
 * لماذا النطاق الافتراضي «الرأس» (العنوان والوصف وH1) مع الكلمات المفتاحية لا المتن كله: انقلاب النية يقع حين تكون
 * الكلمة المفردة هي **المستهدفة** («Bonnes pratiques de la vente en camion» تستهدف بيع الشاحنات). أمّا ذكرها في المتن شرحاً
 * («la vente en camion conclut vente et livraison…») فمحتوى صناعي مشروع — فلسفة dead-keyword-targeting نفسها. وما خطؤه
 * في أي موضع (ترجمة خاطئة أو اسم تطبيق سيارات) يحمل scope: "text" في القاموس فيُفحص في الصفحة كلها.
 *
 * «منفردة» = بلا سياق unlessWith في الجملة نفسها: كلمة من القائمة قبلها أو بعدها في نافذة GLOSSARY_WINDOW حرفاً لا تعبرها
 * فاصلة أو نقطة أو «|» (فلا يُعفي «application» في بند كلمات مفتاحية سابق البندَ التالي). الإعفاء بنظرة خلفية **بعد**
 * مطابقة الكلمة لا قبلها، فلا يتكرّر ثمنها على كل موضع في النصوص الطويلة.
 * الحدود: العربية بسوابق الجر والعطف و«ال» على كل كلمة والتاء المربوطة هاءً والهمزات؛ التركية بلواحقها (plasiyerler،
 * araç satışı)؛ الإنجليزية والفرنسية بجمعها (apps، distributeurs)؛ الصينية بلا حدود (لا مسافات فيها).
 */
const GLOSSARY_LATIN = 'A-Za-z0-9\\u00C0-\\u024F';
const GLOSSARY_SEP = '[^,.;|\\n،؛!?؟。，；！？]';
const GLOSSARY_WINDOW = { zh: 15 };
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** نصّ حرفي من القاموس ← نمط بحدود كتابة لغته (نصّ القاموس يُطبَّع بـnorm كما يُطبَّع النص المفحوص) */
export function glossaryPattern(code, literal) {
  const words = norm(literal).trim().split(/\s+/).filter(Boolean);
  if (code === 'ar') {
    const core = words.map((w) => `(?:ال)?${escRe(w.length > 3 ? w.replace(/^ال/, '') : w)
      .replace(/[إأآا]/g, '[إأآا]').replace(/[ةه]$/, '[ةه]').replace(/[يى]$/, '[يى]')}`).join('\\s+');
    return `(?<![${AR}])(?:[وف]?[بكل]?ل?)?${core}(?![${AR}])`;
  }
  if (code === 'zh') return words.map(escRe).join('\\s*');
  const body = words.map(escRe).join('\\s+');
  if (code === 'tr') return `(?<![${GLOSSARY_LATIN}])${body}`; // اللواحق التركية تلتصق بالجذر
  return `(?<![${GLOSSARY_LATIN}])${body}s?(?![${GLOSSARY_LATIN}])`;
}

/**
 * مسار صفحات اللغة في dist: اللغات القديمة تحت مجلدها، والعربية في الجذر — أي مسار لا يبدأ بمجلد لغة. مجلد اللغة مقطع
 * بشكل رمز لغة ليس من المقاطع المحجوزة (checkLocaleCode يرفض رمزاً يساوي محجوزاً، فـog وrep-app صفحات عربية لا لغات).
 */
const SEG_END = '[\\\\/]';
const LOCALE_DIR = `(?!(?:${RESERVED_SEGMENTS.map(escRe).join('|')})${SEG_END})[a-z]{2,3}(?:-[a-z]{2,4})?${SEG_END}`;
export const GLOSSARY_PATHS = {
  ar: new RegExp(`^(?:ar${SEG_END}|(?!${LOCALE_DIR}))`),
  en: new RegExp(`^en${SEG_END}`),
  fr: new RegExp(`^fr${SEG_END}`),
  tr: new RegExp(`^tr${SEG_END}`),
  zh: new RegExp(`^zh${SEG_END}`),
};

/**
 * حدّ مقطع لـscope: "alone" — بداية العنوان أو نهايته أو فاصل («|» «:» «—» فاصلة نقطة سطر). كلمات نيّة الوظائف
 * («مندوب مبيعات» · «plasiyer» · «van sales rep») تنقلب حين تكون **هي** المقطع كله (عنوان «Plasiyer | …» أو بند كلمات
 * مفتاحية «مندوب مبيعات»)، لا حين تكون جزءاً من جملة إدارة («صلاحيات مندوب المبيعات» · «Plasiyerlerinizi ve
 * ihtiyaçlarınızı anlatın» · «E-Invoicing for Van Sales Reps») — وهذه لا تحصرها قائمة سياق.
 */
const GLOSSARY_SEG = '[,.;:|\\n،؛!?؟。，；！？—–]';
const GLOSSARY_PAD = '[\\s«»"\'()]*';

/** قاعدة لكلمة واحدة من avoid */
function glossaryRule(code, entry, i) {
  const term = glossaryPattern(code, entry.term);
  const n = GLOSSARY_WINDOW[code] ?? 50;
  const ctx = (entry.unlessWith || []).map((c) => glossaryPattern(code, c)).join('|');
  const tail = code === 'tr' ? `[${GLOSSARY_LATIN}]*` : ''; // plasiyerler · plasiyerin
  const source = entry.scope === 'alone'
    ? `(?<=(?:^|${GLOSSARY_SEG})${GLOSSARY_PAD})(?:${term})${tail}(?=${GLOSSARY_PAD}(?:$|${GLOSSARY_SEG}))`
    : ctx
      ? `(?:${term})(?<!(?:${ctx})${GLOSSARY_SEP}{0,${n}}(?:${term}))(?!${GLOSSARY_SEP}{0,${n}}(?:${ctx}))`
      : term;
  const where = entry.scope === 'text' ? 'في صفحات اللغة'
    : entry.scope === 'alone' ? 'وحدها عنواناً أو بنداً في الكلمات المفتاحية'
      : 'منفردةً في العنوان أو الوصف أو H1 أو الكلمات المفتاحية';
  return {
    id: `glossary-${code}-${String(i + 1).padStart(2, '0')}`,
    re: new RegExp(source, 'i'),
    ...(entry.scope === 'text' ? {} : { scope: 'head' }),
    keywords: true,
    paths: GLOSSARY_PATHS[code],
    cmsWarn: true,
    glossary: code,
    term: entry.term,
    why: `قاموس ${code}: «${entry.term}» ${where} — ${entry.why}`,
  };
}

export const GLOSSARY_RULES = Object.entries(GLOSSARY_AVOID)
  .flatMap(([code, list]) => list.map((entry, i) => glossaryRule(code, entry, i)));

export const RULES = [
  {
    id: 'zatca-approved',
    // تبقى محجوبة بعد تفعيل الربط وتُشدَّد: الهيئة لا تعتمد مزوّدي البرمجيات ولا تُشاركهم رسمياً.
    // الثغرات المسدودة: «معتمد من الهيئة» · «معتمدة · ZATCA» · «معتمد هيئة الزكاة» بلا حرف جر (كان
    // النمط الأقدم يحجبها فتراجع عنها الأحدث) · «معتمد في/عند» · «حاصلون على اعتماد الهيئة» ·
    // «بشهادة هيئة الزكاة» · «شريك تقني رسمي» · «بالشراكة مع الهيئة» · «Fatoora-certified» ·
    // «ZATCA-compliant and certified» · «certifiée ZATCA» · «tarafından onaylanmış» · «认可».
    re: new RegExp([
      `(?:معتمد|مصادق|مرخص|موثق)(?:ة|ه|ون|ين)?\\s*(?:رسمي[اةه]?\\s*)?(?:(?:من\\s*قبل|من|لدى|في|عند)\\s*)?(?:هيئة\\s*)?${ZATCA_BODY_AR}`,
      // «فاتورة» وحدها تلتبس بـ«العملة المعتمدة في فاتورة المبيعات» ⇒ حرف جر ونهاية العبارة شرطان
      '(?:معتمد|مصادق|مرخص)(?:ة|ه|ون|ين)?\\s*(?:من|لدى|في|عند)\\s*«?فاتور[ةه]»?(?=\\s*(?:$|[.،؛,:)»!؟?\\n(]|التابع|ZATCA|ل?لربط))',
      `(?:اعتماد|مصادق[ةه]|ترخيص|شهاد[ةه])\\s*(?:رسمي[ةه]?\\s*)?(?:من\\s*قبل|من|لدى)\\s*(?:هيئة\\s*)?${ZATCA_BODY_AR}`,
      // الاسم بلا حرف جر يحتاج فعل حيازة: «اعتماد الهيئة» وحده يصف اعتماد الفاتورة (Clearance) في الشرح
      `(?:حاصل(?:ون|ين|ة|ه)?\\s*على|حصلنا\\s*على|حصلت\\s*على|حصل\\s*على|نحمل|يحمل|نملك|لدينا|ب)\\s*(?:ال)?(?:اعتماد|شهاد[ةه]|مصادق[ةه]|ترخيص)\\s*(?:رسمي[ةه]?\\s*)?(?:(?:من\\s*قبل|من|لدى)\\s*)?(?:هيئة\\s*)?${ZATCA_BODY_AR}`,
      'شريك[^.،\\n]{0,15}(?:رسمي|معتمد)[^.،\\n]{0,10}(?:هيئ[ةه]|الزكاة|ZATCA|زاتكا|منص[ةه]\\s*«?فاتور[ةه])',
      `(?:بال)?شراك[ةه]\\s*(?:رسمي[ةه]\\s*)?مع\\s*(?:هيئة\\s*)?${ZATCA_BODY_AR}`,
      '(?:معتمدة?|مصادقة?|مرخصة?)\\s*[·•|:–—-]\\s*(?:ZATCA|الزكاة|الهيئة)',
      // «ZATCA-compliant and certified» · «ZATCA Phase 2 certified» · «Fatoora-certified»؛ ولا تعبر
      // كلمات النفي والإسناد («ZATCA does not certify» · «ZATCA has approved…» شرح لا ادّعاء)
      '(?:ZATCA|Fatoora)(?:[\\s-]+(?!(?:not|no|never|does|did|do|has|have|had|is|was|isn.t|doesn.t|hasn.t)\\b)[\\w’\'-]+){0,3}?[\\s-]+(?:certified|approved|accredited|authori[sz]ed|endorsed)\\b',
      '(?:certified|approved|accredited|authori[sz]ed|endorsed)\\s+(?:by\\s+(?:the\\s+)?)?(?:ZATCA|Zakat|Fatoora)',
      'official\\s+(?:ZATCA|Fatoora)\\s+partner',
      '(?:official|certified|approved|authori[sz]ed|accredited)\\s+(?:[\\w-]+\\s+){0,2}partner\\s+(?:of|for|with|to)\\s+(?:the\\s+)?(?:ZATCA|Zakat|Fatoora)',
      'in\\s+partnership\\s+with\\s+(?:the\\s+)?(?:ZATCA|Zakat|Fatoora)',
      '(?:certifi|homologu|agré|approuv)[ée]e?s?\\s+(?:par\\s+(?:la\\s+)?)?ZATCA',
      'partenaire\\s+officiel\\s+de\\s+la\\s+ZATCA',
      'ZATCA\\s*(?:onaylı|sertifikalı|tarafından\\s+(?:onay|sertifika)\\w*)',
      'ZATCA\\s*(?:认证|认可|批准|授权|官方合作)',
    ].join('|'), 'i'),
    // النفي يُقبل ملاصقاً قبل المطابقة فقط («لسنا معتمدين من الهيئة»)، و**كلمةً مستقلة**:
    // بلا حدّ كلمة كانت «فعلاً/أصلاً/مثلاً معتمد من الهيئة» تُعدّ نفياً («لا» في آخرها)،
    // و«Casino certified by ZATCA» كذلك («no»). والواو والفاء السابقتان مقبولتان («ولا مصادق»).
    unless: /(?:^|[\s(«"'،,.؛:])[وف]?(?:لا|ليس|ليست|لسنا|غير|لا\s*ندعي\s*(?:أننا|اننا)?|not|never|no)(?:\s+(?:a|an))?\s*$|n['’]t(?:\s+(?:a|an))?\s*$/i,
    unlessBefore: 25,
    unlessAfter: 0,
    why: 'ZATCA لا تعتمد ولا تصادق مزوّدي البرمجيات — ادّعاء الاعتماد أو الشراكة الرسمية ممنوع ولو بعد تفعيل الربط',
  },
  {
    id: 'zatca-phase2-dated',
    // ربط المرحلة الثانية مع منصة فاتورة قدرة معلنة بقرار المالك بعد التفعيل الفعلي، فصيغة الدعم
    // تمرّ. الممنوع: اقترانها بموعد أو رقم غير مثبت — بفعل إعلان أو بعبارة المنتج نفسها.
    re: new RegExp(`${nearWith(PHASE2_VERB, PHASE2).source}|${PHASE2_INTEGRATION}`, 'i'),
    requireNear: { re: DATE_OR_NUMBER, before: 80, after: 120 },
    why: 'ادّعاء ربط المرحلة الثانية مقروناً بموعد أو رقم — لا موعد ولا رقم مثبت يُنشر',
  },
  {
    id: 'zatca-phase2-stale-denial',
    // نفي قديم أو تموضع «المرحلة الأولى» يناقض الحقيقة الجديدة. severity 'warn' حتى يُحرَّر CMS:
    // prerender يجلب مقالات CMS إلى dist وفيها نفي قديم يحرّره المالك من لوحة CMS؛ لو حُجب كله الآن
    // لفشل كل بناء. لذا verify-claims يرفع إلى حاجب كل مطابقة **لا** يجد نصّها في CMS (مصدرها المستودع)،
    // ويُبقي مطابقات CMS تحذيراً. بعد التحرير: PHASE2_CMS_CLEANED = true أعلاه (لا حذف severity يدوياً).
    // تموضع «المرحلة الأولى» لا يُعدّ نفياً إن ذُكرت المرحلة الثانية في الجملة نفسها
    // («نصدر فاتورة المرحلة الأولى وندعم ربط المرحلة الثانية» صادقة).
    re: new RegExp([
      `${PHASE2}[^.؛\\n]{0,90}${STALE_AFTER}`,
      `${STALE_BEFORE}[^.؛\\n]{0,40}${PHASE2}`,
      '(?:لا\\s*(?:نربط|نرتبط)|غير\\s*(?:مربوط|مربوطة|مرتبط|مرتبطة)|لسنا\\s*(?:مربوطين|مرتبطين))[^.؛\\n]{0,30}(?:منص[ةه]\\s*«?فاتور[ةه]|«فاتور[ةه]»|ZATCA|الهيئة)|not\\s*(?:yet\\s*)?(?:integrated|connected|linked)\\s*(?:to|with)\\s*(?:the\\s*)?(?:ZATCA|Fatoora)',
      `${PHASE1}[^.؛\\n]{0,45}(?:فقط|وحدها|(?<![\\w-])only\\b|uniquement)`,
      // والسؤال ليس تموضعاً: «اسأل مورّدك: هل تُصدر وفق المرحلة الأولى؟» قائمة فحص للقارئ.
      // والصيغ بلا فعل (PHASE1_STALE_FORM) تشارك البديل نظرتيه فلا يتكرّر ثمنهما على النصوص الطويلة.
      `(?<!${PHASE2}[^.؛\\n]{0,160})(?:(?:${PHASE1_VERB}[^.؛\\n]{0,80}?|${PHASE1_NOUN}\\s*(?:ZATCA\\s*)?[(«]?\\s*)${PHASE1}|${PHASE1_STALE_FORM})(?![^.؛\\n]{0,160}${PHASE2})(?![^.؛\\n]{0,40}[؟?])`,
      'النطاق\\s*الذي\\s*(?:نعلنه|نغطيه|ندعمه)',
    ].join('|'), 'i'),
    // مرشّح مسبق رخيص: كل بديل في النمط أعلاه يحوي واحدة من هذه — والنمط بنظرته الخلفية بطيء على
    // النصوص الطويلة (١٧ ثانية على مقالات catalog كاملة)، فلا يُشغَّل على نصّ لا يحوي أياً منها.
    pre: /مرحل|phase|aşama|阶段|نربط|نرتبط|مربوط|مرتبط|integrated|connected|linked|النطاق/i,
    ...(PHASE2_CMS_CLEANED ? {} : { severity: 'warn' }),
    why: 'نفي قديم للمرحلة الثانية (أو تموضع «المرحلة الأولى» وحدها) بعد تفعيل الربط — يناقض الحقيقة الجديدة',
  },
  {
    id: 'eta-egypt-claim',
    re: near('(?:\\bETA\\b|منظومة\\s*الفاتورة\\s*الإلكترونية\\s*المصرية)'),
    unless: /(غير\s*(مبني|متاح|مدعوم)|not\s*(built|implemented|supported))/i,
    why: 'ادّعاء دعم ETA مصر — stub not_implemented (شرح اللائحة مسموح)',
  },
  {
    id: 'fake-certification',
    re: /\b(SOC\s*2|SOC2|ISO\s*27001|ISO\s*9001)\b/i,
    // النفي الصريح مشروع: «ليست لدينا شهادات SOC2 أو ISO» جزء من صندوق الإنصاف
    unless: /(ليست?\s*لدينا|لا\s*نملك|بلا\s*شهاد|we\s*(hold|have)\s*no|no\s*SOC|not\s*certified)/i,
    why: 'ادّعاء شهادة لا نملكها',
  },
  {
    id: 'subscribe-now',
    re: /(اشترك\s*الآن|اشتراك\s*فوري|ادفع\s*الآن|Subscribe\s*now|Buy\s*now)/i,
    why: 'لا اشتراك ذاتي ولا بوابة دفع — كل نداء فعل ينتهي بمحادثة أو تجربة',
  },
  // ⚠️ رُفعت قاعدة play-store-link في 3 سبتمبر 2026 بعد التحقّق الحيّ لا بالافتراض:
  //   • play.google.com/store/apps/details?id=net.fieldsa.twa ⇒ 200 وفيه زرّ التثبيت
  //     ولا أثر لـ«not found» (كانت تُرجع 404 أيام الاختبار المغلق فوُضعت القاعدة).
  //   • itunes.apple.com/lookup?id=6797991968 ⇒ resultCount 1 · bundleId net.fieldsa.rep
  //     · الإصدار 1.0 · صدر 2026-08-17.
  // القاعدة كانت تحرس رقماً صار قديماً، فمنعت صفحةً صادقة. إن سُحب أي تطبيق من متجره
  // فأعِد القاعدة — وتحقّق من الرابط حيّاً قبل ذلك، فالحارس الخاطئ يكلّف مثل الادّعاء الخاطئ.
  {
    id: 'dead-keyword-targeting',
    // القيد على **الاستهداف** لا على ذكر المصطلح في المتن: مقال يشرح الفرق بين
    // «كاش فان» و«بري سيلز» محتوى صناعي مشروع؛ أمّا بناء عنوان/وصف صفحة على
    // صياغة نتائجها ملوّثة (van seals · كاش باك · دفتر الفيزياء) فإهدار زحف.
    re: /(فان\s*سيلز|بديل\s*دفترة)/i,
    scope: 'head', // العنوان والوصف فقط
    why: 'صياغة ميتة/ملوّثة في عنوان أو وصف الصفحة — نتائج البحث عليها لغير مجالنا',
  },
  {
    id: 'unverified-social-proof',
    // «أكثر من N شركة/عميل يثقون» — لا عملاء مرجعيين بعد
    re: /(أكثر\s*من\s*[\d٠-٩,،]+\s*(شركة|عميل|مستخدم)\s*(يثق|تثق|يستخدم))/i,
    why: 'لا عملاء مرجعيون — أي رقم ثقة غير مملوك',
  },
  {
    id: 'arab-only-targeting',
    // التموضع عالمي (قرار المالك ٨ نوفمبر ٢٠٢٦: المنصة لكل دول العالم): عنوان صفحة إنجليزية أو فرنسية أو تركية أو
    // صينية ووصفها وH1 لا تحصر الاستهداف في «الأسواق العربية» ونظائرها — كان عنوان /en/ «…Software for Arab Markets»
    // فيذهب الباحث خارج المنطقة إلى غيرنا. القيد على الرأس وحده لا على المتن: شرح السوق العربية في مقال
    // عنها محتوى صحيح. ومقالات المدوّنة داخلة في القاعدة منذ ٨ نوفمبر (طلب المالك «صحّح العناوين»): لاحقة REGION في
    // catalog.mjs صارت «worldwide / partout dans le monde» بدل «in Arab markets / sur les marchés arabes».
    // الصفحات العربية خارج القاعدة (paths): الجذر العربي وعناوينه المفهرسة لا تُمسّ.
    re: /\bArab\s+(?:markets?|world)\b|march[ée]s\s+arabes?|monde\s+arabe|Arap\s+(?:pazar|dünya)\w*|阿拉伯(?:市场|世界)/i,
    scope: 'head', // العنوان والوصف وH1 — gen-llms يستثني نطاق head (llms.txt يحمل عناوين المقالات الجامعة)
    paths: /^(?:en|fr|tr|zh)[\\/]/,
    why: 'عنوان أو وصف صفحة غير عربية يحصر الاستهداف في الأسواق العربية — التموضع عالمي (شركات التوزيع في أي دولة)',
  },
  {
    id: 'competitor-name',
    // قرار المالك (٢٩ يوليو ٢٠٢٦): **لا يُذكر اسم أي منافس في أي مخرَج، أبداً.**
    // المقارنة تبقى قائمة لكن بالنماذج لا بالأسماء (انظر /pricing).
    //
    // لماذا حارس آلي لا مجرّد حذف: الأسماء تتسلّل لاحقاً من مقال جديد أو سؤال
    // شائع أو نصّ CMS، والحذف اليدوي مرّة واحدة لا يمنع ذلك. هذا يفحص dist
    // في كل بناء فيمنع التسرّب قبل النشر لا بعده.
    //
    // «قيود» و«دفترة» و«مست» كلمات عربية شائعة (قيود محاسبية · دفترة الحسابات)،
    // لذلك تُطابَق الأسماء اللاتينية والنطاقات فقط — والعربية منها ما لا يلتبس.
    re: new RegExp(`\\b(?:${COMPETITORS_LATIN.join('|')})\\b|(?:${COMPETITORS_OTHER.join('|')})`, 'i'),
    scope: 'raw', // يشمل الروابط والوسوم لا النصّ المرئي وحده
    why: 'ذكر اسم منافس — قرار المالك: المقارنة بالنماذج لا بالأسماء',
  },
  {
    id: 'competitor-name-attributed',
    // أسماء منافسين في الميدان نفسه، من قائمة حارس بوت واتساب (backend/src/services/wa-agent/guard.ts)
    // بلا Odoo: نظام ERP قد يُذكر في الموقع تكاملاً أو مصدر استيراد لا منافساً.
    // منفصلة عن competitor-name لأن مصدرها يُسنَد: مقال CMS «repzo-alternative-field-reps» (رابطه وعنوانه
    // ومتنه) ينتظر قرار المالك، فلو حُجب الآن لفشل كل بناء بسبب نصّ لا يملكه المستودع. لذلك:
    //   - في نصوص المستودع (قوالب prerender والكتالوج وllms) حاجبة — verify-claims يسندها بسياقها (fromCmsContext).
    //   - في نصوص CMS تحذير يُطبع في كل بناء حتى يقرّر المالك (إعادة صياغة بلا الاسم أو noindex ثم حذف).
    // ومصادر المستودع يحرسها claimsGuard.test.ts مباشرةً بلا إسناد.
    // العربية بلا \b (حدّ الكلمة في JS لاتيني فقط) وبسوابق الجر والعطف: «وريبزو» · «لريبزو».
    re: new RegExp(`\\b(?:Repzo|repzo\\.com|Sales\\s*Buzz)\\b|(?<![${AR}])[وبلفك]?(?:ريبزو|سيلز\\s*بز)(?![${AR}])`, 'i'),
    scope: 'raw', // الرابط (slug) والعنوان والوسوم لا النصّ المرئي وحده
    cmsWarn: true,
    why: 'ذكر اسم منافس — حاجب في نصوص المستودع، وتحذير في نصوص CMS حتى يقرّر المالك (قرار ٢٩ يوليو ٢٠٢٦: لا أسماء منافسين)',
  },
  // قاموس المصطلحات (أعلاه): قاعدة لكل كلمة في avoid بلغات الموقع الخمس
  ...GLOSSARY_RULES,
];

/**
 * أول مطابقة **مُدانة** للقاعدة في النص، أو null.
 * تُفحص كل المطابقات لا الأولى وحدها: كانت الحلقة القديمة تكتفي بالأولى، فإن أعفاها نفيٌ
 * قريب مرّ أي ادّعاء لاحق في الصفحة نفسها دون فحص.
 */
export function findViolation(rule, haystack) {
  const all = findViolations(rule, haystack, 1);
  return all.length ? all[0] : null;
}

/** كل المطابقات المُدانة (حتى limit) — لحصر بنود CMS كاملةً لا أول مطابقة في كل ملف */
export function findViolations(rule, haystack, limit = Infinity) {
  const hay = norm(haystack);
  if (rule.pre && !rule.pre.test(hay)) return [];
  const flags = rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`;
  const out = [];
  for (const m of hay.matchAll(new RegExp(rule.re.source, flags))) {
    const i = m.index;
    if (rule.unless) {
      const w = hay.slice(Math.max(0, i - (rule.unlessBefore ?? 220)), i + (rule.unlessAfter ?? 220));
      if (rule.unless.test(w)) continue;
    }
    if (rule.requireNear) {
      const w = hay
        .slice(Math.max(0, i - rule.requireNear.before), i + m[0].length + rule.requireNear.after)
        .replace(new RegExp(PHASE2, 'gi'), ' '); // «2» في «المرحلة 2» ليس رقماً
      if (!rule.requireNear.re.test(w)) continue;
    }
    out.push({ index: i, match: m[0] });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * معرّفات القواعد المُدانة في نصّ واحد (كل القواعد على النص نفسه) — للاختبار.
 * عدا قواعد القاموس: هي للغة بعينها ولموضع الاستهداف (الرأس) لا لأي نصّ — «van sales» في متن إنجليزي أو «مندوب مبيعات»
 * في جملة شرح صحيحتان. تُفحص بـcheckGlossary.
 */
export function checkText(text) {
  return RULES.filter((r) => !r.glossary && findViolation(r, text)).map((r) => r.id);
}

/** قواعد قاموس لغة واحدة المُدانة في نصّ (كأنه رأس صفحة من صفحاتها) — للاختبار ولفحص ترجمة قبل نشرها */
export function checkGlossary(text, code) {
  return RULES.filter((r) => r.glossary === code && findViolation(r, text)).map((r) => r.id);
}

/**
 * إسناد مطابقة إلى CMS — لماذا: ربط المرحلة الثانية صار حيّاً، فالنفي القديم في **نصوص المستودع**
 * خطأ لا عذر له ويُحجب الآن، أمّا الباقي في **مقالات CMS** فيحرّره المالك من اللوحة (owner-actions.md §٨)
 * ويبقى تحذيراً حتى PHASE2_CMS_CLEANED. verify-claims يجلب CMS الحيّ ويسند كل مطابقة: إن وُجد نصّها
 * حرفياً في CMS فمصدرها CMS، وإلا فالمستودع.
 *
 * المقارنة بعد norm وفكّ الكيانات وحذف الوسوم والمسافات ورموز Markdown الخفيفة: dist يفصل الوسوم
 * بمسافات، وCMS قد يكتب **غامقاً** أو <strong>، فلا يُخطئ الإسناد بسبب الشكل.
 * القيد المعروف: عبارة يكرّرها نصّ في المستودع حرفياً من CMS تُحسب على CMS — واختبار
 * claimsGuard.test.ts يفحص مصادر المستودع مباشرةً فلا تفلت منه.
 */
const squash = (s) => norm(String(s))
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/[\s*_#`]+/g, '');

/** كل نصوص CMS في سلسلة واحدة مضغوطة (الفاصل U+0001 يمنع مطابقةً تعبر حقلين) */
export function cmsCorpus(data) {
  const parts = [];
  const walk = (v) => {
    if (typeof v === 'string') parts.push(squash(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(data);
  return parts.join('\u0001');
}

/** هل نصّ المطابقة موجود حرفياً في CMS؟ (corpus من cmsCorpus؛ بلا corpus لا إسناد ⇒ false) */
export function fromCms(match, corpus) {
  const m = squash(match);
  return !!corpus && m.length > 0 && corpus.includes(m);
}

/**
 * إسناد مطابقة **قصيرة** (اسم منافس: «Repzo» · «ريبزو») إلى CMS بسياقها لا بنصّها وحده.
 *
 * لماذا لا يكفي fromCms: الاسم نفسه موجود في CMS ما دام المقال حيّاً، فكل ذكرٍ له في المستودع
 * كان سيُحسب على CMS فيصير تحذيراً — أي أن قاعدة «حاجبة للمستودع» لا تحجب شيئاً. هنا يُشترط أن
 * يوجد في CMS الاسمُ **مع ما يلاصقه** من أحد جانبيه (ctx حرفاً بعد الضغط): «بدائل ريبزو (Repzo) لإدارة…»
 * في عنوان المقال أو رابطه «repzo-alternative-…» يُسند إلى CMS، أمّا «قارن FieldSales مع Repzo»
 * في قالبٍ من المستودع فلا يلاصقه في CMS شيء ⇒ مستودع ⇒ حاجب.
 * جانبٌ واحد يكفي: dist يلصق نصّ CMS بنصّ المستودع (العنوان + « | مدوّنة FieldSales»، والقوائم).
 * والمقارنة مرنة في علامات الاقتباس والفواصل والأقواس المعقوفة: كتل JSON-LD تُحذف منها في النصّ المرئي.
 *
 * haystack: النصّ نفسه الذي مُرِّر إلى findViolations (v.index على نسخته المطبَّعة)؛ بلا corpus ⇒ false.
 */
const LOOSE = /["'`,،{}[\]\\]/g;
let looseCorpus = { src: null, out: '' };
let normHay = { src: null, out: '' };
export function fromCmsContext(haystack, v, corpus, ctx = 16) {
  if (!corpus || !v || !v.match) return false;
  if (looseCorpus.src !== corpus) looseCorpus = { src: corpus, out: corpus.replace(LOOSE, '') };
  if (normHay.src !== haystack) normHay = { src: haystack, out: norm(haystack) };
  const c = looseCorpus.out;
  const hay = normHay.out;
  const tight = (s) => squash(s).replace(LOOSE, '');
  const m = tight(v.match);
  if (!m || !c.includes(m)) return false;
  // السياق من العقدة النصية نفسها فقط: يُقطع عند حدّ وسم أو سمة أو سطر، وإلا عبرت النافذة من
  // فقرة CMS قصيرة إلى ما يجاورها في الصفحة («…كنظام شامل.</p><p>نص آخر») فبدت نصّ مستودع.
  const end = v.index + v.match.length;
  const before = hay.slice(Math.max(0, v.index - ctx * 6), v.index);
  const after = hay.slice(end, end + ctx * 6);
  const cut = Math.max(before.lastIndexOf('<'), before.lastIndexOf('>'), before.lastIndexOf('"'), before.lastIndexOf('\n'));
  const stop = after.search(/[<>"\n]/);
  const left = tight(before.slice(cut + 1)).slice(-ctx);
  const right = tight(stop < 0 ? after : after.slice(0, stop)).slice(0, ctx);
  return c.includes(left + m) || c.includes(m + right);
}
