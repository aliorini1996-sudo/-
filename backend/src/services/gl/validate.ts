/**
 * التحقق من مسودة القيد قبل الترحيل (DESIGN.md §2.1 I1–I5 وI8، §4.4 سطر العلامة، §5.9 CONTROL_ADJUSTMENT).
 *
 * صرف بلا I/O: يأخذ MoveDraft وسياق البناء ووضع التحقق، ويحلّ حساب كل سطر (id ثم code ثم key).
 * I6 (التسلسل) وI7 (الملكية) من مسؤولية الترحيل لا هذا الملف.
 *
 * الوضعان:
 *  - MANUAL: القيود اليدوية (§6.1) — تُطبَّق I4 وقاعدة LEDGER_VAT_LINE_UNTAGGED.
 *  - SYSTEM: قيود المُرحِّل والخدمات — بلا I4 (الحسابات الرئيسية يغذّيها مصدرها).
 * الافتراضي من move.origin: MANUAL ⇒ MANUAL، وAUTO ⇒ SYSTEM.
 * إعفاء I4 للحسابات الرئيسية مشروط بـmoveType === 'CONTROL_ADJUSTMENT' وحده (§5.9).
 */
import {
  LedgerError,
  SOURCE_OWNED_CONTROL_KINDS,
  VAT_CONTROL_KINDS,
  type AccountRef,
  type AccountResolver,
  type BuildContext,
  type LedgerErrorCode,
  type LineDraft,
  type Milli,
  type MoveDraft,
  type TaxRef,
} from './types';

export type ValidationMode = 'MANUAL' | 'SYSTEM';

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I8' | 'MARKER' | 'ACCOUNT';

/** سبب مفصّل داخل الرمز — للواجهة والاختبارات ولوحة الأحداث. */
export type ValidationReason =
  | 'ACCOUNT_NOT_FOUND'
  | 'NEGATIVE_AMOUNT'
  | 'DEBIT_AND_CREDIT'
  | 'ZERO_LINE_NOT_MARKER'
  | 'MARKER_WITH_AMOUNT'
  | 'MARKER_WITHOUT_TAX'
  | 'MARKER_WITHOUT_BASE'
  | 'MARKER_NONZERO_RATE'
  | 'ACCOUNT_ARCHIVED'
  | 'EQUITY_UNAFFECTED'
  | 'CONTROL_ACCOUNT_MANUAL'
  | 'VAT_LINE_UNTAGGED'
  | 'CUSTOMER_REQUIRED'
  | 'VENDOR_REQUIRED'
  | 'OFF_BALANCE_MIXED'
  | 'TOO_FEW_LINES'
  | 'UNBALANCED';

export interface ValidationIssue {
  code: LedgerErrorCode;
  invariant: InvariantId;
  reason: ValidationReason;
  /** فهرس السطر في move.lines، وnull لمخالفة على مستوى القيد */
  lineIndex: number | null;
  accountCode?: string;
  /** المبالغ نصوص (BigInt لا يُسلسل JSON) */
  debitMilli?: string;
  creditMilli?: string;
}

export interface ResolvedLine {
  index: number;
  line: LineDraft;
  account: AccountRef;
  /** الضريبة المحلولة من taxId ثم taxCode — null إن لم تُذكر أو لم تُحلّ */
  tax: TaxRef | null;
  isMarker: boolean;
}

export interface MoveValidationReport {
  mode: ValidationMode;
  issues: ValidationIssue[];
  /** السطور التي حُلّ حسابها (قد تنقص عن move.lines عند ACCOUNT_NOT_FOUND) */
  lines: ResolvedLine[];
  totalDebitMilli: Milli;
  totalCreditMilli: Milli;
  /** سطور غير صفرية (العلامات مستبعدة) — حدّها الأدنى 2 (I1) */
  nonZeroLineCount: number;
}

export interface ValidatedMove {
  move: MoveDraft;
  mode: ValidationMode;
  lines: ResolvedLine[];
  totalDebitMilli: Milli;
  totalCreditMilli: Milli;
}

export interface ValidateOptions {
  /** يتجاوز الاشتقاق من move.origin */
  mode?: ValidationMode;
}

export function validationModeOf(move: Pick<MoveDraft, 'origin'>): ValidationMode {
  return move.origin === 'MANUAL' ? 'MANUAL' : 'SYSTEM';
}

/** حلّ حساب السطر بالأولوية: accountId ثم accountCode ثم accountKey (types.ts LineDraft). */
export function resolveLineAccount(line: LineDraft, accounts: AccountResolver): AccountRef | null {
  if (line.accountId) return accounts.byId(line.accountId);
  if (line.accountCode) return accounts.byCode(line.accountCode);
  if (line.accountKey) return accounts.byKey(line.accountKey);
  return null;
}

function resolveLineTax(line: LineDraft, ctx: BuildContext): TaxRef | null {
  if (line.taxId) return ctx.taxes.byId(line.taxId);
  if (line.taxCode) return ctx.taxes.byKey(line.taxCode);
  return null;
}

function hasText(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** يجمع كل المخالفات دون رمي — للمعاينة في النموذج وللوحة الأحداث. */
export function collectMoveIssues(move: MoveDraft, ctx: BuildContext, opts: ValidateOptions = {}): MoveValidationReport {
  const mode = opts.mode ?? validationModeOf(move);
  const controlExempt = move.moveType === 'CONTROL_ADJUSTMENT';
  const issues: ValidationIssue[] = [];
  const resolved: ResolvedLine[] = [];
  let totalDebit = 0n;
  let totalCredit = 0n;
  let nonZero = 0;
  let offBalanceCount = 0;

  move.lines.forEach((line, index) => {
    const d = line.debitMilli;
    const c = line.creditMilli;
    const amounts = { debitMilli: d.toString(), creditMilli: c.toString() };
    const account = resolveLineAccount(line, ctx.accounts);
    if (!account) {
      issues.push({ code: 'LEDGER_ACCOUNT_NOT_FOUND', invariant: 'ACCOUNT', reason: 'ACCOUNT_NOT_FOUND', lineIndex: index,
        accountCode: line.accountCode ?? line.accountKey ?? line.accountId, ...amounts });
    }
    const at = { lineIndex: index, accountCode: account?.code, ...amounts };
    const isMarker = line.taxRole === 'MARKER';
    const tax = resolveLineTax(line, ctx);

    // I2: غير سالب، ولا مدين ودائن معاً
    if (d < 0n || c < 0n) {
      issues.push({ code: 'LEDGER_UNBALANCED', invariant: 'I2', reason: 'NEGATIVE_AMOUNT', ...at });
    } else if (d > 0n && c > 0n) {
      issues.push({ code: 'LEDGER_UNBALANCED', invariant: 'I2', reason: 'DEBIT_AND_CREDIT', ...at });
    }

    // I1 وقاعدة العلامة: 0/0 للعلامة وحدها، والعلامة 0/0 دائماً بضريبة صفرية ووعاء
    if (isMarker) {
      if (d !== 0n || c !== 0n) {
        issues.push({ code: 'LEDGER_UNBALANCED', invariant: 'MARKER', reason: 'MARKER_WITH_AMOUNT', ...at });
      }
      if (!tax) {
        issues.push({ code: 'LEDGER_UNBALANCED', invariant: 'MARKER', reason: 'MARKER_WITHOUT_TAX', ...at });
      } else if (tax.rate !== 0) {
        issues.push({ code: 'LEDGER_UNBALANCED', invariant: 'MARKER', reason: 'MARKER_NONZERO_RATE', ...at });
      }
      if (line.taxBaseMilli === null || line.taxBaseMilli === undefined) {
        issues.push({ code: 'LEDGER_UNBALANCED', invariant: 'MARKER', reason: 'MARKER_WITHOUT_BASE', ...at });
      }
    } else if (d === 0n && c === 0n) {
      issues.push({ code: 'LEDGER_UNBALANCED', invariant: 'I1', reason: 'ZERO_LINE_NOT_MARKER', ...at });
    }

    if (!isMarker && (d !== 0n || c !== 0n)) nonZero++;
    totalDebit += d;
    totalCredit += c;

    if (!account) return;
    resolved.push({ index, line, account, tax, isMarker });

    // I3: مؤرشف (والعلامة مشمولة)، أو equity_unaffected المحسوب آلياً
    if (!account.isActive) {
      issues.push({ code: 'LEDGER_ACCOUNT_ARCHIVED', invariant: 'I3', reason: 'ACCOUNT_ARCHIVED', ...at });
    }
    if (account.type === 'equity_unaffected') {
      issues.push({ code: 'LEDGER_ACCOUNT_ARCHIVED', invariant: 'I3', reason: 'EQUITY_UNAFFECTED', ...at });
    }

    if (account.type === 'off_balance') offBalanceCount++;

    const kind = account.controlKind;
    if (mode === 'MANUAL' && kind) {
      // I4: الحسابات الرئيسية ممنوعة يدوياً إلا بنوع القيد CONTROL_ADJUSTMENT
      if (SOURCE_OWNED_CONTROL_KINDS.includes(kind) && !controlExempt) {
        issues.push({ code: 'LEDGER_CONTROL_ACCOUNT_MANUAL', invariant: 'I4', reason: 'CONTROL_ACCOUNT_MANUAL', ...at });
      }
      // I4: سطر يدوي على حساب ضريبة يلزمه ضريبة محلولة ومربع
      if (VAT_CONTROL_KINDS.includes(kind) && (!tax || !hasText(line.vatBox))) {
        issues.push({ code: 'LEDGER_VAT_LINE_UNTAGGED', invariant: 'I4', reason: 'VAT_LINE_UNTAGGED', ...at });
      }
    }

    // I5: ذمم العملاء بالعميل، وذمم الموردين بالمورّد
    if (kind === 'AR' && !hasText(line.customerId)) {
      issues.push({ code: 'LEDGER_PARTNER_REQUIRED', invariant: 'I5', reason: 'CUSTOMER_REQUIRED', ...at });
    }
    if (kind === 'AP' && !hasText(line.vendorId)) {
      issues.push({ code: 'LEDGER_PARTNER_REQUIRED', invariant: 'I5', reason: 'VENDOR_REQUIRED', ...at });
    }
  });

  // I8: off_balance لا يخالط غيره (العلامات مشمولة لأنها على حسابات الضريبة)
  if (offBalanceCount > 0 && offBalanceCount < resolved.length) {
    issues.push({ code: 'LEDGER_OFF_BALANCE_MIXED', invariant: 'I8', reason: 'OFF_BALANCE_MIXED', lineIndex: null });
  }

  // I1: سطران غير صفريين على الأقل، وتوازن تام
  if (nonZero < 2) {
    issues.push({ code: 'LEDGER_UNBALANCED', invariant: 'I1', reason: 'TOO_FEW_LINES', lineIndex: null });
  }
  if (totalDebit !== totalCredit) {
    issues.push({ code: 'LEDGER_UNBALANCED', invariant: 'I1', reason: 'UNBALANCED', lineIndex: null,
      debitMilli: totalDebit.toString(), creditMilli: totalCredit.toString() });
  }

  return { mode, issues, lines: resolved, totalDebitMilli: totalDebit, totalCreditMilli: totalCredit, nonZeroLineCount: nonZero };
}

/**
 * يتحقق ويرمي LedgerError بأول مخالفة (ترتيب السطور ثم مستوى القيد)،
 * وتفاصيله {invariant, reason, lineIndex, accountCode, issues[]} كاملة.
 */
export function validateMove(move: MoveDraft, ctx: BuildContext, opts: ValidateOptions = {}): ValidatedMove {
  const report = collectMoveIssues(move, ctx, opts);
  const first = report.issues[0];
  if (first) {
    const { code, ...rest } = first;
    throw new LedgerError(code, { ...rest, issues: report.issues }, `${code}: ${first.invariant}/${first.reason}`);
  }
  return {
    move,
    mode: report.mode,
    lines: report.lines,
    totalDebitMilli: report.totalDebitMilli,
    totalCreditMilli: report.totalCreditMilli,
  };
}

/** اختصار منطقي بلا رمي. */
export function isValidMove(move: MoveDraft, ctx: BuildContext, opts: ValidateOptions = {}): boolean {
  return collectMoveIssues(move, ctx, opts).issues.length === 0;
}
