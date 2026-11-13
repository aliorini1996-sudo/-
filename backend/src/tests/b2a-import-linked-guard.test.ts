// «ربط الدفاتر» L0/L1 — استيراد المخزون الافتتاحي (routes/import.ts) فوق القاعدة المزيّفة lots-b3-fake.ts (بلا قاعدة بيانات):
//   • حركة الاستيراد تُكتب بمصدرها source = 'OPENING_IMPORT' (لا يُعرف الافتتاحي من نصّ ملاحظته بعد اليوم).
//   • التراجع عنه في الشركة المربوطة ⇒ 409 BOOKS_LINKED_NO_DELETE قبل الحلقة، وتحت قفل gl-post ثانيةً (ربطٌ التزم بين القراءتين)،
//     بلا حذف شيء. واليدوية كما كانت (يُتراجع)، والطريقة القديمة المفعّلة كما كانت (OPENING_STOCK_REVERT_LEDGER_ACTIVE).
//   • coupledActivatedAt بدالّة الوضع (isManualBooks) لا بمقارنة حرفية.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { World, type Row } from './lots-b3-fake';
import { LINKED_NO_DELETE_CODE, LINKED_NO_DELETE_MESSAGE } from '../services/booksMode';
import { ImportHttpError } from '../services/importLedger';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const world = new World();
const db = world.db;
stub('config/database', { default: db });
db.stockZeroRun = { findFirst: async () => null };

/* eslint-disable @typescript-eslint/no-var-requires */
const importRoutes = require('../routes/import') as typeof import('../routes/import');
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };
const LINKED = { setupMethod: 'LINKED', activatedAt: new Date('2026-11-01T00:00:00Z') };
const CLEAN = { setupMethod: 'CLEAN', activatedAt: new Date('2026-01-01T00:00:00Z') };
const LEGACY = { setupMethod: 'OPENING', activatedAt: new Date('2026-01-01T00:00:00Z') };

/** إعدادات الدفاتر بالترتيب: القراءة رقم i ترى books[min(i, آخر)] — لمحاكاة ربطٍ التزم بين القراءتين */
let booksSeq: Array<Row | null> = [null];
let bookReads = 0;
db.glSettings = {
  findUnique: async () => {
    world.calls.push({ op: 'glSettings.findUnique' });
    const s = booksSeq[Math.min(bookReads, booksSeq.length - 1)];
    bookReads++;
    return s;
  },
};

function fresh(): void {
  Object.assign(world, new World());
  world.lotsEnabled = false;
  for (const [id, code, name] of [['p1', 'A-1', 'ماء'], ['p2', 'B-2', 'حليب']]) world.product({ id, code, name });
  booksSeq = [null];
  bookReads = 0;
}

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }
async function call(method: string, p: string, req: Row = {}): Promise<{ status: number; body: Row }> {
  const stack = (importRoutes.default as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === p && l.route.methods[method]);
  assert.ok(layer, `${method} ${p} مفقود`);
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { method: method.toUpperCase(), query: {}, params: {}, body: {}, headers: {}, user: ADMIN, ...req };
  let err: unknown = null;
  for (const h of [...pre, ...layer!.route!.stack.map((l) => l.handle)]) {
    let passed = false;
    await h(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err || !passed) break;
  }
  if (err) throw err;
  return { status: res.statusCode, body: res.body };
}

async function importOpening(): Promise<string> {
  const r = await call('post', '/opening-stock', { body: { rows: [{ productCode: 'A-1', qty: 4, unitCost: 2 }, { productCode: 'B-2', qty: 5, unitCost: 3 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.created, 2);
  return r.body.data.batchId as string;
}
const revert = (batchId: string) => call('post', '/batches/:id/revert', { params: { id: batchId } });

test('الاستيراد: حركة المخزون الافتتاحي تُكتب بمصدرها OPENING_IMPORT في إنشائها نفسه', async () => {
  fresh();
  await importOpening();
  const creates = world.calls.filter((c) => c.op === 'warehouseEntry.create');
  assert.equal(creates.length, 1);
  const data = (creates[0] as Row).args.data;
  assert.equal(data.source, 'OPENING_IMPORT');
  assert.equal(data.type, 'RECEIVE');
  assert.equal(world.entries.length, 1);
});

test('التراجع في الشركة المربوطة ⇒ 409 BOOKS_LINKED_NO_DELETE قبل الحلقة — لا معاملة ولا حذف، والدفعة باقية', async () => {
  fresh();
  const batchId = await importOpening();
  booksSeq = [LINKED];
  bookReads = 0;
  world.calls.length = 0;
  const r = await call('post', '/batches/:id/revert', { params: { id: batchId } }).catch((e) => e);
  // الخطأ يمرّ بـsendImportError ⇒ 409 بجسم الرمز
  const status = r instanceof ImportHttpError ? r.status : r.status;
  const body = r instanceof ImportHttpError ? { code: r.code, message: r.message } : r.body;
  assert.equal(status, 409, JSON.stringify(body));
  assert.deepEqual([body.code, body.message], [LINKED_NO_DELETE_CODE, LINKED_NO_DELETE_MESSAGE]);
  assert.ok(!world.calls.some((c) => c.op === 'tx.begin'), 'لا معاملة');
  assert.ok(!world.calls.some((c) => /deleteMany$/.test(c.op)), 'لا حذف');
  assert.equal(world.entries.length, 1);
  assert.equal(world.batches.find((b) => b.id === batchId)?.reverted, false);
});

test('التراجع: ربطٌ التزم بين القراءة الأولى والمعاملة ⇒ الحارس تحت قفل gl-post يرفض 409 وتُلغى المعاملة بلا حذف', async () => {
  fresh();
  const batchId = await importOpening();
  booksSeq = [null, LINKED];
  bookReads = 0;
  world.calls.length = 0;
  const r = await revert(batchId).catch((e) => e);
  const status = r instanceof ImportHttpError ? r.status : r.status;
  const code = r instanceof ImportHttpError ? r.code : r.body.code;
  assert.deepEqual([status, code], [409, 'BOOKS_LINKED_NO_DELETE']);
  const ops = world.calls.map((c) => c.op);
  const begin = ops.indexOf('tx.begin');
  const lock = world.calls.findIndex((c) => c.op === 'exec' && /pg_advisory_xact_lock/.test(String((c as Row).sql ?? '')));
  assert.ok(begin > 0 && ops.lastIndexOf('glSettings.findUnique') > begin, ops.join(' → '));
  if (lock >= 0) assert.ok(lock < ops.lastIndexOf('glSettings.findUnique'), 'الحارس بعد قفل gl-post');
  assert.ok(ops.includes('tx.rollback'));
  assert.ok(!ops.some((o) => /deleteMany$/.test(o)), 'لا حذف');
  assert.equal(world.entries.length, 1);
});

test('التراجع: اليدوية (CLEAN) وبلا دفاتر كما كان — يُتراجع؛ والطريقة القديمة المفعّلة ⇒ الرمز القائم كما كان', async () => {
  for (const books of [null, CLEAN, { ...LINKED, activatedAt: null }]) {
    fresh();
    const batchId = await importOpening();
    booksSeq = [books];
    bookReads = 0;
    const r = await revert(batchId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.reverted, true, JSON.stringify(books));
    assert.equal(world.entries.length, 0);
  }
  fresh();
  const batchId = await importOpening();
  booksSeq = [LEGACY];
  bookReads = 0;
  const r = await revert(batchId).catch((e) => e);
  const code = r instanceof ImportHttpError ? r.code : r.body.code;
  assert.equal(code, 'OPENING_STOCK_REVERT_LEDGER_ACTIVE');
  assert.equal(world.entries.length, 1);
});

test('assertOpeningStockRevertNotLinked: المربوطة المفعّلة وحدها ترمي 409 BOOKS_LINKED_NO_DELETE', () => {
  const f = importRoutes.assertOpeningStockRevertNotLinked;
  for (const s of [null, undefined, CLEAN, LEGACY, { setupMethod: 'LINKED', activatedAt: null }, { setupMethod: 'FULL_HISTORY', activatedAt: new Date() }]) {
    assert.doesNotThrow(() => f(s as never), JSON.stringify(s));
  }
  assert.throws(() => f(LINKED), (e: unknown) => e instanceof ImportHttpError && e.status === 409 && e.code === LINKED_NO_DELETE_CODE && e.message === LINKED_NO_DELETE_MESSAGE);
});

test('حارس ثابت: وضع الدفاتر في import.ts بدالّة الوضع — لا مقارنة حرفية بـCLEAN، والحارسان قبل الحلقة وتحت القفل قبل FOR UPDATE', () => {
  const raw = fs.readFileSync(path.join(SRC, 'routes', 'import.ts'), 'utf8').replace(/\r\n/g, '\n');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /setupMethod\s*[!=]==\s*'CLEAN'/, 'مقارنة حرفية بـCLEAN');
  assert.match(code, /s\?\.activatedAt && !isManualBooks\(s\) \? s\.activatedAt : null/);
  const start = code.indexOf('} else if (batch.kind === OPENING_STOCK_KIND) {');
  const branch = code.slice(start, code.indexOf("if (batch.kind === 'customers' || batch.kind === 'products' || batch.kind === OPENING_STOCK_KIND)", start));
  const order = [
    'assertOpeningStockRevertNotLinked(revertBooks)', 'assertOpeningStockRevertAllowed(coupledActivatedAt(revertBooks))', 'for (const eid of ids)',
    'acquirePostLock(tx, tid)', 'assertOpeningStockRevertNotLinked(booksNow)', 'assertOpeningStockRevertAllowed(coupledActivatedAt(booksNow))', 'FOR UPDATE',
  ];
  let at = -1;
  for (const p of order) { const i = branch.indexOf(p, at + 1); assert.ok(i > at, `«${p}» غائب أو خارج الترتيب`); at = i; }
  // ومصدر حركة الاستيراد في الإنشاء الوحيد للمسار
  const handler = code.slice(code.indexOf("router.post('/opening-stock'"));
  const create = handler.slice(handler.indexOf('tx.warehouseEntry.create('), handler.indexOf('tx.importBatch.create('));
  assert.match(create, /source: 'OPENING_IMPORT' satisfies WarehouseEntrySource/);
});
