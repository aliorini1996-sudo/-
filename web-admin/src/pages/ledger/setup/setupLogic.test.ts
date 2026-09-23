import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MANUAL_BALANCE_ISSUES, OPENING_BALANCE_TEMPLATE_COLUMNS, cleanManualRows, clampStep, compactBoxes, effectiveCutover, fiscalYearStart, initialStep1, isVatPeriodStart, manualTotalsMilli,
  milliText, needsMidPeriodConfirm, normalizeDueDate, openingDateOf, openingFieldOf, parseOpeningBalanceRecords,
  DATA_IMPORT_ANCHOR, DATA_IMPORT_HREF, derivedAccountKind, hasPostCutoverImports, importsAckBlocksCommit, openingDataHints,
  openingStockReview, commitNeedsRefresh, COMMIT_REFRESH_CODES,
  keepLiveCategoryLinks, timezoneImportsConflictOf, TIMEZONE_IMPORTS_CONFLICT_CODE,
} from './setupLogic';
import type { SetupEffective } from '../../../api/ledgerSetup';

/**
 * معالج الإعداد (M3، §5.6): منطق الواجهة الصرف، ومرآة ثوابت الخادم (أعمدة القالب وأسباب الصفوف وحد فترة الإقرار)،
 * وحراس نصية على الصفحات: الإقرار بالسجلات النظامية قبل التفعيل، والمعاينة لا تُرسل للاعتماد، والصلاحية.
 */

const backend = path.resolve(process.cwd(), '..', 'backend', 'src');
const webSrc = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

test('ثوابت الأرصدة اليدوية مرآة services/gl/opening.ts', () => {
  const s = read(backend, 'services', 'gl', 'opening.ts');
  assert.match(read(backend, 'routes', 'ledger', 'setup.ts'), /rows: z\.array\(manualRowSchema\)\.max\(5000\)/, 'سقف الصفوف');
  const cols = /OPENING_BALANCE_TEMPLATE_COLUMNS\s*=\s*\[([^\]]*)\]/.exec(s)?.[1] ?? '';
  assert.deepEqual([...cols.matchAll(/'(\w+)'/g)].map(m => m[1]), [...OPENING_BALANCE_TEMPLATE_COLUMNS]);
  const issues = /MANUAL_BALANCE_ISSUES\s*=\s*\[([^\]]*)\]/.exec(s)?.[1] ?? '';
  assert.deepEqual([...issues.matchAll(/'(\w+)'/g)].map(m => m[1]), [...MANUAL_BALANCE_ISSUES]);
});

test('حد فترة الإقرار: تقويمي للدوريات، وبداية السنة المالية لـFISCAL_YEAR', () => {
  assert.equal(isVatPeriodStart('2026-01-01', 'QUARTERLY'), true);
  assert.equal(isVatPeriodStart('2026-04-01', 'QUARTERLY'), true);
  assert.equal(isVatPeriodStart('2026-05-01', 'QUARTERLY'), false);
  assert.equal(isVatPeriodStart('2026-05-01', 'MONTHLY'), true);
  assert.equal(isVatPeriodStart('2026-05-02', 'MONTHLY'), false);
  assert.equal(isVatPeriodStart('2026-07-01', 'SEMIANNUAL'), true);
  assert.equal(isVatPeriodStart('2026-06-01', 'FISCAL_YEAR', 5, 31), true);
  assert.equal(isVatPeriodStart('2026-01-01', 'FISCAL_YEAR', 5, 31), false);
  assert.equal(fiscalYearStart('2026-09-17', 12, 31), '2026-01-01');
  assert.equal(fiscalYearStart('2026-02-15', 2, 28), '2025-03-01');
  assert.equal(fiscalYearStart('2026-03-01', 2, 28), '2026-03-01');
  assert.equal(fiscalYearStart('2024-02-29', 2, 29), '2023-03-01', 'نهاية فبراير مقصوصة في السنة غير الكبيسة');
  assert.equal(needsMidPeriodConfirm('SA_6D', '2026-05-01', 'QUARTERLY', 12, 31), true);
  assert.equal(needsMidPeriodConfirm('GENERIC_6D', '2026-05-01', 'QUARTERLY', 12, 31), false, 'القالب العام بلا شرط');
  assert.equal(needsMidPeriodConfirm('SA_6D', '2026-04-01', 'QUARTERLY', 12, 31), false);
  // مطابقة مصدر الخادم: جدول الأشهر نفسه
  const s = read(backend, 'services', 'gl', 'opening.ts');
  assert.match(s, /MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, FOUR_MONTHS: 4, SEMIANNUAL: 6, ANNUAL: 12/);
});

test('التاريخ الفعلي والقيد الافتتاحي', () => {
  assert.equal(effectiveCutover('OPENING', '2026-07-01', '2024-01-01'), '2026-07-01');
  assert.equal(effectiveCutover('FULL_HISTORY', '2026-07-01', '2024-01-01'), '2024-01-01');
  assert.equal(effectiveCutover('FULL_HISTORY', '2026-07-01', null), '2026-07-01', 'بلا مستندات ⇒ تاريخ الطريقة (أ)');
  assert.equal(openingDateOf('2026-01-01'), '2025-12-31');
  assert.equal(clampStep(9), 1);
  assert.equal(clampStep('4'), 4);
  const eff: SetupEffective = {
    templateKey: 'SA_6D', countryCode: 'SA', timezone: 'Asia/Riyadh', fiscalYearEndMonth: 12, fiscalYearEndDay: 31, weekStartsOn: 0,
    taxPeriodicity: 'QUARTERLY', method: 'OPENING', cutoverDate: null, confirmMidVatPeriod: false, preCutoverBoxes: null,
  };
  assert.equal(initialStep1({}, eff, '2026-01-01').cutoverDate, '2026-01-01', 'المقترح حين لا مسودة');
  assert.equal(initialStep1({ step1: { cutoverDate: '2026-07-01', taxPeriodicity: 'MONTHLY' } }, eff, '2026-01-01').taxPeriodicity, 'MONTHLY');
  assert.deepEqual(compactBoxes({ 'SA_1.amount': ' 100 ', 'SA_1.tax': '' }), { 'SA_1.amount': '100' });
  assert.equal(compactBoxes({ 'SA_1.tax': ' ' }), null);
});

test('استيراد XLSX: عناوين عربية أو إنجليزية، وتواريخ، وتجاهل الفارغ، والأعمدة الناقصة', () => {
  assert.equal(openingFieldOf('رمز الحساب'), 'accountCode');
  assert.equal(openingFieldOf('Account Code'), 'accountCode');
  assert.equal(openingFieldOf('اسم المورّد'), 'vendorName');
  assert.equal(openingFieldOf('due_date'), 'dueDate');
  const r = parseOpeningBalanceRecords([
    { 'رمز الحساب': 111001, 'مدين': 1500.5, 'دائن': '', 'المورد': '', 'تاريخ الاستحقاق': '' },
    { 'رمز الحساب': '211001', 'مدين': '', 'دائن': '2,000', 'المورد': ' مؤسسة النور ', 'تاريخ الاستحقاق': new Date(Date.UTC(2026, 9, 31)) },
    { 'رمز الحساب': '', 'مدين': '', 'دائن': '', 'المورد': '', 'تاريخ الاستحقاق': '' },
    { 'رمز الحساب': '311001', 'مدين': '', 'دائن': '500', 'المورد': '', 'تاريخ الاستحقاق': '15/11/2026' },
  ]);
  assert.deepEqual(r.missingColumns, []);
  assert.equal(r.skippedEmpty, 1);
  assert.deepEqual(r.rows, [
    { accountCode: '111001', debit: '1500.5', credit: null },
    { accountCode: '211001', debit: null, credit: '2,000', vendorName: 'مؤسسة النور', dueDate: '2026-10-31' },
    { accountCode: '311001', debit: null, credit: '500', dueDate: '2026-11-15' },
  ]);
  assert.deepEqual(parseOpeningBalanceRecords([{ code: '1', label: 'x' }]).missingColumns, ['debit', 'credit']);
  assert.equal(normalizeDueDate('٢٠٢٦-١٢-٠١'), '2026-12-01');
  assert.equal(normalizeDueDate('غدا'), 'غدا', 'غير الصالح يمر ليرفضه الخادم بـINVALID_DUE_DATE');
});

test('الصفوف المرسلة ومجاميعها بالمللي', () => {
  const rows = cleanManualRows([
    { accountCode: ' 111001 ', debit: '١٬٢٥٠٫٥', credit: '' },
    { accountCode: '', debit: '', credit: '' },
    { accountCode: '211001', debit: '', credit: '1,250.50', vendorName: ' النور ' },
  ]);
  assert.deepEqual(rows, [
    { accountCode: '111001', debit: '1250.5', credit: null },
    { accountCode: '211001', debit: null, credit: '1250.50', vendorName: 'النور' },
  ]);
  const t = manualTotalsMilli(rows, 2);
  assert.equal(t.debit, 1_250_500n);
  assert.equal(t.credit, 1_250_500n);
  assert.equal(milliText(t.debit - t.credit - 5n), '-0.005');
  assert.equal(manualTotalsMilli([{ accountCode: 'x', debit: 'abc' }], 2).invalid, 1);
});

test('حراس الصفحات: الإقرار النظامي قبل التفعيل، والمعاينة للقراءة، والصلاحية', () => {
  const api = read(webSrc, 'api', 'ledgerSetup.ts');
  assert.match(api, /acknowledgeStatutory: true/, 'الاعتماد يرسل الإقرار بالسجلات النظامية');
  const review = read(webSrc, 'pages', 'ledger', 'setup', 'SetupReview.tsx');
  assert.ok(review.includes("tr('التفعيل يُنشئ سجلات محاسبية نظامية: بعد أول ترحيل لا تُحذف الدفاتر ولا يُعاد ضبطها، والتصحيح بقيود عكسية أو تسوية')"), 'نص G6 الحرفي من §5.6');
  assert.match(review, /disabled=\{[^}]*!ack/, 'زر التفعيل معطّل قبل الإقرار');
  const wizard = read(webSrc, 'pages', 'ledger', 'setup', 'SetupWizard.tsx');
  assert.match(wizard, /canLedger\(user, 'canConfigureLedger'\)|useLedgerCan\('canConfigureLedger'\)/);
  const home = read(webSrc, 'pages', 'ledger', 'LedgerHome.tsx');
  assert.match(home, /SetupWizard/);
  assert.match(home, /canConfigure\s*\?/, 'المعالج لمن يملك canConfigureLedger وإلا «بانتظار الإعداد»');
  // المعاينة لا تُخزَّن ولا تُمرَّر أرقامها إلى الاعتماد (§5.6 الخطوة 4). البند 41 يستثني لقطة إقرار الحركات
  // المستوردة وحدها: تُرسَل لتُقارَن فيُرفض الاعتماد إن تغيّرت، ولا يُبنى عليها قيد ولا رصيد.
  const commitCall = review.slice(review.indexOf('ledgerSetupApi.commit(undefined, {'), review.indexOf('onSuccess:'));
  assert.ok(commitCall.length > 0, 'نداء الاعتماد غير موجود');
  assert.doesNotMatch(commitCall, /opening\.(?!snapshotAt\b)/, 'لا تُمرَّر أرقام القيد الافتتاحي المعروضة إلى الاعتماد');
  assert.doesNotMatch(commitCall, /q\.data\.(?:move|manual|receivables)/);
});

test('حركات مستوردة بعد تاريخ البدء: التنبيه عند count>0، والإقرار شرط التفعيل، ومرآة الخادم', () => {
  assert.equal(hasPostCutoverImports({ count: 2 }), true);
  assert.equal(hasPostCutoverImports({ count: 0 }), false);
  assert.equal(hasPostCutoverImports(undefined), false, 'خادم أقدم بلا الحقل ⇒ لا تنبيه');
  assert.equal(importsAckBlocksCommit({ count: 2 }, false), true);
  assert.equal(importsAckBlocksCommit({ count: 2 }, true), false);
  assert.equal(importsAckBlocksCommit({ count: 0 }, false), false);
  const api = read(webSrc, 'api', 'ledgerSetup.ts');
  // البند 41: اللقطة تُمرَّر كما هي إلى جسم الطلب (لا `true`)، والقيمة الكاذبة تُسقط الحقل
  assert.match(api, /\.\.\.\(opts\?\.acknowledgePostCutoverImports \? \{ acknowledgePostCutoverImports: opts\.acknowledgePostCutoverImports \} : \{\}\)/);
  const setup = read(backend, 'routes', 'ledger', 'setup.ts');
  assert.match(setup, /acknowledgePostCutoverImports: z\.union\(\[z\.boolean\(\), postCutoverImportsAckSchema\]\)\.optional\(\)/);
  assert.match(setup, /'LEDGER_POST_CUTOVER_IMPORTS_ACK'/);
  const review = read(webSrc, 'pages', 'ledger', 'setup', 'SetupReview.tsx');
  assert.match(review, /disabled=\{[^}]*importsBlocked/, 'زر التفعيل معطّل قبل الإقرار بالحركات المستوردة');
  assert.match(review, /ledgerSetupApi\.commit\(undefined, \{\s*acknowledgePostCutoverImports: importsAck && imported/);
  assert.match(review, /<PostCutoverImportsNotice data=\{q\.data\.importedAfterCutover\}/, 'التنبيه في الخطوة 4');
});

test('البند 41: الإقرار لقطةً بالأرقام المعروضة، تُعرض في نصّه ويسقط الإقرار بتغيّرها', () => {
  const setup = read(backend, 'routes', 'ledger', 'setup.ts');
  // مخطط اللقطة في الخادم: الحقول الأربعة بعينها
  const schema = /const postCutoverImportsAckSchema = z\.object\(\{([\s\S]*?)\}\)\.strict\(\);/.exec(setup)?.[1] ?? '';
  assert.ok(schema, 'مخطط اللقطة غير موجود في setup.ts');
  for (const f of ['count', 'debit', 'credit', 'snapshotAt']) assert.match(schema, new RegExp(`\\b${f}:`), f);
  // الرمز الجديد يُرمى من الخادم ويُدرَج في رموز إعادة المعاينة
  assert.match(setup, /'LEDGER_POST_CUTOVER_IMPORTS_CHANGED'\)/);
  assert.equal(commitNeedsRefresh('LEDGER_POST_CUTOVER_IMPORTS_CHANGED'), true);
  assert.ok((COMMIT_REFRESH_CODES as readonly string[]).includes('LEDGER_POST_CUTOVER_IMPORTS_CHANGED'));

  const review = read(webSrc, 'pages', 'ledger', 'setup', 'SetupReview.tsx');
  // اللقطة المرسلة هي الأرقام المعروضة ولحظة المعاينة نفسها
  assert.match(review, /\{ count: imported\.count, debit: imported\.debit, credit: imported\.credit, snapshotAt: q\.data\?\.opening\.snapshotAt \}/);
  // أرقام اللقطة داخل نصّ الإقرار لا مربع اختيار على مجهول
  const ackAt = review.indexOf('onChange={e => setImportsAck(');
  assert.ok(ackAt > 0, 'خانة إقرار الحركات المستوردة غير موجودة');
  const label = review.slice(ackAt, review.indexOf('</PostCutoverImportsNotice>', ackAt));
  assert.match(label, /راجعت هذه الأرقام وأوافق على ترحيل الحركات المستوردة بعد تاريخ البدء بتواريخها/);
  assert.match(label, /\{imported\.count\}/, 'عدد الحركات في نصّ الإقرار');
  assert.match(label, /value=\{imported\.debit\}/, 'مجموع المدين في نصّ الإقرار');
  assert.match(label, /value=\{imported\.credit\}/, 'مجموع الدائن في نصّ الإقرار');
  // تغيّر الأرقام المعروضة ⇒ الإقرار يسقط (لا إقرار مؤشَّر على أرقام لم تعد معروضة)، والتوقيع على القيم
  // لا على لحظة الجلب فلا يُلغى إقرار صحيح لمجرد إعادة جلب ردّت الأرقام نفسها
  assert.ok(review.includes('const importsAckSig = imported ? `${imported.count}|${imported.debit}|${imported.credit}` : \'\';'), 'توقيع لقطة الحركات المستوردة');
  assert.ok(review.includes('const stockAckSig = os ? `${os.afterCutover.count}|${os.afterCutover.value}|${os.fullHistoryBlocked}` : \'\';'), 'توقيع حكم المخزون الافتتاحي');
  assert.match(review, /useEffect\(\(\) => \{ setImportsAck\(false\); \}, \[importsAckSig\]\);/);
  assert.match(review, /useEffect\(\(\) => \{ setStockAck\(false\); \}, \[stockAckSig\]\);/);

  // نصّ الرمز في الواجهة = رسالة الخادم الحيّة نفسها
  const opening = read(backend, 'services', 'gl', 'opening.ts');
  const serverText = /LEDGER_POST_CUTOVER_IMPORTS_CHANGED_MESSAGE\s*=\s*'([^']+)'/.exec(opening)?.[1];
  assert.ok(serverText, 'رسالة الخادم غير موجودة في services/gl/opening.ts');
  const ui = read(webSrc, 'pages', 'ledger', 'setup', 'setupUi.tsx');
  assert.ok(ui.includes(`case 'LEDGER_POST_CUTOVER_IMPORTS_CHANGED': return tr('${serverText}')`), 'نص المعالج لا يطابق رسالة الخادم');
  assert.ok(ui.includes(`POST_CUTOVER_IMPORTS_CHANGED: tr('${serverText}')`), 'نص السبب لا يطابق رسالة الخادم');
});

test('تلميحات الخطوة 4: ذمم صفرية مع عملاء، ومخزون صفري مع منتجات', () => {
  const p = (ar: string, wh: string, customers: number, products: number) =>
    openingDataHints({ opening: { receivablesTotal: ar, warehouse: { value: wh } }, tenantCounts: { customers, products } });
  assert.deepEqual(p('0.00', '0.00', 5, 3), { receivablesMissing: true, inventoryMissing: true });
  assert.deepEqual(p('0.00', '0.00', 0, 0), { receivablesMissing: false, inventoryMissing: false });
  assert.deepEqual(p('150.00', '20.50', 5, 3), { receivablesMissing: false, inventoryMissing: false });
  assert.deepEqual(openingDataHints({ opening: { receivablesTotal: '0', warehouse: { value: '0' } } }), { receivablesMissing: false, inventoryMissing: false });
});

test('نص DERIVED_ACCOUNT حسب نوع الحساب: الذمم للاستيراد، والمخزون للمستودع، والباقي عام', () => {
  assert.equal(derivedAccountKind('AR', '113001'), 'AR');
  assert.equal(derivedAccountKind('INVENTORY', '114001'), 'INVENTORY');
  assert.equal(derivedAccountKind('CUSTODY', '111003'), 'OTHER');
  assert.equal(derivedAccountKind('PAYLINK', null), 'OTHER');
  assert.equal(derivedAccountKind(null, '113001'), 'AR', 'قبل زرع الشجرة يُستدل بالرمز');
  assert.equal(derivedAccountKind(null, 114001), 'INVENTORY');
  assert.equal(derivedAccountKind(null, '112005'), 'OTHER');
  const ui = read(webSrc, 'pages', 'ledger', 'setup', 'setupUi.tsx');
  const fn = ui.slice(ui.indexOf('export function derivedAccountText('), ui.indexOf('export function manualIssueText('));
  assert.match(fn, /kind === 'AR'[\s\S]*صفحة استيراد البيانات/);
  assert.match(fn, /kind === 'INVENTORY'[\s\S]*وارد المستودع/);
  assert.match(fn, /رصيد هذا الحساب يُحسب من المستندات ولا يُدخل يدويا/);
  for (const f of ['ManualBalances.tsx', 'SetupReview.tsx']) {
    assert.match(read(webSrc, 'pages', 'ledger', 'setup', f), /manualIssueText\(tr, is\.reason, /, `${f}: نص السبب حسب نوع الحساب`);
  }
});

test('الرابط إلى قسم الاستيراد: المرساة موجودة في إعدادات الشركة، وبطاقة «قبل أن تبدأ» في المعالج', () => {
  assert.equal(DATA_IMPORT_HREF, `/app/company#${DATA_IMPORT_ANCHOR}`);
  assert.match(read(webSrc, 'App.tsx'), /path="company"/);
  assert.ok(new RegExp(`id="${DATA_IMPORT_ANCHOR}"[^>]*>\\s*<DataImportPanel`).test(read(webSrc, 'pages', 'CompanySettingsPage.tsx')), 'مرساة قسم الاستيراد');
  const wizard = read(webSrc, 'pages', 'ledger', 'setup', 'SetupWizard.tsx');
  assert.match(wizard, /<BeforeYouStart /);
  assert.match(wizard, /tr\('قبل أن تبدأ'\)/);
  assert.match(wizard, /<ol[\s\S]*DataImportLink[\s\S]*WarehouseLink[\s\S]*<\/ol>/);
});

test('المخزون الافتتاحي في المعاينة: التاريخ الكامل يمنع، وبعد البدء يطلب إقراراً، والأحدث من اللقطة ينتظر retryAfter', () => {
  const now = new Date('2026-09-17T10:00:00.000Z');
  const os = (o: { fh?: boolean; after?: number; min?: string | null; recent?: number; retry?: string | null }) => ({
    fullHistoryBlocked: o.fh ?? false,
    afterCutover: { count: o.after ?? 0, minCutoverDate: o.min ?? null },
    tooRecent: { count: o.recent ?? 0, retryAfter: o.retry ?? null },
  });
  assert.equal(openingStockReview(undefined, false, now).block, null, 'خادم أقدم بلا openingStock');
  assert.equal(openingStockReview(undefined, false, now).visible, false);
  assert.equal(openingStockReview(os({}), false, now).visible, false);

  const fh = openingStockReview(os({ fh: true, after: 1, min: '2026-09-18' }), true, now);
  assert.equal(fh.block, 'FULL_HISTORY', 'الإقرار لا يرفع منع التاريخ الكامل');

  const after = openingStockReview(os({ after: 2, min: '2026-09-18' }), false, now);
  assert.deepEqual([after.visible, after.afterCutover, after.minCutoverDate, after.block], [true, true, '2026-09-18', 'AFTER_CUTOVER_ACK']);
  assert.equal(openingStockReview(os({ after: 2, min: '2026-09-18' }), true, now).block, null);

  const recent = openingStockReview(os({ recent: 1, retry: '2026-09-17T10:04:00.000Z' }), false, now);
  assert.deepEqual([recent.tooRecent, recent.waitMs, recent.block], [true, 240_000, 'TOO_RECENT']);
  const passed = openingStockReview(os({ recent: 1, retry: '2026-09-17T09:59:00.000Z' }), false, now);
  assert.deepEqual([passed.waitMs, passed.block], [0, null]);
  // ترتيب فحوص الخادم: بعد البدء قبل الأحدث من اللقطة
  assert.equal(openingStockReview(os({ after: 1, recent: 1, retry: '2026-09-17T10:04:00.000Z' }), false, now).block, 'AFTER_CUTOVER_ACK');
  assert.equal(openingStockReview(os({ after: 1, recent: 1, retry: '2026-09-17T10:04:00.000Z' }), true, now).block, 'TOO_RECENT');

  // مخزون مستورد خارج الافتتاح ⇒ لا تلميح «مخزون صفري»
  assert.equal(openingDataHints({ opening: { receivablesTotal: '0', warehouse: { value: '0' } }, tenantCounts: { customers: 0, products: 3 }, openingStock: { batches: 1 } }).inventoryMissing, false);
});

test('رفض الاعتماد بسبب الاستيراد أو المخزون يعيد المعاينة، ورموزه مرآة setup.ts', () => {
  const setup = read(backend, 'routes', 'ledger', 'setup.ts');
  for (const code of COMMIT_REFRESH_CODES) assert.ok(setup.includes(`'${code}')`), code);
  assert.equal(commitNeedsRefresh('LEDGER_OPENING_STOCK_TOO_RECENT'), true);
  assert.equal(commitNeedsRefresh('LEDGER_CUTOVER_IN_FUTURE'), false);
  assert.equal(commitNeedsRefresh(null), false);
  assert.match(setup, /acknowledgeOpeningStockExcluded: z\.boolean\(\)\.optional\(\)/);
  assert.match(read(webSrc, 'api', 'ledgerSetup.ts'), /acknowledgeOpeningStockExcluded: true/);
  const review = read(webSrc, 'pages', 'ledger', 'setup', 'SetupReview.tsx');
  assert.match(review, /acknowledgeOpeningStockExcluded: stockAck/, 'الإقرار يُمرَّر للاعتماد');
  assert.match(review, /disabled=\{[^}]*stockBlocked/, 'زر التفعيل ينتظر حكم المخزون الافتتاحي');
  assert.match(review, /commitNeedsRefresh\(code\)/, 'إعادة المعاينة بعد 409');
  const ui = read(webSrc, 'pages', 'ledger', 'setup', 'setupUi.tsx');
  assert.match(ui, /export function OpeningStockNotice/);
  assert.match(ui, /tr\('قيمة إرشادية/, 'القيمة إرشادية');
});

test('«قبل أن تبدأ»: المخزون الافتتاحي يُستورد قبل ضبط تاريخ البدء، والاعتماد في يوم لاحق', () => {
  const wizard = read(webSrc, 'pages', 'ledger', 'setup', 'SetupWizard.tsx');
  const card = wizard.slice(wizard.indexOf('function BeforeYouStart'));
  const stock = card.indexOf('استورد المخزون الافتتاحي');
  const cutover = card.indexOf('حدّد تاريخ البدء في الخطوة 1');
  assert.ok(stock > 0 && cutover > stock, 'بند المخزون قبل بند تاريخ البدء');
  assert.match(card, /في يوم لاحق/);
});

// ═══ دفعة الإصلاحات 2 (مراجعة 2026-09-17) ═══

test('البند 26: روابط الفئات تُصفّى على الفئات القائمة، ولا تُمحى حين القائمة غير معروفة', () => {
  const links = { 'cat-live': '4101', 'cat-dead': '4102', 'cat-empty': '' };
  // القائمة معروفة ⇒ معرّف فئة محذوفة يُسقط ولا يُعاد حفظه في المسودة
  assert.deepEqual(keepLiveCategoryLinks(links, new Set(['cat-live'])), [{ categoryId: 'cat-live', accountCode: '4101' }]);
  // القائمة غير معروفة (catsQ معطّلة قبل زرع الشجرة أو فشل الاستعلام) ⇒ الروابط كما هي
  assert.deepEqual(keepLiveCategoryLinks(links, null), [
    { categoryId: 'cat-live', accountCode: '4101' }, { categoryId: 'cat-dead', accountCode: '4102' },
  ]);
  assert.deepEqual(keepLiveCategoryLinks({}, new Set(['cat-live'])), []);
  // والخطوة 3 تستعملها فعلاً بدل الترشيح على وجود الكود وحده
  const steps = read(webSrc, 'pages', 'ledger', 'setup', 'SetupSteps.tsx');
  assert.match(steps, /keepLiveCategoryLinks\(catCodes, liveCategoryIds\)/);
  assert.doesNotMatch(steps, /Object\.entries\(catCodes\)\.filter\(\(\[, code\]\) => !!code\)/);
  assert.match(steps, /catsQ\.data && !catsQ\.isError/, 'الترشيح لا يتحقق من توفّر قائمة الفئات');
  // والمتخطّى عند الاعتماد يُعرض للمالك بالعبارة المترجمة سلفاً
  const review = read(webSrc, 'pages', 'ledger', 'setup', 'SetupReview.tsx');
  assert.match(review, /result\.step3\?\.skippedCategoryLinks\?\.length/);
  assert.match(review, /رابط فئة إلى حساب إيراد تُخطّي لأن الفئة لم تعد موجودة/);
  assert.match(read(webSrc, 'api', 'ledgerSetup.ts'), /skippedCategoryLinks: \{ categoryId: string; accountCode: string \}\[\]/);
  // والخادم يعيدها فعلاً
  assert.match(read(backend, 'routes', 'ledger', 'setup.ts'), /skippedCategoryLinks/);
});

test('البند 25: تعارض المنطقة الزمنية يُقرأ بتفاصيله وللواجهة مسار إقرار يعيد إرسال الطلب', () => {
  const body = {
    code: TIMEZONE_IMPORTS_CONFLICT_CODE,
    details: {
      reason: 'IMPORT_TIMEZONE_CONFLICT', previousTimezone: 'Asia/Riyadh', timezone: 'Europe/Istanbul', field: 'rebaseImportDates',
      batches: [{ id: 'b1', kind: 'ledger', count: 12, createdAt: '2026-09-01T10:00:00.000Z' }],
    },
  };
  const c = timezoneImportsConflictOf(body);
  assert.deepEqual(c, {
    previousTimezone: 'Asia/Riyadh', timezone: 'Europe/Istanbul',
    batches: [{ id: 'b1', kind: 'ledger', count: 12, createdAt: '2026-09-01T10:00:00.000Z' }],
  });
  assert.equal(timezoneImportsConflictOf({ code: 'LEDGER_IMPORT_IN_PROGRESS', details: {} }), null);
  assert.equal(timezoneImportsConflictOf(null), null);
  // تفاصيل ناقصة من خادم أقدم لا تُسقط الشاشة
  assert.deepEqual(timezoneImportsConflictOf({ code: TIMEZONE_IMPORTS_CONFLICT_CODE }), { previousTimezone: '', timezone: '', batches: [] });

  // الرمز نفسه في الخادم
  assert.match(read(backend, 'services', 'importTimezoneRebase.ts'), /LEDGER_TIMEZONE_IMPORTS_CONFLICT/);
  // واجهة: المسودة والاعتماد يمرّران الإقرار، والمعالج يلتقط الرمز ويعيد الإرسال
  const api = read(webSrc, 'api', 'ledgerSetup.ts');
  assert.match(api, /saveDraft: \(draft: SetupDraft, opts\?: \{ rebaseImportDates\?: boolean \}\)/);
  assert.match(api, /rebaseImportDates: true/);
  assert.match(api, /rebasedImportEntries\?: number/);
  const wizard = read(webSrc, 'pages', 'ledger', 'setup', 'SetupWizard.tsx');
  assert.match(wizard, /timezoneImportsConflictOf/);
  assert.match(wizard, /rebaseImportDates: true/);
  assert.match(wizard, /rebasedImportEntries/);
  assert.match(wizard, /TimezoneImportsConflictNotice/);
  const ui = read(webSrc, 'pages', 'ledger', 'setup', 'setupUi.tsx');
  assert.match(ui, /أكّد إعادة ضبط تواريخ الأرصدة والكشوف المستوردة على المنطقة الزمنية الجديدة/);
  assert.match(ui, /case 'LEDGER_TIMEZONE_IMPORTS_CONFLICT'/);
  // ومسار الاعتماد يلتقطه كذلك
  const review = read(webSrc, 'pages', 'ledger', 'setup', 'SetupReview.tsx');
  assert.match(review, /timezoneImportsConflictOf/);
  assert.match(review, /rebaseImportDates: true/);
  // والرمز له نصّه في قائمة رموز التهيئة فلا يسقط على رسالة عامة
  assert.match(read(webSrc, 'lib', 'ledger', 'labels.ts'), /LEDGER_TIMEZONE_IMPORTS_CONFLICT: tr\(/);
});
