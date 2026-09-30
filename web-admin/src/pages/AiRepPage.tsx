import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, EyeOff, Info, MapPin, Save, Sparkles, Tags, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { aiRepApi, productApi, salesRepApi } from '../api/client';
import { useAiRepTr } from '../i18n/aiRepPhrases';
import { activeLocale } from '../utils/format';
import { useAuthStore } from '../store/authStore';
import AiLearningPanel from './AiLearningPanel';

/**
 * المندوب الذكي AI — صفحة إدارة الشركة:
 *   0) ما يعمل الآن بحسب مفاتيح المنصّة: المسح التلقائي من خرائط Google العامة بلا مفتاح (التوجيه بالتقييم والفتح والمسافة)،
 *      ودراسة المراجعات بمفتاح الأماكن، والعقل يكتب التوجيه والدراسة بمفتاحه.
 *   1) جاهزية البيانات: التوقّع لكل محل يُبنى من عملاء الشركة المشابهين (النوع نفسه، بموقع، بمبيعات منتظمة).
 *   2) الإعدادات: أنواع المحلات المستهدفة، ونطاق البحث، والمنتجات ذات الأولوية، ومن يستخدم الميزة، وطريقة التعلّم.
 *      حقول الأرقام تُحفظ نصّاً أثناء الكتابة وتُضبط بحدودها عند الخروج منها.
 *   3) «ما تعلّمه العقل»: حلقة التعلّم الليلية بأرقامها قبل/بعد ودروسها ونسخها (AiLearningPanel).
 *   4) المحلات المخفية عن المسح («أُغلق نهائياً / لم أجده» مؤكَّداً): من أبلغ ومتى، و«أعد إظهاره».
 *   5) تصنيف العملاء: نوع كل منفذ — مقترحٌ من الاسم، والإدارة تؤكّده (يميّز «ربما عميل حالي» في المسح؛ بصلاحية إدارة العملاء).
 */

type LearningMode = 'AUTO' | 'REVIEW' | 'OFF';
interface Settings {
  targetOutletTypes: string[]; searchRadiusM: number; priorityProductIds: string[]; estimateWindowMonths: number;
  minPeers: number; showMoney: boolean; repScope: 'ALL' | 'SELECTED'; repIds: string[]; dailySearchesPerRep: number; playbook: string | null;
  advisorEnabled: boolean; dailyChatTurnsPerRep: number;
  /** حلقة التعلّم (الخادم يعيدهما بافتراضيَّي AUTO و٢٠) */
  learningMode?: LearningMode; holdoutPct?: number;
}
const HOLDOUTS = [0, 10, 20, 30];
interface TypeRow { code: string; label: string; targeted: boolean; classified: number; withLocation: number; withRegularSales: number; ready: boolean }
interface Overview {
  settings: Settings; outletTypes: { code: string; label: string }[]; placesConfigured: boolean; mapsConfigured?: boolean; advisorConfigured?: boolean;
  readiness: { window: { from: string; to: string }; unclassified: number; classifiedWithoutLocation: number; perType: TypeRow[] };
}
interface ClassRow { id: string; name: string; businessName: string | null; district: string | null; city: string | null; outletType: string | null; suggested: string | null; hasLocation: boolean }

const RADII = [500, 1000, 2000, 3000, 5000, 10000];

type ApiErr = { response?: { data?: { message?: string } } } | null | undefined;
const apiMessage = (e: unknown): string | undefined => (e as ApiErr)?.response?.data?.message;

/**
 * حقل رقم بحدّين: النصّ كما يُكتب (المسح ثم «20» لا يقفز إلى الحدّ الأدنى مع أول خانة)، والقيمة تُعتمد متى صحّت
 * ضمن الحدّين، وتُضبط بهما عند الخروج من الحقل.
 */
function BoundedNumber({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [raw, setRaw] = useState(String(value));
  useEffect(() => { setRaw(prev => (Number(prev) === value ? prev : String(value))); }, [value]);
  return (
    <input type="number" inputMode="numeric" min={min} max={max} className="input mt-1" value={raw}
      onChange={e => {
        setRaw(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isInteger(n) && n >= min && n <= max) onChange(n);
      }}
      onBlur={() => {
        const n = Math.round(Number(raw));
        const v = Number.isFinite(n) && raw.trim() !== '' ? Math.max(min, Math.min(max, n)) : value;
        setRaw(String(v));
        if (v !== value) onChange(v);
      }} />
  );
}

export default function AiRepPage() {
  const tr = useAiRepTr();
  const qc = useQueryClient();
  const canCustomers = useAuthStore(s => s.user?.canManageCustomers !== false || !!s.impersonating);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['ai-rep', 'settings'],
    queryFn: async () => (await aiRepApi.settings()).data.data as Overview,
  });
  const { data: products } = useQuery({
    queryKey: ['ai-rep', 'products'],
    queryFn: async () => ((await productApi.list({ limit: 500, status: 'ACTIVE' })).data.data ?? []) as { id: string; name: string; unit: string }[],
  });
  const { data: reps } = useQuery({
    queryKey: ['ai-rep', 'reps'],
    queryFn: async () => ((await salesRepApi.list({ limit: 500 })).data.data ?? []) as { id: string; name: string; isActive?: boolean }[],
  });

  const [form, setForm] = useState<Settings | null>(null);
  useEffect(() => { if (data?.settings && !form) setForm(data.settings); }, [data, form]);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm(f => (f ? { ...f, [k]: v } : f));
  const toggleIn = (k: 'targetOutletTypes' | 'priorityProductIds' | 'repIds', id: string) =>
    setForm(f => (f ? { ...f, [k]: f[k].includes(id) ? f[k].filter(x => x !== id) : [...f[k], id] } : f));

  const save = useMutation({
    mutationFn: async (s: Settings) => (await aiRepApi.saveSettings(s)).data,
    onSuccess: (res: { data?: { settings?: Settings } }) => {
      toast.success(tr('تم حفظ إعدادات المندوب الذكي'));
      if (res.data?.settings) setForm(res.data.settings);
      qc.invalidateQueries({ queryKey: ['ai-rep', 'settings'] });
      qc.invalidateQueries({ queryKey: ['ai-rep', 'learning'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) => toast.error(e.response?.data?.message || tr('تعذّر الحفظ')),
  });

  const [productFilter, setProductFilter] = useState('');
  const shownProducts = useMemo(() => {
    const q = productFilter.trim();
    return (products ?? []).filter(p => !q || p.name.includes(q)).slice(0, 60);
  }, [products, productFilter]);

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" /></div>;
  if (isError || !data) return <div className="card text-sm text-red-600">{apiMessage(error) || tr('تعذّر تحميل إعدادات المندوب الذكي')}</div>;

  const r = data.readiness;
  const targeted = r.perType.filter(t => t.targeted);
  const activeReps = (reps ?? []).filter(x => x.isActive !== false);
  const activeIds = new Set(activeReps.map(x => x.id));
  // «محدّدون» بلا مندوب نشط مختار: الزرّ يختفي عن الجميع بلا تفسير ⇒ لا يُحفظ (والخادم يرفضه)
  const noRepSelected = !!form && form.repScope === 'SELECTED' && !!reps && !form.repIds.some(id => activeIds.has(id));

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Sparkles className="text-[#E15A30]" size={22} /> {tr('المندوب الذكي')}</h1>
          <p className="text-sm text-[#6E6557] mt-1">{tr('يفتح المندوب «المندوب الذكي» فتُمسح المحلات حوله تلقائياً من خرائط Google، ويعرف بأي الفرص الجديدة يبدأ ولماذا، ولكل محل دراسة من تقييمه وعدد مقيّميه وحالة فتحه — ثم يسجّل نتيجة زيارته أو يضيفه عميلاً')}</p>
        </div>
      </div>

      {/* ما يعمل الآن بحسب مفاتيح المنصّة — المسح بلا مفتاح حيّ، فلا يوحي غياب المفتاح بأن الميزة مطفأة */}
      <div className="flex items-start gap-2 rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] p-3 text-sm text-[#44403a]">
        <MapPin size={18} className="shrink-0 mt-0.5 text-[#E15A30]" />
        <div className="space-y-1">
          <p>{data.placesConfigured
            ? tr('مفتاح Google الرسمي مضبوط: المسح بالبحث الرسمي، وفتح أي محل يضيف دراسة من مراجعات عملائه النصية')
            : tr('المسح يعمل الآن من خرائط Google العامة بلا مفتاح: المحلات حول المندوب، والتوجيه بالتقييم وحالة الفتح والمسافة — بلا مراجعات نصية. حين يُضبط مفتاح Google الرسمي يضيف فتحُ المحل دراسةً من مراجعات عملائه')}</p>
          {!data.mapsConfigured && <p className="text-xs text-[#6E6557]">{tr('الخريطة التفاعلية تحتاج مفتاح عرض الخريطة — المندوب يرى الآن خريطة Google المضمّنة ويفتح المحلات من القائمة')}</p>}
        </div>
      </div>

      {/* جاهزية البيانات */}
      <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
        <p className="font-bold text-[#1F1A13] mb-1 flex items-center gap-2"><CheckCircle2 size={18} className="text-[#E15A30]" /> {tr('جاهزية بياناتك للتوقّع')}</p>
        <p className="text-xs text-[#6E6557] mb-3">
          {tr('يحتاج التوقّع لكل نوع محل خمسة عملاء على الأقل من النوع نفسه، لهم موقع على الخريطة ومبيعات منتظمة (ثلاثة أشهر فعلية وفاتورة خلال ٦٠ يوماً)')}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-right text-xs text-[#6E6557] border-b border-[#E9E1D3]">
              <th className="py-2 font-medium">{tr('نوع المحل')}</th><th className="py-2 font-medium">{tr('مصنّفون')}</th>
              <th className="py-2 font-medium">{tr('بموقع')}</th><th className="py-2 font-medium">{tr('بمبيعات منتظمة')}</th><th className="py-2 font-medium">{tr('التوقّع')}</th>
            </tr></thead>
            <tbody>
              {targeted.map(t => (
                <tr key={t.code} className="border-b border-[#F4EEE3]">
                  <td className="py-2 font-medium">{tr(t.label)}</td>
                  <td className="py-2">{t.classified}</td>
                  <td className="py-2">{t.withLocation}</td>
                  <td className="py-2">{t.withRegularSales}</td>
                  <td className="py-2">{t.ready
                    ? <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle2 size={14} /> {tr('جاهز')}</span>
                    : <span className="inline-flex items-center gap-1 text-amber-700"><XCircle size={14} /> {tr('يحتاج بيانات')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-[#6E6557] mt-3">
          {tr('عملاء نشطون بلا تصنيف')}: <b>{r.unclassified}</b> · {tr('مصنّفون بلا موقع')}: <b>{r.classifiedWithoutLocation}</b>
        </p>
      </div>

      {/* الإعدادات */}
      {form && (
        <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-5">
          <p className="font-bold text-[#1F1A13] flex items-center gap-2"><Sparkles size={18} className="text-[#E15A30]" /> {tr('إعدادات المندوب الذكي')}</p>

          <div>
            <p className="label">{tr('أنواع المحلات المستهدفة')}</p>
            <div className="flex flex-wrap gap-2">
              {data.outletTypes.map(t => {
                const on = form.targetOutletTypes.includes(t.code);
                return (
                  <button key={t.code} type="button" onClick={() => toggleIn('targetOutletTypes', t.code)}
                    className={`rounded-xl border-2 px-3 py-1.5 text-sm ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'border-[#E9E1D3] bg-white text-[#44403a]'}`}>
                    {tr(t.label)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <label className="block">
              <span className="label">{tr('نطاق البحث حول المندوب')}</span>
              <select className="input mt-1" value={form.searchRadiusM} onChange={e => set('searchRadiusM', Number(e.target.value))}>
                {RADII.map(m => <option key={m} value={m}>{m < 1000 ? `${m} ${tr('متر')}` : `${m / 1000} ${tr('كم')}`}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">{tr('فترة المبيعات التي يُبنى عليها التوقّع')}</span>
              <select className="input mt-1" value={form.estimateWindowMonths} onChange={e => set('estimateWindowMonths', Number(e.target.value))}>
                {[3, 6, 9, 12].map(m => <option key={m} value={m}>{m} {tr('أشهر')}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">{tr('مسح/دراسة المحلات يومياً لكل مندوب (يشمل المسح التلقائي عند الفتح)')}</span>
              <BoundedNumber value={form.dailySearchesPerRep} min={5} max={100} onChange={n => set('dailySearchesPerRep', n)} />
            </label>
            <label className="block">
              <span className="label">{tr('أقل عدد محلات مشابهة لعرض رقم')}</span>
              <BoundedNumber value={form.minPeers} min={5} max={20} onChange={n => set('minPeers', n)} />
              <span className="text-[11px] text-[#8A8178]">{tr('لا ينزل عن ٥ حمايةً لخصوصية عملائك')}</span>
            </label>
            <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer select-none bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-3 py-2.5 self-end">
              <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={form.showMoney} onChange={e => set('showMoney', e.target.checked)} />
              {tr('عرض القيم المالية المتوقعة للمندوب')}
            </label>
          </div>

          <div>
            <p className="label">{tr('منتجات ذات أولوية (تُقترح أولاً في دراسة المحل)')}</p>
            <input className="input mb-2" placeholder={tr('ابحث عن منتج')} value={productFilter} onChange={e => setProductFilter(e.target.value)} />
            <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
              {shownProducts.map(p => {
                const on = form.priorityProductIds.includes(p.id);
                return (
                  <button key={p.id} type="button" onClick={() => toggleIn('priorityProductIds', p.id)}
                    className={`rounded-lg border px-2.5 py-1 text-xs ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'border-[#E9E1D3] text-[#44403a]'}`}>
                    {p.name}
                  </button>
                );
              })}
            </div>
            {/* منتج أولوية أُوقف أو خارج القائمة: يظهر هنا ليُزال — لا يبقى مختاراً خفياً (الخادم يُسقطه عند الحفظ أيضاً) */}
            {(() => {
              const known = new Set((products ?? []).map(x => x.id));
              const missing = products ? form.priorityProductIds.filter(id => !known.has(id)) : [];
              return missing.length ? (
                <div className="flex flex-wrap gap-2 mt-2">
                  {missing.map(id => (
                    <button key={id} type="button" onClick={() => toggleIn('priorityProductIds', id)} className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
                      {tr('منتج غير ظاهر في القائمة')} ✕
                    </button>
                  ))}
                </div>
              ) : null;
            })()}
            <p className="text-[11px] text-[#8A8178] mt-1">{tr('المختار')}: {form.priorityProductIds.length} / 20</p>
          </div>

          <div>
            <p className="label">{tr('من يستخدم المندوب الذكي')}</p>
            <div className="flex gap-2 mb-2">
              {(['ALL', 'SELECTED'] as const).map(s => (
                <button key={s} type="button" onClick={() => set('repScope', s)}
                  className={`rounded-xl border-2 px-3 py-1.5 text-sm ${form.repScope === s ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'border-[#E9E1D3] bg-white text-[#44403a]'}`}>
                  {s === 'ALL' ? tr('كل المناديب') : tr('مناديب محدّدون')}
                </button>
              ))}
            </div>
            {form.repScope === 'SELECTED' && (
              <div className="flex flex-wrap gap-2">
                {activeReps.map(x => {
                  const on = form.repIds.includes(x.id);
                  return (
                    <button key={x.id} type="button" onClick={() => toggleIn('repIds', x.id)}
                      className={`rounded-lg border px-2.5 py-1 text-xs ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'border-[#E9E1D3] text-[#44403a]'}`}>
                      {x.name}
                    </button>
                  );
                })}
                {/* مختارٌ حُذف أو أُوقف: يظهر ليُزال — لا يبقى مختاراً خفياً (الخادم يُسقط المحذوف عند الحفظ أيضاً) */}
                {reps && form.repIds.filter(id => !activeIds.has(id)).map(id => {
                  const x = reps.find(r => r.id === id);
                  return (
                    <button key={id} type="button" onClick={() => toggleIn('repIds', id)} title={tr('أزله من القائمة')}
                      className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
                      {x ? `${x.name} (${tr('موقوف')})` : tr('مندوب محذوف')} ✕
                    </button>
                  );
                })}
              </div>
            )}
            {noRepSelected && <p className="text-xs text-red-600 mt-1">{tr('اختر مندوباً واحداً على الأقل — وإلا لن يظهر المندوب الذكي لأي مندوب')}</p>}
          </div>

          <div className="rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] p-3 space-y-3">
            <p className="text-sm font-semibold text-[#1F1A13]">{tr('المستشار الذكي (العقل)')}</p>
            <p className="text-xs text-[#6E6557]">{data.advisorConfigured
              ? tr('العقل مفعّل لدى مزوّد الخدمة: يكتب توجيه المسح (بأي المحلات يبدأ المندوب ولماذا) ودراسة المحل ملتزماً بدليل البيع — وحين يتعذّر أو تنفد تحليلاته اليومية يبقى التوجيه الحتمي')
              : tr('العقل لم يُفعَّل بعد لدى مزوّد الخدمة — التوجيه الآن حتمي: بالتقييم وحالة الفتح والمسافة، والدراسة من ملف المحل')}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer select-none">
                <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={form.advisorEnabled} onChange={e => set('advisorEnabled', e.target.checked)} />
                {tr('تفعيل المستشار الذكي لمناديب الشركة')}
              </label>
              <label className="block">
                <span className="label">{tr('تحليلات العقل يومياً لكل مندوب (توجيه المسح + دراسة المحل)')}</span>
                <BoundedNumber value={form.dailyChatTurnsPerRep} min={5} max={150} onChange={n => set('dailyChatTurnsPerRep', n)} />
              </label>
            </div>
          </div>

          <div className="rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] p-3 space-y-3">
            <p className="text-sm font-semibold text-[#1F1A13]">{tr('حلقة التعلّم')}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <span className="label">{tr('طريقة التعلّم')}</span>
                <select className="input mt-1" value={form.learningMode ?? 'AUTO'} onChange={e => set('learningMode', e.target.value as LearningMode)}>
                  <option value="AUTO">{tr('تلقائي')}</option>
                  <option value="REVIEW">{tr('بمراجعتي')}</option>
                  <option value="OFF">{tr('متوقف')}</option>
                </select>
                <span className="text-[11px] text-[#8A8178]">
                  {(form.learningMode ?? 'AUTO') === 'OFF' ? tr('متوقف: المسح والدراسة بالترتيب الافتراضي بلا دروس، وتُسجَّل نتائج الزيارات فقط')
                    : form.learningMode === 'REVIEW' ? tr('بمراجعتي: دروس المراجعة الذاتية تنتظر اعتمادك قبل تجربتها')
                      : tr('تلقائي: يعتمد العقل ما يثبت بالأرقام، ودروس المراجعة الذاتية تبدأ تجربةً قبل اعتمادها')}
                </span>
              </label>
              <label className="block">
                <span className="label">{tr('نسبة المجموعة الضابطة')}</span>
                <select className="input mt-1" value={form.holdoutPct ?? 20} onChange={e => set('holdoutPct', Number(e.target.value))}>
                  {HOLDOUTS.map(p => <option key={p} value={p}>{new Intl.NumberFormat(activeLocale(), { style: 'percent' }).format(p / 100)}</option>)}
                </select>
                <span className="text-[11px] text-[#8A8178]">{tr('أيام من عمل المناديب تبقى على الترتيب الافتراضي بلا دروس، لقياس أثر التعلّم بإنصاف')}</span>
              </label>
            </div>
          </div>

          <label className="block">
            <span className="label">{tr('دليل البيع (يقرؤه المستشار الذكي)')}</span>
            <textarea className="input mt-1 min-h-[96px]" maxLength={4000} value={form.playbook ?? ''} onChange={e => set('playbook', e.target.value)}
              placeholder={tr('مثال: الحد الأدنى للطلب ٥ كراتين، عرض الشهر ١٠+١ على المياه، الآجل ٣٠ يوماً للعملاء بسجل تجاري')} />
          </label>

          <div className="flex justify-end">
            <button type="button" className="btn-primary inline-flex items-center gap-2" disabled={save.isPending || form.targetOutletTypes.length === 0 || noRepSelected}
              onClick={() => save.mutate(form)}>
              <Save size={16} /> {save.isPending ? tr('جاري الحفظ') : tr('حفظ الإعدادات')}
            </button>
          </div>
        </div>
      )}

      <AiLearningPanel />

      <HiddenOutletsSection />

      {canCustomers ? (
        <ClassifySection outletTypes={data.outletTypes} onSaved={() => qc.invalidateQueries({ queryKey: ['ai-rep', 'settings'] })} />
      ) : (
        <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 text-sm text-[#6E6557] flex items-start gap-2">
          <Info size={18} className="shrink-0 mt-0.5 text-[#E15A30]" />
          <span><b className="text-[#1F1A13]">{tr('تصنيف أنواع العملاء')}</b> — {tr('تحتاج صلاحية إدارة العملاء')}</span>
        </div>
      )}
    </div>
  );
}

interface HiddenOutlet {
  id: string; outletTypeLabel: string; name: string | null; mapsUri: string | null;
  reportedAt: string | null; hiddenUntil: string | null; reports: { repName: string | null; at: string }[];
}

/**
 * المحلات المخفية عن مسح المناديب: أبلغ مندوبان (أو مندوب في يومين) أنها أُغلقت نهائياً أو لم يجدوها — تُخفى مدةً ثم
 * تعود موسومة. القائمة بمن أبلغ ومتى، و«أعد إظهاره» لما أُخفي خطأً. اسم المحل من Google لا يُخزَّن ⇒ النوع ورابط الخريطة.
 */
function HiddenOutletsSection() {
  const tr = useAiRepTr();
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['ai-rep', 'hidden-outlets'],
    queryFn: async () => (await aiRepApi.hiddenOutlets()).data.data as { memoryDays: number; items: HiddenOutlet[] },
  });
  const unhide = useMutation({
    mutationFn: async (id: string) => (await aiRepApi.unhideOutlet(id)).data,
    onSuccess: () => {
      toast.success(tr('عاد المحل إلى مسح المناديب'));
      qc.invalidateQueries({ queryKey: ['ai-rep', 'hidden-outlets'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) => toast.error(e.response?.data?.message || tr('تعذّر الحفظ')),
  });
  const day = (d: string | null) => (d ? new Date(d).toLocaleDateString(activeLocale()) : '—');
  const loadErr = (error as { response?: { data?: { message?: string } } } | null)?.response?.data?.message;

  return (
    <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
      <p className="font-bold text-[#1F1A13] mb-1 flex items-center gap-2"><EyeOff size={18} className="text-[#E15A30]" /> {tr('محلات مخفية عن المسح')}</p>
      <p className="text-xs text-[#6E6557] mb-3">{tr('محلٌّ أبلغ مندوبان (أو مندوب في يومين مختلفين) أنه أُغلق نهائياً أو لم يجده يُخفى عن مسح المناديب مدةً ثم يعود موسوماً — أعد إظهار ما أُخفي خطأً')}</p>
      {isLoading ? (
        <p className="py-4 text-center text-xs text-[#6E6557]">{tr('جاري التحميل')}</p>
      ) : isError ? (
        <p className="py-4 text-center text-xs text-red-600">{loadErr || tr('تعذّر تحميل المحلات المخفية')}</p>
      ) : !data?.items.length ? (
        <p className="py-4 text-center text-xs text-[#6E6557]">{tr('لا محلات مخفية الآن')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-right text-xs text-[#6E6557] border-b border-[#E9E1D3]">
              <th className="py-2 font-medium">{tr('نوع المحل')}</th><th className="py-2 font-medium">{tr('من أبلغ')}</th>
              <th className="py-2 font-medium">{tr('مخفي حتى')}</th><th className="py-2" />
            </tr></thead>
            <tbody>
              {data.items.map(o => (
                <tr key={o.id} className="border-b border-[#F4EEE3] align-top">
                  <td className="py-2">
                    <p className="font-medium">{o.name || tr(o.outletTypeLabel)}</p>
                    {o.name && <p className="text-[11px] text-[#8A8178]">{tr(o.outletTypeLabel)}</p>}
                    {o.mapsUri && <a href={o.mapsUri} target="_blank" rel="noreferrer" className="text-[11px] text-[#1D4ED8] underline">{tr('افتح في خرائط Google')}</a>}
                  </td>
                  <td className="py-2 text-xs text-[#44403a]">
                    {o.reports.length
                      ? o.reports.map((r, i) => <p key={i}>{r.repName || '—'} · {day(r.at)}</p>)
                      : day(o.reportedAt)}
                  </td>
                  <td className="py-2 text-xs text-[#44403a]">{day(o.hiddenUntil)}</td>
                  <td className="py-2 text-left">
                    <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={unhide.isPending} onClick={() => unhide.mutate(o.id)}>
                      {tr('أعد إظهاره')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** تصنيف أنواع العملاء — المقترح من الاسم معبّأ، والإدارة تؤكّده أو تغيّره. */
function ClassifySection({ outletTypes, onSaved }: { outletTypes: { code: string; label: string }[]; onSaved: () => void }) {
  const tr = useAiRepTr();
  const [filter, setFilter] = useState<'unclassified' | 'all'>('unclassified');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['ai-rep', 'classify', filter, search, page],
    queryFn: async () => {
      const res = await aiRepApi.classifyList({ filter, page, limit: 100, ...(search.trim() && { search: search.trim() }) });
      return { rows: res.data.data as ClassRow[], total: (res.data.pagination?.total ?? 0) as number };
    },
  });
  // المقترح يُعبّأ مبدئياً؛ اختيار الإدارة يغلبه
  const valueOf = (row: ClassRow) => picks[row.id] ?? row.outletType ?? row.suggested ?? '';
  const changed = (data?.rows ?? []).filter(row => valueOf(row) !== (row.outletType ?? ''));

  const save = useMutation({
    mutationFn: async () => (await aiRepApi.classify(changed.map(row => ({ customerId: row.id, outletType: valueOf(row) || null })))).data,
    onSuccess: (res: { data?: { updated?: number } }) => {
      toast.success(`${tr('تم تصنيف')} ${res.data?.updated ?? 0} ${tr('عميل')}`);
      setPicks({}); refetch(); onSaved();
    },
    onError: (e: { response?: { data?: { message?: string } } }) => toast.error(e.response?.data?.message || tr('تعذّر الحفظ')),
  });

  return (
    <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
      <p className="font-bold text-[#1F1A13] mb-1 flex items-center gap-2"><Tags size={18} className="text-[#E15A30]" /> {tr('تصنيف أنواع العملاء')}</p>
      <p className="text-xs text-[#6E6557] mb-3">{tr('النوع المقترح مستنتج من اسم العميل — راجعه ثم احفظ. يُستعمل لتمييز «ربما عميل حالي» على الخريطة')}</p>
      <div className="flex flex-wrap gap-2 mb-3">
        {(['unclassified', 'all'] as const).map(f => (
          <button key={f} type="button" onClick={() => { setFilter(f); setPage(1); setPicks({}); }}
            className={`rounded-xl border-2 px-3 py-1.5 text-sm ${filter === f ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'border-[#E9E1D3] bg-white text-[#44403a]'}`}>
            {f === 'unclassified' ? tr('غير المصنّفين') : tr('كل العملاء')}
          </button>
        ))}
        <input className="input flex-1 min-w-[180px]" placeholder={tr('ابحث بالاسم')} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
      </div>
      {isLoading ? (
        <p className="py-4 text-center text-xs text-[#6E6557]">{tr('جاري التحميل')}</p>
      ) : isError ? (
        <p className="py-4 text-center text-xs text-red-600">{apiMessage(error) || tr('تعذّر تحميل قائمة العملاء')}</p>
      ) : !data?.rows.length ? (
        <p className="py-4 text-center text-xs text-[#6E6557]">{filter === 'unclassified' ? tr('كل عملائك مصنّفون') : tr('لا نتائج')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-right text-xs text-[#6E6557] border-b border-[#E9E1D3]">
              <th className="py-2 font-medium">{tr('العميل')}</th><th className="py-2 font-medium">{tr('الحي')}</th><th className="py-2 font-medium">{tr('الموقع')}</th><th className="py-2 font-medium">{tr('نوع المحل')}</th>
            </tr></thead>
            <tbody>
              {data.rows.map(row => (
                <tr key={row.id} className="border-b border-[#F4EEE3]">
                  <td className="py-2">
                    <p className="font-medium">{row.name}</p>
                    {row.businessName && <p className="text-[11px] text-[#8A8178]">{row.businessName}</p>}
                  </td>
                  <td className="py-2 text-xs text-[#6E6557]">{[row.district, row.city].filter(Boolean).join('، ') || '—'}</td>
                  <td className="py-2">{row.hasLocation ? <MapPin size={15} className="text-green-600" /> : <span className="text-[11px] text-amber-700">{tr('بلا موقع')}</span>}</td>
                  <td className="py-2">
                    <select className={`input py-1 text-sm ${!row.outletType && row.suggested && !picks[row.id] ? 'border-dashed' : ''}`}
                      value={valueOf(row)} onChange={e => setPicks(p => ({ ...p, [row.id]: e.target.value }))}>
                      <option value="">{tr('غير مصنّف')}</option>
                      {outletTypes.map(t => <option key={t.code} value={t.code}>{tr(t.label)}</option>)}
                    </select>
                    {!row.outletType && row.suggested && !picks[row.id] && <span className="text-[10px] text-[#8A8178]">{tr('مقترح')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
        <div className="flex items-center gap-2 text-xs text-[#6E6557]">
          <button type="button" className="btn-secondary px-2 py-1" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{tr('السابق')}</button>
          <span>{page} / {Math.max(1, Math.ceil((data?.total ?? 0) / 100))}</span>
          <button type="button" className="btn-secondary px-2 py-1" disabled={page * 100 >= (data?.total ?? 0)} onClick={() => setPage(p => p + 1)}>{tr('التالي')}</button>
        </div>
        <button type="button" className="btn-primary inline-flex items-center gap-2" disabled={!changed.length || save.isPending} onClick={() => save.mutate()}>
          <Save size={16} /> {tr('حفظ التصنيف')} ({changed.length})
        </button>
      </div>
    </div>
  );
}
