/**
 * ترقيم القيود (M1، DESIGN.md I6 §2.1، GlSequence §3.2، الدفاتر §4.3، §9.5 G2) — دوال صرفة.
 *
 * - المجموعة (دفتر، بادئة، فترة) = @@unique([journalId, prefix, periodKey]) في gl_sequences.
 * - periodKey: "YYYY" للسنوي و"YYYY-MM" للشهري، من التاريخ المحاسبي (بعد إزاحة ADR‑7) بالسنة التقويمية.
 * - الصيغة: شهري INV/2026/09/0001 (4 خانات)، سنوي PAY/2026/00001 (5 خانات)؛ الرقم يتجاوز الحشو ولا يُقصّ.
 * - البادئة = رمز الدفتر، والمرتجع OUT_REFUND/IN_REFUND = "R" + الرمز (RINV، RBILL).
 * - منح الرقم نفسه (UPDATE … nextNumber+1 RETURNING) في post.ts داخل معاملة الترحيل (M2).
 */
import type { JournalRef, LocalDate, MoveType, SequenceReset } from './types';
import { SEQUENCE_RESETS } from './types';
import { isLocalDate, parseLocalDate } from './dates';

/** خانات الحشو لكل نمط تصفير (§4.3). */
export const SEQUENCE_PADDING: Readonly<Record<SequenceReset, number>> = { MONTHLY: 4, YEARLY: 5 };

/** رمز الدفتر: ≤6 أحرف لاتينية (أرقام مسموحة بعد الحرف الأول: CSH1، BNK1) — §3.2. */
export const JOURNAL_CODE_RE = /^[A-Z][A-Z0-9]{0,5}$/;
/** البادئة: رمز الدفتر أو "R" + الرمز. */
export const SEQUENCE_PREFIX_RE = /^[A-Z][A-Z0-9]{0,6}$/;

/** أنواع القيود التي تأخذ بادئة المرتجع. */
export const REFUND_MOVE_TYPES: readonly MoveType[] = ['OUT_REFUND', 'IN_REFUND'];

export function isValidJournalCode(code: unknown): code is string {
  return typeof code === 'string' && JOURNAL_CODE_RE.test(code);
}

export function isSequenceReset(v: unknown): v is SequenceReset {
  return typeof v === 'string' && (SEQUENCE_RESETS as readonly string[]).includes(v);
}

function assertReset(reset: unknown): asserts reset is SequenceReset {
  if (!isSequenceReset(reset)) throw new RangeError(`sequenceReset غير صالح: ${String(reset)}`);
}

function assertDate(date: unknown): asserts date is LocalDate {
  if (!isLocalDate(date)) throw new RangeError(`تاريخ محلي غير صالح (YYYY-MM-DD): ${String(date)}`);
}

function assertPrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== 'string' || !SEQUENCE_PREFIX_RE.test(prefix)) {
    throw new RangeError(`بادئة تسلسل غير صالحة: ${String(prefix)}`);
  }
}

/** مفتاح الفترة حسب sequenceReset: YEARLY ⇒ "2026"، MONTHLY ⇒ "2026-09". */
export function sequencePeriodKey(date: LocalDate, reset: SequenceReset): string {
  assertDate(date);
  assertReset(reset);
  const { y, m } = parseLocalDate(date);
  const yyyy = String(y).padStart(4, '0');
  return reset === 'YEARLY' ? yyyy : `${yyyy}-${String(m).padStart(2, '0')}`;
}

/** بادئة التسلسل: المُمرَّرة صراحةً في المسودة، وإلا رمز الدفتر، والمرتجع "R" + الرمز. */
export function sequencePrefixFor(journalCode: string, moveType: MoveType, explicit?: string | null): string {
  if (explicit != null && explicit !== '') {
    assertPrefix(explicit);
    return explicit;
  }
  if (!isValidJournalCode(journalCode)) throw new RangeError(`رمز دفتر غير صالح: ${String(journalCode)}`);
  return REFUND_MOVE_TYPES.includes(moveType) ? `R${journalCode}` : journalCode;
}

/**
 * تصادم رمز دفتر (G2 §9.5): فرادة الرقم على مستوى الشركة @@unique([tenantId, number])، وبادئة المرتجع "R" + الرمز،
 * فرمز يساوي رمزاً قائماً أو بادئة مرتجعه (RINV مع INV) أو العكس يُنتج الرقم نفسه في دفترين.
 * existingCodes: رموز دفاتر الشركة بدون رمز الدفتر نفسه عند التعديل. sequenceReset لا يُعتبر (تحفّظاً: قابل للتغيير قبل أول قيد).
 * يعيد الرمز القائم المتصادم أو null. المُستدعي (M2: POST/PUT /journals وبذر الدفاتر) يردّ 409 LEDGER_JOURNAL_CODE_CONFLICT.
 */
export function journalCodeConflict(code: string, existingCodes: readonly string[]): string | null {
  if (existingCodes.includes(code)) return code;
  if (code.startsWith('R') && existingCodes.includes(code.slice(1))) return code.slice(1);
  if (existingCodes.includes(`R${code}`)) return `R${code}`;
  return null;
}

export interface SequenceGroup {
  journalId: string;
  prefix: string;
  periodKey: string;
}

/** مجموعة التسلسل (دفتر، بادئة، فترة) لقيد — تطابق @@unique([journalId, prefix, periodKey]). */
export function sequenceGroup(input: {
  journal: Pick<JournalRef, 'id' | 'code' | 'sequenceReset'>;
  moveType: MoveType;
  date: LocalDate;
  sequencePrefix?: string | null;
}): SequenceGroup {
  const { journal, moveType, date } = input;
  if (!journal.id) throw new RangeError('journal.id مطلوب');
  return {
    journalId: journal.id,
    prefix: sequencePrefixFor(journal.code, moveType, input.sequencePrefix),
    periodKey: sequencePeriodKey(date, journal.sequenceReset),
  };
}

/** نص المجموعة للتجميع في الذاكرة (C12). */
export function sequenceGroupKey(g: SequenceGroup): string {
  return `${g.journalId}|${g.prefix}|${g.periodKey}`;
}

/** رقم القيد: MONTHLY ⇒ PREFIX/YYYY/MM/0001، YEARLY ⇒ PREFIX/YYYY/00001. */
export function formatMoveNumber(prefix: string, periodKey: string, reset: SequenceReset, n: number): string {
  assertPrefix(prefix);
  assertReset(reset);
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`رقم تسلسل غير صالح: ${String(n)}`);
  const seq = String(n).padStart(SEQUENCE_PADDING[reset], '0');
  if (reset === 'YEARLY') {
    if (!/^\d{4}$/.test(periodKey)) throw new RangeError(`periodKey سنوي غير صالح: ${periodKey}`);
    return `${prefix}/${periodKey}/${seq}`;
  }
  const mm = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodKey);
  if (!mm) throw new RangeError(`periodKey شهري غير صالح: ${periodKey}`);
  return `${prefix}/${mm[1]}/${mm[2]}/${seq}`;
}

/** رقم قيد لمجموعته مباشرةً من التاريخ. */
export function moveNumberFor(prefix: string, date: LocalDate, reset: SequenceReset, n: number): string {
  return formatMoveNumber(prefix, sequencePeriodKey(date, reset), reset, n);
}

export interface ParsedMoveNumber {
  prefix: string;
  periodKey: string;
  reset: SequenceReset;
  n: number;
}

/** تحليل رقم قيد إلى مكوّناته، أو null لصيغة غير معروفة. */
export function parseMoveNumber(number: string): ParsedMoveNumber | null {
  const monthly = /^([A-Z][A-Z0-9]{0,6})\/(\d{4})\/(0[1-9]|1[0-2])\/(\d{4,})$/.exec(number);
  if (monthly) {
    const n = Number(monthly[4]);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return { prefix: monthly[1], periodKey: `${monthly[2]}-${monthly[3]}`, reset: 'MONTHLY', n };
  }
  const yearly = /^([A-Z][A-Z0-9]{0,6})\/(\d{4})\/(\d{5,})$/.exec(number);
  if (yearly) {
    const n = Number(yearly[3]);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return { prefix: yearly[1], periodKey: yearly[2], reset: 'YEARLY', n };
  }
  return null;
}

export interface SequenceGapReport {
  ok: boolean;
  /** أرقام ناقصة من {1 … nextNumber − 1} */
  missing: number[];
  /** أرقام خارج المدى (≥ nextNumber أو < 1) */
  unexpected: number[];
  /** أرقام مكرّرة */
  duplicates: number[];
}

/**
 * الفحص C12 (§5.9، G2): أرقام المرحَّل في مجموعة = {1 … nextNumber − 1} تماماً.
 * nextNumber الافتراضي = أكبر رقم + 1 (فحص الفجوات وحده بلا صف GlSequence).
 */
export function checkSequenceGaps(numbers: readonly number[], nextNumber?: number): SequenceGapReport {
  const max = numbers.reduce((a, b) => (b > a ? b : a), 0);
  const next = nextNumber ?? max + 1;
  if (!Number.isSafeInteger(next) || next < 1) throw new RangeError(`nextNumber غير صالح: ${String(nextNumber)}`);
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  const unexpected: number[] = [];
  for (const n of numbers) {
    if (!Number.isSafeInteger(n) || n < 1 || n >= next) {
      unexpected.push(n);
      continue;
    }
    if (seen.has(n)) duplicates.add(n);
    seen.add(n);
  }
  const missing: number[] = [];
  for (let i = 1; i < next; i++) if (!seen.has(i)) missing.push(i);
  const dups = [...duplicates].sort((a, b) => a - b);
  return {
    ok: missing.length === 0 && unexpected.length === 0 && dups.length === 0,
    missing,
    unexpected,
    duplicates: dups,
  };
}
