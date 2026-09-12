// محتوى صفحة «بروفايل» — الملف التعريفي التسويقي على fieldsa.net/profile
//
// الحقيقة تعيش في CMS الموقع (siteContent[PROFILE_CMS_KEY]) والقيم هنا افتراضياتٌ
// تُستخدم حين لا يكون المالك عدّل الحقل بعد — فأي حقل يعدّله من لوحته يفوز فوراً.
// القوائم تُخزَّن نصاً بأسطر (سطر = بند)، ومحطات الرحلة وأرقامها بصيغة «قيمة | وصف».
//
// النصوص كلها مكتوبة بقوالب نصّية (backticks) بأسطر حقيقية لا بـ«\n»: القارئ يرى
// الشكل النهائي كما هو، و`splitLines` تقصّ كل سطر فلا تضرّ المسافات البادئة.

/**
 * مفتاح محتوى البروفايل في CMS.
 *
 * ⚠️ **لماذا مفتاح ثالث:** هذه النسخة تسويقية لا استثمارية، وأسماء الحقول نفسها
 * (`ask_title` و`model_items` و`opportunity_items` …) صار **معناها مختلفاً**:
 * «الطلب الاستثماري» صار «ابدأ اليوم»، و«نموذج العمل» صار «الاشتراك». و
 * `mergeProfile` يُعلي المحفوظ على الافتراضي — فلو بقي المفتاح `profileV2` لفازت
 * قيمٌ محفوظة لمعنى قديم على النصّ الجديد بصمت، فيرى الزائر «نفتح جولتنا
 * الاستثمارية» تحت عنوان «ابدأ اليوم».
 *
 * القاعدة المستخلصة مرّتين الآن: **تغيير معنى الحقول يلزمه فضاء اسم جديد** — لا
 * تغيير أسمائها وحدها. والقديم يبقى في `profile` و`profileV2` لا يُحذف ولا يُقرأ.
 */
export const PROFILE_CMS_KEY = 'profileV3';

/** لغات البروفايل — نفس لغات المنصّة الخمس، والعربية وحدها RTL */
export const PROFILE_LANGS = ['ar', 'en', 'fr', 'tr', 'zh'] as const;
export type ProfileLang = (typeof PROFILE_LANGS)[number];

export interface ProfileSection { [k: string]: string }
export type ProfileContent = Record<ProfileLang, ProfileSection>;

/** اسم كل لغة بلغتها — لمبدّل الصفحة ومحرّر المالك */
export const PROFILE_LANG_LABEL: Record<ProfileLang, string> = {
  ar: 'عربي',
  en: 'English',
  fr: 'Français',
  tr: 'Türkçe',
  zh: '中文',
};

// وصف الحقول — يقود محرر المالك والصفحة معاً (المفتاح ثابت والنص حر)
export const PROFILE_FIELDS: { key: string; label: string; multiline?: boolean; hint?: string }[] = [
  { key: 'cover_title', label: 'عنوان الغلاف' },
  { key: 'cover_promise', label: 'سطر الوعد تحت العنوان', multiline: true },
  { key: 'problem_title', label: 'المشكلة العنوان' },
  { key: 'problem_body', label: 'المشكلة النص', multiline: true, hint: 'كل سطر يظهر سطرا مستقلا' },
  { key: 'solution_title', label: 'المنصة العنوان' },
  { key: 'solution_col1_title', label: 'عنوان عمود لوحة الادارة' },
  { key: 'solution_col1', label: 'ميزات لوحة الادارة', multiline: true, hint: 'كل سطر ميزة' },
  { key: 'solution_col2_title', label: 'عنوان عمود تطبيق المندوب' },
  { key: 'solution_col2', label: 'ميزات تطبيق المندوب', multiline: true, hint: 'كل سطر ميزة' },
  { key: 'opportunity_title', label: 'ما نحله العنوان' },
  { key: 'opportunity_intro', label: 'ما نحله التمهيد', multiline: true },
  { key: 'opportunity_items', label: 'ما نحله البنود', multiline: true, hint: 'ثلاثة بنود — بطاقة لكل سطر' },
  { key: 'why_title', label: 'لماذا نحن العنوان' },
  { key: 'why_body', label: 'لماذا نحن النص', multiline: true },
  { key: 'journey_title', label: 'الرحلة العنوان' },
  { key: 'journey_stations', label: 'الرحلة المحطات', multiline: true, hint: 'كل سطر التاريخ | الحدث' },
  { key: 'model_title', label: 'الاشتراك العنوان' },
  { key: 'model_items', label: 'الاشتراك البنود', multiline: true, hint: 'كل سطر بند مرقم' },
  { key: 'numbers_title', label: 'الارقام العنوان' },
  { key: 'numbers_items', label: 'الارقام', multiline: true, hint: 'كل سطر الرقم | الوصف' },
  { key: 'roadmap_title', label: 'القدرات الاضافية العنوان' },
  { key: 'roadmap_items', label: 'القدرات الاضافية البنود', multiline: true, hint: 'كل سطر بند مرقم' },
  { key: 'partners_title', label: 'شركاء النجاح العنوان' },
  { key: 'ask_title', label: 'ابدا اليوم العنوان' },
  { key: 'ask_items', label: 'ابدا اليوم الخطوات', multiline: true, hint: 'كل سطر خطوة مرقمة' },
  { key: 'closing_title', label: 'الختام العنوان' },
  { key: 'closing_line', label: 'سطر الختام', multiline: true },
  { key: 'contact_website', label: 'الموقع' },
  { key: 'contact_email', label: 'البريد' },
  { key: 'contact_location', label: 'المقر' },
];

export const PROFILE_DEFAULTS: ProfileContent = {
  // ─────────────────────────────── العربية ───────────────────────────────
  ar: {
    cover_title: 'نظام التشغيل الكامل لشركات التوزيع والمبيعات الميدانية',
    cover_promise: `من الطلب في الميدان إلى الفاتورة الضريبية والتحصيل والمخزون
      كل شيء في منصّة واحدة تعمل حتى بلا إنترنت`,

    problem_title: 'يومك يضيع في مطاردة الورق لا في زيادة المبيعات',
    problem_body: `الفاتورة تُكتب بخطّ اليد في الميدان وتدخل النظام بعد أيام
      والتحصيل النقدي عهدة بلا سند يثبت من قبضه ومتى ورّده
      ومخزون السيارة بلا جرد، والمرتجع يذوب في الرصيد بلا أثر
      وأنت تطارد مناديبك على واتساب بدل أن تقرأ شاشة واحدة`,

    solution_title: 'منصّة واحدة تُدار من مكتبك ومن جوّال مندوبك',
    solution_col1_title: 'لوحة الإدارة',
    solution_col1: `مبيعات وتحصيل ومخزون لحظة بلحظة على شاشة واحدة
      تتبّع مباشر لكل مندوب على الخريطة مع خطّ سيره وزياراته
      كشوف حساب ومديونيات مرتّبة بأعمار الدين
      منتجات وأسعار خاصّة وشرائح كمّية لكل عميل
      مناديب بصلاحيات دقيقة وعهدة موثّقة لكل واحد
      مستخدمو شركة بنطاق محدود: كلٌّ يرى عملاءه ومناديبه وحدهم
      سجلٌّ لا يُمحى: من أصدر الفاتورة ومن قبض ومتى ورّد
      تقارير جاهزة تقرؤها قبل اجتماع الصباح
      هويّتك البصريّة على كل مطبوعة: شعارك ولونك وترويستك`,
    solution_col2_title: 'تطبيق المندوب',
    solution_col2: `يعمل من الجوّال مباشرةً كأنّه نقطة بيع متنقّلة
      فاتورة ضريبيّة برمز QR متوافقة مع الفوترة الإلكترونيّة
      سند قبض يوثّق كل ريال يستلمه من العميل
      يعمل بلا إنترنت ويرفع كل شيء وحده حين يعود الاتّصال
      مخزون سيّارته أمامه والتحميل المقترح يحسبه النظام
      كشف حساب العميل يعرضه ويرسله وهو في مكانه
      رابط دفع إلكترونيّ يسدّد به العميل ببطاقته فوراً
      تسجيل الزيارة بالصور والموقع وملاحظة ميدانيّة
      مسح باركود سريع للأصناف أثناء البيع`,

    opportunity_title: 'ثلاث عُقد يعرفها كل موزّع، وحلّها مبنيّ في الأساس',
    opportunity_intro: 'ليست إضافاتٍ لُصقت على النظام، بل قرارات بُني عليها من أوّل سطر',
    opportunity_items: `انقطاع الشبكة لا يوقف البيع: المندوب يفوتر ويحصّل ثم يزامن وحده حين يعود الاتّصال
      الحمولة تُحسب لا تُخمَّن: النظام يقترح كمّية كل صنف من طلب الأيّام الماضية
      النقد يتقلّص: العميل يدفع ببطاقته من جوّال المندوب ويصله سنده في اللحظة`,

    why_title: 'بناها موزّع يعيش المشكلة كل يوم',
    why_body: `المؤسّس يملك ويدير شركة توزيع غذائيّ في الرياض ونجد منذ ٢٠٢١
      نعرف المرتجع والعهدة وضغط نهاية الشهر لأنّنا نعيشها لا نقرأ عنها
      كل شاشة جُرِّبت على مناديبنا شهوراً قبل أن تصل إلى أوّل عميل
      والدعم يردّ بالعربيّة ويفهم كلامك من أوّل جملة`,

    journey_title: 'منصّة بُنيت طبقةً فوق طبقة',
    journey_stations: `مطلع ٢٠٢٦ | إطلاق المنصّة حيّةً على السحابة
      ربيع ٢٠٢٦ | التتبّع المباشر والتقارير
      صيف ٢٠٢٦ | العمل بلا إنترنت والمدفوعات الإلكترونيّة
      اليوم | منصّة مكتملة في الإنتاج تخدم شركات في ١٣ قطاعاً`,

    model_title: 'ثلاث باقات تختار بينها بعدد مناديبك',
    model_items: `المبتدئة ٢٩٩ ريالاً شهريّاً حتى خمسة مناديب ومستخدم إداريّ واحد، شاملةً ضريبة القيمة المضافة
      المتوسّطة ٣٩٩ ريالاً شهريّاً حتى عشرة مناديب ومستخدمَين إداريَّين
      الاحترافيّة ٥٩٩ ريالاً شهريّاً حتى عشرين مندوباً وخمسة مستخدمين إداريين بصلاحيات موسّعة
      وما زاد على عشرين مندوباً فبالتفاوض — كلّمنا ونجهّز لك عرضاً يناسب حجمك
      تجربة عشرة أيّام مجّاناً بلا بطاقة ولا التزام، وبياناتك تبقى ملكك`,

    numbers_title: 'أرقام من الإنتاج لا من العروض',
    numbers_items: `١٦ | شركة شغّلت أعمالها على المنصّة
      ٨٥ | مندوباً نشطاً في الميدان يوميّاً
      +١٠٠٠٠ | فاتورة تصدر عبر المنصّة شهريّاً
      ١٣ | قطاع توزيع يعمل عليها اليوم`,

    roadmap_title: 'قدرات إضافيّة تفتحها حين تحتاجها',
    roadmap_items: `مستودع الشركة: وارد وتسويات وجرد يربط المخزون بسيّارات المناديب
      المدفوعات الإلكترونيّة: رابط دفع لكل فاتورة وتوريد أسبوعيّ منظّم
      منيو المطاعم مع كاشير وشاشة مطبخ لقطاع الأغذية
      ربطٌ مع أنظمتك القائمة ومنظومات الوقود وأرقام العمل المؤسّسيّة`,

    partners_title: 'شركاء نثق بهم ويثقون بنا',
    ask_title: 'ابدأ اليوم في ثلاث خطوات',
    ask_items: `سجّل تجربة عشرة أيّام مجّاناً من الموقع بلا بطاقة
      استورد عملاءك ومنتجاتك من ملفّ إكسل في دقائق
      درّب مندوبيك في جلسة واحدة وابدأ الفوترة من الغد`,

    closing_title: 'ميدانك، مرتّباً',
    closing_line: 'منصّة حيّة في الإنتاج، وشركات تشغّلها في الميدان كل يوم',

    contact_website: 'fieldsa.net',
    contact_email: 'info@fieldsa.net',
    contact_location: 'الرياض، المملكة العربية السعودية',
  },

  // ─────────────────────────────── English ───────────────────────────────
  en: {
    cover_title: 'The complete operating system for distribution and field sales',
    cover_promise: `From the order in the field to the tax invoice, the collection and the stock
      everything in one platform that keeps working without internet`,

    problem_title: 'Your day goes to chasing paper, not to growing sales',
    problem_body: `Invoices are handwritten in the field and reach the system days later
      Cash sits with the rep, with no receipt proving who took it or when it came back
      Van stock goes uncounted, and returns dissolve into the balance without a trace
      And you chase reps on WhatsApp instead of reading one screen`,

    solution_title: 'One platform, run from your desk and from your rep’s phone',
    solution_col1_title: 'Admin dashboard',
    solution_col1: `Sales, collections and stock in real time on a single screen
      Live tracking of every rep on the map, with route and visits
      Statements and receivables sorted by debt age
      Products, customer-specific prices and quantity tiers
      Reps with precise permissions and documented custody for each
      Scoped company users: each sees only their own customers and reps
      An audit trail that cannot be erased: who invoiced, who collected, when it was handed in
      Reports ready before the morning meeting
      Your brand on every printout: logo, colour and letterhead`,
    solution_col2_title: 'Rep app',
    solution_col2: `Runs straight from the phone as a mobile point of sale
      Tax invoices with a QR code, compliant with e-invoicing
      A receipt documenting every riyal taken from the customer
      Works offline and uploads everything on its own when the connection returns
      Van stock in front of the rep, with the suggested load calculated for them
      Customer statements shown and sent on the spot
      An electronic payment link the customer settles by card immediately
      Visit logging with photos, location and a field note
      Fast barcode scanning while selling`,

    opportunity_title: 'Three knots every distributor knows, solved at the foundation',
    opportunity_intro: 'Not add-ons bolted onto the system, but decisions it was built on from the first line',
    opportunity_items: `A dropped connection does not stop the sale: the rep invoices and collects, then syncs on their own
      The load is calculated, not guessed: the system suggests a quantity per item from recent demand
      Cash shrinks: the customer pays by card from the rep phone and gets the receipt instantly`,

    why_title: 'Built by a distributor who lives the problem daily',
    why_body: `The founder has owned and run a food distribution company in Riyadh and Najd since 2021
      We know returns, custody and month-end pressure because we live them, not read about them
      Every screen was tested on our own reps for months before it reached a single customer
      And support answers in Arabic and understands you from the first sentence`,

    journey_title: 'A platform built layer over layer',
    journey_stations: `Early 2026 | Platform launched live on the cloud
      Spring 2026 | Live tracking and reports
      Summer 2026 | Offline mode and electronic payments
      Today | A complete platform in production serving companies across 13 sectors`,

    model_title: 'Three plans, chosen by your number of reps',
    model_items: `Starter at 299 SAR a month for up to five reps and one admin user, VAT included
      Growth at 399 SAR a month for up to ten reps and two admin users
      Advanced at 599 SAR a month for up to twenty reps and five admin users, with extended permissions
      Beyond twenty reps, pricing is by agreement — talk to us and we will tailor an offer to your size
      A ten-day free trial, no card and no commitment, and your data stays yours`,

    numbers_title: 'Numbers from production, not from decks',
    numbers_items: `16 | companies have run their work on the platform
      85 | reps active in the field every day
      10,000+ | invoices issued through the platform monthly
      13 | distribution sectors running on it today`,

    roadmap_title: 'Extra capabilities you switch on when you need them',
    roadmap_items: `Company warehouse: inbound, adjustments and stocktakes linked to van stock
      Electronic payments: a payment link per invoice and an organised weekly settlement
      Restaurant menu with cashier and kitchen screen for the food sector
      Integration with your existing systems, fuel platforms and corporate work numbers`,

    partners_title: 'Partners we trust, and who trust us',
    ask_title: 'Start today in three steps',
    ask_items: `Sign up for a ten-day free trial from the website, no card needed
      Import your customers and products from an Excel file in minutes
      Train your reps in one session and start invoicing tomorrow`,

    closing_title: 'Your field, in order',
    closing_line: 'A live platform in production, with companies running it in the field every day',

    contact_website: 'fieldsa.net',
    contact_email: 'info@fieldsa.net',
    contact_location: 'Riyadh, Saudi Arabia',
  },

  // ─────────────────────────────── Français ───────────────────────────────
  fr: {
    cover_title: 'Le système d’exploitation complet de la distribution et de la vente terrain',
    cover_promise: `De la commande sur le terrain à la facture fiscale, à l’encaissement et au stock
      tout dans une seule plateforme qui fonctionne même sans connexion`,

    problem_title: 'Vos journées passent à courir après le papier, pas à vendre plus',
    problem_body: `Les factures sont écrites à la main sur le terrain et saisies des jours plus tard
      L’encaissement en espèces reste chez le commercial, sans reçu prouvant qui l’a pris ni quand il l’a rendu
      Le stock du camion n’est jamais inventorié, et les retours se dissolvent dans le solde sans trace
      Et vous relancez vos commerciaux sur WhatsApp au lieu de lire un seul écran`,

    solution_title: 'Une plateforme unique, pilotée depuis votre bureau et depuis le téléphone du commercial',
    solution_col1_title: 'Tableau de bord',
    solution_col1: `Ventes, encaissements et stock en temps réel sur un seul écran
      Suivi en direct de chaque commercial sur la carte, avec son itinéraire et ses visites
      Relevés de compte et créances classés par ancienneté de la dette
      Produits, prix négociés par client et paliers de quantité
      Commerciaux aux droits précis, avec une caisse documentée pour chacun
      Utilisateurs au périmètre limité : chacun ne voit que ses clients et ses commerciaux
      Une piste d’audit ineffaçable : qui a facturé, qui a encaissé, quand cela a été remis
      Des rapports prêts avant la réunion du matin
      Votre identité sur chaque impression : logo, couleur et en-tête`,
    solution_col2_title: 'Application commercial',
    solution_col2: `Fonctionne directement depuis le téléphone comme un point de vente mobile
      Factures fiscales avec code QR, conformes à la facturation électronique
      Un reçu qui documente chaque riyal encaissé auprès du client
      Fonctionne hors ligne et téléverse tout seul dès le retour du réseau
      Le stock du camion sous les yeux, avec le chargement suggéré calculé pour lui
      Relevé de compte client affiché et envoyé sur place
      Un lien de paiement électronique que le client règle par carte immédiatement
      Enregistrement des visites avec photos, position et note de terrain
      Lecture rapide des codes-barres pendant la vente`,

    opportunity_title: 'Trois nœuds que tout distributeur connaît, résolus dès les fondations',
    opportunity_intro: 'Non pas des options ajoutées après coup, mais des choix faits dès la première ligne de code',
    opportunity_items: `Une coupure réseau n’arrête pas la vente : le commercial facture et encaisse, puis la synchronisation se fait seule
      Le chargement se calcule au lieu de se deviner : le système propose une quantité par article à partir de la demande récente
      Le cash recule : le client paie par carte depuis le téléphone du commercial et reçoit son reçu à l’instant`,

    why_title: 'Conçue par un distributeur qui vit le problème chaque jour',
    why_body: `Le fondateur possède et dirige une société de distribution alimentaire à Riyad et au Najd depuis 2021
      Nous connaissons les retours, la caisse et la pression de fin de mois parce que nous les vivons
      Chaque écran a été testé des mois sur nos propres commerciaux avant d’atteindre un seul client
      Et le support répond en arabe et vous comprend dès la première phrase`,

    journey_title: 'Une plateforme bâtie couche après couche',
    journey_stations: `Début 2026 | Lancement de la plateforme en production sur le cloud
      Printemps 2026 | Suivi en direct et rapports
      Été 2026 | Mode hors ligne et paiements électroniques
      Aujourd’hui | Une plateforme complète en production au service de 13 secteurs`,

    model_title: 'Trois formules, choisies selon votre nombre de commerciaux',
    model_items: `Débutant à 299 SAR par mois jusqu’à cinq commerciaux et un utilisateur admin, TVA comprise
      Croissance à 399 SAR par mois jusqu’à dix commerciaux et deux utilisateurs admin
      Avancé à 599 SAR par mois jusqu’à vingt commerciaux et cinq utilisateurs admin, avec droits étendus
      Au-delà de vingt commerciaux, le tarif se négocie — parlez-nous et nous adapterons une offre à votre taille
      Dix jours d’essai gratuit, sans carte ni engagement, et vos données restent les vôtres`,

    numbers_title: 'Des chiffres issus de la production, pas des présentations',
    numbers_items: `16 | entreprises ont fait tourner leur activité sur la plateforme
      85 | commerciaux actifs sur le terrain chaque jour
      10 000+ | factures émises par la plateforme chaque mois
      13 | secteurs de distribution l’utilisent aujourd’hui`,

    roadmap_title: 'Des capacités supplémentaires activées quand vous en avez besoin',
    roadmap_items: `Entrepôt central : entrées, ajustements et inventaires reliés au stock des camions
      Paiements électroniques : un lien de paiement par facture et un reversement hebdomadaire organisé
      Menu restaurant avec caisse et écran cuisine pour le secteur alimentaire
      Intégration à vos systèmes existants, aux plateformes carburant et aux numéros professionnels`,

    partners_title: 'Des partenaires de confiance, réciproque',
    ask_title: 'Commencez aujourd’hui en trois étapes',
    ask_items: `Ouvrez un essai gratuit de dix jours depuis le site, sans carte
      Importez vos clients et vos produits depuis un fichier Excel en quelques minutes
      Formez vos commerciaux en une séance et facturez dès demain`,

    closing_title: 'Votre terrain, enfin en ordre',
    closing_line: 'Une plateforme en production, utilisée chaque jour sur le terrain par de vraies entreprises',

    contact_website: 'fieldsa.net',
    contact_email: 'info@fieldsa.net',
    contact_location: 'Riyad, Arabie saoudite',
  },

  // ─────────────────────────────── Türkçe ───────────────────────────────
  tr: {
    cover_title: 'Dağıtım ve saha satışı için eksiksiz işletim sistemi',
    cover_promise: `Sahadaki siparişten vergi faturasına, tahsilata ve stoğa kadar
      her şey internet olmadan da çalışan tek bir platformda`,

    problem_title: 'Gününüz satışı büyütmekle değil, kâğıt kovalamakla geçiyor',
    problem_body: `Faturalar sahada elle yazılıyor ve sisteme günler sonra giriyor
      Nakit tahsilat temsilcide kalıyor; kimin aldığını ve ne zaman teslim ettiğini gösteren bir belge yok
      Araç stoğu sayılmıyor, iadeler bakiyenin içinde izsiz kayboluyor
      Ve siz tek bir ekranı okumak yerine temsilcileri WhatsApp’tan kovalıyorsunuz`,

    solution_title: 'Masanızdan ve temsilcinizin telefonundan yönetilen tek platform',
    solution_col1_title: 'Yönetim paneli',
    solution_col1: `Satış, tahsilat ve stok tek ekranda anlık olarak
      Her temsilcinin haritada canlı takibi; güzergâhı ve ziyaretleriyle
      Hesap ekstreleri ve borç yaşına göre sıralanmış alacaklar
      Ürünler, müşteriye özel fiyatlar ve miktar kademeleri
      Yetkileri ayrıntılı tanımlanmış temsilciler ve her biri için belgelenmiş zimmet
      Kapsamı sınırlı şirket kullanıcıları: herkes yalnızca kendi müşterisini ve temsilcisini görür
      Silinemeyen denetim izi: kim faturaladı, kim tahsil etti, ne zaman teslim edildi
      Sabah toplantısından önce hazır raporlar
      Her çıktıda kendi kimliğiniz: logonuz, renginiz ve antetiniz`,
    solution_col2_title: 'Temsilci uygulaması',
    solution_col2: `Telefondan doğrudan mobil satış noktası gibi çalışır
      E-faturaya uyumlu, QR kodlu vergi faturası
      Müşteriden alınan her riyali belgeleyen tahsilat makbuzu
      Çevrimdışı çalışır ve bağlantı gelince her şeyi kendiliğinden yükler
      Araç stoğu önünde, önerilen yükleme sistem tarafından hesaplanmış
      Müşteri ekstresini yerinde gösterir ve gönderir
      Müşterinin kartıyla anında ödediği elektronik ödeme bağlantısı
      Fotoğraf, konum ve saha notuyla ziyaret kaydı
      Satış sırasında hızlı barkod okutma`,

    opportunity_title: 'Her dağıtımcının bildiği üç düğüm, temelden çözülmüş',
    opportunity_intro: 'Sisteme sonradan eklenen özellikler değil, ilk satırdan itibaren üzerine kurulduğu kararlar',
    opportunity_items: `Bağlantı kopması satışı durdurmaz: temsilci faturalar ve tahsil eder, sonra eşitleme kendiliğinden yapılır
      Yükleme tahmin edilmez, hesaplanır: sistem son günlerin talebinden ürün başına miktar önerir
      Nakit azalır: müşteri temsilcinin telefonundan kartıyla öder ve makbuzunu anında alır`,

    why_title: 'Sorunu her gün yaşayan bir dağıtımcı tarafından yapıldı',
    why_body: `Kurucu 2021’den beri Riyad ve Necid’de bir gıda dağıtım şirketinin sahibi ve yöneticisi
      İadeyi, zimmeti ve ay sonu baskısını biliyoruz; çünkü okumuyor, yaşıyoruz
      Her ekran, tek bir müşteriye ulaşmadan önce aylarca kendi temsilcilerimizde denendi
      Ve destek Arapça yanıt verir, sizi ilk cümleden anlar`,

    journey_title: 'Katman katman inşa edilmiş bir platform',
    journey_stations: `2026 başı | Platformun bulutta canlı olarak yayına alınması
      2026 baharı | Canlı takip ve raporlar
      2026 yazı | Çevrimdışı çalışma ve elektronik ödemeler
      Bugün | Üretimde, 13 sektörde şirketlere hizmet veren eksiksiz bir platform`,

    model_title: 'Temsilci sayınıza göre seçtiğiniz üç paket',
    model_items: `Başlangıç paketi, beş temsilci ve bir yönetici hesabına kadar aylık 299 SAR, KDV dâhil
      Büyüme paketi, on temsilci ve iki yönetici hesabına kadar aylık 399 SAR
      Gelişmiş paket, yirmi temsilci ve beş yönetici hesabına kadar aylık 599 SAR; genişletilmiş yetkiler
      Yirmi temsilcinin üzerinde fiyat görüşmeye tabidir — bize ulaşın, ölçeğinize uygun bir teklif hazırlayalım
      On gün ücretsiz deneme; kart yok, taahhüt yok ve verileriniz sizin kalır`,

    numbers_title: 'Sunumlardan değil, üretimden gelen rakamlar',
    numbers_items: `16 | şirket işini platform üzerinde yürüttü
      85 | temsilci her gün sahada aktif
      10.000+ | fatura her ay platform üzerinden kesiliyor
      13 | dağıtım sektörü bugün platformu kullanıyor`,

    roadmap_title: 'İhtiyaç duyduğunuzda açtığınız ek yetenekler',
    roadmap_items: `Şirket deposu: giriş, düzeltme ve sayımların araç stoğuyla bağlanması
      Elektronik ödemeler: fatura başına ödeme bağlantısı ve düzenli haftalık aktarım
      Gıda sektörü için kasa ve mutfak ekranıyla restoran menüsü
      Mevcut sistemlerinizle, yakıt platformlarıyla ve kurumsal iş numaralarıyla entegrasyon`,

    partners_title: 'Güvendiğimiz ve bize güvenen iş ortakları',
    ask_title: 'Bugün üç adımda başlayın',
    ask_items: `Siteden kartsız, on günlük ücretsiz denemeyi başlatın
      Müşterilerinizi ve ürünlerinizi Excel dosyasından dakikalar içinde aktarın
      Temsilcilerinizi tek oturumda eğitin ve yarın faturalamaya başlayın`,

    closing_title: 'Sahanız, düzene girmiş halde',
    closing_line: 'Üretimde canlı bir platform ve onu her gün sahada çalıştıran şirketler',

    contact_website: 'fieldsa.net',
    contact_email: 'info@fieldsa.net',
    contact_location: 'Riyad, Suudi Arabistan',
  },

  // ─────────────────────────────── 中文 ───────────────────────────────
  zh: {
    cover_title: '面向分销与外勤销售的完整运营系统',
    cover_promise: `从现场下单到税务发票、回款与库存
      全部集中在一个即使断网也能继续运转的平台上`,

    problem_title: '时间都花在追单据上，而不是把销售做大',
    problem_body: `发票在现场手写，几天后才录入系统
      现金回款留在业务员手里，没有凭据证明谁收的、何时上交
      车载库存无人盘点，退货在余额里悄悄消失
      而您只能在 WhatsApp 上追业务员，而不是看一块屏幕`,

    solution_title: '一个平台，办公室与业务员手机同时在用',
    solution_col1_title: '管理后台',
    solution_col1: `销售、回款与库存在同一块屏幕上实时呈现
      在地图上实时追踪每位业务员，含行驶轨迹与拜访记录
      按账龄排序的对账单与应收账款
      商品、客户专属价格与数量阶梯价
      权限精细的业务员，每人都有可追溯的在手库存与现金
      范围受限的公司用户：各自只看到自己的客户与业务员
      不可抹除的操作留痕：谁开票、谁收款、何时上交
      晨会之前就已备好的报表
      每一张打印件上都是您的品牌：标识、主色与抬头`,
    solution_col2_title: '业务员应用',
    solution_col2: `直接在手机上运行，如同一台移动收银机
      带二维码、符合电子发票要求的税务发票
      为向客户收取的每一笔款项出具收据
      支持离线作业，网络恢复后自动上传全部数据
      车载库存一目了然，建议装车量由系统自动计算
      客户对账单可当场查看并发送
      电子支付链接，客户可立即用银行卡结清
      拜访记录含照片、定位与现场备注
      销售过程中快速扫描条码`,

    opportunity_title: '每位分销商都熟悉的三个难题，从底层解决',
    opportunity_intro: '不是事后加装的功能，而是从第一行代码起就确定的设计取舍',
    opportunity_items: `断网不影响开单：业务员照常开票收款，恢复连接后自动同步
      装车量靠计算而非猜测：系统根据近期需求为每个品项建议数量
      现金占比下降：客户在业务员手机上刷卡支付，收据即时送达`,

    why_title: '由每天面对同样问题的分销商打造',
    why_body: `创始人自 2021 年起在利雅得与纳吉德拥有并经营一家食品分销公司
      我们了解退货、在手货款与月末压力，因为我们身处其中
      每一块屏幕都先在自家业务员身上试用数月，才交付给第一位客户
      客服以阿拉伯语作答，第一句话就能听懂您的诉求`,

    journey_title: '一层一层搭建起来的平台',
    journey_stations: `2026 年初 | 平台在云端正式上线
      2026 年春 | 实时追踪与报表
      2026 年夏 | 离线作业与电子支付
      今天 | 已在生产环境稳定运行，服务 13 个行业的企业`,

    model_title: '三种套餐，按业务员人数选择',
    model_items: `入门版每月 299 沙特里亚尔，最多 5 位业务员和 1 个管理账号，含增值税
      成长版每月 399 沙特里亚尔，最多 10 位业务员和 2 个管理账号
      进阶版每月 599 沙特里亚尔，最多 20 位业务员和 5 个管理账号，权限更广
      超过 20 位业务员的方案面议 —— 联系我们，我们按您的规模定制报价
      十天免费试用，无需银行卡、无需承诺，数据始终属于您`,

    numbers_title: '来自生产环境的数字，而非演示文稿',
    numbers_items: `16 | 家企业已在平台上开展业务
      85 | 位业务员每天活跃在一线
      10,000+ | 张发票每月通过平台开具
      13 | 个分销行业正在使用`,

    roadmap_title: '按需开通的增值能力',
    roadmap_items: `公司仓库：入库、调整与盘点，并与车载库存联动
      电子支付：每张发票一个支付链接，每周有序结算
      面向餐饮业的菜单、收银台与厨房显示屏
      与现有系统、燃油平台及企业办公号码的对接`,

    partners_title: '彼此信赖的合作伙伴',
    ask_title: '三步即可开始',
    ask_items: `在官网开通十天免费试用，无需银行卡
      几分钟内从 Excel 文件导入客户与商品
      一次培训即可让业务员上手，次日开始开票`,

    closing_title: '让您的一线井然有序',
    closing_line: '一个稳定运行的平台，每天都有企业在一线真实使用',

    contact_website: 'fieldsa.net',
    contact_email: 'info@fieldsa.net',
    contact_location: '沙特阿拉伯，利雅得',
  },
};

/** أقسام يمكن للمالك إخفاؤها من الصفحة — الغياب يعني الظهور */
export const PROFILE_SECTIONS: { key: string; label: string }[] = [
  { key: 'problem', label: 'المشكلة' },
  { key: 'solution', label: 'المنصة والميزات' },
  { key: 'opportunity', label: 'ما نحله' },
  { key: 'why', label: 'لماذا نحن' },
  { key: 'journey', label: 'الرحلة' },
  { key: 'model', label: 'الاشتراك' },
  { key: 'numbers', label: 'الارقام' },
  { key: 'roadmap', label: 'القدرات الاضافية' },
  { key: 'ask', label: 'ابدا اليوم' },
  { key: 'partners', label: 'شركاء النجاح' },
  { key: 'contact', label: 'تواصل معنا' },
];

/**
 * شركاء النجاح — **خارج خريطة اللغات عمداً**.
 *
 * بقيّة المحتوى `Record<lang, ...>`، ولو وُضع الشركاء فيها لوجب على المالك رفع
 * كل شعار **خمس مرّات**، ولتضاعف حجم الـbase64 خمسةً في حمولةٍ تُجلب مع كل
 * زيارة. واسم الشريك علامةٌ تجارية لا تُترجَم أصلاً. فالشركاء مفتاحٌ مستقلّ
 * يُرفع مرّة ويُعرض في اللغات كلّها، والعنوان وحده يُترجَم (`partners_title`).
 */
export const PROFILE_PARTNERS_KEY = 'profileV3Partners';

export interface ProfilePartner {
  /** اسم الشريك كما يُكتب على شعاره */
  name: string;
  /** الشعار data URL — يُصغَّر عند الرفع فلا يُثقل الحمولة */
  logo: string;
}

/** يقرأ الشركاء من محتوى الموقع، ويتجاهل أي صفٍّ بلا اسم ولا شعار */
export function readPartners(cms: Record<string, unknown> | null | undefined): ProfilePartner[] {
  const raw = cms?.[PROFILE_PARTNERS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is ProfilePartner => !!x && typeof x === 'object')
    .map(x => ({ name: String(x.name || '').trim(), logo: String(x.logo || '').trim() }))
    .filter(x => x.name || x.logo);
}

/** مفتاح إظهار القسم داخل المحتوى */
export const showKey = (section: string) => `show_${section}`;

/**
 * هل يظهر القسم؟ الإظهار شأنٌ واحد لكل اللغات فيُقرأ من العربية أياً كانت اللغة
 * المعروضة — ولو خُزّن لكل لغة لرأى قارئ الصينية قسماً أخفاه المالك.
 */
export const sectionOn = (c: ProfileContent, section: string) => c.ar[showKey(section)] !== '0';

/**
 * يدمج ما حفظه المالك فوق الافتراضي — الحقل المحفوظ يفوز، والغائب يبقى افتراضياً.
 * والدمج يمرّ على `PROFILE_LANGS` لا على لغتين مكتوبتين بأيديهما: إضافة لغة سادسة
 * يوماً ما تصير سطراً في المصفوفة، لا صيداً لكل موضعٍ نُسي فيه اسمها.
 */
export function mergeProfile(saved: Partial<ProfileContent> | null | undefined): ProfileContent {
  const out = {} as ProfileContent;
  for (const l of PROFILE_LANGS) out[l] = { ...PROFILE_DEFAULTS[l], ...(saved?.[l] || {}) };
  return out;
}

/** يقسّم حقلاً متعدّد الأسطر إلى بنود — الفراغات تُهمَل والمسافات البادئة تُقصّ */
export const splitLines = (s: string): string[] =>
  (s || '').split('\n').map(l => l.trim()).filter(Boolean);

/** يقسّم بنود «قيمة | وصف» — ما لا فاصل فيه يصير وصفاً بلا قيمة */
export const splitPairs = (s: string): { a: string; b: string }[] =>
  splitLines(s).map(l => {
    const i = l.indexOf('|');
    return i === -1 ? { a: '', b: l.trim() } : { a: l.slice(0, i).trim(), b: l.slice(i + 1).trim() };
  });
