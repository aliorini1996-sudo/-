// ذهابٌ وإياب («إعدادات الطباعة» M3): مُفسِّرٌ صغير يقرأ بايتات المُرمِّزين كما تقرؤها الطابعة (GS v 0 وESC J للحرارية، وESC $
// وESC * وESC J وFF للنقطية) ويعيد رسم الورقة — فتطابق الصورةَ الأصلية نقطةً نقطة لصورٍ عشوائية. الذهبيّ يثبت البايتات، وهذا
// يثبت معناها: لا شريطٌ مزاح، ولا عمودٌ مقلوب، ولا صفٌّ مفقود بين شريطين أو بعد تغذيةٍ مدموجة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEscPos } from './escpos';
import { ESCP24_LINE_DOTS, encodeEscP24 } from './escp24';
import { createBitmap, dotAt, fillRect, type Bitmap } from './raster';
import { defaultPrintOptions, dotsPerMm, presetPaper, type PrintProfile } from './printSettings';
import { encodeForProfile, impactLeftDots } from '../../rep/printDirect';

/** مولّد عشوائيّ ثابت البذرة — النتيجة نفسها في كل تشغيل */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

/** صورة بأسطر حبرٍ عشوائية بينها بياضٌ قصير وطويل (يختبر الدمج والضمّ) */
function randomSheet(w: number, h: number, seed: number): Bitmap {
  const r = rng(seed);
  const b = createBitmap(w, h);
  let y = Math.floor(r() * 40);
  while (y < h) {
    const lineH = 3 + Math.floor(r() * 30);
    for (let k = 0; k < 6; k++) {
      const x = Math.floor(r() * w);
      fillRect(b, x, y, 1 + Math.floor(r() * (w / 3)), lineH, true);
    }
    for (let k = 0; k < 40; k++) fillRect(b, Math.floor(r() * w), y + Math.floor(r() * lineH), 1, 1, false);
    y += lineH + (r() < 0.3 ? 40 + Math.floor(r() * 300) : Math.floor(r() * 20));
  }
  return b;
}

const sameDots = (a: Bitmap, b: Bitmap, dy: number, dx = 0): number => {
  let diff = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) if (dotAt(a, x, y) !== dotAt(b, x + dx, y + dy)) diff++;
  return diff;
};

/** يرسم ما تطبعه طابعة ESC/POS: موضع الرأس الرأسيّ يتقدّم بصفوف الصورة وبـESC J */
function playEscPos(bytes: Uint8Array, width: number, height: number): { sheet: Bitmap; fed: number } {
  const sheet = createBitmap(width, height);
  let y = 0;
  let i = 0;
  const eq = (...b: number[]) => b.every((v, k) => bytes[i + k] === v);
  while (i < bytes.length) {
    if (eq(0x1b, 0x40)) { i += 2; continue; }
    if (eq(0x1b, 0x4a)) { y += bytes[i + 2]; i += 3; continue; }
    if (eq(0x1d, 0x56, 0x42)) { i += 4; continue; }
    if (eq(0x1d, 0x76, 0x30, 0x00)) {
      const xb = bytes[i + 4] + bytes[i + 5] * 256;
      const rows = bytes[i + 6] + bytes[i + 7] * 256;
      i += 8;
      for (let r = 0; r < rows; r++, y++) {
        for (let bx = 0; bx < xb; bx++) {
          const v = bytes[i + r * xb + bx];
          for (let bit = 0; bit < 8; bit++) if (v & (0x80 >> bit)) fillRect(sheet, bx * 8 + bit, y, 1, 1, true);
        }
      }
      i += rows * xb;
      continue;
    }
    throw new Error(`ESC/POS: أمرٌ غير متوقّع عند ${i}: ${bytes[i]}`);
  }
  return { sheet, fed: y };
}

/** يرسم ما تطبعه MIP480: ESC $ بوحدة 1/60 (3 نقاط)، وESC * 39 أعمدة 24 إبرة، وESC J بـ1/180، وFF رأس صفحة جديدة */
function playEscP24(bytes: Uint8Array, width: number, pageRows: number, pages: number): Bitmap[] {
  const out = Array.from({ length: pages }, () => createBitmap(width, pageRows));
  let page = 0;
  let y = 0;
  let x = 0;
  let i = 0;
  const eq = (...b: number[]) => b.every((v, k) => bytes[i + k] === v);
  while (i < bytes.length) {
    if (eq(0x1b, 0x40)) { i += 2; continue; }
    if (eq(0x1b, 0x28)) { i += 5 + bytes[i + 3] + bytes[i + 4] * 256; continue; }
    if (eq(0x1b, 0x55)) { i += 3; continue; }
    if (eq(0x1b, 0x4a)) { y += bytes[i + 2]; i += 3; continue; }
    if (eq(0x1b, 0x24)) { x = (bytes[i + 2] + bytes[i + 3] * 256) * 3; i += 4; continue; }
    if (bytes[i] === 0x0c) { page++; y = 0; i += 1; continue; }
    if (eq(0x1b, 0x2a, 39)) {
      const n = bytes[i + 3] + bytes[i + 4] * 256;
      i += 5;
      for (let c = 0; c < n; c++) {
        for (let r = 0; r < 24; r++) if (bytes[i + c * 3 + (r >> 3)] & (0x80 >> (r & 7))) fillRect(out[page], x + c, y + r, 1, 1, true);
      }
      x += n;
      i += n * 3;
      continue;
    }
    throw new Error(`ESC/P: أمرٌ غير متوقّع عند ${i}: ${bytes[i]}`);
  }
  assert.equal(page, pages, 'FF لكل صفحة');
  return out;
}

test('ESC/POS ذهاباً وإياباً: صورٌ عشوائية (أبيض قصير وطويل، شرائط 255) تُطبع كما هي، والتقدّم الكلّيّ = الهامش + الطول + التغذية', () => {
  for (const seed of [1, 7, 42]) {
    for (const width of [384, 576, 1664]) {
      const src = randomSheet(width, 1300, seed + width);
      const { bytes } = encodeEscPos({ copies: [[src]], topDots: 17, afterDots: 9, pageRows: null, cut: true });
      const { sheet, fed } = playEscPos(bytes, width, 1400);
      assert.equal(fed, 17 + 1300 + 9);
      assert.equal(sameDots(src, sheet, 17), 0, `بذرة ${seed} عرض ${width}`);
    }
  }
});

test('ESC/P 24 ذهاباً وإياباً: الأشرطة والقصّ يساراً والتغذية المدموجة تعيد الورقة نقطةً نقطة — بالإزاحة والهامش، وصفحتين', () => {
  for (const seed of [3, 11]) {
    const p1 = randomSheet(1440, 1900, seed);
    const p2 = randomSheet(1440, 700, seed + 1);
    const { bytes } = encodeEscP24({
      copies: [[{ bitmap: p1, qrRows: [[300, 500]] }, { bitmap: p2, qrRows: [] }]],
      continuous: true, pageLengthMm: 297, topDots: 35, leftDots: 0, draft: false,
    });
    const [a, b] = playEscP24(bytes, 1440, 2200, 2);
    assert.equal(sameDots(p1, a, 35), 0, `الصفحة الأولى بذرة ${seed}`);
    assert.equal(sameDots(p2, b, 35), 0, 'الصفحة الثانية');
  }
  // الإزاحة: كل الورقة 15 نقطة يميناً (ESC $ مطلق لكل شريط)
  const narrow = randomSheet(1200, 400, 99);
  const { bytes } = encodeEscP24({ copies: [[{ bitmap: narrow, qrRows: [] }]], continuous: false, pageLengthMm: null, topDots: 0, leftDots: 15, draft: false });
  const [c] = playEscP24(bytes, 1440, 500, 1);
  assert.equal(sameDots(narrow, c, 0, 15), 0, 'الإزاحة 15 نقطة');
});

const inkCount = (b: Bitmap, x0 = 0, x1 = b.width): number => {
  let n = 0;
  for (let y = 0; y < b.height; y++) for (let x = x0; x < Math.min(x1, b.width); x++) n += dotAt(b, x, y);
  return n;
};

test('النقطية بإزاحتها ذهاباً وإياباً (من القالب إلى الورقة): الحزمة حتى آخر عمودها تُطبع كاملة — لا عمود حبرٍ يضيع وراء سطر 1440', () => {
  // [النقاط، الإزاحة مم]: صالحة (داخل السطر)، وحدّية بالتقريب لمضاعف 3، وحزمةٌ كاملة بإزاحةٍ محفوظةٍ قبل الحارس (تُقصر الإزاحة لا الحبر)
  const cases: Array<[number, number]> = [[1440, 0], [1405, 5], [1424, 2], [1426, 2], [1300, 15], [1440, 3], [1440, 15]];
  for (const [dots, offsetXmm] of cases) {
    const p: PrintProfile = {
      id: 'mip480', name: 'MIP480', printer: 'impact', template: 'impact_plain',
      paper: { ...presetPaper('ff_a4')!, printableDots: dots, offsetXmm }, options: defaultPrintOptions('impact'),
    };
    const src = randomSheet(dots, 600, dots + Math.round(offsetXmm * 10));
    fillRect(src, 0, 0, 1, 600, true); // أوّل عمود
    fillRect(src, dots - 1, 0, 1, 600, true); // وآخر عمود — حيث كان اسم البائع أو طرف الرمز يضيع
    const { bytes } = encodeForProfile(p, [[{ bitmap: src, qrRows: [[100, 300]] }]]).job;
    const top = Math.round(p.paper.marginTopMm * dotsPerMm(180));
    // ورقةٌ أعرض من السطر ليُرى ما يقع وراءه
    const [sheet] = playEscP24(bytes, 1700, 1200, 1);
    const left = Math.round(impactLeftDots(Math.round(offsetXmm * dotsPerMm(180)), dots) / 3) * 3;
    assert.ok(left + dots <= ESCP24_LINE_DOTS, `${dots}+${offsetXmm}: الحزمة داخل السطر`);
    assert.equal(sameDots(src, sheet, top, left), 0, `${dots}+${offsetXmm}: الورقة نقطةً نقطة بعد الإزاحة ${left}`);
    assert.equal(inkCount(sheet), inkCount(src), `${dots}+${offsetXmm}: كل الحبر طُبع`);
    assert.equal(inkCount(sheet, ESCP24_LINE_DOTS), 0, `${dots}+${offsetXmm}: لا شيء وراء 1440`);
    if (offsetXmm > 0 && dots + Math.round(offsetXmm * dotsPerMm(180)) <= ESCP24_LINE_DOTS - 2) assert.ok(left > 0, 'الإزاحة الصالحة تُطبَّق');
  }
});
