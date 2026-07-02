// تعريفات الأنواع لمولّد مقالات SEO (catalog.mjs) — ليقبله الفحص الصارم tsc.
export type SeoLang = 'ar' | 'en' | 'fr';

export interface SeoListItem {
  slug: string;
  lang: SeoLang;
  date: string;
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
  description: string;
  keywords: string;
  excerpt: string;
  contentHtml: string;
  date: string;
  readMinutes: number;
  countryCode: string | null;
  isSeo: true;
}

export interface SeoCatalogEntry {
  slug: string;
  date: string;
  cc: string | null;
  trilingual: boolean;
  fr: boolean;
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
