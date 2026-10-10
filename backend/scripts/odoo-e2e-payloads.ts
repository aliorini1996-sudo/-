/**
 * حمولات الاختبار الحيّ على Odoo 17 (.github/workflows/odoo-connector.yml) — تُبنى بمحرّك الفاتورة الحقيقي
 * (lib/invoiceCalc.computeInvoiceTotals) وبدوالّ الحمولة نفسها التي يرسل بها الخادم (services/erpPayload.ts)،
 * فما يصل Odoo في الاختبار هو حرفياً ما يصله من المنصة. صفوفٌ اصطناعية بأسماء حقول Prisma — لا بيانات حقيقية.
 *
 *   npx tsx scripts/odoo-e2e-payloads.ts <مجلد الإخراج>
 *
 * يكتب round1/round2 لكل قسم + expected.json بما يجب أن يكون في Odoo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeInvoiceTotals } from '../src/lib/invoiceCalc';
import {
  customerPayloadRow, erpEnvelope, invoicePayloadRow, productPayloadRow, receiptPayloadRow, type ErpInvoiceInput,
} from '../src/services/erpPayload';

const OUT = process.argv[2] ?? 'e2e-payloads';
const TZ = 'Asia/Riyadh';
const T = 'tenant-e2e';
const NOW = new Date('2026-10-09T09:00:00Z');
fs.mkdirSync(OUT, { recursive: true });

// ═══ العملاء ═══
const customer = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, tenantId: T, code: `C-${id}`, name, businessName: null, commercialReg: null, taxNumber: null, phone: '0500000000',
  altPhone: null, email: null, city: 'الرياض', district: 'العليا', address: 'شارع ١', lat: 24.7, lng: 46.6, channel: null,
  outletType: null, aiPlaceId: null, status: 'ACTIVE', creditLimit: 0, paymentDays: 30, balance: 1234, totalSales: 99999,
  totalCollected: 0, clientRef: null, clientCreatedAt: null, createdBySalesRepId: null, createdAt: NOW, updatedAt: NOW, ...o,
});
const C1 = customer('c1', 'بقالة النور', { businessName: 'مؤسسة النور التجارية', taxNumber: '300000000000003' });
const C2 = customer('c2', 'تموينات الريان');
const C3 = customer('c3', 'محل مغلق', { status: 'INACTIVE' });
const customers = [C1, C2, C3];

// ═══ المنتجات (بصورة كبيرة — يجب أن تُنزع من الحمولة) ═══
const BIG_IMAGE = `data:image/png;base64,${'A'.repeat(400_000)}`;
const product = (id: string, name: string, basePrice: number, taxPct: number, o: Record<string, unknown> = {}) => ({
  id, tenantId: T, code: `SKU-${id}`, name, barcode: `628${id.replace(/\D/g, '')}000`, unit: 'كرتون', basePrice, taxPct,
  image: BIG_IMAGE, itemCode: null, itemCodeType: 'EGS', unitCode: null, status: 'ACTIVE', damagedReturnToStock: false,
  deletedAt: null, categoryId: null, category: null, priceTiers: [], vatCategory: null, vatExemptionCode: null,
  vatExemptionReason: null, createdAt: NOW, updatedAt: NOW, ...o,
});
const P1 = product('p1', 'عصير برتقال ٢٠٠ مل', 11.5, 15);
const P2 = product('p2', 'ماء صحي ٣٣٠ مل', 1, 15);
const P3 = product('p3', 'خبز عربي', 4.75, 0);
const P4 = product('p4', 'صنف مؤرشف', 3, 15, { deletedAt: new Date('2026-09-01T00:00:00Z') });
const products = [P1, P2, P3, P4];

// ═══ الفواتير بمحرّك المنصة ═══
type Line = { p: typeof P1; qty: number; unitPrice: number; discountPct?: number };
function invoice(id: string, number: string, c: typeof C1, type: 'CASH' | 'CREDIT' | 'RETURN', lines: Line[],
  o: { inclusive?: boolean; headerDiscountPct?: number; status?: string; invoiceDate?: string; documentKind?: string | null;
    original?: { id: string; number: string } | null; einvoiceUuid?: string | null } = {}): ErpInvoiceInput {
  const calc = computeInvoiceTotals(
    lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct ?? 0, taxPct: l.p.taxPct })),
    { companyVat: 15, decimals: 2, invoiceDiscountPct: o.headerDiscountPct ?? 0, pricesIncludeTax: o.inclusive === true },
  );
  return {
    id, tenantId: T, number, customerId: c.id, customer: { id: c.id, code: c.code, name: c.name }, salesRepId: null, salesRep: null,
    type, status: o.status ?? 'CONFIRMED', returnReason: type === 'RETURN' ? 'NORMAL' : null, returnToStock: true,
    invoiceDate: new Date(o.invoiceDate ?? '2026-10-08T07:00:00Z'), deliveryDate: null, dueDate: null, paymentPlan: null, notes: null,
    pricesIncludeTax: o.inclusive === true, subtotal: calc.subtotal, discountPct: o.headerDiscountPct ?? 0, discountAmt: calc.discountAmt,
    taxAmt: calc.taxAmt, total: calc.total, paidAmt: type === 'CASH' ? calc.total : 0, remainingAmt: type === 'CASH' ? 0 : calc.total,
    einvoiceProvider: o.einvoiceUuid ? 'zatca' : null, einvoiceStatus: o.einvoiceUuid ? 'reported' : null, einvoiceUuid: o.einvoiceUuid ?? null,
    einvoiceQr: o.einvoiceUuid ? 'Q'.repeat(2000) : null, einvoiceSnapshot: o.einvoiceUuid ? { big: 'S'.repeat(20000) } : null,
    documentKind: o.documentKind ?? null, originalInvoiceId: o.original?.id ?? null, originalInvoice: o.original ? { number: o.original.number } : null,
    serviceChargeAmt: 0, tipAmt: 0, clientRef: null, clientCreatedAt: null, createdAt: NOW, updatedAt: NOW,
    items: calc.items.map((it, i) => ({
      id: `${id}-i${i}`, invoiceId: id, productId: lines[i].p.id,
      product: { id: lines[i].p.id, code: lines[i].p.code, name: lines[i].p.name, unit: lines[i].p.unit, image: BIG_IMAGE },
      unitCost: 0, qty: it.qty, unitPrice: it.unitPrice, discountPct: it.discountPct, discountAmt: it.discountAmt, taxPct: it.taxPct,
      taxAmt: it.taxAmt, lineTotal: it.lineTotal, seq: i + 1, itemName: lines[i].p.name, unitCode: null, vatCategory: null,
    })),
  };
}

// صافي قبل الضريبة + خصم بند + خصم فاتورة كلّي
const I1 = invoice('i1', 'INV-0001', C1, 'CREDIT', [
  { p: P1, qty: 3, unitPrice: 10 }, { p: P2, qty: 7, unitPrice: 2.35, discountPct: 5 },
], { headerDiscountPct: 3 });
// تطبيق المندوب: أسعار شاملة، نقدي، بعد منتصف الليل بالرياض، مُبلَّغة للهيئة
const I2 = invoice('i2', 'INV-0002', C2, 'CASH', [
  { p: P1, qty: 4, unitPrice: 11.5 }, { p: P2, qty: 10, unitPrice: 1 },
], { inclusive: true, invoiceDate: '2026-10-07T22:30:00Z', einvoiceUuid: 'uuid-e2e-0002' });
// أسعار شاملة غير مستديرة + خصم كلّي ١٠٪ + صنف صفري الضريبة
const I3 = invoice('i3', 'INV-0003', C1, 'CREDIT', [
  { p: P1, qty: 7, unitPrice: 9.99 }, { p: P3, qty: 3, unitPrice: 4.75 },
], { inclusive: true, headerDiscountPct: 10 });
// إشعار دائن (مرتجع) على I2
const I4 = invoice('i4', 'RET-0001', C2, 'RETURN', [{ p: P2, qty: 2, unitPrice: 1 }], {
  inclusive: true, documentKind: 'CREDIT_NOTE', original: { id: 'i2', number: 'INV-0002' },
});
// عميل غير نشط — يجب أن يُعثر عليه لا أن يُرفض
const I5 = invoice('i5', 'INV-0005', C3, 'CREDIT', [{ p: P2, qty: 1, unitPrice: 1 }]);
// تُلغى في الجولة الثانية
const I6 = invoice('i6', 'INV-0006', C2, 'CREDIT', [{ p: P1, qty: 1, unitPrice: 10 }]);
// ملغاة قبل أن تصل — لا تُنشأ أبداً
const I7 = invoice('i7', 'INV-0007', C1, 'CREDIT', [{ p: P1, qty: 2, unitPrice: 10 }], { status: 'CANCELLED' });
const invoices = [I1, I2, I3, I4, I5, I6, I7];

// ═══ السندات ═══
const receipt = (id: string, number: string, c: { id: string; code: string; name: string }, amount: number, method: string,
  o: { status?: string; alloc?: { inv: ErpInvoiceInput; amount: number }[] } = {}) => ({
  id, tenantId: T, number, customerId: c.id, customer: { id: c.id, code: c.code, name: c.name }, salesRepId: null, salesRep: null,
  receiptDate: new Date('2026-10-08T08:00:00Z'), amount, paymentMethod: method, chequeNumber: null, bankName: null, notes: null,
  status: o.status ?? 'ACTIVE', clientRef: null, clientCreatedAt: null, createdAt: NOW, updatedAt: NOW,
  invoiceItems: (o.alloc ?? []).map((a) => ({ invoiceId: String(a.inv.id), amount: a.amount, invoice: { number: String(a.inv.number) } })),
});
const R1 = receipt('r1', 'REC-0001', C1, 50, 'CASH', { alloc: [{ inv: I1, amount: 50 }] });
const R2 = receipt('r2', 'REC-0002', C2, 30, 'BANK_TRANSFER');
const R3 = receipt('r3', 'REC-0003', C2, 12.5, 'POS');
const R4 = receipt('r4', 'REC-0004', { id: 'c-unsynced', code: 'C-X', name: 'عميل لم يُزامَن' }, 9, 'CASH');

// ═══ الكتابة ═══
const write = (name: string, body: unknown) => fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(body));
const inv = (rows: ErpInvoiceInput[]) => rows.map((r) => invoicePayloadRow(r, TZ));
const rec = (rows: ReturnType<typeof receipt>[]) => rows.map((r) => receiptPayloadRow(r, TZ));

write('round1_customers', erpEnvelope('customers', customers.map((c) => customerPayloadRow(c)), NOW));
write('round1_products', erpEnvelope('products', products.map((p) => productPayloadRow(p)), NOW));
write('round1_invoices', erpEnvelope('invoices', inv(invoices), NOW));
write('round1_receipts', erpEnvelope('receipts', rec([R1, R2, R3, R4]), NOW));
// الجولة الثانية: إعادة الإرسال نفسه (لا تكرار)، وإلغاء I6 وR3
write('round2_customers', erpEnvelope('customers', customers.map((c) => customerPayloadRow(c)), NOW));
write('round2_products', erpEnvelope('products', products.map((p) => productPayloadRow(p)), NOW));
write('round2_invoices', erpEnvelope('invoices', inv([I1, I2, I3, I4, I5, { ...I6, status: 'CANCELLED' }, I7]), NOW));
write('round2_receipts', erpEnvelope('receipts', rec([R1, R2, { ...R3, status: 'CANCELLED' }]), NOW));

write('expected', {
  customers: { c1: { active: true, name: C1.name }, c2: { active: true, name: C2.name }, c3: { active: false, name: C3.name } },
  products: { p1: { active: true, tax: 15 }, p2: { active: true, tax: 15 }, p3: { active: true, tax: 0 }, p4: { active: false, tax: 15 } },
  invoices: Object.fromEntries(invoices.filter((i) => i.status !== 'CANCELLED').map((i) => [i.id, {
    number: i.number, total: i.total, tax: i.taxAmt, moveType: i.type === 'RETURN' ? 'out_refund' : 'out_invoice',
  }])),
  neverCreated: ['i7'],
  i2LocalDate: '2026-10-08',
  receipts: {
    r1: { method: 'نقداً', invoices: ['i1'], customer: 'c1' }, r2: { method: 'تحويل بنكي', customer: 'c2' },
    r3: { method: 'شبكة / نقاط بيع', customer: 'c2' },
  },
  unsyncedReceipt: 'r4',
  maxPayloadBytes: Math.max(...fs.readdirSync(OUT).filter((f) => f.startsWith('round')).map((f) => fs.statSync(path.join(OUT, f)).size)),
});
console.log(`payloads written to ${OUT}:`, invoices.map((i) => `${i.number}=${i.total}`).join(' '));
