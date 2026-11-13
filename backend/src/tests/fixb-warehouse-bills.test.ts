// إصلاحات «ربط الدفاتر» L1 (fixb) — مسار المستودع routes/warehouse.ts فوق القاعدة المزيّفة b4-fake.ts:
//   #2 إلغاء الشراء النقدي بعد مرتجع «خصم من المستحق»: السند الآلي يبقى ويُستردّ المتبقّي وحده (REFUND_IN)، فيبقى الخصم رصيداً مديناً
//      على المورّد — كحالة المرتجع النقدي تماماً (لا معاملتان للإشعار نفسه).
//   #3/#8 مرتجع المورّد بمفتاح منع التكرار clientRef: الإعادة بعد ضياع الردّ ⇒ 200 replay بلا مرتجعٍ ثانٍ ولا قيدٍ مكرَّر، والطلب
//      المتزامن يحسمه القفل الاستشاري داخل المعاملة، ومرجعٌ لحركةٍ أخرى 409 CLIENT_REF_REUSED.
//   #5/#9 المخزون الافتتاحي السابق لعمود المصدر ('MANUAL' بدفعة opening_stock): لا يُصنَّف ولا يُلغى (409)، ويُعرض في السجلّ بمصدره
//      الحقيقي OPENING_IMPORT — بالدفعة لا بنصّ الملاحظة وحده.
//   #6 «الدفع من عهدة مندوب» بنطاق المستخدم المقيَّد في الإنشاء والتصنيف، و«مصدر الدفع» بلا معرّف مندوبٍ خارج نطاقه في السجلّ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store, type Row } from './b4-fake';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
const store = new Store();
const db = store.db;
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const router = (require('../routes/warehouse') as typeof import('../routes/warehouse')).default;
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
const { OPENING_STOCK_NOTE } = require('../services/importLedger') as typeof import('../services/importLedger');
/* eslint-enable @typescript-eslint/no-var-requires */

const T = 't1';
const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: T, name: 'المدير' };
/** مستخدمٌ مقيَّد بالقوائم: نطاقه المندوب R1 وحده (salesRep.adminScopes) */
const SCOPED = { id: 'U2', role: 'ADMIN', tenantId: T, name: 'مقيَّد' };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }

/** حرّاس الموجّه ثم المعالج ثم معالجات الأخطاء (نمط b4-warehouse-purchase) — والردّ يمرّ بـJSON حقيقي */
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

function fresh(): void {
  store.reset();
  store.add('tenant', { id: T, warehouseEnabled: true, accountingEnabled: true, lotTrackingEnabled: false });
  store.add('admin', { id: 'ADM', isActive: true, canManageVanStock: true, scopeEnabled: false });
  store.add('admin', { id: 'U2', isActive: true, canManageVanStock: true, scopeEnabled: true, scopeMode: 'LISTS' });
  store.add('companySettings', { tenantId: T, taxDisabled: false, currency: 'SAR', countryCode: 'SA', defaultVatPct: 15 });
  store.add('product', { id: 'P1', tenantId: T, name: 'مياه', code: 'W1', unit: 'كرتون', taxPct: 15 });
  store.add('glVendor', { id: 'V1', tenantId: T, name: 'مؤسسة الخير', paymentDays: 30 });
  store.add('salesRep', { id: 'R1', tenantId: T, name: 'سالم', adminScopes: [{ adminId: 'U2' }] });
  store.add('salesRep', { id: 'R2', tenantId: T, name: 'خالد', adminScopes: [] });
}

const post = (body: Row, user: Row = ADMIN) => call('post', '/entries', { body, user });
// ١٠ × ١٠ صافٍ بضريبة ١٥٪ ⇒ 115
const BUY = { type: 'RECEIVE', vendorId: 'V1', supplierRef: 'INV-1', billDate: '2026-11-10', items: [{ productId: 'P1', qty: 10, unitCost: 10 }] };
const writes = (from: number) => store.calls.slice(from).map((c) => c.op).filter((op) => /\.(create|createMany|update|updateMany|delete|deleteMany)$/.test(op));

// ═══ #2 إلغاء النقدي بعد مرتجع «خصم من المستحق» ═══

test('#2 إلغاء الشراء النقدي بعد مرتجع خصمٍ من المستحق: السند يبقى، وRETURN + REFUND_IN بالمتبقّي وحده، والخصم يبقى رصيداً مديناً على المورّد', async () => {
  fresh();
  assert.equal((await post({ ...BUY, paymentMode: 'CASH' })).status, 201);
  const [bill] = store.entries();
  const [it] = store.itemsOf(bill.id);
  // مرتجع النصف «خصماً من المستحق» (الافتراضي CREDIT) ⇒ RETURN −57.5 والرصيد −57.5 (إشعار دائن لنا)
  const half = await call('post', '/entries/:id/return', { params: { id: bill.id }, body: { items: [{ itemId: it.id, qty: 5 }] } });
  assert.equal(half.status, 201, JSON.stringify(half.body));
  assert.equal(store.balanceMilli('V1'), -57_500n);
  const r = await call('post', '/entries/:id/cancel', { params: { id: bill.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // كان: PAYMENT_REV +115 (نقدٌ عائد كاملاً) والرصيد صفر — فيُمحى الإشعار ويُسجَّل نقداً ما لم يُردّ
  assert.equal(store.t.supplierPayment[0].status, 'POSTED', 'السند الآلي باقٍ');
  assert.ok(!('cancelledPayment' in r.body));
  assert.deepEqual(store.ledger({ kind: 'PAYMENT_REV' }), []);
  const last = store.entries({ type: 'RETURN' })[1];
  assert.deepEqual([last.paymentMode, last.paidAccountRef, last.totalMilli], ['CASH', 'MAIN_CASH', 57_500n]);
  assert.deepEqual(store.ledger({ warehouseEntryId: last.id }).map((l) => [l.kind, l.amountMilli]), [['RETURN', -57_500n], ['REFUND_IN', 57_500n]]);
  assert.equal(store.balanceMilli('V1'), -57_500n, 'الخصم السابق باقٍ ديناً على المورّد');
  assert.equal(store.entries()[0].status, 'CANCELLED');
});

test('#2 الإشعار نفسه يُعامَل معاملةً واحدة: مرتجعٌ نقدي ثم مرتجع خصم ثم إلغاء ⇒ الرصيد سالب بقيمة الخصم وحده كالحالة السابقة', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CASH' });
  const [bill] = store.entries();
  const [it] = store.itemsOf(bill.id);
  await call('post', '/entries/:id/return', { params: { id: bill.id }, body: { items: [{ itemId: it.id, qty: 2 }], refundMode: 'CASH' } }); // 23 نقداً
  await call('post', '/entries/:id/return', { params: { id: bill.id }, body: { items: [{ itemId: it.id, qty: 3 }] } }); // 34.5 خصماً
  const r = await call('post', '/entries/:id/cancel', { params: { id: bill.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(store.t.supplierPayment[0].status, 'POSTED');
  const last = store.entries({ type: 'RETURN' })[2];
  assert.deepEqual(store.ledger({ warehouseEntryId: last.id }).map((l) => [l.kind, l.amountMilli]), [['RETURN', -57_500n], ['REFUND_IN', 57_500n]]);
  assert.equal(store.balanceMilli('V1'), -34_500n, 'إشعار الخصم وحده');
  // وبلا أي مرتجعٍ سابق: السند الآلي يُلغى كما كان (PAYMENT_REV) والرصيد صفر
  fresh();
  await post({ ...BUY, paymentMode: 'CASH' });
  const c = await call('post', '/entries/:id/cancel', { params: { id: store.entries()[0].id } });
  assert.equal(c.status, 200);
  assert.equal(c.body.cancelledPayment.displayNumber, 'SP-000001');
  assert.equal(store.balanceMilli('V1'), 0n);
});

// ═══ #3/#8 مفتاح منع التكرار للمرتجع ═══

test('#3 مرتجعٌ أُعيد بمرجعه بعد ضياع الردّ ⇒ 200 replay بالمرتجع نفسه بلا حركةٍ ثانية ولا قيدٍ مكرَّر — والمرجع في عمود الحركة', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT', items: [{ productId: 'P1', qty: 10, unitCost: 10 }] });
  const [bill] = store.entries();
  const [it] = store.itemsOf(bill.id);
  const body = { items: [{ itemId: it.id, qty: 3 }], refundMode: 'CASH', clientRef: 'ret-0001' };
  const first = await call('post', '/entries/:id/return', { params: { id: bill.id }, body });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const ret = store.entries({ type: 'RETURN' })[0];
  assert.equal(ret.clientRef, 'ret-0001');
  const mark = store.calls.length;
  const again = await call('post', '/entries/:id/return', { params: { id: bill.id }, body });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.replay, again.body.idempotent, again.body.data.id, again.body.entry.id], [true, true, ret.id, bill.id]);
  assert.deepEqual(writes(mark), [], 'لا كتابة في الإعادة');
  assert.equal(store.entries({ type: 'RETURN' }).length, 1);
  assert.deepEqual(store.ledger({ kind: 'RETURN' }).length, 1);
  assert.deepEqual(store.ledger({ kind: 'REFUND_IN' }).length, 1, 'الاسترداد النقدي مرّة واحدة');
  // الإعادة تُجاب ولو أُلغي الوارد بعدها (لا حكمٌ جديد على الوارد)
  await call('post', '/entries/:id/cancel', { params: { id: bill.id } });
  const late = await call('post', '/entries/:id/return', { params: { id: bill.id }, body });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.data.id, ret.id);
  // مرجعٌ آخر لمرتجعٍ جديد يُكتب كالمعتاد (بلا مرجع كما كان)
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT' });
  const b2 = store.entries()[0];
  const i2 = store.itemsOf(b2.id)[0];
  assert.equal((await call('post', '/entries/:id/return', { params: { id: b2.id }, body: { items: [{ itemId: i2.id, qty: 1 }] } })).status, 201);
  assert.equal((await call('post', '/entries/:id/return', { params: { id: b2.id }, body: { items: [{ itemId: i2.id, qty: 1 }] } })).status, 201, 'بلا مرجع: كما كان');
  assert.equal(store.entries({ type: 'RETURN' })[0].clientRef, null);
});

test('#3 الطلبان المتزامنان: القفل الاستشاري أول المعاملة (قبل أقفال الأصناف) ثم البحث بالمرجع — من وجده يُجهِض بلا كتابة ويردّ القائم', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT' });
  const [bill] = store.entries();
  const [it] = store.itemsOf(bill.id);
  const body = { items: [{ itemId: it.id, qty: 4 }], clientRef: 'ret-race' };
  assert.equal((await call('post', '/entries/:id/return', { params: { id: bill.id }, body })).status, 201);
  const ret = store.entries({ type: 'RETURN' })[0];
  // الطلب الثاني لم يجده الفحص السريع خارج المعاملة (التزم الأول بعده) — يجده تحت القفل
  const realFindFirst = db.warehouseEntry.findFirst;
  let outside = true;
  db.warehouseEntry.findFirst = async (a: Row) => {
    if (outside && a?.where?.clientRef) { outside = false; return null; }
    return realFindFirst(a);
  };
  const mark = store.calls.length;
  try {
    const r = await call('post', '/entries/:id/return', { params: { id: bill.id }, body });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.replay, r.body.data.id], [true, ret.id]);
  } finally {
    db.warehouseEntry.findFirst = realFindFirst;
  }
  const ops = store.calls.slice(mark);
  const lock = ops.findIndex((c) => c.op === 'exec' && String(c.values?.[0]) === `warehouse-entry-ref:${T}:ret-race`);
  const products = ops.findIndex((c) => c.op === 'query' && /FROM products/.test(String(c.sql)));
  assert.ok(lock >= 0, 'قفل المرجع');
  assert.ok(products === -1 || lock < products, 'المرجع قبل أقفال الأصناف');
  assert.ok(ops.some((c) => c.op === 'tx.rollback'), 'المعاملة أُجهضت');
  assert.equal(store.entries({ type: 'RETURN' }).length, 1);
  assert.equal(store.ledger({ kind: 'RETURN' }).length, 1);
});

test('#3 مرجعٌ مستعملٌ لحركةٍ أخرى (وارد، أو مرتجع وارد آخر) ⇒ 409 CLIENT_REF_REUSED بلا كتابة، والشكل الخاطئ 400 RETURN_INVALID', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT', clientRef: 'shared-1' });
  await post({ ...BUY, paymentMode: 'CREDIT', supplierRef: 'INV-2' });
  const [b1, b2] = store.entries();
  const i1 = store.itemsOf(b1.id)[0];
  const i2 = store.itemsOf(b2.id)[0];
  const reused = await call('post', '/entries/:id/return', { params: { id: b1.id }, body: { items: [{ itemId: i1.id, qty: 1 }], clientRef: 'shared-1' } });
  assert.equal(reused.status, 409, JSON.stringify(reused.body));
  assert.equal(reused.body.code, 'CLIENT_REF_REUSED');
  assert.equal((await call('post', '/entries/:id/return', { params: { id: b1.id }, body: { items: [{ itemId: i1.id, qty: 1 }], clientRef: 'r-1' } })).status, 201);
  const other = await call('post', '/entries/:id/return', { params: { id: b2.id }, body: { items: [{ itemId: i2.id, qty: 1 }], clientRef: 'r-1' } });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, 'CLIENT_REF_REUSED');
  assert.equal(store.entries({ type: 'RETURN' }).length, 1);
  for (const bad of ['has space', 'x'.repeat(65), 7]) {
    const r = await call('post', '/entries/:id/return', { params: { id: b1.id }, body: { items: [{ itemId: i1.id, qty: 1 }], clientRef: bad } });
    assert.equal(r.status, 400, String(bad));
    assert.equal(r.body.code, 'RETURN_INVALID');
  }
});

// ═══ #5/#9 المخزون الافتتاحي السابق لعمود المصدر ═══

/** وارد «استيراد المخزون الافتتاحي» كما كتبه الاستيراد قبل العمود: RECEIVE مسعَّر بملاحظته، والمصدر MANUAL من db push، ودفعته */
function legacyOpening(id = 'OPEN1', inBatch = true): Row {
  const e = store.add('warehouseEntry', { id, tenantId: T, type: 'RECEIVE', note: OPENING_STOCK_NOTE, source: 'MANUAL' });
  store.add('warehouseEntryItem', { id: `${id}-i`, entryId: id, productId: 'P1', qty: 100, baseQty: 100, unitCost: 5 });
  if (inBatch) store.add('importBatch', { id: `B-${id}`, tenantId: T, kind: 'opening_stock', count: 1, recordIds: JSON.stringify([id]), reverted: false });
  return e;
}

test('#5 الافتتاحي السابق للعمود (MANUAL بدفعة opening_stock): التصنيف 409 ENTRY_NOT_CLASSIFIABLE والإلغاء 409 ENTRY_NOT_RETURNABLE — بلا كتابة', async () => {
  fresh();
  const e = legacyOpening();
  const mark = store.calls.length;
  const c = await call('post', '/entries/:id/classify', { params: { id: e.id }, body: { vendorId: 'V1', paymentMode: 'CASH' } });
  assert.equal(c.status, 409, JSON.stringify(c.body));
  assert.equal(c.body.code, 'ENTRY_NOT_CLASSIFIABLE');
  const x = await call('post', '/entries/:id/cancel', { params: { id: e.id } });
  assert.equal(x.status, 409, JSON.stringify(x.body));
  assert.equal(x.body.code, 'ENTRY_NOT_RETURNABLE');
  assert.match(x.body.message, /تراجع/);
  assert.deepEqual(writes(mark), []);
  assert.deepEqual([store.entries({ type: 'RETURN' }).length, store.ledger().length, store.t.supplierPayment.length], [0, 0, 0]);
  // وبالعمود (بعد سكربت الملء أو الاستيراد الجديد): الإلغاء مرفوضٌ أيضاً — كان يمرّ فيحبس تراجع الاستيراد
  store.add('warehouseEntry', { id: 'OPEN2', tenantId: T, type: 'RECEIVE', note: OPENING_STOCK_NOTE, source: 'OPENING_IMPORT' });
  store.add('warehouseEntryItem', { id: 'OPEN2-i', entryId: 'OPEN2', productId: 'P1', qty: 1, baseQty: 1, unitCost: 5 });
  const y = await call('post', '/entries/:id/cancel', { params: { id: 'OPEN2' } });
  assert.equal(y.body.code, 'ENTRY_NOT_RETURNABLE');
  assert.equal(store.entries({ type: 'RETURN' }).length, 0);
});

test('#5 السجلّ يعرض الافتتاحي السابق للعمود بمصدره OPENING_IMPORT (بالدفعة) — ووارد يدوي كُتبت فيه الملاحظة نفسها يبقى يدوياً ويُصنَّف', async () => {
  fresh();
  legacyOpening('OPEN1', true);
  legacyOpening('FAKE1', false); // ملاحظةٌ مكتوبة يدوياً بلا دفعة استيراد
  const rows = (await call('get', '/entries')).body.data as Row[];
  assert.equal(rows.find((r) => r.id === 'OPEN1')!.source, 'OPENING_IMPORT');
  assert.equal(rows.find((r) => r.id === 'FAKE1')!.source, 'MANUAL');
  const ok = await call('post', '/entries/:id/classify', { params: { id: 'FAKE1' }, body: { vendorId: 'V1', paymentMode: 'CREDIT' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // سجلٌّ بلا مرشّح (لا ملاحظة الافتتاحي): لا قراءة لدفعات الاستيراد أصلاً
  fresh();
  await post({ ...BUY, paymentMode: 'CREDIT' });
  const mark = store.calls.length;
  await call('get', '/entries');
  assert.ok(!store.calls.slice(mark).some((c) => c.op.startsWith('importBatch.')), 'لا استعلام زائد');
});

// ═══ #6 «الدفع من عهدة مندوب» بنطاق المستخدم ═══

test('#6 المقيَّد لا يحمّل شراءه على عهدة مندوبٍ خارج نطاقه: الإنشاء والتصنيف 400 PURCHASE_INVALID برسالة غير الموجود — ومن نطاقه 201', async () => {
  fresh();
  const out = await post({ ...BUY, paymentMode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'R2' }, SCOPED);
  assert.equal(out.status, 400, JSON.stringify(out.body));
  assert.deepEqual([out.body.code, out.body.message], ['PURCHASE_INVALID', 'مندوب العهدة غير موجود في الشركة']);
  assert.deepEqual([store.entries().length, store.t.supplierPayment.length], [0, 0]);
  const mine = await post({ ...BUY, paymentMode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'R1' }, SCOPED);
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.deepEqual([store.t.supplierPayment[0].method, store.t.supplierPayment[0].salesRepId], ['REP_CUSTODY', 'R1']);
  // غير المقيَّد: أي مندوبٍ في الشركة كما كان
  assert.equal((await post({ ...BUY, supplierRef: 'INV-9', paymentMode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'R2' })).status, 201);
  // مفتاح API مقيَّد: لا يُرفض — الوارد غير مصنَّف بتحذير («الربط لا يُرفض»)
  const api = await post({ ...BUY, supplierRef: 'INV-10', paymentMode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'R2' }, { ...SCOPED, apiKeyId: 'K1' });
  assert.equal(api.status, 201, JSON.stringify(api.body));
  assert.equal(api.body.data.paymentMode, null);
  assert.ok((api.body.warnings as Row[]).some((w) => w.code === 'PURCHASE_UNCLASSIFIED' && /مندوب العهدة/.test(w.message)));
  // التصنيف بالطريقة نفسها
  await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 1, unitCost: 4 }] });
  const raw = store.entries().find((e) => !e.paymentMode && !e.vendorId)!;
  const cls = await call('post', '/entries/:id/classify', { params: { id: raw.id }, user: SCOPED, body: { vendorId: 'V1', paymentMode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'R2' } });
  assert.equal(cls.status, 400, JSON.stringify(cls.body));
  assert.equal(cls.body.message, 'مندوب العهدة غير موجود في الشركة');
  assert.equal(store.entries().find((e) => e.id === raw.id)!.paymentMode, null);
});

test('#6 السجلّ للمقيَّد: «مصدر الدفع» بعهدة مندوبٍ خارج نطاقه بلا معرّفه (REP_CUSTODY)، ومن نطاقه كاملاً — وغير المقيَّد يرى الكل', async () => {
  fresh();
  await post({ ...BUY, paymentMode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'R2' });
  await post({ ...BUY, supplierRef: 'INV-2', paymentMode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'R1' });
  await post({ ...BUY, supplierRef: 'INV-3', paymentMode: 'CASH' });
  const refs = async (user: Row) => ((await call('get', '/entries', { user })).body.data as Row[]).map((e) => e.paidAccountRef).sort();
  assert.deepEqual(await refs(SCOPED), ['MAIN_CASH', 'REP_CUSTODY', 'REP_CUSTODY:R1']);
  assert.deepEqual(await refs(ADMIN), ['MAIN_CASH', 'REP_CUSTODY:R1', 'REP_CUSTODY:R2']);
  // وردّ الإلغاء للمقيَّد بالحجب نفسه
  const r2 = store.entries().find((e) => e.paidAccountRef === 'REP_CUSTODY:R2')!;
  const c = await call('post', '/entries/:id/cancel', { params: { id: r2.id }, user: SCOPED });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.data.paidAccountRef, 'REP_CUSTODY');
});
