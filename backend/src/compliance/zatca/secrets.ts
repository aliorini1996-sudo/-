// ============================================================================
// ZATCA المرحلة الثانية (Z4) — تشفير أسرار وحدات EGS (مفتاح التوقيع الخاص، وأسرار CSID) بمفتاح المنصّة
// ----------------------------------------------------------------------------
// قرار المالك D8: المنصّة تحفظ مفتاح توقيع كل شركة مشفّراً. هذا الملف نقيّ (بلا قاعدة بيانات ولا شبكة):
//   • AES-256-GCM، IV عشوائي 12 بايت، وسم مصادقة 16 بايت.
//   • صيغة ذاتية الوصف بإصدار: "v1:<kid>:<iv>:<tag>:<ct>" — الأجزاء الثلاثة base64url بلا حشو.
//   • بيانات مرتبطة (AAD) **إلزامية** تربط كل نصّ مشفّر بغرضه ومالكه: "zatca:<purpose>:<ownerId>"
//     (مثلاً zatca:egs-key:<unitId>)، ويُسبق بترويسة "v1:<kid>|" فالإصدار والمعرّف مصادَقان أيضاً.
//     فلا يُنقل نصّ مشفّر بين وحدتين أو بين غرضين (مفتاح ⇄ سرّ CSID) دون أن يفشل فكّه.
//   • حلقة مفاتيح: مفتاح حالي يُشفَّر به، ومفاتيح سابقة للفكّ فقط (تدوير بلا توقّف). kid = بصمة HMAC
//     للمفتاح نفسه (لا متغيّر بيئة إضافياً يُنسى أو يتعارض).
//   • FAIL CLOSED (بخلاف affiliate/core.ts): مفتاح مفقود أو قصير أو مشوّه أو بفراغات ⇒ خطأ، ولا اشتقاق ولا قيمة افتراضية.
//   • أخطاء بأكواد ثابتة (SecretsError.code)، ولا تحمل رسائلها نصاً صريحاً ولا مادة مفتاح ولا النصّ المشفّر.
//   • مقارنة الوسم تتمّ داخل OpenSSL (زمن ثابت)؛ لا مقارنة لبيانات سرّية في JavaScript.
//   • المخازن الوسيطة (مادة المفتاح المفكوكة، النصّ الصريح المحوَّل، ناتج الفكّ الجزئي) تُصفَّر بعد الاستعمال.
//     وكل مخزن يحمل نصاً صريحاً ويُعاد للمستدعي أو يُحوَّل من نصّ (ناتج الفكّ، ترميز النصّ الصريح) يُحجز مستقلاً
//     بـBuffer.alloc لا من مجمّع Node المشترك (8 KiB)؛ ما يبقى من المجمّع وسيط يعيش داخل استدعاء متزامن ويُصفَّر قبل عودته.
//     النصوص (string) في JavaScript غير قابلة للتصفير: من يستطيع فليستعمل decryptSecretBytes ويصفّر الناتج.
// ============================================================================

import crypto from 'crypto';

export const SECRETS_ENV_KEY = 'ZATCA_SECRETS_KEY';
/** مفاتيح سابقة للفكّ فقط أثناء التدوير: قائمة مفصولة بفواصل «,» (كل عنصر بصيغة المفتاح نفسها، بلا فراغات). */
export const SECRETS_ENV_PREVIOUS_KEYS = 'ZATCA_SECRETS_KEY_PREVIOUS';

export const SECRET_FORMAT_VERSION = 'v1';
export const SECRET_KEY_BYTES = 32;
export const SECRET_IV_BYTES = 12;
export const SECRET_TAG_BYTES = 16;
/** مفتاح PEM نحو 250 بايت وسرّ CSID نحو 44؛ السقف يمنع استعمال الوحدة مخزناً لبيانات كبيرة. */
export const MAX_SECRET_PLAINTEXT_BYTES = 64 * 1024;
/** أطول نصّ مخزَّن مقبول قبل أي تحليل: ترويسة + base64url لأكبر نصّ صريح. */
export const MAX_STORED_SECRET_CHARS = 256 + Math.ceil((MAX_SECRET_PLAINTEXT_BYTES * 4) / 3);
/** أقصى عدد مفاتيح في الحلقة (الحالي + السابقة). */
export const MAX_KEYRING_KEYS = 16;

export type SecretsErrorCode =
  | 'KEY_MISSING' | 'KEY_MALFORMED' | 'KEY_LENGTH' | 'KEY_WEAK' | 'KEYRING_INVALID'
  | 'CONTEXT_INVALID' | 'PLAINTEXT_INVALID'
  | 'FORMAT_INVALID' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_KEY_ID' | 'DECRYPT_FAILED';

/** كل ما يرميه هذا الملف. الرسالة لا تحمل أبداً مفتاحاً أو نصاً صريحاً أو نصاً مشفّراً — ولا cause من OpenSSL. */
export class SecretsError extends Error {
  readonly code: SecretsErrorCode;
  constructor(code: SecretsErrorCode, message: string) {
    super(`ZATCA_SECRETS ${code}: ${message}`);
    this.name = 'SecretsError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// سياق الربط (AAD)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * أغراض الأسرار المعروفة (قائمة مغلقة: غرض جديد يُضاف هنا صراحةً).
 *   egs-key          مفتاح التوقيع الخاص للوحدة (PEM)
 *   egs-key-pending  مفتاح جديد مولَّد أثناء التجديد قبل تبديل الاعتماد (design §3 Z4 renewUnit خطوة 3)
 *   ccsid-secret     سرّ شهادة الامتثال
 *   pcsid-secret     سرّ شهادة الإنتاج
 */
export type SecretPurpose = 'egs-key' | 'egs-key-pending' | 'ccsid-secret' | 'pcsid-secret';
export const SECRET_PURPOSES: readonly SecretPurpose[] = Object.freeze(['egs-key', 'egs-key-pending', 'ccsid-secret', 'pcsid-secret'] as SecretPurpose[]);

export interface SecretContext {
  purpose: SecretPurpose;
  /** معرّف المالك (عادةً معرّف وحدة EGS: cuid أو uuid). بلا «:» كي يبقى الترميز غير ملتبس. */
  ownerId: string;
}

const OWNER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function checkedContext(ctx: unknown): SecretContext {
  if (!ctx || typeof ctx !== 'object') throw new SecretsError('CONTEXT_INVALID', 'سياق الربط مفقود (purpose وownerId إلزاميان)');
  const { purpose, ownerId } = ctx as Partial<SecretContext>;
  if (typeof purpose !== 'string' || !(SECRET_PURPOSES as readonly string[]).includes(purpose)) {
    throw new SecretsError('CONTEXT_INVALID', `غرض غير معروف — المسموح: ${SECRET_PURPOSES.join('، ')}`);
  }
  if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) {
    throw new SecretsError('CONTEXT_INVALID', 'معرّف المالك يجب أن يكون 1–128 محرفاً من [A-Za-z0-9_-]');
  }
  return { purpose: purpose as SecretPurpose, ownerId };
}

/** نصّ الربط المنطقي لسياق: "zatca:<purpose>:<ownerId>". */
export function secretAad(ctx: SecretContext): string {
  const c = checkedContext(ctx);
  return `zatca:${c.purpose}:${c.ownerId}`;
}

/** AAD الفعلي لـGCM: الترويسة (الإصدار والمعرّف) + سياق الربط. */
function gcmAad(version: string, kid: string, ctx: SecretContext): Buffer {
  return Buffer.from(`${version}:${kid}|${secretAad(ctx)}`, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// المفاتيح وحلقة المفاتيح
// ─────────────────────────────────────────────────────────────────────────────

/** مادة مفتاح: 32 بايت خام، أو نصّ hex بـ64 محرفاً، أو base64 قانوني (44 محرفاً بحشو) أو base64url (43 بلا حشو). */
export type SecretKeyMaterial = Uint8Array | string;

export interface SecretKeyringInput {
  current: SecretKeyMaterial;
  previous?: readonly SecretKeyMaterial[];
}

/**
 * حلقة مفاتيح معتمة: لا تُعرِض مادة المفاتيح عبر خصائصها (JSON.stringify/util.inspect يُظهران المعرّفات فقط).
 * المفاتيح نفسها في WeakMap خاصّة بهذه الوحدة، ككائنات KeyObject.
 */
export interface SecretKeyring {
  readonly currentKid: string;
  readonly kids: readonly string[];
}

const KEYRINGS = new WeakMap<object, ReadonlyMap<string, crypto.KeyObject>>();

const zeroize = (b: Uint8Array | null | undefined) => { if (b) b.fill(0); };

/**
 * مخزن مستقل لبيانات سرّية: Buffer.alloc يحجز ArrayBuffer خاصاً بالطول نفسه ولا يستعمل مجمّع Node المشترك (8 KiB).
 * Buffer.concat وBuffer.from(نص/مصفوفة) وBuffer.allocUnsafe تقتطع ما دون 4 KiB من ذلك المجمّع، فيشارك المفتاح المفكوك
 * ArrayBuffer واحداً مع مخازن صغيرة لا علاقة لها به: أي كود يسلسل someBuffer.buffer يكشفه، ويبقى حيّاً ما بقيت أي شريحة
 * أخرى من المجمّع. التصفير يمحو البايتات، لكن العزل لازم للمدة بين الفكّ والتصفير (انتظار الشبكة أثناء الربط).
 */
function isolatedConcat(parts: readonly Uint8Array[]): Buffer {
  const out = Buffer.alloc(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** ترميز UTF-8 في مخزن مستقل (لا مجمّع مشترك). */
function isolatedUtf8(s: string): Buffer {
  const out = Buffer.alloc(Buffer.byteLength(s, 'utf8'));
  out.write(s, 0, 'utf8');
  return out;
}

const b64u = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64url');

/** يفكّ مادة مفتاح نصّية إلى Buffer جديد (يصفّره المستدعي). label اسم المصدر في الرسائل، لا القيمة أبداً. */
function decodeKeyText(text: string, label: string): Buffer {
  if (text.length === 0) throw new SecretsError('KEY_MISSING', `${label}: المفتاح فارغ`);
  if (text.length > 256) throw new SecretsError('KEY_MALFORMED', `${label}: نصّ المفتاح أطول من المعقول`);
  // فراغات في أي موضع (سطر جديد ملصوق، مسافة زائدة) ⇒ رفض لا قصّ: لا نخمّن ما قصده المشغّل
  if (/\s/.test(text)) throw new SecretsError('KEY_MALFORMED', `${label}: المفتاح يحتوي فراغاً أو سطراً جديداً — أزِله`);
  if (/^[0-9a-fA-F]+$/.test(text)) {
    if (text.length !== SECRET_KEY_BYTES * 2) {
      throw new SecretsError('KEY_LENGTH', `${label}: مفتاح hex يجب أن يكون ${SECRET_KEY_BYTES * 2} محرفاً (${SECRET_KEY_BYTES} بايت)، والمُعطى ${text.length} محرفاً`);
    }
    return Buffer.from(text, 'hex');
  }
  let buf: Buffer;
  if (/^[A-Za-z0-9_-]+$/.test(text)) {
    // بلا حشو ولا «+/»: base64url (نصّ أبجدي رقمي بحت بطول 43 هو ترميز base64url القانوني نفسه لـ32 بايت)
    buf = Buffer.from(text, 'base64url');
    if (buf.toString('base64url') !== text) { zeroize(buf); throw new SecretsError('KEY_MALFORMED', `${label}: base64url غير قانوني`); }
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    if (text.length % 4 !== 0) throw new SecretsError('KEY_MALFORMED', `${label}: base64 بحشو ناقص`);
    buf = Buffer.from(text, 'base64');
    if (buf.toString('base64') !== text) { zeroize(buf); throw new SecretsError('KEY_MALFORMED', `${label}: base64 غير قانوني`); }
  } else {
    throw new SecretsError('KEY_MALFORMED', `${label}: المفتاح ليس hex ولا base64 ولا base64url`);
  }
  if (buf.length !== SECRET_KEY_BYTES) {
    const n = buf.length;
    zeroize(buf);
    throw new SecretsError('KEY_LENGTH', `${label}: المفتاح يجب أن يكون ${SECRET_KEY_BYTES} بايت، والمُعطى ${n} بايت`);
  }
  return buf;
}

/** KeyObject من مادة مفتاح؛ كل مخزن وسيط يُصفَّر. مخزن المستدعي (Uint8Array) لا يُمسّ. */
function importKey(material: unknown, label: string): { key: crypto.KeyObject; kid: string } {
  let raw: Buffer;
  if (typeof material === 'string') {
    raw = decodeKeyText(material, label);
  } else if (material instanceof Uint8Array) {
    if (material.length !== SECRET_KEY_BYTES) {
      throw new SecretsError('KEY_LENGTH', `${label}: المفتاح يجب أن يكون ${SECRET_KEY_BYTES} بايت، والمُعطى ${material.length} بايت`);
    }
    raw = Buffer.from(material); // نسخة نملكها فنصفّرها
  } else if (material === undefined || material === null) {
    throw new SecretsError('KEY_MISSING', `${label}: المفتاح مفقود`);
  } else {
    throw new SecretsError('KEY_MALFORMED', `${label}: المفتاح يجب أن يكون نصاً أو Uint8Array`);
  }
  try {
    // مفتاح كل بايتاته متساوية (أصفار، أو "0000…" ملصوق كقيمة مؤقتة) خطأ تشغيل واضح لا مفتاح
    if (raw.every(b => b === raw[0])) throw new SecretsError('KEY_WEAK', `${label}: المفتاح ضعيف (كل البايتات متساوية) — ولّد 32 بايتاً عشوائية`);
    const key = crypto.createSecretKey(raw);
    return { key, kid: kidOf(key) };
  } finally {
    zeroize(raw);
  }
}

/** kid = base64url لأول 12 بايت من HMAC-SHA256(المفتاح، سياق ثابت): بصمة لا تكشف شيئاً عن المفتاح. */
function kidOf(key: crypto.KeyObject): string {
  const mac = crypto.createHmac('sha256', key).update('zatca-secrets:kid:v1', 'utf8').digest();
  try {
    return mac.subarray(0, 12).toString('base64url');
  } finally {
    zeroize(mac);
  }
}

/** معرّف المفتاح (kid) كما يُكتب في النصّ المشفّر — للتشغيل والمراقبة (أيّ مفتاح يلزم إبقاؤه). */
export function keyIdFor(material: SecretKeyMaterial): string {
  return importKey(material, 'key').kid;
}

/** يبني حلقة مفاتيح من مواد صريحة. مفتاحان مختلفان بالمعرّف نفسه ⇒ KEYRING_INVALID؛ المفتاح نفسه مكرّراً يُتجاهل. */
export function createKeyring(input: SecretKeyringInput): SecretKeyring {
  if (!input || typeof input !== 'object') throw new SecretsError('KEY_MISSING', 'مدخلات حلقة المفاتيح مفقودة');
  return buildKeyring(input.current, input.previous ?? [], 'current', 'previous');
}

function buildKeyring(currentMaterial: unknown, previous: unknown, currentLabel: string, previousLabel: string): SecretKeyring {
  if (!Array.isArray(previous)) throw new SecretsError('KEYRING_INVALID', `${previousLabel} يجب أن تكون مصفوفة`);
  if (previous.length + 1 > MAX_KEYRING_KEYS) throw new SecretsError('KEYRING_INVALID', `حلقة المفاتيح أكبر من ${MAX_KEYRING_KEYS} مفتاحاً`);
  const current = importKey(currentMaterial, currentLabel);
  const map = new Map<string, crypto.KeyObject>([[current.kid, current.key]]);
  previous.forEach((m: unknown, i: number) => {
    const k = importKey(m, `${previousLabel}[${i}]`);
    const existing = map.get(k.kid);
    if (existing) {
      // المعرّف نفسه لمفتاح مختلف (تصادم 96 بت — عملياً مستحيل) ⇒ رفض؛ المفتاح نفسه مكرّراً ⇒ يُتجاهل
      if (!existing.equals(k.key)) throw new SecretsError('KEYRING_INVALID', `تصادم معرّف مفتاح ${k.kid}`);
      return;
    }
    map.set(k.kid, k.key);
  });
  const ring: SecretKeyring = Object.freeze({ currentKid: current.kid, kids: Object.freeze([...map.keys()]) });
  KEYRINGS.set(ring, map);
  return ring;
}

/**
 * يقرأ ZATCA_SECRETS_KEY (إلزامي) وZATCA_SECRETS_KEY_PREVIOUS (اختياري) من كائن بيئة **مُمرَّر** (لا process.env
 * ضمنياً — فالاختبار والتشغيل صريحان). FAIL CLOSED: أي خلل يرمي، ولا مفتاح مشتقّ أو افتراضي.
 * PREVIOUS فارغة أو غائبة = لا مفاتيح سابقة؛ عنصر فارغ داخلها («a,,b») أو مشوّه ⇒ خطأ.
 */
export function keyringFromEnv(env: Readonly<Record<string, string | undefined>>): SecretKeyring {
  if (!env || typeof env !== 'object') throw new SecretsError('KEY_MISSING', `${SECRETS_ENV_KEY}: كائن البيئة مفقود`);
  const current = env[SECRETS_ENV_KEY];
  if (current === undefined || current === '') throw new SecretsError('KEY_MISSING', `${SECRETS_ENV_KEY} غير مضبوط — التشفير معطّل (fail closed)`);
  if (typeof current !== 'string') throw new SecretsError('KEY_MALFORMED', `${SECRETS_ENV_KEY} ليس نصاً`);
  const prevRaw = env[SECRETS_ENV_PREVIOUS_KEYS];
  if (prevRaw !== undefined && typeof prevRaw !== 'string') throw new SecretsError('KEY_MALFORMED', `${SECRETS_ENV_PREVIOUS_KEYS} ليس نصاً`);
  const previous = prevRaw === undefined || prevRaw === '' ? [] : prevRaw.split(',');
  previous.forEach((p, i) => {
    if (p === '') throw new SecretsError('KEY_MALFORMED', `${SECRETS_ENV_PREVIOUS_KEYS}[${i}]: عنصر فارغ في القائمة`);
  });
  return buildKeyring(current, previous, SECRETS_ENV_KEY, SECRETS_ENV_PREVIOUS_KEYS);
}

function keysOf(keyring: unknown): ReadonlyMap<string, crypto.KeyObject> {
  const map = keyring && typeof keyring === 'object' ? KEYRINGS.get(keyring) : undefined;
  if (!map) throw new SecretsError('KEYRING_INVALID', 'حلقة المفاتيح غير صالحة — استعمل createKeyring أو keyringFromEnv');
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// التشفير والفكّ
// ─────────────────────────────────────────────────────────────────────────────

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function encryptWith(plain: Uint8Array, ctx: SecretContext, kid: string, key: crypto.KeyObject): string {
  const iv = crypto.randomBytes(SECRET_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: SECRET_TAG_BYTES });
  cipher.setAAD(gcmAad(SECRET_FORMAT_VERSION, kid, ctx));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_FORMAT_VERSION}:${kid}:${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`;
}

/** يشفّر نصاً (UTF-8) أو بايتات بالمفتاح الحالي ويربطه بالسياق. مخزن المستدعي لا يُعدَّل. */
export function encryptSecret(plaintext: string | Uint8Array, ctx: SecretContext, keyring: SecretKeyring): string {
  const keys = keysOf(keyring);
  const c = checkedContext(ctx);
  let owned: Buffer | null = null;
  let plain: Uint8Array;
  if (typeof plaintext === 'string') {
    // بديل منفرد يُستبدل صامتاً بـU+FFFD عند الترميز ⇒ الفكّ يعيد نصاً آخر: رفض بدل تغيير السرّ
    if (LONE_SURROGATE.test(plaintext)) throw new SecretsError('PLAINTEXT_INVALID', 'النصّ الصريح يحتوي بديلاً UTF-16 منفرداً');
    owned = isolatedUtf8(plaintext);
    plain = owned;
  } else if (plaintext instanceof Uint8Array) {
    plain = plaintext;
  } else {
    throw new SecretsError('PLAINTEXT_INVALID', 'النصّ الصريح يجب أن يكون نصاً أو Uint8Array');
  }
  try {
    if (plain.length === 0) throw new SecretsError('PLAINTEXT_INVALID', 'النصّ الصريح فارغ');
    if (plain.length > MAX_SECRET_PLAINTEXT_BYTES) throw new SecretsError('PLAINTEXT_INVALID', `النصّ الصريح أكبر من ${MAX_SECRET_PLAINTEXT_BYTES} بايت`);
    return encryptWith(plain, c, keyring.currentKid, keys.get(keyring.currentKid)!);
  } finally {
    zeroize(owned);
  }
}

export interface StoredSecretHeader {
  version: string;
  kid: string;
}

interface ParsedStored extends StoredSecretHeader {
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

function decodeB64u(s: string, what: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new SecretsError('FORMAT_INVALID', `${what} ليس base64url`);
  const b = Buffer.from(s, 'base64url');
  if (b.toString('base64url') !== s) throw new SecretsError('FORMAT_INVALID', `${what} ليس base64url قانونياً`);
  return b;
}

function parseStored(stored: unknown): ParsedStored {
  if (typeof stored !== 'string') throw new SecretsError('FORMAT_INVALID', 'القيمة المخزّنة ليست نصاً');
  if (stored.length === 0 || stored.length > MAX_STORED_SECRET_CHARS) throw new SecretsError('FORMAT_INVALID', 'طول القيمة المخزّنة خارج المدى');
  const parts = stored.split(':');
  const version = parts[0];
  if (version !== SECRET_FORMAT_VERSION) {
    if (/^v[0-9]{1,4}$/.test(version)) throw new SecretsError('UNSUPPORTED_VERSION', `إصدار الصيغة ${version} غير مدعوم`);
    throw new SecretsError('FORMAT_INVALID', 'القيمة المخزّنة لا تبدأ بإصدار صيغة معروف');
  }
  if (parts.length !== 5) throw new SecretsError('FORMAT_INVALID', `عدد الأجزاء ${parts.length} بدل 5`);
  const [, kid, ivS, tagS, ctS] = parts;
  if (!KID_RE.test(kid)) throw new SecretsError('FORMAT_INVALID', 'معرّف المفتاح غير صالح');
  const iv = decodeB64u(ivS, 'IV');
  if (iv.length !== SECRET_IV_BYTES) throw new SecretsError('FORMAT_INVALID', `IV يجب أن يكون ${SECRET_IV_BYTES} بايت`);
  const tag = decodeB64u(tagS, 'وسم المصادقة');
  if (tag.length !== SECRET_TAG_BYTES) throw new SecretsError('FORMAT_INVALID', `وسم المصادقة يجب أن يكون ${SECRET_TAG_BYTES} بايت`);
  const ct = decodeB64u(ctS, 'النصّ المشفّر');
  if (ct.length > MAX_SECRET_PLAINTEXT_BYTES) throw new SecretsError('FORMAT_INVALID', 'النصّ المشفّر أكبر من الحدّ');
  return { version, kid, iv, tag, ct };
}

/** الترويسة العامة (الإصدار والمعرّف) بلا فكّ — لمعرفة المفتاح المطلوب أثناء التدوير. */
export function inspectStoredSecret(stored: string): StoredSecretHeader {
  const { version, kid } = parseStored(stored);
  return { version, kid };
}

/**
 * يفكّ ويعيد البايتات في Buffer جديد يملكه المستدعي (وعليه تصفيره بعد الاستعمال). المخزن مستقل: ArrayBuffer خاص بطول
 * الناتج بالضبط (byteOffset = 0)، لا شريحة من مجمّع Node المشترك — فلا يكشفه .buffer لمخزن آخر.
 * مفتاح غير موجود ⇒ UNKNOWN_KEY_ID؛ مفتاح خاطئ أو سياق مختلف أو عبث بأي بايت ⇒ DECRYPT_FAILED (رسالة واحدة لا تميّز بينها).
 */
export function decryptSecretBytes(stored: string, ctx: SecretContext, keyring: SecretKeyring): Buffer {
  const keys = keysOf(keyring);
  const c = checkedContext(ctx);
  const p = parseStored(stored);
  const key = keys.get(p.kid);
  if (!key) throw new SecretsError('UNKNOWN_KEY_ID', `لا مفتاح بالمعرّف ${p.kid} في الحلقة — هل أُزيل مفتاح سابق قبل إعادة التشفير؟`);
  let partial: Buffer | null = null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, p.iv, { authTagLength: SECRET_TAG_BYTES });
    decipher.setAAD(gcmAad(p.version, p.kid, c));
    decipher.setAuthTag(p.tag);
    // GCM يُخرج update() قبل التحقق من الوسم في final(): الناتج الجزئي يُصفَّر إن فشل التحقق
    partial = decipher.update(p.ct);
    const tail = decipher.final();
    const out = isolatedConcat([partial, tail]);
    zeroize(partial);
    zeroize(tail);
    partial = null;
    return out;
  } catch {
    zeroize(partial);
    throw new SecretsError('DECRYPT_FAILED', 'تعذّر فكّ القيمة المخزّنة (مفتاح خاطئ أو سياق ربط مختلف أو بيانات معدَّلة)');
  }
}

/** يفكّ إلى نصّ UTF-8 صالح. المخزن الوسيط يُصفَّر؛ النصّ الناتج نفسه لا يمكن تصفيره في JavaScript. */
export function decryptSecret(stored: string, ctx: SecretContext, keyring: SecretKeyring): string {
  const bytes = decryptSecretBytes(stored, ctx, keyring);
  let back: Buffer | null = null;
  try {
    const s = bytes.toString('utf8');
    // بايتات شُفّرت كـUint8Array وليست UTF-8 صالحاً ⇒ رفض بدل إعادة نصّ مشوّه بـU+FFFD
    back = isolatedUtf8(s);
    if (!back.equals(bytes)) throw new SecretsError('PLAINTEXT_INVALID', 'القيمة المفكوكة ليست نصاً UTF-8 صالحاً — استعمل decryptSecretBytes');
    return s;
  } finally {
    zeroize(bytes);
    zeroize(back);
  }
}

/** هل النصّ المشفّر بمفتاح غير الحالي (فيُعاد تشفيره قبل إزالة المفتاح القديم من البيئة)؟ */
export function needsReencryption(stored: string, keyring: SecretKeyring): boolean {
  keysOf(keyring);
  return parseStored(stored).kid !== keyring.currentKid;
}

/** يعيد التشفير بالمفتاح الحالي (بعد التحقق الكامل بالسياق نفسه). القيمة الحالية تُعاد كما هي إن كانت بالمفتاح الحالي. */
export function reencryptSecret(stored: string, ctx: SecretContext, keyring: SecretKeyring): { stored: string; rotated: boolean } {
  const keys = keysOf(keyring);
  const bytes = decryptSecretBytes(stored, ctx, keyring);
  try {
    if (parseStored(stored).kid === keyring.currentKid) return { stored, rotated: false };
    return { stored: encryptWith(bytes, checkedContext(ctx), keyring.currentKid, keys.get(keyring.currentKid)!), rotated: true };
  } finally {
    zeroize(bytes);
  }
}
