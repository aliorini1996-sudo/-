import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, FileText, RotateCcw, Banknote, CreditCard, ChevronLeft, XCircle, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { invoiceApi, receiptApi } from '../api/client';
import { Invoice } from '../types';
import { formatCurrency, formatDate, formatTime } from '../utils/format';
import { useTr } from '../i18n/strings';
import ConfirmDialog from '../components/ConfirmDialog';
import { MCard, MRow, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray } from './shape';

const MDocScreen = lazy(() => import('./MDocScreen'));

const PAGE = 25;

type Kind = 'invoice' | 'receipt';

/**
 * قائمة مستندات (فواتير أو سندات) — نمط واحد لكليهما.
 *
 * ما ينفرد به الأدمن عن تطبيق المندوب ويظهر هنا: **اسم المندوب** على كل
 * مستند، والمدفوع/المتبقّي، وشارة «ملغي».
 *
 * والوقت من `clientCreatedAt` حين يوجد: مستند أُصدر أوف‑لاين ورُفع بعد ساعات
 * تاريخُه الحقيقيّ لحظة إصداره عند العميل لا لحظة وصوله للخادم.
 */
export default function MDocList({ kind, company, userName }: {
  kind: Kind;
  company: unknown;
  userName: string;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setTimeout(() => { setDq(q.trim()); setLimit(PAGE); }, 300); return () => clearTimeout(t); }, [q]);

  const api = kind === 'invoice' ? invoiceApi : receiptApi;
  const listQ = useQuery({
    queryKey: ['m-docs', kind, dq, limit],
    queryFn: async () => {
      const res = await api.list({ search: dq, limit });
      return expectArray<Record<string, unknown>>(res.data?.data, kind === 'invoice' ? 'الفواتير' : 'السندات');
    },
  });

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || listQ.isFetching) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160
        && (listQ.data?.length ?? 0) >= limit) setLimit(l => l + PAGE);
  }, [listQ.isFetching, listQ.data, limit]);

  const doCancel = async () => {
    if (!cancelId) return;
    setCancelling(true);
    try {
      await api.cancel(cancelId);
      qc.invalidateQueries({ queryKey: ['m-docs', kind] });
      qc.invalidateQueries({ queryKey: ['m-dashboard'] });
      toast.success(kind === 'invoice' ? tr('تم إلغاء الفاتورة') : tr('تم إلغاء السند'));
      setCancelId(null); setOpenId(null);
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر الإلغاء'));
    } finally { setCancelling(false); }
  };

  if (openId) {
    return (
      <Suspense fallback={<MSpinner />}>
        <MDocScreen kind={kind} id={openId} company={company} userName={userName}
          onClose={() => setOpenId(null)} onCancel={() => setCancelId(openId)} />
      </Suspense>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <div className="flex-shrink-0 p-3 pb-2">
        <div className="relative">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
          <input value={q} onChange={e => setQ(e.target.value)} className="input ps-9"
            placeholder={kind === 'invoice' ? tr('ابحث برقم الفاتورة أو العميل…') : tr('ابحث برقم السند أو العميل…')} />
        </div>
      </div>

      <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {listQ.isLoading ? <MSpinner />
          : listQ.isError ? <MError onRetry={() => listQ.refetch()} />
          : !listQ.data?.length ? <MEmpty text={kind === 'invoice' ? tr('لا توجد فواتير') : tr('لا توجد سندات')} icon={FileText} />
          : (
            <MCard>
              {listQ.data.map(d => <DocRow key={String(d.id)} kind={kind} d={d} onOpen={() => setOpenId(String(d.id))} />)}
            </MCard>
          )}
        {listQ.isFetching && !listQ.isLoading && (
          <p className="text-center text-[11px] text-[#9A8F7E] py-3">{tr('جاري التحميل...')}</p>
        )}
      </div>

      {cancelId && (
        <ConfirmDialog
          danger
          title={kind === 'invoice' ? tr('إلغاء الفاتورة') : tr('إلغاء السند')}
          message={kind === 'invoice'
            ? tr('سيُلغى المستند وتُعكس قيوده المحاسبية ويعود رصيد العميل كما كان. لا يمكن التراجع.')
            : tr('سيُلغى السند وتُعكس قيوده ويعود المبلغ على ذمّة العميل. لا يمكن التراجع.')}
          confirmLabel={tr('تأكيد الإلغاء')}
          loading={cancelling}
          onConfirm={doCancel}
          onClose={() => setCancelId(null)} />
      )}
    </div>
  );
}

function DocRow({ kind, d, onOpen }: { kind: Kind; d: Record<string, unknown>; onOpen: () => void }) {
  const tr = useTr();
  const cancelled = d.status === 'CANCELLED';
  const inv = d as unknown as Invoice;
  const isReturn = kind === 'invoice' && inv.type === 'RETURN';
  const isCash = kind === 'invoice' && inv.type === 'CASH';
  const Icon = kind === 'receipt' ? CreditCard : isReturn ? RotateCcw : isCash ? Banknote : FileText;
  const tone = cancelled ? 'bg-[#F1EBDF] text-[#9A8F7E]'
    : isReturn ? 'bg-[#FDF2F0] text-[#C0392B]'
    : kind === 'receipt' ? 'bg-[#E9F6EF] text-[#2F855A]' : 'bg-[#FBEBE2] text-[#C94E28]';

  // لحظة الإصدار الحقيقية: أوف‑لاين تسبق الرفع بساعات
  const issuedAt = String(d.clientCreatedAt || d.createdAt || '');
  const customerName = (d.customer as { name?: string } | undefined)?.name || '—';
  const repName = (d.salesRep as { name?: string } | undefined)?.name || tr('الإدارة');
  const amount = Number(d.total ?? d.amount ?? 0);
  const remaining = Number(d.remainingAmt ?? 0);

  return (
    <MRow
      onClick={onOpen}
      leading={<span className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${tone}`}><Icon size={16} /></span>}
      title={
        <span className="flex items-center gap-1.5">
          <span dir="ltr">{String(d.number || '')}</span>
          {cancelled && <span className="text-[9px] bg-[#F1EBDF] text-[#9A8F7E] rounded-full px-1.5 py-0.5">{tr('ملغي')}</span>}
        </span>
      }
      subtitle={`${customerName} · ${repName} · ${issuedAt ? `${formatDate(issuedAt)} ${formatTime(issuedAt)}` : ''}`}
      trailing={
        <span className="flex items-center gap-1 flex-shrink-0">
          <span className="text-end">
            <span className={`block text-sm font-bold whitespace-nowrap ${cancelled ? 'text-[#9A8F7E] line-through' : 'text-[#1F1A13]'}`}>
              {formatCurrency(amount)}
            </span>
            {kind === 'invoice' && !cancelled && remaining > 0 && (
              <span className="block text-[10px] text-[#B7791F] whitespace-nowrap">
                {tr('متبقٍّ')} {formatCurrency(remaining)}
              </span>
            )}
          </span>
          <ChevronLeft size={15} className="text-[#C9BFB0]" />
        </span>
      } />
  );
}
