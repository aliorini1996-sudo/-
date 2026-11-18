import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { companyApi, reportApi } from '../../api/client';
import { useTr } from '../../i18n/strings';
import { activeLocale, formatCurrency } from '../../utils/format';
import { appliedRangeOf, defaultedRangeNote, type AppliedRange } from '../../lib/reportsAccuracy';
import { isTaxOff } from '../../lib/taxMode';
import { num, type ExcelSheet } from '../../utils/excel';
import { negAmount } from '../../lib/money';

/**
 * «تقرير الضرائب» (طلب المالك ١٨ نوفمبر ٢٠٢٦) — GET /reports/tax (backend services/reports/taxReport.ts):
 * ضريبة المخرجات (المبيعات والإشعار المدين، والمرتجع والإشعار الدائن يطرحان) وضريبة المدخلات من فواتير الموردين المصنَّفة
 * القابلة للاسترداد (مرتجعات الموردين تطرح، وغير المستردة تُعرض منفصلة ولا تُطرح) وصافي المستحق، مجمّعةً بالشهر أو بالربع
 * (فترة الإقرار) أو بالنسبة. الشركة التي أزالت ضريبتها (أو أُطفئت محاسبتها) لا تقرير لها: التبويب مخفيّ (useTaxTabVisible) والمكوّن
 * لا يطلب شيئاً، والخادم يعيد بياناً فارغاً صريحاً taxDisabled (أو ٤٠٣ للمحاسبة) لو طُلب مباشرة.
 */

type Tr = (s: string) => string;

export type TaxGroupBy = 'month' | 'quarter' | 'rate';
export type TaxCategory = 'S' | 'Z' | 'E' | 'O' | '0';

export interface TaxRowDto {
  key: string;
  kind: TaxGroupBy;
  start: string | null;
  end: string | null;
  rate: number | null;
  category: TaxCategory | null;
  output: { salesBase: number; salesTax: number; returnsBase: number; returnsTax: number; base: number; tax: number };
  input: { purchasesBase: number; purchasesTax: number; returnsBase: number; returnsTax: number; base: number; tax: number } | null;
  nonRecoverable: { base: number; tax: number } | null;
  net: number | null;
}
interface Counted { count: number; base: number; tax: number }
export interface TaxSummaryDto {
  output: { sales: Counted; debitNotes: Counted; returns: Counted; base: number; tax: number; zeroBase: number };
  input: { purchases: Counted; returns: Counted; base: number; tax: number } | null;
  nonRecoverable: Counted | null;
  net: number | null;
  position: 'PAYABLE' | 'REFUNDABLE' | 'NIL' | null;
}
export interface TaxReportDto {
  taxDisabled: boolean;
  groupBy: TaxGroupBy;
  decimals: number;
  /** مقيَّد النطاق: المخرجات لفواتير نطاقه وحدها */
  scoped: boolean;
  /** سبب غياب المدخلات والصافي: SCOPE مقيَّد النطاق، PERMISSION ممنوعٌ من المشتريات — null ⇒ حاضرة */
  inputHidden?: 'SCOPE' | 'PERMISSION' | null;
  rows: TaxRowDto[];
  summary: TaxSummaryDto | null;
}
/** البيان والمدى الذي طبّقه الخادم */
export interface TaxReportResult { data: TaxReportDto; applied: AppliedRange | null }

/** ما يصل الصفحة للتصدير (Excel وPDF من الأوراق نفسها) — شكل ProfitExport: الأوراق واسم الملف والملاحظة والمدى المطبَّق */
export interface TaxExport {
  sheets: ExcelSheet[];
  fname: string;
  /** ملاحظة الملف (تحت رأس PDF وفي ورقة «الفترة») — سبب غياب المدخلات إن غابت، وإلا null */
  note: string | null;
  applied: AppliedRange | null;
}

/** نصّ خانة البحث لتبويب الضرائب (يمرّ بـtr عند العرض) */
export const TAX_SEARCH_PLACEHOLDER = 'ابحث بالفترة أو النسبة';

/** خيارات «تجميع حسب» لتبويب الضرائب — النصّ عربيٌّ يمرّ بـtr عند العرض */
export const TAX_GROUP_OPTIONS: ReadonlyArray<{ value: TaxGroupBy; label: string }> = [
  { value: 'month', label: 'الشهر' },
  { value: 'quarter', label: 'الربع (فترة الإقرار)' },
  { value: 'rate', label: 'نسبة الضريبة' },
];

/** تجميع الصفحة المشترك (قد يبقى «rep» من تبويبٍ آخر) ⇒ تجميعٌ صالح للضرائب، والافتراضي الشهر */
export const normalizeTaxGroupBy = (g: string | null | undefined): TaxGroupBy =>
  g === 'quarter' || g === 'rate' || g === 'month' ? g : 'month';

/**
 * ظهور التبويب: المحاسبة غير مطفأة صراحةً والشركة لم تُزل ضريبتها — من استعلام ['company'] المشترك (دلالة AccountingGate: الغائب
 * مفعّل). `ready` يفصل «لم نقرأ بعد» عن «قرأنا» فلا يومض التبويب ولا يُطلق طلبٌ قبل القراءة.
 */
export function useTaxTabVisible(): { visible: boolean; ready: boolean } {
  const q = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { accountingEnabled?: boolean; taxDisabled?: boolean } | null,
    staleTime: 300_000,
  });
  return { visible: q.data?.accountingEnabled !== false && !isTaxOff(q.data), ready: !q.isLoading };
}

// ═══ نصوص الصفوف ═══

const fmtRate = (r: number): string => `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 2 }).format(r)}%`;

/** اسم الصفّ: الشهر باسمه ميلادياً، والربع «الربع ٤ ٢٠٢٦»، والنسبة «١٥٪» أو فئتها */
export function taxRowLabel(row: Pick<TaxRowDto, 'key' | 'kind' | 'rate' | 'category'>, tr: Tr): string {
  if (row.kind === 'month') {
    const [y, m] = row.key.split('-').map(Number);
    if (!y || !m) return row.key;
    return new Intl.DateTimeFormat(activeLocale(), { year: 'numeric', month: 'long' }).format(new Date(y, m - 1, 1));
  }
  if (row.kind === 'quarter') {
    const q = /^(\d{4})-Q([1-4])$/.exec(row.key);
    if (!q) return row.key;
    const nf = new Intl.NumberFormat(activeLocale(), { useGrouping: false });
    return tr('الربع {q} {y}').replace('{q}', nf.format(+q[2])).replace('{y}', nf.format(+q[1]));
  }
  switch (row.category) {
    case 'Z': return tr('صفرية');
    case 'E': return tr('معفاة');
    case 'O': return tr('خارج نطاق الضريبة');
    case '0': return fmtRate(0);
    default: return fmtRate(row.rate ?? Number(row.key));
  }
}

const groupTitle = (g: TaxGroupBy, tr: Tr): string =>
  tr(g === 'rate' ? 'نسبة الضريبة' : g === 'quarter' ? 'الربع' : 'الشهر');

/** البحث في الصفوف باسمها المعروض أو مفتاحها — الملخّص يبقى للشركة كلها */
export function filterTaxRows(rows: readonly TaxRowDto[], search: string | undefined, tr: Tr): TaxRowDto[] {
  const q = (search ?? '').trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => taxRowLabel(r, tr).toLowerCase().includes(q) || r.key.toLowerCase().includes(q));
}

const positionLabel = (p: TaxSummaryDto['position'], tr: Tr): string =>
  p === 'PAYABLE' ? tr('مستحقة للسداد') : p === 'REFUNDABLE' ? tr('رصيد مسترد') : tr('لا ضريبة مستحقة');

/** سبب غياب المدخلات والصافي (null ⇒ حاضرة) — خادمٌ بلا inputHidden: scoped يكفي */
export const taxInputHiddenOf = (d: TaxReportDto): 'SCOPE' | 'PERMISSION' | null =>
  d.inputHidden ?? (d.summary && !d.summary.input ? (d.scoped ? 'SCOPE' : 'PERMISSION') : null);

/** تنبيه غياب المدخلات للشاشة والملف */
function hiddenNote(h: 'SCOPE' | 'PERMISSION' | null, tr: Tr): string | null {
  if (h === 'SCOPE') return tr('نطاقك مقيد: تظهر ضريبة مبيعات نطاقك وحدها، أما ضريبة المشتريات وصافي الضريبة فعلى مستوى الشركة ولا تظهر لك');
  if (h === 'PERMISSION') return tr('لا تملك صلاحية المشتريات: تظهر ضريبة المخرجات وحدها، أما ضريبة المدخلات وصافي الضريبة فلا تظهر لك');
  return null;
}

// ═══ التصدير (Excel وPDF من الأوراق نفسها — ReportsPage buildSheets) ═══

/** أسطر «ملخص الإقرار»: البند ووعاؤه وضريبته — المطروح بإشارته السالبة */
function declarationLines(s: TaxSummaryDto, tr: Tr): Array<{ label: string; base: number | null; tax: number | null; strong?: boolean; muted?: boolean }> {
  const out: Array<{ label: string; base: number | null; tax: number | null; strong?: boolean; muted?: boolean }> = [
    { label: `${tr('المبيعات')} (${s.output.sales.count})`, base: s.output.sales.base, tax: s.output.sales.tax },
  ];
  if (s.output.debitNotes.count > 0) out.push({ label: `${tr('الإشعارات المدينة')} (${s.output.debitNotes.count})`, base: s.output.debitNotes.base, tax: s.output.debitNotes.tax });
  out.push(
    { label: `${tr('المرتجعات والإشعارات الدائنة')} (${s.output.returns.count})`, base: negAmount(s.output.returns.base), tax: negAmount(s.output.returns.tax) },
    { label: tr('صافي ضريبة المخرجات'), base: s.output.base, tax: s.output.tax, strong: true },
  );
  if (s.input) {
    out.push(
      { label: `${tr('المشتريات القابلة للاسترداد')} (${s.input.purchases.count})`, base: s.input.purchases.base, tax: s.input.purchases.tax },
      { label: `${tr('مرتجعات المشتريات')} (${s.input.returns.count})`, base: negAmount(s.input.returns.base), tax: negAmount(s.input.returns.tax) },
      { label: tr('صافي ضريبة المدخلات'), base: s.input.base, tax: s.input.tax, strong: true },
    );
  }
  if (s.net != null) out.push({ label: `${tr('صافي الضريبة')} — ${positionLabel(s.position, tr)}`, base: null, tax: s.net, strong: true });
  if (s.nonRecoverable && (s.nonRecoverable.tax !== 0 || s.nonRecoverable.base !== 0)) {
    out.push({ label: `${tr('ضريبة غير قابلة للاسترداد (لا تطرح)')} (${s.nonRecoverable.count})`, base: s.nonRecoverable.base, tax: s.nonRecoverable.tax, muted: true });
  }
  if (s.output.zeroBase !== 0) out.push({ label: tr('مبيعات صفرية ومعفاة وخارج النطاق'), base: s.output.zeroBase, tax: null, muted: true });
  return out;
}

/**
 * أوراق التصدير: «ملخص الإقرار» ثم صفوف التجميع (المعروضة بعد البحث). أعمدةٌ ثمانية على الأكثر لتتّسع لصفحة PDF.
 * من غابت عنه المدخلات (مقيَّد النطاق أو ممنوعٌ من المشتريات) بلا أعمدتها ولا الصافي — كما الشاشة، وسبب الغياب ملاحظة الملف.
 */
export function taxReportSheets(result: TaxReportResult, tr: Tr, search?: string): TaxExport | null {
  const { data } = result;
  if (data.taxDisabled || !data.summary) return null;
  const hidden = taxInputHiddenOf(data);
  const dec = data.decimals;
  const n = (x: number | null) => (x == null ? '' : num(x, dec));
  const rows = filterTaxRows(data.rows, search, tr);
  const head = groupTitle(data.groupBy, tr);
  const summarySheet: ExcelSheet = {
    name: tr('ملخص الإقرار'),
    rows: declarationLines(data.summary, tr).map((l) => ({ [tr('البند')]: l.label, [tr('الوعاء')]: n(l.base), [tr('الضريبة')]: n(l.tax) })),
    colWidths: [44, 18, 18],
  };
  const rowsSheet: ExcelSheet = {
    // الاسم يُنظَّف لـExcel في utils/excel (sheetNameOf): ترجمةٌ فيها «:» (التركية) لا تُسقط التصدير
    name: `${tr('الضريبة حسب')} ${head}`,
    rows: rows.map((r) => ({
      [head]: taxRowLabel(r, tr),
      [tr('وعاء المخرجات')]: n(r.output.base),
      [tr('ضريبة المخرجات')]: n(r.output.tax),
      [tr('منها ضريبة المرتجعات')]: n(negAmount(r.output.returnsTax)),
      ...(r.input ? {
        [tr('وعاء المدخلات')]: n(r.input.base),
        [tr('ضريبة المدخلات')]: n(r.input.tax),
        [tr('غير قابلة للاسترداد')]: n(r.nonRecoverable?.tax ?? 0),
        [tr('صافي الضريبة')]: n(r.net),
      } : {}),
    })),
    colWidths: hidden ? [20, 16, 16, 18] : [20, 16, 16, 18, 16, 16, 18, 16],
  };
  return { sheets: [summarySheet, rowsSheet], fname: tr('تقرير الضرائب'), note: hiddenNote(hidden, tr), applied: result.applied };
}

// ═══ المكوّن ═══

export interface TaxReportProps {
  from?: string;
  to?: string;
  /** البحث النصّي من فلتر الصفحة — يصفّي الجدول والتصدير معاً (الملخّص يبقى للشركة كلها) */
  search?: string;
  /** تجميع الصفحة المشترك — يُطبَّع (normalizeTaxGroupBy) فقيمة تبويبٍ آخر تصير «الشهر» */
  groupBy: string;
  /** يُستدعى كلما تغيّر المعروض: أوراق التصدير والملاحظة والمدى المطبَّق (null بلا بيانات أو عند الخروج) — مرّر setState ثابتاً */
  onExportRows?: (x: TaxExport | null) => void;
  /** false يوقف الطلب (تبويبٌ غير ظاهر) */
  enabled?: boolean;
}

const OUTPUT_COLOR = '#E15A30';
const INPUT_COLOR = '#2E6FB0';

export default function TaxReport({ from = '', to = '', search, groupBy, onExportRows, enabled = true }: TaxReportProps) {
  const tr = useTr();
  const g = normalizeTaxGroupBy(groupBy);
  const { visible, ready } = useTaxTabVisible();

  const q = useQuery({
    queryKey: ['report-tax', from, to, g],
    enabled: enabled && ready && visible,
    queryFn: async (): Promise<TaxReportResult> => {
      const params: Record<string, string> = { groupBy: g };
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await reportApi.tax(params);
      return { data: res.data.data as TaxReportDto, applied: appliedRangeOf(res.data) };
    },
  });

  const result = visible && q.data && !q.data.data.taxDisabled ? q.data : null;

  // التصدير: المرجع يحمل آخر دالّة فلا يعيد تغيّرُ هويّتها تشغيلَ الأثر في كل رسم، والخروج يمسحه
  const exportPayload = useMemo(() => (result ? taxReportSheets(result, tr, search) : null), [result, tr, search]);
  const exportRef = useRef(onExportRows);
  exportRef.current = onExportRows;
  useEffect(() => { exportRef.current?.(exportPayload); }, [exportPayload]);
  useEffect(() => () => exportRef.current?.(null), []);

  const rows = useMemo(() => (result ? filterTaxRows(result.data.rows, search, tr) : []), [result, search, tr]);
  const dec = result?.data.decimals ?? 2;
  const hidden = result ? taxInputHiddenOf(result.data) : null;
  const noInput = hidden !== null; // بلا مدخلات ولا صافٍ (مقيَّد النطاق أو ممنوعٌ من المشتريات)
  const totals = useMemo(() => {
    const f = Math.pow(10, dec);
    const add = (pick: (r: TaxRowDto) => number) => Math.round(rows.reduce((s, r) => s + Math.round(pick(r) * f), 0)) / f;
    return {
      outBase: add((r) => r.output.base), outTax: add((r) => r.output.tax),
      inBase: add((r) => r.input?.base ?? 0), inTax: add((r) => r.input?.tax ?? 0),
      net: add((r) => r.net ?? 0),
    };
  }, [rows, dec]);
  const chartRows = useMemo(() => {
    const list = g === 'rate' ? rows : rows.slice(-24);
    return list.map((r) => ({ name: taxRowLabel(r, tr), output: r.output.tax, input: r.input?.tax ?? 0 }));
  }, [rows, g, tr]);

  const noteCls = 'rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs px-3 py-2';
  const cell = 'px-2 sm:px-3 tabular-nums break-words';

  // «إزالة الضريبة» أو المحاسبة مطفأة: لا ذكر للضريبة إطلاقاً
  if (ready && !visible) return <div className="card text-center text-gray-400 py-12">{tr('لا توجد بيانات')}</div>;
  if (!ready || q.isLoading) return <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>;
  if (q.isError) {
    return (
      <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
        <span>{tr('تعذر تحميل التقرير')}</span>
        <button onClick={() => q.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
      </div>
    );
  }
  if (!result?.data.summary) return <div className="card text-center text-gray-400 py-12">{tr('لا توجد بيانات')}</div>;

  const s = result.data.summary;
  const rangeNote = defaultedRangeNote(result.applied, tr);
  const inputNote = hiddenNote(hidden, tr);
  const netTone = s.position === 'PAYABLE' ? 'text-[#E15A30]' : s.position === 'REFUNDABLE' ? 'text-emerald-700' : 'text-gray-700';
  const nonRecTax = s.nonRecoverable?.tax ?? 0;
  const head = groupTitle(g, tr);
  const lines = declarationLines(s, tr);
  const empty = rows.length === 0;

  return (
    <div className="space-y-4">
      {rangeNote && <div className={noteCls}>{rangeNote}</div>}
      {inputNote && <div className={noteCls}>{inputNote}</div>}

      {/* البطاقات: الإجماليات للشركة (أو للنطاق) كلها — البحث يقطّع الجدول لا الملخّص */}
      <div className={`grid grid-cols-2 ${noInput ? 'md:grid-cols-2' : 'md:grid-cols-4'} gap-4`}>
        <div className="card text-center">
          <p className="text-xs text-gray-500">{tr('ضريبة المخرجات')}</p>
          <p className="text-xl font-bold text-gray-800 tabular-nums">{formatCurrency(s.output.tax)}</p>
          <p className="text-[11px] text-gray-400 tabular-nums mt-0.5">{tr('الوعاء')} {formatCurrency(s.output.base)}</p>
        </div>
        {s.input && (
          <div className="card text-center">
            <p className="text-xs text-gray-500">{tr('ضريبة المدخلات القابلة للاسترداد')}</p>
            <p className="text-xl font-bold text-gray-800 tabular-nums">{formatCurrency(s.input.tax)}</p>
            <p className="text-[11px] text-gray-400 tabular-nums mt-0.5">{tr('الوعاء')} {formatCurrency(s.input.base)}</p>
          </div>
        )}
        {s.net != null && (
          <div className="card text-center">
            <p className="text-xs text-gray-500">{tr('صافي الضريبة')}</p>
            <p className={`text-xl font-bold tabular-nums ${netTone}`}>{formatCurrency(s.net)}</p>
            <p className={`text-[11px] font-semibold mt-0.5 ${netTone}`}>{positionLabel(s.position, tr)}</p>
          </div>
        )}
        <div className="card text-center">
          <p className="text-xs text-gray-500">{tr('مبيعات صفرية ومعفاة وخارج النطاق')}</p>
          <p className="text-xl font-bold text-gray-700 tabular-nums">{formatCurrency(s.output.zeroBase)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">{tr('وعاء بلا ضريبة')}</p>
        </div>
      </div>
      {nonRecTax !== 0 && (
        <div className="rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] text-[#6E6557] text-xs px-3 py-2 tabular-nums">
          {tr('ضريبة مشتريات غير قابلة للاسترداد')}: <b>{formatCurrency(nonRecTax)}</b> — {tr('مرسملة في تكلفة البضاعة ولا تطرح من المستحق')}
        </div>
      )}

      {/* الرسم: ضريبتا المخرجات والمدخلات لكل صفّ — آخر ٢٤ فترة */}
      {!empty && (
        <div className="card">
          <h3 className="font-semibold text-gray-700 mb-4">{tr('الضريبة حسب')} {head}</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartRows} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => new Intl.NumberFormat(activeLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(v)} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} />
              {!noInput && <Legend wrapperStyle={{ fontSize: 12 }} />}
              <Bar dataKey="output" fill={OUTPUT_COLOR} radius={[4, 4, 0, 0]} maxBarSize={28} name={tr('ضريبة المخرجات')} />
              {!noInput && <Bar dataKey="input" fill={INPUT_COLOR} radius={[4, 4, 0, 0]} maxBarSize={28} name={tr('ضريبة المدخلات')} />}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* الجدول: عرضٌ ثابت بنِسَب للأعمدة بلا تمرير أفقي، والأرقام بأعمدة متساوية الخانات */}
      <div className="card p-0 overflow-hidden">
        <div className="table-wrapper border-0 rounded-none">
          <table className="table table-fixed text-xs sm:text-sm">
            <thead>
              <tr>
                <th className={`${cell} ${noInput ? 'w-[34%]' : 'w-[18%]'}`}>{head}</th>
                <th className={`${cell} ${noInput ? 'w-[33%]' : 'w-[16%]'}`}>{tr('وعاء المبيعات')}</th>
                <th className={`${cell} ${noInput ? 'w-[33%]' : 'w-[16%]'}`}>{tr('ضريبة المخرجات')}</th>
                {!noInput && (
                  <>
                    <th className={`${cell} w-[16%]`}>{tr('وعاء المشتريات')}</th>
                    <th className={`${cell} w-[16%]`}>{tr('ضريبة المدخلات')}</th>
                    <th className={`${cell} w-[18%]`}>{tr('صافي الضريبة')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {empty ? (
                <tr><td colSpan={noInput ? 3 : 6} className="text-center py-10 text-gray-400">{search?.trim() ? tr('لا نتائج مطابقة للبحث') : tr('لا توجد بيانات')}</td></tr>
              ) : rows.map((r) => (
                <tr key={r.key}>
                  <td className={`${cell} font-medium text-gray-800`}>{taxRowLabel(r, tr)}</td>
                  <td className={`${cell} text-gray-600`}>{formatCurrency(r.output.base)}</td>
                  <td className={`${cell} font-semibold text-gray-800`}>
                    {formatCurrency(r.output.tax)}
                    {r.output.returnsTax !== 0 && (
                      <span className="block text-[10px] font-normal text-gray-400">{tr('بعد طرح مرتجعات')} {formatCurrency(r.output.returnsTax)}</span>
                    )}
                  </td>
                  {r.input && (
                    <>
                      <td className={`${cell} text-gray-600`}>{formatCurrency(r.input.base)}</td>
                      <td className={`${cell} font-semibold text-gray-800`}>
                        {formatCurrency(r.input.tax)}
                        {(r.nonRecoverable?.tax ?? 0) !== 0 && (
                          <span className="block text-[10px] font-normal text-gray-400">{tr('غير قابلة للاسترداد')} {formatCurrency(r.nonRecoverable!.tax)}</span>
                        )}
                      </td>
                      <td className={`${cell} font-semibold ${(r.net ?? 0) > 0 ? 'text-[#E15A30]' : (r.net ?? 0) < 0 ? 'text-emerald-700' : 'text-gray-500'}`}>
                        {formatCurrency(r.net ?? 0)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
            {!empty && (
              <tfoot>
                <tr className="bg-[#FAF7F0] font-bold">
                  <td className={`${cell} py-3 text-gray-700`}>{tr('الإجمالي')}</td>
                  <td className={`${cell} py-3 text-gray-700`}>{formatCurrency(totals.outBase)}</td>
                  <td className={`${cell} py-3 text-gray-800`}>{formatCurrency(totals.outTax)}</td>
                  {!noInput && (
                    <>
                      <td className={`${cell} py-3 text-gray-700`}>{formatCurrency(totals.inBase)}</td>
                      <td className={`${cell} py-3 text-gray-800`}>{formatCurrency(totals.inTax)}</td>
                      <td className={`${cell} py-3 ${totals.net > 0 ? 'text-[#E15A30]' : totals.net < 0 ? 'text-emerald-700' : 'text-gray-500'}`}>{formatCurrency(totals.net)}</td>
                    </>
                  )}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ملخص الإقرار: من أين جاء الرقم — المطروح بإشارته */}
      <div className="card p-0 overflow-hidden">
        <h3 className="font-semibold text-gray-700 px-4 pt-4 pb-2">{tr('ملخص الإقرار')}</h3>
        <div className="table-wrapper border-0 rounded-none">
          <table className="table table-fixed text-xs sm:text-sm">
            <thead>
              <tr>
                <th className={`${cell} w-[50%]`}>{tr('البند')}</th>
                <th className={`${cell} w-[25%]`}>{tr('الوعاء')}</th>
                <th className={`${cell} w-[25%]`}>{tr('الضريبة')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className={l.strong ? 'bg-[#FAF7F0]/60' : undefined}>
                  <td className={`${cell} ${l.strong ? 'font-bold text-gray-800' : l.muted ? 'text-gray-400' : 'text-gray-700'}`}>{l.label}</td>
                  <td className={`${cell} ${l.muted ? 'text-gray-400' : 'text-gray-600'}`}>{l.base == null ? '—' : formatCurrency(l.base)}</td>
                  <td className={`${cell} ${l.strong ? 'font-bold text-gray-800' : l.muted ? 'text-gray-400' : 'text-gray-700'}`}>{l.tax == null ? '—' : formatCurrency(l.tax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-400 px-4 py-3 leading-relaxed">
          {tr('المرتجعات والإشعارات الدائنة تطرح من ضريبة المخرجات، ومرتجعات الموردين تطرح من ضريبة المدخلات. فواتير الموردين غير المصنفة نقدا أو آجلا والمستندات الملغاة لا تدخل التقرير.')}
        </p>
      </div>
    </div>
  );
}
