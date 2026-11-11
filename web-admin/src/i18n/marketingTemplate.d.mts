// تعريفات الأنواع للقالب المشترك (marketingTemplate.mjs) — العقد بين مجموعات spec-b (§٥).
// يستورده prerender وgen-llms-i18n (Node) وI18nMarketingPage.tsx (المتصفح)، فلا تُغيَّر التوقيعات من طرف واحد.
import type { I18nPage, PublishedRegistry, Alternate } from './i18nRoutes.mjs';

export interface MarketingFile {
  _meta: { code: string; hreflang: string; dir: 'ltr' | 'rtl'; quality: string | null; contentDate: string; contentHash: string; simulated?: boolean };
  _derived: { uiLanguages: string; countriesCount: string; foundingYear: string; countryNames: Record<string, string>;
              currencyNames: Record<string, string>; countryOrder: string[];
              percent: { before: string; after: string; decimal: string }; namesFallback: string | null };
  strings: Record<string, string>;
}
/**
 * محتوى لغة من ملف صفحة الدولة — ما يقرؤه القالب منه. الملف الذي يُصيَّر هو المشتق المجرّد
 * src/i18n/registry/country-content/<CC>.<code>.json (scripts/country-i18n.mjs: strippedCountryFile)، لا النسخة الحرفية
 * src/content/country-pages/<CC>.json (فيها notes وreview ولا تدخل المتصفح).
 */
export interface CountryPageContent {
  slugHint: string | null; title: string; description: string; h1: string; intro: string;
  sections: { id: string; title: string; body: string }[];
  faq: { q: string; a: string }[];
  sampleInvoice: { title: string; note?: string; fields: { label: string; example: string }[] };
  sources: { url: string; title?: string; label?: string; name?: string }[];
  sourcesTitle?: string; lastVerifiedLabel: string;
}
export interface CountryPageFile {
  code: string; languages?: string[]; basedOnFactsVerifiedAt: string;   // languages في النسخة الحرفية وحدها
  content: Record<string, CountryPageContent>;
  review?: { quality?: string | null } & Record<string, unknown>;
  [k: string]: unknown;
}
export interface WorldCountries { meta: Record<string, unknown>; countries: { code: string; alpha3: string; numeric: string; currencies: string[] }[] }
export interface RenderInput {
  page: I18nPage; reg: PublishedRegistry;
  file?: MarketingFile;                 // مطلوب لكل صفحة عدا 'languages'
  world?: WorldCountries;               // مطلوب لـ'countries'
  vatByCode?: Record<string, number>;   // مطلوب لـ'countries' — vatMapFrom(COUNTRIES)
  country?: CountryPageFile;            // مطلوب لصفحات الدول 'country:<CC>'
}
export interface Rendered {
  title: string; description: string; h1: string;
  html: string;                          // جسم الصفحة كاملاً — ما يُحقن في #root (prerender) ويُرسم في React حرفياً
  faq: { q: string; a: string }[];       // الأسئلة الظاهرة في html (مصدر FAQPage)
  jsonld: object;                        // {"@context","@graph":[…]} — بلا Organization
  lang: string; dir: 'ltr' | 'rtl'; ogLocale: string;
  canonical: string; alternates: Alternate[];  // = clusterAlternates(page.clusterKey, reg) أو []
}
export function renderI18nPage(input: RenderInput): Rendered;   // يرمي إن نقص مفتاح مطلوب
export function vatMapFrom(countries: Record<string, { code: string; defaultVatPct: number }>): Record<string, number>; // بلا 'XX'
export function escapeHtml(s: string): string;
export const TEMPLATE_VERSION: number;
export const COUNTRY_SECTION_IDS: readonly string[];
export function countryContentOf(country: CountryPageFile, code: string, cc: string): CountryPageContent; // يرمي إن غاب
export function countrySourceLabel(source: { url: string; title?: string; label?: string; name?: string }): string;
