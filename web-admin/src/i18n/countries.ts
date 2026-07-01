// ============================================================================
// سجلّ الدول (Country Registry) — أساس تدويل المنصّة (المرحلة 0)
// ----------------------------------------------------------------------------
// مصدر واحد لكل ما يختلف بين الدول: العملة، الخانات العشرية، الضريبة الافتراضية،
// الـlocale، صيغة الرقم الضريبي، ومزوّد الفوترة الإلكترونية.
// ⚠️ النِّسب والمواعيد إرشادية وتتغيّر — تُراجَع مع مستشار ضريبي محلي قبل الاعتماد.
// ملاحظة حرجة: KWD/BHD/OMR/TND/JOD/LYD تستخدم ٣ خانات عشرية لا ٢.
// ============================================================================

export type EInvoiceProvider = 'zatca' | 'eta' | 'peppol' | 'ttn' | 'none';

export interface CountryConfig {
  code: string;              // ISO 3166-1 alpha-2
  nameAr: string;
  nameEn: string;
  currency: string;          // ISO 4217
  currencyDecimals: number;  // ٢ أو ٣ (مهم لتقريب وتنسيق الفاتورة)
  symbolAr: string;
  symbolEn: string;
  defaultVatPct: number;     // نسبة الضريبة الافتراضية للدولة
  locale: string;            // BCP-47 لتنسيق الأرقام والتواريخ
  taxIdLabelAr: string;      // اسم الرقم الضريبي محليًا
  taxIdLabelEn: string;
  taxIdRegex?: string;       // تحقّق صيغة الرقم الضريبي (اختياري)
  einvoice: EInvoiceProvider;
  einvoiceNoteAr: string;    // حالة الفوترة الإلكترونية (توضيح)
}

// الدول المستهدفة في خطّة التوسّع (السعودية + مصر + الإمارات + بقية الخليج + المغرب العربي + شائعة)
export const COUNTRIES: Record<string, CountryConfig> = {
  SA: {
    code: 'SA', nameAr: 'السعودية', nameEn: 'Saudi Arabia',
    currency: 'SAR', currencyDecimals: 2, symbolAr: 'ر.س', symbolEn: 'SAR',
    defaultVatPct: 15, locale: 'ar-SA',
    taxIdLabelAr: 'الرقم الضريبي (VAT)', taxIdLabelEn: 'VAT Number',
    taxIdRegex: '^3\\d{14}$',
    einvoice: 'zatca', einvoiceNoteAr: 'ZATCA (فاتورة) — مُطبَّق',
  },
  EG: {
    code: 'EG', nameAr: 'مصر', nameEn: 'Egypt',
    currency: 'EGP', currencyDecimals: 2, symbolAr: 'ج.م', symbolEn: 'EGP',
    defaultVatPct: 14, locale: 'ar-EG',
    taxIdLabelAr: 'رقم التسجيل الضريبي', taxIdLabelEn: 'Tax Registration No.',
    taxIdRegex: '^\\d{9}$',
    einvoice: 'eta', einvoiceNoteAr: 'ETA — فاتورة وإيصال إلكتروني',
  },
  AE: {
    code: 'AE', nameAr: 'الإمارات', nameEn: 'United Arab Emirates',
    currency: 'AED', currencyDecimals: 2, symbolAr: 'د.إ', symbolEn: 'AED',
    defaultVatPct: 5, locale: 'ar-AE',
    taxIdLabelAr: 'الرقم الضريبي (TRN)', taxIdLabelEn: 'TRN',
    taxIdRegex: '^\\d{15}$',
    einvoice: 'peppol', einvoiceNoteAr: 'Peppol (5-corner) — تطبيق مرحلي قادم',
  },
  KW: {
    code: 'KW', nameAr: 'الكويت', nameEn: 'Kuwait',
    currency: 'KWD', currencyDecimals: 3, symbolAr: 'د.ك', symbolEn: 'KWD',
    defaultVatPct: 0, locale: 'ar-KW',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'لا ضريبة قيمة مضافة بعد',
  },
  QA: {
    code: 'QA', nameAr: 'قطر', nameEn: 'Qatar',
    currency: 'QAR', currencyDecimals: 2, symbolAr: 'ر.ق', symbolEn: 'QAR',
    defaultVatPct: 0, locale: 'ar-QA',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'الضريبة والفوترة في التخطيط',
  },
  BH: {
    code: 'BH', nameAr: 'البحرين', nameEn: 'Bahrain',
    currency: 'BHD', currencyDecimals: 3, symbolAr: 'د.ب', symbolEn: 'BHD',
    defaultVatPct: 10, locale: 'ar-BH',
    taxIdLabelAr: 'رقم حساب الضريبة (VAT)', taxIdLabelEn: 'VAT Account No.',
    einvoice: 'none', einvoiceNoteAr: 'VAT 10% — فوترة إلكترونية غير إلزامية بعد',
  },
  OM: {
    code: 'OM', nameAr: 'عُمان', nameEn: 'Oman',
    currency: 'OMR', currencyDecimals: 3, symbolAr: 'ر.ع', symbolEn: 'OMR',
    defaultVatPct: 5, locale: 'ar-OM',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'VAT Number',
    einvoice: 'none', einvoiceNoteAr: 'VAT 5% — فوترة إلكترونية في التخطيط',
  },
  MA: {
    code: 'MA', nameAr: 'المغرب', nameEn: 'Morocco',
    currency: 'MAD', currencyDecimals: 2, symbolAr: 'د.م', symbolEn: 'MAD',
    defaultVatPct: 20, locale: 'fr-MA',
    taxIdLabelAr: 'المعرّف الموحّد (ICE)', taxIdLabelEn: 'ICE',
    taxIdRegex: '^\\d{15}$',
    einvoice: 'none', einvoiceNoteAr: 'TVA 20% — تتّجه للفوترة الإلكترونية',
  },
  DZ: {
    code: 'DZ', nameAr: 'الجزائر', nameEn: 'Algeria',
    currency: 'DZD', currencyDecimals: 2, symbolAr: 'د.ج', symbolEn: 'DZD',
    defaultVatPct: 19, locale: 'fr-DZ',
    taxIdLabelAr: 'رقم التعريف الجبائي', taxIdLabelEn: 'NIF',
    einvoice: 'none', einvoiceNoteAr: 'TVA 19% — الفوترة الإلكترونية قيد التطوير',
  },
  TN: {
    code: 'TN', nameAr: 'تونس', nameEn: 'Tunisia',
    currency: 'TND', currencyDecimals: 3, symbolAr: 'د.ت', symbolEn: 'TND',
    defaultVatPct: 19, locale: 'fr-TN',
    taxIdLabelAr: 'المعرّف الجبائي', taxIdLabelEn: 'Tax ID',
    einvoice: 'ttn', einvoiceNoteAr: 'el-Fatoura (TTN) — إلزامية جزئيًا',
  },
  JO: {
    code: 'JO', nameAr: 'الأردن', nameEn: 'Jordan',
    currency: 'JOD', currencyDecimals: 3, symbolAr: 'د.أ', symbolEn: 'JOD',
    defaultVatPct: 16, locale: 'ar-JO',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة المبيعات العامة 16%',
  },
};

export const DEFAULT_COUNTRY = 'SA';

// يعيد إعداد الدولة (مع الرجوع للسعودية افتراضيًا لأي رمز غير معروف)
export function getCountry(code?: string | null): CountryConfig {
  if (code && COUNTRIES[code.toUpperCase()]) return COUNTRIES[code.toUpperCase()];
  return COUNTRIES[DEFAULT_COUNTRY];
}

// قائمة الدول المدعومة (لعناصر الاختيار في الواجهة)
export function supportedCountries(): CountryConfig[] {
  return Object.values(COUNTRIES);
}

// ============================================================================
// تنسيق المبالغ حسب عملة الدولة وخاناتها العشرية (يحلّ مشكلة ٢ مقابل ٣ خانات)
// ============================================================================

// ينسّق مبلغًا بعملة دولة معيّنة (رمز الدولة) — يحترم الخانات العشرية واللغة
export function formatMoneyByCountry(
  amount: number | string,
  countryCode?: string | null,
  lang: 'ar' | 'en' = 'ar',
): string {
  const c = getCountry(countryCode);
  const n = Number(amount) || 0;
  const num = new Intl.NumberFormat(lang === 'en' ? 'en' : c.locale, {
    minimumFractionDigits: c.currencyDecimals,
    maximumFractionDigits: c.currencyDecimals,
  }).format(n);
  const symbol = lang === 'en' ? c.symbolEn : c.symbolAr;
  return `${num} ${symbol}`;
}

// ينسّق مبلغًا بعملة ISO مباشرة (SAR/EGP/…)، ويستنتج الخانات من أول دولة تطابق العملة
export function formatMoney(
  amount: number | string,
  currency = 'SAR',
  lang: 'ar' | 'en' = 'ar',
): string {
  const match = Object.values(COUNTRIES).find((c) => c.currency === currency);
  const decimals = match ? match.currencyDecimals : (THREE_DECIMAL.has(currency) ? 3 : 2);
  const n = Number(amount) || 0;
  const num = new Intl.NumberFormat(lang === 'en' ? 'en' : (match?.locale || 'ar'), {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(n);
  const symbol = lang === 'en' ? (match?.symbolEn || currency) : (match?.symbolAr || currency);
  return `${num} ${symbol}`;
}

// عملات عالمية شائعة بثلاث خانات (احتياط لعملة خارج السجلّ)
const THREE_DECIMAL = new Set(['KWD', 'BHD', 'OMR', 'TND', 'JOD', 'LYD', 'IQD']);

// عدد الخانات العشرية لعملة ISO (٢ افتراضيًا، ٣ للعملات المذكورة)
export function currencyDecimals(currency: string): number {
  const match = Object.values(COUNTRIES).find((c) => c.currency === currency);
  if (match) return match.currencyDecimals;
  return THREE_DECIMAL.has(currency) ? 3 : 2;
}
