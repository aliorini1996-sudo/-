// ============================================================================
// بوابة «سفير فيلد سيلز» على /ax — صفحة خاصة غير مُدرجة (العقد §1 ق7 وق8).
//
// · معزولة المصادقة: عميل axios خاص (./api) ومفتاح `ax_token`. لا تستورد
//   عميل لوحة الشركة ولا مخزن مصادقتها.
// · غير مُدرجة: `noindex, nofollow` يُحقن عند التحميل ويُستعاد عند المغادرة، ولا
//   روابط إليها من أي صفحة عامة، ولا في robots/sitemap/llms/prerender.
// · خمس لغات (ar · en · fr · tr · zh) بقاموس ./i18n ومبدّلٍ أعلى كل شاشة؛ الاتجاه يتبع
//   اللغة (RTL للعربية وحدها)، والجوال أولاً (أغلب السفراء على هواتفهم).
// · v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦): الانضمام فوريّ (لا تأكيد بريد ولا مراجعة)، وشريطٌ سفليّ
//   و«المزيد» على الجوال وشريطٌ جانبيّ على الحاسوب (./shell)، وزرّ واتساب دعمٍ عائم.
// ============================================================================
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { LogOut } from 'lucide-react';
import { affiliateApi, clearToken, getToken, httpStatus, onTermsOutdated, onUnauthorized, qk, shouldRetry } from './api';
import type { AffiliateMe, MeResponse } from './types';
import { AuthShell, AxLanguageToggle, BrandLockup, ErrorBox, Loading } from './ui';
import { useAxT } from './i18n';
import { ForgotScreen, LoginScreen, RegisterScreen, ResetScreen } from './screens/AuthScreens';
import {
  MORE_TABS, TAB_IDS, authTarget, authViewSearch, isLegacyAuthLink, linkTokenFromSearch, sessionTarget, showLinkScreen,
  tabFromHash, tabTarget, viewFromSearch, visibleTabs, type AuthView, type Tab,
} from './nav';
import { mergeMeUser } from './profile';
import { BottomBar, MoreSheet, Sidebar, SupportFab } from './shell';
import { StatusScreen, TermsGate } from './screens/StatusScreens';
import { HomeTab, LinkTab } from './screens/HomeScreens';
import { ClaimsTab } from './screens/ClaimsScreen';
import { MissedClaimsTab } from './screens/MissedClaimsScreen';
import { TrialTab } from './screens/TrialScreen';
import { CompaniesTab } from './screens/CompaniesScreen';
import { EarningsTab } from './screens/EarningsScreen';
import { PricingTab } from './screens/PricingScreen';
import { MaterialsTab } from './screens/MaterialsScreen';
import { FaqTab, SupportTab } from './screens/HelpScreens';
import { ProfileTab, TermsTab } from './screens/ProfileScreen';

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

  // رابط الاستعادة /ax?reset=TOKEN — الرمز يُحفظ في الذاكرة ويُستبدل في الشريط بـ?view=reset
  // **استبدالاً** فلا يبقى في السجل، ويبقى متاحاً إن عاد السفير لهذه الشاشة بزرّ الرجوع.
  const [resetToken, setResetToken] = useState<string | undefined>(() => linkTokenFromSearch(location.search)?.token);
  // الرابط «طازج» ما دام السفير على شاشته منذ فتحه — وبعد مغادرتها تصير عودته إليها
  // «من السجل»، فإن كانت له جلسة يُوجَّه للبوابة لا لشاشة الاستعادة.
  const [freshLink, setFreshLink] = useState<'reset' | null>(() => linkTokenFromSearch(location.search)?.kind ?? null);
  useEffect(() => {
    const link = linkTokenFromSearch(location.search);
    if (!link) return;
    setResetToken(link.token);
    setFreshLink(link.kind);
    navigate({ pathname: location.pathname, search: authViewSearch(link.kind), hash: '' }, { replace: true });
  }, [location.search, location.pathname, navigate]);
  useEffect(() => {
    if (freshLink && view !== freshLink) setFreshLink(null);
  }, [view, freshLink]);

  // روابط بريد v1 (`?verify=TOKEN` و`?view=verify|resend`): لا تأكيد بريد بعد الانضمام الفوريّ —
  // تُستبدل بـ/ax نظيفاً: الدخول، أو البوابة لمن له جلسة (V2_SPEC §7).
  const legacyLink = isLegacyAuthLink(location.search);
  // ?view=reset بلا رمزٍ في الذاكرة (بعد تحديث الصفحة مثلاً) ⇒ الدخول، استبدالاً لا دفعاً
  const orphanToken = !linkTokenFromSearch(location.search) && view === 'reset' && !resetToken;
  useEffect(() => {
    if (legacyLink || orphanToken) navigate({ pathname: location.pathname, search: '', hash: '' }, { replace: true });
  }, [legacyLink, orphanToken, location.pathname, navigate]);

  const [email, setEmail] = useState('');
  const [hasToken, setHasToken] = useState<boolean>(() => !!getToken());

  // جلسةٌ قائمة + شاشة الاستعادة من السجل ⇒ البوابة (استبدالاً، فلا حلقة)
  const linkFromHistory = hasToken && view === 'reset' && freshLink !== view && !linkTokenFromSearch(location.search);
  useEffect(() => {
    if (linkFromHistory) navigate({ pathname: location.pathname, search: '', hash: '' }, { replace: true });
  }, [linkFromHistory, location.pathname, navigate]);

  // 403 `terms_outdated` من أي مسارٍ للمعتمدين ⇒ بوابة قبول الشروط فوراً (لا خطأ ولا خروج)
  const [termsOutdated, setTermsOutdated] = useState(false);
  // ورقة «المزيد» حالةٌ عابرة لا عنوان: تُغلق مع أيّ تنقّل (رجوع أندرويد أيضاً)
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { setMoreOpen(false); }, [location.hash, location.search]);

  useEffect(() => { window.scrollTo({ top: 0 }); }, [view, tab, hasToken]);

  /** انتقالٌ إلى شاشة ما قبل الجلسة — مدخلٌ جديد في السجل */
  const go = useCallback((v: AuthView) => {
    const target = authTarget(location.search, location.hash, v);
    if (target) navigate({ pathname: location.pathname, ...target });
  }, [navigate, location.pathname, location.search, location.hash]);

  /** يعود العنوان إلى /ax نظيفاً — استبدالاً، فلا يُضاف مدخل (الخروج) */
  const toRoot = useCallback(() => {
    if (location.search || location.hash) navigate({ pathname: location.pathname, search: '', hash: '' }, { replace: true });
  }, [navigate, location.pathname, location.search, location.hash]);

  /**
   * بدء الجلسة أو انتهاؤها (401): /ax بلا معامل **ويبقى وسم التبويب** (nav.sessionTarget) — استبدالاً.
   * رابط بريد «تعذّر التحويل» `/ax#profile` بلا جلسةٍ في هذا المتصفّح يصل «ملفي» بعد الدخول لا الرئيسية.
   */
  const toSession = useCallback(() => {
    const target = sessionTarget(location.search, location.hash);
    if (target) navigate({ pathname: location.pathname, ...target }, { replace: true });
  }, [navigate, location.pathname, location.search, location.hash]);

  /** `keepTab`: انتهاء الجلسة (401) يُبقي التبويب للعودة إليه بعد الدخول؛ والخروج الصريح يمسحه */
  const resetSession = useCallback((keepTab: boolean) => {
    setHasToken(false);
    setMoreOpen(false);
    qc.removeQueries({ queryKey: qk.all });
    if (keepTab) toSession(); else toRoot();
  }, [qc, toRoot, toSession]);

  const logout = useCallback(() => {
    clearToken();
    resetSession(false);
  }, [resetSession]);

  // 401 على أي طلبٍ بجلسة ⇒ مسح ax_token وحده (في api.ts) والعودة للدخول — والتبويب باقٍ في العنوان
  useEffect(() => onUnauthorized(() => {
    resetSession(true);
    toast.error(t('session.expired'));
  }), [resetSession, t]);

  const me = useQuery({ queryKey: qk.me, queryFn: affiliateApi.me, enabled: hasToken, retry: shouldRetry, staleTime: 60_000 });

  /** دخولٌ أو تسجيلٌ فوريّ أو استعادة — الجلسة تبدأ من الرئيسية، أو من تبويب الرابط العميق (#profile) */
  const onLoggedIn = useCallback(() => {
    qc.removeQueries({ queryKey: qk.all });
    setTermsOutdated(false);
    setFreshLink(null);
    setHasToken(true);
    toSession();
  }, [qc, toSession]);

  const refreshMe = useCallback(() => { void qc.invalidateQueries({ queryKey: qk.me }); }, [qc]);

  useEffect(() => onTermsOutdated(() => {
    setTermsOutdated(true);
    void qc.invalidateQueries({ queryKey: qk.me });
  }), [qc]);

  const onUserUpdated = useCallback((u: AffiliateMe) => {
    // دمجٌ لا استبدال: ردّ PUT /me وPUT /payout-profile وPOST /accept-terms بلا `documents` و`missing`
    // و`profileComplete` (حقول GET /me وحده) — فيبقى ما في الذاكرة منها حتى تصل القراءة (profile.mergeMeUser)
    qc.setQueryData<MeResponse>(qk.me, (old) => (old ? { ...old, user: mergeMeUser(old.user, u) } : old));
    // اكتمال الملف و`missing` والإعدادات تُحسب في الخادم — تُعاد قراءتها
    void qc.invalidateQueries({ queryKey: qk.me });
    void qc.invalidateQueries({ queryKey: qk.dashboard });
  }, [qc]);

  /** قُبلت الشروط الجديدة — تُعاد كل الاستعلامات التي رُفضت بـ terms_outdated */
  const onTermsAccepted = useCallback((u: AffiliateMe) => {
    setTermsOutdated(false);
    onUserUpdated(u);
    void qc.invalidateQueries({ queryKey: qk.all });
  }, [qc, onUserUpdated]);

  /** انتقالٌ إلى تبويب — مدخلٌ جديد في السجل */
  const setTab = useCallback((next: Tab) => {
    const target = tabTarget(location.search, location.hash, next);
    if (target) navigate({ pathname: location.pathname, ...target });
  }, [navigate, location.pathname, location.search, location.hash]);

  const openMore = useCallback(() => setMoreOpen(true), []);
  const closeMore = useCallback(() => setMoreOpen(false), []);

  const nav = { go, email, setEmail };

  // ---- رابط الاستعادة يسبق كل شيء ----
  if (showLinkScreen('reset', { view, token: resetToken, hasToken, freshLink })) {
    return <ResetScreen {...nav} token={resetToken!} onLoggedIn={onLoggedIn} />;
  }

  // ---- بلا جلسة ----
  if (!hasToken) {
    switch (view) {
      case 'register': return <RegisterScreen {...nav} onLoggedIn={onLoggedIn} />;
      case 'forgot': return <ForgotScreen {...nav} />;
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

  // «افتح حساباً تجريبياً» يتبع مفتاح الخادم: مطفأً يغيب من الشريط و«المزيد»، و`#trial` (رابطٌ
  // محفوظ أو سجلّ المتصفّح) يعرض الرئيسية بدل نموذجٍ يرفضه الخادم بـ403 portal_trial_disabled.
  const trialOn = data.settings.portalTrialEnabled === true;
  const shown: Tab = tab === 'trial' && !trialOn ? 'home' : tab;

  const tabProps = { me: data, refreshMe };
  let content: ReactNode;
  switch (shown) {
    case 'companies': content = <CompaniesTab {...tabProps} openTab={setTab} />; break;
    case 'earnings': content = <EarningsTab {...tabProps} openTab={setTab} />; break;
    case 'link': content = <LinkTab {...tabProps} />; break;
    case 'claims': content = <ClaimsTab {...tabProps} />; break;
    case 'trial': content = <TrialTab {...tabProps} />; break;
    case 'missed': content = <MissedClaimsTab {...tabProps} />; break;
    case 'pricing': content = <PricingTab {...tabProps} />; break;
    case 'materials': content = <MaterialsTab {...tabProps} />; break;
    case 'faq': content = <FaqTab me={data} />; break;
    case 'support': content = <SupportTab me={data} openTab={setTab} />; break;
    case 'profile': content = <ProfileTab {...tabProps} onUserUpdated={onUserUpdated} />; break;
    case 'terms': content = <TermsTab me={data} />; break;
    default: content = <HomeTab {...tabProps} openTab={setTab} trialOn={trialOn} />;
  }

  return (
    <div className="min-h-screen bg-[#FAF7F0]" dir={dir} lang={lang}>
      {/* خلفية صلبة لا backdrop-blur: أيّ backdrop-filter يجعل الرأس حاويةً لعناصر position:fixed،
          فتنحبس خلفية إغلاق قائمة اللغة (fixed inset-0) داخل الرأس ولا تُغلق بلمسة خارجها. */}
      <header className="sticky top-0 z-30 bg-[#FAF7F0] border-b border-[#E9E1D3]">
        <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between gap-2 sm:gap-3">
          <div className="min-w-0 flex-1"><BrandLockup compact /></div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <span className="hidden md:inline text-[12.5px] text-[#6E6557] truncate max-w-[180px]">{data.user.fullName}</span>
            <AxLanguageToggle />
          </div>
        </div>
      </header>
      <div className="max-w-6xl mx-auto px-4 lg:flex lg:gap-6 lg:pt-5">
        <Sidebar tabs={visibleTabs(TAB_IDS, trialOn)} active={shown} onSelect={setTab} onLogout={logout} />
        {/* مساحةٌ سفلية للشريط الثابت وزرّ الدعم على الجوال */}
        <main className="flex-1 min-w-0 max-w-3xl mx-auto lg:mx-0 py-5 lg:pt-0 pb-36 lg:pb-14">{content}</main>
      </div>
      <BottomBar active={shown} moreOpen={moreOpen} onSelect={setTab} onMore={openMore} />
      <MoreSheet
        open={moreOpen} tabs={visibleTabs(MORE_TABS, trialOn)} active={shown}
        onSelect={setTab} onClose={closeMore} onLogout={logout}
      />
      {!moreOpen && <SupportFab code={data.user.code} />}
    </div>
  );
}
