import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

/**
 * حرّاس «غير مُدرجة ومعزولة» لبوابة السفير (docs/affiliate/CONTRACT.md §1 ق7 وق8).
 * تُقرأ الملفات نصّاً — لا DOM في node — فأي تعديلٍ يُسرّب /ax إلى محرّكات
 * البحث أو يربط البوابة بجلسة لوحة الشركة يُفشل الاختبار بدل أن يمرّ صامتاً.
 */
const web = (p: string) => new URL(`../../${p}`, import.meta.url);
const read = (p: string) => readFileSync(web(p), 'utf8');

/** `/ax` مساراً لا جزءاً من كلمة (/axis، /axios) */
const AX_PATH = /\/ax(?![A-Za-z0-9_-])/;

test('البوابة تحقن noindex, nofollow وتعيده عند المغادرة', () => {
  const s = read('src/affiliate/AffiliateApp.tsx');
  assert.match(s, /meta\[name="robots"\]/, 'لا بحث عن وسم robots القائم');
  assert.match(s, /'noindex, nofollow'/, 'noindex, nofollow غير محقون');
  assert.match(s, /return \(\) => \{[\s\S]*prevRobots/, 'لا استعادة لوسم robots عند المغادرة');
  assert.match(s, /document\.title = 'سفير فيلد سيلز'/);
});

test('البوابة لا تستورد عميل لوحة الشركة ولا مخزن مصادقتها', () => {
  const dir = web('src/affiliate/');
  const files: string[] = [];
  const walk = (u: URL) => {
    for (const name of readdirSync(u)) {
      const child = new URL(name, u);
      if (statSync(child).isDirectory()) walk(new URL(`${name}/`, u));
      else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) files.push(child.href);
    }
  };
  walk(dir);
  assert.ok(files.length >= 5, 'ملفات البوابة غير موجودة');
  for (const f of files) {
    const s = readFileSync(new URL(f), 'utf8');
    assert.doesNotMatch(s, /from\s+['"][./]*api\/client['"]/, `${f} يستورد api/client`);
    assert.doesNotMatch(s, /store\/authStore/, `${f} يستورد مخزن مصادقة الشركة`);
  }
  const api = read('src/affiliate/api.ts');
  assert.match(api, /TOKEN_KEY = 'ax_token'/, 'مفتاح التوكن ليس ax_token');
  assert.match(api, /axios\.create\(/, 'لا عميل axios مستقل');
  assert.match(api, /\/affiliate`/, 'العميل لا يشير إلى /api/affiliate');
  assert.doesNotMatch(api, /localStorage\.clear\(\)/, '401 يجب أن يمسح ax_token وحده');
});

test('App.tsx: مسار /ax كسول، ومستثنى من VisitTracker', () => {
  const s = read('src/App.tsx');
  assert.match(s, /lazy\(\(\) => import\('\.\/affiliate\/AffiliateApp'\)\)/, 'البوابة ليست كسولة');
  assert.match(s, /<Route path="\/ax" element=\{<AffiliateApp \/>\} \/>/, 'مسار /ax غير مسجَّل');

  const tracker = s.match(/function VisitTracker\(\)[\s\S]*?\.test\(pathname\)\) return;/);
  assert.ok(tracker, 'تعذّر العثور على قاعدة VisitTracker');
  const re = tracker![0].match(/(\/\^\\\/\([^)]*\)\(\\\/\|\$\)\/)/);
  assert.ok(re, 'تعذّر استخراج تعبير VisitTracker');
  assert.match(re![1], /\|ax\)/, 'VisitTracker لا يستثني ax');
  // نبني التعبير ونجرّبه فعلاً — لا يكفي أن يحوي النصّ «ax»
  const rx = new RegExp(re![1].slice(1, -1));
  assert.equal(rx.test('/ax'), true);
  assert.equal(rx.test('/ax/'), true);
  assert.equal(rx.test('/axis'), false);
});

test('App.tsx: الالتقاط يعمل على الصفحات العامة والتسجيل، لا داخل البوابة', () => {
  const s = read('src/App.tsx');
  const block = s.match(/function ReferralCapture\(\)[\s\S]*?return null;\n\}/);
  assert.ok(block, 'مكوّن ReferralCapture غير موجود');
  assert.match(block![0], /captureRefFromUrl\(search\)/);
  assert.match(block![0], /\[pathname, search\]/, 'الالتقاط يجب أن يتبع search أيضاً');
  const re = block![0].match(/(\/\^\\\/\([^)]*\)\(\\\/\|\$\)\/)/);
  assert.ok(re);
  const skip = new RegExp(re![1].slice(1, -1));
  for (const p of ['/', '/pricing', '/signup', '/blog/x', '/en', '/free/van']) assert.equal(skip.test(p), false, `${p} يجب أن يُلتقط فيه`);
  for (const p of ['/ax', '/app', '/platform', '/rep', '/m', '/hx']) assert.equal(skip.test(p), true, `${p} يجب ألا يُلتقط فيه`);
  assert.match(s, /<ReferralCapture \/>/, 'المكوّن غير مركّب');
});

test('WhatsAppFab يُخفى على /ax', () => {
  const s = read('src/components/WhatsAppFab.tsx');
  const m = s.match(/const HIDDEN_ON = (\/\^[^\n]+\/);/);
  assert.ok(m);
  const rx = new RegExp(m![1].slice(1, -1));
  assert.equal(rx.test('/ax'), true);
  assert.equal(rx.test('/axis'), false);
});

test('ملفات الفهرسة والتصيير المسبق لا تذكر /ax', () => {
  for (const f of ['public/robots.txt', 'public/sitemap.xml', 'public/llms.txt', 'public/llms-full.txt', 'scripts/prerender.mjs']) {
    const s = read(f);
    const hit = s.match(AX_PATH);
    assert.equal(hit, null, `${f} يذكر /ax — البوابة غير مُدرجة`);
  }
});

test('مولّدات الفهرسة لا تذكر /ax', () => {
  for (const f of ['scripts/gen-sitemap.mjs', 'scripts/gen-llms.mjs']) {
    let s = '';
    try { s = read(f); } catch { continue; }
    assert.equal(s.match(AX_PATH), null, `${f} يذكر /ax`);
  }
});

test('لا رابط إلى /ax من صفحات الموقع العامة', () => {
  // لوحة المالك (PlatformPage وAffiliatesPanel ومنطقها) خاصة ويجوز أن تعرض رابط البوابة للمالك
  const isOwnerOnly = (name: string) => /^(PlatformPage|AffiliatesPanel|affiliatesPanel)/.test(name);
  const LINK = /(href|to)=["'{`]\s*['"`]?\/ax(?![A-Za-z0-9_-])|fieldsa\.net\/ax(?![A-Za-z0-9_-])/;
  const offenders: string[] = [];
  const walk = (u: URL, rel: string) => {
    for (const name of readdirSync(u)) {
      const child = new URL(name, u);
      if (statSync(child).isDirectory()) walk(new URL(`${name}/`, u), `${rel}${name}/`);
      else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !isOwnerOnly(name)) {
        if (LINK.test(readFileSync(child, 'utf8'))) offenders.push(`${rel}${name}`);
      }
    }
  };
  for (const d of ['pages', 'landing', 'blog', 'free', 'content', 'components']) {
    try { walk(web(`src/${d}/`), `src/${d}/`); } catch { /* مجلد غير موجود */ }
  }
  assert.deepEqual(offenders, [], `روابط إلى البوابة من: ${offenders.join(', ')}`);
});
