// البند 5 — منع تكرار الاستيراد: البصمة، الرصيد القائم بالدفعات لا بالوصف، وتداخل الكشف مع المستورد. بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BALANCE_SKIP_MESSAGES, IMPORT_FLUSH_EVERY_MS, IMPORT_FLUSH_EVERY_ROWS, IMPORT_RUNNING_STALE_MS, ImportHttpError, OPENING_BALANCE_DESCRIPTION,
  assertBatchRevertible, assertNoRunningImport, assertNotDuplicateBatch, assertOverlapConfirmed, balanceSkipReason, canonicalImportRow,
  detectLedgerOverlap, existingImportReason, importBatchState, importContentHash, importFlushDue, importedEntryIndex, roundImportAmount,
  assertImportLedgerStateUnchanged, isLockBusyError, IMPORT_LEDGER_TIMEZONE_CHANGED_MESSAGE, explicitTimezone,
  IMPORT_FUTURE_DATE_MESSAGE, resolveImportDates,
} from '../services/importLedger';
import { IMPORT_FUTURE_DATE_GRACE_DAYS, maxImportEntryDate } from '../services/gl/opening';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

function assertOrder(body: string, parts: readonly string[], label: string) {
  let pos = -1;
  for (const p of parts) {
    const i = body.indexOf(p, pos + 1);
    assert.ok(i > pos, `${label}: «${p}» مفقود أو خارج الترتيب`);
    pos = i;
  }
}

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
  // البند 6 (مراجعة 2026-09-17): المعرّفات تُكتب في آخر كل معاملة شريحة دون شرط due، والكتابة داخل المعاملة نفسها
  assert.doesNotMatch(ledger, /progress\.due\(/, '/ledger: حفظ المعرّفات مشروط بـdue');
  assertOrder(ledger, ['runImportChunks(', 'prisma.$transaction(async tx => fn(tx)', 'tx.accountEntry.create(', 'tx.customer.update(', 'flush: (tx, written) => progress.write(tx,', 'onCommitted:', 'progress.commit('], '/ledger: الكتابة والمعرّفات في المعاملة');
  assert.ok(reserve < ledger.indexOf('runImportChunks('), '/ledger: الحجز بعد الكتابة');
  assert.doesNotMatch(ledger, /recordBatch\(/, '/ledger: الدفعة لا تُسجَّل في النهاية فقط');
  assert.match(ledger, /groupLedgerRows\(rows, await customerMatcher\(req, tid\), dates, ctx\.decimals\)/);
  assert.match(read('services/importLedger.ts'), /const debit = roundImportAmount\(r\.debit, decimals\); const credit = roundImportAmount\(r\.credit, decimals\);/);

  const bi = s.indexOf("router.post('/balances'");
  const bal = s.slice(bi, s.indexOf('\n});', bi));
  assert.doesNotMatch(bal, /description: 'رصيد افتتاحي' \}/, 'فحص الوجود بالوصف ما زال قائماً');
  const tx = bal.slice(bal.indexOf('prisma.$transaction(async tx => fn(tx)'));
  assert.ok(bal.indexOf('prisma.$transaction(async tx => fn(tx)') > 0, '/balances: لا معاملة كتابة');
  let pos = -1;
  for (const n of ['FOR UPDATE', 'tx.accountEntry.findMany(', 'select: { id: true, description: true }', 'balanceSkipReason(adj, idx)', 'tx.accountEntry.create(', 'flush: (tx, written) => progress.write(tx,', 'progress.commit(']) {
    const i = tx.indexOf(n, pos + 1);
    assert.ok(i > pos, `/balances: ${n} خارج الترتيب`);
    pos = i;
  }
  assert.doesNotMatch(bal, /progress\.due\(/, '/balances: حفظ المعرّفات مشروط بـdue');
  // البند 10: لا إضافة إلى فهرس المستورد داخل الطلب (الدمج قبل الكتابة)
  assert.doesNotMatch(bal, /idx\.balances\.add\(/);
  assert.ok(bal.indexOf('mergeBalanceRows(') > 0 && bal.indexOf('mergeBalanceRows(') < bal.indexOf('prisma.$transaction('));
  assert.ok(bal.indexOf('assertNotDuplicateBatch(') < bal.indexOf('prisma.$transaction('));
  assert.match(bal, /skippedWarnings\.push\(\{ customerName: [^\n]*reason: BALANCE_SKIP_MESSAGES\[out\.reason\] \}\)/);
  // تنبيهات /balances الثلاثة ما زالت في الرد (الحارس على أجزائها لا على نصّ السطر كاملاً، فتنبيه جديد لا يكسره)
  assert.match(bal, /warnings: \{ undatedAsToday, skipped: skippedWarnings, merged: merged\.slice\(0, 500\)/);
  const bReserve = bal.indexOf("reserveEntryBatch(tid, 'balances', contentHash");
  assert.ok(bReserve > 0 && bReserve < bal.indexOf('prisma.$transaction(') && bReserve < bal.indexOf('loadImportedIndex('), '/balances: الحجز بعد الكتابة');
  assert.match(bal, /\} finally \{\s*result\.batchId = await progress\.finish\(\);/);
  assert.doesNotMatch(bal, /recordBatch\(/);
  assert.match(bal, /const amount = roundImportAmount\(r\.balance, ctx\.decimals\)/);

  // الحجز: قفل الشركة ثم البصمة (ومنها الجارية) ثم الاستيراد الجاري ثم الإنشاء running — داخل معاملة واحدة
  const ri = s.indexOf('async function reserveEntryBatch(');
  const reserveFn = s.slice(ri, s.indexOf('\n}\n', ri));
  let p = -1;
  for (const n of ["SET LOCAL lock_timeout = '5s'", 'pg_advisory_xact_lock(hashtext(', 'tx.glSettings.findUnique(', 'assertImportLedgerStateUnchanged({ activatedAt: gs?.activatedAt, expectActivated, timezone: explicitTimezone(gs), expectTimezone })', 'tx.importBatch.findFirst(', 'assertNotDuplicateBatch(dup, force, now)', 'status: IMPORT_BATCH_RUNNING }', 'assertNoRunningImport(', 'tx.importBatch.create(', 'status: IMPORT_BATCH_RUNNING, heartbeatAt: now']) {
    const i = reserveFn.indexOf(n, p + 1);
    assert.ok(i > p, `reserveEntryBatch: ${n} خارج الترتيب`);
    p = i;
  }
  assert.ok(reserveFn.indexOf('prisma.$transaction(async tx => {') < reserveFn.indexOf("SET LOCAL lock_timeout = '5s'"), 'reserveEntryBatch: المهلة داخل المعاملة');
  // سباق التفعيل (مراجعة البند 5): الحالة تحت القفل، والمساران يمرّران ctx.activated الذي حُسبت به التواريخ
  assert.match(bal, /reserveEntryBatch\(tid, 'balances', contentHash, [^\n]*body\.force === true, ctx\.activated, ctx\.timezone\)/);
  assert.match(ledger, /reserveEntryBatch\(tid, 'ledger', contentHash, [^\n]*body\.force === true, ctx\.activated, ctx\.timezone\)/);
  // انتظار قفل يمسكه الاعتماد ⇒ 409 IMPORT_LEDGER_BUSY لا 500، وأخطاء الاستيراد ذات الرمز تمرّ كما هي
  assert.match(reserveFn, /catch \(e\) \{\s*if \(!isImportHttpError\(e\) && isLockBusyError\(e\)\) throw new ImportHttpError\(409, 'IMPORT_LEDGER_BUSY', LEDGER_BUSY_MESSAGE\);\s*throw e;/);
  // التراجع عن دفعة جارية مرفوض، والقائمة تعرض الحالة
  const rv = s.slice(s.indexOf("router.post('/batches/:id/revert'"));
  assert.ok(rv.indexOf('assertBatchRevertible(batch, new Date())') > 0 && rv.indexOf('assertBatchRevertible(') < rv.indexOf('parseBatchRecordIds('));
  assert.match(rv, /catch \(err\) \{ sendImportError\(err, res, next\); \}/);
  assert.match(s, /status: importBatchState\(\{ \.\.\.b, heartbeatAt \}, now\)/);
});

test('مراجعة 4 والبند 6: رصيد افتتاحي بلا دفعة (استيراد قديم أو منقطع) ⇒ BALANCE_UNBATCHED احتياطاً بالوصف؛ وما في دفعة يبقى بسببه', () => {
  const idx = importedEntryIndex([
    { kind: 'balances', recordIds: JSON.stringify(['e-bal']) },
    { kind: 'ledger', recordIds: JSON.stringify(['e-led-open']) },
  ]);
  assert.equal(OPENING_BALANCE_DESCRIPTION, 'رصيد افتتاحي');
  // يتيم: كُتب ولم تُسجَّل دفعته (انقطاع في منتصف 10,000 صف) ⇒ يُتخطى بدل مضاعفة الذمة
  assert.equal(balanceSkipReason([{ id: 'orphan', description: 'رصيد افتتاحي' }], idx), 'BALANCE_UNBATCHED');
  // لا دفعة يُتراجع عنها ⇒ الرسالة لا تطلب التراجع
  assert.doesNotMatch(BALANCE_SKIP_MESSAGES.BALANCE_UNBATCHED, /تراجع عنها أولاً/);
  assert.match(BALANCE_SKIP_MESSAGES.BALANCE_UNBATCHED, /خارج أي دفعة استيراد/);
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

// البند 39: «أقصى تاريخ مقبول لصفّ مستورد = اليوم المحلي بتوقيت الشركة + يوم سماح» — قاعدة واحدة يشترك فيها
// الاستيراد والدفاتر (gl/opening.ts). في الاستيراد تنبيهٌ معدود: الصفّ يُكتب بتاريخه ولا يُمنع ولا يُسقط بصمت.
test('البند 39: تاريخ بعد الحدّ ⇒ تنبيه معدود بصفوفه وتواريخه، والصفّ يُكتب كما هو', () => {
  const now = new Date('2026-09-17T10:00:00Z'); // 13:00 بالرياض من 17 سبتمبر
  const opts = { timezone: 'Asia/Riyadh', activated: false, now };
  const r = resolveImportDates([{ date: '2026-09-17' }, { date: '2026-09-18' }, { date: '2052-03-15' }, { date: '2026-09-19' }], opts);
  assert.equal(r.dates.length, 4, 'صفّ سقط بسبب تاريخه');
  assert.equal(r.dates[2].toISOString(), '2052-03-14T21:00:00.000Z', 'التاريخ المستقبلي يُكتب كما هو لا كاليوم');
  assert.equal(r.futureDates?.count, 2);
  assert.deepEqual(r.futureDates?.rows, [{ row: 4, date: '2052-03-15' }, { row: 5, date: '2026-09-19' }]);
  assert.equal(r.futureDates?.maxDate, '2026-09-18');
  assert.equal(r.futureDates?.message, IMPORT_FUTURE_DATE_MESSAGE);
  assert.match(IMPORT_FUTURE_DATE_MESSAGE, /سنة التاريخ/);
  // اليوم وغدُه مقبولان بلا تنبيه (يوم السماح يغطّي فرق المناطق الزمنية)
  assert.equal(resolveImportDates([{ date: '2026-09-17' }, { date: '2026-09-18' }], opts).futureDates, null);
  assert.equal(resolveImportDates([], opts).futureDates, null);
  // القاعدة من مصدر واحد مع الدفاتر، ومحسوبة بتوقيت الشركة لا بـUTC
  assert.equal(IMPORT_FUTURE_DATE_GRACE_DAYS, 1);
  assert.equal(maxImportEntryDate(now, 'Asia/Riyadh'), '2026-09-18');
  const late = new Date('2026-09-17T22:00:00Z'); // 18 سبتمبر بالرياض، 17 بـUTC
  assert.equal(resolveImportDates([{ date: '2026-09-19' }], { ...opts, now: late }).futureDates, null);
  // بلا توقيت مضبوط للشركة: الافتراضي (الرياض) لا انهيار ولا تنبيه كاذب
  assert.equal(resolveImportDates([{ date: '2026-09-19' }], { timezone: null, activated: false, now: late }).futureDates, null);
  // تاريخ الصفوف بلا تاريخ يُفحص كذلك، بأرقام صفوفه هو
  const u = resolveImportDates([{}, { date: '2026-09-01' }, {}], { ...opts, undatedDate: '2052-01-01' });
  assert.equal(u.futureDates?.count, 2);
  assert.deepEqual(u.futureDates?.rows, [{ row: 2, date: '2052-01-01' }, { row: 4, date: '2052-01-01' }]);
  // بعد التفعيل تنبيه كذلك لا مانع (المانع الوحيد هو الصفوف بلا تاريخ)
  assert.equal(resolveImportDates([{ date: '2052-03-15' }], { ...opts, activated: true }).futureDates?.count, 1);
  // أكثر من خمسين صفاً: العدّ كامل والقائمة مقصوصة
  const many = Array.from({ length: 60 }, () => ({ date: '2052-03-15' }));
  const big = resolveImportDates(many, opts);
  assert.equal(big.futureDates?.count, 60);
  assert.equal(big.futureDates?.rows.length, 50);
  // حارس ثابت: القاعدة مستوردة من gl/opening لا منسوخة في الاستيراد
  const src = read('services/importLedger.ts');
  assert.match(src, /import \{ maxImportEntryDate \} from '\.\/gl\/opening';/);
  assert.doesNotMatch(src, /IMPORT_FUTURE_DATE_GRACE_DAYS\s*=/, 'نسخة ثانية من قاعدة الحدّ');
});

// البند 39 (سلامة الدورة): مصدرٌ واحد للقاعدة يعني أن importLedger.ts وgl/opening.ts يستورد أحدهما الآخر.
// الدورة سليمة **بشرط** ألّا يُستعمل المستورَد وقت تحميل الوحدة: من يُحمَّل ثانياً يرى صادرات الأول كاملة،
// أما من يُحمَّل أولاً فيرى وحدة الآخر نصف مهيّأة. استعمالٌ واحد على مستوى الوحدة (ثابت مُهيّأ بنداء) يجعل
// القيمة undefined في أحد ترتيبَي التحميل وحده — عطلٌ لا يظهر إلا في الإنتاج. الحارس: كل نداء متبادل مُزاح
// (داخل دالّة)، وسطور الاستيراد وحدها في العمود صفر.
test('البند 39: دورة importLedger ↔ gl/opening تبقى آمنة — لا استعمال متبادل وقت تحميل الوحدة', () => {
  const atTopLevel = (file: string, needle: RegExp) => read(file).split('\n')
    .filter((l) => needle.test(l) && !/^\s*(import|export)\s/.test(l) && !/^\s*\*/.test(l))
    .filter((l) => !/^\s/.test(l));
  assert.deepEqual(atTopLevel('services/importLedger.ts', /\bmaxImportEntryDate\s*\(/), [],
    'importLedger يستدعي قاعدة الحدّ وقت تحميل الوحدة — undefined حين يُحمَّل قبل gl/opening');
  assert.deepEqual(atTopLevel('services/gl/opening.ts', /\bimportBatchState\s*\(|\bIMPORT_BATCH_RUNNING\b/), [],
    'gl/opening يستعمل صادرات importLedger وقت تحميل الوحدة — undefined حين يُحمَّل قبله');
  // والدورة قائمة فعلاً في الاتجاهين (لو انقطعت سقط الحارس صامتاً عن غير عمد)
  assert.match(read('services/gl/opening.ts'), /from '\.\.\/importLedger'/);
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
  const ACT = new Date('2026-09-17T10:00:00Z');
  assert.doesNotThrow(() => assertImportLedgerStateUnchanged({ activatedAt: null, expectActivated: false }));
  assert.doesNotThrow(() => assertImportLedgerStateUnchanged({ activatedAt: undefined, expectActivated: false }));
  assert.doesNotThrow(() => assertImportLedgerStateUnchanged({ activatedAt: ACT, expectActivated: true }));
  assert.throws(() => assertImportLedgerStateUnchanged({ activatedAt: ACT, expectActivated: false }), (e: unknown) => {
    assert.ok(e instanceof ImportHttpError);
    assert.deepEqual([e.status, e.code], [409, 'IMPORT_LEDGER_STATE_CHANGED']);
    assert.equal(e.details.activatedAt, '2026-09-17T10:00:00.000Z');
    return true;
  });
  assert.throws(() => assertImportLedgerStateUnchanged({ activatedAt: null, expectActivated: true }), (e: unknown) => e instanceof ImportHttpError && e.code === 'IMPORT_LEDGER_STATE_CHANGED' && e.details.activatedAt === null);
  // البند 25: المنطقة الزمنية تحت القفل تخالف التي حُسبت بها التواريخ (يوم كامل إزاحة) ⇒ الرمز نفسه برسالتها وتفاصيلها
  assert.doesNotThrow(() => assertImportLedgerStateUnchanged({ activatedAt: null, expectActivated: false, timezone: 'Africa/Cairo', expectTimezone: 'Africa/Cairo' }));
  assert.throws(() => assertImportLedgerStateUnchanged({ activatedAt: null, expectActivated: false, timezone: 'Africa/Cairo', expectTimezone: 'Asia/Riyadh' }), (e: unknown) => {
    assert.ok(e instanceof ImportHttpError);
    assert.deepEqual([e.status, e.code], [409, 'IMPORT_LEDGER_STATE_CHANGED']);
    assert.deepEqual([e.details.timezone, e.details.expectedTimezone], ['Africa/Cairo', 'Asia/Riyadh']);
    assert.equal(e.message, IMPORT_LEDGER_TIMEZONE_CHANGED_MESSAGE);
    return true;
  });
  // التفعيل يُفحص أولاً، وتفاصيله تحمل المنطقتين كذلك
  assert.throws(() => assertImportLedgerStateUnchanged({ activatedAt: ACT, expectActivated: false, timezone: 'Africa/Cairo', expectTimezone: 'Asia/Riyadh' }),
    (e: unknown) => e instanceof ImportHttpError && e.message !== IMPORT_LEDGER_TIMEZONE_CHANGED_MESSAGE && e.details.expectedTimezone === 'Asia/Riyadh');
  // الحجز يقرأ المنطقة تحت القفل ويقارنها بمنطقة حساب التواريخ التي مرّرها المسار
  const src = read('routes/import.ts');
  const rf = src.slice(src.indexOf('async function reserveEntryBatch('), src.indexOf('\n}\n', src.indexOf('async function reserveEntryBatch(')));
  assert.match(rf, /select: \{ activatedAt: true, timezone: true, setupDraft: true \}/);
  // البند 22: المنطقة المقارَنة تحت القفل هي المضبوطة فعلاً (explicitTimezone) — المنطقة نفسها التي كُتبت بها اللحظات
  assert.match(rf, /timezone: explicitTimezone\(gs\), expectTimezone/);
  assert.equal(explicitTimezone({ activatedAt: null, timezone: 'Africa/Cairo', setupDraft: { step1: { timezone: 'Asia/Riyadh' } } }), 'Asia/Riyadh', 'قبل التفعيل: مسودة الخطوة 1 أولاً');
  assert.equal(explicitTimezone({ activatedAt: new Date(), timezone: 'Africa/Cairo', setupDraft: { step1: { timezone: 'Asia/Riyadh' } } }), 'Africa/Cairo', 'بعد التفعيل: الإعدادات');
  // شركة بلا إعدادات دفاتر: null في الطرفين (لا افتراض الرياض) فلا 409 كاذب ولا إزاحة يوم
  assert.equal(explicitTimezone(null), null);
  assert.doesNotThrow(() => assertImportLedgerStateUnchanged({ activatedAt: null, expectActivated: false, timezone: null, expectTimezone: null }));
  assert.throws(() => assertImportLedgerStateUnchanged({ activatedAt: null, expectActivated: false, timezone: 'Asia/Riyadh', expectTimezone: null }),
    (e: unknown) => e instanceof ImportHttpError && e.message === IMPORT_LEDGER_TIMEZONE_CHANGED_MESSAGE);
  // مهلة القفل (lock_timeout) ومهلة المعاملة تُصنَّفان انشغالاً ⇒ IMPORT_LEDGER_BUSY
  assert.equal(isLockBusyError({ code: 'P2028' }), true);
  assert.equal(isLockBusyError(new Error('Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`')), true);
  assert.equal(isLockBusyError(new Error('other')), false);
});
