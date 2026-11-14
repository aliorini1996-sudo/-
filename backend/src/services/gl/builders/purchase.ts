// «ربط الدفاتر» L6 — قيود المشتريات والذمم الدائنة (D2–D9) من كشف المورّد (supplier_ledger_entries) ولقطات التكلفة.
// دوال صرفة: الحمولة + لقطات حركة المستودع + BuildContext ⇒ MoveDraft أو NO_MOVE.
//
//   STOCK  (WH_ENTRY RECEIVE، buildReceiptStockMove): مدين 114001 / دائن 211002 بالصافي (القيمة من لقطة الوارد)
//   BILL   (دفتر BILL، IN_INVOICE): مدين 211002 بما قُيِّد دائناً عند الاستلام (G) + مدين 116001 بالضريبة (S15_PURCH، SA_7)
//          / دائن 211001 بالإجمالي بالمورّد والاستحقاق. الضريبة غير المستردة (NON_RECOVERABLE) مرسمَلة في التكلفة أصلاً (D9:
//          unitCost شامل) فلا سطر 116001. فرق فاتورة المورّد عن قيمة الاستلام (سعرٌ صُنِّف بعد طيّ الوارد، أو تقريب) ⇒ 514002.
//   PAY    (دفتر PAY، PAYMENT): مدين 211001 / دائن 111001 (نقد) أو 111101 (تحويل أو شيك) أو 111003 (عهدة المندوب)
//   RETURN (دفتر BILL، IN_REFUND): مدين 211001 بالإجمالي / دائن 114001 بالتكلفة (لقطة المرتجع) / دائن 116001 بالضريبة،
//          والفرق بين صافي المرتجع وتكلفته ⇒ 514002
//   REFUND_IN: مدين مستلم الردّ (الصندوق أو البنك أو عهدة المندوب) / دائن 211001
//   OPENING: رصيد مورّد افتتاحي بعد البدء ⇒ 211001 مقابل 319002 مع تنبيه
//   *_REV: مرآة القيد الأمامي بمبلغ صفّ العكس
import { toMilli } from '../money';
import {
  draftFrom, LineAccumulator, receivedValueMilli, repLabel, vendorReturnCostMilli,
  type CostSnapshotInput, type StockMoveInput, type TargetWithLabel, buildStockMove, COUNT_DIFF_TARGET, GRNI_TARGET,
} from './stock';
import type { SupplierEntryEventPayload } from '../sync/types';
import type { BuildContext, BuildResult, LineDraft, LocalDate, MoveDraft, TaxRef } from '../types';

/** ضريبة المشتريات الافتراضية في قالب السعودية */
export const PURCHASE_TAX_KEY = 'S15_PURCH';

// ═══ STOCK: الاستلام ═══

export function buildReceiptStockMove(input: Omit<StockMoveInput, 'sourceType' | 'sourceEvent'>, ctx: BuildContext): BuildResult {
  return buildStockMove({ ...input, sourceType: 'WH_ENTRY', sourceEvent: 'POST' }, ctx);
}

// ═══ أدوات ═══

function milliText(v: string | null | undefined, field: string): bigint | null {
  if (v === null || v === undefined || v === '') return null;
  if (!/^-?\d+$/.test(v)) throw new RangeError(`مبلغ ملّي غير صالح في ${field}: ${v}`);
  return BigInt(v);
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

function vendorTarget(p: Pick<SupplierEntryEventPayload, 'vendorId' | 'vendorName'>): TargetWithLabel {
  const name = p.vendorName && p.vendorName.trim() ? p.vendorName.trim() : 'مورّد';
  return { target: { accountKey: 'AP_CONTROL', vendorId: p.vendorId, partnerName: name }, label: `ذمة المورّد ${name}` };
}

/** ضريبة المشتريات القابلة للخصم: الافتراضية في الإعدادات ثم S15_PURCH */
export function purchaseTax(ctx: BuildContext): TaxRef | null {
  const id = ctx.settings.defaultPurchaseTaxId;
  const byId = id ? ctx.taxes.byId(id) : null;
  const t = byId ?? ctx.taxes.byKey(PURCHASE_TAX_KEY);
  if (!t || !t.isActive || t.use !== 'PURCHASE' || !t.deductible) return null;
  if (!t.accountId && !ctx.accounts.byKey('INPUT_VAT')) return null;
  return t;
}

/** سطر ضريبة المدخلات (مدين موجب، دائن للمرتجع) موسوماً للإقرار — أو بلا وسم مع تنبيه إن غابت الضريبة */
function vatLine(ctx: BuildContext, signedMilli: bigint, baseMilli: bigint, label: string): { line: LineDraft; tagged: boolean } {
  const tax = purchaseTax(ctx);
  const amounts = { debitMilli: signedMilli > 0n ? signedMilli : 0n, creditMilli: signedMilli < 0n ? -signedMilli : 0n };
  if (!tax) return { line: { accountKey: 'INPUT_VAT', label, ...amounts }, tagged: false };
  return {
    line: {
      ...(tax.accountId ? { accountId: tax.accountId } : { accountKey: 'INPUT_VAT' as const }),
      label, ...amounts,
      taxId: tax.id, taxCode: tax.key ?? PURCHASE_TAX_KEY, taxRole: 'TAX', taxBaseMilli: baseMilli, vatBox: tax.vatBox,
    },
    tagged: true,
  };
}

/** مستلم الدفع أو الردّ: الصندوق، البنك، أو عهدة المندوب */
export function cashTarget(
  method: string | null | undefined, salesRepId: string | null | undefined, repNames?: Readonly<Record<string, string>> | null,
): TargetWithLabel & { fallback: boolean } {
  const m = (method ?? '').toUpperCase();
  if (m === 'CASH' || m === 'MAIN_CASH') return { target: { accountKey: 'MAIN_CASH' }, label: 'الصندوق الرئيسي', fallback: false };
  if (m === 'BANK_TRANSFER' || m === 'BANK') return { target: { accountKey: 'MAIN_BANK' }, label: 'البنك الرئيسي (تحويل)', fallback: false };
  if (m === 'CHEQUE') return { target: { accountKey: 'MAIN_BANK' }, label: 'شيك على البنك الرئيسي', fallback: false };
  if (m === 'REP_CUSTODY' && salesRepId) {
    const name = repLabel(repNames, salesRepId);
    return { target: { accountKey: 'REP_CUSTODY', salesRepId, partnerName: name }, label: `عهدة المندوب ${name}`, fallback: false };
  }
  return { target: { accountKey: 'MAIN_CASH' }, label: 'الصندوق الرئيسي', fallback: true };
}

/** MAIN_CASH | BANK | REP_CUSTODY:<id> (WarehouseEntry.paidAccountRef) ⇒ {طريقة، مندوب} */
export function parsePaidRef(ref: string | null | undefined): { method: string; salesRepId: string | null } | null {
  if (!ref) return null;
  if (ref === 'MAIN_CASH') return { method: 'CASH', salesRepId: null };
  if (ref === 'BANK') return { method: 'BANK_TRANSFER', salesRepId: null };
  const m = /^REP_CUSTODY:(.+)$/.exec(ref);
  return m ? { method: 'REP_CUSTODY', salesRepId: m[1] } : null;
}

function invertDraft(d: MoveDraft, narration: string): MoveDraft {
  return {
    ...d,
    narration,
    lines: d.lines.map((l) => ({
      ...l,
      label: `عكس: ${l.label}`,
      debitMilli: l.creditMilli,
      creditMilli: l.debitMilli,
      ...(l.taxBaseMilli !== undefined && l.taxBaseMilli !== null ? { taxBaseMilli: -l.taxBaseMilli } : {}),
    })),
  };
}

// ═══ قيد كشف المورّد ═══

export interface SupplierEntryBuildInput {
  payload: SupplierEntryEventPayload;
  sourceKey: string;
  date: LocalDate;
  /** لقطات حركة المستودع المرتبطة (الفاتورة: الوارد؛ المرتجع: مرتجع المورّد) */
  snapshots?: readonly CostSnapshotInput[];
  needsAttention?: boolean;
  attentionReason?: string | null;
}

interface Built { lines: LineDraft[]; attention: string[] }

function billLines(input: SupplierEntryBuildInput, ctx: BuildContext, amounts: { total: bigint; net: bigint; tax: bigint }): Built {
  const p = input.payload;
  const attention: string[] = [];
  const vt = (p.warehouseEntry?.vatTreatment ?? 'RECOVERABLE').toUpperCase();
  const grni = receivedValueMilli(input.snapshots ?? []);
  // الضريبة المرسمَلة (غير المستردة) جزءٌ من تكلفة الاستلام نفسها (unitCost شامل) ⇒ الأساس المقابل لـ211002 هو الإجمالي
  const recoverable = vt !== 'NON_RECOVERABLE' && vt !== 'NONE';
  const capitalBase = vt === 'NON_RECOVERABLE' ? amounts.net + amounts.tax : amounts.net;
  const vatAmount = recoverable ? amounts.tax : 0n;
  if (vt === 'NONE' && amounts.tax !== 0n) attention.push('فاتورة مورّد بلا ضريبة تحمل مبلغ ضريبة — رُحّل ضمن فرق السعر');
  const diff = (vt === 'NONE' ? amounts.net + amounts.tax : capitalBase) - grni;
  const acc = new LineAccumulator();
  acc.add({ ...GRNI_TARGET, label: 'إقفال مشتريات مستلمة لم تُفوتر' }, grni);
  if (diff !== 0n) acc.add({ ...COUNT_DIFF_TARGET, label: 'فرق فاتورة المورّد عن قيمة الاستلام' }, diff);
  acc.add(vendorTarget(p), -amounts.total, p.dueDate ? { dueDate: p.dueDate } : {});
  const lines = acc.lines();
  if (vatAmount !== 0n) {
    const v = vatLine(ctx, vatAmount, amounts.net, 'ضريبة القيمة المضافة على المشتريات');
    if (!v.tagged) attention.push(`ضريبة المشتريات ${PURCHASE_TAX_KEY} غير متاحة — سطر الضريبة بلا وسم إقرار`);
    lines.splice(lines.length - 1, 0, v.line);
  }
  if (grni === 0n && capitalBase !== 0n) attention.push('فاتورة مورّد لاستلامٍ بلا قيمة مخزون (غير مسعَّر عند الاستلام) — رُحّلت إلى فروقات المخزون');
  return { lines, attention };
}

function returnLines(input: SupplierEntryBuildInput, ctx: BuildContext, amounts: { total: bigint; net: bigint; tax: bigint }): Built {
  const p = input.payload;
  const attention: string[] = [];
  const vt = (p.warehouseEntry?.vatTreatment ?? 'RECOVERABLE').toUpperCase();
  const cost = vendorReturnCostMilli(input.snapshots ?? []);
  const recoverable = vt !== 'NON_RECOVERABLE' && vt !== 'NONE';
  const vatAmount = recoverable ? amounts.tax : 0n;
  const creditBase = amounts.total - vatAmount; // ما يقابل المخزون: الصافي، أو الإجمالي للضريبة المرسمَلة
  const diff = creditBase - cost; // موجب ⇒ دائن 514002 (رُدّ بأعلى من التكلفة)
  const acc = new LineAccumulator();
  acc.add(vendorTarget(p), amounts.total);
  acc.add({ target: { accountKey: 'INVENTORY_WAREHOUSE' }, label: 'بضاعة مرتجعة للمورّد بالتكلفة' }, -cost);
  const lines = acc.lines();
  if (vatAmount !== 0n) {
    const v = vatLine(ctx, -vatAmount, -amounts.net, 'عكس ضريبة المدخلات على المرتجع للمورّد');
    if (!v.tagged) attention.push(`ضريبة المشتريات ${PURCHASE_TAX_KEY} غير متاحة — سطر الضريبة بلا وسم إقرار`);
    lines.push(v.line);
  }
  if (diff !== 0n) {
    const d = new LineAccumulator();
    d.add({ ...COUNT_DIFF_TARGET, label: 'فرق قيمة المرتجع للمورّد عن تكلفته' }, -diff);
    lines.push(...d.lines());
  }
  return { lines, attention };
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  BILL: 'فاتورة مورّد', BILL_REV: 'عكس فاتورة مورّد', PAYMENT: 'سند صرف لمورّد', PAYMENT_REV: 'إلغاء سند صرف لمورّد',
  RETURN: 'مرتجع للمورّد', REFUND_IN: 'استرداد نقدي من المورّد', OPENING: 'رصيد مورّد افتتاحي',
};

/**
 * قيد صفّ كشف المورّد. المبالغ من الصفّ نفسه (amountMilli موقّعاً كالصفّ، وnet/tax للفاتورة والمرتجع)، فالعكس *_REV يُبنى
 * أمامياً بمبلغه المطلق ثم يُقلب. يرمي RangeError لشكل غير متوقع (المُرحِّل يحوّله HELD).
 */
export function buildSupplierEntryMove(input: SupplierEntryBuildInput, ctx: BuildContext): BuildResult {
  const p = input.payload;
  const kind = p.kind.toUpperCase();
  const reversal = kind === 'BILL_REV' || kind === 'PAYMENT_REV';
  const fwd = reversal ? kind.slice(0, -4) : kind;
  const amount = milliText(p.amountMilli, 'amountMilli');
  if (amount === null) throw new RangeError(`قيد مورّد ${p.entryId} بلا مبلغ`);
  const total = abs(amount);
  if (total === 0n) return { kind: 'NO_MOVE', reason: 'ZERO_VALUE', note: 'قيد مورّد بمبلغ صفري' };
  const name = p.vendorName && p.vendorName.trim() ? p.vendorName.trim() : 'مورّد';
  const ref = p.ref ?? null;
  const note = p.note ? ` — ${p.note}` : '';
  const attention: string[] = input.needsAttention && input.attentionReason ? [input.attentionReason] : [];
  let lines: LineDraft[];
  let journal: 'PURCHASES' | 'PAYMENTS' | 'OPENING' = 'PURCHASES';
  let moveType: MoveDraft['moveType'] = 'IN_INVOICE';

  switch (fwd) {
    case 'BILL': {
      const net = milliText(p.netMilli, 'netMilli');
      const tax = milliText(p.taxMilli, 'taxMilli') ?? 0n;
      const n = net !== null ? abs(net) : total - abs(tax);
      if (n + abs(tax) !== total) throw new RangeError(`فاتورة المورّد ${p.entryId}: الصافي + الضريبة ≠ الإجمالي`);
      const b = billLines(input, ctx, { total, net: n, tax: abs(tax) });
      lines = b.lines;
      attention.push(...b.attention);
      break;
    }
    case 'RETURN': {
      const net = milliText(p.netMilli, 'netMilli');
      const tax = milliText(p.taxMilli, 'taxMilli') ?? 0n;
      const n = net !== null ? abs(net) : total - abs(tax);
      if (n + abs(tax) !== total) throw new RangeError(`مرتجع المورّد ${p.entryId}: الصافي + الضريبة ≠ الإجمالي`);
      const b = returnLines(input, ctx, { total, net: n, tax: abs(tax) });
      lines = b.lines;
      attention.push(...b.attention);
      moveType = 'IN_REFUND';
      break;
    }
    case 'PAYMENT': {
      const pay = p.payment;
      const c = cashTarget(pay?.method, pay?.salesRepId ?? null, { ...(p.repNames ?? {}), ...(pay?.salesRepId && pay.salesRepName ? { [pay.salesRepId]: pay.salesRepName } : {}) });
      if (c.fallback) attention.push(`طريقة سند الصرف (${pay?.method ?? '—'}) غير معروفة — رُحّل من الصندوق الرئيسي`);
      const acc = new LineAccumulator();
      acc.add(vendorTarget(p), total);
      acc.add(c, -total);
      lines = acc.lines();
      journal = 'PAYMENTS';
      moveType = 'PAYMENT';
      break;
    }
    case 'REFUND_IN': {
      const paid = parsePaidRef(p.warehouseEntry?.paidAccountRef ?? null);
      const c = cashTarget(paid?.method ?? null, paid?.salesRepId ?? null, p.repNames);
      if (c.fallback) attention.push('مستلم استرداد المورّد غير محدَّد — رُحّل إلى الصندوق الرئيسي');
      const acc = new LineAccumulator();
      acc.add(c, total);
      acc.add(vendorTarget(p), -total);
      lines = acc.lines();
      journal = 'PAYMENTS';
      moveType = 'PAYMENT';
      break;
    }
    case 'OPENING': {
      // موجب = ندين للمورّد (دائن 211001)
      const acc = new LineAccumulator();
      acc.add({ target: { accountKey: 'OPENING_EQUITY' }, label: 'أرصدة افتتاحية (تُصفّى)' }, amount);
      acc.add(vendorTarget(p), -amount);
      lines = acc.lines();
      journal = 'OPENING';
      moveType = 'IMPORT'; // كالأرصدة المستوردة للعملاء (importEntry.ts): دفتر OPEN، لا قيد الافتتاح نفسه
      attention.push('رصيد مورّد افتتاحي بعد تاريخ البدء رُحّل إلى 319002 — راجع تصنيفه');
      break;
    }
    default:
      throw new RangeError(`نوع قيد مورّد غير معروف: ${p.kind}`);
  }

  const label = KIND_LABEL[kind] ?? 'قيد مورّد';
  const built = draftFrom(ctx, {
    journalSystemKey: journal, moveType, date: input.date, ref,
    narration: `${label} — ${name}${ref ? ` (${ref})` : ''}${note}`,
    sourceType: 'SUPPLIER_ENTRY', sourceId: p.entryId, sourceKey: input.sourceKey, sourceEvent: 'POST',
    needsAttention: attention.length > 0, attentionReason: attention.join('؛ ') || null,
    vendorId: p.vendorId,
  }, lines, `قيد مورّد بلا قيمة (${p.kind})`);
  if (!reversal || built.kind === 'NO_MOVE') return built;
  return invertDraft(built, `${label} — ${name}${ref ? ` (${ref})` : ''}${note}`);
}

/** مبلغ نصّي بمنازل العملة ⇒ ملّي (للاختبارات والمشتقات) */
export const milliOfAmount = (v: number, decimals: number): bigint => toMilli(v, decimals);
