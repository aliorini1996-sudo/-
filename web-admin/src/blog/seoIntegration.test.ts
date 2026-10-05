import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { seoUrls, availableLangs } from '../i18n/locale';
import { effectivePosts, POSTS } from './posts';
import * as claimsRules from '../../scripts/claims-rules.mjs';
// @ts-ignore -- لا ملف تعريف للوحدة (extractFaq.d.mts)؛ الأنواع مثبّتة بالتحويل أدناه
import * as faqMod from './extractFaq.mjs';
// @ts-ignore -- لا ملف تعريف للوحدة (consolidate.d.mts)؛ الأنواع مثبّتة بالتحويل أدناه
import * as consMod from './consolidate.mjs';

/**
 * حرّاس دفعة الظهور (أكتوبر ٢٠٢٦): العقود التي يتّكئ عليها التصيير والخريطة معاً —
 * عنقود hreflang بلغات الصفحة الموجودة فعلاً (P1+H1)، واتحاد مقالات CMS والمستودع (P5)،
 * وتصفية FAQPage من النفي القديم والوعد غير المقيَّد (P2 وتصحيح الناقد 7)، والدمج (P3).
 */

type Pair = { q: string; a: string };
const { extractFaq, rawFaq, faqProblemWith } = faqMod as {
  extractFaq: (html: string, opts?: { problem?: (p: Pair) => string | null }) => Pair[];
  rawFaq: (html: string) => Pair[];
  faqProblemWith: (rules: unknown) => (p: Pair) => string | null;
};
const { consolidatedTarget, consolidatedFor, existsWith, consolidatedUrl } = consMod as {
  consolidatedTarget: (slug: string, L: string, exists?: (s: string, L: string) => boolean) => string | null;
  consolidatedFor: (L: string, exists?: (s: string, L: string) => boolean) => Set<string>;
  existsWith: (manual?: unknown[]) => (s: string, L: string) => boolean;
  consolidatedUrl: (target: string, L: string) => string;
};

test('صفحة بلغة واحدة: canonical ذاتي بلا بدائل لغات غير موجودة', () => {
  const s = seoUrls('/مزايا/ربط-المرحلة-الثانية', 'ar', ['ar']);
  assert.deepEqual(s.alternates, []);
  // الشرطة الأخيرة يضيفها useSeo (canon) عند الكتابة
  assert.equal(s.canonical.replace(/\/$/, ''), 'https://fieldsa.net/مزايا/ربط-المرحلة-الثانية');
});

test('الرئيسية وحدها بخمس لغات، والصفحات الثلاثية بلا tr/zh', () => {
  assert.deepEqual([...availableLangs('/')].sort(), ['ar', 'en', 'fr', 'tr', 'zh']);
  const p = seoUrls('/pricing', 'en');
  const langs = p.alternates.map((a) => a.hreflang);
  assert.ok(langs.includes('ar') && langs.includes('en') && langs.includes('fr') && langs.includes('x-default'));
  assert.ok(!langs.includes('tr') && !langs.some((l) => l.startsWith('zh')), `بدائل خاطئة: ${langs.join(',')}`);
});

test('اتحاد المقالات: مقال المستودع الغائب عن CMS يبقى، ونسخة CMS تتقدّم عند تطابق slug', () => {
  assert.ok(POSTS.length >= 2);
  const [a, b] = POSTS;
  const cmsA = { ...a, title: 'عنوان CMS' };
  const out = effectivePosts([cmsA]);
  assert.equal(out.filter((p) => p.slug === a.slug).length, 1, 'لا تكرار');
  assert.equal(out.find((p) => p.slug === a.slug)?.title, 'عنوان CMS');
  assert.ok(out.some((p) => p.slug === b.slug), 'مقال المستودع وحده يظهر');
  assert.equal(effectivePosts(null).length, POSTS.length);
});

const FAQ_HTML = `
<h2>مقدمة</h2><p>نص.</p>
<h2>أسئلة شائعة</h2>
<h3>هل يطبع المندوب الفاتورة؟</h3><p>نعم، على طابعة حرارية بالبلوتوث من جوال المندوب.</p>
<h3>هل يدعم النظام المرحلة الثانية؟</h3><p>أما المرحلة الثانية (الربط والتكامل) فغير مبنية لدينا حتى الآن.</p>
<h3>هل يعمل دون إنترنت؟</h3><p>نعم، يعمل أوف-لاين بالكامل ثم يرفع العمليات عند عودة الاتصال.</p>
<h3>هل أستطيع تحديد صلاحيات المندوب؟</h3><p>نعم، لكل مندوب صلاحيات البيع النقدي والآجل والمرتجع.</p>`;

test('FAQPage المقالات: يُسقط النفي القديم والوعد غير المقيَّد، ويفشل مغلقاً بلا مصنِّف', () => {
  assert.equal(rawFaq(FAQ_HTML).length, 4);
  const problem = faqProblemWith(claimsRules);
  const kept = extractFaq(FAQ_HTML, { problem }).map((p) => p.q);
  assert.deepEqual(kept, ['هل يطبع المندوب الفاتورة؟', 'هل أستطيع تحديد صلاحيات المندوب؟']);
  assert.deepEqual(extractFaq(FAQ_HTML), [], 'بلا مصنِّف لا FAQPage');
  // الوعد المقيَّد بالربط يبقى
  assert.equal(problem({ q: 'هل يعمل دون إنترنت؟', a: 'نعم، وللشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة تحتاج الفواتير (القياسية والمبسطة) والمرتجعات اتصالاً لحظة الإصدار.' }), null);
});

test('الدمج: الهدف بشرطة أخيرة، ولا يُطبَّق إن غاب الهدف بتلك اللغة', () => {
  assert.equal(consolidatedTarget('van-stock-management', 'ar'), 'van-stock-inventory');
  assert.equal(consolidatedTarget('van-stock-management', 'ar', () => false), null);
  assert.equal(consolidatedTarget('not-a-merged-slug', 'ar'), null);
  assert.equal(consolidatedUrl('van-stock-inventory', 'en'), 'https://fieldsa.net/en/blog/van-stock-inventory/');
  const ex = existsWith([]);
  assert.ok(ex('van-stock-inventory', 'ar'), 'هدف الكتالوج موجود بالعربية');
  const merged = consolidatedFor('ar', ex);
  assert.ok(merged.has('van-stock-management'));
  for (const slug of merged) assert.ok(!ex(slug, 'ar'), `المدموج ${slug} لا يُعدّ هدفاً`);
});

test('الخريطة الملتزمة: tr/zh للرئيسية وحدها، ولا ‎-region‎، ولا رابط مدموج', () => {
  const sm = fs.readFileSync(path.join(process.cwd(), 'public', 'sitemap.xml'), 'utf8');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 100);
  const trzh = locs.filter((u) => /^https:\/\/fieldsa\.net\/(tr|zh)\//.test(u));
  assert.deepEqual(trzh.sort(), ['https://fieldsa.net/tr/', 'https://fieldsa.net/zh/']);
  assert.ok(!sm.includes('-region'), 'لا رابط ‎-region‎ في الخريطة');
  const merged = consolidatedFor('ar', existsWith([]));
  for (const slug of merged) assert.ok(!locs.includes(`https://fieldsa.net/blog/${slug}/`), `المدموج ${slug} في الخريطة`);
});
