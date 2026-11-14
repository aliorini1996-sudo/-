import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  agingRowBalanced, carriedBalance, partnerLedgerBalanced, toMilli,
  type AgingData, type LateArrivalsData, type PartnerLedgerData, type ProductLedgerData,
} from '../../../api/ledgerPartners';
import { buildReportTable, type ReportExportData } from './exportReport';

/**
 * «ربط الدفاتر» L8 — عقد الردّ بين الخادم والواجهة (A12 مقابل A10) **بالدوال الصرفة الحقيقية** في
 * `backend/src/services/gl/reports/*` (بلا قاعدة ولا شبكة): ما تُسلسله الخدمة تقرؤه أنواع `api/ledgerPartners.ts`
 * وجداول التصدير حرفياً، والأرقام تبقى تامة بالملّي من البناء إلى الملف — بأمثلة العقد E4.1 وE8.1 وE8.2 وE8.3 وE8.4.
 */

/**
 * الدوال الصرفة من الخادم باستيراد ديناميكي بمسار محسوب: tsx يشغّلها كما هي، و`tsc` الواجهة لا يتبعها — فلا يرتبط
 * فحص أنواع الواجهة بملفات الخادم (وعميل Prisma فيه) ولا تتعطّل الواجهة بتغيّر داخلي هناك.
 */
const serverReport = (file: string) =>
  import(pathToFileURL(path.resolve(process.cwd(), '..', 'backend', 'src', 'services', 'gl', 'reports', file)).href);
const { buildPartnerLedger, serializePartnerLedger } = await serverReport('partnerLedger.ts');
const { buildAging, serializeAging } = await serverReport('aging.ts');
const { buildLateArrivals, serializeLateArrivals } = await serverReport('lateArrivals.ts');
const { buildProductLedger, serializeProductLedger } = await serverReport('productLedger.ts');

const tr = (ar: string) => ar;
const settings = { currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', linked: true };
const asExport = (d: object): ReportExportData => ({ ...d, format: 'xlsx', cap: 50_000, paginated: false }) as unknown as ReportExportData;

/** E4.1 + E8.1: قسطا INV-1001 على 113001 وسند 600 مخصّص لها، والمطابقتان RI:x 575 و25 */
const e81Lines = [
  { lineId: 'i1', moveId: 'mInv', moveNumber: 'INV/0001', moveCreatedAt: 1, date: '2026-11-14', journalCode: 'INV', ref: 'INV-1001', label: 'فاتورة INV-1001',
    sourceType: 'INVOICE', sourceId: 'inv1', seq: 1, debitMilli: 575_000n, creditMilli: 0n, dueDate: '2026-12-14', productId: null, quantity: null },
  { lineId: 'i2', moveId: 'mInv', moveNumber: 'INV/0001', moveCreatedAt: 1, date: '2026-11-14', journalCode: 'INV', ref: 'INV-1001', label: 'فاتورة INV-1001',
    sourceType: 'INVOICE', sourceId: 'inv1', seq: 2, debitMilli: 575_000n, creditMilli: 0n, dueDate: '2027-01-13', productId: null, quantity: null },
  { lineId: 'r1', moveId: 'mRc', moveNumber: 'RCPT/0001', moveCreatedAt: 2, date: '2026-11-20', journalCode: 'RCPT', ref: 'R-1', label: 'سند قبض',
    sourceType: 'RECEIPT', sourceId: 'rc1', seq: 1, debitMilli: 0n, creditMilli: 600_000n, dueDate: null, productId: null, quantity: null },
];
const e81Partials = [
  { id: 'p1', debitLineId: 'i1', creditLineId: 'r1', debitMoveId: 'mInv', creditMoveId: 'mRc', amountMilli: 575_000n },
  { id: 'p2', debitLineId: 'i2', creditLineId: 'r1', debitMoveId: 'mInv', creditMoveId: 'mRc', amountMilli: 25_000n },
];

function ledgerJson(opts: { page?: number; pageSize?: number | null; includeReconciled?: boolean; partials?: typeof e81Partials; opening?: bigint } = {}): PartnerLedgerData {
  const l = buildPartnerLedger({
    partner: { type: 'customer', id: 'C', name: 'العميل C' }, currency: 'SAR', decimals: 2, from: '2026-11-01', to: '2027-01-31',
    openingMilli: opts.opening ?? 0n, lines: e81Lines, partials: opts.partials ?? e81Partials, includeReconciled: opts.includeReconciled ?? true,
    page: opts.page ?? 1, pageSize: opts.pageSize === undefined ? 100 : opts.pageSize,
  });
  const body = serializePartnerLedger(l, {
    moveNumbers: new Map([['mInv', 'INV/0001'], ['mRc', 'RCPT/0001']]),
    attachments: new Map([['r1', { count: 2, kinds: ['RECEIPT_PHOTO'] }]]),
    documentsCount: 1,
  });
  // JSON حقيقي كما يصل المتصفح: لا BigInt في الردّ (القاعدة 5)
  return JSON.parse(JSON.stringify({ reportKey: 'partner-ledger', settings, ...body, warnings: [] })) as PartnerLedgerData;
}

test('E8.1 عبر الخدمة الحقيقية: المتبقّي 550 على القسط الثاني، والافتتاح + الحركة = الختام، والمطابقات بأرقام قيودها', () => {
  const d = ledgerJson();
  assert.equal(partnerLedgerBalanced(d), true);
  assert.deepEqual(d.lines.map(l => [l.lineId, l.balance, l.residual, l.fullyReconciled]), [
    ['i1', 575, 0, true], ['i2', 1150, 550, false], ['r1', 550, 0, true],
  ]);
  assert.deepEqual(d.lines[2].matches.map(m => [m.moveNumber, m.amount]), [['INV/0001', 575], ['INV/0001', 25]]);
  assert.deepEqual(d.lines[2].attachments, { count: 2, kinds: ['RECEIPT_PHOTO'] });
  assert.equal(d.documents.count, 1);

  const t = buildReportTable(asExport(d), tr);
  const total = t.rows[t.rows.length - 1].cells;
  const at = (l: string) => t.columns.findIndex(c => c.label === l);
  assert.deepEqual([total[at('مدين')], total[at('دائن')], total[at('الرصيد')]], [1150, 600, 550]);
  assert.equal(t.rows[2].cells[at('المتبقّي')], 550);
});

test('الترقيم: «رصيد مُرحَّل» أعلى كل صفحة = رصيد آخر سطر في الصفحة السابقة تماماً (الخدمة تعطي الرصيد الجاري الصحيح)', () => {
  const full = ledgerJson({ pageSize: null, opening: 123_456n });
  for (let size = 1; size <= 3; size++) {
    for (let page = 1; page <= Math.ceil(full.lines.length / size); page++) {
      const d = ledgerJson({ page, pageSize: size, opening: 123_456n });
      const before = (page - 1) * size;
      const expected = before === 0 ? full.opening : full.lines[before - 1].balance;
      assert.equal(toMilli(carriedBalance(d)), toMilli(expected), `page ${page}/${size}`);
      assert.equal(partnerLedgerBalanced(d), true);
    }
  }
});

test('E8.3: عكس السند يفكّ المطابقتين فيعود المفتوح 1150، و«غير المطابَقة وحدها» يُبقي الثابت على المعروض', () => {
  const reversed = ledgerJson({ partials: [] });
  assert.equal(reversed.lines.filter(l => l.debit > 0).reduce((s, l) => s + toMilli(l.residual), 0n), 1_150_000n);
  const open = ledgerJson({ includeReconciled: false });
  assert.deepEqual(open.lines.map(l => l.lineId), ['i2']);
  assert.equal(partnerLedgerBalanced(open), true);
  const t = buildReportTable(asExport({ ...open, includeReconciled: false }), tr);
  assert.equal(t.rows.length, 3, 'افتتاح + سطر + إجمالي');
});

test('E8.2 عبر الخدمة الحقيقية: في 2027‑01‑20 القسط الثاني 550 في «1–30»، ومرتجع غير مطبّق سالباً، وكل صفّ متوازن', () => {
  const items = [
    { partnerId: 'C', lineId: 'i2', moveId: 'mInv', moveNumber: 'INV/0001', date: '2026-11-14', dueDate: '2027-01-13', residualMilli: 550_000n },
    { partnerId: 'C', lineId: 'rt', moveId: 'mRet', moveNumber: 'RET/0005', date: '2026-12-01', dueDate: null, residualMilli: -200_000n },
    { partnerId: 'D', lineId: 'd1', moveId: 'mD', moveNumber: 'INV/0002', date: '2026-08-01', dueDate: '2026-08-31', residualMilli: 1_000_001n },
  ];
  const names = new Map([['C', 'العميل C'], ['D', 'العميل D']]);
  const r = buildAging({ kind: 'AR', asOf: '2027-01-20', basis: 'due', buckets: [30, 60, 90, 120], items, names, detail: false });
  const d = JSON.parse(JSON.stringify({ reportKey: 'aged-receivable', settings, partnerId: null, ...serializeAging(r), warnings: [] })) as AgingData;
  const c = d.rows.find(x => x.partnerId === 'C')!;
  assert.deepEqual([c.notDue, c.b1, c.unappliedCredits, c.total], [0, 550, -200, 350]);
  const dd = d.rows.find(x => x.partnerId === 'D')!;
  assert.equal(dd.older, 1000.001, '142 يوماً ⇒ أقدم من 120، والملّي الثالث محفوظ');
  for (const row of [...d.rows, d.totals]) assert.equal(agingRowBalanced(row), true);
  const t = buildReportTable(asExport(d), tr);
  assert.deepEqual(t.rows[t.rows.length - 1].cells.slice(2), [0, 550, 0, 0, 0, 1000.001, -200, 1350.001]);
});

test('E8.4 عبر الخدمة الحقيقية: الإقفال ⇒ PERIOD_LOCKED، وما قبل البداية ⇒ AFTER_CUTOVER، والإجمالي بالملّي', () => {
  const built = buildLateArrivals([
    { moveId: 'm1', moveNumber: 'INV/0009', sourceType: 'INVOICE', sourceId: 'inv9', ref: 'INV-9', partnerName: 'C', date: '2026-11-01', originalDate: '2026-10-02', lateArrival: true, totalMilli: 115_000n },
    { moveId: 'm2', moveNumber: 'RCPT/0003', sourceType: 'RECEIPT', sourceId: 'rc3', ref: null, partnerName: null, date: '2026-01-01', originalDate: '2025-12-30', lateArrival: true, totalMilli: 1n },
    { moveId: 'm3', moveNumber: 'INV/0010', sourceType: 'INVOICE', sourceId: 'inv10', ref: null, partnerName: null, date: '2026-11-03', originalDate: null, lateArrival: false, totalMilli: 9n },
  ], { cutoverDate: '2026-01-01' });
  const d = JSON.parse(JSON.stringify({ reportKey: 'late-arrivals', settings, from: '2026-01-01', to: '2026-11-30', cutoverDate: '2026-01-01', ...serializeLateArrivals(built), warnings: [] })) as LateArrivalsData;
  assert.deepEqual(d.rows.map(r => [r.moveNumber, r.reason]), [['RCPT/0003', 'AFTER_CUTOVER'], ['INV/0009', 'PERIOD_LOCKED']]);
  const t = buildReportTable(asExport(d), tr);
  assert.deepEqual(t.rows.map(r => r.cells[7]), ['تاريخه قبل بداية الدفاتر', 'تاريخه في فترة مقفلة', null]);
  assert.deepEqual(t.rows[2].cells.slice(-1), [115.001]);
});

test('E4.5 عبر الخدمة الحقيقية: إيراد الصنف وخصمه ومردوده، والكمية بالوحدة الصغرى، والصافي تامّ', () => {
  const report = buildProductLedger({
    lines: [
      { productId: 'P1', accountId: 'a411', isReturnMove: false, debitMilli: 0n, creditMilli: 100_000n, creditQuantity: 2, debitQuantity: 0 },
      { productId: 'P1', accountId: 'a413', isReturnMove: false, debitMilli: 10_000n, creditMilli: 0n, creditQuantity: 0, debitQuantity: 0 },
      { productId: 'P2', accountId: 'a411', isReturnMove: false, debitMilli: 0n, creditMilli: 100_000n, creditQuantity: 1, debitQuantity: 0 },
      { productId: 'P2', accountId: 'a413', isReturnMove: false, debitMilli: 10_000n, creditMilli: 0n, creditQuantity: 0, debitQuantity: 0 },
      { productId: 'P1', accountId: 'a412', isReturnMove: true, debitMilli: 50_000n, creditMilli: 0n, creditQuantity: 0, debitQuantity: 1 },
    ],
    discountAccountIds: new Set(['a413']), returnsAccountIds: new Set(['a412']), names: new Map([['P1', 'P1'], ['P2', 'P2']]),
  });
  const d = JSON.parse(JSON.stringify({ reportKey: 'product-ledger', settings, from: '2026-11-01', to: '2026-11-30', filters: { productId: null, customerId: null, salesRepId: null }, ...serializeProductLedger(report), warnings: [] })) as ProductLedgerData;
  for (const r of [...d.rows, d.totals]) assert.equal(toMilli(r.revenue) - toMilli(r.discount) - toMilli(r.returns), toMilli(r.net));
  const t = buildReportTable(asExport(d), tr);
  assert.deepEqual(t.rows.map(r => r.cells.slice(1)), [
    ['P2', 1, 0, 1, 100, 10, 0, 90],
    ['P1', 2, 1, 1, 100, 10, 50, 40],
    ['الإجمالي', 3, 1, 2, 200, 20, 50, 130],
  ]);
});
