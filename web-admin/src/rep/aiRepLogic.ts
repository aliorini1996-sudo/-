/**
 * المندوب الذكي — منطق صرف لشاشة المندوب (بلا React ولا شبكة، مختبَر).
 *   - ترتيب المسار: أقرب جار ثم تحسين 2‑opt على مسار مفتوح يبدأ من موقع المندوب.
 *   - زمن تقديري: المسافة المستقيمة × ١٫٣ (تعرّج الشوارع) بسرعة ٢٥ كم/س داخل المدن — تقدير لا وعد.
 *   - روابط الملاحة: Google Maps بمعرّف المكان (الجوال يقبل ٣ نقاط وسيطة فقط).
 */

export interface Pt { lat: number; lng: number }
export interface Stop extends Pt { placeId: string; name: string }

export function distKm(a: Pt, b: Pt): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function pathLen(origin: Pt, seq: Pt[]): number {
  let d = 0, prev = origin;
  for (const p of seq) { d += distKm(prev, p); prev = p; }
  return d;
}

/** ترتيب المحطات: أقرب جار ثم 2‑opt حتى لا يتحسّن. حتمي لنفس المدخلات. */
export function orderRoute<T extends Pt>(origin: Pt, stops: T[]): T[] {
  if (stops.length <= 1) return [...stops];
  const left = [...stops];
  const seq: T[] = [];
  let cur: Pt = origin;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((s, i) => { const d = distKm(cur, s); if (d < bd) { bd = d; bi = i; } });
    cur = left[bi];
    seq.push(left.splice(bi, 1)[0]);
  }
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < seq.length - 1; i++) {
      for (let k = i + 1; k < seq.length; k++) {
        const cand = [...seq.slice(0, i), ...seq.slice(i, k + 1).reverse(), ...seq.slice(k + 1)];
        if (pathLen(origin, cand) + 1e-9 < pathLen(origin, seq)) { seq.splice(0, seq.length, ...cand); improved = true; }
      }
    }
  }
  return seq;
}

export const DETOUR = 1.3;
export const CITY_KMH = 25;

/** محطات مرتّبة مع المسافة التراكمية والدقائق التقديرية للوصول. */
export function routeLegs<T extends Pt>(origin: Pt, ordered: T[]): Array<T & { legKm: number; cumKm: number; etaMin: number }> {
  let prev: Pt = origin, cum = 0;
  return ordered.map(s => {
    const leg = distKm(prev, s) * DETOUR;
    cum += leg; prev = s;
    return { ...s, legKm: leg, cumKm: cum, etaMin: Math.round((cum / CITY_KMH) * 60) };
  });
}

/** رابط ملاحة لمحطة واحدة (الأدق: بمعرّف المكان). */
export function navUrl(dest: { lat: number; lng: number; placeId?: string | null }): string {
  const q = new URLSearchParams({ api: '1', destination: `${dest.lat},${dest.lng}`, travelmode: 'driving', dir_action: 'navigate' });
  if (dest.placeId) q.set('destination_place_id', dest.placeId);
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}

/** رابط مسار متعدد: أول ٤ محطات (٣ وسيطة + الوجهة) — حدّ متصفح الجوال. */
export function multiStopUrl(ordered: Array<{ lat: number; lng: number; placeId?: string | null }>): string | null {
  if (!ordered.length) return null;
  const take = ordered.slice(0, 4);
  const dest = take[take.length - 1];
  const mids = take.slice(0, -1);
  const q = new URLSearchParams({ api: '1', destination: `${dest.lat},${dest.lng}`, travelmode: 'driving' });
  if (dest.placeId) q.set('destination_place_id', dest.placeId);
  if (mids.length) {
    q.set('waypoints', mids.map(m => `${m.lat},${m.lng}`).join('|'));
    const ids = mids.map(m => m.placeId || '');
    if (ids.every(Boolean)) q.set('waypoint_place_ids', ids.join('|'));
  }
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}

/** مسافة للعرض بالعربية. */
export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m / 10) * 10} م` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} كم`;
}

/** مدى للعرض: «٦–١٢» أو رقم واحد حين يتساوى الطرفان. */
export function fmtRange(r: { low: number; high: number } | null | undefined, fmt: (n: number) => string = n => String(n)): string {
  if (!r) return '—';
  return r.low === r.high ? fmt(r.low) : `${fmt(r.low)}–${fmt(r.high)}`;
}

export const CONFIDENCE_LABEL: Record<string, string> = { HIGH: 'ثقة عالية', MEDIUM: 'ثقة متوسطة', LOW: 'ثقة منخفضة' };

export const OUTCOMES: { kind: string; label: string }[] = [
  { kind: 'INTERESTED', label: 'مهتم' },
  { kind: 'CALL_BACK', label: 'عُد لاحقاً' },
  { kind: 'QUOTE', label: 'طلب عرض سعر' },
  { kind: 'NOT_INTERESTED', label: 'غير مهتم' },
  { kind: 'EXCLUSIVE_SUPPLIER', label: 'عنده مورّد حصري' },
  { kind: 'CLOSED', label: 'مغلق أو لم أجده' },
];

export const OUTCOME_LABEL: Record<string, string> = Object.fromEntries([...OUTCOMES, { kind: 'CONVERTED', label: 'أصبح عميلاً' }].map(o => [o.kind, o.label]));

/** أنواع المنافذ (نسخة الواجهة من backend/src/ai-rep/taxonomy.ts — الخادم يتحقّق من الرموز). */
export const OUTLET_TYPE_OPTIONS: { code: string; label: string }[] = [
  { code: 'GROCERY', label: 'بقالة / تموينات' },
  { code: 'MINIMARKET', label: 'ميني ماركت' },
  { code: 'SUPERMARKET', label: 'سوبرماركت' },
  { code: 'HYPERMARKET', label: 'هايبر ماركت' },
  { code: 'WHOLESALE', label: 'جملة' },
  { code: 'PHARMACY', label: 'صيدلية' },
  { code: 'CAFE', label: 'مقهى / كوفي' },
  { code: 'CAFETERIA', label: 'كافتيريا / بوفيه' },
  { code: 'RESTAURANT', label: 'مطعم' },
  { code: 'BAKERY', label: 'مخبز' },
  { code: 'FUEL_SHOP', label: 'متجر محطة وقود' },
];

/** نص المستشار للعرض: كل مرجع P3 يُستبدل باسم المحل «…» (الاسم لا يغادر الجهاز). */
export function renderRefs(text: string, names: { ref: string; label: string }[]): string {
  const map = new Map(names.map(n => [n.ref, n.label]));
  return text.replace(/\bP(\d{1,3})\b/g, (m) => (map.has(m) ? `«${map.get(m)}»` : m));
}

// ───────────── حلقة التعلّم: إشارات المندوب ─────────────

/** أسباب التردّد أو الرفض (نسخة الواجهة من OBJECTION_CODES في الخادم — الخادم يرفض أي رمز آخر). */
export const OBJECTIONS: { code: string; label: string }[] = [
  { code: 'PRICE', label: 'السعر مرتفع' },
  { code: 'HAS_SUPPLIER', label: 'عنده مورّد' },
  { code: 'NO_SHELF_SPACE', label: 'لا مساحة على الرف' },
  { code: 'NEEDS_CREDIT', label: 'يريد آجل' },
  { code: 'SLOW_MOVING', label: 'الصنف لا يمشي عنده' },
  { code: 'DECISION_MAKER_ABSENT', label: 'صاحب القرار غير موجود' },
  { code: 'WANTS_SAMPLE', label: 'يريد تجربة أو كمية أقل' },
  { code: 'UNKNOWN_BRAND', label: 'لا يعرف العلامة' },
  { code: 'TIMING', label: 'وقت غير مناسب' },
  { code: 'OTHER', label: 'غير ذلك' },
];

/** نتائج تُعرض معها أزرار السبب. «عنده مورّد حصري» بلا أزرار: الخادم يستنتج «عنده مورّد». */
export const OBJECTION_OUTCOMES = new Set(['INTERESTED', 'CALL_BACK', 'QUOTE', 'NOT_INTERESTED']);

/** أسباب «غير مفيد» (نسخة الواجهة من FEEDBACK_REASONS في الخادم). */
export const FEEDBACK_REASONS: { code: string; label: string }[] = [
  { code: 'WRONG_OUTLET', label: 'محل غير مناسب' },
  { code: 'WRONG_QTY', label: 'الكمية غير مناسبة' },
  { code: 'NOT_PRACTICAL', label: 'غير عملي' },
  { code: 'WRONG_INFO', label: 'معلومة غير صحيحة' },
  { code: 'TOO_LONG', label: 'طويل' },
];

// ───────────── حلقة التعلّم: أحكام لوحة «ما تعلّمه العقل» (صرفة) ─────────────
// لا يُدّعى تحسّن إلا حين يستبعد المجال الصفر: الترتيب lo90 > 0، والنسب P ≥ 0.9؛ بين 0.7 و0.9 «مؤشّر» فقط.

export type Verdict = 'CONFIRMED' | 'HINT' | 'NONE' | 'WORSE' | 'NEEDS_DATA';

export const VERDICT_LABEL: Record<Verdict, string> = {
  CONFIRMED: 'تحسّن مؤكَّد', HINT: 'مؤشّر تحسّن', NONE: 'لا أثر مؤكَّد بعد', WORSE: 'أسوأ — أُعيد للأساس', NEEDS_DATA: 'يحتاج مزيداً من البيانات',
};

function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** P(p > t) لنسبة لاحقها بيتا(1+k, 1+n−k) — تقريب طبيعي كما في الخادم (stats.pGreater). */
export function betaAbove(k: number, n: number, t: number): number {
  const a = 1 + k, b = 1 + Math.max(0, n - k), s = a + b;
  const mean = a / s, sd = Math.sqrt((a * b) / (s * s * (s + 1)));
  return sd > 0 ? normalCdf((mean - t) / sd) : mean > t ? 1 : 0;
}

/** حكم من احتمال أن «بعد» أفضل من «قبل». دون minN لا يُدّعى شيء («لا أثر مؤكَّد بعد»). */
export function verdictOfP(p: number | null | undefined, n = Infinity, minN = 0): Verdict {
  if (p == null || !Number.isFinite(p)) return 'NEEDS_DATA';
  if (n < minN) return 'NONE';
  return p >= 0.9 ? 'CONFIRMED' : p >= 0.7 ? 'HINT' : 'NONE';
}

/** فرق بمجال ثقة ٩٠٪ (bootstrap): مؤكَّد فقط إن lo90 > 0؛ «مؤشّر» إن كان P(Δ>0) بالتقريب الطبيعي ≥ 0.7. */
export function verdictOfCI(d: number | null | undefined, lo: number | null | undefined, hi: number | null | undefined,
  n: number | null = Infinity, minN = 0): Verdict {
  if (d == null || lo == null || hi == null || ![d, lo, hi].every(Number.isFinite)) return 'NEEDS_DATA';
  if ((n ?? 0) < minN) return 'NONE';
  if (lo > 0) return 'CONFIRMED';
  const se = (hi - lo) / (2 * 1.645);
  const p = se > 0 ? normalCdf(d / se) : d > 0 ? 1 : 0;
  return p >= 0.7 ? 'HINT' : 'NONE';
}

/** عدّاد أو نسبة → نسبة: العدد الصحيح ضمن n عدّاد، وغيره نسبة جاهزة (تحمّلاً لشكل المؤشّر). */
export function toRate(v: number | null | undefined, n: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (Number.isInteger(v) && n != null && n > 0 && v <= n) return v / n;
  return v >= 0 && v <= 1 ? v : null;
}

/** آخر نسخة من نوع نموذج أُرجعت تلقائياً (لا بيد الإدارة) ⇒ «أسوأ — أُعيد للأساس». */
export function autoRolledBack(models: { kind: string; version: number; status: string; reason: string | null }[], kind: string): boolean {
  const latest = models.filter(m => m.kind === kind).sort((a, b) => b.version - a.version)[0];
  return !!latest && latest.status === 'ROLLED_BACK' && !/ADMIN/i.test(latest.reason ?? '');
}

/** أسباب تغيّر حالة الدرس (رموز الخادم §3.10) بالعربية. */
export const LESSON_REASON_LABEL: Record<string, string> = {
  HARMFUL: 'ضرر مقاس', REP_FEEDBACK: 'تقييم المناديب', INCONCLUSIVE: 'بلا أثر حاسم', EVIDENCE_GONE: 'زال الدليل',
  PROVEN: 'أثبت فائدته', NON_INFERIOR: 'لا يضرّ', ADMIN: 'أوقفته الإدارة', ADMIN_RESET: 'إعادة الضبط', EXPIRED: 'انتهت مهلة المراجعة',
  REFLECTION: 'مراجعة ذاتية',
};

export const LESSON_ORIGIN_LABEL: Record<string, string> = { STATS: 'إحصاء', REFLECTION: 'مراجعة ذاتية', SELF: 'مكتبة التصحيح' };

/** إجراءات الإدارة المسموحة لكل حالة درس (الخادم يرفض غيرها بـ409). */
export function lessonActions(status: string): ('approve' | 'reject' | 'disable' | 'enable' | 'restore')[] {
  switch (status) {
    case 'PENDING': return ['approve', 'reject'];
    case 'TRIAL': case 'ACTIVE': return ['disable'];
    case 'DISABLED': return ['enable'];
    case 'RETIRED': return ['restore'];
    default: return [];
  }
}
