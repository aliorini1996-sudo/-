/**
 * فكّ حمولة JWT على العميل — **بلا تحقّق توقيع**، لقراءة `exp` فقط.
 *
 * الغرض الوحيد: تمييز 401 الحقيقي (انتهت الجلسة فعلاً) من 401 العابر (هيكوب
 * شبكة أو بوّابة Cloudflare، أو تتالٍ بعد فشل واحد). المعترِض يُخرج المندوب
 * فقط عند الأوّل، فلا يُكسر عمله بسبب فشل لحظي.
 *
 * ⚠️ هذا ليس تحقّقاً أمنياً — الخادم وحده يتحقّق من التوقيع. هنا نقرأ الادّعاء
 * المحلّي عن الانتهاء لا أكثر.
 */

/**
 * فكّ base64url إلى JSON مع **معالجة UTF-8 صحيحة**.
 *
 * حرج: توكن المندوب يحمل حقل `name` باسمه، وقد يكون عربياً. فكٌّ ساذج
 * (`JSON.parse(atob(...))`) يُفسد البايتات متعدّدة الوحدات فيرمي استثناءً،
 * فتُعدّ الحمولة «غير قابلة للفكّ» ⇒ يُخرَج المندوب عند **كل** 401 حتى بتوكن
 * صالح — أي عكس الغرض تماماً. لذا نفكّ البايتات ثم نُمرّرها على TextDecoder.
 */
function decodePayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8').decode(bytes);
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * هل التوكن مفقود أو منتهٍ فعلاً؟
 *
 * السياسة محافِظة عمداً: **عند أي شكّ نعدّه منتهياً**. توكن مشوّه أو بلا `exp`
 * لا نثق به. أما توكننا الصحيح فيحمل دائماً `exp` رقمياً وثلاثة أجزاء، فإن
 * قرأناه ووجدناه في المستقبل ⇒ 401 عابر لا يُخرِج.
 *
 * @param skewMs هامش انحراف الساعة (نعدّه منتهياً قبل الوقت بهذا القدر)
 */
export function tokenExpiredOrMissing(token: string | null | undefined, skewMs = 0): boolean {
  if (!token) return true;
  const payload = decodePayload(token);
  if (!payload || typeof payload.exp !== 'number') return true;
  return payload.exp * 1000 <= Date.now() + skewMs;
}

/** الثواني المتبقية للتوكن (0 إن منتهٍ/مفقود) — للتشخيص لا للقرار الأمني */
export function tokenSecondsLeft(token: string | null | undefined): number {
  if (!token) return 0;
  const payload = decodePayload(token);
  if (!payload || typeof payload.exp !== 'number') return 0;
  return Math.max(0, Math.round(payload.exp - Date.now() / 1000));
}
