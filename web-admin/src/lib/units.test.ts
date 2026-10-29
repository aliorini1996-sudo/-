import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatQty, refundAmount, toBase, baseQtyOf } from './units';

/**
 * نسخة الواجهة من قلب الحساب يجب أن تطابق نسخة الخادم حرفياً (بعد الترويسة).
 * تطبيق المندوب يطبع الفاتورة أوف‑لاين بهذه النسخة، والخادم يكتب السجلّ بتلك —
 * فاختلافهما يعني ورقةً في يد العميل تخالف ما في الدفاتر.
 */
test('حارس ثابت: lib/units.ts نسخة حرفية من backend/src/services/units.ts', () => {
  const body = (p: string) => {
    const s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    // الجسم بعد سطر «قلب الحساب» — الترويسة وحدها تختلف
    return s.slice(s.indexOf('/** الدقّة المخزَّنة'));
  };
  const web = body(path.join(process.cwd(), 'src', 'lib', 'units.ts'));
  const api = body(path.join(process.cwd(), '..', 'backend', 'src', 'services', 'units.ts'));
  assert.ok(web.length > 1000, 'لم يُعثر على جسم الملف');
  assert.equal(web, api, 'نسختا قلب الحساب افترقتا — انقل التعديل إلى الطرف الآخر');
});

test('الواجهة: العرض والتحويل والمرتجع كالخادم', () => {
  assert.equal(formatQty(51, [{ name: 'كرتون', factor: 24 }], 'حبة'), '2 كرتون و3 حبة');
  assert.equal(toBase(2, { unitFactor: 24 }), 48);
  assert.equal(baseQtyOf({ qty: 5, baseQty: null }), 5);
  let paid = 0;
  for (let i = 0; i < 24; i++) paid += refundAmount({ lineTotal: 10, qty: 1, unitFactor: 24 }, 1, i);
  assert.equal(Math.round(paid * 100) / 100, 10);
});
