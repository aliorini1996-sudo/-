import { BlockList, isIPv4, isIPv6 } from 'net';

/**
 * عنوان المستخدم الحقيقي خلف Cloudflare ثم بروكسي Render (إصلاح ٢١ نوفمبر ٢٠٢٦، طلب المالك).
 *
 * الطريق: المستخدم ← Cloudflare ← بروكسي Render ← الخادم. كان `trust proxy = 1` يثق بقفزة Render وحدها، فصار
 * `req.ip` عنوانَ حافة Cloudflare (172.71.x.x و104.22.x.x في السجلات) لا عنوان المستخدم — فتقاسمت شبكاتٌ ومناطق
 * كاملة حدود المعدّل لكل IP (الدخول ٢٠/١٥ دقيقة، التسجيل، الحسابات التجريبية للسفراء…) فيُحجب بريءٌ بمحاولات غيره.
 *
 * الحلّ: نثق بالقفزة الأولى (بروكسي Render — كما كان) **وبعناوين Cloudflare المنشورة وحدها**؛ فيصير `req.ip` أوّل
 * عنوانٍ غير موثوق من اليمين في X-Forwarded-For = المستخدم الذي أضافه Cloudflare. ومن يتجاوز Cloudflare (النطاق
 * onrender.com مباشرةً) ويزوّر X-Forwarded-For لا ينفعه التزوير: القفزة التي أضافها Render عنوانُه هو وليس من
 * Cloudflare فيتوقّف عندها. المصدر: https://www.cloudflare.com/ips/ (يُحدَّث إن نشرت Cloudflare نطاقاً جديداً).
 */
export const CLOUDFLARE_RANGES: readonly string[] = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

const cloudflare = new BlockList();
for (const r of CLOUDFLARE_RANGES) {
  const [ip, bits] = r.split('/');
  cloudflare.addSubnet(ip, Number(bits), isIPv6(ip) ? 'ipv6' : 'ipv4');
}

/** هل العنوان من شبكة Cloudflare؟ (يقبل صيغة IPv4 المغلّفة ‎::ffff:1.2.3.4) */
export function isCloudflareIp(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (isIPv4(a)) return cloudflare.check(a, 'ipv4');
  if (isIPv6(a)) return cloudflare.check(a, 'ipv6');
  return false;
}

/** دالّة `trust proxy` لـExpress: القفزة الأولى (بروكسي Render) دائماً، وما بعدها إن كان من Cloudflare فقط */
export function trustProxy(addr: string, i: number): boolean {
  return i === 0 || isCloudflareIp(addr);
}
