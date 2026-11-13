// «أفضل المناديب» وعدّا العملاء المدينين في لوحة التحكم، و«أفضل المناديب أداءً» في لوحة مالك المنصة
// (تدقيق دقّة التقارير، طلب المالك ١٣ نوفمبر ٢٠٢٦ — البندان ١ و٢).
//
// الخلل: salesRep.findMany بـtake: 5 بلا orderBy يأخذ أقدم خمسة صفوف (والموقوف معها) ثم يرتّبها وحدها، فيغيب أعلى المناديب
// مبيعاً؛ ولوحة المالك بالخلل نفسه وبإجماليٍّ لا يطرح المرتجع. وعدّا «العملاء بأرصدة» و«تجاوز الحد الائتماني» يُسقطان
// الموقوف والمحظور وهما مدينان.
//
// المسارات الحقيقية فوق Prisma مزيّف يقيّم شروط where فعلاً (المستأجر، الحالة، الشهر، النشاط، النطاق) — لا قاعدة ولا شبكة.
// ترتيب صفوف المناديب في المزيّف هو ترتيب إنشائهم، فالسلوك القديم (أول خمسة) يرسب هنا.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dashboard-top-reps-test-secret';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rankTopReps } from '../services/topReps';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

// —— أداة مطابقة where بالقدر الذي تكتبه المسارات ——
const FIELD_CREDIT_LIMIT = { __field: 'creditLimit' };
function cmp(v: any, cond: any, row: Row): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return +v === +cond;
  if (typeof cond !== 'object') return v === cond;
  const val = (x: any) => (x && typeof x === 'object' && '__field' in x ? row[x.__field] : x);
  for (const [op, raw] of Object.entries(cond)) {
    const c = val(raw);
    if (op === 'not') { if (c === null ? (v === null || v === undefined) : v === c) return false; }
    else if (op === 'in') { if (!(c as unknown[]).includes(v)) return false; }
    else if (op === 'gt') { if (!(v > c)) return false; }
    else if (op === 'gte') { if (!(v >= c)) return false; }
    else if (op === 'lt') { if (!(v < c)) return false; }
    else if (op === 'lte') { if (!(v <= c)) return false; }
    else throw new Error(`عامل غير مدعوم في المزيّف: ${op}`);
  }
  return true;
}
let REPS: Row[] = [];
/** «الفرق»: مشرفو كل فريق — وسم المستند (team) وعضوية المندوب (teamMemberships) يُقيَّمان بها */
const TEAM_SUPERVISORS: Record<string, string[]> = { A: ['a1'], B: ['a2'] };
function match(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'AND') { if (!(cond as Row[]).every((w) => match(row, w))) return false; continue; }
    if (k === 'OR') { if (!(cond as Row[]).some((w) => match(row, w))) return false; continue; }
    if (k === 'salesRep') { const rep = REPS.find((r) => r.id === row.salesRepId); if (!rep || !match(rep, cond)) return false; continue; }
    if (k === 'adminScopes') { if (!(row.scopedFor ?? []).includes(cond.some.adminId)) return false; continue; }
    if (k === 'team') { if (!(TEAM_SUPERVISORS[row.teamId] ?? []).includes(cond.supervisors.some.adminId)) return false; continue; }
    if (k === 'teamMemberships') {
      const admin = cond.some.team.supervisors.some.adminId;
      if (!(row.teams ?? []).some((t: string) => (TEAM_SUPERVISORS[t] ?? []).includes(admin))) return false;
      continue;
    }
    if (!cmp(row[k], cond, row)) return false;
  }
  return true;
}

// —— البيانات: تسعة مناديب بترتيب الإنشاء، والكبار متأخّرون ——
const now = new Date();
const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
const lastMonth = new Date(startOfMonth.getTime() - 86400000);
const rep = (id: string, name: string, isActive = true, scopedFor: string[] = []) => ({ id, name, isActive, tenantId: 'T1', scopedFor });
const BASE_REPS = [
  rep('r1', 'أحمد', true, ['a1']), rep('r2', 'بدر', true, ['a1']), rep('r3', 'جابر', false, ['a1']), rep('r4', 'حسن', true, ['a1']),
  rep('r5', 'خالد', true, ['a1']), rep('r6', 'رائد'), rep('r7', 'سالم'), rep('r8', 'طارق', true, ['a1']), rep('r9', 'عادل', true, ['a1']),
];
let seq = 0;
const doc = (salesRepId: string | null, type: string, total: number, o: Row = {}) =>
  ({ id: `d${++seq}`, tenantId: 'T1', status: 'CONFIRMED', invoiceDate: now, salesRepId, type, total, ...o });
const BASE_DOCS = [
  doc('r1', 'CASH', 5000), doc('r1', 'CREDIT', 300000, { status: 'CANCELLED' }), // الملغاة لا تُحسب
  doc('r2', 'CREDIT', 20000),
  doc('r3', 'CREDIT', 100000), // موقوف: لا يظهر مهما باع
  doc('r4', 'CASH', 8000), doc('r4', 'CASH', 1000000, { tenantId: 'T2' }), // شركة أخرى
  doc('r5', 'CREDIT', 12000), doc('r5', 'CREDIT', 500000, { invoiceDate: lastMonth }), // الشهر الماضي: خارج اللوحة، داخل لوحة المالك
  doc('r6', 'CREDIT', 50000), doc('r6', 'CASH', 30000),
  doc('r7', 'CREDIT', 60000),
  doc('r8', 'CASH', 55000),
  doc('r9', 'CREDIT', 90000), doc('r9', 'RETURN', 50000), // صافيه ٤٠٬٠٠٠ لا ٩٠٬٠٠٠
  doc(null, 'CASH', 7000), // مستند المكتب بلا مندوب
];
let DOCS: Row[] = [];
const CUSTOMERS = [
  { id: 'c1', tenantId: 'T1', status: 'ACTIVE', balance: 100, creditLimit: 50 },
  { id: 'c2', tenantId: 'T1', status: 'INACTIVE', balance: 300, creditLimit: 0 },
  { id: 'c3', tenantId: 'T1', status: 'BLOCKED', balance: 7500, creditLimit: 1000 },
  { id: 'c4', tenantId: 'T1', status: 'DELETED', balance: 900, creditLimit: 100 },
  { id: 'c5', tenantId: 'T1', status: 'ACTIVE', balance: 0, creditLimit: 0 },
  { id: 'c6', tenantId: 'T1', status: 'ACTIVE', balance: 1e-9, creditLimit: 0 }, // غبار عائمة لا دين
  { id: 'c7', tenantId: 'T2', status: 'BLOCKED', balance: 999, creditLimit: 1 },
];
const reset = () => { REPS = BASE_REPS.map((r) => ({ ...r })); DOCS = BASE_DOCS.map((d) => ({ ...d })); calls = []; scopeMode = 'NONE'; };

let calls: [string, Row][] = [];
const sumOf = (rows: Row[]) => rows.reduce((s, r) => s + Number(r.total), 0);
const empty = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0, aggregate: async () => ({ _sum: {}, _count: {} }), groupBy: async () => [] };
const db = new Proxy({
  invoice: {
    async groupBy(a: Row) {
      calls.push(['invoice.groupBy', a]);
      const groups = new Map<string, Row>();
      for (const d of DOCS.filter((x) => match(x, a.where))) {
        const key = (a.by as string[]).map((k) => String(d[k])).join('|');
        const g = groups.get(key) ?? { ...Object.fromEntries((a.by as string[]).map((k) => [k, d[k]])), _sum: { total: 0 }, _count: { _all: 0 } };
        g._sum.total += d.total; g._count._all += 1;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
    async aggregate(a: Row) { const rows = DOCS.filter((d) => match(d, a.where)); return { _sum: { total: sumOf(rows) }, _count: { id: rows.length } }; },
    async findMany(a: Row) { calls.push(['invoice.findMany', a]); return []; },
  },
  receipt: { async aggregate() { return { _sum: { amount: 0 }, _count: { id: 0 } }; } },
  customer: {
    fields: { creditLimit: FIELD_CREDIT_LIMIT },
    async count(a: Row) { return CUSTOMERS.filter((c) => match(c, a.where)).length; },
    async findMany() { return []; },
  },
  salesRep: {
    async findMany(a: Row) { calls.push(['salesRep.findMany', a]); return REPS.filter((r) => match(r, a.where)).map((r) => ({ id: r.id, name: r.name })); },
    async count(a: Row) { return REPS.filter((r) => match(r, a.where)).length; },
  },
  product: { async count() { return 0; } },
  tenant: {
    async findUnique() {
      return { id: 'T1', name: 'شركة', plan: 'PRO', isActive: true, subscriptionEndsAt: null, createdAt: now, accountingEnabled: true, warehouseEnabled: false };
    },
  },
} as Row, { get: (t, k: string) => (k in t ? t[k] : k === 'then' ? undefined : empty) });

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
stub('config/database', { default: db });
stub('services/mailer', { async sendMail() { return true; }, mailLayout: () => '' });
/* eslint-disable @typescript-eslint/no-var-requires */
const realScope = require('../services/adminScope') as typeof import('../services/adminScope');
// المستخدم a1: مقيَّدٌ بالقوائم (مناديبه بقائمته ومستنداته بقيد المستند الحقيقيّ composeRecordWhere)، أو مشرف فرق
// (مناديب فرقه بعضويتهم، ومستنداته بوسم فرقه — composeTeamRecordWhere الحقيقيّ)، أو بلا قيد
let scopeMode: 'NONE' | 'LISTS' | 'TEAMS' = 'NONE';
const REP_SCOPE = { adminScopes: { some: { adminId: 'a1' } } };
const TEAM_REP_SCOPE = { teamMemberships: { some: { team: { supervisors: { some: { adminId: 'a1' } } } } } };
stub('services/adminScope', {
  ...realScope,
  scopedRecordWhere: async () => (scopeMode === 'LISTS' ? realScope.composeRecordWhere({}, REP_SCOPE, realScope.SHAPE_INVOICE_RECEIPT)
    : scopeMode === 'TEAMS' ? realScope.composeTeamRecordWhere('a1', realScope.SHAPE_INVOICE_RECEIPT) : {}),
  adminCustomerFilter: async () => ({}),
  adminRepFilter: async () => (scopeMode === 'LISTS' ? REP_SCOPE : scopeMode === 'TEAMS' ? TEAM_REP_SCOPE : {}),
});
const dashboard = require('../routes/dashboard').default;
const tenants = require('../routes/tenants').default;
/* eslint-enable @typescript-eslint/no-var-requires */

/** معالج المسار الأخير وحده — المصادقة والصلاحية لهما اختباراتهما */
async function run(router: unknown, routePath: string, params: Row = {}) {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === routePath && l.route.methods.get);
  assert.ok(layer, `GET ${routePath} غير موجود`);
  const handler = layer.route.stack.slice(-1)[0].handle;
  let body: Row | null = null;
  const res = { status() { return this; }, json(b: Row) { body = b; return this; } };
  let err: unknown = null;
  await handler({ query: {}, params, user: { id: 'a1', role: 'ADMIN', tenantId: 'T1' } }, res, (e: unknown) => { err = e; });
  if (err) throw err;
  return body!.data;
}
const ids = (rows: Row[]) => rows.map((r) => r.id);

test('المساعد: الصافي والعدد والترتيب بالمبلغ ثم بالاسم ثم بالمعرّف، والحدّ', () => {
  const reps = [{ id: 'b', name: 'زياد' }, { id: 'a', name: 'زياد' }, { id: 'c', name: 'باسم' }, { id: 'd', name: 'أنس' }];
  const groups = [
    { salesRepId: 'a', type: 'CREDIT', _sum: { total: 100 }, _count: { _all: 2 } },
    { salesRepId: 'b', type: 'CASH', _sum: { total: 100 }, _count: { _all: 1 } },
    { salesRepId: 'c', type: 'CREDIT', _sum: { total: 0.1 }, _count: { _all: 1 } },
    { salesRepId: 'c', type: 'CASH', _sum: { total: 0.2 }, _count: { _all: 1 } },
    { salesRepId: 'c', type: 'RETURN', _sum: { total: 0.1 }, _count: { _all: 3 } },
    { salesRepId: null, type: 'CASH', _sum: { total: 9999 }, _count: { _all: 1 } },
    { salesRepId: 'ghost', type: 'CASH', _sum: { total: 9999 }, _count: { _all: 1 } }, // ليس من المرشّحين
  ];
  assert.deepEqual(rankTopReps(reps, groups), [
    { id: 'a', name: 'زياد', salesTotal: 100, invoicesCount: 2 },
    { id: 'b', name: 'زياد', salesTotal: 100, invoicesCount: 1 },
    { id: 'c', name: 'باسم', salesTotal: 0.2, invoicesCount: 2 }, // لا 0.20000000000000004، والمرتجع لا يُعدّ فاتورة
    { id: 'd', name: 'أنس', salesTotal: 0, invoicesCount: 0 },
  ]);
  assert.deepEqual(ids(rankTopReps(reps, groups, 2)), ['a', 'b']);
  // نشرُ مجموعٍ null (لا مستندات بمبلغ) صفرٌ لا NaN
  assert.deepEqual(rankTopReps([{ id: 'x', name: 'س' }], [{ salesRepId: 'x', type: 'CASH', _sum: { total: null }, _count: { _all: 1 } }]),
    [{ id: 'x', name: 'س', salesTotal: 0, invoicesCount: 1 }]);
});

test('لوحة التحكم: أعلى خمسة من كل المناديب النشطين بصافي الشهر — لا أول خمسة صفوف', async () => {
  reset();
  const d = await run(dashboard, '/');
  // السلوك القديم: r1..r5 (ومعهم الموقوف r3)، وأعلاهم r5 أو r3. الصحيح:
  assert.deepEqual(d.topReps.map((r: Row) => [r.id, r.salesTotal, r.invoicesCount]), [
    ['r6', 80000, 2], ['r7', 60000, 1], ['r8', 55000, 1], ['r9', 40000, 1], ['r2', 20000, 1],
  ]);
  assert.deepEqual(Object.keys(d.topReps[0]).sort(), ['id', 'invoicesCount', 'name', 'salesTotal'], 'شكل الردّ كما كان');
  assert.ok(!ids(d.topReps).includes('r3'), 'الموقوف لا يظهر ولو باع أكثر من الجميع');
  // ملخّص الشهر لم يتغيّر بنيته: صافٍ ومستند المكتب داخله
  assert.equal(d.month.salesTotal, 5000 + 20000 + 100000 + 8000 + 12000 + 80000 + 60000 + 55000 + 90000 - 50000 + 7000);
});

test('لوحة التحكم: تجميعٌ واحد بالمندوب والنوع وصفوف مناديب خفيفة — لا فواتير كل مندوب ولا take: 5', async () => {
  reset();
  await run(dashboard, '/');
  const groupBys = calls.filter(([op]) => op === 'invoice.groupBy');
  assert.equal(groupBys.length, 1);
  const g = groupBys[0][1];
  assert.deepEqual(g.by, ['salesRepId', 'type']);
  assert.equal(g.where.tenantId, 'T1');
  assert.equal(g.where.status, 'CONFIRMED');
  assert.deepEqual(g.where.salesRepId, { not: null });
  assert.equal(+g.where.invoiceDate.gte, +startOfMonth, 'حدّ الشهر كما كان: أول يوم فيه بتوقيت الخادم');
  assert.equal(g.where.invoiceDate.lte, undefined);
  const repQueries = calls.filter(([op]) => op === 'salesRep.findMany');
  assert.equal(repQueries.length, 1);
  const q = repQueries[0][1];
  assert.equal(q.take, undefined, 'لا قصّ قبل الترتيب');
  assert.equal(q.where.isActive, true);
  assert.deepEqual(q.select, { id: true, name: true });
});

test('لوحة التحكم: أصحاب المبيعات أولاً، ويكمل الصفرُ القائمة بالاسم، والصافي السالب بعده', async () => {
  reset();
  DOCS = [doc('r7', 'CREDIT', 500), doc('r6', 'CASH', 900), doc('r8', 'RETURN', 1000)];
  const d = await run(dashboard, '/');
  assert.deepEqual(d.topReps.map((r: Row) => [r.id, r.salesTotal]), [['r6', 900], ['r7', 500], ['r1', 0], ['r2', 0], ['r4', 0]]);
  DOCS = [doc('r9', 'CREDIT', 300), doc('r2', 'CASH', 300)];
  const tie = await run(dashboard, '/');
  assert.deepEqual(ids(tie.topReps).slice(0, 2), ['r2', 'r9'], 'التعادل بالاسم: بدر قبل عادل');
});

test('لوحة التحكم: المستخدم المقيَّد يرى ترتيب مناديبه وحدهم', async () => {
  reset();
  scopeMode = 'LISTS';
  const d = await run(dashboard, '/');
  // r6 وr7 خارج قائمته؛ r3 موقوف
  assert.deepEqual(d.topReps.map((r: Row) => [r.id, r.salesTotal]), [['r8', 55000], ['r9', 40000], ['r2', 20000], ['r5', 12000], ['r4', 8000]]);
});

test('لوحة التحكم: مشرف الفرق — مناديب فرقه، ومبالغهم بوسم المستند لا بعضوية المندوب', async () => {
  reset();
  scopeMode = 'TEAMS';
  REPS = REPS.map((r) => ({ ...r, teams: r.id === 'r8' ? ['A'] : r.id === 'r9' ? ['A', 'B'] : r.id === 'r2' ? ['B'] : [] }));
  DOCS = [
    doc('r8', 'CREDIT', 1000, { teamId: 'A' }),
    doc('r8', 'CASH', 7000, { teamId: null }), // بلا وسم: لا يراه المشرف (فشلٌ مغلق)
    doc('r9', 'CREDIT', 3000, { teamId: 'A' }), doc('r9', 'RETURN', 500, { teamId: 'A' }),
    doc('r9', 'CREDIT', 9000, { teamId: 'B' }), // مندوبٌ مشترك: مبيعات فريقه الآخر لا تُجمع لمشرف A
    doc('r2', 'CREDIT', 50000, { teamId: 'B' }), // مندوب فريقٍ لا يشرف عليه
  ];
  const d = await run(dashboard, '/');
  assert.deepEqual(d.topReps.map((r: Row) => [r.id, r.salesTotal, r.invoicesCount]), [['r9', 2500, 1], ['r8', 1000, 1]]);
});

test('لوحة التحكم: «العملاء بأرصدة» و«تجاوز الحد» بكل عميلٍ غير محذوف، و«النشطون» كما كان', async () => {
  reset();
  const d = await run(dashboard, '/');
  assert.equal(d.customers.total, 3, 'النشطون: c1 وc5 وc6');
  assert.equal(d.customers.withBalance, 3, 'بأرصدة: c1 والموقوف c2 والمحظور c3 — لا المحذوف c4 ولا غبار c6');
  assert.equal(d.customers.creditExceeded, 2, 'تجاوز الحد: c1 والمحظور c3 — لا المحذوف c4');
});

test('لوحة المالك: أعلى خمسة نشطين بالصافي على كل الزمن، والإجماليات كما كانت', async () => {
  reset();
  const d = await run(tenants, '/:id/performance', { id: 'T1' });
  // كل الزمن كما كان (r5 بفاتورة الشهر الماضي في القمة)، والمرتجع مطروح (r9 = ٤٠٬٠٠٠)، والموقوف r3 غائب
  assert.deepEqual(d.topReps.map((r: Row) => [r.id, r.salesTotal, r.invoicesCount]), [
    ['r5', 512000, 2], ['r6', 80000, 2], ['r7', 60000, 1], ['r8', 55000, 1], ['r9', 40000, 1],
  ]);
  assert.deepEqual(Object.keys(d.topReps[0]).sort(), ['id', 'invoicesCount', 'name', 'salesTotal']);
  // إجمالي الشركة يبقى إجمالياً والمرتجع سطرٌ مستقل (services/netSales.ts)
  assert.equal(d.returnsTotal, 50000);
  assert.equal(d.salesTotal, 5000 + 20000 + 100000 + 8000 + 12000 + 500000 + 80000 + 60000 + 55000 + 90000 + 7000);
  const g = calls.find(([op]) => op === 'invoice.groupBy')![1];
  assert.deepEqual(g.by, ['salesRepId', 'type']);
  assert.equal(g.where.invoiceDate, undefined, 'لا حدّ شهر في لوحة المالك');
  const q = calls.find(([op]) => op === 'salesRep.findMany')![1];
  assert.equal(q.take, undefined);
  assert.deepEqual(q.where, { tenantId: 'T1', isActive: true });
});
