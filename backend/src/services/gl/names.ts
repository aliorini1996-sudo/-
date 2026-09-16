/**
 * أسماء الدفاتر بالعربية (DESIGN.md §9.5 G7، §8.7) — دوال صرفة.
 *
 * `name` في الحساب والدفتر والضريبة هو الاسم العربي وإلزامي: POST وPUT واستيراد الشجرة يرفضون
 * اسماً بلا حرف عربي واحد (422 LEDGER_NAME_ARABIC_REQUIRED)، والاسم بلغة أخرى مكانه `nameEn`.
 */
import { LedgerError } from './types';

/** حرف عربي في نطاقي U+0600–U+06FF وU+0750–U+077F. */
const ARABIC_LETTER_RE = /[؀-ۿݐ-ݿ]/;

export function hasArabicLetter(v: unknown): boolean {
  return typeof v === 'string' && ARABIC_LETTER_RE.test(v);
}

/** يرمي LEDGER_NAME_ARABIC_REQUIRED {field, entity?} إن خلا الاسم من حرف عربي. */
export function assertArabicName(name: unknown, details: Record<string, unknown> = {}): void {
  if (!hasArabicLetter(name)) throw new LedgerError('LEDGER_NAME_ARABIC_REQUIRED', { field: 'name', ...details });
}
