import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2, Wallet, ReceiptText, Banknote, Copy, XCircle, CheckCircle2, Clock, Ban } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api/client';
import { formatCurrency, formatDate } from '../utils/format';
import { useTr } from '../i18n/strings';

/**
 * صفحة «المدفوعات الالكترونية» — لوحة أدمن الشركة (ميزة اشتراك كبترو آب وهاتف).
 *
 * الشركة ترى هنا كل ما يخصها من الميزة بشفافية كاملة:
 *  - ملخص من دفتر الأمانات: المحصل إلكترونيا − عمولة المنصة − ما ورد إليهم
 *    = صافي مستحقهم الآن (التوريد أسبوعي كل خميس).
 *  - قائمة الروابط بحالاتها مع نسخ الرابط وإلغاء ما لم يدفع.
 *
 * الإصدار نفسه يبقى في تطبيق المندوب من ملف العميل — هذه شاشة متابعة ومحاسبة.
 */

interface Summary {
  collected: number; fees: number | null; refunds: number | null; payouts: number | null;
  paymentsCount: number; balance: number | null;
  lastPayout: { amount: number; bankReference?: string | null; createdAt: string } | null;
  feePct?: number; feeFlat?: number;
  scoped?: boolean; // مستخدم مقيد النطاق: أرقام روابط عملائه فقط بلا بطاقات الأمانات
}

interface LinkRow {
  id: string; token: string; amount: number; status: string;
  paidAt?: string | null; expiresAt: string; createdAt: string;
  customer?: { name: string } | null;
  invoice?: { number: string } | null;
  salesRep?: { name: string } | null;
  receiptId?: string | null;
}

const STATUS_META: Record<string, { label: string; cls: string; Icon: typeof Clock }> = {
  initiated: { label: 'بانتظار الدفع', cls: 'bg-amber-100 text-amber-700', Icon: Clock },
  paid: { label: 'مدفوع', cls: 'bg-green-100 text-green-700', Icon: CheckCircle2 },
  canceled: { label: 'ملغى', cls: 'bg-gray-100 text-gray-500', Icon: Ban },
  expired: { label: 'منتهي', cls: 'bg-orange-100 text-orange-600', Icon: XCircle },
  refunded: { label: 'مسترد', cls: 'bg-purple-100 text-purple-700', Icon: Ban },
};

export default function PaylinkPage() {
  const tr = useTr();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  // تحديث تلقائي كل ٣٠ ثانية: المالك يراقب دفعة واردة فلا يليق ببياناته الموت
  const { data: summary } = useQuery({
    queryKey: ['paylink-summary'],
    queryFn: async () => (await api.get('/paylink/summary')).data.data as Summary,
    refetchInterval: 30_000,
  });

  const { data: linksRes, isLoading } = useQuery({
    queryKey: ['paylink-links', status, page],
    queryFn: async () => (await api.get('/paylink/links', { params: { status: status || undefined, page, limit: 25 } })).data as { data: LinkRow[]; meta: { total: number; limit: number } },
    refetchInterval: 30_000,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/paylink/links/${id}/cancel`),
    onSuccess: () => {
      toast.success(tr('الغي الرابط ولن يقبل الدفع'));
      qc.invalidateQueries({ queryKey: ['paylink-links'] });
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الالغاء')),
  });

  const copyLink = async (token: string) => {
    const url = `${window.location.origin}/pay/${token}`;
    try { await navigator.clipboard.writeText(url); } catch {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    toast.success(tr('نسخ الرابط'));
  };

  const rows = linksRes?.data ?? [];
  const total = linksRes?.meta?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (linksRes?.meta?.limit || 25)));

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-xl bg-[#2E6FB0]/10 text-[#2E6FB0] flex items-center justify-center"><Link2 size={20} /></span>
        <div>
          <h1 className="text-xl font-bold text-gray-800">{tr('المدفوعات الالكترونية')}</h1>
          <p className="text-xs text-gray-400">{tr('روابط الدفع التي يصدرها مناديبك من ملف العميل والتوريد اسبوعي كل خميس')}</p>
        </div>
      </div>

      {/* الملخص المالي — من دفتر الأمانات؛ المقيد النطاق يرى إحصاء روابط عملائه فقط */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card icon={ReceiptText} tint="text-green-600 bg-green-50" label={tr('المحصل الكترونيا')}
          value={formatCurrency(summary?.collected ?? 0)} sub={`${summary?.paymentsCount ?? 0} ${tr('دفعة')}`} />
        {!summary?.scoped && <>
          <Card icon={Wallet} tint="text-[#C94E28] bg-[#FBEBE2]" label={tr('عمولة المنصة')}
            value={formatCurrency(summary?.fees ?? 0)}
            sub={`${summary?.feePct ?? 4}% + ${summary?.feeFlat ?? 1} ${tr('ريال لكل دفعة شاملة الضريبة')}`} />
          <Card icon={Banknote} tint="text-[#2E6FB0] bg-[#2E6FB0]/10" label={tr('صافي مستحقكم الان')}
            value={formatCurrency(summary?.balance ?? 0)} sub={tr('يورد لحسابكم كل خميس')} />
          <Card icon={CheckCircle2} tint="text-gray-600 bg-gray-100" label={tr('المورد اليكم سابقا')}
            value={formatCurrency(summary?.payouts ?? 0)}
            sub={summary?.lastPayout ? `${tr('اخر توريد')} ${formatDate(summary.lastPayout.createdAt)}` : tr('لا توريد بعد')} />
        </>}
      </div>

      {/* الروابط */}
      <div className="bg-white rounded-2xl border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <p className="font-bold text-sm text-gray-700">{tr('روابط الدفع')}</p>
          <select className="input text-sm !w-auto" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
            <option value="">{tr('كل الحالات')}</option>
            <option value="initiated">{tr('بانتظار الدفع')}</option>
            <option value="paid">{tr('مدفوع')}</option>
            <option value="canceled">{tr('ملغى')}</option>
            <option value="expired">{tr('منتهي')}</option>
            <option value="refunded">{tr('مسترد')}</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-400 border-b border-gray-100">
              <tr>
                <th className="text-right p-3">{tr('الفاتورة')}</th>
                <th className="text-right p-3">{tr('العميل')}</th>
                <th className="text-right p-3">{tr('المندوب')}</th>
                <th className="text-right p-3">{tr('المبلغ')}</th>
                <th className="text-right p-3">{tr('الحالة')}</th>
                <th className="text-right p-3">{tr('التاريخ')}</th>
                <th className="text-right p-3">{tr('إجراءات')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} className="text-center text-gray-400 py-10">{tr('جاري التحميل')}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="text-center text-gray-400 py-10">
                  {tr('لا روابط بعد يصدرها المندوب من ملف العميل في تطبيقه')}
                </td></tr>
              ) : rows.map(r => {
                const meta = STATUS_META[r.status] ?? STATUS_META.initiated;
                return (
                  <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50/60">
                    <td className="p-3 font-medium text-gray-700">{r.invoice?.number ?? '—'}</td>
                    <td className="p-3">{r.customer?.name ?? '—'}</td>
                    <td className="p-3 text-gray-500">{r.salesRep?.name ?? '—'}</td>
                    <td className="p-3 font-bold">{formatCurrency(r.amount)}</td>
                    <td className="p-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${meta.cls}`}>
                        <meta.Icon size={12} /> {tr(meta.label)}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-gray-400">
                      {formatDate(r.createdAt)}
                      {r.status === 'paid' && r.paidAt && <div className="text-green-600">{tr('دفع')} {formatDate(r.paidAt)}</div>}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => copyLink(r.token)} title={tr('نسخ الرابط')}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-[#2E6FB0] hover:bg-[#2E6FB0]/10">
                          <Copy size={15} />
                        </button>
                        {r.status === 'initiated' && (
                          <button onClick={() => cancel.mutate(r.id)} disabled={cancel.isPending} title={tr('الغاء الرابط')}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">
                            <XCircle size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div className="p-3 flex items-center justify-center gap-2 text-sm">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 rounded-lg border border-gray-200 disabled:opacity-40">{tr('السابق')}</button>
            <span className="text-gray-500">{page} / {pages}</span>
            <button disabled={page >= pages} onClick={() => setPage(p => p + 1)} className="px-3 py-1 rounded-lg border border-gray-200 disabled:opacity-40">{tr('التالي')}</button>
          </div>
        )}
      </div>

      <p className="text-[11px] text-gray-400 leading-relaxed">
        {tr('المندوب يصدر الرابط من ملف العميل في تطبيقه ويشاركه واتساب وعند سداد العميل يسجل سند القبض تلقائيا وتسدد الفاتورة')}
      </p>
    </div>
  );
}

function Card({ icon: Icon, tint, label, value, sub }: { icon: typeof Wallet; tint: string; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4">
      <div className="flex items-center gap-2.5 mb-2">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${tint}`}><Icon size={16} /></span>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
      <p className="text-lg font-bold text-gray-800">{value}</p>
      {sub && <p className="text-[10.5px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}
