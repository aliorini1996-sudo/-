// مراجعة المخزون نوفمبر ٢٠٢٦ (البند ١٥، قرار المالك D11) — تاريخ فاتورة المندوب دون اتصال (services/offlineInvoiceDate.ts):
// لحظة الجهاز لإعادة رفع صندوق المندوب وحدها، محصورةً: لا مستقبل، ولا أقدم من سبعة أيام، ولا لحظة تالفة أو غائبة، ولا لحظةٍ
// عند تفعيل المرحلة الثانية أو بعده (تاريخها لحظة الختم IssueDate) — وإلا null فيبقى السلوك القائم (ساعة الخادم).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEVICE_CLOCK_SKEW_TOLERANCE_MS, OFFLINE_INVOICE_DATE_MAX_AGE_MS, PRICE_REPLAY_MAX_AGE_MS, PRICING_DAY_WINDOW_MS, deviceClockSkewMs,
  devicePriceInstant, devicePricingDay, offlineInvoiceDate, priceRulesKnownAt, rawDeviceMoment, rowsKnownAt, type DevicePriceInput, type OfflineDateInput,
} from '../services/offlineInvoiceDate';
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

// ═══ «قوائم الأسعار» (٥ نوفمبر ٢٠٢٦): لحظة الجهاز ليوم تسعير قواعد القائمة ذات الفترة (devicePriceInstant) ═══

const priceBase = (o: Partial<DevicePriceInput> = {}): DevicePriceInput => ({
  replay: true, role: 'SALES_REP', viaApiKey: false, clientCreatedAt: '2026-11-03T19:00:00.000Z', now: NOW, ...o,
});

test('devicePriceInstant: حصر offlineInvoiceDate نفسه — إعادة رفع المندوب وحده، لا مستقبل، واللحظة التالفة ⇒ null — والعمر ثلاثون يوماً (D1)', () => {
  assert.equal(devicePriceInstant(priceBase())?.toISOString(), '2026-11-03T19:00:00.000Z');
  assert.equal(devicePriceInstant(priceBase({ replay: false })), null, 'إصدار حيّ');
  assert.equal(devicePriceInstant(priceBase({ role: 'ADMIN' })), null, 'لوحة الإدارة');
  assert.equal(devicePriceInstant(priceBase({ viaApiKey: true })), null, 'مفتاح API');
  assert.equal(devicePriceInstant(priceBase({ clientCreatedAt: new Date(NOW.getTime() + 60_000).toISOString() })), null, 'مستقبل');
  // CONTRACT2 D1: ثلاثون يوماً للتسعير وحده — مستندٌ محجوز «بانتظار الإدارة» أكثر من أسبوع يُسعَّر بيوم بيعه
  assert.equal(PRICE_REPLAY_MAX_AGE_MS, 30 * 86_400_000);
  const edge = new Date(NOW.getTime() - PRICE_REPLAY_MAX_AGE_MS);
  assert.equal(devicePriceInstant(priceBase({ clientCreatedAt: edge.toISOString() }))?.getTime(), edge.getTime());
  assert.equal(devicePriceInstant(priceBase({ clientCreatedAt: new Date(edge.getTime() - 1).toISOString() })), null, 'أقدم من ثلاثين يوماً');
  for (const days of [8, 10, 25]) {
    const at = new Date(NOW.getTime() - days * 86_400_000);
    assert.equal(devicePriceInstant(priceBase({ clientCreatedAt: at.toISOString() }))?.getTime(), at.getTime(), `${days} أيام: لحظة الجهاز للتسعير`);
    assert.equal(offlineInvoiceDate(base({ clientCreatedAt: at.toISOString() })), null, `${days} أيام: التأريخ بحدّ السبعة كما كان`);
  }
  assert.equal(devicePriceInstant(priceBase({ clientCreatedAt: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() })), null, 'أربعون يوماً ⇒ ساعة الخادم');
  // وحدّ التأريخ لم يتغيّر
  assert.equal(OFFLINE_INVOICE_DATE_MAX_AGE_MS, 7 * 86_400_000);
  for (const clientCreatedAt of [undefined, null, '', 'غداً']) assert.equal(devicePriceInstant(priceBase({ clientCreatedAt })), null, String(clientCreatedAt));
  // وانحراف ساعة الجهاز يُصحَّح بالفرق كما في التأريخ
  const behind = devicePriceInstant(priceBase({ clientCreatedAt: '2026-11-03T17:00:00.000Z', deviceNow: String(NOW.getTime() - 2 * 3_600_000) }));
  assert.equal(behind?.toISOString(), '2026-11-03T19:00:00.000Z');
});

test('devicePriceInstant بلا استثناءي التأريخ: المرحلة الثانية لا تُسقط لحظة البيع، ولا يُقرأ تاريخ الجسم — والتأريخ نفسه كما كان', () => {
  const p2 = new Date('2026-10-02T00:00:00.000Z');
  assert.equal(offlineInvoiceDate(base({ phase2StartedAt: p2 })), null, 'التأريخ بالختم كما كان');
  assert.equal(devicePriceInstant({ ...priceBase(), phase2StartedAt: p2 } as DevicePriceInput)?.toISOString(), '2026-11-03T19:00:00.000Z');
  assert.equal(offlineInvoiceDate(base({ bodyInvoiceDate: '2026-11-01' })), null, 'التاريخ الصريح يغلب التأريخ كما كان');
  assert.equal(devicePriceInstant({ ...priceBase(), bodyInvoiceDate: '2026-11-01' } as DevicePriceInput)?.toISOString(), '2026-11-03T19:00:00.000Z');
});

test('حارس نصّي: يوم تسعير القائمة في POST /invoices من devicePriceInstant (لا invoiceDate) ومنطقة الشركة لقائمةٍ بقاعدةٍ ذات فترة وحدها، ومرشّحا D1/D3', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'invoices.ts'), 'utf8');
  const at = src.indexOf('const priceNow = ');
  assert.ok(at > 0);
  const block = src.slice(at, src.indexOf('type PriceCandidate', at));
  // ساعة الخادم وترويسة ساعة الجهاز مرّةً واحدة: لحظة الإصدار ولحظة جلب الكاش تُصحَّحان بالانحراف نفسه
  assert.match(block, /^const priceNow = new Date\(\);\s*const priceDeviceNow = headerText\(req\.headers\[DEVICE_NOW_HEADER\]\);/);
  // لحظة التسعير: لقائمةٍ بقواعد وحدها، من devicePriceInstant بلا تاريخ الجسم ولا المرحلة الثانية
  assert.match(block, /const priceInstant = docRules\.length \? devicePriceInstant\(\{\s*replay: isReplay, role: req\.user!\.role, viaApiKey: Boolean\(req\.user\?\.apiKeyId\),\s*clientCreatedAt: deviceAt, deviceNow: priceDeviceNow, now: priceNow,\s*\}\) : null;/);
  // اليوم: منطقة الشركة لقائمةٍ بقاعدةٍ ذات فترة وحدها (قراءةٌ واحدة)، ولحظة الجهاز وإلا الآن
  assert.match(block, /const datedRules = docRules\.some\(\(r\) => r\.startsOn != null \|\| r\.endsOn != null\);/);
  assert.match(block, /const priceTz = datedRules \? await tenantTz\(tid\) : null;/);
  assert.match(block, /const pricingDay = priceTz \? companyDayOf\(priceInstant \?\? priceNow, priceTz\) : priceNow\.toISOString\(\)\.slice\(0, 10\);/);
  assert.equal(block.split('tenantTz(').length - 1, 1, 'المنطقة مرّةً واحدة');
  // يوم الجهاز: للمندوب وحده بلا مفتاح، ولقائمةٍ بقاعدةٍ ذات فترة، ضمن ساعتين من لحظة التسعير (devicePricingDay)
  assert.match(block, /const rawMoment = priceTz && priceInstant \? rawDeviceMoment\(deviceAt, priceInstant\) : null;\s*const deviceDay = priceTz && req\.user!\.role === 'SALES_REP' && !req\.user\?\.apiKeyId\s*\? devicePricingDay\(body\.pricingDay, priceInstant \?\? priceNow, priceTz\)[\s\S]*?\?\? \(rawMoment \? devicePricingDay\(body\.pricingDay, rawMoment, priceTz\) : null\)\s*: null;/);
  // قواعد الجهاز: لإعادة الرفع بلحظة جهاز وحدها، بحدّ معرفته (لحظة الإصدار أو جلب الكاش قبلها)، وحين تخالف وحدها
  assert.match(block, /const knownRules = priceInstant\s*\? rowsKnownAt\(docRules, priceRulesKnownAt\(\{ priceInstant, pricesSeenAt: body\.pricesSeenAt, deviceNow: priceDeviceNow, now: priceNow \}\)\)\s*: docRules;/);
  assert.match(block, /knownRules\.length !== docRules\.length \? \[docRules, knownRules\] : \[docRules\]/);
  assert.equal(block.includes('invoiceDate'), false, 'تاريخ الجسم لا يحكم السعر');
  assert.equal(block.includes('phase2StartedAt'), false);
  // الحقلان تلميحان لا يرفضان: تالفٌ أو بغير نوعه يُهمل بصمت (catch)
  assert.match(src, /pricingDay: z\.string\(\)\.max\(40\)\.nullish\(\)\.catch\(undefined\),/);
  assert.match(src, /pricesSeenAt: z\.string\(\)\.max\(64\)\.nullish\(\)\.catch\(undefined\),/);
});

// ═══ CONTRACT2 D1 (بعد التحقّق): يوم تسعير الجهاز (body.pricingDay) ضمن ساعتين من لحظة التسعير بمنطقة الشركة ═══

/** لحظةٌ بتوقيت الرياض (+03:00 بلا توقيتٍ صيفي) */
const riyadh = (local: string): Date => new Date(`${local}:00+03:00`);

test('devicePricingDay: يوم الشركة قبل اللحظة بساعتين أو بعدها بساعتين وحده — ٢٣:٣٠ يقبل الغد و٠٠:٣٠ يقبل الأمس، وظهراً يوم الخادم وحده', () => {
  const TZ = 'Asia/Riyadh';
  assert.equal(PRICING_DAY_WINDOW_MS, 2 * 3_600_000);
  // ٢٣:٣٠ بتوقيت الشركة: الغد (سلّةٌ على جهازٍ متقدّم) مقبول، والأمس لا
  const lateNight = riyadh('2026-11-05T23:30');
  assert.equal(devicePricingDay('2026-11-06', lateNight, TZ), '2026-11-06');
  assert.equal(devicePricingDay('2026-11-05', lateNight, TZ), '2026-11-05');
  assert.equal(devicePricingDay('2026-11-04', lateNight, TZ), null, 'الأمس ليس ضمن ساعتين');
  // ٠٠:٣٠: الأمس (سلّةٌ سُعّرت قبل منتصف الليل) مقبول، والغد لا
  const pastMidnight = riyadh('2026-11-06T00:30');
  assert.equal(devicePricingDay('2026-11-05', pastMidnight, TZ), '2026-11-05');
  assert.equal(devicePricingDay('2026-11-06', pastMidnight, TZ), '2026-11-06');
  assert.equal(devicePricingDay('2026-11-07', pastMidnight, TZ), null);
  // الظهر: يوم الخادم وحده — تغيير تاريخ الجوال يوماً لا يبلغ عرض الأمس ولا الغد
  const noon = riyadh('2026-11-05T12:00');
  assert.equal(devicePricingDay('2026-11-05', noon, TZ), '2026-11-05');
  assert.equal(devicePricingDay('2026-11-04', noon, TZ), null, 'الأمس ظهراً');
  assert.equal(devicePricingDay('2026-11-06', noon, TZ), null, 'الغد ظهراً');
  // حدّا النافذة: ٢٢:٠٠ تماماً (+ساعتان = منتصف الليل) يقبل الغد، و٢١:٥٩ لا؛ و٠٢:٠٠ تماماً لا يقبل الأمس، و٠١:٥٩ يقبله
  assert.equal(devicePricingDay('2026-11-06', riyadh('2026-11-05T22:00'), TZ), '2026-11-06');
  assert.equal(devicePricingDay('2026-11-06', riyadh('2026-11-05T21:59'), TZ), null);
  assert.equal(devicePricingDay('2026-11-05', riyadh('2026-11-06T01:59'), TZ), '2026-11-05');
  assert.equal(devicePricingDay('2026-11-05', riyadh('2026-11-06T02:00'), TZ), null);
  // يومان فأكثر لا أبداً، ولو عند منتصف الليل
  assert.equal(devicePricingDay('2026-11-04', pastMidnight, TZ), null);
  assert.equal(devicePricingDay('2026-11-07', lateNight, TZ), null);
  // بمنطقة الشركة لا UTC: ٢٣:٣٠ بتوقيت نيويورك (EST) يوم ٥ = ٠٤:٣٠Z يوم ٦
  const ny = new Date('2026-11-06T04:30:00Z');
  assert.equal(devicePricingDay('2026-11-06', ny, 'America/New_York'), '2026-11-06');
  assert.equal(devicePricingDay('2026-11-04', ny, 'America/New_York'), null);
  // حدود الشهر والسنة والكبيسة
  assert.equal(devicePricingDay('2026-10-31', riyadh('2026-11-01T00:30'), TZ), '2026-10-31');
  assert.equal(devicePricingDay('2027-01-01', riyadh('2026-12-31T23:30'), TZ), '2027-01-01');
  assert.equal(devicePricingDay('2028-02-29', riyadh('2028-03-01T00:30'), TZ), '2028-02-29');
  assert.equal(devicePricingDay('2026-02-28', riyadh('2026-03-01T00:30'), TZ), '2026-02-28', 'سنة بسيطة');
  // تالفٌ أو بغير نوعه ⇒ null بصمت (ولو عند منتصف الليل)
  for (const sent of [undefined, null, '', 'غداً', '2026-11-5', '2026-13-01', '2026-11-31', 20261105, '2026-11-05T00:00:00Z', {}]) {
    assert.equal(devicePricingDay(sent, pastMidnight, TZ), null, JSON.stringify(sent));
  }
  assert.equal(devicePricingDay('2026-11-05', new Date('x'), TZ), null, 'لحظةٌ تالفة');
});

// ═══ التحقّق L2.2: حدّ ما عرفه الجهاز من القواعد — لحظة جلب الكاش (body.pricesSeenAt) ═══

test('priceRulesKnownAt: لحظة جلب الكاش قبل الإصدار (حتى ثلاثين يوماً) حدُّ المعرفة — وبعده أو أقدم أو تالفةٌ ⇒ لحظة الإصدار كما كان', () => {
  const sold = new Date('2026-11-04T08:00:00.000Z');
  const SYNC = new Date('2026-11-04T11:00:00.000Z');
  const known = (pricesSeenAt: unknown, deviceNow?: string | null) =>
    priceRulesKnownAt({ priceInstant: sold, pricesSeenAt, deviceNow, now: SYNC }).toISOString();
  // جلب ٠٥:٠٠ وباع ٠٨:٠٠ ⇒ ٠٥:٠٠
  assert.equal(known('2026-11-04T05:00:00.000Z'), '2026-11-04T05:00:00.000Z');
  assert.equal(known('2026-11-04T08:00:00+03:00'), '2026-11-04T05:00:00.000Z', 'بإزاحة');
  // اللحظة نفسها ⇒ هي (min)
  assert.equal(known(sold.toISOString()), sold.toISOString());
  // بعد الإصدار (ولو بملّي ثانية) ⇒ لحظة الإصدار
  assert.equal(known(new Date(sold.getTime() + 1).toISOString()), sold.toISOString());
  assert.equal(known('2026-11-04T10:00:00.000Z'), sold.toISOString());
  // ثلاثون يوماً قبل الإصدار مقبولة، وأقدم منها بملّي ثانية (مزوّرةٌ أو كاشٌ أقدم) تُهمل
  // (والحدّ أيضاً ثلاثون يوماً قبل ساعة الخادم — SYNC بعد الإصدار بثلاث ساعات فهو الأضيق هنا)
  const edge = new Date(SYNC.getTime() - PRICE_REPLAY_MAX_AGE_MS);
  assert.equal(known(edge.toISOString()), edge.toISOString());
  assert.equal(known(new Date(edge.getTime() - 1).toISOString()), sold.toISOString());
  assert.equal(known('2026-01-01T00:00:00.000Z'), sold.toISOString(), 'أقدم من ثلاثين يوماً');
  // تالفةٌ أو بغير نوعها أو بلا منطقة ⇒ لحظة الإصدار بصمت
  for (const v of [undefined, null, '', '   ', 'x', 'غداً', '2026-11-04', '2026-11-04T05:00:00', '-5', '1730000000000', 1_730_000_000_000, {}, []]) {
    assert.equal(known(v), sold.toISOString(), JSON.stringify(v));
  }
  // ساعة الجهاز متأخّرة ساعتين (X-FS-Device-Now): لحظة الجلب على ساعته تُصحَّح بالفرق نفسه كلحظة الإصدار
  const H2 = 2 * 3_600_000;
  assert.equal(known('2026-11-04T03:00:00.000Z', new Date(SYNC.getTime() - H2).toISOString()), '2026-11-04T05:00:00.000Z');
  // والمتقدّمة: جلبٌ «٠٩:٠٠» على ساعةٍ متقدّمة ساعتين = ٠٧:٠٠ حقيقةً قبل الإصدار ⇒ مقبول
  assert.equal(known('2026-11-04T09:00:00.000Z', String(SYNC.getTime() + H2)), '2026-11-04T07:00:00.000Z');
  // انحرافٌ ضمن التسامح: كما أُرسلت
  assert.equal(known('2026-11-04T05:00:00.000Z', new Date(SYNC.getTime() - 4 * 60_000).toISOString()), '2026-11-04T05:00:00.000Z');
});

test('deviceClockSkewMs: الفرق فوق خمس دقائق وحده، وبلا ترويسةٍ صالحة صفر — وهو تصحيح offlineInvoiceDate حرفياً', () => {
  const H2 = 2 * 3_600_000;
  assert.equal(deviceClockSkewMs(String(NOW.getTime() - H2), NOW), H2);
  assert.equal(deviceClockSkewMs(new Date(NOW.getTime() + H2).toISOString(), NOW), -H2);
  assert.equal(deviceClockSkewMs(String(NOW.getTime() - DEVICE_CLOCK_SKEW_TOLERANCE_MS), NOW), 0, 'الحدّ نفسه تسامح');
  assert.equal(deviceClockSkewMs(String(NOW.getTime() - DEVICE_CLOCK_SKEW_TOLERANCE_MS - 1), NOW), DEVICE_CLOCK_SKEW_TOLERANCE_MS + 1);
  for (const v of [undefined, null, '', 'x']) assert.equal(deviceClockSkewMs(v, NOW), 0, String(v));
});

// ═══ CONTRACT2 D3: قواعد القائمة كما عرفها الجهاز لحظة إصداره ═══

test('rowsKnownAt: ما كُتب عند لحظة الجهاز أو قبلها يبقى، وما بعدها يُسقَط — وصفٌّ بلا لحظةٍ صالحة يبقى', () => {
  const at = new Date('2026-11-03T19:00:00.000Z');
  const rows: { id: string; updatedAt?: string | number | Date | null }[] = [
    { id: 'old', updatedAt: new Date('2026-11-01T00:00:00.000Z') },
    { id: 'same', updatedAt: new Date(at.getTime()) },
    { id: 'after', updatedAt: new Date(at.getTime() + 1) },
    { id: 'iso-after', updatedAt: '2026-11-04T00:00:00.000Z' },
    { id: 'ms-old', updatedAt: at.getTime() - 1 },
    { id: 'none', updatedAt: null },
    { id: 'bad', updatedAt: 'x' },
    { id: 'absent' },
  ];
  assert.deepEqual(rowsKnownAt(rows, at).map((r) => r.id), ['old', 'same', 'ms-old', 'none', 'bad', 'absent']);
  assert.deepEqual(rowsKnownAt([], at), []);
});

test('priceRulesKnownAt: لحظة الجلب لا تُقبل أقدم من ثلاثين يوماً قبل ساعة الخادم أيضاً (لا قواعد قبل ستين يوماً بإعادة رفعٍ مصطنعة)', () => {
  const now = new Date('2026-11-30T12:00:00.000Z');
  const sold = new Date('2026-11-20T12:00:00.000Z'); // قبل عشرة أيام
  const seenOk = new Date(now.getTime() - PRICE_REPLAY_MAX_AGE_MS + 60_000); // داخل الثلاثين من الخادم
  const seenOld = new Date(now.getTime() - PRICE_REPLAY_MAX_AGE_MS - 60_000); // داخل ثلاثين من الإصدار لا من الخادم
  assert.equal(priceRulesKnownAt({ priceInstant: sold, pricesSeenAt: seenOk.toISOString(), now }).toISOString(), seenOk.toISOString());
  assert.equal(priceRulesKnownAt({ priceInstant: sold, pricesSeenAt: seenOld.toISOString(), now }).toISOString(), sold.toISOString());
});

test('rawDeviceMoment: لحظة الجهاز بلا تصحيح لإعادة الرفع — ضمن يومٍ من المصحَّحة، وإلا null', () => {
  const inst = new Date('2026-11-05T21:00:00.000Z');
  assert.equal(rawDeviceMoment('2026-11-05T18:00:00.000Z', inst)?.toISOString(), '2026-11-05T18:00:00.000Z');
  assert.equal(rawDeviceMoment('2026-11-03T18:00:00.000Z', inst), null, 'أبعد من يوم');
  assert.equal(rawDeviceMoment('x', inst), null);
  assert.equal(rawDeviceMoment(undefined, inst), null);
  assert.equal(rawDeviceMoment('2026-11-05T18:00:00.000Z', null), null);
  // جوالٌ ساعته متأخّرة ثلاث ساعات سعّر يوم ٥ نوفمبر قبيل منتصف ليله، والمصحَّحة بعد منتصف ليل الرياض: يومه يُقبل بلحظته الخام
  const tz = 'Asia/Riyadh';
  const corrected = new Date('2026-11-06T00:30:00.000Z'); // ٠٣:٣٠ الرياض يوم ٦ (ساعة الجهاز متأخّرة أربع ساعات)
  const raw = rawDeviceMoment('2026-11-05T20:30:00.000Z', corrected) as Date; // ٢٣:٣٠ الرياض يوم ٥ على ساعته
  assert.equal(devicePricingDay('2026-11-05', corrected, tz), null, 'بالمصحَّحة وحدها خارج النافذة');
  assert.equal(devicePricingDay('2026-11-05', raw, tz), '2026-11-05');
});
