import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestLoad, type SaleRow, type ProductRow } from '../services/suggestLoad';

/**
 * التواريخ تُبنى بالإزاحة عن اليوم المستهدَف لا بأرقام مثبّتة، فلا يعتمد
 * الاختبار على يوم أسبوع بعينه ولا ينكسر مع تغيّر التقويم.
 */
const TARGET = new Date(2026, 7, 2); // 2 أغسطس 2026 (منتصف الليل محلياً)
const daysAgo = (n: number) => new Date(TARGET.getTime() - n * 86400000);

const PRODUCTS: ProductRow[] = [
  { id: 'p1', name: 'عصير برتقال', code: 'J-1', unit: 'كرتون' },
  { id: 'p2', name: 'مياه 330 مل', code: 'W-1', unit: 'كرتون' },
];
const P1 = [PRODUCTS[0]];

const run = (sales: SaleRow[], extra: Partial<Parameters<typeof suggestLoad>[0]> = {}) =>
  suggestLoad({ sales, products: P1, targetDate: TARGET, windowDays: 28, bufferPct: 0, ...extra });

const row = (r: ReturnType<typeof suggestLoad>, id = 'p1') => r.rows.find((x) => x.id === id)!;

/* ───────────────────── القاعدة الحاكمة: الأيام الصفرية ───────────────────── */

test('الأيام الصفرية تُحتسب — بيعة واحدة في أربعة آحاد ⇒ الربع لا الكلّ', () => {
  // 100 حبّة في أحدٍ واحد فقط من أربعة. القسمة على «أيام البيع» تعطي 100،
  // وعلى «أيام الأسبوع في النافذة» تعطي 25. الثاني هو الصحيح.
  const r = run([{ productId: 'p1', qty: 100, date: daysAgo(7) }]);
  const x = row(r);
  assert.equal(x.basis, 'overall', 'عيّنة يوم واحد لا تكفي لطريقة يوم الأسبوع');
  assert.ok(x.expected < 30, `المتوقّع ${x.expected} — لا يجوز أن يقترب من 100`);
  assert.equal(x.expected, 3.57, '100 ÷ 28 يوماً مقرَّباً لخانتين');
});

test('طريقة يوم الأسبوع تقسم على كل أيام الأسبوع لا على أيام البيع', () => {
  // 4 آحاد في نافذة 28 يوماً: بيع في اثنين فقط (60 و40) ⇒ 100 ÷ 4 = 25
  const r = run([
    { productId: 'p1', qty: 60, date: daysAgo(7) },
    { productId: 'p1', qty: 40, date: daysAgo(21) },
  ]);
  const x = row(r);
  assert.equal(x.basis, 'weekday');
  assert.equal(x.sampleDays, 4, 'القاسم = عدد الآحاد في النافذة');
  assert.equal(x.activeDays, 2, 'وأيام البيع الفعلي تُعرض للشفافية فقط');
  assert.equal(x.expected, 25);
});

test('الشرح يذكر القاسم صراحةً — الرقم غير القابل للشرح يُرفض', () => {
  const r = run([
    { productId: 'p1', qty: 60, date: daysAgo(7) },
    { productId: 'p1', qty: 40, date: daysAgo(14) },
  ]);
  const x = row(r);
  assert.match(x.why, /على 4 /);
  assert.match(x.why, /منها 2 فيها بيع/);
});

/* ───────────────────── لا اختراع عند غياب التاريخ ───────────────────── */

test('صنف بلا مبيعات ⇒ لا اقتراح، لا رقم مُختلَق', () => {
  const r = suggestLoad({ sales: [], products: PRODUCTS, targetDate: TARGET });
  for (const x of r.rows) {
    assert.equal(x.basis, 'none');
    assert.equal(x.suggested, 0);
    assert.match(x.why, /لا مبيعات/);
  }
});

test('صنف له تاريخ وآخر بلا تاريخ ⇒ لا يتسرّب رقم للثاني', () => {
  const r = suggestLoad({
    sales: [{ productId: 'p1', qty: 28, date: daysAgo(3) }],
    products: PRODUCTS, targetDate: TARGET, bufferPct: 0,
  });
  assert.ok(row(r, 'p1').expected > 0);
  assert.equal(row(r, 'p2').expected, 0);
  assert.equal(row(r, 'p2').basis, 'none');
});

/* ───────────────────── المرتجعات ومخزون السيارة ───────────────────── */

test('المرتجع يُخصم من الطلب — ليس طلباً حقيقياً', () => {
  const withReturns = suggestLoad({
    sales: [{ productId: 'p1', qty: 56, date: daysAgo(3) }],
    returns: [{ productId: 'p1', qty: 28, date: daysAgo(3) }],
    products: P1, targetDate: TARGET, bufferPct: 0,
  });
  assert.equal(row(withReturns).expected, 1); // (56−28)/28
});

test('المرتجع يُخصم ولو جاء في يوم غير يوم البيع — الحالة الطبيعية', () => {
  // المرتجع في التوزيع يصل في زيارة تالية لا في يوم البيع. القصّ عند الصفر
  // لكل يوم كان يبتلعه تماماً فيخرج 10/يوم بدل 2.5 — أربعة أضعاف الحاجة.
  const cross = suggestLoad({
    sales: [{ productId: 'p1', qty: 280, date: daysAgo(5) }],
    returns: [{ productId: 'p1', qty: 210, date: daysAgo(3) }],
    products: P1, targetDate: TARGET, windowDays: 28, bufferPct: 0,
  });
  assert.equal(row(cross).expected, 2.5, '(280−210)/28');

  // والنتيجة نفسها لو وقعا في اليوم ذاته — لا فرق يعتمد على توقيت المرتجع
  const same = suggestLoad({
    sales: [{ productId: 'p1', qty: 280, date: daysAgo(5) }],
    returns: [{ productId: 'p1', qty: 210, date: daysAgo(5) }],
    products: P1, targetDate: TARGET, windowDays: 28, bufferPct: 0,
  });
  assert.equal(same.rows[0].expected, cross.rows[0].expected);
});

test('مرتجع يفوق مبيعات اليوم لا يجعل المتوسط سالباً', () => {
  const r = suggestLoad({
    sales: [{ productId: 'p1', qty: 10, date: daysAgo(3) }],
    returns: [{ productId: 'p1', qty: 99, date: daysAgo(3) }],
    products: P1, targetDate: TARGET, bufferPct: 0,
  });
  assert.equal(row(r).expected, 0);
  assert.equal(row(r).suggested, 0);
});

test('ما في السيارة يُخصم من المقترح ولا ينزل تحت الصفر', () => {
  const sales = [{ productId: 'p1', qty: 280, date: daysAgo(3) }]; // 10/يوم
  const none = suggestLoad({ sales, products: P1, targetDate: TARGET, bufferPct: 0 });
  assert.equal(row(none).suggested, 10);

  const some = suggestLoad({ sales, onVan: [{ productId: 'p1', remaining: 4 }], products: P1, targetDate: TARGET, bufferPct: 0 });
  assert.equal(row(some).suggested, 6);
  assert.equal(row(some).onVan, 4);

  const full = suggestLoad({ sales, onVan: [{ productId: 'p1', remaining: 99 }], products: P1, targetDate: TARGET, bufferPct: 0 });
  assert.equal(row(full).suggested, 0, 'سيارة ممتلئة ⇒ لا تحميل، لا رقم سالب');
});

/* ───────────────────── الهامش والتقريب ───────────────────── */

test('الهامش يُطبَّق ويُقرَّب لأعلى — النقص يُضيّع بيعاً والزيادة تعود', () => {
  const r = suggestLoad({
    sales: [{ productId: 'p1', qty: 280, date: daysAgo(3) }], // 10/يوم
    products: P1, targetDate: TARGET, bufferPct: 15,
  });
  const x = row(r);
  assert.equal(x.expected, 10);
  assert.equal(x.withBuffer, 12); // ceil(11.5)
  assert.match(x.why, /هامش 15٪/);
});

test('كسر صغير يُقرَّب لأعلى لا لصفر', () => {
  const r = run([{ productId: 'p1', qty: 1, date: daysAgo(3) }], { bufferPct: 0 });
  const x = row(r);
  assert.ok(x.expected > 0 && x.expected < 1);
  assert.equal(x.withBuffer, 1, 'طلب ضئيل يبقى وحدة واحدة لا صفراً');
});

/* ───────────────────── النافذة والثقة والتحذير ───────────────────── */

test('ما خارج النافذة لا يُحتسب', () => {
  const r = run([{ productId: 'p1', qty: 1000, date: daysAgo(60) }], { windowDays: 28 });
  assert.equal(row(r).basis, 'none');
  assert.equal(r.meta.dataDays, 0);
});

test('مبيعات اليوم المستهدَف نفسه خارج الحساب — نتنبّأ به لا نتعلّم منه', () => {
  const r = run([{ productId: 'p1', qty: 500, date: new Date(TARGET.getTime() + 3600000) }]);
  assert.equal(row(r).basis, 'none');
});

test('الثقة تتدرّج مع كثافة العيّنة', () => {
  const four = [7, 14, 21, 28].map((d) => ({ productId: 'p1', qty: 10, date: daysAgo(d) }));
  assert.equal(row(run(four)).confidence, 'high');

  const two = [7, 14].map((d) => ({ productId: 'p1', qty: 10, date: daysAgo(d) }));
  assert.equal(row(run(two)).confidence, 'medium');

  assert.equal(row(run([{ productId: 'p1', qty: 10, date: daysAgo(3) }])).confidence, 'low');
});

test('التحذير يصدق عن رقّة البيانات', () => {
  assert.match(String(suggestLoad({ sales: [], products: P1, targetDate: TARGET }).meta.warning), /لا مبيعات/);

  const thin = run([1, 2, 3].map((d) => ({ productId: 'p1', qty: 5, date: daysAgo(d) })));
  assert.match(String(thin.meta.warning), /3 يوماً فقط/);

  const many = run(Array.from({ length: 20 }, (_, i) => ({ productId: 'p1', qty: 5, date: daysAgo(i + 1) })));
  assert.equal(many.meta.warning, null, 'بيانات كافية ⇒ لا تحذير');
});

/* ───────────────────── المتانة ───────────────────── */

test('تاريخ غير صالح لا يُسقط المحرّك', () => {
  const r = suggestLoad({ sales: [], products: P1, targetDate: 'ليس تاريخاً' });
  assert.equal(r.rows.length, 1);
  assert.match(String(r.meta.warning), /تاريخ غير صالح/);
});

test('مدخلات تالفة تُتجاهَل بلا انهيار', () => {
  const r = suggestLoad({
    sales: [
      { productId: 'p1', qty: NaN as unknown as number, date: daysAgo(2) },
      { productId: '', qty: 5, date: daysAgo(2) },
      { productId: 'p1', qty: 5, date: 'تاريخ فاسد' },
    ],
    products: P1, targetDate: TARGET,
  });
  assert.equal(r.rows.length, 1);
  assert.ok(Number.isFinite(row(r).suggested));
});

test('الترتيب يضع ما يحتاج تحميلاً أولاً', () => {
  const r = suggestLoad({
    sales: [
      { productId: 'p1', qty: 28, date: daysAgo(3) },
      { productId: 'p2', qty: 280, date: daysAgo(3) },
    ],
    products: PRODUCTS, targetDate: TARGET, bufferPct: 0,
  });
  assert.equal(r.rows[0].id, 'p2');
});

test('نافذة أقصر تُحترَم ولا تقلّ عن أسبوع', () => {
  const sales = [{ productId: 'p1', qty: 70, date: daysAgo(3) }];
  assert.equal(run(sales, { windowDays: 7 }).rows[0].expected, 10);
  assert.equal(run(sales, { windowDays: 1 }).meta.windowDays, 7, 'نافذة أقلّ من أسبوع تُرفع لأسبوع');
});
