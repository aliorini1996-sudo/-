import { randomBytes, createHash, createHmac } from 'crypto';
import { isIP } from 'net';
/**
 * إسناد الزيارات — تطبيع وسوم الحملة واشتقاق القناة على الخادم.
 *
 * لماذا على الخادم: قيم UTM تصل من العميل ولا يُوثق بها؛ ولو خُزّنت خاماً لتفرّقت
 * القناة الواحدة على عشرات التهجئات فيستحيل التجميع. القاموس مغلق: أي قيمة خارجه
 * تُطبَّع إلى `other` بدل رفض الزيارة (فقدان زيارة أسوأ من تصنيفها عامّاً).
 *
 * لا يُخزَّن من هنا أي بيان شخصي: لا IP خام ولا هاتف ولا بريد. عنوان IP يمرّ فقط
 * إلى `ipFingerprint` (بصمة بملح سرّي) وإلى `geoLookupUrl` (تحديد الدولة والمدينة).
 */

/** المصادر المعروفة — أي قيمة أخرى ⇒ other */
const SOURCES = new Set([
  'google', 'bing', 'chatgpt', 'perplexity', 'copilot', 'gemini', 'claude',
  'facebook_group', 'facebook', 'linkedin', 'x', 'twitter', 'telegram',
  'sourceforge', 'alternativeto', 'saashub', 'slashdot', 'trustradius',
  'softwaresuggest', 'techjockey', 'odoo_apps', 'email', 'whatsapp', 'direct',
  // منصّات الحملات الممولة (Meta تُعلن على فيسبوك وإنستغرام معاً)
  'instagram', 'meta',
]);

/** وسائط الحملات المدفوعة — تُحفظ بقيمتها لا `other`، وتُحسم قناتها في `paidChannelOf` */
const PAID_SEARCH_MEDIUMS = new Set(['paid_search', 'paidsearch']);
const PAID_SOCIAL_MEDIUMS = new Set(['paid_social', 'paidsocial']);
/** وسائط مدفوعة عامّة: القناة يحسمها المصدر (cpc من فيسبوك إعلان اجتماعي لا بحثي) */
const PAID_GENERIC_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'cpm']);

const MEDIUMS = new Set([
  'organic', 'ai_answer', 'directory', 'community', 'email', 'referral',
  'app_store', 'social', 'none',
  ...PAID_SEARCH_MEDIUMS, ...PAID_SOCIAL_MEDIUMS, ...PAID_GENERIC_MEDIUMS,
]);

/** مصادر شبكات التواصل التي نشتري فيها إعلاناً (بالقيمة الخام قبل القاموس، مع اختصارات Meta) */
const PAID_SOCIAL_SOURCES = new Set([
  'facebook', 'fb', 'instagram', 'ig', 'meta', 'linkedin', 'x', 'twitter', 'snapchat', 'tiktok',
]);

/**
 * معاملات نقر إعلانات جوجل في رابط الهبوط — يصل نوع المعامل فقط لا قيمته.
 *
 * `gclid`/`gbraid`/`wbraid` معرّفات الوسم التلقائي. و`gad_source`/`gad_campaignid` تضيفهما
 * Google Ads إلى رابط الهبوط مستقلّين عنها، فيبقيان حين يُحذف `gclid` (تصفّح Safari الخاص
 * أو إطفاء الوسم التلقائي). بدونهما تصل نقرة الإعلان بمُحيل google.com وحده فتُحسب «عضوية».
 */
const PAID_CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'gad_source', 'gad_campaignid'] as const;

/** محرّكات الذكاء التوليدي — تُعرف من نطاق المُحيل، أو من `utm_source` حين يغيب المُحيل */
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

/** أسماء محرّكات الذكاء المعروفة (chatgpt · perplexity · copilot · gemini · claude) */
export const AI_ENGINE_IDS: readonly string[] = [...new Set(Object.values(AI_ENGINES))];

/** محرّك الذكاء من نطاق: مطابقة تامّة أو نطاق فرعي لأحد نطاقات `AI_ENGINES` */
function aiEngineOfHost(host: string): string | null {
  if (!host) return null;
  for (const [h, engine] of Object.entries(AI_ENGINES)) {
    if (host === h || host.endsWith('.' + h)) return engine;
  }
  return null;
}

/**
 * محرّك الذكاء من `utm_source` — نطاقه (`chatgpt.com`) أو اسمه (`perplexity`).
 *
 * لماذا: ChatGPT يضيف `utm_source=chatgpt.com` إلى الروابط التي يقتبسها، وتطبيقات
 * المساعدات على الجوال لا ترسل مُحيلاً. فلو اكتُفي بالمُحيل لصُنّفت الزيارة «مباشرة».
 */
export function aiEngineOfSource(source: unknown): string | null {
  const s = clamp(source, 64);
  if (!s) return null;
  if (AI_ENGINE_IDS.includes(s)) return s;
  return aiEngineOfHost(s);
}

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
  /**
   * وسوم الحملة كما أرسلها العميل. إضافةً إلى source/medium/campaign/content/term قد تحمل
   * `clickId` (نوع معامل نقر جوجل: gclid | gbraid | wbraid | gad_source | gad_campaignid)، أو المعامل نفسه بمفتاحه —
   * وجود أيٍّ منهما يكفي، وقيمته لا تُقرأ ولا تُخزَّن.
   */
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

/** تطبيع الوسيط للمطابقة: `Paid-Social` و`paid social` ⇒ `paid_social` */
const normMedium = (v: unknown): string | null => {
  const s = clamp(v, 64);
  return s ? s.replace(/[\s-]+/g, '_') : null;
};

/** هل تحمل الزيارة معرّف نقر إعلان جوجل؟ (النوع في `clickId` أو المعرّف بمفتاحه) */
function hasPaidClickId(u: Record<string, unknown>): boolean {
  const kind = clamp(u.clickId, 16);
  if (kind && (PAID_CLICK_IDS as readonly string[]).includes(kind)) return true;
  return PAID_CLICK_IDS.some((k) => typeof u[k] === 'string' && (u[k] as string).trim() !== '');
}

/**
 * القناة المدفوعة إن وُجدت — وإلا null.
 *
 * لماذا قبل كل شيء: نقرة إعلان جوجل تصل بمُحيل `google.com` تماماً كالبحث العضوي،
 * فلو حُسمت بالمُحيل لنُسب إنفاق الحملة إلى السيو ولبدت الحملة بلا أثر. الوسيط الصريح
 * أو معرّف النقر دليل دفع لا يملكه المُحيل.
 *
 * الترتيب: وسيط اجتماعي أو بحثي صريح ⇒ هو؛ وسيط مدفوع عامّ (cpc/ppc/paid/cpm) ⇒ يحسمه
 * المصدر (شبكة تواصل ⇒ اجتماعي، وإلا بحثي)؛ معرّف نقر جوجل بلا وسيط مدفوع ⇒ بحثي.
 *
 * `cpm` بلا مصدر اجتماعي يُحسب بحثياً مدفوعاً: حسابنا الإعلاني الوحيد خارج شبكات
 * التواصل هو Google Ads (بحث الرياض وجدة)، ولا حملات عرض لدينا. المهمّ ألا يُحسب عضوياً.
 */
export function paidChannelOf(u: Record<string, unknown>): 'paid_search' | 'paid_social' | null {
  const medium = normMedium(u.medium);
  const source = clamp(u.source, 64);
  if (medium && PAID_SOCIAL_MEDIUMS.has(medium)) return 'paid_social';
  if (medium && PAID_SEARCH_MEDIUMS.has(medium)) return 'paid_search';
  if (medium && PAID_GENERIC_MEDIUMS.has(medium)) {
    return source && PAID_SOCIAL_SOURCES.has(source) ? 'paid_social' : 'paid_search';
  }
  if (hasPaidClickId(u)) return 'paid_search';
  return null;
}

/**
 * يشتقّ القناة: الدفع الصريح أولاً (وسيط مدفوع أو معرّف نقر جوجل)، ثم مُحيل محرّك ذكاء،
 * ثم الوسيط الصريح، ثم مصدر محرّك ذكاء في `utm_source`، ثم نطاق المُحيل، ثم مباشرة.
 * محرّكات الذكاء تُميَّز عن البحث العادي لأنها مسار اقتباس لا نقر تقليدي.
 *
 * مصدر الذكاء في `utm_source` يأتي بعد الوسيط الصريح وقبل المُحيل: وسم صريح يسبق المُحيل
 * كما في بقية القواعد، ولا يغيّر تصنيف أي زيارة تحمل وسيطاً معروفاً.
 *
 * القنوات: paid_search | paid_social | ai_generative | organic | social | referral | direct
 * أو وسيط صريح من القاموس (email · directory · community · app_store …). عمود `channel`
 * نصّ حرّ `VarChar(24)` لا enum، فالقناتان المدفوعتان لا تحتاجان أي تغيير في المخطّط.
 */
export function resolveAttribution(input: AttributionInput): AttributionResult {
  const u = input.utm || {};
  const host = (input.referrerHost || '').toLowerCase();

  const hostEngine = aiEngineOfHost(host);
  const sourceEngine = aiEngineOfSource(u.source);
  const aiEngine = hostEngine || sourceEngine;

  // `chatgpt.com` خارج القاموس ⇒ كانت تُحفظ `other` فيضيع المصدر؛ تُحفظ باسم المحرّك (وهو في القاموس)
  const rawSource = dict(u.source, SOURCES);
  const utmSource = rawSource === 'other' && sourceEngine && SOURCES.has(sourceEngine) ? sourceEngine : rawSource;
  const utmMedium = dict(normMedium(u.medium), MEDIUMS);

  const paid = paidChannelOf(u);

  let channel: string;
  if (paid) channel = paid;
  else if (hostEngine) channel = 'ai_generative';
  else if (utmMedium && utmMedium !== 'other' && utmMedium !== 'none') channel = utmMedium === 'ai_answer' ? 'ai_generative' : utmMedium;
  else if (sourceEngine) channel = 'ai_generative';
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

/**
 * ⚠️ درس مقيس: النسخة الأولى استعملت مولّداً خطّياً وأخذت **البتّات الدنيا**
 * (`h % 32`)، ودورة البتّات الدنيا في LCG قصيرة جداً — فأنتجت رموزاً مثل
 * `D2222222`. رمز متكرّر يعني محادثات لا تُنسب لزياراتها، أي انهيار الإسناد
 * كلّه بصمت. الآن: بايتات عشوائية حقيقية من `crypto`، والاحتياطي يأخذ
 * البتّات **العليا** بعد خلط.
 */
export function makeWaCode(seed?: string): string {
  try {
    // مسار قياسي: عشوائية تشفيرية حقيقية
    const bytes = randomBytes(8);
    let out = '';
    for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  } catch {
    // احتياطي حتمي: خلط ثم أخذ البتّات العليا لا الدنيا
    const base = (seed || '') + Date.now().toString(36);
    let h = 2166136261 >>> 0; // FNV-1a
    for (let i = 0; i < base.length; i++) {
      h ^= base.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    let out = '';
    for (let i = 0; i < 8; i++) {
      h ^= h << 13; h >>>= 0;
      h ^= h >>> 17;
      h ^= h << 5; h >>>= 0;
      out += ALPHABET[(h >>> 26) % ALPHABET.length]; // البتّات العليا
    }
    return out;
  }
}

/** ref الصفحة: يُشتقّ من المسار آلياً — لا يُكتب يدوياً فلا يُنسى ولا يتضارب */
export function refFromPath(path?: string | null): string {
  // الفكّ إلزامي: المسار العربي يصل مُرمَّزاً، وبلا فكّه يقصّ حدّ الـ٤٨ حرفاً
  // داخل الترميز فتتطابق مراجع صفحات مختلفة (قِيس: ٣ صفحات قطاعات ⇒ مرجع واحد).
  let p = String(path || '/').split('?')[0];
  try { p = decodeURIComponent(p); } catch { /* ترميز تالف — نُبقيه كما هو */ }
  p = p.replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  return p.replace(/^\/+/, '').replace(/\//g, '-').slice(0, 48) || 'home';
}

/**
 * هل رفض الزائر القياس؟ — يحكم ما يُخزَّن من طلب الزيارة أو نقرة واتساب.
 *
 * مصدران: إشارة المتصفّح في ترويسات الطلب نفسه (`Sec-GPC: 1` · `DNT: 1`)، أو علَم
 * صريح ترسله الواجهة حين يكون الإيقاف من زرّ «إيقاف القياس» أو من تخزين محلي محجوب
 * (وهما لا يظهران في الترويسات). عند الرفض لا تُشتقّ بصمة IP ولا يُرسل العنوان لخدمة
 * تحديد الموقع ولا تُحفظ المعرّفات — وهذا ما تَعِد به سياسة الخصوصية (القسم ٧).
 */
export function requestOptedOut(headers: Record<string, unknown> | null | undefined, flag?: unknown): boolean {
  if (flag === true || flag === '1' || flag === 1) return true;
  const h = (k: string) => String((headers || {})[k] ?? '').trim();
  return h('sec-gpc') === '1' || h('dnt') === '1';
}

/** وسم فصل الغرض: الملح المشتقّ من JWT_SECRET لا يصلح لغير بصمة IP، ولا يكشف السرّ نفسه */
const IP_SALT_LABEL = 'fieldsa:visit-ip-fingerprint-salt:v1';

/**
 * ملح بصمة IP — سرّي دائماً، أو null إن لم يوجد سرّ.
 *
 * لماذا لا ملح افتراضي في الكود: فضاء IPv4 نحو 2^32 عنوان، فمن يعرف الملح يعكس البصمة
 * بتجربة كل العناوين في دقائق. والملح المكتوب في مستودع عام معروف للجميع، فتصير «البصمة
 * بدل العنوان» شكلية. الترتيب: `IP_SALT` إن ضُبط؛ وإلا ملح مشتقّ بـHMAC من `JWT_SECRET`
 * (مضبوط في الإنتاج وتتوقّف المصادقة بدونه)؛ وإلا null فلا تُحفظ بصمة أصلاً.
 *
 * ⚠️ تغيير الملح (ضبط IP_SALT لاحقاً أو تدوير JWT_SECRET) يغيّر بصمات الزوّار أنفسهم، فيُعدّ
 * الزائر العائد مرّتين في «الزوّار الفريدون» لأي نافذة تعبر لحظة التغيير (حتى ٩٠ يوماً).
 */
export function ipSalt(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.IP_SALT;
  if (explicit && explicit.trim()) return explicit;
  const base = env.JWT_SECRET;
  if (!base || !base.trim()) return null;
  return createHmac('sha256', base).update(IP_SALT_LABEL).digest('hex');
}

/** بصمة IP للزيارة (16 خانة ست عشرية) — null بلا عنوان أو بلا ملح سرّي */
export function ipFingerprint(ip: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  if (!ip) return null;
  const salt = ipSalt(env);
  if (!salt) return null;
  return createHash('sha256').update(ip + salt).digest('hex').slice(0, 16);
}

/**
 * رابط تحديد الدولة والمدينة من ip-api — أو null إن لم يكن العنوان IP صالحاً.
 *
 * بلا `IPAPI_KEY` الرابط مطابق حرفياً لما قبل المفتاح (نقطة HTTP المجانية). العنوان يُدرج
 * خاماً لا مُرمَّزاً: `encodeURIComponent` يحوّل نقطتي IPv6 إلى `%3A` فيتغيّر الطلب، والتحقّق
 * بـ`isIP` يضمن ألا يحوي العنوان إلا أرقاماً ونقاطاً ونقطتين (لا حقن في المسار من X-Forwarded-For).
 */
export function geoLookupUrl(ip: string, apiKey?: string | null): string | null {
  if (!ip || isIP(ip) === 0 || !/^[0-9a-fA-F.:]+$/.test(ip)) return null;
  const fields = 'status,country,countryCode,regionName,city';
  const key = (apiKey || '').trim();
  return key
    ? `https://pro.ip-api.com/json/${ip}?fields=${fields}&key=${encodeURIComponent(key)}`
    : `http://ip-api.com/json/${ip}?fields=${fields}`;
}
