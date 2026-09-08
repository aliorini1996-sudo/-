import { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, Circle, MapPin, ChevronRight, Repeat, CalendarDays, Route as RouteIcon } from 'lucide-react';
import repApi from './repApi';
import { useTr } from '../i18n/strings';

/**
 * خط سير اليوم في تطبيق المندوب — العملاء بالترتيب، وعلامةٌ خضراء لمن زاره.
 *
 * **الإنجاز يأتي من الخادم مشتقّاً من سجلّ الزيارات**، لا من علامةٍ يضعها
 * المندوب هنا. فزيارةٌ سجّلها من ملفّ العميل تظهر هنا فوراً، ولا يستطيع أحد
 * أن يشطب محطّةً لم يزرها.
 *
 * وهي شاشةٌ أون‑لاين: الخطّ يتغيّر من الإدارة، ونسخةٌ محلّيةٌ قديمة تُرسل
 * المندوب إلى عميلٍ حُذف من مساره صباحاً.
 */

export interface RouteStop {
  id: string; seq: number; note: string | null;
  customerId: string; customerName: string;
  phone: string | null; address: string | null;
  lat: number | null; lng: number | null;
  done: boolean; doneAt: string | null;
}
export interface RouteToday {
  id: string; name: string; isPermanent: boolean; routeDate: string | null; day: string;
  stops: RouteStop[]; doneCount: number; total: number;
}

/** يوم الجهاز — لا يوم الخادم، فالمندوب قد يكون في يومٍ آخر */
function dayKeyLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function fetchMyRoute(): Promise<RouteToday | null> {
  const res = await repApi.get('/rep-routes/mine', {
    params: { date: dayKeyLocal(), tzOffsetMin: -new Date().getTimezoneOffset() },
    background: true,
  });
  return (res.data?.data ?? null) as RouteToday | null;
}

export default function RepRouteScreen({ onBack }: { onBack: () => void }) {
  const tr = useTr();
  const [route, setRoute] = useState<RouteToday | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try { setRoute(await fetchMyRoute()); }
    catch { setFailed(true); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full pb-24">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-2 -mr-2 text-gray-500"><ChevronRight size={20} /></button>
        <div className="flex-1">
          <p className="font-bold text-[#1F1A13] flex items-center gap-1.5">
            <RouteIcon size={17} className="text-[#E15A30]" /> {tr('خط السير')}
          </p>
          {route && (
            <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1">
              {route.isPermanent
                ? <><Repeat size={10} /> {tr('دائم')}</>
                : <><CalendarDays size={10} /> {route.routeDate}</>}
              {' · '}{route.name}
            </p>
          )}
        </div>
        <button onClick={load} className="text-xs text-[#E15A30] px-2">{tr('تحديث')}</button>
      </div>

      {loading ? (
        <p className="text-center text-gray-400 py-10 text-sm">{tr('جاري التحميل')}</p>
      ) : failed ? (
        <div className="text-center py-10">
          <p className="text-sm text-gray-500">{tr('تعذر تحميل خط السير')}</p>
          <button onClick={load} className="text-xs text-[#E15A30] mt-2">{tr('إعادة المحاولة')}</button>
        </div>
      ) : !route ? (
        <div className="text-center py-12">
          <RouteIcon size={30} className="mx-auto text-gray-300" />
          <p className="text-sm text-gray-500 mt-2">{tr('لا خط سير لك اليوم')}</p>
          <p className="text-[11px] text-gray-400 mt-1">{tr('تحدده الإدارة من لوحة التحكم')}</p>
        </div>
      ) : (
        <>
          {/* التقدّم */}
          <div className="bg-white rounded-2xl p-4 border-2 border-[#F1EBDF]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-500">{tr('أنجزت')}</span>
              <span className="text-sm font-bold text-[#1F1A13]">{route.doneCount} / {route.total}</span>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{ width: `${route.total ? (route.doneCount / route.total) * 100 : 0}%` }}
              />
            </div>
          </div>

          <div className="space-y-2">
            {route.stops.map(s => (
              <div
                key={s.id}
                className={`w-full text-right rounded-2xl p-3 border-2 flex items-start gap-3
                  ${s.done ? 'bg-green-50/60 border-green-200' : 'bg-white border-gray-100'}`}
              >
                <span className="shrink-0 mt-0.5">
                  {s.done
                    ? <CheckCircle2 size={22} className="text-green-600" />
                    : <span className="w-[22px] h-[22px] rounded-full bg-[#FFF1EA] text-[#E15A30] text-[11px] font-bold flex items-center justify-center">{s.seq}</span>}
                </span>
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm font-semibold truncate ${s.done ? 'text-green-800' : 'text-[#1F1A13]'}`}>
                    {s.customerName}
                  </span>
                  {s.address && (
                    <span className="block text-[11px] text-gray-400 truncate mt-0.5 flex items-center gap-1">
                      <MapPin size={10} className="shrink-0" /> {s.address}
                    </span>
                  )}
                  {s.note && <span className="block text-[11px] text-[#B7791F] mt-0.5">{s.note}</span>}
                  {s.done && s.doneAt && (
                    <span className="block text-[10px] text-green-700 mt-0.5">
                      {tr('زرته')} {new Date(s.doneAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </span>
                {/* موقع العميل على الخرائط — أنفع للمندوب من الاتصال وهو في
                    الطريق. وعميلٌ بلا إحداثيات تظهر أيقونته باهتةً معطَّلة، لا
                    تختفي: غيابها يُقرأ «العميل بلا موقع» فيبحث عنه بنفسه، بينما
                    الفراغ يُقرأ عطلاً في التطبيق. */}
                {s.lat != null && s.lng != null ? (
                  <a
                    href={`https://www.google.com/maps?q=${s.lat},${s.lng}`}
                    target="_blank" rel="noreferrer"
                    title={tr('موقع العميل على الخريطة')}
                    className="shrink-0 w-9 h-9 rounded-xl bg-[#FFF1EA] text-[#E15A30] flex items-center justify-center"
                  >
                    <MapPin size={16} />
                  </a>
                ) : (
                  <span
                    title={tr('لا موقع مسجل لهذا العميل')}
                    className="shrink-0 w-9 h-9 rounded-xl bg-gray-50 text-gray-300 flex items-center justify-center"
                  >
                    <MapPin size={16} />
                  </span>
                )}
              </div>
            ))}
          </div>

          {route.doneCount === route.total && route.total > 0 && (
            <p className="text-center text-sm text-green-700 font-semibold py-2 flex items-center justify-center gap-1.5">
              <CheckCircle2 size={16} /> {tr('أنهيت خط سيرك اليوم')}
            </p>
          )}

          {/* الزيارة تُسجَّل من ملفّ العميل — والعلامة تتبعها، لا العكس */}
          <p className="text-[11px] text-gray-400 text-center">
            {tr('تظهر العلامة الخضراء تلقائيا بعد تسجيل الزيارة من ملف العميل')}
          </p>
        </>
      )}
    </div>
  );
}

/** أيقونة الشاشة — مستقلّة كي لا يُستورد الملفّ كلّه لأجلها */
export { Circle as RouteDot };
