/**
 * نتيجة معاينة صالحة النوع (PreviewResult بمبالغ BigInt) لاختبارات P5 — المهمة والمسارات وقصّ النتيجة.
 * الأحجام قابلة للضبط لبناء نتيجة تتجاوز PREVIEW_RESULT_MAX_BYTES.
 */
import type { PreviewResult, ParityCheck, PreflightCheck } from '../services/gl/linking/types';
import { PARITY_CODES, PREFLIGHT_CODES } from '../services/gl/linking/types';

export interface ResultSizes {
  openingLines?: number;
  drillPerCheck?: number;
  heldLines?: number;
  itemsPerCheck?: number;
  uncosted?: number;
  tbRows?: number;
  tbZeroRows?: number;
  label?: string;
}

export function makePreviewResult(over: Partial<PreviewResult> = {}, sizes: ResultSizes = {}): PreviewResult {
  const label = sizes.label ?? 'بند';
  const parity: ParityCheck[] = PARITY_CODES.map((code, i) => ({
    code,
    titleAr: `مطابقة ${code}`,
    status: i < 4 ? 'OK' : 'NOT_AVAILABLE',
    scope: i < 4 ? 'FULL' : 'NONE',
    availableIn: i < 4 ? null : 'L6',
    reason: null,
    expectedMilli: 1_000n * BigInt(i + 1),
    actualMilli: 1_000n * BigInt(i + 1),
    diffMilli: 0n,
    drill: Array.from({ length: sizes.drillPerCheck ?? 2 }, (_, k) => ({
      partnerType: 'CUSTOMER' as const, partnerId: `c-${code}-${k}`, name: `${label} عميل ${k}`,
      expectedMilli: BigInt(k * 10), actualMilli: BigInt(k * 10), diffMilli: 0n, note: null, refs: [`ref-${k}`],
    })),
    drillTruncated: 0,
  }));
  const checks: PreflightCheck[] = PREFLIGHT_CODES.map((code) => ({
    code, level: 'W', ok: true, titleAr: `فحص ${code}`, details: 'لا شيء', count: 0, valueMilli: 0n, mode: 'FULL',
    items: Array.from({ length: sizes.itemsPerCheck ?? 1 }, (_, k) => ({ id: `${code}-${k}`, label: `${label} ${k}`, qty: k, valueMilli: BigInt(k) })),
  }));
  const months = ['2026-01', '2026-02'];
  const tbRow = (i: number, zero: boolean) => ({
    accountId: `acc-${i}`, accountCode: String(100000 + i), accountName: `${label} حساب ${i}`, accountType: 'ASSET',
    openingMilli: zero ? 0n : BigInt(i), months: months.map((m) => ({ month: m, debitMilli: zero ? 0n : 5n, creditMilli: 0n })),
    debitMilli: zero ? 0n : 10n, creditMilli: 0n, closingMilli: zero ? 0n : BigInt(i + 10),
  });
  const base: PreviewResult = {
    version: 1,
    tenantId: 't-1',
    basis: 'FY_RESTATED',
    linkedFrom: '2026-01-01',
    openingDate: '2025-12-31',
    snapshotAt: '2026-11-14T08:50:00.000Z',
    dbNow: '2026-11-14T09:00:00.000Z',
    currency: 'SAR',
    currencyDecimals: 2,
    timezone: 'Asia/Riyadh',
    templateKey: 'SA_6D',
    inventoryMode: 'PERPETUAL',
    dataHash: 'd'.repeat(64),
    resultHash: 'r'.repeat(64),
    opening: {
      date: '2025-12-31',
      lines: Array.from({ length: sizes.openingLines ?? 3 }, (_, k) => ({
        accountCode: '113001', accountName: 'ذمم العملاء', origin: 'DERIVED' as const, partnerType: 'CUSTOMER' as const,
        partnerId: `c-${k}`, partnerName: `${label} ${k}`, label: `رصيد افتتاحي — ${label} ${k}`, debitMilli: 1_230n + BigInt(k), creditMilli: 0n,
      })),
      linesTruncated: 0,
      byAccount: [{ accountCode: '113001', accountName: 'ذمم العملاء', debitMilli: 3_690n, creditMilli: 0n, lines: 3 }],
      totals: { debitMilli: 3_690n, creditMilli: 3_690n, derivedNetMilli: 3_690n, manualDebitMilli: 0n, manualCreditMilli: 0n, equityDiffMilli: 3_690n },
      manualIssues: [],
    },
    eventCounts: [{ sourceType: 'ACCOUNT_ENTRY', event: 'POST', status: 'DONE', reason: null, count: 3 }],
    trialBalanceByMonth: {
      months,
      rows: [
        ...Array.from({ length: sizes.tbRows ?? 2 }, (_, i) => tbRow(i, false)),
        ...Array.from({ length: sizes.tbZeroRows ?? 0 }, (_, i) => tbRow(100_000 + i, true)),
      ],
      totals: { openingMilli: 0n, debitMilli: 20n, creditMilli: 20n, closingMilli: 0n },
    },
    pnlYtd: { from: '2026-01-01', to: '2026-11-14', lines: [{ key: 'REVENUE', labelAr: 'الإيرادات', amountMilli: 9_990n, depth: 0 }], netMilli: 9_990n },
    balanceSheet: {
      asOf: '2026-11-14', lines: [{ key: 'ASSETS', labelAr: 'الأصول', amountMilli: 9_990n, depth: 0 }],
      assetsMilli: 9_990n, liabilitiesMilli: 0n, equityMilli: 9_990n, balanced: true,
    },
    vatByPeriodBox: [{ periodKey: '2026-Q1', from: '2026-01-01', to: '2026-03-31', box: 'SA_1', baseMilli: 100_000n, taxMilli: 15_000n }],
    parity,
    preflight: { mode: 'FULL', linkedFrom: '2026-01-01', basis: 'FY_RESTATED', checks, blocking: 0, warnings: 0 },
    heldLines: Array.from({ length: sizes.heldLines ?? 1 }, (_, k) => ({
      kind: 'EVENT' as const, sourceKey: `AE:${k}`, sourceType: 'ACCOUNT_ENTRY', status: 'HELD', reason: 'MISSING_ACCOUNT', detail: `${label} ${k}`,
      effectDate: '2026-02-01', amountMilli: 1_000n, partnerType: 'CUSTOMER' as const, partnerId: `c-${k}`, partnerName: `${label} ${k}`,
    })),
    heldTruncated: 0,
    costing: {
      summary: {
        moveCount: 10, productCount: 2,
        openingByLocation: [{ location: 'WH', qtyBase: 10, uncostedQty: 0, valueMilli: 2_000_000n }],
        nowByLocation: [{ location: 'WH', qtyBase: 140, uncostedQty: 0, valueMilli: 2_940_000n }],
        fyCogsMilli: 210_000n, fyVarianceMilli: 6_000n, fyWriteOffMilli: 63_000n,
        uncostedAtCutover: Array.from({ length: sizes.uncosted ?? 1 }, (_, k) => ({ productId: `p-${label}-${k}`, location: 'WH' as const, uncostedQty: 1 })),
        uncostedAtCutoverTotalQty: sizes.uncosted ?? 1,
        negativeAtCutover: [],
        holesFy: { count: 1, varianceMilli: 6_000n, sample: [{ key: 'COST:VAN_LOAD:x', productId: 'p-1', location: 'VAN:r2', varianceMilli: 6_000n }] },
        warnings: [{ code: 'HOLE_FILLED', count: 1, sample: ['COST:VAN_LOAD:x'] }],
      },
      sourceRows: { WH_ENTRY: 2, VAN_LOAD: 2, INVOICE: 4, RESTOCK_LOG: 0 },
    },
    eta: { eventsToPost: 3, msPerEvent: 40, offPeakBudgetMsPerMin: 20_000, peakBudgetMsPerMin: 5_000, etaMinutesOffPeak: 1, etaMinutesPeakOnly: 1 },
    storage: { rows: { events: 3, moves: 3, lines: 9, moveSources: 3, audits: 0, costSnapshots: 10, total: 28 }, bytesEstimate: 9_800, headroomNote: null },
    warnings: [],
    timings: [{ phase: 'READ', ms: 5 }],
  };
  return { ...base, ...over };
}
