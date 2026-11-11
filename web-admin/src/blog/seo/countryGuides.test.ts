import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCatalog, getArticle, listArticles, LANGS, canonicalSlug, hasArticle, cardCatalog, modifiedOf } from './catalog.mjs';
import type { SeoLang } from './catalog.mjs';
import * as guides from './countryGuides.mjs';
import * as rules from '../../../scripts/claims-rules.mjs';
import { leanCountryPage, isCountryPageModule } from './countryPageLean.mjs';

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

test('الصفحات المرقّاة: قسم «حقائق محلية» بلغاتها الثلاث، وأسئلة الملف أولاً في FAQPage، وcanonical لنفسها', () => {
  // canonical لنفسها ولو لم تكن الدولة من أسواق الأولوية (العراق): محتواها حقائق دولتها لا نسخة من الصفحة الجامعة،
  // وإعلانها نسخةً منها canonical غير مطابق — كانت الترقية لا تصل البحث (بلا hreflang وغائبة عن الخريطة)
  const priority = new Set(['SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'EG']);
  const cat = buildCatalog();
  for (const cc of G.UPGRADED_GUIDES) {
    const slug = G.guideSlug(cc);
    assert.equal(canonicalSlug(slug), slug, `${slug}: canonical`);
    const e = cat.find((x) => x.slug === slug)!;
    assert.equal(e.isCanonical, true, `${slug}: أساسية في الكتالوج (الخريطة وhreflang)`);
    assert.equal(e.langs, undefined, `${slug}: ثلاثية اللغة`);
    for (const L of G.UPGRADE_LANGS) {
      // صفحة دولة غير ذات أولوية تُبقي رابط الجامعة في «مقالات ذات صلة» كما كان قبل أن تصير أساسية
      const pillarHref = `${L === 'ar' ? '' : `/${L}`}/blog/field-sales-software/`;
      if (!priority.has(cc)) assert.ok(getArticle(slug, L)!.contentHtml.includes(`href="${pillarHref}"`), `${slug}.${L}: رابط الجامعة`);
    }
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
      // قواعد القاموس كما يطبّقها verify-claims (وcheckText يستثنيها): لصفحات لغتها وحدها (paths على مسار dist)، وعلى
      // الرأس — العنوان والوصف وH1 كلٌّ في سطره — والكلمات المفتاحية؛ إلا scope «text» فعلى الصفحة كلها. «van sales» في
      // متن إنجليزي شرحاً أو «vente en tournée» في جملة فرنسية صحيحتان، ونسخة عربية لا تُحاسَب بقاموس الإنجليزية.
      const rel = `${L === 'ar' ? '' : `${L}/`}blog/${g.slug}/index.html`;
      const page = { text, raw: text, head: [a.title, a.description, a.h1 || a.title].join(R.FIELD_SEP), kw: a.keywords };
      for (const r of blocking) {
        if (r.glossary && ((r.paths && !r.paths.test(rel)) || (r.exceptPaths && r.exceptPaths.test(rel)))) continue;
        if (R.findViolation(r, r.glossary ? R.ruleHaystack(r, page) : text)) bad.push(`${g.slug}.${L}: ${r.id}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  // قواعد القاموس ما زالت تُطبَّق هنا: رأس دليل بالصيغة المنفردة يُحجب (ما صحّحه review.fix3 في ملفات المحتوى)
  const glossaryHits = (L: SeoLang, head: string, kw = '') => R.RULES
    .filter((r) => r.glossary && r.severity !== 'warn' && (!r.paths || r.paths.test(`${L === 'ar' ? '' : `${L}/`}blog/x/index.html`)))
    .filter((r) => R.findViolation(r, R.ruleHaystack(r, { text: head, raw: head, head, kw })))
    .map((r) => r.id);
  assert.deepEqual(glossaryHits('en', 'Van Sales Software for Kenya\nVan sales, pre-sales and collections for Kenyan distributors.\nKenya'), ['glossary-en-01']);
  assert.deepEqual(glossaryHits('fr', 'Logiciel\nFieldSales\nFieldSales au Cameroun : vente en tournée, prise de commandes'), ['glossary-fr-04']);
  assert.deepEqual(glossaryHits('en', 'Van sales app with pre-sales and collections for distributors in Kenya'), []);
  assert.deepEqual(glossaryHits('fr', 'FieldSales au Cameroun : logiciel de vente en tournée, de prise de commandes'), []);
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

test('أدلة الدول بلا وعد «فاتورة ضريبية» من القالب: الدعوة والكلمات المفتاحية والوصف، وفي المتن ما يقوله الملف وحده', () => {
  // الدعوة المشتركة (cta) تَعِد بـ«tax invoices / فواتير ضريبية»، وكانت تُلحق بالمحتوى المراجَع فتناقضه: باكستان
  // (فاتورة المسجَّل من نظامه المربوط بـFBR)، وكينيا (ليست فواتير ضريبية إلكترونية)، والعراق (بلا قيمة مضافة؛
  // honesty.mustNotSay). المتن قد يذكر العبارة حيث يشرحها الملف نفسه (عُمان وجنوب أفريقيا وباكستان) — فالشرط
  // أن ما في الصفحة منها هو ما في الملف عدداً، لا زيادة من القالب.
  const TAX = /tax[\s-]+invoic|فواتير ضريبي|فاتورة ضريبي|الفاتورة الضريبي|الفواتير الضريبي|factures? fiscales?/gi;
  const count = (s: string) => (s.match(TAX) || []).length;
  const bad: string[] = [];
  for (const g of G.registeredGuides()) {
    for (const L of g.langs) {
      const a = getArticle(g.slug, L)!;
      const c = countryPage(g.cc)!.content[L];
      const own = [
        c.intro, ...c.sections.flatMap((s) => [s.title, s.body]), ...c.faq.flatMap((f) => [f.q, f.a]),
        c.sampleInvoice.title, c.sampleInvoice.note || '', ...c.sampleInvoice.fields.flatMap((f) => [f.label, f.example]),
        ...c.sources.map((s) => s.title || ''), c.lastVerifiedLabel,
      ].join('\n');
      const extra = count(textOf(a.contentHtml)) - count(textOf(own));
      if (extra) bad.push(`${g.slug}.${L}: ${extra} من القالب في المتن`);
      if (count(a.keywords)) bad.push(`${g.slug}.${L}: الكلمات المفتاحية`);
      if (g.kind === 'upgraded' && count(a.description)) bad.push(`${g.slug}.${L}: وصف القالب`);
      for (const it of listArticles(L)) if (it.slug === g.slug && count(it.keywords)) bad.push(`${g.slug}.${L}: كلمات الفهرس`);
    }
  }
  assert.deepEqual(bad, []);
});

test('حزمة المتصفح من ملف الدولة: ما يرسمه العرض كاملاً، بلا الملاحظات التحريرية الداخلية', () => {
  for (const g of G.registeredGuides()) {
    const full = countryPage(g.cc)!;
    const lean = leanCountryPage(full)!;
    const json = JSON.stringify(lean);
    // لا notes ولا review.issues ولا review.fixes (مفاتيحها ولا نصوصها)
    assert.deepEqual(Object.keys(lean).sort(), ['code', 'content', 'languages', 'review'], `${g.cc}: مفاتيح الحزمة`);
    assert.deepEqual(lean.review, { quality: full.review!.quality }, `${g.cc}: review`);
    for (const k of ['notes', 'issues', 'fixes', 'mustNotSay']) assert.ok(!json.includes(`"${k}"`), `${g.cc}: «${k}» في الحزمة`);
    for (const note of [full.notes, (full.review as { issues?: unknown }).issues, (full.review as { fixes?: unknown }).fixes]) {
      for (const s of JSON.stringify(note ?? []).match(/"[^"]{40,}"/g) || []) {
        if (!JSON.stringify(full.content).includes(s)) assert.ok(!json.includes(s), `${g.cc}: نصّ ملاحظة داخلية في الحزمة — ${s.slice(0, 60)}`);
      }
    }
    // ما يرسمه countryGuides.mjs لا يتغيّر بالتنحيف: البوابة ولغاتها وكل حقل مرسوم
    assert.equal(G.isPublishable(lean), G.isPublishable(full), `${g.cc}: البوابة`);
    assert.deepEqual(lean.languages, full.languages);
    for (const L of g.langs) {
      const f = full.content[L], l = lean.content[L];
      for (const k of ['title', 'description', 'h1', 'intro', 'lastVerifiedLabel'] as const) assert.equal(l[k], f[k], `${g.cc}.${L}.${k}`);
      assert.deepEqual(l.sections, f.sections.map(({ id, title, body }) => ({ id, title, body })), `${g.cc}.${L}: الأقسام`);
      assert.deepEqual(l.faq, f.faq.map(({ q, a }) => ({ q, a })), `${g.cc}.${L}: الأسئلة`);
      assert.deepEqual(l.sources, f.sources.map(({ title, url }) => (title === undefined ? { url } : { title, url })), `${g.cc}.${L}: المصادر`);
      const si = f.sampleInvoice;
      assert.deepEqual(l.sampleInvoice, { title: si.title, ...(si.note === undefined ? {} : { note: si.note }), fields: si.fields.map(({ label, example }) => ({ label, example })) }, `${g.cc}.${L}: مثال الفاتورة`);
    }
  }
  // التحويل في vite.config.ts يطابق ملفات المحتوى وحدها
  assert.equal(isCountryPageModule('D:/x/web-admin/src/content/country-pages/IQ.json'), true);
  assert.equal(isCountryPageModule('/x/src/content/country-pages/OM.json?import'), true);
  assert.equal(isCountryPageModule('/x/src/content/country-facts/IQ.json'), false);
  assert.equal(isCountryPageModule('/x/src/content/country-pages/IQ.ts'), false);
});

test('تاريخ التعديل بلغته: ربط الأدلة لا يرفع تاريخ الجامعة بلغة بلا دليل (العربية يرفعها تعديل الجامعات REGION_REVISED وحده)، والخريطة تطابق dateModified كل نسخة', () => {
  const pillar = (L: SeoLang) => getArticle(G.GUIDE_TOPIC, L)!.modified!;
  const guideLangs = new Set(NEW.map((g) => g.lang));
  const cat = buildCatalog();
  const { date } = cat.find((x) => x.slug === G.GUIDE_TOPIC)!;
  for (const L of LANGS) {
    // تاريخ الجامعة بلا تعديل الصفحة بلغتها (REVISED_PAGE): بلا slug يبقى كل ما سواه — النشر والقالب وREVISED بمعرّف
    // الموضوع وREGION_REVISED (cc جامع null كما في buildCatalog)
    const withoutPage = modifiedOf(date, null, null, G.GUIDE_TOPIC, L);
    if (guideLangs.has(L)) assert.equal(pillar(L), G.GUIDE_DATE, `الجامعة ${L}: تربط أدلة لغتها`);
    else assert.equal(pillar(L), withoutPage, `الجامعة ${L}: ${pillar(L)} — لا دليل بلغتها فلا يرفع ربطُ الأدلة تاريخها (${withoutPage} من غيره)`);
  }
  // الجامعة العربية ٢٠٢٦-١١-١١ صادق: تعديل F9 (REGION_REVISED) غيّر جواب «هل يعمل النظام…» في الصفحات الجامعة بلغاتها
  // الثلاث يومها — لا ربط الأدلة
  assert.equal(pillar('ar'), '2026-11-11');
  assert.match(getArticle(G.GUIDE_TOPIC, 'ar')!.faq.find((f) => /هل يعمل النظام/.test(f.q))?.a || '', /في كل دول العالم/);
  // آلية التعديل بلغته معزولةً عن REGION_REVISED (cc غير جامع فلا يدخل): REVISED_PAGE يرفع لغات الأدلة وحدها، فلغة بلا
  // دليل يبقى تاريخها دون GUIDE_DATE — يتساوى التاريخان اليوم في الصفحة الحقيقية فلا يُرى الفرق إلا هكذا
  for (const L of LANGS) {
    const d = modifiedOf(date, 'XX', G.GUIDE_TOPIC, null, L);
    if (guideLangs.has(L)) assert.equal(d, G.GUIDE_DATE, `REVISED_PAGE ${L}: تربط أدلة لغتها`);
    else assert.ok(d < G.GUIDE_DATE, `REVISED_PAGE ${L}: ${d} — لا دليل بلغتها فلا يُرفع تاريخها`);
  }
  // lastmod في الخريطة (modifiedByLang) = modified الفهرس = dateModified المقال، لكل نسخة
  for (const L of LANGS) {
    const listed = new Map(listArticles(L).map((x) => [x.slug, x.modified]));
    for (const e of cat) {
      if (e.langs && !e.langs.includes(L)) continue;
      assert.equal(e.modifiedByLang[L], listed.get(e.slug), `${e.slug}.${L}: الخريطة والفهرس`);
    }
  }
  for (const slug of ['field-sales-software', ...G.registeredGuides().map((g) => g.slug)]) {
    const e = cat.find((x) => x.slug === slug)!;
    for (const L of e.langs || LANGS) assert.equal(getArticle(slug, L)!.modified, e.modifiedByLang[L], `${slug}.${L}: الخريطة والمقال`);
  }
});
