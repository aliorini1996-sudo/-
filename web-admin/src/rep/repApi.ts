import axios from 'axios';
import { refClear } from './offlineDb';

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

// عميل API مستقل للمندوب — يستخدم مفتاح token خاص حتى لا يتعارض مع جلسة الأدمن
const repApi = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
});

repApi.interceptors.request.use(config => {
  const token = localStorage.getItem('rep_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// عند انتهاء الجلسة (401) — نمسح بيانات المندوب ونعيده لشاشة الدخول
// (يُستثنى طلب تسجيل الدخول نفسه ليُظهر رسالة الخطأ بدل إعادة التحميل)
repApi.interceptors.response.use(
  r => r,
  err => {
    const isLogin = (err.config?.url as string | undefined)?.includes('/auth/login');
    if (err.response?.status === 401 && !isLogin) {
      // نمسح البيانات المرجعية المخزّنة أيضاً كي لا يرثها من يدخل بعده على الجهاز نفسه
      void refClear();
      localStorage.removeItem('rep_token');
      localStorage.removeItem('rep_user');
      if (window.location.pathname.startsWith('/rep')) window.location.href = '/rep';
    }
    return Promise.reject(err);
  }
);

export default repApi;
