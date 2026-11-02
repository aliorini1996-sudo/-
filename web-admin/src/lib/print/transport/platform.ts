/**
 * طريق الطباعة المباشرة لهذا الجهاز — يختار النقل وحده ولا يُخرج نصّاً للمندوب أبداً (لا اسم متصفح ولا إصدار).
 *
 *   داخل تطبيق فيلد سيلز 1.2.1+  ⇒ 'app'   (علامة الجسر بإصدار ≥ APP_FIRST_BRIDGE_VERSION: شاشة الطابعة في التطبيق ولو وُجد Web Serial)
 *   Web Serial موجود            ⇒ 'serial' (Chrome خارج التطبيق وسطح المكتب كما اليوم)
 *   أندرويد بلا Web Serial      ⇒ 'app'   (تطبيق فيلد سيلز بالبلوتوث — WebView وFirefox وSamsung Internet وChrome القديم سواء)
 *                                 (APP_BRIDGE_FOR_ALL مفعّل منذ نشر 1.2.0 في الإنتاج؛ لو أُطفئ: علامة الجسر وحدها، وإلا 'none')
 *   iOS بجسر تطبيق الآيفون      ⇒ 'ios-app' (فيلد سيلز 1.1.0 فأحدث: معالج fsPrint وعلامة __fsIosBridge بإصدارٍ ≥ IOS_BRIDGE_VERSION —
 *                                 iosBridge.ts). كشفٌ بالميزة لا ببوّابة: لا يوجد الجسر إلا في التطبيق الجديد
 *   غير ذلك (سفاري ومتصفحات iOS، تطبيق الآيفون 1.0، سطح المكتب) ⇒ 'none' (كاليوم: الخيار معطّل ونظام الطباعة)
 *
 * أندرويد يُعرف من الوكيل أو من userAgentData أو من وضع سطح المكتب في Samsung Internet، أو من مُحيل التطبيق
 * (android-app://) أو من علامة الجسر التي وضعها التطبيق نفسه. نقيٌّ: المدخلات تُجمع في direct.ts.
 *
 * وتلميح الخيار المعطّل (directHint) بلا سببٍ تقنيّ على الجوال: «تصل مع التحديث القادم» حتى يُنشر التحديث، ثم دعوة التحديث
 * أو التطبيق. نصّ المتصفح القديم لسطح المكتب وحده.
 */
import { IOS_BRIDGE_VERSION } from './bridgeContract';

export type DirectPath = 'serial' | 'app' | 'ios-app' | 'none';

/**
 * التطبيق لكل جوالات أندرويد — يُقلب true حين يصل تحديث التطبيق ذو الجسر (versionCode 6 فأحدث) إلى الإنتاج في Google Play.
 * قبلها لا يُجرَّب التطبيق إلا حيث أعلن نفسه بعلامة الجسر (fsbridge، المسار الداخلي للاختبار)، فلا يُدعى مندوبُ النسخة 3
 * إلى تحديثٍ لم يُنشر بعد. مُحيل التطبيق (android-app://) لا يكفي هنا: النسخة 3 تضعه أيضاً بلا جسر.
 * قُلب true في ١ نوفمبر ٢٠٢٦ بعد أن صار الإصدار 6 (1.2.0) «متوفراً على Google Play» للجميع — مندوب النسخة 3 يُدعى إلى تحديثٍ موجود
 */
export const APP_BRIDGE_FOR_ALL = true;

/**
 * نُشر تطبيق الآيفون 1.1.0 (ذو الجسر) في App Store — يُقلب true بعد أن يضغط المالك «Release». لا يغيّر الطريق أبداً (الجسر
 * يُكشف بالميزة)، بل التلميح وحده: قبله «تصل مع التحديث القادم»، وبعده دعوة التحديث (1.0) أو التطبيق (سفاري).
 */
export const IOS_BRIDGE_RELEASED = false;

/**
 * إصدار الجسر الذي يُقدَّم فيه التطبيق على Web Serial داخل التطبيق. شاشة الاختيار في 1.2.0 (الجسر 1) تُنشئ أزرار الطابعات مخفيّة
 * فلا يرى المندوب طابعته المقترنة (بلاغ المالك ٢ نوفمبر ٢٠٢٦)، فيبقى مندوبها على نافذة Chrome حيث وُجد Web Serial. أُصلحت في
 * 1.2.1 (الجسر 2)، ومنه تُقدَّم شاشة التطبيق: نافذة Chrome لا تعرض إلا مقترناً يعلن SPP وبإذن «الأجهزة القريبة» لـChrome نفسه
 */
export const APP_FIRST_BRIDGE_VERSION = 2;

/**
 * النقطية (MIP480) على الآيفون: بلوتوثها كلاسيكيٌّ بلا BLE فلا يصلها تطبيق آيفون — الخيار معطّل بتلميحٍ بسيط. يُقلب true
 * إن جُرّب محوّل RS-232↔BLE على الطابعة.
 */
export const IOS_IMPACT_DIRECT = false;

export interface PlatformInput {
  ua: string;
  uaDataPlatform?: string | null;
  maxTouchPoints?: number;
  hasSerial: boolean;
  referrer?: string;
  bridgeFlag?: boolean;
  /** إصدار علامة الجسر (fsbridge=<الإصدار>.<المفتاح>) — null بلا علامة */
  bridgeVersion?: number | null;
  /** للاختبار — غيابه = APP_BRIDGE_FOR_ALL */
  bridgeForAll?: boolean;
  /** إصدار جسر تطبيق الآيفون (window.__fsIosBridge.v) — يُقرأ فقط إن وُجد معالج fsPrint، وإلا null */
  iosBridge?: number | null;
  /** تطبيق فيلد سيلز على الآيفون بأيّ إصدار (وكيلٌ ينتهي بـ« FieldSales» أو كعكة app-platform) — لتلميح التحديث وحده */
  iosWrapper?: boolean;
  /** للاختبار — غيابه = IOS_BRIDGE_RELEASED */
  iosReleased?: boolean;
}

export interface PrintPlatform { os: 'android' | 'ios' | 'other'; path: DirectPath }

export function classifyPrintPlatform(i: PlatformInput): PrintPlatform {
  const ua = i.ua ?? '';
  const os: PrintPlatform['os'] = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (i.maxTouchPoints ?? 0) > 1) ? 'ios'
    : i.uaDataPlatform === 'Android' || /Android/i.test(ua) || /SamsungBrowser\//.test(ua)
      || (i.referrer ?? '').startsWith('android-app://') || i.bridgeFlag === true ? 'android'
    : 'other';
  const appOpen = (i.bridgeForAll ?? APP_BRIDGE_FOR_ALL) || i.bridgeFlag === true;
  const iosOpen = os === 'ios' && typeof i.iosBridge === 'number' && i.iosBridge >= IOS_BRIDGE_VERSION;
  // داخل تطبيق فيلد سيلز 1.2.1+ يُقدَّم التطبيق على Web Serial (APP_FIRST_BRIDGE_VERSION): نافذة Chrome تبدو فارغة للمندوب
  // («No compatible devices found»)، وشاشة التطبيق تطلب الإذن وتشغّل البلوتوث وتعرض كل المقترن وتفتح إعداداته للاقتران
  const appFirst = os === 'android' && (i.bridgeVersion ?? 0) >= APP_FIRST_BRIDGE_VERSION;
  const path: DirectPath = appFirst ? 'app'
    : i.hasSerial ? 'serial' : os === 'android' && appOpen ? 'app' : iosOpen ? 'ios-app' : 'none';
  return { os, path };
}

/**
 * تلميح «بلوتوث مباشر» في أدوات الطباعة:
 *   ready     طريقٌ موجود
 *   soon      أندرويد بلا طريق، أو الآيفون قبل نشر 1.1.0 — «تصل مع التحديث القادم لتطبيق فيلد سيلز»
 *   updateIos الآيفون بعد النشر في تطبيق 1.0 — «حدّث من App Store» وزرّ التحديث
 *   iosApp    الآيفون بعد النشر في سفاري أو متصفحٍ آخر — «متاحة في تطبيق فيلد سيلز على الآيفون»
 *   browser   سطح المكتب بلا Web Serial — نصّ المتصفح القديم (لا يُعرض على جوالٍ أبداً)
 */
export type DirectHint = 'ready' | 'soon' | 'updateIos' | 'iosApp' | 'browser';

export function directHint(i: PlatformInput, iosReleased: boolean = i.iosReleased ?? IOS_BRIDGE_RELEASED): DirectHint {
  const { os, path } = classifyPrintPlatform(i);
  if (path !== 'none') return 'ready';
  if (os === 'android') return 'soon';
  if (os === 'ios') return !iosReleased ? 'soon' : i.iosWrapper === true ? 'updateIos' : 'iosApp';
  return 'browser';
}
