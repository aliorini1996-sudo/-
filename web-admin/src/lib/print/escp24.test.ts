// مُرمِّز ESC/P بإبر 24 للنقطية MIP480 («إعدادات الطباعة» M3، التصميم §3.3 الخطوة 5 و§3.5): بايتات ذهبية — طول الصفحة 297 مم
// بوحدة 1/360 ثم العودة لـ1/60، وشريط ESC * 39 بثلاثة بايتات للعمود والبت الأعلى للإبرة العليا، وقصّ الأعمدة البيضاء بـESC $
// على مضاعف 3، ودمج الأشرطة البيضاء في ESC J بحدّ 255، وESC U 1 حول أشرطة الرمز، والمسودة ESC * 33، وFF آخر كل صفحة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ESCP24_CANCEL, ESCP24_CANCEL_CONTINUOUS, ESCP24_LINE_DOTS, band24Columns, band24Draft, encodeEscP24, escp24Cancel, escpPageLength, units360,
} from './escp24';
import { createBitmap, fillRect, type Bitmap } from './raster';
import { PRINT_ISSUES, PRINT_WARNINGS } from './printSettings';
import { PrintRefusedError } from './printErrors';

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const ink = (w: number, h: number, rects: Array<[number, number, number, number]>): Bitmap => {
  const b = createBitmap(w, h);
  for (const [x, y, ww, hh] of rects) fillRect(b, x, y, ww, hh, true);
  return b;
};
const job = (pages: Array<{ bitmap: Bitmap; qrRows?: Array<[number, number]> }>, over: Partial<Parameters<typeof encodeEscP24>[0]> = {}) =>
  encodeEscP24({
    copies: [pages.map((p) => ({ bitmap: p.bitmap, qrRows: p.qrRows ?? [] }))],
    continuous: false, pageLengthMm: null, topDots: 0, leftDots: 0, draft: false, ...over,
  });

test('طول الصفحة 297 مم = 4209 وحدة 1/360 (0x1071) — ثم الوحدة 1/60 من جديد لأجل ESC $', () => {
  assert.equal(units360(297), 4209);
  assert.equal(units360(279.4), 3960);
  assert.equal(hex(escpPageLength(297)), '1b 28 55 01 00 0a 1b 28 43 02 00 71 10 1b 28 55 01 00 3c');
  // الورق المتصل وحده يرسل طول الصفحة؛ المقطع تهيئة فقط
  const b = ink(48, 24, [[0, 0, 3, 24]]);
  assert.ok(hex(job([{ bitmap: b }], { continuous: true, pageLengthMm: 297 }).bytes).startsWith('1b 40 1b 28 55 01 00 0a 1b 28 43 02 00 71 10 1b 28 55 01 00 3c 1b 24'));
  assert.ok(hex(job([{ bitmap: b }]).bytes).startsWith('1b 40 1b 24'));
});

test('حزم العمود: ثلاثة بايتات من أعلى لأسفل والبت 7 للإبرة العليا', () => {
  const b = createBitmap(2, 24);
  fillRect(b, 0, 0, 1, 1, true); // الإبرة 1
  fillRect(b, 0, 9, 1, 1, true); // البايت الثاني البت 6
  fillRect(b, 1, 23, 1, 1, true); // الإبرة 24
  assert.equal(hex(band24Columns(b, 0, 0, 1)), '80 40 00 00 00 01');
});

test('ذهبيّ: شريطٌ واحد — الموضع ESC $ بوحدة 1/60 (3 نقاط) بعد قصّ الأبيض يساراً ثم ESC * 39 حتى آخر حبر ثم FF', () => {
  // حبرٌ في الأعمدة 301–305 كامل الارتفاع ⇒ البداية تُقرَّب إلى 300 (ESC $ 100) والأعمدة 300..305 = 6
  const b = ink(1440, 24, [[301, 0, 5, 24]]);
  const { bytes, marks } = job([{ bitmap: b }]);
  assert.equal(hex(bytes), `1b 40 1b 24 64 00 1b 2a 27 06 00 00 00 00 ${Array(15).fill('ff').join(' ')} 0c`);
  assert.deepEqual(marks, [2, bytes.length - 1, bytes.length]);
});

test('الأشرطة البيضاء تُدمج في ESC J بحدّ 255 (24 بعد الشريط + 20 شريطاً أبيض = 504 ⇒ 255 + 249)، والأخيرة قبل FF تُهمل', () => {
  const b = ink(6, 24 * 22 + 24 * 3, [[0, 0, 3, 24], [0, 24 * 21, 3, 24]]);
  const s = hex(job([{ bitmap: b }]).bytes);
  const band = `1b 24 00 00 1b 2a 27 03 00 ${Array(9).fill('ff').join(' ')}`;
  assert.equal(s, `1b 40 ${band} 1b 4a ff 1b 4a f9 ${band} 0c`);
});

test('الهامش العلوي تغذيةٌ قبل أوّل شريط، والإزاحة تُضاف لموضع ESC $ مقرّبةً لمضاعف 3', () => {
  const b = ink(30, 24, [[9, 0, 3, 24]]);
  const s = hex(job([{ bitmap: b }], { topDots: 36, leftDots: 31 }).bytes);
  // الإزاحة 31 ⇒ 30؛ الحبر عند 9 ⇒ (30 + 9) / 3 = 13
  assert.ok(s.startsWith('1b 40 1b 4a 24 1b 24 0d 00 1b 2a 27 03 00'), s);
});

test('أشرطة رمز QR باتجاهٍ واحد: ESC U 1 قبل أوّلها وESC U 0 بعد آخرها — والمسودة ESC * 33 لغيرها والرمز يبقى 39', () => {
  const b = ink(30, 24 * 3, [[0, 0, 30, 24 * 3]]);
  const s = hex(job([{ bitmap: b, qrRows: [[30, 60]] }], { draft: true }).bytes);
  const at = (needle: string) => s.indexOf(needle);
  // الشريط 0 (0–23): لا رمز ⇒ مسودة؛ الشريطان 1 و2 (24–71) يمسّان الرمز [30، 60)
  assert.ok(s.startsWith('1b 40 1b 24 00 00 1b 2a 21 14 00'), 'المسودة: 30 عموداً ⇒ 20 بـ120 نقطة/بوصة');
  assert.ok(at('1b 55 01') > 0 && at('1b 55 01') < at('1b 2a 27 1e 00'), 'اتجاهٌ واحد قبل شريط الرمز');
  assert.equal((s.match(/1b 2a 27 1e 00/g) || []).length, 2, 'شريطا الرمز بجودة 180 كاملة');
  assert.ok(s.endsWith('1b 55 00 0c'), 'إلغاء الاتجاه الواحد قبل FF');
});

test('المسودة تجمع العمودين المغطّيين (OR) فلا يضيع خطٌّ بعرض نقطة', () => {
  const b = createBitmap(6, 24);
  fillRect(b, 1, 0, 1, 24, true); // خطٌّ في العمود 1 وحده
  const d = band24Draft(b, 0, 0, 5);
  assert.equal(d.length, 4 * 3);
  assert.equal(hex(d.subarray(0, 3)), 'ff ff ff', 'العمود 0 بـ120 يغطّي 0 و1');
  assert.equal(hex(d.subarray(3, 6)), 'ff ff ff', 'العمود 1 يغطّي 1 و2');
  assert.equal(hex(d.subarray(6, 12)), '00 00 00 00 00 00');
});

test('حبرٌ وراء سطر الطباعة 8.0 بوصة يُرفض لا يُقصّ (كان يُسقط اسم البائع أو طرف الرمز صامتاً) — وحتى آخر عمودٍ فيه يُرسل كاملاً', () => {
  assert.equal(ESCP24_LINE_DOTS, 1440);
  // حتى العمود 1439: البداية 1428 (مضاعف 3) ⇒ ESC $ 476 (0x1dc)؛ الأعمدة 1428..1439 = 12
  const edge = ink(1440, 24, [[1430, 0, 10, 24]]);
  assert.ok(hex(job([{ bitmap: edge }]).bytes).startsWith('1b 40 1b 24 dc 01 1b 2a 27 0c 00'));
  // عمودٌ واحد وراءه ⇒ رفضٌ برسالة سطر الطباعة، ولا بايت يخرج (المهمة لا تُبنى)
  const wide = ink(1500, 24, [[1430, 0, 70, 24]]);
  assert.throws(() => job([{ bitmap: wide }]), (e: unknown) => e instanceof PrintRefusedError && e.message === PRINT_ISSUES.impactLine);
  assert.throws(() => job([{ bitmap: ink(1500, 24, [[1440, 0, 1, 24]]) }]), PrintRefusedError, 'حبرٌ كلّه وراء السطر لا يُعامَل بياضاً');
  // في شريط الرمز ⇒ رسالة الرمز (الرمز المختوم لا يُطبع ناقصاً)
  assert.throws(() => job([{ bitmap: wide, qrRows: [[0, 24]] }]), (e: unknown) => e instanceof PrintRefusedError && e.message === PRINT_WARNINGS.qrNoFit);
  // الإزاحة تُنقص السطر: 15 نقطة ⇒ آخر عمودٍ مسموح 1424
  const shifted = (col: number) => job([{ bitmap: ink(1440, 24, [[1400, 0, col - 1400 + 1, 24]]) }], { leftDots: 15 });
  assert.doesNotThrow(() => shifted(1424));
  assert.throws(() => shifted(1425), PrintRefusedError);
  // والأبيض وراء السطر لا يضرّ (صورةٌ أعرض بلا حبرٍ هناك)
  assert.doesNotThrow(() => job([{ bitmap: ink(1600, 24, [[0, 0, 30, 24]]) }]));
  const b = ink(3, 24, [[0, 0, 3, 24]]);
  const two = encodeEscP24({ copies: [[{ bitmap: b, qrRows: [] }, { bitmap: b, qrRows: [] }], [{ bitmap: b, qrRows: [] }]], continuous: false, pageLengthMm: null, topDots: 0, leftDots: 0, draft: false });
  assert.equal((hex(two.bytes).match(/ 0c( |$)/g) || []).length, 3, 'FF لكل صفحة من كل نسخة');
});

test('الإلغاء: المقطع ESC @ ثم FF، والمتصل ESC U 0 ثم FF — بلا ESC @ يمحو طول الصفحة ولا ESC ( C يجعل الموضع رأس صفحة', () => {
  assert.deepEqual(ESCP24_CANCEL, [0x1b, 0x40, 0x0c]);
  assert.deepEqual(ESCP24_CANCEL_CONTINUOUS, [0x1b, 0x55, 0x00, 0x0c]);
  assert.deepEqual(escp24Cancel(false, null), ESCP24_CANCEL);
  assert.deepEqual(escp24Cancel(false, 297), ESCP24_CANCEL, 'المقطع يُخرج الورقة');
  assert.deepEqual(escp24Cancel(true, 297), ESCP24_CANCEL_CONTINUOUS);
  assert.deepEqual(escp24Cancel(true, 139.7), ESCP24_CANCEL_CONTINUOUS);
  assert.deepEqual(escp24Cancel(true, null), ESCP24_CANCEL, 'متصلٌ بطول اللوحة: لا طول من المهمة يُحفظ');
  for (const c of [ESCP24_CANCEL_CONTINUOUS, escp24Cancel(true, 297)]) {
    assert.ok(!hex(c).includes('1b 40'), 'لا تهيئة');
    assert.ok(!hex(c).includes('1b 28 43'), 'لا طول صفحة جديد');
    assert.equal(c[c.length - 1], 0x0c, 'FF آخره: رأس النموذج التالي');
  }
});
