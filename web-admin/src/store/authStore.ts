import { create } from 'zustand';
import { User } from '../types';
import { shouldAdopt, REJECTED_KEY, SIGNED_OUT_KEY } from './sessionAdoption';

interface AuthState {
  token: string | null;
  user: User | null;
  impersonating: string | null; // اسم الشركة التي يتصفّحها المالك حالياً (أو null)
  login: (token: string, user: User) => void;
  logout: () => void;
  sessionExpired: () => void;
  isAdmin: () => boolean;
  isSuperAdmin: () => boolean;
  impersonate: (token: string, user: User, companyName: string) => void;
  stopImpersonating: () => void;
}

// ───────────────────────────────────────────────────────────────
//  عزل الجلسات حسب «المساحة» لمنع تداخل الأدوار في نفس المتصفح:
//   • مالك المنصّة (سوبر أدمن): مفاتيح sa_token / sa_user  ← مساران /platform و /owner
//   • تطبيق الإدارة على الجوال: m_token / m_user           ← مسار /m
//   • أدمن الشركة (وجلسة الشركة أثناء انتحال المالك): token / user  ← مسار /
//   • المندوب: rep_token / rep_user (مُدار في rep/repApi.ts) ← مسار /rep
//  بهذا تستطيع الأدوار أن تسجّل الدخول معاً دون أن يطرد أحدها الآخر.
//
//  ولماذا لتطبيق الجوال مساحته: **الخروج منه يجب ألّا يُخرج من اللوحة**.
//  مشاركة المفاتيح كانت تعني أن زرّ الخروج في التطبيق يمحو جلسة اللوحة أيضاً
//  في المتصفّح نفسه. الآن جلستان مستقلّتان تماماً في الاتجاهين.
//
//  ولئلّا يُطلب دخولٌ ثانٍ بلا داعٍ: التطبيق **يتبنّى** جلسة اللوحة عند أوّل
//  فتح إن وُجدت (نسخةً في مساحته) — راجع `adoptDashboardSession` أدناه.
// ───────────────────────────────────────────────────────────────
type Space = { tokenKey: string; userKey: string; loginPath: string };

/** علامة «خرج من تطبيق الجوال عمداً» — تمنع التبنّي التلقائيّ بعدها */
const SIGNED_OUT = SIGNED_OUT_KEY;

/**
 * مساحة الجلسة للمسار الحاليّ — **المصدر الوحيد**، يستوردها عميل الـAPI أيضاً
 * (`api/client.ts`). تكرارها في موضعين يعني يوماً ما إرسالَ توكن مساحةٍ أخرى.
 */
export function sessionSpace(pathname = window.location.pathname): Space {
  if (pathname.startsWith('/platform') || pathname.startsWith('/owner')) {
    return { tokenKey: 'sa_token', userKey: 'sa_user', loginPath: '/owner' };
  }
  // انتهاء جلسة التطبيق تعيده إلى `/m` (شاشة دخوله الداخلية) لا إلى صفحة
  // الدخول المكتبية — وإلا قُذف المستخدم خارج التطبيق المثبَّت.
  if (pathname === '/m' || pathname.startsWith('/m/')) {
    return { tokenKey: 'm_token', userKey: 'm_user', loginPath: '/m' };
  }
  return { tokenKey: 'token', userKey: 'user', loginPath: '/login' };
}

const TKEY = () => sessionSpace().tokenKey;
const UKEY = () => sessionSpace().userKey;

/**
 * يتبنّى تطبيقُ الجوال جلسةَ اللوحة عند أوّل فتح — نسخةً في مساحته.
 *
 * الغاية: عزل الخروج بلا ثمنِ دخولٍ ثانٍ لمن هو مسجَّل أصلاً على اللوحة.
 * ويُستدعى قبل إنشاء المتجر كي يقرأ المتجرُ الجلسةَ المتبنّاة فوراً.
 *
 * ⚠️ **أثرٌ يجب أن يُعرَف:** بعد التبنّي صارت نسختان مستقلّتان من التوكن،
 * فالخروج من اللوحة لا يُنهي جلسة التطبيق (تبقى حتى انتهاء التوكن). وهذا
 * لا يُضعف شيئاً قائماً: الخروج في هذا النظام يمحو النسخة المحلّية ولا
 * يُبطل التوكن على الخادم أصلاً.
 */
function adoptDashboardSession() {
  try {
    const t = localStorage.getItem('token');
    const u = localStorage.getItem('user');
    /* القرار كلّه في `sessionAdoption.ts` دالّةً نقيّة مُختبَرة — ولا نسخة هنا.
     * وأهمّ شروطه: **لا يُتبنّى توكنٌ ردّه الخادم من قبل**. بدونه كان محوُ
     * التوكن عند ٤٠١ يعقبه إحياؤه عند الإقلاع التالي، فتدور الحلقة أبداً. */
    if (!shouldAdopt({
      path: window.location.pathname,
      mToken: localStorage.getItem('m_token'),
      dashToken: t,
      dashUserRaw: u,
      signedOut: localStorage.getItem(SIGNED_OUT),
      rejected: localStorage.getItem(REJECTED_KEY),
      nowMs: Date.now(),
    })) return;
    localStorage.setItem('m_token', t as string);
    localStorage.setItem('m_user', u as string);
  } catch { /* تجاهل: غياب التبنّي يعني شاشة دخول فقط */ }
}
adoptDashboardSession();

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

  // تسجيل دخول جديد = بداية نظيفة تماماً في مساحة الدور الصحيح (لا بقايا انتحال).
  // مالك المنصّة له مساحته أينما دخل؛ وغيره يدخل مساحة **المسار الحاليّ**
  // (تطبيق الجوال في m_*، واللوحة في token/user) فلا يطرد أحدهما الآخر.
  login: (token, user) => {
    const space = user.role === 'SUPER_ADMIN'
      ? { tokenKey: 'sa_token', userKey: 'sa_user' }
      : sessionSpace();
    localStorage.setItem(space.tokenKey, token);
    localStorage.setItem(space.userKey, JSON.stringify(user));
    // دخولٌ صريح يرفع علامة الخروج، فيعود التبنّي متاحاً لاحقاً
    if (space.tokenKey === 'm_token') localStorage.removeItem(SIGNED_OUT);
    // ووسمُ الرفض يُمسح بأيّ دخولٍ ناجح: التوكن الجديد غير المرفوض
    localStorage.removeItem(REJECTED_KEY);
    // «الانتحال» شأن اللوحة وحدها — لا يُمسّ من مساحة تطبيق الجوال
    if (space.tokenKey !== 'm_token') localStorage.removeItem('impersonating');
    set({ token, user, impersonating: space.tokenKey === 'm_token' ? get().impersonating : null });
  },

  /**
   * خروج = يمسح **مساحة المسار الحاليّ وحدها**.
   *
   * الخروج من تطبيق الجوال يمحو `m_*` فقط، فتبقى جلسة اللوحة في المتصفّح
   * نفسه كما هي — والعكس صحيح. ومالك المنصّة يمسح مساحته أينما كان.
   */
  logout: () => {
    const u = get().user;
    const space = u?.role === 'SUPER_ADMIN'
      ? { tokenKey: 'sa_token', userKey: 'sa_user' }
      : sessionSpace();
    localStorage.removeItem(space.tokenKey);
    localStorage.removeItem(space.userKey);
    // نرفع علامة الخروج الصريح كي لا يتبنّى التطبيقُ جلسةَ اللوحة عند إعادة فتحه
    if (space.tokenKey === 'm_token') localStorage.setItem(SIGNED_OUT, '1');
    // بقايا الانتحال تخصّ اللوحة — لا تُمسّ من تطبيق الجوال
    if (space.tokenKey !== 'm_token') {
      ['impersonating', 'owner_token', 'owner_user'].forEach(k => localStorage.removeItem(k));
    }
    set({ token: null, user: null, impersonating: space.tokenKey === 'm_token' ? get().impersonating : null });
  },

  /**
   * انتهت الجلسة من طرف الخادم (٤٠١) — لا خروجٌ اختاره المستخدم.
   *
   * والفرق بينهما ليس تسميةً: الخروج الصريح يرفع `m_signed_out` فيمنع التبنّي
   * أبداً حتى دخولٍ يدويّ، وهذا لا يرفعه — بل يسجّل **التوكن المرفوض وحده**،
   * فتبقى ميزة التبنّي حيّةً لأيّ جلسةٍ صحيحة لاحقة.
   */
  sessionExpired: () => {
    const space = get().user?.role === 'SUPER_ADMIN'
      ? { tokenKey: 'sa_token', userKey: 'sa_user' }
      : sessionSpace();
    const dead = localStorage.getItem(space.tokenKey);
    localStorage.removeItem(space.tokenKey);
    localStorage.removeItem(space.userKey);
    // الوسم لمساحة التطبيق وحدها: هي التي تتبنّى، وهي التي دارت فيها الحلقة
    if (space.tokenKey === 'm_token' && dead) localStorage.setItem(REJECTED_KEY, dead);
    if (space.tokenKey !== 'm_token') localStorage.removeItem('impersonating');
    set({ token: null, user: null, impersonating: space.tokenKey === 'm_token' ? get().impersonating : null });
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
