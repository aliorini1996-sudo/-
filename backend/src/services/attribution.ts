/**
 * إسناد الزيارات — تطبيع وسوم الحملة واشتقاق القناة على الخادم.
 *
 * لماذا على الخادم: قيم UTM تصل من العميل ولا يُوثق بها؛ ولو خُزّنت خاماً لتفرّقت
 * القناة الواحدة على عشرات التهجئات فيستحيل التجميع. القاموس مغلق: أي قيمة خارجه
 * تُطبَّع إلى `other` بدل رفض الزيارة (فقدان زيارة أسوأ من تصنيفها عامّاً).
 *
 * لا بيانات شخصية هنا إطلاقاً: لا IP خام ولا هاتف ولا بريد.
 */

/** المصادر المعروفة — أي قيمة أخرى ⇒ other */
const SOURCES = new Set([
  'google', 'bing', 'chatgpt', 'perplexity', 'copilot', 'gemini', 'claude',
  'facebook_group', 'facebook', 'linkedin', 'x', 'twitter', 'telegram',
  'sourceforge', 'alternativeto', 'saashub', 'slashdot', 'trustradius',
  'softwaresuggest', 'techjockey', 'odoo_apps', 'email', 'whatsapp', 'direct',
]);

const MEDIUMS = new Set([
  'organic', 'ai_answer', 'directory', 'community', 'email', 'referral',
  'app_store', 'social', 'none',
]);

/** محرّكات الذكاء التوليدي — تُعرف من نطاق المُحيل */
const AI_ENGINES: Record<string, string> = {
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'openai.com': 'chatgpt',
  'perplexity.ai': 'perplexity',
  'www.perplexity.ai': 'perplexity',
  'copilot.microsoft.com': 'copilot',
  'gemini.google.com': 'gemini',
  'claude.ai': 'claude',
};

const SEARCH_HOSTS = ['google.', 'bing.com', 'duckduckgo.com', 'yandex.', 'search.brave.com', 'ecosia.org'];
const SOCIAL_HOSTS = ['facebook.com', 'linkedin.com', 'x.com', 'twitter.com', 't.co', 'instagram.com', 'telegram', 'youtube.com'];

const clamp = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s ? s.slice(0, max) : null;
};

/** قيمة من القاموس أو other (أو null إن لم تُرسل أصلاً) */
const dict = (v: unknown, set: Set<string>, max = 64): string | null => {
  const s = clamp(v, max);
  if (!s) return null;
  return set.has(s) ? s : 'other';
};

export interface AttributionInput {
  utm?: Record<string, unknown> | null;
  referrerHost?: string | null;
  path?: string | null;
}

export interface AttributionResult {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  channel: string;
  aiEngine: string | null;
  contentType: string | null;
}

/** نوع المحتوى من المسار — لقراءة «أي نوع صفحة يولّد المحادثات» */
export function contentTypeOf(path?: string | null): string | null {
  if (!path) return null;
  const p = String(path).toLowerCase();
  if (/^\/(en\/|fr\/)?blog/.test(p)) return 'blog';
  if (/(invoice-generator|calculator|\/free)/.test(p)) return 'tool';
  if (/pricing|الأسعار|التسعير/.test(p)) return 'pricing';
  if (/(قطاعات|sectors?)\//.test(p)) return 'sector';
  if (/(مقارنة|compare|vs-)/.test(p)) return 'compare';
  if (p === '/' || /^\/(en|fr)\/?$/.test(p)) return 'landing';
  return null;
}

/**
 * يشتقّ القناة: الوسوم الصريحة أولاً، ثم نطاق المُحيل، ثم مباشرة.
 * محرّكات الذكاء تُميَّز عن البحث العادي لأنها مسار اقتباس لا نقر تقليدي.
 */
export function resolveAttribution(input: AttributionInput): AttributionResult {
  const u = input.utm || {};
  const host = (input.referrerHost || '').toLowerCase();

  const utmSource = dict(u.source, SOURCES);
  const utmMedium = dict(u.medium, MEDIUMS);

  let aiEngine: string | null = null;
  for (const [h, engine] of Object.entries(AI_ENGINES)) {
    if (host === h || host.endsWith('.' + h)) { aiEngine = engine; break; }
  }

  let channel: string;
  if (aiEngine) channel = 'ai_generative';
  else if (utmMedium && utmMedium !== 'other' && utmMedium !== 'none') channel = utmMedium === 'ai_answer' ? 'ai_generative' : utmMedium;
  else if (!host) channel = 'direct';
  else if (SEARCH_HOSTS.some((h) => host.includes(h))) channel = 'organic';
  else if (SOCIAL_HOSTS.some((h) => host.includes(h))) channel = 'social';
  else channel = 'referral';

  return {
    utmSource,
    utmMedium,
    utmCampaign: clamp(u.campaign, 96),
    utmContent: clamp(u.content, 96),
    utmTerm: clamp(u.term, 96),
    channel,
    aiEngine,
    contentType: contentTypeOf(input.path),
  };
}

/**
 * رمز واتساب: 8 محارف من قاعدة 32 (بلا أحرف ملتبسة) — يُلصق في نصّ الرسالة
 * فيصل مع المحادثة، ويُطابَق لاحقاً بصفّ الزيارة لإغلاق حلقة الإسناد.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // بلا 0/O/1/I
export function makeWaCode(seed?: string): string {
  let out = '';
  const base = (seed || '') + Math.random().toString(36) + Date.now().toString(36);
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  for (let i = 0; i < 8; i++) { out += ALPHABET[h % ALPHABET.length]; h = (h * 1103515245 + 12345) >>> 0; }
  return out;
}

/** ref الصفحة: يُشتقّ من المسار آلياً — لا يُكتب يدوياً فلا يُنسى ولا يتضارب */
export function refFromPath(path?: string | null): string {
  const p = String(path || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  return p.replace(/^\/+/, '').replace(/\//g, '-').slice(0, 48) || 'home';
}
