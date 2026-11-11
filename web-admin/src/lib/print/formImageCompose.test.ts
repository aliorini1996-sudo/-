// «نموذج الشركة المطبوع مسبقاً» — الأجزاء الخالصة لتجهيز صورة النموذج: تصنيف الملف (PDF برسالته)، المقاسات، الأركان، حلقة جودة
// JPEG حتى 600 كيلوبايت، قراءة ردّ الخادم، ورسائل الأخطاء برموزها — وترجمة كل رسالة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORM_DECODE_MAX_PX, FORM_IMAGE_ACCEPT, FORM_JPEG_QUALITIES, FORM_UPLOAD_MESSAGES, FORM_UPLOAD_TARGET_BYTES, FormImageError,
  classifyFormFile, clampPt, defaultFormQuad, encodeWithinBudget, fitWithin, formImageRefOf, formUploadErrorCode,
  formUploadErrorMessage, quadAspect, quadAspectMismatch, quadUsable, scaleQuad, withQuadCorner, type Quad,
} from './formImageCompose';
import { formRasterPx } from './formModel';
import { PHRASES } from '../../i18n/strings';

test('classifyFormFile: الصور الثلاث بنوعها أو امتدادها، وPDF برسالته، وغير المدعوم والفارغ والضخم', () => {
  assert.equal(classifyFormFile({ type: 'image/jpeg', name: 'a.jpg', size: 10 }), 'image');
  assert.equal(classifyFormFile({ type: 'image/png', name: 'a', size: 10 }), 'image');
  assert.equal(classifyFormFile({ type: 'IMAGE/WEBP', name: 'a.webp', size: 10 }), 'image');
  assert.equal(classifyFormFile({ type: '', name: 'scan.JPEG', size: 10 }), 'image');
  assert.equal(classifyFormFile({ type: 'application/pdf', name: 'form.pdf', size: 10 }), 'pdf');
  assert.equal(classifyFormFile({ type: '', name: 'form.PDF', size: 10 }), 'pdf');
  assert.equal(classifyFormFile({ type: 'image/heic', name: 'IMG_1.HEIC', size: 10 }), 'unsupported');
  assert.equal(classifyFormFile({ type: 'image/gif', name: 'a.gif', size: 10 }), 'unsupported');
  assert.equal(classifyFormFile({ type: 'image/png', name: 'a.png', size: 0 }), 'empty');
  assert.equal(classifyFormFile({ type: 'image/png', name: 'a.png', size: 41 * 1024 * 1024 }), 'huge');
  assert.equal(classifyFormFile({}), 'unsupported');
  // أسماءٌ غير قانونية للصيغ نفسها (ويندوز وبعض المتصفّحات)، وامتدادٌ معروف بنوعٍ ليس صورة — الفكّ يحكم بعدها
  for (const type of ['image/jpg', 'image/pjpeg', 'image/x-png', 'IMAGE/JPG', 'image/jfif']) assert.equal(classifyFormFile({ type, name: 'form', size: 10 }), 'image', type);
  assert.equal(classifyFormFile({ type: 'application/octet-stream', name: 'form.jpg', size: 10 }), 'image');
  assert.equal(classifyFormFile({ type: 'application/octet-stream', name: 'form.bin', size: 10 }), 'unsupported');
  assert.equal(classifyFormFile({ type: 'image/heic', name: 'form.jpg', size: 10 }), 'unsupported', 'نوعٌ صريحٌ غير مدعوم يغلب الامتداد');
  assert.equal(classifyFormFile({ type: 'image/pjpeg', name: 'a.jpg', size: 0 }), 'empty');
  // حقل الملف يقبل PDF ليظهر لصاحبه سبب الرفض بدل أن يختفي من النافذة
  assert.match(FORM_IMAGE_ACCEPT, /image\/jpeg/);
  assert.match(FORM_IMAGE_ACCEPT, /application\/pdf/);
  assert.equal(FORM_UPLOAD_MESSAGES.pdf, 'احفظ الملف صورة JPG أو PNG ثم ارفعه');
});

test('fitWithin: أطول ضلع ≤ 2400 بنسبةٍ محفوظة، والأصغر كما هو، والقيم الفاسدة لا تنتج NaN', () => {
  assert.equal(FORM_DECODE_MAX_PX, 2400);
  assert.deepEqual(fitWithin(4032, 3024, 2400), { w: 2400, h: 1800 });
  assert.deepEqual(fitWithin(3024, 4032, 2400), { w: 1800, h: 2400 });
  assert.deepEqual(fitWithin(1240, 1754, 2400), { w: 1240, h: 1754 });
  assert.deepEqual(fitWithin(12000, 10, 2400), { w: 2400, h: 2 });
  const bad = fitWithin(Number.NaN, -5, 2400);
  assert.ok(bad.w >= 1 && bad.h >= 1);
});

test('مقاس الصورة المصحّحة: A4 = 1240 × 1754 بكسل عند 150 نقطة، وA5 وLetter', () => {
  assert.deepEqual(formRasterPx({ widthMm: 210, lengthMm: 297 }), { wPx: 1240, hPx: 1754 });
  assert.deepEqual(formRasterPx({ widthMm: 148, lengthMm: 210 }), { wPx: 874, hPx: 1240 });
  assert.deepEqual(formRasterPx({ widthMm: 215.9, lengthMm: 279.4 }), { wPx: 1275, hPx: 1650 });
});

test('الأركان: الافتراضي أركان الصورة، والتحريك داخلها، والتحويل بين الفضاءين', () => {
  const q = defaultFormQuad(2400, 1800);
  assert.deepEqual(q, [{ x: 0, y: 0 }, { x: 2400, y: 0 }, { x: 2400, y: 1800 }, { x: 0, y: 1800 }]);
  const moved = withQuadCorner(q, 2, { x: 9999, y: 1500 }, 2400, 1800);
  assert.deepEqual(moved[2], { x: 2400, y: 1500 });
  assert.equal(moved[0], q[0]);
  assert.notEqual(moved, q);
  assert.equal(withQuadCorner(q, 7, { x: 1, y: 1 }, 10, 10), q);
  assert.deepEqual(clampPt({ x: -4, y: Number.NaN }, 100, 50), { x: 0, y: 0 });
  assert.deepEqual(scaleQuad(q, 2400, 1800, 1200, 900)[2], { x: 1200, y: 900 });
});

test('صلاحية الأركان ونسبتها: المتقاطع أو الصغير جداً لا يُصحَّح، والنسبة البعيدة عن الورقة تنبيه', () => {
  const a4: Quad = [{ x: 100, y: 50 }, { x: 1340, y: 50 }, { x: 1340, y: 1804 }, { x: 100, y: 1804 }];
  assert.equal(quadUsable(a4, 1500, 1900), true);
  // الأركان المعكوسة (محدّبة لكن بترتيبٍ معكوس على الشاشة) تُخرج صورةً كالمرآة ⇒ غير صالحة
  const mirrored: Quad = [a4[1], a4[0], a4[3], a4[2]];
  assert.equal(quadUsable(mirrored, 1500, 1900), false, 'اليسار مكان اليمين');
  assert.equal(quadUsable([a4[3], a4[2], a4[1], a4[0]], 1500, 1900), false, 'الأعلى مكان الأسفل');
  near(quadAspect(a4), 1240 / 1754);
  assert.equal(quadAspectMismatch(a4, { widthMm: 210, lengthMm: 297 }), false);
  // صورة جوال مائلة قليلاً: لا تنبيه
  const tilted: Quad = [{ x: 212, y: 95 }, { x: 1580, y: 160 }, { x: 1650, y: 2080 }, { x: 140, y: 2010 }];
  assert.equal(quadAspectMismatch(tilted, { widthMm: 210, lengthMm: 297 }), false);
  // الأركان على صورةٍ أفقية كاملة مع ورق A4 عمودي: تنبيه
  assert.equal(quadAspectMismatch(defaultFormQuad(2400, 1800), { widthMm: 210, lengthMm: 297 }), true);
  // ربطة عنق
  assert.equal(quadUsable([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }], 100, 100), false);
  // أقلّ من 5٪ من الصورة
  assert.equal(quadUsable([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], 1000, 1000), false);
});

function near(a: number, b: number, eps = 1e-6) { assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`); }

/** مرمِّزٌ مزيّف: الحجم يتناسب مع الجودة */
const fakeEncoder = (bytesAt: (q: number) => number, calls: number[]) => async (q: number): Promise<Blob | null> => {
  calls.push(q);
  return new Blob([new Uint8Array(bytesAt(q))], { type: 'image/jpeg' });
};

test('حلقة الجودة: 0.85 ثم نزولاً حتى 0.5 — أوّل نتيجةٍ ضمن 600 كيلوبايت، وإلا الأصغر', async () => {
  assert.deepEqual([...FORM_JPEG_QUALITIES], [0.85, 0.78, 0.71, 0.64, 0.57, 0.5]);
  assert.equal(FORM_UPLOAD_TARGET_BYTES, 600 * 1024);
  const c1: number[] = [];
  const r1 = await encodeWithinBudget(fakeEncoder(() => 300 * 1024, c1));
  assert.deepEqual(c1, [0.85]);
  assert.equal(r1?.quality, 0.85);
  const c2: number[] = [];
  const r2 = await encodeWithinBudget(fakeEncoder((q) => Math.round(q * 1000) * 1024, c2));
  assert.deepEqual(c2, [0.85, 0.78, 0.71, 0.64, 0.57]);
  assert.equal(r2?.quality, 0.57);
  assert.ok((r2?.blob.size ?? 0) <= 600 * 1024);
  const c3: number[] = [];
  const r3 = await encodeWithinBudget(fakeEncoder((q) => Math.round(q * 2000) * 1024, c3));
  assert.equal(c3.length, 6);
  assert.equal(r3?.quality, 0.5);
  // المرمِّز لا ينتج شيئاً ⇒ null (أو آخر ما نجح)
  assert.equal(await encodeWithinBudget(async () => null), null);
  let n = 0;
  const r4 = await encodeWithinBudget(async () => (++n === 1 ? new Blob([new Uint8Array(900 * 1024)]) : null));
  assert.equal(r4?.quality, 0.85);
});

test('ردّ الخادم ⇒ مرجع الصورة: المعرّف uuid والبصمة hex والأبعاد 200..10000، وما سواه null', () => {
  const ok = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', v: 'a1b2c3d4e5f60718', wPx: 1240, hPx: 1754, sizeBytes: 345000 };
  assert.deepEqual(formImageRefOf(ok), { id: ok.id, v: ok.v, wPx: 1240, hPx: 1754 });
  assert.equal(formImageRefOf(null), null);
  assert.equal(formImageRefOf({ ...ok, id: 'x' }), null);
  assert.equal(formImageRefOf({ ...ok, v: 'XYZ' }), null);
  assert.equal(formImageRefOf({ ...ok, wPx: 199 }), null);
  assert.equal(formImageRefOf({ ...ok, hPx: 1754.5 }), null);
  assert.equal(formImageRefOf({ ...ok, hPx: '1754' }), null);
});

test('رسائل الأخطاء: التجهيز برمزه، وردّ الخادم برمزه أو حالته، والشبكة', () => {
  assert.equal(formUploadErrorCode(new FormImageError('quad')), 'quad');
  assert.equal(new FormImageError('pdf').message, FORM_UPLOAD_MESSAGES.pdf);
  const res = (status: number, code?: string) => ({ response: { status, data: code ? { code } : {} } });
  assert.equal(formUploadErrorCode(res(400, 'PRINT_FORM_TYPE')), 'type');
  assert.equal(formUploadErrorCode(res(413, 'PRINT_FORM_TOO_LARGE')), 'tooLarge');
  assert.equal(formUploadErrorCode(res(413)), 'tooLarge');
  assert.equal(formUploadErrorCode(res(400, 'PRINT_FORM_SIZE')), 'size');
  assert.equal(formUploadErrorCode(res(409, 'PRINT_FORM_LIMIT')), 'limit');
  assert.equal(formUploadErrorCode(res(403, 'API_KEY_FORBIDDEN')), 'apiKey');
  assert.equal(formUploadErrorCode(res(403, 'FORBIDDEN')), 'forbidden');
  assert.equal(formUploadErrorCode(res(400, 'PRINT_FORM_INVALID')), 'failed');
  assert.equal(formUploadErrorCode(res(500)), 'failed');
  assert.equal(formUploadErrorCode({ code: 'ERR_NETWORK', request: {} }), 'network');
  assert.equal(formUploadErrorCode(new Error('x')), 'failed');
  assert.equal(formUploadErrorMessage(res(409, 'PRINT_FORM_LIMIT')), FORM_UPLOAD_MESSAGES.limit);
});

test('ترجمة: كل رسالة رفع لها en/fr/tr/zh (الفرنسية بلا فاصلة عليا)', () => {
  const missing: string[] = [];
  for (const ar of Object.values(FORM_UPLOAD_MESSAGES)) {
    const e = (PHRASES as Record<string, { en?: string; fr?: string; tr?: string; zh?: string }>)[ar];
    if (!e || !e.en || !e.fr || !e.tr || !e.zh) { missing.push(ar); continue; }
    assert.doesNotMatch(e.fr, /'/, `فاصلة عليا في الفرنسية: ${ar}`);
  }
  assert.deepEqual(missing, [], `نصوص بلا ترجمة: ${missing.join(' | ')}`);
});
