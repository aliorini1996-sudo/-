/**
 * «ربط الدفاتر» L8 — تقرير «مستندات وصلت متأخرة» (عقد §6.2، B15). **صرف تماماً**.
 *
 * قيد آلي أُزيح عن تاريخ مستنده (ADR‑7) لأحد سببين، ويُحفظ له `originalDate` و`lateArrival`:
 * - AFTER_CUTOVER: مستند تاريخه قبل بداية الدفاتر (`linkedFrom`، وإلا `cutoverDate`) أُنشئ بعد لقطة البدء، فرُحّل بتاريخ البدء.
 * - PERIOD_LOCKED: تاريخ مستنده في فترة مقفلة (إقفال المبيعات/المشتريات/الضريبة/النهائي) فرُحّل بأول يوم مفتوح.
 * المصدر: `GlMove.lateArrival = true` أو `originalDate ≠ date`.
 */
import { fromMilli } from '../money';
import type { LocalDate, Milli } from '../types';

export type LateArrivalReason = 'PERIOD_LOCKED' | 'AFTER_CUTOVER';

export interface LateArrivalMoveInput {
  moveId: string;
  moveNumber: string | null;
  sourceType: string | null;
  sourceId: string | null;
  ref: string | null;
  partnerName: string | null;
  /** تاريخ القيد كما رُحّل */
  date: LocalDate;
  originalDate: LocalDate | null;
  lateArrival: boolean;
  totalMilli: Milli;
}

export interface LateArrivalRow {
  moveId: string;
  moveNumber: string | null;
  sourceType: string | null;
  sourceId: string | null;
  ref: string | null;
  partnerName: string | null;
  originalDate: LocalDate;
  postedDate: LocalDate;
  reason: LateArrivalReason;
  amountMilli: Milli;
}

/** هل القيد وصل متأخراً؟ */
export function isLateArrival(m: Pick<LateArrivalMoveInput, 'lateArrival' | 'originalDate' | 'date'>): boolean {
  return m.lateArrival || (m.originalDate !== null && m.originalDate !== m.date);
}

/** السبب: أصلٌ قبل بداية الدفاتر ⇒ AFTER_CUTOVER، وإلا إقفال فترة */
export function lateArrivalReason(originalDate: LocalDate, cutoverDate: LocalDate | null): LateArrivalReason {
  return cutoverDate !== null && originalDate < cutoverDate ? 'AFTER_CUTOVER' : 'PERIOD_LOCKED';
}

export function buildLateArrivals(
  moves: readonly LateArrivalMoveInput[],
  opts: { cutoverDate: LocalDate | null },
): { rows: LateArrivalRow[]; totalMilli: Milli; count: number } {
  const rows: LateArrivalRow[] = [];
  let total = 0n;
  for (const m of moves) {
    if (!isLateArrival(m)) continue;
    const originalDate = m.originalDate ?? m.date;
    rows.push({
      moveId: m.moveId, moveNumber: m.moveNumber, sourceType: m.sourceType, sourceId: m.sourceId, ref: m.ref,
      partnerName: m.partnerName, originalDate, postedDate: m.date, reason: lateArrivalReason(originalDate, opts.cutoverDate),
      amountMilli: m.totalMilli,
    });
    total += m.totalMilli;
  }
  rows.sort((a, b) => {
    if (a.postedDate !== b.postedDate) return a.postedDate < b.postedDate ? -1 : 1;
    const na = a.moveNumber ?? '';
    const nb = b.moveNumber ?? '';
    if (na !== nb) return na < nb ? -1 : 1;
    return a.moveId < b.moveId ? -1 : a.moveId > b.moveId ? 1 : 0;
  });
  return { rows, totalMilli: total, count: rows.length };
}

export function serializeLateArrivals(r: { rows: LateArrivalRow[]; totalMilli: Milli; count: number }): Record<string, unknown> {
  return {
    rows: r.rows.map((x) => ({
      moveId: x.moveId, moveNumber: x.moveNumber, sourceType: x.sourceType, sourceId: x.sourceId, ref: x.ref,
      partnerName: x.partnerName, originalDate: x.originalDate, postedDate: x.postedDate, reason: x.reason,
      amount: fromMilli(x.amountMilli),
    })),
    total: fromMilli(r.totalMilli),
    count: r.count,
  };
}
