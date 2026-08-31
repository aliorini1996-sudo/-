import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { Download } from 'lucide-react';
import { BrandIcon } from '../components/BrandLogo';
import { mergeProfile, splitLines, splitPairs, sectionOn, ProfileLang, ProfileContent } from '../content/profileContent';

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
const PRINT_CSS = `
@page { size: A4; margin: 0; }

/* قسم أخفاه المالك لا يُعرض ولا يُطبع — قاعدة عامة لأن قواعد الطباعة تفرض display */
#profile-doc > [hidden] { display: none !important; }

@media print {
  /* الخلفيات والصور جزء من الهوية لا زينة */
  *, *::before, *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  html, body { background: #FAF7F0 !important; margin: 0 !important; }
  #profile-doc { min-height: 0 !important; background: #FAF7F0 !important; }

  /* ما لا ينتمي للوثيقة */
  .wa-fab, [data-wa-fab], [data-print-hide] { display: none !important; }

  /* عرض الورقة دون عتبة lg فينهار العمودان */
  #profile-doc .lg\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }

  /* ═══ صفحة كاملة لكل قسم ═══
     ارتفاع مضبوط لا أدنى فلا يتسرّب سطر إلى ورقة تالية،
     وoverflow حارس أخير ضد أي فيض فلا يظهر قطع أبداً. */
  #profile-doc > section, #profile-doc > footer {
    break-before: page;
    break-inside: avoid;
    height: 100vh !important;
    max-height: 100vh !important;
    overflow: hidden !important;
    display: flex !important;
    flex-direction: column;
    justify-content: center;
    padding: 0 !important;
    margin: 0 !important;
    max-width: none !important;
    width: 100% !important;
  }
  #profile-doc > section:first-of-type { break-before: auto; }

  /* ═══ الأقسام النصّية ═══
     الحشوة على القسم نفسه لا على حاويته الداخلية: بعض الأقسام (العملاء) بلا
     حاوية أصلاً — عنوانها ابن مباشر للقسم — فكانت تلتصق بحافة الورقة وتُقرأ
     كأنها مقطوعة. الخلفية لا تتأثر بالحشوة فتبقى ممتدّة للحافة. */
  #profile-doc > section:not([data-split]), #profile-doc > footer { padding: 0 20mm !important; }
  #profile-doc > section:not([data-split]) > div, #profile-doc > footer > div {
    width: 100% !important;
    max-width: none !important;
    margin-inline: 0 !important;
    padding: 0 !important;
  }

  /* ═══ أقسام الصورة: نصف صورة سائلة للحافة ونصف نصّ ═══ */
  #profile-doc > section[data-split] > div { padding: 0 !important; max-width: none !important; height: 100vh !important; }
  #profile-doc > section[data-split] .lg\\:grid-cols-2 {
    height: 100vh !important;
    gap: 0 !important;
    align-items: stretch !important;
    margin: 0 !important;
  }
  #profile-doc > section[data-split] .lg\\:grid-cols-2 > div {
    display: flex !important;
    flex-direction: column;
    justify-content: center;
    padding: 0 16mm !important;
  }
  #profile-doc > section[data-split] img[data-profile-photo] {
    height: 100vh !important;
    max-height: none !important;
    width: 100% !important;
    object-fit: cover !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    border: 0 !important;
  }

  /* صورة العملاء لافتة عريضة لا عمود */
  #profile-doc [data-sec="clients"] img[data-profile-photo] { height: 40vh !important; max-height: none !important; }
  /* خلفيات الأقسام الداكنة تغطّي الورقة كاملة */
  #profile-doc img[data-backdrop] { height: 100% !important; max-height: none !important; }

  /* عنوان لا يُفصل عن جسمه وبطاقة لا تُشطر */
  #profile-doc h1, #profile-doc h2 { break-after: avoid; }
  #profile-doc .rounded-2xl { break-inside: avoid; }

  /* ═══ مقاسات الورق: تملأ الصفحة ولا تفيض ═══ */
  #profile-doc h1 { font-size: 34pt !important; line-height: 1.18 !important; }
  #profile-doc h2 { font-size: 26pt !important; line-height: 1.3 !important; }
  #profile-doc [data-sec="contact"] h2 { font-size: 40pt !important; line-height: 1.25 !important; }
  #profile-doc [data-sec="numbers"] .grid p:first-child { font-size: 28pt !important; }

  /* ═══ الأقسام قليلة المحتوى: نملأ الورقة بالتنفّس لا بالفراغ ═══
     صفحة نصفها فارغ تقرأ كخطأ طباعة لا كتصميم — فنكبّر ونباعد بقدر ما تحتمل. */
  #profile-doc [data-sec="contact"] { padding: 0 26mm !important; }
  #profile-doc [data-sec="contact"] > div {
    height: 100vh !important;
    display: flex !important; flex-direction: column; justify-content: center;
  }
  #profile-doc [data-sec="contact"] > div > .grid {
    margin-top: 34mm !important; gap: 16mm !important; max-width: none !important;
  }
  #profile-doc [data-sec="contact"] .border-t-2 { padding-top: 9mm !important; }
  #profile-doc [data-sec="contact"] .grid p:first-child { font-size: 11pt !important; margin-bottom: 3mm !important; }
  #profile-doc [data-sec="contact"] .grid p:last-child { font-size: 15pt !important; }

  /* بطاقات الأرقام والقوائم تتمدّد عمودياً فتملأ نصيبها من الصفحة */
  #profile-doc [data-sec="numbers"] .grid > div { padding: 22mm 6mm !important; }
  #profile-doc [data-sec="solution"] .rounded-2xl,
  #profile-doc [data-sec="achievements"] .rounded-2xl,
  #profile-doc [data-sec="goals"] .rounded-2xl { padding: 13mm !important; }
  #profile-doc [data-sec="clients"] .grid > div { padding: 11mm !important; }
  /* مسافة العنوان عن جسمه تتّسع على الورق فتتنفّس الصفحة */
  #profile-doc > section:not([data-split]) h2 { margin-bottom: 10mm !important; }
}
`;

const COLORS = { coral: '#E15A30', ink: '#1F1A13', cream: '#FAF7F0', coralL: '#FBEBE2', gray: '#6E6557', sand: '#E9E1D3', green: '#1E7A52' };
const IMG = (n: string) => `/media/profile/${n}.jpg`;
/**
 * ملفّ البروفايل الجاهز — نسخة مصمَّمة بمقاس عرضيّ 16:9 يُنزّلها الزائر كما هي.
 *
 * ولماذا ملفّ جاهز لا `window.print()` على الصفحة نفسها: الطباعة تخرج بمقاس
 * ورق المستخدم وبإعدادات طابعته، فتختلف النتيجة من جهاز لجهاز، وقد تسقط صورةٌ
 * لم تُحمَّل بعد. والملفّ في `public` أي أصل ثابت يُخدَم قبل التحويل العام
 * للـSPA (كما يُخدَم `privacy.html` اليوم).
 */
const PROFILE_PDF = '/fieldsales-profile.pdf';
// كل صور الصفحة: ستّ صور <img> وأربع خلفيات أقسام — مصدر واحد للتسخين والتصدير
const PHOTOS = ['cover', 'problem', 'clients', 'about', 'journey', 'achievements', 'goals', 'invest', 'closing'];

export default function ProfilePage() {
  const [lang, setLang] = useState<ProfileLang>('ar');
  const isAr = lang === 'ar';
  const dir = isAr ? 'rtl' : 'ltr';

  const { data: cms } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => (await siteContentApi.get()).data.data as { profile?: Partial<ProfileContent> } | null,
    staleTime: 300_000,
  });
  const content = mergeProfile(cms?.profile);
  const t = content[lang];

  useEffect(() => {
    document.title = isAr ? 'بروفايل Field Sales' : 'Company Profile — Field Sales';
  }, [isAr]);

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
  const font = isAr ? arFont : enFont;
  const headFont = isAr ? arFont : serif;

  const L = (ar: string, en: string) => (isAr ? ar : en);

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

  const H2 = ({ children, dark }: { children: React.ReactNode; dark?: boolean }) => (
    <h2 className="mt-3 text-3xl sm:text-5xl font-bold leading-snug" style={{ color: dark ? COLORS.cream : COLORS.ink, fontFamily: headFont }}>
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

  return (
    <div id="profile-doc" dir={dir} className="min-h-screen" style={{ background: COLORS.cream, fontFamily: font }}>
      <style>{PRINT_CSS}</style>

      {/* الشريط العلوي: الشعار + مبدل اللغة + طباعة */}
      <header className="sticky top-0 z-40 border-b print:hidden" style={{ background: 'rgba(250,247,240,.92)', backdropFilter: 'blur(8px)', borderColor: COLORS.sand }}>
        <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <BrandIcon size={32} radius={0.28} />
            <span className="text-lg"><Wordmark /></span>
          </a>
          <div className="flex items-center gap-2">
            <div className="flex rounded-xl p-0.5" style={{ background: '#F3EDE3' }}>
              {(['ar', 'en'] as ProfileLang[]).map(l => (
                <button key={l} onClick={() => setLang(l)}
                  className="px-3.5 py-1.5 rounded-lg text-sm font-bold transition-colors"
                  style={lang === l ? { background: '#fff', color: COLORS.coral, boxShadow: '0 1px 3px rgba(0,0,0,.08)' } : { color: COLORS.gray }}>
                  {l === 'ar' ? 'عربي' : 'EN'}
                </button>
              ))}
            </div>
            {/* الملفّ الجاهز لا طباعةُ الصفحة: نسخة مصمَّمة بمقاس عرضيّ 16:9
                يقرؤها المتلقّي كما هي على أي جهاز، ولا تتغيّر بمقاس نافذته ولا
                بإعدادات طابعته. والصفحة تبقى للقراءة على الشاشة. */}
            <a href={PROFILE_PDF} download={L('بروفايل Field Sales.pdf', 'Field Sales Profile.pdf')}
              title={L('تنزيل البروفايل PDF', 'Download profile PDF')}
              className="px-3.5 py-1.5 rounded-xl text-sm font-bold inline-flex items-center gap-1.5"
              style={{ background: COLORS.ink, color: COLORS.cream }}>
              <Download size={14} />
              PDF
            </a>
          </div>
        </div>
      </header>

      {/* ١ الغلاف — صورة المندوب خلفية بتدرج داكن جهة النص */}
      <section data-sec="cover" className="relative overflow-hidden" style={{ backgroundColor: COLORS.ink }}>
        <Backdrop name="cover" grad={`linear-gradient(${isAr ? '270deg' : '90deg'}, rgba(31,26,19,.35) 0%, rgba(31,26,19,.78) 45%, rgba(31,26,19,.96) 100%)`} />
        <div className="relative z-[2] max-w-6xl mx-auto px-4 py-24 sm:py-32">
          <Kicker>{L('الملف التعريفي', 'Company profile')}</Kicker>
          <h1 className="mt-4 text-4xl sm:text-6xl font-bold leading-tight max-w-3xl" style={{ color: COLORS.cream, fontFamily: headFont }}>
            {t.cover_title}
          </h1>
          <div className="mt-6 text-lg sm:text-2xl leading-relaxed" style={{ color: 'rgba(250,247,240,.8)' }}>
            {splitLines(t.cover_promise).map((l, i) => <p key={i}>{l}</p>)}
          </div>
          <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm" style={{ color: 'rgba(250,247,240,.6)' }}>
            <span style={{ color: COLORS.coral, fontWeight: 700, fontFamily: enFont }}>fieldsa.net</span>
            <span>{L('نسخة ٢٠٢٦', '2026 edition')}</span>
            <span>{L('معد لشركات التوزيع', 'Prepared for distribution companies')}</span>
          </div>
        </div>
      </section>

      {/* ٢ المشكلة — نص + صورة الدفاتر */}
      <section data-sec="problem" data-split="" hidden={!on('problem')} className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
        <div className="grid lg:grid-cols-2 gap-10 items-center">
          <div>
            <Kicker>{L('المشكلة', 'The problem')}</Kicker>
            <H2>{t.problem_title}</H2>
            <Lines text={t.problem_body} size="text-lg sm:text-xl" />
          </div>
          <Photo name="problem" alt={L('دفاتر ورقية متكدسة', 'Piles of paper ledgers')} />
        </div>
      </section>

      {/* ٣ الحل */}
      <section data-sec="solution" hidden={!on('solution')} style={{ background: COLORS.ink }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker>{L('الحل', 'The solution')}</Kicker>
          <H2 dark>{t.solution_title}</H2>
          <div className="mt-8 grid sm:grid-cols-2 gap-8">
            {[t.solution_col1, t.solution_col2].map((col, ci) => (
              <div key={ci} className="rounded-2xl p-6" style={{ background: 'rgba(250,247,240,.05)', border: '1px solid rgba(250,247,240,.12)' }}>
                {splitLines(col).map((l, i) => (
                  <p key={i} className="flex items-start gap-3 text-base sm:text-lg leading-loose" style={{ color: 'rgba(250,247,240,.85)' }}>
                    <span className="mt-3 inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: COLORS.coral }} />
                    <span>{l}</span>
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ٤ العملاء — صورة الاسطول لافتة ثم البطاقات */}
      <section data-sec="clients" hidden={!on('clients')} className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
        <Kicker>{L('العملاء', 'Our clients')}</Kicker>
        <H2>{t.clients_title}</H2>
        <Lines text={t.clients_intro} />
        <div className="mt-8">
          <Photo name="clients" alt={L('اسطول سيارات توزيع', 'A fleet of delivery vans')} h="h-56 sm:h-72" />
        </div>
        <div className="mt-6 grid sm:grid-cols-3 gap-5">
          {splitLines(t.clients_sectors).map((s, i) => (
            <div key={i} className="rounded-2xl bg-white p-6 text-base leading-relaxed" style={{ border: `1px solid ${COLORS.sand}`, color: COLORS.ink }}>
              <span className="block mb-3 text-2xl font-bold" style={{ color: COLORS.coral, fontFamily: headFont }}>{isAr ? '٠' + '١٢٣'[i] : `0${i + 1}`}</span>
              {s}
            </div>
          ))}
        </div>
      </section>

      {/* ٥ من نحن — نص + صورة التسليم */}
      <section data-sec="about" data-split="" hidden={!on('about')} style={{ background: COLORS.coralL }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <div className="grid lg:grid-cols-2 gap-10 items-center">
            <div>
              <Kicker>{L('من نحن', 'Who we are')}</Kicker>
              <H2>{t.about_title}</H2>
              <Lines text={t.about_body} size="text-lg sm:text-xl" />
            </div>
            <Photo name="about" alt={L('مندوب يسلم بضاعة لعميل', 'A rep handing goods to a customer')} />
          </div>
        </div>
      </section>

      {/* ٦ الرحلة — الخط الزمني + صورة المستودع */}
      <section data-sec="journey" data-split="" hidden={!on('journey')} className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
        <div className="grid lg:grid-cols-2 gap-10 items-center">
          <div>
            <Kicker>{L('الرحلة', 'The journey')}</Kicker>
            <H2>{t.journey_title}</H2>
            <div className="mt-10 grid gap-0">
              {splitPairs(t.journey_stations).map((st, i, arr) => (
                <div key={i} className="flex gap-5">
                  <div className="flex flex-col items-center">
                    <span className="w-4 h-4 rounded-full shrink-0" style={{ background: COLORS.coral }} />
                    {i < arr.length - 1 && <span className="w-0.5 flex-1" style={{ background: COLORS.sand }} />}
                  </div>
                  <div className="pb-8 -mt-1">
                    <p className="font-bold text-lg" style={{ color: COLORS.coral }}>{st.a}</p>
                    <p className="text-base sm:text-lg mt-0.5" style={{ color: COLORS.ink }}>{st.b}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Photo name="journey" alt={L('داخل مستودع توزيع', 'Inside a distribution warehouse')} h="h-72 sm:h-96" />
        </div>
      </section>

      {/* ٧ الانجازات — خلفية طرق المدينة ليلا */}
      <section data-sec="achievements" hidden={!on('achievements')} className="relative overflow-hidden" style={{ background: COLORS.ink }}>
        <Backdrop name="achievements" grad={dim(0.88)} />
        <div className="relative z-[2] max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker>{L('الجاهز اليوم', 'Ready today')}</Kicker>
          <H2 dark>{t.achievements_title}</H2>
          <div className="mt-8 grid sm:grid-cols-3 gap-5">
            {splitLines(t.achievements_items).map((a, i) => (
              <div key={i} className="rounded-2xl p-6" style={{ background: 'rgba(250,247,240,.06)', border: '1px solid rgba(250,247,240,.14)' }}>
                <span className="block mb-3 text-3xl font-bold" style={{ color: COLORS.coral, fontFamily: headFont }}>{isAr ? '١٢٣'[i] : i + 1}</span>
                <p className="text-base leading-relaxed" style={{ color: 'rgba(250,247,240,.88)' }}>{a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ٨ الارقام */}
      <section data-sec="numbers" hidden={!on('numbers')} style={{ background: COLORS.coral }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <div className="flex items-center gap-2.5 font-bold text-sm" style={{ color: COLORS.cream }}>
            <span className="inline-block h-1 w-9 rounded-full" style={{ background: COLORS.cream }} />
            {L('الارقام', 'The numbers')}
          </div>
          <h2 className="mt-3 text-3xl sm:text-5xl font-bold" style={{ color: COLORS.cream, fontFamily: headFont }}>{t.numbers_title}</h2>
          <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-5">
            {splitPairs(t.numbers_items).map((n, i) => (
              <div key={i} className="rounded-2xl bg-white p-6 text-center">
                <p className="text-4xl sm:text-5xl font-bold" style={{ color: COLORS.ink, fontFamily: headFont }}>{n.a}</p>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: COLORS.gray }}>{n.b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ٩ اهداف المستقبل — خلفية سلسلة الامداد الذكية */}
      <section data-sec="goals" hidden={!on('goals')} className="relative overflow-hidden" style={{ background: COLORS.ink }}>
        <Backdrop name="goals" grad={dim(0.9)} />
        <div className="relative z-[2] max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker>{L('خارطة الطريق', 'Roadmap')}</Kicker>
          <H2 dark>{t.goals_title}</H2>
          <div className="mt-8 grid sm:grid-cols-2 gap-5">
            {splitLines(t.goals_items).map((g, i) => (
              <div key={i} className="rounded-2xl p-6 flex gap-5 items-start" style={{ background: 'rgba(250,247,240,.06)', border: '1px solid rgba(250,247,240,.14)' }}>
                <span className="text-4xl sm:text-5xl font-bold leading-none" style={{ color: COLORS.coral, fontFamily: headFont }}>{isAr ? '١٢٣٤'[i] : i + 1}</span>
                <p className="text-base sm:text-lg leading-relaxed" style={{ color: 'rgba(250,247,240,.92)' }}>{g}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ١٠ الاستثمار — نص + صورة الدفع بالبطاقة */}
      <section data-sec="invest" data-split="" hidden={!on('invest')} className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
        <div className="grid lg:grid-cols-2 gap-10 items-center">
          <div>
            <Kicker>{L('البدء معنا', 'Getting started')}</Kicker>
            <H2>{t.invest_title}</H2>
            <div className="mt-8 grid gap-4">
              {splitLines(t.invest_tracks).map((tr, i) => (
                <div key={i} className="rounded-2xl bg-white p-5 flex items-center gap-4 text-base leading-relaxed" style={{ border: `1px solid ${COLORS.sand}`, color: COLORS.ink }}>
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: COLORS.coral }} />
                  {tr}
                </div>
              ))}
            </div>
          </div>
          <Photo name="invest" alt={L('دفع الكتروني على جوال المندوب', 'Contactless payment on a rep phone')} />
        </div>
      </section>

      {/* ١١ تواصل معنا */}
      <section data-sec="contact" hidden={!on('contact')} style={{ background: COLORS.coralL }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24 text-center">
          <h2 className="text-3xl sm:text-5xl font-bold" style={{ color: COLORS.ink, fontFamily: headFont }}>{t.contact_title}</h2>
          <div className="mt-8 grid sm:grid-cols-3 gap-6 max-w-3xl mx-auto">
            {[
              { label: L('الموقع', 'Website'), value: t.contact_website, coral: true, latin: true },
              { label: L('البريد', 'Email'), value: t.contact_email, latin: true },
              { label: L('المقر', 'Location'), value: t.contact_location },
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

      {/* ١٢ الختام — خلفية افق الرياض */}
      <footer data-sec="closing" className="relative overflow-hidden" style={{ background: COLORS.ink }}>
        <Backdrop name="closing" grad={dim(0.85)} />
        <div className="relative z-[2] max-w-6xl mx-auto px-4 py-16 sm:py-20 text-center">
          <div className="flex justify-center mb-5"><BrandIcon size={64} radius={0.28} /></div>
          <p className="text-3xl mb-4"><Wordmark dark /></p>
          <div className="text-base sm:text-lg leading-loose" style={{ color: 'rgba(250,247,240,.7)' }}>
            {splitLines(t.closing_line).map((l, i) => <p key={i}>{l}</p>)}
          </div>
          <div className="mt-6 flex justify-center gap-6 text-sm" style={{ fontFamily: enFont }}>
            <span style={{ color: COLORS.coral, fontWeight: 700 }}>fieldsa.net</span>
            <span style={{ color: 'rgba(250,247,240,.65)' }}>help@fieldsa.net</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
