import { useEffect, useRef } from 'react';

/**
 * خريطة Google التفاعلية لشاشة المندوب الذكي (بمفتاح عرض الخريطة): موقع المندوب، ومحلات المسح ملوّنة بحالتها
 * (فرصة جديدة / عميل / ربما عميل / مرفوض)، وأرقام خطة التوجيه على محطّاتها بترتيبها، وخطّ يصلها.
 *
 * الخريطة تُنشأ مرّة واحدة (تحميلٌ مدفوع). العلامات تُعاد عند مسحٍ جديد (fitKey) أو تغيّر المحلات المعروضة، أما تغيّر
 * الخطة فيحدّث أيقوناتها وخطّها دون إعادة ضبط التكبير الذي أجراه المندوب. الضغط على محلٍّ من محلات Google نفسها ⇒ onPoi.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;

export interface MapItem { placeId: string; lat: number; lng: number; relation: string; rejectedRecently: boolean; name: string; closed?: boolean }

const COLORS = { NEW: '#16A34A', CUSTOMER: '#2563EB', POSSIBLE_CUSTOMER: '#60A5FA', REJECTED: '#9CA3AF', PLAN: '#E15A30' };

export default function RepAiMap({ g, origin, items, plan, fitKey, onSelect, onPoi, full = false, recenterKey = 0 }: {
  g: G;
  origin: { lat: number; lng: number } | null;
  items: MapItem[];
  plan: string[]; // placeIds بترتيب خطة التوجيه
  fitKey: string | null; // يتغيّر مع كل مسح جديد ⇒ إعادة ضبط الإطار
  onSelect: (placeId: string) => void;
  /** ضغطة على محلٍّ من محلات Google نفسها (لا علاماتنا) ⇒ دراسته */
  onPoi?: (p: { placeId: string; lat: number; lng: number }) => void;
  /** تملأ الشاشة كلها */
  full?: boolean;
  /** يتغيّر ⇒ تتمركز الخريطة على موقع المندوب */
  recenterKey?: number;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<G>(null);
  const markers = useRef(new Map<string, G>());
  const me = useRef<G>(null);
  const line = useRef<G>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const poiRef = useRef(onPoi);
  poiRef.current = onPoi;

  // إنشاء الخريطة مرّة واحدة
  useEffect(() => {
    if (!g || !box.current || map.current) return;
    map.current = new g.maps.Map(box.current, {
      center: origin ?? { lat: 24.7136, lng: 46.6753 },
      zoom: full ? 17 : 15, disableDefaultUI: true, zoomControl: !full, gestureHandling: 'greedy', clickableIcons: !!poiRef.current,
    });
    // ضغطة على محلٍّ من محلات Google: بطاقة Google الافتراضية لا تظهر — ندرسه نحن
    map.current.addListener('click', (e: G) => {
      if (!e?.placeId || !poiRef.current) return;
      e.stop();
      poiRef.current({ placeId: e.placeId, lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
  }, [g, origin]);

  // العلامات: تُعاد مع كل نتيجة بحث (أو تغيّر المحلات المعروضة)، والإطار يُضبط مع البحث الجديد وحده
  const itemsKey = items.map(i => `${i.placeId}:${i.relation}:${i.rejectedRecently ? 1 : 0}:${i.closed ? 1 : 0}`).join('|');
  const lastFit = useRef<string | null>(null);
  useEffect(() => {
    const m = map.current;
    if (!g || !m) return;
    markers.current.forEach(mk => mk.setMap(null));
    markers.current.clear();
    const bounds = new g.maps.LatLngBounds();
    for (const it of items) {
      if (it.closed) continue;
      const mk = new g.maps.Marker({ position: { lat: it.lat, lng: it.lng }, map: m, title: it.name });
      mk.addListener('click', () => selectRef.current(it.placeId));
      markers.current.set(it.placeId, mk);
      bounds.extend({ lat: it.lat, lng: it.lng });
    }
    if (me.current) me.current.setMap(null);
    if (origin) {
      me.current = new g.maps.Marker({
        position: origin, map: m, zIndex: 999, title: 'موقعك',
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#1D4ED8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
      });
      bounds.extend(origin);
    }
    const shown = (box.current?.offsetWidth ?? 0) > 0;
    if (shown && fitKey && lastFit.current !== fitKey && items.length) { m.fitBounds(bounds, 40); lastFit.current = fitKey; }
    else if (!items.length && origin) m.setCenter(origin);
    styleMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g, itemsKey, fitKey, origin?.lat, origin?.lng]);

  // الخطة: أيقونات مرقّمة وخطّ المسار — بلا إعادة ضبط للإطار
  const planKey = plan.join('|');
  useEffect(() => { styleMarkers(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [planKey]);

  function styleMarkers() {
    const m = map.current;
    if (!g || !m) return;
    const order = new Map(plan.map((id, i) => [id, i + 1]));
    for (const it of items) {
      const mk = markers.current.get(it.placeId);
      if (!mk) continue;
      const n = order.get(it.placeId);
      const color = n ? COLORS.PLAN : it.rejectedRecently ? COLORS.REJECTED : (COLORS as Record<string, string>)[it.relation] ?? COLORS.NEW;
      mk.setZIndex(n ? 500 - n : 10);
      mk.setLabel(n ? { text: String(n), color: '#fff', fontSize: '12px', fontWeight: '700' } : null);
      mk.setIcon({ path: g.maps.SymbolPath.CIRCLE, scale: n ? 12 : 7, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 });
    }
    if (line.current) line.current.setMap(null);
    const stops = plan.map(id => items.find(i => i.placeId === id)).filter((x): x is MapItem => !!x && !x.closed);
    line.current = stops.length
      ? new g.maps.Polyline({
          path: [...(origin ? [origin] : []), ...stops.map(s => ({ lat: s.lat, lng: s.lng }))],
          map: m, strokeColor: COLORS.PLAN, strokeOpacity: 0.85, strokeWeight: 4,
        })
      : null;
  }

  // التمركز على موقع المندوب عند الطلب
  useEffect(() => {
    if (recenterKey && map.current && origin) { map.current.panTo(origin); map.current.setZoom(Math.max(map.current.getZoom() ?? 17, 16)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterKey]);

  return <div ref={box} className={full ? 'w-full h-full bg-gray-100' : 'w-full h-64 rounded-2xl overflow-hidden border border-gray-100 bg-gray-100'} />;
}
