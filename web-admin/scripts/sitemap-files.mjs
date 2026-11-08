/**
 * قراءة خريطة الموقع بعد تحويلها إلى فهرس (spec-b §٨.١).
 *
 * لماذا وُجد: public/sitemap.xml صار فهرساً (<sitemapindex>) يشير إلى sitemap-legacy.xml وخريطة لكل لغة منشورة
 * (sitemap-en.xml …). وكل مستهلك قديم (verify-sitemap وindexnow وlive-sitemap-check وseo-audit واختبار
 * seoIntegration ووركفلو الصيانة) يقرأ <url> من sitemap.xml مباشرةً — على الفهرس يجد صفر <url> فيصير أخضر
 * **بلا فحص**. هذا المساعد يعيد لكلٍّ منها urlset واحداً يضم <url> الأبناء كلها، فيعمل محلّله الحالي بلا تغيير.
 *
 * الأبناء تُقرأ **من مجلد الفهرس نفسه بالاسم الأخير من <loc>** (لا من النطاق المكتوب فيه): الفهرس في dist يُفحص
 * مقابل أبنائه في dist، وفي public مقابل public، وحيّاً مقابل الأصل المجلوب منه (--origin في الفحص الحيّ).
 * ملف urlset عادي (خريطة قديمة في git مثلاً) يعود كما هو.
 *
 * بلا استيراد من src/: وركفلو الصيانة يجلب scripts/ وحدها في مهمة ما بعد النشر (sparse-checkout).
 *
 * CLI: node scripts/sitemap-files.mjs --merge <index> [--out <file>]   (بلا --out يُطبع على stdout)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** رأس urlset الحالي حرفياً (gen-sitemap) — بمساحات أسماء xhtml وimage */
export const URLSET_OPEN = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">';

export const isSitemapIndex = (xml) => /<sitemapindex\b/.test(xml);
export const childLocs = (xml) => [...String(xml).matchAll(/<sitemap>\s*<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);

/** اسم ملف الابن: آخر مقطع من مسار <loc> — اسم آمن وحده (لا مسار ولا رجوع إلى الأعلى)، وإلا null */
export function childName(loc) {
  const raw = String(loc).replace(/&amp;/g, '&');
  let p = raw;
  try { p = new URL(raw, 'https://fieldsa.net/').pathname; } catch { /* يبقى كما هو */ }
  const name = p.split('/').pop() || '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.xml$/.test(name) ? name : null;
}

/** كتل <url>…</url> كما هي من urlset واحد */
export const urlBlocks = (xml) => [...String(xml).matchAll(/<url>[\s\S]*?<\/url>/g)].map((m) => m[0]);

/** urlset واحد من عدة urlset (أو فراغات لابن غائب) — بالرأس الحالي نفسه */
export function mergeUrlsets(xmls) {
  const blocks = xmls.flatMap((x) => urlBlocks(x || ''));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${URLSET_OPEN}\n${blocks.map((b) => `  ${b}`).join('\n')}\n</urlset>\n`;
}

/**
 * أبناء فهرس على القرص: [{loc, name, file, exists}] — file بجانب الفهرس بالاسم الأخير من <loc>.
 * name=null لـ<loc> لا يصلح اسمَ ملف (يُعدّ غائباً).
 */
export function childFilesOf(indexFile, xml = fs.readFileSync(indexFile, 'utf8')) {
  const dir = path.dirname(indexFile);
  return childLocs(xml).map((loc) => {
    const name = childName(loc);
    const file = name ? path.join(dir, name) : null;
    return { loc, name, file, exists: !!file && fs.existsSync(file) };
  });
}

/**
 * urlset واحد يضم <url> كل الخرائط الفرعية (أو الملف نفسه إن كان urlset) — المحلّل الحالي لكل سكربت يعمل عليه بلا تغيير.
 * onMissing: 'throw' (الافتراضي) يرمي بأسماء الأبناء الغائبة · 'skip' يدمج الموجود وحده (verify-sitemap يبلّغ عن الغائب بنفسه).
 */
export function mergedUrlsetFromFile(indexFile, { onMissing = 'throw' } = {}) {
  const xml = fs.readFileSync(indexFile, 'utf8');
  if (!isSitemapIndex(xml)) return xml;
  const kids = childFilesOf(indexFile, xml);
  const missing = kids.filter((k) => !k.exists);
  if (missing.length && onMissing !== 'skip') {
    throw new Error(`فهرس الخريطة ${indexFile} يشير إلى أبناء غير موجودة بجانبه: ${missing.map((k) => k.name || k.loc).join(', ')}`);
  }
  return mergeUrlsets(kids.filter((k) => k.exists).map((k) => fs.readFileSync(k.file, 'utf8')));
}

/**
 * النسخة الحيّة: get(url, opts) هو دالة الجلب نفسها في live-sitemap-check — تعيد {status, body, location}
 * أو {transient: true, error}. الأبناء تُجلب من أصل الفهرس المجلوب (لا من النطاق المكتوب في <loc>) مع nocache.
 * يعيد بالشكل نفسه: {status: 200, body: urlset مدموج, children: N} عند النجاح، وإلا ردّ أول جلب فشل
 * (الفهرس أو ابن) ومعه child = رابط الابن إن كان الفاشل ابناً.
 */
export async function mergedUrlsetFromUrl(indexUrl, get, opts) {
  const r = await get(indexUrl, opts);
  if (r.transient || r.status !== 200) return r;
  if (!isSitemapIndex(r.body)) return { ...r, children: 0 };
  const parts = [];
  const locs = childLocs(r.body);
  for (const loc of locs) {
    const name = childName(loc);
    if (!name) return { status: 0, body: '', location: '', child: loc, error: `<loc> لا يصلح اسم ملف: ${loc}` };
    const u = new URL(name, indexUrl);
    u.search = `nocache=${Date.now()}`;
    const c = await get(u.href, opts);
    if (c.transient || c.status !== 200) return { ...c, child: u.href };
    parts.push(c.body);
  }
  return { status: 200, location: '', body: mergeUrlsets(parts), children: locs.length };
}

/**
 * النسخة من git: gitShow(spec) تعيد محتوى `${ref}:${مسار}` أو ترمي. الفهرس الغائب يرمي (المنادي يقرّر)،
 * والابن الغائب = فارغ (أول ظهوره في الالتزام التالي يجعل روابطه «مضافة» — وهو الصحيح).
 * indexRel نسبيّ بشرطات أمامية (مثل ./public/sitemap.xml).
 */
export function mergedUrlsetFromGit(ref, indexRel, gitShow) {
  const xml = gitShow(`${ref}:${indexRel}`);
  if (!isSitemapIndex(xml)) return xml;
  const dir = path.posix.dirname(indexRel);
  const parts = childLocs(xml).map((loc) => {
    const name = childName(loc);
    if (!name) return '';
    try { return gitShow(`${ref}:${dir}/${name}`); } catch { return ''; }
  });
  return mergeUrlsets(parts);
}

// ───────── CLI ─────────
const isMain = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const src = opt('--merge');
  if (!src) {
    console.error('الاستخدام: node scripts/sitemap-files.mjs --merge <index> [--out <file>]');
    process.exit(2);
  }
  let merged;
  try { merged = mergedUrlsetFromFile(path.resolve(src)); } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  const out = opt('--out');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), merged);
    console.error(`✓ ${urlBlocks(merged).length} رابطاً مدموجاً ← ${out}`);
  } else {
    process.stdout.write(merged);
  }
}
