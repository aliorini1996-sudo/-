import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { BadgeCheck, AlertTriangle, Download, Printer, Loader2 } from 'lucide-react';
import { useLang, type Lang } from '../i18n/lang';
import { formatCurrency } from '../utils/format';
import {
  isShareToken, parsePublicDoc, shareAmountLines, shareDocTitle, shareStatusNote, shareTranslate, type PublicDoc,
} from '../lib/zatca/shareView';

/**
 * ZATCA المرحلة الثانية (Z5.7) — صفحة المشتري: `/e/:token` بلا مصادقة.
 *
 * الفاتورة القياسية لا تُسلَّم للمشتري إلا بعد اعتماد الهيئة، والذي يُسلَّم هو مستند الهيئة نفسه (الـXML ورمزه
 * المختوم) لا ورقةً مطبوعة. فهذه الصفحة هي مخرج ذلك المستند: يفتحها مشترٍ لا حساب له من رابطٍ في واتساب.
 *
 * ولأنّ من يفتحها ليس مستخدم المنصّة، تُكتب بقواعد مختلفة:
 *   • **الرمز هو الإذن**: يُفحص شكله محلياً قبل أيّ نداء (رابطٌ قُصّ في اللصق لا يستهلك حصّة الخادم).
 *   • **كلّ رفضٍ شاشةٌ واحدة**: لا يفرّق العرض بين «لا يوجد» و«غير نهائيّ» و«رمزٌ خاطئ» — الخادم لا يفرّق أصلاً،
 *     وتفريقُ الواجهة يبني كاشفَ وجودٍ من لا شيء. استثناؤها 429 وحدها: «حاول بعد قليل» إرشادٌ لا كشف.
 *   • **بلا حالة محفوظة ولا تتبّع**: لا تخزين محلّي ولا إحالة تسويقية ولا فهرسة (noindex) — رابطٌ خاصّ يُشارك يداً بيد.
 *   • **الجوال أولاً**: عمودٌ واحد يتّسع، وجدول المبالغ بسطورٍ لا بأعمدة.
 *
 * ولأنّ المشتري قد لا يقرأ العربية، مبدّل اللغات الخمس في رأس الصفحة، وقاموسها كلّه في `lib/zatca/shareView.ts`
 * الذي يُحمَّل كسولاً مع هذه الصفحة وحدها.
 */

const API = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

const LANGS: ReadonlyArray<{ code: Lang; label: string }> = Object.freeze([
  { code: 'ar', label: 'العربية' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'zh', label: '中文' },
]);

type Phase = 'loading' | 'ready' | 'gone' | 'busy';

export default function EinvoicePublicPage() {
  const { token } = useParams();
  const lang = useLang(s => s.lang);
  const setLang = useLang(s => s.setLang);
  const tr = (ar: string): string => shareTranslate(lang, ar);
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  const [phase, setPhase] = useState<Phase>('loading');
  const [doc, setDoc] = useState<PublicDoc | null>(null);
  const [qrImg, setQrImg] = useState<string | null>(null);

  // رابطٌ خاصّ يُشارك يداً بيد: لا يُفهرس ولا يُتبع، ولا يُرسل مساره في ترويسة Referer.
  // الرمز هو الإذن كلّه وهو في المسار: بلا `no-referrer` يرسله المتصفّح مع نداء الـAPI (نفس الأصل) ومع أيّ
  // طلبٍ لاحق، فينتهي في سجلّات الخادم وعند أيّ طرفٍ ثالث. يُركَّب قبل أوّل نداء (ترتيب الـeffects).
  useEffect(() => {
    const metas = ([['robots', 'noindex, nofollow'], ['referrer', 'no-referrer']] as const).map(([name, content]) => {
      const m = document.createElement('meta');
      m.name = name;
      m.content = content;
      document.head.appendChild(m);
      return m;
    });
    return () => { metas.forEach((m) => document.head.removeChild(m)); };
  }, []);

  useEffect(() => {
    let dead = false;
    if (!isShareToken(token)) { setPhase('gone'); return; }
    (async () => {
      try {
        const r = await fetch(`${API}/public/einvoice/${token}`, { headers: { Accept: 'application/json' } });
        if (r.status === 429) { if (!dead) setPhase('busy'); return; }
        if (!r.ok) { if (!dead) setPhase('gone'); return; }
        const body = await r.json();
        const v = parsePublicDoc((body as { data?: unknown })?.data);
        if (dead) return;
        if (!v) { setPhase('gone'); return; }
        setDoc(v);
        setPhase('ready');
      } catch {
        if (!dead) setPhase('gone');
      }
    })();
    return () => { dead = true; };
  }, [token]);

  // عنوان التبويب باسم المستند — يظهر في مشاركة الرابط ثانيةً وفي ملفّ الطباعة
  useEffect(() => {
    document.title = doc ? `${tr(shareDocTitle(doc))}${doc.document.number ? ` ${doc.document.number}` : ''}` : 'Field Sales';
  }, [doc, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  // رسم رمز الهيئة المختوم صورةً — بيانات الرمز كما ختمها التوقيع لا تُبنى هنا
  useEffect(() => {
    let dead = false;
    if (!doc?.qr) { setQrImg(null); return; }
    QRCode.toDataURL(doc.qr, { width: 220, margin: 1, errorCorrectionLevel: 'M' })
      .then(url => { if (!dead) setQrImg(url); })
      .catch(() => { if (!dead) setQrImg(null); });
    return () => { dead = true; };
  }, [doc]);

  const lines = useMemo(() => (doc ? shareAmountLines(doc) : []), [doc]);

  if (phase === 'loading') {
    return (
      <Shell dir={dir}>
        <p className="flex items-center justify-center gap-2 text-[#6E6557] py-16">
          <Loader2 size={16} className="animate-spin" /> {tr('جاري التحميل')}
        </p>
      </Shell>
    );
  }

  if (phase !== 'ready' || !doc) {
    return (
      <Shell dir={dir}>
        <LangBar lang={lang} setLang={setLang} tr={tr} />
        <div className="text-center py-14 px-4">
          <AlertTriangle size={34} className="mx-auto text-[#C0392B]" />
          <p className="mt-3 font-semibold text-[#1F1A13]">
            {phase === 'busy' ? tr('طلبات كثيرة حاول بعد قليل') : tr('الرابط غير صحيح أو لم يعد متاحا')}
          </p>
          {phase !== 'busy' && <p className="mt-1 text-sm text-[#6E6557]">{tr('تحقق من الرابط كاملا مع من أرسله لك')}</p>}
        </div>
      </Shell>
    );
  }

  const d = doc.document;
  const note = shareStatusNote(doc);

  return (
    <Shell dir={dir}>
      <LangBar lang={lang} setLang={setLang} tr={tr} />

      <header className="px-4 pt-2 pb-4 border-b border-[#F1EBDF]">
        <h1 className="text-lg font-bold text-[#1F1A13]">{tr(shareDocTitle(doc))}</h1>
        {d.number && <p className="font-mono text-[#E15A30] text-sm mt-0.5" dir="ltr">{d.number}</p>}
        <div className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[13px] leading-relaxed ${
          note.tone === 'ok' ? 'bg-[#E4F1EA] border-[#BFE0CE] text-[#1E7A52]' : 'bg-[#FDF3D8] border-[#F0DDA6] text-[#6B4B00]'}`}>
          {note.tone === 'ok'
            ? <BadgeCheck size={17} className="mt-0.5 shrink-0" />
            : <AlertTriangle size={17} className="mt-0.5 shrink-0" />}
          <div className="min-w-0">
            <p className="font-semibold">{tr(note.label)}</p>
            <p className="mt-0.5">{tr(note.hint)}</p>
          </div>
        </div>
      </header>

      <section className="px-4 py-4 grid gap-3 sm:grid-cols-2 border-b border-[#F1EBDF]">
        <Field label={tr('البائع')} value={doc.seller.name} />
        <Field label={tr('الرقم الضريبي')} value={doc.seller.vatNumber} ltr />
        <Field label={tr('المشتري')} value={doc.buyer.name} />
        <Field
          label={tr('تاريخ الإصدار')}
          value={d.issueDate ? `${d.issueDate}${d.issueTime ? ` ${d.issueTime}` : ''}` : null}
          hint={d.issueDate ? tr('بتوقيت الرياض') : null}
          ltr
        />
        <Field label={tr('المعرف الفريد')} value={d.uuid} ltr small />
      </section>

      <section className="px-4 py-4 border-b border-[#F1EBDF]">
        <dl className="space-y-1.5">
          {lines.map(l => (
            <div key={l.label} className={`flex items-baseline justify-between gap-3 ${
              l.strong ? 'pt-2 mt-1 border-t border-[#F1EBDF] text-[15px] font-bold text-[#1F1A13]' : 'text-sm text-[#4A4239]'}`}>
              <dt>{tr(l.label)}</dt>
              <dd className="font-mono tabular-nums whitespace-nowrap" dir="ltr">
                {l.negative ? '−' : ''}{formatCurrency(Math.abs(l.value), d.currency)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {qrImg && (
        <section className="px-4 py-5 text-center border-b border-[#F1EBDF]">
          <img src={qrImg} alt={tr('رمز الاستجابة السريعة المختوم')} className="mx-auto w-40 h-40" />
          <p className="mt-2 text-[12px] text-[#6E6557]">{tr('امسح الرمز للتحقق من المستند في تطبيق الهيئة')}</p>
        </section>
      )}

      <section className="px-4 py-5 space-y-2 print:hidden">
        {doc.xml.available && (
          <a
            href={`${API}/public/einvoice/${token}/xml`}
            className="flex items-center justify-center gap-2 w-full rounded-xl bg-[#1F1A13] text-white py-3 text-sm font-semibold"
          >
            <Download size={16} /> {tr('تنزيل المستند الإلكتروني XML')}
          </a>
        )}
        <button
          type="button"
          onClick={() => window.print()}
          className="flex items-center justify-center gap-2 w-full rounded-xl bg-[#F1EBDF] text-[#4A4239] py-3 text-sm font-semibold"
        >
          <Printer size={16} /> {tr('طباعة')}
        </button>
        <p className="text-[12px] text-[#6E6557] text-center pt-1">{tr('هذه النسخة الإلكترونية هي المستند المعتمد لدى الهيئة')}</p>
      </section>
    </Shell>
  );
}

// ─── قطع العرض ───

function Shell({ dir, children }: { dir: 'rtl' | 'ltr'; children: React.ReactNode }) {
  return (
    <div dir={dir} className="min-h-screen bg-[#FAF6EF] py-6 px-3">
      <div className="mx-auto w-full max-w-lg bg-white rounded-2xl shadow-sm border border-[#F1EBDF] overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function LangBar({ lang, setLang, tr }: { lang: Lang; setLang: (l: Lang) => void; tr: (s: string) => string }) {
  return (
    <div className="flex items-center gap-1 flex-wrap px-4 pt-3 print:hidden">
      <span className="sr-only">{tr('اللغة')}</span>
      {LANGS.map(l => (
        <button
          key={l.code}
          type="button"
          onClick={() => setLang(l.code)}
          className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
            lang === l.code ? 'bg-[#1F1A13] text-white' : 'bg-[#F1EBDF] text-[#6E6557]'}`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, value, hint, ltr, small }: {
  label: string; value: string | null; hint?: string | null; ltr?: boolean; small?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-[#6E6557]">{label}</p>
      <p
        className={`${small ? 'text-[11px]' : 'text-sm'} text-[#1F1A13] break-words ${ltr ? 'font-mono' : ''}`}
        dir={ltr ? 'ltr' : undefined}
      >
        {value ?? '—'}
      </p>
      {hint && <p className="text-[10px] text-[#6E6557]">{hint}</p>}
    </div>
  );
}
