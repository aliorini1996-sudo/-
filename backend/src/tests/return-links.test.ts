// المرتجع من فاتورة بيع (services/returnLinks.ts) ومخزون «منتهي الصلاحية» في السيارة (routes/vanStock.ts foldStock).
// صرفٌ بلا قاعدة، ومعه حارسٌ نصّي على مسار الإصدار ومسار حركات السيارة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { returnLinkProblem, returnableOf } from '../services/returnLinks';
import { foldStock } from '../routes/vanStock';

const SALE = {
  customerId: 'c1', type: 'CREDIT', status: 'CONFIRMED', documentKind: null,
  items: [{ id: 's1', productId: 'p1', qty: 10 }, { id: 's2', productId: 'p2', qty: 4 }],
};

test('المتاح للإرجاع: المبيع ناقص ما أُرجع، ولا يقلّ عن صفر', () => {
  const left = returnableOf(SALE.items, new Map([['s1', 3], ['s2', 9]]));
  assert.equal(left.get('s1'), 7);
  assert.equal(left.get('s2'), 0);
});

test('المرتجع من فاتورة بيع: كامل أصنافها أو بعضها ضمن المتاح يُقبل', () => {
  const returnable = returnableOf(SALE.items, new Map([['s1', 3]]));
  assert.equal(returnLinkProblem({ sale: SALE, customerId: 'c1', returnable, lines: [
    { productId: 'p1', saleItemId: 's1', qty: 7 }, { productId: 'p2', saleItemId: 's2', qty: 4 },
  ] }), null, 'كامل المتاح');
  assert.equal(returnLinkProblem({ sale: SALE, customerId: 'c1', returnable, lines: [{ productId: 'p2', saleItemId: 's2', qty: 1 }] }), null, 'بعض الأصناف');
});

test('المرتجع من فاتورة بيع: يُرفض ما يتجاوز المتاح ولو موزّعاً على سطرين، أو من فاتورة أو صنف آخر', () => {
  const returnable = returnableOf(SALE.items, new Map([['s1', 3]]));
  const p = (lines: { productId: string; saleItemId: string | null; qty: number }[], over: Partial<typeof SALE> = {}, customerId = 'c1') =>
    returnLinkProblem({ sale: { ...SALE, ...over } as typeof SALE, customerId, returnable, lines });
  assert.match(String(p([{ productId: 'p1', saleItemId: 's1', qty: 8 }])), /أكبر من المتبقي/);
  assert.match(String(p([{ productId: 'p1', saleItemId: 's1', qty: 4 }, { productId: 'p1', saleItemId: 's1', qty: 4 }])), /أكبر من المتبقي/);
  assert.match(String(p([{ productId: 'p1', saleItemId: 'x9', qty: 1 }])), /ليس من فاتورة البيع/);
  assert.match(String(p([{ productId: 'p2', saleItemId: 's1', qty: 1 }])), /لا يطابق/);
  assert.match(String(p([{ productId: 'p1', saleItemId: null, qty: 1 }])), /يجب أن تكون من فاتورة البيع/);
  assert.match(String(p([{ productId: 'p1', saleItemId: 's1', qty: 1 }], {}, 'c2')), /لعميلٍ آخر/);
  assert.match(String(p([{ productId: 'p1', saleItemId: 's1', qty: 1 }], { type: 'RETURN' })), /ليست فاتورة بيع/);
  assert.match(String(p([{ productId: 'p1', saleItemId: 's1', qty: 1 }], { status: 'CANCELLED' })), /ليست فاتورة بيع/);
  assert.match(String(returnLinkProblem({ sale: null, customerId: 'c1', returnable, lines: [] })), /غير موجودة/);
});

const D = (s: string) => new Date(`${s}T10:00:00Z`);
const load = (pid: string, qty: number, type = 'LOAD') => ({ productId: pid, qty, vanLoad: { type, createdAt: D('2026-10-01') } });
const inv = (pid: string, qty: number, type: string, returnToStock: boolean | null, returnExpired?: boolean | null) =>
  ({ productId: pid, qty, returnExpired, invoice: { type, returnToStock, invoiceDate: D('2026-10-05') } });

test('السيارة: المرتجع المنتهي يدخل «منتهي الصلاحية» مهما كان سببه، ولا يُحسب في المتاح للبيع', () => {
  const { bal } = foldStock([load('p', 20)], [
    inv('p', 5, 'CASH', null),
    inv('p', 3, 'RETURN', true, true), // منتهٍ ويعود للمخزون: إلى المنتهي لا المتاح
    inv('p', 2, 'RETURN', false, true), // منتهٍ تالف (لا يعود): إلى المنتهي أيضاً
    inv('p', 1, 'RETURN', true, false), // سارٍ يعود: إلى المتاح كما اليوم
  ]);
  const b = bal.get('p')!;
  assert.equal(b.expiredIn, 5);
  assert.equal(b.returned, 1);
  assert.equal(b.loaded - b.unloaded + b.adjusted - b.sold + b.returned, 16, 'المتاح لا يحمل المنتهي');
});

test('السيارة: إزالة المنتهي تنقص رصيده هو لا المتاح', () => {
  const { bal } = foldStock([load('p', 10), load('p', 2, 'EXPIRED_OUT')], [inv('p', 3, 'RETURN', null, true)]);
  const b = bal.get('p')!;
  assert.equal(b.expiredIn - b.expiredOut, 1);
  assert.equal(b.adjusted, 0, 'الإزالة ليست تسوية');
  assert.equal(b.loaded - b.unloaded + b.adjusted - b.sold + b.returned, 10);
});

test('حارس نصّي: المندوب يُرجع أصناف الصلاحية من فاتورة بيعها، والتحقق يتكرّر بعد قفل فاتورة البيع، والإزالة للإدارة', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const inv = read('routes/invoices.ts');
  for (const frag of [
    "} else if (isReturn && req.user!.role === 'SALES_REP' && tracksExpiry) {",
    "code: 'RETURN_NEEDS_SALE_INVOICE'",
    'await assertReturnLinks(prisma, { tenantId: tid, customerId, saleInvoiceId: saleForReturn, lines: saleLinkLines });',
    'await assertReturnLinks(tx, { tenantId: tid, customerId, saleInvoiceId: saleForReturn, lines: saleLinkLines, lock: true });',
    'returnOfItemId: saleForReturn ? (saleLinkLines[idx]?.saleItemId ?? null) : null,',
    'if (err instanceof ReturnLinkError)',
  ]) assert.ok(inv.includes(frag), `مسار الإصدار: ${frag}`);
  // التحقق داخل المعاملة قبل إنشاء المستند
  const tx = inv.indexOf('lines: saleLinkLines, lock: true });');
  assert.ok(tx > 0 && tx < inv.indexOf('const inv = await tx.invoice.create({'), 'إعادة التحقق قبل الإنشاء داخل المعاملة');
  // مسارا القراءة قبل '/:id' (وإلا ابتلعهما)
  assert.ok(inv.indexOf("router.get('/returnable-sales'") < inv.indexOf("router.get('/:id',"));

  const svc = read('services/returnLinks.ts');
  assert.match(svc, /FOR UPDATE/, 'قفل صفّ فاتورة البيع');
  assert.match(svc, /OR: \[\{ returnOfItemId: \{ in: saleItemIds \} \}, \{ creditedItemId: \{ in: saleItemIds \} \}\]/, 'المرتجَع يشمل الإشعارات الدائنة');
  assert.match(svc, /status: \{ not: 'CANCELLED' \}/, 'المرتجع الملغى لا يُحسب');

  const van = read('routes/vanStock.ts');
  assert.match(van, /if \(isRep && \(data\.type !== 'LOAD'/, 'المندوب لا يزيل المنتهي (غير التحميل للإدارة وحدها)');
  assert.match(van, /if \(data\.type === 'EXPIRED_OUT'\)/, 'الإزالة لا تتجاوز رصيد المنتهي');
  assert.match(van, /returnExpired: true, invoice: \{ select:/, 'مخزون السيارة يقرأ حالة الصلاحية');
});
