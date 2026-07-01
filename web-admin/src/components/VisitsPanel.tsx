import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '../api/client';
import { X, Users, Globe2, TrendingUp, MapPin, Link2, FileText, Clock, RefreshCw } from 'lucide-react';

interface Row { at: string; path: string; referrer: string; country: string | null; city: string | null; countryCode: string | null }
interface Item { label: string; count: number }
interface Stats {
  total: number; uniques: number; days: number;
  byDay: { date: string; count: number }[];
  byCountry: Item[]; byCity: Item[]; byReferrer: Item[]; byPath: Item[]; byLang: Item[];
  recent: Row[];
}

// تحويل رمز الدولة (ISO alpha-2) إلى علم إيموجي
const flag = (cc?: string | null): string => {
  if (!cc || cc.length !== 2 || !/^[A-Za-z]{2}$/.test(cc)) return '🌐';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 - 65 + c.charCodeAt(0)));
};

// وقت الزيارة بالساعة والدقيقة (بتوقيت المتصفّح المحلّي) + التاريخ
const fmtDT = (s: string): { date: string; time: string } => {
  const d = new Date(s);
  return {
    date: d.toLocaleDateString('ar', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }),
  };
};

// لوحة تتبّع زيارات الموقع — لمالك المنصّة
export default function VisitsPanel({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState(30);
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['analytics', days],
    queryFn: async () => { const r = await analyticsApi.stats(days); return r.data.data as Stats; },
  });

  const topReferrer = data?.byReferrer?.[0]?.label ?? '—';
  const maxDay = Math.max(1, ...(data?.byDay ?? []).map((d) => d.count));

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3] sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><Globe2 size={20} className="text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">زيارات الموقع</h2>
              <p className="text-xs text-[#6E6557]">متى · كم · من أي رابط · من أي دولة ومدينة</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-[#F3EDE3] rounded-lg p-0.5">
              {[7, 30, 90].map((d) => (
                <button key={d} onClick={() => setDays(d)}
                  className={`text-xs font-semibold px-2.5 py-1 rounded-md transition-colors ${days === d ? 'bg-white text-[#C94E28] shadow-sm' : 'text-[#6E6557]'}`}>
                  {d} يوم
                </button>
              ))}
            </div>
            <button onClick={() => refetch()} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" title="تحديث">
              <RefreshCw size={15} className={isFetching ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-gray-400">جارٍ تحميل بيانات الزيارات…</div>
        ) : isError ? (
          <div className="py-20 text-center text-red-500">تعذّر تحميل البيانات — قد تكون خدمة التتبّع قيد النشر.</div>
        ) : !data || data.total === 0 ? (
          <div className="py-20 text-center px-6">
            <div className="w-14 h-14 bg-[#FBEBE2] rounded-2xl flex items-center justify-center mx-auto mb-4"><Globe2 size={28} className="text-[#E15A30]" /></div>
            <h3 className="font-bold text-[#1F1A13]">لا زيارات بعد</h3>
            <p className="text-sm text-[#6E6557] mt-1 max-w-sm mx-auto">تبدأ الزيارات بالظهور فور دخول أول زائر للموقع بعد تفعيل التتبّع. جرّب فتح fieldsa.net في متصفّح آخر.</p>
          </div>
        ) : (
          <div className="p-5 space-y-5">
            {/* KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Kpi icon={TrendingUp} value={String(data.total)} label={`زيارة خلال ${data.days} يوماً`} color="text-[#E15A30]" bg="bg-[#FBEBE2]" />
              <Kpi icon={Users} value={String(data.uniques)} label="زائر فريد" color="text-[#1E7A52]" bg="bg-green-50" />
              <Kpi icon={MapPin} value={String(data.byCountry.length)} label="دولة" color="text-[#E0A02C]" bg="bg-[#FBF0D8]" />
              <Kpi icon={Link2} value={topReferrer} label="أعلى مصدر" color="text-[#6E6557]" bg="bg-[#EDE7DB]" small />
            </div>

            {/* الزيارات باليوم */}
            <div className="bg-white border border-[#E9E1D3] rounded-2xl p-4">
              <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><TrendingUp size={15} className="text-[#E15A30]" /> الزيارات آخر {data.byDay.length} يوماً</h3>
              <div className="flex items-end gap-1.5 h-28">
                {data.byDay.map((d) => (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-1 group">
                    <span className="text-[10px] text-[#9A8F7E] opacity-0 group-hover:opacity-100">{d.count}</span>
                    <div className="w-full bg-[#F1EBDF] rounded-t-md relative" style={{ height: '100%' }}>
                      <div className="absolute bottom-0 w-full bg-[#E15A30] rounded-t-md transition-all" style={{ height: `${(d.count / maxDay) * 100}%` }} />
                    </div>
                    <span className="text-[9px] text-[#9A8F7E]">{d.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* الدول + المدن */}
            <div className="grid md:grid-cols-2 gap-4">
              <TopList title="أعلى الدول" icon={MapPin} items={data.byCountry} withFlag recent={data.recent} />
              <TopList title="أعلى المدن" icon={MapPin} items={data.byCity} />
            </div>

            {/* المصادر + الصفحات */}
            <div className="grid md:grid-cols-2 gap-4">
              <TopList title="مصادر الزيارات (من أي رابط)" icon={Link2} items={data.byReferrer} />
              <TopList title="أكثر الصفحات زيارة" icon={FileText} items={data.byPath} mono />
            </div>

            {/* أحدث الزيارات */}
            <div className="bg-white border border-[#E9E1D3] rounded-2xl overflow-hidden">
              <h3 className="text-sm font-bold text-[#1F1A13] px-4 pt-4 pb-2 flex items-center gap-2"><Clock size={15} className="text-[#E15A30]" /> أحدث الزيارات</h3>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-[12.5px]">
                  <thead className="text-[#9A8F7E] text-[11px] sticky top-0 bg-[#FAF7F0]">
                    <tr><th className="text-right font-medium px-4 py-2">الوقت</th><th className="text-right font-medium py-2">الصفحة</th><th className="text-right font-medium py-2">المصدر</th><th className="text-right font-medium px-4 py-2">الدولة / المدينة</th></tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r, i) => {
                      const dt = fmtDT(r.at);
                      return (
                      <tr key={i} className="border-t border-[#F1EBDF]">
                        <td className="px-4 py-2 whitespace-nowrap">
                          <span className="font-bold text-[#1F1A13] tabular-nums">{dt.time}</span>
                          <span className="text-[10px] text-[#9A8F7E] block">{dt.date}</span>
                        </td>
                        <td className="py-2 text-[#1F1A13] font-mono text-[11px] truncate max-w-[120px]">{r.path}</td>
                        <td className="py-2 text-[#6E6557] truncate max-w-[110px]">{r.referrer}</td>
                        <td className="px-4 py-2 text-[#1F1A13] whitespace-nowrap">{flag(r.countryCode)} {r.city ? `${r.city}، ` : ''}{r.country || '—'}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-[11px] text-[#9A8F7E] text-center">التتبّع يستثني لوحات الدخول ويتجاهل الزواحف (bots). الموقع الجغرافي تقريبي من عنوان IP دون تخزينه.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, value, label, color, bg, small }: { icon: React.ElementType; value: string; label: string; color: string; bg: string; small?: boolean }) {
  return (
    <div className="bg-white rounded-xl p-3.5 border border-[#E9E1D3]">
      <div className={`w-9 h-9 ${bg} rounded-lg flex items-center justify-center mb-2`}><Icon size={17} className={color} /></div>
      <p className={`${small ? 'text-sm' : 'text-lg'} font-bold ${color} truncate`}>{value}</p>
      <p className="text-[11px] text-[#6E6557] mt-0.5">{label}</p>
    </div>
  );
}

function TopList({ title, icon: Icon, items, withFlag, recent, mono }: { title: string; icon: React.ElementType; items: Item[]; withFlag?: boolean; recent?: Row[]; mono?: boolean }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  const ccOf = (name: string) => recent?.find((r) => r.country === name)?.countryCode ?? null;
  return (
    <div className="bg-white border border-[#E9E1D3] rounded-2xl p-4">
      <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><Icon size={15} className="text-[#E15A30]" /> {title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-[#9A8F7E] py-2">لا بيانات بعد</p>
      ) : (
        <div className="space-y-2.5">
          {items.map((it) => (
            <div key={it.label} className="flex items-center gap-2">
              <span className={`text-[12.5px] text-[#1F1A13] truncate flex-1 ${mono ? 'font-mono text-[11px]' : ''}`}>
                {withFlag ? `${flag(ccOf(it.label))} ` : ''}{it.label}
              </span>
              <div className="w-24 h-1.5 bg-[#F1EBDF] rounded-full overflow-hidden shrink-0">
                <div className="h-full bg-[#E15A30] rounded-full" style={{ width: `${(it.count / max) * 100}%` }} />
              </div>
              <span className="text-[11px] font-semibold text-[#6E6557] w-7 text-left shrink-0">{it.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
