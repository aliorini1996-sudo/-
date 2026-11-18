/**
 * «تقرير الربح» — مجمل الربح قبل المصروفات (طلب المالك: تبويبات تقارير المشتريات والربح والضرائب).
 *
 * الأرقام كلها من الخادم (`GET /reports/profit`، backend/src/services/reports/profitReport.ts): المبيعات الصافية بعد المرتجعات
 * وقبل الضريبة، والتكلفة من لقطات الدفاتر المربوطة أو بمتوسّط تكلفة الشراء المرجّح حتى نهاية الفترة، والصنف بلا سعر شراء
 * تكلفته صفر بعَلَم «بلا تكلفة». هذه الشاشة للعرض والتصفية بالبحث والتصدير وحدها.
 *
 * - البحث على المعروض والتصدير يتبعه (كتقرير المبيعات): مع البحث تُجمع البطاقات من الصفوف المطابقة، وبلاه من ملخّص الخادم.
 * - سقف الخادم (أحدث ٢٠٬٠٠٠ فاتورة في المدى — meta.truncated/limit) يُعلَن على الشاشة وفي ملاحظة الملف: الأرقام عنها وحدها.
 * - «إزالة الضريبة» (taxOff من الخادم): لا تُكتب «قبل الضريبة» في أي موضع.
 * - الجدول بعرضٍ ثابت ونِسَب أعمدة: كل شيء ظاهر بلا تمرير أفقي، والأسماء الطويلة تلتفّ داخل خلاياها.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { AlertTriangle } from 'lucide-react';
import { reportApi } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { activeLocale, formatCurrency, formatNumber, gregorianLocale } from '../../utils/format';
import { num, type ExcelSheet } from '../../utils/excel';
import { appliedRangeOf, defaultedRangeNote, truncationNote, truncationOf, type AppliedRange, type Truncation } from '../../lib/reportsAccuracy';
import { filterFlat } from '../../lib/reportSearch';
import { baseQtyText, hasBigUnit } from '../../lib/adminUnits';
import { roundHalfUp } from '../../lib/money';
import type { UnitDef } from '../../lib/units';

type Tr = (ar: string) => string;

// ═══ التجميع ═══

export type ProfitGroup = 'product' | 'rep' | 'customer' | 'month';
/** خيارات «تجميع حسب» لتبويب الربح — التسميات مفاتيح tr() */
export const PROFIT_GROUPS: { id: ProfitGroup; label: string }[] = [
  { id: 'product', label: 'الصنف' },
  { id: 'rep', label: 'المندوب' },
  { id: 'customer', label: 'العميل' },
  { id: 'month', label: 'الشهر' },
];
/** تجميع الصفحة (قد يكون «القناة» من تبويب المبيعات) ⇐ تجميعٌ يقبله تقرير الربح، والافتراضي الصنف */
export const profitGroupOf = (g: string | null | undefined): ProfitGroup =>
  (PROFIT_GROUPS.some((x) => x.id === g) ? (g as ProfitGroup) : 'product');

// ═══ الردّ ═══

export interface ProfitRowDto {
  key: string;
  name: string;
  code?: string | null;
  /** للصنف: صافي الكمية بالأساس (البيع − المرتجع) */
  qty?: number;
  unit?: string;
  units?: UnitDef[];
  primaryUnitId?: string | null;
  /** فواتير البيع في المجموعة */
  count: number;
  netSales: number;
  cost: number;
  grossProfit: number;
  marginPct: number | null;
  noCost: boolean;
  noCostQty?: number;
}
export interface ProfitSummaryDto {
  netSales: number; cost: number; grossProfit: number; marginPct: number | null;
  salesTotal: number; returnsTotal: number; invoicesCount: number; returnsCount: number;
  noCostProducts: number;
  noCostList: { key: string; productId: string | null; name: string; code: string | null; qty: number }[];
  costSource: 'SNAPSHOT' | 'AVERAGE' | 'MIXED' | 'NONE';
}
export interface ProfitReportDto {
  groupBy: ProfitGroup;
  rows: ProfitRowDto[];
  summary: ProfitSummaryDto;
  taxOff: boolean;
  currencyDecimals: number;
  linked: boolean;
  /** `meta.appliedRange` — المدى الذي طبّقه الخادم بأيام الشركة */
  applied: AppliedRange | null;
  /** `meta.truncated/limit` — قرأ الخادم أحدث الفواتير حتى سقفه وحدها */
  trunc?: Truncation | null;
}

export interface ProfitParams {
  from?: string; to?: string; groupBy: string;
  teamId?: string; salesRepId?: string; customerId?: string; locationId?: string;
}

/** معاملات الطلب: الفارغ لا يُرسل */
export function profitQueryParams(p: ProfitParams): Record<string, string> {
  const out: Record<string, string> = { groupBy: profitGroupOf(p.groupBy) };
  for (const k of ['from', 'to', 'teamId', 'salesRepId', 'customerId', 'locationId'] as const) {
    const v = p[k];
    if (v) out[k] = v;
  }
  return out;
}

/** الاستعلام — مفتاحه المعاملات نفسها، فاستدعاؤه من الصفحة (للتصدير) ومن المكوّن طلبٌ واحد في الكاش */
export function useProfitReport(p: ProfitParams, enabled = true) {
  const params = profitQueryParams(p);
  return useQuery({
    queryKey: ['report-profit', params],
    queryFn: async (): Promise<ProfitReportDto> => {
      const res = await reportApi.profit(params);
      return { ...(res.data.data as Omit<ProfitReportDto, 'applied' | 'trunc'>), applied: appliedRangeOf(res.data), trunc: truncationOf(res.data) };
    },
    enabled,
  });
}

// ═══ العرض ═══

/** الشهر «نوفمبر ٢٠٢٦» بتقويمٍ ميلادي صريح ولغة الواجهة */
export function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  return new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toLocaleDateString(gregorianLocale(activeLocale()), { year: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** اسم الصفّ للعرض: الشهر منسَّقاً، والصفوف الخاصة («بلا مندوب»، «صنف محذوف»، «تعديلات أسعار») مترجمةً */
export function profitRowName(r: Pick<ProfitRowDto, 'key' | 'name'>, group: ProfitGroup, tr: Tr): string {
  if (group === 'month') return monthLabel(r.key);
  if (group === 'rep' && r.key === '—') return tr('بلا مندوب');
  if (group === 'product' && r.key === '__adjustments') return tr('تعديلات أسعار');
  if (group === 'product' && r.key.startsWith('deleted:') && !r.key.slice('deleted:'.length)) return tr('صنف محذوف');
  // اسمٌ بديل يكتبه الخادم بالعربية (صنفٌ لم يُعثر عليه بلا اسمٍ محفوظ) يُترجم كغيره
  if (r.name === 'صنف محذوف') return tr('صنف محذوف');
  return r.name;
}

/** اسم صنفٍ في قائمة «بلا تكلفة»: المحذوف بلا اسم (أو باسم الخادم البديل) مترجماً */
const noCostName = (name: string | null | undefined, tr: Tr) => (name && name !== 'صنف محذوف' ? name : tr('صنف محذوف'));

/** أرقام الكمية كما في تقرير المبيعات (بلا منسّق محلّي) */
const plainQty = (n: number) => String(Number(n.toFixed(3)));
/** كمية صفّ الصنف بوحداته «٢ كرتون و٣ حبة» */
const qtyText = (r: ProfitRowDto) => (hasBigUnit(r.units) ? baseQtyText(Number(r.qty) || 0, r, plainQty) : plainQty(Number(r.qty) || 0));
const pctText = (m: number | null) => (m == null ? '—' : `${formatNumber(m)}%`);

/** الصفوف بعد البحث — باسم العرض أو الاسم المخزَّن أو الكود */
export function filterProfitRows(rows: ProfitRowDto[], q: string, group: ProfitGroup, tr: Tr): ProfitRowDto[] {
  return filterFlat(rows, q, (r) => [profitRowName(r, group, tr), r.name, r.code]);
}

export interface ProfitTotals { netSales: number; cost: number; grossProfit: number; marginPct: number | null }

/** إجماليات المعروض: ملخّص الخادم بلا بحث، ومجموع الصفوف المطابقة معه (التصدير يتبع المعروض) */
export function profitTotals(data: ProfitReportDto, shown: ProfitRowDto[], searching: boolean): ProfitTotals {
  if (!searching) {
    const s = data.summary;
    return { netSales: s.netSales, cost: s.cost, grossProfit: s.grossProfit, marginPct: s.marginPct };
  }
  const dec = Number.isInteger(data.currencyDecimals) ? data.currencyDecimals : 2;
  const netSales = roundHalfUp(shown.reduce((s, r) => s + r.netSales, 0), dec) || 0;
  const cost = roundHalfUp(shown.reduce((s, r) => s + r.cost, 0), dec) || 0;
  const grossProfit = roundHalfUp(netSales - cost, dec) || 0;
  return { netSales, cost, grossProfit, marginPct: netSales > 0 ? roundHalfUp((grossProfit / netSales) * 100, 2) : null };
}

/** مصدر التكلفة سطراً تحت العنوان — كي لا يُقرأ الرقم بغير معناه */
export function costSourceText(s: ProfitSummaryDto['costSource'], tr: Tr): string | null {
  if (s === 'SNAPSHOT') return tr('التكلفة من دفاتر التكلفة المربوطة');
  if (s === 'AVERAGE') return tr('التكلفة بمتوسط سعر الشراء المرجح حتى نهاية الفترة');
  if (s === 'MIXED') return tr('التكلفة من دفاتر التكلفة المربوطة وما لم يرحل منها بمتوسط سعر الشراء المرجح');
  return null;
}

// ═══ التصدير ═══

export interface ProfitExport {
  sheets: ExcelSheet[];
  fname: string;
  /** ملاحظة الملف (تحت رأس PDF وفي ورقة «الفترة») */
  note: string;
  /** المدى المطبَّق لرأس PDF وورقة «الفترة» */
  applied: AppliedRange | null;
}

/**
 * أوراق Excel/PDF للمعروض: صفٌّ لكل مجموعة وصفّ الإجمالي آخراً، وورقة الأصناف بلا تكلفة إن وُجدت. المبالغ أرقامٌ (num) للجمع
 * في Excel، والهامش رقمٌ بمنزلتين، والكمية بالأساس ومعها نصّها بالوحدات لصنفٍ له وحدات.
 */
export function profitExportSheets(data: ProfitReportDto, shown: ProfitRowDto[], q: string, tr: Tr): ProfitExport | null {
  if (!shown.length) return null;
  const group = profitGroupOf(data.groupBy);
  const label = tr(PROFIT_GROUPS.find((g) => g.id === group)?.label ?? 'الصنف');
  const isProduct = group === 'product';
  const multi = isProduct && shown.some((r) => hasBigUnit(r.units));
  const t = profitTotals(data, shown, !!q.trim());
  const yes = tr('نعم');
  const rows: Record<string, unknown>[] = shown.map((r) => ({
    [label]: profitRowName(r, group, tr),
    ...(isProduct && { [tr('الكود')]: r.code || '' }),
    ...(isProduct ? { [tr('الكمية')]: Number(r.qty) || 0 } : { [tr('عدد الفواتير')]: r.count }),
    ...(multi && { [tr('الكمية بوحداتها')]: qtyText(r) }),
    [tr('المبيعات الصافية')]: num(r.netSales),
    [tr('التكلفة')]: num(r.cost),
    [tr('مجمل الربح')]: num(r.grossProfit),
    [tr('هامش الربح %')]: r.marginPct ?? '',
    [tr('بلا تكلفة')]: r.noCost ? yes : '',
  }));
  rows.push({
    [label]: tr('الإجمالي'),
    ...(isProduct && { [tr('الكود')]: '' }),
    ...(isProduct ? { [tr('الكمية')]: '' } : { [tr('عدد الفواتير')]: '' }),
    ...(multi && { [tr('الكمية بوحداتها')]: '' }),
    [tr('المبيعات الصافية')]: num(t.netSales),
    [tr('التكلفة')]: num(t.cost),
    [tr('مجمل الربح')]: num(t.grossProfit),
    [tr('هامش الربح %')]: t.marginPct ?? '',
    [tr('بلا تكلفة')]: '',
  });
  const widths = [28, ...(isProduct ? [12] : []), 14, ...(multi ? [22] : []), 16, 16, 16, 12, 10];
  const sheets: ExcelSheet[] = [{ name: tr('مجمل الربح'), rows, colWidths: widths }];
  const list = data.summary.noCostList ?? [];
  if (list.length) {
    sheets.push({
      name: tr('أصناف بلا تكلفة'), colWidths: [30, 14, 16],
      rows: list.map((p) => ({ [tr('الصنف')]: noCostName(p.name, tr), [tr('الكود')]: p.code || '', [tr('الكمية بلا تكلفة')]: p.qty })),
    });
  }
  const note = [
    tr('مجمل الربح قبل المصروفات'),
    truncationNote(data.trunc, tr, formatNumber, 'newest'),
    costSourceText(data.summary.costSource, tr),
    data.summary.noCostProducts > 0 ? tr('{n} صنف بلا سعر شراء احتسبت تكلفتها صفرا').replace('{n}', formatNumber(data.summary.noCostProducts)) : null,
  ].filter(Boolean).join(' — ');
  return { sheets, fname: tr('تقرير الربح'), note, applied: data.applied };
}

// ═══ المكوّن ═══

const CHART_ROWS = 10;
const NO_COST_SHOWN = 8;

export interface ProfitReportProps extends Omit<ProfitParams, 'groupBy'> {
  groupBy: string;
  /** البحث النصّي من فلتر الصفحة — يصفّي المعروض والتصدير معاً */
  search?: string;
  /** يُستدعى كلما تغيّر المعروض: أوراق التصدير والملاحظة والمدى المطبَّق (null بلا بيانات) — مرّر setState ثابتاً */
  onExportRows?: (x: ProfitExport | null) => void;
  /** false يوقف الطلب (تبويبٌ غير ظاهر) */
  enabled?: boolean;
}

export default function ProfitReport({ search = '', onExportRows, enabled = true, ...params }: ProfitReportProps) {
  const tr = useTr();
  const group = profitGroupOf(params.groupBy);
  const query = useProfitReport({ ...params, groupBy: group }, enabled);
  const data = query.data;
  const q = search.trim();

  const shown = useMemo(() => (data ? filterProfitRows(data.rows, q, group, tr) : []), [data, q, group, tr]);
  const totals = useMemo(() => (data ? profitTotals(data, shown, !!q) : null), [data, shown, q]);
  const exportPayload = useMemo(() => (data ? profitExportSheets(data, shown, q, tr) : null), [data, shown, q, tr]);

  // المرجع يحمل آخر دالّة فلا يعيد تغيّرُ هويّتها (دالّةٌ مضمَّنة) تشغيلَ الأثر في كل رسم
  const exportRef = useRef(onExportRows);
  exportRef.current = onExportRows;
  useEffect(() => { exportRef.current?.(exportPayload); }, [exportPayload]);
  useEffect(() => () => exportRef.current?.(null), []);

  const rangeNote = defaultedRangeNote(data?.applied, tr);
  const truncNote = truncationNote(data?.trunc, tr, formatNumber, 'newest');
  const noteCls = 'rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs px-3 py-2';

  if (query.isPending) {
    return <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>;
  }
  if (query.isError || !data || !totals) {
    return (
      <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
        <span>{tr('تعذر تحميل التقرير')}</span>
        <button onClick={() => query.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
      </div>
    );
  }

  const isProduct = group === 'product';
  const groupLabel = tr(PROFIT_GROUPS.find((g) => g.id === group)?.label ?? 'الصنف');
  const salesHint = data.taxOff ? tr('بعد المرتجعات') : tr('بعد المرتجعات وقبل الضريبة');
  const sourceText = costSourceText(data.summary.costSource, tr);
  const noCost = data.summary.noCostList ?? [];
  const profitCls = (v: number) => (v < 0 ? 'text-red-600' : 'text-emerald-700');
  const chartRows = (group === 'month' ? shown : shown.slice(0, CHART_ROWS)).map((r) => ({
    name: profitRowName(r, group, tr), netSales: r.netSales, cost: r.cost, grossProfit: r.grossProfit,
  }));

  return (
    <div className="space-y-4">
      {rangeNote && <div className={noteCls}>{rangeNote}</div>}
      {truncNote && <div className={noteCls}>{truncNote}</div>}

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-semibold text-gray-800">{tr('مجمل الربح قبل المصروفات')}</h3>
        {sourceText && <p className="text-xs text-gray-500">{sourceText}</p>}
      </div>

      {/* البطاقات: ملخّص الخادم، ومع البحث مجموع المطابق المعروض */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card text-center">
          <p className="text-xs text-gray-500">{tr('المبيعات الصافية')}</p>
          <p className="text-xl font-bold text-gray-800 tabular-nums">{formatCurrency(totals.netSales)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">{salesHint}</p>
        </div>
        <div className="card text-center">
          <p className="text-xs text-gray-500">{tr('التكلفة')}</p>
          <p className="text-xl font-bold text-gray-700 tabular-nums">{formatCurrency(totals.cost)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">{tr('تكلفة البضاعة المباعة')}</p>
        </div>
        <div className="card text-center">
          <p className="text-xs text-gray-500">{tr('مجمل الربح')}</p>
          <p className={`text-xl font-bold tabular-nums ${profitCls(totals.grossProfit)}`}>{formatCurrency(totals.grossProfit)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">{tr('قبل المصروفات')}</p>
        </div>
        <div className="card text-center">
          <p className="text-xs text-gray-500">{tr('هامش الربح')}</p>
          <p className={`text-xl font-bold tabular-nums ${totals.marginPct != null && totals.marginPct < 0 ? 'text-red-600' : 'text-gray-800'}`}>{pctText(totals.marginPct)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">{tr('مجمل الربح من المبيعات الصافية')}</p>
        </div>
      </div>

      {/* أصنافٌ بلا سعر شراء: تكلفتها صفر فربحها مضخَّم — تُعلن بعددها وأسمائها لا تُخفى */}
      {data.summary.noCostProducts > 0 && (
        <div className={`${noteCls} flex items-start gap-2`}>
          <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">
              {tr('{n} صنف بلا سعر شراء احتسبت تكلفتها صفرا').replace('{n}', formatNumber(data.summary.noCostProducts))}
            </p>
            <p className="mt-0.5">
              {noCost.slice(0, NO_COST_SHOWN).map((p) => noCostName(p.name, tr)).join(' · ')}
              {noCost.length > NO_COST_SHOWN && ` ${tr('و{n} أخرى').replace('{n}', formatNumber(noCost.length - NO_COST_SHOWN))}`}
            </p>
            <p className="mt-0.5 text-amber-700">{tr('أدخل سعر الشراء في وارد المستودع ليظهر ربحها الحقيقي')}</p>
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="card text-center text-gray-400 py-12">
          {q ? tr('لا نتائج مطابقة للبحث') : tr('لا مبيعات في هذه الفترة')}
        </div>
      ) : (
        <>
          <div className="card">
            <h3 className="font-semibold text-gray-700 mb-4">{tr('مجمل الربح حسب')} {groupLabel}</h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartRows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="netSales" fill="#3b82f6" radius={[4, 4, 0, 0]} name={tr('المبيعات الصافية')} />
                <Bar dataKey="cost" fill="#B8AE9C" radius={[4, 4, 0, 0]} name={tr('التكلفة')} />
                <Bar dataKey="grossProfit" fill="#E15A30" radius={[4, 4, 0, 0]} name={tr('مجمل الربح')} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card p-0 overflow-hidden">
            <div className="table-wrapper border-0 rounded-none">
              {/* عرض ثابت بنِسَب للأعمدة: كل شيء ظاهر بلا تمرير أفقي، والأسماء الطويلة تلتفّ داخل خلاياها */}
              <table className="table table-fixed">
                <thead>
                  <tr>
                    <th className="w-[28%]">{groupLabel}</th>
                    <th className="w-[14%]">{isProduct ? tr('الكمية') : tr('عدد الفواتير')}</th>
                    <th className="w-[16%]">{tr('المبيعات الصافية')}</th>
                    <th className="w-[15%]">{tr('التكلفة')}</th>
                    <th className="w-[16%]">{tr('مجمل الربح')}</th>
                    <th className="w-[11%]">{tr('الهامش')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.key}>
                      <td className="font-medium text-gray-800 break-words">
                        <span>{profitRowName(r, group, tr)}</span>
                        {isProduct && r.code && <span className="block text-[11px] text-gray-400 tabular-nums">{r.code}</span>}
                        {r.noCost && (
                          <span
                            title={isProduct ? tr('لا سعر شراء لهذا الصنف فتكلفته صفر') : tr('فيها أصناف بلا سعر شراء تكلفتها صفر')}
                            className="mt-1 inline-block rounded-full bg-amber-100 text-amber-800 text-[11px] px-2 py-0.5">
                            {tr('بلا تكلفة')}
                          </span>
                        )}
                      </td>
                      <td className="text-gray-600 tabular-nums break-words">{isProduct ? qtyText(r) : formatNumber(r.count)}</td>
                      <td className="tabular-nums break-words">{formatCurrency(r.netSales)}</td>
                      <td className="text-gray-600 tabular-nums break-words">{formatCurrency(r.cost)}</td>
                      <td className={`font-semibold tabular-nums break-words ${profitCls(r.grossProfit)}`}>{formatCurrency(r.grossProfit)}</td>
                      <td className="tabular-nums break-words">{pctText(r.marginPct)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[#FAF7F0] font-semibold">
                    <td>{tr('الإجمالي')}</td>
                    <td />
                    <td className="tabular-nums break-words">{formatCurrency(totals.netSales)}</td>
                    <td className="tabular-nums break-words">{formatCurrency(totals.cost)}</td>
                    <td className={`tabular-nums break-words ${profitCls(totals.grossProfit)}`}>{formatCurrency(totals.grossProfit)}</td>
                    <td className="tabular-nums break-words">{pctText(totals.marginPct)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
