// حالة المندوب على خريطة التتبّع (علاج «تأخّر الموقع»، طلب المالك ٢٢ أكتوبر ٢٠٢٦) — صرفٌ تشترك فيه لوحة الويب
// (pages/TrackingPage.tsx) وتطبيق الإدارة (m/MTracking.tsx).
//
// «متصل» (lastSeenAt) تمدّه نبضة التطبيق كل دقيقة بلا GPS، فكان المندوب يظهر «متصل الآن» على دبّوسٍ عمره ساعة — والمدير
// يظنّه عند العميل. الآن تُفرَّق ثلاث حالات بلحظة الموقع نفسها (lastLocAt): موقعٌ مباشر، ومتصلٌ وموقعه قديم، وغير متصل.

/** «متصل» = نبضةٌ أو نقطةٌ خلال هذه المدّة — كما كان */
export const CONNECTED_MS = 5 * 60 * 1000;
/** «موقع مباشر» = لُقط خلال هذه المدّة. التطبيق يرفع الساكن كل ٣٠ث والمتحرّك كل ١٥ث، فدقيقتان تحتملان رفعاً فاتَ */
export const LOCATION_FRESH_MS = 2 * 60 * 1000;

export type RepLiveState = 'live' | 'stale' | 'offline' | 'none';

let skewMs = 0;

/**
 * ساعة الخادم من ردّ /tracking/live (serverNow): طوابع المواقع بساعة الخادم، ونافذة «موقع مباشر» دقيقتان فقط — ساعة جهاز
 * مديرٍ منحرفة دقيقةً كانت تقلب كل المناديب «متوقفين» (أو تُبقي المتوقف «مباشراً»). خادمٌ أقدم بلا serverNow ⇒ لا تصحيح.
 */
export function noteServerNow(serverNow: unknown, received = Date.now()): void {
  const t = Number(serverNow);
  if (Number.isFinite(t) && t > 0) skewMs = t - received;
}

/** «الآن» بساعة الخادم كما قُدّرت — يُمرَّر إلى useNow */
export const serverClockNow = (): number => Date.now() + skewMs;

export interface LiveRepTimes {
  lastLat: number | null;
  lastLng: number | null;
  lastSeenAt: string | null;
  /** غائبٌ (undefined) من خادمٍ أقدم — الواجهة قد تُنشر قبله */
  lastLocAt?: string | null;
}

const ageMs = (iso: string | null | undefined, now: number): number => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? now - t : Infinity;
};

export function repLiveState(r: LiveRepTimes, now = Date.now()): RepLiveState {
  if (!r.lastSeenAt) return 'none';
  if (!(ageMs(r.lastSeenAt, now) < CONNECTED_MS)) return 'offline';
  const located = r.lastLat != null && r.lastLng != null;
  // خادمٌ أقدم لا يعرف لحظة الموقع: كما كان («متصل» = موقعه الآن)
  if (r.lastLocAt === undefined) return located ? 'live' : 'stale';
  return located && ageMs(r.lastLocAt, now) < LOCATION_FRESH_MS ? 'live' : 'stale';
}

/** لون الحالة — الأخضر والرمادي كما كانا، والكهرماني جديد لـ«متصل وموقعه قديم» */
export const STATE_COLOR: Record<RepLiveState, string> = {
  live: '#1E7A52',
  stale: '#B7791F',
  offline: '#9A8F7E',
  none: '#D69E2E',
};

/** «الآن» أو «قبل ٣ د» بلغة العرض */
export function relativeAge(iso: string, tr: (s: string) => string, now = Date.now()): string {
  const m = Math.floor(ageMs(iso, now) / 60000);
  if (!Number.isFinite(m) || m < 1) return tr('الآن');
  if (m < 60) return `${tr('قبل')} ${m} ${tr('د')}`.trim();
  const h = Math.floor(m / 60);
  if (h < 24) return `${tr('قبل')} ${h} ${tr('س')}`.trim();
  return `${tr('قبل')} ${Math.floor(h / 24)} ${tr('يوم')}`.trim();
}

/**
 * سطر الحالة تحت اسم المندوب وفي نافذة دبّوسه. `lastSeen` يكتب «آخر ظهور» بأسلوب الشاشة (نسبيّ في الويب، ساعةٌ في الجوال).
 */
export function repLiveText(r: LiveRepTimes, tr: (s: string) => string, lastSeen: (iso: string) => string, now = Date.now()): string {
  const st = repLiveState(r, now);
  if (st === 'none') return tr('لم يحدد موقعه بعد');
  if (st === 'offline') return `${tr('آخر ظهور')} ${lastSeen(r.lastSeenAt!)}`;
  if (st === 'live') return r.lastLocAt ? `${tr('موقع مباشر')} · ${relativeAge(r.lastLocAt, tr, now)}` : tr('متصل الآن');
  if (r.lastLat == null || r.lastLng == null) return tr('متصل بلا موقع');
  return r.lastLocAt ? `${tr('متصل وموقعه متوقف')} · ${relativeAge(r.lastLocAt, tr, now)}` : tr('متصل وموقعه غير محدث');
}
