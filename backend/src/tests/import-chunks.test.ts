// البند 6 (مراجعة استيراد البيانات 2026-09-17): معرّفات القيود تُسجَّل في معاملة كتابتها نفسها. منفّذ معاملات مزيّف بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  importChunkTarget, mergeImportDeltas, mergeImportProgress, planImportChunks, runImportChunks,
} from '../services/importChunks';
import { IMPORT_FLUSH_EVERY_ROWS, importFlushDue } from '../services/importLedger';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/** مخزن: القيود ومعرّفات الدفعة تُلتزم معاً أو لا */
class FakeDb {
  entries: { id: string; key: string }[] = [];
  recordIds: string[] = [];
  private seq = 0;
  async tx<X>(fn: (tx: FakeTx) => Promise<X>): Promise<X> {
    const t: FakeTx = { entries: [...this.entries], recordIds: [...this.recordIds], newId: () => `e${++this.seq}` };
    const out = await fn(t);
    this.entries = t.entries;
    this.recordIds = t.recordIds;
    return out;
  }
}
interface FakeTx { entries: { id: string; key: string }[]; recordIds: string[]; newId: () => string }

class Crash extends Error {}

/** استيراد 130 قيداً (عنصر = قيد) بالمنطق الجديد؛ crashAfterCommits ⇒ انقطاع الخادم بعد عدد التزامات */
async function importNew(db: FakeDb, keys: readonly string[], crashAfterCommits = Infinity) {
  const committed: string[] = [];
  let commits = 0;
  await runImportChunks<string, string, FakeTx>({
    chunks: planImportChunks(keys, () => 1, importChunkTarget(keys.length)),
    runTx: (fn) => {
      if (commits >= crashAfterCommits) throw new Crash('restart');
      return db.tx(fn);
    },
    writeItem: async (tx, key) => { const id = tx.newId(); tx.entries.push({ id, key }); return id; },
    flush: async (tx, written) => { tx.recordIds = mergeImportDeltas({ records: committed, categories: [], previous: {} }, written.map((w) => ({ records: [w.result] }))).records; },
    onCommitted: (written) => { commits++; committed.push(...written.map((w) => w.result)); },
    onItemError: (_k, e) => { throw e; },
    isFatal: (e) => e instanceof Crash,
  });
}

/** المنطق القديم: الحفظ حين يحين (كل 50 قيداً)، ومعاملة لكل قيد */
async function importOld(db: FakeDb, keys: readonly string[], crashAfterRows: number) {
  const ids: string[] = [];
  let flushed = 0;
  for (let i = 0; i < keys.length; i++) {
    if (i >= crashAfterRows) throw new Crash('restart');
    await db.tx(async (tx) => {
      const id = tx.newId();
      tx.entries.push({ id, key: keys[i] });
      if (importFlushDue({ pending: ids.length + 1 - flushed, lastFlushAt: Date.now(), now: Date.now() })) { tx.recordIds = [...ids, id]; flushed = ids.length + 1; }
      ids.push(id);
    });
  }
}

/** التراجع: يحذف المسجَّل وحده */
function revert(db: FakeDb) {
  const rec = new Set(db.recordIds);
  db.entries = db.entries.filter((e) => !rec.has(e.id));
  db.recordIds = [];
}

const KEYS = Array.from({ length: 130 }, (_, i) => `row-${i + 1}`);

test('هدف الشريحة max(50, ceil(الإجمالي/100))، والتجميع جشع والعنصر الكبير وحده', () => {
  assert.equal(importChunkTarget(0), 50);
  assert.equal(importChunkTarget(130), 50);
  assert.equal(importChunkTarget(20_000), 200);
  assert.deepEqual(planImportChunks(KEYS, () => 1, 50).map((c) => c.length), [50, 50, 30]);
  assert.deepEqual(planImportChunks([10, 45, 5, 80, 20, 30, 1], (n) => n, 50), [[10], [45, 5], [80], [20, 30], [1]]);
  assert.deepEqual(planImportChunks([], () => 1, 50), []);
});

test('سيناريو البند 6: 130 قيداً ثم انقطاع بعد التزام شريحة ⇒ المسجَّل = الملتزم تماماً، والتراجع ثم إعادة الرفع 130 لا 160', async () => {
  // قبل الإصلاح (الحفظ كل 50): انقطاع بعد 80 قيداً يترك 30 يتيماً ⇒ 160 بعد التراجع وإعادة الرفع
  const old = new FakeDb();
  await assert.rejects(importOld(old, KEYS, 80), Crash);
  assert.equal(old.entries.length, 80);
  assert.equal(old.recordIds.length, IMPORT_FLUSH_EVERY_ROWS);
  revert(old);
  await importOld(old, KEYS, Infinity);
  assert.equal(old.entries.length, 160, 'المنطق القديم يضاعف 30 قيداً');

  const db = new FakeDb();
  await assert.rejects(importNew(db, KEYS, 1), Crash);
  assert.equal(db.entries.length, 50, 'شريحة واحدة ملتزمة');
  assert.deepEqual([...db.recordIds].sort(), db.entries.map((e) => e.id).sort(), 'المسجَّل = الملتزم');
  revert(db);
  assert.equal(db.entries.length, 0, 'لا قيد يتيم بعد التراجع');
  await importNew(db, KEYS);
  assert.equal(db.entries.length, 130);
  assert.equal(new Set(db.entries.map((e) => e.key)).size, 130);
  assert.deepEqual([...db.recordIds].sort(), db.entries.map((e) => e.id).sort());
});

test('فشل عنصر داخل شريحة ⇒ إعادة البقية فرادى وخطأ للعنصر وحده، ولا أثر للشريحة الفاشلة', async () => {
  const db = new FakeDb();
  const committed: string[] = [];
  const errors: string[] = [];
  let chunkTxs = 0;
  await runImportChunks<string, string, FakeTx>({
    chunks: planImportChunks(KEYS, () => 1, 50),
    runTx: (fn) => { chunkTxs++; return db.tx(fn); },
    writeItem: async (tx, key) => {
      if (key === 'row-77') throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      const id = tx.newId(); tx.entries.push({ id, key }); return id;
    },
    flush: async (tx, written) => { tx.recordIds = [...committed, ...written.map((w) => w.result)]; },
    onCommitted: (written) => { committed.push(...written.map((w) => w.result)); },
    onItemError: (k) => { errors.push(k); },
  });
  assert.deepEqual(errors, ['row-77']);
  assert.equal(db.entries.length, 129);
  assert.ok(!db.entries.some((e) => e.key === 'row-77'));
  assert.deepEqual([...db.recordIds].sort(), db.entries.map((e) => e.id).sort());
  // 3 شرائح + 50 إعادة منفردة للشريحة الثانية
  assert.equal(chunkTxs, 3 + 50);
});

test('دمج التقدّم: المعرّفات بلا تكرار، والفئات، وأول سعر سابق وحده', () => {
  const base = { records: ['a'], categories: ['c1'], previous: { a: 5 } };
  const m = mergeImportProgress(base, { records: ['a', 'b'], categories: ['c1', 'c2'], previous: [['a', 9], ['b', null]] });
  assert.deepEqual(m, { records: ['a', 'b'], categories: ['c1', 'c2'], previous: { a: 5, b: null } });
  assert.deepEqual(base, { records: ['a'], categories: ['c1'], previous: { a: 5 } }, 'الأساس لا يتغير');
  assert.deepEqual(mergeImportDeltas(base, [{ previous: [['x', 1]] }, { records: ['x'], previous: [['x', 2]] }]).previous, { a: 5, x: 1 });
});

test('حارس ثابت: لا حفظ مشروط بـdue في مسارات الكتابة، وكل مسار يكتب بـrunImportChunks ويسجّل في flush', () => {
  const src = read('routes/import.ts');
  assert.doesNotMatch(src, /progress\.due\(/);
  assert.doesNotMatch(src, /class EntryBatchProgress/);
  for (const m of ["router.post('/customers'", "router.post('/products'", "router.post('/balances'", "router.post('/ledger'", "router.post('/prices'"]) {
    const i = src.indexOf(m);
    const body = src.slice(i, src.indexOf('\n});', i));
    const run = body.indexOf('runImportChunks(');
    assert.ok(run > 0, `${m}: بلا runImportChunks`);
    assert.match(body, /runTx: <X>\(fn: \(tx: Prisma\.TransactionClient\) => Promise<X>\) => prisma\.\$transaction\(async tx => fn\(tx\), IMPORT_WRITE_TX\)/, m);
    assert.match(body, /flush: \(tx, written\) => progress\.write\(tx, /, m);
    assert.match(body, /\} finally \{\s*result\.batchId = await progress\.finish\(\);/, m);
  }
  assert.match(src, /const IMPORT_WRITE_TX = \{ maxWait: 10_000, timeout: 60_000 \};/);
});
