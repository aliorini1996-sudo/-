/**
 * مُرمِّز TSPL (lib/print/tspl.ts) — طابعة العميل Rongta RPP04 بلغة الملصقات، مقيساً على دليل TSC TSPL/TSPL2: الأوامر نصّاً بـCRLF،
 * والبت 0 أسود، وDIRECTION 0 (الصفّ الأوّل أوّلاً)، ومم صحيحة في SIZE، وتقسيم الإيصال الطويل على صفٍّ أبيض لا داخل رمز QR بمقاطع
 * متقاربة، ونقاط الإلغاء قبل PRINT — ثم وصله من اختيار الجهاز إلى encodeForProfile (الرول وحده).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TSPL_CANCEL, TSPL_MAX_LABEL_ROWS, encodeTspl, tsplBitmapData, tsplChunks } from './tspl';
import { createBitmap, fillRect, type Bitmap } from './raster';
import { deviceRollProfile, presetPaper, defaultPrintOptions, type PrintProfile } from './printSettings';
import { encodeForProfile } from '../../rep/printDirect';
import { directOpts, parseDeviceChoice, withConnection } from '../../rep/printDevice';

const text = (b: Uint8Array): string => Array.from(b, (c) => String.fromCharCode(c)).join('');
const count = (s: string, sub: string): number => s.split(sub).length - 1;

/** صورةٌ صفّها الأوّل أسود كلّه (بتات الحشو آخر الصفّ تبقى 0 كما يرسمها raster.ts) */
function sample(width: number, height: number): Bitmap {
  const bm = createBitmap(width, height);
  for (let x = 0; x < width; x++) bm.data[x >> 3] |= 0x80 >> (x & 7);
  return bm;
}
/** صورةٌ «نصّ» كثيف: كل صفٍّ أسود إلا الصفوف البيضاء المعطاة */
function inked(width: number, height: number, blankRows: number[] = []): Bitmap {
  const bm = createBitmap(width, height);
  fillRect(bm, 0, 0, width, height, true);
  for (const y of blankRows) fillRect(bm, 0, y, width, 1, false);
  return bm;
}

test('البتات معكوسة: الأسود 0 والأبيض 1 — وبتات الحشو آخر الصفّ بيضاء (دليل TSC ص٤٤)', () => {
  const d = tsplBitmapData(sample(12, 2), 0, 2);
  assert.deepEqual(Array.from(d), [0x00, 0x0f, 0xff, 0xff]);
});

test('الأوامر: GAP 0,0 وDIRECTION 0 مرّةً، ثم SIZE بمم صحيحة وCLS وBITMAP ثم CRLF وPRINT — ونقطة إلغاءٍ قبل PRINT', () => {
  const job = encodeTspl({ copies: [[{ bitmap: sample(832, 16) }]], dotsPerMm: 8, afterDots: 0, flip: false });
  const s = text(job.bytes);
  const head = 'GAP 0,0\r\nDIRECTION 0\r\nSIZE 104 mm,2 mm\r\nCLS\r\nBITMAP 0,0,104,16,0,';
  assert.ok(s.startsWith(head), s.slice(0, 90));
  assert.ok(s.endsWith('\r\nPRINT 1,1\r\n'));
  assert.equal(job.bytes.length, head.length + 104 * 16 + '\r\n'.length + 'PRINT 1,1\r\n'.length);
  const afterSetup = 'GAP 0,0\r\nDIRECTION 0\r\n'.length;
  const afterData = head.length + 104 * 16 + 2;
  assert.deepEqual(job.marks, [afterSetup, afterData, job.bytes.length], 'الإلغاء يقف قبل PRINT فلا يُطبع المقطع الجاري');
  assert.ok(!s.includes('FEED'));
  assert.deepEqual(TSPL_CANCEL, []);
});

test('طولٌ لا يقسم على 8: المم بالتقريب لأعلى — فلا ملصق بطول صفر ولا صفٌّ مقصوص', () => {
  for (const [rows, mm] of [[1, 1], [5, 1], [9, 2], [17, 3]] as const) {
    const s = text(encodeTspl({ copies: [[{ bitmap: createBitmap(384, rows) }]], dotsPerMm: 8, afterDots: 0, flip: false }).bytes);
    assert.ok(s.includes(`SIZE 48 mm,${mm} mm\r\nCLS\r\nBITMAP 0,0,48,${rows},0,`), `${rows} صفّ`);
    assert.ok(!/SIZE [\d.]+ mm,0(\.\d)? mm/.test(s) && !/\d\.\d mm/.test(s), 'مم كسرية أو صفرية');
  }
});

test('القلب: DIRECTION 1 والمقاطع من آخرها — والتغذية FEED بالنقاط بعد كل نسخة', () => {
  const s = text(encodeTspl({ copies: [[{ bitmap: inked(384, 20, [9]) }], [{ bitmap: sample(384, 8) }]], dotsPerMm: 8, afterDots: 80, flip: true, maxRows: 12 }).bytes);
  assert.ok(s.startsWith('GAP 0,0\r\nDIRECTION 1\r\n'));
  assert.equal(count(s, 'FEED 80\r\n'), 2);
  // النسخة الأولى مقطعان (قطعٌ على الصفّ الأبيض 9): الثاني (11 صفّاً بعد تخطّي الأبيض) يُرسل أوّلاً
  assert.ok(s.indexOf('BITMAP 0,0,48,10,0,') > s.indexOf('BITMAP 0,0,48,9,0,') || s.indexOf('BITMAP 0,0,48,9,0,') === -1);
});

test('الإيصال الطويل: مقاطع متقاربة الطول لا ذيلٌ صغير، والقطع على صفٍّ أبيض لا داخل رمز QR', () => {
  const max = TSPL_MAX_LABEL_ROWS;
  // 2401 صفّ: لا مقطع من صفٍّ واحد — بل مقطعان متقاربان
  const even = tsplChunks({ bitmap: inked(576, max + 1) }, max, 96);
  assert.equal(even.length, 2);
  assert.ok(even.every(([a, b]) => b - a > 1000), JSON.stringify(even));
  // وذيل الإيصال الأبيض (هامش القطع) يبقى في آخر مقطع — splitPages تُسقط البياض بعد القطع
  const tail = inked(576, 2600, Array.from({ length: 1400 }, (_, i) => 1200 + i));
  const tc = tsplChunks({ bitmap: tail }, max, 96);
  assert.equal(tc[tc.length - 1][1], 2600, JSON.stringify(tc));
  // صورةٌ كثيفة بصفٍّ أبيض قبل حدّ المقطع المتوازن (2600 ÷ 2 = 1300): القطع عليه
  const page = inked(576, 2600, [1260]);
  const cuts = tsplChunks({ bitmap: page }, max, 96);
  assert.equal(cuts[0][1], 1261, JSON.stringify(cuts));
  // رمز QR يعبر الحدّ ولا صفّ أبيض في نافذة البحث: القطع قبل الرمز لا داخله
  const qr = tsplChunks({ bitmap: inked(576, 2600), qrRows: [[1200, 1400]] }, max, 96);
  assert.equal(qr[0][1], 1200, JSON.stringify(qr));
  assert.ok(qr.every(([a, b]) => !(a < 1200 && b > 1200 && b < 1400)), 'مقطعٌ ينتهي داخل الرمز');
});

test('اختيار الجهاز: لغة TSPL واتجاهها يُحفظان ويُقرآن، والعودة إلى ESC/POS تُسقط القلب', () => {
  const c = withConnection(withConnection(null, { lang: 'tspl' }), { tsplFlip: true });
  assert.deepEqual(c, { lang: 'tspl', tsplFlip: true });
  assert.equal(withConnection(c, { lang: 'escpos' }), null);
  assert.deepEqual(parseDeviceChoice('{"lang":"tspl","tsplFlip":true,"rollMm":112}'), { lang: 'tspl', tsplFlip: true, rollMm: 112 });
  assert.deepEqual(parseDeviceChoice('{"lang":"zpl","rollMm":100}'), null, 'لغةٌ أو عرضٌ مجهولان يسقطان');
  assert.deepEqual(directOpts({ slow: true, lang: 'tspl', tsplFlip: true }), { slow: true, lang: 'tspl', tsplFlip: true });
});

test('encodeForProfile: الرول 112 مم بلغة TSPL يرسل أوامرها بعرض 104 مم — والورق المقطع وبلا لغة يبقيان ESC/POS', () => {
  const p = deviceRollProfile(112);
  assert.equal(p.paper.printableDots, 832);
  const pages = [[{ bitmap: createBitmap(832, 24), qrRows: [] }]] as Parameters<typeof encodeForProfile>[1];
  const tspl = text(encodeForProfile(p, pages, { lang: 'tspl' }).job.bytes);
  assert.ok(tspl.startsWith('GAP 0,0\r\nDIRECTION 0\r\nSIZE 104 mm,3 mm\r\n'), tspl.slice(0, 80));
  const esc = encodeForProfile(p, pages).job.bytes;
  assert.deepEqual(Array.from(esc.subarray(0, 2)), [0x1b, 0x40], 'ESC @ أوّل مهمة ESC/POS');
  const sheet: PrintProfile = { id: 'a4-thermal', name: 'x', printer: 'thermal', template: 'roll_compact', paper: presetPaper('roll_a4')!, options: defaultPrintOptions('thermal') };
  const sheetBytes = encodeForProfile(sheet, [[{ bitmap: createBitmap(1664, 24), qrRows: [] }]], { lang: 'tspl' }).job.bytes;
  assert.deepEqual(Array.from(sheetBytes.subarray(0, 2)), [0x1b, 0x40], 'الورق المقطع لا يُرسل بـTSPL');
});
