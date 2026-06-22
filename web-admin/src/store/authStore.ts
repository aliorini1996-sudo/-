import { create } from 'zustand';
import { User } from '../types';

interface AuthState {
  token: string | null;
  user: User | null;
  impersonating: string | null; // اسم الشركة التي يتصفّحها المالك حالياً (أو null)
  login: (token: string, user: User) => void;
  logout: () => void;
  isAdmin: () => boolean;
  isSuperAdmin: () => boolean;
  impersonate: (token: string, user: User, companyName: string) => void;
  stopImpersonating: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('token'),
  user: (() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
  })(),
  impersonating: localStorage.getItem('impersonating'),
  login: (token, user) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ token, user });
  },
  logout: () => {
    ['token', 'user', 'owner_token', 'owner_user', 'impersonating'].forEach(k => localStorage.removeItem(k));
    set({ token: null, user: null, impersonating: null });
  },
  isAdmin: () => {
    const u = get().user;
    return !!u && ['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(u.role);
  },
  isSuperAdmin: () => get().user?.role === 'SUPER_ADMIN',
  // المالك يدخل لوحة شركة — نحفظ جلسة المالك ونبدّلها بجلسة الشركة
  impersonate: (token, user, companyName) => {
    const cur = get();
    if (cur.token) localStorage.setItem('owner_token', cur.token);
    if (cur.user) localStorage.setItem('owner_user', JSON.stringify(cur.user));
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('impersonating', companyName);
    set({ token, user, impersonating: companyName });
  },
  // العودة لجلسة المالك
  stopImpersonating: () => {
    const ot = localStorage.getItem('owner_token');
    const ou = localStorage.getItem('owner_user');
    if (ot && ou) {
      localStorage.setItem('token', ot);
      localStorage.setItem('user', ou);
      ['owner_token', 'owner_user', 'impersonating'].forEach(k => localStorage.removeItem(k));
      set({ token: ot, user: JSON.parse(ou), impersonating: null });
    }
  },
}));
