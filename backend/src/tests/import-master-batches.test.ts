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
// البند 39: قاعدة «أقصى تاريخ أثر مقبول» الوحيدة في المنظومة — المسار يستدعيها نفسها
import { IMPORT_FUTURE_DATE_GRACE_DAYS, isImportDateTooFarAhead, maxImportEntryDate } from '../services/gl/opening';

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

test('سيناريو البند 20(أ): recordIds للأسعار {records, previous, imported} ذهاباً وإياباً، والشكل القديم previous={}، وخطة التراجع', () => {
  // دفعة: cp1 كان 12.5 ثم كُتب مرتين (يبقى أول سابق وآخر مستورد)، cp2 أُنشئ جديداً
  const state = mergeImportDeltas({ records: [], categories: [], previous: {}, imported: {} }, [
    { records: ['cp1'], previous: [['cp1', 12.5]], imported: [['cp1', 9]] },
    { records: ['cp2'], previous: [['cp2', null]], imported: [['cp2', 4]] },
    { records: ['cp1'], previous: [['cp1', 9]], imported: [['cp1', 13]] },
  ]);
  const saved = serializeBatchRecordIds('prices', state.records, [], state.previous, state.imported);
  assert.equal(saved, '{"records":["cp1","cp2"],"previous":{"cp1":12.5,"cp2":null},"imported":{"cp1":13,"cp2":4}}');
  const parsed = parseBatchRecordIds(saved);
  assert.deepEqual(parsed, { records: ['cp1', 'cp2'], categories: [], previous: { cp1: 12.5, cp2: null }, imported: { cp1: 13, cp2: 4 } });
  assert.deepEqual(pricesRevertPlan(parsed).items, [
    { id: 'cp1', previous: 12.5, imported: 13 }, { id: 'cp2', previous: null, imported: 4 },
  ]);
  // الشكل القديم (مصفوفة) ⇒ حذف كما كان
  const legacy = parseBatchRecordIds('["cp1","cp2"]');
  assert.deepEqual(legacy.previous, {});
  assert.deepEqual(legacy.imported, {});
  assert.deepEqual(pricesRevertPlan(legacy).items, [
    { id: 'cp1', previous: undefined, imported: undefined }, { id: 'cp2', previous: undefined, imported: undefined },
  ]);
  // السعر السابق صفر يُستعاد لا يُحذف، والقيم التالفة تُهمل
  assert.deepEqual(pricesRevertPlan(parseBatchRecordIds('{"records":["a","b"],"previous":{"a":0,"b":"x"}}')).items, [
    { id: 'a', previous: 0, imported: undefined }, { id: 'b', previous: undefined, imported: undefined },
  ]);
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
  // البندان 43 و44: الفحص انتقل إلى المخطِّط الصرف، والمسار يمرّر الإقرار إليه قبل أي كتابة
  assert.match(body, /planPriceImportRows\(rows, matcher, prods, body\.allowZeroPrice === true\)/);
  assert.match(read('services/importLedger.ts'), /const zeroIssue = priceRowIssue\(r\.price, allowZeroPrice\);/);
  assert.match(body, /importContentHash\('prices', rows\)/, 'البصمة للصفوف وحدها');
  assert.match(src, /allowZeroPrice: z\.boolean\(\)\.optional\(\)/);
  // البند 31: خيار «شاملة الضريبة» لا يدخل البصمة (كالمخزون الافتتاحي) فلا يصير تبديله دفعةً ثانية
  assert.ok(body.indexOf('importContentHash(') < body.indexOf('pricesIncludeTax === true'), 'البصمة قبل التحويل');
  assert.ok(body.indexOf('planPriceImportRows(') < body.indexOf('runImportChunks('));
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
  // البند 30: الفحص انتقل إلى المخطِّط الصرف، والمسار يستدعيه قبل أي كتابة بالضريبة الافتراضية التي يكتبها للصف
  assert.match(body, /plan = planProductImportRows\(rows, existing, defaultVat\);/);
  assert.ok(body.indexOf('planProductImportRows(') < body.indexOf('tx.product.create('));
  assert.match(read('services/importLedger.ts'), /const taxIssue = taxPctIssue\(r\.taxPct\);/);
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
  // البند 7: كلاهما داخل معاملة القفل، والحذف قبل الاستعادة في المصدر (الفرع الواحد يقرر بـpriceRevertAction)
  assert.ok(pr.indexOf('tx.customerPrice.deleteMany(') < pr.indexOf('tx.customerPrice.updateMany('));
  assert.doesNotMatch(pr, /prisma\.customerPrice\./, 'كتابة خارج معاملة القفل');
  assert.ok(rv.indexOf('assertBatchRevertible(batch, new Date())') < rv.indexOf('pricesRevertPlan('));
});

// ═══ الدفعة 3: البند 51 (عقد تاريخ الواجهة) والبند 39 (تاريخ بعد اليوم) في مساري الأرصدة والكشوف ═══

/** جسم مُعالِج المسار (حتى المسار التالي) كما في بقية الحراس الثابتة */
function entryRouteBody(src: string, marker: string): string {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, marker);
  const end = src.indexOf('\nrouter.', i + marker.length);
  return src.slice(i, end < 0 ? undefined : end);
}

test('حارس ثابت (البند 51): /balances و/ledger يفحصان dateContract قبل أي قراءة أو كتابة، و409 IMPORT_CLIENT_OUTDATED بالعربية', () => {
  const src = read('routes/import.ts');
  // العقد نفسه الذي ترسله الواجهة (web-admin/src/lib/importRevert.ts: IMPORT_DATE_CONTRACT)
  assert.match(src, /const IMPORT_DATE_CONTRACT = 'local-ymd-v2';/);
  // الرسالة العربية شرط لا زينة: التبويب القديم لا يعرف الرمز، ويعرض رسالة الخادم كما هي
  assert.match(src, /const IMPORT_CLIENT_OUTDATED_MESSAGE = 'هذه الصفحة مفتوحة من قبل تحديث النظام ولم يُكتب شيء\. حدّث الصفحة ثم أعد رفع الملف';/);
  assert.match(src, /throw new ImportHttpError\(409, 'IMPORT_CLIENT_OUTDATED', IMPORT_CLIENT_OUTDATED_MESSAGE/);
  // الغائب مخالف كالمختلف: التبويب الذي لا يرسله هو عين الذي يرسل تواريخ متأخرة يوماً
  assert.match(src, /if \(contract === IMPORT_DATE_CONTRACT\) return;/);
  for (const wrapper of ['balancesBody', 'ledgerBody']) {
    const start = src.indexOf(`const ${wrapper} = z.object({`);
    assert.ok(start > 0, wrapper);
    assert.match(src.slice(start, src.indexOf('});', start)), /dateContract: z\.string\(\)\.trim\(\)\.optional\(\)/, wrapper);
  }
  for (const marker of ["router.post('/balances'", "router.post('/ledger'"]) {
    const body = entryRouteBody(src, marker);
    const at = body.indexOf('assertImportDateContract(body.dateContract);');
    assert.ok(at > 0, `${marker}: لا فحص للعقد`);
    // قبل فحص الصفوف وقبل حالة الدفاتر والحجز والكتابة
    for (const after of ['parseImportBodyRows(', 'importLedgerContext(tid)', 'resolveImportDates(', 'importContentHash(', 'reserveEntryBatch(']) {
      assert.ok(at < body.indexOf(after), `${marker}: ${after} قبل فحص العقد`);
    }
  }
  // العقد يخصّ مساري القيود وحدهما (البيانات الأساسية بلا تواريخ)
  assert.doesNotMatch(entryRouteBody(src, "router.post('/customers'"), /assertImportDateContract\(/);
  assert.doesNotMatch(entryRouteBody(src, "router.post('/products'"), /assertImportDateContract\(/);
});

test('سيناريو البند 39: تاريخ 2052 بعد «اليوم + يوم» بتوقيت الشركة ⇒ تنبيه معدود بصفوفه، و«غداً» يمرّ', () => {
  const tz = 'Asia/Riyadh';
  // 17 سبتمبر 2026 الساعة 23:30 بتوقيت الرياض ⇒ اليوم المحلي 2026-09-17، والحدّ 2026-09-18 (شامل)
  const now = new Date('2026-09-17T20:30:00.000Z');
  assert.equal(maxImportEntryDate(now, tz), '2026-09-18');
  assert.equal(IMPORT_FUTURE_DATE_GRACE_DAYS, 1);
  // الحدّ نفسه يمرّ، وما بعده تنبيه — والمقارنة بالأيام المحلية لا باللحظات
  assert.equal(isImportDateTooFarAhead(new Date('2026-09-18T20:00:00.000Z'), now, tz), false, 'غد الشركة مقبول');
  assert.equal(isImportDateTooFarAhead(new Date('2026-09-19T00:00:00.000Z'), now, tz), true, 'بعد غدٍ تنبيه');
  assert.equal(isImportDateTooFarAhead(new Date('2052-03-15T00:00:00.000Z'), now, tz), true, 'خطأ السنة');
  assert.equal(isImportDateTooFarAhead(new Date('2020-01-01T00:00:00.000Z'), now, tz), false, 'الماضي مقبول دائماً');
  // منطق التنبيه في المسار: رقم السطر = الفهرس + 2، ولا تنبيه حين لا صفّ مخالف
  const dates = [new Date('2025-01-01T00:00:00.000Z'), new Date('2052-03-15T00:00:00.000Z'), new Date('2060-01-01T00:00:00.000Z')];
  const rows = dates.map((d, i) => [d, i + 2] as const).filter(([d]) => isImportDateTooFarAhead(d, now, tz)).map(([, r]) => r);
  assert.deepEqual(rows, [3, 4]);
  assert.equal(dates.filter((d) => isImportDateTooFarAhead(d, now, tz)).length, 2);
});

test('حارس ثابت (البند 39): التنبيه معدود لا مانع — لا يُرمى خطأ ولا يُمنع صفّ، ويُرسَل في warnings للمسارين', () => {
  const src = read('routes/import.ts');
  // الإغلاقة: لا نسخة ثانية للقاعدة في المسار — المصدر الوحيد `resolveImportDates` بالتوقيت المضبوط نفسه
  // الذي تُكتب به التواريخ (البند 22)، فلا تنبيه كاذب لشركة بلا توقيت مضبوط قرب منتصف الليل.
  assert.doesNotMatch(src, /function futureDatedWarning\(/, 'عادت نسخة ثانية من قاعدة التاريخ المستقبلي إلى المسار');
  assert.doesNotMatch(src, /isImportDateTooFarAhead\(/, 'المسار يحسب القاعدة بنفسه بدل resolveImportDates');
  const svc = read('services/importLedger.ts');
  const fn = svc.slice(svc.indexOf('export function resolveImportDates('), svc.indexOf('\n}\n', svc.indexOf('export function resolveImportDates(')));
  assert.match(fn, /maxImportEntryDate\(opts\.now/, 'القاعدة من services/gl/opening بلحظة الطلب نفسها');
  assert.match(fn, /future\.push\(\{ row: i \+ 2/, 'رقم السطر = الفهرس + 2');
  assert.match(fn, /futureDates: future\.length/, 'تنبيه معدود في نتيجة الحلّ');
  assert.doesNotMatch(fn, /throw [^;]*FUTURE/i, 'التنبيه صار مانعاً');
  for (const marker of ["router.post('/balances'", "router.post('/ledger'"]) {
    const body = entryRouteBody(src, marker);
    // اللحظة نفسها التي تُحسب بها التواريخ (now واحد لا new Date() مرتين)
    assert.match(body, /const now = new Date\(\);/, marker);
    assert.match(body, /activated: ctx\.activated, now \}\)/, marker);
    assert.match(body, /futureDates: futureDated \} = resolveImportDates\(/, marker);
    assert.match(body, /\.\.\.\(futureDated \? \{ futureDated \} : \{\}\)/, marker);
  }
});
