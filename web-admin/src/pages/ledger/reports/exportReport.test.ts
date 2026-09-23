import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_EXPORT_CAPS,
  buildReportTable, dedupeLabels, exportErrorInfo, exportErrorText, exportRequestBody, formulaSafe,
  indentText, ledgerLineNote, makeAmountFormatter, milliToUnits, optionsLabel, periodLabel,
  reportFileName, reportMetaRows, reportTitle, retryAfterSeconds, tableToPdfRows, tableToSheet, unitLabel, waitLabel,
  type ReportExportData,
} from './exportReport';

/**
 * حرّاس التصدير (DESIGN.md §7.1 البندان 5 و6، RPT‑01).
 *
 * كل ما هنا **صرف**: لا شبكة ولا DOM ولا قاعدة. ما يحرسه:
 * - معاملات النقطة: خيارات الشاشة نفسها بلا ترقيم (التصدير بلا صفحات أصلاً).
 * - **تحييد الصيغ**: خليّة نصّية تبدأ بـ`= + - @` لا تصير معادلة في Excel.
 * - المبالغ خلايا **رقمية** بمنازل العملة، محوَّلة من الملّي بوحدة العرض (RPT‑06).
 * - رسالة 422 `LEDGER_EXPORT_TOO_LARGE` و429 بالعربية وبمقترحٍ عملي.
 * - شكل الجدول لكل تقرير كما يعيده الخادم (لا أعمدة مخترعة).
 */

const tr = (ar: string) => ar;

const settings = { currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh' };
const baseOptions = {
  dateFilter: { mode: 'month', from: '2026-01-01', to: '2026-01-31' },
  comparison: null,
  postedOnly: true,
  includeDrafts: false,
  unit: 1,
  hierarchy: false,
  hideZero: false,
  journals: [] as string[],
  analytic: [] as string[],
  salesReps: [] as string[],
  search: '',
  breakdown: 'none',
  accounts: [] as string[],
  partners: [] as string[],
};

const makeData = (over: Partial<ReportExportData> & { reportKey: string }): ReportExportData => ({
  period: { from: '2026-01-01', to: '2026-01-31', fyStart: '2026-01-01' },
  options: { ...baseOptions },
  settings: { ...settings },
  mode: 'AGGREGATE',
  rows: [],
  totals: {},
  comparison: null,
  lineCount: 0,
  warnings: [],
  format: 'xlsx',
  cap: REPORT_EXPORT_CAPS.xlsx,
  ...over,
} as ReportExportData);

// ═══ معاملات النقطة ═══

test('جسم الطلب يحمل خيارات الشاشة ويُسقط الترقيم والفراغ ويضيف الصيغة', () => {
  const body = exportRequestBody(
    {
      mode: 'custom', from: '2026-01-01', to: '2026-03-31', search: '',
      postedOnly: true, unit: 1000, accounts: ['a1', '', 'a2'], journals: [],
      page: 3, pageSize: 500, cursor: 'xyz', format: 'pdf', nothing: null, gone: undefined,
    },
    'xlsx',
  );
  assert.deepEqual(body, {
    mode: 'custom', from: '2026-01-01', to: '2026-03-31',
    postedOnly: true, unit: 1000, accounts: ['a1', 'a2'], format: 'xlsx',
  });
  assert.equal('page' in body, false, 'التصدير بلا ترقيم (RPT‑01)');
  assert.equal('cursor' in body, false, 'ولا تحميل كسول');
});

// ═══ تحييد الصيغ (§7.1 البند 5) ═══

test('خلية تبدأ بمحرف صيغة تُسبق بفاصلة عليا', () => {
  for (const s of ['=SUM(A1:A9)', '+1+1', '-2+3', '@SUM', '  =cmd|/c calc']) {
    assert.equal(formulaSafe(s).startsWith("'"), true, `لم يُحيَّد: ${s}`);
    assert.equal(formulaSafe(s).slice(1), s, 'النصّ الأصلي محفوظ كاملاً');
  }
});

test('النصوص العادية والعربية لا تُمسّ', () => {
  for (const s of ['113001', 'المدينون', 'الرصيد الافتتاحي', '', 'A-1']) {
    assert.equal(formulaSafe(s), s);
  }
});

// ═══ المبالغ (RPT‑06) ═══

test('الملّي يتحوّل إلى وحدة العرض', () => {
  assert.equal(milliToUnits('610001090', 1), 610001.09);
  assert.equal(milliToUnits('610001090', 1000), 610.00109);
  assert.equal(milliToUnits('-7000000', 1), -7000);
  assert.equal(milliToUnits(0, 1), 0);
});

test('مبلغ غائب أو فاسد يعطي خلية فارغة لا صفراً كاذباً', () => {
  assert.equal(milliToUnits(null, 1), null);
  assert.equal(milliToUnits(undefined, 1), null);
  assert.equal(milliToUnits('', 1), null);
  assert.equal(milliToUnits('abc', 1), null);
});

test('وحدة غير معروفة تسقط إلى الآحاد', () => {
  assert.equal(milliToUnits('1000', 7 as number), 1);
});

// ═══ أدوات العرض ═══

test('العناوين المكرّرة تُميَّز فلا يبتلع عمودٌ عموداً في ورقة XLSX', () => {
  assert.deepEqual(dedupeLabels(['مدين', 'دائن', 'مدين', 'مدين']), ['مدين', 'دائن', 'مدين (2)', 'مدين (3)']);
});

test('الإزاحة تنمو بالعمق وتقف عند سقف', () => {
  assert.equal(indentText(0, 'الأصول'), 'الأصول');
  assert.ok(indentText(2, 'نقد').length > indentText(1, 'نقد').length);
  assert.equal(indentText(50, 'x'), indentText(8, 'x'));
});

test('وسم الوحدة عربي ولا يظهر عند الآحاد', () => {
  assert.equal(unitLabel(1, tr), '');
  assert.equal(unitLabel(1000, tr), 'بالآلاف');
  assert.equal(unitLabel(1_000_000, tr), 'بالملايين');
});

// ═══ الأخطاء ═══

test('Retry-After: ثوانٍ أو تاريخ HTTP أو لا شيء', () => {
  assert.equal(retryAfterSeconds('120'), 120);
  assert.equal(retryAfterSeconds(45), 45);
  const now = new Date('2026-09-23T10:00:00Z');
  assert.equal(retryAfterSeconds('Wed, 23 Sep 2026 10:01:00 GMT', now), 60);
  assert.equal(retryAfterSeconds('غداً'), null);
  assert.equal(retryAfterSeconds(undefined), null);
});

test('المهلة تُقرأ بالثواني ثم بالدقائق', () => {
  assert.equal(waitLabel(30, tr), 'بعد 30 ثانية');
  assert.equal(waitLabel(120, tr), 'بعد 2 دقيقة');
  assert.equal(waitLabel(null, tr), 'بعد قليل');
  assert.equal(waitLabel(0, tr), 'بعد قليل');
});

test('422 سقف التصدير: عربي، بالعدد والسقف، ويقترح XLSX حين كان PDF', () => {
  const msg = exportErrorText({ status: 422, code: 'LEDGER_EXPORT_TOO_LARGE', lines: 7321, cap: 5000, format: 'pdf' }, tr);
  assert.match(msg, /7321/);
  assert.match(msg, /5000/);
  assert.match(msg, /XLSX/);
  assert.match(msg, /ضيّق الفترة/);
});

test('422 سقف التصدير على XLSX لا يقترح XLSX مرة أخرى', () => {
  const msg = exportErrorText({ status: 422, code: 'LEDGER_EXPORT_TOO_LARGE', lines: 60000, cap: 50000, format: 'xlsx' }, tr);
  assert.equal(/XLSX/.test(msg), false);
  assert.match(msg, /ضيّق الفترة أو الحسابات/);
});

test('429 يعرض مهلة صريحة لا «حدث خطأ»', () => {
  assert.match(exportErrorText({ status: 429, retryAfter: 90 }, tr), /2 دقيقة/);
  assert.match(exportErrorText({ status: 429, code: 'RATE_LIMITED', retryAfter: null }, tr), /بعد قليل/);
});

test('رسالة الخادم العربية تُحترم، وبلا رسالة يظهر نصّ افتراضي', () => {
  assert.equal(exportErrorText({ status: 422, code: 'LEDGER_RANGE_TOO_LARGE', message: 'المدى كبير' }, tr), 'المدى كبير');
  assert.equal(exportErrorText({ status: 500 }, tr), 'تعذّر تصدير التقرير');
  assert.equal(exportErrorText({ status: 403, message: 'لا تملك صلاحية الوصول لهذا القسم' }, tr), 'لا تملك صلاحية الوصول لهذا القسم');
});

test('قراءة جسم خطأ الدفاتر: التفاصيل منشورة بجانب الرمز وتحت details معاً', () => {
  const info = exportErrorInfo(
    {
      response: {
        status: 422,
        headers: { 'retry-after': '30' },
        data: {
          success: false, code: 'LEDGER_EXPORT_TOO_LARGE', message: 'التصدير يتجاوز الحد المسموح',
          lines: 9000, cap: 5000, format: 'pdf', details: { lines: 9000, cap: 5000 },
        },
      },
    },
    'pdf',
  );
  assert.equal(info.code, 'LEDGER_EXPORT_TOO_LARGE');
  assert.equal(info.lines, 9000);
  assert.equal(info.cap, 5000);
  assert.equal(info.format, 'pdf');
  assert.equal(info.retryAfter, 30);
});

test('خطأ بلا ردّ (انقطاع الشبكة) لا ينهار', () => {
  const info = exportErrorInfo(new Error('Network Error'), 'xlsx');
  assert.equal(info.status, undefined);
  assert.equal(exportErrorText(info, tr), 'تعذّر تصدير التقرير');
});

// ═══ ميزان المراجعة (§7.2) ═══

const tbCell = (o: string, d: string, c: string, e: string, percent: number | null = null) =>
  ({ openingMilli: o, debitMilli: d, creditMilli: c, endingMilli: e, deltaMilli: null, percent });

const tbData = (): ReportExportData => makeData({
  reportKey: 'trial-balance',
  columnLabels: { opening: 'الرصيد الافتتاحي', debit: 'مدين', credit: 'دائن', ending: 'الرصيد النهائي' },
  columns: [{ from: '2026-01-01', to: '2026-01-31', fyStart: '2026-01-01', kind: 'base', index: 0 }],
  rows: [
    { id: 'group:1', kind: 'group', accountId: null, code: '1', name: 'الأصول', level: 0, cells: [tbCell('0', '1000000', '0', '1000000')] },
    { id: 'a1', kind: 'account', accountId: 'a1', code: '111001', name: 'الصندوق', level: 1, cells: [tbCell('0', '1000000', '0', '1000000')] },
  ],
  totals: [tbCell('0', '1000000', '1000000', '0')],
  lineCount: 2,
});

test('ميزان المراجعة: أعمدته من الخادم، وصفّ إجمالي، والمبالغ أرقام', () => {
  const t = buildReportTable(tbData(), tr);
  assert.deepEqual(t.columns.map((c) => c.label), [
    'المستوى', 'الرمز', 'الحساب', 'الرصيد الافتتاحي', 'مدين', 'دائن', 'الرصيد النهائي',
  ]);
  assert.equal(t.rows.length, 3, 'صفّان + الإجمالي');
  assert.deepEqual(t.rows[1].cells, [1, '111001', 'الصندوق', 0, 1000, 0, 1000]);
  assert.equal(t.rows[2].cells[2], 'الإجمالي');
  assert.equal(t.rows[2].strong, true);
});

test('ميزان المراجعة بالمقارنة: عمود ٪ للمقارنة وحدها وعناوين مميَّزة بفترتها', () => {
  const d = tbData();
  d.columns = [
    { from: '2026-01-01', to: '2026-01-31', fyStart: '2026-01-01', kind: 'base', index: 0 },
    { from: '2025-12-01', to: '2025-12-31', fyStart: '2025-01-01', kind: 'comparison', index: 1 },
  ];
  (d.rows as Record<string, unknown>[]).forEach((r) => {
    (r.cells as unknown[]).push(tbCell('0', '500000', '0', '500000', 100));
  });
  (d.totals as unknown[]).push(tbCell('0', '500000', '500000', '0', 100));
  const t = buildReportTable(d, tr);
  const labels = t.columns.map((c) => c.label);
  assert.equal(labels.filter((l) => l.startsWith('مدين')).length, 2);
  assert.ok(labels.includes('مدين (2025-12-01 — 2025-12-31)'), 'عمود المقارنة موسوم بفترته');
  assert.ok(labels.includes('٪ التغيّر (2025-12-01 — 2025-12-31)'));
  assert.equal(t.rows[1].cells[t.columns.length - 1], 100, '٪ التغيّر يُنقل كما هو لا كمبلغ');
});

// ═══ قائمة الدخل (§7.3) ═══

const isData = (): ReportExportData => makeData({
  reportKey: 'income-statement',
  rows: [
    {
      key: 'revenue', label: 'الإيرادات', amountMilli: '610001090', total: false, groups: [],
      accounts: [{ accountId: 'i1', code: '411001', name: 'المبيعات', amountMilli: '610001090' }],
    },
    {
      key: 'operatingExpenses', label: 'نفقات التشغيل', amountMilli: '198735240', total: false,
      accounts: [],
      groups: [{
        key: 'depreciation', label: 'الإهلاك', amountMilli: '47080390',
        accounts: [{ accountId: 'e9', code: '611009', name: 'إهلاك السيارات', amountMilli: '47080390' }],
      }],
    },
    { key: 'netProfit', label: 'صافي الربح', amountMilli: '104186330', total: true, accounts: [], groups: [] },
  ],
  totals: { netProfitMilli: '104186330' },
  lineCount: 5,
});

test('قائمة الدخل: السطر ثم سطره الفرعي ثم حساباته بعمق متدرّج، والتسميات من الخادم', () => {
  const t = buildReportTable(isData(), tr);
  assert.deepEqual(t.rows.map((r) => [r.level, r.cells[2]]), [
    [0, 'الإيرادات'],
    [1, 'المبيعات'],
    [0, 'نفقات التشغيل'],
    [1, 'الإهلاك'],
    [2, 'إهلاك السيارات'],
    [0, 'صافي الربح'],
  ]);
  assert.equal(t.rows[0].cells[3], 610001.09);
  assert.equal(t.rows[5].strong, true, 'سطر المجموع عريض');
});

test('قائمة الدخل بالمقارنة: عمود مبلغ لكل فترة، مطابقٌ بمفتاح السطر لا بترتيبه', () => {
  const d = isData();
  d.comparison = { kind: 'previousPeriod', count: 1, periods: [{ from: '2025-01-01', to: '2025-12-31', fyStart: '2025-01-01' }] };
  d.comparisonColumns = [{
    lines: [
      { key: 'netProfit', label: 'صافي الربح', amountMilli: '50000000', total: true, accounts: [], groups: [] },
      { key: 'revenue', label: 'الإيرادات', amountMilli: '300000000', total: false, groups: [], accounts: [] },
    ],
  }];
  const t = buildReportTable(d, tr);
  assert.deepEqual(t.columns.map((c) => c.label).slice(3), ['المبلغ', 'المبلغ (2025-01-01 — 2025-12-31)']);
  assert.equal(t.rows[0].cells[4], 300000, 'الإيرادات من عمود المقارنة');
  assert.equal(t.rows[5].cells[4], 50000, 'صافي الربح من عمود المقارنة');
  assert.equal(t.rows[1].cells[4], null, 'حسابٌ لا مقابل له في المقارنة يبقى فارغاً لا صفراً');
});

// ═══ الميزانية العمومية (§7.4) ═══

const bsNode = (key: string, label: string, amountMilli: string, children: unknown[] = [], accounts: unknown[] = [], total = false) =>
  ({ key, label, amountMilli, total, children, accounts });

test('الميزانية: الشجرة مسطَّحة بعمقها ثم سطر الالتزامات + حقوق الملكية', () => {
  const d = makeData({
    reportKey: 'balance-sheet',
    asOf: '2026-03-31',
    options: { ...baseOptions, dateFilter: { mode: 'asOf', from: '2026-03-31', to: '2026-03-31' } },
    rows: [
      bsNode('assets', 'الأصول', '542850610', [
        bsNode('currentAssets', 'الأصول المتداولة', '7315000', [], [
          { accountId: 'c1', code: '111001', name: 'الصندوق', amountMilli: '7315000' },
        ]),
      ], [], true),
    ],
    totals: { totalLine: bsNode('liabilitiesAndEquity', 'الالتزامات + حقوق الملكية', '542850610', [], [], true) },
  });
  const t = buildReportTable(d, tr);
  assert.deepEqual(t.rows.map((r) => [r.level, r.cells[2]]), [
    [0, 'الأصول'],
    [1, 'الأصول المتداولة'],
    [2, 'الصندوق'],
    [0, 'الالتزامات + حقوق الملكية'],
  ]);
  assert.equal(t.rows[0].cells[3], 542850.61);
  assert.equal(periodLabel(d, tr), 'اعتباراً من 2026-03-31');
  assert.equal(reportFileName(d, tr), 'الميزانية العمومية-2026-03-31');
});

// ═══ دفتر الأستاذ العام (§7.5) ═══

const glData = (): ReportExportData => makeData({
  reportKey: 'general-ledger',
  rows: [{
    account: { id: 'a1', code: '113001', name: 'المدينون' },
    openingMilli: '1000000', carriedForwardMilli: '1000000',
    debitMilli: '500000', creditMilli: '200000', endingMilli: '1300000',
    closingExcluded: false,
    lines: [
      {
        date: '2026-01-05', originalDate: null, moveNumber: 'SAL/2026/0001',
        journalCode: 'SAL', journalName: 'المبيعات', partnerName: 'مؤسسة الوفاء', salesRepName: 'خالد',
        label: 'فاتورة', debitMilli: '500000', creditMilli: '0', runningMilli: '1500000',
      },
      {
        date: '2026-01-09', originalDate: '2025-12-30', shifted: true, draft: true, moveNumber: null,
        journalCode: null, journalName: 'عام', partnerName: null, salesRepName: null,
        label: null, debitMilli: '0', creditMilli: '200000', runningMilli: '1300000',
      },
    ],
  }],
  totals: { debitMilli: '500000', creditMilli: '200000', endingMilli: '1300000', lineCount: 2 },
  lineCount: 4,
});

test('دفتر الأستاذ: أعمدة §7.5 بالترتيب الموثّق', () => {
  const t = buildReportTable(glData(), tr);
  assert.deepEqual(t.columns.map((c) => c.label), [
    'المستوى', 'التاريخ', 'الرقم', 'الدفتر', 'الشريك', 'المندوب', 'البيان', 'مدين', 'دائن', 'رصيد جارٍ',
  ]);
});

test('دفتر الأستاذ: صفّ افتتاحي مُرحَّل لكل حساب يتكرر في PDF، ثم إجمالي الحساب فالإجمالي العام', () => {
  const t = buildReportTable(glData(), tr);
  assert.equal(t.rows[0].carry, true, 'الافتتاحي هو الصفّ المُرحَّل (§7.1)');
  assert.match(String(t.rows[0].cells[6]), /113001 المدينون/, 'يحمل اسم الحساب فيُقرأ حين يتكرر');
  assert.equal(t.rows[0].cells[9], 1000, 'الرصيد المُرحَّل');
  assert.equal(t.rows[3].cells[6], 'الإجمالي — 113001');
  assert.equal(t.rows[4].cells[6], 'الإجمالي العام');
  assert.equal(t.rows[4].cells[9], 1300);
});

test('وسوم السطر: مسودة ومُزاح تظهر في البيان ولا تُبتلع', () => {
  const t = buildReportTable(glData(), tr);
  assert.equal(t.rows[1].cells[6], 'فاتورة');
  assert.match(String(t.rows[2].cells[6]), /مسودة/);
  assert.match(String(t.rows[2].cells[6]), /مُزاح من 2025-12-30/);
});

test('سطر بلا بيان ولا وسوم يبقى فارغاً', () => {
  assert.equal(ledgerLineNote({ label: null } as never, tr), '');
  assert.equal(ledgerLineNote({ label: 'بيان' } as never, tr), 'بيان');
});

test('صفّ بنود الإقفال المفصولة يظهر بتسميته المحاسبية حين فُصلت', () => {
  const d = glData();
  const s = (d.rows as Record<string, unknown>[])[0];
  s.closingExcluded = true;
  s.closingDebitMilli = '0';
  s.closingCreditMilli = '900000';
  const t = buildReportTable(d, tr);
  const row = t.rows.find((r) => r.cells[6] === 'منقول إلى أرباح سنوات سابقة');
  assert.ok(row, 'صفّ الإقفال موجود');
  assert.equal(row?.cells[8], 900);
});

// ═══ الملخّص التنفيذي (ORPT‑09) ═══

test('الملخّص التنفيذي: بطاقة المال بالملّي والنسبة بقيمتها، وغير المعرَّفة فارغة', () => {
  const d = makeData({
    reportKey: 'executive-summary',
    rows: [
      { key: 'revenue', kind: 'money', label: 'الإيراد', amountMilli: '610001090', previousMilli: '300000000', changeMilli: '310001090', changePct: 103.33 },
      { key: 'dso', kind: 'days', label: 'DSO', decimals: 2, value: 41.5, defined: true, previousValue: 38, changeValue: 3.5 },
      { key: 'currentRatio', kind: 'ratio', label: 'النسبة الجارية', decimals: 2, value: 0, defined: false, previousValue: null, changeValue: null },
    ],
  });
  const t = buildReportTable(d, tr);
  assert.deepEqual(t.rows[0].cells, [0, 'الإيراد', 610001.09, 300000, 310001.09, 103.33]);
  assert.deepEqual(t.rows[1].cells, [0, 'DSO', 41.5, 38, 3.5, null]);
  assert.equal(t.rows[2].cells[2], null, 'نسبة غير معرَّفة لا تُطبع صفراً');
});

// ═══ ورقة XLSX ═══

test('ورقة XLSX: الترويسة أولاً، ثم فاصل، ثم البيانات؛ والمبالغ خلايا رقمية', () => {
  const data = tbData();
  const table = buildReportTable(data, tr);
  const meta = reportMetaRows({ data, tr, company: 'فيلد سيلز', now: new Date('2026-09-23T07:00:00Z'), locale: 'en-GB' });
  const sheet = tableToSheet({ table, meta, sheetName: reportTitle(data.reportKey, tr), decimals: 2 });
  assert.equal(sheet.name, 'ميزان المراجعة');
  assert.equal(sheet.rows[0]['المستوى'], 'الشركة');
  assert.equal(sheet.rows[0]['الرمز'], 'فيلد سيلز');
  const labels = sheet.rows.map((r) => r['المستوى']);
  assert.ok(labels.includes('الفترة'));
  assert.ok(labels.includes('الخيارات'));
  assert.ok(labels.includes('تاريخ الطباعة'));
  const dataRows = sheet.rows.slice(meta.length + 1);
  assert.equal(dataRows.length, table.rows.length);
  assert.equal(typeof dataRows[1]['مدين'], 'number', 'مبلغ = خلية رقمية لا نصّ');
  assert.equal(dataRows[1]['مدين'], 1000);
  assert.equal(dataRows[1]['المستوى'], 1, 'المستوى عدد صحيح لا يُقرَّب كمبلغ');
});

test('ورقة XLSX: الشجرة مُزاحة في عمود الاسم، وكل خلية نصّية محيَّدة', () => {
  const data = tbData();
  (data.rows as Record<string, unknown>[])[1].name = '=cmd|/c calc';
  const table = buildReportTable(data, tr);
  const sheet = tableToSheet({ table, meta: [], sheetName: 'ورقة', decimals: 2 });
  const cell = String(sheet.rows[1]['الحساب']);
  assert.equal(cell.startsWith("'"), true, 'اسم حساب خبيث لا يصير معادلة');
  assert.match(cell, / /, 'مُزاح بعمقه');
  assert.equal(String(sheet.rows[0]['الحساب']), 'الأصول', 'الجذر بلا إزاحة');
});

test('ورقة XLSX: مبلغ يُقرَّب بمنازل العملة', () => {
  const data = tbData();
  (data.rows as Record<string, unknown>[])[1].cells = [tbCell('0', '1000555', '0', '1000555')];
  const sheet = tableToSheet({ table: buildReportTable(data, tr), meta: [], sheetName: 'ورقة', decimals: 2 });
  assert.equal(sheet.rows[1]['مدين'], 1000.56);
  const three = tableToSheet({ table: buildReportTable(data, tr), meta: [], sheetName: 'ورقة', decimals: 3 });
  assert.equal(three.rows[1]['مدين'], 1000.555, 'عملات الثلاث منازل لا تفقد الفلس الثالث');
});

// ═══ صفوف PDF ═══

test('صفوف PDF: عمود «المستوى» يسقط، والأرقام تُنسَّق نصّاً، والمُرحَّل محفوظ', () => {
  const table = buildReportTable(glData(), tr);
  const out = tableToPdfRows({ table, formatAmount: makeAmountFormatter(2, 'en-US') });
  assert.deepEqual(out.columns.map((c) => c.label), [
    'التاريخ', 'الرقم', 'الدفتر', 'الشريك', 'المندوب', 'البيان', 'مدين', 'دائن', 'رصيد جارٍ',
  ]);
  assert.equal(out.columns[6].align, 'end', 'الأرقام تُحاذى يساراً');
  assert.equal(out.rows[0].carry, true);
  assert.equal(out.rows[0].cells[8], '1,000.00');
  assert.equal(out.rows[0].cells[6], '');
  assert.equal(out.rows[1].cells[5], ' فاتورة', 'سطور الحساب مُزاحة تحت صفّه الافتتاحي');
});

test('صفوف PDF: الإزاحة نصّية فلا تُزاح مرّتين', () => {
  const out = tableToPdfRows({ table: buildReportTable(isData(), tr), formatAmount: makeAmountFormatter(2, 'en-US') });
  assert.equal(out.rows.every((r) => r.level === 0), true);
  assert.match(String(out.rows[1].cells[1]), / المبيعات/);
});

// ═══ الترويسة واسم الملف ═══

test('سطر الخيارات يذكر ما يغيّر الأرقام ووسم «مفلتر، أبطأ»', () => {
  const d = tbData();
  d.options = { ...baseOptions, includeDrafts: true, postedOnly: false, unit: 1000, hideZero: true, search: 'نقد', journals: ['j1'] };
  d.mode = 'LINE_SCAN';
  const label = optionsLabel(d, tr);
  assert.match(label, /مع المسودات/);
  assert.match(label, /بالآلاف/);
  assert.match(label, /إخفاء الأصفار/);
  assert.match(label, /بحث: نقد/);
  assert.match(label, /مفلتر، أبطأ/);
});

test('اسم الملف يحمل التقرير ومداه بلا محارف تكسر الملفات', () => {
  assert.equal(reportFileName(tbData(), tr), 'ميزان المراجعة-2026-01-01_2026-01-31');
  const d = glData();
  d.options = { ...baseOptions, dateFilter: { mode: 'custom', from: '2026-01-01', to: '2026-12-31' } };
  assert.equal(/[\\/?*[\]:<>|"]/.test(reportFileName(d, tr)), false);
});

test('عنوان كل تقرير بالعربية ولا يعود رمزاً إنجليزياً', () => {
  for (const k of ['trial-balance', 'income-statement', 'balance-sheet', 'general-ledger', 'executive-summary']) {
    const title = reportTitle(k, tr);
    assert.equal(/[a-z-]{5,}/.test(title), false, `عنوان ${k} ليس عربياً: ${title}`);
  }
});
