// البندان 18 و19 (مراجعة استيراد البيانات 2026-09-17): إعادة حساب الأرصدة بعد التراجع عن دفعة أرصدة/كشوف داخل معاملة
// الحذف نفسها بقفل import-entries وقفل صفوف العملاء، ووسم reverted فيها؛ واستيراد الكشف يقفل صف العميل قبل قراءة رصيده.
// حراس ثابتة + قاعدة الاستيراد الجاري الصرفة، بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ImportHttpError, IMPORT_RUNNING_STALE_MS, otherRunningEntryImport } from '../services/importLedger';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const NOW = new Date('2026-09-17T10:00:00Z');

function orderedIn(text: string, needles: string[], label: string): void {
  let pos = -1;
  for (const n of needles) {
    const k = text.indexOf(n, pos + 1);
    assert.ok(k > pos, `${label}: «${n}» مفقود أو خارج الترتيب`);
    pos = k;
  }
}

test('سيناريو البند 19(ج): دفعة أرصدة/كشوف أخرى جارية ⇒ 409 IMPORT_IN_PROGRESS للتراجع، والمنقطعة والدفعة نفسها لا', () => {
  const running = { id: 'b2', kind: 'ledger', createdAt: new Date(NOW.getTime() - 60_000), status: 'running', heartbeatAt: new Date(NOW.getTime() - 5_000) };
  assert.throws(() => otherRunningEntryImport([running], 'b1', NOW), (e: unknown) => {
    assert.ok(e instanceof ImportHttpError);
    assert.deepEqual([e.status, e.code, e.details.batchId, e.details.kind], [409, 'IMPORT_IN_PROGRESS', 'b2', 'ledger']);
    return true;
  });
  assert.doesNotThrow(() => otherRunningEntryImport([running], 'b2', NOW));
  assert.doesNotThrow(() => otherRunningEntryImport([{ ...running, heartbeatAt: new Date(NOW.getTime() - IMPORT_RUNNING_STALE_MS - 1) }], 'b1', NOW));
  assert.doesNotThrow(() => otherRunningEntryImport([{ ...running, kind: 'customers' }], 'b1', NOW));
});

test('حارس ثابت (البند 18): تراجع balances/ledger — قفل import-entries بعد acquirePostLock، وإعادة قراءة الدفعة، وإعادة الحساب ووسم reverted داخل المعاملة', () => {
  const src = read('routes/import.ts');
  const rv = src.slice(src.indexOf("router.post('/batches/:id/revert'"));
  const branch = rv.slice(rv.indexOf("} else if (batch.kind === 'balances' || batch.kind === 'ledger') {"), rv.indexOf("} else if (batch.kind === 'prices') {"));
  const txStart = branch.indexOf('prisma.$transaction(async tx => {');
  const txEnd = branch.indexOf('}, { maxWait', txStart);
  assert.ok(txStart > 0 && txEnd > txStart);
  const tx = branch.slice(txStart, txEnd);
  orderedIn(tx, [
    "SET LOCAL lock_timeout = '5s'", 'acquirePostLock(tx, tid)', 'pg_advisory_xact_lock(hashtext(${IMPORT_ENTRIES_LOCK_PREFIX + tid}::text))',
    'tx.importBatch.findFirst({ where: { id: batch.id, tenantId: tid, reverted: false }', "'IMPORT_BATCH_GONE'", 'otherRunningEntryImport(',
    'tx.accountEntry.findMany(', 'ledgerTombstones(tx', 'tx.accountEntry.deleteMany(',
    'ORDER BY id FOR UPDATE', 'UPDATE account_entries ae SET balance = s.run', 'ROWS UNBOUNDED PRECEDING', 'UPDATE customers c SET balance = COALESCE(',
    'tx.importBatch.update({ where: { id: batch.id }, data: { reverted: true } })',
  ], 'تراجع الأرصدة');
  assert.doesNotMatch(branch, /prisma\.customer\.update\(|prisma\.accountEntry\.update\(|prisma\.accountEntry\.findMany\(/, 'إعادة الحساب خارج المعاملة');
  assert.match(branch, /if \(!isImportHttpError\(e\) && isLockBusyError\(e\)\)/, 'خطأ HTTP برمز لا يصير 409 مشغول');
  // الوسم العام بعد الفروع لا يعيد وسم الأرصدة خارج المعاملة
  const tail = rv.slice(rv.indexOf("} else if (batch.kind === OPENING_STOCK_KIND) {"));
  assert.match(tail, /if \(!\(IMPORT_ENTRY_KINDS as readonly string\[\]\)\.includes\(batch\.kind\)\) await prisma\.importBatch\.update/);
  assert.match(src, /^import \{ Prisma \} from '@prisma\/client';$/m);
});

test('حارس ثابت (البند 19): /ledger يقفل صف العميل FOR UPDATE قبل currentBalance، و/balances يكتب الرصيد المحسوب تحت القفل', () => {
  const src = read('routes/import.ts');
  const li = src.indexOf("router.post('/ledger'");
  const ledger = src.slice(li, src.indexOf('\n});', li));
  orderedIn(ledger, ['writeItem: async (tx', 'SELECT id FROM customers WHERE id = ${cid} AND "tenantId" = ${tid} FOR UPDATE', 'currentBalance(tx, cid)', 'tx.accountEntry.create(', 'tx.customer.update({ where: { id: cid }, data: { balance: running } })'], '/ledger');
  const bi = src.indexOf("router.post('/balances'");
  const bal = src.slice(bi, src.indexOf('\n});', bi));
  assert.match(bal, /data: \{ balance: clean\(prev \+ amount\) \}/);
  assert.doesNotMatch(bal, /increment: amount/);
});
