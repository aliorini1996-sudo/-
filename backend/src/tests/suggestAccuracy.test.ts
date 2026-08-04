import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAccuracy, type AccuracyInput } from '../services/suggestAccuracy';

const NOW = new Date(2026, 7, 10, 18, 0, 0);
const at = (dayOffset: number, hour = 8) =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - dayOffset, hour, 0, 0);
const day = (dayOffset: number) => {
  const d = at(dayOffset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const PRODUCTS = [{ id: 'p1', name: 'عصير', code: 'J1', unit: 'كرتون' }];
const run = (i: Partial<AccuracyInput>) =>
  computeAccuracy({ loads: [], sales: [], now: NOW, products: PRODUCTS, ...i });
const on = (r: ReturnType<typeof computeAccuracy>, offset: number, pid = 'p1') =>
  r.days.find((d) => d.day === day(offset) && d.productId === pid)!;

/* ══════ الجذر: يُقاس التنبّؤ اليومي لا كمية التعبئة ══════ */

test('القياس على expected لا على suggested — وإلا انقلبت التوصية', () => {
  // العيب الذي كشفته المراجعة: في السيارة 30، حُمِّل 16 مقترَحة (المتاح 46)،
  // فبيع 44. قياس «44 مقابل 16» يعلن نقصاً بـ28 ويوصي برفع الهامش، بينما
  // التنبّؤ اليومي كان 40 والطلب 44 ⇒ نقص بـ4 فقط.
  const r = run({
    loads: [{ id: 'L1', at: at(2), items: [{ productId: 'p1', qty: 16, suggestedQty: 16, expectedQty: 40 }] }],
    sales: [{ productId: 'p1', qty: 44, at: at(2, 12) }],
  });
  const x = on(r, 2);
  assert.equal(x.expected, 40);
  assert.equal(x.suggested, 16, 'كمية التعبئة تُعرض سياقاً');
  assert.equal(x.actual, 44);
  assert.equal(x.error, 4, 'الخطأ 4 لا 28');
  assert.equal(r.summary.bias, 4);
});

test('مندوب لا يُفرغ سيارته لا يُنتج انحياز نقص وهمياً', () => {
  // ثلاثة أيام، التنبّؤ 40 والطلب 40، لكن كمية التعبئة صغيرة لأن السيارة ممتلئة
  const r = run({
    loads: [1, 2, 3].map((d) => ({
      id: `L${d}`, at: at(d),
      items: [{ productId: 'p1', qty: 5, suggestedQty: 5, expectedQty: 40 }],
    })),
    sales: [1, 2, 3].map((d) => ({ productId: 'p1', qty: 40, at: at(d, 12) })),
  });
  assert.equal(r.summary.measured, 3);
  assert.equal(r.summary.bias, 0, 'لا انحياز — التنبّؤ مطابق');
  assert.equal(r.summary.mae, 0);
  assert.match(r.summary.verdict, /لا انحياز واضح/);
});

/* ══════ وحدة القياس يوم تقويمي ══════ */

test('تحميلان في اليوم نفسه: تنبّؤ واحد لليوم لا تنبّؤان', () => {
  // تحميل صباحي ثم عودة للمستودع لتكملة نقص. الحساب القديم كان يعطي نافذة
  // 25 دقيقة للأول فيصير خطؤه = كامل التنبّؤ، ثم يلتقط الثاني كل المبيعات.
  const r = run({
    loads: [
      { id: 'L1', at: at(2, 6), items: [{ productId: 'p1', qty: 30, suggestedQty: 30, expectedQty: 40 }] },
      { id: 'L2', at: at(2, 7), items: [{ productId: 'p1', qty: 10, suggestedQty: 10, expectedQty: 40 }] },
    ],
    sales: [
      { productId: 'p1', qty: 20, at: at(2, 9) },
      { productId: 'p1', qty: 18, at: at(2, 14) },
    ],
  });
  assert.equal(r.summary.measured, 1, 'يوم واحد لا يومان');
  const x = on(r, 2);
  assert.equal(x.expected, 40, 'التنبّؤ لا يُضاعَف');
  assert.equal(x.loaded, 40, 'والمُحمَّل يُجمَع');
  assert.equal(x.actual, 38);
  assert.equal(x.error, -2);
  assert.equal(r.summary.mae, 2, 'لا 29 كما في التصميم السابق');
});

test('مندوب يُحمّل كل ثلاثة أيام لا يُتّهم بنقص ثلاثة أضعاف', () => {
  // التنبّؤ ليوم واحد. الحساب القديم كان يجمع مبيعات ثلاثة أيام في نافذة
  // واحدة فيعلن نقصاً بـ74 وحدة بلا أي خطأ في التنبّؤ.
  const r = run({
    loads: [{ id: 'L1', at: at(5), items: [{ productId: 'p1', qty: 140, suggestedQty: 140, expectedQty: 40 }] }],
    sales: [
      { productId: 'p1', qty: 40, at: at(5, 12) },
      { productId: 'p1', qty: 40, at: at(4, 12) },
      { productId: 'p1', qty: 40, at: at(3, 12) },
    ],
  });
  assert.equal(r.summary.measured, 1, 'يوم التحميل وحده يُقاس');
  assert.equal(on(r, 5).actual, 40, 'طلب يوم التحميل فقط');
  assert.equal(on(r, 5).error, 0);
});

test('أيام بلا تحميل لا تُقاس — لا تنبّؤ لها أصلاً', () => {
  const r = run({
    loads: [{ id: 'L1', at: at(4), items: [{ productId: 'p1', qty: 10, suggestedQty: 10, expectedQty: 10 }] }],
    sales: [
      { productId: 'p1', qty: 10, at: at(4, 12) },
      { productId: 'p1', qty: 999, at: at(3, 12) }, // يوم بلا تحميل
    ],
  });
  assert.equal(r.summary.measured, 1);
  assert.equal(r.summary.mae, 0);
});

/* ══════ اليوم الجاري مستبعَد ══════ */

test('تحميل اليوم لا يدخل التجميع — بيعه لم يكتمل', () => {
  const r = run({
    loads: [{ id: 'L1', at: at(0), items: [{ productId: 'p1', qty: 40, suggestedQty: 40, expectedQty: 40 }] }],
    sales: [{ productId: 'p1', qty: 5, at: at(0, 10) }],
  });
  assert.equal(r.summary.measured, 0);
  assert.equal(r.summary.pending, 1);
  assert.equal(r.summary.mae, null);
  assert.equal(on(r, 0).open, true);
  assert.match(r.summary.verdict, /ما زال قيد البيع/);
});

test('يوم أمس مكتمل فيُقاس', () => {
  const r = run({
    loads: [{ id: 'L1', at: at(1), items: [{ productId: 'p1', qty: 40, suggestedQty: 40, expectedQty: 40 }] }],
    sales: [{ productId: 'p1', qty: 36, at: at(1, 15) }],
  });
  assert.equal(r.summary.measured, 1);
  assert.equal(on(r, 1).error, -4);
});

/* ══════ المرتجعات ══════ */

test('مرتجع اليوم يُخصم من طلبه', () => {
  const r = run({
    loads: [{ id: 'L1', at: at(2), items: [{ productId: 'p1', qty: 40, suggestedQty: 40, expectedQty: 40 }] }],
    sales: [
      { productId: 'p1', qty: 40, at: at(2, 10) },
      { productId: 'p1', qty: 6, at: at(2, 16), isReturn: true },
    ],
  });
  assert.equal(on(r, 2).actual, 34);
});

test('مرتجع يفوق البيع لا يجعل الطلب سالباً', () => {
  const r = run({
    loads: [{ id: 'L1', at: at(2), items: [{ productId: 'p1', qty: 40, suggestedQty: 40, expectedQty: 40 }] }],
    sales: [
      { productId: 'p1', qty: 3, at: at(2, 10) },
      { productId: 'p1', qty: 30, at: at(2, 16), isReturn: true },
    ],
  });
  assert.equal(on(r, 2).actual, 0);
  assert.equal(on(r, 2).error, -40);
});

/* ══════ التبنّي وما لا يُقاس ══════ */

test('بند بلا تنبّؤ لا يُقاس ولا يُلفَّق «دقيقاً»', () => {
  const r = run({
    loads: [{ id: 'L1', at: at(2), items: [
      { productId: 'p1', qty: 10, suggestedQty: null, expectedQty: null },
    ] }],
    sales: [{ productId: 'p1', qty: 10, at: at(2, 12) }],
  });
  assert.equal(r.summary.unmeasured, 1);
  assert.equal(r.summary.measured, 0);
  assert.equal(r.days.length, 0);
  assert.match(r.summary.verdict, /لم يُحمَّل شيء بناءً على اقتراح/);
});

test('التبنّي يقيس المُحمَّل مقابل كمية التعبئة لا مقابل التنبّؤ', () => {
  const r = run({
    loads: [
      { id: 'L1', at: at(3), items: [{ productId: 'p1', qty: 16, suggestedQty: 16, expectedQty: 40 }] },
      { id: 'L2', at: at(2), items: [{ productId: 'p1', qty: 90, suggestedQty: 16, expectedQty: 40 }] },
    ],
    sales: [],
  });
  assert.equal(r.summary.measured, 2);
  assert.equal(on(r, 3).adopted, true, '16 = 16 رغم أن التنبّؤ 40');
  assert.equal(on(r, 2).adopted, false);
  assert.equal(r.summary.adoptionRate, 50);
  assert.match(r.summary.verdict, /50٪ فقط كما اقتُرح/);
});

/* ══════ الانحياز مقابل الخطأ المطلق ══════ */

test('خطآن متعاكسان: الانحياز صفر والخطأ المطلق يكشفهما', () => {
  const r = run({
    loads: [3, 2].map((d) => ({
      id: `L${d}`, at: at(d),
      items: [{ productId: 'p1', qty: 10, suggestedQty: 10, expectedQty: 10 }],
    })),
    sales: [{ productId: 'p1', qty: 20, at: at(3, 12) }],
  });
  assert.equal(r.summary.bias, 0);
  assert.equal(r.summary.mae, 10);
  assert.equal(r.summary.under, 1);
  assert.equal(r.summary.over, 1);
});

test('انحياز للنقص ⇒ توصية برفع الهامش', () => {
  const r = run({
    loads: [3, 2].map((d) => ({
      id: `L${d}`, at: at(d),
      items: [{ productId: 'p1', qty: 10, suggestedQty: 10, expectedQty: 10 }],
    })),
    sales: [
      { productId: 'p1', qty: 18, at: at(3, 12) },
      { productId: 'p1', qty: 16, at: at(2, 12) },
    ],
  });
  assert.ok(r.summary.bias! > 0);
  assert.match(r.summary.verdict, /النقص/);
  assert.match(r.summary.verdict, /ارفع هامش الأمان/);
});

test('النسبة على مجموع التنبّؤ لا كمتوسط نِسَب', () => {
  const r = computeAccuracy({
    now: NOW,
    products: [
      { id: 'a', name: 'صغير', code: 'A', unit: 'ح' },
      { id: 'b', name: 'كبير', code: 'B', unit: 'ح' },
    ],
    loads: [{ id: 'L1', at: at(2), items: [
      { productId: 'a', qty: 2, suggestedQty: 2, expectedQty: 2 },
      { productId: 'b', qty: 200, suggestedQty: 200, expectedQty: 200 },
    ] }],
    sales: [{ productId: 'b', qty: 198, at: at(2, 12) }],
  });
  // الخطأ: a=2 · b=2 ⇒ 4 على تنبّؤ 202 ⇒ 1.98٪ (ومتوسط النِسَب كان سيعطي ~50٪)
  assert.equal(r.summary.maePct, 1.98);
});

/* ══════ المتانة ══════ */

test('لا تحميلات ⇒ حكم صريح بلا انهيار', () => {
  const r = run({});
  assert.equal(r.summary.measured, 0);
  assert.equal(r.summary.adoptionRate, null);
  assert.match(r.summary.verdict, /لم يُحمَّل شيء/);
});

test('تواريخ فاسدة تُتجاهَل', () => {
  const r = run({
    loads: [
      { id: 'BAD', at: 'ليس تاريخاً', items: [{ productId: 'p1', qty: 5, suggestedQty: 5, expectedQty: 5 }] },
      { id: 'L1', at: at(2), items: [{ productId: 'p1', qty: 10, suggestedQty: 10, expectedQty: 10 }] },
    ],
    sales: [{ productId: 'p1', qty: 10, at: 'تاريخ فاسد' }],
  });
  assert.equal(r.summary.measured, 1);
  assert.equal(on(r, 2).actual, 0);
});

test('صنف آخر لا يلوّث قياس صنفنا', () => {
  const r = run({
    loads: [{ id: 'L1', at: at(2), items: [{ productId: 'p1', qty: 10, suggestedQty: 10, expectedQty: 10 }] }],
    sales: [{ productId: 'OTHER', qty: 999, at: at(2, 12) }],
  });
  assert.equal(on(r, 2).actual, 0);
});

test('التحميلات غير المرتّبة: الأوّل زمنياً هو صاحب التنبّؤ', () => {
  const r = run({
    loads: [
      { id: 'L2', at: at(2, 7), items: [{ productId: 'p1', qty: 10, suggestedQty: 10, expectedQty: 99 }] },
      { id: 'L1', at: at(2, 6), items: [{ productId: 'p1', qty: 30, suggestedQty: 30, expectedQty: 40 }] },
    ],
    sales: [{ productId: 'p1', qty: 40, at: at(2, 12) }],
  });
  assert.equal(on(r, 2).expected, 40, 'تنبّؤ التحميل الأبكر لا الأحدث');
  assert.equal(on(r, 2).loaded, 40);
});
