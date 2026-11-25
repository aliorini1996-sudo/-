// «قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦) — routes/vanStock.ts (POST /loads ومسارات /pending-loads) وroutes/companyVanLoadAcceptance.ts
// فوق Prisma مزيّف في الذاكرة بلا قاعدة ولا شبكة (على نمط van-load-warehouse-guard.test.ts):
//  · الإعداد مطفأ ⇒ POST /loads كما كان حرفياً (حركةٌ 201 ولا صفّ معلّق)، والمندوب ومفتاح API وإعادة الرفع والتنزيل والتسوية مباشرةً دائماً.
//  · مفعّلاً: تحميل الإدارة يُجرَّب بلا كتابة (رصيد المستودع، الأصناف والوحدات) ثم يُحفظ معلّقاً 201 { pending: true } بلا أي حركة.
//  · القبول بتوقيعٍ يكتب حركةً واحدة كالمسار المباشر حرفياً مختومةً بالقبول، تحت قفل الصفّ أولاً — والإعادة 200، والنقص 409 ويبقى معلّقاً.
//  · الاعتراض بسببٍ، والتعديل (PENDING بمراجعةٍ جديدة)، والإلغاء، ونطاق الإدارة، ورفض مفتاح API، والإعداد وإطفاؤه.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
interface ProductRow { id: string; tenantId: string; name: string; unit: string; code: string; primaryUnitId: string | null; status: string; deletedAt: Date | null; lotTracked: boolean }
interface UnitRow { id: string; tenantId: string; productId: string; name: string; factor: number; isActive: boolean; sortOrder: number }
interface VanItemRow { id: string; vanLoadId: string; productId: string; qty: number; unitName: string | null; unitFactor: number; baseQty: number | null; suggestedQty: number | null; expectedQty: number | null }
interface WhItemRow { productId: string; tenantId: string; qty: number; unitFactor: number; baseQty: number | null }

interface State {
  tenants: Record<string, { id: string; lotTrackingEnabled: boolean; warehouseEnabled: boolean; locationsEnabled: boolean }>;
  settings: Record<string, { vanLoadAcceptance: boolean }>;
  products: ProductRow[]; units: UnitRow[];
  reps: { id: string; tenantId: string; name: string; canManageVanStock: boolean; locationId: string | null; isActive: boolean }[];
  vanLoads: Row[]; vanItems: VanItemRow[]; whItems: WhItemRow[]; pending: Row[];
  log: string[]; seq: number; tick: number; settingsReads: number; pushes: { id: string; payload: Row }[];
  /** نطاق الإداري المقيّد: مناديبه */
  scoped: boolean; scopeReps: Set<string>;
  /** طلبات بضاعة المناديب (sentRef ⇐ «تحميل مباشر») وحسابات مستخدمي الشركة (دورهم من القاعدة) */
  requests: Row[]; admins: Record<string, { role: string; tenantId: string; isActive: boolean }>;
}
let S: State;
const T = 't1';
const T0 = Date.UTC(2026, 10, 22, 8);

function reset(opts: { acceptance?: boolean; warehouse?: boolean } = {}): void {
  S = {
    tenants: { [T]: { id: T, lotTrackingEnabled: false, warehouseEnabled: opts.warehouse ?? true, locationsEnabled: false } },
    settings: { [T]: { vanLoadAcceptance: opts.acceptance ?? true } },
    products: [
      { id: 'pA', tenantId: T, name: 'حليب', unit: 'حبة', code: 'A', primaryUnitId: null, status: 'ACTIVE', deletedAt: null, lotTracked: false },
      { id: 'pC', tenantId: T, name: 'ماء', unit: 'قارورة', code: 'C', primaryUnitId: 'uC', status: 'ACTIVE', deletedAt: null, lotTracked: false },
    ],
    units: [{ id: 'uC', tenantId: T, productId: 'pC', name: 'كرتون', factor: 12, isActive: true, sortOrder: 0 }],
    reps: [
      { id: 'r1', tenantId: T, name: 'سالم', canManageVanStock: true, locationId: null, isActive: true },
      { id: 'r2', tenantId: T, name: 'خالد', canManageVanStock: true, locationId: null, isActive: true },
      { id: 'r3', tenantId: T, name: 'موقوف', canManageVanStock: true, locationId: null, isActive: false },
    ],
    vanLoads: [], vanItems: [], pending: [],
    // رصيد المستودع: حليب ١٠، وماء ٣٠ قارورة
    whItems: [
      { productId: 'pA', tenantId: T, qty: 10, unitFactor: 1, baseQty: 10 },
      { productId: 'pC', tenantId: T, qty: 30, unitFactor: 1, baseQty: 30 },
    ],
    log: [], seq: 0, tick: 0, settingsReads: 0, pushes: [], scoped: false, scopeReps: new Set(),
    requests: [],
    admins: {
      adm1: { role: 'ADMIN', tenantId: T, isActive: true },
      mgr1: { role: 'MANAGER', tenantId: T, isActive: true },
      acc1: { role: 'ACCOUNTANT', tenantId: T, isActive: true },
      off1: { role: 'ADMIN', tenantId: T, isActive: false },
      oth1: { role: 'ADMIN', tenantId: 't2', isActive: true },
    },
  };
}
reset();

const nid = (p: string) => `${p}${++S.seq}`;
const clock = () => new Date(T0 + (++S.tick) * 1000);
const yieldTurn = () => new Promise<void>((r) => setImmediate(r));
const loadOf = (id: string) => S.vanLoads.find((l) => l.id === id)!;
const unitsOf = (pid: string) => S.units.filter((u) => u.productId === pid).map(({ id, name, factor, isActive }) => ({ id, name, factor, isActive }));
const loadOut = (l: Row) => ({
  ...l, items: S.vanItems.filter((i) => i.vanLoadId === l.id).map((i) => ({ ...i, product: S.products.find((p) => p.id === i.productId) ?? null })),
});
const clone = <V>(v: V): V => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** شرط صفّ المعلّق كما يبنيه المسار: مساواةٌ، و{in}، و{gte}، وقيد النطاق (salesRep) بمناديب الإداري المقيّد */
function pendingMatch(r: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (k === 'salesRep') { if (!r.salesRepId || !S.scopeReps.has(r.salesRepId)) return false; continue; }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v && !(v.in as unknown[]).includes(r[k])) return false;
      if ('gte' in v && !(r[k] && r[k] >= v.gte)) return false;
      continue;
    }
    if (r[k] !== v) return false;
  }
  return true;
}
/** شرط طلب البضاعة: مساواةٌ، و{in}، و{not} */
const reqMatch = (r: Row, where: Row): boolean => Object.entries(where).every(([k, v]) =>
  (v && typeof v === 'object' && !(v instanceof Date) ? ('in' in v ? (v.in as unknown[]).includes(r[k]) : 'not' in v ? r[k] !== v.not : true) : r[k] === v));
const pendingOut = (r: Row, select?: Row) => {
  const out: Row = { ...r, body: clone(r.body), salesRep: S.reps.find((x) => x.id === r.salesRepId) ? { name: S.reps.find((x) => x.id === r.salesRepId)!.name } : null };
  if (select && !select.signature) delete out.signature;
  return out;
};

const locks = new Map<string, Promise<void>>();

/** قاعدة مزيّفة: `tx` نسخةٌ لكل معاملة بأقفالٍ استشارية حقيقية التزاحم وسجلّ تراجعٍ لما كتبته وحدها */
function makeDb(inTx: boolean, held: (() => void)[] = [], undo: (() => void)[] = []): Row {
  const write = (fn: () => void) => { if (!inTx) throw new Error('كتابة خارج معاملة'); undo.push(fn); };
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
    admin: { findUnique: async ({ where }: { where: { id: string } }) => (S.admins[where.id] ? { ...S.admins[where.id] } : null) },
    repStockRequest: {
      findMany: async ({ where }: { where: Row }) => S.requests.filter((r) => reqMatch(r, where)).map((r) => ({ ...r })),
      findFirst: async ({ where }: { where: Row }) => { const r = S.requests.find((x) => reqMatch(x, where)); return r ? { ...r } : null; },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const r = S.requests.find((x) => x.id === where.id);
        assert.ok(r, 'تحديث طلبٍ غير موجود');
        const before = { ...r };
        Object.assign(r, data);
        // @updatedAt: يتجدّد ما لم يُكتب صراحةً
        if (!('updatedAt' in data)) r.updatedAt = clock();
        write(() => { Object.keys(r).forEach((k) => delete r[k]); Object.assign(r, before); });
        return { ...r };
      },
    },
    glSettings: { findUnique: async () => null },
    companySettings: {
      findUnique: async ({ where }: { where: { tenantId: string } }) => { S.settingsReads++; return S.settings[where.tenantId] ? { ...S.settings[where.tenantId] } : null; },
      updateMany: async ({ where, data }: { where: { tenantId: string }; data: Row }) => {
        if (!S.settings[where.tenantId]) return { count: 0 };
        Object.assign(S.settings[where.tenantId], data);
        return { count: 1 };
      },
    },
    salesRep: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => {
        const r = S.reps.find((x) => x.id === where.id && x.tenantId === where.tenantId);
        const t = S.tenants[where.tenantId];
        return r ? { ...r, tenant: { locationsEnabled: t.locationsEnabled, lotTrackingEnabled: t.lotTrackingEnabled, warehouseEnabled: t.warehouseEnabled } } : null;
      },
    },
    product: {
      findMany: async ({ where }: { where: { id?: { in: string[] }; tenantId?: string } }) =>
        S.products.filter((p) => (where.tenantId === undefined || p.tenantId === where.tenantId) && (!where.id || where.id.in.includes(p.id))).map((p) => ({ ...p, units: unitsOf(p.id), baseConvertedAt: null })),
    },
    productUnit: {
      findMany: async ({ where }: { where: { tenantId: string; id?: { in: string[] }; productId?: { in: string[] } } }) =>
        S.units.filter((u) => u.tenantId === where.tenantId && (!where.id || where.id.in.includes(u.id)) && (!where.productId || where.productId.in.includes(u.productId))),
    },
    productLot: { findMany: async () => [] },
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
          const l = S.vanLoads.find((x) => x.tenantId === where.tenantId && x.clientRef === where.clientRef);
          return l ? loadOut(l) : null;
        }
        if ('id' in where) { const l = S.vanLoads.find((x) => x.tenantId === where.tenantId && x.id === where.id); return l ? loadOut(l) : null; }
        return null;
      },
      create: async ({ data }: { data: Row & { items: { create: Row[] } } }) => {
        assert.ok(inTx, 'إنشاء الحركة خارج معاملة');
        S.log.push('create');
        const { items, ...head } = data;
        const load: Row = {
          id: nid('vl'), salesRepId: null, deletedSalesRepId: null, locationId: null, reason: null, note: null, clientRef: null,
          acceptedAt: null, pendingLoadId: null, zeroRunId: null, ...head, createdAt: clock(),
        };
        S.vanLoads.push(load);
        for (const c of items.create) {
          S.vanItems.push({
            id: nid('vi'), vanLoadId: load.id, productId: c.productId, qty: c.qty, unitName: c.unitName ?? null, unitFactor: c.unitFactor ?? 1,
            baseQty: c.baseQty ?? null, suggestedQty: c.suggestedQty ?? null, expectedQty: c.expectedQty ?? null,
          });
        }
        write(() => {
          S.vanLoads = S.vanLoads.filter((l) => l.id !== load.id);
          S.vanItems = S.vanItems.filter((i) => i.vanLoadId !== load.id);
        });
        return loadOut(load);
      },
    },
    pendingVanLoad: {
      findFirst: async ({ where, select, orderBy }: { where: Row; select?: Row; orderBy?: Row }) => {
        void orderBy;
        const r = S.pending.find((x) => pendingMatch(x, where));
        return r ? pendingOut(r, select) : null;
      },
      findMany: async ({ where, select, orderBy, take }: { where: Row; select?: Row; orderBy?: Row; take?: number }) => {
        const [k] = Object.keys(orderBy ?? { createdAt: 'desc' });
        const rows = S.pending.filter((x) => pendingMatch(x, where)).sort((a, b) => (b[k]?.getTime?.() ?? 0) - (a[k]?.getTime?.() ?? 0));
        return rows.slice(0, take ?? rows.length).map((r) => pendingOut(r, select));
      },
      count: async ({ where }: { where: Row }) => S.pending.filter((x) => pendingMatch(x, where)).length,
      create: async ({ data, select }: { data: Row; select?: Row }) => {
        const now = clock();
        const row: Row = {
          id: nid('pl'), revision: 1, note: null, clientRef: null, createdById: null, createdByName: null, disputeNote: null, disputedAt: null,
          acceptedAt: null, signature: null, acceptedLat: null, acceptedLng: null, vanLoadId: null, cancelledAt: null, cancelledById: null,
          cancelledByName: null, repName: null, ...data, body: clone(data.body), createdAt: now, updatedAt: now,
        };
        S.pending.push(row);
        write(() => { S.pending = S.pending.filter((x) => x.id !== row.id); });
        return pendingOut(row, select);
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = S.pending.find((x) => x.id === where.id);
        assert.ok(row, 'تحديث صفٍّ غير موجود');
        const before = { ...row, body: clone(row.body) };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as Row)) row[k] += (v as Row).increment;
          else row[k] = k === 'body' ? clone(v) : v;
        }
        row.updatedAt = clock();
        write(() => { Object.keys(row).forEach((k) => delete row[k]); Object.assign(row, before); });
        return pendingOut(row);
      },
    },
  };
}
const db = makeDb(false);
db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
  const held: (() => void)[] = [];
  const undo: (() => void)[] = [];
  try {
    return await fn(makeDb(true, held, undo));
  } catch (e) {
    // التراجع: ما كتبته هذه المعاملة وحدها بعكس ترتيبه (معاملةٌ متزامنة التزمت قبلها تبقى)
    for (const u of undo.reverse()) u();
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
  actorOf: (req: { user?: { id?: string; impersonated?: boolean } }) => (req.user?.impersonated ? `OWNER:${req.user?.id}` : req.user?.id ?? ''),
});
stub('services/adminScope', {
  canAccessRep: async (_req: unknown, _tid: string, id: string) => !S.scoped || S.scopeReps.has(id),
  adminRepFilter: async () => (S.scoped ? { adminScopes: { some: { adminId: 'adm1' } } } : {}),
  adminScopeEnabled: async () => S.scoped,
  scopedRepRecordWhere: async (req: { user?: { role?: string } }) => (S.scoped && req.user?.role !== 'SALES_REP' ? { salesRep: { adminScopes: { some: { adminId: 'adm1' } } } } : {}),
  scopedRecordWhere: async () => ({}),
  SHAPE_INVOICE_RECEIPT: {},
});
stub('services/webPush', {
  sendPushToRep: async (id: string, payload: Row) => { S.pushes.push({ id, payload }); return 1; },
});

/* eslint-disable @typescript-eslint/no-var-requires */
const vanStock = require('../routes/vanStock') as typeof import('../routes/vanStock');
const router = vanStock.default as Router;
const { errorHandler } = require('../middleware/errorHandler') as { errorHandler: (...a: unknown[]) => void };
const { createVanLoadAcceptanceRouter } = require('../routes/companyVanLoadAcceptance') as typeof import('../routes/companyVanLoadAcceptance');
const svc = require('../services/vanPendingLoads') as typeof import('../services/vanPendingLoads');
/* eslint-enable @typescript-eslint/no-var-requires */

type Method = 'get' | 'post' | 'put' | 'patch';
interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (...a: unknown[]) => unknown }[] }; handle: (...a: unknown[]) => unknown }
const layersOf = (r: Router) => (r as unknown as { stack: Layer[] }).stack;
function handler(r: Router, method: Method, p: string) {
  for (const l of layersOf(r)) {
    const rt = l.route;
    if (rt && rt.path === p && rt.methods[method]) return rt.stack[rt.stack.length - 1].handle;
  }
  throw new Error(`نقطة غير مسجّلة: ${method} ${p}`);
}
interface Res { statusCode: number; body: Row | null; status(c: number): Res; json(b: unknown): Res }
const ADMIN = { role: 'ADMIN', id: 'adm1', tenantId: T, name: 'مدير' };
const API = { ...ADMIN, name: 'مفتاح الربط', apiKeyId: 'k1' };
const REP1 = { role: 'SALES_REP', id: 'r1', tenantId: T, name: 'سالم' };
const REP2 = { role: 'SALES_REP', id: 'r2', tenantId: T, name: 'خالد' };
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function call(method: Method, p: string, opts: { user?: unknown; body?: unknown; query?: Record<string, string>; params?: Record<string, string>; headers?: Record<string, string>; on?: Router } = {}): Promise<Res> {
  const r = opts.on ?? router;
  const res: Res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b as Row; return this; } };
  const req = { user: opts.user ?? ADMIN, body: opts.body ?? {}, query: opts.query ?? {}, headers: opts.headers ?? {}, params: opts.params ?? {}, path: p, method: method.toUpperCase() };
  let err: unknown = null;
  await handler(r, method, p)(req, res, (e?: unknown) => { if (e) err = e; });
  if (err) {
    const errLayer = layersOf(r).find((l) => !l.route && l.handle.length === 4);
    let passed: unknown = err;
    if (errLayer) { passed = null; errLayer.handle(err, req, res, (e?: unknown) => { passed = e ?? null; }); }
    if (passed) errorHandler(passed, req, res, () => undefined);
  }
  return res;
}
const postLoad = (body: Row, user: unknown = ADMIN, headers?: Record<string, string>) => call('post', '/loads', { body, user, headers });
const accept = (id: string, body: Row = {}, user: unknown = REP1, headers?: Record<string, string>) =>
  call('post', '/pending-loads/:id/accept', { params: { id }, body: { signature: SIG, revision: 1, ...body }, user, headers });
const dispute = (id: string, note: unknown, user: unknown = REP1) => call('post', '/pending-loads/:id/dispute', { params: { id }, body: { note }, user });
const edit = (id: string, body: Row, user: unknown = ADMIN) => call('put', '/pending-loads/:id', { params: { id }, body, user });
const cancel = (id: string, body: Row = {}, user: unknown = ADMIN) => call('post', '/pending-loads/:id/cancel', { params: { id }, body, user });
const settle = async () => { for (let i = 0; i < 5; i++) await yieldTurn(); };
/** شكل الحركة وبنودها بلا المعرّفات واللحظات وختم القبول — للمقارنة بالمسار المباشر */
const loadShape = (l: Row) => {
  const { id: _i, createdAt: _c, acceptedAt: _a, pendingLoadId: _p, ...head } = l;
  void _i; void _c; void _a; void _p;
  return { ...head, items: S.vanItems.filter((i) => i.vanLoadId === l.id).map(({ id: _x, vanLoadId: _v, ...it }) => { void _x; void _v; return it; }) };
};
const BODY = { salesRepId: 'r1', type: 'LOAD', note: 'تحميل الصباح', items: [{ productId: 'pA', qty: 4, suggestedQty: 5, expectedQty: 3 }, { productId: 'pC', qty: 2, unitId: 'uC' }] };

/** يرسل تحميلاً معلّقاً للمندوب r1 ويعيد معرّفه */
async function sendPending(body: Row = BODY): Promise<string> {
  const r = await postLoad(body);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(r.body!.pending, true);
  return (r.body!.data as Row).id as string;
}

// ═══ ١) الإعداد مطفأ: كما كان حرفياً ═══

test('مطفأ: تحميل الإدارة حركةٌ 201 كما كان — لا صفّ معلّق، ولا pending في الردّ، والعمودان الجديدان غائبان عن الكتابة', async () => {
  reset({ acceptance: false });
  const r = await postLoad(BODY);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.ok(!('pending' in r.body!));
  assert.equal(S.vanLoads.length, 1);
  assert.equal(S.pending.length, 0);
  assert.equal(S.vanLoads[0].createdBy, 'ADMIN');
  assert.equal(S.vanLoads[0].acceptedAt, null);
  assert.equal(S.vanLoads[0].pendingLoadId, null);
  assert.deepEqual(S.log, ['lockBases', 'lock:warehouse-stock', 'whRead', 'create'], 'المسار القائم حرفياً');
  assert.equal(S.settingsReads, 1, 'قراءة الإعداد الوحيدة لتحميل الإدارة');
  // والشركة بلا صفّ إعدادات ⇒ مطفأة
  reset();
  delete S.settings[T];
  assert.equal((await postLoad(BODY)).statusCode, 201);
  assert.equal(S.pending.length, 0);
});

// ═══ ٢) مفعّلاً: الإرسال ═══

test('مفعّل: تحميل الإدارة معلّقٌ 201 { pending: true } بلا حركة ولا أثر في المخزون — المراجعة ١ والجسم بلا clientRef، ويُنبَّه المندوب', async () => {
  reset();
  const r = await postLoad({ ...BODY, clientRef: 'ref-1' });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(r.body!.success, true);
  assert.equal(r.body!.pending, true);
  assert.equal(S.vanLoads.length, 0, 'لا حركة');
  assert.ok(!S.log.includes('create'), 'تجربةٌ أُجهضت قبل الإنشاء');
  assert.ok(S.log.includes('whRead'), 'رصيد المستودع حُكم عليه في التجربة');
  assert.equal(S.pending.length, 1);
  const row = S.pending[0];
  assert.deepEqual([row.status, row.revision, row.salesRepId, row.repName, row.clientRef, row.createdById, row.createdByName, row.note], ['PENDING', 1, 'r1', 'سالم', 'ref-1', 'adm1', 'مدير', 'تحميل الصباح']);
  assert.ok(!('clientRef' in row.body), 'الجسم بلا مرجع');
  // فاعل سجل تدقيق اللوط كما كان سيكتبه المسار المباشر — داخليٌّ لا يصل أي ردّ
  assert.deepEqual(row.createdByActor, { type: 'ADMIN', id: 'adm1', name: 'مدير' });
  assert.ok(!('createdByActor' in (r.body!.data as Row)));
  assert.equal(row.body.type, 'LOAD');
  assert.deepEqual(row.body.items, BODY.items);
  // العقد: الأسطر بوحداتها وأساسها، والجسم للإدارة
  const v = r.body!.data as Row;
  assert.equal(v.status, 'PENDING');
  assert.equal(v.lineCount, 2);
  assert.deepEqual((v.lines as Row[]).map((l) => [l.idx, l.productId, l.name, l.unitName, l.unitFactor, l.qty, l.baseQty, l.missing]), [
    [0, 'pA', 'حليب', 'حبة', 1, 4, 4, false],
    [1, 'pC', 'ماء', 'كرتون', 12, 2, 24, false],
  ]);
  assert.ok('body' in v && !('signature' in v));
  // المخزون كما هو: سيارة المندوب فارغة
  assert.deepEqual(await vanStock.computeStock(T, 'r1'), []);
  await settle();
  assert.deepEqual(S.pushes.map((p) => [p.id, p.payload.url, p.payload.tag]), [['r1', '/rep?screen=vanloads', 'van-load']]);
});

test('مفعّل: المندوب (ومنه صندوقه دون اتصال) ومفتاح API والتنزيل والتسوية والمندوب المحذوف — مباشرةً كما كانت، والإعداد لا يُقرأ لغير تحميل الإدارة', async () => {
  reset();
  const direct = async (label: string, r: Res) => {
    assert.ok(!r.body?.pending, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(S.pending.length, 0, label);
  };
  const rep = await postLoad({ type: 'LOAD', items: [{ productId: 'pA', qty: 1 }] }, REP1);
  assert.equal(rep.statusCode, 201);
  assert.equal(loadOf((rep.body!.data as Row).id).createdBy, 'REP');
  await direct('المندوب', rep);
  const api = await postLoad({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 1 }] }, API);
  assert.equal(api.statusCode, 201);
  await direct('مفتاح API', api);
  // إعادة رفع صندوق المندوب دون اتصال: مستندٌ سُجّل على جهازه يُكتب كما كان (المندوب معفى بدوره)
  const replay = await postLoad({ type: 'LOAD', items: [{ productId: 'pA', qty: 1 }] }, REP1, { 'x-fs-replay': '1' });
  assert.equal(replay.statusCode, 201, JSON.stringify(replay.body));
  await direct('إعادة رفع المندوب', replay);
  assert.equal(S.settingsReads, 0, 'الشروط الرخيصة قبل قراءة الإعداد');
  const unload = await postLoad({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pA', qty: 1 }] });
  assert.equal(unload.statusCode, 201, JSON.stringify(unload.body));
  await direct('التنزيل', unload);
  const adjust = await postLoad({ salesRepId: 'r1', type: 'ADJUST', reason: 'COUNT', items: [{ productId: 'pA', qty: -1 }] });
  assert.equal(adjust.statusCode, 201, JSON.stringify(adjust.body));
  await direct('التسوية', adjust);
  const gone = await postLoad({ deletedSalesRepId: 'old', type: 'LOAD', items: [{ productId: 'pA', qty: 1 }] });
  assert.ok(gone.statusCode >= 400, 'سيارة المندوب المحذوف بمسارها القائم (التنزيل وحده)');
  await direct('المندوب المحذوف', gone);
  assert.equal(S.settingsReads, 0);
  assert.equal(S.vanLoads.length, 5);
});

test('مفعّل: ترويسة إعادة الرفع من مستخدم الشركة لا تُعفي — تحميل الإدارة (وجلسة المالك) معلّقٌ 201 pending بلا حركة', async () => {
  reset();
  // صندوق الأوف‑لاين لتطبيق المندوب وحده: الترويسة من اللوحة طلبٌ حيّ كغيره — لا تدخل البضاعة السيارة بلا قبولٍ ولا توقيع
  const r = await postLoad({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 1 }] }, ADMIN, { 'x-fs-replay': '1' });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(r.body!.pending, true);
  const owner = await postLoad({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 2 }] }, { ...ADMIN, impersonated: true }, { 'x-fs-replay': '1' });
  assert.equal(owner.statusCode, 201, JSON.stringify(owner.body));
  assert.equal(owner.body!.pending, true);
  assert.equal(S.vanLoads.length, 0, 'لا حركة');
  assert.equal(S.pending.length, 2);
  assert.equal(S.settingsReads, 2, 'الإعداد قُرئ لتحميل الإدارة');
});

test('مفعّل: كمياتٌ موجبة وحدها — سطرٌ سالب في الإرسال أو التعديل ⇒ 400 PENDING_LOAD_QTY_NEGATIVE بلا كتابة', async () => {
  reset();
  const r = await postLoad({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 2 }, { productId: 'pC', qty: -1 }] });
  assert.deepEqual([r.statusCode, r.body!.code], [400, 'PENDING_LOAD_QTY_NEGATIVE'], JSON.stringify(r.body));
  assert.equal(r.body!.message, svc.PENDING_LOAD_MESSAGES.PENDING_LOAD_QTY_NEGATIVE);
  assert.equal(S.pending.length, 0);
  assert.equal(S.vanLoads.length, 0);
  const id = await sendPending();
  const e = await edit(id, { salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 3 }, { productId: 'pC', qty: -2 }], revision: 1 });
  assert.deepEqual([e.statusCode, e.body!.code], [400, 'PENDING_LOAD_QTY_NEGATIVE']);
  assert.deepEqual([S.pending[0].revision, S.pending[0].body.items], [1, BODY.items], 'الصفّ كما أُرسل');
  // والصفر ليس سالباً: يُهمل كما كان (لا يُعرض ولا يُسجَّل)
  const z = await postLoad({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 1 }, { productId: 'pC', qty: 0 }] });
  assert.equal(z.statusCode, 201, JSON.stringify(z.body));
  assert.equal(((z.body!.data as Row).lines as Row[]).length, 1);
  assert.equal(S.vanLoads.length, 0);
});

test('مفعّل: رصيد المستودع لا يكفي ⇒ 422 WAREHOUSE_INSUFFICIENT كما كان بلا صفّ، والمندوب الموقوف 409، والمندوب مطلوب', async () => {
  reset();
  const r = await postLoad({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 11 }] });
  assert.equal(r.statusCode, 422, JSON.stringify(r.body));
  assert.equal(r.body!.code, 'WAREHOUSE_INSUFFICIENT');
  assert.equal(S.pending.length, 0);
  const off = await postLoad({ salesRepId: 'r3', type: 'LOAD', items: [{ productId: 'pA', qty: 1 }] });
  assert.deepEqual([off.statusCode, off.body!.code], [409, 'PENDING_LOAD_REP_INACTIVE']);
  const none = await postLoad({ type: 'LOAD', items: [{ productId: 'pA', qty: 1 }] });
  assert.equal(none.statusCode, 400);
  assert.equal(S.pending.length, 0);
});

test('مفعّل: سطرٌ سيتغيّر عند التسجيل (صنفٌ غير موجود) ⇒ 422 PENDING_LOAD_LINES_CHANGED بتحذيره — ولو تُركت الأسطر كلها', async () => {
  reset();
  const r = await postLoad({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 1 }, { productId: 'nope', qty: 2 }] });
  assert.equal(r.statusCode, 422, JSON.stringify(r.body));
  assert.equal(r.body!.code, 'PENDING_LOAD_LINES_CHANGED');
  assert.deepEqual((r.body!.warnings as Row[]).map((w) => [w.code, w.index]), [['PRODUCT_NOT_FOUND', 1]]);
  const all = await postLoad({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'nope', qty: 2 }] });
  assert.deepEqual([all.statusCode, all.body!.code], [422, 'PENDING_LOAD_LINES_CHANGED']);
  // وحدةٌ ليست من وحدات الصنف (UNIT_INVALID) كذلك
  const unit = await postLoad({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pC', qty: 1, unitId: 'uX' }, { productId: 'pA', qty: 1 }] });
  assert.deepEqual([unit.statusCode, unit.body!.code], [422, 'PENDING_LOAD_LINES_CHANGED']);
  assert.equal(S.pending.length, 0);
  assert.equal(S.vanLoads.length, 0);
});

test('مفعّل: clientRef — الإعادة 200 بالصفّ نفسه بلا كتابة، ومندوبٌ آخر بالمرجع نفسه 409 CLIENT_REF_REUSED', async () => {
  reset();
  const a = await postLoad({ ...BODY, clientRef: 'dup-1' });
  assert.equal(a.statusCode, 201);
  const b = await postLoad({ ...BODY, clientRef: 'dup-1' });
  assert.equal(b.statusCode, 200, JSON.stringify(b.body));
  assert.deepEqual([b.body!.pending, b.body!.replay, b.body!.idempotent, (b.body!.data as Row).id], [true, true, true, (a.body!.data as Row).id]);
  const c = await postLoad({ ...BODY, salesRepId: 'r2', clientRef: 'dup-1' });
  assert.deepEqual([c.statusCode, c.body!.code], [409, 'CLIENT_REF_REUSED']);
  assert.equal(S.pending.length, 1);
  // والإرسالان المتزامنان بالمرجع نفسه: صفٌّ واحد (القفل ثم البحث في المعاملة)
  reset();
  const [x, y] = await Promise.all([postLoad({ ...BODY, clientRef: 'race-1' }), postLoad({ ...BODY, clientRef: 'race-1' })]);
  assert.deepEqual([x.statusCode, y.statusCode].sort(), [200, 201]);
  assert.equal(S.pending.length, 1);
});

// ═══ ٣) القبول ═══

test('القبول: حركةٌ واحدة كالمسار المباشر حرفياً (ADMIN) مختومةً بلحظة القبول ومعرّف الإقرار، والصفّ ACCEPTED بتوقيعه وموقعه — قفل الصفّ أول المعاملة', async () => {
  // المسار المباشر مرجعاً
  reset({ acceptance: false });
  assert.equal((await postLoad(BODY)).statusCode, 201);
  const directShape = loadShape(S.vanLoads[0]);
  reset();
  const id = await sendPending();
  S.log = [];
  const r = await accept(id, { lat: 24.7, lng: 46.6 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body!.success, true);
  assert.equal(S.vanLoads.length, 1);
  const load = S.vanLoads[0];
  assert.deepEqual(loadShape(load), directShape, 'الحركة نفسها حرفياً');
  assert.equal(load.createdBy, 'ADMIN');
  assert.equal(load.pendingLoadId, id);
  assert.ok(load.acceptedAt instanceof Date);
  assert.equal((r.body!.load as Row).id, load.id);
  const row = S.pending[0];
  assert.deepEqual([row.status, row.vanLoadId, row.signature, row.acceptedLat, row.acceptedLng], ['ACCEPTED', load.id, SIG, 24.7, 46.6]);
  assert.equal(+row.acceptedAt, +load.acceptedAt);
  assert.equal((r.body!.data as Row).status, 'ACCEPTED');
  assert.ok(!('body' in (r.body!.data as Row)), 'الجسم للإدارة وحدها');
  assert.deepEqual(S.log.filter((x) => x.startsWith('lock:') || x === 'lockBases' || x === 'create'), ['lock:pending-van-load', 'lockBases', 'lock:warehouse-stock', 'create']);
  // البضاعة في السيارة الآن
  const stock = await vanStock.computeStock(T, 'r1');
  assert.deepEqual(stock.map((s) => [s.productId, s.remaining]).sort(), [['pA', 4], ['pC', 24]]);
});

test('القبول مرّتين: الثانية 200 replay وحركةٌ واحدة — ولو تزامنتا', async () => {
  reset();
  const id = await sendPending();
  assert.equal((await accept(id)).statusCode, 200);
  const again = await accept(id);
  assert.deepEqual([again.statusCode, again.body!.replay], [200, true]);
  assert.equal(S.vanLoads.length, 1);
  reset();
  const id2 = await sendPending();
  const [a, b] = await Promise.all([accept(id2), accept(id2)]);
  assert.deepEqual([a.statusCode, b.statusCode], [200, 200], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
  assert.equal([a, b].filter((x) => x.body!.replay === true).length, 1);
  assert.equal(S.vanLoads.length, 1, 'حركةٌ واحدة');
});

test('القبول بلا موقع: lat/lng غائبان أو null يُقبل بلا إحداثيات، وإحداثيةٌ وحدها لا تُحفظ', async () => {
  reset();
  const a = await sendPending();
  const r = await accept(a, { lat: null, lng: null });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual([S.pending[0].status, S.pending[0].acceptedLat, S.pending[0].acceptedLng], ['ACCEPTED', null, null]);
  const b = await sendPending({ ...BODY, items: [{ productId: 'pA', qty: 1 }] });
  assert.equal((await accept(b, { lat: 24.7 })).statusCode, 200);
  const row = S.pending.find((p) => p.id === b)!;
  assert.deepEqual([row.status, row.acceptedLat, row.acceptedLng], ['ACCEPTED', null, null]);
});

test('القبول يُرفض: مندوبٌ آخر 404، والإدارة 403، وبلا توقيع 400، ومراجعةٌ قديمة 409 REVISED، وإعادة الرفع 400 — بلا حركة', async () => {
  reset();
  const id = await sendPending();
  const other = await accept(id, {}, REP2);
  assert.deepEqual([other.statusCode, other.body!.code], [404, 'PENDING_LOAD_NOT_FOUND']);
  const admin = await accept(id, {}, ADMIN);
  assert.deepEqual([admin.statusCode, admin.body!.code], [403, 'PENDING_LOAD_REP_ONLY']);
  const noSig = await call('post', '/pending-loads/:id/accept', { params: { id }, body: { revision: 1 }, user: REP1 });
  assert.deepEqual([noSig.statusCode, noSig.body!.code], [400, 'PENDING_LOAD_SIGNATURE_REQUIRED']);
  const badSig = await accept(id, { signature: 'data:image/jpeg;base64,AAAA' });
  assert.deepEqual([badSig.statusCode, badSig.body!.code], [400, 'PENDING_LOAD_SIGNATURE_REQUIRED']);
  const stale = await accept(id, { revision: 2 });
  assert.deepEqual([stale.statusCode, stale.body!.code], [409, 'PENDING_LOAD_REVISED']);
  assert.equal((stale.body!.data as Row).revision, 1);
  const offline = await accept(id, {}, REP1, { 'x-fs-replay': '1' });
  assert.deepEqual([offline.statusCode, offline.body!.code], [400, 'PENDING_LOAD_ONLINE_ONLY']);
  assert.equal(S.vanLoads.length, 0);
  assert.equal(S.pending[0].status, 'PENDING');
});

test('القبول ورصيد المستودع لم يعد يكفي ⇒ 409 PENDING_LOAD_STOCK_SHORT بأسطره، والصفّ معلّق كما هو بلا حركة', async () => {
  reset();
  const id = await sendPending();
  // استهلك المستودع تحميلٌ مباشر من مفتاح API بعد الإرسال
  assert.equal((await postLoad({ salesRepId: 'r2', type: 'LOAD', items: [{ productId: 'pA', qty: 8 }] }, API)).statusCode, 201);
  const r = await accept(id);
  assert.deepEqual([r.statusCode, r.body!.code], [409, 'PENDING_LOAD_STOCK_SHORT'], JSON.stringify(r.body));
  assert.deepEqual((r.body!.lines as Row[]).map((l) => [l.productId, l.availableBase, l.requestedBase]), [['pA', 2, 4]]);
  assert.equal(S.vanLoads.length, 1, 'تحميل المفتاح وحده');
  assert.deepEqual([S.pending[0].status, S.pending[0].signature, S.pending[0].vanLoadId], ['PENDING', null, null]);
  // أعادت الإدارة الرصيد ⇒ يُقبل
  S.whItems.push({ productId: 'pA', tenantId: T, qty: 5, unitFactor: 1, baseQty: 5 });
  assert.equal((await accept(id)).statusCode, 200);
});

test('القبول بعد حذف صنفٍ من التحميل ⇒ 409 PENDING_LOAD_CHANGED — سطرٌ من اثنين أو السطر الوحيد', async () => {
  reset();
  const id = await sendPending();
  const [view] = (await call('get', '/pending-loads', { user: REP1 })).body!.data as Row[];
  assert.equal(view.id, id);
  S.products = S.products.filter((p) => p.id !== 'pC');
  const r = await accept(id);
  assert.deepEqual([r.statusCode, r.body!.code], [409, 'PENDING_LOAD_CHANGED'], JSON.stringify(r.body));
  assert.deepEqual((r.body!.warnings as Row[]).map((w) => w.code), ['PRODUCT_NOT_FOUND']);
  // الأسطر تعرض الصنف المحذوف «missing»
  const [after] = (await call('get', '/pending-loads', { user: REP1 })).body!.data as Row[];
  assert.deepEqual((after.lines as Row[]).map((l) => [l.productId, l.missing]), [['pA', false], ['pC', true]]);
  reset();
  const only = await sendPending({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pC', qty: 1 }] });
  S.products = S.products.filter((p) => p.id !== 'pC');
  const r2 = await accept(only);
  assert.deepEqual([r2.statusCode, r2.body!.code], [409, 'PENDING_LOAD_CHANGED']);
  assert.equal(S.vanLoads.length, 0);
  assert.equal(S.pending[0].status, 'PENDING');
});

// ═══ ٤) الاعتراض والتعديل والإلغاء ═══

test('الاعتراض: بلا سبب 400، وبسببٍ DISPUTED — ثم القبول 409 NOT_PENDING، والإدارة لا تعترض', async () => {
  reset();
  const id = await sendPending();
  for (const note of ['', '   ', undefined, 'x'.repeat(1001)]) {
    const r = await dispute(id, note);
    assert.deepEqual([r.statusCode, r.body!.code], [400, 'PENDING_LOAD_NOTE_REQUIRED'], String(note));
  }
  assert.deepEqual([(await dispute(id, 'ناقص', ADMIN)).statusCode], [403]);
  const r = await dispute(id, 'الماء ناقص كرتوناً');
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual([(r.body!.data as Row).status, (r.body!.data as Row).disputeNote], ['DISPUTED', 'الماء ناقص كرتوناً']);
  assert.ok(S.pending[0].disputedAt instanceof Date);
  const a = await accept(id);
  assert.deepEqual([a.statusCode, a.body!.code], [409, 'PENDING_LOAD_NOT_PENDING']);
  // الاعتراض ثانيةً يحدّث سببه
  assert.equal((await dispute(id, 'والحليب أيضاً')).statusCode, 200);
  assert.equal(S.pending[0].disputeNote, 'والحليب أيضاً');
  assert.equal(S.vanLoads.length, 0);
});

test('التعديل: المعترَض عليه ⇒ PENDING بمراجعة ٢ ويُمحى الاعتراض ويُنبَّه المندوب؛ والمقبول 409، وتغيير المندوب 400، والمراجعة القديمة 409', async () => {
  reset();
  const id = await sendPending();
  await dispute(id, 'الماء ناقص');
  S.pushes = [];
  const body = { salesRepId: 'r1', type: 'LOAD', note: 'بعد التصحيح', items: [{ productId: 'pA', qty: 4 }, { productId: 'pC', qty: 1, unitId: 'uC' }] };
  const r = await edit(id, { ...body, revision: 1 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = S.pending[0];
  assert.deepEqual([row.status, row.revision, row.disputeNote, row.disputedAt, row.note], ['PENDING', 2, null, null, 'بعد التصحيح']);
  assert.deepEqual(row.body.items, body.items);
  assert.equal(S.vanLoads.length, 0, 'التعديل تجربةٌ بلا كتابة');
  await settle();
  assert.deepEqual(S.pushes.map((p) => p.id), ['r1']);
  // المندوب يوقّع على المراجعة ٢ وحدها
  assert.deepEqual([(await accept(id)).body!.code], ['PENDING_LOAD_REVISED']);
  assert.deepEqual([(await edit(id, { ...body, revision: 1 })).body!.code], ['PENDING_LOAD_REVISED'], 'تعديلٌ على مراجعةٍ قديمة');
  assert.deepEqual([(await edit(id, { ...body, salesRepId: 'r2', revision: 2 })).statusCode], [400]);
  assert.deepEqual([(await edit(id, { ...body, type: 'UNLOAD', revision: 2 })).body!.code], ['PENDING_LOAD_TYPE_INVALID']);
  assert.deepEqual([(await edit(id, { ...body, revision: 2 }, REP1)).statusCode], [403]);
  // تعديلٌ فوق رصيد المستودع ⇒ 422 كالإرسال، والصفّ كما هو
  const over = await edit(id, { ...body, items: [{ productId: 'pA', qty: 50 }], revision: 2 });
  assert.deepEqual([over.statusCode, over.body!.code], [422, 'WAREHOUSE_INSUFFICIENT']);
  assert.equal(S.pending[0].revision, 2);
  const ok = await accept(id, { revision: 2 });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.deepEqual(S.vanItems.map((i) => [i.productId, i.baseQty]), [['pA', 4], ['pC', 12]], 'الحركة بالجسم المعدَّل');
  const late = await edit(id, { ...body, revision: 2 });
  assert.deepEqual([late.statusCode, late.body!.code], [409, 'PENDING_LOAD_ACCEPTED']);
});

test('التعديل واعتراضٌ بعد فتحه: updatedAt الذي فُتح عليه — اعترض المندوب بعده (أو بدّل سببه) ⇒ 409 PENDING_LOAD_DISPUTED بملاحظته ولا يُمحى', async () => {
  reset();
  const id = await sendPending();
  const opened = async () => ((await call('get', '/pending-loads/:id', { params: { id } })).body!.data as Row).updatedAt as Date;
  const body = { salesRepId: 'r1', type: 'LOAD', note: 'بعد التصحيح', items: [{ productId: 'pA', qty: 3 }] };
  // فتح الإداري التعديل والتحميل بانتظار القبول، ثم اعترض المندوب
  const seen = await opened();
  assert.equal((await dispute(id, 'الماء ناقص')).statusCode, 200);
  await settle();
  S.pushes = [];
  const r = await edit(id, { ...body, revision: 1, updatedAt: seen.toISOString() });
  assert.deepEqual([r.statusCode, r.body!.code], [409, 'PENDING_LOAD_DISPUTED'], JSON.stringify(r.body));
  assert.equal(r.body!.message, svc.PENDING_LOAD_MESSAGES.PENDING_LOAD_DISPUTED);
  assert.deepEqual([(r.body!.data as Row).status, (r.body!.data as Row).disputeNote], ['DISPUTED', 'الماء ناقص'], 'الصفّ بملاحظته ليراها');
  assert.deepEqual([S.pending[0].status, S.pending[0].disputeNote, S.pending[0].revision], ['DISPUTED', 'الماء ناقص', 1], 'الاعتراض باقٍ');
  await settle();
  assert.equal(S.pushes.length, 0, 'لا تنبيه');
  // فُتح على المعترَض عليه ثم بدّل المندوب سببه ⇒ 409 كذلك
  const seen2 = await opened();
  assert.equal((await dispute(id, 'والحليب أيضاً')).statusCode, 200);
  assert.equal((await edit(id, { ...body, revision: 1, updatedAt: seen2.toISOString() })).body!.code, 'PENDING_LOAD_DISPUTED');
  assert.equal(S.pending[0].disputeNote, 'والحليب أيضاً');
  // رآه الإداري ⇒ التعديل يمضي: PENDING بمراجعة ٢ ويُمحى الاعتراض
  const ok = await edit(id, { ...body, revision: 1, updatedAt: (await opened()).toISOString() });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.deepEqual([S.pending[0].status, S.pending[0].revision, S.pending[0].disputeNote], ['PENDING', 2, null]);
  assert.ok(!('updatedAt' in S.pending[0].body), 'لحظة الفتح لا تدخل جسم التحميل');
  // المعلّق بلا اعتراض لا يُقارن بلحظته، وبلا updatedAt (عميلٌ لا يرسله) كما كان
  assert.equal((await edit(id, { ...body, revision: 2, updatedAt: '2000-01-01T00:00:00.000Z' })).statusCode, 200, 'المعلّق بلا اعتراض لا يُرفض');
  await dispute(id, 'ناقص');
  assert.equal((await edit(id, { ...body, revision: 3 })).statusCode, 200, 'بلا updatedAt');
  assert.equal(S.pending[0].status, 'PENDING');
});

test('الإلغاء: المعلّق ⇒ CANCELLED باسم المُلغي، والإعادة 200، والمقبول 409، والقبول بعد الإلغاء 409', async () => {
  reset();
  const id = await sendPending();
  const r = await cancel(id, { reason: 'أُرسل خطأً' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = S.pending[0];
  assert.deepEqual([row.status, row.cancelledById, row.cancelledByName, row.note], ['CANCELLED', 'adm1', 'مدير', 'أُرسل خطأً']);
  assert.ok(row.cancelledAt instanceof Date);
  assert.equal((await cancel(id)).statusCode, 200, 'الإلغاء ثانيةً');
  const a = await accept(id);
  assert.deepEqual([a.statusCode, a.body!.code], [409, 'PENDING_LOAD_NOT_PENDING']);
  assert.deepEqual([(await dispute(id, 'سبب')).body!.code], ['PENDING_LOAD_CANCELLED']);
  assert.deepEqual([(await cancel(id, {}, REP1)).statusCode], [403]);
  reset();
  const id2 = await sendPending();
  await accept(id2);
  const c = await cancel(id2);
  assert.deepEqual([c.statusCode, c.body!.code], [409, 'PENDING_LOAD_ACCEPTED']);
  assert.equal(S.vanLoads.length, 1);
});

test('الإلغاء و«تحميل مباشر» لطلب المندوب: الطلب المعلَّم «حُمِّل» بالتحميل الملغى يعود معلّقاً — وللمندوب طلبٌ أحدث ⇒ «رُفض» — تحت قفل الطلبات بعد قفل الصفّ', async () => {
  reset();
  const a = await sendPending();
  const b = await sendPending({ ...BODY, salesRepId: 'r2' });
  const t0 = new Date(T0);
  const req = (id: string, salesRepId: string, status: string, sentRef: string | null) =>
    ({ id, tenantId: T, salesRepId, status, sentRef, decidedAt: status === 'PENDING' ? null : t0, decidedBy: status === 'PENDING' ? null : 'مدير', updatedAt: t0 });
  S.requests = [
    req('q1', 'r1', 'LOADED', a),
    req('q2', 'r2', 'LOADED', b), req('q3', 'r2', 'PENDING', null),
    // حركةٌ مباشرة (الميزة مطفأة حينها) لا يمسّها إلغاء معلّق
    req('q9', 'r1', 'LOADED', 'vl-direct'),
  ];
  S.log = [];
  assert.equal((await cancel(a)).statusCode, 200);
  const q = (id: string) => S.requests.find((x) => x.id === id)!;
  assert.deepEqual([q('q1').status, q('q1').sentRef, q('q1').decidedAt, q('q1').decidedBy], ['PENDING', null, null, null], 'يعود معلّقاً للإدارة والطلب العام');
  assert.deepEqual(S.log.filter((x) => x.startsWith('lock:')), ['lock:pending-van-load', 'lock:rep-stock-request'], 'قفل الصفّ ثم قفل الطلبات');
  assert.deepEqual([q('q9').status, q('q9').sentRef], ['LOADED', 'vl-direct']);
  // للمندوب الثاني طلبٌ معلّق أحدث: لا معلّقان له — القديم «رُفض» بلحظة الإلغاء وباسم من ألغى، والأحدث كما هو
  assert.equal((await cancel(b, {}, { ...ADMIN, id: 'mgr1', name: 'مشرف' })).statusCode, 200);
  assert.deepEqual([q('q2').status, q('q2').sentRef, q('q2').decidedBy], ['REJECTED', null, 'مشرف']);
  assert.ok(q('q2').decidedAt instanceof Date && +q('q2').decidedAt > +t0);
  assert.deepEqual([q('q3').status, q('q3').sentRef, +q('q3').updatedAt], ['PENDING', null, +t0]);
  // معلّقٌ بعلامة «حُمِّلت منه نسخةٌ سابقة» (sentRef على PENDING): تُمحى العلامة وتبقى نسخته
  const c = await sendPending({ ...BODY, items: [{ productId: 'pA', qty: 1 }] });
  Object.assign(q('q1'), { sentRef: c, updatedAt: t0 });
  assert.equal((await cancel(c)).statusCode, 200);
  assert.deepEqual([q('q1').status, q('q1').sentRef, +q('q1').updatedAt], ['PENDING', null, +t0], 'النسخة لم تتغيّر');
  // الإلغاء ثانيةً والمقبول: لا مساس بالطلبات
  S.requests.push(req('q5', 'r1', 'LOADED', a));
  assert.equal((await cancel(a)).statusCode, 200);
  assert.equal(q('q5').status, 'LOADED', 'الإلغاء ثانيةً بلا كتابة');
  const d = await sendPending({ ...BODY, items: [{ productId: 'pA', qty: 1 }] });
  assert.equal((await accept(d)).statusCode, 200);
  S.requests.push(req('q6', 'r1', 'LOADED', d));
  assert.equal((await cancel(d)).statusCode, 409);
  assert.deepEqual([q('q6').status, q('q6').sentRef], ['LOADED', d], 'المقبول دخل السيارة فعلاً');
});

// ═══ ٥) القراءة والنطاق ومفتاح API ═══

test('القائمة: المندوب صفوفه وحدها بلا جسم ولا توقيع، والإدارة الكل بالعدّ؛ والتوقيع للمقبول بـwithSignature=1 وحده، وGET /:id بحركته', async () => {
  reset();
  const a = await sendPending();
  const b = await sendPending({ ...BODY, salesRepId: 'r2' });
  const c = await sendPending({ ...BODY, items: [{ productId: 'pA', qty: 1 }] });
  await dispute(c, 'ناقص');
  await accept(a);
  const mine = await call('get', '/pending-loads', { user: REP1 });
  assert.equal(mine.statusCode, 200);
  assert.deepEqual((mine.body!.data as Row[]).map((v) => [v.id, v.status]), [[c, 'DISPUTED'], [a, 'ACCEPTED']], 'المفتوح أولاً ثم المقبول حديثاً');
  assert.deepEqual(mine.body!.counts, { pending: 0, disputed: 1 });
  for (const v of mine.body!.data as Row[]) assert.ok(!('body' in v) && !('signature' in v) && !('createdById' in v));
  const all = await call('get', '/pending-loads', { user: ADMIN });
  assert.deepEqual((all.body!.data as Row[]).map((v) => v.id).sort(), [a, b, c].sort());
  assert.deepEqual(all.body!.counts, { pending: 1, disputed: 1 });
  for (const v of all.body!.data as Row[]) assert.ok('body' in v && !('signature' in v));
  const sig = await call('get', '/pending-loads', { user: ADMIN, query: { withSignature: '1' } });
  assert.deepEqual((sig.body!.data as Row[]).filter((v) => 'signature' in v).map((v) => [v.id, v.signature]), [[a, SIG]]);
  const onlyR2 = await call('get', '/pending-loads', { user: ADMIN, query: { salesRepId: 'r2', status: 'PENDING' } });
  assert.deepEqual((onlyR2.body!.data as Row[]).map((v) => v.id), [b]);
  const open = await call('get', '/pending-loads', { user: ADMIN, query: { status: 'open' } });
  assert.deepEqual((open.body!.data as Row[]).map((v) => v.id).sort(), [b, c].sort());
  const one = await call('get', '/pending-loads/:id', { user: REP1, params: { id: a } });
  assert.equal(one.statusCode, 200);
  assert.equal((one.body!.data as Row).signature, SIG);
  assert.equal(((one.body!.data as Row).vanLoad as Row).id, S.pending.find((p) => p.id === a)!.vanLoadId);
  assert.equal((await call('get', '/pending-loads/:id', { user: REP1, params: { id: b } })).statusCode, 404, 'صفّ مندوبٍ آخر');
});

test('النطاق: الإداري المقيّد لا يرى صفوف مندوبٍ خارج نطاقه ولا يعدّلها أو يلغيها (404)، ولا يرسل له', async () => {
  reset();
  const a = await sendPending();
  const b = await sendPending({ ...BODY, salesRepId: 'r2' });
  S.scoped = true;
  S.scopeReps = new Set(['r1']);
  const list = await call('get', '/pending-loads', { user: ADMIN });
  assert.deepEqual((list.body!.data as Row[]).map((v) => v.id), [a]);
  assert.deepEqual(list.body!.counts, { pending: 1, disputed: 0 });
  assert.equal((await edit(b, { ...BODY, salesRepId: 'r2', revision: 1 })).statusCode, 404);
  assert.equal((await cancel(b)).statusCode, 404);
  assert.equal((await call('get', '/pending-loads/:id', { user: ADMIN, params: { id: b } })).statusCode, 404);
  assert.equal((await postLoad({ ...BODY, salesRepId: 'r2' })).statusCode, 404, 'الإرسال بنطاق المندوب');
  assert.equal(S.pending.find((p) => p.id === b)!.status, 'PENDING');
});

test('مفتاح API مرفوض في كل مسارات التحميل المعلّق (403 API_KEY_FORBIDDEN)', async () => {
  reset();
  const id = await sendPending();
  const calls: [Method, string][] = [
    ['get', '/pending-loads'], ['get', '/pending-loads/:id'], ['post', '/pending-loads/:id/accept'],
    ['post', '/pending-loads/:id/dispute'], ['put', '/pending-loads/:id'], ['post', '/pending-loads/:id/cancel'],
  ];
  for (const [m, p] of calls) {
    const r = await call(m, p, { user: API, params: { id }, body: { ...BODY, revision: 1, note: 'x', signature: SIG } });
    assert.deepEqual([r.statusCode, r.body!.code], [403, 'API_KEY_FORBIDDEN'], `${m} ${p}`);
  }
  assert.equal(S.pending[0].status, 'PENDING');
});

// ═══ ٦) الإعداد ═══

test('الإعداد: القراءة بالعدد المفتوح، والقلب بلا مفتاح API ولا نطاق، والإطفاء مرفوض والتحميلات مفتوحة، وبلا صفّ شركة 409', async () => {
  reset({ acceptance: false });
  const audits: string[] = [];
  const settings = createVanLoadAcceptanceRouter({
    db: db as never, scopeEnabled: async () => S.scoped, tenantId: (req) => req.user!.tenantId!,
    permission: (_q, _s, next) => next(), audit: (l) => audits.push(l),
  });
  const get = () => call('get', '/', { on: settings });
  const patch = (body: unknown, user: unknown = ADMIN) => call('patch', '/', { on: settings, body, user });
  assert.deepEqual((await get()).body!.data, { enabled: false, openCount: 0 });
  assert.deepEqual([(await patch({ enabled: true }, API)).body!.code], ['API_KEY_FORBIDDEN']);
  S.scoped = true;
  assert.deepEqual([(await patch({ enabled: true })).body!.code], ['VAN_LOAD_ACCEPTANCE_SCOPED']);
  assert.equal((await patch({ enabled: true }, { ...ADMIN, impersonated: true })).statusCode, 200, 'جلسة المالك لا نطاق لها');
  S.scoped = false;
  for (const bad of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }]) {
    assert.deepEqual([(await patch(bad)).statusCode, (await patch(bad)).body!.code], [400, 'VAN_LOAD_ACCEPTANCE_INVALID']);
  }
  assert.equal(S.settings[T].vanLoadAcceptance, true);
  const id = await sendPending();
  assert.deepEqual((await get()).body!.data, { enabled: true, openCount: 1 });
  const off = await patch({ enabled: false });
  assert.deepEqual([off.statusCode, off.body!.code, off.body!.count], [409, 'VAN_LOAD_ACCEPTANCE_OPEN_LOADS', 1]);
  await dispute(id, 'ناقص');
  assert.equal((await patch({ enabled: false })).statusCode, 409, 'المعترَض عليه مفتوحٌ أيضاً');
  await cancel(id);
  const ok = await patch({ enabled: false });
  assert.deepEqual([ok.statusCode, ok.body!.data], [200, { enabled: false }]);
  assert.equal(S.settings[T].vanLoadAcceptance, false);
  delete S.settings[T];
  assert.deepEqual([(await patch({ enabled: true })).statusCode, (await patch({ enabled: true })).body!.code], [409, 'COMPANY_SETTINGS_MISSING']);
  // سطر تدقيقٍ لكل تغييرٍ كُتب: معرّفاتٌ وحالةٌ وحدها — لا أسماء
  assert.deepEqual(audits.map((l) => JSON.parse(l)), [
    { event: 'VAN_LOAD_ACCEPTANCE', tenantId: T, actorId: 'adm1', role: 'ADMIN', impersonated: true, enabled: true },
    { event: 'VAN_LOAD_ACCEPTANCE', tenantId: T, actorId: 'adm1', role: 'ADMIN', impersonated: false, enabled: false },
  ]);
  assert.ok(!audits.some((l) => l.includes('مدير')), 'لا اسم في سطر التدقيق');
});

test('الإعداد: القلب لمدير الشركة وحده (دوره من القاعدة) أو جلسة المالك — مدير المبيعات والمحاسب والموقوف ومن شركةٍ أخرى 403 بلا كتابة', async () => {
  reset({ acceptance: true });
  const audits: string[] = [];
  const settings = createVanLoadAcceptanceRouter({
    db: db as never, scopeEnabled: async () => false, tenantId: (req) => req.user!.tenantId!,
    permission: (_q, _s, next) => next(), audit: (l) => audits.push(l),
  });
  const patch = (user: unknown, enabled = false) => call('patch', '/', { on: settings, body: { enabled }, user });
  for (const id of ['mgr1', 'acc1', 'off1', 'oth1', 'ghost']) {
    // التوكن يقول ADMIN — والقاعدة هي الحكم
    const r = await patch({ ...ADMIN, id });
    assert.deepEqual([r.statusCode, r.body!.code], [403, 'VAN_LOAD_ACCEPTANCE_ADMIN_ONLY'], id);
    assert.equal(r.body!.message, 'اشتراط قبول المندوب للتحميل لمدير الشركة وحده');
  }
  assert.equal(S.settings[T].vanLoadAcceptance, true, 'لم يُطفأ ضابط التوقيع');
  assert.equal(audits.length, 0);
  // جلسة المالك تمرّ ولو كان المنتحَل مدير مبيعات، ومدير الشركة يمرّ
  assert.equal((await patch({ ...ADMIN, id: 'mgr1', role: 'MANAGER', impersonated: true })).statusCode, 200);
  assert.equal(S.settings[T].vanLoadAcceptance, false);
  assert.equal((await patch(ADMIN, true)).statusCode, 200);
  assert.deepEqual(audits.map((l) => JSON.parse(l)).map((x) => [x.actorId, x.role, x.impersonated, x.enabled]), [
    ['mgr1', 'MANAGER', true, false], ['adm1', 'ADMIN', false, true],
  ]);
  // والقراءة لكل مستخدم شركة كما كانت
  assert.equal((await call('get', '/', { on: settings, user: { ...ADMIN, id: 'mgr1', role: 'MANAGER' } })).statusCode, 200);
});

// ═══ ٧) الخدمة نقيّاً ═══

test('الخدمة: فاعل اللوط من المرسِل (جلسة المالك «الدعم الفني»)، ورموز التحذير المغيِّرة، ونمط التوقيع', () => {
  // المحفوظ لحظة الإرسال (lotEventActorOf) أولاً، وشكلٌ غير صالح ⇒ null فيُبنى من المرسِل
  assert.deepEqual(svc.storedEventActor({ type: 'STAFF', id: 'st9', name: 'موظف المنصة' }), { type: 'STAFF', id: 'st9', name: 'موظف المنصة' });
  assert.deepEqual(svc.storedEventActor({ type: 'OWNER', id: null, name: null }), { type: 'OWNER', id: null, name: null });
  for (const bad of [null, undefined, 'ADMIN', [], {}, { type: 'ROOT', id: 'x', name: null }, { type: 'ADMIN', id: 5, name: null }, { type: 'ADMIN', id: 'a' }]) {
    assert.equal(svc.storedEventActor(bad), null, JSON.stringify(bad));
  }
  assert.equal(svc.repStockRequestLockKey('t1'), 'rep-stock-request:t1');
  assert.deepEqual(svc.pendingEventActor('OWNER:o1', 'مدير'), { type: 'OWNER', id: 'o1', name: 'الدعم الفني' });
  assert.deepEqual(svc.pendingEventActor('adm1', 'مدير'), { type: 'ADMIN', id: 'adm1', name: 'مدير' });
  assert.equal(svc.pendingActorName('OWNER:o1', 'مدير'), 'الدعم الفني');
  for (const c of ['PRODUCT_NOT_FOUND', 'PRODUCT_REDIRECTED', 'UNIT_INVALID', 'UNIT_FALLBACK_BASE', 'LOT_CLAMPED', 'ZERO_QTY_IGNORED']) assert.ok(svc.PENDING_LINE_ALTERING.has(c), c);
  for (const c of ['PRODUCT_ARCHIVED', 'UNIT_INACTIVE', 'LOT_CREATED', 'LOT_MULTI_IN_VAN']) assert.ok(!svc.PENDING_LINE_ALTERING.has(c), c);
  assert.ok(svc.PNG_SIGNATURE_RE.test(SIG));
  assert.ok(!svc.PNG_SIGNATURE_RE.test('data:image/svg+xml;base64,PHN2Zz4='));
  assert.equal(svc.pendingLoadLockKey('x'), 'pending-van-load:x');
  // رسائل الأخطاء الداخلية لا تُقرأ انشغالاً (asLotBusy)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { asLotBusy } = require('../services/lots') as typeof import('../services/lots');
  for (const e of [new svc.VanDryRun([]), new svc.PendingLinesChanged([]), new svc.PendingLoadSettled('ACCEPTED')]) assert.equal(asLotBusy(e), null);
});
