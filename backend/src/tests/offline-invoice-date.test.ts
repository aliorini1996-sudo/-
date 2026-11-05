// مراجعة المخزون نوفمبر ٢٠٢٦ (البند ١٥، قرار المالك D11) — تاريخ فاتورة المندوب دون اتصال (services/offlineInvoiceDate.ts):
// لحظة الجهاز لإعادة رفع صندوق المندوب وحدها، محصورةً: لا مستقبل، ولا أقدم من سبعة أيام، ولا لحظة تالفة أو غائبة، ولا لحظةٍ
// عند تفعيل المرحلة الثانية أو بعده (تاريخها لحظة الختم IssueDate) — وإلا null فيبقى السلوك القائم (ساعة الخادم).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEVICE_CLOCK_SKEW_TOLERANCE_MS, OFFLINE_INVOICE_DATE_MAX_AGE_MS, offlineInvoiceDate, type OfflineDateInput } from '../services/offlineInvoiceDate';
import { CUTOVER_BACKDATE_LIMIT_MS } from '../compliance/zatca/goLive';
import { prefixFor } from '../utils/helpers';

const NOW = new Date('2026-11-04T08:00:00.000Z');
const base = (o: Partial<OfflineDateInput> = {}): OfflineDateInput => ({
  replay: true, role: 'SALES_REP', viaApiKey: false, clientCreatedAt: '2026-11-03T19:00:00.000Z', phase2StartedAt: null, now: NOW, ...o,
});

test('بيع الساعة ٢٢:٠٠ (بتوقيت الرياض) رُفع صباح الغد: تاريخ الفاتورة لحظة الجهاز', () => {
  assert.equal(offlineInvoiceDate(base())?.toISOString(), '2026-11-03T19:00:00.000Z');
});

test('الحصر: المستقبل (ولو دقيقة انحراف) ⇒ ساعة الخادم، واللحظة نفسها مقبولة', () => {
  assert.equal(offlineInvoiceDate(base({ clientCreatedAt: new Date(NOW.getTime() + 60_000).toISOString() })), null);
  assert.equal(offlineInvoiceDate(base({ clientCreatedAt: new Date(NOW.getTime() + 5 * 60_000).toISOString() })), null);
  assert.equal(offlineInvoiceDate(base({ clientCreatedAt: new Date(NOW.getTime() + 30 * 86_400_000).toISOString() })), null);
  assert.equal(offlineInvoiceDate(base({ clientCreatedAt: NOW.toISOString() }))?.getTime(), NOW.getTime());
});

test('الحصر: أقدم من سبعة أيام ⇒ ساعة الخادم، والحدّ نفسه مقبول', () => {
  assert.equal(OFFLINE_INVOICE_DATE_MAX_AGE_MS, 7 * 86_400_000);
  assert.equal(OFFLINE_INVOICE_DATE_MAX_AGE_MS, CUTOVER_BACKDATE_LIMIT_MS, 'حدّ قاعدة الانتقال نفسه');
  const edge = new Date(NOW.getTime() - OFFLINE_INVOICE_DATE_MAX_AGE_MS);
  assert.equal(offlineInvoiceDate(base({ clientCreatedAt: edge.toISOString() }))?.getTime(), edge.getTime());
  assert.equal(offlineInvoiceDate(base({ clientCreatedAt: new Date(edge.getTime() - 1).toISOString() })), null);
});

test('اللحظة الغائبة أو الفارغة أو التالفة ⇒ ساعة الخادم', () => {
  for (const clientCreatedAt of [undefined, null, '', '   ', 'غداً', 'not-a-date']) {
    assert.equal(offlineInvoiceDate(base({ clientCreatedAt })), null, String(clientCreatedAt));
  }
});

test('خارج إعادة رفع المندوب: الحيّ والإدارة ومفتاح API والتاريخ الصريح — السلوك القائم حرفياً', () => {
  assert.equal(offlineInvoiceDate(base({ replay: false })), null, 'إصدار حيّ');
  assert.equal(offlineInvoiceDate(base({ role: 'ADMIN' })), null, 'لوحة الإدارة');
  assert.equal(offlineInvoiceDate(base({ role: undefined })), null);
  assert.equal(offlineInvoiceDate(base({ viaApiKey: true })), null, 'مفتاح API');
  assert.equal(offlineInvoiceDate(base({ bodyInvoiceDate: '2026-11-01' })), null, 'التاريخ الصريح يغلب');
  assert.notEqual(offlineInvoiceDate(base({ bodyInvoiceDate: '  ' })), null, 'الفراغ ليس تاريخاً');
});

test('المرحلة الثانية: لحظة جهازٍ عند التفعيل أو بعده لا تُعتمد (تاريخها لحظة الختم: IssueDate وQR وICV ومهلة الإبلاغ)', () => {
  assert.equal(offlineInvoiceDate(base({ phase2StartedAt: new Date('2026-10-02T00:00:00.000Z') })), null);
  assert.equal(offlineInvoiceDate(base({ phase2StartedAt: new Date('2026-11-03T19:00:00.000Z') })), null, 'اللحظة نفسها ليست قبله');
});

test('المرحلة الثانية: المستند الانتقاليّ (لحظة جهازه قبل التفعيل، يُقبل مرحلةً أولى) يُؤرَّخ بلحظة الجهاز — والحصر كما هو', () => {
  const started = new Date('2026-11-04T00:00:00.000Z');
  assert.equal(offlineInvoiceDate(base({ phase2StartedAt: started, clientCreatedAt: '2026-11-03T19:00:00.000Z' }))?.toISOString(), '2026-11-03T19:00:00.000Z');
  // أقدم من سبعة أيام ⇒ ساعة الخادم ولو قبل التفعيل
  assert.equal(offlineInvoiceDate(base({ phase2StartedAt: started, clientCreatedAt: '2026-10-20T00:00:00.000Z' })), null);
  // تفعيلٌ تالف ⇒ لا اعتماد
  assert.equal(offlineInvoiceDate(base({ phase2StartedAt: new Date('x'), clientCreatedAt: '2026-11-03T19:00:00.000Z' })), null);
});

test('حارس نصّي: POST /invoices يمرّر لحظة الجهاز والمرحلة الثانية والمفتاح، والتاريخ الصريح يغلب، وفرع المرحلة الثانية بلا هذا التاريخ', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'invoices.ts'), 'utf8');
  assert.match(src, /const offlineAt = offlineInvoiceDate\(\{\s*replay: isReplay, role: req\.user!\.role, viaApiKey: Boolean\(req\.user\?\.apiKeyId\), bodyInvoiceDate: body\.invoiceDate,\s*clientCreatedAt: deviceAt, deviceNow: headerText\(req\.headers\[DEVICE_NOW_HEADER\]\),\s*phase2StartedAt: company\?\.zatcaPhase2StartedAt \?\? null, now: new Date\(\),\s*\}\);/);
  assert.match(src, /const docDate = body\.invoiceDate \? new Date\(body\.invoiceDate\) : \(offlineAt \?\? undefined\);/);
  // الشركة المحمَّلة تحمل علم المرحلة الثانية (لا استعلام زائد)
  assert.match(src, /zatcaPhase2StartedAt: true/);
});

test('حارس نصّي (D11-2): سند المندوب دون اتصال بالقاعدة نفسها — لحظة الجهاز، والتاريخ الصريح يغلب، ولا استثناء للمرحلة الثانية', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'receipts.ts'), 'utf8');
  assert.match(src, /const offlineAt = offlineInvoiceDate\(\{\s*replay: String\(req\.headers\['x-fs-replay'\] \|\| ''\) === '1', role: req\.user!\.role, viaApiKey: Boolean\(req\.user\?\.apiKeyId\),\s*bodyInvoiceDate: body\.receiptDate, clientCreatedAt: body\.clientCreatedAt, deviceNow: headerText\(req\.headers\[DEVICE_NOW_HEADER\]\),\s*phase2StartedAt: null, now: new Date\(\),\s*\}\);/);
  assert.match(src, /const docDate = body\.receiptDate \? new Date\(body\.receiptDate\) : \(offlineAt \?\? undefined\);/);
  // الرقم والقيد من التاريخ نفسه
  assert.match(src, /generateReceiptNumber\(tid, docDate, numTz\)/);
  assert.match(src, /const numTz = offlineAt \? await tenantTz\(tid\)\.catch\(\(\) => undefined\) : undefined;/);
  assert.match(src, /postReceiptEntries\(tx as never, tid, rcp\.id, customerId, body\.amount, docDate\)/);
});

test('D11-3: ساعة جهازٍ متأخّرة تُصحَّح بفرقها وقت الرفع (X-FS-Device-Now) — وضمن خمس دقائق أو بلا ترويسة كما كانت', () => {
  assert.equal(DEVICE_CLOCK_SKEW_TOLERANCE_MS, 5 * 60_000);
  const H2 = 2 * 3_600_000;
  // الجهاز متأخّر ساعتين: أصدر عند «17:00Z» على ساعته ورفع حين كانت ساعته 06:00Z (الخادم 08:00Z) ⇒ الإصدار الحقيقي 19:00Z
  const behind = offlineInvoiceDate(base({ clientCreatedAt: '2026-11-03T17:00:00.000Z', deviceNow: new Date(NOW.getTime() - H2).toISOString() }));
  assert.equal(behind?.toISOString(), '2026-11-03T19:00:00.000Z');
  // ومتقدّم ساعتين: يُعاد إلى الوراء بالفرق (لا يسقط إلى ساعة الخادم وحدها)
  const ahead = offlineInvoiceDate(base({ clientCreatedAt: '2026-11-03T21:00:00.000Z', deviceNow: new Date(NOW.getTime() + H2).toISOString() }));
  assert.equal(ahead?.toISOString(), '2026-11-03T19:00:00.000Z');
  // انحرافٌ ضمن التسامح: اللحظة كما أُرسلت
  const near = offlineInvoiceDate(base({ deviceNow: new Date(NOW.getTime() - 4 * 60_000).toISOString() }));
  assert.equal(near?.toISOString(), '2026-11-03T19:00:00.000Z');
  // والصيغة الرقمية (ملّي ثانية) التي يرسلها معترض repApi فعلاً — يغلب ترويسة الصندوق ISO
  const behindMs = offlineInvoiceDate(base({ clientCreatedAt: '2026-11-03T17:00:00.000Z', deviceNow: String(NOW.getTime() - H2) }));
  assert.equal(behindMs?.toISOString(), '2026-11-03T19:00:00.000Z');
  // ترويسةٌ غائبة أو تالفة ⇒ كما كان
  for (const deviceNow of [undefined, null, '', 'x']) {
    assert.equal(offlineInvoiceDate(base({ deviceNow }))?.toISOString(), '2026-11-03T19:00:00.000Z', String(deviceNow));
  }
  // والحصر بعد التصحيح: تصحيحٌ يخرج إلى المستقبل ⇒ ساعة الخادم
  assert.equal(offlineInvoiceDate(base({ clientCreatedAt: '2026-11-04T07:00:00.000Z', deviceNow: new Date(NOW.getTime() - H2).toISOString() })), null);
});

test('D11-4: بادئة رقم المستند المؤرَّخ بلحظة الجهاز من شهره بتوقيت الشركة — وبلا منطقة كما كانت', () => {
  // ١ نوفمبر ٠١:٠٠ بتوقيت الرياض = ٣١ أكتوبر ٢٢:٠٠Z
  const at = new Date('2026-10-31T22:00:00.000Z');
  assert.equal(prefixFor('INV', at, 'Asia/Riyadh'), 'INV-2611-');
  assert.equal(prefixFor('RCP', at, 'Asia/Riyadh'), 'RCP-2611-');
  assert.equal(prefixFor('RET', new Date('2026-11-15T10:00:00.000Z'), 'Asia/Riyadh'), 'RET-2611-');
  // منطقةٌ تالفة ⇒ ساعة الخادم (لا رمي)
  assert.match(prefixFor('INV', at, 'Not/AZone'), /^INV-26(10|11)-$/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'invoices.ts'), 'utf8');
  assert.match(src, /const numTz = offlineAt \? await tenantTz\(tid\)\.catch\(\(\) => undefined\) : undefined;/);
  assert.match(src, /generateReturnNumber\(tid, docDate, numTz\) : await generateInvoiceNumber\(tid, docDate, numTz\)/);
});
