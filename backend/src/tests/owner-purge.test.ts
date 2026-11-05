// «الحذف النهائي» لمالك المنصة (services/ownerPurge.ts) — بنية العلاقات من نموذج Prisma، والخطة على قاعدةٍ في الذاكرة، وحارس الجلسة
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPurgePlan, deletionOrder, inboundOf, targetableModels } from '../services/ownerPurge';
import { isPlatformOwnerSession } from '../routes/ownerPurge';

test('الأنواع: كل جدولٍ فيه tenantId قابل للحذف عدا الشركة نفسها', () => {
  const t = targetableModels();
  for (const m of ['Invoice', 'Receipt', 'VanLoad', 'WarehouseEntry', 'SalesLocation', 'Customer', 'Product', 'SalesRep']) assert.ok(t.includes(m), m);
  assert.ok(!t.includes('Tenant'));
});

test('العلاقات الواردة إلى الفاتورة: البنود إلزامية، والقيد اختياري، والمرتجع يشير إليها اختيارياً', () => {
  const inv = inboundOf('Invoice');
  const f = (child: string, fk: string) => inv.find((r) => r.child.name === child && r.fk === fk);
  assert.equal(f('InvoiceItem', 'invoiceId')?.required, true);
  assert.equal(f('ReceiptInvoice', 'invoiceId')?.required, true);
  assert.equal(f('AccountEntry', 'invoiceId')?.required, false);
  assert.equal(f('Invoice', 'originalInvoiceId')?.required, false);
});

/** قاعدة في الذاكرة: findMany/count بشرط {حقل: قيمة} أو {حقل: {in}} — والجداول غير المعرَّفة فارغة */
function memDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const match = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k]);
    return row[k] === v;
  });
  return new Proxy({}, {
    get(_t, name: string) {
      const rows = tables[name] ?? [];
      return {
        findMany: async (a: { where: Record<string, unknown>; select?: Record<string, true> }) => rows.filter((r) => match(r, a.where))
          .map((r) => (a.select ? Object.fromEntries(Object.keys(a.select).map((k) => [k, r[k] ?? null])) : r)),
        count: async (a: { where: Record<string, unknown> }) => rows.filter((r) => match(r, a.where)).length,
      };
    },
  });
}

test('الخطة: الفاتورة تسحب بنودها وقيودها وسند قبضها (قرار المالك)، والمرتجع المرتبط بها يبقى بلا ربط', async () => {
  const db = memDb({
    invoice: [
      { id: 'i1', tenantId: 't1', customerId: 'c1', originalInvoiceId: null },
      { id: 'i2', tenantId: 't1', customerId: 'c1', originalInvoiceId: 'i1' },
    ],
    invoiceItem: [{ id: 'it1', invoiceId: 'i1' }],
    accountEntry: [{ id: 'a1', invoiceId: 'i1', receiptId: null }, { id: 'a2', invoiceId: null, receiptId: 'r1' }],
    receipt: [{ id: 'r1', tenantId: 't1', customerId: 'c1' }],
    receiptInvoice: [{ id: 'ri1', receiptId: 'r1', invoiceId: 'i1' }],
  });
  const plan = await buildPurgePlan(db as never, 't1', 'Invoice', 'i1');
  assert.equal(plan.counts.Invoice, 1);
  assert.equal(plan.counts.InvoiceItem, 1);
  assert.equal(plan.counts.Receipt, 1);
  assert.equal(plan.counts.ReceiptInvoice, 1);
  assert.equal(plan.counts.AccountEntry, 2);
  assert.equal(plan.nullCounts.Invoice, 1); // المرتجع i2 يبقى ويُرفع ربطه
  assert.deepEqual(plan.invoiceIds, ['i1']);
  assert.deepEqual(plan.receiptIds, ['r1']);
  // الحذف بالعكس: الأبناء قبل الآباء
  const order = deletionOrder(plan);
  assert.ok(order.indexOf('InvoiceItem') < order.indexOf('Invoice'));
  assert.ok(order.indexOf('ReceiptInvoice') < order.indexOf('Receipt'));
  assert.ok(order.indexOf('ReceiptInvoice') < order.indexOf('Invoice'));
  assert.ok(order.indexOf('AccountEntry') < order.indexOf('Receipt'));
  assert.ok(order.indexOf('AccountEntry') < order.indexOf('Invoice'));
});

test('الخطة: سجلّ شركةٍ أخرى لا يُحذف', async () => {
  const db = memDb({ invoice: [{ id: 'i1', tenantId: 't2', customerId: 'c1' }] });
  await assert.rejects(buildPurgePlan(db as never, 't1', 'Invoice', 'i1'), /غير موجود/);
  await assert.rejects(buildPurgePlan(db as never, 't1', 'Tenant', 't1'), /غير معروف/);
});

test('الحارس: جلسة «دخول» أصدرها المالك وحدها — لا موظف المنصة ولا مدير الشركة ولا مفتاح API', () => {
  const r = (user: Record<string, unknown>) => ({ user } as never);
  assert.equal(isPlatformOwnerSession(r({ impersonated: true, byKind: 'OWNER' })), true);
  assert.equal(isPlatformOwnerSession(r({ impersonated: true, byKind: 'STAFF' })), false);
  assert.equal(isPlatformOwnerSession(r({ role: 'ADMIN' })), false);
  assert.equal(isPlatformOwnerSession(r({ impersonated: true, byKind: 'OWNER', apiKeyId: 'k' })), false);
});

test('التحديد الجماعي: عدّة فواتير في خطة واحدة، وأي معرّفٍ من شركة أخرى يرفض الطلب كله', async () => {
  const db = memDb({
    invoice: [
      { id: 'i1', tenantId: 't1', customerId: 'c1' }, { id: 'i2', tenantId: 't1', customerId: 'c1' },
      { id: 'x9', tenantId: 't2', customerId: 'c9' },
    ],
    invoiceItem: [{ id: 'a', invoiceId: 'i1' }, { id: 'b', invoiceId: 'i2' }, { id: 'c', invoiceId: 'i2' }],
  });
  const plan = await buildPurgePlan(db as never, 't1', 'Invoice', ['i1', 'i2']);
  assert.equal(plan.counts.Invoice, 2);
  assert.equal(plan.counts.InvoiceItem, 3);
  assert.deepEqual([...plan.invoiceIds].sort(), ['i1', 'i2']);
  await assert.rejects(buildPurgePlan(db as never, 't1', 'Invoice', ['i1', 'x9']), /غير موجودة/);
  await assert.rejects(buildPurgePlan(db as never, 't1', 'Invoice', []), /حدد/);
});
