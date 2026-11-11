// تعريفات الأنواع لكاشف أسماء اللغات (facts-langs.mjs) — ليقبلها الفحص الصارم tsc حين يستوردها اختبار
// src/content/factsLangs.test.ts. المصدر واحد: الكاشف نفسه يخدم حارس الحقائق verify-facts.mjs.

export const DETECT_CODES: readonly string[];
export const AR_STEMS: Record<string, string>;

export interface LangClaim { match: string; note: string }
export interface PublishedLocale { code: string; intl?: string; uiLanguages?: string }

export interface LangDetector {
  mentionedLangs(s: string, loc?: string | null): Set<string>;
  firstLangIndex(s: string, loc?: string | null): number;
  languageClaims(text: string, loc?: string | null): LangClaim[];
  localNames(loc: string): Record<string, string[]> | null;
  has(loc: string): boolean;
}

export function splitUiLanguages(list: string, intl?: string): string[] | null;
export function localeLangNames(intl: string, uiLanguages?: string): Record<string, string[]>;
export function createLangDetector(locales?: PublishedLocale[]): LangDetector;
export function docLocale(name: string, detector: LangDetector): string | null;

export const sentences: (text: string) => string[];
export const clauses: (sentence: string) => string[];
export const setStr: (s: Iterable<string>) => string;
export const sameSet: (a: Set<string>, b: Set<string>) => boolean;
export const UI: Set<string>;
