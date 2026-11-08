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
    taxIdLabelAr: 'الرقم الضريبي VAT', taxIdLabelEn: 'VAT Number',
    taxIdRegex: '^3\\d{14}$',
    einvoice: 'zatca', einvoiceNoteAr: 'ZATCA فاتورة مطبق',
  },
  EG: {
    code: 'EG', nameAr: 'مصر', nameEn: 'Egypt',
    currency: 'EGP', currencyDecimals: 2, symbolAr: 'ج.م', symbolEn: 'EGP',
    defaultVatPct: 14, locale: 'ar-EG',
    taxIdLabelAr: 'رقم التسجيل الضريبي', taxIdLabelEn: 'Tax Registration No.',
    taxIdRegex: '^\\d{9}$',
    einvoice: 'eta', einvoiceNoteAr: 'ETA فاتورة وإيصال إلكتروني',
  },
  AE: {
    code: 'AE', nameAr: 'الإمارات', nameEn: 'United Arab Emirates',
    currency: 'AED', currencyDecimals: 2, symbolAr: 'د.إ', symbolEn: 'AED',
    defaultVatPct: 5, locale: 'ar-AE',
    taxIdLabelAr: 'الرقم الضريبي TRN', taxIdLabelEn: 'TRN',
    taxIdRegex: '^\\d{15}$',
    einvoice: 'peppol', einvoiceNoteAr: 'Peppol 5-corner تطبيق مرحلي قادم',
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
    taxIdLabelAr: 'رقم حساب الضريبة VAT', taxIdLabelEn: 'VAT Account No.',
    einvoice: 'none', einvoiceNoteAr: 'VAT 10% فوترة إلكترونية غير إلزامية بعد',
  },
  OM: {
    code: 'OM', nameAr: 'عمان', nameEn: 'Oman',
    currency: 'OMR', currencyDecimals: 3, symbolAr: 'ر.ع', symbolEn: 'OMR',
    defaultVatPct: 5, locale: 'ar-OM',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'VAT Number',
    einvoice: 'none', einvoiceNoteAr: 'VAT 5% فوترة إلكترونية في التخطيط',
  },
  MA: {
    code: 'MA', nameAr: 'المغرب', nameEn: 'Morocco',
    currency: 'MAD', currencyDecimals: 2, symbolAr: 'د.م', symbolEn: 'MAD',
    defaultVatPct: 20, locale: 'fr-MA',
    taxIdLabelAr: 'المعرف الموحد ICE', taxIdLabelEn: 'ICE',
    taxIdRegex: '^\\d{15}$',
    einvoice: 'none', einvoiceNoteAr: 'TVA 20% تتجه للفوترة الإلكترونية',
  },
  DZ: {
    code: 'DZ', nameAr: 'الجزائر', nameEn: 'Algeria',
    currency: 'DZD', currencyDecimals: 2, symbolAr: 'د.ج', symbolEn: 'DZD',
    defaultVatPct: 19, locale: 'fr-DZ',
    taxIdLabelAr: 'رقم التعريف الجبائي', taxIdLabelEn: 'NIF',
    einvoice: 'none', einvoiceNoteAr: 'TVA 19% الفوترة الإلكترونية قيد التطوير',
  },
  TN: {
    code: 'TN', nameAr: 'تونس', nameEn: 'Tunisia',
    currency: 'TND', currencyDecimals: 3, symbolAr: 'د.ت', symbolEn: 'TND',
    defaultVatPct: 19, locale: 'fr-TN',
    taxIdLabelAr: 'المعرف الجبائي', taxIdLabelEn: 'Tax ID',
    einvoice: 'ttn', einvoiceNoteAr: 'el-Fatoura TTN إلزامية جزئيا',
  },
  JO: {
    code: 'JO', nameAr: 'الأردن', nameEn: 'Jordan',
    currency: 'JOD', currencyDecimals: 3, symbolAr: 'د.أ', symbolEn: 'JOD',
    defaultVatPct: 16, locale: 'ar-JO',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة المبيعات العامة 16%',
  },
  IQ: {
    code: 'IQ', nameAr: 'العراق', nameEn: 'Iraq',
    currency: 'IQD', currencyDecimals: 0, symbolAr: 'د.ع', symbolEn: 'IQD',
    defaultVatPct: 0, locale: 'ar-IQ',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'لا ضريبة قيمة مضافة عامة بعد',
  },
  LB: {
    code: 'LB', nameAr: 'لبنان', nameEn: 'Lebanon',
    currency: 'LBP', currencyDecimals: 0, symbolAr: 'ل.ل', symbolEn: 'LBP',
    defaultVatPct: 11, locale: 'ar-LB',
    taxIdLabelAr: 'رقم التسجيل الضريبي', taxIdLabelEn: 'Tax Registration No.',
    einvoice: 'none', einvoiceNoteAr: 'TVA 11% فوترة بعملتين ل.ل/دولار',
  },
  LY: {
    code: 'LY', nameAr: 'ليبيا', nameEn: 'Libya',
    currency: 'LYD', currencyDecimals: 3, symbolAr: 'د.ل', symbolEn: 'LYD',
    defaultVatPct: 0, locale: 'ar-LY',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة الدمغة/الإنتاج حسب النشاط',
  },
  PS: {
    code: 'PS', nameAr: 'فلسطين', nameEn: 'Palestine',
    currency: 'ILS', currencyDecimals: 2, symbolAr: '₪', symbolEn: 'ILS',
    defaultVatPct: 16, locale: 'ar-PS',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة القيمة المضافة 16%',
  },
  SD: {
    code: 'SD', nameAr: 'السودان', nameEn: 'Sudan',
    currency: 'SDG', currencyDecimals: 2, symbolAr: 'ج.س', symbolEn: 'SDG',
    defaultVatPct: 17, locale: 'ar-SD',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة القيمة المضافة 17%',
  },
  YE: {
    code: 'YE', nameAr: 'اليمن', nameEn: 'Yemen',
    currency: 'YER', currencyDecimals: 2, symbolAr: 'ر.ي', symbolEn: 'YER',
    defaultVatPct: 5, locale: 'ar-YE',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة المبيعات العامة',
  },
  SY: {
    code: 'SY', nameAr: 'سوريا', nameEn: 'Syria',
    currency: 'SYP', currencyDecimals: 0, symbolAr: 'ل.س', symbolEn: 'SYP',
    defaultVatPct: 0, locale: 'ar-SY',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'رسوم إنفاق استهلاكي حسب النشاط',
  },
  MR: {
    code: 'MR', nameAr: 'موريتانيا', nameEn: 'Mauritania',
    currency: 'MRU', currencyDecimals: 2, symbolAr: 'أ.م', symbolEn: 'MRU',
    defaultVatPct: 16, locale: 'ar-MR',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة القيمة المضافة 16%',
  },
  DJ: {
    code: 'DJ', nameAr: 'جيبوتي', nameEn: 'Djibouti',
    currency: 'DJF', currencyDecimals: 0, symbolAr: 'ف.ج', symbolEn: 'DJF',
    defaultVatPct: 10, locale: 'fr-DJ',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة القيمة المضافة 10%',
  },
  SO: {
    code: 'SO', nameAr: 'الصومال', nameEn: 'Somalia',
    currency: 'SOS', currencyDecimals: 2, symbolAr: 'ش.ص', symbolEn: 'SOS',
    defaultVatPct: 0, locale: 'ar-SO',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'ضرائب مبيعات محلية حسب النشاط',
  },
  KM: {
    code: 'KM', nameAr: 'جزر القمر', nameEn: 'Comoros',
    currency: 'KMF', currencyDecimals: 0, symbolAr: 'ف.ق', symbolEn: 'KMF',
    defaultVatPct: 10, locale: 'ar-KM',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Number',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة الاستهلاك حسب النشاط',
  },
  // ── أسواق التوسّع غير العربية (مذكورة في areaServed التسويقي) ──
  TR: {
    code: 'TR', nameAr: 'تركيا', nameEn: 'Turkey',
    currency: 'TRY', currencyDecimals: 2, symbolAr: '₺', symbolEn: '₺',
    defaultVatPct: 20, locale: 'tr-TR',
    taxIdLabelAr: 'الرقم الضريبي VKN', taxIdLabelEn: 'Tax No. (VKN)',
    einvoice: 'none', einvoiceNoteAr: 'KDV 20% e-Fatura حكومي غير مدمج بعد',
  },
  PK: {
    code: 'PK', nameAr: 'باكستان', nameEn: 'Pakistan',
    currency: 'PKR', currencyDecimals: 2, symbolAr: '₨', symbolEn: '₨',
    defaultVatPct: 18, locale: 'en-PK',
    taxIdLabelAr: 'الرقم الضريبي NTN', taxIdLabelEn: 'NTN',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة المبيعات 18%',
  },
  ID: {
    code: 'ID', nameAr: 'إندونيسيا', nameEn: 'Indonesia',
    currency: 'IDR', currencyDecimals: 0, symbolAr: 'Rp', symbolEn: 'Rp',
    defaultVatPct: 11, locale: 'id-ID',
    taxIdLabelAr: 'الرقم الضريبي NPWP', taxIdLabelEn: 'NPWP',
    einvoice: 'none', einvoiceNoteAr: 'PPN 11%',
  },
  MY: {
    code: 'MY', nameAr: 'ماليزيا', nameEn: 'Malaysia',
    currency: 'MYR', currencyDecimals: 2, symbolAr: 'RM', symbolEn: 'RM',
    defaultVatPct: 10, locale: 'ms-MY',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax No.',
    einvoice: 'none', einvoiceNoteAr: 'SST e-Invoice حكومي غير مدمج بعد',
  },
  IN: {
    code: 'IN', nameAr: 'الهند', nameEn: 'India',
    currency: 'INR', currencyDecimals: 2, symbolAr: '₹', symbolEn: '₹',
    defaultVatPct: 18, locale: 'en-IN',
    taxIdLabelAr: 'الرقم الضريبي GSTIN', taxIdLabelEn: 'GSTIN',
    einvoice: 'none', einvoiceNoteAr: 'GST 18% e-Invoice حكومي غير مدمج بعد',
  },
  BD: {
    code: 'BD', nameAr: 'بنغلاديش', nameEn: 'Bangladesh',
    currency: 'BDT', currencyDecimals: 2, symbolAr: '৳', symbolEn: '৳',
    defaultVatPct: 15, locale: 'bn-BD',
    taxIdLabelAr: 'الرقم الضريبي BIN', taxIdLabelEn: 'BIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 15%',
  },
  LK: {
    code: 'LK', nameAr: 'سريلانكا', nameEn: 'Sri Lanka',
    currency: 'LKR', currencyDecimals: 2, symbolAr: 'Rs', symbolEn: 'Rs',
    defaultVatPct: 18, locale: 'en-LK',
    taxIdLabelAr: 'الرقم الضريبي TIN', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 18%',
  },
  NP: {
    code: 'NP', nameAr: 'نيبال', nameEn: 'Nepal',
    currency: 'NPR', currencyDecimals: 2, symbolAr: 'रू', symbolEn: 'Rs',
    defaultVatPct: 13, locale: 'ne-NP',
    taxIdLabelAr: 'الرقم الضريبي PAN', taxIdLabelEn: 'PAN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 13%',
  },
  PH: {
    code: 'PH', nameAr: 'الفلبين', nameEn: 'Philippines',
    currency: 'PHP', currencyDecimals: 2, symbolAr: '₱', symbolEn: '₱',
    defaultVatPct: 12, locale: 'en-PH',
    taxIdLabelAr: 'الرقم الضريبي TIN', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 12%',
  },
  VN: {
    code: 'VN', nameAr: 'فيتنام', nameEn: 'Vietnam',
    currency: 'VND', currencyDecimals: 0, symbolAr: '₫', symbolEn: '₫',
    defaultVatPct: 10, locale: 'vi-VN',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax Code',
    einvoice: 'none', einvoiceNoteAr: 'VAT 10%',
  },
  TH: {
    code: 'TH', nameAr: 'تايلاند', nameEn: 'Thailand',
    currency: 'THB', currencyDecimals: 2, symbolAr: '฿', symbolEn: '฿',
    defaultVatPct: 7, locale: 'th-TH',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'VAT 7%',
  },
  IR: {
    code: 'IR', nameAr: 'إيران', nameEn: 'Iran',
    currency: 'IRR', currencyDecimals: 0, symbolAr: '﷼', symbolEn: 'IRR',
    defaultVatPct: 9, locale: 'fa-IR',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax No.',
    einvoice: 'none', einvoiceNoteAr: 'VAT 9%',
  },
  AZ: {
    code: 'AZ', nameAr: 'أذربيجان', nameEn: 'Azerbaijan',
    currency: 'AZN', currencyDecimals: 2, symbolAr: '₼', symbolEn: '₼',
    defaultVatPct: 18, locale: 'az-AZ',
    taxIdLabelAr: 'الرقم الضريبي VÖEN', taxIdLabelEn: 'VÖEN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 18%',
  },
  KZ: {
    code: 'KZ', nameAr: 'كازاخستان', nameEn: 'Kazakhstan',
    currency: 'KZT', currencyDecimals: 2, symbolAr: '₸', symbolEn: '₸',
    defaultVatPct: 12, locale: 'kk-KZ',
    taxIdLabelAr: 'الرقم الضريبي BIN', taxIdLabelEn: 'BIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 12%',
  },
  NG: {
    code: 'NG', nameAr: 'نيجيريا', nameEn: 'Nigeria',
    currency: 'NGN', currencyDecimals: 2, symbolAr: '₦', symbolEn: '₦',
    defaultVatPct: 7.5, locale: 'en-NG',
    taxIdLabelAr: 'الرقم الضريبي TIN', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 7.5%',
  },
  SN: {
    code: 'SN', nameAr: 'السنغال', nameEn: 'Senegal',
    currency: 'XOF', currencyDecimals: 0, symbolAr: 'CFA', symbolEn: 'CFA',
    defaultVatPct: 18, locale: 'fr-SN',
    taxIdLabelAr: 'الرقم الضريبي NINEA', taxIdLabelEn: 'NINEA',
    einvoice: 'none', einvoiceNoteAr: 'TVA 18%',
  },
  KE: {
    code: 'KE', nameAr: 'كينيا', nameEn: 'Kenya',
    currency: 'KES', currencyDecimals: 2, symbolAr: 'KSh', symbolEn: 'KSh',
    defaultVatPct: 16, locale: 'en-KE',
    taxIdLabelAr: 'الرقم الضريبي KRA PIN', taxIdLabelEn: 'KRA PIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 16%',
  },
  ET: {
    code: 'ET', nameAr: 'إثيوبيا', nameEn: 'Ethiopia',
    currency: 'ETB', currencyDecimals: 2, symbolAr: 'Br', symbolEn: 'Br',
    defaultVatPct: 15, locale: 'en-ET',
    taxIdLabelAr: 'الرقم الضريبي TIN', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 15%',
  },
  GH: {
    code: 'GH', nameAr: 'غانا', nameEn: 'Ghana',
    currency: 'GHS', currencyDecimals: 2, symbolAr: '₵', symbolEn: '₵',
    defaultVatPct: 15, locale: 'en-GH',
    taxIdLabelAr: 'الرقم الضريبي TIN', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 15%',
  },
  CI: {
    code: 'CI', nameAr: 'ساحل العاج', nameEn: 'Ivory Coast',
    currency: 'XOF', currencyDecimals: 0, symbolAr: 'CFA', symbolEn: 'CFA',
    defaultVatPct: 18, locale: 'fr-CI',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax No.',
    einvoice: 'none', einvoiceNoteAr: 'TVA 18%',
  },
  TZ: {
    code: 'TZ', nameAr: 'تنزانيا', nameEn: 'Tanzania',
    currency: 'TZS', currencyDecimals: 2, symbolAr: 'TSh', symbolEn: 'TSh',
    defaultVatPct: 18, locale: 'en-TZ',
    taxIdLabelAr: 'الرقم الضريبي TIN', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 18%',
  },
  UG: {
    code: 'UG', nameAr: 'أوغندا', nameEn: 'Uganda',
    currency: 'UGX', currencyDecimals: 0, symbolAr: 'USh', symbolEn: 'USh',
    defaultVatPct: 18, locale: 'en-UG',
    taxIdLabelAr: 'الرقم الضريبي TIN', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 18%',
  },
  CM: {
    code: 'CM', nameAr: 'الكاميرون', nameEn: 'Cameroon',
    currency: 'XAF', currencyDecimals: 0, symbolAr: 'FCFA', symbolEn: 'FCFA',
    defaultVatPct: 19, locale: 'fr-CM',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax No.',
    einvoice: 'none', einvoiceNoteAr: 'TVA 19.25%',
  },
  ML: {
    code: 'ML', nameAr: 'مالي', nameEn: 'Mali',
    currency: 'XOF', currencyDecimals: 0, symbolAr: 'CFA', symbolEn: 'CFA',
    defaultVatPct: 18, locale: 'fr-ML',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax No.',
    einvoice: 'none', einvoiceNoteAr: 'TVA 18%',
  },
  NE: {
    code: 'NE', nameAr: 'النيجر', nameEn: 'Niger',
    currency: 'XOF', currencyDecimals: 0, symbolAr: 'CFA', symbolEn: 'CFA',
    defaultVatPct: 19, locale: 'fr-NE',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax No.',
    einvoice: 'none', einvoiceNoteAr: 'TVA 19%',
  },
  TD: {
    code: 'TD', nameAr: 'تشاد', nameEn: 'Chad',
    currency: 'XAF', currencyDecimals: 0, symbolAr: 'FCFA', symbolEn: 'FCFA',
    defaultVatPct: 18, locale: 'fr-TD',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax No.',
    einvoice: 'none', einvoiceNoteAr: 'TVA 18%',
  },
  BF: {
    code: 'BF', nameAr: 'بوركينا فاسو', nameEn: 'Burkina Faso',
    currency: 'XOF', currencyDecimals: 0, symbolAr: 'CFA', symbolEn: 'CFA',
    defaultVatPct: 18, locale: 'fr-BF',
    taxIdLabelAr: 'الرقم الضريبي IFU', taxIdLabelEn: 'IFU',
    einvoice: 'none', einvoiceNoteAr: 'TVA 18%',
  },
  ZA: {
    code: 'ZA', nameAr: 'جنوب أفريقيا', nameEn: 'South Africa',
    currency: 'ZAR', currencyDecimals: 2, symbolAr: 'R', symbolEn: 'R',
    defaultVatPct: 15, locale: 'en-ZA',
    taxIdLabelAr: 'الرقم الضريبي VAT', taxIdLabelEn: 'VAT No.',
    einvoice: 'none', einvoiceNoteAr: 'VAT 15%',
  },
  // بقية دول العالم (طلب المالك ٨ نوفمبر ٢٠٢٦: المنصة لكل الدول) — الضريبة الافتراضية إرشادية ويعدّلها المشترك من إعدادات الشركة،
  // والفوترة عادية بلا ربط حكومي (الربط عند الطلب عبر خدمة العملاء)
  AF: {
    code: 'AF', nameAr: 'أفغانستان', nameEn: 'Afghanistan',
    currency: 'AFN', currencyDecimals: 2, symbolAr: 'AFN', symbolEn: 'AFN',
    defaultVatPct: 10, locale: 'fa-AF',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  AL: {
    code: 'AL', nameAr: 'ألبانيا', nameEn: 'Albania',
    currency: 'ALL', currencyDecimals: 2, symbolAr: 'ALL', symbolEn: 'ALL',
    defaultVatPct: 20, locale: 'sq-AL',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  AO: {
    code: 'AO', nameAr: 'أنغولا', nameEn: 'Angola',
    currency: 'AOA', currencyDecimals: 2, symbolAr: 'AOA', symbolEn: 'AOA',
    defaultVatPct: 14, locale: 'pt-AO',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  AR: {
    code: 'AR', nameAr: 'الأرجنتين', nameEn: 'Argentina',
    currency: 'ARS', currencyDecimals: 2, symbolAr: 'ARS', symbolEn: 'ARS',
    defaultVatPct: 21, locale: 'es-AR',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  AM: {
    code: 'AM', nameAr: 'أرمينيا', nameEn: 'Armenia',
    currency: 'AMD', currencyDecimals: 2, symbolAr: 'AMD', symbolEn: 'AMD',
    defaultVatPct: 20, locale: 'hy-AM',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  AU: {
    code: 'AU', nameAr: 'أستراليا', nameEn: 'Australia',
    currency: 'AUD', currencyDecimals: 2, symbolAr: 'AUD', symbolEn: 'AUD',
    defaultVatPct: 10, locale: 'en-AU',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  AT: {
    code: 'AT', nameAr: 'النمسا', nameEn: 'Austria',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 20, locale: 'de-AT',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  BY: {
    code: 'BY', nameAr: 'بيلاروسيا', nameEn: 'Belarus',
    currency: 'BYN', currencyDecimals: 2, symbolAr: 'BYN', symbolEn: 'BYN',
    defaultVatPct: 20, locale: 'ru-BY',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  BE: {
    code: 'BE', nameAr: 'بلجيكا', nameEn: 'Belgium',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 21, locale: 'nl-BE',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  BJ: {
    code: 'BJ', nameAr: 'بنين', nameEn: 'Benin',
    currency: 'XOF', currencyDecimals: 0, symbolAr: 'XOF', symbolEn: 'XOF',
    defaultVatPct: 18, locale: 'fr-BJ',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  BO: {
    code: 'BO', nameAr: 'بوليفيا', nameEn: 'Bolivia',
    currency: 'BOB', currencyDecimals: 2, symbolAr: 'BOB', symbolEn: 'BOB',
    defaultVatPct: 13, locale: 'es-BO',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  BR: {
    code: 'BR', nameAr: 'البرازيل', nameEn: 'Brazil',
    currency: 'BRL', currencyDecimals: 2, symbolAr: 'BRL', symbolEn: 'BRL',
    defaultVatPct: 17, locale: 'pt-BR',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  BG: {
    code: 'BG', nameAr: 'بلغاريا', nameEn: 'Bulgaria',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 20, locale: 'bg-BG',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  KH: {
    code: 'KH', nameAr: 'كمبوديا', nameEn: 'Cambodia',
    currency: 'KHR', currencyDecimals: 2, symbolAr: 'KHR', symbolEn: 'KHR',
    defaultVatPct: 10, locale: 'km-KH',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  CA: {
    code: 'CA', nameAr: 'كندا', nameEn: 'Canada',
    currency: 'CAD', currencyDecimals: 2, symbolAr: 'CAD', symbolEn: 'CAD',
    defaultVatPct: 5, locale: 'en-CA',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  CL: {
    code: 'CL', nameAr: 'تشيلي', nameEn: 'Chile',
    currency: 'CLP', currencyDecimals: 0, symbolAr: 'CLP', symbolEn: 'CLP',
    defaultVatPct: 19, locale: 'es-CL',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  CN: {
    code: 'CN', nameAr: 'الصين', nameEn: 'China',
    currency: 'CNY', currencyDecimals: 2, symbolAr: 'CNY', symbolEn: 'CNY',
    defaultVatPct: 13, locale: 'zh-CN',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  CO: {
    code: 'CO', nameAr: 'كولومبيا', nameEn: 'Colombia',
    currency: 'COP', currencyDecimals: 2, symbolAr: 'COP', symbolEn: 'COP',
    defaultVatPct: 19, locale: 'es-CO',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  CG: {
    code: 'CG', nameAr: 'الكونغو', nameEn: 'Congo',
    currency: 'XAF', currencyDecimals: 0, symbolAr: 'XAF', symbolEn: 'XAF',
    defaultVatPct: 18, locale: 'fr-CG',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  CD: {
    code: 'CD', nameAr: 'الكونغو الديمقراطية', nameEn: 'Congo (DRC)',
    currency: 'CDF', currencyDecimals: 2, symbolAr: 'CDF', symbolEn: 'CDF',
    defaultVatPct: 16, locale: 'fr-CD',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  CR: {
    code: 'CR', nameAr: 'كوستاريكا', nameEn: 'Costa Rica',
    currency: 'CRC', currencyDecimals: 2, symbolAr: 'CRC', symbolEn: 'CRC',
    defaultVatPct: 13, locale: 'es-CR',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  HR: {
    code: 'HR', nameAr: 'كرواتيا', nameEn: 'Croatia',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 25, locale: 'hr-HR',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  CY: {
    code: 'CY', nameAr: 'قبرص', nameEn: 'Cyprus',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 19, locale: 'el-CY',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  CZ: {
    code: 'CZ', nameAr: 'التشيك', nameEn: 'Czechia',
    currency: 'CZK', currencyDecimals: 2, symbolAr: 'CZK', symbolEn: 'CZK',
    defaultVatPct: 21, locale: 'cs-CZ',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  DK: {
    code: 'DK', nameAr: 'الدنمارك', nameEn: 'Denmark',
    currency: 'DKK', currencyDecimals: 2, symbolAr: 'DKK', symbolEn: 'DKK',
    defaultVatPct: 25, locale: 'da-DK',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  DO: {
    code: 'DO', nameAr: 'الدومينيكان', nameEn: 'Dominican Republic',
    currency: 'DOP', currencyDecimals: 2, symbolAr: 'DOP', symbolEn: 'DOP',
    defaultVatPct: 18, locale: 'es-DO',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  EC: {
    code: 'EC', nameAr: 'الإكوادور', nameEn: 'Ecuador',
    currency: 'USD', currencyDecimals: 2, symbolAr: '$', symbolEn: '$',
    defaultVatPct: 15, locale: 'es-EC',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  FI: {
    code: 'FI', nameAr: 'فنلندا', nameEn: 'Finland',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 25.5, locale: 'fi-FI',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  FR: {
    code: 'FR', nameAr: 'فرنسا', nameEn: 'France',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 20, locale: 'fr-FR',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  GA: {
    code: 'GA', nameAr: 'الغابون', nameEn: 'Gabon',
    currency: 'XAF', currencyDecimals: 0, symbolAr: 'XAF', symbolEn: 'XAF',
    defaultVatPct: 18, locale: 'fr-GA',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  GE: {
    code: 'GE', nameAr: 'جورجيا', nameEn: 'Georgia',
    currency: 'GEL', currencyDecimals: 2, symbolAr: 'GEL', symbolEn: 'GEL',
    defaultVatPct: 18, locale: 'ka-GE',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  DE: {
    code: 'DE', nameAr: 'ألمانيا', nameEn: 'Germany',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 19, locale: 'de-DE',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  GR: {
    code: 'GR', nameAr: 'اليونان', nameEn: 'Greece',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 24, locale: 'el-GR',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  GT: {
    code: 'GT', nameAr: 'غواتيمالا', nameEn: 'Guatemala',
    currency: 'GTQ', currencyDecimals: 2, symbolAr: 'GTQ', symbolEn: 'GTQ',
    defaultVatPct: 12, locale: 'es-GT',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  GN: {
    code: 'GN', nameAr: 'غينيا', nameEn: 'Guinea',
    currency: 'GNF', currencyDecimals: 0, symbolAr: 'GNF', symbolEn: 'GNF',
    defaultVatPct: 18, locale: 'fr-GN',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  HN: {
    code: 'HN', nameAr: 'هندوراس', nameEn: 'Honduras',
    currency: 'HNL', currencyDecimals: 2, symbolAr: 'HNL', symbolEn: 'HNL',
    defaultVatPct: 15, locale: 'es-HN',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  HK: {
    code: 'HK', nameAr: 'هونغ كونغ', nameEn: 'Hong Kong',
    currency: 'HKD', currencyDecimals: 2, symbolAr: 'HKD', symbolEn: 'HKD',
    defaultVatPct: 0, locale: 'zh-HK',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  HU: {
    code: 'HU', nameAr: 'المجر', nameEn: 'Hungary',
    currency: 'HUF', currencyDecimals: 2, symbolAr: 'HUF', symbolEn: 'HUF',
    defaultVatPct: 27, locale: 'hu-HU',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  IS: {
    code: 'IS', nameAr: 'آيسلندا', nameEn: 'Iceland',
    currency: 'ISK', currencyDecimals: 0, symbolAr: 'ISK', symbolEn: 'ISK',
    defaultVatPct: 24, locale: 'is-IS',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  IE: {
    code: 'IE', nameAr: 'أيرلندا', nameEn: 'Ireland',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 23, locale: 'en-IE',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  IT: {
    code: 'IT', nameAr: 'إيطاليا', nameEn: 'Italy',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 22, locale: 'it-IT',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  JP: {
    code: 'JP', nameAr: 'اليابان', nameEn: 'Japan',
    currency: 'JPY', currencyDecimals: 0, symbolAr: 'JPY', symbolEn: 'JPY',
    defaultVatPct: 10, locale: 'ja-JP',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  KG: {
    code: 'KG', nameAr: 'قيرغيزستان', nameEn: 'Kyrgyzstan',
    currency: 'KGS', currencyDecimals: 2, symbolAr: 'KGS', symbolEn: 'KGS',
    defaultVatPct: 12, locale: 'ky-KG',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  LA: {
    code: 'LA', nameAr: 'لاوس', nameEn: 'Laos',
    currency: 'LAK', currencyDecimals: 2, symbolAr: 'LAK', symbolEn: 'LAK',
    defaultVatPct: 10, locale: 'lo-LA',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  LV: {
    code: 'LV', nameAr: 'لاتفيا', nameEn: 'Latvia',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 21, locale: 'lv-LV',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  LT: {
    code: 'LT', nameAr: 'ليتوانيا', nameEn: 'Lithuania',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 21, locale: 'lt-LT',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  LU: {
    code: 'LU', nameAr: 'لوكسمبورغ', nameEn: 'Luxembourg',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 17, locale: 'fr-LU',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  MG: {
    code: 'MG', nameAr: 'مدغشقر', nameEn: 'Madagascar',
    currency: 'MGA', currencyDecimals: 2, symbolAr: 'MGA', symbolEn: 'MGA',
    defaultVatPct: 20, locale: 'fr-MG',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  MT: {
    code: 'MT', nameAr: 'مالطا', nameEn: 'Malta',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 18, locale: 'en-MT',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  MX: {
    code: 'MX', nameAr: 'المكسيك', nameEn: 'Mexico',
    currency: 'MXN', currencyDecimals: 2, symbolAr: 'MXN', symbolEn: 'MXN',
    defaultVatPct: 16, locale: 'es-MX',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  MD: {
    code: 'MD', nameAr: 'مولدوفا', nameEn: 'Moldova',
    currency: 'MDL', currencyDecimals: 2, symbolAr: 'MDL', symbolEn: 'MDL',
    defaultVatPct: 20, locale: 'ro-MD',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  MN: {
    code: 'MN', nameAr: 'منغوليا', nameEn: 'Mongolia',
    currency: 'MNT', currencyDecimals: 2, symbolAr: 'MNT', symbolEn: 'MNT',
    defaultVatPct: 10, locale: 'mn-MN',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  MZ: {
    code: 'MZ', nameAr: 'موزمبيق', nameEn: 'Mozambique',
    currency: 'MZN', currencyDecimals: 2, symbolAr: 'MZN', symbolEn: 'MZN',
    defaultVatPct: 16, locale: 'pt-MZ',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  MM: {
    code: 'MM', nameAr: 'ميانمار', nameEn: 'Myanmar',
    currency: 'MMK', currencyDecimals: 2, symbolAr: 'MMK', symbolEn: 'MMK',
    defaultVatPct: 5, locale: 'my-MM',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  NL: {
    code: 'NL', nameAr: 'هولندا', nameEn: 'Netherlands',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 21, locale: 'nl-NL',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  NZ: {
    code: 'NZ', nameAr: 'نيوزيلندا', nameEn: 'New Zealand',
    currency: 'NZD', currencyDecimals: 2, symbolAr: 'NZD', symbolEn: 'NZD',
    defaultVatPct: 15, locale: 'en-NZ',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  NO: {
    code: 'NO', nameAr: 'النرويج', nameEn: 'Norway',
    currency: 'NOK', currencyDecimals: 2, symbolAr: 'NOK', symbolEn: 'NOK',
    defaultVatPct: 25, locale: 'nb-NO',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  PA: {
    code: 'PA', nameAr: 'بنما', nameEn: 'Panama',
    currency: 'USD', currencyDecimals: 2, symbolAr: '$', symbolEn: '$',
    defaultVatPct: 7, locale: 'es-PA',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  PY: {
    code: 'PY', nameAr: 'باراغواي', nameEn: 'Paraguay',
    currency: 'PYG', currencyDecimals: 0, symbolAr: 'PYG', symbolEn: 'PYG',
    defaultVatPct: 10, locale: 'es-PY',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  PE: {
    code: 'PE', nameAr: 'بيرو', nameEn: 'Peru',
    currency: 'PEN', currencyDecimals: 2, symbolAr: 'PEN', symbolEn: 'PEN',
    defaultVatPct: 18, locale: 'es-PE',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  PL: {
    code: 'PL', nameAr: 'بولندا', nameEn: 'Poland',
    currency: 'PLN', currencyDecimals: 2, symbolAr: 'PLN', symbolEn: 'PLN',
    defaultVatPct: 23, locale: 'pl-PL',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  PT: {
    code: 'PT', nameAr: 'البرتغال', nameEn: 'Portugal',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 23, locale: 'pt-PT',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  RO: {
    code: 'RO', nameAr: 'رومانيا', nameEn: 'Romania',
    currency: 'RON', currencyDecimals: 2, symbolAr: 'RON', symbolEn: 'RON',
    defaultVatPct: 21, locale: 'ro-RO',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  RU: {
    code: 'RU', nameAr: 'روسيا', nameEn: 'Russia',
    currency: 'RUB', currencyDecimals: 2, symbolAr: 'RUB', symbolEn: 'RUB',
    defaultVatPct: 22, locale: 'ru-RU',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  RW: {
    code: 'RW', nameAr: 'رواندا', nameEn: 'Rwanda',
    currency: 'RWF', currencyDecimals: 0, symbolAr: 'RWF', symbolEn: 'RWF',
    defaultVatPct: 18, locale: 'rw-RW',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  RS: {
    code: 'RS', nameAr: 'صربيا', nameEn: 'Serbia',
    currency: 'RSD', currencyDecimals: 2, symbolAr: 'RSD', symbolEn: 'RSD',
    defaultVatPct: 20, locale: 'sr-RS',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  SG: {
    code: 'SG', nameAr: 'سنغافورة', nameEn: 'Singapore',
    currency: 'SGD', currencyDecimals: 2, symbolAr: 'SGD', symbolEn: 'SGD',
    defaultVatPct: 9, locale: 'en-SG',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  SK: {
    code: 'SK', nameAr: 'سلوفاكيا', nameEn: 'Slovakia',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 23, locale: 'sk-SK',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  SI: {
    code: 'SI', nameAr: 'سلوفينيا', nameEn: 'Slovenia',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 22, locale: 'sl-SI',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  KR: {
    code: 'KR', nameAr: 'كوريا الجنوبية', nameEn: 'South Korea',
    currency: 'KRW', currencyDecimals: 0, symbolAr: 'KRW', symbolEn: 'KRW',
    defaultVatPct: 10, locale: 'ko-KR',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  SS: {
    code: 'SS', nameAr: 'جنوب السودان', nameEn: 'South Sudan',
    currency: 'SSP', currencyDecimals: 2, symbolAr: 'SSP', symbolEn: 'SSP',
    defaultVatPct: 18, locale: 'en-SS',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  ES: {
    code: 'ES', nameAr: 'إسبانيا', nameEn: 'Spain',
    currency: 'EUR', currencyDecimals: 2, symbolAr: '€', symbolEn: '€',
    defaultVatPct: 21, locale: 'es-ES',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  SE: {
    code: 'SE', nameAr: 'السويد', nameEn: 'Sweden',
    currency: 'SEK', currencyDecimals: 2, symbolAr: 'SEK', symbolEn: 'SEK',
    defaultVatPct: 25, locale: 'sv-SE',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  CH: {
    code: 'CH', nameAr: 'سويسرا', nameEn: 'Switzerland',
    currency: 'CHF', currencyDecimals: 2, symbolAr: 'CHF', symbolEn: 'CHF',
    defaultVatPct: 8.1, locale: 'de-CH',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  TW: {
    code: 'TW', nameAr: 'تايوان', nameEn: 'Taiwan',
    currency: 'TWD', currencyDecimals: 2, symbolAr: 'TWD', symbolEn: 'TWD',
    defaultVatPct: 5, locale: 'zh-TW',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  TJ: {
    code: 'TJ', nameAr: 'طاجيكستان', nameEn: 'Tajikistan',
    currency: 'TJS', currencyDecimals: 2, symbolAr: 'TJS', symbolEn: 'TJS',
    defaultVatPct: 14, locale: 'tg-TJ',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  TG: {
    code: 'TG', nameAr: 'توغو', nameEn: 'Togo',
    currency: 'XOF', currencyDecimals: 0, symbolAr: 'XOF', symbolEn: 'XOF',
    defaultVatPct: 18, locale: 'fr-TG',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  TM: {
    code: 'TM', nameAr: 'تركمانستان', nameEn: 'Turkmenistan',
    currency: 'TMT', currencyDecimals: 2, symbolAr: 'TMT', symbolEn: 'TMT',
    defaultVatPct: 15, locale: 'tk-TM',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  UA: {
    code: 'UA', nameAr: 'أوكرانيا', nameEn: 'Ukraine',
    currency: 'UAH', currencyDecimals: 2, symbolAr: 'UAH', symbolEn: 'UAH',
    defaultVatPct: 20, locale: 'uk-UA',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  GB: {
    code: 'GB', nameAr: 'المملكة المتحدة', nameEn: 'United Kingdom',
    currency: 'GBP', currencyDecimals: 2, symbolAr: '£', symbolEn: '£',
    defaultVatPct: 20, locale: 'en-GB',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  US: {
    code: 'US', nameAr: 'الولايات المتحدة', nameEn: 'United States',
    currency: 'USD', currencyDecimals: 2, symbolAr: '$', symbolEn: '$',
    defaultVatPct: 0, locale: 'en-US',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  UY: {
    code: 'UY', nameAr: 'أوروغواي', nameEn: 'Uruguay',
    currency: 'UYU', currencyDecimals: 2, symbolAr: 'UYU', symbolEn: 'UYU',
    defaultVatPct: 22, locale: 'es-UY',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  UZ: {
    code: 'UZ', nameAr: 'أوزبكستان', nameEn: 'Uzbekistan',
    currency: 'UZS', currencyDecimals: 2, symbolAr: 'UZS', symbolEn: 'UZS',
    defaultVatPct: 12, locale: 'uz-UZ',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  VE: {
    code: 'VE', nameAr: 'فنزويلا', nameEn: 'Venezuela',
    currency: 'VES', currencyDecimals: 2, symbolAr: 'VES', symbolEn: 'VES',
    defaultVatPct: 16, locale: 'es-VE',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  ZM: {
    code: 'ZM', nameAr: 'زامبيا', nameEn: 'Zambia',
    currency: 'ZMW', currencyDecimals: 2, symbolAr: 'ZMW', symbolEn: 'ZMW',
    defaultVatPct: 16, locale: 'en-ZM',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  ZW: {
    code: 'ZW', nameAr: 'زيمبابوي', nameEn: 'Zimbabwe',
    currency: 'USD', currencyDecimals: 2, symbolAr: '$', symbolEn: '$',
    defaultVatPct: 15.5, locale: 'en-ZW',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
  },
  // «دولة أخرى»: لأي دولة غير مدرجة — دولار وضريبة يحدّدها المشترك (XX رمز ISO محجوز للاستخدام الخاص، لا يُرسل لـZATCA)
  XX: {
    code: 'XX', nameAr: 'دولة أخرى', nameEn: 'Other country',
    currency: 'USD', currencyDecimals: 2, symbolAr: '$', symbolEn: '$',
    defaultVatPct: 0, locale: 'en-US',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax ID',
    einvoice: 'none', einvoiceNoteAr: 'فواتير عادية والربط الحكومي عند الطلب',
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

// رمز عملة ISO (من السجلّ، أو رمز العملة نفسه احتياطًا)
export function currencySymbol(currency: string, lang: 'ar' | 'en' = 'ar'): string {
  // عملتا التجاوز الدوليتان (لا دولة لهما في السجل)
  if (currency === 'USD') return '$';
  if (currency === 'EUR') return '€';
  const match = Object.values(COUNTRIES).find((c) => c.currency === currency);
  if (!match) return currency;
  return lang === 'en' ? match.symbolEn : match.symbolAr;
}
