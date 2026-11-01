/**
 * موزّع الطباعة المباشرة — تستورده كل واجهةٍ بدل btSerial.ts: الطريق بحسب الجهاز (platform.ts) ثم النقل.
 *
 *   'serial' ⇒ Web Serial كما اليوم حرفاً بحرف (btSerial.ts لم يتغيّر)
 *   'app'    ⇒ أندرويد بلا Web Serial: تطبيق فيلد سيلز (appBridge.ts) — «الطابعة» هنا وقت اللمسة لا منفذ
 *   'none'   ⇒ iOS وسطح المكتب بلا Web Serial: كاليوم (unsupported)
 */
import { DirectPrintError } from '../printErrors';
import * as btSerial from './btSerial';
import type { SerialPortLike } from './btSerial';
import { appPrinterLink, openAppPicker, readBridgeFlag, type AppPrinterLink } from './appBridge';
import { classifyPrintPlatform, type DirectPath, type PlatformInput } from './platform';

export type DirectLink = SerialPortLike | AppPrinterLink;
/** تسليمٌ متأخّر إلى التطبيق بعد دعوة التحديث (appBridge.ts) — تشترك فيه الواجهة ما دامت الدعوة معروضة */
export { onLateHandoff } from './appBridge';

export function isAppLink(l: DirectLink | null | undefined): l is AppPrinterLink {
  return (l as AppPrinterLink | null | undefined)?.via === 'fs-app';
}

/** مدخلات التصنيف من الصفحة — محروسةٌ لـNode (navigator موجود فيه بوكيل «Node.js/24»، وdocument غائب) */
export function currentPlatformInput(): PlatformInput {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userAgentData?: { platform?: string } });
  let referrer = '';
  try { referrer = typeof document === 'undefined' ? '' : document.referrer || ''; } catch { /* */ }
  return {
    ua: typeof nav?.userAgent === 'string' ? nav.userAgent : '',
    uaDataPlatform: nav?.userAgentData?.platform ?? null,
    maxTouchPoints: typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0,
    hasSerial: btSerial.serialApi() !== null,
    referrer,
    bridgeFlag: readBridgeFlag() !== null,
  };
}

export function directPath(input: PlatformInput = currentPlatformInput()): DirectPath {
  return classifyPrintPlatform(input).path;
}

/** جوال أندرويد؟ — لتلميح الخيار المعطّل: لا سبب تقنياً للمندوب على أندرويد */
export function directOnAndroid(input: PlatformInput = currentPlatformInput()): boolean {
  return classifyPrintPlatform(input).os === 'android';
}

/** طباعةٌ مباشرة ممكنة على هذا الجهاز: Web Serial، أو أندرويد (تطبيق فيلد سيلز) */
export const directPrintAvailable = (): boolean => directPath() !== 'none';

/** الطابعة المربوطة بـWeb Serial — ومسار التطبيق لا يعرف طابعته في الصفحة (null) */
export async function linkedPrinter(): Promise<SerialPortLike | null> {
  return directPath() === 'serial' ? btSerial.linkedPrinter() : null;
}

/** «ربط الطابعة»: نافذة Chrome (serial) أو شاشة الاختيار في التطبيق (app) */
export async function linkPrinter(): Promise<'linked' | 'handed'> {
  const path = directPath();
  if (path === 'serial') { await btSerial.linkPrinter(); return 'linked'; }
  if (path === 'app') return openAppPicker();
  throw new DirectPrintError('unsupported');
}

/** طابعة هذه الضغطة — أوّل الضغطة (الإيماءة صالحة): المنفذ المربوط أو الربط الآن، أو وقت اللمسة لمسار التطبيق */
export async function printerForJob(): Promise<DirectLink> {
  const path = directPath();
  if (path === 'serial') return btSerial.printerForJob();
  if (path === 'app') return appPrinterLink(Date.now());
  throw new DirectPrintError('unsupported');
}
