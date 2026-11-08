/**
 * يولّد public/robots.txt (spec-b §١٠) — يُشغَّل في prebuild ويُلتزم الناتج. **لا يُحرَّر robots.txt يدوياً.**
 *
 * مجموعة واحدة لكل الزواحف (RFC 9309 يجيز عدة أسطر User-agent لمجموعة واحدة): الزاحف المسمّى يقرأ القواعد
 * نفسها التي يقرؤها «*»، فلا تنحرف قواعد مجموعة عن أخرى. كانت مجموعتان، وانحرفتا فعلاً: /signup محجوبة في «*»
 * ومفتوحة لزواحف الذكاء الاصطناعي.
 *
 * الأسماء: موثّقة من مالكيها وحدهم، مجمّعة بالفئة. لا أسماء مجتمعية غير رسمية (نقد GEO، البند 17).
 * كل اسم كان في الملف قبل التوليد باقٍ فيه (geo-audit يحذّر من غياب أي منها).
 *
 * يتوقّف (exit 1) قبل الكتابة إن: تكرّر اسم، أو ظهر «Disallow: /» وحده، أو غابت قاعدة من قواعد التطبيق.
 * verify-sitemap يبقى الحارس الحاجب على المخرَج في postbuild (البند 7، و/signup في MUST_BLOCK).
 *
 * التشغيل: node scripts/gen-robots.mjs [--out <ملف>] [--check]   (الافتراضي public/robots.txt)
 *   --check يقارن الناتج بالملف دون كتابة، ويفشل إن اختلفا (لاختبار أو وركفلو).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://fieldsa.net';

/** الأسماء بالفئة — [عنوان الفئة، [الأسماء]] */
export const AGENT_GROUPS = [
  ['محركات البحث', ['Googlebot', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'SeznamBot', 'PetalBot', 'coccocbot-web', 'Yeti']],
  ['رموز التحكم في استعمال المحتوى للذكاء الاصطناعي (مرحّب بها — لا تُحجب)', ['Google-Extended', 'GoogleOther', 'GoogleOther-Image', 'GoogleOther-Video', 'Google-CloudVertexBot', 'Applebot-Extended', 'YandexAdditional', 'YandexAdditionalBot']],
  ['OpenAI (ChatGPT)', ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User']],
  ['Anthropic (Claude)', ['ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'anthropic-ai', 'claude-web']],
  ['Perplexity', ['PerplexityBot', 'Perplexity-User']],
  ['Meta (Meta AI)', ['meta-webindexer', 'meta-externalagent', 'meta-externalfetcher', 'facebookexternalhit', 'FacebookBot']],
  ['Amazon (Alexa وRufus وBedrock وNova)', ['Amazonbot', 'Amzn-SearchBot', 'Amzn-User', 'NovaAct', 'bedrockbot']],
  ['Mistral (Le Chat)', ['MistralAI-User', 'MistralAI-Index']],
  ['ByteDance / TikTok', ['Bytespider', 'TikTokSpider']],
  ['Huawei (PanGu)', ['PanguBot']],
  ['زواحف ذكاء اصطناعي وأدوات أخرى موثّقة', [
    'cohere-ai', 'cohere-training-data-crawler', 'AI2Bot', 'Ai2Bot-Dolma', 'DuckAssistBot', 'YouBot', 'CCBot', 'Diffbot',
    'Webzio-Extended', 'omgili', 'omgilibot', 'Timpibot', 'ImagesiftBot', 'iaskspider', 'LinerBot', 'QuillBot', 'QualifiedBot',
    'Devin', 'FriendlyCrawler', 'FirecrawlAgent', 'Andibot', 'Kangaroo Bot', 'aiHitBot', 'Cotoyogi', 'Crawlspace',
    'SemrushBot-OCOB', 'ProRataInc',
  ]],
];

/** القواعد — كل سطر كما يُكتب (التعليقات تبقى في الملف شرحاً لمن يقرؤه) */
export const RULE_LINES = [
  'Allow: /',
  '# لوحات الدخول والتطبيق ليست للفهرسة',
  'Disallow: /app',
  'Disallow: /platform',
  'Disallow: /owner',
  'Disallow: /staff',
  '# /rep-app صفحة تنزيل التطبيق العامّة — تُستثنى صراحةً لأن Disallow: /rep قاعدة بادئة تبتلعها',
  'Allow: /rep-app',
  'Disallow: /rep',
  '# /m وحدها و/m/… لا بادئة «/m» العارية (كانت تحجب /meeting/ وبادئات لغات مثل /ms/ و/mr/)',
  'Disallow: /m$',
  'Disallow: /m/',
  'Disallow: /login',
  '# /signup: نموذج بلا صفحة مُصيَّرة (قوقعة الرئيسية لغير مشغّلي JavaScript) — محجوب للجميع بلا استثناء',
  'Disallow: /signup',
  'Disallow: /verify-email',
  'Disallow: /activate',
];

/** قواعد التطبيق التي يجب أن تبقى (غياب أيّ منها يوقف التوليد) */
const REQUIRED_RULES = [
  'Disallow: /app', 'Disallow: /platform', 'Disallow: /owner', 'Disallow: /staff', 'Allow: /rep-app', 'Disallow: /rep',
  'Disallow: /m$', 'Disallow: /m/', 'Disallow: /login', 'Disallow: /signup', 'Disallow: /verify-email', 'Disallow: /activate',
];

export function buildRobots() {
  const lines = [
    '# robots.txt — مولَّد من scripts/gen-robots.mjs (لا يُحرَّر يدوياً)',
    '# مجموعة واحدة: كل زاحف مسمّى يقرأ القواعد نفسها، وأي زاحف آخر يشمله «*».',
    'User-agent: *',
  ];
  for (const [title, agents] of AGENT_GROUPS) {
    lines.push(`# ${title}`);
    for (const a of agents) lines.push(`User-agent: ${a}`);
  }
  lines.push(...RULE_LINES, '', `# دليل الموقع لنماذج الذكاء الاصطناعي: ${ORIGIN}/llms.txt`, `Sitemap: ${ORIGIN}/sitemap.xml`);
  return `${lines.join('\n')}\n`;
}

/** أسباب رفض الناتج (فارغة = سليم) */
export function problemsOf(txt) {
  const out = [];
  const agents = AGENT_GROUPS.flatMap(([, a]) => a);
  const seen = new Map();
  for (const a of agents) {
    const k = a.toLowerCase(); // المطابقة في المعيار بلا حساسية لحالة الأحرف
    if (seen.has(k)) out.push(`اسم مكرّر: ${a} (و${seen.get(k)})`);
    seen.set(k, a);
  }
  const rules = txt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  if (rules.some((l) => /^Disallow:\s*\/\s*$/i.test(l))) out.push('سطر «Disallow: /» يحجب الموقع كاملاً');
  for (const r of REQUIRED_RULES) if (!rules.includes(r)) out.push(`قاعدة تطبيق غائبة: ${r}`);
  // مجموعة واحدة: لا سطر User-agent بعد أول قاعدة
  const firstRule = rules.findIndex((l) => /^(?:allow|disallow)\s*:/i.test(l));
  if (rules.slice(firstRule).some((l) => /^user-agent\s*:/i.test(l))) out.push('أكثر من مجموعة User-agent');
  if (!rules.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)) out.push('سطر Sitemap غائب');
  return out;
}

const isMain = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const outArg = argv.indexOf('--out') >= 0 ? argv[argv.indexOf('--out') + 1] : null;
  const OUT = outArg ? path.resolve(outArg) : path.join(ROOT, 'public/robots.txt');
  const txt = buildRobots();
  const bad = problemsOf(txt);
  if (bad.length) {
    console.error('✗ gen-robots: الناتج مرفوض — لم يُكتب شيء:');
    for (const b of bad) console.error(`    ${b}`);
    process.exit(1);
  }
  const count = AGENT_GROUPS.reduce((n, [, a]) => n + a.length, 0);
  if (argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (cur !== txt) {
      console.error(`✗ ${path.relative(ROOT, OUT) || OUT} لا يطابق ناتج gen-robots — شغّل npm run seo:robots والتزم الناتج`);
      process.exit(1);
    }
    console.log(`✓ robots.txt مطابق للمولّد (${count} زاحفاً مسمّى في مجموعة واحدة)`);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, txt);
  console.log(`✅ robots.txt: مجموعة واحدة بـ${count} زاحفاً مسمّى + «*» ← ${path.relative(ROOT, OUT) || OUT}`);
}
