// مُرمِّز ESC/POS («إعدادات الطباعة» M3، التصميم §3.3 الخطوة 5): بايتات ذهبية — التهيئة، وشرائط GS v 0 بحدّ 255 صفّاً والبت
// الأعلى يساراً، والتغذية ESC J بحدّ 255، وضمّ الأبيض القصير للصورة، والورق المقطع يُكمَّل لطول الورقة، والقصّ، ونقاط الإلغاء.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESCPOS_CANCEL, ESCPOS_MIN_GAP_ROWS, encodeEscPos, escposSegments } from './escpos';
import { feedCommands } from './byteSink';
import { createBitmap, fillRect, type Bitmap } from './raster';

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const bm = (w: number, h: number, ink: Array<[number, number, number, number]>): Bitmap => {
  const b = createBitmap(w, h);
  for (const [x, y, ww, hh] of ink) fillRect(b, x, y, ww, hh, true);
  return b;
};

test('ESC J على دفعاتٍ بحدّ 255 — ولا شيء للصفر', () => {
  assert.deepEqual(feedCommands(0), []);
  assert.deepEqual(feedCommands(80), [0x1b, 0x4a, 80]);
  assert.deepEqual(feedCommands(255), [0x1b, 0x4a, 255]);
  assert.deepEqual(feedCommands(600), [0x1b, 0x4a, 255, 0x1b, 0x4a, 255, 0x1b, 0x4a, 90]);
});

test('ذهبيّ: صورة 16×2 — ESC @ ثم GS v 0 0 بعرض بايتين وصفّين والبت الأعلى يساراً', () => {
  // الصف 0: النقطة 0 والنقطة 15؛ الصف 1: النقاط 0–7
  const b = bm(16, 2, [[0, 0, 1, 1], [15, 0, 1, 1], [0, 1, 8, 1]]);
  const { bytes, marks } = encodeEscPos({ copies: [[b]], topDots: 0, afterDots: 0, pageRows: null, cut: false });
  assert.equal(hex(bytes), '1b 40 1d 76 30 00 02 00 02 00 80 01 ff 00');
  assert.deepEqual(marks, [2, 14]);
});

test('شرائط بحدّ 255 صفّاً: 600 صفّ ⇒ 255 + 255 + 90، وعرضٌ غير مضاعف لـ8 يُقرَّب لبايت كامل والحشوة صفر', () => {
  const b = bm(12, 600, [[0, 0, 12, 600]]);
  const { bytes, marks } = encodeEscPos({ copies: [[b]], topDots: 0, afterDots: 0, pageRows: null, cut: false });
  const rowBytes = 2;
  const headers: string[] = [];
  let i = 2;
  while (i < bytes.length) {
    const h = Array.from(bytes.subarray(i, i + 8));
    headers.push(hex(h));
    const rows = h[6] + h[7] * 256;
    assert.equal(bytes[i + 8], 0xff);
    assert.equal(bytes[i + 9], 0xf0, 'آخر 4 بتات (حشوة العرض 12) صفر');
    i += 8 + rows * rowBytes;
  }
  assert.deepEqual(headers, ['1d 76 30 00 02 00 ff 00', '1d 76 30 00 02 00 ff 00', '1d 76 30 00 02 00 5a 00']);
  assert.equal(marks.length, 4, 'علامةٌ بعد التهيئة وبعد كل شريط');
});

test('الأبيض: في الطرفين تغذية بأيّ طول، وفي الوسط تغذيةٌ من 32 صفّاً وما دونها يبقى في الصورة', () => {
  const b = bm(8, 5 + 10 + 40 + 10 + 20 + 10 + 7, [[0, 5, 8, 10], [0, 55, 8, 10], [0, 85, 8, 10]]);
  assert.deepEqual(escposSegments(b), [[0, 5, true], [5, 15, false], [15, 55, true], [55, 95, false], [95, 102, true]]);
  assert.equal(ESCPOS_MIN_GAP_ROWS, 32);
  const { bytes } = encodeEscPos({ copies: [[b]], topDots: 16, afterDots: 0, pageRows: null, cut: false });
  // التهيئة ⇒ تغذية الهامش 16 + الأبيض الأوّل 5 ⇒ صورة 10 ⇒ ESC J 40 ⇒ صورة 40 صفّاً (الأبيض القصير 20 داخلها) ⇒ الذيل 7
  const s = hex(bytes);
  assert.ok(s.startsWith('1b 40 1b 4a 15 1d 76 30 00 01 00 0a 00 ff'), s.slice(0, 60));
  assert.ok(s.includes('1b 4a 28 1d 76 30 00 01 00 28 00'), 'تغذية 40 ثم شريط 40 صفّاً');
  assert.ok(s.endsWith('1b 4a 07'), 'الذيل الأبيض تغذية');
});

test('الرول: التغذية بعد النسخة والقصّ GS V 66 0 بعد كل نسخة — والنسخ مهامٌّ كاملة متتالية', () => {
  const b = bm(8, 1, [[0, 0, 8, 1]]);
  const { bytes } = encodeEscPos({ copies: [[b], [b]], topDots: 0, afterDots: 24, pageRows: null, cut: true });
  const one = '1d 76 30 00 01 00 01 00 ff 1b 4a 18 1d 56 42 00';
  assert.equal(hex(bytes), `1b 40 ${one} ${one}`);
  assert.deepEqual(ESCPOS_CANCEL, [0x1b, 0x40]);
});

test('الورق المقطع (A4 حراري): الهامش ثم المحتوى ثم تكملةٌ تجعل تقدّم الورقة طول الصفحة تماماً', () => {
  // صفحة 2000 نقطة: هامش 40 + محتوى 10 (آخر 4 صفوفه بيضاء) ⇒ تكملة 1950 بعد الصفوف الحبرية الستة
  const b = bm(8, 10, [[0, 0, 8, 6]]);
  const { bytes } = encodeEscPos({ copies: [[b, b]], topDots: 40, afterDots: 0, pageRows: 2000, cut: false });
  const page = `1b 4a 28 1d 76 30 00 01 00 06 00 ff ff ff ff ff ff ${hex(feedCommands(4 + 1950))}`;
  assert.equal(hex(bytes), `1b 40 ${page} ${page}`);
  const feeds = 40 + 6 + 4 + 1950;
  assert.equal(feeds, 2000);
});
