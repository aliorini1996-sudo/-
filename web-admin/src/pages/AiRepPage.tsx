import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, KeyRound, MapPin, PlugZap, Save, Sparkles, Tags, Trash2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { aiRepApi, productApi, salesRepApi } from '../api/client';
import { useAiRepTr } from '../i18n/aiRepPhrases';

/**
 * المندوب الذكي AI — صفحة إدارة الشركة:
 *   1) جاهزية البيانات: التوقّع لكل محل يُبنى من عملاء الشركة المشابهين (النوع نفسه، بموقع، بمبيعات منتظمة).
 *   2) الإعدادات: أنواع المحلات المستهدفة، ونطاق البحث، والمنتجات ذات الأولوية، ومن يستخدم الميزة.
 *   3) تصنيف العملاء: نوع كل منفذ — مقترحٌ من الاسم، والإدارة تؤكّده.
 */

interface Settings {
  targetOutletTypes: string[]; searchRadiusM: number; priorityProductIds: string[]; estimateWindowMonths: number;
  minPeers: number; showMoney: boolean; repScope: 'ALL' | 'SELECTED'; repIds: string[]; dailySearchesPerRep: number; playbook: string | null;
  advisorEnabled: boolean; dailyChatTurnsPerRep: number;
}
interface TypeRow { code: string; label: string; targeted: boolean; classified: number; withLocation: number; withRegularSales: number; ready: boolean }
interface Brain {
  provider: string | null; model: string | null; keySet: boolean; keyHint: string | null; updatedAt: string | null; secretsReady: boolean;
  providers: { code: string; label: string; defaultModel: string; keyHelpUrl: string }[];
}
interface Overview {
  settings: Settings; outletTypes: { code: string; label: string }[]; placesConfigured: boolean; mapsConfigured?: boolean; advisorConfigured?: boolean; brain?: Brain;
  readiness: { window: { from: string; to: string }; unclassified: number; classifiedWithoutLocation: number; perType: TypeRow[] };
}
interface ClassRow { id: string; name: string; businessName: string | null; district: string | null; city: string | null; outletType: string | null; suggested: string | null; hasLocation: boolean }

const RADII = [500, 1000, 2000, 3000, 5000, 10000];

export default function AiRepPage() {
  const tr = useAiRepTr();
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
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
    },
    onError: (e: { response?: { data?: { message?: string } } }) => toast.error(e.response?.data?.message || tr('تعذّر الحفظ')),
  });

  const [productFilter, setProductFilter] = useState('');
  const shownProducts = useMemo(() => {
    const q = productFilter.trim();
    return (products ?? []).filter(p => !q || p.name.includes(q)).slice(0, 60);
  }, [products, productFilter]);

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" /></div>;
  if (isError || !data) return <div className="card text-sm text-red-600">{tr('تعذّر تحميل إعدادات المندوب الذكي')}</div>;

  const r = data.readiness;
  const targeted = r.perType.filter(t => t.targeted);

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Sparkles className="text-[#E15A30]" size={22} /> {tr('المندوب الذكي')}</h1>
          <p className="text-sm text-[#6E6557] mt-1">{tr('يقترح على المندوب المحلات القريبة التي لا تشتري منكم بعد، ويتوقّع لكل محل كم يمكن أن يشتري من كل منتج — من مبيعات شركتك الفعلية للمحلات المشابهة')}</p>
        </div>
      </div>

      {!data.placesConfigured ? (
        <div className="flex items-start gap-2 rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] p-3 text-sm text-[#44403a]">
          <MapPin size={18} className="shrink-0 mt-0.5 text-[#E15A30]" />
          <span>{tr('خرائط Google بحساب المندوب: يفتح المندوب خرائط Google كأي مستخدم، ويضيف المحل برابط المشاركة أو بزر «أنا عند المحل الآن»، فيحسب له التوقّع ويوجّهه العقل. البحث التلقائي عن كل المحلات المجاورة يُضاف لاحقاً بمفتاح Google')}</span>
        </div>
      ) : !data.mapsConfigured && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <span>{tr('عرض الخريطة داخل تطبيق المندوب ينتظر مفتاح العرض لدى مزوّد الخدمة — البحث والتوقّع يعملان بالقائمة')}</span>
        </div>
      )}

      {data.brain && <BrainSection brain={data.brain} onSaved={() => qc.invalidateQueries({ queryKey: ['ai-rep', 'settings'] })} />}

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
              <span className="label">{tr('حدّ البحث اليومي لكل مندوب')}</span>
              <input type="number" min={5} max={100} className="input mt-1" value={form.dailySearchesPerRep} onChange={e => set('dailySearchesPerRep', Math.max(5, Math.min(100, Number(e.target.value) || 5)))} />
            </label>
            <label className="block">
              <span className="label">{tr('أقل عدد محلات مشابهة لعرض رقم')}</span>
              <input type="number" min={5} max={20} className="input mt-1" value={form.minPeers} onChange={e => set('minPeers', Math.max(5, Math.min(20, Number(e.target.value) || 5)))} />
              <span className="text-[11px] text-[#8A8178]">{tr('لا ينزل عن ٥ حمايةً لخصوصية عملائك')}</span>
            </label>
            <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer select-none bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-3 py-2.5 self-end">
              <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={form.showMoney} onChange={e => set('showMoney', e.target.checked)} />
              {tr('عرض القيم المالية المتوقعة للمندوب')}
            </label>
          </div>

          <div>
            <p className="label">{tr('منتجات ذات أولوية (تظهر أولاً في التوقّع)')}</p>
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
                {(reps ?? []).filter(x => x.isActive !== false).map(x => {
                  const on = form.repIds.includes(x.id);
                  return (
                    <button key={x.id} type="button" onClick={() => toggleIn('repIds', x.id)}
                      className={`rounded-lg border px-2.5 py-1 text-xs ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'border-[#E9E1D3] text-[#44403a]'}`}>
                      {x.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] p-3 space-y-3">
            <p className="text-sm font-semibold text-[#1F1A13]">{tr('المستشار الذكي (العقل)')}</p>
            <p className="text-xs text-[#6E6557]">{data.advisorConfigured ? tr('العقل جاهز بمفتاح شركتك: يفحص المحلات المجاورة ويعطي المندوب خطة وتوجيهاً ويجيب أسئلته — الأرقام دائماً من بيانات شركتك') : tr('أضف مفتاح الذكاء الاصطناعي لشركتك (أعلى الصفحة) ليعمل العقل — حتى ذلك يحصل المندوب على خطة حتمية من بيانات شركتك')}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer select-none">
                <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={form.advisorEnabled} onChange={e => set('advisorEnabled', e.target.checked)} />
                {tr('تفعيل المستشار الذكي لمناديب الشركة')}
              </label>
              <label className="block">
                <span className="label">{tr('حدّ أسئلة المستشار اليومي لكل مندوب')}</span>
                <input type="number" min={5} max={150} className="input mt-1" value={form.dailyChatTurnsPerRep} onChange={e => set('dailyChatTurnsPerRep', Math.max(5, Math.min(150, Number(e.target.value) || 5)))} />
              </label>
            </div>
          </div>

          <label className="block">
            <span className="label">{tr('دليل البيع (يقرؤه المستشار الذكي)')}</span>
            <textarea className="input mt-1 min-h-[96px]" maxLength={4000} value={form.playbook ?? ''} onChange={e => set('playbook', e.target.value)}
              placeholder={tr('مثال: الحد الأدنى للطلب ٥ كراتين، عرض الشهر ١٠+١ على المياه، الآجل ٣٠ يوماً للعملاء بسجل تجاري')} />
          </label>

          <div className="flex justify-end">
            <button type="button" className="btn-primary inline-flex items-center gap-2" disabled={save.isPending || form.targetOutletTypes.length === 0}
              onClick={() => save.mutate(form)}>
              <Save size={16} /> {save.isPending ? tr('جاري الحفظ') : tr('حفظ الإعدادات')}
            </button>
          </div>
        </div>
      )}

      <ClassifySection outletTypes={data.outletTypes} onSaved={() => qc.invalidateQueries({ queryKey: ['ai-rep', 'settings'] })} />
    </div>
  );
}

/**
 * «العقل»: مفتاح مزوّد الذكاء الاصطناعي الخاص بالشركة (والكلفة على حسابها لدى المزوّد مباشرة).
 * المفتاح لا يعود من الخادم بعد الحفظ — آخر ٤ محارف فقط.
 */
function BrainSection({ brain, onSaved }: { brain: Brain; onSaved: () => void }) {
  const tr = useAiRepTr();
  const [provider, setProvider] = useState(brain.provider ?? brain.providers[0]?.code ?? '');
  const [model, setModel] = useState(brain.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const preset = brain.providers.find(p => p.code === provider);
  const providerChanged = !!brain.provider && provider !== brain.provider;
  const needKey = !brain.keySet || providerChanged;
  const errOf = (e: unknown) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message;

  const save = useMutation({
    mutationFn: async (body: { provider: string; model?: string; apiKey?: string; clearKey?: boolean }) => (await aiRepApi.saveLlm(body)).data,
    onSuccess: (_r: unknown, body) => {
      toast.success(body.clearKey ? tr('أُزيل مفتاح الذكاء الاصطناعي') : tr('تم حفظ إعداد العقل'));
      setApiKey(''); setResult(null); onSaved();
    },
    onError: (e: unknown) => toast.error(errOf(e) || tr('تعذّر الحفظ')),
  });
  const test = useMutation({
    mutationFn: async () => (await aiRepApi.testLlm()).data.data as { ok: boolean; message: string },
    onSuccess: d => setResult(d),
    onError: (e: unknown) => setResult({ ok: false, message: errOf(e) || tr('تعذّر الاختبار') }),
  });

  return (
    <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-3">
      <p className="font-bold text-[#1F1A13] flex items-center gap-2"><KeyRound size={18} className="text-[#E15A30]" /> {tr('العقل: مفتاح الذكاء الاصطناعي لشركتك')}</p>
      <p className="text-xs text-[#6E6557]">{tr('العقل يفحص المحلات المجاورة ويرتّب للمندوب خطة الزيارات ويجيب أسئلته. أنشئ مفتاح API من حساب شركتك لدى المزوّد والصقه هنا — الكلفة على حساب شركتك لدى المزوّد مباشرة، والمفتاح يُحفظ مشفّراً ولا يظهر لأحد بعد الحفظ')}</p>
      {!brain.secretsReady && (
        <p className="text-xs rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-800">{tr('تخزين المفاتيح غير مهيّأ على الخادم — تواصل مع مزوّد الخدمة')}</p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="label">{tr('المزوّد')}</span>
          <select className="input mt-1" value={provider} onChange={e => { setProvider(e.target.value); setModel(''); setResult(null); }}>
            {brain.providers.map(p => <option key={p.code} value={p.code}>{tr(p.label)}</option>)}
          </select>
          {preset && <a href={preset.keyHelpUrl} target="_blank" rel="noreferrer" className="text-[11px] text-[#E15A30] underline">{tr('احصل على مفتاح من موقع المزوّد')}</a>}
        </label>
        <label className="block">
          <span className="label">{tr('النموذج (اختياري)')}</span>
          <input className="input mt-1" dir="ltr" maxLength={120} value={model} placeholder={preset?.defaultModel} onChange={e => setModel(e.target.value.trim())} />
          <span className="text-[11px] text-[#8A8178]">{tr('اتركه فارغاً للنموذج الموصى به')}</span>
        </label>
      </div>
      <label className="block">
        <span className="label">{tr('مفتاح API')}</span>
        <input className="input mt-1" type="password" dir="ltr" autoComplete="off" maxLength={500} value={apiKey} onChange={e => setApiKey(e.target.value)}
          placeholder={brain.keySet && !providerChanged ? `${tr('مضبوط')} ••••${brain.keyHint ?? ''}` : tr('الصق مفتاح API هنا')} />
        {providerChanged && brain.keySet && <span className="text-[11px] text-amber-700">{tr('غيّرت المزوّد — أدخل مفتاح API من المزوّد الجديد')}</span>}
      </label>
      {result && (
        <p className={`text-xs rounded-lg p-2 ${result.ok ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>{result.message}</p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {brain.keySet && (
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5 text-red-600" disabled={save.isPending}
            onClick={() => { if (window.confirm(tr('إزالة مفتاح الذكاء الاصطناعي؟ يتوقف العقل حتى تضيف مفتاحاً جديداً'))) save.mutate({ provider: brain.provider ?? provider, clearKey: true }); }}>
            <Trash2 size={15} /> {tr('إزالة المفتاح')}
          </button>
        )}
        <button type="button" className="btn-secondary inline-flex items-center gap-1.5" disabled={!brain.keySet || providerChanged || !!apiKey || test.isPending} onClick={() => { setResult(null); test.mutate(); }}>
          <PlugZap size={15} /> {test.isPending ? tr('جاري الاختبار') : tr('اختبر المفتاح')}
        </button>
        <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={save.isPending || !provider || !brain.secretsReady || (needKey && apiKey.trim().length < 8)}
          onClick={() => save.mutate({ provider, ...(model && { model }), ...(apiKey.trim() && { apiKey: apiKey.trim() }) })}>
          <Save size={15} /> {save.isPending ? tr('جاري الحفظ') : tr('حفظ العقل')}
        </button>
      </div>
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
  const { data, isLoading, isError, refetch } = useQuery({
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
      <p className="text-xs text-[#6E6557] mb-3">{tr('النوع المقترح مستنتج من اسم العميل — راجعه ثم احفظ. العميل بلا موقع على الخريطة لا يدخل في التوقّع')}</p>
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
        <p className="py-4 text-center text-xs text-red-600">{tr('تعذّر تحميل قائمة العملاء')}</p>
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
