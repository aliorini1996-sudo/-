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
  // بقية الدول العربية — لا تفويض فوترة إلكترونية بعد (provider: none)، لكن العملة والضريبة صحيحتان
  IQ: { code: 'IQ', currency: 'IQD', currencyDecimals: 0, defaultVatPct: 0, provider: 'none' },
  LB: { code: 'LB', currency: 'LBP', currencyDecimals: 0, defaultVatPct: 11, provider: 'none' },
  LY: { code: 'LY', currency: 'LYD', currencyDecimals: 3, defaultVatPct: 0, provider: 'none' },
  PS: { code: 'PS', currency: 'ILS', currencyDecimals: 2, defaultVatPct: 16, provider: 'none' },
  SD: { code: 'SD', currency: 'SDG', currencyDecimals: 2, defaultVatPct: 17, provider: 'none' },
  YE: { code: 'YE', currency: 'YER', currencyDecimals: 2, defaultVatPct: 5, provider: 'none' },
  SY: { code: 'SY', currency: 'SYP', currencyDecimals: 0, defaultVatPct: 0, provider: 'none' },
  MR: { code: 'MR', currency: 'MRU', currencyDecimals: 2, defaultVatPct: 16, provider: 'none' },
  DJ: { code: 'DJ', currency: 'DJF', currencyDecimals: 0, defaultVatPct: 10, provider: 'none' },
  SO: { code: 'SO', currency: 'SOS', currencyDecimals: 2, defaultVatPct: 0, provider: 'none' },
  KM: { code: 'KM', currency: 'KMF', currencyDecimals: 0, defaultVatPct: 10, provider: 'none' },
  // أسواق التوسّع غير العربية (مذكورة في areaServed التسويقي) — عملة وضريبة صحيحتان بلا فوترة حكومية
  TR: { code: 'TR', currency: 'TRY', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  PK: { code: 'PK', currency: 'PKR', currencyDecimals: 2, defaultVatPct: 18, provider: 'none' },
  ID: { code: 'ID', currency: 'IDR', currencyDecimals: 0, defaultVatPct: 11, provider: 'none' },
  MY: { code: 'MY', currency: 'MYR', currencyDecimals: 2, defaultVatPct: 10, provider: 'none' },
  IN: { code: 'IN', currency: 'INR', currencyDecimals: 2, defaultVatPct: 18, provider: 'none' },
  BD: { code: 'BD', currency: 'BDT', currencyDecimals: 2, defaultVatPct: 15, provider: 'none' },
  LK: { code: 'LK', currency: 'LKR', currencyDecimals: 2, defaultVatPct: 18, provider: 'none' },
  NP: { code: 'NP', currency: 'NPR', currencyDecimals: 2, defaultVatPct: 13, provider: 'none' },
  PH: { code: 'PH', currency: 'PHP', currencyDecimals: 2, defaultVatPct: 12, provider: 'none' },
  VN: { code: 'VN', currency: 'VND', currencyDecimals: 0, defaultVatPct: 10, provider: 'none' },
  TH: { code: 'TH', currency: 'THB', currencyDecimals: 2, defaultVatPct: 7, provider: 'none' },
  IR: { code: 'IR', currency: 'IRR', currencyDecimals: 0, defaultVatPct: 9, provider: 'none' },
  AZ: { code: 'AZ', currency: 'AZN', currencyDecimals: 2, defaultVatPct: 18, provider: 'none' },
  KZ: { code: 'KZ', currency: 'KZT', currencyDecimals: 2, defaultVatPct: 12, provider: 'none' },
  NG: { code: 'NG', currency: 'NGN', currencyDecimals: 2, defaultVatPct: 7.5, provider: 'none' },
  SN: { code: 'SN', currency: 'XOF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  KE: { code: 'KE', currency: 'KES', currencyDecimals: 2, defaultVatPct: 16, provider: 'none' },
  ET: { code: 'ET', currency: 'ETB', currencyDecimals: 2, defaultVatPct: 15, provider: 'none' },
  GH: { code: 'GH', currency: 'GHS', currencyDecimals: 2, defaultVatPct: 15, provider: 'none' },
  CI: { code: 'CI', currency: 'XOF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  TZ: { code: 'TZ', currency: 'TZS', currencyDecimals: 2, defaultVatPct: 18, provider: 'none' },
  UG: { code: 'UG', currency: 'UGX', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  CM: { code: 'CM', currency: 'XAF', currencyDecimals: 0, defaultVatPct: 19, provider: 'none' },
  ML: { code: 'ML', currency: 'XOF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  NE: { code: 'NE', currency: 'XOF', currencyDecimals: 0, defaultVatPct: 19, provider: 'none' },
  TD: { code: 'TD', currency: 'XAF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  BF: { code: 'BF', currency: 'XOF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  ZA: { code: 'ZA', currency: 'ZAR', currencyDecimals: 2, defaultVatPct: 15, provider: 'none' },
};

export const DEFAULT_COUNTRY = 'SA';

// يعيد إعداد ضريبة الدولة (يرجع السعودية لأي رمز غير معروف)
export function getCountryTax(code?: string | null): CountryTax {
  if (code && COUNTRY_TAX[code.toUpperCase()]) return COUNTRY_TAX[code.toUpperCase()];
  return COUNTRY_TAX[DEFAULT_COUNTRY];
}
