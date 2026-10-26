// تعريفات الأنواع لوحدة محتوى CMS المنشور (cms-content.mjs) — ليقبلها tsc حين يستوردها
// src/content/cmsFixes.test.ts. الوحدة تحمّل src/content/cmsFixes.ts نفسه بـesbuild، فالأنواع من هناك.
import type * as CmsFixesModule from '../src/content/cmsFixes';
import type { PublicCmsFixes } from '../src/content/cmsFixes';

export const CMS_API: string;
export function fetchCmsRaw(opts?: { failHint?: string; offlineHint?: string }): Promise<Record<string, unknown> | null>;
export function loadCmsFixes(): Promise<typeof CmsFixesModule>;
export const postUrl: (slug: string, lang: 'ar' | 'en') => string;
export function publicCms<T>(raw: T, who?: string): Promise<{ data: T; fixes: PublicCmsFixes<T> | null; version: string }>;
export function fetchPublicCms(opts?: { who?: string; failHint?: string; offlineHint?: string }): Promise<{ data: Record<string, unknown> | null; fixes: PublicCmsFixes<Record<string, unknown>> | null; version: string }>;
