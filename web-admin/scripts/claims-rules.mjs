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

/** مصطلح المرحلة الثانية بلغات الموقع الخمس */
export const PHASE2 = '(?:المرحلة\\s*(?:الثانية|2|٢)|Phase\\s*(?:2|II|two)\\b|phase\\s*deux|2\\.\\s*Aşama|第二阶段)';
const PHASE1_ONLY = '(?:المرحلة\\s*الأولى|Phase[\\s-]*(?:1|one|un)\\b)';

/**
 * ⚠️ الفارق الحاكم: **ادّعاء دعم** ما لم يُبنَ ممنوع، و**الذكر التعليمي** مشروع بل مطلوب.
 * مقال يشرح لائحة المرحلة الثانية أو نظام ETA المصري محتوى نافع. لذا تُطابَق أفعال الدعم
 * على مقربة من المصطلح، لا المصطلح وحده — وإلا صرخ الحارس على محتوانا الصحيح فعُطّل،
 * وهو أسوأ من غيابه.
 */
export const SUPPORT_VERB = '(?:ندعم|يدعم|تدعم|مدعوم|مدعومة|متوافق|متوافقة|نوفر|يوفر|جاهز(?:ون|ة)?\\s*لـ?|نلتزم|مفعل|مفعلة|فعلنا|مربوط|مرتبط|we\\s+support|supports?|supported|compliant\\s+with|ready\\s+for|enabled|is\\s+live|prend\\s+en\\s+charge|prenons\\s+en\\s+charge|pris\\s+en\\s+charge|activ[ée]e?|destekl|etkin|支持|已启用|已上线)';
export const near = (term) => new RegExp(`(${SUPPORT_VERB}[^.،؛\\n]{0,60}${term})|(${term}[^.،؛\\n]{0,60}${SUPPORT_VERB})`, 'i');

// موعد أو رقم عملاء — «منذ سبتمبر 2026» · «قبل الموجة 25» · «لـ16 شركة».
// أُخرجت % والعملة والمليمترات عمداً: «ضريبة 15%» و«58مم» و«299 ر.س» ليست مواعيد.
const MONTHS_AR_FR = 'يناير|فبراير|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|janvier|février|avril|juillet|août|septembre|octobre|novembre|décembre';
const MONTHS_EN = 'January|February|March|April|May|June|July|August|September|October|November|December';
export const DATE_OR_NUMBER = new RegExp(`(?:منذ|بحلول|ابتداء\\s*من|اعتبارا\\s*من|خلال\\s*[\\d٠-٩]+|الموجة\\s*[\\d٠-٩]+|موجة\\s*[\\d٠-٩]+|\\b(?:19|20)\\d{2}\\b|[١٢][٠٩][٠-٩]{2}|[\\d٠-٩][\\d٠-٩,.٬]*\\s*\\+?\\s*(?:شركة|شركات|عميل|عملاء|منشأة|منشآت|companies|customers|clients|entreprises|şirket|家企业)|(?:${MONTHS_AR_FR})|\\b(?:since|as\\s+of|starting|from|by|in|until|before)\\s+(?:${MONTHS_EN}|\\d)|depuis|à\\s+partir\\s+d|itibaren|起)`, 'i');

export const RULES = [
  {
    id: 'zatca-approved',
    // تبقى محجوبة بعد تفعيل الربط وتُشدَّد: الهيئة لا تعتمد مزوّدي البرمجيات ولا تُشاركهم رسمياً.
    // الثغرات المسدودة: «معتمد من الهيئة» (كان يطابق الزكاة/ZATCA وحدهما) · «معتمدة · ZATCA» ·
    // صيغ الإنجليزية والفرنسية والتركية والصينية · «شريك رسمي للهيئة».
    re: new RegExp([
      '(?:معتمد|مصادق|مرخص|موثق)(?:ة|ون|ين)?\\s*(?:رسميا?\\s*)?(?:من\\s*قبل|من|لدى)\\s*(?:هيئة\\s*)?(?:الزكاة|ZATCA|زاتكا|الهيئة|منصة\\s*فاتورة)',
      '(?:اعتماد|مصادقة|ترخيص|شهادة)\\s*(?:رسمية?\\s*)?(?:من|لدى)\\s*(?:هيئة\\s*)?(?:الزكاة|ZATCA|زاتكا|الهيئة)',
      'شريك\\s*(?:رسمي|معتمد)\\s*(?:لـ?|لل|مع|من)?\\s*(?:هيئة\\s*)?(?:الزكاة|ZATCA|زاتكا|الهيئة|هيئة)',
      '(?:معتمدة?|مصادقة?|مرخصة?)\\s*[·•|:–—-]\\s*(?:ZATCA|الزكاة|الهيئة)',
      'ZATCA[\\s-]*(?:certified|approved|accredited|authori[sz]ed|endorsed)',
      '(?:certified|approved|accredited|authori[sz]ed|endorsed)\\s+by\\s+(?:the\\s+)?(?:ZATCA|Zakat)',
      'official\\s+ZATCA\\s+partner|official\\s+partner\\s+of\\s+(?:the\\s+)?(?:ZATCA|Zakat)',
      '(?:certifi|homologu|agré|approuv)[ée]e?s?\\s+par\\s+la\\s+ZATCA',
      'ZATCA\\s*(?:onaylı|sertifikalı|tarafından\\s+onaylı)',
      'ZATCA\\s*(?:认证|批准|官方合作)',
    ].join('|'), 'i'),
    // النفي يُقبل ملاصقاً قبل المطابقة فقط («لسنا معتمدين من الهيئة»). النافذة ±220 القديمة
    // كانت تمرّر «الهيئة لا تعتمد المزودين، لكن نظامنا معتمد من الهيئة».
    unless: /(?:لا|ليس|ليست|لسنا|غير|لا\s*ندعي\s*(?:أننا|اننا)?|not|never|no)\s*$/i,
    unlessBefore: 25,
    unlessAfter: 0,
    why: 'ZATCA لا تعتمد ولا تصادق مزوّدي البرمجيات — ادّعاء الاعتماد أو الشراكة الرسمية ممنوع ولو بعد تفعيل الربط',
  },
  {
    id: 'zatca-phase2-dated',
    // ربط المرحلة الثانية مع منصة فاتورة قدرة معلنة بقرار المالك بعد التفعيل الفعلي، فصيغة الدعم
    // تمرّ. الممنوع: اقترانها بموعد أو رقم غير مثبت.
    re: near(PHASE2),
    requireNear: { re: DATE_OR_NUMBER, before: 80, after: 120 },
    why: 'ادّعاء ربط المرحلة الثانية مقروناً بموعد أو رقم — لا موعد ولا رقم مثبت يُنشر',
  },
  {
    id: 'zatca-phase2-stale-denial',
    // نفي قديم يناقض الحقيقة الجديدة. **تحذير غير حاجب** عمداً: prerender يجلب مقالات CMS إلى
    // dist وفيها نفي قديم يحرّره المالك من لوحة CMS بعد التفعيل؛ لو حُجب الآن لفشل كل بناء.
    // بعد تحرير CMS: احذف severity لتصير حاجبة.
    re: new RegExp(`(${PHASE2}[^.؛\\n]{0,90}(?:غير\\s*(?:مبني|مبنية|متاح|متاحة)|لم\\s*(?:نبنها|تبن)|not\\s*(?:yet\\s*)?(?:built|available)|n.est\\s*pas\\s*(?:encore\\s*)?(?:disponible|d[ée]velopp[ée]e)|henüz\\s*hazır\\s*değil|尚未上线))|((?:لا\\s*ندعم|do\\s*not\\s*support)[^.؛\\n]{0,40}${PHASE2})|(${PHASE1_ONLY}[^.؛\\n]{0,45}(?:فقط|وحدها|(?<![\\w-])only\\b|uniquement))`, 'i'),
    severity: 'warn',
    why: 'نفي قديم للمرحلة الثانية (أو «الأولى فقط») بعد تفعيل الربط — يناقض الحقيقة الجديدة',
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
  const hay = norm(haystack);
  const flags = rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`;
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
    return { index: i, match: m[0] };
  }
  return null;
}

/** معرّفات القواعد المُدانة في نصّ واحد (كل القواعد على النص نفسه) — للاختبار */
export function checkText(text) {
  return RULES.filter((r) => findViolation(r, text)).map((r) => r.id);
}
