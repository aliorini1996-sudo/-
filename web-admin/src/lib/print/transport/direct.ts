/**
 * موزّع الطباعة المباشرة — تستورده كل واجهةٍ بدل btSerial.ts: الطريق بحسب الجهاز (platform.ts) ثم النقل.
 *
 *   'serial' ⇒ Web Serial كما اليوم حرفاً بحرف (btSerial.ts لم يتغيّر)
 *   'app'     ⇒ أندرويد بلا Web Serial: تطبيق فيلد سيلز (appBridge.ts) — «الطابعة» هنا وقت اللمسة لا منفذ
 *   'ios-app' ⇒ تطبيق فيلد سيلز على الآيفون بجسره (iosBridge.ts) — الطابعة محفوظةٌ في التطبيق، والصفحة تعرف اسمها
 *   'none'    ⇒ سفاري وتطبيق الآيفون 1.0 وسطح المكتب بلا Web Serial: كاليوم (unsupported)
 */
import { DirectPrintError } from '../printErrors';
import * as btSerial from './btSerial';
import type { SerialPortLike } from './btSerial';
import { appPrinterLink, openAppPicker, readBridgeFlag, type AppPrinterLink } from './appBridge';
import { iosLinkedPrinter, iosPick, iosPrinterForJob, isIosWrapper, readIosBridgeVersion, type IosPrinterLink } from './iosBridge';
import { classifyPrintPlatform, type DirectPath, type PlatformInput } from './platform';

export type DirectLink = SerialPortLike | AppPrinterLink | IosPrinterLink;
/** تسليمٌ متأخّر إلى التطبيق بعد دعوة التحديث (appBridge.ts) — تشترك فيه الواجهة ما دامت الدعوة معروضة */
export { onLateHandoff } from './appBridge';

export function isAppLink(l: DirectLink | null | undefined): l is AppPrinterLink {
  return (l as AppPrinterLink | null | undefined)?.via === 'fs-app';
}

export function isIosLink(l: DirectLink | null | undefined): l is IosPrinterLink {
  return (l as IosPrinterLink | null | undefined)?.via === 'fs-ios';
}

/** مدخلات التصنيف من الصفحة — محروسةٌ لـNode (navigator موجود فيه بوكيل «Node.js/24»، وdocument غائب) */
export function currentPlatformInput(): PlatformInput {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userAgentData?: { platform?: string } });
  let referrer = '';
  try { referrer = typeof document === 'undefined' ? '' : document.referrer || ''; } catch { /* */ }
  let cookie = '';
  try { cookie = typeof document === 'undefined' ? '' : String(document.cookie ?? ''); } catch { /* كعكاتٌ محجوبة */ }
  const ua = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
  return {
    ua,
    uaDataPlatform: nav?.userAgentData?.platform ?? null,
    maxTouchPoints: typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0,
    hasSerial: btSerial.serialApi() !== null,
    referrer,
    bridgeFlag: readBridgeFlag() !== null,
    iosBridge: readIosBridgeVersion(),
    iosWrapper: isIosWrapper(ua, cookie),
  };
}

export function directPath(input: PlatformInput = currentPlatformInput()): DirectPath {
  return classifyPrintPlatform(input).path;
}

/** جوال أندرويد؟ — لتلميح الخيار المعطّل: لا سبب تقنياً للمندوب على أندرويد */
export function directOnAndroid(input: PlatformInput = currentPlatformInput()): boolean {
  return classifyPrintPlatform(input).os === 'android';
}

/** تطبيق فيلد سيلز على الآيفون بجسره؟ — سطر «لا تقفل الشاشة» أثناء الإرسال (BLE يتوقّف إن قُفلت) */
export function directOnIos(input: PlatformInput = currentPlatformInput()): boolean {
  return classifyPrintPlatform(input).path === 'ios-app';
}

/** طباعةٌ مباشرة ممكنة على هذا الجهاز: Web Serial، أو أندرويد (تطبيق فيلد سيلز)، أو تطبيق الآيفون بجسره */
export const directPrintAvailable = (): boolean => directPath() !== 'none';

/** الطابعة المربوطة: منفذ Web Serial، أو المحفوظة في تطبيق الآيفون (باسمها) — ومسار أندرويد لا يعرف طابعته في الصفحة (null) */
export async function linkedPrinter(): Promise<SerialPortLike | IosPrinterLink | null> {
  const path = directPath();
  if (path === 'serial') return btSerial.linkedPrinter();
  if (path === 'ios-app') return iosLinkedPrinter();
  return null;
}

/** «ربط الطابعة»: نافذة Chrome (serial) أو شاشة الاختيار في التطبيق (app على أندرويد، ios-app على الآيفون) */
export async function linkPrinter(): Promise<'linked' | 'handed'> {
  const path = directPath();
  if (path === 'serial') { await btSerial.linkPrinter(); return 'linked'; }
  if (path === 'app') return openAppPicker();
  if (path === 'ios-app') { await iosPick(); return 'linked'; }
  throw new DirectPrintError('unsupported');
}

/**
 * طابعة هذه الضغطة — أوّل الضغطة (الإيماءة صالحة): المنفذ المربوط أو الربط الآن، أو وقت اللمسة لمسار أندرويد، أو المحفوظة في
 * تطبيق الآيفون (وإلا شاشة الاختيار فيه)
 */
export async function printerForJob(): Promise<DirectLink> {
  const path = directPath();
  if (path === 'serial') return btSerial.printerForJob();
  if (path === 'app') return appPrinterLink(Date.now());
  if (path === 'ios-app') return iosPrinterForJob();
  throw new DirectPrintError('unsupported');
}
