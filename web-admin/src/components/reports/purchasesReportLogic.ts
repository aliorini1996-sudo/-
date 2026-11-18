import { formatDayOnly, activeLocale } from '../../utils/format';
import { num, type ExcelSheet } from '../../utils/excel';
import type { AppliedRange } from '../../lib/reportsAccuracy';
import { baseQtyText, hasBigUnit } from '../../lib/adminUnits';
import type { UnitDef } from '../../lib/units';

/**
 * منطق «تقرير المشتريات» الصرف (بلا React ولا شبكة) — يستعمله PurchasesReport.tsx ويختبره purchasesReport.test.ts.
 * الردّ من GET /reports/purchases (backend/src/services/reports/purchasesReport.ts).
 */

export const PURCHASE_GROUP_BYS = ['vendor', 'product', 'day', 'month'] as const;
export type PurchaseGroupBy = (typeof PURCHASE_GROUP_BYS)[number];
export const isPurchaseGroupBy = (v: unknown): v is PurchaseGroupBy => (PURCHASE_GROUP_BYS as readonly unknown[]).includes(v);

/** أعمدة المال كما يرسلها الخادم — مفاتيح الضريبة غائبة مع «إزالة الضريبة» */
export interface PurchaseMoney {
  net: number; tax?: number; total: number;
  returns: number; returnsTax?: number; returnsTotal: number;
  netPurchases: number; netTax?: number; netTotal: number;
  cash: number; credit: number; unclassified: number;
  paid: number | null; remaining: number | null;
}
export interface PurchaseRow extends PurchaseMoney {
  key: string; name: string | null;
  code?: string | null; unit?: string | null; units?: UnitDef[]; primaryUnitId?: string | null;
  bills: number; returnsCount: number;
  qty: number | null; receivedQty: number | null; returnedQty: number | null;
}
export interface PurchaseSummary extends PurchaseMoney {
  bills: number; returnsCount: number; vendors: number; products: number; unpricedEntries: number;
}
export interface PurchasesData { groupBy: PurchaseGroupBy; taxHidden: boolean; rows: PurchaseRow[]; summary: PurchaseSummary }

/** ما تحتاجه الصفحة للتصدير: أوراقٌ جاهزة واسم الملف والمدى المطبَّق (رأس PDF وورقة «الفترة») وعدد المعروض (سطر البحث) */
export interface PurchasesExport {
  sheets: ExcelSheet[];
  fname: string;
  applied: AppliedRange | null;
  shown: number;
  /** تنبيه القصّ إن بلغ الخادم سقفه — يُطبع تحت رأس PDF */
  note: string | null;
}

export type Tr = (ar: string) => string;

export const purchaseGroupLabel = (g: PurchaseGroupBy, tr: Tr): string =>
  g === 'vendor' ? tr('المورّد') : g === 'product' ? tr('الصنف') : g === 'day' ? tr('اليوم') : tr('الشهر');

/** اسم الصفّ للعرض: «بلا مورّد» للمورّد الغائب، واليوم والشهر بتاريخٍ ميلادي محلّي */
export function purchaseRowName(r: Pick<PurchaseRow, 'key' | 'name'>, g: PurchaseGroupBy, tr: Tr): string {
  if (g === 'day') return formatDayOnly(r.key);
  if (g === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(r.key);
    if (!m) return r.key;
    return new Intl.DateTimeFormat(activeLocale(), { year: 'numeric', month: 'long' }).format(new Date(Number(m[1]), Number(m[2]) - 1, 1));
  }
  if (r.name) return r.name;
  return g === 'vendor' ? tr('بلا مورّد') : tr('صنف محذوف');
}

const MONEY_KEYS = ['net', 'tax', 'total', 'returns', 'returnsTax', 'returnsTotal', 'netPurchases', 'netTax', 'netTotal', 'cash', 'credit', 'unclassified'] as const;
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * إجماليات المعروض: بلا بحث إجماليُّ الخادم كما هو (من الحركات لا من الصفوف)، ومع البحث مجموعُ الصفوف الظاهرة — فالبطاقات
 * والتصدير يطابقان ما على الشاشة. المدفوع والمتبقّي null في تجميع الصنف.
 */
export function purchasesTotals(rows: readonly PurchaseRow[], summary: PurchaseSummary, searching: boolean, groupBy: PurchaseGroupBy): PurchaseMoney {
  if (!searching) return summary;
  const out: Record<string, number | null | undefined> = {};
  for (const k of MONEY_KEYS) {
    if (summary[k] === undefined) continue;
    out[k] = round(rows.reduce((s, r) => s + (r[k] ?? 0), 0));
  }
  const product = groupBy === 'product';
  out.paid = product ? null : round(rows.reduce((s, r) => s + (r.paid ?? 0), 0));
  out.remaining = product ? null : round(rows.reduce((s, r) => s + (r.remaining ?? 0), 0));
  return out as unknown as PurchaseMoney;
}

/** أعمدة الجدول والتصدير — بوزنٍ نسبيّ لعرضٍ ثابت بلا تمرير أفقي، و`wide` تظهر من md فما فوق */
export interface PurchaseCol { id: string; label: string; weight: number; wide?: boolean; title?: string }
export function purchaseColumns(g: PurchaseGroupBy, taxHidden: boolean, showUnclassified: boolean, tr: Tr): PurchaseCol[] {
  const product = g === 'product';
  return [
    { id: 'name', label: purchaseGroupLabel(g, tr), weight: product ? 20 : 16 },
    { id: 'count', label: product ? tr('الكمية') : tr('عدد الفواتير'), weight: product ? 10 : 7, wide: !product },
    { id: 'net', label: tr('المشتريات'), weight: 9, wide: true, title: taxHidden ? undefined : tr('قيمة الوارد قبل الضريبة') },
    { id: 'returns', label: tr('المرتجعات'), weight: 8, wide: true },
    { id: 'netPurchases', label: tr('صافي المشتريات'), weight: 10, title: taxHidden ? undefined : tr('المشتريات ناقص المرتجعات قبل الضريبة') },
    ...(taxHidden ? [] : [
      { id: 'netTax', label: tr('الضريبة'), weight: 8, wide: true },
      { id: 'netTotal', label: tr('الإجمالي'), weight: 10 },
    ]),
    { id: 'cash', label: tr('نقدي'), weight: 8, wide: true },
    { id: 'credit', label: tr('آجل'), weight: 8, wide: true },
    ...(showUnclassified ? [{ id: 'unclassified', label: tr('غير مصنف'), weight: 8, wide: true, title: tr('وارد لم يحدد نقدا أو آجلا') }] : []),
    ...(product ? [] : [
      { id: 'paid', label: tr('المدفوع'), weight: 8, wide: true },
      { id: 'remaining', label: tr('المتبقي'), weight: 8 },
    ]),
  ];
}

/** عمود «غير مصنف» يظهر حين يحمل قيمةً في المعروض أو الإجمالي */
export const hasUnclassified = (rows: readonly PurchaseRow[], totals: PurchaseMoney | null): boolean =>
  rows.some(r => r.unclassified !== 0) || (totals?.unclassified ?? 0) !== 0;

export const plainQty = (n: number) => String(Number(n.toFixed(3)));

/** أوراق التصدير (Excel وPDF): الإجماليات ثم الصفوف بأعمدة الشاشة — أرقامٌ لا نصوص ليجمعها Excel */
export function purchasesSheets(data: PurchasesData, rows: readonly PurchaseRow[], totals: PurchaseMoney, tr: Tr): ExcelSheet[] {
  const g = data.groupBy;
  const cols = purchaseColumns(g, data.taxHidden, hasUnclassified(rows, totals), tr).filter(c => c.id !== 'name' && c.id !== 'count');
  const multi = g === 'product' && rows.some(r => hasBigUnit(r.units));
  const money = (m: PurchaseMoney): Record<string, unknown> => Object.fromEntries(cols.map(c => {
    const v = (m as unknown as Record<string, number | null | undefined>)[c.id];
    return [c.label, v == null ? '' : num(v)];
  }));
  const summaryRow: Record<string, unknown> = {
    ...(g === 'product' ? {} : { [tr('عدد الفواتير')]: rows.reduce((s, r) => s + r.bills, 0) }),
    ...money(totals),
  };
  const dataRows = rows.map(r => ({
    [purchaseGroupLabel(g, tr)]: purchaseRowName(r, g, tr),
    ...(g === 'product'
      ? {
          [tr('الرمز')]: r.code ?? '',
          [tr('الكمية')]: r.qty ?? 0,
          [tr('الوحدة')]: r.unit ?? '',
          ...(multi && { [tr('الكمية بوحداتها')]: baseQtyText(Number(r.qty) || 0, r, plainQty) }),
        }
      : { [tr('عدد الفواتير')]: r.bills }),
    [tr('عدد المرتجعات')]: r.returnsCount,
    ...money(r),
  }));
  const widths = (row: Record<string, unknown> | undefined) => Object.keys(row ?? {}).map((k, i) => (i === 0 ? 28 : Math.max(12, k.length + 4)));
  return [
    { name: tr('الإجماليات'), rows: [summaryRow], colWidths: widths(summaryRow) },
    { name: tr('المشتريات'), rows: dataRows, colWidths: widths(dataRows[0]) },
  ];
}
