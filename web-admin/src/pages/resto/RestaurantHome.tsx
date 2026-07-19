import { UtensilsCrossed, LogOut, Sparkles } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';

// لوحة المطعم (/app-r) — عنصر نائب لمرحلة M0 (أساس العزل). يحلّ محلّه في M2+
// تطبيق المطعم الكامل (قائمة/طاولات/كاشير/تقارير). وجوده يُثبت أن أدمن عمودية
// «restaurant» يُوجَّه لمساحته الخاصّة ولا يرى لوحة التوزيع (/app) إطلاقاً.
export default function RestaurantHome() {
  const { user, logout } = useAuthStore();
  const handleLogout = () => { logout(); window.location.replace('/login'); };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAF7F0] p-6" dir="rtl">
      <div className="w-full max-w-lg text-center">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-[#B5322A] mb-6"
          style={{ filter: 'drop-shadow(0 16px 40px rgba(181,50,42,.35))' }}>
          <UtensilsCrossed size={38} className="text-white" />
        </div>

        <div style={{ fontFamily: "'IBM Plex Sans', sans-serif" }} className="text-3xl font-bold tracking-tight text-[#1F1A13]">
          <span>Field</span><span className="text-[#B5322A]"> Restaurant</span>
        </div>

        {user?.companyName && (
          <p className="text-[#6E6557] mt-2 text-sm">{user.companyName}</p>
        )}

        <div className="mt-8 rounded-2xl border border-[#E9E1D3] bg-white p-6 text-right">
          <div className="flex items-center gap-2 text-[#B5322A] mb-2">
            <Sparkles size={18} />
            <h1 className="text-lg font-bold text-[#1F1A13]">منصّة المطاعم قيد الإنشاء</h1>
          </div>
          <p className="text-sm text-[#6E6557] leading-relaxed">
            حسابك جاهز على عمودية المطاعم. تُبنى حالياً وحدات الكاشير وإدارة الطاولات والقوائم
            والفوترة الإلكترونية والمحاسبة، وستظهر هنا فور جاهزيتها. شكراً لانضمامك في وقت مبكّر.
          </p>
        </div>

        <button onClick={handleLogout}
          className="mt-6 inline-flex items-center gap-2 text-sm text-[#6E6557] hover:text-[#B5322A] transition-colors">
          <LogOut size={16} /> تسجيل الخروج
        </button>
      </div>
    </div>
  );
}
