// ============================================================================
// إشعارات الويب (Web Push) لتطبيق المندوب — تنبيهات الحضور (طلب المالك، ٢١ أكتوبر ٢٠٢٦).
//
// بلا مكتبة خارجية: تشفير الرسالة وفق RFC 8291 (aes128gcm) وتوقيع VAPID وفق RFC 8292، بـcrypto في Node وحده —
// واختبار tests/web-push.test.ts يطابق المثال الرسمي في RFC 8291 (الملحق A) حرفاً حرفاً.
//
// مفاتيح VAPID: من متغيّرَي البيئة VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY إن وُجدا، وإلّا تُولَّد مرّةً وتُحفظ في
// ops_markers (المفتاح vapid:v1) — فلا يلزم إعدادٌ يدويّ على الخادم، والمفتاح العامّ ثابتٌ فلا تسقط الاشتراكات بإعادة التشغيل.
// ============================================================================
import crypto from 'crypto';
import prisma from '../config/database';

const b64u = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export interface VapidKeys { publicKey: string; privateKey: string }
export interface PushSub { endpoint: string; p256dh: string; auth: string }

/** حجم السجلّ في ترويسة aes128gcm — الرسالة القصيرة سجلٌّ واحد */
const RECORD_SIZE = 4096;

/**
 * تشفير رسالة إشعار (RFC 8291): ECDH مع مفتاح المتصفّح + سرّ المصادقة ⇒ مفتاح المحتوى والـnonce، ثمّ AES-128-GCM
 * لسجلٍّ واحد بفاصل 0x02. `fixed` للاختبار وحده (مفتاح الخادم المؤقّت والملح من المثال الرسمي).
 */
export function encryptPushPayload(plaintext: Buffer, uaPublicB64: string, authSecretB64: string, fixed?: { asPrivate: Buffer; salt: Buffer }): Buffer {
  const uaPublic = unb64u(uaPublicB64);
  const authSecret = unb64u(authSecretB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('مفتاح المتصفّح غير صالح');
  if (authSecret.length < 16) throw new Error('سرّ المصادقة غير صالح');
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const salt = fixed ? fixed.salt : crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** مفتاحا اشتراكٍ يصلحان للتشفير: نقطةٌ على المنحنى (٦٥ بايتاً تبدأ بـ0x04) وسرّ مصادقة ١٦ بايتاً — يُفحص عند الاشتراك لا عند الإرسال */
export function pushKeysValid(p256dh: string, auth: string): boolean {
  try {
    const pub = unb64u(p256dh);
    if (pub.length !== 65 || pub[0] !== 0x04 || unb64u(auth).length !== 16) return false;
    const probe = crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pub); // يرمي لنقطةٍ خارج المنحنى
    return true;
  } catch {
    return false;
  }
}

/** ترويسة Authorization بتوقيع VAPID (RFC 8292): JWT بـES256 لجمهور خدمة الإشعارات، صالحٌ ١٢ ساعة */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(Buffer.from(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })));
  const pub = unb64u(keys.publicKey);
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** زوج مفاتيح VAPID جديد (P-256): العامّ ٦٥ بايتاً غير مضغوط، والخاصّ ٣٢ — بـbase64url */
export function generateVapidKeys(): VapidKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

const VAPID_MARKER = 'vapid:v1';
let cached: VapidKeys | null = null;

/** مفاتيح VAPID: البيئة أولاً، ثمّ المحفوظة، وإلّا تُولَّد وتُحفظ (الإنشاء الفريد قفلٌ: نسختان متزامنتان تتّفقان على واحد) */
export async function getVapidKeys(): Promise<VapidKeys> {
  if (cached) return cached;
  const envPub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const envPriv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (envPub && envPriv) return (cached = { publicKey: envPub, privateKey: envPriv });
  const read = async () => {
    const row = await prisma.opsMarker.findUnique({ where: { key: VAPID_MARKER } });
    if (!row) return null;
    try { const k = JSON.parse(row.value) as VapidKeys; return k.publicKey && k.privateKey ? k : null; } catch { return null; }
  };
  const existing = await read();
  if (existing) return (cached = existing);
  const fresh = generateVapidKeys();
  try {
    await prisma.opsMarker.create({ data: { key: VAPID_MARKER, value: JSON.stringify(fresh) } });
    return (cached = fresh);
  } catch {
    const won = await read();
    if (!won) throw new Error('تعذّر تهيئة مفاتيح الإشعارات');
    return (cached = won);
  }
}

/**
 * خدمات الإشعارات المعروفة وحدها — الخادم يرسل إلى رابطٍ يقدّمه الجوال، فرابطٌ داخليّ (localhost، عناوين البيانات
 * الوصفية للسحابة) كان سيجعل الخادم يطلب ما لا يجوز (SSRF). https وأسماء المزوّدين الكبار فقط.
 */
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function pushEndpointAllowed(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

/** نتيجة الإرسال: gone = الاشتراك منتهٍ (404/410) فيُحذف */
export type PushResult = 'sent' | 'gone' | 'failed';

/** يرسل رسالةً لاشتراكٍ واحد — مهلة ١٠ ثوانٍ، والرسالة تبقى لدى المزوّد ساعة إن كان الجوال مطفأ */
export async function sendPush(sub: PushSub, payload: object, opts: { ttlSec?: number } = {}): Promise<PushResult> {
  if (!pushEndpointAllowed(sub.endpoint)) return 'gone';
  const keys = await getVapidKeys();
  let body: Buffer;
  try {
    body = encryptPushPayload(Buffer.from(JSON.stringify(payload), 'utf8'), sub.p256dh, sub.auth);
  } catch {
    return 'gone'; // مفتاحٌ فاسد لا يُشفَّر له أبداً: يُحذف الاشتراك، ولا يوقف استثناؤه دورة التنبيهات لكل الشركات
  }
  const subject = (process.env.VAPID_SUBJECT || 'mailto:support@fieldsa.net').trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(sub.endpoint, keys, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttlSec ?? 3600),
        Urgency: 'high',
      },
      body,
      signal: ctrl.signal,
    });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

/** يرسل لكل اشتراكات المندوب ويحذف المنتهية — يعيد عدد ما وصل */
export async function sendPushToRep(salesRepId: string, payload: object): Promise<number> {
  const subs = await prisma.repPushSubscription.findMany({ where: { salesRepId }, select: { id: true, endpoint: true, p256dh: true, auth: true } });
  let sent = 0;
  for (const s of subs) {
    const r = await sendPush(s, payload);
    if (r === 'sent') sent++;
    else if (r === 'gone') await prisma.repPushSubscription.delete({ where: { id: s.id } }).catch(() => { /* حُذف للتوّ */ });
  }
  return sent;
}
