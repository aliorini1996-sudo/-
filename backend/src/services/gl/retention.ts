/**
 * ضمانة الحفظ G6 (M3، DESIGN.md §3.9، §5.3، §8.1، §9.5 G6 (د) و(ط)، ملحق ب LEDGER_RETENTION_ACTIVE).
 *
 * صرفة بلا I/O:
 *  - ledgerRetentionUntil: نهاية السنة المالية التي يقع فيها آخر قيد مرحَّل + 10 سنوات.
 *  - tenantDeleteRetentionGuard: قرار حارس DELETE /api/tenants/:id **قبل** أول عبارة حذف وقبل قراءة confirmLedgerDestroy:
 *      لا قيد مرحَّل ⇒ ALLOW (كما اليوم)؛ اليوم بتوقيت الشركة ≤ retentionUntil ⇒ RETENTION_ACTIVE (409 بلا أي تجاوز)؛
 *      بعدها ⇒ EXPIRED، ثم يقرأ المسار ?confirmLedgerDestroy=1 (استعلام لا جسم) وإلا 409 LEDGER_HAS_POSTED_MOVES.
 */
import { DEFAULT_TIMEZONE, compareLocalDate, daysInMonth, fiscalYearEnd, fromDbDate, isLocalDate, todayLocal } from './dates';
import type { LocalDate } from './types';

export const LEDGER_RETENTION_YEARS = 10;

export interface LedgerRetentionInput {
  /** تاريخ آخر قيد مرحَّل (المحلي أو عمود @db.Date)؛ null ⇒ لا قيود مرحّلة */
  lastPostedDate: LocalDate | Date | null;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
}

/** 2027-05-10 بسنة 12/31 ⇒ 2037-12-31؛ بسنة 06/30 ⇒ 2037-06-30؛ 2027-07-01 بسنة 06/30 ⇒ 2038-06-30. null بلا قيود. */
export function ledgerRetentionUntil(input: LedgerRetentionInput): LocalDate | null {
  const { lastPostedDate } = input;
  if (lastPostedDate === null || lastPostedDate === undefined) return null;
  const last = lastPostedDate instanceof Date ? fromDbDate(lastPostedDate) : lastPostedDate;
  if (!isLocalDate(last)) throw new RangeError(`lastPostedDate غير صالح: ${String(lastPostedDate)}`);
  const fyEnd = fiscalYearEnd(last, input.fiscalYearEndMonth, input.fiscalYearEndDay);
  const year = Number(fyEnd.slice(0, 4)) + LEDGER_RETENTION_YEARS;
  const month = input.fiscalYearEndMonth;
  const day = Math.min(input.fiscalYearEndDay, daysInMonth(year, month));
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface RetentionGuardInput extends LedgerRetentionInput {
  /** glMove.count({tenantId, state:'POSTED'}) */
  postedMoves: number;
  timezone?: string | null;
  now: Date;
}

export type RetentionGuardDecision =
  /** لا قيد مرحَّل: الحذف كما اليوم */
  | { action: 'ALLOW'; postedMoves: 0; retentionUntil: null }
  /** 409 LEDGER_RETENTION_ACTIVE {retentionUntil, postedMoves} — لا معامل يتجاوزه */
  | { action: 'RETENTION_ACTIVE'; postedMoves: number; retentionUntil: LocalDate }
  /** انقضت المدة: يلزم ?confirmLedgerDestroy=1 وإلا 409 LEDGER_HAS_POSTED_MOVES */
  | { action: 'EXPIRED'; postedMoves: number; retentionUntil: LocalDate };

export function tenantDeleteRetentionGuard(input: RetentionGuardInput): RetentionGuardDecision {
  if (!(input.postedMoves > 0)) return { action: 'ALLOW', postedMoves: 0, retentionUntil: null };
  const retentionUntil = ledgerRetentionUntil(input);
  if (retentionUntil === null) {
    // قيود مرحّلة بلا تاريخ معروف: الأحوط اعتبار المدة سارية بلا حد معروف ⇒ يُرفض ولا يُتجاوز
    throw new RangeError('postedMoves > 0 يتطلب lastPostedDate');
  }
  const today = todayLocal(input.now, input.timezone || DEFAULT_TIMEZONE);
  if (compareLocalDate(today, retentionUntil) <= 0) {
    return { action: 'RETENTION_ACTIVE', postedMoves: input.postedMoves, retentionUntil };
  }
  return { action: 'EXPIRED', postedMoves: input.postedMoves, retentionUntil };
}

/** ?confirmLedgerDestroy=1 حرفياً من req.query (لا جسم في DELETE) */
export function isLedgerDestroyConfirmed(queryValue: unknown): boolean {
  return queryValue === '1' || (Array.isArray(queryValue) && queryValue.length === 1 && queryValue[0] === '1');
}

/** نص 409 LEDGER_RETENTION_ACTIVE (§3.9) */
export function retentionActiveMessage(retentionUntil: LocalDate): string {
  return `للشركة سجلات محاسبية نظامية محفوظة حتى ${retentionUntil} — أوقف الشركة بدل حذفها`;
}

/**
 * قرار الحفظ المعاد داخل معاملة الحذف (تحت قفل gl-post) اختلف عن قرار ما قبل المعاملة — تُرمى لإسقاط المعاملة كلها
 * فلا يُحذف شيء، ويحوّلها المسار 409 (§9.5 G6 (د)).
 */
export class RetentionChangedError extends Error {
  constructor(readonly decision: RetentionGuardDecision) {
    super(`RETENTION_CHANGED:${decision.action}`);
    this.name = 'RetentionChangedError';
    Object.setPrototypeOf(this, RetentionChangedError.prototype);
  }
}
