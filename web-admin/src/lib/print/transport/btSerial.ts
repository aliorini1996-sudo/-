/**
 * النقل بالبلوتوث الكلاسيكي (RFCOMM/SPP) عبر Web Serial — «إعدادات الطباعة» M3، التصميم §3.1 و§3.3 الخطوة 6.
 *
 * Chrome على أندرويد يحمل Web Serial منذ 138 (وسطح المكتب منذ 117 للبلوتوث)، فتطبيق المندوب (TWA) يرسل البايتات للطابعة بلا
 * كود أصليّ. الشروط: Chrome لا Samsung Internet مضيفاً للتطبيق (WebView لا يحمله أبداً)، والطابعة **مقترنة أولاً** من إعدادات
 * البلوتوث في الجوال، والربط الأوّل بلمسة (requestPort يحتاج إيماءة المستخدم) ثم getPorts في كل طباعةٍ بعدها.
 *
 * طابعةٌ واحدة مربوطة لكل جهاز: Web Serial لا يكشف اسم الجهاز ولا عنوانه، فطابعتان مربوطتان لا تُميَّزان — «ربط الطابعة»
 * ينسى ما قبلها (forget). شاحنةٌ واحدة = طابعةٌ واحدة؛ وجهازٌ بطابعتين يطبع الثانية بنظام الطباعة.
 *
 * الإرسال: فتح المنفذ (معدّل البود يُتجاهل على RFCOMM) ثم دفعات 512 بايتاً تنتظر writer.ready، ومهلة 20 مللي ثانية اختيارية
 * («رابط بطيء») لطابعاتٍ تُسقط البيانات، ثم إغلاق المنفذ بعد كل مهمة — فتبقى الطابعة متاحةً لتطبيقٍ آخر. والإلغاء يكمل الأمر
 * الجاري حتى أقرب علامة (byteSink.ts) ثم يرسل أمر الإلغاء (ESC @، ومعه FF للنقطية).
 */
import { DirectPrintError, type DirectPrintFailure } from '../printErrors';
import type { EncodedJob } from '../byteSink';

/** خدمة المنفذ التسلسلي (SPP) — UUID القياسي 0x1101 */
export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';
export const CHUNK_BYTES = 512;
export const SLOW_LINK_PAUSE_MS = 20;
/** مهلة قبل الإغلاق: آخر الدفعات في ذاكرة النظام لم تبلغ الطابعة بعد — إغلاق RFCOMM فوراً قد يقطع ذيل الورقة */
export const CLOSE_GRACE_MS = 800;

// ─── أنواع Web Serial الدنيا (ليست في lib.dom لـTypeScript هذا) ───

export interface SerialPortInfoLike { bluetoothServiceClassId?: string | number; usbVendorId?: number }
export interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfoLike;
  forget?(): Promise<void>;
}
export interface SerialLike {
  requestPort(options?: { filters?: Array<{ bluetoothServiceClassId?: string }>; allowedBluetoothServiceClassIds?: string[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

/** واجهة Web Serial إن وُجدت في سياقٍ آمن — وإلا null (Samsung Internet، WebView، Chrome أقدم، http) */
export function serialApi(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator, secure: boolean = typeof window !== 'undefined' && window.isSecureContext): SerialLike | null {
  const s = (nav as { serial?: SerialLike } | undefined)?.serial;
  return secure && s && typeof s.requestPort === 'function' && typeof s.getPorts === 'function' ? s : null;
}

export const directPrintAvailable = (): boolean => serialApi() !== null;

/** منفذ بلوتوث SPP؟ المعرّف نصّاً كاملاً أو مختصراً أو رقماً (0x1101) بحسب إصدار Chrome */
export function isSppPort(info: SerialPortInfoLike): boolean {
  const id = info.bluetoothServiceClassId;
  if (typeof id === 'number') return id === 0x1101;
  if (typeof id === 'string') {
    const v = id.toLowerCase();
    return v === SPP_UUID || v === '0x1101' || v === '1101';
  }
  return false;
}

/** نوع الخطأ: نصّ الاستثناء من Web Serial ومرحلته (اختيار/فتح/كتابة) */
export function serialFailureOf(e: unknown, phase: 'choose' | 'open' | 'write'): DirectPrintFailure {
  if (e instanceof DirectPrintError) return e.kind;
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'SecurityError') return 'security';
  if (phase === 'choose') return name === 'NotFoundError' || name === 'AbortError' ? 'notChosen' : 'failed';
  if (phase === 'open') return 'busy'; // InvalidStateError (مفتوحٌ لتطبيقٍ آخر) أو NetworkError (مطفأة/بعيدة)
  return 'disconnected'; // NetworkError / BreakError أثناء الكتابة: انقطع الرابط
}

/** الطابعة المربوطة على هذا الجهاز (بلا إيماءة) — null إن لم تُربط أو لم يدعم المتصفح */
export async function linkedPrinter(api: SerialLike | null = serialApi()): Promise<SerialPortLike | null> {
  if (!api) return null;
  try {
    const ports = await api.getPorts();
    return ports.find((p) => isSppPort(p.getInfo())) ?? null;
  } catch { return null; }
}

/**
 * «ربط الطابعة»: نافذة اختيار Chrome بالطابعات المقترنة التي تقدّم SPP — بإيماءة المستخدم (لمسة الزرّ) — ثم نسيان ما قبلها.
 */
export async function linkPrinter(api: SerialLike | null = serialApi()): Promise<SerialPortLike> {
  if (!api) throw new DirectPrintError('unsupported');
  let port: SerialPortLike;
  try {
    port = await api.requestPort({ filters: [{ bluetoothServiceClassId: SPP_UUID }], allowedBluetoothServiceClassIds: [SPP_UUID] });
  } catch (e) {
    throw new DirectPrintError(serialFailureOf(e, 'choose'), e);
  }
  try {
    for (const p of await api.getPorts()) if (p !== port && p.forget) await p.forget().catch(() => undefined);
  } catch { /* النسيان تحسين: الربط نجح */ }
  return port;
}

/** المربوطة أو الربط الآن — يُستدعى أوّل الضغطة (قبل أيّ عملٍ طويل) كي لا تنتهي صلاحية الإيماءة */
export async function printerForJob(api: SerialLike | null = serialApi()): Promise<SerialPortLike> {
  if (!api) throw new DirectPrintError('unsupported');
  return (await linkedPrinter(api)) ?? linkPrinter(api);
}

export interface SendOptions {
  signal?: AbortSignal;
  /** نسبة المُرسَل 0–1 بعد كل دفعة */
  onProgress?: (fraction: number) => void;
  /** يُرسل بعد آخر أمرٍ مكتمل عند الإلغاء */
  cancelBytes?: readonly number[];
  /** مهلة بين الدفعات لطابعاتٍ تُسقط البيانات */
  slow?: boolean;
  /** للاختبار: انتظار بلا مؤقّت حقيقي */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * يرسل المهمة ويغلق المنفذ دائماً. 'cancelled' إن أُلغيت (بعد إكمال الأمر الجاري وإرسال أمر الإلغاء). يرمي DirectPrintError:
 * busy عند الفتح، وdisconnected أثناء الكتابة.
 */
export async function sendJob(port: SerialPortLike, job: EncodedJob, opts: SendOptions = {}): Promise<'done' | 'cancelled'> {
  const sleep = opts.sleep ?? realSleep;
  try {
    await port.open({ baudRate: 9600 });
  } catch (e) {
    throw new DirectPrintError(serialFailureOf(e, 'open'), e);
  }
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  try {
    if (!port.writable) throw new DirectPrintError('busy');
    writer = port.writable.getWriter();
    const { bytes, marks } = job;
    const total = bytes.length;
    let sent = 0;
    let stopAt = total;
    let cancelled = false;
    while (sent < stopAt) {
      if (!cancelled && opts.signal?.aborted) {
        cancelled = true;
        // أقرب نهاية أمرٍ مكتمل بعد ما أُرسل — لا قطع في منتصف صورة
        stopAt = marks.find((m) => m >= sent) ?? total;
        if (sent >= stopAt) break;
      }
      const end = Math.min(sent + CHUNK_BYTES, stopAt);
      await writer.ready;
      await writer.write(bytes.subarray(sent, end));
      sent = end;
      opts.onProgress?.(sent / total);
      if (opts.slow) await sleep(SLOW_LINK_PAUSE_MS);
    }
    if (cancelled && opts.cancelBytes?.length) {
      await writer.ready;
      await writer.write(Uint8Array.from(opts.cancelBytes));
    }
    await writer.ready;
    await writer.close();
    writer = null;
    await sleep(CLOSE_GRACE_MS);
    return cancelled ? 'cancelled' : 'done';
  } catch (e) {
    throw e instanceof DirectPrintError ? e : new DirectPrintError(serialFailureOf(e, 'write'), e);
  } finally {
    // خطأٌ أثناء الكتابة: إسقاط ما بقي في الطابور ثم فكّ القفل — وإلا رفض close() منفذاً مقفلاً وبقي محجوزاً
    if (writer) {
      try { await writer.abort(); } catch { /* */ }
      try { writer.releaseLock(); } catch { /* */ }
    }
    try { await port.close(); } catch { /* مغلقٌ أصلاً أو انقطع */ }
  }
}
