/**
 * طريق الطباعة المباشرة لهذا الجهاز — يختار النقل وحده ولا يُخرج نصّاً للمندوب أبداً (لا اسم متصفح ولا إصدار).
 *
 *   Web Serial موجود            ⇒ 'serial' (مسار اليوم كما هو)
 *   أندرويد بلا Web Serial      ⇒ 'app'   (تطبيق فيلد سيلز بالبلوتوث — WebView وFirefox وSamsung Internet وChrome القديم سواء)
 *                                 (APP_BRIDGE_FOR_ALL مفعّل منذ نشر 1.2.0 في الإنتاج؛ لو أُطفئ: علامة الجسر وحدها، وإلا 'none')
 *   غير ذلك (iOS، سطح المكتب)   ⇒ 'none'  (كاليوم: الخيار معطّل ونظام الطباعة)
 *
 * أندرويد يُعرف من الوكيل أو من userAgentData أو من وضع سطح المكتب في Samsung Internet، أو من مُحيل التطبيق
 * (android-app://) أو من علامة الجسر التي وضعها التطبيق نفسه. نقيٌّ: المدخلات تُجمع في direct.ts.
 */

export type DirectPath = 'serial' | 'app' | 'none';

/**
 * التطبيق لكل جوالات أندرويد — يُقلب true حين يصل تحديث التطبيق ذو الجسر (versionCode 6 فأحدث) إلى الإنتاج في Google Play.
 * قبلها لا يُجرَّب التطبيق إلا حيث أعلن نفسه بعلامة الجسر (fsbridge، المسار الداخلي للاختبار)، فلا يُدعى مندوبُ النسخة 3
 * إلى تحديثٍ لم يُنشر بعد. مُحيل التطبيق (android-app://) لا يكفي هنا: النسخة 3 تضعه أيضاً بلا جسر.
 * قُلب true في ١ نوفمبر ٢٠٢٦ بعد أن صار الإصدار 6 (1.2.0) «متوفراً على Google Play» للجميع — مندوب النسخة 3 يُدعى إلى تحديثٍ موجود
 */
export const APP_BRIDGE_FOR_ALL = true;

export interface PlatformInput {
  ua: string;
  uaDataPlatform?: string | null;
  maxTouchPoints?: number;
  hasSerial: boolean;
  referrer?: string;
  bridgeFlag?: boolean;
  /** للاختبار — غيابه = APP_BRIDGE_FOR_ALL */
  bridgeForAll?: boolean;
}

export interface PrintPlatform { os: 'android' | 'ios' | 'other'; path: DirectPath }

export function classifyPrintPlatform(i: PlatformInput): PrintPlatform {
  const ua = i.ua ?? '';
  const os: PrintPlatform['os'] = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (i.maxTouchPoints ?? 0) > 1) ? 'ios'
    : i.uaDataPlatform === 'Android' || /Android/i.test(ua) || /SamsungBrowser\//.test(ua)
      || (i.referrer ?? '').startsWith('android-app://') || i.bridgeFlag === true ? 'android'
    : 'other';
  const appOpen = (i.bridgeForAll ?? APP_BRIDGE_FOR_ALL) || i.bridgeFlag === true;
  const path: DirectPath = i.hasSerial ? 'serial' : os === 'android' && appOpen ? 'app' : 'none';
  return { os, path };
}
