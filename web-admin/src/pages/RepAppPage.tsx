import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, Globe, WifiOff, Receipt, MapPin, Printer, ScanLine, type LucideIcon } from 'lucide-react';
import { useSeo } from '../lib/seo';
import { seoUrls } from '../i18n/locale';
// @ts-ignore -- لا ملف تعريف للوحدة بعد (clusters.d.mts)؛ الأنواع مثبّتة بالتحويل أدناه
import * as clustersMod from '../blog/clusters.mjs';

/**
 * صفحة تنزيل تطبيق المندوب — fieldsa.net/rep-app
 *
 * تُفتح من رابط «تطبيق المندوب» في ترويسة الموقع وتذييله بدل الذهاب مباشرةً لشاشة
 * الدخول: المندوب الجديد يحتاج **تنزيل** التطبيق لا تسجيل الدخول في المتصفح.
 *
 * الروابط تُقرأ من CMS (لوحة المالك ← محتوى الموقع ← «تطبيق المندوب») لا من الكود،
 * فحين توافق Google على النشر العلني يكفي أن يلصق المالك الرابط ليصير الشعار فعّالاً
 * — بلا نشر جديد. ورابط فارغ يعني «قريباً» فلا يُعرض للمستخدم رابط ميّت.
 */

type Faq = { q: string; a: string };
type Section = { h2: string; paras?: string[]; sub: { h3: string; p: string }[]; link: { href: string; label: string } };
/**
 * نصوص الصفحة من clusters.mjs — المصدر نفسه الذي يصيّره prerender.mjs للزاحف (P7). كانت هنا نسخة ثانية
 * تَعِد «البيع والتحصيل يستمران في المناطق المقطوعة»، والتطبيق يمنع الفاتورة (القياسية والمبسطة) والمرتجع
 * دون اتصال للشركات المفعّل لها ربط المرحلة الثانية (RepApp.tsx).
 */
const { REP_APP, REP_APP_STORES, repAppSections, repAppJsonLd } = clustersMod as {
  REP_APP: {
    title: string; description: string; h1: string; intro: string; offline: string;
    cards: { key: string; title: string; desc: string }[]; faq: Faq[];
  };
  REP_APP_STORES: { play: string; apple: string };
  repAppSections: () => Section[];
  repAppJsonLd: (canonical: string) => object;
};

// روابط المتجرين الفعلية — هي المصدر حين لا يضبطها المالك من CMS.
// (لا تكفي القيمة في defaultContent: تلك يدمجها قالب الهبوط وحده، وهذه الصفحة
//  تقرأ استجابة CMS مباشرةً — فلزم أن تحمل بدائلها بنفسها.)
// حقل مضبوط في CMS يعلو عليها؛ وحقل **مُفرَّغ عمداً** يعيد الشعار إلى وسم «قريباً».
const FALLBACK_APPLE = REP_APP_STORES.apple;
const FALLBACK_PLAY = REP_APP_STORES.play;

const CARD_ICON: Record<string, LucideIcon> = {
  invoice: Receipt, offline: WifiOff, scan: ScanLine, visit: MapPin, print: Printer, stock: Globe,
};
const SECTIONS = repAppSections();

/** شعار App Store — رسم داخليّ (الصفحة مكتفية بذاتها بلا أصول خارجية) */
function AppleBadge({ muted }: { muted?: boolean }) {
  return (
    <svg width="180" height="56" viewBox="0 0 180 56" direction="ltr" role="img" aria-label="App Store">
      <rect width="180" height="56" rx="11" fill={muted ? '#8E8A82' : '#1F1A13'} />
      <g transform="translate(18, 15) scale(1.08)" fill="#fff">
        <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </g>
      <text x="52" y="24" textAnchor="start" fill="#fff" fontSize="11.5" fontFamily="'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif">متوفر على</text>
      <text x="52" y="43" textAnchor="start" fill="#fff" fontSize="19" fontWeight="600" fontFamily="'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif">App&#160;Store</text>
    </svg>
  );
}

/** شعار Google Play — رسم داخليّ بنفس البنية */
function PlayBadge({ muted }: { muted?: boolean }) {
  const dim = muted ? 0.45 : 1;
  return (
    <svg width="180" height="56" viewBox="0 0 180 56" direction="ltr" role="img" aria-label="Google Play">
      <rect width="180" height="56" rx="11" fill={muted ? '#8E8A82' : '#1F1A13'} />
      <g transform="translate(18, 15) scale(1.08)" opacity={dim}>
        <path d="M3.18 2.28a1.5 1.5 0 0 0-.35.97v17.5c0 .37.13.7.35.97L12.5 12 3.18 2.28z" fill="#00C3FF" />
        <path d="M3.18 2.28L12.5 12l3.78-3.44L5.2 2.1c-.72-.41-1.5-.31-2.02.18z" fill="#00E676" />
        <path d="M16.28 15.44L12.5 12l3.78-3.44 3.6 2.05c.9.51.9 1.78 0 2.29l-3.6 2.54z" fill="#FFD500" />
        <path d="M3.18 21.72c.52.49 1.3.59 2.02.18l11.08-6.46L12.5 12 3.18 21.72z" fill="#FF3A44" />
      </g>
      <text x="52" y="24" textAnchor="start" fill="#fff" fontSize="11.5" fontFamily="'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif">احصل عليه من</text>
      <text x="52" y="43" textAnchor="start" fill="#fff" fontSize="19" fontWeight="600" fontFamily="'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif">Google&#160;Play</text>
    </svg>
  );
}

/**
 * شعار متجر: رابط فعّال متى ضُبط رابطه، وإلا شعار خافت موسوم «قريباً».
 * رابط ميّت أسوأ من انتظار معلن — والمستخدم يجد بديلاً عاملاً أسفل الشعارين.
 */
function StoreLink({ url, store, Badge }: { url: string; store: string; Badge: (p: { muted?: boolean }) => JSX.Element }) {
  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" aria-label={`تنزيل من ${store}`} className="inline-block transition-transform hover:-translate-y-1">
        <Badge />
      </a>
    );
  }
  return (
    <div className="relative inline-block cursor-default" aria-label={`${store} قريبا`} title={`قريبا على ${store}`}>
      <Badge muted />
      <span className="absolute -top-2 -left-2 bg-[#E15A30] text-white text-[11px] font-bold px-2.5 py-1 rounded-full shadow">
        قريبا
      </span>
    </div>
  );
}

export default function RepAppPage() {
  const { data } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const res = await siteContentApi.get(); return res.data.data as Record<string, unknown>; },
  });

  // العنوان والوصف وFAQPage مطابقة للمُصيَّر — كان العنوان «تنزيل تطبيق المندوب Field Sales» بعد الإقلاع
  const { canonical } = seoUrls('/rep-app', 'ar');
  const canonicalSlash = canonical.endsWith('/') ? canonical : `${canonical}/`;
  useSeo({
    title: REP_APP.title,
    description: REP_APP.description,
    canonical: canonicalSlash,
    locale: 'ar',
    image: 'https://fieldsa.net/og-image.png',
    jsonLd: repAppJsonLd(canonicalSlash),
  });

  const repApp = (data?.repApp as Record<string, string> | undefined) || {};
  const appleUrl = (repApp.appStoreUrl ?? FALLBACK_APPLE).trim();
  const playUrl = (repApp.playUrl ?? FALLBACK_PLAY).trim();

  return (
    <div dir="rtl" className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif" }}>
      {/* ترويسة */}
      <header className="border-b border-[#E9E1D3] bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-5 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandIcon size={28} />
            <span className="font-bold text-[15px]">Field Sales</span>
          </Link>
          <Link to="/" className="text-sm text-[#6E6557] hover:text-[#1F1A13] flex items-center gap-1.5">
            الرئيسية <ArrowLeft size={15} />
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-5 py-12 sm:py-16">
        {/* البطل: الأيقونة + الاسم + الشعارات */}
        <section className="text-center">
          <img
            src="/icons/icon-512.png"
            alt="تطبيق المندوب"
            width={104}
            height={104}
            className="mx-auto rounded-[24px] shadow-[0_14px_36px_rgba(31,26,19,.16)]"
          />
          <h1 className="text-[26px] sm:text-[34px] font-extrabold mt-6 tracking-tight leading-snug max-w-2xl mx-auto">{REP_APP.h1}</h1>
          <p className="text-[#6E6557] mt-3 max-w-xl mx-auto leading-relaxed">{REP_APP.intro}</p>
          <p className="text-[#6E6557] mt-2 max-w-xl mx-auto leading-relaxed text-[14px]">{REP_APP.offline}</p>

          {/* الشعاران */}
          <div className="flex flex-wrap items-center justify-center gap-3.5 mt-9">
            <StoreLink url={appleUrl} store="App Store" Badge={AppleBadge} />
            <StoreLink url={playUrl} store="Google Play" Badge={PlayBadge} />
          </div>

          {/* فتح مباشر من المتصفح — يعمل على كل جهاز اليوم */}
          <div className="mt-8">
            <Link
              to="/rep"
              className="inline-flex items-center gap-2 bg-white border border-[#E9E1D3] hover:border-[#E8C9BC] text-[#1F1A13] font-bold text-sm px-6 py-3.5 rounded-xl transition-colors"
            >
              <Globe size={16} className="text-[#E15A30]" />
              افتح التطبيق من المتصفح
            </Link>
            <p className="text-[12.5px] text-[#9A8F7E] mt-2.5">
              يعمل على أي جهاز بلا تنزيل ويمكن تثبيته على الشاشة الرئيسية من قائمة المتصفح
            </p>
          </div>
        </section>

        {/* ماذا يفعل التطبيق */}
        <section className="mt-16 sm:mt-20">
          <h2 className="text-[22px] font-bold text-center">ماذا يفعل المندوب من جواله</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-8">
            {REP_APP.cards.map((f) => {
              const Icon = CARD_ICON[f.key] || Receipt;
              return (
                <div key={f.key} className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
                  <div className="w-10 h-10 rounded-xl bg-[#FBEBE2] flex items-center justify-center mb-3.5">
                    <Icon size={18} className="text-[#E15A30]" />
                  </div>
                  <h3 className="font-bold text-[15px] mb-1.5">{f.title}</h3>
                  <p className="text-[13.5px] text-[#6E6557] leading-relaxed">{f.desc}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* كيف يعمل كل جزء — من features.mjs (مكتوبة من الكود) عبر clusters.mjs */}
        <section className="mt-14 space-y-8 max-w-3xl mx-auto">
          {SECTIONS.map((s) => (
            <div key={s.h2}>
              <h2 className="text-[20px] font-bold">{s.h2}</h2>
              {(s.paras || []).map((p) => <p key={p} className="text-[14.5px] text-[#3a342b] mt-2 leading-relaxed">{p}</p>)}
              {s.sub.map((x) => (
                <div key={x.h3} className="mt-3">
                  <h3 className="font-semibold text-[15px]">{x.h3}</h3>
                  <p className="text-[14px] text-[#6E6557] mt-1 leading-relaxed">{x.p}</p>
                </div>
              ))}
              <Link to={s.link.href} className="inline-block mt-2 text-[14px] font-semibold text-[#C94E28] hover:underline">{s.link.label}</Link>
            </div>
          ))}
        </section>

        {/* أسئلة شائعة — ظاهرة لأن FAQPage في سكيما الصفحة لا تصحّ إلا لأسئلة يراها الزائر */}
        <section className="mt-14 max-w-3xl mx-auto">
          <h2 className="text-[20px] font-bold">أسئلة شائعة</h2>
          <div className="mt-4 space-y-3">
            {REP_APP.faq.map((f) => (
              <div key={f.q} className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
                <h3 className="font-bold text-[15px]">{f.q}</h3>
                <p className="text-[14px] text-[#6E6557] mt-1.5 leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* كيف يدخل المندوب */}
        <section className="mt-14 bg-[#1F1A13] rounded-2xl p-7 sm:p-9 text-center relative overflow-hidden">
          <div
            className="absolute -top-16 -right-16 w-56 h-56 rounded-full"
            style={{ background: 'radial-gradient(circle, rgba(225,90,48,.3), transparent 65%)' }}
          />
          <div className="relative">
            <h2 className="text-white text-[20px] font-bold">بيانات الدخول من مدير الشركة</h2>
            <p className="text-[#C9C2B6] text-[14px] mt-2.5 max-w-lg mx-auto leading-relaxed">
              التطبيق للمناديب المسجلين فقط ينشئ مدير الشركة حساب المندوب من لوحة الإدارة
              ويسلمه اسم المستخدم وكلمة المرور لا يوجد تسجيل ذاتي
            </p>
            <Link
              to="/signup"
              className="inline-block bg-[#E15A30] hover:bg-[#C94E28] text-white text-sm font-bold px-6 py-3 rounded-xl mt-6 transition-colors"
            >
              شركتك ليست مشتركة بعد ابدأ مجانا
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-[#E9E1D3] py-8 text-center text-[13px] text-[#9A8F7E]">
        <Link to="/" className="hover:text-[#1F1A13]">Field Sales</Link>
        <span className="mx-2">·</span>
        <Link to="/tutorial" className="hover:text-[#1F1A13]">دليل الاستخدام</Link>
      </footer>
    </div>
  );
}
