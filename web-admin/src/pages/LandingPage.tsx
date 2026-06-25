import { Link } from 'react-router-dom';
import { BrandIcon, BrandMark } from '../components/BrandLogo';
import {
  QrCode, Printer, Wallet, FileSpreadsheet, Users, ShieldCheck,
  Building2, Share2, TrendingUp, CheckCircle2, ArrowLeft, LogIn,
  Smartphone, Sparkles, Truck, ShoppingBasket, Boxes,
} from 'lucide-react';

const FONT_AR = "'IBM Plex Sans Arabic', sans-serif";
const FONT_EN = "'IBM Plex Sans', sans-serif";

const features = [
  { icon: QrCode, title: 'فواتير ضريبية ZATCA', desc: 'فواتير متوافقة مع هيئة الزكاة والضريبة مع رمز QR تلقائي وتصنيف ذكي.' },
  { icon: Printer, title: 'طباعة حرارية فورية', desc: 'اطبع الفاتورة من الميدان مباشرةً عبر طابعة بلوتوث أو مدمجة بعرض 58مم.' },
  { icon: Wallet, title: 'سندات القبض والتحصيل', desc: 'سجّل المدفوعات نقداً أو تحويلاً أو شبكة أو شيكاً، واربطها بالفواتير لحظياً.' },
  { icon: FileSpreadsheet, title: 'كشوف حساب لحظية', desc: 'اعرض رصيد أي عميل وكامل حركاته في أي لحظة، وصدّرها Excel أو PDF.' },
  { icon: TrendingUp, title: 'تتبّع الأداء بالوقت الفعلي', desc: 'لوحة أداء تُظهر مبيعات وتحصيلات كل مندوب لحظةً بلحظة.' },
  { icon: ShieldCheck, title: 'صلاحيات دقيقة لكل مندوب', desc: 'تحكّم بما يفعله كل مندوب — الخصم، تغيير السعر، التحصيل، إضافة العملاء.' },
  { icon: Building2, title: 'عزل كامل وأمان', desc: 'كل شركة لها مساحتها المعزولة تماماً، واتصال مشفّر، وبيانات محمية.' },
  { icon: Share2, title: 'تصدير ومشاركة بضغطة', desc: 'صدّر الفواتير والسندات والكشوف وأداء المناديب إلى Excel أو شاركها فوراً.' },
];

const audience = [
  { icon: Truck, title: 'شركات التوزيع الميداني (DSD)' },
  { icon: ShoppingBasket, title: 'موزّعو المواد الغذائية والاستهلاكية' },
  { icon: Boxes, title: 'أي نشاط يعتمد على مناديب ميدانيين' },
];

export default function LandingPage() {
  return (
    <div dir="rtl" className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: FONT_AR }}>
      {/* ===== شريط التنقّل ===== */}
      <header className="sticky top-0 z-30 backdrop-blur bg-[#FAF7F0]/85 border-b border-[#E9E1D3]">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BrandIcon size={36} />
            <span style={{ fontFamily: FONT_EN, fontWeight: 700 }} className="text-xl tracking-tight">
              <span className="text-[#1F1A13]">Field</span><span className="text-[#E15A30]">Sales</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/rep" className="hidden sm:inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-[#1F1A13] border border-[#E9E1D3] hover:border-[#E15A30] hover:text-[#E15A30] transition-colors">
              <Smartphone size={15} /> تطبيق المندوب
            </Link>
            <Link to="/login" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-[#E15A30] hover:bg-[#C94E28] transition-colors">
              <LogIn size={15} /> دخول الأدمن
            </Link>
          </div>
        </div>
      </header>

      {/* ===== البطل (Hero) ===== */}
      <section className="relative overflow-hidden bg-[#1F1A13] text-white">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 120% at 70% 0%, rgba(225,90,48,.28), transparent 55%)' }} />
        <span className="absolute rounded-full" style={{ width: 320, height: 320, top: -80, left: -60, background: 'rgba(225,90,48,.12)' }} />
        <span className="absolute rounded-full" style={{ width: 220, height: 220, bottom: -60, right: 40, background: 'rgba(30,122,82,.12)' }} />

        <div className="relative max-w-6xl mx-auto px-5 py-20 lg:py-28 text-center">
          <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-white/[0.06] border border-white/10 text-[#FCE6DC] mb-6">
            <Sparkles size={13} className="text-[#E15A30]" /> متوافق مع هيئة الزكاة والضريبة السعودية
          </span>
          <h1 className="text-4xl lg:text-6xl font-extrabold leading-[1.15] tracking-tight">
            أدِر فريق مبيعاتك الميداني
            <br />
            <span className="text-[#E15A30]">من راحة يدك</span>
          </h1>
          <p className="mt-6 text-lg lg:text-xl text-[#C9BEAC] max-w-2xl mx-auto leading-relaxed">
            منصّة <span className="text-white font-semibold">FieldSales</span> المتكاملة لإصدار الفواتير الضريبية،
            وتحصيل المدفوعات، وتتبّع المناديب — مصمّمة خصيصاً للسوق السعودي.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link to="/login" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl font-bold text-white bg-[#E15A30] hover:bg-[#C94E28] transition-colors shadow-lg shadow-[#E15A30]/30">
              <LogIn size={18} /> دخول لوحة الأدمن
            </Link>
            <Link to="/rep" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl font-bold text-white bg-white/[0.08] border border-white/15 hover:bg-white/[0.14] transition-colors">
              <Smartphone size={18} /> تطبيق المندوب
            </Link>
            <a href="#contact" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl font-bold text-[#1F1A13] bg-[#FAF7F0] hover:bg-white transition-colors">
              اطلب عرضاً تجريبياً <ArrowLeft size={18} />
            </a>
          </div>

          {/* شريط ثقة */}
          <div className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-[#9A8F7E]">
            <span className="flex items-center gap-1.5"><CheckCircle2 size={15} className="text-[#1E7A52]" /> فواتير ضريبية بـ QR</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 size={15} className="text-[#1E7A52]" /> طباعة حرارية 58مم</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 size={15} className="text-[#1E7A52]" /> تتبّع لحظي للمناديب</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 size={15} className="text-[#1E7A52]" /> آمن ومعزول</span>
          </div>
        </div>
      </section>

      {/* ===== المميزات ===== */}
      <section id="features" className="max-w-6xl mx-auto px-5 py-20">
        <div className="text-center mb-12">
          <p className="text-[#E15A30] font-bold text-sm mb-2">كل ما يحتاجه فريقك في مكان واحد</p>
          <h2 className="text-3xl lg:text-4xl font-extrabold tracking-tight">مميزات تُنجز عملك أسرع</h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {features.map((f, i) => (
            <div key={i} className="bg-white rounded-2xl p-6 border border-[#E9E1D3] hover:border-[#E8C9BC] hover:shadow-lg hover:shadow-[#E15A30]/5 transition-all">
              <div className="w-12 h-12 rounded-xl bg-[#FBEBE2] flex items-center justify-center mb-4">
                <f.icon size={24} className="text-[#E15A30]" />
              </div>
              <h3 className="font-bold text-lg mb-1.5">{f.title}</h3>
              <p className="text-sm text-[#6E6557] leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ===== لمن هذا النظام ===== */}
      <section className="bg-[#FBEBE2]/50 border-y border-[#E9E1D3]">
        <div className="max-w-6xl mx-auto px-5 py-20">
          <div className="text-center mb-12">
            <h2 className="text-3xl lg:text-4xl font-extrabold tracking-tight">مصمّم لأعمالك الميدانية</h2>
            <p className="text-[#6E6557] mt-3">إن كان لديك مناديب في الميدان، فـ FieldSales لك.</p>
          </div>
          <div className="grid sm:grid-cols-3 gap-5">
            {audience.map((a, i) => (
              <div key={i} className="bg-white rounded-2xl p-7 border border-[#E9E1D3] text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#1F1A13] flex items-center justify-center mx-auto mb-4">
                  <a.icon size={26} className="text-[#E15A30]" />
                </div>
                <p className="font-bold text-[#1F1A13]">{a.title}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== مدخلان (الأدمن / المندوب) ===== */}
      <section className="max-w-6xl mx-auto px-5 py-20">
        <div className="text-center mb-10">
          <h2 className="text-3xl lg:text-4xl font-extrabold tracking-tight">ادخل إلى نظامك</h2>
          <p className="text-[#6E6557] mt-3">اختر بوّابتك للمتابعة مباشرةً.</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-5 max-w-3xl mx-auto">
          <Link to="/login" className="group bg-white rounded-2xl p-8 border border-[#E9E1D3] hover:border-[#E15A30] hover:shadow-xl hover:shadow-[#E15A30]/10 transition-all text-center">
            <div className="w-16 h-16 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-4 group-hover:scale-105 transition-transform">
              <Building2 size={30} className="text-[#E15A30]" />
            </div>
            <h3 className="text-xl font-bold mb-1">لوحة الأدمن</h3>
            <p className="text-sm text-[#6E6557] mb-4">إدارة المنتجات والعملاء والمناديب والتقارير.</p>
            <span className="inline-flex items-center gap-1.5 text-[#E15A30] font-semibold text-sm">
              دخول <ArrowLeft size={16} className="group-hover:-translate-x-1 transition-transform" />
            </span>
          </Link>
          <Link to="/rep" className="group bg-white rounded-2xl p-8 border border-[#E9E1D3] hover:border-[#E15A30] hover:shadow-xl hover:shadow-[#E15A30]/10 transition-all text-center">
            <div className="w-16 h-16 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-4 group-hover:scale-105 transition-transform">
              <Smartphone size={30} className="text-[#E15A30]" />
            </div>
            <h3 className="text-xl font-bold mb-1">تطبيق المندوب</h3>
            <p className="text-sm text-[#6E6557] mb-4">إصدار الفواتير والسندات والتحصيل من الميدان.</p>
            <span className="inline-flex items-center gap-1.5 text-[#E15A30] font-semibold text-sm">
              دخول <ArrowLeft size={16} className="group-hover:-translate-x-1 transition-transform" />
            </span>
          </Link>
        </div>
      </section>

      {/* ===== دعوة نهائية + تواصل ===== */}
      <section id="contact" className="relative overflow-hidden bg-[#1F1A13] text-white">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 120% at 30% 100%, rgba(225,90,48,.25), transparent 55%)' }} />
        <div className="relative max-w-3xl mx-auto px-5 py-20 text-center">
          <div className="inline-flex mb-6" style={{ filter: 'drop-shadow(0 14px 36px rgba(225,90,48,.4))' }}>
            <BrandMark size={64} />
          </div>
          <h2 className="text-3xl lg:text-4xl font-extrabold tracking-tight">ابدأ بإدارة مبيعاتك اليوم</h2>
          <p className="mt-4 text-lg text-[#C9BEAC] leading-relaxed">
            اشترك بشركتك في FieldSales وأطلق العنان لفريقك الميداني — فواتير نظامية، تحصيل أسرع، ورؤية كاملة.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a href="mailto:info@fieldsa.net" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl font-bold text-white bg-[#E15A30] hover:bg-[#C94E28] transition-colors shadow-lg shadow-[#E15A30]/30">
              تواصل معنا للاشتراك
            </a>
            <Link to="/login" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl font-bold text-white bg-white/[0.08] border border-white/15 hover:bg-white/[0.14] transition-colors">
              <LogIn size={18} /> لديّ حساب — دخول
            </Link>
          </div>
          <p className="mt-6 text-sm text-[#9A8F7E]">info@fieldsa.net</p>
        </div>
      </section>

      {/* ===== التذييل ===== */}
      <footer className="bg-[#15110b] text-[#9A8F7E]">
        <div className="max-w-6xl mx-auto px-5 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <BrandMark size={28} />
            <span style={{ fontFamily: FONT_EN, fontWeight: 700 }} className="text-base">
              <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]">Sales</span>
            </span>
          </div>
          <p className="text-xs">© {new Date().getFullYear()} FieldSales — منصّة إدارة مبيعات المناديب الميدانيين. جميع الحقوق محفوظة.</p>
          <div className="flex items-center gap-4 text-sm">
            <Link to="/login" className="hover:text-white transition-colors">دخول الأدمن</Link>
            <Link to="/rep" className="hover:text-white transition-colors">المندوب</Link>
            <a href="/privacy.html" className="hover:text-white transition-colors">الخصوصية</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
