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
  scope?: 'head' | 'raw';
  /** verify-claims يطبّقها على ملفات dist التي يطابق مسارها النسبي paths ولا يطابق exceptPaths */
  paths?: RegExp;
  exceptPaths?: RegExp;
  /** حاجبة لنصوص المستودع وتحذير لنصوص CMS (يُسند verify-claims كل مطابقة بسياقها عبر fromCmsContext) */
  cmsWarn?: boolean;
  /** verify-claims يُلحق بالنطاق محتوى <meta name="keywords"> */
  keywords?: boolean;
  /** رمز لغة قاعدة من قاموس المصطلحات (src/i18n/glossary) — لا تدخل checkText */
  glossary?: 'ar' | 'en' | 'fr' | 'tr' | 'zh';
  /** كلمة القاموس الحرفية لقاعدة القاموس */
  term?: string;
}

/** بند avoid في قاموس المصطلحات */
export interface GlossaryAvoid {
  term: string;
  why: string;
  unlessWith?: string[];
  /** head (الافتراضي): منفردة في الرأس والكلمات المفتاحية · text: الصفحة كلها · alone: وحدها عنواناً أو بنداً */
  scope?: 'head' | 'text' | 'alone';
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
export const GLOSSARY_AVOID: Record<'ar' | 'en' | 'fr' | 'tr' | 'zh', GlossaryAvoid[]>;
export const GLOSSARY_RULES: ClaimRule[];
export const GLOSSARY_PATHS: Record<'ar' | 'en' | 'fr' | 'tr' | 'zh', RegExp>;
export function glossaryPattern(code: string, literal: string): string;
export function checkGlossary(text: string, code: string): string[];
export function findViolation(rule: ClaimRule, haystack: string): { index: number; match: string } | null;
export function findViolations(rule: ClaimRule, haystack: string, limit?: number): { index: number; match: string }[];
export function checkText(text: string): string[];
export function cmsCorpus(data: unknown): string;
export function fromCms(match: string, corpus: string | null): boolean;
export function fromCmsContext(haystack: string, v: { index: number; match: string }, corpus: string | null, ctx?: number): boolean;
