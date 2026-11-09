// مراجعة المخزون — حركات المستودع (POST /warehouse/entries) فوق القاعدة المزيّفة lots-b3-fake.ts (نمط line-ref-warehouse.test.ts):
//  · D8: clientRef — يُحفظ، والمكرَّر يردّ الحركة القائمة 200 (replay: true) بلا كتابة ولو تزامن مع أصله (القفل في المعاملة يجده)،
//    ومرجعٌ لحركةٍ من نوعٍ آخر 409 CLIENT_REF_REUSED، ولكل شركة مستقلّ، وGET /entries?clientRef=.
//  · D3 («الربط لا يُرفض» ٩ نوفمبر ٢٠٢٦): الوارد RECEIVE لصنفٍ مؤرشف يُنقل إلى توأمه الحيّ بالرمز نفسه أو يُقبل عليه بتحذير، والتسوية تمرّ.
//  · #23: صنفٌ لا يتبع الشركة يُترك سطره بتحذير PRODUCT_NOT_FOUND بموضعه، والوارد السالب تسوية إنقاص، والوحدة الغريبة بلا رفض.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { World, type Row } from './lots-b3-fake';

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

// القاعدة المزيّفة لا تعرف العمود الجديد: تُكمَل هنا كما تفعل Prisma — clientRef والشركة على رأس الحركة، والبحث بهما
const refOf = new Map<string, string | null>();
let hidePrior = 0;
const origCreate = db.warehouseEntry.create as (a: Row) => Promise<Row>;
db.warehouseEntry.create = async (a: Row) => {
  const out = await origCreate(a);
  const e = world.entries.at(-1)!;
  e.tenantId = a.data.tenantId;
  refOf.set(e.id, a.data.clientRef ?? null);
  return { ...out, tenantId: e.tenantId, clientRef: a.data.clientRef ?? null };
};
const origFindMany = db.warehouseEntry.findMany as (a: Row) => Promise<Row[]>;
db.warehouseEntry.findMany = async (a: Row) => (await origFindMany(a)).filter((e) => a.where.clientRef === undefined || refOf.get(e.id as string) === a.where.clientRef);
db.warehouseEntry.findFirst = async (a: Row) => {
  world.calls.push({ op: 'warehouseEntry.findFirst', args: a });
  // محاكاة طلبٍ تزامن مع أصله: البحث الأول (خارج المعاملة) لا يراه
  if (hidePrior > 0) { hidePrior--; return null; }
  const e = world.entries.find((x) => x.tenantId === a.where.tenantId && refOf.get(x.id) === a.where.clientRef);
  if (!e) return null;
  return { ...e, clientRef: refOf.get(e.id), items: world.items.filter((i) => i.entryId === e.id).map((i) => ({ ...i, product: { id: i.productId, name: i.productId, unit: 'حبة', primaryUnitId: null } })) };
};

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }

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

/** عالمٌ جديد: P3 غير متتبَّع، وOLD مؤرشف بقي له رصيد، وQ1 لشركةٍ أخرى — والميزة مطفأة (المسار القائم) */
function fresh(): void {
  Object.assign(world, new World());
  world.lotsEnabled = false;
  world.product({ id: 'P3', name: 'سكر' });
  world.product({ id: 'OLD', name: 'كرتون بيض M', status: 'INACTIVE', deletedAt: new Date('2026-10-01T00:00:00Z') });
  world.product({ id: 'Q1', name: 'سكر', tenantId: 't2' });
  refOf.clear();
  hidePrior = 0;
}
const post = (body: Row, user: Row = ADMIN) => call('post', '/entries', { body, user });
const creates = () => world.calls.filter((c) => c.op === 'warehouseEntry.create').length;

test('D8: المرجع يُحفظ، والمكرَّر 200 بالحركة نفسها (replay) بلا كتابة ولا حكمٍ جديد، وGET ?clientRef= يجدها', async () => {
  fresh();
  const first = await post({ type: 'RECEIVE', clientRef: 'po-2026-114', items: [{ productId: 'P3', qty: 50, unitCost: 3 }] });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const id = first.body.data.id as string;
  assert.equal(refOf.get(id), 'po-2026-114');
  // الإعادة بعد ضياع الردّ — ولو أُرشف الصنف بعدها: الحركة القائمة لا 422
  world.products.find((p) => p.id === 'P3')!.deletedAt = new Date();
  const again = await post({ type: 'RECEIVE', clientRef: 'po-2026-114', items: [{ productId: 'P3', qty: 50, unitCost: 3 }] });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replay, true);
  assert.equal(again.body.data.id, id);
  assert.deepEqual((again.body.data.items as Row[]).map((i) => [i.productId, i.qty]), [['P3', 50]]);
  assert.equal(creates(), 1, 'لا كتابة ثانية');
  assert.equal(world.entries.length, 1);
  const g = await call('get', '/entries', { query: { clientRef: 'po-2026-114' } });
  assert.deepEqual((g.body.data as Row[]).map((e) => e.id), [id]);
  assert.deepEqual((await call('get', '/entries', { query: { clientRef: 'other' } })).body.data, []);
  assert.equal(((await call('get', '/entries', { query: { clientRef: { in: ['x'] } } })).body.data as Row[]).length, 1, 'كائن qs يُهمل');
  assert.equal((await post({ type: 'RECEIVE', clientRef: 'مرجع', items: [{ productId: 'P3', qty: 1 }] })).status, 400, 'مرجعٌ غير لاتيني 400');
});

test('D8: طلبٌ مكرَّر تزامن مع أصله (لم يره البحث الأول) — قفل المرجع في المعاملة يجده فيُردّ 200 وتُجهَض المعاملة بلا كتابة', async () => {
  fresh();
  assert.equal((await post({ type: 'ADJUST', clientRef: 'adj-1', items: [{ productId: 'P3', qty: -2 }] })).status, 201);
  hidePrior = 1;
  world.calls = [];
  const again = await post({ type: 'ADJUST', clientRef: 'adj-1', items: [{ productId: 'P3', qty: -2 }] });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replay, true);
  assert.equal(creates(), 0);
  const ops = world.calls.map((c) => (c.op === 'exec' ? `exec:${String(c.values?.[0]).split(':')[0]}` : c.op));
  assert.ok(ops.indexOf('exec:warehouse-entry-ref') >= 0 && ops.indexOf('exec:warehouse-entry-ref') < ops.lastIndexOf('warehouseEntry.findFirst'), `القفل قبل البحث الثاني: ${ops.join(' ')}`);
  assert.ok(ops.includes('tx.rollback'));
});

test('D8: مرجعٌ لحركةٍ من نوعٍ آخر 409 CLIENT_REF_REUSED، والمرجع نفسه لشركةٍ أخرى حركةٌ مستقلّة', async () => {
  fresh();
  assert.equal((await post({ type: 'RECEIVE', clientRef: 'dup', items: [{ productId: 'P3', qty: 5 }] })).status, 201);
  const r = await post({ type: 'ADJUST', clientRef: 'dup', items: [{ productId: 'P3', qty: 1 }] });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CLIENT_REF_REUSED');
  const other = await post({ type: 'RECEIVE', clientRef: 'dup', items: [{ productId: 'Q1', qty: 5 }] }, { ...ADMIN, tenantId: 't2' });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  assert.equal(world.entries.length, 2);
});

/** بنود حركةٍ مكتوبة: [الصنف، الكمية، المعامل، الأساس، التكلفة] */
const itemsOf = (entryId: string) => world.items.filter((i) => i.entryId === entryId).map((i) => [i.productId, i.qty, i.unitFactor, i.baseQty, i.unitCost]);
const codes = (r: { body: Row }) => ((r.body.warnings ?? []) as Row[]).map((w) => [w.code, w.index, w.productId]);

// «الربط لا يُرفض» (أمر المالك ٩ نوفمبر ٢٠٢٦): D3 و#23 صارا تحذيرين في ردّ النجاح — الحركة تُكتب بما يمكن معالجته
test('D3 (لا يُرفض): الوارد لصنفٍ مؤرشف بلا توأم حيّ يُقبل عليه بتحذير PRODUCT_ARCHIVED بموضعه، والتسوية عليه تمرّ بلا تحذير', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }, { productId: 'OLD', qty: 3 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(codes(r), [['PRODUCT_ARCHIVED', 1, 'OLD']]);
  assert.match(String((r.body.warnings as Row[])[0].message), /«كرتون بيض M» محذوف/);
  assert.deepEqual(itemsOf(r.body.data.id), [['P3', 1, 1, 1, null], ['OLD', 3, 1, 3, null]]);
  const adj = await post({ type: 'ADJUST', items: [{ productId: 'OLD', qty: 25 }] });
  assert.equal(adj.status, 201, JSON.stringify(adj.body));
  assert.equal(adj.body.warnings, undefined, 'التسوية على المؤرشف كما كانت');
});

test('D3 (لا يُرفض): صنفٌ حيّ واحد برمز المؤرشف (بلا اعتبار لحالة الأحرف) ⇒ يُسجَّل السطر عليه بتحذير PRODUCT_REDIRECTED', async () => {
  fresh();
  world.product({ id: 'NEW', name: 'كرتون بيض M جديد', code: 'old' });
  const r = await post({ type: 'RECEIVE', clientRef: 'po-old', items: [{ productId: 'OLD', qty: 4, unitCost: 2 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(codes(r), [['PRODUCT_REDIRECTED', 0, 'OLD']]);
  assert.equal((r.body.warnings as Row[])[0].toProductId, 'NEW');
  assert.deepEqual(itemsOf(r.body.data.id), [['NEW', 4, 1, 4, 2]]);
  // توأمان حيّان بالرمز نفسه ⇒ لا تخمين: يُقبل على المؤرشف
  world.product({ id: 'NEW2', name: 'نسخة', code: 'Old' });
  const two = await post({ type: 'RECEIVE', items: [{ productId: 'OLD', qty: 1 }] });
  assert.deepEqual([two.status, codes(two)], [201, [['PRODUCT_ARCHIVED', 0, 'OLD']]]);
  assert.deepEqual(itemsOf(two.body.data.id), [['OLD', 1, 1, 1, null]]);
});

test('#23 (لا يُرفض، أمر المالك ٩ نوفمبر): صنفٌ ليس في الشركة ⇒ صنفٌ مؤقّت بمعرّفه نفسه؛ ومعرّف صنف شركةٍ أخرى أو معرّفٌ لا يصلح يُترك سطره، وكلها متروكة أو صفرية ⇒ 200 بلا حركة', async () => {
  // الاستيراد بعد التبديلات (stub) لا في رأس الملف — وإلا حُمّلت الوحدة قبل بدائلها
  const { stockLenientFlags } = require('../services/stockLenient') as typeof import('../services/stockLenient');
  stockLenientFlags.placeholdersOn = true; // سلوك الصنف المؤقّت (مطفأ افتراضاً منذ ٩ نوفمبر ٢٠٢٦) — يُختبر مفعّلاً
  try {
  fresh();
  // الموضع من items كما أرسلها العميل: السطر الصفري لا يزيحه
  const nf = await post({ type: 'RECEIVE', items: [
    { productId: 'P3', qty: 0 }, { productId: 'P3', qty: 1 }, { productId: 'Q1', qty: 1 },
    { productId: 'erp-9f2c41aa77', qty: 6, unitCost: 3, baseUnitName: ' علبة ' },
  ] });
  assert.equal(nf.status, 201, JSON.stringify(nf.body));
  assert.deepEqual(codes(nf), [['PRODUCT_NOT_FOUND', 2, 'Q1'], ['PRODUCT_PLACEHOLDER_CREATED', 3, 'erp-9f2c41aa77']]);
  assert.deepEqual(itemsOf(nf.body.data.id), [['P3', 1, 1, 1, null], ['erp-9f2c41aa77', 6, 1, 6, 3]]);
  const ph = world.products.find((p) => p.id === 'erp-9f2c41aa77')! as unknown as Row;
  assert.deepEqual([ph.tenantId, ph.code, ph.name, ph.unit, ph.status, ph.basePrice, ph.taxPct, ph.deletedAt], ['t1', 'P-ERP-9F2C', 'صنف P-ERP-9F2C', 'علبة', 'ACTIVE', 0, 15, null]);
  assert.equal(world.products.find((p) => p.id === 'Q1')!.tenantId, 't2', 'عزل الشركات: صنف الشركة الأخرى لا يُمسّ ولا يُنشأ بمعرّفه');
  // إعادة الإرسال تجد الصنف: لا صنف ثانٍ ولا تحذير إنشاء
  const again = await post({ type: 'RECEIVE', items: [{ productId: 'erp-9f2c41aa77', qty: 1 }] });
  assert.deepEqual([again.status, codes(again)], [201, []]);
  assert.equal(world.products.filter((p) => p.id === 'erp-9f2c41aa77').length, 1);
  // الرمز فريدٌ في الشركة: المحجوز ⇒ بذيل
  world.product({ id: 'C1', code: 'P-ERP-AAAA' });
  const clash = await post({ type: 'ADJUST', items: [{ productId: 'erp-aaaa-1', qty: -2 }] });
  assert.deepEqual([clash.status, codes(clash)], [201, [['PRODUCT_PLACEHOLDER_CREATED', 0, 'erp-aaaa-1']]]);
  assert.deepEqual([world.products.find((p) => p.id === 'erp-aaaa-1')!.code, world.products.find((p) => p.id === 'erp-aaaa-1')!.unit], ['P-ERP-AAAA-2', 'حبة']);
  const n = world.entries.length;
  const none = await post({ type: 'RECEIVE', clientRef: 'po-none', items: [{ productId: 'Q1', qty: 1 }, { productId: 'رمز عربي', qty: 2 }] });
  assert.equal(none.status, 200, JSON.stringify(none.body));
  assert.deepEqual([none.body.success, none.body.data, none.body.noop], [true, null, true]);
  assert.deepEqual(codes(none), [['PRODUCT_NOT_FOUND', 0, 'Q1'], ['PRODUCT_NOT_FOUND', 1, 'رمز عربي']]);
  const zero = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: 0 }] });
  assert.equal(zero.status, 200, JSON.stringify(zero.body));
  assert.deepEqual([zero.body.data, zero.body.noop, codes(zero)], [null, true, [['NO_QUANTITIES', undefined, undefined]]]);
  assert.match(String((zero.body.warnings as Row[])[0].message), /لا توجد كميات صالحة/);
  assert.equal(world.entries.length, n, 'لا حركة للطلبين الأخيرين');
  assert.equal(world.products.some((p) => p.id === 'رمز عربي'), false);
  } finally { stockLenientFlags.placeholdersOn = false; }
});

test('التسوية بسعر: يُهمل السعر بتحذير UNIT_COST_IGNORED (كان 400) وتُكتب التسوية بلا تكلفة', async () => {
  fresh();
  const r = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -2, unitCost: 5 }, { productId: 'P3', qty: 1 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(codes(r), [['UNIT_COST_IGNORED', 0, 'P3']]);
  assert.match(String((r.body.warnings as Row[])[0].message), /سعر الوحدة يسجل مع الوارد فقط/);
  assert.deepEqual(itemsOf(r.body.data.id), [['P3', -2, 1, -2, null], ['P3', 1, 1, 1, null]]);
});

test('الوارد السالب (كان 400): كله سالب ⇒ تسوية إنقاص تحمل المرجع وإعادتها replay لا 409؛ ومختلط ⇒ الوارد وتسويةٌ منفصلة adjustment بلا سعر', async () => {
  fresh();
  const neg = await post({ type: 'RECEIVE', clientRef: 'rtv-1', supplier: 'المورّد', items: [{ productId: 'P3', qty: -3, unitCost: 4 }] });
  assert.equal(neg.status, 201, JSON.stringify(neg.body));
  assert.deepEqual(codes(neg), [['NEGATIVE_RECEIVE_AS_ADJUST', 0, 'P3']]);
  assert.equal(neg.body.adjustment, undefined);
  const e1 = world.entries.find((e) => e.id === neg.body.data.id)!;
  assert.equal(e1.type, 'ADJUST', 'إنقاصٌ لا وارد سالب ولا قيمة مطلقة');
  assert.equal(e1.supplier, 'المورّد');
  assert.equal(refOf.get(e1.id), 'rtv-1');
  assert.deepEqual(itemsOf(e1.id), [['P3', -3, 1, -3, null]]);
  const again = await post({ type: 'RECEIVE', clientRef: 'rtv-1', items: [{ productId: 'P3', qty: -3, unitCost: 4 }] });
  assert.deepEqual([again.status, again.body.replay, again.body.data.id], [200, true, e1.id], JSON.stringify(again.body));
  // وارد بلا سطرٍ سالب بمرجع تسوية ⇒ 409 كما كان
  assert.equal((await post({ type: 'RECEIVE', clientRef: 'rtv-1', items: [{ productId: 'P3', qty: 3 }] })).status, 409);

  const mix = await post({ type: 'RECEIVE', clientRef: 'po-mix', items: [{ productId: 'P3', qty: 10, unitCost: 2 }, { productId: 'P3', qty: -4, unitCost: 2 }] });
  assert.equal(mix.status, 201, JSON.stringify(mix.body));
  assert.deepEqual(codes(mix), [['NEGATIVE_RECEIVE_AS_ADJUST', 1, 'P3']]);
  const main = world.entries.find((e) => e.id === mix.body.data.id)!;
  const adj = world.entries.find((e) => e.id === mix.body.adjustment.id)!;
  assert.deepEqual([main.type, adj.type], ['RECEIVE', 'ADJUST']);
  assert.deepEqual(itemsOf(main.id), [['P3', 10, 1, 10, 2]]);
  assert.deepEqual(itemsOf(adj.id), [['P3', -4, 1, -4, null]]);
  assert.deepEqual([refOf.get(main.id), refOf.get(adj.id)], ['po-mix', null], 'المرجع على الوارد وحده');
  const creates0 = creates();
  const replay = await post({ type: 'RECEIVE', clientRef: 'po-mix', items: [{ productId: 'P3', qty: 10, unitCost: 2 }, { productId: 'P3', qty: -4, unitCost: 2 }] });
  assert.deepEqual([replay.status, replay.body.data.id, creates()], [200, main.id, creates0], 'لا كتابة ثانية للحركتين');
});

test('وحدة البند (كان 400 UNIT_INVALID): الموقوفة بمعاملها، والغريبة أساساً لصنفٍ بلا وحدات أكبر، وإلا يُترك السطر — لا ضرب بمعاملٍ مخمَّن', async () => {
  fresh();
  world.product({ id: 'CT', name: 'عصير' });
  world.unit({ id: 'U-CT', productId: 'CT', factor: 24, name: 'كرتون' });
  world.unit({ id: 'U-OFF', productId: 'CT', factor: 6, name: 'شدّة', isActive: false });
  const r = await post({
    type: 'RECEIVE',
    items: [
      { productId: 'CT', qty: 2, unitId: 'U-OFF' }, // موقوفة ⇒ ٢ × ٦
      { productId: 'P3', qty: 5, unitId: 'U-CT' }, // وحدة صنفٍ آخر بمعامل ٢٤ ⇒ خطر: يُترك
      { productId: 'P3', qty: 7, unitId: 'nope' }, // مجهولة وP3 بلا وحدات أكبر ⇒ الأساس
      { productId: 'CT', qty: 1, unitId: 'nope' }, // مجهولة وCT له كرتون ⇒ خطر: يُترك
      { productId: 'CT', qty: 1, unitId: 'U-CT' },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(codes(r), [['UNIT_INACTIVE', 0, 'CT'], ['UNIT_INVALID', 1, 'P3'], ['UNIT_FALLBACK_BASE', 2, 'P3'], ['UNIT_INVALID', 3, 'CT']]);
  assert.deepEqual(itemsOf(r.body.data.id), [['CT', 2, 6, 12, null], ['P3', 7, 1, 7, null], ['CT', 1, 24, 24, null]]);
});
