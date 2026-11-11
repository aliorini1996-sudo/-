// تعريفات الأنواع لحقائق الكيان (entity-facts.mjs) — ليقبلها الفحص الصارم tsc حين يستوردها ملف TypeScript
// (الاختبار src/content/entityFacts.test.ts اليوم، والصفحات لاحقاً). المصدر واحد: القيم في entity-facts.mjs.

export type UiLang = 'ar' | 'en' | 'fr' | 'tr' | 'zh';
export type ByLang = Record<UiLang, string>;

export const FACTS_VERSION: string;
export const FACTS_STATUS: 'draft' | 'approved';
export const ORIGIN: string;

export const IDS: { organization: string; repApp: string; adminApp: string };

export const NAME: {
  official: string;
  arabic: string;
  domain: string;
  alternates: string[];
  disambiguation: { en: string; ar: string };
};

export const DESCRIPTION: { en: string; ar: string };

export const ORGANIZATION: {
  hq: { city: string; cityAr: string; country: string; countryName: string; countryNameAr: string };
  founded: string;
  founder: string;
  legalEntity: { nameAr: string; commercialRegistration: string; useInSchema: boolean };
  vatId: string | null;
};

export interface StoreApp {
  platform: 'android' | 'ios';
  id: string;
  bundleId?: string;
  public: boolean;
  url: string | null;
}
export interface WebApp { platform: 'web'; path: string }

export const APPS: {
  repAndroid: StoreApp;
  repIos: StoreApp;
  adminIos: StoreApp;
  adminAndroid: StoreApp;
  repWeb: WebApp;
  adminWeb: WebApp;
};
export function storeUrls(): string[];

export const UI_LANGS: UiLang[];
/** LANG_NAMES[اللغة المسمّاة][لغة الكتابة] */
export const LANG_NAMES: Record<UiLang, ByLang>;
export const SCHEMA_LANG_NAMES: string[];
export const UI_LANGS_SENTENCE: ByLang;

export const COVERAGE: {
  scope: 'worldwide';
  phrase: ByLang;
  registry: string;
  otherCountryCode: string;
  schemaAreaServed: string;
};

export const E_INVOICING: {
  liveCountries: string[];
  saudi: {
    authority: string;
    platform: string;
    phase2: { ar: string; en: string };
    noCertification: { ar: string; en: string };
  };
  elsewhere: { status: 'on-request'; phrase: ByLang; notImplemented: string[] };
};
export function einvoiceStatus(code: string): 'live' | 'on-request';

export const CONTACT: {
  quotePath: string;
  meetingPath: string;
  email: { sales: string; support: string };
  phone: string;
  whatsapp: { number: string; redirect: string };
  /** لغات فريق المبيعات والدعم (لا لغات الواجهة) — يعدّلها المالك */
  supportLanguages: string[];
};
/** أسماء schema.org للغات فريق التواصل (ContactPoint.availableLanguage) */
export const SUPPORT_SCHEMA_LANG_NAMES: string[];
export function localePath(p: string, lang?: UiLang): string;

export const SAME_AS: string[];
export function normalizeProfileUrl(u: string): string;

export const TRIAL: { days: number; creditCard: boolean; signupPath: string; ownerDecision: 'pending' | 'keep' | 'remove' };
export const PRICING: {
  visibleOnSite: boolean;
  source: 'CMS';
  currency: string;
  model: 'per-company';
  otherCurrencies: 'on-request';
};
export const OFFLINE: { en: string };

export interface RegistryEntry { code: string; nameEn: string; einvoice: string }
export function parseCountryRegistry(source: string): RegistryEntry[];
export function countryRegistry(): RegistryEntry[];

export interface CoverageFacts {
  scope: 'worldwide';
  phrase: ByLang;
  registryEntries: number;
  presetCountries: number;
  hasOtherCountry: boolean;
  einvoiceLive: string[];
  schemaAreaServed: string;
}
export function coverageFacts(entries?: RegistryEntry[]): CoverageFacts;

export interface EntityFacts {
  version: string;
  status: 'draft' | 'approved';
  origin: string;
  ids: typeof IDS;
  name: typeof NAME;
  description: typeof DESCRIPTION;
  organization: typeof ORGANIZATION;
  apps: typeof APPS;
  languages: { ui: UiLang[]; names: typeof LANG_NAMES; schemaNames: string[]; sentence: ByLang };
  coverage: CoverageFacts;
  eInvoicing: typeof E_INVOICING;
  contact: typeof CONTACT;
  sameAs: string[];
  trial: typeof TRIAL;
  pricing: typeof PRICING;
  offline: typeof OFFLINE;
}
export function getFacts(): EntityFacts;
