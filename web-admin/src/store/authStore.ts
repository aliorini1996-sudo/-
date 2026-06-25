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

// ───────────────────────────────────────────────────────────────
//  عزل الجلسات حسب «المساحة» لمنع تداخل الأدوار في نفس المتصفح:
//   • مالك المنصّة (سوبر أدمن): مفاتيح sa_token / sa_user  ← مساران /platform و /owner
//   • أدمن الشركة (وجلسة الشركة أثناء انتحال المالك): token / user  ← مسار /
//   • المندوب: rep_token / rep_user (مُدار في rep/repApi.ts) ← مسار /rep
//  بهذا يستطيع المالك والأدمن تسجيل الدخول معاً دون أن يطرد أحدهما الآخر.
// ───────────────────────────────────────────────────────────────
const isPlatformPath = () => {
  const p = window.location.pathname;
  return p.startsWith('/platform') || p.startsWith('/owner');
};
const TKEY = () => (isPlatformPath() ? 'sa_token' : 'token');
const UKEY = () => (isPlatformPath() ? 'sa_user' : 'user');

// ترحيل لمرّة واحدة: مستخدمو النظام القديم قد تكون جلسة المالك مخزّنة في مفاتيح الأدمن (token/user).
// ننقلها لمساحة المالك وننظّف المفاتيح القديمة غير المستخدمة (owner_token/owner_user).
(() => {
  try {
    const legacy = JSON.parse(localStorage.getItem('user') || 'null');
    if (legacy?.role === 'SUPER_ADMIN') {
      const t = localStorage.getItem('token');
      if (t && !localStorage.getItem('sa_token')) {
        localStorage.setItem('sa_token', t);
        localStorage.setItem('sa_user', JSON.stringify(legacy));
      }
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }
    localStorage.removeItem('owner_token');
    localStorage.removeItem('owner_user');
  } catch { /* تجاهل */ }
})();

const readUser = (): User | null => {
  try { return JSON.parse(localStorage.getItem(UKEY()) || 'null'); } catch { return null; }
};

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem(TKEY()),
  user: readUser(),
  impersonating: localStorage.getItem('impersonating'),

  // تسجيل دخول جديد = بداية نظيفة تماماً في مساحة الدور الصحيح (لا بقايا انتحال)
  login: (token, user) => {
    const platform = user.role === 'SUPER_ADMIN';
    localStorage.setItem(platform ? 'sa_token' : 'token', token);
    localStorage.setItem(platform ? 'sa_user' : 'user', JSON.stringify(user));
    localStorage.removeItem('impersonating');
    set({ token, user, impersonating: null });
  },

  // خروج = يمسح مساحة المستخدم الحالي فقط (المالك أو الأدمن) + أي بقايا انتحال
  logout: () => {
    const u = get().user;
    if (u?.role === 'SUPER_ADMIN') {
      localStorage.removeItem('sa_token');
      localStorage.removeItem('sa_user');
    } else {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }
    ['impersonating', 'owner_token', 'owner_user'].forEach(k => localStorage.removeItem(k));
    set({ token: null, user: null, impersonating: null });
  },

  isAdmin: () => {
    const u = get().user;
    return !!u && ['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(u.role);
  },
  isSuperAdmin: () => get().user?.role === 'SUPER_ADMIN',

  // المالك يدخل لوحة شركة: جلسة المالك تبقى محفوظة بأمان في sa_token،
  // ونضع جلسة الشركة في مساحة الأدمن (token/user) مع علم الانتحال.
  impersonate: (token, user, companyName) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('impersonating', companyName);
    set({ token, user, impersonating: companyName });
  },

  // العودة لجلسة المالك: نمسح جلسة الشركة فقط (sa_token للمالك يبقى سليماً)
  stopImpersonating: () => {
    ['token', 'user', 'impersonating'].forEach(k => localStorage.removeItem(k));
    set({ token: null, user: null, impersonating: null });
  },
}));
