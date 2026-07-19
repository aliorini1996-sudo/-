import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Monitor, LayoutGrid, ChefHat, ScrollText, ReceiptText, Calculator, Wallet, Boxes,
  Printer, UtensilsCrossed, ArrowLeft, Check, Star, Store, ShieldCheck,
} from 'lucide-react';
import { BrandIcon, BrandMark } from '../../components/BrandLogo';

// ============================================================================
// الصفحة التعريفية لعمودية المطاعم «Field Restaurant» (M1)
// مكوّن مستقلّ — لا يمسّ صفحة هبوط التوزيع المشتركة (LandingPage) إطلاقاً.
// بناءً على طلب المالك: نفس شعار Field Sales (BrandIcon) + نفس الألوان (المرجاني
// #E15A30 والفحمي والكريمي والأخضر) + نفس تقسيمات الصفحة الرئيسية (Hero → المميزات
// → كيف يعمل → الأدوار → الأسعار → الأسئلة → دعوة ختامية → تذييل). المحتوى للمطاعم.
// كل «ابدأ مجاناً» → /signup?vertical=restaurant (تجربة 10 أيام).
// ============================================================================

const ORANGE = '#E15A30';
const ORANGE_DARK = '#C94E28';
const VOID = '#1F1A13';
const GREEN = '#1E7A52';
const SOFT = '#FBEBE2';   // خلفية رقاقة الأيقونة (مرجاني فاتح)
const ALT = '#F3EDE3';    // خلفية الأقسام البديلة

const SIGNUP = '/signup?vertical=restaurant';
const SERIF = "'IBM Plex Serif', serif";

// اسم لفظي بنفس أسلوب Field Sales (IBM Plex Serif، Field حبر + الكلمة الثانية مرجانية)
function Wordmark({ dark = false }: { dark?: boolean }) {
  return (
    <div style={{ fontFamily: SERIF, fontWeight: 600, letterSpacing: '-0.3px' }} className="text-xl">
      <span style={{ color: dark ? '#FAF7F0' : VOID }}>Field</span>
      <span style={{ color: ORANGE }}> Restaurant</span>
    </div>
  );
}

const FEATURES: { icon: React.ElementType; title: string; desc: string }[] = [
  { icon: Monitor, title: 'كاشير سريع (POS)', desc: 'شاشة كاشير لمسية بشبكة أصناف حسب الأقسام، تضيف الطلب بنقرة، وتعمل حتى دون اتصال بالإنترنت.' },
  { icon: LayoutGrid, title: 'إدارة الطاولات', desc: 'خريطة صالة بحالات الطاولات (فارغة/مشغولة/طلب الحساب)، مع دمج وتقسيم الفاتورة ونقل الطاولات.' },
  { icon: ChefHat, title: 'تذاكر المطبخ (KOT/KDS)', desc: 'ترسل الطلب لمحطة التحضير المناسبة تلقائياً، وشاشة مطبخ تتابع حالة كل صنف لحظياً.' },
  { icon: ScrollText, title: 'القوائم والإضافات', desc: 'قائمة منظّمة بأقسام وأصناف وأحجام وإضافات إلزامية/اختيارية وأسعار — تُدار من لوحة واحدة.' },
  { icon: ReceiptText, title: 'فوترة إلكترونية معتمدة', desc: 'فاتورة ضريبية مبسّطة برمز QR متوافقة مع هيئة الزكاة والضريبة (ZATCA) ومنظومة الفوترة المصرية (ETA).' },
  { icon: Calculator, title: 'محاسبة وتقارير', desc: 'قيود المبيعات اليومية، تقرير Z، المبيعات حسب الصنف/الكاشير/ساعة الذروة، وملخّص ضريبة القيمة المضافة.' },
  { icon: Wallet, title: 'الورديات ودرج النقد', desc: 'فتح/إغلاق الوردية، عدّ الدرج، واحتساب فرق النقد تلقائياً لكل كاشير — بلا تلاعب.' },
  { icon: Boxes, title: 'المخزون والوصفات', desc: 'اربط كل صنف بوصفته فيُخصم المخزون تلقائياً عند البيع، مع تنبيه نفاد المكوّنات وحساب التكلفة.' },
  { icon: Printer, title: 'طباعة حرارية 80مم', desc: 'إيصال عميل أنيق برمز الفوترة الإلكترونية + تذكرة مطبخ منفصلة — على الطابعات الحرارية المعتادة.' },
  { icon: UtensilsCrossed, title: 'كل أنواع الطلبات', desc: 'صالة (Dine-in)، سفري (Takeaway)، وتوصيل (Delivery) — بسير عمل واحد وتقارير موحّدة.' },
];

const STEPS: { n: string; title: string; desc: string }[] = [
  { n: '١', title: 'أنشئ حسابك وقائمتك', desc: 'سجّل مطعمك، أضف الأقسام والأصناف والإضافات والطاولات في دقائق.' },
  { n: '٢', title: 'افتح الكاشير واستقبل الطلبات', desc: 'يبدأ الكاشير الوردية، يفتح الطلبات، يرسلها للمطبخ، ويحصّل الدفع ويطبع الإيصال.' },
  { n: '٣', title: 'تابع المبيعات والمحاسبة', desc: 'راقب المبيعات والأرباح وتقارير الضريبة والمخزون لحظياً من لوحة واحدة.' },
];

// نفس قسم «واجهة مصمّمة لكل دور» في الصفحة الرئيسية — بأدوار المطعم
const ROLES: { icon: React.ElementType; title: string; desc: string }[] = [
  { icon: ShieldCheck, title: 'صاحب المطعم / المدير', desc: 'لوحة تحكم شاملة للمبيعات والأرباح والتقارير والمخزون عبر كل الفروع.' },
  { icon: Monitor, title: 'الكاشير والنادل', desc: 'شاشة كاشير سريعة لفتح الطلبات وإرسالها للمطبخ وتحصيل الدفع وطباعة الإيصال.' },
  { icon: ChefHat, title: 'المطبخ (الشيف)', desc: 'شاشة مطبخ تعرض التذاكر لحظياً وتتابع حالة كل صنف حتى التقديم.' },
];

const PLANS: { name: string; price: string; period?: string; limit: string; badge?: string; features: string[]; cta: string }[] = [
  { name: 'المبتدئة', price: '٢٩٩', period: 'ر.س / شهرياً', limit: 'نقطة بيع واحدة',
    features: ['كاشير POS وإدارة الطلبات', 'قائمة وطاولات', 'فاتورة إلكترونية ZATCA', 'تقارير أساسية'], cta: 'ابدأ الآن' },
  { name: 'الاحترافية', price: '٧٩٩', period: 'ر.س / شهرياً', limit: 'حتى ٣ نقاط بيع', badge: 'الأكثر طلباً',
    features: ['كل مميزات المبتدئة', 'تذاكر مطبخ KOT/KDS', 'محاسبة وتقارير متقدمة', 'المخزون والوصفات', 'دعم أولوية'], cta: 'ابدأ تجربتك المجانية' },
  { name: 'الفروع', price: 'حسب الطلب', limit: 'فروع ونقاط بيع غير محدودة',
    features: ['كل مميزات الاحترافية', 'إدارة عدّة فروع', 'صلاحيات دقيقة للموظّفين', 'تدريب وإعداد كامل'], cta: 'تواصل معنا' },
];

const FAQ: { q: string; a: string }[] = [
  { q: 'هل الفواتير متوافقة مع الأنظمة الضريبية؟', a: 'نعم — فاتورة ضريبية مبسّطة برمز QR متوافقة مع هيئة الزكاة والضريبة (ZATCA Phase 2) في السعودية، ومع منظومة الفوترة الإلكترونية (ETA) في مصر.' },
  { q: 'هل أحتاج أجهزة خاصة؟', a: 'لا — يعمل الكاشير على أي جهاز لوحي أو حاسوب عبر المتصفّح. للطباعة تكفي طابعة حرارية 80مم معتادة.' },
  { q: 'هل يعمل الكاشير دون اتصال بالإنترنت؟', a: 'نعم — تُفتح الطلبات وتُطبع وتُحصّل نقداً دون اتصال، ثم ترتفع تلقائياً فور عودة الشبكة بلا تكرار ولا فقدان.' },
  { q: 'كم يستغرق إعداد المطعم؟', a: 'تُجهّز قائمتك وطاولاتك وتبدأ استقبال الطلبات خلال دقائق. جرّبه مجاناً ١٠ أيام دون بطاقة ائتمان.' },
];

export default function RestaurantLandingPage() {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = 'Field Restaurant — نظام كاشير ومحاسبة للمطاعم';
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('lang', 'ar');
    const meta = document.querySelector('meta[name="description"]');
    const prevDesc = meta?.getAttribute('content') || '';
    meta?.setAttribute('content', 'Field Restaurant: نظام كاشير (POS) وفوترة إلكترونية ومحاسبة متكامل للمطاعم — طاولات، تذاكر مطبخ، تقارير، ومخزون. تجربة مجانية ١٠ أيام.');
    return () => { document.title = prevTitle; if (meta && prevDesc) meta.setAttribute('content', prevDesc); };
  }, []);

  return (
    <div dir="rtl" style={{ background: '#FAF7F0', color: VOID, fontFamily: "'IBM Plex Sans', 'IBM Plex Sans Arabic', sans-serif" }} className="min-h-screen">
      {/* ===== شريط التنقّل ===== */}
      <nav className="sticky top-0 z-40 backdrop-blur border-b" style={{ background: 'rgba(250,247,240,.85)', borderColor: '#E9E1D3' }}>
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between gap-4">
          <a href="#top" className="flex items-center gap-3"><BrandIcon size={36} /><Wordmark /></a>
          <div className="hidden md:flex items-center gap-6 text-sm text-[#6E6557]">
            <a href="#features" className="hover:text-[#1F1A13]">المميزات</a>
            <a href="#how" className="hover:text-[#1F1A13]">كيف يعمل</a>
            <a href="#pricing" className="hover:text-[#1F1A13]">الأسعار</a>
            <a href="#faq" className="hover:text-[#1F1A13]">الأسئلة</a>
          </div>
          <div className="flex items-center gap-2.5">
            <Link to="/login" className="text-sm font-semibold text-[#6E6557] hover:text-[#1F1A13] px-2">دخول</Link>
            <Link to={SIGNUP} className="text-sm font-bold text-white px-4 py-2 rounded-xl transition-colors" style={{ background: ORANGE }}
              onMouseOver={e => (e.currentTarget.style.background = ORANGE_DARK)} onMouseOut={e => (e.currentTarget.style.background = ORANGE)}>
              ابدأ مجاناً
            </Link>
          </div>
        </div>
      </nav>

      {/* ===== Hero ===== */}
      <header id="top" className="relative overflow-hidden">
        <div className="absolute inset-0" style={{ background: `radial-gradient(120% 120% at 85% 0%, ${ORANGE}22, transparent 55%)` }} />
        <div className="relative max-w-6xl mx-auto px-5 pt-16 pb-20 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold mb-5" style={{ background: SOFT, color: ORANGE_DARK }}>
              <Star size={13} /> نظام تشغيل مطاعم عربي متكامل
            </span>
            <h1 className="text-4xl sm:text-5xl font-bold leading-[1.15] tracking-tight">
              أدِر مطعمك بالكامل<br /><span style={{ color: ORANGE }}>من الكاشير حتى المحاسبة</span>
            </h1>
            <p className="mt-5 text-[15px] leading-relaxed text-[#6E6557] max-w-xl">
              كاشير سريع، إدارة طاولات وقوائم، تذاكر مطبخ، فوترة إلكترونية معتمدة، ومحاسبة وتقارير دقيقة —
              كل ما يحتاجه مطعمك في منصّة واحدة تعمل على أي جهاز.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to={SIGNUP} className="inline-flex items-center gap-2 text-white font-bold px-6 py-3.5 rounded-xl transition-colors" style={{ background: ORANGE }}
                onMouseOver={e => (e.currentTarget.style.background = ORANGE_DARK)} onMouseOut={e => (e.currentTarget.style.background = ORANGE)}>
                ابدأ تجربتك المجانية <ArrowLeft size={18} />
              </Link>
              <a href="#features" className="inline-flex items-center gap-2 font-semibold px-6 py-3.5 rounded-xl border" style={{ borderColor: '#DED5C4', color: VOID }}>
                شاهد المميزات
              </a>
            </div>
            <p className="mt-4 text-xs text-[#9A8F7E]">١٠ أيام مجاناً · بدون بطاقة ائتمان · إلغاء في أي وقت</p>
          </div>

          {/* بطاقة معاينة الكاشير */}
          <div className="relative">
            <div className="rounded-3xl border shadow-2xl p-5 bg-white" style={{ borderColor: '#E9E1D3' }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: ORANGE }}><Monitor size={16} className="text-white" /></span>
                  <span className="text-sm font-bold">طلب #١٤ — طاولة ٧</span>
                </div>
                <span className="text-xs px-2 py-1 rounded-full" style={{ background: '#EAF5EF', color: GREEN }}>مفتوح</span>
              </div>
              <div className="space-y-2.5">
                {[['برجر لحم مشوي ×٢', '٥٨٫٠٠'], ['بطاطس مقلية كبير', '١٦٫٠٠'], ['عصير برتقال طازج ×٢', '٢٤٫٠٠']].map(([n, p], i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="text-[#3a342b]">{n}</span>
                    <span className="font-semibold tabular-nums">{p}</span>
                  </div>
                ))}
              </div>
              <div className="border-t my-3.5" style={{ borderColor: '#E9E1D3' }} />
              <div className="flex items-center justify-between text-sm text-[#6E6557]"><span>ضريبة القيمة المضافة (١٥٪)</span><span className="tabular-nums">١٤٫٧٠</span></div>
              <div className="flex items-center justify-between mt-1.5"><span className="font-bold">الإجمالي</span><span className="font-bold text-lg tabular-nums" style={{ color: ORANGE }}>١١٢٫٧٠ ر.س</span></div>
              <button className="w-full mt-4 text-white font-bold py-3 rounded-xl" style={{ background: GREEN }}>دفع وطباعة الإيصال</button>
            </div>
            <div className="absolute -bottom-4 -left-4 rounded-2xl px-4 py-3 shadow-xl hidden sm:flex items-center gap-2" style={{ background: VOID }}>
              <ChefHat size={18} style={{ color: ORANGE }} />
              <span className="text-white text-xs font-semibold">تذكرة المطبخ أُرسلت</span>
            </div>
          </div>
        </div>
      </header>

      {/* ===== المميزات ===== */}
      <section id="features" className="max-w-6xl mx-auto px-5 py-20">
        <div className="text-center max-w-2xl mx-auto">
          <div className="text-xs font-semibold tracking-widest uppercase" style={{ color: ORANGE }}>المميزات</div>
          <h2 className="text-3xl font-bold mt-3 tracking-tight">كل ما يحتاجه مطعمك في منصّة واحدة</h2>
          <p className="text-[#6E6557] mt-3">من نقطة البيع في الصالة إلى قيد المحاسبة الذي يصل مكتب المدير — كل شيء متصل ومتزامن.</p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-12">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-2xl border p-5 bg-white transition-shadow hover:shadow-lg" style={{ borderColor: '#E9E1D3' }}>
              <span className="w-11 h-11 rounded-xl flex items-center justify-center mb-3.5" style={{ background: SOFT }}>
                <Icon size={21} style={{ color: ORANGE }} />
              </span>
              <h3 className="font-bold text-[15px]">{title}</h3>
              <p className="text-sm text-[#6E6557] mt-1.5 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ===== كيف يعمل ===== */}
      <section id="how" style={{ background: ALT }}>
        <div className="max-w-6xl mx-auto px-5 py-20">
          <div className="text-center max-w-2xl mx-auto">
            <div className="text-xs font-semibold tracking-widest uppercase" style={{ color: ORANGE }}>كيف يعمل</div>
            <h2 className="text-3xl font-bold mt-3 tracking-tight">تبدأ خلال دقائق</h2>
            <p className="text-[#6E6557] mt-3">ثلاث خطوات تفصلك عن إدارة مطعمك بالكامل.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-6 mt-12">
            {STEPS.map(({ n, title, desc }) => (
              <div key={n} className="rounded-2xl bg-white border p-6 text-center" style={{ borderColor: '#E9E1D3' }}>
                <span className="w-12 h-12 rounded-2xl inline-flex items-center justify-center text-white text-xl font-bold mb-4" style={{ background: ORANGE }}>{n}</span>
                <h3 className="font-bold">{title}</h3>
                <p className="text-sm text-[#6E6557] mt-2 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== الأدوار (واجهة مصمّمة لكل دور) ===== */}
      <section className="max-w-6xl mx-auto px-5 py-20">
        <div className="text-center max-w-2xl mx-auto">
          <div className="text-xs font-semibold tracking-widest uppercase" style={{ color: ORANGE }}>لكل دور</div>
          <h2 className="text-3xl font-bold mt-3 tracking-tight">واجهة مصمّمة لكل دور في مطعمك</h2>
        </div>
        <div className="grid md:grid-cols-3 gap-5 mt-12">
          {ROLES.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-2xl border p-6 bg-white" style={{ borderColor: '#E9E1D3' }}>
              <span className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4" style={{ background: VOID }}>
                <Icon size={22} style={{ color: ORANGE }} />
              </span>
              <h3 className="font-bold">{title}</h3>
              <p className="text-sm text-[#6E6557] mt-2 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ===== الأسعار ===== */}
      <section id="pricing" style={{ background: ALT }}>
        <div className="max-w-6xl mx-auto px-5 py-20">
          <div className="text-center max-w-2xl mx-auto">
            <div className="text-xs font-semibold tracking-widest uppercase" style={{ color: ORANGE }}>الأسعار</div>
            <h2 className="text-3xl font-bold mt-3 tracking-tight">باقات تناسب نمو مطعمك</h2>
            <p className="text-[#6E6557] mt-3">ابدأ مجاناً ١٠ أيام — بدون بطاقة ائتمان.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-5 mt-12 items-stretch">
            {PLANS.map(p => (
              <div key={p.name} className="rounded-2xl border bg-white p-6 flex flex-col relative"
                style={{ borderColor: p.badge ? ORANGE : '#E9E1D3', borderWidth: p.badge ? 2 : 1 }}>
                {p.badge && (
                  <span className="absolute -top-3 right-6 text-xs font-bold text-white px-3 py-1 rounded-full" style={{ background: ORANGE }}>{p.badge}</span>
                )}
                <h3 className="font-bold text-lg">{p.name}</h3>
                <p className="text-sm text-[#9A8F7E] mt-1">{p.limit}</p>
                <div className="mt-4 flex items-end gap-1.5">
                  <span className="text-3xl font-bold" style={{ color: ORANGE }}>{p.price}</span>
                  {p.period && <span className="text-sm text-[#6E6557] mb-1">{p.period}</span>}
                </div>
                <ul className="mt-5 space-y-2.5 flex-1">
                  {p.features.map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm text-[#3a342b]">
                      <Check size={17} className="shrink-0 mt-0.5" style={{ color: GREEN }} /> {f}
                    </li>
                  ))}
                </ul>
                <Link to={SIGNUP} className="mt-6 text-center font-bold py-2.5 rounded-xl transition-colors"
                  style={p.badge ? { background: ORANGE, color: '#fff' } : { border: '1.5px solid #DED5C4', color: VOID }}>
                  {p.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== الأسئلة الشائعة ===== */}
      <section id="faq" className="max-w-3xl mx-auto px-5 py-20">
        <div className="text-center">
          <div className="text-xs font-semibold tracking-widest uppercase" style={{ color: ORANGE }}>FAQ</div>
          <h2 className="text-3xl font-bold mt-3 tracking-tight">أسئلة شائعة</h2>
        </div>
        <div className="mt-10 space-y-3">
          {FAQ.map(({ q, a }) => (
            <details key={q} className="group rounded-2xl bg-white border p-5" style={{ borderColor: '#E9E1D3' }}>
              <summary className="flex items-center justify-between cursor-pointer font-bold list-none">
                {q}
                <span className="text-2xl leading-none transition-transform group-open:rotate-45" style={{ color: ORANGE }}>+</span>
              </summary>
              <p className="text-sm text-[#6E6557] mt-3 leading-relaxed">{a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ===== دعوة نهائية ===== */}
      <section className="relative overflow-hidden" style={{ background: VOID }}>
        <div className="absolute inset-0" style={{ background: `radial-gradient(90% 120% at 80% 0%, ${ORANGE}44, transparent 60%)` }} />
        <div className="relative max-w-3xl mx-auto px-5 py-20 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">جاهز لتشغيل مطعمك باحتراف؟</h2>
          <p className="text-[#C9BEAC] mt-4 max-w-xl mx-auto leading-relaxed">
            افتح الكاشير، أدِر طاولاتك، أصدر فواتيرك الإلكترونية، وتابع محاسبتك — كل ذلك من منصّة واحدة.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to={SIGNUP} className="inline-flex items-center gap-2 text-white font-bold px-7 py-3.5 rounded-xl" style={{ background: ORANGE }}>
              ابدأ تجربتك المجانية <ArrowLeft size={18} />
            </Link>
            <Link to="/login" className="inline-flex items-center gap-2 font-semibold px-7 py-3.5 rounded-xl border border-white/20 text-white">
              تسجيل الدخول
            </Link>
          </div>
          <p className="mt-4 text-xs text-[#9A8F7E]">١٠ أيام مجاناً · بدون بطاقة ائتمان · إلغاء في أي وقت</p>
        </div>
      </section>

      {/* ===== التذييل ===== */}
      <footer style={{ background: '#17130D' }} className="text-[#C9BEAC]">
        <div className="max-w-6xl mx-auto px-5 py-12">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-3"><BrandMark size={34} /><Wordmark dark /></div>
            <div className="flex items-center gap-6 text-sm">
              <a href="#features" className="hover:text-white">المميزات</a>
              <a href="#pricing" className="hover:text-white">الأسعار</a>
              <Link to="/terms" className="hover:text-white">الشروط</Link>
              <Link to="/privacy" className="hover:text-white">الخصوصية</Link>
            </div>
          </div>
          <div className="border-t border-white/10 mt-8 pt-6 text-center text-xs text-[#9A8F7E]">
            © ٢٠٢٦ Field Restaurant — فرع من منصّة Field. جميع الحقوق محفوظة.
          </div>
        </div>
      </footer>
    </div>
  );
}
