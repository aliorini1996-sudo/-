// السجل المنشور للطبقة التسويقية متعددة اللغات (spec-b §٦.١) — ملف صغير يولّده المستورد (scripts/import-i18n.mjs)
// وتقرؤه حزمة المتصفح: مسارات App.tsx، ولغة الواجهة في lang.ts، وعناقيد hreflang في locale.ts، وتسمية الزرّ العائم.
// المسارات من i18nPages وحدها (i18nRoutes.mjs) — لا يكتب أحد مساراً بيده.
// صفحات الدول (نوع «country») من فهرسها المولَّد (scripts/import-country-i18n.mjs) — تُدمج بـwithCountryPages وحدها.
import data from './registry/published.json';
import countryIndex from './registry/country-pages.json';
import { i18nPages, i18nPageForPath, withCountryPages, type PublishedRegistry, type I18nPage, type CountryPagesIndex } from './i18nRoutes.mjs';

export const PUBLISHED: PublishedRegistry = withCountryPages(data as unknown as PublishedRegistry, countryIndex as unknown as CountryPagesIndex);
export const I18N_PAGES: I18nPage[] = i18nPages(PUBLISHED);
export const i18nPageAt = (pathname: string): I18nPage | null => i18nPageForPath(pathname, PUBLISHED);
