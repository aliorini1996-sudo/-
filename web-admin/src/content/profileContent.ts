// محتوى صفحة «بروفايل» — الملف التعريفي التفاعلي على fieldsa.net/profile
//
// الحقيقة تعيش في CMS الموقع (siteContent.profile) والقيم هنا افتراضياتٌ تُستخدم
// حين لا يكون المالك عدّل الحقل بعد — فأي حقل يعدّله من لوحته يفوز فوراً.
// القوائم تُخزَّن نصاً بأسطر (سطر = بند)، ومحطات الرحلة وأرقامها بصيغة «قيمة | وصف».
//
// المحتوى مأخوذ من عرض البروفايل المعتمد (نسخة المستثمرين) قسماً قسماً.

export type ProfileLang = 'ar' | 'en';

export interface ProfileSection { [k: string]: string }
export interface ProfileContent { ar: ProfileSection; en: ProfileSection }

// وصف الحقول — يقود محرر المالك والصفحة معاً (المفتاح ثابت والنص حر)
export const PROFILE_FIELDS: { key: string; label: string; multiline?: boolean; hint?: string }[] = [
  { key: 'cover_title', label: 'عنوان الغلاف' },
  { key: 'cover_promise', label: 'سطر الوعد تحت العنوان', multiline: true },
  { key: 'problem_title', label: 'المشكلة العنوان' },
  { key: 'problem_body', label: 'المشكلة النص', multiline: true, hint: 'كل سطر يظهر سطرا مستقلا' },
  { key: 'solution_title', label: 'الحل العنوان' },
  { key: 'solution_col1_title', label: 'الحل عنوان العمود الاول' },
  { key: 'solution_col1', label: 'الحل بنود العمود الاول', multiline: true, hint: 'كل سطر بند' },
  { key: 'solution_col2_title', label: 'الحل عنوان العمود الثاني' },
  { key: 'solution_col2', label: 'الحل بنود العمود الثاني', multiline: true, hint: 'كل سطر بند' },
  { key: 'opportunity_title', label: 'الفرصة العنوان' },
  { key: 'opportunity_intro', label: 'الفرصة التمهيد', multiline: true },
  { key: 'opportunity_items', label: 'الفرصة البنود', multiline: true, hint: 'كل سطر بند مرقم' },
  { key: 'why_title', label: 'لماذا نحن العنوان' },
  { key: 'why_body', label: 'لماذا نحن النص', multiline: true },
  { key: 'journey_title', label: 'الرحلة العنوان' },
  { key: 'journey_stations', label: 'الرحلة المحطات', multiline: true, hint: 'كل سطر التاريخ | الحدث' },
  { key: 'model_title', label: 'نموذج العمل العنوان' },
  { key: 'model_items', label: 'نموذج العمل البنود', multiline: true, hint: 'كل سطر بند مرقم' },
  { key: 'numbers_title', label: 'الانجاز العنوان' },
  { key: 'numbers_items', label: 'الانجاز الارقام', multiline: true, hint: 'كل سطر الرقم | الوصف' },
  { key: 'roadmap_title', label: 'خارطة الطريق العنوان' },
  { key: 'roadmap_items', label: 'خارطة الطريق البنود', multiline: true, hint: 'كل سطر بند مرقم' },
  { key: 'ask_title', label: 'الطلب الاستثماري العنوان' },
  { key: 'ask_items', label: 'الطلب الاستثماري البنود', multiline: true, hint: 'كل سطر بند مرقم' },
  { key: 'closing_title', label: 'الختام العنوان' },
  { key: 'closing_line', label: 'سطر الختام', multiline: true },
  { key: 'contact_website', label: 'الموقع' },
  { key: 'contact_email', label: 'البريد' },
  { key: 'contact_location', label: 'المقر' },
];

export const PROFILE_DEFAULTS: ProfileContent = {
  ar: {
    cover_title: 'البنية الرقمية لتوزيع سلاسل الإمداد',
    cover_promise: 'بالذكاء الصناعي تتم إدارة سلاسل الإمداد والمبيعات الميدانية\nوالتحصيل والمخزون والسيارات لحظة بلحظة',

    problem_title: 'قطاع بمليارات الريالات يدار بالورقة والواتساب',
    problem_body: 'فاتورة الميدان تكتب باليد وتدخل النظام بعد ايام\nوالتحصيل النقدي عهدة بلا سند يثبت من قبضه ومتى وردها\nومخزون السيارة بلا جرد والمرتجع يذوب في الرصيد بلا اثر\nوالمدير يطارد مناديبه بالواتساب بدل ان يقرا شاشته',

    solution_title: 'نظام تشغيل كامل لشركة التوزيع',
    solution_col1_title: 'لوحة الادارة',
    solution_col1: 'ترى المبيعات والتحصيل والمخزون لحظة بلحظة\nتتبع مباشر لكل مندوب على الخريطة مع خط سيره\nكشوف حساب ومديونيات مرتبة باعمار الدين\nتقارير جاهزة تقرؤها قبل اجتماع الصباح',
    solution_col2_title: 'تطبيق المندوب',
    solution_col2: 'يعمل من الجوال مباشرة كانه كاشير\nفاتورة ضريبية متوافقة مع متطلبات الفوترة الالكترونية\nسند قبض يوثق كل ريال يستلمه من العميل\nيزامن كل شيء وحده حين يعود الاتصال\nاصدار كشوف حسابات\nاستقبال مدفوعات الكترونية لقيمة الفاتورة',

    opportunity_title: 'رقمنة هذا القطاع ليست خيارا',
    opportunity_intro: 'ثلاث قوى تدفع السوق نحونا ولا تحتاج منا اقناع احد',
    opportunity_items: 'كل موجة ربط جديدة من هيئة الزكاة تدفع الاف الشركات لحل متوافق\nمستهدفات المدفوعات الرقمية في رؤية ٢٠٣٠ تحاصر التحصيل النقدي\nسوق نقدر حجمه بقيمة مليارية سنويا قبل احتساب دخل المدفوعات',

    why_title: 'منصة بناها مشغل توزيع حقيقي',
    why_body: 'المؤسس يملك ويدير شركة توزيع غذائي في الرياض ونجد منذ ٢٠٢١\nنعرف المرتجع والعهدة وضغط نهاية الشهر لاننا نعيشها كل يوم\nكل شاشة جربناها على مناديبنا لفترة طويلة قبل ان تصل الى اي عميل\nلذلك كل الاجراءات والمميزات صدرت من داخل القطاع وتجاربه',

    journey_title: 'منصة بنيت طبقة فوق طبقة',
    journey_stations: 'مطلع ٢٠٢٦ | اطلاق المنصة حية على السحابة\nربيع ٢٠٢٦ | التتبع المباشر والتقارير\nصيف ٢٠٢٦ | اقبال كبير من شركات بعدة قطاعات\nاليوم | منصة مكتملة في الانتاج تخدم شركات في ١٣ قطاعا',

    model_title: 'اشتراكات اليوم ومدفوعات الغد',
    model_items: 'اشتراك شهري يبدا من ٢٩٩ ريالا وهو باب دخول سهل لشريحة تحسب كل ريال\nمتوسط دخلنا من العميل الواحد ٦٠٠ ريال في الشهر وهامشنا الاجمالي ٧٠٪\nواليوم اصبح جوال المندوب نقطة بيع وناخذ عمولة من كل عملية تمر عبرنا',

    numbers_title: 'ارقام من الانتاج لا من العروض',
    numbers_items: '١٦ | شركة جربوا العمل على المنصة\n٨٥ | مندوب نشط في الميدان يوميا\n+١٠٠٠٠ | فاتورة صادرة عبر المنصة شهريا\n١٣ | قطاعات توزيع تعمل على المنصة اليوم',

    roadmap_title: 'ما بنيناه الان وكيف يكبر الدخل',
    roadmap_items: 'جوال المندوب يصير نقطة بيع شبكية تفتح لنا دخل عمولات المدفوعات\nذكاء يقترح حمولة اليوم ويتنبا بالطلب لكل صنف فيلتصق العميل بنا اكثر\nربط منظومات الوقود وارقام العمل المؤسسية يفتح لنا الشركات الاكبر\nتطوير الذكاء الصناعي ليضاعف عمل المندوب الواحد ليعمل عمل ٣ مناديب',

    ask_title: 'ماذا نطلب وماذا نحقق به',
    ask_items: 'نفتح جولتنا الاستثمارية الاولى\nنوجه ١٠٪ للمنتج والفريق و٨٠٪ للنمو و١٠٪ للتشغيل\nوخلال ١٨ شهرا نصل الى ١٠ الاف شركة ودخل متكرر ٣ مليون ريال',

    closing_title: 'نعيد تعريف الميدان',
    closing_line: 'منصة حية في الانتاج وعملاء يشغلونها في الميدان كل يوم',

    contact_website: 'fieldsa.net',
    contact_email: 'info@fieldsa.net',
    contact_location: 'الرياض، المملكة العربية السعودية',
  },
  en: {
    cover_title: 'The digital backbone for supply chain distribution',
    cover_promise: 'AI runs supply chains and field sales,\nwith collections, inventory and vehicles tracked in real time',

    problem_title: 'A multi-billion riyal sector run on paper and WhatsApp',
    problem_body: 'Field invoices are handwritten and reach the system days later\nCash collection sits with the rep, with no receipt proving who took it or when it came back\nVan stock goes uncounted, and returns dissolve into the balance without a trace\nAnd the manager chases reps on WhatsApp instead of reading a screen',

    solution_title: 'A complete operating system for a distribution company',
    solution_col1_title: 'Admin dashboard',
    solution_col1: 'See sales, collections and stock in real time\nLive tracking of every rep on the map with their route\nStatements and receivables sorted by debt age\nReports ready before the morning meeting',
    solution_col2_title: 'Rep app',
    solution_col2: 'Runs straight from the phone like a cash register\nE-invoicing compliant tax invoices\nA receipt documenting every riyal taken from the customer\nSyncs everything on its own when the connection returns\nIssues customer statements\nAccepts electronic payment of the invoice',

    opportunity_title: 'Digitizing this sector is not optional',
    opportunity_intro: 'Three forces push the market toward us, and none of them needs convincing from us',
    opportunity_items: 'Every new ZATCA integration wave pushes thousands of companies to a compliant solution\nVision 2030 digital payment targets are closing in on cash collection\nA market we size in the billions of riyals a year, before payment revenue',

    why_title: 'Built by a distributor who actually runs one',
    why_body: 'The founder has owned and run a food distribution company in Riyadh and Najd since 2021\nWe know returns, custody and month-end pressure because we live them every day\nEvery screen was tested on our own reps for a long stretch before it reached a single customer\nSo every workflow and feature came out of the sector itself and its practice',

    journey_title: 'A platform built layer over layer',
    journey_stations: 'Early 2026 | Platform launched live on the cloud\nSpring 2026 | Live tracking and reports\nSummer 2026 | Strong uptake from companies across several sectors\nToday | A complete platform in production serving companies across 13 sectors',

    model_title: "Subscriptions today, payments tomorrow",
    model_items: 'A monthly subscription starting at 299 SAR, an easy entry point for a segment that counts every riyal\nAverage revenue per customer is 600 SAR a month at a 70% gross margin\nAnd today the rep phone is a point of sale, and we take a fee on every transaction that runs through us',

    numbers_title: 'Numbers from production, not from decks',
    numbers_items: '16 | companies have run their work on the platform\n85 | reps active in the field every day\n10,000+ | invoices issued through the platform monthly\n13 | distribution sectors running on the platform today',

    roadmap_title: 'What we have built and how revenue grows',
    roadmap_items: 'The rep phone becomes a card point of sale, opening payment fee revenue\nAI that suggests the day load and forecasts demand per item, so customers stay with us longer\nFuel systems and corporate work numbers open the door to larger companies\nAI that multiplies one rep into the output of three',

    ask_title: 'What we are raising and what it delivers',
    ask_items: 'We are opening our first investment round\nWe allocate 10% to product and team, 80% to growth and 10% to operations\nAnd within 18 months we reach 10,000 companies and 3 million SAR in recurring revenue',

    closing_title: 'Redefining the field',
    closing_line: 'A live platform in production, with customers running it in the field every day',

    contact_website: 'fieldsa.net',
    contact_email: 'info@fieldsa.net',
    contact_location: 'Riyadh, Saudi Arabia',
  },
};

/** أقسام يمكن للمالك إخفاؤها من الصفحة — الغياب يعني الظهور */
export const PROFILE_SECTIONS: { key: string; label: string }[] = [
  { key: 'problem', label: 'المشكلة' },
  { key: 'solution', label: 'الحل' },
  { key: 'opportunity', label: 'الفرصة' },
  { key: 'why', label: 'لماذا نحن' },
  { key: 'journey', label: 'الرحلة' },
  { key: 'model', label: 'نموذج العمل' },
  { key: 'numbers', label: 'الانجاز' },
  { key: 'roadmap', label: 'خارطة الطريق' },
  { key: 'ask', label: 'الطلب الاستثماري' },
  { key: 'contact', label: 'تواصل معنا' },
];

/** مفتاح إظهار القسم داخل المحتوى */
export const showKey = (section: string) => `show_${section}`;

/**
 * هل يظهر القسم؟ الإظهار شأنٌ واحد للغتين فيُقرأ من العربية أياً كانت اللغة
 * المعروضة — ولو خُزّن لكل لغة لرأى قارئ الإنجليزية قسماً أخفاه المالك.
 */
export const sectionOn = (c: ProfileContent, section: string) => c.ar[showKey(section)] !== '0';

/** يدمج ما حفظه المالك فوق الافتراضي — الحقل المحفوظ يفوز، والغائب يبقى افتراضياً */
export function mergeProfile(saved: Partial<ProfileContent> | null | undefined): ProfileContent {
  return {
    ar: { ...PROFILE_DEFAULTS.ar, ...(saved?.ar || {}) },
    en: { ...PROFILE_DEFAULTS.en, ...(saved?.en || {}) },
  };
}

/** يقسّم حقلاً متعدّد الأسطر إلى بنود — الفراغات تُهمَل */
export const splitLines = (s: string): string[] =>
  (s || '').split('\n').map(l => l.trim()).filter(Boolean);

/** يقسّم بنود «قيمة | وصف» — ما لا فاصل فيه يصير وصفاً بلا قيمة */
export const splitPairs = (s: string): { a: string; b: string }[] =>
  splitLines(s).map(l => {
    const i = l.indexOf('|');
    return i === -1 ? { a: '', b: l.trim() } : { a: l.slice(0, i).trim(), b: l.slice(i + 1).trim() };
  });
