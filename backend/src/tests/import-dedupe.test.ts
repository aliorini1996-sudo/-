// البند 5 — منع تكرار الاستيراد: البصمة، الرصيد القائم بالدفعات لا بالوصف، وتداخل الكشف مع المستورد. بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BALANCE_SKIP_MESSAGES, IMPORT_FLUSH_EVERY_MS, IMPORT_FLUSH_EVERY_ROWS, IMPORT_RUNNING_STALE_MS, ImportHttpError, OPENING_BALANCE_DESCRIPTION,
  assertBatchRevertible, assertNoRunningImport, assertNotDuplicateBatch, assertOverlapConfirmed, balanceSkipReason, canonicalImportRow,
  detectLedgerOverlap, existingImportReason, importBatchState, importContentHash, importFlushDue, importedEntryIndex, roundImportAmount,
  assertImportLedgerStateUnchanged, isLockBusyError,
} from '../services/importLedger';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const rows = [
  { customerName: 'مؤسسة أ', balance: 1500.5, date: '2026-08-31' },
  { customerCode: 'C-2', balance: -200, date: '2026-08-31' },
  { phone: '0500000000', balance: 75 },
];

test('البصمة ثابتة مع اختلاف ترتيب الصفوف والمسافات، وتتغير بتغيّر مبلغ أو نوع', () => {
  const h = importContentHash('balances', rows);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(importContentHash('balances', [...rows].reverse()), h);
  assert.equal(importContentHash('balances', [{ ...rows[0], customerName: '  مؤسسة  أ ' }, rows[1], rows[2]]), h);
  assert.equal(importContentHash('balances', [{ balance: 1500.5, date: '2026-08-31', customerName: 'مؤسسة أ' }, rows[1], rows[2]]), h, 'ترتيب المفاتيح');
  assert.notEqual(importContentHash('balances', [{ ...rows[0], balance: 1500.51 }, rows[1], rows[2]]), h);
  assert.notEqual(importContentHash('ledger', rows), h);
  // الفارغ والصفر وغياب الحقل سواء (debit: 0 ≡ غياب debit)
  assert.equal(canonicalImportRow({ customerName: 'x', debit: 0, credit: 5, description: '' }), canonicalImportRow({ credit: 5, customerName: 'x' }));
});

test('الملف المكرر ⇒ 409 IMPORT_DUPLICATE_BATCH بـ{batchId, createdAt}، ومع force ينجح، وبلا سابقة يمر', () => {
  const prev = { id: 'b-1', createdAt: new Date('2026-09-01T08:00:00Z') };
  assert.throws(() => assertNotDuplicateBatch(prev, false), (e: unknown) => {
    assert.ok(e instanceof ImportHttpError);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'IMPORT_DUPLICATE_BATCH');
    assert.deepEqual(e.details, { batchId: 'b-1', createdAt: '2026-09-01T08:00:00.000Z' });
    return true;
  });
  assert.doesNotThrow(() => assertNotDuplicateBatch(prev, true));
  assert.doesNotThrow(() => assertNotDuplicateBatch(null, false));
});

test('صف «رصيد افتتاحي» ليس في دفعة (تسوية يدوية بالوصف نفسه) لا يُسقط رصيد /balances', () => {
  const idx = importedEntryIndex([
    { kind: 'balances', recordIds: JSON.stringify(['e-bal']) },
    { kind: 'ledger', recordIds: JSON.stringify(['e-led1', 'e-led2']) },
    { kind: 'customers', recordIds: JSON.stringify(['e-manual']) },
    { kind: 'balances', recordIds: 'not json' },
  ]);
  assert.equal(existingImportReason(['e-manual'], idx), null, 'الوصف لا يُعتدّ به');
  assert.equal(existingImportReason([], idx), null);
  assert.equal(existingImportReason(['e-manual', 'e-bal'], idx), 'BALANCE_ALREADY_IMPORTED');
  assert.equal(existingImportReason(['e-led2'], idx), 'LEDGER_ALREADY_IMPORTED');
  assert.equal(existingImportReason(['e-led1', 'e-bal'], idx), 'BALANCE_ALREADY_IMPORTED');
  assert.ok(BALANCE_SKIP_MESSAGES.LEDGER_ALREADY_IMPORTED.length > 10);
});

test('التداخل بين الكشف والرصيد ⇒ warnings.overlap و409 IMPORT_OVERLAP_CONFIRM دون confirmOverlap', () => {
  const idx = importedEntryIndex([{ kind: 'balances', recordIds: JSON.stringify(['b1']) }, { kind: 'ledger', recordIds: JSON.stringify(['l1', 'l2']) }]);
  const statement = new Map([
    ['c1', [{ debit: 1000, credit: 0 }, { debit: 0, credit: 250.25 }]],
    ['c2', [{ debit: 10, credit: 0 }]],
    ['c3', [{ debit: 5, credit: 0 }]],
  ]);
  const existing = [
    { id: 'b1', customerId: 'c1', debit: '1500.5', credit: '0' },
    { id: 'l1', customerId: 'c1', debit: 0, credit: 100 },
    { id: 'manual', customerId: 'c2', debit: 999, credit: 0 }, // تسوية يدوية لا تُعدّ
    { id: 'l2', customerId: 'c9', debit: 1, credit: 0 },       // عميل خارج الكشف
  ];
  const overlap = detectLedgerOverlap(statement, existing, idx, new Map([['c1', 'مؤسسة أ']]));
  assert.deepEqual(overlap, [{ customerId: 'c1', customerName: 'مؤسسة أ', existingBalance: 1400.5, statementNet: 749.75 }]);
  assert.throws(() => assertOverlapConfirmed(overlap, false), (e: unknown) => {
    assert.ok(e instanceof ImportHttpError);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'IMPORT_OVERLAP_CONFIRM');
    assert.deepEqual((e.details.warnings as { overlap: unknown }).overlap, overlap);
    return true;
  });
  assert.doesNotThrow(() => assertOverlapConfirmed(overlap, true));
  assert.doesNotThrow(() => assertOverlapConfirmed([], false));
});

test('import.ts /ledger: البصمة والتداخل قبل أي كتابة؛ /balances: الفحص داخل المعاملة بعد FOR UPDATE ويبلّغ warnings.skipped', () => {
  const s = read('routes/import.ts');
  const li = s.indexOf("router.post('/ledger'");
  const ledger = s.slice(li, s.indexOf('\n});', li));
  const firstTx = ledger.indexOf('prisma.$transaction(');
  for (const n of ['assertNotDuplicateBatch(', 'assertOverlapConfirmed(overlap, body.confirmOverlap === true)']) {
    const i = ledger.indexOf(n);
    assert.ok(i > 0 && i < firstTx, `/ledger: ${n} بعد الكتابة`);
  }
  // مراجعة 3 و7: الحجز قبل التداخل وأي كتابة، والإنهاء في finally
  const reserve = ledger.indexOf("reserveEntryBatch(tid, 'ledger', contentHash");
  assert.ok(reserve > 0 && reserve < ledger.indexOf('assertOverlapConfirmed(') && reserve < firstTx, '/ledger: الحجز بعد التداخل أو الكتابة');
  assert.match(ledger, /\} finally \{\s*result\.batchId = await progress\.finish\(\);/);
  assert.match(ledger, /progress\.due\(groupIds\.length\)\) step\.flushed = await progress\.write\(tx, groupIds\)/, '/ledger: المعرّفات تُحفظ داخل معاملة الكتابة');
  assert.doesNotMatch(ledger, /recordBatch\(/, '/ledger: الدفعة لا تُسجَّل في النهاية فقط');
  assert.match(ledger, /debit: roundImportAmount\(r\.debit, ctx\.decimals\), credit: roundImportAmount\(r\.credit, ctx\.decimals\)/);

  const bi = s.indexOf("router.post('/balances'");
  const bal = s.slice(bi, s.indexOf('\n});', bi));
  assert.doesNotMatch(bal, /description: 'رصيد افتتاحي' \}/, 'فحص الوجود بالوصف ما زال قائماً');
  const tx = bal.slice(bal.indexOf('prisma.$transaction(async tx => {'));
  let pos = -1;
  for (const n of ['FOR UPDATE', 'tx.accountEntry.findMany(', 'select: { id: true, description: true }', 'balanceSkipReason(adj, idx)', 'tx.accountEntry.create(', 'progress.write(tx, [e.id])']) {
    const i = tx.indexOf(n, pos + 1);
    assert.ok(i > pos, `/balances: ${n} خارج الترتيب`);
    pos = i;
  }
  assert.ok(bal.indexOf('assertNotDuplicateBatch(') < bal.indexOf('prisma.$transaction('));
  assert.match(bal, /skippedWarnings\.push\(\{ customerName: [^\n]*reason: BALANCE_SKIP_MESSAGES\[out\.reason\] \}\)/);
  assert.match(bal, /warnings: \{ undatedAsToday, skipped: skippedWarnings \}/);
  const bReserve = bal.indexOf("reserveEntryBatch(tid, 'balances', contentHash");
  assert.ok(bReserve > 0 && bReserve < bal.indexOf('prisma.$transaction(') && bReserve < bal.indexOf('loadImportedIndex('), '/balances: الحجز بعد الكتابة');
  assert.match(bal, /\} finally \{\s*result\.batchId = await progress\.finish\(\);/);
  assert.doesNotMatch(bal, /recordBatch\(/);
  assert.match(bal, /const amount = roundImportAmount\(r\.balance, ctx\.decimals\)/);

  // الحجز: قفل الشركة ثم البصمة (ومنها الجارية) ثم الاستيراد الجاري ثم الإنشاء running — داخل معاملة واحدة
  const ri = s.indexOf('async function reserveEntryBatch(');
  const reserveFn = s.slice(ri, s.indexOf('\n}\n', ri));
  let p = -1;
  for (const n of ["SET LOCAL lock_timeout = '5s'", 'pg_advisory_xact_lock(hashtext(', 'tx.glSettings.findUnique(', 'assertImportLedgerStateUnchanged(gs?.activatedAt, expectActivated)', 'tx.importBatch.findFirst(', 'assertNotDuplicateBatch(dup, force, now)', 'status: IMPORT_BATCH_RUNNING }', 'assertNoRunningImport(', 'tx.importBatch.create(', 'status: IMPORT_BATCH_RUNNING, heartbeatAt: now']) {
    const i = reserveFn.indexOf(n, p + 1);
    assert.ok(i > p, `reserveEntryBatch: ${n} خارج الترتيب`);
    p = i;
  }
  assert.ok(reserveFn.indexOf('prisma.$transaction(async tx => {') < reserveFn.indexOf("SET LOCAL lock_timeout = '5s'"), 'reserveEntryBatch: المهلة داخل المعاملة');
  // سباق التفعيل (مراجعة البند 5): الحالة تحت القفل، والمساران يمرّران ctx.activated الذي حُسبت به التواريخ
  assert.match(bal, /reserveEntryBatch\(tid, 'balances', contentHash, [^\n]*body\.force === true, ctx\.activated\)/);
  assert.match(ledger, /reserveEntryBatch\(tid, 'ledger', contentHash, [^\n]*body\.force === true, ctx\.activated\)/);
  // انتظار قفل يمسكه الاعتماد ⇒ 409 IMPORT_LEDGER_BUSY لا 500، وأخطاء الاستيراد ذات الرمز تمرّ كما هي
  assert.match(reserveFn, /catch \(e\) \{\s*if \(!isImportHttpError\(e\) && isLockBusyError\(e\)\) throw new ImportHttpError\(409, 'IMPORT_LEDGER_BUSY', LEDGER_BUSY_MESSAGE\);\s*throw e;/);
  // التراجع عن دفعة جارية مرفوض، والقائمة تعرض الحالة
  const rv = s.slice(s.indexOf("router.post('/batches/:id/revert'"));
  assert.ok(rv.indexOf('assertBatchRevertible(batch, new Date())') > 0 && rv.indexOf('assertBatchRevertible(') < rv.indexOf('parseBatchRecordIds('));
  assert.match(rv, /catch \(err\) \{ sendImportError\(err, res, next\); \}/);
  assert.match(s, /status: importBatchState\(\{ \.\.\.b, heartbeatAt \}, now\)/);
});

test('مراجعة 4: رصيد افتتاحي بلا دفعة (استيراد انقطع أو سبق الدفعات) ⇒ BALANCE_ALREADY_IMPORTED احتياطاً بالوصف؛ وما في دفعة يبقى بسببه', () => {
  const idx = importedEntryIndex([
    { kind: 'balances', recordIds: JSON.stringify(['e-bal']) },
    { kind: 'ledger', recordIds: JSON.stringify(['e-led-open']) },
  ]);
  assert.equal(OPENING_BALANCE_DESCRIPTION, 'رصيد افتتاحي');
  // يتيم: كُتب ولم تُسجَّل دفعته (انقطاع في منتصف 10,000 صف) ⇒ يُتخطى بدل مضاعفة الذمة
  assert.equal(balanceSkipReason([{ id: 'orphan', description: 'رصيد افتتاحي' }], idx), 'BALANCE_ALREADY_IMPORTED');
  // تسوية يدوية بوصف آخر لا تحجب
  assert.equal(balanceSkipReason([{ id: 'manual', description: 'تسوية' }, { id: 'x', description: null }], idx), null);
  assert.equal(balanceSkipReason([], idx), null);
  // «رصيد افتتاحي» مستورد عبر الكشف ⇒ سبب الكشف لا الاحتياط
  assert.equal(balanceSkipReason([{ id: 'e-led-open', description: 'رصيد افتتاحي' }], idx), 'LEDGER_ALREADY_IMPORTED');
  assert.equal(balanceSkipReason([{ id: 'e-bal', description: 'رصيد افتتاحي' }], idx), 'BALANCE_ALREADY_IMPORTED');
  // التراجع يحذف صفوف دفعته (قبل التفعيل وبعده) ⇒ لا صف يحجب إعادة الاستيراد بعده
  const s = read('routes/import.ts');
  const from = s.indexOf("batch.kind === 'balances' || batch.kind === 'ledger'");
  const rv = s.slice(from, s.indexOf("batch.kind === 'prices'", from));
  assert.match(rv, /tx\.accountEntry\.deleteMany\(\{ where: \{ id: \{ in: ids \}, tenantId: tid \} \}\)/);
});

test('مراجعة 3 و7: إعادة الرفع أثناء استيراد جارٍ (تحديث الصفحة/انقطاع الشبكة) ⇒ 409 مكرر بعلامة running، واستيراد قيود آخر ⇒ IMPORT_IN_PROGRESS حتى مع force', () => {
  const now = new Date('2026-09-17T10:00:00Z');
  const running = { id: 'b-run', kind: 'balances', createdAt: new Date('2026-09-17T09:55:00Z'), status: 'running', heartbeatAt: new Date('2026-09-17T09:59:50Z') };
  assert.equal(importBatchState(running, now), 'running');
  assert.throws(() => assertNotDuplicateBatch(running, false, now), (e: unknown) => {
    assert.ok(e instanceof ImportHttpError);
    assert.deepEqual([e.status, e.code], [409, 'IMPORT_DUPLICATE_BATCH']);
    assert.deepEqual(e.details, { batchId: 'b-run', createdAt: '2026-09-17T09:55:00.000Z', running: true });
    return true;
  });
  // force يتجاوز البصمة لا الاستيراد الجاري
  assert.doesNotThrow(() => assertNotDuplicateBatch(running, true, now));
  assert.throws(() => assertNoRunningImport(running), (e: unknown) => e instanceof ImportHttpError && e.status === 409 && e.code === 'IMPORT_IN_PROGRESS' && e.details.batchId === 'b-run');
  assert.doesNotThrow(() => assertNoRunningImport(undefined));
  // لا تراجع عن دفعة ما زالت تُكتب
  assert.throws(() => assertBatchRevertible(running, now), (e: unknown) => e instanceof ImportHttpError && e.code === 'IMPORT_BATCH_RUNNING');

  // انقطاع الخادم: running بلا نبض 10 دقائق ⇒ interrupted — لا يحجب، ويُتراجع عمّا سُجّل منه، والبصمة ما زالت تمنع المكرر
  const stale = { ...running, heartbeatAt: new Date(now.getTime() - IMPORT_RUNNING_STALE_MS - 1) };
  assert.equal(importBatchState(stale, now), 'interrupted');
  assert.doesNotThrow(() => assertBatchRevertible(stale, now));
  assert.throws(() => assertNotDuplicateBatch(stale, false, now), (e: unknown) => e instanceof ImportHttpError && e.details.running === undefined);
  assert.equal(importBatchState({ ...running, heartbeatAt: null, createdAt: new Date(now.getTime() - IMPORT_RUNNING_STALE_MS - 1) }, now), 'interrupted');
  // الدفعات القديمة (status null) والمنتهية
  assert.equal(importBatchState({ status: null, createdAt: now }, now), 'done');
  assert.equal(importBatchState({ status: 'done', createdAt: now }, now), 'done');
  assert.doesNotThrow(() => assertBatchRevertible({ id: 'old', status: null, createdAt: now }, now));

  // الحفظ أثناء الاستيراد: كل N قيد أو كل T
  const t = now.getTime();
  assert.equal(importFlushDue({ pending: IMPORT_FLUSH_EVERY_ROWS - 1, lastFlushAt: t, now: t }), false);
  assert.equal(importFlushDue({ pending: IMPORT_FLUSH_EVERY_ROWS, lastFlushAt: t, now: t }), true);
  assert.equal(importFlushDue({ pending: 0, lastFlushAt: t, now: t + IMPORT_FLUSH_EVERY_MS }), true, 'النبض حتى بلا قيود جديدة');
  assert.ok(IMPORT_FLUSH_EVERY_MS * 4 < IMPORT_RUNNING_STALE_MS, 'النبض أسرع بكثير من حد الانقطاع');
});

test('مراجعة 1: مبالغ الاستيراد تُقرَّب لمنازل العملة قبل التخزين (نصف-لأعلى وبعيداً عن الصفر)', () => {
  assert.equal(roundImportAmount(1.005, 2), 1.01);
  assert.equal(roundImportAmount(2.005, 2), 2.01);
  assert.equal(roundImportAmount(3.125, 2), 3.13);
  assert.equal(roundImportAmount(-1.005, 2), -1.01);
  assert.equal(roundImportAmount(1.0005, 3), 1.001);
  assert.equal(roundImportAmount(12.5, 0), 13);
  assert.equal(roundImportAmount(undefined, 2), 0);
  assert.equal(roundImportAmount(0.004, 2), 0, 'يُتخطى كصفر');
  // مجموع المخزَّن = مجموع toMilli لكل صف (القيد الافتتاحي)
  assert.equal(Math.round([1.005, 2.005, 3.125].reduce((a, v) => a + roundImportAmount(v, 2), 0) * 1000), 6150);
});

test('schema.prisma: ImportBatch.contentHash String? إضافي', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const i = schema.indexOf('model ImportBatch {');
  const model = schema.slice(i, schema.indexOf('\n}', i));
  assert.match(model, /\n\s+contentHash\s+String\?\s/);
  assert.match(model, /\n\s+status\s+String\?\s/, 'status إضافي nullable');
  assert.match(model, /\n\s+heartbeatAt\s+DateTime\?\s/, 'heartbeatAt إضافي nullable');
});

test('سباق التفعيل عند حجز دفعة الأرصدة/الكشوف: حالة الدفاتر تحت القفل تخالف ما حُسبت به التواريخ ⇒ 409 IMPORT_LEDGER_STATE_CHANGED', () => {
  assert.doesNotThrow(() => assertImportLedgerStateUnchanged(null, false));
  assert.doesNotThrow(() => assertImportLedgerStateUnchanged(undefined, false));
  assert.doesNotThrow(() => assertImportLedgerStateUnchanged(new Date('2026-09-17T10:00:00Z'), true));
  assert.throws(() => assertImportLedgerStateUnchanged(new Date('2026-09-17T10:00:00Z'), false), (e: unknown) => {
    assert.ok(e instanceof ImportHttpError);
    assert.deepEqual([e.status, e.code], [409, 'IMPORT_LEDGER_STATE_CHANGED']);
    assert.equal(e.details.activatedAt, '2026-09-17T10:00:00.000Z');
    return true;
  });
  assert.throws(() => assertImportLedgerStateUnchanged(null, true), (e: unknown) => e instanceof ImportHttpError && e.code === 'IMPORT_LEDGER_STATE_CHANGED' && e.details.activatedAt === null);
  // مهلة القفل (lock_timeout) ومهلة المعاملة تُصنَّفان انشغالاً ⇒ IMPORT_LEDGER_BUSY
  assert.equal(isLockBusyError({ code: 'P2028' }), true);
  assert.equal(isLockBusyError(new Error('Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`')), true);
  assert.equal(isLockBusyError(new Error('other')), false);
});
