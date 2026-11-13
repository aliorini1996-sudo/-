// دقّة التقارير — الخلفية (طلب المالك ١٣ نوفمبر ٢٠٢٦، البنود ٢ و٦ و٧ و٩): أرصدة العملاء لكل غير محذوف بحالته، ونسبة التحصيل
// تعدّ البيع النقدي المحصَّل، والزيارات تُقرأ كلّها دفعاتٍ بلا سقفٍ صامت، وملخّصا المرتجع والطلبات تجميعٌ على كل المدى،
// والمدى المطبَّق فعلاً في meta. الدوالّ الصرفة وحدها، ثم المسارات الحقيقية فوق Prisma مزيّف يفسّر الشروط — بلا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NEWEST_FIRST, VISIT_BATCH_SIZE, VISIT_RAW_CEILING, olderThan, readNewestFirst, utcAppliedRange, utcDay, type KeysetCursor } from '../services/reportBatches';
import { COLLECTED_CASH_SALE } from '../services/paymentMethodsReport';
import { CASH_VOID_KEEP_COLLECTION_NOTE } from '../lib/ledgerNotes';
import { MERGE_TOLERANCE_MS, mergeVisits, type MergedVisit, type VisitLike } from '../services/workDay';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);

// ═══ الدوالّ الصرفة ═══

/** صفحةٌ من مصفوفةٍ في الذاكرة بالترتيب الثابت وبعد المؤشّر — كما يفعل الاستعلام */
const pager = (all: { id: string; createdAt: Date }[]) => {
  const sorted = [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const takes: number[] = [];
  const page = async (after: KeysetCursor | null, take: number) => {
    takes.push(take);
    const rest = after
      ? sorted.filter((r) => r.createdAt.getTime() < after.createdAt.getTime() || (r.createdAt.getTime() === after.createdAt.getTime() && r.id < after.id))
      : sorted;
    return rest.slice(0, take);
  };
  return { page, takes, sorted };
};
const mk = (n: number, tieEvery = 3) => Array.from({ length: n }, (_, i) => ({
  id: `v${String(i).padStart(6, '0')}`,
  // كل ثلاثة سجلّات في اللحظة نفسها — المعرّف وحده يفصل بينها
  createdAt: new Date(Date.UTC(2026, 10, 1) + Math.floor(i / tieEvery) * 60_000),
}));

test('القراءة على دفعات: كل السجلّات مرّةً واحدة بلا تكرارٍ ولا سقوط، الأحدث أولاً، والتعادل في اللحظة يفصله المعرّف', async () => {
  const all = mk(23);
  const { page, takes, sorted } = pager(all);
  const r = await readNewestFirst(page, { batch: 5, ceiling: 1000 });
  assert.equal(r.truncated, false);
  assert.equal(r.limit, 1000);
  assert.deepEqual(r.rows.map((x) => x.id), sorted.map((x) => x.id), 'الترتيب الثابت كاملاً');
  assert.equal(new Set(r.rows.map((x) => x.id)).size, 23, 'بلا تكرار');
  assert.deepEqual(takes, [5, 5, 5, 5, 5], 'الدفعة الأخيرة ناقصة فتتوقّف القراءة');
});

test('حدّ الأمان: يُبقي الأحدث ويُعلن truncated وحده حين يوجد ما بعده — والمدى الذي فيه الحدّ بالضبط ليس مقصوصاً', async () => {
  const all = mk(12);
  const over = pager(all);
  const cut = await readNewestFirst(over.page, { batch: 5, ceiling: 7 });
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.rows.map((x) => x.id), over.sorted.slice(0, 7).map((x) => x.id), 'الأحدث سبعة');
  assert.deepEqual(over.takes, [5, 3], 'لا يطلب فوق الحدّ إلا صفّاً واحداً شاهداً');

  const exact = pager(mk(7));
  const full = await readNewestFirst(exact.page, { batch: 5, ceiling: 7 });
  assert.deepEqual([full.truncated, full.rows.length], [false, 7]);
  assert.deepEqual(exact.takes, [5, 3]);

  const empty = await readNewestFirst(pager([]).page);
  assert.deepEqual([empty.rows.length, empty.truncated, empty.limit], [0, false, VISIT_RAW_CEILING]);
  assert.deepEqual([VISIT_BATCH_SIZE, VISIT_RAW_CEILING], [5_000, 200_000], 'دفعات ٥٬٠٠٠ وحدّ ٢٠٠٬٠٠٠ (المواصفة)');
});

test('المؤشّر والترتيب: (createdAt، id) تنازلياً، و«أقدم من» بالشرطين معاً — والأولى بلا قيد', () => {
  assert.deepEqual(NEWEST_FIRST, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.deepEqual(olderThan(null), {});
  const at = new Date('2026-11-05T10:00:00.000Z');
  // وحدّ المسح الصريح lte (يلزم من OR ولا يستنتجه المخطِّط): تبدأ الدفعة من موضعها على فهرس (tenantId, createdAt)
  assert.deepEqual(olderThan({ id: 'v9', createdAt: at }),
    { createdAt: { lte: at }, OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: 'v9' } }] });
});

test('المدى المطبَّق بأيام UTC: من الشرط نفسه — الافتراضيّ بلا lt مفتوح الطرف الأعلى (to: null)، والصريح كما طُلب، والطرف الغائب بلا حدّ', () => {
  const now = new Date('2026-11-13T21:30:00.000Z');
  // النافذة الافتراضية بلا حدٍّ أعلى: لا يُعلَن «إلى اليوم» لم يُطبَّق (الطلبات القادمة تسليماً داخلة)
  assert.deepEqual(utcAppliedRange(true, { gte: new Date(now.getTime() - 90 * 86_400_000) }), { from: '2026-08-15', to: null, defaulted: true });
  assert.deepEqual(utcAppliedRange(false, { gte: new Date('2026-11-01'), lt: new Date(new Date('2026-11-10').getTime() + 86_400_000) }),
    { from: '2026-11-01', to: '2026-11-10', defaulted: false }, '«إلى» شاملٌ يومه: lt منتصف ليل التالي');
  assert.deepEqual(utcAppliedRange(false, { gte: new Date('2026-11-01') }), { from: '2026-11-01', to: null, defaulted: false });
  assert.deepEqual(utcAppliedRange(false, { lt: new Date('2026-11-11') }), { from: null, to: '2026-11-10', defaulted: false });
  assert.equal(utcDay(new Date('garbage')), null, 'تاريخٌ غير صالح لا يُسقط المسار');
});

// ═══ الدمج المفهرس يطابق الدمج القديم حرفاً (workDay.mergeVisits) ═══

/** الخوارزمية القديمة كما كانت (مسح `out` كلّه لكل ملاحظة) — مرجعٌ للمطابقة */
function referenceMerge<T extends VisitLike>(visits: T[]): MergedVisit<T>[] {
  const same = (a: VisitLike, b: VisitLike) => (a.customerId && b.customerId ? a.customerId === b.customerId : a.customerName === b.customerName);
  const sorted = [...visits].sort((a, b) => a.at.getTime() - b.at.getTime());
  const isTimed = (v: VisitLike) => !!v.durationSec && v.durationSec > 0;
  const out: MergedVisit<T>[] = sorted.filter(isTimed).map((v) => ({
    customerName: v.customerName, start: v.at, end: new Date(v.at.getTime() + (v.durationSec as number) * 1000), durationSec: v.durationSec,
    hasNote: false, parts: 1, lat: v.lat ?? null, lng: v.lng ?? null, sources: [v],
  }));
  for (const u of sorted.filter((v) => !isTimed(v))) {
    const t = u.at.getTime();
    const host = out.find((h) => h.durationSec != null && same(h.sources[0], u)
      && t >= h.start.getTime() - MERGE_TOLERANCE_MS && t <= (h.end ? h.end.getTime() : h.start.getTime()) + MERGE_TOLERANCE_MS);
    if (host) {
      host.hasNote = true; host.parts += 1; host.sources.push(u);
      if (host.lat == null && u.lat != null) { host.lat = u.lat; host.lng = u.lng ?? null; }
    } else {
      out.push({ customerName: u.customerName, start: u.at, end: null, durationSec: null, hasNote: true, parts: 1, lat: u.lat ?? null, lng: u.lng ?? null, sources: [u] });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
const brief = (ms: MergedVisit<VisitLike & { id: string }>[]) => ms.map((m) => [
  m.customerName, m.start.getTime(), m.end?.getTime() ?? null, m.durationSec, m.hasNote, m.parts, m.lat, m.lng, m.sources.map((s) => s.id).join(','),
]);

test('الدمج المفهرس = الدمج القديم حرفاً: عملاء بمعرّف وبلاه وأسماء مكرّرة، ونوافذ متداخلة وحدودها، وتعادل اللحظات', () => {
  // مولّدٌ حتميّ (LCG) — لا عشوائية تتغيّر بين تشغيلين
  let seed = 20261113;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const base = Date.UTC(2026, 10, 1, 6);
  for (let round = 0; round < 300; round++) {
    const n = 1 + rnd(60);
    const rows = Array.from({ length: n }, (_, i) => {
      const cust = rnd(6);
      const idMode = rnd(4); // ثلثا السجلّات بمعرّف، وبعضها بلا معرّف أو بمعرّفٍ فارغ (يُعامل كالغياب)
      const timed = rnd(2) === 0;
      return {
        id: `r${round}-${i}`,
        customerName: `عميل ${cust % 4}`, // اسمان لعميلين مختلفين أحياناً — المعرّف وحده يفصلهما
        customerId: idMode === 0 ? null : idMode === 1 ? '' : `c${cust}`,
        // دقائق متقاربة ولحظاتٌ متطابقة، وحدود النافذة بالضبط (±٥ دقائق)
        at: new Date(base + rnd(90) * 60_000 + (rnd(3) === 0 ? MERGE_TOLERANCE_MS : 0)),
        durationSec: timed ? [60, 300, 900, 1][rnd(4)] : rnd(2) === 0 ? null : 0,
        lat: rnd(3) === 0 ? 24.7 : null,
        lng: rnd(3) === 0 ? 46.6 : null,
      };
    });
    assert.deepEqual(brief(mergeVisits(rows)), brief(referenceMerge(rows)), `الجولة ${round}`);
  }
});

test('الدمج المفهرس خطّيٌّ تقريباً: ٤٠٬٠٠٠ سجلّ لمندوبٍ واحد (نصفها ملاحظات) في جزءٍ من الثانية لا ثوانٍ', () => {
  const rows = Array.from({ length: 40_000 }, (_, i) => ({
    // الوقفة k: مؤقّتٌ (زوجي) وملاحظته بعده بدقيقة (فردي) للعميل نفسه
    id: `x${i}`, customerName: `عميل ${Math.floor(i / 2) % 500}`, customerId: `c${Math.floor(i / 2) % 500}`,
    at: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 2) * 20 * 60_000 + (i % 2) * 60_000),
    durationSec: i % 2 === 0 ? 300 : null, lat: null, lng: null,
  }));
  const t0 = Date.now();
  const out = mergeVisits(rows);
  assert.equal(out.length, 20_000, 'كل ملاحظةٍ اندمجت في مؤقّتها');
  assert.ok(Date.now() - t0 < 3_000, `استغرق ${Date.now() - t0}ms`);
});

// ═══ Prisma مزيّف يفسّر الشروط ═══

function scalarOk(val: unknown, cond: unknown): boolean {
  if (cond instanceof Date) return val instanceof Date && val.getTime() === cond.getTime();
  if (!isObj(cond)) return val === cond || (cond === null && val === undefined);
  return Object.entries(cond).every(([op, x]) => {
    const v = val instanceof Date ? val.getTime() : val;
    const y = x instanceof Date ? x.getTime() : x;
    switch (op) {
      case 'not': return isObj(x) ? !scalarOk(val, x) : x === null ? val != null : val !== x;
      case 'in': return (x as unknown[]).includes(val);
      case 'gte': return v != null && (v as number) >= (y as number);
      case 'gt': return v != null && (v as number) > (y as number);
      case 'lt': return v != null && (v as number) < (y as number);
      case 'lte': return v != null && (v as number) <= (y as number);
      default: throw new Error(`عامل غير مدعوم في المزيّف: ${op}`);
    }
  });
}
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === 'AND') return (Array.isArray(v) ? v : [v]).every((w: Row) => matches(row, w));
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    const val = row[k];
    if (Array.isArray(val) && isObj(v) && ('some' in v || 'none' in v)) {
      if ('some' in v && !val.some((x: Row) => matches(x, v.some))) return false;
      if ('none' in v && val.some((x: Row) => matches(x, v.none))) return false;
      return true;
    }
    if (isObj(val) && isObj(v) && !('not' in v) && !('in' in v) && !('gte' in v) && !('lt' in v) && !('gt' in v)) return matches(val, v);
    return scalarOk(val, v);
  });
}
const keyOf = (v: unknown) => (v instanceof Date ? v.getTime() : v) as number | string;
function sortBy(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => Object.entries(o)[0] as [string, 'asc' | 'desc']);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = keyOf(a[k]);
      const y = keyOf(b[k]);
      if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
function groupRows(rows: Row[], a: Row): Row[] {
  const groups = new Map<string, Row>();
  for (const r of rows) {
    const key = JSON.stringify((a.by as string[]).map((k) => r[k] ?? null));
    const g = groups.get(key) ?? {
      ...Object.fromEntries((a.by as string[]).map((k) => [k, r[k] ?? null])),
      ...(a._count ? { _count: { _all: 0 } } : {}),
      _sum: Object.fromEntries(Object.keys(a._sum ?? {}).map((f) => [f, 0])),
    };
    if (g._count) g._count._all += 1;
    for (const f of Object.keys(a._sum ?? {})) g._sum[f] += Number(r[f] ?? 0);
    groups.set(key, g);
  }
  return [...groups.values()];
}

let CUSTOMERS: Row[] = [];
let REPS: Row[] = [];
let INVOICES: Row[] = [];
let RECEIPTS: Row[] = [];
let VISITS: Row[] = [];
let calls: { model: string; op: string; args: Row }[] = [];

const models: Record<string, Record<string, (a: Row) => unknown>> = {
  customer: {
    findMany: (a) => sortBy(CUSTOMERS.filter((c) => matches(c, a.where)), a.orderBy)
      .map((c) => Object.fromEntries(Object.keys(a.select).map((k) => [k, c[k]]))),
  },
  salesRep: {
    findMany: (a) => REPS.filter((r) => matches(r, a.where)).map((r) => ({
      id: r.id, name: r.name,
      ...(a.select?.invoices ? { invoices: INVOICES.filter((i) => i.salesRepId === r.id && matches(i, a.select.invoices.where)) } : {}),
      ...(a.select?.receipts ? { receipts: RECEIPTS.filter((x) => x.salesRepId === r.id && matches(x, a.select.receipts.where)) } : {}),
    })),
  },
  repSession: { findMany: () => [] },
  repAttendance: { findMany: () => [] },
  repVisit: { findMany: (a) => sortBy(VISITS.filter((v) => matches(v, a.where)), a.orderBy).slice(0, a.take ?? Infinity) },
  invoice: {
    findMany: (a) => sortBy(INVOICES.filter((i) => matches(i, a.where)), a.orderBy).slice(0, a.take ?? Infinity),
    aggregate: (a) => {
      const rows = INVOICES.filter((i) => matches(i, a.where));
      return {
        ...(a._count ? { _count: { _all: rows.length } } : {}),
        _sum: Object.fromEntries(Object.keys(a._sum ?? {}).map((f) => [f, rows.reduce((t, r) => t + Number(r[f] ?? 0), 0)])),
      };
    },
    groupBy: (a) => groupRows(INVOICES.filter((i) => matches(i, a.where)), a),
  },
  invoiceItem: {
    count: (a) => INVOICES.flatMap((i) => i.items.map((it: Row) => ({ ...it, invoice: i }))).filter((it) => matches(it, a.where)).length,
    findMany: () => [],
  },
  tenant: { findUnique: () => ({ accountingEnabled: true }) },
};
const db = new Proxy({}, {
  get: (_t, model: string) => {
    if (model === 'then') return undefined;
    // نقاط GPS المجمَّعة في القاعدة (ساعات العمل والمسافة) — لا نقاط في هذه الاختبارات
    if (model === '$queryRaw') return async () => [];
    return new Proxy({}, {
      get: (_u, op: string) => {
        if (op === 'then') return undefined;
        const fn = models[model]?.[op];
        return async (args: Row = {}) => {
          calls.push({ model, op, args });
          if (!fn) throw new Error(`استدعاء غير متوقَّع: ${model}.${op}`);
          return fn(args);
        };
      },
    });
  },
});

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
stub('config/database', { default: db });
// بلا نطاق مستخدم — نطاق المستخدم والفرق لهما اختباراتهما (teams.test، lots-reports)
stub('services/adminScope', {
  scopedRecordWhere: async () => ({}), scopedRepRecordWhere: async () => ({}), adminCustomerFilter: async () => ({}), adminRepFilter: async () => ({}),
  SHAPE_INVOICE_RECEIPT: {}, SHAPE_VISIT: {},
});
/* eslint-disable @typescript-eslint/no-var-requires */
const reports = require('../routes/reports').default;
/* eslint-enable @typescript-eslint/no-var-requires */

/** معالج المسار الأخير وحده (المصادقة والصلاحية على الموجّه ولها اختباراتها) — يعيد الجسم كاملاً: data وmeta */
async function run(routePath: string, query: Row = {}): Promise<Row> {
  const layer = (reports as { stack: Row[] }).stack.find((l) => l.route?.path === routePath && l.route.methods.get);
  assert.ok(layer, `GET ${routePath} غير موجود`);
  const handler = layer.route.stack.slice(-1)[0].handle;
  let body: Row | null = null;
  let err: unknown = null;
  const res = { status() { return this; }, json(b: Row) { body = b; return this; } };
  await handler({ query, params: {}, user: { id: 'a1', role: 'ADMIN', tenantId: 't1' } }, res, (e: unknown) => { err = e; });
  if (err) throw err;
  return body!;
}

// ═══ البيانات ═══

const D = (iso: string) => new Date(iso);
/** ٢٠٬٥٠٠ سجلّ زيارة لمندوبٍ واحد في أسبوعٍ من نوفمبر — فوق كل سقفٍ صامت قديم (٥٬٠٠٠ و١٠٬٠٠٠ و٢٠٬٠٠٠)، وكل زوجٍ في لحظةٍ واحدة */
const VISIT_COUNT = 20_500;
function visits(): Row[] {
  return Array.from({ length: VISIT_COUNT }, (_, i) => {
    const createdAt = new Date(Date.UTC(2026, 10, 1, 6) + Math.floor(i / 2) * 30_000);
    // عميلٌ مختلف لكل سجلّ وبلا مؤقّت: كل سجلٍّ وقفةٌ مستقلّة، فعدد الوقفات = عدد السجلّات
    return {
      id: `v${String(i).padStart(6, '0')}`, tenantId: 't1', salesRepId: 'r2', customerId: `c${i}`, teamId: null,
      createdAt, startedAt: null, durationSec: null, note: null, lat: null, lng: null,
      customer: { name: `عميل ${i}` }, salesRep: { name: 'خالد' }, team: null,
    };
  });
}
const inv = (o: Row): Row => ({
  tenantId: 't1', status: 'CONFIRMED', discountAmt: 0, paidAmt: 0, teamId: null, accountEntries: [], items: [], ...o,
});
function reset(): void {
  calls = [];
  CUSTOMERS = [
    { id: 'A', tenantId: 't1', name: 'نشط', phone: '1', status: 'ACTIVE', balance: 100, creditLimit: 0 },
    { id: 'B', tenantId: 't1', name: 'محظور', phone: '2', status: 'BLOCKED', balance: 250, creditLimit: 0 },
    { id: 'C', tenantId: 't1', name: 'موقوف', phone: '3', status: 'INACTIVE', balance: 50, creditLimit: 0 },
    { id: 'X', tenantId: 't1', name: 'محذوف', phone: '4', status: 'DELETED', balance: 999, creditLimit: 0 },
    { id: 'Z', tenantId: 't1', name: 'بلا دين', phone: '5', status: 'BLOCKED', balance: 0, creditLimit: 0 },
  ];
  REPS = [
    { id: 'r1', tenantId: 't1', name: 'سالم', isActive: true },
    { id: 'r2', tenantId: 't1', name: 'خالد', isActive: true },
  ];
  const nov = D('2026-11-05T09:00:00Z');
  INVOICES = [
    // سالم نقديٌّ كلّه: نقدية مؤكَّدة، ونقدية أبطلتها الهيئة واحتُفظ بتحصيلها وبديلها الآجل المؤكَّد، ونقدية ألغتها الإدارة (عكسٌ حقيقي)
    inv({ id: 'i1', salesRepId: 'r1', type: 'CASH', total: 1000, paidAmt: 1000, invoiceDate: nov }),
    inv({ id: 'i2', salesRepId: 'r1', type: 'CASH', status: 'CANCELLED', total: 500, paidAmt: 500, invoiceDate: nov,
      accountEntries: [{ type: 'INVOICE_DEBIT' }, { type: 'RECEIPT_CREDIT' }, { type: 'INVOICE_CREDIT', description: CASH_VOID_KEEP_COLLECTION_NOTE }] }),
    inv({ id: 'i3', salesRepId: 'r1', type: 'CREDIT', total: 500, paidAmt: 500, invoiceDate: nov }),
    inv({ id: 'i4', salesRepId: 'r1', type: 'CASH', status: 'CANCELLED', total: 200, paidAmt: 200, invoiceDate: nov,
      accountEntries: [{ type: 'INVOICE_CREDIT', description: CASH_VOID_KEEP_COLLECTION_NOTE }, { type: 'RECEIPT_DEBIT' }] }),
    // خالد آجلٌ ٩٠٠ صافياً (١٠٠٠ − مرتجع ١٠٠) حصّل منه ٦٠٠ بسند
    inv({ id: 'i5', salesRepId: 'r2', type: 'CREDIT', total: 1000, invoiceDate: nov }),
    inv({ id: 'i6', salesRepId: 'r2', type: 'RETURN', total: 100, invoiceDate: nov }),
  ];
  RECEIPTS = [{ id: 'rc1', tenantId: 't1', salesRepId: 'r2', status: 'ACTIVE', amount: 600, receiptDate: nov, teamId: null }];
  VISITS = visits();
}
const RANGE = { from: '2026-11-01', to: '2026-11-10' };
const visitReads = () => calls.filter((c) => c.model === 'repVisit' && c.op === 'findMany');
/** كل قراءة زيارات: شرط المسار ومؤشّر الدفعة في AND، بالترتيب الثابت، ودفعةٌ لا تتجاوز ٥٬٠٠٠ */
function assertBatched(label: string): void {
  const reads = visitReads();
  assert.equal(reads.length, Math.ceil(VISIT_COUNT / VISIT_BATCH_SIZE), `${label}: دفعاتٌ حتى تنفد`);
  for (const [i, c] of reads.entries()) {
    assert.deepEqual(c.args.orderBy, NEWEST_FIRST, label);
    assert.ok(c.args.take <= VISIT_BATCH_SIZE, label);
    assert.ok(Array.isArray(c.args.where.AND) && c.args.where.AND.length === 2, `${label}: الشرط والمؤشّر عنصران في AND`);
    if (i === 0) assert.deepEqual(c.args.where.AND[1], {}, `${label}: الدفعة الأولى بلا مؤشّر`);
    else {
      // المؤشّر آخر صفٍّ في الدفعة السابقة: أقدم لحظةً منه، أو لحظته نفسها بمعرّفٍ أصغر
      const cur = c.args.where.AND[1].OR[1];
      assert.deepEqual(c.args.where.AND[1], olderThan({ id: cur.id.lt, createdAt: cur.createdAt }), label);
      const prevLast = `v${String(VISIT_COUNT - i * VISIT_BATCH_SIZE).padStart(6, '0')}`;
      assert.equal(cur.id.lt, prevLast, `${label}: المؤشّر آخر صفوف الدفعة السابقة`);
    }
    assert.equal(c.args.select.id, true, `${label}: المعرّف للمؤشّر`);
  }
}

// ═══ البند ٢: أرصدة العملاء ═══

test('أرصدة العملاء: كل غير محذوف بدينه — المحظور والموقوف داخلان بحالتهما، والمحذوف وحده خارج', async () => {
  reset();
  const body = await run('/balances', { type: 'overdue' });
  assert.deepEqual(body.data.map((c: Row) => [c.id, c.status, c.balance]), [['B', 'BLOCKED', 250], ['A', 'ACTIVE', 100], ['C', 'INACTIVE', 50]]);
  const total = body.data.reduce((t: number, c: Row) => t + c.balance, 0);
  assert.equal(total, 400, '«إجمالي مديونية الشركة» يشمل المحظور والموقوف');
  const q = calls.find((c) => c.model === 'customer')!.args;
  assert.deepEqual(q.where.status, { not: 'DELETED' });
  assert.equal(q.select.status, true);
  assert.equal('meta' in body, false, 'لا meta لتقريرٍ بلا مدى ولا سقف');
});

// ═══ البند ٦ + ٧: أداء المناديب ═══

test('أداء المناديب: «نسبة التحصيل» = (السندات + البيع النقدي المحصَّل) ÷ صافي المبيعات، و«التحصيل» السندات وحدها كما كان', async () => {
  reset();
  const body = await run('/rep-performance', {});
  const byId = new Map<string, Row>(body.data.map((r: Row) => [r.id, r]));
  const salem = byId.get('r1')!;
  // صافي سالم: النقدية المؤكَّدة ١٠٠٠ + بديل المُبطَلة ٥٠٠ (الملغاة خارج المبيعات)؛ ونقده المحصَّل: ١٠٠٠ + المُبطَلة المحتفظ بتحصيلها ٥٠٠
  assert.deepEqual([salem.salesTotal, salem.collectionsTotal, salem.cashSalesTotal, salem.collectionRate], [1500, 0, 1500, 100],
    'مندوبٌ نقديٌّ كلّه ١٠٠٪ لا ٠٪ — والملغاة إدارياً (عُكس تحصيلها) خارج النقد');
  const khaled = byId.get('r2')!;
  assert.deepEqual([khaled.salesTotal, khaled.collectionsTotal, khaled.cashSalesTotal, khaled.collectionRate], [900, 600, 0, 67]);
  // الشرط هو COLLECTED_CASH_SALE نفسه (صفحة «طرق الدفع»، القرار ١) — بالمرجع لا بنسخة — في AND مع النطاق والفريق
  const g = calls.find((c) => c.model === 'invoice' && c.op === 'groupBy')!.args;
  assert.deepEqual(g.by, ['salesRepId']);
  assert.ok(g.where.AND.includes(COLLECTED_CASH_SALE), 'شرط طرق الدفع حرفياً');
  assert.deepEqual(g._sum, { paidAmt: true });
  assert.equal(calls.filter((c) => c.model === 'invoice' && c.op === 'groupBy').length, 1, 'تجميعٌ واحد لكل المناديب (لا N+1)');
  assert.ok(!('invoiceDate' in g.where), 'بلا مدى: بلا شرط تاريخ كمبيعات الصفّ');

  await run('/rep-performance', RANGE);
  const g2 = calls.filter((c) => c.model === 'invoice' && c.op === 'groupBy').at(-1)!.args;
  assert.deepEqual(g2.where.invoiceDate, { gte: new Date('2026-11-01'), lt: new Date('2026-11-11') }, 'مدى الصفّ نفسه');
});

test('أداء المناديب: الزيارات كلّها دفعاتٍ (٢٠٬٥٠٠ فوق سقف ٢٠٬٠٠٠ القديم)، ومن الأحدث، وmeta.truncated صادق', async () => {
  reset();
  const body = await run('/rep-performance', RANGE);
  const khaled = body.data.find((r: Row) => r.id === 'r2');
  assert.equal(khaled.visitsCount, VISIT_COUNT, 'كل الوقفات لا أقدم ٢٠٬٠٠٠');
  assert.deepEqual(body.meta, { truncated: false, limit: VISIT_RAW_CEILING });
  assertBatched('الأداء');
});

// ═══ البند ٧: زيارات العملاء وساعات العمل والتقييم ═══

test('زيارات العملاء: كل الزيارات بلا تكرارٍ ولا سقوط (كان ٥٬٠٠٠)، والأحدث أولاً، وmeta بجانب data', async () => {
  reset();
  const body = await run('/customer-visits', RANGE);
  assert.equal(body.data.count, VISIT_COUNT);
  assert.equal(new Set(body.data.visits.map((v: Row) => v.id)).size, VISIT_COUNT, 'كل سجلٍّ مرّةً واحدة عبر الدفعات');
  assert.equal(body.data.visits[0].id, `v${String(VISIT_COUNT - 1).padStart(6, '0')}`, 'الأحدث أولاً كما كان');
  assert.deepEqual(body.meta, { truncated: false, limit: VISIT_RAW_CEILING });
  assertBatched('زيارات العملاء');
});

test('ساعات العمل: زيارات كل الأيام (كان ١٠٬٠٠٠)، والمدى المطبَّق بالأيام المحلية مع القصّ والافتراض', async () => {
  reset();
  const body = await run('/work-hours', { ...RANGE, tz: '180' });
  const khaled = body.data.find((r: Row) => r.id === 'r2');
  assert.equal(khaled.visitsTotal, VISIT_COUNT);
  assert.deepEqual(body.meta, { tzOffsetMin: 180, truncated: false, limit: VISIT_RAW_CEILING, appliedRange: { from: '2026-11-01', to: '2026-11-10', defaulted: false } });
  assertBatched('ساعات العمل');

  // مدىً فوق ٣١ يوماً: يُقصّ ويُعلن، و«من» المطبَّق بعد القصّ
  reset();
  const clamped = await run('/work-hours', { from: '2026-09-01', to: '2026-11-10', tz: '0' });
  assert.equal(clamped.meta.rangeClamped, 31);
  assert.deepEqual(clamped.meta.appliedRange, { from: '2026-10-11', to: '2026-11-10', defaulted: false });
  assert.deepEqual([clamped.data[0].days[0].date, clamped.data[0].days.at(-1).date], ['2026-10-11', '2026-11-10'], 'المدى المعلَن هو أيام الجدول نفسها');

  // بلا «من»: أسبوعٌ اختاره الخادم
  reset();
  const dflt = await run('/work-hours', { tz: '0' });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(dflt.meta.appliedRange.defaulted, true);
  assert.equal(dflt.meta.appliedRange.to, today);
  assert.equal(dflt.meta.appliedRange.from, dflt.data[0].days[0].date);
});

test('التقييم بالزيارات: العدد كلّه بتعريف الأداء نفسه، والأعمدة ما يحتاجه الدمج وحده، وmeta.limit للزيارات وحدها', async () => {
  reset();
  const body = await run('/rep-ranking', { metric: 'visits', ...RANGE, tz: '0' });
  const khaled = body.data.rows.find((r: Row) => r.repId === 'r2');
  assert.equal(khaled.value, VISIT_COUNT);
  assert.deepEqual(body.meta, { truncated: false, limit: VISIT_RAW_CEILING });
  assertBatched('التقييم');
  assert.deepEqual(Object.keys(visitReads()[0].args.select).sort(), ['createdAt', 'customerId', 'durationSec', 'id', 'salesRepId', 'startedAt']);

  reset();
  const sales = await run('/rep-ranking', { metric: 'sales', ...RANGE, tz: '0' });
  assert.deepEqual(sales.meta, { truncated: false }, 'لا حدّ ولا مدىً افتراضيّ لغير الزيارات والمسافة');
});

test('التقييم بالمسافة: المدى المطبَّق في meta — أسبوعٌ افتراضيّ، وقصّ ٣١ يوماً — ويطابق data.range', async () => {
  reset();
  REPS = []; // بلا مناديب: لا نقاط تُقرأ، والمدى يُحسب كما هو
  const dflt = await run('/rep-ranking', { metric: 'distance', tz: '0' });
  assert.equal(dflt.meta.appliedRange.defaulted, true);
  assert.deepEqual([dflt.meta.appliedRange.from, dflt.meta.appliedRange.to], [dflt.data.range.from, dflt.data.range.to]);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(dflt.meta.appliedRange.to, today);
  assert.equal(dflt.meta.appliedRange.from, new Date(Date.parse(today) - 6 * 86_400_000).toISOString().slice(0, 10), 'سبعة أيام تنتهي اليوم');

  const clamped = await run('/rep-ranking', { metric: 'distance', from: '2026-08-01', to: '2026-11-10', tz: '0' });
  assert.equal(clamped.data.clampedDays, 31);
  assert.deepEqual(clamped.meta.appliedRange, { from: '2026-10-11', to: '2026-11-10', defaulted: false });
  assert.equal('limit' in clamped.meta, false);
});

// ═══ البند ٧: المرتجع والطلبات — الملخّص كلّه، والقائمة بسقفٍ مُعلَن ═══

function manyReturns(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const reason = i % 5 === 0 ? 'DAMAGED' : i === 1 || i === 2 ? null : 'NORMAL';
    const row = inv({
      id: `R${i}`, number: `R-${i}`, salesRepId: 'r2', type: 'RETURN', total: 10, taxAmt: 1.3, returnReason: reason, returnToStock: true,
      documentKind: null, notes: null, createdAt: D('2026-11-05T09:00:00Z'), invoiceDate: new Date(Date.UTC(2026, 10, 2) + i * 60_000),
      originalInvoice: null, team: null, customer: { id: 'c1', name: 'بقالة', phone: '', city: null }, salesRep: { id: 'r2', name: 'خالد' },
    });
    row.items = [{
      id: `R${i}a`, qty: 1, lineTotal: 10, returnExpired: reason === 'DAMAGED' ? true : null, expiresAt: null, returnOfItemId: null, itemName: 'صنف',
      unitName: null, unitFactor: 1, baseQty: 1, product: { name: 'صنف', unit: 'حبة', primaryUnitId: null },
    }];
    return row;
  });
}

test('المرتجع: الملخّص (العدد والقيمة والأسباب والبنود المنتهية والنسبة) على كل المدى، والقائمة ٥٬٠٠٠ مع truncated', async () => {
  reset();
  INVOICES = [...manyReturns(5_003), inv({ id: 'S', salesRepId: 'r2', type: 'CREDIT', total: 100_000, invoiceDate: D('2026-11-03T09:00:00Z') })];
  const body = await run('/returns', RANGE);
  const s = body.data.summary;
  assert.equal(body.data.returns.length, 5_000, 'القائمة مقصوصة');
  assert.equal(body.data.returns[0].id, 'R5002', 'الأحدث أولاً كما كانت');
  assert.deepEqual([s.count, s.total, s.salesTotal, s.returnRate, s.expiredLines], [5_003, 50_030, 100_000, 50, 1_001]);
  // ١٬٠٠١ تالفاً (كل خامس)، والسبب الفارغ (اثنان) يُعدّ «عادياً» كما يعرضه الصفّ
  assert.deepEqual(s.byReason, { DAMAGED: { count: 1_001, total: 10_010 }, NORMAL: { count: 4_002, total: 40_020 } });
  assert.deepEqual(body.meta, { truncated: true, limit: 5_000, appliedRange: { from: '2026-11-01', to: '2026-11-10', defaulted: false } });
  assert.deepEqual([body.data.rangeApplied, body.data.defaultDays], [true, null], 'الحقول القائمة كما هي');
  const list = calls.find((c) => c.model === 'invoice' && c.op === 'findMany')!.args;
  assert.equal(list.take, 5_001, 'صفٌّ زائد شاهدُ «يوجد المزيد»');

  // تحت السقف: بلا قصّ، والملخّص هو نفسه مجموع القائمة
  reset();
  INVOICES = manyReturns(7);
  const small = await run('/returns', {});
  assert.equal(small.meta.truncated, false);
  assert.equal(small.meta.appliedRange.defaulted, true);
  assert.equal(small.data.summary.count, small.data.returns.length);
});

test('الطلبات: الملخّص تجميعٌ على كل طلبات المدى، والقائمة ٥٬٠٠٠ بترتيب التسليم مع truncated، والمدى المطبَّق', async () => {
  reset();
  INVOICES = Array.from({ length: 5_001 }, (_, i) => inv({
    id: `o${i}`, number: `O-${i}`, salesRepId: 'r2', type: 'CREDIT', total: 10, paidAmt: 4, remainingAmt: 6, invoiceDate: D('2026-11-01T09:00:00Z'),
    deliveryDate: new Date(Date.UTC(2026, 10, 3) + i * 60_000), team: null, customer: { id: 'c1', name: 'بقالة', phone: '', city: null }, salesRep: { id: 'r2', name: 'خالد' },
  }));
  INVOICES.push(inv({ id: 'gone', type: 'CREDIT', status: 'CANCELLED', total: 999, deliveryDate: D('2026-11-04T09:00:00Z') }));
  INVOICES.push(inv({ id: 'nodate', type: 'CREDIT', total: 999, deliveryDate: null }));
  const body = await run('/orders', RANGE);
  assert.deepEqual(body.data.summary, { count: 5_001, total: 50_010, paid: 20_004, remaining: 30_006 }, 'المتبقي من remainingAmt');
  assert.equal(body.data.orders.length, 5_000);
  assert.equal(body.data.orders[0].id, 'o0', 'الأقرب تسليماً أوّلاً كما كان');
  assert.deepEqual(body.meta, { truncated: true, limit: 5_000, appliedRange: { from: '2026-11-01', to: '2026-11-10', defaulted: false } });

  // بلا مدى: تاريخ التسليم من ٩٠ يوماً مضت بلا حدٍّ أعلى — فالمُعلَن مفتوح الطرف لا «إلى اليوم»
  const dflt = await run('/orders', {});
  assert.equal(dflt.meta.appliedRange.defaulted, true);
  assert.equal(dflt.meta.appliedRange.to, null);
  assert.equal(dflt.meta.appliedRange.from, new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
});

// ═══ البند ٩: المبيعات بكل تجميعاتها ═══

test('المبيعات: كل تجميعٍ وملخّصه يحمل meta.appliedRange — الافتراضيّ ٩٠ يوماً بأيام UTC، والصريح كما طُلب، والطرف الغائب null', async () => {
  reset();
  INVOICES = []; // المدى وحده موضع الاختبار — التجميعات نفسها لها net-sales.test
  for (const groupBy of ['rep', 'customer', 'product', 'channel', 'region', 'team', undefined]) {
    const body = await run('/sales', groupBy ? { groupBy } : {});
    const now = Date.now();
    assert.equal(body.meta.appliedRange.defaulted, true, String(groupBy));
    assert.equal(body.meta.appliedRange.to, null, 'النافذة الافتراضية بلا حدٍّ أعلى');
    assert.equal(body.meta.appliedRange.from, new Date(now - 90 * 86_400_000).toISOString().slice(0, 10));
  }
  const explicit = await run('/sales', { ...RANGE, groupBy: 'rep' });
  assert.deepEqual(explicit.meta, { appliedRange: { from: '2026-11-01', to: '2026-11-10', defaulted: false } });
  const oneSided = await run('/sales', { from: '2026-11-01', groupBy: 'customer' });
  assert.deepEqual(oneSided.meta.appliedRange, { from: '2026-11-01', to: null, defaulted: false });
  const summary = await run('/sales', {});
  assert.equal(summary.data.summary.defaultRangeDays, 90, 'الحقل القائم باقٍ');
});

// ═══ حارس نصّي: لا سقفٌ صامت باقٍ في قراءات الزيارات ═══

test('حارس نصّي: قراءات الزيارات الأربع دفعاتٌ بالمؤشّر — لا take ثابت ولا ترتيب تصاعديّ عليها', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'reports.ts'), 'utf8').replace(/\r\n/g, '\n');
  for (const [route, next] of [['/rep-performance', '/customer-visits'], ['/customer-visits', '/unvisited-customers'], ['/work-hours', '/rep-ranking']]) {
    const seg = src.slice(src.indexOf(`router.get('${route}'`), src.indexOf(`router.get('${next}'`));
    assert.match(seg, /readNewestFirst\(\(after, take\) => prisma\.repVisit\.findMany\(\{\s+where: \{ AND: \[/, route);
    assert.match(seg, /orderBy: NEWEST_FIRST, take,/, route);
    assert.doesNotMatch(seg, /take: (5000|10000|20000|50000)\b/, `${route}: سقفٌ صامت`);
  }
  const rank = src.slice(src.indexOf("} else if (ids.length && metric === 'visits') {"), src.indexOf("} else if (ids.length && metric === 'appTime') {"));
  assert.match(rank, /readNewestFirst\(\(after, take\) => prisma\.repVisit\.findMany\(\{/);
  assert.doesNotMatch(rank, /take: 50000/);
  // الطلبات والمرتجع: صفٌّ زائد شاهد، والملخّص تجميعٌ لا مجموعُ القائمة
  assert.equal(src.split('take: REPORT_LIST_LIMIT + 1').length - 1, 2);
  assert.doesNotMatch(src, /count: orders\.length|count: rows\.length,\n\s+total: Math\.round/, 'ملخّصٌ من قائمةٍ مقصوصة');
});
