// ============================================================================
// «أرباحي» — العمولات والتسويات والتحويلات.
// «شاملة الضريبة» وصفٌ لمبلغ **دفعة المنشأة** وحده (أساس العمولة بقرار المالك)،
// لا للعمولة نفسها.
// ============================================================================
import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { affiliateApi, qk } from '../api';
import { daysLabel, daysUntil, formatDay, formatRate, formatSar, maskedIban } from '../format';
import { ADJUSTMENT_KIND, COMMISSION_STATUS, PAYOUT_STATUS, labelOf, textOf } from '../labels';
import type { MeResponse } from '../types';
import { Badge, Empty, ErrorBox, Loading, Money, SectionTitle } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void }

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12.5px]">
      <span className="text-[#6E6557]">{k}</span>
      <span className="text-[#1F1A13] text-left">{children}</span>
    </div>
  );
}

export function EarningsTab({ me, refreshMe }: TabProps) {
  const commissions = useAxQuery(qk.commissions, affiliateApi.commissions, refreshMe);
  const adjustments = useAxQuery(qk.adjustments, affiliateApi.adjustments, refreshMe);
  const payouts = useAxQuery(qk.payouts, affiliateApi.payouts, refreshMe);
  const s = me.settings;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#E9E1D3] bg-white p-3.5 flex gap-2.5 text-[12.5px] text-[#44403a] leading-relaxed">
        <Info size={16} className="shrink-0 mt-0.5 text-[#E15A30]" />
        <div className="space-y-1">
          <p>
            تُنشأ العمولة <b>معلّقة</b> عند تأكيد أول دفعة للمنشأة، وتبقى محجوزة {s.holdDays} يوماً من تاريخ الدفع
            للتأكد من عدم استرداد المبلغ، ثم تُراجع وتصبح <b>معتمدة</b>.
          </p>
          <p>
            تُحوَّل المستحقات المعتمدة يدوياً إلى حسابك البنكي متى بلغ صافيها {formatSar(s.minPayoutHalalas)}، وتصبح <b>مدفوعة</b>.
            إن استُردّت دفعةٌ بعد تحويل عمولتها يُخصم مقدارها من دفعتك القادمة.
          </p>
        </div>
      </div>

      <section>
        <SectionTitle>العمولات</SectionTitle>
        {commissions.isLoading ? <Loading /> : commissions.isError || !commissions.data ? (
          <ErrorBox err={commissions.error} onRetry={() => void commissions.refetch()} />
        ) : commissions.data.length === 0 ? (
          <Empty title="لا عمولات بعد" hint="تظهر العمولة هنا حين تدفع منشأةٌ مُسندة إليك أول دفعة." />
        ) : (
          <div className="space-y-2.5">
            {commissions.data.map((c) => {
              const left = c.status === 'pending' ? daysUntil(c.eligibleAt) : 0;
              return (
                <div key={c.id} className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-[14.5px] text-[#1F1A13] break-words">{c.tenantName}</p>
                      <p className="text-[20px] font-bold text-[#1F1A13] mt-1"><Money h={c.commissionHalalas} /></p>
                    </div>
                    <Badge value={labelOf(COMMISSION_STATUS, c.status)} />
                  </div>
                  <div className="mt-2.5 space-y-1.5 border-t border-[#F1EBDF] pt-2.5">
                    <Row k="مبلغ الدفعة (شاملة الضريبة)"><Money h={c.paymentAmountHalalas} /></Row>
                    {(c.refundedHalalas ?? 0) > 0 && <Row k="مستردّ من الدفعة"><Money h={c.refundedHalalas ?? 0} /></Row>}
                    <Row k="النسبة"><bdi dir="ltr">{formatRate(c.rateBps)}</bdi></Row>
                    <Row k="تاريخ الدفع">{formatDay(c.paymentPaidAt)}</Row>
                    <Row k="نهاية فترة الحجز">
                      {formatDay(c.eligibleAt)}{left > 0 ? ` (بعد ${daysLabel(left)})` : ''}
                    </Row>
                    {c.paidAt && <Row k="حُوّلت في">{formatDay(c.paidAt)}</Row>}
                  </div>
                  {c.reasonNote && (
                    <p className="mt-2 rounded-xl bg-[#FAF7F0] px-3 py-2 text-[12.5px] text-[#44403a] leading-relaxed" style={{ whiteSpace: 'pre-wrap' }}>
                      <b className="text-[#6E6557]">ملاحظة: </b>{c.reasonNote}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>التسويات</SectionTitle>
        {adjustments.isLoading ? <Loading /> : adjustments.isError || !adjustments.data ? (
          <ErrorBox err={adjustments.error} onRetry={() => void adjustments.refetch()} />
        ) : adjustments.data.length === 0 ? (
          <Empty title="لا تسويات" />
        ) : (
          <div className="space-y-2">
            {adjustments.data.map((a) => (
              <div key={a.id} className="bg-white rounded-2xl border border-[#E9E1D3] px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-semibold text-[#1F1A13]">{textOf(ADJUSTMENT_KIND, a.kind)}</span>
                  <Money h={a.amountHalalas} className="font-bold text-[14px]" />
                </div>
                <div className="flex items-center justify-between gap-2 mt-1 text-[11.5px] text-[#8A8072]">
                  <span>{formatDay(a.createdAt)}</span>
                  <span>{a.settled ? 'سُوّيت في دفعة سابقة' : 'تُحتسب في دفعتك القادمة'}</span>
                </div>
                {a.note && <p className="mt-1.5 text-[12.5px] text-[#44403a]" style={{ whiteSpace: 'pre-wrap' }}>{a.note}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>التحويلات</SectionTitle>
        {payouts.isLoading ? <Loading /> : payouts.isError || !payouts.data ? (
          <ErrorBox err={payouts.error} onRetry={() => void payouts.refetch()} />
        ) : payouts.data.length === 0 ? (
          <Empty title="لا تحويلات بعد" />
        ) : (
          <div className="space-y-2.5">
            {payouts.data.map((p) => (
              <div key={p.id} className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[20px] font-bold text-[#1E7A52]"><Money h={p.netHalalas} /></p>
                  <Badge value={labelOf(PAYOUT_STATUS, p.status)} />
                </div>
                <div className="mt-2 space-y-1.5 border-t border-[#F1EBDF] pt-2.5">
                  <Row k="العمولات"><Money h={p.commissionsHalalas} /></Row>
                  {p.adjustmentsHalalas !== 0 && <Row k="التسويات"><Money h={p.adjustmentsHalalas} /></Row>}
                  <Row k="تاريخ التحويل">{formatDay(p.transferredAt ?? p.createdAt)}</Row>
                  {p.bankReference && <Row k="مرجع التحويل"><bdi dir="ltr" className="break-all">{p.bankReference}</bdi></Row>}
                  <Row k="إلى الحساب"><bdi dir="ltr">{maskedIban(p.ibanLast4)}</bdi></Row>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
