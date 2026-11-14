/**
 * معاينة «ربط الدفاتر بكامل النظام» (L2 — العقد §10، الخطة §3 L2 و§4). للشركات غير المفعّلة وحدها (D7).
 *
 * داخل لقطة واحدة `REPEATABLE READ READ ONLY` (snapshot.ts) — فالقاعدة نفسها تمنع أي كتابة — يُشغَّل المحرّك الحقيقي فوق ظلّ
 * في الذاكرة (D8): محرّك التكلفة، ثم القيد الافتتاحي المشتقّ (P2) يُرحَّل في الظلّ مع تجميد تقسيم الاستلامات، ثم المُطابِق
 * (reconcileTenant + scanFutureDatedRows) ثم المُرحِّل (runPoster بمساري العدالة حتى EMPTY، وتقديم الساعة الافتراضية
 * ساعتين حتى ست مرات ما بقي BLOCKED/ERROR قابل للإعادة)، ثم المطابقة R1..R13 (P4) والفحوص المسبقة FULL (P3).
 * التجميع بعد إغلاق المعاملة (في الذاكرة) فلا يُمسك اتصال القاعدة أكثر من القراءة.
 * دلالة LINKED في المُرحِّل: setupMethod 'OPENING' في الظلّ (D9، cleanStart=false — القاعدة 7: عكس ما قبل السنة من المصدر).
 * المظلم: لا شيء يستدعي هذا إلا مهمة المعاينة (jobs.ts) — لا أثر على الشركات اليدوية والحالية.
 */
import type { PrismaClient } from '@prisma/client';
import { SYSTEM_ACTOR } from '../audit';
import { freezeOpeningSettlementSplits, scanFutureDatedRows } from '../backfill';
import { addDays, todayLocal, zonedStartOfDay } from '../dates';
import {
  buildOpeningMove, openingCutoff, resolveManualPartners, validateManualBalanceRows,
  type ManualBalanceLine,
} from '../opening';
import { initialWatermarkAt } from '../sync/classify';
import { RECONCILED_SOURCES } from '../sync/desired';
import { createSyncBudget, runPoster } from '../sync/poster';
import type { PosterSettings } from '../sync/postingStore';
import { reconcileTenant, type ReconcileLogEntry, type ReconcileSettings } from '../sync/reconciler';
import { resolveLineAccount } from '../validate';
import { loadMoves } from '../../costing/streams';
import { CostingTooLargeError, foldCostingForPreview } from './costingFold';
import { replay } from '../../costing/stepper';
import { summarizeCosting } from '../../costing/summary';
import {
  balanceSheetToday, etaAndStorage, eventCounts, heldByPartner, heldLines, openingPreview, pnlYtd, shadowCounts,
  trialBalanceByMonth, vatByPeriodBox,
} from './aggregate';
import { computeDataHash, computeResultHash, loadPreCutoverSourceStats } from './dataHash';
import { loadLinkedOpening } from './openingLinked';
import { loadOperationalFacts, runParity } from './parity';
import { runPreflight } from './preflight';
import { ShadowGlAccessError, createShadowClient } from './shadowClient';
import {
  ShadowPostingStore, ShadowReconcilerStore, ShadowState, ShadowTooLargeError, createPreviewShadow, shadowBalanceView,
} from './shadowStore';
import { withReadOnlySnapshot } from './snapshot';
import {
  PREVIEW_LIST_CAPS, PREVIEW_MAX_EVENTS, PREVIEW_PHASE_PCT,
  type PreflightEventStats, type PreviewDeps, type PreviewErrorCode, type PreviewHooks, type PreviewOptions, type PreviewPhase,
  type PreviewResult, type PreviewWarning,
} from './types';

// ═══ الأخطاء ═══

/** فشل المعاينة برمز معروف (TOO_LARGE، ALREADY_ACTIVATED…) ورسالة عربية للمالك */
export class PreviewRunError extends Error {
  constructor(readonly code: PreviewErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PreviewRunError';
  }
}

/** رمز الفشل لصفّ GlLinkPreview: ShadowGlAccessError ⇒ SHADOW_GL_ACCESS، PreviewRunError برمزه، وغيرهما INTERNAL */
export function previewErrorCodeOf(e: unknown): PreviewErrorCode {
  if (e instanceof ShadowGlAccessError) return 'SHADOW_GL_ACCESS';
  if (e instanceof PreviewRunError) return e.code;
  if (e instanceof ShadowTooLargeError || e instanceof CostingTooLargeError) return 'TOO_LARGE';
  // P2028: انتهت مهلة معاملة اللقطة (PREVIEW_TX_TIMEOUT_MS) قبل مهلة المهمة
  if (e && typeof e === 'object' && (e as { code?: unknown }).code === 'P2028') return 'TIMEOUT';
  return 'INTERNAL';
}

export const PREVIEW_ERROR_MESSAGES: Readonly<Record<PreviewErrorCode, string>> = {
  INTERRUPTED: 'انقطعت المعاينة (أُعيد تشغيل الخادم) — شغّلها من جديد',
  TIMEOUT: 'تجاوزت المعاينة مهلتها — شغّلها خارج الذروة أو تواصل مع الدعم',
  TOO_LARGE: 'حجم بيانات الشركة يتجاوز سقف المعاينة على المنصّة — تواصل مع الدعم',
  SHADOW_GL_ACCESS: 'توقّفت المعاينة احترازياً: حاولت قراءة دفاتر غير مدعومة — لم تُعرض أرقام غير موثوقة',
  ALREADY_ACTIVATED: 'الدفاتر مفعّلة لهذه الشركة — معاينة الربط لغير المفعّلة وحدها',
  INTERNAL: 'تعذّر إكمال المعاينة — راجع سجلّ الخادم',
};

// ═══ الاعتماديات ═══

export const defaultPreviewDeps: PreviewDeps = {
  loadMoves, replay, summarizeCosting, loadLinkedOpening, runPreflight, loadOperationalFacts, runParity,
};

/** جولات إعادة المُرحِّل بعد تقديم الساعة الافتراضية، ومقدار التقديم */
export const POST_RETRY_ROUNDS = 6;
export const POST_RETRY_ADVANCE_MS = 2 * 60 * 60_000;
/** سقف تمريرات المُطابِق (التمريرة الثانية تكفي عادةً: الذيل يُعاد بلا إدراج) */
const MAX_RECONCILE_PASSES = 20;
/** سقف تشغيلات المُرحِّل في الجولة (كل تشغيل يقف عند قاطع النبضة 60 ثانية أو EMPTY) */
const MAX_POSTER_RUNS = 100_000;
/** نبض التقدّم داخل POST: مرة في الثانية على الأكثر */
const POST_PROGRESS_MS = 1_000;
/** تخلٍّ عن حلقة الأحداث كل هذا العدد من معاملات المُرحِّل في الظلّ */
export const POST_YIELD_EVERY_TX = 500;
/** نبض النشاط في المراحل الأخرى (قراءات اللقطة): أقلّ بكثير من PREVIEW_STALE_MS (دقيقتان) */
export const ACTIVITY_BEAT_MS = 15_000;

function assertNoViolation(shadow: ShadowState): void {
  if (shadow.glViolations.length > 0) throw new ShadowGlAccessError(shadow.glViolations[0]);
  if (shadow.tooLarge) {
    throw new PreviewRunError('TOO_LARGE', PREVIEW_ERROR_MESSAGES.TOO_LARGE, { events: shadow.events.size, maxEvents: shadow.maxEvents });
  }
}

/** موردو الأرصدة اليدوية بالاسم وحده: الاعتماد ينشئ GlVendor لكل اسم (resolveVendors)؛ الظلّ يعطيه معرّفاً افتراضياً ثابتاً */
function virtualVendors(lines: ManualBalanceLine[]): number {
  let n = 0;
  for (const l of lines) {
    if (l.account.controlKind !== 'AP' || l.vendorId) continue;
    const name = (l.vendorName ?? '').trim();
    if (!name) continue;
    l.vendorId = `pv-vendor:${name.toLowerCase()}`;
    l.vendorName = name;
    n++;
  }
  return n;
}

async function reconcileAll(store: ShadowReconcilerStore, shadow: ShadowState, settings: ReconcileSettings, stalls: ReconcileLogEntry[]): Promise<void> {
  for (let i = 0; i < MAX_RECONCILE_PASSES; i++) {
    const res = await reconcileTenant(store, shadow.tenantId, {
      pageSize: 2000, settings, dbNow: shadow.now(), log: (e) => { if (stalls.length < 20) stalls.push(e); },
    });
    assertNoViolation(shadow);
    const inserted = res.reduce((a, r) => a + r.eventsInserted + r.tailEventsInserted, 0);
    if (inserted === 0) return;
  }
}

async function drainPoster(store: ShadowPostingStore, shadow: ShadowState, settings: PosterSettings): Promise<void> {
  for (let i = 0; i < MAX_POSTER_RUNS; i++) {
    const r = await runPoster(store, settings, createSyncBudget({ timeMs: 1e12, events: 1e9 }), { actor: SYSTEM_ACTOR, log: () => undefined });
    if (shadow.glViolations.length > 0 || shadow.tooLarge) return;
    if (r.stoppedBy === 'EMPTY') return;
  }
}

// ═══ التشغيل ═══

export async function runPreview(
  db: { $transaction: PrismaClient['$transaction'] }, tenantId: string, opts: PreviewOptions,
  hooks: PreviewHooks = {}, deps: PreviewDeps = defaultPreviewDeps,
): Promise<PreviewResult> {
  if (opts.settingsRow?.activatedAt) {
    throw new PreviewRunError('ALREADY_ACTIVATED', PREVIEW_ERROR_MESSAGES.ALREADY_ACTIVATED);
  }
  const clock = hooks.clock ?? Date.now;
  const timings: { phase: PreviewPhase; ms: number }[] = [];
  let phase: PreviewPhase | null = null;
  let phaseStart = clock();
  let lastPct = 0;
  let lastBeatAt = clock();
  const progress = async (p: PreviewPhase, pct: number) => {
    lastPct = pct;
    lastBeatAt = clock();
    if (hooks.onProgress) await hooks.onProgress(p, pct);
  };
  const enter = async (next: PreviewPhase) => {
    const t = clock();
    if (phase) timings.push({ phase, ms: t - phaseStart });
    phase = next;
    phaseStart = t;
    await progress(next, PREVIEW_PHASE_PCT[next]);
  };
  /** نبض بلا انتظار من داخل القراءات (العميل الحارس) — أخطاؤه لا تمسّ المعاينة */
  const activityBeat = () => {
    if (!hooks.onProgress || !phase) return;
    const t = clock();
    if (t - lastBeatAt < ACTIVITY_BEAT_MS) return;
    lastBeatAt = t;
    void Promise.resolve().then(() => hooks.onProgress!(phase as PreviewPhase, lastPct)).catch(() => undefined);
  };

  const tz = opts.timezone;
  const dec = opts.currencyDecimals;
  const linkedFrom = opts.linkedFrom;
  const openingDate = addDays(linkedFrom, -1);
  const cutoverStart = zonedStartOfDay(linkedFrom, tz);
  const warnings: PreviewWarning[] = [];
  let shadowRef: ShadowState | null = null;

  try {
    const c = await withReadOnlySnapshot(db, async (tx, dbNow) => {
      await enter('READ');
      // حارس على الصفّ الحقيقي داخل اللقطة (سباق تفعيلٍ بين قراءة المهمة وبدء اللقطة) — قراءة مباشرة لا عبر الظلّ
      const real = await tx.glSettings.findUnique({ where: { tenantId }, select: { activatedAt: true } });
      if (real?.activatedAt) throw new PreviewRunError('ALREADY_ACTIVATED', PREVIEW_ERROR_MESSAGES.ALREADY_ACTIVATED);

      const built = createPreviewShadow(tenantId, opts, dbNow, opts.limits?.maxEvents ?? PREVIEW_MAX_EVENTS);
      const { shadow, reconcileSettings, posterSettings } = built;
      const T0 = built.t0;
      shadowRef = shadow;
      shadow.activity = activityBeat;
      if (built.unknownCategoryAccounts.length) {
        warnings.push({
          code: 'CATEGORY_ACCOUNT_UNKNOWN', count: built.unknownCategoryAccounts.length,
          message: `حسابات دخل الفئات غير موجودة في الدليل (${built.unknownCategoryAccounts.join('، ')}) — بنودها على حساب المبيعات العام`,
        });
      }
      const client = createShadowClient(tx, shadow);

      // ── COSTING ── طيٌّ تزايدي على دفعات (costingFold.ts): لا يبقى التاريخ كله حركاتٍ ونواتج في الذاكرة، وسقفٌ ⇒ TOO_LARGE
      await enter('COSTING');
      const folded = await foldCostingForPreview(deps, client, tenantId, {
        until: dbNow, currencyDecimals: dec, cutoverDate: linkedFrom, cutoverStart, openingSnapshotAt: T0, timezone: tz,
        batchMoves: opts.limits?.costBatchMoves, maxMoves: opts.limits?.maxCostMoves,
        onBatch: () => { assertNoViolation(shadow); activityBeat(); },
      });
      assertNoViolation(shadow);
      const summary = folded.summary;
      const costSnapshots = folded.snapshots;

      // ── OPENING ──
      await enter('OPENING');
      const cut = openingCutoff(linkedFrom, tz, T0);
      const linked = await deps.loadLinkedOpening(client, tenantId, {
        cut, decimals: dec, routing: { receiptRouting: opts.receiptRouting, cashInvoiceRouting: opts.cashInvoiceRouting },
        inventory: opts.inventoryMode === 'PERPETUAL' ? summary.openingByLocation : null,
      });
      // المخزون مشتقٌّ في الجرد المستمر وحده: في الدوري (OD7) رصيده الافتتاحي يدويٌّ يُقبل ويدخل القيد (لا سطور مشتقّة له)
      const manual = validateManualBalanceRows(opts.manualRows, shadow.context.ctx, {
        midVatPeriod: opts.midVatPeriod, derivedAccounts: true, derivedInventory: opts.inventoryMode === 'PERPETUAL',
      });
      const partners = await resolveManualPartners(client, tenantId, manual.lines);
      const badRows = new Set(partners.issues.map((i) => i.index));
      const manualLines = manual.lines.filter((l) => !badRows.has(l.index));
      const vendors = virtualVendors(manualLines);
      if (vendors) warnings.push({ code: 'VIRTUAL_VENDORS', count: vendors, message: 'موردو الأرصدة اليدوية بأسمائهم يُنشؤون عند الاعتماد' });
      const manualIssues = [...manual.issues, ...partners.issues];
      if (manualIssues.length) {
        warnings.push({ code: 'MANUAL_ROWS_INVALID', count: manualIssues.length, message: 'صفوف أرصدة يدوية غير صالحة لم تدخل القيد الافتتاحي' });
      }
      const opening = buildOpeningMove({
        openingDate, manual: manualLines, ctx: shadow.context.ctx, salesRepNames: partners.salesRepNames, derived: linked.derived,
      });
      // تاريخ القيد = linkedFrom − 1 والإقفال يفحصه P4 في الـpreflight؛ القيد يُرحَّل في الظلّ كما سيُرحَّل عند الاعتماد
      if (opening.draft) shadow.postDraft(opening.draft, { validationMode: 'SYSTEM', lockPolicy: 'NONE', createSource: false });
      await freezeOpeningSettlementSplits(client, tenantId, { splits: linked.settlementSplits, settings: reconcileSettings, processedAt: dbNow });
      assertNoViolation(shadow);
      const preCutoverSources = await loadPreCutoverSourceStats(client, tenantId, cutoverStart, dec);
      const derivedCount = opening.derivedLineCount ?? 0;
      const dataHash = computeDataHash({
        settings: {
          basis: opts.basis, linkedFrom, timezone: tz, currency: opts.currency, currencyDecimals: dec, templateKey: opts.templateKey,
          countryCode: opts.countryCode, fyEnd: { month: opts.fiscalYearEndMonth, day: opts.fiscalYearEndDay },
          receiptRouting: opts.receiptRouting, cashInvoiceRouting: opts.cashInvoiceRouting, inventoryMode: opts.inventoryMode,
          categoryIncomeAccounts: opts.categoryIncomeAccounts,
        },
        manualRows: opts.manualRows,
        derivedLines: (opening.draft?.lines ?? []).slice(0, derivedCount).map((l) => ({
          account: resolveLineAccount(l, shadow.context.ctx.accounts)?.code ?? l.accountCode ?? l.accountKey ?? '',
          partner: l.customerId ?? l.salesRepId ?? l.vendorId ?? null,
          milli: l.debitMilli - l.creditMilli,
        })),
        costingOpening: summary.openingByLocation,
        preCutoverSources,
      });

      // ── RECONCILE ──
      await enter('RECONCILE');
      const watermarkAt = initialWatermarkAt({ method: 'OPENING', cutoverDate: linkedFrom, openingSnapshotAt: T0, timezone: tz });
      for (const s of RECONCILED_SOURCES) shadow.setCursor(s, watermarkAt, '');
      await scanFutureDatedRows(client, tenantId, { watermarkAt, cutoverStart, settings: reconcileSettings });
      assertNoViolation(shadow);
      const recStore = new ShadowReconcilerStore(shadow, client);
      const stalls: ReconcileLogEntry[] = [];
      await reconcileAll(recStore, shadow, reconcileSettings, stalls);

      // ── POST ──
      await enter('POST');
      const total = Math.max(1, shadow.countPending());
      const store = new ShadowPostingStore(shadow, client, {
        afterTx: async () => {
          // ذيل POST كله في الذاكرة (وعودٌ محلولة): تخلٍّ دوري عن حلقة الأحداث كي لا يتجمّد ما يشاركها ثوانيَ
          if (shadow.postTxCount % POST_YIELD_EVERY_TX === 0) await new Promise<void>((r) => setImmediate(r));
          if (!hooks.onProgress || clock() - lastBeatAt < POST_PROGRESS_MS) return;
          const pct = PREVIEW_PHASE_PCT.POST + Math.floor(((PREVIEW_PHASE_PCT.PARITY - 3 - PREVIEW_PHASE_PCT.POST) * Math.min(total, shadow.postTxCount)) / total);
          await progress('POST', Math.max(lastPct, pct));
        },
      });
      shadow.rebuildQueues();
      await drainPoster(store, shadow, posterSettings);
      assertNoViolation(shadow);
      for (let round = 0; round < POST_RETRY_ROUNDS && shadow.hasRetryable(); round++) {
        // ما يحجبه الزمن وحده (ترتيب P7 بعد نافذة الالتزام المتأخر، سلّم التراجع): الساعة الافتراضية تتقدّم والمؤشرات تلحق
        shadow.advanceClock(POST_RETRY_ADVANCE_MS);
        await reconcileAll(recStore, shadow, reconcileSettings, stalls);
        shadow.rebuildQueues();
        await drainPoster(store, shadow, posterSettings);
        assertNoViolation(shadow);
      }
      if (stalls.length) warnings.push({ code: 'RECONCILE_STALLED', count: stalls.length, message: 'توقّف مؤشر المُطابِق في المعاينة — راجع سجلّ الخادم' });
      const leftover = [...shadow.events.values()].filter((e) => e.status === 'BLOCKED' || e.status === 'ERROR' || e.status === 'PENDING').length;
      if (leftover) warnings.push({ code: 'POSTER_INCOMPLETE', count: leftover, message: 'أحداث لم تُحسم بعد كل جولات المعاينة — معروضة في السطور المحجوزة' });

      // ── PARITY ──
      await enter('PARITY');
      const ops = await deps.loadOperationalFacts(client, tenantId, {
        snapshotAt: T0, dbNow, linkedFrom, cutoverStart, timezone: tz, currencyDecimals: dec,
      });
      assertNoViolation(shadow);
      const parity = deps.runParity(shadowBalanceView(shadow), ops, {
        linkedFrom, openingDate, currencyDecimals: dec, openingEquityDiffMilli: opening.equityDiffMilli, costing: summary,
        heldByPartner: heldByPartner(shadow), inventoryMode: opts.inventoryMode,
      });

      // ── PREFLIGHT ──
      await enter('PREFLIGHT');
      const counts = shadowCounts(shadow);
      // التخزين المقيس نفسه الذي يعرضه قسم «الوقت والتخزين» — فيطابقه P13 حرفياً
      const measured = etaAndStorage({ ...counts, costSnapshots }).storage;
      const eventStats: PreflightEventStats = {
        eventsToPost: counts.eventsToPost, autoSalePercents: [...shadow.autoSalePercents].sort((a, b) => a - b), byType: counts.byType,
        storage: { rows: measured.rows.total, bytesEstimate: measured.bytesEstimate },
      };
      const preflight = await deps.runPreflight(client, tenantId, {
        mode: 'FULL', basis: opts.basis, linkedFrom, timezone: tz, templateKey: opts.templateKey, currency: opts.currency,
        currencyDecimals: dec, receiptRouting: opts.receiptRouting, cashInvoiceRouting: opts.cashInvoiceRouting,
        settingsRow: opts.settingsRow, draft: opts.draft, suiteEnabled: opts.suiteEnabled, workerEnabled: opts.workerEnabled,
        now: dbNow, inventoryMode: opts.inventoryMode, costing: summary, eventStats,
      });
      assertNoViolation(shadow);
      return {
        shadow, dbNow, T0, summary, sourceRows: folded.sourceRows, costSnapshots, opening, manualIssues,
        dataHash, parity, preflight, counts,
      };
    }, { timeoutMs: opts.limits?.txTimeoutMs });

    // ── التجميع (بعد إغلاق المعاملة) ──
    const { shadow } = c;
    const ctx = shadow.context;
    const asOf = todayLocal(c.dbNow, tz);
    const statement = { asOf, fiscalYearEndMonth: opts.fiscalYearEndMonth, fiscalYearEndDay: opts.fiscalYearEndDay };
    const held = heldLines(shadow, PREVIEW_LIST_CAPS.heldLines);
    const es = etaAndStorage({ ...c.counts, costSnapshots: c.costSnapshots });
    const body: Omit<PreviewResult, 'resultHash' | 'timings'> = {
      version: 1,
      tenantId,
      basis: opts.basis,
      linkedFrom,
      openingDate,
      snapshotAt: c.T0.toISOString(),
      dbNow: c.dbNow.toISOString(),
      currency: opts.currency,
      currencyDecimals: dec,
      timezone: tz,
      templateKey: opts.templateKey,
      inventoryMode: opts.inventoryMode,
      dataHash: c.dataHash,
      opening: openingPreview(c.opening.draft, c.opening, ctx, c.manualIssues, PREVIEW_LIST_CAPS.openingLines, openingDate),
      eventCounts: eventCounts(shadow),
      trialBalanceByMonth: trialBalanceByMonth(shadow, ctx, linkedFrom, asOf),
      pnlYtd: pnlYtd(shadow, ctx, statement),
      balanceSheet: balanceSheetToday(shadow, ctx, statement),
      vatByPeriodBox: vatByPeriodBox(shadow, ctx, opts.taxPeriodicity, { month: opts.fiscalYearEndMonth, day: opts.fiscalYearEndDay }),
      parity: c.parity,
      preflight: c.preflight,
      heldLines: held.lines,
      heldTruncated: held.truncated,
      costing: { summary: c.summary, sourceRows: c.sourceRows },
      eta: es.eta,
      storage: es.storage,
      warnings,
    };
    const resultHash = computeResultHash(body);
    await enter('DONE');
    return { ...body, resultHash, timings };
  } catch (e) {
    const sh = shadowRef as ShadowState | null;
    // وصول gl* مرفوض يتقدّم على أي خطأ لاحق نتج عنه (فشل مغلق)
    if (sh && sh.glViolations.length > 0 && !(e instanceof ShadowGlAccessError)) throw new ShadowGlAccessError(sh.glViolations[0]);
    if (e instanceof CostingTooLargeError) {
      throw new PreviewRunError('TOO_LARGE', PREVIEW_ERROR_MESSAGES.TOO_LARGE, { costMoves: e.moves, maxCostMoves: e.maxMoves });
    }
    if (e instanceof ShadowTooLargeError) {
      throw new PreviewRunError('TOO_LARGE', PREVIEW_ERROR_MESSAGES.TOO_LARGE, { events: e.events, maxEvents: e.maxEvents });
    }
    throw e;
  }
}
