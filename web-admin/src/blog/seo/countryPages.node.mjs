/**
 * مصدر محتوى صفحات الدول المراجَع في node (البناء والاختبارات): يقرأ src/content/country-pages/<CC>.json
 * وsrc/content/country-facts/<CC>.json من القرص **متزامناً** عند أول طلب، فيرى كل مستهلك للكتالوج في node
 * (prerender وgen-sitemap وgen-llms وverify-sitemap وgen-og-cards والاختبارات) المحتوى نفسه بلا خطوة تحميل.
 *
 * يُختار هذا الملف بشرط "default" في حقل imports من package.json (‎#country-pages‎)، ونظيره في المتصفح
 * countryPages.browser.mjs (شرط "browser" الذي يطبّقه Vite): هناك يُحمَّل كل ملف كسولاً في حزمة مستقلة حتى
 * لا تثقل الحزمة الرئيسية بمئات الكيلوبايتات لصفحات قليلة. الواجهة واحدة في الملفين.
 *
 * الملفات منسوخة حرفياً من مصدرها المراجَع ولا تُحرَّر في المستودع (فرع آخر ينسخها نفسها).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGES_DIR = fileURLToPath(new URL('../../content/country-pages/', import.meta.url));
const FACTS_DIR = fileURLToPath(new URL('../../content/country-facts/', import.meta.url));

/** القراءة في node متزامنة: كل ملف «محمَّل» منذ البداية */
export const COUNTRY_PAGES_EAGER = true;

const cache = { page: new Map(), facts: new Map() };
const readJson = (dir, kind, cc) => {
  const key = String(cc || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(key)) return null;
  if (!cache[kind].has(key)) {
    const f = `${dir}${key}.json`;
    cache[kind].set(key, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  }
  return cache[kind].get(key);
};

/** محتوى صفحة الدولة كما هو في الملف، أو null إن لم يوجد */
export const countryPage = (cc) => readJson(PAGES_DIR, 'page', cc);
/** حقائق الدولة المدقّقة كما هي في الملف، أو null إن لم توجد */
export const countryFacts = (cc) => readJson(FACTS_DIR, 'facts', cc);
/** في node كل شيء جاهز */
export const countryPageLoaded = () => true;
export const loadCountryPage = async (cc) => ({ page: countryPage(cc), facts: countryFacts(cc) });
