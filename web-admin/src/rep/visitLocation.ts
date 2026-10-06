/**
 * موقع الزيارة — «أين سُجّلت الزيارة بالضبط» (أمر المالك ٦ أكتوبر ٢٠٢٦: زيارات المناديب المقيَّدين بـ«اشتراط تفعيل الموقع»
 * تظهر «بلا موقع»، ولا تُقبل زيارتهم أبداً دون اتصال ولا دون موقع).
 *
 * السببان: زيارة المؤقّت كانت تُرفع بلا إحداثيات إطلاقاً (لكل مندوب)، وزيارة الملاحظة تُحفظ بلا موقع إن تأخّرت قراءة
 * الـGPS عشر ثوانٍ. وحاجز الموقع (locationGate.ts) يثبت أن الموقع مفعّل لا أن قراءةً وصلت.
 *
 * القاعدة:
 *  • كل مندوب: الموقع يُلتقط عند بدء المؤقّت ويُحفظ معه (ينجو من إعادة التحميل)، وأول قراءة تبقى — مكان الوصول لا آخر
 *    مكان — وإن غابت فمحاولةٌ عند الانتهاء.
 *  • المقيَّد: لا يبدأ المؤقّت ولا تُحفظ الملاحظة إلا متصلاً وبقراءة. ولا يدخل صفّ العمل دون اتصال أبداً: زيارة المؤقّت التي
 *    انقطعت شبكتها عند الانتهاء تبقى على الجهاز «بانتظار الاتصال» بقراءة البدء (visitPending.ts) فلا تُسجَّل إلا متصلاً،
 *    والملاحظة بلا اتصال لا تُحفظ. والخادم يردّ زيارته بلا موقع أو من الصفّ (LOCATION_REQUIRED / VISIT_NEEDS_CONNECTION).
 *
 * القرارات صرفة هنا بلا DOM ولا شبكة، والتنفيذ في RepApp.tsx.
 */

export interface GeoFix {
  lat: number;
  lng: number;
  /** نصف قطر الدقّة بالأمتار كما يعطيه الجهاز */
  accuracy?: number;
  /** لحظة القراءة — ISO */
  at: string;
}

/** مؤقّتٌ يكفي للإلحاق: هوية الزيارة وموقعها إن وُجد (VisitTimer يحقّقه) */
export interface FixHolder { customerId: string; startedAt: string; fix?: GeoFix }

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** قراءةٌ سليمة؟ — لما يُقرأ من التخزين المحلي (قيمةٌ تالفة لا تُرسل إحداثياتٍ فاسدة)، و(0،0) قراءةٌ فاسدة لا مكان */
export function isGeoFix(v: unknown): v is GeoFix {
  const f = v as GeoFix | null;
  return !!f && finite(f.lat) && finite(f.lng) && Math.abs(f.lat) <= 90 && Math.abs(f.lng) <= 180
    && !(f.lat === 0 && f.lng === 0)
    && typeof f.at === 'string' && (f.accuracy === undefined || finite(f.accuracy));
}

/** من قراءة المتصفّح إلى GeoFix */
export function toGeoFix(p: { coords: { latitude: number; longitude: number; accuracy?: number | null }; timestamp?: number }): GeoFix {
  const at = finite(p.timestamp) ? new Date(p.timestamp).toISOString() : new Date().toISOString();
  return {
    lat: p.coords.latitude, lng: p.coords.longitude,
    ...(finite(p.coords.accuracy) ? { accuracy: Math.round(p.coords.accuracy) } : {}),
    at,
  };
}

/**
 * يُلحق القراءة بالمؤقّت الجاري — يعيد المؤقّت الجديد أو null إن لا شيء يُكتب:
 * لا مؤقّت، أو مؤقّتٌ لزيارةٍ أخرى (قراءةٌ متأخّرة من زيارةٍ سابقة لا تُلصق بالتالية)، أو قراءةٌ سابقة موجودة (أولها يبقى).
 */
export function attachFix<T extends FixHolder>(current: T | null, visit: { customerId: string; startedAt: string }, fix: GeoFix | null): T | null {
  if (!current || current.customerId !== visit.customerId || current.startedAt !== visit.startedAt) return null;
  if (isGeoFix(current.fix) || !isGeoFix(fix)) return null;
  return { ...current, fix };
}

/** إحداثيات الحمولة: {lat,lng} أو لا شيء — الدقّة ولحظة القراءة لا يحفظهما الخادم */
export function fixCoords(fix: GeoFix | null | undefined): { lat?: number; lng?: number } {
  return isGeoFix(fix) ? { lat: fix.lat, lng: fix.lng } : {};
}

/**
 * بوّابة الزيارة للمقيَّد — لبدء المؤقّت ولحفظ الملاحظة/الصور: متصلٌ أولاً ثم قراءة. غير المقيَّد يمضي دائماً
 * (مؤقّته يبدأ فوراً وقراءته تلحق، وملاحظته تُحفظ ولو بلا موقع كما كانت).
 */
export type VisitGate = 'ok' | 'offline' | 'noFix';
export function visitGate(strict: boolean, online: boolean, hasFix: boolean): VisitGate {
  if (!strict) return 'ok';
  if (!online) return 'offline';
  return hasFix ? 'ok' : 'noFix';
}

/** سقف ضغطة البدء الخاطئة: أقلّ من ثانيتين لا زيارة (كما كان) */
export const MIN_VISIT_SEC = 2;

/**
 * مصير زيارة المؤقّت عند انتهائه (بعد محاولة القراءة إن غابت):
 *  - skip: ضغطة خاطئة لا زيارة.
 *  - send: معها موقع ⇒ تُرفع به.
 *  - sendBare: غير المقيَّد بلا موقع ⇒ تُرفع بلا موقع (سلوكه السابق).
 *  - drop: المقيَّد بلا موقع ⇒ لا تُرسل (الخادم يردّها) — يُقال للمندوب لماذا.
 */
export type FinalizePlan = 'skip' | 'send' | 'sendBare' | 'drop';
export function planFinalize(durationSec: number, hasFix: boolean, strict: boolean): FinalizePlan {
  if (durationSec < MIN_VISIT_SEC) return 'skip';
  if (hasFix) return 'send';
  return strict ? 'drop' : 'sendBare';
}

/**
 * فشل الرفع الحيّ:
 *  - مؤقّت: المقيَّد ⇒ held: يُحفظ على الجهاز (لا صفّ العمل دون اتصال) — «بانتظار الاتصال» لما يُنتظر (انقطاع، خطأ خادم،
 *    عميلٌ لم يُرفع) و«لم تُسجَّل» بسببه للرفض (visitPending.pendingRetryOutcome). غيره: انقطاعٌ ⇒ الصفّ، ورفضٌ يُتجاهل بصمت
 *    كما كان.
 *  - ملاحظة: انقطاع ⇒ المقيَّد يُطلب منه الاتصال ويبقى ما كتبه في النموذج، وغيره إلى الصفّ؛ رفض الخادم ⇒ رسالته.
 */
export type VisitFailure = 'held' | 'outbox' | 'ignore' | 'needOnline' | 'showError';
export function visitFailure(kind: 'timer' | 'note', strict: boolean, networkError: boolean): VisitFailure {
  if (kind === 'timer') {
    if (strict) return 'held';
    return networkError ? 'outbox' : 'ignore';
  }
  if (networkError) return strict ? 'needOnline' : 'outbox';
  return 'showError';
}

/** رموز ردّ الخادم لزيارةٍ لا تُقبل أبداً — إعادة المحاولة بها عبث، فتبقى «مرفوضة» ظاهرةً بسببها حتى يزيلها المندوب */
export const FINAL_VISIT_CODES = ['LOCATION_REQUIRED', 'VISIT_NEEDS_CONNECTION'] as const;
export function isFinalVisitRejection(d: { kind: string; status: string; rejectCode?: string }): boolean {
  return d.kind === 'visit' && d.status === 'rejected' && (FINAL_VISIT_CODES as readonly string[]).includes(d.rejectCode ?? '');
}
