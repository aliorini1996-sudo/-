import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { Home, FileText, CreditCard, Users, MapPin, LogOut, Download, ClipboardCheck } from 'lucide-react';
import { companyApi } from '../api/client';
import { BrandIcon } from '../components/BrandLogo';
import AppIntro from '../components/AppIntro';
import LanguageToggle from '../components/LanguageToggle';
import { useAuthStore } from '../store/authStore';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';
import { useTr } from '../i18n/strings';
import { User } from '../types';
import MobileLogin from './MobileLogin';
import MHome, { HomeSection } from './MHome';
import MCustomers from './MCustomers';
import MDocList from './MDocList';
import MDailyReports from './MDailyReports';
const MTracking = lazy(() => import('./MTracking'));
/* أقسام الإدارة في حزمٍ كسولة: ثلاث شاشاتٍ ثقيلة (جداول ونماذج وتقارير) لا
 * يدفع ثمنها من لم يفتحها — والرئيسية أوّل ما يُحمَّل عند كل إقلاع. */
const MSalesReps = lazy(() => import('./MSalesReps'));
const MProducts = lazy(() => import('./MProducts'));
const MReports = lazy(() => import('./MReports'));
const MWarehouse = lazy(() => import('./MWarehouse'));
import { MEmpty, MSpinner } from './mobileUi';
import { can, PermKey } from './perms';
import { useBackClose } from '../lib/useBackClose';

/**
 * تطبيق الإدارة على الجوال (`/m`) — قوقعة مستقلّة على نمط تطبيق المندوب:
 * شريط علويّ داكن، جسم يبدّل الشاشات بالحالة لا بالمسارات، شريط سفليّ.
 *
 * **يتشارك جلسة لوحة الشركة** (مفتاحا `token`/`user`) — نفس الإنسان لا هوية
 * ثانية. وثمن ذلك: الخروج من هنا يُخرج تبويب اللوحة في المتصفّح نفسه.
 *
 * وهو **أون‑لاين فقط** بخلاف تطبيق المندوب: منظومة العمل دون اتصال مربوطة
 * بهوية مندوب في صميمها (تختم المستندات بـ`repId` وترفع عبر مسارات المندوب)،
 * ومسار الفواتير الإداريّ لا يقبل `clientRef` فلا حماية من التكرار.
 */
type Screen = 'home' | 'invoices' | 'receipts' | 'dailyReports' | 'customers' | 'tracking';

interface Tab { id: Screen; label: string; icon: React.ElementType; perm: PermKey }

const TABS: Tab[] = [
  { id: 'home', label: 'm.tabHome', icon: Home, perm: 'canAccessDashboard' },
  { id: 'invoices', label: 'm.tabInvoices', icon: FileText, perm: 'canManageInvoices' },
  { id: 'receipts', label: 'm.tabReceipts', icon: CreditCard, perm: 'canManageReceipts' },
  // يحلّ محلّ «التحصيل» حين تُفعّل الشركة التقرير اليومي — انظر `tabs` أدناه
  { id: 'dailyReports', label: 'm.tabDailyReports', icon: ClipboardCheck, perm: 'canViewReports' },
  { id: 'customers', label: 'm.tabCustomers', icon: Users, perm: 'canManageCustomers' },
  { id: 'tracking', label: 'm.tabTracking', icon: MapPin, perm: 'canManageTracking' },
];

/** حدث تثبيت PWA — غير معرَّف في lib.dom */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export default function MobileApp() {
  const tr = useTr();
  const { token, user, login, logout } = useAuthStore();
  // شاشة تعريفية قبل الدخول (متطلّب App Store 5.1.1(v)): يفتح التطبيق عليها لا على الدخول
  const [showLogin, setShowLogin] = useState(false);
  const [screen, setScreen] = useState<Screen>('home');
  /* قسمٌ إداريّ مفتوحٌ فوق كل شيء — طبقةٌ لا تبويب: هذه صفحاتٌ يدخلها المستخدم
   * ليضبط شيئاً ثمّ يخرج، لا محطّاتٌ يتنقّل بينها طوال اليوم. */
  const [section, setSection] = useState<HomeSection | null>(null);
  const [installEvt, setInstallEvt] = useState<InstallPromptEvent | null>(null);
  // إعدادات الشركة — تُمرَّر لطابع المستندات (ترويسة، رقم ضريبي، رمز ZATCA)
  const [company, setCompany] = useState<unknown>(null);

  // «النظام المحاسبي» — مفعّل افتراضياً، فغيابه يعني مفعّل لا مطفأ
  const accountingOn = (company as { accountingEnabled?: boolean } | null)?.accountingEnabled !== false;
  /* «التقرير اليومي» — مطفأ افتراضياً، فالشرط `=== true` لا `!== false`.
   * وقلبه هنا يُظهر التبويب لكل شركة تعذّرت قراءة إعداداتها. */
  const dailyReportOn = (company as { dailyReportEnabled?: boolean } | null)?.dailyReportEnabled === true;
  /* «مخزون الشركة» ميزة اشتراك **مطفأة افتراضياً** — الشرط `=== true` لا
   * `!== false`، بعكس النظام المحاسبيّ المفعّل افتراضاً. */
  const warehouseOn = (company as { warehouseEnabled?: boolean } | null)?.warehouseEnabled === true;

  // التبويبات المسموحة لهذا المستخدم — المنع عند `false` الصريحة وحدها،
  // ثم إسقاط التبويبين المحاسبيين حين يُطفئ المالك الميزة عن الشركة
  /* التقارير اليومية **تحلّ محلّ** التحصيل لا تُضاف إليه: الشريط السفليّ
   * خمسة تبويبات على عرض جوال، وسادسٌ يضغطها حتى تتلاصق أيقوناتها.
   * وثمنُ ذلك صريح: قائمة السندات تصير غير مبلوغة من تطبيق الجوال لشركةٍ
   * فعّلت الميزة — تبقى في لوحة الويب، ورقم تحصيل اليوم يبقى في الرئيسية. */
  const tabs = useMemo(
    () => TABS.filter(t => {
      if (!can(user, t.perm)) return false;
      if (t.id === 'dailyReports') return dailyReportOn;
      if (t.id === 'receipts' && dailyReportOn) return false;
      if (!accountingOn && (t.id === 'invoices' || t.id === 'receipts')) return false;
      return true;
    }),
    [user, accountingOn, dailyReportOn]
  );

  /* ═══ شاشةٌ متاحةٌ بلا مقعد ═══
   *
   * «التقارير اليومية» تحلّ محلّ «التحصيل» في الشريط السفليّ حين تُفعّلها
   * الشركة (المقاعد خمسة وقد امتلأت)، فتصير شاشة السندات بلا طريقٍ في التطبيق
   * كلّه — لا من تبويب ولا من بلاطة. وهي شاشةٌ يملك المستخدم صلاحيتها ويحتاجها
   * يومياً. فتُبلَغ من شاشة الفواتير بزرٍّ في أعلاها.
   *
   * والشرط ثلاثيّ يطابق شرط التبويب حرفاً: لا مقعد لها · النظام المحاسبيّ
   * مفعّل · وله صلاحية السندات. وإسقاط أيٍّ منها يعطي زرّاً يُفضي إلى شاشةٍ
   * فارغة أو إلى ٤٠٣. */
  const receiptsSeatless = !tabs.some(t => t.id === 'receipts')
    && accountingOn && can(user, 'canManageReceipts');

  // أوّل تبويب مسموح يصير الشاشة الافتراضية، فلا تُفتح القوقعة على شاشة محجوبة.
  // و«بلا مقعد» ليست «محجوبة»: بلوغها من زرٍّ لا من تبويب، فلا تُرتدّ عنه.
  useEffect(() => {
    if (!tabs.length) return;
    if (tabs.some(t => t.id === screen)) return;
    if (screen === 'receipts' && receiptsSeatless) return;
    setScreen(tabs[0].id);
  }, [tabs, screen, receiptsSeatless]);

  /* بلاطات أقسام الإدارة في الرئيسية — تُحسب هنا لا في MHome: الصلاحيات شأن
   * القوقعة، والشاشة تعرض ما يُعطى لها. والمنع عند `false` الصريحة وحدها كبقيّة
   * التطبيق، وإلا حُجبت الأقسام عن مدير الشركة الأصليّ المُنشأ قبل أعمدة الصلاحيات. */
  /* و«المنتجات» تسقط كاملةً حين يُطفأ النظام المحاسبي: الشاشة كلّها أسعارٌ
   * وشرائح تسعير، ومسار `/products` خلف `requireAccounting` في الخادم — فبلاطةٌ
   * تُفضي إلى ٤٠٣ تقول للمستخدم إنّ ثمّة أرقاماً حُجبت عنه، وذاك تسريبٌ بذاته. */
  const allowedSections = useMemo<HomeSection[]>(() => {
    const out: HomeSection[] = [];
    if (can(user, 'canManageSalesReps')) out.push('reps');
    if (can(user, 'canManageProducts') && accountingOn) out.push('products');
    if (can(user, 'canViewReports')) out.push('reports');
    /* مخزون الشركة بحارسٍ ثلاثيّ يطابق حارس الخادم: الصلاحية، ثمّ النظام
     * المحاسبيّ، ثمّ ميزة المستودع. وبلاطةٌ تُفضي إلى ٤٠٣ أسوأ من غيابها. */
    if (can(user, 'canManageVanStock') && accountingOn && warehouseOn) out.push('warehouse');
    return out;
  }, [user, accountingOn, warehouseOn]);

  /* قسمٌ مفتوحٌ خرج من قائمة المسموح (وصلت إعدادات الشركة بعد فتحه) يُغلق —
   * وإلا بقيت شاشة المنتجات معروضةً فوق كل شيء بأسعارها. */
  useEffect(() => {
    if (section && !allowedSections.includes(section)) setSection(null);
  }, [section, allowedSections]);

  /* ═══ زرّ الرجوع (أندرويد) وسحبة الحافة (آيفون) ═══
   * طبقات الشاشات الداخلية مربوطة في مكوّناتها؛ هنا الجذر وحده.
   * والعودة إلى `tabs[0].id` لا إلى 'home' حرفياً: التبويبات مصفّاة
   * بالصلاحيات وقد لا تكون الرئيسية متاحةً لهذا المستخدم أصلاً. */
  useBackClose(!!(!token || !user) && showLogin, () => setShowLogin(false));
  // القسم الإداريّ فوق التبويبات، فيُغلق أوّلاً عند الرجوع
  useBackClose(!!section, () => setSection(null));
  /* والرجوع من الشاشة بلا مقعد يعود إلى **من فتحها** لا إلى الرئيسية: زرُّ
   * التحويل فتحها من الفواتير، فالرجوع نقضُ تلك الخطوة لا قفزٌ فوقها.
   *
   * وهي **طبقةٌ ثانية** لا وجهةٌ ثانية للطبقة الجذر — وهذا ليس تنظيماً:
   * `useBackClose` يسحب الطبقة من المكدّس **قبل** استدعاء `close` (اقرأ
   * `onPop`)، ولا يعيد تسجيلها إلّا حين يتحوّل `open`، وهو تبعيّة التأثير
   * الوحيدة. فإغلاقٌ يترك شرطَ طبقته صادقاً يترك المكوّن يظنّ طبقته مسجّلةً
   * وقد زالت من المكدّس: الضغطة التالية لا تجد طبقةً فتخرج من التطبيق
   * (يُغلق التطبيق المثبَّت، ويغادر تبويبُ المتصفّح الصفحة).
   *
   * والجذر كان يفعل ذلك حرفاً: الرجوع من السندات إلى «الفواتير» يُبقي
   * `screen !== tabs[0].id` صادقاً حين تكون الأولى «الرئيسية». وبالطبقتين
   * المتنافيتين يتحوّل شرطُ كلٍّ منهما عند الانتقال، فتُسجَّل التالية دائماً. */
  const onSeatlessDoc = !!token && !!user && !section && tabs.length > 0
    && screen === 'receipts' && receiptsSeatless;
  useBackClose(onSeatlessDoc, () => setScreen('invoices'));
  useBackClose(
    !!token && !!user && !section && tabs.length > 0 && !onSeatlessDoc && screen !== tabs[0].id,
    () => setScreen(tabs[0].id),
  );

  /**
   * عملة الشركة تُضبط عند الإقلاع. إغفالها **خطأ صامت لا يُسقط شاشة**: كل
   * المبالغ تُعرض بالريال السعودي (الافتراضي) لشركة بعملة أخرى.
   */
  useEffect(() => {
    if (!token) return;
    let alive = true;
    (async () => {
      try {
        const { data } = await companyApi.get();
        if (!alive) return;
        setCompany(data?.data ?? null);
        setActiveCurrency((data?.data as { currency?: string })?.currency);
        setActiveNumerals((data?.data as { numerals?: string })?.numerals);
      } catch { /* الفشل لا يمنع التطبيق — تبقى العملة الافتراضية */ }
    })();
    return () => { alive = false; };
  }, [token]);

  // زرّ التثبيت: يظهر فقط حين يعرض المتصفّح إمكانية التثبيت فعلاً
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', () => setInstallEvt(null));
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const doInstall = async () => {
    if (!installEvt) return;
    await installEvt.prompt();
    await installEvt.userChoice;
    setInstallEvt(null);
  };

  // إطار الجوّال للمعاينة على سطح المكتب فقط — على الجوال أو داخل التطبيق
  // المثبَّت يُعرض ملء الشاشة، وإلا ظهر «جوال داخل جوال».
  const framed = !(typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(max-width: 640px)').matches));

  const shell = (body: React.ReactNode) => (
    <div className={framed ? 'min-h-screen bg-slate-200 flex items-center justify-center p-4' : 'bg-white'}
      style={framed ? undefined : { height: '100dvh' }} dir="rtl">
      <div className={framed ? 'relative w-[400px] h-[820px] bg-black rounded-[44px] p-2.5 shadow-2xl' : 'relative w-full h-full'}>
        {framed && <div className="absolute top-2.5 left-1/2 -translate-x-1/2 w-32 h-6 bg-black rounded-b-2xl z-30" />}
        <div className={`w-full h-full bg-white overflow-hidden relative flex flex-col ${framed ? 'rounded-[36px]' : ''}`}>
          {body}
        </div>
      </div>
    </div>
  );

  if (!token || !user) {
    return shell(showLogin
      ? <MobileLogin onLogin={(t, u) => login(t, u as User)} onBack={() => setShowLogin(false)} />
      : <AppIntro app="m" onProceed={() => setShowLogin(true)} />);
  }

  return shell(
    <>
      {/* الشريط العلويّ */}
      <div className="bg-[#1F1A13] text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
        <span className="flex items-center gap-2 min-w-0">
          <BrandIcon size={26} radius={0.3} />
          <span className="min-w-0">
            <span className="block text-sm leading-tight" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }}>
              <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
            </span>
            <span className="block text-[10px] text-[#9A8F7E] truncate">{user.companyName || user.name}</span>
          </span>
        </span>
        <div className="flex items-center gap-2.5 flex-shrink-0">
          {installEvt && (
            <button onClick={doInstall} title={tr('ثبت التطبيق')}
              className="flex items-center gap-1 text-[11px] bg-[#E15A30]/20 text-[#E8A87C] border border-[#E15A30]/40 rounded-full px-2 py-1">
              <Download size={12} /> {tr('ثبت')}
            </button>
          )}
          <LanguageToggle variant="dark" />
          <button onClick={logout} className="text-[#9A8F7E] hover:text-white p-1" aria-label={tr('خروج')}>
            <LogOut size={18} />
          </button>
        </div>
      </div>

      {/* الجسم */}
      <div className="flex-1 overflow-hidden">
        {tabs.length === 0
          ? <MEmpty text={tr('لا تملك صلاحية أي قسم في التطبيق راجع مدير الشركة')} />
          : <ScreenBody screen={screen} company={company} userName={user.name} accountingOn={accountingOn}
              allowedSections={allowedSections} onOpenSection={setSection}
              onSwitchDoc={receiptsSeatless ? (k => setScreen(k === 'receipt' ? 'receipts' : 'invoices')) : undefined} />}
      </div>

      {/* الشريط السفليّ — يُخفى إن لم يبقَ تبويب مسموح */}
      {tabs.length > 0 && (
        <div className="flex-shrink-0 bg-white border-t border-gray-100 flex px-2 py-1.5"
          style={{ paddingBottom: 'calc(0.375rem + env(safe-area-inset-bottom))' }}>
          {/* الشاشة بلا مقعدٍ تُضيء مقعد من فتحها: شريطٌ سفليٌّ بلا أيّ مقعدٍ
              مُضاء يقول للمستخدم إنّه «خارج التطبيق». */}
          {tabs.map(t => {
            const Icon = t.icon;
            const active = screen === t.id
              || (screen === 'receipts' && receiptsSeatless && t.id === 'invoices');
            return (
              <button key={t.id} onClick={() => setScreen(t.id)}
                className={`flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-xl min-h-[48px] ${active ? 'text-[#E15A30]' : 'text-gray-400'}`}>
                <Icon size={20} />
                <span className="text-[10px] font-medium">{tr(t.label === 'm.tabHome' ? 'الرئيسية'
                  : t.label === 'm.tabInvoices' ? 'الفواتير'
                  : t.label === 'm.tabReceipts' ? 'التحصيل'
                  : t.label === 'm.tabDailyReports' ? 'التقارير'
                  : t.label === 'm.tabCustomers' ? 'العملاء' : 'التتبع')}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* قسم إداريّ مفتوح — صفحةٌ كاملة فوق الشريطين معاً، بترويستها وزرّ رجوعها */}
      {section && (
        <div className="absolute inset-0 z-20 bg-white">
          <Suspense fallback={<MSpinner />}>
            {section === 'reps' ? <MSalesReps company={company} accountingOn={accountingOn} onBack={() => setSection(null)} />
              : section === 'products' ? <MProducts onBack={() => setSection(null)} />
                : section === 'warehouse' ? <MWarehouse onBack={() => setSection(null)} />
                  : <MReports accountingOn={accountingOn} onBack={() => setSection(null)} />}
          </Suspense>
        </div>
      )}
    </>
  );
}

/** شاشات التبويبات */
function ScreenBody({ screen, company, userName, accountingOn, allowedSections, onOpenSection, onSwitchDoc }: {
  screen: Screen; company: unknown; userName: string; accountingOn: boolean;
  allowedSections: HomeSection[]; onOpenSection: (s: HomeSection) => void;
  /** يُعطى حين تكون إحدى شاشتَي المستندات بلا مقعد — وإلّا `undefined` فلا يظهر الزرّ */
  onSwitchDoc?: (k: 'invoice' | 'receipt') => void;
}) {
  const tr = useTr();
  if (screen === 'home') {
    return <MHome accountingOn={accountingOn} allowedSections={allowedSections} onOpenSection={onOpenSection} />;
  }
  if (screen === 'customers') return <MCustomers accountingOn={accountingOn} />;
  // key ضروريّ: المكوّنان في الموضع نفسه من الشجرة ومن النوع نفسه، فيوفّق
  // React بينهما ويحتفظ بالحالة — فيبقى مستندٌ مفتوحاً عند تبديل التبويب
  // ويُطلَب بمعرّف فاتورة ونوع سند. ويكسر ذلك مكدّس الرجوع أيضاً.
  if (screen === 'invoices') return <MDocList key="invoice" kind="invoice" company={company} userName={userName} onSwitchKind={onSwitchDoc} />;
  if (screen === 'receipts') return <MDocList key="receipt" kind="receipt" company={company} userName={userName} onSwitchKind={onSwitchDoc} />;
  if (screen === 'dailyReports') return <MDailyReports />;
  // الخريطة (leaflet) في حزمة كسولة: لا يدفع ثمنها من لم يفتح التبويب
  return (
    <Suspense fallback={<MSpinner />}>
      <MTracking />
    </Suspense>
  );
}
