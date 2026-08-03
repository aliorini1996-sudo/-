import L from 'leaflet';

/**
 * أيقونات الخريطة ودوالّها الزمنية.
 *
 * **منقولة نصّاً** من `pages/TrackingPage.tsx` لا مستوردة: هي دوالّ محلّية غير
 * مُصدَّرة هناك، وتصديرها يعني تعديل صفحة تعمل على الإنتاج بلا داعٍ. النقل هنا
 * يُبقي الصفحة القائمة على حالها تماماً.
 *
 * ⚠️ **الأيقونات مكبَّرة عمداً عن نظيرتها المكتبية** (٣٦ بدل ٣٠، و٣٠ بدل ٢٤):
 * الدبّوس على الجوال هدفُ لمسٍ لا مجرّد علامة بصرية، ودبّوس ٢٤px بإصبع لا
 * يُصاب.
 */

export const SA_CENTER: [number, number] = [24.7136, 46.6753]; // الرياض مركزاً افتراضياً
const ONLINE_MS = 5 * 60 * 1000;

export const isOnline = (iso: string | null) =>
  !!iso && Date.now() - new Date(iso).getTime() < ONLINE_MS;

export function repIcon(online: boolean, label: string) {
  const color = online ? '#1E7A52' : '#9A8F7E';
  return L.divIcon({
    className: '',
    html: `<div style="width:36px;height:36px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700">${label}</div>`,
    iconSize: [36, 36], iconAnchor: [18, 18],
  });
}

export function visitIcon(n: number) {
  return L.divIcon({
    className: '',
    html: `<div style="width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#5FBE92;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);color:#fff;font-size:12px;font-weight:700">${n}</span></div>`,
    iconSize: [30, 30], iconAnchor: [15, 30],
  });
}

export function customerIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#2563EB;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)"></div>`,
    iconSize: [26, 26], iconAnchor: [13, 26],
  });
}

/** «12:05» أو «1:03:20» — يطابق تنسيق الخادم وتطبيق المندوب */
export function fmtDur(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return null;
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(ss)}` : `${m}:${two(ss)}`;
}

export const timeText = (iso: string) =>
  new Date(iso).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
