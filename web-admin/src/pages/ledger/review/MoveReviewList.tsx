import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { formatDayOnly } from '../../../utils/format';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import { Badge } from '../../../components/ledger/SyncBadges';
import {
  LedgerListView, initialLedgerListState, type LedgerAction, type LedgerColumn, type LedgerFilterDef, type LedgerListState,
} from '../../../components/ledger/LedgerListView';
import { ledgerErrorOf } from '../../../api/ledgerConfig';
import { ledgerMovesApi, ledgerMoveKeys, type GlMoveRow, type MoveListParams, type ReviewState } from '../../../api/ledgerMoves';
import { ledgerErrorMessage, ledgerErrorText } from '../../../lib/ledger/errors';
import { sourceTypeLabels } from '../../../lib/ledger/sync';
import { ledgerHref } from '../routes';

/**
 * «مراجعة ← قيود تحتاج انتباها / مستندات وصلت متأخرة / قيود غير مُراجَعة» (M3، §8.2 `review/MoveReviewList kind=…`).
 * النوع من المسار: attention ⇒ needsAttention، late ⇒ lateArrival، unreviewed ⇒ مرحّلة بـreviewState=NONE.
 * القراءة من GET /moves (canViewLedger)، وتعليم المراجعة الجماعي POST /moves/review (canPostJournals).
 */

export type MoveReviewKind = 'attention' | 'late' | 'unreviewed';

export function reviewKindOf(pathname: string): MoveReviewKind {
  const last = pathname.replace(/\/+$/, '').split('/').pop();
  return last === 'late' ? 'late' : last === 'unreviewed' ? 'unreviewed' : 'attention';
}

export function reviewKindParams(kind: MoveReviewKind): MoveListParams {
  switch (kind) {
    case 'attention': return { needsAttention: true };
    case 'late': return { lateArrival: true, state: 'POSTED' };
    case 'unreviewed': return { reviewState: 'NONE', state: 'POSTED' };
  }
}

const BULK_LIMIT = 100;

export default function MoveReviewList() {
  const tr = useTr();
  const qc = useQueryClient();
  const location = useLocation();
  const kind = reviewKindOf(location.pathname);
  const [state, setState] = useState<LedgerListState>(() => initialLedgerListState());
  useEffect(() => setState(initialLedgerListState()), [kind]);

  const filterParams: Record<string, MoveListParams> = {
    auto: { origin: 'AUTO' }, manual: { origin: 'MANUAL' }, flagged: { reviewState: 'FLAGGED' }, notReviewed: { reviewState: 'NONE' },
  };
  const params: MoveListParams = useMemo(() => ({
    ...Object.assign({}, ...state.filters.map(f => filterParams[f] ?? {})),
    ...reviewKindParams(kind),
    search: state.search || undefined, offset: state.offset, limit: state.limit,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [state, kind]);

  const q = useQuery({
    queryKey: ledgerMoveKeys.moves({ review: kind, ...params }),
    queryFn: async () => (await ledgerMovesApi.moves.list(params)).data.data,
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.rows ?? [];
  const typeLabels = sourceTypeLabels(tr);

  const title = kind === 'attention' ? tr('قيود تحتاج انتباها') : kind === 'late' ? tr('مستندات وصلت متأخرة') : tr('قيود غير مراجعة');
  const hint = kind === 'attention'
    ? tr('قيود علّمها الترحيل الآلي للمراجعة، مثل مبالغ على الحساب المعلّق أو قيود تصحيح الحسابات الرئيسية')
    : kind === 'late'
      ? tr('مستندات بتاريخ في فترة مقفلة أو قبل تاريخ البدء، رُحّلت بأول تاريخ مفتوح')
      : tr('قيود مرحّلة لم يعلّمها أحد كمراجعة بعد');

  const review = async (ids: string[], s: ReviewState) => {
    try {
      const r = (await ledgerMovesApi.moves.reviewMany(ids, s)).data.data;
      if (r.updated.length) toast.success(`${tr('تم تحديث المراجعة')}: ${r.updated.length}`);
      if (r.rejected.length) toast.error(r.rejected.map(x => ledgerErrorText(tr, x.code)).filter((v, i, a) => a.indexOf(v) === i).join(' · '));
      qc.invalidateQueries({ queryKey: ['ledger', 'moves'] });
    } catch (err) {
      toast.error(ledgerErrorMessage(tr, ledgerErrorOf(err)));
    }
  };
  const limitReason = (ids: string[]) => (ids.length > BULK_LIMIT ? tr('الحد الأقصى 100 قيد في الإجراء الواحد') : null);
  const bulkActions: LedgerAction[] = [
    { label: tr('تعليم كمراجع'), perm: 'canPostJournals', run: ids => review(ids, 'REVIEWED'), disabledReason: limitReason },
    { label: tr('تعليم للمتابعة'), perm: 'canPostJournals', run: ids => review(ids, 'FLAGGED'), disabledReason: limitReason },
    { label: tr('إلغاء المراجعة'), perm: 'canPostJournals', run: ids => review(ids, 'NONE'), disabledReason: limitReason },
  ];

  const filters: LedgerFilterDef[] = [
    { key: 'auto', label: tr('آلي'), group: 'origin' },
    { key: 'manual', label: tr('يدوي'), group: 'origin' },
    ...(kind !== 'unreviewed' ? [
      { key: 'notReviewed', label: tr('غير مراجع'), group: 'review' },
      { key: 'flagged', label: tr('للمتابعة'), group: 'review' },
    ] : []),
  ];

  const reviewLabel = (s: ReviewState) => (s === 'REVIEWED' ? tr('مراجع') : s === 'FLAGGED' ? tr('للمتابعة') : tr('غير مراجع'));

  const columns: LedgerColumn<GlMoveRow>[] = [
    { key: 'date', label: tr('التاريخ'), render: r => <span className="whitespace-nowrap">{formatDayOnly(r.date)}</span> },
    ...(kind === 'late' ? [{ key: 'originalDate', label: tr('التاريخ الأصلي'), render: (r: GlMoveRow) => <span className="whitespace-nowrap">{r.originalDate ? formatDayOnly(r.originalDate) : ''}</span> }] : []),
    { key: 'number', label: tr('الرقم'), render: r => (r.number ? <bdi className="font-semibold tabular-nums">{r.number}</bdi> : <span className="text-[#9A8F7E]">{tr('(مسودة)')}</span>) },
    { key: 'journal', label: tr('الدفتر'), render: r => <span className="whitespace-nowrap">{r.journal.name}</span> },
    { key: 'source', label: tr('المصدر'), render: r => (r.origin === 'AUTO' ? `${tr('آلي')}${r.sourceType ? ` · ${typeLabels[r.sourceType] ?? r.sourceType}` : ''}` : tr('يدوي')) },
    { key: 'partner', label: tr('الشريك'), render: r => r.partnerName ?? '' },
    ...(kind === 'attention' ? [{
      key: 'reason', label: tr('السبب'),
      render: (r: GlMoveRow) => <span className="inline-flex items-center gap-1 max-w-[18rem] truncate" title={r.attentionReason ?? undefined}><AlertTriangle size={13} className="text-amber-600 shrink-0" />{r.attentionReason ?? ''}</span>,
    }] : []),
    { key: 'total', label: tr('الإجمالي'), align: 'end', render: r => <LedgerAmount value={r.total} decimals={r.currencyDecimals} colored={false} /> },
    { key: 'review', label: tr('المراجعة'), align: 'center', render: r => <Badge tone={r.reviewState === 'REVIEWED' ? 'green' : r.reviewState === 'FLAGGED' ? 'amber' : 'gray'}>{reviewLabel(r.reviewState)}</Badge> },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-[#6E6557]">{hint}</p>
      <LedgerListView<GlMoveRow>
        title={title}
        screen={`review/${kind}`}
        columns={columns}
        rows={rows}
        total={q.data?.total ?? 0}
        loading={q.isLoading}
        fetching={q.isFetching}
        state={state}
        onStateChange={setState}
        filters={filters}
        bulkActions={bulkActions}
        recordPath={r => ledgerHref(`entries/${r.id}`)}
        emptyText={q.isError ? ledgerErrorMessage(tr, ledgerErrorOf(q.error)) : tr('لا توجد قيود')}
      />
    </div>
  );
}
