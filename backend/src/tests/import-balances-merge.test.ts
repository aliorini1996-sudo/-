// البندان 10 و8 (مراجعة استيراد البيانات 2026-09-17): دمج صفوف العميل في /balances، وأخطاء صفوف /ledger. منطق صرف بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupLedgerRows, importWriteFailure, mergeBalanceRows, type ResolvedBalanceRow } from '../services/importLedger';
import { buildCustomerMatcher } from '../services/importMatch';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const d = (s: string) => new Date(`${s}T00:00:00+03:00`);

test('سيناريو البند 10: العميل X بثلاثة أسطر 1000 و2500 و700 ⇒ قيد واحد 4200 بأحدث تاريخ، مع تنبيه merged', () => {
  const rows: ResolvedBalanceRow[] = [
    { row: 2, customerId: 'x', customerName: 'العميل X', amount: 1000, date: d('2026-06-30') },
    { row: 3, customerId: 'y', customerName: 'العميل Y', amount: 50, date: d('2026-08-01') },
    { row: 4, customerId: 'x', customerName: 'العميل X', amount: 2500, date: d('2026-08-31') },
    { row: 5, customerId: 'x', customerName: 'العميل X', amount: 700, date: d('2026-07-15') },
  ];
  const out = mergeBalanceRows(rows, 2);
  assert.equal(out.items.length, 2);
  const x = out.items.find((i) => i.customerId === 'x')!;
  assert.equal(x.amount, 4200);
  assert.deepEqual(x.rows, [2, 4, 5]);
  assert.equal(x.date.getTime(), d('2026-08-31').getTime());
  assert.deepEqual(out.merged, [{ customerName: 'العميل X', rows: [2, 4, 5], total: 4200 }]);
  assert.equal(out.zero, 0);
  assert.deepEqual(out.items.map((i) => i.customerId), ['x', 'y'], 'ترتيب أول ظهور');
});

test('سيناريو البند 10: مدين 5000 ودائن 1200 ⇒ 3800؛ والمتعادل بعد الدمج لا يُكتب ويُعدّ zero؛ والمجموع بالتقريب المقرّب', () => {
  const out = mergeBalanceRows([
    { row: 2, customerId: 'a', customerName: 'أ', amount: 5000, date: d('2026-08-31') },
    { row: 3, customerId: 'a', customerName: 'أ', amount: -1200, date: d('2026-08-31') },
    { row: 4, customerId: 'b', customerName: 'ب', amount: 300, date: d('2026-08-31') },
    { row: 5, customerId: 'b', customerName: 'ب', amount: -300, date: d('2026-08-31') },
    { row: 6, customerId: 'c', customerName: 'ج', amount: 0.004, date: d('2026-08-31') },
    { row: 7, customerId: 'e', customerName: 'هـ', amount: 1.005, date: d('2026-08-31') },
    { row: 8, customerId: 'e', customerName: 'هـ', amount: 2.005, date: d('2026-08-31') },
  ], 2);
  assert.deepEqual(out.items.map((i) => [i.customerId, i.amount]), [['a', 3800], ['e', 3.02]]);
  assert.equal(out.zero, 2);
  assert.deepEqual(out.merged.map((m) => [m.customerName, m.total]), [['أ', 3800], ['ب', 0], ['هـ', 3.02]]);
});

test('سيناريو البند 8: 3000 صف كشف لعملاء غير موجودين ⇒ 3000 خطأ CUSTOMER_NOT_FOUND، بلا مجموعات ولا تخطٍّ', () => {
  const matcher = buildCustomerMatcher([{ id: 'c1', code: 'K-1', phone: '0501234567', name: 'قائم' }]);
  const rows = Array.from({ length: 3000 }, (_, i) => ({ customerName: `غير موجود ${i}`, debit: 10, credit: 0 }));
  const dates = rows.map(() => d('2026-08-31'));
  const g = groupLedgerRows(rows, matcher, dates, 2);
  assert.equal(g.errors.length, 3000);
  assert.ok(g.errors.every((e, i) => e.code === 'CUSTOMER_NOT_FOUND' && e.row === i + 2 && e.message === 'العميل غير موجود استورد العملاء أولا'));
  assert.equal(g.groups.size, 0);
  assert.equal(g.zero, 0);
});

test('/ledger: المطابَق يُجمَّع مقرّباً، والملتبس خطأ بقيمته، والصفري بعد التقريب zero', () => {
  const matcher = buildCustomerMatcher([
    { id: 'c1', code: 'K-1', phone: '0501234567', name: 'قائم' },
    { id: 'b1', code: 'B-1', phone: '0555000000', name: 'فرع 1' },
    { id: 'b2', code: 'B-2', phone: '0555000000', name: 'فرع 2' },
  ]);
  const rows = [
    { customerCode: 'K-1', debit: 1.005, credit: 0, description: 'فاتورة' },
    { phone: '0555000000', debit: 10 },
    { customerName: 'قائم', debit: 0.001, credit: 0.004 },
    { phone: '+966501234567', credit: 20 },
  ];
  const g = groupLedgerRows(rows, matcher, rows.map(() => d('2026-08-31')), 2);
  assert.deepEqual(g.errors, [{ row: 3, code: 'CUSTOMER_AMBIGUOUS', message: 'مطابقة ملتبسة: أكثر من عميل بهذا الجوال أو الاسم، أضف كود العميل', value: '0555000000' }]);
  assert.equal(g.zero, 1);
  assert.deepEqual(g.groups.get('c1')!.map((e) => [e.row, e.debit, e.credit]), [[2, 1.01, 0], [5, 0, 20]]);
  // فشل مجموعة ⇒ خطأ لكل صف: P2002 ⇒ ROW_CONFLICT، وغيره الرسالة الخام
  assert.equal(importWriteFailure(9, Object.assign(new Error('x'), { code: 'P2002' })).code, 'ROW_CONFLICT');
  assert.deepEqual(importWriteFailure(9, new Error('boom'.repeat(50))), { row: 9, code: 'ROW_WRITE_FAILED', message: 'boom'.repeat(35) });
});

test('حارس ثابت: /balances يدمج قبل الكتابة وفشل العميل خطأ لكل صف، و/ledger فشل المجموعة خطأ لكل صف وzero في الرد', () => {
  const src = read('routes/import.ts');
  const body = (m: string) => { const i = src.indexOf(m); return src.slice(i, src.indexOf('\n});', i)); };
  const bal = body("router.post('/balances'");
  assert.match(bal, /mergeBalanceRows\(resolved, ctx\.decimals\)/);
  assert.match(bal, /onItemError: \(item, e\) => \{ for \(const row of item\.rows\) result\.errors\.push\(importWriteFailure\(row, e\)\); \}/);
  assert.match(bal, /zero: 0/);
  assert.doesNotMatch(bal, /if \(!amount\) \{ result\.skipped\+\+/);
  const led = body("router.post('/ledger'");
  assert.match(led, /onItemError: \(g, e\) => \{ for \(const en of g\.entries\) result\.errors\.push\(importWriteFailure\(en\.row, e\)\); \}/);
  assert.match(led, /result\.zero = grouped\.zero;/);
  assert.match(led, /skipped: 0, zero: 0/);
});
