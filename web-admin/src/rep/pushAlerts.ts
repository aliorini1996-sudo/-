// تنبيهات الحضور على جوال المندوب (Web Push، طلب المالك ٢١ أكتوبر ٢٠٢٦): «قبل بداية الدوام» و«نسيت الانصراف».
//
// المندوب يفعّلها بضغطة من شاشة البصمة (الإذن يُطلب داخل النقرة)، فيُحفظ اشتراك جهازه في الخادم ومعه إزاحة توقيته
// ولغته، والخادم يرسل في موعده (backend/src/services/attendanceAlerts.ts). عامل الخدمة (public/sw.js) يعرض الإشعار.
// آيفون: الإشعارات لتطبيق الويب المضاف إلى الشاشة الرئيسية وحده (iOS 16.4+).
import repApi from './repApi';
import { useLang } from '../i18n/lang';
import { urlB64ToBytes, localPushSubscription, unsubscribeLocalPush, PUSH_OWNER_KEY } from './pushKey';

export type PushState = 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on';

// ‏iPadOS 13+ يقدّم نفسه «ماك» في User-Agent سفاري — يُعرف باللمس المتعدّد على منصّة MacIntel
export const isIos = () => typeof navigator !== 'undefined'
  && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const standalone = () => typeof window !== 'undefined'
  && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

function supported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}


/** العامل جاهزاً للاشتراك — بمهلة: ready لا تُحلّ أبداً حين فشل تسجيله، فيعلق زرّ التفعيل على «جارٍ التسجيل» */
async function readyRegistration(timeoutMs = 10_000): Promise<ServiceWorkerRegistration | null> {
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
  } catch { return null; }
}

const currentRepId = (): string | null => {
  try { return (JSON.parse(localStorage.getItem('rep_user') || 'null') as { id?: string } | null)?.id ?? null; } catch { return null; }
};

/** حالة التنبيهات على هذا الجهاز الآن */
export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !standalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  return (await localPushSubscription()) ? 'on' : 'off';
}

/** لغة التطبيق الحالية — نصّ التنبيه يُرسل بها */
const lang = () => useLang.getState().lang;

async function save(sub: PushSubscription): Promise<void> {
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await repApi.post('/tracking/push/subscribe', {
    subscription: { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } },
    tzOffsetMin: -new Date().getTimezoneOffset(),
    lang: lang(),
  });
  try { const id = currentRepId(); if (id) localStorage.setItem(PUSH_OWNER_KEY, id); } catch { /* تخزينٌ محجوب */ }
}

/** يفعّل التنبيهات — يُستدعى من نقرة (إذن الإشعارات يُطلب داخلها). يعيد الحالة بعد المحاولة */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return pushState();
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await readyRegistration();
  if (!reg) return 'unsupported';
  const { data } = await repApi.get('/tracking/push/key');
  const key = urlB64ToBytes(data.data.publicKey as string);
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // اشتراكٌ قديم بمفتاحٍ آخر لا يصلح لخادمنا — يُجدَّد
    const old = sub.options?.applicationServerKey;
    if (old && new Uint8Array(old as ArrayBuffer).toString() !== key.toString()) { await sub.unsubscribe(); sub = null; }
  }
  const fresh = !sub;
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  try {
    await save(sub);
  } catch (e) {
    // اشتراكٌ أُنشئ الآن ولم يحفظه الخادم: يُلغى فتبقى الحالة «غير مفعّلة» وزرّ التفعيل ظاهراً — لا «مفعّلة» بلا تنبيهات
    if (fresh) await sub.unsubscribe().catch(() => false);
    throw e;
  }
  return 'on';
}

/** عند فتح شاشة البصمة: الاشتراك القائم يُعاد إرساله (توقيت الجهاز ولغته قد تغيّرا، أو الحساب تبدّل على الجهاز) */
export async function refreshPush(): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return;
  const sub = await localPushSubscription();
  if (sub) await save(sub).catch(() => { /* دون اتصال: في المرّة القادمة */ });
}

/**
 * عند الدخول: اشتراكٌ على هذا الجهاز لحسابٍ آخر (أو بلا صاحبٍ معروف) يُلغى محلياً — حسابٌ خرج قسراً (رُفض تجديده) لم
 * يُلغِ اشتراكه، فتصل تنبيهات دوامه من بعده جوالَ مندوبٍ آخر ولو من شركةٍ أخرى. الخادم يحذف صفّه عند أول إرسالٍ يُرفض.
 */
export async function forgetForeignPush(repId: string): Promise<void> {
  let owner: string | null = null;
  try { owner = localStorage.getItem(PUSH_OWNER_KEY); } catch { /* تخزينٌ محجوب */ }
  if (owner === repId) return;
  if (await localPushSubscription()) await unsubscribeLocalPush();
}

/** عند تسجيل الخروج: الجهاز لا يتلقّى تنبيهات حسابٍ خرج منه */
export async function dropPush(): Promise<void> {
  try {
    const sub = await localPushSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    // محلياً أولاً (لا يحتاج شبكة)، ثمّ إخبار الخادم بمهلةٍ قصيرة: شبكةٌ ميدانية معلّقة لا تعلّق الخروج
    await sub.unsubscribe().catch(() => false);
    try { localStorage.removeItem(PUSH_OWNER_KEY); } catch { /* تخزينٌ محجوب */ }
    await repApi.post('/tracking/push/unsubscribe', { endpoint }, { background: true, timeout: 3000 }).catch(() => {});
  } catch { /* لا يمنع الخروج */ }
}
