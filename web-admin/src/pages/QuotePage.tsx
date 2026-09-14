import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { FileDown, Loader2, Share2 } from 'lucide-react';
import { BrandIcon } from '../components/BrandLogo';
import { elementToPdfBlob, shareOrDownloadPdf } from '../rep/pdf';

/**
 * مُصدِر عروض الأسعار السريع — رابطٌ خاصّ `/q-fs7k2m` بلا دخول، للمالك وموظّفي المبيعات.
 * غير مُدرج: noindex ولا روابط إليه، ولا يستدعي أيّ API — لا بيانات تُقرأ أو تُكتب.
 *
 * يُغني عن فتح ملفّ الوورد في كل مرّة: اسم المنشأة ورقمها الموحّد والباقة ودورة
 * السداد، ثمّ PDF جاهز يُشارَك عبر قائمة الجوال (واتساب وغيره).
 *
 * العربية هنا ثابتة لا `tr()`: المستند نفسه عربيّ بتصميمه.
 */

/** الأسعار المعتمدة — **شاملة الضريبة** (المنشأة مسجّلة في ضريبة القيمة المضافة) */
const PACKAGES = [
  { id: 'starter', name: 'المبتدئة', total: 299, limit: 'حتى ٥ مناديب ومستخدم إداري واحد' },
  { id: 'growth', name: 'المتوسطة', total: 399, limit: 'حتى ١٠ مناديب ومستخدمَين إداريَّين' },
  { id: 'pro', name: 'المتقدمة', total: 599, limit: 'حتى ٢٠ مندوباً و٥ مستخدمين إداريين', badge: 'الأكثر طلباً' },
] as const;

const VAT = 0.15;
/** صلاحية العرض بالأيام — كما في نصّ الشروط بملفّ الوورد */
const VALID_DAYS = 10;

const INCLUDED = [
  'تطبيق مندوب ميدانيّ (أندرويد / iOS / ويب).',
  'التتبّع المباشر (GPS) وتسجيل الزيارات الميدانية على الخريطة.',
  'تقارير شاملة: أداء المناديب، مديونيات العملاء، ساعات العمل، والمبيعات.',
  'لوحة إدارة ويب كاملة + تطبيق لسطح المكتب (ويندوز).',
  'دعم فنّي.',
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')} / ${String(d.getMonth() + 1).padStart(2, '0')} / ${d.getFullYear()}`;

export default function QuotePage() {
  // رابطٌ خاصّ: لا فهرسة، ويُستعاد وسم robots والعنوان عند المغادرة
  useEffect(() => {
    const prevTitle = document.title;
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    const prevRobots = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'robots');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', 'noindex, nofollow');
    document.title = 'عرض سعر — Field Sales';
    return () => {
      document.title = prevTitle;
      if (created) meta?.remove();
      else if (prevRobots !== null) meta?.setAttribute('content', prevRobots);
    };
  }, []);

  const [company, setCompany] = useState('');
  const [unifiedNo, setUnifiedNo] = useState('');
  const [pkgId, setPkgId] = useState<(typeof PACKAGES)[number]['id']>('pro');
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const docRef = useRef<HTMLDivElement>(null);

  const pkg = PACKAGES.find(p => p.id === pkgId)!;
  const yearly = cycle === 'yearly';

  /* الضريبة **تُستخرَج من السعر لا تُضاف إليه**: ٢٩٩ شاملةٌ أصلاً. والسنويّ يُحسب
   * على إجماليّ الاثني عشر شهراً مباشرةً لا بضرب صافي الشهر، فلا ينحرف فلسٌ بالتقريب. */
  const figures = useMemo(() => {
    const total = yearly ? pkg.total * 12 : pkg.total;
    const net = r2(total / (1 + VAT));
    return { total, net, vat: r2(total - net) };
  }, [pkg, yearly]);

  // رقم العرض وتاريخاه يُثبَّتان لحظة فتح الصفحة، فلا يتغيّر الرقم بين المعاينة والملفّ
  const meta = useMemo(() => {
    const now = new Date();
    const valid = new Date(now.getTime() + VALID_DAYS * 86400000);
    const p = (n: number) => String(n).padStart(2, '0');
    const no = `FS-QT-${now.getFullYear()}-${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}`;
    return { no, date: dmy(now), valid: dmy(valid) };
  }, []);

  const ready = company.trim().length > 1 && /^\d{5,}$/.test(unifiedNo.trim());

  const issue = async () => {
    if (!ready || !docRef.current) return;
    setBusy(true); setErr('');
    try {
      const blob = await elementToPdfBlob(docRef.current);
      const safe = company.trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
      await shareOrDownloadPdf(blob, `عرض سعر - ${safe} - ${meta.no}.pdf`);
    } catch {
      setErr('تعذر إصدار الملف حاول مجددا');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div dir="rtl" className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]">
      <header className="bg-[#1F1A13] text-white px-4 py-3 flex items-center gap-2.5">
        <BrandIcon size={30} radius={0.3} />
        <div>
          <p className="text-sm font-bold leading-tight">عرض سعر سريع</p>
          <p className="text-[11px] text-[#9A8F7E]">{meta.no}</p>
        </div>
      </header>

      <main className="max-w-md mx-auto p-4 space-y-4">
        <section className="bg-white rounded-2xl border border-[#F1EBDF] p-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-[#6E6557] mb-1">اسم المنشأة</label>
            <input className="input" value={company} onChange={e => setCompany(e.target.value)}
              placeholder="مثال: شركة الأمل للتجارة" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#6E6557] mb-1">الرقم الموحد</label>
            <input className="input" dir="ltr" inputMode="numeric" value={unifiedNo}
              onChange={e => setUnifiedNo(e.target.value.replace(/[^\d]/g, ''))} placeholder="7000000000" />
          </div>
        </section>

        <section className="space-y-2">
          <p className="text-xs font-bold text-[#9A8F7E] px-1">الباقة</p>
          {PACKAGES.map(p => (
            <button key={p.id} type="button" onClick={() => setPkgId(p.id)}
              className={`w-full text-start rounded-2xl border p-3.5 flex items-center justify-between gap-3 transition-colors ${
                pkgId === p.id ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#F1EBDF] bg-white'}`}>
              <span className="min-w-0">
                <span className="block font-bold">{p.name}</span>
                <span className="block text-[11px] text-[#9A8F7E]">{p.limit}</span>
              </span>
              <span className="text-left flex-shrink-0">
                <span className="block font-bold tabular-nums">{p.total} ر.س</span>
                <span className="block text-[10px] text-[#9A8F7E]">شهرياً شامل الضريبة</span>
              </span>
            </button>
          ))}
        </section>

        <section className="space-y-2">
          <p className="text-xs font-bold text-[#9A8F7E] px-1">دورة السداد</p>
          <div className="grid grid-cols-2 gap-2">
            {(['monthly', 'yearly'] as const).map(c => (
              <button key={c} type="button" onClick={() => setCycle(c)}
                className={`rounded-xl border py-3 font-semibold ${
                  cycle === c ? 'border-[#E15A30] bg-[#E15A30] text-white' : 'border-[#F1EBDF] bg-white'}`}>
                {c === 'monthly' ? 'شهرية' : 'سنوية'}
              </button>
            ))}
          </div>
        </section>

        <section className="bg-white rounded-2xl border border-[#F1EBDF] p-4 text-sm space-y-1.5 tabular-nums">
          <Row label={yearly ? 'السعر السنوي قبل الضريبة' : 'السعر الشهري قبل الضريبة'} value={`${money(figures.net)} ر.س`} />
          <Row label="ضريبة القيمة المضافة ١٥٪" value={`${money(figures.vat)} ر.س`} />
          <div className="border-t border-[#F1EBDF] pt-1.5">
            <Row strong label={yearly ? 'الإجمالي السنوي' : 'الإجمالي الشهري'} value={`${money(figures.total)} ر.س`} />
          </div>
        </section>

        {err && <p className="text-center text-sm text-[#C0392B]">{err}</p>}

        <button type="button" onClick={issue} disabled={!ready || busy}
          className="w-full bg-[#E15A30] text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {busy ? <Loader2 size={18} className="animate-spin" /> : <Share2 size={18} />}
          إصدار العرض ومشاركته
        </button>
        {!ready && (
          <p className="text-center text-[11px] text-[#9A8F7E] flex items-center justify-center gap-1">
            <FileDown size={12} /> أدخل اسم المنشأة ورقمها الموحد
          </p>
        )}
      </main>

      {/* ═══ المستند المطبوع — خارج الشاشة، يُلتقط بمقاس A4 ═══ */}
      <div style={{ position: 'fixed', left: -10000, top: 0 }} aria-hidden>
        <QuoteDocument ref={docRef} company={company.trim()} unifiedNo={unifiedNo.trim()}
          pkg={pkg} yearly={yearly} figures={figures} meta={meta} />
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${strong ? 'font-bold text-base' : 'text-[#6E6557]'}`}>
      <span>{label}</span><span className="text-[#1F1A13]">{value}</span>
    </div>
  );
}

/* ═══════════════════════ المستند ═══════════════════════ */


const ACCENT = '#E15A30';
const INK = '#1F1A13';
const MUTED = '#6E6557';
const LINE = '#E9E1D3';

interface DocProps {
  company: string;
  unifiedNo: string;
  pkg: (typeof PACKAGES)[number];
  yearly: boolean;
  figures: { total: number; net: number; vat: number };
  meta: { no: string; date: string; valid: string };
}

const QuoteDocument = forwardRef<HTMLDivElement, DocProps>(({ company, unifiedNo, pkg, yearly, figures, meta }, ref) => {
  const th: React.CSSProperties = { background: INK, color: '#fff', padding: '10px 8px', fontSize: 12, fontWeight: 700, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '12px 8px', fontSize: 13, textAlign: 'center', borderBottom: `1px solid ${LINE}` };
  return (
    <div ref={ref} dir="rtl" style={{
      width: 794, minHeight: 1123, background: '#fff', color: INK, padding: '48px 54px',
      fontFamily: "'IBM Plex Sans Arabic', 'Noto Sans Arabic', Tahoma, sans-serif", boxSizing: 'border-box',
    }}>
      {/* الترويسة */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `3px solid ${ACCENT}`, paddingBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <BrandIcon size={54} radius={0.28} />
          <div>
            <div style={{ fontFamily: "'IBM Plex Serif', serif", fontSize: 24, fontWeight: 700, direction: 'ltr' }}>
              <span style={{ color: INK }}>Field</span> <span style={{ color: ACCENT }}>Sales</span>
            </div>
            <div style={{ fontSize: 12, color: MUTED }}>منصّة إدارة المبيعات الميدانية والتوزيع</div>
          </div>
        </div>
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: ACCENT }}>عرض سعر</div>
          <div style={{ fontSize: 11, letterSpacing: 3, color: MUTED }}>QUOTATION</div>
        </div>
      </div>

      {/* بيانات العرض + المُقدَّم إليه */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, marginTop: 22 }}>
        <div style={{ flex: 1, background: '#FAF7F0', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: MUTED, marginBottom: 6 }}>مُقدَّم إلى</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{company || '—'}</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
            الرقم الموحد: <span style={{ direction: 'ltr', unicodeBidi: 'embed', color: INK }}>{unifiedNo || '—'}</span>
          </div>
        </div>
        <div style={{ fontSize: 12, lineHeight: 2, minWidth: 210 }}>
          <div>رقم العرض: <b style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{meta.no}</b></div>
          <div>التاريخ: <b style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{meta.date}</b></div>
          <div>صالح حتى: <b style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{meta.valid}</b></div>
        </div>
      </div>

      <p style={{ fontSize: 13, lineHeight: 1.9, color: INK, marginTop: 22 }}>
        يسعدنا في Field Sales أن نقدّم لكم عرض السعر التالي لاشتراك منصّتنا في إدارة فريق المبيعات
        الميداني والتوزيع — بأسعارٍ معلنة وشفّافة، وتفعيلٍ فوريّ، ودعمٍ عربيّ مباشر.
      </p>

      {/* جدول الباقة */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 18 }}>
        <thead>
          <tr>
            <th style={{ ...th, borderTopRightRadius: 8 }}>الباقة</th>
            <th style={th}>الحدّ الأقصى</th>
            <th style={th}>{yearly ? 'السعر السنوي (ر.س)' : 'السعر الشهري (ر.س)'}</th>
            <th style={th}>ض.ق.م ١٥٪</th>
            <th style={{ ...th, borderTopLeftRadius: 8 }}>{yearly ? 'الإجمالي السنوي' : 'الإجمالي الشهري'}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ ...td, fontWeight: 700 }}>
              {pkg.name}
              {'badge' in pkg && pkg.badge && (
                <div style={{ fontSize: 10, color: ACCENT, fontWeight: 600, marginTop: 2 }}>{pkg.badge}</div>
              )}
            </td>
            <td style={{ ...td, fontSize: 12 }}>{pkg.limit}</td>
            <td style={{ ...td, direction: 'ltr' }}>{money(figures.net)}</td>
            <td style={{ ...td, direction: 'ltr' }}>{money(figures.vat)}</td>
            <td style={{ ...td, fontWeight: 800, color: ACCENT, fontSize: 15 }}>
              <span style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{money(figures.total)}</span> ريال
            </td>
          </tr>
        </tbody>
      </table>
      {yearly && (
        <p style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>
          يعادل {pkg.total} ريالاً شهرياً شاملة الضريبة × ١٢ شهراً.
        </p>
      )}

      <Block title="ما تشمله جميع الباقات" items={INCLUDED} />
      <Block title="الشروط والأحكام" items={[
        `هذا العرض صالحٌ لمدّة ${VALID_DAYS} أيام من تاريخه.`,
        yearly
          ? 'الاشتراك سنويّ ويُجدَّد تلقائياً ما لم يُطلب إيقافه، ويمكن الترقية في أي وقت.'
          : 'الاشتراك شهريّ ويُجدَّد تلقائياً ما لم يُطلب إيقافه، ويمكن الترقية أو التخفيض في أي وقت.',
        'الأسعار شاملة ضريبة القيمة المضافة ١٥٪.',
        'الدفع عبر تحويل بنكيّ؛ تُرسَل تفاصيل الحساب عند تأكيد الطلب.',
      ]} />

      <div style={{ marginTop: 40, borderTop: `1px solid ${LINE}`, paddingTop: 12, textAlign: 'center', fontSize: 12, color: MUTED, direction: 'ltr' }}>
        Field Sales · fieldsa.net · help@fieldsa.net
      </div>
    </div>
  );
});
QuoteDocument.displayName = 'QuoteDocument';

function Block({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 26 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: INK, borderRight: `4px solid ${ACCENT}`, paddingRight: 10, marginBottom: 10 }}>
        {title}
      </div>
      {items.map((t, i) => (
        <div key={i} style={{ fontSize: 12.5, lineHeight: 1.9, color: INK, display: 'flex', gap: 8 }}>
          <span style={{ color: ACCENT }}>•</span><span>{t}</span>
        </div>
      ))}
    </div>
  );
}
