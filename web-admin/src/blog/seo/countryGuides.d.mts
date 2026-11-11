// تعريفات الأنواع لسجلّ أدلة الدول ومُصيِّرها (countryGuides.mjs) — ليقبله الفحص الصارم tsc في الاختبارات.
import type { SeoLang } from './catalog.mjs';

export interface CountryPageContent {
  slugHint?: string | null;
  title: string;
  description: string;
  h1: string;
  intro: string;
  sections: { id: string; title: string; body: string }[];
  faq: { q: string; a: string }[];
  sampleInvoice: { title: string; note?: string; fields: { label: string; example: string }[] };
  sources: { title?: string; url: string }[];
  lastVerifiedLabel: string;
}
export interface CountryPage {
  code: string;
  languages: string[];
  basedOnFactsVerifiedAt?: string;
  content: Record<string, CountryPageContent>;
  review?: { quality?: string; [k: string]: unknown };
  [k: string]: unknown;
}
export interface CountryFacts {
  code?: string;
  audit?: unknown;
  verifiedAt?: string;
  currency?: { iso?: string; symbol?: string; officialSign?: string; [k: string]: unknown };
  [k: string]: unknown;
}
export interface NewGuide {
  code: string;
  lang: SeoLang;
  ar: string; en: string; fr: string;
  inAr: string; inEn: string; inFr: string;
}
export interface RegisteredGuide { cc: string; slug: string; langs: SeoLang[]; kind: 'new' | 'upgraded' }

export const COUNTRY_PAGES_EAGER: boolean;
export function countryPage(cc: string): CountryPage | null;
export function countryFacts(cc: string): CountryFacts | null;
export const GUIDE_DATE: string;
export const PUBLISHABLE_QUALITY: Set<string>;
export const UPGRADED_GUIDES: string[];
export const UPGRADE_LANGS: SeoLang[];
export const NEW_GUIDES: NewGuide[];
export const GUIDE_TOPIC: string;
export function guideSlug(cc: string): string;
export function newGuideOf(slug: string): NewGuide | null;
export function upgradedGuideOf(slug: string): string | null;
export function countryGuideOf(slug: string, lang: string): string | null;
export function countryGuideReady(cc: string): boolean;
export function loadCountryGuide(cc: string): Promise<unknown>;
export function isPublishable(page: unknown): boolean;
export function guideContent(cc: string, lang: string): CountryPageContent | null;
export function guideProblems(cc: string, langs: readonly string[]): string[];
export function registeredGuides(): RegisteredGuide[];
