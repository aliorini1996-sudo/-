import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sarNumber, formatSar, formatRate, formatDay, riyadhToday, toDateInput, daysUntil, daysLabel,
  maskedIban, shareText, whatsappShareUrl, firstName,
} from './format';

test('الهللات ⇒ ريال بخانتين وفواصل آلاف، بحسابٍ صحيح لا عشريّ', () => {
  const table: Array<[number | null | undefined, string]> = [
    [0, '0.00'],
    [1, '0.01'],
    [10, '0.10'],
    [100, '1.00'],
    [8970, '89.70'],
    [29900, '299.00'],
    [123456, '1,234.56'],
    [100000000, '1,000,000.00'],
    [-2500, '-25.00'],
    [-1, '-0.01'],
    [12.9, '0.12'],          // كسرٌ في الهللة لا يُفترض أن يصل — يُقطع لا يُقرَّب لأعلى
    [NaN, '0.00'],
    [Infinity, '0.00'],
    [null, '0.00'],
    [undefined, '0.00'],
  ];
  for (const [h, want] of table) assert.equal(sarNumber(h), want, `sarNumber(${h})`);
  assert.equal(formatSar(123456), '1,234.56 ر.س');
});

test('النسبة من نقاط الأساس', () => {
  assert.equal(formatRate(3000), '30%');
  assert.equal(formatRate(2550), '25.5%');
  assert.equal(formatRate(3333), '33.33%');
  assert.equal(formatRate(0), '0%');
  assert.equal(formatRate(10000), '100%');
  assert.equal(formatRate(undefined), '0%');
});

test('التاريخ بتوقيت الرياض — منتصف الليل UTC لا يسقط يوماً', () => {
  assert.equal(formatDay('2026-09-13T10:00:00.000Z'), '13 سبتمبر 2026');
  // 22:30 UTC = 01:30 بتوقيت الرياض من اليوم التالي
  assert.equal(formatDay('2026-09-13T22:30:00.000Z'), '14 سبتمبر 2026');
  assert.equal(formatDay('2027-01-01T00:00:00.000Z'), '1 يناير 2027');
  assert.equal(formatDay(null), '—');
  assert.equal(formatDay(''), '—');
  assert.equal(formatDay('not a date'), '—');
  // حقول اليوم الخالص تصل 'YYYY-MM-DD' بيوم الرياض (transferredAt، mawthooqExpiry) — لا تنزلق يوماً
  assert.equal(formatDay('2026-09-13'), '13 سبتمبر 2026');
  assert.equal(formatDay('2027-01-01'), '1 يناير 2027');
});

test('اليوم بتوقيت الرياض وحقل التاريخ', () => {
  assert.equal(riyadhToday(Date.parse('2026-09-13T20:59:59Z')), '2026-09-13');
  assert.equal(riyadhToday(Date.parse('2026-09-13T21:00:00Z')), '2026-09-14');
  assert.equal(toDateInput('2027-03-01'), '2027-03-01');
  assert.equal(toDateInput('2027-03-01T00:00:00.000Z'), '2027-03-01');
  assert.equal(toDateInput(null), '');
  assert.equal(toDateInput('garbage'), '');
});

test('الأيام المتبقية وتمييز العدد', () => {
  const now = Date.parse('2026-09-13T00:00:00Z');
  assert.equal(daysUntil('2026-09-14T00:00:00Z', now), 1);
  assert.equal(daysUntil('2026-09-13T00:00:01Z', now), 1);
  assert.equal(daysUntil('2026-10-13T00:00:00Z', now), 30);
  assert.equal(daysUntil('2026-09-01T00:00:00Z', now), 0);
  assert.equal(daysUntil(null, now), 0);
  assert.equal(daysLabel(0), 'اليوم');
  assert.equal(daysLabel(1), 'يوم واحد');
  assert.equal(daysLabel(2), 'يومان');
  assert.equal(daysLabel(3), '3 أيام');
  assert.equal(daysLabel(10), '10 أيام');
  assert.equal(daysLabel(11), '11 يوماً');
  assert.equal(daysLabel(30), '30 يوماً');
});

test('الآيبان مُقنَّع دائماً', () => {
  assert.equal(maskedIban('1234'), '****1234');
  assert.equal(maskedIban(null), '—');
});

test('نصّ المشاركة: الإفصاح قبل الرابط، وواتساب مُرمَّز', () => {
  const link = 'https://fieldsa.net/?ref=ABCD2345';
  const text = shareText('أحصل على عمولة من فيلد سيلز إذا اشتركت عبر رابطي', link);
  assert.ok(text.startsWith('أحصل على عمولة'));
  assert.ok(text.endsWith(link));
  assert.ok(text.indexOf('عمولة') < text.indexOf(link), 'الإفصاح يسبق الرابط');
  assert.equal(shareText('', link), link);
  const wa = whatsappShareUrl(text);
  assert.ok(wa.startsWith('https://wa.me/?text='));
  assert.equal(decodeURIComponent(wa.slice('https://wa.me/?text='.length)), text);
  assert.ok(!wa.slice(20).includes('&'), 'رابط الإحالة لا يكسر معامل text');
});

test('الاسم الأول', () => {
  assert.equal(firstName('  محمد عبدالله  '), 'محمد');
  assert.equal(firstName(''), '');
  assert.equal(firstName(null), '');
});
