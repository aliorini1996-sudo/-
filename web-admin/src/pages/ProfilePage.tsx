import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { BrandIcon } from '../components/BrandLogo';
import { mergeProfile, splitLines, splitPairs, ProfileLang, ProfileContent } from '../content/profileContent';

/**
 * «بروفايل» — الملف التعريفي التفاعلي fieldsa.net/profile
 * بنفس ترتيب ملف الـPDF قسما قسما، والمشاهد يبدل اللغة (عربي/انجليزي) كما يناسبه.
 * كل نص يُقرأ من CMS الموقع (siteContent.profile) فيعدّله المالك من لوحته بأي وقت.
 */

const COLORS = { coral: '#E15A30', ink: '#1F1A13', cream: '#FAF7F0', coralL: '#FBEBE2', gray: '#6E6557', sand: '#E9E1D3', green: '#1E7A52' };

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
    document.title = isAr ? 'بروفايل — Field Sales' : 'Company Profile — Field Sales';
  }, [isAr]);

  const arFont = "'IBM Plex Sans Arabic', sans-serif";
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

  const Kicker = ({ children, dark }: { children: React.ReactNode; dark?: boolean }) => (
    <div className="flex items-center gap-2.5 font-bold text-sm" style={{ color: COLORS.coral }}>
      <span className="inline-block h-1 w-9 rounded-full" style={{ background: COLORS.coral }} />
      <span style={{ opacity: dark ? 1 : 0.95 }}>{children}</span>
    </div>
  );

  const H2 = ({ children, dark }: { children: React.ReactNode; dark?: boolean }) => (
    <h2 className="mt-3 text-3xl sm:text-5xl font-bold leading-snug" style={{ color: dark ? COLORS.cream : COLORS.ink, fontFamily: headFont }}>
      {children}
    </h2>
  );

  const Lines = ({ text, dark, size = 'text-lg' }: { text: string; dark?: boolean; size?: string }) => (
    <div className={`mt-5 ${size} leading-loose`} style={{ color: dark ? 'rgba(250,247,240,.75)' : COLORS.gray }}>
      {splitLines(text).map((l, i) => <p key={i}>{l}</p>)}
    </div>
  );

  return (
    <div dir={dir} className="min-h-screen" style={{ background: COLORS.cream, fontFamily: font }}>

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
            <button onClick={() => window.print()} title={L('حفظ PDF', 'Save PDF')}
              className="px-3.5 py-1.5 rounded-xl text-sm font-bold" style={{ background: COLORS.ink, color: COLORS.cream }}>
              PDF
            </button>
          </div>
        </div>
      </header>

      {/* ١ الغلاف */}
      <section className="relative overflow-hidden" style={{ background: COLORS.ink }}>
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 1280 640" preserveAspectRatio="xMidYMid slice" aria-hidden>
          <line x1={isAr ? 180 : 1100} y1="560" x2={isAr ? 1100 : 180} y2="110" stroke={COLORS.coral} strokeWidth="6" strokeLinecap="round" opacity=".55" />
          <circle cx={isAr ? 180 : 1100} cy="560" r="13" fill={COLORS.cream} opacity=".9" />
          <circle cx="640" cy="335" r="10" fill={COLORS.cream} opacity=".9" />
          <circle cx={isAr ? 1100 : 180} cy="110" r="20" fill="none" stroke={COLORS.coral} strokeWidth="9" />
          <circle cx={isAr ? 1100 : 180} cy="110" r="7" fill={COLORS.cream} />
        </svg>
        <div className="relative max-w-6xl mx-auto px-4 py-20 sm:py-28">
          <Kicker dark>{L('الملف التعريفي', 'Company profile')}</Kicker>
          <h1 className="mt-4 text-4xl sm:text-6xl font-bold leading-tight max-w-3xl" style={{ color: COLORS.cream, fontFamily: headFont }}>
            {t.cover_title}
          </h1>
          <div className="mt-6 text-lg sm:text-2xl leading-relaxed" style={{ color: 'rgba(250,247,240,.72)' }}>
            {splitLines(t.cover_promise).map((l, i) => <p key={i}>{l}</p>)}
          </div>
          <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm" style={{ color: 'rgba(250,247,240,.55)' }}>
            <span style={{ color: COLORS.coral, fontWeight: 700, fontFamily: enFont }}>fieldsa.net</span>
            <span>{L('نسخة ٢٠٢٦', '2026 edition')}</span>
            <span>{L('معد للشركاء والمستثمرين', 'Prepared for partners and investors')}</span>
          </div>
        </div>
      </section>

      {/* ٢ المشكلة */}
      <section className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
        <Kicker>{L('المشكلة', 'The problem')}</Kicker>
        <H2>{t.problem_title}</H2>
        <Lines text={t.problem_body} size="text-lg sm:text-xl" />
      </section>

      {/* ٣ الحل */}
      <section style={{ background: COLORS.ink }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker dark>{L('الحل', 'The solution')}</Kicker>
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

      {/* ٤ العملاء */}
      <section className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
        <Kicker>{L('العملاء', 'Our clients')}</Kicker>
        <H2>{t.clients_title}</H2>
        <Lines text={t.clients_intro} />
        <div className="mt-8 grid sm:grid-cols-3 gap-5">
          {splitLines(t.clients_sectors).map((s, i) => (
            <div key={i} className="rounded-2xl bg-white p-6 text-base leading-relaxed" style={{ border: `1px solid ${COLORS.sand}`, color: COLORS.ink }}>
              <span className="block mb-3 text-2xl font-bold" style={{ color: COLORS.coral, fontFamily: headFont }}>{isAr ? '٠' + '١٢٣'[i] : `0${i + 1}`}</span>
              {s}
            </div>
          ))}
        </div>
      </section>

      {/* ٥ من نحن */}
      <section style={{ background: COLORS.coralL }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker>{L('من نحن', 'Who we are')}</Kicker>
          <H2>{t.about_title}</H2>
          <Lines text={t.about_body} size="text-lg sm:text-xl" />
        </div>
      </section>

      {/* ٦ الرحلة */}
      <section className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
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
      </section>

      {/* ٧ الانجازات */}
      <section style={{ background: COLORS.ink }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker dark>{L('الانجازات', 'Achievements')}</Kicker>
          <H2 dark>{t.achievements_title}</H2>
          <div className="mt-8 grid sm:grid-cols-3 gap-5">
            {splitLines(t.achievements_items).map((a, i) => (
              <div key={i} className="rounded-2xl p-6" style={{ background: 'rgba(250,247,240,.05)', border: '1px solid rgba(250,247,240,.12)' }}>
                <span className="block mb-3 text-3xl font-bold" style={{ color: COLORS.coral, fontFamily: headFont }}>{isAr ? '١٢٣'[i] : i + 1}</span>
                <p className="text-base leading-relaxed" style={{ color: 'rgba(250,247,240,.85)' }}>{a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ٨ الارقام */}
      <section style={{ background: COLORS.coral }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker dark><span style={{ color: COLORS.cream }}>{L('الارقام', 'The numbers')}</span></Kicker>
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

      {/* ٩ اهداف المستقبل */}
      <section style={{ background: COLORS.ink }}>
        <div className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
          <Kicker dark>{L('اهداف المستقبل', 'Future targets')}</Kicker>
          <H2 dark>{t.goals_title}</H2>
          <div className="mt-8 grid sm:grid-cols-2 gap-5">
            {splitLines(t.goals_items).map((g, i) => (
              <div key={i} className="rounded-2xl p-6 flex gap-5 items-start" style={{ background: 'rgba(250,247,240,.05)', border: '1px solid rgba(250,247,240,.12)' }}>
                <span className="text-4xl sm:text-5xl font-bold leading-none" style={{ color: COLORS.coral, fontFamily: headFont }}>{isAr ? '١٢٣٤'[i] : i + 1}</span>
                <p className="text-base sm:text-lg leading-relaxed" style={{ color: 'rgba(250,247,240,.9)' }}>{g}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ١٠ الاستثمار */}
      <section className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
        <Kicker>{L('الاستثمار', 'Investment')}</Kicker>
        <H2>{t.invest_title}</H2>
        <div className="mt-8 grid sm:grid-cols-3 gap-5">
          {splitLines(t.invest_tracks).map((tr, i) => (
            <div key={i} className="rounded-2xl bg-white p-6 text-base leading-relaxed" style={{ border: `1px solid ${COLORS.sand}`, color: COLORS.ink }}>
              <span className="block w-2.5 h-2.5 rounded-full mb-4" style={{ background: COLORS.coral }} />
              {tr}
            </div>
          ))}
        </div>
      </section>

      {/* ١١ تواصل معنا */}
      <section style={{ background: COLORS.coralL }}>
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

      {/* ١٢ الختام */}
      <footer className="relative overflow-hidden" style={{ background: COLORS.ink }}>
        <div className="relative max-w-6xl mx-auto px-4 py-16 sm:py-20 text-center">
          <div className="flex justify-center mb-5"><BrandIcon size={64} radius={0.28} /></div>
          <p className="text-3xl mb-4"><Wordmark dark /></p>
          <div className="text-base sm:text-lg leading-loose" style={{ color: 'rgba(250,247,240,.65)' }}>
            {splitLines(t.closing_line).map((l, i) => <p key={i}>{l}</p>)}
          </div>
          <div className="mt-6 flex justify-center gap-6 text-sm" style={{ fontFamily: enFont }}>
            <span style={{ color: COLORS.coral, fontWeight: 700 }}>fieldsa.net</span>
            <span style={{ color: 'rgba(250,247,240,.6)' }}>help@fieldsa.net</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
