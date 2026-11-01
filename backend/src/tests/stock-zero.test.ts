// «تصفير المخزون» (طلب المالك ١ نوفمبر ٢٠٢٦) — GET /api/stock-zero/preview و POST /api/stock-zero بقاعدة مزيّفة في الذاكرة
// تحاكي التجميعات (SQL lotsDb وstockZero) من صفوفها، ومعاملةٍ تتراجع، وخادمٍ على 127.0.0.1 (لا قاعدة ولا شبكة): من يصفّر، والتأكيد،
// والتكرار بالـzeroRef، و«لا شيء يُصفَّر»، وأصناف اللوط، وأسطر المستودع والسيارات بدلائها، والمحذوف والمطفأ، وشرط ما بعد التصفير
// والانشغال — مع حرّاس نصّية على التركيب في index.ts وعلى zeroRunId في سجلّات المستودع والسيارات.
import { guardHits } from '../compliance/zatca/__fixtures__/z3-netguard';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { createStockZeroRouter, STOCK_ZERO_TX, type StockZeroDeps } from '../routes/stockZero';
import {
  STOCK_ZERO_CODES, STOCK_ZERO_NOTE, isStockZeroBusy, planStockZero, residualsOf, vanBalancesOf, warehouseBalancesOf, StockZeroError,
} from '../services/stockZero';
import { DAMAGED_VAN_SINCE } from '../services/vanDamaged';
import { requireAdmin } from '../middleware/auth';
import { errorHandler } from '../middleware/errorHandler';
import type { AuthRequest } from '../types';

after(() => { assert.equal(guardHits(), 0, 'محاولة شبكة حقيقية'); });

const SRC = path.join(__dirname, '..');
const raw = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const TENANT = 'tenant-zero';
const LATER = new Date(DAMAGED_VAN_SINCE.getTime() + 86_400_000);
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
interface Store {
  tenant: { id: string; warehouseEnabled: boolean; lotTrackingEnabled: boolean };
  products: { id: string; name: string; code: string; unit: string; status: string; lotTracked: boolean }[];
  reps: { id: string; name: string; isActive: boolean; lastSeenAt: Date | null; outboxPending: number | null }[];
  admins: { id: string; role: string; tenantId: string; isActive: boolean; scopeEnabled: boolean; canManageVanStock?: boolean | null }[];
  whEntries: Row[]; whItems: Row[]; vanLoads: Row[]; vanItems: Row[]; invoices: Row[]; invItems: Row[]; runs: Row[];
}

const ADMINS: Store['admins'] = [
  { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, isActive: true, scopeEnabled: false, canManageVanStock: true },
  // مديرٌ سُحبت منه صلاحية «مخزون السيارات» (companyUsers يسمح) — مرفوضٌ في /api/warehouse و/api/van-stock فهنا كذلك
  { id: 'admin-novan', role: 'ADMIN', tenantId: TENANT, isActive: true, scopeEnabled: false, canManageVanStock: false },
  // حسابٌ قديم بلا قيمة: الغائب/null يمرّ كعرف requireAdminPermission (`=== false`)
  { id: 'admin-nullvan', role: 'ADMIN', tenantId: TENANT, isActive: true, scopeEnabled: false, canManageVanStock: null },
  { id: 'admin-scoped', role: 'ADMIN', tenantId: TENANT, isActive: true, scopeEnabled: true },
  { id: 'admin-scoped-dep', role: 'ADMIN', tenantId: TENANT, isActive: true, scopeEnabled: false },
  { id: 'mgr-1', role: 'MANAGER', tenantId: TENANT, isActive: true, scopeEnabled: false },
  { id: 'admin-off', role: 'ADMIN', tenantId: TENANT, isActive: false, scopeEnabled: false },
  // مديرُ شركةٍ أخرى بتوكنٍ يحمل هذه الشركة — العزل من صفّه في القاعدة لا من التوكن
  { id: 'admin-moved', role: 'ADMIN', tenantId: 'tenant-other', isActive: true, scopeEnabled: false },
];

let clock = Date.parse('2026-10-20T08:00:00.000Z');
const tick = () => new Date((clock += 60_000));
let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;

function emptyStore(o: Partial<Store['tenant']> = {}): Store {
  return {
    tenant: { id: TENANT, warehouseEnabled: true, lotTrackingEnabled: false, ...o },
    products: [], reps: [], admins: ADMINS.map((a) => ({ ...a })),
    whEntries: [], whItems: [], vanLoads: [], vanItems: [], invoices: [], invItems: [], runs: [],
  };
}

// —— بناة الحركات ——
const whEntry = (s: Store, type: string, lines: { productId: string; qty: number; unitFactor?: number; baseQty?: number | null; unitCost?: number | null }[]) => {
  const id = nid('we');
  s.whEntries.push({ id, tenantId: TENANT, type, note: null, createdBy: 'مدير', zeroRunId: null, createdAt: tick() });
  for (const l of lines) {
    const f = l.unitFactor ?? 1;
    s.whItems.push({ entryId: id, productId: l.productId, qty: l.qty, unitName: null, unitFactor: f, baseQty: l.baseQty === undefined ? l.qty * f : l.baseQty, unitCost: l.unitCost ?? null });
  }
};
const vanLoad = (s: Store, rep: string | { deleted: string }, type: string, lines: { productId: string; qty: number }[]) => {
  const id = nid('vl');
  const deleted = typeof rep === 'object';
  s.vanLoads.push({ id, tenantId: TENANT, salesRepId: deleted ? null : rep, deletedSalesRepId: deleted ? rep.deleted : null, type, note: null, createdBy: 'ADMIN', zeroRunId: null, createdAt: tick() });
  for (const l of lines) s.vanItems.push({ vanLoadId: id, productId: l.productId, qty: l.qty, unitName: null, unitFactor: 1, baseQty: l.qty });
};
const invoice = (s: Store, rep: string, type: 'SALE' | 'RETURN', lines: { productId: string; qty: number; returnExpired?: boolean }[], o: { returnReason?: string; returnToStock?: boolean; status?: string } = {}) => {
  const id = nid('inv');
  s.invoices.push({ id, tenantId: TENANT, salesRepId: rep, status: o.status ?? 'CONFIRMED', type, returnToStock: o.returnToStock ?? null, returnReason: o.returnReason ?? null, createdAt: LATER, invoiceDate: LATER });
  for (const l of lines) s.invItems.push({ invoiceId: id, productId: l.productId, qty: l.qty, unitFactor: 1, baseQty: l.qty, returnExpired: l.returnExpired ?? false });
};

/**
 * السيناريو الكامل: ماء (نشط)، عصير (معطّل)، حليب (مستودعه سالب)، لبن (صفّ كرتون قديم بلا baseQty).
 * المستودع: ماء ١٠٠−٣٠−٤−٦ = ٦٠، عصير ١٠، حليب −٥، لبن ٢×١٢ = ٢٤.
 * r1: ماء ٣٠−١٠ = ٢٠ متاح و٢ تالف؛ حليب ٥−٨ = −٣ متاح و١ منتهٍ. r2 (موقوف): ماء ٤، وحليب تالف −١ (إزالةٌ بلا مرتجع).
 * gone-1: سيارة مندوب محذوف فيها ماء ٦ — لا تُمسّ.
 */
function scenario(o: Partial<Store['tenant']> = {}): Store {
  const s = emptyStore(o);
  s.products.push(
    { id: 'p1', name: 'ماء', code: 'W', unit: 'حبة', status: 'ACTIVE', lotTracked: false },
    { id: 'p2', name: 'عصير', code: 'J', unit: 'حبة', status: 'INACTIVE', lotTracked: false },
    { id: 'p3', name: 'حليب', code: 'M', unit: 'حبة', status: 'ACTIVE', lotTracked: false },
    { id: 'p4', name: 'لبن', code: 'L', unit: 'حبة', status: 'ACTIVE', lotTracked: false },
  );
  s.reps.push(
    { id: 'r1', name: 'أحمد', isActive: true, lastSeenAt: new Date('2026-10-31T10:00:00Z'), outboxPending: 3 },
    { id: 'r2', name: 'سالم', isActive: false, lastSeenAt: new Date('2026-09-01T10:00:00Z'), outboxPending: 5 },
  );
  whEntry(s, 'RECEIVE', [{ productId: 'p1', qty: 100, unitCost: 2 }, { productId: 'p2', qty: 10, unitCost: 5 }]);
  // صفٌّ سبق الوحدات المتعددة: كرتونان بمعامل ١٢ بلا baseQty — الرصيد ٢٤ حبة من اللقطة، والتكلفة ٢٤ للكرتون = ٢ للحبة
  whEntry(s, 'RECEIVE', [{ productId: 'p4', qty: 2, unitFactor: 12, baseQty: null, unitCost: 24 }]);
  vanLoad(s, 'r1', 'LOAD', [{ productId: 'p1', qty: 30 }, { productId: 'p3', qty: 5 }]);
  vanLoad(s, 'r2', 'LOAD', [{ productId: 'p1', qty: 4 }]);
  vanLoad(s, { deleted: 'gone-1' }, 'LOAD', [{ productId: 'p1', qty: 6 }]);
  invoice(s, 'r1', 'SALE', [{ productId: 'p1', qty: 10 }, { productId: 'p3', qty: 8 }]);
  invoice(s, 'r1', 'RETURN', [{ productId: 'p1', qty: 2 }], { returnReason: 'DAMAGED', returnToStock: true });
  invoice(s, 'r1', 'RETURN', [{ productId: 'p3', qty: 1, returnExpired: true }], { returnToStock: true });
  // فاتورةٌ ملغاة لا تدخل الرصيد
  invoice(s, 'r1', 'SALE', [{ productId: 'p1', qty: 999 }], { status: 'CANCELLED' });
  vanLoad(s, 'r2', 'DAMAGED_OUT', [{ productId: 'p3', qty: 1 }]);
  return s;
}

const baseOf = (r: Row) => (r.baseQty ?? r.qty * (r.unitFactor || 1)) as number;
const render = (strings: TemplateStringsArray, values: unknown[]) => {
  const q = Prisma.sql(strings, ...(values as Prisma.Sql[]));
  return { sql: q.text.replace(/\s+/g, ' ').trim(), values: q.values };
};
const groupSum = <K extends string>(rows: Row[], keyOf: (r: Row) => Record<K, unknown>, qty: (r: Row) => number) => {
  const m = new Map<string, Row>();
  for (const r of rows) {
    const k = keyOf(r);
    const id = JSON.stringify(k);
    const cur = m.get(id) ?? { ...k, qty: 0 };
    cur.qty += qty(r);
    m.set(id, cur);
  }
  return [...m.values()];
};
const pick = (r: Row | undefined, select?: Record<string, unknown>) => (r && select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r ?? null);

interface FakeOpts {
  lockHeld?: boolean;
  freezeError?: unknown;
  /** يُستدعى عند ربط التشغيلة بحركاتها — بعد الكتابة وقبل شرط ما بعد التصفير (يحاكي كاتباً تسلّل) */
  afterWrite?: (s: Store) => void;
}

function fakeDb(store: Store, o: FakeOpts = {}) {
  const calls: string[] = [];
  const txOpts: unknown[] = [];
  const live = () => new Set(store.reps.map((r) => r.id));
  const whType = (entryId: string) => store.whEntries.find((e) => e.id === entryId)!;
  const vl = (id: string) => store.vanLoads.find((v) => v.id === id)!;
  const inv = (id: string) => store.invoices.find((i) => i.id === id)!;

  const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { sql } = render(strings, values);
    calls.push(`query:${sql.slice(0, 60)}`);
    if (sql.includes('pg_try_advisory_xact_lock')) return [{ ok: !o.lockHeld }];
    if (sql.includes('FROM products') && sql.includes('FOR UPDATE')) {
      if (o.freezeError) throw o.freezeError;
      return [...store.products].sort((a, b) => a.id.localeCompare(b.id)).map((p) => ({ id: p.id, name: p.name, lotTracked: p.lotTracked }));
    }
    if (sql.includes('FROM warehouse_entry_items')) {
      return groupSum(store.whItems, (r) => ({ productId: r.productId, type: whType(r.entryId).type }), baseOf);
    }
    if (sql.includes('FROM van_load_items') && sql.includes('"deletedSalesRepId" IS NOT NULL')) {
      return groupSum(store.vanItems.filter((r) => vl(r.vanLoadId).salesRepId === null && vl(r.vanLoadId).deletedSalesRepId),
        (r) => ({ vanKey: vl(r.vanLoadId).deletedSalesRepId, type: vl(r.vanLoadId).type }), baseOf);
    }
    if (sql.includes('FROM van_load_items') && sql.includes("vl.type IN ('LOAD', 'UNLOAD')")) {
      return groupSum(store.vanItems.filter((r) => ['LOAD', 'UNLOAD'].includes(vl(r.vanLoadId).type)), (r) => ({ productId: r.productId, type: vl(r.vanLoadId).type }), baseOf);
    }
    if (sql.includes('FROM van_load_items') && sql.includes('"salesRepId" = ANY')) {
      const reps = live();
      return groupSum(store.vanItems.filter((r) => reps.has(vl(r.vanLoadId).salesRepId)),
        (r) => ({ productId: r.productId, vanKey: vl(r.vanLoadId).salesRepId, type: vl(r.vanLoadId).type }), baseOf);
    }
    if (sql.includes('FROM invoice_items')) {
      const reps = live();
      return groupSum(store.invItems.filter((r) => inv(r.invoiceId).status === 'CONFIRMED' && reps.has(inv(r.invoiceId).salesRepId) && r.productId), (r) => {
        const i = inv(r.invoiceId);
        return {
          productId: r.productId, lotId: null, vanKey: i.salesRepId, type: i.type, returnToStock: i.returnToStock, returnExpired: r.returnExpired,
          damaged: i.returnReason === 'DAMAGED' && i.createdAt >= DAMAGED_VAN_SINCE, held: false, firstAt: null, src: 'TOT',
        };
      }, baseOf);
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
        Object.assign(store, snap); // التراجع: كل ما كُتب داخل المعاملة يزول
        throw e;
      }
    },
    admin: { findUnique: async (a: Row) => { calls.push('admin.findUnique'); return pick(store.admins.find((x) => x.id === a.where.id), a.select); } },
    tenant: { findUnique: async (a: Row) => pick(store.tenant, a.select) },
    product: {
      findMany: async (a: Row) => [...store.products].sort((x, y) => x.id.localeCompare(y.id))
        .map((p) => pick({ ...p, units: [], primaryUnitId: null }, a.select)),
    },
    salesRep: {
      findMany: async (a: Row) => store.reps
        .filter((r) => !a.where.outboxPending || (r.outboxPending ?? 0) > a.where.outboxPending.gt)
        .filter((r) => !a.where.lastSeenAt || (r.lastSeenAt !== null && r.lastSeenAt >= a.where.lastSeenAt.gte))
        .map((r) => pick(r, a.select)),
    },
    warehouseEntryItem: {
      findMany: async () => store.whItems.map((i) => ({ ...i, entry: { type: whType(i.entryId).type, createdAt: whType(i.entryId).createdAt } })),
      createMany: async (a: Row) => { calls.push('warehouseEntryItem.createMany'); store.whItems.push(...a.data.map((d: Row) => ({ unitCost: null, ...d }))); return { count: a.data.length }; },
    },
    vanLoadItem: {
      findMany: async () => store.vanItems.map((i) => {
        const v = vl(i.vanLoadId);
        return { ...i, vanLoad: { type: v.type, createdAt: v.createdAt, salesRepId: v.salesRepId, deletedSalesRepId: v.deletedSalesRepId } };
      }),
      createMany: async (a: Row) => { calls.push('vanLoadItem.createMany'); store.vanItems.push(...a.data); return { count: a.data.length }; },
    },
    warehouseEntry: {
      create: async (a: Row) => { calls.push('warehouseEntry.create'); const id = nid('we'); store.whEntries.push({ id, createdAt: tick(), supplier: null, ...a.data }); return { id }; },
    },
    vanLoad: {
      create: async (a: Row) => { calls.push('vanLoad.create'); const id = nid('vl'); store.vanLoads.push({ id, createdAt: tick(), deletedSalesRepId: null, ...a.data }); return { id }; },
    },
    stockZeroRun: {
      findUnique: async (a: Row) => pick(store.runs.find((r) => r.tenantId === a.where.tenantId_zeroRef.tenantId && r.zeroRef === a.where.tenantId_zeroRef.zeroRef), a.select),
      findFirst: async (a: Row) => pick([...store.runs].sort((x, y) => y.createdAt - x.createdAt)[0], a.select),
      create: async (a: Row) => {
        calls.push('stockZeroRun.create');
        const id = nid('run');
        store.runs.push({ id, warehouseEntryId: null, vanLoadCount: 0, createdAt: tick(), ...structuredClone(a.data) });
        return { id };
      },
      update: async (a: Row) => {
        calls.push('stockZeroRun.update');
        Object.assign(store.runs.find((r) => r.id === a.where.id)!, structuredClone(a.data));
        o.afterWrite?.(store);
        return {};
      },
    },
  };
  return { db: db as unknown as StockZeroDeps['db'], calls, txOpts };
}

const ADMIN = { id: 'admin-1', role: 'ADMIN', name: 'مدير الشركة', tenantId: TENANT };
const OWNER = { ...ADMIN, impersonated: true, by: 'owner-9', byKind: 'OWNER' };
const STAFF = { ...ADMIN, impersonated: true, by: 'staff-3', byKind: 'STAFF' };

async function serve(db: StockZeroDeps['db'], user: () => object, o: { audit?: string[]; scoped?: string[] } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => { (req as AuthRequest).user = user() as AuthRequest['user']; next(); });
  app.use('/api/stock-zero', createStockZeroRouter({
    db,
    // الإنتاج: authenticate ثم requireAccounting ثم requireAdmin — الهوية محقونة أعلاه، وrequireAdmin صرفٌ بلا قاعدة
    guards: [requireAdmin],
    scopeEnabled: async (req) => req.user?.impersonated !== true && (o.scoped ?? []).includes(req.user?.id ?? ''),
    tenantId: (req) => req.user!.tenantId!,
    decimals: async () => 2,
    audit: (line) => o.audit?.push(line),
    now: () => new Date('2026-11-01T09:00:00Z'),
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

const rowsCount = (s: Store) => [s.whEntries.length, s.whItems.length, s.vanLoads.length, s.vanItems.length, s.runs.length];
const zeroRows = (s: Store) => ({
  entries: s.whEntries.filter((e) => e.zeroRunId), loads: s.vanLoads.filter((l) => l.zeroRunId),
});
const linesOf = (s: Store, parentKey: 'entryId' | 'vanLoadId', id: string) =>
  (parentKey === 'entryId' ? s.whItems : s.vanItems).filter((i) => i[parentKey] === id)
    .map((i) => ({ productId: i.productId, qty: i.qty, unitName: i.unitName, unitFactor: i.unitFactor, baseQty: i.baseQty }))
    .sort((a, b) => a.productId.localeCompare(b.productId));

// ═══ من يصفّر ═══

test('الرفض قبل أي قراءة مخزون: مفتاح API، والمندوب، والمشرف، والمقيّد (بالصفّ أو بالنطاق)، والمعطّل، ومدير شركة أخرى، وجلسة موظف المنصة — بلا كتابة', async () => {
  const store = scenario();
  const f = fakeDb(store);
  let user: object = { ...ADMIN, apiKeyId: 'key-1' };
  const s = await serve(f.db, () => user, { scoped: ['admin-scoped-dep'] });
  const before = rowsCount(store);
  const body = { confirm: 'تصفير', zeroRef: REF(1) };
  try {
    const expect = async (u: object, status: number, code: string | null) => {
      user = u;
      for (const [m, p] of [['GET', '/preview'], ['POST', '']] as const) {
        const res = await s.call(m, p, m === 'POST' ? body : undefined);
        assert.equal(res.status, status, `${m} ${JSON.stringify(u)}`);
        if (code) assert.deepEqual(res.body, { success: false, code, message: STOCK_ZERO_CODES[code as keyof typeof STOCK_ZERO_CODES] });
      }
    };
    await expect({ ...ADMIN, apiKeyId: 'key-1' }, 403, 'API_KEY_FORBIDDEN');
    assert.ok(!f.calls.includes('admin.findUnique'), 'المفتاح يُرفض قبل قراءة الدور');
    await expect({ id: 'rep-1', role: 'SALES_REP', name: 'مندوب', tenantId: TENANT }, 403, null);
    await expect({ id: 'mgr-1', role: 'MANAGER', name: 'مشرف', tenantId: TENANT }, 403, 'STOCK_ZERO_ADMIN_ONLY');
    // توكنٌ يقول ADMIN لحسابٍ صار مشرفاً: الدور من القاعدة
    await expect({ id: 'mgr-1', role: 'ADMIN', name: 'مشرف', tenantId: TENANT }, 403, 'STOCK_ZERO_ADMIN_ONLY');
    await expect({ id: 'admin-scoped', role: 'ADMIN', name: 'مقيد', tenantId: TENANT }, 403, 'STOCK_ZERO_SCOPED');
    await expect({ id: 'admin-scoped-dep', role: 'ADMIN', name: 'مقيد', tenantId: TENANT }, 403, 'STOCK_ZERO_SCOPED');
    await expect({ id: 'admin-off', role: 'ADMIN', name: 'معطل', tenantId: TENANT }, 403, 'STOCK_ZERO_ADMIN_ONLY');
    await expect({ id: 'admin-moved', role: 'ADMIN', name: 'منقول', tenantId: TENANT }, 403, 'STOCK_ZERO_ADMIN_ONLY');
    // بلا صلاحية «مخزون السيارات»: لا قيمة مخزون في المعاينة ولا تصفير
    await expect({ id: 'admin-novan', role: 'ADMIN', name: 'بلا مخزون', tenantId: TENANT }, 403, 'STOCK_ZERO_ADMIN_ONLY');
    await expect({ id: 'ghost', role: 'ADMIN', name: 'محذوف', tenantId: TENANT }, 403, 'STOCK_ZERO_ADMIN_ONLY');
    await expect(STAFF, 403, 'STOCK_ZERO_ADMIN_ONLY');
    assert.deepEqual(rowsCount(store), before, 'لا كتابة');
    assert.equal(f.txOpts.length, 0, 'ولا معاملة');
  } finally { await s.close(); }
});

test('صلاحية «مخزون السيارات»: false ⇒ 403 في المعاينة والتنفيذ بلا قراءة مخزون ولا معاملة؛ true وnull ⇒ يمرّ', async () => {
  for (const [id, status] of [['admin-novan', 403], ['admin-1', 200], ['admin-nullvan', 200]] as const) {
    const store = scenario();
    const f = fakeDb(store);
    const s = await serve(f.db, () => ({ id, role: 'ADMIN', name: 'مدير', tenantId: TENANT }));
    try {
      const pv = await s.call('GET', '/preview');
      assert.equal(pv.status, status, `${id} preview`);
      if (status === 403) {
        assert.deepEqual(pv.body, { success: false, code: 'STOCK_ZERO_ADMIN_ONLY', message: STOCK_ZERO_CODES.STOCK_ZERO_ADMIN_ONLY });
        assert.ok(!f.calls.some((c) => c.startsWith('query:')), 'لا قراءة مخزون قبل الرفض');
      } else {
        assert.equal(typeof pv.body.data.warehouse.value, 'number');
      }
      const before = rowsCount(store);
      const res = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(5) });
      assert.equal(res.status, status, `${id} post ${JSON.stringify(res.body)}`);
      if (status === 403) {
        assert.equal(res.body.code, 'STOCK_ZERO_ADMIN_ONLY');
        assert.deepEqual(rowsCount(store), before, 'لا كتابة');
        assert.equal(f.txOpts.length, 0, 'ولا معاملة');
      } else {
        assert.equal(res.body.data.alreadyZero, false);
      }
    } finally { await s.close(); }
  }
  assert.ok(raw('routes/stockZero.ts').includes('canManageVanStock: true },'), 'الصلاحية من القاعدة لا التوكن');
});

// ═══ المعاينة ═══

test('المعاينة: المستودع والسيارات بالأساس وقيمتها بتكلفة الشراء، والمحذوف معدودٌ لا مُصفَّر، وأجهزة الصندوق الصادر النشطة، بلا كتابة', async () => {
  const store = scenario();
  const f = fakeDb(store);
  const s = await serve(f.db, () => ADMIN);
  try {
    const before = rowsCount(store);
    const res = await s.call('GET', '/preview');
    assert.equal(res.status, 200);
    const d = res.body.data;
    // ماء ٦٠ + عصير (معطّل) ١٠ + لبن (كرتون قديم) ٢٤ موجب، وحليب −٥ سالب
    assert.deepEqual(d.warehouse, { enabled: true, products: 4, positiveQty: 94, negativeQty: 5, value: 120 + 50 + 48, uncostedQty: 0 });
    // r1 ماء ٢٠ (٤٠) وحليب −٣، تالف ٢ ومنتهٍ ١؛ r2 ماء ٤ (٨) وتالف حليب −١ متروك
    assert.deepEqual(d.vans, { reps: 2, products: 2, sellableQty: 24, negativeQty: 3, unsellableQty: 3, value: 48, deletedVans: 1 });
    assert.deepEqual(d.lotBlocked, []);
    // r2 آخر ظهوره قبل ١٤ يوماً فلا يُعدّ جهازاً نشطاً
    assert.deepEqual(d.pendingDevices, [{ repId: 'r1', name: 'أحمد', outboxPending: 3 }]);
    assert.deepEqual([d.lastRun, d.alreadyZero, d.currencyDecimals], [null, false, 2]);
    assert.deepEqual(rowsCount(store), before);
    assert.equal(f.txOpts.length, 0, 'المعاينة بلا معاملة ولا قفل');
  } finally { await s.close(); }
});

// ═══ التنفيذ ═══

test('التنفيذ: تسوية مستودع واحدة بسطر −الرصيد لكل صنف (المعطّل والسالب والكرتون القديم)، وADJUST/DAMAGED_OUT/EXPIRED_OUT لكل سيارة، والمحذوف لا يُمسّ', async () => {
  const store = scenario();
  const f = fakeDb(store);
  const audit: string[] = [];
  const s = await serve(f.db, () => ADMIN, { audit });
  try {
    const gone = store.vanLoads.filter((l) => l.deletedSalesRepId).length;
    const res = await s.call('POST', '', { confirm: '  تصفير ', zeroRef: REF(10) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.equal(d.alreadyZero, false);
    assert.ok(d.runId);
    assert.deepEqual(d.vans, { reps: 2, loads: 4, products: 2 });
    assert.deepEqual(d.skipped, { deletedVans: 1, negativeUnsellable: 1 });
    assert.deepEqual(d.value, { warehouse: 218, vans: 48 });
    assert.deepEqual(f.txOpts, [STOCK_ZERO_TX]);
    assert.deepEqual(STOCK_ZERO_TX, { maxWait: 10_000, timeout: 60_000 });

    // القفل الاستشاري ثم مهلة القفل ثم تجميد الأصناف — بالترتيب، قبل أي كتابة
    const iLock = f.calls.findIndex((c) => c.includes('pg_try_advisory_xact_lock'));
    const iTimeout = f.calls.findIndex((c) => c.includes("set_config('lock_timeout'"));
    const iFreeze = f.calls.findIndex((c) => c.includes('FROM products'));
    const iWrite = f.calls.indexOf('stockZeroRun.create');
    assert.ok(iLock >= 0 && iLock < iTimeout && iTimeout < iFreeze && iFreeze < iWrite, f.calls.join('\n'));
    assert.ok(f.calls.some((c) => c === "exec:SELECT set_config('lock_timeout', ?, true)" || c.startsWith("exec:SELECT set_config('lock_timeout'")));

    const { entries, loads } = zeroRows(store);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(d.warehouse.entryId, e.id);
    assert.deepEqual([e.type, e.note, e.createdBy, e.zeroRunId, d.warehouse.products], ['ADJUST', STOCK_ZERO_NOTE, 'مدير الشركة', d.runId, 4]);
    assert.deepEqual(linesOf(store, 'entryId', e.id), [
      { productId: 'p1', qty: -60, unitName: null, unitFactor: 1, baseQty: -60 },
      { productId: 'p2', qty: -10, unitName: null, unitFactor: 1, baseQty: -10 },
      { productId: 'p3', qty: 5, unitName: null, unitFactor: 1, baseQty: 5 },
      { productId: 'p4', qty: -24, unitName: null, unitFactor: 1, baseQty: -24 },
    ]);
    assert.ok(store.whItems.filter((i) => i.entryId === e.id).every((i) => i.unitCost === null && !('unitId' in i)), 'بلا تكلفة ولا وحدة');

    const byRep = (rep: string, type: string) => loads.filter((l) => l.salesRepId === rep && l.type === type);
    assert.ok(loads.every((l) => l.note === STOCK_ZERO_NOTE && l.createdBy === 'ADMIN' && l.zeroRunId === d.runId && l.deletedSalesRepId === null));
    assert.deepEqual(linesOf(store, 'vanLoadId', byRep('r1', 'ADJUST')[0].id).map((l) => [l.productId, l.qty, l.baseQty]), [['p1', -20, -20], ['p3', 3, 3]]);
    assert.deepEqual(linesOf(store, 'vanLoadId', byRep('r1', 'DAMAGED_OUT')[0].id).map((l) => [l.productId, l.qty]), [['p1', 2]]);
    assert.deepEqual(linesOf(store, 'vanLoadId', byRep('r1', 'EXPIRED_OUT')[0].id).map((l) => [l.productId, l.qty]), [['p3', 1]]);
    assert.deepEqual(linesOf(store, 'vanLoadId', byRep('r2', 'ADJUST')[0].id).map((l) => [l.productId, l.qty]), [['p1', -4]]);
    // التالف السالب في r2 متروك: لا DAMAGED_OUT بكميةٍ سالبة
    assert.equal(byRep('r2', 'DAMAGED_OUT').length, 0);
    assert.equal(loads.length, 4);
    assert.equal(store.vanLoads.filter((l) => l.deletedSalesRepId).length, gone, 'سيارة المحذوف بلا حركة');

    const run = store.runs[0];
    assert.deepEqual([run.zeroRef, run.actorId, run.actorName, run.impersonated, run.warehouseEntryId, run.vanLoadCount], [REF(10), 'admin-1', 'مدير الشركة', false, e.id, 4]);
    assert.deepEqual(run.summary.warehouse.map((w: Row) => [w.productId, w.qty, w.value]), [['p1', 60, 120], ['p2', 10, 50], ['p3', -5, 0], ['p4', 24, 48]]);
    assert.deepEqual(run.summary.vans.find((v: Row) => v.repId === 'r1').products.map((p: Row) => [p.productId, p.remaining, p.damaged, p.expired]), [['p1', 20, 2, 0], ['p3', -3, 0, 1]]);
    assert.deepEqual(run.summary.vans.find((v: Row) => v.repId === 'r2').products.map((p: Row) => [p.productId, p.remaining, p.damaged, p.expired]), [['p1', 4, 0, 0], ['p3', 0, -1, 0]]);
    assert.deepEqual(run.summary.skipped, { deletedVans: 1, negativeUnsellable: 1 });
    assert.deepEqual(run.summary.result, d);

    assert.deepEqual(JSON.parse(audit[0]), { event: 'STOCK_ZERO', tenantId: TENANT, actorId: 'admin-1', impersonated: false, runId: d.runId, warehouseLines: 4, vanLoads: 4 });

    // بعده: كل شيء صفر — المعاينة alreadyZero، وآخر تصفير باسم فاعله، وتشغيلةٌ جديدة لا تكتب شيئاً
    const pv = (await s.call('GET', '/preview')).body.data;
    assert.equal(pv.alreadyZero, true);
    assert.deepEqual([pv.warehouse.products, pv.vans.reps, pv.vans.deletedVans], [0, 0, 1]);
    assert.deepEqual([pv.lastRun.id, pv.lastRun.actorName], [d.runId, 'مدير الشركة']);
    const before = rowsCount(store);
    const again = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(11) });
    assert.deepEqual([again.status, again.body.data.runId, again.body.data.alreadyZero], [200, null, true]);
    assert.deepEqual(again.body.data.skipped, { deletedVans: 1, negativeUnsellable: 1 });
    assert.deepEqual(rowsCount(store), before, 'لا تشغيلة ولا حركة');
    assert.equal(audit.length, 1, 'ولا سطر تدقيق');
  } finally { await s.close(); }
});

test('التكرار بالـzeroRef نفسه: الردّ المحفوظ idempotent بلا صفوف جديدة ولا معاملة', async () => {
  const store = scenario();
  const f = fakeDb(store);
  const s = await serve(f.db, () => ADMIN);
  try {
    const first = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(20) });
    assert.equal(first.status, 200);
    const before = rowsCount(store);
    const tx = f.txOpts.length;
    const second = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(20) });
    assert.deepEqual(second.body, { success: true, idempotent: true, data: first.body.data });
    assert.deepEqual(rowsCount(store), before);
    assert.equal(f.txOpts.length, tx);
  } finally { await s.close(); }
});

test('جلسة المالك تصفّر باسم «الدعم الفني» وبمعرّف OWNER: في التشغيلة وحركة المستودع وسطر التدقيق', async () => {
  const store = scenario();
  const f = fakeDb(store);
  const audit: string[] = [];
  const s = await serve(f.db, () => OWNER, { audit });
  try {
    const res = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(30) });
    assert.equal(res.status, 200);
    const run = store.runs[0];
    assert.deepEqual([run.actorId, run.actorName, run.impersonated], ['OWNER:admin-1', 'الدعم الفني', true]);
    assert.equal(zeroRows(store).entries[0].createdBy, 'الدعم الفني');
    assert.deepEqual([JSON.parse(audit[0]).actorId, JSON.parse(audit[0]).impersonated], ['OWNER:admin-1', true]);
    assert.ok(!f.calls.includes('admin.findUnique'), 'جلسة المالك لا دور يقيّدها');
  } finally { await s.close(); }
});

test('التأكيد: كلمةٌ خاطئة أو غائبة أو zeroRef غير uuid أو مفتاحٌ زائد ⇒ 400 STOCK_ZERO_CONFIRM_REQUIRED بلا كتابة ولا معاملة', async () => {
  const store = scenario();
  const f = fakeDb(store);
  const s = await serve(f.db, () => ADMIN);
  try {
    const before = rowsCount(store);
    for (const body of [
      { confirm: 'نعم', zeroRef: REF(40) }, { confirm: 'تصفير المخزون', zeroRef: REF(40) }, { zeroRef: REF(40) },
      { confirm: 'تصفير' }, { confirm: 'تصفير', zeroRef: 'abc' }, { confirm: 'تصفير', zeroRef: REF(40), force: true }, { confirm: 5, zeroRef: REF(40) },
    ]) {
      const res = await s.call('POST', '', body);
      assert.deepEqual([res.status, res.body], [400, { success: false, code: 'STOCK_ZERO_CONFIRM_REQUIRED', message: 'اكتب كلمة التأكيد تصفير' }], JSON.stringify(body));
    }
    assert.deepEqual(rowsCount(store), before);
    assert.equal(f.txOpts.length, 0);
  } finally { await s.close(); }
});

test('«تتبّع اللوط» مفعّل وصنفٌ متتبَّع له رصيد ⇒ 409 STOCK_ZERO_LOT_TRACKED بأصنافه بلا كتابة؛ والميزة مطفأة ⇒ علم الصنف لا أثر له', async () => {
  const store = scenario({ lotTrackingEnabled: true });
  store.products.find((p) => p.id === 'p3')!.lotTracked = true;
  const f = fakeDb(store);
  const s = await serve(f.db, () => ADMIN);
  try {
    const pv = (await s.call('GET', '/preview')).body.data;
    assert.deepEqual(pv.lotBlocked, [{ productId: 'p3', name: 'حليب' }]);
    const before = rowsCount(store);
    const res = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(50) });
    assert.deepEqual([res.status, res.body], [409, {
      success: false, code: 'STOCK_ZERO_LOT_TRACKED',
      // صفحة اللوط لا تصفّر: الرسالة تدلّ على تسوية النقص بالتشغيلة في مخزون الشركة وعلى مخزون السيارات (نصّ strings.ts في الواجهة نفسه)
      message: 'أصناف بتتبع اللوط لها رصيد صفر رصيد المستودع بتسوية نقص بالتشغيلة من مخزون الشركة وأزل رصيد السيارات من مخزون السيارات أولا',
      data: { products: [{ productId: 'p3', name: 'حليب' }] },
    }]);
    assert.deepEqual(rowsCount(store), before);
  } finally { await s.close(); }

  const off = scenario({ lotTrackingEnabled: false });
  off.products.find((p) => p.id === 'p3')!.lotTracked = true;
  const s2 = await serve(fakeDb(off).db, () => ADMIN);
  try {
    assert.equal((await s2.call('POST', '', { confirm: 'تصفير', zeroRef: REF(51) })).status, 200);
  } finally { await s2.close(); }
});

test('المستودع مطفأ ⇒ السيارات وحدها: لا تسوية مستودع (entryId null) ولو بقي له رصيدٌ قديم', async () => {
  const store = scenario({ warehouseEnabled: false });
  const s = await serve(fakeDb(store).db, () => ADMIN);
  try {
    const pv = (await s.call('GET', '/preview')).body.data;
    assert.deepEqual(pv.warehouse, { enabled: false, products: 0, positiveQty: 0, negativeQty: 0, value: 0, uncostedQty: 0 });
    const res = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(60) });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.data.warehouse, res.body.data.vans.loads, res.body.data.value.warehouse], [{ products: 0, entryId: null }, 4, 0]);
    assert.equal(zeroRows(store).entries.length, 0);
    assert.equal(store.runs[0].warehouseEntryId, null);
  } finally { await s.close(); }
});

test('لا شيء يُصفَّر (شركة بلا حركات) ⇒ 200 alreadyZero بلا تشغيلة ولا حركة ولا تدقيق', async () => {
  const store = emptyStore();
  store.products.push({ id: 'p1', name: 'ماء', code: 'W', unit: 'حبة', status: 'ACTIVE', lotTracked: false });
  store.reps.push({ id: 'r1', name: 'أحمد', isActive: true, lastSeenAt: null, outboxPending: null });
  const audit: string[] = [];
  const s = await serve(fakeDb(store).db, () => ADMIN, { audit });
  try {
    const res = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(70) });
    assert.deepEqual(res.body, {
      success: true,
      data: { runId: null, alreadyZero: true, warehouse: { products: 0, entryId: null }, vans: { reps: 0, loads: 0, products: 0 }, skipped: { deletedVans: 0, negativeUnsellable: 0 }, value: { warehouse: 0, vans: 0 } },
    });
    assert.deepEqual(rowsCount(store), [0, 0, 0, 0, 0]);
    assert.equal(audit.length, 0);
  } finally { await s.close(); }
});

test('شرط ما بعد التصفير: كاتبٌ لا ينتظر التجميد (إلغاء فاتورة بتحديث حالتها) التزم أثناء التصفير فبقي رصيد ⇒ 503 STOCK_ZERO_BUSY قابلٌ للإعادة وتراجعٌ كامل، وتحذير STOCK_ZERO_RESIDUAL بأوّل ٢٠ سطراً', async () => {
  const store = scenario();
  // إلغاء فاتورة البيع: تحديث حالةٍ لا إدراج سطرٍ بالصنف فلا يصطدم بـFOR UPDATE — يعيد ماء ١٠ وحليب ٨ إلى سيارة r1 بعد كتابتنا
  const cancelSale = (st: Store) => { st.invoices.find((i) => i.salesRepId === 'r1' && i.type === 'SALE' && i.status === 'CONFIRMED')!.status = 'CANCELLED'; };
  const f = fakeDb(store, { afterWrite: cancelSale });
  const audit: string[] = [];
  const s = await serve(f.db, () => ADMIN, { audit });
  const warns: string[] = [];
  const errors: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (m: unknown) => { warns.push(String(m)); };
  console.error = (m: unknown) => { errors.push(String(m)); };
  try {
    const before = rowsCount(store);
    const statuses = store.invoices.map((i) => i.status);
    const res = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(80) });
    assert.deepEqual([res.status, res.body], [503, { success: false, code: 'STOCK_ZERO_BUSY', message: 'المخزون مشغول بحركة أخرى أعد المحاولة بعد لحظات' }]);
    assert.deepEqual(rowsCount(store), before, 'التراجع: لا تشغيلة ولا حركة');
    assert.deepEqual(store.invoices.map((i) => i.status), statuses, 'والمزيّفة تتراجع بما فيها');
    assert.equal(zeroRows(store).loads.length + zeroRows(store).entries.length, 0);
    assert.equal(audit.length, 0, 'لا سطر تدقيق نجاح');
    assert.equal(errors.length, 0, 'ليس خطأ سلامة');
    const line = warns.map((w) => { try { return JSON.parse(w); } catch { return null; } }).find((j) => j?.event === 'STOCK_ZERO_RESIDUAL');
    assert.ok(line, warns.join('\n'));
    assert.equal(line.tenantId, TENANT);
    assert.ok(line.residuals.includes('VAN:r1:p1:remaining:10') && line.residuals.includes('VAN:r1:p3:remaining:8'), JSON.stringify(line));

    // الإعادة بعد التزام الإلغاء تقرأ الرصيد الجديد فتصفّره
    const retry = await serve(fakeDb(store).db, () => ADMIN);
    try {
      cancelSale(store);
      const ok = await retry.call('POST', '', { confirm: 'تصفير', zeroRef: REF(81) });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(zeroRows(store).loads.length, 4);
    } finally { await retry.close(); }
  } finally { console.warn = origWarn; console.error = origError; await s.close(); }
});

test('سطر البقيّة محدودٌ بعشرين، وبيانات 5xx لا تصل العميل', async () => {
  const store = scenario();
  // ثلاثون صنفاً بلا رصيد — والمزيّفة تُدخل لكلٍّ منها وارداً بعد كتابتنا (ثلاثون بقيّة في المستودع)
  for (let i = 0; i < 30; i += 1) store.products.push({ id: `px${String(i).padStart(2, '0')}`, name: `صنف ${i}`, code: `X${i}`, unit: 'حبة', status: 'ACTIVE', lotTracked: false });
  const f = fakeDb(store, { afterWrite: (st) => whEntry(st, 'RECEIVE', st.products.filter((p) => p.id.startsWith('px')).map((p) => ({ productId: p.id, qty: 1 }))) });
  const s = await serve(f.db, () => ADMIN);
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (m: unknown) => { warns.push(String(m)); };
  try {
    const res = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(82) });
    assert.equal(res.status, 503);
    assert.ok(!('data' in res.body));
    const line = JSON.parse(warns.find((w) => w.includes('STOCK_ZERO_RESIDUAL'))!);
    assert.equal(line.residuals.length, 20);
  } finally { console.warn = origWarn; await s.close(); }
});

test('تصفيرٌ آخر قيد التنفيذ ⇒ 409 STOCK_ZERO_IN_PROGRESS، وانتظار قفل صنف أو تعذّر التسلسل ⇒ 503 STOCK_ZERO_BUSY — بلا كتابة', async () => {
  for (const [o, status, code] of [
    [{ lockHeld: true }, 409, 'STOCK_ZERO_IN_PROGRESS'],
    [{ freezeError: Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } }) }, 503, 'STOCK_ZERO_BUSY'],
    [{ freezeError: Object.assign(new Error('could not serialize access'), { code: '40001' }) }, 503, 'STOCK_ZERO_BUSY'],
    [{ freezeError: Object.assign(new Error('Transaction API error: expired transaction'), { code: 'P2028' }) }, 503, 'STOCK_ZERO_BUSY'],
  ] as const) {
    const store = scenario();
    const s = await serve(fakeDb(store, o).db, () => ADMIN);
    try {
      const before = rowsCount(store);
      const res = await s.call('POST', '', { confirm: 'تصفير', zeroRef: REF(90) });
      assert.deepEqual([res.status, res.body], [status, { success: false, code, message: STOCK_ZERO_CODES[code] }]);
      assert.deepEqual(rowsCount(store), before);
    } finally { await s.close(); }
  }
  assert.equal(isStockZeroBusy(new StockZeroError(409, 'STOCK_ZERO_IN_PROGRESS')), false, 'رفض التطبيق ليس انشغالاً');
  assert.equal(isStockZeroBusy(new Error('boom')), false);
});

// ═══ الدوالّ الصرفة ═══

test('الطيّ الصرف: المستودع بستّ منازل (لا غبار يبقى بعد السطر)، والسيارة بدلائها، والخطة تترك السالب من التالف والمنتهي', () => {
  const wh = warehouseBalancesOf([
    { productId: 'a', source: 'WH', type: 'RECEIVE', qty: 1.23456 },
    { productId: 'a', source: 'VAN', type: 'LOAD', qty: 0.1 },
    { productId: 'a', source: 'VAN', type: 'ADJUST', qty: 50 }, // تسوية السيارة لا تمسّ المستودع
    { productId: 'b', source: 'WH', type: 'ADJUST', qty: -2 },
    { productId: 'b', source: 'VAN', type: 'UNLOAD', qty: 0.5 },
  ]);
  assert.deepEqual([...wh], [['a', 1.13456], ['b', -1.5]]);
  const vans = vanBalancesOf(
    [{ productId: 'a', vanKey: 'r', type: 'LOAD', qty: 5 }, { productId: 'a', vanKey: 'r', type: 'EXPIRED_OUT', qty: 1 }],
    [
      { productId: 'a', vanKey: 'r', type: 'SALE', returnToStock: null, returnExpired: false, damaged: false, qty: 1 },
      { productId: 'a', vanKey: 'r', type: 'RETURN', returnToStock: true, returnExpired: false, damaged: true, qty: 2 },
      { productId: 'a', vanKey: 'r', type: 'RETURN', returnToStock: true, returnExpired: false, damaged: false, qty: 0.5 },
      { productId: 'a', vanKey: 'r', type: 'RETURN', returnToStock: false, returnExpired: false, damaged: false, qty: 9 }, // لا يعود للسيارة
    ],
  );
  assert.deepEqual(vans.get('r')!.get('a'), { remaining: 4.5, damaged: 2, expired: -1 });
  const plan = planStockZero({
    products: [{ id: 'a', name: 'أ' }, { id: 'b', name: 'ب' }], warehouseEnabled: true, lotTrackingEnabled: false,
    balances: { warehouse: wh, vans, deletedVans: 0 },
  });
  assert.deepEqual(plan.warehouse.lines, [{ productId: 'a', balance: 1.13456 }, { productId: 'b', balance: -1.5 }]);
  assert.deepEqual([plan.vans[0].adjust, plan.vans[0].damagedOut, plan.vans[0].expiredOut], [[{ productId: 'a', qty: -4.5 }], [{ productId: 'a', qty: 2 }], []]);
  assert.deepEqual(plan.skipped, { deletedVans: 0, negativeUnsellable: 1 });
  // البقيّة: المنتهي السالب المتروك ليس بقيّة، والمتاح غير الصفري بقيّة
  assert.deepEqual(residualsOf({ warehouse: new Map([['a', 0.0000004]]), vans: new Map([['r', new Map([['a', { remaining: 0, damaged: 0, expired: -1 }]])]]), deletedVans: 2 }, true), []);
  assert.equal(residualsOf({ warehouse: new Map([['a', 0.001]]), vans: new Map(), deletedVans: 0 }, true).length, 1);
  assert.equal(residualsOf({ warehouse: new Map([['a', 0.001]]), vans: new Map(), deletedVans: 0 }, false).length, 0, 'المستودع المطفأ لا يُفحص');
});

// ═══ التركيب والسجلّات ═══

test('التركيب: /api/stock-zero في index.ts، والموجّه بحرّاس authenticate وrequireAccounting وrequireAdmin، وzeroRunId في سجلّ المستودع وحركات السيارات', () => {
  const idx = raw('index.ts');
  assert.ok(idx.includes("import stockZeroRouter from './routes/stockZero';"));
  assert.ok(idx.includes("app.use('/api/stock-zero', stockZeroRouter);"));
  const r = raw('routes/stockZero.ts');
  assert.ok(r.includes('deps.guards ?? [authenticate, requireAccounting, requireAdmin]'));
  assert.ok(r.includes("pg_try_advisory_xact_lock(hashtext(${'stock-zero:' + tid}))"));
  assert.ok(r.includes('ORDER BY id FOR UPDATE'));
  const wh = raw('routes/warehouse.ts');
  assert.ok(wh.includes('zeroRunId: e.zeroRunId ?? null,'), 'GET /api/warehouse/entries');
  const vs = raw('routes/vanStock.ts');
  assert.ok(vs.includes('zeroRunId: l.zeroRunId ?? null, salesRep:'), 'GET /api/van-stock/loads');
  assert.ok(vs.includes("by: l.createdBy, zeroRunId: l.zeroRunId ?? null,"), 'GET /api/van-stock/movements (الحركات)');
  assert.ok(vs.includes("by: 'REP', zeroRunId: null,"), 'GET /api/van-stock/movements (الفواتير)');
});
