// ============================================================================
// رموز الاتصال الدولية (Dial Codes) — لاختيار مفتاح هاتف أيّ دولة في نماذج التسجيل
// ----------------------------------------------------------------------------
// الدول العربية أولاً (الأكثر صلة بالسوق) ثم بقية دول العالم. العلم يُحسب من رمز
// الدولة ISO (حروف المؤشّر الإقليمي) فلا نخزّنه.
// ============================================================================

export interface DialCountry {
  code: string; // ISO 3166-1 alpha-2
  dial: string; // رمز الاتصال بصيغة +XXX
  ar: string;
  en: string;
}

// علم الدولة (emoji) من رمزها ISO — حرفا المؤشّر الإقليمي
export function flagOf(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '🌐';
  return String.fromCodePoint(...code.toUpperCase().split('').map((c) => 127397 + c.charCodeAt(0)));
}

// الدول العربية (تُعرض في مجموعة أولى)
export const ARAB_DIAL: DialCountry[] = [
  { code: 'SA', dial: '+966', ar: 'السعودية', en: 'Saudi Arabia' },
  { code: 'AE', dial: '+971', ar: 'الإمارات', en: 'United Arab Emirates' },
  { code: 'EG', dial: '+20', ar: 'مصر', en: 'Egypt' },
  { code: 'KW', dial: '+965', ar: 'الكويت', en: 'Kuwait' },
  { code: 'QA', dial: '+974', ar: 'قطر', en: 'Qatar' },
  { code: 'BH', dial: '+973', ar: 'البحرين', en: 'Bahrain' },
  { code: 'OM', dial: '+968', ar: 'عُمان', en: 'Oman' },
  { code: 'JO', dial: '+962', ar: 'الأردن', en: 'Jordan' },
  { code: 'MA', dial: '+212', ar: 'المغرب', en: 'Morocco' },
  { code: 'DZ', dial: '+213', ar: 'الجزائر', en: 'Algeria' },
  { code: 'TN', dial: '+216', ar: 'تونس', en: 'Tunisia' },
  { code: 'LB', dial: '+961', ar: 'لبنان', en: 'Lebanon' },
  { code: 'IQ', dial: '+964', ar: 'العراق', en: 'Iraq' },
  { code: 'SY', dial: '+963', ar: 'سوريا', en: 'Syria' },
  { code: 'YE', dial: '+967', ar: 'اليمن', en: 'Yemen' },
  { code: 'LY', dial: '+218', ar: 'ليبيا', en: 'Libya' },
  { code: 'SD', dial: '+249', ar: 'السودان', en: 'Sudan' },
  { code: 'PS', dial: '+970', ar: 'فلسطين', en: 'Palestine' },
  { code: 'MR', dial: '+222', ar: 'موريتانيا', en: 'Mauritania' },
  { code: 'DJ', dial: '+253', ar: 'جيبوتي', en: 'Djibouti' },
  { code: 'SO', dial: '+252', ar: 'الصومال', en: 'Somalia' },
  { code: 'KM', dial: '+269', ar: 'جزر القمر', en: 'Comoros' },
];

// بقية دول العالم (مجموعة ثانية) — مرتّبة حسب الاسم الإنجليزي تقريباً
export const WORLD_DIAL: DialCountry[] = [
  { code: 'AF', dial: '+93', ar: 'أفغانستان', en: 'Afghanistan' },
  { code: 'AL', dial: '+355', ar: 'ألبانيا', en: 'Albania' },
  { code: 'AO', dial: '+244', ar: 'أنغولا', en: 'Angola' },
  { code: 'AR', dial: '+54', ar: 'الأرجنتين', en: 'Argentina' },
  { code: 'AM', dial: '+374', ar: 'أرمينيا', en: 'Armenia' },
  { code: 'AU', dial: '+61', ar: 'أستراليا', en: 'Australia' },
  { code: 'AT', dial: '+43', ar: 'النمسا', en: 'Austria' },
  { code: 'AZ', dial: '+994', ar: 'أذربيجان', en: 'Azerbaijan' },
  { code: 'BD', dial: '+880', ar: 'بنغلاديش', en: 'Bangladesh' },
  { code: 'BY', dial: '+375', ar: 'بيلاروسيا', en: 'Belarus' },
  { code: 'BE', dial: '+32', ar: 'بلجيكا', en: 'Belgium' },
  { code: 'BJ', dial: '+229', ar: 'بنين', en: 'Benin' },
  { code: 'BO', dial: '+591', ar: 'بوليفيا', en: 'Bolivia' },
  { code: 'BR', dial: '+55', ar: 'البرازيل', en: 'Brazil' },
  { code: 'BG', dial: '+359', ar: 'بلغاريا', en: 'Bulgaria' },
  { code: 'BF', dial: '+226', ar: 'بوركينا فاسو', en: 'Burkina Faso' },
  { code: 'KH', dial: '+855', ar: 'كمبوديا', en: 'Cambodia' },
  { code: 'CM', dial: '+237', ar: 'الكاميرون', en: 'Cameroon' },
  { code: 'CA', dial: '+1', ar: 'كندا', en: 'Canada' },
  { code: 'TD', dial: '+235', ar: 'تشاد', en: 'Chad' },
  { code: 'CL', dial: '+56', ar: 'تشيلي', en: 'Chile' },
  { code: 'CN', dial: '+86', ar: 'الصين', en: 'China' },
  { code: 'CO', dial: '+57', ar: 'كولومبيا', en: 'Colombia' },
  { code: 'CG', dial: '+242', ar: 'الكونغو', en: 'Congo' },
  { code: 'CD', dial: '+243', ar: 'الكونغو الديمقراطية', en: 'Congo (DRC)' },
  { code: 'CR', dial: '+506', ar: 'كوستاريكا', en: 'Costa Rica' },
  { code: 'CI', dial: '+225', ar: 'ساحل العاج', en: 'Côte d’Ivoire' },
  { code: 'HR', dial: '+385', ar: 'كرواتيا', en: 'Croatia' },
  { code: 'CY', dial: '+357', ar: 'قبرص', en: 'Cyprus' },
  { code: 'CZ', dial: '+420', ar: 'التشيك', en: 'Czechia' },
  { code: 'DK', dial: '+45', ar: 'الدنمارك', en: 'Denmark' },
  { code: 'DO', dial: '+1', ar: 'الدومينيكان', en: 'Dominican Republic' },
  { code: 'EC', dial: '+593', ar: 'الإكوادور', en: 'Ecuador' },
  { code: 'ET', dial: '+251', ar: 'إثيوبيا', en: 'Ethiopia' },
  { code: 'FI', dial: '+358', ar: 'فنلندا', en: 'Finland' },
  { code: 'FR', dial: '+33', ar: 'فرنسا', en: 'France' },
  { code: 'GA', dial: '+241', ar: 'الغابون', en: 'Gabon' },
  { code: 'GE', dial: '+995', ar: 'جورجيا', en: 'Georgia' },
  { code: 'DE', dial: '+49', ar: 'ألمانيا', en: 'Germany' },
  { code: 'GH', dial: '+233', ar: 'غانا', en: 'Ghana' },
  { code: 'GR', dial: '+30', ar: 'اليونان', en: 'Greece' },
  { code: 'GT', dial: '+502', ar: 'غواتيمالا', en: 'Guatemala' },
  { code: 'GN', dial: '+224', ar: 'غينيا', en: 'Guinea' },
  { code: 'HN', dial: '+504', ar: 'هندوراس', en: 'Honduras' },
  { code: 'HK', dial: '+852', ar: 'هونغ كونغ', en: 'Hong Kong' },
  { code: 'HU', dial: '+36', ar: 'المجر', en: 'Hungary' },
  { code: 'IS', dial: '+354', ar: 'آيسلندا', en: 'Iceland' },
  { code: 'IN', dial: '+91', ar: 'الهند', en: 'India' },
  { code: 'ID', dial: '+62', ar: 'إندونيسيا', en: 'Indonesia' },
  { code: 'IR', dial: '+98', ar: 'إيران', en: 'Iran' },
  { code: 'IE', dial: '+353', ar: 'أيرلندا', en: 'Ireland' },
  { code: 'IT', dial: '+39', ar: 'إيطاليا', en: 'Italy' },
  { code: 'JP', dial: '+81', ar: 'اليابان', en: 'Japan' },
  { code: 'KZ', dial: '+7', ar: 'كازاخستان', en: 'Kazakhstan' },
  { code: 'KE', dial: '+254', ar: 'كينيا', en: 'Kenya' },
  { code: 'KR', dial: '+82', ar: 'كوريا الجنوبية', en: 'South Korea' },
  { code: 'KG', dial: '+996', ar: 'قيرغيزستان', en: 'Kyrgyzstan' },
  { code: 'LA', dial: '+856', ar: 'لاوس', en: 'Laos' },
  { code: 'LV', dial: '+371', ar: 'لاتفيا', en: 'Latvia' },
  { code: 'LT', dial: '+370', ar: 'ليتوانيا', en: 'Lithuania' },
  { code: 'LU', dial: '+352', ar: 'لوكسمبورغ', en: 'Luxembourg' },
  { code: 'MG', dial: '+261', ar: 'مدغشقر', en: 'Madagascar' },
  { code: 'MY', dial: '+60', ar: 'ماليزيا', en: 'Malaysia' },
  { code: 'ML', dial: '+223', ar: 'مالي', en: 'Mali' },
  { code: 'MT', dial: '+356', ar: 'مالطا', en: 'Malta' },
  { code: 'MX', dial: '+52', ar: 'المكسيك', en: 'Mexico' },
  { code: 'MD', dial: '+373', ar: 'مولدوفا', en: 'Moldova' },
  { code: 'MN', dial: '+976', ar: 'منغوليا', en: 'Mongolia' },
  { code: 'MZ', dial: '+258', ar: 'موزمبيق', en: 'Mozambique' },
  { code: 'MM', dial: '+95', ar: 'ميانمار', en: 'Myanmar' },
  { code: 'NP', dial: '+977', ar: 'نيبال', en: 'Nepal' },
  { code: 'NL', dial: '+31', ar: 'هولندا', en: 'Netherlands' },
  { code: 'NZ', dial: '+64', ar: 'نيوزيلندا', en: 'New Zealand' },
  { code: 'NE', dial: '+227', ar: 'النيجر', en: 'Niger' },
  { code: 'NG', dial: '+234', ar: 'نيجيريا', en: 'Nigeria' },
  { code: 'NO', dial: '+47', ar: 'النرويج', en: 'Norway' },
  { code: 'PK', dial: '+92', ar: 'باكستان', en: 'Pakistan' },
  { code: 'PA', dial: '+507', ar: 'بنما', en: 'Panama' },
  { code: 'PY', dial: '+595', ar: 'باراغواي', en: 'Paraguay' },
  { code: 'PE', dial: '+51', ar: 'بيرو', en: 'Peru' },
  { code: 'PH', dial: '+63', ar: 'الفلبين', en: 'Philippines' },
  { code: 'PL', dial: '+48', ar: 'بولندا', en: 'Poland' },
  { code: 'PT', dial: '+351', ar: 'البرتغال', en: 'Portugal' },
  { code: 'RO', dial: '+40', ar: 'رومانيا', en: 'Romania' },
  { code: 'RU', dial: '+7', ar: 'روسيا', en: 'Russia' },
  { code: 'RW', dial: '+250', ar: 'رواندا', en: 'Rwanda' },
  { code: 'SN', dial: '+221', ar: 'السنغال', en: 'Senegal' },
  { code: 'RS', dial: '+381', ar: 'صربيا', en: 'Serbia' },
  { code: 'SG', dial: '+65', ar: 'سنغافورة', en: 'Singapore' },
  { code: 'SK', dial: '+421', ar: 'سلوفاكيا', en: 'Slovakia' },
  { code: 'SI', dial: '+386', ar: 'سلوفينيا', en: 'Slovenia' },
  { code: 'ZA', dial: '+27', ar: 'جنوب أفريقيا', en: 'South Africa' },
  { code: 'SS', dial: '+211', ar: 'جنوب السودان', en: 'South Sudan' },
  { code: 'ES', dial: '+34', ar: 'إسبانيا', en: 'Spain' },
  { code: 'LK', dial: '+94', ar: 'سريلانكا', en: 'Sri Lanka' },
  { code: 'SE', dial: '+46', ar: 'السويد', en: 'Sweden' },
  { code: 'CH', dial: '+41', ar: 'سويسرا', en: 'Switzerland' },
  { code: 'TW', dial: '+886', ar: 'تايوان', en: 'Taiwan' },
  { code: 'TJ', dial: '+992', ar: 'طاجيكستان', en: 'Tajikistan' },
  { code: 'TZ', dial: '+255', ar: 'تنزانيا', en: 'Tanzania' },
  { code: 'TH', dial: '+66', ar: 'تايلاند', en: 'Thailand' },
  { code: 'TG', dial: '+228', ar: 'توغو', en: 'Togo' },
  { code: 'TR', dial: '+90', ar: 'تركيا', en: 'Turkey' },
  { code: 'TM', dial: '+993', ar: 'تركمانستان', en: 'Turkmenistan' },
  { code: 'UG', dial: '+256', ar: 'أوغندا', en: 'Uganda' },
  { code: 'UA', dial: '+380', ar: 'أوكرانيا', en: 'Ukraine' },
  { code: 'GB', dial: '+44', ar: 'المملكة المتحدة', en: 'United Kingdom' },
  { code: 'US', dial: '+1', ar: 'الولايات المتحدة', en: 'United States' },
  { code: 'UY', dial: '+598', ar: 'أوروغواي', en: 'Uruguay' },
  { code: 'UZ', dial: '+998', ar: 'أوزبكستان', en: 'Uzbekistan' },
  { code: 'VE', dial: '+58', ar: 'فنزويلا', en: 'Venezuela' },
  { code: 'VN', dial: '+84', ar: 'فيتنام', en: 'Vietnam' },
  { code: 'ZM', dial: '+260', ar: 'زامبيا', en: 'Zambia' },
  { code: 'ZW', dial: '+263', ar: 'زيمبابوي', en: 'Zimbabwe' },
];

// كل الدول (عربية أولاً ثم العالم)
export const ALL_DIAL: DialCountry[] = [...ARAB_DIAL, ...WORLD_DIAL];

// رمز الاتصال لدولة (من رمزها ISO) — فارغ إن لم تُعرف
export function dialOf(countryCode?: string | null): string {
  const m = ALL_DIAL.find((d) => d.code === (countryCode || '').toUpperCase());
  return m ? m.dial : '';
}
