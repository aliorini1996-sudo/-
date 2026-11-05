import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RETURN_CANCEL_BUCKET_LABELS, RETURN_CANCEL_TEXT, cachedProduct, cachedProductName, returnCancelShortOf, returnCancelShortText } from './returnCancelStock';
import { baseQtyText } from './adminUnits';
import { PHRASES } from '../i18n/strings';

const err = (data: unknown) => ({ response: { status: 409, data } });
const id = (s: string) => s;

test('409 RETURN_CANCEL_STOCK_SHORT يُقرأ بأسطره (الدلو موحّداً، والصنف والدلو مرةً) — وغيره null', () => {
  const s = returnCancelShortOf(err({ success: false, code: 'RETURN_CANCEL_STOCK_SHORT', message: 'خرجت', lines: [
    { productId: 'a', availableBase: 3, requiredBase: 12, bucket: 'sellable' },
    { productId: 'a', availableBase: 3, requiredBase: 12, bucket: 'sellable' },
    { productId: 'a', availableBase: 0, requiredBase: 2, bucket: 'expired' },
    { productId: 'b', availableBase: '1', requiredBase: 5 },
    { bucket: 'damaged' },
  ] }));
  assert.deepEqual(s, { message: 'خرجت', lines: [
    { productId: 'a', availableBase: 3, requiredBase: 12, bucket: 'SELLABLE' },
    { productId: 'a', availableBase: 0, requiredBase: 2, bucket: 'EXPIRED' },
    { productId: 'b', availableBase: 1, requiredBase: 5, bucket: 'SELLABLE' },
  ] });
  assert.equal(returnCancelShortOf(err({ code: 'LOT_STOCK_INSUFFICIENT' })), null);
  assert.equal(returnCancelShortOf(new Error('x')), null);
});

test('النصّ بأسماء الأصناف ومتاحها حين تُعرف، وإلا رسالة الخادم بعد الجملة', () => {
  const s = { message: 'رسالة الخادم', lines: [
    { productId: 'a', availableBase: 3, requiredBase: 12, bucket: 'SELLABLE' },
    { productId: 'b', availableBase: 0, requiredBase: 2, bucket: 'DAMAGED' },
  ] };
  const names: Record<string, string> = { a: 'ماء', b: 'عصير' };
  assert.equal(returnCancelShortText(s, id, pid => names[pid]),
    'لا يمكن لأن رصيد السيارة سيصير سالبا — ماء: المتاح 3 · المطلوب سحبه 12، عصير (المرتجع التالف): المتاح 0 · المطلوب سحبه 2 — سجل تحميلا أو تسوية للسيارة أولا');
  assert.equal(returnCancelShortText(s, id, pid => (pid === 'a' ? 'ماء' : null)), 'لا يمكن لأن رصيد السيارة سيصير سالبا — رسالة الخادم');
  assert.equal(returnCancelShortText({ message: '', lines: [] }, id, () => null),
    `${RETURN_CANCEL_TEXT.lead} — ${RETURN_CANCEL_TEXT.hint}`);
});

test('اسم الصنف من قوائم الأصناف المخزّنة — لا طلب شبكة', () => {
  const cache: Record<string, unknown> = { 'products-min': [{ id: 'a', name: 'ماء' }], 'products-all': 'bad' };
  assert.equal(cachedProductName(k => cache[String(k[0])], 'a'), 'ماء');
  assert.equal(cachedProductName(k => cache[String(k[0])], 'z'), null);
});

test('الكميات بوحدات الصنف المخزّن («2 كرتون و3 حبة») لا رقماً مجرّداً', () => {
  const cache: Record<string, unknown> = {
    'products-all': [{ id: 'a', name: 'ماء', unit: 'حبة', units: [{ id: 'c', name: 'كرتون', factor: 12 }], primaryUnitId: null }],
  };
  const get = (k: readonly unknown[]) => cache[String(k[0])];
  assert.deepEqual(cachedProduct(get, 'a')?.units, [{ id: 'c', name: 'كرتون', factor: 12 }]);
  assert.equal(cachedProduct(get, 'z'), null);
  const s = { message: '', lines: [{ productId: 'a', availableBase: 3, requiredBase: 27, bucket: 'SELLABLE' }] };
  const fmt = (x: number) => String(Number(x.toFixed(4)));
  const text = returnCancelShortText(s, id, pid => cachedProductName(get, pid), (pid, n) => baseQtyText(n, cachedProduct(get, pid), fmt, { withUnit: true }));
  assert.match(text, /المتاح 3 حبة/);
  assert.match(text, /المطلوب سحبه 2 كرتون/);
  assert.match(text, /3 حبة — سجل تحميلا أو تسوية للسيارة أولا$/);
});

test('نصوص الرفض مترجمة باللغات الأربع', () => {
  for (const key of [...Object.values(RETURN_CANCEL_TEXT), ...Object.values(RETURN_CANCEL_BUCKET_LABELS)]) {
    const row = PHRASES[key];
    assert.ok(row, `لا ترجمة: ${key}`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(row[lang]?.trim(), `${lang} فارغة: ${key}`);
  }
});

test('الإلغاء وإطفاء العودة والسحب يقرأون الرفض في الصفحتين', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
  const page = read('pages', 'InvoicesPage.tsx');
  assert.equal((page.match(/if \(cancelShortToast\(err\)\)/g) ?? []).length, 3, 'الإلغاء وعودة المرتجع وسحب الإشعار');
  assert.match(read('components', 'zatca', 'ZatcaDocsPanel.tsx'), /returnCancelShortOf\(err\)/);
  // والإلغاء من تطبيق الإدارة على الجوال (/m) كذلك
  assert.match(read('m', 'MDocList.tsx'), /const short = returnCancelShortOf\(e\);\s*if \(short\) \{ toast\.error\(returnCancelShortText\(short, tr, \(\) => null\)/);
});
