// «إرفاق فاتورة المشتريات» (طلب المالك ١٣ نوفمبر ٢٠٢٦): صور فاتورة المورّد (تصوير/استديو) أو PDF مع حركة المستودع.
//  · الخدمة الصرفة services/purchaseAttachments.ts: النوع من البايتات لا من البادئة ولا من الاسم، والأحجام والأعداد، والاسم المنظَّف.
//  · الموجّه الحقيقي routes/warehouse.ts فوق القاعدة المزيّفة lots-b3-fake.ts (نمط warehouse-entry-client-ref.test.ts): المرفقات في
//    معاملة الحركة نفسها (رفضها لا يُبقي مرفقاً)، والإعادة بالمرجع لا تكرّرها، وattachmentsCount في السجلّ، ومسارات حركةٍ قائمة
//    (القائمة والملف والإضافة بالسقف والحذف) معزولةً بالشركة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { World, type Row } from './lots-b3-fake';
import {
  PURCHASE_ATTACHMENT_IMAGE_MAX_BYTES, PURCHASE_ATTACHMENT_MAX_PER_ENTRY, PURCHASE_ATTACHMENT_MAX_PER_REQUEST, PURCHASE_ATTACHMENT_MAX_TOTAL_BYTES,
  PURCHASE_ATTACHMENT_MIMES, PURCHASE_ATTACHMENT_NAME_MAX, PURCHASE_ATTACHMENT_PDF_MAX_BYTES, attachmentName, entryCapMessage, parseAttachmentData,
  parsePurchaseAttachments, servableAttachment, sniffAttachmentMime,
} from '../services/purchaseAttachments';

// ═══ ملفات الاختبار: بايتات توقيع كل نوع ثم حشوٌ إلى الحجم المطلوب ═══
const MB = 1024 * 1024;
const HEAD: Record<string, Buffer> = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  webp: Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ', 'latin1')]),
  pdf: Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'latin1'),
  gif: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'),
};
const bytesOf = (kind: keyof typeof HEAD, size = 2048): Buffer => {
  const b = Buffer.alloc(Math.max(size, HEAD[kind].length), 0x41);
  HEAD[kind].copy(b);
  return b;
};
const url = (mime: string, buf: Buffer) => `data:${mime};base64,${buf.toString('base64')}`;
const JPG = url('image/jpeg', bytesOf('jpeg'));
const PNG = url('image/png', bytesOf('png'));
const WEBP = url('image/webp', bytesOf('webp'));
const PDF = url('application/pdf', bytesOf('pdf', 50_000));

// ═══ الخدمة الصرفة ═══

test('الحدود كما في العقد: صورة ١٫٥ ميغابايت وPDF ٤ وخمسة في الطلب بمجموع ٦ وعشرة للحركة واسمٌ ١٢٠ — والأنواع الأربعة وحدها', () => {
  assert.equal(PURCHASE_ATTACHMENT_IMAGE_MAX_BYTES, 1.5 * MB);
  assert.equal(PURCHASE_ATTACHMENT_PDF_MAX_BYTES, 4 * MB);
  assert.equal(PURCHASE_ATTACHMENT_MAX_PER_REQUEST, 5);
  assert.equal(PURCHASE_ATTACHMENT_MAX_TOTAL_BYTES, 6 * MB);
  assert.equal(PURCHASE_ATTACHMENT_MAX_PER_ENTRY, 10);
  assert.equal(PURCHASE_ATTACHMENT_NAME_MAX, 120);
  assert.deepEqual([...PURCHASE_ATTACHMENT_MIMES], ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  // base64 الطلب الأكبر تحت حدّ جسم JSON (10mb في index.ts) مع هامشٍ لأسطر الحركة
  assert.ok(Math.ceil(PURCHASE_ATTACHMENT_MAX_TOTAL_BYTES / 3) * 4 < 10 * MB - 512 * 1024);
});

test('النوع من البايتات الأولى: JPEG وPNG وWEBP وPDF، وSVG وGIF والنصّ لا شيء', () => {
  assert.equal(sniffAttachmentMime(bytesOf('jpeg')), 'image/jpeg');
  assert.equal(sniffAttachmentMime(bytesOf('png')), 'image/png');
  assert.equal(sniffAttachmentMime(bytesOf('webp')), 'image/webp');
  assert.equal(sniffAttachmentMime(bytesOf('pdf')), 'application/pdf');
  assert.equal(sniffAttachmentMime(bytesOf('svg')), null);
  assert.equal(sniffAttachmentMime(bytesOf('gif')), null);
  assert.equal(sniffAttachmentMime(Buffer.from('RIFF....AVI ', 'latin1')), null, 'RIFF بلا WEBP');
  assert.equal(sniffAttachmentMime(Buffer.from([0xff, 0xd8])), null, 'قصيرٌ لا يكفي');
});

test('data URL: البادئة تُعلن والبايتات تشهد — المختلفان يُرفضان، وما ليس base64 صورةً أو PDF يُرفض، والحجم بعد الفكّ', () => {
  for (const [d, mime] of [[JPG, 'image/jpeg'], [PNG, 'image/png'], [WEBP, 'image/webp'], [PDF, 'application/pdf']] as const) {
    const p = parseAttachmentData(d);
    assert.ok(p.ok, mime);
    if (p.ok) assert.equal(p.mime, mime);
  }
  const p = parseAttachmentData(PDF);
  assert.ok(p.ok && p.size === 50_000, 'الحجم بالبايتات لا بطول النصّ');
  // PDF ببادئة صورة، وصورة ببادئة PDF، وSVG وGIF، ونصٌّ حرّ، ورابط
  const bad = [
    url('image/png', bytesOf('pdf')), url('application/pdf', bytesOf('png')), url('image/jpeg', bytesOf('webp')),
    url('image/svg+xml', bytesOf('svg')), url('image/png', bytesOf('svg')), url('image/gif', bytesOf('gif')),
    url('application/octet-stream', bytesOf('pdf')), 'javascript:alert(1)', 'https://evil.example/x.pdf', '', null, 42,
    `data:application/pdf;base64,${bytesOf('pdf').toString('base64')}!!`, // محرفٌ خارج base64
    `data:application/pdf;base64,${bytesOf('pdf').toString('base64').slice(0, -1)}`, // حشوٌ مبتور
    url('image/jpeg', HEAD.jpeg), // أصغر من ملفٍّ حقيقي
  ];
  for (const d of bad) assert.equal(parseAttachmentData(d).ok, false, String(d).slice(0, 40));
  // المسافات حول النصّ تُقصّ (لا داخله)
  assert.ok(parseAttachmentData(`  ${PNG}\n`).ok);
});

test('الأحجام: الصورة حتى ١٫٥ ميغابايت والـPDF حتى ٤ — البايت الزائد يُرفض برسالته', () => {
  assert.ok(parseAttachmentData(url('image/jpeg', bytesOf('jpeg', PURCHASE_ATTACHMENT_IMAGE_MAX_BYTES))).ok);
  const big = parseAttachmentData(url('image/jpeg', bytesOf('jpeg', PURCHASE_ATTACHMENT_IMAGE_MAX_BYTES + 1)));
  assert.ok(!big.ok && big.reason.includes('الصورة أكبر من 1.5 ميغابايت'), JSON.stringify(big));
  assert.ok(parseAttachmentData(url('application/pdf', bytesOf('pdf', PURCHASE_ATTACHMENT_PDF_MAX_BYTES))).ok);
  const bigPdf = parseAttachmentData(url('application/pdf', bytesOf('pdf', PURCHASE_ATTACHMENT_PDF_MAX_BYTES + 1)));
  assert.ok(!bigPdf.ok && bigPdf.reason.includes('PDF أكبر من 4 ميغابايت'), JSON.stringify(bigPdf));
  // نصٌّ أطول من أكبر ملفٍّ ممكن يُرفض قبل التعبير النمطي
  const huge = parseAttachmentData(url('application/pdf', bytesOf('pdf', PURCHASE_ATTACHMENT_PDF_MAX_BYTES + 64)));
  assert.ok(!huge.ok && huge.reason.includes('أكبر من المسموح'));
});

test('القائمة كلها أو لا شيء: الغائب لا شيء، وغير المصفوفة والزائد عن خمسة والمجموع فوق ٦ ميغابايت وملفٌّ واحد تالف — رفضٌ يسمّيه', () => {
  assert.deepEqual(parsePurchaseAttachments(undefined), { ok: true, items: [] });
  assert.deepEqual(parsePurchaseAttachments(null), { ok: true, items: [] });
  assert.deepEqual(parsePurchaseAttachments([]), { ok: true, items: [] });
  assert.equal(parsePurchaseAttachments({ name: 'a', data: PNG }).ok, false, 'كائنٌ لا قائمة');
  assert.equal(parsePurchaseAttachments(PNG).ok, false);
  const six = parsePurchaseAttachments(Array.from({ length: 6 }, (_, k) => ({ name: `f${k}.png`, data: PNG })));
  assert.ok(!six.ok && six.message.includes('5'), JSON.stringify(six));
  const pdf35 = url('application/pdf', bytesOf('pdf', 3.5 * MB));
  const total = parsePurchaseAttachments([{ name: 'a.pdf', data: pdf35 }, { name: 'b.pdf', data: pdf35 }]);
  assert.ok(!total.ok && total.message.includes('6 ميغابايت'), JSON.stringify(total));
  const one = parsePurchaseAttachments([{ name: 'فاتورة.jpg', data: JPG }, { name: 'شعار.svg', data: url('image/svg+xml', bytesOf('svg')) }]);
  assert.ok(!one.ok && one.message.includes('«شعار.svg»'), 'الرسالة تسمّي الملف');
  const noName = parsePurchaseAttachments([{ data: 'x' }]);
  assert.ok(!noName.ok && noName.message.includes('رقم 1'));
  const ok = parsePurchaseAttachments([{ name: ' فاتورة المورد ', data: JPG }, { name: 'scan.pdf', data: PDF }, { name: 'x', data: WEBP }]);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.items.map((i) => [i.name, i.mime]), [['فاتورة المورد.jpg', 'image/jpeg'], ['scan.pdf', 'application/pdf'], ['x.webp', 'image/webp']]);
    assert.equal(ok.items[1].size, 50_000);
    assert.equal(ok.items[1].data, PDF);
  }
});

test('الاسم: يُقصّ ويُنظَّف من محارف التحكّم والاتجاه والفواصل، وينتهي بامتداد نوعه المفحوص — لا يُصدَّق في النوع', () => {
  assert.equal(attachmentName('  فاتورة المورد.pdf  ', 'application/pdf'), 'فاتورة المورد.pdf');
  assert.equal(attachmentName('IMG_0001.HEIC', 'image/jpeg'), 'IMG_0001.jpg', 'امتدادٌ معروف مخالف يُستبدل');
  assert.equal(attachmentName('photo.JPEG', 'image/jpeg'), 'photo.JPEG');
  assert.equal(attachmentName('invoice‮fdp.exe', 'application/pdf'), 'invoice fdp.exe.pdf', 'U+202E لا يقلب الامتداد');
  assert.equal(attachmentName('x/../y\\z\u0000.png', 'image/png'), 'x .. y z .png');
  assert.equal(attachmentName('', 'image/png'), 'فاتورة-مشتريات.png');
  assert.equal(attachmentName(undefined, 'application/pdf'), 'فاتورة-مشتريات.pdf');
  assert.equal(attachmentName('.pdf', 'image/webp'), 'فاتورة-مشتريات.webp');
  const long = attachmentName(`${'ب'.repeat(300)}.pdf`, 'application/pdf');
  assert.ok(long.length <= PURCHASE_ATTACHMENT_NAME_MAX && long.endsWith('.pdf'), long);
  const long2 = attachmentName('ج'.repeat(500), 'image/png');
  assert.ok(long2.length <= PURCHASE_ATTACHMENT_NAME_MAX && long2.endsWith('.png'));
});

test('سقف الحركة والتقديم: entryCapMessage بما يتّسع، وservableAttachment يطابق النوع المحفوظ بالبايتات', () => {
  assert.equal(entryCapMessage(0, 5), null);
  assert.equal(entryCapMessage(5, 5), null);
  assert.ok(entryCapMessage(8, 3)?.includes('2'));
  assert.ok(entryCapMessage(10, 1)?.includes('الحد الأقصى'));
  assert.equal(servableAttachment('application/pdf', PDF), true);
  assert.equal(servableAttachment('image/png', PDF), false, 'نوعٌ محفوظ يخالف البايتات');
  assert.equal(servableAttachment('image/svg+xml', url('image/svg+xml', bytesOf('svg'))), false);
  assert.equal(servableAttachment('image/png', 'javascript:alert(1)'), false);
  assert.equal(servableAttachment('image/png', null), false);
});

// ═══ الموجّه فوق القاعدة المزيّفة ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const world = new World();
const db = world.db;
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const router = (require('../routes/warehouse') as typeof import('../routes/warehouse')).default;
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

// جدول المرفقات في الذاكرة — يُستعاد مع لقطة المعاملة عند الرمي (لا مرفق بلا حركة)
interface WAtt { id: string; tenantId: string; entryId: string; name: string; mime: string; size: number; data: string; createdBy: string | null; createdAt: Date }
let atts: WAtt[] = [];
let attSeq = 0;
let failAttAt = -1; // موضع الإنشاء الذي يرمي (محاكاة عطلٍ بعد صفّ الحركة)
const pick = (r: WAtt, select?: Row): Row => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, (r as unknown as Row)[k]])) : { ...r });
const attWhere = (w: Row) => (r: WAtt) => (w.id === undefined || r.id === w.id) && (w.tenantId === undefined || r.tenantId === w.tenantId)
  && (w.entryId === undefined || r.entryId === w.entryId);
db.warehouseEntryAttachment = {
  create: async (a: Row) => {
    world.calls.push({ op: 'warehouseEntryAttachment.create', args: { ...a, data: { ...a.data, data: '…' } } });
    if (failAttAt === atts.length) throw new Error('عطلٌ مصطنع في كتابة المرفق');
    const r: WAtt = { id: `att${++attSeq}`, createdAt: new Date(Date.parse('2026-11-13T10:00:00Z') + attSeq * 1000), createdBy: null, ...a.data };
    atts.push(r);
    return pick(r, a.select);
  },
  findMany: async (a: Row) => atts.filter(attWhere(a.where)).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((r) => pick(r, a.select)),
  findFirst: async (a: Row) => { const r = atts.find(attWhere(a.where)); return r ? pick(r, a.select) : null; },
  count: async (a: Row) => atts.filter(attWhere(a.where)).length,
  deleteMany: async (a: Row) => { const n = atts.length; atts = atts.filter((r) => !attWhere(a.where)(r)); return { count: n - atts.length }; },
};
const origTx = db.$transaction as (fn: (tx: Row) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
db.$transaction = async (fn: (tx: Row) => Promise<unknown>, opts?: unknown) => {
  const snap = atts.map((r) => ({ ...r }));
  try { return await origTx(fn, opts); } catch (e) { atts = snap; throw e; }
};

// القاعدة المزيّفة لا تعرف clientRef ولا شركة الحركة المنشأة ولا _count: تُكمَل هنا كما تفعل Prisma (نمط warehouse-entry-client-ref)
const refOf = new Map<string, string | null>();
let hidePrior = 0;
const origCreate = db.warehouseEntry.create as (a: Row) => Promise<Row>;
db.warehouseEntry.create = async (a: Row) => {
  const out = await origCreate(a);
  const e = world.entries.at(-1)!;
  e.tenantId = a.data.tenantId;
  refOf.set(e.id, a.data.clientRef ?? null);
  return { ...out, tenantId: e.tenantId, clientRef: a.data.clientRef ?? null };
};
const origFindMany = db.warehouseEntry.findMany as (a: Row) => Promise<Row[]>;
db.warehouseEntry.findMany = async (a: Row) => (await origFindMany(a))
  .filter((e) => a.where.clientRef === undefined || refOf.get(e.id as string) === a.where.clientRef)
  .map((e) => (a.include?._count ? { ...e, _count: { attachments: atts.filter((r) => r.entryId === e.id).length } } : e));
db.warehouseEntry.findFirst = async (a: Row) => {
  world.calls.push({ op: 'warehouseEntry.findFirst', args: a });
  if (a.where.clientRef === undefined) {
    const e = world.entries.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId);
    return e ? { id: e.id } : null;
  }
  if (hidePrior > 0) { hidePrior--; return null; }
  const e = world.entries.find((x) => x.tenantId === a.where.tenantId && refOf.get(x.id) === a.where.clientRef);
  if (!e) return null;
  return { ...e, clientRef: refOf.get(e.id), items: world.items.filter((i) => i.entryId === e.id).map((i) => ({ ...i, product: { id: i.productId, name: i.productId, unit: 'حبة', primaryUnitId: null } })) };
};

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };
const OTHER = { ...ADMIN, id: 'ADM2', tenantId: 't2', name: 'مدير أخرى' };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }

async function call(method: string, p: string, req: Row = {}): Promise<{ status: number; body: Row; headers: Row }> {
  const stack = (router as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === p && l.route.methods[method]);
  assert.ok(layer, `${method} ${p} مفقود`);
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const errHandlers = [...stack.filter((l) => !l.route && l.handle.length === 4).map((l) => l.handle), errorHandler];
  const headers: Row = {};
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = JSON.parse(JSON.stringify(b)); return res; };
  res.setHeader = (k: string, v: string) => { headers[k] = v; return res; };
  const full = { method: method.toUpperCase(), query: {}, params: {}, body: {}, headers: {}, user: ADMIN, ...req };
  let err: unknown = null;
  for (const h of [...pre, ...layer!.route!.stack.map((l) => l.handle)]) {
    let passed = false;
    await h(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err || !passed) break;
  }
  if (err) {
    for (const eh of errHandlers) {
      let next: unknown = null;
      let passed = false;
      await eh(err, full, res, (e?: unknown) => { next = e; passed = true; });
      if (!passed) return { status: res.statusCode, body: res.body, headers };
      err = next;
    }
    return { status: 500, body: { message: (err as Error)?.message }, headers };
  }
  return { status: res.statusCode, body: res.body, headers };
}

/** عالمٌ جديد: P3 غير متتبَّع والميزة مطفأة (المسار القائم)؛ وT1 متتبَّع وT2 متتبَّع بصلاحية لمسار اللوط حين تُفعَّل */
function fresh(): void {
  Object.assign(world, new World());
  world.lotsEnabled = false;
  world.product({ id: 'P3', name: 'سكر' });
  world.product({ id: 'T1', name: 'ماء' });
  world.product({ id: 'T2', name: 'حليب', shelfLifeEnabled: true, shelfLifeValue: 30, shelfLifeUnit: 'DAY' });
  world.track('T1');
  world.track('T2');
  refOf.clear();
  hidePrior = 0;
  atts = [];
  attSeq = 0;
  failAttAt = -1;
}
const post = (body: Row, user: Row = ADMIN) => call('post', '/entries', { body, user });
const TWO = [{ name: 'فاتورة المورد.jpg', data: JPG }, { name: 'scan', data: PDF }];

test('الوارد بمرفقين: 201 والمرفقات في معاملة الحركة بعد صفّها، على الحركة نفسها وشركتها، والردّ بياناتها الوصفية بلا الملفات', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', supplier: 'مورد', items: [{ productId: 'P3', qty: 10, unitCost: 4 }], attachments: TWO });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.data.id as string;
  assert.equal(atts.length, 2);
  assert.ok(atts.every((a) => a.entryId === id && a.tenantId === 't1' && a.createdBy === 'المدير'));
  assert.deepEqual(atts.map((a) => [a.name, a.mime, a.size]), [['فاتورة المورد.jpg', 'image/jpeg', 2048], ['scan.pdf', 'application/pdf', 50_000]]);
  assert.equal(atts[1].data, PDF, 'data URL كاملاً كما أُرسل');
  const meta = r.body.attachments as Row[];
  assert.deepEqual(meta.map((m) => Object.keys(m).sort()), [0, 1].map(() => ['createdAt', 'createdBy', 'id', 'mime', 'name', 'size']), 'لا data في الردّ');
  // الترتيب: قفل المرجع/الأساس ثم صفّ الحركة ثم المرفقات ثم الالتزام
  const ops = world.calls.map((c) => c.op);
  const at = (op: string) => ops.indexOf(op);
  assert.ok(at('tx.begin') < at('warehouseEntry.create') && at('warehouseEntry.create') < at('warehouseEntryAttachment.create')
    && ops.lastIndexOf('warehouseEntryAttachment.create') < at('tx.commit'), ops.join(' '));
});

test('بلا مرفقات: الردّ والكتابة كما كانا حرفياً (لا attachments ولا استعلام مرفق)', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 3 }] });
  assert.equal(r.status, 201);
  assert.equal('attachments' in r.body, false);
  assert.equal(world.calls.some((c) => c.op.startsWith('warehouseEntryAttachment')), false);
});

test('التسوية تقبل المرفق أيضاً (ADJUST)، والوارد السالب كله يصير تسوية ويحمل مرفقه', async () => {
  fresh();
  const a = await post({ type: 'ADJUST', items: [{ productId: 'P3', qty: -2 }], attachments: [{ name: 'محضر جرد.png', data: PNG }] });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(atts.length, 1);
  assert.equal(atts[0].entryId, a.body.data.id);
  const neg = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: -1 }], attachments: [{ name: 'مرتجع.webp', data: WEBP }] });
  assert.equal(neg.status, 201, JSON.stringify(neg.body));
  assert.equal(neg.body.data.type, 'ADJUST');
  assert.equal(atts[1].entryId, neg.body.data.id);
});

test('وارد مختلط (موجب وسالب): المرفقات على الحركة الرئيسية لا على تسوية الإنقاص المفصولة', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 5 }, { productId: 'P3', qty: -1 }], attachments: [{ name: 'f.pdf', data: PDF }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.adjustment);
  assert.deepEqual(atts.map((a) => a.entryId), [r.body.data.id]);
});

test('مرفقٌ لا يصلح: 400 ATTACHMENT_INVALID برسالةٍ عربية ولا حركة ولا مرفق — والإعادة بعده تُكتب', async () => {
  fresh();
  for (const bad of [
    [{ name: 'a.pdf', data: url('image/png', bytesOf('pdf')) }],
    [{ name: 'شعار.svg', data: url('image/svg+xml', bytesOf('svg')) }],
    [...TWO, { name: 'x', data: 'not-a-file' }],
    Array.from({ length: 6 }, () => ({ name: 'p.png', data: PNG })),
    { name: 'a', data: PNG },
  ]) {
    const r = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }], attachments: bad });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.success, false);
    assert.equal(r.body.code, 'ATTACHMENT_INVALID');
    assert.match(r.body.message, /[؀-ۿ]/);
  }
  assert.equal(world.entries.length, 0);
  assert.equal(atts.length, 0);
  assert.equal(world.calls.some((c) => c.op === 'tx.begin'), false, 'الفحص قبل أي معاملة');
});

test('رفض الحركة لا يُبقي مرفقاً: عطلٌ في المرفق الثاني يُرجع الحركة كلها، وعطل الحركة لا يكتب مرفقاً', async () => {
  fresh();
  failAttAt = 1;
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 4 }], attachments: TWO });
  assert.equal(r.status, 500);
  assert.equal(world.entries.length, 0, 'الحركة رجعت مع المرفق');
  assert.equal(atts.length, 0, 'والمرفق الأول رجع معها');
  failAttAt = -1;
  const orig = db.warehouseEntry.create;
  db.warehouseEntry.create = async () => { throw new Error('عطل الحركة'); };
  world.calls = [];
  try {
    assert.equal((await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 4 }], attachments: TWO })).status, 500);
  } finally { db.warehouseEntry.create = orig; }
  assert.equal(atts.length, 0);
  assert.equal(world.calls.some((c) => c.op === 'warehouseEntryAttachment.create'), false, 'المرفق بعد صفّ الحركة لا قبله');
});

test('مسار اللوط (الميزة مفعّلة وصنفٌ متتبَّع): المرفقات بعد الحركة في معاملتها، ورفض الخطة (LOT_EXPIRY_REQUIRED) لا يكتب مرفقاً', async () => {
  fresh();
  world.lotsEnabled = true;
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'T1', qty: 10 }], attachments: TWO });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(world.lots.length, 1);
  assert.deepEqual(atts.map((a) => a.entryId), [r.body.data.id, r.body.data.id]);
  assert.equal((r.body.attachments as Row[]).length, 2);
  const refused = await post({ type: 'RECEIVE', items: [{ productId: 'T2', qty: 5, lotNumber: 'M-1' }], attachments: TWO });
  assert.ok(refused.status >= 400 && refused.status < 500, JSON.stringify(refused.body));
  assert.equal(world.entries.length, 1);
  assert.equal(atts.length, 2, 'لا مرفق للحركة المرفوضة');
  // المسار غير المتتبَّع والميزة مفعّلة (D25) يكتبها أيضاً
  const plain = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }], attachments: [{ name: 'p.png', data: PNG }] });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(atts.at(-1)!.entryId, plain.body.data.id);
});

test('الإعادة بالمرجع (clientRef): 200 replay بلا مرفقٍ مكرَّر — ولو تزامنت مع أصلها (القفل في المعاملة يجدها فتُجهَض)', async () => {
  fresh();
  const first = await post({ type: 'RECEIVE', clientRef: 'po-2026-77', items: [{ productId: 'P3', qty: 6 }], attachments: TWO });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await post({ type: 'RECEIVE', clientRef: 'po-2026-77', items: [{ productId: 'P3', qty: 6 }], attachments: TWO });
  assert.equal(again.status, 200);
  assert.equal(again.body.replay, true);
  assert.equal(again.body.data.id, first.body.data.id);
  assert.equal(atts.length, 2);
  hidePrior = 1;
  const raced = await post({ type: 'RECEIVE', clientRef: 'po-2026-77', items: [{ productId: 'P3', qty: 6 }], attachments: TWO });
  assert.equal(raced.status, 200, JSON.stringify(raced.body));
  assert.equal(raced.body.replay, true);
  assert.equal(world.entries.length, 1);
  assert.equal(atts.length, 2, 'لا مرفق ثالث');
});

test('حركةٌ لا تُكتب (كل الكميات صفر): 200 noop بلا مرفق وتحذير ATTACHMENTS_NOT_SAVED — وبلا مرفقات كما كان', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 0 }], attachments: TWO });
  assert.equal(r.status, 200);
  assert.equal(r.body.noop, true);
  assert.deepEqual((r.body.warnings as Row[]).map((w) => w.code), ['NO_QUANTITIES', 'ATTACHMENTS_NOT_SAVED']);
  assert.equal(atts.length, 0);
  const plain = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 0 }] });
  assert.deepEqual((plain.body.warnings as Row[]).map((w) => w.code), ['NO_QUANTITIES']);
});

test('السجلّ GET /entries: attachmentsCount لكل حركة (صفرٌ بلا مرفق) من _count وحده، و_count الخام لا يخرج', async () => {
  fresh();
  const a = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }], attachments: TWO });
  const b = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 2 }] });
  world.calls = [];
  const g = await call('get', '/entries');
  assert.equal(g.status, 200);
  const rows = g.body.data as Row[];
  const byId = new Map(rows.map((e) => [e.id, e]));
  assert.equal(byId.get(a.body.data.id)!.attachmentsCount, 2);
  assert.equal(byId.get(b.body.data.id)!.attachmentsCount, 0);
  assert.ok(rows.every((e) => !('_count' in e)));
  assert.equal(world.calls.some((c) => c.op.startsWith('warehouseEntryAttachment')), false, 'الملفات لا تُقرأ في السجلّ');
});

/** حركةٌ لشركةٍ أخرى بمرفقٍ واحد — للعزل */
function otherTenantEntry(): { entryId: string; attId: string } {
  const e = world.entry('RECEIVE', [{ productId: 'P3', qty: 1 }]);
  e.tenantId = 't2';
  const r: WAtt = { id: `att${++attSeq}`, tenantId: 't2', entryId: e.id, name: 'سري.pdf', mime: 'application/pdf', size: 50_000, data: PDF, createdBy: 'غيره', createdAt: new Date() };
  atts.push(r);
  return { entryId: e.id, attId: r.id };
}

test('مرفقات حركةٍ قائمة: القائمة بلا البيانات، والملف ببياناته وتخزينٍ خاصّ، ومن شركةٍ أخرى أو حركةٍ أخرى 404', async () => {
  fresh();
  const created = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }], attachments: TWO });
  const id = created.body.data.id as string;
  const list = await call('get', '/entries/:id/attachments', { params: { id } });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual((list.body.data as Row[]).map((m) => [m.name, m.mime, m.size, m.createdBy]), [['فاتورة المورد.jpg', 'image/jpeg', 2048, 'المدير'], ['scan.pdf', 'application/pdf', 50_000, 'المدير']]);
  assert.ok((list.body.data as Row[]).every((m) => !('data' in m)));
  const attId = (list.body.data as Row[])[1].id as string;
  const one = await call('get', '/entries/:id/attachments/:attId', { params: { id, attId } });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.data, { id: attId, name: 'scan.pdf', mime: 'application/pdf', data: PDF });
  assert.equal(one.headers['Cache-Control'], 'private, max-age=3600');
  // العزل: حركة شركةٍ أخرى ومرفقها
  const o = otherTenantEntry();
  assert.equal((await call('get', '/entries/:id/attachments', { params: { id: o.entryId } })).status, 404);
  assert.equal((await call('get', '/entries/:id/attachments/:attId', { params: { id: o.entryId, attId: o.attId } })).status, 404);
  assert.equal((await call('get', '/entries/:id/attachments/:attId', { params: { id, attId: o.attId } })).status, 404, 'مرفقٌ من حركةٍ أخرى');
  assert.equal((await call('get', '/entries/:id/attachments', { params: { id: 'nope' } })).status, 404);
  // وصاحبها يراه
  assert.equal((await call('get', '/entries/:id/attachments/:attId', { params: { id: o.entryId, attId: o.attId }, user: OTHER })).status, 200);
});

test('الملف يُفحص من جديد قبل تقديمه: صفٌّ نوعه المحفوظ يخالف بايتاته أو ليس data URL ⇒ 404 لا يُعاد', async () => {
  fresh();
  const created = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }], attachments: TWO });
  const id = created.body.data.id as string;
  atts[0].mime = 'application/pdf'; // JPEG محفوظٌ بنوع PDF
  atts[1].data = 'javascript:alert(1)';
  for (const a of atts) {
    const r = await call('get', '/entries/:id/attachments/:attId', { params: { id, attId: a.id } });
    assert.equal(r.status, 404, a.id);
    assert.equal(r.body.data, undefined);
  }
});

test('الإضافة لحركةٍ قائمة: 201 بالبيانات الوصفية تحت قفل صفّ الحركة، وسقف العشرة كلُّه أو لا شيء، والفارغ 400، وحركة شركةٍ أخرى 404', async () => {
  fresh();
  const created = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }], attachments: TWO });
  const id = created.body.data.id as string;
  world.calls = [];
  const add = await call('post', '/entries/:id/attachments', { params: { id }, body: { attachments: [{ name: 'a.png', data: PNG }, { name: 'b.webp', data: WEBP }, { name: 'c.jpg', data: JPG }, { name: 'd.pdf', data: PDF }, { name: 'e.png', data: PNG }] } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.deepEqual((add.body.data as Row[]).map((m) => m.name), ['a.png', 'b.webp', 'c.jpg', 'd.pdf', 'e.png']);
  assert.ok((add.body.data as Row[]).every((m) => !('data' in m)));
  const sqls = world.calls.filter((c) => c.op === 'query').map((c) => c.sql ?? '');
  assert.ok(sqls.some((s) => s.includes('FROM warehouse_entries WHERE id') && s.includes('FOR UPDATE')), 'قفل صفّ الحركة');
  assert.equal(atts.filter((a) => a.entryId === id).length, 7);
  // ٧ + ٤ > ١٠ ⇒ رفضٌ كامل برسالة ما يتّسع، ولا شيء يُكتب
  const over = await call('post', '/entries/:id/attachments', { params: { id }, body: { attachments: Array.from({ length: 4 }, (_, k) => ({ name: `o${k}.png`, data: PNG })) } });
  assert.equal(over.status, 400);
  assert.equal(over.body.code, 'ATTACHMENT_INVALID');
  assert.ok((over.body.message as string).includes('3'), over.body.message);
  assert.equal(atts.filter((a) => a.entryId === id).length, 7);
  // ٣ تتّسع حتى العشرة، وبعدها لا شيء
  assert.equal((await call('post', '/entries/:id/attachments', { params: { id }, body: { attachments: Array.from({ length: 3 }, () => ({ name: 'x.png', data: PNG })) } })).status, 201);
  const full = await call('post', '/entries/:id/attachments', { params: { id }, body: { attachments: [{ name: 'x.png', data: PNG }] } });
  assert.equal(full.status, 400);
  assert.ok((full.body.message as string).includes('الحد الأقصى'));
  // فارغ أو غائب أو تالف
  for (const body of [{}, { attachments: [] }, { attachments: [{ name: 'x', data: 'bad' }] }]) {
    const r = await call('post', '/entries/:id/attachments', { params: { id }, body });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'ATTACHMENT_INVALID');
  }
  // حركة شركةٍ أخرى أو غير موجودة
  const o = otherTenantEntry();
  const before = atts.length;
  assert.equal((await call('post', '/entries/:id/attachments', { params: { id: o.entryId }, body: { attachments: [{ name: 'x.png', data: PNG }] } })).status, 404);
  assert.equal((await call('post', '/entries/:id/attachments', { params: { id: 'nope' }, body: { attachments: [{ name: 'x.png', data: PNG }] } })).status, 404);
  assert.equal(atts.length, before);
});

test('الإضافة من جلسة «دخول» المالك تُنسب لـ«الدعم الفني» لا لمدير الشركة', async () => {
  fresh();
  const created = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }] });
  const r = await call('post', '/entries/:id/attachments', { params: { id: created.body.data.id }, body: { attachments: [{ name: 'x.png', data: PNG }] }, user: { ...ADMIN, impersonated: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(atts[0].createdBy, 'الدعم الفني');
});

test('الحذف: حقيقيّ للمرفق وحده (الحركة باقية)، ومرفق شركةٍ أخرى أو حركةٍ أخرى 404 لا يُحذف', async () => {
  fresh();
  const created = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }], attachments: TWO });
  const id = created.body.data.id as string;
  const o = otherTenantEntry();
  assert.equal((await call('delete', '/entries/:id/attachments/:attId', { params: { id: o.entryId, attId: o.attId } })).status, 404);
  assert.equal((await call('delete', '/entries/:id/attachments/:attId', { params: { id, attId: o.attId } })).status, 404);
  assert.ok(atts.some((a) => a.id === o.attId), 'مرفق الشركة الأخرى باقٍ');
  const target = atts.find((a) => a.entryId === id)!.id;
  const del = await call('delete', '/entries/:id/attachments/:attId', { params: { id, attId: target } });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { success: true });
  assert.equal(atts.some((a) => a.id === target), false);
  assert.equal(world.entries.some((e) => e.id === id), true);
  assert.equal((await call('delete', '/entries/:id/attachments/:attId', { params: { id, attId: target } })).status, 404, 'مرّةً ثانية');
});

test('الحرّاس: المندوب 403 والميزة المطفأة 403 على مسارات المرفقات كلها — بحرّاس الموجّه نفسها', async () => {
  fresh();
  const created = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }], attachments: TWO });
  const id = created.body.data.id as string;
  const attId = atts[0].id;
  const routes: [string, string, Row][] = [
    ['get', '/entries/:id/attachments', { params: { id } }],
    ['get', '/entries/:id/attachments/:attId', { params: { id, attId } }],
    ['post', '/entries/:id/attachments', { params: { id }, body: { attachments: [{ name: 'x.png', data: PNG }] } }],
    ['delete', '/entries/:id/attachments/:attId', { params: { id, attId } }],
  ];
  for (const [m, p, req] of routes) {
    assert.equal((await call(m, p, { ...req, user: { id: 'R1', role: 'SALES_REP', tenantId: 't1', name: 'مندوب' } })).status, 403, `${m} ${p} مندوب`);
  }
  world.warehouseEnabled = false;
  for (const [m, p, req] of routes) assert.equal((await call(m, p, req)).status, 403, `${m} ${p} الميزة مطفأة`);
  assert.equal(atts.length, 2, 'لا شيء أُضيف ولا حُذف');
});
