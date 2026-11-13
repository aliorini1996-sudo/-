import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search, Truck, ChevronLeft, AlertTriangle, Wallet } from 'lucide-react';
import { suppliersApi, type Supplier, type SupplierAging, type SupplierStatusFilter } from '../api/suppliers';
import { formatCurrency, formatNumber, getActiveCurrency } from '../utils/format';
import { currencyDecimals } from '../i18n/countries';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { MCard, MRow, MHeader, MStat, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';
import { useMTaxOff } from './mTaxMode';
import { agingSummary, balanceState } from './MSuppliersLogic';
import MSuppliersCard from './MSuppliersCard';

const PAGE = 50;

const STATUS_CHIPS: { id: SupplierStatusFilter; label: string }[] = [
  { id: 'active', label: 'النشطون' },
  { id: 'archived', label: 'المؤرشفون' },
  { id: 'all', label: 'الكل' },
];

/**
 * «الموردون» في تطبيق الإدارة — قسمٌ من الرئيسية بحارس «مخزون الشركة» نفسه (الصلاحية والمحاسبة والميزة)، فلا يُفتح لشركةٍ
 * يردّها فيها الخادم ٤٠٣.
 *
 * البحث على الخادم (الاسم والرمز والرقم الضريبي والجوال) لا على الصفحات المحمّلة، فيبلغ أيّ مورّد مهما طالت القائمة. والرصيد
 * بإشارته: موجبٌ مستحقٌّ له، وسالبٌ دفعةٌ مقدّمة — يُقال باسمه بجانب الرقم، فـ«−٥٠٠» وحدها تُقرأ ديناً.
 *
 * ورأس القائمة من تقرير الأعمار لا من الصفحة المعروضة: «المستحق للموردين» يجب أن يصف الشركة لا نتيجة بحثٍ عابرة.
 */
export default function MSuppliers({ company, onBack }: {
  /** إعدادات الشركة — لترويسة الكشف والسند المطبوعين وحدها */
  company?: unknown;
  onBack: () => void;
}) {
  const tr = useTr();
  const taxOff = useMTaxOff();
  const decimals = currencyDecimals(getActiveCurrency());
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [status, setStatus] = useState<SupplierStatusFilter>('active');
  const [open, setOpen] = useState<Supplier | null>(null);
  useBackClose(!!open, () => setOpen(null));

  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const listQ = useInfiniteQuery({
    queryKey: ['m-suppliers', 'list', status, dq],
    queryFn: async ({ pageParam }) => {
      const d = expectObject<{ items: unknown; total: unknown }>(
        (await suppliersApi.list({ search: dq || undefined, status, page: pageParam, limit: PAGE })).data?.data, 'الموردون');
      return { items: expectArray<Supplier>(d.items, 'الموردون'), total: Number(d.total) || 0 };
    },
    initialPageParam: 1,
    // صفحةٌ أخرى ما دام المحمَّل دون العدد الكلّي — وصفحةٌ فارغة توقف الطلب (لا حلقة على عددٍ تغيّر بين صفحتين)
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((s, p) => s + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? pages.length + 1 : undefined;
    },
  });
  const rows = useMemo(() => listQ.data?.pages.flatMap(p => p.items) ?? [], [listQ.data]);
  const total = listQ.data?.pages[0]?.total ?? 0;

  // ملخّص الشركة كلّها — فشله صامت: الرأس يغيب ولا تُحجب القائمة
  const agingQ = useQuery({
    queryKey: ['m-suppliers', 'aging'],
    queryFn: async () => expectObject<SupplierAging>((await suppliersApi.aging()).data?.data, 'أعمار الذمم'),
    staleTime: 60_000,
  });
  const summary = useMemo(
    () => (agingQ.data ? agingSummary(Array.isArray(agingQ.data.rows) ? agingQ.data.rows : [], decimals) : null),
    [agingQ.data, decimals]);

  if (open) return <MSuppliersCard supplier={open} company={company} onClose={() => setOpen(null)} />;

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('الموردون')} subtitle={tr('أرصدة الموردين وكشوف حساباتهم وسندات الصرف')} onBack={onBack} />

      <div className="flex-shrink-0 p-3 pb-2 space-y-2">
        <div className="relative">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
          <input value={q} onChange={e => setQ(e.target.value)} className="input ps-9 min-h-[44px]"
            placeholder={taxOff ? tr('ابحث بالاسم أو الرمز أو الجوال') : tr('ابحث بالاسم أو الرمز أو الرقم الضريبي أو الجوال')} />
        </div>
        <div className="flex gap-1.5">
          {STATUS_CHIPS.map(c => (
            <button key={c.id} type="button" onClick={() => setStatus(c.id)}
              className={`text-xs px-3 py-1.5 rounded-full border min-h-[32px] ${status === c.id ? 'bg-[#1F1A13] text-white border-[#1F1A13]' : 'bg-white text-[#6E6557] border-[#E9E1D3]'}`}>
              {tr(c.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3 space-y-3">
        {summary && (summary.owed > 0 || summary.overdue > 0 || summary.advance > 0) && (
          <section className="space-y-1.5">
            <div className="grid grid-cols-2 gap-2.5">
              <MStat icon={Wallet} label={tr('المستحق للموردين')} value={formatCurrency(summary.owed)} tone="warn" compact />
              <MStat icon={AlertTriangle} label={tr('متأخر السداد')} value={formatCurrency(summary.overdue)}
                tone={summary.overdue > 0 ? 'bad' : 'default'} compact />
            </div>
            {summary.advance > 0 && (
              <p className="text-[11px] text-[#6E6557] px-1">
                {tr('دفعات مقدمة للموردين')}: <b className="text-[#2B6CB0] tabular-nums" dir="ltr">{formatCurrency(summary.advance)}</b>
              </p>
            )}
          </section>
        )}

        {listQ.isLoading ? <MSpinner />
          : listQ.isError ? <MError onRetry={() => listQ.refetch()} text={tr('تعذر تحميل الموردين')} />
          : !rows.length ? (
            <div className="py-10">
              <MEmpty icon={Truck} text={dq ? tr('لا نتائج')
                : status === 'archived' ? tr('لا يوجد موردون مؤرشفون')
                : tr('لا يوجد موردون بعد أضف المورد عند استلام البضاعة أو من لوحة الويب')} />
            </div>
          ) : (
            <>
              <p className="text-[11px] text-[#9A8F7E] px-1">{tr('عدد الموردين')}: {formatNumber(total)}</p>
              <MCard>
                {rows.map(s => <SupplierRow key={s.id} s={s} decimals={decimals} onOpen={() => setOpen(s)} />)}
              </MCard>
              {listQ.hasNextPage && (
                <button type="button" onClick={() => listQ.fetchNextPage()} disabled={listQ.isFetchingNextPage}
                  className="w-full bg-white border border-[#E9E1D3] text-[#1F1A13] font-semibold text-sm py-3 rounded-xl min-h-[44px] disabled:opacity-60">
                  {listQ.isFetchingNextPage ? tr('جاري التحميل') : tr('تحميل المزيد')}
                </button>
              )}
            </>
          )}
        <div className="h-2" />
      </div>
    </div>
  );
}

function SupplierRow({ s, decimals, onOpen }: { s: Supplier; decimals: number; onOpen: () => void }) {
  const tr = useTr();
  const b = balanceState(s.balance, decimals);
  const tone = b.state === 'owed' ? 'text-[#B7791F]' : b.state === 'advance' ? 'text-[#2B6CB0]' : 'text-[#2F855A]';
  return (
    <MRow
      onClick={onOpen}
      leading={
        <span className="w-9 h-9 rounded-full bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center text-sm font-bold flex-shrink-0">
          {s.name?.charAt(0) || ''}
        </span>
      }
      title={s.name}
      subtitle={[s.code, s.phone, s.city].filter(Boolean).join(' · ') || tr('بلا بيانات')}
      note={s.openBillsCount > 0 ? `${tr('فواتير مفتوحة')}: ${formatNumber(s.openBillsCount)}` : undefined}
      trailing={
        <span className="flex items-center gap-1 flex-shrink-0">
          {!s.isActive && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 whitespace-nowrap">{tr('مؤرشف')}</span>
          )}
          <span className="text-end">
            <span className={`block text-xs font-bold whitespace-nowrap tabular-nums ${tone}`} dir="ltr">{formatCurrency(b.amount)}</span>
            {/* الرقم بلا إشارة واسم حاله تحته: «−٥٠٠» وحدها تُقرأ ديناً وهي دفعةٌ مقدّمة */}
            {b.state !== 'settled' && (
              <span className="block text-[10px] text-[#9A8F7E] whitespace-nowrap">{b.state === 'owed' ? tr('مستحق له') : tr('رصيد مدين له')}</span>
            )}
          </span>
          <ChevronLeft size={15} className="text-[#C9BFB0]" />
        </span>
      } />
  );
}
