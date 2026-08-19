import { useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { paymentsApi } from '../api/client';
import { BrandIcon } from '../components/BrandLogo';
import { CheckCircle2, Clock, XCircle, RefreshCw } from 'lucide-react';

interface Pub { id: string; status: string; description: string; amountHalalas: number; paidAt: string | null }

const fmtSar = (h: number) => `${(h / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} ر.س`;

// صفحة عودة العميل من صفحة دفع ميسر — تعرض نتيجة الدفع بالمعرف غير القابل للتخمين.
// الحالة تاتي من خادمنا الذي يجلبها من ميسر نفسه (لا من معاملات الرابط).
export default function PaymentResultPage() {
  const [params] = useSearchParams();
  const ref = params.get('ref') || '';

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['payment-status', ref],
    queryFn: async () => (await paymentsApi.publicStatus(ref)).data.data as Pub,
    enabled: !!ref,
    refetchInterval: q => {
      const st = q.state.data?.status;
      return st && !['paid', 'canceled', 'expired'].includes(st) ? 5000 : false;
    },
  });

  useEffect(() => { document.title = 'نتيجة الدفع — Field Sales'; }, []);

  const paid = data?.status === 'paid';
  const pending = data && !paid && (data.status === 'initiated');

  return (
    <div dir="rtl" className="min-h-screen flex items-center justify-center bg-[#FAF7F0] p-4" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}>
      <div className="bg-white rounded-2xl shadow-xl border border-[#E9E1D3] w-full max-w-md p-8 text-center">
        <div className="flex justify-center mb-4"><BrandIcon size={52} radius={0.28} /></div>

        {!ref ? (
          <p className="text-[#6E6557]">رابط غير صالح</p>
        ) : isLoading ? (
          <p className="text-[#9A8F7E] py-6">جار التحقق من الدفع…</p>
        ) : isError || !data ? (
          <>
            <XCircle size={44} className="text-red-500 mx-auto mb-3" />
            <h1 className="text-xl font-bold text-[#1F1A13]">تعذر التحقق</h1>
            <p className="text-sm text-[#6E6557] mt-2">حاول تحديث الصفحة او تواصل معنا</p>
          </>
        ) : paid ? (
          <>
            <CheckCircle2 size={52} className="text-green-600 mx-auto mb-3" />
            <h1 className="text-2xl font-bold text-[#1F1A13]">تم الدفع بنجاح</h1>
            <p className="text-sm text-[#6E6557] mt-3">{data.description}</p>
            <p className="text-3xl font-extrabold text-[#1E7A52] mt-2 tabular-nums">{fmtSar(data.amountHalalas)}</p>
            <p className="text-[12px] text-[#9A8F7E] mt-4">شكرا لكم — تم تسجيل دفعتكم وسنباشر التفعيل</p>
          </>
        ) : pending ? (
          <>
            <Clock size={48} className="text-[#E0A02C] mx-auto mb-3" />
            <h1 className="text-xl font-bold text-[#1F1A13]">بانتظار اكتمال الدفع</h1>
            <p className="text-sm text-[#6E6557] mt-2">{data.description} — {fmtSar(data.amountHalalas)}</p>
            <button onClick={() => refetch()} className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-[#E15A30]">
              <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} /> تحديث الحالة
            </button>
          </>
        ) : (
          <>
            <XCircle size={44} className="text-gray-400 mx-auto mb-3" />
            <h1 className="text-xl font-bold text-[#1F1A13]">الرابط {data.status === 'canceled' ? 'ملغي' : 'منتهي'}</h1>
            <p className="text-sm text-[#6E6557] mt-2">تواصل معنا لاصدار رابط جديد</p>
          </>
        )}

        <div className="mt-6 pt-4 border-t border-[#F1EBDF] text-[12px]" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
          <Link to="/" className="text-[#E15A30] font-bold">fieldsa.net</Link>
          <span className="text-[#9A8F7E]"> · help@fieldsa.net</span>
        </div>
      </div>
    </div>
  );
}
