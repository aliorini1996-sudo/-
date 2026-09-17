import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupRevertBlocked, revertReasonKey, REVERT_LEDGER_BUSY, REVERT_DELETE_FAILED,
  batchStatusView, hasRunningBatch, classifyRevertFailure, revertFailureKey,
  NETWORK_LOST_MESSAGE, OPENING_STOCK_REVERT_ACTIVE, REVERT_BATCH_RUNNING, REVERT_BATCH_GONE,
  importResultView, RESULT_FAILURE_TITLE, RESULT_SUCCESS_TITLE, RESULT_WARNING_TITLE,
  customerSkipReasonKey, similarWarningKey, duplicateConsequenceKey, IMPORT_IN_PROGRESS_TEXT,
  zeroPriceGate, buildImportBody, importButtonBlocked, classifyAccessFailure, accessFailureKey,
  REVERT_PERMISSION_DENIED, IMPORT_PERMISSION_DENIED, ACCOUNTING_DISABLED,
  importFieldLabel, previewCellValue,
} from './importRevert';
import { IMPORT_SCOPED_NOTE } from './importAccess';

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

// ═══ دفعة 1 من مراجعة 2026-09-17 ═══

const http403 = (data: unknown) => ({ isAxiosError: true, response: { status: 403, data } });

test('البندان 5 و21: التراجع المرفوض 403 بالنطاق أو الصلاحية أو الدفاتر يُصنَّف بمفتاح مفهوم لا «تعذر التراجع»', () => {
  const scoped = classifyRevertFailure(http403({ success: false, code: 'IMPORT_SCOPED_ADMIN', message: 'x' }));
  assert.deepEqual(scoped, { type: 'scopedAdmin' });
  assert.equal(revertFailureKey(scoped), IMPORT_SCOPED_NOTE);

  const denied = classifyRevertFailure(http403({ success: false, code: 'IMPORT_PERMISSION_DENIED', kind: 'balances', permission: 'canManageCustomers' }));
  assert.deepEqual(denied, { type: 'permissionDenied', kind: 'balances', permission: 'canManageCustomers' });
  assert.equal(revertFailureKey(denied), REVERT_PERMISSION_DENIED);

  const acc = classifyRevertFailure(http403({ success: false, code: 'ACCOUNTING_NOT_ALLOWED' }));
  assert.deepEqual(acc, { type: 'accountingDisabled' });
  assert.equal(revertFailureKey(acc), ACCOUNTING_DISABLED);
});

test('classifyAccessFailure للاستيراد: نص الاستيراد لا التراجع، والرموز الأخرى والانقطاع null', () => {
  const f = classifyAccessFailure(http403({ code: 'IMPORT_PERMISSION_DENIED', details: { kind: 'products' } }));
  assert.deepEqual(f, { type: 'permissionDenied', kind: 'products', permission: undefined });
  assert.equal(accessFailureKey(f!, 'import'), IMPORT_PERMISSION_DENIED);
  assert.equal(classifyAccessFailure(http403({ code: 'OTHER' })), null);
  assert.equal(classifyAccessFailure({ isAxiosError: true, code: 'ERR_NETWORK' }), null);
});

test('البند 8: 3000 صف غير مطابَق وصفر مضاف ⇒ فشل «لم يُستورد شيء» لا «تم الاستيراد»', () => {
  const errors = Array.from({ length: 3000 }, (_, i) => ({ row: i + 2, message: 'العميل غير موجود استورد العملاء أولا', code: 'CUSTOMER_NOT_FOUND' }));
  const v = importResultView({ created: 0, skipped: 0, errors });
  assert.equal(v.tone, 'failure');
  assert.equal(v.titleKey, RESULT_FAILURE_TITLE);
  assert.deepEqual(v.counts, { created: 0, attached: 0, skipped: 0, zero: 0, notFound: 3000, ambiguous: 0, otherErrors: 0 });
});

test('البند 8: النتيجة النظيفة نجاح، والجزئية تحذير بعدّ منفصل للملتبس والصفري والأخطاء الأخرى', () => {
  const ok = importResultView({ created: 10, skipped: 2, zero: 1, errors: [] });
  assert.equal(ok.tone, 'success');
  assert.equal(ok.titleKey, RESULT_SUCCESS_TITLE);
  const mixed = importResultView({
    created: 5, skipped: 0, zero: 3,
    errors: [
      { row: 2, message: 'm', code: 'CUSTOMER_AMBIGUOUS', value: '0500000001' },
      { row: 3, message: 'm', code: 'CUSTOMER_NOT_FOUND' },
      { row: 6, message: 'm', code: 'CUSTOMER_CODE_NOT_FOUND', value: '1001' },
      { row: 4, message: 'boom', code: 'ROW_WRITE_FAILED' },
      { row: 5, message: 'legacy' },
    ],
  });
  assert.equal(mixed.tone, 'warning');
  assert.equal(mixed.titleKey, RESULT_WARNING_TITLE);
  assert.deepEqual(mixed.counts, { created: 5, attached: 0, skipped: 0, zero: 3, notFound: 2, ambiguous: 1, otherErrors: 2 });
  // رد خادم قديم بلا errors
  assert.equal(importResultView({ created: 0 }).tone, 'failure');
});

test('البند 3: أسباب تخطي العملاء وتنبيه التشابه', () => {
  assert.equal(customerSkipReasonKey('CODE_EXISTS'), 'الكود موجود');
  assert.equal(customerSkipReasonKey('PHONE_EXISTS'), 'الجوال موجود');
  assert.equal(customerSkipReasonKey('NAME_EXISTS'), 'الاسم موجود');
  assert.equal(customerSkipReasonKey('CODE_ATTACHABLE'), 'عميل موجود بلا كود بالجوال أو الاسم نفسه');
  assert.equal(customerSkipReasonKey('X'), 'مكرر تخطي');
  assert.match(similarWarningKey('phone'), /جواله/);
  assert.match(similarWarningKey('name'), /اسمه/);
});

test('البند 20: نص «استيراد رغم التكرار» بحسب النوع، ونص الاستيراد الجاري عام', () => {
  assert.equal(duplicateConsequenceKey('balances'), 'استيراده مرة أخرى يضاعف الأرصدة');
  assert.equal(duplicateConsequenceKey('ledger'), 'استيراده مرة أخرى يضاعف الأرصدة');
  assert.equal(duplicateConsequenceKey('opening_stock'), 'استيراده مرة أخرى يضاعف الكميات');
  assert.equal(duplicateConsequenceKey('customers'), 'الصفوف القائمة تُتخطّى ولن يُضاف إلا الجديد');
  assert.equal(duplicateConsequenceKey('products'), 'الصفوف القائمة تُتخطّى ولن يُضاف إلا الجديد');
  assert.equal(duplicateConsequenceKey('prices'), 'يُعاد كتابة الأسعار نفسها في دفعة جديدة');
  assert.doesNotMatch(IMPORT_IN_PROGRESS_TEXT, /أرصدة أو كشوف/);
  // الأرصدة والكشوف تتحاجبان: «من هذا النوع» خاطئ حين يكون الجاري من النوع الآخر
  assert.doesNotMatch(IMPORT_IN_PROGRESS_TEXT, /من هذا النوع/);
});

test('البند 1: السعر الخاص الصفري يمنع الزر حتى الإقرار، وallowZeroPrice يُرسل بعد الإقرار فقط', () => {
  const rows = [{ customerCode: 'C1', productCode: 'P1', price: 0 }];
  assert.deepEqual(zeroPriceGate('prices', 2, false), { required: true, blocksImport: true, allowZeroPrice: false });
  assert.deepEqual(zeroPriceGate('prices', 0, false), { required: false, blocksImport: false, allowZeroPrice: false });
  assert.deepEqual(zeroPriceGate('products', 5, true), { required: false, blocksImport: false, allowZeroPrice: false });

  assert.equal('allowZeroPrice' in buildImportBody({ kind: 'prices', rows, ledgerKind: false, zeroPriceRows: 1, zeroPriceAck: false }), false);
  assert.deepEqual(buildImportBody({ kind: 'prices', rows, ledgerKind: false, zeroPriceRows: 1, zeroPriceAck: true }), { rows, allowZeroPrice: true });
  // إقرار بلا صفوف صفرية لا يرسل الإذن
  assert.deepEqual(buildImportBody({ kind: 'prices', rows, ledgerKind: false, zeroPriceRows: 0, zeroPriceAck: true }), { rows });

  assert.equal(importButtonBlocked({ rows: 3, zeroPrice: zeroPriceGate('prices', 1, false) }), true);
  assert.equal(importButtonBlocked({ rows: 3, zeroPrice: zeroPriceGate('prices', 1, true) }), false);
});

test('buildImportBody يحفظ السلوك القائم: التاريخ للأرصدة والكشوف، وحقول المخزون، وforce وconfirmOverlap', () => {
  const rows = [{ a: 1 }];
  assert.deepEqual(buildImportBody({ kind: 'ledger', rows, ledgerKind: true, undatedDate: '2026-01-01', flags: { force: true, confirmOverlap: true } }),
    { rows, undatedDate: '2026-01-01', force: true, confirmOverlap: true });
  assert.deepEqual(buildImportBody({ kind: 'customers', rows, ledgerKind: false, undatedDate: '2026-01-01' }), { rows });
  assert.deepEqual(buildImportBody({ kind: 'opening_stock', rows, ledgerKind: false, stockInclTax: true, stockAckBody: { acknowledgeCutoverChange: true } }),
    { rows, pricesIncludeTax: true, acknowledgeCutoverChange: true });
});

test('البنود 9 و12 و13: عوائق التحويل تعطّل زر الاستيراد', () => {
  assert.equal(importButtonBlocked({ rows: 10, blockers: ['عائق'] }), true);
  assert.equal(importButtonBlocked({ rows: 10, blockers: [] }), false);
  assert.equal(importButtonBlocked({ rows: 0 }), true);
  assert.equal(importButtonBlocked({ rows: 10, conflict: true }), true);
  assert.equal(importButtonBlocked({ rows: 10, needUndatedChoice: true }), true);
  assert.equal(importButtonBlocked({ rows: 10, stockBlocked: true }), true);
});

test('البند 13: خريطة الأعمدة تعرض اسم الحقل بالعربية والقيمة المحوّلة ولو اختلف مفتاح الصف المرسل', () => {
  assert.equal(importFieldLabel('basePrice'), 'السعر');
  assert.equal(importFieldLabel('name'), 'الاسم');
  assert.equal(importFieldLabel('mystery'), 'mystery');
  const balanceRow = { customerName: 'مؤسسة النور', customerCode: 'C1', balance: -700 };
  assert.equal(previewCellValue(balanceRow, 'name'), 'مؤسسة النور');
  assert.equal(previewCellValue(balanceRow, 'code'), 'C1');
  assert.equal(previewCellValue(balanceRow, 'balance'), -700);
  assert.equal(previewCellValue(balanceRow, 'phone'), undefined);
  // الحقل نفسه مقدَّم على البديل
  assert.equal(previewCellValue({ name: 'أ', customerName: 'ب' }, 'name'), 'أ');
});

test('الدفعة 2 (الانحدار 3): ربط الأكواد نتيجة ناجحة، والكود غير المسجّل بلا اسم يُعدّ «غير مطابق» بنصه الثابت', async () => {
  const { importRowErrorKey, attachedCodeKey, CUSTOMER_CODE_UNREGISTERED_MESSAGE } = await import('./importRevert');
  const onlyAttached = importResultView({ created: 0, attached: 3, skipped: 1, errors: [] });
  assert.deepEqual([onlyAttached.tone, onlyAttached.titleKey, onlyAttached.counts.attached], ['success', RESULT_SUCCESS_TITLE, 3]);
  assert.equal(importResultView({ created: 0, attached: 0, errors: [] }).tone, 'failure');
  const unreg = importResultView({ created: 1, errors: [{ row: 2, code: 'CUSTOMER_CODE_UNREGISTERED', message: 'm', value: 'C001' }] });
  assert.deepEqual([unreg.counts.notFound, unreg.counts.otherErrors], [1, 0]);
  assert.equal(importRowErrorKey({ code: 'CUSTOMER_CODE_UNREGISTERED', message: 'نص متغير' }), CUSTOMER_CODE_UNREGISTERED_MESSAGE);
  assert.equal(customerSkipReasonKey('CODE_AMBIGUOUS_NAME'), 'أكثر من عميل بلا كود بالاسم نفسه، أضف الجوال لتمييزه');
  assert.match(attachedCodeKey('phone'), /بالجوال/);
  assert.match(attachedCodeKey('name'), /بالاسم/);
});
