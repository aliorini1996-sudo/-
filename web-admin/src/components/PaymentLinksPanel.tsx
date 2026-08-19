import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { paymentsApi, tenantApi } from '../api/client';
import { Tenant } from '../types';
import { X, Link2, Copy, RefreshCw, CreditCard, MessageCircle, CheckCircle2, Clock, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';

interface PayLink {
  id: string; tenantId: string | null; tenantName: string | null;
  description: string; amountHalalas: number; months: number;
  url: string | null; status: string; paidAt: string | null; createdAt: string;
}

const fmtSar = (halalas: number) => `${(halalas / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ر.س`;
const fmtDT = (s: string) => new Date(s).toLocaleString('ar', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

const STATUS: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  paid: { label: 'مدفوع', cls: 'bg-green-50 text-green-700', icon: CheckCircle2 },
  initiated: { label: 'بانتظار الدفع', cls: 'bg-[#FBF0D8] text-[#9A6B1E]', icon: Clock },
  canceled: { label: 'ملغي', cls: 'bg-gray-100 text-gray-500', icon: XCircle },
  expired: { label: 'منتهي', cls: 'bg-gray-100 text-gray-500', icon: XCircle },
};

// لوحة روابط الدفع (ميسر) — المالك يصدر رابطا بمبلغ يحدده ويرسله للعميل،
// والدفع يتم على صفحة ميسر المستضافة ثم تعتمد الحالة من ميسر نفسه.
export default function PaymentLinksPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [months, setMonths] = useState('0');

  const { data: links, isLoading, isError } = useQuery({
    queryKey: ['payment-links'],
    queryFn: async () => (await paymentsApi.list()).data.data as PayLink[],
  });
  const { data: tenants } = useQuery({
    queryKey: ['tenants'],
    queryFn: async () => (await tenantApi.list()).data.data as Tenant[],
  });

  const create = useMutation({
    mutationFn: () => paymentsApi.create({
      amountSar: Number(amount),
      description: description.trim(),
      tenantId: tenantId || null,
      months: Number(months) || 0,
    }),
    onSuccess: (res) => {
      const url = (res.data.data as PayLink).url;
      qc.invalidateQueries({ queryKey: ['payment-links'] });
      setAmount(''); setDescription(''); setTenantId(''); setMonths('0');
      if (url && navigator.clipboard) {
        navigator.clipboard.writeText(url)
          .then(() => toast.success('انشئ الرابط ونسخ للحافظة'))
          .catch(() => toast.success('انشئ الرابط — انسخه من زر النسخ'));
      } else {
        toast.success('انشئ الرابط — انسخه من زر النسخ');
      }
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذر انشاء الرابط'),
  });

  const refresh = useMutation({
    mutationFn: (id: string) => paymentsApi.refresh(id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['payment-links'] });
      const out = res.data.data as { status: string; paid: boolean };
      if (out.status === 'amount_mismatch') {
        toast.error('تنبيه: ميسر يظهر دفعا بمبلغ او عملة مختلفة — راجع فاتورة ميسر يدويا', { duration: 8000 });
      } else if (out.paid) {
        toast.success('تم اعتماد الدفع وتنفيذ التمديد ان وجد');
      } else {
        toast(`لم يدفع بعد — الحالة: ${out.status === 'initiated' ? 'بانتظار الدفع' : out.status}`);
      }
    },
    onError: () => toast.error('تعذر التحديث'),
  });

  const copy = (url: string) => { navigator.clipboard.writeText(url).then(() => toast.success('نسخ الرابط')).catch(() => toast.error('تعذر النسخ — انسخه يدويا')); };
  const wa = (l: PayLink) => {
    const txt = `السلام عليكم\nهذا رابط الدفع الخاص بكم\n${l.description}\nالمبلغ ${fmtSar(l.amountHalalas)}\n${l.url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`, '_blank');
  };

  const amt = Number(amount);
  const canSubmit = amt >= 1 && amt <= 1_000_000 && description.trim().length >= 3 && description.trim().length <= 255 && !create.isPending && (Number(months) === 0 || !!tenantId);

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><CreditCard size={20} className="text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">روابط الدفع</h2>
              <p className="text-xs text-[#6E6557]">اصدر رابط دفع ميسر بالمبلغ الذي تحدده وارسله للعميل</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        {/* نموذج الانشاء */}
        <div className="px-5 py-4 border-b border-[#F1EBDF] grid sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">المبلغ بالريال *</label>
            <input type="number" min="1" step="0.01" className="input w-full" dir="ltr" value={amount}
              onChange={e => setAmount(e.target.value)} placeholder="500" />
          </div>
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">الوصف (يظهر للعميل) *</label>
            <input className="input w-full" maxLength={255} value={description} onChange={e => setDescription(e.target.value)}
              placeholder="اشتراك منصة Field Sales" />
          </div>
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">الشركة (اختياري)</label>
            <select className="input w-full" value={tenantId} onChange={e => { setTenantId(e.target.value); if (!e.target.value) setMonths('0'); }}>
              <option value="">— بلا ربط —</option>
              {(tenants || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[12px] font-bold text-[#1F1A13] mb-1">تمديد الاشتراك عند الدفع (اشهر)</label>
            <select className="input w-full" value={months} onChange={e => setMonths(e.target.value)} disabled={!tenantId}>
              {['0', '1', '3', '6', '12'].map(m => <option key={m} value={m}>{m === '0' ? 'بلا تمديد تلقائي' : `${m} شهر`}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button onClick={() => create.mutate()} disabled={!canSubmit}
              className="inline-flex items-center gap-2 bg-[#E15A30] text-white font-bold text-sm px-5 py-2.5 rounded-xl disabled:opacity-50 hover:bg-[#C94E28]">
              <Link2 size={15} /> {create.isPending ? 'ينشئ…' : 'انشاء رابط الدفع'}
            </button>
          </div>
        </div>

        {/* السجل */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="text-center text-gray-400 py-10">جار التحميل…</p>
          ) : isError ? (
            <p className="text-center text-red-500 py-10">تعذر تحميل الروابط</p>
          ) : !links || links.length === 0 ? (
            <p className="text-center text-gray-400 py-10">لا روابط بعد — انشئ اول رابط من الاعلى</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="text-[#9A8F7E] text-[11px] sticky top-0 bg-[#FAF7F0]">
                <tr>
                  <th className="text-right font-medium px-4 py-2">الوصف</th>
                  <th className="text-right font-medium py-2">الشركة</th>
                  <th className="text-center font-medium py-2">المبلغ</th>
                  <th className="text-center font-medium py-2">الحالة</th>
                  <th className="text-center font-medium py-2">التاريخ</th>
                  <th className="text-center font-medium px-4 py-2">اجراءات</th>
                </tr>
              </thead>
              <tbody>
                {links.map(l => {
                  const st = STATUS[l.status] || { label: l.status, cls: 'bg-gray-100 text-gray-500', icon: Clock };
                  const Icon = st.icon;
                  return (
                    <tr key={l.id} className="border-t border-[#F1EBDF]">
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-[#1F1A13] truncate max-w-[200px]">{l.description}</p>
                        {l.months > 0 && <p className="text-[10px] text-[#9A8F7E]">تمديد {l.months} شهر عند الدفع</p>}
                      </td>
                      <td className="py-2.5 text-[#6E6557] truncate max-w-[120px]">{l.tenantName || '—'}</td>
                      <td className="text-center py-2.5 font-bold text-[#1F1A13] tabular-nums whitespace-nowrap">{fmtSar(l.amountHalalas)}</td>
                      <td className="text-center py-2.5">
                        <span className={`inline-flex items-center gap-1 text-[11px] font-bold rounded-full px-2.5 py-1 ${st.cls}`}>
                          <Icon size={12} /> {st.label}
                        </span>
                      </td>
                      <td className="text-center py-2.5 text-[#9A8F7E] text-[11px] whitespace-nowrap">{fmtDT(l.createdAt)}</td>
                      <td className="text-center px-4 py-2.5">
                        <div className="inline-flex items-center gap-1">
                          {l.url && <button onClick={() => copy(l.url!)} title="نسخ الرابط" className="p-1.5 rounded-lg text-[#1E7A52] hover:bg-green-50"><Copy size={14} /></button>}
                          {l.url && <button onClick={() => wa(l)} title="ارسال واتساب" className="p-1.5 rounded-lg text-[#1E7A52] hover:bg-green-50"><MessageCircle size={14} /></button>}
                          {l.status !== 'paid' && (
                            <button onClick={() => refresh.mutate(l.id)} title="تحديث الحالة من ميسر" disabled={refresh.isPending}
                              className="p-1.5 rounded-lg text-[#E15A30] hover:bg-[#FBEBE2] disabled:opacity-50">
                              <RefreshCw size={14} className={refresh.isPending && refresh.variables === l.id ? 'animate-spin' : ''} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <p className="text-[11px] text-[#9A8F7E] text-center px-4 py-3 border-t border-[#F1EBDF]">
          الدفع يتم على صفحة ميسر المستضافة — لا تمر اي بيانات بطاقة بنظامنا. الحالة تعتمد من ميسر عبر الاشعارات او زر التحديث.
        </p>
      </div>
    </div>
  );
}
