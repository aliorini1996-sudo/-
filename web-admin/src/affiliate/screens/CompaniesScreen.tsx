// ============================================================================
// «شركاتي» — المنشآت المُسندة إليك وحالة اشتراكها وعمولتها.
// ============================================================================
import { affiliateApi, qk } from '../api';
import { daysLabel, daysUntil, formatDay } from '../format';
import { COMMISSION_STATUS, COMPANY_SOURCE, COMPANY_STATUS, labelOf, textOf } from '../labels';
import type { MeResponse } from '../types';
import { Badge, Empty, ErrorBox, Loading, Money, SectionTitle } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void }

export function CompaniesTab({ refreshMe }: TabProps) {
  const q = useAxQuery(qk.companies, affiliateApi.companies, refreshMe);

  return (
    <div>
      <SectionTitle>شركاتي</SectionTitle>
      {q.isLoading ? <Loading /> : q.isError || !q.data ? (
        <ErrorBox err={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <Empty title="لا منشآت مُسندة إليك بعد" hint="حين تسجّل منشأة عبر رابطك أو رمزك، أو يُعتمد ترشيحك وتشترك، تظهر هنا." />
      ) : (
        <div className="space-y-2.5">
          {q.data.map((c) => {
            const pendingDays = c.commission?.status === 'pending' ? daysUntil(c.commission.eligibleAt) : 0;
            return (
              <div key={c.id} className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-[14.5px] text-[#1F1A13] break-words">{c.tenantName}</p>
                    <p className="text-[12px] text-[#6E6557] mt-0.5">{textOf(COMPANY_SOURCE, c.source)} · {formatDay(c.signedUpAt)}</p>
                  </div>
                  <Badge value={labelOf(COMPANY_STATUS, c.status)} />
                </div>

                <div className="mt-2.5 space-y-1 text-[12.5px] text-[#44403a]">
                  {c.firstPaidAt ? (
                    <p>أول دفعة: {formatDay(c.firstPaidAt)}</p>
                  ) : c.status === 'trial' ? (
                    <p className="text-[#8A8072]">تُحتسب العمولة إن دفعت قبل {formatDay(c.firstPaymentDeadline)}</p>
                  ) : null}
                </div>

                {c.commission && (
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#FAF7F0] px-3 py-2">
                    <span className="text-[12.5px] text-[#6E6557]">
                      العمولة <Money h={c.commission.commissionHalalas} className="font-bold text-[#1F1A13]" />
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge value={labelOf(COMMISSION_STATUS, c.commission.status)} />
                    </span>
                    <span className="w-full text-[11.5px] text-[#8A8072]">
                      {c.commission.status === 'pending'
                        ? pendingDays > 0
                          ? `تصبح قابلة للاعتماد في ${formatDay(c.commission.eligibleAt)} (بعد ${daysLabel(pendingDays)})`
                          : `انتهت فترة الحجز في ${formatDay(c.commission.eligibleAt)} — بانتظار المراجعة`
                        : `تاريخ الاستحقاق ${formatDay(c.commission.eligibleAt)}`}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
