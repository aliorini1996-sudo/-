// ============================================================================
// ZATCA المرحلة الثانية (Z2) — قارئ وكاتب DER مصغّران (native، بلا مكتبات ASN.1)
// ----------------------------------------------------------------------------
// القارئ: صارم على DER (طول محدَّد بأقصر ترميز، لا طول غير محدود، رقم وسم بأقصر صيغة)،
// محدود العمق، ويفكّ INTEGER (bigint بإشارة) وOID وBIT STRING والنصوص وUTCTime/GeneralizedTime.
// الكاتب: SEQUENCE وSET (SET OF مرتّب بايتياً كما يشترط DER) وINTEGER وOID وUTF8String
// وPrintableString وIA5String وBIT STRING وOCTET STRING وBOOLEAN وNULL والأزمنة والوسوم السياقية.
// يُستعمل في cert.ts لقراءة شهادة CSID، ويعيد Z4 استعمال الكاتب لبناء CSR.
// ============================================================================

export class DerError extends Error {
  readonly offset: number;
  constructor(message: string, offset = -1) {
    super(offset >= 0 ? `DER: ${message} (offset ${offset})` : `DER: ${message}`);
    this.name = 'DerError';
    this.offset = offset;
  }
}

export const TAG = Object.freeze({
  BOOLEAN: 0x01, INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06,
  UTF8_STRING: 0x0c, PRINTABLE_STRING: 0x13, T61_STRING: 0x14, IA5_STRING: 0x16, UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18, BMP_STRING: 0x1e, SEQUENCE: 0x30, SET: 0x31,
});

export type DerClass = 'universal' | 'application' | 'context' | 'private';

export interface DerNode {
  /** بايت المعرّف الأول كما هو (مثلاً 0x30 للـSEQUENCE، 0xa0 لـ[0] مركّب). */
  tag: number;
  cls: DerClass;
  constructed: boolean;
  tagNumber: number;
  /** موضع بداية الـTLV. */
  offset: number;
  /** موضع بداية القيمة. */
  valueOffset: number;
  /** الموضع بعد نهاية الـTLV. */
  end: number;
  /** الـTLV كاملاً (عرض على نفس الذاكرة). */
  raw: Uint8Array;
  value: Uint8Array;
  /** للأنواع المركّبة فقط. */
  children?: DerNode[];
}

const CLASSES: DerClass[] = ['universal', 'application', 'context', 'private'];
const MAX_DEPTH = 32;
/**
 * أقصى عدد عُقد TLV في مخزن واحد. كل عقدة كائن بعرضَي ذاكرة، فمخزن من TLVات صغيرة (05 00) كان يتضخّم
 * ~190 ضعفاً (16MB ⇒ نفاد ذاكرة Node). شهادة CSID نحو 60 عقدة وCSR أقل.
 */
export const DEFAULT_MAX_DER_NODES = 4096;

interface ReadState { nodes: number; maxNodes: number }

function readNode(buf: Uint8Array, offset: number, limit: number, depth: number, st: ReadState): DerNode {
  if (depth > MAX_DEPTH) throw new DerError('تداخل أعمق من الحدّ', offset);
  if (++st.nodes > st.maxNodes) throw new DerError(`عدد العُقد تجاوز ${st.maxNodes}`, offset);
  let p = offset;
  if (p >= limit) throw new DerError('نهاية مبكرة (وسم)', p);
  const tag = buf[p++];
  const cls = CLASSES[tag >> 6];
  const constructed = (tag & 0x20) !== 0;
  let tagNumber = tag & 0x1f;
  if (tagNumber === 0x1f) {
    tagNumber = 0;
    let first = true;
    for (;;) {
      if (p >= limit) throw new DerError('نهاية مبكرة (رقم وسم)', p);
      const b = buf[p++];
      if (first && b === 0x80) throw new DerError('رقم وسم بصيغة غير أقصر', p - 1);
      first = false;
      tagNumber = tagNumber * 128 + (b & 0x7f);
      if (tagNumber > 0xffffff) throw new DerError('رقم وسم كبير جداً', p - 1);
      if ((b & 0x80) === 0) break;
    }
    if (tagNumber < 0x1f) throw new DerError('رقم وسم صغير بصيغة طويلة', offset);
  }
  if (p >= limit) throw new DerError('نهاية مبكرة (طول)', p);
  const l0 = buf[p++];
  let length: number;
  if (l0 < 0x80) {
    length = l0;
  } else {
    const nb = l0 & 0x7f;
    if (nb === 0) throw new DerError('الطول غير المحدود ممنوع في DER', p - 1);
    if (nb > 4) throw new DerError('طول أكبر من المدعوم', p - 1);
    if (p + nb > limit) throw new DerError('نهاية مبكرة (بايتات الطول)', p);
    if (buf[p] === 0) throw new DerError('بايت طول بادئ صفري (ليس أقصر ترميز)', p);
    length = 0;
    for (let i = 0; i < nb; i++) length = length * 256 + buf[p++];
    if (length < 0x80) throw new DerError('طول قصير بصيغة طويلة (ليس أقصر ترميز)', offset);
  }
  const valueOffset = p;
  const end = valueOffset + length;
  if (end > limit) throw new DerError('الطول يتجاوز البيانات', offset);
  const node: DerNode = {
    tag, cls, constructed, tagNumber, offset, valueOffset, end,
    raw: buf.subarray(offset, end), value: buf.subarray(valueOffset, end),
  };
  if (constructed) {
    const children: DerNode[] = [];
    let q = valueOffset;
    while (q < end) {
      const c = readNode(buf, q, end, depth + 1, st);
      children.push(c);
      q = c.end;
    }
    node.children = children;
  }
  return node;
}

const nodeBudget = (maxNodes: number): ReadState => {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new DerError(`حدّ العُقد غير صالح ${String(maxNodes)}`);
  return { nodes: 0, maxNodes };
};

/** يقرأ عقدة DER واحدة عند offset (ضمن حدود المخزن). */
export function readDer(buf: Uint8Array, offset = 0, maxNodes = DEFAULT_MAX_DER_NODES): DerNode {
  return readNode(buf, offset, buf.length, 0, nodeBudget(maxNodes));
}

/** يقرأ مخزناً يجب أن يكون TLV واحداً بالضبط (لا بايتات زائدة). */
export function parseDer(buf: Uint8Array, maxNodes = DEFAULT_MAX_DER_NODES): DerNode {
  const n = readNode(buf, 0, buf.length, 0, nodeBudget(maxNodes));
  if (n.end !== buf.length) throw new DerError('بايتات زائدة بعد الـTLV', n.end);
  return n;
}

export function expectTag(node: DerNode, tag: number, what: string): DerNode {
  if (node.tag !== tag) throw new DerError(`${what}: وسم 0x${node.tag.toString(16)} بدل 0x${tag.toString(16)}`, node.offset);
  return node;
}

export function childrenOf(node: DerNode, what = 'عنصر'): DerNode[] {
  if (!node.children) throw new DerError(`${what}: ليس نوعاً مركّباً`, node.offset);
  return node.children;
}

/** أقصى طول INTEGER افتراضياً: الرقم التسلسلي ≤ 20 بايت (RFC 5280) وr/s في ECDSA ≤ 33. */
export const DEFAULT_MAX_INTEGER_BYTES = 128;

/**
 * INTEGER بإشارة (مكمّل الاثنين)، مع رفض الترميز غير الأقصر. الطول محدود قبل أي حساب، والقيمة تُبنى
 * دفعة واحدة من hex — البناء بايتاً بايتاً بإزاحة bigint كان تربيعياً (80KB ⇒ ~6 ثوانٍ تحجب الخادم).
 */
export function decodeInteger(node: DerNode, maxBytes = DEFAULT_MAX_INTEGER_BYTES): bigint {
  expectTag(node, TAG.INTEGER, 'INTEGER');
  const v = node.value;
  if (v.length === 0) throw new DerError('INTEGER فارغ', node.offset);
  if (v.length > maxBytes) throw new DerError(`INTEGER أطول من ${maxBytes} بايت`, node.offset);
  if (v.length > 1 && ((v[0] === 0x00 && (v[1] & 0x80) === 0) || (v[0] === 0xff && (v[1] & 0x80) !== 0))) {
    throw new DerError('INTEGER بترميز غير أقصر', node.offset);
  }
  let x = BigInt(`0x${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}`);
  if (v[0] & 0x80) x -= BigInt(1) << BigInt(8 * v.length);
  return x;
}

/** أطول OID مقبول (بايتات القيمة) وأطول قوس واحد: 2^64 يحتاج 10 بايتات بترميز base-128. */
export const MAX_OID_BYTES = 64;
export const MAX_OID_ARC_BYTES = 10;

export function decodeOid(node: DerNode): string {
  expectTag(node, TAG.OID, 'OID');
  const v = node.value;
  if (v.length === 0) throw new DerError('OID فارغ', node.offset);
  if (v.length > MAX_OID_BYTES) throw new DerError(`OID أطول من ${MAX_OID_BYTES} بايت`, node.offset);
  const arcs: bigint[] = [];
  let cur = BigInt(0);
  let fresh = true;
  let arcLen = 0;
  for (let i = 0; i < v.length; i++) {
    const b = v[i];
    if (fresh && b === 0x80) throw new DerError('OID بترميز غير أقصر', node.offset + i);
    fresh = false;
    if (++arcLen > MAX_OID_ARC_BYTES) throw new DerError(`قوس OID أطول من ${MAX_OID_ARC_BYTES} بايت`, node.offset + i);
    cur = (cur << BigInt(7)) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) {
      arcs.push(cur);
      cur = BigInt(0);
      fresh = true;
      arcLen = 0;
    }
  }
  if (!fresh) throw new DerError('OID مبتور', node.offset);
  const first = arcs[0];
  const head = first < BigInt(40) ? [BigInt(0), first] : first < BigInt(80) ? [BigInt(1), first - BigInt(40)] : [BigInt(2), first - BigInt(80)];
  return [...head, ...arcs.slice(1)].map(a => a.toString()).join('.');
}

export function decodeBitString(node: DerNode): { unusedBits: number; bytes: Uint8Array } {
  expectTag(node, TAG.BIT_STRING, 'BIT STRING');
  const v = node.value;
  if (v.length === 0) throw new DerError('BIT STRING بلا بايت البتات غير المستعملة', node.offset);
  const unusedBits = v[0];
  if (unusedBits > 7 || (v.length === 1 && unusedBits !== 0)) throw new DerError('عدد بتات غير مستعملة غير صالح', node.offset);
  if (unusedBits && (v[v.length - 1] & ((1 << unusedBits) - 1)) !== 0) throw new DerError('بتات الحشو غير صفرية', node.offset);
  return { unusedBits, bytes: v.subarray(1) };
}

const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]*$/;

/** أقصى طول نصّ ASN.1 يُفكّ (أسماء الشهادات مئات البايتات؛ TLV واحد قد يبلغ 4GB بلا هذا الحدّ). */
export const MAX_DER_STRING_BYTES = 64 * 1024;

/** نص ASN.1: UTF8String وPrintableString وIA5String وBMPString (وT61 كـlatin1). */
export function decodeString(node: DerNode): string {
  if (node.value.length > MAX_DER_STRING_BYTES) throw new DerError(`نصّ أطول من ${MAX_DER_STRING_BYTES} بايت`, node.offset);
  const v = Buffer.from(node.value.buffer, node.value.byteOffset, node.value.byteLength);
  switch (node.tag) {
    case TAG.UTF8_STRING: {
      const s = v.toString('utf8');
      if (!Buffer.from(s, 'utf8').equals(v)) throw new DerError('UTF8String غير صالح', node.offset);
      return s;
    }
    case TAG.PRINTABLE_STRING: {
      const s = v.toString('latin1');
      if (!PRINTABLE.test(s)) throw new DerError('PrintableString بمحارف غير مسموحة', node.offset);
      return s;
    }
    case TAG.IA5_STRING: {
      if (v.some(b => b > 0x7f)) throw new DerError('IA5String بمحارف غير ASCII', node.offset);
      return v.toString('latin1');
    }
    case TAG.T61_STRING:
      return v.toString('latin1');
    case TAG.BMP_STRING: {
      if (v.length % 2) throw new DerError('BMPString بطول فردي', node.offset);
      // فكّ دفعة واحدة (الإلحاق محرفاً محرفاً كان يبني حبل نصّ من ملايين الخلايا)
      return Buffer.from(v).swap16().toString('utf16le');
    }
    default:
      throw new DerError(`وسم 0x${node.tag.toString(16)} ليس نصاً`, node.offset);
  }
}

/** UTCTime (YYMMDDHHMMSSZ) أو GeneralizedTime (YYYYMMDDHHMMSSZ) بصيغة DER (Z إلزامية، ثوانٍ إلزامية). */
export function decodeTime(node: DerNode): Date {
  const s = Buffer.from(node.value).toString('latin1');
  let m: RegExpExecArray | null;
  let year: number;
  if (node.tag === TAG.UTC_TIME) {
    m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    if (!m) throw new DerError(`UTCTime غير صالح «${s}»`, node.offset);
    const yy = +m[1];
    year = yy >= 50 ? 1900 + yy : 2000 + yy; // RFC 5280 §4.1.2.5.1
  } else if (node.tag === TAG.GENERALIZED_TIME) {
    m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    if (!m) throw new DerError(`GeneralizedTime غير صالح «${s}»`, node.offset);
    year = +m[1];
  } else {
    throw new DerError(`وسم 0x${node.tag.toString(16)} ليس زمناً`, node.offset);
  }
  const [mo, d, h, mi, se] = [+m[2], +m[3], +m[4], +m[5], +m[6]];
  const dt = new Date(Date.UTC(2000, mo - 1, d, h, mi, se));
  dt.setUTCFullYear(year); // Date.UTC يحوّل السنوات 0–99 إلى 19xx
  if (mo < 1 || mo > 12 || dt.getUTCDate() !== d || h > 23 || mi > 59 || se > 59 || dt.getUTCFullYear() !== year) {
    throw new DerError(`زمن تقويمي غير صالح «${s}»`, node.offset);
  }
  return dt;
}

// ─────────────────────────────────────────────────────────────────────────────
// الكاتب
// ─────────────────────────────────────────────────────────────────────────────

function lengthBytes(n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 0) throw new DerError(`طول غير صالح ${n}`);
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) out.unshift(x & 0xff);
  if (out.length > 4) throw new DerError('طول أكبر من المدعوم');
  return [0x80 | out.length, ...out];
}

function concat(parts: Uint8Array[]): Uint8Array {
  return Buffer.concat(parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}

/** TLV بمعرّف من بايت واحد (رقم وسم < 31). */
export function encTlv(tag: number, value: Uint8Array): Uint8Array {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xff || (tag & 0x1f) === 0x1f) throw new DerError(`وسم غير مدعوم في الكاتب 0x${tag.toString(16)}`);
  return concat([Uint8Array.from([tag, ...lengthBytes(value.length)]), value]);
}

export function encSequence(items: Uint8Array[]): Uint8Array {
  return encTlv(TAG.SEQUENCE, concat(items));
}

/** SET OF: العناصر مرتّبة تصاعدياً بترميزها (X.690 §11.6). sort=false لـSET عادي مرتّب مسبقاً. */
export function encSet(items: Uint8Array[], sort = true): Uint8Array {
  const list = sort ? [...items].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))) : items;
  return encTlv(TAG.SET, concat(list));
}

/** أقصى حجم INTEGER يكتبه الكاتب (CSR/الاختبارات؛ أكبر قيمة واقعية رقم تسلسلي 20 بايت). */
export const MAX_ENC_INTEGER_BYTES = 4096;

/** INTEGER من bigint/number بإشارة، أو من بايتات مقدار موجب (بلا إشارة). خطّي: من hex دفعة واحدة لا إزاحة لكل بايت. */
export function encInteger(v: bigint | number | Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  if (v instanceof Uint8Array) {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    const mag = v.subarray(i);
    if (mag.length === 0) bytes = Uint8Array.from([0]);
    else if (mag[0] & 0x80) { bytes = new Uint8Array(mag.length + 1); bytes.set(mag, 1); }
    else bytes = Uint8Array.from(mag);
  } else {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new DerError(`عدد غير صحيح ${v}`);
    const x = typeof v === 'number' ? BigInt(v) : v;
    let hex: string;
    if (x >= BigInt(0)) {
      hex = x.toString(16);
      if (hex.length % 2) hex = `0${hex}`;
      if (parseInt(hex.slice(0, 2), 16) & 0x80) hex = `00${hex}`;
    } else {
      // مكمّل الاثنين بأقل عدد بايتات: L = ⌈(bits(−x−1) + 1) / 8⌉
      const m = -x - BigInt(1);
      const bits = m === BigInt(0) ? 0 : m.toString(2).length;
      const len = Math.ceil((bits + 1) / 8);
      hex = ((BigInt(1) << BigInt(8 * len)) + x).toString(16).padStart(2 * len, '0');
    }
    bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  }
  if (bytes.length > MAX_ENC_INTEGER_BYTES) throw new DerError(`INTEGER أطول من ${MAX_ENC_INTEGER_BYTES} بايت`);
  return encTlv(TAG.INTEGER, bytes);
}

export function encOid(oid: string): Uint8Array {
  if (!/^[0-2](\.(0|[1-9]\d*))+$/.test(oid)) throw new DerError(`OID غير صالح «${oid}»`);
  const arcs = oid.split('.').map(a => BigInt(a));
  if (arcs[0] < BigInt(2) && arcs[1] >= BigInt(40)) throw new DerError(`القوس الثاني ≥ 40 في «${oid}»`);
  const out: number[] = [];
  const push = (a: bigint) => {
    // قوس واحد ≤ MAX_OID_ARC_BYTES بايت base-128 (يطابق القارئ) — وبلا نشر (spread) يفيض المكدّس
    if (a >= BigInt(1) << BigInt(7 * MAX_OID_ARC_BYTES)) throw new DerError(`قوس OID أكبر من ${MAX_OID_ARC_BYTES} بايت في «${oid.slice(0, 40)}»`);
    const tmp: number[] = [];
    let x = a;
    do { tmp.push(Number(x & BigInt(0x7f))); x >>= BigInt(7); } while (x > BigInt(0));
    for (let i = tmp.length - 1; i >= 0; i--) out.push(i === 0 ? tmp[i] : tmp[i] | 0x80);
    if (out.length > MAX_OID_BYTES) throw new DerError(`OID أطول من ${MAX_OID_BYTES} بايت`);
  };
  push(arcs[0] * BigInt(40) + arcs[1]);
  for (const a of arcs.slice(2)) push(a);
  return encTlv(TAG.OID, Uint8Array.from(out));
}

export function encUtf8String(s: string): Uint8Array {
  return encTlv(TAG.UTF8_STRING, Buffer.from(s, 'utf8'));
}

export function encPrintableString(s: string): Uint8Array {
  if (!PRINTABLE.test(s)) throw new DerError(`محارف غير مسموحة في PrintableString «${s}»`);
  return encTlv(TAG.PRINTABLE_STRING, Buffer.from(s, 'latin1'));
}

export function encIa5String(s: string): Uint8Array {
  if (!/^[\x00-\x7f]*$/.test(s)) throw new DerError('IA5String يقبل ASCII فقط');
  return encTlv(TAG.IA5_STRING, Buffer.from(s, 'latin1'));
}

export function encBitString(bytes: Uint8Array, unusedBits = 0): Uint8Array {
  if (!Number.isInteger(unusedBits) || unusedBits < 0 || unusedBits > 7 || (bytes.length === 0 && unusedBits)) throw new DerError('بتات غير مستعملة غير صالحة');
  if (unusedBits && (bytes[bytes.length - 1] & ((1 << unusedBits) - 1)) !== 0) throw new DerError('بتات الحشو يجب أن تكون صفراً');
  return encTlv(TAG.BIT_STRING, concat([Uint8Array.from([unusedBits]), bytes]));
}

export function encOctetString(bytes: Uint8Array): Uint8Array {
  return encTlv(TAG.OCTET_STRING, bytes);
}

export function encBoolean(b: boolean): Uint8Array {
  return encTlv(TAG.BOOLEAN, Uint8Array.from([b ? 0xff : 0x00]));
}

export function encNull(): Uint8Array {
  return encTlv(TAG.NULL, new Uint8Array(0));
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function timeDigits(d: Date): string {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) throw new DerError('تاريخ غير صالح');
  return `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** UTCTime للسنوات 1950–2049 (RFC 5280). */
export function encUtcTime(d: Date): Uint8Array {
  const y = d.getUTCFullYear();
  if (y < 1950 || y > 2049) throw new DerError(`UTCTime يغطي 1950–2049 فقط (${y})`);
  return encTlv(TAG.UTC_TIME, Buffer.from(pad(y % 100) + timeDigits(d), 'latin1'));
}

export function encGeneralizedTime(d: Date): Uint8Array {
  const y = d.getUTCFullYear();
  if (y < 0 || y > 9999) throw new DerError(`سنة خارج النطاق ${y}`);
  return encTlv(TAG.GENERALIZED_TIME, Buffer.from(pad(y, 4) + timeDigits(d), 'latin1'));
}

/** وسم سياقي [n]: مركّب (EXPLICIT أو IMPLICIT لنوع مركّب) يلفّ المحتوى، أو بدائي (IMPLICIT لقيمة بدائية). */
export function encContext(tagNumber: number, content: Uint8Array | Uint8Array[], constructed = true): Uint8Array {
  if (!Number.isInteger(tagNumber) || tagNumber < 0 || tagNumber > 30) throw new DerError(`رقم وسم سياقي غير مدعوم ${tagNumber}`);
  const value = Array.isArray(content) ? concat(content) : content;
  return encTlv(0x80 | (constructed ? 0x20 : 0) | tagNumber, value);
}
