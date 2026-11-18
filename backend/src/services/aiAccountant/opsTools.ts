/**
 * «المحاسب الذكي AI» — أدوات القراءة التشغيلية (حزمة A2، المواصفة §٣.٣).
 *
 * ست أدوات تجيب من جداول التشغيل (الفواتير والسندات والمستودع والموردين والعملاء) لكل شركةٍ فعّلت المحاسب — بدفاتر أو بلا دفاتر:
 *   sales_summary · collections_summary · purchases_inventory (مخزون الشركة مفعّل) · receivables · top_customers_products
 *   · profit_estimate (بلا دفاتر مفعّلة وحدها — موسومٌ «تقديري» صراحة).
 *
 * الضوابط:
 *   - **الذكاء لا يحسب رقماً:** كل مجموعٍ وفرقٍ ونسبةٍ يُحسب هنا ويُسلَّم للنموذج جاهزاً (حارس الأرقام في runAdvisor يرفض غيره).
 *   - **الشركة من السياق وحده** (ctx.tenantId): وسائط النموذج تُقرأ بمخطّط zod يُسقط كل مفتاحٍ غير الفترة والحدّ، فلا يصل
 *     tenantId ولا غيره من نصّ المحادثة إلى استعلام.
 *   - **«النظام المحاسبي» مطفأ ⇒ لا مبلغ يغادر الخادم:** الأعداد وحدها (كبطاقات لوحة التحكم dashboard.ts).
 *   - **«إزالة الضريبة»:** لا سطر ولا ذكر للضريبة في التقرير ولا في مدخل النموذج.
 *   - كل أداةٍ ناجحة تدفع تقريراً (AiReport) إلى ctx.reports فترسمه الواجهة جدولاً وPDF بهوية الشركة.
 * البناء صرف (دوالّ *Report مُصدَّرة ومختبَرة بلا قاعدة)، والقراءات محقونة (opsQueries.ts).
 */
import { z } from 'zod';
import type { AcctCtx, AiReport, Tool } from './context';
import { isPeriodError, parsePeriod, type AcctPeriod } from './period';
import {
  defaultOpsDeps, SALE_ITEMS_CAP,
  type AgingJson, type OpsDeps, type PartyGroup, type ReceiptMethodGroup, type ReceivablesData, type TypeTotals,
} from './opsQueries';
import { cleanMoney, isReturnInvoice, netSales, signedAmount } from '../netSales';
import { summarizeCollectionsByMethod } from '../paymentMethodsReport';
import { resolvePaymentMethod, type PaymentMethodsConfigV1 } from '../paymentMethodsCore';
import { monthPurchasesOf, type PurchaseAggRow, type WarehouseRow } from '../warehouseStock';
import { rankTopReps, type RepTypeGroup, type TopRep } from '../topReps';
import { salesByProduct } from '../../routes/reports';
import { currencyDecimalsOf } from '../../config/countries';
import { roundDecimal } from '../../utils/helpers';

type Row = AiReport['sections'][number]['rows'][number];
type Section = AiReport['sections'][number];
type ToolResult = { data: unknown; summaryAr: string } | { error: string };

/** ملاحظة التقرير حين «النظام المحاسبي» مطفأ */
export const MONEY_HIDDEN_NOTE = 'المبالغ مخفية لأن النظام المحاسبي غير مفعّل للشركة — الأعداد وحدها.';
/** وسم تقدير الربح بلا دفاتر (المواصفة §٣.٣) */
export const ESTIMATE_NOTE = 'تقديري — فعّل الدفاتر لربح دقيق';
/** حدود الأيام: بتوقيت الشركة — صفحة التقارير تقرأ أيام UTC فقد يختلف مجموعٌ قليلاً عنها */
const BOUNDARY_BASIS = 'company-local days (the Reports page uses UTC days, so totals may differ slightly at day edges)';

// ───────────── أدوات صغيرة ─────────────

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** تقريب المال بخانات عملة الشركة (half-up كالفواتير) — و‎-0 صفر */
export function moneyOf(currency: string): (n: number) => number {
  const dec = currencyDecimalsOf(currency);
  return (n: number) => roundDecimal(num(n), dec) || 0;
}

const row = (label: string, amount: number | null, extra: Partial<Omit<Row, 'label' | 'amount'>> = {}): Row => ({ label, amount, ...extra });
const periodOf = (p: AcctPeriod) => ({ from: p.fromLocal, to: p.toLocal });

/** وسائط الفترة: نصٌّ أو رقم (شهرٌ 11) أو null — وكل مفتاحٍ آخر يسقط (tenantId من النموذج لا يُقرأ أبداً) */
const strish = z.preprocess((v) => (v == null || v === '' ? undefined : typeof v === 'number' ? String(v) : v), z.string().max(40).optional());
const periodSchema = z.object({ from: strish, to: strish, month: strish });
const topSchema = periodSchema.extend({
  limit: z.preprocess((v) => (v == null || v === '' ? undefined : Number(v)), z.number().int().min(1).max(10).optional()),
});

const PERIOD_PROPS = {
  month: { type: 'string', description: 'A whole month: "YYYY-MM", or just "MM" for that month of the current year (e.g. "11" = November). Takes precedence over from/to.' },
  from: { type: 'string', description: 'Start date YYYY-MM-DD, company local, inclusive.' },
  to: { type: 'string', description: 'End date YYYY-MM-DD, inclusive. Omit month, from and to for the current month to date.' },
} as const;

/** فترة الأداة من وسائطها — أو خطأ بالعربية يعود للنموذج فيسأل المستخدم */
function periodFrom(ctx: AcctCtx, args: Record<string, unknown>): AcctPeriod | { error: string } {
  const a = periodSchema.safeParse(args ?? {});
  if (!a.success) return { error: 'وسائط الفترة غير صالحة — month بصيغة YYYY-MM أو MM، أو from/to بصيغة YYYY-MM-DD' };
  return parsePeriod(a.data, ctx.tz, ctx.todayLocal);
}

/** غلاف التشغيل: خطأ القاعدة لا يُسقط الدورة ولا يصل نصّه للنموذج — سطر سجلٍّ بلا محتوى ورسالةٌ عامة */
async function safely(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[ai-accountant] أداة ${name} فشلت:`, (err as Error)?.message ?? err);
    return { error: 'تعذّر جلب البيانات الآن — حاول بعد قليل' };
  }
}

// ═══════════════ المبيعات ═══════════════

export interface SalesFigures {
  salesCount: number; salesTotal: number;
  cashCount: number; cashTotal: number;
  creditCount: number; creditTotal: number;
  returnsCount: number; returnsTotal: number;
  /** صافي المبيعات (شامل الضريبة كما تُخزَّن Invoice.total) = البيع − المرتجع */
  net: number;
  /** صافي الضريبة (ضريبة البيع − ضريبة المرتجع) */
  netTax: number;
  /** صافي المبيعات قبل الضريبة */
  netExTax: number;
  netDiscount: number;
}

/**
 * أرقام المبيعات من تجميع الفواتير المؤكَّدة بالنوع — منطق GET /reports/sales (الملخّص) حرفياً: البيع غير RETURN والمرتجع RETURN
 * يُطرح من الإجمالي والضريبة والخصم (services/netSales.ts)، والعدد لفواتير البيع وحدها. النقدي CASH وما سواه من البيع آجل.
 */
export function salesFigures(groups: readonly TypeTotals[]): SalesFigures {
  const f = { salesCount: 0, salesTotal: 0, salesTax: 0, salesDisc: 0, cashCount: 0, cashTotal: 0, creditCount: 0, creditTotal: 0, returnsCount: 0, returnsTotal: 0, returnsTax: 0, returnsDisc: 0 };
  for (const g of groups) {
    if (isReturnInvoice(g)) {
      f.returnsCount += num(g.count); f.returnsTotal += num(g.total); f.returnsTax += num(g.taxAmt); f.returnsDisc += num(g.discountAmt);
      continue;
    }
    f.salesCount += num(g.count); f.salesTotal += num(g.total); f.salesTax += num(g.taxAmt); f.salesDisc += num(g.discountAmt);
    if (g.type === 'CASH') { f.cashCount += num(g.count); f.cashTotal += num(g.total); } else { f.creditCount += num(g.count); f.creditTotal += num(g.total); }
  }
  const net = netSales(f.salesTotal, f.returnsTotal);
  const netTax = netSales(f.salesTax, f.returnsTax);
  return {
    salesCount: f.salesCount, salesTotal: cleanMoney(f.salesTotal),
    cashCount: f.cashCount, cashTotal: cleanMoney(f.cashTotal),
    creditCount: f.creditCount, creditTotal: cleanMoney(f.creditTotal),
    returnsCount: f.returnsCount, returnsTotal: cleanMoney(f.returnsTotal),
    net, netTax, netExTax: cleanMoney(net - netTax), netDiscount: netSales(f.salesDisc, f.returnsDisc),
  };
}

export function salesSummaryReport(ctx: AcctCtx, p: AcctPeriod, f: SalesFigures): { report: AiReport; data: unknown; summaryAr: string } {
  const period = periodOf(p);
  const base = { kind: 'sales' as const, title: 'ملخص المبيعات', period, currency: ctx.currency };
  if (!ctx.accountingOn) {
    return {
      report: {
        ...base,
        sections: [{ title: 'المبيعات', rows: [
          row('فواتير البيع', null, { text: `${f.salesCount} فاتورة`, bold: true }),
          row('نقدية', null, { text: `${f.cashCount} فاتورة`, level: 1 }),
          row('آجلة', null, { text: `${f.creditCount} فاتورة`, level: 1 }),
          row('المرتجعات', null, { text: `${f.returnsCount} مستند` }),
        ] }],
        notes: [MONEY_HIDDEN_NOTE],
      },
      data: { period, money_hidden: true, sales_invoices: f.salesCount, cash_invoices: f.cashCount, credit_invoices: f.creditCount, return_documents: f.returnsCount },
      summaryAr: `من ${p.fromLocal} إلى ${p.toLocal}: ${f.salesCount} فاتورة بيع (نقدية ${f.cashCount}، آجلة ${f.creditCount}) و${f.returnsCount} مرتجع.`,
    };
  }
  const m = moneyOf(ctx.currency);
  const taxOff = ctx.taxDisabled;
  const sections: Section[] = [
    { title: 'المبيعات', rows: [
      row('مبيعات نقدية', m(f.cashTotal), { text: `${f.cashCount} فاتورة`, level: 1 }),
      row('مبيعات آجلة', m(f.creditTotal), { text: `${f.creditCount} فاتورة`, level: 1 }),
      row('إجمالي فواتير البيع', m(f.salesTotal), { text: `${f.salesCount} فاتورة`, bold: true }),
      row('المرتجعات', m(-f.returnsTotal), { text: `${f.returnsCount} مستند` }),
      row('صافي المبيعات', m(f.net), { bold: true }),
    ] },
    { title: taxOff ? 'الخصومات' : 'الضريبة والخصومات', rows: [
      ...(taxOff ? [] : [
        row('ضريبة القيمة المضافة (صافية)', m(f.netTax)),
        row('صافي المبيعات قبل الضريبة', m(f.netExTax), { bold: true }),
      ]),
      row('الخصومات (صافية)', m(f.netDiscount)),
    ] },
  ];
  const notes = [taxOff
    ? 'من الفواتير المؤكَّدة في الفترة، والمرتجع مطروح.'
    : 'من الفواتير المؤكَّدة في الفترة، والمبالغ شاملة الضريبة ما لم يُذكر، والمرتجع مطروح.'];
  return {
    report: { ...base, sections, notes },
    data: {
      period, currency: ctx.currency,
      sales_invoices: f.salesCount,
      cash_sales: { invoices: f.cashCount, amount: m(f.cashTotal) },
      credit_sales: { invoices: f.creditCount, amount: m(f.creditTotal) },
      gross_sales: m(f.salesTotal),
      returns: { documents: f.returnsCount, amount: m(f.returnsTotal) },
      net_sales: m(f.net),
      ...(!taxOff && { vat_net: m(f.netTax), net_sales_before_vat: m(f.netExTax) }),
      discounts_net: m(f.netDiscount),
      basis: taxOff ? `confirmed invoices, returns deducted; ${BOUNDARY_BASIS}` : `confirmed invoices, amounts include VAT unless stated, returns deducted; ${BOUNDARY_BASIS}`,
    },
    summaryAr: `صافي المبيعات من ${p.fromLocal} إلى ${p.toLocal}: ${m(f.net)} ${ctx.currency} من ${f.salesCount} فاتورة بيع (نقدي ${m(f.cashTotal)}، آجل ${m(f.creditTotal)})، والمرتجع ${m(f.returnsTotal)}.`,
  };
}

// ═══════════════ التحصيل ═══════════════

export interface MethodRow { id: string; label: string; amount: number; count: number }

/**
 * سندات القبض بالطريقة كما تعرفها الشركة — summarizeCollectionsByMethod نفسها (الترتيب والأسماء والمخصّصة)، والعدد من
 * عدّ كل مجموعة (التجميع في القاعدة يعطي صفّاً لكل طريقة لا لكل سند، والدالّة تعدّ الصفوف).
 */
export function collectionsByMethod(groups: readonly ReceiptMethodGroup[], config: PaymentMethodsConfigV1 | null): MethodRow[] {
  const sum = summarizeCollectionsByMethod(groups.map((g) => ({ paymentMethod: g.paymentMethod, paymentMethodKey: g.paymentMethodKey, amount: num(g.amount) })), config);
  const counts = new Map<string, number>();
  for (const g of groups) {
    const id = resolvePaymentMethod(config, g.paymentMethod || 'CASH', g.paymentMethodKey).id;
    counts.set(id, (counts.get(id) ?? 0) + num(g.count));
  }
  return sum.methods.map((x) => ({ id: x.id, label: x.label, amount: x.amount, count: counts.get(x.id) ?? 0 }));
}

export function collectionsReport(
  ctx: AcctCtx, p: AcctPeriod, methods: readonly MethodRow[], cashSales: { amount: number; count: number },
): { report: AiReport; data: unknown; summaryAr: string } {
  const period = periodOf(p);
  const receiptsCount = methods.reduce((s, x) => s + x.count, 0);
  const base = { kind: 'collections' as const, title: 'ملخص التحصيل', period, currency: ctx.currency };
  if (!ctx.accountingOn) {
    return {
      report: {
        ...base,
        sections: [{ title: 'التحصيل', rows: [
          row('سندات القبض', null, { text: `${receiptsCount} سند`, bold: true }),
          ...methods.map((x) => row(x.label, null, { text: `${x.count} سند`, level: 1 as const })),
          row('فواتير البيع النقدي', null, { text: `${cashSales.count} فاتورة` }),
        ] }],
        notes: [MONEY_HIDDEN_NOTE],
      },
      data: { period, money_hidden: true, receipts: receiptsCount, by_method: methods.map((x) => ({ method: x.label, receipts: x.count })), cash_sale_invoices: cashSales.count },
      summaryAr: `من ${p.fromLocal} إلى ${p.toLocal}: ${receiptsCount} سند قبض و${cashSales.count} فاتورة بيع نقدي.`,
    };
  }
  const m = moneyOf(ctx.currency);
  const receiptsTotal = cleanMoney(methods.reduce((s, x) => s + x.amount, 0));
  const total = cleanMoney(receiptsTotal + num(cashSales.amount));
  const sections: Section[] = [
    { title: 'سندات القبض حسب طريقة الدفع', rows: [
      ...methods.map((x) => row(x.label, m(x.amount), { text: `${x.count} سند`, level: 1 as const })),
      row('إجمالي سندات القبض', m(receiptsTotal), { text: `${receiptsCount} سند`, bold: true }),
    ] },
    { title: 'البيع النقدي', rows: [row('فواتير البيع النقدي المحصَّلة', m(cashSales.amount), { text: `${cashSales.count} فاتورة` })] },
    { title: null, rows: [row('إجمالي المحصَّل', m(total), { bold: true })] },
  ];
  return {
    report: {
      ...base, sections,
      notes: ['المحصَّل = سندات القبض السارية + المدفوع في فواتير البيع النقدي. تقرير التحصيل في صفحة التقارير يعرض السندات وحدها.'],
    },
    data: {
      period, currency: ctx.currency,
      receipts: { count: receiptsCount, amount: m(receiptsTotal), by_method: methods.map((x) => ({ method: x.label, count: x.count, amount: m(x.amount) })) },
      cash_sales_collected: { invoices: cashSales.count, amount: m(cashSales.amount) },
      total_collected: m(total),
      basis: `active receipts + paid amount of confirmed cash-sale invoices; ${BOUNDARY_BASIS}`,
    },
    summaryAr: `المحصَّل من ${p.fromLocal} إلى ${p.toLocal}: ${m(total)} ${ctx.currency} — سندات قبض ${m(receiptsTotal)} (${receiptsCount} سند) وبيع نقدي ${m(cashSales.amount)}.`,
  };
}

// ═══════════════ المشتريات والمخزون ═══════════════

export interface StockSummary {
  value: number;
  productsInStock: number;
  uncostedProducts: number;
  negativeProducts: number;
  top: { name: string; onHand: number; unit: string; value: number }[];
}

/** قيمة مخزون المستودع من صفوف computeWarehouseStock: Σ القيمة (المقيَّم وحده)، وأعلى الأصناف قيمةً */
export function stockSummaryOf(rows: readonly WarehouseRow[], topN = 5): StockSummary {
  const EPS = 1e-9;
  return {
    value: cleanMoney(rows.reduce((s, r) => s + num(r.stockValue), 0)),
    productsInStock: rows.filter((r) => r.onHand > EPS).length,
    uncostedProducts: rows.filter((r) => r.uncostedQty > EPS).length,
    negativeProducts: rows.filter((r) => r.onHand < -EPS).length,
    top: [...rows].filter((r) => r.stockValue > EPS)
      .sort((a, b) => b.stockValue - a.stockValue || a.name.localeCompare(b.name, 'ar'))
      .slice(0, topN)
      .map((r) => ({ name: r.name, onHand: r.onHand, unit: r.unit, value: r.stockValue })),
  };
}

export interface PurchasesInventoryInput {
  purchases: readonly PurchaseAggRow[];
  supplierPayments: { amount: number; count: number };
  stock: readonly WarehouseRow[];
  /** يوم تقييم المخزون والموردين: نهاية الفترة، أو اليوم إن امتدّت إليه */
  asOfLocal: string;
  aging: AgingJson;
}

export function purchasesInventoryReport(ctx: AcctCtx, p: AcctPeriod, input: PurchasesInventoryInput): { report: AiReport; data: unknown; summaryAr: string } {
  const period = periodOf(p);
  const pur = monthPurchasesOf(input.purchases);
  const st = stockSummaryOf(input.stock);
  const base = { kind: 'purchases-inventory' as const, title: 'المشتريات والمخزون', period, currency: ctx.currency };
  const stockTitle = `مخزون المستودع كما في ${input.asOfLocal}`;
  if (!ctx.accountingOn) {
    return {
      report: {
        ...base,
        sections: [
          { title: 'المشتريات', rows: [row('حركات الوارد', null, { text: `${pur.entriesCount} حركة` })] },
          { title: stockTitle, rows: [row('أصناف لها رصيد', null, { text: `${st.productsInStock} صنف` })] },
        ],
        notes: [MONEY_HIDDEN_NOTE],
      },
      data: { period, money_hidden: true, purchase_entries: pur.entriesCount, products_in_stock: st.productsInStock },
      summaryAr: `من ${p.fromLocal} إلى ${p.toLocal}: ${pur.entriesCount} حركة وارد، و${st.productsInStock} صنفاً له رصيد في المستودع.`,
    };
  }
  const m = moneyOf(ctx.currency);
  const t = input.aging.totals;
  const owed = num(t.balance);
  const openBills = num(t.total);
  const overdue = cleanMoney(num(t.d1_30) + num(t.d31_60) + num(t.d61_90) + num(t.d90_plus));
  const topSuppliers = [...input.aging.rows].filter((r) => num(r.balance) > 1e-9)
    .sort((a, b) => num(b.balance) - num(a.balance) || a.name.localeCompare(b.name, 'ar')).slice(0, 5);
  const purchasesLabel = ctx.taxDisabled ? 'صافي المشتريات' : 'صافي المشتريات (قبل الضريبة)';
  const sections: Section[] = [
    { title: 'المشتريات', rows: [
      row(purchasesLabel, m(pur.purchasesTotal), { text: `${pur.entriesCount} حركة وارد`, bold: true }),
      row('المدفوع للموردين', m(input.supplierPayments.amount), { text: `${input.supplierPayments.count} سند صرف` }),
    ] },
    { title: stockTitle, rows: [
      row('قيمة المخزون بتكلفة الشراء', m(st.value), { text: `${st.productsInStock} صنف له رصيد`, bold: true }),
      ...st.top.map((x) => row(x.name, m(x.value), { text: `${x.onHand} ${x.unit}`.trim(), level: 1 as const })),
      ...(st.uncostedProducts ? [row('أصناف فيها كمية بلا تكلفة معروفة', null, { text: `${st.uncostedProducts} صنف` })] : []),
    ] },
    { title: 'الموردون', rows: [
      row('المستحق للموردين', m(owed), { bold: true }),
      row('فواتير آجلة مفتوحة', m(openBills), { level: 1 }),
      row('منها متأخرة السداد', m(overdue), { level: 1 }),
      ...topSuppliers.map((s) => row(s.name, m(num(s.balance)), { level: 2 as const })),
    ] },
  ];
  const notes = [
    'المشتريات = قيمة الوارد المسعَّر للمستودع صافيةً من المرتجع للمورّد، بلا المخزون الافتتاحي، بتاريخ تسجيل الحركة.',
    'قيمة المخزون للمستودع وحده — لا تشمل ما في سيارات المناديب.',
    ...(st.uncostedProducts ? ['كمياتٌ بلا تكلفة شراء معروفة خارج القيمة.'] : []),
  ];
  return {
    report: { ...base, sections, notes },
    data: {
      period, currency: ctx.currency,
      purchases: { net_amount: m(pur.purchasesTotal), receipt_entries: pur.entriesCount, ...(!ctx.taxDisabled && { before_vat: true }) },
      paid_to_suppliers: { vouchers: input.supplierPayments.count, amount: m(input.supplierPayments.amount) },
      warehouse_stock: {
        as_of: input.asOfLocal, value_at_cost: m(st.value), products_in_stock: st.productsInStock,
        products_with_uncosted_qty: st.uncostedProducts, products_negative: st.negativeProducts,
        top_items: st.top.map((x) => ({ product: x.name, qty: x.onHand, unit: x.unit, value: m(x.value) })),
        excludes: 'stock in sales reps vans',
      },
      suppliers: {
        as_of: input.asOfLocal, total_owed: m(owed), open_credit_bills: m(openBills), overdue: m(overdue),
        top: topSuppliers.map((s) => ({ supplier: s.name, owed: m(num(s.balance)) })),
      },
    },
    summaryAr: `صافي المشتريات من ${p.fromLocal} إلى ${p.toLocal}: ${m(pur.purchasesTotal)} ${ctx.currency} (${pur.entriesCount} حركة)، وقيمة مخزون المستودع ${m(st.value)}، والمستحق للموردين ${m(owed)}.`,
  };
}

// ═══════════════ ذمم العملاء ═══════════════

export function receivablesReport(ctx: AcctCtx, r: ReceivablesData): { report: AiReport; data: unknown; summaryAr: string } {
  const base = { kind: 'receivables' as const, title: `ذمم العملاء كما في ${ctx.todayLocal}`, period: null, currency: ctx.currency };
  const statusAr = (s: string) => (s === 'BLOCKED' ? 'محظور' : s === 'INACTIVE' ? 'موقوف' : undefined);
  if (!ctx.accountingOn) {
    return {
      report: {
        ...base,
        sections: [{ title: 'ذمم العملاء', rows: [
          row('عملاء عليهم أرصدة', null, { text: `${r.debit.count} عميل`, bold: true }),
          row('عملاء تجاوزوا الحدّ الائتماني', null, { text: `${r.exceededCount} عميل` }),
        ] }],
        notes: [MONEY_HIDDEN_NOTE],
      },
      data: { as_of: ctx.todayLocal, money_hidden: true, debtors: r.debit.count, over_credit_limit: r.exceededCount },
      summaryAr: `${r.debit.count} عميلاً عليهم أرصدة، و${r.exceededCount} تجاوزوا الحدّ الائتماني.`,
    };
  }
  const m = moneyOf(ctx.currency);
  const sections: Section[] = [
    { title: 'ذمم العملاء', rows: [
      row('إجمالي مديونية العملاء', m(r.debit.total), { text: `${r.debit.count} عميل مدين`, bold: true }),
      row('أرصدة دائنة للعملاء (دفعات مقدّمة)', m(r.credit.total), { text: `${r.credit.count} عميل` }),
      row('عملاء تجاوزوا الحدّ الائتماني', null, { text: `${r.exceededCount} عميل` }),
    ] },
    ...(r.top.length ? [{ title: 'أعلى العملاء مديونية', rows: r.top.map((c) => row(c.name, m(c.balance), { level: 1 as const, ...(statusAr(c.status) && { text: statusAr(c.status) }) })) }] : []),
  ];
  return {
    report: {
      ...base, sections,
      notes: ['الأرصدة الحالية لكل عميلٍ غير محذوف (ومنهم الموقوف والمحظور) كتقرير «أرصدة العملاء».'],
    },
    data: {
      as_of: ctx.todayLocal, currency: ctx.currency,
      total_receivables: m(r.debit.total), debtors: r.debit.count,
      customer_credit_balances: m(r.credit.total), customers_in_credit: r.credit.count,
      over_credit_limit: r.exceededCount,
      top_debtors: r.top.map((c) => ({ customer: c.name, balance: m(c.balance), credit_limit: m(c.creditLimit), ...(statusAr(c.status) && { status: statusAr(c.status) }) })),
    },
    summaryAr: `مديونية العملاء اليوم ${m(r.debit.total)} ${ctx.currency} على ${r.debit.count} عميلاً، و${r.exceededCount} تجاوزوا الحدّ الائتماني.`,
  };
}

// ═══════════════ الأعلى مبيعاً ═══════════════

export interface PartyNet { id: string; total: number; count: number }

/** صافي كل عميل (البيع − المرتجع) وعدد فواتير بيعه — كتجميع groupBy=customer في GET /reports/sales */
export function partyNets(groups: readonly PartyGroup[]): PartyNet[] {
  const acc = new Map<string, PartyNet>();
  for (const g of groups) {
    if (!g.id) continue;
    const x = acc.get(g.id) ?? { id: g.id, total: 0, count: 0 };
    x.total += signedAmount(g, g.total);
    if (!isReturnInvoice(g)) x.count += num(g.count);
    acc.set(g.id, x);
  }
  return [...acc.values()].map((x) => ({ ...x, total: cleanMoney(x.total) }));
}

export interface TopInput {
  customers: readonly (PartyNet & { name: string })[];
  products: ReturnType<typeof salesByProduct> | null;
  reps: readonly TopRep[];
}

/** يرتّب ويقصّ: بالمبلغ الصافي، أو بالعدد/الكمية حين تُخفى المبالغ */
export function topReport(ctx: AcctCtx, p: AcctPeriod, input: TopInput, limit: number): { report: AiReport; data: unknown; summaryAr: string } {
  const period = periodOf(p);
  const money = ctx.accountingOn;
  const m = moneyOf(ctx.currency);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'ar');
  const customers = [...input.customers]
    .sort((a, b) => (money ? b.total - a.total : b.count - a.count) || byName(a, b))
    .slice(0, limit);
  const products = input.products
    ? [...input.products].sort((a, b) => (money ? b.total - a.total : b.baseQty - a.baseQty) || byName(a, b)).slice(0, limit)
    : null;
  const reps = [...input.reps].sort((a, b) => (money ? b.salesTotal - a.salesTotal : b.invoicesCount - a.invoicesCount) || byName(a, b)).slice(0, limit);
  const amt = (n: number) => (money ? m(n) : null);
  const sections: Section[] = [
    { title: 'أعلى العملاء', rows: customers.map((c) => row(c.name, amt(c.total), { text: `${c.count} فاتورة` })) },
    ...(products ? [{ title: 'أعلى الأصناف', rows: products.map((x) => row(x.name, amt(x.total), { text: `${x.baseQty} ${x.unit}`.trim() })) }] : []),
    { title: 'أعلى المناديب', rows: reps.map((r) => row(r.name, amt(r.salesTotal), { text: `${r.invoicesCount} فاتورة` })) },
  ];
  const notes = [
    money ? 'الترتيب بصافي المبيعات (المرتجع مطروح)، وكمية الصنف بوحدته الأساسية.' : 'الترتيب بعدد الفواتير والكميات، وكمية الصنف بوحدته الأساسية.',
    ...(products ? [] : ['الفترة كبيرة على ترتيب الأصناف — قلّصها لعرضه.']),
    ...(money ? [] : [MONEY_HIDDEN_NOTE]),
  ];
  const data = {
    period, ...(money ? { currency: ctx.currency } : { money_hidden: true }),
    top_customers: customers.map((c) => ({ customer: c.name, invoices: c.count, ...(money && { net_sales: m(c.total) }) })),
    top_products: products
      ? products.map((x) => ({ product: x.name, qty: x.baseQty, unit: x.unit, ...(money && { net_sales: m(x.total) }) }))
      : 'period too large for the product ranking — ask for a shorter period',
    top_reps: reps.map((r) => ({ rep: r.name, invoices: r.invoicesCount, ...(money && { net_sales: m(r.salesTotal) }) })),
  };
  const first = (xs: readonly { name: string }[]) => xs[0]?.name ?? '—';
  return {
    report: { kind: 'top', title: 'الأعلى مبيعاً', period, currency: ctx.currency, sections, notes },
    data,
    summaryAr: `من ${p.fromLocal} إلى ${p.toLocal}: أعلى العملاء ${first(customers)}، وأعلى الأصناف ${products ? first(products) : '—'}، وأعلى المناديب ${first(reps)}.`,
  };
}

// ═══════════════ تقدير الربح (بلا دفاتر) ═══════════════

export interface ProfitEstimate {
  /** صافي المبيعات قبل الضريبة (Invoice.total − taxAmt، والمرتجع مطروح) */
  revenue: number;
  /** تكلفة البضاعة المباعة التقديرية — null حين لا تكلفة معروفة لأي صنفٍ مباع */
  cogs: number | null;
  grossProfit: number | null;
  /** هامش الربح الإجمالي % بمنزلة عشرية — null بلا إيراد أو بلا تكلفة */
  marginPct: number | null;
  /** نسبة مبيعات الأصناف المعروفة تكلفتها من مبيعات الأصناف كلها % */
  coveragePct: number | null;
  uncostedProducts: number;
  uncostedSales: number;
}

/**
 * الربح الإجمالي التقديري = صافي المبيعات قبل الضريبة − Σ (الكمية المباعة صافيةً بالأساس × متوسّط تكلفة الشراء الحالي لوحدة
 * الأساس). InvoiceItem.unitCost صفرٌ في الفواتير فلا يُعتمد؛ والصنف بلا متوسّط معروف تُحسب تكلفته صفراً ويُعلن عدده ومبيعاته.
 */
export function profitEstimateOf(f: SalesFigures, products: ReturnType<typeof salesByProduct>, avgCost: ReadonlyMap<string, number>): ProfitEstimate {
  let cogs = 0;
  let costedSales = 0;
  let uncostedSales = 0;
  let uncostedProducts = 0;
  for (const x of products) {
    const c = x.productId ? avgCost.get(x.productId) : undefined;
    if (c != null && Number.isFinite(c) && c > 0) {
      cogs += x.baseQty * c;
      costedSales += x.total;
    } else if (Math.abs(x.baseQty) > 1e-9 || Math.abs(x.total) > 1e-9) {
      uncostedProducts += 1;
      uncostedSales += x.total;
    }
  }
  const revenue = f.netExTax;
  // التكلفة معروفة: صنفٌ مُسعَّر واحد على الأقل، أو لا أصناف مباعة أصلاً (فترةٌ بلا بيع: تكلفةٌ صفر لا «غير معروفة»)
  const known = costedSales !== 0 || cogs !== 0 || uncostedProducts === 0;
  const grossProfit = known ? cleanMoney(revenue - cogs) : null;
  const allSales = costedSales + uncostedSales;
  return {
    revenue,
    cogs: known ? cleanMoney(cogs) : null,
    grossProfit,
    marginPct: grossProfit != null && revenue > 0 ? round1((grossProfit / revenue) * 100) : null,
    coveragePct: Math.abs(allSales) > 1e-9 ? round1((costedSales / allSales) * 100) : null,
    uncostedProducts,
    uncostedSales: cleanMoney(uncostedSales),
  };
}

export function profitEstimateReport(ctx: AcctCtx, p: AcctPeriod, f: SalesFigures, e: ProfitEstimate): { report: AiReport; data: unknown; summaryAr: string } {
  const period = periodOf(p);
  const m = moneyOf(ctx.currency);
  const taxOff = ctx.taxDisabled;
  const revenueRows: Row[] = taxOff
    ? [row('صافي المبيعات', m(e.revenue), { bold: true })]
    : [
      row('صافي المبيعات (شامل الضريبة)', m(f.net)),
      row('ضريبة القيمة المضافة (صافية)', m(-f.netTax), { level: 1 }),
      row('صافي المبيعات قبل الضريبة', m(e.revenue), { bold: true }),
    ];
  const sections: Section[] = [
    { title: 'الإيراد', rows: revenueRows },
    { title: 'التكلفة التقديرية', rows: [
      row('تكلفة البضاعة المباعة (تقديرية)', e.cogs == null ? null : m(-e.cogs), { ...(e.cogs == null && { text: 'غير معروفة' }) }),
      ...(e.uncostedProducts ? [row('أصناف بلا تكلفة شراء معروفة', m(e.uncostedSales), { text: `${e.uncostedProducts} صنف`, level: 1 as const })] : []),
    ] },
    { title: 'النتيجة', rows: [
      row('الربح الإجمالي التقديري', e.grossProfit == null ? null : m(e.grossProfit), { bold: true, ...(e.grossProfit == null && { text: 'غير متاح' }) }),
      ...(e.marginPct != null ? [row('هامش الربح الإجمالي', null, { text: `${e.marginPct}%` })] : []),
    ] },
  ];
  const notes = [
    ESTIMATE_NOTE,
    'التكلفة = الكمية المباعة صافيةً من المرتجع × متوسّط تكلفة الشراء الحالي في المستودع.',
    'لا يشمل المصروفات والرواتب — ربحٌ إجمالي لا صافٍ.',
    ...(e.cogs == null ? [ctx.warehouseOn
      ? 'لا تكلفة شراء مسجّلة للأصناف المباعة — لا يمكن تقدير الربح.'
      : 'مخزون الشركة غير مفعّل أو غير متاح لحسابك (صلاحية «إدارة المخزون») فلا تكلفة شراء لتقدير الربح — المبيعات وحدها.'] : []),
    ...(e.cogs != null && e.uncostedProducts
      ? ['أصنافٌ بلا تكلفة معروفة حُسبت تكلفتها صفراً، فالربح التقديري أعلى من حقيقته بقدرها.'] : []),
  ];
  const data = {
    estimated: true,
    label: ESTIMATE_NOTE,
    period, currency: ctx.currency,
    ...(taxOff ? { net_sales: m(e.revenue) } : { net_sales_incl_vat: m(f.net), vat_net: m(f.netTax), net_sales_before_vat: m(e.revenue) }),
    estimated_cost_of_goods_sold: e.cogs == null ? null : m(e.cogs),
    estimated_gross_profit: e.grossProfit == null ? null : m(e.grossProfit),
    gross_margin_pct: e.marginPct,
    costed_sales_coverage_pct: e.coveragePct,
    uncosted_products: e.uncostedProducts,
    uncosted_products_sales: m(e.uncostedSales),
    cost_basis: 'net quantity sold x current warehouse average purchase cost per base unit',
    excludes: 'expenses and salaries (no activated books) — this is gross profit, not net profit',
  };
  return {
    report: { kind: 'profit-estimate', title: 'تقدير الربح الإجمالي', period, currency: ctx.currency, sections, notes, estimated: true },
    data,
    summaryAr: e.grossProfit == null
      ? `${ESTIMATE_NOTE}: صافي المبيعات ${m(e.revenue)} ${ctx.currency} ولا تكلفة شراء معروفة لتقدير الربح.`
      : `${ESTIMATE_NOTE}: الربح الإجمالي التقديري من ${p.fromLocal} إلى ${p.toLocal} نحو ${m(e.grossProfit)} ${ctx.currency} من صافي مبيعات ${m(e.revenue)}.`,
  };
}

// ═══════════════ الأدوات ═══════════════

const tool = (name: string, description: string, properties: Record<string, unknown>, run: Tool['run']): Tool => ({
  spec: { type: 'function', function: { name, description, parameters: { type: 'object', properties, additionalProperties: false } } },
  run,
});

/** يوم تقييم «كما في» لفترة: نهايتها، أو اليوم إن امتدّت إليه أو بعده */
const asOfOf = (p: AcctPeriod, todayLocal: string): string => (p.toLocal < todayLocal ? p.toLocal : todayLocal);

/**
 * أدوات القراءة التشغيلية لسياق الدورة. `deps` للاختبار وحده (الافتراضي القاعدة).
 * purchases_inventory حين «مخزون الشركة» مفعّل، وprofit_estimate حين لا دفاتر مفعّلة والنظام المحاسبي مفعّل (ربحٌ بلا مبالغ لا معنى له).
 */
export function buildOpsTools(ctx: AcctCtx, deps: OpsDeps = defaultOpsDeps): Tool[] {
  const tid = ctx.tenantId;
  const tools: Tool[] = [];

  tools.push(tool('sales_summary',
    'Sales summary for a period from the company’s confirmed invoices: number of sale invoices, cash vs credit (آجل) sales, returns, net sales (returns deducted), VAT and net sales before VAT, discounts. All figures are computed by the server — quote them exactly. Use for «كم مبيعاتنا» or «ملخص المبيعات». Default period: current month to date.',
    PERIOD_PROPS,
    (args) => safely('sales_summary', async () => {
      const p = periodFrom(ctx, args);
      if (isPeriodError(p)) return p;
      const out = salesSummaryReport(ctx, p, salesFigures(await deps.salesByType(tid, p.gte, p.lt)));
      ctx.reports.push(out.report);
      return { data: out.data, summaryAr: out.summaryAr };
    })));

  tools.push(tool('collections_summary',
    'Money collected in a period: active receipt vouchers (سندات القبض) by payment method (cash, card/POS, bank transfer, cheque, online and the company’s custom methods) plus cash-sale invoices collected at the point of sale, and the combined total. Use for «التحصيل» or «كم حصّلنا». Default period: current month to date.',
    PERIOD_PROPS,
    (args) => safely('collections_summary', async () => {
      const p = periodFrom(ctx, args);
      if (isPeriodError(p)) return p;
      const [groups, cash, config] = await Promise.all([
        deps.receiptsByMethod(tid, p.gte, p.lt),
        deps.cashSalesCollected(tid, p.gte, p.lt),
        deps.paymentMethodsConfig(tid),
      ]);
      const out = collectionsReport(ctx, p, collectionsByMethod(groups, config), cash);
      ctx.reports.push(out.report);
      return { data: out.data, summaryAr: out.summaryAr };
    })));

  if (ctx.warehouseOn) {
    tools.push(tool('purchases_inventory',
      'Purchases and inventory: net purchases in the period (priced receipts into the company warehouse minus returns to suppliers, before VAT, excluding opening stock), payments made to suppliers in the period, the warehouse stock value at purchase cost as of the period end with the top items, and supplier payables (total owed, open credit bills, overdue). Warehouse only — not stock in sales reps’ vans. Default period: current month to date.',
      PERIOD_PROPS,
      (args) => safely('purchases_inventory', async () => {
        const p = periodFrom(ctx, args);
        if (isPeriodError(p)) return p;
        const asOfLocal = asOfOf(p, ctx.todayLocal);
        const [purchases, supplierPayments, decimals, before, aging] = await Promise.all([
          deps.purchases(tid, p.gte, p.lt),
          deps.supplierPayments(tid, p.fromLocal, p.toLocal),
          deps.currencyDecimals(tid),
          // «كما في» يومٍ مضى ⇒ حركات ما قبل نهاية يومه وحدها؛ وإلا الرصيد الحالي
          asOfLocal < ctx.todayLocal ? deps.warehouseAsOf(tid, asOfLocal) : Promise.resolve(undefined),
          deps.supplierAging(tid, asOfLocal),
        ]);
        const stock = await deps.warehouseStock(tid, decimals, before);
        const out = purchasesInventoryReport(ctx, p, { purchases, supplierPayments, stock, asOfLocal, aging });
        ctx.reports.push(out.report);
        return { data: out.data, summaryAr: out.summaryAr };
      })));
  }

  tools.push(tool('receivables',
    'Customer receivables as of today: total owed by customers and the number of debtors, customer credit balances (advance payments), customers over their credit limit, and the top debtors. No period argument.',
    {},
    () => safely('receivables', async () => {
      const out = receivablesReport(ctx, await deps.receivables(tid, 10));
      ctx.reports.push(out.report);
      return { data: out.data, summaryAr: out.summaryAr };
    })));

  tools.push(tool('top_customers_products',
    'Top customers, top products and top sales reps by net sales (returns deducted) in a period. Product quantities are in each product’s base unit. Default period: current month to date.',
    { ...PERIOD_PROPS, limit: { type: 'integer', description: 'How many of each list (1-10, default 5).' } },
    (args) => safely('top_customers_products', async () => {
      const a = topSchema.safeParse(args ?? {});
      if (!a.success) return { error: 'وسائط غير صالحة — limit من 1 إلى 10، والفترة month أو from/to' };
      const p = parsePeriod(a.data, ctx.tz, ctx.todayLocal);
      if (isPeriodError(p)) return p;
      const limit = a.data.limit ?? 5;
      const [custGroups, repGroups, reps, items] = await Promise.all([
        deps.customerGroups(tid, p.gte, p.lt),
        deps.repGroups(tid, p.gte, p.lt),
        deps.activeReps(tid),
        deps.saleItems(tid, p.gte, p.lt),
      ]);
      const nets = partyNets(custGroups);
      // الترتيب قبل الأسماء: أعلى limit بالمعيار نفسه للعرض (المبلغ، أو العدد حين تُخفى المبالغ)
      const head = [...nets].sort((x, y) => (ctx.accountingOn ? y.total - x.total : y.count - x.count) || (x.id < y.id ? -1 : 1)).slice(0, limit);
      const names = await deps.customerNames(tid, head.map((x) => x.id));
      const customers = head.map((x) => ({ ...x, name: names.get(x.id) ?? '—' }));
      const products = items ? salesByProduct([{ items: items.sales }], new Map(), [{ items: items.returns }]) : null;
      // المبالغ مخفية ⇒ يُرتَّب كل المناديب بالعدد (rankTopReps يقصّ بالمبلغ)
      const ranked = rankTopReps(reps, repGroups as RepTypeGroup[], ctx.accountingOn ? limit : reps.length);
      const out = topReport(ctx, p, { customers, products, reps: ranked }, limit);
      ctx.reports.push(out.report);
      return { data: out.data, summaryAr: out.summaryAr };
    })));

  if (!ctx.booksActivated && ctx.accountingOn) {
    tools.push(tool('profit_estimate',
      'ESTIMATED gross profit for a period (the company has no activated books): net sales before VAT minus (net quantity sold × current warehouse average purchase cost). It excludes expenses and salaries. Always present the result as an estimate (تقديري) and say that activating the books (الدفاتر) gives exact profit. Default period: current month to date.',
      PERIOD_PROPS,
      (args) => safely('profit_estimate', async () => {
        const p = periodFrom(ctx, args);
        if (isPeriodError(p)) return p;
        const [groups, items] = await Promise.all([deps.salesByType(tid, p.gte, p.lt), deps.saleItems(tid, p.gte, p.lt)]);
        if (!items) return { error: `الفترة كبيرة (أكثر من ${SALE_ITEMS_CAP} بند فاتورة) — اطلب فترة أقصر` };
        // بلا «مخزون الشركة» لا وارد مسعَّر أصلاً — لا داعي للاستعلام
        const avgCost = ctx.warehouseOn ? await deps.avgCosts(tid, await deps.currencyDecimals(tid)) : new Map<string, number>();
        const f = salesFigures(groups);
        const products = salesByProduct([{ items: items.sales }], new Map(), [{ items: items.returns }]);
        const out = profitEstimateReport(ctx, p, f, profitEstimateOf(f, products, avgCost));
        ctx.reports.push(out.report);
        return { data: out.data, summaryAr: out.summaryAr };
      })));
  }

  return tools;
}

/** للاختبار: أسماء الأدوات المبنية لسياق */
export const opsToolNames = (ctx: AcctCtx, deps?: OpsDeps): string[] => buildOpsTools(ctx, deps).map((t) => t.spec.function.name);
