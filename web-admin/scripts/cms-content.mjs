/**
 * محتوى CMS العام كما يُنشر — وحدة واحدة للجلب والتصحيح تستعملها السكربتات التي تُخرج ما يقرؤه الزاحف
 * ومحرّكات الإجابة: prerender.mjs (dist/**.html) وgen-llms.mjs (llms.txt وllms-full.txt) وgen-sitemap.mjs.
 *
 * لماذا (٢٦ أكتوبر ٢٠٢٦): ربط المرحلة الثانية حيّ منذ ٢ أكتوبر، لكن مقالات CMS ما زالت تنفيه («not built» ·
 * «غير مبنية لدينا» · «وفق المرحلة الأولى»)، وChatGPT يقتبس النفي من المقالات الحيّة. قائمة التصحيح الجاهزة
 * (src/content/cmsFixes.ts) تُطبَّق هنا على المحتوى المجلوب — **لا كتابة على CMS** — بالدالة نفسها التي
 * تطبّقها صفحات الموقع العامة وقت العرض (src/content/publicSiteContent.ts)، فلا يختلف HTML المُصيَّر عمّا
 * يرسمه React. الحرّاس (verify-claims وverify-sitemap) يجلبون CMS الخام عمداً: إسنادهم «نصّ CMS أم نصّ
 * المستودع» يعدّ نصوص القائمة نصّ مستودع (حاجباً) كما ينبغي.
 *
 * التاريخ: كل مقال يحمل نصّ القائمة يُختم modified فيه بـCMS_FIXES_VERSION (ثابت في cmsFixes.ts لا «اليوم»)،
 * فيصير lastmod في الخريطة وdateModified في Article عبر lastModifiedOf في posts.ts بلا تعديل هناك.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { transformSync } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const CMS_API = 'https://api.fieldsa.net/api/site-content';

/**
 * يجلب محتوى CMS الخام بمحاولات متكرّرة حتى نحو 90 ثانية (تصحيح الناقد 16: نشر الخادم قد يتزامن مع بناء
 * الموقع). الفشل الكلّي يُسقط السكربت (exit 1) فيبقى النشر السابق أو الملف الملتزم كما هو — بدل مخرج بلا
 * مقالات CMS يُنشر صامتاً. لا حدّ أدنى لعدد المقالات: ردّ صالح يكفي.
 * SEO_ALLOW_OFFLINE=1 للتشغيل المحلي بلا شبكة فقط ⇒ null (محتوى المستودع وحده).
 *   failHint: سطر يشرح أثر الإيقاف على هذا السكربت · offlineHint: ما يُستعمل بدل CMS حين لا شبكة
 */
export async function fetchCmsRaw({ failHint = 'أُوقف البناء عمداً.', offlineHint = 'محتوى المستودع وحده' } = {}) {
  const DEADLINE = 90_000;
  const started = Date.now();
  let wait = 2000;
  let attempt = 0;
  let last = '';
  for (;;) {
    attempt++;
    const left = DEADLINE - (Date.now() - started);
    try {
      const r = await fetch(CMS_API, { signal: AbortSignal.timeout(Math.max(5000, Math.min(20000, left))) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json())?.data;
      if (!data || typeof data !== 'object') throw new Error('ردّ بلا data');
      if (attempt > 1) console.log(`  نجح جلب CMS في المحاولة ${attempt}`);
      return data;
    } catch (e) {
      last = e?.message || String(e);
    }
    if (Date.now() - started + wait >= DEADLINE) break;
    console.log(`  تعذّر جلب CMS (محاولة ${attempt}: ${last}) — إعادة بعد ${wait / 1000} ث`);
    await new Promise((res) => setTimeout(res, wait));
    wait = Math.min(wait * 2, 30_000);
  }
  if (process.env.SEO_ALLOW_OFFLINE === '1') {
    console.log(`  ⚠️ CMS غير متاح (${last}) — SEO_ALLOW_OFFLINE=1: ${offlineHint} (تشغيل محلي فقط)`);
    return null;
  }
  console.error(`✗ تعذّر جلب CMS بعد ${attempt} محاولات خلال ${Math.round((Date.now() - started) / 1000)} ث (${last}).`);
  console.error(`  ${failHint} للتشغيل المحلي بلا شبكة: SEO_ALLOW_OFFLINE=1`);
  process.exit(1);
}

let fixesModule = null;
/**
 * src/content/cmsFixes.ts (بلا استيرادات) كوحدة ESM في الذاكرة — كما تحمّل السكربتات posts.ts. ملف واحد
 * للمحرّر والاختبار والسكربتات والواجهة، لا نسخة .mjs موازية تنحرف.
 */
export async function loadCmsFixes() {
  if (fixesModule) return fixesModule;
  const src = fs.readFileSync(path.join(ROOT, 'src/content/cmsFixes.ts'), 'utf8');
  const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
  fixesModule = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return fixesModule;
}

const ORIGIN = 'https://fieldsa.net';
/** رابط المقال اليدوي القانوني بلغته (الشرطة الأخيرة إلزامية — انظر canon في gen-sitemap.mjs) */
export const postUrl = (slug, lang) => `${ORIGIN}${lang === 'en' ? '/en' : ''}/blog/${slug}/`;

/**
 * يطبّق قائمة التصحيح على محتوى CMS خام ويطبع سطراً واحداً في سجل البناء: عدد البنود المطبّقة، وما حُفظ في
 * CMS سلفاً، وما لم ينطبق بمعرّفه (CMS تغيّر بعد كتابة البند — يُراجع في cmsFixes.ts، ولا يُسقط البناء:
 * verify-claims يُبقي ما تبقّى من نفي CMS تحذيراً كما كان).
 * يعيد { data, fixes, version }: data المحتوى المصحَّح (أو null بلا شبكة)، وfixes نتيجة publicCmsContent.
 */
export async function publicCms(raw, who = '') {
  const mod = await loadCmsFixes();
  const tag = `تصحيحات CMS${who ? ` (${who})` : ''}`;
  if (!raw || typeof raw !== 'object') {
    console.log(`  ${tag}: لا محتوى CMS — لا شيء يُطبَّق`);
    return { data: raw, fixes: null, version: mod.CMS_FIXES_VERSION };
  }
  const fixes = mod.publicCmsContent(raw);
  const by = {};
  for (const r of fixes.results) (by[r.status] ||= []).push(r.fix.id);
  const total = mod.CMS_FIXES.length;
  const off = Object.entries(by).filter(([s]) => s !== 'applied' && s !== 'already');
  const changed = fixes.posts.filter((p) => p.applied).length;
  console.log(`  ${tag}: طُبّق ${fixes.applied} من ${total} بنداً على المنشور (src/content/cmsFixes.ts، إصدار ${mod.CMS_FIXES_VERSION})`
    + `${by.already ? ` · محفوظ في CMS سلفاً ${by.already.length}` : ''} — ${changed} مقالاً تغيّر نصّه${fixes.home.applied ? ' + الرئيسية العربية' : ''}`);
  for (const [status, ids] of off) console.log(`  ⚠️ ${tag}: ${ids.length} بنداً لم ينطبق [${status}]: ${ids.join('، ')}`);
  return { data: fixes.value, fixes, version: mod.CMS_FIXES_VERSION };
}

/** الجلب ثم التصحيح — ما تستعمله السكربتات المولِّدة */
export async function fetchPublicCms({ who, ...opts } = {}) {
  return publicCms(await fetchCmsRaw(opts), who);
}
