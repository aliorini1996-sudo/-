import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FISCAL_YEAR, MAX_COMPARISON_COUNT,
  addDaysLocal, addMonthsLocal, changePercent, clampToFeatures, defaultDateMode, defaultReportOptions,
  endOfMonthLocal, fiscalQuarterRange, fiscalYearRange, formatPercent, generalLedgerHref, isLocalDate,
  milliToUnitString, moveHref, parseReportOptions, percentChange, reportFeatures, reportQueryParams,
  reportSearchParams, reportSearchString, resolvePeriodRange, shiftReportPeriod, startOfMonthLocal,
  toMilli, unitScaleDigits, unitSuffixKey,
  type FiscalYearConfig, type ReportKey, type ReportOptionsState,
} from './reportOptions';

/**
 * خيارات تقارير الدفاتر (M4، §7.1): المنطق الصرف وحده — الفترات والإزاحة والمعاملات والرابط
 * والوحدة ونسبة التغيّر. مرجع كل توقّع هنا هو الخادم نفسه:
 * `backend/src/routes/ledger/reports.ts` (`defaultDateFilter`, `resolveDateFilter`, `optionsShape`)
 * و`services/gl/reports/period.ts` (`resolveReportPeriod`, `fiscalQuarterOf`)
 * و`services/gl/reports/trialBalance.ts` (`percentChange`).
 */

const TODAY = '2026-09-23';
/** سنة مالية غير تقويمية (تنتهي 31 مارس) — الفخّ الذي يُسقط حساب الربع والسنة */
const FY_MARCH: FiscalYearConfig = { endMonth: 3, endDay: 31 };

const stateOf = (key: ReportKey, over: Partial<ReportOptionsState> = {}): ReportOptionsState =>
  ({ ...defaultReportOptions(key, TODAY), ...over });

// ═══ تواريخ محلية ═══

test('التواريخ المحلية: التحقق والقصّ إلى آخر الشهر', () => {
  assert.ok(isLocalDate('2026-02-28'));
  assert.ok(!isLocalDate('2026-02-30'), '30 فبراير ليس تاريخاً');
  assert.ok(!isLocalDate('2026-13-01'));
  assert.ok(!isLocalDate('26-01-01'));
  assert.ok(!isLocalDate(null));
  // 31 يناير + شهر = آخر فبراير (قاعدة addMonths في الخادم)
  assert.equal(addMonthsLocal('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsLocal('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonthsLocal('2026-01-15', -1), '2025-12-15');
  assert.equal(addDaysLocal('2026-03-01', -1), '2026-02-28');
  assert.equal(startOfMonthLocal('2026-09-23'), '2026-09-01');
  assert.equal(endOfMonthLocal('2026-09-23'), '2026-09-30');
  assert.equal(endOfMonthLocal('2026-02-01'), '2026-02-28');
});

test('السنة المالية والربع المالي — غير التقويمية أيضاً', () => {
  assert.deepEqual(fiscalYearRange('2026-09-23'), { from: '2026-01-01', to: '2026-12-31' });
  // تنتهي 31 مارس: 2026-03-15 داخل السنة 2025-04-01 … 2026-03-31
  assert.deepEqual(fiscalYearRange('2026-03-15', FY_MARCH), { from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(fiscalYearRange('2026-04-01', FY_MARCH), { from: '2026-04-01', to: '2027-03-31' });
  // الربع **المالي** كتل ثلاثة أشهر من بداية السنة المالية لا من يناير
  assert.deepEqual(fiscalQuarterRange('2025-06-10', FY_MARCH), { from: '2025-04-01', to: '2025-06-30' });
  assert.deepEqual(fiscalQuarterRange('2026-02-02', FY_MARCH), { from: '2026-01-01', to: '2026-03-31' });
  // ومع سنة تقويمية يطابق الربع التقويمي
  assert.deepEqual(fiscalQuarterRange('2026-09-23', DEFAULT_FISCAL_YEAR), { from: '2026-07-01', to: '2026-09-30' });
});

// ═══ الفترة والإزاحة ═══

test('resolvePeriodRange يطابق resolveReportPeriod لكل وضع', () => {
  assert.deepEqual(resolvePeriodRange(stateOf('trial-balance', { mode: 'month', from: '2026-09-23' })), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(resolvePeriodRange(stateOf('trial-balance', { mode: 'quarter', from: '2026-09-23' })), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(resolvePeriodRange(stateOf('trial-balance', { mode: 'fiscalYear', from: '2026-09-23' }), FY_MARCH), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(resolvePeriodRange(stateOf('trial-balance', { mode: 'custom', from: '2026-02-05', to: '2026-04-09' })), { from: '2026-02-05', to: '2026-04-09' });
  // «حتى تاريخ» يُعرض للمستخدم يوماً واحداً؛ امتداده إلى بداية السنة المالية شأن الخادم (§7.4)
  assert.deepEqual(resolvePeriodRange(stateOf('balance-sheet', { mode: 'asOf', to: '2026-09-23' })), { from: '2026-09-23', to: '2026-09-23' });
  // مدى مقلوب لا يرمي: يُرتَّب (والخادم يرفض المقلوب بـ400 فلا يُرسَل أصلاً)
  assert.deepEqual(resolvePeriodRange(stateOf('trial-balance', { mode: 'custom', from: '2026-04-09', to: '2026-02-05' })), { from: '2026-02-05', to: '2026-04-09' });
});

test('السابق والتالي يزيحان بطول الوضع، والرجوع يعيد الحالة', () => {
  const month = stateOf('trial-balance', { mode: 'month', from: '2026-03-15' });
  assert.equal(shiftReportPeriod(month, -1).from, '2026-02-01');
  assert.equal(shiftReportPeriod(month, 1).from, '2026-04-01');

  const quarter = stateOf('trial-balance', { mode: 'quarter', from: '2026-05-10' });
  assert.equal(shiftReportPeriod(quarter, 1).from, '2026-08-10');
  assert.equal(shiftReportPeriod(quarter, -1).from, '2026-02-10');

  const year = stateOf('income-statement', { mode: 'fiscalYear', from: '2026-05-10' });
  assert.equal(shiftReportPeriod(year, -1).from, '2025-05-10');
  // والإزاحة تقع في السنة المالية المجاورة أياً كانت نهايتها
  assert.deepEqual(
    fiscalYearRange(shiftReportPeriod(year, -1).from, FY_MARCH),
    { from: '2025-04-01', to: '2026-03-31' },
  );

  const custom = stateOf('trial-balance', { mode: 'custom', from: '2026-01-01', to: '2026-01-10' });
  const fwd = shiftReportPeriod(custom, 1);
  assert.deepEqual({ from: fwd.from, to: fwd.to }, { from: '2026-01-11', to: '2026-01-20' });
  const back = shiftReportPeriod(fwd, -1);
  assert.deepEqual({ from: back.from, to: back.to }, { from: '2026-01-01', to: '2026-01-10' });

  const asOf = stateOf('balance-sheet', { mode: 'asOf', from: '2026-03-31', to: '2026-03-31' });
  assert.equal(shiftReportPeriod(asOf, -1).to, '2026-02-28');
});

// ═══ الخصائص المتاحة ═══

test('reportFeatures: الميزانية «حتى تاريخ» وحدها، ودفتر الأستاذ بلا مقارنة ولا هرمية', () => {
  assert.deepEqual([...reportFeatures('balance-sheet').dateModes], ['asOf']);
  assert.ok(!reportFeatures('balance-sheet').dateModes.includes('custom'));
  assert.ok(reportFeatures('trial-balance').dateModes.includes('custom'));
  assert.ok(!reportFeatures('trial-balance').dateModes.includes('asOf'));
  assert.equal(reportFeatures('general-ledger').comparison, false);
  assert.equal(reportFeatures('general-ledger').hierarchy, false);
  assert.equal(reportFeatures('trial-balance').comparison, true);

  // ما لا يدعمه التقرير يُقصّ من الحالة بدل أن يُرسَل ثم يُهمَل بتنبيه
  const clamped = clampToFeatures(stateOf('general-ledger', { comparison: 'previousPeriod', hierarchy: true }), 'general-ledger');
  assert.equal(clamped.comparison, null);
  assert.equal(clamped.hierarchy, false);
});

test('الفترة الافتراضية لكل تقرير كما في defaultDateFilter', () => {
  assert.equal(defaultDateMode('balance-sheet'), 'asOf');
  assert.equal(defaultDateMode('income-statement'), 'fiscalYear');
  assert.equal(defaultDateMode('trial-balance'), 'month');
  assert.equal(defaultDateMode('general-ledger'), 'month');
  assert.equal(defaultDateMode('executive-summary'), 'month');
  const d = defaultReportOptions('trial-balance', TODAY);
  assert.deepEqual(
    { postedOnly: d.postedOnly, unit: d.unit, hierarchy: d.hierarchy, hideZero: d.hideZero, search: d.search, comparison: d.comparison },
    { postedOnly: true, unit: 1, hierarchy: false, hideZero: false, search: '', comparison: null },
  );
});

// ═══ القراءة من عنوان الصفحة ═══

test('parseReportOptions: رابط فارغ يعطي الافتراض، ورابط كامل يُقرأ كما هو', () => {
  const empty = parseReportOptions('', { reportKey: 'trial-balance', today: TODAY });
  assert.deepEqual(empty, defaultReportOptions('trial-balance', TODAY));

  const full = parseReportOptions(
    'mode=custom&from=2026-02-01&to=2026-02-28&comparison=sameLastYear&comparisonCount=3&postedOnly=false&unit=1000&hierarchy=true&hideZero=1&search=%20نقد%20',
    { reportKey: 'trial-balance', today: TODAY },
  );
  assert.deepEqual(full, {
    mode: 'custom', from: '2026-02-01', to: '2026-02-28',
    comparison: 'sameLastYear', comparisonCount: 3,
    postedOnly: false, unit: 1000, hierarchy: true, hideZero: true,
    search: ' نقد ', accounts: [],
  });
});

test('parseReportOptions: القيم غير الصالحة تعود للافتراض بلا خطأ', () => {
  const s = parseReportOptions(
    'mode=weekly&from=2026-13-40&comparison=next&comparisonCount=99&unit=7&hierarchy=maybe',
    { reportKey: 'trial-balance', today: TODAY },
  );
  assert.equal(s.mode, 'month');
  assert.equal(s.from, TODAY);
  assert.equal(s.comparison, null);
  assert.equal(s.comparisonCount, MAX_COMPARISON_COUNT, 'العدد يُقصّ إلى 12 لا يُرفض');
  assert.equal(s.unit, 1);
  assert.equal(s.hierarchy, false);
});

test('parseReportOptions: الميزانية تُقصّ إلى «حتى تاريخ» بلا أن يضيع تاريخ الرابط', () => {
  const s = parseReportOptions('mode=custom&from=2026-05-05&to=2026-06-30', { reportKey: 'balance-sheet', today: TODAY });
  assert.equal(s.mode, 'asOf');
  // ترتيب البدائل نفسه الذي في resolveDateFilter: asOf ?? to ?? from
  assert.equal(s.to, '2026-06-30');
  assert.equal(s.from, '2026-06-30', 'المرساة هي التاريخ نفسه فلا يضلّل «السابق/التالي»');
  assert.equal(parseReportOptions('asOf=2026-04-01&to=2026-06-30', { reportKey: 'balance-sheet', today: TODAY }).to, '2026-04-01');
});

test('parseReportOptions: includeDrafts يتقدّم على postedOnly كما في normalizeReportOptions', () => {
  assert.equal(parseReportOptions('includeDrafts=true', { reportKey: 'trial-balance', today: TODAY }).postedOnly, false);
  assert.equal(parseReportOptions('includeDrafts=false&postedOnly=false', { reportKey: 'trial-balance', today: TODAY }).postedOnly, true);
  assert.equal(parseReportOptions('postedOnly=false', { reportKey: 'trial-balance', today: TODAY }).postedOnly, false);
});

test('parseReportOptions: يقبل `account` المفرد (رابط التعمّق) و`accounts` معاً بلا تكرار', () => {
  const s = parseReportOptions('account=a1,a2&accounts=a2,a3', { reportKey: 'general-ledger', today: TODAY });
  assert.deepEqual(s.accounts, ['a1', 'a2', 'a3']);
  assert.deepEqual(parseReportOptions('account=%20%20', { reportKey: 'general-ledger', today: TODAY }).accounts, []);
});

// ═══ معاملات النقطة والرابط ═══

test('reportQueryParams: أسماء معاملات النقطة، وما ساوى الافتراض لا يُرسَل', () => {
  const base = reportQueryParams(stateOf('trial-balance', { mode: 'month', from: '2026-09-23' }));
  assert.deepEqual(base, { mode: 'month', from: '2026-09-23' }, 'الافتراضات لا تُرسَل');

  const full = reportQueryParams(stateOf('trial-balance', {
    mode: 'custom', from: '2026-02-01', to: '2026-02-28',
    comparison: 'previousPeriod', comparisonCount: 20,
    postedOnly: false, unit: 1_000_000, hierarchy: true, hideZero: true, search: '  نقد  ', accounts: ['a1', 'a2'],
  }));
  assert.deepEqual(full, {
    mode: 'custom', from: '2026-02-01', to: '2026-02-28',
    comparison: 'previousPeriod', comparisonCount: '12',
    postedOnly: 'false', unit: '1000000', hierarchy: 'true', hideZero: 'true',
    search: 'نقد', accounts: 'a1,a2',
  });

  // «حتى تاريخ» يُرسَل بـ`asOf` (مرادف `to` في §7.4) والمرساة لا تُرسَل
  assert.deepEqual(reportQueryParams(stateOf('balance-sheet', { mode: 'asOf', from: '2026-09-23', to: '2026-09-23' })), { mode: 'asOf', asOf: '2026-09-23' });
  // المدى المقلوب يُرتَّب قبل الإرسال فلا يرد الخادم 400 INVALID_RANGE
  assert.deepEqual(
    reportQueryParams(stateOf('trial-balance', { mode: 'custom', from: '2026-04-09', to: '2026-02-05' })),
    { mode: 'custom', from: '2026-02-05', to: '2026-04-09' },
  );
  // المعاملات الإضافية للتقرير (RPT‑14 مثلاً) تُضاف كما هي
  assert.equal(reportQueryParams(stateOf('income-statement'), { showZero: 'true' }).showZero, 'true');
});

test('الرابط يحمل `account` مفرداً، والذهاب والعودة لا يغيّران الحالة', () => {
  const s = stateOf('general-ledger', { mode: 'custom', from: '2026-02-01', to: '2026-02-28', accounts: ['a1'], postedOnly: false, unit: 1000 });
  const sp = reportSearchParams(s);
  assert.equal(sp.account, 'a1');
  assert.equal(sp.accounts, undefined, 'لا يحمل الرابط الاسمين لشيء واحد');
  assert.deepEqual(parseReportOptions(reportSearchString(s), { reportKey: 'general-ledger', today: TODAY }), s);

  // ومرتّب المفاتيح فيتساوى رابطان لحالة واحدة
  assert.equal(reportSearchString(s), reportSearchString({ ...s }));
  assert.equal(reportSearchString(stateOf('trial-balance', { mode: 'month', from: '2026-09-01' })), 'from=2026-09-01&mode=month');
});

test('رابط التعمّق يحمل mode=custom — بدونه يقرأ دفتر الأستاذ `from` مرساةَ شهر', () => {
  const href = generalLedgerHref('acc-1', { from: '2026-02-01', to: '2026-02-28' });
  assert.ok(href.startsWith('/app/ledger/reports/general-ledger?'), href);
  const q = new URLSearchParams(href.split('?')[1]);
  assert.equal(q.get('account'), 'acc-1');
  assert.equal(q.get('mode'), 'custom');
  assert.equal(q.get('from'), '2026-02-01');
  assert.equal(q.get('to'), '2026-02-28');
  assert.equal(q.get('postedOnly'), null, 'المرحّلة فقط هي الافتراض فلا تُكتب');
  assert.equal(new URLSearchParams(generalLedgerHref('a', { from: '2026-01-01', to: '2026-01-31' }, { postedOnly: false }).split('?')[1]).get('postedOnly'), 'false');
  assert.equal(moveHref('mv-9'), '/app/ledger/entries/mv-9');

  // والرابط يُقرأ حالةً كاملة في صفحة دفتر الأستاذ
  const s = parseReportOptions(href.split('?')[1], { reportKey: 'general-ledger', today: TODAY });
  assert.deepEqual({ mode: s.mode, from: s.from, to: s.to, accounts: s.accounts }, { mode: 'custom', from: '2026-02-01', to: '2026-02-28', accounts: ['acc-1'] });
});

// ═══ العرض: الوحدة والنسبة ═══

test('toMilli يقرأ نصّ الملّي بلا فقد دقة، وغير الصالح صفر', () => {
  assert.equal(toMilli('610001090'), 610001090n);
  assert.equal(toMilli(' -7000000 '), -7000000n);
  assert.equal(toMilli('9007199254740993000'), 9007199254740993000n, 'فوق Number.MAX_SAFE_INTEGER بلا فقد');
  assert.equal(toMilli(null), 0n);
  assert.equal(toMilli(undefined), 0n);
  assert.equal(toMilli('12.5'), 0n, 'الملّي عدد صحيح: العشري ليس منه');
  assert.equal(toMilli('abc'), 0n);
  assert.equal(toMilli(1234), 1234n);
  assert.equal(toMilli(Number.NaN), 0n);
});

test('milliToUnitString: القسمة على وحدة العرض بـBigInt بلا عائم (RPT‑06)', () => {
  assert.equal(unitScaleDigits(1), 3);
  assert.equal(unitScaleDigits(1000), 6);
  assert.equal(unitScaleDigits(1_000_000), 9);
  // 610,001.09 ريالاً = 610001090 ملّي
  assert.equal(milliToUnitString('610001090', 1), '610001.090');
  assert.equal(milliToUnitString('610001090', 1000), '610.001090');
  assert.equal(milliToUnitString('610001090', 1_000_000), '0.610001090');
  assert.equal(milliToUnitString('-1234567', 1), '-1234.567');
  assert.equal(milliToUnitString('-1234567', 1000), '-1.234567');
  assert.equal(milliToUnitString(0, 1), '0.000');
  assert.equal(milliToUnitString(null, 1_000_000), '0.000000000');
  assert.equal(unitSuffixKey(1), null);
  assert.equal(unitSuffixKey(1000), 'thousands');
  assert.equal(unitSuffixKey(1_000_000), 'millions');
});

test('percentChange نسخةٌ من دالّة الخادم: منزلتان، نصف‑لأعلى بعيداً عن الصفر، والأساس صفراً null', () => {
  assert.equal(percentChange(1000n, 2000n), 50);
  assert.equal(percentChange(-1000n, 2000n), -50);
  assert.equal(percentChange(1n, 3n), 33.33);
  assert.equal(percentChange(2n, 3n), 66.67, 'نصف‑لأعلى');
  assert.equal(percentChange(-2n, 3n), -66.67, 'بعيداً عن الصفر');
  assert.equal(percentChange(5n, 0n), null, 'لا قسمة على صفر ولا «∞٪»');
  // الأساس السالب: المقدار المطلق مقاماً فتبقى إشارة النسبة إشارةَ الفرق
  assert.equal(percentChange(1000n, -2000n), 50);

  // changePercent = (الأساسي − المقارَن) ÷ |المقارَن| كما في `cells[i].percent`
  assert.equal(changePercent('3000', '2000'), 50);
  assert.equal(changePercent('2000', '3000'), -33.33);
  assert.equal(changePercent('2000', '2000'), 0);
  assert.equal(changePercent('2000', '0'), null);
});

test('formatPercent: علامة ومنزلتان وشرطة حين لا نسبة', () => {
  assert.equal(formatPercent(12.5), '+12.50٪');
  assert.equal(formatPercent(-3.4), '-3.40٪');
  assert.equal(formatPercent(0), '0.00٪');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatPercent(Number.POSITIVE_INFINITY), '—');
});
