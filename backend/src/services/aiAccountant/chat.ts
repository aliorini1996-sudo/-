/**
 * «المحاسب الذكي AI» — دورة المحادثة: البوابات الخاصة بالنموذج (مفتاح الإطفاء، الإعداد، الحصة اليومية) ثم حلقة الأدوات.
 *
 * - الحلقة نفسها `runAdvisor` (ai-rep/advisor.ts) بحارس الأرقام وحجب البيانات الشخصية، بـ٦ قفزات (تقرير + ترحيل في دورة)
 *   وقالب احتياطي خاص بالمحاسب. النقل `chatCompletion` (ai-rep/llm.ts) بدلو الرموز المشترك للمنصة.
 * - الحصة لكل مدير يومياً عبر ai-rep/usage.ts بمفتاح salesRepId = 'acct:'+adminId (وجلسة المالك 'acct:OWNER:'+id) (عمود نصّي بلا مفتاح أجنبي):
 *   AI_ACCOUNTANT_DAILY_TURNS (افتراضاً ٨٠ دورة) وAI_ACCOUNTANT_DAILY_TOKENS (افتراضاً ١٢٠ ألف رمز) ⇒ 429 AI_ACCOUNTANT_DAILY_LIMIT.
 *   الدورة التي لم تصرف رمزاً (تعذّر النموذج قبل الرد) تُردّ إلى الحصة.
 * - السجلّ سطر console بلا محتوى (الشركة والقفزات والأدوات والحارس والرموز والزمن) — لا يُخزَّن نص المحادثة.
 * - قيدٌ رُحّل ثم تعذّر النموذج بعده: الرد 200 بالقيد وبطاقته (لا خطأ يُخفي قيداً حقيقياً عن صاحبه).
 * - مستندات المحادثة (طلب المالك ١٨ نوفمبر ٢٠٢٦): رسالة المستخدم تحمل docIds (≤ ٣)، فتُحمَّل مستندات النافذة بالشركة
 *   والرافع نفسه بمراجعها D1..Dn (أداة document_facts للقراءة وحدها). نصّ رسالةٍ تحمل مستندات (الرفع أو «سجّل القيد» بمبالغه
 *   ورموزه) لا يدخل حارس المبلغ ونيّة التسجيل أبداً (guardMessagesOf)، ولا أدوات كتابة إن حملت مستنداتٍ إحدى آخر رسالتين
 *   للمستخدم (النافذة التي يقرؤها الحارس) — فلا يرحّل النموذج مبلغ مستندٍ بيده متجاوزاً البطاقة وطبقات تكرارها (D1/D4). وضغطة
 *   «سجّل القيد» ترسل docConfirm فيُرحَّل المستند **بلا نموذج ولا حصة** (documents/post.ts) ويُعاد action DOC_POSTED أو
 *   DOC_REFUSED برفضه. الجسم النصّي وحده {clientRef, messages:[{role,text}]} وردّه كما كانا حرفياً.
 * كل التبعيات قابلة للحقن (النموذج والأدوات والسياق والحصة والمستندات) — مختبَرة بلا شبكة ولا قاعدة.
 */
import { randomUUID } from 'crypto';
import { z } from 'zod';
import prisma from '../../config/database';
import { runAdvisor, type AdvisorResult, type AdvisorError } from '../../ai-rep/advisor';
import { chatCompletion, llmConfig, type LlmConfig, type LlmRequest, type LlmResult, type LlmUsage } from '../../ai-rep/llm';
import { addUsage, refundUsage, reserveUsage, usageToday } from '../../ai-rep/usage';
import { actorRefOf, aiChatEnabled, loadAcctCtx, type AcctCtx, type AcctUser, type AiReport, type PostedMove, type Tool } from './context';
import { accountantSystemPrompt } from './prompt';
import { buildReadTools } from './readTools';
import { buildWriteTools } from './writeTools';
import { DOCS_PER_MESSAGE } from './documents/caps';
import {
  defaultDocViews, docPostText, docsAllowed, executeDocumentPost, type DocPostInput, type DocPostOutcome,
} from './documents/post';
import { loadDocsForCtx, type DocsDb } from './documents/store';
import { ACCT_DOC_TREATMENTS, ACCT_PAID_FROM, type AcctDocConfirm, type AcctDocView } from './documents/types';

export const ACCT_MAX_HOPS = 6;
export const DEFAULT_DAILY_TURNS = 80;
export const DEFAULT_DAILY_TOKENS = 120_000;
/** سقف رموز الرد الواحد (يشمل التفكير) — أصغر من افتراض المندوب ليتّسع دلو Groq لعدّة قفزات */
export const DEFAULT_MAX_TOKENS = 4096;
/** أقصى انتظار لسعة الدلو المشترك قبل كل نداء — القفزة الثانية تنتظر ما صرفته الأولى */
export const DEFAULT_QUEUE_MS = 20_000;

export const RATE_LIMIT_MESSAGE = 'المحاسب مشغول، حاول بعد دقيقة';

/** مفتاح الحصة في ai_usage_daily (salesRepId نصّ بلا علاقة) */
export const usageKeyOf = (adminId: string): string => `acct:${adminId}`;

const intEnv = (raw: string | undefined, def: number, min: number, max: number): number => {
  const s = (raw ?? '').trim();
  const n = Number(s);
  return s !== '' && Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
};
export const dailyTurnsLimit = (env: NodeJS.ProcessEnv = process.env) => intEnv(env.AI_ACCOUNTANT_DAILY_TURNS, DEFAULT_DAILY_TURNS, 0, 100_000);
export const dailyTokensLimit = (env: NodeJS.ProcessEnv = process.env) => intEnv(env.AI_ACCOUNTANT_DAILY_TOKENS, DEFAULT_DAILY_TOKENS, 0, 100_000_000);
export const acctLlmOptions = (env: NodeJS.ProcessEnv = process.env) => ({
  maxTokens: intEnv(env.AI_ACCOUNTANT_MAX_TOKENS, DEFAULT_MAX_TOKENS, 256, 32_768),
  queueMs: intEnv(env.AI_ACCOUNTANT_QUEUE_MS, DEFAULT_QUEUE_MS, 1000, 60_000),
});

// ───────────── الجسم ─────────────

/** ما تُرسله البطاقة مع «سجّل القيد» (AcctDocConfirm) — الأشهر بلا سقف هنا: الأطول من ٢٤ رفضٌ مشروح لا 400 */
export const docConfirmSchema = z.object({
  docId: z.string().uuid(),
  treatment: z.enum(ACCT_DOC_TREATMENTS as unknown as [AcctDocConfirm['treatment'], ...AcctDocConfirm['treatment'][]]),
  accountCode: z.string().trim().min(1).max(32),
  paidFrom: z.enum(ACCT_PAID_FROM as unknown as [AcctDocConfirm['paidFrom'], ...AcctDocConfirm['paidFrom'][]]),
  paidFromAccountCode: z.string().trim().max(32).nullish(),
  months: z.number().int().min(0).max(1200).nullish(),
  date: z.string().trim().max(20).nullish(),
  confirmedNotDuplicate: z.boolean().nullish(),
});

export const chatBodySchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().trim().min(1).max(4000),
    /** مستندات رُفعت (POST /documents) وأُرفقت بهذه الرسالة — للمستخدم وحده، ≤ ٣ */
    docIds: z.array(z.string().uuid()).max(DOCS_PER_MESSAGE).optional(),
  })).min(1).max(12)
    .refine(m => m[m.length - 1].role === 'user', 'آخر رسالة يجب أن تكون طلب المستخدم')
    .refine(m => m.every(x => !x.docIds || x.role === 'user'), 'المستندات تُرفق برسائل المستخدم وحدها'),
  clientRef: z.string().uuid(),
  /** «سجّل القيد» من بطاقة المستند — المستند من مستندات آخر رسالة */
  docConfirm: docConfirmSchema.optional(),
}).refine(
  b => !b.docConfirm || (b.messages[b.messages.length - 1].docIds ?? []).includes(b.docConfirm.docId),
  { message: 'المستند المؤكَّد يجب أن يكون مرفقاً بآخر رسالة', path: ['docConfirm', 'docId'] },
);
export type ChatBody = z.infer<typeof chatBodySchema>;

export interface ChatData {
  text: string;
  guard: string;
  turnId: string | null;
  reports: AiReport[];
  posted: PostedMove[];
  warnings: string[];
  /** مستندات آخر رسالة (بطاقاتها) أو المستند المؤكَّد — حاضرٌ حين يوجد فقط */
  documents?: AcctDocView[];
  /** دورة «سجّل القيد»: رُحّل أو رُفض (بلا نموذج) */
  action?: 'DOC_POSTED' | 'DOC_REFUSED';
  refusal?: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * رسائل المستخدم كما يقرؤها حارس المبلغ ونيّة التسجيل (userTextOf/writeIntentOf): رسالةٌ تحمل مستندات تُعدّ فارغة — نصّها
 * إمّا طلب قراءة أو نصّ «سجّل القيد» المؤلَّف من البطاقة (الإجمالي والضريبة ورمزا الحساب والدفع و«سجّل»)، ولا يصير أيٌّ
 * منهما مبلغاً «كتبه المستخدم» ولا نيّة تسجيلٍ لدورةٍ نصّية تالية. الترتيب والعدد كما هما (الحارس يقرأ آخر رسالتين).
 */
export function guardMessagesOf(messages: readonly { role: string; text: string; docIds?: readonly string[] }[]): string[] {
  return messages.filter((m) => m.role === 'user').map((m) => ((m.docIds ?? []).length ? '' : m.text));
}

/** إحدى آخر رسالتين للمستخدم (نافذة الحارس) تحمل مستندات ⇒ دورة مستند: لا أدوات كتابة */
export function docWindowTurn(messages: readonly { role: string; docIds?: readonly string[] }[]): boolean {
  return messages.filter((m) => m.role === 'user').slice(-2).some((m) => (m.docIds ?? []).length > 0);
}

/** معرّفات مستندات النافذة بترتيب أول ظهور بلا تكرار (رسائل المستخدم وحدها) */
export function windowDocIds(messages: readonly { role: string; docIds?: readonly string[] }[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const id of m.docIds ?? []) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * تاريخ المحادثة للنموذج: رسالة المستخدم التي أرفقت مستندات يُلحق بها مراجعها «[المرفقات: D1، D2]» (نصّ خادم بلا محتوى
 * المستند) ليقرأها بـdocument_facts — المعرّفات نفسها لا تصل النموذج.
 */
export function historyFor(
  messages: readonly { role: 'user' | 'assistant'; text: string; docIds?: readonly string[] }[], docs: readonly AcctDocView[] = [],
): { role: 'user' | 'assistant'; text: string }[] {
  const refOf = new Map(docs.map((d) => [d.id, d.ref]));
  return messages.map((m) => {
    const refs = m.role === 'user' ? (m.docIds ?? []).map((id) => refOf.get(id)).filter((r): r is string => !!r) : [];
    return { role: m.role, text: refs.length ? `${m.text}\n[المرفقات: ${refs.join('، ')}]` : m.text };
  });
}

// ───────────── الحلقة ─────────────

/** الأدوات مصفوفةً ⇒ سجلّ بالاسم كما تأخذه runAdvisor (الأسبق يغلب عند تكرار الاسم) */
export function toolRecord(tools: Tool[]): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const t of tools) {
    const name = t?.spec?.function?.name;
    if (name && !(name in out)) out[name] = t;
  }
  return out;
}

/** أرقام مسموحة سلفاً: اليوم المحلي (السنة والشهر واليوم) والشهر والسنة السابقان — لا يُحسب «اليوم» رقماً مخترعاً */
export function baseAllowedFor(ctx: Pick<AcctCtx, 'todayLocal'>): Set<number> {
  const out = new Set<number>();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ctx.todayLocal);
  if (!m) return out;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (const n of [y, mo, d, y - 1, mo === 1 ? 12 : mo - 1]) out.add(n);
  return out;
}

/** القالب الحتمي للمحاسب: ملخّصات الأدوات كما هي، أو دعوة لإعادة الصياغة */
export function acctFallbackText(summaries: string[]): string {
  if (!summaries.length) return 'لم أتمكن من الإجابة بأرقام موثوقة هذه المرة. اختر أحد الطلبات الجاهزة أو أعد صياغة سؤالك مع الفترة المطلوبة.';
  return summaries.join('\n');
}

/** نصّ ردّ قيدٍ رُحّل ثم تعذّر النموذج: ملخّص كل قيد وكل تقرير من الخادم لا من النموذج */
export function recoveredText(ctx: Pick<AcctCtx, 'posted' | 'reports'>): string {
  const lines = [
    ...ctx.posted.map(p => p.summaryAr),
    ...ctx.reports.map(r => `جهّزت «${r.title}» — تجده في البطاقة أدناه.`),
    'تعذّر إكمال الرد الآن — ما سبق تمّ فعلاً، وحاول سؤالك التالي بعد دقيقة.',
  ];
  return lines.filter(Boolean).join('\n');
}

/** نصّ دورة مستندٍ تعذّر فيها النموذج: البطاقة تعمل بلا نموذج (المراجعة و«سجّل القيد») */
export const DOC_CARD_FALLBACK_TEXT = 'تعذّر شرح المستند الآن — راجع بياناته في البطاقة أدناه، وصحّح ما يلزم ثم اضغط «سجّل القيد».';

export interface TurnArgs {
  ctx: AcctCtx;
  companyName: string;
  messages: { role: 'user' | 'assistant'; text: string; docIds?: string[] }[];
  tools: Tool[];
  llm: (req: LlmRequest) => Promise<LlmResult>;
}

/** دورة واحدة صرفة فوق تبعيات محقونة: التعليمات من السياق، والأدوات تدفع تقاريرها وقيودها إلى ctx */
export async function runAccountantTurn(a: TurnArgs): Promise<AdvisorResult | AdvisorError> {
  const tools = toolRecord(a.tools);
  return runAdvisor({
    system: accountantSystemPrompt(a.ctx, { companyName: a.companyName, toolNames: Object.keys(tools) }),
    history: historyFor(a.messages, a.ctx.documents ?? []),
    baseAllowed: baseAllowedFor(a.ctx),
    tools,
    llm: a.llm,
    maxHops: ACCT_MAX_HOPS,
    fallbackText: acctFallbackText,
    // أرقام الدفاتر السالبة (صافي خسارة، تدفق نقدي سالب، أرصدة دائنة) تُكتب في الرد بلا إشارة
    signless: true,
  });
}

// ───────────── نقطة المحادثة ─────────────

export interface UsageDeps {
  reserve: typeof reserveUsage;
  refund: typeof refundUsage;
  add: typeof addUsage;
  today: (tid: string, key: string) => Promise<{ tokensIn?: number | null; tokensOut?: number | null } | null>;
}

export interface ChatDeps {
  env?: NodeJS.ProcessEnv;
  config?: () => LlmConfig | null;
  complete?: (cfg: LlmConfig, req: LlmRequest) => Promise<LlmResult>;
  loadCtx?: (user: AcctUser, input: { userMessages: string[]; clientRef: string }) => Promise<{ ctx: AcctCtx; companyName: string }>;
  buildTools?: (ctx: AcctCtx) => Tool[];
  usage?: UsageDeps;
  turnId?: () => string;
  log?: (level: 'info' | 'warn', line: string) => void;
  /** مستندات النافذة ⇐ عروضها بمراجع D1..Dn (الشركة والرافع من السياق) — الافتراض store.ts + view */
  loadDocViews?: (ctx: AcctCtx, ids: string[]) => Promise<AcctDocView[]>;
  /** ترحيل المستند من بطاقته (بلا نموذج) — الافتراض executeDocumentPost */
  postDocument?: (ctx: AcctCtx, input: DocPostInput) => Promise<DocPostOutcome>;
}

export interface ChatResponse { status: number; body: Record<string, unknown> }

const defaultUsage: UsageDeps = { reserve: reserveUsage, refund: refundUsage, add: addUsage, today: usageToday };
const defaultLog = (level: 'info' | 'warn', line: string) => { if (level === 'warn') console.warn(line); else console.info(line); };

/** المراجع D1..Dn بترتيب أول ظهور للمستندات المحمَّلة (ما سقط لشركة أخرى أو رافع آخر لا يأخذ مرجعاً) */
export function docRefsOf(ids: readonly string[]): Map<string, string> {
  return new Map(ids.map((id, i) => [id, `D${i + 1}`]));
}

/** الافتراض: صفوف المستندات بالشركة والرافع (loadDocsForCtx) ثم عروضها بدليل الشركة ومراجعها */
async function defaultLoadDocViews(ctx: AcctCtx, ids: string[]): Promise<AcctDocView[]> {
  const db = prisma as unknown as DocsDb;
  const rows = await loadDocsForCtx(db, { tenantId: ctx.tenantId, actorRef: actorRefOf(ctx.adminId, ctx.impersonated), ids });
  return defaultDocViews(db, ctx, rows, docRefsOf(rows.map((r) => r.id)));
}

/**
 * «سجّل القيد» (docConfirm): ترحيل المستند حتمياً بلا نموذج ولا حصة رموز — السياق من الجلسة، والمبالغ من صفّ المستند،
 * والنص من آخر رسالة. الرفض ردٌّ 200 بـaction DOC_REFUSED ورسالته العربية (لا خطأ HTTP: البطاقة تعرضه).
 */
async function documentConfirmTurn(user: AcctUser, body: ChatBody, deps: ChatDeps, log: (level: 'info' | 'warn', line: string) => void): Promise<ChatResponse> {
  const confirm = body.docConfirm as AcctDocConfirm;
  const turnId = (deps.turnId ?? randomUUID)();
  const started = Date.now();
  const last = body.messages[body.messages.length - 1];
  const { ctx } = await (deps.loadCtx ?? ((u, i) => loadAcctCtx(u, i)))(user, {
    userMessages: body.messages.filter(m => m.role === 'user').map(m => m.text),
    clientRef: body.clientRef,
  });
  ctx.docTurn = true;
  const out = await (deps.postDocument ?? ((c, i) => executeDocumentPost(c, i, { env: deps.env ?? process.env })))(ctx, {
    confirm, lastText: last.text, lastDocIds: last.docIds ?? [],
  });
  const ref = docRefsOf(windowDocIds(body.messages)).get(confirm.docId) ?? '';
  let view: AcctDocView | null = out.view ? { ...out.view, ref } : null;
  // تكرارٌ محتمل حُسب تحت القفل: البطاقة تعرضه بزرّ «ليست مكررة — سجّلها»
  if (view && !out.ok && out.refusal.code === 'DOC_POSSIBLE_DUPLICATE') {
    const d = out.refusal.details ?? {};
    const reason = d.reason === 'INVOICE_NO' ? 'INVOICE_NO' : 'SOFT';
    view = { ...view, duplicateOf: { moveNumber: typeof d.move_number === 'string' ? d.move_number : null, reason } };
  }
  const data: ChatData = {
    text: docPostText(out),
    guard: 'TEMPLATE',
    turnId,
    reports: [],
    posted: out.ok ? [out.move] : [],
    warnings: out.ok ? ctx.warnings : [],
    documents: view ? [view] : [],
    action: out.ok ? 'DOC_POSTED' : 'DOC_REFUSED',
    ...(out.ok ? {} : { refusal: { code: out.refusal.code, message: out.refusal.message, ...(out.refusal.details ? { details: out.refusal.details } : {}) } }),
  };
  // سجلّ بلا محتوى: الشركة والدورة والنتيجة ورمز الرفض والزمن
  log('info', `[ai-accountant] مستند ${JSON.stringify({ tenant: ctx.tenantId, turnId, action: data.action, ...(out.ok ? { replayed: out.replayed } : { code: out.refusal.code }), ms: Date.now() - started })}`);
  return { status: 200, body: { success: true, data } };
}

/** أدوات الدورة: القراءة ثم الكتابة (الكتابة [] ما لم يُسمح بالترحيل — قرار writeTools.ts) */
export function defaultBuildTools(ctx: AcctCtx): Tool[] {
  return [...buildReadTools(ctx), ...buildWriteTools(ctx)];
}

const fail = (status: number, code: string, message: string): ChatResponse => ({ status, body: { success: false, code, message } });

/**
 * POST /api/ai-accountant/chat بعد حرّاس الموجّه. جسمٌ غير صالح يرمي ZodError (المسار يمرّره لمعالج الأخطاء ⇒ 400).
 * الترتيب: مفتاح الإطفاء ⇒ إعداد النموذج ⇒ الجسم ⇒ [docConfirm ⇒ ترحيل المستند بلا نموذج ولا حصة] ⇒ حدّ الرموز اليومي ⇒
 * حجز الدورة ⇒ السياق والمستندات والأدوات ⇒ الحلقة.
 */
export async function accountantChat(user: AcctUser, rawBody: unknown, deps: ChatDeps = {}): Promise<ChatResponse> {
  const env = deps.env ?? process.env;
  if (!aiChatEnabled(env)) return fail(503, 'AI_ACCOUNTANT_OFF', 'المحاسب الذكي متوقف مؤقتاً لدى المنصة — صفحات التقارير والدفاتر تعمل كالمعتاد');
  const cfg = (deps.config ?? (() => llmConfig(env)))();
  if (!cfg) return fail(503, 'AI_LLM_NOT_CONFIGURED', 'المحاسب الذكي لم يُفعَّل بعد لدى المنصة — صفحات التقارير والدفاتر تعمل كالمعتاد');
  const body = chatBodySchema.parse(rawBody);
  const log = deps.log ?? defaultLog;
  // «سجّل القيد» من بطاقة المستند: ترحيلٌ حتمي بلا أي نداء نموذج (D1)
  if (body.docConfirm) return documentConfirmTurn(user, body, deps, log);
  const tid = String(user.tenantId ?? '');
  // جلسة المالك بحصّتها لا بحصة مدير الشركة الذي دخل باسمه (OWNER:<id> كـactorOf)
  const key = usageKeyOf(actorRefOf(user.id, user.impersonated));
  const usage = deps.usage ?? defaultUsage;

  const turnsLimit = dailyTurnsLimit(env);
  const tokensLimit = dailyTokensLimit(env);
  const limitMsg = `بلغت حدّ المحاسب الذكي اليومي — صفحات التقارير والدفاتر تعمل كالمعتاد، ويتجدّد الحدّ غداً`;
  const today = await usage.today(tid, key);
  if ((Number(today?.tokensIn) || 0) + (Number(today?.tokensOut) || 0) >= tokensLimit) {
    return { status: 429, body: { success: false, code: 'AI_ACCOUNTANT_DAILY_LIMIT', message: limitMsg, limit: turnsLimit } };
  }
  const day = await usage.reserve(tid, key, 'chatTurns', turnsLimit);
  if (!day) return { status: 429, body: { success: false, code: 'AI_ACCOUNTANT_DAILY_LIMIT', message: limitMsg, limit: turnsLimit } };

  const turnId = (deps.turnId ?? randomUUID)();
  const started = Date.now();
  let ctx: AcctCtx;
  let result: AdvisorResult | AdvisorError;
  // مستندات آخر رسالة (بطاقاتها في الرد) — من المحمَّل فعلاً بالشركة والرافع
  let lastDocs: AcctDocView[] = [];
  try {
    const loaded = await (deps.loadCtx ?? ((u, i) => loadAcctCtx(u, i)))(user, {
      // نصوص رسائل المستندات خارج حارس المبلغ ونيّة التسجيل (guardMessagesOf)
      userMessages: guardMessagesOf(body.messages),
      clientRef: body.clientRef,
    });
    ctx = loaded.ctx;
    const companyName = loaded.companyName;
    const docIds = windowDocIds(body.messages);
    const lastIds = body.messages[body.messages.length - 1].docIds ?? [];
    // مستندٌ في نافذة الحارس (آخر رسالتين) ⇒ لا أدوات كتابة (الترحيل من البطاقة وحدها) ولو تعذّر تحميله
    if (lastIds.length || docWindowTurn(body.messages)) ctx.docTurn = true;
    if (docIds.length) {
      // حرّاس المحادثة اجتيزت أعلاه (المفتاح والنموذج المُعدّ) — chatReady
      if (!docsAllowed(ctx, env, true)) {
        ctx.warnings.push('قراءة المستندات المرفقة وترحيلها غير متاحة الآن لحسابك أو لدى المنصة.');
      } else {
        try {
          const views = await (deps.loadDocViews ?? defaultLoadDocViews)(ctx, docIds);
          if (views.length) ctx.documents = views;
          lastDocs = views.filter((v) => lastIds.includes(v.id));
        } catch {
          ctx.warnings.push('تعذّر تحميل المستندات المرفقة الآن — أعد المحاولة بعد قليل.');
        }
      }
    }
    const tools = (deps.buildTools ?? defaultBuildTools)(ctx);
    const opts = acctLlmOptions(env);
    const complete = deps.complete ?? ((c: LlmConfig, r: LlmRequest) => chatCompletion(c, r));
    result = await runAccountantTurn({
      ctx, companyName, messages: body.messages, tools,
      // إعادة الرد المبتور (runAdvisor) تمرّر سقفها الأعلى — يُحترم؛ وإلا سقف المحاسب وتفكير متوسط
      llm: r => complete(cfg, { ...r, maxTokens: r.maxTokens ?? opts.maxTokens, queueMs: r.queueMs ?? opts.queueMs, reasoningEffort: r.reasoningEffort ?? 'medium' }),
    });
  } catch (err) {
    await usage.refund(tid, key, 'chatTurns', 1, day).catch(() => undefined);
    throw err;
  }

  const u: LlmUsage = result.usage;
  const spent = u.promptTokens + u.completionTokens;
  await usage.add(tid, key, {
    tokensIn: u.promptTokens, tokensOut: u.completionTokens,
    guardRegen: 'guard' in result && result.guard === 'REGEN' ? 1 : 0,
    guardFallback: 'guard' in result && (result.guard === 'TRIM' || result.guard === 'TEMPLATE') ? 1 : 0,
  }).catch(() => undefined);

  const meta = {
    tenant: tid, turnId, posted: ctx.posted.length, reports: ctx.reports.length,
    tin: u.promptTokens, tout: u.completionTokens, cached: u.cachedTokens, ms: Date.now() - started,
  };
  if ('error' in result) {
    // دورة لم تصرف رمزاً لا تُحتسب على الحصة
    if (spent === 0) await usage.refund(tid, key, 'chatTurns', 1, day).catch(() => undefined);
    log('warn', `[ai-accountant] تعذّر النموذج ${JSON.stringify({ ...meta, code: result.code })}`);
    // قيدٌ رُحّل فعلاً (أو تقرير جُهّز) قبل التعذّر: يُعاد بطاقاته — لا خطأ يُخفي قيداً حقيقياً؛ وبطاقة المستند تعمل بلا نموذج
    if (ctx.posted.length || ctx.reports.length || lastDocs.length) {
      const text = ctx.posted.length || ctx.reports.length ? recoveredText(ctx) : DOC_CARD_FALLBACK_TEXT;
      const data: ChatData = {
        text, guard: 'TEMPLATE', turnId, reports: ctx.reports, posted: ctx.posted, warnings: ctx.warnings,
        ...(lastDocs.length ? { documents: lastDocs } : {}),
      };
      return { status: 200, body: { success: true, data } };
    }
    if (result.code === 'LLM_RATE_LIMIT') return fail(429, 'AI_LLM_RATE_LIMIT', RATE_LIMIT_MESSAGE);
    return fail(503, 'AI_' + result.code, 'المحاسب الذكي غير متاح مؤقتاً — حاول بعد قليل');
  }
  // سجلّ بلا محتوى محادثة
  log('info', `[ai-accountant] دورة ${JSON.stringify({ ...meta, hops: result.hops, tools: result.toolNames, toolErrors: result.toolErrors, guard: result.guard })}`);
  const data: ChatData = {
    text: result.text, guard: result.guard, turnId, reports: ctx.reports, posted: ctx.posted, warnings: ctx.warnings,
    // بطاقات مستندات آخر رسالة — المفتاح غائب في الدورة النصّية (الشكل القائم حرفياً)
    ...(lastDocs.length ? { documents: lastDocs } : {}),
  };
  return { status: 200, body: { success: true, data } };
}
