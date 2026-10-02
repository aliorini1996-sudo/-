/**
 * قواعد حارس الادّعاءات — مفصولة عن verify-claims.mjs كي يختبرها
 * src/content/claimsGuard.test.ts بالقواعد نفسها التي تحرس dist (لا نسخة موازية تنحرف).
 *
 * كل قاعدة: نمط + سبب + استثناء اختياري يمنع الإنذار الكاذب.
 *  - unless + unlessBefore/unlessAfter: نفي صريح في نافذة حول المطابقة يُعفيها (الافتراضي ±220).
 *  - requireNear: لا تُعدّ المطابقة إصابة إلا إن وُجد نمط آخر قربها (مثل موعد أو رقم).
 *  - severity: 'warn' تحذير يُطبع ولا يُفشل البناء؛ غيابها = حاجبة.
 *  - scope: 'head' (العنوان والوصف وH1) · 'raw' (HTML الخام) · الافتراضي النصّ المرئي.
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
      // والسؤال ليس تموضعاً: «اسأل مورّدك: هل تُصدر وفق المرحلة الأولى؟» قائمة فحص للقارئ
      `(?<!${PHASE2}[^.؛\\n]{0,160})(?:${PHASE1_VERB}[^.؛\\n]{0,80}?|${PHASE1_NOUN}\\s*(?:ZATCA\\s*)?[(«]?\\s*)${PHASE1}(?![^.؛\\n]{0,160}${PHASE2})(?![^.؛\\n]{0,40}[؟?])`,
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
    re: /\b(MEST\s*SE|mestsoft|Daftra|Qoyod|qoyod\.com|daftra\.com|Delta\s*Sales\s*App|deltasalesapp|PepUpSales|pepupsales)\b/i,
    scope: 'raw', // يشمل الروابط والوسوم لا النصّ المرئي وحده
    why: 'ذكر اسم منافس — قرار المالك: المقارنة بالنماذج لا بالأسماء',
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
