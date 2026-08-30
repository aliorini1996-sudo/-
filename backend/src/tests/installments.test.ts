import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInstallments, validateInstallments, addPeriod, MAX_INSTALLMENTS,
} from '../services/installments';

/**
 * حرّاس جدولة الأقساط.
 *
 * الثابت الأول والأهم: **مجموع الأقساط = إجمالي الفاتورة بالضبط**. أي كسرٍ يضيع
 * هنا يبقى قرشاً معلَّقاً على العميل لا يُغلق به دَينه، وأي كسرٍ يزيد يجعله
 * يدفع فوق فاتورته. لذلك تُقاس المبالغ بالهللات الصحيحة لا بالعائمة.
 */

const plan = (count: number, startDate: string, period: 'MONTHLY' | 'WEEKLY' | 'SEMI_MONTHLY' = 'MONTHLY') =>
  ({ count, startDate, period });

const sumHalalas = (rows: { amount: number }[], dec = 2) =>
  rows.reduce((s, r) => s + Math.round(r.amount * Math.pow(10, dec)), 0);

test('القسمة غير المستوية: المجموع يساوي الإجمالي بالضبط والفارق في الأخير', () => {
  const rows = buildInstallments(1000, plan(3, '2026-09-01'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.amount), [333.33, 333.33, 333.34]);
  assert.equal(sumHalalas(rows), 100000, 'ضاع كسر من إجمالي الفاتورة');
});

test('القسمة المستوية: أقساط متساوية بلا فارق مصطنع', () => {
  const rows = buildInstallments(1200, plan(4, '2026-09-01'));
  assert.deepEqual(rows.map(r => r.amount), [300, 300, 300, 300]);
  assert.equal(sumHalalas(rows), 120000);
});

test('لا يتجاوز المجموعُ الإجماليَّ أبداً — التقريب لأسفل ثم التسوية في الأخير', () => {
  for (const total of [0.07, 7.77, 99.99, 1234.56, 10000.01]) {
    for (const n of [2, 3, 6, 7, 12]) {
      // ما لا يكفي عدد أقساطه يُرفض بذاته، ويحرسه اختبارٌ مستقلّ أدناه
      if (Math.round(total * 100) < n) continue;
      const rows = buildInstallments(total, plan(n, '2026-09-01'));
      assert.equal(sumHalalas(rows), Math.round(total * 100), `اختل المجموع عند ${total}/${n}`);
      assert.ok(rows.every(r => r.amount > 0), `قسط بصفر أو أقل عند ${total}/${n}`);
    }
  }
});

test('العملات الثلاثية الخانات: التقريب بخاناتها لا بخانتين', () => {
  const rows = buildInstallments(100, plan(3, '2026-09-01'), 3);
  assert.deepEqual(rows.map(r => r.amount), [33.333, 33.333, 33.334]);
  assert.equal(sumHalalas(rows, 3), 100000);
});

test('قسط واحد = الإجمالي كلّه', () => {
  const rows = buildInstallments(543.21, plan(1, '2026-09-01'));
  assert.deepEqual(rows, [{ seq: 1, dueDate: new Date('2026-09-01'), amount: 543.21 }]);
});

test('مدخلات غير صالحة لا تنتج جدولاً', () => {
  assert.deepEqual(buildInstallments(0, plan(3, '2026-09-01')), []);
  assert.deepEqual(buildInstallments(-100, plan(3, '2026-09-01')), []);
  assert.deepEqual(buildInstallments(1000, plan(0, '2026-09-01')), []);
});

test('سقف عدد الأقساط محروس', () => {
  assert.throws(() => buildInstallments(1000, plan(MAX_INSTALLMENTS + 1, '2026-09-01')), /الحد المسموح/);
  assert.equal(buildInstallments(1000, plan(MAX_INSTALLMENTS, '2026-09-01')).length, MAX_INSTALLMENTS);
});

test('تاريخ أول قسط غير صالح يُرفض صراحةً', () => {
  assert.throws(() => buildInstallments(1000, plan(3, 'ليس تاريخا')), /غير صالح/);
});

/**
 * الشهور بالتقويم لا بثلاثين يوماً: قسطٌ أوّله ٣١ يناير يستحقّ آخرَ فبراير لا
 * أن يقفز إلى مارس. وهذا فخّ `setMonth` الشهير في جافاسكربت.
 */
test('الاستحقاق الشهري لا يفيض إلى الشهر التالي', () => {
  const jan31 = new Date(2026, 0, 31);
  assert.equal(addPeriod(jan31, 'MONTHLY', 1).getMonth(), 1, 'قفز فبراير إلى مارس');
  assert.equal(addPeriod(jan31, 'MONTHLY', 1).getDate(), 28);
  assert.equal(addPeriod(jan31, 'MONTHLY', 2).getDate(), 31, 'مارس يعود إلى ٣١');
});

test('الدوريات: أسبوعي ونصف شهري بالأيام', () => {
  const d = new Date(2026, 8, 1);
  assert.equal(addPeriod(d, 'WEEKLY', 2).getDate(), 15);
  assert.equal(addPeriod(d, 'SEMI_MONTHLY', 1).getDate(), 16);
});

test('تواريخ الجدول تتقدّم ولا تتكرّر', () => {
  const rows = buildInstallments(1200, plan(12, '2026-01-31'));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].dueDate > rows[i - 1].dueDate, `القسط ${i + 1} ليس بعد سابقه`);
  }
});

// ═══ التحقّق من جدول أرسلته الواجهة ═══

test('الجدول اليدوي يُقبل حين يساوي مجموعه الإجمالي بالضبط', () => {
  const ok = validateInstallments(
    [{ dueDate: '2026-09-01', amount: 400 }, { dueDate: '2026-10-01', amount: 600 }], 1000,
  );
  assert.deepEqual(ok, { ok: true });
});

test('الجدول اليدوي يُرفض عند أي فارق ولو هللة', () => {
  const bad = validateInstallments(
    [{ dueDate: '2026-09-01', amount: 400 }, { dueDate: '2026-10-01', amount: 599.99 }], 1000,
  );
  assert.equal(bad.ok, false);
  assert.match((bad as { message: string }).message, /لا يساوي إجمالي الفاتورة/);
});

test('قسط بصفر أو سالب مرفوض', () => {
  for (const amount of [0, -50]) {
    const r = validateInstallments([{ dueDate: '2026-09-01', amount }], amount);
    assert.equal(r.ok, false, `قُبل قسط بمبلغ ${amount}`);
  }
});

test('الجدول الفارغ مرفوض — فاتورة تقسيط بلا أقساط لا معنى لها', () => {
  assert.equal(validateInstallments([], 1000).ok, false);
});

test('ما يبنيه الخادم يجتاز تحقّقه هو — الدالتان متّسقتان', () => {
  for (const total of [1000, 333.33, 9999.99, 0.5]) {
    for (const n of [1, 3, 7, 12]) {
      const rows = buildInstallments(total, plan(n, '2026-09-01'));
      assert.deepEqual(validateInstallments(rows, total), { ok: true }, `تعارض عند ${total}/${n}`);
    }
  }
});

/**
 * مبلغٌ أصغر من عدد أقساطه لا يقبل القسمة: خمس هللات على سبعة أقساط تعني
 * أقساطاً بصفر. تُرفض صراحةً بدل أن تُنتج جدولاً كاذباً — وهذا خللٌ كشفه
 * الاختبار في أول تشغيل، إذ كانت القسمة العائمة تُخرج أصفاراً بلا إنذار.
 */
test('مبلغ لا يكفي عدد أقساطه يُرفض ولا يُنتج قسطاً بصفر', () => {
  assert.throws(() => buildInstallments(0.05, plan(7, '2026-09-01')), /لا يكفي/);
  assert.throws(() => buildInstallments(0.02, plan(3, '2026-09-01')), /لا يكفي/);
  // الحدّ تماماً: ثلاث هللات على ثلاثة أقساط تمرّ بهللة لكلٍّ
  assert.deepEqual(buildInstallments(0.03, plan(3, '2026-09-01')).map(r => r.amount), [0.01, 0.01, 0.01]);
});
