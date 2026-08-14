import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '../api/client';
import { X, RefreshCw, Radio, Truck, Users, Building2, UtensilsCrossed } from 'lucide-react';

interface Company { tenantId: string; name: string; vertical: string; reps: number; admins: number; total: number }
interface Live {
  windowMinutes: number;
  total: number; totalReps: number; totalAdmins: number;
  activeCompanies: number;
  companies: Company[];
  serverTime: string;
}

const fmtClock = (s?: string): string => {
  if (!s) return '—';
  return new Date(s).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

// لوحة «الزيارات الحية» — من يستخدم المنصّة الآن عبر كل الشركات (لمالك المنصّة).
// تُحدّث نفسها تلقائياً كل ١٥ ثانية لتبقى المؤشّرات لحظيّة.
export default function LiveUsersPanel({ onClose }: { onClose: () => void }) {
  const { data, isLoading, isError, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['live-users'],
    queryFn: async () => { const r = await analyticsApi.liveUsers(); return r.data.data as Live; },
    refetchInterval: 15000,          // نبض تلقائي كل ١٥ ثانية
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const total = data?.total ?? 0;

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* الترويسة */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3] sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center relative">
              <Radio size={20} className="text-[#1E7A52]" />
              <span className="absolute -top-0.5 -left-0.5 w-2.5 h-2.5 rounded-full bg-green-500 ring-2 ring-white animate-pulse" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">الزيارات الحية</h2>
              <p className="text-xs text-[#6E6557]">من يستخدم المنصّة الآن — مباشرةً عبر كل الشركات</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-[11px] text-[#9A8F7E]">آخر تحديث: {fmtClock(dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : undefined)}</span>
            <button onClick={() => refetch()} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" title="تحديث الآن">
              <RefreshCw size={15} className={isFetching ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-gray-400">جارٍ قياس النشاط اللحظي…</div>
        ) : isError ? (
          <div className="py-20 text-center text-red-500 px-6">تعذّر تحميل البيانات — قد تكون الخدمة قيد النشر. أعد المحاولة بعد قليل.</div>
        ) : (
          <div className="p-5 space-y-5">
            {/* البطاقة الكبرى — الإجمالي المتصل الآن */}
            <div className="rounded-2xl border border-green-200 bg-gradient-to-b from-green-50 to-white p-6 text-center">
              <div className="inline-flex items-center gap-2 text-[13px] font-semibold text-[#1E7A52] mb-1">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> متصل الآن
              </div>
              <p className="text-6xl font-extrabold text-[#1F1A13] tabular-nums leading-none my-2">{total}</p>
              <p className="text-xs text-[#6E6557]">
                مستخدم يستعمل المنصّة خلال آخر {data?.windowMinutes ?? 5} دقائق
              </p>
            </div>

            {/* تقسيم: المناديب | مستخدمو الشركة */}
            <div className="grid grid-cols-2 gap-3">
              <Split icon={Truck} label="المناديب" value={data?.totalReps ?? 0} color="text-[#E15A30]" bg="bg-[#FBEBE2]" />
              <Split icon={Users} label="مستخدمو الشركة" value={data?.totalAdmins ?? 0} color="text-[#2563EB]" bg="bg-blue-50" />
            </div>

            {/* شريط: عدد الشركات النشطة */}
            <div className="flex items-center justify-center gap-2 text-[13px] text-[#6E6557]">
              <Building2 size={15} className="text-[#9A8F7E]" />
              <span>الشركات النشطة الآن: <b className="text-[#1F1A13]">{data?.activeCompanies ?? 0}</b></span>
            </div>

            {/* جدول التفصيل لكل شركة */}
            <div className="bg-white border border-[#E9E1D3] rounded-2xl overflow-hidden">
              <h3 className="text-sm font-bold text-[#1F1A13] px-4 pt-4 pb-2">التوزيع حسب الشركة</h3>
              {(!data || data.companies.length === 0) ? (
                <div className="py-14 text-center px-6">
                  <div className="w-12 h-12 bg-[#F3EDE3] rounded-2xl flex items-center justify-center mx-auto mb-3">
                    <Radio size={22} className="text-[#9A8F7E]" />
                  </div>
                  <p className="font-bold text-[#1F1A13]">لا مستخدمين متصلين الآن</p>
                  <p className="text-sm text-[#6E6557] mt-1 max-w-sm mx-auto">
                    يظهر المستخدمون هنا فور فتحهم تطبيق المندوب أو لوحة الشركة. تُحدَّث اللوحة تلقائياً كل ١٥ ثانية.
                  </p>
                </div>
              ) : (
                <div className="max-h-[46vh] overflow-y-auto">
                  <table className="w-full text-[13px]">
                    <thead className="text-[#9A8F7E] text-[11px] sticky top-0 bg-[#FAF7F0]">
                      <tr>
                        <th className="text-right font-medium px-4 py-2">الشركة</th>
                        <th className="text-center font-medium py-2">المناديب</th>
                        <th className="text-center font-medium py-2">مستخدمو الشركة</th>
                        <th className="text-center font-medium px-4 py-2">الإجمالي</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.companies.map((c) => {
                        const Vic = c.vertical === 'restaurant' ? UtensilsCrossed : Truck;
                        return (
                          <tr key={c.tenantId} className="border-t border-[#F1EBDF]">
                            <td className="px-4 py-2.5">
                              <span className="inline-flex items-center gap-2 font-medium text-[#1F1A13]">
                                <Vic size={14} className={c.vertical === 'restaurant' ? 'text-[#B5322A]' : 'text-[#E15A30]'} />
                                <span className="truncate max-w-[220px]">{c.name}</span>
                              </span>
                            </td>
                            <td className="text-center py-2.5 tabular-nums text-[#E15A30] font-semibold">{c.reps || '—'}</td>
                            <td className="text-center py-2.5 tabular-nums text-[#2563EB] font-semibold">{c.admins || '—'}</td>
                            <td className="text-center px-4 py-2.5">
                              <span className="inline-flex items-center gap-1.5 font-bold text-[#1F1A13] tabular-nums">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> {c.total}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="text-[11px] text-[#9A8F7E] text-center">
              «متصل الآن» = نشاطٌ خلال آخر {data?.windowMinutes ?? 5} دقائق. المندوب يُحسب بنبض تطبيقه، ومستخدم الشركة بآخر طلب من لوحته. اللوحة تُحدَّث تلقائياً كل ١٥ ثانية.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Split({ icon: Icon, label, value, color, bg }: { icon: React.ElementType; label: string; value: number; color: string; bg: string }) {
  return (
    <div className="bg-white rounded-xl p-4 border border-[#E9E1D3] flex items-center gap-3">
      <div className={`w-11 h-11 ${bg} rounded-xl flex items-center justify-center shrink-0`}><Icon size={20} className={color} /></div>
      <div>
        <p className={`text-2xl font-bold ${color} tabular-nums leading-none`}>{value}</p>
        <p className="text-[12px] text-[#6E6557] mt-1">{label}</p>
      </div>
    </div>
  );
}
