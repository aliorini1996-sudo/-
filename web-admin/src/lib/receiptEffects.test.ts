import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { invalidateAfterReceipt, RECEIPT_TOUCHES } from './receiptEffects';

function spy() {
  const seen: string[] = [];
  return {
    seen,
    client: { invalidateQueries: (o: { queryKey: readonly unknown[] }) => { seen.push(o.queryKey.join('/')); } },
  };
}

test('السند يبطل قائمة الفواتير — الخلل الأصلي الذي ابقى الفاتورة غير مدفوعة', () => {
  const s = spy();
  invalidateAfterReceipt(s.client);
  assert.ok(s.seen.includes('invoices'), 'قائمة الفواتير يجب ان تبطل والا بقي المتبقي القديم معروضا');
  assert.ok(s.seen.includes('m-docs/invoice'), 'وقائمة فواتير الجوال كذلك');
});

test('يبطل رصيد العميل ولوحة التحكم ايضا — السند يغير الثلاثة معا', () => {
  const s = spy();
  invalidateAfterReceipt(s.client);
  for (const k of ['customers', 'dashboard', 'm-customers', 'm-dashboard']) {
    assert.ok(s.seen.includes(k), `مفتاح ${k} غير مبطل`);
  }
});

test('يبطل السندات نفسها — السلوك القديم لم يسقط', () => {
  const s = spy();
  invalidateAfterReceipt(s.client);
  assert.ok(s.seen.includes('receipts'));
  assert.ok(s.seen.includes('m-docs/receipt'));
});

test('لا مفتاح مكرر — الابطال المكرر طلب شبكة بلا سبب', () => {
  const keys = RECEIPT_TOUCHES.map(k => k.join('/'));
  assert.equal(new Set(keys).size, keys.length, 'يوجد مفتاح مكرر في القائمة');
});

test('كل موضع يصدر سندا او يلغيه ينادي الدالة — لا ترقيع يدوي ينسى مفتاحا', () => {
  const root = process.cwd();
  const files = [
    ['src', 'pages', 'ReceiptsPage.tsx'],
    ['src', 'm', 'MReceiptCreate.tsx'],
    ['src', 'm', 'MDocList.tsx'],
  ];
  for (const parts of files) {
    const p = path.join(root, ...parts);
    assert.ok(fs.existsSync(p), `ملف غير موجود: ${p}`);
    const s = fs.readFileSync(p, 'utf8');
    assert.match(s, /invalidateAfterReceipt\(/, `${parts.join('/')} لا ينادي invalidateAfterReceipt`);
  }
});
