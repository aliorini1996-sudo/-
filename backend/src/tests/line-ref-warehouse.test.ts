// «مرجع السطر» (lineRef) في حركات المستودع: الموجّه الحقيقي routes/warehouse.ts فوق القاعدة المزيّفة lots-b3-fake.ts (نمط
// lots-warehouse.test.ts). شكوى المُكامِل: مشاكل اللوط على مستوى السطر — فسطرُ نقصٍ يقسمه الخادم على عدّة تشغيلات كان يعود بنوداً
// لا يعرف أيّها من أيّ سطرٍ أرسله. ما يُحرس تشغيلاً:
//   • السطر العادي يحفظ مرجعه (بعد القصّ) على بنده ويعود به في ردّ 201 وفي GET /entries.
//   • سطر النقص التلقائي المقسوم على تشغيلات (splitByLine): كلُّ بندٍ ناتجٍ منه يحمل المرجع نفسه، ومجموعها أساس السطر.
//   • الفارغ أو المسافات أو null ⇒ null (والبند بلا مفتاح lineRef كما كان)، وفوق ١٠٠ بعد القصّ ⇒ 400 بلا حركة.
//   • الشركة المطفأة (أو الصنف غير المتتبَّع) كما كانت حرفياً: المرجع يُحفظ ولا يتغيّر تسلسل النداءات ولا الـinclude.
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
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

// القاعدة المزيّفة لا تعرف العمود الجديد: تُكمَل هنا كما تفعل Prisma — يُحفظ ما كُتب على البند وغيابه null، ويعود في الردّ والقراءة
const origCreate = db.warehouseEntry.create as (a: Row) => Promise<Row>;
db.warehouseEntry.create = async (a: Row) => {
  const out = await origCreate(a);
  const created = a.data.items.create as Row[];
  const rows = world.items.slice(-created.length) as Row[];
  rows.forEach((it, k) => { it.lineRef = created[k].lineRef ?? null; });
  (out.items as Row[] | undefined)?.forEach((it, k) => { it.lineRef = created[k].lineRef ?? null; });
  return out;
};

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }

/** يشغّل وسائط الموجّه (عدا المصادقة) ثم المسار ثم معالج أخطائه ثم معالج التطبيق العام (ZodError ⇒ 400) — كما يمشيها Express */
async function call(method: string, p: string, req: Row = {}): Promise<{ status: number; body: Row }> {
  const stack = (router as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === p && l.route.methods[method]);
  assert.ok(layer, `${method} ${p} مفقود`);
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const errHandlers = [...stack.filter((l) => !l.route && l.handle.length === 4).map((l) => l.handle), errorHandler];
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
    return { status: 500, body: { message: (err as Error)?.message } };
  }
  return { status: res.statusCode, body: res.body };
}

/** عالمٌ جديد: P1 متتبَّع بكرتون ٢٤، وP3 غير متتبَّع */
function fresh(): void {
  Object.assign(world, new World());
  world.product({ id: 'P1', name: 'ماء' });
  world.product({ id: 'P3', name: 'سكر' });
  world.unit({ id: 'U-CT', productId: 'P1', name: 'كرتون', factor: 24 });
  world.track('P1');
}
const post = (body: Row) => call('post', '/entries', { body });
const lastItems = () => world.items.filter((i) => i.entryId === world.entries[world.entries.length - 1].id) as (Row & { lineRef?: string | null })[];
const lastCreate = () => (world.calls.filter((c) => c.op === 'warehouseEntry.create').at(-1)!.args as Row).data.items.create as Row[];
/** رصيدٌ مسمّى في المستودع: وارد بلوطه */
function stock(lotNumber: string, qty: number, extra: Row = {}): string {
  const l = world.lot({ id: `L-${lotNumber}`, productId: 'P1', lotNumber, ...extra });
  world.entry('RECEIVE', [{ productId: 'P1', qty, lotId: l.id }]);
  return l.id;
}

test('السطر العادي: المرجع (بعد القصّ) على بند كل سطر — متتبَّعاً وغير متتبَّع — ويعود في ردّ 201 وفي GET /entries', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', items: [
    { productId: 'P1', qty: 2, unitId: 'U-CT', lotNumber: 'A', lineRef: '  ERP-10  ' },
    { productId: 'P3', qty: 5, lineRef: 'ERP-11' },
    { productId: 'P3', qty: 1 },
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(lastCreate().map((i) => i.lineRef), ['ERP-10', 'ERP-11', undefined], 'المحفوظ مقصوص، والغائب بلا مفتاح');
  assert.deepEqual(lastItems().map((i) => [i.productId, i.baseQty, i.lineRef]), [['P1', 48, 'ERP-10'], ['P3', 5, 'ERP-11'], ['P3', 1, null]]);
  assert.deepEqual((r.body.data.items as Row[]).map((i) => i.lineRef), ['ERP-10', 'ERP-11', null], 'ردّ الإنشاء');
  assert.equal(r.body.data.items[0].lot.lotNumber, 'A', 'وبطاقة التشغيلة كما كانت');
  const g = await call('get', '/entries');
  assert.equal(g.status, 200);
  const e = (g.body.data as Row[]).find((x) => x.id === r.body.data.id)!;
  assert.deepEqual((e.items as Row[]).map((i) => i.lineRef), ['ERP-10', 'ERP-11', null], 'سجلّ الحركات');
});

test('سطر نقصٍ تلقائي مقسوم على تشغيلتين (splitByLine): كلُّ بندٍ ناتجٍ منه يحمل مرجع سطره نفسه، والسطر الصريح بجانبه بمرجعه', async () => {
  fresh();
  const A = stock('A', 10);
  const B = stock('B', 4, { expiryDate: dateOf('2027-01-01') });   // تنتهي قبل A ⇒ النقص منها أولاً
  const r = await post({ type: 'ADJUST', items: [
    { productId: 'P1', qty: -6, lineRef: 'ADJ-1' },
    { productId: 'P1', qty: -1, lotId: A, lineRef: 'ADJ-2' },
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // ٦ من B (٤) ثم A (٢): بندان من السطر الأول بمرجعه، ثم السطر الصريح
  assert.deepEqual(lastItems().map((i) => [i.lotId, i.baseQty, i.lineRef]), [[B, -4, 'ADJ-1'], [A, -2, 'ADJ-1'], [A, -1, 'ADJ-2']]);
  assert.deepEqual(lastCreate().map((i) => i.lineRef), ['ADJ-1', 'ADJ-1', 'ADJ-2']);
  const out = r.body.data.items as Row[];
  assert.deepEqual(out.map((i) => [i.lineRef, i.lot?.lotNumber]), [['ADJ-1', 'B'], ['ADJ-1', 'A'], ['ADJ-2', 'A']], 'ردّ الإنشاء يجمع البندين إلى سطرهما');
  // المُكامِل يجمع بنود المرجع الواحد فيعود أساس سطره كاملاً
  assert.equal(out.filter((i) => i.lineRef === 'ADJ-1').reduce((s, i) => s + (i.baseQty as number), 0), -6);
  const g = await call('get', '/entries');
  const e = (g.body.data as Row[]).find((x) => x.id === r.body.data.id)!;
  assert.deepEqual((e.items as Row[]).map((i) => i.lineRef), ['ADJ-1', 'ADJ-1', 'ADJ-2']);
});

test('سطرٌ بالكرتون مقسوم (بندٌ بوحدة السطر وبندٌ بالأساس): المرجع على البندين معاً، وبلا مرجع لا مفتاح على أيٍّ من البنود', async () => {
  fresh();
  const A = stock('A', 40);
  const B = stock('B', 24, { expiryDate: dateOf('2027-01-01') });
  // كرتونٌ ونصف (٣٦): كرتونٌ كامل من B ثم ١٢ حبة من A
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -1.5, unitId: 'U-CT', lineRef: 'CT-9' }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(lastItems().map((i) => [i.lotId, i.qty, i.unitFactor, i.baseQty, i.lineRef]), [[B, -1, 24, -24, 'CT-9'], [A, -12, 1, -12, 'CT-9']]);
  const plain = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -1, unitId: 'U-CT' }] });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual(lastItems().map((i) => [i.lotId, i.baseQty]), [[A, -24]]);
  // بلا مرجع: البند كما كان بلا عمود lineRef
  assert.ok(lastCreate().every((i) => !('lineRef' in i)), JSON.stringify(lastCreate()));
  assert.deepEqual((plain.body.data.items as Row[]).map((i) => i.lineRef), [null]);
  // وسطرٌ مقسوم بلا مرجع: لا مفتاح على أيٍّ من بنوده
  const C = stock('C', 10, { expiryDate: dateOf('2027-02-01') });
  const split = await post({ type: 'ADJUST', items: [{ productId: 'P1', qty: -12 }] });
  assert.equal(split.status, 201, JSON.stringify(split.body));
  assert.deepEqual(lastItems().map((i) => [i.lotId, i.baseQty, i.lineRef]), [[C, -10, null], [A, -2, null]]);
  assert.ok(lastCreate().length === 2 && lastCreate().every((i) => !('lineRef' in i)), JSON.stringify(lastCreate()));
});

test('الفارغ والمسافات وnull ⇒ null (بلا مفتاح على البند)، و١٠٠ بعد القصّ مقبول، وفوقه ⇒ 400 بلا حركة', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', items: [
    { productId: 'P3', qty: 1, lineRef: '' }, { productId: 'P3', qty: 2, lineRef: '    ' }, { productId: 'P3', qty: 3, lineRef: null },
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(lastCreate().every((i) => !('lineRef' in i)), JSON.stringify(lastCreate()));
  assert.deepEqual(lastItems().map((i) => i.lineRef), [null, null, null]);
  assert.deepEqual((r.body.data.items as Row[]).map((i) => i.lineRef), [null, null, null]);

  const max = 'x'.repeat(100);
  const ok = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1, lineRef: `  ${max}  ` }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(lastItems()[0].lineRef, max, 'الحدّ على ما بعد القصّ');

  const n = world.entries.length;
  const items = world.items.length;
  const over = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1, lineRef: 'ok' }, { productId: 'P3', qty: 1, lineRef: `${max}y` }] });
  assert.equal(over.status, 400, JSON.stringify(over.body));
  assert.equal(over.body.success, false);
  assert.deepEqual([world.entries.length, world.items.length], [n, items], 'لا حركة ولا بند');
  // ونوعٌ غير النصّ ⇒ 400 كذلك (لا تحويلٌ صامت)
  assert.equal((await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1, lineRef: 12 }] })).status, 400);
  assert.equal(world.entries.length, n);
});

test('الشركة المطفأة: المرجع يُحفظ ويعود، وتسلسل النداءات والـinclude وبند بلا lotId كما كانت حرفياً', async () => {
  fresh();
  world.lotsEnabled = false;
  world.calls.length = 0;
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P1', qty: 3, lotNumber: 'A', lineRef: 'OFF-1' }, { productId: 'P3', qty: 2 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(world.calls.map((c) => c.op), ['product.findMany', 'tx.begin', 'query', 'exec', 'query', 'exec', 'warehouseEntry.create', 'tx.commit']);
  const create = world.calls.find((c) => c.op === 'warehouseEntry.create')!.args as Row;
  assert.deepEqual(Object.keys(create.include.items.include), ['product'], 'الردّ كما كان بلا lot');
  const rows = create.data.items.create as Row[];
  assert.ok(rows.every((i) => !('lotId' in i)), 'البند بلا عمود lotId');
  assert.deepEqual(rows.map((i) => i.lineRef), ['OFF-1', undefined]);
  assert.deepEqual((r.body.data.items as Row[]).map((i) => [i.lineRef, i.lot]), [['OFF-1', undefined], [null, undefined]]);
  assert.equal(world.lots.length, 0);
  const g = await call('get', '/entries');
  assert.deepEqual(((g.body.data as Row[])[0].items as Row[]).map((i) => [i.lineRef, i.lot]), [['OFF-1', undefined], [null, undefined]]);
});

test('الصنف غير المتتبَّع والميزة مفعّلة: المرجع يُحفظ والمسار كما هو (إعادة قراءة التتبّع وحدها، بلا طابور ولا قفل لوط)', async () => {
  fresh();
  world.calls.length = 0;
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -4, lineRef: 'U-1' }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const seq = world.calls.map((c) => c.op);
  assert.deepEqual([seq.slice(0, 2), seq.slice(-2)], [['product.findMany', 'tx.begin'], ['warehouseEntry.create', 'tx.commit']], seq.join(' '));
  assert.ok(!world.calls.some((c) => c.op === 'exec' && String(c.sql ?? '').includes('pg_advisory_xact_lock')), 'لا قفل لوط');
  assert.deepEqual(lastItems().map((i) => [i.lotId, i.baseQty, i.lineRef]), [[null, -4, 'U-1']]);
  assert.equal(r.body.data.items[0].lineRef, 'U-1');
});
