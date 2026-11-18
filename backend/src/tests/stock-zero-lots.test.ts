// «تصفير المخزون» لأصناف اللوط تشغيلةً تشغيلة (طلب المالك ١٨ نوفمبر ٢٠٢٦ — كان 409 STOCK_ZERO_LOT_TRACKED) — بقاعدة مزيّفة في
// الذاكرة تحاكي تجميعات lotsDb (أسطر المستودع بتشغيلاتها، وصفوف van_load_item_lots وinvoice_item_lots، وعبارة UNION ALL لبنود
// الفواتير ولوطاتها) ومعاملةً تتراجع، وخادمٍ على 127.0.0.1 (لا قاعدة ولا شبكة):
//   • مستودعٌ بتشغيلتين وجزءٍ غير مسمّى ⇒ ثلاثة أسطر (−كلٍّ ومعه lotId، وغير المسمّى بلا تشغيلة) وكل رصيدٍ صفر بعدها؛
//   • سيارةٌ فيها تشغيلةٌ منتهية في المتاح ومرتجعٌ منتهٍ بتشغيلته ⇒ ADJUST بصفّ لكل تشغيلة وEXPIRED_OUT بتشغيلته؛
//   • تصفير سيارة مندوبٍ واحدة لا يمسّ تشغيلات المستودع ولا سيارةً أخرى؛
//   • رصيد تشغيلةٍ سالب يُعاد صفراً (سطرٌ موجب، وفي السيارة صفٌّ موجب داخل تسوية نقص)؛
//   • إعادة الطلب بالمرجع نفسه لا تكرّر شيئاً؛ والميزة مطفأة ⇒ السلوك كما كان بلا قراءة لوط؛ وترتيب الأقفال وشرط ما بعد التصفير.
import { guardHits } from '../compliance/zatca/__fixtures__/z3-netguard';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { createStockZeroRouter, type StockZeroDeps } from '../routes/stockZero';
import { STOCK_ZERO_NOTE, loadZeroBalances, lotPartsOf, lotPreviewOf, planStockZero, residualsOf, type ZeroBalances } from '../services/stockZero';
import type { LotDb } from '../services/lotsDb';
import { DAMAGED_VAN_SINCE } from '../services/vanDamaged';
import { requireAdmin } from '../middleware/auth';
import { errorHandler } from '../middleware/errorHandler';
import type { AuthRequest } from '../types';

after(() => { assert.equal(guardHits(), 0, 'محاولة شبكة حقيقية'); });

const TENANT = 'tenant-lots';
const LATER = new Date(DAMAGED_VAN_SINCE.getTime() + 86_400_000);
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
interface Store {
  tenant: { id: string; warehouseEnabled: boolean; lotTrackingEnabled: boolean };
  products: { id: string; name: string; code: string; unit: string; status: string; lotTracked: boolean; lotTrackedSince: Date | null }[];
  lots: { id: string; productId: string; lotNumber: string; expiryDate: string | null }[];
  reps: { id: string; name: string; isActive: boolean; lastSeenAt: Date | null; outboxPending: number | null }[];
  whEntries: Row[]; whItems: Row[]; vanLoads: Row[]; vanItems: Row[]; vanLots: Row[];
  invoices: Row[]; invItems: Row[]; invLots: Row[]; runs: Row[];
}

let clock = Date.parse('2026-11-01T08:00:00.000Z');
const tick = () => new Date((clock += 60_000));
let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;

function emptyStore(o: Partial<Store['tenant']> = {}): Store {
  return {
    tenant: { id: TENANT, warehouseEnabled: true, lotTrackingEnabled: true, ...o },
    products: [
      { id: 'p1', name: 'ماء', code: 'W', unit: 'حبة', status: 'ACTIVE', lotTracked: false, lotTrackedSince: null },
      { id: 'pL', name: 'دواء', code: 'D', unit: 'حبة', status: 'ACTIVE', lotTracked: true, lotTrackedSince: null },
    ],
    lots: [
      { id: 'lot-a', productId: 'pL', lotNumber: 'A-100', expiryDate: '2027-03-01' },
      { id: 'lot-b', productId: 'pL', lotNumber: 'B-200', expiryDate: '2026-12-15' },
      // منتهية قبل اليوم (١ نوفمبر ٢٠٢٦)
      { id: 'lot-e', productId: 'pL', lotNumber: 'E-9', expiryDate: '2026-01-10' },
    ],
    reps: [
      { id: 'r1', name: 'أحمد', isActive: true, lastSeenAt: null, outboxPending: null },
      { id: 'r2', name: 'سالم', isActive: true, lastSeenAt: null, outboxPending: null },
    ],
    whEntries: [], whItems: [], vanLoads: [], vanItems: [], vanLots: [], invoices: [], invItems: [], invLots: [], runs: [],
  };
}

// —— بناة الحركات (الكميات بالأساس) ——
const whEntry = (s: Store, type: string, lines: { productId: string; qty: number; lotId?: string | null; unitCost?: number }[]) => {
  const id = nid('we');
  s.whEntries.push({ id, tenantId: TENANT, type, note: null, createdBy: 'مدير', zeroRunId: null, createdAt: tick() });
  for (const l of lines) {
    s.whItems.push({ entryId: id, productId: l.productId, qty: l.qty, unitName: null, unitFactor: 1, baseQty: l.qty, unitCost: l.unitCost ?? null, lotId: l.lotId ?? null });
  }
};
const vanLoad = (s: Store, rep: string, type: string, lines: { productId: string; qty: number; lots?: { lotId: string | null; qty: number }[] }[]) => {
  const id = nid('vl');
  const at = tick();
  s.vanLoads.push({ id, tenantId: TENANT, salesRepId: rep, deletedSalesRepId: null, type, note: null, createdBy: 'ADMIN', zeroRunId: null, createdAt: at });
  const via = (type === 'LOAD' || type === 'UNLOAD') && s.tenant.warehouseEnabled;
  for (const l of lines) {
    const itemId = nid('vli');
    s.vanItems.push({ id: itemId, vanLoadId: id, productId: l.productId, qty: l.qty, unitName: null, unitFactor: 1, baseQty: l.qty });
    for (const r of l.lots ?? []) {
      s.vanLots.push({ vanLoadItemId: itemId, tenantId: TENANT, productId: l.productId, vanKey: rep, moveType: type, viaWarehouse: via, lotId: r.lotId, qty: r.qty, createdAt: at });
    }
  }
};
const invoice = (s: Store, rep: string, type: 'SALE' | 'RETURN', lines: { productId: string; qty: number; returnExpired?: boolean; lots?: { lotId: string | null; qty: number }[] }[],
  o: { returnToStock?: boolean } = {}) => {
  const id = nid('inv');
  s.invoices.push({ id, tenantId: TENANT, salesRepId: rep, status: 'CONFIRMED', type, returnToStock: o.returnToStock ?? null, returnReason: null, createdAt: LATER, invoiceDate: LATER });
  for (const l of lines) {
    const itemId = nid('ii');
    s.invItems.push({ id: itemId, invoiceId: id, productId: l.productId, qty: l.qty, unitFactor: 1, baseQty: l.qty, returnExpired: l.returnExpired ?? false });
    for (const r of l.lots ?? []) s.invLots.push({ invoiceId: id, invoiceItemId: itemId, productId: l.productId, lotId: r.lotId, vanKey: rep, quantity: r.qty, createdAt: LATER });
  }
};

const baseOf = (r: Row) => (r.baseQty ?? r.qty * (r.unitFactor || 1)) as number;
const render = (strings: TemplateStringsArray, values: unknown[]) => {
  const q = Prisma.sql(strings, ...(values as Prisma.Sql[]));
  return { sql: q.text.replace(/\s+/g, ' ').trim(), values: q.values };
};
const groupSum = <K extends string>(rows: Row[], keyOf: (r: Row) => Record<K, unknown>, qty: (r: Row) => number, extra?: (acc: Row, r: Row) => void) => {
  const m = new Map<string, Row>();
  for (const r of rows) {
    const k = keyOf(r);
    const id = JSON.stringify(k);
    const cur = m.get(id) ?? { ...k, qty: 0 };
    cur.qty += qty(r);
    extra?.(cur, r);
    m.set(id, cur);
  }
  return [...m.values()];
};
const pick = (r: Row | undefined, select?: Record<string, unknown>) => (r && select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r ?? null);

function fakeDb(store: Store, o: { afterWrite?: (s: Store) => void } = {}) {
  const calls: string[] = [];
  const txOpts: unknown[] = [];
  const live = () => new Set(store.reps.map((r) => r.id));
  const arrays = (vals: unknown[]) => vals.filter((v): v is string[] => Array.isArray(v));
  // سيارات الاستعلام: أول مصفوفةٍ في القيم كلها معرّفات مناديب (ANY(${keys}))، وإلا كل القائمين
  const keysOf = (vals: unknown[]) => {
    const reps = live();
    const a = arrays(vals).find((x) => x.length > 0 && x.every((v) => reps.has(v)));
    return a ? new Set(a) : reps;
  };
  // الأصناف: أول مصفوفةٍ كلها معرّفات أصناف (ANY(${pids}))
  const pidsOf = (vals: unknown[]) => {
    const ids = new Set(store.products.map((p) => p.id));
    const a = arrays(vals).find((x) => x.length > 0 && x.every((v) => ids.has(v)));
    return a ? new Set(a) : ids;
  };
  const we = (id: string) => store.whEntries.find((e) => e.id === id)!;
  const vl = (id: string) => store.vanLoads.find((v) => v.id === id)!;
  const inv = (id: string) => store.invoices.find((i) => i.id === id)!;
  const item = (id: string) => store.invItems.find((i) => i.id === id)!;

  const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { sql, values: vals } = render(strings, values);
    calls.push(`query:${sql}`);
    if (sql.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '5s' }];
    if (sql.includes('FROM products') && sql.includes('FOR UPDATE')) {
      return [...store.products].sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => ({ id: p.id, name: p.name, lotTracked: p.lotTracked, lotTrackedSince: p.lotTrackedSince }));
    }
    if (sql.includes('FROM warehouse_entry_items') && sql.includes('"lotId" IS NOT NULL')) {
      const pids = pidsOf(vals);
      return groupSum(store.whItems.filter((r) => r.lotId && pids.has(r.productId)), (r) => ({ productId: r.productId, lotId: r.lotId }), baseOf);
    }
    if (sql.includes('FROM warehouse_entry_items')) {
      return groupSum(store.whItems, (r) => ({ productId: r.productId, type: we(r.entryId).type }), baseOf);
    }
    if (sql.includes('FROM van_load_item_lots')) {
      const pids = pidsOf(vals);
      const viaOnly = sql.includes('"viaWarehouse" = true');
      const keys = keysOf(vals);
      const rows = store.vanLots.filter((r) => pids.has(r.productId)
        && (viaOnly ? r.viaWarehouse === true && ['LOAD', 'UNLOAD'].includes(r.moveType) : keys.has(r.vanKey)));
      return groupSum(rows, (r) => ({ productId: r.productId, lotId: r.lotId, vanKey: r.vanKey, moveType: r.moveType, viaWarehouse: r.viaWarehouse }), (r) => r.qty,
        (acc, r) => { if (r.qty > 0 && (!acc.firstInAt || r.createdAt < acc.firstInAt)) acc.firstInAt = r.createdAt; });
    }
    if (sql.includes('FROM lot_relabels')) return [];
    if (sql.includes('FROM van_load_items') && sql.includes('"deletedSalesRepId" IS NOT NULL')) return [];
    if (sql.includes('FROM van_load_items') && sql.includes("vl.type IN ('LOAD', 'UNLOAD')")) {
      return groupSum(store.vanItems.filter((r) => ['LOAD', 'UNLOAD'].includes(vl(r.vanLoadId).type)), (r) => ({ productId: r.productId, type: vl(r.vanLoadId).type }), baseOf);
    }
    if (sql.includes('FROM van_load_items') && sql.includes('"salesRepId" = ANY')) {
      const keys = keysOf(vals);
      return groupSum(store.vanItems.filter((r) => keys.has(vl(r.vanLoadId).salesRepId)),
        (r) => ({ productId: r.productId, vanKey: vl(r.vanLoadId).salesRepId, type: vl(r.vanLoadId).type }), baseOf);
    }
    if (sql.includes('FROM invoice_item_lots') || sql.includes('FROM invoice_items')) {
      const keys = keysOf(vals);
      const route = (i: Row, returnExpired: boolean) => ({
        type: i.type, returnToStock: i.returnToStock, returnExpired, damaged: i.returnReason === 'DAMAGED' && i.createdAt >= DAMAGED_VAN_SINCE, held: false,
      });
      const out: Row[] = [];
      if (sql.includes('FROM invoice_item_lots')) {
        const pids = pidsOf(vals);
        out.push(...groupSum(store.invLots.filter((r) => inv(r.invoiceId).status === 'CONFIRMED' && keys.has(r.vanKey) && pids.has(r.productId)),
          (r) => ({ productId: r.productId, lotId: r.lotId, vanKey: r.vanKey, ...route(inv(r.invoiceId), item(r.invoiceItemId).returnExpired), src: 'LOT' }),
          (r) => r.quantity, (acc, r) => { if (!acc.firstAt || r.createdAt < acc.firstAt) acc.firstAt = r.createdAt; }));
      }
      if (sql.includes('FROM invoice_items')) {
        out.push(...groupSum(store.invItems.filter((r) => inv(r.invoiceId).status === 'CONFIRMED' && keys.has(inv(r.invoiceId).salesRepId)),
          (r) => ({ productId: r.productId, lotId: null, vanKey: inv(r.invoiceId).salesRepId, ...route(inv(r.invoiceId), r.returnExpired), firstAt: null, src: 'TOT' }), baseOf));
      }
      return out;
    }
    throw new Error(`SQL غير متوقَّع في الاختبار: ${sql}`);
  };

  const db: Row = {
    $queryRaw: queryRaw,
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push(`exec:${render(strings, values).sql}`); return 1; },
    async $transaction(fn: (tx: unknown) => Promise<unknown>, opts: unknown) {
      txOpts.push(opts);
      const snap = structuredClone(store);
      try {
        return await fn(db);
      } catch (e) {
        Object.assign(store, snap);
        throw e;
      }
    },
    admin: { findUnique: async (a: Row) => pick({ id: 'admin-1', role: 'ADMIN', tenantId: TENANT, isActive: true, scopeEnabled: false, canManageVanStock: true }, a.select) },
    tenant: { findUnique: async (a: Row) => pick(store.tenant, a.select) },
    product: {
      findMany: async (a: Row) => [...store.products].sort((x, y) => x.id.localeCompare(y.id))
        .filter((p) => a.where?.lotTracked === undefined || p.lotTracked === a.where.lotTracked)
        .map((p) => pick({ ...p, units: [], primaryUnitId: null, deletedAt: null }, a.select)),
    },
    productLot: {
      findMany: async (a: Row) => store.lots.filter((l) => (a.where.id?.in ?? []).includes(l.id)).map((l) => pick({
        ...l, productionDate: null, expiryDate: l.expiryDate ? new Date(`${l.expiryDate}T00:00:00.000Z`) : null,
        status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date(0),
      }, a.select)),
    },
    salesRep: {
      findFirst: async (a: Row) => pick(store.reps.find((r) => r.id === a.where.id), a.select),
      findMany: async (a: Row) => store.reps
        .filter((r) => !a.where.id || r.id === a.where.id)
        .filter((r) => !a.where.outboxPending || (r.outboxPending ?? 0) > a.where.outboxPending.gt)
        .map((r) => pick(r, a.select)),
    },
    warehouseEntryItem: {
      findMany: async () => store.whItems.map((i) => ({ ...i, entry: { type: we(i.entryId).type, createdAt: we(i.entryId).createdAt } })),
      // lotId كما يرسله الكاتب حرفاً: غائبٌ للصنف غير المتتبَّع (itemsOf يُظهره ABSENT) وnull لغير المسمّى
      createMany: async (a: Row) => { calls.push('warehouseEntryItem.createMany'); store.whItems.push(...a.data.map((d: Row) => ({ unitCost: null, ...d }))); return { count: a.data.length }; },
    },
    vanLoadItem: {
      findMany: async () => store.vanItems.map((i) => {
        const v = vl(i.vanLoadId);
        return { ...i, vanLoad: { type: v.type, createdAt: v.createdAt, salesRepId: v.salesRepId, deletedSalesRepId: v.deletedSalesRepId } };
      }),
      createMany: async (a: Row) => { calls.push('vanLoadItem.createMany'); store.vanItems.push(...a.data.map((d: Row) => ({ id: nid('vli'), ...d }))); return { count: a.data.length }; },
    },
    vanLoadItemLot: {
      createMany: async (a: Row) => {
        calls.push('vanLoadItemLot.createMany');
        const at = tick();
        store.vanLots.push(...a.data.map((d: Row) => ({ createdAt: at, ...d })));
        return { count: a.data.length };
      },
    },
    warehouseEntry: {
      create: async (a: Row) => { calls.push('warehouseEntry.create'); const id = nid('we'); store.whEntries.push({ id, createdAt: tick(), ...a.data }); return { id }; },
    },
    vanLoad: {
      create: async (a: Row) => { calls.push('vanLoad.create'); const id = nid('vl'); store.vanLoads.push({ id, createdAt: tick(), deletedSalesRepId: null, ...a.data }); return { id }; },
      findFirst: async (a: Row) => pick([...store.vanLoads]
        .filter((l) => l.tenantId === a.where.tenantId && l.salesRepId === a.where.salesRepId && (!a.where.zeroRunId || l.zeroRunId))
        .sort((x, y) => y.createdAt - x.createdAt)[0], a.select),
    },
    stockZeroRun: {
      findUnique: async (a: Row) => pick(store.runs.find((r) => r.zeroRef === a.where.tenantId_zeroRef.zeroRef), a.select),
      findFirst: async (a: Row) => pick([...store.runs].filter((r) => !a.where?.id || r.id === a.where.id).sort((x, y) => y.createdAt - x.createdAt)[0], a.select),
      create: async (a: Row) => {
        calls.push('stockZeroRun.create');
        const id = nid('run');
        store.runs.push({ id, warehouseEntryId: null, vanLoadCount: 0, createdAt: tick(), ...structuredClone(a.data) });
        return { id };
      },
      update: async (a: Row) => {
        Object.assign(store.runs.find((r) => r.id === a.where.id)!, structuredClone(a.data));
        o.afterWrite?.(store);
        return {};
      },
    },
  };
  return { db: db as unknown as StockZeroDeps['db'], calls, txOpts };
}

const ADMIN = { id: 'admin-1', role: 'ADMIN', name: 'مدير الشركة', tenantId: TENANT };

async function serve(db: StockZeroDeps['db']) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => { (req as AuthRequest).user = ADMIN as AuthRequest['user']; next(); });
  app.use('/api/stock-zero', createStockZeroRouter({
    db, guards: [requireAdmin], scopeEnabled: async () => false, tenantId: (req) => req.user!.tenantId!,
    decimals: async () => 2, audit: () => undefined, now: () => new Date('2026-11-01T09:00:00Z'),
  }));
  app.use(errorHandler);
  const server = http.createServer(app);
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const call = (method: string, p: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: `/api/stock-zero${p}`, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
  return { call, close: () => new Promise((r) => server.close(r)) };
}

/** الأرصدة بعد التصفير بالقراءة نفسها التي يتحقّق بها الخادم — رصيد كل صنف وكل تشغيلة في المواقع */
const balancesOf = (f: ReturnType<typeof fakeDb>, s: Store, o: { vansOnly?: boolean; repIds?: string[] } = {}) => loadZeroBalances(
  f.db as unknown as LotDb, TENANT,
  { productIds: s.products.map((p) => p.id), repIds: o.repIds ?? s.reps.map((r) => r.id), lotProductIds: s.products.filter((p) => p.lotTracked).map((p) => p.id) },
  { vansOnly: o.vansOnly },
);
const lotMap = (m: Map<string, number> | undefined) => Object.fromEntries([...(m ?? [])].sort(([a], [b]) => a.localeCompare(b)));
const zeroOf = (s: Store) => ({ entries: s.whEntries.filter((e) => e.zeroRunId), loads: s.vanLoads.filter((l) => l.zeroRunId) });
const itemsOf = (s: Store, entryId: string) => s.whItems.filter((i) => i.entryId === entryId)
  .map((i) => ({ productId: i.productId, qty: i.qty, baseQty: i.baseQty, lotId: 'lotId' in i ? i.lotId : 'ABSENT' }));
const vanLinesOf = (s: Store, loadId: string) => s.vanItems.filter((i) => i.vanLoadId === loadId).map((i) => ({
  productId: i.productId, qty: i.qty,
  lots: s.vanLots.filter((r) => r.vanLoadItemId === i.id).map((r) => ({ lotId: r.lotId, qty: r.qty, moveType: r.moveType, viaWarehouse: r.viaWarehouse, certainty: r.certainty, vanKey: r.vanKey })),
}));
const counts = (s: Store) => [s.whEntries.length, s.whItems.length, s.vanLoads.length, s.vanItems.length, s.vanLots.length, s.runs.length];

// ═══ المستودع ═══

test('مستودعٌ بتشغيلتين وجزءٍ غير مسمّى ⇒ المعاينة بتشغيلاته، ثم ثلاثة أسطر (−كلٍّ ومعه lotId، وغير المسمّى بلا تشغيلة) وكل رصيدٍ صفر', async () => {
  const s = emptyStore();
  whEntry(s, 'RECEIVE', [
    { productId: 'pL', qty: 10, lotId: 'lot-a', unitCost: 2 }, { productId: 'pL', qty: 5, lotId: 'lot-b', unitCost: 2 },
    { productId: 'pL', qty: 3, lotId: null, unitCost: 2 }, { productId: 'p1', qty: 7, unitCost: 1 },
  ]);
  const f = fakeDb(s);
  const srv = await serve(f.db);
  try {
    const pv = await srv.call('GET', '/preview');
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    const d = pv.body.data;
    assert.equal('lotBlocked' in d, false, 'لا منع لأصناف اللوط بعد اليوم');
    assert.deepEqual(d.warehouse, { enabled: true, products: 2, positiveQty: 25, negativeQty: 0, value: 43, uncostedQty: 0 });
    // الأقرب انتهاءً أولاً، وغير المسمّى آخراً — والكمية رصيد كل جزء قبل التصفير
    assert.deepEqual(d.lotProducts, [{
      place: 'WAREHOUSE', repId: null, repName: null, productId: 'pL', name: 'دواء', lots: [
        { lotId: 'lot-b', lotNumber: 'B-200', expiryDate: '2026-12-15', bucket: 'SELLABLE', qty: 5 },
        { lotId: 'lot-a', lotNumber: 'A-100', expiryDate: '2027-03-01', bucket: 'SELLABLE', qty: 10 },
        { lotId: null, lotNumber: null, expiryDate: null, bucket: 'SELLABLE', qty: 3 },
      ],
    }]);
    assert.equal(d.lotProductsTotal, 1);
    assert.equal(f.txOpts.length, 0, 'المعاينة بلا معاملة ولا قفل');

    const res = await srv.call('POST', '', { confirm: 'تصفير', zeroRef: REF(1) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.data.warehouse.products, res.body.data.alreadyZero], [2, false]);
    const { entries, loads } = zeroOf(s);
    assert.equal(entries.length, 1);
    assert.equal(loads.length, 0);
    assert.deepEqual(itemsOf(s, entries[0].id), [
      { productId: 'p1', qty: -7, baseQty: -7, lotId: 'ABSENT' }, // الصنف العادي كما كان (بلا lotId)
      { productId: 'pL', qty: -10, baseQty: -10, lotId: 'lot-a' },
      { productId: 'pL', qty: -5, baseQty: -5, lotId: 'lot-b' },
      { productId: 'pL', qty: -3, baseQty: -3, lotId: null },
    ]);
    assert.ok(s.whItems.filter((i) => i.entryId === entries[0].id).every((i) => i.unitCost === null), 'بلا تكلفة');
    assert.equal(entries[0].note, STOCK_ZERO_NOTE);

    // كل رصيدٍ صفر: الصنف وكل تشغيلة (وغير المسمّى = الرصيد − Σ الخام)
    const after = await balancesOf(f, s);
    assert.deepEqual([after.warehouse.get('pL'), after.warehouse.get('p1')], [0, 0]);
    assert.deepEqual(lotMap(after.lots!.warehouse.get('pL')), { 'lot-a': 0, 'lot-b': 0 });
    assert.deepEqual(residualsOf(after, true), []);

    // الملخّص يسجّل التشغيلات برقمها وكميتها قبل التصفير
    const run = s.runs[0];
    assert.deepEqual(run.summary.warehouse.find((w: Row) => w.productId === 'pL').lots, [
      { lotId: 'lot-a', lotNumber: 'A-100', qty: 10 }, { lotId: 'lot-b', lotNumber: 'B-200', qty: 5 }, { lotId: null, lotNumber: null, qty: 3 },
    ]);
    assert.equal('lots' in run.summary.warehouse.find((w: Row) => w.productId === 'p1'), false);

    // ترتيب الأقفال: تجميد الأصناف FOR UPDATE ثم قفل اللوط الاستشاري (lockLotProducts على الصفوف نفسها: مهلةٌ ثم القفل ثم الاستعادة)
    // لصنفٍ متتبَّع واحد — بلا FOR KEY SHARE ثانٍ — ثم قراءة الأرصدة ثم الكتابة
    const iFreeze = f.calls.findIndex((c) => c.includes('FROM products') && c.startsWith('query:SELECT id, name'));
    const iCur = f.calls.findIndex((c) => c.includes("current_setting('lock_timeout')"));
    const lotLocks = f.calls.filter((c) => c.startsWith('exec:SELECT pg_advisory_xact_lock('));
    const iLot = f.calls.findIndex((c) => c.startsWith('exec:SELECT pg_advisory_xact_lock('));
    const iRead = f.calls.findIndex((c) => c.includes('FROM warehouse_entry_items') && c.includes('SUM'));
    const iWrite = f.calls.indexOf('warehouseEntry.create');
    assert.ok(iFreeze >= 0 && iFreeze < iCur && iCur < iLot && iLot < iWrite, f.calls.join('\n'));
    assert.ok(f.calls.slice(iLot).some((c) => c.includes('FROM van_load_item_lots')), 'قراءة اللوط بعد قفله');
    assert.ok(iRead >= 0);
    assert.equal(lotLocks.length, 1, 'قفل لوطٍ واحد لصنفٍ متتبَّع واحد');
    assert.equal(f.calls.filter((c) => c.includes('FOR KEY SHARE')).length, 0, 'لا FOR KEY SHARE ثانٍ على الصفوف المقفلة');

    // بعده: المعاينة صفر بلا أصناف لوط، وتشغيلةٌ ثانية لا تكتب شيئاً
    const pv2 = (await srv.call('GET', '/preview')).body.data;
    assert.deepEqual([pv2.alreadyZero, pv2.lotProducts, pv2.lotProductsTotal], [true, [], 0]);
  } finally { await srv.close(); }
});

test('رصيد تشغيلةٍ سالب يُعاد صفراً: المستودع بسطرٍ موجب للتشغيلة وسالبٍ لغير المسمّى، والسيارة بصفٍّ موجبٍ داخل تسوية النقص', async () => {
  const s = emptyStore();
  // المستودع: وارد ٥ بلا تشغيلة، وتسوية نقص −٢ من lot-b بلا رصيدٍ لها ⇒ الصنف ٣ = lot-b −٢ وغير المسمّى ٥
  whEntry(s, 'RECEIVE', [{ productId: 'pL', qty: 5, lotId: null, unitCost: 1 }]);
  whEntry(s, 'ADJUST', [{ productId: 'pL', qty: -2, lotId: 'lot-b' }]);
  // السيارة r1: تسوية زيادة ٦ في lot-a، وبيع ٣ (١ من lot-b بلا رصيد، و٢ من lot-a) ⇒ المتاح ٣ = lot-a ٤ وlot-b −١
  vanLoad(s, 'r1', 'ADJUST', [{ productId: 'pL', qty: 6, lots: [{ lotId: 'lot-a', qty: 6 }] }]);
  invoice(s, 'r1', 'SALE', [{ productId: 'pL', qty: 3, lots: [{ lotId: 'lot-b', qty: 1 }, { lotId: 'lot-a', qty: 2 }] }]);
  const f = fakeDb(s);
  const srv = await serve(f.db);
  try {
    const pv = (await srv.call('GET', '/preview')).body.data;
    assert.deepEqual(pv.lotProducts.map((x: Row) => [x.place, x.repId, x.lots.map((l: Row) => [l.lotId, l.bucket, l.qty])]), [
      ['WAREHOUSE', null, [['lot-b', 'SELLABLE', -2], [null, 'SELLABLE', 5]]],
      ['VAN', 'r1', [['lot-b', 'SELLABLE', -1], ['lot-a', 'SELLABLE', 4]]],
    ]);
    assert.equal(pv.lotProducts[1].repName, 'أحمد');

    const res = await srv.call('POST', '', { confirm: 'تصفير', zeroRef: REF(2) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { entries, loads } = zeroOf(s);
    assert.deepEqual(itemsOf(s, entries[0].id), [
      { productId: 'pL', qty: 2, baseQty: 2, lotId: 'lot-b' },
      { productId: 'pL', qty: -5, baseQty: -5, lotId: null },
    ]);
    assert.deepEqual(loads.map((l) => [l.salesRepId, l.type]), [['r1', 'ADJUST']]);
    // البند الصافي −٣ كالصنف العادي، وصفوفه: −٤ لـlot-a و+١ لـlot-b (السالبة تُعاد صفراً) — ومجموعها كميته (I3)
    assert.deepEqual(vanLinesOf(s, loads[0].id), [{
      productId: 'pL', qty: -3, lots: [
        { lotId: 'lot-a', qty: -4, moveType: 'ADJUST', viaWarehouse: false, certainty: 'CONFIRMED', vanKey: 'r1' },
        { lotId: 'lot-b', qty: 1, moveType: 'ADJUST', viaWarehouse: false, certainty: 'CONFIRMED', vanKey: 'r1' },
      ],
    }]);

    const after = await balancesOf(f, s);
    assert.equal(after.warehouse.get('pL'), 0);
    assert.deepEqual(lotMap(after.lots!.warehouse.get('pL')), { 'lot-b': 0 });
    assert.equal(after.vans.get('r1')!.get('pL')!.remaining, 0);
    assert.deepEqual([...after.lots!.vans.get('r1')!.get('pL')!].map(([id, x]) => [id, x.SELLABLE, x.EXPIRED, x.DAMAGED]).sort(), [['lot-a', 0, 0, 0], ['lot-b', 0, 0, 0]]);
    assert.deepEqual(residualsOf(after, true), []);
  } finally { await srv.close(); }
});

// ═══ السيارات ═══

/** r1: تحميلٌ من المستودع ١٠ (lot-a ٦، والمنتهية lot-e ٤)، وبيع ٢ من lot-a، ومرتجعٌ منتهٍ ١ من lot-e. r2: تحميل ٣ من lot-a */
function vanScenario(): Store {
  const s = emptyStore();
  whEntry(s, 'RECEIVE', [{ productId: 'pL', qty: 12, lotId: 'lot-a', unitCost: 3 }, { productId: 'pL', qty: 4, lotId: 'lot-e', unitCost: 3 }]);
  vanLoad(s, 'r1', 'LOAD', [{ productId: 'pL', qty: 10, lots: [{ lotId: 'lot-a', qty: 6 }, { lotId: 'lot-e', qty: 4 }] }]);
  vanLoad(s, 'r2', 'LOAD', [{ productId: 'pL', qty: 3, lots: [{ lotId: 'lot-a', qty: 3 }] }]);
  invoice(s, 'r1', 'SALE', [{ productId: 'pL', qty: 2, lots: [{ lotId: 'lot-a', qty: 2 }] }]);
  invoice(s, 'r1', 'RETURN', [{ productId: 'pL', qty: 1, returnExpired: true, lots: [{ lotId: 'lot-e', qty: 1 }] }], { returnToStock: true });
  return s;
}

test('سيارةٌ بتشغيلةٍ منتهية: المتاح بـADJUST صفٌّ لكل تشغيلة (والمنتهية غير المباعة منها)، والمرتجع منتهياً بـEXPIRED_OUT بتشغيلته — وكل رصيدٍ صفر', async () => {
  const s = vanScenario();
  const f = fakeDb(s);
  const srv = await serve(f.db);
  try {
    const pv = (await srv.call('GET', '/preview?salesRepId=r1')).body.data;
    assert.deepEqual(pv.lotProducts, [{
      place: 'VAN', repId: 'r1', repName: 'أحمد', productId: 'pL', name: 'دواء', lots: [
        { lotId: 'lot-e', lotNumber: 'E-9', expiryDate: '2026-01-10', bucket: 'SELLABLE', qty: 4 },
        { lotId: 'lot-a', lotNumber: 'A-100', expiryDate: '2027-03-01', bucket: 'SELLABLE', qty: 4 },
        { lotId: 'lot-e', lotNumber: 'E-9', expiryDate: '2026-01-10', bucket: 'EXPIRED', qty: 1 },
      ],
    }]);

    const res = await srv.call('POST', '', { confirm: 'تصفير', zeroRef: REF(3), salesRepId: 'r1' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { loads } = zeroOf(s);
    const byType = (t: string) => loads.find((l) => l.type === t);
    assert.deepEqual(loads.map((l) => l.type).sort(), ['ADJUST', 'EXPIRED_OUT']);
    assert.deepEqual(vanLinesOf(s, byType('ADJUST')!.id), [{
      productId: 'pL', qty: -8, lots: [
        { lotId: 'lot-a', qty: -4, moveType: 'ADJUST', viaWarehouse: false, certainty: 'CONFIRMED', vanKey: 'r1' },
        { lotId: 'lot-e', qty: -4, moveType: 'ADJUST', viaWarehouse: false, certainty: 'CONFIRMED', vanKey: 'r1' },
      ],
    }]);
    assert.deepEqual(vanLinesOf(s, byType('EXPIRED_OUT')!.id), [{
      productId: 'pL', qty: 1, lots: [{ lotId: 'lot-e', qty: 1, moveType: 'EXPIRED_OUT', viaWarehouse: false, certainty: 'CONFIRMED', vanKey: 'r1' }],
    }]);
    // الملخّص: أجزاء الصنف بدلائها قبل التصفير
    const sp = s.runs[0].summary.vans[0].products[0];
    assert.deepEqual([sp.productId, sp.remaining, sp.expired], ['pL', 8, 1]);
    assert.deepEqual(sp.lots, [
      { lotId: 'lot-a', lotNumber: 'A-100', bucket: 'SELLABLE', qty: 4 }, { lotId: 'lot-e', lotNumber: 'E-9', bucket: 'SELLABLE', qty: 4 },
      { lotId: 'lot-e', lotNumber: 'E-9', bucket: 'EXPIRED', qty: 1 },
    ]);

    const after = await balancesOf(f, s, { vansOnly: true, repIds: ['r1'] });
    assert.deepEqual(after.vans.get('r1')!.get('pL'), { remaining: 0, damaged: 0, expired: 0 });
    assert.deepEqual([...after.lots!.vans.get('r1')!.get('pL')!].map(([id, x]) => [id, x.SELLABLE, x.EXPIRED]).sort(), [['lot-a', 0, 0], ['lot-e', 0, 0]]);
    assert.deepEqual(residualsOf(after, false), []);
  } finally { await srv.close(); }
});

test('تصفير سيارة مندوبٍ واحدة لا يمسّ تشغيلات المستودع ولا سيارةً أخرى', async () => {
  const s = vanScenario();
  const f = fakeDb(s);
  const srv = await serve(f.db);
  try {
    const before = await balancesOf(f, s);
    assert.deepEqual(lotMap(before.lots!.warehouse.get('pL')), { 'lot-a': 3, 'lot-e': 0 });
    const whItemsBefore = s.whItems.length;
    const res = await srv.call('POST', '', { confirm: 'تصفير', zeroRef: REF(4), salesRepId: 'r1' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.data.scope, res.body.data.warehouse.entryId], ['VAN', null]);
    assert.equal(s.whItems.length, whItemsBefore, 'لا سطر مستودع');
    assert.ok(zeroOf(s).loads.every((l) => l.salesRepId === 'r1'));
    assert.ok(s.vanLots.filter((r) => r.vanKey === 'r2').every((r) => r.moveType === 'LOAD'), 'سيارة r2 بلا صفوفٍ جديدة');
    assert.equal(s.runs[0].warehouseZeroed, false);

    const after = await balancesOf(f, s);
    assert.equal(after.warehouse.get('pL'), 3);
    assert.deepEqual(lotMap(after.lots!.warehouse.get('pL')), { 'lot-a': 3, 'lot-e': 0 }, 'تشغيلات المستودع كما هي');
    assert.deepEqual(after.vans.get('r2')!.get('pL'), { remaining: 3, damaged: 0, expired: 0 });
    assert.deepEqual(lotMap(new Map([...after.lots!.vans.get('r2')!.get('pL')!].map(([id, x]) => [id, x.SELLABLE]))), { 'lot-a': 3 });
    assert.deepEqual(after.vans.get('r1')!.get('pL'), { remaining: 0, damaged: 0, expired: 0 });
  } finally { await srv.close(); }
});

// ═══ التكرار والانشغال والميزة المطفأة ═══

test('إعادة الطلب بالمرجع نفسه لا تكرّر: الردّ المحفوظ idempotent بلا أسطر ولا صفوف لوطٍ جديدة ولا معاملة', async () => {
  const s = vanScenario();
  const f = fakeDb(s);
  const srv = await serve(f.db);
  try {
    const first = await srv.call('POST', '', { confirm: 'تصفير', zeroRef: REF(5) });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // الشركة كلها: المستودع (lot-a ٣) وr1 وr2
    assert.deepEqual([first.body.data.warehouse.products, first.body.data.vans.reps], [1, 2]);
    const before = counts(s);
    const tx = f.txOpts.length;
    const second = await srv.call('POST', '', { confirm: 'تصفير', zeroRef: REF(5) });
    assert.deepEqual(second.body, { success: true, idempotent: true, data: first.body.data });
    assert.deepEqual(counts(s), before);
    assert.equal(f.txOpts.length, tx);
    // وتصفيرٌ جديد بعده لا يجد شيئاً
    const third = await srv.call('POST', '', { confirm: 'تصفير', zeroRef: REF(6) });
    assert.deepEqual([third.status, third.body.data.alreadyZero], [200, true]);
    assert.deepEqual(counts(s), before);
    assert.deepEqual(residualsOf(await balancesOf(f, s), true), []);
  } finally { await srv.close(); }
});

test('شرط ما بعد التصفير يشمل التشغيلات: إلغاء بيعٍ بتشغيلته التزم أثناء التصفير ⇒ 503 STOCK_ZERO_BUSY وتراجعٌ كامل بلا صفوف لوط', async () => {
  const s = vanScenario();
  const cancel = (st: Store) => { st.invoices.find((i) => i.type === 'SALE')!.status = 'CANCELLED'; };
  const f = fakeDb(s, { afterWrite: cancel });
  const srv = await serve(f.db);
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  try {
    const before = counts(s);
    const res = await srv.call('POST', '', { confirm: 'تصفير', zeroRef: REF(7), salesRepId: 'r1' });
    assert.deepEqual([res.status, res.body.code], [503, 'STOCK_ZERO_BUSY']);
    assert.deepEqual(counts(s), before, 'تراجعٌ كامل');
    const line = warns.map((w) => { try { return JSON.parse(w); } catch { return null; } }).find((x) => x?.event === 'STOCK_ZERO_RESIDUAL');
    assert.ok(line.residuals.some((r: string) => r === 'VAN:r1:pL:lot:lot-a:remaining:2'), JSON.stringify(line));
  } finally {
    console.warn = orig;
    await srv.close();
  }
});

test('الميزة مطفأة ⇒ السلوك كما كان: سطرٌ واحد للصنف بلا تشغيلة، ولا صفوف لوط، ولا قراءة لوطٍ ولا قفله', async () => {
  const s = vanScenario();
  s.tenant.lotTrackingEnabled = false;
  const f = fakeDb(s);
  const srv = await serve(f.db);
  try {
    const pv = (await srv.call('GET', '/preview')).body.data;
    assert.deepEqual([pv.lotProducts, pv.lotProductsTotal], [[], 0]);
    const lotRows = s.vanLots.length;
    const res = await srv.call('POST', '', { confirm: 'تصفير', zeroRef: REF(8) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { entries, loads } = zeroOf(s);
    assert.deepEqual(itemsOf(s, entries[0].id), [{ productId: 'pL', qty: -3, baseQty: -3, lotId: 'ABSENT' }]);
    assert.equal(s.vanLots.length, lotRows, 'لا صفوف لوط');
    assert.deepEqual(vanLinesOf(s, loads.find((l) => l.salesRepId === 'r1' && l.type === 'ADJUST')!.id), [{ productId: 'pL', qty: -8, lots: [] }]);
    for (const frag of ['van_load_item_lots', 'invoice_item_lots', 'lot_relabels', "current_setting('lock_timeout')", 'pg_advisory_xact_lock(']) {
      assert.ok(!f.calls.some((c) => c.includes(frag)), `${frag} والميزة مطفأة`);
    }
  } finally { await srv.close(); }
});

// ═══ الدوالّ الصرفة ═══

test('الصرف: أجزاء الرصيد، وصنفٌ رصيده صفر بتشغيلةٍ «شبح» يُكتب بكمية صفر وأجزائه، والدلو السالب متروكٌ بتشغيلاته خارج البقيّة', () => {
  assert.deepEqual(lotPartsOf(18, [['lot-b', 5], ['lot-a', 10], ['lot-z', 0.0000000001]]), [
    { lotId: 'lot-a', balance: 10 }, { lotId: 'lot-b', balance: 5 }, { lotId: null, balance: 3 },
  ]);
  assert.deepEqual(lotPartsOf(3, [['lot-a', 3]]), [{ lotId: 'lot-a', balance: 3 }], 'لا غير مسمّى صفري');
  assert.deepEqual(lotPartsOf(1.23456, [['lot-a', 1.2345]]), [{ lotId: 'lot-a', balance: 1.2345 }, { lotId: null, balance: 0.00006 }], 'ستّ منازل');

  const balances: ZeroBalances = {
    warehouse: new Map([['pL', 0]]),
    vans: new Map([['r1', new Map([['pL', { remaining: 0, damaged: -1, expired: 2 }]])]]),
    deletedVans: 0,
    lots: {
      tracked: new Set(['pL']),
      warehouse: new Map([['pL', new Map([['lot-a', 2]])]]),
      vans: new Map([['r1', new Map([['pL', new Map([['lot-a', { SELLABLE: 0, EXPIRED: 2, DAMAGED: 1 }]])]])]]),
      metas: new Map(),
    },
  };
  const plan = planStockZero({ products: [{ id: 'pL', name: 'دواء', lotTracked: true }], warehouseEnabled: true, lotTrackingEnabled: true, balances });
  // المستودع: الرصيد صفر وlot-a ٢ فوقه ⇒ سطرٌ بكمية صفر وجزآه (lot-a ٢ وغير المسمّى −٢)
  assert.deepEqual(plan.warehouse.lines, [{ productId: 'pL', balance: 0, lots: [{ lotId: 'lot-a', balance: 2 }, { lotId: null, balance: -2 }] }]);
  assert.equal(plan.alreadyZero, false);
  const v = plan.vans[0];
  assert.deepEqual([v.adjust, v.expiredOut], [[], [{ productId: 'pL', qty: 2, lots: [{ lotId: 'lot-a', qty: 2 }] }]]);
  // التالف السالب (−١) متروكٌ معدود — ولا DAMAGED_OUT ولو كانت فيه تشغيلةٌ موجبة
  assert.deepEqual([v.damagedOut, plan.skipped.negativeUnsellable], [[], 1]);
  // الميزة مطفأة: الخطة كما كانت (لا أجزاء ولا سطر للرصيد الصفري)
  const off = planStockZero({ products: [{ id: 'pL', name: 'دواء', lotTracked: true }], warehouseEnabled: true, lotTrackingEnabled: false, balances });
  assert.deepEqual([off.warehouse.lines, off.vans[0].expiredOut], [[], [{ productId: 'pL', qty: 2 }]]);

  // البقيّة: تشغيلة المستودع غير الصفرية بقيّة، ودلو التالف السالب المتروك بتشغيلاته ليس بقيّة
  const post: ZeroBalances = {
    ...balances,
    warehouse: new Map([['pL', 0]]),
    vans: new Map([['r1', new Map([['pL', { remaining: 0, damaged: -1, expired: 0 }]])]]),
    lots: { ...balances.lots!, warehouse: new Map([['pL', new Map([['lot-a', 0.5]])]]), vans: new Map([['r1', new Map([['pL', new Map([['lot-a', { SELLABLE: 0, EXPIRED: 0, DAMAGED: 1 }]])]])]]) },
  };
  assert.deepEqual(residualsOf(post, true), ['WH:pL:lot:lot-a:0.5']);
  assert.deepEqual(residualsOf(post, false), [], 'المستودع خارج النطاق لا يُفحص');

  // المعاينة من أسطر الخطة: التالف المتروك لا يظهر
  const items = lotPreviewOf(plan, { metas: new Map(), productNames: new Map([['pL', 'دواء']]), repNames: new Map([['r1', 'أحمد']]) });
  assert.deepEqual(items.map((x) => [x.place, x.lots.map((l) => [l.lotId, l.bucket, l.qty])]), [
    ['WAREHOUSE', [['lot-a', 'SELLABLE', 2], [null, 'SELLABLE', -2]]],
    ['VAN', [['lot-a', 'EXPIRED', 2]]],
  ]);
});
