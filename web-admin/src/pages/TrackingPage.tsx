import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { trackingApi, visitsApi, customerApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { MapPin, Navigation, Calendar, Radio, Power, ClipboardCheck, Camera, X, ChevronLeft, Store, Timer } from 'lucide-react';
import toast from 'react-hot-toast';

interface LiveRep {
  id: string; name: string; phone: string; isActive: boolean;
  lastLat: number | null; lastLng: number | null; lastSeenAt: string | null; visitsToday: number;
}
interface RoutePoint { lat: number; lng: number; accuracy: number | null; speed: number | null; capturedAt: string; }
type SegKind = 'observed' | 'inferred' | 'raw';
interface RouteSegment { kind: SegKind; points: { lat: number; lng: number }[]; meters: number }
interface RouteShape {
  segments: RouteSegment[];
  observedMeters: number; inferredMeters: number; rawMeters: number;
  truncated: boolean; degraded: boolean;
}
interface RouteResp { points: RoutePoint[]; snapped: { lat: number; lng: number }[] | null; shape: RouteShape | null; }
interface Visit {
  id: string; note: string | null; lat: number | null; lng: number | null; createdAt: string;
  durationSec: number | null; // مدّة الزيارة بالثواني (null = زيارة ملاحظة بلا توقيت)
  startedAt: string | null; endedAt: string | null; // طابعا المؤقّت (للزيارات المؤقّتة)
  customer: { id: string; name: string; phone: string | null } | null;
  _count: { photos: number };
}
interface VisitDetail extends Visit {
  salesRep: { id: string; name: string } | null;
  photos: { id: string; data: string }[];
}
interface CustomerLoc {
  id: string; name: string; businessName: string | null; phone: string | null;
  city: string | null; district: string | null; address: string | null; lat: number; lng: number;
}

const SA_CENTER: [number, number] = [24.7136, 46.6753]; // الرياض كمركز افتراضي
const ONLINE_MS = 5 * 60 * 1000;

const isOnline = (iso: string | null) => !!iso && Date.now() - new Date(iso).getTime() < ONLINE_MS;

function repIcon(online: boolean, label: string) {
  const color = online ? '#1E7A52' : '#9A8F7E';
  return L.divIcon({
    className: '',
    html: `<div style="width:30px;height:30px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700">${label}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

// سهم اتجاه على خطّ السير — بلا اتجاهٍ يرى المشرف خطاً ولا يعرف أين بدأ اليوم.
// `interactive:false` كي لا يسرق السهمُ نقرةً موجّهةً لدبّوس زيارةٍ تحته.
function arrowIcon(deg: number) {
  return L.divIcon({
    className: '',
    html: `<div style="transform:rotate(${deg}deg);width:16px;height:16px;display:flex;align-items:center;justify-content:center"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B3462A" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 0 2px #fff) drop-shadow(0 0 2px #fff)"><path d="M12 20V5M5 12l7-7 7 7"/></svg></div>`,
    iconSize: [16, 16], iconAnchor: [8, 8],
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

// دبّوس موقع عميل (أزرق مميّز عن المناديب والزيارات)
function customerIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#2563EB;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);color:#fff;font-size:10px;font-weight:700">●</span></div>`,
    iconSize: [22, 22], iconAnchor: [11, 22], popupAnchor: [0, -20],
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
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string>('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [openVisit, setOpenVisit] = useState<string | null>(null); // زيارة مفتوحة لعرض صورها
  const [zoomPhoto, setZoomPhoto] = useState<string | null>(null); // صورة مكبّرة (lightbox)
  const [mapType, setMapType] = useState<'roadmap' | 'satellite'>('roadmap'); // نوع خريطة Google
  const [showCustomers, setShowCustomers] = useState(false); // إظهار مواقع العملاء

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
  // «12:05» أو «1:03:20» — يطابق تنسيق الخادم والمندوب
  const fmtDur = (sec: number | null | undefined): string | null => {
    if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return null;
    const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
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
    queryFn: async () => {
      const res = await trackingApi.route(selected, date);
      return {
        points: res.data.data as RoutePoint[],
        snapped: (res.data.snapped ?? null) as RouteResp['snapped'],
        shape: (res.data.shape ?? null) as RouteShape | null,
      };
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
  // مواقع العملاء على الخريطة — تُجلب مرّة عند تفعيل الطبقة
  const customerLocsQ = useQuery({
    queryKey: ['customer-locations'],
    queryFn: async () => (await customerApi.locations()).data.data as CustomerLoc[],
    enabled: showCustomers && enabled,
    refetchOnMount: 'always',
    refetchInterval: showCustomers && enabled ? 30000 : false, // يلتقط المواقع المُضافة حديثاً
  });

  const toggle = useMutation({
    mutationFn: (v: boolean) => trackingApi.setEnabled(v),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ['track-settings'] }); toast.success(v ? tr('تم تفعيل التتبّع') : tr('تم إيقاف التتبّع')); },
    onError: () => toast.error(tr('تعذّر تغيير الإعداد')),
  });

  const reps = liveQ.data || [];
  const route = routeQ.data?.points || [];
  const snapped = routeQ.data?.snapped || null;
  const shape = routeQ.data?.shape || null;
  const visits = visitsQ.data || [];
  const customerLocs = showCustomers ? (customerLocsQ.data || []) : [];

  const rawLatLng = useMemo(() => route.map(p => [p.lat, p.lng] as [number, number]), [route]);

  /**
   * مقاطع الرسم. المقطع **المُرجَّح** ليس أثراً رُصد: هو أرجحُ طريقٍ بين نقطتين
   * متباعدتين أعاده محرّك التوجيه. رسمُه متصلاً كالمرصود يقول للمشرف «هذا ما
   * سلكه» ونحن لا نعلم — وقد يُبنى عليه اتّهامُ مندوبٍ بالانحراف. فالمتقطّع
   * ليس زينة: هو حدّ ما نستطيع الجزم به.
   */
  const drawSegments = useMemo<{ kind: SegKind; pos: [number, number][] }[]>(() => {
    const segs = shape?.segments?.filter(sg => sg.points.length > 1) || [];
    if (segs.length) return segs.map(sg => ({ kind: sg.kind, pos: sg.points.map(p => [p.lat, p.lng] as [number, number]) }));
    // لا شكل من الخادم (نشرٌ قديم أو تعذّر) ⇒ خامٌ صريح، لا «مرصود» ولا «مُرجَّح»
    return rawLatLng.length > 1 ? [{ kind: 'raw' as SegKind, pos: rawLatLng }] : [];
  }, [shape, rawLatLng]);

  /** كل نقاط الرسم بالترتيب — لتأطير الخريطة وحساب الاتجاه */
  const pathLatLng = useMemo<[number, number][]>(
    () => drawSegments.flatMap(sg => sg.pos),
    [drawSegments],
  );

  /**
   * أسهم الاتجاه: بلا اتجاهٍ يقرأ المشرف الخطّ ولا يعرف أين بدأ اليوم. نضع
   * سهماً كل ~عُشر المسار (٤ إلى ١٢ سهماً) مُدوَّراً نحو النقطة التالية.
   */
  const arrows = useMemo(() => {
    if (pathLatLng.length < 4) return [];
    const n = Math.min(12, Math.max(4, Math.floor(pathLatLng.length / 40)));
    const step = Math.floor(pathLatLng.length / (n + 1));
    const out: { pos: [number, number]; deg: number }[] = [];
    for (let i = 1; i <= n; i++) {
      const idx = i * step;
      const a = pathLatLng[idx], b = pathLatLng[Math.min(idx + 1, pathLatLng.length - 1)];
      if (!a || !b) continue;
      // الاتجاه البوصلي مباشرةً: atan2(شرقاً، شمالاً) — الموضع [lat, lng] فـ
      // a[0] شمال و a[1] شرق. (كتبتُها أوّلاً `90 - deg` على عادة تحويل زاوية
      // رياضية إلى بوصلية، فأشار السهم شرقاً حيث السير شمالاً — أربع جهات كلها
      // خاطئة، والسهم الكاذب أسوأ من غيابه.) و cos(lat) يصحّح تقلّص خطوط الطول.
      const kx = Math.cos((a[0] * Math.PI) / 180);
      const deg = (Math.atan2((b[1] - a[1]) * kx, b[0] - a[0]) * 180) / Math.PI;
      out.push({ pos: a, deg }); // السهم يرسم شمالاً عند 0° ويدور مع عقارب الساعة
    }
    return out;
  }, [pathLatLng]);
  const visitPins = useMemo(() => visits.filter(v => v.lat != null && v.lng != null), [visits]);
  // رقم الزيارة **زمنيّ**: ١ = أول زيارة في اليوم. القائمة تنزل من الخادم أحدثَ
  // أولاً، وكان الترقيم بموضع المصفوفة (i+1) فقرأ المشرف اليومَ معكوساً — آخرُ
  // عميل «١» وبدايةُ الدوام أكبرُ رقم (بلاغ المالك). خريطةٌ واحدة id→رقم
  // يستهلكها الدبّوس والقائمة معاً: الدبابيس قائمة مُرشّحة (ذات إحداثيات)،
  // وترقيمُ كلٍّ بطولها يجعل الدبّوس يناقض بطاقة الزيارة نفسها.
  const visitNo = useMemo(() => new Map(visits.map((v, i) => [v.id, visits.length - i])), [visits]);

  // النقاط المعروضة على الخريطة لضبط الحدود
  const focusPoints: [number, number][] = useMemo(() => {
    if (selected) {
      const pts = [...rawLatLng, ...visitPins.map(v => [v.lat!, v.lng!] as [number, number])];
      if (pts.length) return pts;
    }
    return reps.filter(r => r.lastLat != null && r.lastLng != null).map(r => [r.lastLat!, r.lastLng!] as [number, number]);
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
        <div className="grid lg:grid-cols-[340px_1fr] gap-5 items-start">
          {/* العمود الأيسر: المناديب ثم زيارات المندوب المحدّد أسفلها مباشرةً */}
          <div className="space-y-5 min-w-0">
          {/* قائمة المناديب */}
          <div className="card p-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center justify-between">
              <span>{tr('المناديب')} ({reps.length})</span>
              {selected && <button onClick={() => setSelected('')} className="text-xs text-[#E15A30] font-semibold">{tr('إلغاء التحديد')}</button>}
            </div>
            <div className="max-h-[340px] overflow-y-auto">
              {reps.length === 0 ? (
                <p className="text-center text-gray-400 text-sm py-10 px-4">{tr('لا توجد مواقع بعد. سجّل المناديب دخولهم وفعّلوا الموقع لتظهر هنا.')}</p>
              ) : reps.map(r => {
                const on = isOnline(r.lastSeenAt);
                const located = r.lastSeenAt != null;
                return (
                  <button key={r.id} onClick={() => setSelected(s => s === r.id ? '' : r.id)}
                    className={`w-full text-right px-4 py-3 border-b border-[#F1EBDF] flex items-center gap-3 transition-colors ${selected === r.id ? 'bg-[#FBEBE2]' : 'hover:bg-[#FAF7F0]'}`}>
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${on ? 'bg-[#1E7A52]' : located ? 'bg-gray-300' : 'bg-amber-400'}`} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[#1F1A13] text-sm truncate">{r.name}</p>
                      <p className="text-[11px] text-[#9A8F7E]">{!located ? tr('لم يُحدّد موقعه بعد') : on ? tr('متصل الآن') : `${tr('آخر ظهور')} ${sinceText(r.lastSeenAt!)}`}</p>
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
                </p>
                {/* مفتاح القراءة: الرقمان يقولان كم من اليوم رُصد فعلاً وكم أُعيد
                    بناؤه — والفرق بينهما هو الفرق بين الدليل والترجيح. */}
                {shape && (shape.observedMeters > 0 || shape.inferredMeters > 0 || shape.rawMeters > 0) && (
                  <div className="space-y-1 pt-1 border-t border-[#F1EBDF]">
                    <div className="flex items-center gap-1.5 text-[11px] text-[#6E6557]">
                      <span className="inline-block w-5 h-[3px] rounded bg-[#E15A30]" />
                      <span>{tr('مسار مرصود')}: <b className="tabular-nums">{(shape.observedMeters / 1000).toFixed(1)}</b> {tr('كم')}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-[#6E6557]">
                      <span className="inline-block w-5 h-[3px] rounded" style={{ background: 'repeating-linear-gradient(90deg,#9A8F7E 0 4px,transparent 4px 8px)' }} />
                      <span>{tr('مسار مُرجَّح')}: <b className="tabular-nums">{(shape.inferredMeters / 1000).toFixed(1)}</b> {tr('كم')}</span>
                    </div>
                    {shape.rawMeters > 0 && (
                      <div className="flex items-center gap-1.5 text-[11px] text-[#6E6557]">
                        <span className="inline-block w-5 h-[3px] rounded" style={{ background: 'repeating-linear-gradient(90deg,#B7791F 0 2px,transparent 2px 7px)' }} />
                        <span>{tr('خطّ مستقيم (تعذّرت المطابقة)')}: <b className="tabular-nums">{(shape.rawMeters / 1000).toFixed(1)}</b> {tr('كم')}</span>
                      </div>
                    )}
                    <p className="text-[10px] text-[#B3A996] leading-snug">
                      {tr('المُرجَّح هو أرجح طريق بين نقطتين متباعدتين (التطبيق لا يلتقط الموقع وهو مغلق) — ليس أثراً مرصوداً.')}
                    </p>
                    {shape.degraded && (
                      <p className="text-[10px] text-red-600 leading-snug">
                        {tr('تعذّر الوصول لخدمة الخرائط — ما تراه خطوط مستقيمة بين نقاط التثبيت لا مسار شوارع.')}
                      </p>
                    )}
                    {shape.truncated && (
                      <p className="text-[10px] text-amber-700">{tr('بعض المقاطع عُرضت خاماً (بلغنا حدّ المعالجة لهذا اليوم).')}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* قائمة زيارات المندوب المحدّد — أسفل المندوب مباشرةً */}
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
              ) : (<>
                {/* ملخّص المدّة: متوسط مدّة الزيارات المؤقّتة + إجماليها.
                    يُحسب من الزيارات ذات durationSec فقط (لا يخلط بزيارات الملاحظة). */}
                {(() => {
                  const timed = visits.filter(v => typeof v.durationSec === 'number' && (v.durationSec as number) > 0) as (Visit & { durationSec: number })[];
                  if (!timed.length) return null;
                  const total = timed.reduce((s, v) => s + v.durationSec, 0);
                  const avg = Math.round(total / timed.length);
                  return (
                    <div className="px-4 py-2.5 bg-[#2E6FB0]/5 border-b border-[#2E6FB0]/15 flex items-center gap-4 text-[12px]">
                      <span className="flex items-center gap-1.5 text-[#2E6FB0] font-bold">
                        <Timer size={13} /> {tr('متوسّط مدّة الزيارة')}: {fmtDur(avg)}
                      </span>
                      <span className="text-[#6E6557]">{tr('زيارات مؤقّتة')}: {timed.length} · {tr('إجمالي الوقت')}: {fmtDur(total)}</span>
                    </div>
                  );
                })()}
                <div className="max-h-[420px] overflow-y-auto divide-y divide-[#F1EBDF]">
                  {visits.map(v => (
                    <button key={v.id} onClick={() => setOpenVisit(v.id)}
                      className="w-full text-right px-4 py-3 flex items-start gap-3 hover:bg-[#FAF7F0]">
                      <span className="w-7 h-7 rounded-full bg-[#E7F5EE] text-[#1E7A52] text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{visitNo.get(v.id)}</span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-[#1F1A13] text-sm truncate">{v.customer?.name || tr('عميل')}</p>
                        {v.note && <p className="text-[12px] text-[#6E6557] mt-0.5 line-clamp-2">{v.note}</p>}
                        <p className="text-[11px] text-[#9A8F7E] mt-0.5 flex items-center gap-2 flex-wrap">
                          <span>{timeText(v.createdAt)}</span>
                          {/* مدّة الزيارة: تُعرض فقط للزيارات المؤقّتة (durationSec ليس null) */}
                          {fmtDur(v.durationSec) && (
                            <span className="flex items-center gap-0.5 text-[#2E6FB0] font-bold tabular-nums" title={tr('مدّة الزيارة')}>
                              <Timer size={11} /> {fmtDur(v.durationSec)}
                            </span>
                          )}
                          {v.lat != null && <span className="flex items-center gap-0.5"><MapPin size={10} /> {tr('موقع')}</span>}
                        </p>
                      </div>
                      {v._count.photos > 0 && (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-[#E15A30] bg-[#FBEBE2] rounded-full px-2 py-1">
                          <Camera size={12} /> {v._count.photos}
                        </span>
                      )}
                      <ChevronLeft size={16} className="text-[#C9BFB0] shrink-0 mt-1" />
                    </button>
                  ))}
                </div>
              </>)}
            </div>
          )}
          </div>

          {/* الخريطة */}
          <div className="card p-0 overflow-hidden relative" style={{ height: 600 }}>
              {/* أدوات الخريطة: نوع الخريطة + طبقة مواقع العملاء */}
              <div className="absolute top-2 right-2 z-[1000] flex flex-col items-end gap-2">
                <div className="flex rounded-lg overflow-hidden shadow-md text-xs font-semibold">
                  <button onClick={() => setMapType('roadmap')}
                    className={`px-3 py-1.5 ${mapType === 'roadmap' ? 'bg-[#1F1A13] text-white' : 'bg-white text-[#1F1A13]'}`}>{tr('خريطة')}</button>
                  <button onClick={() => setMapType('satellite')}
                    className={`px-3 py-1.5 ${mapType === 'satellite' ? 'bg-[#1F1A13] text-white' : 'bg-white text-[#1F1A13]'}`}>{tr('قمر صناعي')}</button>
                </div>
                <button onClick={() => setShowCustomers(v => !v)}
                  className={`px-3 py-1.5 rounded-lg shadow-md text-xs font-semibold flex items-center gap-1.5 ${showCustomers ? 'bg-[#2563EB] text-white' : 'bg-white text-[#1F1A13]'}`}>
                  <Store size={13} /> {tr('مواقع العملاء')}{showCustomers && customerLocs.length ? ` (${customerLocs.length})` : ''}
                </button>
              </div>
              <MapContainer center={SA_CENTER} zoom={6} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
                {/* بلاطات خرائط Google (طرق m / قمر صناعي هجين y) */}
                <TileLayer key={mapType} attribution='&copy; Google'
                  url={`https://{s}.google.com/vt/lyrs=${mapType === 'satellite' ? 'y' : 'm'}&x={x}&y={y}&z={z}`}
                  subdomains={['mt0', 'mt1', 'mt2', 'mt3']} maxZoom={20} />
                <FitBounds points={focusPoints} />

                {/* علامات المواقع الحيّة (لمن لهم موقع فقط؛ تُخفى عند تحديد مندوب) */}
                {!selected && reps.filter(r => r.lastLat != null && r.lastLng != null).map(r => (
                  <Marker key={r.id} position={[r.lastLat!, r.lastLng!]} icon={repIcon(isOnline(r.lastSeenAt), r.name.charAt(0))}>
                    <Popup>
                      <div style={{ direction: 'rtl', minWidth: 140 }}>
                        <strong>{r.name}</strong><br />
                        <span style={{ color: '#6E6557', fontSize: 12 }}>{isOnline(r.lastSeenAt) ? tr('متصل الآن') : `${tr('آخر ظهور')} ${r.lastSeenAt ? sinceText(r.lastSeenAt) : ''}`}</span><br />
                        <span style={{ color: '#1E7A52', fontSize: 12 }}>{r.visitsToday} {tr('زيارة اليوم')}</span><br />
                        <span style={{ color: '#9A8F7E', fontSize: 11 }}>{r.phone}</span>
                      </div>
                    </Popup>
                  </Marker>
                ))}

                {/* خطّ سير المندوب المحدّد (مطابَق للطرق إن توفّر) */}
                {selected && pathLatLng.length > 0 && (
                  <>
                    {drawSegments.map((sg, i) => (
                      <Polyline
                        key={i}
                        positions={sg.pos}
                        pathOptions={{ observed: { color: '#E15A30', weight: 5, opacity: 0.9 },
                          inferred: { color: '#9A8F7E', weight: 3.5, opacity: 0.75, dashArray: '7 9' },
                          raw: { color: '#B7791F', weight: 3, opacity: 0.7, dashArray: '2 7' } }[sg.kind]}
                      />
                    ))}
                    {arrows.map((a, i) => (
                      <Marker key={`ar${i}`} position={a.pos} icon={arrowIcon(a.deg)} interactive={false} />
                    ))}
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
                {selected && visitPins.map(v => (
                  <Marker key={v.id} position={[v.lat!, v.lng!]} icon={visitIcon(visitNo.get(v.id) ?? 0)}>
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

                {/* طبقة مواقع العملاء (اختيارية) */}
                {customerLocs.map(c => (
                  <Marker key={`cust-${c.id}`} position={[c.lat, c.lng]} icon={customerIcon()}>
                    <Popup>
                      <div style={{ direction: 'rtl', minWidth: 150 }}>
                        <strong style={{ color: '#2563EB' }}>{c.name}</strong>
                        {c.businessName ? <><br /><span style={{ fontSize: 12 }}>{c.businessName}</span></> : null}
                        {(c.city || c.district || c.address) && (
                          <><br /><span style={{ color: '#6E6557', fontSize: 12 }}>{[c.city, c.district, c.address].filter(Boolean).join(' · ')}</span></>
                        )}
                        {c.phone ? <><br /><span style={{ color: '#9A8F7E', fontSize: 11 }} dir="ltr">{c.phone}</span></> : null}
                        <br />
                        <button onClick={() => navigate(`/app/customers?open=${c.id}`)}
                          style={{ marginTop: 8, background: '#2563EB', color: '#fff', border: 0, borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                          {tr('ملف العميل')}
                        </button>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>
        </div>
      )}

      {selected && enabled && route.length === 0 && !routeQ.isLoading && (
        <p className="text-center text-sm text-[#9A8F7E] flex items-center justify-center gap-1.5"><Navigation size={14} /> {tr('لا توجد نقاط مسجّلة لهذا المندوب في هذا اليوم.')}</p>
      )}

      {/* تفاصيل الزيارة: الملاحظة + الصور */}
      {openVisit && (
        <div className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4" onClick={() => setOpenVisit(null)}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-[#F1EBDF] flex items-center justify-between">
              <span className="font-bold text-[#1F1A13] text-sm flex items-center gap-2 flex-wrap">
                {visitDetailQ.data?.customer?.name || tr('تفاصيل الزيارة')}
                {visitDetailQ.data && <span className="text-[#9A8F7E] font-normal">· {timeText(visitDetailQ.data.createdAt)}</span>}
                {fmtDur(visitDetailQ.data?.durationSec) && (
                  <span className="inline-flex items-center gap-1 text-[#2E6FB0] font-bold tabular-nums text-[13px]">
                    <Timer size={13} /> {fmtDur(visitDetailQ.data?.durationSec)}
                  </span>
                )}
              </span>
              <button onClick={() => setOpenVisit(null)} className="text-[#9A8F7E] hover:text-[#1F1A13]"><X size={20} /></button>
            </div>
            <div className="p-4 overflow-y-auto">
              {visitDetailQ.isLoading ? (
                <p className="text-center text-gray-400 text-sm py-8">{tr('جارٍ التحميل…')}</p>
              ) : visitDetailQ.isError ? (
                <p className="text-center text-red-500 text-sm py-8">{tr('تعذّر تحميل تفاصيل الزيارة، حاول مجدداً.')}</p>
              ) : (
                <>
                  {/* مدّة الزيارة: من البدء إلى الانتهاء + الوقت المستغرق (للزيارات المؤقّتة فقط) */}
                  {fmtDur(visitDetailQ.data?.durationSec) && (
                    <div className="mb-4 rounded-xl border border-[#2E6FB0]/20 bg-[#2E6FB0]/5 p-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-[#2E6FB0]">
                        <Timer size={18} />
                        <div>
                          <p className="text-[11px] text-[#6E6557]">{tr('الوقت المستغرق للزيارة')}</p>
                          <p className="text-lg font-bold tabular-nums leading-tight">{fmtDur(visitDetailQ.data?.durationSec)}</p>
                        </div>
                      </div>
                      {visitDetailQ.data?.startedAt && visitDetailQ.data?.endedAt && (
                        <div className="text-[11px] text-[#6E6557] text-left tabular-nums">
                          <p>{tr('بدأت')}: {timeText(visitDetailQ.data.startedAt)}</p>
                          <p>{tr('انتهت')}: {timeText(visitDetailQ.data.endedAt)}</p>
                        </div>
                      )}
                    </div>
                  )}
                  {/* الملاحظة */}
                  <p className="text-[11px] font-semibold text-[#9A8F7E] mb-1">{tr('ملاحظة الزيارة')}</p>
                  {visitDetailQ.data?.note
                    ? <p className="text-sm text-[#1F1A13] bg-[#FAF7F0] rounded-xl p-3 mb-4 whitespace-pre-wrap">{visitDetailQ.data.note}</p>
                    : <p className="text-sm text-gray-400 bg-[#FAF7F0] rounded-xl p-3 mb-4">{tr('لا توجد ملاحظة.')}</p>}
                  {/* الصور */}
                  <p className="text-[11px] font-semibold text-[#9A8F7E] mb-1">{tr('صور الزيارة')} ({visitDetailQ.data?.photos.length || 0})</p>
                  {(visitDetailQ.data?.photos.length || 0) > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {visitDetailQ.data!.photos.map(ph => (
                        <button key={ph.id} onClick={() => setZoomPhoto(ph.data)}
                          className="block aspect-square rounded-xl overflow-hidden border border-[#F1EBDF] hover:opacity-90">
                          <img src={ph.data} alt="" className="w-full h-full object-cover" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400 py-2">{tr('لا توجد صور لهذه الزيارة.')}</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* تكبير صورة (lightbox) — بديل فتح data: URL الذي يحجبه المتصفّح */}
      {zoomPhoto && (
        <div className="fixed inset-0 z-[2100] bg-black/90 flex items-center justify-center p-4" onClick={() => setZoomPhoto(null)}>
          <img src={zoomPhoto} alt="" className="max-w-full max-h-full object-contain rounded-lg" />
          <button onClick={() => setZoomPhoto(null)} className="absolute top-4 right-4 text-white/80 hover:text-white"><X size={28} /></button>
        </div>
      )}
    </div>
  );
}
