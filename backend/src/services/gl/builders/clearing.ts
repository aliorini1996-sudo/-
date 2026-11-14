// «ربط الدفاتر» L5 (C3/C5، العقد §5.2) — مستندات التسوية الموجّهة للحسابات الوسيطة. دوال صرفة بلا prisma ولا I/O.
//
// يُصفّي الحساب الوسيط حين يصل المال إلى البنك (قيد يدوي origin=MANUAL، moveType=RECONCILE، دفتر البنك):
//   مدين البنك                 = الإجمالي − العمولة − ضريبتها (الصافي المودَع كما في كشف البنك)
//   مدين 611008 (BANK_FEES)     = العمولة قبل الضريبة
//   مدين 116001 (ضريبة المدخلات) = ضريبة العمولة — ضريبة المشتريات الافتراضية (S15_PURCH ⇒ SA_7) بوعاء العمولة
//   دائن الحساب الوسيط          = الإجمالي
// الأنواع: POS_SETTLEMENT ⇒ 112004، CARD_SETTLEMENT ⇒ 112007، CHEQUE_CLEARANCE ⇒ 112003، DEPOSIT_CLEARANCE ⇒ 112001.
// وللمربوطة: حساب الطريقة في خريطة الطرق (D3) إن كان وسيطاً (أصلاً متداولاً غير رقابي) — فما رُحّلت إليه سندات الطريقة هو ما يُصفّى.
//
// الحسابات الوسيطة بلا controlKind فيقبلها التحقق اليدوي (I4)، والبنك حساب نقدي غير رقابي (لا عهدة 111003/111004)،
// وسطر الضريبة موسوم بضريبته ومربّعه فلا يُرفض LEDGER_VAT_LINE_UNTAGGED.
// المطابقة: كل سطر مدين مفتوح مختار (أو الأقدم فالأقدم) يُطابَق بسطر الدائن بـsourceRef = CLR:<moveId> حتى الإجمالي.
import { CARD_CLEARING_CODE } from '../coa/linkedAccounts';
import { compareLocalDate, isLocalDate } from '../dates';
import { maxMilli, minMilli, unitMilli } from '../money';
import { linkedMethodAccount, type AccountTarget } from './receipt';
import {
  JOURNAL_CODE_BY_SYSTEM_KEY, LedgerError,
  type AccountRef, type BuildContext, type LineDraft, type LocalDate, type Milli, type MoveDraft, type TaxRef,
} from '../types';

export const CLEARING_KINDS = ['POS_SETTLEMENT', 'CARD_SETTLEMENT', 'CHEQUE_CLEARANCE', 'DEPOSIT_CLEARANCE'] as const;
export type ClearingKind = (typeof CLEARING_KINDS)[number];

export function isClearingKind(v: unknown): v is ClearingKind {
  return typeof v === 'string' && (CLEARING_KINDS as readonly string[]).includes(v);
}

export interface ClearingInput {
  kind: ClearingKind;
  date: LocalDate;
  /** حساب البنك (أو الصندوق) المستلِم: asset_cash نشط غير رقابي */
  bankAccountId: string;
  grossMilli: bigint;
  feeMilli?: bigint;
  feeVatMilli?: bigint;
  ref?: string | null;
  note?: string | null;
  /** السطور المدينة المفتوحة المختارة على الحساب الوسيط — الغائب ⇒ الأقدم فالأقدم (يقرّره المسار، لا الـbuilder) */
  openLineIds?: string[];
  /** إضافة على العقد: رمز دفتر البنك المستلِم (دفتر BANK/CASH حسابه الافتراضي = bankAccountId) — الغائب ⇒ البنك الرئيسي BNK1 */
  journalCode?: string | null;
}

/** مرجع المطابقة الجزئية للتسوية الموجّهة (GlPartialReconcile.sourceRef) */
export const clearingSourceRef = (moveId: string): string => `CLR:${moveId}`;

export const CLEARING_KIND_LABELS: Readonly<Record<ClearingKind, string>> = {
  POS_SETTLEMENT: 'تسوية مقبوضات نقاط البيع',
  CARD_SETTLEMENT: 'تسوية تحصيلات البطاقة',
  CHEQUE_CLEARANCE: 'تحصيل شيكات العملاء',
  DEPOSIT_CLEARANCE: 'إيداع مقبوضات قيد الإيداع',
};

/** الحساب الوسيط في القالب لكل نوع */
const KIND_TEMPLATE_TARGET: Readonly<Record<ClearingKind, AccountTarget>> = {
  POS_SETTLEMENT: { accountKey: 'POS_CLEARING' },
  CARD_SETTLEMENT: { accountCode: CARD_CLEARING_CODE },
  CHEQUE_CLEARANCE: { accountKey: 'CHEQUES_UNDER_COLLECTION' },
  DEPOSIT_CLEARANCE: { accountKey: 'OUTSTANDING_RECEIPTS' },
};

function resolveTarget(t: AccountTarget, ctx: BuildContext): AccountRef | null {
  if ('accountId' in t) return ctx.accounts.byId(t.accountId);
  if ('accountCode' in t) return ctx.accounts.byCode(t.accountCode);
  return ctx.accounts.byKey(t.accountKey);
}

/** يصلح وسيطاً: أصل متداول غير رقابي — صف خريطة يوجّه الطريقة إلى البنك مباشرة لا وسيط له فيُرجع إلى القالب */
const isIntermediate = (a: AccountRef | null): a is AccountRef => !!a && a.type === 'asset_current' && a.controlKind === null;

/** الحساب الوسيط الذي يُصفّيه النوع — null إن لم يوجد في شجرة الشركة */
export function clearingAccountOf(kind: ClearingKind, ctx: BuildContext): AccountRef | null {
  if (ctx.settings.linkedPosting === true && kind !== 'DEPOSIT_CLEARANCE') {
    const effective = kind === 'CARD_SETTLEMENT'
      ? linkedMethodAccount({ method: 'POS', card: true }, ctx)
      : linkedMethodAccount({ method: kind === 'POS_SETTLEMENT' ? 'POS' : 'CHEQUE' }, ctx);
    const acc = effective ? resolveTarget(effective, ctx) : null;
    if (isIntermediate(acc)) return acc;
  }
  return resolveTarget(KIND_TEMPLATE_TARGET[kind], ctx);
}

/**
 * ضريبة عمولة البنك: ضريبة المشتريات الافتراضية للشركة ثم S15_PURCH — نشطة، مشتريات، بنسبة موجبة، ولها حساب.
 * سطرها على حساب رقابي للضريبة (VAT_IN) يلزمه مربّع (I4)، فضريبة بلا مربّع (القالب العام) لا تصلح لقيد يدوي.
 */
export function clearingFeeTax(ctx: BuildContext): TaxRef | null {
  const usable = (t: TaxRef | null): t is TaxRef => {
    if (!t || !t.isActive || t.use !== 'PURCHASE' || !(t.rate > 0)) return false;
    const acc = t.accountId ? ctx.accounts.byId(t.accountId) : ctx.accounts.byKey('INPUT_VAT');
    if (!acc || !acc.isActive) return false;
    return !(acc.controlKind === 'VAT_IN' || acc.controlKind === 'VAT_OUT') || !!(t.vatBox && t.vatBox.trim());
  };
  const byDefault = ctx.settings.defaultPurchaseTaxId ? ctx.taxes.byId(ctx.settings.defaultPurchaseTaxId) : null;
  if (usable(byDefault)) return byDefault;
  const sa = ctx.taxes.byKey('S15_PURCH');
  return usable(sa) ? sa : null;
}

export type ClearingProblemReason =
  | 'INVALID_KIND' | 'INVALID_DATE'
  | 'GROSS_NOT_POSITIVE' | 'FEE_NEGATIVE' | 'FEE_VAT_NEGATIVE' | 'FEES_EXCEED_GROSS' | 'FEE_VAT_WITHOUT_FEE' | 'PRECISION'
  | 'BANK_ACCOUNT_NOT_FOUND' | 'BANK_ACCOUNT_INACTIVE' | 'BANK_ACCOUNT_NOT_CASH' | 'BANK_ACCOUNT_CONTROL'
  | 'CLEARING_ACCOUNT_MISSING' | 'CLEARING_ACCOUNT_INACTIVE' | 'BANK_IS_CLEARING'
  | 'FEE_ACCOUNT_MISSING' | 'VAT_TAX_UNAVAILABLE';

export interface ClearingProblem { reason: ClearingProblemReason; field: string }

/** كل مخالفات المدخل دون رمي — المسار يحوّلها 422 LEDGER_CLEARING_INVALID، والـbuilder يرمي بأولها */
export function clearingInputProblems(i: ClearingInput, ctx: BuildContext): ClearingProblem[] {
  const out: ClearingProblem[] = [];
  const add = (reason: ClearingProblemReason, field: string) => out.push({ reason, field });
  if (!isClearingKind(i.kind)) add('INVALID_KIND', 'kind');
  if (!isLocalDate(i.date)) add('INVALID_DATE', 'date');

  const u = unitMilli(ctx.settings.currencyDecimals);
  const gross = i.grossMilli;
  const fee = i.feeMilli ?? 0n;
  const vat = i.feeVatMilli ?? 0n;
  if (gross <= 0n) add('GROSS_NOT_POSITIVE', 'gross');
  if (fee < 0n) add('FEE_NEGATIVE', 'fee');
  if (vat < 0n) add('FEE_VAT_NEGATIVE', 'feeVat');
  // مبلغ بمنازل أكثر من منازل العملة لا يُقرَّب صامتاً في مستند محاسبي
  for (const [field, v] of [['gross', gross], ['fee', fee], ['feeVat', vat]] as const) {
    if (v % u !== 0n) add('PRECISION', field);
  }
  if (fee >= 0n && vat >= 0n && gross > 0n && fee + vat > gross) add('FEES_EXCEED_GROSS', 'fee');
  if (vat > 0n && fee === 0n) add('FEE_VAT_WITHOUT_FEE', 'feeVat');

  const bank = ctx.accounts.byId(i.bankAccountId);
  if (!bank) add('BANK_ACCOUNT_NOT_FOUND', 'bankAccountId');
  else {
    if (!bank.isActive) add('BANK_ACCOUNT_INACTIVE', 'bankAccountId');
    if (bank.type !== 'asset_cash') add('BANK_ACCOUNT_NOT_CASH', 'bankAccountId');
    if (bank.controlKind !== null) add('BANK_ACCOUNT_CONTROL', 'bankAccountId');
  }
  if (isClearingKind(i.kind)) {
    const clearing = clearingAccountOf(i.kind, ctx);
    if (!clearing) add('CLEARING_ACCOUNT_MISSING', 'kind');
    else {
      if (!clearing.isActive) add('CLEARING_ACCOUNT_INACTIVE', 'kind');
      if (bank && bank.id === clearing.id) add('BANK_IS_CLEARING', 'bankAccountId');
    }
  }
  if (fee > 0n) {
    const feeAcc = ctx.accounts.byKey('BANK_FEES');
    if (!feeAcc || !feeAcc.isActive) add('FEE_ACCOUNT_MISSING', 'fee');
  }
  if (vat > 0n && !clearingFeeTax(ctx)) add('VAT_TAX_UNAVAILABLE', 'feeVat');
  return out;
}

/** قيد التسوية الموجّهة — متّزن دائماً: Σ المدين = (الإجمالي − العمولة − الضريبة) + العمولة + الضريبة = الإجمالي */
export function buildClearingMove(i: ClearingInput, ctx: BuildContext): MoveDraft {
  const problems = clearingInputProblems(i, ctx);
  if (problems.length > 0) throw new LedgerError('LEDGER_CLEARING_INVALID', { reason: problems[0].reason, problems });
  const { settings } = ctx;
  const gross = i.grossMilli;
  const fee = i.feeMilli ?? 0n;
  const vat = i.feeVatMilli ?? 0n;
  const net = gross - fee - vat;
  const clearing = clearingAccountOf(i.kind, ctx) as AccountRef;
  const kindLabel = CLEARING_KIND_LABELS[i.kind];
  const refPart = i.ref && i.ref.trim() ? ` — مرجع ${i.ref.trim()}` : '';
  const notePart = i.note && i.note.trim() ? ` — ${i.note.trim()}` : '';

  const lines: LineDraft[] = [];
  if (net > 0n) {
    lines.push({ accountId: i.bankAccountId, label: `${kindLabel}: الصافي المودَع في الحساب${refPart}`, debitMilli: net, creditMilli: 0n });
  }
  if (fee > 0n) {
    lines.push({ accountKey: 'BANK_FEES', label: `${kindLabel}: عمولة البنك قبل الضريبة`, debitMilli: fee, creditMilli: 0n });
  }
  if (vat > 0n) {
    const tax = clearingFeeTax(ctx) as TaxRef;
    lines.push({
      ...(tax.accountId ? { accountId: tax.accountId } : { accountKey: 'INPUT_VAT' as const }),
      label: `${kindLabel}: ضريبة القيمة المضافة على عمولة البنك`,
      debitMilli: vat, creditMilli: 0n,
      taxId: tax.id, taxCode: tax.key ?? null, taxRole: 'TAX', taxBaseMilli: fee, vatBox: tax.vatBox,
    });
  }
  lines.push({ accountId: clearing.id, label: `${kindLabel}: تصفية ${clearing.name}${refPart}`, debitMilli: 0n, creditMilli: gross });

  const journalCode = i.journalCode && i.journalCode.trim() ? i.journalCode.trim() : null;
  return {
    kind: 'MOVE',
    journalCode: journalCode ?? ctx.journals.bySystemKey('BANK_MAIN')?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY.BANK_MAIN,
    // دفتر البنك المختار بالرمز يعلو على المفتاح (post.ts يقدّم journalSystemKey على الرمز)
    ...(journalCode ? {} : { journalSystemKey: 'BANK_MAIN' as const }),
    moveType: 'RECONCILE',
    origin: 'MANUAL',
    date: i.date,
    ref: i.ref && i.ref.trim() ? i.ref.trim() : null,
    narration: `${kindLabel}${refPart}${notePart}`,
    needsAttention: false,
    attentionReason: null,
    sourceType: null,
    sourceId: null,
    sourceKey: null,
    sourceEvent: null,
    currencyCode: settings.currency,
    currencyDecimals: settings.currencyDecimals,
    lines,
  };
}

// ═══ السطور المفتوحة على الحساب الوسيط والمطابقة (صرفة — المسار يحمّل الصفوف) ═══

/** سطر مدين على الحساب الوسيط كما يحمّله المسار: المطابَق منه (CLR غير المعكوسة) محسوب في matchedMilli */
export interface ClearingLineRow {
  lineId: string;
  moveId: string;
  moveNumber: string | null;
  date: LocalDate;
  label: string | null;
  seq: number;
  debitMilli: Milli;
  matchedMilli: Milli;
}

export interface ClearingOpenLine {
  lineId: string;
  moveId: string;
  moveNumber: string | null;
  date: LocalDate;
  label: string | null;
  seq: number;
  amountMilli: Milli;
  residualMilli: Milli;
}

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** الأقدم فالأقدم: التاريخ ثم رقم القيد (ترتيب ثنائي لا محلّي، فلا يتبدّل بلغة الخادم) ثم ترتيب السطر ثم معرّفه — حتمي */
const byAge = (a: { date: LocalDate; moveNumber: string | null; seq: number; lineId: string },
  b: { date: LocalDate; moveNumber: string | null; seq: number; lineId: string }): number =>
  compareLocalDate(a.date, b.date)
  || cmpText(a.moveNumber ?? '', b.moveNumber ?? '')
  || a.seq - b.seq
  || cmpText(a.lineId, b.lineId);

/**
 * المتبقّي المفتوح لكل سطر مدين، بعد المطابَق وبعد ما يقابله في زوج العكس: قيدٌ عُكس (أو قيدٌ عاكس) يقابل مدينَه على الحساب
 * دائنُ قرينه على الحساب نفسه (pairCreditByMove)، يُوزَّع على سطور القيد بترتيبها. فسند نقطة بيع أُلغي بمرآته لا يظهر مفتوحاً،
 * وأُلغي بردٍّ من الصندوق (C11) يبقى مفتوحاً لأن المال ما زال آتياً من البنك. الناتج بالأقدم فالأقدم، والمتبقّي > 0 وحده.
 */
export function openClearingLines(rows: readonly ClearingLineRow[], pairCreditByMove: ReadonlyMap<string, Milli>): ClearingOpenLine[] {
  const byMove = new Map<string, ClearingLineRow[]>();
  for (const r of rows) {
    const list = byMove.get(r.moveId) ?? [];
    list.push(r);
    byMove.set(r.moveId, list);
  }
  const out: ClearingOpenLine[] = [];
  for (const [moveId, list] of byMove) {
    let offset = maxMilli(0n, pairCreditByMove.get(moveId) ?? 0n);
    for (const r of [...list].sort((a, b) => a.seq - b.seq || cmpText(a.lineId, b.lineId))) {
      let residual = maxMilli(0n, r.debitMilli - maxMilli(0n, r.matchedMilli));
      const take = minMilli(offset, residual);
      residual -= take;
      offset -= take;
      if (residual > 0n) {
        out.push({
          lineId: r.lineId, moveId: r.moveId, moveNumber: r.moveNumber, date: r.date, label: r.label, seq: r.seq,
          amountMilli: r.debitMilli, residualMilli: residual,
        });
      }
    }
  }
  return out.sort(byAge);
}

export interface ClearingMatch {
  debitLineId: string;
  debitMoveId: string;
  creditLineId: string;
  creditMoveId: string;
  amountMilli: Milli;
  sourceRef: string;
}

/**
 * يوزّع الإجمالي على السطور المفتوحة بالأقدم فالأقدم بحدّ متبقّي كلٍّ منها. السطور المفتوحة تصل مختارةً أو كلّها؛
 * والإجمالي أكبر من مجموعها يُرفض في المسار قبل الترحيل (لا يبقى للحساب الوسيط رصيد دائن).
 */
export function planClearingMatches(
  open: readonly ClearingOpenLine[], credit: { lineId: string; moveId: string }, grossMilli: Milli, sourceRef: string,
): ClearingMatch[] {
  const out: ClearingMatch[] = [];
  let remaining = grossMilli;
  for (const l of [...open].sort(byAge)) {
    if (remaining <= 0n) break;
    const amt = minMilli(remaining, l.residualMilli);
    if (amt <= 0n) continue;
    out.push({ debitLineId: l.lineId, debitMoveId: l.moveId, creditLineId: credit.lineId, creditMoveId: credit.moveId, amountMilli: amt, sourceRef });
    remaining -= amt;
  }
  return out;
}

/** مجموع المتبقّي */
export function openResidualTotal(open: readonly ClearingOpenLine[]): Milli {
  let s = 0n;
  for (const l of open) s += l.residualMilli;
  return s;
}
