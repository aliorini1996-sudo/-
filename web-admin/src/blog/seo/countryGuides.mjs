/**
 * أدلة الدول المبنية على محتوى مراجَع (src/content/country-pages/<CC>.json) — السجلّ ومُصيِّر HTML.
 *
 * نوعان، وكلاهما في موضوع field-sales-software وحده (لا مصفوفة موضوع × دولة):
 *   - **مرقّاة**: صفحات الدول القائمة /blog/field-sales-software-<cc>/ بلغاتها الثلاث. يحلّ قسم «حقائق محلية»
 *     (أقسام الملف ومثال بنية الفاتورة والمصادر وآخر تحقق) محلّ الأقسام القالبية العامة التي تكرّره أو تناقضه،
 *     وتتصدّر أسئلته كتلة الأسئلة (FAQPage). الروابط والعنوان والوصف كما كانت؛ وcanonical لنفسها ولو لم تكن الدولة
 *     من أسواق الأولوية (canonicalSlug في الكتالوج) فتدخل عنقود hreflang الثلاثي والخريطة — محتواها لم يعد نسخة
 *     من الصفحة الجامعة.
 *   - **جديدة**: صفحة واحدة لكل دولة بلغة سوقها وحدها (field-sales-software-<cc> على نمط صفحات الدول القائمة)،
 *     بلا نسخ عربية ولا صفحات best-* أو مواضيع أخرى لها. hreflang ذاتي وx-default ذاتي.
 *
 * السجلّ ثابت هنا (لا يُشتقّ من الملفات وقت التشغيل) لأن المتصفح يحمّل المحتوى كسولاً (countryPages.browser.mjs)
 * ويحتاج قائمة الصفحات وعناوين الفهرس قبل وصوله. البوابة — مراجعة المحتوى (review.quality = publish أو
 * publish-with-notes) واكتمال تدقيق الحقائق (country-facts audit) — يفرضها countryGuides.test.ts وفحص البناء
 * في prerender (assertCountryGuides)، فلا تُدرج دولة هنا إلا بعد أن تمرّ.
 *
 * الملف نقيّ بلا fs ولا شبكة: ‎#country-pages‎ يُحلّ إلى قارئ القرص في node وإلى المحمّل الكسول في المتصفح.
 * ⚠️ النصوص كلها من ملفات المحتوى المراجَعة كما هي (تُهرَّب ولا تُعاد صياغتها)؛ ما يُكتب هنا عناوين الأقسام فقط.
 */
import { countryPage, countryFacts, countryPageLoaded, loadCountryPage, COUNTRY_PAGES_EAGER } from '#country-pages';

export { COUNTRY_PAGES_EAGER, countryPage, countryFacts };

/** تاريخ نشر الصفحات الجديدة وترقية القائمة (تعديل جوهري حقيقي ⇒ lastmod صادق) */
export const GUIDE_DATE = '2026-11-11';

/** جودة المراجعة التي تسمح بالنشر */
export const PUBLISHABLE_QUALITY = new Set(['publish', 'publish-with-notes']);

/**
 * أُضيفت ١١ نوفمبر ٢٠٢٦ بعد تصحيح نصّها في مصدره (D:/claude-work/country-pages) — كانت مستثناة لأن حارساً قائماً يحجب
 * نصّاً منها، والحارس لم يُضعَف: SA (عنوان مصدر EY بموجة وتاريخ ← zatca-phase2-dated)، وAE وMA وPH وGH وCM (جملة
 * ربط المرحلة الثانية في صفحة دولة غير السعودية ← catalog.links.test.ts)، وEG وAE («دون اتصال» بلا قيد الاتصال في
 * سوق مقاصّة لحظية ← claimsGuard.test.ts). دولة يحجب حارسٌ نصّها تبقى خارج السجلّ (وخارج نمط المحمّل الكسول في
 * countryPages.browser.mjs) حتى يُصحَّح مصدرها.
 */

/** صفحات الدول القائمة المرقّاة بقسم «حقائق محلية» (ع/إ/فر) */
export const UPGRADED_GUIDES = ['SA', 'AE', 'EG', 'MA', 'IQ', 'OM'];
export const UPGRADE_LANGS = ['ar', 'en', 'fr'];

/**
 * الصفحات الجديدة: لغة سوقها وحدها. الأسماء للفهرس وبطاقة المشاركة (العنوان والوصف الظاهران في الصفحة من ملفها).
 * inAr/ar للكلمات المفتاحية المشتركة في الكتالوج فقط — لا صفحة عربية لهذه الدول.
 */
export const NEW_GUIDES = [
  { code: 'PK', lang: 'en', ar: 'باكستان', en: 'Pakistan', fr: 'Pakistan', inAr: 'في باكستان', inEn: 'in Pakistan', inFr: 'au Pakistan' },
  { code: 'NG', lang: 'en', ar: 'نيجيريا', en: 'Nigeria', fr: 'Nigeria', inAr: 'في نيجيريا', inEn: 'in Nigeria', inFr: 'au Nigeria' },
  { code: 'ZA', lang: 'en', ar: 'جنوب أفريقيا', en: 'South Africa', fr: 'Afrique du Sud', inAr: 'في جنوب أفريقيا', inEn: 'in South Africa', inFr: 'en Afrique du Sud' },
  { code: 'KE', lang: 'en', ar: 'كينيا', en: 'Kenya', fr: 'Kenya', inAr: 'في كينيا', inEn: 'in Kenya', inFr: 'au Kenya' },
  { code: 'CI', lang: 'fr', ar: 'ساحل العاج', en: 'Côte d’Ivoire', fr: 'Côte d’Ivoire', inAr: 'في ساحل العاج', inEn: 'in Côte d’Ivoire', inFr: 'en Côte d’Ivoire' },
  { code: 'SN', lang: 'fr', ar: 'السنغال', en: 'Senegal', fr: 'Sénégal', inAr: 'في السنغال', inEn: 'in Senegal', inFr: 'au Sénégal' },
  // أُلحقت بآخر السجلّ لا بترتيب الأسواق: موضع الدليل يحدّد لون بطاقته (cardCatalog)، وبطاقات ما قبلها مولَّدة
  { code: 'PH', lang: 'en', ar: 'الفلبين', en: 'Philippines', fr: 'Philippines', inAr: 'في الفلبين', inEn: 'in the Philippines', inFr: 'aux Philippines' },
  { code: 'GH', lang: 'en', ar: 'غانا', en: 'Ghana', fr: 'Ghana', inAr: 'في غانا', inEn: 'in Ghana', inFr: 'au Ghana' },
  { code: 'CM', lang: 'fr', ar: 'الكاميرون', en: 'Cameroon', fr: 'Cameroun', inAr: 'في الكاميرون', inEn: 'in Cameroon', inFr: 'au Cameroun' },
];

/** موضوع الأدلة الوحيد */
export const GUIDE_TOPIC = 'field-sales-software';
export const guideSlug = (cc) => `${GUIDE_TOPIC}-${String(cc).toLowerCase()}`;

const NEW_BY_SLUG = new Map(NEW_GUIDES.map((g) => [guideSlug(g.code), g]));
const UPGRADED_BY_SLUG = new Map(UPGRADED_GUIDES.map((cc) => [guideSlug(cc), cc]));

/** الدليل الجديد لهذا الـslug أو null */
export const newGuideOf = (slug) => NEW_BY_SLUG.get(slug) || null;
/** رمز الدولة إن كان الـslug صفحة دولة مرقّاة */
export const upgradedGuideOf = (slug) => UPGRADED_BY_SLUG.get(slug) || null;

/**
 * رمز الدولة التي يُرسم محتوى هذا المقال بلغة L من ملفها، أو null. يستعمله BlogPostPage ليعرف أن عليه انتظار
 * الملف (المتصفح) قبل الرسم، فلا يرى الزائر الصفحة القالبية ثم تتبدّل.
 */
export function countryGuideOf(slug, L) {
  const g = newGuideOf(slug);
  if (g) return g.lang === L ? g.code : null;
  const cc = upgradedGuideOf(slug);
  return cc && UPGRADE_LANGS.includes(L) ? cc : null;
}
export const countryGuideReady = (cc) => countryPageLoaded(cc);
export const loadCountryGuide = (cc) => loadCountryPage(cc);

/** هل اجتاز الملف المراجعة؟ */
export const isPublishable = (page) => !!(page && page.review && PUBLISHABLE_QUALITY.has(page.review.quality));

/** محتوى الدولة بلغة L إن كان قابلاً للنشر ومحمَّلاً، وإلا null */
export function guideContent(cc, L) {
  const page = countryPage(cc);
  if (!isPublishable(page)) return null;
  if (!Array.isArray(page.languages) || !page.languages.includes(L)) return null;
  const c = page.content && page.content[L];
  return c && typeof c === 'object' ? c : null;
}

/**
 * فحص البوابة لدولة في السجلّ (node وحده — يقرأ الحقائق من القرص): يُرجع قائمة الأسباب، وفارغة = صالحة.
 * يستدعيه prerender قبل الكتابة، وcountryGuides.test.ts — فدولة في السجلّ بلا محتوى مراجَع توقف البناء.
 */
export function guideProblems(cc, langs) {
  const out = [];
  const page = countryPage(cc);
  const facts = countryFacts(cc);
  if (!page) out.push('لا يوجد ملف المحتوى src/content/country-pages/' + cc + '.json');
  else {
    if (!isPublishable(page)) out.push(`المراجعة لم تُجِز النشر (review.quality=${page.review ? page.review.quality : 'غائب'})`);
    for (const L of langs) {
      const c = page.content && page.content[L];
      if (!c || !Array.isArray(page.languages) || !page.languages.includes(L)) { out.push(`لا محتوى بلغة ${L}`); continue; }
      if (!c.intro || !Array.isArray(c.sections) || !c.sections.length) out.push(`${L}: المقدّمة أو الأقسام ناقصة`);
      if (!Array.isArray(c.faq) || !c.faq.length) out.push(`${L}: بلا أسئلة شائعة`);
      if (!Array.isArray(c.sources) || !c.sources.length) out.push(`${L}: بلا مصادر`);
      if (!c.lastVerifiedLabel) out.push(`${L}: بلا «آخر تحقق»`);
      if (!c.sampleInvoice || !Array.isArray(c.sampleInvoice.fields) || !c.sampleInvoice.fields.length) out.push(`${L}: بلا مثال بنية الفاتورة`);
    }
  }
  if (COUNTRY_PAGES_EAGER) {
    if (!facts) out.push('لا يوجد ملف الحقائق src/content/country-facts/' + cc + '.json');
    else if (!facts.audit) out.push('الحقائق لم يكتمل تدقيقها (audit غائب)');
  }
  return out;
}

/** كل دول السجلّ بلغاتها — للفحص */
export const registeredGuides = () => [
  ...UPGRADED_GUIDES.map((cc) => ({ cc, slug: guideSlug(cc), langs: UPGRADE_LANGS, kind: 'upgraded' })),
  ...NEW_GUIDES.map((g) => ({ cc: g.code, slug: guideSlug(g.code), langs: [g.lang], kind: 'new' })),
];

/* ─── التصيير ─────────────────────────────────────────────────────────────────── */

const P = (L, ar, en, fr) => (L === 'ar' ? ar : L === 'en' ? en : fr);
export const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** نصّ الملف فقرات: سطر فارغ أو سطر جديد يفصل الفقرات */
const paras = (text) => String(text || '').split(/\n+/).map((t) => t.trim()).filter(Boolean).map((t) => `<p>${esc(t)}</p>`).join('\n     ');
/** «| FieldSales» في آخر عنوان الملف تُزال: blogTitle يضيفها حين يتّسع العنوان (لا تتكرّر) */
export const stripBrand = (t) => String(t || '').replace(/\s*[|–—-]\s*FieldSales\s*$/i, '').trim();

const LABEL = {
  facts: (L, name) => P(L, `حقائق محلية: ${name}`, `Local facts: ${name}`, `Faits locaux : ${name}`),
  field: (L) => P(L, 'الحقل', 'Field', 'Champ'),
  example: (L) => P(L, 'مثال', 'Example', 'Exemple'),
  sources: (L) => P(L, 'المصادر', 'Sources', 'Sources'),
  faq: (L) => P(L, 'أسئلة شائعة', 'Frequently asked questions', 'Questions fréquentes'),
};

/** أقسام الملف بمستوى عنوان h */
const sectionsHtml = (c, h) => c.sections
  .map((s) => `<h${h}>${esc(s.title)}</h${h}>\n     ${paras(s.body)}`)
  .join('\n');

/** مثال بنية الفاتورة: جدول حقل ← مثال، بلا مبالغ (الملف يخلو منها والتحقق في countryGuides.test.ts) */
const sampleHtml = (c, L, h) => {
  const s = c.sampleInvoice;
  if (!s || !Array.isArray(s.fields) || !s.fields.length) return '';
  const rows = s.fields.map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(f.example)}</td></tr>`).join('');
  return `<h${h}>${esc(s.title)}</h${h}>${s.note ? `\n     <p>${esc(s.note)}</p>` : ''}\n<table><thead><tr><th>${LABEL.field(L)}</th><th>${LABEL.example(L)}</th></tr></thead><tbody>${rows}</tbody></table>`;
};

/**
 * المصادر روابط خارجية بعناوينها، ثم «آخر تحقق». تأتي **بعد** كتلة الأسئلة عمداً: عناوين المصادر و«آخر تحقق»
 * تحمل سنوات وأشهراً، وأول الأسئلة في صفحات السعودية جملة الربط — ونافذة حارس الموعد/الرقم (scripts/claims-rules.mjs)
 * ٨٠ حرفاً قبل العبارة و١٢٠ بعدها، فلا يجاور تاريخٌ من هنا جملةً من هناك. وآخر الأسئلة في الصفحات المرقّاة سؤالا
 * الجهاز والتجربة، بلا جملة ربط.
 */
export const sourcesHtml = (c, L, heading) => {
  const list = (c.sources || []).filter((s) => s && /^https?:\/\//.test(s.url || ''))
    .map((s) => `<li><a href="${esc(s.url)}" rel="noopener">${esc(s.title || s.url)}</a></li>`).join('');
  const verified = c.lastVerifiedLabel ? `\n<p class="last-verified"><em>${esc(c.lastVerifiedLabel)}</em></p>` : '';
  return `<section class="local-sources">\n<h2>${esc(heading)}</h2>\n<ol class="sources">${list}</ol>${verified}\n</section>`;
};
export const sourcesHeading = {
  upgraded: (L) => P(L, 'مصادر الحقائق المحلية', 'Sources for the local facts', 'Sources des faits locaux'),
  new: (L) => LABEL.sources(L),
};

/** أسئلة الملف أزواجاً نظيفة (تُغذّي القسم الظاهر وFAQPage معاً) */
export const guideFaq = (c) => (c.faq || []).filter((f) => f && f.q && f.a).map((f) => ({ q: String(f.q), a: String(f.a) }));

/** كتلة الأسئلة الظاهرة — الشكل نفسه في الكتالوج (سؤال عريض يليه جوابه) */
export const faqHtml = (list, L) => `<h2>${LABEL.faq(L)}</h2>\n     ${list.map(({ q, a }) => `<p><strong>${esc(q)}</strong> ${esc(a)}</p>`).join('\n     ')}`;

/** مقدّمة الملف */
export const introHtml = (c) => paras(c.intro);

/**
 * قسم «حقائق محلية» لصفحة مرقّاة: عنوان h2 بالدولة، ثم أقسام الملف (h3) ومثال بنية الفاتورة. تليه في الكتالوج
 * الأسئلة (أسئلة الملف أولاً) ثم مصادره و«آخر تحقق» (sourcesHtml).
 */
export const localFactsHtml = (c, L, countryName) => `<section class="local-facts" id="local-facts">
<h2>${esc(LABEL.facts(L, countryName))}</h2>
${sectionsHtml(c, 3)}
${sampleHtml(c, L, 3)}
</section>`;

/** جسم صفحة جديدة قبل الأسئلة: المقدّمة ثم الأقسام (h2) ومثال الفاتورة */
export const newGuideBodyHtml = (c, L) => `${introHtml(c)}
${sectionsHtml(c, 2)}
${sampleHtml(c, L, 2)}`;

/** نصّ المقدّمة صرفاً (llms-full.txt) */
export const introText = (c) => String(c.intro || '').replace(/\s+/g, ' ').trim();
