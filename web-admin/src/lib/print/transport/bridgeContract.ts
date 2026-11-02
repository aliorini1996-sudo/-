/**
 * عقد جسر الطباعة مع تطبيق فيلد سيلز على أندرويد — كل قيمةٍ هنا نظيرُها حرفياً في
 * android-rep/app/src/main/java/net/fieldsa/twa/print/BridgeContract.kt، ويحرس تطابقهما bridgeContract.test.ts.
 *
 * الصفحة تبني رابط intent (fieldsaprint://print) بحمولةٍ مضغوطة (bridgePayload.ts) فيطبعها التطبيق بالبلوتوث الكلاسيكي —
 * حين لا يحمل المتصفح Web Serial. تغيير قيمةٍ هنا دون الأخرى يكسر الطباعة بصمت، فلا يُغيَّر إلا الطرفان معاً.
 */

/** مخطّط الرابط ومضيفاه: طباعة مهمة، واختيار الطابعة */
export const BRIDGE_SCHEME = 'fieldsaprint';
export const BRIDGE_HOST_PRINT = 'print';
export const BRIDGE_HOST_PRINTER = 'printer';
/** معاملا الاستعلام: الحمولة ومفتاح الثقة */
export const BRIDGE_PARAM_PAYLOAD = 'p';
export const BRIDGE_PARAM_KEY = 'k';
/** معامل يضيفه LauncherActivity لرابط الإقلاع: «<إصدار البروتوكول>.<المفتاح>» — تقرؤه الصفحة وتحذفه فوراً */
export const BRIDGE_LAUNCH_PARAM = 'fsbridge';
/** 2 منذ 1.2.1: شاشة الاختيار تُظهر الطابعات المقترنة — ومنه يُقدَّم التطبيق على Web Serial (platform.ts APP_FIRST_BRIDGE_VERSION) */
export const BRIDGE_PROTOCOL_VERSION = 2;
export const BRIDGE_PACKAGE = 'net.fieldsa.twa';

/** صيغة الحمولة v1: رأس 14 بايتاً ثم الجسم (خام أو deflate) */
export const PAYLOAD_FORMAT_VERSION = 1;
export const PAYLOAD_HEADER_BYTES = 14;
/** حدود الحمولة — سقف المحارف من حدّ Binder (1 م.ب مشتركة، UTF-16) */
export const MAX_PAYLOAD_CHARS = 196_608;
export const MAX_INNER_BYTES = 5_242_880;
export const MAX_JOB_BYTES = 4_194_304;
export const MAX_MARKS = 65_535;
export const MAX_LABEL_BYTES = 160;
export const MAX_CANCEL_BYTES = 16;
/** مفتاح الثقة: 16 بايتاً عشوائية بـbase64url بلا حشو = 22 محرفاً */
export const BRIDGE_KEY_LENGTH = 22;
export const BRIDGE_KEY_RE = /^[A-Za-z0-9_-]{22}$/;

/** سقف رابط intent كاملاً (الويب وحده) */
export const MAX_INTENT_URL_CHARS = 200_000;
/** صفحة التطبيق في Google Play — زرّ «تحديث التطبيق» */
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=net.fieldsa.twa';

/** مهلة انتقال الصفحة إلى التطبيق قبل الحكم بالتعذّر، ونافذة الانتقال المتأخّر بعدها */
export const HANDOFF_TIMEOUT_MS = 3000;
export const LATE_HANDOFF_MS = 12000;
/** Chrome لا يفتح intent إلا بإيماءةٍ حديثة — بعد هذه المدة من اللمسة تُطلب لمسةٌ ثانية (كالتحصيل بالبطاقة) */
export const LAUNCH_GESTURE_MS = 3000;

// ─── تطبيق فيلد سيلز على الآيفون (1.1.0) ───
// نظير كل قيمةٍ أدناه في تطبيق الآيفون: FieldSales/PrintPayload.swift (`enum FSP`، فرع ios-app). الجسر هناك معالجُ رسائل
// بردّ (WKScriptMessageHandlerWithReply) لا رابط intent: الصفحة تنادي window.webkit.messageHandlers.fsPrint.postMessage فيعود
// وعدٌ بالنتيجة — بلا مفتاح ثقة ولا مهلة تسليم (WebKit يعرف إطار المُرسل وأصله). والحمولة هي نفسها FSP v1 أعلاه.

/** اسم معالج الرسائل، والعلامة العامة التي يضعها التطبيق قبل تحميل الصفحة ({v, caps})، وإصدار البروتوكول */
export const IOS_HANDLER = 'fsPrint';
export const IOS_MARKER = '__fsIosBridge';
export const IOS_BRIDGE_VERSION = 1;
/** حدث التقدّم الذي يطلقه التطبيق في الصفحة: detail = {job, sent, total} */
export const IOS_PROGRESS_EVENT = 'fs-ios-print';
/**
 * سقفا الآيفون: لا حدّ Binder في WKWebView، لكن BLE بطيء (3–20 ك.ب/ث) — فالمهمة 1 م.ب، والحمولة الخام تتسع لها مع الرأس
 * والعلامات. الآيفون يرسل خاماً دائماً (CompressionStream غائبٌ قبل iOS 16.4).
 */
export const IOS_MAX_PAYLOAD_CHARS = 1_572_864;
export const IOS_MAX_JOB_BYTES = 1_048_576;
/** معرّف المهمة في رسائل print/cancel والتقدّم */
export const IOS_JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** صفحة التطبيق في App Store — زرّ «تحديث التطبيق» على الآيفون */
export const APP_STORE_URL = 'https://apps.apple.com/app/id6797991968';
/** «نظام الطباعة» داخل تطبيق الآيفون عبر الجسر (AirPrint أصليّ) — false يعيده إلى print() في الإطار بلا تحديث للتطبيق */
export const IOS_SYSTEM_PRINT_VIA_APP = true;
