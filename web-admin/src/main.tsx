import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { useDir } from './i18n/lang';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000 },
  },
});

/**
 * التنبيهات بعامّة التطبيق — اتجاهها يتبع اللغة (RTL للعربية وحدها). كان مثبّتاً RTL فتظهر
 * الأيقونة يمين النصّ الإنجليزي وتنحاز أسطره لليمين.
 */
function AppToaster() {
  const dir = useDir();
  return (
    <Toaster
      position="top-center"
      toastOptions={{
        duration: 3000,
        style: { fontFamily: 'Noto Kufi Arabic, IBM Plex Sans, system-ui, sans-serif', direction: dir, fontSize: '14px' },
        success: { iconTheme: { primary: '#10b981', secondary: 'white' } },
        error: { iconTheme: { primary: '#ef4444', secondary: 'white' } },
      }}
    />
  );
}

// تسجيل Service Worker (PWA) — يجعل تطبيق المندوب قابلاً للتثبيت على الجوال
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <AppToaster />
    </QueryClientProvider>
  </React.StrictMode>
);

// إخفاء شاشة الإقلاع بعد أول رسم لـReact — بمشغّلات متعددة لضمان العمل حتى في التبويبات
// الخلفية (حيث يتوقّف requestAnimationFrame)، فلا تبقى الشاشة تُغطّي التطبيق أبداً.
function hideBoot() {
  const boot = document.getElementById('boot');
  if (!boot || boot.classList.contains('hide')) return;
  boot.classList.add('hide');
  setTimeout(() => boot.remove(), 400);
}
requestAnimationFrame(() => requestAnimationFrame(hideBoot)); // المسار السريع (تبويب أمامي)
setTimeout(hideBoot, 1500);                                    // احتياطي مضمون يعمل في كل الحالات
window.addEventListener('load', hideBoot);                     // بعد اكتمال تحميل الموارد
document.addEventListener('visibilitychange', () => { if (!document.hidden) hideBoot(); }); // عند إظهار التبويب
