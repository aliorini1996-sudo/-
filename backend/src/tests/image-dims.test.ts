// «النموذج المطبوع مسبقاً» — نوع الصورة وأبعادها من بايتاتها (services/imageDims.ts): PNG وJPEG (أساسي وتدريجي، بحشوٍ وDHT قبل
// SOF) وWebP بصيغه الثلاث، والمبتور والتالف وغير الصور ⇒ null. صرفٌ بلا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORM_IMAGE_MIMES, imageInfo, sniffImageMime } from '../services/imageDims';
import { gifBytes, jpegBytes, pdfBytes, pngBytes, webpVp8Bytes, webpVp8lBytes, webpVp8xBytes } from './image-fixtures';

test('النوع من البايتات الأولى وحدها: JPEG وPNG وWebP — وPDF وGIF والفارغ والمبتور null', () => {
  assert.deepEqual([...FORM_IMAGE_MIMES], ['image/jpeg', 'image/png', 'image/webp']);
  assert.equal(sniffImageMime(jpegBytes(1240, 1754)), 'image/jpeg');
  assert.equal(sniffImageMime(pngBytes(1240, 1754)), 'image/png');
  assert.equal(sniffImageMime(webpVp8Bytes(1240, 1754)), 'image/webp');
  assert.equal(sniffImageMime(pdfBytes()), null);
  assert.equal(sniffImageMime(gifBytes()), null);
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8])), null, 'بايتان لا تكفيان');
  assert.equal(sniffImageMime(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1')), null, 'RIFF بلا WEBP');
  assert.equal(sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test('PNG: الأبعاد من IHDR — وبلا IHDR أولاً أو مبتوراً null', () => {
  assert.deepEqual(imageInfo(pngBytes(1240, 1754)), { mime: 'image/png', width: 1240, height: 1754 });
  assert.deepEqual(imageInfo(pngBytes(10000, 200)), { mime: 'image/png', width: 10000, height: 200 });
  const noIhdr = pngBytes(1240, 1754);
  noIhdr.write('IDAT', 12, 'latin1');
  assert.equal(imageInfo(noIhdr), null);
  assert.equal(imageInfo(pngBytes(1240, 1754).subarray(0, 20)), null);
  assert.equal(imageInfo(pngBytes(0, 1754)), null, 'بعدٌ صفري');
});

test('JPEG: أول SOFn بالمشي على المقاطع (أساسي C0 وتدريجي C2 وC1) — DHT قبله ليس SOF، والحشو FF يُطوى', () => {
  assert.deepEqual(imageInfo(jpegBytes(1240, 1754)), { mime: 'image/jpeg', width: 1240, height: 1754 });
  assert.deepEqual(imageInfo(jpegBytes(1754, 1240, { sof: 0xc2 })), { mime: 'image/jpeg', width: 1754, height: 1240 });
  assert.deepEqual(imageInfo(jpegBytes(2480, 3508, { sof: 0xc1 })), { mime: 'image/jpeg', width: 2480, height: 3508 });
  // بايتا الأبعاد لا يُلتقطان بالبحث: FF C0 داخل جدول DQT لا تُقرأ (المشي يتخطّى المقطع بطوله)
  const tricky = jpegBytes(1240, 1754);
  const dqt = tricky.indexOf(Buffer.from([0xff, 0xdb]));
  tricky[dqt + 6] = 0xff; tricky[dqt + 7] = 0xc0; tricky[dqt + 8] = 0x00; tricky[dqt + 9] = 0x11;
  assert.deepEqual(imageInfo(tricky), { mime: 'image/jpeg', width: 1240, height: 1754 });
});

test('JPEG تالف: SOS قبل SOF، أو مبتور داخل SOF، أو علامةٌ بلا FF، أو طولٌ أقل من 2 ⇒ null', () => {
  assert.equal(imageInfo(jpegBytes(1240, 1754, { noSof: true })), null);
  const full = jpegBytes(1240, 1754);
  const sof = full.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(imageInfo(full.subarray(0, sof + 6)), null, 'مبتور داخل SOF');
  const broken = Buffer.from(full);
  broken[2] = 0x00; // ما بعد SOI ليس علامة
  assert.equal(imageInfo(broken), null);
  const zeroLen = Buffer.from(full);
  zeroLen[4] = 0; zeroLen[5] = 1; // طول APP0 = 1
  assert.equal(imageInfo(zeroLen), null);
  assert.equal(imageInfo(Buffer.from([0xff, 0xd8, 0xff])), null);
});

test('WebP: VP8X (لوحة 24 بت) وVP8 (14 بت بلا بتّي التكبير) وVP8L (14 بت معبّأة) — وما سواها null', () => {
  assert.deepEqual(imageInfo(webpVp8xBytes(1240, 1754)), { mime: 'image/webp', width: 1240, height: 1754 });
  assert.deepEqual(imageInfo(webpVp8xBytes(16384, 20000)), { mime: 'image/webp', width: 16384, height: 20000 }, 'VP8X يتجاوز 14 بتاً');
  assert.deepEqual(imageInfo(webpVp8Bytes(1240, 1754)), { mime: 'image/webp', width: 1240, height: 1754 });
  assert.deepEqual(imageInfo(webpVp8lBytes(1240, 1754)), { mime: 'image/webp', width: 1240, height: 1754 });
  assert.deepEqual(imageInfo(webpVp8lBytes(1, 16384)), { mime: 'image/webp', width: 1, height: 16384 });
  const badStart = webpVp8Bytes(1240, 1754);
  badStart[23] = 0x00; // رمز البدء 9D 01 2A
  assert.equal(imageInfo(badStart), null);
  const badSig = webpVp8lBytes(1240, 1754);
  badSig[20] = 0x00;
  assert.equal(imageInfo(badSig), null);
  const unknown = webpVp8xBytes(1240, 1754);
  unknown.write('ANIM', 12, 'latin1');
  assert.equal(imageInfo(unknown), null);
  assert.equal(imageInfo(webpVp8xBytes(1240, 1754).subarray(0, 28)), null, 'مبتور');
});

test('غير الصور لا أبعاد لها: PDF وGIF ⇒ null', () => {
  assert.equal(imageInfo(pdfBytes()), null);
  assert.equal(imageInfo(gifBytes()), null);
});
