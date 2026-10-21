// ============================================================================
// جهاز البصمة (طلب المالك، ٢١ أكتوبر ٢٠٢٦): «تسجيل نوع الجهاز مع كل بصمة» و«ربط الموظف بجهاز واحد».
//
// تطبيق المندوب تطبيق ويب (PWA/TWA) لا يرى معرّف عتاد الجوال، فالمعرّف يولّده التطبيق مرّة ويحفظه على الجهاز
// (web-admin/src/rep/deviceId.ts) — يكشف الحالة الشائعة: زميلٌ يدخل بحساب صاحبه من جواله. ووصف الجهاز يرسله التطبيق
// من تلميحات المتصفّح (طراز الجوال ونظامه)، وإن غاب يُستنتج هنا من User-Agent.
// ============================================================================

/** معرّف التطبيق على الجهاز: UUID أو ما يشبهه — حروف لاتينية وأرقام وشرطات، ٨ إلى ٦٤ */
export const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** أقصى طول لوصف الجهاز المخزَّن */
export const DEVICE_NAME_MAX = 120;

export const deviceIdOf = (v: unknown): string | null => (typeof v === 'string' && DEVICE_ID_RE.test(v) ? v : null);

/** وصفٌ أرسله التطبيق: يُنظَّف من محارف التحكّم ويُقصّ — نصٌّ يُعرض للإدارة لا يُثق بمحتواه */
export function cleanDeviceName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, DEVICE_NAME_MAX) : null;
}

/**
 * وصفٌ مختصر من User-Agent: «Android 14 · Chrome»، «iPhone · iOS 17.4 · Safari»، «Windows · Chrome · كمبيوتر».
 * يكفي لتمييز جوالٍ من كمبيوتر ونظامٍ من نظام — والطراز الدقيق يأتي من التطبيق (تلميحات المتصفّح) لا من هنا،
 * فكروم يُخفي الطراز في User-Agent.
 */
export function describeUserAgent(ua: unknown): string {
  const s = typeof ua === 'string' ? ua : '';
  if (!s) return 'جهاز غير معروف';
  let os = '';
  let desktop = false;
  const android = /Android\s+([\d.]+)/i.exec(s);
  const ios = /(?:iPhone|iPad|iPod).*?OS\s+([\d_]+)/i.exec(s);
  if (android) os = `Android ${android[1].split('.')[0]}`;
  else if (ios) os = `${/iPad/i.test(s) ? 'iPad' : 'iPhone'} · iOS ${ios[1].replace(/_/g, '.').split('.').slice(0, 2).join('.')}`;
  else if (/Windows/i.test(s)) { os = 'Windows'; desktop = true; }
  else if (/Macintosh|Mac OS X/i.test(s)) { os = 'macOS'; desktop = true; }
  else if (/CrOS/i.test(s)) { os = 'ChromeOS'; desktop = true; }
  else if (/Linux/i.test(s)) { os = 'Linux'; desktop = true; }
  const browser = /SamsungBrowser/i.test(s) ? 'Samsung Internet'
    : /EdgA?\//i.test(s) ? 'Edge'
      : /Firefox|FxiOS/i.test(s) ? 'Firefox'
        : /CriOS|Chrome\//i.test(s) ? 'Chrome'
          : /Safari/i.test(s) ? 'Safari' : '';
  return [os || 'جهاز غير معروف', browser, desktop ? 'كمبيوتر' : ''].filter(Boolean).join(' · ').slice(0, DEVICE_NAME_MAX);
}

/** جهاز البصمة: معرّفه من التطبيق (أو null من حزمة أقدم)، ووصفه من التطبيق وإلّا من User-Agent */
export function punchDeviceOf(body: { deviceId?: unknown; deviceName?: unknown }, userAgent: unknown): { id: string | null; name: string } {
  return { id: deviceIdOf(body.deviceId), name: cleanDeviceName(body.deviceName) ?? describeUserAgent(userAgent) };
}
