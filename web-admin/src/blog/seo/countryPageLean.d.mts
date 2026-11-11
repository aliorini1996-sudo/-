// تعريفات countryPageLean.mjs — ما يدخل حزم المتصفح من ملف محتوى الدولة.
import type { CountryPage } from './countryGuides.mjs';

export function leanCountryPage(page: unknown): CountryPage | null;
export function isCountryPageModule(id: string): boolean;
