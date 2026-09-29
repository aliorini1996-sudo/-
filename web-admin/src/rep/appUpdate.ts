/**
 * تحديث تطبيق المندوب نفسه حين تُنشر نسخة أحدث (بلاغ المالك، ٢٩ سبتمبر ٢٠٢٦: «بصمة الحضور مفعّلة للشركة ولا تظهر لبعض مناديبها»).
 *
 * السبب: تطبيق المندوب (TWA/PWA) يبقى مفتوحاً في خلفية الجوال أياماً، فيظلّ يشغّل شيفرة الحزمة التي فُتح بها — وإعادة جلب إعدادات
 * الشركة عند العودة إلى التطبيق تحدّث البيانات لا الشيفرة. فمندوبٌ فتح تطبيقه قبل نشر ميزةٍ لا يرى زرّها ولو فُعّلت لشركته.
 *
 * العلاج: البناء ينشر `/build.json` بمعرّف الحزمة (vite.config.ts)، والتطبيق يقارنه بمعرّفه (BUILD_ID) كل بضع دقائق وعند العودة إليه.
 * المعرّف يبدأ بوقت البناء UTC (YYYYMMDDTHHMMSSZ) فالمقارنة النصية ترتيبٌ زمني: «أحدث» وحده يطلق التحديث — نسخة حافة CDN قديمة
 * لا تُرجع تطبيقاً أحدث إلى الوراء ولا تدور في حلقة إعادة تحميل.
 */

/** أقصى تكرار للفحص — مثل إعادة جلب إعدادات الشركة (القاعدة عنق ضيّق، والملف ثابت صغير) */
export const APP_UPDATE_CHECK_GAP_MS = 5 * 60 * 1000;

/** معرّف حزمة صالح (مرآة CLIENT_BUNDLE_RE في الخادم) */
const BUNDLE_RE = /^[A-Za-z0-9._:+-]{1,40}$/;

/** هل المعرّف البعيد أحدث من الجاري؟ خارج البناء ('dev') لا تحديث أبداً */
export function isNewerBuild(current: string, remote: unknown): remote is string {
  if (!current || current === 'dev') return false;
  if (typeof remote !== 'string' || !BUNDLE_RE.test(remote)) return false;
  return remote > current;
}

/** يجلب معرّف أحدث حزمة منشورة — بلا كاش (معامل وقت + no-store)؛ أي فشل ⇒ null صامت */
export async function fetchLatestBuildId(fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<string | null> {
  try {
    const res = await fetchImpl(`/build.json?t=${now}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { buildId?: unknown } | null;
    return typeof body?.buildId === 'string' ? body.buildId : null;
  } catch {
    return null;
  }
}

/** مفتاح الجلسة: الحزمة التي أُعيد التحميل من أجلها — فلا تتكرّر إعادة التحميل إن قُدّمت الصفحة القديمة نفسها (حلقة) */
export const APP_UPDATE_TRIED_KEY = 'rep_update_tried';

/** يُعاد التحميل تلقائياً مرة واحدة لكل حزمة، وحين يكون المندوب خاملاً وحده (لا نموذج ولا مستند مفتوح) */
export function shouldAutoReload(remote: string, idle: boolean, triedFor: string | null): boolean {
  return idle && triedFor !== remote;
}
