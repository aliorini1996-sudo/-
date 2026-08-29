import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillAllocationsFifo, allocatableCeiling } from '../services/allocate';

/**
 * حرّاس توزيع سند القبض على الفواتير.
 *
 * التوزيع صار إلزامياً — وهذه الدالة هي ضمانة الخادم التي تمنع سنداً طافياً
 * مهما كان مصدره (أوف‑لاين، تطبيق إدارة، تكامل). الثوابت المحروسة:
 *  ١ لا يُوزَّع أكثر من مبلغ السند.  ٢ لا تُسدَّد فاتورة فوق متبقّيها.
 *  ٣ الفائض عن مديونية العميل يبقى رصيداً دائناً لا يُبتلع.
 */

const inv = (id: string, remainingAmt: number, day: number) =>
  ({ id, remainingAmt, invoiceDate: new Date(2026, 7, day) });

test('التوزيع الآلي يبدأ بالأقدم ثم ينتقل للأحدث', () => {
  const out = fillAllocationsFifo(1500, [], [
    inv('c', 900, 20),   // الأحدث
    inv('a', 1000, 5),   // الأقدم
    inv('b', 400, 12),
  ]);
  assert.deepEqual(out, [
    { invoiceId: 'a', amount: 1000 },
    { invoiceId: 'b', amount: 400 },
    { invoiceId: 'c', amount: 100 },
  ]);
});

test('لا يُسدَّد فوق متبقّي الفاتورة ولا فوق مبلغ السند', () => {
  const out = fillAllocationsFifo(5000, [], [inv('a', 300, 1), inv('b', 200, 2)]);
  const sum = out.reduce((s, o) => s + o.amount, 0);
  assert.equal(sum, 500, 'وزّع أكثر من مديونية العميل');
  assert.ok(out.every(o => o.amount <= 300), 'تجاوز متبقّي فاتورة');
});

test('الفائض عن المديونية يبقى رصيداً دائناً — لا يُقحَم على فاتورة', () => {
  const out = fillAllocationsFifo(1000, [], [inv('a', 250, 1)]);
  assert.deepEqual(out, [{ invoiceId: 'a', amount: 250 }]);
  const sum = out.reduce((s, o) => s + o.amount, 0);
  assert.equal(sum, 250, 'الفائض ٧٥٠ يجب أن يبقى دائناً لا موزَّعاً');
});

test('ما وزّعه المستخدم يدوياً يبقى كما هو والباقي يُكمَّل آلياً', () => {
  const out = fillAllocationsFifo(1000, [{ invoiceId: 'b', amount: 400 }], [
    inv('a', 700, 1), inv('b', 700, 9),
  ]);
  const byId = Object.fromEntries(out.map(o => [o.invoiceId, o.amount]));
  assert.equal(byId.b, 400, 'غُيّر تخصيص المستخدم اليدوي');
  assert.equal(byId.a, 600, 'لم يُكمَّل الباقي على الأقدم');
});

test('التكملة تحترم ما خُصِّص يدوياً لنفس الفاتورة فلا تتجاوز متبقّيها', () => {
  const out = fillAllocationsFifo(1000, [{ invoiceId: 'a', amount: 200 }], [inv('a', 500, 1), inv('b', 900, 4)]);
  const byId = Object.fromEntries(out.map(o => [o.invoiceId, o.amount]));
  assert.equal(byId.a, 500, 'الفاتورة أ يجب أن تكتمل عند متبقّيها ٥٠٠ لا أكثر');
  assert.equal(byId.b, 500);
});

test('سند بلا فواتير مفتوحة يمر بلا توزيع (دفعة مقدَّمة)', () => {
  assert.deepEqual(fillAllocationsFifo(500, [], []), []);
});

test('التخصيص اليدوي الكامل لا يُضاف إليه شيء', () => {
  const out = fillAllocationsFifo(300, [{ invoiceId: 'a', amount: 300 }], [inv('a', 900, 1)]);
  assert.deepEqual(out, [{ invoiceId: 'a', amount: 300 }]);
});

test('سقف التوزيع = الأصغر بين المبلغ والمديونية — ما تطالب به الواجهة', () => {
  assert.equal(allocatableCeiling(1000, [inv('a', 250, 1), inv('b', 300, 2)]), 550);
  assert.equal(allocatableCeiling(400, [inv('a', 250, 1), inv('b', 300, 2)]), 400);
  assert.equal(allocatableCeiling(400, []), 0);
});

test('الكسور: مجموع التوزيع لا ينحرف بغبار العائمة', () => {
  const out = fillAllocationsFifo(344.85, [], [inv('a', 114.95, 1), inv('b', 114.95, 2), inv('c', 114.95, 3)]);
  const halalas = out.reduce((s, o) => s + Math.round(o.amount * 100), 0);
  assert.equal(halalas, 34485, 'انحرف مجموع التوزيع عن مبلغ السند');
});

test('المبلغ غير الصالح لا ينتج توزيعا', () => {
  for (const bad of [0, -100, Number.NaN]) {
    assert.deepEqual(fillAllocationsFifo(bad as number, [], [inv('a', 500, 1)]), []);
  }
});
