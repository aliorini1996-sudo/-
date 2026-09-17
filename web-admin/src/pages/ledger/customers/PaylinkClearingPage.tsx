import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { formatDayOnly } from '../../../utils/format';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import { Badge, MilliAmount, PostingBadge } from '../../../components/ledger/SyncBadges';
import {
  LedgerListView, initialLedgerListState, type LedgerColumn, type LedgerListState,
} from '../../../components/ledger/LedgerListView';
import { ledgerErrorOf } from '../../../api/ledgerConfig';
import { ledgerReviewApi, ledgerReviewKeys, type PaylinkEntryKind, type PaylinkEntryRow } from '../../../api/ledgerReview';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';
import { ledgerHref } from '../routes';
import { NotActivatedNotice } from './postingFilters';

/**
 * «العملاء ← أمانات الدفع الإلكتروني» (M3، PAY‑01، §5.5 P5/P6/P9/P10، §5.9 C5): رصيد 112005 في الأستاذ مقابل رصيد
 * التسوية (Σ SettlementEntry) مع صفوف التفسير (روابط مستردة بلا REFUND، وسندات إلكترونية ملغاة بلا REFUND)، ثم
 * ثلاثة تبويبات بحالة الترحيل: السندات الإلكترونية، والعمولات (PAYLINK_FEE)، والتوريدات (PAYOUT). للقراءة وحدها:
 * إصدار الروابط واستردادها يبقيان في مسارات الدفع الإلكتروني القائمة.
 */

const isZero = (m: string | null | undefined) => !m || /^-?0+$/.test(m);

export default function PaylinkClearingPage() {
  const tr = useTr();
  const navigate = useNavigate();
  const [kind, setKind] = useState<PaylinkEntryKind>('ONLINE');
  const [state, setState] = useState<LedgerListState>(() => initialLedgerListState());

  const summaryQ = useQuery({ queryKey: ledgerReviewKeys.paylink, queryFn: async () => (await ledgerReviewApi.customers.paylink()).data.data });
  const params = useMemo(() => ({ kind, offset: state.offset, limit: state.limit }), [kind, state]);
  const q = useQuery({
    queryKey: ledgerReviewKeys.paylinkEntries(params),
    queryFn: async () => (await ledgerReviewApi.customers.paylinkEntries(params)).data.data,
    placeholderData: keepPreviousData,
  });
  const decimals = summaryQ.data?.currencyDecimals ?? q.data?.currencyDecimals ?? 2;
  const s = summaryQ.data?.summary;

  const tabs: { key: PaylinkEntryKind; label: string }[] = [
    { key: 'ONLINE', label: tr('السندات الإلكترونية') },
    { key: 'FEE', label: tr('العمولات') },
    { key: 'PAYOUT', label: tr('التوريدات') },
  ];

  const columns: LedgerColumn<PaylinkEntryRow>[] = [
    { key: 'date', label: tr('التاريخ'), render: r => <span className="whitespace-nowrap">{formatDayOnly(r.date)}</span> },
    ...(kind === 'ONLINE' ? [
      { key: 'number', label: tr('الرقم'), render: (r: PaylinkEntryRow) => <bdi className="font-semibold tabular-nums">{r.number}</bdi> },
      { key: 'customer', label: tr('العميل'), render: (r: PaylinkEntryRow) => r.customerName ?? '' },
      { key: 'status', label: tr('حالة المستند'), render: (r: PaylinkEntryRow) => (r.status === 'CANCELLED' ? <span className="text-[#C0392B]">{tr('ملغى')}</span> : tr('نشط')) },
      { key: 'link', label: tr('رابط الدفع'), render: (r: PaylinkEntryRow) => (r.paylinkStatus ? <bdi className="font-mono text-[11px]">{r.paylinkStatus}</bdi> : '') },
    ] : []),
    ...(kind === 'FEE' ? [
      { key: 'feeNet', label: tr('صافي العمولة'), align: 'end' as const, render: (r: PaylinkEntryRow) => <LedgerAmount value={r.feeNet ?? 0} decimals={decimals} colored={false} /> },
      { key: 'feeVat', label: tr('ضريبة العمولة'), align: 'end' as const, render: (r: PaylinkEntryRow) => <LedgerAmount value={r.feeVat ?? 0} decimals={decimals} colored={false} /> },
    ] : []),
    ...(kind === 'PAYOUT' ? [
      { key: 'ref', label: tr('مرجع التحويل'), render: (r: PaylinkEntryRow) => <bdi>{r.bankReference ?? ''}</bdi> },
    ] : []),
    { key: 'amount', label: tr('المبلغ'), align: 'end', render: r => <LedgerAmount value={r.amount} decimals={decimals} /> },
    { key: 'posting', label: tr('حالة الترحيل'), render: r => <PostingBadge posting={r.posting} /> },
  ];

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-bold text-[#1F1A13]">{tr('أمانات الدفع الإلكتروني')}</h1>
      {summaryQ.data && !summaryQ.data.activated && <NotActivatedNotice />}
      {summaryQ.isError && <p className="text-sm text-[#C0392B]">{ledgerErrorMessage(tr, ledgerErrorOf(summaryQ.error))}</p>}

      {s && (
        <div className="card space-y-3">
          <div className="grid gap-3 sm:grid-cols-3 text-sm">
            <div><p className="text-xs text-[#9A8F7E]">{tr('رصيد الأمانات في الأستاذ')}</p><p className="text-lg font-bold"><MilliAmount value={s.ledgerMilli} decimals={decimals} /></p></div>
            <div><p className="text-xs text-[#9A8F7E]">{tr('رصيد التسوية لدى فيلد سيلز')}</p><p className="text-lg font-bold"><MilliAmount value={s.settlementBalanceMilli} decimals={decimals} /></p></div>
            <div>
              <p className="text-xs text-[#9A8F7E]">{tr('الفرق')} (C5)</p>
              <p className="text-lg font-bold flex items-center gap-2">
                <MilliAmount value={s.gapMilli} decimals={decimals} />
                {isZero(s.gapMilli) ? <Badge tone="green">{tr('متطابق')}</Badge> : <Badge tone={s.pending ? 'amber' : 'red'}>{s.pending ? tr('بانتظار الترحيل') : tr('انحراف')}</Badge>}
              </p>
            </div>
          </div>
          {(s.refundedLinksWithoutRefund.length > 0 || s.cancelledOnlineWithoutRefund.length > 0) && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs space-y-1">
              <p className="font-semibold text-amber-900 flex items-center gap-1"><AlertTriangle size={13} />{tr('تفسير الفرق')}</p>
              {s.refundedLinksWithoutRefund.map(x => (
                <p key={x.linkId}>{tr('رابط مسترد بلا قيد استرداد في التسوية')} · <bdi className="font-mono">{x.linkId.slice(0, 8)}</bdi> · <MilliAmount value={x.amountMilli} decimals={decimals} /></p>
              ))}
              {s.cancelledOnlineWithoutRefund.map(x => (
                <p key={x.receiptId}>{tr('سند إلكتروني ملغى بلا استرداد (قيده على الحساب المعلّق)')} · <bdi>{x.number ?? x.receiptId.slice(0, 8)}</bdi> · <MilliAmount value={x.amountMilli} decimals={decimals} /></p>
              ))}
              <Link to={ledgerHref('review/checks')} className="text-[#E15A30] hover:underline">{tr('فحوصات السلامة')}</Link>
            </div>
          )}
        </div>
      )}

      <div className="flex gap-1 border-b border-[#E8E0D2]" role="tablist">
        {tabs.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={kind === t.key}
            className={`px-3 py-1.5 text-sm -mb-px border-b-2 ${kind === t.key ? 'border-[#E15A30] text-[#E15A30] font-semibold' : 'border-transparent text-[#6E6557] hover:text-[#1F1A13]'}`}
            onClick={() => { setKind(t.key); setState(initialLedgerListState()); }}>
            {t.label}
          </button>
        ))}
      </div>

      <LedgerListView<PaylinkEntryRow>
        title={tabs.find(t => t.key === kind)!.label}
        columns={columns}
        rows={q.data?.rows ?? []}
        total={q.data?.total ?? 0}
        loading={q.isLoading}
        fetching={q.isFetching}
        state={state}
        onStateChange={setState}
        onRowClick={r => { if (r.posting?.post?.moveId) navigate(ledgerHref(`entries/${r.posting.post.moveId}`)); }}
        emptyText={q.isError ? ledgerErrorMessage(tr, ledgerErrorOf(q.error)) : tr('لا صفوف')}
      />
    </div>
  );
}
