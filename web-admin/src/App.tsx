import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import { useLang, isAppRoute } from './i18n/lang';
import { localeFromPath } from './i18n/locale';
import { analyticsApi } from './api/client';
// صفحات عامّة — تحميل فوري (مدخل سريع + SEO)
import LandingPage from './pages/LandingPage';
import InfoPage from './pages/InfoPage';
import ContactPage from './pages/ContactPage';
import SignupPage from './pages/SignupPage';
import LoginPage from './pages/LoginPage';
import OwnerLoginPage from './pages/OwnerLoginPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import BlogIndexPage from './pages/BlogIndexPage';
import BlogPostPage from './pages/BlogPostPage';
import SubscriptionRequestPage from './pages/SubscriptionRequestPage';
import LeakCalculatorPage from './pages/LeakCalculatorPage';
import InvoiceGeneratorPage from './pages/InvoiceGeneratorPage';
// لوحات مصادَق عليها — تحميل كسول (لا تُحمَّل لزوّار الصفحات العامّة/المدوّنة)
const MainLayout = lazy(() => import('./layouts/MainLayout'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const CustomersPage = lazy(() => import('./pages/CustomersPage'));
const ProductsPage = lazy(() => import('./pages/ProductsPage'));
const SalesRepsPage = lazy(() => import('./pages/SalesRepsPage'));
const InvoicesPage = lazy(() => import('./pages/InvoicesPage'));
const ReceiptsPage = lazy(() => import('./pages/ReceiptsPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const CompanySettingsPage = lazy(() => import('./pages/CompanySettingsPage'));
const CompanyUsersPage = lazy(() => import('./pages/CompanyUsersPage'));
const ErpIntegrationPage = lazy(() => import('./pages/ErpIntegrationPage'));
const VanStockPage = lazy(() => import('./pages/VanStockPage'));
const TrackingPage = lazy(() => import('./pages/TrackingPage'));
const PlatformPage = lazy(() => import('./pages/PlatformPage'));
const RepApp = lazy(() => import('./rep/RepApp'));
const RestaurantHome = lazy(() => import('./pages/resto/RestaurantHome'));

// شاشة تحميل بسيطة أثناء جلب الحِزَم الكسولة
function PageFallback() {
  return <div className="min-h-screen flex items-center justify-center bg-[#FAF7F0] text-[#9A8F7E]">جارٍ التحميل…</div>;
}

// لوحة الأدمن على /app — الجذر "/" يبقى دائماً الصفحة التعريفية
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuthStore();
  if (!token) return <Navigate to="/login" replace />;
  if (user?.role === 'SUPER_ADMIN') return <Navigate to="/platform" replace />;
  // عزل العموديّات: أدمن المطاعم لا يرى لوحة التوزيع أبداً — يُوجَّه لمساحته /app-r.
  if (user?.vertical === 'restaurant') return <Navigate to="/app-r" replace />;
  return <>{children}</>;
}

// لوحة المطعم على /app-r — لعمودية المطاعم فقط (يُعيد التوزيع إلى /app)
function RestaurantRoute({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuthStore();
  if (!token) return <Navigate to="/login" replace />;
  if (user?.role === 'SUPER_ADMIN') return <Navigate to="/platform" replace />;
  if ((user?.vertical ?? 'distribution') !== 'restaurant') return <Navigate to="/app" replace />;
  return <>{children}</>;
}

// لوحة المالك — للسوبر أدمن فقط (يُوجّه لمدخله السرّي عند عدم الدخول)
function SuperAdminRoute({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuthStore();
  if (!token || user?.role !== 'SUPER_ADMIN') return <Navigate to="/owner" replace />;
  return <>{children}</>;
}

function PermissionRoute({ permission, children }: { permission: keyof NonNullable<ReturnType<typeof useAuthStore.getState>['user']>; children: React.ReactNode }) {
  const { user } = useAuthStore();
  if (user?.[permission] === false) {
    return (
      <div className="card max-w-xl">
        <h1 className="text-lg font-bold text-[#1F1A13]">غير مسموح</h1>
        <p className="text-sm text-gray-500 mt-1">لا تملك صلاحية الوصول لهذا القسم.</p>
      </div>
    );
  }
  return <>{children}</>;
}

// يضبط لغة الواجهة من المسار (المسارات تحت /en إنجليزية و/fr فرنسية) — مصدر الحقيقة للفهرسة الدولية.
// يتجاهل مسارات التطبيق (الدخول/التسجيل/اللوحة/المندوب) لأنها تدير لغتها يدويًا عبر المبدّل الثلاثي.
function LocaleSync() {
  const { pathname } = useLocation();
  const setLang = useLang((s) => s.setLang);
  useEffect(() => {
    if (isAppRoute(pathname)) return;
    setLang(localeFromPath(pathname));
  }, [pathname, setLang]);
  return null;
}

// يسجّل زيارة لكل صفحة عامّة (يتجاهل لوحات الدخول والتطبيق) — لتحليلات المالك
function VisitTracker() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (/^\/(app|app-r|platform|owner|login|signup|verify-email|rep)(\/|$)/.test(pathname)) return;
    analyticsApi.track({ path: pathname, referrer: document.referrer || '', lang: document.documentElement.lang || 'ar' }).catch(() => { /* تجاهل */ });
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <LocaleSync />
      <VisitTracker />
      <Suspense fallback={<PageFallback />}>
      <Routes>
        {/* الجذر دائماً الصفحة التعريفية التسويقية */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/rep" element={<RepApp />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/owner" element={<OwnerLoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        {/* الصفحات التعريفية الفرعية (عامة) */}
        <Route path="/about" element={<InfoPage pageKey="about" />} />
        <Route path="/terms" element={<InfoPage pageKey="terms" />} />
        <Route path="/service-agreement" element={<InfoPage pageKey="serviceAgreement" />} />
        <Route path="/privacy" element={<InfoPage pageKey="privacy" />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/subscribe-request" element={<SubscriptionRequestPage />} />
        <Route path="/calculator" element={<LeakCalculatorPage />} />
        <Route path="/invoice-generator" element={<InvoiceGeneratorPage />} />
        <Route path="/blog" element={<BlogIndexPage />} />
        <Route path="/blog/:slug" element={<BlogPostPage />} />
        {/* النسخة الإنجليزية على /en — نفس المكوّنات تُعرَض بالإنجليزية (دولي + hreflang) */}
        <Route path="/en" element={<LandingPage />} />
        <Route path="/en/about" element={<InfoPage pageKey="about" />} />
        <Route path="/en/terms" element={<InfoPage pageKey="terms" />} />
        <Route path="/en/service-agreement" element={<InfoPage pageKey="serviceAgreement" />} />
        <Route path="/en/privacy" element={<InfoPage pageKey="privacy" />} />
        <Route path="/en/contact" element={<ContactPage />} />
        <Route path="/en/subscribe-request" element={<SubscriptionRequestPage />} />
        <Route path="/en/calculator" element={<LeakCalculatorPage />} />
        <Route path="/en/invoice-generator" element={<InvoiceGeneratorPage />} />
        <Route path="/en/blog" element={<BlogIndexPage />} />
        <Route path="/en/blog/:slug" element={<BlogPostPage />} />
        {/* النسخة الفرنسية على /fr — للأسواق الفرنكوفونية (المغرب العربي) مع hreflang */}
        <Route path="/fr" element={<LandingPage />} />
        <Route path="/fr/about" element={<InfoPage pageKey="about" />} />
        <Route path="/fr/terms" element={<InfoPage pageKey="terms" />} />
        <Route path="/fr/service-agreement" element={<InfoPage pageKey="serviceAgreement" />} />
        <Route path="/fr/privacy" element={<InfoPage pageKey="privacy" />} />
        <Route path="/fr/contact" element={<ContactPage />} />
        <Route path="/fr/subscribe-request" element={<SubscriptionRequestPage />} />
        <Route path="/fr/calculator" element={<LeakCalculatorPage />} />
        <Route path="/fr/invoice-generator" element={<InvoiceGeneratorPage />} />
        <Route path="/fr/blog" element={<BlogIndexPage />} />
        <Route path="/fr/blog/:slug" element={<BlogPostPage />} />
        <Route path="/platform" element={<SuperAdminRoute><PlatformPage /></SuperAdminRoute>} />
        {/* لوحة المطعم (عمودية restaurant) — عنصر نائب M0، يتوسّع في M2+ */}
        <Route path="/app-r" element={<RestaurantRoute><RestaurantHome /></RestaurantRoute>} />
        {/* لوحة الأدمن على /app */}
        <Route path="/app" element={
          <ProtectedRoute>
            <MainLayout />
          </ProtectedRoute>
        }>
          <Route index element={<PermissionRoute permission="canAccessDashboard"><DashboardPage /></PermissionRoute>} />
          <Route path="customers" element={<PermissionRoute permission="canManageCustomers"><CustomersPage /></PermissionRoute>} />
          <Route path="products" element={<PermissionRoute permission="canManageProducts"><ProductsPage /></PermissionRoute>} />
          <Route path="sales-reps" element={<PermissionRoute permission="canManageSalesReps"><SalesRepsPage /></PermissionRoute>} />
          <Route path="invoices" element={<PermissionRoute permission="canManageInvoices"><InvoicesPage /></PermissionRoute>} />
          <Route path="receipts" element={<PermissionRoute permission="canManageReceipts"><ReceiptsPage /></PermissionRoute>} />
          <Route path="reports" element={<PermissionRoute permission="canViewReports"><ReportsPage /></PermissionRoute>} />
          <Route path="van-stock" element={<PermissionRoute permission="canManageVanStock"><VanStockPage /></PermissionRoute>} />
          <Route path="tracking" element={<PermissionRoute permission="canManageTracking"><TrackingPage /></PermissionRoute>} />
          <Route path="company-users" element={<PermissionRoute permission="canManageCompanyUsers"><CompanyUsersPage /></PermissionRoute>} />
          <Route path="erp" element={<PermissionRoute permission="canManageCompanySettings"><ErpIntegrationPage /></PermissionRoute>} />
          <Route path="company" element={<PermissionRoute permission="canManageCompanySettings"><CompanySettingsPage /></PermissionRoute>} />
          <Route path="notifications" element={<NotificationsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
