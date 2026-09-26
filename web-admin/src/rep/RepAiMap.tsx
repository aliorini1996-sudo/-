import { useEffect, useRef } from 'react';

/**
 * خريطة Google داخل شاشة المندوب الذكي: موقع المندوب، وكل المحلات المجاورة ملوّنة بحالتها
 * (فرصة جديدة / عميل / مرفوض)، وأرقام خطة التوجيه على محطّاتها، وخطّ المسار المقترح.
 * لمس الدبّوس يفتح تفاصيل المحل.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;

export interface MapItem { placeId: string; lat: number; lng: number; relation: string; rejectedRecently: boolean; name: string }

const COLORS = { NEW: '#16A34A', CUSTOMER: '#2563EB', POSSIBLE_CUSTOMER: '#60A5FA', REJECTED: '#9CA3AF', PLAN: '#E15A30' };

export default function RepAiMap({ g, origin, items, plan, onSelect }: {
  g: G;
  origin: { lat: number; lng: number } | null;
  items: MapItem[];
  plan: string[]; // placeIds بترتيب الخطة
  onSelect: (placeId: string) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<G>(null);
  const layers = useRef<G[]>([]);

  useEffect(() => {
    if (!g || !box.current || map.current) return;
    map.current = new g.maps.Map(box.current, {
      center: origin ?? { lat: 24.7136, lng: 46.6753 },
      zoom: 15,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'greedy',
      clickableIcons: false,
    });
  }, [g, origin]);

  useEffect(() => {
    const m = map.current;
    if (!g || !m) return;
    layers.current.forEach(l => l.setMap(null));
    layers.current = [];
    const bounds = new g.maps.LatLngBounds();
    if (origin) {
      layers.current.push(new g.maps.Marker({
        position: origin, map: m, zIndex: 999, title: 'موقعك',
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#1D4ED8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
      }));
      bounds.extend(origin);
    }
    const order = new Map(plan.map((id, i) => [id, i + 1]));
    for (const it of items) {
      const n = order.get(it.placeId);
      const color = n ? COLORS.PLAN : it.rejectedRecently ? COLORS.REJECTED : (COLORS as Record<string, string>)[it.relation] ?? COLORS.NEW;
      const mk = new g.maps.Marker({
        position: { lat: it.lat, lng: it.lng }, map: m, title: it.name, zIndex: n ? 500 - n : 10,
        label: n ? { text: String(n), color: '#fff', fontSize: '12px', fontWeight: '700' } : undefined,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: n ? 12 : 7, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
      });
      mk.addListener('click', () => onSelect(it.placeId));
      layers.current.push(mk);
      bounds.extend({ lat: it.lat, lng: it.lng });
    }
    const stops = plan.map(id => items.find(i => i.placeId === id)).filter((x): x is MapItem => !!x);
    if (stops.length) {
      layers.current.push(new g.maps.Polyline({
        path: [...(origin ? [origin] : []), ...stops.map(s => ({ lat: s.lat, lng: s.lng }))],
        map: m, strokeColor: COLORS.PLAN, strokeOpacity: 0.85, strokeWeight: 4,
      }));
    }
    if (items.length) m.fitBounds(bounds, 40);
    else if (origin) m.setCenter(origin);
  }, [g, origin, items, plan, onSelect]);

  return <div ref={box} className="w-full h-64 rounded-2xl overflow-hidden border border-gray-100 bg-gray-100" />;
}
