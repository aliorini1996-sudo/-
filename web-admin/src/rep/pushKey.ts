/** مفتاح الإشعارات العامّ (base64url، ٦٥ بايتاً غير مضغوط) ⇒ بايتات applicationServerKey — صرفٌ يُختبر وحده */
export function urlB64ToBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** صاحب اشتراك الإشعارات على هذا الجهاز (معرّف المندوب الذي حُفظ له في الخادم) */
export const PUSH_OWNER_KEY = 'fs_push_rep';

/**
 * اشتراك هذا الجهاز إن وُجد — بـgetRegistration لا serviceWorker.ready: هذه لا تُحلّ أبداً حين فشل تسجيل العامل،
 * فيعلق الخروج وزرّ التفعيل بلا نهاية. بلا اعتمادٍ على repApi، فيستدعيها معترضه في الخروج القسري.
 */
export async function localPushSubscription(): Promise<PushSubscription | null> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager?.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** يلغي اشتراك الجهاز محلياً بلا شبكة وبمهلة — الخروج القسري ودخول حسابٍ آخر: لا تصل الجهازَ تنبيهاتُ حسابٍ غادره */
export async function unsubscribeLocalPush(timeoutMs = 2000): Promise<void> {
  const work = (async () => {
    const sub = await localPushSubscription();
    if (sub) await sub.unsubscribe();
    try { localStorage.removeItem(PUSH_OWNER_KEY); } catch { /* تخزينٌ محجوب */ }
  })().catch(() => { /* لا يمنع الخروج */ });
  await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs))]);
}
