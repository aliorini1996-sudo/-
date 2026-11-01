/**
 * حمولة جسر الطباعة v1 — بايتات الطابعة كما أخرجها encodeForProfile (rep/printDirect.ts) في نصٍّ base64url يحمله رابط
 * intent إلى تطبيق فيلد سيلز على أندرويد (appBridge.ts)، فيفكّه PrintPayload.kt ويرسله بالبلوتوث كما يرسله btSerial.ts.
 *
 *   الإطار = رأس 14 بايتاً («FSP»، الإصدار، الترميز، محجوز، طول الداخل، CRC32 الداخل) ثم الجسم (خام أو deflate)
 *   الداخل = النوع، الأعلام (رابط بطيء)، الدفعة، المهلة، مهلة الإغلاق، أمر الإلغاء، الوسم، العلامات (LEB128 فروقاً)، المهمة
 *
 * الصيغة ملزمةٌ للطرفين حرفاً بحرف، وترتيب الفحص في الفكّ ملزمٌ كذلك (لكل خللٍ رمزه نفسه في TypeScript وKotlin) — والعقد
 * بينهما متّجهات ذهبية مشتركة (bridgeVectors.test.ts). نقيٌّ: لا وصول للصفحة عند التحميل (تستورده اختبارات Node).
 */
import { CHUNK_BYTES, CLOSE_GRACE_MS, SLOW_LINK_PAUSE_MS } from './btSerial';
import {
  MAX_CANCEL_BYTES, MAX_INNER_BYTES, MAX_JOB_BYTES, MAX_LABEL_BYTES, MAX_MARKS, MAX_PAYLOAD_CHARS, PAYLOAD_FORMAT_VERSION,
  PAYLOAD_HEADER_BYTES,
} from './bridgeContract';

export type BridgeKind = 'escpos' | 'escp24' | 'tspl';
export type BridgeEncoding = 'raw' | 'deflate-raw' | 'deflate';
export type PayloadErrorCode = 'TOO_LONG' | 'BAD_BASE64' | 'BAD_HEADER' | 'BAD_VERSION' | 'BAD_ENCODING' | 'BAD_LENGTH'
  | 'INFLATE_FAILED' | 'LENGTH_MISMATCH' | 'BAD_CRC' | 'BAD_LAYOUT' | 'BAD_MARKS';

/** رفض الحمولة برمزه — الرموز نفسها في PrintPayload.kt (والترميز وحده: TOO_LARGE وBAD_INPUT) */
export class BridgePayloadError extends Error {
  readonly code: PayloadErrorCode | 'TOO_LARGE' | 'BAD_INPUT';
  constructor(code: PayloadErrorCode | 'TOO_LARGE' | 'BAD_INPUT', cause?: unknown) {
    super(code);
    this.name = 'BridgePayloadError';
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface BridgeJob {
  kind: BridgeKind;
  bytes: Uint8Array;
  marks: readonly number[];
  cancel: readonly number[];
  slow: boolean;
  /** وسمٌ قصير للمستند يعرضه التطبيق، مثل «الفاتورة — INV-12» */
  label: string;
  chunkBytes?: number;
  pauseMs?: number;
  closeGraceMs?: number;
}

export interface DecodedBridgeJob {
  kind: BridgeKind; slow: boolean; chunkBytes: number; pauseMs: number; closeGraceMs: number;
  cancel: number[]; label: string; marks: number[]; bytes: Uint8Array;
}

export type Compressor = (data: Uint8Array, format: 'deflate-raw' | 'deflate') => Promise<Uint8Array>;
export type Decompressor = (data: Uint8Array, format: 'deflate-raw' | 'deflate', maxOut: number) => Promise<Uint8Array>;

const MAGIC = [0x46, 0x53, 0x50]; // "FSP"
const KIND_CODE: Readonly<Record<BridgeKind, number>> = { escpos: 1, escp24: 2, tspl: 3 };
const KIND_NAME: Readonly<Record<number, BridgeKind>> = { 1: 'escpos', 2: 'escp24', 3: 'tspl' };
const ENC_CODE: Readonly<Record<BridgeEncoding, number>> = { raw: 0, 'deflate-raw': 1, deflate: 2 };

// ─── CRC-32 (IEEE 802.3 = java.util.zip.CRC32) ───

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ─── base64url بلا حشو ───

/** طول base64url بلا حشو لعددٍ من البايتات */
const b64Length = (n: number): number => Math.floor((n * 4 + 2) / 3);

export function toBase64Url(b: Uint8Array): string {
  let bin = '';
  // شرائح 32 ك.ب: String.fromCharCode بمعاملاتٍ كثيرة يفيض المكدّس
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  if (s.length === 0 || s.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(s)) throw new BridgePayloadError('BAD_BASE64');
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  } catch (e) {
    throw new BridgePayloadError('BAD_BASE64', e);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** UTF-8 بحدٍّ أقصى من البايتات — لا يقطع حرفاً في منتصفه */
export function utf8Truncate(s: string, maxBytes: number): Uint8Array {
  const enc = new TextEncoder();
  const all = enc.encode(s);
  if (all.length <= maxBytes) return all;
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const ch of s) {
    const b = enc.encode(ch);
    if (total + b.length > maxBytes) break;
    parts.push(b);
    total += b.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ─── الداخل ───

const u16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
function leb128(v: number, out: number[]): void {
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
}
const isU16 = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= 0xffff;

/** وثيقة الداخل من مهمةٍ — يرفض المدخل المختلّ (BAD_INPUT) والكبير (TOO_LARGE) قبل أيّ ترميز */
export function buildInner(job: BridgeJob): Uint8Array {
  const bad = () => new BridgePayloadError('BAD_INPUT');
  const kind = KIND_CODE[job.kind];
  if (kind === undefined) throw bad();
  const bytes = job.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw bad();
  if (bytes.length > MAX_JOB_BYTES) throw new BridgePayloadError('TOO_LARGE');
  const marks = job.marks;
  if (marks.length === 0) throw bad();
  if (marks.length > MAX_MARKS) throw new BridgePayloadError('TOO_LARGE');
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (!Number.isInteger(m) || m < 0 || (i > 0 && m <= marks[i - 1])) throw bad();
  }
  if (marks[marks.length - 1] !== bytes.length) throw bad();
  const cancel = job.cancel;
  if (cancel.length > MAX_CANCEL_BYTES || cancel.some((c) => !Number.isInteger(c) || c < 0 || c > 0xff)) throw bad();
  const chunkBytes = job.chunkBytes ?? CHUNK_BYTES;
  const pauseMs = job.pauseMs ?? SLOW_LINK_PAUSE_MS;
  const closeGraceMs = job.closeGraceMs ?? CLOSE_GRACE_MS;
  if (!isU16(chunkBytes) || chunkBytes === 0 || !isU16(pauseMs) || !isU16(closeGraceMs)) throw bad();
  const label = utf8Truncate(job.label.trim(), MAX_LABEL_BYTES);

  const head: number[] = [kind, job.slow ? 1 : 0, ...u16(chunkBytes), ...u16(pauseMs), ...u16(closeGraceMs), cancel.length, ...cancel, label.length];
  const tail: number[] = [...u32(marks.length)];
  let prev = 0;
  marks.forEach((m, i) => { leb128(i === 0 ? m : m - prev, tail); prev = m; });
  tail.push(...u32(bytes.length));
  const size = head.length + label.length + tail.length + bytes.length;
  if (size > MAX_INNER_BYTES) throw new BridgePayloadError('TOO_LARGE');
  const out = new Uint8Array(size);
  let at = 0;
  out.set(head, at); at += head.length;
  out.set(label, at); at += label.length;
  out.set(tail, at); at += tail.length;
  out.set(bytes, at);
  return out;
}

// ─── الضغط بتيارات المتصفح ───

/**
 * يكتب ويقرأ معاً — انتظار الكتابة أوّلاً يحبس المدخل الكبير (ضغط التيار الراجع). وmaxOut: إخراجٌ يجاوزه يُلغى فوراً
 * (LENGTH_MISMATCH) فلا تنفجر الذاكرة بحمولةٍ مغشوشة.
 */
async function pump(stream: { writable: WritableStream<BufferSource>; readable: ReadableStream<Uint8Array> }, data: Uint8Array, maxOut?: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const written = writer.write(new Uint8Array(data)).then(() => writer.close());
  written.catch(() => undefined); // خطأ التيار يصل القارئ أيضاً — يُحكم هناك
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    total += r.value.length;
    if (maxOut !== undefined && total > maxOut) {
      await reader.cancel().catch(() => undefined);
      throw new BridgePayloadError('LENGTH_MISMATCH');
    }
    chunks.push(r.value);
  }
  await written;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** CompressionStream إن وُجد — وإلا null (الحمولة خامٌ) */
export function streamCompressor(): Compressor | null {
  if (typeof CompressionStream === 'undefined') return null;
  return (data, format) => pump(new CompressionStream(format), data);
}

/** DecompressionStream إن وُجد — للاختبارات والتحقّق ذهاباً وإياباً (التطبيق يفكّ بـInflater) */
export function streamDecompressor(): Decompressor | null {
  if (typeof DecompressionStream === 'undefined') return null;
  return async (data, format, maxOut) => {
    try {
      return await pump(new DecompressionStream(format), data, maxOut);
    } catch (e) {
      // تيارٌ مبتور أو بعده بايتات زائدة: TypeError من المتصفح/Node
      throw e instanceof BridgePayloadError ? e : new BridgePayloadError('INFLATE_FAILED', e);
    }
  };
}

// ─── الترميز ───

function frameOf(inner: Uint8Array, body: Uint8Array, encoding: BridgeEncoding): Uint8Array {
  const head = [...MAGIC, PAYLOAD_FORMAT_VERSION, ENC_CODE[encoding], 0, ...u32(inner.length), ...u32(crc32(inner))];
  const f = new Uint8Array(PAYLOAD_HEADER_BYTES + body.length);
  f.set(head, 0);
  f.set(body, PAYLOAD_HEADER_BYTES);
  return f;
}

/**
 * الحمولة النصّية لمهمة. 'auto' (الإنتاج): deflate-raw، فإن رُفض فـdeflate، فإن غابا فخام — والمضغوط لا يُستعمل إلا إن قصُر
 * عن الداخل. ما جاوز MAX_PAYLOAD_CHARS ⇒ TOO_LARGE (يُطبع بنظام الطباعة). والترميز المفروض للاختبارات والمتّجهات.
 */
export async function encodeBridgePayload(
  job: BridgeJob, opts: { encoding?: BridgeEncoding | 'auto'; compress?: Compressor | null } = {},
): Promise<string> {
  const inner = buildInner(job);
  const compress = opts.compress === undefined ? streamCompressor() : opts.compress;
  const want = opts.encoding ?? 'auto';
  let body = inner;
  let encoding: BridgeEncoding = 'raw';
  if (want === 'auto') {
    if (compress) {
      for (const format of ['deflate-raw', 'deflate'] as const) {
        let c: Uint8Array;
        try { c = await compress(inner, format); } catch { continue; }
        if (c.length < inner.length) { body = c; encoding = format; }
        break;
      }
    }
  } else if (want !== 'raw') {
    if (!compress) throw new BridgePayloadError('BAD_INPUT');
    body = await compress(inner, want);
    encoding = want;
  }
  if (b64Length(PAYLOAD_HEADER_BYTES + body.length) > MAX_PAYLOAD_CHARS) throw new BridgePayloadError('TOO_LARGE');
  return toBase64Url(frameOf(inner, body, encoding));
}

// ─── الفكّ (ترتيب الفحص ملزم — §A.3.6) ───

export async function decodeBridgePayload(s: string, opts: { decompress?: Decompressor } = {}): Promise<DecodedBridgeJob> {
  if (s.length > MAX_PAYLOAD_CHARS) throw new BridgePayloadError('TOO_LONG');
  const f = fromBase64Url(s);
  if (f.length < PAYLOAD_HEADER_BYTES || f[0] !== MAGIC[0] || f[1] !== MAGIC[1] || f[2] !== MAGIC[2]) throw new BridgePayloadError('BAD_HEADER');
  if (f[3] !== PAYLOAD_FORMAT_VERSION) throw new BridgePayloadError('BAD_VERSION');
  const enc = f[4];
  if (enc !== 0 && enc !== 1 && enc !== 2) throw new BridgePayloadError('BAD_ENCODING');
  if (f[5] !== 0) throw new BridgePayloadError('BAD_HEADER');
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const innerLength = dv.getUint32(6, true);
  const crc = dv.getUint32(10, true);
  if (innerLength === 0 || innerLength > MAX_INNER_BYTES) throw new BridgePayloadError('BAD_LENGTH');
  const body = f.subarray(PAYLOAD_HEADER_BYTES);
  let inner: Uint8Array;
  if (enc === 0) {
    if (body.length !== innerLength) throw new BridgePayloadError('BAD_LENGTH');
    inner = body;
  } else {
    const decompress = opts.decompress ?? streamDecompressor();
    if (!decompress) throw new BridgePayloadError('INFLATE_FAILED');
    try {
      inner = await decompress(body, enc === 1 ? 'deflate-raw' : 'deflate', innerLength);
    } catch (e) {
      throw e instanceof BridgePayloadError ? e : new BridgePayloadError('INFLATE_FAILED', e);
    }
    if (inner.length !== innerLength) throw new BridgePayloadError('LENGTH_MISMATCH');
  }
  if (crc32(inner) !== crc) throw new BridgePayloadError('BAD_CRC');
  return parseInner(inner);
}

function parseInner(b: Uint8Array): DecodedBridgeJob {
  const layout = () => new BridgePayloadError('BAD_LAYOUT');
  let p = 0;
  const need = (n: number) => { if (p + n > b.length) throw layout(); };
  const rdU32 = () => { need(4); const v = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; p += 4; return v; };
  need(9);
  const kind = KIND_NAME[b[0]];
  if (!kind) throw layout();
  const flags = b[1];
  if (flags & 0xfe) throw layout();
  const chunkBytes = b[2] | (b[3] << 8);
  const pauseMs = b[4] | (b[5] << 8);
  const closeGraceMs = b[6] | (b[7] << 8);
  if (chunkBytes === 0) throw layout();
  const cancelLen = b[8];
  p = 9;
  if (cancelLen > MAX_CANCEL_BYTES) throw layout();
  need(cancelLen);
  const cancel = Array.from(b.subarray(p, p + cancelLen));
  p += cancelLen;
  need(1);
  const labelLen = b[p];
  p += 1;
  if (labelLen > MAX_LABEL_BYTES) throw layout();
  need(labelLen);
  let label: string;
  try { label = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(p, p + labelLen)); } catch { throw layout(); }
  p += labelLen;
  const marksCount = rdU32();
  if (marksCount === 0 || marksCount > MAX_MARKS) throw layout();
  const deltas: number[] = [];
  for (let i = 0; i < marksCount; i++) {
    let v = 0;
    let shift = 0;
    for (let k = 0; ; k++) {
      need(1);
      const byte = b[p++];
      if (k === 4 && (byte & 0xf0)) throw layout(); // فوق 32 بتاً
      v += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (k === 4) throw layout();
    }
    deltas.push(v);
  }
  const jobLength = rdU32();
  if (jobLength === 0 || jobLength > MAX_JOB_BYTES) throw layout();
  need(jobLength);
  const bytes = b.slice(p, p + jobLength);
  p += jobLength;
  if (p !== b.length) throw layout();
  const marks: number[] = [];
  let acc = 0;
  for (let i = 0; i < deltas.length; i++) {
    if (i > 0 && deltas[i] === 0) throw new BridgePayloadError('BAD_MARKS');
    acc += deltas[i];
    if (acc > jobLength) throw new BridgePayloadError('BAD_MARKS');
    marks.push(acc);
  }
  if (marks[marks.length - 1] !== jobLength) throw new BridgePayloadError('BAD_MARKS');
  return { kind, slow: (flags & 1) === 1, chunkBytes, pauseMs, closeGraceMs, cancel, label, marks, bytes };
}
