// «تتبّع اللوط» — موجّه /api/lots فوق Prisma مزيّف في الذاكرة (المواصفة §٨.٢ lots-api، الحزمة B2: routes/lots.ts،
// services/lotsRelabel.ts، services/lotsTrace.ts). لا قاعدة ولا شبكة خارجية: خادم express على 127.0.0.1 بمنفذٍ عشوائي.
//
// المزيّف ينفّذ نماذج Prisma المستعملة (where/select/include/orderBy/distinct، والمعاملة بتراجعٍ كامل عند الرمي) ويجيب **جمل
// SQL الحقيقية** في services/lotsDb.ts (قفل الأصناف، وتجميعات صفوف اللوط والبنود بالحقبة والتوجيه والحجز وBASE_QTY_SQL)
// بحسابها على الجداول — فيمرّ كل اختبار بـplaceViews وfoldStock وassemblePlaceViews الحقيقية.
//
// يغطّي: الحرّاس بالترتيب، والمسارات الثابتة قبل /:id، وLOT_SCOPED_USER وLOT_REASON_REQUIRED (D27)، ومنع السالب في التسمية
// (I1 على اللوط، وI2 على غير المسمّى ومنه السالب التاريخي، والمحجوز D24، والسيارة المحذوفة)، ولا تسمية من موقوف أو منتهٍ،
// وLotEvent لكل تغيير، والتتبّع STRICT بصافي الصفر وBROAD بنافذة رصيد الصنف، والنطاق، وخطة التنزيل، وسلامة الأرصدة،
// والتفعيل الجماعي بدفعات ١٠٠ وأقفالٍ مرتّبة وD9، و«المخزون في تاريخ»، واقتراح FEFO بقاعدة الكرتون، والانشغال 503 —
// وحالات الوحدات: سطرٌ بكرتون وسطرٌ بحبّة للصنف نفسه (الكمية الأساسية في الأرصدة والتسمية والتتبّع والاقتراح).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Prisma } from '@prisma/client';
import { LOT_HOLD_MIRRORS, lotLockKey, sortedLockKeys } from '../services/lots';
import { DAMAGED_VAN_SINCE } from '../services/vanDamaged';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
type Row = Record<string, any>;

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ قاعدة مزيّفة في الذاكرة ═══

const MODELS = [
  'tenant', 'companySettings', 'glSettings', 'admin', 'salesRep', 'customer', 'adminRepScope', 'adminCustomerScope', 'product',
  'productLot', 'warehouseEntry', 'warehouseEntryItem', 'vanLoad', 'vanLoadItem', 'vanLoadItemLot', 'invoice', 'invoiceItem',
  'invoiceItemLot', 'lotRelabel', 'lotEvent',
] as const;
type Model = typeof MODELS[number];
type Tables = Record<Model, Row[]>;
const emptyTables = (): Tables => Object.fromEntries(MODELS.map((m) => [m, []])) as unknown as Tables;
let T: Tables = emptyTables();

interface LogEntry { kind: 'query' | 'exec' | 'model'; text: string; values: unknown[]; inTx: boolean }
let log: LogEntry[] = [];
let txOpts: unknown[] = [];
let inTx = 0;
let lockTimeout = '0';
let rawHook: ((e: LogEntry) => void) | null = null;
let seq = 0;
let tick = 0;
/** ساعة الكتابة: لا ترجع أبداً، ولا تسبق ساعة الخادم (الحقبة lotTrackedSince تُضبط بـnew Date() في المسار) */
const now = () => new Date((tick = Math.max(Date.now(), tick + 1)));

interface Rel { model: Model; many: boolean; get: (r: Row) => Row | Row[] | null }
const one = (model: Model, fk: string): Rel => ({ model, many: false, get: (r) => T[model].find((x) => x.id === r[fk]) ?? null });
const many = (model: Model, fk: string): Rel => ({ model, many: true, get: (r) => T[model].filter((x) => x[fk] === r.id) });
const REL: Partial<Record<Model, Record<string, Rel>>> = {
  warehouseEntryItem: { entry: one('warehouseEntry', 'entryId'), lot: one('productLot', 'lotId'), product: one('product', 'productId') },
  warehouseEntry: { items: many('warehouseEntryItem', 'entryId') },
  vanLoadItemLot: { vanLoadItem: one('vanLoadItem', 'vanLoadItemId'), lot: one('productLot', 'lotId') },
  vanLoadItem: { vanLoad: one('vanLoad', 'vanLoadId'), lots: many('vanLoadItemLot', 'vanLoadItemId') },
  vanLoad: { items: many('vanLoadItem', 'vanLoadId'), salesRep: one('salesRep', 'salesRepId') },
  invoiceItemLot: { invoiceItem: one('invoiceItem', 'invoiceItemId'), lot: one('productLot', 'lotId') },
  invoiceItem: { invoice: one('invoice', 'invoiceId'), lots: many('invoiceItemLot', 'invoiceItemId') },
  invoice: { customer: one('customer', 'customerId'), salesRep: one('salesRep', 'salesRepId'), items: many('invoiceItem', 'invoiceId') },
  productLot: { product: one('product', 'productId') },
  salesRep: { adminScopes: many('adminRepScope', 'salesRepId') },
  customer: { adminScopes: many('adminCustomerScope', 'customerId') },
};
const UPDATED_AT: ReadonlySet<Model> = new Set(['productLot', 'product']);
const COMPOUND: Record<string, string[]> = { tenantId_productId_lotNumber: ['tenantId', 'productId', 'lotNumber'] };
const DEFAULTS: Partial<Record<Model, () => Row>> = {
  productLot: () => ({
    productionDate: null, expiryDate: null, status: 'ACTIVE', blockKind: null, blockReason: null, blockedAt: null, blockedBy: null,
    note: null, source: 'MANUAL', sourceEntryId: null, createdBy: null,
  }),
  lotRelabel: () => ({ vanKey: null, bucket: 'SELLABLE', fromLotId: null, toLotId: null, note: null, createdBy: null }),
  lotEvent: () => ({ lotId: null, before: null, after: null, reason: null, actorId: null, actorName: null }),
};

const isPlain = (x: unknown): x is Row => !!x && typeof x === 'object' && !(x instanceof Date) && !Array.isArray(x);
const val = (x: unknown) => (x instanceof Date ? x.getTime() : x);
const eq = (a: unknown, b: unknown) => (a == null && b == null) || val(a) === val(b);
const cmp = (a: unknown, b: unknown) => { const x = val(a) as any, y = val(b) as any; return x < y ? -1 : x > y ? 1 : 0; };

function scalar(v: unknown, cond: unknown): boolean {
  if (cond === null) return v == null;
  if (!isPlain(cond)) return eq(v, cond);
  for (const [op, x] of Object.entries(cond)) {
    if (x === undefined) continue;
    switch (op) {
      case 'equals': if (!eq(v, x)) return false; break;
      case 'in': if (!(x as unknown[]).some((y) => eq(v, y))) return false; break;
      case 'notIn': if ((x as unknown[]).some((y) => eq(v, y))) return false; break;
      case 'not': if (x === null ? v == null : isPlain(x) ? scalar(v, x) : eq(v, x)) return false; break;
      case 'lt': if (!(v != null && cmp(v, x) < 0)) return false; break;
      case 'lte': if (!(v != null && cmp(v, x) <= 0)) return false; break;
      case 'gt': if (!(v != null && cmp(v, x) > 0)) return false; break;
      case 'gte': if (!(v != null && cmp(v, x) >= 0)) return false; break;
      case 'contains': {
        const ins = (cond as Row).mode === 'insensitive';
        if (typeof v !== 'string' || !(ins ? v.toLowerCase().includes(String(x).toLowerCase()) : v.includes(String(x)))) return false;
        break;
      }
      case 'mode': break;
      default: throw new Error(`مزيّف: عامل غير مدعوم ${op}`);
    }
  }
  return true;
}

function match(model: Model, row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'AND') { if (!(Array.isArray(cond) ? cond : [cond]).every((w) => match(model, row, w))) return false; continue; }
    if (k === 'OR') { if (!(cond as Row[]).some((w) => match(model, row, w))) return false; continue; }
    if (k === 'NOT') { if ((Array.isArray(cond) ? cond : [cond]).some((w) => match(model, row, w))) return false; continue; }
    if (COMPOUND[k]) { if (!COMPOUND[k].every((f) => eq(row[f], (cond as Row)[f]))) return false; continue; }
    const rel = REL[model]?.[k];
    if (rel) {
      const got = rel.get(row);
      if (rel.many) {
        const rows = got as Row[];
        const c = cond as Row;
        if (c.some && !rows.some((r) => match(rel.model, r, c.some))) return false;
        if (c.none && rows.some((r) => match(rel.model, r, c.none))) return false;
        if (c.every && !rows.every((r) => match(rel.model, r, c.every))) return false;
      } else {
        if (cond === null) { if (got != null) return false; continue; }
        const c = (cond as Row).is !== undefined ? (cond as Row).is : cond;
        if (c === null ? got != null : !(got && match(rel.model, got as Row, c))) return false;
      }
      continue;
    }
    if (!scalar(row[k], cond)) return false;
  }
  return true;
}

function project(model: Model, row: Row, select?: Row, include?: Row): Row {
  if (!select && !include) return { ...row };
  const out: Row = select ? {} : { ...row };
  for (const [k, v] of Object.entries((select ?? include) as Row)) {
    if (!v) continue;
    const rel = REL[model]?.[k];
    if (rel) {
      const o: Row = v === true ? {} : v;
      const got = rel.get(row);
      if (rel.many) out[k] = (got as Row[]).filter((r) => match(rel.model, r, o.where)).map((r) => project(rel.model, r, o.select, o.include));
      else out[k] = got ? project(rel.model, got as Row, o.select, o.include) : null;
    } else out[k] = row[k] ?? null;
  }
  return out;
}

function ordered(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
  return [...rows].sort((a, b) => {
    for (const s of specs) {
      const [k, d] = Object.entries(s)[0];
      const dir = isPlain(d) ? d.sort : d;
      const nulls = isPlain(d) ? d.nulls : undefined;
      const x = a[k], y = b[k];
      if (x == null || y == null) {
        if (x == null && y == null) continue;
        const nullFirst = nulls ? nulls === 'first' : dir === 'desc';
        return (x == null ? -1 : 1) * (nullFirst ? 1 : -1);
      }
      const c = cmp(x, y);
      if (c) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

function query(model: Model, a: Row = {}): Row[] {
  let rows = ordered(T[model].filter((r) => match(model, r, a.where)), a.orderBy);
  if (a.distinct) {
    const seen = new Set<string>();
    rows = rows.filter((r) => { const k = JSON.stringify((a.distinct as string[]).map((f) => r[f])); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (a.skip) rows = rows.slice(a.skip);
  if (a.take !== undefined) rows = rows.slice(0, a.take);
  return rows.map((r) => project(model, r, a.select, a.include));
}

function uniqueClash(model: Model, row: Row): boolean {
  return model === 'productLot'
    && T.productLot.some((x) => x !== row && x.tenantId === row.tenantId && x.productId === row.productId && x.lotNumber === row.lotNumber);
}
function insert(model: Model, data: Row): Row {
  const at = now();
  const row: Row = { id: `${model}-${++seq}`, ...DEFAULTS[model]?.(), createdAt: at, ...(UPDATED_AT.has(model) && { updatedAt: at }), ...data };
  if (uniqueClash(model, row)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  T[model].push(row);
  return row;
}
function referenced(lotId: string): boolean {
  return T.warehouseEntryItem.some((r) => r.lotId === lotId) || T.vanLoadItemLot.some((r) => r.lotId === lotId)
    || T.invoiceItemLot.some((r) => r.lotId === lotId) || T.lotRelabel.some((r) => r.fromLotId === lotId || r.toLotId === lotId);
}

function modelApi(model: Model) {
  const note = (method: string, a: unknown) => log.push({ kind: 'model', text: `${model}.${method}`, values: [a], inTx: inTx > 0 });
  return {
    findMany: async (a: Row = {}) => { note('findMany', a); return query(model, a); },
    findFirst: async (a: Row = {}) => { note('findFirst', a); return query(model, { ...a, take: 1 })[0] ?? null; },
    findUnique: async (a: Row = {}) => { note('findUnique', a); return query(model, { ...a, take: 1 })[0] ?? null; },
    count: async (a: Row = {}) => { note('count', a); return T[model].filter((r) => match(model, r, a.where)).length; },
    create: async (a: Row) => { note('create', a); return project(model, insert(model, a.data), a.select, a.include); },
    createMany: async (a: Row) => {
      note('createMany', a);
      let count = 0;
      for (const d of a.data as Row[]) {
        try { insert(model, d); count++; } catch (e) { if (!a.skipDuplicates) throw e; }
      }
      return { count };
    },
    updateMany: async (a: Row) => {
      note('updateMany', a);
      const rows = T[model].filter((r) => match(model, r, a.where));
      const at = now();
      for (const r of rows) Object.assign(r, a.data, UPDATED_AT.has(model) && !('updatedAt' in a.data) ? { updatedAt: at } : {});
      return { count: rows.length };
    },
    update: async (a: Row) => {
      note('update', a);
      const r = T[model].find((x) => match(model, x, a.where));
      if (!r) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      Object.assign(r, a.data, UPDATED_AT.has(model) ? { updatedAt: now() } : {});
      return project(model, r, a.select, a.include);
    },
    delete: async (a: Row) => {
      note('delete', a);
      const i = T[model].findIndex((x) => match(model, x, a.where));
      if (i < 0) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      if (model === 'productLot' && referenced(T[model][i].id)) throw Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' });
      return T[model].splice(i, 1)[0];
    },
    deleteMany: async (a: Row = {}) => {
      note('deleteMany', a);
      const keep = T[model].filter((r) => !match(model, r, a.where));
      const count = T[model].length - keep.length;
      T[model] = keep;
      return { count };
    },
  };
}

// ── جمل SQL الحقيقية (lotsDb.ts وموجّه اللوط) محسوبةً على الجداول ──
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const arg = (text: string, values: unknown[], prefix: string): any => {
  const m = new RegExp(`${esc(prefix)}\\$(\\d+)`).exec(text);
  return m ? values[Number(m[1]) - 1] : undefined;
};
const ms = (d: unknown) => (d instanceof Date ? d.getTime() : d == null ? null : new Date(d as string).getTime());
/** الحقبة (D25) = GREATEST(tenants.lotTrackingSince، products.lotTrackedSince) */
const epochOf = (tenantId: string, productId: string) => {
  const t = T.tenant.find((x) => x.id === tenantId), p = T.product.find((x) => x.id === productId);
  return Math.max(t?.lotTrackingSince ? ms(t.lotTrackingSince)! : -Infinity, p?.lotTrackedSince ? ms(p.lotTrackedSince)! : -Infinity);
};
/** BASE_QTY_SQL = COALESCE("baseQty", qty * COALESCE(NULLIF("unitFactor", 0), 1)) */
const baseSql = (r: Row) => (r.baseQty != null ? r.baseQty : r.qty * (r.unitFactor == null || r.unitFactor === 0 ? 1 : r.unitFactor));
function groupRows<R>(rows: R[], key: (r: R) => unknown[], init: (r: R) => Row, add: (acc: Row, r: R) => void): Row[] {
  const m = new Map<string, Row>();
  for (const r of rows) {
    const k = JSON.stringify(key(r));
    let acc = m.get(k);
    if (!acc) { acc = init(r); m.set(k, acc); }
    add(acc, r);
  }
  return [...m.values()];
}
const minDate = (a: Date | null, b: Date | null) => (a == null ? b : b == null ? a : (a < b ? a : b));

function invLotsPart(text: string, values: unknown[]): Row[] {
  const tid = arg(text, values, 'il."tenantId" = ');
  const pids: string[] = arg(text, values, 'il."productId" = ANY(');
  const keys: string[] | undefined = arg(text, values, 'il."vanKey" = ANY(');
  const before: Date | undefined = arg(text, values, 'i."invoiceDate" < ');
  const since: Date = arg(text, values, 'i."createdAt" >= ');
  const mirrors: string[] = arg(text, values, '"einvoiceStatus" = ANY(');
  assert.equal(+since, +DAMAGED_VAN_SINCE);
  assert.deepEqual(mirrors, [...LOT_HOLD_MIRRORS]);
  const rows = T.invoiceItemLot.flatMap((il) => {
    const inv = T.invoice.find((i) => i.id === il.invoiceId)!;
    const it = T.invoiceItem.find((i) => i.id === il.invoiceItemId)!;
    if (il.tenantId !== tid || inv.tenantId !== tid || inv.status !== 'CONFIRMED' || !pids.includes(il.productId)) return [];
    if (keys && !keys.includes(il.vanKey)) return [];
    if (before && !(inv.invoiceDate < before)) return [];
    if (ms(il.createdAt)! < epochOf(il.tenantId, il.productId)) return [];
    return [{ il, inv, it }];
  });
  return groupRows(rows, ({ il, inv, it }) => [il.productId, il.lotId, il.vanKey, inv.type, inv.returnToStock, it.returnExpired, damagedOf(inv, since), heldOf(inv, mirrors)],
    ({ il, inv, it }) => ({
      productId: il.productId, lotId: il.lotId, vanKey: il.vanKey, type: inv.type, returnToStock: inv.returnToStock, returnExpired: it.returnExpired ?? null,
      damaged: damagedOf(inv, since), held: heldOf(inv, mirrors), qty: 0, firstAt: null, src: 'LOT',
    }),
    (acc, { il }) => { acc.qty += il.quantity; acc.firstAt = minDate(acc.firstAt, il.createdAt); });
}
const damagedOf = (inv: Row, since: Date) => inv.returnReason === 'DAMAGED' && inv.createdAt >= since;
const heldOf = (inv: Row, mirrors: string[]) => inv.type === 'RETURN' && inv.zatcaPhase === 2 && inv.invoiceSubtype === '01'
  && (inv.einvoiceStatus == null || mirrors.includes(inv.einvoiceStatus));

function invTotalsPart(text: string, values: unknown[]): Row[] {
  const tid = arg(text, values, 'i."tenantId" = ');
  const keys: string[] = arg(text, values, 'i."salesRepId" = ANY(');
  const pids: string[] = arg(text, values, 'it."productId" = ANY(');
  const before: Date | undefined = arg(text, values, 'i."invoiceDate" < ');
  const since: Date = arg(text, values, 'i."createdAt" >= ');
  const mirrors: string[] = arg(text, values, '"einvoiceStatus" = ANY(');
  const rows = T.invoiceItem.flatMap((it) => {
    const inv = T.invoice.find((i) => i.id === it.invoiceId)!;
    if (inv.tenantId !== tid || !keys.includes(inv.salesRepId) || inv.status !== 'CONFIRMED' || !pids.includes(it.productId)) return [];
    if (before && !(inv.invoiceDate < before)) return [];
    return [{ it, inv }];
  });
  return groupRows(rows, ({ it, inv }) => [it.productId, inv.salesRepId, inv.type, inv.returnToStock, it.returnExpired, damagedOf(inv, since), heldOf(inv, mirrors)],
    ({ it, inv }) => ({
      productId: it.productId, lotId: null, vanKey: inv.salesRepId, type: inv.type, returnToStock: inv.returnToStock, returnExpired: it.returnExpired ?? null,
      damaged: damagedOf(inv, since), held: heldOf(inv, mirrors), qty: 0, firstAt: null, src: 'TOT',
    }),
    (acc, { it }) => { acc.qty += baseSql(it); });
}

function rawQuery(e: LogEntry): unknown[] | number {
  const { text, values } = e;
  if (/FROM products WHERE "tenantId" = \$\d+ AND id = ANY\(\$\d+::text\[\]\) ORDER BY id (FOR KEY SHARE|FOR UPDATE)$/.test(text)) {
    const tid = arg(text, values, '"tenantId" = '), ids: string[] = arg(text, values, 'id = ANY(');
    return T.product.filter((p) => p.tenantId === tid && ids.includes(p.id)).sort((a, b) => cmp(a.id, b.id))
      .map((p) => ({ id: p.id, lotTracked: p.lotTracked === true, lotTrackedSince: p.lotTrackedSince ?? null }));
  }
  if (text === "SELECT current_setting('lock_timeout') AS lock_timeout") return [{ lock_timeout: lockTimeout }];
  if (text === "SELECT set_config('lock_timeout', $1, true)") { lockTimeout = String(values[0]); return 1; }
  if (text === 'SELECT pg_advisory_xact_lock($1)') return 1;
  if (text.includes('FROM van_load_item_lots l')) {
    const tid = arg(text, values, 'l."tenantId" = '), pids: string[] = arg(text, values, 'l."productId" = ANY(');
    const keys: string[] | undefined = arg(text, values, 'l."vanKey" = ANY(');
    const before: Date | undefined = arg(text, values, 'l."createdAt" < ');
    const whOnly = text.includes('l."viaWarehouse" = true AND l."moveType" IN (\'LOAD\', \'UNLOAD\')');
    const rows = T.vanLoadItemLot.filter((l) => l.tenantId === tid && pids.includes(l.productId) && (!keys || keys.includes(l.vanKey))
      && (!whOnly || (l.viaWarehouse && (l.moveType === 'LOAD' || l.moveType === 'UNLOAD'))) && (!before || l.createdAt < before)
      && ms(l.createdAt)! >= epochOf(l.tenantId, l.productId));
    return groupRows(rows, (l) => [l.productId, l.lotId, l.vanKey, l.moveType, l.viaWarehouse],
      (l) => ({ productId: l.productId, lotId: l.lotId, vanKey: l.vanKey, moveType: l.moveType, viaWarehouse: l.viaWarehouse, qty: 0, firstInAt: null }),
      (acc, l) => { acc.qty += l.qty; if (l.qty > 0) acc.firstInAt = minDate(acc.firstInAt, l.createdAt); });
  }
  if (text.includes('FROM invoice_item_lots il') || text.includes('FROM invoice_items it')) {
    const parts = text.split(' UNION ALL ');
    return parts.flatMap((p) => (p.includes('FROM invoice_item_lots il') ? invLotsPart(p, values) : invTotalsPart(p, values)));
  }
  if (text.includes('FROM lot_relabels r')) {
    const tid = arg(text, values, 'r."tenantId" = '), pids: string[] = arg(text, values, 'r."productId" = ANY(');
    const keys: string[] = arg(text, values, 'r."vanKey" = ANY(') ?? [];
    const before: Date | undefined = arg(text, values, 'r."createdAt" < ');
    const both = text.includes("r.place = 'WAREHOUSE' OR");
    const whOnly = !both && text.includes("AND r.place = 'WAREHOUSE'");
    const rows = T.lotRelabel.filter((r) => r.tenantId === tid && pids.includes(r.productId)
      && (both ? (r.place === 'WAREHOUSE' || (r.place === 'VAN' && keys.includes(r.vanKey))) : whOnly ? r.place === 'WAREHOUSE' : (r.place === 'VAN' && keys.includes(r.vanKey)))
      && (!before || r.createdAt < before) && ms(r.createdAt)! >= epochOf(r.tenantId, r.productId));
    return groupRows(rows, (r) => [r.productId, r.place, r.vanKey, r.bucket, r.fromLotId, r.toLotId],
      (r) => ({ productId: r.productId, place: r.place, vanKey: r.vanKey, bucket: r.bucket, fromLotId: r.fromLotId, toLotId: r.toLotId, qty: 0, firstAt: null }),
      (acc, r) => { acc.qty += r.qty; if (r.qty > 0) acc.firstAt = minDate(acc.firstAt, r.createdAt); });
  }
  if (text.includes('FROM warehouse_entry_items wi')) {
    const tid = arg(text, values, 'we."tenantId" = '), pids: string[] = arg(text, values, 'wi."productId" = ANY(');
    const before: Date | undefined = arg(text, values, 'we."createdAt" < ');
    const named = text.includes('wi."lotId" IS NOT NULL');
    const rows = T.warehouseEntryItem.flatMap((wi) => {
      const we = T.warehouseEntry.find((x) => x.id === wi.entryId)!;
      if (we.tenantId !== tid || !pids.includes(wi.productId) || (before && !(we.createdAt < before))) return [];
      if (named && (wi.lotId == null || ms(we.createdAt)! < epochOf(we.tenantId, wi.productId))) return [];
      return [{ wi, we }];
    });
    return named
      ? groupRows(rows, ({ wi }) => [wi.productId, wi.lotId], ({ wi }) => ({ productId: wi.productId, lotId: wi.lotId, qty: 0 }), (acc, { wi }) => { acc.qty += baseSql(wi); })
      : groupRows(rows, ({ wi, we }) => [wi.productId, we.type], ({ wi, we }) => ({ productId: wi.productId, type: we.type, qty: 0 }), (acc, { wi }) => { acc.qty += baseSql(wi); });
  }
  if (text.includes('FROM van_load_items vli')) {
    const tid = arg(text, values, 'vl."tenantId" = '), pids: string[] = arg(text, values, 'vli."productId" = ANY(');
    const keys: string[] | undefined = arg(text, values, 'vl."salesRepId" = ANY(');
    const before: Date | undefined = arg(text, values, 'vl."createdAt" < ');
    const rows = T.vanLoadItem.flatMap((vli) => {
      const vl = T.vanLoad.find((x) => x.id === vli.vanLoadId)!;
      if (vl.tenantId !== tid || !pids.includes(vli.productId) || (before && !(vl.createdAt < before))) return [];
      if (keys ? !keys.includes(vl.salesRepId) : !(vl.type === 'LOAD' || vl.type === 'UNLOAD')) return [];
      return [{ vli, vl }];
    });
    return keys
      ? groupRows(rows, ({ vli, vl }) => [vli.productId, vl.salesRepId, vl.type], ({ vli, vl }) => ({ productId: vli.productId, vanKey: vl.salesRepId, type: vl.type, qty: 0 }), (acc, { vli }) => { acc.qty += baseSql(vli); })
      : groupRows(rows, ({ vli, vl }) => [vli.productId, vl.type], ({ vli, vl }) => ({ productId: vli.productId, type: vl.type, qty: 0 }), (acc, { vli }) => { acc.qty += baseSql(vli); });
  }
  throw new Error(`مزيّف: جملة SQL غير معروفة: ${text}`);
}

function raw(kind: 'query' | 'exec') {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    const e: LogEntry = { kind, text: q.text.replace(/\s+/g, ' ').trim(), values: q.values, inTx: inTx > 0 };
    log.push(e);
    rawHook?.(e);
    return rawQuery(e);
  };
}

const db: Row = new Proxy<Row>({
  ...Object.fromEntries(MODELS.map((m) => [m, modelApi(m)])),
  $queryRaw: raw('query'),
  $executeRaw: raw('exec'),
  async $transaction(fn: (tx: unknown) => Promise<unknown>, opts?: unknown) {
    txOpts.push(opts ?? null);
    const snap = structuredClone(T);
    const lt = lockTimeout;
    inTx++;
    try {
      return await fn(db);
    } catch (e) {
      T = snap; // التراجع الكامل كالقاعدة
      throw e;
    } finally {
      inTx--;
      lockTimeout = lt; // set_config(…, true) محلّي للمعاملة
    }
  },
}, {
  get: (t, k: string) => {
    if (k in t) return t[k];
    if (k === 'then') return undefined;
    throw new Error(`مزيّف: نموذج غير معروف ${k}`);
  },
});

// ═══ الوحدات تحت الاختبار ═══

stub('config/database', { default: db });
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('لا يُستدعى'); } });
const realAuth = require('../middleware/auth') as typeof import('../middleware/auth');
/** المصادقة الحقيقية تُختبر في api-key-feature-guards؛ هنا هويةٌ من ترويسة الاختبار وبقية الحرّاس حقيقية */
const fakeAuth = (req: any, res: any, next: () => void) => {
  const h = req.headers['x-test-user'];
  if (!h) { res.status(401).json({ success: false, message: 'غير مصادق' }); return; }
  req.user = JSON.parse(Buffer.from(String(h), 'base64').toString('utf8'));
  next();
};
stub('middleware/auth', { ...realAuth, authenticate: fakeAuth });
const lotsRouter = (require('../routes/lots') as typeof import('../routes/lots')).default;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');

let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });

type User = { id: string; role: string; name: string; tenantId: string; apiKeyId?: string; impersonated?: boolean };
const ADMIN: User = { id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 'T1' };
const SCOPED: User = { id: 'a2', role: 'MANAGER', name: 'مشرف', tenantId: 'T1' };
const NO_CUSTOMERS: User = { id: 'a3', role: 'ACCOUNTANT', name: 'محاسب', tenantId: 'T1' };
const REP: User = { id: 'R1', role: 'SALES_REP', name: 'أحمد', tenantId: 'T1' };
const KEY: User = { id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 'T1', apiKeyId: 'k1' };

async function call(method: string, url: string, opts: { user?: User | null; body?: unknown } = {}): Promise<{ status: number; body: Row }> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/lots', lotsRouter);
    app.use(errorHandler);
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const user = opts.user === undefined ? ADMIN : opts.user;
  const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server!.port, method, path: url, agent: false,
      headers: {
        connection: 'close',
        ...(user && { 'x-test-user': Buffer.from(JSON.stringify(user), 'utf8').toString('base64') }),
        ...(payload && { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const enc = encodeURIComponent;

// ═══ العالم: شركةٌ مفعّلة بتاريخٍ قبل الاختبار ═══

const D = (d: string, h = 9) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00.000Z`);
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);
const PERMS = ['canManageCustomers', 'canManageProducts', 'canManageVanStock', 'canManageCompanySettings', 'canManageInvoices'];

let invSeq = 0;
function addWh(at: string, type: string, items: { pid: string; qty: number; unitFactor?: number; baseQty?: number | null; lotId?: string | null }[], tenantId = 'T1') {
  const entry = { id: `WE-${++invSeq}`, tenantId, type, note: null, supplier: null, createdBy: null, createdAt: D(at) };
  T.warehouseEntry.push(entry);
  for (const it of items) {
    T.warehouseEntryItem.push({
      id: `WI-${++invSeq}`, entryId: entry.id, productId: it.pid, qty: it.qty, unitName: null, unitFactor: it.unitFactor ?? 1,
      baseQty: it.baseQty ?? null, unitCost: null, expiresAt: null, lotId: it.lotId ?? null,
    });
  }
  return entry.id;
}
function addLoad(at: string, type: string, rep: string, items: { pid: string; qty: number; unitFactor?: number; baseQty?: number | null; lots?: { lotId: string | null; qty: number }[] }[],
  opts: { deleted?: boolean; via?: boolean; tenantId?: string } = {}) {
  const vl = { id: `VL-${++invSeq}`, tenantId: opts.tenantId ?? 'T1', salesRepId: opts.deleted ? null : rep, deletedSalesRepId: opts.deleted ? rep : null, type, createdAt: D(at) };
  T.vanLoad.push(vl);
  for (const it of items) {
    const vli = { id: `VLI-${++invSeq}`, vanLoadId: vl.id, productId: it.pid, qty: it.qty, unitName: null, unitFactor: it.unitFactor ?? 1, baseQty: it.baseQty ?? null, suggestedQty: null, expectedQty: null };
    T.vanLoadItem.push(vli);
    for (const l of it.lots ?? []) {
      T.vanLoadItemLot.push({
        id: `VLL-${++invSeq}`, vanLoadItemId: vli.id, tenantId: vl.tenantId, productId: it.pid, vanKey: rep, moveType: type,
        viaWarehouse: opts.via ?? true, lotId: l.lotId, qty: l.qty, certainty: 'CONFIRMED', reason: null, createdAt: D(at),
      });
    }
  }
  return vl.id;
}
interface InvLotSeed { id?: string; lotId: string | null; qty: number; certainty?: string; flags?: string | null; src?: string | null }
function addInv(id: string, at: string, rep: string, customer: string, type: string,
  items: { pid: string; qty: number; unitFactor?: number; baseQty?: number | null; lots?: InvLotSeed[]; returnExpired?: boolean | null }[],
  opts: { returnToStock?: boolean; held?: boolean; createdAt?: Date; status?: string } = {}) {
  const createdAt = opts.createdAt ?? D(at);
  T.invoice.push({
    id, tenantId: 'T1', number: `INV-${id}`, customerId: customer, salesRepId: rep, teamId: null, type, status: opts.status ?? 'CONFIRMED',
    returnReason: null, returnToStock: opts.returnToStock ?? true, invoiceDate: createdAt, createdAt, clientCreatedAt: null,
    zatcaPhase: opts.held ? 2 : null, invoiceSubtype: opts.held ? '01' : null, einvoiceStatus: opts.held ? 'clearance_pending' : null,
  });
  items.forEach((it, i) => {
    const itemId = `${id}-I${i}`;
    T.invoiceItem.push({ id: itemId, invoiceId: id, productId: it.pid, qty: it.qty, unitName: null, unitFactor: it.unitFactor ?? 1, baseQty: it.baseQty ?? null, returnExpired: it.returnExpired ?? null });
    for (const l of it.lots ?? []) {
      T.invoiceItemLot.push({
        id: l.id ?? `IIL-${++invSeq}`, invoiceItemId: itemId, invoiceId: id, tenantId: 'T1', productId: it.pid, vanKey: rep, lotId: l.lotId,
        quantity: l.qty, certainty: l.certainty ?? (l.lotId ? 'CONFIRMED' : 'UNKNOWN'), expiryDate: null, sourceItemLotId: l.src ?? null,
        flags: l.flags ?? null, createdAt,
      });
    }
  });
}
const lotRow = (id: string, pid: string, lotNumber: string, expiry: string | null, extra: Row = {}) => ({
  id, tenantId: 'T1', productId: pid, lotNumber, productionDate: null, expiryDate: expiry ? DAY(expiry) : null, status: 'ACTIVE', blockKind: null,
  blockReason: null, blockedAt: null, blockedBy: null, note: null, source: 'RECEIVE', sourceEntryId: null, createdBy: null,
  createdAt: D('2026-01-20'), updatedAt: D('2026-01-20'), ...extra,
});

/**
 * المنتجات: P1 «حليب» متتبَّع بصلاحية (الانتهاء إلزامي)، P2 «شاي» غير متتبَّع، P3 «قهوة» متتبَّع بلا صلاحية (كرتون ٢٤ حبة).
 * اللوطات لـP1: L1 (٢٠٩٩-٠١)، L2 (٢٠٩٩-٠٦)، LX منتهية (٢٠٢٠)، LB موقوفة. السيارات: R1 «أحمد»، R2 «سالم»، وRX لمندوبٍ محذوف.
 * الأرصدة المتوقَّعة (P1): المستودع ١٢٥ = L1 ٥٠ + L2 ٢٥ + LX ١٠ + LB ١٠ + غير مسمّى ٣٠؛ R1 ٣٤ = L1 ٢٥ + L2 ٩ (منها ٢ محجوزة
 * بمرتجع إشعارٍ قياسي)؛ R2 ٦ = L2 ٦؛ RX: L2 ٥. و(P3): المستودع ١٩ = ٣ كراتين − ٥٣ حبة؛ R1 ٢٦ = ٢ كرتون + ٥ حبات − (كرتون + ٣)
 * غير مسمّاة كلها؛ R2 −٥ (بيعٌ بلا مخزون: عجزٌ غير مسمّى). P2 (غير متتبَّع): المستودع ٧، وR1 −٢.
 */
function world(): void {
  T = emptyTables();
  log = []; txOpts = []; inTx = 0; lockTimeout = '0'; rawHook = null;
  T.tenant.push(
    { id: 'T1', lotTrackingEnabled: true, lotTrackingSince: D('2026-01-01'), accountingEnabled: true, warehouseEnabled: true },
    { id: 'T2', lotTrackingEnabled: true, lotTrackingSince: D('2026-01-01'), accountingEnabled: true, warehouseEnabled: true },
  );
  T.companySettings.push({ id: 'CS1', tenantId: 'T1', countryCode: 'SA', lotOnInvoice: false });
  const admin = (id: string, role: string, extra: Row = {}) => ({ id, tenantId: 'T1', role, name: id, isActive: true, scopeEnabled: false, scopeMode: 'LISTS', ...Object.fromEntries(PERMS.map((p) => [p, true])), ...extra });
  T.admin.push(admin('a1', 'ADMIN'), admin('a2', 'MANAGER', { scopeEnabled: true }), admin('a3', 'ACCOUNTANT', { canManageCustomers: false }),
    admin('a4', 'MANAGER', { canManageVanStock: false }), admin('a5', 'MANAGER', { canManageProducts: false, canManageCompanySettings: false }));
  T.salesRep.push({ id: 'R1', tenantId: 'T1', name: 'أحمد' }, { id: 'R2', tenantId: 'T1', name: 'سالم' }, { id: 'R9', tenantId: 'T2', name: 'غريب' });
  T.customer.push(
    { id: 'C1', tenantId: 'T1', name: 'بقالة النور', phone: '0500000001', address: 'شارع ١', city: 'الرياض' },
    { id: 'C2', tenantId: 'T1', name: 'سوبرماركت الفجر', phone: '0500000002', address: null, city: 'جدة' },
  );
  T.adminRepScope.push({ id: 'ars1', adminId: 'a2', salesRepId: 'R1' });
  T.adminCustomerScope.push({ id: 'acs1', adminId: 'a2', customerId: 'C1' });
  const prod = (id: string, name: string, tracked: boolean, shelf: boolean, extra: Row = {}) => ({
    id, tenantId: 'T1', code: id, name, unit: 'حبة', lotTracked: tracked, lotTrackedSince: tracked ? D('2026-01-01') : null,
    shelfLifeEnabled: shelf, shelfLifeValue: shelf ? 6 : null, shelfLifeUnit: shelf ? 'MONTH' : null, categoryId: null, deletedAt: null,
    createdAt: D('2025-12-01'), updatedAt: D('2025-12-01'), ...extra,
  });
  T.product.push(prod('P1', 'حليب', true, true, { categoryId: 'CAT1' }), prod('P2', 'شاي', false, false, { categoryId: 'CAT1' }), prod('P3', 'قهوة', true, false),
    prod('P9', 'منتج شركة أخرى', true, false, { tenantId: 'T2' }));
  T.productLot.push(
    lotRow('L1', 'P1', 'A100', '2099-01-31'), lotRow('L2', 'P1', 'B200', '2099-06-30'), lotRow('LX', 'P1', 'X900', '2020-01-01'),
    lotRow('LB', 'P1', 'H500', '2099-12-31', { status: 'BLOCKED', blockKind: 'HOLD', blockReason: 'اشتباه', blockedAt: D('2026-01-25') }),
    lotRow('L9', 'P9', 'Z1', null, { tenantId: 'T2' }),
  );
  T.lotEvent.push({ id: 'EV0', tenantId: 'T1', lotId: 'L1', productId: 'P1', kind: 'CREATE', before: null, after: { lotNumber: 'A100' }, reason: null, actorType: 'ADMIN', actorId: 'a1', actorName: 'مدير', createdAt: D('2026-01-20') });

  addWh('2026-02-01', 'RECEIVE', [
    { pid: 'P1', qty: 100, lotId: 'L1' }, { pid: 'P1', qty: 50, lotId: 'L2' }, { pid: 'P1', qty: 10, lotId: 'LX' }, { pid: 'P1', qty: 10, lotId: 'LB' },
    { pid: 'P1', qty: 30 }, { pid: 'P2', qty: 7 }, { pid: 'P3', qty: 3, unitFactor: 24, baseQty: 72 },
  ]);
  addLoad('2026-02-02', 'LOAD', 'R1', [{ pid: 'P1', qty: 40, lots: [{ lotId: 'L1', qty: 30 }, { lotId: 'L2', qty: 10 }] }]);
  addLoad('2026-02-02', 'LOAD', 'R2', [{ pid: 'P1', qty: 20, lots: [{ lotId: 'L1', qty: 20 }] }]);
  // الوحدات: سطرٌ بكرتون (لقطة baseQty مخزَّنة) وسطرٌ بحبّة (baseQty فارغ يُحسب من اللقطة) للصنف نفسه
  addLoad('2026-02-02', 'LOAD', 'R1', [
    { pid: 'P3', qty: 2, unitFactor: 24, baseQty: 48, lots: [{ lotId: null, qty: 48 }] },
    { pid: 'P3', qty: 5, unitFactor: 1, lots: [{ lotId: null, qty: 5 }] },
  ]);
  addInv('S1', '2026-02-03', 'R1', 'C1', 'CASH', [{ pid: 'P1', qty: 12, lots: [{ id: 'S1-L1', lotId: 'L1', qty: 12 }] }]);
  addInv('S6', '2026-02-03', 'R2', 'C1', 'CASH', [{ pid: 'P1', qty: 20, lots: [{ lotId: 'L1', qty: 20 }] }]);
  addInv('S3', '2026-02-03', 'R1', 'C2', 'CASH', [
    { pid: 'P3', qty: 1, unitFactor: 24, lots: [{ lotId: null, qty: 24 }] }, { pid: 'P3', qty: 3, unitFactor: 1, lots: [{ lotId: null, qty: 3 }] },
  ]);
  addInv('S10', '2026-02-03', 'R1', 'C1', 'CASH', [{ pid: 'P2', qty: 2 }]);
  addInv('RT1', '2026-02-04', 'R1', 'C1', 'RETURN', [{ pid: 'P1', qty: 12, lots: [{ lotId: 'L1', qty: 12, src: 'S1-L1' }] }]);
  addInv('S2', '2026-02-05', 'R1', 'C2', 'CREDIT', [{ pid: 'P1', qty: 5, lots: [{ lotId: 'L1', qty: 5, certainty: 'ASSUMED', flags: 'REPLAY_CLAMPED' }] }]);
  addLoad('2026-02-05', 'LOAD', 'RX', [{ pid: 'P1', qty: 5, lots: [{ lotId: 'L2', qty: 5 }] }], { deleted: true });
  addInv('S9', '2026-02-05', 'R2', 'C1', 'CASH', [{ pid: 'P3', qty: 5, lots: [{ lotId: null, qty: 5 }] }]);
  addInv('S5', '2026-02-06', 'R1', 'C2', 'CASH', [{ pid: 'P1', qty: 3, lots: [{ id: 'S5-L2', lotId: 'L2', qty: 3 }] }]);
  addInv('RT2', '2026-02-07', 'R1', 'C2', 'RETURN', [{ pid: 'P1', qty: 2, lots: [{ lotId: 'L2', qty: 2, src: 'S5-L2' }] }], { held: true });
  addLoad('2026-02-10', 'LOAD', 'R2', [{ pid: 'P1', qty: 10, lots: [{ lotId: 'L2', qty: 10 }] }]);
  addInv('S7', '2026-02-11', 'R2', 'C2', 'CASH', [{ pid: 'P1', qty: 4, lots: [{ lotId: 'L2', qty: 4 }] }]);
}

const qlog = () => log.filter((e) => e.kind !== 'model');
const firstIdx = (pred: (e: LogEntry) => boolean) => log.findIndex(pred);
const bal = (s: number, e = 0, d = 0) => ({ SELLABLE: s, EXPIRED: e, DAMAGED: d });
const eventsOf = (lotId: string | null, kind?: string) => T.lotEvent.filter((e) => e.lotId === lotId && (!kind || e.kind === kind));

// ═══ الحرّاس والترتيب ═══

test('الحرّاس بالترتيب: المصادقة، ثم رفض المندوب، ثم requireLots، ثم canManageVanStock — والمسارات الثابتة قبل /:id', async () => {
  const stack = (lotsRouter as unknown as { stack: { route?: { path: string; methods: Row }; handle: unknown }[] }).stack;
  assert.equal(stack[0].handle, fakeAuth, 'authenticate أولاً');
  assert.equal(stack[0].route, undefined);
  assert.equal(stack[2].handle, realAuth.requireLots, 'requireLots بعد رفض المندوب');
  assert.ok(!stack[1].route && !stack[3].route, 'رفض المندوب وcanManageVanStock وسيطان على الموجّه');
  const routes = stack.filter((l) => l.route).map((l) => `${Object.keys(l.route!.methods)[0].toUpperCase()} ${l.route!.path}`);
  const firstParam = routes.findIndex((r) => r.includes('/:id'));
  assert.ok(firstParam > 0);
  for (const r of routes.slice(firstParam)) assert.match(r, /\/:id/, `${r} بعد أول مسار بمعامل`);
  for (const r of ['GET /balances', 'GET /fefo', 'GET /health', 'POST /relabel', 'POST /products/tracking', 'PUT /settings']) {
    assert.ok(routes.indexOf(r) >= 0 && routes.indexOf(r) < firstParam, `${r} قبل /:id`);
  }

  world();
  // المندوب يُرفض قبل قراءة العَلَم: لا استعلام شركة
  let r = await call('GET', '/api/lots/health', { user: REP });
  assert.deepEqual([r.status, r.body.message], [403, 'غير مسموح']);
  assert.ok(!log.some((e) => e.text === 'tenant.findUnique'), 'المندوب يُرفض قبل requireLots');
  r = await call('GET', '/api/lots/health', { user: null });
  assert.equal(r.status, 401);
  // العَلَم المطفأ، ثم المحاسبة المطفأة قبله
  T.tenant[0].lotTrackingEnabled = false;
  r = await call('GET', '/api/lots/L1');
  assert.deepEqual([r.status, r.body.code], [403, 'LOTS_NOT_ALLOWED']);
  T.tenant[0].accountingEnabled = false;
  r = await call('GET', '/api/lots/L1');
  assert.deepEqual([r.status, r.body.code], [403, 'ACCOUNTING_NOT_ALLOWED']);
  world();
  // بلا «إدارة مخزون السيارات»: ممنوع قبل أي مسار
  r = await call('GET', '/api/lots', { user: { ...ADMIN, id: 'a4', role: 'MANAGER' } });
  assert.equal(r.status, 403);
  assert.ok(!log.some((e) => e.text === 'productLot.findMany'));
  // /health ثابتٌ لا يلتقطه /:id، والمفتاح يمرّ بهوية مُصدِره
  r = await call('GET', '/api/lots/health', { user: KEY });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.deficits));
  // اللوط في المسار من شركةٍ أخرى: 404 LOT_NOT_FOUND
  r = await call('GET', '/api/lots/L9');
  assert.deepEqual([r.status, r.body.code], [404, 'LOT_NOT_FOUND']);
});

// ═══ بطاقة اللوط (§٤.٣) ═══

test('POST /lots: الرقم مطبَّع، والانتهاء إلزامي مع الصلاحية، والقائم 409 LOT_NUMBER_TAKEN بمعرّفه، وLotEvent CREATE تحت قفل الصنف', async () => {
  world();
  let r = await call('POST', '/api/lots', { body: { productId: 'P1', lotNumber: ' c-٧٧ ' } });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_EXPIRY_REQUIRED']);
  r = await call('POST', '/api/lots', { body: { productId: 'P1', lotNumber: 'c-77', productionDate: '2026-12-01', expiryDate: '2026-11-01' } });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_DATES_INVALID']);
  log = []; txOpts = [];
  r = await call('POST', '/api/lots', { body: { productId: 'P1', lotNumber: ' c-٧٧ ', expiryDate: '2099-03-01', note: ' أول ' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.lotNumber, 'C-77');
  assert.deepEqual([r.body.data.expiryDate, r.body.data.status, r.body.data.source, r.body.data.note], ['2099-03-01', 'ACTIVE', 'MANUAL', 'أول']);
  assert.deepEqual(txOpts, [{ maxWait: 10_000, timeout: 20_000 }], 'D13');
  const lockAt = firstIdx((e) => e.text.includes('pg_advisory_xact_lock') && e.inTx);
  assert.ok(lockAt >= 0 && lockAt < firstIdx((e) => e.text === 'productLot.createMany'), 'القفل قبل الإنشاء');
  assert.equal(log[lockAt].values[0], lotLockKey('T1', 'P1'));
  const created = T.productLot.find((l) => l.lotNumber === 'C-77')!;
  assert.deepEqual(eventsOf(created.id, 'CREATE').map((e) => [e.actorType, e.actorId, e.after.source]), [['ADMIN', 'a1', 'MANUAL']]);
  r = await call('POST', '/api/lots', { body: { productId: 'P1', lotNumber: 'C-77', expiryDate: '2099-03-01' } });
  assert.deepEqual([r.status, r.body.code, r.body.detail.id], [409, 'LOT_NUMBER_TAKEN', created.id]);
  // صنف شركةٍ أخرى: 404 لا إنشاء
  r = await call('POST', '/api/lots', { body: { productId: 'P9', lotNumber: 'Q', expiryDate: '2099-03-01' } });
  assert.equal(r.status, 404);
  // صنفٌ بلا صلاحية: الانتهاء اختياري؛ والمفتاح يُسجَّل API_KEY
  r = await call('POST', '/api/lots', { user: KEY, body: { productId: 'P3', lotNumber: 'k1' } });
  assert.equal(r.status, 201);
  assert.equal(eventsOf(r.body.data.id, 'CREATE')[0].actorType, 'API_KEY');
});

test('PATCH /lots/:id: LOT_CHANGED على نسخةٍ قديمة، ومدّ الانتهاء لما له حركات لغير المقيّد وبسبب (D27)، والتقصير حرّ، وUPDATE_DATES بقبل وبعد', async () => {
  world();
  const v = () => (T.productLot.find((l) => l.id === 'L1')!.updatedAt as Date).toISOString();
  let r = await call('PATCH', '/api/lots/L1', { body: { expiryDate: '2099-12-31', updatedAt: '2026-01-01T00:00:00.000Z' } });
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_CHANGED']);
  r = await call('PATCH', '/api/lots/L1', { user: SCOPED, body: { expiryDate: '2099-12-31', reason: 'تمديد المصنع', updatedAt: v() } });
  assert.deepEqual([r.status, r.body.code], [403, 'LOT_SCOPED_USER']);
  r = await call('PATCH', '/api/lots/L1', { body: { expiryDate: null, updatedAt: v() } });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_EXPIRY_REQUIRED'], 'محو الانتهاء ممنوع مع الصلاحية');
  r = await call('PATCH', '/api/lots/L1', { body: { expiryDate: '2099-12-31', updatedAt: v() } });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_REASON_REQUIRED']);
  assert.equal(eventsOf('L1', 'UPDATE_DATES').length, 0, 'لا حدث لتعديلٍ مرفوض');
  r = await call('PATCH', '/api/lots/L1', { body: { expiryDate: '2099-12-31', reason: 'تمديد المصنع', updatedAt: v() } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.expiryDate, '2099-12-31');
  const ev = eventsOf('L1', 'UPDATE_DATES');
  assert.deepEqual(ev.map((e) => [e.before.expiryDate, e.after.expiryDate, e.reason]), [['2099-01-31', '2099-12-31', 'تمديد المصنع']]);
  // التقصير حرٌّ للمقيّد بلا سبب
  r = await call('PATCH', '/api/lots/L1', { user: SCOPED, body: { expiryDate: '2099-02-01', updatedAt: v() } });
  assert.equal(r.status, 200);
  // لوطٌ بلا حركات: المدّ حرّ؛ والملاحظة وحدها UPDATE_NOTE
  T.productLot.push(lotRow('LN', 'P1', 'N1', '2099-01-01'));
  r = await call('PATCH', '/api/lots/LN', { user: SCOPED, body: { expiryDate: '2099-09-09', updatedAt: D('2026-01-20').toISOString() } });
  assert.equal(r.status, 200);
  r = await call('PATCH', '/api/lots/LN', { body: { note: 'رف ٣', updatedAt: r.body.data.updatedAt } });
  assert.equal(r.status, 200);
  assert.deepEqual(eventsOf('LN').map((e) => e.kind), ['UPDATE_DATES', 'UPDATE_NOTE']);
  // لقطات انتهاء صفوف الفواتير لا تُمسّ
  assert.ok(T.invoiceItemLot.every((x) => x.expiryDate === null));
});

test('PATCH /lots/:id/status: لغير المقيّد وبسببٍ إلزامي في الاتجاهين، والتصعيد إلى سحبٍ يُبقي لحظة الإيقاف، وBLOCK/UNBLOCK', async () => {
  world();
  const v = (id: string) => (T.productLot.find((l) => l.id === id)!.updatedAt as Date).toISOString();
  let r = await call('PATCH', '/api/lots/L1/status', { user: SCOPED, body: { status: 'BLOCKED', blockKind: 'HOLD', reason: 'شكوى', updatedAt: v('L1') } });
  assert.deepEqual([r.status, r.body.code], [403, 'LOT_SCOPED_USER']);
  r = await call('PATCH', '/api/lots/L1/status', { body: { status: 'BLOCKED', blockKind: 'HOLD', reason: '  ', updatedAt: v('L1') } });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_REASON_REQUIRED']);
  r = await call('PATCH', '/api/lots/L1/status', { body: { status: 'BLOCKED', blockKind: 'HOLD', reason: 'شكوى', updatedAt: v('L1') } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const blockedAt = r.body.data.blockedAt;
  assert.deepEqual([r.body.data.status, r.body.data.blockKind, r.body.data.blockReason, r.body.data.blockedBy], ['BLOCKED', 'HOLD', 'شكوى', 'a1']);
  r = await call('PATCH', '/api/lots/L1/status', { body: { status: 'BLOCKED', blockKind: 'RECALL', reason: 'قرار الهيئة', updatedAt: r.body.data.updatedAt } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.data.blockKind, r.body.data.blockedAt], ['RECALL', blockedAt], 'طبقة الإعادة ١ تعدّ الموقوف بعد لحظة الإيقاف الأولى');
  r = await call('PATCH', '/api/lots/L1/status', { body: { status: 'ACTIVE', updatedAt: r.body.data.updatedAt } });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_REASON_REQUIRED'], 'إعادة الموقوف إلى نشط بسبب (D27)');
  r = await call('PATCH', '/api/lots/L1/status', { body: { status: 'ACTIVE', reason: 'نتيجة الفحص سليمة', updatedAt: v('L1') } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.data.status, r.body.data.blockKind, r.body.data.blockedAt], ['ACTIVE', null, null]);
  assert.deepEqual(eventsOf('L1').filter((e) => e.kind !== 'CREATE').map((e) => [e.kind, e.after.blockKind, e.reason]),
    [['BLOCK', 'HOLD', 'شكوى'], ['BLOCK', 'RECALL', 'قرار الهيئة'], ['UNBLOCK', null, 'نتيجة الفحص سليمة']]);
  r = await call('PATCH', '/api/lots/L1/status', { body: { status: 'BLOCKED', reason: 'x', updatedAt: '2020-01-01T00:00:00.000Z' } });
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_CHANGED']);
});

test('DELETE /lots/:id: ما له مرجعٌ 409 LOT_IN_USE، وما لا مرجع له يُحذف تحت القفل ويبقى سجلّه (DELETE) مقروءاً', async () => {
  world();
  let r = await call('DELETE', '/api/lots/L1');
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_IN_USE']);
  assert.ok(T.productLot.some((l) => l.id === 'L1'));
  // الفحص قبل الحذف تحت القفل — لا يُترك لمفتاح القاعدة الأجنبي (NoAction) يُجهض المعاملة
  assert.ok(!log.some((e) => e.text === 'productLot.delete'), 'لا محاولة حذفٍ للوطٍ له مراجع');
  T.productLot.push(lotRow('LN', 'P1', 'N1', '2099-01-01'));
  T.lotRelabel.push({ id: 'RL', tenantId: 'T1', productId: 'P1', place: 'WAREHOUSE', vanKey: null, bucket: 'SELLABLE', fromLotId: null, toLotId: 'LN', qty: 1, reason: 'LABEL_EXISTING', note: null, createdBy: null, createdAt: D('2026-02-01') });
  r = await call('DELETE', '/api/lots/LN');
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_IN_USE'], 'التسمية مرجعٌ أيضاً');
  T.lotRelabel = [];
  log = [];
  r = await call('DELETE', '/api/lots/LN');
  assert.equal(r.status, 200);
  assert.ok(!T.productLot.some((l) => l.id === 'LN'));
  assert.ok(firstIdx((e) => e.text.includes('FOR KEY SHARE')) < firstIdx((e) => e.text === 'productLot.delete'));
  assert.deepEqual(eventsOf('LN').map((e) => [e.kind, e.before.lotNumber]), [['DELETE', 'N1']]);
  r = await call('GET', '/api/lots/LN/events');
  assert.deepEqual([r.status, r.body.data.map((e: Row) => e.kind)], [200, ['DELETE']]);
  r = await call('GET', '/api/lots/LN');
  assert.deepEqual([r.status, r.body.code], [404, 'LOT_NOT_FOUND']);
});

// ═══ التسمية وإعادة التصنيف (§٤.٦) — منع السالب ═══

const relabel = (body: Row, user: User = ADMIN) => call('POST', '/api/lots/relabel', { user, body });
const vanView = async (pid: string, rep: string) => {
  const r = await call('GET', `/api/lots/balances?productId=${pid}`);
  return r.body.data.vans.find((v: Row) => v.salesRepId === rep)?.view;
};

test('التسمية: قفل الصنف أولاً، ثم I1 على صالح اللوط (والمحجوز D24 خارجه) بعد جمع الأسطر، ثم الوجهة وLotEvent RELABEL لطرفيها', async () => {
  world();
  log = [];
  // L1 في R1: صالحه ٢٥ — سطران مجموعهما ٢٦ يُرفضان معاً (D26)
  let r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'R1', fromLotId: 'L1', reason: 'RECLASSIFY', lines: [{ toLotId: 'L2', qty: 13 }, { lotNumber: 'n-1', expiryDate: '2099-05-05', qty: 13 }] });
  assert.deepEqual([r.status, r.body.code, r.body.detail.lotId, r.body.detail.usable, r.body.detail.reason], [409, 'LOT_STOCK_INSUFFICIENT', 'L1', 25, 'RELABEL']);
  assert.equal(T.lotRelabel.length, 0);
  assert.ok(!T.productLot.some((l) => l.lotNumber === 'N-1'), 'لا لوط يُنشأ لتسميةٍ مرفوضة');
  const keyShare = firstIdx((e) => e.text.includes('FOR KEY SHARE'));
  assert.ok(keyShare >= 0 && keyShare < firstIdx((e) => e.text.includes('FROM van_load_item_lots')), 'القفل قبل أول قراءة رصيد');
  assert.ok(firstIdx((e) => e.text.includes('pg_advisory_xact_lock')) < firstIdx((e) => e.text.includes('FROM invoice_item_lots')));
  log = [];
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'R1', fromLotId: 'L1', reason: 'RECLASSIFY', note: ' فرز ', lines: [{ toLotId: 'L2', qty: 12 }, { lotNumber: 'n-1', expiryDate: '2099-05-05', qty: 13 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { rows: 2, warnings: [] });
  assert.ok(firstIdx((e) => e.text.includes('pg_advisory_xact_lock')) < firstIdx((e) => e.text === 'lotRelabel.create'));
  const n1 = T.productLot.find((l) => l.lotNumber === 'N-1')!;
  assert.deepEqual([n1.source, n1.createdBy], ['RELABEL', 'a1']);
  assert.deepEqual(T.lotRelabel.map((x) => [x.place, x.vanKey, x.bucket, x.fromLotId, x.toLotId, x.qty, x.reason, x.note]),
    [['VAN', 'R1', 'SELLABLE', 'L1', 'L2', 12, 'RECLASSIFY', 'فرز'], ['VAN', 'R1', 'SELLABLE', 'L1', n1.id, 13, 'RECLASSIFY', 'فرز']]);
  assert.equal(eventsOf('L1', 'RELABEL').length, 2);
  assert.equal(eventsOf('L2', 'RELABEL').length, 1);
  assert.deepEqual(eventsOf(n1.id).map((e) => e.kind), ['CREATE', 'RELABEL']);
  // رصيد الصنف لا يتغيّر (R9)، واللوطات تنتقل
  const view = await vanView('P1', 'R1');
  assert.deepEqual(view.total, bal(34));
  assert.deepEqual(view.lots.map((l: Row) => [l.meta.lotNumber, l.raw.SELLABLE, l.usable.SELLABLE]), [['A100', 0, 0], ['N-1', 13, 13], ['B200', 21, 19]], 'بترتيب FEFO');
  assert.deepEqual(view.unknown, bal(0));
  // L1 صار صفراً: أي كسرٍ آخر يُرفض (I1)
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'R1', fromLotId: 'L1', reason: 'RECLASSIFY', lines: [{ toLotId: 'L2', qty: 0.0001 }] });
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_STOCK_INSUFFICIENT']);
  // L2 في R1: خامه ٢١ ومحجوزه ٢ (مرتجع إشعار قياسي بانتظار الاعتماد) ⇒ صالحه ١٩ لا ٢١
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'R1', fromLotId: 'L2', reason: 'RECLASSIFY', lines: [{ toLotId: n1.id, qty: 20 }] });
  assert.deepEqual([r.status, r.body.code, r.body.detail.usable], [409, 'LOT_STOCK_INSUFFICIENT', 19]);
});

test('التسمية من غير المسمّى: I2 — لا يُنقص دون min(0, قبله)، والسالب التاريخي لا يُسمّى منه، والسيارة المحذوفة مجهولٌ غير مسمّاها', async () => {
  world();
  // المستودع P1: غير المسمّى ٣٠
  let r = await relabel({ productId: 'P1', place: 'WAREHOUSE', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ lotNumber: 'w-1', expiryDate: '2099-02-02', qty: 30.0001 }] });
  assert.deepEqual([r.status, r.body.code, r.body.detail.lotId, r.body.detail.usable], [409, 'LOT_STOCK_INSUFFICIENT', null, 30]);
  r = await relabel({ productId: 'P1', place: 'WAREHOUSE', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ lotNumber: 'w-1', expiryDate: '2099-02-02', qty: 30 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await relabel({ productId: 'P1', place: 'WAREHOUSE', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ toLotId: 'L1', qty: 0.5 }] });
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_STOCK_INSUFFICIENT']);
  // R2 P3: بيعٌ بلا مخزون ⇒ غير المسمّى −٥ ⇒ لا تسمية منه أبداً
  r = await relabel({ productId: 'P3', place: 'VAN', vanKey: 'R2', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ lotNumber: 'q-1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code, r.body.detail.usable], [409, 'LOT_STOCK_INSUFFICIENT', -5]);
  // R1 P1: كله مسمّى ⇒ غير المسمّى صفر
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'R1', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ toLotId: 'L1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_STOCK_INSUFFICIENT']);
  // RX (مندوبٌ محذوف): رصيد صنفها مجهول ⇒ غير المسمّى لا يُسمّى منه، والمسمّى بحدّ صالحه (لغير المقيّد وحده)
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'RX', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ toLotId: 'L1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code, r.body.detail.usable], [409, 'LOT_STOCK_INSUFFICIENT', null]);
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'RX', fromLotId: 'L2', reason: 'RECLASSIFY', lines: [{ toLotId: 'L1', qty: 5.0001 }] });
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_STOCK_INSUFFICIENT']);
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'RX', fromLotId: 'L2', reason: 'RECLASSIFY', lines: [{ toLotId: 'L1', qty: 5 }] });
  assert.equal(r.status, 201);
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'RX', fromLotId: 'L1', reason: 'RECLASSIFY', lines: [{ toLotId: 'L2', qty: 1 }] }, SCOPED);
  assert.equal(r.status, 404, 'المقيّد لا يبلغ سيارة محذوف');
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'R2', fromLotId: 'L2', reason: 'RECLASSIFY', lines: [{ toLotId: 'L1', qty: 1 }] }, SCOPED);
  assert.equal(r.status, 404, 'ولا سيارة خارج نطاقه');
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'R9', fromLotId: 'L2', reason: 'RECLASSIFY', lines: [{ toLotId: 'L1', qty: 1 }] });
  assert.equal(r.status, 404, 'مندوب شركةٍ أخرى');
  // كل ما سبق من المرفوض لم يكتب شيئاً
  assert.equal(T.lotRelabel.length, 2);
});

test('الوحدات: سطرٌ بكرتون وسطرٌ بحبّة للصنف نفسه — غير المسمّى بالأساس في السيارة والمستودع (BASE_QTY_SQL)، والتسمية بحدّه', async () => {
  world();
  // R1 P3: كرتونان (٤٨ مخزَّنة) + ٥ حبات (baseQty فارغ) − كرتون (٢٤ من اللقطة) − ٣ = ٢٦
  const v = await vanView('P3', 'R1');
  assert.deepEqual([v.total, v.unknown, v.unknownUsable, v.lots], [bal(26), bal(26), bal(26), []]);
  const w = (await call('GET', '/api/lots/balances?productId=P3')).body.data.warehouse[0];
  assert.deepEqual([w.total, w.unknown], [bal(19), bal(19)], 'المستودع: ٣ كراتين (٧٢) − ٥٣ حبة');
  let r = await relabel({ productId: 'P3', place: 'VAN', vanKey: 'R1', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ lotNumber: 'q1', qty: 24 }, { lotNumber: 'q1', qty: 2.0001 }] });
  assert.deepEqual([r.status, r.body.code, r.body.detail.wanted, r.body.detail.usable], [409, 'LOT_STOCK_INSUFFICIENT', 26.0001, 26]);
  r = await relabel({ productId: 'P3', place: 'VAN', vanKey: 'R1', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ lotNumber: 'q1', qty: 24 }, { lotNumber: 'Q1', qty: 2 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const after = await vanView('P3', 'R1');
  assert.deepEqual([after.total, after.unknown, after.lots.map((l: Row) => [l.meta.lotNumber, l.raw.SELLABLE])], [bal(26), bal(0), [['Q1', 26]]]);
  // أربع خانات وحدها (isLotQty)
  r = await relabel({ productId: 'P3', place: 'WAREHOUSE', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ lotNumber: 'q2', qty: 1.00005 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_QTY_INVALID']);
});

test('D27 والقيود: لا تسمية ولا تصحيح من موقوف أو منتهٍ، والتصحيح إلى غير المسمّى بـCORRECTION وملاحظة ولغير المقيّد، والطرفان', async () => {
  world();
  const base = { productId: 'P1', place: 'WAREHOUSE', reason: 'RECLASSIFY' };
  let r = await relabel({ ...base, fromLotId: 'LB', lines: [{ toLotId: 'L1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_BLOCKED']);
  r = await relabel({ ...base, fromLotId: 'LB', reason: 'CORRECTION', note: 'إخفاء', lines: [{ toLotId: null, qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_BLOCKED'], 'لا غسيل للموقوف في غير المسمّى');
  r = await relabel({ ...base, fromLotId: 'LX', lines: [{ toLotId: 'L1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_EXPIRED']);
  r = await relabel({ ...base, fromLotId: 'L1', lines: [{ toLotId: null, qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_RELABEL_INVALID'], 'إلى غير المسمّى بلا CORRECTION');
  r = await relabel({ ...base, fromLotId: 'L1', reason: 'CORRECTION', lines: [{ toLotId: null, qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_REASON_REQUIRED'], 'التصحيح بملاحظة');
  r = await relabel({ ...base, fromLotId: 'L1', reason: 'CORRECTION', note: 'خطأ إدخال', lines: [{ toLotId: null, qty: 1 }] }, SCOPED);
  assert.deepEqual([r.status, r.body.code], [403, 'LOT_SCOPED_USER']);
  r = await relabel({ ...base, fromLotId: null, lines: [{ toLotId: null, qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_RELABEL_INVALID'], 'بلا طرفين');
  r = await relabel({ ...base, fromLotId: 'L1', lines: [{ toLotId: 'L1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_RELABEL_INVALID'], 'من التشغيلة إليها');
  r = await relabel({ ...base, fromLotId: 'L1', lines: [{ lotNumber: ' a١٠٠ ', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_RELABEL_INVALID'], 'رقمٌ يُطبَّع إلى المصدر نفسه');
  r = await relabel({ ...base, fromLotId: 'L1', lines: [{ lotNumber: 'B200', expiryDate: '2099-01-01', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_DATES_MISMATCH']);
  r = await relabel({ ...base, fromLotId: 'L1', lines: [{ lotNumber: 'NEW-1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_EXPIRY_REQUIRED'], 'الجديد بانتهاءٍ مع الصلاحية');
  r = await relabel({ ...base, productId: 'P2', fromLotId: null, lines: [{ lotNumber: 'T1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_RELABEL_INVALID'], 'صنفٌ غير متتبَّع: تسميته قبل الحقبة بلا أثر');
  r = await relabel({ ...base, place: 'WAREHOUSE', bucket: 'EXPIRED', fromLotId: 'L1', lines: [{ toLotId: 'L2', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_RELABEL_INVALID'], 'المستودع دلوٌ واحد');
  assert.equal(T.lotRelabel.length, 0);
  // التصحيح الصحيح: من L1 إلى غير المسمّى، والوجهة الموقوفة تُقبل بتحذير
  r = await relabel({ ...base, fromLotId: 'L1', reason: 'CORRECTION', note: 'خطأ إدخال', lines: [{ toLotId: null, qty: 2 }, { toLotId: 'LB', qty: 1 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.warnings.map((w: Row) => [w.code, w.detail.lotId]), [['LOT_INTO_BLOCKED', 'LB']]);
  const w = (await call('GET', '/api/lots/balances?productId=P1')).body.data.warehouse[0];
  assert.deepEqual([w.unknown.SELLABLE, w.lots.find((l: Row) => l.lotId === 'L1').raw.SELLABLE, w.lots.find((l: Row) => l.lotId === 'LB').raw.SELLABLE], [32, 47, 11]);
  // وفي المستودع المطفأ لا تسمية
  T.tenant[0].warehouseEnabled = false;
  r = await relabel({ ...base, fromLotId: 'L1', lines: [{ toLotId: 'L2', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_RELABEL_INVALID']);
});

test('التسمية من غير المسمّى المحجوز (D24): مرتجع إشعارٍ قياسي بلا صفوف لوط داخلٌ في غير المسمّى وخارجٌ عن صالحه — لا يُسمّى', async () => {
  world();
  // R2 P1: L2 ٦ مسمّاة. مرتجع إشعار قياسي «01» بانتظار الاعتماد (٣، بلا صفوف: كُتب قبل تتبّع صنفه) ومرتجعٌ حرّ عادي (٢، بلا صفوف)
  addInv('RT8', '2026-02-12', 'R2', 'C1', 'RETURN', [{ pid: 'P1', qty: 3 }], { held: true });
  addInv('RT9', '2026-02-12', 'R2', 'C1', 'RETURN', [{ pid: 'P1', qty: 2 }]);
  const v = await vanView('P1', 'R2');
  assert.deepEqual([v.total, v.unknown, v.unknownUsable, v.availability.held, v.availability.availableUnknown], [bal(11), bal(5), bal(2), 3, 2]);
  // صالح غير المسمّى ٢ وحده: إبطال المحجوز لاحقاً يُنقص غير المسمّى ومحجوزه معاً — لو سُمّي منه لصار سالباً (I2)
  let r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'R2', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ toLotId: 'L2', qty: 2.0001 }] });
  assert.deepEqual([r.status, r.body.code, r.body.detail.usable, r.body.detail.reason], [409, 'LOT_STOCK_INSUFFICIENT', 2, 'RELABEL']);
  r = await relabel({ productId: 'P1', place: 'VAN', vanKey: 'R2', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ toLotId: 'L2', qty: 1 }, { toLotId: 'L1', qty: 1 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // ثم الإبطال (مرآة المرتجع تُسحب ثم الإلغاء بالتغيير): غير المسمّى ٥ − ٢ مسمّاة − ٣ مُبطلة = صفر، لا سالب
  T.invoice.find((i) => i.id === 'RT8')!.status = 'CANCELLED';
  const after = await vanView('P1', 'R2');
  assert.deepEqual([after.total, after.unknown, after.unknownUsable, after.deficits], [bal(8), bal(0), bal(0), []]);
});

test('التسمية في دلوي المنتهي والتالف بالسيارة: من غير المسمّى بحدّ صالحه في الدلو نفسه، ولا من لوطٍ منتهٍ (D27)', async () => {
  world();
  // R1 P1: مرتجعٌ منتهٍ ٤ (returnExpired) ومرتجعٌ تالف ٢ (بعد DAMAGED_VAN_SINCE) — بلا صفوف لوط: غير مسمّى في دلويهما
  addInv('RT6', '2026-10-20', 'R1', 'C1', 'RETURN', [{ pid: 'P1', qty: 4, returnExpired: true }]);
  addInv('RT7', '2026-10-20', 'R1', 'C1', 'RETURN', [{ pid: 'P1', qty: 2 }], { returnToStock: false });
  T.invoice.find((i) => i.id === 'RT7')!.returnReason = 'DAMAGED';
  const v = await vanView('P1', 'R1');
  assert.deepEqual([v.total, v.unknown], [bal(34, 4, 2), bal(0, 4, 2)]);
  const base = { productId: 'P1', place: 'VAN', vanKey: 'R1', fromLotId: null, reason: 'LABEL_EXISTING' };
  let r = await relabel({ ...base, bucket: 'EXPIRED', lines: [{ toLotId: 'LX', qty: 4.0001 }] });
  assert.deepEqual([r.status, r.body.code, r.body.detail.bucket, r.body.detail.usable], [409, 'LOT_STOCK_INSUFFICIENT', 'EXPIRED', 4]);
  r = await relabel({ ...base, bucket: 'EXPIRED', lines: [{ toLotId: 'LX', qty: 4 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // SELLABLE في R1 كله مسمّى: الدلو الآخر لا يُستعار منه
  r = await relabel({ ...base, bucket: 'SELLABLE', lines: [{ toLotId: 'L1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_STOCK_INSUFFICIENT']);
  r = await relabel({ ...base, bucket: 'DAMAGED', lines: [{ toLotId: 'L2', qty: 2 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await relabel({ ...base, bucket: 'DAMAGED', lines: [{ toLotId: 'L2', qty: 0.0001 }] });
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_STOCK_INSUFFICIENT']);
  // المنتهي لا يخرج بتسميته (D27): خروجه بالتنزيل أو الإزالة وحدهما
  r = await relabel({ ...base, bucket: 'EXPIRED', fromLotId: 'LX', reason: 'RECLASSIFY', lines: [{ toLotId: 'L1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_EXPIRED']);
  const after = await vanView('P1', 'R1');
  assert.deepEqual([after.total, after.unknown, after.deficits], [bal(34, 4, 2), bal(0, 0, 0), []]);
  assert.deepEqual(after.lots.filter((l: Row) => l.raw.EXPIRED || l.raw.DAMAGED).map((l: Row) => [l.lotId, l.raw]), [['LX', bal(0, 4, 0)], ['L2', bal(9, 0, 2)]]);
});

test('مدخلاتٌ شاذّة: رقم تشغيلةٍ أطول من الحدّ 400/422 لا «حدّد التشغيلة»، وخطأ التحقق بنصّ «lock timeout» 400 لا 503', async () => {
  world();
  const long = 'X'.repeat(65);
  let r = await call('POST', '/api/lots', { body: { productId: 'P3', lotNumber: long } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /64/);
  r = await relabel({ productId: 'P1', place: 'WAREHOUSE', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ lotNumber: long, expiryDate: '2099-01-01', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_RELABEL_INVALID']);
  r = await relabel({ productId: 'P1', place: 'lock timeout', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ toLotId: 'L1', qty: 1 }] });
  assert.equal(r.status, 400);
  assert.equal(T.lotRelabel.length, 0);
  assert.ok(!T.productLot.some((l) => l.lotNumber.length > 64));
});

test('الانشغال: مهلة قفل اللوط (55P03) ⇒ 503 LOT_BUSY، ولا كتابة (المعاملة تتراجع)', async () => {
  world();
  rawHook = (e) => {
    if (e.text.includes('pg_advisory_xact_lock')) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } });
  };
  let r = await relabel({ productId: 'P1', place: 'WAREHOUSE', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ toLotId: 'L1', qty: 1 }] });
  assert.deepEqual([r.status, r.body.code], [503, 'LOT_BUSY']);
  r = await call('PATCH', '/api/lots/L1/status', { body: { status: 'BLOCKED', reason: 'x', updatedAt: (T.productLot[0].updatedAt as Date).toISOString() } });
  assert.deepEqual([r.status, r.body.code], [503, 'LOT_BUSY']);
  assert.equal(T.lotRelabel.length, 0);
  assert.equal(T.productLot[0].status, 'ACTIVE');
  assert.equal(T.lotEvent.length, 1);
});

// ═══ التتبّع (§٤.١٧) ═══

test('التتبّع STRICT: المصدر والأماكن ومجاميعها، وكل من بيع له وإن كان صافيه صفراً، بأضعف يقين ووسومه، والسجلّ', async () => {
  world();
  const r = await call('GET', '/api/lots/L1/trace');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.deepEqual([d.lot.lotNumber, d.lot.productName, d.lot.expiryDate, d.scope, d.scoped, d.customersHidden], ['A100', 'حليب', '2099-01-31', 'STRICT', false, false]);
  assert.deepEqual(d.origin.map((o: Row) => [o.kind, o.qty]), [['RECEIVE', 100]]);
  assert.deepEqual(d.places.map((p: Row) => [p.place, p.salesRepId, p.repName, p.raw.SELLABLE, p.loaded, p.unloaded, p.sold, p.returned, p.approximate]), [
    ['WAREHOUSE', null, null, 50, 50, 0, 0, 0, false],
    ['VAN', 'R1', 'أحمد', 25, 30, 0, 17, 12, false],
    ['VAN', 'R2', 'سالم', 0, 20, 0, 20, 0, false],
  ]);
  const cust = d.customers.map((c: Row) => [c.name, c.invoices.map((i: Row) => [i.number, i.sold, i.returned, i.net, i.weakest, i.flags, i.broad])]);
  assert.deepEqual(cust, [
    ['بقالة النور', [['INV-S1', 12, 12, 0, 'CONFIRMED', [], false], ['INV-S6', 20, 0, 20, 'CONFIRMED', [], false]]],
    ['سوبرماركت الفجر', [['INV-S2', 5, 0, 5, 'ASSUMED', ['REPLAY_CLAMPED'], false]]],
  ], 'صافي الصفر (S1 بعد مرتجعه) مُدرج');
  assert.equal(d.customers[0].phone, '0500000001');
  assert.deepEqual(d.events.map((e: Row) => e.kind), ['CREATE']);
  // سيارة المحذوف «مندوب محذوف» بعلم approximate (L2 في RX)
  const l2 = (await call('GET', '/api/lots/L2/trace')).body.data;
  const rx = l2.places.find((p: Row) => p.salesRepId === 'RX');
  assert.deepEqual([rx.repName, rx.approximate, rx.raw.SELLABLE, rx.loaded], ['مندوب محذوف', true, 5, 5]);
  const r1 = l2.places.find((p: Row) => p.salesRepId === 'R1');
  assert.deepEqual([r1.raw.SELLABLE, r1.held.SELLABLE, r1.usable.SELLABLE, r1.returned], [9, 2, 7, 2]);
});

test('التتبّع BROAD: بيع الصنف من السيارة في نافذة وجود اللوط حتى يفرغ رصيد الصنف — «مفترض» بوسم broad', async () => {
  world();
  const d = (await call('GET', '/api/lots/L1/trace?scope=BROAD')).body.data;
  assert.equal(d.scope, 'BROAD');
  const rows = d.customers.flatMap((c: Row) => c.invoices.map((i: Row) => [c.name, i.number, i.sold, i.weakest, i.broad]));
  // S5 (من L2 في R1 والنافذة مفتوحة) يُضاف؛ وS7 (R2 بعد أن فرغت بـS6 ولم يعد إليها L1) لا يُضاف
  assert.deepEqual(rows, [
    ['بقالة النور', 'INV-S1', 12, 'CONFIRMED', false], ['بقالة النور', 'INV-S6', 20, 'CONFIRMED', false],
    ['سوبرماركت الفجر', 'INV-S2', 5, 'ASSUMED', false], ['سوبرماركت الفجر', 'INV-S5', 3, 'ASSUMED', true],
  ]);
});

test('التتبّع BROAD بالوحدات: لوطٌ سُمّي في السيارة ثم بيعٌ بكرتون وحبّتين بلا صفوف ⇒ ٢٦ أساسية، والنافذة تُغلق عند الفراغ', async () => {
  world();
  let r = await relabel({ productId: 'P3', place: 'VAN', vanKey: 'R1', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ lotNumber: 'Q1', qty: 26 }] });
  assert.equal(r.status, 201);
  const q1 = T.productLot.find((l) => l.lotNumber === 'Q1')!;
  const later = new Date(Date.now() + 60_000);
  addInv('S4', '2026-02-12', 'R1', 'C2', 'CASH', [{ pid: 'P3', qty: 1, unitFactor: 24 }, { pid: 'P3', qty: 2, unitFactor: 1 }], { createdAt: later });
  addInv('S11', '2026-02-12', 'R1', 'C1', 'CASH', [{ pid: 'P3', qty: 1, unitFactor: 1 }], { createdAt: new Date(later.getTime() + 60_000) });
  r = await call('GET', `/api/lots/${q1.id}/trace?scope=BROAD`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.origin.map((o: Row) => [o.kind, o.qty]), [['RELABEL', 26]]);
  assert.deepEqual(r.body.data.customers.map((c: Row) => [c.name, c.invoices.map((i: Row) => [i.number, i.sold, i.broad])]),
    [['سوبرماركت الفجر', [['INV-S4', 26, true]]]], 'S11 بعد أن فرغت السيارة بـS4 خارج النافذة');
  r = await call('GET', `/api/lots/${q1.id}/trace`);
  assert.deepEqual(r.body.data.customers, [], 'STRICT بلا صفوف لوط');
});

test('التتبّع BROAD بالوحدات: رصيد الصنف في النافذة بالأساس — كرتونٌ مخزَّن (٤٨) لا كمية سطره (٢)، فالنافذة تبقى مفتوحة حتى الفراغ الحقيقي', async () => {
  world();
  let r = await relabel({ productId: 'P3', place: 'VAN', vanKey: 'R1', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ lotNumber: 'Q1', qty: 26 }] });
  assert.equal(r.status, 201);
  const q1 = T.productLot.find((l) => l.lotNumber === 'Q1')!;
  const t = Date.now() + 60_000;
  const at = (k: number) => ({ createdAt: new Date(t + k * 60_000) });
  // ٢٦ − كرتون (٢٤) = ٢ ⇒ مفتوحة؛ − ١ = ١ ⇒ مفتوحة؛ − ١ = ٠ ⇒ تُغلق عند S12 (وهو داخلها)؛ S13 بعدها خارجها
  addInv('S4', '2026-02-12', 'R1', 'C2', 'CASH', [{ pid: 'P3', qty: 1, unitFactor: 24 }], at(0));
  addInv('S11', '2026-02-12', 'R1', 'C1', 'CASH', [{ pid: 'P3', qty: 1 }], at(1));
  addInv('S12', '2026-02-12', 'R1', 'C2', 'CASH', [{ pid: 'P3', qty: 1 }], at(2));
  addInv('S13', '2026-02-12', 'R1', 'C1', 'CASH', [{ pid: 'P3', qty: 1 }], at(3));
  r = await call('GET', `/api/lots/${q1.id}/trace?scope=BROAD`);
  assert.deepEqual(r.body.data.customers.map((c: Row) => [c.name, c.invoices.map((i: Row) => [i.number, i.sold, i.weakest])]), [
    ['بقالة النور', [['INV-S11', 1, 'ASSUMED']]],
    ['سوبرماركت الفجر', [['INV-S4', 24, 'ASSUMED'], ['INV-S12', 1, 'ASSUMED']]],
  ]);
});

test('التتبّع بالنطاق والصلاحية: المقيّد يرى سياراته وفواتير نطاقه (scoped)، وبلا «إدارة العملاء» customersHidden', async () => {
  world();
  let d = (await call('GET', '/api/lots/L1/trace?scope=BROAD', { user: SCOPED })).body.data;
  assert.deepEqual([d.scoped, d.places.map((p: Row) => p.salesRepId)], [true, [null, 'R1']]);
  assert.deepEqual(d.customers.map((c: Row) => [c.name, c.invoices.map((i: Row) => [i.number, i.net])]), [['بقالة النور', [['INV-S1', 0]]]]);
  d = (await call('GET', '/api/lots/L1/trace', { user: NO_CUSTOMERS })).body.data;
  assert.deepEqual([d.customers, d.customersHidden, d.places.length], [null, true, 3]);
});

// ═══ خطة التنزيل وسلامة الأرصدة ═══

test('خطة التنزيل: كل سيارة فيها اللوط بصالحه ومحجوزه ومنها المحذوفة (D30)، والمقيّد سياراته وحدها', async () => {
  world();
  let r = await call('GET', '/api/lots/L2/unload-plan');
  assert.deepEqual(r.body.data.map((x: Row) => [x.salesRepId, x.repName, x.deleted, x.usable.SELLABLE, x.held.SELLABLE]),
    [['R1', 'أحمد', false, 7, 2], ['R2', 'سالم', false, 6, 0], ['RX', 'مندوب محذوف', true, 5, 0]]);
  r = await call('GET', '/api/lots/L2/unload-plan', { user: SCOPED });
  assert.deepEqual(r.body.data.map((x: Row) => x.salesRepId), ['R1']);
  r = await call('GET', '/api/lots/LX/unload-plan');
  assert.deepEqual(r.body.data, [], 'المنتهي في المستودع وحده');
});

test('/lots/health: العجز غير المسمّى والمسمّى في كل مكان، والمقيّد يرى المستودع وسياراته', async () => {
  world();
  let r = await call('GET', '/api/lots/health');
  assert.deepEqual(r.body.data.deficits.map((x: Row) => [x.productId, x.place, x.salesRepId, x.lotId, x.bucket, x.qty]),
    [['P3', 'VAN', 'R2', null, 'SELLABLE', -5]]);
  // صفّ بيعٍ من لوطٍ لم يدخل السيارة (خلل) ⇒ خامٌ مسمّى سالب
  addInv('S8', '2026-02-12', 'R2', 'C1', 'CASH', [{ pid: 'P1', qty: 1, lots: [{ lotId: 'LB', qty: 1 }] }]);
  r = await call('GET', '/api/lots/health');
  assert.deepEqual(r.body.data.deficits.map((x: Row) => [x.productId, x.salesRepId, x.lotId, x.lotNumber, x.qty]),
    [['P1', 'R2', 'LB', 'H500', -1], ['P3', 'R2', null, null, -5]]);
  r = await call('GET', '/api/lots/health', { user: SCOPED });
  assert.deepEqual([r.body.data.deficits, r.body.data.scoped], [[], true]);
});

// ═══ الأرصدة والمخزون في تاريخ (§٤.٢٠) والاقتراح ═══

test('/lots/balances: المستودع وكل سيارة (والمحذوفة approximate) بالخام والصالح والمتاح، وasOf بمرشّحات المستودع', async () => {
  world();
  let r = await call('GET', '/api/lots/balances?productId=P1');
  const d = r.body.data;
  const w = d.warehouse[0];
  assert.deepEqual([w.total, w.unknown, w.lots.map((l: Row) => [l.meta.lotNumber, l.raw.SELLABLE])],
    [bal(125), bal(30), [['X900', 10], ['A100', 50], ['B200', 25], ['H500', 10]]], 'بترتيب FEFO');
  assert.equal(w.firstInAt, undefined, 'لا خرائط داخلية في الردّ');
  assert.deepEqual([w.availability.available, w.availability.quarantined, w.availability.expiredUnsold], [105, 10, 10]);
  assert.deepEqual(d.vans.map((v: Row) => [v.salesRepId, v.repName, v.deleted, v.view.total, v.view.approximate]), [
    ['R1', 'أحمد', false, bal(34), false], ['R2', 'سالم', false, bal(6), false], ['RX', 'مندوب محذوف', true, null, true],
  ]);
  assert.deepEqual(d.vans[0].view.availability.held, 2);
  // asOf: نهاية يوم ٢٠٢٦-٠٢-٠١ — الوارد وحده
  r = await call('GET', '/api/lots/balances?productId=P1&asOf=2026-02-01');
  assert.deepEqual([r.body.data.asOf, r.body.data.warehouse[0].total, r.body.data.warehouse[0].lots.find((l: Row) => l.lotId === 'L1').raw.SELLABLE, r.body.data.vans],
    ['2026-02-01', bal(200), 100, []]);
  // المقيّد: سياراته وحدها بلا المحذوفة
  r = await call('GET', `/api/lots/balances?productIds=${enc('P1,P3')}`, { user: SCOPED });
  assert.deepEqual(r.body.data.vans.map((v: Row) => [v.salesRepId, v.view.productId]), [['R1', 'P1'], ['R1', 'P3']]);
  r = await call('GET', '/api/lots/balances');
  assert.equal(r.status, 400);
});

test('/lots/fefo: اقتراحٌ بلا قفل بـFEFO من المؤهَّل ثم غير المسمّى، والنقص shortage، وقاعدة الكرتون (unitFactor)، وتحذير اللوطين', async () => {
  world();
  log = [];
  let r = await call('GET', '/api/lots/fefo?productId=P1&qty=60');
  assert.deepEqual(r.body.data.rows.map((x: Row) => [x.lotId, x.qty, x.certainty]), [['L1', 50, 'ASSUMED'], ['L2', 10, 'ASSUMED']]);
  assert.ok(!log.some((e) => e.text.includes('pg_advisory_xact_lock') || e.text.includes('FOR KEY SHARE')), 'قراءة بلا قفل');
  r = await call('GET', '/api/lots/fefo?productId=P1&qty=200');
  assert.deepEqual([r.body.data.shortage.wanted, r.body.data.shortage.available], [200, 105]);
  assert.deepEqual(r.body.data.rows.map((x: Row) => [x.lotId, x.qty]), [['L1', 50], ['L2', 25], [null, 30]], 'المتاح كله، وغير المسمّى بعد المسمّى (D17)');
  // كرتون ٢٤: ثلاثة كراتين = كرتونان من L1 وكرتونٌ من L2 بلا تقسيم
  r = await call('GET', '/api/lots/fefo?productId=P1&qty=72&unitFactor=24');
  assert.deepEqual([r.body.data.rows.map((x: Row) => [x.lotId, x.qty, x.flags]), r.body.data.warnings], [[['L1', 48, []], ['L2', 24, []]], []]);
  // كرتونان ونصف: الباقي ١٢ ينقسم بين L1 (٢) وL2 (١٠) فيُوسم SPLIT_UNIT
  r = await call('GET', '/api/lots/fefo?productId=P1&qty=60&unitFactor=24');
  assert.deepEqual(r.body.data.rows.map((x: Row) => [x.lotId, x.qty, x.flags]), [['L1', 50, ['SPLIT_UNIT']], ['L2', 10, ['SPLIT_UNIT']]]);
  assert.deepEqual(r.body.data.warnings.map((w: Row) => [w.code, w.detail.unitFactor]), [['LOT_SPLIT_UNIT', 24]]);
  // لسيارة R2 (فيها L2): تحميل L1 يجعلها بلوطين
  r = await call('GET', '/api/lots/fefo?productId=P1&qty=5&salesRepId=R2');
  assert.deepEqual(r.body.data.warnings.map((w: Row) => [w.code, w.detail.lots.map((l: Row) => l.lotId)]), [['LOT_MULTI_IN_VAN', ['L1', 'L2']]]);
  r = await call('GET', '/api/lots/fefo?productId=P1&qty=5&salesRepId=R2', { user: SCOPED });
  assert.equal(r.status, 404);
  r = await call('GET', '/api/lots/fefo?productId=P1&qty=1.00001');
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_QTY_INVALID']);
  r = await call('GET', '/api/lots/fefo?productId=P2&qty=1');
  assert.deepEqual(r.body.data.rows, [], 'غير المتتبَّع بلا اقتراح');
  // مندوبٌ غير موجود في الشركة (أو من شركةٍ أخرى): 404 ولو لغير المقيّد
  r = await call('GET', '/api/lots/fefo?productId=P1&qty=5&salesRepId=R9');
  assert.equal(r.status, 404);
  r = await call('GET', '/api/lots/fefo?productId=P1&qty=5&salesRepId=NOPE');
  assert.equal(r.status, 404);
});

test('/lots/fefo بالأسطر (الوحدات): سطرٌ بحبّة قبل سطرٍ بكرتون للصنف نفسه — الكرتون كراتينه كاملةً من لوطٍ واحد والحبّات مما بقي (allocateOutLines)', async () => {
  world();
  // المستودع P1: L1 ٥٠، L2 ٢٥، وغير مسمّى ٣٠. «٥ حبة» ثم «٢ كرتون (٤٨)»: الكرتون يُخدَم أولاً فيأخذ ٤٨ من L1 كاملةً،
  // والحبّات ٢ من L1 و٣ من L2 — لا ٥ من L1 ثم ٤٥ + ٣ يشقّان كرتوناً (توزيع المجموع ثم distributeToLines)
  let r = await call('GET', `/api/lots/fefo?productId=P1&lines=${enc('5,48:24')}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.lines.map((l: Row) => [l.idx, l.qty, l.unitFactor, l.rows.map((x: Row) => [x.lotId, x.qty, x.flags])]), [
    [0, 5, 1, [['L1', 2, []], ['L2', 3, []]]],
    [1, 48, 24, [['L1', 48, []]]],
  ]);
  assert.deepEqual([r.body.data.rows.map((x: Row) => [x.lotId, x.qty]), r.body.data.warnings], [[['L1', 2], ['L2', 3], ['L1', 48]], []]);
  // النقص: المتاح ١٠٥ يُقتطع بترتيب الخدمة — الكرتون (١٠٠) أولاً ثم الحبّات (٥ من ١٠)، وsplit موسوم على سطر الكرتون بفهرسه
  r = await call('GET', `/api/lots/fefo?productId=P1&lines=${enc('100:24,10')}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.shortage.wanted, r.body.data.shortage.available], [110, 105]);
  const sum = (rows: Row[]) => Math.round(rows.reduce((s, x) => s + x.qty, 0) * 1e4) / 1e4;
  assert.deepEqual(r.body.data.lines.map((l: Row) => sum(l.rows)), [100, 5]);
  assert.deepEqual(r.body.data.lines[1].rows.map((x: Row) => [x.lotId, x.qty]), [[null, 5]]);
  assert.ok(r.body.data.warnings.some((w: Row) => w.code === 'LOT_SPLIT_UNIT' && w.detail.idx === 0 && w.detail.unitFactor === 24));
  // أسطرٌ غير صالحة: كمية بخمس خانات 422، ومعاملٌ صفري 400، وأكثر من خمسين سطراً 400
  r = await call('GET', `/api/lots/fefo?productId=P1&lines=${enc('5,1.00001')}`);
  assert.deepEqual([r.status, r.body.code, r.body.detail.line], [422, 'LOT_QTY_INVALID', 1]);
  r = await call('GET', `/api/lots/fefo?productId=P1&lines=${enc('5:0')}`);
  assert.equal(r.status, 400);
  r = await call('GET', `/api/lots/fefo?productId=P1&lines=${enc(Array.from({ length: 51 }, () => '1').join(','))}`);
  assert.equal(r.status, 400);
});

// ═══ التفعيل الجماعي (§٤.٢) والإعدادات ═══

test('/lots/products/tracking: التفعيل بـFOR UPDATE ثم قفل اللوط والحقبة وTRACKING_ON، وneedsAttention بغير المسمّى والسالب', async () => {
  world();
  log = []; txOpts = [];
  let r = await call('POST', '/api/lots/products/tracking', { body: { enabled: true, productIds: ['P2', 'P1'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.updated, 1, 'P1 متتبَّعٌ أصلاً');
  const p2 = T.product.find((p) => p.id === 'P2')!;
  assert.ok(p2.lotTracked === true && p2.lotTrackedSince instanceof Date);
  const forUpdate = firstIdx((e) => e.text.includes('FOR UPDATE'));
  const lock = firstIdx((e) => e.text.includes('pg_advisory_xact_lock'));
  assert.ok(forUpdate >= 0 && forUpdate < lock && lock < firstIdx((e) => e.text === 'product.updateMany'), 'صفّ الصنف ثم قفل اللوط ثم الكتابة');
  assert.equal(log[lock].values[0], lotLockKey('T1', 'P2'));
  assert.deepEqual(log[forUpdate - 1].values, ['5s'], 'مهلة انتظارٍ محلية قبل FOR UPDATE');
  assert.deepEqual(txOpts, [{ maxWait: 10_000, timeout: 20_000 }]);
  assert.deepEqual(eventsOf(null).map((e) => [e.productId, e.kind, e.after.lotTracked]), [['P2', 'TRACKING_ON', true]]);
  assert.deepEqual(r.body.data.needsAttention, [
    { productId: 'P1', name: 'حليب', warehouse: { total: 125, unknown: 30 }, vans: [] },
    { productId: 'P2', name: 'شاي', warehouse: { total: 7, unknown: 7 }, vans: [{ salesRepId: 'R1', total: -2, unknown: -2 }] },
  ]);
  r = await call('POST', '/api/lots/products/tracking', { body: { enabled: true } });
  assert.equal(r.status, 400, 'محدِّدٌ واحد');
  r = await call('POST', '/api/lots/products/tracking', { body: { enabled: true, all: true, categoryId: 'CAT1' } });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/lots/products/tracking', { user: { ...ADMIN, id: 'a5', role: 'MANAGER' }, body: { enabled: true, all: true } });
  assert.equal(r.status, 403, 'بصلاحية المنتجات');
});

test('/lots/products/tracking: الإطفاء مع أرصدة مسمّاة 409 LOT_TRACKING_HAS_BALANCE بلا إطفاءٍ جزئي، ثم confirmLotBalances وTRACKING_OFF', async () => {
  world();
  let r = await call('POST', '/api/lots/products/tracking', { body: { enabled: false, categoryId: 'CAT1' } });
  assert.deepEqual([r.status, r.body.code], [409, 'LOT_TRACKING_HAS_BALANCE']);
  assert.deepEqual(r.body.detail.products.map((p: Row) => [p.productId, p.name, p.warehouse, p.vans.map((v: Row) => [v.salesRepId, v.qty])]),
    [['P1', 'حليب', 95, [['R1', 34], ['R2', 6], ['RX', 5]]]]);
  assert.ok(T.product.find((p) => p.id === 'P1')!.lotTracked);
  assert.equal(eventsOf(null).length, 0);
  // P3 بلا رصيدٍ مسمّى: يُطفأ بلا تأكيد
  r = await call('POST', '/api/lots/products/tracking', { body: { enabled: false, productIds: ['P3'] } });
  assert.deepEqual([r.status, r.body.data.updated, r.body.data.needsAttention], [200, 1, []]);
  r = await call('POST', '/api/lots/products/tracking', { body: { enabled: false, productIds: ['P1'], confirmLotBalances: true } });
  assert.deepEqual([r.status, r.body.data.updated], [200, 1]);
  assert.equal(T.product.find((p) => p.id === 'P1')!.lotTracked, false);
  assert.deepEqual(eventsOf(null).map((e) => [e.productId, e.kind, e.reason]), [['P3', 'TRACKING_OFF', null], ['P1', 'TRACKING_OFF', 'confirmLotBalances']]);
  // إعادة التفعيل حقبةٌ جديدة: المسمّى يصير غير مسمّى (D25، D9)
  r = await call('POST', '/api/lots/products/tracking', { body: { enabled: true, productIds: ['P1'] } });
  assert.equal(r.status, 200);
  const w = (await call('GET', '/api/lots/balances?productId=P1')).body.data.warehouse[0];
  assert.deepEqual([w.total, w.unknown, w.lots], [bal(125), bal(125), []]);
});

test('/lots/products/tracking: دفعاتٌ بمئة صنف، كلٌّ بمعاملته وقفل صفوفه بترتيب المعرّف وأقفال اللوط بترتيب المفتاح', async () => {
  world();
  const ids = Array.from({ length: 150 }, (_, i) => `Q${String(i).padStart(3, '0')}`);
  for (const id of ids) T.product.push({ ...T.product.find((p) => p.id === 'P2')!, id, code: id, name: id, lotTracked: false, lotTrackedSince: null, categoryId: null });
  log = []; txOpts = [];
  const r = await call('POST', '/api/lots/products/tracking', { body: { enabled: true, productIds: [...ids].reverse() } });
  assert.deepEqual([r.status, r.body.data.updated, r.body.data.needsAttention], [200, 150, []]);
  assert.equal(txOpts.length, 2);
  const forUpdates = log.filter((e) => e.text.includes('FOR UPDATE'));
  assert.deepEqual(forUpdates.map((e) => (e.values[1] as string[]).length), [100, 50]);
  assert.deepEqual(forUpdates.flatMap((e) => e.values[1] as string[]), [...ids].sort());
  const locks = log.filter((e) => e.text.includes('pg_advisory_xact_lock')).map((e) => e.values[0]);
  assert.deepEqual(locks, [...sortedLockKeys('T1', ids.slice(0, 100)), ...sortedLockKeys('T1', ids.slice(100))].map((k) => k.key));
  assert.equal(eventsOf(null, 'TRACKING_ON').length, 150);
});

test('/lots/products/tracking: الإطفاء على دفعات يُفحص كله قبل أي دفعة — صنفٌ برصيدٍ مسمّى في الدفعة الثانية لا يترك الأولى مطفأة', async () => {
  world();
  const ids = Array.from({ length: 150 }, (_, i) => `A${String(i).padStart(3, '0')}`);
  for (const id of ids) T.product.push({ ...T.product.find((p) => p.id === 'P3')!, id, code: id, name: id, categoryId: 'CAT1' });
  // الترتيب بالمعرّف: A000…A099 ثم A100…A149 وP1 (برصيدٍ مسمّى) في الدفعة الثانية
  const r = await call('POST', '/api/lots/products/tracking', { body: { enabled: false, categoryId: 'CAT1' } });
  assert.deepEqual([r.status, r.body.code, r.body.detail.updated, r.body.detail.products.map((p: Row) => p.productId)], [409, 'LOT_TRACKING_HAS_BALANCE', 0, ['P1']]);
  assert.ok(ids.every((id) => T.product.find((p) => p.id === id)!.lotTracked === true), 'لا إطفاء جزئي');
  assert.equal(eventsOf(null).length, 0);
});

test('PUT /lots/settings: lotOnInvoice بصلاحية إعدادات الشركة (D15)', async () => {
  world();
  let r = await call('PUT', '/api/lots/settings', { body: { lotOnInvoice: true } });
  assert.deepEqual([r.status, r.body.data], [200, { lotOnInvoice: true }]);
  assert.equal(T.companySettings[0].lotOnInvoice, true);
  r = await call('PUT', '/api/lots/settings', { body: { lotOnInvoice: 'yes' } });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/lots/settings', { user: { ...ADMIN, id: 'a5', role: 'MANAGER' }, body: { lotOnInvoice: false } });
  assert.equal(r.status, 403);
  assert.equal(T.companySettings[0].lotOnInvoice, true);
});

test('القوائم: GET /lots بحثاً بالرقم المطبَّع والقريب من الانتهاء بملخّص الأرصدة، وGET /lots/:id بالبطاقة وinUse، والسجلّ', async () => {
  world();
  let r = await call('GET', `/api/lots?q=${enc(' a١٠٠ ')}`);
  assert.deepEqual(r.body.data.map((l: Row) => [l.lotNumber, l.productName, l.summary.warehouse, l.summary.vans.SELLABLE, l.summary.vanCount]), [['A100', 'حليب', 50, 25, 1]]);
  r = await call('GET', `/api/lots?q=${enc('حليب')}&limit=2&page=2`);
  assert.deepEqual([r.body.data.map((l: Row) => l.lotNumber), r.body.pagination], [['B200', 'H500'], { total: 4, page: 2, limit: 2, pages: 2 }]);
  r = await call('GET', '/api/lots?expiringWithinDays=30');
  assert.deepEqual(r.body.data.map((l: Row) => l.lotNumber), ['X900'], 'المنتهي ضمن القريب من الانتهاء');
  r = await call('GET', '/api/lots?status=BLOCKED');
  assert.deepEqual(r.body.data.map((l: Row) => l.lotNumber), ['H500']);
  r = await call('GET', '/api/lots?expiringWithinDays=-1');
  assert.equal(r.status, 400);
  r = await call('GET', '/api/lots/LX');
  assert.deepEqual([r.body.data.expired, r.body.data.inUse, r.body.data.product.shelfLifeOn, r.body.data.summary.warehouse], [true, true, true, 10]);
  r = await call('GET', '/api/lots/L2', { user: SCOPED });
  assert.deepEqual([r.body.data.scoped, r.body.data.summary.places.map((p: Row) => p.salesRepId)], [true, [null, 'R1']]);
  r = await call('GET', '/api/lots/L1/events');
  assert.deepEqual(r.body.data.map((e: Row) => [e.kind, e.actorName]), [['CREATE', 'مدير']]);
});
