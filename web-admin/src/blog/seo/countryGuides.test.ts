import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCatalog, getArticle, listArticles, LANGS, canonicalSlug, hasArticle, cardCatalog } from './catalog.mjs';
import type { SeoLang } from './catalog.mjs';
import * as guides from './countryGuides.mjs';
import * as rules from '../../../scripts/claims-rules.mjs';

/**
 * أدلة الدول (countryGuides.mjs): البوابة، وصفحة واحدة لكل دولة جديدة بلغة سوقها، وFAQPage ومصادر لكل صفحة،
 * وقسم «حقائق محلية» في الصفحات المرقّاة دون تغيير روابطها أو canonical فيها.
 */

const G = guides;
const { countryPage, countryFacts } = guides;
const R = rules;

const PAGES_DIR = fileURLToPath(new URL('../../content/country-pages/', import.meta.url));
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const NEW = G.NEW_GUIDES;
const NEW_CODES = new Set(NEW.map((g) => g.code));

test('كل دولة في السجلّ اجتازت البوابة: محتوى مراجَع للنشر بلغاتها وحقائق مدقّقة', () => {
  const bad = G.registeredGuides().map((g) => ({ g, why: G.guideProblems(g.cc, g.langs) })).filter((x) => x.why.length);
  assert.deepEqual(bad.map(({ g, why }) => `${g.cc}: ${why.join('؛ ')}`), []);
  for (const g of G.registeredGuides()) {
    const page = countryPage(g.cc)!;
    assert.equal(page.code, g.cc, `${g.cc}: رمز الملف`);
    assert.ok(['publish', 'publish-with-notes'].includes(String(page.review?.quality)), `${g.cc}: جودة المراجعة`);
    assert.ok(countryFacts(g.cc)?.audit, `${g.cc}: تدقيق الحقائق`);
  }
  // الدول الجديدة بلغة سوقها: الإنجليزية لـPK وPH وNG وZA وKE وGH، والفرنسية لـCI وSN وCM
  const want: Record<string, SeoLang> = { PK: 'en', PH: 'en', NG: 'en', ZA: 'en', KE: 'en', GH: 'en', CI: 'fr', SN: 'fr', CM: 'fr' };
  for (const g of NEW) assert.equal(g.lang, want[g.code], `${g.code}: لغة السوق`);
});

test('صفحة واحدة لكل دولة جديدة: لا best-* ولا موضوع آخر ولا نسخة بلغة أخرى', () => {
  const cat = buildCatalog();
  for (const g of NEW) {
    const cc = g.code.toLowerCase();
    const slug = G.guideSlug(g.code);
    const mine = cat.filter((e) => e.cc === g.code || e.slug.endsWith(`-${cc}`));
    assert.deepEqual(mine.map((e) => e.slug), [slug], `${g.code}: مدخلات الكتالوج`);
    assert.deepEqual(mine[0].langs, [g.lang], `${g.code}: لغة واحدة`);
    assert.equal(mine[0].isCanonical, true);
    assert.equal(canonicalSlug(slug), slug, `${g.code}: canonical ذاتي`);
    for (const topic of ['best-field-sales-software', 'distribution-management-system', 'van-sales-app', 'einvoicing-compliance', 'sales-rep-management', 'collection-receivables', 'gps-rep-tracking']) {
      assert.equal(hasArticle(`${topic}-${cc}`), false, `${topic}-${cc} لا يجوز أن يوجد`);
    }
    for (const L of LANGS) {
      const a = getArticle(slug, L);
      if (L === g.lang) assert.ok(a, `${slug}.${L} غير موجود`);
      else assert.equal(a, null, `${slug}.${L}: نسخة بغير لغة السوق`);
      const listed = listArticles(L).filter((x) => x.countryCode === g.code).map((x) => x.slug);
      assert.deepEqual(listed, L === g.lang ? [slug] : [], `${g.code}.${L}: الفهرس`);
    }
    const cards = cardCatalog().filter((c) => c.cc === g.code);
    assert.deepEqual(cards.map((c) => [c.slug, c.langs]), [[slug, [g.lang]]], `${g.code}: بطاقة المشاركة`);
  }
});

test('دول السوق الجديدة التسع (المنشورة والمستثناة): لا مدخل في الكتالوج غير دليلها إن نُشر', () => {
  const TARGET = ['PK', 'PH', 'NG', 'ZA', 'KE', 'GH', 'CI', 'SN', 'CM'];
  const cat = buildCatalog();
  for (const cc of TARGET) {
    const lc = cc.toLowerCase();
    const mine = cat.filter((e) => e.cc === cc || new RegExp(`-${lc}$`).test(e.slug)).map((e) => e.slug);
    assert.deepEqual(mine, NEW_CODES.has(cc) ? [G.guideSlug(cc)] : [], `${cc}: مدخلات الكتالوج`);
    for (const L of LANGS) {
      assert.deepEqual(listArticles(L).filter((x) => x.countryCode === cc || x.slug.endsWith(`-${lc}`)).map((x) => x.slug),
        NEW_CODES.has(cc) && NEW.find((g) => g.code === cc)!.lang === L ? [G.guideSlug(cc)] : [], `${cc}.${L}: الفهرس`);
    }
  }
});

test('لكل صفحة دولة جديدة FAQPage ظاهرة ومصادر و«آخر تحقق» ومثال فاتورة بلا مبالغ', () => {
  for (const g of NEW) {
    const slug = G.guideSlug(g.code);
    const a = getArticle(slug, g.lang)!;
    const c = countryPage(g.code)!.content[g.lang];
    const body = textOf(a.contentHtml);
    // FAQPage = أسئلة الملف كلها، وكل سؤال وجوابه ظاهران في الصفحة
    assert.ok(a.faq.length >= 4, `${slug}: ${a.faq.length} سؤالاً`);
    assert.deepEqual(a.faq.map((f) => f.q), c.faq.map((f) => f.q), `${slug}: أسئلة FAQPage`);
    for (const f of a.faq) {
      assert.ok(body.includes(textOf(f.q)), `${slug}: السؤال غير ظاهر — ${f.q}`);
      assert.ok(body.includes(textOf(f.a)), `${slug}: الجواب غير ظاهر — ${f.q}`);
    }
    // المصادر: كل مصدر في الملف رابط خارجي ظاهر بعنوانه، ثم «آخر تحقق»
    const list = a.contentHtml.match(/<ol class="sources">([\s\S]*?)<\/ol>/);
    assert.ok(list, `${slug}: بلا قائمة مصادر`);
    const hrefs = [...list![1].matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    assert.ok(hrefs.length >= 3, `${slug}: ${hrefs.length} مصادر`);
    assert.deepEqual(hrefs, c.sources.map((s) => s.url), `${slug}: المصادر`);
    for (const h of hrefs) assert.match(h, /^https:\/\//, `${slug}: مصدر بلا https — ${h}`);
    assert.ok(c.lastVerifiedLabel && body.includes(textOf(c.lastVerifiedLabel)), `${slug}: بلا «آخر تحقق»`);
    // H1 والعنوان والوصف من الملف، والعنوان بلا «| FieldSales» مكرّرة
    assert.ok(a.h1 && a.contentHtml.length > 4000, `${slug}: محتوى ناقص`);
    // «| FieldSales» تُزال من عنوان الملف لأن blogTitle يضيفها (وإلا تكرّرت في <title>)
    assert.doesNotMatch(a.title, /\|\s*FieldSales\s*$/, `${slug}: العنوان يحمل اللاحقة`);
    assert.ok(a.description.length <= 160, `${slug}: وصف ${a.description.length}`);
  }
});

test('مثال بنية الفاتورة في كل الأدلة بلا مبالغ (لا رقم ملاصق لعملة البلد)', () => {
  const bad: string[] = [];
  for (const g of G.registeredGuides()) {
    const cur = countryFacts(g.cc)?.currency || {};
    const marks = [cur.iso, cur.symbol, cur.officialSign].filter((x): x is string => !!x && x.length <= 6)
      .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`[\\d٠-٩][\\d٠-٩,.\\s]*(?:${marks.join('|')})|(?:${marks.join('|')})\\s*[\\d٠-٩]`, 'i');
    for (const L of g.langs) {
      const s = countryPage(g.cc)!.content[L].sampleInvoice;
      for (const f of s.fields) if (re.test(`${f.label} ${f.example}`)) bad.push(`${g.cc}.${L}: ${f.label} — ${f.example}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('الصفحات المرقّاة: قسم «حقائق محلية» بلغاتها الثلاث، وأسئلة الملف أولاً في FAQPage، وcanonical كما كان', () => {
  // canonical قبل الترقية: أسواق الأولوية لنفسها، والبقية إلى الصفحة الجامعة (لا يتغيّر)
  const priority = new Set(['SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'EG']);
  for (const cc of G.UPGRADED_GUIDES) {
    const slug = G.guideSlug(cc);
    assert.equal(canonicalSlug(slug), priority.has(cc) ? slug : 'field-sales-software', `${slug}: canonical`);
    for (const L of G.UPGRADE_LANGS) {
      const a = getArticle(slug, L)!;
      const c = countryPage(cc)!.content[L];
      assert.match(a.contentHtml, /<section class="local-facts" id="local-facts">/, `${slug}.${L}: بلا قسم حقائق محلية`);
      assert.match(a.contentHtml, /<ol class="sources">/, `${slug}.${L}: بلا مصادر`);
      assert.deepEqual(a.faq.slice(0, c.faq.length).map((f) => f.q), c.faq.map((f) => f.q), `${slug}.${L}: أسئلة الملف أولاً`);
      const body = textOf(a.contentHtml);
      for (const f of a.faq) assert.ok(body.includes(textOf(f.q)), `${slug}.${L}: سؤال غير ظاهر — ${f.q}`);
      // الأقسام القالبية التي يحلّ الملف محلّها لا تبقى (البيئة التنظيمية ووعد «فاتورة متوافقة» في «كيف تبدأ»)
      assert.doesNotMatch(a.contentHtml, /البيئة التنظيمية للتوزيع|The regulatory environment for distribution|L'environnement réglementaire de la distribution/, `${slug}.${L}: قسم قالبي باقٍ`);
      assert.doesNotMatch(a.contentHtml, /أول فاتورة متوافقة|first compliant invoice/, `${slug}.${L}: وعد قالبي باقٍ`);
    }
  }
});

test('الصفحة الجامعة تربط الأدلة الجديدة بلغتها وحدها', () => {
  for (const L of LANGS) {
    const a = getArticle('field-sales-software', L)!;
    for (const g of NEW) {
      const href = `${L === 'ar' ? '' : `/${L}`}/blog/${G.guideSlug(g.code)}/`;
      if (g.lang === L) assert.ok(a.contentHtml.includes(`href="${href}"`), `الجامعة ${L} لا تربط ${g.code}`);
      else assert.ok(!a.contentHtml.includes(`/blog/${G.guideSlug(g.code)}/`), `الجامعة ${L} تربط ${g.code} بغير لغته`);
    }
  }
});

test('نصوص الأدلة كما تُصيَّر (المتن وFAQPage والرأس) بلا مطابقة حاجبة لحارس الادّعاءات', () => {
  const blocking = R.RULES.filter((r) => r.severity !== 'warn' && r.scope !== 'raw');
  const bad: string[] = [];
  for (const g of G.registeredGuides()) {
    for (const L of g.langs) {
      const a = getArticle(g.slug, L)!;
      const text = R.norm(`${a.h1 || a.title} ${textOf(a.contentHtml)} . ${a.title} ${a.description} . ${a.faq.map((f) => `${f.q} ${f.a}`).join(' ')}`);
      for (const r of blocking) if (R.findViolation(r, text)) bad.push(`${g.slug}.${L}: ${r.id}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('المحمّل الكسول في المتصفح يحزم دول السجلّ وحدها (لا حزمة في dist لدولة مستثناة)', () => {
  const src = readFileSync(new URL('./countryPages.browser.mjs', import.meta.url), 'utf8');
  const m = src.match(/import\.meta\.glob\('\.\.\/\.\.\/content\/country-pages\/\{([A-Z,]+)\}\.json'/);
  assert.ok(m, 'نمط import.meta.glob ليس قائمة دول حرفية');
  assert.deepEqual(m![1].split(',').sort(), G.registeredGuides().map((g) => g.cc).sort());
});

test('الملفات المنسوخة في المستودع صالحة ولكل دولة في السجلّ ملفّها', () => {
  const files = new Set(readdirSync(PAGES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
  for (const g of G.registeredGuides()) assert.ok(files.has(g.cc), `${g.cc}.json غائب`);
  for (const cc of NEW_CODES) assert.ok(!G.UPGRADED_GUIDES.includes(cc));
});
