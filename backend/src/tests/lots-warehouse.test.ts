// «تتبّع اللوط» — وارد المستودع وتسوياته (المواصفة §٨.٢ lots-warehouse، الحزمة B3): الموجّه الحقيقي routes/warehouse.ts وخطة
// services/lotsWarehouse.ts فوق قاعدةٍ مزيّفة تجيب تجميعات SQL من صفوفها (lots-b3-fake.ts)، فيمرّ الطيّ والعروض والأقفال
// بمسارها الحقيقي. ما يُحرس تشغيلاً: الوارد يلزمه لوط والانتهاء مع الصلاحية، والكمية بالأساس مع الوحدات (سطر بكرتون وسطر بحبة
// للصنف نفسه)، وتسوية النقص بالتجميع (D26) تحت القفل بلا سالب على مستوى اللوط (I1) ولا تحت min(0, قبله) لغير المسمّى (I2)،
// وغير المتتبَّع والميزة المطفأة كما هما حرفياً، وخاصيةٌ عشوائية: لا تسلسل عمليات يُنتج صالحاً سالباً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { World, dateOf, type Row } from './lots-b3-fake';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const world = new World();
const db = world.db;
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const router = (require('../routes/warehouse') as typeof import('../routes/warehouse')).default;
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
const lotsW = require('../services/lotsWarehouse') as typeof import('../services/lotsWarehouse');
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }

/** يشغّل وسائط الموجّه (عدا المصادقة) ثم المسار ثم معالج أخطائه — كما يمشيها Express */
async function call(method: string, p: string, req: Row = {}): Promise<{ status: number; body: Row; err?: unknown }> {
  const stack = (router as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === p && l.route.methods[method]);
  assert.ok(layer, `${method} ${p} مفقود`);
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const errHandlers = stack.filter((l) => !l.route && l.handle.length === 4).map((l) => l.handle);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
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
    return { status: 500, body: { message: (err as Error)?.message }, err };
  }
  return { status: res.statusCode, body: res.body };
}

/** عالمٌ جديد: P1 متتبَّع بوحدتين (كرتون ٢٤ وشدّة ٦)، وP2 متتبَّع بصلاحية، وP3 غير متتبَّع */
function fresh(): void {
  Object.assign(world, new World());
  world.product({ id: 'P1', name: 'ماء' });
  world.product({ id: 'P2', name: 'حليب', shelfLifeEnabled: true, shelfLifeValue: 30, shelfLifeUnit: 'DAY' });
  world.product({ id: 'P3', name: 'سكر' });
  world.unit({ id: 'U-CT', productId: 'P1', name: 'كرتون', factor: 24 });
  world.unit({ id: 'U-6', productId: 'P1', name: 'شدّة', factor: 6 });
  world.track('P1');
  world.track('P2');
}
const post = (body: Row) => call('post', '/entries', { body });
const lotOf = (n: string, pid = 'P1') => world.lotByNumber(pid, n)!;
const lastItems = () => world.items.filter((i) => i.entryId === world.entries[world.entries.length - 1].id);

// ═══ الوارد ═══

test('الوارد لصنفٍ متتبَّع بلا تشغيلة ⇒ 422 LOT_REQUIRED باسم الصنف، ولا حركة ولا لوط', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 10 }] });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.code, 'LOT_REQUIRED');
  assert.match(r.body.message, /«ماء»/);
  assert.equal(world.entries.length, 0);
  assert.equal(world.lots.length, 0);
  assert.ok(world.calls.some((c) => c.op === 'tx.rollback'));
});

test('الوارد: الانتهاء إلزامي مع الصلاحية (LOT_EXPIRY_REQUIRED)، والرقم مطبَّع، واللوط يُنشأ بمصدر RECEIVE مع LotEvent، والردّ يحمل lot', async () => {
  fresh();
  const bad = await post({ type: 'RECEIVE', items: [{ productId: 'P2', qty: 5, lotNumber: 'm-1' }] });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, 'LOT_EXPIRY_REQUIRED');
  const badDates = await post({ type: 'RECEIVE', items: [{ productId: 'P2', qty: 5, lotNumber: 'm-1', productionDate: '2026-12-01', expiryDate: '2026-11-01' }] });
  assert.equal(badDates.body.code, 'LOT_DATES_INVALID');
  assert.equal(world.lots.length, 0);

  const ok = await post({ type: 'RECEIVE', items: [{ productId: 'P2', qty: 5, lotNumber: '  m-١ ', expiryDate: '2027-01-31' }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const lot = lotOf('M-1', 'P2');
  assert.ok(lot, 'الرقم مطبَّع: قصّ وأرقام عربية وحروف كبيرة');
  assert.equal(lot.source, 'RECEIVE');
  assert.equal(lot.createdBy, 'المدير');
  assert.equal(lastItems()[0].lotId, lot.id);
  assert.equal(ok.body.data.items[0].lot.lotNumber, 'M-1', 'ردّ 201 يضمّ بطاقة التشغيلة (ن٢-١٨)');
  assert.equal(ok.body.warnings, undefined, 'بلا تحذير لا مفتاح warnings');
  const ev = world.events.find((e) => e.kind === 'CREATE');
  assert.ok(ev && ev.lotId === lot.id && ev.actorType === 'ADMIN' && ev.actorName === 'المدير');
  // وارد ثانٍ بالرقم نفسه بلا تاريخ يطابق القائم، وبتاريخ مخالف ⇒ 409 LOT_DATES_MISMATCH
  assert.equal((await post({ type: 'RECEIVE', items: [{ productId: 'P2', qty: 2, lotNumber: 'M-1' }] })).status, 201);
  assert.equal(world.lots.length, 1);
  const mis = await post({ type: 'RECEIVE', items: [{ productId: 'P2', qty: 2, lotNumber: 'M-1', expiryDate: '2027-02-28' }] });
  assert.equal(mis.status, 409);
  assert.equal(mis.body.code, 'LOT_DATES_MISMATCH');
  const misById = await post({ type: 'RECEIVE', items: [{ productId: 'P2', qty: 2, lotId: lot.id, expiryDate: '2027-02-28' }] });
  assert.equal(misById.body.code, 'LOT_DATES_MISMATCH', 'بالمعرّف وتاريخٍ مخالف لا يُصحَّح تاريخ اللوط من وارد');
  assert.equal(world.warehouseRaw(lot.id), 7);
});

test('الوارد إلى لوطٍ موقوف مقبول بتحذير LOT_INTO_BLOCKED، ولوط صنفٍ آخر ⇒ 422 LOT_PRODUCT_MISMATCH، ولوط شركةٍ أخرى ⇒ LOT_NOT_FOUND', async () => {
  fresh();
  world.lot({ id: 'LB', productId: 'P1', lotNumber: 'B-1', status: 'BLOCKED', blockKind: 'RECALL', blockedAt: world.now() });
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 3, lotId: 'LB' }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.warnings.map((w: Row) => [w.code, w.detail.lotId, w.detail.blockKind]), [['LOT_INTO_BLOCKED', 'LB', 'RECALL']]);
  assert.equal(world.warehouseRaw('LB'), 3);
  assert.equal((await post({ type: 'RECEIVE', items: [{ productId: 'P2', qty: 3, lotId: 'LB' }] })).body.code, 'LOT_PRODUCT_MISMATCH');
  world.lot({ id: 'LX', tenantId: 'OTHER', productId: 'P1', lotNumber: 'X' });
  assert.equal((await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 3, lotId: 'LX' }] })).body.code, 'LOT_NOT_FOUND');
});

test('الوحدات: سطرٌ بكرتون وسطرٌ بحبة للصنف نفسه بتشغيلتين — لكل سطرٍ لوطه، والخام بالأساس (٢×٢٤ و٥)', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', items: [
    { productId: 'P1', qty: 2, unitId: 'U-CT', lotNumber: 'A' },
    { productId: 'P1', qty: 5, lotNumber: 'B' },
    { productId: 'P3', qty: 4, lotNumber: 'تُتجاهل' },
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [a, b, c] = lastItems();
  assert.deepEqual([a.qty, a.unitFactor, a.baseQty, a.lotId], [2, 24, 48, lotOf('A').id]);
  assert.deepEqual([b.qty, b.unitFactor, b.baseQty, b.lotId], [5, 1, 5, lotOf('B').id]);
  assert.equal(c.lotId, null, 'غير المتتبَّع بلا لوط ولو أُرسل رقم');
  assert.equal(world.lots.filter((l) => l.productId === 'P3').length, 0);
  assert.equal(world.warehouseRaw(lotOf('A').id), 48);
  assert.equal(world.warehouseRaw(lotOf('B').id), 5);
  // كسرٌ بالكرتون أساسه بأربع خانات مقبول (٠٫٢٥ كرتون = ٦)، وكسرٌ بخمس خانات بالأساس ⇒ LOT_QTY_INVALID ولا كتابة
  assert.equal((await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 0.25, unitId: 'U-CT', lotNumber: 'A' }] })).status, 201);
  assert.equal(world.warehouseRaw(lotOf('A').id), 54);
  const n = world.items.length;
  const fine = await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 1.00005, lotNumber: 'A' }] });
  assert.equal(fine.status, 422);
  assert.equal(fine.body.code, 'LOT_QTY_INVALID');
  assert.equal(world.items.length, n);
  // وغير المتتبَّع يقبل الكسر كما كان (لا قاعدة جديدة عليه)
  assert.equal((await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1.00005 }] })).status, 201);
});

// ═══ تسوية النقص: التجميع (D26) والقفل وI1/I2 ═══

/** رصيدٌ مسمّى في المستودع: وارد بلوطه بعد الحقبة */
function stock(pid: string, lotNumber: string, qty: number, extra: Row = {}): string {
  const l = world.lots.find((x) => x.productId === pid && x.lotNumber === lotNumber) ?? world.lot({ id: `L-${lotNumber}`, productId: pid, lotNumber, ...extra });
  world.entry('RECEIVE', [{ productId: pid, qty, lotId: l.id }]);
  return l.id;
}

test('النقص بالتجميع: سطران على لوطٍ واحد كلٌّ دون صالحه ومعاً فوقه ⇒ 409 LOT_STOCK_INSUFFICIENT ولا كتابة؛ ومعاً بقدره يُصفّيه', async () => {
  fresh();
  const A = stock('P1', 'A', 10);
  const over = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -6, lotId: A }, { productId: 'P1', qty: -6, lotId: A }] });
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.equal(over.body.code, 'LOT_STOCK_INSUFFICIENT');
  assert.match(over.body.message, /«ماء»/);
  assert.equal(world.warehouseRaw(A), 10, 'لا نصف حركة');
  const ok = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -6, lotId: A }, { productId: 'P1', qty: -4, lotId: A }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(world.warehouseRaw(A), 0);
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -0.0001, lotId: A }] })).status, 409, 'ولا جزءٌ من عشرة آلاف تحت الصفر');
});

test('النقص بالوحدات: كرتونٌ (٢٤) وسبع حبّات من لوطٍ فيه ٣٠ ⇒ ٣١ بالأساس فوقه؛ وكرتونٌ وستّ يُصفّيه', async () => {
  fresh();
  const A = stock('P1', 'A', 30);
  const over = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -1, unitId: 'U-CT', lotId: A }, { productId: 'P1', qty: -7, lotId: A }] });
  assert.equal(over.status, 409);
  assert.equal(over.body.detail.wanted, 31);
  const ok = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -1, unitId: 'U-CT', lotId: A }, { productId: 'P1', qty: -6, lotId: A }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(lastItems().map((i) => [i.baseQty, i.lotId]), [[-24, A], [-6, A]]);
  assert.equal(world.warehouseRaw(A), 0);
});

test('النقص بلا تشغيلة: مصدرٌ واحد يُستعمل تلقائياً، ومصدران ⇒ 422 LOT_REQUIRED بقائمة المصادر (D10)', async () => {
  fresh();
  const A = stock('P1', 'A', 10);
  const auto = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -3 }] });
  assert.equal(auto.status, 201, JSON.stringify(auto.body));
  assert.equal(lastItems()[0].lotId, A);
  const B = stock('P1', 'B', 5);
  const two = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -1 }] });
  assert.equal(two.status, 422);
  assert.equal(two.body.code, 'LOT_REQUIRED');
  assert.deepEqual(two.body.detail.sources.map((s: Row) => s.lotId).sort(), [A, B].sort());
  // سطرٌ صريح وسطرٌ تلقائي: التلقائي يأخذ المصدر الوحيد ثم يُفحص المجموع معاً
  fresh();
  const C = stock('P1', 'C', 4);
  const mixed = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -3, lotId: C }, { productId: 'P1', qty: -2 }] });
  assert.equal(mixed.status, 409, 'الصريح ٣ والتلقائي ٢ من لوطٍ فيه ٤');
  assert.equal(world.warehouseRaw(C), 4);
});

test('النقص بلا تشغيلة مع صريحٍ للصنف نفسه: التلقائي يأخذ المصدر الوحيد **مما بقي** بعد الصريح (كالسيارة) لا LOT_REQUIRED على العرض كاملاً', async () => {
  // لوط A صالحه ١٠ وغير المسمّى ٥: الصريح يصفّي A فيبقى غير المسمّى وحده مصدراً للسطر التلقائي
  fresh();
  const A = stock('P1', 'A', 10);
  world.entry('ADJUST', [{ productId: 'P1', qty: 5, lotId: null }]);
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -10, lotId: A }, { productId: 'P1', qty: -5 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(lastItems().map((i) => i.lotId), [A, null]);
  assert.equal(world.warehouseRaw(A), 0);
  assert.equal(world.warehouseUnknown('P1'), 0);
  // والمرآة: غير المسمّى صريحٌ كله فيبقى A وحده للتلقائي
  fresh();
  const B = stock('P1', 'B', 10);
  world.entry('ADJUST', [{ productId: 'P1', qty: 5, lotId: null }]);
  const m = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -5, lotId: null }, { productId: 'P1', qty: -4 }] });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.deepEqual(lastItems().map((i) => i.lotId), [null, B]);
  assert.equal(world.warehouseRaw(B), 6);
  // ما بقي لا يكفي: التلقائي فوق غير المسمّى الباقي ⇒ 409 ولا كتابة (I2 محروس كما كان)
  fresh();
  const C = stock('P1', 'C', 10);
  world.entry('ADJUST', [{ productId: 'P1', qty: 5, lotId: null }]);
  const n = world.entries.length;
  const over = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -10, lotId: C }, { productId: 'P1', qty: -6 }] });
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.equal(over.body.code, 'LOT_STOCK_INSUFFICIENT');
  assert.equal(world.entries.length, n);
  assert.equal(world.warehouseRaw(C), 10);
  // والصريح لا يصفّي مصدراً: يبقى مصدران للتلقائي ⇒ LOT_REQUIRED كما كان (D10)
  fresh();
  const D = stock('P1', 'D', 10);
  world.entry('ADJUST', [{ productId: 'P1', qty: 5, lotId: null }]);
  const still = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -4, lotId: D }, { productId: 'P1', qty: -1 }] });
  assert.equal(still.status, 422, JSON.stringify(still.body));
  assert.equal(still.body.code, 'LOT_REQUIRED');
});

test('النقص من غير المسمّى (null صريح): لا ينزل دون min(0, قبله) — السالب التاريخي لا يُنقص، والزيادة غير المسمّاة تسدّه (I2)', async () => {
  fresh();
  // P3 قبل التتبّع: وارد ١٠ وتحميل ١٥ ⇒ غير المسمّى −٥ عند التفعيل
  world.entry('RECEIVE', [{ productId: 'P3', qty: 10 }]);
  world.vanItems.push({ id: 'v0', tenantId: 't1', productId: 'P3', salesRepId: 'R1', type: 'LOAD', qty: 15, unitFactor: 1, baseQty: 15, createdAt: world.now() });
  world.track('P3');
  assert.equal(world.warehouseUnknown('P3'), -5);
  const dec = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -1, lotId: null }] });
  assert.equal(dec.status, 409);
  assert.equal(dec.body.code, 'LOT_STOCK_INSUFFICIENT');
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -1 }] })).status, 409, 'التلقائي بلا مصدر');
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: 3, lotId: null }] })).status, 201, 'الزيادة غير المسمّاة مسموحة');
  assert.equal(world.warehouseUnknown('P3'), -2);
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -1, lotId: null }] })).status, 409, '−٢ لا يصير −٣');
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: 5, lotId: null }] })).status, 201);
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -3, lotId: null }] })).status, 201);
  assert.equal(world.warehouseUnknown('P3'), 0);
  // والتسوية بالزيادة بلا أي حقل ⇒ LOT_REQUIRED (المصدر صريحٌ في الاتجاهين)
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: 2 }] })).body.code, 'LOT_REQUIRED');
});

test('الإتلاف: النقص من لوطٍ موقوف أو منتهٍ مسموح (D27)، وبرقمٍ قائم يُحلّ، وبرقمٍ مجهول ⇒ 422 LOT_NOT_FOUND، وبلوط صنفٍ آخر ⇒ MISMATCH', async () => {
  fresh();
  const blocked = stock('P1', 'BL', 6, { status: 'BLOCKED', blockKind: 'HOLD', blockedAt: new Date() });
  const expired = stock('P1', 'EX', 4, { expiryDate: dateOf('2020-01-01') });
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -6, lotId: blocked }] })).status, 201);
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -4, lotNumber: 'ex' }] })).status, 201);
  assert.equal(world.warehouseRaw(blocked), 0);
  assert.equal(world.warehouseRaw(expired), 0);
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -1, lotNumber: 'NOPE' }] })).body.code, 'LOT_NOT_FOUND');
  const other = stock('P2', 'O', 5);
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -1, lotId: other }] })).body.code, 'LOT_PRODUCT_MISMATCH');
  assert.equal(world.warehouseRaw(other), 5);
});

test('المفتاح المحجوز «∅» (LOT_UNKNOWN_KEY) ليس معرّف تشغيلة: نقصاً أو زيادةً ⇒ 422 LOT_NOT_FOUND ولا حركة — لا سطرٌ بمعرّف لوطٍ لا وجود له', async () => {
  fresh();
  world.entry('RECEIVE', [{ productId: 'P1', qty: 10, lotId: null }]);   // غير المسمّى ١٠ بعد الحقبة
  const entries = world.entries.length;
  const out = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -3, lotId: '∅' }] });
  assert.equal(out.status, 422, JSON.stringify(out.body));
  assert.equal(out.body.code, 'LOT_NOT_FOUND');
  const inc = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: 3, lotId: '∅' }] });
  assert.equal(inc.status, 422, JSON.stringify(inc.body));
  assert.equal(inc.body.code, 'LOT_NOT_FOUND');
  // مع سطرٍ صالح في الحركة نفسها: لا نصف حركة
  const mixed = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -1, lotId: null }, { productId: 'P1', qty: -1, lotId: '∅' }] });
  assert.equal(mixed.body.code, 'LOT_NOT_FOUND');
  assert.equal(world.entries.length, entries);
  assert.ok(!world.items.some((i) => i.lotId === '∅'));
  assert.equal(world.warehouseUnknown('P1'), 10);
  // وnull الصريح يبقى طريق غير المسمّى، وغير المتتبَّع يتجاهل الحقل كما كان
  assert.equal((await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -3, lotId: null }] })).status, 201);
  assert.equal(world.warehouseUnknown('P1'), 7);
  const plain = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -1, lotId: '∅' }] });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(lastItems()[0].lotId, null);
});

test('التسوية بالزيادة: لوط، أو رقمٌ جديد بمصدر MANUAL، أو null صريح؛ وزيادةٌ في الحركة نفسها لا تغطّي نقصها', async () => {
  fresh();
  const A = stock('P1', 'A', 5);
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: 2, lotId: A }, { productId: 'P1', qty: 3, lotNumber: 'N-1' }, { productId: 'P1', qty: 1, lotId: null }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(lotOf('N-1').source, 'MANUAL');
  assert.deepEqual(lastItems().map((i) => i.lotId), [A, lotOf('N-1').id, null]);
  // الصالح ٧: +١٠ و−٨ في حركةٍ واحدة يُفحص النقص على الرصيد قبلها (لا يُصرف ما لم يُسجَّل بعد)
  const mixed = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: 10, lotId: A }, { productId: 'P1', qty: -8, lotId: A }] });
  assert.equal(mixed.status, 409);
  assert.equal(world.warehouseRaw(A), 7);
});

test('ترتيب الأقفال: الطابور ثم المعاملة بمهلة {10s, 20s}، وFOR KEY SHARE ثم lock_timeout ثم القفل الاستشاري قبل أول قراءة رصيد وأول إنشاء', async () => {
  fresh();
  stock('P1', 'A', 10);
  world.calls.length = 0;
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -2, lotNumber: 'A' }, { productId: 'P3', qty: -1 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(world.txOpts.at(-1), { maxWait: 10_000, timeout: 20_000 });
  const ops = world.calls.map((c) => c.sql ?? c.op);
  const at = (pred: (s: string) => boolean) => ops.findIndex(pred);
  const begin = at((s) => s === 'tx.begin');
  const share = at((s) => s.includes('FOR KEY SHARE'));
  const timeout = at((s) => s.includes("set_config('lock_timeout'"));
  const lock = at((s) => s.includes('pg_advisory_xact_lock'));
  const firstRead = at((s) => s.includes('FROM warehouse_entry_items') || s.includes('FROM van_load_item_lots') || s.includes('FROM lot_relabels') || s === 'productLot.findMany');
  const create = at((s) => s === 'warehouseEntry.create');
  assert.ok(begin >= 0 && begin < share && share < timeout && timeout < lock && lock < firstRead && firstRead < create, ops.join('\n'));
  // P3 غير متتبَّع: قفلٌ استشاري واحد (لـP1 وحده)
  assert.equal(world.calls.filter((c) => c.sql?.includes('pg_advisory_xact_lock')).length, 1);
});

test('الانشغال: انتظار القفل (55P03) ⇒ 503 LOT_BUSY ولا كتابة، والطابور يُحرَّر فتمرّ المحاولة التالية', async () => {
  fresh();
  world.failOn = (sql) => (sql.includes('pg_advisory_xact_lock') ? Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }) : null);
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 1, lotNumber: 'A' }] });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, 'LOT_BUSY');
  assert.equal(world.entries.length, 0);
  world.failOn = null;
  assert.equal((await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 1, lotNumber: 'A' }] })).status, 201);
});

// ═══ ما لا يتغيّر (§١٠) ═══

test('غير المتتبَّع والميزة مفعّلة: إنشاءٌ واحد بلا قفل لوط ولا طابور، وlotId فارغ — بعد إعادة قراءة التتبّع وحدها (D25)', async () => {
  fresh();
  world.calls.length = 0;
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -50, lotId: 'ignored' }] });
  assert.equal(r.status, 201, 'المستودع السالب جائزٌ لغير المتتبَّع كما كان');
  // D25 (البوابة B-d25-guards، lots-d25-warehouse.test.ts): FOR KEY SHARE على الأصناف في معاملة الإنشاء، لا غير
  assert.deepEqual(world.calls.map((c) => c.op), ['product.findMany', 'tx.begin', 'query', 'warehouseEntry.create', 'tx.commit']);
  assert.equal(lastItems()[0].lotId, null);
});

test('الميزة مطفأة: الصنف «المتتبَّع» كغيره حرفياً — بلا معاملة ولا قفل، وأعمدة التشغيلة تُتجاهل، والـinclude بلا lot', async () => {
  fresh();
  world.lotsEnabled = false;
  world.calls.length = 0;
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 3, lotNumber: 'A', expiryDate: '2027-01-01' }] });
  assert.equal(r.status, 201);
  assert.deepEqual(world.calls.map((c) => c.op), ['product.findMany', 'warehouseEntry.create']);
  const create = world.calls[1].args as Row;
  assert.deepEqual(Object.keys(create.include.items.include), ['product'], 'الردّ كما كان');
  assert.ok(!('lotId' in (create.data.items.create[0] as Row)), 'البند كما كان بلا عمود lotId');
  assert.equal(world.lots.length, 0);
  assert.equal(r.body.data.items[0].lot, undefined);
});

test('GET /entries: البند يحمل lot والميزة مفعّلة، ولا يحمله مطفأة', async () => {
  fresh();
  await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 3, lotNumber: 'A' }] });
  const on = await call('get', '/entries');
  assert.equal(on.status, 200);
  assert.equal(on.body.data[0].items[0].lot.lotNumber, 'A');
  world.lotsEnabled = false;
  const off = await call('get', '/entries');
  assert.equal(off.body.data[0].items[0].lot, undefined);
});

test('GET /vans: المعزول (موقوف + منتهٍ لم يُبع) والمحجوز (D24) لكل صنفٍ متتبَّع والميزة مفعّلة، ولا مفاتيح لها مطفأة', async () => {
  fresh();
  world.reps = ['R1'];
  const A = world.lot({ id: 'LA', productId: 'P1', lotNumber: 'A' }).id;
  const B = world.lot({ id: 'LB', productId: 'P1', lotNumber: 'B', status: 'BLOCKED', blockKind: 'HOLD', blockedAt: new Date() }).id;
  const C = world.lot({ id: 'LC', productId: 'P1', lotNumber: 'C', expiryDate: dateOf('2020-01-01') }).id;
  world.vanMove('LOAD', 'R1', 'P1', 10, A);
  world.vanMove('LOAD', 'R1', 'P1', 4, B);
  world.vanMove('LOAD', 'R1', 'P1', 3, C);
  // مرتجع إشعارٍ قياسي «01» بانتظار الاعتماد: عائدٌ للمخزون إلى A ومحجوز
  const held = { productId: 'P1', vanKey: 'R1', type: 'RETURN', returnToStock: true, returnExpired: null, damaged: false, held: true, qty: 2, firstAt: null };
  world.invAgg.push({ ...held, lotId: null, src: 'TOT' }, { ...held, lotId: A, src: 'LOT' });
  const on = await call('get', '/vans');
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.data.lotQuarantined, 7);
  assert.equal(on.body.data.lotHeld, 2);
  assert.deepEqual(on.body.data.lotProducts, [{ productId: 'P1', lotQuarantined: 7, lotHeld: 2 }]);
  world.lotsEnabled = false;
  const off = await call('get', '/vans');
  assert.equal(off.status, 200);
  assert.ok(!('lotQuarantined' in off.body.data) && !('lotProducts' in off.body.data));
});

test('الفاعل: جلسة «دخول» المالك أو الموظف تُسجَّل بمُصدِرها، والمفتاح بمعرّفه — لا باسم المدير', () => {
  assert.deepEqual(lotsW.lotEventActorOf({ id: 'a1', name: 'مدير', impersonated: true, by: 'o1', byKind: 'OWNER' }), { type: 'OWNER', id: 'o1', name: 'الدعم الفني' });
  assert.deepEqual(lotsW.lotEventActorOf({ id: 'a1', name: 'مدير', impersonated: true, by: 's1', byKind: 'STAFF' }), { type: 'STAFF', id: 's1', name: 'موظف المنصة' });
  assert.deepEqual(lotsW.lotEventActorOf({ id: 'a1', name: 'مدير', apiKeyId: 'k1' }), { type: 'API_KEY', id: 'k1', name: 'مدير' });
  assert.equal(lotsW.lotActorOf({ id: 'a1', apiKeyId: 'k1' }), 'API_KEY');
  assert.equal(lotsW.lotActorOf({ id: 'a1', role: 'ADMIN' }), 'ADMIN');
});

// ═══ خاصيةٌ عشوائية: لا تسلسل يُنتج صالحاً سالباً (I1) ولا غير مسمّى دون min(0, قبله) (I2) ═══

/** مولّد أرقام شبه عشوائية ثابت البذرة (mulberry32) — فشلٌ يُعاد بالبذرة نفسها */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('خاصية: تسلسلات عشوائية من الوارد والتسوية ± والتحميل بوحدتين — الخام = النموذج، ولا صالح مسمّى سالب، ولا غير مسمّى دون min(0, قبله)', async () => {
  for (const seed of [1, 7, 42, 2026]) {
    fresh();
    const rand = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    const model = new Map<string, number>();   // لوط ⇒ خامه المتوقَّع في المستودع
    let accepted = 0;
    let rejected = 0;
    for (let step = 0; step < 120; step++) {
      const unknownBefore = world.warehouseUnknown('P1');
      const itemsBefore = world.items.length;
      const op = pick(['RECEIVE', 'ADJUST+', 'ADJUST-', 'ADJUST-', 'LOAD']);
      const unit = pick([null, 'U-CT', 'U-6']);
      const F = unit === 'U-CT' ? 24 : unit === 'U-6' ? 6 : 1;
      const qty = pick([1, 2, 3, 0.5, 0.25, 1.5, 0.12345]);
      const base = Math.round(qty * F * 1e6) / 1e6;
      const nums = ['A', 'B', 'C'];
      if (op === 'LOAD') {
        // تحميلٌ صحيح من B4 (خارج هذه الحزمة) يُنقص لوطاً بقدر خامه وحده — ليتحرّك الطيّ بـviaWarehouse
        const l = world.lots.find((x) => x.lotNumber === pick(nums));
        const raw = l ? world.warehouseRaw(l.id) : 0;
        if (l && raw >= 1) { world.vanMove('LOAD', 'R1', 'P1', 1, l.id); model.set(l.id, (model.get(l.id) ?? 0) - 1); }
        continue;
      }
      const lotSpec = pick(['num', 'num', 'null', 'none', 'id']);
      const num = pick(nums);
      const existing = world.lots.find((x) => x.lotNumber === num);
      const ref: Row = lotSpec === 'num' ? { lotNumber: num } : lotSpec === 'null' ? { lotId: null } : lotSpec === 'id' && existing ? { lotId: existing.id } : {};
      const signed = op === 'ADJUST-' ? -qty : qty;
      const r = await post({ type: op === 'RECEIVE' ? 'RECEIVE' : 'ADJUST', items: [{ productId: 'P1', qty: signed, ...(unit && { unitId: unit }), ...ref }] });
      if (r.status === 201) {
        accepted++;
        const it = lastItems()[0];
        if (it.lotId) model.set(it.lotId, (model.get(it.lotId) ?? 0) + it.baseQty!);
        assert.equal(it.baseQty, op === 'ADJUST-' ? -base : base, `seed ${seed} step ${step}: الأساس`);
      } else {
        rejected++;
        assert.ok([409, 422].includes(r.status), `seed ${seed} step ${step}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(world.items.length, itemsBefore, 'الرفض لا يكتب شيئاً');
      }
      for (const l of world.lots) {
        const raw = world.warehouseRaw(l.id);
        assert.ok(Math.abs(raw - Math.round((model.get(l.id) ?? 0) * 1e4) / 1e4) < 1e-6, `seed ${seed} step ${step}: خام ${l.lotNumber} ${raw} ≠ النموذج`);
        assert.ok(raw > -1e-9, `seed ${seed} step ${step}: خام ${l.lotNumber} سالب ${raw}`);
      }
      const unknownAfter = world.warehouseUnknown('P1');
      if (op === 'ADJUST-') assert.ok(unknownAfter >= Math.min(0, unknownBefore) - 1e-9, `seed ${seed} step ${step}: غير المسمّى ${unknownBefore} ⇒ ${unknownAfter}`);
    }
    assert.ok(accepted > 20 && rejected > 5, `seed ${seed}: تغطية (${accepted} مقبول، ${rejected} مرفوض)`);
  }
});
