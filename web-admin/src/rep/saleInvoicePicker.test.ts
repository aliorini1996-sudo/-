// اختيار فاتورة البيع للمرتجع (SaleInvoicePicker.tsx) — حارسٌ نصّي لدرسٍ كشفته المراجعة: `tr` من useTr تتجدّد في كل رسم،
// فوضعها في اعتماديات تأثير التحميل كان يعيد طلب فواتير العميل بلا نهاية (وحلقة رسمٍ تجمّد الجوال دون اتصال).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), 'src', rel), 'utf8').replace(/\r\n/g, '\n');

test('التحميل مرّةً لكل عميل — لا `tr` في اعتماديات التأثير', () => {
  const src = read('rep/SaleInvoicePicker.tsx');
  assert.match(src, /\}, \[customerId\]\);/, 'اعتماديات التحميل');
  assert.doesNotMatch(src, /\[customerId, tr\]/, 'tr في الاعتماديات تعيد الطلب في كل رسم');
});

test('بند فاتورة البيع يحفظ سعر استرداده — أسعار العميل المتأخّرة لا تستبدله', () => {
  const app = read('rep/RepApp.tsx');
  const i = app.indexOf('setLines(prev => prev.map(l => {');
  assert.ok(i > 0);
  assert.match(app.slice(i, i + 300), /if \(l\.saleItemId\) return l;/);
});
