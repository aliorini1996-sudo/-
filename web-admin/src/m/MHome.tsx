import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DollarSign, CreditCard, ShoppingCart, TrendingUp, Users, AlertTriangle, Trophy, ChevronLeft } from 'lucide-react';
import { dashboardApi } from '../api/client';
import { DashboardStats, Invoice } from '../types';
import { formatCurrency } from '../utils/format';
import { useTr } from '../i18n/strings';
import { MCard, MStat, MRow, MError, MSpinner } from './mobileUi';
import { useIsLive, livePoll } from './useLiveQuery';
import { expectArray, expectObject } from './shape';

const MSalesChart = lazy(() => import('./MSalesChart'));

/**
 * الشاشة الرئيسية — نفس أرقام لوحة التحكم، بترتيب جوّاليّ.
 *
 * الفروق المقصودة عن نسخة سطح المكتب:
 *  - بطاقات عمودية `grid-cols-2` لا صفوفاً أفقية بأيقونة 48px (العرض ٣٦٠px).
 *  - «آخر الفواتير» و«أفضل العملاء/المناديب» **أزرارٌ تنقل**، لا نصّاً ميتاً:
 *    تطبيق «بإجراءات كاملة» لا يليق به طريق مسدود.
 *  - الاستطلاع مشروط بحياة الشاشة (بطارية وباقة).
 */
export default function MHome({ onOpenInvoice, onOpenCustomer }: {
  onOpenInvoice?: (inv: Invoice) => void;
  onOpenCustomer?: (id: string) => void;
}) {
  const tr = useTr();
  const live = useIsLive();

  const statsQ = useQuery({
    queryKey: ['m-dashboard'],
    queryFn: async () => expectObject<DashboardStats>((await dashboardApi.stats()).data?.data, 'لوحة التحكم'),
    refetchInterval: livePoll(60000, live),
  });

  const trendQ = useQuery({
    queryKey: ['m-sales-trend'],
    queryFn: async () => expectArray<{ date: string; total: number }>((await dashboardApi.salesTrend(30)).data?.data, 'مبيعات الشهر'),
  });

  if (statsQ.isLoading) return <MSpinner />;
  if (statsQ.isError || !statsQ.data) {
    return <MError onRetry={() => statsQ.refetch()} text={tr('تعذر تحميل بيانات لوحة التحكم')} />;
  }

  const d = statsQ.data;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-[#FAF7F0] p-3 space-y-3">
      {/* اليوم */}
      <Section title={tr('اليوم')}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat icon={DollarSign} label={tr('المبيعات')} value={formatCurrency(d.today.salesTotal)} />
          <MStat icon={CreditCard} label={tr('التحصيل')} value={formatCurrency(d.today.collectionsTotal)} tone="good" />
        </div>
        <p className="text-[11px] text-[#9A8F7E] px-1">
          {d.today.invoicesCount} {tr('فاتورة')} · {d.today.receiptsCount} {tr('سند')}
        </p>
      </Section>

      {/* الشهر */}
      <Section title={tr('هذا الشهر')}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat icon={ShoppingCart} label={tr('المبيعات')} value={formatCurrency(d.month.salesTotal)} />
          <MStat icon={TrendingUp} label={tr('التحصيل')} value={formatCurrency(d.month.collectionsTotal)} tone="good" />
        </div>
        <p className="text-[11px] text-[#9A8F7E] px-1">
          {d.month.invoicesCount} {tr('فاتورة')} · {d.month.receiptsCount} {tr('سند')}
        </p>
      </Section>

      {/* العملاء */}
      <Section title={tr('العملاء')}>
        <div className="grid grid-cols-3 gap-2.5">
          <MStat icon={Users} label={tr('نشطون')} value={String(d.customers.total)} />
          <MStat label={tr('بأرصدة')} value={String(d.customers.withBalance)} tone="warn" />
          <MStat icon={AlertTriangle} label={tr('تجاوز الحد')} value={String(d.customers.creditExceeded)}
            tone={d.customers.creditExceeded > 0 ? 'bad' : 'default'} />
        </div>
      </Section>

      {/* الرسم البياني — حزمة مستقلّة */}
      <Section title={tr('مبيعات آخر 30 يوم')}>
        <MCard className="p-2 pt-3">
          {trendQ.data && trendQ.data.length > 0 ? (
            <Suspense fallback={<div className="h-[170px] flex items-center justify-center text-xs text-[#9A8F7E]">{tr('جاري التحميل')}</div>}>
              <MSalesChart data={trendQ.data} />
            </Suspense>
          ) : (
            <div className="h-[120px] flex items-center justify-center text-xs text-[#9A8F7E]">
              {trendQ.isLoading ? tr('جاري التحميل') : tr('لا توجد بيانات')}
            </div>
          )}
        </MCard>
      </Section>

      {/* أفضل المناديب */}
      <Section title={tr('أفضل المناديب')} icon={Trophy}>
        <MCard>
          {d.topReps.length === 0 ? <Blank text={tr('لا توجد بيانات')} /> : d.topReps.slice(0, 5).map((r, i) => (
            <MRow key={r.id}
              leading={<Rank n={i + 1} />}
              title={r.name}
              subtitle={`${r.invoicesCount} ${tr('فاتورة')}`}
              trailing={<span className="text-sm font-bold text-[#E15A30] whitespace-nowrap">{formatCurrency(r.salesTotal)}</span>} />
          ))}
        </MCard>
      </Section>

      {/* أفضل العملاء */}
      <Section title={tr('أفضل العملاء')}>
        <MCard>
          {d.topCustomers.length === 0 ? <Blank text={tr('لا توجد بيانات')} /> : d.topCustomers.slice(0, 5).map((c, i) => (
            <MRow key={c.id}
              leading={<Rank n={i + 1} />}
              title={c.name}
              subtitle={`${tr('الرصيد')}: ${formatCurrency(c.balance)}`}
              onClick={onOpenCustomer ? () => onOpenCustomer(c.id) : undefined}
              trailing={
                <span className="flex items-center gap-1">
                  <span className="text-sm font-bold text-[#1F1A13] whitespace-nowrap">{formatCurrency(c.totalSales)}</span>
                  {onOpenCustomer && <ChevronLeft size={15} className="text-[#C9BFB0]" />}
                </span>
              } />
          ))}
        </MCard>
      </Section>

      {/* آخر الفواتير — أزرار تفتح المستند */}
      <Section title={tr('آخر الفواتير')}>
        <MCard>
          {d.recentInvoices.length === 0 ? <Blank text={tr('لا توجد فواتير')} /> : d.recentInvoices.slice(0, 6).map(inv => (
            <MRow key={inv.id}
              title={inv.number}
              subtitle={`${inv.customer?.name || '—'} · ${inv.salesRep?.name || tr('الإدارة')}`}
              onClick={onOpenInvoice ? () => onOpenInvoice(inv) : undefined}
              trailing={
                <span className="flex items-center gap-1">
                  <span className="text-sm font-bold text-[#1F1A13] whitespace-nowrap">{formatCurrency(inv.total)}</span>
                  {onOpenInvoice && <ChevronLeft size={15} className="text-[#C9BFB0]" />}
                </span>
              } />
          ))}
        </MCard>
      </Section>

      <div className="h-2" />
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon?: React.ElementType; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] font-bold text-[#9A8F7E] px-1 flex items-center gap-1.5 uppercase tracking-wide">
        {Icon && <Icon size={13} className="text-[#E0A02C]" />} {title}
      </h2>
      {children}
    </section>
  );
}

function Rank({ n }: { n: number }) {
  return (
    <span className="w-6 h-6 rounded-full bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center text-[11px] font-bold flex-shrink-0">
      {n}
    </span>
  );
}

function Blank({ text }: { text: string }) {
  return <p className="text-center text-xs text-[#9A8F7E] py-6">{text}</p>;
}
