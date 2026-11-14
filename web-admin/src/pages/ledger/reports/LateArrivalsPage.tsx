import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTr } from '../../../i18n/strings';
import {
  ledgerPartnersApi, ledgerPartnersKeys, lateArrivalReasonLabels, rangeParams, readRangeState,
} from '../../../api/ledgerPartners';
import AttachmentLinks from './parts/AttachmentLinks';
import { Amount, DateField, MoveLink, PartnerReportFrame, SourceLink, TD, TH, dayText } from './parts/PartnerReportParts';

/**
 * **مستندات وصلت متأخرة (تقرير)** («ربط الدفاتر» L8، عقد §6.2 وB15): قيود آلية رُحّلت بغير تاريخ مستندها (ADR‑7) —
 * إمّا لأن تاريخه في فترة مقفلة فرُحّل بأول يوم مفتوح (PERIOD_LOCKED)، وإمّا لأنه قبل بداية الدفاتر وأُنشئ بعد لقطة البدء
 * (AFTER_CUTOVER). المصدر `GlMove.lateArrival` أو `originalDate ≠ date`، والمدى على تاريخ الترحيل.
 *
 * يكمّل قائمة «مراجعة ← مستندات وصلت متأخرة» (للمراجعة والتعليم): هنا تقريرٌ بالسبب والمبلغ والإجمالي يُصدَّر XLSX وPDF،
 * ومن كل صفّ رابط إلى القيد وإلى المستند المصدر ومرفقاته.
 */
export default function LateArrivalsPage() {
  const tr = useTr();
  const [sp, setSp] = useSearchParams();
  const spString = sp.toString();
  const state = useMemo(() => readRangeState(spString), [spString]);
  const setRange = useCallback((next: { from: string | null; to: string | null }) => setSp(new URLSearchParams(rangeParams(next) as Record<string, string>), { replace: true }), [setSp]);

  const params = useMemo(() => rangeParams(state), [state]);
  const q = useQuery({
    queryKey: ledgerPartnersKeys.report('late-arrivals', params),
    queryFn: async () => (await ledgerPartnersApi.report('late-arrivals', params)).data.data,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const data = q.data;
  const decimals = data?.settings.currencyDecimals ?? 2;
  const reasons = lateArrivalReasonLabels(tr) as Record<string, string>;

  const controls = (
    <>
      <DateField label={tr('من')} value={state.from ?? data?.from} onChange={v => setRange({ ...state, from: v })} />
      <DateField label={tr('إلى')} value={state.to ?? data?.to} onChange={v => setRange({ ...state, to: v })} />
      {data?.cutoverDate && <span className="text-xs text-[#6E6557]">{tr('بداية الدفاتر')}: <bdi>{dayText(data.cutoverDate)}</bdi></span>}
    </>
  );

  return (
    <PartnerReportFrame
      reportKey="late-arrivals"
      subtitle={data ? `${dayText(data.from)} — ${dayText(data.to)} · ${tr('حسب تاريخ الترحيل')}` : tr('حسب تاريخ الترحيل')}
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
              <th scope="col" className={`${TH} text-start`}>{tr('القيد')}</th>
              <th scope="col" className={`${TH} text-start`}>{tr('المستند')}</th>
              <th scope="col" className={`${TH} text-start`}>{tr('المرجع')}</th>
              <th scope="col" className={`${TH} text-start`}>{tr('الشريك')}</th>
              <th scope="col" className={`${TH} text-start`}>{tr('تاريخ المستند')}</th>
              <th scope="col" className={`${TH} text-start`}>{tr('تاريخ الترحيل')}</th>
              <th scope="col" className={`${TH} text-start`}>{tr('السبب')}</th>
              <th scope="col" className={`${TH} text-end`}>{tr('المبلغ')}</th>
              <th scope="col" className={`${TH} text-start`}>{tr('المرفقات')}</th>
            </tr>
          </thead>
          <tbody>
            {!data || data.rows.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-[#9A8F7E]">{q.isLoading ? tr('جاري التحميل...') : tr('لا مستندات وصلت متأخرة في هذه الفترة')}</td></tr>
            ) : data.rows.map(r => (
              <tr key={r.moveId} className="border-b border-[#F1EBDF]">
                <td className={`${TD} whitespace-nowrap`}><MoveLink moveId={r.moveId} number={r.moveNumber} /></td>
                <td className={TD}><SourceLink sourceType={r.sourceType} /></td>
                <td className={TD}><bdi>{r.ref ?? ''}</bdi></td>
                <td className={TD}><bdi>{r.partnerName ?? ''}</bdi></td>
                <td className={`${TD} whitespace-nowrap`}>{dayText(r.originalDate)}</td>
                <td className={`${TD} whitespace-nowrap`}>{dayText(r.postedDate)}</td>
                <td className={TD}>{reasons[r.reason] ?? r.reason}</td>
                <td className={`${TD} text-end`}><Amount value={r.amount} decimals={decimals} /></td>
                <td className={TD}><AttachmentLinks sourceType={r.sourceType} sourceId={r.sourceId} moveId={r.moveId} /></td>
              </tr>
            ))}
          </tbody>
          {data && data.rows.length > 0 && (
            <tfoot className="border-t-2 border-[#E8E0D2]">
              <tr className="bg-[#F1EBDF] font-semibold">
                <td className={TD} colSpan={7}>{tr('الإجمالي')} (<bdi className="tabular-nums">{data.count}</bdi>)</td>
                <td className={`${TD} text-end`}><Amount value={data.total} decimals={decimals} strong /></td>
                <td className={TD} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </PartnerReportFrame>
  );
}
