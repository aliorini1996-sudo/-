// تعريفات الأنواع لوحدة المسارات والعناقيد (i18nRoutes.mjs) — العقد بين مجموعات spec-b (§٣).
// التوقيعات هنا حرفية من المواصفة؛ تغييرها من طرف واحد يكسر prerender وgen-sitemap وReact معاً.

export const ORIGIN: 'https://fieldsa.net';
export const LEGACY: readonly ['ar', 'en', 'fr', 'tr', 'zh'];
export const LEGACY_HREFLANG: { ar: 'ar'; en: 'en'; fr: 'fr'; tr: 'tr'; zh: 'zh-Hans' };
export const DEFAULT_CATEGORY_SLUG: 'van-sales-software';
export const RESERVED_SEGMENTS: readonly string[];
export type PageKey = 'home' | 'category' | 'countries' | 'about' | 'contact' | 'features'
  | 'feature:offlineInvoicing' | 'feature:vanStock' | 'feature:routesVisits' | 'apps' | 'quote' | 'languages';
export type ClusterKey = 'home' | 'about' | 'contact' | 'category' | 'countries' | `tierA:${string}`;
export const BASE_PAGES: readonly PageKey[];   // home category countries about contact
export const TIER_A_PAGES: readonly PageKey[]; // features feature:offlineInvoicing feature:vanStock feature:routesVisits apps quote
export interface PublishedLocale {
  code: string; hreflang: string; name: string; nativeName: string; dir: 'ltr' | 'rtl'; legacy: boolean; tier: 'A' | 'B';
  ogLocale: string; intlLocale: string; slug: string; pages: PageKey[]; waLabel: string; contentDate: string;
  /** النشر الأول للغة — يكتبه المستورد حين يخالف contentDate (تغيّر المحتوى بعد النشر) */
  since?: string;
  /** النشر الأول لصفحات أُضيفت بعد نشر اللغة (صفحات الطبقة A للغات القديمة) */
  pagesSince?: Partial<Record<PageKey, string>>;
}
export interface PublishedRegistry { waveMax: number; generatedAt: string; simulated: boolean; locales: PublishedLocale[] }
export interface I18nPage {
  code: string; pageKey: PageKey; path: string;          // مسار مطلق بشرطة أخيرة، مثل '/es/' و'/es/software-preventa-autoventa/'
  clusterKey: ClusterKey | null; hreflang: string; dir: 'ltr' | 'rtl'; legacy: boolean;
}
export interface Alternate { hreflang: string; href: string }   // href مطلق بشرطة أخيرة
export function normalizeSlug(hint: string | undefined | null): string;
export function checkLocaleCode(code: string, extraReserved?: readonly string[]): string | null; // null = سليم، وإلا السبب
export function pagePath(code: string, pageKey: PageKey, slug: string): string;
export function i18nPages(reg: PublishedRegistry): I18nPage[];
export function clusterOf(pageKey: PageKey): ClusterKey | null;
export function clusterAlternates(key: ClusterKey, reg: PublishedRegistry): Alternate[];
export function newClusterMembers(key: ClusterKey, reg: PublishedRegistry): Alternate[];
/** نشر الصفحة الأول: pagesSince ثم since ثم contentDate */
export function pageSinceOf(loc: PublishedLocale | undefined | null, pageKey: PageKey): string | null;
/** أحدث انضمام بين أعضاء العنقود الجدد، أو null */
export function clusterChangedAt(key: ClusterKey, reg: PublishedRegistry): string | null;
/** lastmod صفحة الطبقة: أحدث contentDate ونشرها الأول وتغيّر عنقودها */
export function i18nLastmod(page: I18nPage, reg: PublishedRegistry, fallback?: string | null): string | null;
export function legacyClusterKey(arPath: string): 'home' | 'about' | 'contact' | null;
export function i18nPageForPath(pathname: string, reg: PublishedRegistry): I18nPage | null;
export function uiLangFor(code: string): 'ar' | 'en' | 'fr' | 'tr' | 'zh';
export function quoteHref(code: string): string;
export function meetingHref(code: string): string;
export function waRedirectHref(page: I18nPage): string;
export function requiredKeys(pageKey: PageKey, enKeys: readonly string[]): string[];
export function canon(url: string): string;
export function xDefaultOf(members: readonly Alternate[], hreflangs: readonly string[]): Alternate | undefined;
