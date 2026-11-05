// ============================================================================
// تتبّع الخلفية من التطبيق الأصلي (طلب المالك، ٤ نوفمبر ٢٠٢٦): «طوال فتح التطبيق في اليوم» — يبدأ حين يفتح المندوب التطبيق،
// ويستمرّ والتطبيق في الخلفية أو الشاشة مقفلة، ويتوقّف بتسجيل الخروج أو نهاية اليوم أو إيقاف الشركة للتتبّع.
//
// صفحة المندوب (الويب) تطلب «رمز تتبّع» بجلستها (POST /api/tracking/device-token) وتسلّمه لخدمة الموقع الأصلية في أندرويد
// (fieldsatrack://start) أو آيفون (fsTrack)، فترسل الخدمة نقاطها إلى POST /api/track-device/ping بلا جلسة ويب.
//
// الرمز JWT بمفتاحٍ **مشتقٍّ مختلف** عن مفتاح الجلسات (JWT_SECRET + ':device-track'): فلا يقبله authenticate في أي مسار
// (توقيعه لا يطابق)، ولا يقبل verifyTrackToken توكن جلسة. صلاحيته ٢٠ ساعة (يومُ عملٍ واحد)، ونوعه typ='fs-track'.
// لا قاعدة هنا — صرفٌ يُختبر بلا Express (tests/device-track.test.ts).
// ============================================================================
import jwt from 'jsonwebtoken';

/** نوع الرمز في حمولته — توكنٌ آخر موقَّعٌ بالمفتاح نفسه بنوعٍ غيره لا يُقبل */
export const TRACK_TOKEN_TYP = 'fs-track';
/** عمر الرمز: يومُ عملٍ واحد — والتطبيق يوقف الخدمة عند انتهائه أو بتغيّر اليوم المحلي قبله */
export const TRACK_TOKEN_TTL = '20h';
/** رمز رفض نقطة الجهاز: الرمز غائب/فاسد/منتهٍ، أو المندوب/الشركة لم يعودا نشطين — التطبيق يمسح رمزه ويتوقّف */
export const TRACK_TOKEN_INVALID = 'TRACK_TOKEN_INVALID';
/** أقصى طول يُقبل لرمزٍ في الترويسة — لا تحقّق توقيعٍ لنصوصٍ ضخمة */
export const TRACK_TOKEN_MAX_LEN = 4096;
/**
 * «التتبّع الأصلي يعمل الآن»: نقطةٌ من الجهاز قُبلت خلال هذه النافذة ⇒ نقاط الويب (غير المقيَّد) لا تُخزَّن — لا أثرين متراكبين.
 * الجهاز يحفظ نقطةً كل ١٥ث متحرّكاً وكل ٣٠ث ساكناً ويرفع كل ٣٠ث، فالنافذة تحتمل دورةً فائتة. وإن خلت (انقطاعٌ قصير)
 * تُخزَّن نقطة ويبٍ في المكان نفسه — تكرارٌ لا يضرّ الخطّ.
 */
export const NATIVE_TRACK_WINDOW_MS = 90_000;
/**
 * «رُئي يرفع مؤخّراً» (nativeRecent في /device-token): نافذةٌ أوسع لسؤال التحقّق الدوري من الصفحة وحده (هل قتل النظام الخدمة؟).
 * ٩٠ث أضيق من أسوأ فجوةٍ عادية لجهازٍ سليم: ثلاث محاولاتٍ فاشلة (٣٠ث ثم تراجع ٣٠ ← ٦٠ ← ١٢٠ث، ومهلة الطلب ١٥ث) تبلغ ٢٨٥ث بلا
 * صفّ — فخرج من انقطاع تغطيةٍ أو من 503 قصيرٍ «ميتاً» وظهر له زرّ البدء (مراجعة ٥ نوفمبر). أمّا حكم البدء وتخزين نقاط الصفحة
 * فيبقيان على NATIVE_TRACK_WINDOW_MS.
 */
export const NATIVE_RECENT_WINDOW_MS = 5 * 60_000;
/**
 * /device-token حين لا تعرف الذاكرةُ الجهاز (نشرٌ أو إعادة تشغيلٍ على Render تمسحها): يُبحث عن أحدث صفّ جهازٍ استُقبل خلال
 * NATIVE_RECENT_WINDOW_MS (createdAt بساعة الخادم). هذا الحدّ على لحظة الالتقاط وحدها يحصر الاستعلام في مدى فهرس (tenantId, salesRepId, capturedAt) —
 * دقائق قليلة من صفوف المندوب. جهازٌ تتأخّر ساعته أكثر منه لا تُرى صفوفه، فتطلب الصفحة بدءاً ثانياً لا يضرّ (تأخذ الخدمة رمزه وتستمرّ).
 */
export const NATIVE_ROW_LOOKBACK_MS = 15 * 60_000;
/**
 * ترويسة «رفع الإغلاق»: يرسلها التطبيقان بقيمة '1' في الرفع الأخير وحده حين تتوقّف خدمة الموقع (أندرويد TrackService.onDestroy،
 * آيفون send(closing:true)). بها ينسى الخادم «التتبّع الأصلي يعمل» فوراً بدل بقائه ٩٠ث بعد موت الخدمة: وإلا أجابت /device-token
 * nativeActive:true عن خدمةٍ توقّفت للتوّ، فمندوبٌ خرج ثم عاد خلال النافذة لا يُطلب له بدءٌ طوال يومه، ونقاط صفحته لا تُخزَّن.
 */
export const TRACK_FINAL_HEADER = 'x-fs-track-final';
/**
 * مصدر نقطة الموقع في RepLocation.source لما يرفعه التطبيق من الخلفية (قرار المالك، ٤ نوفمبر ٢٠٢٦). نقطة الصفحة بلا مصدر
 * (null) كما كانت قبل الميزة. الخادم وحده يكتبه بحسب المسار — لا يُقرأ من جسم الطلب أبداً، فلا تتنكّر نقطة جهازٍ نقطةَ صفحة.
 * الخلفية تسجّل حتى منتصف الليل ولو انصرف المندوب، فتقرير الساعات لا يعدّها، والمسافة تعدّها داخل غلاف يوم العمل وحده.
 */
export const LOCATION_SOURCE_DEVICE = 'device';
export type LocationSource = typeof LOCATION_SOURCE_DEVICE;

function trackSecret(): string | null {
  const s = process.env.JWT_SECRET;
  return s ? `${s}:device-track` : null;
}

/** رمز تتبّع الجهاز للمندوب في شركته — sub = المندوب، tid = الشركة */
export function issueTrackToken(repId: string, tenantId: string): { token: string; expiresAt: string } {
  const secret = trackSecret();
  if (!secret) throw new Error('JWT_SECRET is required');
  const token = jwt.sign({ sub: repId, tid: tenantId, typ: TRACK_TOKEN_TYP }, secret as jwt.Secret, { expiresIn: TRACK_TOKEN_TTL });
  const exp = (jwt.decode(token) as { exp?: number } | null)?.exp;
  return { token, expiresAt: new Date((exp ?? 0) * 1000).toISOString() };
}

/** التوقيع (بالمفتاح المشتق وحده، HS256) والانتهاء والنوع وهويّتا المندوب والشركة — وإلا null. لا يرمي أبداً */
export function verifyTrackToken(token: string): { repId: string; tenantId: string } | null {
  const secret = trackSecret();
  if (!secret || typeof token !== 'string' || !token || token.length > TRACK_TOKEN_MAX_LEN) return null;
  try {
    const p = jwt.verify(token, secret as jwt.Secret, { algorithms: ['HS256'] }) as { sub?: unknown; tid?: unknown; typ?: unknown };
    if (!p || typeof p !== 'object' || p.typ !== TRACK_TOKEN_TYP) return null;
    if (typeof p.sub !== 'string' || !p.sub || typeof p.tid !== 'string' || !p.tid) return null;
    return { repId: p.sub, tenantId: p.tid };
  } catch {
    return null;
  }
}

/** الرمز من ترويسة Authorization: «Bearer <رمز>» — وإلا null */
export function bearerToken(header: unknown): string | null {
  const v = Array.isArray(header) ? header[0] : header;
  if (typeof v !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(v.trim());
  return m ? m[1] : null;
}

/** لحظةٌ بصيغة ISO-8601 كاملة بمنطقتها (Z أو إزاحة) */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/** لحظة ISO-8601 بالملّي ثانية — وإلا null. بصيغتها وحدها: Date.parse في V8 متساهل («-5» عنده سنة ٢٠٠١) فلا يُعطى نصّاً حرّاً */
export function isoInstantMs(v: unknown): number | null {
  if (typeof v !== 'string' || !ISO_INSTANT_RE.test(v.trim())) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * ساعة الجهاز لحظة الإرسال (ترويسة x-fs-device-now) بالملّي ثانية: الويب يرسلها رقماً (Date.now())، والتطبيق الأصلي
 * قد يرسلها ISO-8601 — تُقبل الصيغتان فلا يضيع تصحيح انحراف الساعة (correctCapturedAt تقرأ الرقم وحده). فاسدةٌ ⇒ null.
 */
export function deviceNowMs(header: unknown): number | null {
  const v = Array.isArray(header) ? header[0] : header;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d{1,16}$/.test(s)) { const n = Number(s); return n > 0 ? n : null; }
  return isoInstantMs(s);
}

/**
 * رفع الإغلاق: الترويسة بقيمة '1' حرفياً. غيرها (غائبةٌ أو أي قيمةٍ أخرى) رفعٌ عاديّ يعلّم «يعمل الآن» — فقيمةٌ مشوّهة من
 * وسيطٍ أو إصدارٍ قادم لا تُطفئ علامة خدمةٍ ما زالت ترفع.
 */
export function isTrackFinal(header: unknown): boolean {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === 'string' && v.trim() === '1';
}

/** حالة المندوب وشركته كما تُقرأ لنقطة الجهاز */
export interface TrackRepState {
  isActive: boolean;
  canBeTracked: boolean | null;
  requireLocationOn: boolean | null;
  tenant: { isActive: boolean; subscriptionEndsAt: Date | null } | null;
}

/**
 * التتبّع مطفأٌ لهذا المندوب الآن — الحكم نفسه في /tracking/ping: إيقاف الشركة للتتبّع أو استثناء المندوب، إلا المقيَّد
 * بـ«اشتراط تفعيل الموقع» فموقعه يُخزَّن دائماً (ظهوره على الخريطة شرطُ عمله).
 */
export function repTrackingOff(trackingEnabled: boolean | null | undefined, rep: { canBeTracked?: boolean | null; requireLocationOn?: boolean | null } | null): boolean {
  const strict = rep?.requireLocationOn === true;
  return !strict && (!trackingEnabled || rep?.canBeTracked === false);
}

/** الشركة موقوفة أو انتهى اشتراكها — كما يحكم الدخول وتجديد الجلسة (routes/auth.ts tenantBlockReason) */
export function trackTenantBlocked(tenant: { isActive: boolean; subscriptionEndsAt: Date | null } | null | undefined, now = Date.now()): boolean {
  if (!tenant || !tenant.isActive) return true;
  return !!tenant.subscriptionEndsAt && tenant.subscriptionEndsAt.getTime() < now;
}

/**
 * حكم نقطة الجهاز: 'gone' (المندوب محذوف/معطّل أو الشركة موقوفة ⇒ 401 فيمسح التطبيق رمزه)، 'off' (التتبّع مطفأ ⇒ stop)،
 * 'on' (تُخزَّن).
 */
export function deviceTrackDecision(rep: TrackRepState | null, trackingEnabled: boolean | null | undefined, now = Date.now()): 'gone' | 'off' | 'on' {
  if (!rep || rep.isActive !== true || trackTenantBlocked(rep.tenant, now)) return 'gone';
  return repTrackingOff(trackingEnabled, rep) ? 'off' : 'on';
}

// ─── «التتبّع الأصلي يعمل الآن» لكل مندوب ───
// في ذاكرة العملية: الخادم نسخةٌ واحدة على Render. لو تعدّدت النسخ لرأت كلٌّ ما قبلته وحده، فتُخزَّن أحياناً نقطة ويبٍ مكرّرة —
// تكرارٌ لا يضرّ (الأثر نفسه)، ولا يُسقط نقطةً واحدة من الجهاز.
// تُحفظ لحظة آخر رفعٍ مقبول حتى NATIVE_RECENT_WINDOW_MS (لا ٩٠ث): منها «يرفع الآن» (٩٠ث) و«رُئي مؤخّراً» (سؤال التحقّق) معاً.
const nativeSeen = new Map<string, number>();
// ورفع الإغلاق لكل مندوب (لحظته): صفوف دفعته الأخيرة في القاعدة «حديثة» NATIVE_RECENT_WINDOW_MS بعده — فلا تُقرأ «يعمل» ولا «رُئي
// مؤخّراً» من خدمةٍ توقّفت (nativeTrackStopped)
const nativeStopped = new Map<string, number>();
const NATIVE_SWEEP_AT = 5000;

function sweep(m: Map<string, number>, now: number): void {
  if (m.size > NATIVE_SWEEP_AT) for (const [id, at] of m) if (now - at > NATIVE_RECENT_WINDOW_MS) m.delete(id);
}

/** نقطةٌ من الجهاز قُبلت الآن لهذا المندوب — وخدمةٌ ترفع بعد إغلاقٍ سابق بدأت من جديد */
export function markNativeTrack(repId: string, now = Date.now()): void {
  nativeSeen.set(repId, now);
  nativeStopped.delete(repId);
  sweep(nativeSeen, now);
}

/**
 * رفع الإغلاق قُبل لهذا المندوب: خدمة جهازه توقّفت ⇒ لا «يعمل الآن» — تعود نقاط صفحته تُخزَّن فوراً، و/device-token يجيب
 * nativeActive:false فتطلب الصفحة بدءاً جديداً (لا تنتظر انقضاء النافذة عن خدمةٍ ميتة، ولا تقرأ «يعمل» من صفوف دفعته الأخيرة)
 */
export function clearNativeTrack(repId: string, now = Date.now()): void {
  nativeSeen.delete(repId);
  nativeStopped.set(repId, now);
  sweep(nativeStopped, now);
}

/**
 * أُغلقت خدمة المندوب برفع الإغلاق خلال NATIVE_RECENT_WINDOW_MS ولم يرفع جهازه بعده: صفوفه الحديثة في القاعدة آخرُ دفعةٍ من خدمةٍ
 * توقّفت، فلا تشهد بأنها تعمل (منتصف الليل، أو سحب الإذن، والصفحة ما زالت تحمل «أُرسل بدءٌ» فتصدّق nativeActive وتعلّم يومها بلا
 * خدمة) ولا بأنها «رُئيت مؤخّراً» (سؤال التحقّق لا يُعيد التسليح)
 */
export function nativeTrackStopped(repId: string, now = Date.now()): boolean {
  const at = nativeStopped.get(repId);
  if (at === undefined) return false;
  if (now - at > NATIVE_RECENT_WINDOW_MS) { nativeStopped.delete(repId); return false; }
  return true;
}

/** لحظة آخر نقطةٍ من الجهاز قُبلت لهذا المندوب (ساعة الخادم) خلال NATIVE_RECENT_WINDOW_MS — وإلا null (لا يُعرف في هذه العملية) */
export function nativeTrackSeenAt(repId: string, now = Date.now()): number | null {
  const at = nativeSeen.get(repId);
  if (at === undefined) return null;
  if (now - at > NATIVE_RECENT_WINDOW_MS) { nativeSeen.delete(repId); return null; }
  return at;
}

/** قُبلت نقطةٌ من الجهاز لهذا المندوب خلال النافذة (٩٠ث) */
export function nativeTrackActive(repId: string, now = Date.now()): boolean {
  return nativeTrackFlags(nativeTrackSeenAt(repId, now), now).nativeActive;
}

/**
 * حكما /device-token من لحظة آخر رفعٍ مقبول (الذاكرة، أو أحدث صفّ جهازٍ بعد نشر): nativeActive خلال ٩٠ث — حكم البدء ونقاط الصفحة —
 * وnativeRecent خلال NATIVE_RECENT_WINDOW_MS لسؤال التحقّق وحده. null ⇒ لا هذا ولا ذاك
 */
export function nativeTrackFlags(seenAt: number | null, now = Date.now()): { nativeActive: boolean; nativeRecent: boolean } {
  if (seenAt === null || !Number.isFinite(seenAt)) return { nativeActive: false, nativeRecent: false };
  const age = now - seenAt;
  return { nativeActive: age <= NATIVE_TRACK_WINDOW_MS, nativeRecent: age <= NATIVE_RECENT_WINDOW_MS };
}

/** للاختبار وحده: تفريغ الذاكرة */
export function resetNativeTrack(): void {
  nativeSeen.clear();
  nativeStopped.clear();
}
