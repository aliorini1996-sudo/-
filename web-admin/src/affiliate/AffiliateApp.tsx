// ============================================================================
// بوابة «سفير فيلد سيلز» على /ax — صفحة خاصة غير مُدرجة (العقد §1 ق7 وق8).
//
// · معزولة المصادقة: عميل axios خاص (./api) ومفتاح `ax_token`. لا تستورد
//   عميل لوحة الشركة ولا مخزن مصادقتها.
// · غير مُدرجة: `noindex, nofollow` يُحقن عند التحميل ويُستعاد عند المغادرة، ولا
//   روابط إليها من أي صفحة عامة، ولا في robots/sitemap/llms/prerender.
// · عربية فقط ومن اليمين لليسار، والجوال أولاً (أغلب السفراء على هواتفهم).
// ============================================================================
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Home, Link2, Send, Building2, Wallet, UserRound, FileText, LogOut } from 'lucide-react';
import { affiliateApi, clearToken, getToken, httpStatus, onTermsOutdated, onUnauthorized, qk, shouldRetry } from './api';
import type { AffiliateMe, MeResponse } from './types';
import { AuthShell, BrandLockup, ErrorBox, Loading } from './ui';
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
import { ProfileTab, TermsTab } from './screens/ProfileScreen';

const TABS: Array<{ id: Tab; label: string; icon: ReactNode }> = [
  { id: 'home', label: 'الرئيسية', icon: <Home size={15} /> },
  { id: 'link', label: 'رابطي', icon: <Link2 size={15} /> },
  { id: 'claims', label: 'رشّح شركة', icon: <Send size={15} /> },
  { id: 'companies', label: 'شركاتي', icon: <Building2 size={15} /> },
  { id: 'earnings', label: 'أرباحي', icon: <Wallet size={15} /> },
  { id: 'profile', label: 'الملف', icon: <UserRound size={15} /> },
  { id: 'terms', label: 'الشروط', icon: <FileText size={15} /> },
];

/** يحقن noindex ويضبط العنوان واتجاه المستند — ويُعيد كل شيء كما كان عند المغادرة */
function usePrivatePageHead() {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = 'سفير فيلد سيلز';

    const html = document.documentElement;
    const prevLang = html.getAttribute('lang');
    const prevDir = html.getAttribute('dir');
    html.setAttribute('lang', 'ar');
    html.setAttribute('dir', 'rtl');

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
      if (prevLang === null) html.removeAttribute('lang'); else html.setAttribute('lang', prevLang);
      if (prevDir === null) html.removeAttribute('dir'); else html.setAttribute('dir', prevDir);
      if (created) meta?.remove();
      else if (prevRobots !== null) meta?.setAttribute('content', prevRobots);
    };
  }, []);
}

export default function AffiliateApp() {
  usePrivatePageHead();
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
  useEffect(() => {
    if (!hasToken) return;
    requestAnimationFrame(() => {
      document.getElementById(`ax-tab-${tab}`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    });
  }, [tab, hasToken]);

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
    toast.error('انتهت الجلسة — سجّل الدخول من جديد');
  }), [resetSession]);

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

  if (me.isLoading) return <AuthShell title="سفير فيلد سيلز"><Loading /></AuthShell>;
  if (me.isError || !me.data) {
    if (httpStatus(me.error) === 401) return <LoginScreen {...nav} onLoggedIn={onLoggedIn} />;
    return (
      <AuthShell title="تعذّر تحميل حسابك">
        <ErrorBox err={me.error} onRetry={() => void me.refetch()} />
        <button type="button" className="btn-secondary w-full justify-center py-2.5 mt-4" onClick={logout}>
          <LogOut size={16} /> تسجيل الخروج
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
    case 'claims': content = <ClaimsTab {...tabProps} />; break;
    case 'companies': content = <CompaniesTab {...tabProps} />; break;
    case 'earnings': content = <EarningsTab {...tabProps} />; break;
    case 'profile': content = <ProfileTab {...tabProps} onUserUpdated={onUserUpdated} />; break;
    case 'terms': content = <TermsTab me={data} />; break;
    default: content = <HomeTab {...tabProps} />;
  }

  return (
    <div className="min-h-screen bg-[#FAF7F0]" dir="rtl">
      <header className="sticky top-0 z-30 bg-[#FAF7F0]/95 backdrop-blur border-b border-[#E9E1D3]">
        <div className="max-w-3xl mx-auto px-4 pt-3 pb-2 flex items-center justify-between gap-3">
          <BrandLockup compact />
          <div className="flex items-center gap-2 min-w-0">
            <span className="hidden sm:inline text-[12.5px] text-[#6E6557] truncate max-w-[180px]">{data.user.fullName}</span>
            <button type="button" className="btn-secondary px-3" onClick={logout} aria-label="تسجيل الخروج">
              <LogOut size={15} /> <span className="hidden sm:inline">خروج</span>
            </button>
          </div>
        </div>
        <nav className="max-w-3xl mx-auto overflow-x-auto pb-2.5" style={{ scrollbarWidth: 'none' }} aria-label="أقسام البوابة">
          <div className="flex gap-1.5 w-max px-4">
            {TABS.map((t) => {
              const active = t.id === tab;
              return (
                <button
                  key={t.id} id={`ax-tab-${t.id}`} type="button" onClick={() => setTab(t.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors ${
                    active ? 'bg-[#E15A30] text-white shadow-sm' : 'bg-white text-[#44403a] border border-[#E9E1D3] hover:border-[#E15A30]'
                  }`}
                >
                  {t.icon} {t.label}
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
