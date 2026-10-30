// «تتبّع اللوط» — فواتير المرحلة الأولى (المواصفة §٨.٢ lots-invoices، الحزمة B5): POST /invoices وإلغاء المرتجع وإعادته للمخزون
// عبر الموجّه الحقيقي فوق قاعدةٍ مزيّفة في الذاكرة (نمط invoices-arm-cutover-route.test.ts): تجميعات SQL في lotsDb تُحسب من الصفوف
// المخزّنة، والمعاملة لقطةٌ تُستعاد عند الرمي. لا قاعدة بيانات ولا شبكة.
//   • الميزة مطفأة أو الصنف غير متتبَّع ⇒ المسار كما كان: لا قفل لوط ولا مهلة جديدة ولا صفوف توزيع.
//   • البيع (المندوب والإدارة والمفتاح): FEFO، وغير المسمّى بعد المسمّى (D17)، والصريح وأخطاؤه، وتجاهل canSellWithoutStock للمتتبَّع
//     وحده، ويوم الخادم، والإعادة بطبقاتها وتلميحها ووسومها، والحجز للمراجعة بإشعارٍ واحد، والوحدات (كرتون وحبة للصنف نفسه).
//   • المرتجع المرتبط بالترتيب الهجين، والحرّ وختمه قبل المعاملة، وإلغاء المرتجع وإطفاء عودته (I1/I2)، والختم اللاحق.
//   • ClientRefRace ⇒ 200، وLotError برمزه، و55P03 ⇒ 503 LOT_BUSY.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Prisma } from '@prisma/client';
import { localDateIn } from '../services/shelfLife';
import { companyTimeZone } from '../services/erpPayload';
import { DAMAGED_VAN_SINCE } from '../services/vanDamaged';
import { LOT_HOLD_MIRRORS, LotError } from '../services/lots';

// ═══ قاعدةٌ مزيّفة في الذاكرة ═══

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
interface Db {
  tenant: Row; reps: Row[]; customers: Row[]; products: Row[]; lots: Row[];
  vanLoads: Row[]; vanLoadItems: Row[]; vanLoadItemLots: Row[];
  invoices: Row[]; invoiceItems: Row[]; invoiceItemLots: Row[]; notifications: Row[];
}
let db: Db;
let calls: string[] = [];
let txOptions: unknown[] = [];
let unknownSql: string[] = [];
let failExec: ((sql: string) => unknown) | null = null;
let failCreate: unknown = null;
let txDelayMs = 0;
let onRouteProductLock: (() => void) | null = null;
let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;

const TZ = companyTimeZone(null, 'SA');
const TODAY = localDateIn(new Date(), TZ);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const D = (day: string) => new Date(`${day}T00:00:00.000Z`);
const OLD = new Date('2026-01-01T00:00:00Z');

const lotRow = (id: string, productId: string, expiry: string | null, o: Partial<Row> = {}): Row => ({
  id, tenantId: 't1', productId, lotNumber: id.toUpperCase(), productionDate: null, expiryDate: expiry ? D(expiry) : null,
  status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: OLD, ...o,
});

function freshDb(): Db {
  return {
    tenant: { id: 't1', lotTrackingEnabled: true, lotTrackingSince: OLD, locationsEnabled: false, invoiceSignatureEnabled: false },
    reps: [{
      id: 'r1', tenantId: 't1', name: 'مندوب', canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
      canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, maxDiscountPct: 100, locationId: null,
    }],
    customers: [{ id: 'c1', tenantId: 't1', name: 'بقالة', status: 'ACTIVE', balance: 0, creditLimit: 0 }],
    products: [
      {
        id: 'pM', tenantId: 't1', name: 'حليب', unit: 'حبة', basePrice: 10, taxPct: 15, damagedReturnToStock: true, status: 'ACTIVE',
        priceTiers: [], teams: [], units: [{ id: 'u-ctn', name: 'كرتون', factor: 6, price: null, unitCode: null, isActive: true }],
        shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: null, shelfLifeFromDate: null,
        returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null,
        lotTracked: true, lotTrackedSince: null,
      },
      {
        id: 'pW', tenantId: 't1', name: 'ماء', unit: 'حبة', basePrice: 2, taxPct: 15, damagedReturnToStock: true, status: 'ACTIVE',
        priceTiers: [], teams: [], units: [],
        shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: null, shelfLifeFromDate: null,
        returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null,
        lotTracked: false, lotTrackedSince: null,
      },
    ],
    lots: [
      lotRow('l1', 'pM', addDays(TODAY, 10)),
      lotRow('l2', 'pM', addDays(TODAY, 40)),
      lotRow('lx', 'pM', addDays(TODAY, -1)),                       // منتهٍ أمس
      lotRow('le', 'pM', TODAY),                                    // يوم انتهائه آخر يومٍ صالح
      lotRow('lb', 'pM', addDays(TODAY, 20), { status: 'BLOCKED', blockKind: 'RECALL', blockedAt: new Date(Date.now() - 3600_000) }),
      lotRow('lo', 'pW', addDays(TODAY, 30)),                       // تشغيلة صنفٍ آخر
    ],
    vanLoads: [], vanLoadItems: [], vanLoadItemLots: [],
    invoices: [], invoiceItems: [], invoiceItemLots: [], notifications: [],
  };
}

/** تحميلٌ إلى سيارة المندوب بصفوف لوطه (lotId null = غير مسمّى صراحةً) — الكمية بالأساس */
function load(productId: string, rows: { lotId: string | null; qty: number }[], o: { repId?: string; at?: Date } = {}): void {
  const at = o.at ?? new Date(Date.now() - 86_400_000);
  const vl = { id: nid('vl'), tenantId: 't1', salesRepId: o.repId ?? 'r1', type: 'LOAD', createdAt: at };
  const qty = rows.reduce((s, r) => s + r.qty, 0);
  const it = { id: nid('vli'), vanLoadId: vl.id, productId, qty, unitFactor: 1, baseQty: qty };
  db.vanLoads.push(vl);
  db.vanLoadItems.push(it);
  for (const r of rows) {
    db.vanLoadItemLots.push({ id: nid('vlil'), vanLoadItemId: it.id, tenantId: 't1', productId, vanKey: vl.salesRepId, moveType: 'LOAD', viaWarehouse: false, lotId: r.lotId, qty: r.qty, certainty: 'CONFIRMED', reason: null, createdAt: at });
  }
}

const productOf = (id: string | null) => db.products.find((p) => p.id === id) ?? null;
const lotOf = (id: string | null) => db.lots.find((l) => l.id === id) ?? null;
const invoiceOf = (id: string) => db.invoices.find((i) => i.id === id) ?? null;
const baseOf = (it: Row) => (it.baseQty != null ? Number(it.baseQty) : Number(it.qty) * (Number(it.unitFactor) > 0 ? Number(it.unitFactor) : 1));
const epochOf = (pid: string) => {
  const a = db.tenant.lotTrackingSince as Date | null, b = productOf(pid)?.lotTrackedSince as Date | null;
  return Math.max(a ? a.getTime() : -Infinity, b ? b.getTime() : -Infinity);
};
const damagedOf = (inv: Row) => inv.returnReason === 'DAMAGED' && inv.createdAt >= DAMAGED_VAN_SINCE;
const heldOf = (inv: Row) => inv.type === 'RETURN' && inv.zatcaPhase === 2 && inv.invoiceSubtype === '01'
  && (inv.einvoiceStatus == null || (LOT_HOLD_MIRRORS as readonly string[]).includes(inv.einvoiceStatus));

function itemView(it: Row, withLots: boolean): Row {
  const lots = db.invoiceItemLots.filter((r) => r.invoiceItemId === it.id)
    .map((r) => ({ ...r, lot: r.lotId ? { lotNumber: lotOf(r.lotId)?.lotNumber, expiryDate: lotOf(r.lotId)?.expiryDate } : null }));
  return { ...it, product: productOf(it.productId), invoice: invoiceOf(it.invoiceId), ...(withLots && { lots }) };
}
/** صفوف التوزيع في البنود حين يطلبها الاستعلام وحده (include أو select) — كبريزما: الغائب لا يُرجع مفتاح lots (D11، §٤.٨ البند ٩) */
const wantsItemLots = (args?: Row): boolean => !!args?.include?.items?.include?.lots || args?.select?.items?.select?.lots != null;
function invoiceView(inv: Row, args?: Row): Row {
  const wantLots = wantsItemLots(args);
  const items = db.invoiceItems.filter((it) => it.invoiceId === inv.id).map((it) => {
    const v = itemView(it, wantLots);
    delete v.invoice;
    return v;
  });
  return { ...inv, items, customer: db.customers.find((c) => c.id === inv.customerId), receiptItems: [], installments: [], signature: null, tenant: { lotTrackingEnabled: db.tenant.lotTrackingEnabled } };
}

function group<T extends Row>(rows: T[], key: (r: T) => string, init: (r: T) => Row, add: (acc: Row, r: T) => void): Row[] {
  const m = new Map<string, Row>();
  for (const r of rows) {
    const k = key(r);
    let acc = m.get(k);
    if (!acc) { acc = init(r); m.set(k, acc); }
    add(acc, r);
  }
  return [...m.values()];
}

/** $queryRaw: يُعرف الاستعلام بنصّه، وتُحسب المجاميع من الصفوف المخزّنة (lotsDb.ts §٣.٤) */
function rawQuery(sql: string, values: unknown[]): unknown[] {
  const strs = new Set(values.flat(Infinity as 1).filter((v): v is string => typeof v === 'string'));
  if (sql.includes('FROM products') && sql.includes('FOR KEY SHARE')) {
    // تبديل التتبّع المتزامن (D25): يلتزم بين القراءة المسبقة وأول FOR KEY SHARE على الأصناف داخل المعاملة (قفل المسار في الإصدار،
    // وإعادة قراءة التتبّع في الإلغاء وإطفاء العودة)
    if (onRouteProductLock) { onRouteProductLock(); onRouteProductLock = null; }
    return db.products.filter((p) => strs.has(p.id)).map((p) => ({ id: p.id, unit: p.unit, lotTracked: p.lotTracked, lotTrackedSince: p.lotTrackedSince ?? null }));
  }
  if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
  if (sql.includes('FROM invoices WHERE id =') && sql.includes('FOR UPDATE')) {
    const inv = invoiceOf(String(values[0]));
    if (!inv) return [];
    return sql.startsWith('SELECT status') ? [{ status: inv.status, type: inv.type, paidAmt: inv.paidAmt ?? 0 }] : [{ id: inv.id }];
  }
  if (sql.includes('FROM customers') && sql.includes('FOR UPDATE')) return [{ id: values[0] }];
  if (sql.includes('COUNT(*)::int AS n FROM invoice_items r')) {
    const saleItems = new Set(db.invoiceItems.filter((it) => it.invoiceId === values[0]).map((it) => it.id));
    return [{ n: db.invoiceItems.filter((it) => saleItems.has(it.returnOfItemId) && invoiceOf(it.invoiceId)?.status !== 'CANCELLED').length }];
  }
  if (sql.includes('FROM van_load_item_lots')) {
    const rows = db.vanLoadItemLots.filter((r) => r.tenantId === 't1' && strs.has(r.productId) && r.createdAt.getTime() >= epochOf(r.productId)
      && (!sql.includes('"viaWarehouse" = true') || (r.viaWarehouse && (r.moveType === 'LOAD' || r.moveType === 'UNLOAD'))));
    return group(rows, (r) => [r.productId, r.lotId, r.vanKey, r.moveType, r.viaWarehouse].join('|'),
      (r) => ({ productId: r.productId, lotId: r.lotId, vanKey: r.vanKey, moveType: r.moveType, viaWarehouse: r.viaWarehouse, qty: 0, firstInAt: null }),
      (a, r) => { a.qty += r.qty; if (r.qty > 0 && (!a.firstInAt || r.createdAt < a.firstInAt)) a.firstInAt = r.createdAt; });
  }
  if (sql.includes('FROM invoice_item_lots') || sql.includes('FROM invoice_items it')) {
    const out: Row[] = [];
    if (sql.includes('FROM invoice_item_lots')) {
      const rows = db.invoiceItemLots.map((r) => ({ r, inv: invoiceOf(r.invoiceId)!, it: db.invoiceItems.find((x) => x.id === r.invoiceItemId)! }))
        .filter(({ r, inv }) => r.tenantId === 't1' && inv?.status === 'CONFIRMED' && strs.has(r.productId) && r.createdAt.getTime() >= epochOf(r.productId));
      out.push(...group(rows, ({ r, inv, it }) => [r.productId, r.lotId, r.vanKey, inv.type, inv.returnToStock, it.returnExpired, damagedOf(inv), heldOf(inv)].join('|'),
        ({ r, inv, it }) => ({ productId: r.productId, lotId: r.lotId, vanKey: r.vanKey, type: inv.type, returnToStock: inv.returnToStock, returnExpired: it.returnExpired ?? null, damaged: damagedOf(inv), held: heldOf(inv), qty: 0, firstAt: null, src: 'LOT' }),
        (a, { r }) => { a.qty += r.quantity; if (!a.firstAt || r.createdAt < a.firstAt) a.firstAt = r.createdAt; }));
    }
    if (sql.includes('FROM invoice_items it')) {
      const live = new Set(db.reps.map((r) => r.id));
      const rows = db.invoiceItems.map((it) => ({ it, inv: invoiceOf(it.invoiceId)! }))
        .filter(({ it, inv }) => inv.tenantId === 't1' && inv.status === 'CONFIRMED' && live.has(inv.salesRepId) && strs.has(it.productId));
      out.push(...group(rows, ({ it, inv }) => [it.productId, inv.salesRepId, inv.type, inv.returnToStock, it.returnExpired, damagedOf(inv), heldOf(inv)].join('|'),
        ({ it, inv }) => ({ productId: it.productId, lotId: null, vanKey: inv.salesRepId, type: inv.type, returnToStock: inv.returnToStock, returnExpired: it.returnExpired ?? null, damaged: damagedOf(inv), held: heldOf(inv), qty: 0, firstAt: null, src: 'TOT' }),
        (a, { it }) => { a.qty += baseOf(it); }));
    }
    return out;
  }
  if (sql.includes('FROM lot_relabels')) return [];
  if (sql.includes('FROM van_load_items vli') && sql.includes('AS "vanKey"')) {
    const live = new Set(db.reps.map((r) => r.id));
    const rows = db.vanLoadItems.map((it) => ({ it, vl: db.vanLoads.find((v) => v.id === it.vanLoadId)! }))
      .filter(({ it, vl }) => live.has(vl.salesRepId) && strs.has(it.productId));
    return group(rows, ({ it, vl }) => [it.productId, vl.salesRepId, vl.type].join('|'),
      ({ it, vl }) => ({ productId: it.productId, vanKey: vl.salesRepId, type: vl.type, qty: 0 }), (a, { it }) => { a.qty += baseOf(it); });
  }
  unknownSql.push(sql);
  return [];
}

function matchInvoice(inv: Row | null, w: Row | undefined): boolean {
  if (!w) return true;
  if (!inv) return false;
  if (w.tenantId && inv.tenantId !== w.tenantId) return false;
  if (typeof w.status === 'string' && inv.status !== w.status) return false;
  if (w.status?.not && inv.status === w.status.not) return false;
  if (w.salesRepId && inv.salesRepId !== w.salesRepId) return false;
  if (w.customerId && inv.customerId !== w.customerId) return false;
  if (w.type?.in && !w.type.in.includes(inv.type)) return false;
  if (w.type?.not && inv.type === w.type.not) return false;
  if (w.id?.not && inv.id === w.id.not) return false;
  if (w.invoiceDate?.lte && inv.invoiceDate > w.invoiceDate.lte) return false;
  if (w.invoiceDate?.lt && !(inv.invoiceDate < w.invoiceDate.lt)) return false;
  return true;
}
function itemsWhere(w: Row = {}): Row[] {
  let rows = db.invoiceItems.map((it) => itemView(it, true));
  if (w.id?.in) rows = rows.filter((r) => w.id.in.includes(r.id));
  if (typeof w.id === 'string') rows = rows.filter((r) => r.id === w.id);
  if (w.invoiceId) rows = rows.filter((r) => r.invoiceId === w.invoiceId);
  if (typeof w.productId === 'string') rows = rows.filter((r) => r.productId === w.productId);
  if (w.OR) rows = rows.filter((r) => (w.OR as Row[]).some((c) => (c.returnOfItemId?.in ?? []).includes(r.returnOfItemId) || (c.creditedItemId?.in ?? []).includes(r.creditedItemId)));
  if (w.product?.lotTracked !== undefined) rows = rows.filter((r) => r.product?.lotTracked === w.product.lotTracked);
  if (w.invoice) rows = rows.filter((r) => matchInvoice(r.invoice, w.invoice));
  return rows;
}

function createInvoice({ data, include }: Row): Row {
  if (failCreate) throw failCreate;
  if (data.clientRef && db.invoices.some((i) => i.tenantId === data.tenantId && i.clientRef === data.clientRef)) {
    throw Object.assign(new Error('Unique constraint failed on the fields: (`tenantId`,`clientRef`)'), { code: 'P2002', meta: { target: ['tenantId', 'clientRef'] } });
  }
  const now = new Date();
  const inv: Row = {
    id: data.id ?? nid('inv'), tenantId: data.tenantId, number: data.number, clientRef: data.clientRef ?? null, clientCreatedAt: data.clientCreatedAt ?? null,
    customerId: data.customerId, salesRepId: data.salesRepId, type: data.type, status: 'CONFIRMED',
    returnReason: data.returnReason ?? null, returnToStock: data.returnToStock ?? true, invoiceDate: data.invoiceDate ?? now, createdAt: now,
    zatcaPhase: null, invoiceSubtype: null, einvoiceStatus: data.einvoiceStatus ?? null, total: data.total, paidAmt: data.paidAmt ?? 0,
    preGeneratedId: data.id ?? null,
  };
  db.invoices.push(inv);
  for (const c of data.items?.create ?? []) {
    const { lots, ...rest } = c;
    const it: Row = { id: nid('ii'), invoiceId: inv.id, returnOfItemId: null, creditedItemId: null, expiresAt: null, returnExpired: null, expirySaleInvoiceId: null, ...rest };
    db.invoiceItems.push(it);
    for (const l of lots?.create ?? []) db.invoiceItemLots.push({ id: nid('iil'), invoiceItemId: it.id, createdAt: now, ...l });
  }
  return invoiceView(inv, { include });
}

const scripted: Record<string, (args: any) => unknown> = {
  'invoice.findUnique': (args) => {
    const { where } = args;
    const inv = where.tenantId_clientRef
      ? db.invoices.find((i) => i.tenantId === where.tenantId_clientRef.tenantId && i.clientRef === where.tenantId_clientRef.clientRef)
      : invoiceOf(where.id);
    return inv ? invoiceView(inv, args) : null;
  },
  'invoice.findFirst': (args) => {
    const { where } = args;
    if (where?.number?.startsWith) {
      const same = db.invoices.filter((i) => String(i.number).startsWith(where.number.startsWith)).sort((a, b) => (a.number < b.number ? 1 : -1));
      return same[0] ? { number: same[0].number } : null;
    }
    const inv = where?.id ? invoiceOf(where.id) : null;
    return inv && (!where.tenantId || inv.tenantId === where.tenantId) ? invoiceView(inv, args) : null;
  },
  'invoice.create': createInvoice,
  'invoice.update': ({ where, data }) => { const inv = invoiceOf(where.id)!; Object.assign(inv, data); return invoiceView(inv); },
  'invoice.count': () => 0,
  'invoiceItem.findMany': ({ where }) => itemsWhere(where),
  'invoiceItem.findFirst': ({ where, orderBy }) => {
    const rows = itemsWhere(where);
    if (orderBy) rows.sort((a, b) => (b.invoice.invoiceDate - a.invoice.invoiceDate) || (b.invoice.createdAt - a.invoice.createdAt));
    return rows[0] ?? null;
  },
  'invoiceItem.update': ({ where, data }) => { const it = db.invoiceItems.find((x) => x.id === where.id)!; Object.assign(it, data); return it; },
  'invoiceItem.aggregate': () => ({ _sum: { baseQty: 0, qty: 0 } }),
  'invoiceItemLot.findMany': ({ where }) => db.invoiceItemLots
    .filter((r) => (!where.invoiceItemId?.in || where.invoiceItemId.in.includes(r.invoiceItemId))
      && (!where.sourceItemLotId?.in || where.sourceItemLotId.in.includes(r.sourceItemLotId))
      && (!where.invoiceItem?.invoice || matchInvoice(invoiceOf(r.invoiceId), where.invoiceItem.invoice)))
    .map((r) => ({ ...r, lot: r.lotId ? { lotNumber: lotOf(r.lotId)!.lotNumber } : null })),
  'productLot.findMany': ({ where }) => db.lots.filter((l) => l.tenantId === where.tenantId
    && (!where.id?.in || where.id.in.includes(l.id)) && (!where.productId?.in || where.productId.in.includes(l.productId))),
  'salesRep.findFirst': ({ where }) => {
    const r = db.reps.find((x) => x.id === where.id);
    return r ? { ...r, tenant: { locationsEnabled: db.tenant.locationsEnabled, lotTrackingEnabled: db.tenant.lotTrackingEnabled, settings: { teamsEnabled: false } }, teamMemberships: [] } : null;
  },
  'salesRep.findMany': ({ where }) => db.reps.filter((r) => !where?.id?.in || where.id.in.includes(r.id)).map((r) => ({ id: r.id })),
  'customer.findFirst': ({ where }) => db.customers.find((c) => c.id === where.id) ?? null,
  'product.findMany': ({ where }) => db.products.filter((p) => (!where?.id?.in || where.id.in.includes(p.id)) && (where?.lotTracked === undefined || p.lotTracked === where.lotTracked)),
  'companySettings.findUnique': () => ({ defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null }),
  'tenant.findUnique': () => ({ ...db.tenant }),
  'notification.create': ({ data }) => { const n = { id: nid('n'), ...data }; db.notifications.push(n); return n; },
  'notification.findFirst': ({ where }) => db.notifications.find((n) => n.type === where.type && String(n.data ?? '').includes(where.data?.contains ?? '')) ?? null,
  'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  'vanLoadItem.findMany': ({ where }) => db.vanLoadItems.map((it) => ({ ...it, vanLoad: db.vanLoads.find((v) => v.id === it.vanLoadId) }))
    .filter((it) => !where?.vanLoad?.salesRepId || it.vanLoad?.salesRepId === where.vanLoad.salesRepId),
};

function defaultFor(method: string): unknown {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: {} };
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  if (method === 'create' || method === 'update') return {};
  return null;
}
const render = (strings: TemplateStringsArray | Prisma.Sql, values: unknown[]) => {
  const q = Prisma.sql(strings as TemplateStringsArray, ...(values as Prisma.Sql[]));
  return { sql: q.text.replace(/\s+/g, ' ').trim(), values: q.values };
};
function modelProxy(model: string): unknown {
  return new Proxy({}, { get: (_t, method: string) => async (args: unknown) => { calls.push(`${model}.${method}`); const fn = scripted[`${model}.${method}`]; return fn ? fn(args ?? {}) : defaultFor(method); } });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown, opts?: unknown) => {
        calls.push('$transaction');
        if (Array.isArray(arg)) return Promise.all(arg);
        txOptions.push(opts);
        if (txDelayMs) await sleep(txDelayMs);
        const snap = structuredClone(db);
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } catch (e) { db = snap; throw e; }
      };
    }
    if (key === '$queryRaw') return async (s: TemplateStringsArray, ...v: unknown[]) => { const r = render(s, v); calls.push(`$queryRaw ${r.sql}`); return rawQuery(r.sql, r.values); };
    if (key === '$executeRaw') {
      return async (s: TemplateStringsArray, ...v: unknown[]) => {
        const r = render(s, v);
        calls.push(`$executeRaw ${r.sql}`);
        if (failExec) { const e = failExec(r.sql); if (e) throw e; }
        return 1;
      };
    }
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

// ═══ حقن البدائل قبل تحميل الموجّه ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
let currentUser: Row = { id: 'admin-1', role: 'ADMIN', tenantId: 't1' };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown; headers: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    // المفتاح عميلٌ حيّ: ترويسة الإعادة تُمحى له (middleware/auth.ts:247)
    if (currentUser.apiKeyId) delete req.headers['x-fs-replay'];
    next();
  },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('لا مرحلة ثانية في هذه الاختبارات'); } });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const invoicesRouter = require('../routes/invoices').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lotsInvoice = require('../services/lotsInvoice') as typeof import('../services/lotsInvoice');

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', invoicesRouter);
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status ?? 500).json({ success: false, message: err.message }); });
  const s = http.createServer(app);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Row };
async function call(method: 'POST' | 'PATCH' | 'GET', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const s = await startServer();
  const payload = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: url, agent: false, headers: { connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}), ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ADMIN = { id: 'admin-1', role: 'ADMIN', tenantId: 't1' };
const REP = { id: 'r1', role: 'SALES_REP', tenantId: 't1' };
const API = { id: 'admin-1', role: 'ADMIN', tenantId: 't1', apiKeyId: 'k1' };
function reset(user: Row = ADMIN): void {
  db = freshDb(); calls = []; txOptions = []; unknownSql = []; failExec = null; failCreate = null; txDelayMs = 0; onRouteProductLock = null; currentUser = user;
}
type Line = { productId: string; qty: number; unitId?: string; lots?: unknown; invoiceItemId?: string };
const sale = (items: Line[], o: Row = {}): Row => ({ customerId: 'c1', salesRepId: 'r1', type: 'CASH', items: items.map((i) => ({ unitPrice: 10, ...i })), ...o });
const post = (body: Row, headers?: Record<string, string>) => call('POST', '/api/invoices', { body, headers });
const rowsOf = (r: Reply, idx = 0) => ((r.body.data.items[idx].lots ?? []) as Row[]).map((x) => [x.lotId, x.quantity, x.certainty, x.flags ?? null]);
const lockCalls = () => calls.filter((c) => c.includes('pg_advisory_xact_lock'));
const LOT_TX = { maxWait: 10_000, timeout: 20_000 };
const VAN = () => load('pM', [{ lotId: 'l1', qty: 6 }, { lotId: 'l2', qty: 12 }, { lotId: null, qty: 2 }]);

// ═══ الميزة مطفأة والصنف غير المتتبَّع: المسار كما كان (§١٠) ═══

test('الميزة مطفأة: المسار القديم حرفياً — لا قفل لوط ولا مهلة جديدة ولا صفوف ولا يوم شركة، ولا فحص رصيد للإدارة', async () => {
  reset(); VAN();
  db.tenant.lotTrackingEnabled = false;
  const r = await post(sale([{ productId: 'pM', qty: 25 }]));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(lockCalls(), []);
  assert.deepEqual(txOptions, [undefined], 'المعاملة بلا خيارات');
  assert.equal(db.invoiceItemLots.length, 0);
  assert.equal(db.invoices[0].preGeneratedId, null, 'لا معرّف مولَّد مسبقاً');
  assert.equal(r.body.warnings, undefined);
  assert.ok(!calls.includes('glSettings.findUnique'), 'لا يوم شركة');
  assert.deepEqual(unknownSql, []);
});

test('صنفٌ غير متتبَّع والميزة مفعّلة: كما كان (لا طابور ولا قفل ولا خيار مهلة)، والمستند المختلط يوزّع المتتبَّع وحده', async () => {
  reset(); VAN();
  load('pW', [{ lotId: null, qty: 10 }]);
  const r = await post(sale([{ productId: 'pW', qty: 3 }]));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(lockCalls(), []);
  assert.deepEqual(txOptions, [undefined]);
  assert.equal(db.invoiceItemLots.length, 0);
  const mixed = await post(sale([{ productId: 'pW', qty: 1 }, { productId: 'pM', qty: 2 }]));
  assert.equal(mixed.status, 201, JSON.stringify(mixed.body));
  assert.deepEqual(rowsOf(mixed, 0), [], 'بند غير المتتبَّع بلا صفوف');
  assert.deepEqual(rowsOf(mixed, 1).map((x) => [x[0], x[1]]), [['l1', 2]]);
});

test('شكل الردّ (§٤.٨ البند ٩، D11): الميزة مطفأة أو المستند غير المتتبَّع ⇒ بنودٌ بلا مفتاح lots كما كانت، والمتتبَّع بها؛ والقراءة بـwithLots=1 وحده', async () => {
  const noLots = (r: Reply) => (r.body.data.items as Row[]).every((it) => !('lots' in it));
  const withLots = (r: Reply) => (r.body.data.items as Row[]).every((it) => Array.isArray(it.lots));
  reset(); VAN();
  db.tenant.lotTrackingEnabled = false;
  const off = await post(sale([{ productId: 'pM', qty: 2 }]));
  assert.equal(off.status, 201, JSON.stringify(off.body));
  assert.ok(noLots(off), 'الميزة مطفأة: الردّ كما كان');
  db.tenant.lotTrackingEnabled = true;
  load('pW', [{ lotId: null, qty: 5 }]);
  const un = await post(sale([{ productId: 'pW', qty: 1 }]));
  assert.equal(un.status, 201, JSON.stringify(un.body));
  assert.ok(noLots(un), 'غير المتتبَّع والميزة مفعّلة: الردّ كما كان (§١٠.٢)');
  const tr = await post(sale([{ productId: 'pW', qty: 1 }, { productId: 'pM', qty: 1 }]));
  assert.equal(tr.status, 201, JSON.stringify(tr.body));
  assert.ok(withLots(tr), 'المستند المتتبَّع: صفوف التوزيع في الردّ (ورقة المندوب من ردّ الخادم)');
  const g0 = await call('GET', `/api/invoices/${tr.body.data.id}`);
  assert.equal(g0.status, 200, JSON.stringify(g0.body));
  assert.ok(noLots(g0), 'القراءة بلا withLots كما كانت');
  const g1 = await call('GET', `/api/invoices/${tr.body.data.id}?withLots=1`);
  assert.ok(withLots(g1));
  // الإطفاء يُخفي ولا يحذف (D8): withLots=1 لا يكشف صفوف حقبةٍ سابقة — كقراءات السيارة والتقارير؛ وبلا المعامل لا قراءة شركةٍ زائدة (§١٠.١)
  const ref = crypto.randomUUID();
  const tr2 = await post(sale([{ productId: 'pM', qty: 1 }], { clientRef: ref }));
  assert.equal(tr2.status, 201, JSON.stringify(tr2.body));
  assert.ok(withLots(tr2));
  db.tenant.lotTrackingEnabled = false;
  const g2 = await call('GET', `/api/invoices/${tr2.body.data.id}?withLots=1`);
  assert.equal(g2.status, 200, JSON.stringify(g2.body));
  assert.ok(noLots(g2), 'الميزة مطفأة: withLots=1 يُتجاهل في GET /:id');
  const again = await call('POST', '/api/invoices?withLots=1', { body: sale([{ productId: 'pM', qty: 1 }], { clientRef: ref }) });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.ok(noLots(again), 'الميزة مطفأة: withLots=1 يُتجاهل في تكرار clientRef');
  calls = [];
  const g3 = await call('GET', `/api/invoices/${tr2.body.data.id}`);
  assert.ok(noLots(g3));
  assert.ok(!calls.includes('tenant.findUnique'), `بلا withLots لا قراءة شركة: ${calls.join(' | ')}`);
  db.tenant.lotTrackingEnabled = true;
});

// ═══ البيع ═══

test('بيع الإدارة: FEFO داخل المعاملة بمهلة موسّعة وقفل الصنف، ومعرّفٌ مولَّد مسبقاً تكتبه الصفوف، وختم الصلاحية من التشغيلة', async () => {
  reset(); VAN();
  const r = await post(sale([{ productId: 'pM', qty: 8 }]));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(rowsOf(r), [['l1', 6, 'ASSUMED', null], ['l2', 2, 'ASSUMED', null]], 'ثلاثة مصادر مادية ⇒ مفترَض');
  assert.deepEqual(txOptions, [LOT_TX]);
  assert.equal(lockCalls().length, 1, 'قفلٌ استشاري للصنف المتتبَّع');
  const inv = db.invoices[0];
  assert.ok(inv.preGeneratedId && inv.id === inv.preGeneratedId);
  for (const row of db.invoiceItemLots) assert.deepEqual([row.invoiceId, row.tenantId, row.productId, row.vanKey], [inv.id, 't1', 'pM', 'r1']);
  assert.equal(new Date(db.invoiceItems[0].expiresAt).toISOString().slice(0, 10), addDays(TODAY, 10), 'أقرب انتهاءٍ مسمّى');
  assert.equal(r.body.data.items[0].lots[0].lot.lotNumber, 'L1', 'الردّ يحمل التشغيلة');
  assert.equal(r.body.warnings, undefined);
  assert.ok(!calls.some((c) => c.includes('FOR KEY SHARE') && c.includes('"lotTracked", "lotTrackedSince" FROM products WHERE "tenantId"')), 'لا FOR KEY SHARE ثانٍ: صفوف المسار المقفلة تُمرَّر');
  assert.deepEqual(unknownSql, []);
});

test('D17: غير المسمّى بعد نفاد المسمّى بيقين UNKNOWN وتحذير، ولا يُنقص دون الصفر (409 بلا فاتورة)', async () => {
  reset(); VAN();
  const r = await post(sale([{ productId: 'pM', qty: 19 }]));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(rowsOf(r).map((x) => [x[0], x[1], x[2]]), [['l1', 6, 'ASSUMED'], ['l2', 12, 'ASSUMED'], [null, 1, 'UNKNOWN']]);
  assert.deepEqual(r.body.warnings.map((w: Row) => w.code), ['LOT_FROM_UNKNOWN']);
  const over = await post(sale([{ productId: 'pM', qty: 2 }]));
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.equal(over.body.code, 'LOT_STOCK_INSUFFICIENT');
  assert.equal(over.body.detail.available, 1);
  assert.equal(db.invoices.length, 1, 'لا فاتورة للمرفوض');
});

test('تجاهل canSellWithoutStock للمتتبَّع وحده: المتتبَّع لا يُباع فوق صالحه لأي فاعل، وغير المتتبَّع على القاعدة القديمة حرفياً', async () => {
  reset(REP); VAN();
  db.reps[0].canSellWithoutStock = true;
  const r1 = await post(sale([{ productId: 'pM', qty: 25 }]));
  assert.equal(r1.status, 409, 'الإذن لا يفتح السالب للمتتبَّع');
  assert.equal(r1.body.code, 'LOT_STOCK_INSUFFICIENT');
  const w1 = await post(sale([{ productId: 'pW', qty: 5 }]));
  assert.equal(w1.status, 201, 'غير المتتبَّع: الإذن يبيع بلا مخزون كما كان');
  db.reps[0].canSellWithoutStock = false;
  const w2 = await post(sale([{ productId: 'pW', qty: 1 }]));
  assert.equal(w2.status, 403, 'غير المتتبَّع: القاعدة القديمة (متبقّي السيارة)');
  assert.match(String(w2.body.message), /تتجاوز مخزون سيارتك/);
  const r2 = await post(sale([{ productId: 'pM', qty: 25 }]));
  assert.equal(r2.status, 409, 'المتتبَّع لا يمرّ بالفحص القديم: يرفضه التوزيع برمزه');
  assert.equal(r2.body.code, 'LOT_STOCK_INSUFFICIENT');
  const ok = await post(sale([{ productId: 'pM', qty: 4 }]));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('الوحدات (D22): «١ كرتون + ٣ حبة» للصنف نفسه — الكرتون كاملاً من تشغيلةٍ واحدة أولاً بأيّ ترتيب، وΣ صفوف كل سطر = أساسه', async () => {
  for (const order of [0, 1]) {
    reset();
    load('pM', [{ lotId: 'l1', qty: 4 }, { lotId: 'l2', qty: 12 }]);
    const carton: Line = { productId: 'pM', qty: 1, unitId: 'u-ctn' };
    const pieces: Line = { productId: 'pM', qty: 3 };
    const r = await post(sale(order === 0 ? [carton, pieces] : [pieces, carton]));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ci = order === 0 ? 0 : 1, pi = 1 - ci;
    assert.deepEqual(rowsOf(r, ci).map((x) => [x[0], x[1]]), [['l2', 6]], 'الكرتون من l2 كاملاً (l1 فيها ٤)');
    assert.deepEqual(rowsOf(r, pi).map((x) => [x[0], x[1]]), [['l1', 3]], 'الحبّات من الأقرب انتهاءً');
    assert.equal(db.invoiceItems[ci].baseQty, 6);
    assert.equal(r.body.warnings, undefined, 'لا وحدة مقسومة');
  }
  // كرتونٌ لا تحمله تشغيلةٌ واحدة: يُقسم مع وسم SPLIT_UNIT وتحذيرٍ بفهرس سطره
  reset();
  load('pM', [{ lotId: 'l1', qty: 4 }, { lotId: 'l2', qty: 3 }]);
  const r = await post(sale([{ productId: 'pM', qty: 1, unitId: 'u-ctn' }]));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(rowsOf(r), [['l1', 4, 'ASSUMED', 'SPLIT_UNIT'], ['l2', 2, 'ASSUMED', 'SPLIT_UNIT']]);
  assert.deepEqual(r.body.warnings, [{ code: 'LOT_SPLIT_UNIT', productId: 'pM', detail: { unitFactor: 6, idx: 0 } }]);
});

test('الصريح للإدارة والمفتاح: يُكتب كما هو CONFIRMED، وأخطاؤه برموزها، وسطرٌ بلا صريح يُوزَّع مما بقي', async () => {
  reset(); VAN();
  load('pM', [{ lotId: 'lb', qty: 2 }, { lotId: 'lx', qty: 2 }]);
  const ok = await post(sale([{ productId: 'pM', qty: 5, lots: [{ lotId: 'l2', qty: 5 }] }, { productId: 'pM', qty: 2 }]));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(rowsOf(ok, 0), [['l2', 5, 'CONFIRMED', null]]);
  assert.deepEqual(rowsOf(ok, 1).map((x) => [x[0], x[1]]), [['l1', 2]]);
  const cases: [unknown, number, string][] = [
    [[{ lotId: 'lb', qty: 1 }], 422, 'LOT_BLOCKED'],
    [[{ lotId: 'lx', qty: 1 }], 422, 'LOT_EXPIRED'],
    [[{ lotId: 'lo', qty: 1 }], 422, 'LOT_PRODUCT_MISMATCH'],
    [[{ lotId: 'nope', qty: 1 }], 422, 'LOT_NOT_FOUND'],
    [[{ lotId: 'l1', qty: 0.5 }], 422, 'LOT_QTY_INVALID'],
    [[{ lotId: 'l1', qty: 'x' }], 422, 'LOT_QTY_INVALID'],
  ];
  for (const [lots, status, code] of cases) {
    const r = await post(sale([{ productId: 'pM', qty: 1, lots }]));
    assert.deepEqual([r.status, r.body.code], [status, code], JSON.stringify(lots));
  }
  const tooMuch = await post(sale([{ productId: 'pM', qty: 5, lots: [{ lotId: 'l1', qty: 5 }] }, { productId: 'pM', qty: 2, lots: [{ lotId: 'l1', qty: 2 }] }]));
  assert.deepEqual([tooMuch.status, tooMuch.body.code], [409, 'LOT_STOCK_INSUFFICIENT'], 'التجميع على الأسطر قبل المقارنة (D26): ٧ > ٤');
  const decimals = await post(sale([{ productId: 'pM', qty: 1.00005 }]));
  assert.deepEqual([decimals.status, decimals.body.code], [422, 'LOT_QTY_INVALID'], 'أربع خانات في المسار الحيّ');
  reset(API); VAN();
  const viaKey = await post(sale([{ productId: 'pM', qty: 3, lots: [{ lotId: 'l2', qty: 3 }] }]));
  assert.equal(viaKey.status, 201, JSON.stringify(viaKey.body));
  assert.deepEqual(rowsOf(viaKey), [['l2', 3, 'CONFIRMED', null]], 'المفتاح صريحٌ كالإدارة');
});

test('المندوب حيّاً: صفوف lots مُهملة والخادم يوزّع FEFO، ويوم القياس يوم الخادم لا لحظة الجهاز (D23)', async () => {
  reset(REP); VAN();
  const r = await post(sale([{ productId: 'pM', qty: 3, lots: [{ lotId: 'l2', qty: 3 }] }]));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(rowsOf(r).map((x) => [x[0], x[1]]), [['l1', 3]]);
  reset(REP);
  load('pM', [{ lotId: 'lx', qty: 5 }, { lotId: 'le', qty: 5 }, { lotId: 'l2', qty: 10 }]);
  const threeDaysAgo = new Date(Date.parse(`${addDays(TODAY, -3)}T09:00:00Z`)).toISOString();
  const live = await post(sale([{ productId: 'pM', qty: 3 }], { clientRef: crypto.randomUUID(), clientCreatedAt: threeDaysAgo }));
  assert.equal(live.status, 201, JSON.stringify(live.body));
  assert.deepEqual(rowsOf(live).map((x) => [x[0], x[1]]), [['le', 3]], 'المنتهي أمس لا يُباع، ويوم الانتهاء آخر يومٍ صالح');
});

test('الإعادة دون اتصال (R6): يوم البيع من لحظة الجهاز، والتلميح من موقوفٍ مقبولٌ بوسمه وإشعار، والحصر موسوم', async () => {
  reset(REP);
  load('pM', [{ lotId: 'lx', qty: 5 }, { lotId: 'l2', qty: 10 }, { lotId: 'lb', qty: 2 }]);
  const replay = { 'X-FS-Replay': '1' };
  const at = (n: number) => new Date(Date.parse(`${addDays(TODAY, n)}T09:00:00Z`)).toISOString();
  const r = await post(sale([{ productId: 'pM', qty: 3 }], { clientRef: crypto.randomUUID(), clientCreatedAt: at(-3) }), replay);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(rowsOf(r).map((x) => [x[0], x[1], x[3]]), [['lx', 3, null]], 'lx لم تنتهِ يوم البيع');
  const hinted = await post(sale([{ productId: 'pM', qty: 2, lots: [{ lotId: 'lb', qty: 2 }] }], { clientRef: crypto.randomUUID(), clientCreatedAt: at(-1) }), replay);
  assert.equal(hinted.status, 201, JSON.stringify(hinted.body));
  assert.deepEqual(rowsOf(hinted).map((x) => [x[0], x[1], x[3]]), [['lb', 2, 'REPLAY_RECALLED']], 'الورقة = السجل (D16)');
  assert.ok(hinted.body.warnings.some((w: Row) => w.code === 'LOT_REPLAY_FLAGGED'));
  assert.equal(db.notifications.filter((n) => n.type === 'LOT_REPLAY_FLAGGED').length, 1, 'إشعارٌ داخل المعاملة');
  const clamped = await post(sale([{ productId: 'pM', qty: 1 }], { clientRef: crypto.randomUUID(), clientCreatedAt: at(-10) }), replay);
  assert.equal(clamped.status, 201, JSON.stringify(clamped.body));
  assert.ok(rowsOf(clamped).every((x) => String(x[3]).includes('REPLAY_CLAMPED')), 'الحصر بسبعة أيام موسوم');
  assert.equal(db.notifications.filter((n) => n.type === 'LOT_REPLAY_FLAGGED').length, 2);
  // المفتاح لا ينال الإعادة: ترويسته تُمحى، فيُقاس يوم الخادم والصريح صارم
  reset(API);
  load('pM', [{ lotId: 'lx', qty: 5 }, { lotId: 'l2', qty: 10 }]);
  const key = await post(sale([{ productId: 'pM', qty: 1, lots: [{ lotId: 'lx', qty: 1 }] }], { clientRef: crypto.randomUUID(), clientCreatedAt: at(-3) }), replay);
  assert.deepEqual([key.status, key.body.code], [422, 'LOT_EXPIRED']);
});

test('D20: إعادةٌ لا يكفيها رصيد الصنف الفعلي ⇒ 409 LOT_REPLAY_HELD بلا فاتورة ولا سالب، وإشعارٌ واحد لكل clientRef', async () => {
  reset(REP); VAN();
  const body = sale([{ productId: 'pM', qty: 30 }], { clientRef: crypto.randomUUID(), clientCreatedAt: new Date().toISOString() });
  for (let i = 0; i < 2; i++) {
    const r = await post(body, { 'X-FS-Replay': '1' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'LOT_REPLAY_HELD');
    assert.equal(r.body.detail.missing, 10);
  }
  assert.equal(db.invoices.length, 0);
  const held = db.notifications.filter((n) => n.type === 'LOT_REPLAY_HELD');
  assert.equal(held.length, 1, 'مرةً واحدة لكل clientRef');
  assert.match(held[0].body, /«حليب»/);
  assert.equal(JSON.parse(held[0].data).clientRef, body.clientRef);
});

test('ClientRefRace: طلبان متزامنان بالمرجع نفسه ⇒ 201 ثم 200 بالفاتورة القائمة، وتوزيعٌ واحد', async () => {
  reset(REP); VAN();
  txDelayMs = 60;
  const body = sale([{ productId: 'pM', qty: 15 }], { clientRef: crypto.randomUUID() });
  const [a, b] = await Promise.all([post(body), post(body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.body, b.body]));
  const dup = a.status === 200 ? a : b;
  assert.equal(dup.body.idempotent, true);
  assert.equal(db.invoices.length, 1);
  assert.equal(db.invoiceItemLots.reduce((s, r) => s + r.quantity, 0), 15, 'لا توزيع ثانٍ');
});

test('الأخطاء: LotError برمزه، و55P03 على قفل اللوط ⇒ 503 LOT_BUSY، وP2028 ⇒ 503 في مسار اللوط وحده', async () => {
  reset(); VAN();
  failExec = (sql) => (sql.includes('pg_advisory_xact_lock') ? Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } }) : null);
  const busy = await post(sale([{ productId: 'pM', qty: 1 }]));
  assert.deepEqual([busy.status, busy.body.code], [503, 'LOT_BUSY']);
  assert.equal(db.invoices.length, 0);
  failExec = null;
  failCreate = Object.assign(new Error('Transaction already closed'), { code: 'P2028' });
  const t1 = await post(sale([{ productId: 'pM', qty: 1 }]));
  assert.deepEqual([t1.status, t1.body.code], [503, 'LOT_BUSY']);
  load('pW', [{ lotId: null, qty: 10 }]);
  const t2 = await post(sale([{ productId: 'pW', qty: 1 }]));
  assert.equal(t2.status, 500, 'غير المتتبَّع: لا يُوسَم انشغالاً');
  assert.equal(t2.body.code, undefined);
});

test('D25: صنفٌ صار متتبَّعاً بين القراءة المسبقة والقفل ⇒ 503 LOT_BUSY بلا فاتورة، وإعادة الطلب توزّعه', async () => {
  reset();
  load('pW', [{ lotId: null, qty: 10 }]);
  onRouteProductLock = () => { db.products[1].lotTracked = true; };
  const r = await post(sale([{ productId: 'pW', qty: 3 }]));
  assert.deepEqual([r.status, r.body.code, r.body.detail?.reason], [503, 'LOT_BUSY', 'TRACKING_CHANGED'], JSON.stringify(r.body));
  assert.equal(db.invoices.length, 0);
  db.products[1].lotTracked = true; // التبديل التزم مستقلاً (المعاملة المزيّفة أعادت لقطتها عند الرمي)
  const again = await post(sale([{ productId: 'pW', qty: 3 }]));
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.deepEqual(rowsOf(again).map((x) => [x[0], x[1], x[2]]), [[null, 3, 'UNKNOWN']], 'من غير المسمّى (D17)');
  // والعكس: صنفٌ أُطفئ تتبّعه بين القراءتين يُصدر بلا صفوف (المجموعة الموثوقة ما تحت القفل)
  reset(); VAN();
  onRouteProductLock = () => { db.products[0].lotTracked = false; };
  const off = await post(sale([{ productId: 'pM', qty: 2 }]));
  assert.equal(off.status, 201, JSON.stringify(off.body));
  assert.equal(db.invoiceItemLots.length, 0);
});

test('D25 بالعكس لمندوبٍ بلا «البيع بدون مخزون»: صنفٌ تخطّاه الفحص القديم لأنه متتبَّع ثم أُطفئ تتبّعه قبل القفل ⇒ 503 TRACKING_CHANGED بلا فاتورة، وإعادته تمرّ بالفحص القديم', async () => {
  reset(REP); VAN(); // pM في السيارة: ٦ + ١٢ + ٢ = ٢٠
  db.reps[0].canSellWithoutStock = false;
  onRouteProductLock = () => { db.products[0].lotTracked = false; };
  const r = await post(sale([{ productId: 'pM', qty: 25 }]));
  assert.deepEqual([r.status, r.body.code, r.body.detail?.reason, r.body.detail?.productIds], [503, 'LOT_BUSY', 'TRACKING_CHANGED', ['pM']], JSON.stringify(r.body));
  assert.equal(db.invoices.length, 0, 'لا بيع فوق متبقّي السيارة بلا أي فحص');
  db.products[0].lotTracked = false; // الإطفاء التزم مستقلاً (المعاملة المزيّفة أعادت لقطتها عند الرمي)
  const again = await post(sale([{ productId: 'pM', qty: 25 }]));
  assert.equal(again.status, 403, JSON.stringify(again.body));
  assert.match(String(again.body.message), /تتجاوز مخزون سيارتك/);
  const fits = await post(sale([{ productId: 'pM', qty: 5 }]));
  assert.equal(fits.status, 201, JSON.stringify(fits.body));
  // من يملك الإذن لم يتخطَّ فحصاً: التوزيع يتكيّف مع المجموعة الموثوقة بلا خطأ (D25) — والمرتجع لا فحص له أصلاً
  reset(REP); VAN();
  onRouteProductLock = () => { db.products[0].lotTracked = false; };
  const perm = await post(sale([{ productId: 'pM', qty: 25 }]));
  assert.equal(perm.status, 201, JSON.stringify(perm.body));
  assert.equal(db.invoiceItemLots.length, 0);
  reset(REP); VAN();
  db.reps[0].canSellWithoutStock = false;
  onRouteProductLock = () => { db.products[0].lotTracked = false; };
  const ret = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', items: [{ productId: 'pM', qty: 2, unitPrice: 10 }] });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
});

test('allocateInvoiceLotsInTx (فرع المرحلة الثانية والإشعار الدائن): انتظار قفل اللوط 55P03/40P01 ⇒ LotError LOT_BUSY 503 لا خطأ قاعدة، وصنفٌ تخطّى الفحص القديم ثم أُطفئ ⇒ TRACKING_CHANGED (والفحص المسبق مثله)', async () => {
  reset(); VAN();
  const plan = (o: Row = {}) => ({
    tenantId: 't1', customerId: 'c1', vanKey: 'r1', docType: 'CASH' as const, link: 'NONE' as const, actor: 'ADMIN' as const,
    replay: null, day: TODAY, returnDay: null, allowUnknown: true, clientRef: null,
    lines: lotsInvoice.invoiceLotLines([{ productId: 'pM', productName: 'حليب', qty: 2, unitFactor: 1 }]), fallbackStamps: new Map(), ...o,
  });
  for (const [code, msg] of [['55P03', 'canceling statement due to lock timeout'], ['40P01', 'deadlock detected']]) {
    failExec = (sql) => (sql.includes('pg_advisory_xact_lock') ? Object.assign(new Error(msg), { code: 'P2010', meta: { code } }) : null);
    await assert.rejects(lotsInvoice.allocateInvoiceLotsInTx(prismaFake as never, plan()),
      (e: unknown) => e instanceof LotError && e.code === 'LOT_BUSY' && e.status === 503, code);
  }
  failExec = null;
  // الإشعار الدائن يصل catch مساره بـLotError كما هو (issuanceHttpError لا يعرفه فيعيد رميه) ⇒ lotReply ⇒ 503
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { issuanceHttpError } = require('../compliance/zatca/issue') as typeof import('../compliance/zatca/issue');
  assert.equal(issuanceHttpError(new LotError('LOT_BUSY', 'x', 503)), null);
  db.products[0].lotTracked = false;
  await assert.rejects(lotsInvoice.allocateInvoiceLotsInTx(prismaFake as never, plan({ stockCheckSkipped: ['pM'] })),
    (e: unknown) => e instanceof LotError && e.code === 'LOT_BUSY' && e.detail?.reason === 'TRACKING_CHANGED');
  const pre = await lotsInvoice.precheckInvoiceLots(prismaFake as never, plan({ stockCheckSkipped: ['pM'] }));
  assert.deepEqual([pre?.code, pre?.detail?.reason], ['LOT_BUSY', 'TRACKING_CHANGED'], 'لا يُوقَّع ما سيُرفض');
  const adapts = await lotsInvoice.allocateInvoiceLotsInTx(prismaFake as never, plan());
  assert.deepEqual([adapts.tracked.size, adapts.lines.size], [0, 0], 'بلا تخطٍّ: يتكيّف بلا خطأ (D25)');
});

// ═══ المرتجع ═══

test('المرتجع المرتبط: وراثة صفوف البيع بالأبعد انتهاءً أولاً، والسطر الثاني يرى ما أُرجع، والختم من التشغيلة بفاتورة البيع', async () => {
  reset(); VAN();
  const s = await post(sale([{ productId: 'pM', qty: 8 }]));
  assert.equal(s.status, 201);
  const saleId = s.body.data.id, saleItemId = s.body.data.items[0].id;
  const saleRows = new Map(db.invoiceItemLots.filter((r) => r.invoiceId === saleId).map((r) => [r.lotId, r.id]));
  const ret = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', originalInvoiceId: saleId, items: [{ productId: 'pM', invoiceItemId: saleItemId, qty: 2, unitPrice: 10 }] });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  const rows = db.invoiceItemLots.filter((r) => r.invoiceId === ret.body.data.id);
  assert.deepEqual(rows.map((r) => [r.lotId, r.quantity, r.certainty, r.sourceItemLotId]), [['l2', 2, 'ASSUMED', saleRows.get('l2')]], 'الأبعد انتهاءً أولاً');
  const item = db.invoiceItems.find((it) => it.invoiceId === ret.body.data.id)!;
  assert.deepEqual([new Date(item.expiresAt).toISOString().slice(0, 10), item.returnExpired, item.expirySaleInvoiceId], [addDays(TODAY, 40), false, saleId],
    'الختم من تشغيلة الصفّ الموروث (l2) لا من لقطة البيع (l1)');
  const ret2 = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', originalInvoiceId: saleId, items: [{ productId: 'pM', invoiceItemId: saleItemId, qty: 2, unitPrice: 10 }, { productId: 'pM', invoiceItemId: saleItemId, qty: 3, unitPrice: 10 }] });
  assert.equal(ret2.status, 201, JSON.stringify(ret2.body));
  const items2 = db.invoiceItems.filter((it) => it.invoiceId === ret2.body.data.id);
  assert.deepEqual(items2.map((it) => db.invoiceItemLots.filter((r) => r.invoiceItemId === it.id).map((r) => [r.lotId, r.quantity])), [[['l1', 2]], [['l1', 3]]],
    'المتاح لكل صفّ بعد المرتجع السابق، وسطران على بند بيعٍ واحد يتتابعان');
});

test('المرتجع المرتبط الهجين: صفٌّ منتهٍ يوم المرتجع ⇒ الأقرب انتهاءً أولاً، والبند كله إلى المنتهي (D6)', async () => {
  reset(REP);
  load('pM', [{ lotId: 'lx', qty: 5 }, { lotId: 'l2', qty: 10 }]);
  const at = new Date(Date.parse(`${addDays(TODAY, -3)}T09:00:00Z`)).toISOString();
  const s = await post(sale([{ productId: 'pM', qty: 7 }], { clientRef: crypto.randomUUID(), clientCreatedAt: at }), { 'X-FS-Replay': '1' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.deepEqual(rowsOf(s).map((x) => [x[0], x[1]]), [['lx', 5], ['l2', 2]]);
  currentUser = ADMIN;
  const ret = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', originalInvoiceId: s.body.data.id, items: [{ productId: 'pM', invoiceItemId: s.body.data.items[0].id, qty: 3, unitPrice: 10 }] });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assert.deepEqual(db.invoiceItemLots.filter((r) => r.invoiceId === ret.body.data.id).map((r) => [r.lotId, r.quantity]), [['lx', 3]]);
  const item = db.invoiceItems.find((it) => it.invoiceId === ret.body.data.id)!;
  assert.equal(item.returnExpired, true, 'المنتهي يدخل دلو المنتهي لا المتاح');
});

test('المرتجع الحرّ: المندوب «غير معروف» وختمه من آخر بيعٍ مختومٍ بالتشغيلة (D21)، والإدارة صريحٌ إلى موقوفة بتحذير', async () => {
  reset(); VAN();
  const s = await post(sale([{ productId: 'pM', qty: 3 }]));
  assert.equal(s.status, 201);
  currentUser = REP;
  const r = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', items: [{ productId: 'pM', qty: 2, unitPrice: 10, lots: [{ lotId: 'l2', qty: 2 }] }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(rowsOf(r), [[null, 2, 'UNKNOWN', null]], 'المندوب: غير معروف بلا نقرة (D5) — صفوفه مُهملة');
  const item = db.invoiceItems.find((it) => it.invoiceId === r.body.data.id)!;
  assert.deepEqual([new Date(item.expiresAt).toISOString().slice(0, 10), item.returnExpired, item.expirySaleInvoiceId],
    [addDays(TODAY, 10), false, s.body.data.id], 'لقطة آخر بيع محسوبةً قبل المعاملة ومكتوبةً داخلها');
  currentUser = ADMIN;
  const a = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', items: [{ productId: 'pM', qty: 2, unitPrice: 10, lots: [{ lotId: 'lb', qty: 2 }] }] });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual(rowsOf(a), [['lb', 2, 'CONFIRMED', null]]);
  assert.deepEqual(a.body.warnings.map((w: Row) => w.code), ['LOT_INTO_BLOCKED']);
  const aItem = db.invoiceItems.find((it) => it.invoiceId === a.body.data.id)!;
  assert.equal(new Date(aItem.expiresAt).toISOString().slice(0, 10), addDays(TODAY, 20), 'الختم من التشغيلة الصريحة');
  const bad = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', items: [{ productId: 'pM', qty: 1, unitPrice: 10, lots: [{ lotId: 'lo', qty: 1 }] }] });
  assert.deepEqual([bad.status, bad.body.code], [422, 'LOT_PRODUCT_MISMATCH']);
  const sum = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', items: [{ productId: 'pM', qty: 2, unitPrice: 10, lots: [{ lotId: 'l1', qty: 1 }] }] });
  assert.deepEqual([sum.status, sum.body.code], [422, 'LOT_QTY_INVALID']);
  // كل زيادةٍ لصنفٍ متتبَّع بأربع خانات (I1 مع تقريب الطيّ): مرتجعٌ بخمسٍ يُرفض حيّاً
  const fine = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', items: [{ productId: 'pM', qty: 1.00005, unitPrice: 10 }] });
  assert.deepEqual([fine.status, fine.body.code], [422, 'LOT_QTY_INVALID']);
  assert.equal(db.invoices.filter((i) => i.type === 'RETURN').length, 2, 'المرفوضة بلا مستند');
});

/** مرتجعٌ حرّ من الإدارة إلى تشغيلةٍ صريحة (أو غير معروف) — يزيد السيارة */
const freeReturn = (qty: number, lots?: unknown) => post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', items: [{ productId: 'pM', qty, unitPrice: 10, ...(lots !== undefined && { lots }) }] });
const cancel = (id: string) => call('PATCH', `/api/invoices/${id}/cancel`, { body: {} });
const restock = (id: string, returnToStock: boolean) => call('PATCH', `/api/invoices/${id}/restock`, { body: { returnToStock } });

test('إلغاء المرتجع: بيعت بضاعته من تشغيلةٍ مسمّاة ⇒ 409 (I1)، وإلا يُلغى تحت القفل بالمهلة الموسّعة', async () => {
  reset();
  load('pM', [{ lotId: 'l2', qty: 5 }]);
  const ret = await freeReturn(3, [{ lotId: 'l2', qty: 3 }]);
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assert.equal((await post(sale([{ productId: 'pM', qty: 8 }]))).status, 201);
  txOptions = []; calls = [];
  const c = await cancel(ret.body.data.id);
  assert.equal(c.status, 409, JSON.stringify(c.body));
  assert.equal(c.body.code, 'LOT_STOCK_INSUFFICIENT');
  assert.match(c.body.message, /لا يُلغى المرتجع: بيعت بضاعته من التشغيلة L2/);
  assert.equal(invoiceOf(ret.body.data.id)!.status, 'CONFIRMED');
  assert.deepEqual(txOptions, [LOT_TX]);
  reset();
  load('pM', [{ lotId: 'l2', qty: 5 }]);
  const ok = await freeReturn(3, [{ lotId: 'l2', qty: 3 }]);
  assert.equal((await post(sale([{ productId: 'pM', qty: 4 }]))).status, 201);
  calls = [];
  const c2 = await cancel(ok.body.data.id);
  assert.equal(c2.status, 200, JSON.stringify(c2.body));
  assert.equal(invoiceOf(ok.body.data.id)!.status, 'CANCELLED');
  assert.equal(lockCalls().length, 1);
});

test('إلغاء المرتجع: الفارغ وبندٌ بلا صفوف (قبل التتبّع) على غير المسمّى (I2)، وإلغاء البيع بلا قفل لوط', async () => {
  reset(REP);
  load('pM', [{ lotId: 'l2', qty: 5 }]);
  const ret = await freeReturn(2);
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  currentUser = ADMIN;
  assert.equal((await post(sale([{ productId: 'pM', qty: 7 }]))).status, 201, 'l2 ٥ ثم غير المسمّى ٢');
  const c = await cancel(ret.body.data.id);
  assert.deepEqual([c.status, c.body.code], [409, 'LOT_STOCK_INSUFFICIENT'], JSON.stringify(c.body));
  assert.match(c.body.message, /الرصيد غير المسمّى/);
  // بندٌ كُتب قبل تتبّع صنفه: بلا صفوف، وكميته في غير المسمّى عبر رصيد الصنف
  reset();
  load('pM', [{ lotId: 'l2', qty: 5 }]);
  db.invoices.push({ id: 'old-ret', tenantId: 't1', number: 'RET-OLD', customerId: 'c1', salesRepId: 'r1', type: 'RETURN', status: 'CONFIRMED', returnToStock: true, returnReason: 'NORMAL', invoiceDate: OLD, createdAt: OLD, zatcaPhase: null, paidAmt: 0 });
  db.invoiceItems.push({ id: 'old-ii', invoiceId: 'old-ret', productId: 'pM', qty: 3, unitFactor: 1, baseQty: 3, returnExpired: null, returnOfItemId: null });
  assert.equal((await post(sale([{ productId: 'pM', qty: 6 }]))).status, 201, 'l2 ٥ ثم غير المسمّى ١ — يبقى ٢');
  const old = await cancel('old-ret');
  assert.deepEqual([old.status, old.body.code], [409, 'LOT_STOCK_INSUFFICIENT'], 'إزالة ٣ من غير المسمّى ٢ تكسر I2');
  // إلغاء البيع زيادةٌ خالصة: بلا طابور ولا قفل لوط ولا مهلة جديدة
  reset(); VAN();
  const s = await post(sale([{ productId: 'pM', qty: 2 }]));
  calls = []; txOptions = [];
  const cs = await cancel(s.body.data.id);
  assert.equal(cs.status, 200, JSON.stringify(cs.body));
  assert.deepEqual([lockCalls().length, txOptions], [0, [undefined]]);
  // مرتجعٌ لصنفٍ غير متتبَّع والميزة مفعّلة: لا حارس ولا قفل لوط ولا مهلة جديدة — وحدها إعادة قراءة التتبّع FOR KEY SHARE (D25)
  load('pW', [{ lotId: null, qty: 2 }]);
  const wr = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', items: [{ productId: 'pW', qty: 1, unitPrice: 2 }] });
  assert.equal(wr.status, 201, JSON.stringify(wr.body));
  assert.equal((await post(sale([{ productId: 'pW', qty: 3 }]))).status, 201);
  calls = []; txOptions = [];
  const cw = await cancel(wr.body.data.id);
  assert.equal(cw.status, 200, JSON.stringify(cw.body));
  assert.deepEqual([lockCalls().length, txOptions], [0, [undefined]], 'غير المتتبَّع: لا قفل لوط ولا مهلة جديدة');
  const inTx = calls.slice(calls.indexOf('$transaction'), calls.indexOf('invoice.update'));
  assert.ok(!inTx.includes('tenant.findUnique') && !inTx.includes('invoice.findFirst'), `لا قراءة شركةٍ ولا بنودٍ وصفوف داخل المعاملة: ${inTx.join(' | ')}`);
  assert.deepEqual(inTx.filter((c) => c.includes('FOR KEY SHARE')).map((c) => c.split(' WHERE')[0]), ['$queryRaw SELECT id, "lotTracked" FROM products'],
    'قراءة التتبّع تحت القفل وحدها');
  assert.ok(!inTx.some((c) => c.includes('van_load_item_lots') || c.includes('invoice_item_lots')), 'لا عرض سيارة');
});

test('D25 في الإزالة: مرتجعٌ قُرئت أصنافه غير متتبَّعة ثم صار أحدها متتبَّعاً قبل الكتابة ⇒ 503 TRACKING_CHANGED بلا تغيير، وإعادته تمرّ بالحارس (إطفاء العودة والإلغاء)', async () => {
  // غير المسمّى ٢، ثم مرتجعٌ حرّ ٣ قبل التتبّع (بلا صفوف)، ثم بيع ٤ ⇒ يبقى ١. إزالة المرتجع بعد التتبّع تُنقصه إلى −٢ < min(0, 1) (I2)
  for (const mode of ['restock', 'cancel'] as const) {
    reset();
    load('pW', [{ lotId: null, qty: 2 }]);
    const ret = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', items: [{ productId: 'pW', qty: 3, unitPrice: 2 }] });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    assert.equal((await post(sale([{ productId: 'pW', qty: 4 }]))).status, 201);
    const since = new Date();
    const track = () => { Object.assign(db.products[1], { lotTracked: true, lotTrackedSince: since }); };
    const act = () => (mode === 'restock' ? restock(ret.body.data.id, false) : cancel(ret.body.data.id));
    onRouteProductLock = track; // التبديل يلتزم بين القراءة المسبقة وقراءة التتبّع داخل المعاملة
    calls = []; txOptions = [];
    const r = await act();
    assert.deepEqual([r.status, r.body.code, r.body.detail?.reason], [503, 'LOT_BUSY', 'TRACKING_CHANGED'], `${mode}: ${JSON.stringify(r.body)}`);
    assert.deepEqual([invoiceOf(ret.body.data.id)!.status, invoiceOf(ret.body.data.id)!.returnToStock], ['CONFIRMED', true], mode);
    assert.deepEqual([lockCalls().length, txOptions], [0, [undefined]], `${mode}: بلا قفل لوط ولا مهلة جديدة`);
    track(); // التبديل التزم مستقلاً (المعاملة المزيّفة أعادت لقطتها عند الرمي)
    const again = await act();
    assert.deepEqual([again.status, again.body.code], [409, 'LOT_STOCK_INSUFFICIENT'], `${mode}: ${JSON.stringify(again.body)}`);
    assert.deepEqual([invoiceOf(ret.body.data.id)!.status, invoiceOf(ret.body.data.id)!.returnToStock], ['CONFIRMED', true], mode);
  }
});

test('restock: الإطفاء والبضاعة مبيعة ⇒ 409 (I1)، والإطفاء الممكن يُقفل ويُحدَّث، والتشغيل إلى true زيادةٌ بلا قفل', async () => {
  reset();
  load('pM', [{ lotId: 'l2', qty: 5 }]);
  const ret = await freeReturn(3, [{ lotId: 'l2', qty: 3 }]);
  assert.equal((await post(sale([{ productId: 'pM', qty: 8 }]))).status, 201);
  const off = await restock(ret.body.data.id, false);
  assert.deepEqual([off.status, off.body.code], [409, 'LOT_STOCK_INSUFFICIENT'], JSON.stringify(off.body));
  assert.match(off.body.message, /لا تُطفأ عودة المرتجع للمخزون/);
  assert.equal(invoiceOf(ret.body.data.id)!.returnToStock, true);
  reset();
  load('pM', [{ lotId: 'l2', qty: 5 }]);
  const ret2 = await freeReturn(3, [{ lotId: 'l2', qty: 3 }]);
  calls = []; txOptions = [];
  const off2 = await restock(ret2.body.data.id, false);
  assert.equal(off2.status, 200, JSON.stringify(off2.body));
  assert.equal(invoiceOf(ret2.body.data.id)!.returnToStock, false);
  assert.deepEqual([lockCalls().length, txOptions], [1, [LOT_TX]]);
  assert.ok(calls.some((c) => c.includes('FROM invoices WHERE id =')), 'قفل صفّ المرتجع');
  calls = []; txOptions = [];
  const on = await restock(ret2.body.data.id, true);
  assert.equal(on.status, 200);
  assert.deepEqual([lockCalls().length, txOptions], [0, []], 'التشغيل: السلوك القائم');
  db.tenant.lotTrackingEnabled = false;
  const offDisabled = await restock(ret2.body.data.id, false);
  assert.equal(offDisabled.status, 200);
  assert.deepEqual(txOptions, [], 'الميزة مطفأة: لا معاملة ولا قفل');
  // مرتجعٌ لصنفٍ غير متتبَّع والميزة مفعّلة: إعادة قراءة التتبّع FOR KEY SHARE وحدها (D25) — لا حارس ولا قفل لوط ولا مهلة جديدة
  reset();
  load('pW', [{ lotId: null, qty: 2 }]);
  const wret = await post({ customerId: 'c1', salesRepId: 'r1', type: 'RETURN', items: [{ productId: 'pW', qty: 1, unitPrice: 2 }] });
  assert.equal(wret.status, 201, JSON.stringify(wret.body));
  calls = []; txOptions = [];
  const woff = await restock(wret.body.data.id, false);
  assert.equal(woff.status, 200, JSON.stringify(woff.body));
  assert.equal(invoiceOf(wret.body.data.id)!.returnToStock, false);
  assert.deepEqual([lockCalls().length, txOptions], [0, [undefined]]);
  assert.deepEqual(calls.filter((c) => c.includes('FOR KEY SHARE') || c.includes('FOR UPDATE') || c === 'tenant.findUnique').map((c) => c.split(' WHERE')[0]),
    ['$queryRaw SELECT id, "lotTracked" FROM products'], 'لا قفل صفّ المرتجع ولا قراءة شركة');
});

// ═══ الصلاحية ═══

test('الختم اللاحق يتخطّى البنود المختومة: بند المتتبَّع من تشغيلته داخل المعاملة يبقى، والمختوم بغير المسمّى يُكمله الختم اللاحق', async () => {
  reset(); VAN();
  Object.assign(db.products[0], { shelfLifeEnabled: true, shelfLifeValue: 100, shelfLifeUnit: 'DAY', shelfLifeBasis: 'SALE' });
  const r = await post(sale([{ productId: 'pM', qty: 2 }]));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(new Date(db.invoiceItems[0].expiresAt).toISOString().slice(0, 10), addDays(TODAY, 10), 'لا يُكتب فوقه تاريخ البيع + ١٠٠ يوم');
  reset();
  load('pM', [{ lotId: null, qty: 5 }]);
  Object.assign(db.products[0], { shelfLifeEnabled: true, shelfLifeValue: 100, shelfLifeUnit: 'DAY', shelfLifeBasis: 'SALE' });
  const u = await post(sale([{ productId: 'pM', qty: 2 }]));
  assert.equal(u.status, 201, JSON.stringify(u.body));
  const exp = db.invoiceItems[0].expiresAt;
  assert.ok(exp, 'بلا تشغيلة مسمّاة: اللقطة القائمة من الختم اللاحق');
  assert.ok(new Date(exp).getTime() > Date.now() + 90 * 86_400_000);
});

// ═══ الخدمة مباشرةً (يستعملها فرع المرحلة الثانية — B6) ═══

test('precheckInvoiceLots: بلا قفل — يعيد LotError لما سيُرفض حتماً وnull لما يمرّ، والصنف غير المتتبَّع بلا فحص', async () => {
  reset(); VAN();
  const plan = (qty: number, productId = 'pM') => ({
    tenantId: 't1', customerId: 'c1', vanKey: 'r1', docType: 'CASH' as const, link: 'NONE' as const, actor: 'ADMIN' as const,
    replay: null, day: TODAY, returnDay: null, allowUnknown: true, clientRef: null,
    lines: lotsInvoice.invoiceLotLines([{ productId, productName: 'حليب', qty, unitFactor: 1 }]), fallbackStamps: new Map(),
  });
  calls = [];
  const bad = await lotsInvoice.precheckInvoiceLots(prismaFake as never, plan(25));
  assert.equal(bad?.code, 'LOT_STOCK_INSUFFICIENT');
  assert.equal(await lotsInvoice.precheckInvoiceLots(prismaFake as never, plan(5)), null);
  assert.equal(await lotsInvoice.precheckInvoiceLots(prismaFake as never, plan(500, 'pW')), null);
  assert.deepEqual(lockCalls(), [], 'لا قفل في الفحص المسبق');
  assert.equal(db.invoiceItemLots.length, 0);
  // الكمية الأساسية ومعامل اللقطة في أسطر الخطة (D22)
  assert.deepEqual(lotsInvoice.invoiceLotLines([{ productId: 'pM', productName: 'x', qty: 2, unitFactor: 6, lots: [{ lotId: 'l1', qty: 12 }] }])
    .map((l) => [l.qty, l.unitFactor, l.lotsRaw]), [[12, 6, [{ lotId: 'l1', qty: 12 }]]]);
  // لحظة المستند: المفتاح والإدارة بيوم الخادم، والمندوب بالإعادة محصورةً
  const now = new Date();
  const base = { replayHeader: true, clientRef: 'x', clientCreatedAt: new Date(now.getTime() - 10 * 86_400_000).toISOString(), now, tz: TZ, serverDay: TODAY, isReturn: true };
  assert.deepEqual(lotsInvoice.invoiceLotMoment({ ...base, actor: 'API_KEY' }), { replay: null, day: TODAY, returnDay: TODAY });
  const m = lotsInvoice.invoiceLotMoment({ ...base, actor: 'REP' });
  assert.equal(m.replay?.clamped, true);
  assert.equal(m.day, localDateIn(new Date(now.getTime() - 7 * 86_400_000), TZ));
  assert.equal(lotsInvoice.invoiceLotMoment({ ...base, actor: 'REP', clientRef: null }).replay, null, 'بلا مرجع: لا إعادة');
});

// ═══ D25: علم الشركة المطفأ في القراءة المسبقة (البوابة B-d25-guards) ═══

test('D25 (علم الشركة): مطفأٌ في القراءة المسبقة ثم فُعّل قبل القفل وصنفٌ مقفل متتبَّع ⇒ 503 TRACKING_CHANGED بلا فاتورة، وإعادته توزّعه', async () => {
  reset(); VAN();
  db.tenant.lotTrackingEnabled = false; // pM يحمل علمه من حقبةٍ سابقة (الإطفاء يُخفي ولا يحذف، D8)
  const enable = () => { Object.assign(db.tenant, { lotTrackingEnabled: true, lotTrackingSince: new Date() }); };
  onRouteProductLock = enable; // التفعيل يلتزم بين قراءة صفّ المندوب وقفل الأصناف داخل المعاملة
  const r = await post(sale([{ productId: 'pM', qty: 2 }]));
  assert.deepEqual([r.status, r.body.code, r.body.detail?.reason, r.body.detail?.productIds], [503, 'LOT_BUSY', 'TRACKING_CHANGED', ['pM']], JSON.stringify(r.body));
  assert.equal(db.invoices.length, 0, 'بيعٌ بلا توزيع لصنفٍ متتبَّع في حقبةٍ جديدة');
  enable(); // التفعيل التزم مستقلاً (المعاملة المزيّفة أعادت لقطتها عند الرمي)
  const again = await post(sale([{ productId: 'pM', qty: 2 }]));
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.ok(db.invoiceItemLots.length > 0, 'الإعادة تأخذ مسار اللوط فتكتب صفوف التوزيع');
});

test('D25 (علم الشركة) §١٠.١: ما زال مطفأً ⇒ كما كان بلا صفوف ولا قفل لوط (قراءةٌ واحدة للعلم لصفٍّ مقفل متتبَّع وحده)، وغير المتتبَّع بلا قراءة', async () => {
  const tenantReadsInTx = () => {
    const from = calls.indexOf('$transaction');
    return calls.slice(from, calls.indexOf('invoice.create', from)).filter((c) => c === 'tenant.findUnique').length;
  };
  reset(); VAN();
  db.tenant.lotTrackingEnabled = false;
  calls = [];
  const stale = await post(sale([{ productId: 'pM', qty: 2 }]));
  assert.equal(stale.status, 201, JSON.stringify(stale.body));
  assert.equal(db.invoiceItemLots.length, 0);
  assert.equal(lockCalls().length, 0);
  assert.equal(tenantReadsInTx(), 1, 'علم الشركة يُعاد قراءته تحت قفل الصفّ المتتبَّع');
  reset();
  load('pW', [{ lotId: null, qty: 10 }]);
  db.tenant.lotTrackingEnabled = false;
  calls = [];
  const plain = await post(sale([{ productId: 'pW', qty: 2 }]));
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(tenantReadsInTx(), 0, 'لا صفّ مقفل متتبَّع ⇒ لا استعلام زائد');
});
