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
import { ledgerReviewApi, ledgerReviewKeys, type InvoicePostingRow, type PostingListParams } from '../../../api/ledgerReview';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';
import { ledgerHref } from '../routes';
import { NotActivatedNotice, postingFilterDefs, postingParamsOf } from './postingFilters';

/**
 * «العملاء ← الفواتير والمرتجعات» (M3، INV‑01، §8.2): الفواتير القائمة للقراءة مع حالة ترحيلها في الأستاذ
 * (INVOICE:<id>:POST/REVERSE)، ورابط القيد وقيد العكس. لا إنشاء ولا تعديل هنا: الفواتير تبقى في شاشتها التشغيلية.
 */

export default function InvoicePostingList() {
  const tr = useTr();
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const [state, setState] = useState<LedgerListState>(() => initialLedgerListState());
  const extras = useMemo(() => ({ customerId: sp.get('customerId') ?? undefined, salesRepId: sp.get('salesRepId') ?? undefined }), [sp]);

  const params: PostingListParams = useMemo(() => ({
    ...postingParamsOf(state.filters), ...extras, search: state.search || undefined, offset: state.offset, limit: state.limit,
  }), [state, extras]);
  const q = useQuery({
    queryKey: ledgerReviewKeys.invoices(params),
    queryFn: async () => (await ledgerReviewApi.customers.invoices(params)).data.data,
    placeholderData: keepPreviousData,
  });
  const decimals = q.data?.currencyDecimals ?? 2;

  const typeLabel = (t: string) => (t === 'CASH' ? tr('نقدية') : t === 'CREDIT' ? tr('آجلة') : t === 'RETURN' ? tr('مرتجع') : t);
  const statusLabel = (s: string) => (s === 'CANCELLED' ? tr('ملغاة') : s === 'DRAFT' ? tr('مسودة') : tr('مؤكدة'));

  const filters: LedgerFilterDef[] = [
    { key: 'type:CASH', label: tr('نقدية'), group: 'type' },
    { key: 'type:CREDIT', label: tr('آجلة'), group: 'type' },
    { key: 'type:RETURN', label: tr('مرتجع'), group: 'type' },
    { key: 'status:CONFIRMED', label: tr('مؤكدة'), group: 'status' },
    { key: 'status:CANCELLED', label: tr('ملغاة'), group: 'status' },
    ...postingFilterDefs(tr),
  ];

  const columns: LedgerColumn<InvoicePostingRow>[] = [
    { key: 'date', label: tr('التاريخ'), render: r => <span className="whitespace-nowrap">{formatDayOnly(r.date)}</span> },
    { key: 'number', label: tr('الرقم'), render: r => <bdi className="font-semibold tabular-nums">{r.number}</bdi> },
    { key: 'type', label: tr('النوع'), render: r => typeLabel(r.type) },
    { key: 'customer', label: tr('العميل'), render: r => r.customerName ?? '' },
    { key: 'rep', label: tr('المندوب'), render: r => r.salesRepName ?? '' },
    { key: 'tax', label: tr('الضريبة'), align: 'end', optional: true, render: r => <LedgerAmount value={r.taxAmt} decimals={decimals} colored={false} /> },
    { key: 'total', label: tr('الإجمالي'), align: 'end', render: r => <LedgerAmount value={r.type === 'RETURN' ? -r.total : r.total} decimals={decimals} /> },
    { key: 'status', label: tr('حالة المستند'), render: r => <span className={r.status === 'CANCELLED' ? 'text-[#C0392B]' : ''}>{statusLabel(r.status)}</span> },
    { key: 'posting', label: tr('حالة الترحيل'), render: r => <PostingBadge posting={r.posting} /> },
  ];

  return (
    <div className="space-y-3">
      {q.data && !q.data.activated && <NotActivatedNotice />}
      {q.data?.postingFilterCapped && (
        <p className="rounded-xl border border-[#F3D3C4] bg-[#FBEBE2] px-3 py-2 text-sm">{tr('نتائج فلتر حالة الترحيل مقتصرة على أحدث 5000 مستند؛ ضيّق نطاق التاريخ')}</p>
      )}
      <LedgerListView<InvoicePostingRow>
        title={tr('الفواتير والمرتجعات')}
        screen="customers/invoices"
        columns={columns}
        rows={q.data?.rows ?? []}
        total={q.data?.total ?? 0}
        loading={q.isLoading}
        fetching={q.isFetching}
        state={state}
        onStateChange={setState}
        filters={filters}
        onRowClick={r => { if (r.posting?.post?.moveId) navigate(ledgerHref(`entries/${r.posting.post.moveId}`)); }}
        emptyText={q.isError ? ledgerErrorMessage(tr, ledgerErrorOf(q.error)) : tr('لا توجد فواتير')}
      />
    </div>
  );
}
