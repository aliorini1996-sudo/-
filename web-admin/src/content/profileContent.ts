// محتوى صفحة «بروفايل» — الملف التعريفي التفاعلي على fieldsa.net/profile
//
// الحقيقة تعيش في CMS الموقع (siteContent.profile) والقيم هنا افتراضياتٌ تُستخدم
// حين لا يكون المالك عدّل الحقل بعد — فأي حقل يعدّله من لوحته يفوز فوراً.
// القوائم تُخزَّن نصاً بأسطر (سطر = بند)، ومحطات الرحلة وأرقامها بصيغة «قيمة | وصف».

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
  { key: 'solution_col1', label: 'الحل العمود الاول', multiline: true },
  { key: 'solution_col2', label: 'الحل العمود الثاني', multiline: true },
  { key: 'clients_title', label: 'العملاء العنوان' },
  { key: 'clients_intro', label: 'العملاء التمهيد', multiline: true },
  { key: 'clients_sectors', label: 'العملاء القطاعات', multiline: true, hint: 'كل سطر قطاع' },
  { key: 'about_title', label: 'من نحن العنوان' },
  { key: 'about_body', label: 'من نحن النص', multiline: true },
  { key: 'journey_title', label: 'الرحلة العنوان' },
  { key: 'journey_stations', label: 'الرحلة المحطات', multiline: true, hint: 'كل سطر التاريخ | الحدث' },
  { key: 'achievements_title', label: 'الانجازات العنوان' },
  { key: 'achievements_items', label: 'الانجازات البنود', multiline: true, hint: 'كل سطر بند' },
  { key: 'numbers_title', label: 'الارقام العنوان' },
  { key: 'numbers_items', label: 'الارقام البطاقات', multiline: true, hint: 'كل سطر الرقم | الوصف' },
  { key: 'goals_title', label: 'خارطة الطريق العنوان' },
  { key: 'goals_items', label: 'خارطة الطريق البنود', multiline: true, hint: 'كل سطر بند' },
  { key: 'invest_title', label: 'البدء معنا العنوان' },
  { key: 'invest_tracks', label: 'البدء معنا الخطوات', multiline: true, hint: 'كل سطر خطوة' },
  { key: 'contact_title', label: 'تواصل معنا العنوان' },
  { key: 'contact_website', label: 'الموقع' },
  { key: 'contact_email', label: 'البريد' },
  { key: 'contact_location', label: 'المقر' },
  { key: 'closing_line', label: 'سطر الختام', multiline: true },
];

export const PROFILE_DEFAULTS: ProfileContent = {
  ar: {
    cover_title: 'منصة واحدة تدير توزيعك من المستودع حتى يد العميل',
    cover_promise: 'ترى مبيعات مناديبك وتحصيلهم ومخزون سياراتهم لحظة بلحظة\nويعمل تطبيقهم في الميدان حتى لو انقطع الانترنت',
    problem_title: 'يوم كامل يمر قبل ان تعرف ماذا جرى في الميدان',
    problem_body: 'فواتير تكتب بخط اليد وتصل المكتب بعد ايام\nوتحصيل نقدي بلا سند يثبت من قبضه ومتى\nومخزون سيارة لا يعرف رصيده الا صاحبها\nومدير يسال مناديبه في الواتساب بدل ان يقرا شاشته',
    solution_title: 'كل ما يحتاجه فريقك في مكان واحد',
    solution_col1: 'لوحة ادارة ترى المبيعات والتحصيل والمخزون لحظة بلحظة\nوتتبع مباشر لكل مندوب على الخريطة مع خط سيره\nوكشوف حساب ومديونيات مرتبة باعمار الدين\nوتقارير جاهزة تقرؤها قبل اجتماع الصباح',
    solution_col2: 'تطبيق مندوب يعمل من الجيب بلا انترنت\nيصدر فاتورة ضريبية برمز الاستجابة السريعة وفق المرحلة الاولى من الفوترة الالكترونية\nوسند قبض يوثق كل ريال يستلمه من العميل\nويزامن كل شيء وحده حين يعود الاتصال',
    clients_title: 'شركات تعمل في الميدان كل يوم',
    clients_intro: 'عملاؤنا شركات عاملة في السوق السعودي تدير مناديبها وسياراتها عبر المنصة يوميا\nنذكر صفتهم لا اسماءهم احتراما لخصوصية اعمالهم',
    clients_sectors: 'شركات توزيع المواد الغذائية والاستهلاكية بمناديبها وسياراتها\nمصانع ومستودعات توصل منتجاتها مباشرة الى نقاط البيع\nقطاعات متخصصة من المياه والثلج الى تموينات الجملة والمطاعم بفروعها',
    about_title: 'منصة سعودية ولدت من الميدان',
    about_body: 'فيلد سيلز منصة سحابية سعودية لادارة المبيعات الميدانية والتوزيع\nبنينا كل ميزة حول مشكلة رايناها تحدث امام اعيننا في الميدان\nونصمم كل شاشة بالعربية اولا ولرجل الميدان اولا\nوبيانات كل شركة معزولة تماما عن بيانات غيرها',
    journey_title: 'منصة بنيت طبقة فوق طبقة',
    journey_stations: 'مطلع ٢٠٢٦ | اطلاق المنصة حية على السحابة\nربيع ٢٠٢٦ | العمل بلا انترنت والتتبع المباشر والتقارير\nصيف ٢٠٢٦ | نسخة المطاعم وتطبيقات الجوال وسطح المكتب\nاليوم | منصة مكتملة تعمل في الانتاج وتخدم شركات حقيقية',
    achievements_title: 'ما تحصل عليه من اليوم الاول',
    achievements_items: 'منصة كاملة تعمل في الانتاج ببيانات معزولة لكل شركة على حدة\nتطبيق ميداني يعمل بلا انترنت ويزامن ما اصدره وحده حين يعود الاتصال\nفوترة الكترونية برمز الاستجابة السريعة في كل فاتورة تصدرها المنصة',
    numbers_title: 'ارقام تهمك قبل ان تقرر',
    numbers_items: '٢٩٩ | ريالا شهريا تبدا بها باقتنا الاولى\n١٠ | ايام تجربة كاملة بلا بطاقة دفع\n٠ | ريال اضافي على كل مندوب داخل حدود باقتك\n٧ | قطاعات توزيع تعمل على المنصة اليوم',
    goals_title: 'ما نبنيه الان في المنصة',
    goals_items: 'تحويل جوال المندوب الى نقطة بيع شبكية بدل التحصيل النقدي\nتوسيع الذكاء في اقتراح حمولة اليوم والتنبؤ بالطلب لكل صنف\nربط المنصة بمنظومات الوقود وارقام العمل المؤسسية لكل مندوب\nتغطية اوسع لدول الخليج ومصر وشمال افريقيا',
    invest_title: 'تبدا في نفس اليوم وبلا التزام',
    invest_tracks: 'تفتح حسابك بنفسك وتجرب المنصة كاملة عشرة ايام بلا بطاقة دفع\nترفع عملاءك واصنافك من ملف اكسل قديم والنظام يفهم اعمدته وحده\nونرافق فريقك خطوة بخطوة حتى يصدر اول فاتورة من الميدان',
    contact_title: 'تحدث الينا قبل ان تقرر',
    contact_website: 'fieldsa.net',
    contact_email: 'help@fieldsa.net',
    contact_location: 'الرياض المملكة العربية السعودية',
    closing_line: 'منصة واحدة تدير توزيعك من المستودع حتى يد العميل\nوتبدا بتجربة كاملة عشرة ايام',
  },
  en: {
    cover_title: 'One platform that runs your distribution from the warehouse to the customer',
    cover_promise: 'See what your reps sell collect and carry in their vans as it happens\nAnd their app keeps working in the field even when the connection drops',
    problem_title: 'A full day passes before you know what happened in the field',
    problem_body: 'Invoices written by hand that reach the office days later\nCash collected with nothing to prove who took it and when\nVan stock nobody can count except the rep driving it\nAnd a manager asking his team on WhatsApp instead of reading his screen',
    solution_title: 'Everything your team needs in one place',
    solution_col1: 'An admin panel that shows sales collections and stock as they happen\nLive map tracking for every rep with the route he actually drove\nStatements and receivables sorted by ageing\nAnd reports you read before the morning meeting',
    solution_col2: 'A rep app that works from the pocket with no internet\nIssuing a tax invoice with a QR code under phase one of Saudi e invoicing\nAnd a receipt that documents every riyal he collects\nAnd syncing everything on its own when the connection returns',
    clients_title: 'Companies that work the field every day',
    clients_intro: 'Our clients are operating companies in the Saudi market running their reps and vans on the platform daily\nWe describe who they are without naming them out of respect for their privacy',
    clients_sectors: 'FMCG and food distribution companies with reps and van fleets\nFactories and warehouses delivering direct to points of sale\nSpecialized sectors from water and ice to wholesale supplies and multi branch restaurants',
    about_title: 'A Saudi platform born in the field',
    about_body: 'Field Sales is a Saudi cloud platform for field sales and distribution\nEvery feature was built around a problem we watched happen in the field\nEvery screen is designed Arabic first and field first\nAnd the data of each company stays fully isolated from the rest',
    journey_title: 'A platform built layer over layer',
    journey_stations: 'Early 2026 | The platform went live on the cloud\nSpring 2026 | Offline mode live tracking and reporting\nSummer 2026 | Restaurants edition mobile and desktop apps\nToday | A complete platform running in production serving real companies',
    achievements_title: 'What you get from day one',
    achievements_items: 'A full platform running in production with data isolated per company\nA field app that works offline and syncs what it issued on its own when the connection returns\nQR e invoicing in every invoice the platform issues',
    numbers_title: 'Numbers worth knowing before you decide',
    numbers_items: '299 | SAR a month is where our first plan starts\n10 | days of full trial with no payment card\n0 | extra charge for every rep within your plan limit\n7 | distribution sectors running on the platform today',
    goals_title: 'What we are building into the platform now',
    goals_items: 'Turning the rep phone into a network point of sale instead of cash collection\nDeeper intelligence in suggesting the load of the day and forecasting demand per item\nConnecting the platform to fuel systems and a work number for every rep\nWider coverage across the Gulf Egypt and North Africa',
    invest_title: 'You can start today with no commitment',
    invest_tracks: 'You open your own account and try the whole platform for ten days with no payment card\nYou upload your customers and products from an old Excel file and the system reads its columns on its own\nAnd we walk beside your team until the first invoice goes out from the field',
    contact_title: 'Talk to us before you decide',
    contact_website: 'fieldsa net',
    contact_email: 'help@fieldsa.net',
    contact_location: 'Riyadh Saudi Arabia',
    closing_line: 'One platform that runs your distribution from the warehouse to the customer\nStarting with a full ten day trial',
  },
};

/**
 * الأقسام التي يملك المالك إظهارها أو إخفاءها.
 * الغلاف والختام خارج القائمة عمداً — وثيقة بلا غلاف ولا خاتمة ليست وثيقة.
 */
export const PROFILE_SECTIONS: { key: string; label: string; en: string }[] = [
  { key: 'problem', label: 'المشكلة', en: 'The problem' },
  { key: 'solution', label: 'الحل', en: 'The solution' },
  { key: 'clients', label: 'العملاء', en: 'Our clients' },
  { key: 'about', label: 'من نحن', en: 'Who we are' },
  { key: 'journey', label: 'الرحلة', en: 'The journey' },
  { key: 'achievements', label: 'الجاهز اليوم', en: 'Ready today' },
  { key: 'numbers', label: 'الارقام', en: 'The numbers' },
  { key: 'goals', label: 'خارطة الطريق', en: 'Roadmap' },
  { key: 'invest', label: 'البدء معنا', en: 'Getting started' },
  { key: 'contact', label: 'تواصل معنا', en: 'Contact' },
];

export const showKey = (k: string) => `show_${k}`;

/**
 * الظهور شأن واحد للغتين: يُقرأ من العربية دائماً.
 * لو خُزّن لكل لغة لافترقت النسختان فرأى قارئ الإنجليزية قسماً أخفاه المالك.
 * والغياب يعني الظهور — فالأقسام القديمة تبقى ظاهرة بلا تدخّل.
 */
export const sectionOn = (c: ProfileContent, k: string) => (c.ar[showKey(k)] ?? '1') !== '0';

/** دمج تعديلات الـCMS فوق الافتراضيات على مستوى الحقل */
export function mergeProfile(cms: Partial<ProfileContent> | null | undefined): ProfileContent {
  return {
    ar: { ...PROFILE_DEFAULTS.ar, ...(cms?.ar || {}) },
    en: { ...PROFILE_DEFAULTS.en, ...(cms?.en || {}) },
  };
}

/** قوائم نصية: سطر = بند */
export const splitLines = (s: string | undefined): string[] =>
  (s || '').split('\n').map(l => l.trim()).filter(Boolean);

/** بنود مزدوجة بصيغة «قيمة | وصف» */
export const splitPairs = (s: string | undefined): { a: string; b: string }[] =>
  splitLines(s).map(l => {
    const i = l.indexOf('|');
    return i === -1 ? { a: l, b: '' } : { a: l.slice(0, i).trim(), b: l.slice(i + 1).trim() };
  });
