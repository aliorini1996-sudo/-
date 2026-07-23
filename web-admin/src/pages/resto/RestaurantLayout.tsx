import { Outlet, NavLink } from 'react-router-dom';
import { useState } from 'react';
import { LayoutDashboard, ScrollText, LayoutGrid, LogOut, KeyRound, Eye, ArrowRight, Monitor, Settings, BarChart3 } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { BrandIcon } from '../../components/BrandLogo';
import ChangePasswordModal from '../../components/ChangePasswordModal';

// شِل لوحة المطعم على /app-r — بهوية Field (نفس الشعار والألوان) وقائمة خاصّة بالمطاعم.
// يدعم شريط «تصفّح المالك» (عندما يدخل مالك المنصّة لشركة مطعم من /platform).
const navItems = [
  { to: '/app-r', icon: LayoutDashboard, label: 'الرئيسية', exact: true },
  { to: '/app-r/menu', icon: ScrollText, label: 'القائمة' },
  { to: '/app-r/tables', icon: LayoutGrid, label: 'الصالات والطاولات' },
  { to: '/app-r/reports', icon: BarChart3, label: 'التقارير' },
  { to: '/app-r/settings', icon: Settings, label: 'الإعدادات' },
];

export default function RestaurantLayout() {
  const { user, logout, impersonating, stopImpersonating } = useAuthStore();
  const [showPassword, setShowPassword] = useState(false);

  const handleLogout = () => { logout(); window.location.replace('/login'); };
  const backToPlatform = () => { stopImpersonating(); window.location.href = '/platform'; };

  return (
    <div className="h-screen flex flex-col" dir="rtl">
      {impersonating && (
        <div className="bg-amber-500 text-white px-4 py-2 flex items-center justify-between text-sm flex-shrink-0">
          <span className="flex items-center gap-2 font-medium">
            <Eye size={16} /> تتصفّح «{impersonating}» كمالك للمنصّة
          </span>
          <button onClick={backToPlatform} className="flex items-center gap-1.5 bg-white/20 hover:bg-white/30 rounded-lg px-3 py-1 font-semibold">
            <ArrowRight size={14} /> العودة للوحة المالك
          </button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden bg-slate-100">
        <aside className="w-60 flex-shrink-0 bg-[#1F1A13] text-white flex flex-col">
          <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/10">
            <BrandIcon size={36} radius={0.28} />
            <div>
              <p className="text-sm leading-tight" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }}>
                <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Restaurant</span>
              </p>
              <p className="text-[#9A8F7E] text-xs truncate max-w-[150px]">{user?.companyName || ''}</p>
            </div>
          </div>

          <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
            {navItems.map(item => (
              <NavLink key={item.to} to={item.to} end={item.exact}
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <item.icon size={18} className="flex-shrink-0" />
                <span>{item.label}</span>
              </NavLink>
            ))}
            {/* الكاشير — شاشة ملء الشاشة (خارج شِل اللوحة) */}
            <a href="/pos" className="sidebar-link w-full mt-2 bg-[#E15A30]/15 text-[#E15A30] hover:bg-[#E15A30]/25 hover:text-[#f0703f] font-semibold">
              <Monitor size={18} className="flex-shrink-0" /> <span>فتح الكاشير</span>
            </a>
          </nav>

          <div className="p-2 border-t border-white/10 space-y-1">
            <div className="px-4 py-1.5">
              <p className="text-xs text-[#9A8F7E] leading-tight">مرحباً،</p>
              <p className="text-sm font-semibold truncate leading-tight">{user?.name}</p>
            </div>
            {!impersonating && (
              <button onClick={() => setShowPassword(true)} className="sidebar-link w-full">
                <KeyRound size={18} /> <span>كلمة المرور</span>
              </button>
            )}
            <button onClick={handleLogout} className="sidebar-link w-full text-red-300 hover:bg-red-500/20 hover:text-red-200">
              <LogOut size={18} /> <span>تسجيل الخروج</span>
            </button>
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto">
          <div className="p-6"><Outlet /></div>
        </main>
      </div>
      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}
    </div>
  );
}
