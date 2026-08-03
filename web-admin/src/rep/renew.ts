import { shouldRenew } from './jwt';

/**
 * تجديد جلسة المندوب صامتاً — **الحلّ الجذريّ للإخراج المفاجئ**.
 *
 * التاريخ: عولجت الشكوى مرّةً بمنع الإخراج الكاذب (401 عابر)، فبقي الإخراج
 * **الصحيح**: التوكن يعيش ٨ ساعات ثمّ ينتهي، والخمول يستهلكها كما يستهلكها
 * العمل. وسجلّ الإنتاج أظهر البصمة بوضوح: أربعة طلبات 401 في الثانية نفسها
 * ثمّ `POST /auth/login` بعدها بأربع ثوانٍ — أي مندوبٌ قُذف فأعاد الدخول.
 *
 * ثلاث لحظات تجديد، وكلٌّ منها يسدّ ثغرةً في الأخرى:
 *  1. **استباقيّ**: كلّما بقي للتوكن أقلّ من ساعتين. يغطّي التطبيق المفتوح.
 *  2. **عند العودة**: الجوال يجمّد مؤقّتات التبويب المخفيّ، فالمؤقّت وحده لا
 *     يكفي — نجدّد عند ظهور الشاشة مجدداً.
 *  3. **إنقاذيّ عند 401**: لو انتهى التوكن رغم ذلك (جهاز نائم ليلاً)، نجدّد
 *     ونعيد الطلب الفاشل. المندوب لا يرى شاشة دخول أصلاً.
 *
 * ولا يُخرَج إلا إذا **رفض الخادم التجديد** — أي انتهت نافذة السماح فعلاً أو
 * عُطِّل الحساب.
 */

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

let inFlight: Promise<string | null> | null = null;

/**
 * رفضٌ نهائيّ سابق — يمنع طرق الباب المغلق.
 *
 * الطلبات الخلفية (نبضة الموقع/الحضور) لا تُخرج المندوب عمداً. فلو عُطِّل
 * حسابُه، ترتدّ نبضةٌ كل دقيقة بـ401 فتطلب تجديداً يُرفض — إلى الأبد. نُثبّت
 * الرفض فلا يُعاد الطلب إلا بعد فترة أو بعد دخولٍ جديد.
 */
let rejectedUntil = 0;
const REJECT_BACKOFF_MS = 5 * 60 * 1000;

/** يُستدعى عند تسجيل دخول جديد: الباب قد يكون فُتح */
export function clearRenewRejection() { rejectedUntil = 0; }

/**
 * يطلب توكناً جديداً بالتوكن الحاليّ (ولو انتهى).
 *
 * **مشترك**: نداءات متزامنة تنتظر الطلب نفسه. بدون ذلك يُطلق كل طلب فاشل
 * تجديدَه الخاصّ — وقد رأينا في السجلّ أربعة طلبات تفشل معاً في الثانية نفسها،
 * أي أربعة تجديدات متوازية تسحق حدّ المعدّل ويكتب بعضُها فوق بعض.
 *
 * @returns التوكن الجديد، أو null إن رفض الخادم (يجب الإخراج حينها)
 */
export function renewToken(): Promise<string | null> {
  if (inFlight) return inFlight;
  // رُفض قريباً ⇒ لا نطرق الباب مجدداً. نُعيد الرفض نفسه كي يُخرَج الطلبُ
  // الأماميّ إن وُجد، بلا أن تُغرق النبضاتُ الخلفية الخادمَ بالمحاولات.
  if (Date.now() < rejectedUntil) return Promise.resolve(null);
  inFlight = (async () => {
    const token = localStorage.getItem('rep_token');
    if (!token) return null;
    try {
      const res = await fetch(`${BASE}/auth/renew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        // 401/403 = رفضٌ نهائيّ (نافذة انتهت أو حساب معطَّل) ⇒ إخراج.
        // أمّا 429 أو خطأ شبكة أو 5xx فليس رفضاً — نتركه للمحاولة التالية،
        // وإلا أخرجَ حدُّ المعدّل مندوباً جلستُه سليمة.
        if (res.status === 401 || res.status === 403) {
          rejectedUntil = Date.now() + REJECT_BACKOFF_MS;
          return null;
        }
        return token;
      }
      rejectedUntil = 0;
      const body = await res.json();
      const fresh = body?.data?.token as string | undefined;
      if (!fresh) return token;
      localStorage.setItem('rep_token', fresh);
      if (body?.data?.user) localStorage.setItem('rep_user', JSON.stringify(body.data.user));
      return fresh;
    } catch {
      return token; // انقطاع شبكة: لا نُخرج، نعيد الحاليّ ونحاول لاحقاً
    } finally {
      // نُفرغ بعد تكة كي تلتقط النداءات المتزامنة النتيجة نفسها
      setTimeout(() => { inFlight = null; }, 0);
    }
  })();
  return inFlight;
}

/** يجدّد إن قارب التوكن الانتهاء (أو انتهى) — وإلا لا يفعل شيئاً */
export async function renewIfNeeded(): Promise<void> {
  if (!shouldRenew(localStorage.getItem('rep_token'))) return;
  await renewToken();
}

/**
 * يُشغّل حلقة التجديد: مؤقّت دوريّ + عند عودة الشاشة + عند عودة الشبكة.
 * @returns دالّة إيقاف
 */
export function startRenewLoop(): () => void {
  void renewIfNeeded(); // عند الإقلاع فوراً

  // كل ربع ساعة: يكفي بفارق مريح قبل عتبة الساعتين
  const iv = window.setInterval(() => { void renewIfNeeded(); }, 15 * 60 * 1000);

  // الجوال يجمّد مؤقّتات التبويب المخفيّ — فالعودة إلى الشاشة لحظة تجديد أهمّ
  const onVisible = () => { if (document.visibilityState === 'visible') void renewIfNeeded(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('online', onVisible);

  return () => {
    window.clearInterval(iv);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    window.removeEventListener('online', onVisible);
  };
}
