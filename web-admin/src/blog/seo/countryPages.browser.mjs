/**
 * مصدر محتوى صفحات الدول في المتصفح (شرط "browser" لـ‎#country-pages‎ في package.json، يطبّقه Vite).
 *
 * لماذا كسول: ملفات src/content/country-pages/<CC>.json بين ١٧ و٥٠ كيلوبايت لكلٍّ منها، ولو استوردها الكتالوج
 * مباشرة لدخلت الحزمة الرئيسية التي يحمّلها كل زائر لكل صفحة. هنا يصير كل ملف حزمة مستقلة لا تُطلب إلا في
 * صفحة دولته، وBlogPostPage يُبقي المحتوى المُصيَّر ظاهراً (ssrHoldHtml) حتى يصل الملف، ثم يرسم من المصدر
 * نفسه الذي صيّر منه prerender (countryGuides.mjs) فلا يختلف ما يراه الزائر عمّا قرأه الزاحف.
 *
 * الحقائق المدقّقة (country-facts) لا تُحمَّل هنا: لا يُبنى منها نصّ ظاهر، وبوابتها فحص بناء واختبار في node.
 * الواجهة نفسها في countryPages.node.mjs.
 */
/*
 * دول السجلّ وحدها (countryGuides.mjs: UPGRADED_GUIDES وNEW_GUIDES) لا ‎*.json‎: ملفات الدول المستثناة من النشر
 * منسوخة في المستودع، ولو شملها النمط لصارت حزماً منشورة في dist/assets بنصوصها التي حجبها الحارس. Vite يشترط
 * نمطاً حرفياً، فالقائمة مكرّرة هنا ويطابقها countryGuides.test.ts بالسجلّ.
 */
const LOADERS = import.meta.glob('../../content/country-pages/{IQ,OM,PK,NG,ZA,KE,CI,SN}.json', { import: 'default' });
const keyOf = (cc) => `../../content/country-pages/${String(cc || '').toUpperCase()}.json`;

export const COUNTRY_PAGES_EAGER = false;

const pages = new Map();
const pending = new Map();

/** المحتوى إن حُمِّل، وإلا null (الكتالوج يرسم عندها الصفحة بلا حقائقها، وBlogPostPage ينتظر) */
export const countryPage = (cc) => pages.get(String(cc || '').toUpperCase()) || null;
/** الحقائق المدقّقة لا تُحمَّل في المتصفح */
export const countryFacts = () => null;
/** هل انتهت محاولة التحميل (نجحت أو لم يوجد ملف)؟ */
export const countryPageLoaded = (cc) => pages.has(String(cc || '').toUpperCase());

/** يحمّل ملف الدولة مرة واحدة؛ يُرجع { page, facts: null } ولا يرفض (الفشل = صفحة بلا حقائقها) */
export function loadCountryPage(cc) {
  const key = String(cc || '').toUpperCase();
  if (pages.has(key)) return Promise.resolve({ page: pages.get(key), facts: null });
  if (pending.has(key)) return pending.get(key);
  const load = LOADERS[keyOf(key)];
  const p = (load ? load() : Promise.resolve(null))
    .catch(() => null)
    .then((json) => {
      pages.set(key, json || null);
      pending.delete(key);
      return { page: json || null, facts: null };
    });
  pending.set(key, p);
  return p;
}
