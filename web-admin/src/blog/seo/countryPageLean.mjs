/**
 * ما يحتاجه العرض من ملف محتوى الدولة (src/content/country-pages/<CC>.json) — وحده يدخل حزم المتصفح.
 *
 * الملفات منسوخة حرفياً من مصدرها المراجَع (لا تُحرَّر في المستودع)، وتحمل بجانب المحتوى ملاحظات تحريرية داخلية:
 * notes وreview.issues وreview.fixes (ومنها اقتباس قوائم mustNotSay و«حقيقة محرّفة…»). كانت حزمة الدولة الكسولة
 * في dist/assets تنشرها كما هي لكل من يطلب رابطها. التحويل country-pages-lean في vite.config.ts يمرّر كل ملف من
 * هذه الدالة قبل الحزم، فلا يصل المتصفحَ إلا: code وlanguages وreview.quality ومحتوى كل لغة بحقوله التي يرسمها
 * countryGuides.mjs. وفي node (prerender والاختبارات) يُقرأ الملف كاملاً، وcountryGuides.test.ts يثبت أن ما يرسمه
 * العرض لا يتغيّر بالتنحيف.
 *
 * قائمة بيضاء لا سوداء: حقل داخلي جديد في الملفات لا يُنشر حتى يُضاف هنا عمداً.
 */

const pickStr = (v) => (typeof v === 'string' ? v : undefined);
const arr = (v) => (Array.isArray(v) ? v : []);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** محتوى لغة واحدة: الحقول التي يرسمها countryGuides.mjs وحدها */
const leanContent = (c) => clean({
  title: pickStr(c.title),
  description: pickStr(c.description),
  h1: pickStr(c.h1),
  intro: pickStr(c.intro),
  sections: arr(c.sections).map((s) => clean({ id: pickStr(s && s.id), title: pickStr(s && s.title), body: pickStr(s && s.body) })),
  faq: arr(c.faq).map((f) => clean({ q: pickStr(f && f.q), a: pickStr(f && f.a) })),
  sampleInvoice: c.sampleInvoice && typeof c.sampleInvoice === 'object'
    ? clean({
      title: pickStr(c.sampleInvoice.title),
      note: pickStr(c.sampleInvoice.note),
      fields: arr(c.sampleInvoice.fields).map((f) => clean({ label: pickStr(f && f.label), example: pickStr(f && f.example) })),
    })
    : undefined,
  sources: arr(c.sources).map((s) => clean({ title: pickStr(s && s.title), url: pickStr(s && s.url) })),
  lastVerifiedLabel: pickStr(c.lastVerifiedLabel),
});

/** نسخة الملف المنشورة في المتصفح، أو null لملف غير صالح */
export function leanCountryPage(page) {
  if (!page || typeof page !== 'object') return null;
  const content = {};
  for (const [L, c] of Object.entries(page.content || {})) {
    if (c && typeof c === 'object') content[L] = leanContent(c);
  }
  return {
    code: pickStr(page.code),
    languages: arr(page.languages).filter((L) => typeof L === 'string'),
    content,
    review: { quality: page.review && typeof page.review === 'object' ? pickStr(page.review.quality) : undefined },
  };
}

/** معرّف وحدة ملف محتوى دولة في Vite (المسار مطلق بشرطات أمامية، وقد يحمل استعلاماً) */
export const isCountryPageModule = (id) => /\/src\/content\/country-pages\/[A-Z]{2}\.json$/.test(String(id).split('?')[0].replace(/\\/g, '/'));
