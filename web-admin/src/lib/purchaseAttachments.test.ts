import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ATT_PROBLEM_KEYS, PURCHASE_ATT_IMAGE_MAX_BYTES, PURCHASE_ATT_MAX_PER_ENTRY, PURCHASE_ATT_MAX_PER_REQUEST, PURCHASE_ATT_NAME_MAX,
  PURCHASE_ATT_PDF_MAX_BYTES, PURCHASE_ATT_TOTAL_MAX_BYTES, addProblem, attachmentInvalidOf, attachmentName, attachmentsPayload,
  b64DecodedSize, b64ToBytes, checkAttachment, humanSize, isPdf, normalizePdfDataUrl, parseAttachmentData, pdfBytesOf, pdfFileProblem,
  pickedFileKind, problemText, safeImageSrc, slotsLeft, sniffAttachmentMime, type PickedAttachment,
} from './purchaseAttachments';

// «إرفاق فاتورة المشتريات» (طلب المالك ١٣ نوفمبر ٢٠٢٦)

const b64 = (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString('base64');
const pad = (head: number[], n = 64) => [...head, ...new Array(Math.max(0, n - head.length)).fill(0x20)];
const JPEG = `data:image/jpeg;base64,${b64(pad([0xff, 0xd8, 0xff, 0xe0]))}`;
const PNG = `data:image/png;base64,${b64(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))}`;
const WEBP = `data:image/webp;base64,${b64(pad([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]))}`;
const PDF = `data:application/pdf;base64,${b64(pad([...Buffer.from('%PDF-1.7\n')]))}`;
const att = (mime: PickedAttachment['mime'], size: number): PickedAttachment => ({ key: `${mime}-${size}`, name: 'x', mime, size, data: '' });

test('التوقيعات الأربعة من البايتات — وغيرها null', () => {
  assert.equal(sniffAttachmentMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])), 'image/jpeg');
  assert.equal(sniffAttachmentMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.equal(sniffAttachmentMime(Uint8Array.from(Buffer.from('RIFF\0\0\0\0WEBP'))), 'image/webp');
  assert.equal(sniffAttachmentMime(Uint8Array.from(Buffer.from('%PDF-1.4'))), 'application/pdf');
  assert.equal(sniffAttachmentMime(Uint8Array.from(Buffer.from('GIF89a'))), null);
  assert.equal(sniffAttachmentMime(Uint8Array.from(Buffer.from('RIFF\0\0\0\0WAVE'))), null);
});

test('فكّ base64 وحجمه بعد الفكّ يطابقان Buffer', () => {
  for (const n of [1, 2, 3, 4, 5, 63, 64, 1000]) {
    const raw = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
    const s = b64(raw);
    assert.equal(b64DecodedSize(s), n);
    assert.deepEqual([...b64ToBytes(s)], [...raw]);
    assert.deepEqual([...b64ToBytes(s, 3)], [...raw.subarray(0, 3)]);
  }
});

test('data URL صالحة بتوقيعها: البادئة وحدها لا تكفي', () => {
  assert.equal(parseAttachmentData(JPEG)?.mime, 'image/jpeg');
  assert.equal(parseAttachmentData(PNG)?.mime, 'image/png');
  assert.equal(parseAttachmentData(WEBP)?.mime, 'image/webp');
  assert.equal(parseAttachmentData(PDF)?.mime, 'application/pdf');
  assert.equal(parseAttachmentData(PDF)?.size, 64);
  // بادئة PDF وبايتات JPEG (أو العكس) ⇒ مرفوض
  assert.equal(parseAttachmentData(PDF.replace('application/pdf', 'image/jpeg')), null);
  assert.equal(parseAttachmentData(JPEG.replace('image/jpeg', 'application/pdf')), null);
  // نوعٌ غير مقبول، أو نصّ base64 فاسد، أو ليس نصّاً
  assert.equal(parseAttachmentData(`data:image/gif;base64,${b64(pad([...Buffer.from('GIF89a')]))}`), null);
  assert.equal(parseAttachmentData(`data:image/svg+xml;base64,${b64(pad([...Buffer.from('<svg>')]))}`), null);
  assert.equal(parseAttachmentData(`${JPEG}"onerror="x`), null);
  assert.equal(parseAttachmentData(JPEG.slice(0, -1)), null);
  assert.equal(parseAttachmentData(null), null);
});

test('الفحص: سقف الصورة وسقف PDF بعد الفكّ، والاسم من النوع الفعلي', () => {
  const ok = checkAttachment({ name: 'C:\\fakepath\\فاتورة المورد.HEIC', data: JPEG }, 1);
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.att.name, 'فاتورة المورد.jpg'); assert.equal(ok.att.mime, 'image/jpeg'); assert.equal(ok.att.size, 64); }
  const bigImg = `data:image/jpeg;base64,${b64(pad([0xff, 0xd8, 0xff], PURCHASE_ATT_IMAGE_MAX_BYTES + 1))}`;
  const r1 = checkAttachment({ name: 'a', data: bigImg });
  assert.equal(r1.ok ? null : r1.problem.code, 'IMAGE_TOO_BIG');
  // PDF بحجم يتجاوز سقف الصورة مقبول — وفوق سقفه مرفوض
  const pdfOk = `data:application/pdf;base64,${b64(pad([...Buffer.from('%PDF-')], PURCHASE_ATT_IMAGE_MAX_BYTES + 10))}`;
  assert.ok(checkAttachment({ name: 'a.pdf', data: pdfOk }).ok);
  assert.equal(pdfFileProblem(PURCHASE_ATT_PDF_MAX_BYTES), null);
  assert.equal(pdfFileProblem(PURCHASE_ATT_PDF_MAX_BYTES + 1)?.code, 'PDF_TOO_BIG');
  const bad = checkAttachment({ name: 'a', data: PDF.replace('application/pdf', 'image/png') });
  assert.equal(bad.ok ? null : bad.problem.code, 'CORRUPT');
  const other = checkAttachment({ name: 'a', data: 'data:text/html;base64,PGgxPg==' });
  assert.equal(other.ok ? null : other.problem.code, 'TYPE');
});

test('السقوف: الطلب والحركة والمجموع', () => {
  assert.equal(PURCHASE_ATT_MAX_PER_REQUEST, 5);
  assert.equal(PURCHASE_ATT_MAX_PER_ENTRY, 10);
  const five = Array.from({ length: 5 }, () => att('image/jpeg', 1000));
  assert.equal(addProblem(five.slice(0, 4), att('image/jpeg', 1000)), null);
  assert.equal(addProblem(five, att('image/jpeg', 1000))?.code, 'TOO_MANY');
  // المحفوظ للحركة يُحسب: ٨ محفوظة + ٢ مختارة = السقف
  assert.equal(addProblem(five.slice(0, 2), att('image/jpeg', 1000), { existing: 8 })?.code, 'ENTRY_FULL');
  assert.equal(slotsLeft(0, 0), 5);
  assert.equal(slotsLeft(2, 7), 1);
  assert.equal(slotsLeft(0, 10), 0);
  // ثلاثة PDF بأربعة ميغابايت تقريباً: الثاني يتجاوز المجموع (٦)
  const pdf = att('application/pdf', PURCHASE_ATT_PDF_MAX_BYTES - 10);
  assert.equal(addProblem([], pdf), null);
  assert.equal(addProblem([pdf], pdf)?.code, 'TOTAL_TOO_BIG');
  assert.ok(PURCHASE_ATT_TOTAL_MAX_BYTES * 4 / 3 < 10 * 1024 * 1024, 'الجسم بترميزه تحت حدّ JSON في الخادم');
});

test('نوع الملف المختار: النوع المعلن ثم الامتداد حين لا نوع — والتوقيع يحسم بعد القراءة', () => {
  assert.equal(pickedFileKind({ type: 'application/pdf', name: 'x' }), 'pdf');
  assert.equal(pickedFileKind({ type: 'image/heic', name: 'x.heic' }), 'image');
  assert.equal(pickedFileKind({ type: '', name: 'INV.PDF' }), 'pdf');
  assert.equal(pickedFileKind({ type: 'application/octet-stream', name: 'a.jpg' }), 'image');
  assert.equal(pickedFileKind({ type: 'text/html', name: 'a.pdf' }), null);
  assert.equal(pickedFileKind({ type: 'application/zip', name: 'a.zip' }), null);
});

test('PDF مقروءاً بنوعٍ آخر يُصحَّح بتوقيعه — وغير PDF null', () => {
  const raw = PDF.replace('application/pdf', 'application/octet-stream');
  assert.equal(normalizePdfDataUrl(raw), PDF);
  assert.equal(normalizePdfDataUrl(JPEG), null);
  assert.equal(normalizePdfDataUrl('not-a-data-url'), null);
  assert.deepEqual([...pdfBytesOf(PDF)!.subarray(0, 5)], [...Buffer.from('%PDF-')]);
  assert.equal(pdfBytesOf(JPEG), null);
});

test('الاسم: بلا مسار ولا محارف تحكّم، بحدّه، واسمٌ عامّ للفارغ', () => {
  assert.equal(attachmentName('  ', 'application/pdf', 2), 'purchase-invoice-2.pdf');
  assert.equal(attachmentName(null, 'image/jpeg', 3), 'invoice-photo-3.jpg');
  assert.equal(attachmentName('a/b/inv\u0000oice.pdf', 'application/pdf'), 'invoice.pdf');
  const long = attachmentName('ف'.repeat(300), 'application/pdf');
  assert.equal(long.length, PURCHASE_ATT_NAME_MAX);
  assert.ok(long.endsWith('.pdf'));
});

test('العرض الآمن: الصورة المفحوصة وحدها في src', () => {
  assert.equal(safeImageSrc(JPEG), JPEG);
  assert.equal(safeImageSrc(PDF), null);
  assert.equal(safeImageSrc('data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.equal(safeImageSrc('javascript:alert(1)'), null);
  assert.equal(safeImageSrc(`${JPEG}" onerror="x`), null);
  assert.equal(isPdf('application/pdf'), true);
  assert.equal(isPdf({ mime: 'image/png' }), false);
  assert.equal(humanSize(850 * 1024), '850 KB');
  assert.equal(humanSize(1.25 * 1024 * 1024), '1.3 MB');
  assert.equal(humanSize(10), '1 KB');
});

test('الحمولة: لا مفتاح بلا مرفقات (الجسم ومرجع المحاولة كما كانا)، والاسم والبيانات وحدهما معها', () => {
  assert.deepEqual(attachmentsPayload([]), {});
  assert.deepEqual(attachmentsPayload([{ key: 'k', name: 'a.pdf', mime: 'application/pdf', size: 64, data: PDF }]),
    { attachments: [{ name: 'a.pdf', data: PDF }] });
});

test('ردّ 400 ATTACHMENT_INVALID يُقرأ برسالته — وغيره null', () => {
  assert.equal(attachmentInvalidOf({ response: { status: 400, data: { code: 'ATTACHMENT_INVALID', message: 'المرفق الثاني ليس PDF' } } }), 'المرفق الثاني ليس PDF');
  assert.equal(attachmentInvalidOf({ response: { status: 400, data: { code: 'ATTACHMENT_INVALID' } } }), ATT_PROBLEM_KEYS.TYPE);
  assert.equal(attachmentInvalidOf({ response: { status: 400, data: { code: 'UNIT_INVALID', message: 'x' } } }), null);
  assert.equal(attachmentInvalidOf(new Error('x')), null);
  assert.equal(problemText({ code: 'TOO_MANY', key: ATT_PROBLEM_KEYS.TOO_MANY, n: 5 }, (s) => s), 'الحد الأقصى 5 مرفقات');
});

// ─── حرّاس الشاشة ───
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

test('نافذة «استلام / تسوية»: المرفقات في جسم الحركة نفسه، و«حفظ» ينتظر تجهيزها', () => {
  const s = read('pages', 'CompanyWarehousePage.tsx');
  assert.match(s, /\.\.\.attachmentsPayload\(atts\),\n\s+\};\n\s+\/\/ المرجع من المحتوى/);
  assert.match(s, /disabled=\{save\.isPending \|\| !valid \|\| attBusy\}/);
  assert.match(s, /attachmentInvalidOf\(e\)/);
  assert.match(s, /tr\('إرفاق فاتورة المشتريات'\)/);
  // السجلّ: مشبكٌ بعدد المرفقات يفتح نافذتها، والإضافة والحذف لمن يسجّل الحركات وحده
  assert.match(s, /e\.attachmentsCount/);
  assert.match(s, /<EntryAttachmentsModal entry=\{attsOf\} canEdit=\{canEditEntries\}/);
});

test('المنتقي: تصوير واستديو وPDF، والصورة تُضغط على الجهاز', () => {
  const s = read('components', 'PurchaseAttachmentsPicker.tsx');
  assert.match(s, /accept="image\/\*" capture="environment"/);
  assert.match(s, /accept="image\/\*" multiple/);
  assert.match(s, /accept="application\/pdf" multiple/);
  assert.match(s, /compressImage\(f, PURCHASE_ATT_COMPRESS\)/);
});

test('العارض: الصورة المفحوصة وحدها، وPDF بـBlob URL لا data: في رابط', () => {
  const s = read('components', 'EntryAttachmentsModal.tsx');
  assert.match(s, /safeImageSrc\(/);
  assert.match(s, /URL\.createObjectURL\(/);
  assert.doesNotMatch(s, /href=\{[^}]*\.data\}/);
});
