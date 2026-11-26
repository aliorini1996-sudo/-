// «سجلّ العميل» — اختبارات الدمج النهائي (٢٧ نوفمبر ٢٠٢٦): ما طلبه المُصلِحون بعضهم من بعض ونُفّذ عند الدمج، وإعادة إنتاجات
// المراجعين (verify_tests) مقلوبةً لتُثبت السلوك المُصلَح:
//   C16 لحظة الإجراء لا تتجاوز «الآن» (activityRow)، و«بدء سجلّ الشركة» بلحظة الإدراج (recordedAt) فلا يحرّكه سطرٌ مؤرَّخ يدوياً.
//   C11 السعر الخاص سطرٌ لكل صنفٍ بمرجعه فلا يُشتقّ ثانيةً عند تفاوت الساعتين، والعميل الباقي في خطّ مندوبه يرث تاريخ دخوله.
//   C15 التسويات المشتقّة بأثرها الموقَّع على الرصيد كالسجلّ الحيّ.
//   C3  مفاتيح القيود والحذف الآمنة تبقى لمن لا يرى المال (أرقامٌ وأوضاع بلا مبالغ).
//   C7  أرقام الفواتير الناقصة في الأسطر القديمة تُكمَّل عند القراءة بشركة الطالب.
//   C22 معرّف المنفّذ للمندوب والإداري وحدهما.
//   C10 قيد تصحيح ذمم العملاء (C3) حدثٌ في سجلّ عميله داخل معاملة القيد.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ACTIVITY_FUTURE_SKEW_MS, activityRow, recordCustomerActivity } from '../services/customerActivity';
import { keptStopDates, type RouteStopRef } from '../services/customerActivityEvents';
import { loadCustomerActivity, parseActivityQuery, tenantLogStart, type ActivityDeps } from '../routes/customerActivity';
import type { AuthRequest } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const D = (s: string) => new Date(s);
const T = 't1';
const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

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
      if (x === undefined) return 1;
      if (y === undefined) return -1;
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
const admin = (extra: Row = {}) => ({ user: { id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T, ...extra } } as unknown as AuthRequest);
const rep = (id = 'r1') => ({ user: { id, role: 'SALES_REP', name: 'أحمد', tenantId: T } } as unknown as AuthRequest);
const CUST = { id: 'c1', tenantId: T, name: 'محل النور', phone: '0501234567', number: 7, status: 'ACTIVE', createdAt: D('2024-01-01T08:00:00Z') };
const log = (id: string, at: string, action: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', at: D(at), recordedAt: D(at), action, actorKind: 'ADMIN', actorId: 'a1', actorName: 'سارة', refType: null,
  refId: null, refNo: null, amount: null, data: null, ...extra,
});
const stop = (id: string, at: string) => ({
  id, tenantId: T, customerId: 'c1', routeId: `rt-${id}`, seq: 1, createdAt: D(at),
  route: { name: 'خط الأحد', isActive: true, isPermanent: true, routeDate: null, salesRep: { name: 'أحمد' } },
});
const price = (id: string, at: string) => ({ id, customerId: 'c1', productId: `p-${id}`, price: 3, updatedAt: D(at), product: { name: 'ماء' } });
const page = async (deps: ActivityDeps, req: AuthRequest = admin(), q: Row = {}) => (await loadCustomerActivity(deps, req, T, 'c1', parseActivityQuery(q)))!;

// ═══ C16 — اللحظتان ═══

test('C16: activityRow لا يحفظ لحظةً بعد «الآن» + هامش الساعة — تسقط فيأخذ السطر لحظة إدراجه وتبقى المُرسلة في data.claimedAt', () => {
  const now = Date.parse('2026-11-27T09:00:00Z');
  const base = { tenantId: T, customerId: 'c1', action: 'VISIT_RECORDED' as const, actor: { kind: 'API' as const, id: 'k1', name: null } };
  const far = activityRow({ ...base, at: D('2099-01-01T00:00:00Z'), data: { note: 'x' } }, now)!;
  assert.equal(far.at, undefined, 'لا يُثبَّت بندٌ أعلى السجلّ إلى ٢٠٩٩');
  assert.deepEqual(far.data, { note: 'x', claimedAt: '2099-01-01T00:00:00.000Z' });
  // داخل الهامش (ساعة جهازٍ متقدّمة دقيقة) وفي الماضي: كما أُرسلت
  const near = new Date(now + ACTIVITY_FUTURE_SKEW_MS - 1000);
  assert.equal((activityRow({ ...base, at: near }, now)!.at as Date).getTime(), near.getTime());
  assert.equal((activityRow({ ...base, at: D('2026-11-20T09:00:00Z') }, now)!.at as Date).toISOString(), '2026-11-20T09:00:00.000Z');
  // recordedAt بساعة القاعدة وحدها: لا يحمله صفّ الإدراج ولو مُرِّر
  const forged = activityRow({ ...base, recordedAt: D('2020-01-01T00:00:00Z') } as never, now)!;
  assert.equal('recordedAt' in forged, false);
});

test('C16: الدفعة بلحظةٍ مستقبلية تأخذ لحظات إدراجها المتزايدة كبقية الدفعة', async () => {
  const rows: Row[] = [];
  const db = { customerActivity: { createMany: async (a: { data: Row[] }) => { rows.push(...a.data); } } };
  const base = { tenantId: T, customerId: 'c1', action: 'OTHER' as const, actor: { kind: 'SYSTEM' as const, id: null, name: null } };
  await recordCustomerActivity(db, [{ ...base, at: D('2099-01-01T00:00:00Z') }, { ...base }]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.at instanceof Date && r.at.getTime() < Date.parse('2030-01-01')), 'لا ٢٠٩٩');
  assert.ok(rows[1].at.getTime() > rows[0].at.getTime(), 'بترتيب الإدراج');
});

test('C16/C11 (إعادة إنتاج F27 مقلوبة): سطرٌ مؤرَّخ في ٢٠٢٠ لا يحرّك «بدء سجلّ الشركة» — القاطع لحظة الإدراج (recordedAt)', async () => {
  const realFirst = log('L1', '2026-11-27T09:00:00Z', 'INVOICE_ISSUED', { refType: 'INVOICE', refId: 'i1' });
  // زيارةٌ من مفتاح API مؤرَّخةٌ في ٢٠٢٠ (at) أُدرجت اليوم (recordedAt)
  const backdated = log('LV', '2020-01-01T00:00:00Z', 'VISIT_RECORDED', {
    refType: 'VISIT', refId: 'v-api', actorKind: 'API', recordedAt: D('2026-11-28T09:00:00Z'),
  });
  const tables = { customer: [CUST], repRouteStop: [stop('s', '2025-03-01T09:00:00Z')], customerPrice: [price('x', '2025-03-01T09:00:00Z')] };
  const { db } = memDb({ ...tables, customerActivity: [realFirst, backdated] });
  assert.equal((await tenantLogStart(db, T))!.toISOString(), '2026-11-27T09:00:00.000Z');
  const p = await page({ db, customerScope: noScope });
  assert.equal(p.items.filter((x) => x.refType === 'ROUTE' || x.refType === 'PRICE').length, 2, 'تاريخ ٢٠٢٥ المشتقّ باقٍ');
  // صفٌّ بلا recordedAt (قاعدةٌ قديمة في الذاكرة) ⇒ at
  const { db: db2 } = memDb({ customerActivity: [{ ...realFirst, recordedAt: undefined }] });
  assert.equal((await tenantLogStart(db2, T))!.toISOString(), '2026-11-27T09:00:00.000Z');
  // والاستعلام بفهرس (tenantId, recordedAt)
  const { db: db3, queries } = memDb({ customerActivity: [realFirst] });
  await tenantLogStart(db3, T);
  assert.deepEqual(queries[0].args.orderBy[0], { recordedAt: 'asc' });
  assert.deepEqual(queries[0].args.where, { tenantId: T });
});

test('C16: المخطّط — recordedAt بافتراض القاعدة وفهرس (tenantId, recordedAt) على الجدول الجديد وحده', () => {
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  const start = schema.indexOf('model CustomerActivity {');
  const body = schema.slice(start, schema.indexOf('\n}', start));
  assert.match(body, /recordedAt\s+DateTime\s+@default\(now\(\)\)/);
  assert.match(body, /@@index\(\[tenantId, recordedAt\]\)/);
  assert.doesNotMatch(read('routes', 'customerActivity.ts'), /orderBy: \[\{ at: 'asc' \}, \{ id: 'asc' \}\], take: 1/, 'القاطع لا يُحسب بـat');
});

// ═══ C11 — السعر الخاص ومحطّات الخطّ ═══

test('C11 (إعادة إنتاج F37 مقلوبة): أسعار الدفعة سطرٌ لكل صنفٍ بمرجعه — ساعة الخادم المتأخّرة عن القاعدة لا تُظهر السعر مرّتين', async () => {
  const at = '2026-11-12T09:00:00.010Z';
  const { db } = memDb({
    customer: [CUST],
    customerActivity: [
      log('L2a', at, 'CUSTOMER_PRICE_SET', { refType: 'PRICE', refId: 'p-a', data: { count: 1, items: [{ productId: 'p-a', from: null, to: 3 }] } }),
      log('L2b', at, 'CUSTOMER_PRICE_SET', { refType: 'PRICE', refId: 'p-b', data: { count: 1, items: [{ productId: 'p-b', from: null, to: 3 }] } }),
    ],
    // طابع التطبيق قبل لحظة القاعدة بأجزاء من الثانية ⇒ «قبل بدء السجلّ»
    customerPrice: [price('a', '2026-11-12T09:00:00.005Z'), price('b', '2026-11-12T09:00:00.006Z')],
  });
  const p = await page({ db, customerScope: noScope });
  assert.deepEqual(p.items.filter((x) => x.action === 'CUSTOMER_PRICE_SET').map((x) => x.id).sort(), ['L2a', 'L2b']);
});

test('C11: PUT /customers/:id/prices — السعر الذي لم يتغيّر لا يُعاد كتابته (يبقى طابعه)، والتغيّر سطرٌ لكل صنفٍ بمرجعه', () => {
  const src = read('routes', 'customers.ts');
  const at = src.indexOf("router.put('/:id/prices'");
  const body = src.slice(at, src.indexOf('\n});', at));
  assert.match(body, /const writes = logged \? changed\.map\(c => \(\{ productId: c\.productId, price: c\.to \}\)\) : prices;/);
  assert.match(body, /for \(const p of writes\) \{\s*await tx\.customerPrice\.upsert\(/);
  assert.match(body, /recordActivityInTx\(tx, changed\.map\(c => \(\{[\s\S]*?refType: 'PRICE' as const, refId: c\.productId/);
});

test('C11: إعادة حفظ الخطّ — العميل الباقي في خطّ مندوبه يرث أقدم تاريخ دخول (keptStopDates)، ومن كان لمندوبٍ آخر أو بلا طابع يدخل الآن', () => {
  const old: RouteStopRef[] = [
    { customerId: 'c1', routeId: 'r-old', routeName: 'أ', salesRepId: 'rep1', createdAt: D('2025-03-01T00:00:00Z') },
    { customerId: 'c1', routeId: 'r-old2', routeName: 'ب', salesRepId: 'rep1', createdAt: D('2024-01-01T00:00:00Z') },
    { customerId: 'c2', routeId: 'r-x', routeName: 'ج', salesRepId: 'rep2', createdAt: D('2025-01-01T00:00:00Z') },
    { customerId: 'c3', routeId: 'r-old', routeName: 'أ', salesRepId: 'rep1' },
  ];
  const kept = keptStopDates(old, 'rep1');
  assert.deepEqual([...kept].map(([k, v]) => [k, v.toISOString()]), [['c1', '2024-01-01T00:00:00.000Z']]);
  const src = read('routes', 'repRoutes.ts');
  assert.match(src, /select: \{ customerId: true, routeId: true, createdAt: true \}/, 'طابع المحطّة يُقرأ قبل حذفها');
  assert.match(src, /const joined = keptStopDates\(before, body\.salesRepId\);/);
  assert.match(src, /\.\.\.\(since && \{ createdAt: since \}\),/, 'المحطّة الجديدة ترث تاريخ الدخول');
});

// ═══ C15 — أثر التسوية المشتقّة ═══

test('C15: التسويات المشتقّة بأثرها الموقَّع على رصيد العميل (مدين − دائن) — الشطب سالب، والمدين موجب، وقيد عكس الإلغاء سالب أصله', async () => {
  const entry = (id: string, at: string, debit: number, credit: number, extra: Row = {}) => ({
    id, tenantId: T, customerId: 'c1', type: debit ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT', debit, credit, description: null,
    entryDate: D(at), createdAt: D(at), invoiceId: null, receiptId: null, ...extra,
  });
  const { db } = memDb({
    customer: [CUST],
    accountEntry: [
      entry('e-wo', '2025-01-01T09:00:00Z', 0, 500),
      entry('e-deb', '2025-01-02T09:00:00Z', 200, 0),
      entry('e-rev', '2025-01-03T09:00:00Z', 500, 0),
      entry('e-open', '2024-06-01T09:00:00Z', 0, 300, { description: 'رصيد افتتاحي' }),
    ],
    customerAdjustment: [
      { id: 'e-wo', tenantId: T, customerId: 'c1', kind: 'BAD_DEBT_WRITEOFF', status: 'CANCELLED', reference: 'W-1', createdBy: 'a1', cancelledBy: 'a1', cancelReason: 'خطأ', reverseEntryId: 'e-rev' },
      { id: 'e-deb', tenantId: T, customerId: 'c1', kind: 'DEBIT', status: 'ACTIVE', reference: 'D-1', createdBy: 'a1', reverseEntryId: null },
    ],
  });
  const p = await page({ db, customerScope: noScope });
  const amt = (refId: string, action: string) => p.items.find((x) => x.refId === refId && x.action === action)!.amount;
  assert.equal(amt('e-wo', 'ADJUSTMENT_CREATED'), -500, 'الشطب ينقص ما على العميل');
  assert.equal(amt('e-deb', 'ADJUSTMENT_CREATED'), 200);
  assert.equal(amt('e-wo', 'ADJUSTMENT_UPDATED'), 500, 'إلغاء الشطب سالب أثره');
  const opening = p.items.find((x) => x.refId === 'e-open')!;
  assert.ok(opening.amount! < 0, 'رصيدٌ افتتاحي دائن سالب');
});

// ═══ C3 — المفاتيح الآمنة بلا مال ═══

test('C3: من لا يرى المال يرى أرقام القيود وأوضاعها وحالاتها (moveNo/reversalNo/mode/closedAfterReview/fromStatus/cascade) بلا مبالغ', async () => {
  const { db } = memDb({
    customer: [CUST],
    salesRep: [{ id: 'r1', tenantId: T, canViewStatement: false }],
    customerActivity: [
      log('LJ', '2026-11-26T10:00:00Z', 'LEDGER_JOURNAL_REVERSED', {
        refType: 'ADJUSTMENT', refId: 'm1', refNo: 'JV-1', amount: -500,
        data: { kind: 'GL_JOURNAL', moveNo: 'JV-1', mode: 'REVERSAL', reversalNo: 'JV-2', debit: 500, credit: 0, narration: 'سرّي' },
      }),
      log('LH', '2026-11-26T09:00:00Z', 'CARD_PAYMENT_HELD', {
        refType: 'CARD_PAYMENT', refId: 'cp1', amount: 90, data: { status: 'failed', closedAfterReview: true, fromStatus: 'review', note: 'سرّي' },
      }),
      log('LD', '2026-11-26T08:00:00Z', 'RECEIPT_DELETED', {
        refType: 'RECEIPT', refId: 'rc1', amount: 70,
        data: { reason: 'OWNER_PURGE', cascade: true, purged: true, allocations: [{ invoiceId: 'i1', invoiceNo: 'INV-1', amount: 70, restored: true }] },
      }),
    ],
  });
  const p = await page({ db, customerScope: noScope }, rep('r1'));
  const by = (id: string) => p.items.find((x) => x.id === id)!;
  assert.equal(by('LJ').amount, null);
  assert.deepEqual(by('LJ').data, { kind: 'GL_JOURNAL', moveNo: 'JV-1', mode: 'REVERSAL', reversalNo: 'JV-2' });
  assert.equal(by('LH').amount, null);
  assert.deepEqual(by('LH').data, { status: 'failed', closedAfterReview: true, fromStatus: 'review' });
  assert.deepEqual(by('LD').data, { reason: 'OWNER_PURGE', cascade: true, purged: true, allocations: [{ invoiceNo: 'INV-1', restored: true }] });
});

// ═══ C7 — أرقام الفواتير الناقصة ═══

test('C7: توزيع السند وفاتورة بيع المرتجع في سطرٍ قديم بلا أرقام تُكمَّل عند القراءة بشركة الطالب — والمخزَّن لا يُمسّ', async () => {
  const stored = { allocations: [{ invoiceId: 'i1', amount: 50 }, { invoiceId: 'i-other', amount: 20 }, { invoiceId: 'i2', invoiceNo: 'KEEP', amount: 5 }] };
  const ret = { saleInvoiceId: 'i1', returnReason: 'NORMAL' };
  const { db, queries } = memDb({
    customer: [CUST],
    invoice: [{ id: 'i1', tenantId: T, number: 'INV-1' }, { id: 'i-other', tenantId: 't2', number: 'FOREIGN' }, { id: 'i2', tenantId: T, number: 'INV-2' }],
    customerActivity: [
      log('LR', '2026-11-26T10:00:00Z', 'RECEIPT_ISSUED', { refType: 'RECEIPT', refId: 'rc1', amount: 75, data: stored }),
      log('LT', '2026-11-26T09:00:00Z', 'RETURN_ISSUED', { refType: 'INVOICE', refId: 'ret1', amount: 10, data: ret }),
    ],
  });
  const p = await page({ db, customerScope: noScope });
  assert.deepEqual(p.items.find((x) => x.id === 'LR')!.data!.allocations, [
    { invoiceId: 'i1', amount: 50, invoiceNo: 'INV-1' }, { invoiceId: 'i-other', amount: 20 }, { invoiceId: 'i2', invoiceNo: 'KEEP', amount: 5 },
  ]);
  assert.equal(p.items.find((x) => x.id === 'LT')!.data!.originalInvoiceNo, 'INV-1');
  assert.deepEqual(stored.allocations[0], { invoiceId: 'i1', amount: 50 }, 'السطر المخزَّن كما هو');
  for (const q of queries.filter((x) => x.model === 'invoice' && x.args.where?.id?.in)) assert.equal(q.args.where.tenantId, T);
});

// ═══ C22 — معرّف المنفّذ ═══

test('C22: معرّف المنفّذ في الردّ للمندوب والإداري وحدهما — لا لأفعال المنصّة ولا المفتاح ولا العميل ولا النظام', async () => {
  const { db } = memDb({
    customer: [CUST],
    customerActivity: [
      log('L-r', '2026-11-26T10:00:00Z', 'CALL_LOGGED', { actorKind: 'REP', actorId: 'r1', actorName: 'أحمد' }),
      log('L-a', '2026-11-26T09:59:00Z', 'CUSTOMER_UPDATED', { actorKind: 'ADMIN', actorId: 'a1', actorName: 'سارة' }),
      log('L-o', '2026-11-26T09:58:00Z', 'CUSTOMER_UPDATED', { actorKind: 'OWNER', actorId: 'o1', actorName: null }),
      log('L-s', '2026-11-26T09:57:00Z', 'CUSTOMER_UPDATED', { actorKind: 'STAFF', actorId: 's1', actorName: 'موظف' }),
      log('L-k', '2026-11-26T09:56:00Z', 'CUSTOMER_UPDATED', { actorKind: 'API', actorId: 'k1', actorName: 'ERP' }),
      log('L-y', '2026-11-26T09:55:00Z', 'CUSTOMER_UPDATED', { actorKind: 'SYSTEM', actorId: null, actorName: null }),
    ],
  });
  const p = await page({ db, customerScope: noScope });
  const actor = (id: string) => p.items.find((x) => x.id === id)!.actor;
  assert.deepEqual(actor('L-r'), { kind: 'REP', name: 'أحمد', id: 'r1' });
  assert.deepEqual(actor('L-a'), { kind: 'ADMIN', name: 'سارة', id: 'a1' });
  assert.deepEqual(actor('L-o'), { kind: 'OWNER', name: null });
  assert.deepEqual(actor('L-s'), { kind: 'STAFF', name: null });
  assert.deepEqual(actor('L-k'), { kind: 'API', name: 'ERP' });
  assert.deepEqual(actor('L-y'), { kind: 'SYSTEM', name: null });
});

// ═══ C10 — قيد تصحيح ذمم العملاء ═══

test('C10: قيد تصحيح الحساب الرئيسي لذمم العملاء (C3) حدثٌ في سجلّ عميله بعد ترحيله وداخل معاملته — والعهدة والأمانات بلا عميل', () => {
  const src = read('routes', 'ledger', 'checks.ts');
  const at = src.indexOf("router.post('/checks/:key/control-adjustment'");
  const body = src.slice(at, src.indexOf('}));', at));
  const tx = body.indexOf('prisma.$transaction(async (tx) => {');
  const post = body.indexOf('const move = await postMove(tx, draft');
  const rec = body.indexOf('await recordLedgerJournalActivity(tx, {');
  assert.ok(tx > 0 && post > tx && rec > post, 'الحدث بعد الترحيل داخل المعاملة نفسها');
  assert.match(body.slice(post, rec), /if \(key === 'C3'\) \{\s*$/m, 'لذمم العملاء وحدها');
  assert.match(body.slice(rec, rec + 300), /action: 'LEDGER_JOURNAL_POSTED', meta: docActivityMeta\(req\)/);
});
