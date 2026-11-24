/**
 * «قيود المحاسب الذكي» — المنطق الصرف لبطاقة القيد (PostedMoveCard) وقائمة القيود (AiPostsList).
 *
 * لا React هنا ولا شبكة ولا متجر: تسميات النوع، تحقّق سبب العكس وجسم طلبه، ترجمة رفض الدفاتر إلى رسالة واضحة (والفترة
 * المقفلة بأوّل تاريخٍ مفتوح)، وتطبيع ردّ GET /ai-accountant/posts دفاعياً — كلّها تُختبر بلا متصفّح (aiPosts.test.ts).
 *
 * العكس يمرّ بمسار الدفاتر القائم وحده (POST /ledger/moves/:id/reverse — ledgerMovesApi.moves.reverse)، والسبب إلزاميّ
 * كما يفرضه الخادم (assertReversalReason ⇒ 422 LEDGER_REVERSAL_REASON_REQUIRED). القيد لا يُعكس هنا بغير ذلك.
 */
import type { AiAmortRef, AiPrepaidProgress, PostedMove, PostedMoveKind, PostedMoveLine } from '../../../lib/aiAccountant';
import { ASSET_DEPRECIATION_NOTE, postedDocFields } from '../../../lib/aiAccountantDocs';
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
    // رفع المستندات: إيجارٌ أو خدمةٌ دُفعت مقدماً (115002/115001)، وإطفاؤها الشهري المجدول، وأصلٌ ثابت بلا إهلاك
    case 'PREPAID': return tr('إيجار/مصروف مقدّم');
    case 'PREPAID_AMORT': return tr('إطفاء شهري');
    case 'ASSET': return tr('أصل');
    default: return tr('قيد');
  }
}

/** ألوان شارة النوع: المصروف بلون العلامة، والرواتب أزرق، وسدادها أخضر، والمقدّم بنفسجي وإطفاؤه رمادي مزرقّ، والأصل كهرماني */
export function postedKindTone(kind: unknown): string {
  switch (kind) {
    case 'EXPENSE': return 'bg-[#FDECE6] text-[#B8461F] border-[#F6CDBE]';
    case 'SALARIES': return 'bg-[#E8F0FB] text-[#2C5A8C] border-[#C9DBF2]';
    case 'SALARIES_SETTLE': return 'bg-[#E4F1EA] text-[#1E7A52] border-[#C6E3D2]';
    case 'PREPAID': return 'bg-[#F3ECFB] text-[#6B3FA0] border-[#E0D2F3]';
    case 'PREPAID_AMORT': return 'bg-[#EEF3F8] text-[#3F5F7F] border-[#D5E1EC]';
    case 'ASSET': return 'bg-[#FAEFD8] text-[#8A6A12] border-[#F0DDB0]';
    default: return 'bg-[#F1EBDF] text-[#6E6557] border-[#E0D7C6]';
  }
}

// ─── المستند والإطفاء على البطاقة ───

/** القيد رُحّل من مستندٍ مرفقٍ به — «المستند» يفتحه (GET /ai-accountant/documents/:id/content) */
export const moveDocId = (m: Pick<PostedMove, 'docId' | 'hasAttachment'>): string | null =>
  (typeof m.docId === 'string' && m.docId && m.hasAttachment !== false ? m.docId : null);

/** تقدّم إطفاء قيد الدفع المقدّم: «تم إطفاء ٣ من ١٢» */
export function prepaidProgressText(p: Pick<AiPrepaidProgress, 'postedMonths' | 'months'>, tr: Tr = (s) => s): string {
  return tr('تم إطفاء {n} من {m}').replace('{n}', String(p.postedMonths)).replace('{m}', String(p.months));
}

/**
 * عُكس قيد الدفع (أو توقّف إطفاؤه): الإطفاء يتوقّف وحده وما رُحّل من الأشهر يبقى في الدفاتر — فيُنبَّه إليها بعددها لتُراجع
 * (D2). لا شيء رُحّل ⇒ «توقّف الإطفاء» وحدها. قيدٌ حيّ لم يتوقّف ⇒ null.
 */
export function prepaidStopText(p: Pick<AiPrepaidProgress, 'postedMonths' | 'stopped'>, reversed: boolean, tr: Tr = (s) => s): string | null {
  if (!p.stopped && !reversed) return null;
  if (p.postedMonths > 0) return tr('عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة ({n})').replace('{n}', String(p.postedMonths));
  return tr('عُكس قيد الدفع — توقف الإطفاء');
}

/** أشهرٌ تخطّاها الإطفاء لفترةٍ مقفلة (يُعاد إطفاؤها حين تُفتح) — null بلا أشهر */
export function lockedMonthsText(p: Pick<AiPrepaidProgress, 'lockedMonths'>, tr: Tr = (s) => s): string | null {
  const months = (p.lockedMonths ?? []).filter(m => /^\d{4}-\d{2}$/.test(m));
  return months.length ? tr('تأجل إطفاء {months} لأن الفترة مقفلة').replace('{months}', months.join('، ')) : null;
}

/** ترتيب قيد الإطفاء الشهري: «الشهر ٣ من ١٢» */
export function amortText(a: Pick<AiAmortRef, 'index' | 'months'>, tr: Tr = (s) => s): string {
  return tr('الشهر {n} من {m}').replace('{n}', String(a.index)).replace('{m}', String(a.months));
}

/*
 * تنبيهات الخادم على القيد في قائمة القيود (listAiPostsWith في posting.ts) نصوصٌ عربية ثابتة — والبطاقة تقول معانيها الثلاثة
 * بنفسها مترجمةً: «يحتاج إهلاكاً» للأصل، و«عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة (n)» (n أقساطٌ ما زالت حيّة)، و«الفترة
 * مقفلة فلم يُرحَّل قسط الإطفاء بتاريخ …». تُعرف هنا فلا تُعرض مرّتين ولا بالعربية في واجهةٍ إنجليزية.
 */
const SRV_PREPAID_REVERSED_RE = /^عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة \((\d{1,4})\)$/;
const SRV_PREPAID_LOCKED_RE = /^الفترة مقفلة فلم يُرحَّل قسط الإطفاء بتاريخ (\d{4}-\d{2})-\d{2}/;

/** ملاحظات بطاقة القيد — كلٌّ من مصدرٍ واحد مترجمة، وما لا تعرفه البطاقة من تنبيهات الخادم في `other` كما هو */
export interface MoveNotes {
  /** الأصل الحيّ (D3): «يحتاج إهلاكاً يسجّله المحاسب» */
  asset: string | null;
  /** قيد الدفع المقدّم معكوس: الإطفاء توقّف، والحيّ من أقساطه يُراجع (D2) */
  stop: string | null;
  /** أشهرٌ تخطّاها الإطفاء لفترةٍ مقفلة (لقيدٍ حيّ لم يكتمل) */
  locked: string | null;
  other: string[];
}

/**
 * ملاحظات القيد بلا تكرار: تنبيهات الخادم المعروفة تُطوى في ملاحظات البطاقة المترجمة — وعدد الأقساط في تنبيه العكس من الخادم
 * (الحيّة وحدها — قسطٌ عُكس هو أيضاً لا يُراجع) يغلب عدد المرحّل؛ وقيدٌ أوقفه الخادم بلا تنبيه ⇒ لا قسط حيّاً. الأصل المعكوس
 * لا يحتاج إهلاكاً، والمعكوس لا تُذكر أشهره المقفلة.
 */
export function moveNotes(
  m: Pick<PostedMove, 'kind' | 'prepaid' | 'warnings'>, reversed: boolean, tr: Tr = (s) => s,
): MoveNotes {
  let liveAmort: number | null = null;
  const lockedFromServer: string[] = [];
  const other: string[] = [];
  for (const w of m.warnings ?? []) {
    if (w === ASSET_DEPRECIATION_NOTE) continue;
    const r = SRV_PREPAID_REVERSED_RE.exec(w);
    if (r) { liveAmort = Number(r[1]); continue; }
    const l = SRV_PREPAID_LOCKED_RE.exec(w);
    if (l) { if (!lockedFromServer.includes(l[1])) lockedFromServer.push(l[1]); continue; }
    other.push(w);
  }
  const isPrepaid = m.kind === 'PREPAID';
  const prepaid = isPrepaid ? m.prepaid ?? null : null;
  // تنبيه العكس من الخادم يكفي وحده (ولو غاب جدول التقدّم)
  const stopped = isPrepaid && (reversed || prepaid?.stopped === true || liveAmort !== null);
  const count = liveAmort ?? (prepaid?.stopped ? 0 : prepaid?.postedMonths ?? 0);
  const lockedMonths = [...new Set([...(prepaid?.lockedMonths ?? []), ...lockedFromServer])];
  return {
    asset: m.kind === 'ASSET' && !reversed ? tr('يحتاج إهلاكاً يسجّله المحاسب') : null,
    stop: stopped ? prepaidStopText({ postedMonths: count, stopped: true }, reversed, tr) : null,
    locked: isPrepaid && !stopped ? lockedMonthsText({ lockedMonths }, tr) : null,
    other,
  };
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
    // المستند والإطفاء بوجودهما الصالح وحده — قيدٌ بلا مستند يبقى بمفاتيحه القديمة حرفاً بحرف
    ...postedDocFields(x),
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
