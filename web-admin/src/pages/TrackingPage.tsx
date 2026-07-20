import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { trackingApi, visitsApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { MapPin, Navigation, Calendar, Radio, Power, ClipboardCheck, Camera, X } from 'lucide-react';
import toast from 'react-hot-toast';

interface LiveRep {
  id: string; name: string; phone: string; isActive: boolean;
  lastLat: number; lastLng: number; lastSeenAt: string; visitsToday: number;
}
interface RoutePoint { lat: number; lng: number; accuracy: number | null; speed: number | null; capturedAt: string; }
interface RouteResp { points: RoutePoint[]; snapped: { lat: number; lng: number }[] | null; }
interface Visit {
  id: string; note: string | null; lat: number | null; lng: number | null; createdAt: string;
  customer: { id: string; name: string; phone: string | null } | null;
  _count: { photos: number };
}
interface VisitDetail extends Visit {
  salesRep: { id: string; name: string } | null;
  photos: { id: string; data: string }[];
}

const SA_CENTER: [number, number] = [24.7136, 46.6753]; // الرياض كمركز افتراضي
const ONLINE_MS = 5 * 60 * 1000;

const isOnline = (iso: string) => Date.now() - new Date(iso).getTime() < ONLINE_MS;

function repIcon(online: boolean, label: string) {
  const color = online ? '#1E7A52' : '#9A8F7E';
  return L.divIcon({
    className: '',
    html: `<div style="width:30px;height:30px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700">${label}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

// علامة زيارة على الخريطة (دبّوس أخضر) — موضع تسجيل المندوب للزيارة
function visitIcon(n: number) {
  return L.divIcon({
    className: '',
    html: `<div style="width:24px;height:24px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#5FBE92;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);color:#fff;font-size:11px;font-weight:700">${n}</span></div>`,
    iconSize: [24, 24], iconAnchor: [12, 24], popupAnchor: [0, -22],
  });
}

// يضبط حدود الخريطة لتشمل النقاط المعروضة
function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) { map.setView(points[0], 15); return; }
    if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 16 });
  }, [points, map]);
  return null;
}

export default function TrackingPage() {
  const qc = useQueryClient();
  const tr = useTr();
  const [selected, setSelected] = useState<string>('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [openVisit, setOpenVisit] = useState<string | null>(null); // زيارة مفتوحة لعرض صورها

  // نصّ زمنيّ نسبيّ حسب لغة العرض
  const sinceText = (iso: string) => {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return tr('الآن');
    if (m < 60) return `${tr('قبل')} ${m} ${tr('د')}`.trim();
    const h = Math.floor(m / 60);
    if (h < 24) return `${tr('قبل')} ${h} ${tr('س')}`.trim();
    return `${tr('قبل')} ${Math.floor(h / 24)} ${tr('يوم')}`.trim();
  };
  const timeText = (iso: string) => new Date(iso).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });

  const settingsQ = useQuery({ queryKey: ['track-settings'], queryFn: async () => (await trackingApi.settings()).data.data as { enabled: boolean } });
  const enabled = settingsQ.data?.enabled ?? false;

  const liveQ = useQuery({
    queryKey: ['track-live'],
    queryFn: async () => (await trackingApi.live()).data.data as LiveRep[],
    refetchInterval: enabled ? 20000 : false,
    enabled,
  });
  const routeQ = useQuery({
    queryKey: ['track-route', selected, date],
    queryFn: async () => {
      const res = await trackingApi.route(selected, date);
      return { points: res.data.data as RoutePoint[], snapped: (res.data.snapped ?? null) as RouteResp['snapped'] };
    },
    enabled: !!selected && enabled,
  });
  // زيارات المندوب المحدّد في اليوم — تتحدّث لحظياً مع الخريطة الحيّة
  const visitsQ = useQuery({
    queryKey: ['track-visits', selected, date],
    queryFn: async () => (await visitsApi.byRep(selected, date)).data.data as Visit[],
    enabled: !!selected && enabled,
    refetchInterval: enabled ? 20000 : false,
  });
  // تفاصيل زيارة مفتوحة (صورها كاملة) — تُحمّل عند الطلب فقط
  const visitDetailQ = useQuery({
    queryKey: ['visit-detail', openVisit],
    queryFn: async () => (await visitsApi.detail(openVisit!)).data.data as VisitDetail,
    enabled: !!openVisit,
  });

  const toggle = useMutation({
    mutationFn: (v: boolean) => trackingApi.setEnabled(v),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ['track-settings'] }); toast.success(v ? tr('تم تفعيل التتبّع') : tr('تم إيقاف التتبّع')); },
    onError: () => toast.error(tr('تعذّر تغيير الإعداد')),
  });

  const reps = liveQ.data || [];
  const route = routeQ.data?.points || [];
  const snapped = routeQ.data?.snapped || null;
  const visits = visitsQ.data || [];

  const rawLatLng = useMemo(() => route.map(p => [p.lat, p.lng] as [number, number]), [route]);
  // مسار العرض: المطابَق للطرق إن توفّر (يتبع الشوارع)، وإلا النقاط الخام
  const pathLatLng = useMemo<[number, number][]>(
    () => (snapped && snapped.length > 1 ? snapped.map(p => [p.lat, p.lng] as [number, number]) : rawLatLng),
    [snapped, rawLatLng],
  );
  const visitPins = useMemo(() => visits.filter(v => v.lat != null && v.lng != null), [visits]);

  // النقاط المعروضة على الخريطة لضبط الحدود
  const focusPoints: [number, number][] = useMemo(() => {
    if (selected) {
      const pts = [...rawLatLng, ...visitPins.map(v => [v.lat!, v.lng!] as [number, number])];
      if (pts.length) return pts;
    }
    return reps.map(r => [r.lastLat, r.lastLng] as [number, number]);
  }, [selected, rawLatLng, visitPins, reps]);

  const selectedRep = reps.find(r => r.id === selected);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1A13] flex items-center gap-2">
            <MapPin size={26} className="text-[#E15A30]" /> {tr('تتبّع المناديب')}
          </h1>
          <p className="text-[#6E6557] text-sm mt-1">{tr('مواقع المناديب الحيّة على الخريطة وخطّ سير كل مندوب خلال اليوم.')}</p>
        </div>
        <button
          onClick={() => toggle.mutate(!enabled)} disabled={toggle.isPending}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-colors ${enabled ? 'bg-[#1E7A52] text-white hover:bg-[#176443]' : 'bg-[#F1EBDF] text-[#6E6557] hover:bg-[#E9E1D3]'}`}>
          <Power size={16} /> {enabled ? tr('التتبّع مُفعّل') : tr('التتبّع متوقّف')}
        </button>
      </div>

      {!enabled ? (
        <div className="card text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-4"><Radio size={30} className="text-[#E15A30]" /></div>
          <h3 className="font-bold text-[#1F1A13] text-lg">{tr('التتبّع متوقّف حالياً')}</h3>
          <p className="text-[#6E6557] text-sm mt-2 max-w-md mx-auto">{tr('عند التفعيل، يبدأ تطبيق المندوب بإرسال موقعه أثناء العمل (بعد موافقته على إذن الموقع)، فتظهر المواقع وخطوط السير هنا.')}</p>
          <button onClick={() => toggle.mutate(true)} disabled={toggle.isPending} className="btn-primary mx-auto mt-5"><Power size={16} /> {tr('تفعيل التتبّع')}</button>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[320px_1fr] gap-5">
          {/* قائمة المناديب */}
          <div className="card p-0 overflow-hidden h-fit">
            <div className="px-4 py-3 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center justify-between">
              <span>{tr('المناديب')} ({reps.length})</span>
              {selected && <button onClick={() => setSelected('')} className="text-xs text-[#E15A30] font-semibold">{tr('إلغاء التحديد')}</button>}
            </div>
            <div className="max-h-[520px] overflow-y-auto">
              {reps.length === 0 ? (
                <p className="text-center text-gray-400 text-sm py-10 px-4">{tr('لا توجد مواقع بعد. سجّل المناديب دخولهم وفعّلوا الموقع لتظهر هنا.')}</p>
              ) : reps.map(r => {
                const on = isOnline(r.lastSeenAt);
                return (
                  <button key={r.id} onClick={() => setSelected(s => s === r.id ? '' : r.id)}
                    className={`w-full text-right px-4 py-3 border-b border-[#F1EBDF] flex items-center gap-3 transition-colors ${selected === r.id ? 'bg-[#FBEBE2]' : 'hover:bg-[#FAF7F0]'}`}>
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${on ? 'bg-[#1E7A52]' : 'bg-gray-300'}`} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[#1F1A13] text-sm truncate">{r.name}</p>
                      <p className="text-[11px] text-[#9A8F7E]">{on ? tr('متصل الآن') : `${tr('آخر ظهور')} ${sinceText(r.lastSeenAt)}`}</p>
                    </div>
                    {/* عدّاد زيارات اليوم — لحظيّ */}
                    <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-bold rounded-full px-2 py-1 ${r.visitsToday > 0 ? 'bg-[#E7F5EE] text-[#1E7A52]' : 'bg-[#F1EBDF] text-[#9A8F7E]'}`}
                      title={tr('زيارات اليوم')}>
                      <ClipboardCheck size={12} /> {r.visitsToday}
                    </span>
                  </button>
                );
              })}
            </div>
            {selected && (
              <div className="p-3 border-t border-[#F1EBDF] space-y-2">
                <label className="text-xs font-semibold text-[#6E6557] flex items-center gap-1"><Calendar size={13} /> {tr('خطّ السير والزيارات ليوم')}</label>
                <input type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={e => setDate(e.target.value)} className="input py-2 text-sm" />
                <p className="text-[11px] text-[#9A8F7E]">
                  {routeQ.isLoading ? tr('جارٍ التحميل…') : `${route.length} ${tr('نقطة مسجّلة')}`}
                  {snapped && snapped.length > 1 ? ` · ${tr('مطابَق للطرق')}` : ''}
                </p>
              </div>
            )}
          </div>

          {/* الخريطة + الزيارات */}
          <div className="space-y-5">
            <div className="card p-0 overflow-hidden" style={{ height: 520 }}>
              <MapContainer center={SA_CENTER} zoom={6} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
                <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                <FitBounds points={focusPoints} />

                {/* علامات المواقع الحيّة (تُخفى عند تحديد مندوب لعرض مساره فقط) */}
                {!selected && reps.map(r => (
                  <Marker key={r.id} position={[r.lastLat, r.lastLng]} icon={repIcon(isOnline(r.lastSeenAt), r.name.charAt(0))}>
                    <Popup>
                      <div style={{ direction: 'rtl', minWidth: 140 }}>
                        <strong>{r.name}</strong><br />
                        <span style={{ color: '#6E6557', fontSize: 12 }}>{isOnline(r.lastSeenAt) ? tr('متصل الآن') : `${tr('آخر ظهور')} ${sinceText(r.lastSeenAt)}`}</span><br />
                        <span style={{ color: '#1E7A52', fontSize: 12 }}>{r.visitsToday} {tr('زيارة اليوم')}</span><br />
                        <span style={{ color: '#9A8F7E', fontSize: 11 }}>{r.phone}</span>
                      </div>
                    </Popup>
                  </Marker>
                ))}

                {/* خطّ سير المندوب المحدّد (مطابَق للطرق إن توفّر) */}
                {selected && pathLatLng.length > 0 && (
                  <>
                    <Polyline positions={pathLatLng} pathOptions={{ color: '#E15A30', weight: 4, opacity: 0.85 }} />
                    {rawLatLng.length > 0 && (
                      <>
                        <CircleMarker center={rawLatLng[0]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: '#1E7A52', fillOpacity: 1 }}>
                          <Popup>{tr('بداية اليوم')}</Popup>
                        </CircleMarker>
                        <CircleMarker center={rawLatLng[rawLatLng.length - 1]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: '#E15A30', fillOpacity: 1 }}>
                          <Popup>{tr('آخر موقع')}</Popup>
                        </CircleMarker>
                      </>
                    )}
                  </>
                )}

                {/* دبابيس الزيارات على الخريطة (للمندوب المحدّد) */}
                {selected && visitPins.map((v, i) => (
                  <Marker key={v.id} position={[v.lat!, v.lng!]} icon={visitIcon(i + 1)}>
                    <Popup>
                      <div style={{ direction: 'rtl', minWidth: 160 }}>
                        <strong>{v.customer?.name || tr('زيارة')}</strong><br />
                        <span style={{ color: '#6E6557', fontSize: 12 }}>{timeText(v.createdAt)}</span>
                        {v.note ? <><br /><span style={{ fontSize: 12 }}>{v.note}</span></> : null}
                        {v._count.photos > 0 && (
                          <><br /><button onClick={() => setOpenVisit(v.id)} style={{ color: '#E15A30', fontSize: 12, fontWeight: 700 }}>
                            📷 {v._count.photos} {tr('صورة')}
                          </button></>
                        )}
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>

            {/* قائمة زيارات المندوب المحدّد */}
            {selected && (
              <div className="card p-0 overflow-hidden">
                <div className="px-4 py-3 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
                  <ClipboardCheck size={16} className="text-[#5FBE92]" />
                  {tr('زيارات')} {selectedRep?.name} — {visits.length}
                </div>
                {visitsQ.isLoading ? (
                  <p className="text-center text-gray-400 text-sm py-8">{tr('جارٍ التحميل…')}</p>
                ) : visits.length === 0 ? (
                  <p className="text-center text-gray-400 text-sm py-8 px-4">{tr('لا توجد زيارات مسجّلة لهذا المندوب في هذا اليوم.')}</p>
                ) : (
                  <div className="divide-y divide-[#F1EBDF]">
                    {visits.map((v, i) => (
                      <button key={v.id} onClick={() => v._count.photos > 0 && setOpenVisit(v.id)}
                        className={`w-full text-right px-4 py-3 flex items-start gap-3 ${v._count.photos > 0 ? 'hover:bg-[#FAF7F0]' : 'cursor-default'}`}>
                        <span className="w-7 h-7 rounded-full bg-[#E7F5EE] text-[#1E7A52] text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-[#1F1A13] text-sm truncate">{v.customer?.name || tr('عميل')}</p>
                          {v.note && <p className="text-[12px] text-[#6E6557] mt-0.5 line-clamp-2">{v.note}</p>}
                          <p className="text-[11px] text-[#9A8F7E] mt-0.5 flex items-center gap-2">
                            <span>{timeText(v.createdAt)}</span>
                            {v.lat != null && <span className="flex items-center gap-0.5"><MapPin size={10} /> {tr('موقع')}</span>}
                          </p>
                        </div>
                        {v._count.photos > 0 && (
                          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-[#E15A30] bg-[#FBEBE2] rounded-full px-2 py-1">
                            <Camera size={12} /> {v._count.photos}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {selected && enabled && route.length === 0 && !routeQ.isLoading && (
        <p className="text-center text-sm text-[#9A8F7E] flex items-center justify-center gap-1.5"><Navigation size={14} /> {tr('لا توجد نقاط مسجّلة لهذا المندوب في هذا اليوم.')}</p>
      )}

      {/* عارض صور الزيارة */}
      {openVisit && (
        <div className="fixed inset-0 z-[1000] bg-black/70 flex items-center justify-center p-4" onClick={() => setOpenVisit(null)}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-[#F1EBDF] flex items-center justify-between">
              <span className="font-bold text-[#1F1A13] text-sm">
                {visitDetailQ.data?.customer?.name || tr('زيارة')}
                {visitDetailQ.data && <span className="text-[#9A8F7E] font-normal"> · {timeText(visitDetailQ.data.createdAt)}</span>}
              </span>
              <button onClick={() => setOpenVisit(null)} className="text-[#9A8F7E] hover:text-[#1F1A13]"><X size={20} /></button>
            </div>
            <div className="p-4 overflow-y-auto">
              {visitDetailQ.isLoading ? (
                <p className="text-center text-gray-400 text-sm py-8">{tr('جارٍ التحميل…')}</p>
              ) : (
                <>
                  {visitDetailQ.data?.note && <p className="text-sm text-[#1F1A13] bg-[#FAF7F0] rounded-xl p-3 mb-4">{visitDetailQ.data.note}</p>}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {(visitDetailQ.data?.photos || []).map(ph => (
                      <a key={ph.id} href={ph.data} target="_blank" rel="noreferrer" className="block aspect-square rounded-xl overflow-hidden border border-[#F1EBDF]">
                        <img src={ph.data} alt="" className="w-full h-full object-cover" />
                      </a>
                    ))}
                  </div>
                  {visitDetailQ.data && visitDetailQ.data.photos.length === 0 && !visitDetailQ.data.note && (
                    <p className="text-center text-gray-400 text-sm py-8">{tr('لا توجد تفاصيل إضافية.')}</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
