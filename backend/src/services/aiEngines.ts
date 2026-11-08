/**
 * سجلّ محرّكات الإجابة والذكاء الاصطناعي — المصدر الوحيد لكل من:
 * - الإسناد على الخادم (services/attribution.ts): القناة `ai_generative` وعمود `visits.aiEngine`.
 * - لوحة المالك (routes/analytics.ts): اسم المحرّك في إحصاء GEO وجدول «المحرّك × الدولة».
 *
 * قبل هذا السجل كانت هناك قائمتان متعارضتان: الإسناد يعرف ٥ محرّكات، واللوحة تعدّ Grok وDeepSeek
 * وMeta AI وغيرها. فزيارة من DeepSeek كانت تظهر «AI» في اللوحة وتُخزَّن `referral` بلا محرّك.
 *
 * ⚠️ قواعد ثابتة:
 * - `id` قيمة مخزّنة في `visits.aiEngine` (VarChar(24)): لا تُغيَّر لمحرّك قائم أبداً، وإلا انقسمت
 *   بياناته التاريخية على اسمين. المعرّفات الخمسة الأولى (chatgpt · perplexity · copilot · gemini ·
 *   claude) محفوظة حرفياً.
 * - `hosts` تُطابَق تامّةً أو نطاقاً فرعياً (`www.perplexity.ai` ⇐ `perplexity.ai`)، لا بـ`includes`:
 *   `so.com` بـincludes تلتقط also.com.
 * - لا يدخل `hosts` نطاق بحث أو تواصل عامّ (google.com · bing.com · ya.ru · naver.com · x.com ·
 *   huggingface.co · kagi.com · search.brave.com)، وإلا صارت كل زيارة بحث «ذكاءً». المساعد الذي
 *   يشارك نطاقاً عامّاً يُعرَّف بمسار في `paths`، ولا يُلتقط إلا حين يصل المُحيل كاملاً بمساره.
 *   سياسة المُحيل الافتراضية في المتصفّحات (strict-origin-when-cross-origin) ترسل الأصل وحده،
 *   فقواعد المسار التقاط انتهازي لا وعد بالتغطية.
 * - `sources` قيم `utm_source` التي تعني هذا المحرّك (إضافةً إلى نطاقاته). اسم علامة يشاركه منتج
 *   غير ذكي (brave · kagi · alice · meta) لا يدخل هنا: `utm_source=meta` إعلان Meta لا Meta AI.
 *
 * التحقّق (٨ نوفمبر ٢٠٢٦): قائمة Matomo المصونة للمساعدات (AIAssistants.yml، آخر تحديث ٣١ أكتوبر
 * ٢٠٢٦) ثم صفحات المزوّد أو تغطية صحفية لكل نطاق خارجها؛ المصدر مذكور بجوار كل مدخل.
 *
 * ما لا يمكن تمييزه بالمُحيل أصلاً (يُحسب بحثاً عضوياً أو مباشراً، ومصدره تقارير المحرّك نفسه):
 * - Google AI Mode وAI Overviews: المُحيل google.com كالبحث (تقرير Search Console وحده يفصلها).
 * - إجابات Copilot داخل bing.com، وSearch Assist في duckduckgo.com، وإجابات Brave في نتائج البحث.
 * - Yandex Yazeka/«Поиск с Алисой» داخل نتائج Yandex، وNaver AI Briefing داخل search.naver.com
 *   (Cue: أُغلق في ٩ أبريل ٢٠٢٦)، وAgent i من LY Corp داخل Yahoo! JAPAN.
 * - مساعدات المتصفّح والتطبيقات بلا مُحيل: Brave Leo وOpera Aria وMeta AI داخل واتساب وتطبيقات
 *   الجوال عموماً — تصل «مباشرة» إلا إن حملت `utm_source` (ChatGPT يضيف `utm_source=chatgpt.com`).
 */

export interface AiEngine {
  /** المعرّف المخزّن في `visits.aiEngine` — ثابت، حروف لاتينية صغيرة وأرقام و`_`، ≤ ٢٤ */
  id: string;
  /** اسم العرض في لوحة المالك */
  label: string;
  /** نطاقات المُحيل: مطابقة تامّة أو نطاق فرعي */
  hosts: readonly string[];
  /** `host/مسار` لمساعد يشارك نطاقاً عامّاً — يُطابَق المسار ببدايته عند حدّ `/` */
  paths?: readonly string[];
  /** قيم `utm_source` الدالّة عليه (تُطبَّع بحروف صغيرة) */
  sources?: readonly string[];
}

export const AI_ENGINES: readonly AiEngine[] = [
  // --- المعرّفات الخمسة الأصلية: قيمها المخزّنة ونطاقاتها كما كانت حرفياً ---
  // OpenAI: «ChatGPT automatically includes utm_source=chatgpt.com» (help.openai.com 12627856).
  // openai.com بنطاقاته الفرعية من القاموس القديم (يشمل labs.openai.com في قائمة Matomo).
  { id: 'chatgpt', label: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com'], sources: ['chatgpt'] },
  { id: 'perplexity', label: 'Perplexity', hosts: ['perplexity.ai'], sources: ['perplexity'] },
  // copilot.cloud.microsoft: عنوان تطبيق Copilot الموحّد (رسالة Microsoft MC1462915، سبتمبر ٢٠٢٦)؛
  // edgeservices.bing.com: الشريط الجانبي في Edge (أدلّة GA4 من Savvy وLovesdata)؛
  // m365.cloud.microsoft يحمل Office كلّه فلا يُقبل إلا بمسار المحادثة.
  // utm_source=copilot.com رُصد في تجربة واحدة غير رسمية (Tygart Media، يونيو ٢٠٢٦).
  {
    id: 'copilot', label: 'Copilot',
    hosts: ['copilot.microsoft.com', 'copilot.cloud.microsoft', 'edgeservices.bing.com'],
    paths: ['m365.cloud.microsoft/chat'],
    sources: ['copilot', 'copilot.com'],
  },
  { id: 'gemini', label: 'Gemini', hosts: ['gemini.google.com', 'bard.google.com'], sources: ['gemini'] },
  { id: 'claude', label: 'Claude', hosts: ['claude.ai'], sources: ['claude'] },

  // --- كانت تُعدّ في اللوحة وحدها وتُخزَّن referral؛ الأسماء نفسها للاستمرارية ---
  // x.com/i/grok في Matomo؛ x.ai من قائمة العرض القديمة
  { id: 'grok', label: 'Grok', hosts: ['grok.com', 'x.ai'], paths: ['x.com/i/grok'], sources: ['grok'] },
  // chat.deepseek.com في Matomo؛ deepseek.com بنطاقاته من قائمة العرض القديمة
  { id: 'deepseek', label: 'DeepSeek', hosts: ['deepseek.com'], sources: ['deepseek'] },
  { id: 'meta_ai', label: 'Meta AI', hosts: ['meta.ai'], sources: ['meta_ai'] },

  // --- جديدة: محرّكات عالمية وإقليمية ---
  // Le Chat صار «Vibe» في ٢٨ مايو ٢٠٢٦ وبقي على chat.mistral.ai (help.mistral.ai 682992)
  { id: 'mistral', label: 'Mistral Vibe (Le Chat)', hosts: ['chat.mistral.ai'], sources: ['mistral', 'lechat'] },
  { id: 'youcom', label: 'You.com', hosts: ['you.com'], sources: ['youcom'] },
  // Duck.ai في Matomo (يوليو ٢٠٢٦)؛ duckduckgo.com بحث لا يُميَّز
  { id: 'duckai', label: 'Duck.ai', hosts: ['duck.ai'], sources: ['duckai'] },
  // Ask Brave على search.brave.com/ask (brave.com/blog/ask-brave، ٢٩ سبتمبر ٢٠٢٥)
  { id: 'brave', label: 'Ask Brave', hosts: [], paths: ['search.brave.com/ask'] },
  // Kagi Assistant على kagi.com/assistant (kagifeedback 6642)؛ kagi.com نفسه محرّك بحث
  { id: 'kagi', label: 'Kagi Assistant', hosts: [], paths: ['kagi.com/assistant'] },
  { id: 'poe', label: 'Poe', hosts: ['poe.com'], sources: ['poe'] },
  // HuggingChat على hf.co/chat وhuggingface.co/chat؛ النطاقان يحملان المستودعات كلها
  { id: 'huggingchat', label: 'HuggingChat', hosts: [], paths: ['huggingface.co/chat', 'hf.co/chat'], sources: ['huggingchat'] },
  { id: 'notebooklm', label: 'NotebookLM', hosts: ['notebooklm.google.com'], sources: ['notebooklm'] },
  { id: 'iask', label: 'iAsk', hosts: ['iask.ai'], sources: ['iask'] },
  // توقّف في ١٦ يناير ٢٠٢٦؛ يبقى ليُسمّى تاريخه (كان في قائمة العرض القديمة)
  { id: 'phind', label: 'Phind', hosts: ['phind.com'], sources: ['phind'] },
  // HUMAIN Chat (ALLaM 34B) على chat.humain.ai — البحث الإقليمي للشرق الأوسط
  { id: 'humain', label: 'HUMAIN Chat', hosts: ['chat.humain.ai'], sources: ['humain'] },

  // --- الصين ---
  { id: 'doubao', label: 'Doubao 豆包', hosts: ['doubao.com'], sources: ['doubao'] },
  { id: 'kimi', label: 'Kimi', hosts: ['kimi.com', 'kimi.moonshot.cn'], sources: ['kimi'] },
  // qianwen.com منذ ٢٤ نوفمبر ٢٠٢٥ (IT之家)؛ chat.qwen.ai الدولي (Matomo)؛ tongyi وqianwen.aliyun الأقدم
  { id: 'qwen', label: 'Qwen 千问', hosts: ['qianwen.com', 'chat.qwen.ai', 'tongyi.aliyun.com', 'qianwen.aliyun.com'], sources: ['qwen', 'tongyi', 'qianwen'] },
  { id: 'yuanbao', label: 'Tencent Yuanbao 元宝', hosts: ['yuanbao.tencent.com'], sources: ['yuanbao'] },
  // yiyan.baidu.com وحده؛ www.baidu.com بحث (وإن دمج إجابات ERNIE)
  { id: 'ernie', label: 'ERNIE 文心', hosts: ['yiyan.baidu.com'], sources: ['ernie', 'yiyan'] },
  // 智谱清言 على chatglm.cn، والعلامة الدولية Z.ai على chat.z.ai
  { id: 'zhipu', label: 'Zhipu ChatGLM / Z.ai', hosts: ['chatglm.cn', 'chat.z.ai'], sources: ['chatglm', 'zhipu'] },
  // 秘塔AI搜索
  { id: 'metaso', label: 'Metaso 秘塔', hosts: ['metaso.cn'], sources: ['metaso'] },

  // --- روسيا وآسيا الوسطى ---
  // alice.yandex.ru عنوان الويب الرسمي؛ ya.ru بحث Yandex فلا يُقبل إلا بمسار /alice
  { id: 'alice', label: 'Yandex Alice', hosts: ['alice.yandex.ru'], paths: ['ya.ru/alice'] },
  { id: 'gigachat', label: 'GigaChat', hosts: ['giga.chat'], sources: ['gigachat'] },

  // --- كوريا ---
  // Kanana على mate.kanana.ai (بيان Kakao، ١٢ نوفمبر ٢٠٢٥)
  { id: 'kanana', label: 'Kakao Kanana', hosts: ['mate.kanana.ai'], sources: ['kanana'] },
  { id: 'wrtn', label: 'Wrtn 뤼튼', hosts: ['wrtn.ai'], sources: ['wrtn'] },
];

/** معرّفات المحرّكات المعروفة بترتيب السجل (أوّلها الخمسة الأصلية) */
export const AI_ENGINE_IDS: readonly string[] = AI_ENGINES.map((e) => e.id);

const BY_ID = new Map(AI_ENGINES.map((e) => [e.id, e]));

/** مطابقة نطاق: تامّة أو نطاق فرعي — `www.perplexity.ai` ⇐ `perplexity.ai`، لا `notperplexity.ai` */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

const normHost = (h: unknown): string => (typeof h === 'string' ? h.trim().toLowerCase().replace(/\.$/, '') : '');

/** محرّك الذكاء من نطاق المُحيل وحده */
export function aiEngineOfHost(host: unknown): string | null {
  const h = normHost(host);
  if (!h) return null;
  for (const e of AI_ENGINES) if (e.hosts.some((d) => hostMatches(h, d))) return e.id;
  return null;
}

/** أطول مسار مُحيل يُفحص — قواعد المسار كلها أقصر منه بكثير */
export const REFERRER_PATH_MAX = 256;

/** مسار يبدأ ببادئة عند حدّ مقطع: `/alice` و`/alice/x` لا `/alicex` */
const pathUnder = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/');

/**
 * محرّك الذكاء من المُحيل: النطاق أولاً، ثم قاعدة `host/مسار` إن وصل المسار.
 * المسار اختياري — غيابه (وهو الغالب) يعني الحكم بالنطاق وحده.
 */
export function aiEngineOfReferrer(host: unknown, path?: unknown): string | null {
  const byHost = aiEngineOfHost(host);
  if (byHost) return byHost;
  const h = normHost(host);
  // المسار مقصوص قبل أي معالجة، والشرطات الأخيرة تُزال بحلقة لا بتعبير نمطي (`/\/+$/` يتراجع
  // تراجعاً تربيعياً على آلاف الشرطات يتلوها محرف — حجب خدمة من مسار عام)
  let p = typeof path === 'string' ? path.slice(0, REFERRER_PATH_MAX).trim().toLowerCase() : '';
  while (p.endsWith('/')) p = p.slice(0, -1);
  if (!h || !p) return null;
  for (const e of AI_ENGINES) {
    for (const rule of e.paths || []) {
      const slash = rule.indexOf('/');
      if (hostMatches(h, rule.slice(0, slash)) && pathUnder(p, rule.slice(slash))) return e.id;
    }
  }
  return null;
}

/**
 * محرّك الذكاء من `utm_source`: أحد أسمائه في `sources` أو أحد نطاقاته.
 *
 * لماذا: ChatGPT يضيف `utm_source=chatgpt.com` إلى الروابط التي يقتبسها، وتطبيقات المساعدات على
 * الجوال لا ترسل مُحيلاً، فلو اكتُفي بالمُحيل لصُنّفت الزيارة «مباشرة».
 */
export function aiEngineOfUtmSource(source: unknown): string | null {
  const s = normHost(source).slice(0, 64);
  if (!s) return null;
  for (const e of AI_ENGINES) if (e.sources?.includes(s)) return e.id;
  return aiEngineOfHost(s);
}

/** اسم العرض لمعرّف مخزّن — المعرّف نفسه إن لم يكن في السجل (لا يختفي محرّك من اللوحة) */
export function aiEngineLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return BY_ID.get(id)?.label ?? id;
}

/** المسار من رابط مُحيل كامل مخزّن — null إن لم يكن رابطاً صالحاً */
export function referrerPathOf(referrer: unknown): string | null {
  if (typeof referrer !== 'string' || !referrer) return null;
  try { return new URL(referrer).pathname || null; } catch { return null; }
}

/**
 * محرّك الذكاء لصفّ زيارة مخزّن (للوحة المالك): من المُحيل أولاً — فتُسمّى زيارات قديمة خُزّنت
 * `referral` قبل دخول محرّكها السجل — وإلا من عمود `aiEngine` لزيارة صُنّفت `ai_generative` بلا
 * مُحيل (مثل `utm_source=chatgpt.com` من تطبيق الجوال)، وإلا لسقطت من إحصاء GEO.
 */
export function aiEngineOfVisit(r: {
  referrerHost?: string | null; referrer?: string | null; channel?: string | null; aiEngine?: string | null;
}): string | null {
  return aiEngineOfReferrer(r.referrerHost, referrerPathOf(r.referrer))
    || (r.channel === 'ai_generative' && r.aiEngine ? r.aiEngine : null);
}
