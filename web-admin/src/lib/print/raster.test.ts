// الرسم النقطيّ للطباعة المباشرة («إعدادات الطباعة» M3، التصميم §3.3 و§3.4 و§3.5): العتبة الثابتة، وحزم البتات، والتقسيم على صفٍّ
// أبيض بلا قطع رمز QR، وسطر الترقيم، ورسم الرمز بعددٍ صحيح من النقاط لكل خلية بمنطقةٍ صامتة — ورفض الطباعة حين لا يتسع.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import {
  MONO_THRESHOLD, QR_QUIET_CELLS, applyQrSlots, createBitmap, dotAt, drawQr, fillRect, inkColumns, monoFromRgba, paginate, rowBlank,
  shiftRight, sliceRows, slotDotsPerCell, splitPages, stackRows, rowsOfRects, CANVAS_BAND_SELECTOR, type Bitmap,
} from './raster';
import { PrintRefusedError } from './printErrors';
import { PRINT_WARNINGS, QR_DOTS_PER_CELL, STAMPED_QR_CELLS } from './printSettings';
import { dummyQrValue } from './calibration';

const rgba = (pixels: Array<[number, number, number, number]>) => Uint8ClampedArray.from(pixels.flat());
const lines = (b: Bitmap, rows: number[]): Bitmap => { for (const y of rows) fillRect(b, 0, y, b.width, 1, true); return b; };

test('العتبة الثابتة 160 على خلفية بيضاء: الرماديّ الفاتح أبيض، والداكن أسود، والشفاف أبيض', () => {
  assert.equal(MONO_THRESHOLD, 160);
  const b = monoFromRgba(rgba([
    [0, 0, 0, 255], [159, 159, 159, 255], [160, 160, 160, 255], [255, 255, 255, 255],
    [0, 0, 0, 0], [0, 0, 0, 128], [0, 0, 0, 90], [200, 0, 0, 255],
  ]), 8, 1);
  assert.deepEqual(Array.from({ length: 8 }, (_, x) => dotAt(b, x, 0)), [1, 1, 0, 0, 0, 1, 0, 1]);
});

test('حزم البتات: البت الأعلى يساراً، والصفّ ceil(العرض÷8) بايتاً، والحشوة لا تُكتب أبداً', () => {
  const b = createBitmap(10, 2);
  assert.equal(b.rowBytes, 2);
  fillRect(b, 0, 0, 10, 1, true);
  fillRect(b, 9, 1, 50, 1, true); // يُقصّ على العرض
  assert.deepEqual(Array.from(b.data), [0xff, 0xc0, 0x00, 0x40]);
  assert.deepEqual(inkColumns(b, 0, 2), [0, 9]);
  assert.deepEqual(inkColumns(b, 1, 2), [9, 9]);
  assert.equal(inkColumns(createBitmap(10, 3), 0, 3), null);
  assert.equal(rowBlank(b, 0), false);
  const s = stackRows(sliceRows(b, 1, 2), createBitmap(10, 1));
  assert.deepEqual(Array.from(s.data), [0x00, 0x40, 0x00, 0x00]);
});

test('الإزاحة يميناً بأعمدة بيضاء ولا تتجاوز أقصى عرض — والحرارية لمضاعف 8', () => {
  const b = createBitmap(8, 1);
  fillRect(b, 0, 0, 1, 1, true);
  const s = shiftRight(b, 5, 64, 8);
  assert.equal(s.width, 16);
  assert.equal(dotAt(s, 5, 0), 1);
  assert.equal(shiftRight(b, 40, 12).width, 12, 'الإزاحة تُنقص لا المحتوى');
  assert.equal(shiftRight(b, 0, 64), b);
});

test('التقسيم: عند آخر صفٍّ أبيض فوق الحدّ، وبلا أبيض عند الحدّ، ولا قطع داخل رمز QR، والصفحة التالية تبدأ بالحبر', () => {
  // حبرٌ في كل الصفوف عدا 85 و170 (بياض بين الأسطر)
  const all = Array.from({ length: 250 }, (_, y) => y).filter((y) => y !== 85 && y !== 170);
  const b = lines(createBitmap(16, 250), all);
  assert.deepEqual(splitPages(b, 100, 20), [[0, 86], [86, 171], [171, 250]], 'القطع بعد الصفّ الأبيض 85 ثم 170');
  // نافذة البحث أضيق من المسافة ⇒ قطعٌ عند الحدّ
  assert.deepEqual(splitPages(b, 100, 5)[0], [0, 100]);
  // الرمز [60، 120) يعبر الحدّ 100 بلا صفٍّ أبيض فوقه ⇒ القطع قبل الرمز
  assert.deepEqual(splitPages(b, 100, 5, [[60, 120]])[0], [0, 60]);
  // الصفّ الأبيض داخل الرمز لا يصلح موضع قطع — فالقطع قبل الرمز العابر للحدّ؛ ورمزٌ ينتهي قبل الحدّ لا يمنع القطع عنده
  assert.deepEqual(splitPages(b, 100, 20, [[80, 110]])[0], [0, 80]);
  assert.deepEqual(splitPages(b, 100, 5, [[80, 95]])[0], [0, 100]);
  // بياضٌ في أوّل الصفحة التالية يُتخطّى
  const gap = lines(createBitmap(8, 60), [...Array.from({ length: 20 }, (_, y) => y), ...Array.from({ length: 20 }, (_, y) => 40 + y)]);
  assert.deepEqual(splitPages(gap, 25, 10), [[0, 25], [40, 60]]);
});

test('الصفحات: كلٌّ بطول مساحتها حتى سطر الترقيم، وصفوف الرمز منقولةٌ لصفحتها — والرول صفحة واحدة', () => {
  const all = Array.from({ length: 250 }, (_, y) => y).filter((y) => y !== 85 && y !== 170);
  const b = lines(createBitmap(16, 250), all);
  const label = (n: number, m: number) => { const s = createBitmap(16, 10); fillRect(s, 0, 9, n + m, 1, true); return s; };
  const pages = paginate(b, [[120, 140]], 110, 30, label);
  assert.equal(pages.length, 3);
  for (const p of pages.slice(0, 2)) assert.equal(p.bitmap.height, 110, 'المحتوى يُكمَّل حتى السطر');
  assert.equal(dotAt(pages[0].bitmap, 1 + 3 - 1, 109), 1, 'سطر «1 من 3» آخر الصفحة');
  assert.deepEqual(pages[1].qrRows, [[34, 54]], 'الرمز في الصفحة الثانية بموضعه منها');
  assert.deepEqual(paginate(b, [[1, 2]], null, 30).map((p) => p.bitmap.height), [250]);
  assert.deepEqual(paginate(b, [], 400, 30).length, 1, 'الأقصر من الصفحة بلا ترقيم');
  // بياض ذيل القالب (حشوته وحدّه الأدنى) لا يفتح صفحةً ثانية — يُقصّ والمُرمِّز يكمل الورقة
  const tail = lines(createBitmap(16, 200), Array.from({ length: 90 }, (_, y) => y));
  const one = paginate(tail, [], 100, 30, label);
  assert.deepEqual(one.map((p) => p.bitmap.height), [90]);
});

test('خلية الرمز: «تلقائي» ثم نزولاً حتى الحدّ الأدنى ليتسع (الخلايا + 4) — وnull دونه', () => {
  const r = (s: number) => ({ x: 0, y: 0, w: s, h: s });
  assert.equal(slotDotsPerCell(89, r(500), 1440, 5, 4), 5);
  assert.equal(slotDotsPerCell(89, r(400), 1440, 5, 4), 4);
  assert.equal(slotDotsPerCell(89, r(370), 1440, 5, 4), 4, 'سماح نقطتين للتقريب');
  assert.equal(slotDotsPerCell(89, r(360), 1440, 5, 4), null);
  assert.equal(slotDotsPerCell(89, r(1000), 384, 4, 3), 4, 'الحزمة 58 مم = 384: الرمز المختوم بأربع نقاط كاليوم');
  assert.equal(slotDotsPerCell(93, r(1000), 384, 4, 3), 3);
  assert.equal(QR_QUIET_CELLS, 2);
});

test('رسم الرمز: كل خلية d×d نقطة تماماً في منتصف الخانة، ومنطقةٌ صامتة بيضاء ولو كان تحتها حبر', () => {
  const m = QRCode.create('fieldsa.net test', { errorCorrectionLevel: 'M' }).modules;
  const d = 3;
  const b = createBitmap(200, 200);
  fillRect(b, 0, 0, 200, 200, true); // حبرٌ يملأ الصورة: الخانة ومنطقتها الصامتة تُمسحان
  const at = drawQr(b, m, { x: 40, y: 40, w: (m.size + 4) * d, h: (m.size + 4) * d }, d);
  assert.equal(at.side, m.size * d);
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      const want = m.get(r, c) ? 1 : 0;
      for (const [dx, dy] of [[0, 0], [d - 1, 0], [0, d - 1], [d - 1, d - 1]]) {
        assert.equal(dotAt(b, at.x + c * d + dx, at.y + r * d + dy), want, `الخلية ${r},${c}`);
      }
    }
  }
  for (let i = -2 * d; i < 0; i++) assert.equal(dotAt(b, at.x + i, at.y + 5), 0, 'المنطقة الصامتة يساراً');
});

test('خانات الرمز: الرمز التجريبي (طول المختوم) بخمس نقاط على 180 وأربع على 203 — ولا يتسع ⇒ رفضٌ برسالة الرمز', () => {
  const value = dummyQrValue();
  const cells = QRCode.create(value, { errorCorrectionLevel: 'L' }).modules.size;
  assert.equal(cells, STAMPED_QR_CELLS.typical);
  const big = createBitmap(1440, 600);
  const rows = applyQrSlots(big, [{ value, ec: 'L', rect: { x: 400, y: 50, w: (cells + 4) * 5 + 2, h: (cells + 4) * 5 + 2 } }], { dpi: 180, size: 'auto' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1] - rows[0][0], (cells + 4) * 5, 'خمس نقاط للخلية بمنطقتها الصامتة');
  const roll = createBitmap(576, 600);
  const r2 = applyQrSlots(roll, [{ value, ec: 'L', rect: { x: 0, y: 0, w: 576, h: 576 } }], { dpi: 203, size: 'auto' });
  assert.equal(r2[0][1] - r2[0][0], (cells + 4) * QR_DOTS_PER_CELL[203].auto);
  assert.throws(
    () => applyQrSlots(createBitmap(250, 600), [{ value, ec: 'L', rect: { x: 0, y: 0, w: 250, h: 250 } }], { dpi: 203, size: 'auto' }),
    (e: unknown) => e instanceof PrintRefusedError && e.message === PRINT_WARNINGS.qrNoFit,
  );
});

// ─── «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦): لوحتا الرأس/التذييل لا تُقطعان في النقطية ───

test('التحرير الحرّ: لوحةٌ عابرة لحدّ الصفحة مدىً محفوظ ⇒ القطع أعلاها لا وسطها، وبلا مدى التقسيم كاليوم حرفاً', () => {
  // إطار لوحةٍ بلا صفٍّ أبيض داخلها [150، 260)، وفوقها أسطرٌ بفراغاتٍ كل 20 صفّاً
  const ink = Array.from({ length: 300 }, (_, y) => y).filter((y) => !(y < 150 && y % 20 === 19) && y !== 149);
  const b = lines(createBitmap(16, 300), ink);
  const label = () => null;
  const plain = paginate(b, [], 200, 30, label);
  const same = paginate(b, [], 200, 30, label, undefined);
  const empty = paginate(b, [], 200, 30, label, []);
  assert.deepEqual(plain.map((p) => p.bitmap.height), [200, 100], 'بلا مدى: قطعٌ صلب عند الحدّ داخل اللوحة');
  assert.deepEqual(same.map((p) => [p.bitmap.height, p.qrRows]), plain.map((p) => [p.bitmap.height, p.qrRows]));
  assert.deepEqual(empty.map((p) => [p.bitmap.height, p.qrRows]), plain.map((p) => [p.bitmap.height, p.qrRows]));
  const kept = paginate(b, [], 200, 30, label, [[150, 260]]);
  assert.deepEqual(kept.map((p) => p.bitmap.height), [150, 150], 'القطع عند أعلى اللوحة (بعد صفّها الأبيض 149)');
  assert.deepEqual(kept.map((p) => p.qrRows), [[], []], 'مدى اللوحة ليس صفوف رمز (لا اتجاهٌ واحد)');
});

test('التحرير الحرّ: لوحةٌ أطول من الصفحة لا تحبس التقسيم (قطعٌ عند الحدّ)، والرمز داخل اللوحة يبقى صفوف رمز', () => {
  const b = lines(createBitmap(16, 500), Array.from({ length: 500 }, (_, y) => y));
  const pages = paginate(b, [[40, 80]], 200, 30, () => null, [[0, 450]]);
  assert.deepEqual(pages.map((p) => p.bitmap.height), [200, 200, 100]);
  assert.deepEqual(pages[0].qrRows, [[40, 80]]);
});

test('صفوف المستطيلات: بمقياس الالتقاط (floor أعلى/ceil أسفل) مقصوصةً على الصورة، والفاسد والفارغ يسقطان', () => {
  assert.deepEqual(rowsOfRects([{ top: 10.2, bottom: 20.1 }], 2, 1000), [[20, 41]]);
  assert.deepEqual(rowsOfRects([{ top: -5, bottom: 600 }], 1.8136, 900), [[0, 900]]);
  assert.deepEqual(rowsOfRects([{ top: 30, bottom: 30 }, { top: NaN, bottom: 9 }, { top: 0, bottom: Infinity }], 2, 100), []);
  assert.deepEqual(rowsOfRects([{ top: 0, bottom: 10 }], 0, 100), []);
  assert.equal(CANVAS_BAND_SELECTOR, '[data-section^="canvas-"]');
});
