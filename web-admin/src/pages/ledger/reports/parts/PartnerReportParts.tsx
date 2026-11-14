import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, BookOpen, FileSpreadsheet, FileText, Info, Search, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../../i18n/strings';
import { useLang } from '../../../../i18n/lang';
import { activeLocale, formatDayOnly } from '../../../../utils/format';
import { LedgerAmount } from '../../../../components/ledger/LedgerAmount';
import { LedgerLoadingToast } from '../../../../components/ledger/LedgerListView';
import { ledgerErrorOf } from '../../../../api/ledgerConfig';
import { ledgerErrorMessage } from '../../../../lib/ledger/errors';
import { sourceDocumentHref, sourceTypeLabels } from '../../../../lib/ledger/sync';
import AttachmentLinks from './AttachmentLinks';
import {
  AGING_BUCKET_KEYS, agingBasisLabels, agingColumnLabels, agingParams, agingRowBalanced, agingSearch, cleanPartnerParams,
  ledgerMoveHref, ledgerPartnersApi, ledgerPartnersKeys, parseAgingBucketsInput, partnerLedgerHref, partnerReportCodeLabels,
  partnerHintText, partnerReportReasonLabels, partnerReportTitles, partnerWarningText, partnerWarningTone, readAgingState, roundQuantity,
  type AgingBasis, type AgingColumns, type AgingState, type PartnerReportKey, type PartnerReportWarning, type PartnerSearchType,
} from '../../../../api/ledgerPartners';

/**
 * أجزاء تقارير الشركاء المشتركة («ربط الدفاتر» L8، عقد §6.4 A12): قشرة التقرير (العنوان وزرّا التصدير والتنبيهات والخطأ)،
 * ومنتقي الشريك والصنف بالبحث في الخادم، وعرض أعمار الذمم المدينة والدائنة.
 *
 * **ما يُعرض هو ما يعيده الخادم:** لا يُحسب هنا مبلغ ولا يُجمع صف — الأعمار والأرصدة والمتبقّي من `services/gl/reports`.
 * والتصدير **لا يصدّر ما على الشاشة أبداً**: نقطة التصدير بالمعاملات نفسها عبر `reports/exportReport.ts` القائم (XLSX وPDF).
 * الحالة في عنوان الصفحة فيبقى التقرير رابطاً قابلاً للمشاركة، والطلب واحد لكل تغيير (البحث بمهلة، قاعدة 0.1 نواة).
 */

export const CTL = 'h-8 rounded-lg border border-[#E8E0D2] bg-white px-2 text-xs text-[#1F1A13] focus:outline-none focus:ring-2 focus:ring-[#E15A30]/25';
export const CHIP = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[#E8E0D2] bg-white text-xs text-[#1F1A13] hover:bg-[#FBF7F0] disabled:opacity-40 disabled:cursor-not-allowed';
export const TH = 'px-2 py-2 font-semibold whitespace-nowrap';
export const TD = 'px-2 py-1 align-top';

const SEARCH_DEBOUNCE_MS = 350;

/** نص خطأ نقاط تقارير الشركاء: تسمية السبب ثم الرمز ثم العامة — لا رسالة الخادم العربية خاماً. */
export function partnerErrorText(tr: (ar: string) => string, err: unknown): string {
  const e = ledgerErrorOf(err);
  const reason = typeof e?.reason === 'string' ? e.reason : typeof e?.details?.reason === 'string' ? (e.details.reason as string) : null;
  const byReason = reason ? partnerReportReasonLabels(tr)[reason] : undefined;
  const byCode = e?.code ? partnerReportCodeLabels(tr)[e.code] : undefined;
  return byReason || byCode || ledgerErrorMessage(tr, e);
}

/** مبلغ بوحدة العملة من الردّ بعزل الاتجاه (`LedgerAmount`) */
export function Amount({ value, decimals, strong, blankZero }: { value: number | null | undefined; decimals: number; strong?: boolean; blankZero?: boolean }) {
  return <LedgerAmount value={value ?? 0} decimals={decimals} blankZero={blankZero === true} className={strong ? 'font-semibold' : ''} />;
}

/** كمية بمنازلها (حتى أربع) بأرقام لغة العرض */
export function qtyText(q: number | null | undefined): string {
  const v = roundQuantity(q);
  if (v === null) return '';
  try { return new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 4 }).format(v); } catch { return String(v); }
}

/** تاريخ يوم خالص أو شرطة */
export const dayText = (d: string | null | undefined): string => (d ? formatDayOnly(d) : '—');

/** رابط القيد برقمه */
export function MoveLink({ moveId, number }: { moveId: string | null | undefined; number: string | null | undefined }) {
  const tr = useTr();
  if (!moveId) return <bdi className="tabular-nums">{number ?? '—'}</bdi>;
  return (
    <Link to={ledgerMoveHref(moveId)} title={tr('فتح القيد')} className="font-semibold text-[#E15A30] hover:underline">
      <bdi className="tabular-nums">{number ?? tr('قيد')}</bdi>
    </Link>
  );
}

/** المستند المصدر: نوعه رابطاً إلى شاشته التشغيلية (العميل بملفه حين يُعرف) */
export function SourceLink({ sourceType, customerId }: { sourceType: string | null | undefined; customerId?: string | null }) {
  const tr = useTr();
  if (!sourceType) return <span className="text-[#9A8F7E]">{tr('قيد يدوي')}</span>;
  const label = sourceTypeLabels(tr)[sourceType] ?? sourceType;
  const href = sourceDocumentHref(sourceType, { customerId: customerId ?? null });
  return href
    ? <Link to={href} title={tr('فتح المستند المصدر')} className="text-[#E15A30] hover:underline whitespace-nowrap">{label}</Link>
    : <span className="whitespace-nowrap">{label}</span>;
}

// ═══ القشرة ═══

export function PartnerReportFrame({ reportKey, subtitle, controls, exportParams, warnings, error, loading, fetching, children }: {
  reportKey: PartnerReportKey;
  subtitle?: ReactNode;
  controls: ReactNode;
  /** معاملات النقطة نفسها للتصدير — `null` ⇒ الزرّان معطّلان (لا شريك مختار بعد) */
  exportParams: object | null;
  warnings?: readonly PartnerReportWarning[];
  error?: unknown;
  loading?: boolean;
  fetching?: boolean;
  children: ReactNode;
}) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const title = partnerReportTitles(tr)[reportKey];

  /**
   * نقطة التصدير دائماً (`POST /reports/<key>/export`): مجموعة البيانات كاملة بلا ترقيم، ثم يبني المتصفح الملف (ADR‑9).
   * 422 `LEDGER_EXPORT_TOO_LARGE` و429 لهما نصّاهما الجاهزان من وحدة التصدير.
   */
  const runExport = useMutation({
    mutationFn: async (format: 'xlsx' | 'pdf') => {
      const { runReportExport } = await import('../exportReport');
      await runReportExport({ reportKey, params: cleanPartnerParams(exportParams), format, tr, locale: lang === 'ar' ? 'ar-SA' : undefined });
    },
    onError: (err) => {
      if (err instanceof Error && err.name === 'ReportExportError' && err.message) { toast.error(err.message); return; }
      toast.error(partnerErrorText(tr, err));
    },
  });

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-[#1F1A13]">{title}</h1>
          {subtitle ? <p className="text-xs text-[#6E6557]">{subtitle}</p> : null}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className={CHIP} disabled={!exportParams || runExport.isPending} onClick={() => runExport.mutate('xlsx')}>
            <FileSpreadsheet size={14} /> {tr('تصدير XLSX')}
          </button>
          <button type="button" className={CHIP} disabled={!exportParams || runExport.isPending} onClick={() => runExport.mutate('pdf')}>
            <FileText size={14} /> {tr('تصدير PDF')}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#E8E0D2] bg-[#FBF7F0] p-2">{controls}</div>

      {(warnings ?? []).map((w, i) => {
        const tone = partnerWarningTone(w.code);
        return (
          <div
            key={`${w.code}:${i}`}
            role="status"
            className={`flex flex-wrap items-center gap-2 rounded-xl border p-2 text-xs ${tone === 'amber' ? 'border-[#F0D7A8] bg-[#FDF6E7] text-[#7A5B12]' : 'border-[#CFE0F0] bg-[#F2F7FC] text-[#2B4A63]'}`}
          >
            {tone === 'amber' ? <AlertTriangle size={14} /> : <Info size={14} />}
            <span>{partnerWarningText(w, tr)}</span>
            {w.code === 'UNPOSTED_ENTRIES' && <Link to="/app/ledger/review/events" className="text-[#E15A30] hover:underline">{tr('أحداث الترحيل الآلي')}</Link>}
          </div>
        );
      })}

      {error ? (
        <div className="rounded-xl border border-[#E8C3B7] bg-[#FBEBE2] p-3 text-xs text-[#C0392B]">{partnerErrorText(tr, error)}</div>
      ) : null}

      {children}
      <LedgerLoadingToast show={!!fetching && !loading} />
    </div>
  );
}

/** حقل تاريخ يوم خالص: الفارغ يُعيد الافتراضي (الخادم يحدّده ويعيده في الردّ) */
export function DateField({ value, onChange, label }: { value: string | null | undefined; onChange: (v: string | null) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-1 text-xs text-[#6E6557]">
      <span>{label}</span>
      <input type="date" className={CTL} value={value ?? ''} onChange={e => onChange(e.target.value || null)} aria-label={label} />
    </label>
  );
}

// ═══ منتقي الشريك والصنف ═══

export interface PickedPartner { id: string; name: string | null }

/**
 * منتقي بالبحث في الخادم (`GET /partners/search`، حدّ 20) بصلاحية عرض الدفاتر وحدها — لا يحتاج المحاسب صلاحية العملاء.
 * الكتابة محلية حتى تهدأ (مهلة)، فطلبٌ واحد لكل بحث؛ والأسهم وEnter للاختيار بلوحة المفاتيح.
 */
export function PartnerPicker({ type, value, onChange, placeholder, ariaLabel }: {
  type: PartnerSearchType;
  value: PickedPartner | null;
  onChange: (v: PickedPartner | null) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (draft === q) return;
    const t = setTimeout(() => setQ(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, q]);

  const search = useQuery({
    queryKey: ledgerPartnersKeys.search(type, q.trim()),
    queryFn: async () => (await ledgerPartnersApi.search(type, q)).data.data.items,
    enabled: open,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => search.data ?? [], [search.data]);
  useEffect(() => setActive(0), [items]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const pick = (it: { id: string; name: string }) => {
    onChange({ id: it.id, name: it.name });
    setOpen(false);
    setDraft('');
    setQ('');
  };

  if (value && !open) {
    return (
      <span className="inline-flex items-center gap-1 rounded-lg border border-[#E8E0D2] bg-white px-2 py-1 text-xs">
        <button type="button" className="max-w-[14rem] truncate text-start text-[#1F1A13] hover:text-[#E15A30]" title={tr('تغيير')} onClick={() => setOpen(true)}>
          <bdi>{value.name ?? value.id}</bdi>
        </button>
        <button type="button" aria-label={tr('إزالة')} className="text-[#9A8F7E] hover:text-[#C0392B]" onClick={() => onChange(null)}>
          <X size={12} />
        </button>
      </span>
    );
  }

  return (
    <div ref={boxRef} className="relative inline-flex">
      <span className="relative inline-flex items-center">
        <Search size={13} className="pointer-events-none absolute text-[#9A8F7E]" style={{ insetInlineStart: 8 }} />
        <input
          type="search"
          className={`${CTL} w-56`}
          style={{ paddingInlineStart: 24 }}
          value={draft}
          maxLength={100}
          placeholder={placeholder}
          aria-label={ariaLabel}
          // من الشريحة («تغيير») إلى البحث: المؤشّر في الحقل مباشرة
          autoFocus={!!value}
          onFocus={() => setOpen(true)}
          onChange={e => { setDraft(e.target.value); setOpen(true); }}
          onKeyDown={e => {
            if (e.key === 'Escape') { setOpen(false); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(items.length - 1, a + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
            if (e.key === 'Enter' && items[active]) { e.preventDefault(); pick(items[active]); }
          }}
        />
      </span>
      {open && (
        <div role="listbox" className="absolute z-40 top-full mt-1 start-0 w-72 max-w-[85vw] max-h-72 overflow-auto rounded-xl border border-[#E8E0D2] bg-white p-1 shadow-xl">
          {search.isLoading && <p className="px-2 py-1.5 text-xs text-[#9A8F7E]">{tr('جاري التحميل...')}</p>}
          {search.isError && <p className="px-2 py-1.5 text-xs text-[#C0392B]">{partnerErrorText(tr, search.error)}</p>}
          {search.isSuccess && items.length === 0 && <p className="px-2 py-1.5 text-xs text-[#9A8F7E]">{tr('لا نتائج')}</p>}
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-start text-xs ${i === active ? 'bg-[#FBEBE2]' : 'hover:bg-[#FBF7F0]'}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(it)}
            >
              <bdi className="truncate">{it.name}</bdi>
              {it.hint ? <bdi className="shrink-0 text-[10px] text-[#9A8F7E]">{partnerHintText(type, it.hint, tr)}</bdi> : null}
            </button>
          ))}
          {value && (
            <button type="button" className="mt-1 w-full rounded-lg border-t border-[#F1EBDF] px-2 py-1.5 text-start text-xs text-[#6E6557] hover:bg-[#FBF7F0]" onClick={() => setOpen(false)}>
              {tr('إبقاء')} <bdi>{value.name ?? value.id}</bdi>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ═══ أعمار الذمم (المدينة والدائنة) ═══

/**
 * أعمار الذمم من الدفاتر (Odoo Aged Receivable/Payable): البنود المفتوحة بعد المطابقات الجزئية على حسابات الذمة، صفّ لكل
 * شريك بأعمدته، و«غير مخصّص» سالباً (سند غير مخصّص أو مرتجع غير مطبّق أو دفعة مقدمة)، فيبقى الإجمالي = صافي رصيده المفتوح.
 * اختيار شريك يعرض بنوده المفتوحة مفصّلة، ومن كل صفّ رابط إلى دفتر أستاذه بالتاريخ نفسه.
 */
export function AgingReportView({ kind }: { kind: 'AR' | 'AP' }) {
  const tr = useTr();
  const [sp, setSp] = useSearchParams();
  const reportKey: PartnerReportKey = kind === 'AR' ? 'aged-receivable' : 'aged-payable';
  const partnerType = kind === 'AR' ? 'customer' : 'vendor';
  const spString = sp.toString();
  const state = useMemo(() => readAgingState(spString), [spString]);
  const setState = useCallback((next: AgingState) => setSp(new URLSearchParams(agingSearch(next)), { replace: true }), [setSp]);

  const params = useMemo(() => agingParams(state), [state]);
  const q = useQuery({
    queryKey: ledgerPartnersKeys.report(reportKey, params),
    queryFn: async () => (await ledgerPartnersApi.report(reportKey, params)).data.data,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const data = q.data;
  const decimals = data?.settings.currencyDecimals ?? 2;
  const buckets = data?.buckets ?? state.buckets;
  const labels = agingColumnLabels(buckets, tr, kind);
  const asOf = state.asOf ?? data?.asOf ?? null;

  // أعمدة الأعمار: مسودة محلية تُطبَّق حين تصلح (مرآة تحقّق الخادم) فلا طلب يرفضه بـ400
  const [bucketsDraft, setBucketsDraft] = useState(state.buckets.join(','));
  useEffect(() => setBucketsDraft(state.buckets.join(',')), [state.buckets]);
  const draftBuckets = parseAgingBucketsInput(bucketsDraft);
  const applyBuckets = () => { if (draftBuckets) setState({ ...state, buckets: draftBuckets }); };

  const cols = [...AGING_BUCKET_KEYS, 'unappliedCredits', 'total'] as const;
  const amountCells = (r: AgingColumns, strong?: boolean) => cols.map(k => (
    <td key={k} className={`${TD} text-end`}><Amount value={r[k]} decimals={decimals} blankZero={k !== 'total'} strong={strong || k === 'total'} /></td>
  ));
  const unbalanced = data ? [...data.rows, data.totals].some(r => !agingRowBalanced(r)) : false;

  const controls = (
    <>
      <DateField label={tr('اعتباراً من')} value={asOf} onChange={v => setState({ ...state, asOf: v })} />
      <select className={CTL} value={state.basis} onChange={e => setState({ ...state, basis: e.target.value as AgingBasis })} aria-label={tr('أساس العمر')}>
        {(Object.entries(agingBasisLabels(tr)) as [AgingBasis, string][]).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <label className="inline-flex items-center gap-1 text-xs text-[#6E6557]">
        <span>{tr('الأعمدة (أيام)')}</span>
        <input
          className={`${CTL} w-32 ${draftBuckets ? '' : 'border-[#C0392B] ring-1 ring-[#C0392B]/30'}`}
          dir="ltr"
          value={bucketsDraft}
          onChange={e => setBucketsDraft(e.target.value)}
          onBlur={applyBuckets}
          onKeyDown={e => { if (e.key === 'Enter') applyBuckets(); }}
          aria-invalid={!draftBuckets}
          aria-label={tr('الأعمدة (أيام)')}
          title={tr('أربعة أعداد متزايدة مثل 30,60,90,120')}
        />
      </label>
      <PartnerPicker
        type={partnerType}
        value={state.partnerId ? { id: state.partnerId, name: state.partnerName ?? data?.rows[0]?.name ?? null } : null}
        onChange={p => setState({ ...state, partnerId: p?.id ?? null, partnerName: p?.name ?? null })}
        placeholder={kind === 'AR' ? tr('كل العملاء — ابحث لعرض بنود عميل') : tr('كل الموردين — ابحث لعرض بنود مورد')}
        ariaLabel={kind === 'AR' ? tr('العميل') : tr('المورّد')}
      />
      {!draftBuckets && <span className="text-xs text-[#C0392B]">{tr('أعمدة الأعمار أربعة أعداد صحيحة موجبة متزايدة مثل 30,60,90,120')}</span>}
    </>
  );

  return (
    <PartnerReportFrame
      reportKey={reportKey}
      subtitle={<>{asOf ? `${tr('اعتباراً من')} ${dayText(asOf)} · ` : ''}{agingBasisLabels(tr)[state.basis]}</>}
      controls={controls}
      exportParams={params}
      warnings={data?.warnings}
      error={q.isError ? q.error : null}
      loading={q.isLoading}
      fetching={q.isFetching}
    >
      {unbalanced && (
        <div className="rounded-xl border border-[#E8C3B7] bg-[#FBEBE2] p-2 text-xs text-[#C0392B]">{tr('مجموع الأعمدة لا يساوي الإجمالي في صفّ أو أكثر — أعد التحميل أو أبلغ الدعم')}</div>
      )}
      <div className="overflow-x-auto rounded-xl border border-[#E8E0D2] bg-white">
        <table className="w-full text-xs">
          <thead className="bg-[#F1EBDF] text-[#6E6557]">
            <tr>
              <th scope="col" className={`${TH} text-start`}>{kind === 'AR' ? tr('العميل') : tr('المورّد')}</th>
              {cols.map(k => <th key={k} scope="col" className={`${TH} text-end`}><bdi>{labels[k]}</bdi></th>)}
            </tr>
          </thead>
          <tbody>
            {!data || data.rows.length === 0 ? (
              <tr><td colSpan={cols.length + 1} className="px-3 py-8 text-center text-[#9A8F7E]">{q.isLoading ? tr('جاري التحميل...') : tr('لا بنود مفتوحة في هذا التاريخ')}</td></tr>
            ) : data.rows.map(r => (
              <tr key={r.partnerId} className="border-b border-[#F1EBDF]">
                <th scope="row" className={`${TD} text-start font-normal`}>
                  <span className="inline-flex items-center gap-1.5">
                    <button
                      type="button"
                      className="text-start text-[#1F1A13] hover:text-[#E15A30] hover:underline"
                      title={tr('عرض البنود المفتوحة')}
                      onClick={() => setState({ ...state, partnerId: r.partnerId, partnerName: r.name })}
                    >
                      <bdi>{r.name ?? r.partnerId}</bdi>
                    </button>
                    <Link
                      to={partnerLedgerHref({ type: partnerType, id: r.partnerId, name: r.name, to: data.asOf })}
                      title={tr('دفتر أستاذ الشريك')}
                      aria-label={tr('دفتر أستاذ الشريك')}
                      className="text-[#9A8F7E] hover:text-[#E15A30]"
                    >
                      <BookOpen size={13} />
                    </Link>
                    {/* وثائق العميل («استديو العميل») — تُحمَّل عند الفتح وحده */}
                    {kind === 'AR' && <AttachmentLinks sourceType="CUSTOMER" sourceId={r.partnerId} title={tr('وثائق العميل')} />}
                  </span>
                </th>
                {amountCells(r)}
              </tr>
            ))}
          </tbody>
          {data && data.rows.length > 0 && (
            <tfoot className="border-t-2 border-[#E8E0D2]">
              <tr className="bg-[#F1EBDF] font-semibold">
                <th scope="row" className={`${TD} text-start`}>{tr('الإجمالي')}</th>
                {amountCells(data.totals, true)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {data?.detail && (
        <section className="space-y-1.5">
          <h2 className="text-sm font-semibold text-[#1F1A13]">{tr('البنود المفتوحة')} — <bdi>{data.rows[0]?.name ?? state.partnerName ?? ''}</bdi></h2>
          <div className="overflow-x-auto rounded-xl border border-[#E8E0D2] bg-white">
            <table className="w-full text-xs">
              <thead className="bg-[#F1EBDF] text-[#6E6557]">
                <tr>
                  <th scope="col" className={`${TH} text-start`}>{tr('القيد')}</th>
                  <th scope="col" className={`${TH} text-start`}>{tr('التاريخ')}</th>
                  <th scope="col" className={`${TH} text-start`}>{tr('الاستحقاق')}</th>
                  <th scope="col" className={`${TH} text-end`}>{tr('أيام التأخير')}</th>
                  <th scope="col" className={`${TH} text-start`}>{tr('العمود')}</th>
                  <th scope="col" className={`${TH} text-end`}>{tr('المتبقّي')}</th>
                </tr>
              </thead>
              <tbody>
                {data.detail.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-[#9A8F7E]">{tr('لا بنود مفتوحة في هذا التاريخ')}</td></tr>
                ) : data.detail.map((x, i) => (
                  <tr key={x.lineId ?? `${x.moveId}:${i}`} className="border-b border-[#F1EBDF]">
                    <td className={TD}><MoveLink moveId={x.moveId} number={x.moveNumber} /></td>
                    <td className={`${TD} whitespace-nowrap`}>{dayText(x.date)}</td>
                    <td className={`${TD} whitespace-nowrap`}>{dayText(x.dueDate)}</td>
                    <td className={`${TD} text-end tabular-nums`}>{x.bucket === 'unapplied' ? '—' : <bdi>{x.daysOverdue}</bdi>}</td>
                    <td className={TD}><bdi>{x.bucket === 'unapplied' ? labels.unappliedCredits : labels[x.bucket]}</bdi></td>
                    <td className={`${TD} text-end`}><Amount value={x.residual} decimals={decimals} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </PartnerReportFrame>
  );
}
