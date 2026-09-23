import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { LedgerLocals } from './context';
import {
  LEDGER_IMPORT_IN_PROGRESS_MESSAGE, LEDGER_OPENING_STOCK_AFTER_CUTOVER_MESSAGE, LEDGER_OPENING_STOCK_FULL_HISTORY_MESSAGE,
  LEDGER_OPENING_STOCK_TOO_RECENT_MESSAGE, LEDGER_POST_CUTOVER_IMPORTS_ACK_MESSAGE, LedgerHttpError, ledgerHandler,
} from './errors';
import { appendAudit, ledgerActor, type GlActor, type GlTx } from '../../services/gl/audit';
import { acquirePostLock, postMove } from '../../services/gl/post';
import { GlNotFoundError, loadBuildContext } from '../../services/gl/resolve';
import { resolveTemplate, seedTemplate } from '../../services/gl/seed';
import { assertArabicName } from '../../services/gl/names';
import { addDays, daysInMonth, fromDbDate, isLocalDate, isValidTimeZone, toDbDate, todayLocal } from '../../services/gl/dates';
import { draftsListUrl } from '../../services/gl/locks';
import {
  CASH_INVOICE_ROUTINGS, DEFAULT_GL_SETTINGS, LedgerError, TAX_PERIODICITIES,
  type BackfillState, type BuildContext, type LocalDate, type TaxPeriodicity, type TemplateKey,
} from '../../services/gl/types';
import { initialWatermarkAt, type SetupMethod } from '../../services/gl/sync/classify';
import {
  acquireImportEntriesLock, assertCutoverNotInFuture, buildOpeningMove, checkCutoverVatPeriod, computeDerivedOpening, derivedOpeningJson,
  importBatchRecordIds, importInProgressDetails, importedAfterCutoverJson, loadImportedAfterCutover, loadRunningImportBatch, loadOpeningSources, openingCutoff, openingMoveJson, openingSnapshotFromDbNow,
  loadOpeningStockCheck, openingStockCheckJson,
  postCutoverImportsAckMissing, postCutoverImportsAckStale, suggestedCutoverDate, templatePreviewContext, validateManualBalanceRows,
  LEDGER_POST_CUTOVER_IMPORTS_CHANGED_MESSAGE,
  type ManualBalanceLine, type ManualBalanceRowInput,
} from '../../services/gl/opening';
import {
  assertHistoryNotTooLarge, backfillTransition, estimateHistory, fullHistoryCutoverDate, initialCursorRows,
  freezeOpeningSettlementSplits, loadHistoryFacts, refreshBackfillState, scanFutureDatedRows,
} from '../../services/gl/backfill';
import { IMPORT_ENTRY_KINDS, importTimezone } from '../../services/importLedger';
import {
  LEDGER_TIMEZONE_IMPORTS_CONFLICT_CODE, LEDGER_TIMEZONE_IMPORTS_CONFLICT_MESSAGE, importTimezoneConflict, planImportDateRebase, plannedRebaseCount,
} from '../../services/importTimezoneRebase';

/**
 * معالج الإعداد والقيد الافتتاحي والترحيل التاريخي — `/api/ledger/setup*` (M3، §5.6، §8.4 القسم 2، ملحق أ).
 *
 * - GET  /setup                 الحالة والمسودة والقيم المقترحة وتقدير التاريخ الكامل وتقدم الترحيل التاريخي.
 * - POST /setup/draft           حفظ مسودة خطوة (1 الأساس، 2 الطريقة، 3 الشجرة، 5 الأرصدة اليدوية) في GlSettings.setupDraft.
 * - POST /setup/preview-opening معاينة إرشادية للأرصدة المشتقة والقيد (لا تُخزَّن أبداً)، ومعها importedAfterCutover:
 *                               حركات مستوردة بتاريخ ≥ البدء تُرحَّل بتاريخها على 319002 لا في الافتتاح.
 * - POST /setup/commit          معاملة واحدة (60 ثانية): القفلان ثم T0 من ساعة القاعدة بعدهما (البند 42) ⇒ لا دفعة استيراد جارية (409 LEDGER_IMPORT_IN_PROGRESS) ⇒ الزرع متساوي الأثر ⇒ إعادة الحساب
 *                               بـT0 ⇒ قيد OPEN ⇒ openingSnapshotAt/activatedAt ⇒ المؤشرات ⇒ backfillState=RUNNING ⇒ SETUP_COMMIT.
 * - POST /setup/backfill        «إيقاف مؤقت»/«استئناف» الترحيل التاريخي (RUNNING ⇄ PAUSED).
 *
 * الصلاحية canConfigureLedger لكل المسارات. العزل بـtenantId من السياق. لا تواريخ إقفال هنا (§8.3 LockDatesDialog).
 */
const router = Router();

const CONFIGURE = requireLedgerPermission('canConfigureLedger');
const COMMIT_TX = { timeout: 60_000, maxWait: 10_000 };

const ledgerOf = (res: Response) => res.locals.ledger as LedgerLocals;
const actorOf = (req: AuthRequest, res: Response): GlActor =>
  ledgerActor(ledgerOf(res), { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });
const dateOut = (d: Date | null | undefined): string | null => (d ? fromDbDate(d) : null);

// ═══ المسودة ═══

const localDateSchema = z.string().refine(isLocalDate, 'تاريخ غير صالح YYYY-MM-DD');
const RECEIPT_METHODS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'] as const;
const amountSchema = z.union([z.number(), z.string().max(40)]).nullish();

const step1Schema = z.object({
  timezone: z.string().min(1).refine(isValidTimeZone, 'منطقة زمنية غير صالحة'),
  fiscalYearEndMonth: z.number().int().min(1).max(12),
  fiscalYearEndDay: z.number().int().min(1).max(31),
  weekStartsOn: z.number().int().min(0).max(6),
  taxPeriodicity: z.enum(TAX_PERIODICITIES),
  cutoverDate: localDateSchema,
  confirmMidVatPeriod: z.boolean(),
  preCutoverBoxes: z.record(z.string().max(20), z.union([z.number(), z.string().max(40)])).nullable(),
}).partial().strict();

const step2Schema = z.object({ method: z.enum(['OPENING', 'FULL_HISTORY']) }).strict();

const step3Schema = z.object({
  accountNames: z.array(z.object({ code: z.string().trim().min(1).max(10), name: z.string().trim().min(1).max(200) })).max(500),
  categoryIncomeAccounts: z.array(z.object({ categoryId: z.string().min(1), accountCode: z.string().trim().min(1).max(10) })).max(2000),
  receiptRouting: z.record(z.enum(RECEIPT_METHODS), z.enum(['CUSTODY', 'DIRECT'])).nullable(),
  cashInvoiceRouting: z.enum(CASH_INVOICE_ROUTINGS),
}).partial().strict();

const manualRowSchema = z.object({
  accountCode: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
  debit: amountSchema,
  credit: amountSchema,
  vendorId: z.string().max(100).nullish(),
  vendorName: z.string().max(200).nullish(),
  dueDate: localDateSchema.nullish(),
  salesRepId: z.string().max(100).nullish(),
  label: z.string().max(300).nullish(),
});
const step5Schema = z.object({ rows: z.array(manualRowSchema).max(5000) }).strict();

const draftSchema = z.object({
  currentStep: z.number().int().min(1).max(6),
  step1: step1Schema,
  step2: step2Schema,
  step3: step3Schema,
  step5: step5Schema,
}).partial().strict();

export type SetupDraft = z.infer<typeof draftSchema>;

/** المسودة المخزّنة (قد تكون قديمة الشكل) ⇒ ما يصح منها فقط */
export function parseStoredDraft(v: unknown): SetupDraft {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: SetupDraft = {};
  const o = v as Record<string, unknown>;
  for (const key of ['currentStep', 'step1', 'step2', 'step3', 'step5'] as const) {
    const r = draftSchema.shape[key].safeParse(o[key]);
    if (r.success && r.data !== undefined) (out as Record<string, unknown>)[key] = r.data;
  }
  return out;
}

/** دمج على مستوى الأقسام: قسم مُرسل يحل محل قسمه، وstep1 يُدمج حقلاً بحقل */
export function mergeDraft(base: SetupDraft, patch: SetupDraft): SetupDraft {
  return {
    ...base,
    ...patch,
    ...(patch.step1 ? { step1: { ...(base.step1 ?? {}), ...patch.step1 } } : {}),
  };
}

// ═══ الإعداد الفعلي من المسودة والإعدادات ═══

type SettingsRow = Prisma.GlSettingsGetPayload<object>;

interface EffectiveSetup {
  templateKey: TemplateKey;
  countryCode: string;
  timezone: string;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
  weekStartsOn: number;
  taxPeriodicity: TaxPeriodicity;
  method: SetupMethod;
  cutoverDate: LocalDate | null;
  confirmMidVatPeriod: boolean;
  preCutoverBoxes: Record<string, unknown> | null;
}

async function companyOf(db: GlTx | typeof prisma, tenantId: string) {
  const cs = await db.companySettings.findUnique({ where: { tenantId }, select: { countryCode: true, currency: true, currencyOverride: true } });
  const countryCode = (cs?.countryCode || 'SA').toUpperCase();
  return { countryCode, currency: cs ? (cs.currencyOverride || cs.currency) : null };
}

function effectiveSetup(draft: SetupDraft, s: SettingsRow | null, countryCode: string): EffectiveSetup {
  const templateKey: TemplateKey = s ? (s.templateKey === 'GENERIC_6D' ? 'GENERIC_6D' : 'SA_6D') : (countryCode === 'SA' ? 'SA_6D' : 'GENERIC_6D');
  const d1 = draft.step1 ?? {};
  return {
    templateKey,
    countryCode: s?.countryCode ?? countryCode,
    timezone: d1.timezone ?? s?.timezone ?? DEFAULT_GL_SETTINGS.timezone,
    fiscalYearEndMonth: d1.fiscalYearEndMonth ?? s?.fiscalYearEndMonth ?? 12,
    fiscalYearEndDay: d1.fiscalYearEndDay ?? s?.fiscalYearEndDay ?? 31,
    weekStartsOn: d1.weekStartsOn ?? s?.weekStartsOn ?? 0,
    taxPeriodicity: (d1.taxPeriodicity ?? (s?.taxPeriodicity as TaxPeriodicity | undefined) ?? 'QUARTERLY'),
    method: draft.step2?.method ?? 'OPENING',
    cutoverDate: d1.cutoverDate ?? null,
    confirmMidVatPeriod: d1.confirmMidVatPeriod === true,
    preCutoverBoxes: d1.preCutoverBoxes ?? null,
  };
}

function assertFiscalYearEnd(e: EffectiveSetup) {
  if (e.fiscalYearEndDay > daysInMonth(2001, e.fiscalYearEndMonth)) {
    throw new LedgerHttpError(422, 'يوم نهاية السنة المالية غير صالح للشهر', {
      reason: 'INVALID_FISCAL_YEAR_END', fiscalYearEndMonth: e.fiscalYearEndMonth, fiscalYearEndDay: e.fiscalYearEndDay,
    });
  }
}

/** صف GlSettings بلقطة القالب إن لم يوجد (بلا زرع حسابات) — createMany متساوي الأثر */
async function ensureSettingsRow(tx: GlTx, tenantId: string, templateKey: TemplateKey, countryCode: string): Promise<SettingsRow> {
  const existing = await tx.glSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;
  let tpl;
  try {
    tpl = resolveTemplate(templateKey, templateKey === 'GENERIC_6D' ? { countryCode } : {});
  } catch (e) {
    if (e instanceof RangeError) throw new LedgerHttpError(422, 'لا قالب محاسبي لدولة الشركة', { reason: 'TEMPLATE_UNAVAILABLE', templateKey, countryCode });
    throw e;
  }
  await tx.glSettings.createMany({
    data: [{
      tenantId, templateKey: tpl.settings.templateKey, countryCode: tpl.settings.countryCode, currency: tpl.settings.currency,
      currencyDecimals: tpl.settings.currencyDecimals, zeroRatedSalesTaxKey: tpl.settings.zeroRatedSalesTaxKey,
      ...(tpl.settings.taxDeadlineRule ? { taxDeadlineRule: tpl.settings.taxDeadlineRule } : {}),
      ...(tpl.settings.taxDeadlineDays != null ? { taxDeadlineDays: tpl.settings.taxDeadlineDays } : {}),
    }],
    skipDuplicates: true,
  });
  return tx.glSettings.findUniqueOrThrow({ where: { tenantId } });
}

export async function dbNowOf(db: GlTx | typeof prisma): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
  return rows[0]?.now instanceof Date ? rows[0].now : new Date(rows[0]?.now ?? Date.now());
}

/**
 * البند 42: `now()` داخل المعاملة = لحظة **بدئها**، فلا يرى ما كُتب أثناء انتظار قفل gl-post (والقفل بلا مهلة)،
 * فتمرّ حركات مستوردة كُتبت في الانتظار دون أن تُعرض ولا يُقَرّ بها. `clock_timestamp()` يتقدّم مع المعاملة،
 * فهو مقياس اللقطة **بعد** حيازة الأقفال. خارج المعاملة القيمتان واحدة.
 */
export async function dbClockOf(db: GlTx | typeof prisma): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS "now"`;
  return rows[0]?.now instanceof Date ? rows[0].now : new Date(rows[0]?.now ?? Date.now());
}

function assertNotActivated(s: { activatedAt: Date | null } | null) {
  if (s?.activatedAt) {
    throw new LedgerHttpError(409, 'النظام المحاسبي المتكامل مفعّل مسبقاً لهذه الشركة', { reason: 'ALREADY_ACTIVATED', activatedAt: s.activatedAt });
  }
}

/** الخطوة 1 (الحفظ والاعتماد): لا تاريخ بدء مستقبلي ثم بداية فترة الإقرار — يعيد midPeriod */
function checkStep1(e: EffectiveSetup, now: Date): { midPeriod: boolean } {
  assertFiscalYearEnd(e);
  if (!e.cutoverDate) return { midPeriod: false };
  assertCutoverNotInFuture(e.cutoverDate, e.timezone, now);
  return checkCutoverVatPeriod({
    templateKey: e.templateKey, cutoverDate: e.cutoverDate, taxPeriodicity: e.taxPeriodicity,
    fiscalYearEndMonth: e.fiscalYearEndMonth, fiscalYearEndDay: e.fiscalYearEndDay,
    confirmMidVatPeriod: e.confirmMidVatPeriod, preCutoverBoxes: e.preCutoverBoxes,
  });
}

function settingsStatus(s: SettingsRow | null) {
  return {
    seeded: !!s,
    activatedAt: s?.activatedAt ?? null,
    activatedBy: s?.activatedBy ?? null,
    backfillState: (s?.backfillState ?? 'NONE') as BackfillState,
    setupMethod: s?.setupMethod ?? null,
    cutoverDate: dateOut(s?.cutoverDate),
    openingSnapshotAt: s?.openingSnapshotAt ?? null,
    templateKey: s?.templateKey ?? null,
    countryCode: s?.countryCode ?? null,
    currency: s?.currency ?? null,
    currencyDecimals: s?.currencyDecimals ?? null,
    timezone: s?.timezone ?? null,
    inventoryMode: s?.inventoryMode ?? 'PERIODIC',
    cashInvoiceRouting: s?.cashInvoiceRouting ?? 'MAIN_CASH',
    receiptRouting: s?.receiptRouting ?? null,
  };
}

async function draftsBeforeCutover(db: GlTx | typeof prisma, tenantId: string, cutoverDate: LocalDate | null) {
  if (!cutoverDate) return null;
  const count = await db.glMove.count({ where: { tenantId, state: 'DRAFT', date: { lt: toDbDate(cutoverDate) } } });
  return { count, listUrl: draftsListUrl(addDays(cutoverDate, -1)) };
}

// ═══ المنطقة الزمنية والاستيراد (البند 25) ═══

const REBASE_CHUNK = 1000;

/** دفعات القيود المستوردة القائمة للشركة (balances/ledger، غير متراجَع عنها) — قراءة فقط بلا قفل */
async function loadImportEntryBatches(tx: GlTx, tenantId: string) {
  return tx.importBatch.findMany({
    where: { tenantId, reverted: false, kind: { in: [...IMPORT_ENTRY_KINDS] }, count: { gt: 0 } },
    select: { id: true, kind: true, count: true, createdAt: true, recordIds: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** خطّة الإزاحة على قيود تلك الدفعات، بمجموعات لا تتجاوز REBASE_CHUNK معرّفاً — قراءة فقط */
async function planTenantImportRebase(
  tx: GlTx, tenantId: string, batches: readonly { recordIds: string | null }[], fromTz: string, toTz: string,
): Promise<{ from: Date; to: Date; ids: string[] }[]> {
  const ids = [...new Set(batches.flatMap((b) => importBatchRecordIds(b.recordIds)))];
  const plan: { from: Date; to: Date; ids: string[] }[] = [];
  for (let i = 0; i < ids.length; i += REBASE_CHUNK) {
    const entries = await tx.accountEntry.findMany({
      where: { id: { in: ids.slice(i, i + REBASE_CHUNK) }, tenantId, invoiceId: null, receiptId: null },
      select: { id: true, entryDate: true },
    });
    plan.push(...planImportDateRebase(entries, fromTz, toTz));
  }
  return plan;
}

/**
 * تغيير المنطقة الفعلية عن منطقة الاستيراد (importTimezone(before)) مع **إزاحة فعلية** على تواريخ قيود دفعات
 * balances/ledger القائمة: بلا rebaseImportDates ⇒ 409 LEDGER_TIMEZONE_IMPORTS_CONFLICT؛ معه ⇒ نقل القيود المحاذية
 * لبداية يوم المنطقة السابقة إلى بداية اليوم نفسه بالمنطقة الجديدة داخل المعاملة نفسها. قبل كتابة glSettings دائماً.
 *
 * البند D — الترتيب مقصود: التعارض يُقاس أولاً بالقراءة وحدها (بلا قفل)، فمنطقتان بإزاحة واحدة (Asia/Riyadh ⇄
 * Asia/Aden) لا تُشعلان 409 ولا LEDGER_IMPORT_IN_PROGRESS ولا تأخذان قفل حجز الدفعات. القفل وفحص «استيراد جارٍ»
 * لا يقعان إلا حين توجد إزاحة ستُكتب فعلاً، ثم يُعاد قياس الخطّة تحته فتُشمل أي دفعة وصلت أثناء القياس.
 * lockHeld: /setup/commit أخذ القفل وفحص الجاري قبله، فالخطّة المقيسة هناك تحته أصلاً.
 * يعيد عدد القيود المنقولة حين نُفّذت إعادة الضبط، وإلا undefined.
 */
export async function guardImportTimezone(
  tx: GlTx, tenantId: string, before: SettingsRow | null, timezone: string,
  opts: { rebase: boolean | undefined; now: Date; lockHeld: boolean },
): Promise<number | undefined> {
  const previousTimezone = importTimezone(before);
  if (previousTimezone === timezone) return undefined;
  const batches = await loadImportEntryBatches(tx, tenantId);
  if (!batches.length) return undefined;
  const plan = await planTenantImportRebase(tx, tenantId, batches, previousTimezone, timezone);
  const conflict = importTimezoneConflict({ previousTimezone, timezone, batches, shiftedEntries: plannedRebaseCount(plan) });
  if (!conflict) return undefined;
  if (opts.rebase !== true) {
    throw new LedgerHttpError(409, LEDGER_TIMEZONE_IMPORTS_CONFLICT_MESSAGE, { ...conflict }, LEDGER_TIMEZONE_IMPORTS_CONFLICT_CODE);
  }
  let finalPlan = plan;
  if (!opts.lockHeld) {
    await acquireImportEntriesLock(tx, tenantId);
    const running = await loadRunningImportBatch(tx, tenantId, opts.now);
    if (running) throw new LedgerHttpError(409, LEDGER_IMPORT_IN_PROGRESS_MESSAGE, importInProgressDetails(running), 'LEDGER_IMPORT_IN_PROGRESS');
    finalPlan = await planTenantImportRebase(tx, tenantId, await loadImportEntryBatches(tx, tenantId), previousTimezone, timezone);
  }
  let rebased = 0;
  for (const g of finalPlan) {
    const u = await tx.accountEntry.updateMany({ where: { tenantId, id: { in: g.ids }, entryDate: g.from }, data: { entryDate: g.to } });
    rebased += u.count;
  }
  return rebased;
}

// ═══ GET /setup ═══

router.get('/setup', CONFIGURE, ledgerHandler(async (_req, res) => {
  const { tenantId } = ledgerOf(res);
  const [s, company] = await Promise.all([prisma.glSettings.findUnique({ where: { tenantId } }), companyOf(prisma, tenantId)]);
  const draft = parseStoredDraft(s?.setupDraft);
  const eff = effectiveSetup(draft, s, company.countryCode);
  const now = await dbNowOf(prisma);
  const status = settingsStatus(s);
  if (s?.activatedAt) {
    const progress = await refreshBackfillState(prisma, tenantId);
    res.json({ success: true, data: { activated: true, status: { ...status, backfillState: progress?.state ?? status.backfillState }, progress } });
    return;
  }
  const facts = await loadHistoryFacts(prisma, tenantId);
  const estimate = estimateHistory(facts.counts);
  res.json({
    success: true,
    data: {
      activated: false,
      status,
      draft,
      effective: eff,
      company,
      today: todayLocal(now, eff.timezone),
      suggestedCutoverDate: suggestedCutoverDate(eff.templateKey, now, eff.timezone, eff.fiscalYearEndMonth, eff.fiscalYearEndDay),
      history: {
        ...estimate,
        oldestEffectAt: facts.oldestEffectAt,
        fullHistoryCutoverDate: fullHistoryCutoverDate(facts.oldestEffectAt, eff.timezone, eff.fiscalYearEndMonth, eff.fiscalYearEndDay),
      },
      draftsBeforeCutover: await draftsBeforeCutover(prisma, tenantId, eff.cutoverDate),
      progress: null,
    },
  });
}));

// ═══ POST /setup/draft ═══

router.post('/setup/draft', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  // rebaseImportDates حقل علوي للطلب لا للمسودة: يُنزع قبل draftSchema (strict) ولا يُخزَّن
  const { rebaseImportDates: rawRebase, ...draftBody } = (req.body ?? {}) as Record<string, unknown>;
  const rebaseImportDates = z.boolean().optional().parse(rawRebase);
  const patch = draftSchema.parse(draftBody);
  const actor = actorOf(req, res);
  const out = await prisma.$transaction(async (tx) => {
    const now = await dbNowOf(tx);
    const company = await companyOf(tx, tenantId);
    const before = await tx.glSettings.findUnique({ where: { tenantId } });
    assertNotActivated(before);
    const merged = mergeDraft(parseStoredDraft(before?.setupDraft), patch);
    const eff = effectiveSetup(merged, before, company.countryCode);
    // الخطوة 1: لا تاريخ بدء في المستقبل (422 LEDGER_CUTOVER_IN_FUTURE) ولا داخل فترة إقرار دون تأكيد
    checkStep1(eff, now);
    let history = null;
    if (patch.step2?.method === 'FULL_HISTORY') {
      const facts = await loadHistoryFacts(tx, tenantId);
      const estimate = estimateHistory(facts.counts);
      assertHistoryNotTooLarge(estimate);
      history = { ...estimate, fullHistoryCutoverDate: fullHistoryCutoverDate(facts.oldestEffectAt, eff.timezone, eff.fiscalYearEndMonth, eff.fiscalYearEndDay) };
    }
    // البند 25: تغيير المنطقة بعد استيراد أرصدة/كشوف ⇒ 409 أو إعادة ضبط التواريخ، قبل أي كتابة للإعدادات
    const rebasedImportEntries = await guardImportTimezone(tx, tenantId, before, eff.timezone, { rebase: rebaseImportDates, now, lockHeld: false });
    const s = await ensureSettingsRow(tx, tenantId, eff.templateKey, company.countryCode);
    const updated = await tx.glSettings.update({ where: { tenantId }, data: { setupDraft: merged as Prisma.InputJsonValue } });
    if (!before?.setupDraft) {
      await appendAudit(tx, {
        tenantId, actor, action: 'SETUP_START', entityType: 'SETTINGS', entityId: s.id,
        summary: 'بدء معالج إعداد النظام المحاسبي المتكامل', after: { templateKey: eff.templateKey, countryCode: eff.countryCode },
      });
    }
    return {
      draft: parseStoredDraft(updated.setupDraft), effective: eff, history,
      ...(rebasedImportEntries !== undefined ? { rebasedImportEntries } : {}),
    };
  }, { timeout: 30_000, maxWait: 10_000 });
  res.json({ success: true, data: out });
}));

// ═══ السياق والأرصدة اليدوية ═══

async function previewContext(tenantId: string, s: SettingsRow | null, eff: EffectiveSetup): Promise<BuildContext> {
  if (s && (await prisma.glAccount.count({ where: { tenantId } })) > 0) {
    const lc = await loadBuildContext(prisma, tenantId);
    return lc.ctx;
  }
  try {
    return templatePreviewContext(eff.templateKey, eff.countryCode, { timezone: eff.timezone, taxPeriodicity: eff.taxPeriodicity });
  } catch (e) {
    if (e instanceof RangeError) throw new LedgerHttpError(422, 'لا قالب محاسبي لدولة الشركة', { reason: 'TEMPLATE_UNAVAILABLE', templateKey: eff.templateKey, countryCode: eff.countryCode });
    throw e;
  }
}

function manualRowsOf(draft: SetupDraft): ManualBalanceRowInput[] {
  return (draft.step5?.rows ?? []).map((r) => ({ ...r, accountCode: r.accountCode }));
}

// ═══ POST /setup/preview-opening ═══

/** معاينة إرشادية (§5.6 الخطوة 4): لا تُخزَّن أبداً، ويُعاد الحساب في الاعتماد بـT0 */
router.post('/setup/preview-opening', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const patch = draftSchema.parse(req.body ?? {});
  const [s, company] = await Promise.all([prisma.glSettings.findUnique({ where: { tenantId } }), companyOf(prisma, tenantId)]);
  const draft = mergeDraft(parseStoredDraft(s?.setupDraft), patch);
  const eff = effectiveSetup(draft, s, company.countryCode);
  const now = await dbNowOf(prisma);
  let cutoverDate = eff.cutoverDate;
  if (eff.method === 'FULL_HISTORY') {
    const facts = await loadHistoryFacts(prisma, tenantId);
    cutoverDate = fullHistoryCutoverDate(facts.oldestEffectAt, eff.timezone, eff.fiscalYearEndMonth, eff.fiscalYearEndDay) ?? cutoverDate;
  }
  if (!cutoverDate) throw new LedgerHttpError(422, 'تاريخ البدء مطلوب', { reason: 'CUTOVER_REQUIRED', field: 'cutoverDate' });
  const { midPeriod } = checkStep1({ ...eff, cutoverDate }, now);
  const ctx = await previewContext(tenantId, s, eff);
  const decimals = ctx.settings.currencyDecimals;
  const step3 = draft.step3 ?? {};
  const routing = {
    receiptRouting: (step3.receiptRouting !== undefined ? step3.receiptRouting : ctx.settings.receiptRouting) ?? null,
    cashInvoiceRouting: step3.cashInvoiceRouting ?? ctx.settings.cashInvoiceRouting,
  };
  const cut = openingCutoff(cutoverDate, eff.timezone, now);
  const sources = await loadOpeningSources(prisma, tenantId, cut);
  const derived = computeDerivedOpening(sources, cut, { decimals, routing });
  const manual = validateManualBalanceRows(manualRowsOf(draft), ctx, { midVatPeriod: midPeriod });
  const move = buildOpeningMove({ derived, manual: manual.lines, ctx, salesRepNames: sources.salesRepNames });
  // المخزون الافتتاحي المستورد خارج الافتتاح: بعد البدء، أو أحدث من لقطة الاعتماد (T0 = الآن − 10 دقائق)
  const stockCut = openingCutoff(cutoverDate, eff.timezone, openingSnapshotFromDbNow(now));
  const [importedAfterCutover, customers, products, openingStock] = await Promise.all([
    loadImportedAfterCutover(prisma, tenantId, cut, decimals),
    prisma.customer.count({ where: { tenantId } }),
    prisma.product.count({ where: { tenantId } }),
    loadOpeningStockCheck(prisma, tenantId, stockCut, decimals),
  ]);
  res.json({
    success: true,
    data: {
      preview: true,
      method: eff.method,
      midVatPeriod: midPeriod,
      opening: derivedOpeningJson(derived, decimals),
      manual: { lineCount: manual.lines.length, issues: manual.issues },
      move: openingMoveJson(move, decimals),
      draftsBeforeCutover: await draftsBeforeCutover(prisma, tenantId, cutoverDate),
      importedAfterCutover: importedAfterCutoverJson(importedAfterCutover, decimals),
      /** دفعات opening_stock: fullHistoryBlocked يمنع الاعتماد، وafterCutover يتطلب إقراراً، وtooRecent يُعاد بعد retryAfter */
      openingStock: {
        ...openingStockCheckJson(openingStock, decimals, stockCut),
        fullHistoryBlocked: eff.method === 'FULL_HISTORY' && openingStock.batches > 0,
      },
      /** للتنبيه: ذمم صفرية مع عملاء، ومخزون صفري مع منتجات */
      tenantCounts: { customers, products },
    },
  });
}));

// ═══ POST /setup/commit ═══

/**
 * البند 41: الإقرار مربوط باللقطة المعروضة (العدد والمدين والدائن ولحظتها) لا قيمةً منطقية، فلا يصحّ إقرار قديم
 * على واقع جديد. الشكل المنطقي يبقى مقبولاً للتوافق (نداءات قديمة) لكنه غير مربوط، والواجهة تُرسل اللقطة.
 */
const postCutoverImportsAckSchema = z.object({
  count: z.number().int().min(0),
  debit: z.string().max(40),
  credit: z.string().max(40),
  snapshotAt: z.string().max(40).nullish(),
}).strict();

const commitSchema = z.object({
  /** تنبيه السجلات النظامية قبل زر التفعيل (§9.5 G6) */
  acknowledgeStatutory: z.literal(true),
  /** إقرار بحركات مستوردة بتاريخ ≥ البدء (تُرحَّل على 319002) — إلزامي حين عددها > 0، ومربوط باللقطة المعروضة */
  acknowledgePostCutoverImports: z.union([z.boolean(), postCutoverImportsAckSchema]).optional(),
  /** إقرار بمخزون افتتاحي مستورد في تاريخ البدء أو بعده (لا يدخل الافتتاح ولا يُرحَّل قبل M9) — إلزامي حين عدده > 0 */
  acknowledgeOpeningStockExcluded: z.boolean().optional(),
  /** البند 25: تأكيد إعادة ضبط تواريخ الأرصدة/الكشوف المستوردة على المنطقة الزمنية الجديدة */
  rebaseImportDates: z.boolean().optional(),
  draft: draftSchema.optional(),
}).strict();

export interface CategoryLink { categoryId: string; accountCode: string }

/**
 * البند 26: روابط فئة ⇒ حساب إيراد لفئات لم تعد موجودة (حُذفت بتراجع استيراد المنتجات مثلاً) تُتخطى ولا تُفشل
 * الاعتماد بـ404 لا يُصلَح من الواجهة. دالة صرفة.
 */
export function partitionCategoryLinks<T extends CategoryLink>(links: readonly T[], existingIds: ReadonlySet<string>): { apply: T[]; skipped: CategoryLink[] } {
  const apply: T[] = [];
  const skipped: CategoryLink[] = [];
  for (const l of links) {
    if (existingIds.has(l.categoryId)) apply.push(l);
    else skipped.push({ categoryId: l.categoryId, accountCode: l.accountCode });
  }
  return { apply, skipped };
}

async function applyStep3(tx: GlTx, tenantId: string, draft: SetupDraft): Promise<{ renamed: number; categoryAccounts: number; skippedCategoryLinks: CategoryLink[] }> {
  const step3 = draft.step3 ?? {};
  let renamed = 0;
  for (const r of step3.accountNames ?? []) {
    assertArabicName(r.name, { entity: 'ACCOUNT', code: r.code });
    const u = await tx.glAccount.updateMany({ where: { tenantId, code: r.code, NOT: { name: r.name } }, data: { name: r.name, nameI18n: Prisma.DbNull } });
    renamed += u.count;
  }
  const allLinks = step3.categoryIncomeAccounts ?? [];
  let links: CategoryLink[] = [];
  let skippedCategoryLinks: CategoryLink[] = [];
  if (allLinks.length) {
    const cats = new Set((await tx.productCategory.findMany({ where: { tenantId, id: { in: allLinks.map((l) => l.categoryId) } }, select: { id: true } })).map((c) => c.id));
    ({ apply: links, skipped: skippedCategoryLinks } = partitionCategoryLinks(allLinks, cats));
  }
  if (links.length) {
    const codes = [...new Set(links.map((l) => l.accountCode))];
    const accounts = await tx.glAccount.findMany({ where: { tenantId, code: { in: codes } }, select: { id: true, code: true, type: true, isActive: true } });
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    for (const l of links) {
      const a = byCode.get(l.accountCode);
      if (!a) throw new LedgerError('LEDGER_ACCOUNT_NOT_FOUND', { accountCode: l.accountCode, field: 'categoryIncomeAccounts' });
      if (!a.isActive) throw new LedgerError('LEDGER_ACCOUNT_ARCHIVED', { accountCode: l.accountCode, field: 'categoryIncomeAccounts' });
      if (a.type !== 'income' && a.type !== 'income_other') {
        throw new LedgerHttpError(422, 'حساب إيراد الفئة يجب أن يكون من نوع إيراد', { reason: 'CATEGORY_ACCOUNT_TYPE', accountCode: l.accountCode, categoryId: l.categoryId });
      }
      await tx.glProductCategoryAccount.upsert({
        where: { tenantId_categoryId: { tenantId, categoryId: l.categoryId } },
        create: { tenantId, categoryId: l.categoryId, incomeAccountId: a.id },
        update: { incomeAccountId: a.id },
      });
    }
  }
  return { renamed, categoryAccounts: links.length, skippedCategoryLinks };
}

/** سطور 211001: vendorId قائم للشركة، أو مورّد بالاسم (يُنشأ GlVendor إن لم يوجد) — I5 */
async function resolveVendors(tx: GlTx, tenantId: string, lines: ManualBalanceLine[]): Promise<{ created: number }> {
  const byName = new Map<string, { id: string; name: string }>();
  let created = 0;
  for (const l of lines) {
    if (l.account.controlKind !== 'AP') continue;
    if (l.vendorId) {
      const v = await tx.glVendor.findFirst({ where: { id: l.vendorId, tenantId }, select: { id: true, name: true } });
      if (!v) throw new GlNotFoundError('GlVendor', l.vendorId);
      l.vendorName = v.name;
      continue;
    }
    const name = (l.vendorName ?? '').trim();
    const key = name.toLowerCase();
    let v = byName.get(key);
    if (!v) {
      v = (await tx.glVendor.findFirst({ where: { tenantId, name: { equals: name, mode: 'insensitive' } }, select: { id: true, name: true } })) ?? undefined;
      if (!v) {
        v = await tx.glVendor.create({ data: { tenantId, name }, select: { id: true, name: true } });
        created++;
      }
      byName.set(key, v);
    }
    l.vendorId = v.id;
    l.vendorName = v.name;
  }
  return { created };
}

router.post('/setup/commit', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId, actorId } = ledgerOf(res);
  const parsed = commitSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const ack = (req.body as { acknowledgeStatutory?: unknown } | undefined)?.acknowledgeStatutory;
    if (ack !== true) throw new LedgerHttpError(422, 'يجب الإقرار بتنبيه السجلات المحاسبية النظامية قبل التفعيل', { reason: 'STATUTORY_ACK_REQUIRED', field: 'acknowledgeStatutory' });
    throw parsed.error;
  }
  const actor = actorOf(req, res);

  const out = await prisma.$transaction(async (tx) => {
    // (1) قفل الترحيل أولاً (§5.6 الخطوة 6)
    await acquirePostLock(tx, tenantId);

    const company = await companyOf(tx, tenantId);
    const before = await tx.glSettings.findUnique({ where: { tenantId } });
    assertNotActivated(before);
    // دفعة استيراد جارية (قلبها ينبض خلال المهلة) ⇒ 409 LEDGER_IMPORT_IN_PROGRESS قبل أي كتابة: صفوفها تُكتب بسياق
    // «قبل التفعيل» ولا يغطيها الافتتاح ولا الإقرار. قفل حجز الدفعات أولاً فلا تُحجز دفعة بين الفحص والتفعيل؛
    // المنقطعة (نبض أقدم من المهلة) لا تمنع — ما سُجّل منها يُراجع ويُتراجع عنه من سجل الدفعات.
    await acquireImportEntriesLock(tx, tenantId);
    // البند 42: ساعة القاعدة **بعد** حيازة القفلين (clock_timestamp لا now المجمَّد على بدء المعاملة)، فتشمل اللقطة
    // كل ما كُتب أثناء انتظار القفل. T0 ومنه openingSnapshotAt وactivatedAt وفحوص الإقرار كلها على هذه اللحظة.
    const dbNow = await dbClockOf(tx);
    const T0 = openingSnapshotFromDbNow(dbNow);
    const runningImport = await loadRunningImportBatch(tx, tenantId, dbNow);
    if (runningImport) {
      throw new LedgerHttpError(409, LEDGER_IMPORT_IN_PROGRESS_MESSAGE, importInProgressDetails(runningImport), 'LEDGER_IMPORT_IN_PROGRESS');
    }
    const draft = mergeDraft(parseStoredDraft(before?.setupDraft), parsed.data.draft ?? {});
    const eff = effectiveSetup(draft, before, company.countryCode);
    // البند 25: قبل أي حساب بتواريخ القيود المستوردة (الافتتاح وما بعد البدء) وقبل كتابة الإعدادات؛ القفل مأخوذ أعلاه
    const rebasedImportEntries = await guardImportTimezone(tx, tenantId, before, eff.timezone, {
      rebase: parsed.data.rebaseImportDates, now: dbNow, lockHeld: true,
    });

    // (2) الطريقة وتاريخ البدء
    let cutoverDate = eff.cutoverDate;
    let history = null;
    if (eff.method === 'FULL_HISTORY') {
      const facts = await loadHistoryFacts(tx, tenantId);
      history = estimateHistory(facts.counts);
      assertHistoryNotTooLarge(history);
      cutoverDate = fullHistoryCutoverDate(facts.oldestEffectAt, eff.timezone, eff.fiscalYearEndMonth, eff.fiscalYearEndDay) ?? cutoverDate;
    }
    if (!cutoverDate) throw new LedgerHttpError(422, 'تاريخ البدء مطلوب', { reason: 'CUTOVER_REQUIRED', field: 'cutoverDate' });
    // لا تاريخ بدء في المستقبل: 422 LEDGER_CUTOVER_IN_FUTURE (قبل أي كتابة)
    assertCutoverNotInFuture(cutoverDate, eff.timezone, dbNow);
    const { midPeriod } = checkStep1({ ...eff, cutoverDate }, dbNow);
    // المخزون الافتتاحي المستورد (opening_stock) قبل أي كتابة وقبل حساب الافتتاح: المسند نفسه في loadOpeningSources بـT0.
    // قفل gl-post ممسوك، واستيراد المخزون يأخذه، فلا حركة تُكتب بين الفحص والتفعيل.
    const stockDecimals = before?.currencyDecimals ?? DEFAULT_GL_SETTINGS.currencyDecimals;
    const stockCut = openingCutoff(cutoverDate, eff.timezone, T0);
    const openingStock = await loadOpeningStockCheck(tx, tenantId, stockCut, stockDecimals);
    const openingStockJson = openingStockCheckJson(openingStock, stockDecimals, stockCut);
    if (eff.method === 'FULL_HISTORY' && openingStock.batches > 0) {
      throw new LedgerHttpError(409, LEDGER_OPENING_STOCK_FULL_HISTORY_MESSAGE, {
        reason: 'OPENING_STOCK_FULL_HISTORY', method: 'FULL_HISTORY', batches: openingStock.batches,
      }, 'LEDGER_OPENING_STOCK_FULL_HISTORY');
    }
    if (openingStock.afterCutover.count > 0 && parsed.data.acknowledgeOpeningStockExcluded !== true) {
      throw new LedgerHttpError(409, LEDGER_OPENING_STOCK_AFTER_CUTOVER_MESSAGE, {
        reason: 'OPENING_STOCK_AFTER_CUTOVER', field: 'acknowledgeOpeningStockExcluded', cutoverDate,
        count: openingStockJson.afterCutover.count, value: openingStockJson.afterCutover.value,
        minCutoverDate: openingStockJson.afterCutover.minCutoverDate, entries: openingStockJson.afterCutover.entries,
      }, 'LEDGER_OPENING_STOCK_AFTER_CUTOVER');
    }
    if (openingStock.tooRecent.count > 0) {
      throw new LedgerHttpError(409, LEDGER_OPENING_STOCK_TOO_RECENT_MESSAGE, {
        reason: 'OPENING_STOCK_TOO_RECENT', count: openingStockJson.tooRecent.count, value: openingStockJson.tooRecent.value,
        batchId: openingStockJson.tooRecent.entries[0]?.batchId ?? null, createdAt: openingStockJson.tooRecent.entries[0]?.createdAt ?? null,
        retryAfter: openingStockJson.tooRecent.retryAfter,
      }, 'LEDGER_OPENING_STOCK_TOO_RECENT');
    }
    // حركات مستوردة بتاريخ ≥ البدء: 409 ما لم يُقَرّ بها (قبل أي كتابة). اللقطة dbNow لا T0 — مجموعة أشمل،
    // وهي مقروءة بساعة ما بعد القفلين (البند 42) فتشمل ما استُورد أثناء انتظار القفل.
    const currencyDecimalsForCheck = before?.currencyDecimals ?? DEFAULT_GL_SETTINGS.currencyDecimals;
    const importedAfterCutover = await loadImportedAfterCutover(tx, tenantId, openingCutoff(cutoverDate, eff.timezone, dbNow), currencyDecimalsForCheck);
    if (postCutoverImportsAckMissing(importedAfterCutover, parsed.data.acknowledgePostCutoverImports)) {
      throw new LedgerHttpError(409, LEDGER_POST_CUTOVER_IMPORTS_ACK_MESSAGE, {
        reason: 'POST_CUTOVER_IMPORTS_ACK_REQUIRED', field: 'acknowledgePostCutoverImports',
        importedAfterCutover: importedAfterCutoverJson(importedAfterCutover, currencyDecimalsForCheck),
      }, 'LEDGER_POST_CUTOVER_IMPORTS_ACK');
    }
    // البند 41: الإقرار على لقطة غير التي يراها الاعتماد ⇒ 409 بالأرقام القديمة والجديدة، والواجهة تحدّث المعاينة
    const ackDiff = postCutoverImportsAckStale(importedAfterCutover, currencyDecimalsForCheck, parsed.data.acknowledgePostCutoverImports);
    if (ackDiff) {
      throw new LedgerHttpError(409, LEDGER_POST_CUTOVER_IMPORTS_CHANGED_MESSAGE, {
        reason: 'POST_CUTOVER_IMPORTS_CHANGED', field: 'acknowledgePostCutoverImports',
        acknowledged: ackDiff.acked, importedAfterCutover: importedAfterCutoverJson(importedAfterCutover, currencyDecimalsForCheck),
      }, 'LEDGER_POST_CUTOVER_IMPORTS_CHANGED');
    }

    // (3) الإعدادات قبل التفعيل ثم الزرع متساوي الأثر (§4.5)
    await ensureSettingsRow(tx, tenantId, eff.templateKey, company.countryCode);
    const step3 = draft.step3 ?? {};
    await tx.glSettings.update({
      where: { tenantId },
      data: {
        timezone: eff.timezone, fiscalYearEndMonth: eff.fiscalYearEndMonth, fiscalYearEndDay: eff.fiscalYearEndDay,
        weekStartsOn: eff.weekStartsOn, taxPeriodicity: eff.taxPeriodicity,
        ...(step3.cashInvoiceRouting ? { cashInvoiceRouting: step3.cashInvoiceRouting } : {}),
        ...(step3.receiptRouting !== undefined ? { receiptRouting: step3.receiptRouting === null ? Prisma.DbNull : step3.receiptRouting } : {}),
        setupDraft: draft as Prisma.InputJsonValue,
      },
    });
    let seed;
    try {
      seed = await seedTemplate(tx, tenantId, eff.templateKey, eff.templateKey === 'GENERIC_6D' ? { countryCode: eff.countryCode } : {});
    } catch (e) {
      if (e instanceof RangeError) throw new LedgerHttpError(422, 'لا قالب محاسبي لدولة الشركة', { reason: 'TEMPLATE_UNAVAILABLE', templateKey: eff.templateKey, countryCode: eff.countryCode });
      throw e;
    }
    const purchaseKey = resolveTemplate(eff.templateKey, eff.templateKey === 'GENERIC_6D' ? { countryCode: eff.countryCode } : {}).defaultPurchaseTaxKey;
    if (purchaseKey) {
      const t = await tx.glTax.findUnique({ where: { tenantId_key: { tenantId, key: purchaseKey } }, select: { id: true } });
      if (t) await tx.glSettings.updateMany({ where: { tenantId, defaultPurchaseTaxId: null }, data: { defaultPurchaseTaxId: t.id } });
    }
    const step3Report = await applyStep3(tx, tenantId, draft);
    const context = await loadBuildContext(tx, tenantId);
    const ctx = context.ctx;
    const decimals = ctx.settings.currencyDecimals;

    // (4) الأرصدة اليدوية (الخطوة 5)
    const manual = validateManualBalanceRows(manualRowsOf(draft), ctx, { midVatPeriod: midPeriod });
    if (manual.issues.length) {
      throw new LedgerHttpError(422, 'أرصدة افتتاحية يدوية غير صالحة', { reason: 'OPENING_BALANCE_ROWS_INVALID', issues: manual.issues.slice(0, 200), count: manual.issues.length });
    }
    const vendors = await resolveVendors(tx, tenantId, manual.lines);
    const manualRepIds = [...new Set(manual.lines.map((l) => l.salesRepId).filter((x): x is string => !!x))];
    const manualReps = manualRepIds.length
      ? await tx.salesRep.findMany({ where: { tenantId, id: { in: manualRepIds } }, select: { id: true, name: true } })
      : [];
    for (const id of manualRepIds) if (!manualReps.some((r) => r.id === id)) throw new GlNotFoundError('SalesRep', id);

    // (5) إعادة حساب كل أرصدة الخطوة 4 داخل المعاملة بـT0 (الأثر < cutover و createdAt ≤ T0)
    const cut = openingCutoff(cutoverDate, eff.timezone, T0);
    const sources = await loadOpeningSources(tx, tenantId, cut);
    const derived = computeDerivedOpening(sources, cut, {
      decimals, routing: { receiptRouting: ctx.settings.receiptRouting, cashInvoiceRouting: ctx.settings.cashInvoiceRouting },
    });
    const move = buildOpeningMove({
      derived, manual: manual.lines, ctx,
      salesRepNames: { ...(sources.salesRepNames ?? {}), ...Object.fromEntries(manualReps.map((r) => [r.id, r.name])) },
    });

    // (6) قيد OPEN بتاريخ cutover − 1
    const posted = move.draft
      ? await postMove(tx, move.draft, {
        tenantId, actor, context, validationMode: 'SYSTEM', lockPolicy: 'REJECT',
        auditSummary: `ترحيل القيد الافتتاحي بتاريخ ${cut.openingDate}`,
        auditExtra: { opening: true, equityDiff: openingMoveJson(move, decimals).equityDiff },
        now: dbNow,
      })
      : null;

    // (7) openingSnapshotAt = T0 (لا now()) وactivatedAt، ثم المؤشرات، ثم RUNNING
    const settings = await tx.glSettings.update({
      where: { tenantId },
      data: {
        setupMethod: eff.method, cutoverDate: toDbDate(cutoverDate), openingSnapshotAt: T0,
        activatedAt: dbNow, activatedBy: actorId, backfillState: 'RUNNING',
      },
    });
    const watermarkAt = initialWatermarkAt({ method: eff.method, cutoverDate, openingSnapshotAt: T0, timezone: eff.timezone });
    await tx.glSyncCursor.updateMany({ where: { tenantId }, data: { watermarkAt, watermarkId: '', lastRunAt: null, lastCount: 0, stallTicks: 0 } });
    const inventoryMode = settings.inventoryMode === 'PERPETUAL' ? 'PERPETUAL' : 'PERIODIC';
    await tx.glSyncCursor.createMany({ data: initialCursorRows(tenantId, inventoryMode, watermarkAt), skipDuplicates: true });
    const futureDated = eff.method === 'OPENING'
      ? await scanFutureDatedRows(tx, tenantId, {
        watermarkAt, cutoverStart: cut.cutoverStart,
        settings: { tenantId, activatedAt: dbNow, timezone: eff.timezone, currency: company.currency ?? settings.currency, currencyDecimals: decimals },
      })
      : null;
    // تقسيم P7 للاستلامات المشمولة بالافتتاح يُجمَّد بالمجموعة نفسها التي حسبها الافتتاح (لا بالواصلة متأخرة)
    const frozenSettlements = await freezeOpeningSettlementSplits(tx, tenantId, {
      splits: derived.settlementSplits,
      settings: { tenantId, activatedAt: dbNow, timezone: eff.timezone, currency: company.currency ?? settings.currency, currencyDecimals: decimals },
      processedAt: dbNow,
    });

    const openingJson = derivedOpeningJson(derived, decimals);
    const moveJson = openingMoveJson(move, decimals);
    await appendAudit(tx, {
      tenantId, actor, action: 'SETUP_COMMIT', entityType: 'SETTINGS', entityId: settings.id,
      summary: `تفعيل النظام المحاسبي المتكامل بتاريخ بدء ${cutoverDate} (${eff.method === 'OPENING' ? 'أرصدة افتتاحية' : 'التاريخ الكامل'})`,
      after: {
        method: eff.method, cutoverDate, openingSnapshotAt: T0.toISOString(), activatedAt: dbNow.toISOString(), templateKey: eff.templateKey,
        midVatPeriod: midPeriod, preCutoverBoxes: eff.preCutoverBoxes, watermarkAt: watermarkAt.toISOString(), history, futureDated, frozenSettlements,
        seed: { created: seed.created, skipped: seed.skipped, unresolvedMappings: seed.unresolvedMappings, conflictingMappings: seed.conflictingMappings.length },
        step3: step3Report, vendorsCreated: vendors.created, manualRows: manual.lines.length,
        ...(rebasedImportEntries !== undefined ? { rebasedImportEntries } : {}),
        importedAfterCutover: importedAfterCutoverJson(importedAfterCutover, decimals),
        // البند 41: ما أقرّ به المالك بالضبط (لقطة مربوطة أو إقرار منطقي غير مربوط) — يُثبت في سجل التدقيق
        postCutoverImportsAck: typeof parsed.data.acknowledgePostCutoverImports === 'object' && parsed.data.acknowledgePostCutoverImports !== null
          ? { bound: true, ...parsed.data.acknowledgePostCutoverImports }
          : { bound: false, acknowledged: parsed.data.acknowledgePostCutoverImports === true },
        openingStockExcluded: openingStock.afterCutover.count > 0 ? openingStockJson.afterCutover : null,
        openingMove: posted ? { id: posted.id, number: posted.number, date: posted.date } : null,
        receivablesTotal: openingJson.receivablesTotal, custodyTotal: openingJson.custodyTotal, paylinkHeld: openingJson.paylinkHeld,
        warehouse: openingJson.warehouse, equityDiff: moveJson.equityDiff, totalDebit: moveJson.totalDebit, counts: openingJson.counts,
      },
    });

    return {
      status: settingsStatus(settings),
      opening: openingJson,
      move: { ...moveJson, id: posted?.id ?? null, number: posted?.number ?? null, date: posted?.date ?? cut.openingDate },
      watermarkAt,
      futureDated,
      seed: { created: seed.created, skipped: seed.skipped, unresolvedMappings: seed.unresolvedMappings, conflictingMappings: seed.conflictingMappings, conflictingAccountRefs: seed.conflictingAccountRefs },
      vendorsCreated: vendors.created,
      step3: step3Report,
      ...(rebasedImportEntries !== undefined ? { rebasedImportEntries } : {}),
    };
  }, COMMIT_TX);
  // الاستجابة بالأرقام النهائية الملتزمة لا بأرقام المعاينة
  res.status(201).json({ success: true, data: out });
}));

// ═══ POST /setup/backfill ═══

const backfillSchema = z.object({ action: z.enum(['PAUSE', 'RESUME']) }).strict();

router.post('/setup/backfill', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const { action } = backfillSchema.parse(req.body ?? {});
  const actor = actorOf(req, res);
  const out = await prisma.$transaction(async (tx) => {
    const s = await tx.glSettings.findUnique({ where: { tenantId }, select: { id: true, activatedAt: true, backfillState: true } });
    if (!s?.activatedAt) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'NOT_ACTIVATED' });
    const current = (s.backfillState || 'NONE') as BackfillState;
    const next = backfillTransition(current, action);
    if (!next) throw new LedgerHttpError(409, 'لا يمكن تغيير حالة الترحيل التاريخي من حالتها الحالية', { reason: 'BACKFILL_STATE_CONFLICT', backfillState: current, action });
    const r = await tx.glSettings.updateMany({ where: { tenantId, backfillState: current }, data: { backfillState: next } });
    if (r.count !== 1) throw new LedgerHttpError(409, 'تغيّرت حالة الترحيل التاريخي أثناء الطلب', { reason: 'BACKFILL_STATE_CONFLICT', backfillState: current, action });
    await appendAudit(tx, {
      tenantId, actor, action: 'SETTINGS_CHANGE', entityType: 'SETTINGS', entityId: s.id,
      summary: action === 'PAUSE' ? 'إيقاف مؤقت للترحيل التاريخي' : 'استئناف الترحيل التاريخي',
      before: { backfillState: current }, after: { backfillState: next },
    });
    return { backfillState: next };
  }, { timeout: 15_000, maxWait: 10_000 });
  res.json({ success: true, data: out });
}));

export default router;
