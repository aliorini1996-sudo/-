// Z5.2 (z5_plan §3 «Tests: GL» + §2.4/D6): فاتورة بشكل صفّ المرحلة الثانية — المبالغ المخزَّنة من نواة الإصدار (taxAmt = ضريبة الـXML،
// subtotal − discountAmt = TaxExclusive، total = السعر المعلن) — ببقية 0.01 (بند واحد) و0.02 (نسبتان) ⇒ الفرق يُرحَّل ROUNDING (421009)
// ضمن سماح الدفاتر لا POSTING_SUSPENSE، والقيد متّزن، والذمة = الإجمالي. نقيّ: لا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceMove, invoicePayloadFromRows, type InvoicePayload } from '../services/gl/builders/invoice';
import { saContext } from '../services/gl/testing/fixtures';
import type { BuildContext, LineDraft, MoveDraft } from '../services/gl/types';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import { toMilli } from '../services/gl/money';
import { prepareIssuance, type IssuanceRequest } from '../compliance/zatca/issue';
import {
  COMPANY_VAT, CUSTOMERS, PRODUCTS, REQ_INCLUSIVE_2580, REQ_INCLUSIVE_2595, REQ_INCLUSIVE_R0, REQ_TWO_BUCKETS_002, engineOf, sellerSettings,
} from '../compliance/zatca/__fixtures__/z5-sources';

function phase2Payload(request: IssuanceRequest, type: 'CASH' | 'CREDIT'): { payload: InvoicePayload; rounding: number } {
  const engine = engineOf(request);
  const p = prepareIssuance({
    settings: sellerSettings(), customer: CUSTOMERS.individual, products: PRODUCTS, request: { ...request, type }, companyVat: COMPANY_VAT, engine,
    now: new Date('2026-12-01T09:00:00Z'),
  });
  const a = p.amounts;
  const payload = invoicePayloadFromRows({
    invoice: {
      id: 'inv-p2', number: 'INV-2612-000001', type, customerId: 'cust1', salesRepId: 'rep1', pricesIncludeTax: request.pricesIncludeTax,
      subtotal: a.subtotal, discountAmt: a.discountAmt, taxAmt: a.taxAmt, total: a.total,
    },
    // lineTotal كما يكتبه المسار (المحرّك)، وضريبة البند من الـXML (§2.4)
    items: engine.items.map((it, i) => ({ productId: request.items[i].productId, qty: it.qty, unitPrice: it.unitPrice, taxPct: it.taxPct, taxAmt: a.items[i].taxAmt, lineTotal: it.lineTotal })),
    customerName: 'عميل نقدي', salesRepName: 'خالد', entryDate: '2026-12-01', currency: 'SAR', currencyDecimals: 2,
  });
  return { payload, rounding: a.payableRounding };
}

const code = (l: LineDraft, ctx: BuildContext) => resolveLineAccount(l, ctx.accounts)?.code;

test('قيد فاتورة المرحلة الثانية ببقية D6 (0 و0.01 و0.02): الفرق ROUNDING (421009) لا المعلّق، والقيد متّزن، والذمة = السعر المعلن', () => {
  const ctx = saContext();
  for (const type of ['CREDIT', 'CASH'] as const) {
    for (const [request, expected] of [[REQ_INCLUSIVE_R0, 0], [REQ_INCLUSIVE_2580, 0.01], [REQ_INCLUSIVE_2595, 0.01], [REQ_TWO_BUCKETS_002, 0.02]] as const) {
      const { payload, rounding } = phase2Payload(request, type);
      assert.equal(rounding, expected);
      const r = buildInvoiceMove(payload, ctx);
      assert.equal(r.kind, 'MOVE');
      const m = r as MoveDraft;
      const v = validateMove(m, ctx);
      assert.equal(v.totalDebitMilli, v.totalCreditMilli, 'متّزن');
      const roundingLines = m.lines.filter(l => code(l, ctx) === '421009');
      const suspense = m.lines.filter(l => code(l, ctx) === '911001');
      assert.equal(suspense.length, 0, `${type} ${payload.total}: لا معلّق`);
      assert.ok(!(m.attentionReason ?? '').includes('غير متّزنة'), `${type} ${payload.total}: ${m.attentionReason}`);
      const roundingNet = roundingLines.reduce((s, l) => s + l.creditMilli - l.debitMilli, 0n);
      assert.equal(roundingNet, toMilli(expected, 2), `${type} ${payload.total}: فرق التقريب دائن ${expected}`);
      const ar = m.lines.filter(l => code(l, ctx) === '113001');
      assert.equal(ar.reduce((s, l) => s + l.debitMilli, 0n), toMilli(Number(payload.total), 2), 'الذمة مدينة بالإجمالي');
      const vat = m.lines.filter(l => code(l, ctx) === '212001').reduce((s, l) => s + l.creditMilli - l.debitMilli, 0n);
      assert.equal(vat, toMilli(Number(payload.taxAmt), 2), 'ضريبة المخرجات = ضريبة الـXML');
    }
  }
});
