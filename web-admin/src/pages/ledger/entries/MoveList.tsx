import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Hourglass, X, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useAuthStore } from '../../../store/authStore';
import { canLedger } from '../../../lib/ledgerPerms';
import { formatDayOnly } from '../../../utils/format';
import { exportExcel } from '../../../utils/excel';
import ConfirmDialog from '../../../components/ConfirmDialog';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import {
  LedgerListView, initialLedgerListState, type LedgerAction, type LedgerColumn, type LedgerFilterDef,
  type LedgerGearAction, type LedgerGroupByDef, type LedgerListState,
} from '../../../components/ledger/LedgerListView';
import { ledgerConfigApi, ledgerErrorOf, ledgerKeys } from '../../../api/ledgerConfig';
import {
  ledgerMovesApi, ledgerMoveKeys, type BulkRejection, type GlMoveRow, type MoveListParams, type ReviewState,
} from '../../../api/ledgerMoves';
import { ledgerHref } from '../routes';
import { ledgerErrorMessage, ledgerErrorText } from '../../../lib/ledger/errors';

/**
 * قائمة قيود اليومية (JE‑01..03، §8.3): الأعمدة التاريخ والرقم والشريك والمرجع والدفتر والإجمالي والحالة،
 * وفلتر «مُرحّل» افتراضي قابل للإزالة، والإجراءات الجماعية: ترحيل المسودات، حذفها (JE‑05b)، المراجعة، التصدير.
 * قبل التفعيل (§6.1): شريط واضح، والترحيل الجماعي معطَّل بسببه، وأي LEDGER_NOT_SETUP من الخادم يُشرح.
 * يقبل من الرابط `state` و`dateFrom` و`dateTo` و`journalId` و`accountId` و`ids` (مثل رابط «المسودات قبل الإقفال»).
 */

const BULK_LIMIT = 100;
type Tr = (ar: string) => string;

/** نصوص الأخطاء في lib/ledger/errors.ts (مُعاد تصديرها لمن يستوردها من هنا). */
export { ledgerErrorText, ledgerErrorMessage } from '../../../lib/ledger/errors';

/** ملخص رفض جماعي: «السبب (العدد)» لكل رمز. */
function rejectionSummary(tr: Tr, rejected: readonly BulkRejection[]): string {
  const counts = new Map<string, number>();
  for (const r of rejected) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
  return [...counts.entries()].map(([code, n]) => `${ledgerErrorText(tr, code)} (${n})`).join(' · ');
}

// ═══ الفلاتر ═══

const FILTER_PARAMS: Record<string, { param: keyof MoveListParams; value: string | boolean }> = {
  posted: { param: 'state', value: 'POSTED' },
  draft: { param: 'state', value: 'DRAFT' },
  notReviewed: { param: 'reviewState', value: 'NONE' },
  reviewed: { param: 'reviewState', value: 'REVIEWED' },
  flagged: { param: 'reviewState', value: 'FLAGGED' },
  manual: { param: 'origin', value: 'MANUAL' },
  auto: { param: 'origin', value: 'AUTO' },
  attention: { param: 'needsAttention', value: true },
  late: { param: 'lateArrival', value: true },
  autoPost: { param: 'autoPost', value: true },
};

/** فلاتر المجموعة الواحدة OR (قائمة مفصولة بفواصل)، والمنطقية AND. */
function filtersToParams(keys: readonly string[]): MoveListParams {
  const lists: Record<string, string[]> = {};
  const out: MoveListParams = {};
  for (const k of keys) {
    const f = FILTER_PARAMS[k];
    if (!f) continue;
    if (typeof f.value === 'boolean') (out as Record<string, unknown>)[f.param] = f.value;
    else (lists[f.param] ??= []).push(f.value);
  }
  for (const [p, v] of Object.entries(lists)) (out as Record<string, unknown>)[p] = v.join(',');
  return out;
}

const URL_EXTRAS = ['dateFrom', 'dateTo', 'journalId', 'accountId', 'ids', 'customerId', 'vendorId', 'salesRepId'] as const;
type UrlExtras = Partial<Record<(typeof URL_EXTRAS)[number], string>>;

export default function MoveList() {
  const tr = useTr();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const [sp, setSp] = useSearchParams();
  const canPost = canLedger(user, 'canPostJournals');

  // الحالة الأولية: state من الرابط يعلو فلتر «مُرحّل» الافتراضي (JE‑02)
  const urlState = sp.get('state');
  const initialFilters = urlState
    ? urlState.split(',').map(s => (s === 'DRAFT' ? 'draft' : s === 'POSTED' ? 'posted' : '')).filter(Boolean)
    : ['posted'];
  const [state, setState] = useState<LedgerListState>(() => initialLedgerListState({ filters: initialFilters }));
  const touched = useRef(!!urlState);
  const [extras, setExtras] = useState<UrlExtras>(() => Object.fromEntries(URL_EXTRAS.map(k => [k, sp.get(k) ?? undefined]).filter(([, v]) => v)));

  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data, staleTime: 60_000 });
  const activated = statusQ.data ? !!statusQ.data.activatedAt : true;

  // قبل التفعيل لا مرحَّل: الفلتر الافتراضي يصير «مسودة» ما لم يغيّره المستخدم
  useEffect(() => {
    if (statusQ.data && !statusQ.data.activatedAt && !touched.current) {
      touched.current = true;
      setState(s => ({ ...s, filters: s.filters.filter(f => f !== 'posted').concat(s.filters.includes('draft') ? [] : ['draft']) }));
    }
  }, [statusQ.data]);

  const params: MoveListParams = useMemo(() => ({
    ...filtersToParams(state.filters), ...extras, search: state.search || undefined, offset: state.offset, limit: state.limit,
  }), [state, extras]);

  const q = useQuery({
    queryKey: ledgerMoveKeys.moves(params),
    queryFn: async () => (await ledgerMovesApi.moves.list(params)).data.data,
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.rows ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['ledger', 'moves'] });

  const onStateChange = (s: LedgerListState) => { touched.current = true; setState(s); };
  const clearExtras = () => {
    setExtras({});
    const next = new URLSearchParams(sp);
    for (const k of [...URL_EXTRAS, 'state']) next.delete(k);
    setSp(next, { replace: true });
  };

  // ═══ حذف المسودات بتأكيد (يُحلّ الوعد عند الإغلاق فيُبقي التحديد حتى القرار) ═══
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; resolve: () => void } | null>(null);
  const [busy, setBusy] = useState(false);

  const stateLabel = (m: Pick<GlMoveRow, 'state'>) => (m.state === 'POSTED' ? tr('مُرحّل') : tr('مسودة'));

  const filters: LedgerFilterDef[] = [
    { key: 'posted', label: tr('مُرحّل'), group: 'state' },
    { key: 'draft', label: tr('مسودة'), group: 'state' },
    { key: 'notReviewed', label: tr('غير مراجع'), group: 'review' },
    { key: 'reviewed', label: tr('مراجع'), group: 'review' },
    { key: 'flagged', label: tr('للمتابعة'), group: 'review' },
    { key: 'manual', label: tr('يدوي'), group: 'origin' },
    { key: 'auto', label: tr('آلي'), group: 'origin' },
    { key: 'attention', label: tr('يحتاج انتباها'), group: 'flags' },
    { key: 'late', label: tr('وصول متأخر'), group: 'flags' },
    { key: 'autoPost', label: tr('ترحيل تلقائي مجدول'), group: 'flags' },
  ];

  const groupBys: LedgerGroupByDef<GlMoveRow>[] = [
    { key: 'journal', label: tr('الدفتر'), value: r => `${r.journal.code} ${r.journal.name}` },
    { key: 'state', label: tr('الحالة'), value: r => stateLabel(r) },
    { key: 'month', label: tr('الشهر'), value: r => r.date.slice(0, 7) },
    { key: 'partner', label: tr('الشريك'), value: r => r.partnerName ?? '' },
  ];

  const reviewLabel = (s: ReviewState) => (s === 'REVIEWED' ? tr('مراجع') : s === 'FLAGGED' ? tr('للمتابعة') : tr('غير مراجع'));

  const columns: LedgerColumn<GlMoveRow>[] = [
    { key: 'date', label: tr('التاريخ'), render: r => <span className="whitespace-nowrap">{formatDayOnly(r.date)}</span> },
    {
      key: 'number', label: tr('الرقم'),
      render: r => (r.number
        ? <bdi className="font-semibold tabular-nums">{r.number}</bdi>
        : <span className="text-[#9A8F7E]">{tr('(مسودة)')}</span>),
    },
    { key: 'partner', label: tr('الشريك'), render: r => r.partnerName ?? '' },
    {
      key: 'ref', label: tr('المرجع'),
      render: r => <span className="block max-w-[14rem] truncate" title={r.ref ?? undefined}>{r.ref ?? ''}</span>,
    },
    { key: 'journal', label: tr('الدفتر'), render: r => <span className="whitespace-nowrap">{r.journal.name}</span> },
    { key: 'total', label: tr('الإجمالي'), align: 'end', render: r => <LedgerAmount value={r.total} decimals={r.currencyDecimals} colored={false} /> },
    {
      key: 'state', label: tr('الحالة'), align: 'center',
      render: r => (
        <span className="inline-flex items-center gap-1">
          <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${r.state === 'POSTED' ? 'bg-emerald-50 text-emerald-700' : 'bg-[#F1EBDF] text-[#6E6557]'}`}>{stateLabel(r)}</span>
          {r.needsAttention && <span title={r.attentionReason ?? tr('يحتاج انتباها')}><AlertTriangle size={13} className="text-amber-600" /></span>}
        </span>
      ),
    },
    { key: 'narration', label: tr('البيان'), optional: true, render: r => <span className="block max-w-[18rem] truncate" title={r.narration ?? undefined}>{r.narration ?? ''}</span> },
    { key: 'origin', label: tr('المصدر'), optional: true, render: r => (r.origin === 'AUTO' ? tr('آلي') : tr('يدوي')) },
    { key: 'review', label: tr('المراجعة'), optional: true, render: r => reviewLabel(r.reviewState) },
    { key: 'autoPostOn', label: tr('ترحيل تلقائي في'), optional: true, render: r => (r.autoPostOn ? formatDayOnly(r.autoPostOn) : '') },
  ];

  // ═══ الإجراءات ═══

  const limitReason = (ids: string[]) => (ids.length > BULK_LIMIT ? tr('الحد الأقصى 100 قيد في الإجراء الواحد') : null);

  const postDrafts = async (ids: string[]) => {
    setBusy(true);
    try {
      const r = (await ledgerMovesApi.moves.postDrafts(ids)).data.data;
      if (r.posted.length) toast.success(`${tr('تم ترحيل القيود')}: ${r.posted.length}`);
      if (r.rejected.length) {
        if (r.rejected.every(x => x.code === 'LEDGER_NOT_SETUP')) toast.error(ledgerErrorText(tr, 'LEDGER_NOT_SETUP'), { duration: 6000 });
        else toast.error(`${tr('تعذر ترحيل بعض القيود')}: ${rejectionSummary(tr, r.rejected)}`, { duration: 7000 });
      }
      refresh();
      qc.invalidateQueries({ queryKey: ['ledger', 'items'] });
    } catch (err) {
      const e = ledgerErrorOf(err);
      toast.error(ledgerErrorMessage(tr, e));
    } finally { setBusy(false); }
  };

  const deleteDrafts = async (ids: string[]) => {
    setBusy(true);
    try {
      const r = (await ledgerMovesApi.moves.deleteDrafts(ids)).data.data;
      if (r.rejected.length) toast.error(`${tr('لم يُحذف شيء')}: ${rejectionSummary(tr, r.rejected)}`, { duration: 7000 });
      else toast.success(`${tr('تم حذف المسودات')}: ${r.deleted.length}`);
      refresh();
    } catch (err) {
      const e = ledgerErrorOf(err);
      toast.error(ledgerErrorMessage(tr, e));
    } finally { setBusy(false); }
  };

  const review = async (ids: string[], s: ReviewState) => {
    try {
      const r = (await ledgerMovesApi.moves.reviewMany(ids, s)).data.data;
      if (r.updated.length) toast.success(`${tr('تم تحديث المراجعة')}: ${r.updated.length}`);
      if (r.rejected.length) toast.error(rejectionSummary(tr, r.rejected));
      refresh();
    } catch (err) {
      const e = ledgerErrorOf(err);
      toast.error(ledgerErrorMessage(tr, e));
    }
  };

  const exportMoves = async (input: { ids?: string[] }) => {
    const t = toast.loading(tr('جاري التصدير...'));
    try {
      const { ids } = input;
      const filters = ids ? undefined : { ...filtersToParams(state.filters), ...extras, search: state.search || undefined };
      const res = await ledgerMovesApi.lists.export<GlMoveRow>('moves', ids ? { ids } : { filters });
      const out = res.data.data.rows.map(r => ({
        [tr('التاريخ')]: r.date,
        [tr('الرقم')]: r.number ?? '',
        [tr('الشريك')]: r.partnerName ?? '',
        [tr('المرجع')]: r.ref ?? '',
        [tr('الدفتر')]: `${r.journal.code} ${r.journal.name}`,
        [tr('الإجمالي')]: r.total,
        [tr('الحالة')]: stateLabel(r),
        [tr('البيان')]: r.narration ?? '',
        [tr('المصدر')]: r.origin === 'AUTO' ? tr('آلي') : tr('يدوي'),
        [tr('المراجعة')]: reviewLabel(r.reviewState),
      }));
      await exportExcel([{ name: tr('قيود اليومية'), rows: out }], `journal-entries-${new Date().toISOString().slice(0, 10)}`);
      toast.success(tr('تم التصدير'), { id: t });
    } catch (err) {
      const e = ledgerErrorOf(err);
      toast.error(ledgerErrorMessage(tr, e), { id: t });
    }
  };

  const bulkActions: LedgerAction[] = [
    {
      label: tr('ترحيل'), perm: 'canPostJournals', run: postDrafts,
      disabledReason: ids => (!activated ? ledgerErrorText(tr, 'LEDGER_NOT_SETUP') : busy ? tr('جاري التنفيذ...') : limitReason(ids)),
    },
    { label: tr('تعليم كمراجع'), perm: 'canPostJournals', run: ids => review(ids, 'REVIEWED'), disabledReason: limitReason },
    { label: tr('تعليم للمتابعة'), perm: 'canPostJournals', run: ids => review(ids, 'FLAGGED'), disabledReason: limitReason },
    { label: tr('إلغاء المراجعة'), perm: 'canPostJournals', run: ids => review(ids, 'NONE'), disabledReason: limitReason },
    { label: tr('تصدير'), perm: 'canViewLedger', run: ids => exportMoves({ ids }) },
    {
      label: tr('حذف المسودات'), perm: 'canPostJournals', danger: true,
      run: ids => new Promise<void>(resolve => setConfirmDelete({ ids, resolve })),
      disabledReason: ids => (busy ? tr('جاري التنفيذ...') : limitReason(ids)),
    },
  ];

  const gearActions: LedgerGearAction[] = [
    { label: tr('تصدير الكل'), perm: 'canViewLedger', run: () => exportMoves({}) },
  ];

  const extraChips = Object.entries(extras).filter(([, v]) => v);
  const extraLabel = (k: string) => (k === 'dateFrom' ? tr('من تاريخ') : k === 'dateTo' ? tr('حتى تاريخ') : k === 'journalId' ? tr('الدفتر')
    : k === 'accountId' ? tr('الحساب') : k === 'ids' ? tr('قيود محددة') : tr('الشريك'));

  return (
    <div className="space-y-3">
      {statusQ.data && !statusQ.data.activatedAt && (
        <div className="flex items-start gap-2 rounded-xl border border-[#F3D3C4] bg-[#FBEBE2] px-3 py-2 text-sm text-[#1F1A13]" role="status">
          <Hourglass size={16} className="text-[#E15A30] shrink-0 mt-0.5" />
          <p>
            <span className="font-semibold">{tr('الدفاتر بانتظار الإعداد')}</span>
            {' — '}
            {tr('يمكنك إنشاء المسودات وتحريرها وحذفها الآن، والترحيل متاح بعد اكتمال الإعداد المبدئي للدفاتر')}
          </p>
        </div>
      )}

      {extraChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-[#6E6557]">{tr('فلاتر من الرابط')}:</span>
          {extraChips.map(([k, v]) => (
            <span key={k} className="rounded-md bg-[#F1EBDF] px-1.5 py-0.5">
              {extraLabel(k)}: <bdi>{k === 'ids' ? String(v).split(',').length : k.startsWith('date') ? formatDayOnly(v as string) : v}</bdi>
            </span>
          ))}
          <button type="button" onClick={clearExtras} className="inline-flex items-center gap-0.5 text-[#E15A30] hover:underline"><X size={12} />{tr('مسح')}</button>
        </div>
      )}

      <LedgerListView<GlMoveRow>
        title={tr('قيود اليومية')}
        screen="entries"
        columns={columns}
        rows={rows}
        total={q.data?.total ?? 0}
        loading={q.isLoading}
        fetching={q.isFetching || busy}
        state={state}
        onStateChange={onStateChange}
        filters={filters}
        groupBys={groupBys}
        bulkActions={bulkActions}
        gearActions={gearActions}
        recordPath={r => ledgerHref(`entries/${r.id}`)}
        views={[{ key: 'list', label: tr('قائمة') }]}
        view="list"
        emptyText={q.isError ? ledgerErrorMessage(tr, ledgerErrorOf(q.error)) : tr('لا توجد قيود')}
        toolbar={canPost ? (
          <Link to={ledgerHref('entries/new')} className="btn-primary !py-1.5 !px-3 text-sm inline-flex items-center gap-1">
            <Plus size={15} />{tr('جديد')}
          </Link>
        ) : undefined}
      />

      {confirmDelete && (
        <ConfirmDialog
          title={tr('حذف المسودات')}
          message={`${tr('حذف المسودات المحددة نهائيا؟ لا يترك الحذف فجوة في الترقيم، ويُرفض كله إن كان بينها قيد مرحّل أو مملوك لمستند')} (${confirmDelete.ids.length})`}
          danger
          confirmLabel={tr('حذف')}
          loading={busy}
          onClose={() => { confirmDelete.resolve(); setConfirmDelete(null); }}
          onConfirm={() => { const c = confirmDelete; setConfirmDelete(null); void deleteDrafts(c.ids).finally(c.resolve); }}
        />
      )}
    </div>
  );
}
