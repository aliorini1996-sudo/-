import rateLimit, { Options } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { apiKeyFromHeaders, isWellFormedApiKey, hashApiKey, isLiveKeyHash, API_KEY_RATE_PER_MINUTE } from '../services/apiKeys';

// حدود معدّل الطلبات — حماية ضد التخمين والسبام وإساءة الاستخدام.
// ملاحظة: يتطلب app.set('trust proxy', 1) خلف بروكسي Render لاحتساب IP الحقيقي.

const base: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'تجاوزت الحد المسموح من المحاولات حاول لاحقا' },
};

// تسجيل الدخول — صارم ضد تخمين كلمات المرور (لكل IP)
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { success: false, message: 'محاولات دخول كثيرة انتظر 15 دقيقة ثم حاول مجددا' },
});

/**
 * دخول موظفي المنصة وتغيير كلمة مرورهم (routes/platformStaff.ts) — دلوٌ مستقلّ عن `authLimiter`: الموظف والمالك يعملان
 * غالباً من IP مكتبٍ واحد، فمحاولات الموظف (أو من يخمّن بريده) كانت تستهلك حدّ دخول المالك فتحجبه. الحدّ نفسه لكل IP،
 * وفوقه قفلٌ ذرّي لكل حساب بعد خمس محاولات
 */
export const staffAuthLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { success: false, message: 'محاولات دخول كثيرة انتظر 15 دقيقة ثم حاول مجددا' },
});

/**
 * تجديد الجلسة — سخيّ عمداً، وبمعزل عن حدّ تسجيل الدخول.
 *
 * ليس مسار تخمين: يتطلّب توكناً صحيح التوقيع، فلا فائدة من المحاولة العشوائية،
 * والحدّ هنا وقايةٌ من حلقة تجديد معطوبة لا حمايةٌ من مهاجم.
 *
 * ولماذا لا يُوضع على `authLimiter`: مناديب شركةٍ واحدة يخرجون بـ**IP واحد**
 * (واي‑فاي المستودع أو NAT شبكة الجوال). عشرون طلباً كل ربع ساعة تكفيها دفعةُ
 * دخولٍ صباحية، فلو شاركها التجديدُ لخُنق التجديد ورجعت الشكوى نفسها — إخراجٌ
 * مفاجئ، لكن بسبب 429 هذه المرّة.
 */
export const renewLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: { success: false, message: 'طلبات تجديد كثيرة حاول بعد قليل' },
});

// التسجيل الذاتي — يمنع إنشاء شركات وهمية بكثافة
export const signupLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 6,
  message: { success: false, message: 'طلبات تسجيل كثيرة حاول بعد ساعة' },
});

// نماذج البريد (تواصل/دعم/تحقق) — يمنع السبام
export const mailLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { success: false, message: 'طلبات كثيرة حاول بعد قليل' },
});

/**
 * تسجيل عروض الأسعار من الرابط الخاص بلا دخول — سخيٌّ لفريق مبيعاتٍ يخرج من IP مكتبٍ
 * واحد (ستّون عرضاً في الساعة تفوق أيّ يوم عمل)، وضيّقٌ على من يكتشف الواجهة فيُغرقها.
 */
/** وحدة الدفع الأصلية تستبدل رمز التسليم بلا دخول — الرمز عشوائي لمرة واحدة، والحدّ يمنع تخمينه */
export const cardPayLaunchLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 30,
  message: { success: false, message: 'محاولات كثيرة حاول بعد قليل' },
});

export const quoteLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 60,
  message: { success: false, message: 'عروض كثيرة خلال ساعة حاول لاحقا' },
});

/**
 * بصمة مفتاح API **حيّ** في الطلب — أجازه authenticate خلال الدقيقة الأخيرة (markLiveKey) — أو null.
 * لا قاعدة هنا: المفتاح المجهول أو المزيّف أو الملغى ليس في الذاكرة فيُعامل طلبه كأي طلب.
 */
function liveKeyHashOf(req: { headers: Record<string, unknown> }): string | null {
  const key = apiKeyFromHeaders(req.headers as { authorization?: string; 'x-api-key'?: string | string[] });
  if (!key || !isWellFormedApiKey(key)) return null;
  const hash = hashApiKey(key);
  return isLiveKeyHash(hash) ? hash : null;
}

/**
 * حدّ عام واقٍ لكل واجهة API. طلب المفتاح الحيّ يُعدّ في **دلو مفتاحه** لا في دلو IP: خادم الشركة يزامن من IP
 * واحد طوال اليوم والحدّ العام (٤٠/دقيقة) كان سيخنقه — ولا يُعفى من العدّ إطلاقاً، فالمسارات العامة والمرفوضة
 * تُحسب عليه أيضاً. سقف الدلو ربع ساعة بمعدّل حدّ المفتاح الدقيق (١٢٠/دقيقة في authenticate).
 */
export const apiLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: (req) => (liveKeyHashOf(req) ? API_KEY_RATE_PER_MINUTE * 15 : isRepPing(req) ? PING_IP_LIMIT : 600),
  keyGenerator: (req) => {
    const h = liveKeyHashOf(req);
    if (h) return `key:${h}`;
    // نقاط موقع المندوب تُعدّ (لا إعفاء) في دلوٍ مستقلّ لعنوانها: مناديب الشركة خلف NAT المشغّل يتقاسمون عنواناً، ونقاطهم
    // صارت أسرع (رفعٌ عند التحرّك) فكانت ستستهلك حدّ IP عن فواتيرهم وسنداتهم. وبعد المصادقة دلو المندوب نفسه (pingLimiter)
    return isRepPing(req) ? `ping:${req.ip ?? ''}` : (req.ip ?? '');
  },
});

/** سقف نقاط الموقع لكل عنوان في ربع ساعة — ١٢٠/دقيقة: نحو عشرين مندوباً خلف عنوانٍ واحد */
export const PING_IP_LIMIT = 1800;

const REP_PING = Symbol('repPing');

/**
 * POST /api/tracking/ping بتوكن جلسة مندوبٍ صحيح التوقيع — يُحكم مرةً لكل طلب (limit وkeyGenerator يسألان كلاهما).
 * التوقيع HMAC بلا قاعدة: ترويسةٌ مزوّرة بشكل JWT (ومعها مفتاحٌ عشوائي) لا تنقل صاحبها إلى الدلو الأوسع فتصل استعلام
 * المفاتيح بأربعة أضعاف حدّ IP. ومفتاح API (fsk_…) وتوكن مستخدم اللوحة والمنتهي يبقون في دلو IP العام.
 */
export function isRepPing(req: { method: string; path: string; headers: Record<string, unknown> }): boolean {
  const r = req as typeof req & { [REP_PING]?: boolean };
  if (r[REP_PING] === undefined) r[REP_PING] = verifiedRepPing(req);
  return r[REP_PING]!;
}

function verifiedRepPing(req: { method: string; path: string; headers: Record<string, unknown> }): boolean {
  if (req.method !== 'POST' || req.path !== '/tracking/ping') return false;
  if (apiKeyFromHeaders(req.headers as { authorization?: string; 'x-api-key'?: string | string[] })) return false;
  const auth = req.headers.authorization;
  const m = typeof auth === 'string' ? /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(auth) : null;
  const secret = process.env.JWT_SECRET;
  if (!m || !secret) return false;
  try {
    const p = jwt.verify(m[1], secret as jwt.Secret) as { role?: unknown; id?: unknown };
    return p.role === 'SALES_REP' && typeof p.id === 'string' && p.id.length > 0;
  } catch {
    return false;
  }
}

/**
 * نقاط الموقع لكل مندوب: التطبيق يرفع كل ١٥ث متحرّكاً و٣٠ث ساكناً (≤٤/دقيقة)، والمقيَّد يزيد نقطة حاجزٍ كل ٣٠ث ونقطةً
 * قبل الإجراء (≤٤/دقيقة) — نحو ١٠/دقيقة في أسوأ يوم. ١٦/دقيقة سقفٌ بهامش: أضيق منه يردّ نقطة ما قبل الفاتورة فيُمنع
 * المقيَّد من عمله، وأوسع منه هامشٌ لنقاطٍ مصنوعة. يُركَّب بعد authenticate (req.user)
 */
export const pingLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 240,
  keyGenerator: (req) => `rep-ping:${(req as unknown as { user?: { id?: string } }).user?.id ?? req.ip ?? ''}`,
});

/**
 * جسر واتساب — سخيّ عمداً: الجسر يسحب الطابور كل ~8ث (~112 طلب/15د)، ولوحة المالك
 * تسحب الحالة والمحادثة من **نفس الـIP المنزلي** (~200 أخرى). الحدّ العام (600) كان
 * سيخنقهما معاً فيموت الجسر صامتاً بـ429. يبقى الحدّ موجوداً لمنع تخمين مفتاح الجسر.
 */
export const bridgeLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 1500,
});

/**
 * تصدير الدفاتر (DESIGN.md §9.4، §7.1، §8.3): `POST /api/ledger/lists/:list/export` و`/reports/:key/export`
 * وبدء الحزمة النظامية — 20 طلباً كل 15 دقيقة **لكل مستخدم** فوق `apiLimiter` العام. يُركَّب بعد
 * `authenticate` فيُقرأ المستخدم من التوكن؛ وبلا مستخدم يُحتسب على الـIP.
 */
export const ledgerExportLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => {
    const uid = (req as typeof req & { user?: { id?: string } }).user?.id;
    return uid ? `ledger-export:user:${uid}` : `ledger-export:ip:${req.ip ?? ''}`;
  },
  message: { success: false, code: 'RATE_LIMITED', message: 'طلبات تصدير كثيرة حاول بعد 15 دقيقة' },
});
