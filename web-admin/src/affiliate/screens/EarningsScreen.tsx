// ============================================================================
// «أرباحي» (V2_SPEC §7) — العمولات (الشركة، مبلغ الدفعة، النسبة، العمولة، «محجوزة حتى»،
// الحالة) + التعديلات + **التسويات** (الفترة، العمولات، التعديلات، الصافي، تاريخ التحويل،
// الحالة: قيد المعالجة / مدفوعة / فشل التحويل + السبب) + «التسوية القادمة».
// «شاملة الضريبة» وصفٌ لمبلغ **دفعة المنشأة** وحده (أساس العمولة بقرار المالك)، لا للعمولة.
// ============================================================================
import { CalendarClock, Info, AlertTriangle } from 'lucide-react';
import { affiliateApi, qk } from '../api';
import { dashboardView } from '../dashboard';
import {
  daysLabel, daysUntil, formatDay, formatRate, formatSar, maskedIban, periodLabel, SETTLEMENT_EVERY_DAYS,
} from '../format';
import { useAxT } from '../i18n';
import { ADJUSTMENT_KIND, COMMISSION_STATUS, PAYOUT_STATUS, labelOf, textOf } from '../labels';
import type { Tab } from '../nav';
import type { CommissionRow, MeResponse, PayoutRow } from '../types';
import { Badge, DataList, Empty, ErrorBox, Loading, Money, SectionTitle } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void; openTab: (t: Tab) => void }

export function EarningsTab({ me, refreshMe, openTab }: TabProps) {
  const { t, rich, lang } = useAxT();
  const commissions = useAxQuery(qk.commissions, affiliateApi.commissions, refreshMe);
  const adjustments = useAxQuery(qk.adjustments, affiliateApi.adjustments, refreshMe);
  const payouts = useAxQuery(qk.payouts, affiliateApi.payouts, refreshMe);
  const dash = useAxQuery(qk.dashboard, affiliateApi.dashboard, refreshMe);
  const s = me.settings;
  const day = (v: string | null | undefined) => formatDay(v, lang);
  const every = daysLabel(s.settlementEveryDays || SETTLEMENT_EVERY_DAYS, lang);
  const min = formatSar(s.minPayoutHalalas, lang);
  const status = (k: 'pending' | 'approved' | 'paid') => <b>{labelOf(COMMISSION_STATUS, k, lang).label}</b>;
  const next = dash.data ? dashboardView(dash.data, s.nextSettlementAt ?? null).nextSettlementAt : s.nextSettlementAt ?? null;
  // الملغاة لا تُعرض للسفير (الخادم يُخفيها أصلاً — احتياطٌ لخادمٍ أقدم)
  const shownPayouts = (payouts.data ?? []).filter((p) => p.status !== 'void');

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-white border border-[#E9E1D3] p-3.5 flex gap-3 items-start">
        <span className="w-10 h-10 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center shrink-0"><CalendarClock size={19} /></span>
        <div className="min-w-0 flex-1">
          {next && <p className="text-[15px] font-bold text-[#1F1A13]">{t('settle.next', { date: day(next) })}</p>}
          <p className="text-[12px] text-[#6E6557] leading-relaxed">{t('settle.every', { every, min })}</p>
          {dash.data && (
            <div className="mt-2.5 grid grid-cols-3 gap-2">
              {([
                ['stat.pending', dash.data.pendingHalalas],
                ['stat.approved', dash.data.approvedHalalas],
                ['stat.paidCommissions', dash.data.paidHalalas],
              ] as const).map(([k, h]) => (
                <div key={k} className="rounded-xl bg-[#FAF7F0] px-2 py-1.5 min-w-0">
                  <p className="text-[10.5px] text-[#6E6557] truncate">{t(k)}</p>
                  <Money h={h} className="text-[13px] font-bold text-[#1F1A13]" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-[#E9E1D3] bg-white p-3.5 flex gap-2.5 text-[12.5px] text-[#44403a] leading-relaxed">
        <Info size={16} className="shrink-0 mt-0.5 text-[#E15A30]" />
        <div className="space-y-1">
          <p>{rich('earn.info1', { pending: status('pending'), approved: status('approved'), days: daysLabel(s.holdDays, lang) })}</p>
          <p>{rich('earn.info2', { every, min, paid: status('paid') })}</p>
        </div>
      </div>

      <section>
        <SectionTitle>{t('earn.commissions')}</SectionTitle>
        {commissions.isLoading ? <Loading /> : commissions.isError || !commissions.data ? (
          <ErrorBox err={commissions.error} onRetry={() => void commissions.refetch()} />
        ) : commissions.data.length === 0 ? (
          <Empty title={t('earn.noCommissions')} hint={t('earn.noCommissionsHint')} />
        ) : (
          <DataList<CommissionRow>
            rows={commissions.data}
            rowKey={(c) => c.id}
            head={{ id: 'company', label: t('companies.company'), cell: (c) => c.tenantName }}
            status={{ id: 'status', label: t('companies.status'), cell: (c) => <Badge value={labelOf(COMMISSION_STATUS, c.status, lang)} /> }}
            cols={[
              { id: 'amount', label: t('earn.paymentAmount'), numeric: true, cell: (c) => <Money h={c.paymentAmountHalalas} /> },
              { id: 'rate', label: t('earn.rate'), numeric: true, cell: (c) => <bdi dir="ltr">{formatRate(c.rateBps)}</bdi> },
              { id: 'commission', label: t('companies.commission'), numeric: true, cell: (c) => <Money h={c.commissionHalalas} className="font-bold text-[#1F1A13]" /> },
              {
                id: 'held', label: t('earn.heldUntil'),
                cell: (c) => {
                  const left = c.status === 'pending' ? daysUntil(c.eligibleAt) : 0;
                  return left > 0 ? t('earn.holdEndValue', { date: day(c.eligibleAt), days: daysLabel(left, lang) }) : day(c.eligibleAt);
                },
              },
            ]}
            footer={(c) => {
              const bits = [
                c.paymentPaidAt ? `${t('earn.paymentDate')}: ${day(c.paymentPaidAt)}` : '',
                c.paidAt ? `${t('earn.paidOn')}: ${day(c.paidAt)}` : '',
              ].filter(Boolean);
              const refunded = (c.refundedHalalas ?? 0) > 0;
              if (!bits.length && !refunded && !c.reasonNote) return null;
              return (
                <div className="space-y-1.5 text-[11.5px] text-[#8A8072]">
                  {bits.length > 0 && <p>{bits.join(' · ')}</p>}
                  {refunded && <p>{t('earn.refunded')}: <Money h={c.refundedHalalas ?? 0} /></p>}
                  {c.reasonNote && (
                    <p className="rounded-xl bg-[#FAF7F0] px-3 py-2 text-[12.5px] text-[#44403a] leading-relaxed" style={{ whiteSpace: 'pre-wrap' }}>
                      <b className="text-[#6E6557]">{t('earn.note')}</b><span dir="auto">{c.reasonNote}</span>
                    </p>
                  )}
                </div>
              );
            }}
          />
        )}
      </section>

      <section>
        <SectionTitle>{t('settle.title')}</SectionTitle>
        {payouts.isLoading ? <Loading /> : payouts.isError || !payouts.data ? (
          <ErrorBox err={payouts.error} onRetry={() => void payouts.refetch()} />
        ) : shownPayouts.length === 0 ? (
          <Empty title={t('settle.empty')} hint={t('settle.emptyHint', { every, min })} />
        ) : (
          <DataList<PayoutRow>
            rows={shownPayouts}
            rowKey={(p) => p.id}
            head={{
              id: 'period', label: t('settle.period'),
              cell: (p) => (p.periodEnd ? periodLabel(p.periodStart, p.periodEnd, lang) : day(p.createdAt ?? p.transferredAt)),
            }}
            status={{ id: 'status', label: t('companies.status'), cell: (p) => <Badge value={labelOf(PAYOUT_STATUS, p.status, lang)} /> }}
            cols={[
              { id: 'commissions', label: t('earn.commissions'), numeric: true, cell: (p) => <Money h={p.commissionsHalalas} /> },
              { id: 'adjustments', label: t('earn.adjustments'), numeric: true, cell: (p) => <Money h={p.adjustmentsHalalas} /> },
              { id: 'net', label: t('settle.net'), numeric: true, cell: (p) => <Money h={p.netHalalas} className="font-bold text-[#1E7A52]" /> },
              { id: 'paidOn', label: t('settle.paidOn'), cell: (p) => (p.status === 'recorded' ? day(p.transferredAt) : '—') },
            ]}
            footer={(p) => {
              if (p.status === 'failed') {
                return (
                  <div role="status" className="rounded-xl bg-[#FBE3DF] text-[#8E2B20] px-3 py-2.5 text-[12.5px] leading-relaxed space-y-1.5">
                    <p className="flex gap-2"><AlertTriangle size={15} className="shrink-0 mt-0.5" /><span>{t('settle.failedHint')}</span></p>
                    {p.failedReason && (
                      <p><b>{t('status.reason')}: </b><span dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{p.failedReason}</span></p>
                    )}
                    <button type="button" className="btn-secondary py-1.5 px-3 text-[12.5px]" onClick={() => openTab('profile')}>{t('payout.title')}</button>
                  </div>
                );
              }
              return (
                <p className="text-[11.5px] text-[#8A8072]">
                  {t('earn.toAccount')}: <bdi dir="ltr">{maskedIban(p.ibanLast4)}</bdi>
                  {p.bankReference && <> · {t('earn.bankRef')}: <bdi dir="ltr" className="break-all">{p.bankReference}</bdi></>}
                </p>
              );
            }}
          />
        )}
      </section>

      <section>
        <SectionTitle>{t('earn.adjustments')}</SectionTitle>
        {adjustments.isLoading ? <Loading /> : adjustments.isError || !adjustments.data ? (
          <ErrorBox err={adjustments.error} onRetry={() => void adjustments.refetch()} />
        ) : adjustments.data.length === 0 ? (
          <Empty title={t('earn.noAdjustments')} />
        ) : (
          <div className="space-y-2">
            {adjustments.data.map((a) => (
              <div key={a.id} className="bg-white rounded-2xl border border-[#E9E1D3] px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-semibold text-[#1F1A13]">{textOf(ADJUSTMENT_KIND, a.kind, lang)}</span>
                  <Money h={a.amountHalalas} className="font-bold text-[14px]" />
                </div>
                <div className="flex items-center justify-between gap-2 mt-1 text-[11.5px] text-[#8A8072]">
                  <span>{day(a.createdAt)}</span>
                  <span>{a.settled ? t('earn.settled') : t('earn.nextPayout')}</span>
                </div>
                {a.note && <p className="mt-1.5 text-[12.5px] text-[#44403a]" dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{a.note}</p>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
