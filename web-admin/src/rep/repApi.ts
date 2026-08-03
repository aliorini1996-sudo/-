import axios from 'axios';
import { refClear } from './offlineDb';
import { tokenExpiredOrMissing } from './jwt';

// نسمح للطلب بوسم نفسه «خلفياً» فلا يُخرج المندوب عند فشل 401 عابر.
// انظر التعليق على المعترِض أدناه للسبب.
declare module 'axios' {
  export interface AxiosRequestConfig {
    /** طلب خلفي تلقائي (نبضة تتبّع/حضور): فشله لا يُنهي جلسة المندوب */
    background?: boolean;
  }
}

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

// عند انتهاء الجلسة (401) — نمسح بيانات المندوب ونعيده لشاشة الدخول.
//
// طبقتا حماية ضدّ الإخراج الكاذب (شكوى المناديب: خروج متكرّر يقطع التتبّع):
//
// (١) **النبضات الخلفية** (تتبّع/حضور) لا تُخرج المندوب إطلاقاً — تنطلق كل
//     دقيقة، فأي 401 عابر منها كان يقطع الجلسة بلا سبب حقيقي.
//
// (٢) **حتى الطلب الأمامي لا يُخرج إلا إذا انتهى التوكن فعلاً.** الخادم خلف
//     Cloudflare، ورُصد في سجلّاته 401 متفرّق ثم تتالٍ: فشل واحد كان يمسح
//     التوكن، فتُعاد الطلبات بلا توكن فتفشل كلّها ⇒ إخراج مؤكَّد من هيكوب
//     لحظي. الآن نفكّ التوكن محلياً: إن كان صالحاً غير منتهٍ فالـ401 عابر
//     ⇒ **نُبقي الجلسة ونترك النداء يفشل ويُعاد** لاحقاً؛ ولا نُخرج إلا إذا
//     انتهى التوكن أو غاب (جلسة انتهت فعلاً). هذا يكسر التتالي من جذره.
//
// (ويُستثنى طلب تسجيل الدخول نفسه ليُظهر رسالة الخطأ بدل إعادة التحميل.)
repApi.interceptors.response.use(
  r => r,
  err => {
    const isLogin = (err.config?.url as string | undefined)?.includes('/auth/login');
    const isBackground = err.config?.background === true;
    if (err.response?.status === 401 && !isLogin && !isBackground
        && tokenExpiredOrMissing(localStorage.getItem('rep_token'))) {
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
