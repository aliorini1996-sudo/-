import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGING_BUCKET_KEYS, ATTACHMENT_KINDS, ATTACHMENT_SOURCE_TYPES, DEFAULT_AGING_BUCKETS, PARTNER_REPORT_KEYS, PARTNER_SEARCH_TYPES, PARTNER_TYPES,
  agingColumnLabels, agingParams, agingRowBalanced, agingSearch, attachmentFileName, attachmentPreviewKind, carriedBalance,
  cleanPartnerParams, decodeDataUrl, formatBytes, isAttachmentSourceType, ledgerMoveHref, parseAgingBucketsInput, partnerLedgerBalanced,
  partnerHintText, partnerLedgerHref, partnerLedgerParams, partnerLedgerSearch, partnerReportTitles, partnerWarningText, partnerWarningTone,
  productLedgerParams, productLedgerSearch, readAgingState, readPartnerLedgerState, readProductLedgerState, readRangeState, roundQuantity, toMilli,
  type AgingData, type LateArrivalsData, type PartnerLedgerData, type PartnerLedgerLine, type ProductLedgerData,
} from '../../../api/ledgerPartners';
import {
  buildReportTable, exportRequestBody, isPartnerExportKey, makeAmountFormatter, makeQuantityFormatter, reportFileName, reportMetaRows,
  reportTitle, tableToPdfRows, tableToSheet, type ReportExportData,
} from './exportReport';
import { LEDGER_ROUTES, ledgerMenus } from '../routes';

/**
 * «ربط الدفاتر» L8 — واجهة تقارير الشركاء (A12، عقد L4/L5/L8 §6.2–§6.4). كل ما هنا **صرف** (لا شبكة ولا DOM):
 *
 * - الحالة في العنوان ⇄ معاملات النقطة (رابط قابل للمشاركة، والافتراضي لا يُرسل).
 * - **الدقة بالملّي**: «رصيد مُرحَّل» أعلى الصفحة، و«الافتتاح + الحركة = الختام»، وصفّ الأعمار = مجموع أعمدته — بلا جمع عائم.
 * - التصدير XLSX وPDF عبر `exportReport.ts` القائم بأمثلة العقد المحلولة (E4.1، E4.5، E4.7، E4.8، E8.1، E8.2، E8.4):
 *   المبالغ خلايا رقمية بمنازل العملة، والكمية بمنازلها لا بمنازل العملة.
 * - مرآة الخادم: المفاتيح والأنواع ومصادر المرفقات حرفاً كما في `backend/src/{routes,services/gl/reports}`.
 * - العارض: صور آمنة وPDF من رابط كائن، وغيرهما (SVG) تنزيلٌ فقط.
 */

const tr = (ar: string) => ar;
const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const backend = (...p: string[]) => fs.readFileSync(path.resolve(root, '..', 'backend', 'src', ...p), 'utf8');

/** قائمة النصوص في `export const NAME = [ ... ] as const` من ملف خادم */
function serverList(src: string, name: string): string[] {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(src);
  assert.ok(m, `لم يُعثر على ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

// ═══ مرآة الخادم ═══

test('مرآة الخادم: مفاتيح التقارير وأنواع الشريك والبحث وأعمدة الأعمار ومصادر المرفقات وأنواعها حرفاً', () => {
  assert.deepEqual([...PARTNER_REPORT_KEYS], serverList(backend('routes', 'ledger', 'partnerReports.ts'), 'PARTNER_REPORT_KEYS'));
  assert.deepEqual([...PARTNER_TYPES], serverList(backend('services', 'gl', 'reports', 'partnerLedger.ts'), 'PARTNER_TYPES'));
  assert.deepEqual([...PARTNER_SEARCH_TYPES], serverList(backend('services', 'gl', 'reports', 'partnerLoad.prisma.ts'), 'PARTNER_SEARCH_TYPES'));
  assert.deepEqual([...AGING_BUCKET_KEYS], serverList(backend('services', 'gl', 'reports', 'aging.ts'), 'AGING_BUCKET_KEYS'));
  assert.deepEqual([...ATTACHMENT_SOURCE_TYPES], serverList(backend('routes', 'ledger', 'sourceAttachments.ts'), 'ATTACHMENT_SOURCE_TYPES'));
  assert.deepEqual([...ATTACHMENT_KINDS], serverList(backend('services', 'gl', 'reports', 'partnerLoad.prisma.ts'), 'ATTACHMENT_KINDS'));
  assert.match(backend('services', 'gl', 'reports', 'aging.ts'), /DEFAULT_AGING_BUCKETS: readonly number\[\] = \[30, 60, 90, 120\]/);
  assert.deepEqual([...DEFAULT_AGING_BUCKETS], [30, 60, 90, 120]);
});

test('العناوين = نصوص عناصر القائمة حرفياً، وكل مفتاح مسجَّل في الجدول', () => {
  const titles = partnerReportTitles(tr);
  const items = ledgerMenus(tr).flatMap(m => m.sections.flatMap(s => s.items));
  for (const k of PARTNER_REPORT_KEYS) {
    const item = items.find(i => i.kind === 'route' && i.path === `reports/${k}`);
    assert.ok(item, k);
    assert.equal(item.label, titles[k], k);
    assert.equal(reportTitle(k, tr), titles[k], `عنوان الملف ${k}`);
    assert.ok(LEDGER_ROUTES.some(r => r.path === `reports/${k}` && r.view === 'canViewLedger' && r.write === null), k);
  }
});

// ═══ الحالة في العنوان ═══

test('دفتر الشريك: العنوان ⇄ الحالة ⇄ المعاملات، والافتراضي لا يُكتب ولا يُرسل', () => {
  const s = readPartnerLedgerState('type=vendor&partner=v1&pname=%D9%85%D9%88%D8%B1%D8%AF&from=2026-01-01&to=2026-06-30&reconciled=0&page=3');
  assert.deepEqual(s, { type: 'vendor', partnerId: 'v1', partnerName: 'مورد', from: '2026-01-01', to: '2026-06-30', includeReconciled: false, page: 3 });
  assert.deepEqual(readPartnerLedgerState(new URLSearchParams(partnerLedgerSearch(s))), s, 'ذهاب وإياب');
  assert.deepEqual(partnerLedgerParams(s), { partnerType: 'vendor', partnerId: 'v1', from: '2026-01-01', to: '2026-06-30', includeReconciled: false, page: 3 });

  const d = readPartnerLedgerState('type=hacker&from=2026-02-30x&page=-4&partner=');
  assert.deepEqual(d, { type: 'customer', partnerId: null, partnerName: null, from: null, to: null, includeReconciled: true, page: 1 });
  assert.equal(partnerLedgerParams(d), null, 'لا شريك ⇒ لا طلب');
  assert.deepEqual(partnerLedgerSearch(d), { type: 'customer' });
  const min = partnerLedgerParams({ ...d, partnerId: 'c1' });
  assert.deepEqual(min, { partnerType: 'customer', partnerId: 'c1' }, 'الافتراضي (المطابَقة معروضة، صفحة 1، مدى الخادم) لا يُرسل');

  const href = partnerLedgerHref({ type: 'customer', id: 'c 1', name: 'عميل', to: '2027-01-20' });
  assert.ok(href.startsWith('/app/ledger/reports/partner-ledger?'));
  assert.deepEqual(readPartnerLedgerState(href.split('?')[1]), {
    type: 'customer', partnerId: 'c 1', partnerName: 'عميل', from: null, to: '2027-01-20', includeReconciled: true, page: 1,
  });
  assert.equal(ledgerMoveHref('m/1'), '/app/ledger/entries/m%2F1');
});

test('الأعمار: أعمدة الأيام بتحقّق الخادم نفسه، والافتراضي لا يُرسل', () => {
  assert.deepEqual(parseAgingBucketsInput('30,60,90,120'), [30, 60, 90, 120]);
  assert.deepEqual(parseAgingBucketsInput(' ١٥، ٣٠ ، ٤٥ , ٦٠ '), [15, 30, 45, 60], 'أرقام عربية وفاصلة عربية ومسافات');
  assert.deepEqual(parseAgingBucketsInput(''), [30, 60, 90, 120]);
  for (const bad of ['30,60,90', '30,60,60,90', '0,30,60,90', '30,60,90,4000', '30,60,x,90', '30.5,60,90,120', '30,60,90,120,150']) {
    assert.equal(parseAgingBucketsInput(bad), null, bad);
  }
  const s = readAgingState('asOf=2027-01-20&basis=date&buckets=15,30,45,60&partner=c1&pname=C');
  assert.deepEqual(s, { asOf: '2027-01-20', basis: 'date', buckets: [15, 30, 45, 60], partnerId: 'c1', partnerName: 'C' });
  assert.deepEqual(agingParams(s), { asOf: '2027-01-20', basis: 'date', buckets: '15,30,45,60', partnerId: 'c1' });
  assert.deepEqual(readAgingState(new URLSearchParams(agingSearch(s))), s);
  const d = readAgingState('buckets=1,2&basis=x');
  assert.deepEqual(agingParams(d), {}, 'أعمدة غير صالحة في الرابط ⇒ الافتراضي، وأساس مجهول ⇒ الاستحقاق');
  const l = agingColumnLabels([30, 60, 90, 120], tr, 'AR');
  assert.deepEqual([l.notDue, l.b1, l.b2, l.b3, l.b4, l.older], ['غير مستحق', '1–30', '31–60', '61–90', '91–120', 'أقدم من 120']);
  assert.equal(agingColumnLabels([30, 60, 90, 120], tr, 'AP').unappliedCredits, 'دفعات مقدمة غير مخصّصة');
});

test('الأصناف والمدى: الفلاتر الثلاثة بأسمائها، ولا اسمٌ بلا معرّف', () => {
  const s = readProductLedgerState('from=2026-11-01&to=2026-11-30&product=p1&productName=P1&customer=c1&customerName=C&rep=r1&repName=R');
  assert.deepEqual(productLedgerParams(s), { from: '2026-11-01', to: '2026-11-30', productId: 'p1', customerId: 'c1', salesRepId: 'r1' });
  assert.deepEqual(readProductLedgerState(new URLSearchParams(productLedgerSearch(s))), s);
  const orphan = readProductLedgerState('productName=X&repName=Y');
  assert.equal(orphan.productName, null);
  assert.equal(orphan.salesRepName, null);
  assert.deepEqual(readRangeState('from=2026-13-01&to=2026-11-30'), { from: null, to: '2026-11-30' });
  assert.deepEqual(cleanPartnerParams({ a: '', b: null, c: undefined, d: false, e: 0, f: 'x' }), { d: false, e: 0, f: 'x' }, 'false و0 يبقيان');
});

// ═══ الدقة بالملّي ═══

/** E4.1 + E8.1: قسطا INV-1001 (575 + 575) وسند 600 مخصّص لها — بعد المطابقة RI:x 575 و25 */
function e81Ledger(over: Partial<PartnerLedgerData> = {}): PartnerLedgerData {
  const line = (o: Partial<PartnerLedgerLine>): PartnerLedgerLine => ({
    lineId: 'l', moveId: 'm', moveNumber: null, date: '2026-11-14', journalCode: 'INV', ref: null, label: null, sourceType: 'INVOICE',
    sourceId: 'inv1', debit: 0, credit: 0, balance: 0, dueDate: null, residual: 0, fullyReconciled: false, matches: [], productId: null,
    productName: null, quantity: null, attachments: { count: 0, kinds: [] }, ...o,
  });
  return {
    reportKey: 'partner-ledger',
    settings: { currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', linked: true },
    warnings: [],
    partner: { type: 'customer', id: 'C', name: 'العميل C' },
    currency: 'SAR', decimals: 2, from: '2026-11-01', to: '2027-01-31', includeReconciled: true,
    opening: 0, closing: 550, totalDebit: 1150, totalCredit: 600,
    lines: [
      line({ lineId: 'i1', moveId: 'mInv', moveNumber: 'INV-1001', ref: 'INV-1001', debit: 575, balance: 575, dueDate: '2026-12-14', residual: 0, fullyReconciled: true,
        matches: [{ lineId: 'r1', moveId: 'mRc', moveNumber: 'RCPT-1', amount: 575 }] }),
      line({ lineId: 'i2', moveId: 'mInv', moveNumber: 'INV-1001', ref: 'INV-1001', debit: 575, balance: 1150, dueDate: '2027-01-13', residual: 550,
        matches: [{ lineId: 'r1', moveId: 'mRc', moveNumber: 'RCPT-1', amount: 25 }] }),
      line({ lineId: 'r1', moveId: 'mRc', moveNumber: 'RCPT-1', journalCode: 'RCPT', sourceType: 'RECEIPT', sourceId: 'rc1', date: '2026-11-20', credit: 600,
        balance: 550, residual: 0, fullyReconciled: true, attachments: { count: 2, kinds: ['RECEIPT_PHOTO'] },
        matches: [{ lineId: 'i1', moveId: 'mInv', moveNumber: 'INV-1001', amount: 575 }, { lineId: 'i2', moveId: 'mInv', moveNumber: 'INV-1001', amount: 25 }] }),
    ],
    documents: { count: 1 },
    pagination: { page: 1, pageSize: 100, total: 3, pages: 1, paginated: true },
    lineCount: 3,
    ...over,
  };
}

test('E8.1: الافتتاح + الحركة = الختام بالملّي، و«رصيد مُرحَّل» أعلى الصفحة التالية دقيق بلا غبار عائم', () => {
  const d = e81Ledger();
  assert.equal(partnerLedgerBalanced(d), true);
  assert.equal(partnerLedgerBalanced({ ...d, closing: 550.01 }), false, 'فرق ملّي واحد يُلتقط');
  // المتبقّي المفتوح = القسط الثاني 550 (E8.1)، ومطابقتا RI:x = 575 + 25 = السند 600
  assert.equal(d.lines.reduce((s, l) => s + toMilli(l.residual), 0n), 550_000n);
  assert.equal(d.lines[2].matches.reduce((s, m) => s + toMilli(m.amount), 0n), toMilli(d.lines[2].credit));

  assert.equal(carriedBalance(d), 0, 'الصفحة الأولى ⇒ الافتتاح');
  // الصفحة الثانية تبدأ بالسند: الرصيد قبله = 550 − 0 + 600 = 1150 تماماً
  const p2 = { ...d, lines: [d.lines[2]], pagination: { ...d.pagination, page: 2 } };
  assert.equal(carriedBalance(p2), 1150);
  // 0.1 + 0.2 عائماً ≠ 0.3 — بالملّي تماماً
  const dust = { opening: 0, lines: [{ ...d.lines[0], balance: 0.3, debit: 0.1, credit: 0 }], pagination: { page: 2 } };
  assert.equal(carriedBalance(dust), 0.2);
  assert.equal(toMilli(1.099), 1099n);
  assert.equal(toMilli(-0.005), -5n);
  assert.equal(toMilli(Number.NaN), 0n);
});

test('E8.2: صفّ الأعمار = مجموع أعمدته (بالملّي)، والأرصدة غير المخصّصة سالبة داخل الإجمالي', () => {
  const row = { notDue: 0, b1: 550, b2: 0, b3: 0, b4: 0, older: 0, unappliedCredits: 0, total: 550 };
  assert.equal(agingRowBalanced(row), true);
  assert.equal(agingRowBalanced({ ...row, unappliedCredits: -200, total: 350 }), true);
  assert.equal(agingRowBalanced({ ...row, total: 550.001 }), false);
});

// ═══ التصدير (exportReport.ts القائم) ═══

const asExport = (d: object, format: 'xlsx' | 'pdf' = 'xlsx'): ReportExportData =>
  ({ ...d, format, cap: format === 'xlsx' ? 50_000 : 5_000, paginated: false }) as unknown as ReportExportData;
const col = (t: ReturnType<typeof buildReportTable>, label: string) => {
  const i = t.columns.findIndex(c => c.label === label);
  assert.ok(i >= 0, `عمود غائب: ${label}`);
  return i;
};

test('دفتر الشريك (E8.1): صفّ افتتاح يتكرر في PDF، وسطور بأرقام، وإجمالي بالختام، وأعمدة الذمم للعميل وحده', () => {
  const t = buildReportTable(asExport(e81Ledger()), tr);
  assert.equal(t.columns[0].label, 'المستوى');
  assert.equal(t.columns[t.indentIndex].label, 'البيان');
  for (const l of ['التاريخ', 'رقم القيد', 'المستند', 'الاستحقاق', 'مدين', 'دائن', 'الرصيد', 'المتبقّي', 'المطابقات', 'المرفقات']) col(t, l);
  assert.equal(t.columns.findIndex(c => c.label === 'الكمية'), -1, 'لا عمود صنف حين لا صنف');
  assert.equal(t.rows.length, 5, 'افتتاح + 3 سطور + إجمالي');
  const [open, i1, i2, rc, total] = t.rows;
  assert.equal(open.carry, true);
  assert.equal(open.cells[t.indentIndex], 'العميل C — الرصيد الافتتاحي');
  assert.equal(open.cells[col(t, 'الرصيد')], 0);
  assert.deepEqual([i1.cells[col(t, 'مدين')], i1.cells[col(t, 'الاستحقاق')], i1.cells[col(t, 'المتبقّي')]], [575, '2026-12-14', 0]);
  assert.match(String(i1.cells[col(t, 'المطابقات')]), /^مطابَق كلياً — RCPT-1: 575\.00$/);
  assert.deepEqual([i2.cells[col(t, 'المتبقّي')], i2.cells[col(t, 'المطابقات')]], [550, 'RCPT-1: 25.00']);
  assert.equal(rc.cells[col(t, 'المستند')], 'سند قبض');
  assert.equal(rc.cells[col(t, 'المرفقات')], 2);
  assert.deepEqual([total.cells[col(t, 'مدين')], total.cells[col(t, 'دائن')], total.cells[col(t, 'الرصيد')]], [1150, 600, 550]);
  // كل مبلغ رقمٌ لا نصّ
  for (const r of t.rows) for (const l of ['مدين', 'دائن', 'الرصيد']) {
    const v = r.cells[col(t, l)];
    assert.ok(v === null || typeof v === 'number', `${l}: ${v}`);
  }

  // المندوب (عهدة 111003): بلا استحقاق ولا متبقٍّ ولا مطابقات
  const rep = buildReportTable(asExport(e81Ledger({ partner: { type: 'rep', id: 'R', name: 'المندوب R' } })), tr);
  for (const l of ['الاستحقاق', 'المتبقّي', 'المطابقات']) assert.equal(rep.columns.findIndex(c => c.label === l), -1, l);
});

test('E4.1: عمودا الصنف والكمية — الكمية بمنازلها (240 كرتون×24) لا بمنازل العملة، وE4.8 بصفر منازل لا يقرّب 2.5', () => {
  const base = e81Ledger();
  const rev = { ...base.lines[0], lineId: 'rv', debit: 0, credit: 1000, balance: 150, productId: 'P', productName: 'الصنف P', quantity: 240 };
  const half = { ...rev, lineId: 'rv2', credit: 3000, productName: 'نصف كرتون', quantity: 2.5 };
  const iqd = e81Ledger({ settings: { ...base.settings, currency: 'IQD', currencyDecimals: 0 }, lines: [rev, half] });
  const t = buildReportTable(asExport(iqd), tr);
  const q = col(t, 'الكمية');
  assert.equal(t.columns[q].decimals, 4);
  assert.deepEqual([t.rows[1].cells[q], t.rows[2].cells[q]], [240, 2.5]);
  const sheet = tableToSheet({ table: t, meta: [], sheetName: 'x', decimals: 0 });
  const qLabel = t.columns[q].label;
  assert.deepEqual(sheet.rows.slice(1, 3).map(r => r[qLabel]), [240, 2.5], 'XLSX: الكمية 2.5 لا تُقرَّب إلى 3 بمنازل الدينار العراقي');
  assert.equal(sheet.rows[2][t.columns[col(t, 'دائن')].label], 3000);
  const pdf = tableToPdfRows({ table: t, formatAmount: makeAmountFormatter(0, 'en-US'), formatQuantity: makeQuantityFormatter('en-US') });
  const pq = pdf.columns.findIndex(c => c.label === 'الكمية');
  assert.deepEqual([pdf.rows[1].cells[pq], pdf.rows[2].cells[pq]], ['240', '2.5']);
  assert.equal(pdf.rows[2].cells[pdf.columns.findIndex(c => c.label === 'دائن')], '3,000');
  assert.equal(pdf.rows[0].carry, true, 'صفّ الافتتاح يتكرر أعلى صفحات PDF');
});

test('E4.7: ثلاث منازل (دينار بحريني) — 1.099 خلية رقمية تامة في XLSX ونصّها في PDF', () => {
  const base = e81Ledger();
  const d = e81Ledger({
    settings: { ...base.settings, currency: 'BHD', currencyDecimals: 3 }, decimals: 3, opening: 0, totalDebit: 1.099, totalCredit: 0, closing: 1.099,
    lines: [{ ...base.lines[0], debit: 1.099, balance: 1.099, residual: 1.099, fullyReconciled: false, matches: [] }],
  });
  const t = buildReportTable(asExport(d), tr);
  const sheet = tableToSheet({ table: t, meta: [], sheetName: 'x', decimals: 3 });
  const debit = t.columns[col(t, 'مدين')].label;
  assert.equal(sheet.rows[1][debit], 1.099);
  assert.equal(sheet.rows[2][debit], 1.099, 'الإجمالي');
  const pdf = tableToPdfRows({ table: t, formatAmount: makeAmountFormatter(3, 'en-US') });
  assert.equal(pdf.rows[1].cells[pdf.columns.findIndex(c => c.label === 'مدين')], '1.099');
});

function e82Aging(detail: boolean): AgingData {
  return {
    reportKey: 'aged-receivable', kind: 'AR', partnerId: detail ? 'C' : null, asOf: '2027-01-20', basis: 'due', buckets: [30, 60, 90, 120],
    settings: { currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', linked: true }, warnings: [],
    rows: [{ partnerId: 'C', name: 'العميل C', notDue: 0, b1: 550, b2: 0, b3: 0, b4: 0, older: 0, unappliedCredits: -200, total: 350 }],
    totals: { notDue: 0, b1: 550, b2: 0, b3: 0, b4: 0, older: 0, unappliedCredits: -200, total: 350 },
    ...(detail ? {
      detail: [
        { lineId: 'i2', moveId: 'mInv', moveNumber: 'INV-1001', date: '2026-11-14', dueDate: '2027-01-13', daysOverdue: 7, residual: 550, bucket: 'b1' as const },
        { lineId: 'rt', moveId: 'mRet', moveNumber: 'RET-5', date: '2026-12-01', dueDate: null, daysOverdue: 50, residual: -200, bucket: 'unapplied' as const },
      ],
    } : {}),
  };
}

test('E8.2: الأعمار — القسط الثاني 550 في «1–30» في 2027‑01‑20، والدائن غير المخصّص سالباً، والتفصيل في أعمدته', () => {
  const t = buildReportTable(asExport(e82Aging(false)), tr);
  assert.deepEqual(t.columns.map(c => c.label), ['المستوى', 'العميل', 'غير مستحق', '1–30', '31–60', '61–90', '91–120', 'أقدم من 120', 'أرصدة دائنة غير مخصّصة', 'الإجمالي']);
  assert.deepEqual(t.rows[0].cells, [0, 'العميل C', 0, 550, 0, 0, 0, 0, -200, 350]);
  assert.deepEqual(t.rows[1].cells, [0, 'الإجمالي', 0, 550, 0, 0, 0, 0, -200, 350]);
  assert.equal(t.rows[1].strong, true);

  const dt = buildReportTable(asExport(e82Aging(true)), tr);
  assert.equal(dt.rows.length, 4, 'الشريك + بندان + الإجمالي');
  assert.deepEqual(dt.rows[1].cells, [1, 'INV-1001 · 2026-11-14 · الاستحقاق 2027-01-13 · 7 يوماً', null, 550, null, null, null, null, null, 550]);
  assert.deepEqual(dt.rows[2].cells, [1, 'RET-5 · 2026-12-01', null, null, null, null, null, null, -200, -200]);
  // مجموع بنود التفصيل = صفّ الشريك (بالملّي)
  const sum = (e82Aging(true).detail ?? []).reduce((s, x) => s + toMilli(x.residual), 0n);
  assert.equal(sum, toMilli(e82Aging(true).rows[0].total));

  const ap = buildReportTable(asExport({ ...e82Aging(false), reportKey: 'aged-payable', kind: 'AP' }), tr);
  assert.equal(ap.columns[1].label, 'المورّد');
  assert.equal(ap.columns[8].label, 'دفعات مقدمة غير مخصّصة');
});

test('E8.4: وصول متأخر — فاتورة 2026‑10‑02 رُحّلت 2026‑11‑01 بسبب إقفال الفترة، والإجمالي بعدده', () => {
  const d: LateArrivalsData = {
    reportKey: 'late-arrivals', from: '2026-11-01', to: '2026-11-30', cutoverDate: '2026-01-01',
    settings: { currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', linked: true }, warnings: [],
    rows: [
      { moveId: 'm1', moveNumber: 'INV/2026/0001', sourceType: 'INVOICE', sourceId: 'inv1', ref: 'INV-77', partnerName: 'C', originalDate: '2026-10-02', postedDate: '2026-11-01', reason: 'PERIOD_LOCKED', amount: 115 },
      { moveId: 'm2', moveNumber: 'RCPT/2026/0009', sourceType: 'RECEIPT', sourceId: 'rc9', ref: null, partnerName: null, originalDate: '2025-12-30', postedDate: '2026-11-02', reason: 'AFTER_CUTOVER', amount: 0.5 },
    ],
    total: 115.5, count: 2,
  };
  const t = buildReportTable(asExport(d), tr);
  assert.deepEqual(t.rows[0].cells, [0, 'INV/2026/0001', 'فاتورة', 'INV-77', 'C', '2026-10-02', '2026-11-01', 'تاريخه في فترة مقفلة', 115]);
  assert.equal(t.rows[1].cells[7], 'تاريخه قبل بداية الدفاتر');
  assert.deepEqual(t.rows[2].cells, [0, 'الإجمالي (2)', null, null, null, null, null, null, 115.5]);
});

test('E4.5: تقرير الأصناف — إيراد كل صنف وخصمه المنفصل، والصافي = الإيراد − الخصم − المردودات', () => {
  const d: ProductLedgerData = {
    reportKey: 'product-ledger', from: '2026-11-01', to: '2026-11-30', filters: { productId: null, customerId: 'c1', salesRepId: null },
    settings: { currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', linked: true }, warnings: [],
    rows: [
      { productId: 'P1', productName: 'P1', quantity: 2, soldQuantity: 2, returnedQuantity: 0, revenue: 100, discount: 10, returns: 0, net: 90 },
      { productId: 'P2', productName: 'P2', quantity: 1, soldQuantity: 1, returnedQuantity: 0, revenue: 100, discount: 10, returns: 0, net: 90 },
    ],
    totals: { quantity: 3, soldQuantity: 3, returnedQuantity: 0, revenue: 200, discount: 20, returns: 0, net: 180 },
  };
  for (const r of [...d.rows, d.totals]) assert.equal(toMilli(r.revenue) - toMilli(r.discount) - toMilli(r.returns), toMilli(r.net));
  const t = buildReportTable(asExport(d), tr);
  assert.deepEqual(t.columns.map(c => c.label), ['المستوى', 'الصنف', 'الكمية المباعة', 'الكمية المرتجعة', 'صافي الكمية', 'الإيراد', 'الخصم', 'المردودات', 'الصافي']);
  assert.deepEqual(t.columns.slice(2, 5).map(c => c.decimals), [4, 4, 4]);
  assert.deepEqual(t.rows[0].cells, [0, 'P1', 2, 0, 2, 100, 10, 0, 90]);
  assert.deepEqual(t.rows[2].cells, [0, 'الإجمالي', 3, 0, 3, 200, 20, 0, 180]);
  assert.equal(roundQuantity(0.1 + 0.2), 0.3, 'الكمية بلا غبار عائم');
  const meta = reportMetaRows({ data: asExport(d), tr, now: new Date('2026-11-14T10:00:00Z'), locale: 'en-US' });
  assert.deepEqual(meta.find(m => m.label === 'الخيارات')?.value, 'عميل محدد');
});

test('ترويسة الملف واسمه: الشريك والفترة والخيارات بلا اعتماد على options/period (ردّ تقارير الشركاء)', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  const pl = reportMetaRows({ data: asExport({ ...e81Ledger(), includeReconciled: false }), tr, now, locale: 'en-US', company: 'شركة' });
  const get = (rows: { label: string; value: string }[], l: string) => rows.find(r => r.label === l)?.value;
  assert.equal(get(pl, 'الشركة'), 'شركة');
  assert.equal(get(pl, 'التقرير'), 'دفتر أستاذ الشركاء');
  assert.equal(get(pl, 'الشريك'), 'عميل — العميل C');
  assert.equal(get(pl, 'الفترة'), '2026-11-01 — 2027-01-31');
  assert.equal(get(pl, 'الخيارات'), 'البنود غير المطابَقة وحدها');
  assert.equal(get(pl, 'العملة'), 'SAR');

  const ag = reportMetaRows({ data: asExport(e82Aging(true)), tr, now, locale: 'en-US' });
  assert.equal(get(ag, 'الشريك'), 'العميل C');
  assert.equal(get(ag, 'الفترة'), 'اعتباراً من 2027-01-20');
  assert.equal(get(ag, 'الخيارات'), 'حسب تاريخ الاستحقاق · الأعمدة: 30 / 60 / 90 / 120');

  assert.equal(reportFileName(asExport(e81Ledger()), tr), 'دفتر أستاذ الشركاء-العميل C-2026-11-01_2027-01-31');
  assert.equal(reportFileName(asExport(e82Aging(false)), tr), 'أعمار الذمم المدينة-2027-01-20');
  assert.equal(reportFileName(asExport({ ...e81Ledger(), partner: { type: 'customer', id: 'x', name: 'a/b:c' } }), tr).includes('/'), false);
  for (const k of PARTNER_REPORT_KEYS) assert.equal(isPartnerExportKey(k), true);
  for (const k of ['trial-balance', 'general-ledger', 'vat-return']) assert.equal(isPartnerExportKey(k), false);
});

test('جسم نقطة التصدير: المعاملات نفسها بلا ترقيم، و«غير المطابَقة» (false) لا تسقط', () => {
  const params = cleanPartnerParams(partnerLedgerParams(readPartnerLedgerState('type=customer&partner=c1&reconciled=0&page=4')));
  assert.deepEqual(exportRequestBody(params, 'pdf'), { partnerType: 'customer', partnerId: 'c1', includeReconciled: false, format: 'pdf' });
  assert.deepEqual(exportRequestBody(cleanPartnerParams(agingParams(readAgingState(''))), 'xlsx'), { format: 'xlsx' });
});

// ═══ التنبيهات والمرفقات ═══

test('التنبيهات: رموز التقارير الجديدة بنصّ مترجم، وRPT‑08 برسالته، والمسودات تحذير', () => {
  assert.equal(partnerWarningText({ code: 'RECONCILE_NOT_ACTIVE', message: 'x' }, tr).startsWith('المطابقة الآلية'), true);
  assert.equal(partnerWarningText({ code: 'PRODUCT_LINES_LINKED_ONLY', message: 'x' }, tr), 'الإيراد لكل صنف يُرحَّل في الدفاتر المربوطة وحدها');
  assert.equal(partnerWarningText({ code: 'UNPOSTED_ENTRIES', message: 'رسالة الخادم' }, tr), 'رسالة الخادم');
  assert.equal(partnerWarningTone('UNPOSTED_ENTRIES'), 'amber');
  assert.equal(partnerWarningTone('RECONCILE_NOT_ACTIVE'), 'blue');
  // منتقي المستخدمين: الدور بتسميته لا برمزه، وتلميح غيره (الجوال) كما هو
  assert.equal(partnerHintText('user', 'ACCOUNTANT', tr), 'محاسب');
  assert.equal(partnerHintText('user', 'OWNER_X', tr), 'OWNER_X');
  assert.equal(partnerHintText('customer', '0500000000', tr), '0500000000');
  assert.equal(partnerHintText('product', null, tr), null);
});

test('العارض: صور الويب الآمنة وPDF وحدها تُعرض، وSVG وغيره تنزيلٌ فقط؛ وdata URL يُفكّ بايتاتٍ تامة', () => {
  for (const m of ['image/jpeg', 'IMAGE/PNG', 'image/webp', 'image/gif']) assert.equal(attachmentPreviewKind(m), 'image', m);
  assert.equal(attachmentPreviewKind('application/pdf'), 'pdf');
  for (const m of ['image/svg+xml', 'text/html', 'application/octet-stream', '', null]) assert.equal(attachmentPreviewKind(m), 'download', String(m));

  const png = decodeDataUrl('data:image/png;base64,iVBORw0KGgo=');
  assert.ok(png);
  assert.equal(png.mime, 'image/png');
  assert.deepEqual([...png.bytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pdf = decodeDataUrl('data:application/pdf;base64,JVBERi0=');
  assert.equal(Buffer.from(pdf!.bytes).toString('latin1'), '%PDF-');
  const txt = decodeDataUrl('data:text/plain,a%20b');
  assert.equal(new TextDecoder().decode(txt!.bytes), 'a b');
  for (const bad of ['', 'image/png;base64,AAA', 'data:image/png;base64', 'data:image/png;base64,%%%']) assert.equal(decodeDataUrl(bad), null, bad);

  assert.equal(attachmentFileName('صورة السند 1', 'image/jpeg'), 'صورة السند 1.jpg');
  assert.equal(attachmentFileName('scan.PDF', 'application/pdf'), 'scan.PDF');
  assert.equal(attachmentFileName('a/b:c', 'application/pdf'), 'a·b·c.pdf');
  assert.deepEqual([formatBytes(0), formatBytes(300), formatBytes(2048), formatBytes(1.5 * 1024 * 1024)], ['0 KB', '1 KB', '2 KB', '1.5 MB']);
  assert.equal(isAttachmentSourceType('CUSTOMER'), true);
  assert.equal(isAttachmentSourceType(null), false);
  assert.equal(isAttachmentSourceType('MANUAL'), false);
});

// ═══ حرّاس نصّية على الصفحات (بلا DOM) ═══

test('كل صفحة من الخمس فوق القشرة ذات زرّي XLSX وPDF من نقطة التصدير، وتعرض روابط المرفقات حيث لسطرها مستند', () => {
  const parts = read('src', 'pages', 'ledger', 'reports', 'parts', 'PartnerReportParts.tsx');
  assert.match(parts, /runExport\.mutate\('xlsx'\)/);
  assert.match(parts, /runExport\.mutate\('pdf'\)/);
  assert.match(parts, /await import\('\.\.\/exportReport'\)/, 'التصدير عبر وحدة التصدير القائمة (نقطة التصدير لا الشاشة)');
  const page = (f: string) => read('src', 'pages', 'ledger', 'reports', `${f}.tsx`);
  for (const f of ['PartnerLedgerPage', 'LateArrivalsPage', 'ProductLedgerPage']) assert.match(page(f), /<PartnerReportFrame/, f);
  for (const f of ['AgedReceivablePage', 'AgedPayablePage']) assert.match(page(f), /<AgingReportView kind="A[RP]" \/>/, f);
  // روابط المرفقات: سطور دفتر الشريك ووثائق العميل، وصفوف الوصول المتأخر، وصفّ العميل في الأعمار
  assert.match(page('PartnerLedgerPage'), /<AttachmentLinks sourceType=\{l\.sourceType\} sourceId=\{l\.sourceId\} moveId=\{l\.moveId\}/);
  assert.match(page('PartnerLedgerPage'), /<AttachmentLinks sourceType="CUSTOMER" sourceId=\{data\.partner\.id\}/);
  assert.match(page('LateArrivalsPage'), /<AttachmentLinks sourceType=\{r\.sourceType\} sourceId=\{r\.sourceId\}/);
  assert.match(parts, /<AttachmentLinks sourceType="CUSTOMER" sourceId=\{r\.partnerId\}/);
  assert.match(page('ProductLedgerPage'), /<AttachmentLinks sourceType="CUSTOMER" sourceId=\{state\.customerId\}/, 'وثائق العميل المفلتر به');
  // ومن كل سطر رابطٌ إلى قيده
  for (const f of ['PartnerLedgerPage', 'LateArrivalsPage']) assert.match(page(f), /<MoveLink moveId=/, f);
});

test('AttachmentLinks: المحتوى يُجلب للمرفق المنقور وحده، ولا data URL خام في img/object، والرابط يُحرَّر', () => {
  const src = read('src', 'pages', 'ledger', 'reports', 'parts', 'AttachmentLinks.tsx');
  assert.match(src, /enabled: open && supported/, 'القائمة الوصفية عند الفتح وحده');
  assert.match(src, /ledgerPartnersApi\.attachments\.content\(item\.kind, item\.id, sourceId\)/, 'المحتوى بمعرّف المصدر للتحقّق من الانتماء');
  assert.match(src, /URL\.createObjectURL\(new Blob/);
  assert.match(src, /URL\.revokeObjectURL\(file\.url\)/);
  assert.doesNotMatch(src, /src=\{[^}]*\.data\.data/, 'لا data URL خام في الصفحة');
  assert.match(src, /preview === 'image'/);
  assert.match(src, /preview === 'pdf'/);
});
