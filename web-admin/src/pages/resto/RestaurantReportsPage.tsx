import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp, Wallet, ReceiptText, FileText, RotateCcw, Trophy } from 'lucide-react';
import { restaurantApi } from '../../api/client';

const money = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`;
const methodLabel = (m: string) => ({ CASH: 'نقد', CARD: 'بطاقة', WALLET: 'محفظة', ON_ACCOUNT: 'آجل' } as Record<string, string>)[m] || m;

interface Summary {
  from: string; to: string; salesTotal: number; netTotal: number; taxTotal: number; invoiceCount: number; returnsTotal: number;
  byMethod: { method: string; amount: number }[];
  byDay: { date: string; total: number }[];
  topItems: { name: string; qty: number; total: number }[];
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function RestaurantReportsPage() {
  const [to, setTo] = useState(iso(new Date()));
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 86400000)));

  const { data, isLoading } = useQuery({
    queryKey: ['resto-report', from, to],
    queryFn: async () => (await restaurantApi.reportSummary({ from, to })).data.data as Summary,
  });

  const kpis = [
    { icon: TrendingUp, label: 'إجمالي المبيعات', value: money(data?.salesTotal ?? 0), color: '#E15A30' },
    { icon: Wallet, label: 'صافي المبيعات', value: money(data?.netTotal ?? 0), color: '#1E7A52' },
    { icon: ReceiptText, label: 'ضريبة القيمة المضافة', value: money(data?.taxTotal ?? 0), color: '#9A6A00' },
    { icon: FileText, label: 'عدد الفواتير', value: String(data?.invoiceCount ?? 0), color: '#1F1A13' },
  ];
  const maxDay = Math.max(1, ...(data?.byDay ?? []).map(d => d.total));

  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold text-[#1F1A13]">التقارير</h1>
        <div className="flex items-center gap-2">
          <input type="date" className="input" value={from} max={to} onChange={e => setFrom(e.target.value)} />
          <span className="text-[#9A8F7E]">→</span>
          <input type="date" className="input" value={to} min={from} max={iso(new Date())} onChange={e => setTo(e.target.value)} />
        </div>
      </div>

      {isLoading ? <div className="card text-center py-16 text-gray-400">جاري التحميل…</div> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {kpis.map(k => (
              <div key={k.label} className="bg-white rounded-2xl p-4 flex items-center gap-3 border border-gray-100">
                <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: k.color }}><k.icon size={22} className="text-white" /></div>
                <div><p className="text-lg font-bold text-[#1F1A13]">{k.value}</p><p className="text-xs text-[#6E6557]">{k.label}</p></div>
              </div>
            ))}
          </div>

          {(data?.returnsTotal ?? 0) > 0 && (
            <div className="card flex items-center gap-3 text-sm">
              <RotateCcw size={18} className="text-red-500" /> <span className="text-[#6E6557]">المرتجعات في المدى:</span>
              <span className="font-bold text-red-500">{money(data!.returnsTotal)}</span>
            </div>
          )}

          <div className="grid lg:grid-cols-2 gap-5">
            {/* المبيعات حسب اليوم */}
            <div className="card">
              <h2 className="font-bold text-[#1F1A13] mb-3">المبيعات حسب اليوم</h2>
              {(data?.byDay ?? []).length === 0 ? <p className="text-sm text-gray-400 py-6 text-center">لا مبيعات في المدى</p> : (
                <div className="space-y-2">
                  {data!.byDay.slice(-14).map(d => (
                    <div key={d.date} className="flex items-center gap-2">
                      <span className="text-xs text-[#9A8F7E] w-20 shrink-0" dir="ltr">{d.date}</span>
                      <div className="flex-1 h-2.5 bg-[#F1EBDF] rounded-full overflow-hidden">
                        <div className="h-full bg-[#E15A30] rounded-full" style={{ width: `${(d.total / maxDay) * 100}%` }} />
                      </div>
                      <span className="text-xs font-semibold text-[#1F1A13] w-24 text-left tabular-nums">{money(d.total)}</span>
                    </div>
                  ))}
                </div>
              )}
              {(data?.byMethod ?? []).length > 0 && (
                <div className="mt-4 pt-3 border-t border-[#E9E1D3]">
                  <p className="text-xs font-bold text-[#6E6557] mb-1.5">حسب طريقة الدفع</p>
                  {data!.byMethod.map(m => (<div key={m.method} className="flex justify-between text-sm"><span>{methodLabel(m.method)}</span><span className="font-semibold tabular-nums">{money(m.amount)}</span></div>))}
                </div>
              )}
            </div>

            {/* أعلى الأصناف */}
            <div className="card">
              <div className="flex items-center gap-2 mb-3"><Trophy size={16} className="text-[#E15A30]" /><h2 className="font-bold text-[#1F1A13]">أعلى الأصناف مبيعاً</h2></div>
              {(data?.topItems ?? []).length === 0 ? <p className="text-sm text-gray-400 py-6 text-center">لا بيانات</p> : (
                <div className="space-y-2.5">
                  {data!.topItems.map((it, i) => (
                    <div key={it.name + i} className="flex items-center gap-3">
                      <span className={`w-6 h-6 shrink-0 rounded-full text-xs font-bold flex items-center justify-center ${i === 0 ? 'bg-[#E15A30] text-white' : 'bg-[#FBEBE2] text-[#C94E28]'}`}>{i + 1}</span>
                      <span className="flex-1 text-sm text-[#1F1A13] truncate">{it.name}</span>
                      <span className="text-xs text-[#9A8F7E]">×{it.qty}</span>
                      <span className="text-sm font-bold text-[#1F1A13] w-24 text-left tabular-nums">{money(it.total)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
