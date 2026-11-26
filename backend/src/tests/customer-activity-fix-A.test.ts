// «سجلّ العميل» — جولة الإصلاح (المُصلِح A: القراءة والعقد المشترك). لكل إصلاحٍ اختبارٌ يثبته:
//   C1  الزيارات الحيّة والمشتقّة وقفةٌ واحدة (المؤقّت رأسها ومعه visitIds/parts/photosCount)، بلا تكرارٍ ولا ضياعٍ عبر الصفحات.
//   C3  المال بصلاحيته (المندوب بكشف الحساب، المستخدم بالفواتير/السندات، النظام المحاسبي المطفأ)، ونطاق المستندات للمقيَّد،
//       وإحداثيات زيارة مندوبٍ آخر لا تصل المندوب.
//   C4  طلب المنيو على عميلٍ واحدٍ أبداً: سطره الأول نهائيّ، وإلا المطابق الوحيد.
//   C6  البطاقة: COMPLETED وحده ميلاد، والمعكوسة بعد الموافقة تبقى تحصيلاً، والمراجعة HELD.
//   C11 بدء السجلّ على مستوى الشركة، وتوأم الرابط الملغى بعده لا يُشتقّ، وسبب المرتجع وعودته للمخزون بأسماء السجلّ الحيّ.
//   C21 أسطر الدفعة بلحظاتٍ متزايدة بترتيب إدراجها، والقراءة at ثم id تنازلياً.
//   C24 المالك وموظفه والمفتاح الذي أصدره الدعم «الدعم الفني» لا باسمٍ ولا وسم.
//   C2  تغيّر «رمز العميل» (code) يُسجَّل؛ ومبلغٌ خارج مدى العمود لا يُفشل الإجراء.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_CATEGORY, CREATION_ACTIONS, CUSTOMER_ACTIONS, PLATFORM_SUPPORT_NAME, activityRow, actorFromReq, categoryOfAction, customerDiff,
  recordCustomerActivity, type ActivityInput,
} from '../services/customerActivity';
import {
  VISIT_CONTEXT_MS, loadCustomerActivity, parseActivityQuery, tenantLogStart, type ActivityDeps, type ActivityOut, type RecordScope,
} from '../routes/customerActivity';
import type { AuthRequest } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const D = (s: string) => new Date(s);
const T = 't1';

// ═══ قاعدةٌ في الذاكرة (كاختبارات القراءة القائمة) ═══

const isPlain = (v: unknown): v is Row => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
const val = (v: unknown) => (v instanceof Date ? v.getTime() : v);
const same = (a: unknown, b: unknown) => (a == null && b == null) || val(a) === val(b);
const less = (a: unknown, b: unknown) => a != null && b != null && (val(a) as number) < (val(b) as number);
function matchOps(v: unknown, ops: Row): boolean {
  for (const [op, x] of Object.entries(ops)) {
    if (op === 'in') { if (!(x as unknown[]).some((y) => same(v, y))) return false; }
    else if (op === 'not') { if (x === null ? v == null : (v == null || same(v, x))) return false; }
    else if (op === 'lt') { if (!less(v, x)) return false; }
    else if (op === 'lte') { if (!(less(v, x) || (v != null && same(v, x)))) return false; }
    else if (op === 'gt') { if (!less(x, v)) return false; }
    else if (op === 'gte') { if (!(less(x, v) || (v != null && same(v, x)))) return false; }
    else throw new Error(`unsupported op ${op}`);
  }
  return true;
}
function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, w] of Object.entries(where)) {
    if (k === 'AND') { if (!(w as Row[]).every((x) => matchWhere(row, x))) return false; continue; }
    if (k === 'OR') { if (!(w as Row[]).some((x) => matchWhere(row, x))) return false; continue; }
    if (isPlain(w)) { if (!matchOps(row[k], w)) return false; continue; }
    if (!same(row[k], w)) return false;
  }
  return true;
}
function sortRows(rows: Row[], orderBy: Row[] | Row | undefined): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => Object.entries(o)[0] as [string, string]);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = val(a[k]) as number | string; const y = val(b[k]) as number | string;
      if (x === y) continue;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
function memDb(tables: Record<string, Row[]>) {
  const queries: { model: string; args: Row }[] = [];
  const db = new Proxy({}, {
    get(_t, model: string) {
      const rows = () => tables[model] ?? [];
      return {
        findMany: async (args: Row = {}) => {
          queries.push({ model, args });
          const hit = sortRows(rows().filter((r) => matchWhere(r, args.where)), args.orderBy);
          return args.take ? hit.slice(0, args.take) : hit;
        },
        findFirst: async (args: Row = {}) => { queries.push({ model, args }); return rows().find((r) => matchWhere(r, args.where)) ?? null; },
      };
    },
  });
  return { db: db as ActivityDeps['db'], queries };
}

const noScope: ActivityDeps['customerScope'] = async () => ({});
const rep = (id = 'r1') => ({ user: { id, role: 'SALES_REP', name: 'أحمد', tenantId: T } } as unknown as AuthRequest);
const admin = (extra: Row = {}) => ({ user: { id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T, ...extra } } as unknown as AuthRequest);
const owner = () => admin({ impersonated: true, by: 'o1', byKind: 'OWNER' });
const CUST = { id: 'c1', tenantId: T, name: 'محل النور', phone: '0501234567', number: 7, status: 'ACTIVE', createdAt: D('2024-01-01T08:00:00Z') };

const log = (id: string, at: string, action: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', at: D(at), action, actorKind: 'ADMIN', actorId: 'a1', actorName: 'سارة', refType: null, refId: null,
  refNo: null, amount: null, data: null, ...extra,
});
const visit = (id: string, createdAt: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', salesRepId: 'r1', salesRep: { name: 'أحمد' }, note: null, durationSec: null, startedAt: null, endedAt: null,
  lat: null, lng: null, photos: [], createdAt: D(createdAt), ...extra,
});
/** سطر VISIT_RECORDED كما يكتبه routes/visits.ts (بعد التنظيف: التواريخ نصوص) */
const visitLog = (id: string, visitId: string, at: string, data: Row = {}, extra: Row = {}) => log(id, at, 'VISIT_RECORDED', {
  actorKind: 'REP', actorId: 'r1', actorName: 'أحمد', refType: 'VISIT', refId: visitId,
  data: { salesRepId: 'r1', repName: 'أحمد', photosCount: 0, ...data }, ...extra,
});
const inv = (id: string, at: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', number: `INV-${id}`, type: 'CREDIT', status: 'CONFIRMED', documentKind: null, invoiceDate: D(at),
  total: 100, taxAmt: 15, paidAmt: 40, remainingAmt: 60, salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { items: 2 }, ...extra,
});
const rcpt = (id: string, at: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', number: `RC-${id}`, amount: 50, paymentMethod: 'CASH', status: 'ACTIVE', receiptDate: D(at),
  notes: null, clientRef: null, salesRepId: 'r1', deletedSalesRepId: null, salesRep: { name: 'أحمد' }, _count: { photos: 0 }, invoiceItems: [], ...extra,
});

async function page(deps: ActivityDeps, req: AuthRequest, q: Row = {}, id = 'c1') {
  return (await loadCustomerActivity(deps, req, T, id, parseActivityQuery(q)))!;
}
async function allPages(deps: ActivityDeps, req: AuthRequest, limit: number, category?: string): Promise<ActivityOut[]> {
  const out: ActivityOut[] = [];
  let before: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const p = await page(deps, req, { limit, before, category });
    out.push(...p.items);
    if (!p.nextBefore) return out;
    assert.notEqual(p.nextBefore, before, 'المؤشّر يتقدّم');
    before = p.nextBefore;
  }
  throw new Error('لا نهاية للصفحات');
}
const visitItems = (items: ActivityOut[]) => items.filter((i) => i.action === 'VISIT_RECORDED');
const visitIdsOf = (items: ActivityOut[]) => visitItems(items).flatMap((i) => (i.data?.visitIds as string[] | undefined) ?? [i.refId as string]);

// ═══ C1 — الوقفات ═══

test('C1: المؤقّت الحيّ وملاحظته الحيّة وقفةٌ واحدة مرجعها المؤقّت — ومعها visitIds/parts وعدد الصور مجموعاً', async () => {
  const { db } = memDb({
    customer: [CUST],
    repVisit: [
      visit('v-t', '2026-11-27T10:30:00Z', { startedAt: D('2026-11-27T10:00:00Z'), endedAt: D('2026-11-27T10:30:00Z'), durationSec: 1800, lat: 24.7, lng: 46.7 }),
      visit('v-n', '2026-11-27T10:31:00Z', { note: 'الرف ممتلئ', photos: [{ id: 'p1' }, { id: 'p2' }] }),
    ],
    customerActivity: [
      visitLog('L-t', 'v-t', '2026-11-27T10:30:00Z', { durationSec: 1800, startedAt: '2026-11-27T10:00:00.000Z', endedAt: '2026-11-27T10:30:00.000Z', hasLocation: true }),
      visitLog('L-n', 'v-n', '2026-11-27T10:31:00Z', { note: 'الرف ممتلئ', photosCount: 2 }),
    ],
  });
  const p = await page({ db, customerScope: noScope }, admin());
  const v = visitItems(p.items);
  assert.equal(v.length, 1, JSON.stringify(v));
  assert.equal(v[0].id, 'L-t', 'معرّف البند سطر المؤقّت (الرأس)');
  assert.equal(v[0].refId, 'v-t');
  assert.equal(v[0].historical, false);
  assert.equal(v[0].at, '2026-11-27T10:31:00.000Z', 'موضع الوقفة أحدث سجلّاتها');
  assert.deepEqual(v[0].data!.visitIds, ['v-t', 'v-n']);
  assert.equal(v[0].data!.parts, 2);
  assert.equal(v[0].data!.photosCount, 2);
  assert.equal(v[0].data!.durationSec, 1800);
  assert.equal(v[0].data!.note, 'الرف ممتلئ');
  assert.equal(v[0].data!.hasLocation, true);
});

test('C1: ملاحظةٌ قبل بدء السجلّ (مشتقّة) ومؤقّتٌ بعده (حيّ) في وقفةٍ واحدة — حيّة لأن فيها سطراً حيّاً', async () => {
  const { db } = memDb({
    customer: [CUST],
    repVisit: [
      visit('v-n', '2026-11-27T09:58:00Z', { note: 'قبل', photos: [{ id: 'p9' }] }),
      visit('v-t', '2026-11-27T10:20:00Z', { startedAt: D('2026-11-27T10:00:00Z'), endedAt: D('2026-11-27T10:20:00Z'), durationSec: 1200 }),
    ],
    customerActivity: [visitLog('L-t', 'v-t', '2026-11-27T10:20:00Z', { durationSec: 1200, startedAt: '2026-11-27T10:00:00.000Z' })],
  });
  const v = visitItems((await page({ db, customerScope: noScope }, admin())).items);
  assert.equal(v.length, 1);
  assert.deepEqual([v[0].id, v[0].refId, v[0].historical], ['L-t', 'v-t', false]);
  assert.deepEqual(v[0].data!.visitIds, ['v-t', 'v-n']);
  assert.deepEqual(v[0].data!.photoIds, ['p9']);
  assert.equal(v[0].data!.photosCount, 1);
});

test('C1: الصفحات تقطع الوقفة الحيّة (بنودٌ بين سجلّاتها) — كل الصفحات = القائمة الكاملة، والوقفة مرّةً واحدة', async () => {
  const { db } = memDb({
    customer: [CUST],
    repVisit: [
      visit('v-t', '2026-11-27T10:30:00Z', { startedAt: D('2026-11-27T10:00:00Z'), durationSec: 1800 }),
      visit('v-n1', '2026-11-27T10:05:00Z', { note: 'أولى' }),
      visit('v-n2', '2026-11-27T10:33:00Z', { note: 'أخيرة' }),
    ],
    customerActivity: [
      visitLog('L-t', 'v-t', '2026-11-27T10:30:00Z', { durationSec: 1800, startedAt: '2026-11-27T10:00:00.000Z' }),
      visitLog('L-n1', 'v-n1', '2026-11-27T10:05:00Z', { note: 'أولى' }),
      visitLog('L-n2', 'v-n2', '2026-11-27T10:33:00Z', { note: 'أخيرة' }),
      log('L-a', '2026-11-27T10:31:00Z', 'CUSTOMER_UPDATED'),
      log('L-b', '2026-11-27T10:20:00Z', 'CUSTOMER_UPDATED'),
      log('L-c', '2026-11-27T10:01:00Z', 'CUSTOMER_UPDATED'),
    ],
    invoice: [inv('i1', '2026-11-27T10:10:00Z')],
  });
  const deps = { db, customerScope: noScope };
  const full = await page(deps, admin(), { limit: 300 });
  assert.equal(visitItems(full.items).length, 1);
  assert.deepEqual(visitIdsOf(full.items).sort(), ['v-n1', 'v-n2', 'v-t']);
  for (const limit of [1, 2, 3, 4]) {
    const got = await allPages(deps, admin(), limit);
    assert.deepEqual(got.map((x) => x.id), full.items.map((x) => x.id), `limit ${limit}`);
  }
  for (const limit of [1, 2]) {
    const got = await allPages(deps, admin(), limit, 'visits');
    assert.deepEqual(got.map((x) => x.id), (await page(deps, admin(), { limit: 300, category: 'visits' })).items.map((x) => x.id));
  }
});

/** مولّد ثابت البذرة */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('C1: زياراتٌ عشوائية حيّة ومشتقّة لمندوبَين بين بنودٍ أخرى — كل سجلّ زيارةٍ يظهر مرّةً واحدة، والصفحات = الكاملة (بذورٌ وحدودٌ متعدّدة)', async () => {
  for (const seed of [3, 11, 29, 101]) {
    const r = rng(seed);
    const base = Date.UTC(2026, 10, 20, 8);
    const visits: Row[] = [];
    const logs: Row[] = [];
    for (let i = 0; i < 24; i++) {
      const repId = r() < 0.5 ? 'r1' : 'r2';
      const t = base + Math.floor(r() * 8) * 60 * 60_000 + Math.floor(r() * 50) * 60_000;
      const timed = r() < 0.4;
      const id = `v${String(i).padStart(2, '0')}`;
      const createdAt = new Date(timed ? t + 20 * 60_000 : t).toISOString();
      visits.push(visit(id, createdAt, { salesRepId: repId, ...(timed ? { startedAt: new Date(t), durationSec: 1200 } : { note: `ملاحظة ${i}` }) }));
      // نصفها بعد بدء السجلّ: سطرٌ حيّ بمرجعها
      if (r() < 0.5) {
        logs.push(visitLog(`L${id}`, id, createdAt, { salesRepId: repId, ...(timed ? { durationSec: 1200, startedAt: new Date(t).toISOString() } : { note: `ملاحظة ${i}` }) }, { actorId: repId }));
      }
    }
    for (let i = 0; i < 10; i++) logs.push(log(`LX${i}`, new Date(base + Math.floor(r() * 9) * 60 * 60_000).toISOString(), 'CUSTOMER_UPDATED'));
    const { db } = memDb({ customer: [CUST], repVisit: visits, customerActivity: logs });
    const deps = { db, customerScope: noScope };
    const full = await page(deps, admin(), { limit: 300 });
    const ids = visitIdsOf(full.items);
    assert.equal(new Set(ids).size, ids.length, `seed ${seed}: سجلّ زيارةٍ في وقفتين`);
    assert.deepEqual([...ids].sort(), visits.map((v) => v.id).sort(), `seed ${seed}: كل سجلّ زيارةٍ ظاهر`);
    for (const limit of [1, 2, 3, 5, 8]) {
      const got = await allPages(deps, admin(), limit);
      assert.deepEqual(got.map((x) => x.id), full.items.map((x) => x.id), `seed ${seed} limit ${limit}`);
    }
  }
});

test('C1: هامش الوقفة يغطّي أقصى بُعدٍ بين سجلّاتها — مؤقّت أربع ساعات وملاحظةٌ عند بدايته وأخرى بعد نهايته', async () => {
  assert.ok(VISIT_CONTEXT_MS >= 3 * (4 * 3600_000 + 5 * 60_000));
  const { db } = memDb({
    customer: [CUST],
    repVisit: [
      visit('v-t', '2026-11-27T14:00:00Z', { startedAt: D('2026-11-27T10:00:00Z'), durationSec: 4 * 3600 }),
      visit('v-a', '2026-11-27T09:57:00Z', { note: 'عند البداية' }),
      visit('v-b', '2026-11-27T14:04:00Z', { note: 'بعد النهاية' }),
    ],
    customerActivity: Array.from({ length: 6 }, (_, i) => log(`L${i}`, `2026-11-27T1${i}:30:00Z`, 'CUSTOMER_UPDATED')),
  });
  const deps = { db, customerScope: noScope };
  const full = await page(deps, admin(), { limit: 300 });
  assert.equal(visitItems(full.items).length, 1);
  for (const limit of [1, 2, 3]) assert.deepEqual((await allPages(deps, admin(), limit)).map((x) => x.id), full.items.map((x) => x.id));
});

// ═══ C3 — الصلاحيات ═══

const moneyWorld = (extra: Record<string, Row[]> = {}) => memDb({
  customer: [CUST],
  invoice: [inv('i1', '2026-03-01T09:00:00Z', { salesRepId: 'r2', salesRep: { name: 'سالم' } })],
  receipt: [rcpt('rc1', '2026-04-01T09:00:00Z', { paymentMethod: 'CHEQUE', invoiceItems: [{ amount: 50, invoice: { number: 'INV-i1' } }] })],
  customerActivity: [
    log('L-rc', '2026-11-27T09:00:00Z', 'RECEIPT_ISSUED', {
      refType: 'RECEIPT', refId: 'rc-live', refNo: 'RC-9', amount: 700,
      data: { paymentMethod: 'CHEQUE', chequeNumber: '12345', bankName: 'الراجحي', note: 'دفعة', allocations: [{ invoiceId: 'i1', invoiceNo: 'INV-i1', amount: 700, settled: true }] },
    }),
    log('L-inv', '2026-11-27T08:00:00Z', 'INVOICE_ISSUED', { refType: 'INVOICE', refId: 'i-live', refNo: 'INV-9', amount: 5000, data: { paymentType: 'CREDIT', total: 5000, paidAmt: 0, remainingAmt: 5000, itemsCount: 3 } }),
    log('L-edit', '2026-11-27T07:00:00Z', 'CUSTOMER_UPDATED', { data: { changes: [{ field: 'city', from: 'أ', to: 'ب' }] } }),
  ],
  ...extra,
});
const MONEY_KEYS = ['total', 'paidAmt', 'remainingAmt', 'taxTotal', 'chequeNumber', 'bankName', 'note', 'paymentPlan'];
function assertNoMoney(items: ActivityOut[], ids: string[]) {
  for (const id of ids) {
    const x = items.find((i) => i.id === id)!;
    assert.ok(x, id);
    assert.equal(x.amount, null, `${id} amount`);
    for (const k of MONEY_KEYS) assert.equal(x.data?.[k], undefined, `${id}.${k}`);
    for (const a of (x.data?.allocations as Row[] | undefined) ?? []) assert.equal(a.amount, undefined, `${id} allocation amount`);
  }
}

test('C3: المندوب بلا «عرض كشف الحساب» يرى البنود المالية بلا مبالغ ولا تفاصيل دفع — وبها يراها كاملة', async () => {
  const { db } = moneyWorld({ salesRep: [{ id: 'r1', tenantId: T, canViewStatement: false }] });
  const p = await page({ db, customerScope: noScope }, rep('r1'));
  assertNoMoney(p.items, ['L-rc', 'L-inv', 'h:invoice:i1', 'h:receipt:rc1']);
  const liveRc = p.items.find((i) => i.id === 'L-rc')!;
  assert.deepEqual(liveRc.data!.allocations, [{ invoiceNo: 'INV-i1', settled: true }], 'أرقام الفواتير بلا مبالغها');
  assert.equal(liveRc.refNo, 'RC-9', 'من فعل ماذا يبقى');
  assert.deepEqual(p.items.find((i) => i.id === 'L-edit')!.data, { changes: [{ field: 'city', from: 'أ', to: 'ب' }] }, 'غير المالي كما هو');
  const { db: db2 } = moneyWorld({ salesRep: [{ id: 'r1', tenantId: T, canViewStatement: true }] });
  const q = await page({ db: db2, customerScope: noScope }, rep('r1'));
  assert.equal(q.items.find((i) => i.id === 'L-inv')!.amount, 5000);
  assert.equal(q.items.find((i) => i.id === 'L-rc')!.data!.chequeNumber, '12345');
  // ولا صفّ للمندوب ⇒ لا مال (كمسار كشف الحساب)
  const { db: db3 } = moneyWorld();
  assertNoMoney((await page({ db: db3, customerScope: noScope }, rep('r1'))).items, ['L-inv']);
});

test('C3: مستخدم الشركة بلا «سندات القبض» لا يرى مال التحصيل، وبلا «الفواتير» لا يرى مال المبيعات — كلٌّ وحده', async () => {
  const { db } = moneyWorld({ admin: [{ id: 'a1', tenantId: T, name: 'سارة', canManageInvoices: true, canManageReceipts: false }] });
  const p = await page({ db, customerScope: noScope }, admin());
  assertNoMoney(p.items, ['L-rc', 'h:receipt:rc1']);
  assert.equal(p.items.find((i) => i.id === 'L-inv')!.amount, 5000);
  assert.equal(p.items.find((i) => i.id === 'h:invoice:i1')!.data!.total, 100);
  const { db: db2 } = moneyWorld({ admin: [{ id: 'a1', tenantId: T, name: 'سارة', canManageInvoices: false, canManageReceipts: true }] });
  const q = await page({ db: db2, customerScope: noScope }, admin());
  assertNoMoney(q.items, ['L-inv', 'h:invoice:i1']);
  assert.equal(q.items.find((i) => i.id === 'L-rc')!.amount, 700);
});

test('C3: النظام المحاسبي المطفأ ⇒ لا مبالغ لأحد في الردّ (ولا تقدير طلب المنيو ولا سعر الصنف) — ولو جلسة المالك', async () => {
  const { db } = moneyWorld({
    customer: [{ ...CUST, tenant: { accountingEnabled: false } }],
    customerActivity: [
      log('L-inv', '2026-11-27T08:00:00Z', 'INVOICE_ISSUED', { refType: 'INVOICE', refId: 'i-live', amount: 5000, data: { total: 5000 } }),
      log('L-ord', '2026-11-27T07:30:00Z', 'CATALOG_ORDER_PLACED', { refType: 'CATALOG_ORDER', refId: 'o1', amount: 80, data: { estimate: 80, itemsCount: 2 } }),
      log('L-pr', '2026-11-27T07:00:00Z', 'CUSTOMER_PRICE_SET', { refType: 'PRICE', refId: 'p1', amount: 3, data: { count: 1, items: [{ productId: 'p1', from: 2, to: 3 }] } }),
    ],
  });
  for (const viewer of [owner(), admin()]) {
    const p = await page({ db, customerScope: noScope }, viewer);
    for (const x of p.items) assert.equal(x.amount, null, `${x.id} amount`);
    assert.equal(p.items.find((i) => i.id === 'L-inv')!.data, null);
    assert.deepEqual(p.items.find((i) => i.id === 'L-ord')!.data, { itemsCount: 2 });
    assert.deepEqual(p.items.find((i) => i.id === 'L-pr')!.data, { count: 1, items: [{ productId: 'p1' }] });
  }
});

test('C3: نطاق المستندات للمستخدم المقيَّد — المشتقّ بقيده، وسطر السجلّ بمرجعٍ خارج نطاقه (أو محذوف) لا يظهر، ومشرف الفرق بلا قيود التسوية', async () => {
  const scope: RecordScope = { invoice: { salesRepId: 'r1' }, receipt: { salesRepId: 'r1' }, visit: { salesRepId: 'r1' }, paylink: { salesRepId: 'r1' }, card: { salesRepId: 'r1' }, ledger: false };
  const { db } = memDb({
    customer: [CUST],
    invoice: [inv('i-mine', '2026-03-01T09:00:00Z'), inv('i-other', '2026-03-02T09:00:00Z', { salesRepId: 'r2' }), inv('i-live-mine', '2026-11-27T08:00:00Z'), inv('i-live-other', '2026-11-27T08:30:00Z', { salesRepId: 'r2' })],
    repVisit: [visit('v-mine', '2026-05-01T09:00:00Z', { note: 'لي' }), visit('v-other', '2026-05-02T09:00:00Z', { salesRepId: 'r2', note: 'لغيري' })],
    accountEntry: [{ id: 'e1', tenantId: T, customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 5, credit: 0, description: 'قيد', entryDate: D('2026-01-01'), createdAt: D('2026-01-01T00:00:00Z'), invoiceId: null, receiptId: null }],
    customerActivity: [
      log('L-mine', '2026-11-27T08:00:00Z', 'INVOICE_ISSUED', { refType: 'INVOICE', refId: 'i-live-mine' }),
      log('L-other', '2026-11-27T08:30:00Z', 'INVOICE_ISSUED', { refType: 'INVOICE', refId: 'i-live-other' }),
      log('L-gone', '2026-11-27T09:00:00Z', 'INVOICE_CANCELLED', { refType: 'INVOICE', refId: 'i-deleted' }),
      log('L-agg', '2026-11-27T09:30:00Z', 'VISIT_DELETED', { refType: 'VISIT', refId: null, data: { count: 3 } }),
      log('L-adj', '2026-11-27T10:00:00Z', 'ADJUSTMENT_CREATED', { refType: 'ADJUSTMENT', refId: 'x1' }),
      log('L-edit', '2026-11-27T11:00:00Z', 'CUSTOMER_UPDATED'),
    ],
  });
  const p = await page({ db, customerScope: noScope, recordScope: async () => scope }, admin());
  const ids = p.items.map((i) => i.id);
  for (const ok of ['L-mine', 'h:invoice:i-mine', 'h:visit:v-mine', 'L-edit', 'h:created:c1']) assert.ok(ids.includes(ok), ok);
  for (const bad of ['L-other', 'h:invoice:i-other', 'h:visit:v-other', 'L-gone', 'L-agg', 'L-adj', 'h:adj:e1']) assert.ok(!ids.includes(bad), bad);
  // وبلا قيد: الكلّ
  const all = (await page({ db, customerScope: noScope, recordScope: async () => null }, admin())).items.map((i) => i.id);
  for (const id of ['L-other', 'h:invoice:i-other', 'L-gone', 'L-adj', 'h:adj:e1']) assert.ok(all.includes(id), id);
});

test('C3: إحداثيات زيارة مندوبٍ آخر لا تصل المندوب — وزيارته هو بإحداثياتها، والإدارة تراها كلها', async () => {
  const { db } = memDb({
    customer: [CUST],
    repVisit: [
      visit('v-r1', '2026-05-01T09:00:00Z', { note: 'لي', lat: 24.1, lng: 46.1 }),
      visit('v-r2', '2026-05-02T09:00:00Z', { salesRepId: 'r2', salesRep: { name: 'سالم' }, note: 'لزميلي', lat: 24.2, lng: 46.2 }),
    ],
  });
  const p = await page({ db, customerScope: noScope }, rep('r1'));
  const by = (id: string) => p.items.find((i) => i.refId === id)!;
  assert.equal(by('v-r1').data!.lat, 24.1);
  assert.equal(by('v-r2').data!.lat, undefined);
  assert.equal(by('v-r2').data!.lng, undefined);
  assert.equal(by('v-r2').data!.note, 'لزميلي', 'عمل الزميل مع العميل ظاهر');
  const q = await page({ db, customerScope: noScope }, admin());
  assert.equal(q.items.find((i) => i.refId === 'v-r2')!.data!.lat, 24.2);
});

// ═══ C4 — طلبات المنيو ═══

const order = (id: string, at: string, extra: Row = {}) => ({
  id, tenantId: T, phoneKey: '966501234567', status: 'NEW', customerName: 'زبون', note: null, createdAt: D(at), invoiceId: null, salesRepId: 'r1',
  salesRep: { name: 'أحمد' }, _count: { items: 1 }, ...extra,
});

test('C4: طلب المنيو على عميلٍ واحد أبداً — سطره الأول نهائيّ، وإلا المطابق الوحيد بجواله؛ وعميلان بالجوال نفسه ⇒ لا نسبة', async () => {
  const A = { ...CUST, id: 'cA', createdAt: D('2025-06-01T00:00:00Z') };
  const B = { ...CUST, id: 'cB', createdAt: D('2025-01-01T00:00:00Z') };
  const tables = {
    customer: [A, B],
    catalogOrder: [order('o-live', '2026-11-27T09:00:00Z'), order('o-old-closed', '2026-03-01T09:00:00Z'), order('o-ambiguous', '2026-02-01T09:00:00Z')],
    customerActivity: [
      log('L-placed', '2026-11-27T09:00:00Z', 'CATALOG_ORDER_PLACED', { customerId: 'cA', refType: 'CATALOG_ORDER', refId: 'o-live' }),
      // طلبٌ قديم أُغلق بعد بدء السجلّ: سطر إغلاقه على B وحده ⇒ B عميله
      log('L-upd', '2026-11-27T10:00:00Z', 'CATALOG_ORDER_UPDATED', { customerId: 'cB', refType: 'CATALOG_ORDER', refId: 'o-old-closed' }),
    ],
  };
  const { db } = memDb(tables);
  const orderIds = async (id: string) => (await page({ db, customerScope: noScope }, admin(), { limit: 300 }, id)).items.filter((i) => i.refType === 'CATALOG_ORDER').map((i) => i.id);
  assert.deepEqual(await orderIds('cA'), ['L-placed'], 'A: سطره الحيّ وحده — والملتبس لا يُنسب');
  assert.deepEqual(await orderIds('cB'), ['L-upd', 'h:order:o-old-closed'], 'B: إغلاقه وطلبه المشتقّ — ولا طلب A');
  // عميلٌ وحيد بالجوال (والمحذوف لا يُعدّ) ⇒ طلبه القديم له
  const { db: db2 } = memDb({ customer: [A, { ...B, status: 'DELETED' }], catalogOrder: [order('o1', '2026-02-01T09:00:00Z')] });
  const one = await page({ db: db2, customerScope: noScope }, admin(), {}, 'cA');
  assert.deepEqual(one.items.filter((i) => i.refType === 'CATALOG_ORDER').map((i) => i.id), ['h:order:o1']);
  const del = await page({ db: db2, customerScope: noScope }, admin(), {}, 'cB');
  assert.deepEqual(del.items.filter((i) => i.refType === 'CATALOG_ORDER').map((i) => i.id), [], 'لا يظهر على عميلين');
  // مرشّحو الإنتاج (phoneCandidates) يُستعملون متى حُقنوا
  let asked = '';
  const viaDeps = await page({ db: db2, customerScope: noScope, phoneCandidates: async (tid, key) => { asked = `${tid}:${key}`; return [A, B]; } }, admin(), {}, 'cA');
  assert.equal(asked, `${T}:966501234567`);
  assert.deepEqual(viaDeps.items.filter((i) => i.refType === 'CATALOG_ORDER').map((i) => i.id), [], 'مرشّحان ⇒ لا نسبة');
});

// ═══ C6 — البطاقة ═══

const card = (id: string, status: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', amount: 90, status, statusDetail: null, createdAt: D('2026-06-01T09:00:00Z'), approvedAt: null, salesRepId: 'r1',
  createdById: null, cardScheme: 'MADA', salesRep: { name: 'أحمد' }, invoice: { number: 'INV-1' }, ...extra,
});

test('C6: الإجراءات الجديدة وأقسامها، وCARD_PAYMENT_FAILED ليس ميلاداً', () => {
  for (const a of ['CARD_PAYMENT_REVERSED', 'CARD_PAYMENT_HELD', 'PAYLINK_REFUNDED', 'RECEIPT_DELETED', 'LEDGER_JOURNAL_POSTED', 'LEDGER_JOURNAL_REVERSED']) {
    assert.ok((CUSTOMER_ACTIONS as readonly string[]).includes(a), a);
    assert.equal(categoryOfAction(a), 'money', a);
  }
  assert.equal(ACTION_CATEGORY.INVOICE_DELETED, 'sales');
  assert.equal(ACTION_CATEGORY.SMART_REP_OUTCOME, 'visits');
  assert.equal(CREATION_ACTIONS.has('CARD_PAYMENT_FAILED'), false);
  assert.equal(CREATION_ACTIONS.has('CARD_PAYMENT_COMPLETED'), true);
  for (const a of ['CARD_PAYMENT_REVERSED', 'CARD_PAYMENT_HELD', 'PAYLINK_REFUNDED', 'INVOICE_DELETED', 'RECEIPT_DELETED', 'SMART_REP_OUTCOME']) assert.equal(CREATION_ACTIONS.has(a), false, a);
});

test('C6: عمليةٌ وافقت قبل السجلّ وعُكست بعده يبقى تحصيلها المشتقّ مع سطر العكس — والمراجعة HELD، والفشل الحيّ لا يُسقط التحصيل', async () => {
  const { db } = memDb({
    customer: [CUST],
    cardPayment: [card('k-rev', 'reversed'), card('k-review', 'review', { createdAt: D('2026-06-02T09:00:00Z') }), card('k-ok', 'approved', { createdAt: D('2026-06-03T09:00:00Z') }), card('k-dec', 'declined', { createdAt: D('2026-06-04T09:00:00Z') })],
    customerActivity: [
      log('L-rev', '2026-11-27T09:00:00Z', 'CARD_PAYMENT_REVERSED', { refType: 'CARD_PAYMENT', refId: 'k-rev' }),
      log('L-fail', '2026-11-27T09:01:00Z', 'CARD_PAYMENT_FAILED', { refType: 'CARD_PAYMENT', refId: 'k-ok' }),
      log('L-dec', '2026-11-27T09:02:00Z', 'CARD_PAYMENT_FAILED', { refType: 'CARD_PAYMENT', refId: 'k-dec' }),
    ],
  });
  const p = await page({ db, customerScope: noScope }, admin());
  const cards = p.items.filter((i) => i.refType === 'CARD_PAYMENT').map((i) => `${i.id}:${i.action}`);
  assert.deepEqual(cards, [
    'L-dec:CARD_PAYMENT_FAILED', 'L-fail:CARD_PAYMENT_FAILED', 'L-rev:CARD_PAYMENT_REVERSED',
    'h:card:k-ok:CARD_PAYMENT_COMPLETED', 'h:card:k-review:CARD_PAYMENT_HELD', 'h:card:k-rev:CARD_PAYMENT_COMPLETED',
  ]);
  assert.equal(p.items.find((i) => i.id === 'h:card:k-rev')!.data!.status, 'reversed');
});

// ═══ C11 — بدء السجلّ وحدود الاشتقاق ═══

test('C11: بدء السجلّ على مستوى الشركة — محطّةٌ وسعرٌ أُعيد حفظهما بعده لعميلٍ بلا سطرٍ لا يُشتقّان، وما قبله يبقى', async () => {
  const stop = (id: string, at: string) => ({ id, tenantId: T, customerId: 'c1', routeId: `rt-${id}`, seq: 1, createdAt: D(at), route: { name: 'خط', isActive: true, isPermanent: true, routeDate: null, salesRep: { name: 'أحمد' } } });
  const price = (id: string, at: string) => ({ id, customerId: 'c1', productId: `p-${id}`, price: 3, updatedAt: D(at), product: { name: 'ماء' } });
  const { db, queries } = memDb({
    customer: [CUST, { ...CUST, id: 'c2' }],
    customerActivity: [{ ...log('L-c2', '2026-11-26T08:00:00Z', 'CUSTOMER_UPDATED'), customerId: 'c2' }],
    repRouteStop: [stop('old', '2025-05-01T00:00:00Z'), stop('resaved', '2026-11-27T08:00:00Z')],
    customerPrice: [price('old', '2025-05-02T00:00:00Z'), price('resaved', '2026-11-27T08:00:00Z')],
  });
  const p = await page({ db, customerScope: noScope }, admin());
  assert.deepEqual(p.items.filter((i) => i.refType === 'ROUTE').map((i) => i.refId), ['rt-old']);
  assert.deepEqual(p.items.filter((i) => i.refType === 'PRICE').map((i) => i.refId), ['p-old']);
  // بدء الشركة يُقرأ مرّةً ثم يُحفظ (فهرس السجلّ بلا at وحده)
  const n = queries.filter((q) => q.model === 'customerActivity' && q.args.take === 1 && !('customerId' in (q.args.where ?? {}))).length;
  await page({ db, customerScope: noScope }, admin());
  assert.equal(queries.filter((q) => q.model === 'customerActivity' && q.args.take === 1 && !('customerId' in (q.args.where ?? {}))).length, n);
  assert.equal((await tenantLogStart(db, T))!.toISOString(), '2026-11-26T08:00:00.000Z');
  assert.equal(await tenantLogStart(memDb({}).db, T), null);
});

test('C11: رابط الدفع الملغى المُنشأ بعد بدء السجلّ بلا سطر (توأم السباق/اليتيم) لا يُشتقّ — والملغى قبله يبقى بإصداره', async () => {
  const link = (id: string, at: string, status: string) => ({ id, tenantId: T, customerId: 'c1', amount: 40, status, createdAt: D(at), paidAt: null, expiresAt: null, salesRepId: 'r1', createdById: null, salesRep: { name: 'أحمد' }, invoice: { number: 'INV-9' } });
  const { db } = memDb({
    customer: [CUST],
    customerPaymentLink: [link('pl-twin', '2026-11-27T09:00:00Z', 'canceled'), link('pl-old', '2026-05-01T09:00:00Z', 'canceled'), link('pl-open', '2026-11-27T09:30:00Z', 'initiated')],
    customerActivity: [log('L1', '2026-11-26T08:00:00Z', 'CUSTOMER_UPDATED')],
  });
  const ids = (await page({ db, customerScope: noScope }, admin())).items.filter((i) => i.refType === 'PAYLINK').map((i) => i.id);
  assert.deepEqual(ids, ['h:paylink:pl-open', 'h:paylink:pl-old'], 'التوأم الملغى بلا سطر ليس إجراءً، وغير الملغى بلا سطر يبقى شبكة أمان');
});

test('C11: المرتجع المشتقّ بأسماء السجلّ الحيّ — رمز السبب في returnReason وعودته للمخزون، وسبب الإشعار نصّاً في reason', async () => {
  const { db } = memDb({
    customer: [CUST],
    invoice: [
      inv('r1', '2026-03-01T09:00:00Z', { type: 'RETURN', returnReason: 'DAMAGED', returnToStock: false, total: 20 }),
      inv('cn1', '2026-03-02T09:00:00Z', { type: 'RETURN', documentKind: 'CREDIT_NOTE', noteReason: 'خصم لاحق', returnReason: null, returnToStock: null }),
    ],
  });
  const p = await page({ db, customerScope: noScope }, admin());
  const r = p.items.find((i) => i.refId === 'r1')!;
  assert.equal(r.data!.returnReason, 'DAMAGED');
  assert.equal(r.data!.returnToStock, false);
  assert.equal(r.data!.reason, undefined);
  const cn = p.items.find((i) => i.refId === 'cn1')!;
  assert.equal(cn.data!.reason, 'خصم لاحق');
  assert.equal(cn.data!.returnReason, undefined);
});

test('C11/C8: ملاحظة سند البطاقة المشتقّ لا تُعرض، والملاحظة اليدوية بلا ما يشبه البطاقة', async () => {
  const { db } = memDb({
    customer: [CUST],
    receipt: [
      rcpt('pos', '2026-03-01T09:00:00Z', { paymentMethod: 'POS', clientRef: 'cardpay:k1', notes: 'تحصيل بالبطاقة VISA 411111******1111 — فاتورة INV-1 — RRN 123456789012' }),
      rcpt('cash', '2026-03-02T09:00:00Z', { notes: 'دفعة نقدية' }),
    ],
  });
  const p = await page({ db, customerScope: noScope }, admin());
  assert.equal(p.items.find((i) => i.refId === 'pos')!.data!.note, undefined);
  assert.equal(p.items.find((i) => i.refId === 'cash')!.data!.note, 'دفعة نقدية');
});

// ═══ C21 — الترتيب ═══

test('C21: أسطر الدفعة الواحدة بلحظاتٍ متزايدة بترتيب إدراجها (وما حمل لحظته لا يُمسّ)، والسطر الوحيد بلحظة القاعدة', async () => {
  const rows: Row[][] = [];
  const db = { customerActivity: { createMany: async (a: { data: Row[] }) => { rows.push(a.data); return { count: a.data.length }; } } };
  const base = { tenantId: T, customerId: 'c1', actor: { kind: 'SYSTEM' as const, id: null, name: null } };
  const fixed = D('2026-01-01T00:00:00Z');
  await recordCustomerActivity(db, [
    { ...base, action: 'PAYLINK_PAID' }, { ...base, action: 'RECEIPT_ISSUED', at: fixed }, { ...base, action: 'INVOICE_PAID' },
  ] as ActivityInput[]);
  const [paid, rc, invPaid] = rows[0];
  assert.ok(paid.at instanceof Date && invPaid.at instanceof Date);
  assert.ok((invPaid.at as Date).getTime() > (paid.at as Date).getTime(), 'الأحدث إدراجاً أحدث لحظةً');
  assert.equal(rc.at, fixed);
  await recordCustomerActivity(db, { ...base, action: 'OTHER' } as ActivityInput);
  assert.equal('at' in rows[1][0], false);
});

test('C21: أسطر اللحظة الواحدة تُقرأ at ثم id تنازلياً في كل صفحة', async () => {
  const at = '2026-11-27T10:00:00.000Z';
  const { db } = memDb({ customer: [CUST], customerActivity: ['b', 'd', 'a', 'c'].map((id) => log(id, at, 'CUSTOMER_UPDATED')) });
  const deps = { db, customerScope: noScope };
  const full = (await page(deps, admin())).items.filter((i) => i.at === at).map((i) => i.id);
  assert.deepEqual(full, ['d', 'c', 'b', 'a']);
  assert.deepEqual((await allPages(deps, admin(), 1)).filter((i) => i.at === at).map((i) => i.id), full);
});

// ═══ C24 — الدعم الفني ═══

test('C24: وثيقةٌ رفعتها جلسة المالك (OWNER:) فاعلها المالك بلا اسم للشركة لا «إداريّ» — والمفتاح الذي أصدره الدعم «الدعم الفني»', async () => {
  const { db } = memDb({
    customer: [CUST],
    customerDocument: [{ id: 'd1', tenantId: T, customerId: 'c1', kind: 'CR', sizeBytes: 1, uploadedByKind: 'ADMIN', uploadedById: 'OWNER:o1', uploadedByName: 'الدعم الفني', createdAt: D('2026-03-01T00:00:00Z') }],
    customerActivity: [log('L-k', '2026-11-27T09:00:00Z', 'CUSTOMER_UPDATED', { actorKind: 'API', actorId: 'k-sup', actorName: null })],
    apiKey: [{ id: 'k-sup', tenantId: T, name: 'وسمٌ داخلي', createdBy: 'OWNER:o1' }],
  });
  const p = await page({ db, customerScope: noScope }, admin());
  assert.deepEqual(p.items.find((i) => i.id === 'h:doc:d1')!.actor, { kind: 'OWNER', name: null });
  assert.deepEqual(p.items.find((i) => i.id === 'L-k')!.actor, { kind: 'API', name: PLATFORM_SUPPORT_NAME });
  const rq = (user: Row) => ({ user } as unknown as AuthRequest);
  assert.deepEqual(actorFromReq(rq({ id: 'a1', role: 'ADMIN', apiKeyId: 'k-sup', apiKeyName: 'وسم', ownerIssuedKey: true })), { kind: 'API', id: 'k-sup', name: PLATFORM_SUPPORT_NAME });
  assert.deepEqual(actorFromReq(rq({ id: 'a1', role: 'ADMIN', apiKeyId: 'k1', apiKeyName: 'ERP' })), { kind: 'API', id: 'k1', name: 'ERP' });
});

// ═══ C2 والمبلغ ═══

test('C2: تغيّر «رمز العميل» (code) يُسجَّل في الفرق — وتركه بلا تغيير لا', () => {
  assert.deepEqual(customerDiff({ code: 'A1' }, { code: 'B2' }), [{ field: 'code', from: 'A1', to: 'B2' }]);
  assert.deepEqual(customerDiff({ code: 'A1' }, { code: 'A1' }), []);
  assert.deepEqual(customerDiff({ code: 'A1' }, {}), []);
});

test('المبلغ خارج مدى Decimal(18,4) لا يُكتب في العمود (لا يُفشل الإجراء) ويبقى نصّاً في التفاصيل', () => {
  const row = activityRow({ tenantId: T, customerId: 'c1', action: 'INVOICE_ISSUED', actor: { kind: 'SYSTEM', id: null, name: null }, amount: 1e15, data: { total: 1 } })!;
  assert.equal('amount' in row, false);
  assert.equal((row.data as Row).amountOutOfRange, '1000000000000000');
  assert.equal((row.data as Row).total, 1);
  const ok = activityRow({ tenantId: T, customerId: 'c1', action: 'INVOICE_ISSUED', actor: { kind: 'SYSTEM', id: null, name: null }, amount: '99999999999999.9999' })!;
  assert.equal(String(ok.amount), '99999999999999.9999');
});
