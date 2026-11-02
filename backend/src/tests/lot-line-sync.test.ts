// «تتبّع اللوط» على مستوى السطر في المزامنة (/api/v1/sync) — كل بندٍ يحمل توزيعه على التشغيلات وبطاقتها مضمّنين للشركة
// المفعّلة وحدها، و«مرجع السطر» (lineRef) في بنود الفاتورة والتحميل والوارد لكل الشركات. فوق Prisma مزيّف بلا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// —— قاعدة مزيّفة تسجّل استعلام الصفحة وتعيد الصفوف كما هي ——
let lastArgs: Record<string, unknown> | null = null;
let rows: Record<string, unknown>[] = [];
let tenantRow: Record<string, unknown> = { accountingEnabled: true, warehouseEnabled: true };
const delegate = { async findMany(args: Record<string, unknown>) { lastArgs = args; return rows.slice(0, Number(args.take)); } };
const prismaFake = new Proxy({
  admin: { async findUnique() { return { isActive: true, scopeEnabled: false, canManageInvoices: true, canManageVanStock: true }; } },
  tenant: { async findUnique() { return tenantRow; } },
} as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : delegate) });
stub('config/database', { default: prismaFake });
// المصادقة نفسها مختبرة في api-keys.test.ts — هنا تمرير بهوية المفتاح المحقونة
stub('middleware/auth', {
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sync = require('../services/apiSync') as typeof import('../services/apiSync');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/apiV1').default as Router;

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] }; handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }
const KEY_USER = { id: 'a1', role: 'ADMIN', name: 'م', tenantId: 't1', apiKeyId: 'k1' };
/** يمرّ بسلسلة الموجّه كلها (الوسطاء ثم المسار) كما يمرّ الطلب الحقيقي — نمط api-sync.test.ts */
async function call(p: string, query: Record<string, string> = {}) {
  const res = { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
  const params: Record<string, string> = {};
  const req = { user: KEY_USER, query, params, method: 'GET' };
  for (const l of (router as unknown as { stack: Layer[] }).stack) {
    if (res.body) break;
    if (l.route) {
      const m = new RegExp('^' + l.route.path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$').exec(p);
      if (!m || !l.route.methods.get) continue;
      Object.assign(params, m.groups ?? {});
      await l.route.stack[l.route.stack.length - 1].handle(req, res, (e?: unknown) => { if (e) throw e; });
      break;
    }
    let passed = false;
    await l.handle(req, res, (e?: unknown) => { if (e) throw e; passed = true; });
    if (!passed) break;
  }
  return res;
}

type Sel = Record<string, unknown>;
type Rel = { select: Sel; orderBy?: unknown };
const items = (s: unknown): Rel => (s as { items: Rel }).items;
const keys = (o: unknown): string[] => Object.keys(o as object).sort();

const LOTS_OFF = [{ accountingEnabled: true, warehouseEnabled: true }, { accountingEnabled: true, warehouseEnabled: true, lotTrackingEnabled: false }];
const LOTS_ON = { accountingEnabled: true, warehouseEnabled: true, lotTrackingEnabled: true };
const LOT_CARD = { select: { lotNumber: true, productionDate: true, expiryDate: true } };
const LINE_ORDER = [{ createdAt: 'asc' }, { id: 'asc' }];

/** أعمدة البند قبل الميزة كما كانت حرفياً — والجديد عليها lineRef وحده */
const OLD_ITEM_COLS: Record<string, string[]> = {
  invoices: ['id', 'productId', 'unitCost', 'qty', 'unitPrice', 'discountPct', 'discountAmt', 'taxPct', 'taxAmt', 'lineTotal', 'seq',
    'itemName', 'unitCode', 'vatCategory', 'vatExemptionCode', 'vatExemptionReason', 'creditedItemId', 'expiresAt',
    'returnExpired', 'expirySaleInvoiceId', 'returnOfItemId', 'unitName', 'unitFactor', 'baseQty'],
  'van-loads': ['productId', 'qty', 'unitName', 'unitFactor', 'baseQty', 'suggestedQty', 'expectedQty'],
  'warehouse-entries': ['productId', 'qty', 'unitName', 'unitFactor', 'baseQty', 'unitCost'],
};
const LINE_RESOURCES = Object.keys(OLD_ITEM_COLS);

test('البيان: توزيع البند المضمّن وبطاقة التشغيلة بحقول المواصفة حرفياً وترتيب الكتابة (الإنشاء ثم المعرّف) — للمفعّلة وحدها عبر lotSelect', () => {
  assert.deepEqual(sync.syncResource('invoices')!.lotSelect, {
    items: { select: {
      lots: {
        select: { id: true, lotId: true, quantity: true, certainty: true, expiryDate: true, sourceItemLotId: true, flags: true, lot: LOT_CARD },
        orderBy: LINE_ORDER,
      },
    } },
  });
  assert.deepEqual(sync.syncResource('van-loads')!.lotSelect, {
    items: { select: {
      id: true,
      lots: {
        select: { id: true, lotId: true, qty: true, certainty: true, reason: true, moveType: true, viaWarehouse: true, lot: LOT_CARD },
        orderBy: LINE_ORDER,
      },
    } },
  });
  // الوارد: سطرٌ = لوطٌ واحد — المعرّف والتشغيلة وبطاقتها على البند نفسه (لا جدول توزيع)
  assert.deepEqual(sync.syncResource('warehouse-entries')!.lotSelect, { items: { select: { id: true, lotId: true, lot: LOT_CARD } } });
  // البطاقة لا تحمل حالتها ولا سرّها: الحالة الحيّة من product-lots، وsourceEntryId سباكة داخلية
  for (const r of LINE_RESOURCES) {
    const s = JSON.stringify(sync.syncResource(r)!.lotSelect);
    for (const bad of ['status', 'blockKind', 'sourceEntryId', 'tenantId', 'vanKey']) assert.ok(!s.includes(`"${bad}"`), `${r}: ${bad} في السطر`);
  }
  // والموارد المستقلّة باقية كما هي (التوافق مع من يسحبها اليوم)
  assert.deepEqual(keys(sync.syncResource('invoice-item-lots')!.select),
    ['certainty', 'createdAt', 'expiryDate', 'flags', 'id', 'invoiceId', 'invoiceItemId', 'lotId', 'productId', 'quantity', 'sourceItemLotId', 'vanKey']);
  assert.deepEqual(keys(sync.syncResource('van-load-item-lots')!.select),
    ['certainty', 'createdAt', 'id', 'lotId', 'moveType', 'productId', 'qty', 'reason', 'vanKey', 'vanLoadItemId', 'viaWarehouse']);
});

test('«مرجع السطر»: lineRef في بنود الموارد الثلاثة لكل الشركات (ليس عمود لوط)، والمطفأة بأعمدتها القديمة وlineRef وحده', () => {
  for (const r of LINE_RESOURCES) {
    const def = sync.syncResource(r)!;
    assert.equal(items(def.select).select.lineRef, true, `${r}: lineRef في select المورد نفسه`);
    assert.ok(!JSON.stringify(def.lotSelect ?? {}).includes('lineRef'), `${r}: lineRef ليس مشروطاً بالعَلَم`);
    assert.ok(!('lineRef' in (def.nested?.items.denied ?? {})), `${r}: lineRef ممنوع`);
    assert.deepEqual(keys(items(sync.selectFor(def, false)).select), [...OLD_ITEM_COLS[r], 'lineRef'].sort(), `${r}: المطفأة`);
    assert.equal(items(sync.selectFor(def, true)).select.lineRef, true, `${r}: المفعّلة`);
  }
  // ولا موردٌ آخر يحمله (لا عمود في جدوله)
  for (const r of sync.SYNC_RESOURCES) if (!LINE_RESOURCES.includes(r.name)) assert.ok(!JSON.stringify(sync.selectFor(r, true)).includes('lineRef'), r.name);
});

test('GET /sync للشركة المطفأة (العَلَم غائب أو false): البنود بلا lots ولا lot ولا معرّفٍ جديد — الشكل القديم مع lineRef وحده', async () => {
  rows = [];
  for (const t of LOTS_OFF) {
    tenantRow = t;
    for (const r of LINE_RESOURCES) {
      const res = await call(`/sync/${r}`);
      assert.equal(res.statusCode, 200, `${r} ${JSON.stringify(t)}`);
      const it = items(lastArgs!.select);
      assert.deepEqual(keys(it.select), [...OLD_ITEM_COLS[r], 'lineRef'].sort(), `${r}: أعمدة البند`);
      for (const k of ['lots', 'lot']) assert.ok(!(k in it.select), `${r}: ${k} للمطفأة`);
    }
    // ترتيب بنود الفاتورة كما كان
    await call('/sync/invoices');
    assert.deepEqual(items(lastArgs!.select).orderBy, [{ seq: 'asc' }, { id: 'asc' }]);
  }
});

test('GET /sync للشركة المفعّلة: كل بندٍ بتوزيعه وبطاقته بترتيب الكتابة، وأعمدة البند كلها باقية مع lineRef، وترتيب البنود لا يُمسّ', async () => {
  tenantRow = LOTS_ON;
  rows = [];
  await call('/sync/invoices');
  let it = items(lastArgs!.select);
  assert.deepEqual(it.orderBy, [{ seq: 'asc' }, { id: 'asc' }], 'ترتيب البنود');
  assert.deepEqual(keys(it.select), [...OLD_ITEM_COLS.invoices, 'lineRef', 'lots'].sort());
  let lots = it.select.lots as Rel;
  assert.deepEqual(keys(lots.select), ['certainty', 'expiryDate', 'flags', 'id', 'lot', 'lotId', 'quantity', 'sourceItemLotId']);
  assert.deepEqual(lots.orderBy, LINE_ORDER);
  assert.deepEqual(lots.select.lot, LOT_CARD);

  await call('/sync/van-loads');
  it = items(lastArgs!.select);
  assert.deepEqual(keys(it.select), [...OLD_ITEM_COLS['van-loads'], 'lineRef', 'id', 'lots'].sort());
  lots = it.select.lots as Rel;
  assert.deepEqual(keys(lots.select), ['certainty', 'id', 'lot', 'lotId', 'moveType', 'qty', 'reason', 'viaWarehouse']);
  assert.deepEqual(lots.orderBy, LINE_ORDER);
  assert.deepEqual(lots.select.lot, LOT_CARD);

  await call('/sync/warehouse-entries');
  it = items(lastArgs!.select);
  assert.deepEqual(keys(it.select), [...OLD_ITEM_COLS['warehouse-entries'], 'lineRef', 'id', 'lotId', 'lot'].sort());
  assert.deepEqual(it.select.lot, LOT_CARD);
  assert.equal(it.orderBy, undefined, 'بنود الوارد بلا ترتيب كما كانت');

  // الدمج لا يمسّ تعريف المورد المشترك بين الطلبات: الطلب التالي للمطفأة بشكله القديم
  for (const r of LINE_RESOURCES) {
    const base = items(sync.syncResource(r)!.select).select;
    for (const k of ['lots', 'lot']) assert.ok(!(k in base), `${r}: ${k} تسرّب إلى select المورد`);
  }
  tenantRow = LOTS_OFF[0];
  await call('/sync/van-loads');
  assert.ok(!('lots' in items(lastArgs!.select).select) && !('id' in items(lastArgs!.select).select));
});

test('الردّ: التوزيع والبطاقة وlineRef يمرّون كما قرأتهم القاعدة (والبطاقة null لغير المسمّى)، وbaseQty الفارغ يُحسب كما كان', async () => {
  tenantRow = LOTS_ON;
  const card = { lotNumber: 'L-7', productionDate: new Date('2026-09-01T00:00:00Z'), expiryDate: new Date('2027-03-01T00:00:00Z') };
  const invItem = {
    id: 'ii1', productId: 'p1', qty: 2, unitName: 'كرتون', unitFactor: 12, baseQty: null, lineRef: 'ERP-LINE-10',
    lots: [
      { id: 'a', lotId: 'L7', quantity: 20, certainty: 'CONFIRMED', expiryDate: card.expiryDate, sourceItemLotId: null, flags: null, lot: card },
      { id: 'b', lotId: null, quantity: 4, certainty: 'UNKNOWN', expiryDate: null, sourceItemLotId: null, flags: 'NO_LOT', lot: null },
    ],
  };
  rows = [{ id: 'inv1', updatedAt: new Date('2026-11-01T00:00:00Z'), items: [invItem, { id: 'ii2', productId: 'p2', qty: 1, unitFactor: 1, baseQty: 1, lineRef: null, lots: [] }] }];
  let res = await call('/sync/invoices');
  assert.equal(res.statusCode, 200);
  const [inv] = res.body!.data as { items: Record<string, unknown>[] }[];
  assert.deepEqual(inv.items[0], { ...invItem, baseQty: 24 }, 'البند بتوزيعه كما هو، وbaseQty من لقطته');
  assert.deepEqual(inv.items[1], { id: 'ii2', productId: 'p2', qty: 1, unitFactor: 1, baseQty: 1, lineRef: null, lots: [] }, 'بندٌ بلا توزيع ⇒ [] وlineRef null');

  // الوارد: سطر التسوية المنقسم على تشغيلتين بنودٌ بالمرجع نفسه، ولكلٍّ بطاقته
  const split = [
    { id: 'w1', productId: 'p1', qty: -3, unitFactor: 1, baseQty: -3, unitCost: null, lineRef: 'ADJ-1', lotId: 'L7', lot: card },
    { id: 'w2', productId: 'p1', qty: -2, unitFactor: 1, baseQty: -2, unitCost: null, lineRef: 'ADJ-1', lotId: null, lot: null },
  ];
  rows = [{ id: 'e1', type: 'ADJUST', createdAt: new Date('2026-11-01T00:00:00Z'), items: split }];
  res = await call('/sync/warehouse-entries');
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.body!.data as { items: unknown[] }[])[0].items, split);

  // والمطفأة: الصفّ كما قرأته القاعدة (بلا lots لأنها لم تُطلب)، وlineRef فيه
  tenantRow = LOTS_OFF[0];
  rows = [{ id: 'v1', updatedAt: new Date('2026-11-01T00:00:00Z'), items: [{ productId: 'p1', qty: 5, unitName: null, unitFactor: 1, baseQty: 5, suggestedQty: null, expectedQty: null, lineRef: 'X' }] }];
  res = await call('/sync/van-loads');
  assert.deepEqual((res.body!.data as { items: unknown[] }[])[0].items, [{ productId: 'p1', qty: 5, unitName: null, unitFactor: 1, baseQty: 5, suggestedQty: null, expectedQty: null, lineRef: 'X' }]);
  tenantRow = { accountingEnabled: true, warehouseEnabled: true };
});

test('سقف الصفحة ٢٠٠ للفواتير والتحميلات حين تُضمّ تشغيلات البنود — والمطفأة وبقية الموارد بسقفها العام ٥٠٠', async () => {
  rows = [];
  for (const r of ['invoices', 'van-loads']) {
    tenantRow = LOTS_ON;
    await call(`/sync/${r}`, { limit: '500' });
    assert.equal(lastArgs!.take, sync.LOT_SYNC_MAX_LIMIT + 1, `${r}: المفعّلة`);
    await call(`/sync/${r}`);
    assert.equal(lastArgs!.take, 101, `${r}: الافتراضي ١٠٠ كما كان`);
    for (const off of LOTS_OFF) {
      tenantRow = off;
      await call(`/sync/${r}`, { limit: '500' });
      assert.equal(lastArgs!.take, 501, `${r}: المطفأة`);
    }
  }
  tenantRow = LOTS_ON;
  await call('/sync/warehouse-entries', { limit: '500' });
  assert.equal(lastArgs!.take, 501, 'الوارد: بند واحد = تشغيلة واحدة فلا سقف خاص');
  assert.equal(sync.LOT_SYNC_MAX_LIMIT, 200);
});
