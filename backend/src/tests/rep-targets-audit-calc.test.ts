// «هدف الشهر» — إصلاحات مراجعة الحساب (نوفمبر ٢٠٢٦) في services/repTargets.ts، فوق Prisma مزيّف (بلا قاعدة بيانات):
//   • F2/F8: النسبة دون ١٠٠٪ ما لم يتحقق الهدف (round1 كان يرفع ٩٩٫٩٥٪ إلى ١٠٠)، وهدف التحصيل لأعلى بخانات العملة
//     — ولا يتجاوز الأساس (R3) فيبقى «تحصيل ١٠٠٪» ممكناً لأساسٍ بكسرٍ أدق من خانات العملة.
//   • F5: مرتجع المرحلة الأولى المرتبط بفاتورة بيعٍ آجلة (returnOfItemId) يُطرح من افتتاحيّها كإشعار المرحلة الثانية الدائن.
//   • F7/R6: العميل الجديد يُعدّ بـcreatedAt وحده في نافذة الشهر بتوقيت الشركة — تأريخه بلحظة الجهاز عند الكتابة لإعادة المندوب
//     دون اتصال (routes/customers.ts)، لا عند القراءة بـclientCreatedAt غير المصحَّح.
//   • C1: نطاق المستخدم (RepTargetDocScope) يصل كل استعلام مستندٍ في مسارات الإدارة، وغيابه يُبقي /mine كاملاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
// لا استيراد ساكن لـservices/repTargets: الاستيراد يُرفع قبل البديل فيحمّل عميل Prisma الحقيقي

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
let scripted: Record<string, (args: any) => unknown> = {};
const seen: Record<string, any[]> = {};
function defaultFor(method: string): unknown {
  if (method === 'aggregate') return { _sum: { total: null } };
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  return null;
}
const prismaFake = new Proxy({}, {
  get: (_t, model: string) => (model === 'then' ? undefined : new Proxy({}, {
    get: (_m, method: string) => async (args: unknown) => {
      const op = `${model}.${method}`;
      (seen[op] ??= []).push(args);
      const fn = scripted[op];
      return fn ? fn(args) : defaultFor(method);
    },
  })),
});
function reset(s: Record<string, (args: any) => unknown> = {}): void {
  for (const k of Object.keys(seen)) delete seen[k];
  scripted = s;
}
stub('config/database', { default: prismaFake });
/* eslint-disable @typescript-eslint/no-var-requires */
const svc = require('../services/repTargets') as typeof import('../services/repTargets');
const {
  ceilToDecimals, collectionFold, loadProgressContext, monthWindow, pctOf, repTargetViewOf, repTargetsMonth, targetProgress, withLinkedReturns,
} = svc;
type ProgressContext = import('../services/repTargets').ProgressContext;
type TargetLike = import('../services/repTargets').TargetLike;
type CollectionInvoiceRow = import('../services/repTargets').CollectionInvoiceRow;
type RepTargetRow = import('../services/repTargets').RepTargetRow;

const RIYADH = 'Asia/Riyadh';
const NOW = new Date('2026-11-10T10:00:00Z');
const NOV = monthWindow('2026-11', RIYADH, NOW); // [2026-10-31T21:00Z, 2026-11-30T21:00Z)
const OCT = monthWindow('2026-10', RIYADH, NOW); // [2026-09-30T21:00Z, 2026-10-31T21:00Z)
const CTX: ProgressContext = { monthNetSales: 0, productBase: new Map(), collection: { base: 0, collected: 0 } };
const target = (o: Partial<TargetLike>): TargetLike => ({
  kind: 'SALES_AMOUNT', targetValue: 10000, productId: null, unitFactor: 1, rewardKind: 'FIXED_AMOUNT', rewardValue: 500, ...o,
});

// ═══ F2/F8: النسبة وهدف التحصيل ═══

test('النسبة: دون ١٠٠٪ ما لم يتحقق الهدف (٩٩٫٩٥٪ فما فوق كانت تُعرض ١٠٠)، و١٠٠ عند البلوغ، وبلا سقفٍ فوقه', () => {
  assert.equal(pctOf(19990, 20000), 99.9, '٩٩٫٩٥٪ لم يتحقق');
  assert.equal(pctOf(4998, 5000), 99.9);
  assert.equal(pctOf(9996, 10000), 99.9);
  assert.equal(pctOf(1999, 2000), 99.9);
  assert.equal(pctOf(199, 200), 99.5, 'ما دون ٩٩٫٩٥ كما هو');
  assert.equal(pctOf(20000, 20000), 100);
  assert.equal(pctOf(20000 - 1e-7, 20000), 100, 'هامش التحقق نفسه (isDone): المحقَّق ١٠٠');
  assert.equal(pctOf(25000, 20000), 125, 'بلا سقف');
  assert.equal(pctOf(0.29, 1), 29, 'لا Math.floor: غبار العائمة لا يُنقص المنزلة');
  assert.equal(pctOf(5, 0), null);
  // كل الأنواع تمرّ بها: المبيعات والكمية والزيارات
  assert.deepEqual(targetProgress(target({}), { ...CTX, monthNetSales: 9996 }), { state: 'OK', achieved: 9996, goal: 10000, pct: 99.9, done: false });
  assert.deepEqual(targetProgress(target({ kind: 'PRODUCT_QTY', productId: 'p1', unitFactor: 1, targetValue: 5000 }), { ...CTX, productBase: new Map([['p1', 4998]]) }),
    { state: 'OK', achieved: 4998, goal: 5000, pct: 99.9, done: false });
  assert.deepEqual(targetProgress(target({ kind: 'VISITS_COUNT', targetValue: 2000 }), { ...CTX, visits: 1999 }),
    { state: 'OK', achieved: 1999, goal: 2000, pct: 99.9, done: false });
});

test('التقريب لأعلى بخانات العملة: الغبار لا يرفع رقماً تامّاً، وكسرٌ دون الخانة يرفعها خانة', () => {
  assert.equal(ceilToDecimals(166.665, 2), 166.67);
  assert.equal(ceilToDecimals(370.371, 2), 370.38);
  assert.equal(ceilToDecimals(400, 2), 400);
  assert.equal(ceilToDecimals(0.1 + 0.2, 2), 0.3, '0.30000000000000004 ليست فوق ٠٫٣');
  assert.equal(ceilToDecimals(1.005, 2), 1.01);
  assert.equal(ceilToDecimals(166.6665, 3), 166.667, 'الدينار الكويتي ثلاث خانات');
  assert.equal(ceilToDecimals(500.5, 0), 501, 'الدينار العراقي بلا خانات');
  assert.equal(ceilToDecimals(0, 2), 0);
  assert.equal(Object.is(ceilToDecimals(-0.001, 2), -0), false, 'لا ‎-0');
});

test('هدف التحصيل: لأعلى بخانات العملة فمن حصّل المعروض حقّقه، والنسبة دون ١٠٠ قبله، ونسبة المحصَّل من الأساس كذلك', () => {
  // ٥٠٪ من ٣٣٣٫٣٣ = ١٦٦٫٦٦٥ ⇒ ١٦٦٫٦٧
  const half = target({ kind: 'COLLECTION_PCT', targetValue: 50 });
  assert.deepEqual(targetProgress(half, { ...CTX, collection: { base: 333.33, collected: 166.66 } }),
    { state: 'OK', achieved: 166.66, goal: 166.67, pct: 99.9, done: false, base: 333.33, collectedPct: 50 });
  assert.deepEqual(targetProgress(half, { ...CTX, collection: { base: 333.33, collected: 166.67 } }),
    { state: 'OK', achieved: 166.67, goal: 166.67, pct: 100, done: true, base: 333.33, collectedPct: 50 });
  // ٣٠٪ من ١٢٣٤٫٥٧ = ٣٧٠٫٣٧١ ⇒ ٣٧٠٫٣٨: من حصّل ٣٧٠٫٣٧ لم يبلغ ٣٠٪ ولا يرى «٣٧٠٫٣٧ / ٣٧٠٫٣٧»
  const p = targetProgress(target({ kind: 'COLLECTION_PCT', targetValue: 30 }), { ...CTX, collection: { base: 1234.57, collected: 370.37 } });
  assert.deepEqual([p.goal, p.pct, p.done], [370.38, 99.9, false]);
  // خانات الشركة: ثلاث للدينار الكويتي، وصفر للعراقي، والغائب خانتان
  const kwd = targetProgress(half, { ...CTX, collection: { base: 333.333, collected: 166.667 }, currencyDecimals: 3 });
  assert.deepEqual([kwd.goal, kwd.done], [166.667, true]);
  const iqd = targetProgress(half, { ...CTX, collection: { base: 1001, collected: 500 }, currencyDecimals: 0 });
  assert.deepEqual([iqd.goal, iqd.pct, iqd.done], [501, 99.8, false]);
  // هدفٌ تامّ بلا تقريب: كما كان
  assert.deepEqual(targetProgress(half, { ...CTX, collection: { base: 800, collected: 400 } }),
    { state: 'OK', achieved: 400, goal: 400, pct: 100, done: true, base: 800, collectedPct: 50 });
  // نسبة المحصَّل من الأساس: ٩٩٩٫٩٩ من ١٠٠٠ ليست ١٠٠٪
  const full = target({ kind: 'COLLECTION_PCT', targetValue: 100 });
  assert.deepEqual(targetProgress(full, { ...CTX, collection: { base: 1000, collected: 999.99 } }),
    { state: 'OK', achieved: 999.99, goal: 1000, pct: 99.9, done: false, base: 1000, collectedPct: 99.9 });
  assert.equal(targetProgress(full, { ...CTX, collection: { base: 1000, collected: 1000 } }).collectedPct, 100);
  // بلا ديون: NO_BASE كما كان
  assert.deepEqual(targetProgress(half, CTX), { state: 'NO_BASE', achieved: 0, goal: 0, pct: null, done: false, base: 0, collectedPct: null });
});

test('هدف التحصيل لا يتجاوز الأساس (R3): كسرٌ أدق من خانات العملة لا يرفع «تحصيل ١٠٠٪» فوق الدين فيستحيل', () => {
  const full = target({ kind: 'COLLECTION_PCT', targetValue: 100 });
  // سند ١٠٠٠٫٥ بالدينار العراقي (بلا خانات) ⇒ الأساس ٩٩٩٫٥: كان الهدف ١٠٠٠ فمن حصّل الدين كله رأى ٩٩٫٩٪ بلا تحقق ولا مكافأة
  assert.deepEqual(targetProgress(full, { ...CTX, collection: { base: 999.5, collected: 999.5 }, currencyDecimals: 0 }),
    { state: 'OK', achieved: 999.5, goal: 999.5, pct: 100, done: true, base: 999.5, collectedPct: 100 });
  assert.deepEqual(targetProgress(full, { ...CTX, collection: { base: 999.5, collected: 999 }, currencyDecimals: 0 }),
    { state: 'OK', achieved: 999, goal: 999.5, pct: 99.9, done: false, base: 999.5, collectedPct: 99.9 });
  // ثلاث خانات بالريال عبر API (خانتان): ١٠٠٠٫٠٠٥ لا ١٠٠٠٫٠١
  assert.deepEqual(targetProgress(full, { ...CTX, collection: { base: 1000.005, collected: 1000.005 } }),
    { state: 'OK', achieved: 1000.005, goal: 1000.005, pct: 100, done: true, base: 1000.005, collectedPct: 100 });
  // ما دون الأساس يبقى لأعلى كما هو: ٥٠٪ من ٩٩٩٫٥ = ٤٩٩٫٧٥ ⇒ ٥٠٠ — ونسبةٌ يتجاوز تقريبها الأساس تُقصر عليه: ٩٩٫٩٩٪ ⇒ ٩٩٩٫٥ لا ١٠٠٠
  const iqd = (v: number) => targetProgress(target({ kind: 'COLLECTION_PCT', targetValue: v }), { ...CTX, collection: { base: 999.5, collected: 0 }, currencyDecimals: 0 });
  assert.deepEqual([iqd(50).goal, iqd(99.99).goal], [500, 999.5]);
  // الحدّ: لكل أساسٍ ونسبةٍ وخانات الهدف ≤ الأساس، فمن حصّل الدين كله (والمحصَّل لا يفوقه) حقّق أيّ هدف تحصيل
  for (const base of [999.5, 1000.005, 333.333, 0.5, 1234.5678, 800]) {
    for (const currencyDecimals of [0, 2, 3]) {
      for (const v of [1, 33, 50, 99.99, 100]) {
        const p = targetProgress(target({ kind: 'COLLECTION_PCT', targetValue: v }), { ...CTX, collection: { base, collected: base }, currencyDecimals });
        assert.ok(p.goal <= base, `${v}% من ${base} بـ${currencyDecimals} خانات: ${p.goal}`);
        assert.deepEqual([p.done, p.collectedPct], [true, 100], `${v}% من ${base} بـ${currencyDecimals} خانات`);
      }
    }
  }
  // بلا ديون: صفرٌ كما كان
  assert.equal(targetProgress(full, { ...CTX, currencyDecimals: 0 }).goal, 0);
});

// ═══ F5: مرتجع المرحلة الأولى المرتبط ═══

const S = NOV.from;
const E = NOV.to;
const BEFORE = new Date('2026-10-20T09:00:00Z');
const DURING = new Date('2026-11-05T09:00:00Z');
type CreditRow = CollectionInvoiceRow & { id: string; items: { id: string }[] };
const credit = (o: Partial<CreditRow> & { id: string }): CreditRow => ({ total: 0, receiptItems: [], adjustments: [], items: [], ...o });
const ret = (returnOfItemId: string | null, id: string, total: number) => ({ returnOfItemId, invoice: { id, total, status: 'CONFIRMED', type: 'RETURN' } });

test('مرتجع المرحلة الأولى المرتبط يُطرح من افتتاحيّ فاتورة بيعه كإشعار المرحلة الثانية: ١٠٠٠ − ٣٠٠ = ٧٠٠ يُحصَّل كله ١٠٠٪', () => {
  const A = credit({ id: 'A', total: 1000, items: [{ id: 'a1' }, { id: 'a2' }], receiptItems: [{ amount: 700, receipt: { receiptDate: DURING, status: 'ACTIVE' } }] });
  // قبل الإصلاح: الأساس ١٠٠٠ والمحصَّل ٧٠٠ (٧٠٪) والعميل لا يدين إلا بـ٧٠٠
  assert.deepEqual(collectionFold([A], S, E), { base: 1000, collected: 700 });
  const phase1 = collectionFold(withLinkedReturns([A], [ret('a1', 'r1', 300)]), S, E);
  assert.deepEqual(phase1, { base: 700, collected: 700 });
  // والحدث نفسه إشعاراً دائناً في المرحلة الثانية يعطي الرقم نفسه
  const phase2 = collectionFold([{ ...A, adjustments: [{ id: 'cn1', total: 300, status: 'CONFIRMED', type: 'RETURN' }] }], S, E);
  assert.deepEqual(phase2, phase1);
  const p = targetProgress(target({ kind: 'COLLECTION_PCT', targetValue: 100 }), { ...CTX, collection: phase1 });
  assert.deepEqual([p.goal, p.pct, p.done], [700, 100, true]);
});

test('ربط المرتجع: كل مرتجعٍ مرةً واحدة بإجماليه على فاتورة بيعه، ولا يتكرّر ما قُرئ إشعاراً، والغريب يُهمل، وصرفةٌ لا تعدّل مدخلاتها', () => {
  const A = credit({ id: 'A', total: 1000, items: [{ id: 'a1' }, { id: 'a2' }] });
  const B = credit({ id: 'B', total: 500, items: [{ id: 'b1' }], adjustments: [{ id: 'r9', total: 100, status: 'CONFIRMED', type: 'RETURN' }] });
  const C = credit({ id: 'C', total: 200 }); // بلا بنود مقروءة (صفٌّ قديم أو مزيّف) — كما هو
  const rows = [A, B, C];
  const before = JSON.stringify(rows);
  const out = withLinkedReturns(rows, [
    ret('a1', 'r1', 300), ret('a2', 'r1', 300), // مرتجعٌ واحد ببندين على بندي البيع: يُطرح مرة
    ret('b1', 'r9', 100), // قُرئ إشعاراً على B: لا يُطرح مرتين
    ret('x9', 'r5', 50), // بند بيعٍ ليس في المرشَّحة
    ret(null, 'r6', 70),
    ret('b1', 'r1', 300), // المرتجع نفسه على فاتورةٍ ثانية (لا يقع): يُنسب للأولى وحدها
  ]);
  assert.equal(JSON.stringify(rows), before, 'لا يعدّل الصفوف المدخلة');
  assert.deepEqual(out[0].adjustments, [{ id: 'r1', total: 300, status: 'CONFIRMED', type: 'RETURN' }]);
  assert.deepEqual(out[1].adjustments, B.adjustments);
  assert.equal(out[2], C, 'بلا تغيير: الصفّ نفسه');
  assert.deepEqual(collectionFold(out, S, E), { base: 700 + 400 + 200, collected: 0 });
  assert.deepEqual(withLinkedReturns(rows, []), rows);
});

// ═══ المحمّل: الاستعلامات ═══

const TENANT = 'T1';
const REP = 'r1';
const ALL_KINDS = [
  { kind: 'SALES_AMOUNT', productId: null }, { kind: 'PRODUCT_QTY', productId: 'p1' }, { kind: 'COLLECTION_PCT', productId: null },
  { kind: 'VISITS_COUNT', productId: null }, { kind: 'NEW_CUSTOMERS', productId: null },
] as const;
const TEAM_AND = [{ team: { supervisors: { some: { adminId: 'sup-1' } } } }];
const SCOPE = {
  doc: { AND: TEAM_AND },
  visit: { AND: TEAM_AND },
  customer: { adminScopes: { some: { adminId: 'lists-1' } } },
};
const productItemsCall = () => (seen['invoiceItem.findMany'] ?? []).find((a) => a.where.productId);
const linkedCall = () => (seen['invoiceItem.findMany'] ?? []).find((a) => a.where.returnOfItemId);
/** صفّ هدفٍ كما يقرؤه المحمّل من القاعدة */
const row = (o: Partial<RepTargetRow> = {}): RepTargetRow => ({
  id: 't1', tenantId: TENANT, salesRepId: REP, month: '2026-11', kind: 'SALES_AMOUNT', targetValue: 1000,
  productId: null, productName: null, unitId: null, unitName: null, unitFactor: 1, comboId: null,
  rewardKind: 'FIXED_AMOUNT', rewardValue: 10, note: null, createdById: null, createdByName: null, createdAt: NOW, updatedAt: NOW, ...o,
});

test('المحمّل — مرتجع المرحلة الأولى: استعلامٌ واحد ببنود الآجلة المرشَّحة ومرتجعٍ مؤكَّد قبل الشهر، ويُطرح من الأساس — ولا استعلام بلا بنود', async () => {
  reset({
    'invoice.findMany': () => [
      { id: 'A', total: 1000, items: [{ id: 'a1' }, { id: 'a2' }], receiptItems: [{ amount: 700, receipt: { receiptDate: DURING, status: 'ACTIVE' } }], adjustments: [] },
      { id: 'B', total: 500, items: [{ id: 'b1' }], receiptItems: [{ amount: 50, receipt: { receiptDate: BEFORE, status: 'ACTIVE' } }], adjustments: [{ id: 'cn1', total: 100, status: 'CONFIRMED', type: 'RETURN' }] },
    ],
    'invoiceItem.findMany': (a) => (a.where.returnOfItemId ? [ret('a1', 'r1', 300), ret('a2', 'r1', 300)] : []),
  });
  const ctx = await loadProgressContext(TENANT, REP, NOV, [{ kind: 'COLLECTION_PCT', productId: null }]);
  assert.deepEqual(ctx.collection, { base: 700 + 350, collected: 700 });
  const lw = linkedCall().where;
  assert.deepEqual(lw.returnOfItemId, { in: ['a1', 'a2', 'b1'] });
  assert.deepEqual([lw.invoice.tenantId, lw.invoice.status, lw.invoice.type, lw.invoice.invoiceDate.lt.toISOString()], [TENANT, 'CONFIRMED', 'RETURN', NOV.from.toISOString()]);
  assert.deepEqual(linkedCall().select, { returnOfItemId: true, invoice: { select: { id: true, total: true, status: true, type: true } } });
  // الآجلة تُقرأ بمعرّفها وبنودها ومعرّف إشعاراتها
  const cs = seen['invoice.findMany'][0].select;
  assert.deepEqual([cs.id, cs.items, cs.adjustments.select.id], [true, { select: { id: true } }, true]);
  // خانات العملة من الشركة (الغائبة ⇒ عملة السعودية خانتان)
  assert.equal(ctx.currencyDecimals, 2);
  // لا آجلة مرشَّحة ⇒ لا استعلام مرتجعات
  reset();
  assert.deepEqual((await loadProgressContext(TENANT, REP, NOV, [{ kind: 'COLLECTION_PCT', productId: null }])).collection, { base: 0, collected: 0 });
  assert.equal(seen['invoiceItem.findMany'], undefined);
});

test('المحمّل — البند ١١ (مرتجعٌ يُسقط من متبقّي الآجلة): آجلةٌ مفتوحة أول الشهر أرجعها العميل في الشهر تبقى في الأساس بافتتاحيّها', async () => {
  // S: آجلة ١٠٠٠ قبل الشهر بلا سداد، أرجعها العميل كلها في الشهر بمرتجعٍ مرتبط ⇒ متبقّيها اليوم صفر ولا سند ولا إشعار عليها.
  // قبل البند ١١ كان متبقّيها ١٠٠٠ فتُرشَّح بافتتاحي ١٠٠٠؛ ولو سقطت لارتفعت نسبة التحصيل وتغيّر شهرٌ مضى بأثر رجعي
  // P: آجلة ١٠٠٠ سُدّد منها ٦٠٠ قبل الشهر وأُرجع باقيها ٤٠٠ في الشهر ⇒ افتتاحيّها ٤٠٠ كما كان
  const rows = [
    { id: 'S', total: 1000, remainingAmt: 0, items: [{ id: 's1' }], receiptItems: [], adjustments: [] },
    { id: 'P', total: 1000, remainingAmt: 0, items: [{ id: 'p1' }], receiptItems: [{ amount: 600, receipt: { receiptDate: BEFORE, status: 'ACTIVE' } }], adjustments: [] },
  ];
  // القاعدة المزيّفة تطبّق OR الترشيح كما هو: متبقٍّ موجب، أو بند بيعٍ أسقط مرتجعٌ منذ بداية الشهر من متبقّي فاتورته
  const candidates = (a: any) => rows.filter((r) => a.where.OR.some((b: any) =>
    (b.remainingAmt && r.remainingAmt > b.remainingAmt.gt) || (b.items && r.items.some((i) => b.items.some.id.in.includes(i.id)))));
  reset({ 'invoiceItem.groupBy': () => [{ returnOfItemId: 's1' }, { returnOfItemId: 'p1' }], 'invoice.findMany': candidates });
  const ctx = await loadProgressContext(TENANT, REP, NOV, [{ kind: 'COLLECTION_PCT', productId: null }]);
  assert.deepEqual(ctx.collection, { base: 1000 + 400, collected: 0 });
  const gw = seen['invoiceItem.groupBy'][0];
  assert.deepEqual(gw.by, ['returnOfItemId']);
  assert.deepEqual(gw.where.returnOfItemId, { not: null });
  const ri = gw.where.invoice;
  assert.deepEqual([ri.tenantId, ri.status, ri.type, ri.remainingApplied, ri.invoiceDate.gte.toISOString()],
    [TENANT, 'CONFIRMED', 'RETURN', { gt: 0 }, NOV.from.toISOString()], 'ما أسقط من المتبقّي منذ بداية الشهر وحده، بلا حدٍّ أعلى كفرع السندات');
  assert.equal('lt' in ri.invoiceDate, false);
  assert.deepEqual(seen['invoice.findMany'][0].where.OR.at(-1), { items: { some: { id: { in: ['s1', 'p1'] } } } });
  // بلا مرتجعٍ أسقط شيئاً: فروع OR الثلاثة كما كانت، والآجلة بمتبقٍّ صفر خارج الأساس
  reset({ 'invoice.findMany': candidates });
  assert.deepEqual((await loadProgressContext(TENANT, REP, NOV, [{ kind: 'COLLECTION_PCT', productId: null }])).collection, { base: 0, collected: 0 });
  assert.equal(seen['invoice.findMany'][0].where.OR.length, 3);
  // وبلا هدف تحصيل لا استعلام له
  reset();
  await loadProgressContext(TENANT, REP, NOV, [{ kind: 'SALES_AMOUNT', productId: null }]);
  assert.equal(seen['invoiceItem.groupBy'], undefined);
});

test('المحمّل — خانات العملة: عملة الشركة (الكويتي ثلاث والعراقي صفر)، وبلا هدف تحصيل لا قراءة للشركة', async () => {
  const credit1 = () => [{ id: 'A', total: 333.333, items: [], receiptItems: [], adjustments: [] }];
  reset({ 'invoice.findMany': credit1, 'companySettings.findUnique': () => ({ currency: 'KWD', countryCode: 'KW' }) });
  const kw = await loadProgressContext(TENANT, REP, NOV, [{ kind: 'COLLECTION_PCT', productId: null }]);
  assert.equal(kw.currencyDecimals, 3);
  assert.equal(targetProgress(target({ kind: 'COLLECTION_PCT', targetValue: 50 }), kw).goal, 166.667);
  assert.deepEqual(seen['companySettings.findUnique'][0], { where: { tenantId: TENANT }, select: { currency: true, countryCode: true } });
  reset({ 'invoice.findMany': credit1, 'companySettings.findUnique': () => ({ currency: 'IQD', countryCode: 'IQ' }) });
  assert.equal((await loadProgressContext(TENANT, REP, NOV, [{ kind: 'COLLECTION_PCT', productId: null }])).currencyDecimals, 0);
  // R3 من أوله لآخره: فاتورة ٢٠٠٠ دينار عراقي سُدّد منها ١٠٠٠٫٥ قبل الشهر وحُصّل باقيها ٩٩٩٫٥ فيه ⇒ «تحصيل ١٠٠٪» محقَّق
  reset({
    'invoice.findMany': () => [{
      id: 'A', total: 2000, items: [], adjustments: [],
      receiptItems: [{ amount: 1000.5, receipt: { receiptDate: BEFORE, status: 'ACTIVE' } }, { amount: 999.5, receipt: { receiptDate: DURING, status: 'ACTIVE' } }],
    }],
    'companySettings.findUnique': () => ({ currency: 'IQD', countryCode: 'IQ' }),
  });
  const iq = await loadProgressContext(TENANT, REP, NOV, [{ kind: 'COLLECTION_PCT', productId: null }]);
  assert.deepEqual([iq.collection, iq.currencyDecimals], [{ base: 999.5, collected: 999.5 }, 0]);
  const p = targetProgress(target({ kind: 'COLLECTION_PCT', targetValue: 100 }), iq);
  assert.deepEqual([p.goal, p.pct, p.done], [999.5, 100, true]);
  // بلا هدف تحصيل (ولا العملاء الجدد: لا يحتاجون الشركة بعد اليوم) لا قراءة لها
  for (const kind of ['SALES_AMOUNT', 'NEW_CUSTOMERS'] as const) {
    reset();
    const plain = await loadProgressContext(TENANT, REP, NOV, [{ kind, productId: null }]);
    assert.equal(seen['companySettings.findUnique'], undefined, kind);
    assert.equal('currencyDecimals' in plain, false, kind);
  }
});

test('المحمّل — العملاء الجدد (R6): عدٌّ واحد بـcreatedAt في نافذة الشهر بتوقيت الشركة بشرط «نشط»، بلا لحظة الجهاز عند القراءة', async () => {
  reset({ 'customer.count': () => 4 });
  const oct = await loadProgressContext(TENANT, REP, OCT, [{ kind: 'NEW_CUSTOMERS', productId: null }]);
  assert.equal(oct.newCustomers, 4, 'عدّ القاعدة كما هو بلا تصحيح');
  assert.equal(seen['customer.count'].length, 1);
  const cw = seen['customer.count'][0].where;
  assert.deepEqual(Object.keys(cw).sort(), ['createdAt', 'createdBySalesRepId', 'invoices', 'status', 'tenantId']);
  assert.deepEqual([cw.tenantId, cw.createdBySalesRepId, cw.status, cw.createdAt.gte.toISOString(), cw.createdAt.lt.toISOString()],
    [TENANT, REP, { not: 'DELETED' }, OCT.from.toISOString(), OCT.to.toISOString()]);
  // «نشط»: له فاتورة بيعٍ مؤكَّدة حتى نهاية الشهر (لا يُعدّ عميلٌ أُضيف ولم يشترِ)
  assert.deepEqual(cw.invoices, { some: { status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: { lt: OCT.to } } });
  // لا صفوف حافّتين ولا clientCreatedAt: التأريخ بلحظة الجهاز يُكتب في createdAt عند الإنشاء (routes/customers.ts)
  assert.equal(seen['customer.findMany'], undefined);
  assert.equal(JSON.stringify(seen['customer.count'][0]).includes('clientCreatedAt'), false);
  // نافذة الشهر بتوقيت الشركة لا الخادم: دبي (+٤) ⇒ أكتوبر من ٢٠:٠٠ آخر سبتمبر UTC إلى ٢٠:٠٠ آخر أكتوبر
  reset({
    'glSettings.findUnique': () => ({ timezone: 'Asia/Dubai' }),
    'repTarget.findMany': () => [row({ month: '2026-10', kind: 'NEW_CUSTOMERS', targetValue: 2 })],
    'customer.count': () => 2,
  });
  const m = await repTargetsMonth(TENANT, REP, '2026-10', NOW);
  const dw = seen['customer.count'][0].where.createdAt;
  assert.deepEqual([dw.gte.toISOString(), dw.lt.toISOString()], ['2026-09-30T20:00:00.000Z', '2026-10-31T20:00:00.000Z']);
  assert.deepEqual([m.targets[0].progress.achieved, m.targets[0].progress.done], [2, true]);
});

// ═══ C1: نطاق المستند ═══

test('النطاق: يصل كل استعلام مستند (البيع والمرتجع، وبنود الكمية، والآجلة، والزيارات، والعملاء الجدد وبيعهم) ولا يمحو OR المحمّل', async () => {
  reset({ 'invoice.findMany': () => [{ id: 'A', total: 100, items: [{ id: 'a1' }], receiptItems: [], adjustments: [] }] });
  await loadProgressContext(TENANT, REP, NOV, ALL_KINDS, SCOPE);
  for (const w of seen['invoice.aggregate'].map((a) => a.where)) {
    assert.deepEqual([w.tenantId, w.salesRepId, w.status, w.AND], [TENANT, REP, 'CONFIRMED', TEAM_AND]);
  }
  assert.deepEqual(seen['invoice.aggregate'].map((a) => a.where.type), [{ not: 'RETURN' }, 'RETURN']);
  assert.deepEqual(productItemsCall().where.invoice.AND, TEAM_AND);
  const cw = seen['invoice.findMany'][0];
  assert.deepEqual(cw.where.AND, TEAM_AND);
  assert.equal(cw.where.OR.length, 3, 'OR الآجلة باقٍ');
  // سدادها وإشعاراتها ومرتجعاتها بلا نطاق: الدين دين الفاتورة (قصّها يضخّم الأساس)
  assert.equal('AND' in cw.select.receiptItems.where.receipt, false);
  assert.equal('AND' in cw.select.adjustments.where, false);
  assert.equal('AND' in linkedCall().where.invoice, false);
  assert.deepEqual(seen['repVisit.findMany'][0].where.AND, TEAM_AND);
  const nw = seen['customer.count'][0].where;
  assert.deepEqual(nw.adminScopes, SCOPE.customer.adminScopes);
  assert.deepEqual(nw.invoices.some.AND, TEAM_AND, 'بيع العميل الجديد في النطاق');
  assert.deepEqual([nw.invoices.some.status, nw.invoices.some.type], ['CONFIRMED', { not: 'RETURN' }]);
  assert.deepEqual([nw.createdAt.gte, nw.createdAt.lt], [NOV.from, NOV.to], 'نافذة createdAt باقية مع النطاق');
  // بلا نطاق (/mine) أو نطاقٍ فارغ (المدير غير المقيَّد): لا قيد
  for (const scope of [undefined, null, {}, { doc: {}, visit: {}, customer: {} }]) {
    reset({ 'invoice.findMany': () => [{ id: 'A', total: 100, items: [{ id: 'a1' }], receiptItems: [], adjustments: [] }] });
    await loadProgressContext(TENANT, REP, NOV, ALL_KINDS, scope);
    const wheres = [
      ...seen['invoice.aggregate'].map((a) => a.where), productItemsCall().where.invoice, seen['invoice.findMany'][0].where,
      seen['repVisit.findMany'][0].where, seen['customer.count'][0].where, seen['customer.count'][0].where.invoices.some,
    ];
    for (const w of wheres) assert.deepEqual([('AND' in w), ('adminScopes' in w)], [false, false], JSON.stringify(scope));
  }
});

test('النطاق يمرّ في repTargetsMonth وrepTargetViewOf (المستقل والعضو المدمج)، وتوقيعهما السابق كما هو', async () => {
  const scripts = (rows: RepTargetRow[]) => ({
    'repTarget.findMany': () => rows,
    'invoice.aggregate': (a: any) => ({ _sum: { total: a.where.type === 'RETURN' ? 0 : 999.95 } }),
  });
  reset(scripts([row()]));
  const m = await repTargetsMonth(TENANT, REP, '2026-11', NOW, SCOPE);
  assert.deepEqual(seen['invoice.aggregate'][0].where.AND, TEAM_AND);
  // ٩٩٩٫٩٥ من ١٠٠٠: دون ١٠٠٪ بلا تحقق
  assert.deepEqual([m.targets[0].progress.pct, m.targets[0].progress.done], [99.9, false]);
  reset(scripts([row()]));
  await repTargetsMonth(TENANT, REP, '2026-11', NOW);
  assert.equal('AND' in seen['invoice.aggregate'][0].where, false, '/mine بلا نطاق');
  // ردّ الإنشاء والتعديل: المستقل مباشرةً، والعضو المدمج من شهره
  reset(scripts([row()]));
  await repTargetViewOf(TENANT, row(), NOW, SCOPE);
  assert.deepEqual(seen['invoice.aggregate'][0].where.AND, TEAM_AND);
  const combo = [row({ id: 'a', comboId: 'k' }), row({ id: 'b', comboId: 'k' })];
  reset(scripts(combo));
  const v = await repTargetViewOf(TENANT, combo[0], NOW, SCOPE);
  assert.equal(v.id, 'a');
  assert.equal(seen['repTarget.findMany'].length, 1, 'من شهره');
  assert.deepEqual(seen['invoice.aggregate'][0].where.AND, TEAM_AND);
});
