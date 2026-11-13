import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  CUSTOMER_DOC_KINDS, CUSTOMER_DOC_MAX_DATA_LEN, CUSTOMER_DOC_MAX_PER_CUSTOMER, CUSTOMER_DOC_MAX_PER_REQUEST,
  docUploader, docsBatchRef, droppedDocsWarning, isServableImage, normalizeDocKind, parseCustomerDoc, parseCustomerDocs, sniffImageMime,
} from '../services/customerDocs';
import { customerBlockReason } from '../services/importLedger';
import type { AuthRequest } from '../types';

// «استديو العميل» وصور الوثائق مع إضافة العميل (طلب المالك ١٣ نوفمبر ٢٠٢٦)

const pad = (head: number[]) => Buffer.concat([Buffer.from(head), Buffer.alloc(64, 7)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), Buffer.alloc(64, 1)]);
const url = (mime: string, b: Buffer) => `data:image/${mime};base64,${b.toString('base64')}`;
const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');

test('الصورة تُفحص ببايتاتها: JPEG وPNG وWebP تُقبل، والبادئة الكاذبة تُرفض', () => {
  assert.equal(sniffImageMime(JPEG), 'jpeg');
  assert.equal(sniffImageMime(PNG), 'png');
  assert.equal(sniffImageMime(WEBP), 'webp');
  assert.equal(parseCustomerDoc({ kind: 'CR', data: url('jpeg', JPEG) })?.kind, 'CR');
  assert.ok(parseCustomerDoc({ data: url('png', PNG) }));
  assert.ok(parseCustomerDoc({ data: url('webp', WEBP) }));
  // بادئةٌ تقول JPEG وبايتاتٌ PNG، أو ملفٌ ليس صورة، أو صيغةٌ غير مسموحة
  assert.equal(parseCustomerDoc({ data: url('jpeg', PNG) }), null);
  assert.equal(parseCustomerDoc({ data: url('png', Buffer.from('%PDF-1.7 not an image at all, really not one')) }), null);
  assert.equal(parseCustomerDoc({ data: `data:image/svg+xml;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}` }), null);
  assert.equal(parseCustomerDoc({ data: 'https://evil.example/x.jpg' }), null);
  assert.equal(parseCustomerDoc(null), null);
});

test('السقف: نصٌّ أطول من الحدّ يُرفض، والحجم يُحسب من base64', () => {
  const big = `data:image/jpeg;base64,${'/9j/'}${'A'.repeat(CUSTOMER_DOC_MAX_DATA_LEN)}`;
  assert.equal(parseCustomerDoc({ data: big }), null);
  const ok = parseCustomerDoc({ data: url('jpeg', JPEG) })!;
  assert.equal(ok.sizeBytes, JPEG.length);
});

test('النوع: المجهول والغائب «وثيقة أخرى» — لا رفض', () => {
  assert.equal(normalizeDocKind('vat'), 'VAT');
  assert.equal(normalizeDocKind('PASSPORT'), 'OTHER');
  assert.equal(normalizeDocKind(undefined), 'OTHER');
  assert.equal(parseCustomerDoc({ kind: 42, data: url('jpeg', JPEG) })?.kind, 'OTHER');
});

test('قائمة الطلب: الصالح حتى السقف، والباقي يُعدّ مُسقطاً بتحذير — والغائب لا شيء', () => {
  assert.deepEqual(parseCustomerDocs(undefined), { docs: [], dropped: 0 });
  const many = Array.from({ length: CUSTOMER_DOC_MAX_PER_REQUEST + 2 }, () => ({ data: url('jpeg', JPEG) }));
  const r = parseCustomerDocs([...many, { data: 'x' }]);
  assert.equal(r.docs.length, CUSTOMER_DOC_MAX_PER_REQUEST);
  assert.equal(r.dropped, 3);
  assert.equal((droppedDocsWarning(r.dropped) as { code: string }).code, 'CUSTOMER_DOCS_DROPPED');
  assert.equal(droppedDocsWarning(0), null);
});

test('ستّ صور بسقفها تحت حدّ جسم JSON في الخادم', () => {
  const m = /express\.json\(\{\s*limit:\s*'(\d+)mb'/.exec(read('..', 'index.ts'));
  assert.ok(m, 'حدّ express.json');
  assert.ok(CUSTOMER_DOC_MAX_PER_REQUEST * CUSTOMER_DOC_MAX_DATA_LEN < Number(m![1]) * 1024 * 1024);
});

test('الأنواع والحدود نفسها في الخادم والواجهة', () => {
  const web = read('..', '..', '..', 'web-admin', 'src', 'lib', 'customerDocs.ts');
  assert.deepEqual([...web.matchAll(/\{ code: '(\w+)', label: '/g)].map((x) => x[1]), [...CUSTOMER_DOC_KINDS]);
  assert.match(web, new RegExp(`CUSTOMER_DOC_MAX_PER_REQUEST = ${CUSTOMER_DOC_MAX_PER_REQUEST};`));
  assert.match(web, new RegExp(`CUSTOMER_DOC_MAX_PER_CUSTOMER = ${CUSTOMER_DOC_MAX_PER_CUSTOMER};`));
});

test('مسارات الاستديو لمستخدمي الشركة وحدهم، خلف صلاحية العملاء، وكل استعلامٍ بشركة الطالب', () => {
  const studio = read('..', 'routes', 'customerStudio.ts');
  const routes = [...studio.matchAll(/customerStudioRouter\.(get|post|delete)\('([^']+)', (\w+)/g)];
  assert.deepEqual(routes.map((r) => `${r[1]} ${r[2]}`), [
    'get /:id/studio', 'get /:id/studio/:source/:itemId', 'post /:id/documents', 'delete /:id/documents/:docId', 'post /rep-documents',
  ]);
  for (const r of routes.slice(0, 4)) assert.equal(r[3], 'requireAdmin', `${r[1]} ${r[2]}`);
  // صفّ المندوب: للمندوب وحده، ولعميلٍ أنشأه هو
  const repRoute = studio.slice(studio.indexOf("customerStudioRouter.post('/rep-documents'"));
  assert.match(repRoute, /if \(req\.user\?\.role !== 'SALES_REP'\) \{ res\.status\(403\)/);
  assert.match(repRoute, /where: \{ tenantId: tid, createdBySalesRepId: req\.user\.id,/);
  // الصورة الواحدة لا تُعاد إلا data URL صورة
  assert.match(studio, /if \(!row \|\| !isServableImage\(row\.data\)\)/);
  // العميل بنطاق الطالب قبل أي شيء، والوثائق والصور بشركته
  assert.match(studio, /tenantId: tid, \.\.\.\(await customerScope\(req, tid\)\)/);
  assert.equal((studio.match(/studioCustomer\(req, tid\)/g) ?? []).length, 4);
  // مرفقات السندات لصاحب «سندات القبض» في القائمة وفي الصورة الواحدة
  assert.equal((studio.match(/canSeeReceiptPhotos\(req\)/g) ?? []).length, 2);
  assert.match(studio, /scopedRecordWhere\(req, SHAPE_VISIT\)/);
  assert.match(studio, /scopedRecordWhere\(req, SHAPE_INVOICE_RECEIPT\)/);
  assert.match(studio, /deleteMany\(\{ where: \{ id: String\(req\.params\.docId\), tenantId: tid, customerId: customer\.id \} \}\)/);

  const customers = read('..', 'routes', 'customers.ts');
  const perm = customers.indexOf("router.use(requireAdminPermission('canManageCustomers'));");
  const mount = customers.indexOf('router.use(customerStudioRouter);');
  assert.ok(perm > 0 && mount > perm, 'الاستديو بعد صلاحية العملاء');
});

test('إنشاء العميل يحفظ وثائقه معه ذرّياً ولا يُرفض لها، وإعادة الرفع لا تكرّرها', () => {
  const customers = read('..', 'routes', 'customers.ts');
  const post = customers.slice(customers.indexOf("router.post('/', async"), customers.indexOf('function keepableCustomerId'));
  assert.match(post, /const docsIn = parseCustomerDocs\(req\.body\?\.documents\);/);
  // داخل customer.create نفسه وحده (لا كتابة لاحقة قد تفشل وحدها) — وبمفتاح الدفعة الذي يعرفه صفّ المندوب
  assert.equal((post.match(/\.\.\.docsCreate,/g) ?? []).length, 1);
  assert.match(post, /docCreateRows\(tid, docsIn\.docs, req, docsRef\)/);
  // فرع إعادة الرفع بـclientRef يعود قبل أي وثيقة
  const idem = post.indexOf('idempotent: true');
  assert.ok(idem > 0 && idem < post.indexOf('...docsCreate,'));
  assert.doesNotMatch(post, /res\.status\(4\d\d\)[^\n]*docs/i);
});

test('صور الزيارات والسندات القديمة نصٌّ حرّ: لا يُعاد إلا data URL صورة — لا javascript: ولا رابط خارجي', () => {
  assert.equal(isServableImage(url('jpeg', JPEG)), true);
  assert.equal(isServableImage('javascript:alert(1)'), false);
  assert.equal(isServableImage('https://evil.example/pixel.gif'), false);
  assert.equal(isServableImage('data:text/html;base64,PHNjcmlwdD4='), false);
  assert.equal(isServableImage(null), false);
});

test('الرافع: جلسة «دخول» المالك ومفتاح الدعم باسم «الدعم الفني» لا باسم مدير الشركة', () => {
  const admin = { user: { id: 'a1', role: 'ADMIN', name: 'مدير الشركة' } } as unknown as AuthRequest;
  assert.deepEqual(docUploader(admin), { uploadedByKind: 'ADMIN', uploadedById: 'a1', uploadedByName: 'مدير الشركة' });
  const owner = { user: { id: 'a1', role: 'ADMIN', name: 'مدير الشركة', impersonated: true } } as unknown as AuthRequest;
  assert.deepEqual(docUploader(owner), { uploadedByKind: 'ADMIN', uploadedById: 'OWNER:a1', uploadedByName: 'الدعم الفني' });
  const rep = { user: { id: 'r1', role: 'SALES_REP', name: 'مندوب' } } as unknown as AuthRequest;
  assert.equal(docUploader(rep).uploadedByKind, 'REP');
  assert.equal(docsBatchRef('abc'), 'abc:docs');
});

test('تراجع دفعة استيراد العملاء لا يمحو وثائق رُفعت للعميل بصمت', () => {
  const zero = { invoices: 0, receipts: 0, paymentLinks: 0, visits: 0 };
  assert.equal(customerBlockReason({ ...zero, documents: 2 }), 'للعميل وثائق مرفوعة في استديو العميل');
  assert.equal(customerBlockReason({ ...zero, documents: 0 }), null);
  assert.match(read('..', 'routes', 'import.ts'), /documents: await tx\.customerDocument\.count\(\{ where: \{ customerId: cid, tenantId: tid \} \}\),/);
});

test('مزامنة نظامٍ خارجي بالرقم المرجعي (عميلٌ قائم) لا تضيف وثائق — كل مزامنة كانت ستكرّرها', () => {
  const customers = read('..', 'routes', 'customers.ts');
  const byRef = customers.slice(customers.indexOf('if (byRef && !creatorRepId) {'), customers.indexOf('if (byRef) {'));
  assert.doesNotMatch(byRef, /docsCreate/);
  assert.match(byRef, /CUSTOMER_DOCS_IGNORED/);
});
