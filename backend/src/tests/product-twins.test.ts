// «التوائم المؤرشفة» (services/productTwins.ts) — التطبيع والتوأم والحمولة على قاعدةٍ في الذاكرة، وخطة الجداول من نموذج Prisma،
// والدمج على معاملةٍ وهمية تسجّل كل نداء. بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_MODELS, combineRequestItems, detectTwin, findArchivedProducts, indexByName, mergeArchivedProduct, mergePlanModels,
  MergeRefused, normalizeName, type ProductLite, type VanBalancesFn,
} from '../services/productTwins';

test('normalizeName: قصّ الأطراف ودمج المسافات وحالة الأحرف اللاتينية — بلا تطبيع للعربية', () => {
  assert.equal(normalizeName('  كرتون   بيض M '), 'كرتون بيض m');
  assert.equal(normalizeName('Water\t 330ML'), 'water 330ml');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
  assert.notEqual(normalizeName('مياه'), normalizeName('مياة'));
});

const P = (id: string, name: string, unit = 'حبة', status = 'ACTIVE'): ProductLite => ({ id, code: `C-${id}`, name, unit, status });

test('detectTwin: NAME / AMBIGUOUS / UNIT_MISMATCH / NONE', () => {
  const index = indexByName([
    P('b1', 'كرتون بيض M'),
    P('b2', 'مياه 330'), P('b3', ' مياه   330 '),
    P('b4', 'عصير', 'كرتون'),
    P('b5', 'حليب'), P('b6', 'حليب', 'حبة', 'INACTIVE'),
  ]);
  const a = (name: string, unit = 'حبة') => detectTwin(P('a', name, unit, 'INACTIVE'), index);

  const n = a('  كرتون  بيض m');
  assert.equal(n.twinReason, 'NAME');
  assert.deepEqual(n.twin, { id: 'b1', code: 'C-b1', name: 'كرتون بيض M', unit: 'حبة' });

  assert.deepEqual(a('مياه 330'), { twin: null, twinReason: 'AMBIGUOUS' });
  assert.deepEqual(a('عصير', 'حبة'), { twin: null, twinReason: 'UNIT_MISMATCH' });
  assert.deepEqual(a('شاي'), { twin: null, twinReason: 'NONE' });
  assert.deepEqual(a('   '), { twin: null, twinReason: 'NONE' });
  // وحدة الأساس تُطبَّع كالاسم
  assert.equal(a('عصير', ' كرتون ').twinReason, 'NAME');
  // اثنان بالوحدة نفسها وواحدٌ منهما بحالة ACTIVE ⇒ هو التوأم (الموقوف توأمٌ قديم آخر)
  assert.equal(a('حليب').twin?.id, 'b5');
});

/** قاعدة في الذاكرة: findMany بشرط {حقل: قيمة | {in} | {not: null}} وgroupBy بحقلٍ واحد */
function memDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const match = (row: Record<string, unknown>, where: Record<string, unknown> = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as object)) return (v as { in: unknown[] }).in.includes(row[k]);
    if (v && typeof v === 'object' && 'not' in (v as object)) return row[k] !== (v as { not: unknown }).not && !(row[k] == null && (v as { not: unknown }).not == null);
    if (v === null) return row[k] == null;
    return row[k] === v;
  });
  return new Proxy({}, {
    get(_t, name: string) {
      const rows = tables[name] ?? [];
      return {
        findMany: async (a: { where?: Record<string, unknown>; select?: Record<string, true> }) => rows.filter((r) => match(r, a.where))
          .map((r) => (a.select ? Object.fromEntries(Object.keys(a.select).map((k) => [k, r[k] ?? null])) : r)),
        groupBy: async (a: { by: string[]; where?: Record<string, unknown> }) => {
          const n = new Map<unknown, number>();
          for (const r of rows.filter((x) => match(x, a.where))) n.set(r[a.by[0]], (n.get(r[a.by[0]]) ?? 0) + 1);
          return [...n].map(([k, c]) => ({ [a.by[0]]: k, _count: { _all: c } }));
        },
      };
    },
  });
}

test('findArchivedProducts: المؤرشفة وحدها، بتوأمها ورصيدها لكل سيارة وعدد حركاتها، وشركةٌ أخرى لا تُرى', async () => {
  const day = new Date('2026-10-01T00:00:00Z');
  const db = memDb({
    product: [
      { id: 'A', tenantId: 't1', code: '100', name: 'كرتون بيض M', unit: 'حبة', status: 'INACTIVE', deletedAt: day },
      { id: 'A2', tenantId: 't1', code: '200', name: 'زيت', unit: 'لتر', status: 'INACTIVE', deletedAt: day },
      { id: 'B', tenantId: 't1', code: '101', name: 'كرتون  بيض M ', unit: 'حبة', status: 'ACTIVE', deletedAt: null },
      { id: 'X', tenantId: 't2', code: '100', name: 'كرتون بيض M', unit: 'حبة', status: 'INACTIVE', deletedAt: day },
    ],
    salesRep: [{ id: 'r1', tenantId: 't1', name: 'أحمد' }, { id: 'r2', tenantId: 't1', name: 'سالم' }],
    invoiceItem: [{ productId: 'A' }, { productId: 'A' }, { productId: 'B' }],
    vanLoadItem: [{ productId: 'A' }, { productId: 'A2' }],
    warehouseEntryItem: [{ productId: 'A' }],
  });
  const calls: unknown[][] = [];
  const vanBalances: VanBalancesFn = async (_db, tid, pids, reps) => {
    calls.push([tid, [...pids].sort(), [...reps].sort()]);
    return new Map([['A', new Map([['r1', 40], ['r2', 0]])], ['A2', new Map([['r2', -3]])]]);
  };
  const rows = await findArchivedProducts(db as never, 't1', { vanBalances });
  assert.deepEqual(calls, [['t1', ['A', 'A2'], ['r1', 'r2']]]);
  assert.deepEqual(rows.map((r) => r.id), ['A', 'A2']); // الأكبر رصيداً أولاً
  const a = rows[0];
  assert.deepEqual(a.twin, { id: 'B', code: '101', name: 'كرتون  بيض M ', unit: 'حبة' });
  assert.equal(a.twinReason, 'NAME');
  assert.equal(a.vanBalance, 40);
  assert.deepEqual(a.vans, [{ salesRepId: 'r1', repName: 'أحمد', remaining: 40 }]); // الصفر لا يظهر
  assert.deepEqual(a.counts, { invoiceItems: 2, vanLoadItems: 1, warehouseEntryItems: 1 });
  assert.equal(a.deletedAt, day);
  const a2 = rows[1];
  assert.equal(a2.twinReason, 'NONE');
  assert.equal(a2.twin, null);
  assert.equal(a2.vanBalance, -3);
  assert.deepEqual(a2.counts, { invoiceItems: 0, vanLoadItems: 1, warehouseEntryItems: 0 });

  assert.deepEqual(await findArchivedProducts(memDb({}) as never, 't1', { vanBalances }), []);
});

// «هدف الشهر» (RepTarget): هدف كمية الصنف يتبعه إلى توأمه كبنود فواتيره — فيبقى تقدّمه يُقاس على ما صار باسم B،
// وكذا صنفه الإضافي في هدفٍ بعدة أصناف (RepTargetProduct — طلب المالك ١١ نوفمبر ٢٠٢٦)
const REPOINT = [
  'GlMoveLine', 'InvoiceItem', 'InvoiceItemLot', 'LotEvent', 'LotRelabel', 'ProductLot', 'RepStockRequestItem', 'RepTarget', 'RepTargetProduct',
  'VanLoadItem', 'VanLoadItemLot', 'WarehouseEntryItem',
];

test('خطة الجداول من نموذج Prisma: التاريخ والحركات تُوجَّه إلى B، والإعداد لا يُوجَّه أبداً', () => {
  const plan = mergePlanModels();
  assert.deepEqual(plan.repoint.map((t) => t.model).sort(), REPOINT);
  assert.deepEqual(plan.unhandled, []);
  for (const t of plan.repoint) assert.ok(!CONFIG_MODELS.has(t.model), t.model);
  const kind = Object.fromEntries(plan.repoint.map((t) => [t.model, t.kind]));
  for (const m of ['InvoiceItem', 'VanLoadItem', 'WarehouseEntryItem', 'RepStockRequestItem', 'ProductLot', 'RepTarget', 'RepTargetProduct']) assert.equal(kind[m], 'FK', m);
  for (const m of ['VanLoadItemLot', 'InvoiceItemLot', 'LotRelabel', 'LotEvent', 'GlMoveLine']) assert.equal(kind[m], 'PLAIN', m);
  const special = Object.fromEntries(plan.repoint.map((t) => [t.model, t.special]));
  assert.equal(special.ProductLot, 'LOTS');
  assert.equal(special.RepStockRequestItem, 'REQUEST_ITEMS');
  // كل جدولٍ يشير إلى الصنف مصنَّف: إعدادٌ يُحذف مع A، أو تاريخٌ يُوجَّه
  for (const m of plan.deleteWith) assert.ok(CONFIG_MODELS.has(m), m);
  for (const m of ['ProductUnit', 'PriceTier', 'CustomerPrice', 'PriceListItem', 'ProductTeam', 'ProductBaseConversion']) assert.ok(plan.deleteWith.includes(m), m);
  // tenantId يقيّد التحديث حيث يوجد العمود
  const scoped = Object.fromEntries(plan.repoint.map((t) => [t.model, t.tenantScoped]));
  assert.equal(scoped.InvoiceItem, false);
  assert.equal(scoped.ProductLot, true);
  assert.equal(scoped.LotEvent, true);
  assert.equal(scoped.RepTargetProduct, true);
});

test('خطة الجداول: جدول حركاتٍ جديد بقيدٍ فريد على productId بلا معالجة ⇒ unhandled (حارس تغيّر المخطط)', () => {
  const fake = [
    { name: 'Product', fields: [{ name: 'id', kind: 'scalar', type: 'String' }], uniqueFields: [] },
    {
      name: 'NewMove', uniqueFields: [['docId', 'productId']],
      fields: [
        { name: 'productId', kind: 'scalar', type: 'String' },
        { name: 'product', kind: 'object', type: 'Product', relationFromFields: ['productId'], relationToFields: ['id'] },
      ],
    },
    { name: 'NewLog', uniqueFields: [], fields: [{ name: 'productId', kind: 'scalar', type: 'String' }, { name: 'tenantId', kind: 'scalar', type: 'String' }] },
  ];
  const plan = mergePlanModels(fake as never);
  assert.deepEqual(plan.unhandled, ['NewMove']);
  assert.deepEqual(plan.repoint.map((t) => [t.model, t.kind, t.tenantScoped]), [['NewMove', 'FK', false], ['NewLog', 'PLAIN', true]]);
});

test('combineRequestItems: الوحدة نفسها تُجمع كما هي، ووحدتان مختلفتان ⇒ سطرٌ بالأساس', () => {
  const row = (id: string, qty: number, requestedQty: number, unitName: string | null, unitFactor: number) =>
    ({ id, requestId: 'q', qty, requestedQty, unitName, unitFactor, baseQty: qty * unitFactor });
  assert.deepEqual(combineRequestItems(row('a', 2, 3, 'كرتون', 24), row('b', 1, 1, ' كرتون', 24)),
    { qty: 3, requestedQty: 4, unitName: ' كرتون', unitFactor: 24, baseQty: 72 });
  assert.deepEqual(combineRequestItems(row('a', 2, 3, 'كرتون', 24), row('b', 5, 6, null, 1)),
    { qty: 53, requestedQty: 78, unitName: null, unitFactor: 1, baseQty: 53 });
});

/** معاملة وهمية تسجّل كل نداء: القفل الخام، والقراءات، والكتابات */
function fakeTx(opts: {
  products: Array<{ id: string; tenantId: string; name: string; unit: string; deletedAt: Date | null }>;
  lotsA?: Array<{ lotNumber: string }>; lotClash?: number;
  reqA?: Array<Record<string, unknown>>; reqB?: Array<Record<string, unknown>>;
}) {
  const log: Array<{ op: string; model: string; arg?: unknown }> = [];
  const tx = new Proxy({}, {
    get(_t, name: string) {
      if (name === '$queryRaw') return async (s: TemplateStringsArray) => { log.push({ op: 'queryRaw', model: '$', arg: s.join('?') }); return s.join('').includes('current_setting') ? [{ lock_timeout: '0' }] : []; };
      if (name === '$executeRaw') return async (s: TemplateStringsArray) => { log.push({ op: 'executeRaw', model: '$', arg: s.join('?') }); return 0; };
      if (name === 'then') return undefined;
      return {
        findMany: async (a: { where: Record<string, unknown> }) => {
          log.push({ op: 'findMany', model: name, arg: a });
          if (name === 'product') {
            const ids = (a.where.id as { in: string[] }).in;
            return opts.products.filter((p) => ids.includes(p.id) && p.tenantId === a.where.tenantId);
          }
          if (name === 'productLot') return opts.lotsA ?? [];
          if (name === 'repStockRequestItem') return a.where.productId === 'A' ? (opts.reqA ?? []) : (opts.reqB ?? []);
          return [];
        },
        count: async (a: unknown) => { log.push({ op: 'count', model: name, arg: a }); return opts.lotClash ?? 0; },
        updateMany: async (a: unknown) => { log.push({ op: 'updateMany', model: name, arg: a }); return { count: 2 }; },
        update: async (a: unknown) => { log.push({ op: 'update', model: name, arg: a }); return {}; },
        delete: async (a: unknown) => { log.push({ op: 'delete', model: name, arg: a }); return {}; },
        deleteMany: async (a: unknown) => { log.push({ op: 'deleteMany', model: name, arg: a }); return { count: 0 }; },
      };
    },
  });
  return { tx, log };
}

const delegate = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);
const DAY = new Date('2026-10-01T00:00:00Z');
const A = { id: 'A', tenantId: 't1', name: 'كرتون بيض M', unit: 'حبة', deletedAt: DAY };
const B = { id: 'B', tenantId: 't1', name: 'كرتون بيض M', unit: 'حبة', deletedAt: null };

test('الدمج: قفلٌ أولاً، ثم كل جداول التاريخ من A إلى B، ولا جدول إعداد يُمسّ، ثم حذف A بالمحرّك', async () => {
  const { tx, log } = fakeTx({ products: [A, B] });
  const purges: unknown[][] = [];
  const r = await mergeArchivedProduct(tx as never, 't1', 'A', 'B', {
    purge: async (_tx, tid, model, ids) => { purges.push([tid, model, ids]); log.push({ op: 'purge', model }); return { counts: { Product: 1, ProductUnit: 2 }, nullCounts: {} }; },
  });
  // القفل FOR UPDATE بترتيب المعرّف قبل أي كتابة
  const lockAt = log.findIndex((c) => c.op === 'queryRaw' && String(c.arg).includes('FOR UPDATE'));
  const firstWrite = log.findIndex((c) => ['updateMany', 'update', 'delete', 'deleteMany'].includes(c.op));
  assert.ok(lockAt >= 0 && lockAt < firstWrite);
  assert.ok(String(log[lockAt].arg).includes('ORDER BY id'));

  const updates = log.filter((c) => c.op === 'updateMany');
  const repointed = updates.filter((c) => JSON.stringify((c.arg as { data: unknown }).data) === JSON.stringify({ productId: 'B' }));
  assert.deepEqual(repointed.map((c) => c.model).sort(), REPOINT.map(delegate).sort());
  for (const c of repointed) assert.equal((c.arg as { where: { productId: string } }).where.productId, 'A');
  // الاسم والوحدة متطابقان ⇒ لا لقطة تُكتب
  assert.equal(updates.length, repointed.length);
  // جداول الإعداد لا تُقرأ ولا تُكتب هنا — يحذفها purgeInTx مع A
  const config = new Set([...CONFIG_MODELS].map(delegate));
  assert.ok(!log.some((c) => config.has(c.model)), 'لا نداء على جدول إعداد');
  assert.deepEqual(purges, [['t1', 'Product', ['A']]]);
  assert.equal(log[log.length - 1].op, 'purge');
  assert.equal(r.moved.InvoiceItem, 2);
  assert.equal(r.moved.GlMoveLine, 2);
  assert.deepEqual(r.deleted, { Product: 1, ProductUnit: 2 });
});

test('الدمج: لقطة اسم A ووحدته في بنود فواتيره حين يختلف النصّ، وطلب البضاعة المشترك يُجمع سطراه', async () => {
  const { tx, log } = fakeTx({
    products: [{ ...A, name: 'كرتون بيض m ', unit: 'حبه ' }, { ...B, unit: 'حبه' }],
    reqA: [{ id: 'ra', requestId: 'q1', qty: 1, requestedQty: 1, unitName: null, unitFactor: 1, baseQty: 1 }, { id: 'ra2', requestId: 'q2', qty: 1, requestedQty: 1, unitName: null, unitFactor: 1, baseQty: 1 }],
    reqB: [{ id: 'rb', requestId: 'q1', qty: 2, requestedQty: 2, unitName: null, unitFactor: 1, baseQty: 2 }],
  });
  const r = await mergeArchivedProduct(tx as never, 't1', 'A', 'B', { purge: async () => ({ counts: {}, nullCounts: {} }) });
  const snaps = log.filter((c) => c.op === 'updateMany' && c.model === 'invoiceItem' && !('productId' in ((c.arg as { data: object }).data)));
  assert.deepEqual(snaps.map((c) => (c.arg as { data: unknown }).data), [{ itemName: 'كرتون بيض m ' }, { unitName: 'حبه ' }]);
  const upd = log.find((c) => c.op === 'update' && c.model === 'repStockRequestItem');
  assert.deepEqual(upd?.arg, { where: { id: 'rb' }, data: { qty: 3, requestedQty: 3, unitName: null, unitFactor: 1, baseQty: 3 } });
  assert.deepEqual(log.filter((c) => c.op === 'delete').map((c) => c.arg), [{ where: { id: 'ra' } }]);
  // قبل إعادة التوجيه العامة (القيد الفريد requestId+productId)
  const del = log.findIndex((c) => c.op === 'delete');
  const repointReq = log.findIndex((c) => c.op === 'updateMany' && c.model === 'repStockRequestItem');
  assert.ok(del < repointReq);
  assert.equal(r.moved.RepStockRequestItem, 3); // سطرٌ مجموع + اثنان أعيد توجيههما (الوهمية تعدّ ٢)
});

test('الدمج يُرفض برمزه بلا أي كتابة: نفسه، غير موجود، غير مؤرشف، الهدف مؤرشف، وحدة مختلفة، تشغيلات متعارضة', async () => {
  const cases: Array<[string, Parameters<typeof fakeTx>[0], string, string]> = [
    ['SAME_PRODUCT', { products: [A, B] }, 'A', 'A'],
    ['NOT_FOUND', { products: [A, { ...B, tenantId: 't2' }] }, 'A', 'B'],
    ['NOT_ARCHIVED', { products: [{ ...A, deletedAt: null }, B] }, 'A', 'B'],
    ['TARGET_ARCHIVED', { products: [A, { ...B, deletedAt: DAY }] }, 'A', 'B'],
    ['UNIT_MISMATCH', { products: [A, { ...B, unit: 'كرتون' }] }, 'A', 'B'],
    ['LOTS_CONFLICT', { products: [A, B], lotsA: [{ lotNumber: 'L1' }], lotClash: 1 }, 'A', 'B'],
  ];
  for (const [code, opts, from, to] of cases) {
    const { tx, log } = fakeTx(opts);
    let purged = false;
    await assert.rejects(
      mergeArchivedProduct(tx as never, 't1', from, to, { purge: async () => { purged = true; return { counts: {}, nullCounts: {} }; } }),
      (e: unknown) => e instanceof MergeRefused && e.code === code,
      code,
    );
    assert.ok(!log.some((c) => ['updateMany', 'update', 'delete', 'deleteMany'].includes(c.op)), `${code}: لا كتابة`);
    assert.equal(purged, false, code);
  }
});

test('الدمج: تشغيلات A بلا تعارض تُوجَّه إلى B', async () => {
  const { tx, log } = fakeTx({ products: [A, B], lotsA: [{ lotNumber: 'L1' }], lotClash: 0 });
  await mergeArchivedProduct(tx as never, 't1', 'A', 'B', { purge: async () => ({ counts: {}, nullCounts: {} }) });
  const lot = log.find((c) => c.op === 'updateMany' && c.model === 'productLot');
  assert.deepEqual(lot?.arg, { where: { productId: 'A', tenantId: 't1' }, data: { productId: 'B' } });
});
