// تعريفات الأنواع لصفحات الدول (country-i18n.mjs) — ليقبلها tsc الصارم حين يستوردها src/i18n/countryPages.test.ts.
import type { CountryPageContent, CountryPageFile } from '../src/i18n/marketingTemplate.mjs';
import type { CountryPagesIndex, I18nPage, PublishedRegistry } from '../src/i18n/i18nRoutes.mjs';

export const COUNTRY_TARGETS: Readonly<Record<string, string>>;
export const COUNTRY_PAGES_DIR: string;
export const COUNTRY_FACTS_DIR: string;
export const COUNTRY_INDEX_FILE: string;
export const COUNTRY_CONTENT_DIR: string;
export const COUNTRY_QUALITY_OK: readonly string[];
export function countryContentRel(cc: string, code: string): string;
export function factsAudited(facts: unknown): boolean;
export function reviewQuality(page: unknown): string | null;
export function countryShapeProblems(c: unknown): string[];
export function countryContentViolations(c: CountryPageContent, opts?: {
  code?: string; livePrices?: readonly string[]; verifiedAt?: string; script?: string;
}): string[];
export function deriveCountryIndex(args: {
  root: string; published: PublishedRegistry; registry?: unknown; livePrices?: readonly string[]; targets?: Record<string, string>;
}): CountryPagesIndex;
export function strippedCountryContent(c: unknown): CountryPageContent | null;
export function strippedCountryFile(page: CountryPageFile | Record<string, unknown>, code: string): CountryPageFile;
export function countryContentText(file: CountryPageFile): string;
export function deriveCountryContentFiles(args: { root: string; index: CountryPagesIndex }): Map<string, string>;
export function listCountryContentFiles(root: string): string[];
export function countryContentFilesProblems(args: { root: string; index: CountryPagesIndex }): string[];
export function fingerprintOf(s: string, isPublic?: (fp: string) => boolean): string | null;
export function normalizeAssetText(t: string): string;
export interface LeakFingerprint { cc: string; kind: string; fp: string }
export function countryLeakFingerprints(args: { root: string; index: CountryPagesIndex; targets?: Record<string, string> }): LeakFingerprint[];
export function assetLeaks(assets: { name: string; text: string }[], fingerprints: LeakFingerprint[]): (LeakFingerprint & { name: string })[];
export interface GateProblem { g: string; msg: string }
export function countryPageDistProblems(args: {
  html: string; page: I18nPage; reg: PublishedRegistry; country: CountryPageFile | null | undefined; livePrices?: readonly string[];
}): GateProblem[];
export function countryLinkProblems(args: {
  cp: I18nPage; others: { path: string; pageKey: string; html: string | null }[];
}): GateProblem[];
