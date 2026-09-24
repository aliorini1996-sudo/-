// ZATCA المرحلة الثانية (Z5.7) — اختبارات رابط المشتري العلنيّ عبر الموجّه الحقيقيّ.
//
// لا قاعدة بيانات ولا شبكة: عميل Prisma مزيّف يُحقن في require.cache قبل تحميل الموجّه. وما يُختبر هنا ليس
// «هل يعمل» بل «ماذا يمنع»:
//   ١) **الرمز**: يُشتقّ ويُتحقّق بالسرّ نفسه؛ حرفٌ واحد مبدَّل أو سرٌّ آخر أو صيغةٌ مشوّهة ⇒ لا استعلام أصلاً.
//   ٢) **النهائيّ وحده**: كلّ حالةٍ من حالات المستند الاثنتي عشرة تُجرَّب — أربعٌ تُفتح، وثمانٍ تردّ 404 بالنصّ نفسه.
//   ٣) **لا تسريب**: الردّ يُفحص بالنصّ الخام على معرّفات الشركة والعميل والوحدة وبايتات XML ورسائل الهيئة.
//   ٤) **حدّ المعدّل**: الطلب الحادي والستّون من نفس العنوان يُردّ 429.
//   ٥) **الـXML**: البايتات المخزّنة تُفكّ وتُرسل باسمٍ وترويسات صحيحة، ولا وسيط `variant` يفتح نسخةً أخرى.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import express from 'express';

// ═══ حقن بديل القاعدة قبل تحميل الموجّه ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

interface Call { key: string; args: Record<string, unknown> }
let calls: Call[] = [];
let scripted: Record<string, (args: Record<string, unknown>) => unknown> = {};

const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (args: Record<string, unknown>) => {
    const key = `${model}.${method}`;
    calls.push({ key, args: args ?? {} });
    const fn = scripted[key];
    return fn ? fn(args ?? {}) : (method === 'findMany' ? [] : null);
  },
});

const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => (key === 'then' ? undefined : modelProxy(key)),
});
stub('config/database', { default: prismaFake });

process.env.JWT_SECRET = 'test-secret-for-share-tokens';
process.env.PUBLIC_SITE_URL = 'https://fieldsa.net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = (require(path.join(SRC, 'routes/publicEinvoice')) as { default: express.Router }).default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const view = require(path.join(SRC, 'compliance/zatca/publicView')) as typeof import('../compliance/zatca/publicView');

// ═══ الخادم ═══

const app = express();
// الاعتماد على وسيطٍ واحد: يجعل req.ip آخر قيمة في X-Forwarded-For، فلكلّ اختبارٍ دلوُ معدّلٍ خاصّ به
app.set('trust proxy', 1);
app.use('/api/public', router);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ success: false, message: err?.message ?? 'خطأ' });
});

const server = http.createServer(app).listen(0);
const base = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); });

let ipSeq = 0;
const nextIp = (): string => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

interface Reply { status: number; body: Record<string, unknown>; text: string; headers: Headers }

async function call(url: string, ip: string = nextIp()): Promise<Reply> {
  const r = await fetch(`${base()}${url}`, { headers: { 'x-forwarded-for': ip } });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* نصّ XML */ }
  return { status: r.status, body: parsed, text, headers: r.headers };
}

const reset = (): void => { calls = []; scripted = {}; };
const keys = (): string[] => calls.map(c => c.key);
const data = (r: Reply): Record<string, unknown> => r.body.data as Record<string, unknown>;

// ═══ معطيات ثابتة ═══

const DOC_ID = 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff';
const SECRET = view.shareSecretFrom(process.env.JWT_SECRET);
const TOKEN = view.makeShareToken(DOC_ID, SECRET) as string;
const XML = '<?xml version="1.0" encoding="UTF-8"?><Invoice><ID>INV-001</ID></Invoice>';

const docRow = (over: Record<string, unknown> = {}) => ({
  id: DOC_ID, tenantId: 'tenant-1', uuid: 'doc-uuid-1', status: 'REPORTED', typeName: '0200000', flow: 'REPORTING',
  issueDate: '2026-09-20', issueTime: '12:30:00', qr: 'QR-STAMPED-BASE64', clearedQr: null,
  invoice: {
    number: 'INV-001', documentKind: 'INVOICE', currency: 'SAR', subtotal: 100, discountAmt: 0, taxAmt: 15,
    total: 115, einvoiceStatus: 'reported', zatcaPhase: 2, customer: { name: 'مؤسسة المشتري' },
  },
  ...over,
});

/** الحال السعيدة: مستندٌ مبلَّغ لشركةٍ مفعَّلة، وبايتاته مخزّنة. */
const happy = (docOver: Record<string, unknown> = {}): void => {
  scripted['zatcaDocument.findUnique'] = (args) => {
    const sel = (args.select ?? {}) as Record<string, unknown>;
    if (sel.xmlGz === true) return { xmlGz: zlib.gzipSync(Buffer.from(XML, 'utf8')) };
    if (sel.clearedXmlGz === true) return { clearedXmlGz: zlib.gzipSync(Buffer.from(`${XML}<!--cleared-->`, 'utf8')) };
    return docRow(docOver);
  };
  scripted['companySettings.findUnique'] = () => ({
    name: 'شركة البائع', legalName: 'شركة البائع التجارية', taxNumber: '310000000000003',
    zatcaPhase2StartedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
};

// ═══ ١) الرمز ═══

test('الرمز: يُشتقّ ويُقرأ بالسرّ نفسه، وثابتٌ لنفس المستند', () => {
  assert.match(TOKEN, view.SHARE_TOKEN_RE);
  assert.equal(view.makeShareToken(DOC_ID, SECRET), TOKEN, 'الاشتقاق غير ثابت — رابطٌ جديد لكلّ فتحة شاشة');
  assert.equal(view.readShareToken(TOKEN, SECRET), DOC_ID);
  assert.equal(TOKEN.includes(DOC_ID), false, 'المعرّف الخام ظاهرٌ بشرطاته في الرمز');
});

test('الرمز: سرٌّ آخر أو بصمةٌ مبدَّلة أو معرّفٌ مبدَّل ⇒ null', () => {
  const other = view.shareSecretFrom('another-server-secret');
  assert.equal(view.readShareToken(TOKEN, other), null, 'رمزٌ من خادمٍ آخر قُبل');
  assert.notEqual(view.makeShareToken(DOC_ID, other), TOKEN);

  const [flat, mac] = TOKEN.split('.');
  const flipped = `${flat}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  assert.equal(view.readShareToken(flipped, SECRET), null, 'بصمةٌ مبدَّلة قُبلت');
  const otherId = `${flat.slice(0, 31)}${flat[31] === '0' ? '1' : '0'}.${mac}`;
  assert.equal(view.readShareToken(otherId, SECRET), null, 'معرّفٌ آخر ببصمةٍ مستعارة قُبل');
});

test('الرمز: صيغٌ مشوّهة وسرٌّ غائب ⇒ null بلا استثناء', () => {
  for (const bad of ['', 'x', TOKEN.slice(0, -1), `${TOKEN}A`, TOKEN.replace('.', '-'), TOKEN.toUpperCase(), null, 42, {}]) {
    assert.equal(view.readShareToken(bad as unknown, SECRET), null, `قُبل: ${String(bad)}`);
  }
  assert.equal(view.readShareToken(TOKEN, null), null, 'بلا سرّ خادم يجب أن يُغلق الباب');
  assert.equal(view.makeShareToken(DOC_ID, null), null);
  assert.equal(view.makeShareToken('not-a-uuid', SECRET), null);
  assert.equal(view.shareSecretFrom(''), null);
  assert.equal(view.shareSecretFrom(undefined), null);
});

test('الرمز: الرابط يُبنى على /e/:token بلا شرطةٍ مكرّرة', () => {
  assert.equal(view.shareUrlOf('https://fieldsa.net/', TOKEN), `https://fieldsa.net/e/${TOKEN}`);
  assert.equal(view.shareUrlOf('https://fieldsa.net', TOKEN), `https://fieldsa.net/e/${TOKEN}`);
});

// ═══ ٢) الرمز الخاطئ لا يلمس القاعدة ═══

test('رمزٌ مجهول أو مشوّه ⇒ 404 بلا استعلامٍ واحد', async () => {
  for (const bad of ['abc', `${'0'.repeat(32)}.${'A'.repeat(27)}`, TOKEN.slice(0, -2)]) {
    reset(); happy();
    const r = await call(`/api/public/einvoice/${bad}`);
    assert.equal(r.status, 404, bad);
    assert.equal(r.body.message, 'الرابط غير صحيح أو لم يعد متاحاً');
    assert.deepEqual(keys(), [], `استعلامٌ نُفِّذ لرمزٍ لا يطابق: ${keys().join(', ')}`);
  }
});

test('رمزٌ صحيح التوقيع لمستندٍ غير موجود ⇒ 404 بعد استعلامٍ واحد ولا قراءة إعدادات', async () => {
  reset();
  scripted['zatcaDocument.findUnique'] = () => null;
  const r = await call(`/api/public/einvoice/${TOKEN}`);
  assert.equal(r.status, 404);
  assert.deepEqual(keys(), ['zatcaDocument.findUnique']);
});

// ═══ ٣) النهائيّ وحده ═══

const NON_FINAL = [
  ['SIGNED', 'signed'], ['SUBMITTING', 'signed'], ['RETRY_WAIT', 'signed'], ['AUTH_BLOCKED', 'report_blocked'],
  ['CONFIG_ERROR', 'report_blocked'], ['CLEARED_NO_XML', 'cleared_no_xml'], ['REJECTED', 'rejected'],
  ['WITHDRAWN', 'withdrawn'],
] as const;

test('حالةٌ غير نهائية أو مُبطلة ⇒ 404 ولا قراءة إعدادات الشركة', async () => {
  for (const [status, mirror] of NON_FINAL) {
    reset();
    const typeName = mirror.startsWith('clear') ? '0100000' : '0200000';
    happy({ status, typeName, invoice: { ...docRow().invoice, einvoiceStatus: mirror } });
    const r = await call(`/api/public/einvoice/${TOKEN}`);
    assert.equal(r.status, 404, `${status} فُتحت للمشتري`);
    assert.deepEqual(keys(), ['zatcaDocument.findUnique'], `${status}: قُرئت إعدادات الشركة بعد سقوط البوابة`);
  }
});

test('المرحلة الأولى (zatcaPhase ≠ 2) أو typeName مشوّه ⇒ 404', async () => {
  for (const over of [
    { invoice: { ...docRow().invoice, zatcaPhase: 1 } },
    { invoice: { ...docRow().invoice, zatcaPhase: null } },
    { typeName: 'XXXXXXX' },
    { typeName: '0300000' },
  ]) {
    reset(); happy(over);
    const r = await call(`/api/public/einvoice/${TOKEN}`);
    assert.equal(r.status, 404, JSON.stringify(over));
  }
});

test('شركةٌ أُطفئت مرحلتها الثانية ⇒ 404 ولو كان المستند نهائياً', async () => {
  reset(); happy();
  scripted['companySettings.findUnique'] = () => ({ name: 'ش', legalName: null, taxNumber: null, zatcaPhase2StartedAt: null });
  const r = await call(`/api/public/einvoice/${TOKEN}`);
  assert.equal(r.status, 404);
});

test('الحالات الأربع النهائية وحدها تُفتح — ومعها نسخة XML الصحيحة', async () => {
  const cases = [
    { status: 'REPORTED', typeName: '0200000', mirror: 'reported', variant: 'signed' },
    { status: 'REPORTED_WARN', typeName: '0200000', mirror: 'reported_warn', variant: 'signed' },
    { status: 'CLEARED', typeName: '0100000', mirror: 'cleared', variant: 'cleared' },
    { status: 'CLEARED_WARN', typeName: '0100000', mirror: 'cleared_warn', variant: 'cleared' },
  ] as const;
  for (const c of cases) {
    reset();
    happy({
      status: c.status, typeName: c.typeName, flow: c.typeName === '0100000' ? 'CLEARANCE' : 'REPORTING',
      clearedQr: c.variant === 'cleared' ? 'QR-CLEARED' : null,
      invoice: { ...docRow().invoice, einvoiceStatus: c.mirror },
    });
    const r = await call(`/api/public/einvoice/${TOKEN}`);
    assert.equal(r.status, 200, c.status);
    const doc = data(r).document as Record<string, unknown>;
    assert.equal(doc.status, c.mirror);
    assert.equal(doc.subtype, c.typeName.slice(0, 2));
    assert.deepEqual(data(r).xml, { available: true, variant: c.variant });
    // الرمز المختوم: المعتمد للقياسية المعتمدة، وختمُنا للمبسّطة — قاعدة mirrorQrOf نفسها
    assert.equal(data(r).qr, c.variant === 'cleared' ? 'QR-CLEARED' : 'QR-STAMPED-BASE64');
  }
});

// ═══ ٤) الإسقاط: ما يخرج وما لا يخرج ═══

test('الحمولة العلنية: البائع والمشتري والمبالغ والحالة والرمز وحدها', async () => {
  reset(); happy();
  const r = await call(`/api/public/einvoice/${TOKEN}`);
  assert.equal(r.status, 200);
  const d = data(r);
  assert.deepEqual(d.seller, { name: 'شركة البائع التجارية', vatNumber: '310000000000003' });
  assert.deepEqual(d.buyer, { name: 'مؤسسة المشتري' });
  assert.deepEqual(d.document, {
    kind: 'INVOICE', subtype: '02', number: 'INV-001', uuid: 'doc-uuid-1', issueDate: '2026-09-20',
    issueTime: '12:30:00', currency: 'SAR', subtotal: 100, discount: 0, tax: 15, total: 115,
    status: 'reported', flow: 'REPORTING',
  });
  assert.deepEqual(Object.keys(d).sort(), ['buyer', 'document', 'qr', 'seller', 'xml']);
  assert.deepEqual(keys(), ['zatcaDocument.findUnique', 'companySettings.findUnique'], 'استعلاماتٌ زائدة');
});

test('لا يتسرّب معرّف شركة ولا عميل ولا وحدة ولا بايتات ولا رسائل الهيئة', async () => {
  reset();
  happy({
    tenantId: 'tenant-SECRET-1',
    invoice: { ...docRow().invoice, einvoiceStatus: 'reported' },
  });
  // صفٌّ يحمل حقولاً حسّاسة لو أفلتت القائمة البيضاء
  scripted['zatcaDocument.findUnique'] = (args) => {
    const sel = (args.select ?? {}) as Record<string, unknown>;
    if (sel.xmlGz === true) return { xmlGz: zlib.gzipSync(Buffer.from(XML, 'utf8')) };
    return {
      ...docRow(), tenantId: 'tenant-SECRET-1', egsUnitId: 'egs-SECRET-1', invoiceHash: 'HASH-SECRET',
      pih: 'PIH-SECRET', validation: { errors: [{ message: 'رسالة هيئة داخلية' }] },
      xmlGz: Buffer.from('BYTES-SECRET'), invoice: { ...docRow().invoice, customerId: 'cust-SECRET-1' },
    };
  };
  const r = await call(`/api/public/einvoice/${TOKEN}`);
  assert.equal(r.status, 200);
  for (const leak of ['tenant-SECRET-1', 'egs-SECRET-1', 'HASH-SECRET', 'PIH-SECRET', 'cust-SECRET-1', 'BYTES-SECRET', 'رسالة هيئة داخلية']) {
    assert.equal(r.text.includes(leak), false, `تسرّب في الحمولة: ${leak}`);
  }
});

test('الحمولة العلنية ترفض الفهرسة والتخزين الوسيط', async () => {
  reset(); happy();
  const r = await call(`/api/public/einvoice/${TOKEN}`);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(String(r.headers.get('x-robots-tag')), /noindex/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

// ═══ ٥) الـXML ═══

test('الـXML: البايتات المخزّنة تُفكّ وتُرسل باسمٍ وترويسات صحيحة', async () => {
  reset(); happy();
  const r = await call(`/api/public/einvoice/${TOKEN}/xml`);
  assert.equal(r.status, 200);
  assert.equal(r.text, XML);
  assert.match(String(r.headers.get('content-type')), /application\/xml/);
  assert.match(String(r.headers.get('content-disposition')), /attachment; filename="INV-001-signed\.xml"/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('الـXML: القياسية المعتمدة تُسلّم نسخة الهيئة لا نسختنا، ولا وسيط variant يغيّرها', async () => {
  reset();
  happy({ status: 'CLEARED', typeName: '0100000', flow: 'CLEARANCE', clearedQr: 'QR-CLEARED', invoice: { ...docRow().invoice, einvoiceStatus: 'cleared' } });
  const r = await call(`/api/public/einvoice/${TOKEN}/xml?variant=signed`);
  assert.equal(r.status, 200);
  assert.match(r.text, /cleared/, 'سُلّمت النسخة الموقّعة لمستندٍ معتمد');
  assert.match(String(r.headers.get('content-disposition')), /-cleared\.xml/);
});

test('الـXML: نسخةٌ غير مخزّنة ⇒ 404 لا ملفٌّ فارغ', async () => {
  reset(); happy();
  scripted['zatcaDocument.findUnique'] = (args) => {
    const sel = (args.select ?? {}) as Record<string, unknown>;
    if (sel.xmlGz === true || sel.clearedXmlGz === true) return { xmlGz: null, clearedXmlGz: null };
    return docRow();
  };
  const r = await call(`/api/public/einvoice/${TOKEN}/xml`);
  assert.equal(r.status, 404);
  assert.equal(r.body.message, 'الرابط غير صحيح أو لم يعد متاحاً');
});

test('الـXML: مستندٌ غير نهائيّ ⇒ 404 ولا قراءةَ بايتات', async () => {
  reset();
  happy({ status: 'RETRY_WAIT', invoice: { ...docRow().invoice, einvoiceStatus: 'signed' } });
  const r = await call(`/api/public/einvoice/${TOKEN}/xml`);
  assert.equal(r.status, 404);
  assert.deepEqual(keys(), ['zatcaDocument.findUnique']);
});

test('الـXML: بايتاتٌ معطوبة ⇒ 500 لا نصٌّ مشوّه', async () => {
  reset(); happy();
  scripted['zatcaDocument.findUnique'] = (args) => {
    const sel = (args.select ?? {}) as Record<string, unknown>;
    if (sel.xmlGz === true) return { xmlGz: Buffer.from([1, 2, 3, 4]) };
    return docRow();
  };
  const r = await call(`/api/public/einvoice/${TOKEN}/xml`);
  assert.equal(r.status, 500);
});

// ═══ ٦) حدّ المعدّل (آخر اختبار: يستهلك دلو عنوانه) ═══

test('حدّ المعدّل: الطلب الحادي والستّون من نفس العنوان يُردّ 429', async () => {
  reset(); happy();
  const ip = '10.200.0.7';
  for (let i = 0; i < 60; i++) {
    const ok = await call(`/api/public/einvoice/${TOKEN}`, ip);
    assert.equal(ok.status, 200, `الطلب ${i + 1} رُدّ ${ok.status}`);
  }
  const over = await call(`/api/public/einvoice/${TOKEN}`, ip);
  assert.equal(over.status, 429);
  // دلوٌ لكلّ عنوان: مشترٍ آخر لا يُخنق بفعل غيره
  const other = await call(`/api/public/einvoice/${TOKEN}`, '10.200.0.8');
  assert.equal(other.status, 200);
});
