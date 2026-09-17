// البنود 20 و1 و14 (مراجعة استيراد البيانات 2026-09-17): حجز دفعات العملاء والمنتجات والأسعار، واستعادة الأسعار السابقة،
// والسعر الخاص الصفري، ونسبة الضريبة الكسرية. منطق صرف وحراس ثابتة بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPORT_IN_PROGRESS_MESSAGE, IMPORT_MASTER_KINDS, IMPORT_ROW_MESSAGES, IMPORT_RUNNING_STALE_MS, ImportHttpError, assertMasterBatchReservable, importContentHash,
  importRowError, parseBatchRecordIds, priceRowIssue, pricesRevertPlan, serializeBatchRecordIds, taxPctIssue,
} from '../services/importLedger';
import { mergeImportDeltas } from '../services/importChunks';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const NOW = new Date('2026-09-17T10:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

test('سيناريو البند 20(ب): الملف نفسه من تبويبين ⇒ 409 IMPORT_DUPLICATE_BATCH (أو IMPORT_IN_PROGRESS مع force) للأنواع الثلاثة', () => {
  for (const kind of IMPORT_MASTER_KINDS) {
    const rows = [{ code: 'C1', name: 'مشروبات' }];
    const hash = importContentHash(kind, rows);
    assert.notEqual(hash, importContentHash(kind === 'customers' ? 'products' : 'customers', rows), 'البصمة بالنوع');
    const running = { id: `b-${kind}`, kind, createdAt: ago(20_000), status: 'running', heartbeatAt: ago(5_000) };
    // التبويب الثاني: البصمة تطابق الدفعة الجارية
    assert.throws(() => assertMasterBatchReservable(kind, running, [running], false, NOW), (e: unknown) => {
      assert.ok(e instanceof ImportHttpError);
      assert.deepEqual([e.status, e.code, e.details.batchId, e.details.running], [409, 'IMPORT_DUPLICATE_BATCH', `b-${kind}`, true]);
      return true;
    });
    // force يتجاوز البصمة لا الدفعة الجارية من النوع نفسه
    assert.throws(() => assertMasterBatchReservable(kind, running, [running], true, NOW), (e: unknown) => {
      assert.ok(e instanceof ImportHttpError);
      assert.deepEqual([e.status, e.code, e.message], [409, 'IMPORT_IN_PROGRESS', IMPORT_IN_PROGRESS_MESSAGE]);
      assert.deepEqual(e.details, { batchId: `b-${kind}`, kind, createdAt: running.createdAt.toISOString() });
      return true;
    });
    // ملف مختلف أثناء استيراد جارٍ من النوع نفسه ⇒ IMPORT_IN_PROGRESS
    assert.throws(() => assertMasterBatchReservable(kind, null, [running], false, NOW), (e: unknown) => e instanceof ImportHttpError && e.code === 'IMPORT_IN_PROGRESS');
    // نوع آخر جارٍ لا يمنع، والمنقطع لا يمنع، والمنتهي بالبصمة يمنع ما لم يُرسل force
    const other = { ...running, kind: kind === 'prices' ? 'products' : 'prices' };
    assert.doesNotThrow(() => assertMasterBatchReservable(kind, null, [other], false, NOW));
    const stale = { ...running, heartbeatAt: ago(IMPORT_RUNNING_STALE_MS + 1) };
    assert.doesNotThrow(() => assertMasterBatchReservable(kind, null, [stale], false, NOW));
    const done = { id: 'old', createdAt: ago(86_400_000), status: 'done', heartbeatAt: null };
    assert.throws(() => assertMasterBatchReservable(kind, done, [], false, NOW), (e: unknown) => e instanceof ImportHttpError && e.code === 'IMPORT_DUPLICATE_BATCH' && e.details.running === undefined);
    assert.doesNotThrow(() => assertMasterBatchReservable(kind, done, [], true, NOW));
  }
  assert.doesNotMatch(IMPORT_IN_PROGRESS_MESSAGE, /أرصدة أو كشوف/, 'الرسالة عامة');
});

test('سيناريو البند 20(أ): recordIds للأسعار {records, previous} ذهاباً وإياباً، والشكل القديم previous={}، وخطة التراجع', () => {
  // دفعة: cp1 كان 12.5 ثم كُتب مرتين (يبقى أول سابق)، cp2 أُنشئ جديداً
  const state = mergeImportDeltas({ records: [], categories: [], previous: {} }, [
    { records: ['cp1'], previous: [['cp1', 12.5]] },
    { records: ['cp2'], previous: [['cp2', null]] },
    { records: ['cp1'], previous: [['cp1', 9]] },
  ]);
  const saved = serializeBatchRecordIds('prices', state.records, [], state.previous);
  assert.equal(saved, '{"records":["cp1","cp2"],"previous":{"cp1":12.5,"cp2":null}}');
  const parsed = parseBatchRecordIds(saved);
  assert.deepEqual(parsed, { records: ['cp1', 'cp2'], categories: [], previous: { cp1: 12.5, cp2: null } });
  assert.deepEqual(pricesRevertPlan(parsed), { restore: [{ id: 'cp1', price: 12.5 }], remove: ['cp2'] });
  // الشكل القديم (مصفوفة) ⇒ حذف كما كان
  const legacy = parseBatchRecordIds('["cp1","cp2"]');
  assert.deepEqual(legacy.previous, {});
  assert.deepEqual(pricesRevertPlan(legacy), { restore: [], remove: ['cp1', 'cp2'] });
  // السعر السابق صفر يُستعاد لا يُحذف، والقيم التالفة تُهمل
  assert.deepEqual(pricesRevertPlan(parseBatchRecordIds('{"records":["a","b"],"previous":{"a":0,"b":"x"}}')), { restore: [{ id: 'a', price: 0 }], remove: ['b'] });
  // الأنواع الأخرى لا تتغير
  assert.equal(serializeBatchRecordIds('customers', ['c1']), '["c1"]');
  assert.equal(serializeBatchRecordIds('ledger', ['e1']), '["e1"]');
});

test('سيناريو البند 1 (الخادم): السعر الخاص صفر بلا إقرار ⇒ ZERO_PRICE، ومع allowZeroPrice يمر؛ والبصمة لا تشمل الإقرار', () => {
  assert.equal(priceRowIssue(0, false), 'ZERO_PRICE');
  assert.equal(priceRowIssue(0, true), null);
  assert.equal(priceRowIssue(12, false), null);
  assert.deepEqual(importRowError(4, 'ZERO_PRICE'), { row: 4, code: 'ZERO_PRICE', message: 'السعر الخاص صفر، أكّد في المعاينة أنه مقصود' });
  const src = read('routes/import.ts');
  const i = src.indexOf("router.post('/prices'");
  const body = src.slice(i, src.indexOf('\n});', i));
  assert.match(body, /priceRowIssue\(r\.price, body\.allowZeroPrice === true\)/);
  assert.match(body, /importContentHash\('prices', rows\)/, 'البصمة للصفوف وحدها');
  assert.match(src, /allowZeroPrice: z\.boolean\(\)\.optional\(\)/);
  assert.ok(body.indexOf('priceRowIssue(') < body.indexOf('runImportChunks('));
});

test('سيناريو البند 14: taxPct غير صفري أقل من 1 (خلية 15% ⇒ 0.15) ⇒ TAX_PCT_FRACTION، والصفر و15 مقبولان', () => {
  assert.equal(taxPctIssue(0.15), 'TAX_PCT_FRACTION');
  assert.equal(taxPctIssue(0.5), 'TAX_PCT_FRACTION');
  assert.equal(taxPctIssue(0), null);
  assert.equal(taxPctIssue(1), null);
  assert.equal(taxPctIssue(15), null);
  assert.equal(taxPctIssue(undefined), null);
  assert.equal(IMPORT_ROW_MESSAGES.TAX_PCT_FRACTION, 'نسبة الضريبة أقل من 1٪، اكتبها نسبة مئوية (15 لا 0.15)');
  const src = read('routes/import.ts');
  const i = src.indexOf("router.post('/products'");
  const body = src.slice(i, src.indexOf('\n});', i));
  assert.match(body, /const taxIssue = taxPctIssue\(r\.taxPct\);/);
  assert.ok(body.indexOf('taxPctIssue(') < body.indexOf('tx.product.create('));
});

test('حارس ثابت: /customers و/products و/prices تحجز reserveMasterBatch قبل أول create/upsert، ولا recordBatch بعد الحلقة', () => {
  const src = read('routes/import.ts');
  assert.doesNotMatch(src, /recordBatch\(/, 'التسجيل بعد الحلقة');
  const fn = src.slice(src.indexOf('async function reserveMasterBatch('), src.indexOf('\n}\n', src.indexOf('async function reserveMasterBatch(')));
  let pos = -1;
  for (const n of ['prisma.$transaction(async tx => {', "SET LOCAL lock_timeout = '5s'", 'pg_advisory_xact_lock(hashtext(${IMPORT_MASTER_LOCK_PREFIX + kind + \':\' + tid}::text))',
    'tx.importBatch.findFirst(', 'tx.importBatch.findMany(', 'assertMasterBatchReservable(kind, dup, running, force, now)', 'tx.importBatch.create(', 'status: IMPORT_BATCH_RUNNING, heartbeatAt: now']) {
    const i = fn.indexOf(n, pos + 1);
    assert.ok(i > pos, `reserveMasterBatch: ${n} خارج الترتيب`);
    pos = i;
  }
  assert.match(fn, /catch \(e\) \{\s*if \(!isImportHttpError\(e\) && isLockBusyError\(e\)\) throw new ImportHttpError\(409, 'IMPORT_LEDGER_BUSY', LEDGER_BUSY_MESSAGE\);\s*throw e;/);
  assert.match(src, /const IMPORT_MASTER_LOCK_PREFIX = 'import-master:';/);
  const kinds: [string, string, string][] = [
    ["router.post('/customers'", 'customers', 'tx.customer.create('],
    ["router.post('/products'", 'products', 'tx.productCategory.create('],
    ["router.post('/prices'", 'prices', 'tx.customerPrice.upsert('],
  ];
  for (const [m, kind, write] of kinds) {
    const i = src.indexOf(m);
    const body = src.slice(i, src.indexOf('\n});', i));
    const reserve = body.indexOf(`reserveMasterBatch(tid, '${kind}', importContentHash('${kind}', rows), importedBy(req), body.force === true)`);
    assert.ok(reserve > 0, `${m}: بلا reserveMasterBatch`);
    assert.ok(reserve < body.indexOf(write), `${m}: الحجز بعد الكتابة`);
    assert.doesNotMatch(body, /prisma\.(customer|product|productCategory|customerPrice)\.(create|upsert)\(/, `${m}: كتابة خارج المعاملة`);
    assert.match(body, /onItemError: \([^)]*\) => \{ result\.errors\.push\(importWriteFailure\(/, `${m}: P2002 خام`);
  }
  // الفئات بالاسم المطبَّع
  const pi = src.indexOf("router.post('/products'");
  const products = src.slice(pi, src.indexOf('\n});', pi));
  assert.match(products, /const key = normImportName\(c\.name\); if \(key && !catByName\.has\(key\)\) catByName\.set\(key, c\.id\);/);
  assert.match(products, /const key = normImportName\(catName\);/);
  // التراجع عن الأسعار: الاستعادة ثم الحذف، والدفعة الجارية مرفوضة قبلها
  const rv = src.slice(src.indexOf("router.post('/batches/:id/revert'"));
  const pr = rv.slice(rv.indexOf("} else if (batch.kind === 'prices') {"), rv.indexOf('} else if (batch.kind === OPENING_STOCK_KIND) {'));
  assert.match(pr, /pricesRevertPlan\(parsed\)/);
  assert.ok(pr.indexOf('tx.customerPrice.updateMany(') < pr.indexOf('prisma.customerPrice.deleteMany('));
  assert.ok(rv.indexOf('assertBatchRevertible(batch, new Date())') < rv.indexOf('pricesRevertPlan('));
});
