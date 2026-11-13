// «ربط الدفاتر» L1 (B4) — سبب تسوية السيارة (VanLoad.reason) ومزامنة حركات المستودع بطابع التعديل:
//  · POST /van-stock/loads بـtype ADJUST يقبل reason من VAN_ADJUST_REASONS: الصالح يُحفظ، وغير المعروف 400 ADJUST_REASON_INVALID
//    للواجهة بلا حركة، ويُهمل بتحذير ADJUST_REASON_IGNORED لمفتاح API («الربط لا يُرفض»)، ولغير ADJUST يُهمل — والغائب لا مفتاح له
//    في الإنشاء (الحركة كما كانت حرفياً).
//  · services/apiSync.ts: warehouse-entries بطابع التعديل (التصنيف والإلغاء بعد الإنشاء يغيّران الصفّ) بأعمدته الجديدة، والملّي
//    (BigInt) يخرج net/tax/total أرقاماً — وسبب تسوية السيارة وعملة الفاتورة ومندوب السند المحذوف في مواردها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ القاعدة في الذاكرة: ما يلمسه مسار التسوية غير المتتبَّعة وحده ═══
const T = 't1';
type Row = Record<string, unknown>;
interface S { loads: Row[]; createData: Row[]; seq: number }
let S: S = { loads: [], createData: [], seq: 0 };
const reset = () => { S = { loads: [], createData: [], seq: 0 }; };
const PRODUCTS = [{ id: 'pU', tenantId: T, name: 'ماء', unit: 'حبة', code: 'pU', primaryUnitId: null, lotTracked: false, lotTrackedSince: null, shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, deletedAt: null, baseConvertedAt: null }];

const db: Record<string, unknown> = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
    if (sql.includes('FOR KEY SHARE')) {
      const ids = values[1] as string[];
      return PRODUCTS.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, unit: p.unit, lotTracked: false, lotTrackedSince: null }));
    }
    throw new Error(`SQL غير متوقَّع: ${sql}`);
  },
  $executeRaw: async () => 1,
  tenant: { findUnique: async () => ({ id: T, lotTrackingEnabled: false, warehouseEnabled: true, locationsEnabled: false }) },
  glSettings: { findUnique: async () => null },
  companySettings: { findUnique: async () => null },
  salesRep: {
    findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'r1'
      ? { id: 'r1', tenantId: T, name: 'سالم', canManageVanStock: true, locationId: null, tenant: { locationsEnabled: false, lotTrackingEnabled: false, warehouseEnabled: true } }
      : null),
  },
  product: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => PRODUCTS.filter((p) => where.id.in.includes(p.id)).map((p) => ({ ...p, units: [] })) },
  productUnit: { findMany: async () => [] },
  vanLoad: {
    create: async ({ data }: { data: Row & { items: { create: Row[] } } }) => {
      S.createData.push(data);
      const load = { id: `vl${++S.seq}`, ...data, reason: (data.reason as string | undefined) ?? null, items: data.items.create.map((c) => ({ ...c, product: PRODUCTS[0] })) };
      S.loads.push(load);
      return load;
    },
  },
};
db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
  const snap = { loads: [...S.loads], createData: [...S.createData] };
  try { return await fn(db); } catch (e) { Object.assign(S, snap); throw e; }
};
stub('config/database', { default: db });
stub('middleware/auth', {
  authenticate: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdmin: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAccounting: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireAdminPermission: () => (_q: unknown, _s: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});
stub('services/adminScope', {
  canAccessRep: async () => true, adminRepFilter: async () => ({}), adminScopeEnabled: async () => false,
  scopedRepRecordWhere: async () => ({}), scopedRecordWhere: async () => ({}), SHAPE_INVOICE_RECEIPT: {},
});

/* eslint-disable @typescript-eslint/no-var-requires */
const router = require('../routes/vanStock').default as Router;
const { errorHandler } = require('../middleware/errorHandler') as { errorHandler: (...a: unknown[]) => void };
const sync = require('../services/apiSync') as typeof import('../services/apiSync');
const { VAN_ADJUST_REASONS } = require('../services/suppliers/core') as typeof import('../services/suppliers/core');
/* eslint-enable @typescript-eslint/no-var-requires */

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (...a: unknown[]) => unknown }[] }; handle: (...a: unknown[]) => unknown }
const layers = (router as unknown as { stack: Layer[] }).stack;
const errLayer = layers.find((l) => !l.route && l.handle.length === 4)!;
const loadsHandler = layers.find((l) => l.route?.path === '/loads' && l.route.methods.post)!.route!.stack.slice(-1)[0].handle;
interface Res { statusCode: number; body: Record<string, unknown> | null; status(c: number): Res; json(b: unknown): Res }
const ADMIN = { role: 'ADMIN', id: 'adm1', tenantId: T, name: 'مدير' };
const API = { ...ADMIN, apiKeyId: 'k1' };
async function post(body: Row, user: unknown = ADMIN): Promise<Res> {
  const res: Res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = JSON.parse(JSON.stringify(b)); return this; } };
  const req = { user, body, query: {}, headers: {}, params: {}, path: '/loads', method: 'POST' };
  let err: unknown = null;
  await loadsHandler(req, res, (e?: unknown) => { if (e) err = e; });
  if (err) {
    let passed: unknown = null;
    errLayer.handle(err, req, res, (e?: unknown) => { passed = e ?? null; });
    if (passed) errorHandler(passed, req, res, () => undefined);
  }
  return res;
}
const ADJ = { salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pU', qty: -2 }] };

test('سبب تسوية السيارة: القائمة كما في العقد، والصالح يُحفظ (بلا حساسية لحالة الأحرف) ويعود في الردّ', async () => {
  assert.deepEqual([...VAN_ADJUST_REASONS], ['COUNT', 'DAMAGE', 'EXPIRY', 'SHORTAGE_REP', 'SAMPLE', 'OTHER']);
  for (const reason of ['SHORTAGE_REP', 'count', ' Damage ']) {
    reset();
    const r = await post({ ...ADJ, reason });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    assert.equal(S.createData[0].reason, reason.trim().toUpperCase());
    assert.equal((r.body!.data as Row).reason, reason.trim().toUpperCase());
    assert.equal('warnings' in r.body!, false);
  }
});

test('سببٌ غير معروف: الواجهة 400 ADJUST_REASON_INVALID بلا حركة، ومفتاح API يُحفظ بلا سبب وبتحذير ADJUST_REASON_IGNORED', async () => {
  reset();
  const ui = await post({ ...ADJ, reason: 'STOLEN' });
  assert.equal(ui.statusCode, 400, JSON.stringify(ui.body));
  assert.equal(ui.body!.code, 'ADJUST_REASON_INVALID');
  assert.equal(S.loads.length, 0);
  const api = await post({ ...ADJ, reason: 'STOLEN' }, API);
  assert.equal(api.statusCode, 201, JSON.stringify(api.body));
  assert.equal('reason' in S.createData[0], false);
  assert.deepEqual((api.body!.warnings as Row[]).map((w) => w.code), ['ADJUST_REASON_IGNORED']);
  // نوعٌ غير نصّي من الواجهة: الرفض نفسه
  assert.equal((await post({ ...ADJ, reason: 7 })).statusCode, 400);
});

test('بلا سبب أو لغير التسوية: الحركة كما كانت حرفياً — لا مفتاح reason في الإنشاء', async () => {
  reset();
  assert.equal((await post(ADJ)).statusCode, 201);
  assert.equal((await post({ ...ADJ, reason: '' })).statusCode, 201);
  // التنزيل (لا تسوية): السبب يُهمل بلا تحذير — وصفٌ لا يخصّ الحركة
  const unload = await post({ salesRepId: 'r1', type: 'UNLOAD', reason: 'DAMAGE', items: [{ productId: 'pU', qty: 3 }] });
  assert.equal(unload.statusCode, 201, JSON.stringify(unload.body));
  assert.equal('warnings' in unload.body!, false);
  assert.deepEqual(S.createData.map((d) => 'reason' in d), [false, false, false]);
});

// ═══ المزامنة ═══

test('warehouse-entries بطابع التعديل: «منذ» بـupdatedAt والمؤشّر به — التصنيف والإلغاء بعد الإنشاء يصلان المُكامِل', () => {
  const def = sync.syncResource('warehouse-entries')!;
  assert.equal(def.mode, 'updated');
  const since = new Date('2026-11-01T00:00:00Z');
  assert.deepEqual(sync.sinceWhere(def, since), { updatedAt: { gte: since } });
  assert.deepEqual(sync.orderByFor(def), [{ updatedAt: 'asc' }, { id: 'asc' }]);
  const sel = def.select as Record<string, unknown> & { items: { select: Record<string, unknown> } };
  for (const c of ['updatedAt', 'source', 'status', 'reason', 'vendorId', 'paymentMode', 'paidAccountRef', 'supplierRef', 'billDate', 'dueDate',
    'costsIncludeTax', 'vatTreatment', 'returnOfEntryId', 'netMilli', 'taxMilli', 'totalMilli']) assert.equal(sel[c], true, c);
  for (const c of ['taxPct', 'enteredUnitCost', 'unitCost', 'lineRef']) assert.equal(sel.items.select[c], true, `items.${c}`);
  // والأعمدة الجديدة في الموارد الأخرى
  assert.equal((sync.syncResource('van-loads')!.select as Row).reason, true);
  assert.equal((sync.syncResource('receipts')!.select as Row).deletedSalesRepId, true);
  assert.equal((sync.syncResource('invoices')!.select as Row).currency, true);
});

test('الملّي لا يخرج BigInt: net/tax/total أرقامٌ بوحدة العملة (null لغير المسعَّر) والصفّ يمرّ في JSON — وبقية الموارد لا تُمسّ', () => {
  const def = sync.syncResource('warehouse-entries')!;
  const row = {
    id: 'e1', type: 'RECEIVE', paymentMode: 'CREDIT', netMilli: 2_000_000n, taxMilli: 300_000n, totalMilli: 2_300_000n,
    items: [{ productId: 'p', qty: 2, unitFactor: 12, baseQty: null, unitCost: 20, taxPct: 15, enteredUnitCost: 20 }],
  };
  const out = sync.shapeRow(def, row);
  assert.deepEqual([out.net, out.tax, out.total], [2000, 300, 2300]);
  assert.ok(!('netMilli' in out) && !('totalMilli' in out));
  assert.deepEqual((out.items as Row[])[0].baseQty, 24, 'baseQty الفارغ يُحسب كما كان');
  assert.doesNotThrow(() => JSON.stringify(out));
  const unpriced = sync.shapeRow(def, { id: 'e2', netMilli: null, taxMilli: null, totalMilli: null, items: [] });
  assert.deepEqual([unpriced.net, unpriced.tax, unpriced.total], [null, null, null]);
  // الملّي الكبير والكسري بدقّته: 123456789.125
  assert.equal(sync.shapeRow(def, { id: 'e3', totalMilli: 123_456_789_125n }).total, 123456789.125);
  const cust = { id: 'c1', name: 'x' };
  assert.equal(sync.shapeRow(sync.syncResource('customers')!, cust), cust, 'موردٌ آخر بلا ملّي يمرّ كما هو');
});
