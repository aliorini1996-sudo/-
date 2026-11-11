/**
 * قواعد حارس الادّعاءات — مفصولة عن verify-claims.mjs كي يختبرها
 * src/content/claimsGuard.test.ts بالقواعد نفسها التي تحرس dist (لا نسخة موازية تنحرف).
 *
 * كل قاعدة: نمط + سبب + استثناء اختياري يمنع الإنذار الكاذب.
 *  - unless + unlessBefore/unlessAfter: نفي صريح في نافذة حول المطابقة يُعفيها (الافتراضي ±220).
 *  - requireNear: لا تُعدّ المطابقة إصابة إلا إن وُجد نمط آخر قربها (مثل موعد أو رقم).
 *  - severity: 'warn' تحذير يُطبع ولا يُفشل البناء؛ غيابها = حاجبة.
 *  - cmsWarn: حاجبة لنصوص المستودع وتحذير لنصوص CMS — verify-claims يسند كل مطابقة بسياقها (fromCmsContext).
 *  - check(hay, m): حكم إضافي على كل مطابقة (hay مطبَّع) — false يُعفيها (gov-einvoice-abroad: govClaimAt).
 *  - scope: 'head' (العنوان والوصف وH1) · 'raw' (HTML الخام) · 'blocks' (النصّ المرئي بحدود كتله أسطراً؛ من لا
 *    يميّزه — verify-i18n وimport-i18n — يمرّر النصّ المرئي) · الافتراضي النصّ المرئي.
 *  - paths / exceptPaths: تقصر القاعدة في verify-claims على ملفات dist التي يطابق مسارها النسبي paths ولا يطابق
 *    exceptPaths (الفاصل / أو \). checkText في الاختبارات يطبّقها على أي نصّ بلا مسار.
 *
 * ⚠️ كل نصّ يُطبَّع بـnorm (حذف التشكيل والتطويل) قبل الفحص، والأنماط مكتوبة بلا تشكيل:
 *    كان النمط «مُفعّل» لا يطابق «مفعّل» ولا «مفعل»، و«مُعتمَد» يفلت من «معتمد».
 */

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
  // ١١ نوفمبر ٢٠٢٦ (خطة GEO البند ١٤): موردو تقرير المنافسين ودراسة تسويقهم (123 مُدخلاً) غير المدرجين أعلاه.
  // فُحصت قبل الإضافة على المصادر (src وscripts وpublic وindex.html) وملفات الطبقة الـ152 وثلاث نسخ dist حديثة
  // (مع نصوص CMS المصيَّرة): صفر مطابقة. المستبعد عمداً لأنه كلمة عامة أو تكامل محتمل:
  //   Jobber (فعل نرويجي «يعمل» في no.json) · Outfield · Motive · Square · Toast · Lightspeed · Medusa · Cartwheel · VIP ·
  //   Ai2 (زاحف AI2Bot) · AnyPOS (يلتبس بمعرّف anyPos) · Geidea (بوابة دفع) · Zoho وحدها وZoho Books/CRM (خيار ربط في صفحة
  //   تكامل ERP) · Salesforce وحدها · QuickBooks · NetSuite · SYSPRO · Frappe/ERPNext.
  // وما يلتبس بعبارة عامة يُطابَق بسياقه لا وحده: Al-Ameen · Edara · Advantage Route · Blue Link · Encompass · Silver Bullet ·
  // Radley · Cybex · SAP DSD · Salesforce Consumer Goods Cloud · وMezan وSahl وMarn (المنافسون السعوديون الذين يعلنون المرحلة
  // الثانية في التقرير): أسماؤهم كلمات عربية شائعة بالحرف اللاتيني (ميزان: «ميزان المراجعة» · سهل · مرن) تظهر في نصوص
  // مترجمة حرفياً، فتُطابَق بسياق المنتج (Mezan ERP · Sahl POS · Marn POS) وبنطاق mezan.sa.
  // ١١ نوفمبر (مراجعة مستقلة): AFS-TELUS / AFS Technologies (توزيع مؤسسي في جداول التقرير) · Zoho RouteIQ وZoho FSM (منافسان
  // مباشران لا تكاملان) · Posist (الاسم السابق لـRestroworks).
  // المورّدون العرب المحليون
  'Al[-\\s]?Ameen\\s+(?:Software|ERP|Van\\s*Sales|Systems?)', 'Onyx\\s*Pro', 'Motakamel', 'YemenSoft', 'TrioSuite', 'TrioCashVan',
  'Phenix\\s*Van\\s*Sales', 'PDAMAROC', 'THEYSOFT', 'Protid', 'TASSARUF', 'Vatoce', 'Bitrix24',
  // المحاسبة وERP
  'Wafeq', 'Rewaa', 'DEXEF', 'AccFlex', 'Elate\\s*ERP', 'Penieltech', 'Edara\\s*(?:ERP|Software)', 'TallyPrime', 'Datacor', 'Blue\\s*Link\\s*ERP',
  'Tecsys', 'ebizframe', 'ArrowStream', 'Radley\\s+Corporation', 'Cybex\\s+Enterprise',
  // فان-سيلز للشركات الصغيرة
  'Lystloc', 'SalesJump', 'mSELL', 'Unolo', 'TrackoField', 'TrackoBit', 'TrackoMile', 'bMobile', 'Advantage\\s+Route\\s+(?:Systems|Software)',
  'Al[-\\s]?Badr\\s+Sales', 'Infotas', 'SalesRabbit', 'Route4Me', 'RouteManager', 'WorkWave', 'Onfleet', 'Onsight',
  // أتمتة قوة البيع للسوق المتوسط
  'Repsly', 'SPOTIO', 'SimplyDepo', 'Pepperi', 'Advantive', 'Badger\\s*Maps', 'LeadSquared', 'SalesPort', 'Fieldproxy', 'Connecteam', 'Hubstaff',
  'Timeero', 'Housecall\\s*Pro', 'ServiceTitan', 'SynTrack', 'Synergia\\s*Soft', 'RealSoft', 'Axolon', 'Veloxy', 'Jibble',
  // التوزيع المؤسسي
  'SAP\\s+DSD', 'Salesforce\\s+(?:Consumer\\s+Goods|CG)\\s+Cloud', 'Resco', 'xkzero', 'StayinFront', 'Vistex', 'eoStar',
  'AFS\\s*[-/]?\\s*TELUS', 'AFS\\s+Technologies', 'Zoho\\s+(?:RouteIQ|FSM|Field\\s+Service)',
  'Mezan\\s+(?:ERP|Accounting|App|POS|Software|Cloud)', 'mezan\\.sa', 'Sahl\\s+(?:POS|ERP|Accounting|Software|App|Van\\s*Sales)', 'Marn\\s+(?:POS|App|Cashier)',
  'Encompass\\s+(?:Distribution|Technologies)', 'Silver\\s+Bullet\\s+(?:Suite|Technology)', 'SalesWorx', 'Focus\\s*Softnet',
  // مفتوح المصدر وإضافات الفان-سيلز
  'ERPGulf', 'FieldOpt', 'Netilligence', 'VanGo', 'Sellbee', 'TABSYST', 'Dolibarr', 'DoliCloud', 'EspoCRM', 'Tryton', 'Axelor', 'Vtiger',
  // كاشير المطاعم
  'Foodics', 'TapFood', 'Grubtech', 'Petpooja', 'Restroworks', 'Posist', 'Loyverse', 'LazyWait', 'SambaPOS', 'Ordable',
];
/**
 * بلا \b (حدّ الكلمة في JS لاتيني فقط): الصينية والكورية والروسية، والعربية بحدود حروفها وسوابق الجر والعطف («وفودكس» · «لفودكس»).
 * العربية منها ما لا يلتبس بكلمة شائعة وحده: لا «قيود» ولا «دفترة» ولا «ميزان» ولا «سهل» ولا «مرن» ولا «وافق».
 */
const COMPETITORS_OTHER = ['勤策', '外勤365', '舟谱云', '纷享销客', '易订货', '易指快销', '세일즈덕', '샤플', '모두의거래', 'Агент\\s*Плюс',
  `(?<![${AR}])[وبلفك]?(?:فودكس|فوديكس)(?![${AR}])`];

/**
 * ─── ربط حكومي خارج السعودية (gov-einvoice-abroad) — خطة GEO البند ١٤ ─────────────────────────────────
 * قرار المالك: الربط الحكومي حيّ في السعودية وحدها (ZATCA ومنصة «فاتورة» — خارج هذه القائمة عمداً)، وغيرها
 * «عند الطلب» بلا وعد. الممنوع **ادّعاء** الربط أو التكامل أو الدعم أو التوافق أو الامتثال منسوباً إلى FieldSales
 * أو «نحن» أو منتجنا، مع اسم منظومة فوترة حكومية أو جهتها في الجملة نفسها. **الذكر الواقعي** مشروع بل مطلوب في
 * صفحات الدول: «CFDI 4.0 إلزامي في المكسيك» و«يشترط SAT أن تتوافق الفاتورة مع CFDI» لا فاعل منّا فيهما.
 *
 * القائمة: خطة GEO (§٣ «أنظمة فوترة يُمنع ادعاء الربط بها») + منظومات D:/claude-work/country-facts/*.json وجهاتها
 * + أشهر غيرها. لكل دولة نمطها بنظام كتابتها، والحدود بحروف النظام نفسه: «وSAT» العربية تُطابَق، و«SATURDAY» لا.
 * الاختصارات بحالة أحرفها (SAT · BIR · ETA — لا «sat» ولا «bir» التركية ولا «eta» الباسكية)، **والأسماء الرسمية الكاملة** بلغات
 * صفحات الدول والكتالوج (Kenya Revenue Authority · Direction générale des impôts · Nota Fiscal Eletrônica · Autorité fédérale des
 * impôts · هيئة الضرائب المصرية…): الاختصار وحده كان يترك «FieldSales is integrated with the Kenya Revenue Authority» تمرّ.
 * cc: الدول التي يخصّها النمط — claimsGuard.test.ts يشترط لكل دولة في حقائق الدول المدقّقة مُدخلاً بها، ويفحص كل اسم فيها على حدة.
 *
 * ⚠️ لا يدخلها مصطلح عامّ تُترجَم به «الفوترة الإلكترونية» نفسها: E-Rechnung (de.json) · e-fatura (التركية تقولها
 * لـZATCA) · e-factura (nl وay وgn وqu وrm) · hóa đơn điện tử (vi.json) · 电子发票 (zh) · インボイス (ja) — ملفات الطبقة
 * تستعملها في جملة «الربط الحكومي حيّ في السعودية وعند الطلب في غيرها» الصادقة. ولا Soliq (الأوزبكية: «ضريبة»).
 * IRN رمز إيران ISO3 أيضاً في world-countries.json — يبقى لأنه رقم الفاتورة الهندي ولا يُدان إلا مع فعل ربط منسوب.
 */
export const GOV_EINVOICING = [
  // الأمريكتان
  { cc: ['MX', 'GT', 'BR'], latin: 'SAT' }, // المكسيك وغواتيمالا، وCF-e-SAT البرازيلي
  { cc: ['MX'], latin: 'CFDI|Comprobante\\s+Fiscal\\s+Digital(?:\\s+por\\s+Internet)?|Servicio\\s+de\\s+Administraci[oó]n\\s+Tributaria|Carta\\s+Porte' },
  { cc: ['GT'], latin: 'FEL' },
  { cc: ['CO'], latin: 'DIAN|RADIAN|CUFE|SFE|Direcci[oó]n\\s+de\\s+Impuestos\\s+y\\s+Aduanas\\s+Nacionales' },
  { cc: ['BR'], latin: 'SEFAZ|Sefaz|NFC-?e|NFS-?e|NF-?e|CT-?e|MDF-?e|CF-?e|SPED|DANFE|ENCAT|RFB|CGIBS|Receita\\s+Federal'
    + '|Secretarias?\\s+(?:[Ee]staduais\\s+)?da\\s+Fazenda|[Nn]ota\\s+[Ff]iscal\\s+(?:de\\s+[Cc]onsumidor\\s+|de\\s+[Ss]ervi[çc]os?\\s+)?[Ee]letr[ôo]nica' },
  { cc: ['CL', 'ES'], latin: 'SII' },
  { cc: ['CL', 'SV'], latin: 'DTE' },
  { cc: ['AR'], latin: 'ARCA|AFIP' },
  { cc: ['PE'], latin: 'SUNAT' },
  { cc: ['EC'], latin: 'SRI' },
  { cc: ['UY', 'PA', 'MA', 'CI', 'CM', 'DZ'], latin: 'DGI' },
  // الاسم الكامل لـDGI (ساحل العاج والكاميرون والمغرب والجزائر، وDGID السنغال بـ«et des Domaines») وصيغته الإنجليزية في الكتالوج
  { cc: ['MA', 'CI', 'CM', 'DZ', 'SN'], latin: '[Dd]irection\\s+[Gg][ée]n[ée]rale\\s+des\\s+[Ii]mp[ôo]ts(?:\\s+et\\s+des\\s+[Dd]omaines)?|General\\s+Directorate\\s+of\\s+Taxes' },
  { cc: ['PY'], latin: 'SIFEN' },
  { cc: ['BO'], latin: 'SIAT' },
  { cc: ['DO'], latin: 'DGII|e-CF' },
  { cc: ['VE'], latin: 'SENIAT' },
  // أوروبا
  { cc: ['PL'], latin: 'KSeF|Krajowy\\s+System\\s+e-Faktur' },
  { cc: ['RO'], latin: 'ANAF|RO\\s*e-Factura' },
  { cc: ['IT'], latin: 'SdI|SDI|Sistema\\s+di\\s+Interscambio|FatturaPA|Agenzia\\s+delle\\s+Entrate' },
  { cc: ['FR'], latin: 'Chorus\\s*Pro|PPF|Portail\\s+[Pp]ublic\\s+de\\s+[Ff]acturation|DGFiP|Factur-X' },
  { cc: ['DE'], latin: 'XRechnung|ZUGFeRD' },
  { cc: ['ES'], latin: 'VERI\\*?FACTU|Veri\\*?[Ff]actu|TicketBAI|AEAT|FACe' },
  { cc: ['PT'], latin: 'SAF-T|ATCUD|Autoridade\\s+Tribut[aá]ria' },
  { cc: ['GR'], latin: 'myDATA|AADE' },
  { cc: ['HU'], latin: 'Online\\s+Sz[aá]mla|NAV\\s+Online' },
  { cc: ['RS'], latin: 'SEF' },
  { cc: ['AE', 'SG', 'MY', 'JP', 'AU', 'NZ', 'BE'], latin: 'Peppol|PEPPOL|PINT-AE' },
  // تركيا وآسيا الوسطى وروسيا
  { cc: ['TR'], latin: 'GİB|GIB|Gelir\\s+[İI]daresi|e-Ar[şs]iv|e-[İI]rsaliye' },
  { cc: ['KZ'], latin: 'ESF', cyrl: 'ЭСФ|КГД' },
  { cc: ['RU'], cyrl: 'ФНС|ОФД|ЕГАИС|Честный\\s+(?:знак|ЗНАК)' },
  // الشرق الأوسط وشمال أفريقيا — الجهات بأسمائها الكاملة بالإنجليزية والفرنسية (صفحات الدول والكتالوج) لا بالاختصار وحده
  { cc: ['EG'], latin: 'ETA|Egyptian\\s+Tax\\s+Authority|[Aa](?:dministration|utorit[ée])\\s+[Ff]iscale\\s+[ÉEée]gyptienne',
    arab: 'مصلح[ةه]\\s*الضرائب(?:\\s*المصري[ةه])?|هيئ[ةه]\\s*الضرائب\\s*المصري[ةه]'
      + '|منظوم[ةه]\\s*(?:ال)?(?:فاتور[ةه]|[إا]يصال)\\s*(?:ال)?[إا]?لكتروني[ةه]?\\s*(?:ال)?مصري[ةه]|منظوم[ةه]\\s*(?:ال)?[إا]يصال\\s*(?:ال)?[إا]?لكتروني' },
  { cc: ['AE'], latin: 'FTA|EmaraTax|Federal\\s+Tax\\s+Authority|UAE\\s+Electronic\\s+Invoicing\\s+System|[Aa]utorit[ée]\\s+[Ff][ée]d[ée]rale\\s+des\\s+[Ii]mp[ôo]ts',
    arab: '(?:ال|لل)هيئ[ةه]\\s*(?:ال)?اتحادي[ةه]\\s*للضرائب' },
  { cc: ['OM'], latin: 'Fawtara|Oman\\s+Tax\\s+Authority|[Aa]utorit[ée]\\s+[Ff]iscale\\s+(?:d[\'’]Oman|omanaise)', arab: 'جهاز\\s*الضرائب' },
  { cc: ['JO'], latin: 'JoFotara|ISTD|Income\\s+and\\s+Sales\\s+Tax\\s+Department', arab: 'دائر[ةه]\\s*ضريب[ةه]\\s*الدخل\\s*والمبيعات|جو\\s*فوتر[ةه]' },
  { cc: ['BH', 'BD'], latin: 'NBR|National\\s+Bureau\\s+(?:for|of)\\s+Revenue|National\\s+Board\\s+of\\s+Revenue|[Bb]ureau\\s+[Nn]ational\\s+des\\s+[Rr]evenus',
    arab: '(?:ال|لل)جهاز\\s*(?:ال)?وطني\\s*للإيرادات' },
  { cc: ['TN'], latin: 'TTN|El[\\s-]?Fat(?:oo|ou)ra|Tunisie\\s+TradeNet', arab: '(?:ال|لل)[إا]دار[ةه]\\s*(?:ال)?عام[ةه]\\s*للأداءات' },
  { cc: ['IQ', 'QA'], arab: '(?:ال|لل)هيئ[ةه]\\s*(?:ال)?عام[ةه]\\s*للضرائب' },
  { cc: ['IQ'], latin: 'General\\s+Commission\\s+for\\s+Taxes|GCT|[Cc]ommission\\s+[Gg][ée]n[ée]rale\\s+des\\s+[Ii]mp[ôo]ts' },
  { cc: ['QA'], latin: 'General\\s+Tax\\s+Authority|[Aa]utorit[ée]\\s+[Gg][ée]n[ée]rale\\s+des\\s+[Ii]mp[ôo]ts|Dhareeba' },
  { cc: ['MA', 'DZ'], arab: '(?:ال|لل)مديري[ةه]\\s*(?:ال)?عام[ةه]\\s*للضرائب' },
  { cc: ['IR'], latin: 'Moadian', arab: 'سامانه\\s*مودیان|مودیان' },
  // نظام أرقام التخصيص (قائمة الخطة): نمط حاجب بلا رمز دولة — قرار المالك أن ذلك البلد لا يُضاف، فلا رمز له في بيانات مصدَّرة
  { cc: [], hebr: 'מספר\\s*הקצאה' },
  // آسيا
  { cc: ['IN'], latin: 'IRP|GSTN|[Ee]-Way\\s+Bill' },
  { cc: ['IN', 'NG'], latin: 'IRN' },
  { cc: ['PK'], latin: 'FBR|PRAL|KPRA|Federal\\s+Board\\s+of\\s+Revenue|Pakistan\\s+Revenue\\s+Automation' },
  // «faktur pajak» هي الفاتورة الضريبية الرسمية نفسها (لا تصدر إلا عبر e-Faktur/Coretax)، لا مصطلح عامّ للفوترة الإلكترونية
  { cc: ['ID'], latin: 'DJP|Core[Tt]ax|e-Faktur|PJAP|Direktorat\\s+Jenderal\\s+Pajak|Directorate\\s+General\\s+of\\s+Taxes|[Ff]aktur\\s+[Pp]ajak(?:\\s+[Ee]lektronik)?' },
  { cc: ['MY'], latin: 'LHDNM?|MyInvois|IRBM' },
  { cc: ['SG'], latin: 'IRAS|InvoiceNow' },
  { cc: ['PH'], latin: 'BIR|EIS|Bureau\\s+of\\s+Internal\\s+Revenue' },
  { cc: ['VN'], latin: 'T[ổô]ng\\s+c[ụu]c\\s+Thu[ếe]|h[óo]a\\s+đ[ơo]n\\s+đi[ệe]n\\s+t[ửu]\\s+c[óo]\\s+m[ãa]' },
  { cc: ['TH'], latin: 'e-Tax\\s+Invoice', free: 'กรมสรรพากร' },
  { cc: ['CN'], latin: 'Golden\\s+Tax', free: '全电发票|数电发票|金税|国家税务总局' },
  { cc: ['KR'], latin: 'Home[Tt]ax|NTS', free: '국세청|홈택스|전자세금계산서' },
  { cc: ['JP'], free: '適格請求書|インボイス制度|国税庁' },
  // أفريقيا
  { cc: ['KE'], latin: 'KRA|e?TIMS|iTax|OSCU|VSCU|Kenya\\s+Revenue\\s+Authority|Electronic\\s+Tax\\s+Invoice\\s+Management\\s+System' },
  { cc: ['TZ'], latin: 'TRA|VFD' },
  { cc: ['TZ', 'ET'], latin: 'EFD' },
  { cc: ['UG'], latin: 'URA|EFRIS' },
  { cc: ['RW'], latin: 'RRA|EBM' },
  { cc: ['ZM'], latin: 'ZRA' },
  { cc: ['ZW'], latin: 'ZIMRA|FDMS' },
  // MBS وحدها اسم المنصة في صفحة نيجيريا، وEFS نظامها الضريبي الإلكتروني (E-Invoicing and Electronic Fiscal System)
  { cc: ['NG'], latin: 'FIRS|NRS(?:MBS)?|MBS|EFS|Merchant\\s+Buyer\\s+Solution|Nigeria\\s+Revenue\\s+Service|Federal\\s+Inland\\s+Revenue\\s+Service' },
  { cc: ['GH'], latin: 'GRA|E-VAT|VSDC|Ghana\\s+Revenue\\s+Authority|Virtual\\s+Sales\\s+Data\\s+Controller|Certified\\s+Invoicing\\s+System' },
  { cc: ['CI'], latin: 'FNE|RNE|TERNE|[Ff]acture\\s+[Nn]ormalis[ée]e\\s+[ÉEée]lectronique|[Rr]e[çc]u\\s+[Nn]ormalis[ée]\\s+[ÉEée]lectronique' },
  { cc: ['SN'], latin: 'DGID' },
  { cc: ['ZA'], latin: 'SARS|South\\s+African\\s+Revenue\\s+Service' },
  { cc: ['MU'], latin: 'MRA' },
  { cc: ['BW'], latin: 'BURS' },
];

const govAlt = (key) => GOV_EINVOICING.filter((e) => e[key]).map((e) => e[key]).join('|');
/**
 * اسم منظومة أو جهة فوترة حكومية خارج السعودية (بلا حساسية حالة: الاختصارات بحالتها). الحدّ بحروف نظام الكتابة نفسه،
 * والعربية تقبل سوابق الجر والعطف («ولمصلحة الضرائب»). الصينية والكورية واليابانية والتايلاندية بلا حدّ (لا مسافات).
 */
export const GOV_EINVOICING_RE = new RegExp([
  `(?<![\\p{Script=Latin}\\p{N}])(?:${govAlt('latin')})(?![\\p{Script=Latin}\\p{N}])`,
  `(?<![\\p{Script=Cyrillic}\\p{N}])(?:${govAlt('cyrl')})(?![\\p{Script=Cyrillic}\\p{N}])`,
  `(?<![\\p{Script=Arabic}\\p{N}])[وبلفك]?(?:${govAlt('arab')})(?![\\p{Script=Arabic}])`,
  `(?<![\\p{Script=Hebrew}])(?:${govAlt('hebr')})`,
  `(?:${govAlt('free')})`,
].join('|'), 'u');

/** بداية كلمة: لا حرف ولا رقم قبلها (\b لاتيني فقط في JS) */
const W = '(?<![\\p{L}\\p{N}])';
const WE = '(?![\\p{L}\\p{N}])';

/**
 * فعل الربط/التكامل/الدعم/التوافق/الامتثال بلغات الموقع الخمس ولغات الطبقة الأوسع انتشاراً — يُقبل قبل الاسم أو بعده
 * بحدّ ٥٠ حرفاً. الصفة العامة وحدها ليست ربطاً: «منصة متكاملة» و«an integrated platform» و«plataforma integrada»
 * وصفٌ للمنتج، فالصفة تُشترط بحرف صلتها («متكامل مع» · «مرتبط بـ» · «integrated with» · «integrado con» · «intégrée à»).
 * لا يكفي الفعل وحده: يُشترط فاعلٌ منّا (govAttributed) أو صيغة بند بلا فاعل (GOV_LEAD).
 *
 * ⚠️ norm يحذف التنوين وتبقى ألفه: «ربطاً» تصير «ربطا» و«تكاملاً» «تكاملا» — فالمصدر والفعل العربيان يقبلان لاحقة
 *    (ا · ه · ها · هم · هما · ات)، ومنها الضمير المتصل («يتيح ربطه مع منظومة ETA»). والصفة تقبل ظرفاً أو ظرفين
 *    (AR_ADVERB) قبل حرف الصلة («متوافق تماماً مع» · «متكامل بشكل كامل مع»)، لا أي كلمة: «متكاملة لإدارة المناديب بالكامل» وصف.
 */
const AR_SUFFIX = '(?:ا|ه|ها|هم|هما|ات)?';
const AR_ADVERB = '(?:تماما|كليا|كاملا|بالكامل|بالتمام|مباشر[ةه]|تلقائيا|رسميا|فعليا|فعلا|حاليا|الآن|الان|اليوم|دائما|كذلك|[أا]يضا'
  + '|بشكل\\s+(?:كامل|مباشر|تام|تلقائي|رسمي|فعلي)|بصور[ةه]\\s+(?:كامل[ةه]|مباشر[ةه]|تام[ةه]|تلقائي[ةه]|رسمي[ةه]))';
const GOV_LINK = new RegExp([
  // الإنجليزية — «support» اسماً («our support team» · «support hours») ليس فعل ربط
  `${W}(?:integrat(?:es?|ing|ions?)|integrated\\s+(?:with|into|to)|interfac\\p{L}*|connect(?:s|ed|ing|ions?|ors?)?|sync\\p{L}*|(?<!(?:our|the|customer|technical|tech|local|dedicated|live|Arabic)\\s+)support(?:s|ed|ing)?(?!\\s+(?:teams?|cent(?:er|re)s?|staff|agents?|desk|pages?|portal|tickets?|hours|channels?|engineers?|specialists?|services?|plans?)${WE})|compatib\\p{L}*|complian\\p{L}*|conform\\p{L}*|homolog\\p{L}*|link(?:s|ed)?|plug(?:s|ged)?\\s+into|works?\\s+with|ready\\s+for|certified|approved|accredited|authori[sz]ed)${WE}`,
  // الفرنسية — «se connecte à la DGI» كانت تفلت (الإنجليزية connect لا تقبل e بعدها)
  `${W}(?:int[èé]gr(?:e|es|ent|ons|er|ation|ations)|int[ée]gr[ée]e?s?\\s+(?:à|a|avec|au|aux|dans)|connexions?|connect(?:e|es|ent|ons|é|ée|és|ées)|reli[ée]e?s?|raccord\\p{L}*|synchronis\\p{L}*|certifi\\p{L}*|agr[ée]{2}\\p{L}*|(?:prend\\p{L}*|pris\\p{L}*|prenons)\\s+en\\s+charge)${WE}`,
  // التركية
  `${W}(?:entegr|bağlan|bağlant|destekl|uyum|onaylı|sertifikal)`,
  // الإسبانية والبرتغالية والإيطالية
  `${W}(?:integra(?:mos|n|r|ción|ciones|ção|ções|zione|zioni)?|integrad[oa]s?\\s+(?:con|com|a|al|ao|à|en|no|na)|integrat[oa]\\s+(?:con|a|al|nel|nella)|integr[ao]-se|vincul\\p{L}*|sincroniz\\p{L}*|cumpl\\p{L}*|soport\\p{L}*|admit\\p{L}*|certific\\p{L}*|autoriz\\p{L}*|compat[ií]v\\p{L}*|suport\\p{L}*|liga(?:ção|do|da|dos|das|mos)|collega\\p{L}*|connes\\p{L}*)${WE}`,
  `${W}(?:conect|conex)`,
  // الإندونيسية والملايوية والألمانية والبولندية والهولندية والروسية والأوكرانية والفيتنامية والسواحيلية والعبرية واليونانية والهندية
  `${W}(?:terintegrasi\\s+(?:dengan|ke)|mengintegrasikan|integrasi|terhubung|menghubungkan|terkoneksi|koneksi|mendukung|didukung|menyokong|disokong|kompatib\\p{L}*|serasi|sesuai\\s+dengan|patuh|sinkron\\p{L}*|tersambung)${WE}`,
  `${W}(?:angebunden|anbindung|verbunden|verbind|unterstütz|integriert(?!e)|konform|zertifiziert|połącz|obsług|wspier|zgodn|kompatyb|certyfik|koppel|gekoppeld|ondersteun)`,
  `${W}(?:интегр|подключ|связ|поддерж|совмест|соответств|сертифиц|інтегр|підтрим|підключ)`,
  `${W}(?:tích\\s+hợp|kết\\s+nối|hỗ\\s+trợ|tương\\s+thích|tuân\\s+thủ|đồng\\s+bộ|liên\\s+thông|unganish|inaunganisha|inaendana|inasaidia)`,
  `${W}(?:משולב|אינטגרציה|מתממשק|תומך|תואם|מחובר|διασύνδεσ|συνδέ|υποστηρίζ|συμβατ|एकीकृत|इंटीग्रेट|जुड़|कनेक्ट|समर्थन|सपोर्ट|अनुपालन|संगत)`,
  // العربية (والفارسية والأردية لما تشاركه) — المصدر والفعل بلاحقتهما، والصفة بحرف صلتها: «متوافق مع» · «مرتبط بمنظومة»
  `(?<![\\p{L}\\p{N}])[وف]?(?:ب|ل)?(?:ال|ل)?(?:ربط|يربط|تربط|نربط|ربطنا|يرتبط|ترتبط|نرتبط|ارتباط|تكامل|يتكامل|تتكامل|نتكامل|تكاملنا|يدعم|تدعم|ندعم|ندعمها|ندعمه|مدعوم[ةه]?|يتوافق|تتوافق|نتوافق|توافق|يمتثل|تمتثل|نمتثل|امتثال|يتصل|تتصل|نتصل|يزامن|نزامن|مزامن[ةه]|جاهز(?:ون|[ةه])?|معتمد[ةه]?|مرخص[ةه]?|مصادق[ةه]?|منسلک|پشتیبانی|یکپارچه|سازگار)${AR_SUFFIX}(?![\\p{L}\\p{N}])`,
  // «متكاملة لإدارة المناديب» وصفٌ لا صلة: اللام لـ«ممتثل لـ» وحدها
  `(?<![\\p{L}\\p{N}])[وف]?(?:ال)?(?:(?:متكامل|متوافق|مربوط|مرتبط|متصل)(?:[ةه]|ون|ين|ا)?(?:\\s+${AR_ADVERB}){0,2}\\s+(?:مع|ب\\p{L})|ممتثل(?:[ةه]|ون|ين|ا)?(?:\\s+${AR_ADVERB}){0,2}\\s+(?:مع|ل\\p{L}))`,
  // بلا مسافات: الصينية واليابانية والكورية والتايلاندية
  '对接|集成|连接|接入|打通|支持|兼容|符合|合规|同步|认证|直连|連携|対応|準拠|接続|統合|연동|연계|지원|호환|준수|통합|연결|เชื่อมต่อ|รองรับ|บูรณาการ|สอดคล้อง',
].join('|'), 'giu');

/** صيغة اسمية لفعل الربط («integration» · «الربط») — نفيها قد يأتي بعدها: «SAT integration is not available» · «ربط ETA غير متاح» */
const GOV_LINK_NOMINAL = /^(?:[وف]?(?:ب|ل)?(?:ال|ل)?(?:ربط|ارتباط|تكامل|توافق|امتثال)|integrations?$|connections?$|connectors?$|compatibility$|compliance$|int[ée]grations?$|connexions?$|integraci|conex$|integra[çc][ãõ]|integrazion|anbindung$|integrasi$|koneksi$)/iu;

/**
 * فعل الإرسال/الإصدار/التوليد — أضعف دلالة («تصدر منصة FieldSales الفاتورة» صادقة)، فيُشترط أن يسبق الاسم بحدّ ٤٠ حرفاً،
 * أي أن يكون الاسم مفعوله أو وجهته: «emite NF-e» · «sends invoices to KSeF» · «transmite las facturas a la DIAN».
 * والنصوص العربية بلا ترقيم في الكتالوج («…مصلحة الضرائب المصرية … تصدر منصة FieldSales الفاتورة») لا تُدان به.
 */
const GOV_LINK_FWD = new RegExp([
  `${W}(?:submit\\p{L}*|transmi\\p{L}*|sends?|sent|sending|reports?\\s+to|reported\\s+to|issu(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|stamp(?:s|ed|ing)?|e-?fil(?:e|es|ed|ing)|upload\\p{L}*)${WE}`,
  `${W}(?:transm[ei]t\\p{L}*|envo[iy]\\p{L}*|[ée]m(?:et|ett|is)\\p{L}*|g[ée]n[èé]r\\p{L}*|t[ée]l[ée]transm\\p{L}*|gönder\\p{L}*|aktar\\p{L}*|düzenl\\p{L}*|oluştur\\p{L}*|ilet\\p{L}*)${WE}`,
  `${W}(?:timbr\\p{L}*|envi[aáoe]\\p{L}*|transmit\\p{L}*|report[ae]\\p{L}*|emit\\p{L}*|emis\\p{L}*|emiss\\p{L}*|gener(?:a|an|amos|ado|ada|ados|adas)|ger(?:a|am|amos|ado|ada)|trasmett\\p{L}*|invia\\p{L}*|mengirim\\p{L}*|menerbitkan|übermitt\\p{L}*|przesył\\p{L}*|wysył\\p{L}*|trimit\\p{L}*|переда\\p{L}*|отправл\\p{L}*|выгруж\\p{L}*)${WE}`,
  `(?<![\\p{L}\\p{N}])[وف]?(?:ي|ت|ن)?(?:رسل|رفع|صدر)(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])[وف]?(?:ب|ل)?(?:ال)?(?:إرسال|ارسال)(?![\\p{L}\\p{N}])`,
  '上传|开具|送信|発行|전송|발행',
].join('|'), 'giu');

/**
 * اسمنا **بحالة أحرفه** وبحدود الحروف اللاتينية وحدها («لـFieldSales» · «FieldSales는» تُطابَق): «FieldSales»، أو «Field Sales»
 * — يُكتب به الاسم في المستودع مئات المرات («Field Sales is» · «the Field Sales app» · «the Field Sales team») — ما لم يتبعه اسم
 * فئة عامّ بصيغة العنوان («Field Sales Software in Egypt» · «Field Sales Teams» · «Offline Field Sales App»). أمّا «field sales»
 * و«Field sales» بحرف صغير فاسم الفئة نفسها في المتن («Field sales teams in Kenya must…»)، لا فاعلٌ منّا.
 */
const GENERIC_HEAD = '(?:[Ss]oftware|[Mm]anagement|[Tt]eams|Team|[Rr]eps?|[Rr]epresentatives?|[Ss]ystems?|Apps?|apps|[Aa]utomation|[Tt]racking|[Ff]orces?|KPIs?'
  + '|[Tt]raining|[Ss]trateg\\p{L}*|[Pp]rocess\\p{L}*|[Pp]rofessionals?|[Mm]anagers?|[Ss]olutions?|[Tt]ools?|[Jj]obs?|[Rr]oles?|[Ee]xecutives?|[Aa]gents?'
  + '|[Oo]rgani[sz]ations?|[Cc]ompanies|[Pp]latforms|[Cc]ycles?|[Pp]ipelines?|[Tt]erritor\\p{L}*|[Rr]outes?|CRM)';
const LAT_B = '(?<![\\p{Script=Latin}\\p{N}])';
const LAT_E = '(?![\\p{Script=Latin}\\p{N}])';
const OUR_BRAND_SRC = `${LAT_B}(?:FieldSales|FIELDSALES|Field\\s?Sales(?!\\s+${GENERIC_HEAD}${LAT_E}))${LAT_E}|فيلد\\s*سيلز|fieldsa\\.net`;
const OUR_BRAND = new RegExp(OUR_BRAND_SRC, 'u');

/**
 * فاعلٌ منّا بلا شرط: ملكية منتجنا، أو فعل بصيغة المتكلم يدلّ على الربط أو الإرسال (ندعم · integramos · destekliyoruz)، أو ضمير
 * لغةٍ يتأخر فيها الفعل (biz · wir) أو لا تفصل كلماتها مسافات.
 */
const GOV_ATTRIB = new RegExp([
  `(?<![\\p{L}\\p{N}])[وف]?(?:منصتنا|نظامنا|تطبيقنا|تطبيقاتنا|برنامجنا|حلنا|حلولنا|فواتيرنا|منتجنا|ندعم|ندعمها|ندعمه|نربط|ربطنا|نرتبط|نتكامل|تكاملنا|نتوافق|نمتثل|نتصل|نرسل|نرفع|نزامن|نصدر)(?![\\p{L}\\p{N}])`,
  `${W}(?:biz|wir|unser(?:e|er|en|em)?|nostr[oaie])${WE}`,
  `${W}(?:our|notre|nos|nuestr[oa]s?|noss[oa]s?)\\s+(?:[\\p{L}-]+\\s+){0,2}?(?:platform|plateforme|plataforma|app|apps|application|applications|aplicaci[oó]n|aplicativo|appli|software|logiciel|system|syst[èe]me|sistema|solution|soluci[oó]n|solução|product|produit|producto|produto|tool|outil|herramienta|ferramenta|invoices?|factures?|facturas?|faturas?)${WE}`,
  `${W}the\\s+(?:rep|mobile|field|sales|van)\\s+app${WE}`,
  `${W}(?:platformumuz|uygulamamız|yazılımımız|sistemimiz|çözümümüz|nasz\\p{L}*|наш\\p{L}*|integramos|conectamos|vinculamos|sincronizamos|soportamos|suportamos|admitimos|cumplimos|emitimos|enviamos|transmitimos|timbramos|generamos|geramos|reportamos|homologamos|int[ée]grons|connectons|transmettons|envoyons|[ée]mettons|relions|prenons\\s+en\\s+charge|integriamo|colleghiamo|supportiamo|trasmettiamo|inviamo|integrujemy|obsługujemy|wspieramy|łączymy|wysyłamy|przesyłamy|integrăm|conectăm|suportăm|transmitem|trimitem)${WE}`,
  `${W}(?:destekliyoruz|destekleriz|bağlanıyoruz|bağlıyoruz|entegre\\s+(?:ediyoruz|ederiz|olduk)|gönderiyoruz|aktarıyoruz|düzenliyoruz)${WE}`,
  '我们|我方|本平台|本系统|本软件|本应用|当社|弊社|私たち|저희|우리|เรา',
  // الهندية بحروف العلة اللاحقة (\p{M}): «हम» داخل «हमेशा» ليست ضميراً
  '(?<![\\p{L}\\p{M}])हम(?:ारा|ारी|ारे)?(?![\\p{L}\\p{M}])|(?<![\\p{Script=Hebrew}])(?:אנחנו|אנו)(?![\\p{Script=Hebrew}])',
].join('|'), 'iu');

/**
 * ضمير المتكلم في لغة يلي فيها الفعلُ الفاعلَ (we · nous · nosotros · nós · kami · noi · мы · نحن · لدينا) و«نوفر/نقدم/نتيح»: فاعلٌ منّا
 * **بشرط** أن يليه فعل الربط مباشرةً (GOV_FILLER بينهما: مساعد أو ظرف أو أداة — «We are fully compliant with» · «نوفر ربطاً فورياً مع»)،
 * أو فعل تمكين ثم ثلاث كلمات بحدّ («we help distributors connect to SEFAZ»). فـ«we» التحريرية ليست ادّعاءً:
 * «We explain how businesses connect to SEFAZ» و«نقدم شرحاً لكيفية ربط الشركات بمنظومة ETA» شرحٌ لا ربط.
 */
const GOV_PRONOUN = new RegExp([
  `${W}(?:we|we['’](?:re|ve|ll)|nous|nosotros|nós|kami|noi|мы|ми|sisi|chúng\\s+tôi)${WE}`,
  `(?<![\\p{L}\\p{N}])[وف]?(?:نحن|لدينا|عندنا|نوفر|نقدم|نتيح|نضمن|نساعد(?:ك|كم)?|نمكن(?:ك|كم)?)(?![\\p{L}\\p{N}])`,
].join('|'), 'giu');
const FILLER_WORDS = [
  'are', 'have', 'has', 'will', 'can', 'could', 'do', 'does', 'now', 'fully', 'directly', 'also', 'already', 'natively', 'seamlessly', 'automatically',
  'officially', 'currently', 'completely', 'be', 'been', 'proudly', 'securely', 'still', 'today', 'easily', 'instantly', 'always', 'deeply', 'tightly',
  'actively', 'readily', 'technically', 'offer', 'provide', 'include', 'ship', 'built', 'launched', 'added',
  'a', 'an', 'the', 'full', 'native', 'direct', 'seamless', 'built-in', 'complete', 'real-time', 'automatic', 'official', 'deep', 'tight', 'two-way', 'live',
  'sommes', 'avons', 'pouvons', 'allons', 'serons', 'désormais', 'directement', 'aussi', 'déjà', 'entièrement', 'automatiquement', 'nativement',
  'officiellement', 'totalement', 'également', 'maintenant', 'actuellement', 'vous', 'les', 'la', 'le', 'y', 'en', 'leur', 'lui', 'nous', 'offrons',
  'proposons', 'fournissons', 'une', 'un',
  'estamos', 'somos', 'hemos', 'podemos', 'vamos', 'ya', 'también', 'totalmente', 'automáticamente', 'oficialmente', 'plenamente', 'completamente',
  'ahora', 'hoy', 'actualmente', 'nos', 'lo', 'los', 'las', 'les', 'se', 'ofrecemos', 'proporcionamos', 'una', 'el',
  'temos', 'já', 'também', 'diretamente', 'automaticamente', 'agora', 'hoje', 'atualmente', 'o', 'os', 'as', 'lhe', 'lhes', 'oferecemos', 'fornecemos', 'uma', 'um',
  'sudah', 'telah', 'juga', 'langsung', 'secara', 'otomatis', 'resmi', 'penuh', 'dapat', 'bisa', 'akan', 'sedang', 'kini', 'sekarang', 'siap', 'menyediakan', 'menawarkan',
  'уже', 'полностью', 'напрямую', 'также', 'теперь', 'официально', 'можем', 'сейчас',
  'siamo', 'abbiamo', 'possiamo', 'già', 'anche', 'direttamente', 'ora', 'vi', 'ci', 'si', 'offriamo',
  'đã', 'đang', 'cũng', 'hoàn\\s+toàn', 'trực\\s+tiếp', 'sẽ', 'có\\s+thể',
  'الآن', 'الان', 'حاليا', '[أا]يضا', 'كذلك', 'بالفعل', 'فعلا', 'اليوم', 'بالكامل', 'تماما', 'مباشر[ةه]', 'رسميا', 'لكم', 'لك', 'لعملائنا', 'للعملاء',
];
const FILLER_RE = new RegExp(`^(?:${FILLER_WORDS.join('|')})$`, 'iu');
const GOV_ENABLER = /^(?:help|helps|let|lets|enable|enables|allow|allows|aidons|permettons|ayudamos|permitimos|ajudamos|membantu|memungkinkan|aiutiamo|permettiamo)$/iu;
const AR_ENABLER_PRONOUN = /^[وف]?(?:نساعد|نمكن)/u;

/**
 * هل في الجملة الفرعية فاعلٌ منّا؟ linkStarts: بدايات أفعال الربط والإرسال فيها، nameSpans: مواضع أسماء المنظومات.
 * الضمير (GOV_PRONOUN) فاعلٌ إن بلغ فعلَ ربط عبر كلمات الحشو (FILLER_WORDS) أو اسم المنظومة نفسه («We offer SAT integration»)،
 * أو عبر فعل تمكين ثم ثلاث كلمات حرّة («we help distributors connect to SEFAZ» · «نساعد الموزعين على الربط مع ETA»).
 */
function govAttributed(cText, linkStarts, nameSpans) {
  if (OUR_BRAND.test(cText) || GOV_ATTRIB.test(cText)) return true;
  const inName = (p) => nameSpans.some((n) => p >= n.s && p < n.e);
  for (const pr of cText.matchAll(GOV_PRONOUN)) {
    let enabled = AR_ENABLER_PRONOUN.test(pr[0]);
    let free = enabled ? 3 : 0;
    let pos = pr.index + pr[0].length;
    for (let i = 0; i < 8; i++) {
      const w = /^(\s*)(\S+)/u.exec(cText.slice(pos));
      if (!w) break;
      const ws = pos + w[1].length;
      if (linkStarts.has(ws)) return true;
      pos = ws + w[2].length;
      const word = w[2].replace(/[,.;:!?»"')]+$/u, '');
      if (FILLER_RE.test(word) || inName(ws)) continue;
      if (!enabled && GOV_ENABLER.test(word)) { enabled = true; free = 3; continue; }
      if (free-- > 0) continue;
      break;
    }
  }
  return false;
}

/** صيغة بند بلا فاعل في أول الجملة الفرعية: «Integrates with SAT» · «Compatible con CFDI» · «متوافق مع ETA» · «支持全电发票» */
const GOV_LEAD = new RegExp(`^(?:(?:integrat(?:es|ed)|supports?|supported|connect(?:s|ed)|sync(?:s|ed|hroni[sz]ed)?|compatible|compliant|certified|works\\s+with|ready\\s+for|linked|int[ée]gr[ée]e?s?|conforme|connect[ée]e?s?|reli[ée]e?s?|prend\\s+en\\s+charge|integrad[oa]s?|conectad[oa]s?|vinculad[oa]s?|homologad[oa]s?|certificad[oa]s?|cumple|soporta|admite|se\\s+integra|se\\s+conecta|integra-se|compat[ií]vel|suporta|integriert|kompatibel|angebunden|unterstützt|integrat[oa]|compatibile|collegat[oa]|terintegrasi|mendukung|terhubung|интегрирован\\p{L}*|поддерживает|совместим\\p{L}*|[وف]?(?:متوافق|مدعوم|مربوط|مرتبط|متكامل|متصل)[ةه]?)(?![\\p{L}\\p{N}])|支持|兼容|对接|集成|接入|打通)`, 'iu');

/**
 * النفي **مربوط بفعل الربط نفسه** لا بأي كلمة نفي في الجملة الفرعية: كانت «FieldSales integrates with SAT without any manual
 * work» و«…même sans connexion» (ميزة العمل دون اتصال) و«not only integrates» تُعفى لأن فيها كلمة نفي في أي موضع.
 *  - GOV_NEG_STRONG: يُعفي فعل ربط يليه بـ≤ ٢٥ حرفاً أو يتضمّنه («does not integrate» · «no está integrado» · «n'émet ni» · «لا نربط» ·
 *    «不支持»)، وبعده إن كان الفعل اسمياً («SAT integration is not available» · «ربط ETA غير متاح»). ولا يعبر حرف عطف بينهما:
 *    «FieldSales is not a PAC but integrates with SAT» ادّعاء.
 *  - GOV_NEG_WEAK (حرف «بلا/دون»): «sin conexión» و«sans connexion» تعني غالباً «بلا إنترنت»، فلا يُعفي إلا فعلَ ربط يليه بـ≤ ١٢ حرفاً
 *    («sans connexion à la DGI» · «without any integration»).
 *  - GOV_NEG_POST: نفي يتأخر عن الفعل بطبيعة لغته («entegre değil» · «unterstützt XRechnung nicht» · «対応していません» · «연동되지 않습니다»).
 *  - «not only / no solo / pas seulement…» ليست نفياً.
 */
const GOV_NEG_STRONG = new RegExp([
  `${W}(?:not|never|cannot|can['’]t|don['’]t|doesn['’]t|isn['’]t|aren['’]t|won['’]t|wasn['’]t|hasn['’]t|haven['’]t)${WE}|${W}no\\s+(?:[\\p{L}-]+\\s+){0,2}?(?:integrations?|connections?|links?|support)${WE}`,
  // «FieldSales n'émet ni FNE ni RNE» · «n'est aujourd'hui raccordé ni à la plateforme FNE» (صفحة ساحل العاج المراجَعة)
  `${W}n(?:e\\s+|['’])[^.;:\\n]{0,40}?${W}(?:pas|ni|jamais|plus|aucun\\p{L}*|rien)${WE}|${W}aucun\\p{L}*${WE}|${W}pas\\s+encore${WE}`,
  `${W}\\p{L}+m(?:ıyor|iyor|uyor|üyor)(?:uz|ız|iz|üz)?${WE}|desteklenmi`,
  '尚未|不支持|未对接|暂不|没有|无法|不提供|不对接|未接入|未対応|미지원',
  `غير\\s*(?:مبني|متاح|مدعوم|مربوط|مرتبط|منفذ|متكامل|متوافق|متصل)|(?<![\\p{L}])[وف]?لا\\s*(?:ندعم|نربط|يدعم|تدعم|يوجد|يتوفر|نتكامل|يتكامل|يرتبط|نرتبط|نوفر|يوفر|يتصل|نتصل|نرسل|يرسل|نصدر)|(?<![\\p{L}])[وف]?لم\\s*(?:نبن|ندعم|نربط|يتم|تنفذ|نتكامل|نفعل)|(?<![\\p{L}])[وف]?(?:ليس|ليست|لسنا)(?![\\p{L}])|(?:بلا|دون|بدون)\\s*(?:ربط|تكامل)`,
  // «FieldSales no timbra CFDI» (صفحة المكسيك المراجَعة)
  `${W}no\\s+(?:se\\s+|lo\\s+|la\\s+|los\\s+|las\\s+|le\\s+|les\\s+)?(?:\\p{L}+\\s+)?(?:integra|conecta|vincula|soporta|admite|ofrece|est[aá]|es|son|tiene|emite|timbra|sella|firma|valida|certifica|transmite|reporta|sube|carga|sustituye|reemplaza|cumple|env[ií]a|genera|incluye|hay|existe|act[uú]a|funciona|figura|forma)${WE}|${W}(?:todav[ií]a|a[uú]n)\\s+no${WE}|${W}ningun\\p{L}*`,
  `${W}(?:n[ãa]o|nenhum\\p{L}*|tidak|belum|bukan|nicht|kein\\p{L}*|non|nie|не|нет|không|chưa|haina)${WE}`,
].join('|'), 'giu');
const GOV_NEG_WEAK = new RegExp(`${W}(?:without|sans|sin|sem|tanpa|ohne|senza|bez|без|bila)${WE}|(?<![\\p{L}])[وف]?(?:بلا|دون|بدون)(?![\\p{L}])`, 'giu');
const GOV_NEG_POST = new RegExp(`${W}(?:değil\\p{L}*|yok|nicht)${WE}|ません|ない|않|없|नहीं|نیست`, 'giu');
const NOT_ONLY = /^\s*(?:only|just|merely|solo|sólo|solamente|seulement|só|somente|nur|hanya|soltanto|فقط)(?![\p{L}])/iu;
/** حرف عطف بين النفي والفعل يفصلهما: «is not a PAC but integrates» · «no es un PAC pero se integra» */
// يُفحص على المقطع بينهما وحده، فالمسافة قبله شرط: «entegr|e değil» — «e» ذيل كلمة لا حرف عطف
const GOV_NEG_CUT = /\s(?:but|and|yet|however|mais|et|pero|sino|y|mas|e|aber|und|sondern|tetapi|namun|dan|ama|ve|fakat|بل|لكن|ولكن|لكنه)(?=\s|$)/iu;

function govNegations(cText) {
  const spans = (re) => [...cText.matchAll(re)].map((n) => ({ s: n.index, e: n.index + n[0].length }));
  return {
    strong: spans(GOV_NEG_STRONG).filter((n) => !NOT_ONLY.test(cText.slice(n.e))),
    weak: spans(GOV_NEG_WEAK),
    post: spans(GOV_NEG_POST),
  };
}

/**
 * هل فعل الربط l منفيّ؟ (انظر GOV_NEG_STRONG أعلاه). re: نهاية اسم المنظومة — النفي اللاحق يُقاس من بعد الفعل والاسم معاً:
 * «ربط FieldSales مع منظومة ETA غير متاح» · «La integración de FieldSales con el SAT no está disponible».
 */
function govLinkNegated(cText, l, negs, re) {
  // فعل يبدأ بواو العطف أو فائه («لا نصدر فواتير ونربط مع ETA») لا يرثه نفيُ ما قبله إلا إن تضمّنه
  const conj = /^[وف]\p{Script=Arabic}/u.test(l.t);
  const after = Math.max(l.e, re);
  const tied = (from, to) => !GOV_NEG_CUT.test(cText.slice(from, to));
  for (const n of negs.strong) {
    if (n.s <= l.s && n.e > l.s) return true; // النفي يتضمّن الفعل («no timbra» · «لا نربط» · «不支持»)
    if (n.e <= l.s && l.s - n.e <= 25 && !conj && tied(n.e, l.s)) return true;
    if (l.nominal && n.s >= after && n.s - after <= 25 && tied(l.e, n.s)) return true;
  }
  for (const n of negs.weak) if (n.e <= l.s && l.s - n.e <= 12) return true;
  for (const n of negs.post) if (n.s >= after && n.s - after <= 25 && tied(l.e, n.s)) return true;
  return false;
}

/** فكّ الصلة عنّا صراحةً: «La FNE s'émet par les canaux de la DGI, indépendamment de FieldSales» — يُعفي إن تلاه اسمنا أو ضميرنا */
const GOV_DECOUPLE = new RegExp(`${W}(?:indépendamment|independently|independiente(?:mente)?|independente(?:mente)?|unabhängig|separately)\\s+(?:de|of|from|von|du|des|d['’])|(?:بمعزل|بشكل\\s*مستقل)\\s*عن|مستقل[ةه]?\\s*عن`, 'giu');
const OUR_REF = new RegExp(`${OUR_BRAND_SRC}|(?<![\\p{L}])(?:منصتنا|نظامنا|تطبيقنا|منا|عنا)(?![\\p{L}])|${W}(?:us|our|nous|notre|nos|nosotros|nuestr\\p{L}*|nós|noss\\p{L}*)${WE}`, 'iu');

/**
 * «عند الطلب» بلا وعد (قرار المالك) — في الجملة الفرعية نفسها وعلى بعد ≤ ٨٠ حرفاً من الاسم، لا في أي موضع من الجملة:
 * كانت «FieldSales integrates with SAT, and custom reports are available on request» تُعفى بعبارة تخصّ التقارير.
 * و«حسب متطلبات» تُقبل بصيغتها الصادقة وحدها («ويبقى ربط منظومة ETA الرسمية حسب متطلبات كل منشأة» — مقال مصر الاحتياطي في POSTS
 * وفي CMS)، لا «متوافقة مع منظومة … حسب متطلبات مصلحة الضرائب» التي هي ادّعاء توافق.
 */
const GOV_ON_REQUEST = new RegExp([
  'عند\\s*الطلب|(?:ب)?حسب\\s*الطلب',
  '(?:ب)?حسب\\s*(?:متطلبات|احتياجات|حاج[ةه])\\s*(?:كل\\s*)?(?:ال)?(?:منشأ[ةه]|منشآت|عميل|عملاء|شرك[ةه]|شركات)(?:ك|كم|نا)?(?![\\p{L}])',
  'selon\\s+les\\s+besoins\\s+(?:de\\s+(?:chaque|votre|vos|l[\'’]entreprise)|du\\s+client|des\\s+clients)',
  `${W}(?:on|upon|by)\\s+request${WE}|${W}(?:available|offered|provided)\\s+on\\s+demand${WE}|sur\\s+demande|[àa]\\s+la\\s+demande(?!\\s+(?:de|du|des|d['’]))|talep\\s+(?:üzerine|halinde|edil\\p{L}*)`,
  '按需|根据需求|可申请|要望に応じ|ご要望|요청\\s*시',
  `${W}bajo\\s+(?:pedido|solicitud|demanda)|${W}a\\s+(?:pedido|solicitud)${WE}|por\\s+encargo|${W}sob\\s+(?:demanda|consulta|pedido|solicita[çc][ãa]o)|mediante\\s+(?:pedido|solicita\\p{L}*)`,
  'atas\\s+permintaan|berdasarkan\\s+permintaan|auf\\s+Anfrage|su\\s+richiesta|na\\s+(?:żądanie|życzenie)|la\\s+cerere|по\\s+запросу|theo\\s+yêu\\s+cầu|kwa\\s+ombi',
].join('|'), 'giu');

const GOV_EINVOICING_G = new RegExp(GOV_EINVOICING_RE.source, 'gu');

/** فواصل الجملة: النقطة قبل مسافة (لا «CFDI 4.0») وعلامات الاستفهام والتعجب والسطر و« | » و« · » */
const SENT_BREAK = /[.!?](?=\s|$)|[؟。！？\n]|\s[·•|]\s/gu;
/** ما يسبق الفاصلة فيدلّ علينا — الموصولة بعده تصفنا نحن: «FieldSales, which integrates with SAT, stamps…» · «FieldSales, qui est intégré à la DGI…» */
const OUR_TAIL = '(?:FieldSales|Field\\s?Sales|fieldsa\\.net|فيلد\\s*سيلز|(?:our|notre|nuestr[oa]|noss[oa])\\s+(?:[\\p{L}-]+\\s+){0,2}?(?:platform|plateforme|plataforma|app|application|aplicaci[oó]n|aplicativo|software|logiciel|system|syst[èe]me|sistema|solution|soluci[oó]n|solução|product|produit|producto|produto))';
/** فواصل الجملة الفرعية: الفاصلة المنقوطة والنقطتان، و«، و» و«, and/but/while…» وما يقابلها، والشرطة الطويلة */
const CLAUSE_BREAK = new RegExp([
  '[;؛:：，；、]|\\s[—–]\\s',
  '،\\s*(?=و)',
  `,\\s*(?=(?:and|but|while|whereas|et|mais|tandis|y|pero|mientras|e|mas|enquanto|ve|ama|fakat|ancak|und|aber|während|ma|mentre|oraz|ale|а|но|dan|tetapi|sedangkan)${WE})`,
  // الجملة الموصولة المكانية تصف المكان لا المنتج: «FieldSales منصة متكاملة لموزعي مصر، حيث منظومة ETA إلزامية»
  `,\\s*(?=(?:where|donde|où|onde|dove|wo|gdzie)${WE})`,
  // والموصولة بعد غير اسمنا تُقطع («the MBS platform, which connects taxpayers…»)، وبعد اسمنا تبقى معه
  `(?<!${OUR_TAIL}),\\s*(?=(?:which|who|whose|que|qui|che|cuy[oa]s?|yang|который|которая|которое|которые)${WE})`,
  `${W}(?:while|whereas|tandis\\s+que|mientras\\s+que|enquanto|whilst)${WE}|(?<![\\p{L}])(?:بينما|لكن|في\\s+حين|حيث)(?![\\p{L}])`,
].join('|'), 'giu');

/** حدود المقطع [s, e) حول [start, end) بفاصل breakRe، بحدّ cap حرفاً في كل جانب */
function spanAround(hay, lo, hi, start, end, breakRe, cap) {
  const from = Math.max(lo, start - cap);
  let s = from;
  for (const b of hay.slice(from, start).matchAll(breakRe)) s = from + b.index + b[0].length;
  const to = Math.min(hi, end + cap);
  const nb = new RegExp(breakRe.source, breakRe.flags.replace('g', '')).exec(hay.slice(end, to));
  const e = nb ? end + nb.index + nb[0].length : to;
  return { s, e };
}

/**
 * حكم gov-einvoice-abroad على مطابقة واحدة لاسم منظومة (hay مطبَّع).
 * يُدان إن اجتمع في **الجملة الفرعية** نفسها: فعل ربط غير منفيّ على بعد ≤ ٥٠ حرفاً من الاسم (أو فعل إرسال/إصدار قبله بـ≤ ٤٠)،
 * وفاعلٌ منّا (أو صيغة بند بلا فاعل)، في جملة ليست سؤالاً، بلا «عند الطلب» قرب الاسم ولا فكّ صلة صريح عنّا.
 */
export function govClaimAt(hay, m) {
  const start = m.index;
  const end = start + m[0].length;
  const sent = spanAround(hay, 0, hay.length, start, end, SENT_BREAK, 240);
  const sText = hay.slice(sent.s, sent.e).trim();
  if (/[?؟？]$/.test(sText) || sText.startsWith('¿')) return false;
  const cl = spanAround(hay, sent.s, sent.e, start, end, CLAUSE_BREAK, 240);
  const cText = hay.slice(cl.s, cl.e);
  const rs = start - cl.s;
  const re = end - cl.s;
  const gapTo = (s, e) => (e <= rs ? rs - e : s >= re ? s - re : 0);
  for (const o of cText.matchAll(GOV_ON_REQUEST)) if (gapTo(o.index, o.index + o[0].length) <= 80) return false;
  for (const d of cText.matchAll(GOV_DECOUPLE)) {
    const at = d.index + d[0].length;
    if (OUR_REF.test(cText.slice(at, at + 40))) return false;
  }
  const links = [];
  for (const l of cText.matchAll(GOV_LINK)) links.push({ s: l.index, e: l.index + l[0].length, t: l[0], fwd: false, nominal: GOV_LINK_NOMINAL.test(l[0]) });
  for (const l of cText.matchAll(GOV_LINK_FWD)) links.push({ s: l.index, e: l.index + l[0].length, t: l[0], fwd: true, nominal: false });
  const negs = govNegations(cText);
  // نفيٌ بين فعلٍ سابق والاسم يُخرج الاسم من مفعوله: «documents issued in FieldSales are not validated by GRA» (صفحة غانا) ·
  // «integrates with your ERP but not with SAT»
  const negBetween = (l) => l.e <= rs && negs.strong.some((n) => n.s >= l.e && n.e <= rs);
  const live = links.some((l) => (l.fwd ? l.e <= rs && rs - l.e <= 40 : gapTo(l.s, l.e) <= 50) && !negBetween(l) && !govLinkNegated(cText, l, negs, re));
  if (!live) return false;
  const names = [...cText.matchAll(GOV_EINVOICING_G)].map((n) => ({ s: n.index, e: n.index + n[0].length }));
  if (govAttributed(cText, new Set(links.map((l) => l.s)), names)) return true;
  const lead = cText.replace(/^[\s\-*•·✓✔–—>"'«“(]+/u, '');
  return GOV_LEAD.test(lead) && rs - (cText.length - lead.length) <= 60;
}

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
    id: 'gov-einvoice-abroad',
    // اسم منظومة فوترة حكومية خارج السعودية (GOV_EINVOICING) + فعل ربط قريب + فاعل منّا في الجملة الفرعية نفسها
    // ⇒ حاجبة. الحكم في govClaimAt: الذكر الواقعي والنفي والسؤال و«عند الطلب» تمرّ.
    // نطاق «الكتل»: verify-claims يفصل الفقرات والعناوين والبنود أسطراً، فلا يصير «FieldSales» في عنوان H1
    // فاعلاً لجملة واقعية في الفقرة بعده («FieldSales في المكسيك» + «يشترط SAT أن تتوافق الفاتورة مع CFDI»).
    re: GOV_EINVOICING_RE,
    check: govClaimAt,
    scope: 'blocks',
    why: 'ادّعاء ربط أو تكامل أو توافق مع منظومة فوترة حكومية خارج السعودية — الربط حيّ في السعودية وحدها، وغيرها «عند الطلب» بلا وعد',
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
    if (rule.check && !rule.check(hay, m)) continue;
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
 * نصوص كتلة JSON-LD سطراً لكل قيمة نصية (JSON.parse ثم المشي على القيم) — لنطاق «الكتل» في verify-claims وverify-i18n معاً.
 * التقسيم عند كل فاصلة وعلامة تنصيص كان يقطع جواب FAQPage عند فواصله فينفصل FieldSales عن ادّعائه
 * («FieldSales, the van sales app, is integrated with SAT»). تعذّر التحليل ⇒ التقسيم القديم وحده.
 */
export function jsonLdLines(src) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  try { walk(JSON.parse(src)); } catch { return String(src).replace(/["{}[\],]/g, '\n'); }
  return out.join('\n');
}

/** معرّفات القواعد المُدانة في نصّ واحد (كل القواعد على النص نفسه) — للاختبار */
export function checkText(text) {
  return RULES.filter((r) => findViolation(r, text)).map((r) => r.id);
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
