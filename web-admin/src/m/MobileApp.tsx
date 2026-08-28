import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { Home, FileText, CreditCard, Users, MapPin, LogOut, Download } from 'lucide-react';
import { companyApi } from '../api/client';
import { BrandIcon } from '../components/BrandLogo';
import AppIntro from '../components/AppIntro';
import LanguageToggle from '../components/LanguageToggle';
import { useAuthStore } from '../store/authStore';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';
import { useTr } from '../i18n/strings';
import { User } from '../types';
import MobileLogin from './MobileLogin';
import MHome from './MHome';
import MCustomers from './MCustomers';
import MDocList from './MDocList';
const MTracking = lazy(() => import('./MTracking'));
import { MEmpty, MSpinner } from './mobileUi';
import { can, PermKey } from './perms';

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
type Screen = 'home' | 'invoices' | 'receipts' | 'customers' | 'tracking';

interface Tab { id: Screen; label: string; icon: React.ElementType; perm: PermKey }

const TABS: Tab[] = [
  { id: 'home', label: 'm.tabHome', icon: Home, perm: 'canAccessDashboard' },
  { id: 'invoices', label: 'm.tabInvoices', icon: FileText, perm: 'canManageInvoices' },
  { id: 'receipts', label: 'm.tabReceipts', icon: CreditCard, perm: 'canManageReceipts' },
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
  const [installEvt, setInstallEvt] = useState<InstallPromptEvent | null>(null);
  // إعدادات الشركة — تُمرَّر لطابع المستندات (ترويسة، رقم ضريبي، رمز ZATCA)
  const [company, setCompany] = useState<unknown>(null);

  // التبويبات المسموحة لهذا المستخدم — المنع عند `false` الصريحة وحدها
  const tabs = useMemo(() => TABS.filter(t => can(user, t.perm)), [user]);

  // أوّل تبويب مسموح يصير الشاشة الافتراضية، فلا تُفتح القوقعة على شاشة محجوبة
  useEffect(() => {
    if (tabs.length && !tabs.some(t => t.id === screen)) setScreen(tabs[0].id);
  }, [tabs, screen]);

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
          : <ScreenBody screen={screen} company={company} userName={user.name} />}
      </div>

      {/* الشريط السفليّ — يُخفى إن لم يبقَ تبويب مسموح */}
      {tabs.length > 0 && (
        <div className="flex-shrink-0 bg-white border-t border-gray-100 flex px-2 py-1.5"
          style={{ paddingBottom: 'calc(0.375rem + env(safe-area-inset-bottom))' }}>
          {tabs.map(t => {
            const Icon = t.icon;
            const active = screen === t.id;
            return (
              <button key={t.id} onClick={() => setScreen(t.id)}
                className={`flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-xl min-h-[48px] ${active ? 'text-[#E15A30]' : 'text-gray-400'}`}>
                <Icon size={20} />
                <span className="text-[10px] font-medium">{tr(t.label === 'm.tabHome' ? 'الرئيسية'
                  : t.label === 'm.tabInvoices' ? 'الفواتير'
                  : t.label === 'm.tabReceipts' ? 'التحصيل'
                  : t.label === 'm.tabCustomers' ? 'العملاء' : 'التتبع')}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** شاشات التبويبات */
function ScreenBody({ screen, company, userName }: { screen: Screen; company: unknown; userName: string }) {
  const tr = useTr();
  if (screen === 'home') return <MHome />;
  if (screen === 'customers') return <MCustomers />;
  if (screen === 'invoices') return <MDocList kind="invoice" company={company} userName={userName} />;
  if (screen === 'receipts') return <MDocList kind="receipt" company={company} userName={userName} />;
  // الخريطة (leaflet) في حزمة كسولة: لا يدفع ثمنها من لم يفتح التبويب
  return (
    <Suspense fallback={<MSpinner />}>
      <MTracking />
    </Suspense>
  );
}
