/**
 * «المحاسب الذكي AI» — أدوات الكتابة (الحزمة B، المواصفة §3.4): post_expense وpost_salaries وsettle_payable.
 *
 * تُتاح للنموذج فقط حين: الترحيل مسموح للمستخدم (ctx.canPost = النظام المتكامل + دفاتر مفعّلة + «ترحيل القيود»)،
 * والدفاتر مفعّلة، ومفتاح البيئة AI_ACCOUNTANT_WRITE ≠ 0، والمستخدم يطلب تسجيل شيء (ctx.writeIntent) — وإلا []
 * (القراءة تبقى؛ دورة التقرير البحت لا تُرحّل شيئاً ولو حقنت نصوصُ الأدوات أمراً). وكل تنفيذٍ يعيد فحص البوابات من القاعدة
 * (الشركة: النظام المتكامل والمحاسب الذكي، والدفاتر: activatedAt، والمستخدم: canPostJournals) — لا ثقة بسياق بداية الدورة وحده.
 *
 * ترتيب التنفيذ: البوابة الثابتة ⇒ وسائط النموذج (zod) ⇒ **حارس المبلغ** (كل مبلغ حرفياً في رسالة المستخدم) ⇒ التاريخ ⇒
 * بوابات القاعدة ⇒ prisma.$transaction(executeAiPost, POST_TX_OPTIONS) كمسار POST /api/ledger/clearing.
 * tenantId والمستخدم من السياق وحده — لا وسيط للشركة في أي أداة (عزل الشركات وحقن التعليمات).
 * الرفض نتيجةُ أداة «لم يُرحَّل» برسالة عربية تُشرح للمستخدم (أرقامها مسموحة للحارس) — لا مبلغ متوهَّم يُعاد فيها.
 */
import { z } from 'zod';
import prisma from '../../config/database';
import type { ToolOutput } from '../../ai-rep/advisor';
import { actorRefOf, aiWriteEnabled, writeIntentIn, type AcctCtx, type PostedMove, type Tool } from './context';
import { ledgerActor } from '../gl/audit';
import { POST_TX_OPTIONS } from '../gl/autoPost';
import { endOfMonth } from '../gl/dates';
import { ledgerPermissionDecision, type LedgerAdminRow } from '../gl/permissions';
import type { GlDb, LedgerContext } from '../gl/resolve';
import type { Milli } from '../gl/types';
import {
  DEFAULT_AI_POST_DEPS, DUPLICATE_WINDOW_MS, EXPENSE_CATEGORY_KEYS, SETTLE_PAYABLE_KEYS,
  amountInUserText, buildExpensePlan, buildSalariesPlan, buildSettlePlan, executeAiPost, listAiPostsWith, normalizeAmountText, parseAmountArg,
  postingDateProblem, refusalFromError, resolveSalaryMonth, vatOnTopProblem,
  type AiPostDeps, type AiPostResult, type AiRefusal, type AiPostsListDb, type PlanEnv, type PlanOutcome, type ResolvedMonth,
} from './posting';

export const AI_WRITE_TOOL_NAMES = ['post_expense', 'post_salaries', 'settle_payable'] as const;

// ═══ التبعيات (قابلة للحقن في الاختبار) ═══

/** أدنى شكل لعميل بوابات القاعدة (PrismaClient والمزيّف) */
export interface WriteGateDb {
  tenant: { findUnique(args: unknown): Promise<{ accountingEnabled?: boolean | null; accountingSuiteEnabled?: boolean | null; aiAccountantEnabled?: boolean | null } | null> };
  glSettings: { findUnique(args: unknown): Promise<{ activatedAt: Date | null } | null> };
  admin: { findUnique(args: unknown): Promise<LedgerAdminRow | null> };
}

export interface WriteToolDeps {
  env: NodeJS.ProcessEnv;
  gateDb: WriteGateDb;
  /** المعاملة: prisma.$transaction(fn, POST_TX_OPTIONS) */
  runTx<T>(fn: (tx: GlDb) => Promise<T>): Promise<T>;
  post: AiPostDeps;
  now(): Date;
  log(line: string): void;
}

const defaultRunTx = <T>(fn: (tx: GlDb) => Promise<T>): Promise<T> =>
  prisma.$transaction((tx) => fn(tx as GlDb), POST_TX_OPTIONS);

function depsOf(over: Partial<WriteToolDeps>): WriteToolDeps {
  return {
    env: over.env ?? process.env,
    gateDb: over.gateDb ?? (prisma as unknown as WriteGateDb),
    runTx: over.runTx ?? defaultRunTx,
    post: over.post ?? DEFAULT_AI_POST_DEPS,
    now: over.now ?? (() => new Date()),
    log: over.log ?? ((line: string) => console.warn(line)),
  };
}

// ═══ البوابات ═══

/** البوابة الثابتة من السياق والبيئة — تقرّر إتاحة الأدوات أصلاً */
export function writeToolsAllowed(ctx: Pick<AcctCtx, 'canPost' | 'booksActivated' | 'accountingOn'>, env: NodeJS.ProcessEnv = process.env): boolean {
  return aiWriteEnabled(env) && ctx.canPost === true && ctx.booksActivated === true && ctx.accountingOn !== false;
}

function staticGateRefusal(ctx: AcctCtx, env: NodeJS.ProcessEnv): AiRefusal | null {
  if (!aiWriteEnabled(env)) return { code: 'WRITE_DISABLED', message: 'الترحيل متوقف مؤقتاً لدى المنصة — القراءة والتقارير تعمل كالمعتاد.' };
  if (ctx.accountingOn === false || ctx.booksActivated !== true) return { code: 'NOT_ACTIVATED', message: 'الترحيل يحتاج دفاتر مفعّلة لهذه الشركة.' };
  if (ctx.canPost !== true) return { code: 'NOT_ALLOWED', message: 'الترحيل يحتاج صلاحية «ترحيل القيود» في الدفاتر.' };
  if (!ctx.clientRef) return { code: 'CLIENT_REF_MISSING', message: 'تعذّر تمييز الطلب؛ أعد الإرسال من الصفحة.' };
  return null;
}

/**
 * إعادة فحص البوابات من القاعدة عند التنفيذ (كسلسلة /api/ledger): النظام المتكامل مفعّل والنظام المحاسبي غير مطفأ،
 * والمحاسب الذكي مفعّل للشركة، والدفاتر مفعّلة (activatedAt)، و«ترحيل القيود» للمستخدم (جلسة المالك تمرّ كما في
 * requireLedgerPermission). null ⇒ مسموح.
 */
export async function writeGateRefusal(db: WriteGateDb, ctx: Pick<AcctCtx, 'tenantId' | 'adminId' | 'impersonated'>): Promise<AiRefusal | null> {
  const tid = ctx.tenantId;
  if (!tid) return { code: 'NOT_ALLOWED', message: 'لا توجد شركة مرتبطة بالحساب.' };
  const [tenant, settings, admin] = await Promise.all([
    db.tenant.findUnique({ where: { id: tid }, select: { accountingEnabled: true, accountingSuiteEnabled: true, aiAccountantEnabled: true } }),
    db.glSettings.findUnique({ where: { tenantId: tid }, select: { activatedAt: true } }),
    ctx.impersonated
      ? Promise.resolve(null)
      : db.admin.findUnique({
        where: { id: ctx.adminId },
        select: {
          isActive: true, tenantId: true, role: true, canManageCompanyUsers: true, scopeEnabled: true,
          canViewLedger: true, canPostJournals: true, canManagePayables: true, canManageBank: true,
          canCloseLedgerPeriods: true, canConfigureLedger: true,
        },
      }),
  ]);
  if (tenant?.accountingSuiteEnabled !== true || tenant?.accountingEnabled === false) {
    return { code: 'NOT_ACTIVATED', message: 'النظام المحاسبي المتكامل غير مفعّل لهذه الشركة.' };
  }
  if (tenant?.aiAccountantEnabled !== true) return { code: 'NOT_ALLOWED', message: 'المحاسب الذكي غير مفعّل لهذه الشركة.' };
  if (!settings?.activatedAt) return { code: 'NOT_ACTIVATED', message: 'الدفاتر غير مفعّلة لهذه الشركة بعد.' };
  if (!ctx.impersonated && ledgerPermissionDecision(admin, 'canPostJournals', tid) !== 'ALLOW') {
    return { code: 'NOT_ALLOWED', message: 'الترحيل يحتاج صلاحية «ترحيل القيود» في الدفاتر.' };
  }
  return null;
}

// ═══ الوسائط ═══

const amountArg = z.union([z.number(), z.string().trim().min(1).max(40)]);
const optText = (max: number) => z.string().trim().max(max).nullish();

export const expenseArgsSchema = z.object({
  amount: amountArg,
  category: z.enum(EXPENSE_CATEGORY_KEYS).nullish(),
  accountCode: optText(32),
  paidFrom: z.enum(['cash', 'petty_cash', 'bank', 'payable']),
  paidFromAccountCode: optText(32),
  vat: z.object({
    included: z.boolean(),
    rate: z.number().min(0).max(100).nullish(),
    amount: amountArg.nullish(),
  }).nullish(),
  date: optText(20),
  description: z.string().trim().min(1).max(300),
  vendorName: optText(160),
}).refine((a) => !!a.category || !!a.accountCode, { message: 'category or accountCode is required' });

export const salariesArgsSchema = z.object({
  month: z.union([z.string().trim().min(1).max(10), z.number().int()]),
  amount: amountArg,
  group: z.enum(['reps', 'admin']),
  paidFrom: z.enum(['cash', 'bank', 'accrue']),
  paidFromAccountCode: optText(32),
  gosi: amountArg.nullish(),
  date: optText(20),
  confirmedNotAccrued: z.boolean().nullish(),
});

export const settleArgsSchema = z.object({
  amount: amountArg,
  payable: z.enum(SETTLE_PAYABLE_KEYS),
  paidFrom: z.enum(['cash', 'bank']),
  paidFromAccountCode: optText(32),
  month: z.union([z.string().trim().min(1).max(10), z.number().int()]).nullish(),
  description: optText(160),
  date: optText(20),
});

/** خطأ وسائط ⇐ نصّ قصير للنموذج يصحّح به الاستدعاء (لا رسالة للمستخدم) */
function argsError(e: z.ZodError): { error: string } {
  const first = e.issues[0];
  return { error: `invalid arguments: ${first ? `${first.path.join('.') || 'args'} — ${first.message}` : 'bad shape'}` };
}

// ═══ المخرجات ═══

/** رفضٌ ⇐ نتيجة أداة «لم يُرحَّل» (رسالة تُشرح للمستخدم + تفاصيل آمنة) */
export function refusalOutput(r: AiRefusal): ToolOutput {
  return {
    data: { posted: false, reason: r.code, message: r.message, ...(r.details ?? {}) },
    summaryAr: `لم يُرحَّل شيء: ${r.message}`,
  };
}

/** نجاحٌ ⇐ ما يراه النموذج (رقم القيد وسطوره بأرقام) */
export function successOutput(res: AiPostResult, currency: string): ToolOutput {
  const m = res.move;
  const head = res.replayed ? `سبق ترحيل هذا الطلب بالقيد ${m.moveNumber ?? ''}` : `رُحّل القيد ${m.moveNumber ?? ''}`;
  return {
    data: {
      posted: true,
      ...(res.replayed ? { already_posted: true } : {}),
      ...(m.reversed ? { reversed: true } : {}),
      kind: m.kind,
      move_number: m.moveNumber,
      date: m.date,
      amount: m.amount,
      currency,
      entry_lines: m.lines.map((l) => ({ account: `${l.accountCode} ${l.accountName}`.trim(), debit: l.debit, credit: l.credit })),
      summary: m.summaryAr,
      ref: m.ref,
      note: 'رُحّل مباشرة وتظهر للمستخدم بطاقة القيد بزر «عكس القيد».',
    },
    summaryAr: `${head}: ${m.summaryAr}`,
  };
}

// ═══ التنفيذ المشترك ═══

interface Prepared {
  /** المبالغ التي مرّرها النموذج مع اسمها العربي — كلٌّ منها يجب أن يرد في رسالة المستخدم */
  amounts: { milli: Milli; what: string }[];
  date: string;
  build(env: PlanEnv): PlanOutcome;
}

/** حارس المبلغ: أول مبلغ لا يرد حرفياً في رسالة المستخدم ⇒ رفض (بلا ذكر المبلغ المرفوض) */
export function amountGuardRefusal(amounts: readonly { milli: Milli; what: string }[], userText: string): AiRefusal | null {
  for (const a of amounts) {
    if (!amountInUserText(a.milli, userText)) {
      return {
        code: 'AMOUNT_NOT_IN_MESSAGE',
        message: `${a.what} غير مكتوب بالأرقام في رسالة المستخدم. اطلب منه كتابة المبلغ بالأرقام كما يريد تسجيله.`,
        details: { field: a.what },
      };
    }
  }
  return null;
}

async function execute(ctx: AcctCtx, d: WriteToolDeps, prep: Prepared): Promise<ToolOutput> {
  const guard = amountGuardRefusal(prep.amounts, ctx.userText);
  if (guard) return refusalOutput(guard);
  const dateProblem = postingDateProblem(prep.date, ctx.todayLocal);
  if (dateProblem) return refusalOutput(dateProblem);
  try {
    const gate = await writeGateRefusal(d.gateDb, ctx);
    if (gate) return refusalOutput(gate);
    const actor = ledgerActor(
      { actorId: ctx.adminId, impersonated: ctx.impersonated },
      { actorName: `المحاسب الذكي بطلب ${ctx.adminName || ''}`.trim(), requestIp: ctx.requestIp ?? null },
    );
    // صاحب الطلب في صفّ القيد كـactorOf: جلسة المالك OWNER:<id> لا معرّف مدير الشركة الذي دخل باسمه
    const actorRef = actorRefOf(ctx.adminId, ctx.impersonated);
    const now = d.now();
    // مبلغٌ لم يرد في آخر رسالة جاء من سابقتها: لا يُكرَّر به قيدٌ مطابق رحّله الفاعل نفسه بطلبٍ آخر
    const latest = ctx.latestUserText ?? ctx.userText;
    const fromPrevious = prep.amounts.some((a) => !amountInUserText(a.milli, latest));
    const res = await d.runTx((tx) => executeAiPost(tx, {
      tenantId: ctx.tenantId,
      actor,
      adminId: actorRef,
      adminName: ctx.adminName,
      clientRef: ctx.clientRef,
      usedRefs: ctx.posted.map((p) => p.ref),
      build: (lc: LedgerContext) => prep.build({ lc, booksMode: ctx.booksMode, currency: ctx.currency, taxDisabled: ctx.taxDisabled }),
      now,
      ...(fromPrevious ? { duplicateGuard: { adminId: actorRef, since: new Date(now.getTime() - DUPLICATE_WINDOW_MS) } } : {}),
    }, d.post));
    if (!ctx.posted.some((p: PostedMove) => p.id === res.move.id)) ctx.posted.push(res.move);
    for (const w of res.warnings) if (!ctx.warnings.includes(w)) ctx.warnings.push(w);
    return successOutput(res, ctx.currency);
  } catch (e) {
    const r = refusalFromError(e);
    if (r.code === 'POST_FAILED' || r.code === 'LEDGER_ERROR') {
      const code = (e as { code?: unknown })?.code;
      d.log(`[ai-accountant] تعذّر الترحيل ${JSON.stringify({ tenant: ctx.tenantId, code: typeof code === 'string' ? code : (e as Error)?.name ?? 'ERROR' })}`);
    }
    return refusalOutput(r);
  }
}

const isRefusal = (v: unknown): v is AiRefusal =>
  !!v && typeof v === 'object' && typeof (v as AiRefusal).code === 'string' && typeof (v as AiRefusal).message === 'string';

const AMOUNT_INVALID = (what: string): AiRefusal => ({ code: 'AMOUNT_INVALID', message: `${what} غير صالح: اكتبه رقماً موجباً.`, details: { field: what } });

/** وسيط اختياري فارغ أو صفر (ضريبة/تأمينات «0») ⇒ كأنه لم يُذكر */
const isAbsentAmount = (v: unknown): boolean =>
  v === null || v === undefined || /^0*(?:\.0*)?$/.test(normalizeAmountText(String(v).trim()));

/** تاريخ النموذج بأرقام هندية ⇒ لاتينية؛ الغائب ⇒ null (اليوم أو تاريخ الاستحقاق) */
const dateArgOf = (v: string | null | undefined): string | null => (v ? normalizeAmountText(v.trim()) : null);

// ═══ الأدوات ═══

const CATEGORY_HELP = 'rent=إيجار، utilities=كهرباء وماء، telecom=جوال وإنترنت، fuel=بنزين ووقود، vehicle_maintenance=صيانة السيارات، '
  + 'vehicle_insurance=تأمين السيارات والاستمارة، advertising=دعاية وإعلان، bank_fees=رسوم بنكية، samples_gifts=عينات وهدايا، '
  + 'delivery=توصيل وشحن، commissions=عمولات المبيعات، staff_housing=سكن العمال، software=اشتراكات برامج، office_supplies=قرطاسية وطباعة، '
  + 'maintenance=صيانة وإصلاح، cleaning=نظافة، hospitality=ضيافة، government_fees=رسوم حكومية وتراخيص، professional_fees=أتعاب ومحاسب قانوني، '
  + 'medical_insurance=تأمين طبي، bonuses=مكافآت، outsourced=خدمات خارجية وعمالة مؤقتة، misc=مصروفات متنوعة';

const AMOUNT_RULE = 'Copy the number exactly as the user wrote it in digits — the server refuses any amount not written in the user’s message.';

function expenseTool(ctx: AcctCtx, d: WriteToolDeps): Tool {
  return {
    spec: {
      type: 'function',
      function: {
        name: 'post_expense',
        description: 'Post ONE company expense directly to the books (no draft): Dr expense account / Cr main cash, petty cash, bank, or accrued expenses. '
          + 'Use only when the user explicitly asks to record an expense, wrote the amount in digits, and the payment source is known — otherwise ask one short question first. '
          + 'The server picks the accounts from the company chart. Include `vat` ONLY if the user said VAT applies. '
          + 'Never use it for salaries (use post_salaries), stock purchases, depreciation, zakat or provisions. '
          + 'Never use it to pay an amount previously recorded as payable/accrued (آجل، مستحق) or to pay social insurance (GOSI, التأمينات) that was accrued with salaries — use settle_payable. '
          + 'Never use it for an expense a sales rep or user paid from his own custody (عهدة) — that is recorded from custody expenses, not here; apologise and explain. '
          + 'If the result has posted=false, explain its message to the user and stop — do not retry with another amount or account.',
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: `The expense amount. ${AMOUNT_RULE}` },
            category: { type: 'string', enum: [...EXPENSE_CATEGORY_KEYS], description: CATEGORY_HELP },
            accountCode: { type: 'string', description: 'Expense account code from the company chart — only if the user named it or picked it from a list you showed.' },
            paidFrom: {
              type: 'string', enum: ['cash', 'petty_cash', 'bank', 'payable'],
              description: 'cash=نقداً من الصندوق، petty_cash=من صندوق النثريات للشركة، bank=تحويل أو بطاقة من البنك، payable=لم يُدفع بعد (آجل). '
                + 'Not for an expense paid by a rep/user from his custody (عهدة المندوب) — refuse that instead of using petty_cash.',
            },
            paidFromAccountCode: { type: 'string', description: 'Cash/bank account code — only if the user named a specific box or bank account.' },
            vat: {
              type: 'object',
              description: 'Only when the user said VAT applies.',
              properties: {
                included: {
                  type: 'boolean',
                  description: 'true if the amount already includes VAT (شامل الضريبة) — use true when unsure. false ONLY if the user said the amount is before VAT '
                    + '(قبل الضريبة / + الضريبة) or wrote the VAT-inclusive total too; otherwise the server refuses and you must ask.',
                },
                rate: { type: 'number', description: 'VAT percent only if the user stated it.' },
                amount: { type: 'number', description: `VAT amount only if the user wrote it. ${AMOUNT_RULE}` },
              },
              required: ['included'],
              additionalProperties: false,
            },
            date: { type: 'string', description: 'YYYY-MM-DD only if the user gave a date; omit for today.' },
            description: { type: 'string', description: 'Short Arabic description, e.g. «إيجار المستودع لشهر نوفمبر».' },
            vendorName: { type: 'string', description: 'Payee name if the user mentioned it.' },
          },
          required: ['amount', 'paidFrom', 'description'],
          additionalProperties: false,
        },
      },
    },
    async run(args): Promise<ToolOutput | { error: string }> {
      const gate = staticGateRefusal(ctx, d.env);
      if (gate) return refusalOutput(gate);
      const p = expenseArgsSchema.safeParse(args);
      if (!p.success) return argsError(p.error);
      const a = p.data;
      const amount = parseAmountArg(a.amount);
      if (amount === null) return refusalOutput(AMOUNT_INVALID('مبلغ المصروف'));
      const amounts = [{ milli: amount, what: 'مبلغ المصروف' }];
      let vatAmount: Milli | null = null;
      if (a.vat && !isAbsentAmount(a.vat.amount)) {
        vatAmount = parseAmountArg(a.vat.amount ?? null);
        if (vatAmount === null) return refusalOutput(AMOUNT_INVALID('مبلغ الضريبة'));
        amounts.push({ milli: vatAmount, what: 'مبلغ الضريبة' });
      }
      const date = dateArgOf(a.date) ?? ctx.todayLocal;
      return execute(ctx, d, {
        amounts,
        date,
        build: (env) => {
          const out = buildExpensePlan(env, {
            amountMilli: amount,
            category: a.category ?? null,
            accountCode: a.accountCode ?? null,
            paidFrom: a.paidFrom,
            paidFromAccountCode: a.paidFromAccountCode ?? null,
            vat: a.vat ? { included: a.vat.included, rate: a.vat.rate ?? null, amountMilli: vatAmount } : null,
            date,
            description: a.description,
            vendorName: a.vendorName ?? null,
          });
          // الضريبة فوق المبلغ بلا مبلغ ضريبة صريح: دائن النقد = المبلغ + ضريبته — رقمٌ يجب أن يكتبه المستخدم أو يقول «قبل الضريبة»
          if (!out.ok || !a.vat || a.vat.included !== false || vatAmount !== null) return out;
          const problem = vatOnTopProblem(ctx.userText, amount, out.plan.totalMilli);
          return problem ? { ok: false, refusal: problem } : out;
        },
      });
    },
  };
}

/** تاريخ قيد الرواتب: المذكور، وإلا اليوم — والاستحقاق لشهر مضى آخرَ يومٍ فيه (الاستحقاق في فترته) */
export function salariesDate(month: ResolvedMonth, paidFrom: 'cash' | 'bank' | 'accrue', given: string | null | undefined, todayLocal: string): string {
  if (given) return given;
  if (paidFrom === 'accrue' && month.ym < todayLocal.slice(0, 7)) return endOfMonth(month.firstDay);
  return todayLocal;
}

function salariesTool(ctx: AcctCtx, d: WriteToolDeps): Tool {
  return {
    spec: {
      type: 'function',
      function: {
        name: 'post_salaries',
        description: 'Post one month’s salaries directly to the books: Dr sales-rep salaries (group=reps) or administrative salaries (group=admin) '
          + '/ Cr cash or bank when paid now, or Cr Salaries Payable when accrued (paidFrom=accrue). Optional `gosi` = the company’s social-insurance share '
          + 'for the month (Dr social insurance expense / Cr social insurance payable). Use only when the user explicitly asks and wrote the amount in digits; '
          + 'ask for the month, group or payment if missing. Paying salaries that were already recorded as accrued is NOT a new salary expense — use settle_payable (payable=salaries). '
          + 'If posted=false, explain the message and stop.',
        parameters: {
          type: 'object',
          properties: {
            month: { type: 'string', description: 'Salary month as YYYY-MM (or MM for the latest such month).' },
            amount: { type: 'number', description: `Total salaries for the group. ${AMOUNT_RULE}` },
            group: { type: 'string', enum: ['reps', 'admin'], description: 'reps=رواتب المناديب والسائقين، admin=رواتب الموظفين الإداريين' },
            paidFrom: { type: 'string', enum: ['cash', 'bank', 'accrue'], description: 'cash=صُرفت نقداً، bank=تحويل بنكي، accrue=مستحقة لم تُصرف بعد' },
            paidFromAccountCode: { type: 'string', description: 'Cash/bank account code — only if the user named a specific box or bank account.' },
            gosi: { type: 'number', description: `Company social insurance (GOSI) share — only if the user wrote it. ${AMOUNT_RULE}` },
            date: { type: 'string', description: 'YYYY-MM-DD only if the user gave a posting date.' },
            confirmedNotAccrued: {
              type: 'boolean',
              description: 'Set true ONLY after a previous call was refused with SALARIES_ALREADY_ACCRUED and the user then confirmed these salaries were never recorded as accrued before.',
            },
          },
          required: ['month', 'amount', 'group', 'paidFrom'],
          additionalProperties: false,
        },
      },
    },
    async run(args): Promise<ToolOutput | { error: string }> {
      const gate = staticGateRefusal(ctx, d.env);
      if (gate) return refusalOutput(gate);
      const p = salariesArgsSchema.safeParse(args);
      if (!p.success) return argsError(p.error);
      const a = p.data;
      const amount = parseAmountArg(a.amount);
      if (amount === null) return refusalOutput(AMOUNT_INVALID('مبلغ الرواتب'));
      const amounts = [{ milli: amount, what: 'مبلغ الرواتب' }];
      let gosi: Milli | null = null;
      if (!isAbsentAmount(a.gosi)) {
        gosi = parseAmountArg(a.gosi ?? null);
        if (gosi === null) return refusalOutput(AMOUNT_INVALID('مبلغ التأمينات'));
        amounts.push({ milli: gosi, what: 'مبلغ التأمينات' });
      }
      const month = resolveSalaryMonth(a.month, ctx.todayLocal);
      if (isRefusal(month)) return refusalOutput(month);
      const date = salariesDate(month, a.paidFrom, dateArgOf(a.date), ctx.todayLocal);
      return execute(ctx, d, {
        amounts,
        date,
        build: (env) => buildSalariesPlan(env, {
          month, amountMilli: amount, group: a.group, paidFrom: a.paidFrom, paidFromAccountCode: a.paidFromAccountCode ?? null,
          gosiMilli: gosi, date, confirmedNotAccrued: a.confirmedNotAccrued === true,
        }),
      });
    },
  };
}

function settleTool(ctx: AcctCtx, d: WriteToolDeps): Tool {
  return {
    spec: {
      type: 'function',
      function: {
        name: 'settle_payable',
        description: 'Pay an amount that was previously recorded as payable: Dr the payable / Cr cash or bank. '
          + 'payable=salaries (accrued salaries), gosi (social insurance accrued with salaries), accrued_expenses (an expense recorded earlier as unpaid/آجل). '
          + 'Refused when the amount exceeds that payable’s balance. Use only when the user explicitly says such an amount was paid and wrote it in digits; '
          + 'if it is unclear whether the item was recorded as payable before, ask. If posted=false, explain the message and stop.',
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: `Amount paid. ${AMOUNT_RULE}` },
            payable: {
              type: 'string', enum: [...SETTLE_PAYABLE_KEYS],
              description: 'salaries=رواتب مستحقة، gosi=تأمينات اجتماعية مستحقة، accrued_expenses=مصروف سُجّل آجلاً (فاتورة لم تُدفع)',
            },
            paidFrom: { type: 'string', enum: ['cash', 'bank'], description: 'cash=نقداً، bank=تحويل بنكي' },
            paidFromAccountCode: { type: 'string', description: 'Cash/bank account code — only if the user named a specific box or bank account.' },
            month: { type: 'string', description: 'Salary/GOSI month (YYYY-MM) if the user mentioned it — for the description only.' },
            description: { type: 'string', description: 'Short Arabic note of what was paid, e.g. «فاتورة الكهرباء لشهر أكتوبر» — mainly for accrued_expenses.' },
            date: { type: 'string', description: 'YYYY-MM-DD only if the user gave a payment date.' },
          },
          required: ['amount', 'payable', 'paidFrom'],
          additionalProperties: false,
        },
      },
    },
    async run(args): Promise<ToolOutput | { error: string }> {
      const gate = staticGateRefusal(ctx, d.env);
      if (gate) return refusalOutput(gate);
      const p = settleArgsSchema.safeParse(args);
      if (!p.success) return argsError(p.error);
      const a = p.data;
      const amount = parseAmountArg(a.amount);
      if (amount === null) return refusalOutput(AMOUNT_INVALID('مبلغ السداد'));
      let month: ResolvedMonth | null = null;
      if (a.month !== null && a.month !== undefined && String(a.month).trim() !== '') {
        const m = resolveSalaryMonth(a.month, ctx.todayLocal);
        if (isRefusal(m)) return refusalOutput(m);
        month = m;
      }
      const date = dateArgOf(a.date) ?? ctx.todayLocal;
      return execute(ctx, d, {
        amounts: [{ milli: amount, what: 'مبلغ السداد' }],
        date,
        build: (env) => buildSettlePlan(env, {
          amountMilli: amount, payable: a.payable, paidFrom: a.paidFrom, paidFromAccountCode: a.paidFromAccountCode ?? null, month,
          note: a.description ?? null, date,
        }),
      });
    },
  };
}

/**
 * أدوات الكتابة للدورة: [] ما لم يُسمح بالترحيل (ctx.canPost والدفاتر المفعّلة) ومفتاح AI_ACCOUNTANT_WRITE ≠ 0، وما لم يطلب
 * المستخدم تسجيل شيء (ctx.writeIntent = writeIntentOf، وغيابه writeIntentIn(userText)) — سؤال تقرير لا يُعرض فيه الترحيل أصلاً.
 * deps للاختبار وحده (القاعدة والمعاملة والبيئة).
 */
export function buildWriteTools(ctx: AcctCtx, deps: Partial<WriteToolDeps> = {}): Tool[] {
  const d = depsOf(deps);
  if (!writeToolsAllowed(ctx, d.env)) return [];
  if (!(ctx.writeIntent ?? writeIntentIn(ctx.userText))) return [];
  return [expenseTool(ctx, d), salariesTool(ctx, d), settleTool(ctx, d)];
}

/** GET /api/ai-accountant/posts: أحدث قيود المحاسب الذكي للشركة (tenantId من الجلسة) — حدّ 1..200 */
export async function listAiPosts(tenantId: string, limit: number, db: AiPostsListDb = prisma as unknown as AiPostsListDb): Promise<PostedMove[]> {
  return listAiPostsWith(db, tenantId, limit);
}
