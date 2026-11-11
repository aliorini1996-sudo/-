// «هدف الشهر» (طلب المالك ٩ نوفمبر ٢٠٢٦) — الطيّات الصرفة في services/repTargets.ts بلا قاعدة بيانات:
//   • نافذة الشهر بتوقيت الشركة (لا الخادم ولا الجهاز) والأيام الباقية.
//   • صافي كمية الصنف بالأساس (المرتجع يُطرح، والصفّ القديم بلا baseQty من لقطته).
//   • تحصيل الديون السابقة: الافتتاحي لكل فاتورة، والمحصَّل في الشهر مقصوصاً عليه، والسند الملغى والإشعار الدائن.
//   • التقدّم (النسبة بلا سقف، والتحقّق بهامش)، والمكافأة بأنواعها الثلاثة، وشكل العرض كما في العقد.
//   • (١١ نوفمبر ٢٠٢٦) عدد الزيارات والعملاء الجدد، وهدف الكمية بعدة أصناف (المجموع كلٌّ بمعامل وحدته، والمحذوف لا يُعدّ)،
//     و«دمج الأهداف» (applyCombos): مكافأة العضو تُستحق بتحقّق الأعضاء كلهم.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_EPS, MAX_TARGET_PRODUCTS, MAX_TARGETS_PER_MONTH, MONTH_RE, REWARD_KINDS, REWARD_VALUE_MAX, TARGET_KINDS, TARGET_MESSAGES, TARGET_VALUE_MAX,
  applyCombos, collectionFold, currentMonthOf, monthWindow, pctOf, productNetBaseQty, round1, targetProgress, targetReward, toTargetView,
  type CollectionInvoiceRow, type ProgressContext, type RepTargetRow, type TargetLike,
} from '../services/repTargets';

const RIYADH = 'Asia/Riyadh';

test('نافذة الشهر بتوقيت الشركة: منتصف ليل أوله إلى منتصف ليل التالي، والجاري بأيامه الباقية مع اليوم', () => {
  const now = new Date('2026-11-10T10:00:00Z'); // ١٠ نوفمبر بالرياض
  const w = monthWindow('2026-11', RIYADH, now);
  assert.equal(w.from.toISOString(), '2026-10-31T21:00:00.000Z', 'أول نوفمبر 00:00 بالرياض');
  assert.equal(w.to.toISOString(), '2026-11-30T21:00:00.000Z', 'أول ديسمبر 00:00 بالرياض');
  assert.equal(w.isCurrent, true);
  assert.equal(w.daysLeft, 21, '٣٠ − ١٠ + ١ (اليوم يُعدّ)');
  // الماضي صفر، والمقبل أيام الشهر كلها (فبراير ٢٠٢٧ ليس كبيساً، و٢٠٢٨ كبيس)
  assert.deepEqual([monthWindow('2026-10', RIYADH, now).daysLeft, monthWindow('2026-10', RIYADH, now).isCurrent], [0, false]);
  assert.equal(monthWindow('2027-02', RIYADH, now).daysLeft, 28);
  assert.equal(monthWindow('2028-02', RIYADH, now).daysLeft, 29);
  // حدود السنة: ديسمبر ينتهي أول يناير التالي
  assert.equal(monthWindow('2026-12', RIYADH, now).to.toISOString(), '2026-12-31T21:00:00.000Z');
  // آخر ساعة في نوفمبر بتوقيت UTC هي أول ديسمبر بالرياض: الشهر الجاري بتوقيت الشركة لا الخادم
  const late = new Date('2026-11-30T22:00:00Z');
  assert.equal(currentMonthOf(late, RIYADH), '2026-12');
  assert.equal(currentMonthOf(late, 'UTC'), '2026-11');
  assert.deepEqual([monthWindow('2026-11', RIYADH, late).isCurrent, monthWindow('2026-11', RIYADH, late).daysLeft], [false, 0]);
  assert.equal(monthWindow('2026-12', RIYADH, late).daysLeft, 31, 'أول ديسمبر: الشهر كله باقٍ');
  // منطقةٌ أخرى تُزيح الحدود بإزاحتها
  assert.equal(monthWindow('2026-11', 'Africa/Cairo', now).from.toISOString(), '2026-10-31T22:00:00.000Z');
});

test('الثوابت: الأنواع والحدود والرموز كما في العقد، وصيغة الشهر', () => {
  assert.deepEqual([...TARGET_KINDS], ['SALES_AMOUNT', 'PRODUCT_QTY', 'COLLECTION_PCT', 'VISITS_COUNT', 'NEW_CUSTOMERS']);
  assert.deepEqual([...REWARD_KINDS], ['COMMISSION_SALES_PCT', 'SALARY_PCT', 'FIXED_AMOUNT']);
  assert.deepEqual(TARGET_VALUE_MAX, { SALES_AMOUNT: 1e12, PRODUCT_QTY: 1e9, COLLECTION_PCT: 100, VISITS_COUNT: 1e6, NEW_CUSTOMERS: 1e6 });
  assert.deepEqual(REWARD_VALUE_MAX, { COMMISSION_SALES_PCT: 100, SALARY_PCT: 1000, FIXED_AMOUNT: 1e9 });
  assert.equal(MAX_TARGETS_PER_MONTH, 20);
  assert.equal(MAX_TARGET_PRODUCTS, 20);
  assert.equal(TARGET_MESSAGES.TARGET_LIMIT, 'وصلت للحد الأعلى من الأهداف لهذا الشهر (20)');
  assert.deepEqual(Object.keys(TARGET_MESSAGES).sort(), [
    'REP_NOT_FOUND', 'TARGET_COMBO_INVALID', 'TARGET_IN_COMBO', 'TARGET_LIMIT', 'TARGET_NOT_FOUND', 'TARGET_PRODUCT_DUPLICATE', 'TARGET_PRODUCT_INVALID',
    'TARGET_UNIT_INVALID',
  ]);
  assert.equal(TARGET_MESSAGES.TARGET_PRODUCT_DUPLICATE, 'الصنف مكرر في الهدف');
  assert.equal(TARGET_MESSAGES.TARGET_COMBO_INVALID, 'اختر هدفين أو أكثر لنفس المندوب في نفس الشهر');
  assert.equal(TARGET_MESSAGES.TARGET_IN_COMBO, 'أحد الأهداف مدمج مع أهداف أخرى افصله أولا');
  for (const ok of ['2026-01', '2026-12', '1999-09']) assert.match(ok, MONTH_RE);
  for (const bad of ['2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', '2026/11', '']) assert.doesNotMatch(bad, MONTH_RE);
});

test('صافي كمية الصنف بالأساس: البيع موجب والمرتجع سالب، والصفّ القديم بلا baseQty من لقطته، وبندٌ بلا صنف يُهمل', () => {
  const m = productNetBaseQty([
    { productId: 'p1', qty: 2, unitName: 'كرتون', unitFactor: 24, baseQty: 48, invoice: { type: 'CREDIT' } },
    { productId: 'p1', qty: 5, unitFactor: 1, baseQty: null, invoice: { type: 'CASH' } }, // صفٌّ لم يملأه الترحيل
    { productId: 'p1', qty: 1, unitName: 'كرتون', unitFactor: 24, baseQty: 24, invoice: { type: 'RETURN' } },
    { productId: 'p2', qty: 3, unitFactor: 1, baseQty: 3, invoice: { type: 'CREDIT' } },
    { productId: null, qty: 9, unitFactor: 1, baseQty: 9, invoice: { type: 'CREDIT' } }, // صنفٌ حُذف
  ]);
  assert.deepEqual([...m.entries()].sort(), [['p1', 29], ['p2', 3]]);
  assert.equal(productNetBaseQty([]).size, 0);
});

test('تحصيل الديون السابقة: الافتتاحي = الإجمالي − السندات القائمة قبل الشهر − الإشعارات الدائنة، والمحصَّل في الشهر مقصوصٌ عليه', () => {
  const S = new Date('2026-10-31T21:00:00Z');
  const E = new Date('2026-11-30T21:00:00Z');
  const before = new Date('2026-10-20T09:00:00Z');
  const during = new Date('2026-11-05T09:00:00Z');
  const after = new Date('2026-12-02T09:00:00Z');
  const rows: CollectionInvoiceRow[] = [
    { // ١٠٠٠ − ٣٠٠ قبل الشهر − ١٠٠ إشعار دائن = ٦٠٠ مفتوح، حُصّل منه ٥٠٠ (والملغى وما بعد الشهر لا يُعدّان)
      total: 1000,
      receiptItems: [
        { amount: 300, receipt: { receiptDate: before, status: 'ACTIVE' } },
        { amount: 500, receipt: { receiptDate: during, status: 'ACTIVE' } },
        { amount: 100, receipt: { receiptDate: during, status: 'CANCELLED' } },
        { amount: 50, receipt: { receiptDate: after, status: 'ACTIVE' } },
      ],
      adjustments: [{ total: 100, status: 'CONFIRMED', type: 'RETURN' }, { total: 70, status: 'CANCELLED', type: 'RETURN' }],
    },
    // تحصيلٌ يفوق المفتوح يُقصّ عليه
    { total: 200, receiptItems: [{ amount: 400, receipt: { receiptDate: during } }], adjustments: [] },
    // سُدّدت قبل الشهر، أو أطفأها الإشعار — لا تدخل الأساس
    { total: 100, receiptItems: [{ amount: 100, receipt: { receiptDate: before, status: 'ACTIVE' } }], adjustments: [] },
    { total: 50, receiptItems: [], adjustments: [{ total: 80 }] },
    // غبار هللات لا يُعدّ ديناً
    { total: 10, receiptItems: [{ amount: 10 - BASE_EPS / 2, receipt: { receiptDate: before } }], adjustments: [] },
  ];
  assert.deepEqual(collectionFold(rows, S, E), { base: 800, collected: 700 });
  // اللحظة S نفسها من الشهر، وE نفسها خارجه
  assert.deepEqual(collectionFold([{ total: 100, receiptItems: [{ amount: 40, receipt: { receiptDate: S } }, { amount: 30, receipt: { receiptDate: E } }], adjustments: [] }], S, E),
    { base: 100, collected: 40 });
  assert.deepEqual(collectionFold([], S, E), { base: 0, collected: 0 });
  // ضجيج العائمة يُقصّ (cleanMoney)
  assert.deepEqual(collectionFold([{ total: 0.3, receiptItems: [{ amount: 0.1, receipt: { receiptDate: during } }, { amount: 0.2, receipt: { receiptDate: during } }], adjustments: [] }], S, E),
    { base: 0.3, collected: 0.3 });
});

const CTX: ProgressContext = { monthNetSales: 7500, productBase: new Map([['p1', 60], ['p3', 10]]), collection: { base: 800, collected: 700 } };
const target = (o: Partial<TargetLike>): TargetLike => ({
  kind: 'SALES_AMOUNT', targetValue: 10000, productId: null, unitFactor: 1, rewardKind: 'FIXED_AMOUNT', rewardValue: 500, ...o,
});

test('التقدّم: المبيعات والنسبة بلا سقف والتحقّق بهامش، والكمية بوحدة الهدف، والتحصيل من الأساس، والحالات الخاصة', () => {
  assert.deepEqual(targetProgress(target({}), CTX), { state: 'OK', achieved: 7500, goal: 10000, pct: 75, done: false });
  assert.deepEqual(targetProgress(target({ targetValue: 7500 }), CTX), { state: 'OK', achieved: 7500, goal: 7500, pct: 100, done: true });
  assert.deepEqual(targetProgress(target({ targetValue: 6000 }), CTX), { state: 'OK', achieved: 7500, goal: 6000, pct: 125, done: true }, 'بلا سقف');
  assert.equal(targetProgress(target({ targetValue: 7500 + 1e-7 }), CTX).done, true, 'هامش العائمة');
  assert.deepEqual(targetProgress(target({}), { ...CTX, monthNetSales: -500 }), { state: 'OK', achieved: -500, goal: 10000, pct: -5, done: false }, 'مرتجعٌ يفوق البيع');
  // الكمية: ٦٠ حبّة = ٢٫٥ كرتون من هدف ٢ كرتون
  assert.deepEqual(targetProgress(target({ kind: 'PRODUCT_QTY', productId: 'p1', unitFactor: 24, targetValue: 2 }), CTX),
    { state: 'OK', achieved: 2.5, goal: 2, pct: 125, done: true });
  assert.deepEqual(targetProgress(target({ kind: 'PRODUCT_QTY', productId: 'p3', unitFactor: 3, targetValue: 4 }), CTX),
    { state: 'OK', achieved: 3.3333, goal: 4, pct: 83.3, done: false }, 'أربع منازل');
  assert.deepEqual(targetProgress(target({ kind: 'PRODUCT_QTY', productId: 'p9', unitFactor: 1, targetValue: 5 }), CTX),
    { state: 'OK', achieved: 0, goal: 5, pct: 0, done: false }, 'لا مبيع');
  assert.deepEqual(targetProgress(target({ kind: 'PRODUCT_QTY', productId: null, targetValue: 5 }), CTX),
    { state: 'PRODUCT_DELETED', achieved: 0, goal: 5, pct: null, done: false });
  // التحصيل: ٥٠٪ من ٨٠٠ = ٤٠٠، حُصّل ٧٠٠
  assert.deepEqual(targetProgress(target({ kind: 'COLLECTION_PCT', targetValue: 50 }), CTX),
    { state: 'OK', achieved: 700, goal: 400, pct: 175, done: true, base: 800, collectedPct: 87.5 });
  assert.deepEqual(targetProgress(target({ kind: 'COLLECTION_PCT', targetValue: 100 }), CTX),
    { state: 'OK', achieved: 700, goal: 800, pct: 87.5, done: false, base: 800, collectedPct: 87.5 });
  assert.deepEqual(targetProgress(target({ kind: 'COLLECTION_PCT', targetValue: 30 }), { ...CTX, collection: { base: 0, collected: 0 } }),
    { state: 'NO_BASE', achieved: 0, goal: 0, pct: null, done: false, base: 0, collectedPct: null }, 'لا ديون مفتوحة أول الشهر');
  assert.equal(targetProgress(target({ kind: 'COLLECTION_PCT', targetValue: 30 }), { ...CTX, collection: { base: BASE_EPS, collected: 0 } }).state, 'NO_BASE');
  // النسبة والتقريب
  assert.equal(pctOf(1, 3), 33.3);
  assert.equal(pctOf(5, 0), null);
  assert.equal(round1(-0.04), 0);
});

test('المكافأة: العمولة من صافي مبيعات الشهر (لا سالب)، والمبلغ المحدد كما هو، ونسبة الراتب بلا مبلغ — والاستحقاق بتحقّق الهدف', () => {
  assert.deepEqual(targetReward(target({ rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 2 }), 7500, true),
    { kind: 'COMMISSION_SALES_PCT', value: 2, amount: 150, earned: true });
  assert.deepEqual(targetReward(target({ rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 2.5 }), -900, false),
    { kind: 'COMMISSION_SALES_PCT', value: 2.5, amount: 0, earned: false }, 'لا عمولة سالبة');
  assert.equal(targetReward(target({ rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 1 }), 0.3 + 0.6, true).amount, 0.009, 'cleanMoney');
  assert.deepEqual(targetReward(target({ rewardKind: 'FIXED_AMOUNT', rewardValue: 500 }), 7500, false),
    { kind: 'FIXED_AMOUNT', value: 500, amount: 500, earned: false });
  assert.deepEqual(targetReward(target({ rewardKind: 'SALARY_PCT', rewardValue: 50 }), 7500, true),
    { kind: 'SALARY_PCT', value: 50, amount: null, earned: true }, 'الراتب لا يُخزَّن: نصٌّ وحده');
});

const NOW = new Date('2026-11-10T10:00:00Z');
/** صفّ هدفٍ كما يقرؤه المحمّل من القاعدة (بأعمدته كلها) */
const dbRow = (o: Partial<RepTargetRow> = {}): RepTargetRow => ({
  id: 't1', tenantId: 'T1', salesRepId: 'r1', month: '2026-11', kind: 'SALES_AMOUNT', targetValue: 6000,
  productId: null, productName: null, unitId: null, unitName: null, unitFactor: 1, comboId: null,
  rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 2, note: 'ركّز على الحسابات الكبيرة', createdById: 'admin-1', createdByName: 'مدير',
  createdAt: NOW, updatedAt: NOW, ...o,
});

test('شكل العرض: حقول العقد وحدها (بلا الشركة والمندوب ومعرّف المنشئ)، والمكافأة تُستحق بتحقّق التقدّم', () => {
  const v = toTargetView(dbRow(), CTX);
  assert.deepEqual(Object.keys(v).sort(), [
    'comboId', 'createdAt', 'createdByName', 'id', 'kind', 'month', 'note', 'productId', 'productName', 'products', 'progress', 'reward', 'rewardKind',
    'rewardValue', 'targetValue', 'unitFactor', 'unitId', 'unitName', 'updatedAt',
  ]);
  assert.deepEqual(v.progress, { state: 'OK', achieved: 7500, goal: 6000, pct: 125, done: true });
  assert.deepEqual(v.reward, { kind: 'COMMISSION_SALES_PCT', value: 2, amount: 150, earned: true });
  assert.equal('base' in v.progress, false, 'الأساس لهدف التحصيل وحده');
  // غير هدف الكمية بلا أصناف، والمستقل comboId = null (وصفٌّ قديم بلا العمود كذلك)
  assert.deepEqual([v.products, v.comboId], [[], null]);
  const legacy: Partial<RepTargetRow> = dbRow();
  delete legacy.comboId;
  assert.equal(toTargetView(legacy as RepTargetRow, CTX).comboId, null);
  assert.equal(toTargetView(dbRow({ comboId: 'k1' }), CTX).comboId, 'k1');
});

// ═══ (١١ نوفمبر ٢٠٢٦) الأنواع الجديدة، وهدف الكمية بعدة أصناف، و«دمج الأهداف» ═══

test('عدد الزيارات والعملاء الجدد: المُنجَز عدد السياق، والغائب صفرٌ لا NaN، والتحقّق ببلوغ الهدف، وكلٌّ يقرأ عدده وحده', () => {
  const ctx: ProgressContext = { ...CTX, visits: 18, newCustomers: 3 };
  assert.deepEqual(targetProgress(target({ kind: 'VISITS_COUNT', targetValue: 20 }), ctx), { state: 'OK', achieved: 18, goal: 20, pct: 90, done: false });
  assert.deepEqual(targetProgress(target({ kind: 'VISITS_COUNT', targetValue: 18 }), ctx), { state: 'OK', achieved: 18, goal: 18, pct: 100, done: true });
  assert.deepEqual(targetProgress(target({ kind: 'NEW_CUSTOMERS', targetValue: 5 }), ctx), { state: 'OK', achieved: 3, goal: 5, pct: 60, done: false });
  assert.deepEqual(targetProgress(target({ kind: 'NEW_CUSTOMERS', targetValue: 2 }), ctx), { state: 'OK', achieved: 3, goal: 2, pct: 150, done: true }, 'بلا سقف');
  // سياقٌ لم يُحمَّل له العدد (المحمّل لا يستعلم إلا لنوعٍ مطلوب) ⇒ صفر
  assert.deepEqual(targetProgress(target({ kind: 'VISITS_COUNT', targetValue: 10 }), CTX), { state: 'OK', achieved: 0, goal: 10, pct: 0, done: false });
  assert.deepEqual(targetProgress(target({ kind: 'NEW_CUSTOMERS', targetValue: 1 }), CTX), { state: 'OK', achieved: 0, goal: 1, pct: 0, done: false });
  // لا خلط: الزيارات ليست العملاء ولا المبيعات ولا الأصناف
  assert.equal(targetProgress(target({ kind: 'VISITS_COUNT', targetValue: 3 }), { ...ctx, visits: 0 }).achieved, 0);
  assert.equal(targetProgress(target({ kind: 'NEW_CUSTOMERS', targetValue: 3 }), { ...ctx, newCustomers: 0 }).achieved, 0);
  // المكافأة كبقية الأنواع: العمولة من صافي مبيعات الشهر، وبلا أصناف في العرض
  const v = toTargetView(dbRow({ kind: 'VISITS_COUNT', targetValue: 15 }), ctx);
  assert.deepEqual(v.progress, { state: 'OK', achieved: 18, goal: 15, pct: 120, done: true });
  assert.deepEqual(v.reward, { kind: 'COMMISSION_SALES_PCT', value: 2, amount: 150, earned: true });
  assert.deepEqual(v.products, []);
});

test('كمية عدة أصناف: المُنجَز = Σ صافي أساس كل صنفٍ ÷ معامل وحدته، والمحذوف لا يُعدّ ولا يُسقط الهدف، وكلها محذوفة PRODUCT_DELETED', () => {
  const ctx: ProgressContext = { ...CTX, productBase: new Map([['p1', 60], ['p2', 36], ['p3', 10], ['p4', -12]]) };
  // ٦٠ حبّة ÷ ٢٤ = ٢٫٥ كرتون، و٣٦ ÷ ١٢ = ٣ صناديق، و١٠ ÷ ١ = ١٠ ⇒ ١٥٫٥ من ٢٠
  const multi = target({
    kind: 'PRODUCT_QTY', productId: 'p1', unitFactor: 24, targetValue: 20,
    extraProducts: [{ productId: 'p2', unitFactor: 12 }, { productId: 'p3', unitFactor: 1 }],
  });
  const expected = { state: 'OK', achieved: 15.5, goal: 20, pct: 77.5, done: false };
  assert.deepEqual(targetProgress(multi, ctx), expected);
  // صنفٌ إضافي حُذف (productId فارغ بـSetNull) لا يُعدّ — أيّاً كان معامل لقطته
  assert.deepEqual(targetProgress({ ...multi, extraProducts: [...multi.extraProducts!, { productId: null, unitFactor: 6 }] }, ctx), expected);
  // الأول محذوف والإضافية باقية ⇒ تُعدّ الإضافية وحدها
  assert.deepEqual(targetProgress({ ...multi, productId: null }, ctx), { state: 'OK', achieved: 13, goal: 20, pct: 65, done: false });
  // صافٍ كالصنف الواحد: مرتجعٌ يفوق البيع في صنفٍ يُطرح من المجموع
  assert.deepEqual(targetProgress({ ...multi, extraProducts: [...multi.extraProducts!, { productId: 'p4', unitFactor: 12 }] }, ctx),
    { state: 'OK', achieved: 14.5, goal: 20, pct: 72.5, done: false });
  // صنفٌ بلا مبيعٍ يُعدّ صفراً، والبلوغ بالمجموع لا بكل صنف
  assert.deepEqual(targetProgress({ ...multi, targetValue: 15.5, extraProducts: [...multi.extraProducts!, { productId: 'p9', unitFactor: 24 }] }, ctx),
    { state: 'OK', achieved: 15.5, goal: 15.5, pct: 100, done: true });
  // أربع منازل على المجموع: ٢٫٥ + ١٠ ÷ ٣
  assert.deepEqual(targetProgress(target({ kind: 'PRODUCT_QTY', productId: 'p1', unitFactor: 24, targetValue: 6, extraProducts: [{ productId: 'p3', unitFactor: 3 }] }), ctx),
    { state: 'OK', achieved: 5.8333, goal: 6, pct: 97.2, done: false });
  // كلها محذوفة
  assert.deepEqual(targetProgress({ ...multi, productId: null, extraProducts: [{ productId: null, unitFactor: 12 }] }, ctx),
    { state: 'PRODUCT_DELETED', achieved: 0, goal: 20, pct: null, done: false });
  // غير هدف الكمية: أصنافٌ إضافية عالقة لا تُقرأ
  assert.deepEqual(targetProgress(target({ extraProducts: [{ productId: 'p1', unitFactor: 1 }] }), ctx), { state: 'OK', achieved: 7500, goal: 10000, pct: 75, done: false });
});

test('عرض هدف الكمية بعدة أصناف: products الأول ثم الإضافية بـsortOrder، بحقول اللقطة وحدها، والمحذوف باسمه — وغير الكمية بلا أصناف', () => {
  const ctx: ProgressContext = { ...CTX, productBase: new Map([['p1', 48], ['p2', 24]]) };
  const extra = (o: Record<string, unknown>) => ({ id: `e-${String(o.sortOrder)}`, tenantId: 'T1', targetId: 't1', unitId: null, unitName: 'حبة', unitFactor: 1, ...o });
  const extras = [
    extra({ productId: null, productName: 'صنف حُذف', unitFactor: 6, sortOrder: 2 }), // بترتيبٍ معكوس عمداً
    extra({ productId: 'p2', productName: 'عصير', unitId: 'u-p2', unitName: 'صندوق', unitFactor: 12, sortOrder: 1 }),
  ] as unknown as RepTargetRow['extraProducts'];
  const v = toTargetView(dbRow({
    kind: 'PRODUCT_QTY', targetValue: 4, productId: 'p1', productName: 'ماء', unitId: 'u-ct', unitName: 'كرتون', unitFactor: 24, extraProducts: extras,
  }), ctx);
  assert.deepEqual(v.products, [
    { productId: 'p1', productName: 'ماء', unitId: 'u-ct', unitName: 'كرتون', unitFactor: 24 },
    { productId: 'p2', productName: 'عصير', unitId: 'u-p2', unitName: 'صندوق', unitFactor: 12 },
    { productId: null, productName: 'صنف حُذف', unitId: null, unitName: 'حبة', unitFactor: 6 },
  ]);
  // ٤٨ ÷ ٢٤ + ٢٤ ÷ ١٢ = ٤ من ٤
  assert.deepEqual(v.progress, { state: 'OK', achieved: 4, goal: 4, pct: 100, done: true });
  // صنفٌ واحد: الأول وحده؛ وغير الكمية: لا أصناف ولو عَلِقت صفوفٌ إضافية
  assert.deepEqual(toTargetView(dbRow({ kind: 'PRODUCT_QTY', targetValue: 2, productId: 'p1', productName: 'ماء', unitName: 'حبة' }), ctx).products,
    [{ productId: 'p1', productName: 'ماء', unitId: null, unitName: 'حبة', unitFactor: 1 }]);
  assert.deepEqual(toTargetView(dbRow({ extraProducts: extras }), ctx).products, []);
});

test('«دمج الأهداف» (applyCombos): مكافأة كل عضوٍ تُستحق بتحقّق الأعضاء كلهم، والعضو الوحيد والمستقل كما هما، وصرفةٌ لا تعدّل مدخلاتها', () => {
  // صافي مبيعات ٧٥٠٠: هدف ٦٠٠٠ محقَّق و١٠٠٠٠ لا؛ والتحصيل ٧٠٠ من ٤٠٠ محقَّق، والكمية ٢٫٥ من ٢ محقَّقة
  const views = [
    toTargetView(dbRow({ id: 'a', comboId: 'c1', targetValue: 6000 }), CTX),
    toTargetView(dbRow({ id: 'b', comboId: 'c1', targetValue: 10000 }), CTX),
    toTargetView(dbRow({ id: 'c', targetValue: 6000 }), CTX),
    toTargetView(dbRow({ id: 'd', comboId: 'c2', targetValue: 6000 }), CTX), // بقي وحده (حُذف شريكه)
    toTargetView(dbRow({ id: 'e', comboId: 'c3', kind: 'COLLECTION_PCT', targetValue: 50, rewardKind: 'FIXED_AMOUNT', rewardValue: 900 }), CTX),
    toTargetView(dbRow({ id: 'f', comboId: 'c3', kind: 'PRODUCT_QTY', productId: 'p1', unitFactor: 24, targetValue: 2, rewardKind: 'FIXED_AMOUNT', rewardValue: 900 }), CTX),
    toTargetView(dbRow({ id: 'g', comboId: 'c4', targetValue: 9000 }), CTX),
    toTargetView(dbRow({ id: 'h', comboId: 'c4', kind: 'VISITS_COUNT', targetValue: 5 }), CTX),
  ];
  const before = JSON.stringify(views);
  const out = applyCombos(views);
  assert.deepEqual(out.map((v) => v.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'الترتيب كما هو');
  assert.deepEqual(views.map((v) => v.reward.earned), [true, false, true, true, true, true, false, false], 'كلٌّ بتقدّمه وحده قبل الدمج');
  assert.deepEqual(out.map((v) => v.reward.earned), [false, false, true, true, true, true, false, false]);
  // العضو المحقَّق وحده: تقدّمه كما هو ومبلغ مكافأته كما هو — الاستحقاق وحده للمجموعة
  assert.deepEqual(out[0].progress, views[0].progress);
  assert.deepEqual(out[0].reward, { ...views[0].reward, earned: false });
  // المستقل والعضو الوحيد بلا تغيير
  assert.deepEqual([out[2], out[3]], [views[2], views[3]]);
  assert.equal(JSON.stringify(views), before, 'لا يعدّل العروض المدخلة');
  // تحقّق الشريك ⇒ يُستحق للعضوين معاً
  const later = applyCombos([
    toTargetView(dbRow({ id: 'a', comboId: 'c1', targetValue: 6000 }), CTX),
    toTargetView(dbRow({ id: 'b', comboId: 'c1', targetValue: 7500 }), CTX),
  ]);
  assert.deepEqual(later.map((v) => v.reward.earned), [true, true]);
  assert.deepEqual(applyCombos([]), []);
});
