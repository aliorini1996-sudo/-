/**
 * مسودات القيود اليدوية (M2، DESIGN.md §6.1، §2.1، §2.3، §3.9، §4.4).
 *
 * 1) buildManualMoveDraft (صرفة): مدخلات النموذج ⇒ MoveDraft يدوي (moveType=ENTRY، origin=MANUAL) مع
 *    **توليد سطر الضريبة ووعائه آلياً** لكل سطر يحمل taxId، ومخالفات I1–I5/I8 مجمّعة بلا رمي (المسودة تُحفظ ناقصة
 *    والترحيل يرفض)، وتاريخ الإقفال الفعّال للتنبيه.
 * 2) draftRowsFromMoveDraft (صرفة): MoveDraft ⇒ صفوف gl_moves/gl_move_lines بحالة DRAFT بلا رقم.
 * 3) saveDraftMove (tx): إنشاء المسودة أو استبدال سطورها تحت قفل الترحيل، بتدقيق MOVE_CREATE/MOVE_UPDATE_DRAFT.
 * moveType لا يُقبل من المدخلات (§5.9): اليدوي ENTRY دائماً.
 */
import { appendAudit, type GlActor, type GlTx } from './audit';
import { fromDbDate, isLocalDate, toDbDate } from './dates';
import { effectiveLockDate, lockScopeOfDraft, type EffectiveLock } from './locks';
import { toMilli, unitMilli, MAX_CURRENCY_DECIMALS } from './money';
import { acquirePostLock } from './post';
import { manualOwnership, type MoveRecord } from './resolve';
import { collectMoveIssues, resolveLineAccount, type ValidationIssue } from './validate';
import {
  LedgerError, VAT_CONTROL_KINDS,
  type BuildContext, type JournalRef, type LineDraft, type LocalDate, type MappingKey, type Milli, type MoveDraft,
  type TaxRef, type TaxRole,
} from './types';
import type { Prisma } from '@prisma/client';

// ═══ المدخلات ═══

type AmountInput = string | number | null | undefined;

export interface ManualLineInput {
  /** معرّف حساب للشركة (يُتحقق من انتمائه عبر السياق) */
  accountId: string;
  label?: string | null;
  debit?: AmountInput;
  credit?: AmountInput;
  customerId?: string | null;
  vendorId?: string | null;
  salesRepId?: string | null;
  partnerName?: string | null;
  analyticAccountId?: string | null;
  productId?: string | null;
  quantity?: number | null;
  /** ضريبة على السطر ⇒ يُولَّد سطر الضريبة (أو العلامة) ووعاؤه آلياً */
  taxId?: string | null;
  vatBox?: string | null;
  dueDate?: LocalDate | null;
  /**
   * دور الضريبة كما في حفظ سابق. سطر على حساب VAT_OUT/VAT_IN يحمل taxId يُعدّ **سطر ضريبة يدوياً** (I4) أياً كان دوره
   * فيُحفظ كما كتبه المستخدم بلا توليد. وسطر TAX/MARKER على غير حسابات الضريبة بلا generated يُعامَل مولَّداً قديماً فيُهمل.
   */
  taxRole?: TaxRole | null;
  /** سطر مولَّد آلياً في حفظ سابق (generatedLineIndexes أو نسخة «إعادة إلى مسودة») ⇒ يُهمل ويُعاد توليده من سطور الوعاء */
  generated?: boolean | null;
  /** وعاء سطر الضريبة اليدوي (اختياري)؛ يُهمل لغير سطور الضريبة اليدوية */
  taxBaseMilli?: AmountInput;
}

export interface ManualMoveInput {
  journal: JournalRef;
  date: LocalDate;
  ref?: string | null;
  narration?: string | null;
  lines: readonly ManualLineInput[];
}

export interface ManualDraftBuild {
  draft: MoveDraft;
  /** فهارس السطور المولَّدة آلياً في draft.lines */
  generatedLineIndexes: number[];
  /** مخالفات I1–I5 وI8 بوضع MANUAL (فارغة ⇒ صالحة للترحيل ما لم تُقفل الفترة) */
  issues: ValidationIssue[];
  totalDebitMilli: Milli;
  totalCreditMilli: Milli;
  /** الإقفال الفعّال لنطاق القيد؛ locked=true ⇒ الترحيل سيرد LEDGER_PERIOD_LOCKED */
  lock: EffectiveLock & { locked: boolean };
}

// ═══ المبالغ ═══

/**
 * مبلغ نموذج ⇒ ملّي: الفارغ صفر؛ نص غير رقمي ⇒ LEDGER_UNBALANCED{reason:'INVALID_AMOUNT'}؛
 * منازل تتجاوز العملة ⇒ LEDGER_UNBALANCED{reason:'AMOUNT_PRECISION'} (§3.9). السالب يُترك لـI2.
 */
export function parseManualAmount(v: AmountInput, decimals: number, where: { lineIndex: number; field: 'debit' | 'credit' | 'taxBaseMilli' }): Milli {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return 0n;
  let exact: Milli;
  let rounded: Milli;
  try {
    exact = toMilli(v, MAX_CURRENCY_DECIMALS);
    rounded = toMilli(v, decimals);
  } catch {
    throw new LedgerError('LEDGER_UNBALANCED', { reason: 'INVALID_AMOUNT', ...where, value: String(v) });
  }
  if (typeof v === 'string') {
    const frac = /\.(\d*)$/.exec(v.trim())?.[1] ?? '';
    if (frac.slice(decimals).replace(/0+$/, '') !== '') {
      throw new LedgerError('LEDGER_UNBALANCED', { reason: 'AMOUNT_PRECISION', ...where, value: v, decimals });
    }
  } else if (exact !== rounded) {
    throw new LedgerError('LEDGER_UNBALANCED', { reason: 'AMOUNT_PRECISION', ...where, value: String(v), decimals });
  }
  return rounded;
}

/**
 * a × num ÷ den مقرّباً مرة واحدة نصف-لأعلى (بعيداً عن الصفر) من الكسر الدقيق إلى أصغر وحدة عملة (§2.3).
 * لا تقريب وسيط إلى الملّي: 0.0345 ⇒ 0.03 لا 0.035 ⇒ 0.04.
 */
export function mulDivRoundUnit(a: Milli, num: bigint, den: bigint, decimals: number): Milli {
  if (den <= 0n) throw new RangeError('mulDivRoundUnit: مقام غير موجب');
  const u = unitMilli(decimals);
  const neg = (a < 0n) !== (num < 0n);
  const absA = a < 0n ? -a : a;
  const absN = num < 0n ? -num : num;
  const p = absA * absN;
  const D = den * u;
  const q = p / D;
  const r = p % D;
  const out = (r * 2n >= D ? q + 1n : q) * u;
  return neg ? -out : out;
}

/** النسبة ×10⁴ عدداً صحيحاً (7.5 ⇒ 75000). */
const RATE_SCALE = 1_000_000n; // 100 × 10⁴
function rateScaled(rate: number): bigint {
  return BigInt(Math.round(rate * 10_000));
}

/** ضريبة وعاء صافٍ: base × rate/100 مقرّبة مرة واحدة لمنازل العملة. */
export function taxOnBase(baseMilli: Milli, rate: number, decimals: number): Milli {
  return mulDivRoundUnit(baseMilli, rateScaled(rate), RATE_SCALE, decimals);
}

/** وعاء من مبلغ شامل: gross × 100/(100+rate) مقرّباً مرة واحدة لمنازل العملة. */
export function baseFromGross(grossMilli: Milli, rate: number, decimals: number): Milli {
  return mulDivRoundUnit(grossMilli, RATE_SCALE, RATE_SCALE + rateScaled(rate), decimals);
}

// ═══ البناء ═══

type Side = 'D' | 'C';

interface TaxBucket {
  tax: TaxRef;
  side: Side;
  /** للضريبة غير القابلة للخصم: حساب سطر الوعاء */
  costAccountId: string | null;
  bases: Milli[];
  /** ضريبة مستخرجة من مبالغ شاملة (Σ gross − Σ base) */
  includedTax: Milli;
  firstIndex: number;
}

function naturalTaxSide(tax: TaxRef): Side {
  return tax.use === 'SALE' ? 'C' : 'D';
}

function taxAccountTarget(tax: TaxRef): Pick<LineDraft, 'accountId' | 'accountKey'> {
  if (tax.accountId) return { accountId: tax.accountId };
  const key: MappingKey = tax.use === 'SALE' ? 'OUTPUT_VAT' : 'INPUT_VAT';
  return { accountKey: key };
}

function pctText(rate: number): string {
  return `${Number.isInteger(rate) ? rate : rate.toString()}٪`;
}

const trimOrNull = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/**
 * مدخلات القيد اليدوي ⇒ مسودة المحرك مع سطور الضريبة المولَّدة (§6.1، §4.4):
 * - سطر بـtaxId: taxRole=BASE. الضريبة الشاملة (priceInclude) تُستخرج من مبلغه فيصبح صافياً.
 * - لكل سلة (ضريبة، جانب): سطر TAX بحساب الضريبة (أو OUTPUT_VAT/INPUT_VAT)، ومبلغ taxRoundingMethod
 *   (PER_TAX: تقريب Σ الوعاء مرة، PER_LINE: Σ تقريب كل سطر)، وtaxBaseMilli = Σ الوعاء، وvatBox = tax.vatBox.
 *   الوعاء موجب في جانب الضريبة الطبيعي (المبيعات دائن، المشتريات مدين) وسالب مع vatAdjustment=true في عكسه.
 * - نسبة صفرية نشطة غير O ⇒ سطر علامة 0/0 بوعائها. O أو use=NONE ⇒ لا سطر.
 * - deductible=false ⇒ الضريبة على حساب سطر الوعاء نفسه (تُضاف للتكلفة) بلا مربع.
 * - rcOutputAccountId (احتساب عكسي) ⇒ سطر مدخلات وسطر مخرجات معاكس بالمبلغ نفسه.
 * أخطاء مرمية: LEDGER_UNBALANCED{INVALID_AMOUNT|AMOUNT_PRECISION}، LEDGER_ACCOUNT_NOT_FOUND{TAX_NOT_FOUND}،
 * LEDGER_ACCOUNT_ARCHIVED{TAX_ARCHIVED}. بقية المخالفات تُعاد في issues.
 */
export function buildManualMoveDraft(input: ManualMoveInput, ctx: BuildContext): ManualDraftBuild {
  const settings = ctx.settings;
  const dec = settings.currencyDecimals;
  if (!isLocalDate(input.date)) throw new RangeError(`تاريخ القيد غير صالح: ${String(input.date)}`);

  const lines: LineDraft[] = [];
  const buckets = new Map<string, TaxBucket>();
  const bucketOrder: TaxBucket[] = [];

  input.lines.forEach((raw, inputIndex) => {
    if (raw.generated === true) return; // مولَّد في حفظ سابق ⇒ يُعاد توليده
    const rawAccount = raw.accountId ? ctx.accounts.byId(raw.accountId) : null;
    const onVatAccount = !!rawAccount?.controlKind && VAT_CONTROL_KINDS.includes(rawAccount.controlKind);
    // مولَّد قديم بلا علم generated (مثل ضريبة غير قابلة للخصم على حساب التكلفة) ⇒ يُهمل كالسابق
    if ((raw.taxRole === 'TAX' || raw.taxRole === 'MARKER') && !onVatAccount) return;
    let debit = parseManualAmount(raw.debit, dec, { lineIndex: inputIndex, field: 'debit' });
    let credit = parseManualAmount(raw.credit, dec, { lineIndex: inputIndex, field: 'credit' });
    const line: LineDraft = {
      accountId: raw.accountId,
      label: raw.label ?? '',
      debitMilli: debit,
      creditMilli: credit,
      customerId: trimOrNull(raw.customerId),
      vendorId: trimOrNull(raw.vendorId),
      salesRepId: trimOrNull(raw.salesRepId),
      partnerName: trimOrNull(raw.partnerName),
      analyticAccountId: trimOrNull(raw.analyticAccountId),
      productId: trimOrNull(raw.productId),
      quantity: raw.quantity ?? null,
      vatBox: trimOrNull(raw.vatBox),
      dueDate: raw.dueDate ?? null,
    };
    const taxId = trimOrNull(raw.taxId);
    if (taxId) {
      const tax = ctx.taxes.byId(taxId);
      if (!tax) throw new LedgerError('LEDGER_ACCOUNT_NOT_FOUND', { reason: 'TAX_NOT_FOUND', lineIndex: inputIndex, taxId });
      if (!tax.isActive) throw new LedgerError('LEDGER_ACCOUNT_ARCHIVED', { reason: 'TAX_ARCHIVED', lineIndex: inputIndex, taxId });
      line.taxId = tax.id;
      if (onVatAccount) {
        // I4: سطر ضريبة يدوي (تسوية أو تصحيح إقرار) — يُحفظ كما كُتب، لا سلة ولا توليد
        line.taxRole = raw.taxRole === 'MARKER' ? 'MARKER' : 'TAX';
        const hasBase = !(raw.taxBaseMilli === null || raw.taxBaseMilli === undefined || (typeof raw.taxBaseMilli === 'string' && raw.taxBaseMilli.trim() === ''));
        line.taxBaseMilli = hasBase ? parseManualAmount(raw.taxBaseMilli, dec, { lineIndex: inputIndex, field: 'taxBaseMilli' }) : null;
        lines.push(line);
        return;
      }
      line.taxRole = 'BASE';
      const side: Side | null = debit > 0n && credit === 0n ? 'D' : credit > 0n && debit === 0n ? 'C' : null;
      if (side && tax.use !== 'NONE') {
        let includedTax = 0n;
        if (tax.priceInclude && tax.rate > 0) {
          const gross = side === 'D' ? debit : credit;
          const base = baseFromGross(gross, tax.rate, dec);
          includedTax = gross - base;
          if (side === 'D') debit = base; else credit = base;
          line.debitMilli = debit;
          line.creditMilli = credit;
        }
        const costAccountId = tax.deductible ? null : raw.accountId;
        const key = `${tax.id}|${side}|${costAccountId ?? ''}`;
        let b = buckets.get(key);
        if (!b) {
          b = { tax, side, costAccountId, bases: [], includedTax: 0n, firstIndex: lines.length };
          buckets.set(key, b);
          bucketOrder.push(b);
        }
        b.bases.push(side === 'D' ? debit : credit);
        b.includedTax += includedTax;
      }
    }
    lines.push(line);
  });

  const userLineCount = lines.length;
  for (const b of bucketOrder) {
    const { tax, side } = b;
    const sumBase = b.bases.reduce((a, x) => a + x, 0n);
    const natural = naturalTaxSide(tax) === side;
    const signedBase = natural ? sumBase : -sumBase;
    const adj = natural ? {} : { vatAdjustment: true };
    const put = (d: Milli): Pick<LineDraft, 'debitMilli' | 'creditMilli'> => (side === 'D' ? { debitMilli: d, creditMilli: 0n } : { debitMilli: 0n, creditMilli: d });
    const opposite = (d: Milli): Pick<LineDraft, 'debitMilli' | 'creditMilli'> => (side === 'D' ? { debitMilli: 0n, creditMilli: d } : { debitMilli: d, creditMilli: 0n });

    if (tax.rate === 0) {
      if (tax.vatCategory === 'O') continue;
      lines.push({
        ...taxAccountTarget(tax), label: `وعاء ${tax.name}`, debitMilli: 0n, creditMilli: 0n,
        taxId: tax.id, taxRole: 'MARKER', taxBaseMilli: signedBase, vatBox: tax.vatBox, ...adj,
      });
      continue;
    }

    let amount: Milli;
    if (tax.priceInclude) amount = b.includedTax;
    else if (settings.taxRoundingMethod === 'PER_LINE') amount = b.bases.reduce((a, x) => a + taxOnBase(x, tax.rate, dec), 0n);
    else amount = taxOnBase(sumBase, tax.rate, dec);
    if (amount === 0n) continue;

    if (!tax.deductible) {
      lines.push({
        accountId: b.costAccountId as string, label: `${tax.name} (غير قابلة للخصم)`, ...put(amount),
        taxId: tax.id, taxRole: 'TAX', taxBaseMilli: signedBase, vatBox: null, ...adj,
      });
      continue;
    }
    lines.push({
      ...taxAccountTarget(tax), label: `${tax.name} ${pctText(tax.rate)}`, ...put(amount),
      taxId: tax.id, taxRole: 'TAX', taxBaseMilli: signedBase, vatBox: tax.vatBox, ...adj,
    });
    if (tax.rcOutputAccountId) {
      lines.push({
        accountId: tax.rcOutputAccountId, label: `${tax.name} — مخرجات الاحتساب العكسي`, ...opposite(amount),
        taxId: tax.id, taxRole: 'TAX', taxBaseMilli: signedBase, vatBox: null, ...adj,
      });
    }
  }

  const draft: MoveDraft = {
    kind: 'MOVE',
    journalCode: input.journal.code,
    ...(input.journal.systemKey ? { journalSystemKey: input.journal.systemKey } : {}),
    moveType: 'ENTRY',
    origin: 'MANUAL',
    date: input.date,
    originalDate: null,
    lateArrival: false,
    ref: trimOrNull(input.ref),
    narration: input.narration ?? '',
    needsAttention: false,
    attentionReason: null,
    currencyCode: settings.currency,
    currencyDecimals: dec,
    lines,
  };

  const report = collectMoveIssues(draft, ctx, { mode: 'MANUAL' });
  const eff = effectiveLockDate(
    { salesLockDate: settings.salesLockDate, purchaseLockDate: settings.purchaseLockDate, taxLockDate: settings.taxLockDate, hardLockDate: settings.hardLockDate },
    lockScopeOfDraft(draft, ctx),
  );
  const generatedLineIndexes: number[] = [];
  for (let i = userLineCount; i < lines.length; i++) generatedLineIndexes.push(i);
  return {
    draft,
    generatedLineIndexes,
    issues: report.issues,
    totalDebitMilli: report.totalDebitMilli,
    totalCreditMilli: report.totalCreditMilli,
    lock: { ...eff, locked: eff.lockDate !== null && input.date <= eff.lockDate },
  };
}

// ═══ المبلغ الشامل لسطور الوعاء المخزَّنة (priceInclude) ═══

export interface StoredTaxLine {
  accountId: string;
  taxRole: string | null;
  taxId: string | null;
  debitMilli: Milli;
  creditMilli: Milli;
  taxBaseMilli: Milli | null;
}

export type PriceIncludeTaxInfo = Pick<TaxRef, 'id' | 'rate' | 'priceInclude' | 'deductible'> & { use: string };

/**
 * عقد إعادة الحفظ للضريبة الشاملة (§6.1): سطر الوعاء يُخزَّن **صافياً** بعد استخراج الضريبة، بينما
 * buildManualMoveDraft يقرأ مبلغ سطر بضريبة priceInclude **شاملاً**. إرسال الصافي كما هو يُنقص الوعاء في كل حفظ.
 * هذه الدالة تعيد لكل سطر BASE بضريبة شاملة (نسبة > 0، use ≠ NONE) المبلغ الشامل g الذي يعيد بناؤه السطورَ نفسها
 * بالضبط: baseFromGross(g) = الوعاء المخزَّن، وΣ(g − الوعاء) في السلة = مبلغ سطر الضريبة المولَّد المخزَّن.
 * لكل وعاء مرشّحان على الأكثر (مبلغان شاملان متجاوران يقرَّبان للوعاء نفسه)، فيُختار العدد اللازم من «الأعلى»
 * بالترتيب ليطابق المجموع. غير ذلك من السطور ⇒ null (مبلغه يُرسَل كما خُزِّن).
 * `generated` علم التوليد لكل سطر (generatedLineFlags)؛ السلة كما في البناء: (الضريبة، الجانب، وحساب التكلفة لغير القابلة للخصم).
 */
export function priceIncludeGrossAmounts(
  lines: readonly StoredTaxLine[],
  generated: readonly boolean[],
  taxById: (id: string) => PriceIncludeTaxInfo | null | undefined,
  decimals: number,
): (Milli | null)[] {
  const u = unitMilli(decimals);
  const out: (Milli | null)[] = lines.map(() => null);
  const sideOf = (l: StoredTaxLine): Side | null =>
    l.debitMilli > 0n && l.creditMilli === 0n ? 'D' : l.creditMilli > 0n && l.debitMilli === 0n ? 'C' : null;
  const buckets = new Map<string, { tax: PriceIncludeTaxInfo; side: Side; cost: string | null; idx: number[]; sum: Milli }>();
  lines.forEach((l, i) => {
    if (generated[i] || l.taxRole !== 'BASE' || !l.taxId) return;
    const tax = taxById(l.taxId);
    if (!tax || !tax.priceInclude || !(tax.rate > 0) || tax.use === 'NONE') return;
    const side = sideOf(l);
    if (!side) return;
    const cost = tax.deductible ? null : l.accountId;
    const key = `${tax.id}|${side}|${cost ?? ''}`;
    let b = buckets.get(key);
    if (!b) { b = { tax, side, cost, idx: [], sum: 0n }; buckets.set(key, b); }
    b.idx.push(i);
    b.sum += side === 'D' ? l.debitMilli : l.creditMilli;
  });
  const used = new Set<number>();
  for (const b of buckets.values()) {
    let taxAmount = 0n;
    const j = lines.findIndex((l, k) => {
      if (!generated[k] || used.has(k) || l.taxRole !== 'TAX' || l.taxId !== b.tax.id || sideOf(l) !== b.side) return false;
      const base = l.taxBaseMilli === null ? null : l.taxBaseMilli < 0n ? -l.taxBaseMilli : l.taxBaseMilli;
      return base === b.sum && (b.cost === null || l.accountId === b.cost);
    });
    if (j >= 0) {
      used.add(j);
      taxAmount = b.side === 'D' ? lines[j].debitMilli : lines[j].creditMilli;
    }
    const scaled = RATE_SCALE + rateScaled(b.tax.rate);
    const ranges = b.idx.map((i) => {
      const l = lines[i];
      const base = b.side === 'D' ? l.debitMilli : l.creditMilli;
      const g0 = mulDivRoundUnit(base, scaled, RATE_SCALE, decimals);
      const cands: Milli[] = [];
      for (let k = -3n; k <= 3n; k++) {
        const g = g0 + k * u;
        if (g > 0n && baseFromGross(g, b.tax.rate, decimals) === base) cands.push(g);
      }
      return { i, lo: cands[0] ?? g0, hi: cands[cands.length - 1] ?? g0 };
    });
    let steps = (b.sum + taxAmount - ranges.reduce((a, r) => a + r.lo, 0n)) / u;
    for (const r of ranges) {
      const room = (r.hi - r.lo) / u;
      const extra = steps <= 0n ? 0n : steps < room ? steps : room;
      steps -= extra;
      out[r.i] = r.lo + extra * u;
    }
  }
  return out;
}

// ═══ صفوف المسودة ═══

export type DraftMoveRow = Omit<Prisma.GlMoveUncheckedCreateInput, 'lines' | 'sources' | 'notes' | 'reversal'>;
export type DraftLineRow = Omit<Prisma.GlMoveLineCreateManyInput, 'moveId'>;

export interface DraftRows {
  move: DraftMoveRow;
  lines: DraftLineRow[];
}

/**
 * MoveDraft ⇒ صفوف مسودة (state=DRAFT، number=null، posted=false). الحساب يُحلّ id ثم code ثم key،
 * وغير المحلول ⇒ LEDGER_ACCOUNT_NOT_FOUND (المفتاح الأجنبي لا يقبل سطراً بلا حساب).
 */
export function draftRowsFromMoveDraft(
  draft: MoveDraft,
  ctx: BuildContext,
  opts: {
    tenantId: string; journalId: string; actor: GlActor; autoPostOn?: LocalDate | null; draftOfMoveId?: string | null;
    /**
     * فهارس السطور المولَّدة آلياً (buildManualMoveDraft.generatedLineIndexes، أو علم generated المخزَّن لنسخة
     * «إعادة إلى مسودة») ⇒ عمود GlMoveLine.generated=true (M3). الغائب ⇒ لا سطر مولَّد.
     */
    generatedLineIndexes?: readonly number[];
  },
): DraftRows {
  const date = toDbDate(draft.date);
  const generatedSet = new Set(opts.generatedLineIndexes ?? []);
  let total = 0n;
  const lines: DraftLineRow[] = draft.lines.map((l, i) => {
    const account = resolveLineAccount(l, ctx.accounts);
    if (!account) {
      throw new LedgerError('LEDGER_ACCOUNT_NOT_FOUND', {
        reason: 'ACCOUNT_NOT_FOUND', lineIndex: i, accountCode: l.accountCode ?? l.accountKey ?? l.accountId ?? null,
      });
    }
    total += l.debitMilli;
    const taxId = l.taxId ?? (l.taxCode ? ctx.taxes.byKey(l.taxCode)?.id ?? null : null);
    return {
      tenantId: opts.tenantId,
      seq: i,
      accountId: account.id,
      journalId: opts.journalId,
      date,
      posted: false,
      label: l.label,
      debitMilli: l.debitMilli,
      creditMilli: l.creditMilli,
      customerId: l.customerId ?? null,
      vendorId: l.vendorId ?? null,
      salesRepId: l.salesRepId ?? null,
      partnerName: l.partnerName ?? null,
      analyticAccountId: l.analyticAccountId ?? null,
      productId: l.productId ?? null,
      quantity: l.quantity ?? null,
      taxId,
      taxRole: l.taxRole ?? null,
      taxBaseMilli: l.taxBaseMilli ?? null,
      vatBox: l.vatBox ?? null,
      vatAdjustment: l.vatAdjustment === true,
      dueDate: l.dueDate ? toDbDate(l.dueDate) : null,
      generated: generatedSet.has(i),
    };
  });
  const move: DraftMoveRow = {
    tenantId: opts.tenantId,
    journalId: opts.journalId,
    number: null,
    state: 'DRAFT',
    moveType: draft.moveType,
    origin: draft.origin,
    date,
    originalDate: draft.originalDate ? toDbDate(draft.originalDate) : null,
    lateArrival: draft.lateArrival === true,
    ref: draft.ref ?? null,
    narration: draft.narration,
    currencyCode: draft.currencyCode,
    currencyDecimals: draft.currencyDecimals,
    totalMilli: total,
    customerId: draft.customerId ?? null,
    vendorId: draft.vendorId ?? null,
    salesRepId: draft.salesRepId ?? null,
    sourceType: draft.sourceType ?? null,
    sourceId: draft.sourceId ?? null,
    draftOfMoveId: opts.draftOfMoveId ?? null,
    autoPostOn: opts.autoPostOn ? toDbDate(opts.autoPostOn) : null,
    needsAttention: draft.needsAttention,
    attentionReason: draft.attentionReason ?? null,
    createdBy: opts.actor.actorId,
    createdByImpersonated: opts.actor.impersonated === true,
  };
  return { move, lines };
}

/** لقطة مسودة للتدقيق (المبالغ نصوص). */
export function draftAuditSnapshot(rows: DraftRows | { move: Record<string, unknown>; lines: readonly Record<string, unknown>[] }): Record<string, unknown> {
  return { move: rows.move, lines: rows.lines };
}

export interface SaveDraftOptions {
  tenantId: string;
  actor: GlActor;
  rows: DraftRows;
  /** غائب ⇒ إنشاء؛ موجود ⇒ استبدال رأس المسودة وسطورها */
  moveId?: string | null;
  /** الافتراضي MOVE_CREATE أو MOVE_UPDATE_DRAFT */
  auditAction?: string;
  auditSummary?: string;
  now?: Date;
}

/**
 * يحفظ مسودة يدوية داخل المعاملة tx تحت قفل الترحيل (فلا تتداخل مع ترحيلها):
 * - إنشاء: glMove.create بسطوره، وتدقيق MOVE_CREATE.
 * - تعديل: الرأس بـupdateMany بشرط state:'DRAFT' وnumber:null وorigin:'MANUAL' (وإلا LEDGER_MOVE_NOT_DRAFT)،
 *   والسطور تُحذف وتُعاد بشرط move {state:'DRAFT', number:null}، وتدقيق MOVE_UPDATE_DRAFT بلقطتي قبل وبعد.
 * قيد مملوك لمصدر (I7) ⇒ LEDGER_SOURCE_OWNED_MOVE. غير موجود ⇒ LEDGER_MOVE_NOT_DRAFT{reason:'NOT_FOUND'}.
 */
export async function saveDraftMove(tx: GlTx, opts: SaveDraftOptions): Promise<{ id: string; created: boolean }> {
  const { tenantId, actor, rows } = opts;
  if (rows.move.tenantId !== tenantId || rows.lines.some((l) => l.tenantId !== tenantId)) {
    throw new RangeError('saveDraftMove: tenantId الصفوف لا يطابق الشركة');
  }
  if (rows.move.state !== 'DRAFT' || rows.move.number != null) throw new RangeError('saveDraftMove: الصفوف ليست مسودة');
  await acquirePostLock(tx, tenantId);
  const now = opts.now ?? new Date();

  if (!opts.moveId) {
    const created = await tx.glMove.create({
      data: { ...rows.move, lines: { create: rows.lines.map((l) => ({ ...l, tenantId })) } },
      select: { id: true },
    });
    await appendAudit(tx, {
      tenantId, actor, action: opts.auditAction ?? 'MOVE_CREATE', entityType: 'MOVE', entityId: created.id,
      summary: opts.auditSummary ?? 'إنشاء مسودة قيد يدوي', after: draftAuditSnapshot(rows), at: now,
    });
    return { id: created.id, created: true };
  }

  const moveId = opts.moveId;
  const before = await tx.glMove.findFirst({
    where: { id: moveId, tenantId },
    select: {
      id: true, state: true, number: true, origin: true, sourceType: true, sourceId: true, salesRepId: true, journalId: true,
      date: true, ref: true, narration: true, totalMilli: true, autoPostOn: true,
      sources: { select: { sourceType: true, sourceId: true } },
      lines: { select: { seq: true, accountId: true, label: true, debitMilli: true, creditMilli: true, taxId: true, taxRole: true, taxBaseMilli: true, vatBox: true, account: { select: { controlKind: true } } }, orderBy: { seq: 'asc' } },
    },
  });
  if (!before) throw new LedgerError('LEDGER_MOVE_NOT_DRAFT', { moveId, reason: 'NOT_FOUND' });
  if (before.state !== 'DRAFT' || before.number !== null) {
    throw new LedgerError('LEDGER_MOVE_NOT_DRAFT', { moveId, state: before.state, number: before.number });
  }
  const owned = manualOwnership({
    origin: before.origin, sourceType: before.sourceType, sourceId: before.sourceId, salesRepId: before.salesRepId,
    moveSources: before.sources, lineControlKinds: [],
  });
  if (owned) {
    throw new LedgerError('LEDGER_SOURCE_OWNED_MOVE', { sourceType: owned.sourceType, sourceId: owned.sourceId, ownerAction: owned.ownerAction });
  }

  const { tenantId: _t, ...header } = rows.move;
  void _t;
  const updated = await tx.glMove.updateMany({
    where: { id: moveId, tenantId, state: 'DRAFT', number: null, origin: 'MANUAL' },
    data: {
      journalId: header.journalId, date: header.date, originalDate: header.originalDate, ref: header.ref,
      narration: header.narration, currencyCode: header.currencyCode, currencyDecimals: header.currencyDecimals,
      totalMilli: header.totalMilli, customerId: header.customerId, vendorId: header.vendorId, salesRepId: header.salesRepId,
      autoPostOn: header.autoPostOn, needsAttention: header.needsAttention, attentionReason: header.attentionReason,
    },
  });
  if (updated.count !== 1) throw new LedgerError('LEDGER_MOVE_NOT_DRAFT', { moveId, reason: 'RACE' });
  await tx.glMoveLine.deleteMany({ where: { tenantId, moveId, move: { state: 'DRAFT', number: null } } });
  await tx.glMoveLine.createMany({ data: rows.lines.map((l) => ({ ...l, tenantId, moveId })) });

  await appendAudit(tx, {
    tenantId, actor, action: opts.auditAction ?? 'MOVE_UPDATE_DRAFT', entityType: 'MOVE', entityId: moveId,
    summary: opts.auditSummary ?? 'تعديل مسودة قيد يدوي',
    before: { move: { ...before, date: fromDbDate(before.date), lines: undefined, sources: undefined }, lines: before.lines },
    after: draftAuditSnapshot(rows),
    at: now,
  });
  return { id: moveId, created: false };
}

/** رأس القيد المخزَّن كما يُعرض في لقطات التدقيق (§6.1 JE‑05b). */
export function moveAuditHeader(m: Pick<MoveRecord, 'id' | 'number' | 'state' | 'moveType' | 'origin' | 'date' | 'ref' | 'narration' | 'totalMilli' | 'journalId' | 'draftOfMoveId' | 'autoPostOn'>): Record<string, unknown> {
  return {
    id: m.id, number: m.number, state: m.state, moveType: m.moveType, origin: m.origin, date: fromDbDate(m.date),
    ref: m.ref, narration: m.narration, totalMilli: m.totalMilli, journalId: m.journalId, draftOfMoveId: m.draftOfMoveId,
    autoPostOn: m.autoPostOn ? fromDbDate(m.autoPostOn) : null,
  };
}
