import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Route as RouteIcon, Plus, Trash2, ArrowUp, ArrowDown, Search, X, CheckCircle2, Repeat, CalendarDays,
} from 'lucide-react';
import { repRouteApi, salesRepApi, customerApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { backdropClose } from '../lib/backdropClose';

/**
 * بناء خطوط سير المناديب — قائمة عملاء مرتّبة يجب زيارتهم.
 *
 * **الإنجاز يُقرأ من سجلّ الزيارات ولا يُخزَّن**: العميل يُعدّ مُنجَزاً حين
 * تُسجَّل له زيارةٌ من المندوب في اليوم نفسه — فزيارةٌ سُجّلت من ملفّ العميل
 * مباشرةً تُحتسب، ولا يقع تناقضٌ بين شاشتين.
 *
 * والخط نوعان: **دائمٌ** يتكرّر كل يوم، و**مؤقّتٌ** ليومٍ بعينه. وحين يجتمعان
 * يفوز المؤقّت: تخصيصُ يومٍ أحدثُ قصداً من خطّةٍ عامّة وُضعت قبل شهر.
 */

interface RouteRow {
  id: string; name: string; isPermanent: boolean; routeDate: string | null;
  salesRepId: string; salesRepName: string; total: number; doneToday: number;
}
interface Stop { customerId: string; customerName: string; note?: string | null }
interface Named { id: string; name: string; businessName?: string | null }

/**
 * نافذةٌ لا صفحة: خطوط السير تُبنى وأنت تنظر إلى مواقع عملائك على الخريطة.
 * إخراجُها إلى صفحةٍ مستقلّة يقطع تلك النظرة — فتُبنى فوق الخريطة نفسها.
 */
export default function RepRoutesModal({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ id?: string } | null>(null);

  const q = useQuery({
    queryKey: ['rep-routes'],
    queryFn: async () => (await repRouteApi.list()).data.data as RouteRow[],
  });
  const mDel = useMutation({
    mutationFn: (id: string) => repRouteApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rep-routes'] }),
  });

  return (
    <div className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4" {...backdropClose(onClose)}>
      <div
        className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-[#F1EBDF] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-bold text-[#1F1A13] flex items-center gap-2">
              <RouteIcon size={18} className="text-[#E15A30]" /> {tr('خطوط سير المناديب')}
            </p>
            <p className="text-[#6E6557] text-xs mt-0.5 truncate">{tr('حدد لكل مندوب العملاء الذين يزورهم وبأي ترتيب')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!editing && <button className="btn-primary text-xs" onClick={() => setEditing({})}><Plus size={15} /> {tr('خط سير جديد')}</button>}
            <button onClick={onClose} className="p-1.5 text-[#9A8F7E] hover:text-[#1F1A13]" aria-label={tr('إغلاق')}><X size={18} /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {editing ? (
            <RouteEditor id={editing.id} onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['rep-routes'] }); }} />
          ) : (
      <div className="card overflow-hidden p-0">
        {q.isLoading ? <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
          : !q.data?.length ? (
            <div className="p-10 text-center">
              <RouteIcon size={30} className="mx-auto text-gray-300" />
              <p className="text-sm text-[#6E6557] mt-2">{tr('لا خطوط سير بعد')}</p>
              <p className="text-xs text-gray-400 mt-1">{tr('أنشئ خطا ليظهر للمندوب في تطبيقه')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                    <th className="text-right font-semibold px-5 py-2.5">{tr('الاسم')}</th>
                    <th className="text-right font-semibold px-3 py-2.5">{tr('المندوب')}</th>
                    <th className="text-center font-semibold px-3 py-2.5">{tr('النوع')}</th>
                    <th className="text-center font-semibold px-3 py-2.5">{tr('العملاء')}</th>
                    <th className="text-center font-semibold px-3 py-2.5">{tr('أنجز اليوم')}</th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {q.data.map(r => (
                    <tr key={r.id} className="border-t border-[#F5F0E6]">
                      <td className="px-5 py-3 font-semibold text-[#1F1A13]">{r.name}</td>
                      <td className="px-3 py-3 text-[#6E6557]">{r.salesRepName}</td>
                      <td className="px-3 py-3 text-center">
                        {r.isPermanent
                          ? <span className="inline-flex items-center gap-1 text-xs bg-[#EEF2FF] text-[#4338CA] rounded-full px-2 py-0.5"><Repeat size={11} /> {tr('دائم')}</span>
                          : <span className="inline-flex items-center gap-1 text-xs bg-[#FFF7ED] text-[#C2410C] rounded-full px-2 py-0.5"><CalendarDays size={11} /> {r.routeDate}</span>}
                      </td>
                      <td className="px-3 py-3 text-center">{r.total}</td>
                      <td className="px-3 py-3 text-center">
                        <span className={r.doneToday === r.total ? 'text-green-600 font-semibold' : 'text-[#6E6557]'}>
                          {r.doneToday} / {r.total}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-left">
                        <div className="flex items-center gap-2 justify-end">
                          <button onClick={() => setEditing({ id: r.id })} className="btn-secondary text-xs">{tr('تعديل')}</button>
                          <button onClick={() => mDel.mutate(r.id)} className="p-1.5 text-red-600 hover:bg-red-50 rounded" title={tr('إيقاف')}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RouteEditor({ id, onDone }: { id?: string; onDone: () => void }) {
  const tr = useTr();
  const [salesRepId, setSalesRepId] = useState('');
  const [name, setName] = useState('');
  const [isPermanent, setIsPermanent] = useState(true);
  const [routeDate, setRouteDate] = useState('');
  const [stops, setStops] = useState<Stop[]>([]);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState('');

  const repsQ = useQuery({
    queryKey: ['reps-for-route'],
    queryFn: async () => (await salesRepApi.list()).data.data as Named[],
  });
  const custQ = useQuery({
    queryKey: ['customers-for-route', search],
    queryFn: async () => (await customerApi.list({ search, limit: 50 })).data.data as Named[],
  });
  useQuery({
    queryKey: ['rep-route', id],
    enabled: !!id,
    queryFn: async () => {
      const d = (await repRouteApi.get(id!)).data.data;
      setSalesRepId(d.salesRepId); setName(d.name);
      setIsPermanent(d.isPermanent); setRouteDate(d.routeDate || '');
      setStops(d.stops.map((s: Stop) => ({ customerId: s.customerId, customerName: s.customerName, note: s.note })));
      return d;
    },
  });

  const save = useMutation({
    mutationFn: () => repRouteApi.save({
      salesRepId, name: name.trim(), isPermanent,
      routeDate: isPermanent ? null : routeDate,
      stops: stops.map(s => ({ customerId: s.customerId, note: s.note ?? null })),
    }),
    onSuccess: onDone,
    onError: (e: unknown) => setErr((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ')),
  });

  const chosen = useMemo(() => new Set(stops.map(s => s.customerId)), [stops]);
  const move = (i: number, d: -1 | 1) => setStops(v => {
    const j = i + d;
    if (j < 0 || j >= v.length) return v;
    const c = [...v]; [c[i], c[j]] = [c[j], c[i]]; return c;
  });

  const ready = !!salesRepId && !!name.trim() && stops.length > 0 && (isPermanent || !!routeDate);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onDone} className="btn-secondary text-xs"><X size={14} /> {tr('رجوع')}</button>
        <p className="text-sm font-bold text-[#1F1A13]">{id ? tr('تعديل خط السير') : tr('خط سير جديد')}</p>
      </div>

      {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">{err}</p>}

      <div className="card">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="label text-xs">{tr('المندوب')}</label>
            <select className="input w-52" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>
              <option value="">{tr('اختر مندوبا')}</option>
              {repsQ.data?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label text-xs">{tr('اسم خط السير')}</label>
            <input className="input w-52" value={name} onChange={e => setName(e.target.value)} placeholder={tr('مسار وسط الرياض')} />
          </div>
          <div>
            <label className="label text-xs">{tr('النوع')}</label>
            <select className="input w-44" value={isPermanent ? 'perm' : 'temp'} onChange={e => setIsPermanent(e.target.value === 'perm')}>
              <option value="perm">{tr('دائم يتكرر كل يوم')}</option>
              <option value="temp">{tr('مؤقت ليوم محدد')}</option>
            </select>
          </div>
          {!isPermanent && (
            <div>
              <label className="label text-xs">{tr('تاريخ اليوم')}</label>
              <input type="date" className="input w-40" value={routeDate} onChange={e => setRouteDate(e.target.value)} />
            </div>
          )}
        </div>
        <p className="text-xs text-[#6E6557] mt-2">
          {isPermanent
            ? tr('يظهر للمندوب كل يوم، وعلامة الإنجاز تبدأ من جديد كل صباح')
            : tr('يظهر في يومه وحده، ويسبق الخط الدائم إن وجد')}
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* المختارون بالترتيب */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-[#F1EBDF] font-bold text-sm">
            {tr('ترتيب الزيارة')} ({stops.length})
          </div>
          {!stops.length ? (
            <p className="p-6 text-center text-xs text-gray-400">{tr('أضف عملاء من القائمة المجاورة')}</p>
          ) : (
            <div className="divide-y divide-[#F5F0E6] max-h-[26rem] overflow-y-auto">
              {stops.map((s, i) => (
                <div key={s.customerId} className="flex items-center gap-2 px-3 py-2.5">
                  <span className="w-6 h-6 rounded-full bg-[#FFF1EA] text-[#E15A30] text-xs font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                  <span className="flex-1 text-sm text-[#1F1A13] truncate">{s.customerName}</span>
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="p-1 text-[#6E6557] disabled:opacity-30"><ArrowUp size={14} /></button>
                  <button onClick={() => move(i, 1)} disabled={i === stops.length - 1} className="p-1 text-[#6E6557] disabled:opacity-30"><ArrowDown size={14} /></button>
                  <button onClick={() => setStops(v => v.filter(x => x.customerId !== s.customerId))} className="p-1 text-red-600"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* اختيار العملاء */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-[#F1EBDF]">
            <div className="relative">
              <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className="input w-full pr-9 text-sm" value={search}
                onChange={e => setSearch(e.target.value)} placeholder={tr('ابحث عن عميل')}
              />
            </div>
          </div>
          <div className="divide-y divide-[#F5F0E6] max-h-[26rem] overflow-y-auto">
            {custQ.isLoading ? <p className="p-6 text-center text-xs text-gray-400">{tr('جار التحميل')}</p>
              : !custQ.data?.length ? <p className="p-6 text-center text-xs text-gray-400">{tr('لا نتائج')}</p>
              : custQ.data.map(c => {
                const on = chosen.has(c.id);
                const label = c.businessName || c.name;
                return (
                  <button
                    key={c.id} disabled={on}
                    onClick={() => setStops(v => [...v, { customerId: c.id, customerName: label }])}
                    className={`w-full text-right px-4 py-2.5 text-sm flex items-center gap-2 ${on ? 'bg-[#F7FBF8] text-gray-400' : 'hover:bg-[#FAF7F0] text-[#1F1A13]'}`}
                  >
                    {on ? <CheckCircle2 size={14} className="text-green-600 shrink-0" /> : <Plus size={14} className="text-[#E15A30] shrink-0" />}
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button className="btn-primary" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tr('جار الحفظ') : tr('حفظ خط السير')}
        </button>
        <button className="btn-secondary" onClick={onDone}>{tr('إلغاء')}</button>
      </div>
      {!ready && (
        <p className="text-xs text-[#6E6557]">
          {tr('اختر المندوب والاسم وعميلا واحدا على الأقل')}{!isPermanent && !routeDate ? ` · ${tr('وحدد التاريخ')}` : ''}
        </p>
      )}
    </div>
  );
}
