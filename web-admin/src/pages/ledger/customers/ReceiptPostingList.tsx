import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTr } from '../../../i18n/strings';
import { formatDayOnly } from '../../../utils/format';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import { PostingBadge } from '../../../components/ledger/SyncBadges';
import {
  LedgerListView, initialLedgerListState, type LedgerColumn, type LedgerFilterDef, type LedgerListState,
} from '../../../components/ledger/LedgerListView';
import { ledgerErrorOf } from '../../../api/ledgerConfig';
import { ledgerReviewApi, ledgerReviewKeys, type PostingListParams, type ReceiptPostingRow } from '../../../api/ledgerReview';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';
import { ledgerHref } from '../routes';
import { NotActivatedNotice, postingFilterDefs, postingParamsOf } from './postingFilters';

/**
 * «العملاء ← سندات القبض» (M3، INV‑01، §8.2): السندات القائمة للقراءة بطريقة القبض وحالة ترحيلها (RECEIPT:<id>:POST/REVERSE)،
 * والسند الإلكتروني برابطه (PAY‑01). الشاشة التشغيلية للتحصيل لا تتغير (D3).
 */

export default function ReceiptPostingList() {
  const tr = useTr();
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const [state, setState] = useState<LedgerListState>(() => initialLedgerListState());
  const extras = useMemo(() => ({ customerId: sp.get('customerId') ?? undefined, salesRepId: sp.get('salesRepId') ?? undefined }), [sp]);

  const params: PostingListParams = useMemo(() => ({
    ...postingParamsOf(state.filters), ...extras, search: state.search || undefined, offset: state.offset, limit: state.limit,
  }), [state, extras]);
  const q = useQuery({
    queryKey: ledgerReviewKeys.receipts(params),
    queryFn: async () => (await ledgerReviewApi.customers.receipts(params)).data.data,
    placeholderData: keepPreviousData,
  });
  const decimals = q.data?.currencyDecimals ?? 2;

  const methodLabels: Record<string, string> = {
    CASH: tr('نقدي'), BANK_TRANSFER: tr('تحويل بنكي'), POS: tr('شبكة'), CHEQUE: tr('شيك'), ONLINE: tr('دفع إلكتروني'),
  };

  const filters: LedgerFilterDef[] = [
    ...Object.entries(methodLabels).map(([k, label]) => ({ key: `method:${k}`, label, group: 'method' })),
    { key: 'status:ACTIVE', label: tr('نشط'), group: 'status' },
    { key: 'status:CANCELLED', label: tr('ملغى'), group: 'status' },
    ...postingFilterDefs(tr),
  ];

  const columns: LedgerColumn<ReceiptPostingRow>[] = [
    { key: 'date', label: tr('التاريخ'), render: r => <span className="whitespace-nowrap">{formatDayOnly(r.date)}</span> },
    { key: 'number', label: tr('الرقم'), render: r => <bdi className="font-semibold tabular-nums">{r.number}</bdi> },
    { key: 'method', label: tr('طريقة القبض'), render: r => methodLabels[r.paymentMethod] ?? r.paymentMethod },
    { key: 'customer', label: tr('العميل'), render: r => r.customerName ?? '' },
    { key: 'rep', label: tr('المندوب'), render: r => r.salesRepName ?? '' },
    { key: 'amount', label: tr('المبلغ'), align: 'end', render: r => <LedgerAmount value={r.amount} decimals={decimals} colored={false} /> },
    { key: 'status', label: tr('حالة المستند'), render: r => <span className={r.status === 'CANCELLED' ? 'text-[#C0392B]' : ''}>{r.status === 'CANCELLED' ? tr('ملغى') : tr('نشط')}</span> },
    { key: 'paylink', label: tr('رابط الدفع'), optional: true, render: r => (r.paylinkStatus ? <bdi className="font-mono text-[11px]">{r.paylinkStatus}</bdi> : '') },
    { key: 'posting', label: tr('حالة الترحيل'), render: r => <PostingBadge posting={r.posting} /> },
  ];

  return (
    <div className="space-y-3">
      {q.data && !q.data.activated && <NotActivatedNotice pending={q.data.total} />}
      {q.data?.postingFilterCapped && (
        <p className="rounded-xl border border-[#F3D3C4] bg-[#FBEBE2] px-3 py-2 text-sm">{tr('نتائج فلتر حالة الترحيل مقتصرة على أحدث 5000 مستند؛ ضيّق نطاق التاريخ')}</p>
      )}
      <LedgerListView<ReceiptPostingRow>
        title={tr('سندات القبض')}
        screen="customers/receipts"
        columns={columns}
        rows={q.data?.rows ?? []}
        total={q.data?.total ?? 0}
        loading={q.isLoading}
        fetching={q.isFetching}
        state={state}
        onStateChange={setState}
        filters={filters}
        onRowClick={r => { if (r.posting?.post?.moveId) navigate(ledgerHref(`entries/${r.posting.post.moveId}`)); }}
        emptyText={q.isError ? ledgerErrorMessage(tr, ledgerErrorOf(q.error)) : tr('لا توجد سندات')}
      />
    </div>
  );
}
