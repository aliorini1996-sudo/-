// البند 7 (مراجعة استيراد البيانات 2026-09-17): التراجع عن دفعة أسعار يستعيد السعر السابق، ولا يمس سعراً تغيّر بعد الاستيراد
// (يدوياً أو بدفعة أحدث) بل يعيده في blocked. منطق صرف بمخزن مزيّف + حراس ثابتة، بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRICE_CHANGED_AFTER_IMPORT, isLockBusyError, newPricesRevertTotals, parseBatchRecordIds, priceRevertAction, priceRevertOutcome, pricesRevertPlan, revertOutcome,
  revertResponse, runPricesRevertChunks, serializeBatchRecordIds,
  type PriceRevertChunkDelta, type RevertBlocked,
} from '../services/importLedger';
import { mergeImportDeltas } from '../services/importChunks';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const EMPTY = { records: [], categories: [], previous: {}, imported: {} };

/** مخزن أسعار مزيّف: id ⇒ السعر */
type Db = Map<string, number>;

/** «استيراد» سعر كما في import.ts: قراءة السابق ثم upsert، والدلتا previous/imported */
function importPrices(db: Db, writes: [string, number][]): string {
  const state = mergeImportDeltas(EMPTY, writes.map(([id, price]) => {
    const previous = db.has(id) ? db.get(id)! : null;
    db.set(id, price);
    return { records: [id], previous: [[id, previous]] as [string, number | null][], imported: [[id, price]] as [string, number][] };
  }));
  return serializeBatchRecordIds('prices', state.records, [], state.previous, state.imported);
}

/** التراجع كما في import.ts: لكل معرّف `priceRevertOutcome` — الدالّة التي ينفّذها المسار نفسه، لا نسخة منها */
function revertPrices(db: Db, recordIds: string) {
  const parsed = parseBatchRecordIds(recordIds);
  const plan = pricesRevertPlan(parsed);
  const done = new Set<string>();
  const blocked: RevertBlocked[] = [];
  let restored = 0; let deleted = 0; let already = 0;
  for (const item of plan.items) {
    const current = db.has(item.id) ? db.get(item.id)! : null;
    const action = priceRevertOutcome(current, item);
    if (action === 'gone') { done.add(item.id); continue; }
    if (action === 'already') { already++; done.add(item.id); continue; }
    if (action === 'blocked') { blocked.push({ id: item.id, name: 'X — P1', reason: PRICE_CHANGED_AFTER_IMPORT }); continue; }
    if (action === 'delete') { db.delete(item.id); deleted++; done.add(item.id); continue; }
    db.set(item.id, action.restore); restored++; done.add(item.id);
  }
  const { remainingIds } = revertOutcome(parsed.records, done);
  return {
    restored, deleted, already, blocked, remainingIds,
    response: revertResponse('prices', restored + deleted, blocked, remainingIds.length, { restored, deleted, alreadyReverted: already }),
  };
}

test('سيناريو البند 7: سعر يدوي 8، استيراد 9 ثم تعديل يدوي 7 ⇒ blocked ولا يُمس السعر؛ بلا تعديل ⇒ يُستعاد 8', () => {
  const db: Db = new Map([['cp1', 8]]);
  const batch = importPrices(db, [['cp1', 9]]);
  db.set('cp1', 7); // تعديل يدوي بعد الاستيراد
  const r = revertPrices(db, batch);
  assert.equal(db.get('cp1'), 7, 'التعديل اليدوي لا يُمحى');
  assert.deepEqual(r.blocked.map((b) => b.reason), [PRICE_CHANGED_AFTER_IMPORT]);
  assert.equal(PRICE_CHANGED_AFTER_IMPORT, 'تغيّر السعر بعد الاستيراد يدوياً أو بدفعة أحدث فلم يُعد');
  assert.deepEqual(r.remainingIds, ['cp1']);
  assert.equal(r.response.reverted, false);
  assert.equal(r.response.remaining, 1);

  const db2: Db = new Map([['cp1', 8]]);
  const batch2 = importPrices(db2, [['cp1', 9]]);
  const r2 = revertPrices(db2, batch2);
  assert.equal(db2.get('cp1'), 8, 'السعر السابق يُستعاد لا يُحذف الصف');
  assert.deepEqual(r2.response, { removed: 1, blocked: 0, remaining: 0, kind: 'prices', reverted: true, restored: 1, deleted: 0, alreadyReverted: 0 });
});

test('دفعتان A(9) ثم B(11) على الزوج: تراجع A ⇒ blocked؛ تراجع B ⇒ 9 ثم A ⇒ 8', () => {
  const db: Db = new Map([['cp1', 8]]);
  const a = importPrices(db, [['cp1', 9]]);
  const b = importPrices(db, [['cp1', 11]]);
  const ra = revertPrices(db, a);
  assert.equal(ra.blocked.length, 1);
  assert.equal(db.get('cp1'), 11, 'تراجع A لا يمحو أسعار B');
  const rb = revertPrices(db, b);
  assert.equal(rb.restored, 1);
  assert.equal(db.get('cp1'), 9);
  const ra2 = revertPrices(db, a);
  assert.equal(ra2.restored, 1);
  assert.equal(db.get('cp1'), 8);
});

test('سعر أُنشئ في الدفعة ⇒ حذف إن بقي كما استُورد، وblocked إن تغيّر، والصف المحذوف مسبقاً منجز', () => {
  const db: Db = new Map();
  const batch = importPrices(db, [['n1', 5], ['n2', 6], ['n3', 7]]);
  db.set('n2', 6.5);
  db.delete('n3');
  const r = revertPrices(db, batch);
  assert.equal(db.has('n1'), false);
  assert.equal(db.get('n2'), 6.5);
  assert.deepEqual([r.deleted, r.restored, r.blocked.length], [1, 0, 1]);
  assert.deepEqual(r.remainingIds, ['n2']);
  // فرق أقل من 1e-9 ليس تغييراً
  assert.equal(priceRevertAction(5 + 1e-12, { id: 'x', previous: null, imported: 5 }), 'delete');
});

test('الدمج: previous أول قيمة وimported آخر قيمة (زوج تكرر في الملف)، والتسلسل مقصور على records', () => {
  const state = mergeImportDeltas(EMPTY, [
    { records: ['cp1'], previous: [['cp1', 8]], imported: [['cp1', 9]] },
    { records: ['cp1'], previous: [['cp1', 9]], imported: [['cp1', 10]] },
  ]);
  assert.deepEqual(state.previous, { cp1: 8 });
  assert.deepEqual(state.imported, { cp1: 10 });
  const saved = serializeBatchRecordIds('prices', ['cp1'], [], { cp1: 8, zz: 1 }, { cp1: 10, zz: 2 });
  assert.equal(saved, '{"records":["cp1"],"previous":{"cp1":8},"imported":{"cp1":10}}');
  assert.deepEqual(parseBatchRecordIds(saved), { records: ['cp1'], categories: [], previous: { cp1: 8 }, imported: { cp1: 10 } });
});

test('الشكل القديم بلا imported: السابق الرقمي يُستعاد والباقي يُحذف كما كان (بلا فحص تغيّر)', () => {
  const legacy = parseBatchRecordIds('{"records":["a","b"],"previous":{"a":8,"b":null}}');
  assert.deepEqual(legacy.imported, {});
  const plan = pricesRevertPlan(legacy);
  assert.deepEqual(plan.items, [{ id: 'a', previous: 8, imported: undefined }, { id: 'b', previous: null, imported: undefined }]);
  assert.deepEqual(priceRevertAction(99, plan.items[0]), { restore: 8 });
  assert.equal(priceRevertAction(99, plan.items[1]), 'delete');
  assert.equal(priceRevertAction(null, plan.items[0]), 'gone');
  const arr = pricesRevertPlan(parseBatchRecordIds('["c"]'));
  assert.deepEqual(arr.items, [{ id: 'c', previous: undefined, imported: undefined }]);
  assert.equal(priceRevertAction(3, arr.items[0]), 'delete');
});

/**
 * البند 7 (متابعة): الشرائح تلتزم كلٌّ في معاملتها، فتقدّمها يُثبَّت داخلها. قبل الإصلاح كان تحديث recordIds بعد
 * الحلقة كلها: فشل شريحة متأخرة (قفل مشغول) يترك الدفعة بمعرّفاتها الأصلية بـprevious/imported الأصلية، فتصير
 * إعادة المحاولة تقارن السعر **المستعاد** بـimported وتبلّغ المالك زوراً «تغيّر السعر بعد الاستيراد».
 */
function revertAttempt(db: Db, stored: string, failOn: string | null, opts: { idempotent?: boolean } = {}) {
  const idempotent = opts.idempotent !== false; // import.ts اليوم (البند I)؛ false = السلوك قبل الإصلاح
  const parsed = parseBatchRecordIds(stored);
  const totals = newPricesRevertTotals();
  let persisted = stored;
  let already = 0;
  const run = runPricesRevertChunks(parsed.records, pricesRevertPlan(parsed).items, totals, async (part, remainingAfter) => {
    // معاملة الشريحة: ترمي ⇒ لا كتابة ولا تثبيت تقدّم (العودة إلى اللقطة)
    if (failOn && part.some((x) => x.id === failOn)) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2028' });
    let chunkAlready = 0;
    const delta: PriceRevertChunkDelta = { done: [], blocked: [], restored: 0, deleted: 0 };
    const chunkDone = delta.done as string[];
    const chunkBlocked = delta.blocked as RevertBlocked[];
    for (const item of part) {
      const current = db.has(item.id) ? db.get(item.id)! : null;
      // البند I: الدالّة التي ينفّذها المسار؛ idempotent=false يعيد سلوك ما قبل الإصلاح (priceRevertAction وحدها)
      const action = idempotent ? priceRevertOutcome(current, item) : priceRevertAction(current, item);
      if (action === 'blocked') { chunkBlocked.push({ id: item.id, name: 'X — P', reason: PRICE_CHANGED_AFTER_IMPORT }); continue; }
      if (action === 'already') { chunkAlready++; chunkDone.push(item.id); continue; }
      if (action === 'delete') { db.delete(item.id); delta.deleted++; }
      else if (action !== 'gone') { db.set(item.id, action.restore); delta.restored++; }
      chunkDone.push(item.id);
    }
    // آخر عبارة قبل الالتزام: المتبقّي وحده بسوابقه ومستورداته
    persisted = serializeBatchRecordIds('prices', remainingAfter(chunkDone), [], parsed.previous, parsed.imported);
    already += chunkAlready; // بعد التزام الشريحة وحده
    return delta;
  }, 1);
  return { run, totals, parsed, stored: () => persisted, already: () => already };
}

test('سيناريو البند 7 (متابعة): شريحة التزمت وأخرى فشلت ⇒ إعادة المحاولة بلا blocked كاذبة وتُوسم reverted', async () => {
  const db: Db = new Map([['cp1', 8], ['cp2', 4]]);
  const batch = importPrices(db, [['cp1', 9], ['cp2', 5]]);
  assert.deepEqual([db.get('cp1'), db.get('cp2')], [9, 5]);

  // المحاولة الأولى: cp1 يُستعاد ويُثبَّت، وشريحة cp2 ترمي
  const first = revertAttempt(db, batch, 'cp2');
  const err = await first.run.then(() => null, (e: unknown) => e);
  assert.ok(err, 'الخطأ يصعد فيُجيب المسار 409');
  assert.equal(isLockBusyError(err), true, 'قفل مشغول ⇒ IMPORT_REVERT_LEDGER_BUSY لا 500');
  assert.equal(db.get('cp1'), 8, 'الشريحة الملتزمة استعادت السعر السابق');
  assert.equal(first.totals.restored, 1, 'ما التُزم لا يضيع من الحصيلة');
  const afterFail = first.stored();
  assert.deepEqual(parseBatchRecordIds(afterFail), { records: ['cp2'], categories: [], previous: { cp2: 4 }, imported: { cp2: 5 } });

  // إعادة المحاولة على ما ثُبّت: لا فحص تغيّر على cp1 المستعاد
  const retry = revertAttempt(db, afterFail, null);
  await retry.run;
  assert.deepEqual(retry.totals.blocked, [], 'blocked كاذبة على سعر استُعيد فعلاً');
  assert.equal(db.get('cp2'), 4);
  const out = revertOutcome(retry.parsed.records, retry.totals.done);
  assert.equal(out.reverted, true, 'الدفعة تُوسم reverted بعد إعادة المحاولة');
  assert.deepEqual(
    revertResponse('prices', retry.totals.restored + retry.totals.deleted, retry.totals.blocked, out.remainingIds.length,
      { restored: retry.totals.restored, deleted: retry.totals.deleted, alreadyReverted: retry.already() }),
    { removed: 1, blocked: 0, remaining: 0, kind: 'prices', reverted: true, restored: 1, deleted: 0, alreadyReverted: 0 },
  );

  // إعادة إنتاج الخلل (قبل البند I): إعادة المحاولة على recordIds الأصلية ⇒ blocked كاذبة أبدية
  const stale = revertAttempt(db, batch, null, { idempotent: false });
  await stale.run;
  assert.deepEqual(stale.totals.blocked.map((b) => [b.id, b.reason]), [['cp1', PRICE_CHANGED_AFTER_IMPORT], ['cp2', PRICE_CHANGED_AFTER_IMPORT]]);
  assert.equal(revertOutcome(parseBatchRecordIds(batch).records, stale.totals.done).reverted, false);

  // البند I: بالتراجع المتعادي تُعدّ «سبق التراجع عنها» وتُوسم الدفعة reverted بدل بقائها عالقة نصف متراجعة
  const idem = revertAttempt(db, batch, null);
  await idem.run;
  assert.deepEqual(idem.totals.blocked, []);
  assert.equal(idem.already(), 2);
  assert.equal(revertOutcome(parseBatchRecordIds(batch).records, idem.totals.done).reverted, true);
  assert.deepEqual([db.get('cp1'), db.get('cp2')], [8, 4], 'لا كتابة ثانية على سعر مستعاد');
});

test('الممنوع يبقى في المتبقّي المثبَّت داخل المعاملة (لا يدخل done)', async () => {
  const db: Db = new Map([['cp1', 8], ['cp2', 4]]);
  const batch = importPrices(db, [['cp1', 9], ['cp2', 5]]);
  db.set('cp1', 7); // تعديل يدوي بعد الاستيراد
  const a = revertAttempt(db, batch, null);
  await a.run;
  assert.equal(db.get('cp1'), 7, 'التعديل اليدوي لا يُمحى');
  assert.deepEqual(parseBatchRecordIds(a.stored()), { records: ['cp1'], categories: [], previous: { cp1: 8 }, imported: { cp1: 9 } });
  assert.equal(a.totals.blocked.length, 1);
});

// ═══ البند I (إغلاقة الدفعة 2): التراجع متعادٍ — انقطاعه في المنتصف لا يترك دفعة عالقة تُمنع أبداً ═══

test('سيناريو البند I: تراجع انقطع بعد استعادة صف ⇒ إعادة المحاولة تتخطّاه (سبق التراجع عنه) لا blocked أبدية', () => {
  const db: Db = new Map([['cp1', 8], ['cp2', 4]]);
  const batch = importPrices(db, [['cp1', 9], ['cp2', 5]]);
  // انقطاع: cp1 أُعيد إلى سعره السابق فعلاً، والدفعة ما زالت بمعرّفيها (نصف متراجعة)
  db.set('cp1', 8);
  const r = revertPrices(db, batch);
  assert.deepEqual(r.blocked, [], 'blocked كاذبة على صف أُعيد فعلاً');
  assert.equal(r.already, 1);
  assert.equal(r.restored, 1, 'cp2 وحده يُستعاد الآن');
  assert.deepEqual([db.get('cp1'), db.get('cp2')], [8, 4]);
  assert.deepEqual(r.remainingIds, []);
  assert.equal(r.response.reverted, true, 'الدفعة تُغلق بدل بقائها عالقة نصف متراجعة');
  assert.equal(r.response.alreadyReverted, 1);
  assert.equal(r.response.removed, 1, 'ما لم تجرِ له كتابة الآن ليس removed');
});

test('البند I: المنع الحقيقي باقٍ — سعر ≠ المستورد و≠ السابق (تعديل يدوي) يبقى blocked ولا يُمس', () => {
  const db: Db = new Map([['cp1', 8]]);
  const batch = importPrices(db, [['cp1', 9]]);
  db.set('cp1', 7);
  const r = revertPrices(db, batch);
  assert.equal(r.already, 0);
  assert.deepEqual(r.blocked.map((b) => b.reason), [PRICE_CHANGED_AFTER_IMPORT]);
  assert.equal(db.get('cp1'), 7);
  assert.deepEqual(r.remainingIds, ['cp1']);
});

test('البند I: الحدّية previous === imported ⇒ استعادة عادية لا «سبق التراجع عنه»، وprevious = null لا يُتخطّى', () => {
  const db: Db = new Map([['cp1', 5]]);
  const batch = importPrices(db, [['cp1', 5], ['n1', 6]]);
  const r = revertPrices(db, batch);
  assert.equal(r.already, 0, 'السعر لم يتغيّر عن المستورد ⇒ استعادة لا تخطٍّ');
  assert.deepEqual([r.restored, r.deleted], [1, 1]);
  assert.equal(db.get('cp1'), 5);
  assert.equal(db.has('n1'), false);
  // إعادة المحاولة على الدفعة نفسها: المستعاد (= السابق = المستورد) والمحذوف كلاهما منتهٍ
  const again = revertPrices(db, batch);
  assert.deepEqual(again.blocked, []);
  assert.equal(again.already, 0);
  assert.equal(again.response.reverted, true);
  // سعر أُنشئ في الدفعة ثم تغيّر يدوياً: previous = null ⇒ لا «سبق التراجع عنه» بل حماية
  const db2: Db = new Map();
  const b2 = importPrices(db2, [['n2', 6]]);
  db2.set('n2', 6.5);
  const r2 = revertPrices(db2, b2);
  assert.equal(r2.already, 0);
  assert.equal(r2.blocked.length, 1);
});

// البند I (الإغلاقة): القرار صار دالّة مصدَّرة واحدة تنفّذها حلقة المسار — فالاختبار ينادي **ما ينفّذه المسار**
// لا نسخة محلّية منه مربوطة بحارس نصّي.
test('سيناريو البند I: priceRevertOutcome — «سبق التراجع عنه» يُفصل عن المنع الحقيقي (الدالّة التي ينفّذها المسار)', () => {
  const item = { id: 'cp1', previous: 8, imported: 9 };
  assert.deepEqual(priceRevertOutcome(9, item), { restore: 8 }, 'سعر كما استُورد ⇒ استعادة السابق');
  assert.equal(priceRevertOutcome(8, item), 'already', 'سعر = السابق ⇒ تراجع انقطع أعاده فعلاً');
  assert.equal(priceRevertOutcome(7, item), 'blocked', 'تعديل يدوي ≠ المستورد و≠ السابق ⇒ منع');
  assert.equal(priceRevertOutcome(null, item), 'gone');
  // أُنشئ في الدفعة (previous = null): يُحذف كما استُورد، ولا «سبق التراجع عنه» إن تغيّر بعده
  assert.equal(priceRevertOutcome(6, { id: 'n1', previous: null, imported: 6 }), 'delete');
  assert.equal(priceRevertOutcome(6.5, { id: 'n1', previous: null, imported: 6 }), 'blocked');
  // الشكل القديم بلا imported: لا فحص تغيّر أصلاً (كما priceRevertAction)
  assert.deepEqual(priceRevertOutcome(99, { id: 'a', previous: 8, imported: undefined }), { restore: 8 });
  assert.equal(priceRevertOutcome(99, { id: 'b', previous: undefined, imported: undefined }), 'delete');
  // الحدّية: فرق ≤ 1e-9 ليس تغييراً، وprevious = imported استعادةٌ عادية لا تخطٍّ
  assert.equal(priceRevertOutcome(8 + 1e-12, item), 'already');
  assert.deepEqual(priceRevertOutcome(9 + 1e-12, item), { restore: 8 });
  assert.deepEqual(priceRevertOutcome(5, { id: 'x', previous: 5, imported: 5 }), { restore: 5 });
  // وما دون فرع blocked يمرّ كما هو من priceRevertAction
  for (const c of [null, 9, 8, 7]) {
    const a = priceRevertAction(c, item);
    if (a !== 'blocked') assert.deepEqual(priceRevertOutcome(c, item), a, String(c));
  }
});

test('حارس ثابت (البند I): فرع «سبق التراجع عنه» في المسار من الدالّة المصدَّرة، والعدّ يُضاف بعد التزام معاملة الشريحة ويُذكر في الرد', () => {
  const src = read('routes/import.ts');
  const rv = src.slice(src.indexOf("router.post('/batches/:id/revert'"));
  const pr = rv.slice(rv.indexOf("} else if (batch.kind === 'prices') {"), rv.indexOf('} else if (batch.kind === OPENING_STOCK_KIND) {'));
  // القرار في دالّة مصدَّرة واحدة يستعملها المسار ويناديها الاختبار بعينها — لا منطق مكرَّر هنا وهناك
  assert.match(pr, /const action = priceRevertOutcome\(row \? Number\(row\.price\) : null, item\)/, 'المسار لا ينادي priceRevertOutcome');
  assert.doesNotMatch(pr, /Math\.abs\(/, 'منطق «سبق التراجع عنه» مكرَّر داخل المسار');
  const already = pr.indexOf("if (action === 'already') {");
  assert.ok(already > 0, 'المسار بلا فرع «سبق التراجع عنه»');
  const skip = pr.indexOf('chunkAlready++', already);
  assert.ok(skip > already && skip < pr.indexOf('chunkDone.push(item.id);', already), 'العدّ خارج فرع already');
  assert.ok(pr.indexOf('}, IMPORT_WRITE_TX);') < pr.indexOf('alreadyReverted += chunkAlready;'), 'العدّ قبل التزام الشريحة');
  const tail = rv.slice(rv.indexOf("if (batch.kind === 'prices') {"));
  assert.match(tail, /revertResponse\(batch\.kind, removed, blocked, out\.remainingIds\.length, \{ restored, deleted, alreadyReverted \}\)/);
});

test('حارس ثابت: فرع الأسعار بمهلة قفل ويجيب 409 عند المزاحمة ويثبّت المتبقّي داخل المعاملة', () => {
  const src = read('routes/import.ts');
  const rv = src.slice(src.indexOf("router.post('/batches/:id/revert'"));
  const pr = rv.slice(rv.indexOf("} else if (batch.kind === 'prices') {"), rv.indexOf('} else if (batch.kind === OPENING_STOCK_KIND) {'));
  assert.match(pr, /SET LOCAL lock_timeout = '5s'/, 'المزاحمة تنتظر مهلة المعاملة كاملة');
  assert.match(pr, /IMPORT_REVERT_LEDGER_BUSY/, 'القفل المشغول يعطي 500 بدل 409');
  assert.match(pr, /isLockBusyError\(e\)/);
  assert.match(pr, /runPricesRevertChunks\(/);
  // التثبيت داخل المعاملة: tx.importBatch.update قبل نهاية معاملة الشريحة
  const upd = pr.indexOf('tx.importBatch.update(');
  assert.ok(upd > 0, 'تقدّم الشريحة يُثبَّت بعد الحلقة كلها');
  assert.ok(upd > pr.indexOf('remainingAfter(chunkDone)'), 'المتبقّي يُحسب قبل الكتابة');
  assert.match(pr.slice(upd, upd + 300), /serializeBatchRecordIds\('prices', remaining, \[\], parsed\.previous, parsed\.imported\)/);
  assert.ok(pr.indexOf("SET LOCAL lock_timeout = '5s'") < pr.indexOf('FOR UPDATE OF cp'), 'المهلة بعد طلب القفل');
});

test('حارس ثابت: /prices يفصل created عن updated، والتراجع يقفل الصف ويطبّق priceRevertAction ويحفظ المتبقي', () => {
  const src = read('routes/import.ts');
  const i = src.indexOf("router.post('/prices'");
  const body = src.slice(i, src.indexOf('\n});', i));
  assert.match(body, /imported: \[\[w\.id, w\.price\]\]/);
  assert.match(body, /result\.created\+\+/);
  assert.match(body, /result\.updated = \(result\.updated \?\? 0\) \+ 1/);
  assert.doesNotMatch(body, /result\.created \+= written\.length/, 'created يشمل المستبدل');
  const rv = src.slice(src.indexOf("router.post('/batches/:id/revert'"));
  const pr = rv.slice(rv.indexOf("} else if (batch.kind === 'prices') {"), rv.indexOf('} else if (batch.kind === OPENING_STOCK_KIND) {'));
  let pos = -1;
  for (const n of ['pricesRevertPlan(parsed)', 'prisma.$transaction(async tx => {', 'FOR UPDATE', 'priceRevertOutcome(', 'PRICE_CHANGED_AFTER_IMPORT', 'tx.customerPrice.deleteMany(', 'tx.customerPrice.updateMany(']) {
    const k = pr.indexOf(n, pos + 1);
    assert.ok(k > pos, `تراجع الأسعار: ${n} خارج الترتيب`);
    pos = k;
  }
  assert.doesNotMatch(pr, /prisma\.customerPrice\.deleteMany\(/, 'حذف خارج المعاملة بلا فحص');
  // الممنوع يبقى في الدفعة بسوابقه ومستورداته (reverted:false) فيُعاد التراجع عنه بعد المراجعة
  const tail = rv.slice(rv.indexOf("if (batch.kind === 'prices') {"));
  assert.ok(tail.length > 0, 'لا فرع نتيجة لدفعة الأسعار');
  assert.match(tail, /const out = revertOutcome\(ids, done\)/);
  assert.match(tail, /serializeBatchRecordIds\(batch\.kind, out\.remainingIds, \[\], parsed\.previous, parsed\.imported\)/);
  assert.match(tail, /revertResponse\(batch\.kind, removed, blocked, out\.remainingIds\.length, \{ restored, deleted, alreadyReverted \}\)/);
});
