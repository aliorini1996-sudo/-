/**
 * إعادة بناء الأرصدة الشهرية (M3، DESIGN.md §5.9 C2 «زر إعادة بناء»).
 *
 * داخل معاملة المُستدعي: قفل gl-post أولاً (قفل postMove نفسه، فلا يُرحَّل قيد أثناء الإعادة)، ثم مجاميع البنود المرحّلة
 * بالحساب والفترة (YYYY-MM أو YYYY-CL لقيد إقفال السنة، والعلامات مستبعدة)، ثم حذف أرصدة الشركة وإدراجها من المجاميع.
 * لا تمسّ القيود ولا سطورها.
 */
import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { acquirePostLock } from '../post';
import { evaluateC2 } from './rules';
import { createPrismaCheckStore } from './store.prisma';

export interface RebuildBalancesResult {
  deleted: number;
  inserted: number;
  /** صفوف C2 غير المتطابقة قبل الإعادة */
  mismatchesBefore: number;
}

export async function rebuildPeriodBalances(tx: Prisma.TransactionClient, tenantId: string): Promise<RebuildBalancesResult> {
  await acquirePostLock(tx, tenantId);
  const store = createPrismaCheckStore(tx);
  const [ledger, stored] = await Promise.all([store.periodLineTotals(tenantId), store.storedPeriodBalances(tenantId)]);
  const before = evaluateC2(ledger, stored);
  const del = await tx.glPeriodBalance.deleteMany({ where: { tenantId } });
  let inserted = 0;
  for (let i = 0; i < ledger.length; i += 1000) {
    const chunk = ledger.slice(i, i + 1000);
    const r = await tx.glPeriodBalance.createMany({
      data: chunk.map((t) => ({
        id: crypto.randomUUID(), tenantId, accountId: t.accountId, periodKey: t.periodKey, debitMilli: t.debitMilli, creditMilli: t.creditMilli,
      })),
    });
    inserted += r.count;
  }
  return { deleted: del.count, inserted, mismatchesBefore: before.rowCount };
}
