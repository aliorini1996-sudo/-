/**
 * نصوص صفحة التسعير بلغاتها — مفصولة عن PricingPage.tsx كي يستوردها اختبار حارس الادّعاءات
 * (src/content/claimsGuard.test.ts) **بالنص المشحون نفسه**: كان الاختبار يلصق نسخة يدوية من
 * صندوق الإنصاف، فلو عاد نفيٌ قديم هنا لنجح npm test ونجح البناء معاً (verify-claims لا يرى حزم JS،
 * وprerender يصيّر /pricing من نصوصه الخاصة).
 */
export type PricingLang = 'ar' | 'en' | 'fr';

export const PRICING_TEXT: Record<PricingLang, Record<string, string>> = {
  ar: {
    back: 'الرئيسية',
    title: 'باقات Field Sales بلا رسوم خفية',
    sub: 'السعر لكل شركة لا لكل مستخدم إضافة مندوب ضمن حد باقتك لا تزيد فاتورتك',
    perCompany: 'لكل شركة لا لكل مستخدم',
    noSetup: 'بلا رسوم تأسيس أو إعداد',
    noCommit: 'بلا التزام سنوي',
    trial: 'تجربة ١٠ أيام بلا بطاقة ائتمان',
    talk: 'تحدث معنا على واتساب',
    startTrial: 'ابدأ التجربة المجانية',
    quote: 'اطلب عرض سعر',
    faqTitle: 'أسئلة عن التسعير',
    fairTitle: 'ما نملكه وما لا نملكه بصراحة',
    fairBody: 'ندعم الفاتورة الإلكترونية برمز QR وندعم **ربط المرحلة الثانية** مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك والهيئة لا تعتمد ولا تصادق مزودي البرمجيات فلا ندعي اعتمادا منها وليست لدينا شهادات SOC2 أو ISO',
  },
  en: {
    back: 'Home',
    title: 'Field Sales plans with no hidden fees',
    sub: 'Priced per company not per user Adding a rep within your plan limit does not raise your bill',
    perCompany: 'Per company not per user',
    noSetup: 'No setup or onboarding fees',
    noCommit: 'No annual lock-in',
    trial: '10-day trial no credit card',
    talk: 'Talk to us on WhatsApp',
    startTrial: 'Start the free trial',
    quote: 'Request a quote',
    faqTitle: 'Pricing questions',
    fairTitle: 'What we have and do not have plainly',
    fairBody: 'We support **Phase 2 integration** with the Fatoora platform of ZATCA ZATCA does not certify or approve software vendors so we claim no approval from it We hold no SOC2 or ISO certification',
  },
  fr: {
    back: 'Accueil',
    title: 'Offres Field Sales sans frais cachés',
    sub: 'Par entreprise pas par utilisateur Ajouter un commercial dans la limite de votre offre n augmente pas la facture',
    perCompany: 'Par entreprise pas par utilisateur',
    noSetup: 'Aucuns frais de mise en service',
    noCommit: 'Sans engagement annuel',
    trial: 'Essai 10 jours sans carte',
    talk: 'Discutez avec nous sur WhatsApp',
    startTrial: 'Démarrer l essai gratuit',
    quote: 'Demander un devis',
    faqTitle: 'Questions sur les tarifs',
    fairTitle: 'Ce que nous avons et n avons pas clairement',
    fairBody: 'Nous prenons en charge **l intégration phase 2** avec la plateforme Fatoora de la ZATCA La ZATCA ne certifie aucun éditeur nous ne revendiquons donc aucune homologation',
  },
};
