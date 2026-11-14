import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTr } from '../../../i18n/strings';
import {
  ledgerPartnersApi, ledgerPartnersKeys, productLedgerParams, productLedgerSearch, readProductLedgerState,
  type ProductLedgerColumns, type ProductLedgerState,
} from '../../../api/ledgerPartners';
import AttachmentLinks from './parts/AttachmentLinks';
import { Amount, DateField, PartnerPicker, PartnerReportFrame, TD, TH, dayText, qtyText } from './parts/PartnerReportParts';

/**
 * **تقرير الأصناف من الدفاتر** («ربط الدفاتر» L8، عقد §6.2): سطور الإيراد والخصم والمردودات ذات الصنف — يرحّلها الربط
 * (L4 ج) للدفاتر المربوطة صنفاً صنفاً بكميته بالوحدة الصغرى (Σ baseQty).
 *
 * «الصافي = الإيراد − الخصم − المردودات» لكل صنف، ومجموع الصافي = (411001 والفئات) − 412001 − 413001 على السطور ذات الصنف
 * (R6). الكمية المباعة تنقص بإلغاء الفاتورة، والمرتجعة تنقص بعكس المرتجع. فلترة بالصنف والعميل والمندوب، والتصدير XLSX وPDF.
 */
export default function ProductLedgerPage() {
  const tr = useTr();
  const [sp, setSp] = useSearchParams();
  const spString = sp.toString();
  const state = useMemo(() => readProductLedgerState(spString), [spString]);
  const setState = useCallback((next: ProductLedgerState) => setSp(new URLSearchParams(productLedgerSearch(next)), { replace: true }), [setSp]);

  const params = useMemo(() => productLedgerParams(state), [state]);
  const q = useQuery({
    queryKey: ledgerPartnersKeys.report('product-ledger', params),
    queryFn: async () => (await ledgerPartnersApi.report('product-ledger', params)).data.data,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const data = q.data;
  const decimals = data?.settings.currencyDecimals ?? 2;

  const controls = (
    <>
      <DateField label={tr('من')} value={state.from ?? data?.from} onChange={v => setState({ ...state, from: v })} />
      <DateField label={tr('إلى')} value={state.to ?? data?.to} onChange={v => setState({ ...state, to: v })} />
      <PartnerPicker
        type="product"
        value={state.productId ? { id: state.productId, name: state.productName } : null}
        onChange={p => setState({ ...state, productId: p?.id ?? null, productName: p?.name ?? null })}
        placeholder={tr('كل الأصناف — ابحث عن صنف')}
        ariaLabel={tr('الصنف')}
      />
      <PartnerPicker
        type="customer"
        value={state.customerId ? { id: state.customerId, name: state.customerName } : null}
        onChange={p => setState({ ...state, customerId: p?.id ?? null, customerName: p?.name ?? null })}
        placeholder={tr('كل العملاء — ابحث عن عميل')}
        ariaLabel={tr('العميل')}
      />
      {/* وثائق العميل المفلتر به («استديو العميل») — تُحمَّل عند الفتح وحده */}
      {state.customerId && <AttachmentLinks sourceType="CUSTOMER" sourceId={state.customerId} title={tr('وثائق العميل')} label={tr('وثائق العميل')} />}
      <PartnerPicker
        type="rep"
        value={state.salesRepId ? { id: state.salesRepId, name: state.salesRepName } : null}
        onChange={p => setState({ ...state, salesRepId: p?.id ?? null, salesRepName: p?.name ?? null })}
        placeholder={tr('كل المناديب — ابحث عن مندوب')}
        ariaLabel={tr('المندوب')}
      />
    </>
  );

  const cells = (r: ProductLedgerColumns, strong?: boolean) => (
    <>
      <td className={`${TD} text-end tabular-nums`}><bdi>{qtyText(r.soldQuantity)}</bdi></td>
      <td className={`${TD} text-end tabular-nums`}><bdi>{qtyText(r.returnedQuantity)}</bdi></td>
      <td className={`${TD} text-end tabular-nums ${strong ? 'font-semibold' : ''}`}><bdi>{qtyText(r.quantity)}</bdi></td>
      <td className={`${TD} text-end`}><Amount value={r.revenue} decimals={decimals} strong={strong} /></td>
      <td className={`${TD} text-end`}><Amount value={r.discount} decimals={decimals} blankZero={!strong} strong={strong} /></td>
      <td className={`${TD} text-end`}><Amount value={r.returns} decimals={decimals} blankZero={!strong} strong={strong} /></td>
      <td className={`${TD} text-end`}><Amount value={r.net} decimals={decimals} strong /></td>
    </>
  );

  return (
    <PartnerReportFrame
      reportKey="product-ledger"
      subtitle={data ? `${dayText(data.from)} — ${dayText(data.to)}` : undefined}
      controls={controls}
      exportParams={params}
      warnings={data?.warnings}
      error={q.isError ? q.error : null}
      loading={q.isLoading}
      fetching={q.isFetching}
    >
      <div className="overflow-x-auto rounded-xl border border-[#E8E0D2] bg-white">
        <table className="w-full text-xs">
          <thead className="bg-[#F1EBDF] text-[#6E6557]">
            <tr>
              <th scope="col" className={`${TH} text-start`}>{tr('الصنف')}</th>
              <th scope="col" className={`${TH} text-end`}>{tr('الكمية المباعة')}</th>
              <th scope="col" className={`${TH} text-end`}>{tr('الكمية المرتجعة')}</th>
              <th scope="col" className={`${TH} text-end`}>{tr('صافي الكمية')}</th>
              <th scope="col" className={`${TH} text-end`}>{tr('الإيراد')}</th>
              <th scope="col" className={`${TH} text-end`}>{tr('الخصم')}</th>
              <th scope="col" className={`${TH} text-end`}>{tr('المردودات')}</th>
              <th scope="col" className={`${TH} text-end`}>{tr('الصافي')}</th>
            </tr>
          </thead>
          <tbody>
            {!data || data.rows.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-[#9A8F7E]">{q.isLoading ? tr('جاري التحميل...') : tr('لا سطور أصناف في هذه الفترة')}</td></tr>
            ) : data.rows.map(r => (
              <tr key={r.productId} className="border-b border-[#F1EBDF]">
                <th scope="row" className={`${TD} text-start font-normal`}><bdi>{r.productName ?? r.productId}</bdi></th>
                {cells(r)}
              </tr>
            ))}
          </tbody>
          {data && data.rows.length > 0 && (
            <tfoot className="border-t-2 border-[#E8E0D2]">
              <tr className="bg-[#F1EBDF] font-semibold">
                <th scope="row" className={`${TD} text-start`}>{tr('الإجمالي')}</th>
                {cells(data.totals, true)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </PartnerReportFrame>
  );
}
