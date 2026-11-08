import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clusterAlternates, i18nPages, type Alternate, type PublishedLocale, type PublishedRegistry,
} from './i18nRoutes.mjs';
import {
  isSitemapIndex, childLocs, mergedUrlsetFromFile, mergedUrlsetFromGit, mergedUrlsetFromUrl, urlBlocks,
} from '../../scripts/sitemap-files.mjs';
// @ts-ignore -- لا ملف تعريف لـgen-robots.mjs؛ الأنواع مثبّتة بالتحويل أدناه
import * as robotsMod from '../../scripts/gen-robots.mjs';

/**
 * حرّاس I3 للطبقة متعددة اللغات (spec-b §٨.٤): الخرائط وعناقيد الصفحات القديمة وrobots.
 *
 * sitemap.xml صار فهرساً، وكل مستهلك يقرأ <url> أبنائه مدموجةً (scripts/sitemap-files.mjs) — دمجٌ يُسقط كتلة
 * يجعل الحرّاس خضراء بلا فحص. وعناقيد الرئيسية وabout وcontact صارت من clusterAlternates في prerender والخريطة
 * معاً: بلا لغة جديدة منشورة يجب أن تطابق ما كانت تكتبه hreflangFor وalt() حرفاً بحرف (الصفحات القائمة لا تتغيّر).
 */

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const ORIGIN = 'https://fieldsa.net';

// ── نسخ حرفية من السكربتين قبل الطبقة (gen-sitemap.mjs: canon وurlsOf وxDefaultOf وalt؛ prerender.mjs: hreflangFor) ──
const canon = (url: string) => {
  const m = String(url).match(/^(https?:\/\/[^/]+)(\/[^#?]*)?([#?].*)?$/);
  if (!m) return url;
  const [, origin, p = '/', rest = ''] = m;
  if (/\.[a-z0-9]{2,5}$/i.test(p)) return url;
  return p.endsWith('/') ? origin + p + rest : origin + p + '/' + rest;
};
type L5 = 'ar' | 'en' | 'fr' | 'tr' | 'zh';
const urlsOf = (arPath: string): Record<L5, string> => {
  const suffix = arPath === '/' ? '' : arPath;
  return {
    ar: canon(ORIGIN + (arPath === '/' ? '/' : arPath)),
    en: canon(ORIGIN + '/en' + suffix),
    fr: canon(ORIGIN + '/fr' + suffix),
    tr: canon(ORIGIN + '/tr' + suffix),
    zh: canon(ORIGIN + '/zh' + suffix),
  };
};
const xDefaultOf = (langs: L5[]) => (langs.includes('en') ? 'en' : langs.includes('ar') ? 'ar' : langs[0]);
const alt = (arPath: string, langs: L5[]) => {
  if (langs.length < 2) return '';
  const u = urlsOf(arPath);
  const line = {
    ar: `    <xhtml:link rel="alternate" hreflang="ar" href="${u.ar}"/>`,
    en: `    <xhtml:link rel="alternate" hreflang="en" href="${u.en}"/>`,
    fr: `    <xhtml:link rel="alternate" hreflang="fr" href="${u.fr}"/>`,
    tr: `    <xhtml:link rel="alternate" hreflang="tr" href="${u.tr}"/>`,
    zh: `    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${u.zh}"/>`,
  };
  return [...langs.map((L) => line[L]), `    <xhtml:link rel="alternate" hreflang="x-default" href="${u[xDefaultOf(langs)]}"/>`].join('\n');
};
const HREFLANG_CODE: Record<string, string> = { zh: 'zh-Hans' };
const langUrl = (L: L5, p: string) => canon(`${ORIGIN}${L === 'ar' ? '' : '/' + L}${p}`);
const hreflangFor = (blogPath: string, langs: L5[]) => (langs.length < 2 ? '' : langs
  .map((L) => `\n    <link rel="alternate" hreflang="${HREFLANG_CODE[L] || L}" href="${langUrl(L, blogPath)}" data-seo-alt="1"/>`)
  .join('') + `\n    <link rel="alternate" hreflang="x-default" href="${langUrl(xDefaultOf(langs), blogPath)}" data-seo-alt="1"/>`);

// ── الصيغتان الجديدتان: نسخ حرفية يُفرض أدناه وجودها في السكربتين نفسيهما ──
const XHTML_LINES_SRC = 'const xhtmlLines = (alternates) => alternates\n  .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}"/>`).join(\'\\n\');';
const HREFLANG_TAGS_SRC = 'const hreflangTags = (list) => list.map((a) => `\\n    <link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" data-seo-alt="1"/>`).join(\'\');';
const xhtmlLines = (alternates: Alternate[]) => alternates
  .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}"/>`).join('\n');
const hreflangTags = (list: Alternate[]) => list.map((a) => `\n    <link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" data-seo-alt="1"/>`).join('');

// ── سجلات مُحاكاة داخل الاختبار (لا تُكتب على القرص) ──
const locale = (code: string, over: Partial<PublishedLocale> = {}): PublishedLocale => ({
  code, hreflang: code, name: code, nativeName: code, dir: 'ltr', legacy: false, tier: 'B', ogLocale: `${code}_XX`, intlLocale: code,
  slug: 'van-sales-software', pages: ['home', 'category', 'countries', 'about', 'contact'], waLabel: 'WhatsApp', contentDate: '2026-11-08', ...over,
});
const EN_ONLY: PublishedRegistry = {
  waveMax: 1, generatedAt: '2026-11-08', simulated: true,
  locales: [locale('en', { name: 'English', nativeName: 'English', legacy: true, tier: 'A', ogLocale: 'en_US', pages: ['category', 'countries'] })],
};
const WITH_ES: PublishedRegistry = {
  ...EN_ONLY,
  locales: [...EN_ONLY.locales, locale('es', { name: 'Spanish', nativeName: 'Español', tier: 'A', slug: 'software-preventa-autoventa' })],
};

test('الصيغتان الجديدتان مكتوبتان حرفياً في gen-sitemap وprerender (النسخ هنا لا تنحرف عنهما)', () => {
  assert.ok(read('scripts', 'gen-sitemap.mjs').includes(XHTML_LINES_SRC), 'xhtmlLines في gen-sitemap.mjs تغيّرت عن نسخة الاختبار');
  assert.ok(read('scripts', 'prerender.mjs').includes(HREFLANG_TAGS_SRC), 'hreflangTags في prerender.mjs تغيّرت عن نسخة الاختبار');
});

test('ثبات الصفحات القديمة: بلا لغة جديدة منشورة، عناقيد / وabout وcontact مطابقة حرفياً لما قبل الطبقة', () => {
  const five: L5[] = ['ar', 'en', 'fr', 'tr', 'zh'];
  const three: L5[] = ['ar', 'en', 'fr'];
  // الخريطة (alt في gen-sitemap)
  assert.equal(xhtmlLines(clusterAlternates('home', EN_ONLY)), alt('/', five));
  assert.equal(xhtmlLines(clusterAlternates('about', EN_ONLY)), alt('/about', three));
  assert.equal(xhtmlLines(clusterAlternates('contact', EN_ONLY)), alt('/contact', three));
  // HTML المُصيَّر (hreflangFor وtrilingualHreflang في prerender)
  assert.equal(hreflangTags(clusterAlternates('home', EN_ONLY)), hreflangFor('/', five));
  assert.equal(hreflangTags(clusterAlternates('about', EN_ONLY)), hreflangFor('/about', three));
  assert.equal(hreflangTags(clusterAlternates('contact', EN_ONLY)), hreflangFor('/contact', three));
  // صفحتا en الجديدتان بلا عنقود (لغة واحدة)
  assert.deepEqual(clusterAlternates('category', EN_ONLY), []);
  assert.deepEqual(clusterAlternates('countries', EN_ONLY), []);
});

test('إضافة es: /es/ في عنقود الرئيسيات الخمس، و/es/ تعلنها كلها، وx-default يبقى /en/', () => {
  const home = clusterAlternates('home', WITH_ES);
  const hrefs = home.filter((a) => a.hreflang !== 'x-default').map((a) => a.href);
  assert.deepEqual(hrefs, [`${ORIGIN}/`, `${ORIGIN}/en/`, `${ORIGIN}/fr/`, `${ORIGIN}/tr/`, `${ORIGIN}/zh/`, `${ORIGIN}/es/`]);
  assert.equal(home.find((a) => a.hreflang === 'x-default')?.href, `${ORIGIN}/en/`);
  // العنقود واحد لكل أعضائه (تبادل): صفحة /es/ نفسها مفتاحها home فتعلن الخمس، وكل رئيسية قديمة تعلن /es/
  const esHome = i18nPages(WITH_ES).find((p) => p.path === '/es/');
  assert.equal(esHome?.clusterKey, 'home');
  assert.deepEqual(clusterAlternates(esHome!.clusterKey!, WITH_ES), home);
  // القدامى بصيغتهم الحرفية ثم الجديد قبل x-default
  assert.ok(xhtmlLines(home).startsWith(alt('/', ['ar', 'en', 'fr', 'tr', 'zh']).split('\n').slice(0, 5).join('\n')));
  assert.ok(xhtmlLines(home).includes(`hreflang="es" href="${ORIGIN}/es/"`));
  // about/contact: القدامى الثلاثة ثم es
  assert.deepEqual(clusterAlternates('about', WITH_ES).map((a) => a.hreflang), ['ar', 'en', 'fr', 'es', 'x-default']);
  // الفئة: en وes معاً بـx-default الإنجليزية
  const cat = clusterAlternates('category', WITH_ES);
  assert.deepEqual(cat.map((a) => a.href), [`${ORIGIN}/en/van-sales-software/`, `${ORIGIN}/es/software-preventa-autoventa/`, `${ORIGIN}/en/van-sales-software/`]);
});

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-sitemap-'));
const urlset = (...locs: string[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${locs
  .map((l) => `  <url>\n    <loc>${l}</loc>\n    <lastmod>2026-11-08</lastmod>\n  </url>`).join('\n')}\n</urlset>\n`;
const indexOf = (...names: string[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${names
  .map((n) => `  <sitemap><loc>${ORIGIN}/${n}</loc><lastmod>2026-11-08</lastmod></sitemap>`).join('\n')}\n</sitemapindex>\n`;

test('الدمج: mergedUrlsetFromFile على فهرس وابنين يعيد كل الكتل، والملف العادي كما هو، والابن الغائب يرمي أو يُتخطّى', () => {
  const d = tmpDir();
  try {
    const legacy = urlset(`${ORIGIN}/`, `${ORIGIN}/en/`, `${ORIGIN}/about/`);
    const en = urlset(`${ORIGIN}/en/countries/`, `${ORIGIN}/languages/`);
    fs.writeFileSync(path.join(d, 'sitemap-legacy.xml'), legacy);
    fs.writeFileSync(path.join(d, 'sitemap-en.xml'), en);
    fs.writeFileSync(path.join(d, 'sitemap.xml'), indexOf('sitemap-legacy.xml', 'sitemap-en.xml'));
    const merged = mergedUrlsetFromFile(path.join(d, 'sitemap.xml'));
    assert.equal(isSitemapIndex(merged), false);
    assert.equal(urlBlocks(merged).length, 5);
    assert.deepEqual(urlBlocks(merged), [...urlBlocks(legacy), ...urlBlocks(en)]);
    assert.match(merged, /xmlns:xhtml=/);
    // ابن واحد ⇒ الدمج يعيده حرفياً (الخريطة القديمة كما هي)
    fs.writeFileSync(path.join(d, 'one.xml'), indexOf('sitemap-legacy.xml'));
    assert.equal(mergedUrlsetFromFile(path.join(d, 'one.xml')), legacy);
    // urlset عادي يعود كما هو
    assert.equal(mergedUrlsetFromFile(path.join(d, 'sitemap-en.xml')), en);
    // ابن غائب
    fs.writeFileSync(path.join(d, 'gone.xml'), indexOf('sitemap-legacy.xml', 'sitemap-xx.xml'));
    assert.throws(() => mergedUrlsetFromFile(path.join(d, 'gone.xml')), /sitemap-xx\.xml/);
    assert.equal(urlBlocks(mergedUrlsetFromFile(path.join(d, 'gone.xml'), { onMissing: 'skip' })).length, 3);
    // اسم ابن غير آمن (رجوع إلى الأعلى) لا يُقرأ أبداً
    fs.writeFileSync(path.join(d, 'evil.xml'), indexOf('../secret.xml').replace(`${ORIGIN}/../secret.xml`, `${ORIGIN}/a/..%2Fsecret.txt`));
    assert.throws(() => mergedUrlsetFromFile(path.join(d, 'evil.xml')));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('الدمج من git ومن الشبكة: الابن الغائب في المرجع فارغ، وأبناء الفهرس الحيّ من أصله نفسه', async () => {
  const files: Record<string, string> = {
    'REF:./public/sitemap.xml': indexOf('sitemap-legacy.xml', 'sitemap-es.xml'),
    'REF:./public/sitemap-legacy.xml': urlset(`${ORIGIN}/`),
  };
  const show = (spec: string) => { if (!(spec in files)) throw new Error(`missing ${spec}`); return files[spec]; };
  assert.equal(urlBlocks(mergedUrlsetFromGit('REF', './public/sitemap.xml', show)).length, 1);
  // خريطة قديمة (urlset) في المرجع تعود كما هي
  files['OLD:./public/sitemap.xml'] = urlset(`${ORIGIN}/`, `${ORIGIN}/en/`);
  assert.equal(mergedUrlsetFromGit('OLD', './public/sitemap.xml', show), files['OLD:./public/sitemap.xml']);

  const seen: string[] = [];
  const net: Record<string, string> = {
    'https://staging.example/sitemap.xml': indexOf('sitemap-legacy.xml', 'sitemap-en.xml'),
    'https://staging.example/sitemap-legacy.xml': urlset(`${ORIGIN}/`),
    'https://staging.example/sitemap-en.xml': urlset(`${ORIGIN}/languages/`),
  };
  const get = async (u: string) => {
    seen.push(u);
    const key = u.split('?')[0];
    return key in net ? { status: 200, body: net[key] } : { status: 404, body: '' };
  };
  const ok = await mergedUrlsetFromUrl('https://staging.example/sitemap.xml?nocache=1', get);
  assert.equal(ok.transient, undefined);
  assert.equal('body' in ok && urlBlocks(ok.body).length, 2);
  assert.ok(seen.slice(1).every((u) => u.startsWith('https://staging.example/sitemap-') && /\?nocache=\d+$/.test(u)), seen.join(' '));
  delete net['https://staging.example/sitemap-en.xml'];
  const bad = await mergedUrlsetFromUrl('https://staging.example/sitemap.xml', get);
  assert.equal('status' in bad && bad.status, 404);
  assert.match(String(bad.child), /sitemap-en\.xml/);
});

test('الخرائط الملتزمة: فهرس بأبناء موجودة، لكل لغة منشورة ابن واحد، وكلٌّ ضمن حدود البروتوكول', () => {
  const idx = read('public', 'sitemap.xml');
  assert.ok(isSitemapIndex(idx), 'public/sitemap.xml ليس فهرساً');
  const kids = childLocs(idx);
  assert.ok(kids.length < 50000, `الفهرس ${kids.length} ابناً`);
  assert.equal(kids[0], `${ORIGIN}/sitemap-legacy.xml`, 'الابن الأول sitemap-legacy.xml');
  const reg = JSON.parse(read('src', 'i18n', 'registry', 'published.json')) as PublishedRegistry;
  const codes = [...new Set(i18nPages(reg).map((p) => p.code))];
  assert.deepEqual(kids.slice(1), codes.map((c) => `${ORIGIN}/sitemap-${c}.xml`), 'أبناء اللغات لا تطابق السجل المنشور بترتيبه');
  for (const k of kids) {
    const name = k.split('/').pop()!;
    const f = path.join(root, 'public', name);
    assert.ok(fs.existsSync(f), `ابن غير موجود: public/${name}`);
    const xml = fs.readFileSync(f, 'utf8');
    const n = urlBlocks(xml).length;
    assert.ok(n > 0 && n <= 50000, `${name}: ${n} رابطاً`);
    assert.ok(Buffer.byteLength(xml, 'utf8') <= 50 * 1024 * 1024, `${name} يتجاوز 50MB`);
  }
  // لا ابن يتيم في public لم يعد في الفهرس (لغة سُحب نشرها تُحذف خريطتها)
  const orphans = fs.readdirSync(path.join(root, 'public')).filter((f) => /^sitemap-.+\.xml$/.test(f) && !kids.includes(`${ORIGIN}/${f}`));
  assert.deepEqual(orphans, []);
  // صفحات الطبقة في أبناء اللغات وحدها = i18nPages تماماً
  const i18nLocs = kids.slice(1).flatMap((k) => [...read('public', k.split('/').pop()!).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  assert.deepEqual(i18nLocs.sort(), i18nPages(reg).map((p) => `${ORIGIN}${p.path}`).sort());
});

type RobotsMod = { buildRobots: () => string; problemsOf: (txt: string) => string[]; AGENT_GROUPS: [string, string[]][] };
const { buildRobots, problemsOf, AGENT_GROUPS } = robotsMod as RobotsMod;

test('robots.txt مولَّد: مجموعة واحدة سليمة، والملتزم = ناتج gen-robots، و/signup محجوب للجميع', () => {
  const txt = buildRobots();
  assert.deepEqual(problemsOf(txt), []);
  assert.equal(read('public', 'robots.txt').replace(/\r\n/g, '\n'), txt,'public/robots.txt لا يطابق gen-robots.mjs — لا يُحرَّر يدوياً (npm run seo:robots)');
  const agents = AGENT_GROUPS.flatMap(([, a]) => a);
  assert.equal(new Set(agents.map((a) => a.toLowerCase())).size, agents.length, 'اسم مكرّر');
  for (const a of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended',
    'Applebot-Extended', 'meta-webindexer', 'MistralAI-Index', 'MistralAI-User', 'Bytespider', 'Baiduspider', 'YandexBot', 'PetalBot',
    'Amazonbot', 'DuckAssistBot', 'cohere-ai', 'YouBot']) assert.ok(agents.includes(a), `${a} غائب`);
  assert.equal((txt.match(/^User-agent: \*$/gm) || []).length, 1);
  assert.match(txt, /^Disallow: \/signup$/m);
  assert.match(txt, /^Sitemap: https:\/\/fieldsa\.net\/sitemap\.xml$/m);
  // لا قاعدة بادئة تحجب مسار لغة (/es/ و/ms/ و/mr/…): /m مقيّدة بـ$ و/m/
  assert.ok(!/^Disallow: \/m\s*$/m.test(txt));
});
