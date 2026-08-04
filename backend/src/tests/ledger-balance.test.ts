/**
 * اشتقاق الرصيد الجاري في كشف الحساب — `deriveRunningBalances`.
 *
 * الخلل الذي تحرسه هذه المتجهات: كان الرصيد يُقرأ من `balance` المخزَّن في القيد،
 * وهو لقطةٌ لحظةَ الكتابة. فحالتان تكسرانه:
 *   • **الفاتورة النقدية**: قيدان بنفس `entryDate` وبنفس `createdAt` (دالّة `now()`
 *     في بوستجرس ثابتة طوال المعاملة) — فترتيبهما بيد القاعدة، وقد يظهر التحصيل
 *     قبل فاتورته فيرتفع الرصيد بعد السداد أمام عين العميل.
 *   • **القيد بأثر رجعي**: يأخذ أساسه من رصيد أحدث قيد، فيُخزَّن برصيدٍ لا صلة له
 *     بموضعه الزمني، وتتعطّل كل الأسطر التي بعده.
 *
 * الاشتقاق يجعل كل سطر ناتجَ سابقه بالضرورة — وهذا ما تتحقّق منه هذه الاختبارات.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { deriveRunningBalances } from '../services/accounting';

// قيدٌ مبسّط بالحقول التي يعنيها الاشتقاق، مع `balance` مخزَّن **خاطئ عمداً**
// للتأكّد من أنّه لا يُقرأ أصلاً
const E = (debit: number, credit: number, storedBalance = 999999) =>
  ({ debit, credit, balance: storedBalance, description: '' });

test('يبدأ من الرصيد المُرحَّل ويجمع كل سطر على سابقه', () => {
  const r = deriveRunningBalances([E(1000, 0), E(0, 400), E(250, 0)], 500);
  assert.deepEqual(r.map((x) => x.balance), [1500, 1100, 1350]);
});

test('بلا رصيد مُرحَّل يبدأ من الصفر', () => {
  const r = deriveRunningBalances([E(300, 0), E(0, 300)]);
  assert.deepEqual(r.map((x) => x.balance), [300, 0]);
});

test('الفاتورة النقدية: مدين ثم دائن بنفس المبلغ ⇒ الرصيد يعود كما كان', () => {
  const r = deriveRunningBalances([E(1150, 0), E(0, 1150)], 2000);
  assert.deepEqual(r.map((x) => x.balance), [3150, 2000]);
});

test('لا يُقرأ الرصيد المخزَّن مهما كان فاسداً', () => {
  // أرصدة مخزّنة عشوائية تماماً — لو قُرئت لظهرت في النتيجة
  const r = deriveRunningBalances([E(100, 0, -77), E(0, 40, 12345), E(60, 0, 0)], 0);
  assert.deepEqual(r.map((x) => x.balance), [100, 60, 120]);
});

test('كل سطر = سابقه + مدينه − دائنه (ثابت البنية)', () => {
  const rows = [E(10, 0), E(0, 3.5), E(7.25, 0), E(0, 13.75), E(100, 0)];
  const opening = 42.5;
  const r = deriveRunningBalances(rows, opening);
  let prev = opening;
  for (const row of r) {
    assert.equal(row.balance, Math.round((prev + row.debit - row.credit) * 1e6) / 1e6);
    prev = row.balance;
  }
});

test('الرصيد الختامي = المُرحَّل + Σمدين − Σدائن', () => {
  const rows = [E(1200, 0), E(0, 500), E(0, 300), E(75.5, 0)];
  const r = deriveRunningBalances(rows, 1000);
  const expected = 1000 + rows.reduce((s, x) => s + x.debit - x.credit, 0);
  assert.equal(r[r.length - 1].balance, Math.round(expected * 1e6) / 1e6);
});

test('لا يتراكم غبار الفاصلة العائمة عبر مئات القيود', () => {
  // 0.1 + 0.2 = 0.30000000000000004 — بلا تنظيف تتضخّم عبر التكرار
  const rows = Array.from({ length: 300 }, () => E(0.1, 0));
  const r = deriveRunningBalances(rows, 0);
  assert.equal(r[r.length - 1].balance, 30);
  assert.equal(r[2].balance, 0.3);
});

test('كشف فارغ يُرجع مصفوفة فارغة ولا يرمي', () => {
  assert.deepEqual(deriveRunningBalances([], 750), []);
});

test('لا يُعدّل الاشتقاق مصفوفة الدخل ولا عناصرها', () => {
  const rows = [E(100, 0, 5), E(0, 40, 5)];
  const snapshot = JSON.stringify(rows);
  deriveRunningBalances(rows, 0);
  assert.equal(JSON.stringify(rows), snapshot, 'الدالّة الصرفة لا تمسّ دخلها');
});

test('الأرصدة السالبة (دفعة مقدَّمة) تُشتقّ كما هي', () => {
  const r = deriveRunningBalances([E(0, 500), E(200, 0)], 0);
  assert.deepEqual(r.map((x) => x.balance), [-500, -300]);
});
