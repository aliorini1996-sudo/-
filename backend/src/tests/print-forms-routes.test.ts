// «النموذج المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — صورة نموذج الشركة الفارغ: routes/printForms.ts فوق Prisma مزيّف في
// الذاكرة (المعالجات الحقيقية بحرّاسها وقارئ الجسم الخام الحقيقي express.raw على مجرى طلبٍ حقيقي)، وservices/printForms.ts
// الصرفة، ثم حرّاس نصّية على التركيب والمخطط. ما يُحرس: النوع من البايتات لا من الترويسة (وPDF مرفوض برسالته)، والحجم 1.5
// ميغابايت (413 برمزه لا 500)، والأبعاد 200..10000، وسقف ٨ صور بقفلٍ استشاري لكل شركة، والصورة نفسها مرتين صفٌّ واحد، ومفتاح
// API مرفوض للرفع والحذف، والقراءة لكل مسجّل في الشركة نفسها (والمندوب) بتخزينٍ طويل وETag و304 بلا قراءة البايتات، وعزل الشركات،
// والحذف 409 ما دام قالبٌ يشير إليها. لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { PRINT_FORM_CAPS, PRINT_FORM_MESSAGES, etagMatches, formImageRefMatches, formImageRefsOf, formImageVersion, isFormImageId } from '../services/printForms';
import { gifBytes, jpegBytes, pdfBytes, pngBytes, webpVp8Bytes } from './image-fixtures';

const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const T = 'T1';
const OTHER = 'T2';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

// ═══ الصرفة: مراجع الصور في إعدادات الطباعة ═══

const ID1 = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const ID2 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const withForm = (image: unknown) => ({ id: 'murouj', options: { layout: { design: 'preprinted', form: { image } } } });

test('مراجع الصور: profiles[i].options.layout.form.image بمسارها — من أي شكل (الخام والمحلَّل)، وما ليس مرجعاً لا يُعدّ', () => {
  const s = {
    profiles: [
      { id: 'legacy-58', options: {} },
      withForm({ id: ID1, v: 'abcdef0123456789', wPx: 1240, hPx: 1754 }),
      withForm(null),
      withForm({ id: ID2 }),
      withForm({ id: 7 }),
      null,
      'x',
    ],
  };
  assert.deepEqual(formImageRefsOf(s), [
    { id: ID1, v: 'abcdef0123456789', wPx: 1240, hPx: 1754, path: 'profiles[1].options.layout.form.image.id' },
    { id: ID2, path: 'profiles[3].options.layout.form.image.id' },
  ]);
  for (const x of [null, undefined, 1, 'x', [], {}, { profiles: {} }, { profiles: null }]) assert.deepEqual(formImageRefsOf(x), []);
});

test('المرجع يطابق الصورة المحفوظة: موجودة وبصمتها تبدأ بـv (8 فأكثر) وأبعادها — وما غاب من المرجع لا يُقارَن', () => {
  const row = { sha256: sha(Buffer.from('form')), widthPx: 1240, heightPx: 1754 };
  const v = formImageVersion(row.sha256);
  assert.equal(v.length, 16);
  assert.equal(formImageRefMatches({ id: ID1, v, wPx: 1240, hPx: 1754, path: '' }, row), true);
  assert.equal(formImageRefMatches({ id: ID1, v: row.sha256, path: '' }, row), true, 'البصمة كاملة');
  assert.equal(formImageRefMatches({ id: ID1, v: v.toUpperCase(), path: '' }, row), true);
  assert.equal(formImageRefMatches({ id: ID1, path: '' }, row), true);
  assert.equal(formImageRefMatches({ id: ID1, v, path: '' }, undefined), false, 'غير موجودة');
  assert.equal(formImageRefMatches({ id: ID1, v: v.slice(0, 7), path: '' }, row), false, 'أقصر من 8');
  assert.equal(formImageRefMatches({ id: ID1, v: '0000000000000000', path: '' }, row), false, 'صورةٌ أخرى');
  assert.equal(formImageRefMatches({ id: ID1, v, wPx: 1754, hPx: 1240, path: '' }, row), false, 'أبعاد أخرى');
  assert.equal(isFormImageId(ID1), true);
  for (const x of ['x', '', `${ID1}x`, 1, null, '../etc']) assert.equal(isFormImageId(x), false, String(x));
});

test('If-None-Match: الوسم نفسه، أو ضمن قائمة، أو ضعيفاً W/، أو * — وما سواه لا', () => {
  const e = '"abc"';
  for (const h of ['"abc"', '"x", "abc"', 'W/"abc"', '*']) assert.equal(etagMatches(h, e), true, h);
  for (const h of [undefined, '', '"abd"', 'abc', ['"abc"']]) assert.equal(etagMatches(h, e), false, String(h));
});

// ═══ المعالجات الحقيقية فوق Prisma مزيّف ═══

const stub = (r: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, r));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
interface Img { id: string; tenantId: string; mime: string; widthPx: number; heightPx: number; sizeBytes: number; sha256: string; createdById: string | null; createdByName: string | null; createdAt: Date; bytes: Buffer }
let st: { admin: Row | null; images: Img[]; settings: Map<string, unknown>; locks: string[]; txOpts: unknown[]; blobReads: number; writes: number; clock: number };
function reset(): void {
  st = { admin: { isActive: true, canManageCompanySettings: true }, images: [], settings: new Map([[T, null], [OTHER, null]]), locks: [], txOpts: [], blobReads: 0, writes: 0, clock: Date.now() };
}
reset();
const pick = (r: Row, select?: Row): Row => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, r[k]])) : { ...r });
const match = (r: Row, where: Row): boolean => Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in v ? (v.in as unknown[]).includes(r[k])
  : v && typeof v === 'object' && 'lt' in v ? r[k] < v.lt : r[k] === v));
const db: Row = {
  admin: { async findUnique() { return st.admin; } },
  companySettings: {
    async findUnique(a: Row) { return st.settings.has(a.where.tenantId) ? { printSettings: st.settings.get(a.where.tenantId) } : null; },
  },
  printFormImage: {
    async findFirst(a: Row) { const r = st.images.find((x) => match(x, a.where)); return r ? pick(r, a.select) : null; },
    async findMany(a: Row) {
      let rows = st.images.filter((x) => match(x, a.where));
      if (a.orderBy?.createdAt === 'desc') rows = [...rows].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
      if (a.orderBy?.createdAt === 'asc') rows = [...rows].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
      return rows.map((r) => pick(r, a.select));
    },
    async count(a: Row) { return st.images.filter((x) => match(x, a.where)).length; },
    async create(a: Row) {
      st.writes++;
      const { blob, ...data } = a.data;
      const r = { id: crypto.randomUUID(), createdAt: new Date(st.clock += 1000), ...data, bytes: Buffer.from(blob.create.bytes) } as Img;
      st.images.push(r);
      return pick(r, a.select);
    },
    async update(a: Row) {
      st.writes++;
      const r = st.images.find((x) => x.id === a.where.id);
      if (!r) throw new Error('P2025');
      Object.assign(r, a.data);
      return pick(r, a.select);
    },
    async deleteMany(a: Row) {
      st.writes++;
      const before = st.images.length;
      st.images = st.images.filter((x) => !match(x, a.where)); // المحتوى معه (Cascade)
      return { count: before - st.images.length };
    },
  },
  printFormImageBlob: {
    async findUnique(a: Row) { st.blobReads++; const r = st.images.find((x) => x.id === a.where.imageId); return r ? { bytes: r.bytes } : null; },
  },
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    assert.match(strings.join('?'), /^SELECT pg_advisory_xact_lock\(hashtext\(\?::text\)\)$/);
    st.locks.push(String(values[0]));
    return 1;
  },
  async $transaction(fn: (tx: Row) => Promise<unknown>, opts?: unknown) { st.txOpts.push(opts); return fn(db); },
};
stub('config/database', { default: db });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = (require('../routes/printForms') as typeof import('../routes/printForms')).default;

const admin = { id: 'ADM', role: 'ADMIN', name: 'مدير', tenantId: T };
const rep = { id: 'R1', role: 'SALES_REP', name: 'مندوب', tenantId: T };
const keyUser = { ...admin, apiKeyId: 'k1' };

interface Res { status: number; body: Row | null; headers: Record<string, string>; raw: Buffer | null }
/** طلبٌ خامٌ حقيقي (مجرى ببايتاته وترويساته) يمرّ بـexpress.raw كما في الإنتاج */
function rawReq(bytes: Buffer, contentType: string, extra: Row = {}): Row {
  const s = new PassThrough();
  Object.assign(s, { method: 'POST', url: '/', headers: { 'content-type': contentType, 'content-length': String(bytes.length) }, ...extra });
  s.end(bytes);
  return s as unknown as Row;
}
/** يشغّل مكدّس المسار كلّه (حرّاسه ثم معالجه) — المصادقة قبله في routes/company.ts */
async function call(method: string, routePath: string, req: Row = {}): Promise<Res> {
  const layer = (router as unknown as { stack: Row[] }).stack.find((l) => l.route?.path === routePath && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} مفقود`);
  const out: Res = { status: 200, body: null, headers: {}, raw: null };
  // قارئ الخام ينادي next أو يردّ بعد قراءة المجرى (لا بوعده) — فكل حلقةٍ تنتظر next أو الردّ أو انتهاء المعالج الأخير
  let wake: () => void = () => {};
  const res: Row = {
    status(c: number) { out.status = c; return res; },
    json(b: Row) { out.body = b; wake(); return res; },
    set(k: string | Record<string, string>, v?: string) {
      for (const [h, x] of Object.entries(typeof k === 'string' ? { [k]: v as string } : k)) out.headers[h.toLowerCase()] = String(x);
      return res;
    },
    end(b?: Buffer) { out.raw = b ?? null; wake(); return res; },
  };
  const defaults: Row = { query: {}, params: {}, headers: {}, user: admin, body: undefined };
  for (const k of Object.keys(defaults)) if (!(k in req)) req[k] = defaults[k];
  const stack = layer.route.stack as Row[];
  for (const [i, h] of stack.entries()) {
    let passed = false;
    let err: unknown;
    await new Promise<void>((resolve) => {
      wake = resolve;
      Promise.resolve(h.handle(req, res, (e?: unknown) => { if (e) err = e; else passed = true; resolve(); }))
        .then(() => { if (i === stack.length - 1) resolve(); }, (e: unknown) => { err = e; resolve(); });
    });
    if (err) throw err;
    if (!passed) break;
  }
  return out;
}
const upload = (bytes: Buffer, mime = 'image/jpeg', user: Row = admin) => call('post', '/', rawReq(bytes, mime, { user }));
const uploadJson = (body: unknown, user: Row = admin) => call('post', '/', { user, body, headers: { 'content-type': 'application/json' } });

test('الرفع الخام: JPEG ⇒ 201 بالمرجع { id, v, wPx, hPx, sizeBytes } — النوع والأبعاد من البايتات، والبصمة، ومن رفع، وقفل الشركة', async () => {
  reset();
  const b = jpegBytes(1240, 1754);
  const r = await upload(b);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body!.data.id as string;
  assert.ok(isFormImageId(id));
  assert.deepEqual(r.body, { success: true, data: { id, v: sha(b).slice(0, 16), wPx: 1240, hPx: 1754, sizeBytes: b.length } });
  assert.equal(st.images.length, 1);
  const row = st.images[0];
  assert.deepEqual(
    [row.tenantId, row.mime, row.widthPx, row.heightPx, row.sizeBytes, row.sha256, row.createdById, row.createdByName],
    [T, 'image/jpeg', 1240, 1754, b.length, sha(b), 'ADM', 'مدير'],
  );
  assert.ok(row.bytes.equals(b), 'البايتات كما وصلت');
  assert.deepEqual(st.locks, [`print-form:${T}`], 'قفلٌ استشاري للشركة داخل المعاملة');
  assert.deepEqual(st.txOpts, [{ maxWait: 10_000, timeout: 30_000 }]);
  // النوع المحفوظ من البايتات لا من الترويسة: PNG بترويسة jpeg يُحفظ png
  const png = pngBytes(2480, 3508);
  const p = await upload(png, 'image/jpeg');
  assert.equal(p.status, 201);
  assert.equal(st.images[1].mime, 'image/png');
  // WebP كذلك
  const w = await upload(webpVp8Bytes(1240, 1754), 'image/webp');
  assert.deepEqual([w.status, st.images[2].mime, w.body!.data.wPx], [201, 'image/webp', 1240]);
  // جلسة المالك تُسجَّل OWNER: (actorOf) وباسم «الدعم الفني» لا باسم مدير الشركة الذي يحمله توكنها (auditActorName)
  const o = await upload(jpegBytes(1240, 1754, { seed: 9 }), 'image/jpeg', { ...admin, impersonated: true });
  assert.equal(o.status, 201);
  assert.deepEqual([st.images[3].createdById, st.images[3].createdByName], ['OWNER:ADM', 'الدعم الفني']);
  // ومفتاحٌ أصدره الدعم الفني لا يرفع أصلاً (API_KEY_FORBIDDEN) — فلا اسم له هنا
});

test('الصورة نفسها (البصمة نفسها) مرة ثانية ⇒ 200 بالصفّ القائم بلا نسخة — ولو بلغت الشركة سقفها', async () => {
  reset();
  const b = pngBytes(1240, 1754);
  const first = await upload(b, 'image/png');
  const again = await upload(b, 'image/png');
  assert.deepEqual([first.status, again.status], [201, 200]);
  assert.deepEqual(again.body!.data, first.body!.data);
  assert.equal(st.images.length, 1);
  for (let i = 2; i <= PRINT_FORM_CAPS.maxImages; i++) assert.equal((await upload(pngBytes(1240, 1754, 64, i), 'image/png')).status, 201);
  assert.equal((await upload(b, 'image/png')).status, 200, 'إعادة رفع القائمة لا يمنعها السقف');
});

test('إعادة رفع الصورة نفسها تجدّد وقت رفعها — فلا يجمعها السقف وقد عادت لتوّها إلى مصمّمٍ لم يُحفظ بعد', async () => {
  reset();
  const b = jpegBytes(1240, 1754, { seed: 1 });
  const x = (await upload(b)).body!.data.id as string;
  for (let i = 2; i <= PRINT_FORM_CAPS.maxImages; i++) assert.equal((await upload(jpegBytes(1240, 1754, { seed: i }))).status, 201);
  const day = PRINT_FORM_CAPS.staleMs;
  // كلها قديمة وغير مستخدمة، وX أقدمها (رُفعت قبل أيام وتُرك تطبيقها)
  st.images.forEach((r, i) => { r.createdAt = new Date(Date.now() - (5 * day - i * 1000)); });
  // يعيد المستخدم رفع الملف نفسه لقالبٍ آخر: الصفّ القائم بوقتٍ جديد
  const again = await upload(b);
  assert.deepEqual([again.status, again.body!.data.id], [200, x]);
  assert.ok(Date.now() - st.images.find((r) => r.id === x)!.createdAt.getTime() < day, 'وقت الرفع تجدّد');
  // ثم يرفع صورةً أخرى في الجلسة نفسها: يُجمع أقدم ما سواها لا X
  const other = await upload(jpegBytes(1240, 1754, { seed: 77 }));
  assert.equal(other.status, 201, JSON.stringify(other.body));
  assert.ok(st.images.some((r) => r.id === x), 'X باقية');
  assert.equal(st.images.length, PRINT_FORM_CAPS.maxImages);
});

test('الرفع JSON { mimeType, contentBase64 } (وdata URL) مقبول — والنوع المعلن غير الصورة (PDF) ⇒ 400 PRINT_FORM_TYPE', async () => {
  reset();
  const b = pngBytes(1240, 1754);
  const j = await uploadJson({ mimeType: 'image/png', contentBase64: b.toString('base64') });
  assert.deepEqual([j.status, j.body!.data.wPx, j.body!.data.hPx], [201, 1240, 1754], JSON.stringify(j.body));
  const d = await uploadJson({ contentBase64: `data:image/jpeg;base64,${jpegBytes(1240, 1754).toString('base64')}` });
  assert.equal(d.status, 201);
  assert.equal(st.images[1].mime, 'image/jpeg');
  const pdf = await uploadJson({ mimeType: 'application/pdf', contentBase64: pdfBytes().toString('base64') });
  assert.deepEqual([pdf.status, pdf.body!.code, pdf.body!.message], [400, 'PRINT_FORM_TYPE', PRINT_FORM_MESSAGES.type]);
  assert.match(PRINT_FORM_MESSAGES.type, /PDF احفظه صورة JPG أو PNG ثم ارفعه/);
  // معلنٌ صورة وبايتاته PDF أو GIF: النوع من البايتات
  for (const x of [pdfBytes(), gifBytes()]) {
    const r = await uploadJson({ mimeType: 'image/png', contentBase64: x.toString('base64') });
    assert.deepEqual([r.status, r.body!.code], [400, 'PRINT_FORM_TYPE']);
  }
  for (const body of [{}, { contentBase64: '' }, { contentBase64: '***' }, { contentBase64: 5 }, { mimeType: 'image/png' }]) {
    const r = await uploadJson(body);
    assert.deepEqual([r.status, r.body!.code], [400, 'PRINT_FORM_INVALID'], JSON.stringify(body));
  }
  assert.equal(st.images.length, 2, 'لا صفّ لمرفوض');
});

test('النوع من البايتات: PDF أو GIF خاماً ⇒ 400 PRINT_FORM_TYPE، وJPEG تالفٌ بلا أبعاد ⇒ PRINT_FORM_TYPE برسالة التعذّر — بلا كتابة', async () => {
  reset();
  const pdf = await upload(pdfBytes(), 'application/pdf');
  assert.deepEqual([pdf.status, pdf.body!.code], [400, 'PRINT_FORM_TYPE']);
  const gif = await upload(gifBytes(), 'image/png');
  assert.deepEqual([gif.status, gif.body!.code], [400, 'PRINT_FORM_TYPE']);
  const broken = await upload(jpegBytes(1240, 1754, { noSof: true }));
  assert.deepEqual([broken.status, broken.body!.code, broken.body!.message], [400, 'PRINT_FORM_TYPE', PRINT_FORM_MESSAGES.unreadable]);
  const empty = await call('post', '/', { user: admin, body: {}, headers: { 'content-type': 'image/jpeg' } });
  assert.deepEqual([empty.status, empty.body!.code], [400, 'PRINT_FORM_INVALID']);
  assert.deepEqual([st.images.length, st.writes, st.locks.length], [0, 0, 0], 'الرفض قبل المعاملة');
});

test('الحجم: فوق 1.5 ميغابايت ⇒ 413 PRINT_FORM_TOO_LARGE برمزه (قارئ الخام بترويسة الطول وبدونها، وJSON) — لا 500', async () => {
  reset();
  // ترويسة طولٍ فوق حدّ القارئ: يُرفض قبل القراءة
  const declared = rawReq(jpegBytes(1240, 1754), 'image/jpeg', { user: admin });
  (declared.headers as Row)['content-length'] = String(PRINT_FORM_CAPS.rawLimitBytes + 1);
  const a = await call('post', '/', declared);
  assert.deepEqual([a.status, a.body!.code, a.body!.message], [413, 'PRINT_FORM_TOO_LARGE', PRINT_FORM_MESSAGES.tooLarge]);
  // مجرى مقطّع بلا طول أطول من الحدّ
  const big = Buffer.concat([jpegBytes(1240, 1754), Buffer.alloc(PRINT_FORM_CAPS.rawLimitBytes + 10)]);
  const chunked = rawReq(big, 'image/jpeg', { user: admin });
  delete (chunked.headers as Row)['content-length'];
  (chunked.headers as Row)['transfer-encoding'] = 'chunked';
  const b = await call('post', '/', chunked);
  assert.deepEqual([b.status, b.body!.code], [413, 'PRINT_FORM_TOO_LARGE']);
  // بين حدّ الصورة وحدّ القارئ: يُقرأ ثم يُرفض بالحدّ نفسه
  const over = Buffer.concat([jpegBytes(1240, 1754), Buffer.alloc(PRINT_FORM_CAPS.maxBytes)]);
  const c = await upload(over);
  assert.deepEqual([c.status, c.body!.code], [413, 'PRINT_FORM_TOO_LARGE']);
  const j = await uploadJson({ mimeType: 'image/jpeg', contentBase64: over.toString('base64') });
  assert.deepEqual([j.status, j.body!.code], [413, 'PRINT_FORM_TOO_LARGE']);
  // الحدّ نفسه مقبول
  const edge = Buffer.concat([jpegBytes(1240, 1754), Buffer.alloc(PRINT_FORM_CAPS.maxBytes - jpegBytes(1240, 1754).length)]);
  assert.equal(edge.length, PRINT_FORM_CAPS.maxBytes);
  assert.equal((await upload(edge)).status, 201);
  assert.equal(st.images.length, 1);
});

test('الأبعاد: أقل من 200 أو أكبر من 10000 بكسل ⇒ 400 PRINT_FORM_SIZE بأبعادها — والحدّان مقبولان', async () => {
  reset();
  for (const [w, h] of [[199, 1754], [1240, 199], [10001, 1754], [1240, 10001]]) {
    const r = await upload(pngBytes(w, h), 'image/png');
    assert.deepEqual([r.status, r.body!.code, r.body!.message, r.body!.wPx, r.body!.hPx], [400, 'PRINT_FORM_SIZE', PRINT_FORM_MESSAGES.size, w, h], `${w}×${h}`);
  }
  assert.equal(st.images.length, 0);
  assert.equal((await upload(pngBytes(200, 10000), 'image/png')).status, 201);
  assert.equal((await upload(pngBytes(10000, 200), 'image/png')).status, 201);
});

test('السقف: ٨ صور للشركة ⇒ التاسعة 409 PRINT_FORM_LIMIT بعد القفل — وشركةٌ أخرى لا تُحسب عليها', async () => {
  reset();
  for (let i = 1; i <= PRINT_FORM_CAPS.maxImages; i++) assert.equal((await upload(jpegBytes(1240, 1754, { seed: i }))).status, 201);
  // صور شركة أخرى لا تُعدّ
  st.images.push({ ...st.images[0], id: crypto.randomUUID(), tenantId: OTHER, sha256: 'f'.repeat(64) });
  const r = await upload(jpegBytes(1240, 1754, { seed: 99 }));
  assert.deepEqual([r.status, r.body!.code, r.body!.message, r.body!.limit, r.body!.count], [409, 'PRINT_FORM_LIMIT', PRINT_FORM_MESSAGES.limit, 8, 8]);
  assert.equal(st.images.filter((x) => x.tenantId === T).length, 8);
  assert.equal(st.locks.length, PRINT_FORM_CAPS.maxImages + 1, 'العدّ تحت القفل');
  // والشركة الأخرى ترفع بسقفها هي
  assert.equal((await upload(jpegBytes(1240, 1754, { seed: 99 }), 'image/jpeg', { ...admin, tenantId: OTHER })).status, 201);
});

test('السقف يجمع المهمَل: الأقدم مما لا يشير إليه المحفوظ ومضى عليه يوم يُحذف ليمرّ الرفع — والمستخدَمة والحديثة وصور شركةٍ أخرى تبقى', async () => {
  reset();
  for (let i = 1; i <= PRINT_FORM_CAPS.maxImages; i++) assert.equal((await upload(jpegBytes(1240, 1754, { seed: i }))).status, 201);
  const mine = st.images.filter((x) => x.tenantId === T);
  const day = PRINT_FORM_CAPS.staleMs;
  // الثلاث الأولى قديمة: الأولى مستخدمةٌ في المحفوظ، والثانية أقدم من الثالثة
  mine[0].createdAt = new Date(Date.now() - 5 * day);
  mine[1].createdAt = new Date(Date.now() - 3 * day);
  mine[2].createdAt = new Date(Date.now() - 2 * day);
  st.settings.set(T, { version: 1, profiles: [withForm({ id: mine[0].id, v: formImageVersion(mine[0].sha256), wPx: 1240, hPx: 1754 })] });
  // صورة شركةٍ أخرى قديمة غير مستخدمة لا تُمسّ
  const foreign = { ...mine[3], id: crypto.randomUUID(), tenantId: OTHER, sha256: 'e'.repeat(64), createdAt: new Date(Date.now() - 9 * day) };
  st.images.push(foreign);
  const r = await upload(jpegBytes(1240, 1754, { seed: 50 }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ids = st.images.filter((x) => x.tenantId === T).map((x) => x.id);
  assert.equal(ids.length, PRINT_FORM_CAPS.maxImages);
  assert.ok(!ids.includes(mine[1].id), 'الأقدم غير المستخدم حُذف');
  assert.ok(ids.includes(mine[0].id) && ids.includes(mine[2].id), 'المستخدمة والتالية في القِدم باقيتان');
  assert.ok(st.images.some((x) => x.id === foreign.id), 'صورة الشركة الأخرى باقية');
  // التالية تأخذ الثالثة، ثم لا قديمَ غير مستخدم ⇒ 409 كما كان
  assert.equal((await upload(jpegBytes(1240, 1754, { seed: 51 }))).status, 201);
  assert.ok(!st.images.some((x) => x.id === mine[2].id));
  const full = await upload(jpegBytes(1240, 1754, { seed: 52 }));
  assert.deepEqual([full.status, full.body!.code, full.body!.count], [409, 'PRINT_FORM_LIMIT', 8]);
  assert.ok(st.images.some((x) => x.id === mine[0].id), 'المستخدمة لا تُحذف ولو كانت الأقدم');
});

test('الحرّاس: المندوب ومن لا يملك «إعدادات الشركة» 403، ومفتاح API ⇒ 403 API_KEY_FORBIDDEN للرفع والحذف — قبل قراءة الجسم وبلا كتابة', async () => {
  reset();
  assert.equal((await upload(jpegBytes(1240, 1754), 'image/jpeg', rep)).status, 403);
  st.admin = { isActive: true, canManageCompanySettings: false };
  assert.equal((await upload(jpegBytes(1240, 1754), 'image/jpeg', { ...admin, id: 'M1', role: 'MANAGER' })).status, 403);
  assert.equal((await call('get', '/', { user: { ...admin, id: 'M1', role: 'MANAGER' } })).status, 403, 'القائمة كذلك');
  st.admin = { isActive: true, canManageCompanySettings: true };
  const key = rawReq(jpegBytes(1240, 1754), 'image/jpeg', { user: keyUser });
  const k = await call('post', '/', key);
  assert.deepEqual([k.status, k.body!.code, k.body!.message], [403, 'API_KEY_FORBIDDEN', PRINT_FORM_MESSAGES.apiKey]);
  assert.equal((key as unknown as { _body?: boolean })._body, undefined, 'الجسم لم يُقرأ');
  assert.deepEqual([st.images.length, st.writes, st.locks.length], [0, 0, 0]);
  // الحذف بالمفتاح كذلك — ولو كانت الصورة موجودة غير مستخدمة
  const id = (await upload(jpegBytes(1240, 1754))).body!.data.id as string;
  const d = await call('delete', '/:id', { user: keyUser, params: { id } });
  assert.deepEqual([d.status, d.body!.code], [403, 'API_KEY_FORBIDDEN']);
  assert.equal(st.images.length, 1);
  // والقراءة بالمفتاح كالجلسة (لا شيء يُكتب)
  assert.equal((await call('get', '/:id', { user: keyUser, params: { id } })).status, 200);
  assert.equal((await call('get', '/', { user: keyUser })).status, 200);
});

test('القائمة: بلا بايتات، الأحدث أولاً، وinUse من إعدادات الطباعة المحفوظة (الخام) — وصور الشركة وحدها', async () => {
  reset();
  const a = (await upload(jpegBytes(1240, 1754, { seed: 1 }))).body!.data;
  const b = (await upload(pngBytes(1240, 1754), 'image/png')).body!.data;
  await upload(jpegBytes(1240, 1754, { seed: 3 }), 'image/jpeg', { ...admin, tenantId: OTHER });
  st.settings.set(T, { version: 1, profiles: [withForm({ id: a.id, v: a.v, wPx: 1240, hPx: 1754 })] });
  const r = await call('get', '/');
  assert.equal(r.status, 200);
  assert.equal(r.body!.limit, 8);
  const rows = r.body!.data as Row[];
  assert.deepEqual(rows.map((x) => [x.id, x.inUse]), [[b.id, false], [a.id, true]]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['createdAt', 'createdByName', 'hPx', 'id', 'inUse', 'mime', 'sizeBytes', 'v', 'wPx']);
  assert.deepEqual([rows[0].mime, rows[0].v, rows[0].sizeBytes, rows[0].createdByName], ['image/png', b.v, b.sizeBytes, 'مدير']);
  assert.equal(st.blobReads, 0, 'لا بايتات في القائمة');
  // بلا صفّ إعدادات: لا شيء مستخدم
  st.settings.delete(T);
  assert.deepEqual(((await call('get', '/')).body!.data as Row[]).map((x) => x.inUse), [false, false]);
});

test('الصورة: لكل مسجّل في الشركة (والمندوب) ببايتاتها ونوعها وnosniff وETag بالبصمة وتخزينٍ طويل — و304 بلا قراءة البايتات', async () => {
  reset();
  const bytes = jpegBytes(1240, 1754);
  const id = (await upload(bytes)).body!.data.id as string;
  const r = await call('get', '/:id', { user: rep, params: { id } });
  assert.equal(r.status, 200);
  assert.ok(r.raw && r.raw.equals(bytes));
  assert.deepEqual(r.headers, {
    etag: `"${sha(bytes)}"`, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff',
    'content-type': 'image/jpeg', 'content-length': String(bytes.length),
  });
  assert.equal(st.blobReads, 1);
  for (const inm of [`"${sha(bytes)}"`, `W/"${sha(bytes)}", "x"`]) {
    const n = await call('get', '/:id', { user: rep, params: { id }, headers: { 'if-none-match': inm } });
    assert.deepEqual([n.status, n.raw, n.body], [304, null, null], inm);
    assert.equal(n.headers.etag, `"${sha(bytes)}"`);
    assert.equal(n.headers['cache-control'], 'private, max-age=31536000, immutable');
  }
  assert.equal(st.blobReads, 1, '304 بلا قراءة المحتوى');
  const stale = await call('get', '/:id', { user: rep, params: { id }, headers: { 'if-none-match': '"old"' } });
  assert.equal(stale.status, 200);
});

test('عزل الشركات: صورة شركةٍ أخرى أو معرّفٌ مجهول أو غير uuid ⇒ 404 PRINT_FORM_NOT_FOUND — قراءةً وحذفاً', async () => {
  reset();
  const id = (await upload(jpegBytes(1240, 1754), 'image/jpeg', { ...admin, tenantId: OTHER })).body!.data.id as string;
  for (const user of [admin, rep]) {
    const r = await call('get', '/:id', { user, params: { id } });
    assert.deepEqual([r.status, r.body!.code, r.raw], [404, 'PRINT_FORM_NOT_FOUND', null]);
  }
  const d = await call('delete', '/:id', { user: admin, params: { id } });
  assert.deepEqual([d.status, d.body!.code], [404, 'PRINT_FORM_NOT_FOUND']);
  assert.equal(st.images.length, 1, 'صورة الشركة الأخرى باقية');
  assert.equal((await call('get', '/:id', { user: { ...rep, tenantId: OTHER }, params: { id } })).status, 200, 'وشركتها تقرؤها');
  for (const bad of [crypto.randomUUID(), 'x', '../x']) {
    assert.equal((await call('get', '/:id', { user: admin, params: { id: bad } })).status, 404, bad);
    assert.equal((await call('delete', '/:id', { user: admin, params: { id: bad } })).status, 404, bad);
  }
  assert.equal(st.blobReads, 1);
});

test('الحذف: مستخدمةٌ في قالبٍ محفوظ ⇒ 409 PRINT_FORM_IN_USE، وبعد إزالتها تُحذف مع محتواها — بقفل الشركة، والمندوب 403', async () => {
  reset();
  const a = (await upload(jpegBytes(1240, 1754))).body!.data;
  const b = (await upload(pngBytes(1240, 1754), 'image/png')).body!.data;
  st.settings.set(T, { version: 1, profiles: [{ id: 'office', options: {} }, withForm({ id: a.id, v: a.v, wPx: 1240, hPx: 1754 })] });
  st.locks = [];
  const used = await call('delete', '/:id', { user: admin, params: { id: a.id } });
  assert.deepEqual([used.status, used.body!.code, used.body!.message], [409, 'PRINT_FORM_IN_USE', PRINT_FORM_MESSAGES.inUse]);
  assert.equal(st.images.length, 2);
  // المرجع في المحفوظ الخام ولو كان الكائن لا يُحلَّل اليوم (نسخة أحدث)
  st.settings.set(T, { version: 9, profiles: [withForm({ id: b.id })] });
  assert.equal((await call('delete', '/:id', { user: admin, params: { id: b.id } })).status, 409);
  assert.equal((await call('delete', '/:id', { user: rep, params: { id: a.id } })).status, 403);
  st.settings.set(T, null);
  const ok = await call('delete', '/:id', { user: admin, params: { id: a.id } });
  assert.deepEqual([ok.status, ok.body], [200, { success: true, data: { id: a.id } }]);
  assert.deepEqual(st.images.map((x) => x.id), [b.id]);
  assert.deepEqual(st.locks, [`print-form:${T}`, `print-form:${T}`, `print-form:${T}`], 'كل حذفٍ تحت القفل');
  assert.equal((await call('get', '/:id', { user: admin, params: { id: a.id } })).status, 404);
  assert.equal((await call('delete', '/:id', { user: admin, params: { id: a.id } })).status, 404, 'مرة ثانية');
});

// ═══ حرّاس نصّية ═══

test('حارس نصّي: الحرّاس بترتيبها على كل مسار، والقراءة بلا حارس إضافي، والتركيب تحت /api/company بعد المصادقة', () => {
  const r = read('routes', 'printForms.ts');
  assert.ok(r.includes("router.post('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), refuseApiKey, readRawImage, async"));
  assert.ok(r.includes("router.get('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), async"));
  assert.ok(r.includes("router.get('/:id', async"), 'الصورة لكل مسجّل — المندوب يطبع الخلفية');
  assert.ok(r.includes("router.delete('/:id', requireAdmin, requireAdminPermission('canManageCompanySettings'), refuseApiKey, async"));
  assert.doesNotMatch(r, /router\.use\(/, 'لا حارس عامّ يمنع المندوب من القراءة');
  assert.doesNotMatch(r, /companySettings\.(update|upsert|create|updateMany)\(/, 'لا كتابة على صفّ الشركة');
  assert.match(r, /tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(\$\{LOCK_PREFIX \+ tid\}::text\)\)`/);
  const c = read('routes', 'company.ts');
  const auth = c.indexOf('router.use(authenticate);');
  const mount = c.indexOf("router.use('/print-forms', printFormsRouter);");
  assert.ok(auth > 0 && mount > auth, 'المسار بعد المصادقة');
  assert.ok(mount < c.indexOf("router.get('/'"), 'قبل مسارات الشركة');
  // إعدادات الطباعة تتحقّق من كل مرجع صورة قبل كتابتها
  const ps = read('routes', 'printSettings.ts');
  const put = ps.slice(ps.indexOf("router.put('/'"));
  assert.ok(put.indexOf('formImageRefsOf(parsed.value)') > 0 && put.indexOf('formImageRefsOf(parsed.value)') < put.indexOf('prisma.companySettings.updateMany({ where: { tenantId: tid }, data: { printSettings: parsed.value'));
  assert.ok(put.includes("code: 'PRINT_FORM_IMAGE_MISSING'"));
});

test('حارس نصّي: جدولان إضافيان خارج صفّ الشركة — البايتات في جدولٍ منفصل، وحذف الشركة أو الصورة يحذف ما تحته (Cascade)', () => {
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const model = (name: string) => { const i = schema.indexOf(`model ${name} {`); assert.ok(i > 0, name); return schema.slice(i, schema.indexOf('\n}', i)); };
  const img = model('PrintFormImage');
  assert.match(img, /\n\s*tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/);
  for (const f of ['mime\\s+String', 'widthPx\\s+Int', 'heightPx\\s+Int', 'sizeBytes\\s+Int', 'sha256\\s+String', 'blob\\s+PrintFormImageBlob\\?']) assert.match(img, new RegExp(`\\n\\s*${f}`), f);
  assert.doesNotMatch(img, /\sBytes\b/, 'لا بايتات في الوصف');
  assert.match(img, /@@index\(\[tenantId\]\)/);
  assert.match(img, /@@map\("print_form_images"\)/);
  const blob = model('PrintFormImageBlob');
  assert.match(blob, /\n\s*imageId\s+String\s+@unique/);
  assert.match(blob, /\n\s*image\s+PrintFormImage\s+@relation\(fields: \[imageId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(blob, /\n\s*bytes\s+Bytes\n/);
  assert.match(blob, /@@map\("print_form_image_blobs"\)/);
  assert.match(model('Tenant'), /\n\s*printFormImages\s+PrintFormImage\[\]/);
  assert.doesNotMatch(model('CompanySettings'), /PrintForm|formImage/i, 'لا عمود في صفّ الشركة');
});
