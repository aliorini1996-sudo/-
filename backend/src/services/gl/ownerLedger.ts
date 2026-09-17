/**
 * مساعدات شاشة مالك المنصة للدفاتر (M3، DESIGN.md §8.1، §5.7، §3.9، §9.3، §10.3 D2).
 * صرفة بلا prisma: حالة الدفاتر في قائمة الشركات، وتجميع العمولات غير المرحّلة المتأثرة بتاريخ D2،
 * ونصوص إشعارات إعادة الضبط وتغيير التاريخ.
 */
import { formatMilli, toMilli } from './money';
import type { GlResetModel } from './reset';
import type { LocalDate, Milli } from './types';

// ═══ ledgerStatus (§8.1 M3) ═══

export const LEDGER_OWNER_STATUSES = ['OFF', 'PENDING_SETUP', 'RUNNING', 'STUCK'] as const;
export type LedgerOwnerStatus = (typeof LEDGER_OWNER_STATUSES)[number];

/** الحالات التي يحمرّ لها C8 بعد 24 ساعة (§5.9) */
export const LEDGER_STUCK_EVENT_STATUSES = ['ERROR', 'HELD', 'BLOCKED'] as const;
export const LEDGER_STUCK_AGE_MS = 24 * 60 * 60 * 1000;

/** detectedAt < now − 24h */
export function ledgerStuckCutoff(now: Date): Date {
  return new Date(now.getTime() - LEDGER_STUCK_AGE_MS);
}

export interface LedgerStatusInput {
  accountingSuiteEnabled: boolean | null | undefined;
  accountingEnabled: boolean | null | undefined;
  activatedAt: Date | null | undefined;
  /** عدد الأحداث المتعثرة من groupBy الواحد (0 إن لم تظهر الشركة فيه) */
  stuckEvents: number;
}

export function ledgerStatusOf(i: LedgerStatusInput): LedgerOwnerStatus {
  if (i.accountingSuiteEnabled !== true || i.accountingEnabled === false) return 'OFF';
  if (!i.activatedAt) return 'PENDING_SETUP';
  if (i.stuckEvents > 0) return 'STUCK';
  return 'RUNNING';
}

/** خريطة tenantId ⇒ العدد من نتيجة groupBy({by:['tenantId'], _count:{_all:true}}) */
export function stuckCountsByTenant(rows: readonly { tenantId: string; _count: { _all: number } | number | null | undefined }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const c = typeof r._count === 'number' ? r._count : r._count?._all ?? 0;
    out.set(r.tenantId, (out.get(r.tenantId) ?? 0) + c);
  }
  return out;
}

// ═══ D2: العمولات غير المرحّلة المتأثرة (§8.1) ═══

export interface PendingFeesAffected {
  count: number;
  /** مجموع feeGross بالملّي (رقم آمن للعرض) */
  feeMilli: number;
  /** نص عشري بمنازل العملة */
  fee: string;
}

/**
 * العمولات (SettlementEntry kind=FEE، amount = −feeGross) بتاريخ ≥ from التي لم تبلغ حالة نهائية (DONE/SKIPPED):
 * PENDING أو ERROR أو HELD أو BLOCKED، وما لم يلتقطه المُطابِق أو الترحيل التاريخي بعد.
 */
export function summarizePendingFees(
  fees: readonly { id: string; amount: number | string }[],
  finalSourceIds: ReadonlySet<string>,
  currencyDecimals: number,
): PendingFeesAffected {
  let count = 0;
  let total: Milli = 0n;
  for (const f of fees) {
    if (finalSourceIds.has(f.id)) continue;
    const m = toMilli(f.amount, currencyDecimals);
    total += m < 0n ? -m : m;
    count++;
  }
  return { count, feeMilli: Number(total), fee: formatMilli(total, currencyDecimals) };
}

// ═══ الإشعارات والتدقيق ═══

export function ledgerResetSummary(counts: Record<GlResetModel, number>): { total: number; text: string } {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { total, text: `إعادة ضبط الدفاتر: حُذف ${total} صفاً من جداول الدفاتر (سجل التدقيق محفوظ)` };
}

export function paylinkFeeInvoiceFromSummary(before: LocalDate | null, after: LocalDate | null): string {
  return `تاريخ بداية الفواتير الضريبية لعمولة الدفع الإلكتروني: ${before ?? '—'} ← ${after ?? '—'}`;
}
