// حذف المندوب يحفظ تاريخ مخزون سيارته — حادثة ٢ أكتوبر ٢٠٢٦.
//
// كان مسار الحذف يمحو vanLoad وبنوده ليرضي المفتاح الإلزاميّ، ورصيد المستودع
// (الوارد + المُنزَّل − المُحمَّل على **كل** تحميلات الشركة) يقفز بكل ما حمّله
// المندوب وباعه — وفواتيره باقية. هنا: المعالج الحقيقيّ فوق Prisma مزيّف في
// الذاكرة، والمستودع يُحسب بـcomputeWarehouseStock نفسها قبل الحذف وبعده.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ───────────── Prisma مزيّف ─────────────
type Row = Record<string, any>;
const T = 'T1';
const at = (d: number) => new Date(Date.UTC(2026, 8, d));
let reps: Row[] = [];
let loads: Row[] = [];
let loadItems: Row[] = [];
let calls: string[] = [];

const products: Row[] = [
  { id: 'P1', tenantId: T, name: 'مكسرات', code: 'A1', unit: 'كيس', status: 'ACTIVE' },
  { id: 'P2', tenantId: T, name: 'شاهي', code: 'A2', unit: 'علبة', status: 'ACTIVE' },
];
// وارد بسعرين مختلفين كي يكون للتقييم معنى: طبقة كل سيارة تخرج بكلفة لحظتها
const whItems: Row[] = [
  { productId: 'P1', qty: 100, unitCost: 10, entry: { tenantId: T, type: 'RECEIVE', createdAt: at(1) } },
  { productId: 'P1', qty: 100, unitCost: 20, entry: { tenantId: T, type: 'RECEIVE', createdAt: at(3) } },
  { productId: 'P2', qty: 50, unitCost: 4, entry: { tenantId: T, type: 'RECEIVE', createdAt: at(1) } },
];

const flatMatch = (r: Row, where: Row = {}): boolean => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return (v.in as unknown[]).includes(r[k]);
    return false; // شكلٌ لا يعرفه المزيّف — يفشل صراحةً لا يمرّ صامتاً
  }
  return r[k] === v;
});
const generic = (name: string) => ({
  async updateMany() { calls.push(`${name}.updateMany`); return { count: 0 }; },
  async deleteMany() { calls.push(`${name}.deleteMany`); return { count: 0 }; },
  async findUnique() { calls.push(`${name}.findUnique`); return null; },
});

const db: Row = {
  admin: { async findUnique() { return { scopeEnabled: false }; } },
  glSettings: { async findUnique() { return null; } }, // الدفاتر لم تُفعَّل ⇒ الحذف يمضي
  companySettings: { async findUnique() { return null; } },
  aiRepSettings: generic('aiRepSettings'),
  invoice: generic('invoice'),
  receipt: generic('receipt'),
  dailyReport: generic('dailyReport'),
  dailyReportOwnerRep: generic('dailyReportOwnerRep'),
  notification: generic('notification'),
  repLocation: generic('repLocation'),
  repVisit: generic('repVisit'),
  repSettlement: generic('repSettlement'),
  customerAssignment: generic('customerAssignment'),
  salesRep: {
    async findFirst(a: Row) { const r = reps.find(x => flatMatch(x, a.where)); return r ? { id: r.id, name: r.name } : null; },
    async delete(a: Row) {
      calls.push('salesRep.delete');
      reps = reps.filter(x => x.id !== a.where.id);
      // كما أعلن المخطط: onDelete: SetNull — والمعرّف المحفوظ يكتبه المسار لا القاعدة
      for (const l of loads) if (l.salesRepId === a.where.id) l.salesRepId = null;
      return {};
    },
  },
  vanLoad: {
    async updateMany(a: Row) {
      calls.push('vanLoad.updateMany');
      let count = 0;
      for (const l of loads) if (flatMatch(l, a.where)) { Object.assign(l, a.data); count++; }
      return { count };
    },
    async deleteMany() { calls.push('vanLoad.deleteMany'); loads = []; return { count: 0 }; },
  },
  vanLoadItem: {
    async deleteMany() { calls.push('vanLoadItem.deleteMany'); loadItems = []; return { count: 0 }; },
    async findMany(a: Row) {
      return loadItems
        .map(i => ({ i, l: loads.find(l => l.id === i.vanLoadId)! }))
        .filter(({ l }) => l && l.tenantId === a.where.vanLoad.tenantId)
        .map(({ i, l }) => ({
          productId: i.productId, qty: i.qty,
          vanLoad: { type: l.type, createdAt: l.createdAt, salesRepId: l.salesRepId, deletedSalesRepId: l.deletedSalesRepId ?? null },
        }));
    },
  },
  product: { async findMany(a: Row) { return products.filter(p => p.tenantId === a.where.tenantId).map(p => ({ ...p })); } },
  warehouseEntryItem: {
    async findMany(a: Row) {
      return whItems.filter(i => i.entry.tenantId === a.where.entry.tenantId)
        .map(i => ({ productId: i.productId, qty: i.qty, unitCost: i.unitCost, entry: { type: i.entry.type, createdAt: i.entry.createdAt } }));
    },
  },
};
db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(db);
db.$queryRaw = async () => [];
stub('config/database', { default: db });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeWarehouseStock, composeWarehouse, vanKeyOf } = require('../services/warehouseStock') as typeof import('../services/warehouseStock');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const salesRepsRouter = (require('../routes/salesReps') as typeof import('../routes/salesReps')).default;

/** المعالج الحقيقيّ لـDELETE /:id — بلا وسائط المصادقة (المزيّف لا جلسة فيه) */
function deleteHandler(): (req: Row, res: Row, next: (e?: unknown) => void) => Promise<void> {
  const layer = (salesRepsRouter as unknown as { stack: Row[] }).stack
    .find(l => l.route?.path === '/:id' && l.route.methods?.delete);
  assert.ok(layer, 'مسار DELETE /:id مفقود من salesReps');
  return layer.route.stack[0].handle;
}

async function deleteRep(id: string): Promise<{ status: number; body: Row | null }> {
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  let err: unknown;
  await deleteHandler()(
    { params: { id }, user: { id: 'ADM', role: 'ADMIN', tenantId: T } },
    res, (e?: unknown) => { err = e; },
  );
  if (err) throw err;
  return { status: res.statusCode, body: res.body };
}

let seq = 0;
function load(salesRepId: string | null, type: string, day: number, items: [string, number][], deletedSalesRepId: string | null = null): void {
  const id = `L${++seq}`;
  loads.push({ id, tenantId: T, salesRepId, deletedSalesRepId, type, createdAt: at(day) });
  for (const [productId, qty] of items) loadItems.push({ id: `I${++seq}`, vanLoadId: id, productId, qty });
}

function seed(): void {
  seq = 0; calls = [];
  reps = [{ id: 'R1', tenantId: T, name: 'أحمد' }, { id: 'R2', tenantId: T, name: 'خالد' }];
  loads = []; loadItems = [];
  load('R1', 'LOAD', 2, [['P1', 30], ['P2', 10]]);        // خرج بكلفة ١٠
  // مندوبٌ حُذف قبلُ (بعد الإصلاح): مرجعه مفرَّغ ومعرّفه محفوظ — حمّل بعد ارتفاع الكلفة
  load(null, 'LOAD', 4, [['P1', 20]], 'R0');
  load('R2', 'LOAD', 5, [['P1', 15]]);
  load('R1', 'UNLOAD', 6, [['P1', 5]]);                    // يعود بكلفة طبقة R1 (١٠) لا طبقة R0
  load(null, 'UNLOAD', 7, [['P1', 3]], 'R0');
  load('R2', 'ADJUST', 8, [['P1', -2]]);                   // تسوية سيارة لا تمسّ المستودع
}

test('حذف المندوب يُبقي تحميلاته بمرجعٍ مفرَّغ ومعرّفٍ محفوظ — ورصيد المستودع وقيمته كما هما', async () => {
  seed();
  const before = await computeWarehouseStock(T, 2);
  const itemsBefore = loadItems.length;
  const r1Loads = loads.filter(l => l.salesRepId === 'R1').map(l => l.id);
  assert.equal(r1Loads.length, 2);

  const r = await deleteRep('R1');
  assert.equal(r.status, 200);
  assert.equal(r.body?.success, true, 'الحذف يمضي دائماً (قرار المالك) — لا حجب');
  assert.ok(!reps.some(x => x.id === 'R1'), 'المندوب لم يُحذف');

  // الحركات باقية كلّها: لا بند ولا رأس محذوف
  assert.equal(loadItems.length, itemsBefore, 'بنود التحميل مُحيت');
  assert.ok(!calls.includes('vanLoad.deleteMany') && !calls.includes('vanLoadItem.deleteMany'), 'المسار ما زال يمحو التحميلات');
  for (const id of r1Loads) {
    const l = loads.find(x => x.id === id);
    assert.ok(l, `التحميل ${id} مُحي`);
    assert.equal(l!.salesRepId, null, 'المرجع لم يُفرَّغ');
    assert.equal(l!.deletedSalesRepId, 'R1', 'معرّف المندوب لم يُحفظ لمفتاح سيارته');
  }
  // تحميلات مندوبٍ آخر لم تُمسّ
  assert.ok(loads.filter(l => l.salesRepId === 'R2').length === 2);

  const after = await computeWarehouseStock(T, 2);
  assert.deepEqual(after, before, 'رصيد المستودع أو قيمته تغيّر بحذف المندوب');
  // والرقم نفسه صحيح لا مجرّد ثابت: ٢٠٠ وارد − (٣٠+٢٠+١٥) محمّل + (٥+٣) عائد
  const p1 = after.find(x => x.productId === 'P1')!;
  assert.equal(p1.onHand, 143);
  assert.equal(p1.loadedToVans, 65);
  assert.equal(p1.returnedFromVans, 8);
  assert.equal(after.find(x => x.productId === 'P2')!.onHand, 40);
});

test('المنطق القديم (محو التحميلات) كان يرفع المستودع بكل ما حُمّل — الاختبار يكشفه', async () => {
  seed();
  const before = (await computeWarehouseStock(T, 2)).find(x => x.productId === 'P1')!.onHand;
  // محاكاة السلوك المحذوف: بنود R1 ورؤوسه تُمحى
  const gone = new Set(loads.filter(l => l.salesRepId === 'R1').map(l => l.id));
  loadItems = loadItems.filter(i => !gone.has(i.vanLoadId));
  loads = loads.filter(l => !gone.has(l.id));
  const after = (await computeWarehouseStock(T, 2)).find(x => x.productId === 'P1')!.onHand;
  assert.equal(after - before, 25, 'محو تحميلات R1 (٣٠ محمّل − ٥ عائد) يرفع المستودع ٢٥');
});

test('مفتاح السيارة: مندوبان محذوفان لا يتشاركان مكدّس طبقات (vanKeyOf)', () => {
  assert.equal(vanKeyOf({ salesRepId: 'R2', deletedSalesRepId: null }), 'R2');
  assert.equal(vanKeyOf({ salesRepId: null, deletedSalesRepId: 'R1' }), 'R1');
  assert.equal(vanKeyOf({ salesRepId: null, deletedSalesRepId: null }), null);
  assert.equal(vanKeyOf({ salesRepId: null }), null);

  const prods = [{ id: 'P', name: 'p', code: 'p', unit: 'u' }];
  const wh = [
    { productId: 'P', qty: 100, type: 'RECEIVE', unitCost: 10, at: at(1) },
    { productId: 'P', qty: 100, type: 'RECEIVE', unitCost: 30, at: at(3) },
  ];
  const vans = (keyA: string | null, keyB: string | null) => [
    { productId: 'P', qty: 50, type: 'LOAD', salesRepId: keyA, at: at(2) },   // أ بكلفة ١٠
    { productId: 'P', qty: 50, type: 'LOAD', salesRepId: keyB, at: at(4) },   // ب بكلفة أعلى
    { productId: 'P', qty: 20, type: 'UNLOAD', salesRepId: keyA, at: at(5) }, // أ يُنزل حمولته هو
  ];
  const live = composeWarehouse(prods, wh, vans('A', 'B'))[0];
  const kept = composeWarehouse(prods, wh, vans(vanKeyOf({ salesRepId: null, deletedSalesRepId: 'A' }), vanKeyOf({ salesRepId: null, deletedSalesRepId: 'B' })))[0];
  assert.deepEqual(kept, live, 'المفتاح المحفوظ يُبقي التقييم كما كان والمندوبان حيّان');
  // بلا المفتاح: مكدّسٌ مشترك فيعود تنزيل أ بكلفة حمولة ب — القيمة تتغيّر بمجرّد الحذف
  const merged = composeWarehouse(prods, wh, vans(null, null))[0];
  assert.equal(merged.onHand, live.onHand, 'الكمّية لا تحتاج المفتاح');
  assert.notEqual(merged.stockValue, live.stockValue, 'المثال لا يميّز — يجب أن يفرّق المكدّس المشترك القيمة');
});

test('المخطط: salesRepId اختياريّ بـSetNull، وdeletedSalesRepId نصٌّ بلا علاقة', () => {
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  const i = schema.indexOf('model VanLoad {');
  assert.ok(i > 0, 'نموذج VanLoad مفقود');
  const block = schema.slice(i, schema.indexOf('\n}', i));
  assert.match(block, /\n\s*salesRepId\s+String\?\s*\n/, 'المرجع إلزاميّ — فيعود المسار إلى محو التحميلات');
  assert.match(block, /salesRep\s+SalesRep\? @relation\([^)]*onDelete: SetNull\)/, 'العلاقة يجب أن تكون SetNull');
  assert.match(block, /\n\s*deletedSalesRepId\s+String\?\s*\n/, 'معرّف المندوب المحذوف مفقود');
  assert.doesNotMatch(block, /deletedSalesRepId[^\n]*@relation/, 'المعرّف المحفوظ لا مفتاح أجنبيّ له');
  // البنود تبقى تعاقبية على رأسها — لم تُمسّ
  const j = schema.indexOf('model VanLoadItem {');
  assert.match(schema.slice(j, schema.indexOf('\n}', j)), /vanLoad\s+VanLoad\s+@relation\([^)]*onDelete: Cascade\)/);
});

test('قرّاء التحميلات: المستودع والقيد الافتتاحيّ بمفتاح السيارة، والسجلّ يسمّي المحذوف', () => {
  const wh = read('services', 'warehouseStock.ts');
  assert.match(wh, /deletedSalesRepId: true/, 'المستودع لا يقرأ المعرّف المحفوظ');
  assert.match(wh, /salesRepId: vanKeyOf\(i\.vanLoad\)/, 'المستودع يقيّم بالمندوب الحيّ وحده');
  // تحميلات المحذوفين داخلةٌ في الرصيد: لا قيد على المندوب في استعلام المستودع
  assert.match(wh, /where: \{ vanLoad: \{ tenantId: tid \} \}/);

  const op = read('services', 'gl', 'opening.ts');
  assert.match(op, /deletedSalesRepId: true/, 'القيد الافتتاحيّ لا يقرأ المعرّف المحفوظ');
  assert.match(op, /salesRepId: vanKeyOf\(i\.vanLoad\)/, 'القيد الافتتاحيّ يقيّم بالمندوب الحيّ وحده');

  const vs = read('routes', 'vanStock.ts');
  const h = vs.slice(vs.indexOf("router.get('/loads'"), vs.indexOf("router.get('/movements'"));
  assert.match(h, /salesRep: l\.salesRep \?\? \{ id: null, name: REP_GONE_NAME \}/, 'سجلّ التحميلات يُرجع salesRep: null');
  assert.match(vs, /const REP_GONE_NAME = 'مندوب محذوف'/);
});
