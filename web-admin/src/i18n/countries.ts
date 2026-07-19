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
    einvoice: 'none', einvoiceNoteAr: 'TVA 11% — فوترة بعملتين (ل.ل/دولار)',
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
    taxIdLabelAr: 'الرقم الضريبي (VKN)', taxIdLabelEn: 'Tax No. (VKN)',
    einvoice: 'none', einvoiceNoteAr: 'KDV 20% — e-Fatura حكومي (غير مدمج بعد)',
  },
  PK: {
    code: 'PK', nameAr: 'باكستان', nameEn: 'Pakistan',
    currency: 'PKR', currencyDecimals: 2, symbolAr: '₨', symbolEn: '₨',
    defaultVatPct: 18, locale: 'en-PK',
    taxIdLabelAr: 'الرقم الضريبي (NTN)', taxIdLabelEn: 'NTN',
    einvoice: 'none', einvoiceNoteAr: 'ضريبة المبيعات 18%',
  },
  ID: {
    code: 'ID', nameAr: 'إندونيسيا', nameEn: 'Indonesia',
    currency: 'IDR', currencyDecimals: 0, symbolAr: 'Rp', symbolEn: 'Rp',
    defaultVatPct: 11, locale: 'id-ID',
    taxIdLabelAr: 'الرقم الضريبي (NPWP)', taxIdLabelEn: 'NPWP',
    einvoice: 'none', einvoiceNoteAr: 'PPN 11%',
  },
  MY: {
    code: 'MY', nameAr: 'ماليزيا', nameEn: 'Malaysia',
    currency: 'MYR', currencyDecimals: 2, symbolAr: 'RM', symbolEn: 'RM',
    defaultVatPct: 10, locale: 'ms-MY',
    taxIdLabelAr: 'الرقم الضريبي', taxIdLabelEn: 'Tax No.',
    einvoice: 'none', einvoiceNoteAr: 'SST — e-Invoice حكومي (غير مدمج بعد)',
  },
  IN: {
    code: 'IN', nameAr: 'الهند', nameEn: 'India',
    currency: 'INR', currencyDecimals: 2, symbolAr: '₹', symbolEn: '₹',
    defaultVatPct: 18, locale: 'en-IN',
    taxIdLabelAr: 'الرقم الضريبي (GSTIN)', taxIdLabelEn: 'GSTIN',
    einvoice: 'none', einvoiceNoteAr: 'GST 18% — e-Invoice حكومي (غير مدمج بعد)',
  },
  BD: {
    code: 'BD', nameAr: 'بنغلاديش', nameEn: 'Bangladesh',
    currency: 'BDT', currencyDecimals: 2, symbolAr: '৳', symbolEn: '৳',
    defaultVatPct: 15, locale: 'bn-BD',
    taxIdLabelAr: 'الرقم الضريبي (BIN)', taxIdLabelEn: 'BIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 15%',
  },
  LK: {
    code: 'LK', nameAr: 'سريلانكا', nameEn: 'Sri Lanka',
    currency: 'LKR', currencyDecimals: 2, symbolAr: 'Rs', symbolEn: 'Rs',
    defaultVatPct: 18, locale: 'en-LK',
    taxIdLabelAr: 'الرقم الضريبي (TIN)', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 18%',
  },
  NP: {
    code: 'NP', nameAr: 'نيبال', nameEn: 'Nepal',
    currency: 'NPR', currencyDecimals: 2, symbolAr: 'रू', symbolEn: 'Rs',
    defaultVatPct: 13, locale: 'ne-NP',
    taxIdLabelAr: 'الرقم الضريبي (PAN)', taxIdLabelEn: 'PAN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 13%',
  },
  PH: {
    code: 'PH', nameAr: 'الفلبين', nameEn: 'Philippines',
    currency: 'PHP', currencyDecimals: 2, symbolAr: '₱', symbolEn: '₱',
    defaultVatPct: 12, locale: 'en-PH',
    taxIdLabelAr: 'الرقم الضريبي (TIN)', taxIdLabelEn: 'TIN',
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
    taxIdLabelAr: 'الرقم الضريبي (VÖEN)', taxIdLabelEn: 'VÖEN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 18%',
  },
  KZ: {
    code: 'KZ', nameAr: 'كازاخستان', nameEn: 'Kazakhstan',
    currency: 'KZT', currencyDecimals: 2, symbolAr: '₸', symbolEn: '₸',
    defaultVatPct: 12, locale: 'kk-KZ',
    taxIdLabelAr: 'الرقم الضريبي (BIN)', taxIdLabelEn: 'BIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 12%',
  },
  NG: {
    code: 'NG', nameAr: 'نيجيريا', nameEn: 'Nigeria',
    currency: 'NGN', currencyDecimals: 2, symbolAr: '₦', symbolEn: '₦',
    defaultVatPct: 7.5, locale: 'en-NG',
    taxIdLabelAr: 'الرقم الضريبي (TIN)', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 7.5%',
  },
  SN: {
    code: 'SN', nameAr: 'السنغال', nameEn: 'Senegal',
    currency: 'XOF', currencyDecimals: 0, symbolAr: 'CFA', symbolEn: 'CFA',
    defaultVatPct: 18, locale: 'fr-SN',
    taxIdLabelAr: 'الرقم الضريبي (NINEA)', taxIdLabelEn: 'NINEA',
    einvoice: 'none', einvoiceNoteAr: 'TVA 18%',
  },
  KE: {
    code: 'KE', nameAr: 'كينيا', nameEn: 'Kenya',
    currency: 'KES', currencyDecimals: 2, symbolAr: 'KSh', symbolEn: 'KSh',
    defaultVatPct: 16, locale: 'en-KE',
    taxIdLabelAr: 'الرقم الضريبي (KRA PIN)', taxIdLabelEn: 'KRA PIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 16%',
  },
  ET: {
    code: 'ET', nameAr: 'إثيوبيا', nameEn: 'Ethiopia',
    currency: 'ETB', currencyDecimals: 2, symbolAr: 'Br', symbolEn: 'Br',
    defaultVatPct: 15, locale: 'en-ET',
    taxIdLabelAr: 'الرقم الضريبي (TIN)', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 15%',
  },
  GH: {
    code: 'GH', nameAr: 'غانا', nameEn: 'Ghana',
    currency: 'GHS', currencyDecimals: 2, symbolAr: '₵', symbolEn: '₵',
    defaultVatPct: 15, locale: 'en-GH',
    taxIdLabelAr: 'الرقم الضريبي (TIN)', taxIdLabelEn: 'TIN',
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
    taxIdLabelAr: 'الرقم الضريبي (TIN)', taxIdLabelEn: 'TIN',
    einvoice: 'none', einvoiceNoteAr: 'VAT 18%',
  },
  UG: {
    code: 'UG', nameAr: 'أوغندا', nameEn: 'Uganda',
    currency: 'UGX', currencyDecimals: 0, symbolAr: 'USh', symbolEn: 'USh',
    defaultVatPct: 18, locale: 'en-UG',
    taxIdLabelAr: 'الرقم الضريبي (TIN)', taxIdLabelEn: 'TIN',
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
    taxIdLabelAr: 'الرقم الضريبي (IFU)', taxIdLabelEn: 'IFU',
    einvoice: 'none', einvoiceNoteAr: 'TVA 18%',
  },
  ZA: {
    code: 'ZA', nameAr: 'جنوب أفريقيا', nameEn: 'South Africa',
    currency: 'ZAR', currencyDecimals: 2, symbolAr: 'R', symbolEn: 'R',
    defaultVatPct: 15, locale: 'en-ZA',
    taxIdLabelAr: 'الرقم الضريبي (VAT)', taxIdLabelEn: 'VAT No.',
    einvoice: 'none', einvoiceNoteAr: 'VAT 15%',
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
  const match = Object.values(COUNTRIES).find((c) => c.currency === currency);
  if (!match) return currency;
  return lang === 'en' ? match.symbolEn : match.symbolAr;
}
