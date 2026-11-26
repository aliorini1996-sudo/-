// «سجلّ العميل» — انحدار اختبارات التحقّق (verify_tests) بعد جولة الإصلاح: كل اختبارٍ هنا أثبت خللاً قبلها بسيناريو المُحقِّق نفسه،
// وهو الآن مقلوبٌ يُثبت السلوك المُصلَح — فلا يعود الخلل بصمت:
//   C1  مؤقّتٌ وملاحظةٌ حيّان لوقفةٍ واحدة بندٌ واحد (كالمشتقّ)، والوقفة المشتقّة لا تتكرّر حين يقطعها حدّ الصفحة.
//   C3  مال العميل للمندوب بـ«عرض كشف الحساب» وحده (ولو كانت المستندات لمندوبٍ أو فريقٍ آخر).
//   C4  طلب المنيو المسجَّل على عميلٍ لا يظهر «تاريخياً» على عميلٍ آخر بالجوال نفسه؛ والمشتقّ للمطابق الوحيد «غير موثّق».
//   C6  عمليةٌ وافقت قبل السجلّ وعُكست بعده يبقى تحصيلها مع سطر العكس، والمراجعة HELD لا «تحصيل».
//   C11 بدء السجلّ للشركة لا للعميل، وإعادة حفظ الخطّ تُبقي تاريخ الدخول، وأسعار الدفعة بسطرٍ لكل صنف، والمرتجع بأسماء السجلّ الحيّ،
//       وتوأم الرابط الملغى بعد البدء لا يُشتقّ.
//   C16 لحظةٌ مستقبلية لا تُحفظ، والتأريخ اليدوي لا يحرّك «بدء السجلّ» (recordedAt).
//   C21 أحداث المعاملة الواحدة بترتيب وقوعها لا بمعرّفاتها العشوائية.
//   C24 فعل المالك حيّاً ومشتقّاً بالوسم نفسه؛ والمفتاح الذي أصدره الدعم «الدعم الفني».
//   C2/C7/C8/C12 صورة ما كُتب وحده في الفرق، ورقم الفاتورة في توزيع السند، ولا بيانات بطاقة في الملاحظة، وأثر حذف المندوب كاملاً.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLATFORM_SUPPORT_NAME, TRACKED_CUSTOMER_FIELDS, activityRow, actorFromReq, recordCustomerActivity } from '../services/customerActivity';
import { CUSTOMER_ACTIVITY_SELECT, customerUpdateEvents, keptStopDates, repDeleteEvents, writtenImage } from '../services/customerActivityEvents';
import { receiptEventInput } from '../services/customerActivityDocs';
import { orderPhoneKey } from '../services/catalogOrders';
import { docUploader } from '../services/customerDocs';
import { loadCustomerActivity, parseActivityQuery, type ActivityDeps, type ActivityOut } from '../routes/customerActivity';
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
function memDb(tables: Record<string, Row[]>): ActivityDeps['db'] {
  return new Proxy({}, {
    get(_t, model: string) {
      const rows = () => tables[model] ?? [];
      return {
        findMany: async (args: Row = {}) => {
          const hit = sortRows(rows().filter((r) => matchWhere(r, args.where)), args.orderBy);
          return args.take ? hit.slice(0, args.take) : hit;
        },
        findFirst: async (args: Row = {}) => rows().find((r) => matchWhere(r, args.where)) ?? null,
      };
    },
  }) as ActivityDeps['db'];
}

const noScope: ActivityDeps['customerScope'] = async () => ({});
const admin = { user: { id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T } } as unknown as AuthRequest;
const rep = (id = 'r1') => ({ user: { id, role: 'SALES_REP', name: 'أحمد', tenantId: T } } as unknown as AuthRequest);
const CUST = { id: 'c1', tenantId: T, name: 'محل النور', phone: '', number: 7, status: 'ACTIVE', createdAt: D('2024-01-01T08:00:00Z') };

const log = (id: string, at: string, action: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', at: D(at), action, actorKind: 'ADMIN', actorId: 'a1', actorName: 'سارة', refType: null, refId: null,
  refNo: null, amount: null, data: null, ...extra,
});
const visitRow = (id: string, createdAt: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', createdAt: D(createdAt), note: null, durationSec: null, startedAt: null, endedAt: null, lat: null, lng: null,
  salesRepId: 'r1', salesRep: { name: 'أحمد' }, photos: [], ...extra,
});
const stop = (id: string, at: string) => ({
  id, tenantId: T, customerId: 'c1', routeId: `rt-${id}`, seq: 1, createdAt: D(at),
  route: { name: 'خط الأحد', isActive: true, isPermanent: true, routeDate: null, salesRep: { name: 'أحمد' } },
});
const price = (id: string, at: string) => ({ id, customerId: 'c1', productId: `p-${id}`, price: 3, updatedAt: D(at), product: { name: 'ماء' } });

async function page(db: ActivityDeps['db'], req: AuthRequest = admin, q: Row = {}, id = 'c1') {
  return (await loadCustomerActivity({ db, customerScope: noScope }, req, T, id, parseActivityQuery(q)))!;
}
async function allPages(db: ActivityDeps['db'], limit: number): Promise<ActivityOut[]> {
  const out: ActivityOut[] = [];
  let before: string | undefined;
  for (let i = 0; i < 200; i++) {
    const p = await page(db, admin, { limit, before });
    out.push(...p.items);
    if (!p.nextBefore) return out;
    assert.notEqual(p.nextBefore, before, 'المؤشّر يتقدّم');
    before = p.nextBefore;
  }
  throw new Error('لا نهاية للصفحات');
}
const routeOrPrice = (items: ActivityOut[]) => items.filter((x) => x.refType === 'ROUTE' || x.refType === 'PRICE');

// ═══ C1 — الوقفات ═══

test('C1 (vB_c1 C1a): مؤقّتٌ وملاحظةٌ مسجّلان حيّاً لوقفةٍ واحدة بندٌ واحد مرجعه المؤقّت — كما تُدمج الوقفة نفسها قبل بدء السجلّ', async () => {
  const timer = visitRow('vT', '2026-11-26T10:30:00Z', { durationSec: 1800, startedAt: D('2026-11-26T10:00:00Z'), endedAt: D('2026-11-26T10:30:00Z') });
  const note = visitRow('vN', '2026-11-26T10:29:00Z', { note: 'hello', photos: [{ id: 'p1' }, { id: 'p2' }] });
  const visitLog = (id: string, v: Row, data: Row) => log(id, v.createdAt.toISOString(), 'VISIT_RECORDED', {
    actorKind: 'REP', actorId: 'r1', actorName: 'أحمد', refType: 'VISIT', refId: v.id, data,
  });
  const live = await page(memDb({
    customer: [CUST], repVisit: [timer, note],
    customerActivity: [
      visitLog('L1', timer, { salesRepId: 'r1', durationSec: 1800, startedAt: timer.startedAt.toISOString(), endedAt: timer.endedAt.toISOString(), photosCount: 0 }),
      visitLog('L2', note, { salesRepId: 'r1', note: 'hello', photosCount: 2 }),
    ],
  }));
  const stops = live.items.filter((i) => i.action === 'VISIT_RECORDED');
  assert.equal(stops.length, 1, `وقفةٌ واحدة لا بندان: ${JSON.stringify(stops.map((s) => s.id))}`);
  assert.deepEqual([stops[0].id, stops[0].refId, stops[0].historical], ['L1', 'vT', false], 'رأسها المؤقّت الحيّ');
  assert.deepEqual([...(stops[0].data!.visitIds as string[])].sort(), ['vN', 'vT']);
  assert.equal(stops[0].data!.photosCount, 2);
  assert.equal(stops[0].data!.note, 'hello');

  const derived = await page(memDb({ customer: [CUST], repVisit: [timer, note], customerActivity: [] }));
  assert.equal(derived.items.filter((i) => i.action === 'VISIT_RECORDED').length, 1, 'والوقفة نفسها قبل السجلّ بندٌ واحد أيضاً');
});

test('C1 (vB_c1 C1b): الوقفة المشتقّة التي يقطعها حدّ الصفحة (فاتورةٌ بين مؤقّتها وملاحظتها) تظهر مرّةً واحدة في كل الصفحات', async () => {
  const timer = visitRow('vT', '2026-11-20T10:30:00Z', { durationSec: 1800, startedAt: D('2026-11-20T10:00:00Z'), endedAt: D('2026-11-20T10:30:00Z') });
  const note = visitRow('vN', '2026-11-20T10:10:00Z', { note: 'n', photos: [{ id: 'p1' }] });
  const invoice = {
    id: 'i1', tenantId: T, customerId: 'c1', number: 'INV-1', type: 'CASH', status: 'CONFIRMED', documentKind: null, invoiceDate: D('2026-11-20T10:20:00Z'),
    total: 100, taxAmt: 0, paidAmt: 100, remainingAmt: 0, salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { items: 1 },
  };
  const db = memDb({ customer: [CUST], repVisit: [timer, note], invoice: [invoice], customerActivity: [] });
  for (const limit of [1, 2, 3]) {
    const all = await allPages(db, limit);
    const ids = all.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, `limit=${limit}: لا بند مكرّر ${JSON.stringify(ids)}`);
    const visits = all.filter((i) => i.action === 'VISIT_RECORDED');
    assert.equal(visits.length, 1, `limit=${limit}: الوقفة مرّة واحدة`);
    assert.deepEqual([...(visits[0].data!.visitIds as string[])].sort(), ['vN', 'vT']);
    assert.ok(ids.includes('h:invoice:i1'), `limit=${limit}: والفاتورة بينهما لا تضيع`);
  }
});

// ═══ C3 — المال بصلاحيته ═══

test('C3 (vB_c34): مندوبٌ بلا «عرض كشف الحساب» لا يرى مبالغ فواتير العميل وسنداته (ولو كانت لمندوب فريقٍ آخر) — وبها يراها', async () => {
  const tables = (canViewStatement: boolean) => ({
    customer: [CUST],
    salesRep: [{ id: 'r1', tenantId: T, canViewStatement }],
    invoice: [{ id: 'i9', tenantId: T, customerId: 'c1', number: 'INV-9', type: 'CREDIT', status: 'CONFIRMED', documentKind: null,
      invoiceDate: D('2026-11-01T10:00:00Z'), total: 5000, taxAmt: 0, paidAmt: 0, remainingAmt: 5000, salesRepId: 'rOtherTeam', salesRep: { name: 'X' }, _count: { items: 1 } }],
    receipt: [{ id: 'rc9', tenantId: T, customerId: 'c1', number: 'RC-9', amount: 700, paymentMethod: 'CHEQUE', status: 'ACTIVE', receiptDate: D('2026-11-02T10:00:00Z'),
      notes: 'شيك ٤٤٢', clientRef: null, salesRepId: 'rOtherTeam', salesRep: { name: 'X' }, _count: { photos: 0 }, invoiceItems: [] }],
    customerActivity: [],
  });
  const hidden = await page(memDb(tables(false)), rep('r1'));
  const inv = hidden.items.find((i) => i.refId === 'i9')!;
  const rc = hidden.items.find((i) => i.refId === 'rc9')!;
  assert.equal(inv.amount, null);
  assert.equal(rc.amount, null);
  for (const k of ['total', 'remainingAmt', 'paidAmt']) assert.equal(k in (inv.data ?? {}), false, `بلا ${k}`);
  assert.equal('note' in (rc.data ?? {}), false, 'ولا ملاحظة السند');
  assert.equal(inv.refNo, 'INV-9', 'البند نفسه باقٍ: من فعل ماذا ومتى');

  const shown = await page(memDb(tables(true)), rep('r1'));
  assert.equal(shown.items.find((i) => i.refId === 'i9')!.amount, 5000);
  assert.equal(shown.items.find((i) => i.refId === 'i9')!.data!.remainingAmt, 5000);
  assert.equal(shown.items.find((i) => i.refId === 'rc9')!.amount, 700);
});

// ═══ C4 — طلب المنيو على عميلٍ واحد ═══

test('C4 (vB_c34): طلبٌ مسجَّل على العميل A لا يظهر «تاريخياً» على B بالجوال نفسه — والمشتقّ للمطابق الوحيد «غير موثّق»', async () => {
  const A = { id: 'cA', tenantId: T, name: 'A', phone: '0551234567', number: 2, status: 'ACTIVE', createdAt: D('2026-06-01T00:00:00Z') };
  const B = { id: 'cB', tenantId: T, name: 'B', phone: '0551234567', number: 1, status: 'ACTIVE', createdAt: D('2026-01-01T00:00:00Z') };
  const order = (id: string, phone: string, at: string) => ({
    id, tenantId: T, phoneKey: orderPhoneKey(phone), status: 'NEW', customerName: 'المشتري', note: 'n', createdAt: D(at),
    invoiceId: null, salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { items: 2 },
  });
  const placed = log('L1', '2026-11-26T09:00:00Z', 'CATALOG_ORDER_PLACED', {
    customerId: 'cA', actorKind: 'CUSTOMER', actorId: null, actorName: 'المشتري', refType: 'CATALOG_ORDER', refId: 'o1', amount: 10, data: { unverified: true },
  });
  const db = memDb({ customer: [A, B], catalogOrder: [order('o1', '0551234567', '2026-11-26T09:00:00Z')], customerActivity: [placed] });
  const on = async (id: string) => (await page(db, admin, {}, id)).items.filter((i) => i.refId === 'o1').map((i) => `${i.id}:${i.historical}`);
  assert.deepEqual(await on('cA'), ['L1:false']);
  assert.deepEqual(await on('cB'), [], 'لا يظهر على عميلٍ ثانٍ بالجوال نفسه');

  // طلبٌ قديم بلا سطر لعميلٍ وحيدٍ بجواله: مشتقٌّ بفاعل «العميل» وغير موثّق كالسطر الحيّ
  const C = { id: 'cC', tenantId: T, name: 'C', phone: '0559876543', number: 3, status: 'ACTIVE', createdAt: D('2026-01-01T00:00:00Z') };
  const solo = await page(memDb({ customer: [C], catalogOrder: [order('o2', '0559876543', '2026-10-01T09:00:00Z')], customerActivity: [] }), admin, {}, 'cC');
  const o2 = solo.items.find((i) => i.refId === 'o2')!;
  assert.deepEqual([o2.id, o2.action, o2.actor.kind, o2.historical], ['h:order:o2', 'CATALOG_ORDER_PLACED', 'CUSTOMER', true]);
  assert.equal(o2.data!.unverified, true);
});

// ═══ C6 — البطاقة ═══

test('C6 (vB_c6): عمليةٌ وافقت قبل السجلّ وعُكست بعده يبقى تحصيلها المشتقّ مع سطر العكس — والمراجعة HELD لا «تحصيل»', async () => {
  const card = (id: string, status: string, extra: Row = {}) => ({
    id, tenantId: T, customerId: 'c1', amount: 300, status, statusDetail: null, createdAt: D('2026-11-20T10:00:00Z'), approvedAt: null,
    salesRepId: 'r1', createdById: null, cardScheme: 'VISA', salesRep: { name: 'أحمد' }, invoice: { number: 'INV-1' }, ...extra,
  });
  const live = (id: string, action: string) => log(id, '2026-11-26T10:00:00Z', action, {
    actorKind: 'SYSTEM', actorId: null, actorName: null, refType: 'CARD_PAYMENT', refId: 'cp1', refNo: 'INV-1', amount: 300, data: { status: 'reversed' },
  });
  const reversed = card('cp1', 'reversed', { approvedAt: D('2026-11-20T10:01:00Z') });
  const items = async (rows: Row[]) => (await page(memDb({ customer: [CUST], cardPayment: [reversed], customerActivity: rows })))
    .items.filter((i) => i.refId === 'cp1').map((i) => `${i.action}:${i.historical}`);
  assert.deepEqual(await items([live('L1', 'CARD_PAYMENT_REVERSED')]), ['CARD_PAYMENT_REVERSED:false', 'CARD_PAYMENT_COMPLETED:true']);
  // وسطر «فشل» كتبه الكاتب القديم لا يُسقط التحصيل الذي وقع (FAILED ليس ميلاداً)
  assert.deepEqual(await items([live('L1', 'CARD_PAYMENT_FAILED')]), ['CARD_PAYMENT_FAILED:false', 'CARD_PAYMENT_COMPLETED:true']);
  assert.deepEqual(await items([]), ['CARD_PAYMENT_COMPLETED:true']);

  const review = await page(memDb({ customer: [CUST], cardPayment: [card('cp2', 'review', { statusDetail: 'mismatch' })], customerActivity: [] }));
  assert.deepEqual(review.items.filter((i) => i.refId === 'cp2').map((i) => i.action), ['CARD_PAYMENT_HELD']);
});

// ═══ C11 — بدء السجلّ والصفوف المعاد كتابتها ═══

test('C11 (F13): إعادة حفظ الخطّ تُبقي تاريخ دخول العميل الباقي (keptStopDates) — فعضويته وسعره قبل السجلّ لا يختفيان بعده', async () => {
  const kept = keptStopDates([
    { customerId: 'c1', routeId: 'rt-a', routeName: 'خط', salesRepId: 'R1', createdAt: D('2025-05-01T09:00:00Z') },
    { customerId: 'c1', routeId: 'rt-b', routeName: 'خط', salesRepId: 'R1', createdAt: D('2025-03-01T09:00:00Z') },
    { customerId: 'c2', routeId: 'rt-c', routeName: 'خط', salesRepId: 'R2', createdAt: D('2025-03-01T09:00:00Z') },
    { customerId: 'c3', routeId: 'rt-a', routeName: 'خط', salesRepId: 'R1', createdAt: null },
  ], 'R1');
  assert.deepEqual([...kept].map(([c, d]) => [c, d.toISOString()]), [['c1', '2025-03-01T09:00:00.000Z']], 'الأقدم للمندوب نفسه وحده');

  const firstLog = log('L1', '2026-11-27T09:00:00Z', 'INVOICE_ISSUED', { refType: 'INVOICE', refId: 'i1' });
  // بعد إعادة الحفظ: المحطّة الجديدة بتاريخ الدخول الموروث، والسعر الذي لم يتغيّر لم يُعَد كتابته (طابعه باقٍ)
  const after = await page(memDb({
    customer: [CUST], customerActivity: [firstLog],
    repRouteStop: [stop('s2', kept.get('c1')!.toISOString())], customerPrice: [price('x', '2025-03-01T09:00:00Z')],
  }));
  assert.deepEqual(routeOrPrice(after.items).map((x) => x.action).sort(), ['CUSTOMER_PRICE_SET', 'ROUTE_STOP_ADDED']);
});

test('C11 (F37): بدء السجلّ للشركة لا للعميل — عميلٌ بلا سطرٍ أُعيد حفظ خطّه بعد بدء سجلّ الشركة لا «يُضاف» بتاريخ الحفظ', async () => {
  const other = log('L-other', '2026-11-27T09:00:00Z', 'INVOICE_ISSUED', { customerId: 'c2', refType: 'INVOICE', refId: 'i-other' });
  const resaved = await page(memDb({ customer: [CUST], customerActivity: [other], repRouteStop: [stop('s3', '2026-11-28T09:00:00Z')] }));
  assert.deepEqual(routeOrPrice(resaved.items), []);
  const old = await page(memDb({ customer: [CUST], customerActivity: [other], repRouteStop: [stop('s4', '2025-03-01T09:00:00Z')] }));
  assert.deepEqual(routeOrPrice(old.items).map((x) => [x.action, x.historical]), [['ROUTE_STOP_ADDED', true]], 'وما قبل البدء تاريخٌ مشتقّ');
});

test('C11 (F37 skew): أسعار صنفين بسطرٍ لكل صنفٍ مرجعه الصنف — لا تتكرّر مشتقّةً ولو سبقت ساعةُ التطبيق ساعةَ القاعدة', async () => {
  const rows = ['a', 'b'].map((x) => log(`L-${x}`, '2026-11-12T09:00:00.010Z', 'CUSTOMER_PRICE_SET', {
    refType: 'PRICE', refId: `p-${x}`, data: { items: [{ productId: `p-${x}`, productName: 'ماء', from: null, to: 3 }] },
  }));
  const p = await page(memDb({
    customer: [CUST], customerActivity: rows, customerPrice: [price('a', '2026-11-12T09:00:00.005Z'), price('b', '2026-11-12T09:00:00.006Z')],
  }));
  const prices = p.items.filter((x) => x.action === 'CUSTOMER_PRICE_SET');
  assert.deepEqual(prices.map((x) => [x.refId, x.historical]).sort(), [['p-a', false], ['p-b', false]]);
});

test('C11 (F39): المرتجع المشتقّ بأسماء السجلّ الحيّ — رمز السبب في returnReason وعودته للمخزون، ونصّ السبب في reason', async () => {
  const ret = {
    id: 'r1', tenantId: T, customerId: 'c1', number: 'RET-1', type: 'RETURN', status: 'CONFIRMED', documentKind: null, invoiceDate: D('2025-05-01T09:00:00Z'),
    total: 30, taxAmt: 0, paidAmt: 0, remainingAmt: 0, returnReason: 'DAMAGED', returnToStock: false, noteReason: 'كرتون مبلول', salesRepId: null, salesRep: null, _count: { items: 1 },
  };
  const it = (await page(memDb({ customer: [CUST], invoice: [ret] }))).items.find((x) => x.refId === 'r1')!;
  assert.equal(it.action, 'RETURN_ISSUED');
  assert.deepEqual([it.data!.returnReason, it.data!.returnToStock, it.data!.reason], ['DAMAGED', false, 'كرتون مبلول']);
});

test('C11 (F6): رابط دفعٍ أُنشئ بعد بدء السجلّ وأُلغي بلا سطر (توأم السباق/اليتيم) لا يُشتقّ — والملغى قبل البدء تاريخٌ باقٍ', async () => {
  const firstLog = log('L1', '2026-11-27T09:00:00Z', 'INVOICE_ISSUED', { refType: 'INVOICE', refId: 'i1' });
  const link = (id: string, at: string) => ({
    id, tenantId: T, customerId: 'c1', amount: 40, status: 'canceled', createdAt: D(at), paidAt: null, expiresAt: D('2026-12-05T00:00:00Z'),
    salesRepId: 'r1', createdById: null, salesRep: { name: 'أحمد' }, invoice: { number: 'INV-1' },
  });
  const p = await page(memDb({ customer: [CUST], customerActivity: [firstLog], customerPaymentLink: [link('pl-twin', '2026-11-28T09:00:00Z'), link('pl-old', '2026-10-01T09:00:00Z')] }));
  assert.equal(p.items.some((x) => x.refId === 'pl-twin'), false);
  const old = p.items.find((x) => x.refId === 'pl-old')!;
  assert.deepEqual([old.action, old.historical], ['PAYLINK_CREATED', true]);
});

// ═══ C16 — اللحظة ═══

test('C16 (F27): لحظةٌ في ٢٠٩٩ لا تُحفظ (تبقى في claimedAt) — والسطر المؤرَّخ يدوياً إلى ٢٠٢٠ لا يحرّك بدء السجلّ (recordedAt) فلا يُخفي تاريخاً', async () => {
  const row = activityRow({ tenantId: T, customerId: 'c1', action: 'VISIT_RECORDED', actor: { kind: 'API', id: 'k1', name: null }, at: D('2099-01-01T00:00:00Z') })!;
  assert.equal('at' in row, false, 'لحظة الإدراج للقاعدة');
  assert.equal((row.data as Row).claimedAt, '2099-01-01T00:00:00.000Z');
  assert.equal('recordedAt' in row, false, 'recordedAt لا يُكتب من مُدخلٍ أبداً');

  const tables = { customer: [CUST], repRouteStop: [stop('s', '2025-03-01T09:00:00Z')], customerPrice: [price('x', '2025-03-01T09:00:00Z')] };
  const realFirst = log('L1', '2026-11-27T09:00:00Z', 'INVOICE_ISSUED', { refType: 'INVOICE', refId: 'i1', recordedAt: D('2026-11-27T09:00:00Z') });
  const backdated = log('LV', '2020-01-01T00:00:00Z', 'VISIT_RECORDED', {
    refType: 'VISIT', refId: 'v-api', actorKind: 'API', recordedAt: D('2026-11-28T09:00:00Z'), data: { backdated: true },
  });
  const p = await page(memDb({ ...tables, customerActivity: [realFirst, backdated] }));
  assert.equal(routeOrPrice(p.items).length, 2, 'تاريخ ٢٠٢٥ المشتقّ باقٍ');
});

// ═══ C21 — ترتيب أحداث المعاملة الواحدة ═══

test('C21 (c21_server_ties): سداد الرابط ثم سنده في معاملةٍ واحدة يُعرضان بترتيب وقوعهما أيّاً كانت معرّفاتهما العشوائية', async () => {
  const written: Row[] = [];
  const sink = { customerActivity: { createMany: async (a: { data: Row[] }) => { written.push(...a.data); return { count: a.data.length }; } } };
  const actor = { kind: 'CUSTOMER' as const, id: null, name: 'محل' };
  await recordCustomerActivity(sink, [
    { tenantId: T, customerId: 'c1', action: 'PAYLINK_PAID', actor, refType: 'PAYLINK', refId: 'pl1' },
    { tenantId: T, customerId: 'c1', action: 'RECEIPT_ISSUED', actor, refType: 'RECEIPT', refId: 'rc1' },
  ]);
  assert.ok(written[0].at instanceof Date && written[1].at instanceof Date);
  assert.ok((written[1].at as Date).getTime() > (written[0].at as Date).getTime(), 'لحظاتٌ متزايدة بترتيب الإدراج');

  for (const ids of [['1aaaaaaa', 'faaaaaaa'], ['fbbbbbbb', '1bbbbbbb']]) {
    const rows = written.map((w, i) => ({ ...w, id: `${ids[i]}-0000-4000-8000-000000000000`, actorId: null, actorName: 'محل', refNo: null, amount: null, data: null }));
    const p = await page(memDb({ customer: [CUST], customerActivity: rows }));
    assert.deepEqual(p.items.filter((x) => !x.historical).map((x) => x.action), ['RECEIPT_ISSUED', 'PAYLINK_PAID'], `المعرّفات ${ids.join('/')}`);
  }
});

// ═══ C24 — أفعال المنصّة ═══

test('C24 (c24_actor_labels): فعل جلسة المالك حيّاً ومشتقّاً بالوسم نفسه (المالك بلا اسم) — والمفتاح الذي أصدره الدعم «الدعم الفني»', async () => {
  const ownerSession = { user: { id: 'a1', role: 'ADMIN', name: 'مدير الشركة', tenantId: T, impersonated: true, by: 'owner-1' } } as unknown as AuthRequest;
  const p = await page(memDb({
    customer: [CUST],
    customerActivity: [log('L1', '2026-11-26T10:00:00Z', 'DOCUMENT_ADDED', { actorKind: 'OWNER', actorId: 'owner-1', actorName: null, refType: 'DOCUMENT', refId: 'd-new' })],
    customerDocument: [{ id: 'd-old', tenantId: T, customerId: 'c1', kind: 'CR', sizeBytes: 10, createdAt: D('2026-10-01T10:00:00Z'), ...docUploader(ownerSession) }],
  }));
  assert.deepEqual(p.items.find((x) => x.id === 'L1')!.actor, { kind: 'OWNER', name: null });
  assert.deepEqual(p.items.find((x) => x.refId === 'd-old')!.actor, { kind: 'OWNER', name: null }, 'لا «الدعم الفني · إداري» للمشتقّ');

  const keyReq = { user: { id: 'a1', role: 'ADMIN', name: 'مدير الشركة', tenantId: T, apiKeyId: 'k1', apiKeyName: 'Odoo sync', ownerIssuedKey: true } } as unknown as AuthRequest;
  assert.deepEqual(actorFromReq(keyReq), { kind: 'API', id: 'k1', name: PLATFORM_SUPPORT_NAME });
  assert.equal(docUploader(keyReq).uploadedByName, PLATFORM_SUPPORT_NAME, 'كما تسمّيه الوثائق');
});

// ═══ C2/C7/C8/C12 — الكُتّاب ═══

test('C2 (vB_c2): كل حقلٍ متتبَّع هو عمودٌ في العميل مقروءٌ في صورة القفل — والصفّ الكامل بعد الكتابة لا يُدخل في الفرق إلا ما كُتب', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const block = /\nmodel Customer \{\n([\s\S]*?)\n\}/.exec(schema);
  assert.ok(block, 'model Customer');
  const SCALARS = new Set(['String', 'Int', 'Float', 'Decimal', 'DateTime', 'Boolean', 'Json', 'BigInt']);
  const columns = new Set(block[1].split('\n').map((l) => /^\s+(\w+)\s+(\w+)/.exec(l)).filter((m): m is RegExpExecArray => !!m && SCALARS.has(m[2])).map((m) => m[1]));
  assert.ok(columns.has('altPhone') && columns.has('code'));
  const missing = TRACKED_CUSTOMER_FIELDS.filter((f) => columns.has(f) && !(f in CUSTOMER_ACTIVITY_SELECT));
  assert.deepEqual(missing, [], 'حقلٌ متتبَّع خارج الصورة يُقرأ «فارغاً» فيُنسب تغييره لغير فاعله');

  // A قرأ (هاتف X)، وB غيّر الهاتف إلى Y، ثم كتب A الاسم وحده: الصفّ العائد كاملاً لا يُلصق تغيير B بسطر A
  const meta = { actor: { kind: 'ADMIN' as const, id: 'a1', name: 'A' }, source: 'web' };
  const before = { id: 'c1', name: 'old', phone: '0500000001', status: 'ACTIVE' };
  const fullRow = { id: 'c1', name: 'new', phone: '0500000002', status: 'ACTIVE' };
  const ev = customerUpdateEvents(before, writtenImage(fullRow, { name: 'new' }), { tenantId: T, customerId: 'c1', meta });
  assert.deepEqual(ev.flatMap((e) => ((e.data as Row)?.changes ?? []).map((c: Row) => c.field)), ['name']);
});

test('C7/C8 (vB_c78): توزيع السند برقم كل فاتورة — وإلغاء سند البطاقة يدوياً لا يحمل البطاقة المقنّعة ولا رقم المرجع', () => {
  const meta = { actor: { kind: 'ADMIN' as const, id: 'a1', name: 'A' }, source: 'web' };
  const issued = activityRow(receiptEventInput({
    tenantId: T, action: 'RECEIPT_ISSUED', meta, receipt: { id: 'r1', customerId: 'c1', amount: 500 },
    allocations: [{ invoiceId: 'i1', invoiceNo: 'INV-1', amount: 500, settled: true }],
  }))!;
  assert.deepEqual((issued.data as Row).allocations, [{ invoiceId: 'i1', invoiceNo: 'INV-1', amount: 500, settled: true }]);

  const posNotes = 'تحصيل بالبطاقة VISA 411111******1111 — فاتورة INV-1 — RRN 123456789012';
  const cancelled = activityRow(receiptEventInput({
    tenantId: T, action: 'RECEIPT_CANCELLED', meta, receipt: { id: 'r1', customerId: 'c1', amount: 500, paymentMethod: 'POS', notes: posNotes },
  }))!;
  const text = JSON.stringify(cancelled);
  assert.doesNotMatch(text, /411111/);
  assert.doesNotMatch(text, /123456789012/);
});

test('C7: سطرٌ حيٌّ قديم بتوزيعٍ بلا رقم فاتورة يُعرض برقمها من جدول الفواتير — والسطر المخزَّن لا يُمسّ', async () => {
  const stored = log('L-rc', '2026-11-26T10:00:00Z', 'RECEIPT_ISSUED', {
    refType: 'RECEIPT', refId: 'rc1', refNo: 'RC-1', amount: 500, data: { paymentMethod: 'CASH', allocations: [{ invoiceId: 'i1', amount: 500, settled: true }] },
  });
  const invoice = {
    id: 'i1', tenantId: T, customerId: 'c1', number: 'INV-1', type: 'CREDIT', status: 'CONFIRMED', documentKind: null, invoiceDate: D('2026-11-01T09:00:00Z'),
    total: 500, taxAmt: 0, paidAmt: 500, remainingAmt: 0, salesRepId: null, salesRep: null, _count: { items: 1 },
  };
  const p = await page(memDb({ customer: [CUST], customerActivity: [stored], invoice: [invoice] }));
  const it = p.items.find((x) => x.id === 'L-rc')!;
  assert.deepEqual((it.data!.allocations as Row[]).map((a) => a.invoiceNo), ['INV-1']);
  assert.equal('invoiceNo' in stored.data.allocations[0], false);
});

test('C12 (c9_c12): حذف المندوب يقرأ محطّات خطوطه النشطة وطلبات منيوه ومن أضافهم — لا «إلغاء الإسناد» وحده', async () => {
  const key = orderPhoneKey('0551234567');
  const db = {
    customerActivity: { createMany: async () => ({ count: 0 }), findMany: async () => [] },
    invoice: { groupBy: async () => [] }, receipt: { groupBy: async () => [] }, repVisit: { groupBy: async () => [] },
    customerAssignment: { findMany: async () => [{ customerId: 'c1' }] },
    repRouteStop: { findMany: async () => [{ customerId: 'c1', routeId: 'rt1', route: { name: 'خط الأحد' } }, { customerId: 'c1', routeId: 'rt1', route: { name: 'خط الأحد' } }] },
    catalogOrder: { findMany: async () => [{ id: 'o1', phoneKey: key, status: 'NEW', createdAt: D('2026-11-20T09:00:00Z') }] },
    customer: { findMany: async () => [{ id: 'c9' }] },
    $queryRaw: async () => [{ id: 'c1', name: 'محل', phone: '0551234567', createdAt: D('2026-01-01T00:00:00Z') }],
  };
  const meta = { actor: { kind: 'ADMIN' as const, id: 'a1', name: 'مدير' }, source: 'web' };
  const out = await repDeleteEvents(db, T, { id: 'rep-1', name: 'خالد' }, meta, 'REP_DELETED');
  const by = (action: string) => out.filter((e) => e.action === action).map((e) => [e.customerId, e.refId]);
  assert.deepEqual(by('CUSTOMER_UNASSIGNED'), [['c1', 'rep-1']]);
  assert.deepEqual(by('ROUTE_STOP_REMOVED'), [['c1', 'rt1']], 'عميلٌ مرّةً لكل خطّ');
  assert.deepEqual(by('CATALOG_ORDER_UPDATED'), [['c1', 'o1']]);
  assert.equal(out.find((e) => e.action === 'CATALOG_ORDER_UPDATED')!.data!.newStatus, 'DELETED');
  assert.deepEqual(by('CUSTOMER_UPDATED'), [['c9', 'c9']]);
});
