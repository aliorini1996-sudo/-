// «ربط الدفاتر» L1 (B4) — الشراء النقدي/الآجل في استلام المستودع، وتصنيفه لاحقاً، ومرتجعه للمورّد، وإلغاؤه.
//  · الحساب الصرف في services/suppliers/warehouseBills.ts: إجماليات الفاتورة بالملّي (الصافي والشامل)، والمتبقّي من كل سطر، والمتبقّي من
//    الفاتورة، وتكلفة المخزون بمعاملة الضريبة.
//  · الموجّه الحقيقي routes/warehouse.ts فوق القاعدة المزيّفة b4-fake.ts: أمثلة الخطة المحلولة حرفياً (١٠٠ كرتون × ٢٠ صافٍ و١٥٪ ⇒
//    2000 + 300 = 2300، قيد BILL +2300؛ النقدي ⇒ سند 2300 مخصَّص بالكامل وPAYMENT −2300 والرصيد صفر؛ مرتجع ١٠ ⇒ RETURN −230)،
//    والتصنيف اللاحق، والإلغاء نقداً وآجلاً، ومفتاح API بلا مورّد ⇒ 201 بتحذير، والواجهة بلا سعر ⇒ 400 — وصفر كتابات في gl_*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store, type Row } from './b4-fake';
import { computeBillTotals } from '../services/suppliers/core';
import { localDateIn } from '../services/erpPayload';

// القاعدة المزيّفة قبل أي وحدةٍ تستورد إعداد القاعدة (warehouseStock عبر الخدمة) — import يُرفع فوق الكود، فالخدمة بـrequire بعدها
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
const store = new Store();
const db = store.db;
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const { capTotals, entryBillTotals, inventoryUnitCost, remainingByItem, residualTotals } =
  require('../services/suppliers/warehouseBills') as typeof import('../services/suppliers/warehouseBills');
const router = (require('../routes/warehouse') as typeof import('../routes/warehouse')).default;
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
const payments = require('../services/suppliers/payments') as typeof import('../services/suppliers/payments');
/* eslint-enable @typescript-eslint/no-var-requires */

// ═══ الحساب الصرف ═══

const M = (x: number) => BigInt(Math.round(x * 1000));

test('مثال الخطة: ١٠٠ كرتون × ٢٠ صافٍ بضريبة ١٥٪ ⇒ صافي 2000 وضريبة 300 وإجمالي 2300 (بالملّي)', () => {
  const t = entryBillTotals([{ qty: 100, unitCost: 20, enteredUnitCost: 20, taxPct: 15 }], { costsIncludeTax: false, vatTreatment: 'RECOVERABLE', decimals: 2 });
  assert.deepEqual(t, { netMilli: M(2000), taxMilli: M(300), totalMilli: M(2300) });
  // ومرتجع ١٠ منها (الكمية بإشارتها السالبة) ⇒ 200 + 30 = 230
  const r = entryBillTotals([{ qty: -10, unitCost: 20, enteredUnitCost: 20, taxPct: 15 }], { costsIncludeTax: false, vatTreatment: 'RECOVERABLE', decimals: 2 });
  assert.deepEqual(r, { netMilli: M(200), taxMilli: M(30), totalMilli: M(230) });
  // وسطرٌ سبق الميزة (بلا سعر مُدخل): تكلفته المخزَّنة صافية — الحساب نفسه
  assert.deepEqual(entryBillTotals([{ qty: 100, unitCost: 20, taxPct: 15 }], { costsIncludeTax: true, vatTreatment: null, decimals: 2 }), t);
});

test('الأسعار الشاملة تُجمع شاملةً ثم تُفصل لكل نسبة — الإجمالي = فاتورة المورّد حرفياً لا 10,000.06 من الصافي المقرَّب', () => {
  const t = entryBillTotals([{ qty: 1000, unitCost: 8.6957, enteredUnitCost: 10, taxPct: 15 }], { costsIncludeTax: true, vatTreatment: 'RECOVERABLE', decimals: 2 });
  assert.deepEqual(t, { netMilli: M(8695.65), taxMilli: M(1304.35), totalMilli: M(10000) });
  // الفخّ الذي يتجنّبه: الصافي المخزَّن بأربع منازل × الكمية ثم الضريبة عليه
  const naive = computeBillTotals([{ qty: 1000, unitCost: 8.6957, taxPct: 15 }], 2, 'RECOVERABLE');
  assert.equal(naive.totalMilli, M(10000.06));
  // نسبتان: كلٌّ تُفصل وحدها، والإجمالي مجموع الشامل
  const two = entryBillTotals([
    { qty: 3, unitCost: 0, enteredUnitCost: 11.5, taxPct: 15 },
    { qty: 2, unitCost: 0, enteredUnitCost: 7, taxPct: 0 },
  ], { costsIncludeTax: true, vatTreatment: 'RECOVERABLE', decimals: 2 });
  assert.deepEqual(two, { netMilli: M(30 + 14), taxMilli: M(4.5), totalMilli: M(48.5) });
  // بلا ضريبة (NONE): الإجمالي = الصافي = ما كُتب
  assert.deepEqual(entryBillTotals([{ qty: 5, unitCost: 3, enteredUnitCost: 3, taxPct: 15 }], { costsIncludeTax: true, vatTreatment: 'NONE', decimals: 2 }),
    { netMilli: M(15), taxMilli: 0n, totalMilli: M(15) });
  // الدينار: ثلاث منازل
  assert.deepEqual(entryBillTotals([{ qty: 3, unitCost: 0.333, enteredUnitCost: 0.333, taxPct: 5 }], { costsIncludeTax: false, vatTreatment: 'RECOVERABLE', decimals: 3 }),
    { netMilli: 999n, taxMilli: 50n, totalMilli: 1049n });
});

test('تكلفة المخزون: المستردة والمعفاة صافية كالوارد القائم، وغير المستردة تُرسمَل (الخطة D9)', () => {
  assert.equal(inventoryUnitCost(23, 15, true, 'RECOVERABLE'), 20);
  assert.equal(inventoryUnitCost(20, 15, false, 'RECOVERABLE'), 20);
  assert.equal(inventoryUnitCost(23, 15, true, 'NONE'), 23, 'بلا ضريبة: ما كُتب');
  assert.equal(inventoryUnitCost(20, 15, false, 'NON_RECOVERABLE'), 23, 'الصافي × ١٫١٥');
  assert.equal(inventoryUnitCost(23, 15, true, 'NON_RECOVERABLE'), 23, 'الشامل كما كُتب');
});

test('المتبقّي من الفاتورة: الإلغاء يأخذ الفاتورة ناقص ما سبق ردّه (فالمجموع يساويها بالملّي)، والجزئي لا يتجاوزه بتقريبه', () => {
  const bill = { netMilli: M(2000), taxMilli: M(300), totalMilli: M(2300) };
  const r1 = { netMilli: M(200), taxMilli: M(30), totalMilli: M(230) };
  assert.deepEqual(residualTotals(bill, [r1]), { netMilli: M(1800), taxMilli: M(270), totalMilli: M(2070) });
  assert.deepEqual(residualTotals(bill, [bill, r1]), { netMilli: 0n, taxMilli: 0n, totalMilli: 0n }, 'لا يقلّ عن صفر');
  // ثلاثة مرتجعات بثلث كلٌّ: الثالث مقيَّد بالمتبقّي فلا يزيد المجموع على الفاتورة
  const third = { netMilli: 667n, taxMilli: 100n, totalMilli: 767n };
  const b = { netMilli: 2000n, taxMilli: 300n, totalMilli: 2300n };
  const left = residualTotals(b, [third, third]);
  assert.deepEqual(capTotals(third, left), { netMilli: 666n, taxMilli: 100n, totalMilli: 766n });
});

test('المتبقّي من كل سطر: المرتجع يُطابق سطره بالصنف والوحدة والتكلفة، واللوط المطابق أولاً، ولا يصير سالباً', () => {
  const line = (id: string, qty: number, lotId: string | null = null, extra: Row = {}) => ({
    id, productId: 'P', qty, unitName: 'كرتون', unitFactor: 24, unitCost: 20, taxPct: 15, enteredUnitCost: 20, lotId, ...extra,
  });
  const orig = [line('a', 5, 'LA'), line('b', 10, 'LB'), line('c', 4, null, { unitCost: 21, enteredUnitCost: 21 })];
  // مرتجع من لوط ب، ومرتجعٌ بلا لوط (الميزة مطفأة) يُوزَّع بالترتيب، ومرتجع سطر ج بتكلفته
  const left = remainingByItem(orig, [
    { ...line('x', -3, 'LB') }, { ...line('y', -6, null) }, { ...line('z', -1, null, { unitCost: 21, enteredUnitCost: 21 }) },
  ]);
  assert.deepEqual([...left.entries()], [['a', 0], ['b', 6], ['c', 3]]);
  // مرتجعٌ لا أصل له بمفتاحه (تكلفة أخرى) لا يمسّ شيئاً، وزيادةٌ عن المجموعة لا تجعل المتبقّي سالباً
  const left2 = remainingByItem(orig, [{ ...line('w', -100, null, { unitCost: 99 }) }, { ...line('v', -50, null) }]);
  assert.deepEqual([...left2.entries()], [['a', 0], ['b', 0], ['c', 4]]);
});

// ═══ الموجّه فوق القاعدة المزيّفة ═══

const T = 't1';
const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: T, name: 'المدير' };
const API = { ...ADMIN, name: 'مفتاح الربط', apiKeyId: 'K1' };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }

/** حرّاس الموجّه ثم المعالج ثم معالجات الأخطاء — والردّ يمرّ بـJSON حقيقي (BigInt يرمي هنا كما يرمي في res.json) */
async function call(method: string, p: string, req: Row = {}): Promise<{ status: number; body: Row }> {
  const stack = (router as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === p && l.route.methods[method]);
  assert.ok(layer, `${method} ${p} مفقود`);
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const errHandlers = [...stack.filter((l) => !l.route && l.handle.length === 4).map((l) => l.handle), errorHandler];
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = JSON.parse(JSON.stringify(b)); return res; };
  res.setHeader = () => res;
  const full = { method: method.toUpperCase(), query: {}, params: {}, body: {}, headers: {}, user: ADMIN, ...req };
  let err: unknown = null;
  for (const h of [...pre, ...layer!.route!.stack.map((l) => l.handle)]) {
    let passed = false;
    await h(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err || !passed) break;
  }
  if (err) {
    for (const eh of errHandlers) {
      let next: unknown = null;
      let passed = false;
      await eh(err, full, res, (e?: unknown) => { next = e; passed = true; });
      if (!passed) return { status: res.statusCode, body: res.body };
      err = next;
    }
    return { status: 500, body: { message: (err as Error)?.message } };
  }
  return { status: res.statusCode, body: res.body };
}

function fresh(opts: { taxDisabled?: boolean } = {}): void {
  store.reset();
  store.add('tenant', { id: T, warehouseEnabled: true, accountingEnabled: true, lotTrackingEnabled: false });
  store.add('tenant', { id: 't2', warehouseEnabled: true, accountingEnabled: true, lotTrackingEnabled: false });
  store.add('admin', { id: 'ADM', isActive: true, canManageVanStock: true });
  store.add('companySettings', { tenantId: T, taxDisabled: opts.taxDisabled ?? false, currency: 'SAR', countryCode: 'SA', defaultVatPct: 15 });
  store.add('product', { id: 'P1', tenantId: T, name: 'مياه', code: 'W1', unit: 'كرتون', taxPct: 15 });
  store.add('product', { id: 'P2', tenantId: T, name: 'عصير', code: 'J1', unit: 'حبة', taxPct: 15 });
  store.add('glVendor', { id: 'V1', tenantId: T, name: 'مؤسسة الخير', paymentDays: 30 });
  store.add('glVendor', { id: 'V9', tenantId: 't2', name: 'مورد شركة أخرى' });
  store.add('salesRep', { id: 'R1', tenantId: T, name: 'سالم' });
}

const post = (body: Row, user: Row = ADMIN) => call('post', '/entries', { body, user });
const BUY = { type: 'RECEIVE', vendorId: 'V1', supplierRef: 'INV-77', billDate: '2026-11-10', items: [{ productId: 'P1', qty: 100, unitCost: 20 }] };
const today = () => localDateIn(new Date(), 'Asia/Riyadh');
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const glWrites = () => store.calls.filter((c) => /^gl\w*\.(create|update|upsert|delete)/.test(c.op));

test('الوارد الآجل (مثال الخطة): الإجماليات على الحركة، والاستحقاق بمدة المورّد، وقيد BILL +2300 بتاريخ الفاتورة — ولا سند', async () => {
  fresh();
  const r = await post({ ...BUY, paymentMode: 'CREDIT' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [e] = store.entries();
  assert.equal(e.type, 'RECEIVE');
  assert.deepEqual([e.vendorId, e.paymentMode, e.paidAccountRef, e.supplierRef, e.vatTreatment, e.source, e.status], ['V1', 'CREDIT', null, 'INV-77', 'RECOVERABLE', 'MANUAL', 'POSTED']);
  assert.deepEqual([e.netMilli, e.taxMilli, e.totalMilli], [2_000_000n, 300_000n, 2_300_000n]);
  assert.deepEqual([day(e.billDate), day(e.dueDate)], ['2026-11-10', '2026-12-10'], 'الاستحقاق = الفاتورة + ٣٠ يوماً');
  assert.equal(e.supplier, 'مؤسسة الخير', 'اسم المورّد في الحقل النصّي القديم للعرض');
  const [it] = store.itemsOf(e.id);
  assert.deepEqual([it.qty, it.unitCost, it.taxPct, it.enteredUnitCost], [100, 20, 15, 20]);
  const ledger = store.ledger();
  assert.equal(ledger.length, 1);
  assert.deepEqual([ledger[0].kind, ledger[0].amountMilli, ledger[0].netMilli, ledger[0].taxMilli, ledger[0].warehouseEntryId, day(ledger[0].docDate), day(ledger[0].dueDate), ledger[0].ref],
    ['BILL', 2_300_000n, 2_000_000n, 300_000n, e.id, '2026-11-10', '2026-12-10', 'INV-77']);
  assert.equal(store.t.supplierPayment.length, 0);
  assert.equal(store.balanceMilli('V1'), 2_300_000n);
  // الردّ بلا BigInt: الإجماليات أرقامٌ بوحدة العملة والتاريخان أيام
  assert.deepEqual([r.body.data.net, r.body.data.tax, r.body.data.total, r.body.data.billDate, r.body.data.dueDate], [2000, 300, 2300, '2026-11-10', '2026-12-10']);
  assert.ok(!('totalMilli' in r.body.data) && !('supplierPayment' in r.body));
  assert.deepEqual(glWrites(), [], 'صفر كتابات في gl_*');
});

test('الوارد النقدي: سند صرف آلي 2300 مخصَّص بالكامل للحركة من الصندوق، وPAYMENT −2300، والرصيد صفر', async () => {
  fresh();
  const r = await post({ ...BUY, paymentMode: 'CASH' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [e] = store.entries();
  assert.deepEqual([e.paymentMode, e.paidAccountRef, e.dueDate], ['CASH', 'MAIN_CASH', null]);
  const [p] = store.t.supplierPayment;
  assert.deepEqual([p.number, p.amountMilli, p.method, p.autoForEntryId, p.vendorId, day(p.paidAt), p.status, p.reference], [1, 2_300_000n, 'CASH', e.id, 'V1', '2026-11-10', 'POSTED', 'INV-77']);
  assert.deepEqual(store.t.supplierPaymentAllocation.map((a) => [a.paymentId, a.warehouseEntryId, a.amountMilli]), [[p.id, e.id, 2_300_000n]], 'مخصَّص ١٠٠٪');
  assert.deepEqual(store.ledger().map((l) => [l.kind, l.amountMilli]), [['BILL', 2_300_000n], ['PAYMENT', -2_300_000n]]);
  assert.equal(store.balanceMilli('V1'), 0n);
  assert.deepEqual(r.body.supplierPayment, { id: p.id, number: 1, displayNumber: 'SP-000001' });
  assert.deepEqual(glWrites(), []);
});

test('النقدي من عهدة مندوب: السند REP_CUSTODY بمندوبه — والواجهة بلا مندوبٍ صالح 400 بلا كتابة', async () => {
  fresh();
  const r = await post({ ...BUY, paymentMode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'R1' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(store.entries()[0].paidAccountRef, 'REP_CUSTODY:R1');
  assert.deepEqual([store.t.supplierPayment[0].method, store.t.supplierPayment[0].salesRepId], ['REP_CUSTODY', 'R1']);
  fresh();
  for (const bad of [{ paidFrom: 'REP_CUSTODY' }, { paidFrom: 'REP_CUSTODY', paidFromRepId: 'NOPE' }, { paidFrom: 'SAFE' }]) {
    const x = await post({ ...BUY, paymentMode: 'CASH', ...bad });
    assert.equal(x.status, 400, JSON.stringify(x.body));
    assert.equal(x.body.code, 'PURCHASE_INVALID');
  }
  assert.equal(store.entries().length, 0);
});

test('الواجهة: نوع الشراء بلا سعر ⇒ 400 PURCHASE_PRICE_REQUIRED، وبلا مورّد أو بمورّد شركةٍ أخرى ⇒ 400 PURCHASE_VENDOR_REQUIRED — بلا حركة', async () => {
  fresh();
  const noPrice = await post({ ...BUY, paymentMode: 'CREDIT', items: [{ productId: 'P1', qty: 100, unitCost: 20 }, { productId: 'P2', qty: 3 }] });
  assert.equal(noPrice.status, 400, JSON.stringify(noPrice.body));
  assert.equal(noPrice.body.code, 'PURCHASE_PRICE_REQUIRED');
  assert.deepEqual(noPrice.body.details, { indexes: [1] });
  const noVendor = await post({ type: 'RECEIVE', paymentMode: 'CASH', items: [{ productId: 'P1', qty: 1, unitCost: 5 }] });
  assert.equal(noVendor.status, 400);
  assert.equal(noVendor.body.code, 'PURCHASE_VENDOR_REQUIRED');
  const foreign = await post({ ...BUY, vendorId: 'V9', paymentMode: 'CREDIT' });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.code, 'PURCHASE_VENDOR_REQUIRED');
  const badMode = await post({ ...BUY, paymentMode: 'LATER' });
  assert.equal(badMode.body.code, 'PURCHASE_INVALID');
  const badDate = await post({ ...BUY, paymentMode: 'CREDIT', billDate: '2026-13-40' });
  assert.equal(badDate.body.code, 'PURCHASE_INVALID');
  assert.equal(store.entries().length, 0);
  assert.equal(store.ledger().length, 0);
});

test('مفتاح API لا يُرفض: بلا مورّد أو بسطرٍ بلا سعر أو بمورّدٍ مجهول ⇒ 201 والوارد غير مصنَّف بتحذير PURCHASE_UNCLASSIFIED وبلا قيود', async () => {
  fresh();
  const cases: Row[] = [
    { type: 'RECEIVE', paymentMode: 'CREDIT', items: [{ productId: 'P1', qty: 10, unitCost: 20 }] },
    { ...BUY, paymentMode: 'CASH', items: [{ productId: 'P1', qty: 10 }] },
    { ...BUY, vendorId: 'GHOST', paymentMode: 'CREDIT' },
    { ...BUY, paymentMode: 'CASH', paidFrom: 'REP_CUSTODY' },
  ];
  for (const body of cases) {
    const r = await post(body, API);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const w = (r.body.warnings as Row[]).find((x) => x.code === 'PURCHASE_UNCLASSIFIED');
    assert.ok(w && typeof w.message === 'string', JSON.stringify(r.body.warnings));
    const e = store.entries().slice(-1)[0];
    assert.deepEqual([e.paymentMode, e.totalMilli, e.source], [null, null, 'API']);
  }
  assert.equal(store.ledger().length, 0);
  assert.equal(store.t.supplierPayment.length, 0);
  // تاريخٌ تالف ورقمٌ طويل: يُعدَّلان بتحذير والتصنيف قائم
  const r = await post({ ...BUY, paymentMode: 'CREDIT', billDate: 'أمس', supplierRef: 'X'.repeat(80) }, API);
  assert.equal(r.status, 201);
  const e = store.entries().slice(-1)[0];
  assert.equal(e.paymentMode, 'CREDIT');
  assert.equal(e.supplierRef, 'X'.repeat(60));
  assert.equal((r.body.warnings as Row[]).filter((x) => x.code === 'PURCHASE_FIELD_ADJUSTED').length, 2);
});

test('الوارد بلا بيانات شراء كما كان حرفياً: لا مورّد ولا قيود ولا استعلام شركة/مورّد، ولا مفاتيح جديدة في الإنشاء', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', supplier: 'مورد نصّي', costsIncludeTax: false, items: [{ productId: 'P1', qty: 5, unitCost: 4 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const create = store.calls.find((c) => c.op === 'warehouseEntry.create')!.args as Row;
  assert.deepEqual(Object.keys(create.data).sort(), ['createdBy', 'items', 'note', 'supplier', 'tenantId', 'type']);
  assert.deepEqual(Object.keys(create.data.items.create[0]).sort(), ['baseQty', 'productId', 'qty', 'unitCost', 'unitFactor', 'unitName']);
  assert.ok(!store.calls.some((c) => /^(glVendor|companySettings|supplier)/.test(c.op)), store.calls.map((c) => c.op).join(' '));
  assert.equal(store.ledger().length, 0);
  assert.equal(r.body.data.total, null, 'غير المسعَّر/غير المصنَّف بلا إجماليات');
});

test('مرتجع ١٠ من الآجل (مثال الخطة): حركة RETURN بكمياتٍ سالبة وتكلفة سطرها، وقيد RETURN −230، والمتبقّي 2070 في السجلّ', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT' });
  const [bill] = store.entries();
  const [it] = store.itemsOf(bill.id);
  const r = await call('post', '/entries/:id/return', { params: { id: bill.id }, body: { items: [{ itemId: it.id, qty: 10 }], supplierRef: 'CN-5', billDate: '2026-11-12' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ret = store.entries({ type: 'RETURN' })[0];
  assert.deepEqual([ret.returnOfEntryId, ret.vendorId, ret.paymentMode, ret.supplierRef, day(ret.billDate), ret.status], [bill.id, 'V1', 'CREDIT', 'CN-5', '2026-11-12', 'POSTED']);
  assert.deepEqual([ret.netMilli, ret.taxMilli, ret.totalMilli], [200_000n, 30_000n, 230_000n]);
  const [ri] = store.itemsOf(ret.id);
  assert.deepEqual([ri.productId, ri.qty, ri.baseQty, ri.unitCost, ri.taxPct, ri.enteredUnitCost], ['P1', -10, -10, 20, 15, 20]);
  assert.deepEqual(store.ledger({ kind: 'RETURN' }).map((l) => [l.amountMilli, l.warehouseEntryId, day(l.docDate), l.ref]), [[-230_000n, ret.id, '2026-11-12', 'CN-5']]);
  assert.equal(store.balanceMilli('V1'), 2_070_000n);
  assert.equal(r.body.data.total, 230);
  // السجلّ: الآجل بمدفوعه ومتبقّيه بعد المرتجع، والمرتجع بلا مدفوع
  const g = await call('get', '/entries');
  const rows = g.body.data as Row[];
  const b = rows.find((x) => x.id === bill.id)!;
  assert.deepEqual([b.paid, b.outstanding, b.vendor?.name, b.total], [0, 2070, 'مؤسسة الخير', 2300]);
  assert.equal(rows.find((x) => x.id === ret.id)!.outstanding, null);
  // المتبقّي للإرجاع من كل سطر (الحَكَم نفسه) — للوارد المصنَّف وحده، والمرتجع بلا الحقل
  assert.deepEqual((b.items as Row[]).map((i) => i.remainingQty), [90]);
  assert.ok(!('remainingQty' in (rows.find((x) => x.id === ret.id)!.items as Row[])[0]));
  // وفلتر النوع لا يُخفي المرتجعات عن الحساب (الخادم يقرؤها كلها لا ما في الصفحة)
  const onlyBills = (await call('get', '/entries', { query: { type: 'RECEIVE' } })).body.data as Row[];
  assert.deepEqual((onlyBills[0].items as Row[]).map((i) => i.remainingQty), [90]);
  // فلاتر السجلّ
  assert.deepEqual(((await call('get', '/entries', { query: { type: 'RETURN' } })).body.data as Row[]).map((x) => x.id), [ret.id]);
  assert.equal(((await call('get', '/entries', { query: { vendorId: 'V1' } })).body.data as Row[]).length, 2);
  // أكثر من المتبقّي ⇒ 409 بلا كتابة
  const over = await call('post', '/entries/:id/return', { params: { id: bill.id }, body: { items: [{ itemId: it.id, qty: 91 }] } });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'RETURN_EXCEEDS_RECEIVED');
  assert.equal(store.entries({ type: 'RETURN' }).length, 1);
  // ردٌّ نقدي: RETURN −230 وREFUND_IN +230 على حركة المرتجع، والرصيد كما هو
  const cash = await call('post', '/entries/:id/return', { params: { id: bill.id }, body: { items: [{ itemId: it.id, qty: 10 }], refundMode: 'CASH', refundTo: 'BANK' } });
  assert.equal(cash.status, 201, JSON.stringify(cash.body));
  const ret2 = store.entries({ type: 'RETURN' })[1];
  assert.deepEqual([ret2.paymentMode, ret2.paidAccountRef], ['CASH', 'BANK']);
  assert.deepEqual(store.ledger({ warehouseEntryId: ret2.id }).map((l) => [l.kind, l.amountMilli]), [['RETURN', -230_000n], ['REFUND_IN', 230_000n]]);
  assert.equal(store.balanceMilli('V1'), 2_070_000n);
  // المرتجع المردود نقداً لا يُخصم من متبقّي الفاتورة (سُوّي بالنقد)
  const g2 = await call('get', '/entries');
  assert.equal((g2.body.data as Row[]).find((x) => x.id === bill.id)!.outstanding, 2070);
  assert.deepEqual(((g2.body.data as Row[]).find((x) => x.id === bill.id)!.items as Row[]).map((i) => i.remainingQty), [80]);
  assert.deepEqual(glWrites(), []);
});

test('الإلغاء الآجل: مرتجعٌ كامل للمتبقّي بالمتبقّي من الفاتورة حرفياً (2070 بعد مرتجع 230)، وCANCELLED، والرصيد صفر', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT' });
  const [bill] = store.entries();
  const [it] = store.itemsOf(bill.id);
  await call('post', '/entries/:id/return', { params: { id: bill.id }, body: { items: [{ itemId: it.id, qty: 10 }] } });
  const r = await call('post', '/entries/:id/cancel', { params: { id: bill.id }, body: { reason: 'وصلت تالفة' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(store.entries({ id: bill.id })[0].status, 'CANCELLED');
  const rets = store.entries({ type: 'RETURN' });
  assert.equal(rets.length, 2);
  const last = rets[1];
  assert.deepEqual(store.itemsOf(last.id).map((i) => i.qty), [-90]);
  assert.deepEqual([last.netMilli, last.taxMilli, last.totalMilli, last.note], [1_800_000n, 270_000n, 2_070_000n, 'وصلت تالفة']);
  assert.equal(store.balanceMilli('V1'), 0n);
  assert.equal(r.body.data.status, 'CANCELLED');
  assert.equal(r.body.returnEntry.id, last.id);
  // ملغى ⇒ لا مرتجع ولا إلغاء ثانٍ
  const again = await call('post', '/entries/:id/cancel', { params: { id: bill.id } });
  assert.equal(again.body.code, 'ENTRY_ALREADY_CANCELLED');
  const ret = await call('post', '/entries/:id/return', { params: { id: bill.id }, body: { items: [{ itemId: it.id, qty: 1 }] } });
  assert.equal(ret.body.code, 'ENTRY_ALREADY_CANCELLED');
  // تاريخ قيد الإلغاء: يوم الشركة (ولا يسبق الفاتورة)
  assert.equal(day(store.ledger({ warehouseEntryId: last.id })[0].docDate), today());
});

test('الإلغاء الآجل بدفعةٍ سارية ⇒ 409 BILL_HAS_PAYMENTS، وبعد إلغاء السند يُلغى الوارد', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT' });
  const [bill] = store.entries();
  const pay = await db.$transaction((tx: never) => payments.createSupplierPaymentTx(tx, {
    tenantId: T, vendorId: 'V1', amountMilli: 1_000_000n, method: 'BANK_TRANSFER', paidAt: new Date('2026-11-11T00:00:00Z'),
    allocations: [{ warehouseEntryId: bill.id, amountMilli: 1_000_000n }],
  })) as { id: string };
  const r = await call('post', '/entries/:id/cancel', { params: { id: bill.id } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'BILL_HAS_PAYMENTS');
  assert.equal(store.entries({ type: 'RETURN' }).length, 0, 'لا مرتجع');
  assert.equal(store.entries({ id: bill.id })[0].status, 'POSTED');
  await db.$transaction((tx: never) => payments.cancelSupplierPaymentTx(tx, T, pay.id, { reason: 'خطأ' }));
  const ok = await call('post', '/entries/:id/cancel', { params: { id: bill.id } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(store.balanceMilli('V1'), 0n, 'BILL 2300 − PAYMENT 1000 + PAYMENT_REV 1000 − RETURN 2300');
});

test('الإلغاء النقدي: سنده الآلي يُلغى (PAYMENT_REV +2300) ومرتجع −2300 فالرصيد صفر — والسند الآلي لا يُلغى من مسار السندات', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CASH' });
  const [bill] = store.entries();
  const [p] = store.t.supplierPayment;
  // مسار السندات يرفض إلغاء الآلي (AUTO_PAYMENT_CANCEL_VIA_ENTRY)
  await assert.rejects(db.$transaction((tx: never) => payments.cancelSupplierPaymentTx(tx, T, p.id, {})), (e: Row) => e.code === 'AUTO_PAYMENT_CANCEL_VIA_ENTRY');
  const r = await call('post', '/entries/:id/cancel', { params: { id: bill.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(store.t.supplierPayment[0].status, 'CANCELLED');
  assert.deepEqual(r.body.cancelledPayment, { id: p.id, number: 1, displayNumber: 'SP-000001' });
  assert.deepEqual(store.ledger().map((l) => [l.kind, l.amountMilli]), [['BILL', 2_300_000n], ['PAYMENT', -2_300_000n], ['RETURN', -2_300_000n], ['PAYMENT_REV', 2_300_000n]]);
  assert.equal(store.balanceMilli('V1'), 0n);
  const ret = store.entries({ type: 'RETURN' })[0];
  assert.deepEqual([ret.paymentMode, ret.totalMilli], ['CREDIT', 2_300_000n]);
  assert.deepEqual(glWrites(), []);
});

test('الإلغاء النقدي بعد مرتجعٍ رُدّ نقداً: السند يبقى، وما بقي يُستردّ REFUND_IN — فلا يُحسب مال المرتجع مرّتين', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CASH' });
  const [bill] = store.entries();
  const [it] = store.itemsOf(bill.id);
  await call('post', '/entries/:id/return', { params: { id: bill.id }, body: { items: [{ itemId: it.id, qty: 10 }], refundMode: 'CASH' } });
  const r = await call('post', '/entries/:id/cancel', { params: { id: bill.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(store.t.supplierPayment[0].status, 'POSTED');
  assert.ok(!('cancelledPayment' in r.body));
  const last = store.entries({ type: 'RETURN' })[1];
  assert.deepEqual([last.paymentMode, last.paidAccountRef, last.totalMilli], ['CASH', 'MAIN_CASH', 2_070_000n]);
  assert.deepEqual(store.ledger({ warehouseEntryId: last.id }).map((l) => [l.kind, l.amountMilli]), [['RETURN', -2_070_000n], ['REFUND_IN', 2_070_000n]]);
  assert.equal(store.balanceMilli('V1'), 0n);
});

test('التصنيف اللاحق: وارد بلا سعر ⇒ يُسعَّر ويُصنَّف نقداً فيكتب ما يكتبه الإنشاء (BILL + سند آلي) بتاريخ الاستلام — ومرّة واحدة', async () => {
  fresh();
  const r0 = await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 100 }] });
  assert.equal(r0.status, 201);
  const [e] = store.entries();
  const [it] = store.itemsOf(e.id);
  const noPrice = await call('post', '/entries/:id/classify', { params: { id: e.id }, body: { vendorId: 'V1', paymentMode: 'CASH' } });
  assert.equal(noPrice.status, 400);
  assert.equal(noPrice.body.code, 'PURCHASE_PRICE_REQUIRED');
  assert.equal(store.ledger().length, 0, 'الرفض لا يكتب شيئاً');
  const r = await call('post', '/entries/:id/classify', { params: { id: e.id }, body: { vendorId: 'V1', paymentMode: 'CASH', supplierRef: 'INV-9', prices: [{ itemId: it.id, unitCost: 20 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = store.entries()[0];
  assert.deepEqual([after.paymentMode, after.vendorId, after.totalMilli, after.supplierRef], ['CASH', 'V1', 2_300_000n, 'INV-9']);
  assert.equal(day(after.billDate), localDateIn(e.createdAt, 'Asia/Riyadh'), 'تاريخ الفاتورة يوم الاستلام بتوقيت الشركة');
  assert.deepEqual([store.itemsOf(e.id)[0].unitCost, store.itemsOf(e.id)[0].taxPct, store.itemsOf(e.id)[0].enteredUnitCost], [20, 15, 20]);
  assert.deepEqual(store.ledger().map((l) => [l.kind, l.amountMilli]), [['BILL', 2_300_000n], ['PAYMENT', -2_300_000n]]);
  assert.equal(store.balanceMilli('V1'), 0n);
  assert.equal(r.body.supplierPayment.displayNumber, 'SP-000001');
  assert.equal(r.body.data.total, 2300);
  assert.ok(after.updatedAt.getTime() > e.createdAt.getTime(), 'updatedAt يتحرّك (المزامنة بطابع التعديل)');
  const again = await call('post', '/entries/:id/classify', { params: { id: e.id }, body: { vendorId: 'V1', paymentMode: 'CREDIT', prices: [] } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ENTRY_ALREADY_CLASSIFIED');
  assert.deepEqual(glWrites(), []);
});

test('التصنيف لا يغيّر سعراً قائماً: السطر المسعَّر يبقى (تحذير)، ونسبته تُكتب، والآجل باستحقاقه — وحركةُ شركةٍ أخرى 404', async () => {
  fresh();
  await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 10, unitCost: 20 }, { productId: 'P2', qty: 4 }] });
  const [e] = store.entries();
  const [a, b] = store.itemsOf(e.id);
  const r = await call('post', '/entries/:id/classify', {
    params: { id: e.id }, body: { vendorId: 'V1', paymentMode: 'CREDIT', billDate: '2026-11-01', prices: [{ itemId: a.id, unitCost: 99 }, { itemId: b.id, unitCost: 5, taxPct: 0 }] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((r.body.warnings as Row[]).map((w) => w.code), ['PRICE_IGNORED_EXISTING']);
  const [a2, b2] = store.itemsOf(e.id);
  assert.deepEqual([a2.unitCost, a2.taxPct, b2.unitCost, b2.taxPct], [20, 15, 5, 0]);
  const after = store.entries()[0];
  // 10×20 + 4×5 = 220 صافٍ، وضريبة 15٪ على 200 = 30 ⇒ 250
  assert.deepEqual([after.netMilli, after.taxMilli, after.totalMilli, day(after.dueDate)], [220_000n, 30_000n, 250_000n, '2026-12-01']);
  const other = await call('post', '/entries/:id/classify', { params: { id: e.id }, user: { ...ADMIN, tenantId: 't2' }, body: { vendorId: 'V9', paymentMode: 'CREDIT' } });
  assert.equal(other.status, 404);
});

test('غير المصنَّف: المرتجع الجزئي يُطلب تصنيفه أولاً (409)، والإلغاء مرتجعٌ كامل بلا قيود مورّد', async () => {
  fresh();
  await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 7, unitCost: 3 }] });
  const [e] = store.entries();
  const [it] = store.itemsOf(e.id);
  const ret = await call('post', '/entries/:id/return', { params: { id: e.id }, body: { items: [{ itemId: it.id, qty: 1 }] } });
  assert.equal(ret.status, 409);
  assert.equal(ret.body.code, 'ENTRY_NOT_CLASSIFIED');
  const c = await call('post', '/entries/:id/cancel', { params: { id: e.id } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const [r] = store.entries({ type: 'RETURN' });
  assert.deepEqual([r.paymentMode, r.totalMilli, r.returnOfEntryId], [null, null, e.id]);
  assert.deepEqual(store.itemsOf(r.id).map((i) => [i.qty, i.unitCost]), [[-7, 3]], 'بتكلفة السطر الأصلي فيُصفّر قيمته في المشتريات');
  assert.equal(store.ledger().length, 0);
  // التسوية لا تُلغى بمرتجع
  await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -1 }] });
  const adj = store.entries({ type: 'ADJUST' })[0];
  assert.equal((await call('post', '/entries/:id/cancel', { params: { id: adj.id } })).body.code, 'ENTRY_NOT_RETURNABLE');
});

test('الوارد السالب بمورّدٍ وسعر ⇒ حركة RETURN مسعَّرة وقيدها (لا تسوية)، والمختلط ⇒ وارد مصنَّف + مرتجع مفصول NEG_SPLIT', async () => {
  fresh();
  const neg = await post({ type: 'RECEIVE', vendorId: 'V1', items: [{ productId: 'P1', qty: -4, unitCost: 20 }] }, API);
  assert.equal(neg.status, 201, JSON.stringify(neg.body));
  const [r] = store.entries();
  assert.deepEqual([r.type, r.vendorId, r.paymentMode, r.totalMilli, r.source], ['RETURN', 'V1', 'CREDIT', 92_000n, 'API']);
  assert.deepEqual(store.itemsOf(r.id).map((i) => [i.qty, i.unitCost]), [[-4, 20]]);
  assert.deepEqual(store.ledger().map((l) => [l.kind, l.amountMilli]), [['RETURN', -92_000n]]);
  assert.deepEqual((neg.body.warnings as Row[]).map((w) => w.code), ['NEGATIVE_RECEIVE_AS_RETURN']);
  fresh();
  const mixed = await post({ type: 'RECEIVE', vendorId: 'V1', paymentMode: 'CREDIT', billDate: '2026-11-10', items: [{ productId: 'P1', qty: 100, unitCost: 20 }, { productId: 'P2', qty: -2, unitCost: 10 }] });
  assert.equal(mixed.status, 201, JSON.stringify(mixed.body));
  const main = store.entries({ type: 'RECEIVE' })[0];
  const split = store.entries({ type: 'RETURN' })[0];
  assert.deepEqual([main.totalMilli, split.totalMilli, split.source, split.paymentMode], [2_300_000n, 23_000n, 'NEG_SPLIT', 'CREDIT']);
  assert.deepEqual(store.ledger().map((l) => [l.kind, l.amountMilli, l.warehouseEntryId]), [['RETURN', -23_000n, split.id], ['BILL', 2_300_000n, main.id]]);
  assert.equal(mixed.body.adjustment.type, 'RETURN');
  // بلا مورّد: التسوية كما كانت (بلا سعر) وتحذيرها القائم
  fresh();
  const plain = await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: -4, unitCost: 20 }] }, API);
  assert.equal(store.entries()[0].type, 'ADJUST');
  assert.deepEqual(store.itemsOf(store.entries()[0].id).map((i) => i.unitCost), [null]);
  assert.deepEqual((plain.body.warnings as Row[]).map((w) => w.code), ['NEGATIVE_RECEIVE_AS_ADJUST']);
});

test('سبب التسوية: الصالح يُحفظ، وغير المعروف 400 للواجهة ويُهمل بتحذير لمفتاح API، وبيانات الشراء مع التسوية تُهمل بتحذير', async () => {
  fresh();
  const ok = await post({ type: 'ADJUST', reason: 'damage', items: [{ productId: 'P1', qty: -2 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(store.entries()[0].reason, 'DAMAGE');
  const bad = await post({ type: 'ADJUST', reason: 'LOST', items: [{ productId: 'P1', qty: -2 }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'ADJUST_REASON_INVALID');
  assert.equal(store.entries().length, 1);
  const api = await post({ type: 'ADJUST', reason: 'LOST', vendorId: 'V1', paymentMode: 'CASH', items: [{ productId: 'P1', qty: -2 }] }, API);
  assert.equal(api.status, 201);
  assert.deepEqual((api.body.warnings as Row[]).map((w) => w.code).sort(), ['ADJUST_REASON_IGNORED', 'PURCHASE_FIELDS_IGNORED']);
  const e = store.entries().slice(-1)[0];
  assert.deepEqual([e.reason, e.vendorId, e.paymentMode], [null, null, null]);
  assert.equal(store.ledger().length, 0);
});

test('الشامل وغير المستردة والشركة بلا ضريبة: الإجمالي كفاتورة المورّد، والتكلفة المرسمَلة، والنسبة صفر', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT', costsIncludeTax: true, items: [{ productId: 'P1', qty: 1000, unitCost: 10 }] });
  const inc = store.entries()[0];
  assert.deepEqual([inc.netMilli, inc.taxMilli, inc.totalMilli], [8_695_650n, 1_304_350n, 10_000_000n]);
  assert.equal(store.itemsOf(inc.id)[0].unitCost, 8.6957, 'تكلفة المخزون صافية كما يحسبها الوارد القائم');
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT', vatTreatment: 'NON_RECOVERABLE' });
  const nr = store.entries()[0];
  assert.deepEqual([nr.vatTreatment, nr.totalMilli, store.itemsOf(nr.id)[0].unitCost], ['NON_RECOVERABLE', 2_300_000n, 23]);
  fresh({ taxDisabled: true });
  const off = await post({ ...BUY, paymentMode: 'CREDIT', vatTreatment: 'RECOVERABLE', costsIncludeTax: true, items: [{ productId: 'P1', qty: 100, unitCost: 23 }] });
  const e = store.entries()[0];
  assert.deepEqual([e.vatTreatment, e.netMilli, e.taxMilli, e.totalMilli, store.itemsOf(e.id)[0].taxPct, store.itemsOf(e.id)[0].unitCost], ['NONE', 2_300_000n, 0n, 2_300_000n, 0, 23]);
  assert.deepEqual((off.body.warnings as Row[]).map((w) => w.code), ['VAT_TREATMENT_ADJUSTED']);
});

test('حدود الإدخال: مرتجعٌ بلا أسطر أو بكمية صفر أو لسطرٍ غريب 400، والإلغاء بسببٍ طويل 400، وحركة غير موجودة 404', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT' });
  const [bill] = store.entries();
  const id = bill.id;
  for (const body of [{}, { items: [] }, { items: [{ itemId: 'x', qty: 0 }] }, { items: [{ itemId: 'x', qty: 1 }] }, { items: [{ itemId: store.itemsOf(id)[0].id, qty: 1 }], refundMode: 'GIFT' }]) {
    const r = await call('post', '/entries/:id/return', { params: { id }, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, 'RETURN_INVALID');
  }
  assert.equal((await call('post', '/entries/:id/cancel', { params: { id }, body: { reason: 'س'.repeat(301) } })).status, 400);
  assert.equal((await call('post', '/entries/:id/cancel', { params: { id: 'nope' } })).status, 404);
  assert.equal((await call('post', '/entries/:id/return', { params: { id: 'nope' }, body: { items: [{ itemId: 'x', qty: 1 }] } })).status, 404);
  // تاريخ مرتجعٍ قبل الفاتورة
  const early = await call('post', '/entries/:id/return', { params: { id }, body: { items: [{ itemId: store.itemsOf(id)[0].id, qty: 1 }], billDate: '2026-11-01' } });
  assert.equal(early.body.code, 'RETURN_INVALID');
  assert.equal(store.entries({ type: 'RETURN' }).length, 0);
});

test('المناديب لعهدة الدفع (GET /reps): المعرّف والاسم والحالة وحدها لمناديب الشركة، بحرّاس المستودع — لا canManageSalesReps', async () => {
  fresh();
  store.add('salesRep', { id: 'R0', tenantId: T, name: 'أحمد', isActive: false, phone: '0500', passwordHash: 'x' });
  store.add('salesRep', { id: 'RX', tenantId: 't2', name: 'مندوب شركة أخرى' });
  const r = await call('get', '/reps');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = r.body.data as Row[];
  assert.deepEqual(rows.map((x) => x.id).sort(), ['R0', 'R1']);
  for (const x of rows) assert.deepEqual(Object.keys(x).sort(), ['id', 'isActive', 'name'].filter((k) => k in x).sort());
  assert.ok(!rows.some((x) => 'phone' in x || 'passwordHash' in x));
  assert.deepEqual(glWrites(), []);
});
