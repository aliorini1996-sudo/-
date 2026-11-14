import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {
  EventCountRow, GlLinkPreviewSummary, OpeningPreview, ParityDrillRow, PreflightReport, PreviewResultJson,
} from '../../api/ledgerLinking';
import type { User } from '../../types';
import {
  absBig, cappedListState, durationText, formatBytes, infoEntries, isActivePreview, isLinkingOwner, isParityNotApplicable, linkingBalanceLineLabels,
  linkingErrorText, linkingIncomeGroupLabels, linkingIncomeLineLabels, linkingManualIssueText, linkingOperatingLossLabel,
  linkingWarningText, locationLabel, monthCell, monthNetMilli, openingBalanceCheck, parityCounts, parityReasonText,
  parityTitle, parityTitles, pickPreflight, pickPreviewId, pivotEventCounts, preflightCounts, preflightTitle,
  preflightTitles, preflightTone, previewErrorText, previewPhaseLabels, previewPollInterval, previewProgress,
  retryMinutes, runDisabledReason, previewListPollInterval, PREVIEW_LIST_POLL_MS, shortHash, sortDrill, sortLocations, sortPreviews, statementLineLabel, sumMilli,
  toBig, visibleDrill, parityTone, PREVIEW_POLL_MS, parityDisplayStatus, parityExpandable, preflightExpandable, parityStatusLabels,
} from './linking';
import { formatLedgerAmount, milliToDecimalString } from './format';
import {
  balanceLineLabels, incomeGroupLabels, incomeLineLabels, operatingLossLabel,
} from '../../pages/ledger/reports/statementLines';

/**
 * منطق صفحة «ربط الدفاتر بالنظام (معاينة)» (العقد l23 §15): الملّي بـBigInt بلا فقد، واختيار «آخر معاينة»،
 * واستبدال الفحوص LIGHT بـFULL، وفرز التعمّق، والتسميات، والأخطاء — ومطابقة نسخة الأنواع في الويب لعقد الخادم.
 * الأرقام من أمثلة العقد المحلولة (§5) ومثال تقريب المطابقة (§17 P4-2).
 */

const id = (s: string) => s;
const backendTypes = path.resolve(process.cwd(), '..', 'backend', 'src', 'services', 'gl', 'linking', 'types.ts');
const backendJobs = path.resolve(process.cwd(), '..', 'backend', 'src', 'services', 'gl', 'linking', 'jobs.ts');
const webApi = path.resolve(process.cwd(), 'src', 'api', 'ledgerLinking.ts');
const en = (milli: string, decimals = 2) => formatLedgerAmount(milliToDecimalString(milli), { decimals, locale: 'en-US' });

// ═══ الملّي ═══

test('toBig/sumMilli: نصوص الملّي بـBigInt بلا فقد فوق 2^53، والتالف صفر لا NaN', () => {
  assert.equal(toBig('2940000'), 2_940_000n);
  assert.equal(toBig('-32000'), -32_000n);
  assert.equal(toBig(null), 0n);
  assert.equal(toBig(undefined), 0n);
  assert.equal(toBig('12.5'), 0n, 'الملّي عدد صحيح — الكسر تالف');
  assert.equal(toBig('abc'), 0n);
  assert.equal(toBig(' 15 '), 15n);
  assert.equal(sumMilli(['9007199254740993', '1']), '9007199254740994', 'Number يفقد هذا');
  assert.equal(absBig(-5n), 5n);
  // المثال ج (§5): ثلاث مبيعات بحبّة من 1,000 ملّي ⇒ 330 + 340 + 330 = 1,000 بالضبط
  assert.equal(sumMilli(['330', '340', '330']), '1000');
  assert.equal(en(sumMilli(['330', '340', '330'])), '1.00');
  // تقريب المطابقة لكل مستند (§17 P4-2): 1.005 + 2.005 + 3.125 بمنزلتين ⇒ 1,010 + 2,010 + 3,130 = 6,150 ملّي
  assert.equal(sumMilli(['1010', '2010', '3130']), '6150');
  assert.equal(en('6150'), '6.15');
  // المثال ب: فرق سدّ الحفرة 6,000 ملّي = 6.00 ريال، والمثال أ: المستودع 2,940,000 = 2,940.00
  assert.equal(en('6000'), '6.00');
  assert.equal(en('2940000'), '2,940.00');
  assert.equal(en('-32000'), '32.00-');
  assert.equal(en('1500', 3), '1.500', 'الدينار بثلاث منازل');
});

// ═══ الحالة والاستطلاع ═══

test('الاستطلاع كل ثانيتين ما دامت QUEUED/RUNNING، ويتوقف عند DONE/FAILED', () => {
  assert.equal(PREVIEW_POLL_MS, 2000);
  assert.equal(previewPollInterval('QUEUED'), 2000);
  assert.equal(previewPollInterval('RUNNING'), 2000);
  assert.equal(previewPollInterval('DONE'), false);
  assert.equal(previewPollInterval('FAILED'), false);
  assert.equal(previewPollInterval(undefined), false);
  assert.equal(isActivePreview('RUNNING'), true);
  assert.equal(isActivePreview('DONE'), false);
});

test('استطلاع القائمة: كل عشر ثوانٍ ما دامت فيها جارية لا يستطلعها العرض، وإلا لا', () => {
  assert.equal(PREVIEW_LIST_POLL_MS, 10_000);
  const list = [{ id: 'a', status: 'DONE' as const }, { id: 'b', status: 'RUNNING' as const }];
  assert.equal(previewListPollInterval(list, null), 10_000, 'المستخدم يعرض معاينة أخرى والجارية بلا استطلاع');
  assert.equal(previewListPollInterval(list, 'b'), false, 'العرض يستطلعها كل ثانيتين — لا طلب ثانٍ');
  assert.equal(previewListPollInterval([{ id: 'a', status: 'DONE' }], null), false);
  assert.equal(previewListPollInterval(undefined, null), false);
  assert.equal(previewListPollInterval([{ id: 'q', status: 'QUEUED' }], 'x'), 10_000);
});

test('شريط التقدّم: DONE مئة دائماً، والجارية لا تبلغ 100 قبل الاكتمال، والمرحلة الغائبة «في الطابور»', () => {
  assert.deepEqual(previewProgress({ status: 'DONE', phase: 'PREFLIGHT', progressPct: 94 }), { pct: 100, phase: 'DONE' });
  assert.deepEqual(previewProgress({ status: 'RUNNING', phase: 'POST', progressPct: 62.6 }), { pct: 63, phase: 'POST' });
  assert.deepEqual(previewProgress({ status: 'RUNNING', phase: 'PREFLIGHT', progressPct: 140 }), { pct: 99, phase: 'PREFLIGHT' });
  assert.deepEqual(previewProgress({ status: 'QUEUED', phase: null, progressPct: -3 }), { pct: 0, phase: 'QUEUED' });
  assert.deepEqual(previewProgress({ status: 'FAILED', phase: 'RECONCILE', progressPct: 30 }), { pct: 30, phase: 'RECONCILE' });
  assert.deepEqual(previewProgress({ status: 'RUNNING', phase: 'READ', progressPct: Number.NaN }), { pct: 0, phase: 'READ' });
  // لكل مرحلة تسمية
  for (const p of ['QUEUED', 'READ', 'COSTING', 'OPENING', 'RECONCILE', 'POST', 'PARITY', 'PREFLIGHT', 'DONE'] as const) assert.ok(previewPhaseLabels(id)[p], p);
});

const summary = (o: Partial<GlLinkPreviewSummary> & { id: string }): GlLinkPreviewSummary => ({
  status: 'DONE', phase: 'DONE', progressPct: 100, basis: 'FY_RESTATED', linkedFrom: '2026-01-01', snapshotAt: null,
  dataHash: null, resultHash: null, resultBytes: null, errorCode: null, error: null, createdAt: '2026-11-10T10:00:00.000Z',
  startedAt: null, finishedAt: null, heartbeatAt: null, ...o,
});

test('«آخر معاينة»: الصريحة، ثم الجارية، ثم أحدث مكتملة بالأساس المختار، ثم أحدث مكتملة، ثم أحدث معاينة', () => {
  const doneOld = summary({ id: 'a', createdAt: '2026-11-10T08:00:00.000Z' });
  const doneAct = summary({ id: 'b', basis: 'FROM_ACTIVATION', createdAt: '2026-11-10T09:00:00.000Z' });
  const failed = summary({ id: 'c', status: 'FAILED', errorCode: 'TIMEOUT', createdAt: '2026-11-10T11:00:00.000Z' });
  const running = summary({ id: 'd', status: 'RUNNING', phase: 'POST', createdAt: '2026-11-10T07:00:00.000Z' });
  assert.equal(pickPreviewId([doneOld, doneAct, failed, running], { explicitId: 'a', basis: 'FY_RESTATED' }), 'a', 'الصريحة تغلب');
  assert.equal(pickPreviewId([doneOld, doneAct, failed, running], { basis: 'FROM_ACTIVATION' }), 'd', 'الجارية تُعرض ولو أقدم');
  assert.equal(pickPreviewId([doneOld, doneAct, failed], { basis: 'FY_RESTATED' }), 'a', 'المكتملة بالأساس المختار لا الفاشلة الأحدث');
  assert.equal(pickPreviewId([doneOld, doneAct, failed], { basis: 'FROM_ACTIVATION' }), 'b');
  assert.equal(pickPreviewId([doneAct, failed], { basis: 'FY_RESTATED' }), 'b', 'لا مكتملة بالأساس ⇒ أحدث مكتملة');
  assert.equal(pickPreviewId([failed, summary({ id: 'e', status: 'FAILED', createdAt: '2026-11-09T00:00:00.000Z' })], {}), 'c');
  assert.equal(pickPreviewId([], { basis: 'FY_RESTATED' }), null);
  // تساوي الوقت ⇒ المعرّف تنازلياً (ترتيب الخادم createdAt desc ثم id desc)
  const t = '2026-11-10T10:00:00.000Z';
  assert.deepEqual(sortPreviews([summary({ id: 'x1', createdAt: t }), summary({ id: 'x3', createdAt: t }), summary({ id: 'x2', createdAt: t })]).map(p => p.id), ['x3', 'x2', 'x1']);
  assert.equal(pickPreviewId([summary({ id: 'x1', createdAt: t }), summary({ id: 'x3', createdAt: t })], { basis: 'FY_RESTATED' }), 'x3');
});

const report = (mode: 'LIGHT' | 'FULL', basis: 'FY_RESTATED' | 'FROM_ACTIVATION' = 'FY_RESTATED'): PreflightReport => ({
  mode, basis, linkedFrom: '2026-01-01', blocking: 1, warnings: 1,
  checks: [
    { code: 'P1', level: 'B', ok: true, titleAr: 'x', details: '', mode },
    { code: 'P2', level: 'B', ok: false, titleAr: 'x', details: '', mode },
    { code: 'P6', level: 'W', ok: false, titleAr: 'x', details: '', mode },
    { code: 'P14', level: 'B', ok: true, notApplicable: true, titleAr: 'x', details: '', mode },
  ],
});

test('الفحوص: LIGHT فوراً ويُستبدل بـFULL من المعاينة المكتملة للأساس نفسه وحده', () => {
  const light = report('LIGHT');
  const full = report('FULL');
  const done = { status: 'DONE' as const, result: { preflight: full } as unknown as PreviewResultJson };
  assert.deepEqual(pickPreflight(light, done, 'FY_RESTATED'), { report: full, source: 'FULL' });
  assert.deepEqual(pickPreflight(light, { status: 'RUNNING', result: null }, 'FY_RESTATED'), { report: light, source: 'LIGHT' });
  assert.deepEqual(pickPreflight(undefined, done, 'FY_RESTATED'), { report: full, source: 'FULL' });
  // المعاينة لأساس آخر ⇒ LIGHT للأساس المختار (linkedFrom يختلف)
  const lightAct = report('LIGHT', 'FROM_ACTIVATION');
  assert.deepEqual(pickPreflight(lightAct, done, 'FROM_ACTIVATION'), { report: lightAct, source: 'LIGHT' });
  assert.equal(pickPreflight(light, null, 'FROM_ACTIVATION'), null, 'ذاكرة أساس آخر لا تُعرض');
  assert.equal(pickPreflight(null, null, 'FY_RESTATED'), null);
  // العدّ: «لا ينطبق» لا يُحتسب، وB/W غير المتحققة
  assert.deepEqual(preflightCounts(light), { blocking: 1, warnings: 1, passed: 1, notApplicable: 1 });
  assert.equal(preflightTone(light.checks[0]), 'green');
  assert.equal(preflightTone(light.checks[1]), 'red');
  assert.equal(preflightTone(light.checks[2]), 'amber');
  assert.equal(preflightTone(light.checks[3]), 'gray');
});

// ═══ التعمّق والمطابقة ═══

const drill = (partnerId: string | null, diffMilli: string, name: string | null = null): ParityDrillRow => ({
  partnerType: 'CUSTOMER', partnerId, name, expectedMilli: '0', actualMilli: '0', diffMilli,
});

test('فرز التعمّق: |الفرق| تنازلياً بـBigInt (فوق 2^53)، ثم المعرّف ثم الاسم، و«الفروق وحدها» تُسقط الصفر', () => {
  const rows = [
    drill('c3', '0'), drill('c1', '-1'), drill('c2', '1'), drill('c9', '9007199254740993'), drill('c8', '9007199254740992'),
    drill(null, '-500', 'بلا شريك'), drill('c0', '0', 'ب'), drill('c0', '0', 'أ'),
  ];
  assert.deepEqual(sortDrill(rows).map(r => `${r.partnerId}:${r.diffMilli}:${r.name ?? ''}`), [
    'c9:9007199254740993:', 'c8:9007199254740992:', 'null:-500:بلا شريك', 'c1:-1:', 'c2:1:', 'c0:0:أ', 'c0:0:ب', 'c3:0:',
  ]);
  assert.deepEqual(visibleDrill(rows, true).map(r => r.partnerId), ['c9', 'c8', null, 'c1', 'c2']);
  assert.equal(visibleDrill(rows, false).length, rows.length);
  assert.equal(rows[0].partnerId, 'c3', 'الفرز لا يعدّل المدخل');
});

test('المطابقة: العدّ والنغمة، وسبب «غير متاح بعد» بتسميتنا ثم نصّ الخادم للعربية ثم «يُضاف في Lx»', () => {
  assert.deepEqual(parityCounts([{ status: 'OK' }, { status: 'OK' }, { status: 'MISMATCH' }, { status: 'NOT_AVAILABLE' }]), { ok: 2, mismatch: 1, notAvailable: 1, notApplicable: 0 });
  assert.equal(parityTone('OK'), 'green');
  assert.equal(parityTone('MISMATCH'), 'red');
  assert.equal(parityTone('NOT_AVAILABLE'), 'gray');
  assert.equal(parityReasonText(id, { code: 'R8', status: 'NOT_AVAILABLE', reason: 'نص الخادم', availableIn: 'L6' }, 'en'), 'قيود حركات المخزون تُضاف في L6');
  assert.equal(parityReasonText(id, { code: 'R1', status: 'NOT_AVAILABLE', reason: 'نص الخادم', availableIn: 'L7' }, 'ar'), 'نص الخادم');
  assert.equal(parityReasonText(id, { code: 'R1', status: 'NOT_AVAILABLE', reason: 'نص الخادم', availableIn: 'L7' }, 'en'), 'يُضاف في L7');
  assert.equal(parityReasonText(id, { code: 'R1', status: 'NOT_AVAILABLE', reason: null, availableIn: null }, 'en'), 'يُضاف في مرحلة لاحقة');
  assert.equal(parityReasonText(id, { code: 'R8', status: 'OK', reason: null, availableIn: null }, 'ar'), null);
  assert.deepEqual(infoEntries({ openingTie: 'OK', zMilli: '5', a: 3 }), [
    { key: 'a', value: 3, milli: false }, { key: 'openingTie', value: 'OK', milli: false }, { key: 'zMilli', value: '5', milli: true },
  ]);
  assert.deepEqual(infoEntries(undefined), []);
});

/** R8 لشركة بجرد دوري كما يرسله الخادم (parity.ts checkR8: availableIn = null وR8_PERIODIC_REASON وreasonCode) */
const R8_PERIODIC = {
  code: 'R8' as const, status: 'NOT_AVAILABLE' as const, availableIn: null, reasonCode: 'INVENTORY_PERIODIC' as const,
  reason: 'المخزون الدوري (PERIODIC): لا تحمل الدفاتر رصيد مخزون مستمرّاً — لا مطابقة 114001/114002',
};

test('المطابقة «لا ينطبق»: R8 لجرد دوري (availableIn = null) لا يُقال له «تُضاف في L6» بأي لغة، ولا يُعدّ «غير متاح بعد»', () => {
  const periodicText = 'لا ينطبق: جرد دوري، فلا تحمل الدفاتر رصيد مخزون مستمراً ولا مطابقة له في أي مرحلة';
  for (const lang of ['ar', 'en', 'fr', 'tr', 'zh']) {
    const t = parityReasonText(id, R8_PERIODIC, lang);
    assert.equal(t, periodicText, lang);
    assert.ok(!/L6/.test(t ?? ''), `${lang}: لا «تُضاف في L6»`);
  }
  assert.equal(isParityNotApplicable(R8_PERIODIC), true);
  assert.equal(parityDisplayStatus(R8_PERIODIC), 'NOT_APPLICABLE');
  assert.equal(parityStatusLabels(id).NOT_APPLICABLE, 'لا ينطبق');
  assert.equal(parityTone(parityDisplayStatus(R8_PERIODIC)), 'gray');
  // بلا رمز (نتيجة أقدم أو سبب آخر) وavailableIn = null بسبب الخادم: نصّه للعربية، و«لا ينطبق على هذه الشركة» لغيرها — لا «L6»
  const noCode = { ...R8_PERIODIC, reasonCode: undefined };
  assert.equal(parityReasonText(id, noCode, 'ar'), R8_PERIODIC.reason);
  assert.equal(parityReasonText(id, noCode, 'en'), 'لا ينطبق على هذه الشركة');
  // المستمر (OPENING_ONLY) يبقى «غير متاح بعد» بمرحلته
  const perpetual = { code: 'R8' as const, status: 'NOT_AVAILABLE' as const, availableIn: 'L6' as const, reason: 'قيود حركات المخزون تُضاف في L6' };
  assert.equal(isParityNotApplicable(perpetual), false);
  assert.equal(parityDisplayStatus(perpetual), 'NOT_AVAILABLE');
  assert.equal(parityReasonText(id, perpetual, 'en'), 'قيود حركات المخزون تُضاف في L6');
  // null بلا أي سبب: لا يُدّعى «لا ينطبق»
  assert.equal(isParityNotApplicable({ status: 'NOT_AVAILABLE', availableIn: null, reason: null }), false);
  assert.equal(isParityNotApplicable({ status: 'OK', availableIn: null, reason: 'x', reasonCode: 'INVENTORY_PERIODIC' }), false);
  assert.deepEqual(parityCounts([{ status: 'OK' }, R8_PERIODIC, perpetual, { status: 'MISMATCH' }]), { ok: 1, mismatch: 1, notAvailable: 1, notApplicable: 1 });
});

test('القوائم المقصوصة: «لا شيء» للفارغة حقاً وحدها، وما قُصّ كله ALL_TRUNCATED، ويُفتح الصفّ ليظهر عدده بأي لغة', () => {
  assert.equal(cappedListState(0, 0), 'EMPTY');
  assert.equal(cappedListState(0, undefined), 'EMPTY');
  assert.equal(cappedListState(0, null), 'EMPTY');
  assert.equal(cappedListState(0, 12), 'ALL_TRUNCATED');
  assert.equal(cappedListState(3, 12), 'SHOWN');
  assert.equal(cappedListState(3, 0), 'SHOWN');
  // تعمّق مقصوص كله: يُفتح (فيظهر drillTruncated) ولو لا صفّ ولا info
  assert.equal(parityExpandable({ drill: [], drillTruncated: 40 }), true);
  assert.equal(parityExpandable({ drill: [], drillTruncated: 0 }), false);
  assert.equal(parityExpandable({ drill: [], drillTruncated: 0, info: { a: 1 } }), true);
  // عناصر فحص مقصوصة كلها: تُفتح لغير العربية أيضاً (التفاصيل العربية وحدها لا تفتحه بالإنجليزية)
  assert.equal(preflightExpandable({ items: [], itemsTruncated: 5, details: 'تفاصيل' }, 'en'), true);
  assert.equal(preflightExpandable({ items: [], itemsTruncated: 0, details: 'تفاصيل' }, 'en'), false);
  assert.equal(preflightExpandable({ items: [], itemsTruncated: 0, details: 'تفاصيل' }, 'ar'), true);
  assert.equal(preflightExpandable({ details: '' }, 'ar'), false);
});

// ═══ الأحداث ═══

test('أعداد الأحداث: جدول محوري حتمي بالنوع والحدث، والحالات بترتيبها، والأسباب الأكثر أولاً', () => {
  const rows: EventCountRow[] = [
    { sourceType: 'RECEIPT', event: 'POST', status: 'DONE', reason: null, count: 8000 },
    { sourceType: 'INVOICE', event: 'POST', status: 'SKIPPED', reason: 'OPENING', count: 1200 },
    { sourceType: 'INVOICE', event: 'POST', status: 'DONE', reason: null, count: 20000 },
    { sourceType: 'INVOICE', event: 'REVERSE', status: 'HELD', reason: 'UNEXPECTED_ENTRY_SHAPE', count: 2 },
    { sourceType: 'INVOICE', event: 'POST', status: 'SKIPPED', reason: 'NETTED', count: 30 },
    { sourceType: 'SETTLEMENT', event: 'POST', status: 'DONE', reason: null, count: 1000 },
  ];
  const p = pivotEventCounts(rows);
  assert.deepEqual(p.statuses, ['DONE', 'SKIPPED', 'HELD']);
  assert.deepEqual(p.rows.map(r => `${r.sourceType}/${r.event}:${r.total}`), ['INVOICE/POST:21230', 'INVOICE/REVERSE:2', 'RECEIPT/POST:8000', 'SETTLEMENT/POST:1000']);
  assert.deepEqual(p.rows[0].counts, { SKIPPED: 1230, DONE: 20000 });
  assert.deepEqual(p.totals, { DONE: 29000, SKIPPED: 1230, HELD: 2 });
  assert.equal(p.total, 30232);
  assert.deepEqual(p.reasons, [
    { status: 'SKIPPED', reason: 'OPENING', count: 1200 }, { status: 'SKIPPED', reason: 'NETTED', count: 30 },
    { status: 'HELD', reason: 'UNEXPECTED_ENTRY_SHAPE', count: 2 },
  ]);
  // إعادة ترتيب المدخل لا تغيّر الناتج
  assert.deepEqual(pivotEventCounts([...rows].reverse()), p);
  assert.deepEqual(pivotEventCounts([]).rows, []);
});

// ═══ القيد الافتتاحي وميزان الشهور ═══

/**
 * قيد افتتاحي من أمثلة العقد (ريال، u = 10): المثال أ بعد #10 — المستودع 140 @ 2,940,000؛ والمثال ب بعد #4 —
 * المستودع 10 @ 95,000 وسيارة R2 6 @ 57,000؛ وذمة عميل 1,150,000؛ والفرق إلى 319002 دائناً.
 */
const opening = (): OpeningPreview => ({
  date: '2025-12-31',
  lines: [
    { accountCode: '113001', accountName: 'ذمم العملاء', origin: 'DERIVED', partnerType: 'CUSTOMER', partnerId: 'cu1', partnerName: 'عميل', label: 'رصيد افتتاحي — عميل', debitMilli: '1150000', creditMilli: '0' },
    { accountCode: '114001', accountName: 'مخزون المستودع', origin: 'DERIVED', partnerType: 'LOCATION', partnerId: 'WH', partnerName: null, label: 'مخزون المستودع الافتتاحي', debitMilli: '3035000', creditMilli: '0' },
    { accountCode: '114002', accountName: 'بضاعة السيارات', origin: 'DERIVED', partnerType: 'REP', partnerId: 'R2', partnerName: 'R2', label: 'بضاعة سيارة — R2', debitMilli: '57000', creditMilli: '0' },
    { accountCode: '211001', accountName: 'الموردون', origin: 'MANUAL', partnerType: 'VENDOR', partnerId: null, partnerName: 'مورد', label: 'رصيد يدوي', debitMilli: '0', creditMilli: '400000' },
    { accountCode: '319002', accountName: 'أرصدة افتتاحية', origin: 'EQUITY', partnerType: null, partnerId: null, partnerName: null, label: 'فرق الأرصدة الافتتاحية', debitMilli: '0', creditMilli: '3842000' },
  ],
  linesTruncated: 0,
  byAccount: [],
  totals: { debitMilli: '4242000', creditMilli: '4242000', derivedNetMilli: '4242000', manualDebitMilli: '0', manualCreditMilli: '400000', equityDiffMilli: '3842000' },
  manualIssues: [],
});

test('توازن القيد الافتتاحي بالملّي من المجاميع، ومطابقة السطور المعروضة لها (لا تُعرف مع القصّ)', () => {
  const o = opening();
  // 2,940,000 + 95,000 = 3,035,000 (المستودع في المثالين) و57,000 (السيارة) — Σ المدين = 4,242,000
  assert.deepEqual(openingBalanceCheck(o), { balanced: true, diffMilli: '0', linesMatchTotals: true });
  const off = { ...o, totals: { ...o.totals, creditMilli: '4241990' } };
  assert.deepEqual(openingBalanceCheck(off), { balanced: false, diffMilli: '10', linesMatchTotals: false });
  const truncated = { ...o, linesTruncated: 3 };
  assert.equal(openingBalanceCheck(truncated).linesMatchTotals, null);
  const tampered = { ...o, lines: o.lines.map((l, i) => (i === 0 ? { ...l, debitMilli: '1149990' } : l)) };
  assert.equal(openingBalanceCheck(tampered).linesMatchTotals, false, 'سطر ينقص 10 ملّي عن المجاميع يُلتقط');
});

test('ميزان الشهور: صافي الشهر مدين − دائن بالملّي، والشهر الغائب صفر', () => {
  const row = { months: [{ month: '2026-01', debitMilli: '630000', creditMilli: '210000' }, { month: '2026-02', debitMilli: '0', creditMilli: '42000' }] };
  assert.equal(monthNetMilli(monthCell(row, '2026-01')), '420000');
  assert.equal(monthNetMilli(monthCell(row, '2026-02')), '-42000');
  assert.equal(monthCell(row, '2026-03'), undefined);
  assert.equal(monthNetMilli(monthCell(row, '2026-03')), '0');
});

// ═══ التسميات ═══

test('أسطر القائمتين: نسخة جدول التقارير حرفاً، والمجموعة والحساب والمجهول، والربح التشغيلي السالب خسارة', () => {
  assert.deepEqual(linkingIncomeLineLabels(id), incomeLineLabels(id), 'انجرفت تسميات قائمة الدخل عن statementLines.ts');
  assert.deepEqual(linkingIncomeGroupLabels(id), incomeGroupLabels(id), 'انجرفت تسميات المجموعات');
  assert.deepEqual(linkingBalanceLineLabels(id), balanceLineLabels(id), 'انجرفت تسميات الميزانية');
  assert.equal(linkingOperatingLossLabel(id), operatingLossLabel(id));
  const l = (key: string, amountMilli = '1000', labelAr = 'نص الخادم') => statementLineLabel(id, { key, labelAr, amountMilli });
  assert.equal(l('revenue'), 'صافي الإيرادات');
  assert.equal(l('operatingIncome', '-5000'), 'الخسارة التشغيلية');
  assert.equal(l('operatingIncome', '5000'), 'الربح التشغيلي');
  assert.equal(l('operatingExpenses.selling'), 'مصروفات البيع والتوزيع');
  assert.equal(l('operatingExpenses.unknownGroup'), 'نص الخادم');
  assert.equal(l('currentAssets'), 'الأصول المتداولة');
  assert.equal(l('assetCash:111001', '1', '111001 — الصندوق'), '111001 — الصندوق', 'سطر الحساب كما وصل');
  assert.equal(l('brandNewKey'), 'نص الخادم', 'مفتاح جديد لا يسقط صامتاً');
});

test('عناوين الفحوص والمطابقات كاملة لكل رمز، والمجهول بـtitleAr للعربية وحدها', () => {
  assert.equal(Object.keys(preflightTitles(id)).length, 14);
  assert.equal(Object.keys(parityTitles(id)).length, 13);
  assert.equal(preflightTitle(id, { code: 'P7', titleAr: 'x' }, 'en'), 'نسب ضريبة البيع ومربعات الإقرار');
  assert.equal(preflightTitle(id, { code: 'P99' as 'P1', titleAr: 'عنوان الخادم' }, 'ar'), 'عنوان الخادم');
  assert.equal(preflightTitle(id, { code: 'P99' as 'P1', titleAr: 'عنوان الخادم' }, 'en'), 'P99');
  assert.equal(parityTitle(id, { code: 'R2', titleAr: 'x' }, 'fr'), 'ذمم العملاء لكل عميل');
  assert.equal(previewErrorText(id, 'SHADOW_GL_ACCESS'), 'أُوقفت المعاينة حمايةً للدفاتر: وصول غير مدعوم، ولا رقم معروض منها');
  assert.equal(previewErrorText(id, 'SOMETHING_NEW'), 'فشلت المعاينة');
  assert.equal(previewErrorText(id, null), 'فشلت المعاينة');
  assert.equal(linkingManualIssueText(id, 'DERIVED_ACCOUNT').startsWith('هذا الحساب يُشتق من التشغيل'), true);
  assert.equal(linkingManualIssueText(id, 'ACCOUNT_NOT_FOUND'), 'الحساب غير موجود');
  assert.equal(linkingManualIssueText(id, 'NEW_REASON'), 'NEW_REASON');
  assert.equal(linkingWarningText(id, { code: 'RESULT_TRUNCATED', message: 'م' }, 'en'), 'قُصّت بعض القوائم لتبقى النتيجة ضمن الحجم المسموح');
  assert.equal(linkingWarningText(id, { code: 'X', message: 'رسالة' }, 'ar'), 'رسالة');
  assert.equal(linkingWarningText(id, { code: 'X', message: 'رسالة' }, 'en'), 'X', 'لا نصّ خادم عربي في واجهة غير عربية');
});

test('المواقع والبصمة والحجم والمدة', () => {
  assert.equal(locationLabel(id, 'WH'), 'المستودع');
  assert.equal(locationLabel(id, 'VAN:_'), 'سيارة غير معروفة');
  assert.equal(locationLabel(id, 'VAN:rep_abcdefghijk'), 'سيارة — rep_abcd');
  assert.equal(locationLabel(id, 'VAN:r1', { r1: 'خالد' }), 'سيارة — خالد');
  assert.deepEqual(sortLocations([{ location: 'VAN:_' }, { location: 'VAN:b' }, { location: 'WH' }, { location: 'VAN:a' }]).map(x => x.location), ['WH', 'VAN:a', 'VAN:b', 'VAN:_']);
  assert.equal(shortHash('0123456789abcdef0123'), '0123456789ab…');
  assert.equal(shortHash('abc'), 'abc');
  assert.equal(shortHash(null), '—');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1_500_000), '1.4 MB');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(-1), '—');
  assert.equal(durationText(id, 0), '0 دقيقة');
  assert.equal(durationText(id, 0.2), '1 دقيقة');
  assert.equal(durationText(id, 45), '45 دقيقة');
  assert.equal(durationText(id, 90), '1.5 ساعة');
  assert.equal(durationText(id, 60 * 72), '3 يوم');
});

// ═══ الصلاحية والأخطاء ═══

const user = (o: Partial<User>): User => ({ id: 'u', name: 'u', role: 'MANAGER', ...o }) as User;

test('مالك الشركة: ADMIN بـcanManageCompanyUsers غير مقيّد، أو جلسة مالك المنصّة — لا المحاسب بـcanConfigureLedger', () => {
  assert.equal(isLinkingOwner(user({ role: 'ADMIN', canManageCompanyUsers: true })), true);
  assert.equal(isLinkingOwner(user({ role: 'ADMIN', canManageCompanyUsers: false })), false);
  assert.equal(isLinkingOwner(user({ role: 'MANAGER', canConfigureLedger: true })), false);
  assert.equal(isLinkingOwner(user({ role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: true })), false);
  assert.equal(isLinkingOwner(user({ role: 'ADMIN', canManageCompanyUsers: false }), 'شركة'), true, 'جلسة مالك المنصّة');
  assert.equal(isLinkingOwner(null, 'شركة'), false);
});

test('نصوص أخطاء الربط: رموز المسارات، وحدّ المعدّل بالدقائق مقرّبةً لأعلى، وأسباب 422، والبقية نصوص الدفاتر', () => {
  assert.equal(linkingErrorText(id, { code: 'LEDGER_LINKING_OWNER_ONLY', status: 403 }), 'ربط الدفاتر بالنظام لمالك الشركة وحده');
  assert.equal(linkingErrorText(id, { code: 'LEDGER_LINKING_INTERACTIVE_ONLY', status: 403 }), 'ربط الدفاتر بالنظام من لوحة التحكم وحدها لا بمفتاح الربط البرمجي');
  assert.equal(linkingErrorText(id, { code: 'LEDGER_LINK_ALREADY_ACTIVATED', status: 409 }), 'الدفاتر مفعّلة بالفعل، والمعاينة للشركات قبل التفعيل وحدها');
  assert.equal(linkingErrorText(id, { code: 'LEDGER_LINK_PREVIEW_NOT_FOUND', status: 404 }), 'المعاينة غير موجودة');
  assert.equal(linkingErrorText(id, { code: 'LEDGER_LINK_PREVIEW_RATE_LIMITED', status: 429, retryAfterSeconds: 61 }), 'بلغت حد المعاينات في الساعة — أعد المحاولة بعد 2 دقيقة');
  assert.equal(linkingErrorText(id, { code: 'LEDGER_LINK_PREVIEW_RATE_LIMITED', status: 429, details: { retryAfterSeconds: '600' } }), 'بلغت حد المعاينات في الساعة — أعد المحاولة بعد 10 دقيقة');
  assert.equal(linkingErrorText(id, { code: 'LEDGER_LINK_PREVIEW_RATE_LIMITED', status: 429 }), 'بلغت حد المعاينات في الساعة');
  assert.equal(retryMinutes(1), 1);
  assert.equal(retryMinutes(3600), 60);
  assert.equal(linkingErrorText(id, { code: 'LEDGER_LINK_PARAMS_INVALID', status: 422, reason: 'TEMPLATE_UNAVAILABLE' }), 'لا قالب محاسبي لدولة الشركة، تواصل مع الدعم قبل ربط الدفاتر');
  assert.equal(linkingErrorText(id, { code: 'LEDGER_LINK_PARAMS_INVALID', status: 422, details: { reason: 'INVALID_FISCAL_YEAR_END' } }), 'يوم نهاية السنة المالية غير صالح للشهر، صححه في الخطوة الأولى من معالج الإعداد');
  assert.equal(linkingErrorText(id, { code: 'LEDGER_LINK_PARAMS_INVALID', status: 422 }), 'إعدادات الربط غير صالحة، راجع معالج الإعداد');
  assert.equal(linkingErrorText(id, { code: 'LEDGER_PERMISSION_DENIED', status: 403 }), 'لا تملك صلاحية الوصول لهذا القسم');
  assert.equal(linkingErrorText(id, { status: 500 }), 'تعذر تنفيذ الإجراء');
  assert.equal(linkingErrorText(id, null), 'تعذر تنفيذ الإجراء');
});

test('سبب تعطيل «تشغيل المعاينة» بالأولوية: المالك، ثم التفعيل، ثم الجارية، ثم الطلب القائم', () => {
  const s = { owner: true, activated: false, running: false, pending: false };
  assert.equal(runDisabledReason(id, s), null);
  assert.equal(runDisabledReason(id, { ...s, owner: false, activated: true, running: true }), 'ربط الدفاتر بالنظام لمالك الشركة وحده');
  assert.equal(runDisabledReason(id, { ...s, activated: true, running: true }), 'الدفاتر مفعّلة بالفعل، والمعاينة للشركات قبل التفعيل وحدها');
  assert.equal(runDisabledReason(id, { ...s, running: true, pending: true }), 'معاينة جارية الآن، انتظر اكتمالها');
  assert.equal(runDisabledReason(id, { ...s, pending: true }), 'جاري الطلب...');
});

// ═══ نسخة الأنواع في الويب مقابل عقد الخادم ═══

/** حقول واجهة TypeScript من نصّها (المستوى الأعلى وحده) */
function interfaceFields(src: string, name: string): string[] {
  const m = new RegExp(`export interface ${name}(?:<[^>]*>)?(?:\\s+extends\\s+[\\w<>, ]+)?\\s*\\{`).exec(src);
  assert.ok(m, `الواجهة ${name} غير موجودة`);
  let depth = 0; let i = m.index + m[0].length - 1; const start = i;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
  const body = src.slice(start + 1, i);
  const out: string[] = []; let d = 0;
  for (const line of body.split(/\r?\n/)) {
    if (d === 0) { const f = /^\s*(\w+)\??\s*:/.exec(line); if (f && !/^\s*\/[*/]/.test(line)) out.push(f[1]); }
    for (const ch of line.replace(/\/\/.*$/, '')) { if (ch === '{' || ch === '(') d++; else if (ch === '}' || ch === ')') d--; }
  }
  return out.sort();
}

test('محلّل الحقول نفسه: المستوى الأعلى وحده (لا حقول الكائنات المتداخلة)، والاختيارية والتعليقات', () => {
  const src = [
    'export interface A {',
    '  /** تعليق: ليس حقلاً */',
    '  a: string;',
    '  b?: { inner: number; deep: { x: 1 } } | null;',
    '  c: {',
    '    nested: string;',
    '  }[];',
    '  d(x: number): void;',
    '}',
    'export interface B extends A { z: 1 }',
  ].join(String.fromCharCode(10));
  assert.deepEqual(interfaceFields(src, 'A'), ['a', 'b', 'c']);
});

function constArray(src: string, name: string): string[] {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
  assert.ok(m, `الثابت ${name} غير موجود`);
  return [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map(x => x[1]);
}

test('نسخة الويب (api/ledgerLinking.ts) تطابق عقد الخادم linking/types.ts وjobs.ts: الثوابت وحقول كل واجهة', t => {
  if (!fs.existsSync(backendTypes)) { t.skip('عقد الخادم غير موجود'); return; }
  const server = fs.readFileSync(backendTypes, 'utf8');
  const web = fs.readFileSync(webApi, 'utf8');
  for (const c of ['LINK_BASES', 'PREVIEW_STATUSES', 'PREVIEW_PHASES', 'PREVIEW_ERROR_CODES', 'PREFLIGHT_CODES', 'PARITY_CODES']) {
    assert.deepEqual(constArray(web, c), constArray(server, c), c);
  }
  const pct = (s: string) => /PREVIEW_PHASE_PCT[^=]*=\s*\{([^}]*)\}/.exec(s)?.[1].replace(/\s+/g, '');
  assert.equal(pct(web), pct(server), 'PREVIEW_PHASE_PCT');
  const caps = (s: string) => /PREVIEW_LIST_CAPS\s*=\s*\{([^}]*)\}/.exec(s)?.[1].replace(/\s+/g, '');
  assert.equal(caps(web), caps(server), 'PREVIEW_LIST_CAPS');
  assert.equal(/PREVIEW_RATE_LIMIT_PER_HOUR = (\d+)/.exec(web)?.[1], /PREVIEW_RATE_LIMIT_PER_HOUR = (\d+)/.exec(server)?.[1]);
  const pairs: [string, string][] = [
    ['PreviewResultJson', 'PreviewResult'], ['PreflightItem', 'PreflightItem'], ['PreflightCheck', 'PreflightCheck'],
    ['PreflightReport', 'PreflightReport'], ['ParityDrillRow', 'ParityDrillRow'], ['ParityCheck', 'ParityCheck'],
    ['OpeningPreviewLine', 'OpeningPreviewLine'], ['OpeningPreview', 'OpeningPreview'], ['EventCountRow', 'EventCountRow'],
    ['HeldLine', 'HeldLine'], ['TrialBalanceMonthRow', 'TrialBalanceMonthRow'], ['TrialBalanceByMonth', 'TrialBalanceByMonth'],
    ['StatementPreviewLine', 'StatementPreviewLine'], ['PnlPreview', 'PnlPreview'], ['BalanceSheetPreview', 'BalanceSheetPreview'],
    ['VatPeriodBoxRow', 'VatPeriodBoxRow'], ['PreviewEta', 'PreviewEta'], ['PreviewStorage', 'PreviewStorage'],
    ['PreviewWarning', 'PreviewWarning'], ['CostingPreview', 'CostingPreview'],
  ];
  for (const [w, s] of pairs) {
    const fields = interfaceFields(server, s);
    assert.ok(fields.length >= 2, `المحلّل لم يقرأ حقول ${s}`);
    assert.deepEqual(interfaceFields(web, w), fields, `${w} ↔ ${s}`);
  }
  assert.ok(interfaceFields(server, 'PreviewResult').length >= 28, 'PreviewResult ناقص الحقول في المحلّل');
  // CostingSummary وLocationTotals من costing/types.ts
  const costing = path.resolve(path.dirname(backendTypes), '..', '..', 'costing', 'types.ts');
  if (fs.existsSync(costing)) {
    const c = fs.readFileSync(costing, 'utf8');
    assert.deepEqual(interfaceFields(web, 'CostingSummary'), interfaceFields(c, 'CostingSummary'), 'CostingSummary');
    assert.deepEqual(interfaceFields(web, 'LocationTotals'), interfaceFields(c, 'LocationTotals'), 'LocationTotals');
  }
  // صفّ المعاينة (jobs.ts): الملخّص + result
  if (fs.existsSync(backendJobs)) {
    const j = fs.readFileSync(backendJobs, 'utf8');
    assert.deepEqual(interfaceFields(web, 'GlLinkPreviewView'), [...interfaceFields(j, 'GlLinkPreviewSummary'), 'result'].sort(), 'GlLinkPreviewView');
  }
});
