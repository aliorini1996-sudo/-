import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandIcon, BrandMark } from '../components/BrandLogo';
import {
  QrCode, Printer, Wallet, FileSpreadsheet, ShieldCheck,
  Building2, Share2, TrendingUp, CheckCircle2, ArrowLeft, ArrowRight, LogIn,
  Smartphone, Sparkles, Truck, ShoppingBasket, Boxes, Globe,
} from 'lucide-react';

const FONT_AR = "'IBM Plex Sans Arabic', sans-serif";
const FONT_EN = "'IBM Plex Sans', sans-serif";

// الأيقونات مشتركة بين اللغتين (مستقلّة عن النص)
const FEATURE_ICONS = [QrCode, Printer, Wallet, FileSpreadsheet, TrendingUp, ShieldCheck, Building2, Share2];
const AUDIENCE_ICONS = [Truck, ShoppingBasket, Boxes];

const CONTENT = {
  ar: {
    nav: { rep: 'تطبيق المندوب', admin: 'دخول الأدمن', lang: 'English' },
    hero: {
      badge: 'متوافق مع هيئة الزكاة والضريبة السعودية',
      title1: 'أدِر فريق مبيعاتك الميداني', title2: 'من راحة يدك',
      subtitle: 'منصّة FieldSales المتكاملة لإصدار الفواتير الضريبية، وتحصيل المدفوعات، وتتبّع المناديب — مصمّمة خصيصاً للسوق السعودي.',
      ctaAdmin: 'دخول لوحة الأدمن', ctaRep: 'تطبيق المندوب', ctaDemo: 'اطلب عرضاً تجريبياً',
      trust: ['فواتير ضريبية بـ QR', 'طباعة حرارية 58مم', 'تتبّع لحظي للمناديب', 'آمن ومعزول'],
    },
    features: {
      tag: 'كل ما يحتاجه فريقك في مكان واحد', title: 'مميزات تُنجز عملك أسرع',
      items: [
        { title: 'فواتير ضريبية ZATCA', desc: 'فواتير متوافقة مع هيئة الزكاة والضريبة مع رمز QR تلقائي وتصنيف ذكي.' },
        { title: 'طباعة حرارية فورية', desc: 'اطبع الفاتورة من الميدان مباشرةً عبر طابعة بلوتوث أو مدمجة بعرض 58مم.' },
        { title: 'سندات القبض والتحصيل', desc: 'سجّل المدفوعات نقداً أو تحويلاً أو شبكة أو شيكاً، واربطها بالفواتير لحظياً.' },
        { title: 'كشوف حساب لحظية', desc: 'اعرض رصيد أي عميل وكامل حركاته في أي لحظة، وصدّرها Excel أو PDF.' },
        { title: 'تتبّع الأداء بالوقت الفعلي', desc: 'لوحة أداء تُظهر مبيعات وتحصيلات كل مندوب لحظةً بلحظة.' },
        { title: 'صلاحيات دقيقة لكل مندوب', desc: 'تحكّم بما يفعله كل مندوب — الخصم، تغيير السعر، التحصيل، إضافة العملاء.' },
        { title: 'عزل كامل وأمان', desc: 'كل شركة لها مساحتها المعزولة تماماً، واتصال مشفّر، وبيانات محمية.' },
        { title: 'تصدير ومشاركة بضغطة', desc: 'صدّر الفواتير والسندات والكشوف وأداء المناديب إلى Excel أو شاركها فوراً.' },
      ],
    },
    audience: {
      title: 'مصمّم لأعمالك الميدانية', sub: 'إن كان لديك مناديب في الميدان، فـ FieldSales لك.',
      items: ['شركات التوزيع الميداني (DSD)', 'موزّعو المواد الغذائية والاستهلاكية', 'أي نشاط يعتمد على مناديب ميدانيين'],
    },
    gates: {
      title: 'ادخل إلى نظامك', sub: 'اختر بوّابتك للمتابعة مباشرةً.',
      admin: { title: 'لوحة الأدمن', desc: 'إدارة المنتجات والعملاء والمناديب والتقارير.', cta: 'دخول' },
      rep: { title: 'تطبيق المندوب', desc: 'إصدار الفواتير والسندات والتحصيل من الميدان.', cta: 'دخول' },
    },
    cta: {
      title: 'ابدأ بإدارة مبيعاتك اليوم',
      desc: 'اشترك بشركتك في FieldSales وأطلق العنان لفريقك الميداني — فواتير نظامية، تحصيل أسرع، ورؤية كاملة.',
      contact: 'تواصل معنا للاشتراك', haveAccount: 'لديّ حساب — دخول',
    },
    footer: { rights: 'منصّة إدارة مبيعات المناديب الميدانيين. جميع الحقوق محفوظة.', admin: 'دخول الأدمن', rep: 'المندوب', privacy: 'الخصوصية' },
  },
  en: {
    nav: { rep: 'Rep App', admin: 'Admin Login', lang: 'العربية' },
    hero: {
      badge: 'Compliant with Saudi ZATCA e-invoicing',
      title1: 'Manage your field sales team', title2: 'from the palm of your hand',
      subtitle: 'FieldSales — the all-in-one platform for issuing tax invoices, collecting payments, and tracking reps. Built for the Saudi market.',
      ctaAdmin: 'Admin Login', ctaRep: 'Rep App', ctaDemo: 'Request a demo',
      trust: ['Tax invoices with QR', '58mm thermal printing', 'Real-time rep tracking', 'Secure & isolated'],
    },
    features: {
      tag: 'Everything your team needs in one place', title: 'Features that get work done faster',
      items: [
        { title: 'ZATCA Tax Invoices', desc: 'Invoices compliant with ZATCA, with automatic QR code and smart classification.' },
        { title: 'Instant Thermal Printing', desc: 'Print invoices in the field via Bluetooth or a built-in 58mm printer.' },
        { title: 'Receipts & Collections', desc: 'Record payments by cash, transfer, POS or cheque, linked to invoices instantly.' },
        { title: 'Real-time Statements', desc: "View any customer's balance and full history anytime, export to Excel or PDF." },
        { title: 'Real-time Performance', desc: "A live dashboard showing each rep's sales and collections moment by moment." },
        { title: 'Granular Rep Permissions', desc: 'Control what each rep can do — discounts, price changes, collections, adding customers.' },
        { title: 'Full Isolation & Security', desc: 'Each company gets a fully isolated space, encrypted connection, and protected data.' },
        { title: 'One-tap Export & Share', desc: 'Export invoices, receipts, statements and rep performance to Excel, or share instantly.' },
      ],
    },
    audience: {
      title: 'Built for your field operations', sub: 'If you have reps in the field, FieldSales is for you.',
      items: ['Direct Store Delivery (DSD) companies', 'Food & consumer goods distributors', 'Any business with field sales reps'],
    },
    gates: {
      title: 'Enter your system', sub: 'Choose your portal to continue.',
      admin: { title: 'Admin Dashboard', desc: 'Manage products, customers, reps and reports.', cta: 'Login' },
      rep: { title: 'Sales Rep App', desc: 'Issue invoices, receipts and collect from the field.', cta: 'Login' },
    },
    cta: {
      title: 'Start managing your sales today',
      desc: 'Subscribe your company to FieldSales and empower your field team — compliant invoices, faster collections, full visibility.',
      contact: 'Contact us to subscribe', haveAccount: 'I have an account — Login',
    },
    footer: { rights: 'Field sales management platform. All rights reserved.', admin: 'Admin Login', rep: 'Rep', privacy: 'Privacy' },
  },
};

export default function LandingPage() {
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const isAr = lang === 'ar';
  const t = CONTENT[lang];
  const Arrow = isAr ? ArrowLeft : ArrowRight;

  return (
    <div dir={isAr ? 'rtl' : 'ltr'} className="min-h-screen bg-[#FAF7F0] text-[#1F1A13]" style={{ fontFamily: isAr ? FONT_AR : FONT_EN }}>
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
            <button onClick={() => setLang(isAr ? 'en' : 'ar')} title="Language / اللغة"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-[#1F1A13] border border-[#E9E1D3] hover:border-[#E15A30] hover:text-[#E15A30] transition-colors">
              <Globe size={15} /> {t.nav.lang}
            </button>
            <Link to="/rep" className="hidden sm:inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-[#1F1A13] border border-[#E9E1D3] hover:border-[#E15A30] hover:text-[#E15A30] transition-colors">
              <Smartphone size={15} /> {t.nav.rep}
            </Link>
            <Link to="/login" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-[#E15A30] hover:bg-[#C94E28] transition-colors">
              <LogIn size={15} /> {t.nav.admin}
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
            <Sparkles size={13} className="text-[#E15A30]" /> {t.hero.badge}
          </span>
          <h1 className="text-4xl lg:text-6xl font-extrabold leading-[1.15] tracking-tight">
            {t.hero.title1}
            <br />
            <span className="text-[#E15A30]">{t.hero.title2}</span>
          </h1>
          <p className="mt-6 text-lg lg:text-xl text-[#C9BEAC] max-w-2xl mx-auto leading-relaxed">{t.hero.subtitle}</p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link to="/login" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl font-bold text-white bg-[#E15A30] hover:bg-[#C94E28] transition-colors shadow-lg shadow-[#E15A30]/30">
              <LogIn size={18} /> {t.hero.ctaAdmin}
            </Link>
            <Link to="/rep" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl font-bold text-white bg-white/[0.08] border border-white/15 hover:bg-white/[0.14] transition-colors">
              <Smartphone size={18} /> {t.hero.ctaRep}
            </Link>
            <a href="#contact" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl font-bold text-[#1F1A13] bg-[#FAF7F0] hover:bg-white transition-colors">
              {t.hero.ctaDemo} <Arrow size={18} />
            </a>
          </div>

          <div className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-[#9A8F7E]">
            {t.hero.trust.map((item, i) => (
              <span key={i} className="flex items-center gap-1.5"><CheckCircle2 size={15} className="text-[#1E7A52]" /> {item}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ===== المميزات ===== */}
      <section id="features" className="max-w-6xl mx-auto px-5 py-20">
        <div className="text-center mb-12">
          <p className="text-[#E15A30] font-bold text-sm mb-2">{t.features.tag}</p>
          <h2 className="text-3xl lg:text-4xl font-extrabold tracking-tight">{t.features.title}</h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {t.features.items.map((f, i) => {
            const Icon = FEATURE_ICONS[i];
            return (
              <div key={i} className="bg-white rounded-2xl p-6 border border-[#E9E1D3] hover:border-[#E8C9BC] hover:shadow-lg hover:shadow-[#E15A30]/5 transition-all">
                <div className="w-12 h-12 rounded-xl bg-[#FBEBE2] flex items-center justify-center mb-4">
                  <Icon size={24} className="text-[#E15A30]" />
                </div>
                <h3 className="font-bold text-lg mb-1.5">{f.title}</h3>
                <p className="text-sm text-[#6E6557] leading-relaxed">{f.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ===== لمن هذا النظام ===== */}
      <section className="bg-[#FBEBE2]/50 border-y border-[#E9E1D3]">
        <div className="max-w-6xl mx-auto px-5 py-20">
          <div className="text-center mb-12">
            <h2 className="text-3xl lg:text-4xl font-extrabold tracking-tight">{t.audience.title}</h2>
            <p className="text-[#6E6557] mt-3">{t.audience.sub}</p>
          </div>
          <div className="grid sm:grid-cols-3 gap-5">
            {t.audience.items.map((a, i) => {
              const Icon = AUDIENCE_ICONS[i];
              return (
                <div key={i} className="bg-white rounded-2xl p-7 border border-[#E9E1D3] text-center">
                  <div className="w-14 h-14 rounded-2xl bg-[#1F1A13] flex items-center justify-center mx-auto mb-4">
                    <Icon size={26} className="text-[#E15A30]" />
                  </div>
                  <p className="font-bold text-[#1F1A13]">{a}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ===== مدخلان (الأدمن / المندوب) ===== */}
      <section className="max-w-6xl mx-auto px-5 py-20">
        <div className="text-center mb-10">
          <h2 className="text-3xl lg:text-4xl font-extrabold tracking-tight">{t.gates.title}</h2>
          <p className="text-[#6E6557] mt-3">{t.gates.sub}</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-5 max-w-3xl mx-auto">
          {([['/login', Building2, t.gates.admin], ['/rep', Smartphone, t.gates.rep]] as const).map(([to, Icon, g], i) => (
            <Link key={i} to={to} className="group bg-white rounded-2xl p-8 border border-[#E9E1D3] hover:border-[#E15A30] hover:shadow-xl hover:shadow-[#E15A30]/10 transition-all text-center">
              <div className="w-16 h-16 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-4 group-hover:scale-105 transition-transform">
                <Icon size={30} className="text-[#E15A30]" />
              </div>
              <h3 className="text-xl font-bold mb-1">{g.title}</h3>
              <p className="text-sm text-[#6E6557] mb-4">{g.desc}</p>
              <span className="inline-flex items-center gap-1.5 text-[#E15A30] font-semibold text-sm">
                {g.cta} <Arrow size={16} />
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* ===== دعوة نهائية + تواصل ===== */}
      <section id="contact" className="relative overflow-hidden bg-[#1F1A13] text-white">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 120% at 30% 100%, rgba(225,90,48,.25), transparent 55%)' }} />
        <div className="relative max-w-3xl mx-auto px-5 py-20 text-center">
          <div className="inline-flex mb-6" style={{ filter: 'drop-shadow(0 14px 36px rgba(225,90,48,.4))' }}>
            <BrandMark size={64} />
          </div>
          <h2 className="text-3xl lg:text-4xl font-extrabold tracking-tight">{t.cta.title}</h2>
          <p className="mt-4 text-lg text-[#C9BEAC] leading-relaxed">{t.cta.desc}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a href="mailto:info@fieldsa.net" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl font-bold text-white bg-[#E15A30] hover:bg-[#C94E28] transition-colors shadow-lg shadow-[#E15A30]/30">
              {t.cta.contact}
            </a>
            <Link to="/login" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl font-bold text-white bg-white/[0.08] border border-white/15 hover:bg-white/[0.14] transition-colors">
              <LogIn size={18} /> {t.cta.haveAccount}
            </Link>
          </div>
          <p className="mt-6 text-sm text-[#9A8F7E]" dir="ltr">info@fieldsa.net</p>
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
          <p className="text-xs text-center">© {new Date().getFullYear()} FieldSales — {t.footer.rights}</p>
          <div className="flex items-center gap-4 text-sm">
            <Link to="/login" className="hover:text-white transition-colors">{t.footer.admin}</Link>
            <Link to="/rep" className="hover:text-white transition-colors">{t.footer.rep}</Link>
            <a href="/privacy.html" className="hover:text-white transition-colors">{t.footer.privacy}</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
