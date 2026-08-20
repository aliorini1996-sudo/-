import { useMemo, useState } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { BrandIcon } from '../components/BrandLogo';
import { ArrowLeft, MessageCircle, Calculator, Users, Truck, Wallet } from 'lucide-react';
import LanguageToggle from '../components/LanguageToggle';
import { useLang, useDir } from '../i18n/lang';
import { useSeo } from '../lib/seo';
import { seoUrls, pathForLocale } from '../i18n/locale';
import { waHref } from '../components/WhatsAppFab';
import {
  computeCommission, computeVanReconciliation, computeRepsNeeded, computeAging,
  type CommissionTier, type VanLine,
} from '../free/engines';

/**
 * الأدوات المجانية — تُحسب **في المتصفّح بالكامل**.
 *
 * صفر إرسال لأي مدخل مالي إلى خوادمنا: لا تكلفة تشغيل، ولا سطح تسريب، وحجّة
 * خصوصية تُكتب على الصفحة نصّاً. والحساب في `src/free/engines.ts` — دوالّ صرفة
 * مختبَرة بـ١٥ حالة، لأن صاحب الشركة يبني قراراً على الرقم المعروض.
 *
 * ولا رقم سوق مضمَّن: كل معامل يُدخله المستخدم فلا نُخفي افتراضاً داخل حساب.
 */

// العناوين بالاستعلام-أولاً (ترقية أغسطس 2026) — مطابقة FREE_TOOLS في scripts/prerender.mjs إلزامية (المصدر المزدوج).
const TOOLS = [
  { id: 'commission', title: 'حاسبة عمولة المبيعات للمناديب', icon: Calculator,
    desc: 'شرائح عمولة بأرضية وسقف وخصم المرتجعات لمناديب التوزيع بدل جداول Excel الهشة' },
  { id: 'van', title: 'تسوية عهدة سيارة المندوب', icon: Truck,
    desc: 'طابق حمولة السيارة آخر اليوم واكشف العجز بالصنف وقيمته' },
  { id: 'reps', title: 'حاسبة عدد مناديب المبيعات', icon: Users,
    desc: 'كم مندوبا تحتاج حجم فريقك الميداني قبل التوظيف أو الشراء بحساسية ±٢٠٪' },
  { id: 'aging', title: 'حاسبة أعمار الديون وحدود الائتمان', icon: Wallet,
    desc: 'وزع ذممك على شرائح ٣٠/٦٠/٩٠ يوما واقترح حد ائتمان لكل عميل' },
] as const;

const nf = (n: number) => new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 2 }).format(n);
const Num = ({ label, value, set, min = 0, step = 1 }: { label: string; value: number; set: (n: number) => void; min?: number; step?: number }) => (
  <label className="block">
    <span className="block text-[11px] text-[#6b6357] mb-1">{label}</span>
    <input type="number" inputMode="decimal" min={min} step={step} value={value}
      onChange={(e) => set(Math.max(min, Number(e.target.value) || 0))}
      className="w-full border border-[#E8E0D2] rounded-lg px-3 py-2 text-sm tabular-nums" />
  </label>
);

/* ----------------------------- الأدوات ----------------------------- */

function CommissionTool() {
  const [sales, setSales] = useState(120000);
  const [returns, setReturns] = useState(0);
  const [floor, setFloor] = useState(0);
  const [cap, setCap] = useState(0);
  const [tiers, setTiers] = useState<CommissionTier[]>([
    { from: 0, to: 50000, pct: 1 },
    { from: 50000, to: 100000, pct: 2 },
    { from: 100000, to: Infinity, pct: 3 },
  ]);
  const r = useMemo(() => computeCommission({ sales, returns, floor, cap, tiers }), [sales, returns, floor, cap, tiers]);
  const setTier = (i: number, k: 'from' | 'to' | 'pct', v: number) =>
    setTiers((t) => t.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-4">
        <Num label="إجمالي المبيعات" value={sales} set={setSales} step={1000} />
        <Num label="المرتجعات تخصم" value={returns} set={setReturns} step={500} />
        <Num label="أرضية العمولة 0 = بلا" value={floor} set={setFloor} step={100} />
        <Num label="سقف العمولة 0 = بلا" value={cap} set={setCap} step={100} />
      </div>

      <h3 className="text-sm font-semibold mt-5 mb-2">الشرائح</h3>
      <div className="space-y-2">
        {tiers.map((t, i) => (
          <div key={i} className="grid grid-cols-3 gap-2">
            <Num label="من" value={t.from} set={(v) => setTier(i, 'from', v)} step={1000} />
            <Num label={Number.isFinite(t.to) ? 'إلى' : 'إلى بلا حد'} value={Number.isFinite(t.to) ? t.to : 0} set={(v) => setTier(i, 'to', v || Infinity)} step={1000} />
            <Num label="النسبة %" value={t.pct} set={(v) => setTier(i, 'pct', v)} step={0.25} />
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-lg border border-[#E15A30] p-4">
        <p className="text-xs text-[#6b6357]">أساس الحساب بعد المرتجعات <b className="tabular-nums">{nf(r.base)}</b></p>
        <p className="text-2xl font-bold mt-1 tabular-nums" dir="ltr">{nf(r.total)} <span className="text-xs font-normal">ر.س</span></p>
        {r.adjusted && (
          <p className="text-[11px] text-amber-700 mt-1">
            {r.adjusted === 'floor' ? `رفعت للأرضية المحسوب ${nf(r.raw)})` : `حدت بالسقف المحسوب ${nf(r.raw)})`}
          </p>
        )}
        {r.rows.length > 0 && (
          <table className="w-full mt-3 text-xs">
            <caption className="sr-only">تفصيل الشرائح</caption>
            <thead><tr className="text-[#9A8F7E]"><th className="text-start py-1">الشريحة</th><th className="text-start">المبلغ الخاضع</th><th className="text-start">النسبة</th><th className="text-start">العمولة</th></tr></thead>
            <tbody>
              {r.rows.map((row, i) => (
                <tr key={i} className="border-t border-[#F0EBE0]">
                  <td className="py-1 tabular-nums" dir="ltr">{nf(row.from)} – {Number.isFinite(row.to) ? nf(row.to) : '∞'}</td>
                  <td className="tabular-nums">{nf(row.base)}</td>
                  <td className="tabular-nums">{row.pct}%</td>
                  <td className="tabular-nums font-medium">{nf(row.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function VanTool() {
  const [lines, setLines] = useState<VanLine[]>([
    { code: 'P-101', name: 'عصير برتقال 1 لتر', opening: 20, loaded: 30, sold: 38, returned: 2, damaged: 1, counted: 13, unitCost: 40 },
    { code: 'P-204', name: 'مياه 330 مل', opening: 15, loaded: 40, sold: 44, returned: 0, damaged: 0, counted: 10, unitCost: 12 },
  ]);
  const r = useMemo(() => computeVanReconciliation(lines), [lines]);
  const upd = (i: number, k: keyof VanLine, v: number) => setLines((l) => l.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <caption className="sr-only">تسوية عهدة السيارة</caption>
          <thead><tr className="text-[#9A8F7E]">
            {['الصنف', 'أول اليوم', 'المحمل', 'المباع', 'المرتجع', 'التالف', 'الجرد', 'المتوقع', 'الفرق'].map((h) => (
              <th key={h} className="text-start py-1 px-1 whitespace-nowrap">{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {r.lines.map((l, i) => (
              <tr key={i} className="border-t border-[#F0EBE0]">
                <td className="py-1 px-1 whitespace-nowrap">{l.name || l.code}</td>
                {(['opening', 'loaded', 'sold', 'returned', 'damaged', 'counted'] as const).map((k) => (
                  <td key={k} className="px-1">
                    <input type="number" value={l[k] as number} onChange={(e) => upd(i, k, Number(e.target.value) || 0)}
                      className="w-16 border border-[#E8E0D2] rounded px-1.5 py-1 tabular-nums" />
                  </td>
                ))}
                <td className="px-1 tabular-nums">{nf(l.expected)}</td>
                <td className={`px-1 tabular-nums font-medium ${l.diff < 0 ? 'text-red-600' : l.diff > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                  {l.diff > 0 ? '+' : ''}{nf(l.diff)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-[#E8E0D2] p-3"><p className="text-[11px] text-[#6b6357]">إجمالي العجز وحدات</p><p className="text-xl font-bold text-red-600 tabular-nums">{nf(r.totalShortageUnits)}</p></div>
        <div className="rounded-lg border border-[#E8E0D2] p-3"><p className="text-[11px] text-[#6b6357]">إجمالي الزيادة وحدات</p><p className="text-xl font-bold text-amber-600 tabular-nums">{nf(r.totalSurplusUnits)}</p></div>
        <div className="rounded-lg border border-[#E15A30] p-3"><p className="text-[11px] text-[#6b6357]">قيمة العجز</p><p className="text-xl font-bold tabular-nums" dir="ltr">{nf(r.totalShortageValue)} ر.س</p></div>
      </div>
      <p className="text-[11px] text-[#9A8F7E] mt-2">المتوقع = أول اليوم + المحمل − المباع + المرتجع − التالف</p>
    </>
  );
}

function RepsTool() {
  const [outlets, setOutlets] = useState(300);
  const [vpm, setVpm] = useState(4);
  const [vpd, setVpd] = useState(22);
  const [days, setDays] = useState(24);
  const r = useMemo(() => computeRepsNeeded({ outlets, visitsPerMonth: vpm, visitsPerDay: vpd, workDays: days }), [outlets, vpm, vpd, days]);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-4">
        <Num label="عدد المنافذ" value={outlets} set={setOutlets} min={1} />
        <Num label="زيارات العميل شهريا" value={vpm} set={setVpm} min={1} />
        <Num label="زيارات المندوب يوميا" value={vpd} set={setVpd} min={1} />
        <Num label="أيام العمل شهريا" value={days} set={setDays} min={1} />
      </div>
      {!r.valid ? (
        <p className="mt-5 text-sm bg-[#FBEBE2] border border-[#F0C9B6] rounded-lg p-3">أدخل زيارات يومية وأيام عمل أكبر من صفر</p>
      ) : (
        <div className="mt-5 rounded-lg border border-[#E15A30] p-4">
          <p className="text-xs text-[#6b6357]">إجمالي الزيارات المطلوبة شهريا <b className="tabular-nums">{nf(r.totalVisits)}</b> سعة المندوب <b className="tabular-nums">{nf(r.capacityPerRep)}</b></p>
          <p className="text-3xl font-bold mt-2 tabular-nums">{r.reps} <span className="text-sm font-normal">مندوبا</span></p>
          <p className="text-xs text-[#6b6357] mt-1">
            بحساسية ±٢٠٪ على الإنتاجية بين <b className="tabular-nums">{r.low}</b> و<b className="tabular-nums">{r.high}</b>
          </p>
        </div>
      )}
    </>
  );
}

function AgingTool() {
  const [rows, setRows] = useState([
    { amount: 12000, daysOverdue: 0 },
    { amount: 8000, daysOverdue: 20 },
    { amount: 5000, daysOverdue: 45 },
    { amount: 3000, daysOverdue: 120 },
  ]);
  const [monthly, setMonthly] = useState(30000);
  const [payDays, setPayDays] = useState(30);
  const r = useMemo(() => computeAging(rows, monthly, payDays), [rows, monthly, payDays]);
  const upd = (i: number, k: 'amount' | 'daysOverdue', v: number) => setRows((l) => l.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 mb-4">
        <Num label="متوسط مبيعات العميل شهريا" value={monthly} set={setMonthly} step={1000} />
        <Num label="مدة السداد المتفقة يوما" value={payDays} set={setPayDays} min={1} />
      </div>
      <h3 className="text-sm font-semibold mb-2">الفواتير المستحقة</h3>
      <div className="space-y-2">
        {rows.map((x, i) => (
          <div key={i} className="grid grid-cols-2 gap-2">
            <Num label="المبلغ" value={x.amount} set={(v) => upd(i, 'amount', v)} step={500} />
            <Num label="أيام التأخير 0 = غير مستحق" value={x.daysOverdue} set={(v) => upd(i, 'daysOverdue', v)} />
          </div>
        ))}
      </div>
      <div className="mt-5 rounded-lg border border-[#E15A30] p-4">
        <p className="text-xs text-[#6b6357]">إجمالي الذمم <b className="tabular-nums">{nf(r.total)}</b> المتأخر <b className="tabular-nums text-red-600">{nf(r.overdueTotal)}</b></p>
        <table className="w-full text-xs mt-3">
          <caption className="sr-only">شرائح أعمار الدين</caption>
          <tbody>
            {r.buckets.map((b) => (
              <tr key={b.label} className="border-t border-[#F0EBE0]">
                <td className="py-1.5">{b.label}</td>
                <td className="tabular-nums text-end">{nf(b.amount)}</td>
                <td className="text-end text-[#9A8F7E]">{b.count} فاتورة</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm mt-3">حد ائتمان مقترح <b className="tabular-nums" dir="ltr">{nf(r.suggestedLimit)} ر.س</b></p>
        <p className="text-[11px] text-[#9A8F7E] mt-1">= متوسط المبيعات الشهرية × مدة السداد ÷ ٣٠ اضبطه بحسب تاريخ العميل معك</p>
      </div>
    </>
  );
}

/* ----------------------------- الصفحة ----------------------------- */

export default function FreeToolsPage() {
  const { tool } = useParams();
  const lang = useLang((s) => s.lang);
  const dir = useDir();
  const active = TOOLS.find((t) => t.id === tool);
  const arPath = active ? `/free/${active.id}` : '/free';
  const seo = seoUrls(arPath, lang);

  useSeo({
    title: active ? `${active.title} أداة مجانية | Field Sales` : 'أدوات مجانية لشركات التوزيع | Field Sales',
    description: active ? `${active.desc} تعمل في متصفحك بلا تسجيل ولا إرسال بيانات` :
      'أدوات حساب مجانية لشركات التوزيع عمولة المندوب المتدرجة تسوية عهدة السيارة تحجيم الفريق الميداني أعمار الدين وحد الائتمان بلا تسجيل',
    canonical: seo.canonical,
    locale: lang,
  });

  if (tool && !active) return <Navigate to="/free" replace />;

  return (
    <div dir={dir} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]">
      <header className="border-b border-[#E8E0D2] bg-white/70 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to={pathForLocale('/', lang)} className="flex items-center gap-2 text-sm text-[#6b6357]">
            <ArrowLeft size={16} className={dir === 'rtl' ? 'rotate-180' : ''} />
            <BrandIcon size={22} /><span>الرئيسية</span>
          </Link>
          <LanguageToggle variant="light" />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {!active ? (
          <>
            <h1 className="text-2xl sm:text-3xl font-bold">أدوات مجانية لشركات التوزيع</h1>
            <p className="text-[#6b6357] mt-2 max-w-2xl leading-relaxed">
              تعمل في متصفحك بالكامل <strong>لا تسجيل ولا يرسل أي رقم تدخله إلى خوادمنا</strong>.
            </p>
            <ul className="grid gap-3 sm:grid-cols-2 mt-6">
              {TOOLS.map((t) => (
                <li key={t.id}>
                  <Link to={`/free/${t.id}`} className="flex gap-3 bg-white border border-[#E8E0D2] rounded-xl p-4 hover:border-[#E15A30]">
                    <t.icon size={20} className="text-[#E15A30] shrink-0 mt-0.5" />
                    <span>
                      <span className="font-semibold block">{t.title}</span>
                      <span className="text-xs text-[#6b6357] block mt-1 leading-relaxed">{t.desc}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <h1 className="text-2xl sm:text-3xl font-bold">{active.title}</h1>
            <p className="text-[#6b6357] mt-2 leading-relaxed">{active.desc}</p>

            <section className="mt-6 bg-white border border-[#E8E0D2] rounded-xl p-5">
              {active.id === 'commission' && <CommissionTool />}
              {active.id === 'van' && <VanTool />}
              {active.id === 'reps' && <RepsTool />}
              {active.id === 'aging' && <AgingTool />}
            </section>

            <p className="text-[11px] text-[#9A8F7E] mt-3">
              الحساب يجري في متصفحك ولا يرسل شيء لخوادمنا الأرقام التي تدخلها افتراضاتك أنت
            </p>

            {/* الجسر يذكر ما تعجز عنه الأداة لا ما يتفوّق فيه المنتج */}
            <section className="mt-6 bg-white border border-[#E8E0D2] rounded-xl p-5">
              <h2 className="font-semibold text-sm">حين تصير الأداة غير كافية</h2>
              <p className="text-xs text-[#6b6357] mt-2 leading-relaxed">
                هذه الأداة تحسب حالة واحدة الآن إن كنت تكرر هذا الحساب لكل مندوب كل يوم 
                فField Sales يحسبه تلقائيا من بيانات فواتيرك ومخزون سياراتك ويعمل
                <strong> حتى بلا إنترنت</strong> في الميدان
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to={pathForLocale('/pricing', lang)} className="text-sm border border-[#E8E0D2] rounded-lg px-3 py-2">شاهد الأسعار</Link>
                <a href={waHref(arPath, { lang })} target="_blank" rel="noopener noreferrer"
                   className="inline-flex items-center gap-2 bg-[#25D366] text-white rounded-lg px-3 py-2 text-sm">
                  <MessageCircle size={15} />تحدث معنا
                </a>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
