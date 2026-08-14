import { useState, lazy, Suspense, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '../api/client';
import { X, RefreshCw, Radio, Truck, Users, Building2, UtensilsCrossed, TrendingUp, Activity, ChevronDown, Clock } from 'lucide-react';
import type { HistPoint } from './LiveHistoryChart';

// المؤشّر البياني (recharts الثقيلة) — كسولاً كي لا يُثقل إقلاع لوحة المالك
const LiveHistoryChart = lazy(() => import('./LiveHistoryChart'));

interface LiveUser { id: string; name: string; kind: 'rep' | 'admin'; lastSeenAt: string | null }
interface Company { tenantId: string; name: string; vertical: string; reps: number; admins: number; total: number; users: LiveUser[] }
interface Live {
  windowMinutes: number;
  total: number; totalReps: number; totalAdmins: number;
  activeCompanies: number;
  companies: Company[];
  serverTime: string;
}
interface Hist { range: string; bucket: string; points: HistPoint[]; peak: number; count: number }

interface ReqUser { userId: string; name: string; kind: 'rep' | 'admin'; requests: number }
interface ReqCompany { tenantId: string; name: string; vertical: string; requests: number; users: ReqUser[] }
interface ReqStats { range: string; days: number; totalRequests: number; activeCompanies: number; companies: ReqCompany[] }

const RANGES: { key: string; label: string }[] = [
  { key: '24h', label: '٢٤ ساعة' },
  { key: '7d', label: '٧ أيام' },
  { key: '30d', label: '٣٠ يوماً' },
];
const REQ_RANGES: { key: string; label: string }[] = [
  { key: 'today', label: 'اليوم' },
  { key: '7d', label: '٧ أيام' },
  { key: '30d', label: '٣٠ يوماً' },
];

// أرقام غربية بفواصل آلاف — لتوحيد الترقيم مع وضع «مباشر» وبقيّة اللوحة
const nf = (n: number): string => n.toLocaleString('en-US');
const fmtClock = (s?: string): string => {
  if (!s) return '—';
  return new Date(s).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
// «آخر ظهور» نسبيّاً (للمتصلين الآن — دائماً خلال ٥ دقائق)
const fmtAgo = (s?: string | null): string => {
  if (!s) return '—';
  const m = Math.floor((Date.now() - new Date(s).getTime()) / 60000);
  if (m <= 0) return 'الآن';
  if (m === 1) return 'منذ دقيقة';
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.floor(m / 60);
  return `منذ ${h} ساعة`;
};

// لوحة «الزيارات الحية» لمالك المنصّة — وضعان:
//  • «مباشر»: من يستخدم المنصّة الآن (منحنى زمنيّ + أسماء المتصلين لكل شركة).
//  • «الطلبات»: استهلاك طلبات API لكل مستخدم وشركة خلال مدى زمنيّ.
export default function LiveUsersPanel({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'live' | 'requests'>('live');
  const [range, setRange] = useState('24h');
  const [reqRange, setReqRange] = useState('today');
  const [expanded, setExpanded] = useState<string | null>(null); // الشركة المفتوحة

  const { data, isLoading, isError, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['live-users'],
    queryFn: async () => { const r = await analyticsApi.liveUsers(); return r.data.data as Live; },
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    enabled: mode === 'live', // لا نستطلع الحضور بينما المالك في وضع «الطلبات»
  });

  // المؤشّر الزمنيّ — تحديث أبطأ (اللقطة تُلتقط كل ٥ دقائق)
  const { data: hist, isLoading: histLoading, isError: histError, refetch: histRefetch } = useQuery({
    queryKey: ['live-history', range],
    queryFn: async () => { const r = await analyticsApi.liveHistory(range); return r.data.data as Hist; },
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    enabled: mode === 'live',
  });

  // استهلاك الطلبات — يُجلب فقط في وضع «الطلبات»
  const { data: req, isLoading: reqLoading, isError: reqError, refetch: reqRefetch, isFetching: reqFetching } = useQuery({
    queryKey: ['request-stats', reqRange],
    queryFn: async () => { const r = await analyticsApi.requestStats(reqRange); return r.data.data as ReqStats; },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    enabled: mode === 'requests',
  });

  const total = data?.total ?? 0;
  const toggle = (id: string) => setExpanded(p => (p === id ? null : id));

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
              <p className="text-xs text-[#6E6557]">من يستخدم المنصّة — مباشرةً واستهلاكاً، عبر كل الشركات</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {mode === 'live' && (
              <span className="hidden sm:inline text-[11px] text-[#9A8F7E]">آخر تحديث: {fmtClock(dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : undefined)}</span>
            )}
            <button onClick={() => { if (mode === 'live') { refetch(); histRefetch(); } else { reqRefetch(); } }} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" title="تحديث الآن">
              <RefreshCw size={15} className={(mode === 'live' ? isFetching : reqFetching) ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>
        </div>

        {/* مبدّل الوضع */}
        <div className="px-5 pt-4">
          <div className="inline-flex w-full sm:w-auto bg-[#F3EDE3] rounded-xl p-0.5">
            <ModeBtn active={mode === 'live'} onClick={() => { setMode('live'); setExpanded(null); }} icon={Radio} label="مباشر" />
            <ModeBtn active={mode === 'requests'} onClick={() => { setMode('requests'); setExpanded(null); }} icon={Activity} label="الطلبات" />
          </div>
        </div>

        {/* ————— وضع «مباشر» ————— */}
        {mode === 'live' && (
          isLoading ? (
            <div className="py-20 text-center text-gray-400">جارٍ قياس النشاط اللحظي…</div>
          ) : isError ? (
            <div className="py-20 text-center text-red-500 px-6">تعذّر تحميل البيانات — قد تكون الخدمة قيد النشر. أعد المحاولة بعد قليل.</div>
          ) : (
            <div className="p-5 space-y-5">
              {/* المؤشّر الزمنيّ */}
              <div className="rounded-2xl border border-[#E9E1D3] bg-white p-4">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#1E7A52]">
                      <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> متصل الآن
                    </span>
                    <span className="text-3xl font-extrabold text-[#1F1A13] tabular-nums leading-none">{total}</span>
                    {hist && hist.peak > 0 && (
                      <span className="text-[11px] text-[#6E6557] inline-flex items-center gap-1">
                        <TrendingUp size={12} className="text-[#E15A30]" /> الذروة في المدّة: <b className="text-[#1F1A13]">{hist.peak}</b>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center bg-[#F3EDE3] rounded-lg p-0.5">
                    {RANGES.map(r => (
                      <button key={r.key} onClick={() => setRange(r.key)}
                        className={`text-[11px] font-semibold px-2.5 py-1 rounded-md transition-colors ${range === r.key ? 'bg-white text-[#1E7A52] shadow-sm' : 'text-[#6E6557]'}`}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>

                {histLoading ? (
                  <div className="h-[200px] grid place-items-center text-gray-400 text-sm">جارٍ تحميل المنحنى…</div>
                ) : histError ? (
                  <div className="h-[200px] grid place-items-center text-center px-6 text-sm text-red-500">
                    تعذّر تحميل المؤشّر الزمنيّ — سيُعاد المحاولة تلقائياً.
                  </div>
                ) : (hist?.points?.length ?? 0) < 2 ? (
                  <div className="h-[200px] grid place-items-center text-center px-6">
                    <div>
                      <div className="w-12 h-12 bg-green-50 rounded-2xl flex items-center justify-center mx-auto mb-3">
                        <TrendingUp size={22} className="text-[#1E7A52]" />
                      </div>
                      <p className="font-bold text-[#1F1A13] text-sm">المؤشّر الزمنيّ يبدأ بالتجميع الآن</p>
                      <p className="text-xs text-[#6E6557] mt-1 max-w-xs mx-auto">
                        تُلتقط لقطةٌ لعدد المتصلين كل ٥ دقائق. عُد بعد قليل لرؤية المنحنى عبر التاريخ والوقت.
                      </p>
                    </div>
                  </div>
                ) : (
                  <Suspense fallback={<div className="h-[200px] grid place-items-center text-gray-400 text-sm">…</div>}>
                    <LiveHistoryChart points={hist!.points} bucket={hist!.bucket} />
                  </Suspense>
                )}
                <p className="text-[11px] text-[#9A8F7E] text-center mt-2">
                  مرّر فوق المنحنى لمعرفة عدد المتصلين في كل وقتٍ بعينه. {range !== '24h' ? 'النقطة = ذروة الإشغال في تلك الفترة.' : 'نقطةٌ كل ٥ دقائق.'}
                </p>
              </div>

              {/* تقسيم: المناديب | مستخدمو الشركة */}
              <div className="grid grid-cols-2 gap-3">
                <Split icon={Truck} label="المناديب" value={data?.totalReps ?? 0} color="text-[#E15A30]" bg="bg-[#FBEBE2]" />
                <Split icon={Users} label="مستخدمو الشركة" value={data?.totalAdmins ?? 0} color="text-[#2563EB]" bg="bg-blue-50" />
              </div>

              <div className="flex items-center justify-center gap-2 text-[13px] text-[#6E6557]">
                <Building2 size={15} className="text-[#9A8F7E]" />
                <span>الشركات النشطة الآن: <b className="text-[#1F1A13]">{data?.activeCompanies ?? 0}</b></span>
              </div>

              {/* جدول الشركات — قابل للتوسيع لإظهار أسماء المتصلين */}
              <div className="bg-white border border-[#E9E1D3] rounded-2xl overflow-hidden">
                <h3 className="text-sm font-bold text-[#1F1A13] px-4 pt-4 pb-2">المتصلون الآن حسب الشركة</h3>
                {(!data || data.companies.length === 0) ? (
                  <div className="py-14 text-center px-6">
                    <div className="w-12 h-12 bg-[#F3EDE3] rounded-2xl flex items-center justify-center mx-auto mb-3">
                      <Radio size={22} className="text-[#9A8F7E]" />
                    </div>
                    <p className="font-bold text-[#1F1A13]">لا مستخدمين متصلين الآن</p>
                    <p className="text-sm text-[#6E6557] mt-1 max-w-sm mx-auto">
                      يظهر المستخدمون هنا فور فتحهم تطبيق المندوب أو لوحة الشركة. اضغط أيّ شركة لرؤية أسماء المتصلين.
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
                          const open = expanded === c.tenantId;
                          return (
                            <Fragment key={c.tenantId}>
                              <tr className="border-t border-[#F1EBDF] cursor-pointer hover:bg-[#FAF7F0]" onClick={() => toggle(c.tenantId)}>
                                <td className="px-4 py-2.5">
                                  <span className="inline-flex items-center gap-1.5 font-medium text-[#1F1A13]">
                                    <ChevronDown size={13} className={`text-[#9A8F7E] transition-transform ${open ? '' : '-rotate-90'}`} />
                                    <Vic size={14} className={c.vertical === 'restaurant' ? 'text-[#B5322A]' : 'text-[#E15A30]'} />
                                    <span className="truncate max-w-[200px]">{c.name}</span>
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
                              {open && (
                                <tr className="bg-[#FAF7F0]">
                                  <td colSpan={4} className="px-4 py-2">
                                    <div className="space-y-1">
                                      {c.users.map((u) => (
                                        <div key={u.kind + u.id} className="flex items-center justify-between text-[12.5px] py-1 border-b border-[#F1EBDF] last:border-0">
                                          <span className="inline-flex items-center gap-2">
                                            {u.kind === 'rep'
                                              ? <Truck size={13} className="text-[#E15A30]" />
                                              : <Users size={13} className="text-[#2563EB]" />}
                                            <span className="font-medium text-[#1F1A13]">{u.name}</span>
                                            <span className="text-[10px] text-[#9A8F7E]">{u.kind === 'rep' ? 'مندوب' : 'مستخدم شركة'}</span>
                                          </span>
                                          <span className="inline-flex items-center gap-1 text-[11px] text-[#6E6557]">
                                            <Clock size={11} /> {fmtAgo(u.lastSeenAt)}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <p className="text-[11px] text-[#9A8F7E] text-center">
                «متصل الآن» = نشاطٌ خلال آخر {data?.windowMinutes ?? 5} دقائق. اضغط أيّ شركة لأسماء المتصلين. اللوحة تُحدَّث تلقائياً كل ١٥ ثانية.
              </p>
            </div>
          )
        )}

        {/* ————— وضع «الطلبات» ————— */}
        {mode === 'requests' && (
          <div className="p-5 space-y-5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-semibold text-[#1F1A13] inline-flex items-center gap-1.5">
                  <Activity size={15} className="text-[#E15A30]" /> إجمالي الطلبات
                </span>
                <span className="text-3xl font-extrabold text-[#1F1A13] tabular-nums leading-none">{nf(req?.totalRequests ?? 0)}</span>
              </div>
              <div className="flex items-center bg-[#F3EDE3] rounded-lg p-0.5">
                {REQ_RANGES.map(r => (
                  <button key={r.key} onClick={() => setReqRange(r.key)}
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded-md transition-colors ${reqRange === r.key ? 'bg-white text-[#E15A30] shadow-sm' : 'text-[#6E6557]'}`}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-center gap-2 text-[13px] text-[#6E6557]">
              <Building2 size={15} className="text-[#9A8F7E]" />
              <span>الشركات ذات النشاط: <b className="text-[#1F1A13]">{req?.activeCompanies ?? 0}</b></span>
            </div>

            <div className="bg-white border border-[#E9E1D3] rounded-2xl overflow-hidden">
              <h3 className="text-sm font-bold text-[#1F1A13] px-4 pt-4 pb-2">استهلاك الطلبات حسب الشركة</h3>
              {reqLoading ? (
                <div className="py-14 text-center text-gray-400 text-sm">جارٍ تحميل الاستهلاك…</div>
              ) : reqError ? (
                <div className="py-14 text-center text-red-500 text-sm px-6">تعذّر تحميل استهلاك الطلبات — قد تكون الخدمة قيد النشر.</div>
              ) : (!req || req.companies.length === 0) ? (
                <div className="py-14 text-center px-6">
                  <div className="w-12 h-12 bg-[#FBEBE2] rounded-2xl flex items-center justify-center mx-auto mb-3">
                    <Activity size={22} className="text-[#9A8F7E]" />
                  </div>
                  <p className="font-bold text-[#1F1A13]">لا طلبات مُسجّلة في هذه المدّة</p>
                  <p className="text-sm text-[#6E6557] mt-1 max-w-sm mx-auto">
                    يبدأ عدّ الطلبات من لحظة تفعيل الميزة ويتراكم تصاعدياً. اضغط أيّ شركة لتفصيل كل مستخدم.
                  </p>
                </div>
              ) : (
                <div className="max-h-[52vh] overflow-y-auto">
                  <table className="w-full text-[13px]">
                    <thead className="text-[#9A8F7E] text-[11px] sticky top-0 bg-[#FAF7F0]">
                      <tr>
                        <th className="text-right font-medium px-4 py-2">الشركة</th>
                        <th className="text-center font-medium py-2">المستخدمون</th>
                        <th className="text-center font-medium px-4 py-2">الطلبات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {req.companies.map((c) => {
                        const Vic = c.vertical === 'restaurant' ? UtensilsCrossed : Truck;
                        const open = expanded === c.tenantId;
                        return (
                          <Fragment key={c.tenantId}>
                            <tr className="border-t border-[#F1EBDF] cursor-pointer hover:bg-[#FAF7F0]" onClick={() => toggle(c.tenantId)}>
                              <td className="px-4 py-2.5">
                                <span className="inline-flex items-center gap-1.5 font-medium text-[#1F1A13]">
                                  <ChevronDown size={13} className={`text-[#9A8F7E] transition-transform ${open ? '' : '-rotate-90'}`} />
                                  <Vic size={14} className={c.vertical === 'restaurant' ? 'text-[#B5322A]' : 'text-[#E15A30]'} />
                                  <span className="truncate max-w-[200px]">{c.name}</span>
                                </span>
                              </td>
                              <td className="text-center py-2.5 tabular-nums text-[#6E6557]">{nf(c.users.length)}</td>
                              <td className="text-center px-4 py-2.5 font-bold text-[#E15A30] tabular-nums">{nf(c.requests)}</td>
                            </tr>
                            {open && (
                              <tr className="bg-[#FAF7F0]">
                                <td colSpan={3} className="px-4 py-2">
                                  <div className="space-y-1">
                                    {c.users.map((u) => (
                                      <div key={u.kind + u.userId} className="flex items-center justify-between text-[12.5px] py-1 border-b border-[#F1EBDF] last:border-0">
                                        <span className="inline-flex items-center gap-2">
                                          {u.kind === 'rep'
                                            ? <Truck size={13} className="text-[#E15A30]" />
                                            : <Users size={13} className="text-[#2563EB]" />}
                                          <span className="font-medium text-[#1F1A13]">{u.name}</span>
                                          <span className="text-[10px] text-[#9A8F7E]">{u.kind === 'rep' ? 'مندوب' : 'مستخدم شركة'}</span>
                                        </span>
                                        <span className="font-semibold text-[#1F1A13] tabular-nums">{nf(u.requests)}</span>
                                      </div>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="text-[11px] text-[#9A8F7E] text-center">
              «الطلبات» = عدد نداءات API الفعليّة لكل مستخدم (يشمل النبضات الخلفية للموقع والحضور). يبدأ العدّ من تفعيل الميزة ويُجمَّع بأيّام الرياض.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: React.ElementType; label: string }) {
  return (
    <button onClick={onClick}
      className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 text-[13px] font-semibold px-4 py-1.5 rounded-lg transition-colors ${active ? 'bg-white text-[#1F1A13] shadow-sm' : 'text-[#6E6557]'}`}>
      <Icon size={15} className={active ? 'text-[#1E7A52]' : ''} /> {label}
    </button>
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
