// مزيّف Prisma في الذاكرة لحركات السيارة واللوط — منسوخٌ من حاضنة lots-van.test.ts (المواصفة §٨.٢) ومعه ما يلزم الجرد المطلق
// (طلب المالك ١٦ نوفمبر ٢٠٢٦): إعادة التسمية (lotRelabel وتجميعها في lot_relabels)، والبحث بمرجع clientRef، وعمودا reason/clientRef.
// يستورده lots-api-lenient.test.ts وlots-van-count.test.ts — ليس ملف اختبار بنفسه.
import path from 'node:path';
import type { Router } from 'express';
import { Prisma } from '@prisma/client';
import { DAMAGED_VAN_SINCE } from '../services/vanDamaged';
import { LOT_HOLD_MIRRORS, type LotBucket, type PlaceLotView } from '../services/lots';
import { placeViews, type LotDb } from '../services/lotsDb';

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
interface VanLoadRow { id: string; tenantId: string; salesRepId: string | null; deletedSalesRepId: string | null; type: string; note: string | null; createdBy: string | null; locationId: string | null; createdAt: Date; clientRef?: string | null; reason?: string | null }
interface RelabelRow { id: string; tenantId: string; productId: string; place: string; vanKey: string | null; bucket: string; fromLotId: string | null; toLotId: string | null; qty: number; reason: string; note: string | null; createdAt: Date }
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
  lots: LotRow[]; vanLoads: VanLoadRow[]; vanItems: VanItemRow[]; vanItemLots: VanItemLotRow[]; whEntries: WhEntryRow[]; invoices: InvoiceRow[]; relabels: RelabelRow[];
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
    lots: [], vanLoads: [], vanItems: [], vanItemLots: [], whEntries: [], invoices: [], events: [], relabels: [],
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
  if (sql.includes('FROM lot_relabels r')) {
    // إعادة التسمية (الجرد COUNT): تُجمع كما في aggRelabels — بعد الحقبة، بالمكان والدلو والمصدر والوجهة
    const rows = S.relabels.filter((r) => r.tenantId === T && r.createdAt.getTime() >= sinceOf(r.productId));
    return group(rows, (r) => ({ productId: r.productId, place: r.place, vanKey: r.vanKey, bucket: r.bucket, fromLotId: r.fromLotId, toLotId: r.toLotId }),
      (r) => r.qty, (r) => (r.qty > 0 ? r.createdAt : null)).map(({ first, ...g }) => ({ ...g, firstAt: first }));
  }
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

/** رصيد المستودع للصنف في حارس D2 — null ⇒ وفير (اختبار «D2 في مسار اللوط» وحده يضبطه) */
let whOverride: Map<string, number> | null = null;
const db: Record<string, unknown> = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { await yieldTurn(); const r = render(strings, values); return answerSql(r.sql, r.values); },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    await yieldTurn();
    const r = render(strings, values);
    // قفل المستودع (D2) خارج تسلسل الدلو واللوط الذي تحرسه هذه الاختبارات
    if (r.sql.includes('hashtext') && String(r.values[0]).startsWith('warehouse-stock:')) return 1;
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
  lotRelabel: {
    create: async ({ data }: { data: Omit<RelabelRow, 'id' | 'createdAt'> }) => {
      const row: RelabelRow = { id: nid('rl'), createdAt: clock(), ...data, note: data.note ?? null };
      S.relabels.push(row);
      return { id: row.id };
    },
  },
  lotEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { S.events.push(data); return data; } },
  invoiceItemLot: { findFirst: async ({ where }: { where: { tenantId: string; vanKey: string } }) => (S.invoices.some((i) => i.tenantId === where.tenantId && i.items.some((it) => it.lots.some((l) => l.vanKey === where.vanKey))) ? { id: 'il' } : null) },
  // D2 (التحميل فوق رصيد المستودع يُمنع): رصيد المستودع لأصناف الحركة — وفيرٌ هنا، فهذا الملف لا يحرس الرصيد (van-load-warehouse-guard.test.ts)
  warehouseEntryItem: {
    findMany: async ({ where }: { where: { productId: { in: string[] } } }) => where.productId.in.map((productId) => {
      const q = whOverride?.get(productId) ?? 1e6;
      return { productId, qty: q, unitFactor: 1, baseQty: q };
    }),
  },
  vanLoadItem: {
    findMany: async ({ where }: { where: { productId?: unknown; vanLoad: { tenantId: string; salesRepId: string } } }) => {
      // قراءة رصيد المستودع (D2، مقيّدة بالأصناف) ليست computeStock: بلا حركات سيارة والوارد وفير، ولا تُسجَّل في التسلسل
      if ('productId' in where) return [];
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
    findFirst: async ({ where }: { where: { tenantId: string; deletedSalesRepId?: string; clientRef?: string } }) => {
      if (where.clientRef !== undefined) {
        const l = S.vanLoads.find((x) => x.tenantId === where.tenantId && x.clientRef === where.clientRef);
        return l ? { ...l, items: S.vanItems.filter((it) => it.vanLoadId === l.id).map((it) => ({ ...it, product: S.products.find((p) => p.id === it.productId) })) } : null;
      }
      return S.vanLoads.find((l) => l.tenantId === where.tenantId && l.deletedSalesRepId === where.deletedSalesRepId) ?? null;
    },
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
        clientRef: (data.clientRef as string | undefined) ?? null, reason: (data.reason as string | undefined) ?? null,
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
  const snap = { lots: [...S.lots], vanLoads: [...S.vanLoads], vanItems: [...S.vanItems], vanItemLots: [...S.vanItemLots], events: [...S.events], relabels: [...S.relabels] };
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

/** مفتاح الربط: جلسة إدارية بمعرّف مفتاح API (req.user.apiKeyId) — مسار التسامح وحده */
const API = { ...ADMIN, apiKeyId: 'keyABCDEF123' };
const st = (): State => S;
/** الحاضنة كلها مكشوفة للاختبارات */
export {
  T, T0, DAY_MS, FAR1, FAR2, PAST, db, router, call, post, ADMIN, REP, API, st, reset, product, lot, receive, seedMove, seedInvoice, views, usableOf,
  lastLoad, lotRowsOf, codeOf, warnCodes, clock, nid,
};
export type { Res, LotRow };
