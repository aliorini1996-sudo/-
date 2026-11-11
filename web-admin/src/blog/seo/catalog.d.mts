// تعريفات الأنواع لمولّد مقالات SEO (catalog.mjs) — ليقبله الفحص الصارم tsc.
export type SeoLang = 'ar' | 'en' | 'fr';

export interface SeoListItem {
  slug: string;
  lang: SeoLang;
  date: string;
  /** آخر تعديل جوهري لهذه النسخة (lastmod) */
  modified?: string;
  readMinutes: number;
  countryCode: string | null;
  title: string;
  excerpt: string;
  keywords: string;
  description: string;
}

export interface SeoArticle {
  slug: string;
  title: string;
  /** عنوان H1 حين يختلف عن العنوان (أدلة الدول الجديدة من ملف محتواها) */
  h1?: string;
  description: string;
  keywords: string;
  excerpt: string;
  contentHtml: string;
  date: string;
  /** آخر تعديل جوهري لهذه النسخة (dateModified) */
  modified?: string;
  readMinutes: number;
  image: string;
  imagePath: string;
  faq: { q: string; a: string }[];
  howto: { name: string; text: string }[];
  countryCode: string | null;
  isSeo: true;
  /** لغات دليل دولة جديد (لغة سوقها وحدها) */
  langs?: SeoLang[];
}

export interface SeoCardMeta {
  slug: string;
  cc: string | null;
  label: { ar: string; en: string; fr: string };
  country: { ar: string; en: string; fr: string } | null;
  accent: string;
  /** بطاقة دليل دولة جديد بلغة سوقه وحدها */
  langs?: SeoLang[];
}

export interface SeoCatalogEntry {
  slug: string;
  date: string;
  /** أحدث تعديل بأي لغة */
  modified: string;
  /** آخر تعديل كل نسخة لغة (lastmod في الخريطة = dateModified في getArticle) */
  modifiedByLang: Partial<Record<SeoLang, string>>;
  cc: string | null;
  /** الرابط الأساسي: صفحة الدولة غير ذات الأولوية تُشير إلى صفحتها الجامعة (والمرقّاة بمحتوى مراجَع لنفسها) */
  canonical: string;
  isCanonical: boolean;
  trilingual: boolean;
  fr: boolean;
  /** دليل دولة جديد: لغة سوقه وحدها (hreflang ذاتي) — غيابه = ع/إ/فر */
  langs?: SeoLang[];
}

export interface SeoCountry {
  code: string;
  ar: string; en: string; fr: string;
  inAr: string; inEn: string; inFr: string;
}

export const LANGS: readonly SeoLang[];
export const ORIGIN: string;
export const COUNTRIES: SeoCountry[];
export function slugify(s: string): string;
export function listArticles(lang: SeoLang): SeoListItem[];
export function getArticle(slug: string, lang: SeoLang): SeoArticle | null;
export function buildCatalog(): SeoCatalogEntry[];
export function hasArticle(slug: string): boolean;
export function canonicalSlug(slug: string): string;
export function cardCatalog(): SeoCardMeta[];
/** آخر تعديل جوهري (lastmod وdateModified): L لغة النسخة — بلاها يؤخذ أحدث تعديلات الصفحة بلغاتها */
export function modifiedOf(date: string, cc: string | null, slug?: string | null, topicId?: string | null, L?: SeoLang): string;

/** دليل دولة جديد بلغة سوقه وحدها (src/blog/seo/countryGuides.mjs) */
export interface SeoNewGuide {
  code: string;
  lang: SeoLang;
  ar: string; en: string; fr: string;
  inAr: string; inEn: string; inFr: string;
}
export const NEW_GUIDES: SeoNewGuide[];
/** صفحات الدول القائمة المرقّاة بقسم «حقائق محلية» */
export const UPGRADED_GUIDES: string[];
/** رمز الدولة التي يُرسم المقال بلغته من ملف محتواها (فينتظره المتصفح)، أو null */
export function countryGuideOf(slug: string, lang: string): string | null;
/** هل وصل ملف محتوى الدولة (في node دائماً نعم) */
export function countryGuideReady(cc: string): boolean;
/** يحمّل ملف محتوى الدولة كسولاً في المتصفح (لا يرفض) */
export function loadCountryGuide(cc: string): Promise<unknown>;
/** لغات دليل دولة جديد، أو null لمقالات الكتالوج الثلاثية */
export function articleLangs(slug: string): SeoLang[] | null;
export function isIndexable(cc: string | null, lang: string): boolean;
