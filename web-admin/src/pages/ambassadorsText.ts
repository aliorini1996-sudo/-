/**
 * نصوص الصفحة العلنية «سفراء فيلد سيلز» (/ambassadors · /en/ambassadors · /fr/ambassadors) — مصدرٌ واحد
 * (V2_SPEC §9، طلب المالك ١٨ نوفمبر ٢٠٢٦): يقرؤه المكوّن AmbassadorsPage.tsx ويقرؤه scripts/prerender.mjs
 * (loadTs) فيكتب منه العنوان والوصف والكلمات وH1 والجسم الدلالي وFAQPage — فلا يختلف ما يقرؤه الزاحف عمّا
 * يرسمه React بعد الإقلاع (فخّ المصدر المزدوج). لذلك **بلا أي استيراد**: الملف يُحوَّل بـesbuild ويُستورد وحده.
 *
 * قيود حرّاس البناء على هذه النصوص (ambassadorsPage.test.ts يفحصها مباشرةً):
 *  - لا مبلغ بعملة (verify-pricing): الحدّ الأدنى للتسوية «بسيط» بلا رقم.
 *  - لا «اشترك الآن» ولا ادّعاء غير موثّق ولا اسم منافس (verify-claims)، ولا «الأسواق العربية» في رأس en/fr.
 *  - الأزرار إلى /ambassadors/join و/ambassadors/login وحدهما — مساران في App.tsx يحوّلان إلى البوابة،
 *    فلا يظهر مسار البوابة نفسه في الصفحة ولا في prerender (affiliate/hiding.test.ts).
 */

export type AmbLang = 'ar' | 'en' | 'fr';

/** لغات الصفحة — ثلاثية كالخريطة (TRILINGUAL_PATHS في i18n/locale.ts وlangsFor في gen-sitemap) */
export const AMBASSADORS_LANGS: readonly AmbLang[] = ['ar', 'en', 'fr'];

/** المسار العربي للصفحة (بلا بادئة لغة) */
export const AMBASSADORS_PATH = '/ambassadors';
/** زرّ «انضم الآن» — يحوّله App.tsx إلى شاشة التسجيل في البوابة */
export const AMBASSADORS_JOIN = '/ambassadors/join';
/** «لديك حساب؟» — يحوّله App.tsx إلى دخول البوابة */
export const AMBASSADORS_LOGIN = '/ambassadors/login';

export interface AmbItem { t: string; d: string }
export interface AmbFaq { q: string; a: string }
export interface AmbText {
  seoTitle: string;
  seoDesc: string;
  keywords: string;
  eyebrow: string;
  h1: string;
  /** جزء H1 الذي يُلوَّن مرجانياً (يجب أن يكون داخل h1 حرفياً) */
  h1Accent: string;
  lead: string;
  cta: string;
  ctaNote: string;
  login: string;
  loginShort: string;
  stats: { v: string; l: string }[];
  card: { title: string; share: string; copy: string; earnTitle: string; earnBody: string; steps: string[] };
  stepsTitle: string;
  stepsSub: string;
  steps: AmbItem[];
  whyTitle: string;
  why: AmbItem[];
  toolsTitle: string;
  tools: AmbItem[];
  whoTitle: string;
  whoSub: string;
  who: AmbItem[];
  faqTitle: string;
  faq: AmbFaq[];
  finalTitle: string;
  finalBody: string;
  finalCta: string;
  termsNote: string;
  home: string;
  contact: string;
  otherLangs: string;
  rights: string;
}

export const AMBASSADORS_TEXT: Record<AmbLang, AmbText> = {
  ar: {
    seoTitle: 'سفراء فيلد سيلز | اكسب ٣٠٪ من أول دفعة لكل شركة تحيلها',
    seoDesc: 'انضمّ إلى برنامج سفراء فيلد سيلز فوراً بلا انتظار موافقة، وشارك رابطك مع شركات التوزيع، واكسب ٣٠٪ من أول دفعة مؤكَّدة لكل شركة تحيلها — تُسوّى كل ١٠ أيام.',
    keywords: 'سفراء فيلد سيلز، برنامج سفراء، برنامج إحالة، عمولة إحالة، التسويق بالعمولة، برنامج شركاء، دخل إضافي',
    eyebrow: 'برنامج سفراء فيلد سيلز',
    h1: 'اكسب ٣٠٪ من أول دفعة لكل شركة تحيلها',
    h1Accent: '٣٠٪',
    lead: 'سجّل في دقيقة وخذ رابطك فوراً بلا انتظار موافقة. شارك الرابط مع شركات التوزيع والمبيعات الميدانية التي تعرفها، وحين تدفع الشركة أول اشتراك لها تحصل على ٣٠٪ من دفعتها كاملةً.',
    cta: 'انضم الآن',
    ctaNote: 'الانضمام مجاني ويفتح حسابك فوراً',
    login: 'لديك حساب سفير؟ سجّل الدخول',
    loginShort: 'دخول السفراء',
    stats: [
      { v: '٣٠٪', l: 'من أول دفعة مؤكَّدة لكل شركة' },
      { v: '١٠ أيام', l: 'حجزٌ ثم تسوية كل ١٠ أيام' },
      { v: 'فوري', l: 'انضمام بلا انتظار موافقة' },
    ],
    card: {
      title: 'رابطك الخاص جاهز',
      share: 'مشاركة رابطي',
      copy: 'نسخ',
      earnTitle: '٣٠٪',
      earnBody: 'عمولتك من أول دفعة لكل شركة تشترك عبرك',
      steps: ['أُنشئ حسابك', 'شارك رابطك', 'أول شركة تدفع'],
    },
    stepsTitle: 'ثلاث خطوات فقط',
    stepsSub: 'من التسجيل إلى أول أرباحك',
    steps: [
      { t: 'سجّل وخذ رابطك فوراً', d: 'افتح حسابك بالاسم والبريد والجوال، فيصلك رابطك الخاص ورمزك في اللحظة نفسها بلا مراجعة ولا انتظار.' },
      { t: 'شارك رابطك', d: 'أرسله لشركات التوزيع التي تعرفها، أو رشّح شركة باسمها وسجلّها التجاري، أو افتح حساباً تجريبياً لشركة طلبت ذلك من لوحتك.' },
      { t: 'اربح', d: 'حين تدفع الشركة أول اشتراك لها تُحسب عمولتك ٣٠٪ من الدفعة، وتُحجز ١٠ أيام ثم تُسوّى في دورة تسوية كل ١٠ أيام.' },
    ],
    whyTitle: 'لماذا سفراء فيلد سيلز؟',
    why: [
      { t: 'فوري بلا انتظار', d: 'تسجيلك يفتح حسابك مباشرةً، وتبدأ المشاركة من أول دقيقة.' },
      { t: 'على كامل الدفعة الأولى', d: 'عمولتك ٣٠٪ من أول دفعة مؤكَّدة شاملةً الضريبة، ولو كانت اشتراكاً سنوياً مدفوعاً مقدّماً.' },
      { t: 'تسوية منتظمة', d: 'تُحجز العمولة ١٠ أيام ثم تدخل دورة تسوية كل ١٠ أيام بتحويل بنكي، بحدّ أدنى بسيط يُرحَّل ما دونه إلى الدورة التالية.' },
    ],
    toolsTitle: 'أدوات المشاركة في لوحتك',
    tools: [
      { t: 'رابط إحالة خاص', d: 'رابطٌ ورمزٌ باسمك تُنسب إليك عبرهما كل شركة تسجّل.' },
      { t: 'ترشيح الشركات', d: 'رشّح شركة بسجلّها التجاري قبل أن تسجّل، فتُحجز لك ٩٠ يوماً إن قُبل الترشيح.' },
      { t: 'حساب تجريبي', d: 'افتح لشركة طلبت ذلك حساباً تجريبياً من لوحتك، فتُنسب إليك من لحظة إنشائه.' },
      { t: 'مواد تسويقية', d: 'صور ونصوص جاهزة وروابط تشاركها في حساباتك وقنواتك.' },
      { t: 'لوحة على الجوال', d: 'تابع شركاتك وأرباحك وتسوياتك من جوالك في أي وقت.' },
      { t: 'خمس لغات', d: 'لوحتك بالعربية والإنجليزية والفرنسية والتركية والصينية.' },
    ],
    whoTitle: 'لمن البرنامج؟',
    whoSub: 'لكل من يعرف شركات تبيع وتوزّع عبر مناديب في الميدان',
    who: [
      { t: 'الأفراد', d: 'موظفو المبيعات والمحاسبون والمستشارون وكل من له علاقات مع شركات التوزيع.' },
      { t: 'الشركات', d: 'مكاتب الاستشارات ومزوّدو الخدمات الذين يرشّحون لعملائهم نظاماً يعتمدون عليه.' },
      { t: 'المؤثرون', d: 'صنّاع المحتوى في التجارة والأعمال وريادة الأعمال.' },
      { t: 'الوكالات', d: 'وكالات التسويق والتحوّل الرقمي التي تخدم شركات التوزيع والتجزئة.' },
    ],
    faqTitle: 'أسئلة شائعة',
    faq: [
      { q: 'كم أربح عن كل شركة؟', a: '٣٠٪ من أول دفعة مؤكَّدة تدفعها الشركة التي أحلتها، محسوبةً على المبلغ كاملاً شاملاً ضريبة القيمة المضافة، ولو كانت الدفعة اشتراكاً سنوياً. وهي عمولة واحدة لكل شركة، ولا عمولة على التجديدات.' },
      { q: 'هل أنتظر موافقة لأبدأ؟', a: 'لا. التسجيل يفتح حسابك فوراً ويعطيك رابطك ورمزك مباشرةً، فتبدأ المشاركة من أول دقيقة.' },
      { q: 'متى أستلم أرباحي؟', a: 'تُحجز العمولة ١٠ أيام من تاريخ دفع الشركة، ثم تُعتمد وتدخل دورة التسوية التي تُجرى كل ١٠ أيام بتحويل بنكي إلى حسابك. وما دون الحدّ الأدنى البسيط للتسوية يُرحَّل إلى الدورة التالية.' },
      { q: 'كيف تُنسب الشركة إليّ؟', a: 'حين تسجّل الشركة عبر رابطك أو تكتب رمزك عند التسجيل، أو حين يُقبل ترشيحك لها، أو حين تفتح لها حساباً تجريبياً من لوحتك. ويُحفظ رابطك في متصفّح الزائر ٩٠ يوماً.' },
      { q: 'ما المطلوب لاستلام أرباحي؟', a: 'أن تكمل ملفك من لوحتك: نوع حسابك، والحساب البنكي (آيبان سعودي)، وصورة الهوية أو الإقامة، والسجل التجاري إن كنت شركة. اكتمال الملف شرطٌ لدخول دورة التسوية فقط، ولا يمنعك من البدء والمشاركة.' },
      { q: 'هل أستطيع النشر في حساباتي؟', a: 'نعم، مع الإفصاح بأن المنشور إعلان والالتزام بالأنظمة، وبلا رسائل مزعجة ولا ادّعاءات مضلّلة، ودون حسابات أو إعلانات توحي بأنها رسمية لفيلد سيلز.' },
      { q: 'هل أستطيع إحالة شركتي نفسها؟', a: 'نعم، ما دامت عميلاً جديداً لم يسبق له الاشتراك في فيلد سيلز.' },
      { q: 'هل الانضمام برسوم؟', a: 'لا. الانضمام مجاني بالكامل، ولا يُطلب منك أي دفع.' },
    ],
    finalTitle: 'ابدأ اليوم واكسب من أول شركة',
    finalBody: 'التسجيل يأخذ دقيقة، ورابطك جاهز فور انتهائه.',
    finalCta: 'انضم الآن',
    termsNote: 'المشاركة وفق شروط برنامج السفراء التي تقرؤها وتوافق عليها عند التسجيل.',
    home: 'الرئيسية',
    contact: 'تواصل معنا',
    otherLangs: 'هذه الصفحة بلغات أخرى',
    rights: '© ٢٠٢٦ Field Sales',
  },
  en: {
    seoTitle: 'FieldSales Ambassadors | 30% of the first payment per referral',
    seoDesc: 'Join the FieldSales ambassador program instantly, with no approval wait. Share your link with distribution companies and earn 30% of the first confirmed payment of each company you refer, settled every 10 days.',
    keywords: 'FieldSales ambassadors, ambassador program, referral program, affiliate program, referral commission, partner program',
    eyebrow: 'FieldSales Ambassador Program',
    h1: 'Earn 30% of the first payment of every company you refer',
    h1Accent: '30%',
    lead: 'Sign up in a minute and get your link right away, with no approval wait. Share it with the distribution and field sales companies you know, and when a company makes its first subscription payment you earn 30% of the full amount.',
    cta: 'Join now',
    ctaNote: 'Joining is free and opens your account instantly',
    login: 'Already an ambassador? Log in',
    loginShort: 'Ambassador login',
    stats: [
      { v: '30%', l: 'of each company’s first confirmed payment' },
      { v: '10 days', l: 'hold, then settlement every 10 days' },
      { v: 'Instant', l: 'joining with no approval wait' },
    ],
    card: {
      title: 'Your personal link is ready',
      share: 'Share my link',
      copy: 'Copy',
      earnTitle: '30%',
      earnBody: 'your commission on the first payment of every company that subscribes through you',
      steps: ['Account created', 'Share your link', 'First company pays'],
    },
    stepsTitle: 'Just three steps',
    stepsSub: 'From sign-up to your first earnings',
    steps: [
      { t: 'Sign up and get your link instantly', d: 'Open your account with your name, email and mobile number, and your personal link and code arrive at the same moment, with no review and no waiting.' },
      { t: 'Share your link', d: 'Send it to the distribution companies you know, nominate a company by name and commercial registration, or open a trial account from your dashboard for a company that asked for one.' },
      { t: 'Earn', d: 'When the company makes its first subscription payment, your 30% commission is calculated, held for 10 days and then paid out in a settlement cycle that runs every 10 days.' },
    ],
    whyTitle: 'Why become a FieldSales ambassador?',
    why: [
      { t: 'Instant, no waiting', d: 'Signing up opens your account right away, so you can start sharing from the first minute.' },
      { t: 'On the full first payment', d: 'Your commission is 30% of the first confirmed payment including VAT, even when it is an annual subscription paid in advance.' },
      { t: 'Regular settlements', d: 'Each commission is held for 10 days and then joins a settlement cycle every 10 days by bank transfer, with a low minimum; anything below it rolls over to the next cycle.' },
    ],
    toolsTitle: 'Sharing tools in your dashboard',
    tools: [
      { t: 'Personal referral link', d: 'A link and a code in your name, so every company that signs up through them is attributed to you.' },
      { t: 'Company nominations', d: 'Nominate a company by its commercial registration before it signs up, and it is reserved for you for 90 days once the nomination is accepted.' },
      { t: 'Trial accounts', d: 'Open a trial account from your dashboard for a company that asked for one, and it is attributed to you from the moment it is created.' },
      { t: 'Marketing materials', d: 'Ready-made images, texts and links to share on your accounts and channels.' },
      { t: 'Mobile dashboard', d: 'Follow your companies, earnings and settlements from your phone at any time.' },
      { t: 'Five languages', d: 'Your dashboard runs in Arabic, English, French, Turkish and Chinese.' },
    ],
    whoTitle: 'Who is it for?',
    whoSub: 'Anyone who knows companies that sell and distribute through field reps',
    who: [
      { t: 'Individuals', d: 'Sales professionals, accountants, consultants and anyone with relationships at distribution companies.' },
      { t: 'Companies', d: 'Consulting firms and business service providers who recommend a system their clients can rely on.' },
      { t: 'Influencers', d: 'Content creators in trade, business and entrepreneurship.' },
      { t: 'Agencies', d: 'Marketing and digital transformation agencies serving distribution and retail companies.' },
    ],
    faqTitle: 'Frequently asked questions',
    faq: [
      { q: 'How much do I earn per company?', a: '30% of the first confirmed payment made by the company you referred, calculated on the full amount including VAT, even when that payment is an annual subscription. It is one commission per company, with no commission on renewals.' },
      { q: 'Do I need to wait for approval?', a: 'No. Signing up opens your account instantly and gives you your link and code right away, so you can start sharing from the first minute.' },
      { q: 'When do I get paid?', a: 'Each commission is held for 10 days from the company’s payment, then approved and added to the settlement cycle that runs every 10 days by bank transfer to your account. Anything below the low settlement minimum rolls over to the next cycle.' },
      { q: 'How is a company attributed to me?', a: 'When the company signs up through your link or enters your code at sign-up, when your nomination of it is accepted, or when you open a trial account for it from your dashboard. Your link is remembered in the visitor’s browser for 90 days.' },
      { q: 'What do I need to receive my earnings?', a: 'Complete your profile in your dashboard: your account type, your bank account (a Saudi IBAN), a photo of your national ID or residence permit, and your commercial registration if you are a company. A complete profile is only required to enter the settlement cycle; it does not stop you from starting and sharing.' },
      { q: 'Can I promote FieldSales on my social accounts?', a: 'Yes, as long as you disclose that the post is an advertisement and follow the regulations, with no spam, no misleading claims, and no accounts or ads that look like official FieldSales channels.' },
      { q: 'Can I refer my own company?', a: 'Yes, as long as it is a new customer that has never subscribed to FieldSales before.' },
      { q: 'Is there a fee to join?', a: 'No. Joining is completely free and you are never asked to pay anything.' },
    ],
    finalTitle: 'Start today and earn from your first company',
    finalBody: 'Signing up takes a minute, and your link is ready the moment you finish.',
    finalCta: 'Join now',
    termsNote: 'Participation is subject to the ambassador program terms, which you read and accept when you sign up.',
    home: 'Home',
    contact: 'Contact us',
    otherLangs: 'This page in other languages',
    rights: '© 2026 Field Sales',
  },
  fr: {
    seoTitle: 'Ambassadeurs FieldSales | 30 % du premier paiement par parrainage',
    seoDesc: 'Rejoignez le programme ambassadeurs FieldSales instantanément, sans attendre de validation. Partagez votre lien et gagnez 30 % du premier paiement confirmé de chaque entreprise parrainée, réglé tous les 10 jours.',
    keywords: 'ambassadeurs FieldSales, programme ambassadeurs, programme de parrainage, programme d’affiliation, commission de parrainage, programme partenaires',
    eyebrow: 'Programme ambassadeurs FieldSales',
    h1: 'Gagnez 30 % du premier paiement de chaque entreprise que vous parrainez',
    h1Accent: '30 %',
    lead: 'Inscrivez-vous en une minute et recevez votre lien tout de suite, sans attendre de validation. Partagez-le avec les entreprises de distribution et de vente terrain que vous connaissez : quand une entreprise effectue son premier paiement d’abonnement, vous touchez 30 % du montant total.',
    cta: 'Rejoindre maintenant',
    ctaNote: 'L’inscription est gratuite et ouvre votre compte immédiatement',
    login: 'Déjà ambassadeur ? Connectez-vous',
    loginShort: 'Connexion ambassadeurs',
    stats: [
      { v: '30 %', l: 'du premier paiement confirmé de chaque entreprise' },
      { v: '10 jours', l: 'de blocage, puis un règlement tous les 10 jours' },
      { v: 'Immédiat', l: 'inscription sans attente de validation' },
    ],
    card: {
      title: 'Votre lien personnel est prêt',
      share: 'Partager mon lien',
      copy: 'Copier',
      earnTitle: '30 %',
      earnBody: 'votre commission sur le premier paiement de chaque entreprise abonnée grâce à vous',
      steps: ['Compte créé', 'Partagez votre lien', 'Première entreprise qui paie'],
    },
    stepsTitle: 'Trois étapes seulement',
    stepsSub: 'De l’inscription à vos premiers gains',
    steps: [
      { t: 'Inscrivez-vous et recevez votre lien', d: 'Ouvrez votre compte avec votre nom, votre e-mail et votre mobile : votre lien personnel et votre code arrivent au même instant, sans examen ni attente.' },
      { t: 'Partagez votre lien', d: 'Envoyez-le aux entreprises de distribution que vous connaissez, recommandez une entreprise par son nom et son registre de commerce, ou ouvrez depuis votre tableau de bord un compte d’essai pour une entreprise qui le demande.' },
      { t: 'Gagnez', d: 'Quand l’entreprise effectue son premier paiement d’abonnement, votre commission de 30 % est calculée, bloquée 10 jours puis versée lors d’un cycle de règlement qui a lieu tous les 10 jours.' },
    ],
    whyTitle: 'Pourquoi devenir ambassadeur FieldSales ?',
    why: [
      { t: 'Immédiat, sans attente', d: 'Votre inscription ouvre votre compte directement : vous partagez dès la première minute.' },
      { t: 'Sur tout le premier paiement', d: 'Votre commission est de 30 % du premier paiement confirmé TVA comprise, même s’il s’agit d’un abonnement annuel payé d’avance.' },
      { t: 'Des règlements réguliers', d: 'Chaque commission est bloquée 10 jours puis rejoint un cycle de règlement tous les 10 jours par virement bancaire, avec un minimum modeste ; ce qui est en dessous est reporté au cycle suivant.' },
    ],
    toolsTitle: 'Des outils de partage dans votre tableau de bord',
    tools: [
      { t: 'Lien de parrainage personnel', d: 'Un lien et un code à votre nom : chaque entreprise qui s’inscrit par leur biais vous est attribuée.' },
      { t: 'Recommandations d’entreprises', d: 'Recommandez une entreprise par son registre de commerce avant son inscription : elle vous est réservée 90 jours si la recommandation est acceptée.' },
      { t: 'Comptes d’essai', d: 'Ouvrez depuis votre tableau de bord un compte d’essai pour une entreprise qui le demande : elle vous est attribuée dès sa création.' },
      { t: 'Supports marketing', d: 'Images, textes et liens prêts à partager sur vos comptes et vos canaux.' },
      { t: 'Tableau de bord mobile', d: 'Suivez vos entreprises, vos gains et vos règlements depuis votre téléphone, à tout moment.' },
      { t: 'Cinq langues', d: 'Votre tableau de bord fonctionne en arabe, anglais, français, turc et chinois.' },
    ],
    whoTitle: 'À qui s’adresse le programme ?',
    whoSub: 'À tous ceux qui connaissent des entreprises qui vendent et distribuent avec des commerciaux sur le terrain',
    who: [
      { t: 'Particuliers', d: 'Professionnels de la vente, comptables, consultants et toute personne en relation avec des entreprises de distribution.' },
      { t: 'Entreprises', d: 'Cabinets de conseil et prestataires de services aux entreprises qui recommandent un système fiable à leurs clients.' },
      { t: 'Influenceurs', d: 'Créateurs de contenu sur le commerce, les affaires et l’entrepreneuriat.' },
      { t: 'Agences', d: 'Agences de marketing et de transformation numérique au service des entreprises de distribution et de commerce de détail.' },
    ],
    faqTitle: 'Questions fréquentes',
    faq: [
      { q: 'Combien je gagne par entreprise ?', a: '30 % du premier paiement confirmé de l’entreprise que vous avez parrainée, calculés sur le montant total TVA comprise, même si ce paiement est un abonnement annuel. Il s’agit d’une seule commission par entreprise, sans commission sur les renouvellements.' },
      { q: 'Dois-je attendre une validation ?', a: 'Non. L’inscription ouvre votre compte immédiatement et vous donne votre lien et votre code tout de suite : vous partagez dès la première minute.' },
      { q: 'Quand suis-je payé ?', a: 'Chaque commission est bloquée 10 jours à compter du paiement de l’entreprise, puis validée et ajoutée au cycle de règlement qui a lieu tous les 10 jours par virement bancaire sur votre compte. Ce qui est en dessous du minimum modeste de règlement est reporté au cycle suivant.' },
      { q: 'Comment une entreprise m’est-elle attribuée ?', a: 'Quand l’entreprise s’inscrit par votre lien ou saisit votre code à l’inscription, quand votre recommandation est acceptée, ou quand vous lui ouvrez un compte d’essai depuis votre tableau de bord. Votre lien est conservé 90 jours dans le navigateur du visiteur.' },
      { q: 'Que faut-il pour recevoir mes gains ?', a: 'Complétez votre profil dans votre tableau de bord : votre type de compte, votre compte bancaire (IBAN saoudien), une photo de votre pièce d’identité ou titre de séjour, et votre registre de commerce si vous êtes une entreprise. Un profil complet n’est exigé que pour entrer dans le cycle de règlement ; il ne vous empêche pas de commencer à partager.' },
      { q: 'Puis-je publier sur mes réseaux ?', a: 'Oui, à condition d’indiquer que la publication est une publicité et de respecter la réglementation, sans messages indésirables, sans allégations trompeuses, et sans comptes ni annonces qui se présentent comme officiels de FieldSales.' },
      { q: 'Puis-je parrainer ma propre entreprise ?', a: 'Oui, tant qu’il s’agit d’un nouveau client qui ne s’est jamais abonné à FieldSales.' },
      { q: 'L’inscription est-elle payante ?', a: 'Non. L’inscription est entièrement gratuite et aucun paiement ne vous est jamais demandé.' },
    ],
    finalTitle: 'Commencez aujourd’hui et gagnez dès la première entreprise',
    finalBody: 'L’inscription prend une minute, et votre lien est prêt dès la fin.',
    finalCta: 'Rejoindre maintenant',
    termsNote: 'La participation est soumise aux conditions du programme ambassadeurs, que vous lisez et acceptez lors de l’inscription.',
    home: 'Accueil',
    contact: 'Contact',
    otherLangs: 'Cette page dans d’autres langues',
    rights: '© 2026 Field Sales',
  },
};

/** اسم كل لغة بلغتها — روابط النسخ الأخرى في الصفحة وفي HTML المُصيَّر */
export const AMBASSADORS_LANG_LABEL: Record<AmbLang, string> = { ar: 'العربية', en: 'English', fr: 'Français' };

/** نصوص لغةٍ ما بأمان: لغة الواجهة خارج الثلاث (tr/zh) تسقط إلى الإنجليزية لا إلى العربية */
export function ambassadorsTextFor(lang: string): AmbText {
  return AMBASSADORS_TEXT[(lang === 'ar' || lang === 'fr' || lang === 'en' ? lang : 'en') as AmbLang];
}

/** مسار الصفحة بلغة ما: العربية بلا بادئة */
export function ambassadorsPathFor(lang: AmbLang): string {
  return lang === 'ar' ? AMBASSADORS_PATH : `/${lang}${AMBASSADORS_PATH}`;
}

/**
 * FAQPage من الأسئلة الظاهرة في الصفحة نفسها (verify-schema: كل سؤال يظهر نصّه في الجسم المُصيَّر) —
 * يمرّره React إلى useSeo ويمرّره prerender إلى buildPage، فالكتلتان واحدة بعد الإقلاع وقبله.
 */
export function ambassadorsJsonLd(lang: AmbLang): Record<string, unknown> {
  const t = AMBASSADORS_TEXT[lang];
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: lang,
    mainEntity: t.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
}

const esc = (s: string) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * الجسم الدلالي الذي يكتبه prerender داخل #root (يقرؤه الزاحف وقارئ بلا JavaScript، ويستبدله React بالصفحة
 * كاملةً عند الإقلاع): كل نصوص الصفحة بترتيبها، والأزرار روابط حقيقية إلى مساري التحويل.
 */
export function ambassadorsStaticHtml(lang: AmbLang): string {
  const t = AMBASSADORS_TEXT[lang];
  const home = lang === 'ar' ? '/' : `/${lang}/`;
  const items = (list: AmbItem[]) => `<ul>${list.map((x) => `<li><strong>${esc(x.t)}</strong> — ${esc(x.d)}</li>`).join('')}</ul>`;
  const others = AMBASSADORS_LANGS.filter((x) => x !== lang)
    .map((x) => `<a href="${ambassadorsPathFor(x)}/" hreflang="${x}">${esc(AMBASSADORS_LANG_LABEL[x])}</a>`).join(' · ');
  return [
    '<main>',
    `<p>${esc(t.eyebrow)}</p>`,
    `<h1>${esc(t.h1)}</h1>`,
    `<p>${esc(t.lead)}</p>`,
    `<p><a href="${AMBASSADORS_JOIN}">${esc(t.cta)}</a> — ${esc(t.ctaNote)} · <a href="${AMBASSADORS_LOGIN}">${esc(t.login)}</a></p>`,
    `<ul>${t.stats.map((s) => `<li><strong>${esc(s.v)}</strong> ${esc(s.l)}</li>`).join('')}</ul>`,
    `<h2>${esc(t.stepsTitle)}</h2>`,
    `<p>${esc(t.stepsSub)}</p>`,
    `<ol>${t.steps.map((x) => `<li><strong>${esc(x.t)}</strong> — ${esc(x.d)}</li>`).join('')}</ol>`,
    `<h2>${esc(t.whyTitle)}</h2>`,
    items(t.why),
    `<h2>${esc(t.toolsTitle)}</h2>`,
    items(t.tools),
    `<h2>${esc(t.whoTitle)}</h2>`,
    `<p>${esc(t.whoSub)}</p>`,
    items(t.who),
    `<h2>${esc(t.faqTitle)}</h2>`,
    t.faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join(''),
    `<h2>${esc(t.finalTitle)}</h2>`,
    `<p>${esc(t.finalBody)}</p>`,
    `<p><a href="${AMBASSADORS_JOIN}">${esc(t.finalCta)}</a></p>`,
    `<p>${esc(t.termsNote)}</p>`,
    `<p>${esc(t.otherLangs)}: ${others}</p>`,
    `<p><a href="${home}">${esc(t.home)}</a></p>`,
    '</main>',
  ].join('\n');
}
