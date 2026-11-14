// حلّ خيارات معاينة «ربط الدفاتر» (P5 — params.ts، العقد §14.1): ترتيب المصادر (المسودة ⇒ الصفّ ⇒ الافتراضي) كـeffectiveSetup،
// linkedFrom من الأساس بتوقيت الشركة، العملة من الصفّ أو القالب، OD4/OD2/OD7، midVatPeriod، والأخطاء — صرفٌ بلا قاعدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LinkingParamsError, preflightInputFromOptions, receiptRoutingFrom, resolvePreviewOptions, templateKeyOf, type ResolveParamsInput,
} from '../services/gl/linking/params';
import { LINKED_DEFAULT_RECEIPT_ROUTING, type LinkingDraft, type LinkingSettingsRow } from '../services/gl/linking/types';

const NOW = new Date('2026-11-14T09:00:00.000Z');

function row(over: Partial<LinkingSettingsRow> & Record<string, unknown> = {}): LinkingSettingsRow {
  return {
    templateKey: 'SA_6D', countryCode: 'SA', currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', fiscalYearEndMonth: 12,
    fiscalYearEndDay: 31, weekStartsOn: 0, cutoverDate: null, inventoryMode: 'PERIODIC', perpetualFromDate: null, salesLockDate: null,
    purchaseLockDate: null, taxLockDate: null, hardLockDate: null, taxPeriodicity: 'QUARTERLY', taxDeadlineRule: 'END_OF_NEXT_MONTH',
    taxDeadlineDays: null, zeroRatedSalesTaxKey: 'Z_SALE', postSalesDiscountSeparately: true, postReturnsToContra: true, receiptRouting: null,
    cashInvoiceRouting: 'MAIN_CASH', paylinkFeeTaxInvoiceFrom: null, postPurchaseDiscountSeparately: false, billPricesIncludeTax: false,
    earlyDiscountAdjustsVat: true, taxRoundingMethod: 'PER_TAX', defaultPurchaseTaxId: null, activatedAt: null, setupMethod: null,
    ...over,
  } as LinkingSettingsRow;
}

function input(over: Partial<ResolveParamsInput> = {}): ResolveParamsInput {
  return {
    basis: 'FY_RESTATED', dbNow: NOW, settingsRow: row(), draft: null,
    company: { countryCode: 'SA', currency: 'SAR' },
    tenant: { accountingSuiteEnabled: true, accountingEnabled: true, warehouseEnabled: true },
    env: {},
    ...over,
  };
}

test('linkedFrom: FY_RESTATED = بداية السنة المالية لليوم المحلي، FROM_ACTIVATION = اليوم المحلي', () => {
  assert.equal(resolvePreviewOptions(input()).linkedFrom, '2026-01-01');
  assert.equal(resolvePreviewOptions(input({ basis: 'FROM_ACTIVATION' })).linkedFrom, '2026-11-14');
  // سنة مالية تنتهي 30 يونيو ⇒ تبدأ 1 يوليو
  assert.equal(resolvePreviewOptions(input({ settingsRow: row({ fiscalYearEndMonth: 6, fiscalYearEndDay: 30 }) })).linkedFrom, '2026-07-01');
  // 22:30 UTC يوم 31 ديسمبر = 01:30 يوم 1 يناير بالرياض ⇒ السنة الجديدة
  const nye = new Date('2026-12-31T22:30:00.000Z');
  assert.equal(resolvePreviewOptions(input({ dbNow: nye })).linkedFrom, '2027-01-01');
  assert.equal(resolvePreviewOptions(input({ dbNow: nye, basis: 'FROM_ACTIVATION' })).linkedFrom, '2027-01-01');
  // والمنطقة من المسودة تغلب الصف: UTC ما زال 31 ديسمبر
  const utc: LinkingDraft = { step1: { timezone: 'UTC' } };
  assert.equal(resolvePreviewOptions(input({ dbNow: nye, draft: utc })).linkedFrom, '2026-01-01');
});

test('ترتيب المصادر: المسودة ثم الصفّ ثم الافتراضي (المنطقة ونهاية السنة وبداية الأسبوع ودورية الإقرار)', () => {
  const fromDraft = resolvePreviewOptions(input({
    settingsRow: row({ timezone: 'Asia/Dubai', fiscalYearEndMonth: 6, fiscalYearEndDay: 30, weekStartsOn: 1, taxPeriodicity: 'MONTHLY' }),
    draft: { step1: { timezone: 'Africa/Cairo', fiscalYearEndMonth: 3, fiscalYearEndDay: 31, weekStartsOn: 6, taxPeriodicity: 'ANNUAL' } },
  }));
  assert.deepEqual([fromDraft.timezone, fromDraft.fiscalYearEndMonth, fromDraft.fiscalYearEndDay, fromDraft.weekStartsOn, fromDraft.taxPeriodicity],
    ['Africa/Cairo', 3, 31, 6, 'ANNUAL']);
  assert.equal(fromDraft.linkedFrom, '2026-04-01');
  const fromRow = resolvePreviewOptions(input({
    settingsRow: row({ timezone: 'Asia/Dubai', fiscalYearEndMonth: 6, fiscalYearEndDay: 30, weekStartsOn: 1, taxPeriodicity: 'MONTHLY' }),
  }));
  assert.deepEqual([fromRow.timezone, fromRow.fiscalYearEndMonth, fromRow.fiscalYearEndDay, fromRow.weekStartsOn, fromRow.taxPeriodicity],
    ['Asia/Dubai', 6, 30, 1, 'MONTHLY']);
  const defaults = resolvePreviewOptions(input({ settingsRow: null }));
  assert.deepEqual([defaults.timezone, defaults.fiscalYearEndMonth, defaults.fiscalYearEndDay, defaults.weekStartsOn, defaults.taxPeriodicity],
    ['Asia/Riyadh', 12, 31, 0, 'QUARTERLY']);
  // قيم صفّ تالفة لا تُعتمد
  const junk = resolvePreviewOptions(input({ settingsRow: row({ timezone: 'Mars/Base', taxPeriodicity: 'WEEKLY', weekStartsOn: 9 }) }));
  assert.deepEqual([junk.timezone, junk.taxPeriodicity, junk.weekStartsOn], ['Asia/Riyadh', 'QUARTERLY', 0]);
});

test('القالب والعملة: الصفّ يحكم إن زُرع، وإلا الدولة (SA ⇒ SA_6D، غيرها ⇒ GENERIC_6D بعملتها ومنازلها)', () => {
  assert.equal(templateKeyOf(row({ templateKey: 'GENERIC_6D' }), 'SA'), 'GENERIC_6D');
  assert.equal(templateKeyOf(null, 'SA'), 'SA_6D');
  assert.equal(templateKeyOf(null, 'AE'), 'GENERIC_6D');
  const kw = resolvePreviewOptions(input({ settingsRow: null, company: { countryCode: 'kw', currency: 'KWD' } }));
  assert.deepEqual([kw.templateKey, kw.countryCode, kw.currency, kw.currencyDecimals], ['GENERIC_6D', 'KW', 'KWD', 3]);
  const sa = resolvePreviewOptions(input({ settingsRow: null }));
  assert.deepEqual([sa.templateKey, sa.currency, sa.currencyDecimals], ['SA_6D', 'SAR', 2]);
  // لقطة الصفّ المجمّدة تغلب القالب
  const frozen = resolvePreviewOptions(input({ settingsRow: row({ templateKey: 'GENERIC_6D', countryCode: 'BH', currency: 'BHD', currencyDecimals: 3 }) }));
  assert.deepEqual([frozen.templateKey, frozen.countryCode, frozen.currency, frozen.currencyDecimals], ['GENERIC_6D', 'BH', 'BHD', 3]);
});

test('مسارات العهدة (OD4) والفواتير النقدية (OD2): المسودة ثم الصفّ ثم افتراضي الربط — نسخة لا مرجع', () => {
  const def = resolvePreviewOptions(input());
  assert.deepEqual(def.receiptRouting, { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'DIRECT' });
  assert.notEqual(def.receiptRouting, LINKED_DEFAULT_RECEIPT_ROUTING);
  assert.equal(def.cashInvoiceRouting, 'MAIN_CASH');
  const fromRow = resolvePreviewOptions(input({ settingsRow: row({ receiptRouting: { CASH: 'DIRECT', POS: 'CUSTODY', ONLINE: 'CUSTODY', X: 1 }, cashInvoiceRouting: 'CUSTODY' }) }));
  assert.deepEqual(fromRow.receiptRouting, { CASH: 'DIRECT', POS: 'CUSTODY' });
  assert.equal(fromRow.cashInvoiceRouting, 'CUSTODY');
  const fromDraft = resolvePreviewOptions(input({
    settingsRow: row({ receiptRouting: { CASH: 'DIRECT' }, cashInvoiceRouting: 'CUSTODY' }),
    draft: { step3: { receiptRouting: { CHEQUE: 'CUSTODY' }, cashInvoiceRouting: 'MAIN_CASH' } },
  }));
  assert.deepEqual(fromDraft.receiptRouting, { CHEQUE: 'CUSTODY' });
  assert.equal(fromDraft.cashInvoiceRouting, 'MAIN_CASH');
  // null صريح في المسودة يسقط إلى الصفّ ثم الافتراضي
  assert.deepEqual(resolvePreviewOptions(input({ draft: { step3: { receiptRouting: null } } })).receiptRouting, { ...LINKED_DEFAULT_RECEIPT_ROUTING });
  assert.equal(receiptRoutingFrom('CUSTODY'), null);
  assert.equal(receiptRoutingFrom([1]), null);
});

test('الجرد (OD7) والتفعيل والعامل والفئات والأرصدة اليدوية', () => {
  assert.equal(resolvePreviewOptions(input()).inventoryMode, 'PERPETUAL');
  assert.equal(resolvePreviewOptions(input({ tenant: { accountingSuiteEnabled: true, accountingEnabled: true, warehouseEnabled: false } })).inventoryMode, 'PERIODIC');
  assert.equal(resolvePreviewOptions(input()).suiteEnabled, true);
  assert.equal(resolvePreviewOptions(input({ tenant: { accountingSuiteEnabled: true, accountingEnabled: false, warehouseEnabled: true } })).suiteEnabled, false);
  assert.equal(resolvePreviewOptions(input({ tenant: { accountingSuiteEnabled: false, accountingEnabled: true, warehouseEnabled: true } })).suiteEnabled, false);
  assert.equal(resolvePreviewOptions(input({ env: {} })).workerEnabled, true);
  assert.equal(resolvePreviewOptions(input({ env: { LEDGER_WORKER_ENABLED: '0' } })).workerEnabled, false);
  assert.equal(resolvePreviewOptions(input({ env: { LEDGER_WORKER_ENABLED: '1' } })).workerEnabled, true);
  const draft: LinkingDraft = {
    step3: { categoryIncomeAccounts: [{ categoryId: 'cat-1', accountCode: '411002' }] },
    step5: { rows: [{ accountCode: ' 111001 ', debit: 100 }, { accountCode: '311001', credit: '100' }] },
  };
  const frozen = JSON.stringify(draft);
  const o = resolvePreviewOptions(input({ draft }));
  assert.deepEqual(o.categoryIncomeAccounts, [{ categoryId: 'cat-1', accountCode: '411002' }]);
  assert.deepEqual(o.manualRows, [{ accountCode: '111001', debit: 100 }, { accountCode: '311001', credit: '100' }]);
  assert.equal(JSON.stringify(draft), frozen, 'المسودة لا تُعدَّل');
  assert.equal(o.draft, draft);
  assert.equal(o.settingsRow?.templateKey, 'SA_6D');
  assert.deepEqual(resolvePreviewOptions(input()).manualRows, []);
});

test('midVatPeriod: بداية سنة مالية ليست بداية فترة إقرار ومؤكَّدة في المسودة وحدها', () => {
  // نهاية السنة 15 مارس ⇒ البدء 16 مارس (ليس بداية ربع)
  const mid = { fiscalYearEndMonth: 3, fiscalYearEndDay: 15 };
  assert.equal(resolvePreviewOptions(input({ draft: { step1: { ...mid, confirmMidVatPeriod: true } } })).midVatPeriod, true);
  assert.equal(resolvePreviewOptions(input({ draft: { step1: { ...mid } } })).midVatPeriod, false);
  // 1 يناير بداية ربع ⇒ لا منتصف فترة ولو أكّد
  assert.equal(resolvePreviewOptions(input({ draft: { step1: { confirmMidVatPeriod: true } } })).midVatPeriod, false);
  // FROM_ACTIVATION يوم 14 نوفمبر داخل الربع
  assert.equal(resolvePreviewOptions(input({ basis: 'FROM_ACTIVATION', draft: { step1: { confirmMidVatPeriod: true } } })).midVatPeriod, true);
});

test('الأخطاء: نهاية سنة مستحيلة، ودولة بلا قالب، وأساس مجهول ⇒ LinkingParamsError بسببه', () => {
  assert.throws(() => resolvePreviewOptions(input({ draft: { step1: { fiscalYearEndMonth: 2, fiscalYearEndDay: 30 } } })),
    (e: unknown) => e instanceof LinkingParamsError && e.reason === 'INVALID_FISCAL_YEAR_END');
  assert.throws(() => resolvePreviewOptions(input({ draft: { step1: { fiscalYearEndMonth: 2, fiscalYearEndDay: 29 } } })),
    (e: unknown) => e instanceof LinkingParamsError && e.reason === 'INVALID_FISCAL_YEAR_END');
  assert.throws(() => resolvePreviewOptions(input({ settingsRow: null, company: { countryCode: 'ZZ', currency: null } })),
    (e: unknown) => e instanceof LinkingParamsError && e.reason === 'TEMPLATE_UNAVAILABLE' && /قالب/.test(e.message));
  assert.throws(() => resolvePreviewOptions(input({ basis: 'TOMORROW' as never })),
    (e: unknown) => e instanceof LinkingParamsError && e.reason === 'INVALID_BASIS');
});

test('preflightInputFromOptions: LIGHT بلا costing/eventStats، وFULL يحملهما، والحقول من الخيارات نفسها', () => {
  const o = resolvePreviewOptions(input({ env: { LEDGER_WORKER_ENABLED: '0' } }));
  const light = preflightInputFromOptions(o, 'LIGHT', NOW);
  assert.equal(light.mode, 'LIGHT');
  assert.equal('costing' in light, false);
  assert.equal('eventStats' in light, false);
  assert.deepEqual([light.linkedFrom, light.basis, light.timezone, light.templateKey, light.currency, light.currencyDecimals, light.workerEnabled],
    [o.linkedFrom, o.basis, o.timezone, o.templateKey, o.currency, o.currencyDecimals, false]);
  assert.equal(light.receiptRouting, o.receiptRouting);
  assert.equal(light.now, NOW);
  const full = preflightInputFromOptions(o, 'FULL', NOW, { eventStats: { eventsToPost: 3, autoSalePercents: [], byType: {} } });
  assert.equal(full.costing, null);
  assert.equal(full.eventStats?.eventsToPost, 3);
});
