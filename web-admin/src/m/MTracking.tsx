import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, Polyline, CircleMarker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Radio, Power, ClipboardCheck, Store, Timer, X, ChevronUp, ChevronDown, Layers, Phone, MapPin,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { trackingApi, visitsApi, customerApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { MSpinner, MError } from './mobileUi';
import { expectArray, expectObject } from './shape';
import { SA_CENTER, isOnline, repIcon, visitIcon, customerIcon, fmtDur, timeText } from './mapIcons';
import { useIsLive, livePoll } from './useLiveQuery';

interface LiveRep {
  id: string; name: string; phone: string; isActive: boolean;
  lastLat: number | null; lastLng: number | null; lastSeenAt: string | null; visitsToday: number;
}
interface RoutePoint { lat: number; lng: number; accuracy: number | null; speed: number | null; capturedAt: string }
type SegKind = 'observed' | 'inferred' | 'raw';
/** أنماط رسم المقاطع — مطابقة للوحة المكتبية عمداً: عينُ المشرف واحدة */
const ROUTE_STYLE: Record<SegKind, Record<string, unknown>> = {
  observed: { color: '#E15A30', weight: 5, opacity: 0.9 },
  inferred: { color: '#9A8F7E', weight: 3.5, opacity: 0.75 },
  raw: { color: '#B7791F', weight: 3, opacity: 0.7, dashArray: '2 7' },
};
interface RouteSegment { kind: SegKind; points: { lat: number; lng: number }[]; meters: number }
interface RouteShape { segments: RouteSegment[]; observedMeters: number; inferredMeters: number; rawMeters: number; truncated: boolean; degraded: boolean }
interface RouteResp { points: RoutePoint[]; snapped: { lat: number; lng: number }[] | null; shape: RouteShape | null }
interface Visit {
  id: string; note: string | null; lat: number | null; lng: number | null; createdAt: string;
  durationSec: number | null; startedAt: string | null; endedAt: string | null;
  customer: { id: string; name: string; phone: string | null } | null;
  _count: { photos: number };
}
interface VisitDetail extends Visit {
  salesRep: { id: string; name: string } | null;
  photos: { id: string; data: string }[];
}
interface CustomerLoc {
  id: string; name: string; businessName: string | null; phone: string | null;
  city: string | null; district: string | null; address: string | null;
  lat: number; lng: number;
}

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) { map.setView(points[0], 15); return; }
    if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 16 });
  }, [points, map]);
  return null;
}

/**
 * تبويب تتبّع المناديب.
 *
 * إعادة تصميم لا تصغير: العمود الجانبيّ ٣٤٠px في اللوحة يبتلع شاشة الجوال
 * كاملةً، فصار **ورقةً سفلية منزلقة** تُفتح وتُغلق بسحبة؛ والخريطة تملأ الجسم.
 *
 * وتفاصيل الزيارة **شاشة كاملة بزرّ رجوع** لا نافذة: نوافذُ فوق نوافذ على
 * الجوال تُربك زرّ الرجوع في الجهاز.
 *
 * قيود مُعلَنة: التبويب **للقراءة** (كل نداءاته GET عدا مفتاح التفعيل)،
 * و**لا يعمل دون اتصال** (بلاطات الخريطة من الشبكة).
 */
export default function MTracking() {
  const tr = useTr();
  const qc = useQueryClient();
  const live = useIsLive();
  const [selected, setSelected] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [openVisit, setOpenVisit] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [satellite, setSatellite] = useState(false);
  const [showCustomers, setShowCustomers] = useState(false);
  const [confirmToggle, setConfirmToggle] = useState(false);
  const [pickedCustomer, setPickedCustomer] = useState<CustomerLoc | null>(null);

  const settingsQ = useQuery({
    queryKey: ['m-track-settings'],
    queryFn: async () => expectObject<{ enabled: boolean }>((await trackingApi.settings()).data?.data, tr('إعدادات التتبّع')),
  });

  const liveQ = useQuery({
    queryKey: ['m-track-live'],
    queryFn: async () => expectArray<LiveRep>((await trackingApi.live()).data?.data, tr('المناديب')),
    refetchInterval: livePoll(25000, live),
    enabled: settingsQ.data?.enabled !== false,
  });

  const routeQ = useQuery({
    queryKey: ['m-track-route', selected, date],
    queryFn: async () => {
      const res = await trackingApi.route(selected, date);
      const d = res.data?.data;
      return {
        points: Array.isArray(d) ? d : (d as RouteResp)?.points ?? [],
        snapped: (res.data as { snapped?: RouteResp['snapped'] })?.snapped ?? null,
        shape: (res.data as { shape?: RouteShape | null })?.shape ?? null,
      } as RouteResp;
    },
    enabled: !!selected,
  });

  const visitsQ = useQuery({
    queryKey: ['m-track-visits', selected, date],
    queryFn: async () => expectArray<Visit>((await visitsApi.byRep(selected, date)).data?.data, tr('الزيارات')),
    enabled: !!selected,
  });

  const visitDetailQ = useQuery({
    queryKey: ['m-visit', openVisit],
    queryFn: async () => expectObject<VisitDetail>((await visitsApi.detail(openVisit!)).data?.data, tr('الزيارة')),
    enabled: !!openVisit,
  });

  const custQ = useQuery({
    queryKey: ['m-customer-locs'],
    queryFn: async () => expectArray<CustomerLoc>((await customerApi.locations()).data?.data, tr('مواقع العملاء')),
    enabled: showCustomers,
  });

  const toggle = useMutation({
    mutationFn: (v: boolean) => trackingApi.setEnabled(v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['m-track-settings'] });
      setConfirmToggle(false);
      toast.success(tr('تم تحديث إعداد التتبّع'));
    },
    onError: () => { setConfirmToggle(false); toast.error(tr('تعذّر التحديث')); },
  });

  const reps = liveQ.data ?? [];
  const sel = reps.find(r => r.id === selected) || null;

  // رقم الزيارة زمنيّ (١ = أول زيارة): القائمة تنزل أحدثَ أولاً، والترقيم
  // بالموضع كان يقلب اليوم — نفس إصلاح خريطة اللوحة المكتبية حرفياً.
  const visitNo = useMemo(() => new Map((visitsQ.data ?? []).map((v, i) => [v.id, (visitsQ.data ?? []).length - i])), [visitsQ.data]);
  const focusPoints = useMemo<[number, number][]>(() => {
    if (selected && routeQ.data?.points.length) return routeQ.data.points.map(p => [p.lat, p.lng]);
    if (sel?.lastLat != null && sel?.lastLng != null) return [[sel.lastLat, sel.lastLng]];
    return reps.filter(r => r.lastLat != null && r.lastLng != null).map(r => [r.lastLat!, r.lastLng!]);
  }, [selected, routeQ.data, sel, reps]);

  // نفس تمييز اللوحة المكتبية: المقطع المُرجَّح (أعاده محرّك التوجيه بين نقطتين
  // متباعدتين) يُرسم متصلاً بطلب المالك، ويبقى مميّزاً بلونه الباهت ووسمه «مُرجَّح».
  const segs = useMemo<{ kind: SegKind; pos: [number, number][] }[]>(() => {
    const ss = routeQ.data?.shape?.segments?.filter(g => g.points.length > 1) || [];
    if (ss.length) return ss.map(g => ({ kind: g.kind, pos: g.points.map(p => [p.lat, p.lng] as [number, number]) }));
    const raw = routeQ.data?.points.map(p => [p.lat, p.lng] as [number, number]) ?? [];
    return raw.length > 1 ? [{ kind: 'raw' as SegKind, pos: raw }] : [];
  }, [routeQ.data]);
  const line = useMemo(() => segs.flatMap(g => g.pos), [segs]);

  // تفاصيل الزيارة — شاشة كاملة
  if (openVisit) {
    return <VisitScreen q={visitDetailQ} onBack={() => setOpenVisit(null)} />;
  }

  if (settingsQ.isLoading) return <MSpinner />;
  if (settingsQ.isError) return <MError onRetry={() => settingsQ.refetch()} />;

  const trackingOff = settingsQ.data?.enabled === false;

  return (
    <div className="h-full relative bg-[#EDE8DF]">
      {/* الخريطة تملأ الجسم */}
      <MapContainer center={SA_CENTER} zoom={11} className="w-full h-full" zoomControl={false}
        scrollWheelZoom={false} attributionControl={false}>
        <TileLayer key={satellite ? 'sat' : 'road'}
          url={`https://{s}.google.com/vt/lyrs=${satellite ? 'y' : 'm'}&x={x}&y={y}&z={z}`}
          subdomains={['mt0', 'mt1', 'mt2', 'mt3']} maxZoom={20} />
        <FitBounds points={focusPoints} />

        {reps.filter(r => r.lastLat != null && r.lastLng != null).map(r => (
          <Marker key={r.id} position={[r.lastLat!, r.lastLng!]}
            icon={repIcon(isOnline(r.lastSeenAt), (r.name || '؟').charAt(0))}
            eventHandlers={{ click: () => { setSelected(r.id); setSheetOpen(true); } }} />
        ))}

        {segs.map((g, i) => (
          <Polyline key={i} positions={g.pos}
            pathOptions={ROUTE_STYLE[g.kind]} />
        ))}
        {line.length > 1 && (
          <>
            <CircleMarker center={line[0]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: '#2F855A', fillOpacity: 1 }}>
              <Popup>
                <div style={{ direction: 'rtl', textAlign: 'center', minWidth: 96 }}>
                  <strong style={{ color: '#2F855A' }}>{tr('بداية اليوم')}</strong>
                  {routeQ.data?.points?.[0] && <><br /><span style={{ color: '#6E6557', fontSize: 12 }}>{tr('أول رصد')}: {timeText(routeQ.data.points[0].capturedAt)}</span></>}
                </div>
              </Popup>
            </CircleMarker>
            <CircleMarker center={line[line.length - 1]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: '#C0392B', fillOpacity: 1 }} />
          </>
        )}

        {(visitsQ.data ?? []).filter(v => v.lat != null && v.lng != null).map(v => (
          <Marker key={v.id} position={[v.lat!, v.lng!]} icon={visitIcon(visitNo.get(v.id) ?? 0)}
            eventHandlers={{ click: () => setOpenVisit(v.id) }} />
        ))}

        {showCustomers && (custQ.data ?? []).map(c => (
          <Marker key={c.id} position={[c.lat, c.lng]} icon={customerIcon()}
            eventHandlers={{ click: () => setPickedCustomer(c) }} />
        ))}
      </MapContainer>

      {/* أدوات عائمة — بعيدة عن الشريطين كي لا تُزاحمهما */}
      <div className="absolute top-3 z-[500] flex flex-col gap-2" style={{ insetInlineEnd: '12px' }}>
        <IconBtn active={satellite} onClick={() => setSatellite(s => !s)} label={tr('قمر صناعي')}><Layers size={17} /></IconBtn>
        <IconBtn active={showCustomers} onClick={() => { setShowCustomers(s => !s); setPickedCustomer(null); }} label={tr('مواقع العملاء')}><Store size={17} /></IconBtn>
      </div>

      {trackingOff && (
        <div className="absolute top-3 z-[500] rounded-xl bg-[#1F1A13]/90 text-white text-[11px] px-3 py-2 max-w-[62%]"
          style={{ insetInlineStart: '12px' }}>
          {tr('التتبّع متوقّف للشركة — لا تُسجَّل مواقع جديدة')}
        </div>
      )}

      {/* بطاقة العميل المنقور — فوق الورقة السفلية لا نافذة منبثقة صغيرة:
          النافذة المنبثقة على الجوال تُقصّ عند حواف الخريطة ولا يُصاب زرّ إغلاقها. */}
      {pickedCustomer && (
        <div className="absolute inset-x-0 z-[650] px-3" style={{ bottom: sheetOpen ? '66%' : '74px' }}>
          <div className="bg-white rounded-2xl shadow-[0_4px_20px_rgba(0,0,0,.22)] border border-[#E9E1D3] p-3.5">
            <div className="flex items-start gap-2">
              <span className="w-9 h-9 rounded-xl bg-[#EBF1FE] text-[#2563EB] flex items-center justify-center flex-shrink-0">
                <Store size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-[#1F1A13] truncate">{pickedCustomer.name}</span>
                {pickedCustomer.businessName && (
                  <span className="block text-[11px] text-[#6E6557] truncate">{pickedCustomer.businessName}</span>
                )}
                <span className="block text-[11px] text-[#9A8F7E] truncate">
                  {[pickedCustomer.city, pickedCustomer.district, pickedCustomer.address].filter(Boolean).join(' — ') || tr('بلا عنوان')}
                </span>
              </span>
              <button onClick={() => setPickedCustomer(null)} className="p-1.5 -m-1 text-[#9A8F7E]" aria-label={tr('إغلاق')}>
                <X size={17} />
              </button>
            </div>
            <div className="flex gap-2 mt-3">
              {pickedCustomer.phone && (
                <a href={`tel:${pickedCustomer.phone}`}
                  className="flex-1 flex items-center justify-center gap-1.5 border border-[#E9E1D3] rounded-xl py-2.5 min-h-[44px] text-sm font-semibold text-[#E15A30]">
                  <Phone size={14} /> {tr('اتصال')}
                </a>
              )}
              <a href={`https://maps.google.com/?q=${pickedCustomer.lat},${pickedCustomer.lng}`} target="_blank" rel="noreferrer"
                className="flex-1 flex items-center justify-center gap-1.5 border border-[#E9E1D3] rounded-xl py-2.5 min-h-[44px] text-sm font-semibold text-[#1F1A13]">
                <MapPin size={14} /> {tr('الاتجاهات')}
              </a>
            </div>
          </div>
        </div>
      )}

      {/* الورقة السفلية */}
      <div className={`absolute inset-x-0 bottom-0 z-[600] bg-white rounded-t-3xl shadow-[0_-6px_24px_rgba(0,0,0,.18)] transition-transform duration-200 ${sheetOpen ? 'translate-y-0' : 'translate-y-[calc(100%-58px)]'}`}
        style={{ maxHeight: '62%' }}>
        <button onClick={() => setSheetOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3">
          <span className="flex items-center gap-2">
            <Radio size={15} className="text-[#E15A30]" />
            <span className="text-sm font-bold text-[#1F1A13]">
              {sel ? sel.name : `${tr('المناديب')} (${reps.length})`}
            </span>
            {sel && <span className="text-[11px] text-[#9A8F7E]">· {sel.visitsToday} {tr('زيارة اليوم')}</span>}
          </span>
          {sheetOpen ? <ChevronDown size={18} className="text-[#9A8F7E]" /> : <ChevronUp size={18} className="text-[#9A8F7E]" />}
        </button>

        <div className="px-3 pb-3 overflow-y-auto overscroll-contain" style={{ maxHeight: 'calc(62vh - 58px)' }}>
          {/* التاريخ + مفتاح التتبّع */}
          <div className="flex items-center gap-2 mb-3">
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="input flex-1 text-sm" dir="ltr" />
            <button onClick={() => setConfirmToggle(true)}
              className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 border ${trackingOff ? 'border-[#E9E1D3] text-[#9A8F7E] bg-white' : 'border-[#BFE3D0] text-[#2F855A] bg-[#E9F6EF]'}`}
              aria-label={tr('تفعيل التتبّع')}>
              <Power size={17} />
            </button>
          </div>

          {liveQ.isLoading ? <MSpinner />
            : liveQ.isError ? <MError onRetry={() => liveQ.refetch()} />
            : reps.length === 0 ? <p className="text-center text-xs text-[#9A8F7E] py-6">{tr('لا يوجد مناديب')}</p>
            : (
              <div className="rounded-2xl border border-[#F1EBDF] overflow-hidden mb-3">
                {reps.map(r => {
                  const on = isOnline(r.lastSeenAt);
                  const active = r.id === selected;
                  return (
                    <button key={r.id} onClick={() => setSelected(active ? '' : r.id)}
                      className={`w-full text-start flex items-center gap-3 px-3 py-3 min-h-[56px] border-b border-[#F1EBDF] last:border-0 ${active ? 'bg-[#FBEBE2]' : 'active:bg-[#FAF7F0]'}`}>
                      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${on ? 'bg-[#2F855A]' : 'bg-[#C9BFB0]'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[#1F1A13] truncate">{r.name}</span>
                        <span className="block text-[11px] text-[#9A8F7E]">
                          {on ? tr('متصل الآن') : r.lastSeenAt ? `${tr('آخر ظهور')} ${timeText(r.lastSeenAt)}` : tr('لا موقع بعد')}
                        </span>
                      </span>
                      <span className="text-[11px] text-[#6E6557] flex items-center gap-1 flex-shrink-0">
                        <ClipboardCheck size={12} /> {r.visitsToday}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

          {/* زيارات المندوب المختار */}
          {selected && (
            <>
              <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 mb-2 uppercase">
                {tr('زيارات اليوم المحدَّد')} ({visitsQ.data?.length ?? 0})
              </h3>
              {visitsQ.isLoading ? <p className="text-center text-xs text-[#9A8F7E] py-4">{tr('جاري التحميل...')}</p>
                : !visitsQ.data?.length ? <p className="text-center text-xs text-[#9A8F7E] py-4">{tr('لا زيارات في هذا اليوم')}</p>
                : (
                  <div className="rounded-2xl border border-[#F1EBDF] overflow-hidden">
                    {visitsQ.data.map(v => {
                      const dur = fmtDur(v.durationSec);
                      return (
                        <button key={v.id} onClick={() => setOpenVisit(v.id)}
                          className="w-full text-start flex items-center gap-3 px-3 py-3 min-h-[56px] border-b border-[#F1EBDF] last:border-0 active:bg-[#FAF7F0]">
                          <span className="w-6 h-6 rounded-full bg-[#E9F6EF] text-[#2F855A] flex items-center justify-center text-[11px] font-bold flex-shrink-0">{visitNo.get(v.id)}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-[#1F1A13] truncate">{v.customer?.name || tr('عميل محذوف')}</span>
                            <span className="block text-[11px] text-[#9A8F7E]">
                              {timeText(v.createdAt)}
                              {dur && <> · <Timer size={10} className="inline" /> {dur}</>}
                              {v._count.photos > 0 && ` · ${v._count.photos} ${tr('صورة')}`}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              <div className="h-3" />
            </>
          )}
        </div>
      </div>

      {/* تأكيد تبديل التتبّع — إعداد يخصّ الشركة كلّها لا هذا المستخدم */}
      {confirmToggle && (
        <div className="absolute inset-0 z-[700] bg-black/50 flex items-end" onClick={() => setConfirmToggle(false)}>
          <div className="w-full bg-white rounded-t-3xl p-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-[#1F1A13] mb-1">
              {trackingOff ? tr('تفعيل تتبّع المناديب') : tr('إيقاف تتبّع المناديب')}
            </h3>
            <p className="text-xs text-[#6E6557] mb-4">
              {trackingOff
                ? tr('سيبدأ تسجيل مواقع المناديب لكل الشركة أثناء فتحهم للتطبيق.')
                : tr('سيتوقّف تسجيل المواقع لكل مناديب الشركة. المسارات المسجّلة تبقى محفوظة.')}
            </p>
            <div className="flex gap-2">
              <button onClick={() => toggle.mutate(trackingOff)} disabled={toggle.isPending}
                className={`flex-1 font-bold py-3 rounded-xl min-h-[48px] text-white ${trackingOff ? 'bg-[#2F855A]' : 'bg-[#C0392B]'} disabled:opacity-60`}>
                {trackingOff ? tr('تفعيل') : tr('إيقاف')}
              </button>
              <button onClick={() => setConfirmToggle(false)}
                className="px-5 py-3 rounded-xl border border-[#E9E1D3] text-[#6E6557] min-h-[48px]">
                {tr('إلغاء')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IconBtn({ children, onClick, active, label }: {
  children: React.ReactNode; onClick: () => void; active?: boolean; label: string;
}) {
  return (
    <button onClick={onClick} aria-label={label}
      className={`w-10 h-10 rounded-xl shadow-md flex items-center justify-center border ${active ? 'bg-[#1F1A13] text-white border-[#1F1A13]' : 'bg-white text-[#6E6557] border-[#E9E1D3]'}`}>
      {children}
    </button>
  );
}

/** تفاصيل الزيارة — شاشة كاملة بصورها */
function VisitScreen({ q, onBack }: {
  q: { data?: VisitDetail; isLoading: boolean; isError: boolean; refetch: () => void };
  onBack: () => void;
}) {
  const tr = useTr();
  const [zoom, setZoom] = useState<string | null>(null);

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <div className="flex-shrink-0 bg-[#1F1A13] text-white px-3 py-3 flex items-center gap-2">
        <button onClick={onBack} className="p-2 -m-1 text-[#9A8F7E] hover:text-white" aria-label={tr('رجوع')}>
          <X size={20} />
        </button>
        <span className="text-sm font-bold flex-1 truncate">{tr('تفاصيل الزيارة')}</span>
      </div>

      {q.isLoading ? <MSpinner />
        : q.isError || !q.data ? <MError onRetry={q.refetch} />
        : (
          <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
            <div className="bg-white rounded-2xl border border-[#F1EBDF] p-4 space-y-2">
              <p className="text-base font-bold text-[#1F1A13]">{q.data.customer?.name || tr('عميل محذوف')}</p>
              {q.data.customer?.phone && (
                <a href={`tel:${q.data.customer.phone}`} className="text-sm text-[#E15A30] font-semibold flex items-center gap-1.5" dir="ltr">
                  <Phone size={13} /> {q.data.customer.phone}
                </a>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#6E6557] pt-1">
                <span>{tr('المندوب')}: <b className="text-[#1F1A13]">{q.data.salesRep?.name || '—'}</b></span>
                <span>{tr('الوقت')}: <b className="text-[#1F1A13]">{timeText(q.data.createdAt)}</b></span>
                {fmtDur(q.data.durationSec) && (
                  <span className="flex items-center gap-1">
                    <Timer size={11} /> {tr('المدّة')}: <b className="text-[#1F1A13]">{fmtDur(q.data.durationSec)}</b>
                  </span>
                )}
              </div>
            </div>

            {q.data.note && (
              <div className="bg-white rounded-2xl border border-[#F1EBDF] p-4">
                <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('الملاحظة')}</p>
                <p className="text-sm text-[#1F1A13] whitespace-pre-line">{q.data.note}</p>
              </div>
            )}

            {q.data.photos.length > 0 && (
              <div>
                <p className="text-[11px] font-bold text-[#9A8F7E] px-1 mb-2 uppercase">
                  {tr('الصور')} ({q.data.photos.length})
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {q.data.photos.map(p => (
                    <button key={p.id} onClick={() => setZoom(p.data)} className="rounded-xl overflow-hidden border border-[#F1EBDF] bg-white">
                      <img src={p.data} alt="" className="w-full h-36 object-cover" loading="lazy" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {q.data.lat != null && q.data.lng != null && (
              <a href={`https://maps.google.com/?q=${q.data.lat},${q.data.lng}`} target="_blank" rel="noreferrer"
                className="block text-center bg-white border border-[#E9E1D3] rounded-xl py-3 text-sm font-semibold text-[#E15A30] min-h-[48px]">
                {tr('افتح موقع الزيارة في الخرائط')}
              </a>
            )}
            <div className="h-2" />
          </div>
        )}

      {zoom && (
        <div className="absolute inset-0 z-[800] bg-black/90 flex items-center justify-center p-3" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" className="max-w-full max-h-full object-contain" />
          <button onClick={() => setZoom(null)}
            className="absolute top-4 text-white p-2"
            style={{ insetInlineEnd: '16px', top: 'calc(1rem + env(safe-area-inset-top))' }}>
            <X size={24} />
          </button>
        </div>
      )}
    </div>
  );
}
