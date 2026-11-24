/**
 * «التعميمات» (طلب المالك ٢٣ نوفمبر ٢٠٢٦): قرارٌ أو إعلانٌ إداريّ تنشره إدارة الشركة — للمناديب (REPS، من صفحة المناديب)
 * أو لمستخدمي الشركة (USERS، من صفحة مستخدمي الشركة) — فيظهر للموظف في نافذةٍ صغيرة حين يفتح التطبيق ولا تختفي حتى يضغط
 * «تمت القراءة». الخادم: /api/circulars (القائمة والنشر ومن قرأ والسحب للإدارة، والمعلّق والإقرار للموظف).
 *
 * منطقٌ صرفٌ بلا React (يختبره circulars.test.ts): حدود النموذج مرآةً لحدود الخادم (العنوان ١..١٢٠ والنص ١..٤٠٠٠ والمستهدفون
 * غير فارغين حين «محددون»)، وتاريخ الانتهاء نهايةَ اليوم المختار بتوقيت الجهاز، ونسبة القراءة، وحالة العرض (نشط/منتهٍ/مسحوب).
 * طرف الموظف (النافذة و«تمت القراءة» والمعلّق) منطقه في lib/circularGate.ts.
 */

export type CircularAudience = 'REPS' | 'USERS';
export type CircularStatus = 'ACTIVE' | 'WITHDRAWN';

/** صفّ قائمة الإدارة — GET /api/circulars?audience= (الأحدث أولاً، حتى ٢٠٠) */
export interface CircularRow {
  id: string;
  audience: CircularAudience;
  title: string;
  body: string;
  targetAll: boolean;
  targetCount: number;
  readCount: number;
  status: CircularStatus;
  createdAt: string;
  createdByName: string | null;
  expiresAt: string | null;
}

/** GET /api/circulars/:id/reads — من قرأ ومتى، ومن لم يقرأ بعد */
export interface CircularReads {
  read: { id: string; name: string; readAt: string }[];
  unread: { id: string; name: string }[];
}

/** جسم POST /api/circulars — targetIds للمحددين وحدهم (معرّفات مناديب لـREPS ومستخدمين لـUSERS) */
export interface CircularCreateBody {
  audience: CircularAudience;
  title: string;
  body: string;
  targetAll: boolean;
  targetIds?: string[];
  expiresAt?: string | null;
}

/** حدود الخادم حرفاً — تغييرها هنا وحدها لا يكفي */
export const CIRCULAR_TITLE_MAX = 120;
export const CIRCULAR_BODY_MAX = 4000;

/** مفتاح React Query للقائمة — وما تحته (من قرأ) يُبطَل معه بمطابقة البادئة */
export const circularsKey = (audience: CircularAudience) => ['circulars', audience] as const;
export const circularReadsKey = (audience: CircularAudience, id: string) => ['circulars', audience, 'reads', id] as const;

/** مسوّدة النموذج كما في الشاشة — expiresOn يومٌ YYYY-MM-DD من حقل التاريخ أو '' بلا انتهاء */
export interface CircularDraft {
  title: string;
  body: string;
  targetAll: boolean;
  targetIds: string[];
  expiresOn: string;
}

export type CircularFormError =
  | 'TITLE_EMPTY' | 'TITLE_LONG' | 'BODY_EMPTY' | 'BODY_LONG' | 'NO_TARGETS' | 'EXPIRES_INVALID' | 'EXPIRES_PAST';

/** نهاية اليوم المختار (٢٣:٥٩:٥٩٫٩٩٩) بتوقيت الجهاز: «ينتهي في ٢٥» يعني أنه يظهر طوال يوم ٢٥ — ويوم غير موجود (٣١ فبراير) ⇒ null */
export function endOfLocalDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const at = new Date(y, mo, d, 23, 59, 59, 999);
  if (at.getFullYear() !== y || at.getMonth() !== mo || at.getDate() !== d) return null;
  return at;
}

/** اليوم بتوقيت الجهاز YYYY-MM-DD — حدٌّ أدنى لحقل «ينتهي في» */
export function localDayOf(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** فحص المسوّدة قبل النشر — أول خطأ بترتيب الحقول على الشاشة، أو null. النصّان يُقصّان كما يُرسَلان */
export function validateCircularDraft(d: CircularDraft, now: Date = new Date()): CircularFormError | null {
  const title = d.title.trim();
  const body = d.body.trim();
  if (!title) return 'TITLE_EMPTY';
  if (title.length > CIRCULAR_TITLE_MAX) return 'TITLE_LONG';
  if (!body) return 'BODY_EMPTY';
  if (body.length > CIRCULAR_BODY_MAX) return 'BODY_LONG';
  if (!d.targetAll && new Set(d.targetIds.filter(Boolean)).size === 0) return 'NO_TARGETS';
  if (d.expiresOn.trim()) {
    const end = endOfLocalDay(d.expiresOn);
    if (!end) return 'EXPIRES_INVALID';
    if (end.getTime() <= now.getTime()) return 'EXPIRES_PAST';
  }
  return null;
}

/** جسم الطلب من مسوّدةٍ صالحة: نصّان مقصوصان، وtargetIds بلا تكرار للمحددين وحدهم (لا تُرسَل مع «الكل»)، والانتهاء ISO أو null */
export function buildCircularBody(audience: CircularAudience, d: CircularDraft): CircularCreateBody {
  const end = d.expiresOn.trim() ? endOfLocalDay(d.expiresOn) : null;
  return {
    audience,
    title: d.title.trim(),
    body: d.body.trim(),
    targetAll: d.targetAll,
    ...(d.targetAll ? {} : { targetIds: [...new Set(d.targetIds.filter(Boolean))] }),
    expiresAt: end ? end.toISOString() : null,
  };
}

/** نسبة القراءة ٠..١٠٠ صحيحةً — بلا مستهدفين ⇒ ٠ (لا قسمة على صفر)، ولا تتجاوز ١٠٠ ولو زاد العدّ */
export function readPct(readCount: number, targetCount: number): number {
  if (!(targetCount > 0) || !(readCount > 0)) return 0;
  return Math.min(100, Math.round((readCount / targetCount) * 100));
}

export type CircularViewState = 'ACTIVE' | 'EXPIRED' | 'WITHDRAWN';

/** حالة العرض: المسحوب مسحوب، والنشط الذي مضى تاريخ انتهائه «منتهٍ» (لم يعد يظهر لأحد) — والسحب للنشط وحده */
export function circularViewState(row: Pick<CircularRow, 'status' | 'expiresAt'>, now: Date = new Date()): CircularViewState {
  if (row.status === 'WITHDRAWN') return 'WITHDRAWN';
  if (row.expiresAt) {
    const t = new Date(row.expiresAt).getTime();
    if (!Number.isNaN(t) && t <= now.getTime()) return 'EXPIRED';
  }
  return 'ACTIVE';
}

export const canWithdrawCircular = (row: Pick<CircularRow, 'status' | 'expiresAt'>, now: Date = new Date()) =>
  circularViewState(row, now) === 'ACTIVE';

export interface CircularPerson { id: string; name: string; isActive?: boolean }

/**
 * مرشّحو «محددون»: النشطون وحدهم (المعطَّل لا يفتح التطبيق)، وبلا الناشر نفسه (لا يصله تعميمه — الخادم يستثنيه أيضاً)،
 * مرتّبين بالاسم.
 */
export function circularCandidates<T extends CircularPerson>(rows: T[] | undefined | null, selfId?: string | null): T[] {
  return (rows ?? [])
    .filter((r) => r && r.id && r.isActive !== false && r.id !== selfId)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
}

/** بحثٌ بالاسم بلا حساسية لحالة الأحرف */
export function filterPeopleByName<T extends CircularPerson>(rows: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => (r.name || '').toLowerCase().includes(needle));
}
