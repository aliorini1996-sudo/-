/**
 * بايتات صورٍ صناعية لاختبارات «النموذج المطبوع مسبقاً» (image-dims.test.ts وprint-forms-routes.test.ts) — ترويسات الصيغ الثلاث كما
 * تكتبها المرمّزات الحقيقية (PNG IHDR، JPEG APP0/DQT/DHT/SOFn/SOS، WebP VP8/VP8L/VP8X) بلا مكتبة. ليس ملف اختبار بنفسه.
 */

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** حشوٌ متغيّر (لا أصفار كلها) ليختلف المحتوى والبصمة بالبذرة */
const filler = (n: number, seed = 1) => Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff);

export function pngBytes(w: number, h: number, pad = 64, seed = 1): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), ...ascii('IHDR'), ...be32(w), ...be32(h), 8, 2, 0, 0, 0, ...be32(0x12345678),
    ...be32(pad), ...ascii('IDAT'), ...filler(pad, seed), ...be32(0),
    ...be32(0), ...ascii('IEND'), 0xae, 0x42, 0x60, 0x82,
  ]);
}

/** JPEG: SOI ثم APP0 وDQT وحشو FF وDHT (C4 ليس SOF) ثم SOFn وSOS وبياناتٌ وEOI */
export function jpegBytes(w: number, h: number, opts: { sof?: number; pad?: number; seed?: number; noSof?: boolean } = {}): Buffer {
  const { sof = 0xc0, pad = 64, seed = 1, noSof = false } = opts;
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xdb, ...be16(67), 0, ...filler(64, seed),
    0xff, 0xff, // حشوٌ قبل العلامة
    0xff, 0xc4, ...be16(4), 0, 0,
    ...(noSof ? [] : [0xff, sof, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    0xff, 0xda, ...be16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0,
    ...filler(pad, seed),
    0xff, 0xd9,
  ]);
}

const riff = (chunk: number[]) => Buffer.from([...ascii('RIFF'), ...le32(4 + chunk.length), ...ascii('WEBP'), ...chunk]);

export function webpVp8xBytes(w: number, h: number, pad = 32): Buffer {
  return riff([...ascii('VP8X'), ...le32(10), 0x10, 0, 0, 0, ...le24(w - 1), ...le24(h - 1), ...ascii('ALPH'), ...le32(pad), ...filler(pad)]);
}

/** VP8 (مفقود): وسم إطار مفتاحي ثم 9D 01 2A ثم العرض والارتفاع 14 بت ومعهما بتّا التكبير */
export function webpVp8Bytes(w: number, h: number, pad = 32): Buffer {
  return riff([...ascii('VP8 '), ...le32(10 + pad), 0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w | 0x4000), ...le16(h | 0x8000), ...filler(pad)]);
}

/** VP8L (بلا فقد): التوقيع 2F ثم العرض−1 والارتفاع−1 (14 بتاً لكلٍّ) وبت الشفافية والإصدار */
export function webpVp8lBytes(w: number, h: number, pad = 32): Buffer {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | (1 << 28);
  return riff([...ascii('VP8L'), ...le32(5 + pad), 0x2f, ...le32(bits >>> 0), ...filler(pad)]);
}

export const pdfBytes = (): Buffer => Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n', 'latin1');
export const gifBytes = (): Buffer => Buffer.from([...ascii('GIF89a'), ...le16(1240), ...le16(1754), 0, 0, 0, ...filler(32)]);
