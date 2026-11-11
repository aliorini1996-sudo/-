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
  /** مرشّح مسبق: لا يُشغَّل re على نصّ لا يطابقه (يجب أن يكون أوسع من re) */
  pre?: RegExp;
  severity?: 'warn';
  scope?: 'head' | 'raw' | 'blocks';
  /** حكم إضافي على كل مطابقة (النص مطبَّع) — false يُعفيها */
  check?: (hay: string, m: RegExpMatchArray) => boolean;
  /** verify-claims يطبّقها على ملفات dist التي يطابق مسارها النسبي paths ولا يطابق exceptPaths */
  paths?: RegExp;
  exceptPaths?: RegExp;
  /** حاجبة لنصوص المستودع وتحذير لنصوص CMS (يُسند verify-claims كل مطابقة بسياقها عبر fromCmsContext) */
  cmsWarn?: boolean;
}

export const norm: (s: string) => string;
export const PHASE2_CMS_CLEANED: boolean;
export const PHASE2: string;
export const PHASE1: string;
export const SUPPORT_VERB: string;
export const PHASE2_VERB: string;
export const PHASE2_INTEGRATION: string;
export const DATE_OR_NUMBER: RegExp;
export const near: (term: string) => RegExp;
export const RULES: ClaimRule[];
export const GOV_EINVOICING: { cc: string[]; latin?: string; cyrl?: string; arab?: string; hebr?: string; free?: string }[];
export const GOV_EINVOICING_RE: RegExp;
export function govClaimAt(hay: string, m: RegExpMatchArray): boolean;
export function jsonLdLines(src: string): string;
export function findViolation(rule: ClaimRule, haystack: string): { index: number; match: string } | null;
export function findViolations(rule: ClaimRule, haystack: string, limit?: number): { index: number; match: string }[];
export function checkText(text: string): string[];
export function cmsCorpus(data: unknown): string;
export function fromCms(match: string, corpus: string | null): boolean;
export function fromCmsContext(haystack: string, v: { index: number; match: string }, corpus: string | null, ctx?: number): boolean;
