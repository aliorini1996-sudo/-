import { Link, useLocation } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, BadgePercent, Briefcase, Building2, CalendarClock, Check, CheckCircle2, ChevronDown, Copy,
  FlaskConical, Images, Languages, Link2, LogIn, Megaphone, Share2, Smartphone, User, UserPlus, Wallet, Zap,
  type LucideIcon,
} from 'lucide-react';
import { BrandIcon } from '../components/BrandLogo';
import LanguageToggle from '../components/LanguageToggle';
import { localeFromPath, pathForLocale, seoUrls } from '../i18n/locale';
import { useSeo } from '../lib/seo';
import {
  AMBASSADORS_JOIN, AMBASSADORS_LANGS, AMBASSADORS_LANG_LABEL, AMBASSADORS_LOGIN, AMBASSADORS_PATH, AMBASSADORS_TEXT,
  ambassadorsJsonLd, ambassadorsPathFor, type AmbLang,
} from './ambassadorsText';

/**
 * الصفحة العلنية «سفراء فيلد سيلز» (V2_SPEC §9، طلب المالك ١٨ نوفمبر ٢٠٢٦) — مفهرسة بثلاث لغات (ع/إ/فر).
 * النصوص كلها من ambassadorsText.ts — المصدر نفسه الذي يكتب منه prerender العنوان والوصف والجسم وFAQPage.
 * لغة الصفحة من مسارها لا من مخزن اللغة: الرأس (lang وcanonical وhreflang) يطابق ما صُيِّر مسبقاً من أول رسم.
 * الأزرار إلى /ambassadors/join و/ambassadors/login وحدهما (يحوّلهما App.tsx إلى البوابة) — مسار البوابة نفسه
 * لا يُذكر في الصفحات العامة (affiliate/hiding.test.ts).
 */

const FONT = "'IBM Plex Sans Arabic', 'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif";
const AR_DIGITS = ['١', '٢', '٣'];

const STEP_ICONS: LucideIcon[] = [UserPlus, Share2, Wallet];
const WHY_ICONS: LucideIcon[] = [Zap, BadgePercent, CalendarClock];
const TOOL_ICONS: LucideIcon[] = [Link2, UserPlus, FlaskConical, Images, Smartphone, Languages];
const WHO_ICONS: LucideIcon[] = [User, Building2, Megaphone, Briefcase];

/** لغة الصفحة من مسارها: المسارات المسجّلة ثلاثية، وأي لغة أخرى (لا مسار لها) تسقط إلى الإنجليزية */
function pageLang(pathname: string): AmbLang {
  const l = localeFromPath(pathname);
  return l === 'ar' || l === 'fr' ? l : 'en';
}

/** H1 بجزئه المرجاني (النسبة) — النصّ نفسه حرفياً الذي يكتبه prerender */
function Headline({ text, accent }: { text: string; accent: string }) {
  const i = text.indexOf(accent);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="text-[#E15A30] whitespace-nowrap">{accent}</span>
      {text.slice(i + accent.length)}
    </>
  );
}

export default function AmbassadorsPage() {
  const { pathname } = useLocation();
  const L = pageLang(pathname);
  const t = AMBASSADORS_TEXT[L];
  const dir = L === 'ar' ? 'rtl' : 'ltr';
  const Fwd = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const num = (i: number) => (L === 'ar' ? AR_DIGITS[i] : String(i + 1));
  const home = pathForLocale('/', L);
  const contact = pathForLocale('/contact', L);

  const seoUrl = seoUrls(AMBASSADORS_PATH, L);
  useSeo({
    title: t.seoTitle, description: t.seoDesc, keywords: t.keywords, locale: L,
    canonical: seoUrl.canonical, alternates: seoUrl.alternates, image: 'https://fieldsa.net/og-image.png',
    jsonLd: ambassadorsJsonLd(L),
  });

  const primaryBtn = 'inline-flex items-center justify-center gap-2 rounded-2xl bg-[#E15A30] hover:bg-[#C94B24] text-white font-bold transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-[#E15A30]/30';

  return (
    <div dir={dir} lang={L} data-ambassadors-page="" className="min-h-screen bg-[#FAF7F0] text-[#1F1A13] overflow-x-hidden" style={{ fontFamily: FONT }}>
      {/* ── الرأس ── */}
      <header className="sticky top-0 z-40 bg-[#FAF7F0]/90 backdrop-blur border-b border-[#E9E1D3]/70">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-2">
          <Link to={home} className="flex items-center gap-2.5 min-w-0" aria-label={t.home}>
            <BrandIcon size={32} />
            <span className="hidden min-[400px]:inline text-lg sm:text-xl whitespace-nowrap" dir="ltr" style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, letterSpacing: '-0.3px' }}>
              <span className="text-[#1F1A13]">Field</span> <span className="text-[#E15A30]">Sales</span>
            </span>
          </Link>
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            <Link to={AMBASSADORS_LOGIN} className="hidden sm:inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#6E6557] hover:text-[#1F1A13] px-3 py-2 rounded-xl hover:bg-black/5">
              <LogIn size={15} />{t.loginShort}
            </Link>
            <LanguageToggle />
            <Link to={AMBASSADORS_JOIN} data-amb-join="header" className={`${primaryBtn} text-[13px] px-3.5 py-2 rounded-xl`}>{t.cta}</Link>
          </div>
        </div>
      </header>

      <main>
        {/* ── البطل ── */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-8 sm:pt-14 pb-12 sm:pb-16 grid lg:grid-cols-[1.1fr_0.9fr] gap-10 lg:gap-14 items-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-[#FBEBE2] text-[#B5431F] text-[13px] font-bold px-3.5 py-1.5">
              <BadgePercent size={16} />{t.eyebrow}
            </span>
            <h1 className="mt-5 text-[32px] leading-[1.25] sm:text-5xl sm:leading-[1.18] font-extrabold tracking-tight">
              <Headline text={t.h1} accent={t.h1Accent} />
            </h1>
            <p className="mt-5 text-[16px] sm:text-lg leading-relaxed text-[#5C5347] max-w-xl">{t.lead}</p>
            <div className="mt-7 flex flex-col sm:flex-row sm:items-center gap-3">
              <Link to={AMBASSADORS_JOIN} data-amb-join="hero" className={`${primaryBtn} h-14 px-8 text-[17px] w-full sm:w-auto shadow-[0_14px_30px_rgba(225,90,48,0.28)]`}>
                {t.cta}<Fwd size={19} />
              </Link>
              <Link to={AMBASSADORS_LOGIN} className="inline-flex items-center justify-center gap-1.5 h-12 px-5 rounded-2xl text-[15px] font-semibold text-[#1F1A13] hover:bg-black/5">
                <LogIn size={16} />{t.login}
              </Link>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-[13px] text-[#6E6557]">
              <CheckCircle2 size={15} className="text-[#1E7A52] shrink-0" />{t.ctaNote}
            </p>
            <ul className="mt-8 grid grid-cols-3 gap-2 sm:gap-3">
              {t.stats.map((s) => (
                <li key={s.v} className="bg-white rounded-2xl border border-[#E9E1D3] px-2.5 py-3.5 sm:p-4 text-center">
                  <div className="text-xl sm:text-2xl font-extrabold text-[#1F1A13] whitespace-nowrap">{s.v}</div>
                  <div className="mt-1 text-[11.5px] sm:text-[13px] leading-snug text-[#6E6557]">{s.l}</div>
                </li>
              ))}
            </ul>
          </div>

          {/* بطاقة توضيحية لِما يراه السفير فور تسجيله (زخرفة لا بيانات) */}
          <div aria-hidden="true" className="relative mx-auto w-full max-w-[420px]">
            <div className="absolute -inset-3 sm:-inset-5 rounded-[36px] bg-[#E15A30]/10 rotate-[-3deg]" />
            <div className="relative rounded-[28px] bg-[#1F1A13] text-[#FAF7F0] p-5 sm:p-6 shadow-[0_30px_60px_rgba(31,26,19,0.25)]">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-[#C9BFAE]">{t.card.title}</span>
                <span className="w-8 h-8 rounded-xl bg-[#E15A30] flex items-center justify-center"><Link2 size={16} /></span>
              </div>
              <div dir="ltr" className="mt-3 rounded-2xl bg-white/5 border border-white/10 px-4 py-3 font-mono text-[13px] sm:text-sm text-[#FAF7F0] truncate">
                fieldsa.net/signup?ref=K7M2Q9XR
              </div>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                <span className="h-11 rounded-xl bg-[#E15A30] flex items-center justify-center gap-2 text-sm font-bold"><Share2 size={16} />{t.card.share}</span>
                <span className="h-11 px-4 rounded-xl border border-white/15 flex items-center justify-center gap-1.5 text-sm font-semibold"><Copy size={15} />{t.card.copy}</span>
              </div>
              <div className="mt-5 rounded-2xl bg-[#FAF7F0] text-[#1F1A13] p-4 flex items-center gap-4">
                <span className="text-4xl font-extrabold text-[#E15A30] whitespace-nowrap">{t.card.earnTitle}</span>
                <span className="text-[13px] leading-snug text-[#5C5347]">{t.card.earnBody}</span>
              </div>
              <ol className="mt-5 space-y-2.5">
                {t.card.steps.map((s, i) => (
                  <li key={s} className="flex items-center gap-3 text-sm">
                    <span className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${i === 0 ? 'bg-[#1E7A52] text-white' : 'border border-white/25 text-[#C9BFAE]'}`}>
                      {i === 0 ? <Check size={15} /> : num(i)}
                    </span>
                    <span className={i === 0 ? 'text-[#FAF7F0]' : 'text-[#C9BFAE]'}>{s}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* ── الخطوات ── */}
        <section className="bg-white border-y border-[#EFE8DA]">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20">
            <div className="text-center max-w-2xl mx-auto">
              <h2 className="text-2xl sm:text-4xl font-extrabold">{t.stepsTitle}</h2>
              <p className="mt-3 text-[#6E6557]">{t.stepsSub}</p>
            </div>
            <ol className="mt-10 grid gap-4 md:grid-cols-3">
              {t.steps.map((s, i) => {
                const Icon = STEP_ICONS[i] || Share2;
                return (
                  <li key={s.t} className="relative rounded-3xl bg-[#FAF7F0] border border-[#EFE8DA] p-6">
                    <div className="flex items-center gap-3">
                      <span className="w-10 h-10 rounded-full bg-[#E15A30] text-white font-extrabold flex items-center justify-center text-lg">{num(i)}</span>
                      <Icon size={22} className="text-[#E15A30]" />
                    </div>
                    <h3 className="mt-4 text-lg font-bold">{s.t}</h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-[#5C5347]">{s.d}</p>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        {/* ── لماذا ── */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20">
          <h2 className="text-2xl sm:text-4xl font-extrabold text-center">{t.whyTitle}</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {t.why.map((w, i) => {
              const Icon = WHY_ICONS[i] || Zap;
              return (
                <div key={w.t} className="rounded-3xl bg-white border border-[#E9E1D3] p-6">
                  <span className="w-12 h-12 rounded-2xl bg-[#FBEBE2] flex items-center justify-center"><Icon size={24} className="text-[#E15A30]" /></span>
                  <h3 className="mt-4 text-lg font-bold">{w.t}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-[#5C5347]">{w.d}</p>
                </div>
              );
            })}
          </div>

          <h2 className="mt-16 text-xl sm:text-3xl font-extrabold text-center">{t.toolsTitle}</h2>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {t.tools.map((x, i) => {
              const Icon = TOOL_ICONS[i] || Link2;
              return (
                <li key={x.t} className="flex items-start gap-3.5 rounded-2xl bg-white border border-[#E9E1D3] p-4">
                  <span className="w-11 h-11 rounded-xl bg-[#1F1A13] flex items-center justify-center shrink-0"><Icon size={20} className="text-[#FAF7F0]" /></span>
                  <div className="min-w-0">
                    <h3 className="font-bold text-[15px]">{x.t}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-[#5C5347]">{x.d}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* ── لمن ── */}
        <section className="bg-[#F3EEE5]">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20">
            <div className="text-center max-w-2xl mx-auto">
              <h2 className="text-2xl sm:text-4xl font-extrabold">{t.whoTitle}</h2>
              <p className="mt-3 text-[#6E6557]">{t.whoSub}</p>
            </div>
            <ul className="mt-10 grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {t.who.map((w, i) => {
                const Icon = WHO_ICONS[i] || User;
                return (
                  <li key={w.t} className="rounded-3xl bg-white border border-[#E9E1D3] p-4 sm:p-6">
                    <span className="w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-[#FBEBE2] flex items-center justify-center"><Icon size={22} className="text-[#E15A30]" /></span>
                    <h3 className="mt-3 sm:mt-4 font-bold text-[15px] sm:text-lg">{w.t}</h3>
                    <p className="mt-1.5 text-[13px] sm:text-[15px] leading-relaxed text-[#5C5347]">{w.d}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        {/* ── الأسئلة الشائعة (details: تعمل بلا JavaScript، والإجابات في الصفحة لـFAQPage) ── */}
        <section className="max-w-3xl mx-auto px-4 sm:px-6 py-14 sm:py-20">
          <h2 className="text-2xl sm:text-4xl font-extrabold text-center">{t.faqTitle}</h2>
          <div className="mt-8 space-y-3">
            {t.faq.map((f, i) => (
              <details key={f.q} className="group rounded-2xl bg-white border border-[#E9E1D3] open:border-[#E15A30]/40 open:shadow-[0_10px_30px_rgba(31,26,19,0.06)]" open={i === 0}>
                <summary className="flex items-center justify-between gap-3 cursor-pointer list-none px-5 py-4 font-bold text-[15px] sm:text-base [&::-webkit-details-marker]:hidden">
                  <h3 className="font-bold">{f.q}</h3>
                  <ChevronDown size={18} className="text-[#9A8F7E] shrink-0 transition-transform group-open:rotate-180" />
                </summary>
                <p className="px-5 pb-5 -mt-1 text-[15px] leading-relaxed text-[#5C5347]">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ── الدعوة الأخيرة ── */}
        <section className="px-4 sm:px-6 pb-14 sm:pb-20">
          <div className="max-w-5xl mx-auto rounded-[32px] bg-[#1F1A13] text-[#FAF7F0] px-6 py-12 sm:px-12 sm:py-16 text-center relative overflow-hidden">
            <div aria-hidden="true" className="absolute -top-20 -end-20 w-64 h-64 rounded-full bg-[#E15A30]/20" />
            <h2 className="relative text-2xl sm:text-4xl font-extrabold">{t.finalTitle}</h2>
            <p className="relative mt-3 text-[#C9BFAE]">{t.finalBody}</p>
            <div className="relative mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link to={AMBASSADORS_JOIN} data-amb-join="final" className={`${primaryBtn} h-14 px-10 text-[17px] w-full sm:w-auto`}>
                {t.finalCta}<Fwd size={19} />
              </Link>
              <Link to={AMBASSADORS_LOGIN} className="inline-flex items-center gap-1.5 h-12 px-5 rounded-2xl text-[15px] font-semibold text-[#FAF7F0] hover:bg-white/10">
                <LogIn size={16} />{t.login}
              </Link>
            </div>
            <p className="relative mt-6 text-[12.5px] text-[#9A8F7E]">{t.termsNote}</p>
          </div>
        </section>
      </main>

      {/* ── التذييل (هامش سفلي للزرّ العائم على الجوال) ── */}
      <footer className="border-t border-[#E9E1D3]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-24 sm:pb-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 text-sm text-[#6E6557]">
          <div className="flex items-center gap-4 flex-wrap">
            <Link to={home} className="hover:text-[#1F1A13]">{t.home}</Link>
            <Link to={contact} className="hover:text-[#1F1A13]">{t.contact}</Link>
            <Link to={AMBASSADORS_LOGIN} className="hover:text-[#1F1A13]">{t.loginShort}</Link>
          </div>
          <nav aria-label={t.otherLangs} className="flex items-center gap-3 flex-wrap">
            {AMBASSADORS_LANGS.filter((x) => x !== L).map((x) => (
              <Link key={x} to={ambassadorsPathFor(x)} hrefLang={x} className="hover:text-[#1F1A13]">{AMBASSADORS_LANG_LABEL[x]}</Link>
            ))}
            <span className="text-[#9A8F7E]" dir="ltr">{t.rights}</span>
          </nav>
        </div>
      </footer>
    </div>
  );
}
