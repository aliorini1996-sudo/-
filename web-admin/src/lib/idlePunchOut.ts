// «تذكير بالانصراف عند الخمول ثم انصراف تلقائي» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — منطقٌ صرف يُختبر وحده، مشتركٌ بين نافذة
// المندوب في اللوحة (SalesRepModal) وشاشة صلاحياته في الجوال (MSalesReps) وتطبيق المندوب (IdlePunchOutModal).
//
// القيد في الخادم (services/idlePunchOut.ts): نوبةٌ مفتوحة بلا نشاطٍ في التطبيق ولا تنقّلٍ (انتقالٌ فوق ١٥٠ م من تتبّع الخلفية —
// نقاطها والجوال ساكن لا تُحسب) مدّة «دقائق الخمول» ⇒ إشعارٌ يذكّر
// المندوب بالانصراف، وبلا ردٍّ خلال «مهلة الرد» ⇒ انصرافٌ تلقائي بوقت آخر نشاطٍ له، موسومٌ «انصراف تلقائي» في التقارير.
// والدقيقتان قابلتان للتغيير لكل مندوب كالمسافة، وحدودهما هنا حدود الخادم نفسها (رسالة 400 بالعربية هناك).

/** دقائق الخمول قبل التذكير: ١٠–٤٨٠، و٤٥ افتراضاً */
export const IDLE_MINUTES_MIN = 10;
export const IDLE_MINUTES_MAX = 480;
export const IDLE_MINUTES_DEFAULT = 45;
/** مهلة الردّ بعد التذكير قبل الانصراف التلقائي: ٥–١٢٠، و١٥ افتراضاً (قرار المالك) */
export const IDLE_GRACE_MIN = 5;
export const IDLE_GRACE_MAX = 120;
export const IDLE_GRACE_DEFAULT = 15;

const intIn = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

export const idleMinutesOk = (n: unknown): n is number => intIn(n, IDLE_MINUTES_MIN, IDLE_MINUTES_MAX);
export const idleGraceOk = (n: unknown): n is number => intIn(n, IDLE_GRACE_MIN, IDLE_GRACE_MAX);

/** حقلٌ نصّي (شاشة الجوال) ⇒ عدده، والفارغ NaN فلا يمرّ بالفحص — Number('') صفرٌ كان سيُقرأ «صفر دقيقة» */
export const idleFieldNum = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw));

/** حقول القيد على صفّ المندوب — اختياريةٌ: صفّ خادمٍ أقدم لا يحملها */
export interface IdlePunchOutFields {
  idlePunchOutEnabled?: boolean;
  idlePunchOutMinutes?: number;
  idlePunchOutGraceMinutes?: number;
}

/** إعدادات المندوب المحفوظة بافتراضاتها: الغائب مطفأٌ (تقييديٌّ يُقرأ بـ=== true) بـ٤٥/١٥، والقيمة خارج الحدود تعود للافتراض */
export function idleSettingsOf(rep: IdlePunchOutFields | null | undefined): Required<IdlePunchOutFields> {
  return {
    idlePunchOutEnabled: rep?.idlePunchOutEnabled === true,
    idlePunchOutMinutes: idleMinutesOk(rep?.idlePunchOutMinutes) ? rep!.idlePunchOutMinutes! : IDLE_MINUTES_DEFAULT,
    idlePunchOutGraceMinutes: idleGraceOk(rep?.idlePunchOutGraceMinutes) ? rep!.idlePunchOutGraceMinutes! : IDLE_GRACE_DEFAULT,
  };
}

/**
 * جسم الحفظ: المفعّل يرسل دقيقتيه، والمطفأ لا يرسلهما — فتبقى المحفوظتان (أو افتراض الخادم لمندوبٍ جديد)، ولا تردّ قيمةٌ
 * مخفيةٌ خاطئة الحفظَ بـ400 (كتب ٥ ثم أطفأ القيد). كقاعدة المسافة: «المطفأ لا يُرسل مسافته فلا يعطّل الحفظ».
 */
export function idleSaveFields<T extends IdlePunchOutFields>(data: T): T {
  if (data.idlePunchOutEnabled === true) return data;
  const { idlePunchOutMinutes: _m, idlePunchOutGraceMinutes: _g, ...rest } = data;
  return { ...rest, idlePunchOutEnabled: false } as T;
}

// ───────── تطبيق المندوب: «هل ما زلت تعمل؟» ─────────

/**
 * التذكير المعلّق كما يرسله الخادم (services/idlePunchOut.ts ⇒ pendingIdleReminder) في ردّ النبضة
 * (POST /tracking/heartbeat ⇒ data.idlePunchOutReminder) وفي حالة الحضور (GET /tracking/attendance/today، للنوبة المفتوحة).
 * والتطبيق يقرؤه من ردّ النبضة وحده: النبضة تنطلق فور فتح التطبيق وبكل عودةٍ إلى المقدّمة (لمس الإشعار)، فلا مصدرين يتسابقان
 */
export interface IdleReminder {
  /** لحظة إرسال التذكير (ISO بساعة الخادم) — مفتاحه: تذكيرٌ أُجيب لا يُعاد فتحه بنبضةٍ لاحقة */
  remindedAt: string;
  idleMinutes: number;
  graceMinutes: number;
}

/** مفتاح التذكير في ردّ الخادم */
export const IDLE_REMINDER_KEY = 'idlePunchOutReminder';

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/**
 * التذكير من ردّ الخادم: الحقل غائب (خادمٌ قبل الميزة) ⇒ undefined فلا يتغيّر شيء، وnull ⇒ لا تذكير معلّق،
 * وشكلٌ فاسد (لحظةٌ لا تُقرأ) ⇒ null — لا نافذة بلا مفتاحٍ يُعرف به التذكير المُجاب.
 * ولا عدّ تنازليّ من graceMinutes في النافذة: النبضة التي حملت التذكير نشاطٌ يلغي انصرافه التلقائي في الخادم (IdlePunchOutModal)
 */
export function idleReminderOf(data: unknown): IdleReminder | null | undefined {
  if (!data || typeof data !== 'object' || !(IDLE_REMINDER_KEY in data)) return undefined;
  const v = (data as Record<string, unknown>)[IDLE_REMINDER_KEY];
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.remindedAt !== 'string' || !Number.isFinite(Date.parse(r.remindedAt))) return null;
  return {
    remindedAt: r.remindedAt,
    idleMinutes: posInt(r.idleMinutes) ?? IDLE_MINUTES_DEFAULT,
    graceMinutes: posInt(r.graceMinutes) ?? IDLE_GRACE_DEFAULT,
  };
}

/** نصٌّ بعدده: «{n}» في الترجمة يُستبدل بالعدد بعد tr — فالمفتاح ثابتٌ في القاموس */
export const withCount = (text: string, n: number): string => text.replace('{n}', String(n));

/** «ما زلت أعمل»: يسجّل نشاطاً للمندوب الآن ويمحو التذكير المعلّق (routes/tracking.ts) — بجانب الحضور والانصراف */
export const IDLE_STILL_WORKING_PATH = '/tracking/attendance/still-working';

/** رمز الخادم لنوبةٍ أُغلقت قبل الردّ — رمز الانصراف نفسه، ومعه autoCheckedOut: true حين أغلقها الانصراف التلقائي حديثاً */
export const IDLE_NO_OPEN_SHIFT = 'NO_OPEN_SHIFT';

/** ما تعرضه النافذة بعد ردٍّ مرفوض: 'auto' انصرافٌ تلقائي سبق، و'closed' نوبةٌ أُغلقت بغيره (جهازٌ آخر)، وnull خطأٌ يُعاد فيه الضغط */
export function idleClosedKind(status: number | undefined, body: { code?: string; autoCheckedOut?: boolean } | undefined): 'auto' | 'closed' | null {
  if (status !== 409 || body?.code !== IDLE_NO_OPEN_SHIFT) return null;
  return body.autoCheckedOut === true ? 'auto' : 'closed';
}

/** حدث «أعد تحميل حالة الحضور» داخل التطبيق: النافذة تغلق نوبةً أو تكشف إغلاقها فتتحدّث شاشة البصمة إن كانت مفتوحة */
export const ATTENDANCE_REFRESH_EVENT = 'rep:attendance-refresh';

// ───────── اللوحة: نافذة تعديل البصمات ─────────

/** منفّذ الانصراف التلقائي في editedBy وسجلّ التدقيق — اسمٌ يكتبه الخادم (backend services/workDay.ts ⇒ AUTO_CHECKOUT_EDITOR) */
export const AUTO_CHECKOUT_EDITOR = 'النظام';
/** سبب سطره في سجلّ التدقيق (الإجراء AUTO_CHECKOUT) — كما يكتبه الخادم (services/idlePunchOut.ts ⇒ IDLE_AUDIT_REASON) */
export const AUTO_CHECKOUT_REASON = 'انصراف تلقائي بعد خمول';

/**
 * «آخر تعديل» يُعرض لتعديلٍ بشريّ وحده: ختم النظام editedAt/editedBy لحظة الانصراف التلقائي (لتلتقطه المزامنة) ليس تعديلاً —
 * وسم «انصراف تلقائي» بجانبه يقول ما جرى. وتعديلٌ لاحقٌ أبقى وقت الانصراف يكتب اسم المستخدم فيظهر كما هو
 */
export const humanEditOf = (r: { editedBy?: string | null; checkOutAuto?: boolean | null }): string | null =>
  r.editedBy && !(r.checkOutAuto === true && r.editedBy === AUTO_CHECKOUT_EDITOR) ? r.editedBy : null;
