// تعريفات الأنواع لقواعد حارس الادّعاءات (claims-rules.mjs) — ليقبلها الفحص الصارم tsc
// حين يستوردها اختبار src/content/claimsGuard.test.ts. المصدر واحد: القواعد نفسها تحرس dist.

export interface ClaimRule {
  id: string;
  re: RegExp;
  why: string;
  unless?: RegExp;
  unlessBefore?: number;
  unlessAfter?: number;
  requireNear?: { re: RegExp; before: number; after: number };
  severity?: 'warn';
  scope?: 'head' | 'raw';
}

export const norm: (s: string) => string;
export const PHASE2: string;
export const SUPPORT_VERB: string;
export const DATE_OR_NUMBER: RegExp;
export const near: (term: string) => RegExp;
export const RULES: ClaimRule[];
export function findViolation(rule: ClaimRule, haystack: string): { index: number; match: string } | null;
export function checkText(text: string): string[];
