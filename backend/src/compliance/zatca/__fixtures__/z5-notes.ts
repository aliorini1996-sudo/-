// بيانات اختبار Z5.5 — فواتير أصلية وإشعاراتها السابقة، مبنيّة من طلبات z5-sources.ts نفسها بالمحرّك نفسه (computeInvoiceTotals)،
// فما يخرج هنا هو عين ما كان سيُكتب في صفّ الفاتورة يوم إصدارها. مصطنعة بالكامل: لا قاعدة بيانات ولا شبكة ولا عميل حقيقي.
//   • originalInvoice(): صفّ فاتورة أصلية + بنودها بلقطة المرحلة الثانية (seq/itemName/unitCode/vatCategory) أو بلا لقطة (المرحلة الأولى).
//   • priorNote(): إشعار سابق بقيمته وكمّياته المربوطة ببنود الأصل.
//   • ORIGINAL_Z1_STANDARD: الأصل الذي يعطي إشعاره عيّنة Z1 الذهبية STANDARD_CREDIT_NOTE حرفياً (خصم فاتورة صفر).
import type { IssuanceRequest } from '../issue';
import type { InvoiceSubtype } from '../mapInvoice';
import { computeInvoiceTotals, type CalcResult } from '../../../lib/invoiceCalc';
import type { NoteOriginalInvoice, NoteOriginalItem, PriorNote } from '../notes';
import { COMPANY_VAT, PRODUCTS, REQ_STANDARD_Z1, Z5_TENANT } from './z5-sources';

export const ORIGINAL_CUSTOMER = 'c-b2b';
export const NOTE_ISSUED_AT = new Date('2026-12-01T09:00:00.000Z');

export interface OriginalOptions {
  request: IssuanceRequest;
  id?: string;
  number?: string;
  tenantId?: string;
  customerId?: string;
  salesRepId?: string | null;
  /** 2 = مرحلة ثانية بلقطة بنود؛ 1 = صفّ قديم بلا seq ولا فئة ضريبية. */
  phase?: 1 | 2;
  subtype?: InvoiceSubtype | null;
  einvoiceStatus?: string | null;
  status?: string;
  type?: string;
  paymentPlan?: string | null;
  documentKind?: string | null;
  companyVat?: number;
  /** تجاوز paidAmt/remainingAmt المشتقّين من النوع. */
  paidAmt?: number;
  remainingAmt?: number;
  damagedReturnToStock?: boolean | null;
}

export function engineFor(request: IssuanceRequest, companyVat: number = COMPANY_VAT): CalcResult {
  return computeInvoiceTotals(
    request.items.map(i => ({ qty: i.qty, unitPrice: i.unitPrice, discountPct: i.discountPct ?? 0, taxPct: i.taxPct ?? undefined })),
    { companyVat, decimals: 2, invoiceDiscountPct: request.discountPct ?? 0, pricesIncludeTax: request.pricesIncludeTax },
  );
}

/** صفّ فاتورة أصلية كما يقرؤه الإشعار (مع بنودها). */
export function originalInvoice(o: OriginalOptions): NoteOriginalInvoice {
  const phase = o.phase ?? 2;
  const calc = engineFor(o.request, o.companyVat ?? COMPANY_VAT);
  const type = o.type ?? o.request.type;
  const subtype = o.subtype === undefined ? '01' : o.subtype;
  const items: NoteOriginalItem[] = o.request.items.map((it, i) => {
    const p = PRODUCTS.find(x => x.id === it.productId);
    const line: NoteOriginalItem = {
      id: `it-${i + 1}`,
      productId: it.productId,
      // المرحلة الأولى: لا لقطة بند — الاسم يمرّره المسار من بطاقة الصنف، ولا seq ولا فئة
      seq: phase === 2 ? i + 1 : null,
      itemName: p?.name ?? 'صنف',
      unitCode: phase === 2 ? 'PCE' : null,
      qty: it.qty,
      unitPrice: it.unitPrice,
      discountPct: it.discountPct ?? 0,
      taxPct: calc.items[i].taxPct,
      vatCategory: phase === 2 ? (p?.vatCategory ?? null) : null,
      vatExemptionCode: phase === 2 ? (p?.vatExemptionCode ?? null) : null,
      vatExemptionReason: phase === 2 ? (p?.vatExemptionReason ?? null) : null,
      damagedReturnToStock: o.damagedReturnToStock ?? null,
    };
    return line;
  });
  const paid = o.paidAmt ?? (type === 'CASH' ? calc.total : 0);
  return {
    id: o.id ?? 'inv-1',
    tenantId: o.tenantId ?? Z5_TENANT,
    customerId: o.customerId ?? ORIGINAL_CUSTOMER,
    salesRepId: o.salesRepId === undefined ? 'rep-1' : o.salesRepId,
    number: o.number ?? 'INV-2612-000001',
    status: o.status ?? 'CONFIRMED',
    type,
    paymentPlan: o.paymentPlan ?? null,
    zatcaPhase: phase,
    documentKind: o.documentKind === undefined ? (phase === 2 ? 'INVOICE' : null) : o.documentKind,
    invoiceSubtype: phase === 2 ? subtype : null,
    einvoiceStatus: o.einvoiceStatus === undefined ? (phase === 2 ? (subtype === '01' ? 'cleared' : 'reported') : 'generated') : o.einvoiceStatus,
    pricesIncludeTax: o.request.pricesIncludeTax === true,
    discountPct: o.request.discountPct ?? 0,
    total: calc.total,
    paidAmt: paid,
    remainingAmt: o.remainingAmt ?? (type === 'CASH' ? 0 : calc.total),
    items,
  };
}

/** إشعار سابق ملتزَم (أو ملغى) بكمّياته المربوطة ببنود الأصل. */
export function priorNote(o: {
  id?: string; status?: string; documentKind?: string | null; total: number;
  items: readonly { creditedItemId: string | null; qty: number }[];
}): PriorNote {
  return {
    id: o.id ?? 'note-1',
    status: o.status ?? 'CONFIRMED',
    documentKind: o.documentKind === undefined ? 'CREDIT_NOTE' : o.documentKind,
    total: o.total,
    items: o.items,
  };
}

/**
 * الأصل الذي يُنتج إشعاره عيّنة Z1 الذهبية: عيّنة Z1 القياسية نفسها بخصم فاتورة **صفر** (فالإشعار الذهبي
 * invoiceDiscountPct = 0)، وبرقم الفاتورة الذي يشير إليه الإشعار.
 */
export const REQ_STANDARD_NO_HEAD_DISCOUNT: IssuanceRequest = Object.freeze({ ...REQ_STANDARD_Z1, discountPct: 0 }) as IssuanceRequest;

export const ORIGINAL_Z1_STANDARD: NoteOriginalInvoice = originalInvoice({
  request: REQ_STANDARD_NO_HEAD_DISCOUNT, number: 'INV-2609-000124', subtype: '01', einvoiceStatus: 'cleared',
});
