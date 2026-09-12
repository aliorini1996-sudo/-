import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { Download } from 'lucide-react';
import { BrandIcon } from '../components/BrandLogo';
import { mergeProfile, splitLines, splitPairs, sectionOn, readPartners, PROFILE_CMS_KEY, PROFILE_LANGS, PROFILE_LANG_LABEL, ProfileLang, ProfileContent } from '../content/profileContent';

/**
 * «بروفايل» — الملف التعريفي التفاعلي fieldsa.net/profile
 * بنفس ترتيب ملف الـPDF قسما قسما، والمشاهد يبدل اللغة (عربي/انجليزي) كما يناسبه.
 * كل نص يُقرأ من CMS الموقع (siteContent.profile) فيعدّله المالك من لوحته بأي وقت.
 *
 * الصور في /media/profile/*.jpg بأسماء ثابتة — استبدال أي ملف بنسخة أعلى دقة
 * (بنفس الاسم) يحدّث الصفحة دون أي تغيير في الكود.
 */

/**
 * ورقة الطباعة — الملف المصدَّر وثيقة مصمَّمة لا لقطة شاشة مقصوصة.
 *
 * أربع حقائق تحكم كل قاعدة هنا:
 *  ١ المتصفح يُسقط خلفيات الألوان والصور افتراضاً توفيراً للحبر.
 *  ٢ يقيس استعلامات الوسائط بعرض الورقة (A4 ≈ ٧٩٤ بكسل) لا بعرض الشاشة،
 *    فتنهار تخطيطات lg ذات العمودين إلى عمود واحد.
 *  ٣ القسم أطول من الصفحة يُقطع بين ورقتين — أسوأ ما يظهر في وثيقة تُعرض على عميل.
 *  ٤ خلفية الورقة تحكم قراءة كل قسم لا لون له: الأقسام الفاتحة تستمدّ لونها من
 *    الجسم، فتغييره إلى داكن يُخفي نصّها الرماديّ. الجسم يبقى كريمياً دائماً.
 *
 * فالقاعدة: كل قسم صفحة واحدة بارتفاع مضبوط ومحتوى يملؤها — وأقسام الصورة
 * تُقسم نصفين: صورة تسيل إلى حافة الورقة ونصّ يقابلها.
 */
/**
 * قواعد صفحة الوثيقة — **مصدر واحد** يخدم مسارَي الإخراج معاً.
 *
 * كانت هذه القواعد داخل `@media print` وحدها، فلمّا صار التصدير يلتقط الصفحة
 * بنفسه (لا بحوار الطباعة) لم تكن تنطبق عليه. ونسخُها نسختين يعيد فخّ «المصدر
 * المزدوج» الموثّق في هذا المستودع: تُصلَح واحدة وتبقى الأخرى.
 *
 * وارتفاع الورقة صار متغيّراً لأن `100vh` **لا يساوي ارتفاع A4 عند الطباعة** —
 * قِيس فخرج القسم بنحو ٧٨٪ من الورقة، فظهر شريط فاتح أسفل كل صفحة، و`overflow`
 * حذف ما فاض: بندان كاملان وسطرٌ مشطور في صفحة «المنصّة».
 */
const DOC_RULES = (S: string) => `
  /* الخلفيات والصور جزء من الهوية لا زينة */
  ${S} { min-height: 0 !important; background: #FAF7F0 !important; }

  /* ما لا ينتمي للوثيقة */

  /* عرض الورقة دون عتبة lg فينهار العمودان */
  ${S} .lg\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }

  /* ═══ صفحة كاملة لكل قسم ═══
     ارتفاع مضبوط لا أدنى فلا يتسرّب سطر إلى ورقة تالية،
     وoverflow حارس أخير ضد أي فيض فلا يظهر قطع أبداً. */
  ${S} > section, ${S} > footer {
    break-before: page;
    break-inside: avoid;
    height: var(--pg-h) !important;
    overflow: hidden !important;
    display: flex !important;
    flex-direction: column;
    justify-content: center;
    padding: 0 !important;
    margin: 0 !important;
    max-width: none !important;
    width: 100% !important;
  }
  ${S} > section:first-of-type { break-before: auto; }

  /* قسم الصورة **هو** الشبكة نفسها لا حاوية لها، والقاعدة أعلاه تفرض
     display:flex على كل قسم فتُلغي الشبكة. يُستثنى ليبقى شبكةً — وتوزيعُ
     صفوفها في كتلة «أقسام الصورة» أدناه. */
  ${S} > section[data-split] {
    display: grid !important;
    align-items: stretch !important;
  }

  /* ═══ الأقسام النصّية ═══
     الحشوة على القسم نفسه لا على حاويته الداخلية: بعض الأقسام (العملاء) بلا
     حاوية أصلاً — عنوانها ابن مباشر للقسم — فكانت تلتصق بحافة الورقة وتُقرأ
     كأنها مقطوعة. الخلفية لا تتأثر بالحشوة فتبقى ممتدّة للحافة. */
  ${S} > section:not([data-split]), ${S} > footer { padding: 0 20mm !important; }
  ${S} > section:not([data-split]) > div, ${S} > footer > div {
    width: 100% !important;
    max-width: none !important;
    margin-inline: 0 !important;
    padding: 0 !important;
  }

  /* ═══ أقسام الصورة: شريطٌ عريض أعلى الورقة ونصٌّ تحته ═══
     كانت تُقسم نصفين رأسيّين — وهذا يصلح لشاشةٍ عريضة لا لورقة طوليّة: نصف
     العرض يصير شريطاً طوله ثلاثة أمثال عرضه، فتُقصّ الصورة قصّاً يفسد تكوينها
     (رؤوس مقطوعة) ويمرّ النصّ تحتها لأن حشوته تُلغى. فتُكدَّس: الصورة عريضة
     بنسبةٍ طبيعية، والنصّ تحتها بحشوةٍ تخصّه وحده. */
  ${S} > section[data-split] {
    grid-template-columns: 1fr !important;
    grid-template-rows: 42% 58% !important;
    gap: 0 !important;
    margin: 0 !important;
  }
  ${S} > section[data-split] > div { max-width: none !important; height: auto !important; min-height: 0 !important; }

  /* عمود الصورة يسبق النصّ بصريّاً ويسيل إلى الحوافّ الثلاث */
  ${S} > section[data-split] > div:has(img[data-profile-photo]) {
    order: -1;
    padding: 0 !important;
    overflow: hidden !important;
  }
  /* وعمود النصّ وحده يأخذ حشوته — القاعدة القديمة كانت تخاطب شبكةً **داخل**
     القسم، والقسم نفسه هو الشبكة، فلم تنطبق قطّ وبقي النصّ بلا حشوة. */
  ${S} > section[data-split] > div:not(:has(img[data-profile-photo])) {
    display: flex !important;
    flex-direction: column;
    justify-content: center;
    padding: 0 18mm !important;
  }
  ${S} > section[data-split] img[data-profile-photo] {
    position: absolute !important;
    inset: 0 !important;
    height: 100% !important;
    max-height: none !important;
    width: 100% !important;
    object-fit: cover !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    border: 0 !important;
  }

  /* صورة العملاء لافتة عريضة لا عمود */
  ${S} [data-sec="opportunity"] img[data-profile-photo] { height: calc(var(--pg-h) * 0.4) !important; max-height: none !important; }
  /* خلفيات الأقسام الداكنة تغطّي الورقة كاملة */
  ${S} img[data-backdrop] { height: 100% !important; max-height: none !important; }

  /* عنوان لا يُفصل عن جسمه وبطاقة لا تُشطر */
  ${S} h1, ${S} h2 { break-after: avoid; }
  ${S} .rounded-2xl { break-inside: avoid; }

  /* ═══ مقاسات الورق: تملأ الصفحة ولا تفيض ═══ */
  ${S} h1 { font-size: 34pt !important; line-height: 1.18 !important; }
  ${S} h2 { font-size: 26pt !important; line-height: 1.3 !important; }
  ${S} [data-sec="contact"] h2 { font-size: 40pt !important; line-height: 1.25 !important; }
  ${S} [data-sec="numbers"] .grid p:first-child { font-size: 28pt !important; }

  /* ═══ الأقسام قليلة المحتوى: نملأ الورقة بالتنفّس لا بالفراغ ═══
     صفحة نصفها فارغ تقرأ كخطأ طباعة لا كتصميم — فنكبّر ونباعد بقدر ما تحتمل. */
  ${S} [data-sec="contact"] { padding: 0 26mm !important; }
  ${S} [data-sec="contact"] > div {
    height: var(--pg-h) !important;
    display: flex !important; flex-direction: column; justify-content: center;
  }
  ${S} [data-sec="contact"] > div > .grid {
    margin-top: 34mm !important; gap: 16mm !important; max-width: none !important;
  }
  ${S} [data-sec="contact"] .border-t-2 { padding-top: 9mm !important; }
  ${S} [data-sec="contact"] .grid p:first-child { font-size: 11pt !important; margin-bottom: 3mm !important; }
  ${S} [data-sec="contact"] .grid p:last-child { font-size: 15pt !important; }

  /* بطاقات الأرقام والقوائم تتمدّد عمودياً فتملأ نصيبها من الصفحة */
  ${S} [data-sec="numbers"] .grid > div { padding: 22mm 6mm !important; }
  ${S} [data-sec="solution"] .rounded-2xl,
  /* أسماء الأقسام تغيّرت مع النسخة التسويقية، وبقيت هذه القواعد تخاطب
     «achievements» و«clients» و«goals» — أقساماً لم تعد موجودة. فكانت قواعد
     طباعةٍ تمرّ بلا أثر: تنسيقٌ يبدو مضبوطاً في المصدر وغائب عن الورق. */
  ${S} [data-sec="numbers"] .rounded-2xl,
  ${S} [data-sec="roadmap"] .rounded-2xl { padding: 13mm !important; }
  ${S} [data-sec="opportunity"] .grid > div { padding: 11mm !important; }
  /* بطاقات الشركاء: شعارٌ أكبر ومساحةٌ تتنفّس على الورق */
  ${S} [data-sec="partners"] .grid > div { padding: 10mm 6mm !important; }
  ${S} [data-sec="partners"] img[data-partner-logo] { height: 22mm !important; }
  /* مسافة العنوان عن جسمه تتّسع على الورق فتتنفّس الصفحة */
  ${S} > section:not([data-split]) h2 { margin-bottom: 10mm !important; }
`;

const PRINT_CSS = `
@page { size: A4; margin: 0; }

/* قسم أخفاه المالك لا يُعرض ولا يُطبع — قاعدة عامة لأن قواعد الطباعة تفرض display */
#profile-doc > [hidden] { display: none !important; }

@media print {
  *, *::before, *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  html, body { background: #FAF7F0 !important; margin: 0 !important; }
  .wa-fab, [data-wa-fab], [data-print-hide] { display: none !important; }
  #profile-doc { --pg-h: 297mm; }
${DOC_RULES('#profile-doc')}
}

/* ═══ وضع الالتقاط: نفس القواعد بمقاس A4 بالبكسل (٩٦ نقطة/بوصة) ═══
   يُفعَّل لحظة التصدير ثم يُرفع، فالزائر لا يراه. */
#profile-doc.pdf-capture {
  --pg-h: 1123px;
  width: 794px !important;
  max-width: none !important;
  background: #FAF7F0 !important;
}
#profile-doc.pdf-capture .wa-fab,
#profile-doc.pdf-capture [data-print-hide] { display: none !important; }
${DOC_RULES('#profile-doc.pdf-capture')}
`;

/** عرض ورقة A4 بالبكسل عند ٩٦ نقطة/بوصة — نفس ما يفترضه `.pdf-capture` */
const PAGE_PX_W = 794;

const COLORS = { coral: '#E15A30', ink: '#1F1A13', cream: '#FAF7F0', coralL: '#FBEBE2', gray: '#6E6557', sand: '#E9E1D3', green: '#1E7A52' };
const IMG = (n: string) => `/media/profile/${n}.jpg`;
/**
 * تصدير البروفايل PDF = **طباعة الصفحة نفسها** بلغتها المعروضة.
 *
 * كان الزرّ يخدم ملفاً جاهزاً واحداً في `public`، وحُجّته أن الطباعة تخرج بمقاس
 * ورق المستخدم وقد تسقط صورة لم تُحمَّل. لكنّ الحجّتين سقطتا: `@page { size: A4 }`
 * يفرض المقاس في PRINT_CSS، والصور تُنتظَر صراحةً قبل فتح الحوار.
 *
 * وبقي عيبٌ لا علاج له في الملفّ الجاهز: **ملفٌّ واحد لا يمكن أن يطابق خمس
 * لغات**، ولا يتبع نصّاً يعدّله المالك من لوحته. فكان الزائر التركيّ يقرأ صفحةً
 * بالتركية ثم ينزّل ملفاً عربياً بمحتوى قديم. الطباعة تُلغي الفجوة **بالبناء**:
 * المصدر واحد، فلا مجال لأن يفترقا.
 */
// كل صور الصفحة: ستّ صور <img> وأربع خلفيات أقسام — مصدر واحد للتسخين والتصدير
const PHOTOS = ['cover', 'problem', 'clients', 'about', 'journey', 'achievements', 'goals', 'invest', 'closing'];

/**
 * نصوص الواجهة (العناوين الصغيرة وأسماء الأزرار وبدائل الصور) بلغات المنصّة الخمس.
 *
 * كانت `L(ar, en)` تأخذ نصّين فقط، فأي لغة ثالثة كانت ستقرأ الإنجليزية صامتةً.
 * القاموس يجعل النقص **مرئياً**: مفتاحٌ بلا لغةٍ ما يسقط في الاختبار البنيويّ
 * بدل أن يظهر للزائر التركيّ سطرٌ إنجليزيّ وسط صفحته.
 */
const UI: Record<string, Record<ProfileLang, string>> = {
  pdfName: {
    ar: 'بروفايل Field Sales.pdf', en: 'Field Sales Profile.pdf', fr: 'Profil Field Sales.pdf',
    tr: 'Field Sales Tanitim.pdf', zh: 'Field Sales 公司简介.pdf',
  },
  pdfTitle: {
    ar: 'تنزيل البروفايل PDF', en: 'Download profile PDF', fr: 'Télécharger le profil PDF',
    tr: 'Tanıtım dosyasını PDF indir', zh: '下载 PDF 简介',
  },
  kProfile: { ar: 'الملف التعريفي', en: 'Company profile', fr: 'Profil', tr: 'Tanıtım dosyası', zh: '公司简介' },
  edition: { ar: 'نسخة ٢٠٢٦', en: '2026 edition', fr: 'Édition 2026', tr: '2026 sürümü', zh: '2026 版' },
  audience: {
    ar: 'لشركات التوزيع والمبيعات الميدانية', en: 'For distribution and field sales teams',
    fr: 'Pour la distribution et la vente terrain', tr: 'Dağıtım ve saha satış ekipleri için',
    zh: '面向分销与外勤销售团队',
  },
  kProblem: { ar: 'المشكلة', en: 'The problem', fr: 'Le problème', tr: 'Sorun', zh: '痛点' },
  kSolution: { ar: 'المنصّة', en: 'The platform', fr: 'La plateforme', tr: 'Platform', zh: '平台' },
  kSolve: { ar: 'ما نحلّه', en: 'What we solve', fr: 'Ce que nous résolvons', tr: 'Neyi çözüyoruz', zh: '我们解决什么' },
  kWhy: { ar: 'لماذا نحن', en: 'Why us', fr: 'Pourquoi nous', tr: 'Neden biz', zh: '为什么选择我们' },
  kJourney: { ar: 'الرحلة', en: 'The journey', fr: 'Notre parcours', tr: 'Yolculuk', zh: '发展历程' },
  kModel: { ar: 'الاشتراك', en: 'Pricing', fr: 'Abonnement', tr: 'Abonelik', zh: '订阅方案' },
  kNumbers: { ar: 'أرقامنا', en: 'By the numbers', fr: 'En chiffres', tr: 'Rakamlarla', zh: '数据一览' },
  kRoadmap: { ar: 'قدرات إضافيّة', en: 'Add-ons', fr: 'Options avancées', tr: 'Ek yetenekler', zh: '增值功能' },
  kPartners: { ar: 'شركاء النجاح', en: 'Our partners', fr: 'Nos partenaires', tr: 'İş ortaklarımız', zh: '合作伙伴' },
  kAsk: { ar: 'ابدأ اليوم', en: 'Get started', fr: 'Commencer', tr: 'Hemen başlayın', zh: '立即开始' },
  contactTitle: { ar: 'تواصل معنا', en: 'Get in touch', fr: 'Nous contacter', tr: 'Bize ulaşın', zh: '联系我们' },
  lWebsite: { ar: 'الموقع', en: 'Website', fr: 'Site web', tr: 'Web sitesi', zh: '网站' },
  lEmail: { ar: 'البريد', en: 'Email', fr: 'E-mail', tr: 'E-posta', zh: '邮箱' },
  lLocation: { ar: 'المقر', en: 'Location', fr: 'Siège', tr: 'Merkez', zh: '总部' },
  altProblem: {
    ar: 'دفاتر ورقية متكدسة', en: 'Piles of paper ledgers', fr: 'Des registres papier empilés',
    tr: 'Üst üste yığılmış kâğıt defterler', zh: '堆积如山的纸质账本',
  },
  altClients: {
    ar: 'اسطول سيارات توزيع', en: 'A fleet of delivery vans', fr: 'Une flotte de camionnettes de livraison',
    tr: 'Dağıtım araç filosu', zh: '配送车队',
  },
  altAbout: {
    ar: 'داخل مستودع توزيع', en: 'Inside a distribution warehouse', fr: 'Dans un entrepôt de distribution',
    tr: 'Bir dağıtım deposunun içi', zh: '分销仓库内部',
  },
  altInvest: {
    ar: 'دفع الكتروني على جوال المندوب', en: 'Contactless payment on a rep phone',
    fr: 'Paiement sans contact sur le téléphone du commercial',
    tr: 'Temsilcinin telefonunda temassız ödeme', zh: '在业务员手机上完成刷卡支付',
  },
  docTitle: {
    ar: 'بروفايل Field Sales', en: 'Company Profile — Field Sales', fr: 'Profil — Field Sales',
    tr: 'Tanıtım Dosyası — Field Sales', zh: '公司简介 — Field Sales',
  },
};

export default function ProfilePage() {
  const [lang, setLang] = useState<ProfileLang>('ar');
  const isAr = lang === 'ar';
  const dir = isAr ? 'rtl' : 'ltr';

  const { data: cms } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => (await siteContentApi.get()).data.data as Record<string, unknown> | null,
    staleTime: 300_000,
  });
  const content = mergeProfile(cms?.[PROFILE_CMS_KEY] as Partial<ProfileContent> | undefined);
  const t = content[lang];
  // الشركاء خارج خريطة اللغات: يُرفعون مرّة ويظهرون في اللغات كلّها
  const partners = readPartners(cms);

  /**
   * التصدير: **نبني الملفّ بأنفسنا** — لا نفتح حوار الطباعة.
   *
   * كان الزرّ ينادي `window.print()`، فصار الناتج رهينةَ إعدادات الحوار عند كل
   * زائر: خيار «الرؤوس والتذييلات» يفرض هوامش فتظهر **أطراف بيضاء** ويُطبع
   * رابط الصفحة وتاريخها ورقم الورقة على وثيقةٍ تسويقية. ولا يملك الكود إطفاء
   * ذلك الخيار — فالمخرج لم يكن لنا أصلاً.
   *
   * الآن: نلتقط كل قسم في مقاس A4 ونضعه ورقةً كاملة من الحافة إلى الحافة.
   * المخرج واحد عند كل زائر، بلغته المعروضة، بلا هامش ولا رأس ولا تذييل.
   *
   * والانتظار قبل الالتقاط ليس احتياطاً زائداً: الصور كسولة وخلفيات الأقسام
   * تحت الطيّة، فالتقاطٌ قبل تحميلها يُخرج ورقاً بخانات بيضاء.
   */
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState('');
  const exportPdf = useCallback(async () => {
    setExporting(true);
    try {
      // ① عناصر <img> في الصفحة كسولة وتحت الطيّة: تسخين المورد في الذاكرة
      //    **لا يكفي** — المتصفّح لا يُحمّل الصورة الكسولة حتى تقارب الشاشة،
      //    فتخرج الورقة بخانات بيضاء ولو كان الملفّ محمَّلاً سلفاً. نرفع الكسل
      //    عنها صراحةً ثم ننتظرها هي لا نسخةً منها.
      const domImages = Array.from(
        // وشعارات الشركاء معها: كسولةٌ مثلها، وغيابها يُخرج بطاقاتٍ فارغة
        document.querySelectorAll<HTMLImageElement>(
          '#profile-doc img[data-profile-photo], #profile-doc img[data-partner-logo]'),
      );
      domImages.forEach(im => { im.loading = 'eager'; });

      // ② وخلفيات الأقسام صورٌ في CSS لا عناصر، فتُسخَّن بنسخةٍ في الذاكرة
      const settled = <T,>(p: Promise<T>) => p.catch(() => undefined);
      const withDeadline = (p: Promise<unknown>) =>
        Promise.race([p, new Promise(done => window.setTimeout(done, 6000))]);

      await withDeadline(Promise.all([
        settled(Promise.resolve((document as Document & { fonts?: FontFaceSet }).fonts?.ready)),
        // `complete` وحدها هي الشرط، لا `naturalWidth > 0`: الصورة التي **فشلت**
        // تبقى complete بعرضٍ صفر، ولن يُطلق لها onload ولا onerror مرّةً ثانية —
        // فانتظارها انتظارٌ لحدثٍ وقع وانقضى، يعلّق الزرّ حتى تنقضي المهلة.
        ...domImages.map(im => im.complete
          ? Promise.resolve()
          : new Promise<void>(done => { im.onload = () => done(); im.onerror = () => done(); })),
        ...PHOTOS.map(n => new Promise<void>(done => {
          const warm = new Image();
          warm.onload = () => done();
          warm.onerror = () => done();   // صورة ناقصة لا تمنع التصدير
          warm.src = IMG(n);
        })),
      ]));
      // ③ وضع الالتقاط: مقاس A4 بالبكسل وقواعد الوثيقة نفسها
      const doc = document.getElementById('profile-doc');
      if (!doc) return;
      doc.classList.add('pdf-capture');
      // ريشتان لا واحدة: الأولى تُطبّق الأنماط والثانية تُنهي التخطيط قبل الالتقاط.
      // ومهلةٌ تسابقهما لأن **التبويب المخفيّ لا يُطلق رسم الإطار أصلاً** — رُصد
      // حيّاً: بلا هذا السباق يعلّق التصدير أبداً لمن صدّر من تبويب في الخلفية.
      await Promise.race([
        new Promise<void>(done =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))),
        new Promise<void>(done => window.setTimeout(done, 400)),
      ]);

      try {
        const [{ default: JsPDF }, { default: html2canvas }] = await Promise.all([
          import('jspdf'),
          import('html2canvas'),
        ]);
        const pdf = new JsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
        const pageW = pdf.internal.pageSize.getWidth();
        const pageH = pdf.internal.pageSize.getHeight();

        const pages = Array.from(doc.children).filter(
          el => (el.tagName === 'SECTION' || el.tagName === 'FOOTER')
            && !el.hasAttribute('hidden'),
        ) as HTMLElement[];

        for (let i = 0; i < pages.length; i++) {
          setProgress(`${i + 1}/${pages.length}`);
          const canvas = await html2canvas(pages[i], {
            scale: 2,                 // ضِعف الدقّة: النصّ العربي يبقى حادّاً
            useCORS: true,
            backgroundColor: '#FAF7F0',
            logging: false,
            windowWidth: PAGE_PX_W,
          });
          if (i > 0) pdf.addPage();
          // من الحافة إلى الحافة: لا هامش ولا إطار أبيض
          pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, pageW, pageH);
        }
        pdf.save(UI.pdfName[lang] || UI.pdfName.en);
      } finally {
        doc.classList.remove('pdf-capture');
      }
    } finally {
      setProgress('');
      setExporting(false);
    }
  }, [lang]);

  useEffect(() => {
    document.title = UI.docTitle[lang] || UI.docTitle.en;
  }, [lang]);

  /**
   * تسخين صور الصفحة بعد أول رسم.
   * صور <img> كسولة وخلفيات الأقسام الداكنة تحت الطيّة، فلا يطلبها المتصفح حتى
   * تُرى — وحوار الطباعة لا ينتظر ما لم يُطلب، فكان الملف المصدَّر يخرج بخانات
   * بيضاء وأقسام بلا خلفيتها. نطلبها في وقت الخمول فلا تؤخّر أول رسم.
   */
  useEffect(() => {
    const warm = () => PHOTOS.forEach(n => { const im = new Image(); im.src = IMG(n); });
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (ric) { ric(warm); return; }
    const id = window.setTimeout(warm, 1200);
    return () => window.clearTimeout(id);
  }, []);

  const arFont = "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif";
  const enFont = "'IBM Plex Sans', sans-serif";
  const serif = "'IBM Plex Serif', serif";
  const cjkFont = `'PingFang SC','Microsoft YaHei','Noto Sans SC',${enFont}`;
  const font = isAr ? arFont : lang === 'zh' ? cjkFont : enFont;
  const headFont = isAr ? arFont : lang === 'zh' ? cjkFont : serif;

  // نصّ الواجهة بلغة العرض؛ والإنجليزية شبكة أمان لو نقص مفتاحٌ يوماً
  const L = (k: keyof typeof UI) => UI[k][lang] || UI[k].en;

  const Wordmark = ({ dark }: { dark?: boolean }) => (
    <span style={{ fontFamily: serif, fontWeight: 700 }}>
      <span style={{ color: dark ? COLORS.cream : COLORS.ink }}>Field</span>
      <span style={{ color: COLORS.coral }}> Sales</span>
    </span>
  );

  const Kicker = ({ children }: { children: React.ReactNode }) => (
    <div className="flex items-center gap-2.5 font-bold text-sm" style={{ color: COLORS.coral }}>
      <span className="inline-block h-1 w-9 rounded-full" style={{ background: COLORS.coral }} />
      <span>{children}</span>
    </div>
  );

  /**
   * ارتفاع السطر يُضبط في `style` لا بصنف تايلويند.
   *
   * أصناف الحجم (`text-5xl`) تحمل معها `line-height: 1`، وتغلب `leading-*`
   * حسب ترتيب الورقة. ونسبةُ ١٫٠ تكفي اللاتينية ولا تكفي العربية: قِيس على
   * الصفحة الحيّة أن سطرَي عنوان بحجم ٤٨ بكسل **يتداخلان ٤٤ بكسل** — تصعد
   * ألفات السطر الثاني في نزول السطر الأول. والقيمة في `style` تفوز دائماً.
   */
  const H2 = ({ children, dark }: { children: React.ReactNode; dark?: boolean }) => (
    <h2 className="mt-3 text-3xl sm:text-5xl font-bold" style={{ color: dark ? COLORS.cream : COLORS.ink, fontFamily: headFont, lineHeight: 1.4 }}>
      {children}
    </h2>
  );

  const Lines = ({ text, dark, size = 'text-lg' }: { text: string; dark?: boolean; size?: string }) => (
    <div className={`mt-5 ${size} leading-loose`} style={{ color: dark ? 'rgba(250,247,240,.78)' : COLORS.gray }}>
      {splitLines(text).map((l, i) => <p key={i}>{l}</p>)}
    </div>
  );

  const Photo = ({ name, alt, h = 'h-64 sm:h-80' }: { name: string; alt: string; h?: string }) => (
    <img src={IMG(name)} alt={alt} loading="lazy" data-profile-photo=""
      className={`w-full ${h} object-cover rounded-2xl`}
      style={{ border: `1px solid ${COLORS.sand}`, boxShadow: '0 10px 30px rgba(31,26,19,.10)' }} />
  );

  /**
   * خلفية القسم الداكن: الصورة **عنصر img** لا خلفية CSS.
   * حوار الطباعة يُسقط خلفيات CSS حين لا يُفعّل الطابع خيار «رسوم الخلفية»،
   * بينما صور المحتوى تُطبع دائماً — فكانت صورة الغلاف تختفي من الملف المصدَّر.
   * طبقة التعتيم تبقى فوقها كي يظل النص الفاتح مقروءاً كما على الشاشة.
   */
  const Backdrop = ({ name, grad }: { name: string; grad: string }) => (
    <>
      <img src={IMG(name)} alt="" aria-hidden="true" data-profile-photo="" data-backdrop=""
        className="absolute inset-0 w-full h-full object-cover" style={{ zIndex: 0 }} />
      <span aria-hidden="true" className="absolute inset-0" style={{ zIndex: 1, background: grad }} />
    </>
  );
  const dim = (o: number) => `linear-gradient(rgba(31,26,19,${o}), rgba(31,26,19,${Math.min(1, o + 0.05)}))`;

  // إظهار الأقسام كما ضبطها المالك — الغياب يعني الظهور
  const on = (k: string) => sectionOn(content, k);

  /**
   * ترقيم البطاقات بأرقام اللغة المعروضة.
   *
   * تُشتقّ من الرقم لا من جدول محارف ثابت: الجدول الثابت («١٢٣»[i]) ينهار صامتاً
   * حين يضيف المالك بنداً رابعاً — يخرج `undefined` فتظهر بطاقة بلا رقم.
   */
  const num1 = (n: number) => (isAr ? n.toLocaleString('ar-EG') : String(n));
  const num2 = (n: number) => (isAr ? n.toLocaleString('ar-EG').padStart(2, '٠') : String(n).padStart(2, '0'));


  return (
    <div id="profile-doc" dir={dir} lang={lang} className="min-h-screen" style={{ background: COLORS.cream, fontFamily: font }}>
      <style>{PRINT_CSS}</style>

      {/* الشريط العلوي: الشعار + مبدل اللغة + تنزيل الملف */}
      <header className="sticky top-0 z-40 border-b print:hidden" style={{ background: 'rgba(250,247,240,.92)', backdropFilter: 'blur(8px)', borderColor: COLORS.sand }}>
        {/* صفٌّ واحد لا يلتفّ كان يفيض على الجوّال: خمسة أزرار لغة + زرّ التنزيل
            + العلامة أعرض من ٣٩٠ بكسل، فيُدفع **زرّ التنزيل** خارج الشاشة —
            وهو الزرّ الوحيد الذي لا بديل عنه. فيلتفّ الرأس صفّين على الضيّق:
            العلامة والتنزيل معاً أولاً، واللغات تحتهما. */}
        <div className="max-w-6xl mx-auto px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2">
          <a href="/" className="flex items-center gap-2.5 shrink-0">
            <BrandIcon size={32} radius={0.28} />
            <span className="text-lg whitespace-nowrap"><Wordmark /></span>
          </a>
          <button type="button" onClick={exportPdf} disabled={exporting}
            title={L('pdfTitle')} aria-label={L('pdfTitle')}
            className="shrink-0 ms-auto order-2 sm:order-3 sm:ms-0 px-3.5 py-1.5 rounded-xl text-sm font-bold inline-flex items-center gap-1.5 disabled:opacity-60"
            style={{ background: COLORS.ink, color: COLORS.cream }}>
            <Download size={14} />
            {exporting ? (progress || '…') : 'PDF'}
          </button>
          <div className="order-3 sm:order-2 w-full sm:w-auto sm:ms-auto flex justify-center">
            {/* والمبدّل نفسه يمرّر أفقياً عند الحاجة فلا يقصّ لغةً مهما ضاقت الشاشة */}
            <div className="flex rounded-xl p-0.5 max-w-full overflow-x-auto" style={{ background: '#F3EDE3' }}>
              {PROFILE_LANGS.map(l => (
                <button key={l} onClick={() => setLang(l)} lang={l}
                  className="px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-bold transition-colors whitespace-nowrap"
                  style={lang === l ? { background: '#fff', color: COLORS.coral, boxShadow: '0 1px 3px rgba(0,0,0,.08)' } : { color: COLORS.gray }}>
                  {PROFILE_LANG_LABEL[l]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* ═══ ١ الغلاف — صورة كاملة والنصّ على جهة التدرّج الداكن ═══ */}
      <section data-sec="cover" className="relative overflow-hidden" style={{ backgroundColor: COLORS.ink }}>
        <Backdrop name="cover" grad={`linear-gradient(${isAr ? '90deg' : '270deg'}, rgba(31,26,19,.25) 0%, rgba(31,26,19,.72) 46%, rgba(31,26,19,.95) 100%)`} />
        <div className="relative z-[2] max-w-6xl mx-auto px-4 pt-24 pb-10 sm:pt-36 sm:pb-14">
          <div className="max-w-2xl" style={{ marginInlineEnd: 'auto' }}>
            <Kicker>{L('kProfile')}</Kicker>
            <h1 className="mt-4 text-3xl sm:text-5xl font-bold" style={{ color: COLORS.cream, fontFamily: headFont, lineHeight: 1.35 }}>
              {t.cover_title}
            </h1>
            <div className="mt-5 text-base sm:text-xl leading-relaxed" style={{ color: 'rgba(250,247,240,.82)' }}>
              {splitLines(t.cover_promise).map((l, i) => <p key={i}>{l}</p>)}
            </div>
          </div>
        </div>
        <div className="relative z-[2] max-w-6xl mx-auto px-4 pb-6 flex flex-wrap justify-between gap-3 text-xs" style={{ color: 'rgba(250,247,240,.55)' }}>
          <span>
            <span style={{ color: COLORS.coral, fontWeight: 700, fontFamily: enFont }}>{t.contact_website}</span>
            {' · '}{L('edition')}
          </span>
          <span>{L('audience')}</span>
        </div>
      </section>

      {/* ═══ ٢ المشكلة — الصورة نصفٌ والنصّ نصف ═══ */}
      <section data-sec="problem" data-split="" hidden={!on('problem')} className="grid lg:grid-cols-2 items-stretch">
        <div className="flex items-center px-4 sm:px-10 py-14 sm:py-24 order-2 lg:order-none">
          <div className="max-w-xl mx-auto w-full">
            <Kicker>{L('kProblem')}</Kicker>
            <H2>{t.problem_title}</H2>
            <Lines text={t.problem_body} size="text-base sm:text-lg" />
          </div>
        </div>
        <div className="relative min-h-[240px] lg:min-h-[520px] order-1 lg:order-none">
          <img src={IMG('problem')} alt={L('altProblem')} loading="lazy" data-profile-photo=""
            className="absolute inset-0 w-full h-full object-cover" />
        </div>
      </section>

      {/* ═══ ٣ الحل — داكن ببطاقتين ═══ */}
      <section data-sec="solution" hidden={!on('solution')} style={{ background: COLORS.ink }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker>{L('kSolution')}</Kicker>
          <H2 dark>{t.solution_title}</H2>
          <div className="mt-8 grid sm:grid-cols-2 gap-6">
            {[{ h: t.solution_col1_title, c: t.solution_col1 }, { h: t.solution_col2_title, c: t.solution_col2 }].map((col, ci) => (
              <div key={ci} className="rounded-2xl p-6 sm:p-7" style={{ background: 'rgba(250,247,240,.06)', border: '1px solid rgba(250,247,240,.14)' }}>
                <p className="font-bold text-lg sm:text-xl mb-4" style={{ color: COLORS.cream, fontFamily: headFont }}>{col.h}</p>
                {splitLines(col.c).map((l, i) => (
                  <p key={i} className="flex items-start gap-3 text-sm sm:text-base leading-loose" style={{ color: 'rgba(250,247,240,.85)' }}>
                    <span className="mt-3 inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: COLORS.coral }} />
                    <span>{l}</span>
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ ٤ الفرصة — لافتة صورة أعلى ثم ثلاث بطاقات ═══ */}
      <section data-sec="opportunity" hidden={!on('opportunity')}>
        <div className="relative h-52 sm:h-80 overflow-hidden">
          <img src={IMG('clients')} alt={L('altClients')} loading="lazy" data-profile-photo=""
            className="absolute inset-0 w-full h-full object-cover" />
          <span aria-hidden="true" className="absolute inset-0"
            style={{ background: `linear-gradient(rgba(31,26,19,.42), rgba(31,26,19,0) 32%), linear-gradient(rgba(250,247,240,0) 55%, ${COLORS.cream} 100%)` }} />
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-16 sm:pb-24">
          <Kicker>{L('kSolve')}</Kicker>
          <H2>{t.opportunity_title}</H2>
          <Lines text={t.opportunity_intro} size="text-base sm:text-lg" />
          <div className="mt-8 grid sm:grid-cols-3 gap-5">
            {splitLines(t.opportunity_items).map((s, i) => (
              <div key={i} className="rounded-2xl bg-white p-6 text-sm sm:text-base leading-relaxed"
                style={{ border: `1px solid ${COLORS.sand}`, color: COLORS.ink }}>
                <span className="block mb-3 text-2xl font-bold" style={{ color: COLORS.coral, fontFamily: headFont }}>{num2(i + 1)}</span>
                {s}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ ٥ لماذا نحن — النصّ نصفٌ والصورة نصف ═══ */}
      <section data-sec="why" data-split="" hidden={!on('why')} className="grid lg:grid-cols-2 items-stretch">
        <div className="relative min-h-[240px] lg:min-h-[520px] order-1 lg:order-none">
          <img src={IMG('about')} alt={L('altAbout')} loading="lazy" data-profile-photo=""
            className="absolute inset-0 w-full h-full object-cover" />
        </div>
        <div className="flex items-center px-4 sm:px-10 py-14 sm:py-24 order-2 lg:order-none">
          <div className="max-w-xl mx-auto w-full">
            <Kicker>{L('kWhy')}</Kicker>
            <H2>{t.why_title}</H2>
            <Lines text={t.why_body} size="text-base sm:text-lg" />
          </div>
        </div>
      </section>

      {/* ═══ ٦ الرحلة — خطّ زمنيّ أفقيّ ═══ */}
      <section data-sec="journey" hidden={!on('journey')} className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
        <Kicker>{L('kJourney')}</Kicker>
        <H2>{t.journey_title}</H2>
        <div className="mt-12 relative">
          {/* الخطّ يمرّ خلف النقاط — على الشاشات الواسعة وحدها */}
          <span aria-hidden="true" className="hidden sm:block absolute h-0.5 rounded-full"
            style={{ background: COLORS.sand, top: 9, insetInlineStart: '12%', insetInlineEnd: '12%' }} />
          <div className="grid sm:grid-cols-4 gap-8 sm:gap-5 relative">
            {splitPairs(t.journey_stations).map((st, i, arr) => {
              const last = i === arr.length - 1;
              return (
                <div key={i} className="flex sm:block gap-4">
                  <div className="flex sm:block flex-col items-center">
                    <span className="block w-5 h-5 rounded-full shrink-0"
                      style={{ background: last ? COLORS.ink : COLORS.coral, border: `4px solid ${COLORS.cream}`, boxShadow: `0 0 0 2px ${last ? COLORS.ink : COLORS.coral}` }} />
                    <span className="sm:hidden w-0.5 flex-1 mt-1" style={{ background: COLORS.sand }} />
                  </div>
                  <div className="sm:mt-5 pb-4 sm:pb-0">
                    <p className="font-bold text-base sm:text-lg" style={{ color: last ? COLORS.ink : COLORS.coral }}>{st.a}</p>
                    <p className="text-sm sm:text-base mt-1 leading-relaxed" style={{ color: COLORS.ink }}>{st.b}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══ ٧ نموذج العمل — خلفية داكنة بثلاث بطاقات ═══ */}
      <section data-sec="model" hidden={!on('model')} className="relative overflow-hidden" style={{ background: COLORS.ink }}>
        <Backdrop name="achievements" grad={dim(0.88)} />
        <div className="relative z-[2] max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker>{L('kModel')}</Kicker>
          <H2 dark>{t.model_title}</H2>
          <div className="mt-8 grid sm:grid-cols-3 gap-5">
            {splitLines(t.model_items).map((a, i) => (
              <div key={i} className="rounded-2xl p-6" style={{ background: 'rgba(250,247,240,.06)', border: '1px solid rgba(250,247,240,.14)' }}>
                <span className="block mb-3 text-3xl font-bold" style={{ color: COLORS.coral, fontFamily: headFont }}>{num1(i + 1)}</span>
                <p className="text-sm sm:text-base leading-relaxed" style={{ color: 'rgba(250,247,240,.88)' }}>{a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ ٨ الانجاز — مرجانيّ بأربع بطاقات بيضاء ═══ */}
      <section data-sec="numbers" hidden={!on('numbers')} style={{ background: COLORS.coral }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <div className="flex items-center gap-2.5 font-bold text-sm" style={{ color: COLORS.cream }}>
            <span className="inline-block h-1 w-9 rounded-full" style={{ background: COLORS.cream }} />
            {L('kNumbers')}
          </div>
          <h2 className="mt-3 text-3xl sm:text-5xl font-bold" style={{ color: COLORS.cream, fontFamily: headFont, lineHeight: 1.4 }}>{t.numbers_title}</h2>
          <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-5">
            {splitPairs(t.numbers_items).map((n, i) => (
              <div key={i} className="rounded-2xl bg-white p-6 sm:p-8 text-center">
                <p className="text-3xl sm:text-5xl font-bold" style={{ color: COLORS.ink, fontFamily: headFont, lineHeight: 1.25 }}>{n.a}</p>
                <p className="mt-3 text-xs sm:text-sm leading-relaxed" style={{ color: COLORS.gray }}>{n.b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ ٩ خارطة الطريق — خلفية داكنة ببطاقات مزدوجة ═══ */}
      <section data-sec="roadmap" hidden={!on('roadmap')} className="relative overflow-hidden" style={{ background: COLORS.ink }}>
        <Backdrop name="goals" grad={dim(0.9)} />
        <div className="relative z-[2] max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker>{L('kRoadmap')}</Kicker>
          <H2 dark>{t.roadmap_title}</H2>
          <div className="mt-8 grid sm:grid-cols-2 gap-5">
            {splitLines(t.roadmap_items).map((g, i) => (
              <div key={i} className="rounded-2xl p-6 flex gap-5 items-start" style={{ background: 'rgba(250,247,240,.06)', border: '1px solid rgba(250,247,240,.14)' }}>
                <span className="text-3xl sm:text-4xl font-bold leading-none" style={{ color: COLORS.coral, fontFamily: headFont }}>{num1(i + 1)}</span>
                <p className="text-sm sm:text-base leading-relaxed" style={{ color: 'rgba(250,247,240,.92)' }}>{g}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ ١٠ الطلب الاستثماري — النصّ نصفٌ والصورة نصف ═══ */}
      <section data-sec="ask" data-split="" hidden={!on('ask')} className="grid lg:grid-cols-2 items-stretch">
        <div className="relative min-h-[240px] lg:min-h-[520px] order-1 lg:order-none">
          <img src={IMG('invest')} alt={L('altInvest')} loading="lazy" data-profile-photo=""
            className="absolute inset-0 w-full h-full object-cover" />
        </div>
        <div className="flex items-center px-4 sm:px-10 py-14 sm:py-24 order-2 lg:order-none">
          <div className="max-w-xl mx-auto w-full">
            <Kicker>{L('kAsk')}</Kicker>
            <H2>{t.ask_title}</H2>
            <div className="mt-8 grid gap-4">
              {splitLines(t.ask_items).map((tr, i) => (
                <div key={i} className="rounded-2xl bg-white p-4 sm:p-5 flex items-center gap-4 text-sm sm:text-base leading-relaxed"
                  style={{ border: `1px solid ${COLORS.sand}`, color: COLORS.ink }}>
                  <span className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center font-bold"
                    style={{ background: COLORS.coralL, color: COLORS.coral, fontFamily: headFont }}>{num1(i + 1)}</span>
                  {tr}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══ ١١ شركاء النجاح ═══
          لا يُعرض القسم بلا شركاء: صفحةٌ عنوانها «شركاؤنا» وتحتها فراغ تقرأ
          كوعدٍ لم يُوفَ، وتخرج ورقةً بيضاء في الملفّ المصدَّر. */}
      {partners.length > 0 && (
      <section data-sec="partners" hidden={!on('partners')} style={{ background: COLORS.cream }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <div className="flex flex-col items-center text-center">
            <Kicker>{L('kPartners')}</Kicker>
            <h2 className="mt-3 text-3xl sm:text-5xl font-bold" style={{ color: COLORS.ink, fontFamily: headFont, lineHeight: 1.35 }}>
              {t.partners_title}
            </h2>
          </div>
          <div className="mt-10 sm:mt-14 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
            {partners.map((p, i) => (
              <div key={i} className="rounded-2xl bg-white flex flex-col items-center justify-center gap-3 px-4 py-7"
                style={{ border: `1px solid ${COLORS.sand}` }}>
                {p.logo && (
                  /* `contain` لا `cover`: شعارٌ مقصوص أسوأ من شعارٍ صغير */
                  <img src={p.logo} alt={p.name} data-partner-logo=""
                    className="h-12 sm:h-14 w-full object-contain" loading="lazy" />
                )}
                {p.name && (
                  <p className="text-sm font-bold text-center leading-snug"
                    style={{ color: COLORS.ink, fontFamily: font }}>{p.name}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
      )}

      {/* ═══ ١٢ التواصل ═══ */}
      <section data-sec="contact" hidden={!on('contact')} style={{ background: COLORS.coralL }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24 text-center">
          <h2 className="text-3xl sm:text-5xl font-bold" style={{ color: COLORS.ink, fontFamily: headFont, lineHeight: 1.4 }}>{L('contactTitle')}</h2>
          <div className="mt-8 grid sm:grid-cols-3 gap-6 max-w-3xl mx-auto">
            {[
              { label: L('lWebsite'), value: t.contact_website, coral: true, latin: true },
              { label: L('lEmail'), value: t.contact_email, latin: true },
              { label: L('lLocation'), value: t.contact_location },
            ].map((c, i) => (
              <div key={i} className="border-t-2 pt-4" style={{ borderColor: COLORS.ink }}>
                <p className="text-xs mb-1" style={{ color: COLORS.gray }}>{c.label}</p>
                <p className="font-bold text-base" dir={c.latin ? 'ltr' : dir}
                  style={{ color: c.coral ? COLORS.coral : COLORS.ink, fontFamily: c.latin ? enFont : font }}>
                  {c.value}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ ١٢ الختام — أفق الرياض ═══ */}
      <footer data-sec="closing" className="relative overflow-hidden" style={{ background: COLORS.ink }}>
        <Backdrop name="closing" grad={dim(0.85)} />
        <div className="relative z-[2] max-w-6xl mx-auto px-4 py-20 sm:py-28 text-center">
          <div className="flex justify-center mb-5"><BrandIcon size={64} radius={0.28} /></div>
          <p className="text-3xl mb-4" style={{ lineHeight: 1.25 }}><Wordmark dark /></p>
          <h2 className="text-2xl sm:text-4xl font-bold mb-4" style={{ color: COLORS.cream, fontFamily: headFont, lineHeight: 1.4 }}>{t.closing_title}</h2>
          <div className="text-base sm:text-lg leading-loose" style={{ color: 'rgba(250,247,240,.7)' }}>
            {splitLines(t.closing_line).map((l, i) => <p key={i}>{l}</p>)}
          </div>
          <div className="mt-6 flex justify-center gap-6 text-sm" style={{ fontFamily: enFont }}>
            <span style={{ color: COLORS.coral, fontWeight: 700 }}>{t.contact_website}</span>
            <span style={{ color: 'rgba(250,247,240,.65)' }}>{t.contact_email}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
