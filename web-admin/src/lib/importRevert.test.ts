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
  assert.deepEqual(v.counts, { created: 0, updated: 0, attached: 0, skipped: 0, zero: 0, notFound: 3000, ambiguous: 0, otherErrors: 0 });
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
  assert.deepEqual(mixed.counts, { created: 5, updated: 0, attached: 0, skipped: 0, zero: 3, notFound: 2, ambiguous: 1, otherErrors: 2 });
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
  // الدفعة 2 (البندان 15 و16): الصف المستورد سابقاً يُرفض ولا تتضاعف الكمية
  assert.equal(duplicateConsequenceKey('opening_stock'), 'الأصناف المستوردة سابقاً تُرفض صفاً صفاً ولا يُضاف إلا الجديد');
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
  // البند 51: الأرصدة والكشوف تحمل عقد التاريخ كذلك — الحقول الأخرى كما كانت
  assert.deepEqual(buildImportBody({ kind: 'ledger', rows, ledgerKind: true, undatedDate: '2026-01-01', flags: { force: true, confirmOverlap: true } }),
    { rows, undatedDate: '2026-01-01', dateContract: 'local-ymd-v2', force: true, confirmOverlap: true });
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

// ═══ الدفعة 2 من مراجعة 2026-09-17 ═══

test('البند 7: دفعة أسعار حدّثت أسعاراً قائمة بلا إنشاء ليست «لم يُستورد شيء»، ونص تأكيدها لا يَعِد بإعادة الأرصدة', async () => {
  const { revertConfirmKey, REVERT_CONFIRM_PRICES, REVERT_CONFIRM_GENERIC } = await import('./importRevert');
  const onlyUpdated = importResultView({ created: 0, updated: 7, skipped: 0, errors: [] });
  assert.equal(onlyUpdated.tone, 'success');
  assert.equal(onlyUpdated.titleKey, RESULT_SUCCESS_TITLE);
  assert.equal(onlyUpdated.counts.updated, 7);
  // لا created ولا updated ولا attached ⇒ فشل
  assert.equal(importResultView({ created: 0, updated: 0, errors: [] }).tone, 'failure');
  // رد بلا updated (نوع آخر أو خادم أقدم) ⇒ صفر لا NaN
  assert.equal(importResultView({ created: 4, errors: [] }).counts.updated, 0);
  // تحديث مع أخطاء صفوف ⇒ تحذير لا فشل
  assert.equal(importResultView({ created: 0, updated: 2, errors: [{ row: 2, message: 'm' }] }).tone, 'warning');

  assert.equal(revertConfirmKey('prices', false), REVERT_CONFIRM_PRICES);
  assert.equal(revertConfirmKey('prices', true), REVERT_CONFIRM_PRICES);
  assert.doesNotMatch(revertConfirmKey('prices', true), /الأرصدة/);
  assert.match(revertConfirmKey('prices', false), /بدفعة أحدث يبقى كما هو/);
  // المنتجات كذلك لا تَعِد بإعادة الأرصدة
  assert.doesNotMatch(revertConfirmKey('products', true), /الأرصدة/);
  assert.equal(revertConfirmKey(undefined, false), REVERT_CONFIRM_GENERIC);
});

test('البند 7: تغيّر السعر بعد الاستيراد سبب منع محمي لا «أعد المحاولة»', () => {
  const g = groupRevertBlocked([
    { id: '1', name: 'مؤسسة النور — P1', reason: 'تغيّر السعر بعد الاستيراد يدوياً أو بدفعة أحدث فلم يُعد' },
    { id: '2', name: 'مؤسسة النور — P2', reason: 'تغيّر السعر بعد الاستيراد يدوياً أو بدفعة أحدث فلم يُعد' },
  ]);
  assert.deepEqual(g.map((x) => [x.key, x.retry, x.count]), [['تغيّر السعر بعد الاستيراد يدوياً أو بدفعة أحدث فلم يُعد', false, 2]]);
});

test('البندان 15 و16: إعادة رفع المخزون الافتتاحي ترفض الصف المستورد ولا تضاعف الكميات، ورموز صفوفه بنصوصها الثابتة', async () => {
  const {
    importRowErrorKey: rowKey, openingStockRevertHint, OPENING_STOCK_REVERT_HINT,
    PRODUCT_INACTIVE_MESSAGE, PRODUCT_AMBIGUOUS_MESSAGE, OPENING_STOCK_ALREADY_IMPORTED_MESSAGE, PRODUCT_HAS_STOCK_MOVEMENTS_MESSAGE,
  } = await import('./importRevert');
  assert.equal(duplicateConsequenceKey('opening_stock'), 'الأصناف المستوردة سابقاً تُرفض صفاً صفاً ولا يُضاف إلا الجديد');
  assert.doesNotMatch(duplicateConsequenceKey('opening_stock'), /يضاعف/);

  // النص الثابت يُستعمل ولو غيّر الخادم صياغته
  assert.equal(rowKey({ code: 'PRODUCT_INACTIVE', message: 'نص متغير' }), PRODUCT_INACTIVE_MESSAGE);
  assert.equal(rowKey({ code: 'PRODUCT_AMBIGUOUS', message: 'نص متغير' }), PRODUCT_AMBIGUOUS_MESSAGE);
  assert.equal(rowKey({ code: 'OPENING_STOCK_ALREADY_IMPORTED', message: 'نص متغير' }), OPENING_STOCK_ALREADY_IMPORTED_MESSAGE);
  assert.equal(rowKey({ code: 'PRODUCT_HAS_STOCK_MOVEMENTS', message: 'نص متغير' }), PRODUCT_HAS_STOCK_MOVEMENTS_MESSAGE);
  // رمز بلا نص ثابت ⇒ رسالة الخادم
  assert.equal(rowKey({ code: 'STOCK_QTY_INVALID', message: 'الكمية يجب أن تكون أكبر من صفر' }), 'الكمية يجب أن تكون أكبر من صفر');
  assert.equal(rowKey({ message: 'بلا رمز' }), 'بلا رمز');

  // لم يُكتب شيء وكل الصفوف مستوردة سابقاً ⇒ تلميح التراجع عن الدفعة السابقة
  const allImported = { created: 0, errors: [{ row: 2, code: 'OPENING_STOCK_ALREADY_IMPORTED' }, { row: 3, code: 'PRODUCT_NOT_FOUND' }] };
  assert.equal(openingStockRevertHint('opening_stock', allImported), true);
  assert.equal(OPENING_STOCK_REVERT_HINT, 'تراجع عن الدفعة السابقة من سجل الاستيرادات لتصحيحها');
  // الاستيراد الجزئي كذلك: كُتب بعض الأصناف ورُفض بعضها ⇒ المالك يحتاج مسار التراجع نفسه
  assert.equal(openingStockRevertHint('opening_stock', { created: 2, errors: allImported.errors }), true);
  assert.equal(openingStockRevertHint('products', allImported), false);
  assert.equal(openingStockRevertHint('opening_stock', { created: 0, errors: [{ row: 2, code: 'PRODUCT_NOT_FOUND' }] }), false);
  assert.equal(openingStockRevertHint('opening_stock', { created: 0 }), false);

  // البند K: القيمة صارت تاريخ الدفعة السابقة (عقد الخادم) ⇒ عبارة تدلّ المالك على الدفعة التي يتراجع عنها
  const { importRowErrorValue, OPENING_STOCK_PREVIOUS_BATCH_DATE } = await import('./importRevert');
  const uuid = '9f3c1a2e-7b44-4c31-9a2b-2f1d5c7e8a90';
  assert.deepEqual(importRowErrorValue({ code: 'OPENING_STOCK_ALREADY_IMPORTED', value: '2026-03-14' }), { kind: 'previousBatchDate', date: '2026-03-14' });
  assert.deepEqual(importRowErrorValue({ code: 'OPENING_STOCK_ALREADY_IMPORTED', value: ' 2026-03-14 ' }), { kind: 'previousBatchDate', date: '2026-03-14' });
  assert.equal(OPENING_STOCK_PREVIOUS_BATCH_DATE, 'استُوردت سابقاً في دفعة بتاريخ {date}');
  assert.match(OPENING_STOCK_PREVIOUS_BATCH_DATE, /\{date\}/);
  // حارس الشكل: معرّف الدفعة (خادم أقدم) أو أي نص ليس تاريخاً يبقى محجوباً كما كان
  assert.equal(importRowErrorValue({ code: 'OPENING_STOCK_ALREADY_IMPORTED', value: uuid }), null);
  assert.equal(importRowErrorValue({ code: 'OPENING_STOCK_ALREADY_IMPORTED', value: 'batch' }), null);
  assert.equal(importRowErrorValue({ code: 'OPENING_STOCK_ALREADY_IMPORTED', value: '2026-13-01' }), null);
  assert.equal(importRowErrorValue({ code: 'OPENING_STOCK_ALREADY_IMPORTED', value: '2026-03-14T00:00:00.000Z' }), null);
  // أي معرّف UUID في أي رمز يُحجب احتياطاً
  assert.equal(importRowErrorValue({ code: 'ROW_WRITE_FAILED', value: uuid }), null);
  // وما ينفع المالك يبقى: كود الصنف والمبلغ والجوال
  assert.deepEqual(importRowErrorValue({ code: 'PRODUCT_CODE_ARCHIVED', value: 'P1' }), { kind: 'text', value: 'P1' });
  assert.deepEqual(importRowErrorValue({ code: 'PRODUCT_DUPLICATE_IN_FILE', value: 'P1' }), { kind: 'text', value: 'P1' });
  assert.deepEqual(importRowErrorValue({ value: '1,500' }), { kind: 'text', value: '1,500' });
  assert.equal(importRowErrorValue({ code: 'STOCK_QTY_INVALID' }), null);
  assert.equal(importRowErrorValue({ value: '   ' }), null);
  assert.equal(importRowErrorValue(undefined), null);
  // والواجهة تمرّ بالدالة لا بـer.value الخام في موضعَي عرض أخطاء الصفوف، والتاريخ بتنسيق الواجهة عبر tr
  const fs = await import('node:fs');
  const path = await import('node:path');
  const panel = fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'DataImportPanel.tsx'), 'utf8');
  assert.equal(panel.match(/<RowErrorValue er=\{er\} tr=\{tr\} \/>/g)?.length, 2, 'عرض أخطاء الصفوف لا يمرّ بـRowErrorValue');
  assert.match(panel, /importRowErrorValue\(er\)/);
  assert.match(panel, /tr\(OPENING_STOCK_PREVIOUS_BATCH_DATE\)\.replace\('\{date\}', formatDayOnly\(v\.date\)\)/);
  assert.doesNotMatch(panel, /\{er\.value \? </);
});

test('البند 17: أسباب منع حذف العميل الأربعة محمية لا «أعد المحاولة»، ونص التأكيد يذكرها', async () => {
  const { revertConfirmKey, REVERT_CONFIRM_CUSTOMERS } = await import('./importRevert');
  const g = groupRevertBlocked([
    { id: 'c1', name: 'أ', reason: 'للعميل رصيد أو كشف مستورد، تراجع عنه أولاً' },
    { id: 'c2', name: 'ب', reason: 'للعميل قيود في كشف الحساب' },
    { id: 'c3', name: 'ج', reason: 'للعميل أسعار خاصة، تراجع عن دفعة الأسعار أو احذفها أولاً' },
    { id: 'c4', name: 'د', reason: 'للعميل محطات في خطوط سير المناديب' },
    { id: 'c5', name: 'هـ', reason: 'للعميل رصيد أو كشف مستورد، تراجع عنه أولاً' },
  ]);
  assert.equal(g.every((x) => !x.retry), true);
  assert.deepEqual(g.map((x) => [x.key, x.count]), [
    ['للعميل رصيد أو كشف مستورد، تراجع عنه أولاً', 2],
    ['للعميل قيود في كشف الحساب', 1],
    ['للعميل أسعار خاصة، تراجع عن دفعة الأسعار أو احذفها أولاً', 1],
    ['للعميل محطات في خطوط سير المناديب', 1],
  ]);
  // العملاء مع الدفاتر مفعّلة: نص العملاء لا نص القيود العكسية
  assert.equal(revertConfirmKey('customers', true), REVERT_CONFIRM_CUSTOMERS);
  assert.match(REVERT_CONFIRM_CUSTOMERS, /قيود في كشف الحساب/);
  assert.match(REVERT_CONFIRM_CUSTOMERS, /أسعار خاصة/);
  assert.match(REVERT_CONFIRM_CUSTOMERS, /محطات في خطوط السير/);
});

test('البند 19: 409 IMPORT_IN_PROGRESS على التراجع يُصنَّف inProgress بنصه لا «تعذر التراجع»', async () => {
  const { revertConfirmKey, REVERT_CONFIRM_ENTRIES, REVERT_CONFIRM_LEDGER_ACTIVE } = await import('./importRevert');
  const e = { isAxiosError: true, response: { status: 409, data: { success: false, code: 'IMPORT_IN_PROGRESS', message: 'x', details: { batchId: 'b9', kind: 'ledger', createdAt: '2026-09-17T00:00:00.000Z' } } } };
  const f = classifyRevertFailure(e);
  assert.deepEqual(f, { type: 'inProgress', kind: 'ledger' });
  assert.equal(revertFailureKey(f), IMPORT_IN_PROGRESS_TEXT);
  assert.deepEqual(classifyRevertFailure({ isAxiosError: true, response: { status: 409, data: { code: 'IMPORT_IN_PROGRESS' } } }), { type: 'inProgress', kind: undefined });
  // نص التراجع عن القيود قبل التفعيل وبعده
  assert.equal(revertConfirmKey('balances', false), REVERT_CONFIRM_ENTRIES);
  assert.equal(revertConfirmKey('ledger', true), REVERT_CONFIRM_LEDGER_ACTIVE);
});

test('البند 30: أسباب تخطي صفوف المنتجات مفصولة عن أسباب العملاء', async () => {
  const { productSkipReasonKey, importRowErrorKey: rowKey, PRODUCT_CODE_ARCHIVED_MESSAGE, PRODUCT_DUPLICATE_IN_FILE_MESSAGE } = await import('./importRevert');
  assert.equal(productSkipReasonKey('CODE_EXISTS'), 'الكود موجود');
  assert.equal(productSkipReasonKey('DUPLICATE_IN_FILE'), 'مكرر داخل الملف بالبيانات نفسها');
  assert.equal(productSkipReasonKey(undefined), 'مكرر تخطي');
  assert.equal(productSkipReasonKey('X'), 'مكرر تخطي');
  // لا يُخلط بأسباب العملاء
  assert.equal(productSkipReasonKey('PHONE_EXISTS'), 'مكرر تخطي');
  assert.equal(rowKey({ code: 'PRODUCT_CODE_ARCHIVED', message: 'نص متغير', value: 'P1' }), PRODUCT_CODE_ARCHIVED_MESSAGE);
  assert.equal(rowKey({ code: 'PRODUCT_DUPLICATE_IN_FILE', message: 'نص متغير', value: 'P1' }), PRODUCT_DUPLICATE_IN_FILE_MESSAGE);
});

test('ملخّص التراجع يعرض ما سبق التراجع عنه وكل تابع حُذف، والحقل الغائب أو الصفري بلا سطر', async () => {
  const {
    revertSummaryLines, REVERT_ALREADY_REVERTED, REVERT_REMOVED_ENTRIES, REVERT_REMOVED_PRICES,
    REVERT_REMOVED_NOTIFICATIONS, REVERT_REMOVED_ASSIGNMENTS, REVERT_REMOVED_SCOPES,
  } = await import('./importRevert');
  // دفعة الأسعار: إعادة المحاولة بعد انقطاع — الصفوف المعادة سلفاً ليست ضائعة
  assert.deepEqual(revertSummaryLines({ alreadyReverted: 3 }), [{ key: REVERT_ALREADY_REVERTED, count: 3 }]);
  // دفعة العملاء: كل تابع حُذف يُذكر — عقد «لا حذف صامت»
  assert.deepEqual(
    revertSummaryLines({ removedEntries: 4, removedPrices: 2, removedNotifications: 1, removedAssignments: 5, removedScopes: 6 }),
    [
      { key: REVERT_REMOVED_ENTRIES, count: 4 },
      { key: REVERT_REMOVED_PRICES, count: 2 },
      { key: REVERT_REMOVED_NOTIFICATIONS, count: 1 },
      { key: REVERT_REMOVED_ASSIGNMENTS, count: 5 },
      { key: REVERT_REMOVED_SCOPES, count: 6 },
    ],
  );
  // الصفر لا سطر له («قيود حُذفت: 0» ضجيج)، والحقل الغائب (خادم أقدم) كذلك
  assert.deepEqual(revertSummaryLines({ removedEntries: 0, removedPrices: 0, removedNotifications: 0, removedAssignments: 0, removedScopes: 0 }), []);
  assert.deepEqual(revertSummaryLines({ removedPrices: 7 }), [{ key: REVERT_REMOVED_PRICES, count: 7 }]);
  assert.deepEqual(revertSummaryLines({}), []);
  assert.deepEqual(revertSummaryLines(undefined), []);
  assert.deepEqual(revertSummaryLines(null), []);
  // قيمة غير رقمية أو سالبة من خادم غريب لا تكسر الملخّص
  assert.deepEqual(revertSummaryLines({ removedEntries: '4', removedPrices: null, removedNotifications: Number.NaN, removedAssignments: -1, alreadyReverted: {} }), []);

  const fs = await import('node:fs');
  const path = await import('node:path');
  const panel = fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'DataImportPanel.tsx'), 'utf8');
  assert.match(panel, /revertSummaryLines\(d\)/, 'ملخّص التراجع لا يُعرض في نتيجة التراجع');
  assert.match(panel, /msg \+= ` · \$\{tr\(l\.key\)\}: \$\{l\.count\}`/);
  // كل مفتاح عربي هنا في القاموس — langs.test لا تلتقط مفاتيح tr() الديناميكية
  const dict = fs.readFileSync(path.resolve(process.cwd(), 'src', 'i18n', 'strings.ts'), 'utf8');
  for (const k of [REVERT_ALREADY_REVERTED, REVERT_REMOVED_ENTRIES, REVERT_REMOVED_PRICES, REVERT_REMOVED_NOTIFICATIONS, REVERT_REMOVED_ASSIGNMENTS, REVERT_REMOVED_SCOPES]) {
    assert.ok(dict.includes(`  '${k}': {`), `مفتاح غائب عن القاموس: ${k}`);
  }
});

test('البند L: خانة قيمة خطأ الصف تُعرض حين تفيد، وحارس الشكل والتكرار يكتمان ما لا يفيد', async () => {
  const { importRowErrorFieldKey, importFieldLabel: label } = await import('./importRevert');
  const uuid = '9f3c1a2e-7b44-4c31-9a2b-2f1d5c7e8a90';
  // الجرد الافتتاحي: الخادم يرسل عمود المعرّف مع كل خطأ صف ⇒ «كود الصنف: C1»
  assert.equal(importRowErrorFieldKey({ code: 'PRODUCT_NOT_FOUND', message: 'الصنف غير موجود استورد المنتجات أولا', value: 'C1', field: 'productCode' }), 'كود الصنف');
  assert.equal(importRowErrorFieldKey({ code: 'STOCK_QTY_INVALID', message: 'الكمية يجب أن تكون أكبر من صفر', value: '6281', field: 'barcode' }), 'باركود');
  assert.equal(importRowErrorFieldKey({ code: 'STOCK_NET_COST_ZERO', message: 'تكلفة الوحدة الصافية صفرية بعد التقريب', value: 'بيبسي', field: 'productName' }), 'اسم الصنف');
  assert.equal(label('productName'), 'اسم الصنف');
  // الرمز المعروف يُقرأ نصه الثابت لا رسالة الخادم المتغيّرة: «كود الصنف مكرر…» تذكرها سلفاً
  assert.equal(importRowErrorFieldKey({ code: 'PRODUCT_DUPLICATE_IN_FILE', message: 'نص خادم متغيّر', value: 'C1', field: 'productCode' }), null);
  assert.equal(importRowErrorFieldKey({ code: 'PRODUCT_INACTIVE', message: 'نص خادم متغيّر', value: 'C1', field: 'productCode' }), 'كود الصنف');
  // أخطاء المعاينة: الرسالة تذكر الخانة ⇒ لا تُكرَّر، ولا تذكرها ⇒ تُعرض
  assert.equal(importRowErrorFieldKey({ message: 'السعر لا يكون سالباً', value: '-5', field: 'basePrice' }), null);
  assert.equal(importRowErrorFieldKey({ message: 'المدفوع أو المتبقي خارج حدود مبلغ الفاتورة', value: '900', field: 'residual' }), null);
  assert.equal(importRowErrorFieldKey({ message: 'قيمة رقمية غير مفهومة', value: '1.500', field: 'balance' }), 'الرصيد');
  // حارس الشكل باقٍ: OPENING_STOCK_ALREADY_IMPORTED لا يعرض إلا تاريخاً، ولا UUID ولا خانة معه
  assert.equal(importRowErrorFieldKey({ code: 'OPENING_STOCK_ALREADY_IMPORTED', value: '2026-03-14', field: 'productCode' }), null);
  assert.equal(importRowErrorFieldKey({ code: 'OPENING_STOCK_ALREADY_IMPORTED', value: uuid, field: 'productCode' }), null);
  assert.equal(importRowErrorFieldKey({ code: 'ROW_WRITE_FAILED', value: uuid, field: 'productCode' }), null);
  // خانة بلا وسم عربي (اسم داخلي) أو بلا قيمة أو بلا خانة: لا شيء يُعرض
  assert.equal(importRowErrorFieldKey({ message: 'خطأ', value: 'x', field: 'mystery' }), null);
  assert.equal(importRowErrorFieldKey({ message: 'خطأ', value: 'x', field: '  ' }), null);
  assert.equal(importRowErrorFieldKey({ message: 'خطأ', value: 'x' }), null);
  assert.equal(importRowErrorFieldKey({ message: 'خطأ', field: 'productCode' }), null);
  assert.equal(importRowErrorFieldKey(undefined), null);

  const fs = await import('node:fs');
  const path = await import('node:path');
  const panel = fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'DataImportPanel.tsx'), 'utf8');
  assert.match(panel, /importRowErrorFieldKey\(er\)/, 'عرض خطأ الصف لا يقرأ الخانة');
  assert.match(panel, /field \? <> — \{tr\(field\)\}<\/> : null/);
});

const panelSource = async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'DataImportPanel.tsx'), 'utf8');
};

test('البند 31: خانة «الأسعار شاملة الضريبة» في المنتجات والأسعار وحدهما، وتأكيد تلقائي من عنوان العمود', async () => {
  const {
    inclusiveTaxKind, inclusiveTaxDetected, buildImportBody: build,
  } = await import('./importRevert');
  // الكشف نفسه المستعمل في المعاينة (importData) لا قاعدة محلية ثانية
  const { headerSaysPriceIncludesTax } = await import('./importData');
  assert.equal(inclusiveTaxKind('products'), true);
  assert.equal(inclusiveTaxKind('prices'), true);
  // للمخزون الافتتاحي خانته الخاصة، والأنواع الأخرى بلا أسعار
  assert.equal(inclusiveTaxKind('opening_stock'), false);
  assert.equal(inclusiveTaxKind('balances'), false);
  assert.equal(inclusiveTaxKind('toString'), false);

  // عنوان عمود السعر: «شامل/شاملة» بالتشكيل أو بالتطويل، و«incl» بأي حالة — مع كلمة ضريبة
  assert.equal(headerSaysPriceIncludesTax('السعر شامل الضريبة'), true);
  assert.equal(headerSaysPriceIncludesTax('سعر البيع شاملة الضريبة'), true);
  assert.equal(headerSaysPriceIncludesTax('شـامل الضريبة'), true);
  assert.equal(headerSaysPriceIncludesTax('Unit Price Incl. VAT'), true);
  assert.equal(headerSaysPriceIncludesTax('سعر البيع'), false);
  assert.equal(headerSaysPriceIncludesTax(null), false);

  // المنتجات على basePrice والأسعار على price — وعنوان عمود آخر لا يحسم
  assert.equal(inclusiveTaxDetected('products', [{ field: 'basePrice', header: 'السعر شامل الضريبة' }]), true);
  assert.equal(inclusiveTaxDetected('products', [{ field: 'taxPct', header: 'الضريبة شاملة' }, { field: 'basePrice', header: 'سعر البيع' }]), false);
  assert.equal(inclusiveTaxDetected('prices', [{ field: 'price', header: 'السعر الخاص شامل الضريبة' }]), true);
  assert.equal(inclusiveTaxDetected('prices', [{ field: 'price', header: null }]), false);
  assert.equal(inclusiveTaxDetected('customers', [{ field: 'basePrice', header: 'شامل' }]), false);
  assert.equal(inclusiveTaxDetected('products', undefined), false);

  // 🔴 خلل مالي: «شامل» بلا كلمة ضريبة، أو منفيّة، لا تُحدِّد الخانة — وإلا قُسمت أسعار المالك الصافية على 1.15
  for (const header of [
    'غير شامل الضريبة', 'السعر غير شامل الضريبة', 'Price excl. VAT', 'السعر قبل الضريبة', 'السعر بدون ضريبة',
    'السعر شامل الخصم', 'السعر شامل التوصيل', 'Price incl. delivery', 'شامل', 'incl',
  ]) {
    assert.equal(headerSaysPriceIncludesTax(header), false, `عنوان بريء يُحدِّد الخانة: ${header}`);
    assert.equal(inclusiveTaxDetected('products', [{ field: 'basePrice', header }]), false, `المنتجات: ${header}`);
    assert.equal(inclusiveTaxDetected('prices', [{ field: 'price', header }]), false, `الأسعار: ${header}`);
  }
  // وما يقوله فعلاً يبقى مكشوفاً
  for (const header of ['السعر شامل الضريبة', 'شامل ضريبة القيمة المضافة', 'Unit Price Incl. Tax', 'price incl vat']) {
    assert.equal(headerSaysPriceIncludesTax(header), true, `عنوان شامل الضريبة لم يُكشف: ${header}`);
    assert.equal(inclusiveTaxDetected('products', [{ field: 'basePrice', header }]), true, `المنتجات: ${header}`);
  }

  // الإرسال: العلم مع المنتجات والأسعار حين يُحدَّد وحده، ولا يتسرّب إلى نوع آخر
  const rows = [{ code: 'P1', basePrice: 115 }];
  assert.deepEqual(build({ kind: 'products', rows, ledgerKind: false, pricesIncludeTax: true }), { rows, pricesIncludeTax: true });
  assert.deepEqual(build({ kind: 'products', rows, ledgerKind: false, pricesIncludeTax: false }), { rows });
  assert.deepEqual(build({ kind: 'products', rows, ledgerKind: false }), { rows });
  assert.deepEqual(build({ kind: 'prices', rows, ledgerKind: false, pricesIncludeTax: true }), { rows, pricesIncludeTax: true });
  assert.deepEqual(build({ kind: 'customers', rows, ledgerKind: false, pricesIncludeTax: true }), { rows });
  // خانة المخزون الافتتاحي كما كانت: تُرسل دائماً بقيمتها
  assert.deepEqual(build({ kind: 'opening_stock', rows, ledgerKind: false, stockInclTax: false, pricesIncludeTax: true }), { rows, pricesIncludeTax: false });

  const panel = await panelSource();
  assert.match(panel, /const inclusiveChosen = priceInclTax \?\? inclusiveDetected;/, 'الخانة لا تأخذ قرار المالك ثم عنوان العمود');
  assert.match(panel, /pricesIncludeTax = view\?\.inclusiveChosen \?\? priceInclTax \?\? false/, 'العلم المُرسل لا يتبع الخانة المعروضة');
  assert.match(panel, /zeroPriceAck, pricesIncludeTax,/, 'العلم لا يُرسل مع جسم الاستيراد');
  assert.match(panel, /setPriceInclTax\(null\)/, 'الخانة لا تُصفَّر مع كل ملف جديد');
});

test('البند 31: اقتراح «فعّل الخيار» يسكت بعد تأشير الخانة (لا تنبيه لا يُطفأ)', async () => {
  const { PRICE_INCL_TAX_SUGGESTED_NOTICE, IMPORT_TYPES } = await import('./importData');
  const rows = [{ 'كود الصنف': 'P1', 'اسم الصنف': 'صنف', 'السعر شامل الضريبة': '115' }];
  const has = (o?: { pricesIncludeTax?: boolean }) =>
    (IMPORT_TYPES.products.transform(rows, o).notices ?? []).some((n) => n.key === PRICE_INCL_TAX_SUGGESTED_NOTICE);
  // بلا خيار: الاقتراح يظهر — ومع الخيار: يسكت (chosen يصل التحويل)
  assert.equal(has(), true, 'الاقتراح لا يظهر والعنوان يقول شامل الضريبة');
  assert.equal(has({ pricesIncludeTax: false }), true);
  assert.equal(has({ pricesIncludeTax: true }), false, 'الاقتراح يبقى بعد تأشير الخانة');

  const panel = await panelSource();
  // خيار المالك الصريح يصل التحويل، والتأشير التلقائي يُسقط الاقتراح من قائمة التنبيهات
  assert.match(panel, /pricesIncludeTax: priceInclTax === true,/, 'التحويل لا يعرف بخيار المالك');
  assert.match(panel, /\.filter\(\(n\) => !\(inclusiveChosen && n\.key === PRICE_INCL_TAX_SUGGESTED_NOTICE\)\)/, 'الاقتراح لا يُسقَط والخانة مؤشّرة');
  // إعادة التحويل عند تبديل الخانة: بلا هذه الاعتمادية يبقى التنبيه من حساب قديم
  assert.match(panel, /zeroPriceAck, companyDecimals, priceInclTax\]\)/, 'تبديل الخانة لا يعيد حساب المعاينة');
});

test('البند 31: نتيجة الاستيراد تقول إن الأسعار حُفظت صافية، وبعددها إن أرسله الخادم', async () => {
  const { netFromInclusiveCount, PRICES_SAVED_NET } = await import('./importRevert');
  // الجذر أولاً ثم التنبيهات — أيّهما وضع فيه الخادم العدّ
  assert.equal(netFromInclusiveCount({ netFromInclusive: 12 }), 12);
  assert.equal(netFromInclusiveCount({ warnings: { netFromInclusive: 7 } }), 7);
  // خادم لا يرسل العدّ (أو يرسل صفراً أو قيمة غريبة): العبارة بلا عدد لا عدد مختلَق
  assert.equal(netFromInclusiveCount({}), 0);
  assert.equal(netFromInclusiveCount({ netFromInclusive: 0 }), 0);
  assert.equal(netFromInclusiveCount({ netFromInclusive: '12' as unknown as number }), 0);
  assert.equal(netFromInclusiveCount({ warnings: null }), 0);
  assert.equal(netFromInclusiveCount(undefined), 0);

  const panel = await panelSource();
  // العبارة معلّقة على ما أُرسل فعلاً في الجسم لا على حالة الخانة بعد إغلاق المعاينة
  assert.match(panel, /sentInclusiveTax: body\.pricesIncludeTax === true && inclusiveTaxKind\(kind\)/, 'النتيجة لا تعرف بم أُرسل الملف');
  // لا تُقال العبارة إن لم يُكتب سعر واحد («لم يُستورد شيء» لا يُخصم فيه شيء)
  assert.match(panel, /result\.sentInclusiveTax && rv\.counts\.created \+ rv\.counts\.updated > 0/, 'نتيجة الاستيراد لا تذكر خصم الضريبة');
  assert.ok(panel.includes('{tr(PRICES_SAVED_NET)}'), 'عبارة الحفظ الصافي غائبة عن النافذة');
  assert.ok(PRICES_SAVED_NET.includes('صافي'), 'العبارة لا تقول للمالك إن المحفوظ صافٍ');
});

test('البند 36: حد صفوف الخادم يُعرض قبل الإرسال، ورفض الملف كله يُفصَّل بسطره وسببه', async () => {
  const {
    rowsOverMax, IMPORT_MAX_ROWS, importButtonBlocked: blocked, importValidationRejection, isPayloadTooLarge,
    payloadBytes, megabytes,
  } = await import('./importRevert');
  assert.equal(IMPORT_MAX_ROWS.customers, 5000);
  assert.equal(IMPORT_MAX_ROWS.ledger, 20000);
  assert.deepEqual(rowsOverMax('customers', 5001), { rows: 5001, max: 5000 });
  assert.equal(rowsOverMax('customers', 5000), null);
  assert.equal(rowsOverMax('ledger', 5001), null);
  // نوع لا يعرفه الجدول: لا ادّعاء حدّ — الخادم يحسم
  assert.equal(rowsOverMax('mystery', 99999), null);
  assert.equal(blocked({ rows: 5001, overMax: true }), true);
  assert.equal(blocked({ rows: 5001, overMax: false }), false);

  // خادم يرسل issues بمسارها: موضع الصف المرسل ⇒ ترقيم الخادم (+2) ليمرّ على fileRowOf، والحقل معه
  const withIssues = {
    isAxiosError: true,
    response: { status: 400, data: { success: false, message: 'بيانات غير صحيحة rows', issues: [
      { path: ['rows', 3, 'creditLimit'], message: 'Number must be greater than or equal to 0' },
      { path: ['rows', 40, 'taxPct'], message: 'Number must be less than or equal to 100' },
      { path: ['rows'], message: 'Array must contain at most 5000 element(s)' },
    ] } },
  };
  assert.deepEqual(importValidationRejection(withIssues)?.details, [
    { row: 5, field: 'creditLimit', message: 'Number must be greater than or equal to 0' },
    { row: 42, field: 'taxPct', message: 'Number must be less than or equal to 100' },
    { row: undefined, field: undefined, message: 'Array must contain at most 5000 element(s)' },
  ]);
  // الخادم القائم يرسل fieldErrors وحدها: الرسالة تُعرض ولو بلا سطر
  const fieldErrors = { isAxiosError: true, response: { status: 400, data: { success: false, errors: { rows: ['بيانات غير صحيحة'] } } } };
  assert.deepEqual(importValidationRejection(fieldErrors)?.details, [{ row: undefined, field: undefined, message: 'بيانات غير صحيحة' }]);
  // مفتاح رقمي = موضع صف
  const numericKeys = { isAxiosError: true, response: { status: 400, data: { errors: { 7: ['قيمة غير صالحة'] } } } };
  assert.deepEqual(importValidationRejection(numericKeys)?.details, [{ row: 9, field: undefined, message: 'قيمة غير صالحة' }]);
  // لا تفصيل ⇒ null فتبقى الرسالة العامة، و409 ليست رفض تحقق
  assert.equal(importValidationRejection({ isAxiosError: true, response: { status: 400, data: { message: 'x' } } }), null);
  assert.equal(importValidationRejection({ isAxiosError: true, response: { status: 409, data: { errors: { rows: ['x'] } } } }), null);

  // حدّ حجم الطلب: 413، أو 500 برسالة express
  assert.equal(isPayloadTooLarge({ type: 'other', status: 413 }), true);
  assert.equal(isPayloadTooLarge({ type: 'other', status: 500, message: 'request entity too large' }), true);
  assert.equal(isPayloadTooLarge({ type: 'other', status: 500, message: 'خطأ في الخادم' }), false);
  assert.equal(isPayloadTooLarge({ type: 'network' }), false);
  assert.equal(payloadBytes({ rows: [{ name: 'أب' }] }), new TextEncoder().encode(JSON.stringify({ rows: [{ name: 'أب' }] })).length);
  assert.equal(megabytes(1572864), 1.5);

  const panel = await panelSource();
  assert.match(panel, /overMax: rowsOverMax\(preview\.kind, rows\.length\)/, 'حد الصفوف لا يُحسب على الصفوف المرسلة');
  assert.match(panel, /overMax: !!view\.overMax/, 'زر الاستيراد يبقى مفعّلاً فوق الحد');
  assert.match(panel, /importValidationRejection\(e\)/, 'رفض الملف كله لا يُقرأ تفصيله');
  assert.match(panel, /type: 'tooLarge', bytes: payloadBytes\(body\)/, 'حجم الجسم لا يُعرض على المالك');
});

test('البندان 43 و44: تخطّي الأسعار بسببه العربي، بعدّاد لكل سبب وأزواج اختلف فيها السعر', async () => {
  const {
    priceSkipReasonKey, skipReasonKey, skipReasonCounts, conflictingPricePairs,
    PRICE_SKIP_PRODUCT_ARCHIVED, PRICE_SKIP_DUPLICATE_PAIR, PRICE_DUPLICATE_PAIRS_TITLE,
  } = await import('./importRevert');
  assert.equal(priceSkipReasonKey('PRODUCT_ARCHIVED'), PRICE_SKIP_PRODUCT_ARCHIVED);
  assert.equal(priceSkipReasonKey('DUPLICATE_PAIR'), PRICE_SKIP_DUPLICATE_PAIR);
  assert.equal(priceSkipReasonKey(undefined), 'مكرر تخطي');
  // لا تُخلط بأسباب نوع آخر: «الكود موجود» سبب منتجات لا أسعار
  assert.equal(priceSkipReasonKey('CODE_EXISTS'), 'مكرر تخطي');
  assert.equal(skipReasonKey('prices', 'PRODUCT_ARCHIVED'), PRICE_SKIP_PRODUCT_ARCHIVED);
  assert.equal(skipReasonKey('products', 'CODE_EXISTS'), 'الكود موجود');
  assert.equal(skipReasonKey('customers', 'PHONE_EXISTS'), 'الجوال موجود');
  assert.equal(skipReasonKey('products', 'PRODUCT_ARCHIVED'), 'مكرر تخطي');
  assert.equal(skipReasonKey(undefined, 'CODE_EXISTS'), 'الكود موجود');

  // العدّاد: لكل سبب عدده بترتيب أول ظهوره — القائمة تُقتطع عند 15 سطراً والعدّ كامل
  assert.deepEqual(
    skipReasonCounts('prices', [
      { reason: 'DUPLICATE_PAIR' }, { reason: 'PRODUCT_ARCHIVED' }, { reason: 'DUPLICATE_PAIR' }, { reason: 'PRODUCT_ARCHIVED' }, { reason: 'PRODUCT_ARCHIVED' },
    ]),
    [{ key: PRICE_SKIP_DUPLICATE_PAIR, count: 2 }, { key: PRICE_SKIP_PRODUCT_ARCHIVED, count: 3 }],
  );
  assert.deepEqual(skipReasonCounts('prices', []), []);
  assert.deepEqual(skipReasonCounts('prices', undefined), []);
  assert.deepEqual(skipReasonCounts('customers', [{}]), [{ key: 'مكرر تخطي', count: 1 }]);

  // أزواج التكرار: المختلفة سعراً وحدها تُعرض (المتطابقة تكرار بلا أثر يكفيه عدّاد التخطي)
  const pairs = [
    { rows: [2, 9], kept: 9, prices: [10, 12], conflict: true, code: 'P1', customerName: 'بقالة الحي' },
    { rows: [3, 4], kept: 4, prices: [5, 5], conflict: false, code: 'P2', customerName: 'سوبر ماركت' },
  ];
  assert.deepEqual(conflictingPricePairs(pairs).map((d) => d.code), ['P1']);
  assert.deepEqual(conflictingPricePairs([]), []);
  assert.deepEqual(conflictingPricePairs(undefined), []);

  // خانة العدّ: «مكرر تخطي» ليست صادقة في الأسعار (الصنف المؤرشف ليس مكرراً)
  const { skippedStatLabel, SKIPPED_ROWS_LABEL } = await import('./importRevert');
  assert.equal(skippedStatLabel('prices'), SKIPPED_ROWS_LABEL);
  assert.equal(skippedStatLabel('products'), 'مكرر تخطي');
  assert.equal(skippedStatLabel(undefined), 'مكرر تخطي');

  const panel = await panelSource();
  assert.match(panel, /skippedStatLabel\(result\.kind\)/, 'خانة المتخطى تقول «مكرر» في الأسعار');
  assert.match(panel, /tr\(skipReasonKey\(result\.kind, s\.reason\)\)/, 'سبب تخطي الأسعار يُعرض بسبب نوع آخر');
  assert.match(panel, /skipReasonCounts\(result\.kind, skippedRows\)/, 'لا عدّاد لأسباب التخطي في النافذة');
  assert.match(panel, /conflictingPricePairs\(w\?\.duplicates\)/, 'أزواج التكرار المختلفة سعراً لا تُعرض');
  assert.ok(panel.includes('{tr(PRICE_DUPLICATE_PAIRS_TITLE)}'), 'عنوان أزواج التكرار غائب');
  assert.ok(PRICE_DUPLICATE_PAIRS_TITLE.includes('المحفوظ آخرها'));
});

test('البند 49: العملاء بجوال لا تقبله بطاقتهم يُنبَّه عليهم بعددهم وصفوفهم', async () => {
  const { phoneNotEditableWarning, CUSTOMER_PHONE_NOT_EDITABLE, CUSTOMER_PHONE_NOT_EDITABLE_FIX } = await import('./importRevert');
  assert.deepEqual(phoneNotEditableWarning({ count: 3, rows: [2, 5, 9] }), { count: 3, rows: [2, 5, 9] });
  // عدد بلا صفوف (خادم قصّها) يبقى تنبيهاً، والصفر والغياب والتشويه بلا كتلة
  assert.deepEqual(phoneNotEditableWarning({ count: 2 }), { count: 2, rows: [] });
  assert.deepEqual(phoneNotEditableWarning({ count: 2, rows: [4, 'x', null] }), { count: 2, rows: [4] });
  assert.equal(phoneNotEditableWarning({ count: 0, rows: [] }), null);
  assert.equal(phoneNotEditableWarning({ rows: [3] }), null);
  assert.equal(phoneNotEditableWarning(null), null);
  assert.equal(phoneNotEditableWarning(undefined), null);
  // العبارة تقول للمالك ما يعطّله وما يصلحه
  assert.ok(CUSTOMER_PHONE_NOT_EDITABLE.includes('لا يُحفظ أي تعديل'));
  assert.ok(CUSTOMER_PHONE_NOT_EDITABLE_FIX.includes('جوالاً صالحاً'));

  const panel = await panelSource();
  assert.match(panel, /phoneNotEditableWarning\(w\?\.phoneNotEditable\)/, 'تحذير الجوال لا يُقرأ من رد الخادم');
  assert.ok(panel.includes('{tr(CUSTOMER_PHONE_NOT_EDITABLE)}'), 'نص تحذير الجوال غائب عن النافذة');
});

test('البند 39: تنبيه «تواريخ بعد اليوم» يصل المالك بعدده وأقصى تاريخ مقبول وأمثلة صفوفه', async () => {
  const { futureDatedWarning, IMPORT_FUTURE_DATED, IMPORT_FUTURE_DATED_MAX, IMPORT_FUTURE_DATED_FIX } = await import('./importRevert');
  // شكل warnings.futureDated في ردّ /import/balances و/import/ledger
  assert.deepEqual(futureDatedWarning({ count: 3, rows: [2, 5, 9], maxDate: '2026-09-24', message: 'x' }),
    { count: 3, rows: [2, 5, 9], maxDate: '2026-09-24' });
  // الشكل الذي يرسله الخادم فعلاً: rows = [{ row, date }] (services/importLedger.ts resolveImportDates)
  assert.deepEqual(
    futureDatedWarning({ count: 2, rows: [{ row: 7, date: '2052-01-03' }, { row: 11, date: '2052-02-09' }], maxDate: '2026-09-24' }),
    { count: 2, rows: [7, 11], maxDate: '2026-09-24' },
  );
  // خلط الشكلين وقيم مشوّهة: تُقرأ الأرقام وحدها ولا تُختلق صفوف
  assert.deepEqual(futureDatedWarning({ count: 3, rows: [4, { row: 9, date: 'x' }, { date: 'y' }, {}, 'z'], maxDate: '' }),
    { count: 3, rows: [4, 9], maxDate: '' });
  // عدد بلا صفوف، وصفوف بلا عدد (خادم أقدم صيغةً): كلاهما تنبيه بعدد صادق
  assert.deepEqual(futureDatedWarning({ count: 2, maxDate: '2026-09-24' }), { count: 2, rows: [], maxDate: '2026-09-24' });
  assert.deepEqual(futureDatedWarning({ rows: [4, 7] }), { count: 2, rows: [4, 7], maxDate: '' });
  assert.deepEqual(futureDatedWarning({ count: 2, rows: [4, 'x', null], maxDate: 9 }), { count: 2, rows: [4], maxDate: '' });
  // الحقل غائب من خادم أقدم، أو صفر ⇒ لا كتلة ولا عدد مختلَق
  assert.equal(futureDatedWarning({ count: 0, rows: [] }), null);
  assert.equal(futureDatedWarning({}), null);
  assert.equal(futureDatedWarning(null), null);
  assert.equal(futureDatedWarning(undefined), null);
  // النص نفسه الذي يرسله الخادم (backend/src/routes/import.ts IMPORT_FUTURE_DATE_WARNING) فيُترجَم عندنا
  assert.equal(IMPORT_FUTURE_DATED, 'تواريخ بعد اليوم بتوقيت الشركة — تحقّق من سنة التاريخ قبل الاعتماد');
  assert.ok(IMPORT_FUTURE_DATED_MAX.includes('أقصى تاريخ'));
  assert.ok(IMPORT_FUTURE_DATED_FIX.includes('التراجع'), 'لا يُقال للمالك كيف يصلحها');

  const panel = await panelSource();
  assert.match(panel, /futureDatedWarning\(w\?\.futureDated\)/, 'تنبيه التاريخ المستقبلي لا يُقرأ من رد الخادم');
  assert.ok(panel.includes('{tr(IMPORT_FUTURE_DATED)}'), 'نص التنبيه غائب عن نافذة النتيجة');
  assert.ok(panel.includes('{tr(IMPORT_FUTURE_DATED_MAX)}'), 'أقصى تاريخ مقبول لا يُعرض');
  assert.match(panel, /futureDated\.rows\.slice\(0, 20\)\.map\(row\)/, 'أمثلة الصفوف لا تُرقَّم بأرقام صفوف الملف');
});

test('البند 36: خطأ الصف بلا قيمة يُعرض باسم خانته، فلا يبقى «خانة مطلوبة» بلا عمود', async () => {
  const { importRowFieldOnlyKey } = await import('./importRevert');
  // parseImportRows: خانة فارغة ⇒ رسالة عامة بلا قيمة، فالوسم وحده يدلّ على العمود
  assert.equal(importRowFieldOnlyKey({ message: 'خانة مطلوبة في هذا الصف فارغة', field: 'creditLimit' }), 'الحد الائتماني');
  assert.equal(importRowFieldOnlyKey({ message: 'نوع القيمة لا يناسب هذه الخانة (نص في خانة رقمية أو العكس)', field: 'qty' }), 'الكمية');
  // مع قيمة: الوسم يظهر معها (importRowErrorFieldKey) فلا يُكرَّر هنا
  assert.equal(importRowFieldOnlyKey({ message: 'خانة مطلوبة في هذا الصف فارغة', value: '0', field: 'qty' }), null);
  // الرسالة تذكر الخانة سلفاً، أو الخانة بلا وسم عربي، أو لا خانة أصلاً
  assert.equal(importRowFieldOnlyKey({ message: 'الكمية يجب أن تكون أكبر من صفر', field: 'qty' }), null);
  assert.equal(importRowFieldOnlyKey({ message: 'خطأ', field: 'mystery' }), null);
  assert.equal(importRowFieldOnlyKey({ message: 'خطأ', field: '  ' }), null);
  assert.equal(importRowFieldOnlyKey({ message: 'خطأ' }), null);
  assert.equal(importRowFieldOnlyKey(undefined), null);

  const panel = await panelSource();
  assert.match(panel, /importRowFieldOnlyKey\(er\)/, 'خطأ الصف بلا قيمة يسقط بلا اسم خانة');
});

test('البند 51: عقد التاريخ يُختم به طلب الأرصدة والكشوف، ورمز عدم التوافق يعرض «حدّث الصفحة»', async () => {
  const { buildImportBody: build, isClientOutdated, IMPORT_DATE_CONTRACT } = await import('./importRevert');
  const rows = [{ a: 1 }];
  assert.equal(IMPORT_DATE_CONTRACT, 'local-ymd-v2');
  assert.equal(build({ kind: 'balances', rows, ledgerKind: true }).dateContract, IMPORT_DATE_CONTRACT);
  assert.equal(build({ kind: 'ledger', rows, ledgerKind: true }).dateContract, IMPORT_DATE_CONTRACT);
  // الأنواع بلا تواريخ لا تحمله
  assert.equal('dateContract' in build({ kind: 'customers', rows, ledgerKind: false }), false);
  assert.equal('dateContract' in build({ kind: 'opening_stock', rows, ledgerKind: false }), false);

  assert.equal(isClientOutdated({ isAxiosError: true, response: { status: 409, data: { code: 'IMPORT_CLIENT_OUTDATED', message: 'حدّث الصفحة' } } }), true);
  assert.equal(isClientOutdated({ isAxiosError: true, response: { status: 409, data: { code: 'IMPORT_DUPLICATE_BATCH' } } }), false);
  assert.equal(isClientOutdated({ isAxiosError: true, code: 'ERR_NETWORK' }), false);
  assert.equal(isClientOutdated(undefined), false);

  const panel = await panelSource();
  assert.match(panel, /if \(isClientOutdated\(e\)\) \{ withConflict\(\{ type: 'outdated' \}\);/, 'عدم التوافق يسقط في الرسالة العامة');
  assert.match(panel, /window\.location\.reload\(\)/, 'لا زرّ تحديث للصفحة');
});

test('البند 52: انقطاع النشر ليس «تعذر الاستيراد»، وسجل الدفعات يُصفَّح بلا ادّعاء ما لم يصل', async () => {
  const {
    isServiceUnavailable, SERVICE_UNAVAILABLE_MESSAGE, classifyRevertFailure: classify, revertFailureKey: key,
    mergeBatchPages, canLoadOlderBatches, BATCHES_PAGE_SIZE,
  } = await import('./importRevert');
  assert.equal(isServiceUnavailable({ type: 'other', status: 502 }), true);
  assert.equal(isServiceUnavailable({ type: 'other', status: 503 }), true);
  assert.equal(isServiceUnavailable({ type: 'other', status: 504 }), true);
  assert.equal(isServiceUnavailable({ type: 'other', status: 500 }), false);
  assert.equal(isServiceUnavailable({ type: 'other' }), false);
  assert.equal(isServiceUnavailable({ type: 'network' }), false);
  // 502 بجسم HTML أثناء النشر: لا code ولا message ⇒ يُصنَّف other بحالته وتُقرأ رسالته الصحيحة
  const deploying = classify({ isAxiosError: true, response: { status: 503, data: '<html>Service Unavailable</html>' } });
  assert.deepEqual(deploying, { type: 'other', message: undefined, status: 503 });
  assert.equal(key(deploying), SERVICE_UNAVAILABLE_MESSAGE);
  assert.equal(key({ type: 'other', message: 'خطأ داخلي', status: 500 }), null);

  // الدمج: بترتيب المعروض، بلا تكرار معرّف، وadded=0 حين لا جديد (خادم بلا cursor)
  const shown = [{ id: 'b1' }, { id: 'b2' }];
  const m = mergeBatchPages(shown, [{ id: 'b2' }, { id: 'b3' }]);
  assert.deepEqual(m.list.map((b) => b.id), ['b1', 'b2', 'b3']);
  assert.deepEqual(m.fresh.map((b) => b.id), ['b3']);
  assert.equal(m.added, 1);
  assert.equal(mergeBatchPages(shown, [{ id: 'b1' }, { id: 'b2' }]).added, 0);
  assert.equal(mergeBatchPages(shown, []).added, 0);
  assert.deepEqual(mergeBatchPages(shown, []).list.map((b) => b.id), ['b1', 'b2']);

  // الزر: hasMore من الخادم يحسم؛ وبدونها صفحة ممتلئة قد يكون خلفها أقدم؛ والمقيّد النطاق لا سجل له
  assert.equal(canLoadOlderBatches({ shown: BATCHES_PAGE_SIZE, exhausted: false, scoped: false }), true);
  assert.equal(canLoadOlderBatches({ shown: 12, exhausted: false, scoped: false }), false);
  assert.equal(canLoadOlderBatches({ shown: 12, hasMore: true, exhausted: false, scoped: false }), true);
  assert.equal(canLoadOlderBatches({ shown: BATCHES_PAGE_SIZE, hasMore: false, exhausted: false, scoped: false }), false);
  assert.equal(canLoadOlderBatches({ shown: BATCHES_PAGE_SIZE, exhausted: true, scoped: false }), false);
  assert.equal(canLoadOlderBatches({ shown: BATCHES_PAGE_SIZE, hasMore: true, exhausted: false, scoped: true }), false);

  // عقد الصفحة: data وhasMore وnextCursor — وما ينقص منها (خادم أقدم) لا يُخترع
  const { batchesPage, nextBatchesCursor } = await import('./importRevert');
  assert.deepEqual(
    batchesPage<{ id: string }>({ success: true, data: [{ id: 'b7' }, { id: 'b8' }], hasMore: true, nextCursor: 'b8' }),
    { rows: [{ id: 'b7' }, { id: 'b8' }], hasMore: true, nextCursor: 'b8' },
  );
  assert.deepEqual(batchesPage<{ id: string }>({ data: [], hasMore: false, nextCursor: null }), { rows: [], hasMore: false, nextCursor: null });
  assert.deepEqual(batchesPage<{ id: string }>({ data: [{ id: 'b1' }, { id: 5 }, null, 'x'] }), { rows: [{ id: 'b1' }], hasMore: undefined, nextCursor: null });
  assert.deepEqual(batchesPage<{ id: string }>({ data: 'x', hasMore: 'yes', nextCursor: 3 }), { rows: [], hasMore: undefined, nextCursor: null });
  assert.deepEqual(batchesPage<{ id: string }>(undefined), { rows: [], hasMore: undefined, nextCursor: null });
  // الاستئناف: ما أعطاه الخادم، وإلا آخر معرّف معروض، ولا شيء ⇒ لا طلب
  assert.equal(nextBatchesCursor('b8', 'b9'), 'b8');
  assert.equal(nextBatchesCursor(null, 'b9'), 'b9');
  assert.equal(nextBatchesCursor(undefined, undefined), undefined);
  assert.equal(nextBatchesCursor('', ''), undefined);

  const panel = await panelSource();
  assert.match(panel, /if \(isServiceUnavailable\(f\)\) \{ withConflict\(\{ type: 'unavailable' \}\); invalidateBatches\(\); break; \}/);
  assert.match(panel, /params: \{ cursor, limit: BATCHES_PAGE_SIZE \}/, 'جلب الأقدم بلا cursor');
  assert.match(panel, /nextBatchesCursor\(olderCursor \?\? firstPageCursor, batches\?\.\[batches\.length - 1\]\?\.id\)/, 'الصفحة التالية لا تستأنف من nextCursor');
  assert.match(panel, /hasMore: olderHasMore \?\? batchesBody\?\.hasMore/, 'زرّ «عرض المزيد» يبقى بعد نهاية السجل');
  assert.match(panel, /else setOlderExhausted\(true\)/, 'لا شيء جديد يُعرض على أنه دفعات');
  assert.match(panel, /resetOlderBatches\(\)/, 'الأقدم تبقى بعد التراجع فيُعرض سجل قديم');
  assert.match(panel, /setOlderCursor\(null\); setOlderHasMore\(undefined\)/, 'التراجع لا يصفّر موضع الاستئناف');
});
