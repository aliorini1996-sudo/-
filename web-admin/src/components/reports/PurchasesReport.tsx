import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { reportApi } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { formatCurrency, formatNumber } from '../../utils/format';
import { filterFlat } from '../../lib/reportSearch';
import { appliedRangeOf, defaultedRangeNote } from '../../lib/reportsAccuracy';
import { baseQtyText } from '../../lib/adminUnits';
import {
  PURCHASE_GROUP_BYS, isPurchaseGroupBy, purchaseGroupLabel, purchaseRowName, purchasesTotals, purchaseColumns, purchasesSheets,
  hasUnclassified, plainQty, type PurchaseGroupBy, type PurchaseMoney, type PurchaseRow, type PurchasesData, type PurchasesExport,
  type PurchaseCol,
} from './purchasesReportLogic';

/**
 * «تقرير المشتريات» (طلب المالك ١٧ نوفمبر ٢٠٢٦) — تبويبٌ في صفحة التقارير يقرأ GET /reports/purchases
 * (backend/src/services/reports/purchasesReport.ts): وارد المستودع والمرتجع للمورّد، بلا المخزون الافتتاحي ولا التسويات.
 *
 * الأعمدة حسابٌ من اليمين إلى اليسار: المشتريات (قبل الضريبة) − المرتجعات = صافي المشتريات، + الضريبة = الإجمالي. ثم الإجمالي
 * مقسوماً نقدياً وآجلاً، والمدفوع والمتبقّي لفواتير الآجل في الفترة بحالها اليوم (لا يُقسَم سندٌ على أصناف: يغيبان في تجميع الصنف).
 * «إزالة الضريبة»: الخادم لا يرسل الضريبة (taxHidden) فلا عمود ولا بطاقة ولا ذكر لها.
 *
 * البحث على المعروض (الاسم والرمز) والتصدير يتبعه — كتقرير المبيعات. والتصدير عبر `onExport`: يُستدعى كلما تغيّر المعروض
 * بأوراقه الجاهزة (الإجماليات ثم الصفوف) فتضعها الصفحة في buildSheets كما هي لـExcel وPDF معاً.
 */

export {
  PURCHASE_GROUP_BYS, purchaseRowName, purchasesTotals, purchasesSheets,
  type PurchaseGroupBy, type PurchaseMoney, type PurchaseRow, type PurchaseSummary, type PurchasesData, type PurchasesExport,
} from './purchasesReportLogic';

export interface PurchasesReportProps {
  from?: string;
  to?: string;
  search?: string;
  groupBy: string;
  onExport?: (x: PurchasesExport | null) => void;
}

/** قائمة «تجميع حسب» لتقرير المشتريات — بشكل فلاتر صفحة التقارير */
export function PurchasesGroupBySelect({ value, onChange }: { value: string; onChange: (v: PurchaseGroupBy) => void }) {
  const tr = useTr();
  return (
    <div>
      <label className="label">{tr('تجميع حسب')}</label>
      <select className="input w-36" value={isPurchaseGroupBy(value) ? value : 'vendor'} onChange={e => onChange(e.target.value as PurchaseGroupBy)}>
        {PURCHASE_GROUP_BYS.map(g => <option key={g} value={g}>{purchaseGroupLabel(g, tr)}</option>)}
      </select>
    </div>
  );
}

const CHART_MAX = 62;
const noteCls = 'rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs px-3 py-2';

export default function PurchasesReport({ from = '', to = '', search = '', groupBy: groupByProp, onExport }: PurchasesReportProps) {
  const tr = useTr();
  const groupBy: PurchaseGroupBy = isPurchaseGroupBy(groupByProp) ? groupByProp : 'vendor';

  const q = useQuery({
    queryKey: ['report-purchases', from, to, groupBy],
    queryFn: async () => {
      const params: Record<string, string> = { groupBy };
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await reportApi.purchases(params);
      return {
        data: res.data.data as PurchasesData,
        applied: appliedRangeOf(res.data),
        truncated: res.data.meta?.truncated === true,
      };
    },
    retry: (n, err: unknown) => n < 2 && (err as { response?: { status?: number } })?.response?.status !== 403,
  });

  const data = q.data?.data ?? null;
  const term = search.trim();
  const rows = useMemo(
    () => (data ? filterFlat(data.rows, term, r => [purchaseRowName(r, groupBy, tr), r.name, r.code]) : []),
    [data, term, groupBy, tr],
  );
  const totals = useMemo(() => (data ? purchasesTotals(rows, data.summary, !!term, groupBy) : null), [data, rows, term, groupBy]);
  const taxHidden = data?.taxHidden === true;
  const showUnc = !!data && hasUnclassified(rows, totals);
  const cols = useMemo(() => purchaseColumns(groupBy, taxHidden, showUnc, tr), [groupBy, taxHidden, showUnc, tr]);
  const weightSum = cols.reduce((s, c) => s + c.weight, 0);
  const truncNote = q.data?.truncated ? tr('النتيجة مقطوعة عند الحد الأقصى للحركات ضيق المدى') : null;

  // التصدير يتبع المعروض: كلما تغيّر سلّمت الصفحةَ أوراقه، ولا شيء بلا صفوف (فتقول «لا توجد بيانات للتصدير»). المستدعي في مرجعٍ
  // فلا يعيد تغيُّرُ هويّته (دالّةٌ تُنشأ في كل رسم) التسليمَ في حلقة
  const exportRef = useRef(onExport);
  exportRef.current = onExport;
  const applied = q.data?.applied ?? null;
  useEffect(() => {
    const out = exportRef.current;
    if (!out) return;
    if (!data || !totals || !rows.length) { out(null); return; }
    out({
      sheets: purchasesSheets(data, rows, totals, tr),
      fname: `${tr('تقرير المشتريات')} - ${purchaseGroupLabel(groupBy, tr)}`,
      applied,
      shown: rows.length,
      note: truncNote,
    });
  }, [data, rows, totals, tr, groupBy, applied, truncNote]);
  useEffect(() => () => { exportRef.current?.(null); }, []);

  if (q.isPending) return <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>;
  if (q.isError || !data || !totals) {
    const code = (q.error as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;
    return (
      <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
        <span>{code === 'WAREHOUSE_NOT_ENABLED' ? tr('ميزة مخزون الشركة غير مفعلة لهذه الشركة') : tr('تعذر تحميل التقرير')}</span>
        {code !== 'WAREHOUSE_NOT_ENABLED' && <button onClick={() => q.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>}
      </div>
    );
  }

  const rangeNote = defaultedRangeNote(q.data?.applied, tr);
  const money = (v: number | null | undefined) => (v == null ? '—' : formatCurrency(v));
  const chrono = groupBy === 'day' || groupBy === 'month';
  const chartRows = (chrono ? rows.slice(-CHART_MAX) : rows.slice(0, 10)).map(r => ({ name: purchaseRowName(r, groupBy, tr), value: r.netPurchases }));

  const buyCards: { label: string; value: number; tone: string; sub?: string }[] = [
    { label: tr('المشتريات'), value: totals.net, tone: 'text-gray-700', sub: taxHidden ? undefined : tr('قبل الضريبة') },
    { label: tr('المرتجعات'), value: totals.returns, tone: 'text-amber-700', sub: !term ? `${formatNumber(data.summary.returnsCount)} ${tr('حركة')}` : undefined },
    { label: tr('صافي المشتريات'), value: totals.netPurchases, tone: 'text-[#E15A30]', sub: taxHidden ? undefined : tr('قبل الضريبة') },
    ...(taxHidden ? [] : [
      { label: tr('الضريبة'), value: totals.netTax ?? 0, tone: 'text-gray-700' },
      { label: tr('الإجمالي'), value: totals.netTotal, tone: 'text-[#1F1A13]' },
    ]),
  ];
  const payCards: { label: string; value: number | null; tone: string }[] = [
    { label: tr('نقدي'), value: totals.cash, tone: 'text-[#1E7A52]' },
    { label: tr('آجل'), value: totals.credit, tone: 'text-[#E15A30]' },
    ...(showUnc ? [{ label: tr('غير مصنف'), value: totals.unclassified, tone: 'text-gray-500' }] : []),
    { label: tr('المدفوع من الآجل'), value: totals.paid, tone: 'text-gray-700' },
    { label: tr('المتبقي من الآجل'), value: totals.remaining, tone: 'text-[#C0392B]' },
  ];
  const gridOf = (n: number) => (n >= 5 ? 'grid-cols-2 md:grid-cols-5' : n === 4 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2 md:grid-cols-3');

  const cell = (r: PurchaseMoney & Partial<PurchaseRow>, c: PurchaseCol, isTotal = false): ReactNode => {
    switch (c.id) {
      case 'name': return isTotal ? tr('الإجمالي') : purchaseRowName(r as PurchaseRow, groupBy, tr);
      case 'count':
        if (groupBy === 'product') return isTotal ? '' : baseQtyText(Number(r.qty) || 0, r as PurchaseRow, plainQty, { withUnit: true });
        return isTotal ? formatNumber(rows.reduce((s, x) => s + x.bills, 0)) : formatNumber(r.bills ?? 0);
      default: {
        const v = (r as unknown as Record<string, number | null | undefined>)[c.id];
        return money(v);
      }
    }
  };
  const tone = (id: string) => (id === 'netPurchases' ? 'font-semibold text-[#E15A30]' : id === 'netTotal' ? 'font-semibold text-[#1F1A13]'
    : id === 'remaining' ? 'text-[#C0392B]' : id === 'returns' ? 'text-amber-700' : 'text-gray-600');
  const vis = (c: PurchaseCol) => (c.wide ? 'hidden md:table-cell' : '');

  return (
    <div className="space-y-4">
      {rangeNote && <div className={noteCls}>{rangeNote}</div>}
      {truncNote && <div className={noteCls}>{truncNote}</div>}

      <div className={`grid ${gridOf(buyCards.length)} gap-4`}>
        {buyCards.map(c => (
          <div key={c.label} className="card text-center">
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className={`text-xl font-bold tabular-nums ${c.tone}`}>{formatCurrency(c.value)}</p>
            {c.sub && <p className="text-[11px] text-gray-400 mt-0.5">{c.sub}</p>}
          </div>
        ))}
      </div>
      <div className={`grid ${gridOf(payCards.length)} gap-4`}>
        {payCards.map(c => (
          <div key={c.label} className="card text-center">
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className={`text-xl font-bold tabular-nums ${c.tone}`}>{money(c.value)}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400">
        {!term && <>{formatNumber(data.summary.bills)} {tr('فاتورة شراء')} · {formatNumber(data.summary.vendors)} {tr('مورد')} · </>}
        {tr('المدفوع والمتبقي لفواتير الآجل في الفترة بحالها اليوم')}
        {data.summary.unpricedEntries > 0 && <> · {formatNumber(data.summary.unpricedEntries)} {tr('وارد بلا تكلفة لا قيمة له في التقرير')}</>}
      </p>

      {rows.length === 0 ? (
        <div className="card text-center text-gray-400 py-12">{term ? tr('لا نتائج مطابقة للبحث') : tr('لا مشتريات في هذه الفترة')}</div>
      ) : (
        <>
          <div className="card">
            <h3 className="font-semibold text-gray-700 mb-4">{tr('صافي المشتريات حسب')} {purchaseGroupLabel(groupBy, tr)}</h3>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={chartRows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="value" fill="#E15A30" radius={[4, 4, 0, 0]} name={tr('صافي المشتريات')} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card p-0 overflow-hidden">
            <div className="table-wrapper border-0 rounded-none">
              {/* عرضٌ ثابت بنِسَب للأعمدة: كل شيء ظاهر بلا تمرير أفقي، والأعمدة الثانوية من md فما فوق */}
              <table className="table table-fixed">
                <thead>
                  <tr>
                    {cols.map(c => (
                      <th key={c.id} title={c.title} style={{ width: `${((c.weight / weightSum) * 100).toFixed(2)}%` }}
                        className={`px-2 ${vis(c)}`}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.key}>
                      {cols.map(c => (
                        <td key={c.id} className={`px-2 text-xs break-words ${c.id === 'name' ? 'font-medium text-gray-800' : `tabular-nums ${tone(c.id)}`} ${vis(c)}`}>
                          {cell(r, c)}
                          {c.id === 'name' && groupBy === 'product' && r.code && <span className="block text-[11px] text-gray-400 tabular-nums">{r.code}</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[#FAF7F0] font-semibold">
                    {cols.map(c => (
                      <td key={c.id} className={`px-2 text-xs tabular-nums border-t border-[#E9E1D3] ${c.id === 'name' ? 'text-gray-800' : tone(c.id)} ${vis(c)}`}>
                        {cell(totals, c, true)}
                      </td>
                    ))}
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
