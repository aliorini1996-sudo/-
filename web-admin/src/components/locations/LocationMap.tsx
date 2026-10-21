import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useTr } from '../../i18n/strings';
import { SA_CENTER } from '../../m/mapIcons';
import type { LatLng } from '../../lib/locations';

/**
 * خرائط «لوكيشن»: **منتقي نقطة** (نافذة الموقع) و**خريطة عرض** لمواقع الشركة. لا منتقي نقطةٍ في اللوحة قبلها (موقع العميل
 * رابطٌ ملصوق)، فبُني على إعداد خريطة التتبّع نفسه: react-leaflet وبلاطات Google (طرق m / قمر صناعي y) ودبابيس
 * `L.divIcon` وحدها — أيقونة Leaflet الافتراضية صورةٌ PNG ينكسر مسارها تحت Vite فيظهر مربّعٌ مكسور.
 * يُستورد من صفحة «لوكيشن» الكسولة وحدها، فتبقى leaflet خارج الحزمة الرئيسية.
 */

/** دبّوسٌ بلون الهوية (المرجاني)، والمؤرشف/الصفر رماديّ */
function pinIcon(muted = false) {
  const color = muted ? '#9A8F7E' : '#E15A30';
  return L.divIcon({
    className: '',
    html: `<div style="width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)"></div>`,
    iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28], tooltipAnchor: [0, -30],
  });
}

function GoogleTiles({ satellite }: { satellite: boolean }) {
  return (
    <TileLayer key={satellite ? 'y' : 'm'} attribution='&copy; Google'
      url={`https://{s}.google.com/vt/lyrs=${satellite ? 'y' : 'm'}&x={x}&y={y}&z={z}`}
      subdomains={['mt0', 'mt1', 'mt2', 'mt3']} maxZoom={20} />
  );
}

/** خريطةٌ داخل نافذةٍ تُرسم قبل أن يستقرّ حجمها فتظهر بلاطاتٌ رمادية ناقصة — إعادة القياس بعد الفتح تعالجها */
function InvalidateOnMount() {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 120);
    return () => clearTimeout(t);
  }, [map]);
  return null;
}

/** النقر يضع النقطة (ملفوفةً إلى مدى الطول −١٨٠..١٨٠ — النقر على نسخة العالم المكرّرة يعطي ٢٠٠° وما فوق) */
function ClickToPick({ onPick }: { onPick: (p: LatLng) => void }) {
  useMapEvents({ click: (e) => onPick(roundPoint(e.latlng.wrap())) });
  return null;
}

/** نقطةٌ وُضعت من خارج الخريطة (لصقٌ أو «موقعي الحالي») وهي خارج المعروض: تنتقل الخريطة إليها — والنقر داخلها لا يحرّكها */
function KeepInView({ point }: { point: LatLng | null }) {
  const map = useMap();
  useEffect(() => {
    if (!point) return;
    const ll = L.latLng(point.lat, point.lng);
    if (!map.getBounds().contains(ll)) map.setView(ll, Math.max(map.getZoom(), 15));
  }, [point, map]);
  return null;
}

/** ٦ منازل ≈ ١٠ سم — أدقّ مما تُصيبه نقرة، ولا ذيل طفوٍ يُخزَّن */
const roundPoint = (ll: L.LatLng): LatLng => ({ lat: Math.round(ll.lat * 1e6) / 1e6, lng: Math.round(ll.lng * 1e6) / 1e6 });

function SatToggle({ satellite, onChange }: { satellite: boolean; onChange: (v: boolean) => void }) {
  const tr = useTr();
  // يمينٌ فعليّ لا end-2: أزرار التكبير في Leaflet أعلى اليسار دائماً، وend في RTL يساراً فيغطّي «+» (كما في TrackingPage)
  return (
    <div className="absolute top-2 right-2 z-10 flex rounded-lg overflow-hidden shadow-md border border-[#E9E1D3] text-[11px] font-semibold">
      <button type="button" onClick={() => onChange(false)} className={`px-2.5 py-1 ${!satellite ? 'bg-[#1F1A13] text-white' : 'bg-white text-[#1F1A13]'}`}>{tr('خريطة')}</button>
      <button type="button" onClick={() => onChange(true)} className={`px-2.5 py-1 ${satellite ? 'bg-[#1F1A13] text-white' : 'bg-white text-[#1F1A13]'}`}>{tr('قمر صناعي')}</button>
    </div>
  );
}

/**
 * منتقي النقطة: النقر يضعها، والدبّوس يُسحب لتدقيقها. بلا نقطة تبدأ الخريطة على المملكة، وبها تبدأ عليها قريبة.
 * النقطة اختيارية (الاسم وحده إلزاميّ) — المسح بيد الصفحة.
 */
export function LocationPicker({ value, onChange, height = 300 }: { value: LatLng | null; onChange: (p: LatLng) => void; height?: number }) {
  const [satellite, setSatellite] = useState(false);
  return (
    <div className="relative rounded-xl overflow-hidden border border-[#E9E1D3]" style={{ height }}>
      <MapContainer center={value ? [value.lat, value.lng] : SA_CENTER} zoom={value ? 15 : 5} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <GoogleTiles satellite={satellite} />
        <InvalidateOnMount />
        <ClickToPick onPick={onChange} />
        <KeepInView point={value} />
        {value && (
          <Marker position={[value.lat, value.lng]} icon={pinIcon()} draggable
            eventHandlers={{ dragend: (e) => onChange(roundPoint((e.target as L.Marker).getLatLng().wrap())) }} />
        )}
      </MapContainer>
      <SatToggle satellite={satellite} onChange={setSatellite} />
    </div>
  );
}

export interface MapPin { id: string; name: string; lat: number; lng: number; lines?: string[]; muted?: boolean }

/** تضبط الحدود على الدبابيس — مرّةً لكل مجموعةٍ مختلفة لا مع كل رسم (وإلا قفزت الخريطة تحت يد المستخدم) */
function FitPins({ pins }: { pins: MapPin[] }) {
  const map = useMap();
  const key = pins.map((p) => `${p.id}:${p.lat},${p.lng}`).join('|');
  const latest = useRef(pins);
  latest.current = pins;
  useEffect(() => {
    const ps = latest.current;
    if (!ps.length) return;
    if (ps.length === 1) { map.setView([ps[0].lat, ps[0].lng], 13); return; }
    map.fitBounds(L.latLngBounds(ps.map((p) => [p.lat, p.lng] as [number, number])), { padding: [40, 40], maxZoom: 14 });
  }, [key, map]);
  return null;
}

/** خريطة عرض: دبّوسٌ لكل موقعٍ له نقطة، واسمه ظاهرٌ دائماً، وسطوره (أرقامه) في النافذة المنبثقة */
export function LocationsMap({ pins, height = 320 }: { pins: MapPin[]; height?: number }) {
  const [satellite, setSatellite] = useState(false);
  const icons = useMemo(() => ({ on: pinIcon(false), off: pinIcon(true) }), []);
  return (
    <div className="relative rounded-xl overflow-hidden border border-[#E9E1D3]" style={{ height }}>
      <MapContainer center={SA_CENTER} zoom={5} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <GoogleTiles satellite={satellite} />
        <InvalidateOnMount />
        <FitPins pins={pins} />
        {pins.map((p) => (
          <Marker key={p.id} position={[p.lat, p.lng]} icon={p.muted ? icons.off : icons.on}>
            <Tooltip permanent direction="top" offset={[0, 0]}>{p.name}</Tooltip>
            {!!p.lines?.length && (
              <Popup>
                <div dir="rtl" style={{ minWidth: 160 }}>
                  <b>{p.name}</b>
                  {p.lines.map((l, i) => <div key={i} style={{ fontSize: 12, marginTop: 2 }}>{l}</div>)}
                </div>
              </Popup>
            )}
          </Marker>
        ))}
      </MapContainer>
      <SatToggle satellite={satellite} onChange={setSatellite} />
    </div>
  );
}
