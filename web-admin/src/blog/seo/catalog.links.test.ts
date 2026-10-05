import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCatalog, getArticle, LANGS, hasArticle, canonicalSlug, listArticles } from './catalog.mjs';
import type { SeoLang } from './catalog.mjs';
import { FEATURES } from '../../content/features.mjs';
import { SECTORS } from '../../content/sectors';
import { TEMPLATES } from '../../content/templates';

/**
 * حرّاس روابط الكتالوج (catalog.mjs) وصوره — كل ما يولّده يُصيَّر للزاحف في dist مباشرة.
 *
 * لماذا: بنى عنقود الدولة `${id}-${cc}` فصنع للصفحات الجامعة روابط ‎-region‎ غير موجودة (168 موضعاً
 * تُخدَم قوقعة الرئيسية بـcanonical «/»)، وعنقود الخدمة ربط صفحات دول مدموجة، والرابط الفرنسي إلى
 * order-to-cash-cycle لا مقال وراءه، و45 صورة og للصفحات الجامعة لم تُولَّد. كلها مرّت صامتة لأن البناء
 * لا يفحص الروابط الداخلية. هذا الاختبار يفحص المصدر نفسه، فيفشل قبل النشر لا بعده.
 */

const PUBLIC_OG = fileURLToPath(new URL('../../../public/og/', import.meta.url));

/** المقالات اليدوية (CMS) التي يربطها الكتالوج بلغاتها المتاحة فعلاً — order-to-cash-cycle عربي وإنجليزي فقط */
const MANUAL: Record<SeoLang, string[]> = { ar: ['order-to-cash-cycle'], en: ['order-to-cash-cycle'], fr: [] };

/** مسارات المنصة المعروفة (عربية وحدها) من مصادرها نفسها — لا نسخة ملصوقة تنحرف */
const KNOWN_PATHS = new Set<string>([
  '/signup', '/pricing/', '/en/pricing/', '/fr/pricing/',
  ...FEATURES.map((f) => `/مزايا/${f.slug}/`),
  ...SECTORS.map((s) => `/قطاعات/${s.slug}/`),
  ...TEMPLATES.map((t) => `/نماذج/${t.slug}/`),
]);

const BLOG_HREF = /^\/(?:(en|fr)\/)?blog\/([^/?#]+)\/$/;

const allArticles = () => {
  const out: { slug: string; cc: string | null; L: SeoLang; a: NonNullable<ReturnType<typeof getArticle>> }[] = [];
  for (const e of buildCatalog()) {
    for (const L of LANGS) {
      const a = getArticle(e.slug, L);
      assert.ok(a, `${e.slug}.${L}: المقال غير موجود`);
      out.push({ slug: e.slug, cc: e.cc, L, a });
    }
  }
  return out;
};
const ARTICLES = allArticles();

test('المجمِّع يقرأ الكتالوج كاملاً', () => {
  assert.ok(ARTICLES.length > 1000, `قُرئ ${ARTICLES.length} مقالاً فقط — الاختبار سينجح كاذباً`);
});

test('كل رابط مقال داخلي يشير إلى مقال قانوني موجود بلغة الصفحة نفسها', () => {
  const bad: string[] = [];
  let n = 0;
  for (const { slug, L, a } of ARTICLES) {
    for (const [, href] of a.contentHtml.matchAll(/href="([^"]+)"/g)) {
      const m = BLOG_HREF.exec(href);
      if (!m) continue;
      n++;
      const hrefLang = (m[1] || 'ar') as SeoLang;
      const target = m[2];
      if (hrefLang !== L) bad.push(`${slug}.${L} → ${href} (لغة أخرى)`);
      if (/-region$/.test(target)) bad.push(`${slug}.${L} → ${href} (‎-region‎)`);
      if (target === slug) bad.push(`${slug}.${L} → ${href} (رابط ذاتي)`);
      if (MANUAL[hrefLang].includes(target)) continue;
      if (!hasArticle(target)) bad.push(`${slug}.${L} → ${href} (لا مقال)`);
      else if (canonicalSlug(target) !== target) bad.push(`${slug}.${L} → ${href} (غير قانوني: ${canonicalSlug(target)})`);
    }
  }
  assert.ok(n > 5000, `فُحص ${n} رابطاً فقط`);
  assert.deepEqual(bad.slice(0, 30), [], `${bad.length} رابطاً مكسوراً أو غير قانوني`);
});

test('روابط المنصة (مزايا وقطاعات ونماذج وأسعار) تشير إلى مسار موجود وبشرطة أخيرة', () => {
  const bad: string[] = [];
  let n = 0;
  for (const { slug, L, a } of ARTICLES) {
    for (const [, href] of a.contentHtml.matchAll(/href="([^"]+)"/g)) {
      if (BLOG_HREF.test(href)) continue;
      n++;
      if (!href.startsWith('/')) bad.push(`${slug}.${L} → ${href} (رابط خارجي في الكتالوج)`);
      else if (!KNOWN_PATHS.has(href)) bad.push(`${slug}.${L} → ${href} (مسار غير معروف)`);
      // صفحات الميزات والقطاعات والنماذج عربية وحدها: لا تُربط من النسخ الإنجليزية والفرنسية
      if (L !== 'ar' && /^\/(?:مزايا|قطاعات|نماذج)\//.test(href)) bad.push(`${slug}.${L} → ${href} (صفحة عربية من نسخة ${L})`);
    }
  }
  assert.ok(n > 1000, `فُحص ${n} رابط منصة فقط`);
  assert.deepEqual(bad.slice(0, 30), [], `${bad.length} رابط منصة مكسوراً`);
});

test('كل صورة og يشير إليها مقال موجودة في public/og (ومنها الصفحات الجامعة)', () => {
  const missing = ARTICLES
    .map(({ a }) => a.imagePath)
    .filter((p) => !existsSync(PUBLIC_OG + p.replace(/^\/og\//, '')));
  assert.deepEqual([...new Set(missing)].slice(0, 20), [], `${missing.length} صورة og مفقودة`);
  // الصفحات الجامعة تحديداً — كانت كلها مفقودة
  assert.ok(existsSync(PUBLIC_OG + 'field-sales-software-ar.jpg'));
  assert.ok(existsSync(PUBLIC_OG + 'distribution-management-system-fr.jpg'));
});

test('ربط المرحلة الثانية في صفحات السعودية وحدها، ورابط صفحة الميزة في نسختها العربية', () => {
  const PHASE2 = /ربط المرحلة الثانية|Phase 2 integration|intégration de la phase 2/i;
  const feature = FEATURES.find((f) => f.slug === 'ربط-المرحلة-الثانية');
  assert.ok(feature, 'صفحة ميزة ربط المرحلة الثانية غير موجودة في FEATURES — روابط الكتالوج إليها ستنكسر');
  const leaks = ARTICLES.filter(({ cc, a }) => cc !== null && cc !== 'SA' && PHASE2.test(a.contentHtml + JSON.stringify(a.faq)));
  assert.deepEqual(leaks.map(({ slug, L }) => `${slug}.${L}`), [], 'جملة الربط في صفحة دولة غير السعودية');
  for (const L of LANGS) {
    const sa = getArticle('einvoicing-compliance-sa', L)!;
    assert.match(sa.contentHtml, PHASE2, `einvoicing-compliance-sa.${L} بلا جملة الربط`);
    assert.ok(sa.faq.some((f) => PHASE2.test(f.q)), `einvoicing-compliance-sa.${L} بلا سؤال الربط في FAQ`);
  }
  assert.ok(getArticle('einvoicing-compliance-sa', 'ar')!.contentHtml.includes('href="/مزايا/ربط-المرحلة-الثانية/"'));
  assert.ok(!getArticle('einvoicing-compliance-sa', 'en')!.contentHtml.includes('/مزايا/'));
  assert.ok(!PHASE2.test(getArticle('einvoicing-compliance-eg', 'ar')!.contentHtml));
  // الوصف يُكتب في كتلة Article تتلوه datePublished مباشرة (prerender.mjs: articleJsonLd)، فجملة الربط فيه تضع
  // السنة في نافذة حارس الموعد/الرقم (claims-rules.mjs) ويفشل verify-claims على dist
  const inDesc = ARTICLES.filter(({ a }) => PHASE2.test(a.description)).map(({ slug, L }) => `${slug}.${L}`);
  assert.deepEqual(inDesc, [], 'جملة الربط في وصف مقال');
});

test('لا جواب مقلوباً ولا «البيع من السيارة» في المراسي والرؤوس، والأوصاف ضمن الحدّ', () => {
  const bad: string[] = [];
  for (const { slug, L, a } of ARTICLES) {
    if (a.contentHtml.includes('لا يكفي') || a.faq.some((f) => f.a.startsWith('لا يكفي'))) bad.push(`${slug}.${L}: «لا يكفي»`);
    for (const [, t] of a.contentHtml.matchAll(/<a [^>]*>([^<]*)<\/a>/g)) if (t.includes('البيع من السيارة')) bad.push(`${slug}.${L}: مرساة «${t}»`);
    if (`${a.title} ${a.description}`.includes('البيع من السيارة')) bad.push(`${slug}.${L}: الرأس`);
    if (a.description.length > 165) bad.push(`${slug}.${L}: وصف ${a.description.length} حرفاً`);
  }
  for (const L of LANGS) for (const it of listArticles(L)) if (it.description !== getArticle(it.slug, L)!.description) bad.push(`${it.slug}.${L}: وصف القائمة يخالف المقال`);
  assert.deepEqual(bad.slice(0, 30), [], `${bad.length} مخالفة`);
});
