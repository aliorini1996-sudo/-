// رفض «أثبت تواجدي» بعيداً عن العملاء (طلب المالك ٧ نوفمبر ٢٠٢٦) — صرفٌ بلا متصفّح (PresenceCheck.tsx يعرضه)، يُختبر وحده.
//
// المندوب المقيَّد بـ«بصمة الحضور بموقع عميل» لا يُقبل منه «أثبت تواجدي» إلا داخل نطاق أحد عملائه — الحكم نفسه للبصمة
// (judgePunchPlace في backend/src/routes/tracking.ts)، وبلا تساهل «اقبلها بوسم». الخادم يردّ 409 PRESENCE_AWAY_FROM_CUSTOMER
// بسببٍ فرعي (بلا موقع / موقعٌ غير دقيق / خارج النطاق) ومعه أقرب عميل والنطاق، والطلب يبقى مفتوحاً على الخادم: النافذة تقول
// السبب وتعرض «أعد المحاولة» بقراءةٍ طازجة حتى تنتهي المهلة — لا «انتهت المهلة» ولا إغلاق ولا ردٌّ يُعدّ مُجاباً.

import type { PunchFixReason } from './punchFix';

export const PRESENCE_AWAY_CODE = 'PRESENCE_AWAY_FROM_CUSTOMER';

/** NO_FIX = لا موقع مع الردّ · LOW_ACCURACY = الموقع غير دقيق وقد يكون داخل النطاق · OUTSIDE = خارج نطاق كل عملائه */
export type PresenceAwayReason = 'NO_FIX' | 'LOW_ACCURACY' | 'OUTSIDE';

export interface PresenceAway {
  kind: 'away';
  reason: PresenceAwayReason;
  /** مسافة أقرب عملائه بالأمتار — null: لا عميل له قريب */
  nearestM: number | null;
  /** النطاق المسموح بالأمتار (نطاق البصمة) */
  radius: number | null;
  /** نصّ الخادم العربي — احتياطٌ إن غاب النطاق */
  message: string | null;
}

/**
 * away = رفض المكان: الطلب مفتوح ويُعاد بقراءةٍ طازجة ·
 * expired = انتهى أو ليس له (404) أو أُطفئت الميزة (403): نهائيٌّ لا يُعاد ·
 * error = شبكةٌ أو خادم: يُعاد، و«إغلاق مؤقت» متاح
 */
export type PresenceFailure = PresenceAway | { kind: 'expired' } | { kind: 'error' };

type ErrShape = { response?: { status?: number; data?: { code?: unknown; reason?: unknown; message?: unknown; nearestM?: unknown; radius?: unknown } } };

const meters = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** تصنيف فشل «أثبت تواجدي» — رفض المكان أولاً: رمزه وحده يكفي ولو تغيّرت حالته */
export function presenceFailureOf(e: unknown): PresenceFailure {
  const resp = (e as ErrShape | null | undefined)?.response;
  const d = resp?.data;
  if (d && d.code === PRESENCE_AWAY_CODE) {
    // سببٌ مجهول (خادمٌ أحدث) يُعامل «خارج النطاق»: الرفض الأعمّ
    const reason: PresenceAwayReason = d.reason === 'NO_FIX' ? 'NO_FIX' : d.reason === 'LOW_ACCURACY' ? 'LOW_ACCURACY' : 'OUTSIDE';
    const message = typeof d.message === 'string' && d.message.trim() ? d.message.trim() : null;
    return { kind: 'away', reason, nearestM: meters(d.nearestM), radius: meters(d.radius), message };
  }
  if (d?.code === 'PRESENCE_EXPIRED' || d?.code === 'PRESENCE_CLOSED' || resp?.status === 403 || resp?.status === 404) return { kind: 'expired' };
  return { kind: 'error' };
}

/** نصوص الرفض — مفاتيح strings.ts (PHRASES) */
export const PRESENCE_AWAY_TEXTS = {
  outsideNear: 'إثبات تواجدك مشروط بأن تكون داخل {radius} مترا من موقع أحد عملائك — أقرب عملائك على بعد {m} مترا منك',
  outsideNone: 'إثبات تواجدك مشروط بأن تكون داخل {radius} مترا من موقع أحد عملائك — لا عميل لك قريب من موقعك الحالي',
  outsideGeneric: 'إثبات تواجدك مشروط بأن تكون عند أحد عملائك — اقترب من أحد عملائك ثم أعد المحاولة',
  noFix: 'فعّل الموقع — إثبات تواجدك مشروط بأن تكون عند أحد عملائك',
  // لا قراءة والموقع غير مرفوض (مهلة/تعذّر) — نصّ البصمة نفسه (VISIT_NOFIX_MSG في RepApp.tsx)
  noFixTimeout: 'تعذر تحديد موقعك اقترب من نافذة او مكان مفتوح ثم اعد المحاولة',
  lowAccuracy: 'موقعك غير دقيق الآن — انتظر لحظات ثم أعد المحاولة',
  // القراءة المرسلة تقريبيةٌ بالكيلومترات (الموقع الدقيق مطفأ للتطبيق أو المتصفّح — pinAccuracyLevel = coarse في punchFix.ts):
  // «انتظر» لا يُصلحها، و«أقرب عملائك على بعد…» لا يصدق بها — المطلوب إعدادٌ في الجوال (R5 من تدقيق نطاق ٥٠ متراً)
  coarse: 'موقع جوالك تقريبي (±{acc} م) لا دقيق — فعّل الموقع الدقيق من إعدادات الموقع في جوالك ثم أعد المحاولة',
} as const;

/** دقّةٌ تقريبية معلومة (أمتار) — وغيرها (null، سالب، NaN) كأن القراءة دقيقة: لا يُقال «فعّل الموقع الدقيق» بلا بيّنة */
const coarseOf = (m: number | null | undefined): number | null => (typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : null);

/**
 * ما يقرؤه المندوب عن رفض المكان، بلغته. fixReason: سبب غياب القراءة في الجهاز — رفض «بلا موقع» والموقع غير مرفوض (مهلةٌ أو
 * تعذّر) لا يُقال له «فعّل الموقع» وهو مفعّل: تُقال الحقيقة بدلاً منه (كالبصمة).
 * coarseM: دقّة القراءة المرسلة إن كانت تقريبية (PresenceCheck.tsx يحكم بـpinAccuracyLevel) — رفضٌ بقراءةٍ كهذه، «غير دقيق» أو
 * «خارج النطاق»، يُقال له «فعّل الموقع الدقيق»: الانتظار لا يُصلحها ومسافة أقرب عميلٍ بها لا تصدق. الحكم نفسه من الخادم بلا تغيير.
 */
export function presenceAwayText(a: PresenceAway, tr: (s: string) => string, fixReason?: PunchFixReason | null, coarseM?: number | null): string {
  if (a.reason === 'NO_FIX') {
    return tr(fixReason === 'timeout' || fixReason === 'unavailable' ? PRESENCE_AWAY_TEXTS.noFixTimeout : PRESENCE_AWAY_TEXTS.noFix);
  }
  const coarse = coarseOf(coarseM);
  if (coarse != null) return tr(PRESENCE_AWAY_TEXTS.coarse).replace('{acc}', String(Math.round(coarse)));
  if (a.reason === 'LOW_ACCURACY') return tr(PRESENCE_AWAY_TEXTS.lowAccuracy);
  if (a.radius == null) return a.message ?? tr(PRESENCE_AWAY_TEXTS.outsideGeneric);
  const radius = String(Math.round(a.radius));
  return a.nearestM != null
    ? tr(PRESENCE_AWAY_TEXTS.outsideNear).replace('{radius}', radius).replace('{m}', String(Math.round(a.nearestM)))
    : tr(PRESENCE_AWAY_TEXTS.outsideNone).replace('{radius}', radius);
}

/**
 * رفضُ «انتظر وأعد» لا «أنت بعيد»: موقعٌ غير دقيق، أو بلا قراءة والموقع مفعّل (مهلةٌ أو تعذّر) — قد يكون واقفاً عند عميله،
 * فيُلوَّن تنبيهاً (كهرمانياً) كحالات النافذة الليّنة لا رفضاً (أحمر). والبُعد الصريح ورفض الإذن أحمران — ومعهما القراءة التقريبية:
 * لا يُصلحها الانتظار بل إعدادٌ في الجوال، كرفض الإذن
 */
export function presenceAwaySoft(a: PresenceAway, fixReason?: PunchFixReason | null, coarseM?: number | null): boolean {
  if (a.reason !== 'NO_FIX' && coarseOf(coarseM) != null) return false;
  return a.reason === 'LOW_ACCURACY' || (a.reason === 'NO_FIX' && (fixReason === 'timeout' || fixReason === 'unavailable'));
}

/** ما تعرضه النافذة عن رفض المكان — ويحفظه التطبيق لطلبه، فتعود به النافذة بعد «إغلاق مؤقت» لا بالسؤال الأول */
export interface PresenceAwayView { text: string; soft: boolean }
export function presenceAwayView(
  a: PresenceAway, tr: (s: string) => string, fixReason?: PunchFixReason | null, coarseM?: number | null,
): PresenceAwayView {
  return { text: presenceAwayText(a, tr, fixReason, coarseM), soft: presenceAwaySoft(a, fixReason, coarseM) };
}
