import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { vanStockApi, productApi, salesRepApi, companyApi } from '../api/client';
import { formatDate, activeLocale } from '../utils/format';
import { useTr } from '../i18n/strings';
import SearchableSelect from '../components/SearchableSelect';
import { Truck, Package, TrendingDown, Plus, X, Trash2, ArrowDownToLine, Boxes, Calendar, Sparkles, AlertTriangle, Target, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import DocumentModal from '../components/DocumentModal';
import { loadNoticeDocFromData, Company } from '../rep/RepDocuments';

/** استجابة /van-stock/suggest — تطابق SuggestResult في الخادم */
interface SuggestRow {
  id: string; name: string; code: string; unit: string;
  expected: number; withBuffer: number; onVan: number; suggested: number;
  basis: 'weekday' | 'overall' | 'none';
  sampleDays: number; activeDays: number;
  confidence: 'high' | 'medium' | 'low';
  why: string;
}
interface SuggestResponse {
  rows: SuggestRow[];
  meta: {
    targetDate: string; weekday: number; windowDays: number; bufferPct: number;
    dataDays: number; oldestSale: string | null; warning: string | null;
  };
  salesRep: { id: string; name: string };
}

/** وسم الثقة — يُعرض دائماً بجوار الرقم فلا يُقرأ الاقتراح كيقين */
function ConfidenceTag({ c }: { c: SuggestRow['confidence'] }) {
  const map = {
    high: { t: 'ثقة عالية', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    medium: { t: 'ثقة متوسطة', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    low: { t: 'ثقة منخفضة', cls: 'bg-red-50 text-red-700 border-red-200' },
  }[c];
  return <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${map.cls}`}>{map.t}</span>;
}

/** استجابة /van-stock/accuracy — تطابق AccuracyResult في الخادم */
interface AccDay {
  day: string; productId: string; name: string; unit: string;
  expected: number; suggested: number; loaded: number; actual: number; error: number;
  adopted: boolean; outcome: string; open: boolean;
}
interface AccResponse {
  days: AccDay[];
  summary: {
    measured: number; pending: number; unmeasured: number;
    adoptionRate: number | null; mae: number | null; bias: number | null; maePct: number | null;
    under: number; over: number; exact: number; verdict: string;
  };
  meta: { days: number };
}

interface RepSummary {
  salesRepId: string; repName: string; isActive: boolean; canSellWithoutStock: boolean;
  productCount: number; totalRemaining: number; totalLoaded: number; totalSold: number; lastLoadAt: string | null;
}
interface StockRow {
  productId: string; name: string; code: string; unit: string;
  loaded: number; unloaded: number; adjusted: number; sold: number; returned: number; remaining: number;
}
interface Movement {
  kind: string; date: string; ref: string; by: string | null;
  items: { name: string; unit: string; qty: number }[];
}

const fmtQty = (n: number) => Number(n.toFixed(2)).toLocaleString(activeLocale());

// لوحة مخزون سيارات المناديب — ملخّص لكل مندوب + تفاصيل المخزون وحركته
export default function VanStockPage() {
  const tr = useTr();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string>('');
  const [showLoad, setShowLoad] = useState(false);
  const [showAccuracy, setShowAccuracy] = useState(false);
  const [noticeMv, setNoticeMv] = useState<Movement | null>(null);

  const summaryQ = useQuery({
    queryKey: ['van-summary'],
    queryFn: async () => (await vanStockApi.summary()).data.data as RepSummary[],
  });

  // تبديل صلاحية «البيع بدون مخزون» لمندوب (تحديث متفائل)
  const setSellPerm = useMutation({
    mutationFn: ({ id, val }: { id: string; val: boolean }) => vanStockApi.setSellPermission(id, val),
    onMutate: async ({ id, val }) => {
      await qc.cancelQueries({ queryKey: ['van-summary'] });
      const prev = qc.getQueryData<RepSummary[]>(['van-summary']);
      qc.setQueryData<RepSummary[]>(['van-summary'], (old) => (old || []).map(r => r.salesRepId === id ? { ...r, canSellWithoutStock: val } : r));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['van-summary'], ctx.prev); toast.error(tr('تعذر تغيير الصلاحية')); },
    onSuccess: (_d, v) => toast.success(v.val ? tr('سمح بالبيع بدون مخزون') : tr('منع البيع بدون مخزون')),
    onSettled: () => qc.invalidateQueries({ queryKey: ['van-summary'] }),
  });

  const currentQ = useQuery({
    queryKey: ['van-current', selected],
    queryFn: async () => (await vanStockApi.current(selected)).data.data as StockRow[],
    enabled: !!selected,
  });
  const movementsQ = useQuery({
    queryKey: ['van-movements', selected],
    queryFn: async () => (await vanStockApi.movements(selected)).data.data as Movement[],
    enabled: !!selected,
  });
  // بيانات الشركة لرأس ملفّ الإشعار
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as Company,
  });
  const repName = summaryQ.data?.find(r => r.salesRepId === selected)?.repName || '';

  const reps = summaryQ.data || [];
  const selectedRep = reps.find(r => r.salesRepId === selected);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1A13] flex items-center gap-2">
            <Truck size={26} className="text-[#E15A30]" /> {tr('مخزون سيارات المناديب')}
          </h1>
          <p className="text-[#6E6557] text-sm mt-1">{tr('متابعة ما حمله كل مندوب في سيارته وما تبقى بعد المبيعات لحظيا')}</p>
        </div>
        <button onClick={() => setShowAccuracy(true)} className="btn-secondary"><Target size={16} /> {tr('دقة الاقتراح')}</button>
        <button onClick={() => setShowLoad(true)} className="btn-primary"><Plus size={17} /> {tr('تسجيل تحميل')}</button>
      </div>

      {/* ملخّص المناديب */}
      <div className="card overflow-hidden p-0">
        <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
          <Boxes size={17} className="text-[#E15A30]" /> {tr('ملخص المخزون حسب المندوب')}
        </div>
        {summaryQ.isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
        ) : reps.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('لا يوجد مناديب بعد')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                  <th className="text-right font-semibold px-5 py-2.5">{tr('المندوب')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('أصناف بالسيارة')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('إجمالي محمل')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('إجمالي مباع')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('المتبقي')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('البيع بدون مخزون')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('آخر تحميل')}</th>
                </tr>
              </thead>
              <tbody>
                {reps.map(r => (
                  <tr key={r.salesRepId}
                    onClick={() => setSelected(r.salesRepId)}
                    className={`border-t border-[#F1EBDF] cursor-pointer transition-colors ${selected === r.salesRepId ? 'bg-[#FBEBE2]' : 'hover:bg-[#FAF7F0]'}`}>
                    <td className="px-5 py-3 font-semibold text-[#1F1A13]">{r.repName}{!r.isActive && <span className="text-[10px] text-red-500 mr-2">{tr('موقوف')}</span>}</td>
                    <td className="text-center px-3 py-3">{r.productCount}</td>
                    <td className="text-center px-3 py-3 text-[#6E6557]">{fmtQty(r.totalLoaded)}</td>
                    <td className="text-center px-3 py-3 text-[#6E6557]">{fmtQty(r.totalSold)}</td>
                    <td className={`text-center px-3 py-3 font-bold ${r.totalRemaining < 0 ? 'text-red-600' : 'text-[#1E7A52]'}`}>{fmtQty(r.totalRemaining)}</td>
                    <td className="text-center px-3 py-3" onClick={e => e.stopPropagation()}>
                      <button onClick={() => setSellPerm.mutate({ id: r.salesRepId, val: !r.canSellWithoutStock })}
                        disabled={setSellPerm.isPending}
                        title={r.canSellWithoutStock ? tr('مسموح اضغط للمنع') : tr('ممنوع اضغط للسماح')}
                        className={`text-[11px] font-bold rounded-full px-3 py-1 border transition-colors disabled:opacity-50 ${r.canSellWithoutStock ? 'bg-green-50 text-[#1E7A52] border-green-200 hover:bg-green-100' : 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'}`}>
                        {r.canSellWithoutStock ? tr('نعم') : tr('لا')}
                      </button>
                    </td>
                    <td className="text-center px-3 py-3 text-[#9A8F7E] text-xs">{r.lastLoadAt ? formatDate(r.lastLoadAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* تفاصيل المندوب المختار */}
      {selected && selectedRep && (
        <div className="grid lg:grid-cols-2 gap-6">
          {/* المخزون الحالي */}
          <div className="card p-0 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
              <Package size={17} className="text-[#E15A30]" /> {tr('مخزون المندوب الحالي')} — {selectedRep.repName}
            </div>
            {currentQ.isLoading ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
            ) : (currentQ.data || []).length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('لا توجد بضاعة محملة لهذا المندوب')}</div>
            ) : (
              <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0">
                    <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                      <th className="text-right font-semibold px-5 py-2.5">{tr('الصنف')}</th>
                      <th className="text-center font-semibold px-2 py-2.5">{tr('محمل')}</th>
                      <th className="text-center font-semibold px-2 py-2.5">{tr('مباع')}</th>
                      <th className="text-center font-semibold px-2 py-2.5">{tr('مرتجع')}</th>
                      <th className="text-center font-semibold px-3 py-2.5">{tr('المتبقي')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(currentQ.data || []).map(row => (
                      <tr key={row.productId} className="border-t border-[#F1EBDF]">
                        <td className="px-5 py-2.5">
                          <p className="font-semibold text-[#1F1A13]">{row.name}</p>
                          <p className="text-[10px] text-[#9A8F7E]">{row.code} · {row.unit}</p>
                        </td>
                        <td className="text-center px-2 py-2.5 text-[#6E6557]">{fmtQty(row.loaded)}</td>
                        <td className="text-center px-2 py-2.5 text-[#C94E28]">{fmtQty(row.sold)}</td>
                        <td className="text-center px-2 py-2.5 text-[#6E6557]">{fmtQty(row.returned)}</td>
                        <td className={`text-center px-3 py-2.5 font-bold ${row.remaining < 0 ? 'text-red-600' : row.remaining === 0 ? 'text-[#9A8F7E]' : 'text-[#1E7A52]'}`}>{fmtQty(row.remaining)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* حركة المخزون (كم نزل ومتى) */}
          <div className="card p-0 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
              <TrendingDown size={17} className="text-[#E15A30]" /> {tr('حركة البضاعة ماذا نزل ومتى')}
            </div>
            {movementsQ.isLoading ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
            ) : (movementsQ.data || []).length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('لا توجد حركة بعد')}</div>
            ) : (
              <div className="max-h-[420px] overflow-y-auto divide-y divide-[#F1EBDF]">
                {(movementsQ.data || []).map((m, i) => <MovementRow key={i} m={m} onExport={setNoticeMv} />)}
              </div>
            )}
          </div>
        </div>
      )}

      {showLoad && <LoadModal preselectRep={selected} onClose={() => setShowLoad(false)} />}
      {showAccuracy && <AccuracyModal preselectRep={selected} onClose={() => setShowAccuracy(false)} />}
      {noticeMv && <DocumentModal doc={loadNoticeDocFromData(repName, noticeMv, companyQ.data ?? null)} onClose={() => setNoticeMv(null)} />}
    </div>
  );
}

const KIND_META: Record<string, { label: string; color: string; sign: string }> = {
  LOAD: { label: 'تحميل', color: 'text-[#1E7A52] bg-green-50', sign: '+' },
  SALE: { label: 'بيع', color: 'text-[#C94E28] bg-[#FBEBE2]', sign: '−' },
  RETURN: { label: 'مرتجع', color: 'text-blue-600 bg-blue-50', sign: '+' },
  UNLOAD: { label: 'تنزيل للمستودع', color: 'text-amber-600 bg-amber-50', sign: '−' },
  ADJUST: { label: 'تسوية', color: 'text-purple-600 bg-purple-50', sign: '±' },
};

function MovementRow({ m, onExport }: { m: Movement; onExport?: (m: Movement) => void }) {
  const tr = useTr();
  const meta = KIND_META[m.kind] || KIND_META.ADJUST;
  const canExport = ['LOAD', 'UNLOAD', 'ADJUST'].includes(m.kind); // حركات السيارة (لا المبيعات) تُصدَّر إشعاراً
  return (
    <div className="px-5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${meta.color}`}>{tr(meta.label)}</span>
          {onExport && canExport && (
            <button onClick={() => onExport(m)} title={tr('إشعار PDF')}
              className="text-[11px] text-slate-600 hover:text-slate-800 flex items-center gap-1 font-semibold">
              <Download size={12} /> {tr('إشعار PDF')}
            </button>
          )}
        </span>
        <span className="text-[11px] text-[#9A8F7E] flex items-center gap-1"><Calendar size={11} /> {formatDate(m.date)}</span>
      </div>
      {m.ref && <p className="text-xs text-[#6E6557] mt-1.5">{m.ref}</p>}
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {m.items.map((it, j) => {
          // التسوية قد تكون + أو −؛ نُظهر الإشارة الفعلية للكمية لا الرمز ±
          const sign = m.kind === 'ADJUST' ? (it.qty < 0 ? '−' : '+') : meta.sign;
          const isNeg = (m.kind === 'ADJUST' && it.qty < 0);
          return (
            <span key={j} className="text-[11px] bg-[#FAF7F0] border border-[#F1EBDF] rounded-md px-2 py-0.5 text-[#1F1A13]">
              {it.name} <b className={isNeg ? 'text-red-600' : undefined}>{sign}{fmtQty(Math.abs(it.qty))}</b> {it.unit}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// نافذة «دقّة الاقتراح» — الحكم أولاً بالعربية، ثم الأرقام، ثم الأيام تفصيلاً.
// «قيد البيع» يوم لم يكتمل فلا يُحسب — عرضُه محسوباً كان سيتّهم كل تنبّؤٍ
// صباحيّ بالمبالغة قبل أن يبيع المندوب شيئاً.
function AccuracyModal({ preselectRep, onClose }: { preselectRep: string; onClose: () => void }) {
  const tr = useTr();
  const [repId, setRepId] = useState(preselectRep);
  const [days, setDays] = useState(14);
  const repsQ = useQuery({ queryKey: ['reps-min'], queryFn: async () => (await salesRepApi.list({ limit: 1000 })).data.data as { id: string; name: string }[] });
  // status/fetchStatus لا isLoading — درس «الموقوف ليس فارغاً» (راجع التقارير)
  const accQ = useQuery({
    queryKey: ['van-accuracy', repId, days],
    enabled: !!repId,
    queryFn: async () => (await vanStockApi.accuracy({ salesRepId: repId, days })).data.data as AccResponse,
  });
  const d = accQ.data;
  const chip = (label: string, val: string, cls: string) => (
    <div className={`rounded-xl border px-3 py-2 ${cls}`}>
      <p className="text-[10px] text-gray-500">{label}</p>
      <p className="text-sm font-bold">{val}</p>
    </div>
  );
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h3 className="font-bold text-[#1F1A13] flex items-center gap-2"><Target size={18} className="text-[#E15A30]" /> {tr('دقة الاقتراح')}</h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="flex gap-3 flex-wrap items-end">
            <div className="flex-1 min-w-[180px]">
              <label className="label">{tr('المندوب')}</label>
              <SearchableSelect
                options={(repsQ.data || []).map(r => ({ value: r.id, label: r.name }))}
                value={repId} onChange={setRepId} placeholder={tr('اختر المندوب')} />
            </div>
            <div>
              <label className="label">{tr('الفترة')}</label>
              <select className="input w-32" value={days} onChange={e => setDays(Number(e.target.value))}>
                <option value={7}>{tr('أسبوع')}</option>
                <option value={14}>{tr('أسبوعان')}</option>
                <option value={30}>{tr('شهر')}</option>
                <option value={60}>{tr('شهران')}</option>
              </select>
            </div>
          </div>

          {!repId ? (
            <p className="text-center text-gray-400 py-8 text-sm">{tr('اختر مندوبا لعرض دقة اقتراحاته')}</p>
          ) : accQ.status === 'pending' ? (
            <p className="text-center text-gray-400 py-8 text-sm">{accQ.fetchStatus === 'paused' ? tr('بانتظار عودة الاتصال') : tr('جاري التحميل')}</p>
          ) : accQ.status === 'error' ? (
            <p className="text-center text-red-500 py-8 text-sm">{tr('تعذر تحميل التقرير')}</p>
          ) : d && (
            <>
              {/* الحكم — جملة تُقرأ كما هي، من الخادم */}
              <div className="bg-[#FAF7F0] border border-[#F1EBDF] rounded-xl p-4 text-sm text-[#1F1A13] leading-relaxed">
                {d.summary.verdict}
              </div>

              {d.summary.measured > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {chip(tr('متوسط الخطأ'), d.summary.mae === null ? '—' : `${d.summary.mae} (${d.summary.maePct ?? '—'}٪`, 'bg-white border-[#E9E1D3]')}
                  {chip(tr('الانحياز'), d.summary.bias === null ? '—' : d.summary.bias > 0 ? `${tr('نقص')} ${d.summary.bias}` : d.summary.bias < 0 ? `${tr('زيادة')} ${Math.abs(d.summary.bias)}` : tr('متوازن'), 'bg-white border-[#E9E1D3]')}
                  {chip(tr('الالتزام بالاقتراح'), d.summary.adoptionRate === null ? '—' : `${d.summary.adoptionRate}٪`, 'bg-white border-[#E9E1D3]')}
                  {chip(`${tr('دقيق')} / ${tr('نقص')} / ${tr('زيادة')}`, `${d.summary.exact} / ${d.summary.under} / ${d.summary.over}`, 'bg-white border-[#E9E1D3]')}
                </div>
              )}

              {d.days.length > 0 ? (
                <div className="table-wrapper border border-[#F1EBDF] rounded-xl">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{tr('اليوم')}</th><th>{tr('الصنف')}</th><th>{tr('التنبؤ')}</th>
                        <th>{tr('حمل')}</th><th>{tr('مباع')}</th><th>{tr('الحكم')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.days.map((r, i) => (
                        <tr key={i} className={r.open ? 'opacity-50' : ''}>
                          <td className="text-xs text-gray-500 tabular-nums">{r.day}</td>
                          <td className="font-medium text-gray-800">{r.name} <span className="text-[10px] text-gray-400">{r.unit}</span></td>
                          <td className="tabular-nums">{fmtQty(r.expected)}</td>
                          <td className="tabular-nums text-gray-600">{fmtQty(r.loaded)}</td>
                          <td className="tabular-nums font-semibold">{fmtQty(r.actual)}</td>
                          <td>
                            {r.open
                              ? <span className="text-[10px] px-1.5 py-0.5 rounded border bg-gray-50 text-gray-500 border-gray-200 font-semibold">{tr('قيد البيع')}</span>
                              : <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${r.outcome === 'دقيق' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : r.outcome === 'نقص' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                                  {tr(r.outcome)} {r.error !== 0 && <span className="tabular-nums">{r.error > 0 ? `+${fmtQty(r.error)}` : `−${fmtQty(Math.abs(r.error))}`}</span>}
                                </span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-center text-gray-400 py-6 text-sm">{tr('لا تحميلات مبنية على اقتراح في هذه الفترة طبق التحميل المقترح عند التحميل ليبدأ القياس')}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// نموذج تسجيل تحميل بضاعة لمندوب (للأدمن)
function LoadModal({ preselectRep, onClose }: { preselectRep: string; onClose: () => void }) {
  const qc = useQueryClient();
  const tr = useTr();
  const [repId, setRepId] = useState(preselectRep);
  const [note, setNote] = useState('');
  // suggestedQty يُحفَظ على الصفّ ليُرسَل مع الحركة — به تُقاس جودة الاقتراح لاحقاً
  const [rows, setRows] = useState<{ productId: string; name: string; unit: string; qty: string; suggestedQty?: number; expectedQty?: number }[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [windowDays, setWindowDays] = useState(28);
  const [bufferPct, setBufferPct] = useState(15);

  const repsQ = useQuery({ queryKey: ['reps-min'], queryFn: async () => (await salesRepApi.list({ limit: 1000 })).data.data as { id: string; name: string }[] });
  const prodQ = useQuery({ queryKey: ['products-min'], queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as { id: string; name: string; unit: string; code: string }[] });

  const addProduct = (id: string, opt?: { label: string }) => {
    if (!id || rows.some(r => r.productId === id)) return;
    const p = (prodQ.data || []).find(x => x.id === id);
    if (!p) return;
    setRows(rs => [...rs, { productId: id, name: opt?.label || p.name, unit: p.unit, qty: '1' }]);
  };

  // الاقتراح لا يُطلَب إلا حين يُفتح القسم: طلب شبكة لكل فتح نموذج هدرٌ
  // لمن يعرف كمياته أصلاً.
  const suggestQ = useQuery({
    queryKey: ['van-suggest', repId, windowDays, bufferPct],
    enabled: showSuggest && !!repId,
    queryFn: async () => (await vanStockApi.suggest({ salesRepId: repId, windowDays, bufferPct })).data.data as SuggestResponse,
  });

  /** يملأ النموذج بما يستحقّ تحميلاً فقط — الأصفار ضجيج لا اقتراح */
  const applySuggestion = () => {
    const list = (suggestQ.data?.rows || []).filter(r => r.suggested > 0);
    if (!list.length) { toast.error(tr('لا يوجد ما يقترح تحميله')); return; }
    setRows(list.map(r => ({
      productId: r.id, name: r.name, unit: r.unit,
      qty: String(r.suggested), suggestedQty: r.suggested,
      // التنبّؤ اليومي — مرجعُ قياس الدقّة؛ suggestedQty كمية تعبئة تتأثر
      // بما في السيارة والهامش فقياسُها يعاقب المحرّك على ما ليس تنبّؤاً
      expectedQty: r.expected,
    })));
    setShowSuggest(false);
    toast.success(tr('طبق الاقتراح راجع الكميات قبل الحفظ'));
  };

  const save = useMutation({
    mutationFn: () => {
      // موجب = تحميل، سالب = تنقيص؛ أي سالب ⇒ حركة تسوية/تنقيص
      const items = rows.map(r => ({ productId: r.productId, qty: Number(r.qty), suggestedQty: r.suggestedQty, expectedQty: r.expectedQty }))
        .filter(i => !Number.isNaN(i.qty) && i.qty !== 0);
      const type = items.some(i => i.qty < 0) ? 'ADJUST' : 'LOAD';
      return vanStockApi.createLoad({ salesRepId: repId, type, note: note.trim() || undefined, items });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['van-summary'] });
      qc.invalidateQueries({ queryKey: ['van-current'] });
      qc.invalidateQueries({ queryKey: ['van-movements'] });
      toast.success(tr('تم حفظ الحركة'));
      onClose();
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ')),
  });

  const valid = !!repId && rows.length > 0 && rows.every(r => { const q = Number(r.qty); return !Number.isNaN(q) && q !== 0; });

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><ArrowDownToLine size={20} className="text-[#E15A30]" /> {tr('تحميل / تنقيص مخزون السيارة')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="label">{tr('المندوب')}</label>
            <SearchableSelect
              options={(repsQ.data || []).map(r => ({ value: r.id, label: r.name }))}
              value={repId} onChange={(v) => setRepId(v)} placeholder={tr('اختر المندوب')} />
          </div>
          <div>
            <label className="label">{tr('إضافة صنف')}</label>
            <SearchableSelect
              options={(prodQ.data || []).filter(p => !rows.some(r => r.productId === p.id)).map(p => ({ value: p.id, label: p.name, hint: `${p.code} · ${p.unit}` }))}
              value="" onChange={addProduct} resetOnSelect placeholder={tr('ابحث وأضف صنفا')} searchPlaceholder={tr('اكتب اسم/كود الصنف')} />
          </div>

          {/* ─────────── التحميل المقترح ───────────
              موضعه هنا لا في لوحة منفصلة: الاقتراح قرار يُتّخذ لحظة التحميل،
              ولوحة توقّعات مستقلّة تُقرأ مرّة وتُنسى. */}
          <div className="border border-[#E9E1D3] rounded-xl overflow-hidden">
            <button type="button" onClick={() => setShowSuggest(v => !v)} disabled={!repId}
              className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 bg-[#FBEBE2] disabled:opacity-50 text-start">
              <span className="text-sm font-bold text-[#1F1A13] flex items-center gap-2">
                <Sparkles size={15} className="text-[#E15A30]" />
                {tr('التحميل المقترح')}
              </span>
              <span className="text-[11px] text-[#6E6557]">
                {repId ? (showSuggest ? tr('إخفاء') : tr('اعرض اقتراحا من تاريخ مبيعاته')) : tr('اختر المندوب أولا')}
              </span>
            </button>

            {showSuggest && (
              <div className="p-3.5 space-y-3">
                <div className="flex items-end gap-2 flex-wrap">
                  <div className="w-32">
                    <label className="label !mb-1 !text-[11px]">{tr('نافذة التاريخ يوم')}</label>
                    <input type="number" min={7} max={180} value={windowDays}
                      onChange={e => setWindowDays(Math.min(180, Math.max(7, Number(e.target.value) || 28)))}
                      className="input py-1.5 text-center" />
                  </div>
                  <div className="w-32">
                    <label className="label !mb-1 !text-[11px]">{tr('هامش أمان %')}</label>
                    <input type="number" min={0} max={100} value={bufferPct}
                      onChange={e => setBufferPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                      className="input py-1.5 text-center" />
                  </div>
                  <button type="button" onClick={applySuggestion}
                    disabled={suggestQ.isLoading || !(suggestQ.data?.rows || []).some(r => r.suggested > 0)}
                    className="btn-primary py-2 px-3.5 text-sm disabled:opacity-50">{tr('املأ النموذج بالاقتراح')}</button>
                </div>

                {suggestQ.isLoading && <p className="text-xs text-[#9A8F7E]">{tr('يحسب')}</p>}
                {suggestQ.isError && <p className="text-xs text-red-600">{tr('تعذر حساب الاقتراح')}</p>}

                {/* التحذير يُعرض كما هو من الخادم — إخفاء رقّة البيانات خداع */}
                {suggestQ.data?.meta.warning && (
                  <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <AlertTriangle size={12} className="inline -mt-0.5 me-1" />{suggestQ.data.meta.warning}
                  </p>
                )}

                {suggestQ.data && (
                  <>
                    <p className="text-[11px] text-[#6E6557]">
                      {tr('بناء على')} <b>{suggestQ.data.meta.dataDays}</b> {tr('يوما فيها مبيعات خلال آخر')}{' '}
                      <b>{suggestQ.data.meta.windowDays}</b> {tr('يوما')}
                      {suggestQ.data.meta.oldestSale && <> · {tr('أقدم بيعة')} {suggestQ.data.meta.oldestSale}</>}
                    </p>
                    <div className="max-h-56 overflow-y-auto border border-[#F1EBDF] rounded-lg divide-y divide-[#F1EBDF]">
                      {suggestQ.data.rows.filter(r => r.suggested > 0).map(r => (
                        <div key={r.id} className="px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</span>
                            <span className="flex items-center gap-1.5 shrink-0">
                              <ConfidenceTag c={r.confidence} />
                              <b className="text-sm text-[#E15A30]">{r.suggested}</b>
                              <span className="text-[10px] text-[#9A8F7E]">{r.unit}</span>
                            </span>
                          </div>
                          {/* «لماذا هذا الرقم» — الاقتراح غير القابل للشرح يُرفض أول خطأ */}
                          <p className="text-[10px] text-[#9A8F7E] mt-0.5 leading-relaxed">{r.why}</p>
                        </div>
                      ))}
                      {!suggestQ.data.rows.some(r => r.suggested > 0) && (
                        <p className="px-3 py-3 text-xs text-[#9A8F7E]">
                          {tr('لا يوجد ما يقترح تحميله إما لا مبيعات سابقة أو السيارة تغطي المتوقع أصلا')}
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <p className="text-[11px] text-[#9A8F7E] bg-[#FAF7F0] rounded-lg px-3 py-2">{tr('أدخل كمية موجبة للتحميل أو سالبة للتنقيص استخدم زر ± أو اكتب مثل ‎-5')}</p>
          {rows.length > 0 && (
            <div className="border border-[#F1EBDF] rounded-xl divide-y divide-[#F1EBDF]">
              {rows.map((r, i) => {
                const neg = Number(r.qty) < 0;
                return (
                <div key={r.productId} className="flex items-center gap-2 p-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</p>
                    <p className={`text-[10px] ${neg ? 'text-red-500 font-semibold' : 'text-[#9A8F7E]'}`}>{neg ? tr('تنقيص') : r.unit}</p>
                  </div>
                  <button type="button" title={tr('عكس الإشارة تحميل/تنقيص')}
                    onClick={() => setRows(rs => rs.map((x, j) => j === i ? { ...x, qty: String(-(Number(x.qty) || 0)) } : x))}
                    className="w-9 h-9 rounded-lg border border-[#E9E1D3] text-base font-bold text-[#6E6557] shrink-0 hover:bg-gray-50">±</button>
                  <input type="number" step="any" value={r.qty}
                    onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))}
                    className={`input w-24 text-center py-1.5 ${neg ? 'border-red-300 text-red-600 font-bold' : ''}`} />
                  <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600 p-1"><Trash2 size={16} /></button>
                </div>
                );
              })}
            </div>
          )}

          <div>
            <label className="label">{tr('ملاحظة اختياري')}</label>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={tr('مثال تحميل صباح اليوم من المستودع')} />
          </div>
        </div>

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={() => save.mutate()} disabled={!valid || save.isPending} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ArrowDownToLine size={16} />}
            {tr('حفظ الحركة')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
