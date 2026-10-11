/**
 * مفاتيح «الربط البرمجي API» — مفتاحٌ لكل شركة يعمل به نظامها الخاص كما يعمل مديرها في اللوحة.
 *
 * أمر المالك (١١ أكتوبر ٢٠٢٦): «API Key حرّ لهم يستخدمونه فيما يريدون». فالمفتاح لا يفتح واجهةً
 * موازية بقواعد منسوخة، بل **يُصادِق على مسارات اللوحة نفسها** بهوية مستخدم الشركة الذي أصدره:
 * الفاتورة عبر المفتاح تمرّ بالتحقّق والترقيم وزاتكا والمخزون ذاتها، وحرّاس الصلاحية والنطاق
 * والأعلام تسري عليه كما تسري على صاحبه. وما لا يراه صاحبه في اللوحة لا يراه مفتاحه.
 *
 * الاستثناء الوحيد: ما يملك به المفتاحُ الحسابَ نفسه — إصدار مفاتيح وإدارة الدخول وكلمات
 * المرور ومستخدمي الشركة وأدوات المالك. مفتاحٌ مسروق يقرأ ويكتب بيانات العمل ولا يستولي على
 * الحساب ولا يورّث نفسه مفتاحاً آخر؛ والإلغاء من اللوحة يُغلقه في الحال.
 *
 * المفتاح لا يُخزَّن: يُخزَّن SHA-256 له (عشوائيّته ٢٤٠ بتاً فلا معنى لتمليح أو بطء)، ويُعرض
 * كاملاً مرةً واحدة عند إصداره.
 */
import crypto from 'crypto';

/** بادئة المفاتيح — تميّزها عن توكن الجلسة (JWT يبدأ بـ eyJ) قبل أي فكّ */
export const API_KEY_PREFIX = 'fsk_';

/** طول الجزء العشوائي بالبايت (٣٠ بايت = ٤٠ محرفاً base64url = ٢٤٠ بتاً) */
const KEY_BYTES = 30;

/** شكل المفتاح بالضبط — ما سواه لا يُبحث عنه في القاعدة أصلاً */
const KEY_SHAPE = /^fsk_[A-Za-z0-9_-]{40}$/;

export const hashApiKey = (key: string): string => crypto.createHash('sha256').update(key, 'utf8').digest('hex');

/** مفتاح جديد: النصّ الكامل (يُعرض مرة) وبادئته الظاهرة في القائمة وبصمته المخزَّنة */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = API_KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('base64url');
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 8), hash: hashApiKey(key) };
}

/** هل يحمل الطلب مفتاح API (لا توكن جلسة)؟ — `Authorization: Bearer fsk_…` أو `X-API-Key: fsk_…` */
export function apiKeyFromHeaders(headers: { authorization?: string; 'x-api-key'?: string | string[] }): string | null {
  const auth = headers.authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  const bearer = m ? m[1] : '';
  if (bearer.startsWith(API_KEY_PREFIX)) return bearer;
  const x = headers['x-api-key'];
  const xv = (Array.isArray(x) ? x[0] : x || '').trim();
  return xv.startsWith(API_KEY_PREFIX) ? xv : null;
}

export const isWellFormedApiKey = (key: string): boolean => KEY_SHAPE.test(key);

/**
 * مسارات لا يبلغها مفتاح API ولو كان كاملاً — ما يملك به الحسابَ لا بياناته.
 * البادئة تُقارَن بالمسار **بعد** /api (الطلب `/api/auth/me` ⇒ `/auth/me`).
 */
export const API_KEY_DENIED_PREFIXES: readonly string[] = Object.freeze([
  '/auth',            // الدخول والتسجيل وتجديد الجلسة وكلمات المرور
  '/api-keys',        // إصدار المفاتيح وإلغاؤها — مفتاحٌ لا يلد مفتاحاً
  '/company-users',   // مستخدمو الشركة وصلاحياتهم وكلمات مرورهم
  '/tenants',         // أدوات مالك المنصة
  '/finance',         // نافذة المالك المالية
  '/hunter',          // منصة الصيد السرّية للمالك
  '/affiliate-admin', // إدارة السفراء (المالك)
  '/wa-inbox',        // صندوق واتساب المالك
  '/site-content',    // محتوى الموقع العام (المالك)
  '/profile-deck',
  '/promo-videos',
  '/leads-cron',
  '/analytics',
  '/payments',        // اشتراك الشركة نفسها في المنصة
  '/live',            // بثّ اللوحة اللحظي: يُفحص عند الفتح وحده فيبقى بعد الإلغاء ويستهلك مقاعد بثّ الشركة
]);

/** أقصى صفحة لقوائم اللوحة عبر المفتاح — والسحب الكامل من /api/v1/sync */
export const API_KEY_MAX_PAGE = 200;

/**
 * المفاتيح التي أجازها authenticate للتوّ (بصمةً) — بها وحدها يُحسب طلبٌ على دلو المفتاح في الحدّ العام
 * بدل دلو IP. بلا قاعدة في الحدّ: المفتاح المجهول أو الملغى ليس هنا فيبقى تحت حدّ IP كأي طلب.
 * والإلغاء يمحوه فوراً (forgetLiveKey)، وما سواه يسقط بمرور دقيقة.
 */
const LIVE_KEY_TTL_MS = 60_000;
const liveKeys = new Map<string, number>();
export function markLiveKey(hash: string, now = Date.now()): void {
  liveKeys.set(hash, now + LIVE_KEY_TTL_MS);
  if (liveKeys.size > 10_000) for (const [k, until] of liveKeys) if (until <= now) liveKeys.delete(k);
}
export function isLiveKeyHash(hash: string, now = Date.now()): boolean {
  const until = liveKeys.get(hash);
  return until !== undefined && until > now;
}
export function forgetLiveKey(hash: string): void { liveKeys.delete(hash); }

/**
 * المسار كما يوجّهه Express لا كما كُتب: التوجيه **غير حسّاس لحالة الأحرف** (`/api/AUTH/me` يبلغ
 * موجّه /auth)، ولا يفرّق بين شرطة ختام وغيابها. فالمقارنة على صورة موحّدة: بلا استعلام، مفكوكة
 * الترميز، بحروف صغيرة، وشرطاتٍ مكرّرة مطويّة — وإلا عبر المفتاحُ الممنوعَ بتغيير حرفٍ واحد.
 */
export function normalizeApiPath(raw: string): string {
  let p = (raw || '').split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch { /* ترميز معطوب: يبقى كما هو ويُقارَن */ }
  p = p.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  return p || '/';
}

/** ما بعد /api من الرابط الأصلي للطلب — `/api/customers?x` ⇒ `/customers` */
export function pathAfterApi(originalUrl: string): string {
  const p = normalizeApiPath(originalUrl);
  return p === '/api' ? '/' : p.startsWith('/api/') ? p.slice(4) : p;
}

/**
 * حكم المسار والطريقة لمفتاح بعينه: `null` = مسموح، وإلا سبب الرفض.
 * المفتاح «قراءة فقط» لا يمرّ إلا بالقراءة (GET/HEAD).
 */
export function apiKeyRouteDecision(method: string, pathAfterApi: string, readOnly: boolean): string | null {
  const p = normalizeApiPath(pathAfterApi);
  for (const d of API_KEY_DENIED_PREFIXES) {
    if (p === d || p.startsWith(`${d}/`)) return 'هذا المسار غير متاح عبر مفتاح API';
  }
  const m = method.toUpperCase();
  if (readOnly && m !== 'GET' && m !== 'HEAD') return 'المفتاح للقراءة فقط';
  return null;
}

/** حدّ الطلبات لكل مفتاح في الدقيقة — يُكتب في المستند ويُعاد في الرؤوس */
export const API_KEY_RATE_PER_MINUTE = 120;

const windows = new Map<string, { start: number; count: number }>();

/**
 * نافذة ثابتة لكل مفتاح (في ذاكرة الخادم — نسخة واحدة على Render). تُرجع ما بقي أو موعد الفتح.
 * المفاتيح الملغاة أو المجهولة لا تبلغها: تُردّ قبلها.
 */
export function takeApiKeyToken(keyId: string, now = Date.now()): { ok: true; remaining: number } | { ok: false; retryAfterSec: number } {
  const w = windows.get(keyId);
  if (!w || now - w.start >= 60_000) {
    windows.set(keyId, { start: now, count: 1 });
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
    }
    return { ok: true, remaining: API_KEY_RATE_PER_MINUTE - 1 };
  }
  if (w.count >= API_KEY_RATE_PER_MINUTE) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000)) };
  w.count += 1;
  return { ok: true, remaining: API_KEY_RATE_PER_MINUTE - w.count };
}

/** للاختبار وحده */
export function _resetApiKeyWindows(): void { windows.clear(); liveKeys.clear(); }

/** اشتراك الشركة نافذ؟ — نفس حكم الدخول (routes/auth.ts tenantBlockReason) */
export function tenantBlockedReason(t: { isActive: boolean; subscriptionEndsAt: Date | null } | null, now = Date.now()): string | null {
  if (!t) return 'الشركة غير موجودة';
  if (!t.isActive) return 'اشتراك الشركة موقوف - تواصل مع مزود الخدمة';
  if (t.subscriptionEndsAt && t.subscriptionEndsAt.getTime() < now) return 'انتهى اشتراك الشركة - تواصل مع مزود الخدمة';
  return null;
}
