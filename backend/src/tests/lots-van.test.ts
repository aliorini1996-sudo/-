// «تتبّع اللوط» — حركات السيارة (المواصفة §٨.٢ lots-van، الحزمة B4): مسار POST /van-stock/loads وGET /van-stock/lot-balances
// وservices/lotsVan.ts فوق Prisma مزيّف في الذاكرة يجيب تجميعات SQL في lotsDb.ts (الحقبة والتوجيه والحجز) — بلا قاعدة.
//
// المحروس أولاً طلب المالك: **لا سالب على مستوى اللوط** — كل إنقاصٍ (التحميل من المستودع، والتنزيل، وتسوية النقص، والإزالة)
// لا يجعل صالح تشغيلةٍ مسمّاة سالباً (I1) ولا يُنقص غير المسمّى دون min(0، قبله) (I2)، بعد تجميع الطلب (D26)، وتحت القفل
// والطابور معاً (طلبان متزامنان لا يصرفان الصالح نفسه مرتين)، ومعها خاصيةٌ عشوائية على المسار كله.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';
import { Prisma } from '@prisma/client';
import { DAMAGED_VAN_SINCE } from '../services/vanDamaged';
import { LOT_EPS, LOT_HOLD_MIRRORS, LotError, type LotBucket, type PlaceLotView } from '../services/lots';
import { placeViews, type LotDb } from '../services/lotsDb';
import { planVanMovementInTx, vanLotSnapshot } from '../services/lotsVan';
import { computeAccuracy } from '../services/suggestAccuracy';
import { baseQtyOf } from '../services/units';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ القاعدة في الذاكرة ═══

const T = 't1';
const T0 = Date.UTC(2026, 10, 10, 8);
const DAY_MS = 86_400_000;
/** تواريخ انتهاء بعيدة عن اليوم الحقيقي (companyDay يقيس بساعة الخادم) — FEFO بينها، والمنتهي في الماضي */
const FAR1 = '2998-01-01';
const FAR2 = '2999-01-01';
const PAST = '2001-01-01';

interface ProductRow {
  id: string; tenantId: string; name: string; unit: string; code: string; lotTracked: boolean; lotTrackedSince: Date | null;
  shelfLifeEnabled: boolean; shelfLifeValue: number | null; shelfLifeUnit: string | null;
}
interface LotRow {
  id: string; tenantId: string; productId: string; lotNumber: string; productionDate: Date | null; expiryDate: Date | null;
  status: string; blockKind: string | null; blockedAt: Date | null; createdAt: Date; source: string; sourceEntryId: string | null; createdBy: string | null; note: string | null;
}
interface VanLoadRow { id: string; tenantId: string; salesRepId: string | null; deletedSalesRepId: string | null; type: string; note: string | null; createdBy: string | null; locationId: string | null; createdAt: Date }
interface VanItemRow { id: string; vanLoadId: string; productId: string; qty: number; unitName: string | null; unitFactor: number; baseQty: number | null; suggestedQty: number | null; expectedQty: number | null }
interface VanItemLotRow { id: string; vanLoadItemId: string; tenantId: string; productId: string; vanKey: string; moveType: string; viaWarehouse: boolean; lotId: string | null; qty: number; certainty: string; reason: string | null; createdAt: Date }
interface WhEntryRow { id: string; tenantId: string; type: string; createdAt: Date; items: { productId: string; qty: number; unitFactor: number; baseQty: number | null; lotId: string | null }[] }
interface InvLotRow { id: string; lotId: string | null; quantity: number; certainty: string; expiryDate: Date | null; vanKey: string | null; createdAt: Date }
interface InvItemRow { id: string; productId: string | null; qty: number; unitFactor: number; baseQty: number | null; returnExpired: boolean | null; lots: InvLotRow[] }
interface InvoiceRow {
  id: string; tenantId: string; salesRepId: string | null; type: string; status: string; returnToStock: boolean | null; returnReason: string | null;
  zatcaPhase: number; invoiceSubtype: string | null; einvoiceStatus: string | null; createdAt: Date; invoiceDate: Date; items: InvItemRow[];
}

interface State {
  tenant: { id: string; lotTrackingEnabled: boolean; lotTrackingSince: Date | null; warehouseEnabled: boolean; locationsEnabled: boolean };
  products: ProductRow[]; reps: { id: string; tenantId: string; name: string; canManageVanStock: boolean; locationId: string | null }[];
  units: { id: string; tenantId: string; productId: string; name: string; factor: number; isActive: boolean }[];
  lots: LotRow[]; vanLoads: VanLoadRow[]; vanItems: VanItemRow[]; vanItemLots: VanItemLotRow[]; whEntries: WhEntryRow[]; invoices: InvoiceRow[];
  events: Record<string, unknown>[];
  log: string[]; txOpts: unknown[]; scoped: boolean; outOfScope: Set<string>; txFail: unknown; tenantReads: number; seq: number; tick: number;
}
let S: State;

function product(id: string, name: string, extra: Partial<ProductRow> = {}): ProductRow {
  return { id, tenantId: T, name, unit: 'حبة', code: id, lotTracked: true, lotTrackedSince: null, shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, ...extra };
}
function reset(opts: { warehouse?: boolean; lots?: boolean } = {}): void {
  S = {
    tenant: { id: T, lotTrackingEnabled: opts.lots ?? true, lotTrackingSince: new Date(T0 - DAY_MS), warehouseEnabled: opts.warehouse ?? true, locationsEnabled: false },
    products: [
      product('pA', 'حليب', { shelfLifeEnabled: true, shelfLifeValue: 30, shelfLifeUnit: 'DAY' }),
      product('pB', 'عصير'),
      product('pC', 'بسكويت'),
      product('pU', 'ماء', { lotTracked: false }),
    ],
    reps: [{ id: 'r1', tenantId: T, name: 'سالم', canManageVanStock: true, locationId: null }, { id: 'r2', tenantId: T, name: 'خالد', canManageVanStock: true, locationId: null }],
    units: [{ id: 'u24', tenantId: T, productId: 'pC', name: 'كرتون', factor: 24, isActive: true }],
    lots: [], vanLoads: [], vanItems: [], vanItemLots: [], whEntries: [], invoices: [], events: [],
    log: [], txOpts: [], scoped: false, outOfScope: new Set(), txFail: null, tenantReads: 0, seq: 0, tick: 0,
  };
}
reset();

const nid = (p: string) => `${p}${++S.seq}`;
const clock = () => new Date(T0 + (++S.tick) * 1000);
const dayDate = (d: string | null) => (d ? new Date(`${d}T00:00:00.000Z`) : null);
/** دورة ماكرو: تتداخل المعاملات المتزامنة لولا الطابور — فاختبار التزامن ذو معنى */
const yieldTurn = () => new Promise<void>((r) => setImmediate(r));
const sinceOf = (pid: string): number => {
  const p = S.products.find((x) => x.id === pid);
  return Math.max(S.tenant.lotTrackingSince?.getTime() ?? -Infinity, p?.lotTrackedSince?.getTime() ?? -Infinity);
};
/** مرآة BASE_QTY_SQL */
const sqlBase = (r: { qty: number; unitFactor: number; baseQty: number | null }) => r.baseQty ?? r.qty * (r.unitFactor === 0 ? 1 : r.unitFactor);
const isHeld = (i: InvoiceRow) => i.type === 'RETURN' && i.zatcaPhase === 2 && i.invoiceSubtype === '01'
  && (i.einvoiceStatus == null || (LOT_HOLD_MIRRORS as readonly string[]).includes(i.einvoiceStatus));
const isDamaged = (i: InvoiceRow) => i.returnReason === 'DAMAGED' && i.createdAt >= DAMAGED_VAN_SINCE;

function group<R, K extends Record<string, unknown>>(rows: R[], key: (r: R) => K, qty: (r: R) => number, at?: (r: R) => Date | null):
  (K & { qty: number; first: Date | null })[] {
  const m = new Map<string, K & { qty: number; first: Date | null }>();
  for (const r of rows) {
    const k = key(r);
    const s = JSON.stringify(k);
    const g = m.get(s) ?? { ...k, qty: 0, first: null };
    g.qty += qty(r);
    const a = at?.(r);
    if (a && (!g.first || a < g.first)) g.first = a;
    m.set(s, g);
  }
  return [...m.values()];
}

const loadOf = (id: string) => S.vanLoads.find((l) => l.id === id)!;
const itemOf = (id: string) => S.vanItems.find((i) => i.id === id)!;

/** يجيب عبارات lotsDb.ts بنصّها (كما في lots-db.test.ts) — كل التجميعات بالحقبة والتوجيه والحجز */
function answerSql(sql: string, values: unknown[]): unknown[] {
  if (sql.includes('FOR KEY SHARE')) {
    const ids = values[1] as string[];
    S.log.push('q:FOR KEY SHARE');
    // وحدة الأساس حين يختارها الاستعلام (lockLotProducts وlockBases — «الوحدة الرئيسية» §2.6) لا في إعادة قراءة التتبّع وحدها
    return S.products.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, ...(/\bunit\b/.test(sql) && { unit: p.unit }), lotTracked: p.lotTracked, lotTrackedSince: p.lotTrackedSince }));
  }
  if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
  if (sql.includes('FROM van_load_item_lots l')) {
    S.log.push('q:van_load_item_lots');
    const wh = sql.includes('l."viaWarehouse" = true');
    const rows = S.vanItemLots.filter((r) => r.tenantId === T && r.createdAt.getTime() >= sinceOf(r.productId)
      && (!wh || (r.viaWarehouse && (r.moveType === 'LOAD' || r.moveType === 'UNLOAD'))));
    return group(rows, (r) => ({ productId: r.productId, lotId: r.lotId, vanKey: r.vanKey, moveType: r.moveType, viaWarehouse: r.viaWarehouse }),
      (r) => r.qty, (r) => (r.qty > 0 ? r.createdAt : null)).map(({ first, ...g }) => ({ ...g, firstInAt: first }));
  }
  if (sql.includes('FROM invoice_item_lots il') || sql.includes('FROM invoice_items it')) {
    S.log.push('q:invoices');
    const out: unknown[] = [];
    const conf = S.invoices.filter((i) => i.tenantId === T && i.status === 'CONFIRMED');
    const route = (i: InvoiceRow, it: InvItemRow) => ({ type: i.type, returnToStock: i.returnToStock, returnExpired: it.returnExpired, damaged: isDamaged(i), held: isHeld(i) });
    if (sql.includes('FROM invoice_item_lots il')) {
      const rows = conf.flatMap((i) => i.items.flatMap((it) => it.lots.filter((l) => l.createdAt.getTime() >= sinceOf(it.productId!)).map((l) => ({ i, it, l }))));
      out.push(...group(rows, ({ i, it, l }) => ({ productId: it.productId, lotId: l.lotId, vanKey: l.vanKey, ...route(i, it) }), ({ l }) => l.quantity, ({ l }) => l.createdAt)
        .map(({ first, ...g }) => ({ ...g, firstAt: first, src: 'LOT' })));
    }
    if (sql.includes('FROM invoice_items it')) {
      const rows = conf.filter((i) => i.salesRepId).flatMap((i) => i.items.filter((it) => it.productId).map((it) => ({ i, it })));
      out.push(...group(rows, ({ i, it }) => ({ productId: it.productId, lotId: null, vanKey: i.salesRepId, ...route(i, it) }), ({ it }) => sqlBase(it))
        .map(({ first: _f, ...g }) => ({ ...g, firstAt: null, src: 'TOT' })));
    }
    return out;
  }
  if (sql.includes('FROM lot_relabels r')) return [];
  if (sql.includes('FROM warehouse_entry_items wi')) {
    const rows = S.whEntries.filter((e) => e.tenantId === T).flatMap((e) => e.items.map((it) => ({ e, it })));
    if (sql.includes('"lotId" IS NOT NULL')) {
      return group(rows.filter(({ e, it }) => it.lotId && e.createdAt.getTime() >= sinceOf(it.productId)),
        ({ it }) => ({ productId: it.productId, lotId: it.lotId }), ({ it }) => sqlBase(it)).map(({ first: _f, ...g }) => g);
    }
    return group(rows, ({ e, it }) => ({ productId: it.productId, type: e.type }), ({ it }) => sqlBase(it)).map(({ first: _f, ...g }) => g);
  }
  if (sql.includes('FROM van_load_items vli')) {
    const rows = S.vanItems.map((it) => ({ it, l: loadOf(it.vanLoadId) })).filter(({ l }) => l.tenantId === T);
    if (sql.includes('AS "vanKey"')) {
      return group(rows.filter(({ l }) => l.salesRepId), ({ it, l }) => ({ productId: it.productId, vanKey: l.salesRepId, type: l.type }), ({ it }) => sqlBase(it))
        .map(({ first: _f, ...g }) => g);
    }
    return group(rows.filter(({ l }) => l.type === 'LOAD' || l.type === 'UNLOAD'), ({ it, l }) => ({ productId: it.productId, type: l.type }), ({ it }) => sqlBase(it))
      .map(({ first: _f, ...g }) => g);
  }
  throw new Error(`SQL غير متوقَّع في المزيّف: ${sql}`);
}

const render = (strings: TemplateStringsArray, values: unknown[]) => {
  const q = Prisma.sql(strings, ...(values as Prisma.Sql[]));
  return { sql: q.text.replace(/\s+/g, ' ').trim(), values: q.values };
};
const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean =>
  Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in (v as object)
    ? ((v as { in: unknown[] }).in).includes(row[k])
    : row[k] === v));
const lotView = (l: LotRow) => ({ lotNumber: l.lotNumber, expiryDate: l.expiryDate });

const db: Record<string, unknown> = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { await yieldTurn(); const r = render(strings, values); return answerSql(r.sql, r.values); },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    await yieldTurn();
    const r = render(strings, values);
    if (r.sql.includes('hashtext')) S.log.push(`exec:bucket:${String(r.values[0])}`);
    else if (r.sql.includes('pg_advisory_xact_lock')) S.log.push('exec:lot');
    return 1;
  },
  tenant: { findUnique: async () => { S.tenantReads++; return { ...S.tenant }; } },
  glSettings: { findUnique: async () => null },
  companySettings: { findUnique: async () => null },
  salesRep: {
    findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => {
      const r = S.reps.find((x) => x.id === where.id && x.tenantId === where.tenantId);
      return r ? { ...r, tenant: { locationsEnabled: S.tenant.locationsEnabled, lotTrackingEnabled: S.tenant.lotTrackingEnabled, warehouseEnabled: S.tenant.warehouseEnabled } } : null;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) => S.reps.filter((r) => matches(r, where)).map((r) => ({ id: r.id })),
  },
  product: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => { S.log.push('product.findMany'); return S.products.filter((p) => matches(p as unknown as Record<string, unknown>, where)).map((p) => ({ ...p })); },
    count: async ({ where }: { where: Record<string, unknown> }) => { S.log.push('product.count'); return S.products.filter((p) => matches(p as unknown as Record<string, unknown>, where)).length; },
  },
  productUnit: { findMany: async ({ where }: { where: Record<string, unknown> }) => S.units.filter((u) => matches(u, where)) },
  productLot: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => S.lots.filter((l) => matches(l as unknown as Record<string, unknown>, where)).map((l) => ({ ...l })),
    findFirst: async ({ where }: { where: Record<string, unknown> }) => S.lots.find((l) => matches(l as unknown as Record<string, unknown>, where)) ?? null,
    findUnique: async ({ where }: { where: { tenantId_productId_lotNumber: { tenantId: string; productId: string; lotNumber: string } } }) => {
      const k = where.tenantId_productId_lotNumber;
      return S.lots.find((l) => l.tenantId === k.tenantId && l.productId === k.productId && l.lotNumber === k.lotNumber) ?? null;
    },
    createMany: async ({ data }: { data: Partial<LotRow>[] }) => {
      let count = 0;
      for (const d of data) {
        if (S.lots.some((l) => l.tenantId === d.tenantId && l.productId === d.productId && l.lotNumber === d.lotNumber)) continue;
        S.lots.push({ id: nid('lot'), status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: clock(), note: null, sourceEntryId: null, createdBy: null, productionDate: null, expiryDate: null, ...d } as LotRow);
        count++;
      }
      return { count };
    },
  },
  lotEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { S.events.push(data); return data; } },
  invoiceItemLot: { findFirst: async ({ where }: { where: { tenantId: string; vanKey: string } }) => (S.invoices.some((i) => i.tenantId === where.tenantId && i.items.some((it) => it.lots.some((l) => l.vanKey === where.vanKey))) ? { id: 'il' } : null) },
  vanLoadItem: {
    findMany: async ({ where }: { where: { vanLoad: { tenantId: string; salesRepId: string } } }) => {
      S.log.push('computeStock');
      return S.vanItems.map((it) => ({ it, l: loadOf(it.vanLoadId) })).filter(({ l }) => l.tenantId === where.vanLoad.tenantId && l.salesRepId === where.vanLoad.salesRepId)
        .map(({ it, l }) => ({ productId: it.productId, qty: it.qty, unitFactor: it.unitFactor, baseQty: it.baseQty, vanLoad: { type: l.type, createdAt: l.createdAt } }));
    },
  },
  invoiceItem: {
    findMany: async ({ where }: { where: { invoice: { tenantId: string; salesRepId: string; status: string } } }) =>
      S.invoices.filter((i) => i.tenantId === where.invoice.tenantId && i.salesRepId === where.invoice.salesRepId && i.status === where.invoice.status)
        .flatMap((i) => i.items.map((it) => ({
          productId: it.productId, qty: it.qty, unitFactor: it.unitFactor, baseQty: it.baseQty, returnExpired: it.returnExpired,
          invoice: { type: i.type, returnToStock: i.returnToStock, invoiceDate: i.invoiceDate, returnReason: i.returnReason, createdAt: i.createdAt },
        }))),
  },
  vanLoad: {
    findFirst: async ({ where }: { where: { tenantId: string; deletedSalesRepId: string } }) =>
      S.vanLoads.find((l) => l.tenantId === where.tenantId && l.deletedSalesRepId === where.deletedSalesRepId) ?? null,
    count: async () => S.vanLoads.length,
    findMany: async ({ where, include }: { where: { tenantId: string; salesRepId?: string }; include: { items: { include: Record<string, unknown> } } }) =>
      S.vanLoads.filter((l) => l.tenantId === where.tenantId && (!where.salesRepId || l.salesRepId === where.salesRepId)).map((l) => ({
        ...l, salesRep: S.reps.find((r) => r.id === l.salesRepId) ?? null, location: null,
        items: S.vanItems.filter((it) => it.vanLoadId === l.id).map((it) => ({
          ...it, product: S.products.find((p) => p.id === it.productId),
          ...('lots' in include.items.include && { lots: S.vanItemLots.filter((x) => x.vanLoadItemId === it.id).map((x) => ({ ...x, lot: x.lotId ? lotView(S.lots.find((y) => y.id === x.lotId)!) : null })) }),
        })),
      })),
    create: async ({ data, include }: { data: Record<string, unknown> & { items: { create: Record<string, unknown>[] } }; include: { items: { include: Record<string, unknown> } } }) => {
      await yieldTurn();
      S.log.push('create:vanLoad');
      const load: VanLoadRow = {
        id: nid('vl'), tenantId: data.tenantId as string, salesRepId: (data.salesRepId as string | null) ?? null,
        deletedSalesRepId: (data.deletedSalesRepId as string | undefined) ?? null, type: data.type as string, note: (data.note as string | undefined) ?? null,
        createdBy: (data.createdBy as string) ?? null, locationId: (data.locationId as string | undefined) ?? null, createdAt: clock(),
      };
      S.vanLoads.push(load);
      const items = data.items.create.map((c) => {
        const row: VanItemRow = {
          id: nid('vi'), vanLoadId: load.id, productId: c.productId as string, qty: c.qty as number, unitName: (c.unitName as string | null) ?? null,
          unitFactor: (c.unitFactor as number) ?? 1, baseQty: (c.baseQty as number | null) ?? null,
          suggestedQty: (c.suggestedQty as number | null) ?? null, expectedQty: (c.expectedQty as number | null) ?? null,
        };
        S.vanItems.push(row);
        const lots = ((c.lots as { create?: Record<string, unknown>[] } | undefined)?.create ?? []).map((x) => {
          const r = { id: nid('vil'), vanLoadItemId: row.id, createdAt: load.createdAt, ...x } as VanItemLotRow;
          S.vanItemLots.push(r);
          return r;
        });
        return {
          ...row, product: S.products.find((p) => p.id === row.productId),
          ...('lots' in include.items.include && { lots: lots.map((x) => ({ ...x, lot: x.lotId ? lotView(S.lots.find((y) => y.id === x.lotId)!) : null })) }),
        };
      });
      return { ...load, items };
    },
  },
};
db.$transaction = async (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
  S.txOpts.push(opts ?? null);
  // التراجع عند الخطأ: لوطٌ أُنشئ ثم رُفضت الحركة لا يبقى (كمعاملة القاعدة)
  const snap = { lots: [...S.lots], vanLoads: [...S.vanLoads], vanItems: [...S.vanItems], vanItemLots: [...S.vanItemLots], events: [...S.events] };
  try {
    if (S.txFail) throw S.txFail;
    return await fn(db);
  } catch (e) {
    Object.assign(S, snap);
    throw e;
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
  canAccessRep: async (_req: unknown, _tid: string, id: string) => !S.outOfScope.has(id),
  adminRepFilter: async () => ({}),
  adminScopeEnabled: async () => S.scoped,
  scopedRepRecordWhere: async () => ({}),
  scopedRecordWhere: async () => ({}),
  SHAPE_INVOICE_RECEIPT: {},
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/vanStock').default as Router;

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
const REP = { role: 'SALES_REP', id: 'r1', tenantId: T, name: 'سالم' };
async function call(method: 'get' | 'post', p: string, opts: { user?: unknown; body?: unknown; query?: Record<string, string> } = {}): Promise<Res> {
  const res: Res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b as Record<string, unknown>; return this; } };
  const req = { user: opts.user ?? ADMIN, body: opts.body ?? {}, query: opts.query ?? {}, headers: {}, params: {} };
  let err: unknown = null;
  await handler(method, p)(req, res, (e?: unknown) => { if (e) err = e; });
  if (err) {
    let passed: unknown = null;
    errLayer.handle(err, req, res, (e?: unknown) => { passed = e ?? null; });
    if (passed) { res.statusCode = 500; res.body = { success: false, unhandled: String((passed as Error)?.message ?? passed) }; }
  }
  return res;
}
const post = (body: Record<string, unknown>, user: unknown = ADMIN) => call('post', '/loads', { body, user });

// ═══ البذور ═══

function lot(id: string, pid: string, expiry: string | null, extra: Partial<LotRow> = {}): LotRow {
  const row: LotRow = {
    id, tenantId: T, productId: pid, lotNumber: id.toUpperCase(), productionDate: null, expiryDate: dayDate(expiry), status: 'ACTIVE', blockKind: null,
    blockedAt: null, createdAt: new Date(T0 - 3600_000 + S.lots.length * 1000), source: 'MANUAL', sourceEntryId: null, createdBy: null, note: null, ...extra,
  };
  S.lots.push(row);
  return row;
}
/** وارد المستودع (بالأساس) — `at` قبل الحقبة ⇒ غير مسمّى من تاريخ ما قبل التفعيل */
function receive(pid: string, qty: number, lotId: string | null, at: Date = clock()): void {
  S.whEntries.push({ id: nid('we'), tenantId: T, type: 'RECEIVE', createdAt: at, items: [{ productId: pid, qty, unitFactor: 1, baseQty: qty, lotId }] });
}
/** حركة سيارة سابقة كما كان المسار سيكتبها (بالأساس) */
function seedMove(vanKey: string, type: string, pid: string, qty: number, rows: { lotId: string | null; qty: number }[], opts: { via?: boolean; deleted?: boolean; at?: Date } = {}): void {
  const at = opts.at ?? clock();
  const load: VanLoadRow = { id: nid('vl'), tenantId: T, salesRepId: opts.deleted ? null : vanKey, deletedSalesRepId: opts.deleted ? vanKey : null, type, note: null, createdBy: 'ADMIN', locationId: null, createdAt: at };
  S.vanLoads.push(load);
  const item: VanItemRow = { id: nid('vi'), vanLoadId: load.id, productId: pid, qty, unitName: null, unitFactor: 1, baseQty: qty, suggestedQty: null, expectedQty: null };
  S.vanItems.push(item);
  for (const r of rows) {
    S.vanItemLots.push({ id: nid('vil'), vanLoadItemId: item.id, tenantId: T, productId: pid, vanKey, moveType: type, viaWarehouse: opts.via ?? (type === 'LOAD' || type === 'UNLOAD'), lotId: r.lotId, qty: r.qty, certainty: 'CONFIRMED', reason: null, createdAt: at });
  }
}
/** فاتورة مؤكَّدة في سيارة (بيع، أو مرتجع منتهٍ يدخل دلو المنتهي) بصفوف لوطها */
function seedInvoice(rep: string, type: 'CASH' | 'RETURN', pid: string, qty: number, rows: { lotId: string | null; qty: number }[], extra: Partial<InvoiceRow> & { returnExpired?: boolean } = {}): void {
  const at = clock();
  const { returnExpired, ...rest } = extra;
  S.invoices.push({
    id: nid('inv'), tenantId: T, salesRepId: rep, type, status: 'CONFIRMED', returnToStock: type === 'RETURN' ? true : null, returnReason: null,
    zatcaPhase: 1, invoiceSubtype: null, einvoiceStatus: null, createdAt: at, invoiceDate: at, ...rest,
    items: [{ id: nid('ii'), productId: pid, qty, unitFactor: 1, baseQty: qty, returnExpired: returnExpired ?? null,
      lots: rows.map((r) => ({ id: nid('il'), lotId: r.lotId, quantity: r.qty, certainty: 'CONFIRMED', expiryDate: null, vanKey: rep, createdAt: at })) }],
  });
}

/** العروض الحالية (الخام والصالح وغير المسمّى) كما يقرؤها المسار — المستودع وسيارة */
async function views(pid: string, vanKey = 'r1'): Promise<{ wh: PlaceLotView; van: PlaceLotView }> {
  const pv = await placeViews(db as unknown as LotDb, T, { warehouse: true, vanKeys: [vanKey], productIds: [pid], withTotals: true });
  return { wh: pv.warehouse.get(pid)!, van: pv.vans.get(vanKey)!.get(pid)! };
}
const usableOf = (v: PlaceLotView, lotId: string, b: LotBucket = 'SELLABLE') => v.lots.find((l) => l.lotId === lotId)?.usable[b] ?? 0;
const lastLoad = () => S.vanLoads[S.vanLoads.length - 1];
const lotRowsOf = (loadId: string) => S.vanItems.filter((i) => i.vanLoadId === loadId).map((i) => S.vanItemLots.filter((x) => x.vanLoadItemId === i.id)
  .map((x) => ({ lotId: x.lotId, qty: x.qty, certainty: x.certainty, viaWarehouse: x.viaWarehouse, moveType: x.moveType, vanKey: x.vanKey, reason: x.reason })));
const codeOf = (r: Res) => r.body?.code;
const warnCodes = (r: Res) => ((r.body?.warnings as { code: string }[] | undefined) ?? []).map((w) => w.code);

// ═══ التحميل ═══

test('التحميل بالمستودع: FEFO من لوطات المستودع لكل سطر، viaWarehouse، ومجموع الصفوف = الكمية الأساسية (I3)، ومهلة اللوط (D13)', async () => {
  reset();
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2);
  receive('pB', 10, 'l1'); receive('pB', 10, 'l2');
  const res = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 15 }] });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(lotRowsOf(lastLoad().id), [[
    { lotId: 'l1', qty: 10, certainty: 'ASSUMED', viaWarehouse: true, moveType: 'LOAD', vanKey: 'r1', reason: null },
    { lotId: 'l2', qty: 5, certainty: 'ASSUMED', viaWarehouse: true, moveType: 'LOAD', vanKey: 'r1', reason: null },
  ]]);
  assert.deepEqual(S.txOpts.at(-1), { maxWait: 10_000, timeout: 20_000 });
  assert.deepEqual(warnCodes(res), ['LOT_MULTI_IN_VAN'], 'تشغيلتان في السيارة بعد التحميل');
  const item = (res.body!.data as { items: { lots: { lot: { lotNumber: string } }[] }[] }).items[0];
  assert.deepEqual(item.lots.map((l) => l.lot.lotNumber), ['L1', 'L2'], 'الردّ يحمل التشغيلات برقمها');
  const v = await views('pB');
  assert.equal(usableOf(v.wh, 'l1'), 0);
  assert.equal(usableOf(v.wh, 'l2'), 5);
  assert.equal(usableOf(v.van, 'l1'), 10);
  assert.equal(v.van.unknown!.SELLABLE, 0, 'رصيد الصنف = Σ المسمّى');
});

test('التحميل بالمستودع: الصريح يُحقَّق — فوق صالح اللوط 409 ولا كتابة، ولوط صنفٍ آخر أو شركةٍ أخرى، والموقوف والمنتهي، وΣ ≠ الكمية', async () => {
  reset();
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2); lot('la', 'pA', FAR1); lot('lx', 'pB', FAR1, { tenantId: 'other' });
  lot('lb', 'pB', FAR1, { status: 'BLOCKED', blockKind: 'RECALL' }); lot('le', 'pB', PAST);
  for (const id of ['l1', 'l2', 'lb', 'le']) receive('pB', 10, id);
  const n0 = S.vanLoads.length;
  const over = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 15, lots: [{ lotId: 'l2', qty: 15 }] }] });
  assert.equal(over.statusCode, 409);
  assert.equal(codeOf(over), 'LOT_STOCK_INSUFFICIENT');
  assert.match(String(over.body!.message), /«عصير»/);
  assert.equal(S.vanLoads.length, n0, 'الرفض لا يكتب حركة');
  const cases: [unknown[], number, string][] = [
    [[{ lotId: 'la', qty: 2 }], 422, 'LOT_PRODUCT_MISMATCH'],
    [[{ lotId: 'lx', qty: 2 }], 422, 'LOT_NOT_FOUND'],
    [[{ lotId: 'lb', qty: 2 }], 422, 'LOT_BLOCKED'],
    [[{ lotId: 'le', qty: 2 }], 422, 'LOT_EXPIRED'],
    [[{ lotId: 'l1', qty: 1 }], 422, 'LOT_QTY_INVALID'],
    [[{ lotId: 'l1', qty: 1.00005 }, { lotId: 'l2', qty: 0.99995 }], 422, 'LOT_QTY_INVALID'],
  ];
  for (const [lots, status, code] of cases) {
    const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 2, lots }] });
    assert.deepEqual([r.statusCode, codeOf(r)], [status, code], JSON.stringify(lots));
  }
  const ok = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 10, lots: [{ lotId: 'l1', qty: 4 }, { lotId: 'l2', qty: 6 }] }] });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((r) => [r.lotId, r.qty, r.certainty]), [['l1', 4, 'CONFIRMED'], ['l2', 6, 'CONFIRMED']]);
  // سطران على التشغيلة نفسها يُجمعان قبل الفحص (D26): ٤ + ٣ > ٦ الباقية
  const both = await post({ salesRepId: 'r1', type: 'LOAD', items: [
    { productId: 'pB', qty: 4, lots: [{ lotId: 'l1', qty: 4 }] }, { productId: 'pB', qty: 3, lots: [{ lotId: 'l1', qty: 3 }] },
  ] });
  assert.deepEqual([both.statusCode, codeOf(both)], [409, 'LOT_STOCK_INSUFFICIENT']);
});

test('D18: التحميل قبل وارد التشغيلة يُرفض 409 «سجّل وارد التشغيلة أولاً»، ورصيد ما قبل التفعيل يُحمَّل غير مسمّى بتحذير ولا يُنقص دون الصفر', async () => {
  reset();
  const none = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 2 }] });
  assert.deepEqual([none.statusCode, codeOf(none)], [409, 'LOT_STOCK_INSUFFICIENT']);
  assert.match(String(none.body!.message), /سجّل وارد التشغيلة أولاً/);
  assert.equal((none.body!.detail as { hint?: string }).hint, 'RECEIVE_FIRST');
  receive('pB', 8, null, new Date(T0 - 2 * DAY_MS)); // قبل الحقبة: غير مسمّى
  const a = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 5 }] });
  assert.equal(a.statusCode, 201);
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((r) => [r.lotId, r.qty, r.certainty]), [[null, 5, 'UNKNOWN']]);
  assert.ok(warnCodes(a).includes('LOT_FROM_UNKNOWN'));
  const b = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 5 }] });
  assert.deepEqual([b.statusCode, codeOf(b)], [409, 'LOT_STOCK_INSUFFICIENT'], 'الباقي ٣ لا ٥ (I2)');
  assert.equal((await views('pB')).wh.unknownUsable!.SELLABLE, 3);
});

test('D4 بلا مستودع: رقمٌ جديد ينشئ التشغيلة بمصدر LOAD، وبلا تشغيلة LOT_REQUIRED، وnull صريح غير مسمّى، والانتهاء إلزامي مع الصلاحية', async () => {
  reset({ warehouse: false });
  const a = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 6, lotNumber: ' ab-١٢ ', expiryDate: FAR1 }] });
  assert.equal(a.statusCode, 201, JSON.stringify(a.body));
  const created = S.lots.find((l) => l.lotNumber === 'AB-12')!;
  assert.ok(created, 'الرقم مطبَّع');
  assert.equal(created.source, 'LOAD');
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((r) => [r.lotId, r.qty, r.certainty, r.viaWarehouse]), [[created.id, 6, 'CONFIRMED', false]], 'D28: بلا مستودع');
  assert.equal(S.events.filter((e) => e.kind === 'CREATE').length, 1, 'LotEvent CREATE');
  // الرقم القائم بتاريخٍ آخر يُرفض، وبلا تاريخ يُستعمل
  const mism = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 1, lotNumber: 'AB-12', expiryDate: FAR2 }] });
  assert.deepEqual([mism.statusCode, codeOf(mism)], [409, 'LOT_DATES_MISMATCH']);
  const none = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 2 }] });
  assert.deepEqual([none.statusCode, codeOf(none)], [422, 'LOT_REQUIRED']);
  assert.match(String(none.body!.message), /«عصير»/);
  const unk = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 2, lots: [{ lotId: null, qty: 2 }] }] });
  assert.equal(unk.statusCode, 201);
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((r) => [r.lotId, r.certainty]), [[null, 'UNKNOWN']]);
  const nLots = S.lots.length;
  const noExp = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pA', qty: 2, lotNumber: 'X1' }] });
  assert.deepEqual([noExp.statusCode, codeOf(noExp)], [422, 'LOT_EXPIRY_REQUIRED']);
  assert.equal(S.lots.length, nLots);
  // تشغيلةٌ أُنشئت ثم رُفضت الحركة في السطر التالي لا تبقى (تراجع المعاملة)
  const rolled = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 1, lotNumber: 'NEW-9' }, { productId: 'pB', qty: 1 }] });
  assert.equal(rolled.statusCode, 422);
  assert.ok(!S.lots.some((l) => l.lotNumber === 'NEW-9'));
  lot('lb', 'pB', FAR1, { status: 'BLOCKED', blockKind: 'HOLD' }); lot('le', 'pB', PAST);
  for (const [lots, code] of [[[{ lotId: 'lb', qty: 1 }], 'LOT_BLOCKED'], [[{ lotId: 'le', qty: 1 }], 'LOT_EXPIRED']] as const) {
    const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 1, lots }] });
    assert.deepEqual([r.statusCode, codeOf(r)], [422, code], 'I4: لا تحميل إلى موقوف أو منتهٍ');
  }
  const byNum = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 1, lotNumber: 'LB' }] });
  assert.deepEqual([byNum.statusCode, codeOf(byNum)], [422, 'LOT_BLOCKED'], 'برقمٍ قائم موقوف كذلك');
  lot('lx', 'pB', FAR1, { tenantId: 'other' }); lot('la', 'pA', FAR1);
  for (const [lotId, code] of [['lx', 'LOT_NOT_FOUND'], ['nope', 'LOT_NOT_FOUND'], ['la', 'LOT_PRODUCT_MISMATCH']] as const) {
    const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 1, lots: [{ lotId, qty: 1 }] }] });
    assert.deepEqual([r.statusCode, codeOf(r)], [422, code], `I5: ${lotId}`);
  }
});

test('المندوب: في شركة بلا مستودع LOT_REQUIRED «تحميل الأصناف المتتبَّعة يتم من لوحة الإدارة»، وفي شركة المستودع يوزّع الخادم ويُهمَل صريحه', async () => {
  reset({ warehouse: false });
  const r = await post({ type: 'LOAD', items: [{ productId: 'pB', qty: 2, lotNumber: 'R-1' }] }, REP);
  assert.deepEqual([r.statusCode, codeOf(r)], [422, 'LOT_REQUIRED']);
  assert.equal(r.body!.message, 'تحميل الأصناف المتتبَّعة يتم من لوحة الإدارة');
  assert.ok(!S.lots.some((l) => l.lotNumber === 'R-1'), 'المندوب لا ينشئ تشغيلة');
  reset();
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2);
  receive('pB', 10, 'l1');
  const ok = await post({ type: 'LOAD', items: [{ productId: 'pB', qty: 3, lots: [{ lotId: 'l2', qty: 3 }] }, { productId: 'pU', qty: 4 }] }, REP);
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.body));
  const rows = lotRowsOf(lastLoad().id);
  assert.deepEqual(rows[0].map((x) => [x.lotId, x.qty, x.certainty]), [['l1', 3, 'CONFIRMED']], 'المصدر الوحيد في المستودع ⇒ مؤكَّد');
  assert.deepEqual(rows[1], [], 'الصنف غير المتتبَّع بلا صفوف');
  assert.equal(lastLoad().createdBy, 'REP');
});

// ═══ التنزيل والتسوية والإزالة ═══

test('التنزيل: المصدر الوحيد تلقائياً (CONFIRMED) ويعود للمستودع، وأكثر من مصدر LOT_REQUIRED بالقائمة، والصريح بعد التجميع (D26) ثم التلقائي مما بقي', async () => {
  reset();
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2);
  receive('pB', 5, 'l1'); receive('pB', 4, 'l2');
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 5, lots: [{ lotId: 'l1', qty: 5 }] }] })).statusCode, 201);
  const u1 = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pB', qty: 2 }] });
  assert.equal(u1.statusCode, 201);
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((r) => [r.lotId, r.qty, r.certainty, r.viaWarehouse]), [['l1', 2, 'CONFIRMED', true]]);
  assert.equal(usableOf((await views('pB')).wh, 'l1'), 2, 'التنزيل يعيد التشغيلة للمستودع (D28)');
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 4, lots: [{ lotId: 'l2', qty: 4 }] }] })).statusCode, 201);
  const two = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pB', qty: 1 }] });
  assert.deepEqual([two.statusCode, codeOf(two)], [422, 'LOT_REQUIRED']);
  assert.match(String(two.body!.message), /«عصير»/);
  assert.deepEqual(((two.body!.detail as { sources: { lotId: string }[] }).sources).map((s) => s.lotId), ['l1', 'l2']);
  const n0 = S.vanLoads.length;
  const agg = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [
    { productId: 'pB', qty: 2, lots: [{ lotId: 'l2', qty: 2 }] }, { productId: 'pB', qty: 3, lots: [{ lotId: 'l2', qty: 3 }] },
  ] });
  assert.deepEqual([agg.statusCode, codeOf(agg)], [409, 'LOT_STOCK_INSUFFICIENT'], '٢ + ٣ على تشغيلةٍ صالحها ٤');
  assert.equal(S.vanLoads.length, n0);
  const mixed = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [
    { productId: 'pB', qty: 4, lots: [{ lotId: 'l2', qty: 4 }] }, { productId: 'pB', qty: 1 },
  ] });
  assert.equal(mixed.statusCode, 201, JSON.stringify(mixed.body));
  assert.deepEqual(lotRowsOf(lastLoad().id).map((rs) => rs.map((r) => [r.lotId, r.qty])), [[['l2', 4]], [['l1', 1]]], 'بعد الصريح يبقى مصدرٌ واحد');
  const v = await views('pB');
  assert.deepEqual([usableOf(v.van, 'l1'), usableOf(v.van, 'l2'), usableOf(v.wh, 'l1'), usableOf(v.wh, 'l2')], [2, 0, 3, 4]);
});

test('التنزيل يُخرج الموقوف والمنتهي (مسار السحب)، والسالب لأي نوعٍ غير التسوية يُرفض (I7)، والكسر الخامس يُرفض (isLotQty)', async () => {
  reset();
  lot('l1', 'pB', FAR1); lot('le', 'pB', PAST);
  receive('pB', 5, 'l1'); receive('pB', 2, 'le');
  seedMove('r1', 'LOAD', 'pB', 5, [{ lotId: 'l1', qty: 5 }]);
  seedMove('r1', 'LOAD', 'pB', 2, [{ lotId: 'le', qty: 2 }]);
  S.lots.find((l) => l.id === 'l1')!.status = 'BLOCKED';
  const out = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pB', qty: 7, lots: [{ lotId: 'l1', qty: 5 }, { lotId: 'le', qty: 2 }] }] });
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  for (const type of ['UNLOAD', 'LOAD', 'EXPIRED_OUT', 'DAMAGED_OUT']) {
    const r = await post({ salesRepId: 'r1', type, items: [{ productId: 'pB', qty: -1 }] });
    if (type === 'EXPIRED_OUT' || type === 'DAMAGED_OUT') { assert.equal(r.statusCode, 400, type); continue; } // حارس الإزالة القائم أولاً
    assert.deepEqual([r.statusCode, codeOf(r)], [422, 'LOT_QTY_INVALID'], type);
  }
  const fine = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: 1.00005, lots: [{ lotId: null, qty: 1.00005 }] }] });
  assert.deepEqual([fine.statusCode, codeOf(fine)], [422, 'LOT_QTY_INVALID']);
  // غير المتتبَّع يبقى على قاعدته القديمة: الإداري يرسل السالب كما اليوم
  assert.equal((await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pU', qty: -1 }] })).statusCode, 201);
});

test('تسوية النقص: من مصدرٍ صريح بإشارة البند، والإتلاف EXPIRED_UNSOLD_DESTROY لتشغيلةٍ منتهية وحدها، والوسم في غير تسوية النقص يُرفض', async () => {
  reset();
  lot('l1', 'pB', FAR1); lot('le', 'pB', PAST);
  seedMove('r1', 'ADJUST', 'pB', 3, [{ lotId: 'l1', qty: 3 }], { via: false });
  seedMove('r1', 'ADJUST', 'pB', 4, [{ lotId: 'le', qty: 4 }], { via: false });
  const d = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -2, lots: [{ lotId: 'le', qty: -2 }], lotReason: 'EXPIRED_UNSOLD_DESTROY' }] });
  assert.equal(d.statusCode, 201, JSON.stringify(d.body));
  assert.deepEqual(lotRowsOf(lastLoad().id)[0], [{ lotId: 'le', qty: -2, certainty: 'CONFIRMED', viaWarehouse: false, moveType: 'ADJUST', vanKey: 'r1', reason: 'EXPIRED_UNSOLD_DESTROY' }]);
  assert.equal(S.vanItems.find((i) => i.vanLoadId === lastLoad().id)!.qty, -2);
  const notExpired = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -1, lots: [{ lotId: 'l1', qty: 1 }], lotReason: 'EXPIRED_UNSOLD_DESTROY' }] });
  assert.equal(notExpired.statusCode, 400);
  assert.match(String(notExpired.body!.message), /منتهية وحدها/);
  const onLoad = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: 1, lots: [{ lotId: 'l1', qty: 1 }], lotReason: 'EXPIRED_UNSOLD_DESTROY' }] });
  assert.equal(onLoad.statusCode, 400);
  const unknownReason = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -1, lots: [{ lotId: 'le', qty: 1 }], lotReason: 'X' }] });
  assert.equal(unknownReason.statusCode, 400);
  const over = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -3, lots: [{ lotId: 'le', qty: 3 }] }] });
  assert.deepEqual([over.statusCode, codeOf(over)], [409, 'LOT_STOCK_INSUFFICIENT'], 'الباقي ٢');
  const two = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -1 }] });
  assert.deepEqual([two.statusCode, codeOf(two)], [422, 'LOT_REQUIRED'], 'D10: مصدران ⇒ صريح');
  // الإنقاص برقم تشغيلةٍ قائمة (المفتاح): يُحلّ إلى صفّها الصريح، ولا يُنشئ تشغيلة
  const byNum = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -1, lotNumber: 'l1' }] });
  assert.equal(byNum.statusCode, 201, JSON.stringify(byNum.body));
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((r) => [r.lotId, r.qty]), [['l1', -1]]);
  const noNum = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: -1, lotNumber: 'NOPE' }] });
  assert.deepEqual([noNum.statusCode, codeOf(noNum)], [422, 'LOT_NOT_FOUND']);
  assert.ok(!S.lots.some((l) => l.lotNumber === 'NOPE'));
  const v = (await views('pB')).van;
  assert.deepEqual([usableOf(v, 'l1'), usableOf(v, 'le')], [2, 2]);
});

test('التسوية بالزيادة: تشغيلةٌ قائمة أو رقمٌ جديد بمصدر LOAD أو null صريح، والموقوفة تُقبل بتحذير LOT_INTO_BLOCKED، وبلا شيء LOT_REQUIRED', async () => {
  reset();
  lot('lb', 'pB', FAR1, { status: 'BLOCKED', blockKind: 'HOLD' });
  const a = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: 3, lots: [{ lotId: 'lb', qty: 3 }] }] });
  assert.equal(a.statusCode, 201);
  assert.ok(warnCodes(a).includes('LOT_INTO_BLOCKED'));
  const b = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: 2, lotNumber: 'NEW-1' }] });
  assert.equal(b.statusCode, 201);
  assert.equal(S.lots.find((l) => l.lotNumber === 'NEW-1')!.source, 'LOAD');
  assert.ok(warnCodes(b).includes('LOT_MULTI_IN_VAN'), 'تشغيلتان في السيارة');
  const c = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: 1, lots: [{ lotId: null, qty: 1 }] }] });
  assert.equal(c.statusCode, 201);
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((r) => [r.lotId, r.qty, r.certainty, r.viaWarehouse]), [[null, 1, 'UNKNOWN', false]]);
  const d = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: 1 }] });
  assert.deepEqual([d.statusCode, codeOf(d)], [422, 'LOT_REQUIRED']);
  const both = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pB', qty: 1, lotNumber: 'Z', lots: [{ lotId: null, qty: 1 }] }] });
  assert.deepEqual([both.statusCode, codeOf(both)], [422, 'LOT_QTY_INVALID'], 'رقمٌ وصفوفٌ معاً');
});

test('الإزالة (EXPIRED_OUT): قفل الدلو ثم قفل الأصناف ثم assertOutAvailable ثم التوزيع ثم الإنشاء — ومن دلو المنتهي باللوط', async () => {
  reset();
  lot('le', 'pB', PAST);
  seedInvoice('r1', 'RETURN', 'pB', 3, [{ lotId: 'le', qty: 3 }], { returnExpired: true });
  S.log = [];
  const r = await post({ salesRepId: 'r1', type: 'EXPIRED_OUT', items: [{ productId: 'pB', qty: 2 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty, x.moveType, x.viaWarehouse]), [['le', 2, 'EXPIRED_OUT', false]]);
  const at = (s: string) => S.log.indexOf(s);
  const order = ['exec:bucket:van-expired:r1', 'q:FOR KEY SHARE', 'exec:lot', 'computeStock', 'q:van_load_item_lots', 'create:vanLoad'];
  for (const s of order) assert.ok(at(s) >= 0, `${s} مفقود: ${S.log.join(' ')}`);
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} قبل ${order[i]}: ${S.log.join(' ')}`);
  assert.equal((await views('pB')).van.lots.find((l) => l.lotId === 'le')!.usable.EXPIRED, 1);
  // فوق رصيد الدلو: حارس الإزالة القائم (400) قبل الخطة
  const over = await post({ salesRepId: 'r1', type: 'EXPIRED_OUT', items: [{ productId: 'pB', qty: 2 }] });
  assert.equal(over.statusCode, 400);
  // مرتجعٌ منتهٍ بلا صفوف لوط (قبل التتبّع) ⇒ مصدران في الدلو: صريحٌ لازم
  seedInvoice('r1', 'RETURN', 'pB', 2, [], { returnExpired: true });
  const two = await post({ salesRepId: 'r1', type: 'EXPIRED_OUT', items: [{ productId: 'pB', qty: 1 }] });
  assert.deepEqual([two.statusCode, codeOf(two)], [422, 'LOT_REQUIRED']);
  const unk = await post({ salesRepId: 'r1', type: 'EXPIRED_OUT', items: [{ productId: 'pB', qty: 2, lots: [{ lotId: null, qty: 2 }] }] });
  assert.equal(unk.statusCode, 201);
  const unk2 = await post({ salesRepId: 'r1', type: 'DAMAGED_OUT', items: [{ productId: 'pB', qty: 1, lots: [{ lotId: null, qty: 1 }] }] });
  assert.equal(unk2.statusCode, 400, 'لا تالف في السيارة');
});

// ═══ الوحدات المتعددة (D22) ═══

test('الوحدات: سطرٌ بكرتون وسطرٌ بحبة للصنف نفسه — الكرتون من لوطٍ واحد بلا تقسيم، ومجموع صفوف كل سطر كميته الأساسية (I3)', async () => {
  reset();
  lot('c1', 'pC', FAR1); lot('c2', 'pC', FAR2);
  receive('pC', 30, 'c1'); receive('pC', 30, 'c2');
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pC', qty: 2, unitId: 'u24' }, { productId: 'pC', qty: 5 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  const items = S.vanItems.filter((i) => i.vanLoadId === lastLoad().id);
  assert.deepEqual(items.map((i) => [i.qty, i.unitFactor, i.baseQty]), [[2, 24, 48], [5, 1, 5]]);
  const rows = lotRowsOf(lastLoad().id);
  assert.deepEqual(rows.map((rs) => rs.map((x) => [x.lotId, x.qty])), [[['c1', 24], ['c2', 24]], [['c1', 5]]],
    'كل كرتونٍ كاملٌ من تشغيلة — لا «c1 30 + c2 18» الذي يشقّ كرتوناً (التجميع ثم distributeToLines)');
  rows.forEach((rs, i) => assert.equal(rs.reduce((s, x) => s + x.qty, 0), baseQtyOf(items[i])));
  assert.ok(!warnCodes(r).includes('LOT_SPLIT_UNIT'));
  // تنزيل كرتونٍ صريحاً: الصفوف بالأساس (٢٤) لا بالكراتين
  const bad = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pC', qty: 1, unitId: 'u24', lots: [{ lotId: 'c2', qty: 1 }] }] });
  assert.deepEqual([bad.statusCode, codeOf(bad)], [422, 'LOT_QTY_INVALID']);
  const back = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pC', qty: 1, unitId: 'u24', lots: [{ lotId: 'c2', qty: 24 }] }] });
  assert.equal(back.statusCode, 201);
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty]), [['c2', 24]]);
});

test('الوحدات: التقسيم المحتوم يُوسَم SPLIT_UNIT بتحذيرٍ لسطره {unitFactor, idx} ولا يُخفى', async () => {
  reset();
  lot('c3', 'pC', FAR1); lot('c4', 'pC', FAR2);
  receive('pC', 36, 'c3'); receive('pC', 12, 'c4');
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 1 }, { productId: 'pC', qty: 2, unitId: 'u24' }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepEqual(lotRowsOf(lastLoad().id)[1].map((x) => [x.lotId, x.qty]), [['c3', 36], ['c4', 12]]);
  const w = (r.body!.warnings as { code: string; detail?: Record<string, unknown> }[]).find((x) => x.code === 'LOT_SPLIT_UNIT');
  assert.deepEqual(w?.detail, { unitFactor: 24, idx: 1 });
});

test('idx في التحذير والخطأ موضع السطر في طلب العميل: السطر الصفري يُرشَّح ولا يزيح ما بعده، وصفوف كل بندٍ لبنده (§٢.٦)', async () => {
  reset();
  lot('c3', 'pC', FAR1); lot('c4', 'pC', FAR2); lot('l1', 'pB', FAR1);
  receive('pC', 36, 'c3'); receive('pC', 12, 'c4'); receive('pB', 10, 'l1');
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 1 }, { productId: 'pU', qty: 0 }, { productId: 'pC', qty: 2, unitId: 'u24' }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  const w = (r.body!.warnings as { code: string; detail?: Record<string, unknown> }[]).find((x) => x.code === 'LOT_SPLIT_UNIT');
  assert.deepEqual(w?.detail, { unitFactor: 24, idx: 2 }, 'سطر الكرتون ثالثٌ في الطلب لا ثانٍ بعد الترشيح');
  // الصفري لا يُكتب، وكل بندٍ مكتوب بصفوف سطره هو (I3)
  const items = S.vanItems.filter((i) => i.vanLoadId === lastLoad().id);
  assert.deepEqual(items.map((i) => [i.productId, i.baseQty]), [['pB', 1], ['pC', 48]]);
  assert.deepEqual(lotRowsOf(lastLoad().id).map((rs) => rs.map((x) => [x.lotId, x.qty])), [[['l1', 1]], [['c3', 36], ['c4', 12]]]);
  // والخطأ بسطره: كسرٌ بخمس خانات (isLotQty) في السطر الثاني من الطلب
  const frac = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 0 }, { productId: 'pB', qty: 1.00005 }] });
  assert.deepEqual([frac.statusCode, codeOf(frac), (frac.body!.detail as { idx?: number }).idx], [422, 'LOT_QTY_INVALID', 1]);
  // وبقائمة أسطره (detail.lines): تنزيلٌ بلا صريح من مصدرين في السيارة
  const two = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pU', qty: 0 }, { productId: 'pC', qty: 1 }] });
  assert.deepEqual([two.statusCode, codeOf(two), (two.body!.detail as { lines?: number[] }).lines], [422, 'LOT_REQUIRED', [1]]);
});

// ═══ D30: سيارة المندوب المحذوف ═══

test('D30: تنزيل سيارة مندوبٍ محذوف — UNLOAD إداري غير مقيّد بلوطاتٍ صريحة، salesRepId: null وdeletedSalesRepId، وI1 على صالحها', async () => {
  reset();
  lot('l1', 'pB', FAR1);
  receive('pB', 5, 'l1');
  seedMove('gone1', 'LOAD', 'pB', 5, [{ lotId: 'l1', qty: 5 }], { deleted: true });
  const ok = await post({ type: 'UNLOAD', deletedSalesRepId: 'gone1', items: [{ productId: 'pB', qty: 3, lots: [{ lotId: 'l1', qty: 3 }] }] });
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.body));
  assert.deepEqual([lastLoad().salesRepId, lastLoad().deletedSalesRepId, lastLoad().type], [null, 'gone1', 'UNLOAD']);
  assert.deepEqual(lotRowsOf(lastLoad().id)[0].map((x) => [x.lotId, x.qty, x.vanKey, x.viaWarehouse]), [['l1', 3, 'gone1', true]]);
  assert.equal(usableOf((await views('pB', 'gone1')).van, 'l1'), 2);
  const over = await post({ type: 'UNLOAD', deletedSalesRepId: 'gone1', items: [{ productId: 'pB', qty: 3, lots: [{ lotId: 'l1', qty: 3 }] }] });
  assert.deepEqual([over.statusCode, codeOf(over)], [409, 'LOT_STOCK_INSUFFICIENT']);
  for (const items of [[{ productId: 'pB', qty: 1, lots: [{ lotId: null, qty: 1 }] }], [{ productId: 'pB', qty: 1 }]]) {
    const r = await post({ type: 'UNLOAD', deletedSalesRepId: 'gone1', items });
    assert.deepEqual([r.statusCode, codeOf(r)], [422, 'LOT_REQUIRED'], 'رصيد صنفها مجهول: لوطاتٌ مسمّاة صريحة');
  }
  const body = { type: 'UNLOAD', deletedSalesRepId: 'gone1', items: [{ productId: 'pB', qty: 1, lots: [{ lotId: 'l1', qty: 1 }] }] };
  assert.equal((await post({ ...body, type: 'LOAD' })).statusCode, 400);
  assert.equal((await post({ ...body, salesRepId: 'r1' })).statusCode, 400);
  assert.equal((await post(body, REP)).statusCode, 403);
  assert.equal((await post({ ...body, items: [{ productId: 'pU', qty: 1 }] })).statusCode, 400, 'الأصناف المتتبَّعة وحدها');
  assert.equal((await post({ ...body, deletedSalesRepId: 'r1' })).statusCode, 404, 'مندوبٌ قائم ليس محذوفاً');
  assert.equal((await post({ ...body, deletedSalesRepId: 'nobody' })).statusCode, 404);
  S.scoped = true;
  const scoped = await post(body);
  assert.deepEqual([scoped.statusCode, codeOf(scoped)], [403, 'LOT_SCOPED_USER']);
  S.scoped = false;
  S.tenant.lotTrackingEnabled = false;
  const off = await post(body);
  assert.deepEqual([off.statusCode, codeOf(off)], [403, 'LOTS_NOT_ALLOWED']);
});

// ═══ قياس الدقّة (D2) ═══

test('suggestAccuracy: تحميلٌ بلوطين يبقى بنداً واحداً بمقترَحه ومتنبَّئه — الدقة نفسها (D2)', async () => {
  reset();
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2);
  receive('pB', 10, 'l1'); receive('pB', 10, 'l2');
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 15, suggestedQty: 15, expectedQty: 12 }] });
  assert.equal(r.statusCode, 201);
  const items = S.vanItems.filter((i) => i.vanLoadId === lastLoad().id);
  assert.equal(items.length, 1, 'البند لا يُشطر');
  assert.equal(lotRowsOf(lastLoad().id)[0].length, 2);
  const at = lastLoad().createdAt;
  const input = (its: typeof items) => ({
    loads: [{ id: 'L', at, items: its.map((i) => ({ productId: i.productId, qty: baseQtyOf(i), suggestedQty: i.suggestedQty, expectedQty: i.expectedQty })) }],
    sales: [{ productId: 'pB', qty: 11, at, isReturn: false }], now: new Date(at.getTime() + 3 * DAY_MS), products: [{ id: 'pB', name: 'عصير', code: 'pB', unit: 'حبة' }],
  });
  const plain = [{ ...items[0], id: 'x' }];
  assert.deepEqual(computeAccuracy(input(items)), computeAccuracy(input(plain)));
});

// ═══ GET /van-stock/lot-balances ═══

test('GET /van-stock/lot-balances: المندوب سيارته، والإداري بالنطاق، والمطفأ LOTS_NOT_ALLOWED، واللقطة VanLotSnapshotDto', async () => {
  reset();
  lot('l1', 'pB', FAR1); lot('l2', 'pB', FAR2, { status: 'BLOCKED', blockKind: 'RECALL' });
  seedMove('r1', 'LOAD', 'pB', 1, [], { at: new Date(T0 - 2 * DAY_MS) }); // قبل الحقبة: غير مسمّى
  seedMove('r1', 'LOAD', 'pB', 3, [{ lotId: 'l1', qty: 3 }], { via: false });
  seedMove('r1', 'LOAD', 'pB', 2, [{ lotId: 'l2', qty: 2 }], { via: false });
  const rep = await call('get', '/lot-balances', { user: REP, query: { salesRepId: 'r2' } });
  assert.equal(rep.statusCode, 200, JSON.stringify(rep.body));
  const snap = rep.body!.data as Awaited<ReturnType<typeof vanLotSnapshot>>;
  assert.deepEqual(snap.tracked, ['pA', 'pB', 'pC']);
  assert.equal(snap.allowUnknown, true);
  assert.match(snap.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(snap.products.map((p) => p.productId), ['pB'], 'الأصناف ذات الرصيد وحدها — والمندوب يرى سيارته لا r2');
  const p = snap.products[0];
  assert.deepEqual([p.available, p.availableNamed, p.unknownUsable, p.quarantined, p.held], [4, 3, 1, 2, 0]);
  assert.deepEqual(p.lots.map((l) => [l.lotId, l.status, l.blockKind, l.usable]), [['l1', 'ACTIVE', null, 3], ['l2', 'BLOCKED', 'RECALL', 2]]);
  const adm = await call('get', '/lot-balances', { query: { salesRepId: 'r1' } });
  assert.deepEqual((adm.body!.data as typeof snap).products, snap.products);
  S.outOfScope.add('r2');
  assert.equal((await call('get', '/lot-balances', { query: { salesRepId: 'r2' } })).statusCode, 404);
  assert.equal((await call('get', '/lot-balances', { query: {} })).statusCode, 400);
  S.tenant.lotTrackingEnabled = false;
  const off = await call('get', '/lot-balances', { query: { salesRepId: 'r1' } });
  assert.deepEqual([off.statusCode, codeOf(off)], [403, 'LOTS_NOT_ALLOWED']);
});

test('اللقطة: غير المسمّى السالب تاريخياً لا يُنقص المتاح المحلي (unknownUsable ≥ 0)، والمحجوز خارج المتاح', async () => {
  reset();
  lot('l1', 'pB', FAR1);
  seedMove('r1', 'LOAD', 'pB', 5, [{ lotId: 'l1', qty: 5 }], { via: false });
  seedInvoice('r1', 'CASH', 'pB', 2, [], { createdAt: new Date(T0 - 2 * DAY_MS) }); // بيعٌ بلا مخزون قبل التفعيل
  seedInvoice('r1', 'RETURN', 'pB', 1, [{ lotId: 'l1', qty: 1 }], { zatcaPhase: 2, invoiceSubtype: '01', einvoiceStatus: 'clearance_pending' });
  const snap = await vanLotSnapshot(db as unknown as LotDb, T, 'r1');
  const p = snap.products[0];
  assert.equal(p.unknownUsable, 0, 'غير المسمّى −٢ لا يُطرح من المتاح');
  assert.deepEqual([p.availableNamed, p.held, p.lots[0].usable], [5, 1, 5], 'مرتجع الإشعار القياسي محجوز (D24)');
});

// ═══ القراءات والميزة المطفأة ═══

test('withLots في السجل: items[].lots مع withLots=1 والميزة مفعّلة، وبدونه الردّ كما كان بلا استعلامٍ زائد', async () => {
  reset();
  lot('l1', 'pB', FAR1);
  seedMove('r1', 'LOAD', 'pB', 3, [{ lotId: 'l1', qty: 3 }], { via: false });
  const plain = await call('get', '/loads', { query: { salesRepId: 'r1' } });
  const it0 = (r: Res) => (r.body!.data as { items: Record<string, unknown>[] }[])[0].items[0];
  assert.ok(!('lots' in it0(plain)));
  assert.equal(S.tenantReads, 0, 'بلا المعامل لا قراءة للعلم');
  const withLots = await call('get', '/loads', { query: { salesRepId: 'r1', withLots: '1' } });
  assert.deepEqual((it0(withLots).lots as { lotId: string; qty: number; lot: { lotNumber: string } }[]).map((l) => [l.lotId, l.qty, l.lot.lotNumber]), [['l1', 3, 'L1']]);
  S.tenant.lotTrackingEnabled = false;
  assert.ok(!('lots' in it0(await call('get', '/loads', { query: { salesRepId: 'r1', withLots: '1' } }))), 'الإطفاء يُخفي (D8)');
});

// «الوحدة الرئيسية» §2.7: القراءة الواحدة للأصناف بأساسها بدل العدّ، وكل فرعٍ قائم معاملةٌ بقفل الأساس (lockBases: FOR KEY SHARE)
// بمهلة BASE_GUARD_TX (I10) — والفرع المطفأ صار معاملةً لذلك وحده. لا طابور ولا SQL لوط ولا مهلة اللوط
test('§١٠: الميزة المطفأة أو الصنف غير المتتبَّع ⇒ المسار كما كان مع قفل الأساس — القراءة الواحدة، ولا طابور ولا SQL لوط ولا مهلة اللوط، والردّ بلا warnings', async () => {
  reset({ lots: false });
  S.log = [];
  const off = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 5, lots: [{ lotId: 'zz', qty: 5 }], lotNumber: 'Q' }] });
  assert.equal(off.statusCode, 201);
  assert.ok(!('warnings' in off.body!));
  assert.deepEqual(S.log, ['product.findMany', 'q:FOR KEY SHARE', 'create:vanLoad'], 'الأجسام الجديدة تُهمَل ولا استعلام زائد — قفل الأساس وحده');
  assert.deepEqual(S.txOpts, [{ maxWait: 10_000, timeout: 20_000 }]);
  assert.equal(S.vanItemLots.length, 0);
  reset();
  S.log = [];
  const untracked = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pU', qty: 2 }] });
  assert.equal(untracked.statusCode, 201);
  assert.ok(!('warnings' in untracked.body!));
  // D25: إعادة قراءة التتبّع تحت FOR KEY SHARE في معاملة الكتابة وحدها (البوابة B-d25-guards) — لا طابور ولا قفل لوط ولا تجميع
  assert.deepEqual(S.log, ['product.findMany', 'q:FOR KEY SHARE', 'q:FOR KEY SHARE', 'create:vanLoad'], 'قفل الأساس ثم إعادة قراءة التتبّع');
  assert.deepEqual(S.txOpts, [{ maxWait: 10_000, timeout: 20_000 }], 'BASE_GUARD_TX لا مهلة اللوط');
  assert.equal(S.vanItemLots.length, 0);
});

test('الانشغال والأخطاء: P2028 داخل معاملة اللوط ⇒ 503 LOT_BUSY، وLotError بحالته ورمزه وتفاصيله قبل فرع 4xx', async () => {
  reset();
  lot('l1', 'pB', FAR1);
  receive('pB', 5, 'l1');
  S.txFail = Object.assign(new Error('Transaction API error: Transaction already closed'), { code: 'P2028' });
  const busy = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 1 }] });
  assert.deepEqual([busy.statusCode, codeOf(busy)], [503, 'LOT_BUSY']);
  S.txFail = Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } });
  assert.equal((await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 1 }] })).statusCode, 503);
  S.txFail = null;
  const conflict = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pB', qty: 9 }] });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body!.success, false);
  assert.equal(codeOf(conflict), 'LOT_STOCK_INSUFFICIENT');
  assert.ok(conflict.body!.detail, 'التفاصيل للواجهة (byLot)');
});

// ═══ التزامن والخاصية ═══

test('التزامن: تنزيلان متزامنان للتشغيلة نفسها يتسلسلان بالطابور فلا يُصرف صالحها مرتين', async () => {
  reset();
  lot('l1', 'pB', FAR1);
  receive('pB', 10, 'l1');
  seedMove('r1', 'LOAD', 'pB', 10, [{ lotId: 'l1', qty: 10 }]);
  const body = { salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pB', qty: 7, lots: [{ lotId: 'l1', qty: 7 }] }] };
  const [a, b] = await Promise.all([post(body), post(body)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 409]);
  assert.equal(usableOf((await views('pB')).van, 'l1'), 3);
});

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <X>(xs: readonly X[]): X => xs[Math.floor(next() * xs.length)] };
}

test('خاصية: ٢٥٠ حركة عشوائية عبر المسار (بالمستودع وبدونه، صريحة وتلقائية، بالكرتون والحبة) لا تترك صالح لوطٍ سالباً ولا تُنقص غير المسمّى دون min(0، قبله)', async () => {
  for (const warehouse of [true, false]) {
    reset({ warehouse });
    const r = rng(warehouse ? 7 : 11);
    const LOTS = ['k1', 'k2', 'k3'];
    LOTS.forEach((id, i) => lot(id, 'pC', [FAR1, FAR2, PAST][i]));
    receive('pC', 7, null, new Date(T0 - 2 * DAY_MS)); // غير مسمّى قبل التفعيل في المستودع
    seedMove('r1', 'LOAD', 'pC', 3, [], { at: new Date(T0 - 2 * DAY_MS) }); // وفي السيارة
    seedInvoice('r1', 'CASH', 'pC', 5, [], { createdAt: new Date(T0 - 2 * DAY_MS) }); // سالبٌ تاريخي: غير المسمّى في السيارة −٢
    let before = await views('pC');
    const statuses = new Map<number, number>();
    for (let step = 0; step < 250; step++) {
      const op = r.pick(['receive', 'load', 'unload', 'adjOut', 'adjIn', 'block'] as const);
      const unit = r.next() < 0.3 ? { unitId: 'u24' } : {};
      const qty = 'unitId' in unit ? r.int(1, 2) : r.int(1, 30);
      const base = 'unitId' in unit ? qty * 24 : qty;
      const explicit = () => {
        const a = r.pick([...LOTS, null]);
        if (r.next() < 0.5) return [{ lotId: a, qty: base }];
        const cut = r.int(1, Math.max(1, base - 1));
        return base > 1 ? [{ lotId: a, qty: cut }, { lotId: r.pick([...LOTS, null]), qty: base - cut }] : [{ lotId: a, qty: base }];
      };
      let res: Res | null = null;
      if (op === 'receive') { if (warehouse) receive('pC', r.int(1, 60), r.pick(LOTS)); }
      else if (op === 'block') { const id = r.pick(LOTS); const l = S.lots.find((x) => x.id === id)!; l.status = l.status === 'ACTIVE' ? 'BLOCKED' : 'ACTIVE'; }
      else if (op === 'load') {
        const lots = r.next() < 0.5 ? explicit() : undefined;
        res = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pC', qty, ...unit, ...(lots && { lots }), ...(!warehouse && !lots && { lotNumber: r.pick(LOTS).toUpperCase() }) }] });
      } else if (op === 'unload' || op === 'adjOut') {
        const lots = r.next() < 0.7 ? explicit() : undefined;
        res = await post({ salesRepId: 'r1', type: op === 'unload' ? 'UNLOAD' : 'ADJUST', items: [{ productId: 'pC', qty: op === 'unload' ? qty : -qty, ...unit, ...(lots && { lots }) }] });
      } else {
        res = await post({ salesRepId: 'r1', type: 'ADJUST', items: [{ productId: 'pC', qty, ...unit, lots: explicit() }] });
      }
      if (res) {
        statuses.set(res.statusCode, (statuses.get(res.statusCode) ?? 0) + 1);
        assert.ok([201, 400, 409, 422].includes(res.statusCode), `خطوة ${step}: ${res.statusCode} ${JSON.stringify(res.body)}`);
        if (res.statusCode >= 409) assert.ok(typeof res.body!.code === 'string', 'رفض اللوط برمزه');
      }
      const after = await views('pC');
      for (const place of ['wh', 'van'] as const) {
        if (place === 'wh' && !warehouse) continue;
        const v = after[place];
        for (const l of v.lots) for (const b of ['SELLABLE', 'EXPIRED', 'DAMAGED'] as const) {
          assert.ok(l.usable[b] >= -LOT_EPS, `خطوة ${step} ${op}: صالح ${l.lotId} في ${place}/${b} سالب ${l.usable[b]}`);
        }
        const u0 = before[place].unknownUsable!.SELLABLE, u1 = v.unknownUsable!.SELLABLE;
        assert.ok(u1 >= Math.min(0, u0) - LOT_EPS || u1 >= u0 - LOT_EPS, `خطوة ${step} ${op}: غير المسمّى في ${place} ${u0} ⇒ ${u1} (I2)`);
      }
      before = after;
    }
    // I3: كل بندٍ لصنفٍ متتبَّع كُتب بعد التفعيل مجموع صفوفه كميته الأساسية بإشارتها
    for (const it of S.vanItems) {
      const l = loadOf(it.vanLoadId);
      if (l.createdAt.getTime() < sinceOf(it.productId)) continue;
      const sum = S.vanItemLots.filter((x) => x.vanLoadItemId === it.id).reduce((s, x) => s + x.qty, 0);
      assert.ok(Math.abs(sum - baseQtyOf(it)) <= LOT_EPS, `I3: ${it.id} ${sum} != ${baseQtyOf(it)}`);
    }
    assert.ok((statuses.get(201) ?? 0) > 40 && ((statuses.get(409) ?? 0) + (statuses.get(422) ?? 0)) > 20, `تغطية النجاح والرفض: ${JSON.stringify([...statuses])}`);
  }
});

// ═══ الخدمة مباشرةً ═══

test('planVanMovementInTx بلا سياق يأخذ الأقفال بنفسه، والمجموعة تحت القفل هي المرجع (D25)', async () => {
  reset();
  lot('l1', 'pB', FAR1);
  seedMove('r1', 'LOAD', 'pB', 4, [{ lotId: 'l1', qty: 4 }], { via: false });
  S.log = [];
  const input = {
    tenantId: T, vanKey: 'r1', deletedVan: false, type: 'UNLOAD' as const, warehouseEnabled: true, actor: 'ADMIN' as const, createdBy: 'adm1',
    day: '2026-11-10', allowUnknown: true,
    lines: [
      { idx: 0, productId: 'pB', productName: 'عصير', shelfLifeOn: false, qty: 2, unitFactor: 1 },
      { idx: 1, productId: 'pU', productName: 'ماء', shelfLifeOn: false, qty: 2, unitFactor: 1 },
    ],
  };
  const plan = await planVanMovementInTx(db as unknown as LotDb, input);
  assert.ok(S.log.indexOf('q:FOR KEY SHARE') >= 0 && S.log.indexOf('exec:lot') > S.log.indexOf('q:FOR KEY SHARE'));
  assert.deepEqual([...plan.tracked], ['pB']);
  assert.deepEqual(plan.lines.get(0)!.map((x) => [x.lotId, x.qty, x.viaWarehouse, x.reason]), [['l1', 2, true, null]]);
  assert.equal(plan.lines.has(1), false, 'غير المتتبَّع بلا صفوف');
  // صار الصنف غير متتبَّع بين القراءتين: لا صفوف ولا خطأ
  S.products.find((p) => p.id === 'pB')!.lotTracked = false;
  const none = await planVanMovementInTx(db as unknown as LotDb, input);
  assert.equal(none.tracked.size, 0);
  assert.equal(none.lines.size, 0);
  // والسياق يغني عن الأقفال
  S.products.find((p) => p.id === 'pB')!.lotTracked = true;
  S.log = [];
  await planVanMovementInTx(db as unknown as LotDb, input, { locked: { tracked: new Set(['pB']) } });
  assert.equal(S.log.indexOf('q:FOR KEY SHARE'), -1);
  await assert.rejects(planVanMovementInTx(db as unknown as LotDb, { ...input, lines: [{ ...input.lines[0], qty: 2.00001 }] }),
    (e: unknown) => e instanceof LotError && e.code === 'LOT_QTY_INVALID');
});

// ═══ D25 في المسار غير المتتبَّع والميزة مفعّلة (البوابة B-d25-guards) ═══
// القراءة المسبقة رأت أصناف الحركة غير متتبَّعة، ثم التزم تفعيل تتبّع أحدها (وتسميةٌ تنقل غير المسمّى إلى لوط) قبل الكتابة: حركةٌ تُنقص
// السيارة بلا صفوف لوط تُنزل غير المسمّى دون الصفر (I2) وتُبقي للوط صالحاً وهمياً. الحارس إعادة قراءة التتبّع FOR KEY SHARE داخل
// معاملة الكتابة ⇒ 503 LOT_BUSY TRACKING_CHANGED فيُعاد الطلب بمسار اللوط.

/** يلتزم تفعيل تتبّع `pid` مباشرةً بعد القراءة المسبقة لأصناف الحركة (product.findMany) — مرّةً واحدة */
function trackAfterPreRead(pid: string): void {
  const pm = db.product as { findMany: (a: unknown) => Promise<unknown> };
  const orig = pm.findMany;
  pm.findMany = async (a: unknown) => {
    const out = await orig(a);
    pm.findMany = orig;
    Object.assign(S.products.find((p) => p.id === pid)!, { lotTracked: true, lotTrackedSince: clock() });
    return out;
  };
}

test('D25 (السيارة): UNLOAD وADJUST لصنفٍ صار متتبَّعاً بين القراءة المسبقة والكتابة ⇒ 503 TRACKING_CHANGED بلا حركة، والإعادة بمسار اللوط', async () => {
  for (const [type, qty] of [['UNLOAD', 4], ['ADJUST', -4]] as const) {
    reset();
    seedMove('r1', 'LOAD', 'pU', 10, []); // ١٠ غير مسمّاة في سيارة r1 قبل التتبّع
    const before = S.vanLoads.length;
    trackAfterPreRead('pU');
    S.log = [];
    const r = await post({ salesRepId: 'r1', type, items: [{ productId: 'pU', qty }] });
    assert.deepEqual([r.statusCode, codeOf(r), (r.body?.detail as { reason?: string })?.reason, (r.body?.detail as { productIds?: string[] })?.productIds],
      [503, 'LOT_BUSY', 'TRACKING_CHANGED', ['pU']], `${type}: ${JSON.stringify(r.body)}`);
    assert.equal(S.vanLoads.length, before, `${type}: كُتبت حركة بلا صفوف لوط لصنفٍ متتبَّع`);
    assert.ok(!S.log.includes('exec:lot'), `${type}: لا قفل لوط في المسار غير المتتبَّع`);
    S.log = [];
    const again = await post({ salesRepId: 'r1', type, items: [{ productId: 'pU', qty }] });
    assert.ok(S.log.includes('exec:lot'), `${type}: الإعادة لم تأخذ مسار اللوط: ${S.log.join(' ')} ${JSON.stringify(again.body)}`);
  }
});

test('D25 (السيارة): الإزالة (EXPIRED_OUT) — قفل الدلو ثم إعادة قراءة التتبّع (§٣.١)، وصنفٌ صار متتبَّعاً ⇒ 503 بلا حركة', async () => {
  reset();
  seedInvoice('r1', 'RETURN', 'pU', 3, [], { returnExpired: true });
  const before = S.vanLoads.length;
  trackAfterPreRead('pU');
  S.log = [];
  const r = await post({ salesRepId: 'r1', type: 'EXPIRED_OUT', items: [{ productId: 'pU', qty: 2 }] });
  assert.deepEqual([r.statusCode, codeOf(r), (r.body?.detail as { reason?: string })?.reason], [503, 'LOT_BUSY', 'TRACKING_CHANGED'], JSON.stringify(r.body));
  assert.equal(S.vanLoads.length, before);
  const at = (s: string) => S.log.indexOf(s);
  assert.ok(at('exec:bucket:van-expired:r1') >= 0 && at('exec:bucket:van-expired:r1') < at('q:FOR KEY SHARE'), `ترتيب الأقفال: ${S.log.join(' ')}`);
  assert.ok(!S.log.includes('computeStock'), 'الرفض قبل فحص الرصيد');
});

test('D25 (السيارة) §١٠.٢: بلا تبديل ⇒ الحركة كما كانت — إعادة قراءة واحدة FOR KEY SHARE في معاملةٍ بلا مهلة جديدة، بلا طابور ولا قفل لوط ولا صفوف', async () => {
  reset();
  S.log = [];
  const r = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 3 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.ok(!('warnings' in r.body!));
  assert.deepEqual(S.log, ['product.findMany', 'q:FOR KEY SHARE', 'q:FOR KEY SHARE', 'create:vanLoad'], 'قفل الأساس ثم إعادة قراءة التتبّع');
  assert.deepEqual(S.txOpts, [{ maxWait: 10_000, timeout: 20_000 }], 'BASE_GUARD_TX (I10) لا مهلة اللوط (D13)');
  assert.equal(S.vanItemLots.length, 0);
  // الإزالة: قفل الدلو كما كان ثم القراءة ثم فحص الرصيد ثم الإنشاء
  seedInvoice('r1', 'RETURN', 'pU', 3, [], { returnExpired: true });
  S.log = []; S.txOpts = [];
  const out = await post({ salesRepId: 'r1', type: 'EXPIRED_OUT', items: [{ productId: 'pU', qty: 2 }] });
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  assert.deepEqual(S.log.filter((x) => x !== 'product.findMany'), ['exec:bucket:van-expired:r1', 'q:FOR KEY SHARE', 'q:FOR KEY SHARE', 'computeStock', 'create:vanLoad']);
  assert.deepEqual(S.txOpts, [{ maxWait: 10_000, timeout: 20_000 }]);
});

// ═══ البوابة B2 (الفاعل، والتنزيل باللوط لصنفٍ غير متتبَّع) ═══

test('B2 (الفاعل): CREATE من حركة السيارة بـlotEventActorOf — جلسة موظف المنصة STAFF بمعرّفه والمالك OWNER بمعرّفه لا معرّف المدير، والمفتاح بمعرّفه', async () => {
  reset({ warehouse: false });
  const users: [string, Record<string, unknown>][] = [
    ['S', { ...ADMIN, impersonated: true, by: 'staff9', byKind: 'STAFF' }],
    ['O', { ...ADMIN, impersonated: true, by: 'own1', byKind: 'OWNER' }],
    ['K', { ...ADMIN, apiKeyId: 'k1' }],
    ['A', ADMIN],
  ];
  const got: unknown[] = [];
  for (const [n, user] of users) {
    // التسوية بالزيادة برقمٍ جديد، والتحميل بلا مستودع برقمٍ جديد (D4): كلاهما ينشئ التشغيلة بحدث CREATE
    for (const type of ['ADJUST', 'LOAD']) {
      const res = await post({ salesRepId: 'r1', type, items: [{ productId: 'pB', qty: 2, lotNumber: `B2-${n}-${type}` }] }, user);
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      const lotId = S.lots.find((l) => l.lotNumber === `B2-${n}-${type}`)!.id;
      const e = S.events.find((x) => x.lotId === lotId && x.kind === 'CREATE')!;
      got.push([n, type, e.actorType, e.actorId, e.actorName]);
    }
  }
  assert.deepEqual(got, [
    ['S', 'ADJUST', 'STAFF', 'staff9', 'موظف المنصة'], ['S', 'LOAD', 'STAFF', 'staff9', 'موظف المنصة'],
    ['O', 'ADJUST', 'OWNER', 'own1', 'الدعم الفني'], ['O', 'LOAD', 'OWNER', 'own1', 'الدعم الفني'],
    ['K', 'ADJUST', 'API_KEY', 'k1', 'مدير'], ['K', 'LOAD', 'API_KEY', 'k1', 'مدير'],
    ['A', 'ADJUST', 'ADMIN', 'adm1', 'مدير'], ['A', 'LOAD', 'ADMIN', 'adm1', 'مدير'],
  ]);
});

test('B2 (D9): الميزة مفعّلة — بندٌ يحمل تشغيلةً لصنفٍ غير متتبَّع 422 بموضع سطره بلا حركة، والفراغ وnull مسار غير المتتبَّع كما كان', async () => {
  reset();
  lot('l1', 'pU', FAR1);
  const before = S.vanLoads.length;
  for (const extra of [
    { lots: [{ lotId: 'l1', qty: 2 }] }, { lotNumber: 'X1' }, { expiryDate: FAR1 }, { productionDate: '2026-01-01' }, { lotReason: 'EXPIRED_UNSOLD_DESTROY' },
  ]) {
    S.log = []; S.txOpts = [];
    const res = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pB', qty: 0 }, { productId: 'pU', qty: 2, ...extra }] });
    assert.equal(res.statusCode, 422, JSON.stringify([extra, res.body]));
    assert.equal(codeOf(res), 'LOT_PRODUCT_MISMATCH');
    assert.deepEqual(res.body!.detail, { productId: 'pU', idx: 1, reason: 'NOT_TRACKED' });
    assert.match(String(res.body!.message), /«ماء»/);
    assert.deepEqual([S.vanLoads.length, S.txOpts.length], [before, 0], 'لا حركة ولا معاملة');
  }
  // غيابٌ صريح: lots فارغة وحقولٌ null أو فارغة ⇒ مسار غير المتتبَّع
  const ok = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pU', qty: 2, lots: [], lotNumber: '', expiryDate: null, productionDate: null, lotReason: null }] });
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.body));
  assert.deepEqual(lotRowsOf(lastLoad().id), [[]]);
});

test('B2 (§١٠.١): الميزة مطفأة — حقول اللوط في البند تُهمل كما كانت حرفياً (لا 422 ولا استعلام زائد)', async () => {
  reset({ lots: false });
  lot('l1', 'pU', FAR1);
  S.log = []; S.txOpts = [];
  const res = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pU', qty: 2, lots: [{ lotId: 'l1', qty: 2 }], lotNumber: 'X1', expiryDate: FAR1 }] });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(S.log, ['product.findMany', 'q:FOR KEY SHARE', 'create:vanLoad'], 'قفل الأساس وحده («الوحدة الرئيسية» §2.7)');
  assert.deepEqual(S.txOpts, [{ maxWait: 10_000, timeout: 20_000 }]);
  assert.deepEqual(lotRowsOf(lastLoad().id), [[]]);
});

test('B2 (D9 تحت القفل): صنفٌ متتبَّع في القراءة المسبقة أُطفئ تتبّعه قبل القفل وبنده يحمل تشغيلة — 422 لا تنزيلٌ بلا صفوف', async () => {
  reset();
  lot('l1', 'pB', FAR1);
  seedMove('r1', 'LOAD', 'pB', 4, [{ lotId: 'l1', qty: 4 }]);
  const prod = db.product as { findMany: (a: unknown) => Promise<unknown> };
  const real = prod.findMany;
  // الإطفاء يلتزم بين القراءة المسبقة وقفل الأصناف
  prod.findMany = async (a: unknown) => { const r = await real(a); S.products.find((p) => p.id === 'pB')!.lotTracked = false; return r; };
  const before = S.vanLoads.length;
  try {
    const res = await post({ salesRepId: 'r1', type: 'UNLOAD', items: [{ productId: 'pB', qty: 2, lots: [{ lotId: 'l1', qty: 2 }] }] });
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
    assert.deepEqual([codeOf(res), res.body!.detail], ['LOT_PRODUCT_MISMATCH', { productId: 'pB', idx: 0, reason: 'NOT_TRACKED' }]);
    assert.equal(S.vanLoads.length, before);
  } finally {
    prod.findMany = real;
  }
});

// ═══ متابعات البوابة F1 (ب): انشغال المسار غير المتتبَّع والميزة مفعّلة ═══
// معاملة إعادة قراءة التتبّع (D25) بالمهلة الافتراضية: P2028 أو انتظار قفل التبديل تحت الضغط ⇒ 503 LOT_BUSY فيعيد العميل (صندوق
// المندوب يعيد على 5xx) لا 500 — والميزة المطفأة كما كانت حرفياً (الإزالة القائمة بمعاملتها تُرجع خطأها إلى المعالج العام).

test('F1 (ب): المسار غير المتتبَّع والميزة مفعّلة — P2028 أو 55P03 في معاملة إعادة القراءة ⇒ 503 LOT_BUSY بلا حركة (التحميل والإزالة)', async () => {
  for (const fail of [
    Object.assign(new Error('Transaction API error: Transaction already closed'), { code: 'P2028' }),
    Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } }),
  ]) {
    for (const type of ['LOAD', 'UNLOAD', 'ADJUST', 'EXPIRED_OUT'] as const) {
      reset();
      seedInvoice('r1', 'RETURN', 'pU', 3, [], { returnExpired: true });
      const before = S.vanLoads.length;
      S.txFail = fail;
      const r = await post({ salesRepId: 'r1', type, items: [{ productId: 'pU', qty: 2 }] });
      assert.deepEqual([r.statusCode, codeOf(r)], [503, 'LOT_BUSY'], `${type}: ${JSON.stringify(r.body)}`);
      assert.equal(S.vanLoads.length, before, type);
      S.txFail = null;
    }
  }
});

// «الوحدة الرئيسية» §2.7: كل فرعٍ قائم صار معاملةً فيها قفل الأساس، فانقضاؤها (P2028) قد يكون انتظار تحويلٍ يمسك الصنف ⇒ 503
// PRODUCT_UNITS_BUSY (baseGuardReply، صالح لإعادة الرفع) لا 500 — لا LOT_BUSY: الميزة مطفأة. والتحميل المطفأ معاملةٌ بـBASE_GUARD_TX
test('F1 (ب) §١٠.١: الميزة مطفأة — P2028 في معاملة الإزالة أو التحميل يمرّ إلى المعالج العام كما كان (لا PRODUCT_UNITS_BUSY، parity-4) بلا حركة، والتحميل معاملةٌ لقفل الأساس وحده', async () => {
  reset({ lots: false });
  seedInvoice('r1', 'RETURN', 'pU', 3, [], { returnExpired: true });
  S.txFail = Object.assign(new Error('Transaction API error: Transaction already closed'), { code: 'P2028' });
  for (const type of ['EXPIRED_OUT', 'LOAD'] as const) {
    const before = S.vanLoads.length;
    const r = await post({ salesRepId: 'r1', type, items: [{ productId: 'pU', qty: 2 }] });
    // انقضاء معاملةٍ خارج قفل الأصناف ليس «وحدات الأصناف قيد التحديث»: 500 بالمعالج العام كما قبل الميزة
    assert.equal(r.statusCode, 500, `${type}: ${JSON.stringify(r.body)}`);
    assert.match(String(r.body?.unhandled), /Transaction already closed/, type);
    assert.notEqual(codeOf(r), 'PRODUCT_UNITS_BUSY', type);
    assert.equal(S.vanLoads.length, before, type);
  }
  S.txFail = null;
  S.log = []; S.txOpts = [];
  const load = await post({ salesRepId: 'r1', type: 'LOAD', items: [{ productId: 'pU', qty: 2 }] });
  assert.equal(load.statusCode, 201, JSON.stringify(load.body));
  assert.deepEqual([S.log, S.txOpts], [['product.findMany', 'q:FOR KEY SHARE', 'create:vanLoad'], [{ maxWait: 10_000, timeout: 20_000 }]]);
});

// ═══ «الوحدة الرئيسية» §2.7 (B3a): الأساس تحت قفل lockLotProducts نفسه في مسار اللوط ═══
// تحويلٌ (كرتون ⇒ قارورة) التزم بين القراءة المسبقة وقفل الأصناف: البنود حُلّت على الأساس القديم، فالكتابة ×F صامتة. الحارس
// assertBasesUnchanged على خريطة الأساس من صفوف القفل — بلا قفلٍ ثانٍ، وقبل رصيد الإزالة والخطة والإنشاء — ولا تبتلعه asLotBusy.
test('مسار اللوط: أساسٌ تغيّر بين القراءة المسبقة والقفل ⇒ 409 PRODUCT_UNITS_CHANGED بلا حركة ولا صفوف ولا خطة — للتحميل والإزالة', async () => {
  for (const type of ['LOAD', 'EXPIRED_OUT'] as const) {
    reset();
    if (type === 'EXPIRED_OUT') seedInvoice('r1', 'RETURN', 'pB', 3, [], { returnExpired: true });
    const before = [S.vanLoads.length, S.vanItemLots.length, S.events.length];
    const pm = db.product as { findMany: (a: unknown) => Promise<unknown> };
    const orig = pm.findMany;
    pm.findMany = async (a: unknown) => {
      const out = await orig(a);
      pm.findMany = orig;
      S.products.find((p) => p.id === 'pB')!.unit = 'كرتون'; // convert-base التزم هنا
      return out;
    };
    try {
      S.log = [];
      const r = await post({ salesRepId: 'r1', type, items: [{ productId: 'pB', qty: 1 }] });
      assert.deepEqual([r.statusCode, codeOf(r)], [409, 'PRODUCT_UNITS_CHANGED'], `${type}: ${JSON.stringify(r.body)}`);
      assert.match(String(r.body?.message), /«عصير»/);
      assert.deepEqual([S.vanLoads.length, S.vanItemLots.length, S.events.length], before, type);
      assert.ok(!S.log.includes('computeStock'), `${type}: المقارنة قبل فحص رصيد الإزالة`);
    } finally {
      pm.findMany = orig;
    }
  }
  // والأساس نفسه ⇒ مسار اللوط كما كان: بقية اختبارات هذا الملف تمرّ والحارس في مكانه (صفوف القفل تحمل unit مطابقاً)
});
