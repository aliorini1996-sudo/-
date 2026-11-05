// ============================================================================
// إشعارات آيفون (APNs) لتطبيق المندوب الأصلي — «أثبت تواجدك» وتنبيهات الحضور (طلب المالك، ٤ نوفمبر ٢٠٢٦).
//
// تطبيق الآيفون غلافٌ لصفحة /rep لا يصله Web Push، فيأخذ رمز جهازه من Apple (جسر fsPush) ويحفظه الخادم في جدول
// rep_push_subscriptions نفسه بعنوان apns:<البيئة>:<الرمز> (p256dh وauth فارغان) — وwebPush.sendPush يحوّله إلى هنا،
// فيصله ما يصل أندرويد والويب بلا تغييرٍ في دورتي التنبيهات (presenceChecks.ts وattendanceAlerts.ts).
//
// بلا مكتبة خارجية: HTTP/2 من Node (http2) ورمز المزوّد JWT بتوقيع ES256 من crypto. الإعداد من متغيّرات البيئة وحدها:
// APNS_KEY_P8 وAPNS_KEY_ID وAPNS_TEAM_ID (وAPNS_TOPIC اختياراً) — بلا أحدها الإرسال خامل (failed لا gone) والاشتراكات
// باقية حتى يُضاف المفتاح. لا يُسجَّل المفتاح ولا الـJWT ولا رمز جهازٍ كاملاً أبداً.
// الاستيراد بلا أثر: لا قراءة للبيئة ولا اتصال قبل أوّل إرسال (اختبارات المسارات تحمّل هذا الملف حقيقياً).
// ============================================================================
import crypto from 'crypto';
import http2 from 'http2';
import type { PushResult } from './webPush';

export type ApnsEnv = 'production' | 'sandbox';
export const APNS_PREFIX = 'apns:';
const ORIGINS: Record<ApnsEnv, string> = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
/** للاختبار وحده: خادم HTTP/2 محلّي بلا TLS (h2c) — لا يُقرأ من البيئة أبداً */
let originOverride: Partial<Record<ApnsEnv, string>> = {};

export const APNS_DEFAULT_TOPIC = 'net.fieldsa.rep';
export const APNS_TIMEOUT_MS = 10_000;
/** عمر رمز المزوّد: Apple تشترط تجديده بين ٢٠ و٦٠ دقيقة */
export const APNS_JWT_REFRESH_MS = 50 * 60_000;
export const APNS_JWT_MIN_AGE_MS = 20 * 60_000;
export const APNS_IDLE_CLOSE_MS = 15 * 60_000;
export const APNS_CONFIG_COOLDOWN_MS = 15 * 60_000;
export const APNS_MAX_PAYLOAD = 4096;
/** صوت «أثبت تواجدك» داخل حزمة التطبيق (FieldSales/presence-alarm.wav، ٢٨ ثانية — أقلّ من حدّ Apple ٣٠ ثانية) */
export const PRESENCE_SOUND = 'presence-alarm.wav';
/** أعطال شبكةٍ متتالية (مهلة/اتصال) تُبرِّد البيئة دقيقتين: دورة «أثبت تواجدك» تُرسل بالتتابع، فخادمٌ معلّق لا يحبسها ١٠ ثوانٍ لكل طلب */
export const APNS_NET_FAILS = 3;
export const APNS_NET_COOLDOWN_MS = 2 * 60_000;
const netFails = new Map<ApnsEnv, number>();
let timeoutMs = APNS_TIMEOUT_MS;

// ─── عنوان الاشتراك المخزَّن في RepPushSubscription.endpoint ───
/** رمز الجهاز: ست عشريّ صغير زوجيّ الطول ٦٤–٢٠٠ — Apple: «لا تفترض طول الرمز» فلا ٦٤ حرفاً حصراً */
export const APNS_TOKEN_RE = /^(?:[0-9a-f]{2}){32,100}$/;
export function apnsTokenValid(token: unknown): token is string {
  return typeof token === 'string' && APNS_TOKEN_RE.test(token);
}
export const isApnsEndpoint = (endpoint: unknown): boolean => typeof endpoint === 'string' && endpoint.startsWith(APNS_PREFIX);
export function apnsEndpoint(env: ApnsEnv, token: string): string { return `${APNS_PREFIX}${env}:${token.toLowerCase()}`; }
export function parseApnsEndpoint(endpoint: string): { env: ApnsEnv; token: string } | null {
  const m = /^apns:(production|sandbox):([0-9a-f]+)$/.exec(endpoint);
  return m && apnsTokenValid(m[2]) ? { env: m[1] as ApnsEnv, token: m[2] } : null;
}

// ─── الإعداد من البيئة وحدها ───
export interface ApnsConfig { keyId: string; teamId: string; topic: string; key: crypto.KeyObject; fp: string }

/**
 * المفتاح الخاصّ: نصّ PEM، أو base64 لنصّ PEM، أو base64 لـDER (PKCS#8) — و«\n» الحرفية (متغيّرٌ بسطرٍ واحد) تُفكّ،
 * وعلامتا اقتباسٍ حول القيمة (لصقٌ من ملفّ env) تُزالان. منحنى P-256 وحده (ES256)، وغيره null.
 */
export function parseP8(raw: string): crypto.KeyObject | null {
  try {
    const v = raw.trim().replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/\\r/g, '').replace(/\\n/g, '\n').trim();
    if (!v) return null;
    let key: crypto.KeyObject;
    if (v.includes('-----BEGIN')) key = crypto.createPrivateKey({ key: v, format: 'pem' });
    else {
      const buf = Buffer.from(v.replace(/\s+/g, ''), 'base64');
      const txt = buf.toString('utf8');
      key = txt.includes('-----BEGIN') ? crypto.createPrivateKey({ key: txt, format: 'pem' }) : crypto.createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' });
    }
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch { return null; }
}

let cfgCache: { sig: string; cfg: ApnsConfig | null } | null = null;
let cfgWarned = false;
/** الإعداد من البيئة (بصمةٌ تُخزَّن لا المفتاح نفسه، فلا يُفكّ المفتاح عند كل إرسال) — null = خامل */
export function apnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const raw = (env.APNS_KEY_P8 || '').trim();
  const keyId = (env.APNS_KEY_ID || '').trim();
  const teamId = (env.APNS_TEAM_ID || '').trim();
  const topic = (env.APNS_TOPIC || '').trim() || APNS_DEFAULT_TOPIC;
  const fp = crypto.createHash('sha256').update(raw).digest('hex');
  const sig = `${fp}:${keyId}:${teamId}:${topic}`;
  if (cfgCache?.sig === sig) return cfgCache.cfg;
  let cfg: ApnsConfig | null = null;
  if (raw || keyId || teamId) {
    const key = raw && keyId && teamId ? parseP8(raw) : null;
    if (key && /^[A-Z0-9]{10}$/.test(keyId) && /^[A-Z0-9]{10}$/.test(teamId) && /^[A-Za-z0-9.-]{1,200}$/.test(topic)) cfg = { keyId, teamId, topic, key, fp };
    // ضُبط بعضه أو كلّه ولا يصلح: سطرٌ واحد في السجلّ (بلا القيم)، والإرسال خامل كأنه غير مضبوط
    else if (!cfgWarned) { cfgWarned = true; console.error('apns: إعداد غير صالح (المفتاح أو المعرّفات أو الموضوع) — إشعارات الآيفون معطّلة'); }
  }
  cfgCache = { sig, cfg };
  return cfg;
}
export const apnsConfigured = (): boolean => apnsConfigFromEnv() != null;

// ─── رمز المزوّد (JWT) ───
const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
export function apnsProviderToken(cfg: Pick<ApnsConfig, 'keyId' | 'teamId' | 'key'>, iatSec: number): string {
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const claims = b64u(JSON.stringify({ iss: cfg.teamId, iat: iatSec }));
  // r||s بطول ٦٤ بايتاً (IEEE P1363) كما يشترط JWS — لا DER الافتراضي في Node
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: cfg.key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${claims}.${b64u(sig)}`;
}
let jwt: { token: string; at: number; keyId: string; teamId: string; fp: string } | null = null;
let jwtNow = (): number => Date.now();
/**
 * الرمز نفسه يُعاد ٥٠ دقيقة (تجديده أكثر من مرّةٍ كل ٢٠ دقيقة = TooManyProviderTokenUpdates)، ويتجدّد إن تغيّر المفتاح
 * أو معرّفه أو الفريق. forceIfOlderThanMin: ردّ ExpiredProviderToken يجدّده إن مضت عليه ٢٠ دقيقة على الأقل.
 */
function currentJwt(cfg: ApnsConfig, forceIfOlderThanMin = false): string {
  const now = jwtNow();
  const age = jwt ? now - jwt.at : Infinity;
  const stale = !jwt || jwt.keyId !== cfg.keyId || jwt.teamId !== cfg.teamId || jwt.fp !== cfg.fp
    || age >= APNS_JWT_REFRESH_MS || (forceIfOlderThanMin && age >= APNS_JWT_MIN_AGE_MS);
  if (stale) jwt = { token: apnsProviderToken(cfg, Math.floor(now / 1000)), at: now, keyId: cfg.keyId, teamId: cfg.teamId, fp: cfg.fp };
  return jwt!.token;
}

// ─── الرسالة ───
/** رسالة المندوب كما تبنيها presencePayload وalertPayload (title/body/url/tag/checkId) */
export interface RepPush { title: string; body: string; url?: unknown; tag?: unknown; checkId?: unknown }
/** قصٌّ بالبايت لا يكسر حرفاً (نقاط الترميز كاملة، فلا نصف زوجٍ بديل) */
const clipBytes = (s: string, max: number): string => {
  let out = '';
  for (const ch of s) { if (Buffer.byteLength(out + ch, 'utf8') > max) break; out += ch; }
  return out;
};

/**
 * جسم الإشعار وترويساته المشتقّة — المفاتيح بالترتيب: aps ثم tag (إن كان نصاً) ثم url (أو /rep) ثم checkId (إن كان نصاً)،
 * بالأسماء نفسها التي يقرؤها عامل الخدمة (sw.js) والتطبيق. «أثبت تواجدك» بصوته الخاصّ وtime-sensitive (يخترق وضع
 * التركيز)، والباقي active بالصوت الافتراضي. ≤ ٤٠٩٦ بايتاً: يُقصّ نصّ الرسالة إن لزم، وإلّا null.
 */
export function apnsRequest(p: RepPush, ttlSec: number, nowMs: number): { body: Buffer; collapseId: string; expiration: number } | null {
  const tag = typeof p.tag === 'string' ? p.tag : null;
  const presence = tag === 'presence';
  const url = typeof p.url === 'string' ? p.url : '/rep';
  const checkId = typeof p.checkId === 'string' ? p.checkId : null;
  const json = (alertBody: string): string => JSON.stringify({
    aps: {
      alert: { title: p.title, body: alertBody },
      sound: presence ? PRESENCE_SOUND : 'default',
      'interruption-level': presence ? 'time-sensitive' : 'active',
      'relevance-score': presence ? 1 : 0.5,
      'thread-id': presence ? 'presence' : 'attendance',
    },
    ...(tag != null ? { tag } : {}),
    url,
    ...(checkId != null ? { checkId } : {}),
  });
  const fits = (s: string): boolean => Buffer.byteLength(s, 'utf8') <= APNS_MAX_PAYLOAD;
  let out = json(p.body);
  if (!fits(out)) {
    // أطول بادئةٍ من النصّ تُبقي الجسم كلّه (بعد ترميز JSON) في الحدّ — بحثٌ ثنائيّ على نقاط الترميز
    const cps = Array.from(p.body);
    let lo = 0; let hi = cps.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(json(cps.slice(0, mid).join('')))) lo = mid; else hi = mid - 1; }
    out = json(cps.slice(0, lo).join(''));
    if (!fits(out)) return null; // العنوان وحده يتجاوز الحدّ
  }
  const ttl = Number.isFinite(ttlSec) ? Math.max(0, Math.floor(ttlSec)) : 3600;
  // معرّف الطيّ = الوسم: طلب «أثبت تواجدك» الأحدث يحلّ محلّ الأقدم في مركز الإشعارات (كـtag في الويب)
  return { body: Buffer.from(out, 'utf8'), collapseId: clipBytes(tag || 'fieldsales', 64) || 'fieldsales', expiration: Math.floor(nowMs / 1000) + ttl };
}

// ─── تصنيف الردّ ───
const GONE_400 = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic']);
const CONFIG = new Set(['InvalidProviderToken', 'BadEnvironmentKeyIdInToken', 'UnrelatedKeyIdInToken', 'MissingProviderToken', 'Forbidden',
  'TopicDisallowed', 'BadTopic', 'MissingTopic', 'BadCertificate', 'BadCertificateEnvironment']);
export type Verdict = { result: PushResult; action?: 'refresh-jwt' | 'config' | 'drop-session' };
/** proven: نجح إرسالٌ في هذه البيئة منذ تشغيل الخادم — فـBadDeviceToken يعني الرمز لا إعدادنا (لا حذف جماعيّ بموضوعٍ خاطئ) */
export function classifyApns(status: number, reason: string | undefined, proven: boolean): Verdict {
  if (status === 200) return { result: 'sent' };
  if (status === 410) return { result: 'gone' }; // Unregistered/ExpiredToken: الرمز خامدٌ لهذا الموضوع
  if (status === 400 && reason && GONE_400.has(reason)) return { result: proven ? 'gone' : 'failed' };
  if (status === 403 && reason === 'ExpiredProviderToken') return { result: 'failed', action: 'refresh-jwt' };
  if (reason && CONFIG.has(reason)) return { result: 'failed', action: 'config' };
  if (status === 503 || reason === 'IdleTimeout') return { result: 'failed', action: 'drop-session' };
  return { result: 'failed' }; // 404/405/413/429/500 وغيرها: يُبقى الاشتراك
}

// ─── الاتصال: جلسة HTTP/2 واحدة لكل بيئة ───
const sessions = new Map<ApnsEnv, http2.ClientHttp2Session>();
/** كل جلسةٍ لم تُهدم بعد (المخزَّنة والمعتزلة) — ليهدمها _resetApns في الاختبار */
const live = new Set<http2.ClientHttp2Session>();
/** جلساتٌ قام اتصالها فعلاً: ما لم يقم لم يخرج منه بايت، فإعادة طلبه آمنة */
const connected = new WeakSet<http2.ClientHttp2Session>();
/** آخر تيارٍ قال الخادم في GOAWAY إنه عالجه: ما فوقه لم يُعالَج (RFC 9113 §6.8) */
const goawayLast = new WeakMap<http2.ClientHttp2Session, number>();
/** مقبس كل جلسة: الإغلاق اللطيف يُنهي طرفنا وينتظر طرف الخادم، فمقبسٌ ميت يُهدم بيدنا */
const sockets = new WeakMap<http2.ClientHttp2Session, { destroy(): unknown }>();
const proven = new Set<ApnsEnv>();
const cooldownUntil = new Map<ApnsEnv, number>();
let lastError: { env: ApnsEnv; status: number; reason?: string; at: string } | null = null;

/**
 * اعتزالٌ لطيف لجلسةٍ بعينها: تخرج من الذاكرة (الإرسال التالي يفتح غيرها) وتُكمل ما عليها من تيارات — فطلبٌ من دورة التنبيهات
 * الأخرى على الاتصال نفسه لا يُقتل — ثم تُهدم هي ومقبسها بعد مهلة طلبٍ (كل تيارٍ عليها انتهى أو انقضت مهلته، ومقبسٌ ميت لا
 * يُفرغ ما عليه ولا يُغلَق من الطرف الآخر). ولا تمسّ جلسةً أحدث للبيئة
 */
function retire(env: ApnsEnv, s: http2.ClientHttp2Session): void {
  if (sessions.get(env) === s) sessions.delete(env);
  if (s.destroyed) return;
  s.close();
  setTimeout(() => { if (!s.destroyed) s.destroy(); sockets.get(s)?.destroy(); }, timeoutMs).unref();
}
function closeSession(env: ApnsEnv): void {
  const s = sessions.get(env);
  if (s) retire(env, s);
}

function session(env: ApnsEnv): http2.ClientHttp2Session {
  const cur = sessions.get(env);
  if (cur && !cur.closed && !cur.destroyed) return cur;
  const s = http2.connect(originOverride[env] ?? ORIGINS[env]);
  const drop = () => { if (sessions.get(env) === s) sessions.delete(env); };
  live.add(s);
  s.once('connect', (_s: http2.ClientHttp2Session, socket: { destroy(): unknown }) => { connected.add(s); sockets.set(s, socket); });
  s.on('error', drop);
  // Node نفسه يغلقها بلطف (NO_ERROR) أو يهدمها (خطأ) بعد هذا الحدث — وclose() منّا هنا كان يُبقي مقبسها نصف مفتوح بعد GOAWAY بخطأ
  s.on('goaway', (_code: number, last: number) => { goawayLast.set(s, last); drop(); });
  s.on('close', () => { drop(); live.delete(s); });
  s.setTimeout(APNS_IDLE_CLOSE_MS, () => { drop(); s.close(); }); // خاملةٌ ١٥ دقيقة تُغلق
  s.unref(); // لا تُبقي العملية حيّة وحدها
  sessions.set(env, s);
  return s;
}

type Raw = { status: number; reason?: string; retryable?: boolean };
function post(env: ApnsEnv, token: string, headers: http2.OutgoingHttpHeaders, body: Buffer): Promise<Raw> {
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let status = 0; const chunks: Buffer[] = [];
    const finish = (r: Raw) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let s: http2.ClientHttp2Session | undefined;
    let req: http2.ClientHttp2Stream;
    try {
      s = session(env);
      req = s.request({ ':method': 'POST', ':path': `/3/device/${token}`, ...headers });
    } catch {
      // لم يُرسَل شيء (جلسةٌ مغلقة/نفدت تياراتها): تُعتزل هي وحدها — لا تُترك مفتوحةً خارج الذاكرة ولا تُزاح جلسةٌ أحدث
      if (s) retire(env, s);
      return finish({ status: 0, retryable: true });
    }
    const sess = s;
    // يُعاد الطلب مرّةً فقط حين يضمن HTTP/2 أن Apple لم تعالجه: تيارٌ مرفوض (REFUSED_STREAM)، أو رقمه فوق آخر ما عالجه الخادم
    // في GOAWAY، أو اتصالٌ لم يقم أصلاً — لا كل خطأ قبل الردّ: طلبٌ وصل كاملاً يُرسَل مرّتين فيرنّ منبّه «أثبت تواجدك» مرّتين
    // (معرّف الطيّ يستبدل الإشعار لا الصوت)
    const unprocessed = (): boolean => req.rstCode === http2.constants.NGHTTP2_REFUSED_STREAM || !connected.has(sess)
      || (typeof req.id === 'number' && req.id > (goawayLast.get(sess) ?? Infinity));
    timer = setTimeout(() => {
      try { req.close(http2.constants.NGHTTP2_CANCEL); } catch { /* أُغلق للتوّ */ }
      // بلا ردٍّ في المهلة: يُلغى هذا التيار وحده، والاتصال المشكوك فيه يُعتزل بلطف — لا يُبنى عليه جديد، وتيارات الدورة الأخرى
      // عليه تكمل (هدمه كان يقتلها فتُحسب «لم يصل» وقد وصلت)
      if (status === 0) retire(env, sess);
      finish({ status: 0 });
    }, timeoutMs);
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.on('data', (c: Buffer) => { if (chunks.length < 8) chunks.push(c); });
    req.on('end', () => {
      let reason: string | undefined;
      try { reason = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: string }).reason : undefined; } catch { /* جسمٌ غير JSON */ }
      finish({ status, reason });
    });
    // خطأ التيار لا يمسّ الجلسة: RST لتيارٍ واحد لا يُفسد اتصالاً سليماً، وجلسةٌ ماتت تُسقط نفسها (error/goaway/close أعلاه)
    req.on('error', () => { finish({ status, retryable: status === 0 && unprocessed() }); });
    req.on('close', () => { if (!done) finish({ status, retryable: status === 0 && unprocessed() }); });
    req.end(body);
  });
}

/** يرسل إشعاراً لاشتراك آيفون واحد — لا يرمي أبداً، ولا يعيد gone إلا لرمزٍ ثبت موته (فيحذفه sendPushToRep) */
export async function sendApns(endpoint: string, payload: object, opts: { ttlSec?: number } = {}): Promise<PushResult> {
  try {
    const parsed = parseApnsEndpoint(endpoint);
    if (!parsed) return 'gone'; // ما لا يُقرأ لن يصلح أبداً (الرمز يُفحص عند التسجيل، فهذا صفٌّ فاسد)
    const cfg = apnsConfigFromEnv();
    if (!cfg) return 'failed'; // بلا إعداد: لا شبكة، والاشتراك يبقى حتى يُضاف المفتاح
    const { env, token } = parsed;
    if ((cooldownUntil.get(env) ?? 0) > Date.now()) return 'failed';
    const p = payload as RepPush;
    if (typeof p.title !== 'string' || typeof p.body !== 'string') return 'failed';
    const msg = apnsRequest(p, opts.ttlSec ?? 3600, Date.now());
    if (!msg) return 'failed';
    let forceJwt = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: http2.OutgoingHttpHeaders = {
        authorization: `bearer ${currentJwt(cfg, forceJwt)}`,
        'apns-topic': cfg.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(msg.expiration),
        'apns-collapse-id': msg.collapseId,
        'apns-id': crypto.randomUUID(),
        'content-type': 'application/json',
      };
      const raw = await post(env, token, headers, msg.body);
      if (raw.status === 0) {
        if (raw.retryable && attempt === 0) continue;
        const n = (netFails.get(env) ?? 0) + 1;
        netFails.set(env, n);
        // والاتصال نفسه يُعتزل: اتصالٌ يرفض كل تيار لا يُعاد إليه بعد التبريد
        if (n >= APNS_NET_FAILS) { netFails.set(env, 0); cooldownUntil.set(env, Date.now() + APNS_NET_COOLDOWN_MS); closeSession(env); }
        return 'failed';
      }
      netFails.set(env, 0);
      const v = classifyApns(raw.status, raw.reason, proven.has(env));
      if (v.result === 'sent') { proven.add(env); return 'sent'; }
      lastError = { env, status: raw.status, reason: raw.reason, at: new Date().toISOString() };
      if (v.action === 'refresh-jwt' && attempt === 0) {
        forceJwt = true;
        closeSession(env); // رمزٌ جديد على اتصالٍ جديد، ومحاولةٌ ثانية واحدة
        continue;
      }
      if (v.action === 'config') {
        // المفتاح/الفريق/الموضوع مرفوض: لا حذف (الرموز سليمة)، والبيئة تتوقّف ١٥ دقيقة والأخرى تعمل
        cooldownUntil.set(env, Date.now() + APNS_CONFIG_COOLDOWN_MS);
        closeSession(env);
        console.error(`apns: رفضٌ للإعداد في ${env} (${raw.status} ${raw.reason ?? ''}) — إيقافٌ ١٥ دقيقة، والاشتراكات باقية`);
      }
      if (v.action === 'drop-session') closeSession(env);
      return v.result;
    }
    return 'failed';
  } catch {
    return 'failed'; // لا يوقف استثناءٌ دورة التنبيهات لكل الشركات
  }
}

/** للوحة المالك/الصحّة (غير موصولة بعد): لا أسرار ولا رموز */
export function apnsStatus() {
  return { configured: apnsConfigured(), proven: [...proven], cooling: [...cooldownUntil].filter(([, t]) => t > Date.now()).map(([e]) => e), lastError };
}

/** للاختبار وحده (لا يُنادى من الشيفرة ولا يُقرأ من البيئة) */
export function _apnsTestHooks(o: { origins?: Partial<Record<ApnsEnv, string>>; timeoutMs?: number; now?: () => number }): void {
  if (o.origins) originOverride = o.origins;
  if (o.timeoutMs) timeoutMs = o.timeoutMs;
  if (o.now) jwtNow = o.now;
}
export function _resetApns(): void {
  for (const s of live) { s.destroy(); sockets.get(s)?.destroy(); }
  live.clear(); sessions.clear(); proven.clear(); netFails.clear(); cooldownUntil.clear();
  jwt = null; cfgCache = null; cfgWarned = false; lastError = null;
  timeoutMs = APNS_TIMEOUT_MS; jwtNow = () => Date.now(); originOverride = {};
}
