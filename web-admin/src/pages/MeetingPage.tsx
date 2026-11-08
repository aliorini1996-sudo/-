import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarDays, CheckCircle2, ChevronDown, Search } from 'lucide-react';
import { contactApi } from '../api/client';
import { BrandIcon } from '../components/BrandLogo';
import LanguageToggle from '../components/LanguageToggle';
import { useDir, useLang } from '../i18n/lang';
import { flagOf } from '../i18n/dialCodes';
import { pathForLocale, seoUrls } from '../i18n/locale';
import { useSeo } from '../lib/seo';
import { countryLabel, dialCountryOf, filterDialCountries, internationalPhone } from '../lib/meetingPhone';

/**
 * «احجز اجتماع» (طلب المالك ٨ نوفمبر ٢٠٢٦): صفحة بسيطة سهلة — الاسم ورقم الجوال فقط، والجوال من أي دولة في العالم
 * (قائمة منسدلة بمفاتيح كل الدول مع بحث). يصل الطلب للإدارة بريدياً (POST /contact/meeting). زرّ الرئيسية «احجز اجتماع» يفتحها.
 */
const TEXT = {
  ar: {
    title: 'احجز اجتماعاً', sub: 'اكتب اسمك ورقم جوالك ونتواصل معك لتحديد موعد يناسبك',
    name: 'الاسم', namePh: 'الاسم الكريم', phone: 'رقم الجوال', country: 'مفتاح الدولة',
    search: 'ابحث عن دولة أو مفتاح', none: 'لا توجد نتائج', submit: 'احجز الاجتماع', sending: 'جار الإرسال',
    note: 'نتواصل معك خلال يوم عمل', errName: 'اكتب اسمك', errPhone: 'اكتب رقم جوال صحيحا',
    fail: 'تعذر إرسال الطلب حاول مرة أخرى', doneTitle: 'وصلنا طلبك', doneBody: 'سنتواصل معك على الرقم', doneTail: 'لتحديد موعد الاجتماع',
    home: 'العودة للرئيسية', seoTitle: 'احجز اجتماعاً مع فيلد سيلز | FieldSales',
    seoDesc: 'احجز اجتماعاً مع فريق فيلد سيلز بالاسم ورقم الجوال فقط ونتواصل معك لتحديد موعد يناسبك',
  },
  en: {
    title: 'Book a meeting', sub: 'Enter your name and mobile number and we will contact you to set a time that suits you',
    name: 'Name', namePh: 'Your name', phone: 'Mobile number', country: 'Country code',
    search: 'Search a country or code', none: 'No results', submit: 'Book the meeting', sending: 'Sending',
    note: 'We will contact you within one business day', errName: 'Enter your name', errPhone: 'Enter a valid mobile number',
    fail: 'Could not send your request please try again', doneTitle: 'We received your request', doneBody: 'We will contact you at', doneTail: 'to schedule the meeting',
    home: 'Back to home', seoTitle: 'Book a meeting with FieldSales',
    seoDesc: 'Book a meeting with the FieldSales team with just your name and mobile number and we will contact you to schedule it',
  },
  fr: {
    title: 'Réserver une réunion', sub: 'Indiquez votre nom et votre numéro de mobile et nous vous contacterons pour fixer un créneau',
    name: 'Nom', namePh: 'Votre nom', phone: 'Numéro de mobile', country: 'Indicatif du pays',
    search: 'Rechercher un pays ou un indicatif', none: 'Aucun résultat', submit: 'Réserver la réunion', sending: 'Envoi en cours',
    note: 'Nous vous contactons sous un jour ouvré', errName: 'Indiquez votre nom', errPhone: 'Indiquez un numéro de mobile valide',
    fail: 'Impossible d envoyer la demande veuillez réessayer', doneTitle: 'Demande bien reçue', doneBody: 'Nous vous contacterons au', doneTail: 'pour fixer la réunion',
    home: 'Retour à l accueil', seoTitle: 'Réserver une réunion avec FieldSales',
    seoDesc: 'Réservez une réunion avec l équipe FieldSales avec votre nom et votre mobile seulement',
  },
  tr: {
    title: 'Toplantı planlayın', sub: 'Adınızı ve cep numaranızı yazın, size uygun bir saat belirlemek için sizinle iletişime geçelim',
    name: 'Ad', namePh: 'Adınız', phone: 'Cep telefonu', country: 'Ülke kodu',
    search: 'Ülke veya kod arayın', none: 'Sonuç yok', submit: 'Toplantıyı planla', sending: 'Gönderiliyor',
    note: 'Bir iş günü içinde sizinle iletişime geçeriz', errName: 'Adınızı yazın', errPhone: 'Geçerli bir cep numarası yazın',
    fail: 'Talep gönderilemedi lütfen tekrar deneyin', doneTitle: 'Talebinizi aldık', doneBody: 'Sizinle şu numaradan iletişime geçeceğiz', doneTail: 'toplantıyı planlamak için',
    home: 'Ana sayfaya dön', seoTitle: 'FieldSales ile toplantı planlayın',
    seoDesc: 'Yalnızca adınız ve cep numaranızla FieldSales ekibiyle bir toplantı planlayın',
  },
  zh: {
    title: '预约会议', sub: '填写您的姓名和手机号码，我们将联系您安排合适的时间',
    name: '姓名', namePh: '您的姓名', phone: '手机号码', country: '国家区号',
    search: '搜索国家或区号', none: '无结果', submit: '预约会议', sending: '正在发送',
    note: '我们将在一个工作日内与您联系', errName: '请填写姓名', errPhone: '请填写有效的手机号码',
    fail: '提交失败，请重试', doneTitle: '已收到您的预约', doneBody: '我们将通过以下号码联系您', doneTail: '以安排会议时间',
    home: '返回首页', seoTitle: '预约 FieldSales 会议',
    seoDesc: '只需姓名和手机号码即可预约 FieldSales 团队会议',
  },
} as const;

/** علم الدولة صورةً (ويندوز لا يرسم أعلام الإيموجي فتظهر حروفاً) — وإيموجي العلم احتياطاً إن تعذّر التحميل */
function Flag({ code, size = 22 }: { code: string; size?: number }) {
  const [bad, setBad] = useState(false);
  const c = code.toLowerCase();
  if (bad) return <span className="text-lg leading-none">{flagOf(code)}</span>;
  return (
    <img src={`https://flagcdn.com/w40/${c}.png`} srcSet={`https://flagcdn.com/w80/${c}.png 2x`} width={size} height={Math.round(size * 0.72)}
      alt="" loading="lazy" onError={() => setBad(true)}
      className="rounded-[3px] object-cover shadow-[0_0_0_1px_rgba(31,26,19,0.08)] shrink-0" />
  );
}

export default function MeetingPage() {
  const lang = useLang((s) => s.lang);
  const dir = useDir();
  const L = TEXT[(lang in TEXT ? lang : 'ar') as keyof typeof TEXT];
  const home = pathForLocale('/', lang);
  const seoUrl = seoUrls('/meeting', lang);
  useSeo({ title: L.seoTitle, description: L.seoDesc, locale: lang as 'ar', canonical: seoUrl.canonical, alternates: seoUrl.alternates, image: 'https://fieldsa.net/og-image.png' });

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('SA');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [doneTo, setDoneTo] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  const country = dialCountryOf(code);
  const list = useMemo(() => filterDialCountries(query, lang), [query, lang]);

  // إغلاق القائمة بالنقر خارجها أو بـEscape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const pick = (c: string) => { setCode(c); setOpen(false); setQuery(''); setErr(null); phoneRef.current?.focus(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr(L.errName); return; }
    const full = internationalPhone(country.dial, phone);
    if (!full) { setErr(L.errPhone); return; }
    setErr(null);
    setSending(true);
    try {
      await contactApi.meeting({ name: name.trim(), phone: full, country: country.code, lang });
      setDoneTo(full);
    } catch {
      setErr(L.fail);
    } finally {
      setSending(false);
    }
  };

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans Arabic', 'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif" }}>
      <header className="max-w-5xl mx-auto px-5 h-16 flex items-center justify-between">
        <Link to={home} className="flex items-center gap-2.5">
          <BrandIcon size={34} />
          <span style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, letterSpacing: '-0.3px' }} className="text-xl">
            <span className="text-[#1F1A13]">Field</span> <span className="text-[#E15A30]">Sales</span>
          </span>
        </Link>
        <LanguageToggle />
      </header>

      <main className="px-4 pt-6 pb-16 flex justify-center">
        <div data-meeting-card="" className="w-full max-w-[560px] bg-white rounded-[22px] border border-[#E9E1D3] shadow-[0_18px_50px_rgba(31,26,19,0.07)] p-6 sm:p-8">
          <div className="flex items-center justify-between mb-6">
            <Link to={home} aria-label={L.home} className="w-10 h-10 rounded-full bg-[#F3EEE5] hover:bg-[#ECE4D7] flex items-center justify-center transition-colors">
              <ArrowLeft size={18} className={dir === 'rtl' ? 'rotate-180' : ''} />
            </Link>
            <div className="w-11 h-11 rounded-2xl bg-[#FBEBE2] flex items-center justify-center">
              <CalendarDays size={22} className="text-[#E15A30]" />
            </div>
          </div>

          {doneTo ? (
            <div className="text-center py-6" data-meeting-done="">
              <CheckCircle2 size={52} className="text-[#1E7A52] mx-auto mb-4" />
              <h1 className="text-2xl font-extrabold">{L.doneTitle}</h1>
              <p className="text-[#6E6557] mt-3 leading-relaxed">
                {L.doneBody} <span dir="ltr" className="font-semibold text-[#1F1A13]">{doneTo}</span> {L.doneTail}
              </p>
              <Link to={home} className="inline-flex mt-7 font-semibold text-white bg-[#E15A30] hover:bg-[#C94B24] px-7 py-3 rounded-xl transition-colors">{L.home}</Link>
            </div>
          ) : (
            <form onSubmit={submit} noValidate>
              <h1 className="text-2xl sm:text-[28px] font-extrabold text-center">{L.title}</h1>
              <p className="text-[#6E6557] text-center mt-2.5 leading-relaxed">{L.sub}</p>

              <label className="block mt-8 mb-1.5 text-sm font-semibold" htmlFor="meeting-name">{L.name}</label>
              <input id="meeting-name" value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} maxLength={120} autoComplete="name"
                placeholder={L.namePh}
                className="w-full h-12 rounded-xl border border-[#DED5C4] bg-white px-4 text-[15px] outline-none focus:border-[#E15A30] focus:ring-2 focus:ring-[#E15A30]/15" />

              <label className="block mt-5 mb-1.5 text-sm font-semibold" htmlFor="meeting-phone">{L.phone}</label>
              <div ref={boxRef} className="relative" dir="ltr">
                <div className="flex h-12 rounded-xl border border-[#DED5C4] bg-white focus-within:border-[#E15A30] focus-within:ring-2 focus-within:ring-[#E15A30]/15">
                  <button type="button" data-meeting-country="" aria-label={L.country} aria-haspopup="listbox" aria-expanded={open}
                    onClick={() => setOpen((o) => !o)}
                    className="flex items-center gap-1.5 px-3 border-r border-[#E9E1D3] rounded-l-xl hover:bg-[#FAF7F0] shrink-0">
                    <Flag code={country.code} size={24} />
                    <span className="text-[15px] font-semibold tabular-nums">{country.dial}</span>
                    <ChevronDown size={16} className="text-[#9A8F7E]" />
                  </button>
                  <input id="meeting-phone" ref={phoneRef} value={phone} inputMode="tel" autoComplete="tel-national" maxLength={20}
                    onChange={(e) => { setPhone(e.target.value); setErr(null); }}
                    placeholder={country.code === 'SA' ? '0512345678' : ''}
                    className="flex-1 min-w-0 bg-transparent px-3 text-[15px] tabular-nums outline-none" />
                </div>

                {open && (
                  <div data-meeting-list="" className="absolute z-30 mt-2 w-full bg-white rounded-xl border border-[#E9E1D3] shadow-[0_18px_40px_rgba(31,26,19,0.12)] overflow-hidden">
                    <div className="flex items-center gap-2 px-3 h-11 border-b border-[#F1EBDF]" dir={dir}>
                      <Search size={16} className="text-[#9A8F7E] shrink-0" />
                      <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={L.search}
                        className="flex-1 min-w-0 bg-transparent text-sm outline-none" />
                    </div>
                    <ul role="listbox" aria-label={L.country} className="max-h-72 overflow-y-auto py-1">
                      {list.length === 0 && <li className="px-4 py-3 text-sm text-[#9A8F7E] text-center">{L.none}</li>}
                      {list.map((c) => (
                        <li key={c.code} role="option" aria-selected={c.code === code}>
                          <button type="button" onClick={() => pick(c.code)} dir={dir}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-[#FAF7F0] ${c.code === code ? 'bg-[#FBEBE2]' : ''}`}>
                            <Flag code={c.code} />
                            <span className="flex-1 text-start truncate">{countryLabel(c, lang)}</span>
                            <span dir="ltr" className="text-[#6E6557] tabular-nums">{c.dial}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {err && <p role="alert" className="mt-4 text-sm text-[#B4231F] bg-[#FBEBE2] rounded-lg px-3 py-2">{err}</p>}

              <button type="submit" disabled={sending} data-meeting-submit=""
                className="w-full h-12 mt-6 rounded-xl bg-[#E15A30] hover:bg-[#C94B24] disabled:opacity-60 text-white font-bold text-[15px] transition-colors">
                {sending ? L.sending : L.submit}
              </button>
              <p className="text-center text-xs text-[#9A8F7E] mt-3">{L.note}</p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
