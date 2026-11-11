// تعريفات الأنواع لقواعد نصوص الطبقة متعددة اللغات (claims-i18n.mjs) — ليقبلها tsc الصارم
// حين يستوردها اختبار src/i18n/i18nRoutes.test.ts. المصدر واحد: القواعد نفسها يطبّقها المستورد والحارس.

export interface I18nViolation { id: string; match: string; why: string }

export const NO_CERT_RULE: readonly string[];
export const CERT_BY_LANG: Readonly<Record<string, string>>;
export const CERT_ALL: RegExp;
export const ENGLISH_LEXIFIER: readonly string[];
export function englishCopies(code: string, strings: Record<string, string>, enStrings: Record<string, string>): string[];
export function certRuleFor(code: string): RegExp | null;
export function toAsciiDigits(s: string): string;
export const YEAR_RE: RegExp;
export const YEAR_KEYS: readonly string[];
export function livePriceRe(livePrices: readonly string[]): RegExp | null;
export function currencyNumberRe(): RegExp;
export const I18N_RULE_WHY: Readonly<Record<string, string>>;
export function govEinvoicingName(text: string): string | null;
export function findI18nViolations(text: string, opts?: {
  code?: string; livePrices?: readonly string[]; allowYear?: boolean; skipCurrency?: boolean;
}): I18nViolation[];
export function checkMarketingStrings(strings: Record<string, string>, opts?: {
  code?: string; livePrices?: readonly string[];
}): (I18nViolation & { key: string })[];
export const BRAND_TOKENS: readonly string[];
export function stripBrands(s: string): string;
export const AR_BRAND: string;
export const SCRIPT_PROPS: Readonly<Record<string, readonly string[]>>;
export const DISTINCT_LETTERS: Readonly<Record<string, string>>;
export const DISTINCT_MIN: number;
export const HANS_MARKERS: string;
export const HANT_MARKERS: string;
export function scriptProblems(text: string, opts?: { script?: string; code?: string; hreflang?: string; minRatio?: number }): string[];
export function contentHashOf(strings: Record<string, string>): string;
export function placeholdersOf(s: string): string[];
export function publishedEntry(loc: Record<string, unknown>, waLabel: string | undefined | null): Record<string, unknown>;
