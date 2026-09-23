import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { composeWarehouse } from '../services/warehouseStock';
import { netUnitCost, lineCost, entryTotalCost, valueStock } from '../services/warehouseCost';

/** قراءة مصدرٍ للحراس الثابتة (البند 40) — بسطورٍ موحَّدة فلا يفرّقها ويندوز */
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const P = [
  { id: 'a', name: 'صنف أ', code: 'A', unit: 'كرتون' },
  { id: 'b', name: 'صنف ب', code: 'B', unit: 'كرتون' },
];
const byId = (rows: ReturnType<typeof composeWarehouse>, id: string) => rows.find((r) => r.productId === id)!;

test('الرصيد = الوارد − المحمل للسيارات + العائد منها (الارتباط الأساسي)', () => {
  const rows = composeWarehouse(
    P,
    [{ productId: 'a', qty: 100, type: 'RECEIVE' }],
    [
      { productId: 'a', qty: 30, type: 'LOAD' },   // خرج للسيارة
      { productId: 'a', qty: 5, type: 'UNLOAD' },   // عاد للمستودع
    ],
  );
  const a = byId(rows, 'a');
  assert.equal(a.received, 100);
  assert.equal(a.loadedToVans, 30);
  assert.equal(a.returnedFromVans, 5);
  assert.equal(a.onHand, 100 - 30 + 5); // 75
});

test('تسوية المستودع تدخل الرصيد (+/−)، وتسوية السيارة لا تمسه', () => {
  const rows = composeWarehouse(
    P,
    [{ productId: 'a', qty: 50, type: 'RECEIVE' }, { productId: 'a', qty: -4, type: 'ADJUST' }],
    [{ productId: 'a', qty: 999, type: 'ADJUST' }], // تسوية سيارة — يجب تجاهلها هنا
  );
  const a = byId(rows, 'a');
  assert.equal(a.adjusted, -4);
  assert.equal(a.loadedToVans, 0);
  assert.equal(a.onHand, 50 - 4); // 46 — تسوية السيارة لم تؤثر
});

test('كل المنتجات تظهر ولو بلا حركة (المستودع مرجع كامل)', () => {
  const rows = composeWarehouse(P, [], []);
  assert.equal(rows.length, 2);
  assert.equal(byId(rows, 'b').onHand, 0);
});

test('الرصيد قد يكون سالبا حين يحمل أكثر من الوارد (مؤشر نقص)', () => {
  const rows = composeWarehouse(P, [{ productId: 'a', qty: 10, type: 'RECEIVE' }], [{ productId: 'a', qty: 25, type: 'LOAD' }]);
  assert.equal(byId(rows, 'a').onHand, -15);
});

test('الترتيب تنازلي بالرصيد', () => {
  const rows = composeWarehouse(
    P,
    [{ productId: 'a', qty: 5, type: 'RECEIVE' }, { productId: 'b', qty: 40, type: 'RECEIVE' }],
    [],
  );
  assert.equal(rows[0].productId, 'b'); // الأكبر أولا
});


// ════════════════════════════════════════════════════════════════════════════
// تقييم المخزون بتكلفة الشراء
//
// نسختان سابقتان من هذا الحساب شُحنتا وكانتا خاطئتين، ومرّتا من اختبارات
// «خضراء» لأنها غطّت الطرفين ولم تغطِّ المزيج: صنفا كل وارده مسعّر، وصنفا لا
// وارد مسعّر له إطلاقا — ولا صنفا نصفه مسعّر، ولا سعرين بينهما استهلاك.
// فالاختبارات هنا مكتوبة على المزيج قصدا.
// ════════════════════════════════════════════════════════════════════════════

test('السعر الشامل يرد الى صافيه قبل الحفظ — عمود بمعنى واحد', () => {
  assert.equal(netUnitCost(115, 15, true), 100);
  assert.equal(netUnitCost(100, 15, false), 100);
  assert.equal(netUnitCost(50, 0, true), 50);
});

test('تكلفة الوحدة تحفظ باربع خانات — التقريب لخانتين يضيع فلسا في كل مئة وحدة', () => {
  assert.equal(netUnitCost(1 / 3, 0, false), 0.3333);
});

test('قيمة السطر = الكمية × التكلفة، والاجمالي مجموع الاسطر المقربة لا الخام', () => {
  assert.equal(lineCost(10, 2.5), 25);
  assert.equal(lineCost(10, null), 0, 'سطر بلا سعر قيمته صفر لا NaN');
  assert.equal(entryTotalCost([{ qty: 1, unitCost: 0.3333 }, { qty: 1, unitCost: 0.3333 }, { qty: 1, unitCost: 0.3333 }]), 0.99);
});

// ═══ العيب الاول الذي شُحن: الكمية بلا تكلفة كانت تقيَّم بمتوسط غيرها ═══

test('الكمية بلا تكلفة خارج القيمة فعلا — لا تقيَّم بمتوسط الكمية المسعرة', () => {
  // ١٠٬٠٠٠ وارد قديم بلا سعر + ١٠ بـ١٢. كان الناتج ١٢٠٬١٢٠ والصواب ١٢٠
  const v = valueStock([
    { qty: 10000, kind: 'RECEIVE' },
    { qty: 10, kind: 'RECEIVE', unitCost: 12 },
  ]);
  assert.equal(v.stockValue, 120, 'الفي ضعف: الرصيد كله كان يضرب في متوسط المسعر');
  assert.equal(v.avgCost, 12);
  assert.equal(v.costedQty, 10);
  assert.equal(v.uncostedQty, 10000, 'وتعلن كميتها صراحة بدل ان تخفى في رقم واثق');
});

test('صنف كل رصيده بلا تكلفة: قيمته صفر ولا متوسط له', () => {
  const v = valueStock([{ qty: 20, kind: 'RECEIVE' }]);
  assert.equal(v.stockValue, 0);
  assert.equal(v.avgCost, 0);
  assert.equal(v.costedQty, 0);
  assert.equal(v.uncostedQty, 20);
});

// ═══ العيب الثاني الذي شُحن: بضاعة استُهلكت كانت تجر المتوسط ابدا ═══

test('الطبقة المستهلكة تخرج من المتوسط — التقييم على الباقي لا على تاريخ الشراء', () => {
  // يناير ١٠٠٠ بعشرة بيعت كلها، فبراير ١٠٠٠ بعشرين هي الباقية.
  // كان الناتج متوسط ١٥ وقيمة ١٥٬٠٠٠؛ والصواب ٢٠ و٢٠٬٠٠٠
  const v = valueStock([
    { qty: 1000, kind: 'RECEIVE', unitCost: 10 },
    { qty: -1000, kind: 'OTHER' },              // حُملت للسيارات
    { qty: 1000, kind: 'RECEIVE', unitCost: 20 },
  ]);
  assert.equal(v.avgCost, 20);
  assert.equal(v.stockValue, 20000);
});

test('الترتيب الزمني جزء من الصحة: نفس الحركات بترتيب مقلوب تعطي رقما اخر', () => {
  const ordered = valueStock([
    { qty: 1000, kind: 'RECEIVE', unitCost: 10 },
    { qty: -1000, kind: 'OTHER' },
    { qty: 1000, kind: 'RECEIVE', unitCost: 20 },
  ]);
  const jumbled = valueStock([
    { qty: 1000, kind: 'RECEIVE', unitCost: 10 },
    { qty: 1000, kind: 'RECEIVE', unitCost: 20 },
    { qty: -1000, kind: 'OTHER' },
  ]);
  assert.equal(ordered.stockValue, 20000);
  assert.equal(jumbled.stockValue, 15000, 'ولذلك يُفرز زمنيا في composeWarehouse قبل الاستدعاء');
});

test('المتوسط مرجح بالكمية لا حسابي — شراء صغير شاذ لا يقلب التقييم', () => {
  const v = valueStock([
    { qty: 1000, kind: 'RECEIVE', unitCost: 1 },
    { qty: 10, kind: 'RECEIVE', unitCost: 2 },
  ]);
  assert.equal(v.avgCost, 1.0099); // لا ١٫٥٠
});

test('الصرف ينقص الدلوين بنسبتهما — لا يستنزف المسعر وحده فيتضخم الباقي', () => {
  // ١٠٠ بلا سعر + ١٠٠ بعشرة، ثم خرج ١٠٠ ⇒ يبقى ٥٠ و٥٠
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE' },
    { qty: 100, kind: 'RECEIVE', unitCost: 10 },
    { qty: -100, kind: 'OTHER' },
  ]);
  assert.equal(v.costedQty, 50);
  assert.equal(v.uncostedQty, 50);
  assert.equal(v.stockValue, 500);
  assert.equal(v.avgCost, 10, 'الصرف بالمتوسط لا يغير المتوسط');
});

test('العائد من السيارة بلا شراء بينهما — الذهاب والاياب لا يخلفان فرقا', () => {
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE', unitCost: 4 },
    { qty: -30, kind: 'VAN_OUT' },  // حُمل
    { qty: 10, kind: 'VAN_IN' },    // عاد
  ]);
  assert.equal(v.costedQty, 80);
  assert.equal(v.stockValue, 320);
  assert.equal(v.avgCost, 4);
});

test('العائد يعود بكلفة خروجه لا بمتوسط لحظة عودته', () => {
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE', unitCost: 10 },
    { qty: -50, kind: 'VAN_OUT' },                 // خرجت الخمسون بعشرة
    { qty: 100, kind: 'RECEIVE', unitCost: 20 },   // شراء ارفع رفع المتوسط الى ١٦٫٦٧
    { qty: 50, kind: 'VAN_IN' },                   // وعادت الخمسون نفسها
  ]);
  assert.equal(v.costedQty, 200);
  assert.equal(v.stockValue, 3000, 'لا ٣٣٣٣: شراء فبراير لا يرفع كلفة حبات كانت خارج المستودع');
  assert.equal(v.avgCost, 15);
});

test('اخر ما حُمّل اول ما يعود — المبيع من الحمولة الاقدم لا يعود ليطالب بسعره', () => {
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE', unitCost: 10 },
    { qty: -100, kind: 'VAN_OUT' },                // حمولة قديمة بعشرة، بيعت كلها
    { qty: 100, kind: 'RECEIVE', unitCost: 20 },
    { qty: -100, kind: 'VAN_OUT' },                // حمولة اليوم بعشرين
    { qty: 50, kind: 'VAN_IN' },                   // العائد منها هي
  ]);
  assert.equal(v.costedQty, 50);
  assert.equal(v.stockValue, 1000, 'لا ٥٠٠: العائد من حمولة اليوم لا من حمولة الشهر الماضي');
  assert.equal(v.avgCost, 20);
});

test('ما خرج بلا كلفة يعود بلا كلفة — لا يلتقط سعر شراء لم يمسه', () => {
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE' },                 // وارد قديم بلا سعر
    { qty: -50, kind: 'VAN_OUT' },
    { qty: 100, kind: 'RECEIVE', unitCost: 20 },
    { qty: 50, kind: 'VAN_IN' },
  ]);
  assert.equal(v.stockValue, 2000, 'لا ٣٠٠٠: العائد لم يكن مسعرا يوم خرج');
  assert.equal(v.costedQty, 100);
  assert.equal(v.uncostedQty, 100);
  assert.equal(v.avgCost, 20);
});

test('التحميل المكشوف يعود بما خُصم به تماما — لا ربح من ذهاب واياب', () => {
  const v = valueStock([
    { qty: 10, kind: 'RECEIVE', unitCost: 2 },
    { qty: -25, kind: 'VAN_OUT' },                 // حُمل اكثر من الوارد
    { qty: 25, kind: 'VAN_IN' },
  ]);
  assert.equal(v.costedQty, 10);
  assert.equal(v.stockValue, 20);
  assert.equal(v.avgCost, 2);
});

test('عودة بلا تحميل يقابلها تبقى على متوسط اللحظة — بضاعة سابقة للنظام', () => {
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE', unitCost: 4 },
    { qty: 10, kind: 'VAN_IN' },
  ]);
  assert.equal(v.costedQty, 110);
  assert.equal(v.stockValue, 440);
  assert.equal(v.avgCost, 4);
});

test('التسوية بلا ثمن لا تغير المتوسط لكن كميتها تقيَّم به — جرد لا شراء', () => {
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE', unitCost: 4 },
    { qty: 10, kind: 'OTHER' },
  ]);
  assert.equal(v.avgCost, 4);
  assert.equal(v.stockValue, 440);
});

test('الرصيد السالب يقيَّم سالبا — رقم احمر اصدق من صفر يخفي تجاوز التحميل', () => {
  const v = valueStock([
    { qty: 10, kind: 'RECEIVE', unitCost: 2 },
    { qty: -25, kind: 'OTHER' },
  ]);
  assert.equal(v.costedQty, -15);
  assert.equal(v.stockValue, -30);
});

// ═══ التقييم عبر حساب الرصيد كاملا (لا الدالة النقية وحدها) ═══

test('التقييم يمر عبر composeWarehouse مرتبا زمنيا لا بترتيب المصفوفة', () => {
  const rows = composeWarehouse(
    P,
    [
      // مسجَّلان بترتيب معكوس عمدا: الاحدث اولا كما ترده قاعدة البيانات احيانا
      { productId: 'a', qty: 1000, type: 'RECEIVE', unitCost: 20, at: '2026-02-01' },
      { productId: 'a', qty: 1000, type: 'RECEIVE', unitCost: 10, at: '2026-01-01' },
    ],
    [{ productId: 'a', qty: 1000, type: 'LOAD', at: '2026-01-15' }],
  );
  const a = byId(rows, 'a');
  assert.equal(a.onHand, 1000);
  assert.equal(a.avgCost, 20, 'دفعة يناير خرجت قبل شراء فبراير');
  assert.equal(a.stockValue, 20000);
});

test('لكل سيارة مكدسها — عودة مندوب لا تأخذ كلفة حمولة زميله', () => {
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE', unitCost: 10 },
    { qty: -100, kind: 'VAN_OUT', vanId: 'repA' },   // خرجت مئة (أ) بعشرة
    { qty: 100, kind: 'RECEIVE', unitCost: 30 },
    { qty: -40, kind: 'VAN_OUT', vanId: 'repB' },    // وخرجت اربعون (ب) بثلاثين
    { qty: 100, kind: 'VAN_IN', vanId: 'repA' },     // ثم انزل (أ) حمولته هو
  ]);
  assert.equal(v.costedQty, 160);
  assert.equal(v.stockValue, 2800, 'لا ٣٦٠٠: حمولة (ب) ما زالت في سيارته فلا يعود بها (أ)');
  assert.equal(v.avgCost, 17.5);
});

test('مكدس السيارة لا يعبر حد الدلوين — غير المسعر لا يلتقط سعر حمولة زميل', () => {
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE' },                   // رصيد افتتاحي بلا فاتورة
    { qty: -100, kind: 'VAN_OUT', vanId: 'repA' },
    { qty: 100, kind: 'RECEIVE', unitCost: 20 },
    { qty: -100, kind: 'VAN_OUT', vanId: 'repB' },
    { qty: 100, kind: 'VAN_IN', vanId: 'repA' },     // العائد هو نفسه بلا كلفة موثقة
  ]);
  assert.equal(v.stockValue, 0, 'لا ٢٠٠٠: لا تختلق قيمة لبضاعة لم تعرف كلفتها قط');
  assert.equal(v.costedQty, 0);
  assert.equal(v.uncostedQty, 100, 'تبقى معلنة خارج التقييم لا مبتلعة فيه');
});

test('عزل السيارات يمر عبر المسار الكامل بمعرف المندوب', () => {
  const rows = composeWarehouse(
    P,
    [
      { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 10, at: '2026-01-01' },
      { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 30, at: '2026-01-03' },
    ],
    [
      { productId: 'a', qty: 100, type: 'LOAD', salesRepId: 'repA', at: '2026-01-02' },
      { productId: 'a', qty: 40, type: 'LOAD', salesRepId: 'repB', at: '2026-01-04' },
      { productId: 'a', qty: 100, type: 'UNLOAD', salesRepId: 'repA', at: '2026-01-05' },
    ],
  );
  const a = byId(rows, 'a');
  assert.equal(a.onHand, 160);
  assert.equal(a.avgCost, 17.5);
  assert.equal(a.stockValue, 2800);
});

test('كلفة العائد تصمد عبر المسار الكامل — تحميل بين شرائين مختلفي السعر', () => {
  const rows = composeWarehouse(
    P,
    [
      { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 10, at: '2026-01-01' },
      { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 20, at: '2026-02-01' },
    ],
    [
      { productId: 'a', qty: 50, type: 'LOAD', at: '2026-01-15' },
      { productId: 'a', qty: 50, type: 'UNLOAD', at: '2026-02-15' },
    ],
  );
  const a = byId(rows, 'a');
  assert.equal(a.onHand, 200);
  assert.equal(a.avgCost, 15, 'العائد رجع بعشرة لا بمتوسط فبراير');
  assert.equal(a.stockValue, 3000);
});

test('صنف نصفه مسعر عبر المسار الكامل — الفجوة التي فاتت النسخة المشحونة', () => {
  const rows = composeWarehouse(
    P,
    [
      { productId: 'a', qty: 10000, type: 'RECEIVE', at: '2026-01-01' },
      { productId: 'a', qty: 10, type: 'RECEIVE', unitCost: 12, at: '2026-01-02' },
    ],
    [],
  );
  const a = byId(rows, 'a');
  assert.equal(a.onHand, 10010);
  assert.equal(a.stockValue, 120);
  assert.notEqual(a.stockValue, a.onHand * a.avgCost, 'القيمة ليست الرصيد كله × المتوسط');
  assert.equal(a.uncostedQty, 10000);
});

// ═══ العيب الثالث: خانتان ثابتتان في قيمة الرصيد تبتلعان كسر الدينار ═══

test('قيمة الرصيد تُقرَّب بخانات عملة الشركة لا بخانتين ثابتتين', () => {
  // شركةٌ بالدينار (ثلاث خانات): ٢٥٠ كرتوناً بـ٤٫١٢٣٥ ⇒ ١٠٣٠٫٨٧٥
  const mv = [{ qty: 250, kind: 'RECEIVE' as const, unitCost: 4.1235 }];
  assert.equal(valueStock(mv, 3).stockValue, 1030.875);
  assert.equal(valueStock(mv, 2).stockValue, 1030.88, 'خانتان ترفعان القيمة نصف فلس');
  assert.equal(
    valueStock(mv).stockValue, 1030.88,
    'والافتراضي يبقى خانتين — لا انحدار على الريال حيث لا يمرّر المستدعي شيئاً',
  );
  // الخسارة المعلنة في المراجعة: ألف صنفٍ تفقد كلٌّ منها نصف فلسٍ ⇒ نصف دينار
  const gap = Math.abs(valueStock(mv, 2).stockValue - valueStock(mv, 3).stockValue);
  assert.equal(
    Number(gap.toFixed(4)), 0.005,
    'خمسة فلوسٍ في الصنف الواحد — وألفُ صنفٍ تجعلها خمسة دنانير في الرصيد الافتتاحيّ',
  );
});

test('عملةٌ بلا كسور: تقريبٌ واحدٌ بخاناتها لا تقريبان متتاليان', () => {
  // ٣ × ٠٫١٦٥ = ٠٫٤٩٥. بخانتين تصير ٠٫٥٠ ثمّ يرفعها toMilli إلى ديناراً كاملاً،
  // والصواب صفرٌ — التقريب مرّتين يخلق وحدةَ عملةٍ من العدم.
  const mv = [{ qty: 3, kind: 'RECEIVE' as const, unitCost: 0.165 }];
  assert.equal(valueStock(mv, 0).stockValue, 0);
  assert.equal(valueStock(mv, 2).stockValue, 0.5, 'هذه هي القيمة التي كانت تُمرَّر فتصير ديناراً');
  assert.equal(valueStock(mv, 3).stockValue, 0.495);
});

test('خانات عملة فاسدة لا تُسقط شاشة المخزون — تعود إلى خانتين', () => {
  const mv = [{ qty: 250, kind: 'RECEIVE' as const, unitCost: 4.1235 }];
  for (const bad of [NaN, 5, 1.5, -1, undefined as unknown as number]) {
    assert.equal(valueStock(mv, bad).stockValue, 1030.88, `خانات ${bad} ⇐ الافتراضي`);
  }
});

test('خانات العملة تمسّ القيمة وحدها: المتوسّط بأربع خانات والكمّيات كما هي', () => {
  // ٣ حبّات بريال ⇒ ٠٫٣٣٣٣ للوحدة، وهي خانات تكلفةٍ لا خانات عملة
  const mv = [{ qty: 3, kind: 'RECEIVE' as const, unitCost: 1 / 3 }, { qty: 0.5, kind: 'OTHER' as const }];
  for (const dec of [0, 2, 3]) {
    const v = valueStock(mv, dec);
    assert.equal(v.avgCost, 0.3333, 'المتوسّط أوسع من العملة عمداً — COST_DECIMALS');
    assert.equal(v.costedQty, 3.5, 'الكمّية كمّيةٌ لا مبلغ');
    assert.equal(v.uncostedQty, 0);
  }
});

// ═══ البند 40: الخانات موصولةٌ فعلاً من المسار إلى الحساب، لا معامِلاً معطَّلاً ═══
//
// المعامل وحده لا يكفي: قبل هذه الجولة كان `valueStock(moves, decimals)` يقبل
// الخانات ولا يمرّرها أحد، فكانت شاشة المخزون والقيد الافتتاحيّ وإشعار الوارد
// تُقرَّب كلّها إلى خانتين حتى في الدينار. فالاختبار هنا على `composeWarehouse`
// (المدخل الإنتاجيّ الوحيد إلى التقييم) لا على `valueStock` وحدها.

const sumStockValue = (rows: ReturnType<typeof composeWarehouse>) =>
  Number(rows.reduce((s, r) => s + r.stockValue, 0).toFixed(6));

test('البند 40: ألف صنفٍ بـ٠٫١٢٣٥ ⇒ ١٢٤ بثلاث خانات و١٢٠ بخانتين — الفرق أربعة دنانير', () => {
  // كل صنفٍ حبّةٌ واحدة بـ٠٫١٢٣٥: بثلاث خاناتٍ ٠٫١٢٤ وبخانتين ٠٫١٢. الخسارة
  // نصف فلسٍ في الصنف الواحد لا تُرى، وألفُ صنفٍ تجعلها أربعة دنانير في الشاشة.
  const products = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, name: `صنف ${i}`, code: `P${i}`, unit: 'حبة' }));
  const items = products.map((p) => ({ productId: p.id, qty: 1, type: 'RECEIVE', unitCost: 0.1235 }));

  assert.equal(sumStockValue(composeWarehouse(products, items, [], 3)), 124);
  assert.equal(sumStockValue(composeWarehouse(products, items, [], 2)), 120);
  assert.equal(
    sumStockValue(composeWarehouse(products, items, [])), 120,
    'الافتراضي خانتان — الريال لا ينحدر حين لا يمرّر المستدعي شيئاً',
  );
  // العملة بلا كسور (الدينار العراقيّ) تُقرَّب مرّةً واحدة بخاناتها هي
  assert.equal(sumStockValue(composeWarehouse(products, items, [], 0)), 0);
});

test('البند 40: المثال المعلن في المراجعة — ٠٫٣٧١ بثلاث خانات لا ٠٫٣٧', () => {
  const p = [{ id: 'a', name: 'صنف أ', code: 'A', unit: 'حبة' }];
  const items = [{ productId: 'a', qty: 3, type: 'RECEIVE', unitCost: 0.1235 }]; // ٠٫٣٧٠٥
  assert.equal(byId(composeWarehouse(p, items, [], 3), 'a').stockValue, 0.371);
  assert.equal(byId(composeWarehouse(p, items, [], 2), 'a').stockValue, 0.37, 'هذا ما كانت تعطيه الشاشة دائماً');
});

test('البند 40: حارسٌ ثابت — لا مستدعيَ إنتاجيّاً يعود ينادي التقييم بلا خانات', () => {
  const stock = read('services/warehouseStock.ts');
  // المحرّك: `valueStock` يأخذ خانات `composeWarehouse` لا افتراضَها
  assert.match(stock, /const val = valueStock\(mv, decimals\);/, 'composeWarehouse يمرّر خاناته إلى valueStock');
  assert.match(stock, /decimals: number = DEFAULT_CURRENCY_DECIMALS,/, 'المعامل اختياريّ بافتراض خانتين');
  // الغلاف: خانات الشركة من مصدرها الحقيقيّ، ومرّةً واحدة
  assert.match(stock, /import \{ currencyDecimalsOf \} from '\.\.\/config\/countries';/);
  assert.match(stock, /export async function tenantCurrencyDecimals\(tid: string\): Promise<number>/);
  assert.match(stock, /decimals \?\? tenantCurrencyDecimals\(tid\)/, '?? لا || — صفر خانات عملةٌ صحيحة');
  assert.match(stock, /at: i\.vanLoad\.createdAt \}\)\),\n\s*dec,\n\s*\);/, 'غلاف القاعدة يمرّر dec رابعةً لا يكتفي بثلاث وسائط');

  // المسار: قراءةٌ واحدة لكل طلب، وتمريرٌ إلى الأسطر والإجمالي معاً
  const route = read('routes/warehouse.ts');
  assert.match(route, /import \{ computeWarehouseStock, tenantCurrencyDecimals \} from '\.\.\/services\/warehouseStock';/);
  assert.match(route, /computeWarehouseStock\(tid, dec\)/);
  assert.match(route, /lineCost\(i\.qty, i\.unitCost, dec\)/);
  assert.match(route, /entryTotalCost\(e\.items, dec\)/);
  assert.equal(
    (route.match(/tenantCurrencyDecimals\(tid\)/g) || []).length, 2,
    'نداءٌ واحد لكل مسار من المسارين — لا داخل حلقة',
  );

  // القيد الافتتاحيّ: خانات الدفاتر نفسها التي يقرأ بها toMilli
  const opening = read('services/gl/opening.ts');
  assert.match(opening, /vans\.map\(\(i\) => \(\{[^\n]*\}\)\),\n(?:\s*\/\/[^\n]*\n)*\s*dec,\n\s*\);/, 'composeWarehouse في opening.ts يأخذ dec');
});
