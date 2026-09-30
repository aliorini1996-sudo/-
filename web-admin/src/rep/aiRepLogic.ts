/**
 * المندوب الذكي — منطق صرف لشاشة المسح (بلا React ولا شبكة، مختبَر):
 *   - المسافة ورابط الملاحة (Google Maps بمعرّف المكان) وعرض المسافة.
 *   - نتائج الزيارة وأسبابها، ووسم كل محل في قائمة المسح، وإيقاف «حدّث» بعد مسحٍ فاشل.
 *   - موقع المندوب: سبب تعذّره، وقرار إعادة المسح عند العودة للشاشة، ودمج محلٍّ دُرس بمراجعاته في القائمة.
 *   - حلقة التعلّم: أسباب 👎، وأحكام لوحة «ما تعلّمه العقل».
 *   - لغة المندوب: وقائع التوجيه والدراسة ودروس الفريق ورموز الأخطاء ← نصوص بلغته (tr من useAiRepTr يُمرَّر).
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

const LOCALE: Record<string, string> = { en: 'en-US', fr: 'fr-FR', tr: 'tr-TR', zh: 'zh-CN' };
const UNITS: Record<string, [string, string]> = { ar: ['م', 'كم'], zh: ['米', '公里'] };

/** رقم بلغة المندوب (الفاصلة العشرية في الفرنسية والتركية) — العربية كما كانت. */
function fmtNum(lang: string, x: number, minDigits: number, maxDigits = minDigits): string {
  const loc = LOCALE[lang];
  if (!loc) return minDigits === maxDigits ? x.toFixed(minDigits) : String(Number(x.toFixed(maxDigits)));
  return new Intl.NumberFormat(loc, { minimumFractionDigits: minDigits, maximumFractionDigits: maxDigits, useGrouping: false }).format(x);
}

/** مسافة للعرض بلغة المندوب ووحداتها (العربية افتراضاً). */
export function fmtDistance(m: number, lang = 'ar'): string {
  if (!Number.isFinite(m)) return '—';
  const [mu, ku] = UNITS[lang] ?? ['m', 'km'];
  return m < 1000 ? `${Math.round(m / 10) * 10} ${mu}` : `${fmtNum(lang, m / 1000, m < 10000 ? 1 : 0)} ${ku}`;
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

// ───────────── لغة المندوب: وقائع الخادم ← نصوص بلغته ─────────────
// العربية يكتبها الخادم نفسه (العدد والمعدود والمثنّى في scanGuide.ts)، فتُعرض كما هي؛ واللغات الأربع الأخرى تُركَّب هنا
// من الوقائع بعبارات aiRepPhrases. بلا وقائع (جلسة محفوظة قبلها، أو نصّ العقل المكتوب بلغة المندوب) ⇒ النص كما هو.

type Tr = (ar: string) => string;

/** يملأ {x} في العبارة المترجمة — بدالّة استبدال: «$» في اسم محلٍّ لا يُفسَّر. */
function fill(t: string, vars: Record<string, string | number>): string {
  return t.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** صيغة المفرد في لغة المندوب؟ (الفرنسية تُفرد الصفر، والصينية لا تفرّق) */
function singular(lang: string, n: number): boolean {
  try { return new Intl.PluralRules(LOCALE[lang] ?? lang).select(n) === 'one'; } catch { return n === 1; }
}

const colon = (lang: string) => (lang === 'zh' ? '：' : ': ');

/** وقائع سبب المحطة الحتمي (نسخة الواجهة من StopFacts في backend/src/ai-rep/scanGuide.ts). */
export interface StopFacts {
  fu?: string; days?: number; prev?: 'CLOSED' | 'NOT_FOUND';
  rating: number | null; ratingCount: number | null; openNow: boolean | null; distanceM: number;
}
/** وقائع خلاصة القواعد (نسخة الواجهة من GuideFacts). */
export interface GuideFacts { shops: number; fresh: number; follow: number; customers: number; possible: number; stops: number; open: number }
/** وقائع الدراسة الحتمية (نسخة الواجهة من StudyFacts في profileStudy.ts): كل حقل حاضر مصدرُ الحقل النصّي بالاسم نفسه. */
export interface StudyFacts {
  summary?: { name: string; rating: number | null; ratingCount: number; openNow: boolean | null; reviews: number };
  activityN?: number; praise?: string[]; complaints?: string[]; opportunity?: string[]; visitTip?: string | null;
}

/** وصف نتيجة الزيارة التي تستحقّ متابعة (نسخة الواجهة من FOLLOW_UP_KINDS في الخادم). */
export const FOLLOW_UP_WHAT: Record<string, string> = { QUOTE: 'طلب عرض سعر', INTERESTED: 'أبدى اهتماماً', CALL_BACK: 'طلب العودة لاحقاً' };
/** محاور المراجعات (نسخة الواجهة من THEMES في profileStudy.ts). */
export const THEME_LABEL: Record<string, string> = {
  PRICE: 'الأسعار', STOCK: 'توفّر الأصناف', CLEAN: 'النظافة', SERVICE: 'التعامل والخدمة', SPEED: 'السرعة والزحمة', DELIVERY: 'التوصيل', HOURS: 'ساعات العمل',
};
/** فرص الدراسة الحتمية (نسخة الواجهة من OPPORTUNITY_AR). */
export const OPPORTUNITY_TEXT: Record<string, string> = {
  STOCK_GAP: 'العملاء يشتكون من نقص الأصناف — اعرض توريداً منتظماً يضمن توفّرها.',
  PRICE_SENSITIVE: 'العملاء حسّاسون للسعر — ابدأ بالأصناف الأوفر.',
  VARIETY: 'يُمدح بتنوّع أصنافه — اعرض أصنافاً جديدة تكمّل تشكيلته.',
  BUSY: 'حركة العملاء عالية — المحل يحتاج توريداً أكبر وأسرع.',
};
export const VISIT_TIP_TEXT: Record<string, string> = { HOURS: 'راجع ساعات العمل أدناه وتجنّب أوقات الذروة.' };
/** فترات اليوم لدروس الوقت (نسخة الواجهة من HOUR_BAND_LABEL_AR) — بحرف الجرّ لتقع في جملة الدرس. */
export const HOUR_BAND_TEXT = ['في الصباح', 'وقت الظهيرة', 'بعد الظهر', 'في المساء', 'في الليل'];
/** تكتيك كل اعتراض في دروس الإحصاء (نسخة الواجهة من TACTIC في learn/lessons.ts — «غير ذلك» لا يولّد درساً). */
export const OBJECTION_TACTIC: Record<string, string> = {
  PRICE: 'ركّز على هامش ربحه وسرعة دوران الصنف، والتزم بأسعار دليل البيع.',
  HAS_SUPPLIER: 'اقترح طلباً تجريبياً صغيراً بجانب مورّده بدل مطالبته بالاستبدال.',
  NO_SHELF_SPACE: 'اقترح صنفاً واحداً سريع الدوران في مكان صغير بدل تشكيلة كاملة.',
  NEEDS_CREDIT: 'وضّح سياسة الدفع كما في دليل البيع فقط، واقترح طلباً نقدياً صغيراً أولاً.',
  SLOW_MOVING: 'اعرض أصنافاً سريعة الدوران وابدأ بكمية صغيرة يرى بها حركتها عنده.',
  DECISION_MAKER_ABSENT: 'اسأل عن وقت وجود صاحب القرار وسجّل «عُد لاحقاً» لتعود إليه في موعده.',
  WANTS_SAMPLE: 'اقترح طلباً تجريبياً صغيراً من صنف سريع الدوران ليجرّب حركته عنده.',
  UNKNOWN_BRAND: 'ابدأ بتعريف قصير بالعلامة وبأنها تُباع عند محلات مشابهة دون ذكر أسماء.',
  TIMING: 'اسأل عن أنسب وقت للعودة وسجّله «عُد لاحقاً».',
};

/** «تقييمه ٤٫٣ (١٢٠ مقيّماً) في خرائط Google» بلغة المندوب. */
function ratingText(lang: string, tr: Tr, rating: number | null, count: number | null): string {
  if (rating == null) return tr('بلا تقييم في خرائط Google');
  const r = fmtNum(lang, rating, 0, 1);
  if (!count) return fill(tr('تقييمه {rating} في خرائط Google'), { rating: r });
  const c = fill(singular(lang, count) ? tr('{n} مقيّم') : tr('{n} مقيّمين'), { n: count });
  return fill(tr('تقييمه {rating} ({count}) في خرائط Google'), { rating: r, count: c });
}

/** سبب المحطة بلغة المندوب: العربية نصّ الخادم، وغيرها من وقائعها (f). */
export function stopWhyText(stop: { why: string; f?: StopFacts }, lang: string, tr: Tr): string {
  const f = stop.f;
  if (lang === 'ar' || !f) return stop.why;
  const days = f.days ?? 0;
  const when = fill(tr('قبل {days}'), { days: fill(singular(lang, days) ? tr('{n} يوم') : tr('{n} أيام'), { n: days }) });
  return [
    f.fu && FOLLOW_UP_WHAT[f.fu] ? `${tr('متابعة زيارة')}${colon(lang)}${tr(FOLLOW_UP_WHAT[f.fu])} — ${when}` : null,
    f.prev === 'CLOSED' ? tr('وُجد مغلقاً في زيارة سابقة') : f.prev === 'NOT_FOUND' ? tr('أُبلغ سابقاً أنه لم يُعثر عليه') : null,
    ratingText(lang, tr, f.rating, f.ratingCount),
    f.openNow === true ? tr('مفتوح الآن') : f.openNow === false ? tr('مغلق الآن — زره لاحقاً') : null,
    fill(tr('على بعد {d}'), { d: fmtDistance(f.distanceM, lang) }),
  ].filter(Boolean).join(' · ');
}

/** خلاصة التوجيه بلغة المندوب: العربية نصّ الخادم، وغيرها من وقائع خلاصة القواعد. */
export function guideSummaryText(g: { summary: string; facts?: GuideFacts }, lang: string, tr: Tr): string {
  const f = g.facts;
  if (lang === 'ar' || !f) return g.summary;
  if (!f.shops) return tr('لا محلات مستهدفة حولك الآن — جرّب منطقة أخرى.');
  const c = colon(lang);
  const head = `${tr('المحلات حولك')}${c}${f.shops}`;
  if (!f.stops) return `${head} — ${tr('لا فرص جديدة ولا متابعات مستحقّة الآن — جرّب منطقة أخرى.')}`;
  const parts = [
    f.fresh ? `${tr('فرص جديدة')}${c}${f.fresh}` : null,
    f.follow ? `${tr('للمتابعة')}${c}${f.follow}` : null,
    f.customers ? `${tr('من عملائك')}${c}${f.customers}` : null,
    f.possible ? `${tr('ربما من عملائك')}${c}${f.possible}` : null,
  ].filter(Boolean);
  const tail = f.stops === 1
    ? (f.open ? tr('ابدأ به:') : tr('مغلق الآن — زره حين يفتح:'))
    : (f.open ? tr('ابدأ بهذا الترتيب:') : tr('كلها مغلقة الآن — زرها بهذا الترتيب حين تفتح:'));
  return `${head} — ${parts.join(' · ')}${lang === 'zh' ? '。' : '. '}${tail}`;
}

/** خلاصة الدراسة الحتمية بلغة المندوب. */
function studySummaryText(x: NonNullable<StudyFacts['summary']>, lang: string, tr: Tr): string {
  if (x.rating != null) {
    const open = x.openNow === true ? ` · ${tr('مفتوح الآن')}` : x.openNow === false ? ` · ${tr('مغلق الآن')}` : '';
    return `${x.name}${colon(lang)}${ratingText(lang, tr, x.rating, x.ratingCount || null)}${open}`;
  }
  if (x.reviews > 0) {
    const reviews = fill(singular(lang, x.reviews) ? tr('{n} مراجعة') : tr('{n} مراجعات'), { n: x.reviews });
    return fill(tr('{name}: دراسة من {reviews} من خرائط Google.'), { name: x.name, reviews });
  }
  return fill(tr('{name}: لا تقييمات له في خرائط Google بعد — الدراسة تعتمد على زيارتك.'), { name: x.name });
}

/** رموز ← نصوص مترجمة؛ رمزٌ لا تعرفه الواجهة (خادم أحدث) ⇒ النصوص العربية كما وصلت. */
function codesText(codes: string[] | undefined, table: Record<string, string>, text: string[], tr: Tr): string[] {
  return codes && codes.every(c => table[c]) ? codes.map(c => tr(table[c])) : text;
}

/**
 * نصوص الدراسة بلغة المندوب: كل حقل له وقائع يُركَّب منها (غير العربية)، وإلا نصّه كما وصل — العربية، ونصّ العقل
 * المكتوب بلغة المندوب.
 */
export function studyTexts(s: {
  summary: string; activityWhy: string; praise: string[]; complaints: string[]; opportunity: string[]; visitTip: string | null; facts?: StudyFacts;
}, lang: string, tr: Tr): { summary: string; activityWhy: string; praise: string[]; complaints: string[]; opportunity: string[]; visitTip: string | null } {
  const f = lang === 'ar' ? undefined : s.facts;
  const tip = f?.visitTip;
  return {
    summary: f?.summary ? studySummaryText(f.summary, lang, tr) : s.summary,
    activityWhy: f?.activityN == null ? s.activityWhy
      : f.activityN > 0 ? fill(tr('بحسب عدد المقيّمين ({n}) — كلما زاد دلّ على حركة أكبر.'), { n: f.activityN }) : '',
    praise: codesText(f?.praise, THEME_LABEL, s.praise, tr),
    complaints: codesText(f?.complaints, THEME_LABEL, s.complaints, tr),
    opportunity: codesText(f?.opportunity, OPPORTUNITY_TEXT, s.opportunity, tr),
    visitTip: tip === undefined || (tip && !VISIT_TIP_TEXT[tip]) ? s.visitTip : tip ? tr(VISIT_TIP_TEXT[tip]) : null,
  };
}

/** سطر «من تجربة فريقك» بلغة المندوب من مفتاح درسه (OBJ:نوع:اعتراض، TIME:نوع:فترة، REVISIT:نوع) — وإلا نصّه العربي. */
export function teamTipText(key: string | null | undefined, text: string | null | undefined, lang: string, tr: Tr): string {
  const fallback = text ?? '';
  if (lang === 'ar' || !key) return fallback;
  const [kind, code, x] = key.split(':');
  const typeLabel = OUTLET_TYPE_OPTIONS.find(t => t.code === code)?.label;
  if (!typeLabel) return fallback;
  const type = tr(typeLabel);
  if (kind === 'REVISIT') return fill(tr('في «{type}» كثير ممن طلبوا العودة لاحقاً تجاوبوا عند العودة — عُد إليهم في موعدهم ولا تُسقطهم.'), { type });
  if (kind === 'TIME') {
    const band = HOUR_BAND_TEXT[Number(x)];
    return band ? fill(tr('محلات «{type}» تُوجد مغلقة كثيراً {band} — رتّب زيارتها في وقت آخر.'), { type, band: tr(band) }) : fallback;
  }
  if (kind === 'OBJ') {
    const o = OBJECTIONS.find(y => y.code === x);
    const tactic = OBJECTION_TACTIC[x];
    return o && tactic ? fill(tr('في «{type}» من أكثر الاعتراضات التي يواجهها مناديب شركتك: «{objection}» — {tactic}'), { type, objection: tr(o.label), tactic: tr(tactic) }) : fallback;
  }
  return fallback;
}

/** نوع المحل للعرض: العربية تصنيف Google كما جاء (أدقّ)، وغيرها تسمية نوعه عندنا مترجمةً (تصنيف البحث العام عربي). */
export function shopTypeText(it: { outletTypeLabel: string; profile?: { typeLabel: string | null } | null }, lang: string, tr: Tr): string {
  return (lang === 'ar' && it.profile?.typeLabel) || tr(it.outletTypeLabel);
}

// ───────────── رموز أخطاء الخادم ← رسائل بلغة المندوب ─────────────

export interface AiErr { status?: number; code?: string; message?: string; retryAfterS?: number; limit?: number }
export type AiErrCtx = 'me' | 'scan' | 'study' | 'outcome';

/** ردّ الخادم من خطأ الطلب (null = لا ردّ: شبكة أو استثناء محلي). */
export function aiErrOf(e: unknown): AiErr | null {
  const r = (e as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (!r) return null;
  const d = (r.data && typeof r.data === 'object' ? r.data : {}) as AiErr;
  return { status: r.status, code: d.code, message: d.message, retryAfterS: d.retryAfterS, limit: d.limit };
}

/**
 * رسالة خطأ الخادم بلغة المندوب: العربية رسالته كما هي، وغيرها من رمزه (ومعه limit وretryAfterS) — null ⇒ المستدعي
 * يعرض رسالته العامة المترجمة (رمزٌ لا تعرفه الواجهة لا يُعرض عربياً لمندوبٍ بلغة أخرى).
 */
export function aiErrorText(err: AiErr | null, ctx: AiErrCtx, lang: string, tr: Tr): string | null {
  if (!err) return null;
  if (lang === 'ar') return err.message || null;
  switch (err.code) {
    case 'AI_REP_NOT_ALLOWED': return tr('ميزة المندوب الذكي غير مفعّلة لاشتراك شركتك — تواصل مع مزوّد الخدمة لتفعيلها');
    case 'GPS_INACCURATE': return tr('موقعك تقريبي جداً — فعّل «الموقع الدقيق» لهذا التطبيق من إعدادات الجوال ثم حدّث');
    case 'SCAN_COOLDOWN': {
      // 429: مهلة المندوب بعد مسحٍ فاشل (نصف دقيقة)؛ وإلا قاطع المسح العام بدقائقه
      if (err.status === 429) return tr('تعذّر المسح قبل لحظات — انتظر نصف دقيقة ثم حدّث');
      const n = Math.max(1, Math.ceil((err.retryAfterS ?? 60) / 60));
      return fill(tr('خرائط Google تحدّ من البحث الآن — أعد المحاولة بعد {time}'), { time: fill(singular(lang, n) ? tr('{n} دقيقة') : tr('{n} دقائق'), { n }) });
    }
    case 'SCAN_FAILED': return tr('تعذّر مسح المحلات حولك — حاول بعد قليل');
    case 'SOURCE_CHANGED': return tr('تعذّرت قراءة نتائج خرائط Google الآن (تغيّرت صيغتها) — حاول لاحقاً');
    case 'AI_REP_DAILY_LIMIT':
      if (ctx === 'outcome') return tr('بلغت حدّ تسجيل النتائج اليومي — يتجدّد غداً');
      if (err.limit == null) return null;
      return fill(ctx === 'study' ? tr('بلغت حدّ المسح والدراسة اليومي ({n}) — يتجدّد غداً') : tr('بلغت حدّ المسح اليومي ({n}) — نتائجك الحالية تبقى متاحة'), { n: err.limit });
    case 'PLACES_NOT_CONFIGURED': return tr('دراسة المحل من خرائط Google تحتاج مفتاح Google للمنصّة — لم يُضبط بعد');
    case 'PLACES_QUOTA': return tr('بلغت خدمة الأماكن حدّها مؤقتاً — حاول بعد قليل');
    case 'PLACES_NOT_FOUND': return tr('تعذّر العثور على هذا المحل في خرائط Google');
    case 'PLACES_AUTH': case 'PLACES_UNAVAILABLE': return tr('خدمة الأماكن غير متاحة مؤقتاً');
    case 'PLACE_CLOSED': return tr('هذا المحل مغلق حسب خرائط Google');
    default: return null;
  }
}
