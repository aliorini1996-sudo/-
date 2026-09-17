import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupRevertBlocked, revertReasonKey, REVERT_LEDGER_BUSY, REVERT_DELETE_FAILED,
  batchStatusView, hasRunningBatch, classifyRevertFailure, revertFailureKey,
  NETWORK_LOST_MESSAGE, OPENING_STOCK_REVERT_ACTIVE, REVERT_BATCH_RUNNING, REVERT_BATCH_GONE,
} from './importRevert';

test('revertReasonKey: قفل الدفاتر وخطأ الحذف يُعادان، والباقي محمي بمفتاحه', () => {
  assert.deepEqual(revertReasonKey('جارٍ تفعيل الدفاتر، أعد المحاولة'), { key: REVERT_LEDGER_BUSY, retry: true });
  assert.deepEqual(revertReasonKey('تعذّر الحذف: deadlock detected'), { key: REVERT_DELETE_FAILED, retry: true });
  assert.deepEqual(revertReasonKey('للعميل فواتير'), { key: 'للعميل فواتير', retry: false });
  assert.deepEqual(revertReasonKey(undefined), { key: 'سجل محمي', retry: false });
});

test('groupRevertBlocked: 120 عميلاً بانشغال القفل لا تُسمّى «محمية»، والتجميع حسب السبب', () => {
  const busy = Array.from({ length: 120 }, (_, i) => ({ id: `c${i}`, name: `عميل ${i}`, reason: 'جارٍ تفعيل الدفاتر، أعد المحاولة' }));
  const g = groupRevertBlocked(busy);
  assert.equal(g.length, 1);
  assert.equal(g[0].retry, true);
  assert.equal(g[0].count, 120);

  const mixed = groupRevertBlocked([
    { name: 'أ', reason: 'تعذّر الحذف: x' },
    { name: 'ب', reason: 'للعميل فواتير' },
    { name: 'ج', reason: 'تعذّر الحذف: y' },
    { name: null, reason: 'للعميل فواتير' },
    { name: 'د', reason: 'مرتبط بسجلات أخرى' },
  ]);
  assert.deepEqual(mixed.map((x) => [x.key, x.retry, x.count, x.names]), [
    ['للعميل فواتير', false, 2, ['ب']],
    ['مرتبط بسجلات أخرى', false, 1, ['د']],
    ['تعذّر الحذف', true, 2, ['أ', 'ج']],
  ]);
});

test('batchStatusView: الجارية لا تُتراجع وعددها غير نهائي، والمنقطعة تُتراجع بعدد غير نهائي، والغائب منتهية', () => {
  assert.deepEqual(batchStatusView({ status: 'running' }), { status: 'running', label: 'قيد الاستيراد', revertable: false, countFinal: false });
  assert.deepEqual(batchStatusView({ status: 'interrupted' }), { status: 'interrupted', label: 'انقطع', revertable: true, countFinal: false });
  assert.deepEqual(batchStatusView({ status: 'done' }), { status: 'done', label: null, revertable: true, countFinal: true });
  assert.equal(batchStatusView({}).status, 'done');
  assert.equal(batchStatusView({ status: null }).status, 'done');
  assert.equal(batchStatusView({ status: 'weird' }).status, 'done');
  assert.equal(hasRunningBatch([{ status: 'done' }, { status: 'running' }]), true);
  assert.equal(hasRunningBatch([{ status: 'interrupted' }]), false);
  assert.equal(hasRunningBatch(undefined), false);
});

test('classifyRevertFailure: الانقطاع والدفعة الجارية وقفل الدفاتر والمخزون بعد التفعيل و404', () => {
  const http = (status: number, data: unknown) => ({ isAxiosError: true, response: { status, data } });
  const cases: [unknown, string, string | null][] = [
    [{ isAxiosError: true, code: 'ERR_NETWORK' }, 'network', NETWORK_LOST_MESSAGE],
    [http(409, { code: 'IMPORT_BATCH_RUNNING', batchId: 'b1' }), 'running', REVERT_BATCH_RUNNING],
    [http(409, { code: 'IMPORT_REVERT_LEDGER_BUSY', message: 'جارٍ تفعيل الدفاتر، أعد المحاولة' }), 'ledgerBusy', REVERT_LEDGER_BUSY],
    [http(409, { code: 'OPENING_STOCK_REVERT_LEDGER_ACTIVE', activatedAt: 'x' }), 'openingStockActive', OPENING_STOCK_REVERT_ACTIVE],
    [http(404, { message: 'الدفعة غير موجودة أو متراجع عنها' }), 'gone', REVERT_BATCH_GONE],
    [http(500, { message: 'boom' }), 'other', null],
  ];
  for (const [e, type, key] of cases) {
    const f = classifyRevertFailure(e);
    assert.equal(f.type, type);
    assert.equal(revertFailureKey(f), key);
  }
  assert.deepEqual(classifyRevertFailure(http(409, { code: 'IMPORT_BATCH_RUNNING', batchId: 'b1' })), { type: 'running', batchId: 'b1' });
});

test('groupRevertBlocked: أسباب حجب المخزون الافتتاحي محمية لا تُعاد', () => {
  const g = groupRevertBlocked([{ id: 'e1', name: 'مخزون افتتاحي (استيراد)', reason: 'بيعت أصناف المخزون الافتتاحي في فواتير' }]);
  assert.deepEqual(g.map((x) => [x.key, x.retry, x.count]), [['بيعت أصناف المخزون الافتتاحي في فواتير', false, 1]]);
});
