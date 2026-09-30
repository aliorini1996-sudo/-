/**
 * المندوب الذكي — منطق صرف لشاشة المسح (بلا React ولا شبكة، مختبَر):
 *   - المسافة ورابط الملاحة (Google Maps بمعرّف المكان) وعرض المسافة.
 *   - نتائج الزيارة وأسبابها، ووسم كل محل في قائمة المسح، وإيقاف «حدّث» بعد مسحٍ فاشل.
 *   - موقع المندوب: سبب تعذّره، وقرار إعادة المسح عند العودة للشاشة، ودمج محلٍّ دُرس بمراجعاته في القائمة.
 *   - حلقة التعلّم: أسباب 👎، وأحكام لوحة «ما تعلّمه العقل».
 */

export interface Pt { lat: number; lng: number }

export function distKm(a: Pt, b: Pt): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** رابط ملاحة لمحطة واحدة (الأدق: بمعرّف المكان). */
export function navUrl(dest: { lat: number; lng: number; placeId?: string | null }): string {
  const q = new URLSearchParams({ api: '1', destination: `${dest.lat},${dest.lng}`, travelmode: 'driving', dir_action: 'navigate' });
  if (dest.placeId) q.set('destination_place_id', dest.placeId);
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}

/** مسافة للعرض بالعربية. */
export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m / 10) * 10} م` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} كم`;
}

export const OUTCOMES: { kind: string; label: string }[] = [
  { kind: 'INTERESTED', label: 'مهتم' },
  { kind: 'CALL_BACK', label: 'عُد لاحقاً' },
  { kind: 'QUOTE', label: 'طلب عرض سعر' },
  { kind: 'NOT_INTERESTED', label: 'غير مهتم' },
  { kind: 'EXCLUSIVE_SUPPLIER', label: 'عنده مورّد حصري' },
  // «مغلق الآن» لحظيّ (يُخفى بقية اليوم ويغذّي نسبة الإغلاق لكل فترة)؛ «لم أجده» بلاغ إغلاق نهائي يتأكّد ببلاغ ثانٍ
  { kind: 'CLOSED', label: 'مغلق الآن' },
  { kind: 'NOT_FOUND', label: 'أُغلق نهائياً / لم أجده' },
];

export const OUTCOME_LABEL: Record<string, string> = Object.fromEntries([...OUTCOMES, { kind: 'CONVERTED', label: 'أصبح عميلاً' }].map(o => [o.kind, o.label]));

/** نتيجتا الإغلاق: تُخرجان المحل من القائمة والخطة في هذه الجلسة (الخادم يخفيه بقية اليوم). */
export const CLOSED_OUTCOMES = new Set(['CLOSED', 'NOT_FOUND']);
/** نتائج تستحقّ متابعة (نسخة الواجهة من FOLLOW_UP_KINDS في الخادم). */
export const FOLLOW_UP_OUTCOMES = new Set(['INTERESTED', 'QUOTE', 'CALL_BACK']);

export type ShopBadgeTone = 'customer' | 'possible' | 'followup' | 'muted' | 'new';

/**
 * وسم المحل في قائمة المسح (صرف): العميل ثم «ربما عميل» ثم المُبلَّغ عن إغلاقه ثم آخر نتيجة زيارة (أي مندوب)،
 * وإلا «فرصة جديدة». «مغلق الآن» من يوم سابق لا يَسِم — المحل فرصة من جديد.
 */
export function shopBadge(it: {
  relation: string; reportedClosed?: boolean; lastOutcome?: string | null; lastOutcomeAt?: string | null; pendingCustomer?: boolean;
}, now = new Date()): { label: string; tone: ShopBadgeTone } {
  if (it.relation === 'CUSTOMER') return { label: 'عميل حالي', tone: 'customer' };
  // أُضيف عميلاً دون اتصال: في صفّ الإرسال حتى يُرفع — لا «فرصة جديدة» تُغري بإضافته ثانيةً
  if (it.pendingCustomer) return { label: 'بانتظار المزامنة', tone: 'customer' };
  if (it.relation === 'POSSIBLE_CUSTOMER') return { label: 'ربما عميل حالي', tone: 'possible' };
  if (it.reportedClosed) return { label: 'أُبلغ أنه مغلق', tone: 'muted' };
  const k = it.lastOutcome;
  if (k && k !== 'CONVERTED' && OUTCOME_LABEL[k]) {
    const at = it.lastOutcomeAt ? new Date(it.lastOutcomeAt) : null;
    const today = !!at && at.toDateString() === now.toDateString();
    if (k !== 'CLOSED' || today) return { label: OUTCOME_LABEL[k], tone: FOLLOW_UP_OUTCOMES.has(k) ? 'followup' : 'muted' };
  }
  return { label: 'فرصة جديدة', tone: 'new' };
}

/** رموز فشل المسح من جهة Google (حجب، صيغة مجهولة، قاطع، مهلة المندوب) — «حدّث» يتوقّف لحظات. */
const SCAN_RETRY_CODES = new Set(['SCAN_FAILED', 'SCAN_COOLDOWN', 'SOURCE_CHANGED']);

/** كم يتوقّف «حدّث» بعد مسحٍ فاشل (مللي ثانية، 0 = لا يتوقّف): ما يطلبه الخادم بين ٥ و٣٠ ثانية. */
export function refreshHoldMs(err: { code?: string; retryAfterS?: number } | null | undefined): number {
  if (!err?.code || !SCAN_RETRY_CODES.has(err.code)) return 0;
  return Math.min(30, Math.max(5, err.retryAfterS ?? 8)) * 1000;
}

// ───────────── موقع المندوب وإعادة المسح ─────────────

/** أسوأ دقّة تُقبل بلا تنبيه: فوقها قراءة ثانية طازجة، ثم المسح بتنبيه «موقعك تقريبي» (الخادم يرفض فوق ٥٠٠ م). */
export const COARSE_GPS_M = 150;

export type GpsErrorKind = 'DENIED' | 'TIMEOUT' | 'UNAVAILABLE';

/** سبب تعذّر الموقع من رمز GeolocationPositionError: ١ رفض الإذن، ٣ انتهاء المهلة، وغيرهما (٢ أو جهاز بلا GPS) غير متاح. */
export function gpsErrorKind(e: unknown): GpsErrorKind {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 1 ? 'DENIED' : code === 3 ? 'TIMEOUT' : 'UNAVAILABLE';
}

/** رسالة كل سبب (تمرّ بـtr() متغيّرةً ⇒ ترجمتها مختبَرة). */
export const GPS_ERROR_TEXT: Record<GpsErrorKind, string> = {
  DENIED: 'اسمح للتطبيق بالوصول إلى موقعك (من إعدادات الجوال أو المتصفح) لنعرف المحلات القريبة منك',
  TIMEOUT: 'تأخّر تحديد موقعك — تأكّد أن الموقع (GPS) يعمل ثم أعد المحاولة',
  UNAVAILABLE: 'تعذّر تحديد موقعك — شغّل الموقع (GPS) في الجوال ثم أعد المحاولة',
};

/** العودة للشاشة تمسح من جديد إن ابتعد المندوب عن موضع آخر مسح أكثر من هذا (أو من دقّة موقعه إن كانت أسوأ). */
export const RESCAN_MOVE_M = 300;
/** …أو قدُم آخر مسح أكثر من هذا. */
export const RESCAN_AGE_MS = 45 * 60_000;

/** هل قائمة المسح المحفوظة لم تعد لمكان المندوب؟ بلا مسحٍ سابق معروف ⇒ نعم. */
export function needsRescan(fix: Pt & { accuracy?: number }, last: { at: Pt; when: number } | null, now = Date.now()): boolean {
  if (!last) return true;
  if (now - last.when > RESCAN_AGE_MS) return true;
  return distKm(fix, last.at) * 1000 > Math.max(RESCAN_MOVE_M, fix.accuracy ?? 0);
}

/**
 * دمج محلٍّ دُرس بمراجعاته في قائمة المسح: الموجود يحتفظ بمرجعه (خطة التوجيه تشير إليه بالمرجع)، والجديد بمرجعٍ
 * لا يتكرّر — جلسة الخادم إن انتهت (٤ ساعات أو إعادة نشر) تبدأ من P1 فيصطدم مرجعها بمراجع المسح.
 */
export function mergeStudied<T extends { placeId: string; ref: string }>(list: T[], item: T): T[] {
  if (list.some(x => x.placeId === item.placeId)) return list.map(x => (x.placeId === item.placeId ? { ...x, ...item, ref: x.ref } : x));
  const refs = new Set(list.map(x => x.ref));
  let ref = item.ref;
  for (let n = list.length + 1; refs.has(ref); n++) ref = `P${n}`;
  return [...list, { ...item, ref }];
}

/**
 * محطات توجيه العقل حين يصل بعد المسح (/scan/guide): ما انتهت زيارته منذ المسح — سُجّلت نتيجته، أو صار عميلاً، أو
 * أُضيف دون اتصال، أو أُبلغ مغلقاً — لا يعود للخطة، كما أسقطته الشاشة من الخطة الحتمية.
 */
export function aiStopsAfterScan<S extends { ref: string }>(stops: S[], items: {
  ref: string; relation: string; closed?: boolean; pendingCustomer?: boolean; lastOutcomeAt?: string | null;
}[], scannedAt: number): S[] {
  const done = new Set(items
    .filter(x => x.closed || x.pendingCustomer || x.relation === 'CUSTOMER' || (!!x.lastOutcomeAt && Date.parse(x.lastOutcomeAt) >= scannedAt))
    .map(x => x.ref));
  return stops.filter(s => !done.has(s.ref));
}

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
  REFLECTION: 'مراجعة ذاتية', PLAYBOOK_CHANGED: 'لم يعد يوافق دليل البيع',
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
