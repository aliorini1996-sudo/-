/**
 * «التعميمات» (طلب المالك ٢٣ نوفمبر ٢٠٢٦): قرارٌ أو إعلانٌ إداري تنشره إدارة الشركة، فيظهر للمستلم نافذةً صغيرة عند فتح
 * التطبيق حتى يضغط «تمت القراءة». جمهوران: المناديب (REPS — من صفحة المناديب، بصلاحية canManageSalesReps) ومستخدمو الشركة
 * (USERS — من صفحة مستخدمي الشركة، بصلاحية canManageCompanyUsers). الموجّه في routes/circulars.ts، وهنا القواعد الصافية
 * (بلا قاعدة بيانات) لتُختبر وحدها:
 *
 * - «الكل» (targetAll) يعني الأعضاء المفعّلين **الحاليين** من ذلك النوع — يُحسب عند كل طلب، فيصل التعميمُ من يُضاف بعد نشره.
 *   فإذا أُغلق (سُحب أو انتهى — circularClosedAt) جُمّد على من وُجد لحظة إغلاقه (membersAt): من يُضاف بعده لم يصله ولن يصله،
 *   فلا يُعدّ في المستلمين ولا يُسرد «لم يقرأه» — وإلا تآكلت نسبة قراءة كل تعميمٍ قديم كلما كبرت الشركة.
 * - الإقرار يحمل لحظة الضغط (ackReadAt): صفّ تطبيق المندوب دون اتصال يرفعه لاحقاً بلحظته على الجهاز، فيُقبل ولو أُغلق التعميم
 *   بعدها ما دامت الضغطة قبل الإغلاق — قرأه وهو قائم.
 * - الناشر لا يصله تعميمه: مستخدم الشركة (createdByKind = ADMIN) يُستثنى من مستلمي تعميمات المستخدمين — في «الكل» وفي القائمة.
 *   وجلسة «دخول» المالك أو موظف المنصة تُنشر باسم «الدعم الفني» (OWNER) فلا يُستثنى صاحب الحساب الذي دخلت به — لم يكتبه.
 * - المقيَّد النطاق (services/adminScope.ts) في تعميمات المناديب: يستهدف مناديب نطاقه وحدهم («الكل» منه يُحفظ قائمةً بمعرّفاتهم
 *   فلا يتّسع بتوسّع الشركة)، ويرى من التعميمات ما نشره هو أو ما كل مستلميه في نطاقه — فلا يقرأ أسماء مناديب خارج نطاقه ولا
 *   حالة قراءتهم. تعميمات المستخدمين بلا نطاق: صفحة «مستخدمو الشركة» تعرض المستخدمين كلهم للمقيَّد كذلك.
 */
import { z } from 'zod';
import { deviceNowMs } from './deviceTrack';

export const CIRCULAR_AUDIENCES = ['REPS', 'USERS'] as const;
export type CircularAudience = typeof CIRCULAR_AUDIENCES[number];
export type CircularReaderKind = 'REP' | 'ADMIN';

/** نوع القارئ لكل جمهور (CircularAck.readerKind) */
export const READER_KIND: Readonly<Record<CircularAudience, CircularReaderKind>> = Object.freeze({ REPS: 'REP', USERS: 'ADMIN' });

/** صلاحية الإدارة لكل جمهور — الصفحة التي يسكنها التعميم */
export const AUDIENCE_PERMISSION = Object.freeze({ REPS: 'canManageSalesReps', USERS: 'canManageCompanyUsers' } as const);

export const CIRCULAR_TITLE_MAX = 120;
export const CIRCULAR_BODY_MAX = 4000;
/** أقصى ما تعرضه قائمة الإدارة (الأحدث أولاً) */
export const CIRCULAR_LIST_MAX = 200;
/** ما يُمسح للمقيَّد قبل فلترة ما يراه (ثم يُقصّ إلى CIRCULAR_LIST_MAX) */
export const CIRCULAR_SCOPED_SCAN = 1000;
/** أقصى ما يُعاد في «المعلّق» عند فتح التطبيق (الأقدم أولاً) */
export const CIRCULAR_PENDING_MAX = 50;
/** أقصى عدد مستلمين محدَّدين في تعميم */
export const CIRCULAR_TARGETS_MAX = 5000;

/** اسم الناشر لجلسة «دخول» المالك أو موظف المنصة ومفتاحٍ أصدره الدعم الفني — لا باسم مدير الشركة (وعد اتفاقية البيانات) */
export const SUPPORT_AUTHOR_NAME = 'الدعم الفني';

export const CIRCULAR_MESSAGES = Object.freeze({
  FORBIDDEN: 'لا تملك صلاحية الوصول لهذا القسم',
  NOT_FOUND: 'التعميم غير موجود',
  AUDIENCE_INVALID: 'نوع التعميم غير معروف',
  INVALID: 'بيانات التعميم غير صحيحة',
  TITLE_REQUIRED: 'اكتب عنوان التعميم',
  TITLE_TOO_LONG: 'عنوان التعميم أطول من 120 حرفا',
  BODY_REQUIRED: 'اكتب نص التعميم',
  BODY_TOO_LONG: 'نص التعميم أطول من 4000 حرف',
  TARGETS_REQUIRED: 'اختر مستلما واحدا على الأقل',
  TARGET_INVALID: 'أحد المستلمين غير موجود أو غير مفعل أو خارج نطاقك',
  NO_RECIPIENTS: 'لا يوجد مستلمون مفعلون لهذا التعميم',
  EXPIRY_INVALID: 'تاريخ انتهاء التعميم غير صحيح',
  EXPIRY_PAST: 'تاريخ انتهاء التعميم يجب أن يكون بعد الآن',
  ACK_NOT_ALLOWED: 'تأكيد قراءة التعميم لصاحب الحساب نفسه وحده',
});

export function parseAudience(v: unknown): CircularAudience | null {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return (CIRCULAR_AUDIENCES as readonly string[]).includes(s) ? (s as CircularAudience) : null;
}

/** ما يلزم من صفّ التعميم لحساب مستلميه */
export interface CircularTargeting {
  audience: string;
  targetAll: boolean;
  targetIds: string[];
  createdByKind: string | null;
  createdById: string | null;
}

/** هل هذا القارئ ناشر التعميم نفسه؟ (مستخدم شركة نشر تعميماً للمستخدمين) */
export function isCreator(c: Pick<CircularTargeting, 'createdByKind' | 'createdById'>, readerKind: CircularReaderKind, readerId: string): boolean {
  return readerKind === 'ADMIN' && c.createdByKind === 'ADMIN' && !!c.createdById && c.createdById === readerId;
}

/**
 * مستلمو التعميم **الآن** من بين الأعضاء المفعّلين المعطَين (activeIds — للمقيَّد: مفعّلو نطاقه وحدهم): «الكل» = كلهم، وإلا
 * المحدَّدون منهم (المعطَّل أو المحذوف بعد النشر يسقط). والناشر مستثنى دائماً.
 */
export function circularTargets(c: CircularTargeting, activeIds: Iterable<string>): string[] {
  const active = activeIds instanceof Set ? (activeIds as Set<string>) : new Set(activeIds);
  const ids = c.targetAll ? [...active] : [...new Set(c.targetIds)].filter((id) => active.has(id));
  const kind = c.audience === 'USERS' ? 'ADMIN' : 'REP';
  return ids.filter((id) => !isCreator(c, kind, id));
}

/** ما يلزم من صفّ التعميم لمعرفة لحظة إغلاقه */
export interface CircularLifetime {
  status: string;
  expiresAt: Date | null;
  withdrawnAt?: Date | null;
  /** احتياطٌ لمسحوبٍ بلا withdrawnAt — لا مسار تعديل للتعميم، فآخر كتابةٍ عليه هي السحب */
  updatedAt?: Date | null;
}

/**
 * لحظة إغلاق التعميم: السحب (withdrawnAt) أو الانتهاء الماضي (expiresAt ≤ الآن) — أسبقهما؛ وnull للقائم (نشطٌ غير منتهٍ).
 * بعدها لا يصل التعميم أحداً (targetedWhere)، فهي حدّ «الكل» في العدّادات وحدّ قبول الإقرار المتأخّر.
 */
export function circularClosedAt(c: CircularLifetime, now: Date): Date | null {
  const times: number[] = [];
  if (c.status === 'WITHDRAWN') {
    const w = c.withdrawnAt ?? c.updatedAt ?? null;
    times.push(w instanceof Date && Number.isFinite(w.getTime()) ? w.getTime() : now.getTime());
  }
  if (c.expiresAt instanceof Date && c.expiresAt.getTime() <= now.getTime()) times.push(c.expiresAt.getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

/**
 * الأعضاء المفعّلون (المعرّف ← لحظة إضافته) الذين وُجدوا عند الإغلاق: للقائم (closedAt = null) كلهم، وللمغلق من أُضيف عنده أو قبله.
 * لحظةٌ مجهولة لا تُسقط صاحبها (لا يُفترض جديداً).
 */
export function membersAt(joinedAt: ReadonlyMap<string, Date | null | undefined>, closedAt: Date | null): string[] {
  if (!closedAt) return [...joinedAt.keys()];
  const limit = closedAt.getTime();
  return [...joinedAt].filter(([, at]) => !(at instanceof Date && at.getTime() > limit)).map(([id]) => id);
}

/** لحظةٌ أرسلها العميل: ملّي ثوانٍ موجبة أو نصّ تاريخٍ ≤ ٤٠ حرفاً — وغير ذلك null */
function sentInstantMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string' && v.length <= 40 && v.trim() !== '') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * لحظة القراءة المخزَّنة لإقرار: ما أرسله الجهاز (body.readAt — لحظة الضغط على ساعته، يرسلها صفّ تطبيق المندوب دون اتصال)
 * مصحَّحاً بانحراف ساعته وقت الرفع (X-FS-Device-Now: الفرق بين ساعة الخادم وساعة الجهاز يُضاف كما هو)، ثم محصوراً بين
 * `floor` (نشر التعميم أو إضافة القارئ — أيّهما أحدث) و«الآن». غائبةٌ أو تالفة ⇒ «الآن» (الإقرار الحيّ). نقيّة.
 */
export function ackReadAt(i: { sent: unknown; deviceNow: unknown; now: Date; floor: Date }): Date {
  const now = i.now.getTime();
  const raw = sentInstantMs(i.sent);
  if (raw == null) return new Date(now);
  const dev = deviceNowMs(i.deviceNow);
  const at = raw + (dev != null ? now - dev : 0);
  const floor = Number.isFinite(i.floor.getTime()) ? i.floor.getTime() : now;
  return new Date(Math.min(now, Math.max(floor, at)));
}

/**
 * عدّادات الصفّ: من قرأ (كل تأكيدٍ مرئيّ — ولو عُطّل صاحبه بعدها، فقد قرأ) ومن لم يقرأ من المستلمين الحاليين.
 * targetCount = المقروء + غير المقروء، فلا يتجاوز المقروءُ المستلمين أبداً.
 */
export function readStats(targets: readonly string[], ackedIds: Iterable<string>): { readCount: number; targetCount: number; unreadIds: string[] } {
  const acked = new Set(ackedIds);
  const unreadIds = targets.filter((id) => !acked.has(id));
  return { readCount: acked.size, targetCount: acked.size + unreadIds.length, unreadIds };
}

/**
 * ما يراه المقيَّد النطاق من تعميمات المناديب: ما نشره هو، أو تعميمٌ بمستلمين محدَّدين كلهم في نطاقه. «الكل» من غير المقيَّد
 * يشمل مناديب خارج نطاقه فلا يراه (لا أسماءهم ولا حالة قراءتهم).
 */
export function visibleToScoped(c: CircularTargeting, adminId: string, scopeIds: ReadonlySet<string>): boolean {
  if (c.createdByKind === 'ADMIN' && c.createdById === adminId) return true;
  return !c.targetAll && c.targetIds.length > 0 && c.targetIds.every((id) => scopeIds.has(id));
}

/**
 * قيد Prisma: تعميمٌ موجَّهٌ لهذا القارئ أيّاً كانت حالته (نشطاً أو مسحوباً أو منتهياً) — من جمهوره، و«الكل» أو هو بين
 * المحدَّدين، وليس ناشره. للإقرار المتأخّر وحده (ضغطةٌ صُفّت دون اتصال قبل إغلاقه)؛ وما سواه targetedWhere.
 */
export function addressedWhere(tid: string, readerKind: CircularReaderKind, readerId: string): Record<string, unknown> {
  return {
    tenantId: tid,
    audience: readerKind === 'REP' ? 'REPS' : 'USERS',
    AND: [{ OR: [{ targetAll: true }, { targetIds: { has: readerId } }] }],
    ...(readerKind === 'ADMIN' && { NOT: { createdByKind: 'ADMIN', createdById: readerId } }),
  };
}

/**
 * قيد Prisma: تعميمٌ موجَّهٌ لهذا القارئ الآن — نشطٌ غير منتهٍ، من جمهوره، و«الكل» أو هو بين المحدَّدين، وليس ناشره.
 * (استثناء الناشر يُعاد في الذاكرة أيضاً بـisCreator — دفاعاً عن عمودٍ فارغ.)
 */
export function targetedWhere(tid: string, readerKind: CircularReaderKind, readerId: string, now: Date): Record<string, unknown> {
  const addressed = addressedWhere(tid, readerKind, readerId);
  return {
    ...addressed,
    status: 'ACTIVE',
    AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, ...(addressed.AND as unknown[])],
  };
}

/** قيد «المعلّق»: الموجَّه لهذا القارئ ولم يؤكّد قراءته بعد */
export function pendingWhere(tid: string, readerKind: CircularReaderKind, readerId: string, now: Date): Record<string, unknown> {
  return { ...targetedWhere(tid, readerKind, readerId, now), acks: { none: { readerKind, readerId } } };
}

export interface CircularCreateInput {
  audience: CircularAudience;
  title: string;
  body: string;
  targetAll: boolean;
  targetIds: string[];
  expiresAt: Date | null;
}
export type CircularParse =
  | { ok: true; data: CircularCreateInput }
  | { ok: false; code: string; message: string };

/** رمز الخطأ لكل رسالة تحقّق — وما سواها CIRCULAR_INVALID */
const PARSE_CODES: Readonly<Record<string, string>> = Object.freeze({
  [CIRCULAR_MESSAGES.AUDIENCE_INVALID]: 'CIRCULAR_AUDIENCE_INVALID',
  [CIRCULAR_MESSAGES.TARGETS_REQUIRED]: 'CIRCULAR_TARGETS_REQUIRED',
  [CIRCULAR_MESSAGES.EXPIRY_INVALID]: 'CIRCULAR_EXPIRY_INVALID',
  [CIRCULAR_MESSAGES.EXPIRY_PAST]: 'CIRCULAR_EXPIRY_PAST',
});
const KNOWN_MESSAGES: ReadonlySet<string> = new Set(Object.values(CIRCULAR_MESSAGES));

/** نصٌّ اختياريّ النوع (الغائب = فارغ) يُطبَّع ثم يُفحص طوله: فارغٌ ⇒ required، وأطول من max ⇒ tooLong */
const textField = (normalize: (s: string) => string, max: number, required: string, tooLong: string) =>
  z.string().nullish().transform((v) => normalize(v ?? '')).pipe(z.string().min(1, required).max(max, tooLong));

/** مخطط جسم النشر (zod) — «الآن» يدخل في فحص تاريخ الانتهاء فيُبنى لكل طلب */
function createSchema(now: Date) {
  const M = CIRCULAR_MESSAGES;
  return z.object({
    audience: z.preprocess((v) => parseAudience(v) ?? undefined, z.enum(CIRCULAR_AUDIENCES, { errorMap: () => ({ message: M.AUDIENCE_INVALID }) })),
    title: textField((s) => s.trim(), CIRCULAR_TITLE_MAX, M.TITLE_REQUIRED, M.TITLE_TOO_LONG),
    body: textField((s) => s.replace(/\r\n?/g, '\n').trim(), CIRCULAR_BODY_MAX, M.BODY_REQUIRED, M.BODY_TOO_LONG),
    targetAll: z.boolean(),
    // المكرّر يُطوى، والمعرّف نصٌّ غير فارغ ≤ ٦٤ بعد القصّ
    targetIds: z.array(z.string().trim().min(1).max(64)).max(CIRCULAR_TARGETS_MAX).nullish()
      .transform((ids) => [...new Set(ids ?? [])]),
    // اختياريّ (الغائب والفارغ = بلا انتهاء)، وأيّ صيغة تاريخ يفهمها Date ≤ ٤٠ حرفاً، وبعد «الآن»
    expiresAt: z.unknown().transform((v, ctx): Date | null => {
      if (v === undefined || v === null || v === '') return null;
      const d = typeof v === 'string' && v.length <= 40 ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: M.EXPIRY_INVALID }); return z.NEVER; }
      if (d.getTime() <= now.getTime()) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: M.EXPIRY_PAST }); return z.NEVER; }
      return d;
    }),
  }).superRefine((d, ctx) => {
    if (!d.targetAll && d.targetIds.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetIds'], message: M.TARGETS_REQUIRED });
  });
}

/**
 * التحقّق من جسم النشر (zod) برسالةٍ عربية لكل حالة (لا رسالة zod العامة — كل ما ليس من CIRCULAR_MESSAGES يصير INVALID):
 * الجمهور، والعنوان ١..١٢٠ والنص ١..٤٠٠٠ بعد القصّ، وtargetAll صريحة، والمحدَّدون (بلا تكرار) لازمون حين لا «الكل»،
 * وتاريخ الانتهاء اختياريّ وبعد الآن. أول مشكلةٍ تحكم.
 */
export function parseCreateBody(body: unknown, now: Date): CircularParse {
  const r = createSchema(now).safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0]?.message ?? '';
    const message = KNOWN_MESSAGES.has(first) ? first : CIRCULAR_MESSAGES.INVALID;
    return { ok: false, code: PARSE_CODES[message] ?? 'CIRCULAR_INVALID', message };
  }
  const d = r.data;
  return {
    ok: true,
    data: { audience: d.audience, title: d.title, body: d.body, targetAll: d.targetAll, targetIds: d.targetAll ? [] : d.targetIds, expiresAt: d.expiresAt },
  };
}
