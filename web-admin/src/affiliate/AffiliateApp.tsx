// ============================================================================
// بوابة «سفير فيلد سيلز» على /ax — صفحة خاصة غير مُدرجة (العقد §1 ق7 وق8).
//
// · معزولة المصادقة: عميل axios خاص (./api) ومفتاح `ax_token`. لا تستورد
//   عميل لوحة الشركة ولا مخزن مصادقتها.
// · غير مُدرجة: `noindex, nofollow` يُحقن عند التحميل ويُستعاد عند المغادرة، ولا
//   روابط إليها من أي صفحة عامة، ولا في robots/sitemap/llms/prerender.
// · خمس لغات (ar · en · fr · tr · zh) بقاموس ./i18n ومبدّلٍ أعلى كل شاشة؛ الاتجاه يتبع
//   اللغة (RTL للعربية وحدها)، والجوال أولاً (أغلب السفراء على هواتفهم).
// ============================================================================
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Home, Link2, Tags, Send, Building2, Wallet, UserRound, FileText, LogOut } from 'lucide-react';
import { affiliateApi, clearToken, getToken, httpStatus, onTermsOutdated, onUnauthorized, qk, shouldRetry } from './api';
import type { AffiliateMe, MeResponse } from './types';
import { AuthShell, AxLanguageToggle, BrandLockup, ErrorBox, Loading } from './ui';
import { useAxT, type AxKey } from './i18n';
import {
  ForgotScreen, LoginScreen, RegisterScreen, ResendScreen, ResetScreen, VerifyScreen,
} from './screens/AuthScreens';
import {
  authTarget, authViewSearch, linkTokenFromSearch, showLinkScreen, tabFromHash, tabTarget, viewFromSearch,
  type AuthView, type Tab,
} from './nav';
import { StatusScreen, TermsGate } from './screens/StatusScreens';
import { HomeTab, LinkTab } from './screens/HomeScreens';
import { ClaimsTab } from './screens/ClaimsScreen';
import { CompaniesTab } from './screens/CompaniesScreen';
import { EarningsTab } from './screens/EarningsScreen';
import { PricingTab } from './screens/PricingScreen';
import { ProfileTab, TermsTab } from './screens/ProfileScreen';

const TABS: Array<{ id: Tab; label: AxKey; icon: ReactNode }> = [
  { id: 'home', label: 'tab.home', icon: <Home size={15} /> },
  { id: 'link', label: 'tab.link', icon: <Link2 size={15} /> },
  { id: 'pricing', label: 'tab.pricing', icon: <Tags size={15} /> },
  { id: 'claims', label: 'tab.claims', icon: <Send size={15} /> },
  { id: 'companies', label: 'tab.companies', icon: <Building2 size={15} /> },
  { id: 'earnings', label: 'tab.earnings', icon: <Wallet size={15} /> },
  { id: 'profile', label: 'tab.profile', icon: <UserRound size={15} /> },
  { id: 'terms', label: 'tab.terms', icon: <FileText size={15} /> },
];

/**
 * يحقن noindex ويضبط العنوان بلغة العرض — ويُعيد العنوان ووسم robots عند المغادرة.
 * لغة المستند واتجاهه يضبطهما مخزن اللغة (`useLang`) لا البوابة.
 */
function usePrivatePageHead(title: string) {
  useEffect(() => {
    const prevTitle = document.title;
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    const prevRobots = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'robots');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', 'noindex, nofollow');

    return () => {
      document.title = prevTitle;
      if (created) meta?.remove();
      else if (prevRobots !== null) meta?.setAttribute('content', prevRobots);
    };
  }, []);
  // العنوان يتبع تبديل اللغة
  useEffect(() => { document.title = title; }, [title]);
}

export default function AffiliateApp() {
  const { t, dir, lang } = useAxT();
  usePrivatePageHead(t('app.title'));
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // الشاشة والتبويب من العنوان (./nav) — فزرّ الرجوع في الجوال يعود للشاشة السابقة
  // داخل البوابة بدل الخروج من /ax وضياع نموذجٍ نصف مكتمل.
  const view: AuthView = viewFromSearch(location.search);
  const tab: Tab = tabFromHash(location.hash);

  // روابط البريد: /ax?verify=TOKEN و/ax?reset=TOKEN — الرمز يُحفظ في الذاكرة ويُستبدل في
  // الشريط بـ?view=verify|reset **استبدالاً** فلا يبقى في السجل، ويبقى متاحاً إن عاد
  // السفير لهذه الشاشة بزرّ الرجوع.
  const [tokens, setTokens] = useState<{ verify?: string; reset?: string }>(() => {
    const t = linkTokenFromSearch(location.search);
    return t ? { [t.kind]: t.token } : {};
  });
  // رابط البريد «طازج» ما دام السفير على شاشته منذ فتحه — وبعد مغادرتها تصير عودته إليها
  // «من السجل»، فإن كانت له جلسة يُوجَّه للبوابة لا لشاشة التأكيد/الاستعادة.
  const [freshLink, setFreshLink] = useState<'verify' | 'reset' | null>(() => linkTokenFromSearch(location.search)?.kind ?? null);
  useEffect(() => {
    const t = linkTokenFromSearch(location.search);
    if (!t) return;
    setTokens((prev) => (prev[t.kind] === t.token ? prev : { ...prev, [t.kind]: t.token }));
    setFreshLink(t.kind);
    navigate({ pathname: location.pathname, search: authViewSearch(t.kind), hash: '' }, { replace: true });
  }, [location.search, location.pathname, navigate]);
  useEffect(() => {
    if (freshLink && view !== freshLink) setFreshLink(null);
  }, [view, freshLink]);

  // ?view=verify|reset بلا رمزٍ في الذاكرة (بعد تحديث الصفحة مثلاً) ⇒ الدخول، استبدالاً لا دفعاً
  const orphanToken = !linkTokenFromSearch(location.search)
    && ((view === 'verify' && !tokens.verify) || (view === 'reset' && !tokens.reset));
  useEffect(() => {
    if (orphanToken) navigate({ pathname: location.pathname, search: '', hash: '' }, { replace: true });
  }, [orphanToken, location.pathname, navigate]);

  const [email, setEmail] = useState('');
  const [hasToken, setHasToken] = useState<boolean>(() => !!getToken());

  // جلسةٌ قائمة + شاشة تأكيد/استعادة من السجل ⇒ البوابة (استبدالاً، فلا حلقة)
  const linkFromHistory = hasToken && (view === 'verify' || view === 'reset') && freshLink !== view
    && !linkTokenFromSearch(location.search);
  useEffect(() => {
    if (linkFromHistory) navigate({ pathname: location.pathname, search: '', hash: '' }, { replace: true });
  }, [linkFromHistory, location.pathname, navigate]);

  // 403 `terms_outdated` من أي مسارٍ للمعتمدين ⇒ بوابة قبول الشروط فوراً (لا خطأ ولا خروج)
  const [termsOutdated, setTermsOutdated] = useState(false);

  useEffect(() => { window.scrollTo({ top: 0 }); }, [view, tab, hasToken]);
  // التبويب النشط في منتصف الشريط — ويُعاد توسيطه بعد تبديل اللغة: الاتجاه يقلب بداية التمرير
  // وعروض العناوين تتغيّر، فيخرج التبويب عن الشاشة. تبديل اللغة يُوسِّط فوراً (auto) لا بانزلاق.
  const lastLang = useRef(lang);
  useEffect(() => {
    if (!hasToken) return;
    const langChanged = lastLang.current !== lang;
    lastLang.current = lang;
    requestAnimationFrame(() => {
      document.getElementById(`ax-tab-${tab}`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: langChanged ? 'auto' : 'smooth' });
    });
  }, [tab, hasToken, dir, lang]);

  /** انتقالٌ إلى شاشة ما قبل الجلسة — مدخلٌ جديد في السجل */
  const go = useCallback((v: AuthView) => {
    const target = authTarget(location.search, location.hash, v);
    if (target) navigate({ pathname: location.pathname, ...target });
  }, [navigate, location.pathname, location.search, location.hash]);

  /** يعود العنوان إلى /ax نظيفاً — استبدالاً، فلا يُضاف مدخل */
  const toRoot = useCallback(() => {
    if (location.search || location.hash) navigate({ pathname: location.pathname, search: '', hash: '' }, { replace: true });
  }, [navigate, location.pathname, location.search, location.hash]);

  const resetSession = useCallback(() => {
    setHasToken(false);
    qc.removeQueries({ queryKey: qk.all });
    toRoot();
  }, [qc, toRoot]);

  const logout = useCallback(() => {
    clearToken();
    resetSession();
  }, [resetSession]);

  // 401 على أي طلبٍ بجلسة ⇒ مسح ax_token وحده (في api.ts) والعودة للدخول
  useEffect(() => onUnauthorized(() => {
    resetSession();
    toast.error(t('session.expired'));
  }), [resetSession, t]);

  const me = useQuery({ queryKey: qk.me, queryFn: affiliateApi.me, enabled: hasToken, retry: shouldRetry, staleTime: 60_000 });

  const onLoggedIn = useCallback(() => {
    qc.removeQueries({ queryKey: qk.all });
    setTermsOutdated(false);
    setFreshLink(null);
    setHasToken(true);
    toRoot();
  }, [qc, toRoot]);

  const refreshMe = useCallback(() => { void qc.invalidateQueries({ queryKey: qk.me }); }, [qc]);

  useEffect(() => onTermsOutdated(() => {
    setTermsOutdated(true);
    void qc.invalidateQueries({ queryKey: qk.me });
  }), [qc]);

  const onUserUpdated = useCallback((u: AffiliateMe) => {
    qc.setQueryData<MeResponse>(qk.me, (old) => (old ? { ...old, user: u } : old));
    void qc.invalidateQueries({ queryKey: qk.me }); // canSetPayout والإعدادات قد تتغيّر معه
  }, [qc]);

  /** قُبلت الشروط الجديدة — تُعاد كل الاستعلامات التي رُفضت بـ terms_outdated */
  const onTermsAccepted = useCallback((u: AffiliateMe) => {
    setTermsOutdated(false);
    onUserUpdated(u);
    void qc.invalidateQueries({ queryKey: qk.all });
  }, [qc, onUserUpdated]);

  /** انتقالٌ إلى تبويب — مدخلٌ جديد في السجل */
  const setTab = useCallback((t: Tab) => {
    const target = tabTarget(location.search, location.hash, t);
    if (target) navigate({ pathname: location.pathname, ...target });
  }, [navigate, location.pathname, location.search, location.hash]);

  const nav = { go, email, setEmail };

  // ---- روابط البريد تسبق كل شيء ----
  if (showLinkScreen('verify', { view, token: tokens.verify, hasToken, freshLink })) {
    return <VerifyScreen {...nav} token={tokens.verify!} />;
  }
  if (showLinkScreen('reset', { view, token: tokens.reset, hasToken, freshLink })) {
    return <ResetScreen {...nav} token={tokens.reset!} onLoggedIn={onLoggedIn} />;
  }

  // ---- بلا جلسة ----
  if (!hasToken) {
    switch (view) {
      case 'register': return <RegisterScreen {...nav} />;
      case 'forgot': return <ForgotScreen {...nav} />;
      case 'resend': return <ResendScreen {...nav} />;
      default: return <LoginScreen {...nav} onLoggedIn={onLoggedIn} />;
    }
  }

  if (me.isLoading) return <AuthShell title={t('app.title')}><Loading /></AuthShell>;
  if (me.isError || !me.data) {
    if (httpStatus(me.error) === 401) return <LoginScreen {...nav} onLoggedIn={onLoggedIn} />;
    return (
      <AuthShell title={t('me.loadFailed')}>
        <ErrorBox err={me.error} onRetry={() => void me.refetch()} />
        <button type="button" className="btn-secondary w-full justify-center py-2.5 mt-4" onClick={logout}>
          <LogOut size={16} /> {t('common.logout')}
        </button>
      </AuthShell>
    );
  }

  const data = me.data;
  if (data.user.status !== 'approved') return <StatusScreen me={data} onLogout={logout} />;
  if (termsOutdated || data.user.termsVersion !== data.settings.currentTermsVersion) {
    return <TermsGate me={data} onAccepted={onTermsAccepted} onLogout={logout} />;
  }

  const tabProps = { me: data, refreshMe };
  let content: ReactNode;
  switch (tab) {
    case 'link': content = <LinkTab {...tabProps} />; break;
    case 'pricing': content = <PricingTab {...tabProps} />; break;
    case 'claims': content = <ClaimsTab {...tabProps} />; break;
    case 'companies': content = <CompaniesTab {...tabProps} />; break;
    case 'earnings': content = <EarningsTab {...tabProps} />; break;
    case 'profile': content = <ProfileTab {...tabProps} onUserUpdated={onUserUpdated} />; break;
    case 'terms': content = <TermsTab me={data} />; break;
    default: content = <HomeTab {...tabProps} />;
  }

  return (
    <div className="min-h-screen bg-[#FAF7F0]" dir={dir} lang={lang}>
      {/* خلفية صلبة لا backdrop-blur: أيّ backdrop-filter يجعل الرأس حاويةً لعناصر position:fixed،
          فتنحبس خلفية إغلاق قائمة اللغة (fixed inset-0) داخل الرأس ولا تُغلق بلمسة خارجها. */}
      <header className="sticky top-0 z-30 bg-[#FAF7F0] border-b border-[#E9E1D3]">
        <div className="max-w-3xl mx-auto px-4 pt-3 pb-2 flex items-center justify-between gap-2 sm:gap-3">
          <div className="min-w-0 flex-1"><BrandLockup compact /></div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <span className="hidden md:inline text-[12.5px] text-[#6E6557] truncate max-w-[180px]">{data.user.fullName}</span>
            <AxLanguageToggle />
            <button type="button" className="btn-secondary px-3" onClick={logout} aria-label={t('common.logout')}>
              <LogOut size={15} /> <span className="hidden sm:inline">{t('common.logoutShort')}</span>
            </button>
          </div>
        </div>
        <nav className="max-w-3xl mx-auto overflow-x-auto pb-2.5" style={{ scrollbarWidth: 'none' }} aria-label={t('nav.sections')}>
          <div className="flex gap-1.5 w-max px-4">
            {TABS.map((item) => {
              const active = item.id === tab;
              return (
                <button
                  key={item.id} id={`ax-tab-${item.id}`} type="button" onClick={() => setTab(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors ${
                    active ? 'bg-[#E15A30] text-white shadow-sm' : 'bg-white text-[#44403a] border border-[#E9E1D3] hover:border-[#E15A30]'
                  }`}
                >
                  {item.icon} {t(item.label)}
                </button>
              );
            })}
          </div>
        </nav>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-5 pb-16">{content}</main>
    </div>
  );
}
