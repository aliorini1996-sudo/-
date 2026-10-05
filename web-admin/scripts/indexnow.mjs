// IndexNow — إشعار فوري لمحركات البحث (Bing وشركاؤه) بالروابط التي **تغيّرت فعلاً**.
// أهميته لـGEO: فهرس Bing يغذّي ChatGPT Search وCopilot وDuckDuckGo مباشرةً.
//
// لماذا تغيّر (أكتوبر 2026): كان يعيد إرسال الخريطة كاملة (631 رابطاً في 30 سبتمبر لأجل تعديل مسافات)،
// وبروابط عربية غير مرمَّزة، وفور الدفع قبل أن يكتمل نشر Render — فيزحف Bing النسخة القديمة.
// وإرسال كل شيء عند كل تغيير يُفقد الإشارة قيمتها (البروتوكول: أشعِر بما تغيّر فقط).
// الآن:
//   - الروابط = الفرق بين الخريطة الحالية ونسخة ملتزمة سابقة: المضافة والمتغيّرة **والمحذوفة**
//     (المحذوف يحتاج زحفاً ليُكتشف خروجه — تصحيح الناقد 17)، ويُضاف إليها seo/changed-urls.txt
//     إن وُجد (روابط تغيّرت بصمة محتواها دون أن يتغيّر سطرها في الخريطة).
//   - كل رابط يمرّ عبر new URL(u).href فيُرسَل مرمَّزاً (%D9…) كما يطلبه البروتوكول.
//   - الخريطة كاملة لا تُرسل إلا بعلم صريح --all.
//   - التوقيت يتولّاه وركفلو الصيانة: الإرسال بعد اكتمال النشر (live-sitemap-check.mjs --wait-for).
//
// الاستخدام:
//   node scripts/indexnow.mjs <رابط...>             روابط محددة (يدوياً: npm run geo:indexnow -- <روابط>)
//   node scripts/indexnow.mjs --file <ملف>          روابط من ملف، رابط في كل سطر
//   node scripts/indexnow.mjs --changed             الفرق مع الخريطة الملتزمة في HEAD + seo/changed-urls.txt
//   node scripts/indexnow.mjs --since <ref>         الفرق مع الخريطة في ref (مثل sha قبل الدفع)
//   node scripts/indexnow.mjs --all                 الخريطة كاملة (صراحةً فقط)
// خيارات: --dry-run يطبع ولا يرسل · --write <ملف> يكتب القائمة النهائية · --sitemap <ملف> خريطة بديلة
// رموز الخروج: 0 نجاح أو لا شيء للإرسال · 1 رفض الخادم أو تعذّر الاتصال · 2 خطأ استخدام أو مرجع git.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOST = 'fieldsa.net';
const KEY = '6548b7ac3458e8bcee3dd9f0c1fe55f3'; // ملف التحقق: public/<KEY>.txt
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const BATCH = 10000; // حدّ البروتوكول لكل طلب
const CHANGED_FILE = path.join(ROOT, 'seo/changed-urls.txt');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const VALUE_OPTS = new Set(['--file', '--since', '--write', '--sitemap']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(argv[i - 1]));
const SITEMAP = path.resolve(opt('--sitemap') || path.join(ROOT, 'public/sitemap.xml'));

const die = (msg, code = 2) => { console.error(`✗ ${msg}`); process.exit(code); };

/** رابط مطلق مرمَّز على النطاق نفسه، أو null (IndexNow يرفض دفعة فيها رابط من نطاق آخر) */
function normalize(u) {
  const s = String(u || '').trim();
  if (!s || s.startsWith('#')) return null;
  let url;
  try { url = new URL(s, `https://${HOST}/`); } catch { return null; }
  if (url.hostname === `www.${HOST}`) url.hostname = HOST;
  if (url.hostname !== HOST || !/^https?:$/.test(url.protocol)) return null;
  url.protocol = 'https:';
  url.hash = '';
  return url.href;
}

/** <url> الخريطة ← Map(رابط مرمَّز ← كتلته بعد ضغط الفراغ) — الكتلة تشمل lastmod والبدائل والصورة */
function parseSitemap(xml) {
  const out = new Map();
  for (const m of String(xml).matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = (m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/) || [])[1];
    const n = loc && normalize(loc.replace(/&amp;/g, '&'));
    if (n) out.set(n, m[1].replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** المضافة والمتغيّرة والمحذوفة بين نسختين من الخريطة */
function sitemapDiff(oldXml, newXml) {
  const a = parseSitemap(oldXml);
  const b = parseSitemap(newXml);
  const added = [...b.keys()].filter((u) => !a.has(u));
  const removed = [...a.keys()].filter((u) => !b.has(u));
  const changed = [...b.keys()].filter((u) => a.has(u) && a.get(u) !== b.get(u));
  return { added, changed, removed };
}

function committedSitemap(ref) {
  // المسار نسبيّ لمجلد web-admin (./) فيعمل أيّاً كان جذر المستودع
  const rel = './' + path.relative(ROOT, SITEMAP).split(path.sep).join('/');
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: ROOT, stdio: 'pipe' });
  } catch {
    die(`المرجع «${ref}» غير موجود في git — لا إرسال (إرسال الخريطة كاملة بدلاً منه يحتاج --all صراحةً)`);
  }
  try {
    return execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } catch {
    // الخريطة لم تكن ملتزمة في ذلك المرجع: كل روابطها «مضافة» — صحيح لكنه أول تشغيل، فيُذكر صراحةً
    console.warn(`  ⚠ لا خريطة في ${ref} — كل روابط الخريطة الحالية تُعدّ مضافة`);
    return '';
  }
}

function changedFileUrls() {
  if (!fs.existsSync(CHANGED_FILE)) return [];
  return fs.readFileSync(CHANGED_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// ───────── جمع الروابط ─────────
let raw = [];
let origin = '';
const modes = ['--all', '--changed', '--since', '--file'].filter((m) => flag(m));
if (modes.length > 1) die(`اختر مصدراً واحداً: ${modes.join(' ')}`);
if (modes.length && positional.length) die('روابط سطر الأوامر لا تُجمع مع --all/--changed/--since/--file');

if (flag('--all')) {
  if (!fs.existsSync(SITEMAP)) die(`لا توجد الخريطة ${SITEMAP}`);
  raw = [...parseSitemap(fs.readFileSync(SITEMAP, 'utf8')).keys()];
  origin = 'الخريطة كاملة (--all)';
} else if (flag('--changed') || flag('--since')) {
  const ref = flag('--since') ? opt('--since') : 'HEAD';
  if (!ref) die('--since يحتاج مرجع git');
  if (!fs.existsSync(SITEMAP)) die(`لا توجد الخريطة ${SITEMAP}`);
  const d = sitemapDiff(committedSitemap(ref), fs.readFileSync(SITEMAP, 'utf8'));
  const extra = changedFileUrls();
  raw = [...d.added, ...d.changed, ...d.removed, ...extra];
  origin = `الفرق مع ${ref}: ${d.added.length} مضاف · ${d.changed.length} متغيّر · ${d.removed.length} محذوف`
    + (extra.length ? ` + ${extra.length} من seo/changed-urls.txt` : '');
} else if (flag('--file')) {
  const f = opt('--file');
  if (!f || !fs.existsSync(f)) die(`الملف ${f || '—'} غير موجود`);
  raw = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  origin = `الملف ${f}`;
} else if (positional.length) {
  raw = positional;
  origin = 'سطر الأوامر';
} else {
  console.error('الاستخدام: node scripts/indexnow.mjs <رابط...> | --file <ملف> | --changed | --since <ref> | --all   [--dry-run] [--write <ملف>]');
  die('لا روابط — الخريطة كاملة لا تُرسل إلا بـ--all صراحةً');
}

const rejected = raw.filter((u) => !normalize(u));
const urls = [...new Set(raw.map(normalize).filter(Boolean))];
console.log(`IndexNow → ${HOST}: ${urls.length} رابط (${origin})`);
if (rejected.length) console.warn(`  ⚠ أُسقط ${rejected.length} رابطاً خارج ${HOST} أو غير صالح: ${rejected.slice(0, 3).join(' · ')}`);

const writeTo = opt('--write');
if (writeTo) {
  fs.mkdirSync(path.dirname(path.resolve(writeTo)), { recursive: true });
  fs.writeFileSync(writeTo, urls.join('\n') + (urls.length ? '\n' : ''));
}

const summary = (line) => {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n'); } catch { /* اختياري */ }
};

if (!urls.length) {
  console.log('  لا روابط متغيّرة — لا إرسال.');
  process.exit(0);
}
if (flag('--dry-run')) {
  for (const u of urls.slice(0, 50)) console.log('  ' + u);
  if (urls.length > 50) console.log(`  … و${urls.length - 50} غيرها`);
  console.log('  (تجربة جافة: لم يُرسل شيء)');
  process.exit(0);
}

async function submit(batch) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: batch }),
        signal: AbortSignal.timeout(30000),
      });
      // 200 = قُبل، 202 = قُبل (سيُتحقق من المفتاح لاحقاً) — كلاهما نجاح
      if (res.status === 200 || res.status === 202) return { ok: true, status: res.status };
      const body = (await res.text()).slice(0, 300);
      // 429/5xx عابرة ⇒ محاولة ثانية بعد مهلة؛ 4xx غيرها رفضٌ نهائي (مفتاح أو رابط أو نطاق)
      if (attempt === 1 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      return { ok: false, status: res.status, body };
    } catch (e) {
      if (attempt === 1) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      return { ok: false, status: 0, body: e.message };
    }
  }
  return { ok: false, status: 0, body: '' };
}

let sent = 0;
for (let i = 0; i < urls.length; i += BATCH) {
  const batch = urls.slice(i, i + BATCH);
  const r = await submit(batch);
  if (!r.ok) {
    console.error(`❌ IndexNow: HTTP ${r.status} — ${r.body}`);
    summary(`- ❌ IndexNow: HTTP ${r.status} بعد إرسال ${sent} من ${urls.length}`);
    process.exit(1);
  }
  sent += batch.length;
  console.log(`✅ IndexNow: أُرسل ${batch.length} رابطاً (HTTP ${r.status})`);
}
summary(`- ✅ IndexNow: أُرسل ${sent} رابطاً (${origin})`);
