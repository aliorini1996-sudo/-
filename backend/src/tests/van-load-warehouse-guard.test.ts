// مراجعة المخزون — حركات السيارة (POST /van-stock/loads) فوق Prisma مزيّف في الذاكرة بلا قاعدة:
//  · D2 «التحميل فوق رصيد المستودع يمنع»: المستودع مفعّل ⇒ LOAD يتجاوز رصيد صنفٍ (بالأساس، وأسطره مجموعة) 422 WAREHOUSE_INSUFFICIENT
//    بلا كتابة، لكل مُصدِر (الإدارة ومفتاح API)، والحكم داخل المعاملة تحت قفل المستودع — تحميلان متزامنان لا يمرّان معاً فوق الرصيد.
//    والشركة بلا مستودع، والتنزيل والتسوية، كما كانت.
//  · D3: LOAD لصنفٍ مؤرشف 422 PRODUCT_ARCHIVED، والتنزيل والتسوية تمرّ عليه؛ وصنفٌ غريب 400 PRODUCT_NOT_FOUND بموضع سطره (#23).
//  · D8: clientRef — المكرَّر يردّ الحركة القائمة 200 (replay: true) بلا كتابة، ولو تزامن مع أصله؛ ولشركةٍ أخرى مستقلّ؛ و?clientRef=.
//  · D9: عهدة أدوات المندوب المحذوف ظاهرة «مندوب محذوف» في الملخّص وGET /tools وتُستلم منه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ القاعدة في الذاكرة ═══

type Row = Record<string, unknown>;
interface ProductRow { id: string; tenantId: string; name: string; unit: string; code: string; primaryUnitId: string | null; status: string; deletedAt: Date | null; lotTracked: boolean }
interface UnitRow { id: string; tenantId: string; productId: string; name: string; factor: number; isActive: boolean; sortOrder: number }
interface VanLoadRow { id: string; tenantId: string; salesRepId: string | null; deletedSalesRepId: string | null; type: string; clientRef: string | null; createdAt: Date }
interface VanItemRow { id: string; vanLoadId: string; productId: string; qty: number; unitName: string | null; unitFactor: number; baseQty: number | null }
interface WhItemRow { productId: string; tenantId: string; qty: number; unitFactor: number; baseQty: number | null }
interface ToolRow { id: string; tenantId: string; salesRepId: string | null; deletedSalesRepId: string | null; type: string; toolName: string; qty: number; note: string | null; createdByName: string | null; createdAt: Date }

interface State {
  tenants: Record<string, { id: string; lotTrackingEnabled: boolean; warehouseEnabled: boolean; locationsEnabled: boolean }>;
  products: ProductRow[]; units: UnitRow[]; reps: { id: string; tenantId: string; name: string; canManageVanStock: boolean; locationId: string | null; isActive: boolean; canSellWithoutStock: boolean }[];
  vanLoads: VanLoadRow[]; vanItems: VanItemRow[]; whItems: WhItemRow[]; tools: ToolRow[];
  creates: number; log: string[]; scoped: boolean; repFilter: Row; seq: number; tick: number;
  /** نداءات findFirst بالمرجع خارج المعاملة تُخفى (محاكاة طلبٍ تزامن مع أصله فلم يره البحث الأول) */
  hidePriorOutsideTx: boolean;
}
let S: State;
const T = 't1';
const T2 = 't2';
const T0 = Date.UTC(2026, 10, 4, 8);

function reset(opts: { warehouse?: boolean } = {}): void {
  S = {
    tenants: {
      [T]: { id: T, lotTrackingEnabled: false, warehouseEnabled: opts.warehouse ?? true, locationsEnabled: false },
      [T2]: { id: T2, lotTrackingEnabled: false, warehouseEnabled: true, locationsEnabled: false },
    },
    products: [
      { id: 'pA', tenantId: T, name: 'حليب', unit: 'حبة', code: 'A', primaryUnitId: null, status: 'ACTIVE', deletedAt: null, lotTracked: false },
      { id: 'pC', tenantId: T, name: 'ماء', unit: 'قارورة', code: 'C', primaryUnitId: 'uC', status: 'ACTIVE', deletedAt: null, lotTracked: false },
      { id: 'pZ', tenantId: T, name: 'بيض قديم', unit: 'حبة', code: 'Z', primaryUnitId: null, status: 'ACTIVE', deletedAt: null, lotTracked: false },
      { id: 'pX', tenantId: T, name: 'كرتون بيض M', unit: 'كرتون', code: 'X-OLD', primaryUnitId: null, status: 'INACTIVE', deletedAt: new Date(T0), lotTracked: false },
      { id: 'q1', tenantId: T2, name: 'حليب', unit: 'حبة', code: 'A', primaryUnitId: null, status: 'ACTIVE', deletedAt: null, lotTracked: false },
    ],
    units: [{ id: 'uC', tenantId: T, productId: 'pC', name: 'كرتون', factor: 12, isActive: true, sortOrder: 0 }],
    reps: [
      { id: 'r1', tenantId: T, name: 'سالم', canManageVanStock: true, locationId: null, isActive: true, canSellWithoutStock: false },
      { id: 'r2', tenantId: T, name: 'خالد', canManageVanStock: true, locationId: null, isActive: true, canSellWithoutStock: false },
      { id: 's1', tenantId: T2, name: 'فهد', canManageVanStock: true, locationId: null, isActive: true, canSellWithoutStock: false },
    ],
    vanLoads: [], vanItems: [],
    // رصيد المستودع: حليب ١٠، وماء ٣٠ قارورة، وبيض قديم سالب (وارد ٥ وتحميلٌ سابق ٨)، والمؤرشف ٢٥، وصنف الشركة الأخرى ١٠٠
    whItems: [
      { productId: 'pA', tenantId: T, qty: 10, unitFactor: 1, baseQty: 10 },
      { productId: 'pC', tenantId: T, qty: 30, unitFactor: 1, baseQty: 30 },
      { productId: 'pZ', tenantId: T, qty: 5, unitFactor: 1, baseQty: 5 },
      { productId: 'pX', tenantId: T, qty: 25, unitFactor: 1, baseQty: 25 },
      { productId: 'q1', tenantId: T2, qty: 100, unitFactor: 1, baseQty: 100 },
    ],
    tools: [], creates: 0, log: [], scoped: false, repFilter: {}, seq: 0, tick: 0, hidePriorOutsideTx: false,
  };
  S.vanLoads.push({ id: 'old1', tenantId: T, salesRepId: 'r2', deletedSalesRepId: null, type: 'LOAD', clientRef: null, createdAt: new Date(T0 - 86_400_000) });
  S.vanItems.push({ id: 'oi1', vanLoadId: 'old1', productId: 'pZ', qty: 8, unitFactor: 1, baseQty: 8 });
}
reset();

const nid = (p: string) => `${p}${++S.seq}`;
const clock = () => new Date(T0 + (++S.tick) * 1000);
const yieldTurn = () => new Promise<void>((r) => setImmediate(r));
const loadOf = (id: string) => S.vanLoads.find((l) => l.id === id)!;
const inList = (v: unknown, x: unknown) => (v && typeof v === 'object' && 'in' in (v as object) ? (v as { in: unknown[] }).in.includes(x) : v === x);
const unitsOf = (pid: string) => S.units.filter((u) => u.productId === pid).map(({ id, name, factor, isActive }) => ({ id, name, factor, isActive }));
const loadOut = (l: VanLoadRow) => ({
  ...l, items: S.vanItems.filter((i) => i.vanLoadId === l.id).map((i) => ({ ...i, product: S.products.find((p) => p.id === i.productId) })),
});

/** قاعدة مزيّفة: `tx` نسخةٌ لكل معاملة بأقفالٍ استشارية حقيقية التزاحم (تُفكّ بنهاية المعاملة) */
function makeDb(inTx: boolean, held: (() => void)[] = [], created: string[] = []): Row {
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
      if (sql.includes('FOR KEY SHARE')) {
        S.log.push('lockBases');
        const ids = values[1] as string[];
        return S.products.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, unit: p.unit, lotTracked: p.lotTracked, lotTrackedSince: null }));
      }
      throw new Error(`SQL غير متوقَّع: ${sql}`);
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) {
        assert.ok(inTx, 'قفلٌ استشاري خارج معاملة');
        const key = String(values[0]);
        S.log.push(`lock:${key.split(':')[0]}`);
        while (locks.has(key)) await locks.get(key);
        let release!: () => void;
        locks.set(key, new Promise<void>((r) => { release = () => { locks.delete(key); r(); }; }));
        held.push(release);
      }
      return 1;
    },
    tenant: { findUnique: async ({ where }: { where: { id: string } }) => ({ ...S.tenants[where.id] }) },
    glSettings: { findUnique: async () => null },
    companySettings: { findUnique: async () => null },
    salesRep: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => {
        const r = S.reps.find((x) => x.id === where.id && x.tenantId === where.tenantId);
        const t = S.tenants[where.tenantId];
        return r ? { ...r, tenant: { locationsEnabled: t.locationsEnabled, lotTrackingEnabled: t.lotTrackingEnabled, warehouseEnabled: t.warehouseEnabled } } : null;
      },
      findMany: async ({ where }: { where: { tenantId: string } }) => S.reps.filter((r) => r.tenantId === where.tenantId),
    },
    product: {
      findMany: async ({ where }: { where: { id?: { in: string[] }; tenantId: string } }) =>
        S.products.filter((p) => p.tenantId === where.tenantId && (!where.id || where.id.in.includes(p.id))).map((p) => ({ ...p, units: unitsOf(p.id), baseConvertedAt: null })),
    },
    productUnit: {
      findMany: async ({ where }: { where: { tenantId: string; id?: { in: string[] }; productId?: { in: string[] } } }) =>
        S.units.filter((u) => u.tenantId === where.tenantId && (!where.id || where.id.in.includes(u.id)) && (!where.productId || where.productId.in.includes(u.productId))),
    },
    warehouseEntryItem: {
      findMany: async ({ where }: { where: { productId: { in: string[] }; entry: { tenantId: string } } }) => {
        S.log.push('whRead');
        await yieldTurn();
        return S.whItems.filter((i) => i.tenantId === where.entry.tenantId && where.productId.in.includes(i.productId));
      },
    },
    vanLoadItem: {
      findMany: async ({ where }: { where: { productId?: { in: string[] }; vanLoad: { tenantId: string; salesRepId?: string; type?: { in: string[] } } } }) => {
        await yieldTurn();
        return S.vanItems.map((it) => ({ it, l: loadOf(it.vanLoadId) }))
          .filter(({ it, l }) => l.tenantId === where.vanLoad.tenantId
            && (!where.productId || where.productId.in.includes(it.productId))
            && (where.vanLoad.salesRepId === undefined || l.salesRepId === where.vanLoad.salesRepId)
            && (!where.vanLoad.type || where.vanLoad.type.in.includes(l.type)))
          .map(({ it, l }) => ({ productId: it.productId, qty: it.qty, unitFactor: it.unitFactor, baseQty: it.baseQty, vanLoad: { type: l.type, createdAt: l.createdAt } }));
      },
    },
    invoiceItem: { findMany: async () => [] },
    invoiceItemLot: { findFirst: async () => null },
    vanLoad: {
      findFirst: async ({ where }: { where: Row }) => {
        if ('clientRef' in where) {
          if (!inTx && S.hidePriorOutsideTx) return null;
          const l = S.vanLoads.find((x) => x.tenantId === where.tenantId && x.clientRef === where.clientRef);
          return l ? loadOut(l) : null;
        }
        if ('deletedSalesRepId' in where) return S.vanLoads.find((x) => x.tenantId === where.tenantId && x.deletedSalesRepId === where.deletedSalesRepId) ?? null;
        // «آخر تحميل» في الملخّص
        return S.vanLoads.filter((x) => x.tenantId === where.tenantId && x.salesRepId === where.salesRepId && x.type === 'LOAD').at(-1) ?? null;
      },
      findMany: async ({ where }: { where: Row }) =>
        S.vanLoads.filter((l) => l.tenantId === where.tenantId && (where.clientRef === undefined || l.clientRef === where.clientRef))
          .map((l) => ({ ...loadOut(l), salesRep: S.reps.find((r) => r.id === l.salesRepId) ?? null, location: null })),
      count: async () => S.vanLoads.length,
      create: async ({ data }: { data: Row & { items: { create: Row[] } } }) => {
        assert.ok(inTx, 'إنشاء الحركة خارج معاملة');
        S.creates++;
        S.log.push('create');
        const load: VanLoadRow = {
          id: nid('vl'), tenantId: data.tenantId as string, salesRepId: (data.salesRepId as string | null) ?? null,
          deletedSalesRepId: (data.deletedSalesRepId as string | undefined) ?? null, type: data.type as string,
          clientRef: (data.clientRef as string | undefined) ?? null, createdAt: clock(),
        };
        S.vanLoads.push(load);
        created.push(load.id);
        for (const c of data.items.create) {
          S.vanItems.push({ id: nid('vi'), vanLoadId: load.id, productId: c.productId as string, qty: c.qty as number, unitName: (c.unitName as string | null) ?? null, unitFactor: (c.unitFactor as number) ?? 1, baseQty: (c.baseQty as number | null) ?? null });
        }
        return loadOut(load);
      },
    },
    vanToolMove: {
      findMany: async ({ where, distinct }: { where: Row; distinct?: string[] }) => {
        const rows = S.tools.filter((m) => m.tenantId === where.tenantId
          && (!('salesRepId' in where) || m.salesRepId === where.salesRepId)
          && (!('deletedSalesRepId' in where) || (where.deletedSalesRepId && typeof where.deletedSalesRepId === 'object' ? m.deletedSalesRepId != null : m.deletedSalesRepId === where.deletedSalesRepId)));
        return distinct ? [...new Map(rows.map((r) => [r.toolName, r])).values()] : rows;
      },
      findFirst: async ({ where }: { where: Row }) => S.tools.find((m) => m.tenantId === where.tenantId && m.salesRepId === where.salesRepId && m.deletedSalesRepId === where.deletedSalesRepId) ?? null,
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) S.tools.push({ id: nid('tm'), salesRepId: null, deletedSalesRepId: null, note: null, createdByName: null, createdAt: clock(), ...d } as ToolRow);
        return { count: data.length };
      },
      groupBy: async ({ where }: { where: { tenantId: string; salesRepId: { in: string[] } } }) => {
        const out = new Map<string, { salesRepId: string | null; type: string; _sum: { qty: number } }>();
        for (const m of S.tools.filter((x) => x.tenantId === where.tenantId && inList(where.salesRepId, x.salesRepId))) {
          const k = `${m.salesRepId}|${m.type}`;
          const g = out.get(k) ?? { salesRepId: m.salesRepId, type: m.type, _sum: { qty: 0 } };
          g._sum.qty += m.qty;
          out.set(k, g);
        }
        return [...out.values()];
      },
    },
  };
}
const locks = new Map<string, Promise<void>>();
const db = makeDb(false);
db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
  const held: (() => void)[] = [];
  const created: string[] = [];
  try {
    return await fn(makeDb(true, held, created));
  } catch (e) {
    // التراجع: ما كتبته هذه المعاملة وحدها (معاملةٌ متزامنة التزمت قبلها تبقى)
    S.vanLoads = S.vanLoads.filter((l) => !created.includes(l.id));
    S.vanItems = S.vanItems.filter((i) => !created.includes(i.vanLoadId));
    throw e;
  } finally {
    for (const r of held) r();
  }
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
  canAccessRep: async () => true,
  adminRepFilter: async () => S.repFilter,
  adminScopeEnabled: async () => S.scoped,
  scopedRepRecordWhere: async () => ({}),
  scopedRecordWhere: async () => ({}),
  SHAPE_INVOICE_RECEIPT: {},
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/vanStock').default as Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../middleware/errorHandler') as { errorHandler: (...a: unknown[]) => void };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ws = require('../services/warehouseStock') as typeof import('../services/warehouseStock');

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (...a: unknown[]) => unknown }[] }; handle: (...a: unknown[]) => unknown }
const layers = (router as unknown as { stack: Layer[] }).stack;
const errLayer = layers.find((l) => !l.route && l.handle.length === 4)!;
function handler(method: 'get' | 'post', p: string) {
  for (const l of layers) {
    const r = l.route;
    if (r && r.path === p && r.methods[method]) return r.stack[r.stack.length - 1].handle;
  }
  throw new Error(`نقطة غير مسجّلة: ${method} ${p}`);
}
interface Res { statusCode: number; body: Record<string, unknown> | null; status(c: number): Res; json(b: unknown): Res }
const ADMIN = { role: 'ADMIN', id: 'adm1', tenantId: T, name: 'مدير' };
const API = { ...ADMIN, name: 'مفتاح الربط', apiKeyId: 'k1' };
async function call(method: 'get' | 'post', p: string, opts: { user?: unknown; body?: unknown; query?: Record<string, string> } = {}): Promise<Res> {
  const res: Res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b as Record<string, unknown>; return this; } };
  const req = { user: opts.user ?? ADMIN, body: opts.body ?? {}, query: opts.query ?? {}, headers: {}, params: {}, path: p, method: method.toUpperCase() };
  let err: unknown = null;
  await handler(method, p)(req, res, (e?: unknown) => { if (e) err = e; });
  if (err) {
    let passed: unknown = null;
    errLayer.handle(err, req, res, (e?: unknown) => { passed = e ?? null; });
    if (passed) errorHandler(passed, req, res, () => undefined);
  }
  return res;
}
const post = (body: Row, user: unknown = ADMIN) => call('post', '/loads', { body, user });
const shortLines = (r: Res) => r.body!.lines as { index: number; indexes: number[]; productId: string; availableBase: number; requestedBase: number }[];

// ═══ D2: الحكم النقيّ ═══

test('D2 نقيّاً: أسطر الصنف تُجمع، والصافي غير الموجب لا يُحكم عليه، والرصيد الصفري أو السالب لا يُحمَّل منه', () => {
  const onHand = new Map([['a', 10], ['b', 0], ['c', -3]]);
  assert.deepEqual(ws.warehouseShortLines([{ productId: 'a', baseQty: 6, at: 0 }, { productId: 'a', baseQty: 4, at: 2 }], onHand), [], '٦+٤ = الرصيد تماماً');
  assert.deepEqual(ws.warehouseShortLines([{ productId: 'a', baseQty: 6, at: 0 }, { productId: 'b', baseQty: 1, at: 1 }, { productId: 'a', baseQty: 5, at: 3 }], onHand), [
    { index: 0, indexes: [0, 3], productId: 'a', availableBase: 10, requestedBase: 11 },
    { index: 1, indexes: [1], productId: 'b', availableBase: 0, requestedBase: 1 },
  ]);
  assert.deepEqual(ws.warehouseShortLines([{ productId: 'c', baseQty: 0.5, at: 0 }], onHand).map((l) => l.availableBase), [-3]);
  assert.deepEqual(ws.warehouseShortLines([{ productId: 'a', baseQty: 20, at: 0 }, { productId: 'a', baseQty: -15, at: 1 }], onHand), [], 'صافي ٥ ضمن الرصيد');
  assert.deepEqual(ws.warehouseShortLines([{ productId: 'zz', baseQty: 1, at: 0 }], new Map()).map((l) => l.availableBase), [0], 'صنفٌ بلا حركة رصيده صفر');
});

// ═══ D2: المسار ═══

test('D2: تحميلٌ ضمن الرصيد 201 بالأساس (الكرتون ×12)، وما يتجاوزه 422 WAREHOUSE_INSUFFICIENT بأسطره ولا شيء يُكتب', async () => {
  reset();
  const ok = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 10 }, { productId: 'pC', qty: 2, unitId: 'uC' }] });
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.body));
  assert.ok(!('warnings' in ok.body!), 'لا تحذير بعد اليوم — المنع وحده');
  const n = S.vanLoads.length;
  // الماء: ٣٠ − ٢٤ = ٦ قوارير باقية، والكرتون ١٢ ⇒ نقص. والحليب صار صفراً
  const bad = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pC', qty: 1, unitId: 'uC' }, { productId: 'pA', qty: 0 }, { productId: 'pA', qty: 1 }] });
  assert.equal(bad.statusCode, 422, JSON.stringify(bad.body));
  assert.equal(bad.body!.success, false);
  assert.equal(bad.body!.code, 'WAREHOUSE_INSUFFICIENT');
  assert.deepEqual(shortLines(bad), [
    { index: 0, indexes: [0], productId: 'pC', availableBase: 6, requestedBase: 12 },
    // موضع السطر كما أرسله العميل (السطر الصفري لا يزيحه)
    { index: 2, indexes: [2], productId: 'pA', availableBase: 0, requestedBase: 1 },
  ]);
  assert.match(String(bad.body!.message), /رصيد المستودع لا يكفي/);
  assert.match(String(bad.body!.message), /«ماء»: المتاح 6 قارورة والمطلوب 1 كرتون/, 'الكمية بوحدة عرض الصنف الرئيسية');
  assert.match(String(bad.body!.message), /«حليب»: لا رصيد له في المستودع/);
  assert.equal(S.vanLoads.length, n, 'لا حركة بعد الرفض');
});

test('D2: أسطر الصنف الواحد تُجمع (٦ + ٦ فوق ١٠)، والرصيد السالب أصلاً لا يُحمَّل منه حبة', async () => {
  reset();
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 6 }, { productId: 'pC', qty: 1 }, { productId: 'pA', qty: 6 }] });
  assert.equal(r.statusCode, 422);
  assert.deepEqual(shortLines(r), [{ index: 0, indexes: [0, 2], productId: 'pA', availableBase: 10, requestedBase: 12 }]);
  // البيض القديم: وارد ٥ وتحميلٌ سابق ٨ ⇒ −٣ في المستودع
  const neg = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pZ', qty: 1 }] });
  assert.equal(neg.statusCode, 422);
  assert.deepEqual(shortLines(neg).map((l) => [l.productId, l.availableBase, l.requestedBase]), [['pZ', -3, 1]]);
  assert.equal(S.creates, 0);
});

test('D2: مفتاح API يُمنع كاللوحة، والتنزيل والتسوية لا يُحكم عليهما بالمستودع', async () => {
  reset();
  const api = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 11 }] }, API);
  assert.equal(api.statusCode, 422, JSON.stringify(api.body));
  assert.equal(api.body!.code, 'WAREHOUSE_INSUFFICIENT');
  for (const [type, qty] of [['UNLOAD', 50], ['ADJUST', 40], ['ADJUST', -2]] as const) {
    S.log = [];
    const r = await post({ salesRepId: 'r1', type, items: [{ productId: 'pA', qty }] }, API);
    assert.equal(r.statusCode, 201, `${type}: ${JSON.stringify(r.body)}`);
    assert.ok(!S.log.includes('lock:warehouse-stock') && !S.log.includes('whRead'), `${type}: لا قفل ولا قراءة للمستودع`);
  }
});

test('D2: الشركة بلا مستودع — التحميل كما كان بلا قفلٍ ولا قراءة ولو فاق «الرصيد»', async () => {
  reset({ warehouse: false });
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 500 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepEqual(S.log, ['lockBases', 'create'], 'المسار القائم حرفياً');
});

test('D2: الترتيب داخل المعاملة — قفل الأصناف ثم قفل المستودع ثم قراءة الرصيد ثم الإنشاء', async () => {
  reset();
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 3 }] });
  assert.equal(r.statusCode, 201);
  assert.deepEqual(S.log, ['lockBases', 'lock:warehouse-stock', 'whRead', 'create']);
});

test('D2 تزامناً: تحميلان متزامنان ٨ و٨ والرصيد ١٠ — قفل المستودع يُسلسلهما فيمرّ واحدٌ ويُرفض الآخر', async () => {
  reset();
  const [a, b] = await Promise.all([
    post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 8 }] }),
    post({ salesRepId: 'r2', type: 'LOAD', items: [{ productId: 'pA', qty: 8 }] }, API),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 422], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
  const loser = a.statusCode === 422 ? a : b;
  assert.deepEqual(shortLines(loser).map((l) => [l.availableBase, l.requestedBase]), [[2, 8]], 'الثاني رأى الأول ملتزَماً');
  assert.equal(S.creates, 1);
});

test('D2: شركتان مستقلّتان — رصيد الصنف من مستودع شركته وحدها', async () => {
  reset();
  const r = await post({ salesRepId: 's1', type: 'LOAD', items: [{ productId: 'q1', qty: 90 }] }, { ...ADMIN, tenantId: T2 });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
});

// ═══ D3 و#23 ═══

test('D3: تحميل صنفٍ مؤرشف 422 PRODUCT_ARCHIVED بموضعه ولو كفاه الرصيد، والتنزيل والتسوية عليه تمرّ؛ والموقوف غير المؤرشف لا يُرفض', async () => {
  reset();
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 1 }, { productId: 'pX', qty: 1 }] });
  assert.equal(r.statusCode, 422, JSON.stringify(r.body));
  assert.deepEqual([r.body!.code, r.body!.productId, r.body!.index], ['PRODUCT_ARCHIVED', 'pX', 1]);
  assert.match(String(r.body!.message), /«كرتون بيض M» محذوف/);
  assert.equal(S.creates, 0);
  for (const [type, qty] of [['UNLOAD', 2], ['ADJUST', -1]] as const) {
    assert.equal((await post({ salesRepId: 'r1', type, items: [{ productId: 'pX', qty }] })).statusCode, 201, type);
  }
  S.products.find((p) => p.id === 'pA')!.status = 'INACTIVE';
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 1 }] })).statusCode, 201, 'الموقوف وسمٌ في العرض وحده');
});

test('#23: صنفٌ لا يتبع الشركة 400 PRODUCT_NOT_FOUND بموضع سطره قبل حلّ وحدته (لا UNIT_INVALID مضلِّل)', async () => {
  reset();
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 1 }, { productId: 'q1', qty: 1, unitId: 'uC' }] }, API);
  assert.equal(r.statusCode, 400, JSON.stringify(r.body));
  assert.deepEqual([r.body!.code, r.body!.productId, r.body!.index, r.body!.indexes], ['PRODUCT_NOT_FOUND', 'q1', 1, [1]]);
  assert.match(String(r.body!.message), /السطر 2/);
});

// ═══ D8: clientRef ═══

test('D8: المرجع يُحفظ، والمكرَّر يردّ الحركة نفسها 200 (replay) بلا كتابة ولا حكمٍ جديد بالمستودع، وGET ?clientRef= يجدها', async () => {
  reset();
  const first = await post({ salesRepId: 'r1', type: 'LOAD', clientRef: 'load-7f3a', items: [{ productId: 'pA', qty: 7 }] }, API);
  assert.equal(first.statusCode, 201, JSON.stringify(first.body));
  const id = (first.body!.data as { id: string }).id;
  assert.equal(loadOf(id).clientRef, 'load-7f3a');
  S.log = [];
  // الإعادة بعد ضياع الردّ: الرصيد صار ٣ والطلب ٧ — ومع ذلك الحركة القائمة لا 422
  const again = await post({ salesRepId: 'r1', type: 'LOAD', clientRef: 'load-7f3a', items: [{ productId: 'pA', qty: 7 }] }, API);
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.equal(again.body!.replay, true);
  assert.equal((again.body!.data as { id: string }).id, id);
  assert.deepEqual((again.body!.data as { items: { productId: string; qty: number; product: unknown }[] }).items.map((i) => [i.productId, i.qty, !!i.product]), [['pA', 7, true]], 'بشكل ردّ الإنشاء');
  assert.equal(S.creates, 1, 'لا كتابة ثانية');
  assert.deepEqual(S.log, [], 'لا قفل ولا قراءة مستودع');
  const list = await call('get', '/loads', { query: { clientRef: 'load-7f3a' } });
  assert.deepEqual((list.body!.data as { id: string }[]).map((l) => l.id), [id]);
  const none = await call('get', '/loads', { query: { clientRef: 'nope' } });
  assert.deepEqual(none.body!.data, []);
  // مرجعٌ غير صالح في القراءة يُهمل (كل الحركات)، وفي الكتابة 400
  assert.equal(((await call('get', '/loads', { query: { clientRef: 'a b' } })).body!.data as unknown[]).length, S.vanLoads.length);
  const bad = await post({ salesRepId: 'r1', type: 'LOAD', clientRef: 'a b', items: [{ productId: 'pA', qty: 1 }] });
  assert.equal(bad.statusCode, 400);
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', clientRef: 'x'.repeat(65), items: [{ productId: 'pA', qty: 1 }] })).statusCode, 400);
});

test('D8: طلبٌ مكرَّر تزامن مع أصله (لم يره البحث الأول) — القفل في المعاملة يجده فيردّه 200 بلا كتابة', async () => {
  reset();
  const first = await post({ salesRepId: 'r1', type: 'LOAD', clientRef: 'race-1', items: [{ productId: 'pA', qty: 2 }] });
  assert.equal(first.statusCode, 201);
  S.hidePriorOutsideTx = true;
  S.log = [];
  const again = await post({ salesRepId: 'r1', type: 'LOAD', clientRef: 'race-1', items: [{ productId: 'pA', qty: 2 }] });
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.equal(again.body!.replay, true);
  assert.equal(S.creates, 1);
  assert.equal(S.log[0], 'lock:van-load-ref', 'المرجع أول أقفال المعاملة');
  assert.ok(!S.log.includes('create'));
  // وطلبان متزامنان حقاً بالمرجع نفسه: حركةٌ واحدة
  reset();
  S.hidePriorOutsideTx = true;
  const both = await Promise.all([1, 2].map(() => post({ salesRepId: 'r1', type: 'LOAD', clientRef: 'twin', items: [{ productId: 'pA', qty: 1 }] })));
  assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 201]);
  assert.equal(S.vanLoads.filter((l) => l.clientRef === 'twin').length, 1);
});

test('D8: المرجع لكل شركة مستقلّ، ومرجعٌ لحركة سيارةٍ أخرى أو نوعٍ آخر 409 CLIENT_REF_REUSED بلا كتابة', async () => {
  reset();
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', clientRef: 'shared', items: [{ productId: 'pA', qty: 1 }] })).statusCode, 201);
  const other = await post({ salesRepId: 's1', type: 'LOAD', clientRef: 'shared', items: [{ productId: 'q1', qty: 1 }] }, { ...ADMIN, tenantId: T2 });
  assert.equal(other.statusCode, 201, 'شركةٌ أخرى بالمرجع نفسه حركةٌ جديدة');
  for (const body of [
    { salesRepId: 'r2', type: 'LOAD', clientRef: 'shared', items: [{ productId: 'pA', qty: 1 }] },
    { salesRepId: 'r1', type: 'UNLOAD', clientRef: 'shared', items: [{ productId: 'pA', qty: 1 }] },
  ]) {
    const r = await post(body);
    assert.equal(r.statusCode, 409, JSON.stringify(r.body));
    assert.equal(r.body!.code, 'CLIENT_REF_REUSED');
  }
  assert.equal(S.creates, 2);
});

// ═══ D9: عهدة أدوات المندوب المحذوف ═══

test('D9: عهدة المندوب المحذوف في الملخّص «مندوب محذوف» وفي GET /tools?deletedSalesRepId=، وتُستلم منه، والمقيَّد لا يراها', async () => {
  reset();
  S.tools.push(
    { id: 'm1', tenantId: T, salesRepId: null, deletedSalesRepId: 'gone1', type: 'ISSUE', toolName: 'عربة', qty: 3, note: null, createdByName: 'مدير', createdAt: new Date(T0) },
    { id: 'm2', tenantId: T, salesRepId: null, deletedSalesRepId: 'gone1', type: 'RETURN', toolName: 'عربة', qty: 1, note: null, createdByName: 'مدير', createdAt: new Date(T0 + 1) },
    { id: 'm3', tenantId: T, salesRepId: null, deletedSalesRepId: 'gone2', type: 'ISSUE', toolName: 'سلة', qty: 1, note: null, createdByName: 'مدير', createdAt: new Date(T0 + 2) },
    { id: 'm4', tenantId: T, salesRepId: null, deletedSalesRepId: 'gone2', type: 'RETURN', toolName: 'سلة', qty: 1, note: null, createdByName: 'مدير', createdAt: new Date(T0 + 3) },
    { id: 'm5', tenantId: T, salesRepId: 'r1', deletedSalesRepId: null, type: 'ISSUE', toolName: 'سلة', qty: 2, note: null, createdByName: 'مدير', createdAt: new Date(T0 + 4) },
  );
  const sum = await call('get', '/summary');
  assert.equal(sum.statusCode, 200, JSON.stringify(sum.body));
  assert.deepEqual(sum.body!.deletedTools, [{ deletedSalesRepId: 'gone1', repName: 'مندوب محذوف', toolsCount: 2, balances: [{ toolName: 'عربة', qty: 2 }] }], 'المُسلَّم كله لا يظهر');
  assert.equal((sum.body!.data as { salesRepId: string; toolsCount: number }[]).find((d) => d.salesRepId === 'r1')!.toolsCount, 2);

  const tools = await call('get', '/tools', { query: { deletedSalesRepId: 'gone1' } });
  assert.equal(tools.statusCode, 200, JSON.stringify(tools.body));
  assert.deepEqual((tools.body!.data as { balances: unknown; total: number }).balances, [{ toolName: 'عربة', qty: 2 }]);

  // الاستلام من المحذوف بسقف عهدته، والتسليم له مرفوض
  const over = await call('post', '/tools', { body: { deletedSalesRepId: 'gone1', type: 'RETURN', items: [{ toolName: 'عربة', qty: 3 }] } });
  assert.equal(over.statusCode, 400);
  const ret = await call('post', '/tools', { body: { deletedSalesRepId: 'gone1', type: 'RETURN', items: [{ toolName: 'عربة', qty: 2 }] } });
  assert.equal(ret.statusCode, 201, JSON.stringify(ret.body));
  assert.deepEqual(S.tools.at(-1)!.salesRepId, null);
  assert.equal(S.tools.at(-1)!.deletedSalesRepId, 'gone1');
  assert.deepEqual((await call('get', '/summary')).body!.deletedTools, [], 'استُلمت العهدة كلها');
  assert.equal((await call('post', '/tools', { body: { deletedSalesRepId: 'gone1', type: 'ISSUE', items: [{ toolName: 'عربة', qty: 1 }] } })).statusCode, 400);
  assert.equal((await call('post', '/tools', { body: { type: 'ISSUE', items: [{ toolName: 'عربة', qty: 1 }] } })).statusCode, 400, 'بلا مندوب');

  // مندوبٌ قائم بمعرّف «محذوف»، أو معرّفٌ بلا أثر، أو مستخدمٌ مقيَّد ⇒ 404
  assert.equal((await call('get', '/tools', { query: { deletedSalesRepId: 'r1' } })).statusCode, 404);
  assert.equal((await call('get', '/tools', { query: { deletedSalesRepId: 'ghost' } })).statusCode, 404);
  S.scoped = true;
  S.repFilter = { id: { in: ['r1'] } };
  assert.equal((await call('get', '/tools', { query: { deletedSalesRepId: 'gone1' } })).statusCode, 404);
  assert.deepEqual((await call('get', '/summary')).body!.deletedTools, [], 'المقيَّد لا تُقرأ له عهد المحذوفين');
});
