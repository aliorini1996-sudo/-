import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { leadApi } from '../api/client';
import { formatDate } from '../utils/format';
import { X, ReceiptText, Users, Globe2, Sparkles, RefreshCw, FileText, MapPin } from 'lucide-react';

/**
 * صفحة عملاء مولّد الفواتير — مستقلة عن العملاء المحتملين:
 * كل شركة استخدمت الأداة المجانية (اسمها، رقمها الضريبي، دولتها، عدد فواتيرها وتفاصيل آخرها).
 * هؤلاء أدفأ جمهور تملكه المنصّة: موزّعون نشطون أدخلوا بياناتهم بأنفسهم وهم يصدرون فواتير فعلية.
 */

interface ToolActivity { content: string | null; createdAt: string }
interface ToolUser {
  id: string; name: string; vatNumber: string | null; country: string | null; countryCode: string | null;
  address: string | null; createdAt: string; uses: number; lastUseAt: string; activities: ToolActivity[];
}
interface ToolData { stats: { total: number; uses: number; newWeek: number; countries: number }; users: ToolUser[] }

function Kpi({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: number | string; color: string }) {
  return (
    <div className="card flex items-center gap-3">
      <div className={`w-11 h-11 rounded-xl ${color} text-white flex items-center justify-center shrink-0`}><Icon size={20} /></div>
      <div className="min-w-0">
        <p className="text-2xl font-bold text-[#1F1A13] leading-tight">{value}</p>
        <p className="text-xs text-gray-500 truncate">{label}</p>
      </div>
    </div>
  );
}

export default function InvoiceToolPanel({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState<ToolUser | null>(null);
  const [q, setQ] = useState('');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['invoice-tool-users'],
    queryFn: async () => (await leadApi.invoiceToolUsers()).data.data as ToolData,
    refetchInterval: 60000,
  });

  const users = (data?.users ?? []).filter((u) =>
    !q.trim() || u.name.includes(q.trim()) || (u.vatNumber || '').includes(q.trim()) || (u.country || '').includes(q.trim()),
  );

  return (
    <div className="fixed inset-0 z-50 bg-[#FAF7F0] overflow-y-auto" dir="rtl">
      {/* Header */}
      <header className="bg-[#1F1A13] text-white sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#1E7A52] flex items-center justify-center"><ReceiptText size={20} /></div>
            <div>
              <h1 className="font-bold">عملاء مولّد الفواتير</h1>
              <p className="text-slate-400 text-xs">شركات حقيقية استخدمت الأداة المجانية وأدخلت بياناتها بنفسها — أدفأ جمهور للتحويل</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => refetch()} className="text-slate-300 hover:text-white p-2" title="تحديث">
              <RefreshCw size={18} className={isFetching ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="text-slate-300 hover:text-white flex items-center gap-1 text-sm"><X size={18} /> إغلاق</button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
          <Kpi icon={Users} label="شركة استخدمت المولّد" value={data?.stats.total ?? 0} color="bg-[#1E7A52]" />
          <Kpi icon={FileText} label="فاتورة أُصدرت عبر الأداة" value={data?.stats.uses ?? 0} color="bg-[#E15A30]" />
          <Kpi icon={Sparkles} label="جدد هذا الأسبوع" value={data?.stats.newWeek ?? 0} color="bg-purple-600" />
          <Kpi icon={Globe2} label="دولة" value={data?.stats.countries ?? 0} color="bg-blue-600" />
        </div>

        {/* بحث */}
        <div className="mb-4">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث بالاسم / الرقم الضريبي / الدولة..." className="input max-w-md" />
        </div>

        {/* الجدول */}
        <div className="card p-0 overflow-hidden">
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>الشركة</th><th>الرقم الضريبي</th><th>الدولة</th>
                  <th className="text-center">الفواتير</th><th>آخر استخدام</th><th>أول استخدام</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={6} className="text-center py-10 text-gray-400">جارٍ التحميل...</td></tr>
                ) : users.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-12 text-gray-400">
                    لا مستخدمون بعد 🧾<br />
                    <span className="text-xs">شارك رابط الأداة في قروبات التجّار: <span dir="ltr" className="text-[#1E7A52] font-semibold">fieldsa.net/invoice-generator</span></span>
                  </td></tr>
                ) : users.map((u) => (
                  <tr key={u.id} className="cursor-pointer hover:bg-[#E4F1EA]/40" onClick={() => setSelected(u)}>
                    <td className="font-medium text-gray-800">{u.name}</td>
                    <td className="text-sm text-gray-600">{u.vatNumber ? <span dir="ltr">{u.vatNumber}</span> : <span className="text-gray-300">—</span>}</td>
                    <td className="text-sm text-gray-600">{u.country || '—'} {u.countryCode ? <span className="text-gray-400">({u.countryCode})</span> : ''}</td>
                    <td className="text-center"><span className="badge bg-[#E4F1EA] text-[#1E7A52] font-bold">{u.uses}</span></td>
                    <td className="text-sm text-gray-600">{formatDate(u.lastUseAt)}</td>
                    <td className="text-sm text-gray-400">{formatDate(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && <div className="px-4 py-2 text-xs text-gray-400 border-t border-[#E9E1D3]">إجمالي: {users.length} شركة</div>}
        </div>

        <p className="text-xs text-gray-400 mt-4">
          💡 هذه الشركات تُصدر فواتير فعلياً وتعرف علامتك — الأولى بعرض مباشر: «أعجبك المولّد؟ مندوبك يصدرها تلقائياً من جواله».
        </p>
      </div>

      {/* تفاصيل شركة: أنشطتها (آخر الفواتير) */}
      {selected && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="font-bold text-lg text-[#1F1A13]">{selected.name}</h3>
                <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                  {selected.vatNumber && <p dir="ltr" className="text-right">VAT: {selected.vatNumber}</p>}
                  {(selected.country || selected.address) && (
                    <p className="flex items-center gap-1"><MapPin size={12} /> {[selected.country, selected.address].filter(Boolean).join(' · ')}</p>
                  )}
                </div>
              </div>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <p className="text-sm font-bold text-gray-700 mb-2">🧾 آخر الفواتير الصادرة ({selected.uses} إجمالاً)</p>
            <div className="space-y-2">
              {selected.activities.length === 0 ? (
                <p className="text-sm text-gray-400">لا تفاصيل بعد</p>
              ) : selected.activities.map((a, i) => (
                <div key={i} className="rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] p-3">
                  <p className="text-sm text-gray-700 leading-relaxed">{a.content || '—'}</p>
                  <p className="text-[11px] text-gray-400 mt-1">{formatDate(a.createdAt)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
