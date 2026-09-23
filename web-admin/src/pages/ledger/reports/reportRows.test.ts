import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendLedgerChunk, chunkOfSection, generalLedgerColumns, generalLedgerLineNode, generalLedgerSectionNode,
  generalLedgerTable, isZeroMilli, ledgerLineTags, ledgerSectionView, ledgerSectionsWithMore,
  trialBalanceBroken, trialBalanceColumns, trialBalanceNodes, trialBalanceTable, trialImbalanceIssues,
  trialRowAccountId, trialRowCells,
  type GeneralLedgerLineJson, type GeneralLedgerResponse, type GeneralLedgerSectionJson,
  type LedgerPageChunk, type ReportRowsContext, type TrialBalanceResponse, type TrialCellJson, type TrialRowJson,
} from './reportRows';

/** سياق عرض صغير: التحويلات لا تحتاج أكثر منه (‏`ReportRenderContext` الكامل يمرّره ReportView). */
const ctx: ReportRowsContext = {
  tr: (ar: string) => ar,
  lang: 'ar',
  periodLabel: p => `${p.from}→${p.to}`,
};

const cell = (over: Partial<TrialCellJson> = {}): TrialCellJson => ({
  openingMilli: '0', debitMilli: '0', creditMilli: '0', endingMilli: '0', deltaMilli: null, percent: null, ...over,
});

const row = (over: Partial<TrialRowJson> = {}): TrialRowJson => ({
  id: 'r', kind: 'account', accountId: 'r', code: '111001', name: 'الصندوق', nameI18n: null, type: 'asset_cash',
  level: 0, parentId: null, childIds: [], hasChildren: false, mergedAccountIds: [], cells: [cell()], ...over,
});

// ═══ ميزان المراجعة (§7.2) ═══

test('trialBalanceColumns: أربعة أعمدة للفترة وستة لكل مقارنة (ومعها الفرق والنسبة)', () => {
  const cols = trialBalanceColumns([
    { from: '2026-01-01', to: '2026-01-31', fyStart: '2026-01-01', kind: 'base', index: 0 },
    { from: '2025-12-01', to: '2025-12-31', fyStart: '2025-01-01', kind: 'comparison', index: 1 },
  ], ctx);
  assert.deepEqual(cols.map(c => c.key), [
    '0:opening', '0:debit', '0:credit', '0:ending',
    '1:opening', '1:debit', '1:credit', '1:ending', '1:delta', '1:percent',
  ]);
  assert.deepEqual(cols.slice(0, 4).map(c => c.label), ['الرصيد الافتتاحي', 'مدين', 'دائن', 'الرصيد النهائي']);
  assert.equal(cols[0].sub, '2026-01-01→2026-01-31');
  assert.equal(cols[4].sub, 'مقارنة: 2025-12-01→2025-12-31');
});

test('trialRowCells: المبالغ تمرّ بالملّي كما هي (الوحدة والتقريب في القشرة لا هنا)', () => {
  const cells = trialRowCells([
    cell({ openingMilli: '1000', debitMilli: '2000', creditMilli: '0', endingMilli: '3000' }),
    cell({ openingMilli: '5', endingMilli: '9', deltaMilli: '-6', percent: -12.5 }),
  ], 2);
  assert.equal(cells.length, 10);
  assert.deepEqual(cells[0], { kind: 'amount', milli: '1000' });
  assert.deepEqual(cells[1], { kind: 'amount', milli: '2000', blankZero: true });
  assert.deepEqual(cells[3], { kind: 'amount', milli: '3000', strong: true });
  assert.deepEqual(cells[8], { kind: 'amount', milli: '-6' });
  assert.deepEqual(cells[9], { kind: 'percent', value: -12.5 });
  // عمودٌ غائب من الردّ يُقرأ صفراً بدل خانة مكسورة
  assert.deepEqual(trialRowCells(undefined, 1), [
    { kind: 'amount', milli: '0' },
    { kind: 'amount', milli: '0', blankZero: true },
    { kind: 'amount', milli: '0', blankZero: true },
    { kind: 'amount', milli: '0', strong: true },
  ]);
});

test('trialBalanceNodes: الشجرة تُبنى بالأب قبل أبنائه، والصف اليتيم يبقى في الجذر', () => {
  const rows = [
    row({ id: 'group:1', kind: 'group', accountId: null, code: '1', hasChildren: true }),
    row({ id: 'group:11', kind: 'group', accountId: null, code: '11', parentId: 'group:1', hasChildren: true }),
    row({ id: 'a1', parentId: 'group:11' }),
    row({ id: 'orphan', parentId: 'group:404' }),
  ];
  const nodes = trialBalanceNodes(rows, ctx, 1);
  assert.deepEqual(nodes.map(n => n.id), ['group:1', 'orphan']);
  assert.deepEqual(nodes[0].children?.map(n => n.id), ['group:11']);
  assert.deepEqual(nodes[0].children?.[0].children?.map(n => n.id), ['a1']);
  assert.equal(nodes[0].emphasis, 'section');
  assert.equal(nodes[0].children?.[0].children?.[0].emphasis, 'normal');
});

test('trialRowAccountId: التعمّق من صفّ الحساب، ومن «أرباح سنوات سابقة» حين تدمج حساباً واحداً', () => {
  assert.equal(trialRowAccountId(row({ accountId: 'acc-1' })), 'acc-1');
  assert.equal(trialRowAccountId(row({ accountId: null, mergedAccountIds: ['e319'] })), 'e319');
  // صفٌّ يجمع حسابين لا يحمل رابطاً يدّعي أنه حساب واحد
  assert.equal(trialRowAccountId(row({ accountId: null, mergedAccountIds: ['a', 'b'] })), null);
  assert.equal(trialRowAccountId(row({ accountId: null })), null);
});

const tbData = (over: Partial<TrialBalanceResponse> = {}): TrialBalanceResponse => ({
  reportKey: 'trial-balance',
  period: { from: '2026-01-01', to: '2026-01-31', fyStart: '2026-01-01' },
  dateFilter: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' },
  options: {
    dateFilter: { mode: 'custom', from: '2026-01-01', to: '2026-01-31' },
    comparison: null, postedOnly: true, includeDrafts: false, unit: 1, hierarchy: false, hideZero: false,
    journals: [], analytic: [], salesReps: [], search: '', breakdown: 'none', accounts: [], partners: [],
  },
  settings: {
    currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', fiscalYearEnd: { month: 12, day: 31 },
    drawingsAfterNetProfit: false, depreciationInOperatingExpenses: true, configured: true,
  },
  mode: 'AGGREGATE',
  rows: [row({ id: 'a1' })],
  totals: [cell()],
  comparison: null,
  pagination: null,
  lineCount: 1,
  warnings: [],
  columns: [{ from: '2026-01-01', to: '2026-01-31', fyStart: '2026-01-01', kind: 'base', index: 0 }],
  visibleTotals: [cell()],
  imbalance: [{ openingMilli: '0', movementMilli: '0', endingMilli: '0', balanced: true }],
  balanced: true,
  unallocatedRowId: 'unallocated-earnings',
  searchApplied: false,
  draftMoveCount: 0,
  ...over,
});

test('trialBalanceTable: صفّ إجمالي واحد في الحالة السليمة، بلا وسم خطر', () => {
  const t = trialBalanceTable(tbData(), ctx);
  assert.deepEqual(t.footer?.map(n => n.id), ['totals']);
  assert.equal(t.footer?.[0].danger, false);
  assert.equal(t.footer?.[0].emphasis, 'total');
  assert.deepEqual(t.nodes.map(n => n.id), ['a1']);
});

test('trialBalanceTable: الخرق يوسم الصفّ خطراً (أحمر)، ويظهر «إجمالي المعروض» عند البحث أو إخفاء الأصفار', () => {
  const broken = trialBalanceTable(tbData({
    imbalance: [{ openingMilli: '0', movementMilli: '-5000', endingMilli: '0', balanced: false }],
    balanced: false,
    searchApplied: true,
  }), ctx);
  assert.deepEqual(broken.footer?.map(n => n.id), ['visible-totals', 'totals']);
  assert.equal(broken.footer?.[1].danger, true);
});

test('trialImbalanceIssues: كل شرط مخروق يُسمّى، والمتوازن لا يرفع شيئاً', () => {
  assert.deepEqual(trialImbalanceIssues({ openingMilli: '0', movementMilli: '0', endingMilli: '0', balanced: true }), []);
  assert.deepEqual(
    trialImbalanceIssues({ openingMilli: '5', movementMilli: '0', endingMilli: '-5', balanced: false }),
    ['opening', 'ending'],
  );
  assert.deepEqual(
    trialImbalanceIssues({ openingMilli: '-0', movementMilli: '-2', endingMilli: '0', balanced: false }),
    ['movement'],
  );
  assert.deepEqual(trialImbalanceIssues(undefined), []);
});

test('trialBalanceBroken: عمود مقارنة مختلّ وحده يكفي، ولا يُقرأ balanced وحده', () => {
  const ok = { openingMilli: '0', movementMilli: '0', endingMilli: '0', balanced: true };
  assert.equal(trialBalanceBroken([ok, ok]), false);
  assert.equal(trialBalanceBroken([ok, { ...ok, endingMilli: '3', balanced: true }]), true);
  assert.equal(trialBalanceBroken([]), false);
  assert.equal(trialBalanceBroken(undefined), false);
});

test('isZeroMilli: النصّ المشوّه أو الفارغ صفر لا NaN', () => {
  assert.ok(isZeroMilli('-0'));
  assert.ok(isZeroMilli(''));
  assert.ok(isZeroMilli(null));
  assert.ok(!isZeroMilli('-1'));
});

// ═══ دفتر الأستاذ العام (§7.5) ═══

const line = (id: string, over: Partial<GeneralLedgerLineJson> = {}): GeneralLedgerLineJson => ({
  id, moveId: `mv-${id}`, accountId: 'acc-1', date: '2026-01-05', originalDate: null, lateArrival: false,
  seq: 1, moveNumber: `MISC/2026/${id}`, moveState: 'POSTED', moveType: 'ENTRY', journalId: 'j1',
  journalCode: 'MISC', journalName: 'متنوّعة', partnerId: null, partnerName: null, salesRepId: null,
  salesRepName: null, analyticAccountId: null, label: 'بيان', debitMilli: '1000', creditMilli: '0',
  runningMilli: '1000', draft: false, closing: false, excluded: false, shifted: false, ...over,
});

const section = (over: Partial<GeneralLedgerSectionJson> = {}): GeneralLedgerSectionJson => ({
  account: { id: 'acc-1', code: '111001', name: 'الصندوق', nameI18n: null, type: 'asset_cash' },
  openingMilli: '0', closingOpeningMilli: '0', openingBalanceMilli: '0', debitMilli: '3000', creditMilli: '0',
  closingExcluded: false, closingDebitMilli: '0', closingCreditMilli: '0', closingMilli: '0',
  endingMilli: '3000', endingBalanceMilli: '3000', lineCount: 3, page: 1, pageSize: 2, pageCount: 2,
  offset: 0, carriedForwardMilli: '0', carriedOutMilli: '2000', hasMore: true,
  lines: [line('l1'), line('l2', { runningMilli: '2000' })], nextCursor: 'cur-2', ...over,
});

const nextChunk: LedgerPageChunk = {
  accountId: 'acc-1', offset: 2, carriedForwardMilli: '2000',
  lines: [line('l3', { runningMilli: '3000' })], nextCursor: null, hasMore: false,
};

test('ledgerSectionView: الصفحة الأولى وحدها قبل التحميل، ومؤشّرها معلن', () => {
  const v = ledgerSectionView(section());
  assert.equal(v.chunks.length, 1);
  assert.equal(v.loadedCount, 2);
  assert.equal(v.lineCount, 3);
  assert.equal(v.hasMore, true);
  assert.equal(v.nextCursor, 'cur-2');
});

test('ledgerSectionView: الصفحة التالية تُضمّ بترتيبها وتحمل رصيدها المُرحَّل ويتوقف الطلب عند الاكتمال', () => {
  const v = ledgerSectionView(section(), [nextChunk]);
  assert.deepEqual(v.chunks.map(c => c.offset), [0, 2]);
  assert.deepEqual(v.chunks[1].lines.map(l => l.id), ['l3']);
  assert.equal(v.chunks[1].carriedForwardMilli, '2000');
  assert.equal(v.loadedCount, 3);
  assert.equal(v.hasMore, false);
  assert.equal(v.nextCursor, null);
});

test('ledgerSectionView: صفحة حسابٍ آخر لا تتسرّب، وhasMore يكذّب الخادم إن اكتملت السطور', () => {
  const other: LedgerPageChunk = { ...nextChunk, accountId: 'acc-9' };
  assert.equal(ledgerSectionView(section(), [other]).loadedCount, 2);
  assert.equal(ledgerSectionView(section({ lineCount: 2 })).hasMore, false);
});

test('appendLedgerChunk: النقر مرتين لا يضاعف سطراً، والترتيب بالحساب ثم الإزاحة', () => {
  const c = (accountId: string, offset: number): LedgerPageChunk => ({
    accountId, offset, carriedForwardMilli: '0', lines: [line(`x${offset}`)], nextCursor: null, hasMore: false,
  });
  let chunks = [c('acc-1', 0)];
  chunks = appendLedgerChunk(chunks, c('acc-1', 2));
  chunks = appendLedgerChunk(chunks, c('acc-1', 2));
  assert.deepEqual(chunks.map(x => x.offset), [0, 2]);
  chunks = appendLedgerChunk(chunks, c('acc-1', 1));
  chunks = appendLedgerChunk(chunks, c('acc-0', 5));
  assert.deepEqual(chunks.map(x => `${x.accountId}:${x.offset}`), ['acc-0:5', 'acc-1:0', 'acc-1:1', 'acc-1:2']);
});

test('chunkOfSection: صفحة الردّ كما هي (موضعها ورصيدها ومؤشّرها)', () => {
  assert.deepEqual(chunkOfSection(section()), {
    accountId: 'acc-1', offset: 0, carriedForwardMilli: '0',
    lines: section().lines, nextCursor: 'cur-2', hasMore: true,
  });
});

test('ledgerSectionsWithMore: الأقسام التي بقي فيها سطور وحدها (مصدر أزرار التحميل)', () => {
  const full = section({ lineCount: 2, hasMore: false, nextCursor: null });
  assert.deepEqual(ledgerSectionsWithMore([section(), full]).map(x => x.section.account.id), ['acc-1']);
  assert.equal(ledgerSectionsWithMore([full]).length, 0);
  assert.equal(ledgerSectionsWithMore([section()], [nextChunk]).length, 0);
});

test('generalLedgerColumns: أعمدة §7.5 بترتيبها (البيان عمود الشجرة في القشرة)', () => {
  assert.deepEqual(generalLedgerColumns(ctx).map(c => c.label), [
    'التاريخ', 'الرقم', 'الدفتر', 'الشريك', 'المندوب', 'مدين', 'دائن', 'رصيد جارٍ',
  ]);
});

test('generalLedgerLineNode: رابط القيد من رقمه، والرصيد الجاري كما يعيده الخادم', () => {
  const n = generalLedgerLineNode(line('l1'), ctx);
  assert.equal(n.id, 'l1');
  assert.equal(n.label, 'بيان');
  assert.deepEqual(n.cells[1], { kind: 'text', text: 'MISC/2026/l1', href: '/app/ledger/entries/mv-l1' });
  assert.deepEqual(n.cells[5], { kind: 'amount', milli: '1000', blankZero: true });
  assert.deepEqual(n.cells[7], { kind: 'amount', milli: '1000' });
});

test('generalLedgerLineNode: الوسوم في البيان، والمسودة بلا رقم لا تكسر الرابط', () => {
  const n = generalLedgerLineNode(line('l9', { draft: true, moveNumber: null, closing: true, excluded: true }), ctx);
  assert.equal(n.label, 'بيان · مسودة · قيد إقفال السنة · منقول إلى أرباح سنوات سابقة');
  assert.deepEqual(n.cells[1], { kind: 'text', text: 'مسودة', href: '/app/ledger/entries/mv-l9' });
  assert.deepEqual(ledgerLineTags(line('l1')), []);
});

test('generalLedgerLineNode: السطر المُزاح يعلن تاريخه الأصلي (ADR‑7)', () => {
  const n = generalLedgerLineNode(line('l1', { shifted: true, originalDate: '2025-12-31' }), ctx);
  const date = n.cells[0];
  assert.equal(date.kind, 'text');
  assert.match(date.kind === 'text' ? date.text : '', /مُزاح من/);
});

test('generalLedgerSectionNode: افتتاحي ثم السطور ثم الإجمالي، والصفحة الثانية تبدأ برصيد مُرحَّل', () => {
  const n = generalLedgerSectionNode(section(), ctx, [nextChunk]);
  assert.deepEqual(n.children?.map(c => c.id), [
    'acc-1:opening', 'l1', 'l2', 'acc-1:carried:2', 'l3', 'acc-1:total',
  ]);
  assert.equal(n.emphasis, 'section');
  assert.equal(n.code, '111001');
  // التعمّق لا يُعاد داخل دفتر الأستاذ نفسه
  assert.equal(n.accountId, null);
  const opening = n.children?.[0];
  assert.deepEqual(opening?.cells[7], { kind: 'amount', milli: '0', strong: true });
  const carried = n.children?.[3];
  assert.deepEqual(carried?.cells[7], { kind: 'amount', milli: '2000', strong: true });
});

test('generalLedgerSectionNode: صفّ عدٍّ صريح ما بقيت سطور، وصفّ بنود الإقفال المفصولة (§7.2)', () => {
  const partial = generalLedgerSectionNode(section(), ctx);
  const ids = partial.children?.map(c => c.id) ?? [];
  assert.ok(ids.includes('acc-1:more'), 'لا صفّ يعلن أنّ السطور لم تكتمل');
  assert.match(partial.children?.find(c => c.id === 'acc-1:more')?.label ?? '', /2 \/ 3/);

  const closing = generalLedgerSectionNode(
    section({ closingExcluded: true, closingMilli: '-4000', closingDebitMilli: '0', closingCreditMilli: '4000' }),
    ctx,
    [nextChunk],
  );
  const closingRow = closing.children?.find(c => c.id === 'acc-1:closing');
  assert.ok(closingRow, 'بنود الإقفال المفصولة لا تظهر صفّاً');
  assert.deepEqual(closingRow?.cells[6], { kind: 'amount', milli: '4000', blankZero: true });
  // حساب ميزانية: بنوده تبقى في حركته فلا صفّ إقفال مستقلّ
  assert.equal(
    generalLedgerSectionNode(section({ closingExcluded: false, closingMilli: '-4000' }), ctx).children
      ?.some(c => c.id === 'acc-1:closing'),
    false,
  );
});

test('generalLedgerTable: قسمٌ لكل حساب بأعمدة §7.5', () => {
  const data = { rows: [section()] } as unknown as GeneralLedgerResponse;
  const t = generalLedgerTable(data, ctx);
  assert.equal(t.columns.length, 8);
  assert.deepEqual(t.nodes.map(n => n.id), ['account:acc-1']);
  assert.equal(generalLedgerTable({ rows: [] } as unknown as GeneralLedgerResponse, ctx).nodes.length, 0);
});

// ═══ حرّاس المصدر ═══

const pageSrc = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'ledger', 'reports', f), 'utf8');

test('الصفحتان قشرةٌ فوق ReportView: لا جلب ولا تصدير ولا تنسيق مبلغ فيهما', () => {
  for (const f of ['TrialBalancePage.tsx', 'GeneralLedgerPage.tsx']) {
    const s = pageSrc(f);
    assert.match(s, /ReportView/, `${f} لا يستعمل القشرة المشتركة`);
    assert.doesNotMatch(s, /html2canvas|exportExcel|jspdf/i, `${f} يصدّر مما على الشاشة (§7.1 البند 4)`);
    assert.doesNotMatch(s, /milliToUnitString|milliToDecimalString|LedgerAmount/, `${f} ينسّق مبلغاً بنفسه`);
    assert.doesNotMatch(s, /from '\.\.\/\.\.\/\.\.\/api\/client'/, `${f} يستدعي النقطة مباشرةً بدل عميل التقارير`);
  }
});

test('دفتر الأستاذ يستعمل منتقي الحساب القائم ولا يكرّره', () => {
  const s = pageSrc('GeneralLedgerPage.tsx');
  assert.match(s, /AccountPickerDialog/);
  assert.doesNotMatch(s, /ledgerConfigApi\.accounts\.list/, 'قائمة حسابات ثانية بدل المنتقي القائم');
});

test('التحويلات صرفة: لا React ولا axios في reportRows.ts', () => {
  const s = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'ledger', 'reports', 'reportRows.ts'), 'utf8');
  assert.doesNotMatch(s, /from 'react'/);
  assert.doesNotMatch(s, /api\/client|axios/);
  // الأنواع وحدها من وحدات الواجهة، فلا يُحمَّل ReportView وقت الاختبار
  assert.match(s, /import type \{[^}]*\} from '\.\/ReportView'/s);
});
