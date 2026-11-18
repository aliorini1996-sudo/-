// «المحاسب الذكي AI» — أدوات قراءة الدفاتر (الحزمة A3، المواصفة §٣.٣).
//
// بلا قاعدة بيانات ولا شبكة ولا نموذج:
//   - تحويل الملّي ⇒ رقم (نصف-لأعلى بمنازل العملة).
//   - التحويل إلى AiReport من مخرجات **المحرّك نفسه** (STATEMENT_BUILDERS المُصدَّرة من المسار ثم reportJson) — أي شكل
//     ردّ GET /api/ledger/reports/:key حرفاً — لقائمة الدخل والميزانية والميزان والملخّص التنفيذي والمصروفات، ودفتر أستاذ.
//   - البوابة: لا أدوات بلا دفاتر مفعّلة أو بلا canViewLedger أو بلا محاسبة.
//   - القائمة البيضاء للمفاتيح (cash-flow/vat-return مرفوضة بلا لمس القاعدة، والمرادف profit-and-loss مقبول).
//   - دورة كاملة بقاعدة مقلَّدة (Proxy): التقرير يطابق بناء المحرّك الصرف، وكل استعلام محصور بـtenantId السياق
//     ولو حقن النموذج شركة أخرى في الوسائط، وسقف سطور الأستاذ يكتفي بالمجاميع.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_GL_MAX_LINES, AI_LEDGER_REPORT_KEYS, LEDGER_TOOL_NAMES, aiPeriodOf, buildLedgerReadTools, filterLookupAccounts,
  fmtAmount, isBankAccount, ledgerLineLabel, loadLedgerReport, mapBalanceSheet, mapExecutiveSummary, mapExpensesSummary,
  mapGeneralLedger, mapIncomeStatement, mapLedgerReport, mapTrialBalance, milliToNumber, ratioText, reportQueryOf,
  type LedgerReportJson, type LookupAccountRow,
} from '../services/aiAccountant/ledgerReadTools';
import type { AcctCtx, AiReport, Tool } from '../services/aiAccountant/context';
import { STATEMENT_BUILDERS, reportJson, statementExtras, type StatementKey } from '../routes/ledger/reports';
import { normalizeReportOptions, type AccountBalance, type ReportAccount, type ReportPeriod } from '../services/gl/reports/types';
import { reportAccountRoles } from '../services/gl/reports/incomeStatement';
import { zeroBalance } from '../services/gl/reports/balances';
import type { ReportDb, ReportSettings } from '../services/gl/reports/load';
import { toDbDate } from '../services/gl/dates';

// ═══ المتجهات: شهر أكتوبر 2026 لشركة واحدة ═══
// رأس مال 50,000 قبل السنة (نقداً) — مبيعات 30,000 (20,000 نقداً و10,000 آجلاً) — تكلفة 12,000 على المورد —
// إيجار 2,500 ووقود 800.125 ورواتب 4,000 نقداً. صافي الربح 10,699.875 ⇒ 10,699.88 بمنزلتين.

const T1 = 'T1';
const ACCOUNTS: (ReportAccount & { controlKind?: string | null; isActive?: boolean; nameEn?: string | null })[] = [
  { id: 'a-cash', code: '111001', name: 'الصندوق الرئيسي', nameI18n: null, type: 'asset_cash', controlKind: null },
  { id: 'a-petty', code: '111002', name: 'صندوق المصروفات النثرية', nameI18n: null, type: 'asset_cash', controlKind: null },
  { id: 'a-cust', code: '111003', name: 'عهدة تحصيلات المناديب', nameI18n: null, type: 'asset_cash', controlKind: 'CUSTODY' },
  { id: 'a-bank', code: '111101', name: 'البنك الرئيسي', nameI18n: null, type: 'asset_cash', controlKind: null },
  { id: 'a-ar', code: '113001', name: 'ذمم العملاء', nameI18n: null, type: 'asset_receivable', controlKind: 'AR' },
  { id: 'a-ap', code: '211001', name: 'الموردون', nameI18n: null, type: 'liability_payable', controlKind: 'AP' },
  { id: 'a-salp', code: '213001', name: 'رواتب مستحقة', nameI18n: null, type: 'liability_current', controlKind: null },
  { id: 'a-cap', code: '311001', name: 'رأس المال', nameI18n: null, type: 'equity', controlKind: null },
  { id: 'a-rev', code: '411001', name: 'المبيعات', nameI18n: null, type: 'income', controlKind: null },
  { id: 'a-cogs', code: '511001', name: 'تكلفة البضاعة المباعة', nameI18n: null, type: 'expense_direct_cost', controlKind: null },
  { id: 'a-fuel', code: '611003', name: 'الوقود', nameI18n: null, type: 'expense', controlKind: null },
  { id: 'a-sal', code: '621001', name: 'الرواتب والأجور', nameI18n: null, type: 'expense', controlKind: null },
  { id: 'a-rent', code: '621004', name: 'الإيجار', nameI18n: null, type: 'expense', controlKind: null },
  { id: 'a-old', code: '621099', name: 'مصروف مؤرشف', nameI18n: null, type: 'expense', controlKind: null, isActive: false },
];
const ENGINE_ACCOUNTS: ReportAccount[] = ACCOUNTS.map(({ id, code, name, nameI18n, type }) => ({ id, code, name, nameI18n, type }));

const b = (id: string, over: Partial<AccountBalance> = {}): AccountBalance => ({ ...zeroBalance(id), ...over });
/** أرصدة أكتوبر (وهي نفسها حركة السنة حتى 31 أكتوبر: لا حركة قبل أكتوبر) */
const BALANCES: AccountBalance[] = [
  b('a-cash', { openingMilli: 50_000_000n, preFyMilli: 50_000_000n, debitMilli: 20_000_000n, creditMilli: 7_300_125n }),
  b('a-ar', { debitMilli: 10_000_000n }),
  b('a-ap', { creditMilli: 12_000_000n }),
  b('a-cap', { openingMilli: -50_000_000n, preFyMilli: -50_000_000n }),
  b('a-rev', { creditMilli: 30_000_000n }),
  b('a-cogs', { debitMilli: 12_000_000n }),
  b('a-fuel', { debitMilli: 800_125n }),
  b('a-sal', { debitMilli: 4_000_000n }),
  b('a-rent', { debitMilli: 2_500_000n }),
];
/** صفوف gl_period_balances المقابلة (ما قبل السنة في 2025-12) */
const PERIOD_BALANCES = [
  { accountId: 'a-cash', periodKey: '2025-12', debitMilli: 50_000_000n, creditMilli: 0n },
  { accountId: 'a-cap', periodKey: '2025-12', debitMilli: 0n, creditMilli: 50_000_000n },
  { accountId: 'a-cash', periodKey: '2026-10', debitMilli: 20_000_000n, creditMilli: 7_300_125n },
  { accountId: 'a-ar', periodKey: '2026-10', debitMilli: 10_000_000n, creditMilli: 0n },
  { accountId: 'a-ap', periodKey: '2026-10', debitMilli: 0n, creditMilli: 12_000_000n },
  { accountId: 'a-rev', periodKey: '2026-10', debitMilli: 0n, creditMilli: 30_000_000n },
  { accountId: 'a-cogs', periodKey: '2026-10', debitMilli: 12_000_000n, creditMilli: 0n },
  { accountId: 'a-fuel', periodKey: '2026-10', debitMilli: 800_125n, creditMilli: 0n },
  { accountId: 'a-sal', periodKey: '2026-10', debitMilli: 4_000_000n, creditMilli: 0n },
  { accountId: 'a-rent', periodKey: '2026-10', debitMilli: 2_500_000n, creditMilli: 0n },
];

const SETTINGS: ReportSettings = {
  configured: true,
  fy: { endMonth: 12, endDay: 31 },
  currency: 'SAR',
  currencyDecimals: 2,
  timezone: 'Asia/Riyadh',
  drawingsAfterNetProfit: false,
  depreciationInOperatingExpenses: false,
};
const OCT: ReportPeriod = { from: '2026-10-01', to: '2026-10-31', fyStart: '2026-01-01' };
const YTD_OCT: ReportPeriod = { from: '2026-01-01', to: '2026-10-31', fyStart: '2026-01-01' };
const NOW = new Date('2026-11-18T09:00:00Z');

/** ردّ المسار لقائمة من المحرّك الصرف نفسه (STATEMENT_BUILDERS ثم reportJson) — «مخرجات التقرير» المرجعية. */
function statementJson(key: StatementKey, period: ReportPeriod, balances: readonly AccountBalance[] = BALANCES): LedgerReportJson {
  const result = STATEMENT_BUILDERS[key]({
    reportKey: key,
    period,
    accounts: ENGINE_ACCOUNTS,
    balances,
    settings: SETTINGS,
    options: normalizeReportOptions({
      dateFilter: key === 'balance-sheet' ? { mode: 'asOf', from: period.to, to: period.to } : { mode: 'custom', from: period.from, to: period.to },
    }),
    roles: reportAccountRoles({ accounts: ENGINE_ACCOUNTS }),
    showZero: false,
    draftMoveCount: 0,
    comparisons: [],
  });
  return reportJson({
    ...statementExtras(result),
    reportKey: key,
    period,
    settings: { currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh' },
    rows: result.rows,
    totals: result.totals,
    warnings: [],
  }) as LedgerReportJson;
}

const rowsOf = (r: AiReport) => r.sections.flatMap((s) => s.rows);
/** بيانات النموذج المختصرة (Record<string, unknown>) بقراءة مرنة في الاختبار */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const D = (x: { data: Record<string, unknown> }): Record<string, any> => x.data;
const rowByLabel = (r: AiReport, label: string) => rowsOf(r).find((x) => x.label === label);

function ctxOf(over: Partial<AcctCtx> = {}): AcctCtx {
  return {
    tenantId: T1, adminId: 'adm-1', adminName: 'مدير الحسابات', impersonated: false, tz: 'Asia/Riyadh', todayLocal: '2026-11-18',
    currency: 'SAR', accountingOn: true, booksMode: 'MANUAL', booksActivated: true, canViewLedger: true, canPost: false,
    warehouseOn: false, taxDisabled: false, userText: '', clientRef: '00000000-0000-4000-8000-000000000000',
    reports: [], posted: [], warnings: [], ...over,
  };
}

// ═══ قاعدة مقلَّدة (Proxy): تسجّل كل استدعاء، وتصفّي الحسابات والأرصدة بالشروط البسيطة ═══

interface Call { model: string; method: string; args: Record<string, unknown> }
interface Fixture {
  ledgerLines?: unknown[];
  aggregates?: unknown[];
  journals?: { defaultAccountId: string | null }[];
  mappings?: { accountId: string }[];
}

function matchAccount(a: (typeof ACCOUNTS)[number], w: Record<string, any>): boolean {
  if (w.tenantId !== undefined && w.tenantId !== T1) return false;
  if (w.id?.in && !w.id.in.includes(a.id)) return false;
  if (w.code !== undefined && w.code !== a.code) return false;
  if (w.type?.in && !w.type.in.includes(a.type)) return false;
  if ('controlKind' in w && w.controlKind === null && a.controlKind) return false;
  if (w.isActive === true && a.isActive === false) return false;
  return true;
}

const hasNotClosing = (v: unknown): boolean =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)).includes('"not":"FY_CLOSING"');

function fakeDb(calls: Call[], fx: Fixture = {}): ReportDb {
  const handler = (model: string, method: string) => async (args: Record<string, any> = {}) => {
    calls.push({ model, method, args });
    const w = (args.where ?? {}) as Record<string, any>;
    switch (`${model}.${method}`) {
      case 'glAccount.findMany': return ACCOUNTS.filter((a) => matchAccount(a, w));
      case 'glAccount.findFirst': return ACCOUNTS.find((a) => matchAccount(a, w)) ?? null;
      case 'glPeriodBalance.findMany':
        return w.tenantId === T1 ? PERIOD_BALANCES.filter((r) => !w.accountId?.in || w.accountId.in.includes(r.accountId)) : [];
      case 'glMoveLine.findMany': return args.select?.move ? (fx.ledgerLines ?? []) : [];
      case 'glMoveLine.groupBy': return hasNotClosing(w) ? (fx.aggregates ?? []) : [];
      case 'glJournal.findMany': return fx.journals ?? [];
      case 'glAccountMapping.findMany': return fx.mappings ?? [];
      default: break;
    }
    if (method === 'findMany' || method === 'groupBy') return [];
    if (method === 'count') return 0;
    if (method === 'aggregate') return { _count: { _all: 0 }, _sum: { debitMilli: null, creditMilli: null } };
    return null;
  };
  return new Proxy({}, {
    get: (_t, model: string) => new Proxy({}, { get: (_t2, method: string) => handler(model, method) }),
  }) as unknown as ReportDb;
}

/** كل قيم المفتاح tenantId في شجرة الوسائط (where وcursor…) */
function tenantIdsIn(v: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) v.forEach((x) => tenantIdsIn(x, out));
  else if (v && typeof v === 'object' && !(v instanceof Date)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'tenantId') out.push(x);
      tenantIdsIn(x, out);
    }
  }
  return out;
}

function assertTenantScoped(calls: Call[]): void {
  assert.ok(calls.length > 0, 'لا استدعاءات أصلاً');
  for (const c of calls) {
    const ids = tenantIdsIn(c.args);
    assert.ok(ids.length > 0, `استعلام بلا tenantId: ${c.model}.${c.method}`);
    for (const id of ids) assert.equal(id, T1, `${c.model}.${c.method} على شركة أخرى`);
  }
}

const toolOf = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.spec.function.name === name);
  assert.ok(t, `الأداة ${name} غائبة`);
  return t!;
};

type Ok = { data: Record<string, any>; summaryAr: string };
const ok = (out: unknown): Ok => {
  assert.ok(out && typeof out === 'object' && !('error' in (out as object)), `خطأ غير متوقع: ${JSON.stringify(out)}`);
  return out as Ok;
};
const err = (out: unknown): string => {
  assert.ok(out && typeof out === 'object' && 'error' in (out as object), `كان متوقعاً خطأ: ${JSON.stringify(out)}`);
  return String((out as { error: unknown }).error);
};

// ═══ الملّي ⇒ رقم ═══

test('milliToNumber: نصف-لأعلى بمنازل العملة، والسالب بعيداً عن الصفر، والفاسد صفر', () => {
  assert.equal(milliToNumber('1234567'), 1234.57);
  assert.equal(milliToNumber('1234565'), 1234.57);
  assert.equal(milliToNumber('1234564'), 1234.56);
  assert.equal(milliToNumber('-1234565'), -1234.57);
  assert.equal(milliToNumber(10_699_875n), 10699.88);
  assert.equal(milliToNumber('1000'), 1);
  assert.equal(milliToNumber('1234567', 3), 1234.567);
  assert.equal(milliToNumber('1500', 0), 2);
  assert.equal(milliToNumber('-4'), 0);
  assert.ok(!Object.is(milliToNumber('-4'), -0));
  assert.equal(milliToNumber('12.5'), 0);
  assert.equal(milliToNumber(null), 0);
  assert.equal(milliToNumber(undefined), 0);
  assert.equal(milliToNumber('abc'), 0);
  assert.equal(milliToNumber('123456789012345'), 123456789012.35);
  assert.equal(fmtAmount(10699.88), '10,699.88');
  assert.equal(fmtAmount(-2500), '-2,500');
});

// ═══ البوابة ═══

test('البوابة: لا أدوات بلا دفاتر مفعّلة أو بلا canViewLedger أو بلا محاسبة', () => {
  assert.deepEqual(buildLedgerReadTools(ctxOf({ booksActivated: false })), []);
  assert.deepEqual(buildLedgerReadTools(ctxOf({ canViewLedger: false })), []);
  assert.deepEqual(buildLedgerReadTools(ctxOf({ accountingOn: false })), []);
  assert.deepEqual(buildLedgerReadTools(ctxOf({ booksActivated: false, booksMode: 'NONE' })), []);
  const tools = buildLedgerReadTools(ctxOf(), { db: fakeDb([]) });
  assert.deepEqual(tools.map((t) => t.spec.function.name), [...LEDGER_TOOL_NAMES]);
  for (const t of tools) {
    assert.equal(t.spec.type, 'function');
    const params = t.spec.function.parameters as { properties: Record<string, unknown> };
    assert.ok(!('tenantId' in params.properties), 'لا شركة في وسائط النموذج');
  }
});

// ═══ القائمة البيضاء للمفاتيح ═══

test('ledger_report: المفاتيح الخمسة وحدها — cash-flow/vat-return/مجهول ⇒ خطأ بلا لمس القاعدة', async () => {
  assert.deepEqual([...AI_LEDGER_REPORT_KEYS], ['trial-balance', 'income-statement', 'balance-sheet', 'general-ledger', 'executive-summary']);
  const spec = toolOf(buildLedgerReadTools(ctxOf(), { db: fakeDb([]) }), 'ledger_report').spec.function.parameters as {
    properties: { key: { enum: string[] } };
  };
  assert.deepEqual(spec.properties.key.enum, [...AI_LEDGER_REPORT_KEYS]);

  const calls: Call[] = [];
  const ctx = ctxOf();
  const tool = toolOf(buildLedgerReadTools(ctx, { db: fakeDb(calls), now: () => NOW }), 'ledger_report');
  assert.match(err(await tool.run({ key: 'cash-flow' })), /executive-summary/);
  assert.match(err(await tool.run({ key: 'vat-return' })), /unknown report/);
  assert.match(err(await tool.run({ key: 'DROP TABLE' })), /unknown report/);
  assert.match(err(await tool.run({})), /invalid arguments/);
  assert.match(err(await tool.run({ key: 7 })), /invalid arguments/);
  assert.equal(calls.length, 0, 'المفتاح المرفوض لا يلمس القاعدة');
  assert.equal(ctx.reports.length, 0);

  // المرادف الداخلي مقبول ويُعاد تحت المفتاح القانوني
  const out = ok(await tool.run({ key: 'profit-and-loss', month: '2026-10' }));
  assert.equal(out.data.report, 'income-statement');
  const tb = ok(await tool.run({ key: 'Trial_Balance', month: '2026-10' }));
  assert.equal(tb.data.report, 'trial-balance');
});

// ═══ التحويل من مخرجات المحرّك ═══

test('قائمة الدخل: الأقسام والأرقام من المحرّك، والمجموعات والحسابات تحتها، وصافي الربح مقرَّب', () => {
  const m = mapIncomeStatement(statementJson('income-statement', OCT));
  const r = m.report;
  assert.equal(r.kind, 'income-statement');
  assert.equal(r.title, 'قائمة الدخل');
  assert.deepEqual(r.period, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.currency, 'SAR');
  assert.deepEqual(r.sections.map((s) => s.title), ['الإيرادات', 'تكلفة الإيرادات', 'المصروفات', 'النتيجة']);
  assert.equal(rowByLabel(r, 'صافي الإيرادات')?.amount, 30000);
  assert.equal(rowByLabel(r, 'صافي الإيرادات')?.bold, true);
  assert.equal(rowByLabel(r, 'مجمل الربح')?.amount, 18000);
  assert.equal(rowByLabel(r, 'المصروفات التشغيلية')?.amount, 7300.13);
  assert.equal(rowByLabel(r, 'مصروفات البيع والتوزيع')?.amount, 800.13);
  assert.equal(rowByLabel(r, 'المصروفات العمومية والإدارية')?.amount, 6500);
  assert.deepEqual(rowByLabel(r, 'الإيجار'), { label: 'الإيجار', amount: 2500, level: 2 });
  assert.equal(rowByLabel(r, 'صافي الربح')?.amount, 10699.88);
  // الأسطر الصفرية غير المجمّعة لا تُعرض (لا مردودات ولا زكاة)
  assert.equal(rowByLabel(r, 'يُطرح: مردودات وخصومات المبيعات'), undefined);
  assert.equal(rowByLabel(r, 'الزكاة وضريبة الدخل'), undefined);
  // بيانات النموذج المختصرة
  assert.equal(D(m).revenue, 30000);
  assert.equal(D(m).net_profit, 10699.88);
  assert.equal(D(m).operating_expenses, 7300.13);
  assert.deepEqual(D(m).top_expense_accounts.map((a: { code: string }) => a.code), ['621001', '621004', '611003']);
  assert.match(m.summaryAr, /صافي الربح 10,699\.88 SAR/);
});

test('قائمة الدخل بخسارة: الملخّص يقول «صافي الخسارة» بالقيمة المطلقة', () => {
  const loss = BALANCES.map((x) => (x.accountId === 'a-rev' ? b('a-rev', { creditMilli: 5_000_000n }) : x));
  const m = mapIncomeStatement(statementJson('income-statement', OCT, loss));
  assert.equal(D(m).net_profit, -14300.13);
  assert.match(m.summaryAr, /صافي الخسارة 14,300\.13/);
});

test('الميزانية: الأصول والالتزامات وحقوق الملكية متوازنة، والفترة «اعتباراً من»', () => {
  const m = mapBalanceSheet(statementJson('balance-sheet', YTD_OCT));
  const r = m.report;
  assert.equal(r.kind, 'balance-sheet');
  assert.deepEqual(r.period, { from: '2026-10-31', to: '2026-10-31' });
  assert.deepEqual(r.sections.map((s) => s.title), ['الأصول', 'الالتزامات', 'حقوق الملكية', null]);
  assert.equal(rowByLabel(r, 'إجمالي الأصول')?.amount, 72699.88);
  assert.equal(rowByLabel(r, 'إجمالي الالتزامات')?.amount, 12000);
  assert.equal(rowByLabel(r, 'إجمالي حقوق الملكية')?.amount, 60699.88);
  assert.equal(rowByLabel(r, 'الحسابات البنكية والنقدية')?.amount, 62699.88);
  assert.equal(rowByLabel(r, 'الالتزامات + حقوق الملكية')?.amount, 72699.88);
  // «الالتزامات المتداولة» بتسمية أبيها تُدمج فلا يتكرر السطر
  assert.equal(rowsOf(r).filter((x) => x.label === 'الالتزامات المتداولة').length, 1);
  assert.equal(D(m).balanced, true);
  assert.equal(D(m).total_assets, 72699.88);
  assert.equal(D(m).current_year_earnings, 10699.88);
  assert.equal(D(m).cash_and_banks, 62699.88);
  assert.ok(!r.notes.some((n) => n.includes('غير متوازنة')));
});

test('الميزانية غير المتوازنة تُنبَّه في الملاحظات', () => {
  const json = statementJson('balance-sheet', YTD_OCT);
  const unbalanced = { ...json, totals: { ...(json.totals as object), balanced: false, imbalanceMilli: '1500' } } as LedgerReportJson;
  const m = mapBalanceSheet(unbalanced);
  assert.match(m.report.notes[0], /غير متوازنة بفرق 1\.5/);
  assert.equal(D(m).balanced, false);
});

test('ميزان المراجعة: أرصدة مدينة ودائنة بمجموعين متساويين بالملّي، وحركة الفترة', () => {
  const m = mapTrialBalance(statementJson('trial-balance', OCT));
  const r = m.report;
  assert.equal(r.kind, 'trial-balance');
  assert.deepEqual(r.sections.map((s) => s.title), ['أرصدة مدينة', 'أرصدة دائنة', 'حركة الفترة']);
  assert.equal(rowByLabel(r, 'إجمالي الأرصدة المدينة')?.amount, 92000);
  assert.equal(rowByLabel(r, 'إجمالي الأرصدة الدائنة')?.amount, 92000);
  assert.equal(rowByLabel(r, '111001 الصندوق الرئيسي')?.amount, 62699.88);
  assert.equal(rowByLabel(r, '311001 رأس المال')?.amount, 50000);
  assert.equal(rowByLabel(r, 'إجمالي المدين')?.amount, 49300.13);
  assert.equal(rowByLabel(r, 'إجمالي الدائن')?.amount, 49300.13);
  // الحسابات الصفرية (البنك، النثرية…) لا تُعرض
  assert.equal(rowByLabel(r, '111101 البنك الرئيسي'), undefined);
  assert.equal(r.notes[0], 'الميزان متوازن.');
  assert.equal(D(m).balanced, true);
  assert.equal(D(m).total_debit_balances, 92000);
  assert.equal(D(m).largest_balances[0].code, '111001');
  assert.equal(D(m).largest_balances.find((x: { code: string }) => x.code === '411001').balance, -30000);
});

test('الملخّص التنفيذي: النقد وصافي حركة النقد (جواب التدفق النقدي) والنِّسب نصوصاً', () => {
  const m = mapExecutiveSummary(statementJson('executive-summary', OCT));
  const r = m.report;
  assert.equal(r.kind, 'executive-summary');
  assert.deepEqual(r.sections.map((s) => s.title), ['الأداء', 'النقد والسيولة', 'الذمم']);
  assert.equal(rowByLabel(r, 'الإيراد')?.amount, 30000);
  assert.equal(rowByLabel(r, 'صافي الربح')?.amount, 10699.88);
  assert.equal(rowByLabel(r, 'النقد')?.amount, 62699.88);
  assert.equal(rowByLabel(r, 'صافي حركة النقد')?.amount, 12699.88);
  assert.deepEqual(rowByLabel(r, 'هامش إجمالي الربح'), { label: 'هامش إجمالي الربح', amount: null, text: '60٪', level: 0 });
  assert.equal(rowByLabel(r, 'هامش صافي الربح')?.text, '35.67٪');
  assert.equal(rowByLabel(r, 'متوسط فترة السداد (DPO)')?.text, '31 يوماً');
  assert.equal(D(m).net_cash_flow, 12699.88);
  assert.equal(D(m).cash_at_period_end, 62699.88);
  assert.equal(D(m).gross_margin_pct, 60);
  assert.ok(r.notes[0].includes('صافي حركة النقد'));
  assert.equal(ratioText({ kind: 'percent', value: 0, defined: false }), '—');
  assert.equal(ratioText({ kind: 'ratio', value: 6.06, defined: true }), '6.06');
});

test('ملخّص المصروفات: من قائمة الدخل نفسها — التشغيلية بمجموعاتها ثم التكلفة، والإجمالي مجموعها بالملّي', () => {
  const m = mapExpensesSummary(statementJson('income-statement', OCT));
  const r = m.report;
  assert.equal(r.kind, 'expenses');
  assert.equal(r.title, 'ملخص المصروفات');
  assert.deepEqual(r.sections.map((s) => s.title), ['المصروفات التشغيلية', 'تكلفة البضاعة المباعة', null]);
  assert.equal(rowByLabel(r, 'إجمالي المصروفات التشغيلية')?.amount, 7300.13);
  assert.equal(rowByLabel(r, 'إجمالي تكلفة البضاعة المباعة')?.amount, 12000);
  assert.equal(rowByLabel(r, 'إجمالي المصروفات')?.amount, 19300.13);
  assert.equal(rowByLabel(r, 'الوقود')?.level, 1);
  assert.equal(D(m).total_expenses, 19300.13);
  assert.equal(D(m).top_accounts[0].code, '511001');
});

test('دفتر الأستاذ: الافتتاحي ثم الحركات بإشارة (مدين موجب) ثم الختامي، والسقف يُنبَّه', () => {
  const json: LedgerReportJson = {
    reportKey: 'general-ledger',
    period: { from: '2026-10-01', to: '2026-10-31' },
    settings: { currency: 'SAR', currencyDecimals: 2 },
    rows: [{
      account: { code: '111001', name: 'الصندوق الرئيسي' },
      openingMilli: '50000000', debitMilli: '20000000', creditMilli: '7300125', endingMilli: '62699875', lineCount: 2,
      lines: [
        { date: '2026-10-05', moveNumber: 'INV/2026/0001', label: 'مبيعات نقدية', debitMilli: '20000000', creditMilli: '0' },
        { date: '2026-10-07', moveNumber: null, label: null, journalName: 'الصندوق', debitMilli: '0', creditMilli: '7300125' },
      ],
    }],
    totals: {},
    warnings: [],
  };
  const m = mapGeneralLedger(json);
  const r = m.report;
  assert.equal(r.title, 'دفتر الأستاذ العام — الصندوق الرئيسي');
  assert.equal(r.sections[0].title, '111001 الصندوق الرئيسي');
  assert.deepEqual(r.sections[0].rows.map((x) => x.amount), [50000, 20000, -7300.13, 20000, 7300.13, 62699.88]);
  assert.equal(r.sections[0].rows[1].label, '2026-10-05 · INV/2026/0001 · مبيعات نقدية');
  assert.equal(r.sections[0].rows[2].label, '2026-10-07 · — · الصندوق');
  assert.equal(r.notes.length, 1, 'بلا تنبيه سقف');
  assert.equal(D(m).accounts[0].closing, 62699.88);
  assert.equal(D(m).accounts[0].latest_lines.length, 2);

  const cut = mapGeneralLedger({ ...json, rows: [{ ...(json.rows[0] as object), lineCount: 900, lines: [] }] }, { truncated: true });
  assert.ok(cut.report.notes.some((n) => n.includes('عُرضت 0 من أصل 900')));
  assert.equal(ledgerLineLabel({ date: '2026-10-01', debitMilli: '0', creditMilli: '0', partnerName: 'عميل' }), '2026-10-01 · — · عميل');
});

test('mapLedgerReport يوزّع بالمفتاح ويرفض المجهول', () => {
  assert.equal(mapLedgerReport(statementJson('trial-balance', OCT)).report.kind, 'trial-balance');
  assert.throws(() => mapLedgerReport({ ...statementJson('trial-balance', OCT), reportKey: 'cash-flow' }));
});

// ═══ الفترة ═══

test('الفترة: الشهر بتوقيت الشركة شاملاً، والاصطلاح الحصري يُحوَّل، والفاسد خطأ، وبلا فترة null', () => {
  assert.deepEqual(aiPeriodOf({ month: '2026-10' }, 'Asia/Riyadh', '2026-11-18'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(aiPeriodOf({ month: '١١' }, 'Asia/Riyadh', '2026-11-18'), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(aiPeriodOf({ from: '2026-01-01', to: '2026-03-31' }, 'Asia/Riyadh', '2026-11-18'), { from: '2026-01-01', to: '2026-03-31' });
  assert.equal(aiPeriodOf({}, 'Asia/Riyadh', '2026-11-18'), null);
  assert.deepEqual(aiPeriodOf({}, 'Asia/Riyadh', '2026-11-18', undefined, { emptyAsDefault: true }), { from: '2026-11-01', to: '2026-11-18' });
  assert.ok('error' in (aiPeriodOf({ month: '13' }, 'Asia/Riyadh', '2026-11-18') as object));
  // مُعيدٌ باصطلاح حصري (toLocal = أول التالي) يُقرأ شاملاً
  const exclusive = () => ({
    fromLocal: '2026-10-01', toLocal: '2026-11-01',
    gte: new Date('2026-09-30T21:00:00Z'), lt: new Date('2026-10-31T21:00:00Z'),
  });
  assert.deepEqual(aiPeriodOf({ month: '10' }, 'Asia/Riyadh', '2026-11-18', exclusive), { from: '2026-10-01', to: '2026-10-31' });
});

test('وسائط المسار: الميزانية «اعتباراً من» نهاية الفترة أو «إلى» وحده، وغيرها مدى مخصّص، وبلا فترة افتراض المسار', () => {
  const tz = 'Asia/Riyadh';
  const today = '2026-11-18';
  assert.deepEqual(reportQueryOf('balance-sheet', { to: '2026-09-30' }, tz, today), { mode: 'asOf', asOf: '2026-09-30' });
  assert.deepEqual(reportQueryOf('balance-sheet', { month: '2026-10' }, tz, today), { mode: 'asOf', asOf: '2026-10-31' });
  assert.deepEqual(reportQueryOf('balance-sheet', {}, tz, today), {});
  assert.deepEqual(reportQueryOf('income-statement', {}, tz, today), {});
  assert.deepEqual(reportQueryOf('income-statement', { month: '2026-10' }, tz, today), { mode: 'custom', from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(reportQueryOf('trial-balance', { from: '2026-10-01', to: '2026-10-15' }, tz, today), { mode: 'custom', from: '2026-10-01', to: '2026-10-15' });
  assert.ok('error' in reportQueryOf('balance-sheet', { to: '2026-02-30' }, tz, today));
  assert.ok('error' in reportQueryOf('income-statement', { from: '2026-10-10', to: '2026-10-01' }, tz, today));
});

// ═══ دورة كاملة بقاعدة مقلَّدة ═══

test('ledger_report بقاعدة مقلَّدة: يطابق المحرّك الصرف، ويدفع التقرير، وكل استعلام محصور بشركة السياق رغم الحقن', async () => {
  const calls: Call[] = [];
  const ctx = ctxOf();
  const tool = toolOf(buildLedgerReadTools(ctx, { db: fakeDb(calls), now: () => NOW }), 'ledger_report');
  const out = ok(await tool.run({ key: 'income-statement', month: '2026-10', tenantId: 'T2', tenant_id: 'T2' }));
  assert.equal(out.data.net_profit, 10699.88);
  assert.equal(out.data.revenue, 30000);
  assert.equal(ctx.reports.length, 1);
  assert.equal(ctx.reports[0].kind, 'income-statement');
  assert.deepEqual(ctx.reports[0].period, { from: '2026-10-01', to: '2026-10-31' });
  assertTenantScoped(calls);

  // مطابقة المحرّك: ردّ loadLedgerReport = بناء STATEMENT_BUILDERS على الأرصدة نفسها
  for (const key of ['income-statement', 'trial-balance', 'executive-summary'] as const) {
    const json = await loadLedgerReport(fakeDb([]), T1, key, { mode: 'custom', from: OCT.from, to: OCT.to }, { now: NOW });
    const pure = statementJson(key, OCT);
    assert.deepEqual(json.rows, pure.rows, `${key}: الصفوف`);
    assert.deepEqual(json.totals, pure.totals, `${key}: المجاميع`);
    assert.deepEqual(json.period, OCT);
    assert.equal(json.settings.currency, 'SAR');
    assert.deepEqual(json.warnings, []);
  }
  const bs = await loadLedgerReport(fakeDb([]), T1, 'balance-sheet', { mode: 'asOf', asOf: '2026-10-31' }, { now: NOW });
  const pureBs = statementJson('balance-sheet', YTD_OCT);
  assert.deepEqual(bs.rows, pureBs.rows);
  assert.deepEqual(bs.totals, pureBs.totals);
  assert.equal(bs.asOf, '2026-10-31');

  // التقرير نفسه مرة ثانية لا يتكرر في الواجهة
  const again = toolOf(buildLedgerReadTools(ctx, { db: fakeDb([]), now: () => NOW }), 'ledger_report');
  ok(await again.run({ key: 'income-statement', month: '10' }));
  assert.equal(ctx.reports.length, 1);
  ok(await again.run({ key: 'balance-sheet', to: '2026-10-31' }));
  assert.equal(ctx.reports.length, 2);
  assert.equal(ctx.reports[1].kind, 'balance-sheet');
});

test('ledger_report بلا فترة: افتراضات المسار (قائمة الدخل = السنة المالية، الميزان = الشهر الحالي)', async () => {
  const ctx = ctxOf();
  const tool = toolOf(buildLedgerReadTools(ctx, { db: fakeDb([]), now: () => NOW }), 'ledger_report');
  ok(await tool.run({ key: 'income-statement' }));
  assert.deepEqual(ctx.reports[0].period, { from: '2026-01-01', to: '2026-12-31' });
  ok(await tool.run({ key: 'trial-balance', month: null }));
  assert.deepEqual(ctx.reports[1].period, { from: '2026-11-01', to: '2026-11-30' });
  ok(await tool.run({ key: 'balance-sheet' }));
  assert.deepEqual(ctx.reports[2].period, { from: '2026-11-18', to: '2026-11-18' });
});

test('ledger_report: الفترة الفاسدة والمقلوبة رسالةٌ لا انهيار', async () => {
  const calls: Call[] = [];
  const tool = toolOf(buildLedgerReadTools(ctxOf(), { db: fakeDb(calls), now: () => NOW }), 'ledger_report');
  assert.match(err(await tool.run({ key: 'income-statement', month: '2026-13' })), /الشهر/);
  assert.match(err(await tool.run({ key: 'trial-balance', from: '2026-10-10', to: '2026-10-01' })), /بعد تاريخ النهاية/);
  assert.equal(calls.length, 0);
});

test('دفتر الأستاذ: يحتاج رمز حساب موجوداً في الشركة، وفوق السقف يكتفي بالمجاميع بلا تحميل السطور', async () => {
  const lineRow = (id: string, date: string, debit: bigint, credit: bigint, label: string) => ({
    id, moveId: `m-${id}`, accountId: 'a-cash', journalId: 'j-cash', date: toDbDate(date), seq: 0, label,
    debitMilli: debit, creditMilli: credit, customerId: null, vendorId: null, salesRepId: null, partnerName: null,
    analyticAccountId: null,
    move: { number: `MISC/2026/${id}`, state: 'POSTED', moveType: 'ENTRY', originalDate: null, lateArrival: false, journal: { code: 'CSH1', name: 'الصندوق' } },
  });
  const fx: Fixture = {
    ledgerLines: [
      lineRow('0001', '2026-10-05', 20_000_000n, 0n, 'مبيعات نقدية'),
      lineRow('0002', '2026-10-06', 0n, 2_500_000n, 'إيجار أكتوبر'),
      lineRow('0003', '2026-10-07', 0n, 800_125n, 'وقود'),
      lineRow('0004', '2026-10-28', 0n, 4_000_000n, 'رواتب أكتوبر'),
    ],
    aggregates: [{ accountId: 'a-cash', _count: { _all: 4 }, _sum: { debitMilli: 20_000_000n, creditMilli: 7_300_125n } }],
  };
  const calls: Call[] = [];
  const ctx = ctxOf();
  const tool = toolOf(buildLedgerReadTools(ctx, { db: fakeDb(calls, fx), now: () => NOW }), 'ledger_report');
  assert.match(err(await tool.run({ key: 'general-ledger', month: '2026-10' })), /account_code/);
  assert.match(err(await tool.run({ key: 'general-ledger', month: '2026-10', account_code: '999999' })), /no account/);
  // أكثر من 12 شهراً في الأستاذ ⇒ رسالة الدفاتر (LEDGER_RANGE_TOO_LARGE) لا انهيار
  const tooLong = err(await tool.run({ key: 'general-ledger', from: '2025-01-01', to: '2026-10-31', account_code: '111001' }));
  assert.ok(tooLong.length > 5 && !/tool failed/.test(tooLong));
  assert.equal(ctx.reports.length, 0);
  const out = ok(await tool.run({ key: 'general-ledger', month: '2026-10', account_code: '١١١٠٠١' }));
  assert.equal(out.data.accounts.length, 1);
  assert.equal(out.data.accounts[0].opening, 50000);
  assert.equal(out.data.accounts[0].closing, 62699.88);
  assert.equal(out.data.accounts[0].line_count, 4);
  const r = ctx.reports[0];
  assert.equal(r.kind, 'general-ledger');
  assert.equal(r.sections.length, 1, 'حسابٌ واحد');
  assert.equal(r.sections[0].rows.length, 1 + 4 + 3);
  assert.equal(r.sections[0].rows[2].amount, -2500);
  assertTenantScoped(calls);

  // فوق السقف: المجاميع من الإجماليات نفسها، ولا قراءة للسطور
  const capCalls: Call[] = [];
  const cut = await loadLedgerReport(fakeDb(capCalls, fx), T1, 'general-ledger', { mode: 'custom', from: OCT.from, to: OCT.to }, { now: NOW, accountId: 'a-cash', maxLines: 2 });
  assert.equal(cut.truncated, true);
  assert.ok(!capCalls.some((c) => c.model === 'glMoveLine' && c.method === 'findMany' && (c.args as { select?: { move?: unknown } }).select?.move));
  const mapped = mapGeneralLedger(cut, { truncated: cut.truncated });
  assert.equal(milliToNumber((cut.rows[0] as { endingMilli: string }).endingMilli), 62699.88);
  assert.equal(mapped.report.sections[0].rows.length, 4, 'الافتتاحي والمجاميع والختامي بلا سطور');
  assert.ok(mapped.report.notes.some((n) => n.includes('عُرضت 0 من أصل 4')));
  assert.ok(AI_GL_MAX_LINES >= 100);
});

test('expenses_summary: افتراض الشهر الحالي حتى اليوم، وبالشهر المطلوب أرقام قائمة الدخل نفسها', async () => {
  const calls: Call[] = [];
  const ctx = ctxOf();
  const tool = toolOf(buildLedgerReadTools(ctx, { db: fakeDb(calls), now: () => NOW }), 'expenses_summary');
  const def = ok(await tool.run({}));
  assert.deepEqual(def.data.period, { from: '2026-11-01', to: '2026-11-18' });
  assert.equal(def.data.total_expenses, 0);
  const oct = ok(await tool.run({ month: '2026-10' }));
  assert.equal(oct.data.total_expenses, 19300.13);
  assert.equal(oct.data.operating_expenses, 7300.13);
  assert.equal(ctx.reports.length, 2);
  assert.equal(ctx.reports[1].kind, 'expenses');
  assertTenantScoped(calls);
});

test('accounts_lookup: بلا حسابات رقابية ولا مؤرشفة، والنقد غير البنك، والبحث يرتّب', async () => {
  const rows: LookupAccountRow[] = ACCOUNTS.filter((a) => !a.controlKind && a.isActive !== false);
  assert.deepEqual(filterLookupAccounts(rows, 'cash', new Set()).map((a) => a.code), ['111001', '111002']);
  assert.deepEqual(filterLookupAccounts(rows, 'bank', new Set()).map((a) => a.code), ['111101']);
  assert.deepEqual(filterLookupAccounts(rows, 'liability', new Set()).map((a) => a.code), ['213001']);
  assert.equal(filterLookupAccounts(rows, 'expense', new Set(), 'الايجار')[0].code, '621004');
  assert.ok(isBankAccount({ id: 'x', code: '111050', name: 'حساب الراجحي', nameEn: 'Al Rajhi Bank' }, new Set()));
  assert.ok(isBankAccount({ id: 'x', code: '111050', name: 'حساب جاري' }, new Set(['x'])));
  assert.ok(!isBankAccount({ id: 'x', code: '111050', name: 'الصندوق الفرعي' }, new Set()));

  const calls: Call[] = [];
  const tool = toolOf(buildLedgerReadTools(ctxOf(), { db: fakeDb(calls, { journals: [{ defaultAccountId: 'a-bank' }] }) }), 'accounts_lookup');
  const cash = ok(await tool.run({ kind: 'cash' }));
  assert.deepEqual(cash.data.accounts.map((a: { code: string }) => a.code), ['111001', '111002']);
  const bank = ok(await tool.run({ kind: 'bank' }));
  assert.deepEqual(bank.data.accounts.map((a: { code: string }) => a.code), ['111101']);
  const exp = ok(await tool.run({ kind: 'expense' }));
  assert.ok(!exp.data.accounts.some((a: { code: string }) => a.code === '621099'), 'المؤرشف مستبعد');
  assert.ok(exp.data.accounts.some((a: { code: string }) => a.code === '511001'));
  const where = calls.find((c) => c.model === 'glAccount')!.args.where as Record<string, unknown>;
  assert.equal(where.controlKind, null);
  assert.equal(where.isActive, true);
  assert.match(err(await tool.run({ kind: 'equity' })), /kind must be/);
  assertTenantScoped(calls);
});
