import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CreditCard, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { formatCurrency } from '../utils/format';

/**
 * صفحة الدفع العامة — /pay/:token — التي يفتحها عميل الشركة من واتساب.
 *
 * بلا مصادقة (الرمز العشوائي نفسه هو الإذن)، بهوية الشركة (شعار ولون)،
 * وزر واحد ينقل لصفحة ميسر المستضافة — بطاقة العميل لا تمر بخوادمنا إطلاقاً.
 *
 * «الصلاحية تفحص لحظة الفتح»: الخادم يعيد الحالة الحقيقية (سُددت نقداً؟
 * انتهى الرابط؟) فلا يدفع العميل فاتورة لم تعد مستحقة.
 * وبعد العودة من ميسر (?done=1) نطلب تأكيداً يجلب الحقيقة من ميسر نفسه —
 * صفحة النجاح ليست دليل سداد.
 */

interface PayView {
  company: { name: string; logo?: string | null; primaryColor?: string | null };
  customerName: string;
  invoiceNumber: string;
  amount: number;
  status: string; // initiated | paid | canceled | expired | settled
  payUrl: string | null;
  paidAt?: string | null;
  receipt?: { number: string; amount: number; date: string } | null;
}

const API = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export default function PayPage() {
  const { token } = useParams();
  const [search] = useSearchParams();
  const [view, setView] = useState<PayView | null>(null);
  const [err, setErr] = useState(false);

  // روابط الدفع خاصة تُشارك يداً بيد — لا تُفهرس
  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'robots'; m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    document.title = 'سداد فاتورة';
    return () => { document.head.removeChild(m); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // عائد من ميسر؟ نؤكد أولاً (الخادم يجلب الحقيقة من ميسر) ثم نعرض
        if (search.get('done') === '1') {
          await fetch(`${API}/paylink/public/${token}/refresh`, { method: 'POST' }).catch(() => null);
        }
        const r = await fetch(`${API}/paylink/public/${token}`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (!cancelled) setView(j.data as PayView);
      } catch { if (!cancelled) setErr(true); }
    })();
    return () => { cancelled = true; };
  }, [token, search]);

  const brand = view?.company.primaryColor || '#E15A30';

  if (err) {
    return (
      <Shell brand="#E15A30">
        <XCircle size={40} color="#C0392B" style={{ margin: '0 auto 12px' }} />
        <p style={{ fontWeight: 800, fontSize: 16 }}>الرابط غير صحيح او لم يعد متاحا</p>
        <p style={{ fontSize: 13, color: '#8A8178', marginTop: 6 }}>تواصل مع مندوبك للحصول على رابط جديد</p>
      </Shell>
    );
  }
  if (!view) {
    return (
      <Shell brand="#E15A30">
        <div style={{ width: 34, height: 34, border: '3px solid #E9E1D3', borderTopColor: '#E15A30', borderRadius: '50%', animation: 'spin 0.9s linear infinite', margin: '0 auto' }} />
        <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
      </Shell>
    );
  }

  return (
    <Shell brand={brand}>
      {/* هوية الشركة — الثقة أول ما يبحث عنه من فتح رابطاً من واتساب */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        {view.company.logo
          ? <img src={view.company.logo} alt="" style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'cover', border: '1px solid #E9E1D3' }} />
          : <span style={{ width: 64, height: 64, borderRadius: 16, background: brand, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><CreditCard size={30} color="#fff" /></span>}
        <p style={{ fontWeight: 800, fontSize: 17 }}>{view.company.name}</p>
      </div>

      <div style={{ background: '#FBF8F2', border: '1px solid #E9E1D3', borderRadius: 16, padding: 16, marginBottom: 18 }}>
        <Row label="العميل" value={view.customerName} />
        <Row label="رقم الفاتورة" value={view.invoiceNumber} />
        <div style={{ borderTop: '1px dashed #E9E1D3', marginTop: 10, paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 13, color: '#8A8178' }}>المبلغ المستحق</span>
          <span style={{ fontWeight: 800, fontSize: 22, color: brand }}>{formatCurrency(view.amount)}</span>
        </div>
      </div>

      {view.status === 'paid' ? (
        <div style={{ textAlign: 'center' }}>
          <CheckCircle2 size={44} color="#1E7A52" style={{ margin: '0 auto 8px' }} />
          <p style={{ fontWeight: 800, color: '#1E7A52' }}>تم الدفع بنجاح</p>
          {view.receipt?.number && (
            <p style={{ fontSize: 13, marginTop: 8 }}>رقم الايصال <b>{view.receipt.number}</b></p>
          )}
          <p style={{ fontSize: 12.5, color: '#8A8178', marginTop: 6 }}>الايصال مسجل لدى الشركة ولا يلزمك شيء اخر</p>
        </div>
      ) : view.status === 'settled' ? (
        <div style={{ textAlign: 'center' }}>
          <CheckCircle2 size={44} color="#1E7A52" style={{ margin: '0 auto 8px' }} />
          <p style={{ fontWeight: 800 }}>الفاتورة سددت لدى الشركة</p>
          <p style={{ fontSize: 12.5, color: '#8A8178', marginTop: 6 }}>لا حاجة للدفع عبر هذا الرابط</p>
        </div>
      ) : view.status === 'expired' || view.status === 'canceled' ? (
        <div style={{ textAlign: 'center' }}>
          <Clock size={44} color="#B7791F" style={{ margin: '0 auto 8px' }} />
          <p style={{ fontWeight: 800 }}>انتهت صلاحية الرابط</p>
          <p style={{ fontSize: 12.5, color: '#8A8178', marginTop: 6 }}>اطلب من مندوبك رابط دفع جديدا</p>
        </div>
      ) : view.payUrl ? (
        <>
          <a href={view.payUrl}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: brand, color: '#fff', borderRadius: 14, padding: '14px 20px', fontWeight: 800, fontSize: 15, textDecoration: 'none' }}>
            <CreditCard size={18} /> ادفع الان بامان
          </a>
          <p style={{ fontSize: 11, color: '#B7AD9D', textAlign: 'center', marginTop: 12, lineHeight: 1.7 }}>
            الدفع عبر بوابة ميسر المرخصة من البنك المركزي السعودي
            <br />بياناتك البنكية لا تمر بخوادمنا
          </p>
        </>
      ) : (
        <p style={{ textAlign: 'center', fontSize: 13, color: '#8A8178' }}>الرابط قيد التجهيز حاول بعد لحظات</p>
      )}

      <p style={{ textAlign: 'center', fontSize: 10.5, color: '#B7AD9D', marginTop: 26 }}>
        مدعوم من <a href="/" style={{ color: '#8A8178', fontWeight: 700, textDecoration: 'none' }}>FieldSales</a>
      </p>
    </Shell>
  );
}

function Shell({ brand, children }: { brand: string; children: React.ReactNode }) {
  return (
    <div dir="rtl" style={{ minHeight: '100vh', background: '#FAF7F0', fontFamily: "'IBM Plex Sans Arabic', system-ui, sans-serif", color: '#1F1A13', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
      <div style={{ width: '100%', maxWidth: 400, background: '#fff', border: '1px solid #E9E1D3', borderRadius: 22, padding: '26px 22px', boxShadow: `0 14px 40px ${brand}14` }}>
        {children}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
      <span style={{ fontSize: 13, color: '#8A8178' }}>{label}</span>
      <span style={{ fontSize: 13.5, fontWeight: 700 }}>{value}</span>
    </div>
  );
}
