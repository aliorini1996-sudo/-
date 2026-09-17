/**
 * تاريخ الفواتير الضريبية لعمولة الدفع الإلكتروني — قرار D2 (M3، DESIGN.md §8.1، §5.5 P9، §10.3 D2، ملحق ب).
 *
 * صرفة بلا I/O. يستدعيها مسار المالك PUT /api/tenants/:id/ledger-paylink-fee-invoice-from داخل معاملة تحت قفل gl-post:
 *  - تعديل تاريخ قائم أو مسحه بعد ترحيل عمولة تاريخها المحلي ≥ التاريخ القائم ⇒ 409 LEDGER_PAYLINK_FEE_INVOICE_DATE_LOCKED.
 *  - from يجب أن يكون **بعد** التاريخ المحلي لآخر عمولة مرحّلة (PAYLINK_FEE بحالة DONE) وبعد taxLockDate وhardLockDate،
 *    ولا يتجاوز today + 90 يوماً (منعاً لخطأ إدخال السنة) ⇒ وإلا 422 LEDGER_PAYLINK_FEE_INVOICE_DATE_INVALID.
 *  - الماضي جائز ما دام بعد آخر عمولة مرحّلة والإقفالات؛ العمولات غير المرحّلة لا تمنع الحفظ (تتبع التاريخ الساري لحظة ترحيلها).
 * فلا تتغير معاملة أي عمولة مرحّلة.
 */
import { addDays, compareLocalDate, fromDbDate, isLocalDate } from './dates';
import type { LocalDate } from './types';

/** أقصى ضبط مسبق لتاريخ بدء الفوترة بعد اليوم المحلي للشركة */
export const PAYLINK_FEE_INVOICE_FROM_MAX_FUTURE_DAYS = 90;

export type PaylinkFeeInvoiceDateInvalidReason =
  | 'FORMAT'
  | 'NOT_AFTER_LAST_POSTED_FEE'
  | 'NOT_AFTER_TAX_LOCK'
  | 'NOT_AFTER_HARD_LOCK'
  | 'TOO_FAR_IN_FUTURE';

export interface PaylinkFeeInvoiceFromInput {
  /** التاريخ الجديد (YYYY-MM-DD) أو null للمسح */
  from: LocalDate | string | null;
  /** القائم في GlSettings.paylinkFeeTaxInvoiceFrom */
  current: LocalDate | Date | null;
  /** التاريخ المحلي لآخر عمولة مرحّلة (PAYLINK_FEE DONE)؛ null بلا عمولات مرحّلة */
  lastPostedFeeDate: LocalDate | Date | null;
  taxLockDate: LocalDate | Date | null;
  hardLockDate: LocalDate | Date | null;
  /** اليوم المحلي للشركة (§2.5) */
  today: LocalDate;
}

export type PaylinkFeeInvoiceFromDecision =
  | { ok: true; from: LocalDate | null; current: LocalDate | null; unchanged: boolean }
  | {
    ok: false;
    code: 'LEDGER_PAYLINK_FEE_INVOICE_DATE_LOCKED';
    httpStatus: 409;
    current: LocalDate;
    lastPostedFeeDate: LocalDate;
  }
  | {
    ok: false;
    code: 'LEDGER_PAYLINK_FEE_INVOICE_DATE_INVALID';
    httpStatus: 422;
    reason: PaylinkFeeInvoiceDateInvalidReason;
    /** أصغر تاريخ مقبول (اليوم التالي لأكبر القيود) حين يُعرف */
    minDate: LocalDate | null;
    maxDate: LocalDate;
  };

function asLocal(v: LocalDate | Date | string | null | undefined): LocalDate | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? fromDbDate(v) : v;
  if (!isLocalDate(d)) throw new RangeError(`تاريخ غير صالح: ${String(v)}`);
  return d;
}

export function validatePaylinkFeeInvoiceFrom(input: PaylinkFeeInvoiceFromInput): PaylinkFeeInvoiceFromDecision {
  if (!isLocalDate(input.today)) throw new RangeError(`today غير صالح: ${String(input.today)}`);
  const current = asLocal(input.current);
  const lastPosted = asLocal(input.lastPostedFeeDate);
  const taxLock = asLocal(input.taxLockDate);
  const hardLock = asLocal(input.hardLockDate);
  const maxDate = addDays(input.today, PAYLINK_FEE_INVOICE_FROM_MAX_FUTURE_DAYS);

  const lowerBounds = [lastPosted, taxLock, hardLock].filter((d): d is LocalDate => d !== null);
  const minDate = lowerBounds.length
    ? addDays(lowerBounds.reduce((a, b) => (compareLocalDate(a, b) >= 0 ? a : b)), 1)
    : null;
  const invalid = (reason: PaylinkFeeInvoiceDateInvalidReason): PaylinkFeeInvoiceFromDecision => ({
    ok: false, code: 'LEDGER_PAYLINK_FEE_INVOICE_DATE_INVALID', httpStatus: 422, reason, minDate, maxDate,
  });

  let from: LocalDate | null;
  if (input.from === null || input.from === undefined || input.from === '') from = null;
  else if (isLocalDate(input.from)) from = input.from;
  else return invalid('FORMAT');

  // بلا تغيير: لا شيء يُكتب ولا يُفحص
  if (from === current) return { ok: true, from, current, unchanged: true };

  // تعديل أو مسح تاريخ قائم بعد ترحيل عمولة تاريخها ≥ القائم
  if (current !== null && lastPosted !== null && compareLocalDate(lastPosted, current) >= 0) {
    return { ok: false, code: 'LEDGER_PAYLINK_FEE_INVOICE_DATE_LOCKED', httpStatus: 409, current, lastPostedFeeDate: lastPosted };
  }

  // المسح (والتاريخ القائم لم تُرحَّل تحته عمولة) لا يغيّر معاملة أي عمولة مرحّلة
  if (from === null) return { ok: true, from, current, unchanged: false };

  if (lastPosted !== null && compareLocalDate(from, lastPosted) <= 0) return invalid('NOT_AFTER_LAST_POSTED_FEE');
  if (taxLock !== null && compareLocalDate(from, taxLock) <= 0) return invalid('NOT_AFTER_TAX_LOCK');
  if (hardLock !== null && compareLocalDate(from, hardLock) <= 0) return invalid('NOT_AFTER_HARD_LOCK');
  if (compareLocalDate(from, maxDate) > 0) return invalid('TOO_FAR_IN_FUTURE');
  return { ok: true, from, current, unchanged: false };
}

/** رسائل عربية للرد (الواجهة تترجمها بـtr) */
export const PAYLINK_FEE_INVOICE_DATE_MESSAGES: Record<PaylinkFeeInvoiceDateInvalidReason | 'LOCKED', string> = {
  FORMAT: 'تاريخ غير صالح YYYY-MM-DD',
  NOT_AFTER_LAST_POSTED_FEE: 'التاريخ يجب أن يكون بعد تاريخ آخر عمولة دفع إلكتروني مرحّلة',
  NOT_AFTER_TAX_LOCK: 'التاريخ يجب أن يكون بعد تاريخ إقفال الضريبة',
  NOT_AFTER_HARD_LOCK: 'التاريخ يجب أن يكون بعد تاريخ الإقفال النهائي',
  TOO_FAR_IN_FUTURE: 'التاريخ لا يتجاوز ٩٠ يوماً من اليوم',
  LOCKED: 'لا يعدَّل التاريخ القائم ولا يُمسح بعد ترحيل عمولة تاريخها في نطاقه',
};
