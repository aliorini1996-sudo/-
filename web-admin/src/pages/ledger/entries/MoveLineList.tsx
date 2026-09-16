import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { formatDayOnly } from '../../../utils/format';
import { exportExcel } from '../../../utils/excel';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import {
  LedgerListView, initialLedgerListState, type LedgerAction, type LedgerColumn, type LedgerFilterDef,
  type LedgerGearAction, type LedgerGroupByDef, type LedgerListState, type LedgerRecordNavState,
} from '../../../components/ledger/LedgerListView';
import { ledgerConfigApi, ledgerErrorOf, ledgerKeys } from '../../../api/ledgerConfig';
import { ledgerMovesApi, ledgerMoveKeys, type MoveLineListParams, type MoveLineRow } from '../../../api/ledgerMoves';
import { ledgerHref } from '../routes';
import { ledgerErrorMessage } from '../../../lib/ledger/errors';

/**
 * بنود اليومية (JI‑01..05، `/items`): الحساب والبيان (بتلميح النص الكامل) ومدين ودائن والضريبة ومربع الإقرار
 * (vatBox) والتحليلي، وصف إجماليات من الخادم للفلاتر كلها، وفلتر «مُرحّل» افتراضي، والتصدير.
 * التحرير نفسه في شبكة نموذج القيد (MoveLinesGrid)؛ النقر يفتح القيد مع عدّاد السجلات بقيود الصفحة.
 * يقبل من الرابط `accountId` و`journalId` و`moveId` و`dateFrom` و`dateTo` و`state`.
 */

const FILTER_PARAMS: Record<string, { param: keyof MoveLineListParams; value: string }> = {
  posted: { param: 'state', value: 'POSTED' },
  draft: { param: 'state', value: 'DRAFT' },
  base: { param: 'taxRole', value: 'BASE' },
  tax: { param: 'taxRole', value: 'TAX' },
  marker: { param: 'taxRole', value: 'MARKER' },
};

function filtersToParams(keys: readonly string[]): MoveLineListParams {
  const lists: Record<string, string[]> = {};
  for (const k of keys) {
    const f = FILTER_PARAMS[k];
    if (f) (lists[f.param] ??= []).push(f.value);
  }
  return Object.fromEntries(Object.entries(lists).map(([p, v]) => [p, v.join(',')])) as MoveLineListParams;
}

const URL_EXTRAS = ['accountId', 'journalId', 'moveId', 'dateFrom', 'dateTo', 'taxId', 'vatBox', 'customerId', 'vendorId', 'salesRepId'] as const;
type UrlExtras = Partial<Record<(typeof URL_EXTRAS)[number], string>>;

export default function MoveLineList() {
  const tr = useTr();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const urlState = sp.get('state');
  const [state, setState] = useState<LedgerListState>(() => initialLedgerListState({
    filters: urlState ? urlState.split(',').map(s => (s === 'DRAFT' ? 'draft' : s === 'POSTED' ? 'posted' : '')).filter(Boolean) : ['posted'],
  }));
  const touched = useRef(!!urlState);
  const [extras, setExtras] = useState<UrlExtras>(() => Object.fromEntries(URL_EXTRAS.map(k => [k, sp.get(k) ?? undefined]).filter(([, v]) => v)));

  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data, staleTime: 60_000 });
  // قبل التفعيل لا بنود مرحّلة: الافتراضي «مسودة» ما لم يغيّره المستخدم
  useEffect(() => {
    if (statusQ.data && !statusQ.data.activatedAt && !touched.current) {
      touched.current = true;
      setState(s => ({ ...s, filters: s.filters.filter(f => f !== 'posted').concat(s.filters.includes('draft') ? [] : ['draft']) }));
    }
  }, [statusQ.data]);
  const decimals = statusQ.data?.currencyDecimals ?? 2;

  const params: MoveLineListParams = useMemo(() => ({
    ...filtersToParams(state.filters), ...extras, search: state.search || undefined, offset: state.offset, limit: state.limit,
  }), [state, extras]);

  const q = useQuery({
    queryKey: ledgerMoveKeys.items(params),
    queryFn: async () => (await ledgerMovesApi.items.list(params)).data.data,
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;

  const clearExtras = () => {
    setExtras({});
    const next = new URLSearchParams(sp);
    for (const k of [...URL_EXTRAS, 'state']) next.delete(k);
    setSp(next, { replace: true });
  };

  const filters: LedgerFilterDef[] = [
    { key: 'posted', label: tr('مُرحّل'), group: 'state' },
    { key: 'draft', label: tr('مسودة'), group: 'state' },
    { key: 'base', label: tr('سطور خاضعة للضريبة'), group: 'tax' },
    { key: 'tax', label: tr('سطور الضريبة'), group: 'tax' },
    { key: 'marker', label: tr('علامات وعاء الضريبة'), group: 'tax' },
  ];

  const groupBys: LedgerGroupByDef<MoveLineRow>[] = [
    { key: 'account', label: tr('الحساب'), value: r => `${r.account.code} ${r.account.name}` },
    { key: 'journal', label: tr('الدفتر'), value: r => `${r.journal.code} ${r.journal.name}` },
    { key: 'partner', label: tr('الشريك'), value: r => r.partnerName ?? '' },
    { key: 'month', label: tr('الشهر'), value: r => r.date.slice(0, 7) },
    { key: 'vatBox', label: tr('مربع الإقرار'), value: r => r.vatBox ?? '' },
  ];

  const columns: LedgerColumn<MoveLineRow>[] = [
    { key: 'date', label: tr('التاريخ'), render: r => <span className="whitespace-nowrap">{formatDayOnly(r.date)}</span> },
    {
      key: 'move', label: tr('القيد'),
      render: r => (r.moveNumber ? <bdi className="tabular-nums font-semibold">{r.moveNumber}</bdi> : <span className="text-[#9A8F7E]">{tr('(مسودة)')}</span>),
    },
    { key: 'journal', label: tr('الدفتر'), render: r => <bdi className="text-[#6E6557]">{r.journal.code}</bdi> },
    {
      key: 'account', label: tr('الحساب'),
      render: r => <span className="whitespace-nowrap"><bdi className="tabular-nums text-[#6E6557]">{r.account.code}</bdi> {r.account.name}</span>,
    },
    { key: 'partner', label: tr('الشريك'), render: r => r.partnerName ?? '' },
    // JI‑05: تلميح النص الكامل للبيان
    { key: 'label', label: tr('البيان'), render: r => <span className="block max-w-[16rem] truncate" title={r.label ?? undefined}>{r.label ?? ''}</span> },
    { key: 'debit', label: tr('مدين'), align: 'end', render: r => <LedgerAmount value={r.debit} decimals={decimals} blankZero colored={false} /> },
    { key: 'credit', label: tr('دائن'), align: 'end', render: r => <LedgerAmount value={r.credit} decimals={decimals} blankZero colored={false} /> },
    { key: 'tax', label: tr('الضريبة'), optional: true, defaultVisible: true, render: r => r.taxName ?? '' },
    // JI‑04: عمود «شبكات الضرائب»
    { key: 'vatBox', label: tr('مربع الإقرار'), optional: true, defaultVisible: true, render: r => (r.vatBox ? <bdi>{r.vatBox}</bdi> : '') },
    { key: 'ref', label: tr('المرجع'), optional: true, render: r => r.moveRef ?? '' },
    { key: 'balance', label: tr('الرصيد'), optional: true, align: 'end', render: r => <LedgerAmount value={r.balance} decimals={decimals} /> },
    { key: 'taxBase', label: tr('وعاء الضريبة'), optional: true, align: 'end', render: r => (r.taxBase !== null ? <LedgerAmount value={r.taxBase} decimals={decimals} /> : '') },
    { key: 'analytic', label: tr('التحليلي'), optional: true, render: r => (r.analyticAccountId ? <bdi>{r.analyticAccountId.slice(0, 8)}</bdi> : '') },
    { key: 'dueDate', label: tr('تاريخ الاستحقاق'), optional: true, render: r => (r.dueDate ? formatDayOnly(r.dueDate) : '') },
  ];

  const exportItems = async (input: { ids?: string[] }) => {
    const t = toast.loading(tr('جاري التصدير...'));
    try {
      const filtersNow = { ...filtersToParams(state.filters), ...extras, search: state.search || undefined };
      const res = await ledgerMovesApi.lists.export<MoveLineRow>('items', input.ids ? { ids: input.ids } : { filters: filtersNow });
      const out = res.data.data.rows.map(r => ({
        [tr('التاريخ')]: r.date,
        [tr('القيد')]: r.moveNumber ?? '',
        [tr('الدفتر')]: r.journal.code,
        [tr('الحساب')]: `${r.account.code} ${r.account.name}`,
        [tr('الشريك')]: r.partnerName ?? '',
        [tr('البيان')]: r.label ?? '',
        [tr('مدين')]: r.debit,
        [tr('دائن')]: r.credit,
        [tr('الرصيد')]: r.balance,
        [tr('الضريبة')]: r.taxName ?? '',
        [tr('مربع الإقرار')]: r.vatBox ?? '',
        [tr('المرجع')]: r.moveRef ?? '',
      }));
      await exportExcel([{ name: tr('بنود اليومية'), rows: out }], `journal-items-${new Date().toISOString().slice(0, 10)}`);
      toast.success(tr('تم التصدير'), { id: t });
    } catch (err) {
      const e = ledgerErrorOf(err);
      toast.error(ledgerErrorMessage(tr, e), { id: t });
    }
  };

  const bulkActions: LedgerAction[] = [{ label: tr('تصدير'), perm: 'canViewLedger', run: ids => exportItems({ ids }) }];
  const gearActions: LedgerGearAction[] = [{ label: tr('تصدير الكل'), perm: 'canViewLedger', run: () => exportItems({}) }];

  // فتح القيد: عدّاد السجلات بقيود الصفحة الحالية (بلا تكرار)
  const openRow = (row: MoveLineRow) => {
    const moveIds = [...new Set(rows.map(r => r.moveId))];
    const nav: LedgerRecordNavState = { ledgerIds: moveIds, ledgerListPath: window.location.pathname + window.location.search };
    navigate(ledgerHref(`entries/${row.moveId}`), { state: nav });
  };

  const extraChips = Object.entries(extras).filter(([, v]) => v);

  return (
    <div className="space-y-3">
      {extraChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-[#6E6557]">{tr('فلاتر من الرابط')}:</span>
          {extraChips.map(([k, v]) => (
            <span key={k} className="rounded-md bg-[#F1EBDF] px-1.5 py-0.5"><bdi>{k}</bdi>: <bdi>{k.startsWith('date') ? formatDayOnly(v as string) : v}</bdi></span>
          ))}
          <button type="button" onClick={clearExtras} className="inline-flex items-center gap-0.5 text-[#E15A30] hover:underline"><X size={12} />{tr('مسح')}</button>
        </div>
      )}

      <LedgerListView<MoveLineRow>
        title={tr('بنود اليومية')}
        screen="items"
        columns={columns}
        rows={rows}
        total={q.data?.total ?? 0}
        loading={q.isLoading}
        fetching={q.isFetching}
        state={state}
        onStateChange={s => { touched.current = true; setState(s); }}
        filters={filters}
        groupBys={groupBys}
        bulkActions={bulkActions}
        gearActions={gearActions}
        onRowClick={openRow}
        views={[{ key: 'list', label: tr('قائمة') }]}
        view="list"
        emptyText={q.isError ? ledgerErrorMessage(tr, ledgerErrorOf(q.error)) : tr('لا توجد بنود')}
        rowClassName={r => (r.posted ? '' : 'text-[#6E6557]')}
        footer={totals ? (
          // JI‑03: صف الإجماليات لكل الفلاتر (لا للصفحة وحدها)
          <tr className="bg-[#F7F2EA] font-semibold">
            <td colSpan={99} className="!p-0">
              <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 px-3 py-2 text-sm">
                <span>{tr('الإجمالي')}</span>
                <span className="inline-flex items-center gap-1.5"><span className="text-[#6E6557] font-normal">{tr('مدين')}</span><LedgerAmount value={totals.debit} decimals={decimals} colored={false} /></span>
                <span className="inline-flex items-center gap-1.5"><span className="text-[#6E6557] font-normal">{tr('دائن')}</span><LedgerAmount value={totals.credit} decimals={decimals} colored={false} /></span>
                <span className="inline-flex items-center gap-1.5"><span className="text-[#6E6557] font-normal">{tr('الرصيد')}</span><LedgerAmount value={totals.balance} decimals={decimals} /></span>
              </div>
            </td>
          </tr>
        ) : undefined}
      />
    </div>
  );
}
