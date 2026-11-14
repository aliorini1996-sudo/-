// «ربط الدفاتر» L2 — الفحوص المسبقة P1..P14 (services/gl/linking/preflight.ts — العقد scratchpad/l23_contract.md §12، §17 P3).
// بلا قاعدة: قاعدة مزيّفة بشكل Prisma (p3-preflight-fake-db.ts) بدلالة SQL للقيم الفارغة، تُحصي كل كتابة وترمي، وعميلها
// الحارس يرمي عند أي gl* (كالعميل الوكيل في ظلّ المعاينة). لكل فحص حالة ناجحة وفاشلة، والمستويات (P6 = W؛ P7 = B للقالب
// السعودي وW للعام؛ P13 = B فوق سقف المنصّة؛ P14 لا ينطبق لغير التحويل)، وLIGHT بلا محرّك التكلفة ولا أحداث الظلّ، وFULL
// يستعملهما، وblocking/warnings، وصفر كتابات، وعدد استعلامات ثابت لا يتبع حجم البيانات (بلا N+1)، والمسح المقسَّم بالمؤشّر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  P13_WARN_EVENTS, PREFLIGHT_DEFAULT_LEVEL, PREFLIGHT_LIGHT_ROUNDING_SCAN, PREFLIGHT_PAGE_SIZE, PREFLIGHT_TITLES_AR,
  estimateLinkVolume, evaluateP12, evaluateP13, invoiceRoundingDiff, preflightCheck, preflightReport, runPreflight,
} from '../services/gl/linking/preflight';
import {
  LINKED_DEFAULT_RECEIPT_ROUTING, PLATFORM_EVENT_CAP, PREFLIGHT_CODES, PREVIEW_LIST_CAPS,
  type LinkingSettingsRow, type PreflightCheck, type PreflightCode, type PreflightEventStats, type PreflightInput, type PreflightReport,
} from '../services/gl/linking/types';
import type { CostingSummary } from '../services/costing/types';
import { zonedStartOfDay } from '../services/gl/dates';
import { toMilli } from '../services/gl/money';
import { FakeDb, type Row } from './p3-preflight-fake-db';

const T = 't1';
const TZ = 'Asia/Riyadh';
const LINKED_FROM = '2026-01-01';
const NOW = new Date('2026-11-14T09:00:00.000Z');
const CUT = zonedStartOfDay(LINKED_FROM, TZ); // 2025-12-31T21:00:00Z
const IN_FY = new Date('2026-03-10T08:00:00.000Z');
const BEFORE = new Date('2025-06-01T08:00:00.000Z');
const at = (iso: string) => new Date(iso);

function settingsRow(over: Partial<LinkingSettingsRow> = {}): LinkingSettingsRow {
  return {
    templateKey: 'SA_6D', countryCode: 'SA', currency: 'SAR', currencyDecimals: 2, timezone: TZ, fiscalYearEndMonth: 12, fiscalYearEndDay: 31,
    weekStartsOn: 0, cutoverDate: null, inventoryMode: 'PERIODIC', perpetualFromDate: null, salesLockDate: null, purchaseLockDate: null,
    taxLockDate: null, hardLockDate: null, taxPeriodicity: 'QUARTERLY', taxDeadlineRule: 'END_OF_NEXT_MONTH', taxDeadlineDays: null,
    zeroRatedSalesTaxKey: 'Z_SALE', postSalesDiscountSeparately: true, postReturnsToContra: false, receiptRouting: null,
    cashInvoiceRouting: 'MAIN_CASH', paylinkFeeTaxInvoiceFrom: null, postPurchaseDiscountSeparately: false, billPricesIncludeTax: false,
    earlyDiscountAdjustsVat: false, taxRoundingMethod: 'PER_TAX', defaultPurchaseTaxId: null,
    activatedAt: null, setupMethod: null, linkPreviewId: null,
    ...over,
  } as LinkingSettingsRow;
}

function input(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    mode: 'LIGHT', basis: 'FY_RESTATED', linkedFrom: LINKED_FROM, timezone: TZ, templateKey: 'SA_6D', currency: 'SAR', currencyDecimals: 2,
    receiptRouting: { ...LINKED_DEFAULT_RECEIPT_ROUTING }, cashInvoiceRouting: 'MAIN_CASH', settingsRow: null,
    draft: { step1: { fiscalYearEndMonth: 12, fiscalYearEndDay: 31 }, step3: { cashInvoiceRouting: 'MAIN_CASH' } },
    suiteEnabled: true, workerEnabled: true, now: NOW, costing: null, eventStats: null,
    ...over,
  };
}

function costing(over: Partial<CostingSummary> = {}): CostingSummary {
  return {
    moveCount: 120, productCount: 2, openingByLocation: [], nowByLocation: [], fyCogsMilli: 0n, fyVarianceMilli: 0n, fyWriteOffMilli: 0n,
    uncostedAtCutover: [], uncostedAtCutoverTotalQty: 0, negativeAtCutover: [], holesFy: { count: 0, varianceMilli: 0n, sample: [] }, warnings: [],
    ...over,
  };
}

const events = (over: Partial<PreflightEventStats> = {}): PreflightEventStats => ({
  eventsToPost: 500, autoSalePercents: [], byType: { INVOICE: 300, RECEIPT: 200 }, ...over,
});

const FULL = (over: Partial<PreflightInput> = {}) => input({ mode: 'FULL', costing: costing(), eventStats: events(), ...over });

/** شركة «نظيفة»: كل فحص ناجح. وثائق قبل بداية السنة وبعدها، بمندوب، ومسعَّرة ومصنَّفة */
function world(): FakeDb {
  const db = new FakeDb();
  db.add('tenant', { id: T, warehouseEnabled: true, erpEnabled: false, accountingSuiteEnabled: true });
  db.add('tenant', { id: 'other', warehouseEnabled: true, erpEnabled: true });
  db.add('companySettings', { tenantId: T, countryCode: 'SA', currency: 'SAR', currencyOverride: null, paymentMethodsConfig: null });
  db.add('product', { id: 'p1', tenantId: T, name: 'ماء 330' }, { id: 'p2', tenantId: T, name: 'عصير برتقال' });
  db.add('salesRep', { id: 'r1', tenantId: T, name: 'أحمد' });
  // وارد قبل السنة مسعَّر (غير مصنَّف — قديم، لا يُفحص في P10)، ووارد السنة مسعَّر ومصنَّف
  db.add('warehouseEntry',
    { id: 'we0', tenantId: T, type: 'RECEIVE', createdAt: BEFORE, vendorId: null, paymentMode: null, supplier: null, source: 'MANUAL' },
    { id: 'we1', tenantId: T, type: 'RECEIVE', createdAt: IN_FY, vendorId: 'v1', paymentMode: 'CREDIT', supplier: 'مورّد المياه', source: 'MANUAL' });
  db.add('warehouseEntryItem',
    { id: 'wi0', entryId: 'we0', productId: 'p1', qty: 100, unitCost: 2 },
    { id: 'wi1', entryId: 'we1', productId: 'p1', qty: 10, unitCost: 2.5 });
  db.add('invoice', inv({ id: 'i0', number: 'INV-0', invoiceDate: BEFORE }), inv({ id: 'i1', number: 'INV-1' }));
  db.add('invoiceItem', { id: 'ii0', invoiceId: 'i0', productId: 'p1', taxPct: 15, vatCategory: 'S' }, { id: 'ii1', invoiceId: 'i1', productId: 'p1', taxPct: 15, vatCategory: 'S' });
  db.add('receipt', { id: 'rc1', tenantId: T, paymentMethod: 'CASH', paymentMethodKey: null, receiptDate: IN_FY, deletedSalesRepId: null });
  db.add('accountEntry',
    { id: 'ae0', tenantId: T, entryDate: BEFORE, createdAt: BEFORE, debit: 115, credit: 0, description: 'فاتورة INV-0' },
    { id: 'ae1', tenantId: T, entryDate: IN_FY, createdAt: IN_FY, debit: 115, credit: 0, description: 'فاتورة INV-1' });
  db.add('vanLoad', { id: 'vl1', tenantId: T, salesRepId: 'r1', deletedSalesRepId: null, type: 'LOAD', createdAt: IN_FY });
  db.add('vanLoadItem', { id: 'vli1', vanLoadId: 'vl1', productId: 'p1', qty: 5 });
  // شركة أخرى بكل ما يفشل — العزل بـtenantId
  db.add('invoice', inv({ id: 'x1', tenantId: 'other', salesRepId: null, currency: 'USD', total: 999 }));
  db.add('invoiceItem', { id: 'xi1', invoiceId: 'x1', productId: 'px', taxPct: 5, vatCategory: 'S' });
  db.add('warehouseEntry', { id: 'xw1', tenantId: 'other', type: 'RECEIVE', createdAt: IN_FY, vendorId: null, paymentMode: null, supplier: null, source: 'MANUAL' });
  db.add('warehouseEntryItem', { id: 'xwi1', entryId: 'xw1', productId: 'px', qty: 1, unitCost: null });
  db.add('receipt', { id: 'xr1', tenantId: 'other', paymentMethod: 'WALLET', paymentMethodKey: null, receiptDate: IN_FY, deletedSalesRepId: 'ghost' });
  db.add('accountEntry', { id: 'xae', tenantId: 'other', entryDate: at('2030-01-01T00:00:00Z'), createdAt: IN_FY, debit: 1, credit: 0, description: 'x' });
  return db;
}

function inv(over: Row = {}): Row {
  return {
    tenantId: T, salesRepId: 'r1', type: 'CREDIT', status: 'CONFIRMED', invoiceDate: IN_FY, taxFree: false, currency: 'SAR', documentKind: null,
    subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115, ...over,
  };
}

const run = (db: FakeDb, over: Partial<PreflightInput> = {}) => runPreflight(db.client(), T, input(over));
const runFull = (db: FakeDb, over: Partial<PreflightInput> = {}) => runPreflight(db.client(), T, FULL(over));
const check = (r: PreflightReport, code: PreflightCode): PreflightCheck => {
  const c = r.checks.find((x) => x.code === code);
  assert.ok(c, `الفحص ${code} غائب`);
  return c;
};
const failing = (r: PreflightReport) => r.checks.filter((c) => !c.ok).map((c) => c.code);

// ═══ الشركة النظيفة والبنية ═══

test('شركة نظيفة: P1..P14 بالترتيب كلها ناجحة في LIGHT وFULL، وP14 لا ينطبق، وblocking = warnings = 0', async () => {
  for (const r of [await run(world()), await runFull(world())]) {
    assert.deepEqual(r.checks.map((c) => c.code), [...PREFLIGHT_CODES]);
    assert.deepEqual(failing(r), [], JSON.stringify(r.checks.filter((c) => !c.ok), (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
    assert.equal(r.blocking, 0);
    assert.equal(r.warnings, 0);
    assert.equal(r.linkedFrom, LINKED_FROM);
    assert.equal(r.basis, 'FY_RESTATED');
    for (const c of r.checks) {
      assert.equal(c.titleAr, PREFLIGHT_TITLES_AR[c.code]);
      assert.ok(c.details.length > 10, `${c.code}: تفاصيل عربية`);
      assert.ok((c.items ?? []).length <= PREVIEW_LIST_CAPS.preflightItems);
    }
    assert.equal(check(r, 'P14').notApplicable, true);
  }
  const light = await run(world());
  assert.equal(light.mode, 'LIGHT');
  assert.ok(light.checks.every((c) => c.mode === 'LIGHT'));
  const full = await runFull(world());
  assert.equal(full.mode, 'FULL');
  for (const code of ['P7', 'P9', 'P10', 'P13'] as const) assert.equal(check(full, code).mode, 'FULL', code);
});

test('LIGHT لا يحتاج costing ولا eventStats (غائبان تماماً)، وFULL بلا أحدهما يسقط فحصه وحده إلى التقدير بعلامة LIGHT', async () => {
  const bare = input();
  delete (bare as Partial<PreflightInput>).costing;
  delete (bare as Partial<PreflightInput>).eventStats;
  const r = await runPreflight(world().client(), T, bare);
  assert.deepEqual(failing(r), []);
  const fullNoCost = await runPreflight(world().client(), T, input({ mode: 'FULL', eventStats: events(), costing: null }));
  assert.equal(fullNoCost.mode, 'FULL');
  assert.equal(check(fullNoCost, 'P9').mode, 'LIGHT');
  assert.equal(check(fullNoCost, 'P10').mode, 'LIGHT');
  assert.equal(check(fullNoCost, 'P13').mode, 'FULL');
  assert.equal(check(fullNoCost, 'P7').mode, 'FULL');
  const fullNoEvents = await runPreflight(world().client(), T, input({ mode: 'FULL', eventStats: null, costing: costing() }));
  assert.equal(check(fullNoEvents, 'P13').mode, 'LIGHT');
  assert.equal(check(fullNoEvents, 'P7').mode, 'LIGHT');
  assert.equal(check(fullNoEvents, 'P9').mode, 'FULL');
});

test('المستويات الافتراضية كالعقد §12: P6 وP10..P13 = W والبقية B', () => {
  assert.deepEqual(
    PREFLIGHT_CODES.filter((c) => PREFLIGHT_DEFAULT_LEVEL[c] === 'W'),
    ['P6', 'P10', 'P11', 'P12', 'P13'],
  );
  for (const c of PREFLIGHT_CODES) assert.ok(PREFLIGHT_TITLES_AR[c].length > 5);
});

test('preflightCheck: يقصّ العناصر إلى 50 مع itemsTruncated، ويحسب من itemsTotal للعيّنة، و«لا ينطبق» ناجح دائماً', () => {
  const items = Array.from({ length: 60 }, (_v, i) => ({ id: `x${i}`, label: `عنصر ${i}` }));
  const a = preflightCheck('P11', 'LIGHT', { ok: false, details: 'd', items });
  assert.equal(a.items!.length, 50);
  assert.equal(a.itemsTruncated, 10);
  assert.equal(a.items![49].id, 'x49');
  assert.equal(a.level, 'W');
  const b = preflightCheck('P12', 'FULL', { ok: false, details: 'd', items: items.slice(0, 50), itemsTotal: 75 });
  assert.equal(b.itemsTruncated, 25);
  assert.equal(b.mode, 'FULL');
  const c = preflightCheck('P14', 'LIGHT', { ok: false, notApplicable: true, details: 'd' });
  assert.equal(c.ok, true);
  assert.equal(c.notApplicable, true);
  assert.equal(c.itemsTruncated, undefined);
  const d = preflightCheck('P7', 'LIGHT', { level: 'W', ok: false, details: 'd' });
  assert.equal(d.level, 'W');
});

test('preflightReport: يرتّب P1..P14 ويعدّ B وW غير المتحققة وحدها', () => {
  const mk = (code: PreflightCode, level: 'B' | 'W', ok: boolean, notApplicable = false) => preflightCheck(code, 'LIGHT', { level, ok, notApplicable, details: 'd' });
  const r = preflightReport({ mode: 'LIGHT', basis: 'FROM_ACTIVATION', linkedFrom: '2026-11-14' }, [
    mk('P13', 'B', false), mk('P2', 'B', false), mk('P6', 'W', false), mk('P10', 'W', true), mk('P14', 'B', false, true), mk('P1', 'B', true),
  ]);
  assert.deepEqual(r.checks.map((c) => c.code), ['P1', 'P2', 'P6', 'P10', 'P13', 'P14']);
  assert.equal(r.blocking, 2);
  assert.equal(r.warnings, 1);
  assert.equal(r.basis, 'FROM_ACTIVATION');
});

// ═══ P1 ═══

test('P1 (B): الحزمة المحاسبية أو المُرحِّل موقوف ⇒ يحجب', async () => {
  const a = await run(world(), { suiteEnabled: false });
  assert.equal(check(a, 'P1').ok, false);
  assert.equal(check(a, 'P1').level, 'B');
  assert.match(check(a, 'P1').details, /غير مفعّل/);
  assert.ok(a.blocking >= 1);
  const b = await run(world(), { workerEnabled: false });
  assert.equal(check(b, 'P1').ok, false);
  assert.match(check(b, 'P1').details, /LEDGER_WORKER_ENABLED/);
  assert.equal(check(await run(world()), 'P1').ok, true);
});

// ═══ P2 ═══

test('P2 (B): نهاية السنة غير مؤكَّدة ⇒ يحجب؛ مؤكَّدة في المسودة أو الصف ⇒ ناجح ويعرض linkedFrom وopeningDate', async () => {
  const none = await run(world(), { draft: null, settingsRow: null });
  assert.equal(check(none, 'P2').ok, false);
  assert.equal(check(none, 'P2').level, 'B');
  assert.match(check(none, 'P2').details, /2026-01-01/);
  assert.match(check(none, 'P2').details, /2025-12-31/);
  const fromRow = await run(world(), { draft: { step3: { cashInvoiceRouting: 'MAIN_CASH' } }, settingsRow: settingsRow() });
  assert.equal(check(fromRow, 'P2').ok, true);
  assert.match(check(fromRow, 'P2').details, /31\/12/);
  const ok = await run(world());
  assert.equal(check(ok, 'P2').ok, true);
  assert.match(check(ok, 'P2').details, /الربط من 2026-01-01 والقيد الافتتاحي بتاريخ 2025-12-31/);
});

test('P2: سنة مالية تنتهي 30/06 ⇒ تاريخ الربط يجب أن يكون 01/07؛ ويوم غير صالح للشهر يحجب', async () => {
  const draft = { step1: { fiscalYearEndMonth: 6, fiscalYearEndDay: 30 }, step3: { cashInvoiceRouting: 'MAIN_CASH' as const } };
  assert.equal(check(await run(world(), { draft, linkedFrom: '2026-07-01' }), 'P2').ok, true);
  const mismatch = await run(world(), { draft, linkedFrom: '2026-01-01' });
  assert.equal(check(mismatch, 'P2').ok, false);
  assert.match(check(mismatch, 'P2').details, /ليس بداية سنةٍ مالية/);
  // FROM_ACTIVATION: الربط من اليوم — لا يُشترط أن يكون بداية سنة
  assert.equal(check(await run(world(), { draft, basis: 'FROM_ACTIVATION', linkedFrom: '2026-11-14' }), 'P2').ok, true);
  const bad = await run(world(), { draft: { step1: { fiscalYearEndMonth: 2, fiscalYearEndDay: 30 } } });
  assert.equal(check(bad, 'P2').ok, false);
  assert.match(check(bad, 'P2').details, /ليست تاريخاً صالحاً/);
});

// ═══ P3 ═══

test('P3 (B): عملة الشركة تخالف عملة الدفاتر ⇒ يحجب', async () => {
  const db = world();
  db.tables.companySettings[0].currencyOverride = 'USD';
  const r = await run(db);
  assert.equal(check(r, 'P3').ok, false);
  assert.equal(check(r, 'P3').level, 'B');
  assert.match(check(r, 'P3').details, /USD تخالف عملة الدفاتر SAR/);
});

test('P3: فواتير بعملة أخرى ⇒ يحجب مع العدد لكل عملة؛ الفارغة (قديمة) وحالة الأحرف لا تُعدّ مخالفة؛ ولا صفّ إعدادات ⇒ عملة الدفاتر', async () => {
  const db = world();
  db.add('invoice', inv({ id: 'u1', number: 'U1', currency: 'USD', invoiceDate: BEFORE }), inv({ id: 'u2', number: 'U2', currency: 'USD' }),
    inv({ id: 'n1', number: 'N1', currency: null }), inv({ id: 'l1', number: 'L1', currency: 'sar' }));
  const r = await run(db);
  const p3 = check(r, 'P3');
  assert.equal(p3.ok, false);
  assert.equal(p3.count, 2);
  assert.deepEqual(p3.items, [{ id: 'USD', label: 'فواتير بعملة USD', qty: 2 }]);
  const clean = world();
  clean.tables.companySettings.length = 0;
  assert.equal(check(await run(clean), 'P3').ok, true);
});

// ═══ P4 ═══

test('P4 (B): إقفال داخل سنة الربط أو يوم القيد الافتتاحي ⇒ يحجب؛ إقفال قبلهما ⇒ ناجح', async () => {
  const inFy = await run(world(), { settingsRow: settingsRow({ hardLockDate: at('2026-03-31T00:00:00Z') }) });
  const p = check(inFy, 'P4');
  assert.equal(p.ok, false);
  assert.equal(p.level, 'B');
  assert.deepEqual(p.items!.map((i) => [i.id, i.date]), [['hardLockDate', '2026-03-31']]);
  // آخر يوم في السنة السابقة = يوم القيد الافتتاحي: الإقفال الشائع، ويُزيح القيد الافتتاحي (post.ts SHIFT)
  const opening = await run(world(), { settingsRow: settingsRow({ salesLockDate: at('2025-12-31T00:00:00Z'), taxLockDate: at('2026-01-01T00:00:00Z') }) });
  assert.deepEqual(check(opening, 'P4').items!.map((i) => i.id), ['salesLockDate', 'taxLockDate']);
  assert.match(check(opening, 'P4').items![0].label, /يوم القيد الافتتاحي/);
  // إقفال = تاريخ الربط نفسه يقع في سنة الربط (يزيح مستنداتها) لا في يوم الافتتاح وحده
  assert.match(check(opening, 'P4').items![1].label, /^إقفال الضريبة 2026-01-01: يقع في سنة الربط/);
  const ok = await run(world(), { settingsRow: settingsRow({ purchaseLockDate: at('2025-12-30T00:00:00Z'), hardLockDate: at('2025-11-30T00:00:00Z') }) });
  assert.equal(check(ok, 'P4').ok, true);
});

// ═══ P5 ═══

test('P5 (B): دفعة استيراد جارية بنبضٍ حيّ ⇒ يحجب؛ المنقطعة (نبض > 10 دقائق) والمنتهية لا تحجب', async () => {
  const db = world();
  db.add('importBatch', { id: 'b1', tenantId: T, kind: 'ledger', reverted: false, status: 'running', heartbeatAt: new Date(NOW.getTime() - 60_000), createdAt: at('2026-11-14T08:50:00Z'), recordIds: '[]' });
  const r = await run(db);
  assert.equal(check(r, 'P5').ok, false);
  assert.equal(check(r, 'P5').level, 'B');
  assert.match(check(r, 'P5').details, /دفعة استيراد \(القيود\) جارية الآن/);
  db.tables.importBatch[0].heartbeatAt = new Date(NOW.getTime() - 11 * 60_000);
  assert.equal(check(await run(db), 'P5').ok, true);
  db.tables.importBatch[0].status = 'done';
  assert.equal(check(await run(db), 'P5').ok, true);
});

test('P5: حركات دفعات opening_stock كلها بمصدر OPENING_IMPORT وإلا تحجب؛ المتراجَع عنها لا تُفحص', async () => {
  const db = world();
  db.add('importBatch',
    { id: 'os', tenantId: T, kind: 'opening_stock', reverted: false, status: 'done', createdAt: BEFORE, recordIds: JSON.stringify(['ok1', 'bad1']) },
    { id: 'rv', tenantId: T, kind: 'opening_stock', reverted: true, status: 'done', createdAt: BEFORE, recordIds: JSON.stringify(['bad2']) });
  db.add('warehouseEntry',
    { id: 'ok1', tenantId: T, type: 'RECEIVE', createdAt: BEFORE, source: 'OPENING_IMPORT', vendorId: null, paymentMode: null },
    { id: 'bad1', tenantId: T, type: 'RECEIVE', createdAt: BEFORE, source: 'MANUAL', vendorId: null, paymentMode: null },
    { id: 'bad2', tenantId: T, type: 'RECEIVE', createdAt: BEFORE, source: 'MANUAL', vendorId: null, paymentMode: null });
  const p = check(await run(db), 'P5');
  assert.equal(p.ok, false);
  assert.equal(p.count, 1);
  assert.deepEqual(p.items!.map((i) => i.id), ['bad1']);
  assert.match(p.items![0].label, /الدفعة os بمصدر MANUAL/);
  db.tables.warehouseEntry.find((e) => e.id === 'bad1')!.source = 'OPENING_IMPORT';
  const fixed = check(await run(db), 'P5');
  assert.equal(fixed.ok, true);
  assert.match(fixed.details, /\(1\)/);
});

// ═══ P6 ═══

test('P6 (W): أودو مفعّل ⇒ تحذير لا حجب (OD19)؛ تكامل غير أودو أو الصلاحية مطفأة ⇒ ناجح', async () => {
  const db = world();
  db.tables.tenant[0].erpEnabled = true;
  db.add('erpIntegration', { tenantId: T, enabled: true, provider: 'ODOO' });
  const r = await run(db);
  assert.equal(check(r, 'P6').ok, false);
  assert.equal(check(r, 'P6').level, 'W');
  assert.equal(r.blocking, 0);
  assert.equal(r.warnings, 1);
  db.tables.erpIntegration[0].provider = 'CUSTOM';
  assert.equal(check(await run(db), 'P6').ok, true);
  db.tables.erpIntegration[0].provider = 'ODOO';
  db.tables.tenant[0].erpEnabled = false;
  assert.equal(check(await run(db), 'P6').ok, true);
});

// ═══ P7 ═══

test('P7 (B للقالب السعودي): نسبة 5٪ على مبيعات الفترة بلا ضريبة قالبية ⇒ يحجب (AUTO_SALE_5 بلا مربع)', async () => {
  const db = world();
  db.add('invoice', inv({ id: 'i5', number: 'I5' }));
  db.add('invoiceItem', { id: 'a', invoiceId: 'i5', productId: 'p1', taxPct: 5, vatCategory: 'S' }, { id: 'b', invoiceId: 'i5', productId: 'p2', taxPct: 5, vatCategory: null });
  const p = check(await run(db), 'P7');
  assert.equal(p.ok, false);
  assert.equal(p.level, 'B');
  assert.equal(p.count, 1);
  assert.equal(p.items!.length, 1);
  assert.equal(p.items![0].qty, 2);
  assert.match(p.items![0].label, /AUTO_SALE_5 بلا مربع إقرار/);
});

test('P7: المعفاة (taxFree) وما قبل السنة والمسودّة لا تُفحص؛ والصفرية والمعفاة والخارجة عن النطاق ناجحة', async () => {
  const db = world();
  db.add('invoice', inv({ id: 'tf', number: 'TF', taxFree: true }), inv({ id: 'old', number: 'OLD', invoiceDate: BEFORE }), inv({ id: 'dr', number: 'DR', status: 'DRAFT' }));
  db.add('invoiceItem', { id: 'a', invoiceId: 'tf', productId: 'p1', taxPct: 5, vatCategory: 'S' }, { id: 'b', invoiceId: 'old', productId: 'p1', taxPct: 5 },
    { id: 'c', invoiceId: 'dr', productId: 'p1', taxPct: 7 }, { id: 'z', invoiceId: 'i1', productId: 'p2', taxPct: 0, vatCategory: 'Z' },
    { id: 'e', invoiceId: 'i1', productId: 'p2', taxPct: 0, vatCategory: 'E' }, { id: 'o', invoiceId: 'i1', productId: 'p2', taxPct: 0, vatCategory: 'O' });
  const p = check(await run(db), 'P7');
  assert.equal(p.ok, true, p.details);
  assert.match(p.details, /\(15٪\)/);
});

test('P7 (W للقالب العام): مصر 14٪ ناجحة و5٪ تحذير؛ ودولة بلا ضريبة مخرجات ⇒ المعلّق 911001', async () => {
  const db = world();
  db.tables.companySettings[0].countryCode = 'EG';
  db.tables.companySettings[0].currency = 'EGP';
  db.tables.invoiceItem.forEach((i) => { i.taxPct = 14; });
  const base = { templateKey: 'GENERIC_6D' as const, currency: 'EGP' };
  db.tables.invoice.forEach((i) => { i.currency = i.tenantId === T ? 'EGP' : i.currency; });
  assert.equal(check(await run(db, base), 'P7').ok, true);
  db.add('invoice', inv({ id: 'e5', number: 'E5', currency: 'EGP' }));
  db.add('invoiceItem', { id: 'e5i', invoiceId: 'e5', productId: 'p1', taxPct: 5, vatCategory: 'S' });
  const r = await run(db, base);
  const p = check(r, 'P7');
  assert.equal(p.ok, false);
  assert.equal(p.level, 'W');
  assert.equal(r.blocking, 0);
  assert.match(p.items![0].label, /AUTO_SALE_5/);
  // الكويت 0٪: لا ضريبة مخرجات نشطة ⇒ الضريبة إلى المعلّق
  db.tables.companySettings[0].countryCode = 'KW';
  db.tables.companySettings[0].currency = 'KWD';
  db.tables.invoice.forEach((i) => { i.currency = i.tenantId === T ? 'KWD' : i.currency; });
  const kw = check(await run(db, { templateKey: 'GENERIC_6D', currency: 'KWD', currencyDecimals: 3 }), 'P7');
  assert.equal(kw.ok, false);
  assert.match(kw.items![0].label, /911001/);
  // القالب العام لدولة الصف يغلب دولة الشركة
  const viaRow = check(await run(db, { templateKey: 'GENERIC_6D', currency: 'KWD', currencyDecimals: 3, settingsRow: settingsRow({ templateKey: 'GENERIC_6D', countryCode: 'EG', zeroRatedSalesTaxKey: 'Z_SALE' }) }), 'P7');
  assert.deepEqual(viaRow.items!.map((i) => i.id), ['5|']);
});

test('P7 FULL: نسبة AUTO_SALE احتاجها الظلّ تُضاف لما في البنود — ولا تُكرَّر', async () => {
  const db = world();
  const r = await runFull(db, { eventStats: events({ autoSalePercents: [7] }) });
  const p = check(r, 'P7');
  assert.equal(p.ok, false);
  assert.equal(p.mode, 'FULL');
  assert.deepEqual(p.items!.map((i) => i.id), ['7|']);
  assert.match(p.items![0].label, /AUTO_SALE_7/);
  db.add('invoice', inv({ id: 'i7', number: 'I7' }));
  db.add('invoiceItem', { id: 'i7a', invoiceId: 'i7', productId: 'p1', taxPct: 7, vatCategory: 'S' });
  const both = check(await runFull(db, { eventStats: events({ autoSalePercents: [7] }) }), 'P7');
  assert.deepEqual(both.items!.map((i) => [i.id, i.qty]), [['7|', 1]]);
  // LIGHT لا يقرأ eventStats ولو مُرِّر
  assert.equal(check(await run(world(), { eventStats: events({ autoSalePercents: [7] }) }), 'P7').ok, true);
});

// ═══ P8 ═══

test('P8 (B): طريقة مستعملة منذ تاريخ الربط بلا مسار ⇒ يحجب؛ ما قبله وONLINE لا يُشترط له مسار', async () => {
  const db = world();
  db.add('receipt', { id: 'pos', tenantId: T, paymentMethod: 'POS', paymentMethodKey: null, receiptDate: IN_FY },
    { id: 'chq0', tenantId: T, paymentMethod: 'CHEQUE', paymentMethodKey: null, receiptDate: BEFORE },
    { id: 'onl', tenantId: T, paymentMethod: 'ONLINE', paymentMethodKey: null, receiptDate: IN_FY });
  const routing = { CASH: 'CUSTODY' as const, BANK_TRANSFER: 'DIRECT' as const };
  const p = check(await run(db, { receiptRouting: routing }), 'P8');
  assert.equal(p.ok, false);
  assert.equal(p.level, 'B');
  assert.deepEqual(p.items!.map((i) => [i.id, i.qty]), [['POS', 1]]);
  assert.equal(check(await run(db), 'P8').ok, true);
});

test('P8: توجيه الفواتير النقدية غير مختار صراحةً في المسودة ⇒ يحجب (قيمة الصف الافتراضية لا تكفي)', async () => {
  const r = await run(world(), { draft: { step1: { fiscalYearEndMonth: 12, fiscalYearEndDay: 31 } }, settingsRow: settingsRow() });
  const p = check(r, 'P8');
  assert.equal(p.ok, false);
  assert.deepEqual(p.items!.map((i) => i.id), ['cashInvoiceRouting']);
  const custody = check(await run(world(), { draft: { step1: { fiscalYearEndMonth: 12, fiscalYearEndDay: 31 }, step3: { cashInvoiceRouting: 'CUSTODY' } } }), 'P8');
  assert.equal(custody.ok, true);
  assert.match(custody.details, /عهدة المندوب/);
});

test('P8: الطريقة المخصّصة تُعدَّد «كطريقتها الأساسية حتى L5» ولا تحجب؛ وطريقة غير معروفة تحجب', async () => {
  const db = world();
  db.tables.companySettings[0].paymentMethodsConfig = {
    version: 1, builtins: {}, custom: [{ key: 'c_stcpay01', label: 'STC Pay', base: 'BANK_TRANSFER', icon: 'smartphone', active: true }],
  };
  db.add('receipt', { id: 'stc1', tenantId: T, paymentMethod: 'BANK_TRANSFER', paymentMethodKey: 'c_stcpay01', receiptDate: IN_FY },
    { id: 'stc2', tenantId: T, paymentMethod: 'BANK_TRANSFER', paymentMethodKey: 'c_stcpay01', receiptDate: IN_FY });
  const ok = check(await run(db), 'P8');
  assert.equal(ok.ok, true);
  assert.equal(ok.items!.length, 1);
  assert.match(ok.items![0].label, /«STC Pay» تُعامَل كطريقتها الأساسية \(تحويل بنكي\) حتى L5 — 2 سنداً/);
  assert.match(ok.details, /STC Pay/);
  db.add('receipt', { id: 'w', tenantId: T, paymentMethod: 'WALLET', paymentMethodKey: null, receiptDate: IN_FY });
  const bad = check(await run(db), 'P8');
  assert.equal(bad.ok, false);
  assert.match(bad.details, /غير معروفة: WALLET/);
});

// ═══ P9 ═══

test('P9 (B) LIGHT: وارد بلا سعر (أو بسعر صفر) قبل بداية السنة ⇒ تقدير يحجب بأسماء الأصناف؛ السالب القديم لا يُعدّ', async () => {
  const db = world();
  db.add('warehouseEntry', { id: 'u0', tenantId: T, type: 'RECEIVE', createdAt: BEFORE, vendorId: null, paymentMode: null, source: 'MANUAL' });
  db.add('warehouseEntryItem', { id: 'u0a', entryId: 'u0', productId: 'p2', qty: 4, unitCost: null }, { id: 'u0b', entryId: 'u0', productId: 'p2', qty: 1, unitCost: 0 },
    { id: 'u0c', entryId: 'u0', productId: 'p1', qty: -3, unitCost: null });
  const r = await run(db);
  const p = check(r, 'P9');
  assert.equal(p.ok, false);
  assert.equal(p.level, 'B');
  assert.equal(p.mode, 'LIGHT');
  assert.equal(p.count, 2);
  assert.deepEqual(p.items, [{ id: 'p2', label: 'عصير برتقال — أسطر وارد بلا سعر', qty: 2 }]);
  assert.match(p.details, /^تقدير/);
});

test('P9: الجرد الدوري (بلا مخزون الشركة) ⇒ لا ينطبق ولو وُجد وارد بلا سعر', async () => {
  const db = world();
  db.tables.tenant[0].warehouseEnabled = false;
  db.tables.warehouseEntryItem.find((i) => i.id === 'wi0')!.unitCost = null;
  const p = check(await run(db), 'P9');
  assert.equal(p.ok, true);
  assert.equal(p.notApplicable, true);
  assert.equal(db.queryCounts()['warehouseEntryItem.groupBy'], undefined, 'لا تقدير بلا حاجة');
});

test('وضع المخزون من المدخلات (التكامل): يغلب Tenant.warehouseEnabled بلا قراءته، وغيابه يقرؤه كما كان', async () => {
  const db = world();
  db.tables.warehouseEntryItem.find((i) => i.id === 'wi0')!.unitCost = null;
  // المعاينة بُنيت PERIODIC (المفتاح بُدّل بعدها): الفحص يتبع خياراتها لا قراءةً ثانية
  const p = check(await run(db, { inventoryMode: 'PERIODIC' }), 'P9');
  assert.equal(p.notApplicable, true);
  const withMode = db.queryCounts()['tenant.findUnique'] ?? 0;
  const q = check(await run(db), 'P9');
  assert.equal(q.ok, false, 'بلا المدخل ⇒ warehouseEnabled = true ⇒ PERPETUAL');
  // قراءة الشركة الوحيدة الزائدة بلا المدخل هي قراءة الوضع (P6 يقرأ الشركة في الحالتين)
  assert.equal((db.queryCounts()['tenant.findUnique'] ?? 0) - withMode, withMode + 1);
});

test('P13 FULL بالتخزين المقيس من الظلّ (التكامل): الصفوف والبايتات منه لا من تقدير 9 صفوف/حدث، والوقت كما هو', async () => {
  const c = check(await runFull(world(), { eventStats: events({ storage: { rows: 7_777, bytesEstimate: 3 * 1_048_576 } }) }), 'P13');
  assert.match(c.details, /≈ 500 حدثاً للترحيل التاريخي و120 لقطة تكلفة ⇒ ≈ 7777 صفاً \(≈ 3\.0 م\.ب\)، ووقت الترحيل ≈ 1 دقيقة خارج الذروة \(4 دقيقة/);
});

test('P9 FULL: من محرّك التكلفة (الرصيد الفعلي) لا من التقدير — بأسماء الأصناف والسيارات، والسالب يُذكر', async () => {
  const db = world();
  db.tables.warehouseEntryItem.find((i) => i.id === 'wi0')!.unitCost = null; // كان سيُفشل LIGHT
  const okFull = check(await runFull(db), 'P9');
  assert.equal(okFull.ok, true);
  assert.equal(okFull.mode, 'FULL');
  assert.equal(db.queryCounts()['warehouseEntryItem.groupBy'], undefined, 'FULL لا يقرأ التقدير');
  const c = costing({
    uncostedAtCutover: [{ productId: 'p1', location: 'VAN:r1', uncostedQty: 4 }, { productId: 'p2', location: 'WH', uncostedQty: 1.5 }, { productId: 'p9', location: 'VAN:_', uncostedQty: 1 }],
    uncostedAtCutoverTotalQty: 6.5,
    negativeAtCutover: [{ productId: 'p1', location: 'WH', qtyBase: -2 }],
  });
  const p = check(await runFull(world(), { costing: c }), 'P9');
  assert.equal(p.ok, false);
  assert.equal(p.count, 3);
  assert.deepEqual(p.items!.map((i) => [i.label, i.qty]), [['ماء 330 — سيارة أحمد', 4], ['عصير برتقال — المستودع', 1.5], ['p9 — سيارة غير معروفة', 1]]);
  assert.match(p.details, /3 رصيداً بلا تكلفة في بداية السنة \(3 صنفاً، كمية 6\.5\)/);
  assert.match(p.details, /1 رصيداً سالب الكمية/);
});

// ═══ P10 ═══

test('P10 (W): وارد السنة غير مصنَّف ⇒ GRNI بقيمة Σ toMilli(qty × unitCost) لكل سطر وحده، وسطر بلا سعر ⇒ تغطية أقل من 100٪', async () => {
  const db = world();
  db.add('warehouseEntry', { id: 'g1', tenantId: T, type: 'RECEIVE', createdAt: at('2026-02-01T10:00:00Z'), vendorId: 'v1', paymentMode: null, supplier: 'المخبز', source: 'MANUAL' },
    { id: 'g2', tenantId: T, type: 'RECEIVE', createdAt: at('2026-02-02T10:00:00Z'), vendorId: null, paymentMode: 'CASH', supplier: null, source: 'MANUAL' });
  db.add('warehouseEntryItem',
    // 3 × 0.3333 = 0.9999 ⇒ 1.00 (1,000 ملّي)؛ 7 × 1.005 = 7.035 ⇒ 7.04 (7,040)؛ وسطر بلا سعر
    { id: 'g1a', entryId: 'g1', productId: 'p1', qty: 3, unitCost: 0.3333 }, { id: 'g1b', entryId: 'g1', productId: 'p2', qty: 7, unitCost: 1.005 },
    { id: 'g1c', entryId: 'g1', productId: 'p2', qty: 2, unitCost: null },
    { id: 'g2a', entryId: 'g2', productId: 'p1', qty: 1, unitCost: 10 });
  const p = check(await run(db), 'P10');
  assert.equal(p.ok, false);
  assert.equal(p.level, 'W');
  assert.equal(p.valueMilli, 1_000n + 7_040n + 10_000n);
  assert.match(p.details, /5 سطراً، المسعَّر منها 4 \(80٪\)/);
  assert.match(p.details, /2 حركة وارد بلا مورّد \(1\) أو بلا نمط دفع \(1\) بقيمة 18\.04 SAR/);
  assert.deepEqual(p.items!.map((i) => [i.id, i.valueMilli, i.date]), [['g1', 8_040n, '2026-02-01'], ['g2', 10_000n, '2026-02-02']]);
  assert.match(p.items![0].label, /«المخبز»: 1 سطراً بلا سعر، بلا نمط دفع/);
  assert.equal(p.count, 1 + 2);
});

test('P10: وارد ما قبل السنة غير المصنَّف لا يُفحص، والمصنَّف المسعَّر ناجح؛ وFULL يضيف حُفر السالب', async () => {
  const light = check(await run(world()), 'P10');
  assert.equal(light.ok, true);
  assert.equal(light.mode, 'LIGHT');
  assert.match(light.details, /1 سطراً، المسعَّر منها 1 \(100٪\)؛ وحُفر الرصيد السالب تظهر في المعاينة الكاملة/);
  const holes = costing({ holesFy: { count: 2, varianceMilli: 6_000n, sample: [{ key: 'COST:VAN_LOAD:x', productId: 'p1', location: 'VAN:r1', varianceMilli: 6_000n }] } });
  const p = check(await runFull(world(), { costing: holes }), 'P10');
  assert.equal(p.ok, false);
  assert.equal(p.mode, 'FULL');
  assert.match(p.details, /2 رصيداً سالباً سُدّ خلال السنة بفرق 6\.00 SAR/);
  assert.deepEqual(p.items!.map((i) => [i.id, i.label, i.valueMilli]), [['COST:VAN_LOAD:x', 'حفرة سالب: ماء 330 — سيارة أحمد', 6_000n]]);
  assert.equal(p.itemsTruncated, 1);
});

test('P10: المسح المقسَّم بالمؤشّر (createdAt, id) يعدّ كل صفّ مرة واحدة عبر الصفحات — ومنها صفوف بلحظة واحدة', async () => {
  const db = world();
  const n = PREFLIGHT_PAGE_SIZE * 2 + 500;
  const same = at('2026-05-05T05:05:05Z');
  for (let k = 0; k < n; k++) {
    const id = `m${String(k).padStart(5, '0')}`;
    // ثلث الصفوف بلحظة واحدة: الترتيب الثانوي بالمعرّف وحده يفصلها
    const createdAt = k % 3 === 0 ? same : new Date(IN_FY.getTime() + k * 1000);
    db.add('warehouseEntry', { id, tenantId: T, type: 'RECEIVE', createdAt, vendorId: 'v', paymentMode: 'CREDIT', source: 'MANUAL' });
    db.add('warehouseEntryItem', { id: `${id}i`, entryId: id, productId: 'p1', qty: 1, unitCost: k === n - 1 ? null : 1 });
  }
  const seen = capturingWheres(db, 'warehouseEntry');
  const p = check(await runPreflight(seen.client, T, input()), 'P10');
  assert.equal(p.ok, false);
  assert.match(p.details, new RegExp(`${n + 1} سطراً، المسعَّر منها ${n} `));
  assert.equal(p.count, 1);
  assert.equal(db.queryCounts()['warehouseEntry.findMany'], 3);
  // الحدّ الأدنى لنطاق الفهرس في كل صفحة = المؤشّر (لا بداية السنة): بلا gte صريح تعود كل صفحة لمسح السنة من أولها
  const paged = seen.wheres.filter((w) => w.type === 'RECEIVE');
  assert.equal(paged.length, 3);
  assert.equal(paged[0].OR, undefined);
  for (const w of paged.slice(1)) {
    const cur = (w.OR as Array<{ createdAt?: { gt?: Date } }>)[0].createdAt!.gt!;
    assert.equal((w.createdAt as { gte: Date }).gte.getTime(), cur.getTime());
  }
});

/** يلفّ عميل الفايك ليلتقط where كل findMany على مندوبٍ واحد (القراءة نفسها تمرّ كما هي) */
function capturingWheres(db: FakeDb, delegate: string): { client: never; wheres: Record<string, unknown>[] } {
  const wheres: Record<string, unknown>[] = [];
  const base = db.client() as unknown as Record<string, Record<string, (a: unknown) => unknown>>;
  const client = new Proxy(base, {
    get(t, prop: string) {
      const v = t[prop];
      if (prop !== delegate) return v;
      return new Proxy(v, {
        get(d, m: string) {
          if (m !== 'findMany') return d[m];
          return (a: { where?: Record<string, unknown> }) => { wheres.push(a.where ?? {}); return d.findMany(a); };
        },
      });
    },
  });
  return { client: client as never, wheres };
}

// ═══ P11 ═══

test('P11 (W): مندوب محذوف له حركات في السنة (تحميل/سند/استلام) ⇒ تحذير لكلٍّ بعدّه', async () => {
  const db = world();
  db.add('vanLoad', { id: 'g1', tenantId: T, salesRepId: null, deletedSalesRepId: 'gone1', createdAt: IN_FY }, { id: 'g0', tenantId: T, salesRepId: null, deletedSalesRepId: 'gone0', createdAt: BEFORE });
  db.add('receipt', { id: 'gr', tenantId: T, paymentMethod: 'CASH', paymentMethodKey: null, receiptDate: IN_FY, deletedSalesRepId: 'gone1' },
    { id: 'gr2', tenantId: T, paymentMethod: 'CASH', paymentMethodKey: null, receiptDate: IN_FY, deletedSalesRepId: 'gone1' });
  db.add('repSettlement', { id: 'gs', tenantId: T, salesRepId: null, deletedSalesRepId: 'gone2', settledAt: IN_FY, createdAt: IN_FY });
  const r = await run(db);
  const p = check(r, 'P11');
  assert.equal(p.ok, false);
  assert.equal(p.level, 'W');
  assert.equal(p.count, 2);
  assert.deepEqual(p.items!.map((i) => [i.id, i.label]), [
    ['gone1', 'مندوب محذوف gone1: 1 حركة سيارة، 2 سنداً، 0 استلاماً'],
    ['gone2', 'مندوب محذوف gone2: 0 حركة سيارة، 0 سنداً، 1 استلاماً'],
  ]);
  assert.equal(r.blocking, 0);
});

test('P11: فاتورة بأصناف بلا مندوب في السنة ⇒ تحذير؛ الإشعار المدين والبنود بلا صنف وما قبل السنة والمسودّة لا تُعدّ', async () => {
  const db = world();
  db.add('invoice',
    inv({ id: 'a1', number: 'ADM-1', salesRepId: null, type: 'CASH', total: 57.5 }),
    inv({ id: 'a2', number: 'ADM-RET', salesRepId: null, type: 'RETURN', total: 10, invoiceDate: at('2026-04-01T09:00:00Z'), documentKind: 'CREDIT_NOTE' }),
    inv({ id: 'dn', number: 'DN', salesRepId: null, documentKind: 'DEBIT_NOTE' }),
    inv({ id: 'np', number: 'NP', salesRepId: null }),
    inv({ id: 'ob', number: 'OB', salesRepId: null, invoiceDate: BEFORE }),
    inv({ id: 'dr', number: 'DR', salesRepId: null, status: 'DRAFT' }));
  db.add('invoiceItem', { id: 'a1i', invoiceId: 'a1', productId: 'p1', taxPct: 15 }, { id: 'a2i', invoiceId: 'a2', productId: 'p1', taxPct: 15 },
    { id: 'dni', invoiceId: 'dn', productId: 'p1', taxPct: 15 }, { id: 'npi', invoiceId: 'np', productId: null, taxPct: 15 },
    { id: 'obi', invoiceId: 'ob', productId: 'p1', taxPct: 15 }, { id: 'dri', invoiceId: 'dr', productId: 'p1', taxPct: 15 });
  const p = check(await run(db), 'P11');
  assert.equal(p.ok, false);
  assert.equal(p.count, 2);
  assert.deepEqual(p.items!.map((i) => [i.id, i.valueMilli, i.date]), [['a1', 57_500n, '2026-03-10'], ['a2', 10_000n, '2026-04-01']]);
  assert.deepEqual(p.items!.map((i) => i.label), ['فاتورة نقدية ADM-1 بلا مندوب', 'فاتورة مرتجع ADM-RET بلا مندوب']);
  assert.match(p.details, /2 فاتورة بأصناف بلا مندوب/);
});

test('P11: قيد عميل مؤرّخ بعد الغد ⇒ تحذير؛ بعد 23 ساعة لا', async () => {
  const db = world();
  db.add('accountEntry', { id: 'f1', tenantId: T, entryDate: new Date(NOW.getTime() + 23 * 3_600_000), createdAt: NOW, debit: 5, credit: 0, description: 'قريب' });
  assert.equal(check(await run(db), 'P11').ok, true);
  db.add('accountEntry', { id: 'f2', tenantId: T, entryDate: at('2027-11-20T09:00:00Z'), createdAt: NOW, debit: 0, credit: 12.345, description: 'سند بتاريخ خاطئ' });
  const p = check(await run(db), 'P11');
  assert.equal(p.ok, false);
  assert.equal(p.count, 1);
  assert.deepEqual(p.items!.map((i) => [i.id, i.valueMilli, i.date]), [['f2', -12_350n, '2027-11-20']]);
});

// ═══ P12 ═══

test('P12 (W): التقريب لكل حدّ وحده نصف-لأعلى؛ فرق وحدة واحدة مقبول وما فوقها تحذير', () => {
  // 1.005 و1.005 ⇒ 1.01 + 1.01 = 2.02 (التقريب الساذج Math.round(x×100) يعطي 2.00 فيخطئ بفرقين)
  assert.deepEqual(invoiceRoundingDiff({ subtotal: 1.005, discountAmt: 0, taxAmt: 1.005, total: 2.02 }, 2), { totalMilli: 2_020n, computedMilli: 2_020n, diffMilli: 0n });
  assert.equal(invoiceRoundingDiff({ subtotal: 100.005, discountAmt: 0.005, taxAmt: 15.0049, total: 115.02 }, 2).diffMilli, 20n);
});

test('P12: على الفايك — فرق هللتين يُلتقط، وهللة واحدة لا؛ مرتّبة بالأكبر فرقاً', async () => {
  const db = world();
  db.add('invoice',
    inv({ id: 'r2', number: 'R2', subtotal: 100.005, discountAmt: 0.005, taxAmt: 15.0049, total: 115.02 }),
    inv({ id: 'r1', number: 'R1', subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115.01 }),
    inv({ id: 'r5', number: 'R5', invoiceDate: at('2026-01-05T09:00:00Z'), subtotal: 10, discountAmt: 0, taxAmt: 1.5, total: 11.45 }),
    inv({ id: 'rb', number: 'RB', invoiceDate: BEFORE, total: 999 }),
    inv({ id: 'rd', number: 'RD', status: 'DRAFT', total: 999 }));
  const p = check(await run(db), 'P12');
  assert.equal(p.ok, false);
  assert.equal(p.level, 'W');
  assert.equal(p.count, 2);
  assert.equal(p.valueMilli, 50n + 20n);
  assert.deepEqual(p.items!.map((i) => [i.id, i.valueMilli]), [['r5', -50n], ['r2', 20n]]);
  assert.match(p.items![0].label, /الإجمالي 11\.45 والمحسوب 11\.50/);
});

test('P12: LIGHT يفحص آخر 5,000 فاتورة للفترة وحدها، وFULL كلها بمسح مقسَّم', async () => {
  const db = world();
  // الأقدم فيه الفرق، و5,000 أحدث منه سليمة
  db.add('invoice', inv({ id: 'oldest', number: 'OLD', invoiceDate: at('2026-01-02T09:00:00Z'), total: 116 }));
  for (let k = 0; k < PREFLIGHT_LIGHT_ROUNDING_SCAN; k++) db.add('invoice', inv({ id: `v${k}`, number: `V${k}`, invoiceDate: new Date(at('2026-02-01T00:00:00Z').getTime() + k * 60_000) }));
  const light = check(await run(db), 'P12');
  assert.equal(light.ok, true);
  assert.match(light.details, /آخر 5000 فاتورة منذ 2026-01-01/);
  const seen = capturingWheres(db, 'invoice');
  const full = check(await runPreflight(seen.client, T, FULL()), 'P12');
  assert.equal(full.ok, false);
  assert.deepEqual(full.items!.map((i) => i.id), ['oldest']);
  assert.match(full.details, /5002 فاتورة منذ 2026-01-01/);
  // صفحات FULL: الحدّ الأدنى invoiceDate ≥ المؤشّر في كل صفحة بعد الأولى
  const paged = seen.wheres.filter((w) => Array.isArray(w.OR) && (w.OR as Array<Record<string, unknown>>)[0].invoiceDate);
  assert.ok(paged.length >= 5, String(paged.length));
  for (const w of paged) {
    const cur = (w.OR as Array<{ invoiceDate: { gt: Date } }>)[0].invoiceDate.gt;
    assert.equal((w.invoiceDate as { gte: Date }).gte.getTime(), cur.getTime());
  }
});

test('evaluateP12: العيّنة تُقصّ إلى 50 وitemsTruncated من العدد الكلي', () => {
  const top = Array.from({ length: 50 }, (_v, i) => ({ id: `i${i}`, number: `N${i}`, invoiceDate: IN_FY, totalMilli: 0n, computedMilli: 0n, diffMilli: 100n }));
  const c = evaluateP12(input(), { rounding: { scanned: 900, limited: false, count: 120, absSumMilli: 12_000n, top } });
  assert.equal(c.items!.length, 50);
  assert.equal(c.itemsTruncated, 70);
});

// ═══ P13 ═══

test('P13 (W/B) FULL: الصفوف والبايتات والوقت بالثوابت (9 صفوف و350 بايتاً للحدث، 300 للّقطة، 40ms، 20 ث/د)', async () => {
  assert.deepEqual(estimateLinkVolume(500, 120), {
    events: 500, costSnapshots: 120, rows: 4_620, bytesEstimate: 1_611_000, msPerEvent: 40, etaMinutesOffPeak: 1, etaMinutesPeakOnly: 4,
  });
  const ok = check(await runFull(world()), 'P13');
  assert.equal(ok.ok, true);
  assert.equal(ok.level, 'W');
  assert.equal(ok.count, 500);
  assert.match(ok.details, /≈ 500 حدثاً للترحيل التاريخي و120 لقطة تكلفة ⇒ ≈ 4620 صفاً \(≈ 1\.5 م\.ب\)، ووقت الترحيل ≈ 1 دقيقة خارج الذروة \(4 دقيقة/);
  assert.deepEqual(ok.items!.map((i) => [i.id, i.qty]), [['INVOICE', 300], ['RECEIPT', 200]]);
});

test('P13: فوق سقف التحذير ⇒ W يُقرّ به، وفوق سقف المنصّة ⇒ B يحجب', async () => {
  const atWarn = check(await runFull(world(), { eventStats: events({ eventsToPost: P13_WARN_EVENTS }) }), 'P13');
  assert.equal(atWarn.ok, true);
  const warn = await runFull(world(), { eventStats: events({ eventsToPost: P13_WARN_EVENTS + 1 }) });
  assert.equal(check(warn, 'P13').ok, false);
  assert.equal(check(warn, 'P13').level, 'W');
  assert.equal(warn.blocking, 0);
  assert.equal(warn.warnings, 1);
  const atCap = check(await runFull(world(), { eventStats: events({ eventsToPost: PLATFORM_EVENT_CAP }) }), 'P13');
  assert.equal(atCap.level, 'W');
  const over = await runFull(world(), { eventStats: events({ eventsToPost: PLATFORM_EVENT_CAP + 1 }) });
  assert.equal(check(over, 'P13').ok, false);
  assert.equal(check(over, 'P13').level, 'B');
  assert.match(check(over, 'P13').details, /سقف المنصّة 300000/);
  assert.equal(over.blocking, 1);
  assert.equal(over.warnings, 0);
});

test('P13 LIGHT: يعدّ الصفوف المُطابَقة منذ المؤشّر الابتدائي (بداية اليوم السابق للربط) وصفوف مصادر التكلفة', async () => {
  const db = world();
  const watermark = zonedStartOfDay('2025-12-31', TZ); // 2025-12-30T21:00Z
  db.add('accountEntry', { id: 'w0', tenantId: T, entryDate: watermark, createdAt: watermark, debit: 1, credit: 0, description: 'على الحدّ' },
    { id: 'w-', tenantId: T, entryDate: CUT, createdAt: new Date(watermark.getTime() - 1), debit: 1, credit: 0, description: 'قبله بملّي ثانية' });
  db.add('repSettlement', { id: 's1', tenantId: T, salesRepId: 'r1', deletedSalesRepId: null, settledAt: IN_FY, createdAt: IN_FY },
    { id: 's2', tenantId: T, salesRepId: null, deletedSalesRepId: 'gone', settledAt: IN_FY, createdAt: IN_FY });
  db.add('settlementEntry', { id: 'se1', tenantId: T, kind: 'COLLECTED', amount: 10, createdAt: IN_FY }, { id: 'se0', tenantId: T, kind: 'FEE', amount: -1, createdAt: BEFORE });
  const p = check(await run(db), 'P13');
  assert.equal(p.mode, 'LIGHT');
  // ae1 + w0 = 2، استلام بمندوب قائم 1، أمانات 1 ⇒ 4 أحداث؛ مصادر التكلفة: 2 وارد + 1 تحميل + 2 بند فاتورة بصنف = 5
  assert.equal(p.count, 4);
  assert.deepEqual(p.items!.map((i) => [i.id, i.qty]), [['ACCOUNT_ENTRY', 2], ['REP_SETTLEMENT', 1], ['SETTLEMENT_ENTRY', 1], ['COST_SOURCE', 5]]);
  assert.match(p.details, /^تقدير: ≈ 4 حدثاً/);
  assert.equal(p.ok, true);
});

test('evaluateP13: FULL بلا محرّك التكلفة يأخذ اللقطات من صفوف المصادر ويبقى عدد الأحداث من الظلّ', () => {
  const c = evaluateP13(input({ mode: 'FULL', eventStats: events({ eventsToPost: 10 }), costing: null }), {
    volume: { watermarkAt: CUT, accountEntries: 0, repSettlements: 0, settlementEntries: 0, costSourceRows: 33 },
  });
  assert.equal(c.mode, 'FULL');
  assert.equal(c.count, 10);
  assert.match(c.details, /10 حدثاً للترحيل التاريخي و33 لقطة تكلفة/);
});

// ═══ P14 ═══

test('P14 (B): دفاتر يدوية مفعّلة ⇒ التحويل في L9 يحجب؛ غير المفعّلة والمربوطة ⇒ لا ينطبق', async () => {
  const conv = await run(world(), { settingsRow: settingsRow({ setupMethod: 'CLEAN', activatedAt: at('2026-10-01T00:00:00Z') }) });
  const p = check(conv, 'P14');
  assert.equal(p.ok, false);
  assert.equal(p.level, 'B');
  assert.equal(p.notApplicable, undefined);
  assert.match(p.details, /L9/);
  for (const row of [settingsRow({ setupMethod: 'CLEAN', activatedAt: null }), settingsRow({ setupMethod: 'LINKED', activatedAt: at('2026-10-01T00:00:00Z') }), null]) {
    const q = check(await run(world(), { settingsRow: row }), 'P14');
    assert.equal(q.ok, true);
    assert.equal(q.notApplicable, true);
  }
});

// ═══ الحرّاس: لا gl*، لا كتابة، بلا N+1، حتمية ═══

test('لا وصول gl* ولا كتابة: LIGHT وFULL على العميل الحارس — والحارس يرمي فعلاً عند gl*', async () => {
  const db = world();
  db.add('importBatch', { id: 'os', tenantId: T, kind: 'opening_stock', reverted: false, status: 'done', createdAt: BEFORE, recordIds: JSON.stringify(['we0']) });
  db.tables.tenant[0].erpEnabled = true;
  db.add('erpIntegration', { tenantId: T, enabled: true, provider: 'ODOO' });
  await run(db);
  await runFull(db, { costing: costing({ uncostedAtCutover: [{ productId: 'p1', location: 'WH', uncostedQty: 1 }], uncostedAtCutoverTotalQty: 1 }) });
  assert.deepEqual(db.glAccess, []);
  assert.equal(db.writes, 0);
  assert.equal(db.raws, 0);
  const c = db.client();
  assert.throws(() => c.glSettings, /SHADOW_GL_ACCESS/);
  assert.throws(() => c.glSourceEvent, /SHADOW_GL_ACCESS/);
  await assert.rejects(c.invoice.update({ where: { id: 'i1' }, data: {} }), /WRITE_FORBIDDEN/);
  assert.equal(db.writes, 1);
});

/** شركة كبيرة بالحجم نفسه في كل مصدر (دون صفحة المسح كي يُقارَن العدد حرفياً) */
function bigWorld(n: number): FakeDb {
  const db = world();
  for (let k = 0; k < n; k++) {
    const d = new Date(IN_FY.getTime() + k * 60_000);
    db.add('invoice', inv({ id: `bi${k}`, number: `B${k}`, invoiceDate: d, salesRepId: k % 2 ? 'r1' : null, total: k % 5 ? 115 : 115.5 }));
    db.add('invoiceItem', { id: `bii${k}`, invoiceId: `bi${k}`, productId: k % 2 ? 'p1' : 'p2', taxPct: k % 7 ? 15 : 5, vatCategory: 'S' });
    db.add('receipt', { id: `br${k}`, tenantId: T, paymentMethod: k % 2 ? 'CASH' : 'POS', paymentMethodKey: null, receiptDate: d, deletedSalesRepId: k % 9 ? null : `gone${k}` });
    db.add('warehouseEntry', { id: `bw${k}`, tenantId: T, type: 'RECEIVE', createdAt: d, vendorId: k % 3 ? 'v' : null, paymentMode: 'CREDIT', source: 'MANUAL' });
    db.add('warehouseEntryItem', { id: `bwi${k}`, entryId: `bw${k}`, productId: 'p1', qty: 2, unitCost: k % 4 ? 3 : null });
    db.add('warehouseEntry', { id: `bo${k}`, tenantId: T, type: 'RECEIVE', createdAt: BEFORE, vendorId: null, paymentMode: null, source: 'MANUAL' });
    db.add('warehouseEntryItem', { id: `boi${k}`, entryId: `bo${k}`, productId: k % 2 ? 'p1' : 'p2', qty: 1, unitCost: k % 2 ? null : 1 });
    db.add('vanLoad', { id: `bv${k}`, tenantId: T, salesRepId: null, deletedSalesRepId: `gone${k % 13}`, type: 'LOAD', createdAt: d });
    db.add('accountEntry', { id: `ba${k}`, tenantId: T, entryDate: k % 11 ? d : at('2028-01-01T00:00:00Z'), createdAt: d, debit: 1, credit: 0, description: `قيد ${k}` });
  }
  return db;
}

test('بلا N+1: عدد الاستعلامات لكل نوع ثابت مهما كبرت البيانات (LIGHT وFULL)', async () => {
  for (const mode of ['LIGHT', 'FULL'] as const) {
    const small = bigWorld(5);
    const big = bigWorld(400);
    const go = (db: FakeDb) => (mode === 'LIGHT' ? run(db) : runFull(db, { costing: costing({ holesFy: { count: 1, varianceMilli: 10n, sample: [{ key: 'k', productId: 'p1', location: 'VAN:r1', varianceMilli: 10n }] } }) }));
    const rs = await go(small);
    const rb = await go(big);
    assert.deepEqual(big.queryCounts(), small.queryCounts(), mode);
    const total = Object.values(big.queryCounts()).reduce((s, n) => s + n, 0);
    assert.ok(total <= 30, `${mode}: ${total} استعلاماً`);
    // والنتيجة تكبر فعلاً مع البيانات (لم يُختصر شيء)
    assert.ok((check(rb, 'P11').count ?? 0) > (check(rs, 'P11').count ?? 0));
    assert.ok((check(rb, 'P12').count ?? 0) > (check(rs, 'P12').count ?? 0));
  }
});

test('حتمية: تشغيلان متتاليان وترتيب إدراج معكوس ⇒ التقرير نفسه حرفياً', async () => {
  const a = await run(bigWorld(60));
  const b = await run(bigWorld(60));
  assert.deepEqual(a, b);
  const rev = bigWorld(60);
  for (const t of Object.values(rev.tables)) t.reverse();
  assert.deepEqual(await run(rev), a);
  const fa = await runFull(bigWorld(60));
  const rev2 = bigWorld(60);
  for (const t of Object.values(rev2.tables)) t.reverse();
  assert.deepEqual(await runFull(rev2), fa);
});

test('شركة كبيرة: الفحوص التحذيرية تلتقط ما فيها وP7 يحجب، والعزل بـtenantId (الشركة الأخرى لا تظهر)', async () => {
  const r = await run(bigWorld(30));
  assert.deepEqual(failing(r), ['P7', 'P9', 'P10', 'P11', 'P12']);
  assert.equal(r.blocking, 2);
  assert.equal(r.warnings, 3);
  const json = JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  for (const leak of ['ghost', 'xw1', 'x1', 'WALLET', 'USD']) assert.ok(!json.includes(leak), leak);
  // قيمة GRNI: حركات بلا مورّد (k % 3 = 0) المسعَّرة (k % 4 ≠ 0): 2 × 3 = 6.00 لكلٍّ
  let expected = 0n;
  for (let k = 0; k < 30; k++) if (k % 3 === 0 && k % 4 !== 0) expected += toMilli(2 * 3, 2);
  assert.equal(check(r, 'P10').valueMilli, expected);
});
