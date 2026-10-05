/**
 * حارس الخريطة والروابط — يفحص **مخرجات dist/** بعد prerender، لا الشيفرة المصدرية.
 *
 * لماذا وُجد (أكتوبر 2026): كانت التدقيقات كلها خضراء يومياً بينما على الموقع الحي
 * 16 رابطاً تركياً وصينياً في الخريطة تخدم قوقعة الرئيسية بـcanonical يشير إلى «/»،
 * وروابط داخلية بلاحقة ‎-region‎ إلى صفحات غير موجودة، و45 صورة مشاركة (og) ترجع 404.
 * لم يكن أي حارس يربط الخريطة بما صُيِّر فعلاً: seo-audit يقرأ المصدر، وverify-schema
 * وverify-pricing وverify-claims تفحص النص لا الروابط. ووقع العطل نفسه في 5 أغسطس
 * (17 صفحة عربية صارت قوقعة) ولم يكتشفه فحص آلي.
 *
 * يفشل (exit 1) إذا:
 *   1) رابط في الخريطة بلا صفحة مُصيَّرة dist/<المسار>/index.html، أو بلا نسخته المرمَّزة
 *      للمسارات العربية (خادم Render يبحث بالمسار المرمَّز — انظر writeRoute في prerender.mjs).
 *   2) canonical الصفحة لا يساوي رابطها في الخريطة، أو الصفحة noindex.
 *   3) مجموعة hreflang في الصفحة تخالف بدائل الرابط في الخريطة.
 *   4) صورة مشاركة (og:image / twitter:image) أو <img> محلية أو image:loc غير موجودة في dist.
 *   5) رابط داخلي <a href> **مصدره المستودع** يشير إلى صفحة غير مُصيَّرة وليس مسار تطبيق معروفاً،
 *      أو رابط بلاحقة ‎-region‎.
 *
 * ويُحذّر دون إفشال (تصحيح الناقد 15): الروابط المعطوبة داخل نص مقالات CMS (contentHtml)،
 * لأن المالك يحرّرها من اللوحة، ولا يصحّ أن يُسقط تحريرُه نشرَ الموقع كله. الإسناد:
 *   - ما داخل <article> في صفحة مقال يدوي (ليس من الكتالوج) ⇒ نصّ CMS.
 *   - ورابط يوجد حرفياً في نصوص CMS الحيّة على صفحة ليست من الكتالوج ⇒ نصّ CMS.
 *   - وكل ما سواه (القوالب، الكتالوج، صفوف الروابط في prerender) ⇒ المستودع، فهو حاجب.
 *
 * التشغيل: node scripts/verify-sitemap.mjs [--dist <مجلد>] [--sitemap <ملف>] [--verbose]   (ضمن postbuild، بعد verify-schema)
 * وضع التحذير المؤقت: SEO_SITEMAP_WARN=1 يطبع الأخطاء ولا يُفشل البناء — لدمج البنود بالتدريج فقط.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://fieldsa.net';
const CMS_API = 'https://api.fieldsa.net/api/site-content';

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const DIST = path.resolve(argOf('--dist') || path.join(ROOT, 'dist'));
const SITEMAP = argOf('--sitemap')
  || (fs.existsSync(path.join(DIST, 'sitemap.xml')) ? path.join(DIST, 'sitemap.xml') : path.join(ROOT, 'public/sitemap.xml'));
const WARN_ONLY = process.env.SEO_SITEMAP_WARN === '1';
/** --verbose يطبع كل البنود لا أول ثمانية من كل فئة */
const VERBOSE = argv.includes('--verbose');

/**
 * مسارات التطبيق: يخدمها React وحده ولا يُتوقَّع لها تصيير مسبق — الرابط إليها مشروع.
 * ⚠️ لا يُضاف هنا مسار تسويقي (about/contact/pricing بلغة ما): غياب صفحته المُصيَّرة هو العطل نفسه
 * الذي وُجد الحارس لكشفه (/tr/about كانت تعيد قوقعة الرئيسية بـcanonical «/»).
 * ولا تُضاف صفحات المالك الداخلية: رابطٌ إليها من صفحة تسويقية خللٌ يستحق أن يُكشف.
 */
const APP_ROUTES = [
  /^\/(?:(?:en|fr|tr|zh)\/)?subscribe-request\/?$/,
  /^\/(?:signup|login|verify-email|tutorial|profile|rep|m|ax)\/?$/,
  /^\/payment\/success\/?$/,
  /^\/app(?:\/.*)?$/,
  /^\/(?:c|pay|e)\/[^/]+(?:\/.*)?$/,
];

// ───────── أدوات ─────────
const decodeEntities = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** سمات وسم HTML واحد ← كائن (الأسماء بأحرف صغيرة، القيم بعد فكّ الكيانات) */
function attrsOf(tag) {
  const o = {};
  const body = tag.replace(/^<\s*[a-zA-Z0-9-]+/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    o[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return o;
}
const tagsOf = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => ({ tag: m[0], index: m.index, a: attrsOf(m[0]) }));

/** مقارنة الروابط بعد توحيد الترميز: «/مزايا/x/» و«/%D9%85.../x/» رابط واحد */
const normUrl = (u, base = ORIGIN + '/') => { try { return new URL(u, base).href; } catch { return String(u); } };

/** مسار URL داخلي (مفكوك الترميز) أو null للخارجي */
function internalPath(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.hostname !== 'fieldsa.net' && u.hostname !== 'www.fieldsa.net') return null;
  return safeDecode(u.pathname);
}

const existsCache = new Map();
const exists = (p) => {
  if (!existsCache.has(p)) existsCache.set(p, fs.existsSync(p));
  return existsCache.get(p);
};
/** ملف الصفحة المُصيَّرة لمسار مفكوك الترميز */
const pageFile = (p) => {
  const rel = p.replace(/^\/+|\/+$/g, '');
  return rel ? path.join(DIST, ...rel.split('/'), 'index.html') : path.join(DIST, 'index.html');
};
const isRendered = (p) => exists(pageFile(p));
/** نسخة المسار المرمَّزة التي يبحث عنها خادم Render (writeRoute في prerender.mjs) */
const encodedTwin = (p) => {
  const enc = p.split('/').map((s) => (/[^\x00-\x7F]/.test(s) ? encodeURIComponent(s) : s)).join('/');
  return pageFile(enc);
};
const assetExists = (p) => exists(path.join(DIST, ...p.replace(/^\/+/, '').split('/')));
const hasExt = (p) => /\.[a-z0-9]{2,5}$/i.test(p);

// ───────── التجميع ─────────
const issues = new Map(); // key → {level, title, items: []}
function report(level, key, title, item) {
  const k = `${level}:${key}`;
  if (!issues.has(k)) issues.set(k, { level, title, count: 0, items: [] });
  const e = issues.get(k);
  e.count++;
  if (VERBOSE || e.items.length < 8) e.items.push(item);
}
const rel = (f) => path.relative(DIST, f).split(path.sep).join('/') || 'index.html';

// ───────── المدخلات ─────────
if (!fs.existsSync(DIST)) {
  console.error('✗ لا يوجد dist/ — شغّل npm run build أولاً');
  process.exit(1);
}
if (!fs.existsSync(SITEMAP)) {
  console.error(`✗ لا توجد خريطة الموقع (${SITEMAP}) — شغّل gen-sitemap أولاً`);
  process.exit(1);
}

/** slugs الكتالوج (المستودع) — كل صفحة مدوّنة خارجها مقال يدوي مصدره CMS */
let catalogSlugs = new Set();
try {
  const cat = await import(pathToFileURL(path.join(ROOT, 'src/blog/seo/catalog.mjs')).href);
  catalogSlugs = new Set(cat.buildCatalog().map((x) => x.slug));
} catch (e) {
  console.warn(`  ⚠ تعذّر تحميل الكتالوج (${e.message}) — كل صفحات المدوّنة تُعامَل مقالات يدوية`);
}

/** روابط نصوص CMS الحيّة (مسارات مفكوكة بلا شرطة أخيرة) — تعذّر الجلب ⇒ الإسناد البنيوي وحده */
let cmsHrefs = null;
for (let attempt = 0; attempt < 2 && !cmsHrefs; attempt++) {
  try {
    const r = await fetch(CMS_API, { signal: AbortSignal.timeout(10000) });
    const data = (await r.json())?.data;
    if (data && typeof data === 'object') {
      cmsHrefs = new Set();
      const walk = (v) => {
        if (typeof v === 'string') {
          for (const m of v.matchAll(/href\s*=\s*["']([^"']+)["']|\]\((\/[^)\s]+|https?:\/\/(?:www\.)?fieldsa\.net[^)\s]*)\)/g)) {
            const p = internalPath(m[1] || m[2], ORIGIN + '/');
            if (p) cmsHrefs.add(p.replace(/\/+$/, '') || '/');
          }
        } else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(data);
    }
  } catch { /* محاولة ثانية ثم إسناد بنيوي */ }
}

// ───────── 1) الخريطة ← الصفحات ─────────
const xml = fs.readFileSync(SITEMAP, 'utf8');
const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => {
  const b = m[1];
  return {
    loc: decodeEntities((b.match(/<loc>\s*([^<]+?)\s*<\/loc>/) || [])[1] || ''),
    alts: [...b.matchAll(/<xhtml:link\b[^>]*>/g)].map((t) => attrsOf(t[0])).filter((a) => a.hreflang),
    images: [...b.matchAll(/<image:loc>\s*([^<]+?)\s*<\/image:loc>/g)].map((x) => decodeEntities(x[1])),
  };
});
const locSet = new Set(entries.map((e) => normUrl(e.loc)));
const seenLoc = new Set();

for (const e of entries) {
  const loc = e.loc;
  const where = safeDecode(loc.replace(ORIGIN, '')) || '/';
  const n = normUrl(loc);
  if (seenLoc.has(n)) report('error', 'dup-loc', 'رابط مكرّر في الخريطة', where);
  seenLoc.add(n);
  let u;
  try { u = new URL(loc); } catch { report('error', 'bad-loc', 'رابط غير صالح في الخريطة', loc); continue; }
  if (u.origin !== ORIGIN) { report('error', 'foreign-loc', 'رابط خارج fieldsa.net في الخريطة', loc); continue; }
  const p = safeDecode(u.pathname);
  if (/-region(?:\/|$)/.test(p)) report('error', 'region', 'رابط بلاحقة ‎-region‎ (صفحة غير موجودة)', `الخريطة ← ${where}`);
  if (!p.endsWith('/') && !hasExt(p)) report('error', 'loc-slash', 'رابط في الخريطة بلا شرطة أخيرة (Render يخدم القوقعة)', where);

  // بدائل الخريطة نفسها: كل بديل يجب أن يكون <loc> (وإلا عنقود يشير إلى صفحة لا نعلنها)
  for (const a of e.alts) {
    if (!locSet.has(normUrl(a.href))) report('error', 'alt-not-loc', 'بديل hreflang في الخريطة ليس رابطاً فيها', `${where} ← ${a.hreflang}: ${safeDecode(a.href)}`);
  }
  for (const img of e.images) {
    const ip = internalPath(img, ORIGIN + '/');
    if (ip && !assetExists(ip)) report('error', 'sitemap-image', 'صورة في الخريطة (image:loc) غير موجودة في dist', `${where} ← ${ip}`);
  }

  const file = pageFile(p);
  if (!exists(file)) {
    report('error', 'no-page', 'رابط في الخريطة بلا صفحة مُصيَّرة (الزاحف يتسلّم قوقعة الرئيسية)', where);
    continue;
  }
  if (/[^\x00-\x7F]/.test(p) && !exists(encodedTwin(p))) {
    report('error', 'no-encoded', 'صفحة عربية بلا نسختها المرمَّزة (Render يبحث بالمسار المرمَّز فيخدم القوقعة)', where);
  }
  const html = fs.readFileSync(file, 'utf8');
  const head = html.slice(0, Math.max(html.search(/<body\b/i), 0) || html.length);
  const links = tagsOf(head, 'link');
  const canon = links.filter((l) => (l.a.rel || '').toLowerCase().split(/\s+/).includes('canonical'));
  if (canon.length !== 1) {
    report('error', 'canonical-count', 'عدد وسوم canonical في الصفحة ليس واحداً', `${where} (${canon.length})`);
  } else if (normUrl(canon[0].a.href, loc) !== n) {
    report('error', 'canonical', 'canonical الصفحة لا يشير إلى رابطها في الخريطة', `${where} ← ${safeDecode(canon[0].a.href)}`);
  }
  const robots = tagsOf(head, 'meta').find((m) => (m.a.name || '').toLowerCase() === 'robots');
  if (robots && /noindex/i.test(robots.a.content || '')) report('error', 'noindex', 'صفحة noindex داخل الخريطة (إشارة متناقضة)', where);

  // hreflang: الصفحة = الخريطة. صفحة بلا وسوم والخريطة تعلن لها بدائل خللٌ أيضاً: useSeo يكتب عندها
  // عنقوده الخاص بعد الإقلاع (seoUrls) فيختلف ما يراه الزاحف المُشغِّل للجافاسكربت عمّا في الخريطة.
  // والرئيسية العربية وحدها مستثناة: ملفها قوقعة كل مسار غير مُصيَّر، فعنقودٌ فيه يُلصق بصفحات التطبيق.
  const pageAlt = links.filter((l) => (l.a.rel || '').toLowerCase() === 'alternate' && l.a.hreflang)
    .map((l) => `${l.a.hreflang.toLowerCase()} ${normUrl(l.a.href, loc)}`);
  const mapAlt = e.alts.map((a) => `${a.hreflang.toLowerCase()} ${normUrl(a.href)}`);
  // عنقود كل بدائله الصفحةُ نفسها (لغتها + x-default إليها) لا يقول شيئاً فيُعامَل كالغياب:
  // مقال يدوي عربي يحمل «ar + x-default» لنفسه لا يخالف خريطةً بلا بدائل له.
  const trivial = (set) => [...set].every((x) => x.slice(x.indexOf(' ') + 1) === n);
  const pa0 = new Set(pageAlt);
  const ma0 = new Set(mapAlt);
  const pa = trivial(pa0) ? new Set() : pa0;
  const ma = trivial(ma0) ? new Set() : ma0;
  if (pageAlt.length !== pa0.size) report('error', 'hreflang-dup', 'وسم hreflang مكرّر في الصفحة', where);
  if (!pa.size && ma.size) {
    if (p !== '/') report('error', 'hreflang-sitemap-only', 'صفحة بلا وسوم hreflang والخريطة تعلن لها بدائل', where);
  } else {
    const onlyPage = [...pa].filter((x) => !ma.has(x));
    const onlyMap = [...ma].filter((x) => !pa.has(x));
    if (onlyPage.length || onlyMap.length) {
      const fmt = (x) => { const [l, h] = x.split(' '); return `${l}:${safeDecode(h.replace(ORIGIN, ''))}`; };
      report('error', 'hreflang', 'hreflang في الصفحة يخالف بدائل الخريطة',
        `${where} — في الصفحة فقط [${onlyPage.map(fmt).join(' ')}] · في الخريطة فقط [${onlyMap.map(fmt).join(' ')}]`);
    }
  }
}

// ───────── 2) كل صفحة مُصيَّرة: الصور والروابط الداخلية ─────────
function collectHtml(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // assets حزم JS؛ والمجلدات المرمَّزة (%D9...) نسخ مطابقة للمجلدات العربية — فُحص وجودها أعلاه
      if (ent.name === 'assets' || ent.name.includes('%')) continue;
      collectHtml(p, out, depth + 1);
    } else if (/\.html$/i.test(ent.name)) out.push(p);
  }
  return out;
}
const pages = collectHtml(DIST);
let linkCount = 0;

for (const f of pages) {
  const r = rel(f);
  // مسار الصفحة كما تُخدم (index.html ⇒ مجلدها بشرطة)
  const pagePath = '/' + (r.endsWith('index.html') ? r.slice(0, -'index.html'.length) : r);
  const base = ORIGIN + encodeURI(pagePath);
  const raw = fs.readFileSync(f, 'utf8');
  // لا روابط داخل السكربت والأنماط والتعليقات (قوالب JS مثل '+esc(v.payUrl)+' ليست روابط)
  const html = raw.replace(/<script\b[\s\S]*?<\/script>/gi, (m) => ' '.repeat(m.length))
    .replace(/<style\b[\s\S]*?<\/style>/gi, (m) => ' '.repeat(m.length))
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));

  // صفحة مقال يدوي (مصدر نصّه CMS): /blog/<slug>/ أو /en/blog/<slug>/ وslug خارج الكتالوج
  const bm = pagePath.match(/^\/(?:(?:en|fr)\/)?blog\/([^/]+)\/$/);
  const isManual = !!bm && !catalogSlugs.has(bm[1]);
  const isCatalog = !!bm && catalogSlugs.has(bm[1]);
  const art = isManual ? { s: html.search(/<article\b/i), e: html.search(/<\/article>/i) } : null;
  const inArticle = (i) => !!art && art.s >= 0 && i > art.s && (art.e < 0 || i < art.e);
  /** مصدر الرابط: CMS (تحذير) أو المستودع (حاجب) */
  const fromCms = (i, p) => inArticle(i) || (!isCatalog && !!cmsHrefs && cmsHrefs.has(p.replace(/\/+$/, '') || '/'));
  const lvl = (i, p) => (fromCms(i, p) ? 'warn' : 'error');
  const src = (i, p) => (fromCms(i, p) ? ' (نصّ CMS)' : '');

  // صور المشاركة — من القالب دائماً ⇒ حاجبة (og:image وtwitter:image غالباً الصورة نفسها: تُعدّ مرة)
  const ogSeen = new Set();
  for (const m of tagsOf(html, 'meta')) {
    const k = (m.a.property || m.a.name || '').toLowerCase();
    if (k !== 'og:image' && k !== 'twitter:image') continue;
    const ip = internalPath(m.a.content || '', base);
    if (!ip || ogSeen.has(ip)) continue;
    ogSeen.add(ip);
    if (!assetExists(ip)) report('error', 'og', 'صورة مشاركة (og/twitter) غير موجودة في dist — ترجع 404', `${pagePath} ← ${ip}`);
  }
  for (const m of tagsOf(html, 'img')) {
    const s = m.a.src || '';
    if (!s || s.startsWith('data:')) continue;
    const ip = internalPath(s, base);
    if (ip && !assetExists(ip)) report(lvl(m.index, ip), 'img', `صورة <img> محلية غير موجودة في dist${src(m.index, ip)}`, `${pagePath} ← ${ip}`);
  }

  for (const m of tagsOf(html, 'a')) {
    const href = (m.a.href || '').trim();
    if (!href || /^(?:#|mailto:|tel:|sms:|javascript:|data:|whatsapp:)/i.test(href)) continue;
    const p = internalPath(href, base);
    if (p == null) continue;
    linkCount++;
    const shown = `${pagePath} ← ${safeDecode(href)}`;
    if (/-region(?:\/|$)/.test(p)) {
      report(lvl(m.index, p), 'region', `رابط بلاحقة ‎-region‎ (صفحة غير موجودة)${src(m.index, p)}`, shown);
      continue;
    }
    if (hasExt(p)) {
      if (!assetExists(p)) report(lvl(m.index, p), 'file', `رابط إلى ملف غير موجود في dist${src(m.index, p)}`, shown);
      continue;
    }
    if (isRendered(p)) {
      if (!p.endsWith('/')) report('warn', 'no-slash', 'رابط بلا شرطة أخيرة إلى صفحة مُصيَّرة (Render يخدم القوقعة لهذا الشكل)', shown);
      continue;
    }
    if (APP_ROUTES.some((re) => re.test(p))) continue;
    report(lvl(m.index, p), 'broken', `رابط داخلي إلى صفحة غير مُصيَّرة وليس مسار تطبيق (الزاحف يتسلّم قوقعة الرئيسية)${src(m.index, p)}`, shown);
  }
}

// ───────── الخلاصة ─────────
console.log(`فحص الخريطة والروابط: ${entries.length} رابط في الخريطة · ${pages.length} صفحة مُصيَّرة · ${linkCount} رابط داخلي`
  + (cmsHrefs ? '' : ' · ⚠ تعذّر جلب CMS (الإسناد بنيوي وحده)'));
const errors = [...issues.values()].filter((x) => x.level === 'error');
const warns = [...issues.values()].filter((x) => x.level === 'warn');
for (const w of warns) {
  console.warn(`\n  ⚠ تحذير غير حاجب: ${w.title} — ${w.count}`);
  for (const it of w.items) console.warn(`      ${it}`);
}
for (const e of errors) {
  console.error(`\n  ✗ ${e.title} — ${e.count}`);
  for (const it of e.items) console.error(`      ${it}`);
}
if (!errors.length) {
  console.log(warns.length ? '\n✓ الخريطة تطابق المُصيَّر ولا رابط معطوب من المستودع (راجع التحذيرات أعلاه).' : '\n✓ الخريطة تطابق المُصيَّر ولا رابط ولا صورة معطوبة.');
  process.exit(0);
}
const total = errors.reduce((s, e) => s + e.count, 0);
if (WARN_ONLY) {
  console.warn(`\n⚠ وضع التحذير (SEO_SITEMAP_WARN=1): ${total} خلل في ${errors.length} فئة لم يُفشل البناء — أعِد الحارس حاجباً بعد دمج الإصلاحات.`);
  process.exit(0);
}
console.error(`\n✗ فحص الخريطة والروابط فشل: ${total} خلل في ${errors.length} فئة. (المؤقت فقط: SEO_SITEMAP_WARN=1)`);
process.exit(1);
