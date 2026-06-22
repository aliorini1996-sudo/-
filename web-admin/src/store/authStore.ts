import { create } from 'zustand';
import { User } from '../types';

interface AuthState {
  token: string | null;
  user: User | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  isAdmin: () => boolean;
  isSuperAdmin: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('token'),
  user: (() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
  })(),
  login: (token, user) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ token, user });
  },
  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    set({ token: null, user: null });
  },
  isAdmin: () => {
    const u = get().user;
    return !!u && ['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(u.role);
  },
  isSuperAdmin: () => get().user?.role === 'SUPER_ADMIN',
}));
