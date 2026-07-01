// ============================================================================
// سجلّ الدول (backend) — المصدر الموثوق لحساب الفوترة الرسمية
// ----------------------------------------------------------------------------
// حقول التشغيل فقط (العملة، الخانات، الضريبة الافتراضية، مزوّد الفوترة).
// الواجهة تملك نسختها للعرض (web-admin/src/i18n/countries.ts). يُوحَّدان لاحقًا
// في حزمة مشتركة لتفادي الانحراف.
// ============================================================================
import type { ProviderId } from '../compliance/provider';

export interface CountryTax {
  code: string;
  currency: string;
  currencyDecimals: number;  // ٢ أو ٣
  defaultVatPct: number;
  provider: ProviderId;
}

export const COUNTRY_TAX: Record<string, CountryTax> = {
  SA: { code: 'SA', currency: 'SAR', currencyDecimals: 2, defaultVatPct: 15, provider: 'zatca' },
  EG: { code: 'EG', currency: 'EGP', currencyDecimals: 2, defaultVatPct: 14, provider: 'eta' },
  AE: { code: 'AE', currency: 'AED', currencyDecimals: 2, defaultVatPct: 5, provider: 'peppol' },
  KW: { code: 'KW', currency: 'KWD', currencyDecimals: 3, defaultVatPct: 0, provider: 'none' },
  QA: { code: 'QA', currency: 'QAR', currencyDecimals: 2, defaultVatPct: 0, provider: 'none' },
  BH: { code: 'BH', currency: 'BHD', currencyDecimals: 3, defaultVatPct: 10, provider: 'none' },
  OM: { code: 'OM', currency: 'OMR', currencyDecimals: 3, defaultVatPct: 5, provider: 'none' },
  MA: { code: 'MA', currency: 'MAD', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  DZ: { code: 'DZ', currency: 'DZD', currencyDecimals: 2, defaultVatPct: 19, provider: 'none' },
  TN: { code: 'TN', currency: 'TND', currencyDecimals: 3, defaultVatPct: 19, provider: 'ttn' },
  JO: { code: 'JO', currency: 'JOD', currencyDecimals: 3, defaultVatPct: 16, provider: 'none' },
};

export const DEFAULT_COUNTRY = 'SA';

// يعيد إعداد ضريبة الدولة (يرجع السعودية لأي رمز غير معروف)
export function getCountryTax(code?: string | null): CountryTax {
  if (code && COUNTRY_TAX[code.toUpperCase()]) return COUNTRY_TAX[code.toUpperCase()];
  return COUNTRY_TAX[DEFAULT_COUNTRY];
}
