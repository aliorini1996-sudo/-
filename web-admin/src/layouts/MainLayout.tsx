import { Outlet, NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Users, Package, UserCheck, FileText,
  Receipt, BarChart3, Bell, LogOut, ChevronLeft, Building2, Eye, ArrowRight, KeyRound, Truck, MapPin, LifeBuoy,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useState } from 'react';
import ChangePasswordModal from '../components/ChangePasswordModal';
import SupportModal from '../components/SupportModal';
import { BrandIcon } from '../components/BrandLogo';
import LanguageToggle from '../components/LanguageToggle';
import { useT } from '../i18n/strings';

const navItems = [
  { to: '/app', icon: LayoutDashboard, label: 'nav.dashboard', exact: true },
  { to: '/app/customers', icon: Users, label: 'nav.customers' },
  { to: '/app/products', icon: Package, label: 'nav.products' },
  { to: '/app/sales-reps', icon: UserCheck, label: 'nav.reps' },
  { to: '/app/van-stock', icon: Truck, label: 'nav.vanStock' },
  { to: '/app/tracking', icon: MapPin, label: 'nav.tracking' },
  { to: '/app/invoices', icon: FileText, label: 'nav.invoices' },
  { to: '/app/receipts', icon: Receipt, label: 'nav.receipts' },
  { to: '/app/reports', icon: BarChart3, label: 'nav.reports' },
  { to: '/app/company', icon: Building2, label: 'nav.company' },
];

export default function MainLayout() {
  const { user, logout, impersonating, stopImpersonating } = useAuthStore();
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showSupport, setShowSupport] = useState(false);

  const handleLogout = () => {
    logout();
    // إعادة تحميل كاملة لمسح ذاكرة React Query ومنع تسرّب بيانات بين الجلسات
    window.location.replace('/login');
  };

  const backToPlatform = () => {
    stopImpersonating();
    // إعادة تحميل كاملة لتجنّب سباق إعادة التقييم عند استعادة هوية المالك
    window.location.href = '/platform';
  };

  return (
    <div className="h-screen flex flex-col" dir="rtl">
      {/* شريط وضع المالك (عند تصفّح شركة) */}
      {impersonating && (
        <div className="bg-amber-500 text-white px-4 py-2 flex items-center justify-between text-sm flex-shrink-0">
          <span className="flex items-center gap-2 font-medium">
            <Eye size={16} /> {t('nav.impersonating')} «{impersonating}» {t('nav.asOwner')}
          </span>
          <button onClick={backToPlatform} className="flex items-center gap-1.5 bg-white/20 hover:bg-white/30 rounded-lg px-3 py-1 font-semibold">
            <ArrowRight size={14} /> {t('nav.backToPlatform')}
          </button>
        </div>
      )}
    <div className="flex flex-1 overflow-hidden bg-slate-100">
      {/* Sidebar */}
      <aside className={`${collapsed ? 'w-16' : 'w-60'} flex-shrink-0 bg-[#1F1A13] text-white flex flex-col transition-all duration-300`}>
        {/* Logo */}
        <div className={`flex items-center gap-3 px-4 py-5 border-b border-white/10 ${collapsed ? 'justify-center' : ''}`}>
          <BrandIcon size={36} radius={0.28} />
          {!collapsed && (
            <div>
              <p className="text-sm leading-tight" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }}>
                <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
              </p>
              <p className="text-[#9A8F7E] text-xs truncate max-w-[150px]">{user?.companyName || ''}</p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) =>
                `sidebar-link ${isActive ? 'active' : ''} ${collapsed ? 'justify-center px-2' : ''}`
              }
              title={collapsed ? t(item.label) : undefined}
            >
              <item.icon size={18} className="flex-shrink-0" />
              {!collapsed && <span>{t(item.label)}</span>}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        <div className="p-2 border-t border-white/10 space-y-1">
          <NavLink
            to="/app/notifications"
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''} ${collapsed ? 'justify-center px-2' : ''}`}
          >
            <Bell size={18} />
            {!collapsed && <span>{t('nav.notifications')}</span>}
          </NavLink>
          {/* تبديل اللغة */}
          <div className={collapsed ? 'flex justify-center' : ''}>
            <LanguageToggle variant="dark" />
          </div>
          {!collapsed && (
            <div className="px-4 py-2">
              <p className="text-xs text-[#9A8F7E]">{t('login.welcomeName')}،</p>
              <p className="text-sm font-semibold truncate">{user?.name}</p>
            </div>
          )}
          {/* تغيير كلمة المرور — يُخفى أثناء تصفّح المالك لشركة (لأنه ليس حسابه) */}
          {!impersonating && (
            <button
              onClick={() => setShowPassword(true)}
              className={`sidebar-link w-full ${collapsed ? 'justify-center px-2' : ''}`}
              title={collapsed ? t('nav.changePassword') : undefined}
            >
              <KeyRound size={18} />
              {!collapsed && <span>{t('nav.changePassword')}</span>}
            </button>
          )}
          <button
            onClick={() => setShowSupport(true)}
            className={`sidebar-link w-full ${collapsed ? 'justify-center px-2' : ''}`}
            title={collapsed ? t('nav.support') : undefined}
          >
            <LifeBuoy size={18} />
            {!collapsed && <span>{t('nav.support')}</span>}
          </button>
          <button
            onClick={handleLogout}
            className={`sidebar-link w-full text-red-300 hover:bg-red-500/20 hover:text-red-200 ${collapsed ? 'justify-center px-2' : ''}`}
          >
            <LogOut size={18} />
            {!collapsed && <span>{t('nav.logout')}</span>}
          </button>
        </div>
      </aside>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="absolute top-6 right-[230px] z-10 w-6 h-6 bg-white rounded-full shadow-md flex items-center justify-center text-gray-500 hover:text-blue-600 transition-all"
        style={{ right: collapsed ? '52px' : '228px' }}
      >
        <ChevronLeft size={14} className={`transition-transform ${collapsed ? 'rotate-180' : ''}`} />
      </button>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-6">
          <Outlet />
        </div>
      </main>
    </div>
    {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}
    {showSupport && <SupportModal onClose={() => setShowSupport(false)} />}
    </div>
  );
}
