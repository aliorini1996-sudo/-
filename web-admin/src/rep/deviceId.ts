// جهاز البصمة (طلب المالك، ٢١ أكتوبر ٢٠٢٦): «تسجيل نوع الجهاز مع كل بصمة» و«ربط الموظف بجهاز واحد».
//
// تطبيق ويب لا يرى معرّف عتاد الجوال، فالمعرّف يُولَّد مرّةً ويُحفظ على الجهاز ويبقى بعد تسجيل الخروج (فالجهاز نفسه
// بحسابٍ آخر يُعرف). مسح بيانات التطبيق يولّد معرّفاً جديداً ⇒ مندوبٌ مربوط يطلب من الإدارة «فكّ الربط».
// ووصف الجهاز من تلميحات المتصفّح (طراز الجوال في كروم أندرويد) وإلّا من User-Agent — والخادم يكمله إن غاب.

const KEY = 'fs_device_id';
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function newId(): string {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch { /* سياقٌ غير آمن */ }
  const r = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  return `${r()}-${r()}-${r()}-${r()}`;
}

/** معرّف هذا الجهاز للبصمة — ثابتٌ ما بقيت بيانات التطبيق */
export function getDeviceId(store: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): string {
  try {
    const saved = store?.getItem(KEY);
    if (saved && ID_RE.test(saved)) return saved;
    const id = newId();
    store?.setItem(KEY, id);
    return id;
  } catch {
    return newId();
  }
}

type UAData = { getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string; platform?: string; platformVersion?: string; mobile?: boolean }> };

/** «SM-S918B · Android 14» من تلميحات المتصفّح، وإلّا وصفٌ من User-Agent — نصٌّ للإدارة لا هويةٌ يُثق بها */
export function describeFromUA(ua: string, touchMac = false): string {
  const android = /Android\s+([\d.]+)/i.exec(ua);
  const ios = /(?:iPhone|iPad|iPod).*?OS\s+([\d_]+)/i.exec(ua);
  if (android) return `Android ${android[1].split('.')[0]}`;
  if (ios) return `${/iPad/i.test(ua) ? 'iPad' : 'iPhone'} · iOS ${ios[1].replace(/_/g, '.').split('.').slice(0, 2).join('.')}`;
  if (/Windows/i.test(ua)) return 'Windows · كمبيوتر';
  // سفاري iPadOS 13+ يرسل User-Agent ماك: لمسٌ متعدّد على «ماك» ⇒ iPad
  if (/Macintosh|Mac OS X/i.test(ua)) return touchMac ? 'iPad · iPadOS' : 'macOS · كمبيوتر';
  return 'جهاز غير معروف';
}

let cached: string | null = null;
export async function describeDevice(): Promise<string> {
  if (cached) return cached;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  let name = describeFromUA(ua, typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
  try {
    const data = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
    const hi = await data?.getHighEntropyValues?.(['model', 'platform', 'platformVersion']);
    if (hi?.platform) {
      const ver = hi.platformVersion ? ` ${hi.platformVersion.split('.')[0]}` : '';
      name = [hi.model?.trim() || '', `${hi.platform}${ver}`, hi.mobile === false || /Windows|macOS|Linux|Chrome OS/i.test(hi.platform) && !hi.model ? 'كمبيوتر' : '']
        .filter(Boolean).join(' · ');
    }
  } catch { /* متصفّحٌ بلا تلميحات: وصف User-Agent */ }
  return (cached = name.slice(0, 120));
}
