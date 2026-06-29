import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import MainLayout from './layouts/MainLayout';
import LandingPage from './pages/LandingPage';
import InfoPage from './pages/InfoPage';
import ContactPage from './pages/ContactPage';
import SignupPage from './pages/SignupPage';
import LoginPage from './pages/LoginPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import BlogIndexPage from './pages/BlogIndexPage';
import BlogPostPage from './pages/BlogPostPage';
import DashboardPage from './pages/DashboardPage';
import CustomersPage from './pages/CustomersPage';
import ProductsPage from './pages/ProductsPage';
import SalesRepsPage from './pages/SalesRepsPage';
import InvoicesPage from './pages/InvoicesPage';
import ReceiptsPage from './pages/ReceiptsPage';
import ReportsPage from './pages/ReportsPage';
import NotificationsPage from './pages/NotificationsPage';
import CompanySettingsPage from './pages/CompanySettingsPage';
import CompanyUsersPage from './pages/CompanyUsersPage';
import ErpIntegrationPage from './pages/ErpIntegrationPage';
import VanStockPage from './pages/VanStockPage';
import TrackingPage from './pages/TrackingPage';
import PlatformPage from './pages/PlatformPage';
import OwnerLoginPage from './pages/OwnerLoginPage';
import RepApp from './rep/RepApp';

// لوحة الأدمن على /app — الجذر "/" يبقى دائماً الصفحة التعريفية
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuthStore();
  if (!token) return <Navigate to="/login" replace />;
  if (user?.role === 'SUPER_ADMIN') return <Navigate to="/platform" replace />;
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

export default function App() {
  return (
    <BrowserRouter>
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
        <Route path="/blog" element={<BlogIndexPage />} />
        <Route path="/blog/:slug" element={<BlogPostPage />} />
        <Route path="/platform" element={<SuperAdminRoute><PlatformPage /></SuperAdminRoute>} />
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
    </BrowserRouter>
  );
}
