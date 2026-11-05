import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arCountText, countText, countLead } from './arCount';
import { PHRASES } from '../i18n/strings';

/** تمييز العدد بالعربية (مراجعة المخزون S14): «6 صنفا» و«2 سيارة» و«1 سيارة» كانت تُقرأ خطأً */

const trEn = (k: string) => (PHRASES[k]?.en ?? k);

test('الصنف: واحد واثنان وثلاثة إلى عشرة وما فوقها — والمئات بآخر جزأيها', () => {
  assert.equal(arCountText(1, 'صنف'), 'صنف واحد');
  assert.equal(arCountText(2, 'صنف'), 'صنفان');
  assert.equal(arCountText(3, 'صنف'), '3 أصناف');
  assert.equal(arCountText(6, 'صنف'), '6 أصناف');
  assert.equal(arCountText(10, 'صنف'), '10 أصناف');
  assert.equal(arCountText(11, 'صنف'), '11 صنفاً');
  assert.equal(arCountText(99, 'صنف'), '99 صنفاً');
  assert.equal(arCountText(100, 'صنف'), '100 صنف');
  assert.equal(arCountText(102, 'صنف'), '102 صنف');
  assert.equal(arCountText(103, 'صنف'), '103 أصناف');
  assert.equal(arCountText(111, 'صنف'), '111 صنفاً');
  assert.equal(arCountText(0, 'صنف'), '0 صنف');
});

test('السيارة: «سيارة واحدة» و«سيارتان» و«3 سيارات» و«11 سيارة»', () => {
  assert.equal(arCountText(1, 'سيارة'), 'سيارة واحدة');
  assert.equal(arCountText(2, 'سيارة'), 'سيارتان');
  assert.equal(arCountText(5, 'سيارة'), '5 سيارات');
  assert.equal(arCountText(11, 'سيارة'), '11 سيارة');
  assert.equal(arCountText(1000, 'سيارة', n => n.toLocaleString('en-US')), '1,000 سيارة', 'المنسّق على الرقم وحده');
});

test('اللغات الأخرى: «N» وترجمة المعدود كما كانت حرفاً', () => {
  assert.equal(countText('en', 6, 'صنف', trEn), `6 ${trEn('صنف')}`);
  assert.equal(countText('ar', 6, 'صنف', trEn), '6 أصناف');
});

test('عبارةٌ أولها المعدود: العربية بتمييزها ثم بقيتها، وغيرها العبارة المترجمة كاملةً كما كانت', () => {
  const key = 'صنفا برصيد صفر أو سالب يحتاج استلام بضاعة';
  assert.equal(countLead('ar', 6, 'صنف', key, k => k), '6 أصناف برصيد صفر أو سالب يحتاج استلام بضاعة');
  assert.equal(countLead('ar', 1, 'صنف', key, k => k), 'صنف واحد برصيد صفر أو سالب يحتاج استلام بضاعة');
  assert.equal(countLead('en', 6, 'صنف', key, trEn), `6 ${trEn(key)}`);
  const vans = 'سيارة لمندوب محذوف بضاعتها غير معروفة فلا تدخل هنا';
  assert.equal(countLead('ar', 2, 'سيارة', vans, k => k), 'سيارتان لمندوب محذوف بضاعتها غير معروفة فلا تدخل هنا');
  assert.ok(PHRASES[vans]?.en, 'العبارة الجديدة مترجمة');
});

test('الفاتورة (المراجعة UX7): «فاتورة واحدة» و«فاتورتان» و«3 فواتير» و«11 فاتورة»', () => {
  assert.equal(arCountText(1, 'فاتورة'), 'فاتورة واحدة');
  assert.equal(arCountText(2, 'فاتورة'), 'فاتورتان');
  assert.equal(arCountText(3, 'فاتورة'), '3 فواتير');
  assert.equal(arCountText(11, 'فاتورة'), '11 فاتورة');
  assert.equal(arCountText(100, 'فاتورة'), '100 فاتورة');
});
