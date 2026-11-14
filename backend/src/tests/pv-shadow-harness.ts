// «ربط الدفاتر» PV — عدّة اختبار مشتركة لملفات pv-*: المُطابِق والمُرحِّل الحقيقيان فوق ظلّ المعاينة بجولات إعادة الساعة
// الافتراضية نفسها التي يجريها runPreview (POST_RETRY_ROUNDS × POST_RETRY_ADVANCE_MS). ليس ملف اختبار.
import type { Prisma } from '@prisma/client';
import { SYSTEM_ACTOR } from '../services/gl/audit';
import { scanFutureDatedRows } from '../services/gl/backfill';
import { zonedStartOfDay } from '../services/gl/dates';
import { foldCostingForPreview } from '../services/gl/linking/costingFold';
import { POST_RETRY_ADVANCE_MS, POST_RETRY_ROUNDS, defaultPreviewDeps } from '../services/gl/linking/preview';
import { createShadowClient } from '../services/gl/linking/shadowClient';
import {
  ShadowPostingStore, ShadowReconcilerStore, createPreviewShadow, enableShadowInventoryPosting, type ShadowState,
} from '../services/gl/linking/shadowStore';
import { withReadOnlySnapshot } from '../services/gl/linking/snapshot';
import type { PreviewOptions } from '../services/gl/linking/types';
import { initialWatermarkAt } from '../services/gl/sync/classify';
import { RECONCILED_SOURCES } from '../services/gl/sync/desired';
import { createSyncBudget, runPoster } from '../services/gl/sync/poster';
import { reconcileTenant } from '../services/gl/sync/reconciler';
import { FIX_LINKED_FROM, FIX_TZ, previewOptionsFor, type FakeDb } from './linking-fake-db';
import { openingSnapshotFromDbNow } from '../services/gl/opening';

export const PV_TID = 't1';
export const PV_CUTOVER_START = zonedStartOfDay(FIX_LINKED_FROM, FIX_TZ);

export function inSnapshot<T>(db: FakeDb, fn: (tx: Prisma.TransactionClient, dbNow: Date) => Promise<T>): Promise<T> {
  return withReadOnlySnapshot(db.client as never, fn);
}

export interface PvEngineResult {
  shadow: ShadowState;
  built: ReturnType<typeof createPreviewShadow>;
  /** هل فُتحت مصادر L6 في الظلّ (طيّ تكلفة بحركات، جرد مستمر) */
  inventoryPosting: boolean;
}

/** طيّ التكلفة الحقيقي (لقطات L6) ثم المُطابِق ثم المُرحِّل فوق الظلّ، ثم جولات الساعة الافتراضية — كـrunPreview بلا الافتتاح والمطابقة */
export async function runPvEngine(db: FakeDb, opts: PreviewOptions = previewOptionsFor()): Promise<PvEngineResult> {
  return inSnapshot(db, async (tx, dbNow) => {
    const built = createPreviewShadow(PV_TID, opts, dbNow);
    const { shadow } = built;
    const client = createShadowClient(tx, shadow);
    const folded = await foldCostingForPreview(defaultPreviewDeps, client, PV_TID, {
      until: dbNow, currencyDecimals: opts.currencyDecimals, cutoverDate: opts.linkedFrom, cutoverStart: PV_CUTOVER_START,
      openingSnapshotAt: openingSnapshotFromDbNow(dbNow), timezone: opts.timezone,
      ...(opts.inventoryMode === 'PERPETUAL' ? { onOutputs: (os: Parameters<ShadowState['addCostSnapshots']>[0]) => shadow.addCostSnapshots(os) } : {}),
    });
    const inventoryPosting = enableShadowInventoryPosting(built, folded);
    const wm = initialWatermarkAt({ method: 'OPENING', cutoverDate: opts.linkedFrom, openingSnapshotAt: built.t0, timezone: opts.timezone });
    for (const src of RECONCILED_SOURCES) shadow.setCursor(src, wm, '');
    await scanFutureDatedRows(client, PV_TID, { watermarkAt: wm, cutoverStart: PV_CUTOVER_START, settings: built.reconcileSettings });
    const rec = new ShadowReconcilerStore(shadow, client);
    const store = new ShadowPostingStore(shadow, client);
    const reconcile = async () => {
      for (let i = 0; i < 5; i++) {
        const r = await reconcileTenant(rec, PV_TID, { pageSize: 2000, settings: built.reconcileSettings, dbNow: shadow.now(), log: () => undefined });
        if (r.reduce((a, x) => a + x.eventsInserted + x.tailEventsInserted, 0) === 0) break;
      }
    };
    const post = async () => {
      shadow.rebuildQueues();
      for (let i = 0; i < 50; i++) {
        const r = await runPoster(store, built.posterSettings, createSyncBudget({ timeMs: 1e12, events: 1e9 }), { actor: SYSTEM_ACTOR, log: () => undefined });
        if (r.stoppedBy === 'EMPTY') break;
      }
    };
    await reconcile();
    await post();
    for (let round = 0; round < POST_RETRY_ROUNDS && shadow.hasRetryable(); round++) {
      shadow.advanceClock(POST_RETRY_ADVANCE_MS);
      await reconcile();
      await post();
    }
    return { shadow, built, inventoryPosting };
  });
}

/** ملخّص الأحداث غير المحسومة (للرسائل) */
export function unsettled(shadow: ShadowState): string[] {
  return [...shadow.events.values()].filter((e) => !['DONE', 'SKIPPED'].includes(e.status)).map((e) => `${e.sourceKey}:${e.status}:${e.lastError}`);
}

/** سطور الظلّ على حساب برمزه */
export function linesOnCode(shadow: ShadowState, code: string) {
  const acc = shadow.context.ctx.accounts.byCode(code);
  return acc ? [...shadow.linesOn(acc.id)] : [];
}

/** كل قيد في الظلّ متوازن بالملّي */
export function allBalanced(shadow: ShadowState): boolean {
  return shadow.moveList.every((m) => m.lines.reduce((a, l) => a + l.debitMilli - l.creditMilli, 0n) === 0n);
}
