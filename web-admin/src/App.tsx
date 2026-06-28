import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import MainLayout from './layouts/MainLayout';
import LandingPage from './pages/LandingPage';
import InfoPage from './pages/InfoPage';
import ContactPage from './pages/ContactPage';
import SignupPage from './pages/SignupPage';
import LoginPage from './pages/LoginPage';
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
        {/* الصفحات التعريفية الفرعية (عامة) */}
        <Route path="/about" element={<InfoPage pageKey="about" />} />
        <Route path="/terms" element={<InfoPage pageKey="terms" />} />
        <Route path="/service-agreement" element={<InfoPage pageKey="serviceAgreement" />} />
        <Route path="/privacy" element={<InfoPage pageKey="privacy" />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/platform" element={<SuperAdminRoute><PlatformPage /></SuperAdminRoute>} />
        {/* لوحة الأدمن على /app */}
        <Route path="/app" element={
          <ProtectedRoute>
            <MainLayout />
          </ProtectedRoute>
        }>
          <Route index element={<DashboardPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="sales-reps" element={<SalesRepsPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="receipts" element={<ReceiptsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="van-stock" element={<VanStockPage />} />
          <Route path="tracking" element={<TrackingPage />} />
          <Route path="company-users" element={<CompanyUsersPage />} />
          <Route path="company" element={<CompanySettingsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
