// إصلاحات «ربط الدفاتر» L1 (fixb) — عهدة المندوب وحذفه، بالمعالجات الحقيقية فوق Prisma مزيّف في الذاكرة (نمط b2b-sales-capture):
//   #4 الشراء أو سند الصرف «من عهدة مندوب» (REP_CUSTODY) يُنقص عهدته التشغيلية: GET /sales-reps/:id/collection (الويب و/m والاستلام)
//      وGET /receipts/collection-balance (تطبيق المندوب) — صافي سندات الصرف السارية من عهدته ناقص ما ردّه المورّدون إلى عهدته، بلا
//      فريق (العرض الإجمالي ودلو «بلا فريق» وحدهما)، والردّ لمن لا سندات له كما كان.
//   #7 (C18) حذف المندوب يقفل صفّه FOR UPDATE لكل شركة قبل أي تفريغ (لا حين تُفعَّل الدفاتر وحدها) — فسندٌ يُدرَج أثناء الحذف ينتظره.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const T = 'T1';

// ═══ Prisma مزيّف بنصّ مبرمَج لكل عملية ═══

let calls: { op: string; args?: Row }[] = [];
let scripted: Record<string, (a: Row) => unknown> = {};
function defaultFor(method: string): unknown {
  if (method === 'count') return 0;
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'aggregate') return { _sum: {} };
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}
const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (a: Row) => {
    calls.push({ op: `${model}.${method}`, args: a });
    const fn = scripted[`${model}.${method}`];
    return fn ? fn(a ?? {}) : defaultFor(method);
  },
});
const db: Row = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (fn: unknown) => {
        calls.push({ op: '$transaction' });
        return typeof fn === 'function' ? (fn as (tx: unknown) => Promise<unknown>)(db) : Promise.all(fn as Promise<unknown>[]);
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (s: TemplateStringsArray) => { calls.push({ op: `${key} ${Array.from(s).join('?').replace(/\s+/g, ' ').trim()}` }); return key === '$queryRaw' ? [] : 1; };
    }
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const salesReps = (require('../routes/salesReps') as typeof import('../routes/salesReps')).default;
const receipts = (require('../routes/receipts') as typeof import('../routes/receipts')).default;
// بعد المزيّف: هذه الوحدات تستورد config/database (import يُرفع فوق الكود)
const {
  custodyIncludesTeamless, custodyRepOf, maskPaidAccountRef, repCustodyPaymentsWhere, repCustodyRefundsWhere, repCustodySupplierNetMilli,
} = require('../services/suppliers/repCustody') as typeof import('../services/suppliers/repCustody');
const { composeTeamCustodyWhere } = require('../services/adminScope') as typeof import('../services/adminScope');
/* eslint-enable @typescript-eslint/no-var-requires */

/** معالج المسار نفسه (آخر طبقاته) بلا حرّاس الموجّه — كـb2b-sales-capture */
async function invoke(router: unknown, method: string, routePath: string, req: Row): Promise<{ status: number; body: Row | null }> {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === routePath && l.route.methods?.[method]);
  assert.ok(layer, `${method} ${routePath} مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = JSON.parse(JSON.stringify(b)); return res; };
  let err: unknown;
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  await handle({ query: {}, body: {}, headers: {}, params: {}, ...req }, res, (e?: unknown) => { err = e; });
  if (err) throw err;
  return { status: res.statusCode, body: res.body };
}

const ADMIN = { id: 'ADM', role: 'ADMIN', name: 'المدير', tenantId: T };
const SUPERVISOR = { id: 'SUP', role: 'ADMIN', name: 'مشرف', tenantId: T };
const REP = { id: 'R1', role: 'SALES_REP', name: 'سالم', tenantId: T };

/** المندوب R1: سندات 1000، واستلام 100، وسندات صرفٍ من عهدته 300 ردّ المورّد منها 50 إلى عهدته ⇒ صافي المصروف 250 */
function world(o: { paid?: bigint | null; refunded?: bigint | null } = {}): void {
  calls = [];
  scripted = {
    'admin.findUnique': (a) => (a.where.id === 'SUP' ? { scopeEnabled: true, scopeMode: 'TEAMS' } : { scopeEnabled: false, scopeMode: null }),
    'salesRep.findFirst': (a) => (a.where.id === 'R1' ? {
      id: 'R1', name: 'سالم', showCollectionBalance: true, tenant: { settings: { teamsEnabled: false } }, teamMemberships: [],
    } : null),
    'receipt.aggregate': () => ({ _sum: { amount: 1000 } }),
    'invoice.aggregate': () => ({ _sum: { paidAmt: 0 } }),
    'repSettlement.aggregate': () => ({ _sum: { amount: 100 } }),
    'supplierPayment.aggregate': () => ({ _sum: { amountMilli: o.paid === undefined ? 300_000n : o.paid } }),
    'supplierLedgerEntry.aggregate': () => ({ _sum: { amountMilli: o.refunded === undefined ? 50_000n : o.refunded } }),
  };
}

// ═══ الدوال الصرفة ═══

test('#4 صافي المصروف من العهدة: سندات REP_CUSTODY السارية لمندوبه − ما ردّه المورّدون إلى عهدته (REFUND_IN على مرتجعٍ مستلمُه عهدته)', async () => {
  const seen: Row[] = [];
  const fake = {
    supplierPayment: { aggregate: async (a: Row) => { seen.push(a); return { _sum: { amountMilli: 300_000n } }; } },
    supplierLedgerEntry: { aggregate: async (a: Row) => { seen.push(a); return { _sum: { amountMilli: 50_000n } }; } },
  };
  assert.equal(await repCustodySupplierNetMilli(fake as never, T, 'R1'), 250_000n);
  assert.deepEqual(seen[0], { where: { tenantId: T, salesRepId: 'R1', method: 'REP_CUSTODY', status: 'POSTED' }, _sum: { amountMilli: true } });
  assert.deepEqual(seen[1], {
    where: { tenantId: T, kind: 'REFUND_IN', warehouseEntry: { is: { tenantId: T, paidAccountRef: 'REP_CUSTODY:R1' } } }, _sum: { amountMilli: true },
  });
  assert.deepEqual(repCustodyPaymentsWhere(T, 'R9'), { tenantId: T, salesRepId: 'R9', method: 'REP_CUSTODY', status: 'POSTED' });
  assert.equal((repCustodyRefundsWhere(T, 'R9').warehouseEntry as Row).is.paidAccountRef, 'REP_CUSTODY:R9');
  // بلا سندات: صفر
  const none = { supplierPayment: { aggregate: async () => ({ _sum: { amountMilli: null } }) }, supplierLedgerEntry: { aggregate: async () => ({ _sum: { amountMilli: null } }) } };
  assert.equal(await repCustodySupplierNetMilli(none as never, T, 'R1'), 0n);
});

test('#4 بلا فريق: يشمل العرض الإجمالي ودلو «بلا فريق» — لا فريقاً بعينه ولا عرض مشرف الفرق', () => {
  assert.equal(custodyIncludesTeamless(composeTeamCustodyWhere(null)), true);
  assert.equal(custodyIncludesTeamless(composeTeamCustodyWhere(null, 'none')), true);
  assert.equal(custodyIncludesTeamless(composeTeamCustodyWhere(null, 'T1')), false);
  assert.equal(custodyIncludesTeamless(composeTeamCustodyWhere('SUP')), false);
  assert.equal(custodyIncludesTeamless(composeTeamCustodyWhere('SUP', 'T1')), false);
});

test('#6 «مصدر الدفع» بعهدة مندوبٍ محجوب: REP_CUSTODY بلا معرّفه، وغيره كما هو', () => {
  const hidden = new Set(['R2']);
  assert.equal(maskPaidAccountRef('REP_CUSTODY:R2', hidden), 'REP_CUSTODY');
  assert.equal(maskPaidAccountRef('REP_CUSTODY:R1', hidden), 'REP_CUSTODY:R1');
  assert.equal(maskPaidAccountRef('MAIN_CASH', hidden), 'MAIN_CASH');
  assert.equal(maskPaidAccountRef(null, hidden), null);
  assert.deepEqual([custodyRepOf('REP_CUSTODY:R7'), custodyRepOf('BANK'), custodyRepOf(undefined)], ['R7', null, null]);
});

// ═══ #4 عهدة المندوب في الشاشات ═══

test('#4 GET /sales-reps/:id/collection: سند الصرف من العهدة يُنقصها (1000 − 100 − 250 = 650) بتفصيل paidToSuppliers', async () => {
  world();
  const r = await invoke(salesReps, 'get', '/:id/collection', { params: { id: 'R1' }, user: ADMIN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(
    [r.body!.data.collected, r.body!.data.settled, r.body!.data.paidToSuppliers, r.body!.data.outstanding],
    [1000, 100, 250, 650],
  );
  // كان 900: يسلّم المندوب 650 فيبقى عليه 250 «عجزاً» دائماً
});

test('#4 بقيد الفريق: فريقٌ بعينه لا يُطرح منه (السند بلا فريق) وإجماليه يُطرح، ودلو «بلا فريق» يُطرح منه', async () => {
  world();
  const team = await invoke(salesReps, 'get', '/:id/collection', { params: { id: 'R1' }, user: ADMIN, query: { teamId: 'T1' } });
  assert.equal(team.status, 200, JSON.stringify(team.body));
  assert.equal(team.body!.data.outstanding, 900);
  assert.ok(!('paidToSuppliers' in team.body!.data));
  assert.equal(team.body!.data.totalOutstanding, 650, 'سقف التعبئة الإجمالي يُطرح منه');
  world();
  const none = await invoke(salesReps, 'get', '/:id/collection', { params: { id: 'R1' }, user: ADMIN, query: { teamId: 'none' } });
  assert.deepEqual([none.body!.data.outstanding, none.body!.data.paidToSuppliers], [650, 250]);
});

test('#4 مندوبٌ بلا سندات صرف من عهدته: الردّ كما كان حرفياً (لا paidToSuppliers والرصيد 900)', async () => {
  world({ paid: null, refunded: null });
  const r = await invoke(salesReps, 'get', '/:id/collection', { params: { id: 'R1' }, user: ADMIN });
  assert.deepEqual(r.body!.data, { collected: 1000, cashSales: 0, settled: 100, outstanding: 900, teams: [], teamScoped: false, teamsEnabled: false });
});

test('#4 POST /sales-reps/:id/settlements يردّ الرصيد بعد الطرح — فاستلام 650 يُصفّر العهدة', async () => {
  world();
  scripted['repSettlement.aggregate'] = () => ({ _sum: { amount: 750 } });
  const r = await invoke(salesReps, 'post', '/:id/settlements', { params: { id: 'R1' }, user: ADMIN, body: { amount: 650 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body!.data.outstanding, 0);
});

test('#4 GET /receipts/collection-balance (تطبيق المندوب): الرصيد بعد الطرح؛ ومشرف الفرق لا يُطرح له (عهدة فرقه وحدها، والسند بلا فريق)', async () => {
  world();
  const rep = await invoke(receipts, 'get', '/collection-balance', { user: REP });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.deepEqual([rep.body!.data.enabled, rep.body!.data.outstanding, rep.body!.data.paidToSuppliers], [true, 650, 250]);
  world();
  const sup = await invoke(receipts, 'get', '/collection-balance', { user: SUPERVISOR, query: { salesRepId: 'R1' } });
  assert.equal(sup.status, 200, JSON.stringify(sup.body));
  assert.equal(sup.body!.data.outstanding, 900);
  assert.ok(!calls.some((c) => c.op === 'supplierPayment.aggregate'), 'لا استعلام لسندات الصرف للمشرف');
  world();
  const admin = await invoke(receipts, 'get', '/collection-balance', { user: ADMIN, query: { salesRepId: 'R1' } });
  assert.equal(admin.body!.data.outstanding, 650);
});

// ═══ #7 (C18) قفل المندوب قبل أي تفريغ في حذفه ═══

/** فهرس قفل صفّ المندوب في الاستدعاءات (أو −1) */
const repLockIdx = (ops: string[], from = 0): number =>
  ops.findIndex((o, k) => k >= from && o.startsWith('$queryRaw') && /FROM sales_reps WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(o));

test('#7 حذف المندوب في شركةٍ بلا دفاتر مفعّلة: قفل صفّ المندوب FOR UPDATE داخل المعاملة بعد الحارس وقبل تفريغ السندات والحذف', async () => {
  world();
  const r = await invoke(salesReps, 'delete', '/:id', { params: { id: 'R1' }, user: ADMIN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ops = calls.map((c) => c.op);
  const lock = repLockIdx(ops);
  // كان: الحارس يخرج مبكراً قبل قفله (لا دفاتر) فلا قفل أبداً — سندٌ يُدرَج في الأثناء يفرّغه SetNull بلا deletedSalesRepId
  assert.ok(lock >= 0, `لا قفل للمندوب: ${ops.join(' → ')}`);
  assert.ok(ops.indexOf('$transaction') < ops.indexOf('glSettings.findUnique') && ops.indexOf('glSettings.findUnique') < lock, 'الحارس أولاً ثم القفل');
  for (const later of ['invoice.updateMany', 'receipt.updateMany', 'vanLoad.updateMany', 'repSettlement.updateMany', 'salesRep.delete']) {
    assert.ok(lock < ops.indexOf(later), `${later} قبل القفل`);
  }
});

test('#7 والشركة المفعّلة بلا أثر: الحارس يقفل قبل عدّه كما كان، والمسار يقفل قبل التفريغ أيضاً — والمربوطة ذات الأثر 409 بلا تفريغ', async () => {
  world();
  scripted['glSettings.findUnique'] = () => ({ activatedAt: new Date('2026-01-01T00:00:00Z'), setupMethod: 'CLEAN' });
  const r = await invoke(salesReps, 'delete', '/:id', { params: { id: 'R1' }, user: ADMIN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ops = calls.map((c) => c.op);
  const first = repLockIdx(ops);
  const second = repLockIdx(ops, first + 1);
  assert.ok(first >= 0 && first < ops.indexOf('glMoveLine.count'), 'قفل الحارس قبل العدّ');
  assert.ok(second > ops.indexOf('glMoveLine.count') && second < ops.indexOf('invoice.updateMany'), 'قفل المسار قبل التفريغ');
  world();
  scripted['glSettings.findUnique'] = () => ({ activatedAt: new Date('2026-01-01T00:00:00Z'), setupMethod: 'LINKED' });
  scripted['receipt.count'] = () => 2;
  const locked = await invoke(salesReps, 'delete', '/:id', { params: { id: 'R1' }, user: ADMIN });
  assert.equal(locked.status, 409);
  assert.ok(!calls.some((c) => c.op === 'receipt.updateMany' || c.op === 'salesRep.delete'));
});
