import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown,
  FileSpreadsheet, FileText, Info, RefreshCw, Search,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useDir, useLang } from '../../../i18n/lang';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import { LedgerLoadingToast } from '../../../components/ledger/LedgerListView';
import { formatDayOnly } from '../../../utils/format';
import { ledgerConfigApi, ledgerErrorOf, ledgerKeys } from '../../../api/ledgerConfig';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';
import { syncResultText } from '../../../components/ledger/SyncBadges';
import {
  getReportExporters, ledgerReportKeys, ledgerReportsApi, reportFileName,
  type ExportFormat, type ReportExporters, type ReportExportJob, type ReportPeriodPayload, type ReportResponse,
  type ReportWarning,
} from '../../../api/ledgerReports';
import {
  MAX_COMPARISON_COUNT, MAX_SEARCH_LENGTH, REPORT_COMPARISON_KINDS, REPORT_UNITS, SEARCH_DEBOUNCE_MS,
  changePercent, clampToFeatures, defaultReportOptions, formatPercent, generalLedgerHref,
  milliToUnitString, parseReportOptions, reportFeatures, reportQueryParams, reportSearchParams,
  resolvePeriodRange, shiftReportPeriod, todayInTimezone,
  type MilliInput, type ReportComparisonKind, type ReportDateMode, type ReportKey, type ReportOptionsState,
  type ReportQueryParams, type ReportUnit,
} from './reportOptions';

/**
 * القشرة المشتركة لتقارير الدفاتر (M4، DESIGN.md §7.1): شريط الخيارات الموحّد، والجدول الهرميّ
 * القابل للطيّ، وتنبيه RPT‑08، وزرّا التصدير.
 *
 * **ما يعرضه هو ما يعيده الخادم:** لا يُحسب هنا مبلغٌ ولا يُجمع صف. كل تقرير يمرّر `toTable`
 * التي تحوّل `data` إلى عُقد الجدول، والقشرة تتولى:
 * - الحالة في عنوان الصفحة (query) فيكون التقرير قابلاً للمشاركة برابط — عبر `reportOptions.ts` الصرف.
 * - **استدعاءٌ واحد لكل تغيير خيار**، والبحث بمهلة `SEARCH_DEBOUNCE_MS` فلا تُستدعى النقطة عند كل
 *   ضغطة مفتاح على قاعدة 0.1 CPU (§7.1 «الأداء»).
 * - التعمّق: كل مبلغ لصفّ حساب رابطٌ إلى دفتر الأستاذ العام بفترة التقرير نفسها.
 * - التصدير: زرّا PDF وXLSX ينادِيان **نقطة التصدير دائماً** (§7.1 البند 4)، فلا أثر لحالة الطيّ
 *   ولا للصفحة المعروضة على الملف. بناء الملف نفسه في وحدة التصدير المسجَّلة (ADR‑9).
 *
 * الوصول: الصفحة كلها ملفوفة بـ`LedgerRoute perm="canViewLedger"` من جدول `routes.ts`، فلا حارس
 * ثانٍ هنا؛ وما لا يدعمه التقرير من خيارات يُخفى (`reportFeatures`) بدل أن يُعرض ثم يُهمَل.
 */

// ═══ نموذج الجدول (عقد الصفحات) ═══

export type ReportEmphasis = 'normal' | 'section' | 'total';

export type ReportCell =
  /** مبلغ ملّي من الردّ — يُقسَم على وحدة العرض ويُقرَّب بمنازل العملة هنا لا في الصفحة */
  | { kind: 'amount'; milli: MilliInput; strong?: boolean; blankZero?: boolean; accountId?: string | null }
  /** نسبة التغيّر: إمّا قيمة جاهزة من الخادم (`percent`)، وإمّا مبلغان تُحسب منهما */
  | { kind: 'percent'; value?: number | null; currentMilli?: MilliInput; baseMilli?: MilliInput }
  | { kind: 'text'; text: string; href?: string; className?: string }
  | { kind: 'empty' };

export interface ReportTableColumn {
  key: string;
  label: string;
  /** سطر ثانٍ تحت العنوان (مدى عمود المقارنة مثلاً) */
  sub?: string;
  align?: 'start' | 'end' | 'center';
  className?: string;
}

export interface ReportNode {
  id: string;
  label: string;
  /** رمز الحساب أو المجموعة (يُعرض قبل الاسم) */
  code?: string | null;
  /** حسابٌ للتعمّق: مبالغ الصف تصير روابط إلى دفتر الأستاذ */
  accountId?: string | null;
  emphasis?: ReportEmphasis;
  /**
   * RPT‑12: معادلة السطر خلف أيقونة (i) — عنوانٌ للفأرة ونصٌّ يُفتح بالنقر تحت التسمية.
   * تُترك فارغة في التقارير التي لا معادلة لأسطرها (الميزان ودفتر الأستاذ).
   */
  hint?: string | null;
  /** تسمية الصف رابطاً (سطر «أرباح السنة الجارية» ⇒ قائمة الدخل للفترة نفسها، §7.4) */
  labelHref?: string | null;
  cells: readonly ReportCell[];
  children?: readonly ReportNode[];
  /** يُفتح بنقرة المستخدم (الأقسام الكبيرة في الميزانية مثلاً) */
  defaultCollapsed?: boolean;
  /** خرق توازن (§7.2 صف الإجمالي) — يُعرض أحمر */
  danger?: boolean;
}

export interface ReportTable {
  columns: readonly ReportTableColumn[];
  nodes: readonly ReportNode[];
  /** صفوف الإجمالي: لا تُطوى ولا تُزاح */
  footer?: readonly ReportNode[];
  emptyText?: string;
}

export interface ReportRenderContext {
  tr: (ar: string) => string;
  lang: string;
  state: ReportOptionsState;
  unit: ReportUnit;
  /** منازل العملة من `settings.currencyDecimals` */
  decimals: number;
  period: ReportPeriodPayload;
  /** رابط تعمّق الحساب بفترة التقرير نفسها */
  drilldown: (accountId: string) => string;
  /** «01/01/2026 — 31/01/2026» */
  periodLabel: (p: { from: string; to: string }) => string;
}

export interface ReportViewProps<TRow = Record<string, unknown>, TTotals = Record<string, unknown>> {
  reportKey: ReportKey;
  title: string;
  subtitle?: string;
  /** ردّ الخادم ⇒ عُقد الجدول */
  toTable: (data: ReportResponse<TRow, TTotals>, ctx: ReportRenderContext) => ReportTable;
  /** بطاقات فوق الجدول (الملخّص التنفيذي، شريط التوازن…) */
  summary?: (data: ReportResponse<TRow, TTotals>, ctx: ReportRenderContext) => ReactNode;
  /** تحت الجدول (ترقيم دفتر الأستاذ، «تحميل المزيد»…) */
  below?: (data: ReportResponse<TRow, TTotals>, ctx: ReportRenderContext) => ReactNode;
  /**
   * يستبدل مدى الفترة في الترويسة. §7.4: الميزانية **اعتباراً من تاريخ واحد**، ومدى ردّها
   * `[بداية السنة المالية، التاريخ]` مدى تعمّقٍ لا فترةَ تقرير — فعرضه مدىً يضلّل القارئ.
   */
  periodText?: (period: ReportPeriodPayload) => string;
  /** معاملات يضيفها التقرير إلى النقطة والتصدير معاً (`showZero`، `partners`…) */
  extraParams?: ReportQueryParams;
  /** عناصر إضافية في شريط الخيارات */
  extraControls?: ReactNode;
  /** يتقدّم على المسجَّل في `registerReportExporters` (للاختبار أو لتقرير له ملفٌ خاص) */
  exporters?: Partial<ReportExporters>;
}

// ═══ أدوات العرض ═══

/**
 * كل مفتاح يكتبه `reportSearchParams` أو يقرؤه `parseReportOptions` — وما عداه في الرابط ملكُ
 * التقرير نفسه (‏`extraParams`) فلا يمسحه الشريط. الأسماء نسخة من عقد `reportOptions.ts`.
 */
const REPORT_BAR_PARAMS = [
  'mode', 'from', 'to', 'asOf', 'comparison', 'comparisonCount', 'postedOnly', 'includeDrafts',
  'unit', 'hierarchy', 'hideZero', 'search', 'account', 'accounts',
] as const;

const CTL = 'h-8 rounded-lg border border-[#E8E0D2] bg-white px-2 text-xs text-[#1F1A13] focus:outline-none focus:ring-2 focus:ring-[#E15A30]/25';
const CHIP = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[#E8E0D2] bg-white text-xs text-[#1F1A13] hover:bg-[#FBF7F0] disabled:opacity-40 disabled:cursor-not-allowed';

const dateModeLabels = (tr: (ar: string) => string): Record<ReportDateMode, string> => ({
  month: tr('شهر'),
  quarter: tr('ربع'),
  fiscalYear: tr('سنة مالية'),
  custom: tr('مدة مخصصة'),
  asOf: tr('حتى تاريخ'),
});

const comparisonLabels = (tr: (ar: string) => string): Record<ReportComparisonKind, string> => ({
  previousPeriod: tr('مقارنة بالفترة السابقة'),
  sameLastYear: tr('مقارنة بالمدة نفسها من السنة الماضية'),
});

const unitLabels = (tr: (ar: string) => string): Record<ReportUnit, string> => ({
  1: tr('بالعملة'),
  1000: tr('بالآلاف'),
  1_000_000: tr('بالملايين'),
});

/** لون التنبيه: المسودات والأحداث المعلّقة تحذير، وما عداها خبرٌ للمستخدم لا عطل. */
function warningTone(code: string): 'amber' | 'blue' {
  return code === 'UNPOSTED_ENTRIES' || code === 'STOCK_EVENTS_PENDING' ? 'amber' : 'blue';
}

/** كل عُقد الشجرة التي لها أبناء — لزرّي «طيّ الكل» و«فتح الكل». صرفة. */
function parentIds(nodes: readonly ReportNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children && n.children.length > 0) {
      out.push(n.id);
      parentIds(n.children, out);
    }
  }
  return out;
}

// ═══ المكوّن ═══

export function ReportView<TRow = Record<string, unknown>, TTotals = Record<string, unknown>>(
  props: ReportViewProps<TRow, TTotals>,
) {
  const { reportKey, title, subtitle, toTable, summary, below, periodText, extraParams, extraControls, exporters } = props;
  const tr = useTr();
  const dir = useDir();
  const lang = useLang(s => s.lang);
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const features = useMemo(() => reportFeatures(reportKey), [reportKey]);

  // حالة الشريط من عنوان الصفحة — مصدرٌ واحد، فالرابط وحده يصف ما على الشاشة
  const spString = sp.toString();
  const state = useMemo(
    () => parseReportOptions(spString, { reportKey, today: todayInTimezone() }),
    [spString, reportKey],
  );

  /**
   * تغيير خيار من الشريط: تُكتب مفاتيح الشريط وحدها ويبقى ما عداها في الرابط كما هو، فمعامل
   * يخصّ تقريراً بعينه (‏`showZero` في قائمة الدخل، RPT‑14) لا يُمحى بأول نقرة على «الفترة».
   */
  const patch = useCallback((next: Partial<ReportOptionsState> | ReportOptionsState) => {
    const merged = clampToFeatures({ ...state, ...next }, reportKey);
    const out = new URLSearchParams(spString);
    for (const k of REPORT_BAR_PARAMS) out.delete(k);
    const own = reportSearchParams(merged);
    for (const k of Object.keys(own)) out.set(k, own[k]);
    setSp(out, { replace: true });
  }, [state, reportKey, setSp, spString]);

  // البحث محلّي حتى تهدأ الكتابة، فلا طلب عند كل ضغطة مفتاح (§7.1 الأداء)
  const [searchDraft, setSearchDraft] = useState(state.search);
  useEffect(() => { setSearchDraft(state.search); }, [state.search]);
  useEffect(() => {
    if (searchDraft === state.search) return;
    const t = setTimeout(() => patch({ search: searchDraft }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchDraft, state.search, patch]);

  const params = useMemo(() => reportQueryParams(state, extraParams ?? {}), [state, extraParams]);
  const q = useQuery({
    queryKey: ledgerReportKeys.report(reportKey, params),
    queryFn: async () => (await ledgerReportsApi.get<TRow, TTotals>(reportKey, params)).data.data,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const data = q.data;

  const sync = useMutation({
    mutationFn: async () => (await ledgerConfigApi.sync()).data,
    onSuccess: (r) => {
      if (r.running) toast(`${tr('المزامنة جارية الآن، أعد التحميل بعد قليل')} (${r.pendingEvents})`);
      else toast.success(`${tr('تمت المزامنة')} — ${tr('أحداث متبقية')}: ${r.pendingEvents}`);
      qc.invalidateQueries({ queryKey: ledgerReportKeys.all });
      qc.invalidateQueries({ queryKey: ledgerKeys.status });
    },
    onError: (err) => toast.error(syncResultText(tr, err)),
  });

  /**
   * §7.1 البند 4: الزرّان ينادِيان **نقطة التصدير دائماً**، فلا أثر لحالة الطيّ ولا للصفحة
   * المعروضة على الملف. المسار الافتراضي وحدة التصدير (`exportReport.ts`) التي تجلب ثم تبني
   * الملف في المتصفح (ADR‑9)؛ و`exporters` (أو المسجَّل بـ`registerReportExporters`) يتقدّم عليها
   * حين يريد تقريرٌ ملفاً خاصاً به.
   */
  const runExport = useMutation({
    mutationFn: async (format: ExportFormat) => {
      const handler = (exporters ?? getReportExporters())[format];
      if (handler) {
        const res = await ledgerReportsApi.export<TRow, TTotals>(reportKey, { ...params, format });
        const payload = res.data.data;
        await handler({
          reportKey,
          format,
          title,
          fileName: reportFileName(reportKey, payload.period),
          data: payload as unknown as ReportExportJob['data'],
        });
        return;
      }
      const { runReportExport } = await import('./exportReport');
      await runReportExport({ reportKey, params, format, tr, locale: lang === 'ar' ? 'ar-SA' : undefined });
    },
    onError: (err) => {
      // وحدة التصدير ترمي رسالةً عربية جاهزة (422 و429 لهما نصّاهما) — تُعرض كما هي
      if (err instanceof Error && err.name === 'ReportExportError' && err.message) {
        toast.error(err.message);
        return;
      }
      const e = ledgerErrorOf(err);
      if (e?.code === 'LEDGER_EXPORT_TOO_LARGE') {
        toast.error(tr('التقرير أكبر من سقف التصدير: ضيّق الفترة أو الحسابات، أو صدّر XLSX'));
        return;
      }
      toast.error(ledgerErrorMessage(tr, e));
    },
  });

  const decimals = data?.settings.currencyDecimals ?? 2;
  const unit = state.unit;
  // قبل وصول الردّ تُعرض الفترة المحسوبة محلياً (مرآة `resolveReportPeriod`)، وبعده فترة الردّ هي المرجع
  const localRange = resolvePeriodRange(state);
  const serverPeriod = data?.period;
  const period: ReportPeriodPayload = useMemo(
    () => serverPeriod ?? { from: localRange.from, to: localRange.to, fyStart: localRange.from },
    [serverPeriod, localRange.from, localRange.to],
  );

  const periodLabel = useCallback(
    (p: { from: string; to: string }) => (p.from === p.to ? formatDayOnly(p.to) : `${formatDayOnly(p.from)} — ${formatDayOnly(p.to)}`),
    [],
  );
  const drilldown = useCallback(
    (accountId: string) => generalLedgerHref(accountId, { from: period.from, to: period.to }, { postedOnly: state.postedOnly }),
    [period.from, period.to, state.postedOnly],
  );

  const ctx: ReportRenderContext = useMemo(
    () => ({ tr, lang, state, unit, decimals, period, drilldown, periodLabel }),
    [tr, lang, state, unit, decimals, period, drilldown, periodLabel],
  );

  const table: ReportTable | null = useMemo(() => (data ? toTable(data, ctx) : null), [data, toTable, ctx]);

  // الطيّ: ما طواه المستخدم صراحةً، وما فُتح من المطويّ افتراضاً
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const isCollapsed = (n: ReportNode) => (collapsed.has(n.id) ? true : n.defaultCollapsed === true && !opened.has(n.id));
  const toggle = (n: ReportNode) => {
    const next = isCollapsed(n) ? false : true;
    setCollapsed(prev => { const s = new Set(prev); if (next) s.add(n.id); else s.delete(n.id); return s; });
    setOpened(prev => { const s = new Set(prev); if (next) s.delete(n.id); else s.add(n.id); return s; });
  };
  const collapseAll = () => { setCollapsed(new Set(parentIds(table?.nodes ?? []))); setOpened(new Set()); };
  const expandAll = () => { setCollapsed(new Set()); setOpened(new Set(parentIds(table?.nodes ?? []))); };

  // RPT‑12: معادلةٌ واحدة مفتوحة في كل مرة — النصّ يظهر أيضاً في `title` لمن يستعمل الفأرة
  const [openHint, setOpenHint] = useState<string | null>(null);

  const warnings: ReportWarning[] = data?.warnings ?? [];
  const colCount = (table?.columns.length ?? 0) + 1;
  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const hasTree = (table?.nodes ?? []).some(n => n.children && n.children.length > 0);

  // ─── الصفوف ───

  const renderCell = (c: ReportCell, node: ReportNode, key: string) => {
    if (c.kind === 'empty') return <td key={key} className="px-2 py-1" />;
    if (c.kind === 'text') {
      return (
        <td key={key} className={`px-2 py-1 ${c.className ?? ''}`}>
          {c.href ? <Link to={c.href} className="text-[#E15A30] hover:underline">{c.text}</Link> : c.text}
        </td>
      );
    }
    if (c.kind === 'percent') {
      const value = c.value !== undefined ? c.value : changePercent(c.currentMilli, c.baseMilli);
      const tone = value === null ? 'text-gray-400' : value < 0 ? 'text-[#C0392B]' : value > 0 ? 'text-[#2E7D32]' : 'text-[#6E6557]';
      return (
        <td key={key} className="px-2 py-1 text-end">
          <bdi dir="ltr" className={`tabular-nums whitespace-nowrap ${tone}`}>{formatPercent(value)}</bdi>
        </td>
      );
    }
    const amount = (
      <LedgerAmount
        value={milliToUnitString(c.milli, unit)}
        decimals={decimals}
        blankZero={c.blankZero === true}
        className={c.strong || node.emphasis === 'total' ? 'font-semibold' : ''}
      />
    );
    const accountId = c.accountId ?? node.accountId ?? null;
    return (
      <td key={key} className="px-2 py-1 text-end">
        {accountId && reportKey !== 'general-ledger'
          ? <Link to={drilldown(accountId)} title={tr('التعمّق في دفتر الأستاذ العام')} className="hover:underline decoration-[#E15A30] underline-offset-4">{amount}</Link>
          : amount}
      </td>
    );
  };

  const renderNode = (node: ReportNode, depth: number): ReactNode[] => {
    const kids = node.children ?? [];
    const open = kids.length > 0 && !isCollapsed(node);
    const emph = node.emphasis ?? 'normal';
    const rowClass = node.danger
      ? 'bg-[#FBEBE2] text-[#C0392B] font-semibold'
      : emph === 'total'
        ? 'bg-[#F1EBDF] font-semibold'
        : emph === 'section'
          ? 'bg-[#FBF7F0] font-semibold'
          : '';
    const hintOpen = openHint === node.id;
    const rows: ReactNode[] = [
      <tr key={node.id} className={`border-b border-[#F1EBDF] ${rowClass}`}>
        <th scope="row" className="px-2 py-1 text-start font-normal">
          <span className="inline-flex flex-wrap items-center gap-1.5" style={{ paddingInlineStart: depth * 16 }}>
            {kids.length > 0 ? (
              <button type="button" onClick={() => toggle(node)} aria-expanded={open} className="text-[#9A8F7E] hover:text-[#1F1A13]">
                {open ? <ChevronDown size={14} /> : dir === 'rtl' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : <span className="w-[14px]" />}
            {node.code ? <bdi className="font-mono text-[11px] text-[#9A8F7E]">{node.code}</bdi> : null}
            <span className={emph === 'normal' ? '' : 'font-semibold'}>
              {node.labelHref
                ? <Link to={node.labelHref} className="text-[#E15A30] hover:underline">{node.label}</Link>
                : node.label}
            </span>
            {/* RPT‑12: معادلة السطر خلف أيقونة (i) — عنوانٌ للفأرة ونصٌّ يُفتح بالنقر تحت التسمية */}
            {node.hint ? (
              <button
                type="button"
                className="text-[#9A8F7E] hover:text-[#E15A30]"
                title={node.hint}
                aria-label={tr('معادلة السطر')}
                aria-expanded={hintOpen}
                onClick={() => setOpenHint(prev => (prev === node.id ? null : node.id))}
              >
                <Info size={13} />
              </button>
            ) : null}
          </span>
          {node.hint && hintOpen ? (
            <span
              className="mt-0.5 block max-w-[15rem] sm:max-w-[28rem] whitespace-normal break-words text-[11px] font-normal leading-relaxed text-[#6E6557]"
              style={{ paddingInlineStart: depth * 16 + 20 }}
            >
              {node.hint}
            </span>
          ) : null}
        </th>
        {node.cells.map((c, i) => renderCell(c, node, `${node.id}:${i}`))}
      </tr>,
    ];
    if (open) for (const k of kids) rows.push(...renderNode(k, depth + 1));
    return rows;
  };

  // ─── شريط الخيارات ───

  const dateInputs = (
    <div className="flex items-center gap-1.5">
      <button type="button" className={CHIP} onClick={() => patch(shiftReportPeriod(state, -1))} title={tr('الفترة السابقة')} aria-label={tr('الفترة السابقة')}>
        <Prev size={14} />
      </button>
      {state.mode === 'custom' ? (
        <>
          <input type="date" className={CTL} value={state.from} onChange={e => patch({ from: e.target.value || state.from })} aria-label={tr('من تاريخ')} />
          <input type="date" className={CTL} value={state.to} onChange={e => patch({ to: e.target.value || state.to })} aria-label={tr('إلى تاريخ')} />
        </>
      ) : state.mode === 'asOf' ? (
        <input type="date" className={CTL} value={state.to} onChange={e => patch({ to: e.target.value || state.to, from: e.target.value || state.from })} aria-label={tr('حتى تاريخ')} />
      ) : (
        <input type="date" className={CTL} value={state.from} onChange={e => patch({ from: e.target.value || state.from })} aria-label={tr('تاريخ داخل الفترة')} />
      )}
      <button type="button" className={CHIP} onClick={() => patch(shiftReportPeriod(state, 1))} title={tr('الفترة التالية')} aria-label={tr('الفترة التالية')}>
        <Next size={14} />
      </button>
    </div>
  );

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-[#1F1A13]">{title}</h1>
          <p className="text-xs text-[#6E6557]">
            {subtitle ? `${subtitle} · ` : ''}{periodText ? periodText(period) : periodLabel(period)}
            {data?.mode === 'LINE_SCAN' ? ` · ${tr('مفلتر، أبطأ')}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className={CHIP} disabled={!data || runExport.isPending} onClick={() => runExport.mutate('xlsx')}>
            <FileSpreadsheet size={14} /> {tr('تصدير XLSX')}
          </button>
          <button type="button" className={CHIP} disabled={!data || runExport.isPending} onClick={() => runExport.mutate('pdf')}>
            <FileText size={14} /> {tr('تصدير PDF')}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#E8E0D2] bg-[#FBF7F0] p-2">
        {features.dateModes.length > 1 && (
          <select className={CTL} value={state.mode} onChange={e => patch({ mode: e.target.value as ReportDateMode })} aria-label={tr('الفترة')}>
            {features.dateModes.map(m => <option key={m} value={m}>{dateModeLabels(tr)[m]}</option>)}
          </select>
        )}
        {dateInputs}

        {features.comparison && (
          <>
            <select
              className={CTL}
              value={state.comparison ?? ''}
              onChange={e => patch({ comparison: (e.target.value || null) as ReportComparisonKind | null })}
              aria-label={tr('المقارنة')}
            >
              <option value="">{tr('بلا مقارنة')}</option>
              {REPORT_COMPARISON_KINDS.map(k => <option key={k} value={k}>{comparisonLabels(tr)[k]}</option>)}
            </select>
            {state.comparison && (
              <input
                type="number" min={1} max={MAX_COMPARISON_COUNT} className={`${CTL} w-16`}
                value={state.comparisonCount}
                onChange={e => patch({ comparisonCount: Math.min(MAX_COMPARISON_COUNT, Math.max(1, Number(e.target.value) || 1)) })}
                aria-label={tr('عدد فترات المقارنة')}
              />
            )}
          </>
        )}

        {features.unit && (
          <select className={CTL} value={state.unit} onChange={e => patch({ unit: Number(e.target.value) as ReportUnit })} aria-label={tr('وحدة العرض')}>
            {REPORT_UNITS.map(u => <option key={u} value={u}>{unitLabels(tr)[u]}</option>)}
          </select>
        )}

        {features.postedOnly && (
          <label className="inline-flex items-center gap-1.5 text-xs text-[#1F1A13]">
            <input type="checkbox" checked={state.postedOnly} onChange={e => patch({ postedOnly: e.target.checked })} />
            {tr('المرحّلة فقط')}
          </label>
        )}
        {features.hierarchy && (
          <label className="inline-flex items-center gap-1.5 text-xs text-[#1F1A13]">
            <input type="checkbox" checked={state.hierarchy} onChange={e => patch({ hierarchy: e.target.checked })} />
            {tr('هرمي ببادئة الرمز')}
          </label>
        )}
        {features.hideZero && (
          <label className="inline-flex items-center gap-1.5 text-xs text-[#1F1A13]">
            <input type="checkbox" checked={state.hideZero} onChange={e => patch({ hideZero: e.target.checked })} />
            {tr('إخفاء الأصفار')}
          </label>
        )}

        {features.search && (
          <span className="relative inline-flex items-center">
            <Search size={13} className="absolute text-[#9A8F7E] pointer-events-none" style={{ insetInlineStart: 8 }} />
            <input
              type="search" className={`${CTL} w-48`} style={{ paddingInlineStart: 24 }}
              maxLength={MAX_SEARCH_LENGTH}
              value={searchDraft}
              onChange={e => setSearchDraft(e.target.value)}
              placeholder={tr('بحث داخل التقرير')}
              aria-label={tr('بحث داخل التقرير')}
            />
          </span>
        )}

        {hasTree && (
          <span className="flex items-center gap-1.5">
            <button type="button" className={CHIP} onClick={collapseAll} title={tr('طيّ الكل')} aria-label={tr('طيّ الكل')}><ChevronsDownUp size={14} /></button>
            <button type="button" className={CHIP} onClick={expandAll} title={tr('فتح الكل')} aria-label={tr('فتح الكل')}><ChevronsUpDown size={14} /></button>
          </span>
        )}
        {extraControls}
      </div>

      {warnings.map((w, i) => {
        const tone = warningTone(w.code);
        return (
          <div
            key={`${w.code}:${i}`}
            className={`flex flex-wrap items-center gap-2 rounded-xl border p-2 text-xs ${tone === 'amber' ? 'border-[#F0D7A8] bg-[#FDF6E7] text-[#7A5B12]' : 'border-[#CFE0F0] bg-[#F2F7FC] text-[#2B4A63]'}`}
            role="status"
          >
            {tone === 'amber' ? <AlertTriangle size={14} /> : <Info size={14} />}
            <span>{w.message}</span>
            {w.code === 'UNPOSTED_ENTRIES' && (
              <>
                <Link to="/app/ledger/review/events" className="text-[#E15A30] hover:underline">{tr('أحداث الترحيل الآلي')}</Link>
                <button type="button" className={CHIP} disabled={sync.isPending} onClick={() => sync.mutate()}>
                  <RefreshCw size={13} className={sync.isPending ? 'animate-spin' : ''} /> {tr('مزامنة الآن')}
                </button>
              </>
            )}
          </div>
        );
      })}

      {q.isError && (
        <div className="rounded-xl border border-[#E8C3B7] bg-[#FBEBE2] p-3 text-xs text-[#C0392B]">
          {ledgerErrorMessage(tr, ledgerErrorOf(q.error))}
        </div>
      )}

      {data && summary ? summary(data, ctx) : null}

      <div className="overflow-x-auto rounded-xl border border-[#E8E0D2] bg-white">
        <table className="w-full text-xs">
          <thead className="bg-[#F1EBDF] text-[#6E6557]">
            <tr>
              <th scope="col" className="px-2 py-2 text-start font-semibold">{tr('البيان')}</th>
              {(table?.columns ?? []).map(c => (
                <th key={c.key} scope="col" className={`px-2 py-2 font-semibold whitespace-nowrap ${c.align === 'start' ? 'text-start' : c.align === 'center' ? 'text-center' : 'text-end'} ${c.className ?? ''}`}>
                  <span className="block">{c.label}</span>
                  {c.sub ? <span className="block text-[10px] font-normal text-[#9A8F7E]">{c.sub}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!table || table.nodes.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, colCount)} className="px-3 py-8 text-center text-[#9A8F7E]">
                  {q.isLoading ? tr('جاري التحميل...') : table?.emptyText ?? tr('لا صفوف في هذه الفترة')}
                </td>
              </tr>
            ) : table.nodes.flatMap(n => renderNode(n, 0))}
          </tbody>
          {table && table.footer && table.footer.length > 0 && (
            <tfoot className="border-t-2 border-[#E8E0D2]">
              {table.footer.flatMap(n => renderNode(n, 0))}
            </tfoot>
          )}
        </table>
      </div>

      {data && below ? below(data, ctx) : null}
      <LedgerLoadingToast show={q.isFetching && !q.isLoading} />
    </div>
  );
}

export default ReportView;

/** الحالة الافتراضية لتقرير — تستعملها الصفحات لبناء روابط جاهزة (بطاقات اللوحة مثلاً). */
export { defaultReportOptions };
