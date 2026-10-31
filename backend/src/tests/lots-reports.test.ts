// «تتبّع اللوط» — التقارير (المواصفة §٨.٢ lots-reports، الحزمة B8): GET /reports/lot-sales بالنطاق والفرق والعَلَم والمدى
// والوحدات المتعددة (الكميات بالأساس D22)، وwithLots=1 في تقرير المرتجع. المسارات فوق Prisma مزيّف في الذاكرة — بلا قاعدة —
// مع الحارس الحقيقي requireLots ونطاق المستخدم الحقيقي (services/adminScope): المزيّف يفسّر شروط Prisma ويرمي على أي مفتاحٍ
// أو عمليةٍ لا يعرفها (ومنها كل كتابة)، فشرطٌ يسقط أو يتغيّر يظهر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';
import { baseQtyOf } from '../services/units';
import type { LotMeta } from '../services/lots';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);

// ═══ البيانات ═══

/** لحظة بتوقيت الرياض (+3) — الشركة سعودية فأيامها أيام الرياض */
const RIY = (day: string, hour = 12, min = 0): Date => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 3, min));
};
const dayDate = (d: string | null): Date | null => (d ? new Date(`${d}T00:00:00.000Z`) : null);

const LOTS: Row[] = [
  { id: 'L1', tenantId: 't1', productId: 'p1', lotNumber: 'A100', productionDate: dayDate('2026-09-01'), expiryDate: dayDate('2026-11-10'), status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date('2026-09-02T08:00:00Z') },
  { id: 'L2', tenantId: 't1', productId: 'p1', lotNumber: 'A200', productionDate: dayDate('2026-09-15'), expiryDate: dayDate('2026-12-01'), status: 'BLOCKED', blockKind: 'RECALL', blockedAt: new Date('2026-10-25T08:00:00Z'), createdAt: new Date('2026-09-16T08:00:00Z') },
  { id: 'L3', tenantId: 't1', productId: 'p2', lotNumber: 'B1', productionDate: null, expiryDate: null, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date('2026-09-20T08:00:00Z') },
  { id: 'LX', tenantId: 't2', productId: 'p9', lotNumber: 'X', productionDate: null, expiryDate: null, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date('2026-09-20T08:00:00Z') },
];
const lotById = new Map(LOTS.map((l) => [l.id, l]));
/** حليبٌ أساسه «حبة» وكرتونه ٢٤ (ووحدةٌ موقوفة لا تُعرض)، ولبنٌ بوحدةٍ واحدة */
const PRODUCTS: Row[] = [
  { id: 'p1', tenantId: 't1', name: 'حليب', code: 'P1', unit: 'حبة', units: [{ name: 'كرتون', factor: 24, isActive: true }, { name: 'نصف كرتون', factor: 12, isActive: false }] },
  { id: 'p2', tenantId: 't1', name: 'لبن', code: 'P2', unit: 'علبة', units: [] },
  { id: 'p9', tenantId: 't2', name: 'صنف شركة أخرى', code: 'P9', unit: 'حبة', units: [] },
];
const CUSTOMERS: Record<string, Row> = {
  c1: { id: 'c1', name: 'بقالة النور', phone: '0500000001', city: 'الرياض' },
  c2: { id: 'c2', name: 'تموينات الفجر', phone: '0500000002', city: 'جدة' },
  c3: { id: 'c3', name: 'سوبرماركت الريم', phone: '0500000003', city: 'الدمام' },
};
const REPS: Record<string, Row> = { r1: { id: 'r1', name: 'سالم' }, r2: { id: 'r2', name: 'فهد' } };
const TEAMS: Record<string, Row> = { T1: { id: 'T1', name: 'فريق الشمال' }, T2: { id: 'T2', name: 'فريق الجنوب' } };

interface LotSpec { lot: string | null; qty: number; certainty?: string; tenantId?: string }
/** qty بوحدة السطر ومعامله (كرتون ٢٤)؛ صفوف اللوط بالأساس (D22) */
interface ItemSpec { id: string; productId: string; qty: number; factor?: number; unitName?: string | null; lots?: LotSpec[]; returnOfItemId?: string | null }
interface InvSpec {
  id: string; tenantId?: string; type: 'CASH' | 'CREDIT' | 'RETURN'; status?: string; at: Date; customerId: string;
  salesRepId?: string | null; teamId?: string | null; documentKind?: string | null; items: ItemSpec[];
}
let lotSeq = 0;
function inv(s: InvSpec): Row {
  const tenantId = s.tenantId ?? 't1';
  const rep = s.salesRepId === undefined ? 'r1' : s.salesRepId;
  const team = s.teamId === undefined ? null : s.teamId;
  const items = s.items.map((it) => {
    const p = PRODUCTS.find((x) => x.id === it.productId)!;
    const factor = it.factor ?? 1;
    const lots = (it.lots ?? []).map((l) => ({
      id: `il${String(++lotSeq).padStart(6, '0')}`, invoiceItemId: it.id, invoiceId: s.id, tenantId: l.tenantId ?? tenantId, productId: it.productId, vanKey: rep,
      lotId: l.lot, quantity: l.qty, certainty: l.certainty ?? 'CONFIRMED',
      expiryDate: l.lot ? lotById.get(l.lot)!.expiryDate : null, sourceItemLotId: null, flags: null,
      createdAt: new Date(s.at.getTime() + lotSeq),
    }));
    const row = {
      id: it.id, productId: it.productId, qty: it.qty, unitName: it.unitName ?? (factor > 1 ? 'كرتون' : null), unitFactor: factor, baseQty: it.qty * factor,
      lineTotal: 10, returnExpired: null, expiresAt: null, returnOfItemId: it.returnOfItemId ?? null, itemName: p.name,
      product: { name: p.name, unit: p.unit }, lots,
    };
    // I3: Σ صفوف التوزيع = الكمية الأساسية للبند — صفّ لوطٍ معطوب لشركةٍ أخرى مستثنى (يُسقطه شرط الشركة)
    const own = lots.filter((l) => l.tenantId === tenantId);
    if (own.length) assert.equal(own.reduce((t, l) => t + l.quantity, 0), baseQtyOf(row), `I3 في بيانات الاختبار: ${it.id}`);
    return row;
  });
  const row: Row = {
    id: s.id, tenantId, type: s.type, status: s.status ?? 'CONFIRMED', invoiceDate: s.at, createdAt: s.at,
    number: `N-${s.id}`, total: 100, taxAmt: 15, returnReason: s.type === 'RETURN' ? 'NORMAL' : null, returnToStock: s.type === 'RETURN' ? true : null,
    documentKind: s.documentKind ?? null, notes: null, originalInvoice: null,
    customerId: s.customerId, customer: CUSTOMERS[s.customerId] ?? { id: s.customerId, name: s.customerId, phone: '', city: null },
    salesRepId: rep, salesRep: rep ? REPS[rep] : null, teamId: team, team: team ? TEAMS[team] : null, items,
  };
  for (const it of items) (it as Row).invoice = row; // علاقة البند بفاتورته (invoiceItem.findMany في تقرير المرتجع)
  return row;
}

/**
 * المجموعة الأساسية: مبيعات ومرتجعات في ١٠–٢٠ أكتوبر، وما يجب ألا يدخل (ملغاة، قبل المدى، بلا لوط، صفٌّ لشركة أخرى).
 * الوحدات: S1 سطرٌ بكرتونين (٤٨ حبة على L1 وL2) وسطرٌ بخمس حبّات للصنف نفسه، وR1 يُرجع حبّةً وكرتوناً مقسوماً على لوطين.
 */
function baseInvoices(): Row[] {
  lotSeq = 0;
  return [
    inv({ id: 'S1', type: 'CASH', at: RIY('2026-10-10', 10), customerId: 'c1', salesRepId: 'r1', teamId: 'T1', items: [
      { id: 'S1a', productId: 'p1', qty: 2, factor: 24, lots: [{ lot: 'L1', qty: 40, certainty: 'ASSUMED' }, { lot: 'L2', qty: 8, certainty: 'ASSUMED' }] },
      { id: 'S1c', productId: 'p1', qty: 5, lots: [{ lot: 'L1', qty: 5 }] },
      { id: 'S1b', productId: 'p2', qty: 3, lots: [{ lot: 'L3', qty: 3 }] },
    ] }),
    // ٠٠:٣٠ بتوقيت الرياض يوم ١٢ = ٢١:٣٠ UTC يوم ١١ — يوم الشركة لا يوم UTC
    inv({ id: 'S2', type: 'CREDIT', at: RIY('2026-10-12', 0, 30), customerId: 'c2', salesRepId: 'r2', teamId: 'T2', items: [
      { id: 'S2a', productId: 'p1', qty: 1, factor: 24, lots: [{ lot: 'L1', qty: 24 }] },
      { id: 'S2b', productId: 'p1', qty: 6, lots: [{ lot: null, qty: 6, certainty: 'UNKNOWN' }] },
    ] }),
    inv({ id: 'S3', type: 'CASH', status: 'CANCELLED', at: RIY('2026-10-12'), customerId: 'c1', items: [{ id: 'S3a', productId: 'p1', qty: 100, lots: [{ lot: 'L1', qty: 100 }] }] }),
    // فاتورة المكتب بلا مندوب (يراها المقيّد بقوائمه إن كان عميلها في نطاقه)، وبلا فريق
    inv({ id: 'S4', type: 'CASH', at: RIY('2026-10-12'), customerId: 'c1', salesRepId: null, teamId: null, items: [{ id: 'S4a', productId: 'p1', qty: 2, lots: [{ lot: 'L1', qty: 2 }] }] }),
    // ٢٣:٥٩ بتوقيت الرياض يوم ٩ — قبل المدى
    inv({ id: 'S5', type: 'CASH', at: RIY('2026-10-09', 23, 59), customerId: 'c1', teamId: 'T1', items: [{ id: 'S5a', productId: 'p1', qty: 7, lots: [{ lot: 'L1', qty: 7 }] }] }),
    inv({ id: 'S6', type: 'CASH', at: RIY('2026-10-20', 9), customerId: 'c3', salesRepId: 'r1', teamId: 'T1', items: [{ id: 'S6a', productId: 'p1', qty: 1, lots: [{ lot: 'L2', qty: 1 }] }] }),
    // صنفٌ غير متتبَّع: بلا صفوف لوط فلا يدخل تقرير التشغيلات
    inv({ id: 'S7', type: 'CASH', at: RIY('2026-10-11'), customerId: 'c1', teamId: 'T1', items: [{ id: 'S7a', productId: 'p2', qty: 9 }] }),
    // صفّ لوطٍ معطوب يحمل شركة أخرى داخل فاتورة الشركة — شرط الشركة على الصفوف نفسها يُسقطه
    inv({ id: 'S8', type: 'CASH', at: RIY('2026-10-11'), customerId: 'c1', teamId: 'T1', items: [{ id: 'S8a', productId: 'p1', qty: 50, lots: [{ lot: 'L1', qty: 50, tenantId: 't2' }] }] }),
    inv({ id: 'R1', type: 'RETURN', at: RIY('2026-10-13'), customerId: 'c1', salesRepId: 'r1', teamId: 'T1', items: [
      { id: 'R1a', productId: 'p1', qty: 1, lots: [{ lot: 'L1', qty: 1 }], returnOfItemId: 'S1a' },   // حبّةٌ من بند الكرتون
      { id: 'R1b', productId: 'p2', qty: 2 },
      { id: 'R1c', productId: 'p1', qty: 1, factor: 24, lots: [{ lot: 'L1', qty: 20, certainty: 'ASSUMED' }, { lot: 'L2', qty: 4, certainty: 'ASSUMED' }], returnOfItemId: 'S1a' },
    ] }),
    inv({ id: 'R2', type: 'RETURN', documentKind: 'CREDIT_NOTE', at: RIY('2026-10-14'), customerId: 'c2', salesRepId: 'r2', teamId: 'T2', items: [
      { id: 'R2a', productId: 'p1', qty: 2, lots: [{ lot: null, qty: 2, certainty: 'UNKNOWN' }] },
    ] }),
    inv({ id: 'Z1', tenantId: 't2', type: 'CASH', at: RIY('2026-10-11'), customerId: 'c9', salesRepId: null, items: [{ id: 'Z1a', productId: 'p9', qty: 9, lots: [{ lot: 'LX', qty: 9 }] }] }),
  ];
}

// ═══ Prisma مزيّف يفسّر الشروط ═══

let INVOICES: Row[] = [];
let tenantRow: Row = {};
const ADMINS: Record<string, Row> = {
  adm: { scopeEnabled: false, scopeMode: null },
  lst: { scopeEnabled: true, scopeMode: 'LISTS' },
  sup: { scopeEnabled: true, scopeMode: 'TEAMS' },
};
const CUSTOMER_SCOPE: Record<string, Set<string>> = { lst: new Set(['c1']) };
const REP_SCOPE: Record<string, Set<string>> = { lst: new Set(['r1']) };
const TEAM_SUPERVISORS: Record<string, Set<string>> = { T1: new Set(['sup']) };
let calls: { model: string; op: string; args: Row }[] = [];

function scalarOk(val: unknown, cond: unknown): boolean {
  if (!isObj(cond)) return val === cond;
  return Object.entries(cond).every(([op, x]) => {
    if (op === 'not') return isObj(x) ? !scalarOk(val, x) : val !== x;
    if (op === 'in') return (x as unknown[]).includes(val);
    if (op === 'gte') return val instanceof Date && val.getTime() >= (x as Date).getTime();
    if (op === 'lt') return val instanceof Date && val.getTime() < (x as Date).getTime();
    throw new Error(`عامل غير مدعوم في المزيّف: ${op}`);
  });
}
const adminOf = (v: Row, pathKeys: string[]): string => {
  let x: Row = v;
  for (const k of pathKeys) { assert.ok(isObj(x[k]), `شكل نطاق غير متوقَّع: ${JSON.stringify(v)}`); x = x[k]; }
  assert.equal(typeof x.adminId, 'string');
  return x.adminId as string;
};
function matchInvoice(r: Row, w: Row): boolean {
  return Object.entries(w).every(([k, v]) => {
    switch (k) {
      case 'AND': return (v as Row[]).every((x) => matchInvoice(r, x));
      case 'OR': return (v as Row[]).some((x) => matchInvoice(r, x));
      case 'customer': return CUSTOMER_SCOPE[adminOf(v, ['adminScopes', 'some'])]?.has(r.customerId) === true;
      case 'salesRep': return r.salesRepId != null && REP_SCOPE[adminOf(v, ['adminScopes', 'some'])]?.has(r.salesRepId) === true;
      case 'team': return r.teamId != null && TEAM_SUPERVISORS[r.teamId]?.has(adminOf(v, ['supervisors', 'some'])) === true;
      case 'items': assert.ok(isObj(v.some)); return r.items.some((it: Row) => matchItem(it, v.some));
      case 'tenantId': case 'status': case 'type': case 'invoiceDate': case 'customerId': case 'salesRepId': case 'teamId': case 'id':
        return scalarOk(r[k], v);
      default: throw new Error(`مفتاح فاتورة غير مدعوم في المزيّف: ${k}`);
    }
  });
}
function matchItem(it: Row, w: Row): boolean {
  return Object.entries(w).every(([k, v]) => {
    if (k === 'lots') { assert.ok(isObj(v.some)); return it.lots.some((l: Row) => matchLot(l, v.some)); }
    if (k === 'invoice') return matchInvoice(it.invoice, v);
    if (k === 'id') return scalarOk(it.id, v);
    throw new Error(`مفتاح بند غير مدعوم في المزيّف: ${k}`);
  });
}
function matchLot(l: Row, w: Row): boolean {
  return Object.entries(w).every(([k, v]) => {
    if (['tenantId', 'productId', 'lotId', 'invoiceId', 'id'].includes(k)) return scalarOk(l[k], v);
    throw new Error(`مفتاح صفّ لوط غير مدعوم في المزيّف: ${k}`);
  });
}
function matchUnit(u: Row, w: Row): boolean {
  return Object.entries(w).every(([k, v]) => {
    if (k === 'isActive') return u.isActive === v;
    throw new Error(`مفتاح وحدة غير مدعوم في المزيّف: ${k}`);
  });
}
const MATCHERS: Record<string, (row: Row, w: Row) => boolean> = { items: matchItem, lots: matchLot, units: matchUnit };
const sortBy = (rows: Row[], orderBy: Row | Row[] | undefined): Row[] => {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => Object.entries(o)[0] as [string, 'asc' | 'desc']);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] instanceof Date ? a[k].getTime() : a[k];
      const y = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
};
function project(row: Row, select: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) { out[k] = row[k]; continue; }
    assert.ok(isObj(v), `select غير مدعوم: ${k}`);
    const child = row[k];
    if (Array.isArray(child)) {
      const xs = sortBy(v.where ? child.filter((c: Row) => MATCHERS[k](c, v.where)) : child, v.orderBy);
      out[k] = xs.map((c: Row) => (v.select ? project(c, v.select) : { ...c }));
    } else out[k] = child == null ? null : v.select ? project(child, v.select) : { ...child };
  }
  return out;
}
const allItems = (): Row[] => INVOICES.flatMap((i) => i.items);
const allItemLots = (): Row[] => allItems().flatMap((it) => it.lots.map((l: Row) => ({ ...l, lot: l.lotId ? lotById.get(l.lotId) ?? null : null })));

const models: Record<string, Record<string, (a: Row) => unknown>> = {
  invoice: {
    findMany: (a) => sortBy(INVOICES.filter((r) => matchInvoice(r, a.where)), a.orderBy).slice(0, a.take ?? Infinity).map((r) => project(r, a.select)),
    aggregate: (a) => ({ _sum: { total: INVOICES.filter((r) => matchInvoice(r, a.where)).reduce((t, r) => t + r.total, 0) } }),
  },
  invoiceItem: { findMany: (a) => allItems().filter((it) => matchItem(it, a.where)).map((it) => project(it, a.select)) },
  invoiceItemLot: { findMany: (a) => sortBy(allItemLots().filter((l) => matchLot(l, a.where)), a.orderBy).map((l) => project(l, a.select)) },
  productLot: { findMany: (a) => LOTS.filter((l) => matchLot(l, a.where)).map((l) => project(l, a.select)) },
  product: { findMany: (a) => PRODUCTS.filter((p) => matchLot(p, a.where)).map((p) => project(p, a.select)) },
  tenant: { findUnique: (a) => { assert.equal(a.where.id, 't1'); return { ...tenantRow }; } },
  admin: { findUnique: (a) => (ADMINS[a.where.id] ? { ...ADMINS[a.where.id] } : null) },
  glSettings: { findUnique: () => null },
  companySettings: { findUnique: () => ({ countryCode: 'SA', paymentMethodsConfig: null }) },
};
/** كل استدعاء يُسجَّل، وأي نموذج أو عملية خارج القائمة (ومنها كل كتابة) ترمي — التقارير قراءةٌ خالصة */
const db = new Proxy({}, {
  get: (_t, model: string) => {
    if (model === 'then') return undefined;
    return new Proxy({}, {
      get: (_u, op: string) => {
        if (op === 'then') return undefined;
        const fn = models[model]?.[op];
        return async (args: Row = {}) => {
          calls.push({ model, op, args });
          if (!fn) throw new Error(`استدعاء غير متوقَّع في التقارير: ${model}.${op}`);
          return fn(args);
        };
      },
    });
  },
});
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const reports = require('../routes/reports') as typeof import('../routes/reports');
/* eslint-enable @typescript-eslint/no-var-requires */
const router = reports.default as unknown as Router;

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }
const USERS: Record<string, Row> = {
  adm: { id: 'adm', role: 'ADMIN', name: 'المدير', tenantId: 't1' },
  lst: { id: 'lst', role: 'MANAGER', name: 'مشرف بقوائم', tenantId: 't1' },
  sup: { id: 'sup', role: 'MANAGER', name: 'مشرف فريق', tenantId: 't1' },
};
/** سلسلة المسار كما يمشيها Express بعد حرّاس الموجّه (router.use تُختبر نصّياً في lots-static-b8): حرّاس المسار ثم معالجه */
async function call(p: string, query: Row = {}, user = 'adm') {
  const layer = (router as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === p && l.route.methods.get);
  assert.ok(layer, `نقطة غير مسجّلة: GET ${p}`);
  const res = { statusCode: 200, body: null as Row | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Row; return this; } };
  const req = { user: USERS[user], query, params: {}, body: {}, headers: {} };
  for (const h of layer.route!.stack) {
    let passed = false;
    let err: unknown = null;
    await h.handle(req, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) throw err;
    if (!passed) break;
  }
  return res;
}
const reset = (invoices: Row[] = baseInvoices()) => {
  INVOICES = invoices;
  tenantRow = { lotTrackingEnabled: true, accountingEnabled: true };
  calls = [];
};
const RANGE = { from: '2026-10-10', to: '2026-10-20' };
const rowsOf = (res: { body: Row | null }) => res.body!.data.rows as Row[];
/** [الصنف، التشغيلة، المباع، المرتجع، الصافي، العملاء، فواتير البيع، مستندات المرتجع] */
const brief = (rows: Row[]) => rows.map((r) => [r.productId, r.lotId, r.sold, r.returned, r.net, r.customers, r.invoices, r.returnInvoices]);
const invoiceQueries = () => calls.filter((c) => c.model === 'invoice' && c.op === 'findMany');

// ═══ /reports/lot-sales ═══

test('lot-sales: المباع والمرتجع والصافي وعدد العملاء لكل تشغيلة — «غير معروف» سطرٌ لكل صنف، والملغاة وما قبل المدى وغير المتتبَّع خارجة', async () => {
  reset();
  const res = await call('/lot-sales', RANGE);
  assert.equal(res.statusCode, 200);
  // حليب (ح) قبل لبن (ل)، والتشغيلات FEFO (A100 تنتهي قبل A200)، و«غير معروف» آخر الصنف
  assert.deepEqual(brief(rowsOf(res)), [
    ['p1', 'L1', 71, 21, 50, 2, 3, 1],  // S1 ٤٠+٥ + S2 ٢٤ + S4 ٢؛ R1 ١+٢٠؛ العملاء c1 وc2
    ['p1', 'L2', 9, 4, 5, 2, 2, 1],     // S1 ٨ + S6 ١ (c1 وc3)؛ R1 ٤
    ['p1', null, 6, 2, 4, 1, 1, 1],     // S2 من غير المسمّى؛ والإشعار الدائن R2 مرتجع
    ['p2', 'L3', 3, 0, 3, 1, 1, 0],
  ]);
  const [l1, l2, unknown, l3] = rowsOf(res);
  assert.deepEqual(l1.soldByCertainty, { CONFIRMED: 31, ASSUMED: 40, UNKNOWN: 0 });
  assert.deepEqual(unknown.soldByCertainty, { CONFIRMED: 0, ASSUMED: 0, UNKNOWN: 6 });
  assert.deepEqual(
    [l1.productName, l1.productCode, l1.unit, l1.units, l1.lotNumber, l1.productionDate, l1.expiryDate, l1.status, l1.blockKind],
    ['حليب', 'P1', 'حبة', [{ name: 'كرتون', factor: 24 }], 'A100', '2026-09-01', '2026-11-10', 'ACTIVE', null],
  );
  assert.deepEqual([l2.lotNumber, l2.status, l2.blockKind], ['A200', 'BLOCKED', 'RECALL'], 'المسحوب يظهر بحالته');
  assert.deepEqual([unknown.lotNumber, unknown.expiryDate, unknown.status], [null, null, null]);
  assert.deepEqual([l3.lotNumber, l3.expiryDate, l3.unit, l3.units], ['B1', null, 'علبة', []]);
  // مجموع الصنف داخل الصنف وحده، والملخّص عدّاتٌ بلا كمية (لا يُجمع أساس صنفٍ إلى آخر)
  const products = res.body!.data.products as Row[];
  assert.deepEqual(products.map((p) => [p.productId, p.lots, p.sold, p.returned, p.net, p.customers, p.invoices, p.returnInvoices]), [
    ['p1', 2, 86, 27, 59, 3, 4, 2],
    ['p2', 1, 3, 0, 3, 1, 1, 0],
  ]);
  assert.deepEqual(res.body!.data.summary, { lots: 3, products: 2, customers: 3, invoices: 4, returnInvoices: 2 });
  assert.deepEqual(res.body!.data.range, { from: '2026-10-10', to: '2026-10-20', timezone: 'Asia/Riyadh' });
  assert.deepEqual([res.body!.data.rangeApplied, res.body!.data.defaultDays, res.body!.data.scoped, res.body!.data.truncated], [true, null, false, false]);
  assert.ok(!('maxInvoices' in res.body!.data));
  // البطاقات والأصناف من الشركة نفسها (I5) — وبلا أي كتابة
  assert.equal(calls.find((c) => c.model === 'productLot')!.args.where.tenantId, 't1');
  assert.equal(calls.find((c) => c.model === 'product')!.args.where.tenantId, 't1');
  assert.deepEqual(new Set(calls.map((c) => c.op)), new Set(['findUnique', 'findMany']));
});

test('lot-sales والوحدات المتعددة: سطرٌ بكرتون وسطرٌ بحبّة للصنف نفسه يُجمعان بالأساس — مجموع الصنف = مجموع baseQtyOf لبنوده لا كمياتها الخام', async () => {
  reset();
  const res = await call('/lot-sales', { ...RANGE, productId: 'p1' });
  const p1 = (res.body!.data.products as Row[])[0];
  // بنود بيع الصنف المتتبَّعة في المدى (من منتصف ليل ١٠ إلى منتصف ليل ٢١ بتوقيت الرياض)
  const lo = RIY('2026-10-10', 0).getTime();
  const hi = RIY('2026-10-21', 0).getTime();
  const saleItems = INVOICES
    .filter((i) => i.tenantId === 't1' && i.status === 'CONFIRMED' && i.type !== 'RETURN' && i.invoiceDate.getTime() >= lo && i.invoiceDate.getTime() < hi)
    .flatMap((i) => i.items).filter((it: Row) => it.productId === 'p1' && it.lots.some((l: Row) => l.tenantId === 't1'));
  const base = saleItems.reduce((t: number, it: Row) => t + baseQtyOf(it), 0);
  const raw = saleItems.reduce((t: number, it: Row) => t + it.qty, 0);
  assert.deepEqual([p1.sold, base, raw], [86, 86, 17], 'بالأساس ٨٦ لا الخام ١٧ (في S1 كرتونان وخمس حبّات = ٥٣ لا ٧)');
  // والعارض يفكّكها «٣ كرتون و١٤ حبة» من unit/units
  assert.deepEqual([p1.unit, p1.units], ['حبة', [{ name: 'كرتون', factor: 24 }]]);
  // ترتيب السطرين لا يغيّر شيئاً
  const swapped = baseInvoices();
  swapped[0].items = [swapped[0].items[1], swapped[0].items[0], swapped[0].items[2]];
  reset(swapped);
  const again = await call('/lot-sales', { ...RANGE, productId: 'p1' });
  assert.deepEqual(rowsOf(again), rowsOf(res));
});

test('lotSalesRows صرفاً: يقينٌ مجهول يُعدّ أضعفها، والكمية الصفرية لا تعدّ عميلاً، وتشغيلةٌ بلا بطاقة بعد ذوات البطاقات وقبل «غير معروف»', () => {
  const meta = (id: string, expiry: string | null): LotMeta => ({
    id, productId: 'p1', lotNumber: id, productionDate: null, expiryDate: expiry, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date('2026-01-01'),
  });
  const out = reports.lotSalesRows(
    [
      { id: 'a', type: 'CASH', customerId: 'c1', items: [{ lots: [{ productId: 'p1', lotId: 'Lb', quantity: 2, certainty: 'WEIRD' }, { productId: 'p1', lotId: null, quantity: 1, certainty: 'UNKNOWN' }] }] },
      { id: 'b', type: 'CREDIT', customerId: 'c2', items: [{ lots: [{ productId: 'p1', lotId: 'Lgone', quantity: 0, certainty: 'CONFIRMED' }, { productId: 'p1', lotId: 'La', quantity: 1.5, certainty: 'CONFIRMED' }] }] },
      { id: 'r', type: 'RETURN', customerId: 'c2', items: [{ lots: [{ productId: 'p1', lotId: 'La', quantity: 3, certainty: 'CONFIRMED' }] }] },
    ],
    new Map([['p1', { name: 'حليب', code: 'P1', unit: 'حبة', units: [] }]]),
    new Map([['La', meta('La', '2026-11-01')], ['Lb', meta('Lb', null)]]),
  );
  assert.deepEqual(out.rows.map((r) => [r.lotId, r.sold, r.returned, r.net, r.customers, r.invoices, r.returnInvoices]), [
    ['La', 1.5, 3, -1.5, 1, 1, 1],        // FEFO: الانتهاء قبل «بلا انتهاء»؛ والصافي في مدى قد يكون سالباً (وقائعٌ لا رصيد)
    ['Lb', 2, 0, 2, 1, 1, 0],
    ['Lgone', 0, 0, 0, 0, 0, 0],          // صفرٌ لا يعدّ عميلاً ولا فاتورة
    [null, 1, 0, 1, 1, 1, 0],
  ]);
  assert.deepEqual(out.rows[1].soldByCertainty, { CONFIRMED: 0, ASSUMED: 0, UNKNOWN: 2 }, 'يقينٌ مجهول = أضعفها');
  assert.equal(out.rows[2].lotNumber, null);
  assert.deepEqual(out.summary, { lots: 3, products: 1, customers: 2, invoices: 2, returnInvoices: 1 });
  assert.deepEqual(out.products.map((p) => [p.productName, p.lots, p.sold, p.returned, p.net]), [['حليب', 3, 4.5, 3, 1.5]]);
  // صنفٌ محذوف البطاقة لا يُسقط التقرير
  const orphan = reports.lotSalesRows([{ id: 'x', type: 'CASH', customerId: 'c1', items: [{ lots: [{ productId: 'pz', lotId: null, quantity: 1, certainty: 'UNKNOWN' }] }] }], new Map(), new Map());
  assert.deepEqual([orphan.rows[0].productName, orphan.rows[0].unit, orphan.rows[0].units], ['صنف محذوف', '', []]);
});

test('lot-sales: المدى بأيام الشركة (الرياض) لا بأيام UTC — طرفٌ واحد بلا حدّ من الجهة الأخرى', async () => {
  reset();
  // S2 أُصدرت ٠٠:٣٠ يوم ١٢ بتوقيت الرياض (٢١:٣٠ UTC يوم ١١)
  let res = await call('/lot-sales', { from: '2026-10-12', to: '2026-10-12' });
  assert.deepEqual(brief(rowsOf(res)), [['p1', 'L1', 26, 0, 26, 2, 2, 0], ['p1', null, 6, 0, 6, 1, 1, 0]]);
  res = await call('/lot-sales', { from: '2026-10-11', to: '2026-10-11' });
  assert.deepEqual(rowsOf(res), [], 'يوم ١١ بتوقيت الشركة بلا مبيعات لوط (S2 ليست منه، وS8 صفّه لشركة أخرى)');
  // ٢٣:٥٩ يوم ٩ بتوقيت الرياض داخل «إلى ٩»
  res = await call('/lot-sales', { to: '2026-10-09' });
  assert.deepEqual(brief(rowsOf(res)), [['p1', 'L1', 7, 0, 7, 1, 1, 0]]);
  assert.deepEqual(res.body!.data.range, { from: null, to: '2026-10-09', timezone: 'Asia/Riyadh' });
  const w = invoiceQueries()[invoiceQueries().length - 1].args.where;
  assert.deepEqual(Object.keys(w.invoiceDate), ['lt'], 'الطرف الغائب بلا حدّ');
  assert.equal(w.invoiceDate.lt.toISOString(), '2026-10-09T21:00:00.000Z', 'نهاية يوم ٩ بتوقيت الرياض');
  // الصافي السالب في مدى وقائعٌ لا رصيد: مرتجعا R1 وR2 لبيعٍ قبل المدى
  res = await call('/lot-sales', { from: '2026-10-13' });
  assert.deepEqual(brief(rowsOf(res)), [['p1', 'L1', 0, 21, -21, 0, 0, 1], ['p1', 'L2', 1, 4, -3, 1, 1, 1], ['p1', null, 0, 2, -2, 0, 0, 1]]);
  assert.deepEqual(res.body!.data.summary, { lots: 2, products: 1, customers: 1, invoices: 1, returnInvoices: 2 });
});

test('lot-sales: بلا مدى ⇒ آخر ٩٠ يوماً بأيام الشركة تنتهي اليوم، مُعلَنة', async () => {
  const now = Date.now();
  lotSeq = 0;
  reset([
    inv({ id: 'OLD', type: 'CASH', at: new Date(now - 100 * 86400000), customerId: 'c1', items: [{ id: 'OLDa', productId: 'p1', qty: 9, lots: [{ lot: 'L1', qty: 9 }] }] }),
    inv({ id: 'NEW', type: 'CASH', at: new Date(now - 86400000), customerId: 'c1', items: [{ id: 'NEWa', productId: 'p1', qty: 2, lots: [{ lot: 'L1', qty: 2 }] }] }),
  ]);
  const res = await call('/lot-sales');
  assert.deepEqual(brief(rowsOf(res)), [['p1', 'L1', 2, 0, 2, 1, 1, 0]]);
  const d = res.body!.data;
  assert.deepEqual([d.rangeApplied, d.defaultDays], [false, 90]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date(now));
  assert.equal(d.range.to, today);
  const from = new Date(`${today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 89);
  assert.equal(d.range.from, from.toISOString().slice(0, 10));
});

test('lot-sales: فلاتر الصنف والتشغيلة و«غير معروف» (lotId=none) — والشرط على صفوف اللوط نفسها وعلى الفاتورة', async () => {
  reset();
  assert.deepEqual(brief(rowsOf(await call('/lot-sales', { ...RANGE, productId: 'p2' }))), [['p2', 'L3', 3, 0, 3, 1, 1, 0]]);
  assert.deepEqual(brief(rowsOf(await call('/lot-sales', { ...RANGE, lotId: 'L2' }))), [['p1', 'L2', 9, 4, 5, 2, 2, 1]]);
  assert.deepEqual(brief(rowsOf(await call('/lot-sales', { ...RANGE, lotId: 'none' }))), [['p1', null, 6, 2, 4, 1, 1, 1]]);
  assert.deepEqual(rowsOf(await call('/lot-sales', { ...RANGE, lotId: 'LX' })), [], 'تشغيلة شركة أخرى لا تظهر');
  const q = invoiceQueries()[0].args;
  assert.deepEqual(q.where.items, { some: { lots: { some: { tenantId: 't1', productId: 'p2' } } } });
  assert.deepEqual(q.select.items.where, { lots: { some: { tenantId: 't1', productId: 'p2' } } });
  assert.deepEqual(q.select.items.select.lots.where, { tenantId: 't1', productId: 'p2' });
  assert.equal(q.where.tenantId, 't1');
  assert.equal(q.where.status, 'CONFIRMED');
  assert.equal(invoiceQueries()[2].args.where.items.some.lots.some.lotId, null, '«غير معروف» = lotId null');
  // بلا صفوف: لا قراءة لبطاقات ولا أصناف
  reset();
  await call('/lot-sales', { ...RANGE, lotId: 'LX' });
  assert.equal(calls.filter((c) => c.model === 'productLot' || c.model === 'product').length, 0);
});

test('lot-sales: معاملٌ غير صالح يُرفض ٤٠٠ قبل أي قراءة للفواتير — لا يُسقَط الفلتر صامتاً', async () => {
  for (const query of [
    { productId: { not: 'x' } }, { lotId: ['L1', 'L2'] }, { from: '2026-13-01' }, { to: '10/10/2026' }, { from: '2026-02-30' },
    { from: '2026-10-20', to: '2026-10-10' }, { productId: 'p'.repeat(129) },
    // شكلٌ صالح وسنةٌ خارج 1900–2099: 9999-12-31 كان يتجاوز addDays (٥٠٠)، و0099 يحمله Date.UTC إلى 1999 (مدى غير المعلَن)
    { to: '9999-12-31' }, { from: '0099-12-31', to: '2026-10-20' }, { from: '1899-12-31' }, { to: '2100-01-01' },
  ]) {
    reset();
    const res = await call('/lot-sales', query);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.equal(res.body!.success, false);
    assert.equal(invoiceQueries().length, 0, JSON.stringify(query));
  }
  // الحدّان مقبولان، والمطبَّق على تاريخ الفاتورة هو المعلَن في range بيوم الشركة
  reset();
  const res = await call('/lot-sales', { from: '1900-01-01', to: '2099-12-31' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body!.data.range, { from: '1900-01-01', to: '2099-12-31', timezone: 'Asia/Riyadh' });
  const riyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' });
  const { gte, lt } = invoiceQueries()[0].args.where.invoiceDate;
  assert.deepEqual([riyDay.format(gte), riyDay.format(lt)], ['1900-01-01', '2100-01-01']);
});

test('lot-sales: النطاق — المقيّد بالقوائم يرى ما عميله **و**مندوبه في نطاقه (وفاتورة المكتب بلا مندوب)، وعدد العملاء من نطاقه', async () => {
  reset();
  const res = await call('/lot-sales', RANGE, 'lst');
  assert.deepEqual(brief(rowsOf(res)), [
    ['p1', 'L1', 47, 21, 26, 1, 2, 1],  // S1 ٤٥ + S4 ٢ (مكتب)؛ S2 لعميلٍ خارج النطاق
    ['p1', 'L2', 8, 4, 4, 1, 1, 1],     // S6 لعميلٍ خارج النطاق
    ['p2', 'L3', 3, 0, 3, 1, 1, 0],
  ]);
  assert.deepEqual(res.body!.data.summary, { lots: 3, products: 2, customers: 1, invoices: 2, returnInvoices: 1 });
  assert.equal(res.body!.data.scoped, true);
  assert.ok(Array.isArray(invoiceQueries()[0].args.where.AND), 'قيد النطاق مفتاح AND في شرط الفاتورة');
});

test('lot-sales: مشرف الفرق يرى ما وُسم بفرقه وحده (القديم بلا فريق لا يراه)', async () => {
  reset();
  const res = await call('/lot-sales', RANGE, 'sup');
  assert.deepEqual(brief(rowsOf(res)), [
    ['p1', 'L1', 45, 21, 24, 1, 1, 1],  // S1 ومرتجعه R1 (T1)؛ S4 بلا فريق وS2 لفريقٍ آخر
    ['p1', 'L2', 9, 4, 5, 2, 2, 1],     // S1 + S6 (T1)
    ['p2', 'L3', 3, 0, 3, 1, 1, 0],
  ]);
  assert.equal(res.body!.data.scoped, true);
});

test('lot-sales: فلتر الفريق بوسم الفاتورة — فريقٌ بعينه و«بلا فريق»، ومعه النطاق لا يمحو أحدهما الآخر', async () => {
  reset();
  assert.deepEqual(brief(rowsOf(await call('/lot-sales', { ...RANGE, teamId: 'T2' }))), [
    ['p1', 'L1', 24, 0, 24, 1, 1, 0], ['p1', null, 6, 2, 4, 1, 1, 1],
  ]);
  assert.deepEqual(brief(rowsOf(await call('/lot-sales', { ...RANGE, teamId: 'none' }))), [['p1', 'L1', 2, 0, 2, 1, 1, 0]]);
  // المقيّد بالقوائم مع فلتر T1: تقاطعهما (S1 وR1)، لا S4 (بلا فريق) ولا S6 (عميلٌ خارج النطاق)
  reset();
  const res = await call('/lot-sales', { ...RANGE, teamId: 'T1' }, 'lst');
  assert.deepEqual(brief(rowsOf(res)), [['p1', 'L1', 45, 21, 24, 1, 1, 1], ['p1', 'L2', 8, 4, 4, 1, 1, 1], ['p2', 'L3', 3, 0, 3, 1, 1, 0]]);
  const w = invoiceQueries()[0].args.where;
  assert.equal(w.teamId, 'T1');
  assert.ok(Array.isArray(w.AND));
});

test('lot-sales: العَلَم — الميزة المطفأة ٤٠٣ LOTS_NOT_ALLOWED والمحاسبة المطفأة قبلها، بلا قراءة فواتير', async () => {
  reset();
  tenantRow = { lotTrackingEnabled: false, accountingEnabled: true };
  let res = await call('/lot-sales', RANGE);
  assert.deepEqual([res.statusCode, res.body!.code], [403, 'LOTS_NOT_ALLOWED']);
  assert.equal(invoiceQueries().length, 0);
  reset();
  tenantRow = { lotTrackingEnabled: true, accountingEnabled: false };
  res = await call('/lot-sales', RANGE);
  assert.deepEqual([res.statusCode, res.body!.code], [403, 'ACCOUNTING_NOT_ALLOWED']);
  assert.equal(invoiceQueries().length, 0);
  reset();
  tenantRow = { accountingEnabled: true };
  res = await call('/lot-sales', RANGE);
  assert.deepEqual([res.statusCode, res.body!.code], [403, 'LOTS_NOT_ALLOWED'], 'تعذّر قراءة العَلَم يمنع (!== true)');
});

test('lot-sales: سقف الفواتير يُعلَن truncated (الأحدث أولاً) — لا صافي مقصوص يُقرأ شاملاً', async () => {
  lotSeq = 0;
  const many: Row[] = [];
  for (let i = 0; i < 20_001; i++) {
    many.push(inv({ id: `M${i}`, type: 'CASH', at: new Date(RIY('2026-10-15').getTime() + i * 1000), customerId: 'c1', items: [{ id: `M${i}a`, productId: 'p1', qty: 1, lots: [{ lot: 'L1', qty: 1 }] }] }));
  }
  reset(many);
  const res = await call('/lot-sales', RANGE);
  assert.equal(invoiceQueries()[0].args.take, 20_001);
  assert.deepEqual(invoiceQueries()[0].args.orderBy, { invoiceDate: 'desc' });
  const d = res.body!.data;
  assert.deepEqual([d.truncated, d.maxInvoices, d.rows[0].sold, d.summary.invoices], [true, 20_000, 20_000, 20_000]);
});

// ═══ /reports/returns بـwithLots ═══

const RET_RANGE = { from: '2026-10-01', to: '2026-10-31' };
// «الوحدة الرئيسية» D18: primaryUnitId حاضرٌ دائماً (null لصنفٍ بلا رئيسية) بعد baseUnit — وبقية الحقول كما كانت
const LINE_KEYS = ['name', 'unit', 'qty', 'unitFactor', 'baseQty', 'baseUnit', 'primaryUnitId', 'lineTotal', 'returnExpired', 'expiresAt'];

test('المرتجع بلا withLots: الردّ كما كان حرفياً — لا قراءة للعَلَم ولا لصفوف اللوط', async () => {
  for (const extra of [{}, { withLots: ['1'] }, { withLots: '0' }, { withLots: 'false' }]) {
    reset();
    const res = await call('/returns', { ...RET_RANGE, ...extra });
    assert.equal(res.statusCode, 200);
    const returns = res.body!.data.returns as Row[];
    assert.deepEqual(returns.map((r) => r.id), ['R2', 'R1']);
    for (const r of returns) for (const it of r.items) assert.deepEqual(Object.keys(it), LINE_KEYS, JSON.stringify(extra));
    assert.deepEqual(returns[1].saleInvoices, ['N-S1']);
    assert.equal(calls.filter((c) => c.model === 'tenant' || c.model === 'invoiceItemLot').length, 0, JSON.stringify(extra));
  }
});

test('المرتجع بـwithLots=1 والعَلَم مفعّل: كل بند يحمل صفوف توزيعه بالأساس (InvoiceItemLotDto) — والشركة شرطٌ في قراءتها', async () => {
  reset();
  const res = await call('/returns', { ...RET_RANGE, withLots: '1' });
  const [r2, r1] = res.body!.data.returns as Row[];
  const [piece, untracked, carton] = r1.items as Row[];
  assert.equal(piece.lots.length, 1);
  const row = piece.lots[0];
  assert.deepEqual(
    { ...row, id: undefined, createdAt: undefined },
    {
      id: undefined, invoiceItemId: 'R1a', invoiceId: 'R1', productId: 'p1', vanKey: 'r1', lotId: 'L1', quantity: 1, certainty: 'CONFIRMED',
      expiryDate: '2026-11-10', sourceItemLotId: null, flags: null, createdAt: undefined, lot: { lotNumber: 'A100', expiryDate: '2026-11-10' },
    },
  );
  assert.ok(row.createdAt instanceof Date && typeof row.id === 'string');
  assert.deepEqual(untracked.lots, [], 'بند صنفٍ غير متتبَّع: مصفوفة فارغة');
  // الوحدات: كرتونٌ مرتجع موزَّعٌ على لوطين بالأساس — Σ الصفوف = baseQty البند، والبند بوحدته هو
  assert.deepEqual([carton.qty, carton.unit, carton.unitFactor, carton.baseQty, carton.baseUnit], [1, 'كرتون', 24, 24, 'حبة']);
  assert.deepEqual(carton.lots.map((l: Row) => [l.lotId, l.quantity, l.certainty, l.lot.lotNumber]), [['L1', 20, 'ASSUMED', 'A100'], ['L2', 4, 'ASSUMED', 'A200']]);
  assert.equal(carton.lots.reduce((t: number, l: Row) => t + l.quantity, 0), carton.baseQty);
  assert.deepEqual(r2.items[0].lots.map((l: Row) => [l.lotId, l.quantity, l.certainty, l.lot, l.expiryDate]), [[null, 2, 'UNKNOWN', null, null]]);
  // الحقول القائمة لم تتغيّر، و`lots` وحده جديد
  assert.deepEqual(Object.keys(piece), [...LINE_KEYS, 'lots']);
  const lotCall = calls.find((c) => c.model === 'invoiceItemLot')!;
  assert.equal(lotCall.args.where.tenantId, 't1');
  assert.deepEqual([...lotCall.args.where.invoiceId.in].sort(), ['R1', 'R2']);
  assert.equal(calls.filter((c) => c.model === 'invoiceItemLot').length, 1, 'استعلامٌ واحد لكل المرتجعات');
  // الملخّص كما هو
  assert.equal(res.body!.data.summary.count, 2);
});

test("المرتجع بـwithLots=true كقراءات الفاتورة والسيارة: يُحترم كـ'1' — الردّ نفسه، واستعلامٌ واحد للصفوف", async () => {
  reset();
  const one = (await call('/returns', { ...RET_RANGE, withLots: '1' })).body!.data;
  reset();
  const yes = (await call('/returns', { ...RET_RANGE, withLots: 'true' })).body!.data;
  assert.ok((yes.returns as Row[]).every((r) => r.items.every((it: Row) => Array.isArray(it.lots))), 'كل بندٍ يحمل lots');
  assert.deepEqual(yes, one);
  assert.equal(calls.filter((c) => c.model === 'invoiceItemLot').length, 1);
});

test('المرتجع بـwithLots=1 والميزة مطفأة: يُتجاهل — الردّ كما كان، وقراءة العَلَم وحدها', async () => {
  reset();
  tenantRow = { lotTrackingEnabled: false, accountingEnabled: true };
  const res = await call('/returns', { ...RET_RANGE, withLots: '1' });
  for (const r of res.body!.data.returns as Row[]) for (const it of r.items) assert.deepEqual(Object.keys(it), LINE_KEYS);
  assert.equal(calls.filter((c) => c.model === 'tenant').length, 1);
  assert.equal(calls.filter((c) => c.model === 'invoiceItemLot').length, 0);
});

test('المرتجع بـwithLots=1 بلا مرتجعات في المدى: لا قراءة للعَلَم ولا لصفوف اللوط', async () => {
  reset();
  const res = await call('/returns', { from: '2026-11-01', to: '2026-11-30', withLots: '1' });
  assert.deepEqual(res.body!.data.returns, []);
  assert.equal(calls.filter((c) => c.model === 'tenant' || c.model === 'invoiceItemLot').length, 0);
});

test('المرتجع بـwithLots=1 للمقيّد بنطاقه: صفوف مرتجعات نطاقه وحدها', async () => {
  reset();
  const res = await call('/returns', { ...RET_RANGE, withLots: '1' }, 'lst');
  assert.deepEqual((res.body!.data.returns as Row[]).map((r) => r.id), ['R1']);
  const lotCall = calls.find((c) => c.model === 'invoiceItemLot')!;
  assert.deepEqual([...lotCall.args.where.invoiceId.in], ['R1']);
});
