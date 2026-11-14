import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { setActiveNumerals } from '../../../utils/format';
import type {
  GlLinkPreviewSummary, GlLinkPreviewView, PreflightCheck, PreflightReport, PreviewResultJson,
} from '../../../api/ledgerLinking';

/**
 * رسم صفحة «ربط الدفاتر بالنظام (معاينة)» ومكوّناتها على الخادم (react-dom/server) بنتيجة معاينة كاملة من أمثلة العقد
 * (§5): كل أقسام §15 تظهر بأرقامها بالملّي منسّقة، والتعمّق مفتوح للفرق، و«غير متاح بعد» بمرحلته، ولا زرّ كتابة غير
 * «تشغيل المعاينة». الواجهة العربية بأرقام لاتينية (حالة المتجر الأولى في node).
 */

setActiveNumerals('latin');
const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const check = (code: PreflightCheck['code'], level: 'B' | 'W', ok: boolean, extra: Partial<PreflightCheck> = {}): PreflightCheck => ({
  code, level, ok, titleAr: `عنوان ${code}`, details: `تفاصيل ${code}`, mode: 'FULL', ...extra,
});

function preflight(mode: 'LIGHT' | 'FULL'): PreflightReport {
  const checks: PreflightCheck[] = [
    check('P1', 'B', true), check('P2', 'B', true), check('P3', 'B', true), check('P4', 'B', true), check('P5', 'B', true),
    check('P6', 'W', false, { count: 1 }), check('P7', 'B', true), check('P8', 'B', true),
    check('P9', 'B', false, { count: 2, items: [{ id: 'p1', label: 'صنف بلا تكلفة', qty: 4 }], itemsTruncated: 7 }),
    check('P10', 'W', false, { valueMilli: '120000' }), check('P11', 'W', true), check('P12', 'W', true), check('P13', 'W', true),
    check('P14', 'B', true, { notApplicable: true }),
  ].map(c => ({ ...c, mode }));
  return { mode, basis: 'FY_RESTATED', linkedFrom: '2026-01-01', checks, blocking: 1, warnings: 2 };
}

/** نتيجة معاينة كاملة — المخزون من المثالين أ وب (§5)، والذمّة وفرق 319002 كاختبار المنطق */
function result(): PreviewResultJson {
  return {
    version: 1, tenantId: 't1', basis: 'FY_RESTATED', linkedFrom: '2026-01-01', openingDate: '2025-12-31',
    snapshotAt: '2026-11-14T09:00:00.000Z', dbNow: '2026-11-14T09:00:00.000Z', currency: 'SAR', currencyDecimals: 2,
    timezone: 'Asia/Riyadh', templateKey: 'SA_6D', inventoryMode: 'PERPETUAL', dataHash: 'a'.repeat(64), resultHash: 'b'.repeat(64),
    opening: {
      date: '2025-12-31',
      lines: [
        { accountCode: '113001', accountName: 'ذمم العملاء', origin: 'DERIVED', partnerType: 'CUSTOMER', partnerId: 'cu1', partnerName: 'عميل أ', label: 'رصيد افتتاحي — عميل أ', debitMilli: '1150000', creditMilli: '0' },
        { accountCode: '114001', accountName: 'مخزون المستودع', origin: 'DERIVED', partnerType: 'LOCATION', partnerId: 'WH', partnerName: null, label: 'مخزون المستودع الافتتاحي', debitMilli: '3035000', creditMilli: '0' },
        { accountCode: '114002', accountName: 'بضاعة السيارات', origin: 'DERIVED', partnerType: 'REP', partnerId: 'R2', partnerName: 'مندوب ٢', label: 'بضاعة سيارة — مندوب ٢', debitMilli: '57000', creditMilli: '0' },
        { accountCode: '211001', accountName: 'الموردون', origin: 'MANUAL', partnerType: 'VENDOR', partnerId: null, partnerName: 'مورد', label: 'رصيد يدوي', debitMilli: '0', creditMilli: '400000' },
        { accountCode: '319002', accountName: 'أرصدة افتتاحية', origin: 'EQUITY', partnerType: null, partnerId: null, partnerName: null, label: 'فرق الأرصدة الافتتاحية', debitMilli: '0', creditMilli: '3842000' },
      ],
      linesTruncated: 0,
      byAccount: [
        { accountCode: '113001', accountName: 'ذمم العملاء', debitMilli: '1150000', creditMilli: '0', lines: 1 },
        { accountCode: '319002', accountName: 'أرصدة افتتاحية', debitMilli: '0', creditMilli: '3842000', lines: 1 },
      ],
      totals: { debitMilli: '4242000', creditMilli: '4242000', derivedNetMilli: '4242000', manualDebitMilli: '0', manualCreditMilli: '400000', equityDiffMilli: '3842000' },
      manualIssues: [{ index: 2, accountCode: '113001', reason: 'DERIVED_ACCOUNT' }],
    },
    eventCounts: [
      { sourceType: 'INVOICE', event: 'POST', status: 'DONE', reason: null, count: 4 },
      { sourceType: 'INVOICE', event: 'POST', status: 'SKIPPED', reason: 'OPENING', count: 2 },
      { sourceType: 'INVOICE', event: 'REVERSE', status: 'HELD', reason: 'UNEXPECTED_ENTRY_SHAPE', count: 1 },
    ],
    trialBalanceByMonth: {
      months: ['2026-01', '2026-02'],
      rows: [
        { accountId: 'a1', accountCode: '114001', accountName: 'مخزون المستودع', accountType: 'asset_current', openingMilli: '3035000', months: [{ month: '2026-01', debitMilli: '0', creditMilli: '630000' }], debitMilli: '0', creditMilli: '630000', closingMilli: '2405000' },
        { accountId: 'a2', accountCode: '114002', accountName: 'بضاعة السيارات', accountType: 'asset_current', openingMilli: '57000', months: [{ month: '2026-01', debitMilli: '630000', creditMilli: '210000' }], debitMilli: '630000', creditMilli: '210000', closingMilli: '477000' },
        { accountId: 'a3', accountCode: '511001', accountName: 'تكلفة المبيعات', accountType: 'expense_direct_cost', openingMilli: '0', months: [{ month: '2026-02', debitMilli: '210000', creditMilli: '0' }], debitMilli: '210000', creditMilli: '0', closingMilli: '210000' },
        { accountId: 'a4', accountCode: '999999', accountName: 'صفري', accountType: 'expense', openingMilli: '0', months: [], debitMilli: '0', creditMilli: '0', closingMilli: '0' },
      ],
      totals: { openingMilli: '3092000', debitMilli: '840000', creditMilli: '840000', closingMilli: '3092000' },
    },
    pnlYtd: {
      from: '2026-01-01', to: '2026-11-14', netMilli: '-5000',
      lines: [
        { key: 'grossRevenue', labelAr: 'x', amountMilli: '300000', depth: 0 },
        { key: 'grossRevenue:411001', labelAr: '411001 — المبيعات', amountMilli: '300000', depth: 1 },
        { key: 'costOfRevenue', labelAr: 'x', amountMilli: '210000', depth: 0 },
        { key: 'operatingExpenses.selling', labelAr: 'x', amountMilli: '95000', depth: 1 },
        { key: 'operatingIncome', labelAr: 'x', amountMilli: '-5000', depth: 0 },
        { key: 'netProfit', labelAr: 'x', amountMilli: '-5000', depth: 0 },
      ],
    },
    balanceSheet: {
      asOf: '2026-11-14', assetsMilli: '4092000', liabilitiesMilli: '400000', equityMilli: '3692000', balanced: true,
      lines: [{ key: 'assets', labelAr: 'x', amountMilli: '4092000', depth: 0 }, { key: 'currentAssets', labelAr: 'x', amountMilli: '4092000', depth: 1 }],
    },
    vatByPeriodBox: [
      { periodKey: '2026-Q1', from: '2026-01-01', to: '2026-03-31', box: 'SA_1', baseMilli: '300000', taxMilli: '45000' },
      { periodKey: '2026-Q1', from: '2026-01-01', to: '2026-03-31', box: null, baseMilli: '0', taxMilli: '150' },
    ],
    parity: [
      { code: 'R1', titleAr: 'x', status: 'OK', scope: 'FULL', expectedMilli: '-3842000', actualMilli: '-3842000', diffMilli: '0', drill: [], drillTruncated: 0 },
      {
        code: 'R2', titleAr: 'x', status: 'MISMATCH', scope: 'FULL', expectedMilli: '1150000', actualMilli: '1149990', diffMilli: '10', drillTruncated: 3,
        drill: [
          { partnerType: 'CUSTOMER', partnerId: 'cu2', name: 'عميل ب', expectedMilli: '5000', actualMilli: '5000', diffMilli: '0' },
          { partnerType: 'CUSTOMER', partnerId: 'cu1', name: 'عميل أ', expectedMilli: '1145000', actualMilli: '1144990', diffMilli: '10', note: 'ملاحظة الخادم', refs: ['INVOICE:inv1:POST'] },
        ],
      },
      { code: 'R3', titleAr: 'x', status: 'OK', scope: 'FULL', expectedMilli: '0', actualMilli: '0', diffMilli: '0', drill: [], drillTruncated: 0, info: { opsOutstandingMilli: '25000' } },
      { code: 'R4', titleAr: 'x', status: 'NOT_AVAILABLE', scope: 'NONE', availableIn: 'L5', reason: 'نص', expectedMilli: null, actualMilli: null, diffMilli: null, drill: [], drillTruncated: 0 },
      { code: 'R5', titleAr: 'x', status: 'OK', scope: 'FULL', expectedMilli: '0', actualMilli: '0', diffMilli: '0', drill: [], drillTruncated: 0 },
      { code: 'R6', titleAr: 'x', status: 'NOT_AVAILABLE', scope: 'NONE', availableIn: 'L4', expectedMilli: null, actualMilli: null, diffMilli: null, drill: [], drillTruncated: 0 },
      { code: 'R7', titleAr: 'x', status: 'NOT_AVAILABLE', scope: 'NONE', availableIn: 'L4', expectedMilli: null, actualMilli: null, diffMilli: null, drill: [], drillTruncated: 0 },
      {
        code: 'R8', titleAr: 'x', status: 'NOT_AVAILABLE', scope: 'OPENING_ONLY', availableIn: 'L6', expectedMilli: '2882000', actualMilli: null, diffMilli: null, drillTruncated: 0,
        info: { openingTie: 'OK' },
        drill: [{ partnerType: 'LOCATION', partnerId: 'WH', name: null, expectedMilli: '2940000', actualMilli: '0', diffMilli: '0' }],
      },
      { code: 'R9', titleAr: 'x', status: 'NOT_AVAILABLE', scope: 'NONE', availableIn: 'L4', expectedMilli: '210000', actualMilli: null, diffMilli: null, drill: [], drillTruncated: 0 },
      { code: 'R10', titleAr: 'x', status: 'NOT_AVAILABLE', scope: 'NONE', availableIn: 'L6', expectedMilli: '0', actualMilli: null, diffMilli: null, drill: [], drillTruncated: 0 },
      { code: 'R11', titleAr: 'x', status: 'NOT_AVAILABLE', scope: 'NONE', availableIn: 'L6', expectedMilli: '0', actualMilli: null, diffMilli: null, drill: [], drillTruncated: 0 },
      { code: 'R12', titleAr: 'x', status: 'NOT_AVAILABLE', scope: 'NONE', availableIn: 'L6', expectedMilli: null, actualMilli: null, diffMilli: null, drill: [], drillTruncated: 0 },
      { code: 'R13', titleAr: 'x', status: 'NOT_AVAILABLE', scope: 'NONE', availableIn: 'L7', expectedMilli: null, actualMilli: null, diffMilli: null, drill: [], drillTruncated: 0 },
    ],
    preflight: preflight('FULL'),
    heldLines: [
      { kind: 'EVENT', sourceKey: 'INVOICE:inv1:REVERSE', sourceType: 'INVOICE', status: 'HELD', reason: 'UNEXPECTED_ENTRY_SHAPE', detail: 'تفصيل الخادم', effectDate: '2026-03-01', amountMilli: '115000', partnerType: 'CUSTOMER', partnerId: 'cu1', partnerName: 'عميل أ' },
    ],
    heldTruncated: 0,
    costing: {
      summary: {
        moveCount: 14, productCount: 2,
        openingByLocation: [{ location: 'VAN:R2', qtyBase: 6, uncostedQty: 0, valueMilli: '57000' }, { location: 'WH', qtyBase: 150, uncostedQty: 0, valueMilli: '3035000' }],
        nowByLocation: [{ location: 'WH', qtyBase: 140, uncostedQty: 0, valueMilli: '2940000' }, { location: 'VAN:R2', qtyBase: 6, uncostedQty: 0, valueMilli: '57000' }],
        fyCogsMilli: '210000', fyVarianceMilli: '6000', fyWriteOffMilli: '63000',
        uncostedAtCutover: [], uncostedAtCutoverTotalQty: 0, negativeAtCutover: [],
        holesFy: { count: 1, varianceMilli: '6000', sample: [{ key: 'COST:VAN_LOAD:i4', productId: 'B', location: 'VAN:R2', varianceMilli: '6000' }] },
        warnings: [],
      },
      sourceRows: { WH_ENTRY: 3, VAN_LOAD: 2, INVOICE: 8, RESTOCK_LOG: 1 },
    },
    eta: { eventsToPost: 29000, msPerEvent: 40, offPeakBudgetMsPerMin: 20000, peakBudgetMsPerMin: 5000, etaMinutesOffPeak: 58, etaMinutesPeakOnly: 232 },
    storage: { rows: { events: 29000, moves: 29000, lines: 120000, moveSources: 29000, audits: 1, costSnapshots: 14, total: 207015 }, bytesEstimate: 72_455_250, headroomNote: null },
    warnings: [{ code: 'RESULT_TRUNCATED', message: 'رسالة', count: 1 }],
    timings: [{ phase: 'READ', ms: 1200 }, { phase: 'POST', ms: 8300 }],
  };
}

const view = (o: Partial<GlLinkPreviewView> = {}): GlLinkPreviewView => ({
  id: 'pv1', status: 'DONE', phase: 'DONE', progressPct: 100, basis: 'FY_RESTATED', linkedFrom: '2026-01-01', snapshotAt: '2026-11-14T09:00:00.000Z',
  dataHash: 'a'.repeat(64), resultHash: 'b'.repeat(64), resultBytes: 210_000, errorCode: null, error: null, createdAt: '2026-11-14T08:59:00.000Z',
  startedAt: '2026-11-14T08:59:01.000Z', finishedAt: '2026-11-14T09:00:10.000Z', heartbeatAt: null, result: result(), ...o,
});
const summaryOf = (v: GlLinkPreviewView): GlLinkPreviewSummary => { const { result: _r, ...s } = v; return s; };

/** بيئة متصفّح دنيا لما يستورد مخزن الجلسة وعميل الـAPI (مثل pages/taxOffScreens1.test.ts) — مالك الشركة في الجلسة */
let envReady = false;
function browserEnv(): void {
  if (envReady) return;
  envReady = true;
  const g = globalThis as { localStorage?: Storage };
  if (!g.localStorage) {
    const m = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    } as Storage;
  }
  g.localStorage!.setItem('user', JSON.stringify({ id: 'u1', name: 'المالك', role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: false }));
  const hook = `export async function load(url, ctx, next) {
    const r = await next(url, ctx);
    if (url.includes('/web-admin/src/') && r.source != null) {
      let src = String(r.source);
      if (src.includes('import.meta.env')) src = src.replace(/import\\.meta\\.env/g, '({})');
      if (url.endsWith('/src/store/authStore.ts')) src = src.replace(/window\\.location\\.pathname/g, '"/app"');
      return { ...r, source: src };
    }
    return r;
  }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
}

/**
 * المكوّنات تستورد شارات الدفاتر ⇒ عميل الـAPI ⇒ مخزن الجلسة الذي يقرأ localStorage عند الاستيراد: تُستورد ديناميكياً
 * بعد تهيئة البيئة (الاستيراد الساكن يُرفع قبلها)
 */
async function ui() {
  browserEnv();
  const [pf, om, pa, rs, hs, ss, pc] = await Promise.all([
    import('./PreflightTable'), import('./OpeningMoveSection'), import('./ParitySection'), import('./ReportsSections'),
    import('./HeldAndStorage'), import('./SummarySection'), import('./PreviewControls'),
  ]);
  return { ...pf, ...om, ...pa, ...rs, ...hs, ...ss, ...pc };
}

test('الفحوص المسبقة: الأربعة عشر بمستوياتها، وFULL/LIGHT، والعدّ، والعناصر بقصّها', async () => {
  const { PreflightTable } = await ui();
  const full = text(html(h(PreflightTable, { report: preflight('FULL'), source: 'FULL', decimals: 2 })));
  for (let i = 1; i <= 14; i++) assert.ok(full.includes(`P${i} `), `P${i}`);
  assert.ok(full.includes('من المعاينة الكاملة'));
  assert.ok(full.includes('تحجب الاعتماد: 1') && full.includes('تحذيرات: 2') && full.includes('سليمة: 10'), full);
  assert.ok(full.includes('لا ينطبق'), 'P14 لغير التحويل');
  assert.ok(full.includes('120.00'), 'قيمة P10 بالملّي منسّقة');
  assert.ok(full.includes('نسب ضريبة البيع ومربعات الإقرار'), 'العنوان المترجم لا titleAr');
  assert.ok(!full.includes('عنوان P7'));
  const light = text(html(h(PreflightTable, { report: preflight('LIGHT'), source: 'LIGHT', decimals: 2 })));
  assert.ok(light.includes('تقدير سريع'));
  assert.ok(text(html(h(PreflightTable, { report: null, source: null, decimals: 2, loading: true }))).includes('جاري الفحص...'));
});

test('القيد الافتتاحي: متوازن، وسطوره بمصدرها وشريكها، و319002 دائناً، وسبب DERIVED_ACCOUNT', async () => {
  const { OpeningMoveSection } = await ui();
  const s = text(html(h(OpeningMoveSection, { opening: result().opening, decimals: 2 })));
  assert.ok(s.includes('متوازن') && !s.includes('غير متوازن'));
  assert.ok(s.includes('4,242.00'), 'Σ المدين');
  assert.ok(s.includes('3,035.00') && s.includes('57.00') && s.includes('1,150.00'), 'سطور المخزون والذمم');
  assert.ok(s.includes('3,842.00 دائن'), 'فرق 319002 دائن');
  assert.ok(s.includes('319002') && s.includes('مشتق من التشغيل') && s.includes('يدوي'));
  assert.ok(s.includes('هذا الحساب يُشتق من التشغيل'));
  const off = result().opening;
  off.totals.creditMilli = '4241990';
  const bad = text(html(h(OpeningMoveSection, { opening: off, decimals: 2 })));
  assert.ok(bad.includes('غير متوازن') && bad.includes('مجموع المدين لا يساوي مجموع الدائن') && bad.includes('0.01'));
});

test('المطابقة: R1..R13، والفرق مفتوح بتعمّقه الأكبر أولاً، و«غير متاح بعد» بمرحلته والمتوقَّع محسوباً', async () => {
  const { ParitySection } = await ui();
  const s = text(html(h(ParitySection, { checks: result().parity, decimals: 2 })));
  for (let i = 1; i <= 13; i++) assert.ok(s.includes(`R${i} `), `R${i}`);
  assert.ok(s.includes('مطابق: 3') && s.includes('فرق: 1') && s.includes('غير متاح بعد: 9'), s.slice(0, 400));
  // R2 مفتوح: «الفروق وحدها» افتراضياً ⇒ عميل أ (فرق 0.01) ظاهر وعميل ب (صفر) مخفي
  assert.ok(s.includes('عميل أ') && s.includes('0.01') && !s.includes('عميل ب'));
  assert.ok(s.includes('INVOICE:inv1:POST'));
  assert.ok(s.includes('ملاحظة الخادم'), 'الملاحظة للعربية');
  assert.ok(s.includes('و 3 صفاً آخر لم يُعرض'));
  assert.ok(s.includes('قيود حركات المخزون تُضاف في L6') && s.includes('2,882.00'), 'R8 بمتوقَّعه');
  assert.ok(s.includes('قيد تكلفة المبيعات يُضاف مع قيود المخزون في L6') && s.includes('210.00'), 'R9 بمتوقَّعه');
  assert.ok(s.includes('عهدة المستخدمين 111004 تُضاف في L5'));
});

test('المطابقة لشركة بجرد دوري: R8 «لا ينطبق» بسببه لا «تُضاف في L6»، وتعمّقه للاطلاع بلا عمود فرق ولا «الفروق وحدها»', async () => {
  const { ParitySection } = await ui();
  // كما يرسله الخادم (parity.ts checkR8 حين inventoryMode = PERIODIC): المتوقَّع من محرّك التكلفة والأستاذ صفر
  const r8 = {
    code: 'R8' as const, titleAr: 'x', status: 'NOT_AVAILABLE' as const, scope: 'NONE' as const, availableIn: null, reasonCode: 'INVENTORY_PERIODIC' as const,
    reason: 'المخزون الدوري (PERIODIC): لا تحمل الدفاتر رصيد مخزون مستمرّاً — لا مطابقة 114001/114002',
    expectedMilli: '2997000', actualMilli: '0', diffMilli: null, drillTruncated: 0, info: { locations: 2, openingTie: null, accountMissing: null },
    drill: [
      { partnerType: 'LOCATION' as const, partnerId: 'WH', name: 'المستودع', expectedMilli: '2940000', actualMilli: '0', diffMilli: '-2940000' },
      { partnerType: 'LOCATION' as const, partnerId: 'VAN:R2', name: 'سيارة — مندوب ٢', expectedMilli: '57000', actualMilli: '0', diffMilli: '-57000' },
    ],
  };
  const checks = result().parity.map(c => (c.code === 'R8' ? r8 : c));
  const s = text(html(h(ParitySection, { checks, decimals: 2 })));
  assert.ok(!s.includes('قيود حركات المخزون تُضاف في L6'), 'لا مرحلة لما لا ينطبق');
  assert.ok(s.includes('لا ينطبق: جرد دوري'), s.slice(0, 600));
  assert.ok(s.includes('غير متاح بعد: 8') && s.includes('لا ينطبق: 1'), 'R8 لا يُعدّ «غير متاح بعد»');
  assert.ok(s.includes('للاطلاع، ليس فرقاً'));
  // مطويّ افتراضياً (ليس فرقاً)؛ ومفتوحاً: كل المواقع بقيمها بلا عمود «الفرق» ولا مرشّح «الفروق وحدها»
  const { ParityRow } = await ui();
  const open = text(html(h(ParityRow, { c: r8, decimals: 2, defaultOpen: true })));
  assert.ok(open.includes('2,940.00') && open.includes('57.00'), open);
  assert.ok(!open.includes('الفروق وحدها') && !open.includes('الفرق') && !open.includes('2,940.00-'), 'لا فروق تُعرض للاطلاع');
});

test('القوائم التي قصّها الخادم كلها: لا رسالة «لا شيء» خضراء، والعدد المقصوص ظاهر (المحجوزة، التعمّق، العناصر، الافتتاح)', async () => {
  const { HeldLinesSection, ParitySection, OpeningMoveSection } = await ui();
  // المحجوزة: 0 محفوظة و12 مقصوصة ⇒ تنبيه بالعدد، لا «لا أحداث محجوزة»
  const held = html(h(HeldLinesSection, { lines: [], truncated: 12, decimals: 2 }));
  assert.ok(!text(held).includes('لا أحداث محجوزة ولا سطور على حساب التعليق'));
  assert.ok(text(held).includes('قُصّت كل السطور المحجوزة من النتيجة لتبقى ضمن الحجم المسموح: 12 سطراً'));
  assert.doesNotMatch(held, /emerald/, 'لا نغمة «سليم»');
  // الفارغة حقاً تبقى «لا شيء» خضراء
  assert.match(html(h(HeldLinesSection, { lines: [], truncated: 0, decimals: 2 })), /emerald[^"]*">لا أحداث محجوزة ولا سطور على حساب التعليق/);
  // التعمّق: R2 «فرق» قُصّ تعمّقه كله ⇒ مفتوح بعدد المقصوص، لا «لا فروق» ولا صفّ مطويّ بلا تفصيل
  const checks = result().parity.map(c => (c.code === 'R2' ? { ...c, drill: [], drillTruncated: 40 } : c));
  const par = text(html(h(ParitySection, { checks, decimals: 2 })));
  assert.ok(par.includes('قُصّت كل صفوف التعمق من النتيجة لتبقى ضمن الحجم المسموح: 40 صفاً'), par.slice(0, 800));
  assert.ok(!par.includes('لا فروق'));
  // القيد الافتتاحي: سطوره مقصوصة كلها ⇒ لا «لا أرصدة افتتاحية»
  const opening = { ...result().opening, lines: [], linesTruncated: 30 };
  const op = text(html(h(OpeningMoveSection, { opening, decimals: 2 })));
  assert.ok(!op.includes('لا أرصدة افتتاحية'));
  assert.ok(op.includes('قُصّت كل سطور القيد الافتتاحي من النتيجة لتبقى ضمن الحجم المسموح: 30 سطراً'));
  assert.ok(!op.includes('و 30 سطراً آخر'), 'لا تكرار للعدد');
});

test('الفحص المسبق بعناصر مقصوصة كلها: الصفّ يُفتح (ولو بلا تفاصيل عربية) ويُظهر العدد', async () => {
  const { PreflightRow } = await ui();
  const c = check('P9', 'B', false, { count: 2, items: [], itemsTruncated: 5, details: '' });
  const closed = html(h(PreflightRow, { c, decimals: 2 }));
  assert.doesNotMatch(closed, /<button[^>]*\sdisabled=""/, 'قابل للفتح');
  const open = text(html(h(PreflightRow, { c, decimals: 2, defaultOpen: true })));
  assert.ok(open.includes('قُصّت كل العناصر من النتيجة لتبقى ضمن الحجم المسموح: 5 عنصراً'), open);
  assert.ok(!open.includes('و 5 عنصراً آخر'));
});

test('التقارير: ميزان الأشهر (والصفري مخفي)، وقائمة الدخل بالخسارة التشغيلية، والميزانية، والضريبة بالمربع', async () => {
  const { TrialBalanceSection, PnlSection, BalanceSheetSection, VatSection } = await ui();
  const r = result();
  const tb = text(html(h(TrialBalanceSection, { tb: r.trialBalanceByMonth, decimals: 2, defaultOpen: true })));
  assert.ok(tb.includes('2026-01') && tb.includes('2026-02'));
  assert.ok(tb.includes('420.00'), 'صافي يناير لـ114002 = 630 − 210');
  assert.ok(tb.includes('630.00-'), 'صافي يناير لـ114001 سالب بعلامة لاحقة');
  assert.ok(!tb.includes('999999'), 'الحساب الصفري مخفي افتراضياً');
  assert.ok(tb.includes('840.00'));
  const pnl = text(html(h(PnlSection, { pnl: r.pnlYtd, decimals: 2, defaultOpen: true })));
  assert.ok(pnl.includes('الخسارة التشغيلية') && pnl.includes('مصروفات البيع والتوزيع') && pnl.includes('411001 — المبيعات'));
  assert.ok(pnl.includes('5.00-'));
  const bs = text(html(h(BalanceSheetSection, { bs: r.balanceSheet, decimals: 2, defaultOpen: true })));
  assert.ok(bs.includes('متوازنة') && bs.includes('4,092.00') && bs.includes('الأصول المتداولة'));
  const vat = text(html(h(VatSection, { rows: r.vatByPeriodBox, decimals: 2, defaultOpen: true })));
  assert.ok(vat.includes('SA_1') && vat.includes('45.00') && vat.includes('بلا مربع') && vat.includes('0.15'));
  // مطويّة افتراضياً (صفحة طويلة)
  assert.ok(!text(html(h(TrialBalanceSection, { tb: r.trialBalanceByMonth, decimals: 2 }))).includes('2026-01'));
});

test('الملخّص والمحجوزة والوقت والتحذيرات', async () => {
  const { SummarySection, HeldLinesSection, EtaStorageSection, WarningsSection } = await ui();
  const r = result();
  const sum = text(html(h(SummarySection, { r })));
  assert.ok(sum.includes('aaaaaaaaaaaa…') && sum.includes('SA_6D') && sum.includes('جرد مستمر'));
  assert.ok(sum.includes('مشمول بالقيد الافتتاحي: 2'), 'سبب التخطّي مترجماً');
  assert.ok(sum.includes('2,940.00') && sum.includes('3,035.00') && sum.includes('6.00') && sum.includes('63.00'), 'محرّك التكلفة');
  assert.ok(sum.indexOf('المستودع') < sum.indexOf('سيارة — R2'), 'المستودع قبل السيارات');
  const held = text(html(h(HeldLinesSection, { lines: r.heldLines, truncated: 0, decimals: 2 })));
  assert.ok(held.includes('شكل قيد غير متوقع في كشف الحساب') && held.includes('INVOICE:inv1:REVERSE') && held.includes('115.00') && held.includes('تفصيل الخادم'));
  assert.ok(text(html(h(HeldLinesSection, { lines: [], truncated: 0, decimals: 2 }))).includes('لا أحداث محجوزة ولا سطور على حساب التعليق'));
  const eta = text(html(h(EtaStorageSection, { eta: r.eta, storage: r.storage, defaultOpen: true })));
  assert.ok(eta.includes('58 دقيقة') && eta.includes('3.9 ساعة') && eta.includes('69.1 MB') && eta.includes('207,015'));
  const w = text(html(h(WarningsSection, { warnings: r.warnings })));
  assert.ok(w.includes('قُصّت بعض القوائم'));
  assert.equal(html(h(WarningsSection, { warnings: [] })), '');
});

test('رأس المعاينة: الأساسان، وسبب التعطيل مكتوباً، والتقدّم بالمرحلة والنسبة، والفشل برمزه، وآخر المعاينات', async () => {
  const { PreviewControls, PreviewProgressCard, RecentPreviews } = await ui();
  const noop = () => undefined;
  const on = html(h(PreviewControls, { basis: 'FY_RESTATED', onBasis: noop, onRun: noop, disabledReason: null, pending: false }));
  assert.ok(text(on).includes('من بداية السنة المالية (بأثر رجعي)') && text(on).includes('من يوم التفعيل') && text(on).includes('تشغيل المعاينة'));
  assert.doesNotMatch(on, /<button[^>]*\sdisabled=""/);
  const off = html(h(PreviewControls, { basis: 'FY_RESTATED', onBasis: noop, onRun: noop, disabledReason: 'ربط الدفاتر بالنظام لمالك الشركة وحده', pending: false }));
  assert.match(off, /<button[^>]*\sdisabled=""/);
  assert.ok(text(off).includes('ربط الدفاتر بالنظام لمالك الشركة وحده'));
  const running = html(h(PreviewProgressCard, { view: view({ status: 'RUNNING', phase: 'POST', progressPct: 62, result: null, finishedAt: null }) }));
  assert.match(running, /aria-valuenow="62"/);
  assert.ok(text(running).includes('ترحيل تجريبي في الذاكرة') && text(running).includes('62%'));
  const failed = text(html(h(PreviewProgressCard, { view: view({ status: 'FAILED', phase: 'POST', progressPct: 40, errorCode: 'SHADOW_GL_ACCESS', error: 'رسالة المالك', result: null }) })));
  assert.ok(failed.includes('أُوقفت المعاينة حمايةً للدفاتر') && failed.includes('رسالة المالك'));
  const recent = text(html(h(RecentPreviews, { list: [summaryOf(view()), summaryOf(view({ id: 'pv0', status: 'FAILED', createdAt: '2026-11-13T08:00:00.000Z' }))], selectedId: 'pv1', onSelect: noop })));
  assert.ok(recent.indexOf('اكتملت') < recent.indexOf('فشلت'), 'الأحدث أولاً');
});

// ═══ الصفحة كاملة (ذاكرة react-query مملوءة؛ لا طلب يخرج) ═══

async function renderPage(seed: (qc: QueryClient) => void): Promise<string> {
  browserEnv();
  const { default: LinkingPreviewPage } = await import('../../../pages/ledger/linking/LinkingPreviewPage');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['ledger', 'status'], { tenantId: 't1', suiteEnabled: true, activatedAt: null, setupRequired: true, currencyDecimals: 2 });
  seed(qc);
  return html(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(LinkingPreviewPage))));
}

test('الصفحة كاملة للمالك: كل أقسام العقد §15 بالترتيب، والفحوص FULL من النتيجة، وزرّ واحد للكتابة', async () => {
  const v = view();
  const page = await renderPage(qc => {
    qc.setQueryData(['ledger', 'linking', 'previews'], [summaryOf(v)]);
    qc.setQueryData(['ledger', 'linking', 'preview', v.id], v);
    qc.setQueryData(['ledger', 'linking', 'preflight', 'FY_RESTATED'], preflight('LIGHT'));
  });
  const s = text(page);
  const order = ['ربط الدفاتر بالنظام (معاينة)', 'أساس الربط', 'تشغيل المعاينة', 'الملخص', 'الفحوص المسبقة', 'القيد الافتتاحي',
    'ميزان المراجعة بالأشهر', 'قائمة الدخل منذ بداية السنة', 'الميزانية اليوم', 'الضريبة بالفترة والمربع', 'المطابقة مع التشغيل',
    'السطور المحجوزة وحساب التعليق', 'الوقت والتخزين', 'تحذيرات'];
  let at = -1;
  for (const t of order) { const i = s.indexOf(t, at + 1); assert.ok(i > at, `القسم «${t}» غائب أو خارج ترتيبه`); at = i; }
  assert.ok(s.includes('من المعاينة الكاملة'), 'FULL من المعاينة المكتملة يحلّ محل LIGHT');
  assert.ok(!s.includes('تقدير سريع'));
  assert.ok(!s.includes('اعتماد الربط') && !/\bcommit\b/i.test(s), 'لا زرّ اعتماد (L7)');
  assert.doesNotMatch(page, /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>).)*تشغيل المعاينة/, 'الزرّ متاح للمالك قبل التفعيل');
  assert.match(page, /<button type="button" class="btn-primary[^"]*">(?:(?!<\/button>).)*تشغيل المعاينة<\/button>/);
});

test('الصفحة أثناء التشغيل: الزرّ معطّل بسببه، وشريط التقدّم، والفحوص LIGHT فوراً', async () => {
  const v = view({ id: 'pv2', status: 'RUNNING', phase: 'COSTING', progressPct: 10, result: null, finishedAt: null });
  const page = await renderPage(qc => {
    qc.setQueryData(['ledger', 'linking', 'previews'], [summaryOf(v)]);
    qc.setQueryData(['ledger', 'linking', 'preview', v.id], v);
    qc.setQueryData(['ledger', 'linking', 'preflight', 'FY_RESTATED'], preflight('LIGHT'));
  });
  const s = text(page);
  assert.ok(s.includes('معاينة جارية الآن، انتظر اكتمالها'));
  assert.match(page, /aria-valuenow="10"/);
  assert.ok(s.includes('حساب تكلفة المخزون'));
  assert.ok(s.includes('تقدير سريع') && s.includes('P14'), 'LIGHT ظاهر قبل اكتمال المعاينة');
  assert.ok(!page.includes('linking-opening-title') && !page.includes('linking-parity-title'), 'لا نتيجة قبل DONE');
  assert.match(page, /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>).)*تشغيل المعاينة/, 'الزرّ معطّل أثناء التشغيل');
});

test('الصفحة بلا معاينة: دعوة التشغيل، والفحوص LIGHT', async () => {
  const page = await renderPage(qc => {
    qc.setQueryData(['ledger', 'linking', 'previews'], []);
    qc.setQueryData(['ledger', 'linking', 'preflight', 'FY_RESTATED'], preflight('LIGHT'));
  });
  const s = text(page);
  assert.ok(s.includes('لا معاينة بعد: اختر أساس الربط ثم شغّل المعاينة'));
  assert.ok(s.includes('تقدير سريع'));
});
