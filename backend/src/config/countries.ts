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
  // بقية دول العالم (طلب المالك ٨ نوفمبر ٢٠٢٦) — مرآة web-admin/src/i18n/countries.ts؛ الضريبة الافتراضية يعدّلها المشترك (PATCH /company/vat-rate)
  AF: { code: 'AF', currency: 'AFN', currencyDecimals: 2, defaultVatPct: 10, provider: 'none' },
  AL: { code: 'AL', currency: 'ALL', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  AO: { code: 'AO', currency: 'AOA', currencyDecimals: 2, defaultVatPct: 14, provider: 'none' },
  AR: { code: 'AR', currency: 'ARS', currencyDecimals: 2, defaultVatPct: 21, provider: 'none' },
  AM: { code: 'AM', currency: 'AMD', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  AU: { code: 'AU', currency: 'AUD', currencyDecimals: 2, defaultVatPct: 10, provider: 'none' },
  AT: { code: 'AT', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  BY: { code: 'BY', currency: 'BYN', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  BE: { code: 'BE', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 21, provider: 'none' },
  BJ: { code: 'BJ', currency: 'XOF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  BO: { code: 'BO', currency: 'BOB', currencyDecimals: 2, defaultVatPct: 13, provider: 'none' },
  BR: { code: 'BR', currency: 'BRL', currencyDecimals: 2, defaultVatPct: 17, provider: 'none' },
  BG: { code: 'BG', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  KH: { code: 'KH', currency: 'KHR', currencyDecimals: 2, defaultVatPct: 10, provider: 'none' },
  CA: { code: 'CA', currency: 'CAD', currencyDecimals: 2, defaultVatPct: 5, provider: 'none' },
  CL: { code: 'CL', currency: 'CLP', currencyDecimals: 0, defaultVatPct: 19, provider: 'none' },
  CN: { code: 'CN', currency: 'CNY', currencyDecimals: 2, defaultVatPct: 13, provider: 'none' },
  CO: { code: 'CO', currency: 'COP', currencyDecimals: 2, defaultVatPct: 19, provider: 'none' },
  CG: { code: 'CG', currency: 'XAF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  CD: { code: 'CD', currency: 'CDF', currencyDecimals: 2, defaultVatPct: 16, provider: 'none' },
  CR: { code: 'CR', currency: 'CRC', currencyDecimals: 2, defaultVatPct: 13, provider: 'none' },
  HR: { code: 'HR', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 25, provider: 'none' },
  CY: { code: 'CY', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 19, provider: 'none' },
  CZ: { code: 'CZ', currency: 'CZK', currencyDecimals: 2, defaultVatPct: 21, provider: 'none' },
  DK: { code: 'DK', currency: 'DKK', currencyDecimals: 2, defaultVatPct: 25, provider: 'none' },
  DO: { code: 'DO', currency: 'DOP', currencyDecimals: 2, defaultVatPct: 18, provider: 'none' },
  EC: { code: 'EC', currency: 'USD', currencyDecimals: 2, defaultVatPct: 15, provider: 'none' },
  FI: { code: 'FI', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 25.5, provider: 'none' },
  FR: { code: 'FR', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  GA: { code: 'GA', currency: 'XAF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  GE: { code: 'GE', currency: 'GEL', currencyDecimals: 2, defaultVatPct: 18, provider: 'none' },
  DE: { code: 'DE', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 19, provider: 'none' },
  GR: { code: 'GR', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 24, provider: 'none' },
  GT: { code: 'GT', currency: 'GTQ', currencyDecimals: 2, defaultVatPct: 12, provider: 'none' },
  GN: { code: 'GN', currency: 'GNF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  HN: { code: 'HN', currency: 'HNL', currencyDecimals: 2, defaultVatPct: 15, provider: 'none' },
  HK: { code: 'HK', currency: 'HKD', currencyDecimals: 2, defaultVatPct: 0, provider: 'none' },
  HU: { code: 'HU', currency: 'HUF', currencyDecimals: 2, defaultVatPct: 27, provider: 'none' },
  IS: { code: 'IS', currency: 'ISK', currencyDecimals: 0, defaultVatPct: 24, provider: 'none' },
  IE: { code: 'IE', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 23, provider: 'none' },
  IT: { code: 'IT', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 22, provider: 'none' },
  JP: { code: 'JP', currency: 'JPY', currencyDecimals: 0, defaultVatPct: 10, provider: 'none' },
  KG: { code: 'KG', currency: 'KGS', currencyDecimals: 2, defaultVatPct: 12, provider: 'none' },
  LA: { code: 'LA', currency: 'LAK', currencyDecimals: 2, defaultVatPct: 10, provider: 'none' },
  LV: { code: 'LV', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 21, provider: 'none' },
  LT: { code: 'LT', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 21, provider: 'none' },
  LU: { code: 'LU', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 17, provider: 'none' },
  MG: { code: 'MG', currency: 'MGA', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  MT: { code: 'MT', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 18, provider: 'none' },
  MX: { code: 'MX', currency: 'MXN', currencyDecimals: 2, defaultVatPct: 16, provider: 'none' },
  MD: { code: 'MD', currency: 'MDL', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  MN: { code: 'MN', currency: 'MNT', currencyDecimals: 2, defaultVatPct: 10, provider: 'none' },
  MZ: { code: 'MZ', currency: 'MZN', currencyDecimals: 2, defaultVatPct: 16, provider: 'none' },
  MM: { code: 'MM', currency: 'MMK', currencyDecimals: 2, defaultVatPct: 5, provider: 'none' },
  NL: { code: 'NL', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 21, provider: 'none' },
  NZ: { code: 'NZ', currency: 'NZD', currencyDecimals: 2, defaultVatPct: 15, provider: 'none' },
  NO: { code: 'NO', currency: 'NOK', currencyDecimals: 2, defaultVatPct: 25, provider: 'none' },
  PA: { code: 'PA', currency: 'USD', currencyDecimals: 2, defaultVatPct: 7, provider: 'none' },
  PY: { code: 'PY', currency: 'PYG', currencyDecimals: 0, defaultVatPct: 10, provider: 'none' },
  PE: { code: 'PE', currency: 'PEN', currencyDecimals: 2, defaultVatPct: 18, provider: 'none' },
  PL: { code: 'PL', currency: 'PLN', currencyDecimals: 2, defaultVatPct: 23, provider: 'none' },
  PT: { code: 'PT', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 23, provider: 'none' },
  RO: { code: 'RO', currency: 'RON', currencyDecimals: 2, defaultVatPct: 21, provider: 'none' },
  RU: { code: 'RU', currency: 'RUB', currencyDecimals: 2, defaultVatPct: 22, provider: 'none' },
  RW: { code: 'RW', currency: 'RWF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  RS: { code: 'RS', currency: 'RSD', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  SG: { code: 'SG', currency: 'SGD', currencyDecimals: 2, defaultVatPct: 9, provider: 'none' },
  SK: { code: 'SK', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 23, provider: 'none' },
  SI: { code: 'SI', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 22, provider: 'none' },
  KR: { code: 'KR', currency: 'KRW', currencyDecimals: 0, defaultVatPct: 10, provider: 'none' },
  SS: { code: 'SS', currency: 'SSP', currencyDecimals: 2, defaultVatPct: 18, provider: 'none' },
  ES: { code: 'ES', currency: 'EUR', currencyDecimals: 2, defaultVatPct: 21, provider: 'none' },
  SE: { code: 'SE', currency: 'SEK', currencyDecimals: 2, defaultVatPct: 25, provider: 'none' },
  CH: { code: 'CH', currency: 'CHF', currencyDecimals: 2, defaultVatPct: 8.1, provider: 'none' },
  TW: { code: 'TW', currency: 'TWD', currencyDecimals: 2, defaultVatPct: 5, provider: 'none' },
  TJ: { code: 'TJ', currency: 'TJS', currencyDecimals: 2, defaultVatPct: 14, provider: 'none' },
  TG: { code: 'TG', currency: 'XOF', currencyDecimals: 0, defaultVatPct: 18, provider: 'none' },
  TM: { code: 'TM', currency: 'TMT', currencyDecimals: 2, defaultVatPct: 15, provider: 'none' },
  UA: { code: 'UA', currency: 'UAH', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  GB: { code: 'GB', currency: 'GBP', currencyDecimals: 2, defaultVatPct: 20, provider: 'none' },
  US: { code: 'US', currency: 'USD', currencyDecimals: 2, defaultVatPct: 0, provider: 'none' },
  UY: { code: 'UY', currency: 'UYU', currencyDecimals: 2, defaultVatPct: 22, provider: 'none' },
  UZ: { code: 'UZ', currency: 'UZS', currencyDecimals: 2, defaultVatPct: 12, provider: 'none' },
  VE: { code: 'VE', currency: 'VES', currencyDecimals: 2, defaultVatPct: 16, provider: 'none' },
  ZM: { code: 'ZM', currency: 'ZMW', currencyDecimals: 2, defaultVatPct: 16, provider: 'none' },
  ZW: { code: 'ZW', currency: 'USD', currencyDecimals: 2, defaultVatPct: 15.5, provider: 'none' },
  // «دولة أخرى» لأي دولة غير مدرجة: دولار، والضريبة يحدّدها المشترك
  XX: { code: 'XX', currency: 'USD', currencyDecimals: 2, defaultVatPct: 0, provider: 'none' },
};

// عملات تشغيل دولية يجوز للشركة اختيارها بدل عملة دولتها (قائمة موثوقة —
// «لا نثق بقيم العميل»): الدولة تبقى مرجع الضريبة والفوترة، والعملة وحدها تتبدّل.
export const OVERRIDE_CURRENCIES: Record<string, { currency: string; currencyDecimals: number }> = {
  USD: { currency: 'USD', currencyDecimals: 2 },
  EUR: { currency: 'EUR', currencyDecimals: 2 },
};

// خانات العملة من رمزها مباشرة — يغلب خانات الدولة عند تجاوز العملة
// (شركة كويتية بعملة دولار: الفاتورة بخانتين لا ثلاث)
const THREE_DECIMAL = new Set(['KWD', 'BHD', 'OMR', 'TND', 'JOD', 'LYD']);
const ZERO_DECIMAL = new Set(['IQD', 'LBP', 'SYP', 'DJF', 'KMF', 'IDR', 'VND', 'IRR', 'XOF', 'XAF', 'UGX', 'CLP', 'JPY', 'KRW', 'ISK', 'PYG', 'GNF', 'RWF']);
export function currencyDecimalsOf(currency?: string | null): number {
  if (!currency) return 2;
  const c = currency.toUpperCase();
  if (THREE_DECIMAL.has(c)) return 3;
  if (ZERO_DECIMAL.has(c)) return 0;
  return 2;
}

export const DEFAULT_COUNTRY = 'SA';

// يعيد إعداد ضريبة الدولة (يرجع السعودية لأي رمز غير معروف)
export function getCountryTax(code?: string | null): CountryTax {
  if (code && COUNTRY_TAX[code.toUpperCase()]) return COUNTRY_TAX[code.toUpperCase()];
  return COUNTRY_TAX[DEFAULT_COUNTRY];
}
