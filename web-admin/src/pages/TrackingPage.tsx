import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { trackingApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { MapPin, Navigation, Calendar, Radio, Power } from 'lucide-react';
import toast from 'react-hot-toast';

interface LiveRep {
  id: string; name: string; phone: string; isActive: boolean;
  lastLat: number; lastLng: number; lastSeenAt: string;
}
interface RoutePoint { lat: number; lng: number; accuracy: number | null; speed: number | null; capturedAt: string; }

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

  // نصّ زمنيّ نسبيّ حسب لغة العرض
  const sinceText = (iso: string) => {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return tr('الآن');
    if (m < 60) return `${tr('قبل')} ${m} ${tr('د')}`.trim();
    const h = Math.floor(m / 60);
    if (h < 24) return `${tr('قبل')} ${h} ${tr('س')}`.trim();
    return `${tr('قبل')} ${Math.floor(h / 24)} ${tr('يوم')}`.trim();
  };

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
    queryFn: async () => (await trackingApi.route(selected, date)).data.data as RoutePoint[],
    enabled: !!selected && enabled,
  });

  const toggle = useMutation({
    mutationFn: (v: boolean) => trackingApi.setEnabled(v),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ['track-settings'] }); toast.success(v ? tr('تم تفعيل التتبّع') : tr('تم إيقاف التتبّع')); },
    onError: () => toast.error(tr('تعذّر تغيير الإعداد')),
  });

  const reps = liveQ.data || [];
  const route = routeQ.data || [];
  const routeLatLng = useMemo(() => route.map(p => [p.lat, p.lng] as [number, number]), [route]);

  // النقاط المعروضة على الخريطة لضبط الحدود
  const focusPoints: [number, number][] = useMemo(() => {
    if (selected && routeLatLng.length) return routeLatLng;
    return reps.map(r => [r.lastLat, r.lastLng] as [number, number]);
  }, [selected, routeLatLng, reps]);

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
        <div className="grid lg:grid-cols-[300px_1fr] gap-5">
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
                  </button>
                );
              })}
            </div>
            {selected && (
              <div className="p-3 border-t border-[#F1EBDF] space-y-2">
                <label className="text-xs font-semibold text-[#6E6557] flex items-center gap-1"><Calendar size={13} /> {tr('خطّ السير ليوم')}</label>
                <input type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={e => setDate(e.target.value)} className="input py-2 text-sm" />
                <p className="text-[11px] text-[#9A8F7E]">{routeQ.isLoading ? tr('جارٍ التحميل…') : `${route.length} ${tr('نقطة مسجّلة')}`}</p>
              </div>
            )}
          </div>

          {/* الخريطة */}
          <div className="card p-0 overflow-hidden" style={{ height: 600 }}>
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
                      <span style={{ color: '#9A8F7E', fontSize: 11 }}>{r.phone}</span>
                    </div>
                  </Popup>
                </Marker>
              ))}

              {/* خطّ سير المندوب المحدّد */}
              {selected && routeLatLng.length > 0 && (
                <>
                  <Polyline positions={routeLatLng} pathOptions={{ color: '#E15A30', weight: 4, opacity: 0.8 }} />
                  <CircleMarker center={routeLatLng[0]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: '#1E7A52', fillOpacity: 1 }}>
                    <Popup>{tr('بداية اليوم')}</Popup>
                  </CircleMarker>
                  <CircleMarker center={routeLatLng[routeLatLng.length - 1]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: '#E15A30', fillOpacity: 1 }}>
                    <Popup>{tr('آخر موقع')}</Popup>
                  </CircleMarker>
                </>
              )}
              {selected && !routeQ.isLoading && routeLatLng.length === 0 && (
                <></>
              )}
            </MapContainer>
          </div>
        </div>
      )}

      {selected && enabled && routeLatLng.length === 0 && !routeQ.isLoading && (
        <p className="text-center text-sm text-[#9A8F7E] flex items-center justify-center gap-1.5"><Navigation size={14} /> {tr('لا توجد نقاط مسجّلة لهذا المندوب في هذا اليوم.')}</p>
      )}
    </div>
  );
}
