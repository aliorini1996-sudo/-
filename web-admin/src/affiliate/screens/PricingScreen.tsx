// ============================================================================
// «الباقات والأسعار» — ما يعرضه السفير على المنشآت.
// الأسعار من الخادم (كتالوج الأسعار المعتمد + الخصم الإقليميّ لسفير اليمن)، والأسماء
// والحدود من القاموس بلغة العرض. كل الأسعار شاملة الضريبة.
// ============================================================================
import { BadgePercent, Info } from 'lucide-react';
import { affiliateApi, qk } from '../api';
import { formatRate } from '../format';
import { useAxT, type AxKey } from '../i18n';
import type { MeResponse, PricingPackageId } from '../types';
import { ErrorBox, Loading, Money, SectionTitle } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void }

const PKG_KEYS: Record<PricingPackageId, { name: AxKey; limit: AxKey }> = {
  starter: { name: 'pricing.starter', limit: 'pricing.starterLimit' },
  growth: { name: 'pricing.growth', limit: 'pricing.growthLimit' },
  pro: { name: 'pricing.pro', limit: 'pricing.proLimit' },
};

function PriceLine({ label, h, listH, discounted }: { label: string; h: number; listH: number; discounted: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[12.5px] text-[#6E6557]">{label}</span>
      <span className="flex items-baseline gap-2">
        {discounted && <Money h={listH} className="text-[11.5px] text-[#9A8F7E] line-through" />}
        <Money h={h} className="text-[16px] font-bold text-[#1F1A13]" />
      </span>
    </div>
  );
}

export function PricingTab({ me, refreshMe }: TabProps) {
  const { t, rich } = useAxT();
  const pricing = useAxQuery(qk.pricing, affiliateApi.pricing, refreshMe);

  if (pricing.isLoading) return <Loading />;
  if (pricing.isError || !pricing.data) return <ErrorBox err={pricing.error} onRetry={() => void pricing.refetch()} />;

  const p = pricing.data;
  const discounted = p.discountPct > 0;

  return (
    <div className="space-y-5">
      <SectionTitle>{t('pricing.title')}</SectionTitle>

      {discounted && (
        <div className="rounded-2xl border border-[#2F7A4B]/30 bg-[#EAF5EE] p-3.5 flex gap-2.5 text-[13px] text-[#1F5C38] leading-relaxed">
          <BadgePercent size={18} className="shrink-0 mt-0.5" />
          <p>{rich('pricing.regionBanner', { pct: <b><bdi dir="ltr">{p.discountPct}%</bdi></b> })}</p>
        </div>
      )}

      <div className="space-y-3">
        {p.packages.map((pkg) => {
          const keys = PKG_KEYS[pkg.id];
          if (!keys) return null;
          return (
            <div key={pkg.id} className="bg-white rounded-2xl border border-[#E9E1D3] p-4">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <p className="font-bold text-[15px] text-[#1F1A13]">{t(keys.name)}</p>
                  <p className="text-[12px] text-[#9A8F7E] mt-0.5">{t(keys.limit)}</p>
                </div>
                {discounted && (
                  <span className="shrink-0 text-[11px] font-bold bg-[#E15A30] text-white rounded-full px-2 py-0.5">
                    <bdi dir="ltr">-{p.discountPct}%</bdi>
                  </span>
                )}
              </div>
              <div className="space-y-1.5 border-t border-[#F1EBDF] pt-3">
                <PriceLine label={t('pricing.monthly')} h={pkg.monthlyHalalas} listH={pkg.listMonthlyHalalas} discounted={discounted} />
                <PriceLine label={t('pricing.yearly')} h={pkg.yearlyHalalas} listH={pkg.listYearlyHalalas} discounted={discounted} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-2xl border border-[#E9E1D3] bg-white p-3.5 flex gap-2.5 text-[12.5px] text-[#44403a] leading-relaxed">
        <Info size={16} className="shrink-0 mt-0.5 text-[#E15A30]" />
        <div className="space-y-1">
          <p>{t('pricing.vatNote')}</p>
          <p>{rich('pricing.commissionNote', { rate: <b><bdi dir="ltr">{formatRate(me.settings.rateBps)}</bdi></b> })}</p>
        </div>
      </div>
    </div>
  );
}
