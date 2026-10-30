// «تتبّع اللوط» — قاعدة مزيّفة في الذاكرة لاختبارات الحزمة B3 (lots-warehouse وlots-import): جداول المستودع والسيارة واللوط
// صفوفاً، وتجميعات SQL في services/lotsDb.ts تُجاب **من الصفوف نفسها** (الكمية بالأساس كـBASE_QTY_SQL، والحقبة وحدّ التاريخ كما
// في SQL)، فيمرّ الطيّ والعروض والأقفال بمسارها الحقيقي. المعاملة لقطةٌ تُستعاد عند الرمي (لا نصف حركة). لا قاعدة ولا شبكة.
// ليس ملف اختبار (لا .test.ts): يستورده الملفان.
import { Prisma } from '@prisma/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;

export interface WProduct {
  id: string; tenantId: string; name: string; code: string; unit: string; taxPct: number; status: string; deletedAt: Date | null;
  lotTracked: boolean; lotTrackedSince: Date | null;
  shelfLifeEnabled: boolean; shelfLifeValue: number | null; shelfLifeUnit: string | null;
}
export interface WUnit { id: string; tenantId: string; productId: string; name: string; factor: number; isActive: boolean }
export interface WLot {
  id: string; tenantId: string; productId: string; lotNumber: string; productionDate: Date | null; expiryDate: Date | null;
  status: string; blockKind: string | null; blockedAt: Date | null; createdAt: Date; source: string; sourceEntryId: string | null; createdBy: string | null; note: string | null;
}
export interface WEntry { id: string; tenantId: string; type: string; createdAt: Date; note?: string | null; createdBy?: string | null; supplier?: string | null }
export interface WEntryItem { id: string; entryId: string; productId: string; qty: number; unitName: string | null; unitFactor: number; baseQty: number | null; unitCost: number | null; lotId: string | null }
export interface WVanItem { id: string; tenantId: string; productId: string; salesRepId: string | null; type: string; qty: number; unitFactor: number; baseQty: number | null; createdAt: Date }
export interface WVanLot { id: string; tenantId: string; productId: string; vanKey: string; moveType: string; viaWarehouse: boolean; lotId: string | null; qty: number; createdAt: Date }
export interface WRelabel { id: string; tenantId: string; productId: string; place: string; vanKey: string | null; bucket: string; fromLotId: string | null; toLotId: string | null; qty: number; createdAt: Date }
/** صفّ فاتورةٍ مجمَّع كما يعيده aggVanInvoices (src = LOT لصفوف اللوط بعد الحقبة، TOT لبنود الفواتير) — يُعاد كما هو */
export interface WInvAgg { productId: string; lotId: string | null; vanKey: string; type: string; returnToStock: boolean | null; returnExpired: boolean | null; damaged: boolean; held: boolean; qty: number; firstAt: Date | null; src: 'LOT' | 'TOT' }
export interface Call { op: string; sql?: string; values?: unknown[]; args?: unknown }

const baseOf = (r: { qty: number; unitFactor?: number | null; baseQty?: number | null }): number =>
  r.baseQty != null ? r.baseQty : r.qty * (r.unitFactor && r.unitFactor > 0 ? r.unitFactor : 1);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
export const dateOf = (s: string | null | undefined): Date | null => (s ? new Date(`${s}T00:00:00.000Z`) : null);
export const dayOf = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** عالمٌ في الذاكرة بشركة `tid` — كل كتابة تأخذ لحظةً متزايدة */
export class World {
  tid = 't1';
  tenantSince: Date | null = null;
  lotsEnabled = true;
  warehouseEnabled = true;
  products: WProduct[] = [];
  units: WUnit[] = [];
  lots: WLot[] = [];
  entries: WEntry[] = [];
  items: WEntryItem[] = [];
  vanItems: WVanItem[] = [];
  vanLots: WVanLot[] = [];
  relabels: WRelabel[] = [];
  invAgg: WInvAgg[] = [];
  invLotRefs: { lotId: string }[] = [];
  reps: string[] = [];
  events: Row[] = [];
  batches: Row[] = [];
  calls: Call[] = [];
  txOpts: unknown[] = [];
  /** يُستدعى لكل SQL خام — يرمي ليحاكي انشغالاً (55P03) أو عطلاً */
  failOn: ((sql: string) => Error | null) | null = null;
  private t = Date.parse('2026-11-01T08:00:00Z');
  private n = 0;

  now(): Date { this.t += 1000; return new Date(this.t); }
  id(p: string): string { return `${p}${++this.n}`; }

  product(p: Partial<WProduct> & { id: string }): WProduct {
    const row: WProduct = {
      tenantId: this.tid, name: p.id, code: p.id, unit: 'حبة', taxPct: 0, status: 'ACTIVE', deletedAt: null,
      lotTracked: false, lotTrackedSince: null, shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, ...p,
    };
    this.products.push(row);
    return row;
  }
  /** تفعيل تتبّع صنفٍ بحقبةٍ تبدأ الآن (D25) */
  track(productId: string): void {
    const p = this.products.find((x) => x.id === productId)!;
    p.lotTracked = true;
    p.lotTrackedSince = this.now();
  }
  unit(u: Partial<WUnit> & { id: string; productId: string; factor: number }): WUnit {
    const row: WUnit = { tenantId: this.tid, name: u.id, isActive: true, ...u };
    this.units.push(row);
    return row;
  }
  lot(l: Partial<WLot> & { id: string; productId: string; lotNumber: string }): WLot {
    const row: WLot = {
      tenantId: this.tid, productionDate: null, expiryDate: null, status: 'ACTIVE', blockKind: null, blockedAt: null,
      createdAt: this.now(), source: 'MANUAL', sourceEntryId: null, createdBy: null, note: null, ...l,
    };
    this.lots.push(row);
    return row;
  }
  /** حركة مستودع بأسطرها كما يكتبها المسار (lotId لكل سطر، والأساس من المعامل) */
  entry(type: string, lines: { productId: string; qty: number; unitFactor?: number; lotId?: string | null }[], at?: Date, id?: string): WEntry {
    const e: WEntry = { id: id ?? this.id('e'), tenantId: this.tid, type, createdAt: at ?? this.now() };
    this.entries.push(e);
    for (const l of lines) {
      const f = l.unitFactor ?? 1;
      this.items.push({ id: this.id('wi'), entryId: e.id, productId: l.productId, qty: l.qty, unitName: f === 1 ? null : 'كرتون', unitFactor: f, baseQty: r4(l.qty * f), unitCost: null, lotId: l.lotId ?? null });
    }
    return e;
  }
  /** تحميل/تنزيل سيارة عبر المستودع: بند الحركة (رصيد الصنف) وصفّ لوطه */
  vanMove(type: 'LOAD' | 'UNLOAD', vanKey: string, productId: string, qty: number, lotId: string | null, viaWarehouse = true): void {
    const at = this.now();
    this.vanItems.push({ id: this.id('vi'), tenantId: this.tid, productId, salesRepId: vanKey, type, qty, unitFactor: 1, baseQty: qty, createdAt: at });
    this.vanLots.push({ id: this.id('vl'), tenantId: this.tid, productId, vanKey, moveType: type, viaWarehouse, lotId, qty, createdAt: at });
  }
  relabel(r: Omit<WRelabel, 'id' | 'tenantId' | 'createdAt'>): void {
    this.relabels.push({ id: this.id('rl'), tenantId: this.tid, createdAt: this.now(), ...r });
  }

  epochOf(productId: string): number {
    const p = this.products.find((x) => x.id === productId);
    const a = this.tenantSince?.getTime() ?? -Infinity;
    const b = p?.lotTrackedSince?.getTime() ?? -Infinity;
    return Math.max(a, b);
  }
  private metaOf(l: WLot): Row {
    return { id: l.id, productId: l.productId, lotNumber: l.lotNumber, productionDate: l.productionDate, expiryDate: l.expiryDate, status: l.status, blockKind: l.blockKind, blockedAt: l.blockedAt, createdAt: l.createdAt };
  }

  /** استعلامات SQL الخام: الأقفال وتجميعات lotsDb.ts من الصفوف */
  private query(sql: string, values: unknown[]): unknown[] {
    const arrays = values.filter((v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string'));
    const before = /"createdAt" <|"invoiceDate" </.test(sql) ? ([...values].reverse().find((v): v is Date => v instanceof Date) ?? null) : null;
    if (sql.includes('FOR KEY SHARE')) {
      const ids = new Set(arrays[0] ?? []);
      return this.products.filter((p) => p.tenantId === values[0] && ids.has(p.id)).sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((p) => ({ id: p.id, lotTracked: p.lotTracked, lotTrackedSince: p.lotTrackedSince }));
    }
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '5s' }];
    if (sql.includes('SELECT now()')) return [{ now: this.now() }];
    const pids = new Set(arrays[0] ?? []);
    if (sql.includes('FROM van_load_item_lots')) {
      const viaOnly = sql.includes('"viaWarehouse" = true');
      const keys = sql.includes('l."vanKey" = ANY(') ? new Set(arrays[1] ?? []) : null;
      const g = new Map<string, Row>();
      for (const r of this.vanLots) {
        if (r.tenantId !== this.tid || !pids.has(r.productId)) continue;
        if (viaOnly && !(r.viaWarehouse && (r.moveType === 'LOAD' || r.moveType === 'UNLOAD'))) continue;
        if (keys && !keys.has(r.vanKey)) continue;
        if (before && !(r.createdAt < before)) continue;
        if (r.createdAt.getTime() < this.epochOf(r.productId)) continue;
        const k = [r.productId, r.lotId, r.vanKey, r.moveType, r.viaWarehouse].join('|');
        const x = g.get(k) ?? { productId: r.productId, lotId: r.lotId, vanKey: r.vanKey, moveType: r.moveType, viaWarehouse: r.viaWarehouse, qty: 0, firstInAt: null };
        x.qty += r.qty;
        if (r.qty > 0 && (!x.firstInAt || r.createdAt < x.firstInAt)) x.firstInAt = r.createdAt;
        g.set(k, x);
      }
      return [...g.values()];
    }
    if (sql.includes('FROM invoice_item_lots') || sql.includes('FROM invoice_items it')) {
      const all = new Set(arrays.flat());
      return this.invAgg.filter((r) => all.has(r.productId) && all.has(r.vanKey)
        && ((r.src === 'TOT' && sql.includes('FROM invoice_items it')) || (r.src === 'LOT' && sql.includes('FROM invoice_item_lots'))));
    }
    if (sql.includes('FROM warehouse_entry_items wi')) {
      const named = sql.includes('wi."lotId" IS NOT NULL');
      const g = new Map<string, Row>();
      for (const it of this.items) {
        const e = this.entries.find((x) => x.id === it.entryId);
        if (!e || e.tenantId !== this.tid || !pids.has(it.productId)) continue;
        if (before && !(e.createdAt < before)) continue;
        if (named) {
          if (it.lotId == null || e.createdAt.getTime() < this.epochOf(it.productId)) continue;
          const k = `${it.productId}|${it.lotId}`;
          const x = g.get(k) ?? { productId: it.productId, lotId: it.lotId, qty: 0 };
          x.qty += baseOf(it); g.set(k, x);
        } else {
          const k = `${it.productId}|${e.type}`;
          const x = g.get(k) ?? { productId: it.productId, type: e.type, qty: 0 };
          x.qty += baseOf(it); g.set(k, x);
        }
      }
      return [...g.values()];
    }
    if (sql.includes('FROM van_load_items vli')) {
      const perVan = sql.includes('AS "vanKey"');
      const keys = perVan ? new Set(arrays[0] ?? []) : null;
      const prods = perVan ? new Set(arrays[1] ?? []) : pids;
      const g = new Map<string, Row>();
      for (const v of this.vanItems) {
        if (v.tenantId !== this.tid || !prods.has(v.productId)) continue;
        if (before && !(v.createdAt < before)) continue;
        if (perVan) { if (!v.salesRepId || !keys!.has(v.salesRepId)) continue; } else if (v.type !== 'LOAD' && v.type !== 'UNLOAD') continue;
        const k = `${v.productId}|${perVan ? v.salesRepId : ''}|${v.type}`;
        const x = g.get(k) ?? { productId: v.productId, ...(perVan ? { vanKey: v.salesRepId } : {}), type: v.type, qty: 0 };
        x.qty += baseOf(v); g.set(k, x);
      }
      return [...g.values()];
    }
    if (sql.includes('FROM lot_relabels')) {
      const wh = sql.includes("r.place = 'WAREHOUSE'");
      const vans = sql.includes("r.place = 'VAN'") ? new Set(arrays[1] ?? []) : null;
      const g = new Map<string, Row>();
      for (const r of this.relabels) {
        if (r.tenantId !== this.tid || !pids.has(r.productId)) continue;
        if (!((wh && r.place === 'WAREHOUSE') || (vans && r.place === 'VAN' && r.vanKey && vans.has(r.vanKey)))) continue;
        if (before && !(r.createdAt < before)) continue;
        if (r.createdAt.getTime() < this.epochOf(r.productId)) continue;
        const k = [r.productId, r.place, r.vanKey, r.bucket, r.fromLotId, r.toLotId].join('|');
        const x = g.get(k) ?? { ...r, qty: 0, firstAt: null };
        x.qty += r.qty;
        if (r.qty > 0 && (!x.firstAt || r.createdAt < x.firstAt)) x.firstAt = r.createdAt;
        g.set(k, x);
      }
      return [...g.values()];
    }
    if (sql.includes('FROM warehouse_entries WHERE id')) {
      return this.entries.filter((e) => e.id === values[0] && e.tenantId === values[1]).map((e) => ({ id: e.id }));
    }
    throw new Error(`استعلامٌ غير متوقَّع: ${sql}`);
  }

  private snapshot(): Row {
    return structuredClone({ lots: this.lots, entries: this.entries, items: this.items, vanItems: this.vanItems, vanLots: this.vanLots, relabels: this.relabels, events: this.events, batches: this.batches });
  }
  private restore(s: Row): void {
    Object.assign(this, s);
  }

  /** عميل القاعدة/المعاملة المزيّف — كل نداءٍ يُسجَّل في calls بترتيبه */
  get db(): Row {
    const w = this;
    const log = (op: string, extra: Omit<Call, 'op'> = {}) => { w.calls.push({ op, ...extra }); };
    const render = (strings: TemplateStringsArray | Prisma.Sql, values: unknown[]) => {
      const q = Array.isArray(strings) ? Prisma.sql(strings as TemplateStringsArray, ...(values as Prisma.Sql[])) : (strings as Prisma.Sql);
      return { sql: q.text.replace(/\s+/g, ' ').trim(), values: q.values };
    };
    const inList = (cond: any, v: unknown) => cond === undefined || (cond && typeof cond === 'object' && 'in' in cond ? (cond.in as unknown[]).includes(v) : cond === v);
    const lotWhere = (where: Row = {}) => (l: WLot) => l.tenantId === (where.tenantId ?? l.tenantId)
      && inList(where.id, l.id) && inList(where.productId, l.productId) && inList(where.lotNumber, l.lotNumber)
      && (where.sourceEntryId === undefined || l.sourceEntryId === where.sourceEntryId) && (where.source === undefined || l.source === where.source);
    const entryOf = (it: WEntryItem) => w.entries.find((x) => x.id === it.entryId);
    const itemWhere = (where: Row = {}) => (it: WEntryItem) => {
      const e = entryOf(it);
      if (typeof where.entryId === 'string' && it.entryId !== where.entryId) return false;
      if (where.entryId?.not && it.entryId === where.entryId.not) return false;
      if (where.entryId?.in && !where.entryId.in.includes(it.entryId)) return false;
      if (where.entryId?.notIn && where.entryId.notIn.includes(it.entryId)) return false;
      if (where.lotId?.in && !(it.lotId && where.lotId.in.includes(it.lotId))) return false;
      if (where.qty?.lt !== undefined && !(it.qty < where.qty.lt)) return false;
      if (!inList(where.productId, it.productId)) return false;
      if (where.entry?.tenantId && e?.tenantId !== where.entry.tenantId) return false;
      if (where.entry?.createdAt?.gte && !(e && e.createdAt >= where.entry.createdAt.gte)) return false;
      if (where.product?.lotTracked !== undefined && w.products.find((p) => p.id === it.productId)?.lotTracked !== where.product.lotTracked) return false;
      return true;
    };
    const vanWhere = (where: Row = {}) => (v: WVanItem) => inList(where.productId, v.productId)
      && (!where.vanLoad?.tenantId || v.tenantId === where.vanLoad.tenantId)
      && (!where.vanLoad?.type || (typeof where.vanLoad.type === 'string' ? v.type === where.vanLoad.type : where.vanLoad.type.in.includes(v.type)))
      && (!where.vanLoad?.createdAt?.gte || v.createdAt >= where.vanLoad.createdAt.gte);
    const entryWithItems = (e: WEntry, include?: Row) => ({
      ...e,
      items: w.items.filter((it) => it.entryId === e.id).map((it) => ({
        ...it,
        ...(include?.items?.include?.product && { product: (() => { const p = w.products.find((x) => x.id === it.productId)!; return { id: p.id, name: p.name, unit: p.unit }; })() }),
        ...(include?.items?.include?.lot && { lot: (() => { const l = w.lots.find((x) => x.id === it.lotId); return l ? { lotNumber: l.lotNumber, productionDate: l.productionDate, expiryDate: l.expiryDate } : null; })() }),
      })),
    });
    const client: Row = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const r = render(strings, values);
        log('query', r);
        const err = w.failOn?.(r.sql);
        if (err) throw err;
        return w.query(r.sql, r.values);
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const r = render(strings, values);
        log('exec', r);
        const err = w.failOn?.(r.sql);
        if (err) throw err;
        return 1;
      },
      $transaction: async (fn: (tx: Row) => Promise<unknown>, opts?: unknown) => {
        log('tx.begin');
        w.txOpts.push(opts);
        const snap = w.snapshot();
        try {
          const out = await fn(client);
          log('tx.commit');
          return out;
        } catch (e) {
          w.restore(snap);
          log('tx.rollback');
          throw e;
        }
      },
      tenant: { findUnique: async () => ({ lotTrackingSince: w.tenantSince, lotTrackingEnabled: w.lotsEnabled, warehouseEnabled: w.warehouseEnabled, accountingEnabled: true }) },
      glSettings: { findUnique: async () => null },
      companySettings: { findUnique: async () => ({ countryCode: 'SA', currency: 'SAR' }) },
      admin: { findUnique: async () => ({ isActive: true, scopeEnabled: false, scopeMode: 'LISTS', canManageVanStock: true }) },
      salesRep: { findMany: async (a: Row) => w.reps.filter((r) => inList(a.where?.id, r)).map((id) => ({ id })) },
      product: {
        findMany: async (a: Row) => {
          log('product.findMany', { args: a });
          return w.products.filter((p) => p.tenantId === a.where.tenantId && inList(a.where.id, p.id)
            && (a.where.lotTracked === undefined || p.lotTracked === a.where.lotTracked))
            .map((p) => ({ ...p, units: w.units.filter((u) => u.productId === p.id).map(({ name, factor, isActive }) => ({ name, factor, isActive })) }));
        },
      },
      productUnit: {
        findMany: async (a: Row) => w.units.filter((u) => u.tenantId === a.where.tenantId && inList(a.where.id, u.id))
          .map((u) => ({ id: u.id, productId: u.productId, name: u.name, factor: u.factor, isActive: u.isActive })),
      },
      productLot: {
        findFirst: async (a: Row) => { log('productLot.findFirst'); const l = w.lots.find(lotWhere(a.where)); return l ? w.metaOf(l) : null; },
        findUnique: async (a: Row) => {
          log('productLot.findUnique');
          const k = a.where.tenantId_productId_lotNumber;
          const l = w.lots.find((x) => x.tenantId === k.tenantId && x.productId === k.productId && x.lotNumber === k.lotNumber);
          return l ? { ...w.metaOf(l), sourceEntryId: l.sourceEntryId } : null;
        },
        findMany: async (a: Row) => { log('productLot.findMany', { args: a }); return w.lots.filter(lotWhere(a.where)).map((l) => ({ ...l })); },
        createMany: async (a: Row) => {
          log('productLot.createMany', { args: a });
          let count = 0;
          for (const d of a.data as Row[]) {
            if (w.lots.some((x) => x.tenantId === d.tenantId && x.productId === d.productId && x.lotNumber === d.lotNumber)) continue;
            w.lots.push({ status: 'ACTIVE', blockKind: null, blockedAt: null, note: null, createdBy: null, sourceEntryId: null, ...d, id: w.id('L'), createdAt: w.now() } as WLot);
            count++;
          }
          return { count };
        },
        deleteMany: async (a: Row) => {
          log('productLot.deleteMany', { args: a });
          const before = w.lots.length;
          w.lots = w.lots.filter((l) => !lotWhere(a.where)(l));
          return { count: before - w.lots.length };
        },
        count: async (a: Row) => w.lots.filter(lotWhere(a.where)).length,
      },
      lotEvent: {
        create: async (a: Row) => { log('lotEvent.create'); w.events.push(a.data); return a.data; },
        createMany: async (a: Row) => { log('lotEvent.createMany'); w.events.push(...(a.data as Row[])); return { count: (a.data as Row[]).length }; },
      },
      warehouseEntry: {
        create: async (a: Row) => {
          log('warehouseEntry.create', { args: a });
          const e = w.entry(a.data.type, [], a.data.createdAt, a.data.id);
          Object.assign(e, { note: a.data.note ?? null, createdBy: a.data.createdBy ?? null, supplier: a.data.supplier ?? null });
          for (const i of a.data.items.create as Row[]) {
            w.items.push({ id: w.id('wi'), entryId: e.id, productId: i.productId, qty: i.qty, unitName: i.unitName ?? null, unitFactor: i.unitFactor ?? 1, baseQty: i.baseQty ?? null, unitCost: i.unitCost ?? null, lotId: i.lotId ?? null });
          }
          return a.select ? { id: e.id } : entryWithItems(e, a.include);
        },
        findMany: async (a: Row) => w.entries.filter((e) => e.tenantId === a.where.tenantId).map((e) => entryWithItems(e, a.include)),
        findUniqueOrThrow: async (a: Row) => {
          const e = w.entries.find((x) => x.id === a.where.id);
          if (!e) throw new Error('NotFound');
          return { createdAt: e.createdAt, items: w.items.filter((i) => i.entryId === e.id).map((i) => ({ productId: i.productId })) };
        },
        deleteMany: async (a: Row) => { log('warehouseEntry.deleteMany'); const n = w.entries.length; w.entries = w.entries.filter((e) => e.id !== a.where.id); return { count: n - w.entries.length }; },
      },
      warehouseEntryItem: {
        findMany: async (a: Row) => {
          log('warehouseEntryItem.findMany', { args: a });
          return w.items.filter(itemWhere(a.where)).map((i) => {
            const e = entryOf(i)!;
            return { ...i, entry: { type: e.type, createdAt: e.createdAt } };
          });
        },
        count: async (a: Row) => { log('warehouseEntryItem.count'); return w.items.filter(itemWhere(a.where)).length; },
        groupBy: async (a: Row) => {
          const ids = [...new Set(w.items.filter(itemWhere(a.where)).map((i) => i.productId))];
          return ids.map((productId) => ({ productId, _count: { _all: 1 } }));
        },
        deleteMany: async (a: Row) => { log('warehouseEntryItem.deleteMany'); const n = w.items.length; w.items = w.items.filter((i) => i.entryId !== a.where.entryId); return { count: n - w.items.length }; },
      },
      vanLoadItem: {
        findMany: async () => w.vanItems.map((v) => ({ productId: v.productId, qty: v.qty, unitFactor: v.unitFactor, baseQty: v.baseQty, vanLoad: { type: v.type, createdAt: v.createdAt, salesRepId: v.salesRepId, deletedSalesRepId: null } })),
        count: async (a: Row) => w.vanItems.filter((v) => vanWhere(a.where)(v)).length,
        groupBy: async (a: Row) => [...new Set(w.vanItems.filter((v) => vanWhere(a.where)(v)).map((v) => v.productId))].map((productId) => ({ productId, _count: { _all: 1 } })),
      },
      importBatch: {
        findFirst: async (a: Row) => w.batches.find((b) => b.tenantId === a.where.tenantId && (a.where.id === undefined || b.id === a.where.id)
          && (a.where.kind === undefined || b.kind === a.where.kind) && (a.where.reverted === undefined || b.reverted === a.where.reverted)
          && (a.where.contentHash === undefined || b.contentHash === a.where.contentHash)) ?? null,
        findMany: async (a: Row) => w.batches.filter((b) => b.tenantId === a.where.tenantId && (a.where.reverted === undefined || b.reverted === a.where.reverted)
          && (a.where.kind === undefined || (typeof a.where.kind === 'string' ? b.kind === a.where.kind : a.where.kind.in.includes(b.kind)))),
        create: async (a: Row) => { const b = { id: w.id('B'), reverted: false, ...a.data }; w.batches.push(b); return { id: b.id }; },
        update: async (a: Row) => { const b = w.batches.find((x) => x.id === a.where.id)!; Object.assign(b, a.data); return b; },
      },
      vanLoadItemLot: {
        count: async (a: Row) => { log('vanLoadItemLot.count'); return w.vanLots.filter((r) => r.lotId && a.where.lotId.in.includes(r.lotId) && (!a.where.createdAt?.gte || r.createdAt >= a.where.createdAt.gte)).length; },
        findMany: async (a: Row) => w.vanLots.filter((r) => r.lotId && a.where.lotId.in.includes(r.lotId)).map((r) => ({ lotId: r.lotId })),
      },
      lotRelabel: {
        count: async (a: Row) => {
          log('lotRelabel.count');
          const ids: string[] = a.where.OR[0].fromLotId.in;
          return w.relabels.filter((r) => (ids.includes(r.fromLotId ?? '') || ids.includes(r.toLotId ?? '')) && (!a.where.createdAt?.gte || r.createdAt >= a.where.createdAt.gte)).length;
        },
        findMany: async (a: Row) => {
          const ids: string[] = a.where.OR[0].fromLotId.in;
          return w.relabels.filter((r) => ids.includes(r.fromLotId ?? '') || ids.includes(r.toLotId ?? '')).map((r) => ({ fromLotId: r.fromLotId, toLotId: r.toLotId }));
        },
      },
      invoiceItemLot: { findMany: async (a: Row) => w.invLotRefs.filter((r) => a.where.lotId.in.includes(r.lotId)) },
      invoiceItem: { findMany: async () => [] },
    };
    return client;
  }

  /** خام لوطٍ في المستودع الآن من الصفوف مباشرةً بعد الحقبة — مرجعٌ مستقل عن الطيّ */
  warehouseRaw(lotId: string): number {
    let s = 0;
    for (const it of this.items) {
      const e = this.entries.find((x) => x.id === it.entryId)!;
      if (it.lotId === lotId && e.createdAt.getTime() >= this.epochOf(it.productId)) s += baseOf(it);
    }
    for (const v of this.vanLots) {
      if (v.lotId !== lotId || !v.viaWarehouse || v.createdAt.getTime() < this.epochOf(v.productId)) continue;
      if (v.moveType === 'UNLOAD') s += v.qty; else if (v.moveType === 'LOAD') s -= v.qty;
    }
    for (const r of this.relabels) {
      if (r.place !== 'WAREHOUSE' || r.createdAt.getTime() < this.epochOf(r.productId)) continue;
      if (r.fromLotId === lotId) s -= r.qty;
      if (r.toLotId === lotId) s += r.qty;
    }
    return r4(s);
  }

  /** رصيد الصنف في المستودع (composeWarehouse.onHand) بالأساس */
  warehouseTotal(productId: string): number {
    let s = 0;
    for (const it of this.items) if (it.productId === productId) s += baseOf(it);
    for (const v of this.vanItems) {
      if (v.productId !== productId) continue;
      if (v.type === 'UNLOAD') s += baseOf(v); else if (v.type === 'LOAD') s -= baseOf(v);
    }
    return r4(s);
  }

  /** غير المسمّى في المستودع = رصيد الصنف − Σ خام لوطاته المسمّاة */
  warehouseUnknown(productId: string): number {
    const lots = this.lots.filter((l) => l.productId === productId).map((l) => l.id);
    return r4(this.warehouseTotal(productId) - lots.reduce((s, id) => s + this.warehouseRaw(id), 0));
  }

  lotByNumber(productId: string, lotNumber: string): WLot | undefined {
    return this.lots.find((l) => l.productId === productId && l.lotNumber === lotNumber);
  }
}
