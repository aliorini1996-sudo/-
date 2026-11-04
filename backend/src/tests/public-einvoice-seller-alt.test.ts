// رابط المشتري العلنيّ (`/api/public/einvoice/:token`) — اسم الشركة وعنوانها باللغة الثانية (قرار المالك ٤ نوفمبر ٢٠٢٦).
//
// الصفحة العلنية تعرض من «نصوص المطبوعات» شيئين فقط: companyNameAlt وcompanyAddressAlt، محلولين في الخادم ومُرسلين تحت
// البائع (`seller.nameAlt` / `seller.addressAlt`). ما يُحرس هنا:
//   ١) بلا إعداد (null) أو بلا لغةٍ ثانية أو بنصٍّ فارغ ⇒ الردّ كما كان حرفاً بحرف (لا مفتاح جديد).
//   ٢) لا يخرج JSON الخام: لا secondLang ولا edits ولا نصّ عبارةٍ معدّلة ولا version.
//   ٣) النصّ سطرٌ واحد بلا محارف اتجاه، مقصوصٌ لحدّه (80 / 160 محرفاً).
//   ٤) قيمةٌ مخزّنة لا تصلح ⇒ لا مفتاح ولا 500.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

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
stub('config/database', { default: new Proxy({}, { get: (_t, key: string) => (key === 'then' ? undefined : modelProxy(key)) }) });

process.env.JWT_SECRET = 'test-secret-for-share-tokens';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require(path.join(SRC, 'routes/publicEinvoice')) as typeof import('../routes/publicEinvoice');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const view = require(path.join(SRC, 'compliance/zatca/publicView')) as typeof import('../compliance/zatca/publicView');

const app = express();
app.set('trust proxy', 1);
app.use('/api/public', mod.default);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ success: false, message: err?.message ?? 'خطأ' });
});
const server = http.createServer(app).listen(0);
after(() => { server.close(); });

let ipSeq = 0;
async function get(): Promise<{ status: number; text: string; data: Record<string, unknown> }> {
  const port = (server.address() as AddressInfo).port;
  const r = await fetch(`http://127.0.0.1:${port}/api/public/einvoice/${TOKEN}`, { headers: { 'x-forwarded-for': `10.7.0.${++ipSeq}` } });
  const text = await r.text();
  const body = JSON.parse(text) as { data?: Record<string, unknown> };
  return { status: r.status, text, data: body.data ?? {} };
}

const DOC_ID = 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff';
const TOKEN = view.makeShareToken(DOC_ID, view.shareSecretFrom(process.env.JWT_SECRET)) as string;

const texts = (over: Record<string, unknown> = {}) => ({
  version: 1, secondLang: 'en', companyNameAlt: 'Seller Trading Co.', companyAddressAlt: 'King Fahd Rd, Riyadh',
  edits: { invoiceTitle: { text: 'عنوانٌ معدّل سرّي', alt: 'EDITED-ALT-SECRET', hidden: false } },
  ...over,
});

/** مستندٌ مبلَّغ لشركةٍ مفعَّلة، وعمود printTexts كما يُعطى. */
function scene(printTexts: unknown): void {
  calls = [];
  scripted = {
    'zatcaDocument.findUnique': () => ({
      id: DOC_ID, tenantId: 'tenant-1', uuid: 'doc-uuid-1', status: 'REPORTED', typeName: '0200000', flow: 'REPORTING',
      issueDate: '2026-09-20', issueTime: '12:30:00', qr: 'QR-STAMPED-BASE64', clearedQr: null,
      invoice: {
        number: 'INV-001', documentKind: 'INVOICE', currency: 'SAR', subtotal: 100, discountAmt: 0, taxAmt: 15,
        total: 115, einvoiceStatus: 'reported', zatcaPhase: 2, customer: { name: 'مؤسسة المشتري' },
      },
    }),
    'companySettings.findUnique': () => ({
      name: 'شركة البائع', legalName: 'شركة البائع التجارية', taxNumber: '310000000000003',
      zatcaPhase2StartedAt: new Date('2026-01-01T00:00:00.000Z'), printTexts,
    }),
  };
}

const BASE_SELLER = { name: 'شركة البائع التجارية', vatNumber: '310000000000003' };

test('بلا إعداد أو بلا لغةٍ ثانية أو بنصٍّ فارغ ⇒ البائع كما كان (لا مفتاح جديد)', async () => {
  scene(null);
  const before = await get();
  assert.equal(before.status, 200);
  assert.deepEqual(before.data.seller, BASE_SELLER);
  for (const pt of [
    undefined,
    texts({ secondLang: null }),
    texts({ companyNameAlt: null, companyAddressAlt: null }),
    texts({ companyNameAlt: '   ', companyAddressAlt: '\n\t' }),
    { version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null, edits: {} },
  ]) {
    scene(pt);
    const r = await get();
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.seller, BASE_SELLER, JSON.stringify(pt));
    // الحمولة كلّها بايتاً ببايت كحال «لا إعداد»
    assert.equal(r.text, before.text, `تغيّر الردّ بلا نصّ ثانٍ: ${JSON.stringify(pt)}`);
  }
});

test('لغةٌ ثانية ونصّان ⇒ seller.nameAlt وseller.addressAlt وحدهما، ولا شيء آخر من الإعداد', async () => {
  scene(texts());
  const r = await get();
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.seller, { ...BASE_SELLER, nameAlt: 'Seller Trading Co.', addressAlt: 'King Fahd Rd, Riyadh' });
  assert.deepEqual(Object.keys(r.data).sort(), ['buyer', 'document', 'qr', 'seller', 'xml']);
  for (const leak of ['secondLang', 'edits', 'EDITED-ALT-SECRET', 'عنوانٌ معدّل سرّي', 'invoiceTitle', 'printTexts', '"version"', 'tenant-1']) {
    assert.equal(r.text.includes(leak), false, `تسرّب من الإعداد: ${leak}`);
  }
  assert.deepEqual(calls.map(c => c.key), ['zatcaDocument.findUnique', 'companySettings.findUnique'], 'استعلاماتٌ زائدة');
  const sel = calls[1].args.select as Record<string, unknown>;
  assert.equal(sel.printTexts, true);
});

test('أحد النصّين وحده ⇒ مفتاحه وحده', async () => {
  scene(texts({ companyAddressAlt: null }));
  assert.deepEqual((await get()).data.seller, { ...BASE_SELLER, nameAlt: 'Seller Trading Co.' });
  scene(texts({ companyNameAlt: '' }));
  assert.deepEqual((await get()).data.seller, { ...BASE_SELLER, addressAlt: 'King Fahd Rd, Riyadh' });
});

test('النصّ سطرٌ واحد بلا محارف اتجاه، مقصوصٌ لحدّه بالمحارف لا بالوحدات', async () => {
  scene(texts({ companyNameAlt: '  Seller\n\tCo.‮  ', companyAddressAlt: `${'汉'.repeat(200)}` }));
  const s = (await get()).data.seller as Record<string, string>;
  assert.equal(s.nameAlt, 'Seller Co.');
  assert.equal(Array.from(s.addressAlt).length, 160);
  assert.equal(s.addressAlt, '汉'.repeat(160));
  // حدّ الاسم ٨٠
  assert.equal(Array.from(mod.sellerAltOf(texts({ companyNameAlt: 'N'.repeat(300) })).nameAlt as string).length, 80);
});

test('قيمةٌ مخزّنة لا تصلح ⇒ لا مفتاح ولا خطأ', async () => {
  for (const bad of ['نص', 42, [], { version: 2, secondLang: 'en', companyNameAlt: 'X', companyAddressAlt: 'Y', edits: {} },
    { version: 1, secondLang: 'de', companyNameAlt: 'X', companyAddressAlt: 'Y', edits: {} },
    { version: 1, secondLang: 'en', companyNameAlt: 7, companyAddressAlt: 'Y', edits: {} }]) {
    scene(bad);
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(bad));
    assert.deepEqual(r.data.seller, BASE_SELLER, JSON.stringify(bad));
  }
});

test('sellerAltOf: يعيد نصّين محلولين فقط — لا مفاتيح أخرى أبداً', () => {
  assert.deepEqual(mod.sellerAltOf(null), {});
  assert.deepEqual(mod.sellerAltOf(undefined), {});
  assert.deepEqual(Object.keys(mod.sellerAltOf(texts())).sort(), ['addressAlt', 'nameAlt']);
  for (const lang of ['en', 'fr', 'tr', 'zh']) {
    assert.deepEqual(mod.sellerAltOf(texts({ secondLang: lang })), { nameAlt: 'Seller Trading Co.', addressAlt: 'King Fahd Rd, Riyadh' });
  }
});
