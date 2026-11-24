// «تذكير بالانصراف عند الخمول ثم انصراف تلقائي» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — منطقٌ صرف يُختبر وحده، مشتركٌ بين نافذة
// المندوب في اللوحة (SalesRepModal) وشاشة صلاحياته في الجوال (MSalesReps) وتطبيق المندوب (IdlePunchOutModal).
//
// القيد في الخادم (services/idlePunchOut.ts) بقرار المالك: نوبةٌ مفتوحة بلا استخدامٍ للتطبيق ولا موقعٍ يصل من جوال المندوب (نقاط
// الخلفية والصفحة، ساكنةً أو متحرّكة) مدّة «دقائق الخمول» ⇒ إشعارٌ يذكّره بالانصراف ونافذة «هل ما زلت تعمل؟» بعدٍّ تنازليّ. وبعد
// التذكير لا يلغي الانصراف التلقائي إلا «ما زلت أعمل» أو تنقّلٌ فعلي (أكثر من ١٥٠ م) أو إصدار مستند (فاتورة أو مرتجع أو سند أو
// زيارة) — لا فتح التطبيق ولا موقعٌ ساكن — وإلا بانقضاء «مهلة الرد» انصرافٌ تلقائي بوقت آخر نشاطٍ سبق التذكير، موسومٌ
// «انصراف تلقائي» في التقارير. والدقيقتان قابلتان للتغيير لكل مندوب كالمسافة، وحدودهما هنا حدود الخادم نفسها (رسالة 400 بالعربية هناك).

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
 * والتطبيق يقرؤه من ردّ النبضة وحده: النبضة تنطلق فور فتح التطبيق وبكل عودةٍ إلى المقدّمة (لمس الإشعار) وكل دقيقة، فلا مصدرين يتسابقان
 */
export interface IdleReminder {
  /** لحظة إرسال التذكير (ISO بساعة الخادم) — مفتاحه: تذكيرٌ أُجيب لا يُعاد فتحه بنبضةٍ لاحقة */
  remindedAt: string;
  idleMinutes: number;
  graceMinutes: number;
  /**
   * فرق ساعة الخادم عن ساعة الجوال لحظة استلام الردّ (serverNow − ساعة الجوال، ms): به يُعدّ التنازل إلى الانصراف التلقائي بساعة
   * الخادم ولو تقدّمت ساعة الجوال أو تأخّرت. صفرٌ إن لم يرسل الخادم serverNow
   */
  clockOffsetMs: number;
}

/** مفتاح التذكير في ردّ الخادم */
export const IDLE_REMINDER_KEY = 'idlePunchOutReminder';

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/**
 * التذكير من ردّ الخادم: الحقل غائب (خادمٌ قبل الميزة) ⇒ undefined فلا يتغيّر شيء، وnull ⇒ لا تذكير معلّق،
 * وشكلٌ فاسد (لحظةٌ لا تُقرأ) ⇒ null — لا نافذة بلا مفتاحٍ يُعرف به التذكير المُجاب.
 * و`phoneNow` ساعة الجوال لحظة استلام الردّ: منها ومن serverNow فرقُ الساعتين للعدّ التنازليّ (idleRemainingMs)
 */
export function idleReminderOf(data: unknown, phoneNow: number = Date.now()): IdleReminder | null | undefined {
  if (!data || typeof data !== 'object' || !(IDLE_REMINDER_KEY in data)) return undefined;
  const v = (data as Record<string, unknown>)[IDLE_REMINDER_KEY];
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.remindedAt !== 'string' || !Number.isFinite(Date.parse(r.remindedAt))) return null;
  const serverNow = typeof r.serverNow === 'number' && Number.isFinite(r.serverNow) && r.serverNow > 0 ? r.serverNow : null;
  return {
    remindedAt: r.remindedAt,
    idleMinutes: posInt(r.idleMinutes) ?? IDLE_MINUTES_DEFAULT,
    graceMinutes: posInt(r.graceMinutes) ?? IDLE_GRACE_DEFAULT,
    clockOffsetMs: serverNow != null && Number.isFinite(phoneNow) ? serverNow - phoneNow : 0,
  };
}

// ───────── العدّ التنازليّ إلى الانصراف التلقائي ─────────

/** لحظة الانصراف التلقائي بساعة الخادم: التذكير + مهلة الرد — تُجريه دورة الخادم (كل دقيقة) عندها أو بعدها بدقيقة على الأكثر */
export const idleDeadlineMs = (r: Pick<IdleReminder, 'remindedAt' | 'graceMinutes'>): number =>
  Date.parse(r.remindedAt) + r.graceMinutes * 60_000;

/** الباقي حتى الانصراف التلقائي (ms، لا أقلّ من صفر) — ساعة الجوال مصحّحةً بفرقها عن ساعة الخادم */
export const idleRemainingMs = (r: IdleReminder, phoneNow: number = Date.now()): number =>
  Math.max(0, idleDeadlineMs(r) - (phoneNow + r.clockOffsetMs));

/** العدّ «د:ث» — الثواني مقرّبةٌ لأعلى فلا يظهر 00:00 والمهلة لم تنقضِ، والدقائق قد تتجاوز ٥٩ (المهلة حتى ١٢٠ دقيقة) */
export function fmtCountdown(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/** التذكير الظاهر في التطبيق: ومعه لحظة إطلاق آخر نبضةٍ أكّدته، وsettled حين تعرض النافذة نتيجة ردٍّ (انصرافٌ تلقائي سبق، أو لا نوبة) */
export type IdleShown = IdleReminder & { beatAt: number; settled?: boolean };

/**
 * النافذة بعد ردّ نبضة (حكمٌ صرف لـRepApp):
 *  • خادمٌ بلا الحقل (undefined) أو ردٌّ من نبضةٍ أُطلقت قبل التي أكّدت الظاهر ⇒ لا تغيير.
 *  • تذكيرٌ أُجيب (handled) ⇒ لا يُعاد فتحه. والتذكير نفسه ⇒ يُحدَّث (فرق الساعتين) بلا إعادة تركيب، وتذكيرٌ آخر ⇒ يحلّ محلّه.
 *  • null (لا تذكير معلّق في الخادم): أُلغي هناك — تنقّلٌ فعلي أو مستندٌ أو «ما زلت أعمل» من جهازٍ آخر أو انصراف — فتُغلق النافذة
 *    ولا يبقى عدٌّ إلى انصرافٍ لن يقع. إلا بعد انقضاء العدّ (الأرجح أنّ الانصراف التلقائي وقع: تبقى ليعرف المندوب النتيجة بضغطه)
 *    أو والنافذة تعرض نتيجة ردٍّ (settled).
 */
export function idleAfterBeat(
  cur: IdleShown | null, incoming: IdleReminder | null | undefined, beatAt: number, handled: ReadonlySet<string>,
  phoneNow: number = Date.now(),
): IdleShown | null {
  if (incoming === undefined) return cur;
  if (cur && beatAt < cur.beatAt) return cur;
  if (incoming === null) {
    if (!cur || cur.settled || idleRemainingMs(cur, phoneNow) <= 0) return cur;
    return null;
  }
  if (handled.has(incoming.remindedAt)) return cur;
  if (cur && cur.remindedAt === incoming.remindedAt) return { ...incoming, beatAt, settled: cur.settled };
  return { ...incoming, beatAt };
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
