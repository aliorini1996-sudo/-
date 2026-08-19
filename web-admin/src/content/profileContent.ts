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
  { key: 'problem_title', label: 'المشكلة — العنوان' },
  { key: 'problem_body', label: 'المشكلة — النص', multiline: true, hint: 'كل سطر يظهر سطرا مستقلا' },
  { key: 'solution_title', label: 'الحل — العنوان' },
  { key: 'solution_col1', label: 'الحل — العمود الاول', multiline: true },
  { key: 'solution_col2', label: 'الحل — العمود الثاني', multiline: true },
  { key: 'clients_title', label: 'العملاء — العنوان' },
  { key: 'clients_intro', label: 'العملاء — التمهيد', multiline: true },
  { key: 'clients_sectors', label: 'العملاء — القطاعات', multiline: true, hint: 'كل سطر قطاع' },
  { key: 'about_title', label: 'من نحن — العنوان' },
  { key: 'about_body', label: 'من نحن — النص', multiline: true },
  { key: 'journey_title', label: 'الرحلة — العنوان' },
  { key: 'journey_stations', label: 'الرحلة — المحطات', multiline: true, hint: 'كل سطر: التاريخ | الحدث' },
  { key: 'achievements_title', label: 'الانجازات — العنوان' },
  { key: 'achievements_items', label: 'الانجازات — البنود', multiline: true, hint: 'كل سطر بند' },
  { key: 'numbers_title', label: 'الارقام — العنوان' },
  { key: 'numbers_items', label: 'الارقام — البطاقات', multiline: true, hint: 'كل سطر: الرقم | الوصف' },
  { key: 'goals_title', label: 'اهداف المستقبل — العنوان' },
  { key: 'goals_items', label: 'اهداف المستقبل — الاهداف', multiline: true, hint: 'كل سطر هدف' },
  { key: 'invest_title', label: 'الاستثمار — العنوان' },
  { key: 'invest_tracks', label: 'الاستثمار — اوجه الاستخدام', multiline: true, hint: 'كل سطر وجه' },
  { key: 'contact_title', label: 'تواصل معنا — العنوان' },
  { key: 'contact_website', label: 'الموقع' },
  { key: 'contact_email', label: 'البريد' },
  { key: 'contact_location', label: 'المقر' },
  { key: 'closing_line', label: 'سطر الختام', multiline: true },
];

export const PROFILE_DEFAULTS: ProfileContent = {
  ar: {
    cover_title: 'نبني العمود الفقري الرقمي للتوزيع في العالم العربي',
    cover_promise: 'منصة سعودية تدير عمل شركات التوزيع كاملا\nمن لوحة الادارة حتى جوال المندوب امام العميل',
    problem_title: 'سوق بمليارات الريالات يدار بالورق',
    problem_body: 'شركات التوزيع تحرك بضائع بمليارات الريالات كل عام\nومعظمها يدير مناديبه بالدفاتر ومجموعات الواتساب\nفواتير تضيع وتحصيل بلا توثيق ومدير لا يرى ميدانه',
    solution_title: 'منصة واحدة تدير التوزيع من اوله الى اخره',
    solution_col1: 'لوحة ادارة ترى كل شيء لحظة بلحظة\nمبيعات وتحصيل ومخزون ومديونيات\nوتتبع مباشر لكل مندوب على الخريطة\nوتقارير تقود قرار الشركة كل يوم',
    solution_col2: 'تطبيق مندوب يعمل من الجيب بلا انترنت\nيصدر الفواتير والسندات برمز الاستجابة\nوفق المرحلة الاولى من الفوترة الالكترونية\nويزامن كل شيء وحده حين يعود الاتصال',
    clients_title: 'شركات تعمل في الميدان كل يوم',
    clients_intro: 'عملاؤنا شركات عاملة في السوق السعودي تدير مناديبها وسياراتها عبر المنصة يوميا\nنذكر صفتهم لا اسماءهم احتراما لخصوصية اعمالهم',
    clients_sectors: 'شركات توزيع المواد الغذائية والاستهلاكية بمناديبها وسياراتها\nمصانع ومستودعات توصل منتجاتها مباشرة الى نقاط البيع\nقطاعات متخصصة من المياه والثلج الى تموينات الجملة والمطاعم بفروعها',
    about_title: 'منصة سعودية ولدت من الميدان',
    about_body: 'فيلد سيلز منصة سحابية لادارة المبيعات الميدانية والتوزيع\nبنينا كل ميزة حول مشكلة رايناها تحدث امامنا في الميدان\nونصمم كل شاشة بالعربية اولا ولرجل الميدان اولا',
    journey_title: 'رحلة بنيت طبقة فوق طبقة',
    journey_stations: 'مطلع ٢٠٢٦ | اطلاق المنصة حية على السحابة\nربيع ٢٠٢٦ | العمل بلا انترنت والتتبع المباشر والتقارير\nصيف ٢٠٢٦ | نسخة المطاعم وتطبيقات الجوال وسطح المكتب\nاليوم | منتج مكتمل يعمل ويحصل ايرادات',
    achievements_title: 'منتج مكتمل يعمل ويحصل ايرادات',
    achievements_items: 'منصة كاملة حية في الانتاج بعزل تام لبيانات كل شركة\nتطبيق ميداني يعمل بلا انترنت ويزامن كل شيء وحده\nفوترة الكترونية برمز الاستجابة في كل فاتورة تصدر',
    numbers_title: 'ارقام تختصر القصة',
    numbers_items: '١٢٣ | منافسا عالميا شملتهم دراسة سوقنا\n٢٩٩ | ريالا بداية اشتراكنا الشهري المعلن\n٢٤ | ساعة تكفي لتفعيل اي شركة جديدة\n٧ | قطاعات توزيع تخدمها المنصة اليوم',
    goals_title: 'اربعة مستهدفات ترسم المرحلة القادمة',
    goals_items: 'تطوير وحوكمة سوق سلاسل امداد التوزيع في العالم العربي\nادخال الذكاء الاصطناعي الى سلاسل الامداد لدى الشركات\nتحويل جوال المندوب الى نقطة بيع شبكية بدل التحصيل الكاش\nمنافسة كبرى شركات الانظمة في العالم',
    invest_title: 'جولة استثمارية لتسريع اربعة مستهدفات',
    invest_tracks: 'بناء فريق الذكاء الاصطناعي وهندسة البيانات\nالبنية المالية والتقنية للتحصيل الشبكي وتراخيصه\nالتوسع في الخليج ومصر وشمال افريقيا مع فرق نجاح ترافق كل عميل',
    contact_title: 'نرحب بمن يشاركنا الطريق',
    contact_website: 'fieldsa.net',
    contact_email: 'help@fieldsa.net',
    contact_location: 'الرياض المملكة العربية السعودية',
    closing_line: 'نبني العمود الفقري الرقمي للتوزيع في العالم العربي\nونرحب بمن يشاركنا الطريق',
  },
  en: {
    cover_title: 'Building the digital backbone of distribution across the Arab world',
    cover_promise: 'A Saudi platform that runs the entire distribution operation\nfrom the back office to the rep standing in front of the customer',
    problem_title: 'A multi billion riyal market run on paper',
    problem_body: 'Distribution companies move billions in goods every year\nMost still manage their reps with paper ledgers and WhatsApp groups\nLost invoices undocumented cash and managers blind to their field',
    solution_title: 'One platform that runs distribution end to end',
    solution_col1: 'An admin panel that sees everything live\nSales collections inventory and receivables\nLive map tracking for every rep\nAnd reports that steer the company every day',
    solution_col2: 'A rep app that works from the pocket with no internet\nIssuing QR invoices and receipts\nUnder phase one of Saudi e invoicing\nAnd syncing everything on its own when connection returns',
    clients_title: 'Companies that work the field every day',
    clients_intro: 'Our clients are operating companies in the Saudi market running their reps and vans on the platform daily\nWe describe who they are without naming them out of respect for their privacy',
    clients_sectors: 'FMCG and food distribution companies with reps and van fleets\nFactories and warehouses delivering direct to points of sale\nSpecialized sectors from water and ice to wholesale supplies and multi branch restaurants',
    about_title: 'A Saudi platform born in the field',
    about_body: 'Field Sales is a cloud platform for field sales and distribution\nEvery feature was built around a problem we watched happen in the field\nEvery screen is designed Arabic first and field first',
    journey_title: 'A journey built layer over layer',
    journey_stations: 'Early 2026 | The platform went live on the cloud\nSpring 2026 | Offline mode live tracking and reporting\nSummer 2026 | Restaurants edition mobile and desktop apps\nToday | A complete product that works and earns',
    achievements_title: 'A complete product that works and earns',
    achievements_items: 'A full platform live in production with complete data isolation per company\nA field app that works offline and syncs on its own\nQR e invoicing in every invoice the platform issues',
    numbers_title: 'Numbers that tell the story',
    numbers_items: '123 | competitors worldwide covered by our market study\n299 | SAR starting monthly subscription published openly\n24 | hours are enough to activate any new company\n7 | distribution sectors served by the platform today',
    goals_title: 'Four targets that define the next stage',
    goals_items: 'Develop and govern the distribution supply chain market across the Arab world\nBring artificial intelligence into company supply chains\nTurn the rep phone into a network point of sale instead of cash collection\nCompete with the giants of enterprise software worldwide',
    invest_title: 'An investment round to accelerate four targets',
    invest_tracks: 'Building the AI and data engineering team\nThe financial and technical rails for network collection and its licensing\nExpansion across the Gulf Egypt and North Africa with success teams beside every client',
    contact_title: 'We welcome those who walk the road with us',
    contact_website: 'fieldsa.net',
    contact_email: 'help@fieldsa.net',
    contact_location: 'Riyadh Saudi Arabia',
    closing_line: 'Building the digital backbone of distribution across the Arab world\nand welcoming those who walk the road with us',
  },
};

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
