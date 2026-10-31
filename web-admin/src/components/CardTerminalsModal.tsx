import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, CreditCard, X } from 'lucide-react';
import { cardPayApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { backdropClose } from '../lib/backdropClose';
import { formatCurrency, formatDate } from '../utils/format';

interface ReviewRow {
  id: string; reference: string; amount: number; statusDetail: string | null; createdAt: string;
  customer?: { name: string } | null; salesRep?: { name: string } | null;
}

interface TerminalsData {
  merchantLinked: boolean;
  terminals: { tid: string; connected: boolean; merchantName: string | null }[];
  reps: { id: string; name: string; isActive: boolean; nearpayTid: string | null }[];
}

/**
 * «التحصيل بالبطاقة» (NearPay): إسناد نقطة بيعٍ لكل مندوب — النقاط من تاجر الشركة لدى NearPay وحده (يربطه مزوّد الخدمة)،
 * والنقطة الواحدة لمندوبٍ واحد. الخادم يحرس الشرطين (routes/cardPayments.ts) — هنا العرض والاختيار فقط.
 */
export default function CardTerminalsModal({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['card-terminals'],
    queryFn: async () => (await cardPayApi.terminals()).data.data as TerminalsData,
  });
  const assign = useMutation({
    mutationFn: ({ repId, tid }: { repId: string; tid: string | null }) => cardPayApi.assignRep(repId, tid),
    onSuccess: () => { toast.success(tr('تم حفظ نقطة البيع')); qc.invalidateQueries({ queryKey: ['card-terminals'] }); },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || tr('تعذر حفظ نقطة البيع'));
    },
  });

  // «review»: خُصمت لدى NearPay ولم يُقيَّد سندها (مراجعة ٣١ أكتوبر ٢٠٢٦) — الفاتورة محجوبة عن تحصيلٍ جديد بالبطاقة حتى تُحسم.
  // تُعالج يدوياً (سند قبضٍ يدوي بما بقي عند التاجر، أو استردادٌ من لوحة NearPay) ثم تُغلق بملاحظةٍ تبقى في سجلها
  const reviewQ = useQuery({
    queryKey: ['card-payments-review'],
    queryFn: async () => (await cardPayApi.review()).data.data as ReviewRow[],
    retry: false,
  });
  const close = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => cardPayApi.closeReview(id, note),
    onSuccess: () => { toast.success(tr('أغلقت العملية')); qc.invalidateQueries({ queryKey: ['card-payments-review'] }); },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || tr('تعذر إغلاق العملية'));
    },
  });
  const askClose = (r: ReviewRow) => {
    const note = window.prompt(tr('كيف عولجت العملية؟ (مثلا: سند قبض يدوي رقم كذا أو استرداد من NearPay)'))?.trim();
    if (note && note.length >= 3) close.mutate({ id: r.id, note });
  };

  const data = q.data;
  const usedBy = new Map((data?.reps || []).filter(r => r.nearpayTid).map(r => [r.nearpayTid as string, r.id]));

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-[#E9E1D3] flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-[#FBEBE2] flex items-center justify-center"><CreditCard size={20} className="text-[#E15A30]" /></span>
          <div className="flex-1">
            <h2 className="font-bold text-[#1F1A13]">{tr('نقاط البيع للتحصيل بالبطاقة')}</h2>
            <p className="text-xs text-[#6E6557] mt-0.5">{tr('أسند لكل مندوب نقطة بيع من نقاط شركتك لدى NearPay ليحصل بالبطاقة من جواله')}</p>
          </div>
          <button onClick={onClose} className="text-gray-400"><X size={20} /></button>
        </div>
        <div className="p-5 overflow-y-auto flex-1">
          {(reviewQ.data || []).length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4">
              <p className="text-sm font-bold text-amber-900 flex items-center gap-2"><AlertTriangle size={16} /> {tr('عمليات بطاقة تحتاج مراجعة')}</p>
              <p className="text-[11px] text-amber-800 mt-1 leading-relaxed">{tr('خصمت لدى NearPay ولم يسجل سندها فلا يحصل المندوب على فاتورتها مرة أخرى عالجها يدويا ثم أغلقها')}</p>
              <div className="space-y-2 mt-3">
                {reviewQ.data!.map(r => (
                  <div key={r.id} className="bg-white border border-amber-200 rounded-lg p-2.5 flex items-start gap-3">
                    <div className="flex-1 min-w-0 text-xs">
                      <p className="font-semibold text-[#1F1A13]">{r.reference} — {formatCurrency(r.amount)}</p>
                      <p className="text-gray-500">{r.customer?.name || ''}{r.salesRep?.name ? ` · ${r.salesRep.name}` : ''} · {formatDate(r.createdAt)}</p>
                      {r.statusDetail && <p className="text-amber-800 mt-1 leading-relaxed">{r.statusDetail}</p>}
                    </div>
                    <button onClick={() => askClose(r)} disabled={close.isPending}
                      className="text-xs border border-[#1F1A13] text-[#1F1A13] rounded-lg px-2.5 py-1.5 whitespace-nowrap">{tr('أغلق بعد المعالجة')}</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {q.isLoading ? (
            <p className="text-center text-gray-400 py-8 text-sm">{tr('جاري التحميل')}</p>
          ) : q.isError ? (
            <p className="bg-red-50 text-red-600 text-sm rounded-xl p-3">
              {(q.error as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر تحميل نقاط البيع')}
            </p>
          ) : !data?.merchantLinked ? (
            <p className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-3 leading-relaxed">
              {tr('لم يربط مزود الخدمة تاجر شركتك لدى NearPay بعد تواصل معه لإكمال الربط')}
            </p>
          ) : (
            <>
              {data.terminals.length === 0 && (
                <p className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-3 mb-3">{tr('لا توجد نقاط بيع لتاجر شركتك لدى NearPay بعد')}</p>
              )}
              <div className="space-y-2">
                {data.reps.map(rep => (
                  <div key={rep.id} className="flex items-center gap-3 border border-[#E9E1D3] rounded-xl p-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-[#1F1A13] truncate">{rep.name}</p>
                      {!rep.isActive && <p className="text-[11px] text-gray-400">{tr('موقوف')}</p>}
                    </div>
                    <select
                      className="input w-56 text-sm" dir="ltr"
                      value={rep.nearpayTid || ''}
                      disabled={assign.isPending}
                      onChange={e => assign.mutate({ repId: rep.id, tid: e.target.value || null })}
                    >
                      <option value="">{tr('بلا نقطة بيع')}</option>
                      {data.terminals.map(t => (
                        <option key={t.tid} value={t.tid} disabled={usedBy.has(t.tid) && usedBy.get(t.tid) !== rep.id}>
                          {t.tid}{usedBy.has(t.tid) && usedBy.get(t.tid) !== rep.id ? ` — ${tr('مسندة')}` : ''}
                        </option>
                      ))}
                      {/* نقطةٌ مسندة لم تعد ضمن نقاط التاجر — تُعرض كي لا يختفي الإسناد بصمت */}
                      {rep.nearpayTid && !data.terminals.some(t => t.tid === rep.nearpayTid) && <option value={rep.nearpayTid}>{rep.nearpayTid}</option>}
                    </select>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-[#9A8F7E] mt-4 leading-relaxed">
                {tr('يدخل المندوب تطبيق الدفع على نقطته دون رمز تحقق ويسجل سند القبض تلقائيا بعد تأكيد NearPay والمال يذهب من NearPay إلى حساب شركتك مباشرة')}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
