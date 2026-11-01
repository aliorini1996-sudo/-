/**
 * جسر الطباعة إلى تطبيق فيلد سيلز على الآيفون (1.1.0 فأحدث) — المسار 'ios-app' في platform.ts.
 *
 * الآيفون لا يحمل Web Serial ولا Web Bluetooth، والطابعة المحمولة هناك BLE تصلها CoreBluetooth في التطبيق وحده. فالصفحة
 * (داخل WKWebView التطبيق) تنادي معالج الرسائل fsPrint فيعود وعدٌ بالنتيجة:
 *
 *   {op:'hello', v}            ⇒ {v, auth, printer:{name}|null, busy, caps}   (بلا طلب إذن البلوتوث)
 *   {op:'pick'}                ⇒ {ok:true, printer:{name}} | {ok:false, code}  (شاشة اختيار الطابعة في التطبيق)
 *   {op:'print', job, payload} ⇒ {ok:true, outcome:'done'|'cancelled'} | {ok:false, code}
 *   {op:'cancel', job}         ⇒ {ok:true}
 *   {op:'systemPrint', html, widthMm, name} ⇒ {ok:true, outcome} | {ok:false, code}   («نظام الطباعة»: AirPrint أصليّ)
 *
 * والتقدّم حدثٌ في الصفحة (fs-ios-print، detail = {job, sent, total}). الحمولة FSP v1 نفسها التي يحملها رابط أندرويد
 * (bridgePayload.ts) خاماً دائماً، بسقف الآيفون. لا مفتاح ثقة ولا مهلة تسليم ولا لمسة ثانية: النداء داخل التطبيق، وWebKit يخبره
 * بإطار المُرسل وأصله. ولا مهلة من الصفحة: مراقبة التطبيق تضمن الردّ، ومهمة BLE طويلة قد تأخذ دقيقة.
 *
 * رموز التطبيق تصير أصناف DirectPrintFailure (failureForCode) برسائل بلا سببٍ تقنيّ — و«اقرن من الإعدادات» و«Chrome 138» لا
 * يخرجان من هنا أبداً. نقيٌّ قابلٌ للحقن (IosEnv) كـAppEnv في appBridge.ts — لا وصول للصفحة عند التحميل.
 */
import { DirectPrintError, type DirectPrintFailure } from '../printErrors';
import type { DirectOutcome, DirectUi } from '../../../rep/printDirect';
import {
  IOS_BRIDGE_VERSION, IOS_HANDLER, IOS_JOB_ID_RE, IOS_MARKER, IOS_MAX_JOB_BYTES, IOS_MAX_PAYLOAD_CHARS, IOS_PROGRESS_EVENT,
  IOS_SYSTEM_PRINT_VIA_APP,
} from './bridgeContract';
import { BridgePayloadError, encodeBridgePayload, toBase64Url, type BridgeJob } from './bridgePayload';

/** «طابعة» مسار الآيفون: محفوظةٌ في التطبيق — الصفحة تعرف اسمها فقط */
export interface IosPrinterLink { readonly via: 'fs-ios'; readonly name: string | null }
export interface IosHello { v: number; auth: string; printer: { name: string } | null; busy: boolean; caps: string[] }
export interface IosProgress { job: string; sent: number; total: number }
export interface IosEnv {
  post(msg: Record<string, unknown>): Promise<unknown>;
  /** يشترك في أحداث التقدّم ويعيد إلغاء الاشتراك */
  onProgress(f: (d: IosProgress) => void): () => void;
  jobId(): string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function pageWindow(): unknown {
  return typeof window === 'undefined' ? undefined : window;
}

/** معالج fsPrint إن وُجد بدالة postMessage — معالجات تطبيقاتٍ أخرى (messageHandlers عامّة) لا تكفي */
function handlerOf(w: unknown): { postMessage(msg: unknown): unknown } | null {
  try {
    const hs = (w as { webkit?: { messageHandlers?: Obj } } | undefined)?.webkit?.messageHandlers;
    const h = hs ? hs[IOS_HANDLER] : undefined;
    return isObj(h) && typeof h.postMessage === 'function' ? (h as unknown as { postMessage(msg: unknown): unknown }) : null;
  } catch { return null; }
}

/** علامة التطبيق {v, caps} — v عددٌ صحيح ≥ 1 وإلا لا علامة */
function markerOf(w: unknown): { v: number; caps: string[] } | null {
  try {
    const m = isObj(w) ? w[IOS_MARKER] : undefined;
    if (!isObj(m)) return null;
    const v = m.v;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return null;
    const caps = Array.isArray(m.caps) ? m.caps.filter((c): c is string => typeof c === 'string') : [];
    return { v, caps };
  } catch { return null; }
}

/** إصدار الجسر: المعالج موجود والعلامة صالحة — وإلا null (سفاري، تطبيق 1.0، متصفحات أخرى) */
export function readIosBridgeVersion(w: unknown = pageWindow()): number | null {
  if (!handlerOf(w)) return null;
  return markerOf(w)?.v ?? null;
}

/** تطبيق فيلد سيلز على الآيفون بأيّ إصدار: وكيلٌ ينتهي بـ« FieldSales» أو كعكة app-platform التي يضعها التطبيق */
export function isIosWrapper(ua: string, cookie: string): boolean {
  return /\sFieldSales$/.test(ua ?? '') || /(?:^|;\s*)app-platform=iOS(?: |%20)App(?: |%20)Store(?:;|$)/.test(cookie ?? '');
}

/** معرّف مهمة: 12 بايتاً عشوائية بـbase64url = 16 محرفاً */
function newJobId(): string {
  const b = new Uint8Array(12);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  return toBase64Url(b);
}

/** بيئة الصفحة الحقيقية — تُقرأ عند الاستدعاء لا عند التحميل */
export function browserIosEnv(): IosEnv {
  return {
    post: (msg) => {
      const h = handlerOf(pageWindow());
      if (!h) return Promise.reject(new Error('fsPrint handler'));
      try {
        // نداءٌ على المعالج نفسه (this) — WebKit يرفض postMessage المفصولة
        return Promise.resolve(h.postMessage(msg));
      } catch (e) { return Promise.reject(e); }
    },
    onProgress: (f) => {
      if (typeof window === 'undefined') return () => undefined;
      const listener = (e: Event) => {
        const d = (e as CustomEvent<unknown>).detail;
        if (isObj(d) && typeof d.job === 'string' && typeof d.sent === 'number' && typeof d.total === 'number') {
          f({ job: d.job, sent: d.sent, total: d.total });
        }
      };
      window.addEventListener(IOS_PROGRESS_EVENT, listener);
      return () => window.removeEventListener(IOS_PROGRESS_EVENT, listener);
    },
    jobId: newJobId,
  };
}

const CODE_KIND: Readonly<Record<string, DirectPrintFailure>> = Object.freeze({
  bt_off: 'btOff',
  bt_denied: 'btDenied',
  no_printer: 'pickPrinter',
  picker_cancelled: 'pickPrinter',
  not_found: 'busy',
  connect: 'busy',
  disconnected: 'disconnected',
  interrupted: 'interrupted',
  busy: 'printing',
  too_large: 'tooLarge',
});

/** رمز التطبيق ⇒ صنف التعذّر — bt_unsupported وbad_payload وما لا يُعرف ⇒ failed */
export function failureForCode(code: unknown): DirectPrintFailure {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE_KIND, code) ? CODE_KIND[code] : 'failed';
}

const linkOf = (name: unknown): IosPrinterLink => ({ via: 'fs-ios', name: typeof name === 'string' && name.trim() ? name : null });
const printerName = (p: unknown): string | null => (isObj(p) && typeof p.name === 'string' ? p.name : null);

/** المصافحة: ردٌّ ناقص أو إصدارٌ أقدم من الصفحة ⇒ appUpdateIos (دعوة التحديث من App Store)؛ ورفض الوعد ⇒ failed */
export async function iosHello(env: IosEnv = browserIosEnv()): Promise<IosHello> {
  let r: unknown;
  try {
    r = await env.post({ op: 'hello', v: IOS_BRIDGE_VERSION });
  } catch (e) {
    throw new DirectPrintError('failed', e);
  }
  if (!isObj(r)) throw new DirectPrintError('appUpdateIos');
  const { v, auth, printer, busy, caps } = r;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < IOS_BRIDGE_VERSION) throw new DirectPrintError('appUpdateIos');
  if (typeof busy !== 'boolean' || !Array.isArray(caps) || !caps.every((c) => typeof c === 'string')) throw new DirectPrintError('appUpdateIos');
  if (printer !== null && printer !== undefined && !isObj(printer)) throw new DirectPrintError('appUpdateIos');
  const name = printerName(printer);
  return { v, auth: typeof auth === 'string' ? auth : '', printer: name === null ? null : { name }, busy, caps: caps as string[] };
}

/** الطابعة المحفوظة في التطبيق — لا يرمي أبداً (null عند أيّ تعذّر) */
export async function iosLinkedPrinter(env: IosEnv = browserIosEnv()): Promise<IosPrinterLink | null> {
  try {
    const h = await iosHello(env);
    return h.printer ? linkOf(h.printer.name) : null;
  } catch { return null; }
}

/** «ربط الطابعة»: شاشة الاختيار في التطبيق — والإلغاء أو التعذّر بصنفه */
export async function iosPick(env: IosEnv = browserIosEnv()): Promise<IosPrinterLink> {
  let r: unknown;
  try {
    r = await env.post({ op: 'pick' });
  } catch (e) {
    throw new DirectPrintError('failed', e);
  }
  if (isObj(r) && r.ok === true) return linkOf(printerName(r.printer));
  throw new DirectPrintError(failureForCode(isObj(r) ? r.code : undefined));
}

/** طابعة هذه الضغطة: طباعةٌ جارية ⇒ printing؛ والمحفوظة، وإلا شاشة الاختيار */
export async function iosPrinterForJob(env: IosEnv = browserIosEnv()): Promise<IosPrinterLink> {
  const h = await iosHello(env);
  if (h.busy) throw new DirectPrintError('printing');
  return h.printer ? linkOf(h.printer.name) : iosPick(env);
}

/**
 * يرسل المهمة إلى التطبيق: سقف المهمة أوّلاً (الكبير يُرفض قبل أيّ ترميز أو إرسال ⇒ نظام الطباعة)، ثم الحمولة خاماً بسقف
 * الآيفون، ثم النداء — والتقدّم من أحداث هذه المهمة وحدها، والإلغاء رسالة cancel مرّةً واحدة يتمّ بعدها التطبيق السطر الجاري.
 * لا يعيد 'handed' أبداً: النتيجة تعود من التطبيق نفسه.
 */
export async function sendViaIos(link: IosPrinterLink, job: BridgeJob, ui: DirectUi, env: IosEnv = browserIosEnv()): Promise<DirectOutcome> {
  void link;
  if (!(job.bytes instanceof Uint8Array) || job.bytes.length > IOS_MAX_JOB_BYTES) throw new DirectPrintError('tooLarge');
  let payload: string;
  try {
    payload = await encodeBridgePayload(job, { encoding: 'raw', compress: null, maxChars: IOS_MAX_PAYLOAD_CHARS });
  } catch (e) {
    throw new DirectPrintError(e instanceof BridgePayloadError && e.code === 'TOO_LARGE' ? 'tooLarge' : 'failed', e);
  }
  if (ui.signal?.aborted) return 'cancelled';
  let id = env.jobId();
  if (!IOS_JOB_ID_RE.test(id)) id = newJobId();
  let cancelSent = false;
  const onAbort = () => {
    if (cancelSent) return;
    cancelSent = true;
    try { env.post({ op: 'cancel', job: id }).catch(() => undefined); } catch { /* التطبيق يُتمّ المهمة */ }
  };
  const off = env.onProgress((d) => {
    if (d.job !== id || !(d.total > 0) || !Number.isFinite(d.sent)) return;
    ui.onProgress?.('send', Math.min(1, Math.max(0, d.sent / d.total)));
  });
  ui.signal?.addEventListener('abort', onAbort, { once: true });
  let r: unknown;
  try {
    ui.onProgress?.('send', 0);
    r = await env.post({ op: 'print', job: id, payload });
  } catch (e) {
    throw new DirectPrintError('failed', e);
  } finally {
    off();
    ui.signal?.removeEventListener('abort', onAbort);
  }
  if (isObj(r) && r.ok === true) return r.outcome === 'cancelled' ? 'cancelled' : 'done';
  throw new DirectPrintError(failureForCode(isObj(r) ? r.code : undefined));
}

/** «نظام الطباعة» عبر التطبيق: المفتاح في الويب، والمعالج، والعلامة تعلن systemPrint */
export function iosSystemPrintAvailable(w: unknown = pageWindow(), viaApp: boolean = IOS_SYSTEM_PRINT_VIA_APP): boolean {
  if (!viaApp || !handlerOf(w)) return false;
  const m = markerOf(w);
  return !!m && m.v >= IOS_BRIDGE_VERSION && m.caps.includes('systemPrint');
}

/**
 * يطبع وثيقة HTML بنظام الطباعة في الآيفون (AirPrint من التطبيق) — print() في WKWebView لا يفتح نافذة الطباعة. إغلاق النافذة
 * بلا طباعة ليس خطأً؛ وتعذّر التطبيق يرمي Error('print frame') كتعذّر الإطار فتعرض الشاشة «تعذرت الطباعة».
 */
export async function iosSystemPrint(html: string, widthMm: number, name: string, env: IosEnv = browserIosEnv()): Promise<void> {
  let r: unknown;
  try {
    r = await env.post({ op: 'systemPrint', html, widthMm, name });
  } catch {
    throw new Error('print frame');
  }
  if (isObj(r) && r.ok === true) return;
  throw new Error('print frame');
}
