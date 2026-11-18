// ============================================================================
// «شركاتي» — المنشآت المُسندة إليك: الطريقة (رابط/رمز/ترشيح/حساب تجريبي/إداري) والحالة
// والعمولة. بطاقاتٌ على الجوال وجدولٌ على الحاسوب (ui.DataList)، وفي أعلاها مدخل
// «مطالبة بإحالة فائتة» لشركةٍ سجّلت دون رابطك (V2_SPEC §7).
// ============================================================================
import { SearchCheck, ChevronLeft, ChevronRight } from 'lucide-react';
import { affiliateApi, qk } from '../api';
import { daysLabel, daysUntil, formatDay } from '../format';
import { useAxT } from '../i18n';
import {
  ACTIVATION, COMMISSION_STATUS, COMPANY_METHOD, COMPANY_STATUS, companyMethod, labelOf, textOf,
} from '../labels';
import type { Tab } from '../nav';
import type { CompanyRow, MeResponse } from '../types';
import { Badge, DataList, Empty, ErrorBox, Loading, Money, SectionTitle } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void; openTab: (t: Tab) => void }

export function CompaniesTab({ refreshMe, openTab }: TabProps) {
  const { t, lang, dir } = useAxT();
  const q = useAxQuery(qk.companies, affiliateApi.companies, refreshMe);
  const day = (v: string | null | undefined) => formatDay(v, lang);
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  /** سطر العمولة: محجوزة حتى… · انتهى الحجز · تاريخ الاستحقاق */
  const commissionNote = (c: CompanyRow) => {
    if (!c.commission) return null;
    if (c.commission.status === 'pending') {
      const left = daysUntil(c.commission.eligibleAt);
      return left > 0
        ? t('companies.eligibleIn', { date: day(c.commission.eligibleAt), days: daysLabel(left, lang) })
        : t('companies.holdEnded', { date: day(c.commission.eligibleAt) });
    }
    return t('companies.dueDate', { date: day(c.commission.eligibleAt) });
  };

  return (
    <div className="space-y-4">
      <SectionTitle>{t('tab.companies')}</SectionTitle>

      <button
        type="button" onClick={() => openTab('missed')}
        className="w-full flex items-center gap-3 rounded-2xl border border-dashed border-[#E15A30]/50 bg-[#FBEBE2]/40 px-3.5 py-3 text-start hover:bg-[#FBEBE2]/70"
      >
        <span className="w-9 h-9 rounded-xl bg-white text-[#E15A30] flex items-center justify-center shrink-0"><SearchCheck size={18} /></span>
        <span className="flex-1 min-w-0 text-[13px] font-semibold text-[#7A3A20] leading-snug">{t('companies.missedCta')}</span>
        <Chevron size={16} className="shrink-0 text-[#E15A30]" />
      </button>

      {q.isLoading ? <Loading /> : q.isError || !q.data ? (
        <ErrorBox err={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <Empty title={t('companies.empty')} hint={t('companies.emptyHint')} />
      ) : (
        <DataList<CompanyRow>
          rows={q.data}
          rowKey={(c) => c.id}
          head={{ id: 'company', label: t('companies.company'), cell: (c) => c.tenantName }}
          status={{
            id: 'status', label: t('companies.status'),
            cell: (c) => (
              <span className="inline-flex flex-col items-end gap-1">
                {/* حسابٌ فتحه السفير من البوابة: هل اختار مسؤوله كلمة مروره بعد؟ (المسحوب بلا تفعيل) */}
                {c.source === 'portal' && c.activation && c.status !== 'void' && <Badge value={labelOf(ACTIVATION, c.activation, lang)} />}
                <Badge value={labelOf(COMPANY_STATUS, c.status, lang)} />
              </span>
            ),
          }}
          cols={[
            { id: 'method', label: t('companies.method'), cell: (c) => textOf(COMPANY_METHOD, companyMethod(c), lang) },
            { id: 'signedUp', label: t('companies.signedUp'), cell: (c) => day(c.signedUpAt) },
            {
              id: 'commission', label: t('companies.commission'), numeric: true,
              cell: (c) => (c.commission
                ? <span className="inline-flex items-center gap-1.5"><Money h={c.commission.commissionHalalas} className="font-bold text-[#1F1A13]" /><Badge value={labelOf(COMMISSION_STATUS, c.commission.status, lang)} /></span>
                : '—'),
            },
          ]}
          footer={(c) => {
            const note = commissionNote(c);
            const pay = c.firstPaidAt
              ? t('companies.firstPaid', { date: day(c.firstPaidAt) })
              : c.status === 'trial' ? t('companies.payBefore', { date: day(c.firstPaymentDeadline) }) : null;
            if (!note && !pay) return null;
            return (
              <p className="text-[11.5px] text-[#8A8072] leading-relaxed">
                {[pay, note].filter(Boolean).join(' · ')}
              </p>
            );
          }}
        />
      )}
    </div>
  );
}
