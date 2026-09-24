// ZATCA المرحلة الثانية (Z5.7) — حرّاس تقنيع رمز رابط المشتري في سجلّ الطلبات (middleware/shareUrlPrivacy.ts).
// الخطر المحروس: الرمز هو الإذن كلّه وهو في المسار، وmorgan بصيغة combined يطبع :url و:referrer في كلّ سطر —
// فسطرُ سجلٍّ واحد يُعاد إرساله يسلّم الـXML الموقَّع. هنا: دالّة التقنيع، والوسيط، وسطر morgan **الحقيقيّ**،
// وموضع التركيب في index.ts، وتثبيت البادئتين على مصدرهما. بلا قاعدة بيانات ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import morgan from 'morgan';
import type { Request, Response, NextFunction } from 'express';
import { redactShareUrl, redactShareTokensInLogs, TOKEN_MASK } from '../middleware/shareUrlPrivacy';
import { makeShareToken, shareSecretFrom, shareUrlOf, SHARE_TOKEN_RE } from '../compliance/zatca/publicView';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const SECRET = shareSecretFrom('unit-test-secret-value');
const TOKEN = makeShareToken('1f2e3d4c-5b6a-4798-8899-aabbccddeeff', SECRET) as string;
const MAC = TOKEN.split('.')[1];

test('العيّنة رمزُ مشاركةٍ حقيقيّ الشكل (وإلا لم يكن الحارس يحرس شيئاً)', () => {
  assert.ok(SHARE_TOKEN_RE.test(TOKEN));
});

// ─── دالّة التقنيع ───

test('مسار الـAPI العلنيّ يخرج بلا رمز', () => {
  assert.equal(redactShareUrl(`/api/public/einvoice/${TOKEN}`), `/api/public/einvoice/${TOKEN_MASK}`);
});

test('لاحقة /xml والاستعلام تبقيان كما هما', () => {
  assert.equal(
    redactShareUrl(`/api/public/einvoice/${TOKEN}/xml?lang=ar`),
    `/api/public/einvoice/${TOKEN_MASK}/xml?lang=ar`,
  );
});

test('مسار صفحة الواجهة /e/:token يُقنَّع مثله', () => {
  assert.equal(redactShareUrl(`/e/${TOKEN}`), `/e/${TOKEN_MASK}`);
  assert.equal(redactShareUrl(`/e/${TOKEN}?l=en`), `/e/${TOKEN_MASK}?l=en`);
  assert.equal(redactShareUrl(`/e/${TOKEN}#x`), `/e/${TOKEN_MASK}#x`);
});

test('ترويسة Referer المطلقة تُقنَّع ويبقى أصلها', () => {
  assert.equal(
    redactShareUrl(shareUrlOf('https://fieldsa.net', TOKEN)),
    `https://fieldsa.net/e/${TOKEN_MASK}`,
  );
  assert.equal(redactShareUrl(`http://localhost:3000/e/${TOKEN}`), `http://localhost:3000/e/${TOKEN_MASK}`);
});

test('لا تبقى بصمة الرمز ولا شظيّةٌ منها في أيّ شكلٍ من أشكال الرابط', () => {
  const shapes = [
    `/e/${TOKEN}`,
    `/e/${TOKEN}?l=tr`,
    `/api/public/einvoice/${TOKEN}`,
    `/api/public/einvoice/${TOKEN}/xml`,
    shareUrlOf('https://fieldsa.net', TOKEN),
  ];
  for (const s of shapes) {
    const out = redactShareUrl(s) as string;
    assert.ok(typeof out === 'string', s);
    assert.ok(!out.includes(TOKEN), s);
    assert.ok(!out.includes(MAC), s);
    assert.ok(!out.includes(TOKEN.slice(0, 8)), s); // ولا بادئة المعرّف
  }
});

test('ما ليس مسار مشاركة لا يُمسّ (null بلا تخصيص)', () => {
  for (const s of [
    '/api/invoices/1f2e3d4c-5b6a-4798-8899-aabbccddeeff',
    '/api/public/catalog/abc',
    '/api/public/einvoice',
    '/api/public/einvoice/',
    '/e',
    '/e/',
    '/employees/list',
    '/export/e/x',
    'einvoice/x',
    'mailto:a@b.c',
    '',
  ]) assert.equal(redactShareUrl(s), null, s);
  assert.equal(redactShareUrl(undefined), null);
  assert.equal(redactShareUrl(null), null);
  assert.equal(redactShareUrl(42), null);
});

test('التقنيع عديم الأثر عند التكرار', () => {
  const once = redactShareUrl(`/e/${TOKEN}`) as string;
  assert.equal(redactShareUrl(once), null);
});

// ─── الوسيط ───

type FakeReq = {
  method: string; url: string; originalUrl: string; params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  httpVersionMajor: number; httpVersionMinor: number;
};

const fakeReq = (over: Partial<FakeReq> = {}): FakeReq => ({
  method: 'GET',
  url: `/einvoice/${TOKEN}`,
  originalUrl: `/api/public/einvoice/${TOKEN}`,
  params: { token: TOKEN },
  headers: { referer: shareUrlOf('https://fieldsa.net', TOKEN), 'user-agent': 'x' },
  httpVersionMajor: 1,
  httpVersionMinor: 1,
  ...over,
});

const run = (req: FakeReq): number => {
  let calls = 0;
  redactShareTokensInLogs(req as unknown as Request, {} as Response, (() => { calls += 1; }) as NextFunction);
  return calls;
};

test('الوسيط يقنّع originalUrl وReferer ولا يمسّ url ولا params', () => {
  const req = fakeReq();
  assert.equal(run(req), 1);
  assert.equal(req.originalUrl, `/api/public/einvoice/${TOKEN_MASK}`);
  assert.equal(req.headers.referer, `https://fieldsa.net/e/${TOKEN_MASK}`);
  // التوجيه يرى الرمز الحقيقيّ كما جاء — وإلا لانكسر الرابط نفسه
  assert.equal(req.url, `/einvoice/${TOKEN}`);
  assert.equal(req.params.token, TOKEN);
});

test('الوسيط يعالج نسخ الترويسة المتعدّدة وصيغة referrer', () => {
  const req = fakeReq({ headers: { referrer: [`/e/${TOKEN}`, '/pricing'] } });
  run(req);
  assert.deepEqual(req.headers.referrer, [`/e/${TOKEN_MASK}`, '/pricing']);
});

test('طلبٌ عاديّ يمرّ كما هو', () => {
  const req = fakeReq({ url: '/', originalUrl: '/api/invoices', headers: { referer: 'https://fieldsa.net/invoices' }, params: {} });
  assert.equal(run(req), 1);
  assert.equal(req.originalUrl, '/api/invoices');
  assert.equal(req.headers.referer, 'https://fieldsa.net/invoices');
});

// ─── سطر morgan الحقيقيّ ───

const fakeRes = () => ({
  statusCode: 200,
  headersSent: true,
  finished: true,
  _startAt: process.hrtime(),
  getHeader: (n: string) => (n.toLowerCase() === 'content-length' ? '12' : undefined),
});

/** سطر السجلّ كما يكتبه morgan فعلاً: نصيغه بصيغته المسجَّلة ودوالّ رموزه نفسها. */
const morganLine = (fmt: 'combined' | 'dev', req: FakeReq): string => {
  const m = morgan as unknown as Record<string, unknown> & { compile: (f: string) => (t: unknown, q: unknown, s: unknown) => string };
  const f = m[fmt];
  const fn = typeof f === 'function' ? (f as (t: unknown, q: unknown, s: unknown) => string) : m.compile(f as string);
  const r = { ...req, _startAt: process.hrtime() };
  return String(fn(m, r, fakeRes()) ?? '');
};

for (const fmt of ['combined', 'dev'] as const) {
  test(`سطر morgan بصيغة ${fmt} لا يحمل الرمز بعد الوسيط`, () => {
    const req = fakeReq();
    const before = morganLine(fmt, req);
    assert.ok(before.includes(TOKEN), 'العيّنة يجب أن تُظهر التسريب قبل العلاج');
    run(req);
    const after = morganLine(fmt, req);
    assert.ok(!after.includes(TOKEN), after);
    assert.ok(!after.includes(MAC), after);
    assert.ok(after.includes(TOKEN_MASK), after);
  });
}

// ─── موضع التركيب وتثبيت البادئتين ───

test('الوسيط مركَّب مباشرةً بعد morgan وقبل كلّ موجّه وقبل الملفّات الساكنة', () => {
  const s = read('index.ts');
  const iMorgan = s.indexOf('app.use(morgan(');
  const iRedact = s.indexOf('app.use(redactShareTokensInLogs)');
  assert.ok(iMorgan > 0 && iRedact > iMorgan, 'التركيب مفقود أو قبل morgan');
  // لا تركيب آخر بينهما: أيّ موجّهٍ يُدسّ هنا يسجّل رمزه خاماً
  assert.ok(!s.slice(iMorgan + 1, iRedact).includes('app.use('), 'دخل تركيبٌ بين morgan والتقنيع');
  for (const needle of ["app.use('/api/public', publicEinvoiceRouter)", 'express.static(webDist)', "app.use('/api'"]) {
    const i = s.indexOf(needle, iMorgan);
    assert.ok(i > iRedact, `${needle} يجب أن يأتي بعد التقنيع`);
  }
  assert.ok(s.includes("from './middleware/shareUrlPrivacy'"));
});

test('البادئتان مثبّتتان على مصدرهما: مسار الموجّه العلنيّ ورابط الصفحة', () => {
  const idx = read('index.ts');
  const route = read('routes/publicEinvoice.ts');
  assert.ok(idx.includes("app.use('/api/public', publicEinvoiceRouter)"));
  assert.ok(route.includes("router.get('/einvoice/:token'"));
  assert.ok(route.includes("router.get('/einvoice/:token/xml'"));
  // المسار المركَّب فعلاً = '/api/public' + '/einvoice/:token' — والتقنيع يلتقطه
  assert.notEqual(redactShareUrl(`/api/public/einvoice/${TOKEN}`), null);
  // ورابط الصفحة كما تصدره الواجهة
  assert.equal(shareUrlOf('https://fieldsa.net', TOKEN), `https://fieldsa.net/e/${TOKEN}`);
  assert.notEqual(redactShareUrl(shareUrlOf('https://fieldsa.net', TOKEN)), null);
});
