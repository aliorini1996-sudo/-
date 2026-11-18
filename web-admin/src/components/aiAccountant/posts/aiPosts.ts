/**
 * «قيود المحاسب الذكي» — المنطق الصرف لبطاقة القيد (PostedMoveCard) وقائمة القيود (AiPostsList).
 *
 * لا React هنا ولا شبكة ولا متجر: تسميات النوع، تحقّق سبب العكس وجسم طلبه، ترجمة رفض الدفاتر إلى رسالة واضحة (والفترة
 * المقفلة بأوّل تاريخٍ مفتوح)، وتطبيع ردّ GET /ai-accountant/posts دفاعياً — كلّها تُختبر بلا متصفّح (aiPosts.test.ts).
 *
 * العكس يمرّ بمسار الدفاتر القائم وحده (POST /ledger/moves/:id/reverse — ledgerMovesApi.moves.reverse)، والسبب إلزاميّ
 * كما يفرضه الخادم (assertReversalReason ⇒ 422 LEDGER_REVERSAL_REASON_REQUIRED). القيد لا يُعكس هنا بغير ذلك.
 */
import type { PostedMove, PostedMoveKind, PostedMoveLine } from '../../../lib/aiAccountant';
import { ledgerErrorMessage, type LedgerErrorLike } from '../../../lib/ledger/errors';

type Tr = (ar: string) => string;

/** مفتاح react-query لقائمة القيود — نفسه في غلاف المحادثة (يبطله بعد العكس) */
export const POSTS_QUERY_KEY = ['ai-accountant-posts'] as const;

/** حجم القائمة (حدّ الخادم الافتراضي) */
export const POSTS_LIMIT = 50;

/** أقصى طول لسبب العكس — كحقل السبب في معالج العكس بصفحة القيد (MoveForm) */
export const REVERSE_REASON_MAX = 500;

// ─── النوع ───

/**
 * اسم نوع القيد مترجماً — نوعٌ لا نعرفه من خادمٍ أحدث يُسمّى «قيد» ولا يُسقط البطاقة. العبارات حرفيةٌ داخل tr('…')
 * فيراها فاحص الترجمات (missing_keys) كغيرها.
 */
export function postedKindLabel(kind: unknown, tr: Tr = (s) => s): string {
  switch (kind) {
    case 'EXPENSE': return tr('مصروف');
    case 'SALARIES': return tr('رواتب');
    case 'SALARIES_SETTLE': return tr('سداد مستحق');
    default: return tr('قيد');
  }
}

/** ألوان شارة النوع: المصروف بلون العلامة، والرواتب أزرق، وسدادها أخضر */
export function postedKindTone(kind: unknown): string {
  switch (kind) {
    case 'EXPENSE': return 'bg-[#FDECE6] text-[#B8461F] border-[#F6CDBE]';
    case 'SALARIES': return 'bg-[#E8F0FB] text-[#2C5A8C] border-[#C9DBF2]';
    case 'SALARIES_SETTLE': return 'bg-[#E4F1EA] text-[#1E7A52] border-[#C6E3D2]';
    default: return 'bg-[#F1EBDF] text-[#6E6557] border-[#E0D7C6]';
  }
}

// ─── سبب العكس وجسم الطلب ───

/** السبب مشذّباً — كما يشذّبه الخادم */
export const cleanReason = (s: string | null | undefined): string => String(s ?? '').trim();

/** سببٌ مقبول: غير فارغ بعد التشذيب ولا يتجاوز الحدّ */
export function reasonValid(s: string | null | undefined): boolean {
  const r = cleanReason(s);
  return r.length > 0 && r.length <= REVERSE_REASON_MAX;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * جسم POST /ledger/moves/:id/reverse — `{reason}` وحده (الخادم يعكس بتاريخ max(اليوم، تاريخ القيد))، و`date` حين يختار
 * المستخدم «العكس بأوّل تاريخٍ مفتوح» بعد رفض الفترة المقفلة. يعيد null لسببٍ غير مقبول — فلا يُرسَل طلبٌ يرفضه الخادم.
 */
export function reverseBody(reason: string, date?: string | null): { reason: string; date?: string } | null {
  if (!reasonValid(reason)) return null;
  const body: { reason: string; date?: string } = { reason: cleanReason(reason) };
  if (typeof date === 'string' && DAY_RE.test(date)) body.date = date;
  return body;
}

// ─── ردّ العكس ───

export interface ReverseOutcome {
  alreadyReversed: boolean;
  reversalNumber: string | null;
}

/** ردّ العكس بعد تطبيعٍ دفاعي ({success, data:{alreadyReversed, original, reversal:{id, number, date}}}) */
export function reverseOutcome(raw: unknown): ReverseOutcome {
  const d = (raw && typeof raw === 'object' ? raw : {}) as { alreadyReversed?: unknown; reversal?: { number?: unknown } | null };
  const n = d.reversal && typeof d.reversal === 'object' ? d.reversal.number : null;
  return { alreadyReversed: d.alreadyReversed === true, reversalNumber: typeof n === 'string' && n.trim() ? n : null };
}

/** نصّ إشعار النجاح — كمعالج العكس في صفحة القيد */
export function reverseSuccessText(o: ReverseOutcome, tr: Tr): string {
  if (o.alreadyReversed) return tr('القيد معكوس مسبقا');
  return o.reversalNumber ? `${tr('تم عكس القيد')} ${o.reversalNumber}` : tr('تم عكس القيد');
}

// ─── رفض العكس ───

export interface ReverseErrorInfo {
  /** الرسالة مترجمةً */
  message: string;
  /** رفضُ فترةٍ مقفلة — و`firstOpenDate` أوّل يومٍ يُقبل فيه العكس إن أرسله الخادم */
  locked: boolean;
  firstOpenDate: string | null;
}

type LedgerErrBody = LedgerErrorLike & { firstOpenDate?: unknown; details?: Record<string, unknown> | null };

/** جسم خطأ الدفاتر من خطأ axios (نسخة ledgerErrorOf بلا استيراد عميل الشبكة — ليبقى الملف صرفاً) */
function errBodyOf(err: unknown): { hasResponse: boolean; body: LedgerErrBody | null } {
  const r = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (!r) return { hasResponse: false, body: null };
  if (!r.data || typeof r.data !== 'object') return { hasResponse: true, body: { status: r.status } };
  return { hasResponse: true, body: { ...(r.data as LedgerErrBody), status: r.status } };
}

/**
 * رفض العكس ⇒ رسالة مترجمة واضحة (لا رسالة الخادم الخام):
 *  - بلا ردّ ⇒ انقطاع الاتصال.
 *  - LEDGER_PERIOD_LOCKED بلا سببٍ أدقّ ⇒ «تاريخ العكس ضمن فترة مقفلة» وأوّل تاريخٍ مفتوح (details.firstOpenDate) ليُعرض زرّ
 *    «العكس بتاريخ …». سببٌ أدقّ (BEFORE_ORIGINAL_DATE مثلاً) يُترجم بتسميته المعروفة.
 *  - LEDGER_PERMISSION_DENIED ⇒ صلاحية «إنشاء القيود وترحيلها» تحديداً باسمها في صفحة الصلاحيات (المسار يشترط canPostJournals).
 *  - ما سواها ⇒ ledgerErrorMessage (قاموس رموز الدفاتر المشترك).
 */
export function reverseErrorInfo(err: unknown, tr: Tr): ReverseErrorInfo {
  const { hasResponse, body } = errBodyOf(err);
  if (!hasResponse) return { message: tr('تعذر الاتصال بالخادم — تحقق من الإنترنت ثم أعد المحاولة'), locked: false, firstOpenDate: null };
  const code = typeof body?.code === 'string' ? body.code : '';
  const reason = typeof body?.reason === 'string' ? body.reason : typeof body?.details?.reason === 'string' ? body.details.reason : '';
  if (code === 'LEDGER_PERIOD_LOCKED' && !reason) {
    const raw = typeof body?.firstOpenDate === 'string' ? body.firstOpenDate : body?.details?.firstOpenDate;
    const first = typeof raw === 'string' && DAY_RE.test(raw) ? raw : null;
    return { message: tr('تاريخ العكس ضمن فترة مقفلة'), locked: true, firstOpenDate: first };
  }
  if (code === 'LEDGER_PERMISSION_DENIED') {
    return { message: tr('عكس القيود يحتاج صلاحية «إنشاء القيود وترحيلها»'), locked: false, firstOpenDate: null };
  }
  return { message: ledgerErrorMessage(tr, body), locked: code === 'LEDGER_PERIOD_LOCKED', firstOpenDate: null };
}

// ─── ردّ القائمة ───

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

function normalizeLine(l: unknown): PostedMoveLine | null {
  if (!l || typeof l !== 'object') return null;
  const x = l as Partial<PostedMoveLine>;
  return { accountCode: str(x.accountCode), accountName: str(x.accountName), debit: num(x.debit), credit: num(x.credit) };
}

/** قيدٌ واحد بعد تطبيعٍ دفاعي — بلا معرّف قيدٍ ⇒ null (لا يُعرض قيدٌ لا يمكن عكسه ولا فتحه) */
export function normalizePostedMove(m: unknown): PostedMove | null {
  if (!m || typeof m !== 'object') return null;
  const x = m as Partial<PostedMove>;
  if (typeof x.moveId !== 'string' || !x.moveId) return null;
  return {
    id: str(x.id) || x.moveId,
    moveId: x.moveId,
    moveNumber: typeof x.moveNumber === 'string' && x.moveNumber.trim() ? x.moveNumber : null,
    ref: str(x.ref),
    // نوعٌ غائب أو مجهول يبقى كما هو فتسمّيه البطاقة «قيد» — لا يُنسب لنوعٍ لم يقله الخادم
    kind: (typeof x.kind === 'string' ? x.kind : '') as PostedMoveKind,
    amount: num(x.amount),
    date: str(x.date),
    summaryAr: str(x.summaryAr),
    lines: Array.isArray(x.lines) ? x.lines.map(normalizeLine).filter((l): l is PostedMoveLine => !!l) : [],
    reversed: x.reversed === true,
    createdAt: str(x.createdAt),
    adminName: typeof x.adminName === 'string' && x.adminName.trim() ? x.adminName : null,
  };
}

/** ردّ GET /ai-accountant/posts ({rows}) ⇒ قائمة القيود؛ شكلٌ غير متوقّع ⇒ قائمة فارغة لا صفحة ساقطة */
export function normalizePostsResponse(raw: unknown): PostedMove[] {
  const rows = raw && typeof raw === 'object' ? (raw as { rows?: unknown }).rows : null;
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizePostedMove).filter((m): m is PostedMove => !!m);
}

// ─── العرض ───

/** شاشة الجوال (/m): لا رابط «فتح في الدفاتر» — صفحات الدفاتر للويب */
export const isMobilePath = (pathname: string): boolean => /^\/m(\/|$)/.test(pathname);

/** رابط القيد في الدفاتر (/app/ledger/entries/:id) */
export const ledgerMoveHref = (moveId: string): string => `/app/ledger/entries/${encodeURIComponent(moveId)}`;
