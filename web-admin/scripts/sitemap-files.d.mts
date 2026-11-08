// أنواع scripts/sitemap-files.mjs — قراءة خريطة الموقع بعد تحويلها إلى فهرس (spec-b §٨.١).
export const URLSET_OPEN: string;
export function isSitemapIndex(xml: string): boolean;
export function childLocs(xml: string): string[];
export function childName(loc: string): string | null;
export function urlBlocks(xml: string): string[];
export function mergeUrlsets(xmls: readonly (string | null | undefined)[]): string;
export interface SitemapChild { loc: string; name: string | null; file: string | null; exists: boolean }
export function childFilesOf(indexFile: string, xml?: string): SitemapChild[];
export function mergedUrlsetFromFile(indexFile: string, opts?: { onMissing?: 'throw' | 'skip' }): string;
export type GetResult = { status: number; body: string; location?: string; transient?: undefined } | { transient: true; error: string };
export type MergedGetResult = (GetResult & { child?: string; children?: number; error?: string });
export function mergedUrlsetFromUrl<O>(indexUrl: string, get: (url: string, opts?: O) => Promise<GetResult>, opts?: O): Promise<MergedGetResult>;
export function mergedUrlsetFromGit(ref: string, indexRel: string, gitShow: (spec: string) => string): string;
