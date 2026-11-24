/**
 * «المحاسب الذكي AI» — الأنواع والقوالب والمنطق الصرف لصفحة المحادثة (ويب و/m).
 *
 * لا React هنا ولا شبكة: كل ما يُختبر بلا متصفّح (بناء جسم الطلب، اختيار القوالب، ترجمة أخطاء الخادم، الأشهر بتوقيت
 * الشركة). الأنواع مرآة عقد الخادم (backend/src/services/aiAccountant/context.ts) حرفاً بحرف — بطاقة التقرير وبطاقة
 * القيد وقائمة القيود تستورد منها.
 *
 * مبادئ ملزمة من المواصفة:
 *  - المحادثة في ذاكرة المكوّن وحدها (لا تخزين) — والطلب يحمل آخر ١٢ رسالة، الأخيرة للمستخدم.
 *  - clientRef جديد (UUID) لكل إرسال، و**إعادة المحاولة تعيد المرجع نفسه**: الترحيل مباشر بلا «نعم»، والخادم يمنع
 *    التكرار بـref مشتقّ منه — فمهلةٌ انقطعت بعد الترحيل ثم إعادةٌ بمرجعٍ جديد كانت ستسجّل المصروف مرّتين.
 *  - قوالب الترحيل («سجّل مصروف»/«سجّل رواتب») لا تظهر إلا لمن يرحّل (status.canPost)، وقوالب القراءة لا تظهر إلا وأداتها
 *    مبنيّة له (تقارير الدفاتر لمن يراها، والمخزون لشركةٍ فعّلته).
 *  - رفع المستندات (طلب المالك ١٨ نوفمبر): رسالة المستخدم تحمل docIds مستنداتها، ورسالة «سجّل القيد» من البطاقة تحمل docConfirm
 *    — كلاهما يُضاف للجسم بوجوده وحده، فجسم المحادثة النصّية يبقى {clientRef, messages:[{role,text}]} حرفاً بحرف. عقد المستندات
 *    ومنطقها الصرف في lib/aiAccountantDocs.ts.
 */
import { newUuid } from './uuid';
import {
  normalizeDocAction, normalizeDocConfirm, normalizeDocIds, normalizeDocRefusal, normalizeDocViews, normalizeDocsStatus,
  postedDocFields,
  type AcctDocConfirm, type AcctDocView, type AiAmortRef, type AiDocsStatus, type AiPrepaidProgress, type ChatAttachment,
  type DocChatAction, type DocRefusal,
} from './aiAccountantDocs';

export type {
  AcctDocConfirm, AcctDocView, AiAmortRef, AiDocsStatus, AiPrepaidProgress, ChatAttachment, DocChatAction, DocRefusal,
} from './aiAccountantDocs';

// ─── عقد الخادم ───

export type AiReportKind =
  | 'income-statement' | 'balance-sheet' | 'trial-balance' | 'executive-summary' | 'general-ledger'
  | 'sales' | 'collections' | 'purchases-inventory' | 'receivables' | 'expenses' | 'profit-estimate' | 'top';

export interface AiReportRow {
  label: string;
  /** null = سطر نصّي بلا مبلغ (عنوان فرعي أو ملاحظة) */
  amount: number | null;
  text?: string;
  level?: 0 | 1 | 2;
  bold?: boolean;
}

export interface AiReportSection {
  title: string | null;
  rows: AiReportRow[];
}

export interface AiReport {
  kind: AiReportKind;
  title: string;
  period: { from: string; to: string } | null;
  currency: string;
  sections: AiReportSection[];
  notes: string[];
  /** تقديري (بلا دفاتر: صافي المبيعات − تكلفة المستودع المتوسطة) — يُوسَم صراحةً */
  estimated?: boolean;
}

/** PREPAID قيد دفعٍ مقدّم (115001/115002)، وPREPAID_AMORT إطفاؤه الشهري المجدول، وASSET أصلٌ ثابت بلا إهلاك (رفع المستندات) */
export type PostedMoveKind = 'EXPENSE' | 'SALARIES' | 'SALARIES_SETTLE' | 'PREPAID' | 'PREPAID_AMORT' | 'ASSET';

export interface PostedMoveLine {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

export interface PostedMove {
  id: string;
  moveId: string;
  moveNumber: string | null;
  ref: string;
  kind: PostedMoveKind;
  amount: number;
  date: string;
  summaryAr: string;
  lines: PostedMoveLine[];
  reversed: boolean;
  createdAt: string;
  adminName: string | null;
  // ── قيود المستندات وحدها (غائبةٌ في قيود المحادثة النصّية — postedDocFields) ──
  /** المستند الذي رُحّل منه القيد */
  docId?: string;
  /** ملف المستند مرفقٌ بالقيد في الدفاتر (يفتحه «المستند» في البطاقة) */
  hasAttachment?: boolean;
  /** قسط إطفاء ⇐ صفّ قيد الدفع المقدّم */
  parentPostId?: string;
  /** قيد الدفع المقدّم: الأقساط المرحّلة من عدد الأشهر */
  prepaid?: AiPrepaidProgress;
  /** قيد إطفاءٍ شهري: ترتيبه من أشهره (حين يرسله الخادم) */
  amort?: AiAmortRef;
  /** تنبيهات الخادم على القيد (warning في الخادم ⇒ قائمة هنا) */
  warnings?: string[];
}

export type BooksMode = 'NONE' | 'MANUAL' | 'LINKED' | 'LEGACY';

/** GET /api/ai-accountant/status */
export interface AiStatus {
  enabled: boolean;
  canPost: boolean;
  booksMode: BooksMode;
  booksActivated: boolean;
  /**
   * يرى الدفاتر (canViewLedger كحرّاس /api/ledger): أدوات تقارير الدفاتر وقائمة «قيود المحاسب الذكي» له وحده.
   * خادمٌ لا يرسله ⇒ يُكمَل من صلاحيات الجلسة (normalizeStatus: fallback).
   */
  canViewLedger: boolean;
  /** «مخزون الشركة» مفعّل — أداة «المشتريات والمخزون» له وحده. خادمٌ لا يرسله ⇒ من علم الشركة (fallback) */
  warehouseOn: boolean;
  currency: string;
  timezone: string;
  /** اليوم بتقويم الشركة المحلي YYYY-MM-DD */
  todayLocal: string;
  companyName: string | null;
  /** رفع المستندات: 📎 لمن docs.enabled وحده (خادمٌ أقدم بلا الكتلة ⇒ مطفأ) */
  docs: AiDocsStatus;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** مستندات رسالة المستخدم (UUID، ٣ على الأكثر) — يُضاف بوجوده وحده */
  docIds?: string[];
}

/** جسم POST /api/ai-accountant/chat */
export interface ChatRequest {
  messages: ChatMessage[];
  clientRef: string;
  /** «سجّل القيد» من بطاقة المستند — docId من docIds آخر رسالة؛ يُضاف بوجوده وحده */
  docConfirm?: AcctDocConfirm;
}

/** نتيجة حارس الأرقام في runAdvisor — TEMPLATE = نصٌّ احتياطي بدل ردٍّ رُفض */
export type ChatGuard = 'PASS' | 'REGEN' | 'TRIM' | 'TEMPLATE';

export interface ChatResponse {
  text: string;
  guard: ChatGuard | string;
  turnId: string | null;
  reports: AiReport[];
  posted: PostedMove[];
  warnings: string[];
  /** بطاقات المستندات المذكورة في الدورة — تُضاف بوجودها وحده (خادمٌ أقدم لا يرسلها) */
  documents?: AcctDocView[];
  /** نتيجة دورة «سجّل القيد»: رُحّل أو رُفض */
  action?: DocChatAction;
  refusal?: DocRefusal;
}

// ─── حدود الطلب (مطابقة zod الخادم) ───

export const MAX_MESSAGES = 12;
export const MAX_TEXT = 4000;

// ─── مدخلات المحادثة في الذاكرة ───

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** مرجع الإرسال لرسالة المستخدم — إعادة المحاولة تعيده نفسه */
  clientRef?: string;
  /** رسالة مستخدم لم يصل ردّها — لا تدخل سياق الطلبات اللاحقة ما لم تُعَد */
  failed?: boolean;
  /** إشعار خطأ محليّ بجانب رسالة فاشلة — لا يُرسَل للخادم أبداً */
  error?: string;
  /** الإشعار يقبل «إعادة المحاولة» (مشغول/شبكة/خادم) — لا مع ميزةٍ مطفأة أو صلاحيةٍ غائبة */
  retryable?: boolean;
  reports?: AiReport[];
  posted?: PostedMove[];
  warnings?: string[];
  guard?: string;
  turnId?: string | null;
  /** رسالة المستخدم: معرّفات مستنداتها — تُرسَل معها في كل طلبٍ ما دامت في نافذة السياق */
  docIds?: string[];
  /** رسالة «سجّل القيد» من البطاقة: بنيتها تُرسَل معها (والإعادة بالمرجع نفسه) — docId من docIds الرسالة نفسها */
  docConfirm?: AcctDocConfirm;
  /** شرائح المرفقات في فقاعة المستخدم — للعرض وحده، لا تُرسَل */
  attachments?: ChatAttachment[];
  /** ردّ المحاسب: بطاقات المستندات */
  documents?: AcctDocView[];
  action?: DocChatAction;
  refusal?: DocRefusal;
}

/** المعرّف المحلي للفقاعة (مفتاح React) — لا علاقة له بالخادم */
export const entryId = (): string => newUuid();

/** مرجع إرسالٍ جديد — UUID v4 كما يتحقّق منه الخادم (z.string().uuid()) */
export const newClientRef = (): string => newUuid();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

/**
 * سياق الطلب من المدخلات: بلا إشعارات الخطأ ولا الرسائل الفاشلة ولا الفارغة، كلٌّ مقصوصٌ إلى ٤٠٠٠ حرف، وآخر ١٢ فقط.
 * يعيد null إن لم تكن الأخيرة للمستخدم (الخادم يرفضه بـ400) — فالمستدعي لا يرسل.
 * `keepFailedId`: رسالة فاشلة تُعاد الآن فتدخل السياق (هي الأخيرة).
 */
export function historyForRequest(entries: readonly ChatEntry[], keepFailedId?: string): ChatMessage[] | null {
  return pickHistory(entries, keepFailedId)?.map(p => p.msg) ?? null;
}

/** السياق مع مدخل كل رسالة — آخره مدخل الإرسال نفسه (منه docConfirm) */
function pickHistory(entries: readonly ChatEntry[], keepFailedId?: string): { entry: ChatEntry; msg: ChatMessage }[] | null {
  const picked: { entry: ChatEntry; msg: ChatMessage }[] = [];
  for (const e of entries) {
    if (e.error && e.role === 'assistant') continue;
    if (e.failed && e.id !== keepFailedId) continue;
    const text = (e.text ?? '').trim();
    if (!text) continue;
    const msg: ChatMessage = { role: e.role, text: text.slice(0, MAX_TEXT) };
    // مستندات رسالة المستخدم وحدها، بوجودها وحده — رسالةٌ بلا مستند تبقى {role, text}
    if (e.role === 'user') {
      const ids = normalizeDocIds(e.docIds);
      if (ids.length) msg.docIds = ids;
    }
    picked.push({ entry: e, msg });
  }
  const last = picked.slice(-MAX_MESSAGES);
  if (!last.length || last[last.length - 1].msg.role !== 'user') return null;
  return last;
}

/**
 * جسم الطلب كاملاً — المرجع إلزامي وبصيغة UUID. docConfirm من مدخل الإرسال (آخر رسالة) بوجوده وحده؛ وتأكيدٌ ناقص الشكل أو
 * لمستندٍ ليس في docIds الرسالة نفسها ⇒ null (لا يُرسَل: الخادم يرفضه DOC_NOT_ATTACHED، والنصّ وحده لا يرحّل شيئاً).
 */
export function buildChatBody(entries: readonly ChatEntry[], clientRef: string, keepFailedId?: string): ChatRequest | null {
  if (!isUuid(clientRef)) return null;
  const picked = pickHistory(entries, keepFailedId);
  if (!picked) return null;
  const messages = picked.map(p => p.msg);
  const sending = picked[picked.length - 1];
  if (sending.entry.docConfirm == null) return { messages, clientRef };
  const docConfirm = normalizeDocConfirm(sending.entry.docConfirm);
  if (!docConfirm || !(sending.msg.docIds ?? []).includes(docConfirm.docId)) return null;
  return { messages, clientRef, docConfirm };
}

/** ردّ الخادم بعد تطبيعٍ دفاعي — حقلٌ غائب من خادمٍ أقدم لا يُسقط الصفحة */
export function normalizeChatResponse(raw: unknown): ChatResponse {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ChatResponse, unknown>>;
  const out: ChatResponse = {
    text: typeof d.text === 'string' ? d.text : '',
    guard: typeof d.guard === 'string' ? d.guard : 'PASS',
    turnId: typeof d.turnId === 'string' ? d.turnId : null,
    reports: Array.isArray(d.reports) ? d.reports.filter(isReportShape) : [],
    posted: Array.isArray(d.posted) ? d.posted.filter(isPostedShape).map(withPostedDocFields) : [],
    warnings: Array.isArray(d.warnings) ? d.warnings.filter((w): w is string => typeof w === 'string' && !!w.trim()) : [],
  };
  // حقول المستندات بوجودها الصالح وحده — ردّ خادمٍ أقدم يبقى بمفاتيحه الستّ
  const documents = normalizeDocViews(d.documents);
  if (documents.length) out.documents = documents;
  const action = normalizeDocAction(d.action);
  if (action) out.action = action;
  const refusal = normalizeDocRefusal(d.refusal);
  if (refusal) out.refusal = refusal;
  return out;
}

const POSTED_DOC_KEYS = ['docId', 'hasAttachment', 'parentPostId', 'prepaid', 'amort', 'warning', 'warnings'] as const;

/** حقول المستند على القيد بعد تطبيعها: الخام منها يُسقط ويُعاد الصالح وحده (postedDocFields) */
function withPostedDocFields(m: PostedMove): PostedMove {
  const out = { ...m } as PostedMove & Record<string, unknown>;
  for (const k of POSTED_DOC_KEYS) delete out[k];
  return Object.assign(out, postedDocFields(m));
}

const isReportShape = (r: unknown): r is AiReport =>
  !!r && typeof r === 'object' && typeof (r as AiReport).title === 'string' && Array.isArray((r as AiReport).sections);

const isPostedShape = (m: unknown): m is PostedMove =>
  !!m && typeof m === 'object' && typeof (m as PostedMove).moveId === 'string' && Array.isArray((m as PostedMove).lines);

/**
 * نصّ الردّ للعرض: النموذج قد يكتب علامات Markdown (**عريض** و# عناوين) — الفقاعة نصٌّ صرف بأسطره، فتُنزع العلامات
 * ولا يُفسَّر شيءٌ منها HTML (React يهرّب النص أصلاً). الأسطر الفارغة المتتالية سطرٌ واحد.
 */
export function plainText(s: string): string {
  return (s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * وسم قيدٍ معكوس في كل الفقاعات (البطاقة تُرسم «معكوساً» بعد نجاح العكس) — وبطاقة المستند المرحّل فيه تصير «غير حيّ»
 * فيُتاح إعادة ترحيله. الفقاعة التي لا تذكره تبقى هي نفسها.
 */
export function markReversed(entries: readonly ChatEntry[], moveId: string): ChatEntry[] {
  return entries.map(e => {
    const inPosted = !!e.posted?.some(m => m.moveId === moveId);
    const inDocs = !!e.documents?.some(d => d.posted?.moveId === moveId && d.posted.live);
    if (!inPosted && !inDocs) return e;
    return {
      ...e,
      ...(inPosted ? { posted: e.posted!.map(m => (m.moveId === moveId ? { ...m, reversed: true } : m)) } : {}),
      ...(inDocs ? { documents: e.documents!.map(d => (d.posted?.moveId === moveId ? { ...d, posted: { ...d.posted, live: false } } : d)) } : {}),
    };
  });
}

/** بطاقة مستندٍ تغيّرت (تصحيح PATCH أو قراءة GET) ⇒ تُستبدل في كل فقاعة تذكرها، وما سواها يبقى هو نفسه */
export function replaceDocView(entries: readonly ChatEntry[], view: AcctDocView): ChatEntry[] {
  return entries.map(e => (e.documents?.some(d => d.id === view.id)
    ? { ...e, documents: e.documents.map(d => (d.id === view.id ? view : d)) }
    : e));
}

// ─── أخطاء الخادم ───

export type ChatErrorKind = 'busy' | 'limit' | 'off' | 'not-enabled' | 'accounting-off' | 'scoped' | 'forbidden' | 'bad-request' | 'network' | 'generic';

export interface ChatErrorInfo {
  kind: ChatErrorKind;
  /** العبارة العربية (مفتاح tr) — المستدعي يمرّرها بـtr */
  message: string;
  /** إعادة المحاولة مفيدة (مشغول/شبكة/خادم) — لا معنى لها مع ميزةٍ مطفأة أو صلاحيةٍ غائبة */
  retryable: boolean;
}

/**
 * خطأ axios ⇒ رسالة عربية واضحة بعباراتنا المترجمة (رسالة الخادم عربية وحدها، و٤٠٠ zod تقنية «بيانات غير صحيحة messages»).
 * ٤٢٩ «الحدّ اليومي» منفصلٌ عن «مشغول»: «حاول بعد دقيقة» كانت ستُعاد طوال اليوم بلا جدوى. و٥٠٣ مفتاح الإطفاء أو نموذجٌ
 * غير مضبوط لا تفيده الإعادة، أمّا تعذّر النموذج العابر (AI_LLM_*) فتفيده.
 */
export function chatErrorInfo(err: unknown): ChatErrorInfo {
  const resp = (err as { response?: { status?: number; data?: { code?: unknown; message?: unknown } } } | null)?.response;
  if (!resp) return { kind: 'network', message: 'تعذر الاتصال بالخادم — تحقق من الإنترنت ثم أعد المحاولة', retryable: true };
  const status = resp.status ?? 0;
  const code = typeof resp.data?.code === 'string' ? resp.data.code : '';
  if (status === 429) {
    if (code === 'AI_ACCOUNTANT_DAILY_LIMIT') return { kind: 'limit', message: 'بلغت حد أسئلة المحاسب الذكي اليومي — يتجدد غدا', retryable: false };
    return { kind: 'busy', message: 'المحاسب مشغول، حاول بعد دقيقة', retryable: true };
  }
  if (status === 503) {
    return { kind: 'off', message: 'المحاسب متوقف مؤقتاً', retryable: code !== 'AI_ACCOUNTANT_OFF' && code !== 'AI_LLM_NOT_CONFIGURED' };
  }
  if (status === 403) {
    if (code === 'AI_ACCOUNTANT_NOT_ALLOWED') return { kind: 'not-enabled', message: 'المحاسب الذكي غير مفعل لشركتك — تواصل مع مزود الخدمة لتفعيله', retryable: false };
    if (code === 'ACCOUNTING_NOT_ALLOWED') return { kind: 'accounting-off', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة', retryable: false };
    if (code === 'AI_ACCOUNTANT_SCOPED') return { kind: 'scoped', message: 'المحاسب الذكي يعمل على مستوى الشركة كلها وحسابك مقيد بنطاق محدد', retryable: false };
    if (code === 'AI_ACCOUNTANT_ADMIN_ONLY' || code === 'AI_ACCOUNTANT_API_KEY') return { kind: 'forbidden', message: 'المحاسب الذكي لإدارة الشركة وحدها', retryable: false };
    return { kind: 'forbidden', message: 'لا تملك صلاحية التقارير اللازمة للمحاسب الذكي', retryable: false };
  }
  if (status === 400 || status === 422) return { kind: 'bad-request', message: 'تعذر فهم الطلب — أعد صياغة رسالتك', retryable: false };
  return { kind: 'generic', message: 'حدث خطأ أثناء الرد — حاول مرة أخرى', retryable: true };
}

/** خطأ يحجب الصفحة كلّها (لا المحادثة وحدها): الميزة أو المحاسبة أو الصلاحية أو النطاق */
export const isBlockingError = (k: ChatErrorKind): boolean =>
  k === 'not-enabled' || k === 'accounting-off' || k === 'scoped' || k === 'forbidden';

// ─── الأشهر والتواريخ بتقويم الشركة ───

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** يوم صالح بصيغة YYYY-MM-DD (لا 2026-02-30) */
export function isValidDay(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

/** اليوم من المتصفّح احتياطاً (قبل وصول حالة الشركة) — بتقويمه المحلي لا UTC */
export function browserToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** شهر اليوم YYYY-MM */
export const monthOf = (day: string): string => day.slice(0, 7);

/** الشهر السابق لليوم YYYY-MM (يناير ⇒ ديسمبر السنة الماضية) */
export function prevMonthOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** أول يوم في شهر اليوم */
export const monthStartOf = (day: string): string => `${day.slice(0, 7)}-01`;

/** فترة «من/إلى» صالحة: يومان صحيحان و«من» ليست بعد «إلى» */
export function rangeError(from: string, to: string): 'missing' | 'invalid' | 'reversed' | null {
  if (!from || !to) return 'missing';
  if (!isValidDay(from) || !isValidDay(to)) return 'invalid';
  if (from > to) return 'reversed';
  return null;
}

// ─── القوالب الجاهزة ───

export type TemplateId =
  | 'income-this-month' | 'income-last-month' | 'profit-this-month' | 'statements-range' | 'trial-balance'
  | 'sales-this-month' | 'collections-this-month' | 'purchases-inventory' | 'receivables' | 'expenses-this-month'
  | 'post-expense' | 'post-salaries';

export interface ChatTemplate {
  id: TemplateId;
  /** اسم الشريحة (مفتاح tr) */
  label: string;
  /**
   * send = يُرسَل نصّه فوراً · range = يفتح خانتي «من/إلى» ثم يُرسَل · prefill = يملأ خانة الكتابة ليكمل المستخدم
   * (قوالب الترحيل: المبلغ يكتبه المستخدم بنفسه — الخادم يرفض مبلغاً لم يرد حرفياً في رسالته).
   */
  mode: 'send' | 'range' | 'prefill';
  /** قالب ترحيل — يظهر لمن يرحّل وحده */
  posting?: boolean;
  /** يحتاج الدفاتر مفعّلة (لا بديل تشغيلي له) */
  needsBooks?: boolean;
  /**
   * أداته من تقارير الدفاتر حين تكون مفعّلة (buildLedgerReadTools: booksActivated && canViewLedger) — فيُخفى عمّن لا يرى
   * الدفاتر وقد فُعّلت. وبلا دفاتر يغطّيه التقدير التشغيلي (profit_estimate) فيبقى ظاهراً.
   */
  needsLedgerView?: boolean;
  /** أداته (purchases_inventory) لا تُبنى إلا و«مخزون الشركة» مفعّل */
  needsWarehouse?: boolean;
}

export const TEMPLATES: readonly ChatTemplate[] = [
  { id: 'income-this-month', label: 'قائمة دخل هذا الشهر', mode: 'send', needsLedgerView: true },
  { id: 'income-last-month', label: 'قائمة دخل الشهر الماضي', mode: 'send', needsLedgerView: true },
  { id: 'profit-this-month', label: 'كم الربح هذا الشهر', mode: 'send', needsLedgerView: true },
  { id: 'statements-range', label: 'قوائم مالية من تاريخ إلى تاريخ', mode: 'range', needsLedgerView: true },
  { id: 'trial-balance', label: 'ميزان المراجعة', mode: 'send', needsBooks: true, needsLedgerView: true },
  { id: 'sales-this-month', label: 'ملخص المبيعات هذا الشهر', mode: 'send' },
  { id: 'collections-this-month', label: 'التحصيل هذا الشهر', mode: 'send' },
  { id: 'purchases-inventory', label: 'المشتريات والمخزون', mode: 'send', needsWarehouse: true },
  { id: 'receivables', label: 'ذمم العملاء', mode: 'send' },
  { id: 'expenses-this-month', label: 'مصروفات هذا الشهر', mode: 'send', needsBooks: true, needsLedgerView: true },
  { id: 'post-expense', label: 'سجّل مصروف', mode: 'prefill', posting: true },
  { id: 'post-salaries', label: 'سجّل رواتب', mode: 'prefill', posting: true },
];

/** ما يحتاجه اختيار القوالب من الحالة — العلمان الأخيران غائبان (حالةٌ جزئية) ⇒ لا يُخفى بهما شيء */
export type TemplateGate = Pick<AiStatus, 'canPost' | 'booksActivated'> & Partial<Pick<AiStatus, 'canViewLedger' | 'warehouseOn'>>;

/**
 * القوالب الظاهرة: الترحيل لمن يرحّل، وما يحتاج الدفاتر لمن فعّلها، وتقارير الدفاتر لمن يراها (حين تكون مفعّلة)،
 * و«المشتريات والمخزون» لشركةٍ فعّلت المخزون — فلا شريحةٌ بلا أداةٍ خلفها تستهلك سؤالاً من الحدّ اليومي لتُجاب «لا أستطيع».
 * وبلا حالةٍ بعد: قوالب القراءة العامة وحدها.
 */
export function visibleTemplates(status: TemplateGate | null | undefined): ChatTemplate[] {
  return TEMPLATES.filter(t => (!t.posting || status?.canPost === true)
    && (!t.needsBooks || status?.booksActivated === true)
    && (!t.needsLedgerView || !(status?.booksActivated === true && status.canViewLedger === false))
    && (!t.needsWarehouse || status?.warehouseOn !== false));
}

type Tr = (ar: string) => string;

/** كلمة العملة في نصّ «سجّل مصروف» — «ريال» للسعودية وأخواتها، وما لا نعرفه برمزه */
export function currencyWord(currency: string | null | undefined, tr: Tr): string {
  const c = (currency || 'SAR').toUpperCase();
  if (['SAR', 'QAR', 'OMR', 'YER', 'IRR'].includes(c)) return tr('ريال');
  if (['AED', 'MAD'].includes(c)) return tr('درهم');
  if (['KWD', 'BHD', 'JOD', 'IQD', 'LYD', 'TND', 'DZD'].includes(c)) return tr('دينار');
  if (['EGP', 'SDG'].includes(c)) return tr('جنيه');
  return c;
}

/** علامة الفراغ في نصوص التعبئة — المؤشّر يُوضع عليها ليكتب المستخدم مكانها */
export const BLANK = '…';

/**
 * نصّ القالب (مترجماً): رسالةٌ صريحة تذكر الشهر بالأرقام حين يكون «الشهر الماضي» — فلا يحسب النموذج تاريخاً بنفسه.
 * `range` للقالب ذي الفترة. القيم الرقمية تُحقن بعد الترجمة فتبقى العبارة مفتاحاً ثابتاً في القاموس.
 * «كم الربح» بحسب الدفاتر: مفعّلةً ⇒ «صافي الربح» (من قائمة الدخل)؛ وبلاها ⇒ «الربح الإجمالي التقديري» — أداة التقدير
 * الوحيدة حينها تحسب الإجمالي بلا مصروفات ولا رواتب، فسؤالٌ عن «الصافي» كان يدعو النموذج لتقديم الإجمالي صافياً.
 */
export function templateText(
  t: Pick<ChatTemplate, 'id'>,
  ctx: { todayLocal: string; currency?: string | null; range?: { from: string; to: string }; booksActivated?: boolean },
  tr: Tr,
): string {
  const today = isValidDay(ctx.todayLocal) ? ctx.todayLocal : browserToday();
  switch (t.id) {
    case 'income-this-month': return tr('اعرض قائمة الدخل لهذا الشهر');
    case 'income-last-month': return tr('اعرض قائمة الدخل للشهر الماضي ({m})').replace('{m}', prevMonthOf(today));
    case 'profit-this-month': return ctx.booksActivated === true ? tr('كم صافي الربح هذا الشهر؟') : tr('كم الربح الإجمالي التقديري هذا الشهر؟');
    case 'statements-range': {
      const r = ctx.range ?? { from: monthStartOf(today), to: today };
      return tr('اعرض القوائم المالية (قائمة الدخل والمركز المالي) من {from} إلى {to}').replace('{from}', r.from).replace('{to}', r.to);
    }
    case 'trial-balance': return tr('اعرض ميزان المراجعة لهذا الشهر');
    case 'sales-this-month': return tr('اعرض ملخص المبيعات لهذا الشهر');
    case 'collections-this-month': return tr('اعرض التحصيل لهذا الشهر حسب طريقة الدفع');
    case 'purchases-inventory': return tr('اعرض المشتريات وقيمة المخزون لهذا الشهر');
    case 'receivables': return tr('اعرض ذمم العملاء المستحقة حتى اليوم');
    case 'expenses-this-month': return tr('اعرض مصروفات هذا الشهر');
    case 'post-expense': return tr('دفعنا {blank} {cur} إيجار نقداً').replace('{blank}', BLANK).replace('{cur}', currencyWord(ctx.currency, tr));
    case 'post-salaries': return tr('رواتب شهر {blank} مبلغ {blank} تحويل بنكي').split('{blank}').join(BLANK);
    default: return '';
  }
}

/** موضع أول فراغ «…» في نصّ التعبئة (لتحديده في الخانة) — أو نهاية النص */
export function firstBlankRange(text: string): [number, number] {
  const i = text.indexOf(BLANK);
  return i < 0 ? [text.length, text.length] : [i, i + BLANK.length];
}

/** نصٌّ ما زال يحمل فراغ القالب — لا يُرسَل قبل إكماله */
export const hasBlank = (text: string): boolean => text.includes(BLANK);

// ─── شريط الحالة ───

export type StatusTone = 'post' | 'read-books' | 'read-only';

/**
 * عبارة الشريط: الدفاتر مفعّلة ويرحّل ⇒ «يسجّل القيود»؛ بلا دفاتر ⇒ «قراءة فقط — فعّل الدفاتر»؛ دفاتر بلا ترحيل
 * (صلاحية «ترحيل القيود» غائبة أو مفتاح الإطفاء) ⇒ قراءة فقط لهذا الحساب.
 */
export function statusLine(s: Pick<AiStatus, 'canPost' | 'booksActivated'>): { tone: StatusTone; text: string } {
  if (s.booksActivated && s.canPost) return { tone: 'post', text: 'الدفاتر مفعّلة — يسجّل القيود' };
  if (!s.booksActivated) return { tone: 'read-only', text: 'قراءة فقط — فعّل الدفاتر لتسجيل المصروفات' };
  return { tone: 'read-books', text: 'قراءة فقط — تسجيل القيود غير متاح لحسابك' };
}

/**
 * حالة الخادم بعد تطبيعٍ دفاعي. `canViewLedger`/`warehouseOn` من الخادم حين يرسلهما (قيمةٌ منطقية)، وإلا من `fallback`
 * (صلاحيات الجلسة وعلم الشركة في الواجهة)، وإلا «مسموح» — فلا يُخفى شيءٌ بعلمٍ مجهول.
 */
export function normalizeStatus(
  raw: unknown,
  fallback: Partial<Pick<AiStatus, 'canViewLedger' | 'warehouseOn'>> = {},
): AiStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<Omit<AiStatus, 'docs'>> & { docs?: unknown };
  const mode = d.booksMode;
  return {
    enabled: d.enabled === true,
    canPost: d.canPost === true,
    booksMode: mode === 'MANUAL' || mode === 'LINKED' || mode === 'LEGACY' ? mode : 'NONE',
    booksActivated: d.booksActivated === true,
    canViewLedger: typeof d.canViewLedger === 'boolean' ? d.canViewLedger : (fallback.canViewLedger ?? true),
    warehouseOn: typeof d.warehouseOn === 'boolean' ? d.warehouseOn : (fallback.warehouseOn ?? true),
    currency: typeof d.currency === 'string' && d.currency ? d.currency : 'SAR',
    timezone: typeof d.timezone === 'string' ? d.timezone : '',
    todayLocal: isValidDay(d.todayLocal) ? d.todayLocal : browserToday(),
    companyName: typeof d.companyName === 'string' && d.companyName.trim() ? d.companyName : null,
    docs: normalizeDocsStatus(d.docs, d.canPost === true),
  };
}
