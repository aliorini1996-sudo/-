// ============================================================================
// مولّد مقالات SEO البرمجي (Programmatic SEO) — مصدر واحد للتطبيق ولخريطة الموقع.
// ----------------------------------------------------------------------------
// يولّد مئات المقالات الفريدة (عربي/إنجليزي/فرنسي) المستهدِفة لكل الدول العربية،
// من قوالب موضوعات × سجلّ دول × ثلاث لغات. المحتوى يُبنى وقت العرض (لا يُخزَّن كاملاً)
// حتى لا يتضخّم حجم الحزمة. كل مقال مُميَّز ببيانات دولته (العملة، جهة الضريبة،
// النسبة، المدن، العاصمة) لتفادي التكرار (doorway pages) وإعطاء قيمة حقيقية.
//
// ⚠️ ملاحظة: النِّسب الضريبية وحالات الفوترة الإلكترونية إرشادية وتتغيّر —
// المحتوى يذكّر القارئ بمراجعة مستشار محلي. لا يُروَّج لأي ميزة غير موجودة فعلاً.
// ============================================================================

export const LANGS = /** @type {const} */ (['ar', 'en', 'fr']);
export const ORIGIN = 'https://fieldsa.net';

// أداة اختيار النص حسب اللغة
const P = (L, ar, en, fr) => (L === 'ar' ? ar : L === 'en' ? en : fr);

// ----------------------------------------------------------------------------
// سجلّ الدول العربية (الجامعة العربية) — بيانات ثلاثية اللغة لتفريد المحتوى.
// vat: نسبة ضريبة القيمة المضافة (null = لا تُطبَّق بعد). tax: جهة الضريبة.
// ----------------------------------------------------------------------------
export const COUNTRIES = [
  { code: 'SA', ar: 'السعودية', en: 'Saudi Arabia', fr: 'Arabie saoudite', inAr: 'في السعودية', inEn: 'in Saudi Arabia', inFr: 'en Arabie saoudite', cap: { ar: 'الرياض', en: 'Riyadh', fr: 'Riyad' }, cities: [{ ar: 'جدة', en: 'Jeddah', fr: 'Djeddah' }, { ar: 'الدمام', en: 'Dammam', fr: 'Dammam' }], cur: { ar: 'الريال السعودي', en: 'Saudi Riyal (SAR)', fr: 'le riyal saoudien' }, vat: 15, tax: { ar: 'هيئة الزكاة والضريبة والجمارك (ZATCA)', en: 'ZATCA', fr: 'la ZATCA' }, einv: { ar: 'الفوترة الإلكترونية «فاتورة» مُطبَّقة على مرحلتين', en: 'ZATCA e-invoicing (Fatoora) is mandatory in two phases', fr: 'la facturation électronique ZATCA (Fatoora) est obligatoire' } },
  { code: 'EG', ar: 'مصر', en: 'Egypt', fr: 'Égypte', inAr: 'في مصر', inEn: 'in Egypt', inFr: 'en Égypte', cap: { ar: 'القاهرة', en: 'Cairo', fr: 'Le Caire' }, cities: [{ ar: 'الإسكندرية', en: 'Alexandria', fr: 'Alexandrie' }, { ar: 'الجيزة', en: 'Giza', fr: 'Gizeh' }], cur: { ar: 'الجنيه المصري', en: 'Egyptian Pound (EGP)', fr: 'la livre égyptienne' }, vat: 14, tax: { ar: 'مصلحة الضرائب المصرية (ETA)', en: 'the Egyptian Tax Authority (ETA)', fr: "l'Autorité fiscale égyptienne (ETA)" }, einv: { ar: 'الفاتورة والإيصال الإلكتروني إلزاميان تدريجياً', en: 'e-invoice and e-receipt are being enforced', fr: 'la facture et le reçu électroniques sont progressivement obligatoires' } },
  { code: 'AE', ar: 'الإمارات', en: 'United Arab Emirates', fr: 'Émirats arabes unis', inAr: 'في الإمارات', inEn: 'in the UAE', inFr: 'aux Émirats arabes unis', cap: { ar: 'أبوظبي', en: 'Abu Dhabi', fr: 'Abou Dabi' }, cities: [{ ar: 'دبي', en: 'Dubai', fr: 'Dubaï' }, { ar: 'الشارقة', en: 'Sharjah', fr: 'Charjah' }], cur: { ar: 'الدرهم الإماراتي', en: 'UAE Dirham (AED)', fr: 'le dirham des Émirats' }, vat: 5, tax: { ar: 'الهيئة الاتحادية للضرائب (FTA)', en: 'the Federal Tax Authority (FTA)', fr: "l'Autorité fédérale des impôts (FTA)" }, einv: { ar: 'الفوترة الإلكترونية (Peppol) في مرحلة تطبيق مرحلي', en: 'Peppol-based e-invoicing is being phased in', fr: 'la facturation électronique (Peppol) est en cours de déploiement' } },
  { code: 'KW', ar: 'الكويت', en: 'Kuwait', fr: 'Koweït', inAr: 'في الكويت', inEn: 'in Kuwait', inFr: 'au Koweït', cap: { ar: 'مدينة الكويت', en: 'Kuwait City', fr: 'Koweït' }, cities: [{ ar: 'حولي', en: 'Hawalli', fr: 'Hawalli' }, { ar: 'الأحمدي', en: 'Ahmadi', fr: 'Ahmadi' }], cur: { ar: 'الدينار الكويتي', en: 'Kuwaiti Dinar (KWD)', fr: 'le dinar koweïtien' }, vat: null, tax: { ar: 'الإدارة الضريبية', en: 'the tax administration', fr: "l'administration fiscale" }, einv: { ar: 'لا تُطبَّق ضريبة قيمة مضافة بعد', en: 'VAT has not been introduced yet', fr: "la TVA n'est pas encore appliquée" } },
  { code: 'QA', ar: 'قطر', en: 'Qatar', fr: 'Qatar', inAr: 'في قطر', inEn: 'in Qatar', inFr: 'au Qatar', cap: { ar: 'الدوحة', en: 'Doha', fr: 'Doha' }, cities: [{ ar: 'الريان', en: 'Al Rayyan', fr: 'Al Rayyan' }, { ar: 'الوكرة', en: 'Al Wakrah', fr: 'Al Wakrah' }], cur: { ar: 'الريال القطري', en: 'Qatari Riyal (QAR)', fr: 'le riyal qatarien' }, vat: null, tax: { ar: 'الهيئة العامة للضرائب', en: 'the General Tax Authority', fr: "l'Autorité générale des impôts" }, einv: { ar: 'الضريبة والفوترة الإلكترونية في مرحلة التخطيط', en: 'VAT and e-invoicing are being planned', fr: 'la TVA et la facturation électronique sont en préparation' } },
  { code: 'BH', ar: 'البحرين', en: 'Bahrain', fr: 'Bahreïn', inAr: 'في البحرين', inEn: 'in Bahrain', inFr: 'au Bahreïn', cap: { ar: 'المنامة', en: 'Manama', fr: 'Manama' }, cities: [{ ar: 'المحرّق', en: 'Muharraq', fr: 'Muharraq' }, { ar: 'الرفاع', en: 'Riffa', fr: 'Riffa' }], cur: { ar: 'الدينار البحريني', en: 'Bahraini Dinar (BHD)', fr: 'le dinar bahreïni' }, vat: 10, tax: { ar: 'الجهاز الوطني للإيرادات (NBR)', en: 'the National Bureau for Revenue (NBR)', fr: "le Bureau national des revenus (NBR)" }, einv: { ar: 'ضريبة القيمة المضافة 10٪ مُطبَّقة', en: 'VAT at 10% applies', fr: 'la TVA de 10 % est appliquée' } },
  { code: 'OM', ar: 'عُمان', en: 'Oman', fr: 'Oman', inAr: 'في عُمان', inEn: 'in Oman', inFr: 'à Oman', cap: { ar: 'مسقط', en: 'Muscat', fr: 'Mascate' }, cities: [{ ar: 'صلالة', en: 'Salalah', fr: 'Salalah' }, { ar: 'صحار', en: 'Sohar', fr: 'Sohar' }], cur: { ar: 'الريال العُماني', en: 'Omani Rial (OMR)', fr: 'le rial omanais' }, vat: 5, tax: { ar: 'جهاز الضرائب', en: 'the Oman Tax Authority', fr: "l'Autorité fiscale omanaise" }, einv: { ar: 'ضريبة القيمة المضافة 5٪ مُطبَّقة والفوترة الإلكترونية قادمة', en: 'VAT at 5% applies and e-invoicing is coming', fr: 'la TVA de 5 % est appliquée' } },
  { code: 'MA', ar: 'المغرب', en: 'Morocco', fr: 'Maroc', inAr: 'في المغرب', inEn: 'in Morocco', inFr: 'au Maroc', cap: { ar: 'الرباط', en: 'Rabat', fr: 'Rabat' }, cities: [{ ar: 'الدار البيضاء', en: 'Casablanca', fr: 'Casablanca' }, { ar: 'مراكش', en: 'Marrakesh', fr: 'Marrakech' }], cur: { ar: 'الدرهم المغربي', en: 'Moroccan Dirham (MAD)', fr: 'le dirham marocain' }, vat: 20, tax: { ar: 'المديرية العامة للضرائب (DGI)', en: 'the General Directorate of Taxes (DGI)', fr: 'la Direction générale des impôts (DGI)' }, einv: { ar: 'الضريبة على القيمة المضافة (TVA) 20٪ والتوجّه نحو الفوترة الإلكترونية', en: 'VAT (TVA) at 20% applies, moving toward e-invoicing', fr: 'la TVA à 20 % s\'applique, avec une transition vers la facturation électronique' } },
  { code: 'DZ', ar: 'الجزائر', en: 'Algeria', fr: 'Algérie', inAr: 'في الجزائر', inEn: 'in Algeria', inFr: 'en Algérie', cap: { ar: 'الجزائر العاصمة', en: 'Algiers', fr: 'Alger' }, cities: [{ ar: 'وهران', en: 'Oran', fr: 'Oran' }, { ar: 'قسنطينة', en: 'Constantine', fr: 'Constantine' }], cur: { ar: 'الدينار الجزائري', en: 'Algerian Dinar (DZD)', fr: 'le dinar algérien' }, vat: 19, tax: { ar: 'المديرية العامة للضرائب (DGI)', en: 'the General Directorate of Taxes (DGI)', fr: 'la Direction générale des impôts (DGI)' }, einv: { ar: 'الضريبة على القيمة المضافة (TVA) 19٪', en: 'VAT (TVA) at 19% applies', fr: 'la TVA à 19 % s\'applique' } },
  { code: 'TN', ar: 'تونس', en: 'Tunisia', fr: 'Tunisie', inAr: 'في تونس', inEn: 'in Tunisia', inFr: 'en Tunisie', cap: { ar: 'تونس العاصمة', en: 'Tunis', fr: 'Tunis' }, cities: [{ ar: 'صفاقس', en: 'Sfax', fr: 'Sfax' }, { ar: 'سوسة', en: 'Sousse', fr: 'Sousse' }], cur: { ar: 'الدينار التونسي', en: 'Tunisian Dinar (TND)', fr: 'le dinar tunisien' }, vat: 19, tax: { ar: 'الإدارة العامة للأداءات', en: 'the tax authority', fr: "l'administration fiscale" }, einv: { ar: 'الفوترة الإلكترونية «el-Fatoura» عبر TTN إلزامية جزئياً', en: 'el-Fatoura e-invoicing via TTN is partly mandatory', fr: 'la facturation électronique el-Fatoura (TTN) est partiellement obligatoire' } },
  { code: 'JO', ar: 'الأردن', en: 'Jordan', fr: 'Jordanie', inAr: 'في الأردن', inEn: 'in Jordan', inFr: 'en Jordanie', cap: { ar: 'عمّان', en: 'Amman', fr: 'Amman' }, cities: [{ ar: 'الزرقاء', en: 'Zarqa', fr: 'Zarka' }, { ar: 'إربد', en: 'Irbid', fr: 'Irbid' }], cur: { ar: 'الدينار الأردني', en: 'Jordanian Dinar (JOD)', fr: 'le dinar jordanien' }, vat: 16, tax: { ar: 'دائرة ضريبة الدخل والمبيعات (ISTD)', en: 'the Income and Sales Tax Department (ISTD)', fr: "le Département de l'impôt (ISTD)" }, einv: { ar: 'ضريبة المبيعات العامة 16٪ والفوترة الوطنية «JoFotara»', en: 'general sales tax at 16% and the JoFotara e-invoicing system', fr: 'la taxe sur les ventes à 16 % et le système JoFotara' } },
  { code: 'IQ', ar: 'العراق', en: 'Iraq', fr: 'Irak', inAr: 'في العراق', inEn: 'in Iraq', inFr: 'en Irak', cap: { ar: 'بغداد', en: 'Baghdad', fr: 'Bagdad' }, cities: [{ ar: 'البصرة', en: 'Basra', fr: 'Bassorah' }, { ar: 'أربيل', en: 'Erbil', fr: 'Erbil' }], cur: { ar: 'الدينار العراقي', en: 'Iraqi Dinar (IQD)', fr: 'le dinar irakien' }, vat: null, tax: { ar: 'الهيئة العامة للضرائب', en: 'the General Commission for Taxes', fr: "la Commission générale des impôts" }, einv: { ar: 'ضريبة مبيعات على أصناف محددة دون قيمة مضافة عامة', en: 'sales tax on selected goods without a general VAT', fr: 'une taxe sur les ventes sur certains biens, sans TVA générale' } },
  { code: 'LY', ar: 'ليبيا', en: 'Libya', fr: 'Libye', inAr: 'في ليبيا', inEn: 'in Libya', inFr: 'en Libye', cap: { ar: 'طرابلس', en: 'Tripoli', fr: 'Tripoli' }, cities: [{ ar: 'بنغازي', en: 'Benghazi', fr: 'Benghazi' }, { ar: 'مصراتة', en: 'Misrata', fr: 'Misrata' }], cur: { ar: 'الدينار الليبي', en: 'Libyan Dinar (LYD)', fr: 'le dinar libyen' }, vat: null, tax: { ar: 'مصلحة الضرائب', en: 'the tax authority', fr: "l'administration fiscale" }, einv: { ar: 'ضريبة الدمغة ورسوم دون قيمة مضافة عامة', en: 'stamp duty and fees without a general VAT', fr: 'un droit de timbre et des frais, sans TVA générale' } },
  { code: 'SD', ar: 'السودان', en: 'Sudan', fr: 'Soudan', inAr: 'في السودان', inEn: 'in Sudan', inFr: 'au Soudan', cap: { ar: 'الخرطوم', en: 'Khartoum', fr: 'Khartoum' }, cities: [{ ar: 'أم درمان', en: 'Omdurman', fr: 'Omdourman' }, { ar: 'بورتسودان', en: 'Port Sudan', fr: 'Port-Soudan' }], cur: { ar: 'الجنيه السوداني', en: 'Sudanese Pound (SDG)', fr: 'la livre soudanaise' }, vat: 17, tax: { ar: 'ديوان الضرائب', en: 'the tax chamber', fr: "la chambre des impôts" }, einv: { ar: 'ضريبة القيمة المضافة نحو 17٪', en: 'value added tax around 17%', fr: 'une TVA d\'environ 17 %' } },
  { code: 'YE', ar: 'اليمن', en: 'Yemen', fr: 'Yémen', inAr: 'في اليمن', inEn: 'in Yemen', inFr: 'au Yémen', cap: { ar: 'صنعاء', en: "Sana'a", fr: 'Sanaa' }, cities: [{ ar: 'عدن', en: 'Aden', fr: 'Aden' }, { ar: 'تعز', en: 'Taiz', fr: 'Taïz' }], cur: { ar: 'الريال اليمني', en: 'Yemeni Rial (YER)', fr: 'le rial yéménite' }, vat: null, tax: { ar: 'مصلحة الضرائب', en: 'the tax authority', fr: "l'administration fiscale" }, einv: { ar: 'ضريبة مبيعات عامة دون فوترة إلكترونية إلزامية', en: 'a general sales tax without mandatory e-invoicing', fr: 'une taxe sur les ventes, sans facturation électronique obligatoire' } },
  { code: 'LB', ar: 'لبنان', en: 'Lebanon', fr: 'Liban', inAr: 'في لبنان', inEn: 'in Lebanon', inFr: 'au Liban', cap: { ar: 'بيروت', en: 'Beirut', fr: 'Beyrouth' }, cities: [{ ar: 'طرابلس', en: 'Tripoli', fr: 'Tripoli' }, { ar: 'صيدا', en: 'Sidon', fr: 'Saïda' }], cur: { ar: 'الليرة اللبنانية', en: 'Lebanese Pound (LBP)', fr: 'la livre libanaise' }, vat: 11, tax: { ar: 'مديرية المالية العامة', en: 'the finance directorate', fr: 'la direction des finances' }, einv: { ar: 'ضريبة القيمة المضافة 11٪', en: 'value added tax at 11%', fr: 'une TVA de 11 %' } },
  { code: 'SY', ar: 'سوريا', en: 'Syria', fr: 'Syrie', inAr: 'في سوريا', inEn: 'in Syria', inFr: 'en Syrie', cap: { ar: 'دمشق', en: 'Damascus', fr: 'Damas' }, cities: [{ ar: 'حلب', en: 'Aleppo', fr: 'Alep' }, { ar: 'حمص', en: 'Homs', fr: 'Homs' }], cur: { ar: 'الليرة السورية', en: 'Syrian Pound (SYP)', fr: 'la livre syrienne' }, vat: null, tax: { ar: 'وزارة المالية', en: 'the ministry of finance', fr: 'le ministère des finances' }, einv: { ar: 'ضريبة إنفاق استهلاكي دون قيمة مضافة عامة', en: 'a consumption tax without a general VAT', fr: 'une taxe à la consommation, sans TVA générale' } },
  { code: 'PS', ar: 'فلسطين', en: 'Palestine', fr: 'Palestine', inAr: 'في فلسطين', inEn: 'in Palestine', inFr: 'en Palestine', cap: { ar: 'القدس', en: 'Jerusalem', fr: 'Jérusalem' }, cities: [{ ar: 'رام الله', en: 'Ramallah', fr: 'Ramallah' }, { ar: 'غزة', en: 'Gaza', fr: 'Gaza' }], cur: { ar: 'الشيكل', en: 'Shekel (ILS)', fr: 'le shekel' }, vat: 16, tax: { ar: 'دائرة ضريبة القيمة المضافة', en: 'the VAT department', fr: 'le département de la TVA' }, einv: { ar: 'ضريبة القيمة المضافة نحو 16٪', en: 'value added tax around 16%', fr: 'une TVA d\'environ 16 %' } },
  { code: 'MR', ar: 'موريتانيا', en: 'Mauritania', fr: 'Mauritanie', inAr: 'في موريتانيا', inEn: 'in Mauritania', inFr: 'en Mauritanie', cap: { ar: 'نواكشوط', en: 'Nouakchott', fr: 'Nouakchott' }, cities: [{ ar: 'نواذيبو', en: 'Nouadhibou', fr: 'Nouadhibou' }, { ar: 'كيفة', en: 'Kiffa', fr: 'Kiffa' }], cur: { ar: 'الأوقية', en: 'Ouguiya (MRU)', fr: "l'ouguiya" }, vat: 16, tax: { ar: 'المديرية العامة للضرائب', en: 'the tax directorate', fr: 'la direction générale des impôts' }, einv: { ar: 'ضريبة القيمة المضافة نحو 16٪', en: 'value added tax around 16%', fr: 'une TVA d\'environ 16 %' } },
  { code: 'SO', ar: 'الصومال', en: 'Somalia', fr: 'Somalie', inAr: 'في الصومال', inEn: 'in Somalia', inFr: 'en Somalie', cap: { ar: 'مقديشو', en: 'Mogadishu', fr: 'Mogadiscio' }, cities: [{ ar: 'هرجيسا', en: 'Hargeisa', fr: 'Hargeisa' }, { ar: 'بوصاصو', en: 'Bosaso', fr: 'Bosaso' }], cur: { ar: 'الشلن الصومالي', en: 'Somali Shilling (SOS)', fr: 'le shilling somalien' }, vat: null, tax: { ar: 'الإدارة الضريبية', en: 'the tax administration', fr: "l'administration fiscale" }, einv: { ar: 'ضرائب مبيعات محلية دون قيمة مضافة موحّدة', en: 'local sales taxes without a unified VAT', fr: 'des taxes locales, sans TVA unifiée' } },
  { code: 'DJ', ar: 'جيبوتي', en: 'Djibouti', fr: 'Djibouti', inAr: 'في جيبوتي', inEn: 'in Djibouti', inFr: 'à Djibouti', cap: { ar: 'جيبوتي', en: 'Djibouti', fr: 'Djibouti' }, cities: [{ ar: 'علي صبيح', en: 'Ali Sabieh', fr: 'Ali-Sabieh' }, { ar: 'تاجورة', en: 'Tadjoura', fr: 'Tadjoura' }], cur: { ar: 'الفرنك الجيبوتي', en: 'Djiboutian Franc (DJF)', fr: 'le franc djiboutien' }, vat: 10, tax: { ar: 'المديرية العامة للضرائب', en: 'the tax directorate', fr: 'la direction générale des impôts' }, einv: { ar: 'ضريبة القيمة المضافة نحو 10٪', en: 'value added tax around 10%', fr: 'une TVA d\'environ 10 %' } },
  { code: 'KM', ar: 'جزر القمر', en: 'Comoros', fr: 'Comores', inAr: 'في جزر القمر', inEn: 'in the Comoros', inFr: 'aux Comores', cap: { ar: 'موروني', en: 'Moroni', fr: 'Moroni' }, cities: [{ ar: 'موتسامودو', en: 'Mutsamudu', fr: 'Mutsamudu' }, { ar: 'فومبوني', en: 'Fomboni', fr: 'Fomboni' }], cur: { ar: 'الفرنك القمري', en: 'Comorian Franc (KMF)', fr: 'le franc comorien' }, vat: null, tax: { ar: 'الإدارة الضريبية', en: 'the tax administration', fr: "l'administration fiscale" }, einv: { ar: 'رسوم وضرائب استهلاك دون قيمة مضافة موحّدة', en: 'consumption duties without a unified VAT', fr: 'des droits de consommation, sans TVA unifiée' } },
];

// دولة وهمية للمقالات العامة (غير المرتبطة بدولة) — تبسّط بُناة الأقسام
const REGION = { code: 'REGION', ar: 'الأسواق العربية', en: 'Arab markets', fr: 'les marchés arabes', inAr: 'في الأسواق العربية', inEn: 'in Arab markets', inFr: 'sur les marchés arabes', cap: { ar: 'المنطقة', en: 'the region', fr: 'la région' }, cities: [{ ar: 'الرياض', en: 'Riyadh', fr: 'Riyad' }, { ar: 'القاهرة', en: 'Cairo', fr: 'Le Caire' }], cur: { ar: 'العملة المحلية', en: 'the local currency', fr: 'la monnaie locale' }, vat: null, tax: { ar: 'الجهة الضريبية المحلية', en: 'the local tax authority', fr: "l'autorité fiscale locale" }, einv: { ar: 'تتّجه دول عربية عدة نحو الفوترة الإلكترونية الإلزامية', en: 'several Arab countries are moving to mandatory e-invoicing', fr: 'plusieurs pays arabes adoptent la facturation électronique obligatoire' } };

// ----------------------------------------------------------------------------
// روابط داخلية ودعوات لاتخاذ إجراء (تحسّن الربط الداخلي وتقلّل «صفحات العبور»)
// ----------------------------------------------------------------------------
const blogBase = (L) => (L === 'ar' ? '/blog' : `/${L}/blog`);
const cta = (L) => P(L,
  `<p><a href="/signup"><strong>ابدأ تجربتك المجانية 10 أيام مع منصّة FieldSales</strong></a> — فواتير ضريبية، تحصيل، مخزون سيارة، وتقارير لحظية من تطبيق واحد للمندوب.</p>`,
  `<p><a href="/signup"><strong>Start your free 10-day trial with FieldSales</strong></a> — tax invoices, collection, van stock and live reports from one rep app.</p>`,
  `<p><a href="/signup"><strong>Commencez votre essai gratuit de 10 jours avec FieldSales</strong></a> — factures, encaissement, stock du véhicule et rapports en temps réel depuis une seule application.</p>`);

// جملة الضريبة/الفوترة حسب الدولة (تتكيّف مع وجود/غياب ضريبة القيمة المضافة)
const taxLine = (c, L) => {
  if (c.vat != null) {
    return P(L,
      `تبلغ ضريبة القيمة المضافة ${c.inAr} نحو ${c.vat}٪ وتتولّاها ${c.tax.ar}، و${c.einv.ar}. لذا يجب أن يُصدر مندوبك فاتورة ضريبية منظّمة من الميدان مباشرةً.`,
      `Value added tax ${c.inEn} is around ${c.vat}% and is administered by ${c.tax.en}, and ${c.einv.en}. Your rep must therefore issue a structured tax invoice directly from the field.`,
      `La TVA ${c.inFr} est d'environ ${c.vat} % et gérée par ${c.tax.fr} ; ${c.einv.fr}. Votre commercial doit donc émettre une facture structurée directement sur le terrain.`);
  }
  return P(L,
    `${c.einv.ar} ${c.inAr}. ومع ذلك يبقى إصدار فواتير منظّمة وكشوف حساب دقيقة ضرورة إدارية ورقابية لكل شركة توزيع.`,
    `${c.einv.en} ${c.inEn}. Even so, issuing structured invoices and accurate customer statements remains an operational necessity for every distributor.`,
    `${c.einv.fr} ${c.inFr}. Malgré cela, émettre des factures structurées et des relevés précis reste indispensable pour tout distributeur.`);
};

const citiesLine = (c, L) => {
  const list = P(L, [c.cap.ar, ...c.cities.map((x) => x.ar)], [c.cap.en, ...c.cities.map((x) => x.en)], [c.cap.fr, ...c.cities.map((x) => x.fr)]);
  const joined = L === 'ar' ? list.join(' و') : list.join(', ');
  return P(L,
    `سواء كان فريقك يعمل في ${joined} أو في المدن الأصغر، فإن تغطية خطوط السير وضبط الزيارات يرفعان مبيعاتك.`,
    `Whether your team covers ${joined} or smaller towns, tightening routes and visit coverage lifts your sales.`,
    `Que votre équipe couvre ${joined} ou de plus petites villes, optimiser les tournées augmente vos ventes.`);
};

// أسئلة شائعة كبيانات (تُغذّي القسم المرئي + FAQPage schema) — مُوطَّنة ومُخصَّصة للدولة
const faqData = (c, L) => {
  const taxA = c.vat != null
    ? P(L, `نعم، يُصدر فاتورة ضريبية منظّمة تناسب متطلبات ${c.tax.ar} (ضريبة ${c.vat}٪) مع رمز QR وطباعة حرارية.`,
        `Yes, it issues a structured tax invoice aligned with ${c.tax.en} (VAT ${c.vat}%), with a QR code and thermal printing.`,
        `Oui, il émet une facture structurée conforme à ${c.tax.fr} (TVA ${c.vat} %), avec code QR et impression thermique.`)
    : P(L, `نعم، يُصدر فواتير وكشوف حساب منظّمة برمز QR وطباعة حرارية، ويتكيّف مع المتطلبات المحلية ${c.inAr}.`,
        `Yes, it issues structured invoices and statements with a QR code and thermal printing, adapting to local rules ${c.inEn}.`,
        `Oui, il émet des factures structurées avec code QR et impression thermique, adaptées aux règles locales ${c.inFr}.`);
  return [
    { q: P(L, `هل يعمل النظام ${c.inAr}؟`, `Does it work ${c.inEn}?`, `Fonctionne-t-il ${c.inFr} ?`),
      a: P(L, `نعم، منصّة FieldSales تدعم شركات التوزيع ${c.inAr} بعملة ${c.cur.ar} ومتطلباتها المحلية.`,
          `Yes, FieldSales supports distributors ${c.inEn} with ${c.cur.en} and local requirements.`,
          `Oui, FieldSales prend en charge les distributeurs ${c.inFr} avec ${c.cur.fr} et les exigences locales.`) },
    { q: P(L, `هل يحتاج المندوب إلى جهاز خاص؟`, `Does the rep need special hardware?`, `Faut-il un matériel spécial ?`),
      a: P(L, `لا، يكفي هاتف ذكي وطابعة حرارية اختيارية للفواتير في الميدان.`,
          `No — a smartphone and an optional thermal printer are enough for field invoicing.`,
          `Non : un smartphone et une imprimante thermique optionnelle suffisent.`) },
    { q: P(L, `هل يُصدر فواتير متوافقة ضريبياً؟`, `Does it issue tax-compliant invoices?`, `Émet-il des factures conformes ?`), a: taxA },
    { q: P(L, `هل توجد تجربة مجانية؟`, `Is there a free trial?`, `Y a-t-il un essai gratuit ?`),
      a: P(L, `نعم، تجربة مجانية 10 أيام تبدأ خلال دقائق دون بطاقة.`,
          `Yes — a free 10-day trial that starts in minutes, no card required.`,
          `Oui — un essai gratuit de 10 jours qui démarre en quelques minutes, sans carte.`) },
  ];
};

// ----------------------------------------------------------------------------
// بُناة الأقسام — كلٌّ يُرجع HTML (عنوان + فقرات) مُوطَّناً ومُخصَّصاً للدولة.
// ----------------------------------------------------------------------------
const S = {
  why: (c, L) => P(L,
    `<h2>لماذا تحتاج شركات التوزيع ${c.inAr} إلى نظام مبيعات ميدانية؟</h2>
     <p>تدير شركات التوزيع ${c.inAr} عشرات المناديب وآلاف العملاء بين الطلبات والفواتير والتحصيل. وبلا نظام موحّد تضيع البيانات وتتراكم الأخطاء وتتعثّر الذمم. ${citiesLine(c, L)}</p>
     <p>نظام إدارة المبيعات الميدانية يربط المندوب بالإدارة لحظياً: طلب، فاتورة، سند قبض، ومخزون سيارة — كلّها في تطبيق واحد يعمل من الميدان.</p>`,
    `<h2>Why do distributors ${c.inEn} need a field sales system?</h2>
     <p>Distributors ${c.inEn} manage dozens of reps and thousands of customers across orders, invoices and collection. Without one system, data is lost, errors pile up and receivables slip. ${citiesLine(c, L)}</p>
     <p>A field sales system connects the rep to the office in real time: order, invoice, receipt and van stock — all in one app that works from the field.</p>`,
    `<h2>Pourquoi les distributeurs ${c.inFr} ont-ils besoin d'un système de vente terrain ?</h2>
     <p>Les distributeurs ${c.inFr} gèrent des dizaines de commerciaux et des milliers de clients : commandes, factures, encaissement. Sans système unifié, les données se perdent et les impayés augmentent. ${citiesLine(c, L)}</p>
     <p>Un système de vente terrain relie le commercial au bureau en temps réel : commande, facture, reçu et stock du véhicule — le tout dans une seule application.</p>`),

  tax: (c, L) => P(L,
    `<h2>الالتزام الضريبي والفوترة ${c.inAr}</h2>
     <p>${taxLine(c, L)}</p>
     <p>منصّة تُصدر فاتورة منظّمة برمز QR وطباعة حرارية تحمي شركتك من المخالفات وتُبسّط محاسبتك. راجع دائماً مستشاراً ضريبياً محلياً لأحدث المتطلبات.</p>`,
    `<h2>Tax compliance and invoicing ${c.inEn}</h2>
     <p>${taxLine(c, L)}</p>
     <p>A platform that issues a structured invoice with a QR code and thermal printing protects you from penalties and simplifies accounting. Always confirm the latest requirements with a local tax advisor.</p>`,
    `<h2>Conformité fiscale et facturation ${c.inFr}</h2>
     <p>${taxLine(c, L)}</p>
     <p>Une plateforme qui émet une facture structurée avec code QR et impression thermique vous protège des pénalités. Vérifiez toujours les exigences auprès d'un conseiller fiscal local.</p>`),

  invoice: (c, L) => P(L,
    `<h2>الفوترة من الجوال في الميدان</h2>
     <p>يُصدر المندوب الفاتورة وسند القبض من جواله في موقع العميل، ويطبعها حرارياً (58مم)، وتتزامن فوراً مع الإدارة. لا أوراق متفرّقة ولا إدخال مزدوج.</p>
     <ul><li>فاتورة ضريبية منظّمة برمز QR.</li><li>طباعة حرارية فورية للعميل.</li><li>مزامنة لحظية مع كشف حساب العميل.</li></ul>`,
    `<h2>Mobile invoicing in the field</h2>
     <p>The rep issues the invoice and receipt from their phone at the customer's location, prints it thermally (58mm), and it syncs instantly with the office. No scattered paper, no double entry.</p>
     <ul><li>Structured tax invoice with a QR code.</li><li>Instant thermal printing for the customer.</li><li>Real-time sync with the customer statement.</li></ul>`,
    `<h2>Facturation mobile sur le terrain</h2>
     <p>Le commercial émet la facture et le reçu depuis son téléphone chez le client, les imprime en thermique (58 mm), et tout se synchronise instantanément. Aucun papier dispersé, aucune double saisie.</p>
     <ul><li>Facture structurée avec code QR.</li><li>Impression thermique immédiate.</li><li>Synchronisation en temps réel avec le relevé client.</li></ul>`),

  collect: (c, L) => P(L,
    `<h2>التحصيل وإدارة الذمم وكشوف الحساب</h2>
     <p>سجّل كل دفعة (نقد/تحويل/شيك) واربطها بكشف حساب العميل بـ${c.cur.ar} تلقائياً. اضبط حدّ ائتمان لكل عميل واحصل على تنبيه فوري عند تجاوزه — قبل أن يتحوّل الدين إلى متعثّر.</p>
     <p>رفع نسبة التحصيل وتقليل الديون المعلّقة من أسرع مصادر تحسين السيولة لأي شركة توزيع.</p>`,
    `<h2>Collection, receivables and statements</h2>
     <p>Record every payment (cash/transfer/cheque) and link it to the customer statement in ${c.cur.en} automatically. Set a credit limit per customer and get an instant alert when it is exceeded — before debt turns bad.</p>
     <p>Raising collection rates and cutting overdue debt is one of the fastest ways to improve a distributor's cash flow.</p>`,
    `<h2>Encaissement, créances et relevés</h2>
     <p>Enregistrez chaque paiement (espèces/virement/chèque) et liez-le automatiquement au relevé du client en ${c.cur.fr}. Fixez une limite de crédit par client et recevez une alerte dès qu'elle est dépassée.</p>
     <p>Améliorer le taux d'encaissement et réduire les impayés est l'un des leviers les plus rapides pour la trésorerie.</p>`),

  vanstock: (c, L) => P(L,
    `<h2>إدارة مخزون سيارة المندوب</h2>
     <p>سجّل ما حمَّله كل مندوب في سيارته، وتابع المتبقّي بعد كل عملية بيع، واكشف الفروقات فوراً. هذا يمنع النقص والعجز ويربط المخزون بالمبيعات لحظياً.</p>`,
    `<h2>Van stock management</h2>
     <p>Record what each rep loaded into their van, track the remaining quantity after every sale, and expose discrepancies instantly. This prevents shortages and links stock to sales in real time.</p>`,
    `<h2>Gestion du stock du véhicule</h2>
     <p>Enregistrez ce que chaque commercial a chargé, suivez le reste après chaque vente et détectez les écarts immédiatement. Cela évite les manques et relie le stock aux ventes en temps réel.</p>`),

  gps: (c, L) => P(L,
    `<h2>تتبّع المناديب وتخطيط خطوط السير</h2>
     <p>تابع مواقع المناديب وخطوط سيرهم لتنظيم التغطية وتقليل الوقت الضائع بين ${c.cap.ar} والمناطق المحيطة. التتبّع يرفع عدد الزيارات المنتِجة يومياً.</p>`,
    `<h2>Rep tracking and route planning</h2>
     <p>Follow reps' locations and routes to organize coverage and cut wasted time between ${c.cap.en} and surrounding areas. Tracking raises the number of productive visits per day.</p>`,
    `<h2>Suivi des commerciaux et planification des tournées</h2>
     <p>Suivez les positions et les tournées pour organiser la couverture et réduire le temps perdu autour de ${c.cap.fr}. Le suivi augmente le nombre de visites productives par jour.</p>`),

  reports: (c, L) => P(L,
    `<h2>التقارير والتحليلات اللحظية</h2>
     <p>مبيعات اليوم، التحصيل، عدد الزيارات، وأداء كل مندوب على لوحة واحدة. قرارات مبنية على أرقام لا انطباعات — مع مقارنة المناطق والمنتجات والفترات.</p>`,
    `<h2>Live reports and analytics</h2>
     <p>Today's sales, collection, visit counts and each rep's performance on one dashboard. Decisions based on numbers, not impressions — with comparisons across regions, products and periods.</p>`,
    `<h2>Rapports et analyses en temps réel</h2>
     <p>Ventes du jour, encaissement, nombre de visites et performance de chaque commercial sur un seul tableau de bord. Des décisions fondées sur des chiffres, avec comparaison par région, produit et période.</p>`),

  reps: (c, L) => P(L,
    `<h2>إدارة المناديب والصلاحيات</h2>
     <p>حدّد صلاحيات كل مندوب: من يمنح خصماً وكم نسبته؟ من يبيع بالآجل؟ ضبط الأدوار (مدير/مشرف/محاسب) يمنع التلاعب ويحمي هوامشك ${c.inAr}.</p>`,
    `<h2>Rep management and permissions</h2>
     <p>Define each rep's permissions: who can grant a discount and how much? Who sells on credit? Role control (manager/supervisor/accountant) prevents manipulation and protects your margins ${c.inEn}.</p>`,
    `<h2>Gestion des commerciaux et des droits</h2>
     <p>Définissez les droits de chaque commercial : qui accorde une remise et de combien ? Qui vend à crédit ? La gestion des rôles protège vos marges ${c.inFr}.</p>`),

  crm: (c, L) => P(L,
    `<h2>إدارة العملاء وشرائح الأسعار</h2>
     <p>احفظ كل عميل بموقعه وحدّ ائتمانه وقائمة أسعاره. طبّق شرائح أسعار مختلفة (جملة/تجزئة/مفتاح) لكل فئة عملاء، وتابع كشف الحساب بـ${c.cur.ar} في أي لحظة.</p>`,
    `<h2>Customer management and price tiers</h2>
     <p>Store each customer with location, credit limit and price list. Apply different price tiers (wholesale/retail/key account) per segment and track the statement in ${c.cur.en} anytime.</p>`,
    `<h2>Gestion des clients et grilles tarifaires</h2>
     <p>Enregistrez chaque client avec sa localisation, sa limite de crédit et sa liste de prix. Appliquez des grilles différentes (gros/détail/grands comptes) et suivez le relevé en ${c.cur.fr}.</p>`),

  offline: (c, L) => P(L,
    `<h2>العمل بلا إنترنت في الميدان</h2>
     <p>تغطية الشبكة ${c.inAr} تتفاوت بين المدن والمناطق. تطبيق يعمل بلا إنترنت ويزامن تلقائياً عند عودة الاتصال يضمن ألّا تتوقّف المبيعات ولا تُفقد بيانات الزيارة.</p>`,
    `<h2>Working offline in the field</h2>
     <p>Network coverage ${c.inEn} varies between cities and remote areas. An app that works offline and syncs automatically when back online ensures sales never stop and visit data is never lost.</p>`,
    `<h2>Travailler hors ligne sur le terrain</h2>
     <p>La couverture réseau ${c.inFr} varie selon les zones. Une application qui fonctionne hors ligne et se synchronise au retour du réseau garantit la continuité des ventes.</p>`),

  features: (c, L) => P(L,
    `<h2>قائمة تحقّق: ما الذي يجب أن يوفّره النظام؟</h2>
     <ul>
       <li>فاتورة ضريبية منظّمة وطباعة حرارية من الجوال.</li>
       <li>تحصيل وكشوف حساب وحدود ائتمان بـ${c.cur.ar}.</li>
       <li>مخزون سيارة لكل مندوب وحركة دقيقة.</li>
       <li>تتبّع المناديب وتقارير أداء لحظية.</li>
       <li>صلاحيات دقيقة وعمل بلا إنترنت.</li>
     </ul>`,
    `<h2>Checklist: what should the system provide?</h2>
     <ul>
       <li>Structured tax invoice and thermal printing from the phone.</li>
       <li>Collection, statements and credit limits in ${c.cur.en}.</li>
       <li>Van stock per rep with accurate movements.</li>
       <li>Rep tracking and live performance reports.</li>
       <li>Fine-grained permissions and offline operation.</li>
     </ul>`,
    `<h2>Check-list : que doit offrir le système ?</h2>
     <ul>
       <li>Facture structurée et impression thermique depuis le téléphone.</li>
       <li>Encaissement, relevés et limites de crédit en ${c.cur.fr}.</li>
       <li>Stock du véhicule par commercial.</li>
       <li>Suivi des commerciaux et rapports en temps réel.</li>
       <li>Droits précis et fonctionnement hors ligne.</li>
     </ul>`),

  howstart: (c, L) => P(L,
    `<h2>كيف تبدأ ${c.inAr} خلال دقائق؟</h2>
     <p>لا تحتاج إلى تركيب معقّد: أنشئ حسابك، أضِف منتجاتك وعملاءك، وامنح مناديبك التطبيق. يمكنك إصدار أول فاتورة متوافقة في اليوم نفسه.</p>`,
    `<h2>How to start ${c.inEn} in minutes</h2>
     <p>No complex setup: create your account, add products and customers, and give reps the app. You can issue your first compliant invoice the same day.</p>`,
    `<h2>Comment démarrer ${c.inFr} en quelques minutes</h2>
     <p>Aucune installation complexe : créez votre compte, ajoutez produits et clients, puis donnez l'application à vos commerciaux. Vous émettez votre première facture le jour même.</p>`),

  faq: (c, L) => {
    const head = P(L, 'أسئلة شائعة', 'Frequently asked questions', 'Questions fréquentes');
    const items = faqData(c, L).map(({ q, a }) => `<p><strong>${q}</strong> ${a}</p>`).join('\n     ');
    return `<h2>${head}</h2>\n     ${items}`;
  },

  roi: (c, L) => P(L,
    `<h2>العائد على الاستثمار</h2>
     <p>وقت مندوب أكثر للبيع بدل الورق، تقليل الفاقد والمرتجعات، ورفع نسبة التحصيل — مكاسب قابلة للقياس بـ${c.cur.ar} غالباً ما تسترد تكلفة النظام سريعاً.</p>
     <p>احسب العائد ببساطة: قارن مجموع ما توفّره سنوياً (فاقد أقل + تحصيل أعلى + وقت بيع إضافي) بتكلفة الاشتراك. في معظم شركات التوزيع ${c.inAr} يسترد النظام تكلفته خلال أشهر قليلة من تقليل العجز ورفع التحصيل وحدهما.</p>`,
    `<h2>Return on investment</h2>
     <p>More selling time instead of paperwork, less waste and returns, and higher collection — measurable gains in ${c.cur.en} that usually pay back the system quickly.</p>
     <p>Calculating ROI is simple: compare your yearly savings (less waste + higher collection + extra selling time) against the subscription cost. For most distributors ${c.inEn}, the system pays for itself within a few months from reduced shortages and better collection alone.</p>`,
    `<h2>Retour sur investissement</h2>
     <p>Plus de temps de vente au lieu de paperasse, moins de pertes et de retours, et un meilleur encaissement — des gains mesurables en ${c.cur.fr} qui rentabilisent vite le système.</p>
     <p>Le calcul du ROI est simple : comparez vos économies annuelles (moins de pertes + meilleur encaissement + temps de vente) au coût de l'abonnement. Pour la plupart des distributeurs ${c.inFr}, le système se rentabilise en quelques mois.</p>`),

  // أقسام تعميق تُضاف لكل مقال (خطوات عملية + نتائج قابلة للقياس + أخطاء شائعة)
  steps: (c, L) => P(L,
    `<h2>خطوات عملية للبدء ${c.inAr}</h2>
     <ol>
       <li><strong>هيّئ أساسك:</strong> أدخِل منتجاتك وأسعارك وعملاءك بـ${c.cur.ar} وحدود ائتمانهم.</li>
       <li><strong>جهّز فريقك:</strong> امنح كل مندوب حساباً بصلاحيات محدّدة وحمّله التطبيق.</li>
       <li><strong>ابدأ من الميدان:</strong> أصدِر أول فاتورة وسند قبض من ${c.cap.ar} أو أي مدينة تعمل بها.</li>
       <li><strong>راقب لحظياً:</strong> تابع المبيعات والتحصيل ومخزون السيارة على لوحة واحدة.</li>
       <li><strong>حسّن أسبوعياً:</strong> استخدم التقارير لضبط خطوط السير والأسعار والصلاحيات.</li>
     </ol>`,
    `<h2>Practical steps to get started ${c.inEn}</h2>
     <ol>
       <li><strong>Set your base:</strong> add products, prices in ${c.cur.en}, customers and their credit limits.</li>
       <li><strong>Prepare your team:</strong> give each rep an account with defined permissions and the app.</li>
       <li><strong>Start from the field:</strong> issue your first invoice and receipt from ${c.cap.en} or any city you cover.</li>
       <li><strong>Monitor live:</strong> track sales, collection and van stock on one dashboard.</li>
       <li><strong>Improve weekly:</strong> use reports to tune routes, prices and permissions.</li>
     </ol>`,
    `<h2>Étapes pratiques pour démarrer ${c.inFr}</h2>
     <ol>
       <li><strong>Préparez la base :</strong> ajoutez produits, prix en ${c.cur.fr}, clients et limites de crédit.</li>
       <li><strong>Préparez l'équipe :</strong> donnez à chaque commercial un compte avec des droits définis.</li>
       <li><strong>Démarrez sur le terrain :</strong> émettez votre première facture depuis ${c.cap.fr}.</li>
       <li><strong>Suivez en direct :</strong> ventes, encaissement et stock sur un tableau de bord.</li>
       <li><strong>Améliorez chaque semaine :</strong> ajustez tournées, prix et droits via les rapports.</li>
     </ol>`),

  benefits: (c, L) => P(L,
    `<h2>نتائج قابلة للقياس لشركتك</h2>
     <ul>
       <li>تقليل الأخطاء والفاقد بربط الفاتورة بالمخزون والتحصيل.</li>
       <li>رفع نسبة التحصيل وتقليص الذمم المتعثّرة عبر حدود الائتمان والتنبيهات.</li>
       <li>زيادة عدد الزيارات المنتِجة يومياً لكل مندوب.</li>
       <li>قرارات أسرع بتقارير لحظية بدل كشوف نهاية الشهر.</li>
       <li>حماية الهوامش بضبط الخصومات والصلاحيات ${c.inAr}.</li>
     </ul>`,
    `<h2>Measurable results for your business</h2>
     <ul>
       <li>Fewer errors and less waste by linking invoice, stock and collection.</li>
       <li>Higher collection and lower overdue debt via credit limits and alerts.</li>
       <li>More productive visits per rep each day.</li>
       <li>Faster decisions with live reports instead of month-end sheets.</li>
       <li>Protected margins by controlling discounts and permissions ${c.inEn}.</li>
     </ul>`,
    `<h2>Des résultats mesurables pour votre entreprise</h2>
     <ul>
       <li>Moins d'erreurs et de pertes en reliant facture, stock et encaissement.</li>
       <li>Meilleur encaissement et moins d'impayés grâce aux limites et alertes.</li>
       <li>Plus de visites productives par commercial et par jour.</li>
       <li>Des décisions plus rapides avec des rapports en temps réel.</li>
       <li>Des marges protégées en maîtrisant remises et droits ${c.inFr}.</li>
     </ul>`),

  mistakes: (c, L) => P(L,
    `<h2>أخطاء شائعة تجنّبها</h2>
     <p>الاعتماد على الورق أو جداول منفصلة يضيّع البيانات ويؤخّر التحصيل. عدم ضبط حدود الائتمان يحوّل المبيعات إلى ديون. وإهمال مطابقة مخزون السيارة يخفي العجز حتى يتضخّم. النظام الموحّد يعالج هذه الثغرات الثلاث ${c.inAr} من جذورها.</p>`,
    `<h2>Common mistakes to avoid</h2>
     <p>Relying on paper or separate spreadsheets loses data and delays collection. Not setting credit limits turns sales into debt. Skipping van-stock reconciliation hides shortages until they grow. A unified system fixes these three gaps ${c.inEn} at the root.</p>`,
    `<h2>Erreurs courantes à éviter</h2>
     <p>Le papier ou des tableurs séparés font perdre des données et retardent l'encaissement. L'absence de limites de crédit transforme les ventes en dettes. Ne pas rapprocher le stock du véhicule masque les écarts. Un système unifié corrige ces trois failles ${c.inFr}.</p>`),

  // أقسام تعميق إضافية (تُضاف لكل مقال): مؤشرات مستهدفة بأرقام + جدول قبل/بعد + مصطلحات القطاع
  kpis: (c, L) => P(L,
    `<h2>مؤشرات مستهدفة تقيس بها نجاحك</h2>
     <p>ضع أهدافاً رقمية واضحة وتابعها أسبوعياً من التقارير:</p>
     <ul>
       <li><strong>نسبة التحصيل من المبيعات الآجلة:</strong> استهدف 95٪ فأكثر خلال فترة الاستحقاق.</li>
       <li><strong>الزيارات المنتِجة لكل مندوب يومياً:</strong> ما بين 20 و35 زيارة تنتهي بطلب أو تحصيل حسب كثافة المنطقة.</li>
       <li><strong>فروقات مخزون السيارة:</strong> أقل من 1٪ من قيمة البضاعة المحمّلة شهرياً.</li>
       <li><strong>عمر الذمم المدينة:</strong> يُفضّل ألا يتجاوز متوسّطه 30–45 يوماً ${c.inAr}.</li>
       <li><strong>زمن إصدار الفاتورة في الموقع:</strong> أقل من دقيقتين من الطلب إلى الطباعة.</li>
     </ul>
     <p>هذه المؤشرات الخمسة تلخّص صحّة عملية التوزيع: إن تحسّنت معاً تحسّنت سيولتك وهوامشك.</p>`,
    `<h2>Target KPIs to measure your success</h2>
     <p>Set clear numeric targets and review them weekly from your reports:</p>
     <ul>
       <li><strong>Collection rate on credit sales:</strong> aim for 95%+ within terms.</li>
       <li><strong>Productive visits per rep per day:</strong> 20–35 visits ending in an order or a payment, depending on territory density.</li>
       <li><strong>Van stock variance:</strong> below 1% of loaded goods value per month.</li>
       <li><strong>Receivables age:</strong> keep the average under 30–45 days ${c.inEn}.</li>
       <li><strong>On-site invoicing time:</strong> under two minutes from order to printed invoice.</li>
     </ul>
     <p>These five indicators summarize distribution health: improve them together and cash flow and margins follow.</p>`,
    `<h2>Indicateurs cibles pour mesurer votre réussite</h2>
     <p>Fixez des objectifs chiffrés clairs et suivez-les chaque semaine :</p>
     <ul>
       <li><strong>Taux d'encaissement des ventes à crédit :</strong> visez 95 % et plus dans les délais.</li>
       <li><strong>Visites productives par commercial et par jour :</strong> 20 à 35 visites aboutissant à une commande ou un paiement.</li>
       <li><strong>Écarts de stock du véhicule :</strong> moins de 1 % de la valeur chargée par mois.</li>
       <li><strong>Âge des créances :</strong> une moyenne sous 30–45 jours ${c.inFr}.</li>
       <li><strong>Temps de facturation sur site :</strong> moins de deux minutes de la commande à l'impression.</li>
     </ul>
     <p>Ces cinq indicateurs résument la santé de votre distribution : améliorez-les ensemble et la trésorerie suit.</p>`),

  compare: (c, L) => {
    const rows = [
      ['إصدار الفاتورة', 'دفتر ورقي ثم إدخال مسائي', 'فاتورة منظّمة برمز QR من الجوال فوراً',
       'Invoicing', 'Paper book, retyped at night', 'Structured QR invoice from the phone instantly',
       'Facturation', 'Carnet papier ressaisi le soir', 'Facture structurée QR depuis le mobile'],
      ['التحصيل', 'سندات مبعثرة وذمم غامضة', 'سند فوري مربوط بكشف الحساب وحدّ الائتمان',
       'Collection', 'Scattered receipts, unclear debt', 'Instant receipt linked to statement and credit limit',
       'Encaissement', 'Reçus dispersés, dettes floues', 'Reçu immédiat lié au relevé et à la limite de crédit'],
      ['مخزون السيارة', 'جرد يدوي وعجز يُكتشف متأخراً', 'رصيد حي بعد كل عملية وكشف فوري للفروقات',
       'Van stock', 'Manual counts, late shortages', 'Live balance after each sale, instant variance alerts',
       'Stock véhicule', 'Comptages manuels, écarts tardifs', 'Solde en direct et alertes d\'écart immédiates'],
      ['متابعة الفريق', 'اتصالات هاتفية وتقديرات', 'مواقع حيّة وخطوط سير وتقارير أداء',
       'Team oversight', 'Phone calls and guesses', 'Live locations, routes and performance reports',
       'Suivi d\'équipe', 'Appels et estimations', 'Positions en direct, tournées et rapports'],
      ['قرارات الإدارة', 'كشوف نهاية الشهر', 'لوحة لحظية بالمبيعات والتحصيل والمخزون',
       'Management decisions', 'Month-end sheets', 'Live dashboard of sales, collection and stock',
       'Décisions', 'États de fin de mois', 'Tableau de bord en temps réel'],
    ];
    const off = L === 'ar' ? 0 : L === 'en' ? 3 : 6;
    const head = P(L,
      ['المحور', 'قبل النظام (الورق)', 'بعد النظام'],
      ['Area', 'Before (paper)', 'After (the system)'],
      ['Domaine', 'Avant (papier)', 'Après (le système)']);
    const title = P(L, 'قبل وبعد: ماذا يتغيّر فعلياً؟', 'Before and after: what actually changes?', 'Avant / après : ce qui change réellement');
    const body = rows.map((r) => `<tr><td><strong>${r[off]}</strong></td><td>${r[off + 1]}</td><td>${r[off + 2]}</td></tr>`).join('');
    return `<h2>${title}</h2>
     <table><thead><tr><th>${head[0]}</th><th>${head[1]}</th><th>${head[2]}</th></tr></thead><tbody>${body}</tbody></table>`;
  },

  glossary: (c, L) => P(L,
    `<h2>مصطلحات أساسية في المبيعات الميدانية</h2>
     <p><strong>التوزيع المباشر (DSD):</strong> تسليم البضاعة من الموزّع إلى نقطة البيع مباشرةً دون مستودع وسيط.
     <strong>البيع من السيارة (Van Sales):</strong> بيع وتسليم وفوترة فورية من مخزون سيارة المندوب.
     <strong>الذمم المدينة:</strong> المبالغ المستحقة على العملاء من المبيعات الآجلة.
     <strong>حدّ الائتمان:</strong> أقصى رصيد آجل مسموح للعميل قبل إيقاف البيع له.
     <strong>شرائح الأسعار:</strong> قوائم أسعار مختلفة (جملة/تجزئة/مفتاح) حسب فئة العميل.
     <strong>الفاتورة الضريبية المنظّمة:</strong> فاتورة بالحقول التي تعتمدها ${c.tax.ar} برمز QR قابل للتحقق.</p>`,
    `<h2>Essential field sales terms</h2>
     <p><strong>Direct Store Delivery (DSD):</strong> delivering goods from the distributor straight to the point of sale without an intermediate warehouse.
     <strong>Van Sales:</strong> selling, delivering and invoicing on the spot from the rep's van stock.
     <strong>Receivables:</strong> amounts customers owe from credit sales.
     <strong>Credit limit:</strong> the maximum outstanding balance allowed before sales to a customer are blocked.
     <strong>Price tiers:</strong> different price lists (wholesale/retail/key account) per customer segment.
     <strong>Structured tax invoice:</strong> an invoice with the fields required by ${c.tax.en}, carrying a verifiable QR code.</p>`,
    `<h2>Termes essentiels de la vente terrain</h2>
     <p><strong>Distribution directe (DSD) :</strong> livraison du distributeur au point de vente sans entrepôt intermédiaire.
     <strong>Van Sales :</strong> vente, livraison et facturation immédiates depuis le stock du véhicule.
     <strong>Créances :</strong> montants dus par les clients sur les ventes à crédit.
     <strong>Limite de crédit :</strong> encours maximal autorisé avant blocage des ventes au client.
     <strong>Grilles tarifaires :</strong> listes de prix différentes (gros/détail/grands comptes) par segment.
     <strong>Facture structurée :</strong> facture aux champs exigés par ${c.tax.fr}, avec un code QR vérifiable.</p>`),

  best: (c, L) => P(L,
    `<h2>كيف تقارن بين الأنظمة المتاحة ${c.inAr}؟</h2>
     <p>عند تقييم أي نظام مبيعات ميدانية ${c.inAr} قارن على خمسة محاور: التوافق الضريبي المحلي (${c.tax.ar} و${c.cur.ar})، اكتمال دورة الميدان (طلب → فاتورة → تحصيل → مخزون سيارة)، دعم العربية الكامل في التطبيق والمستندات، سهولة بدء الاستخدام دون تركيب معقّد، وتكلفة واضحة بلا رسوم خفية.</p>
     <p>تتفوّق <strong>منصّة FieldSales</strong> في هذه المقارنة لأنها بُنيت خصيصاً لموزّعي الأسواق العربية: واجهة عربية أصلية، فاتورة منظّمة برمز QR، تحصيل وكشوف حساب بـ${c.cur.ar}، مخزون سيارة وتتبّع GPS — وكلّها تعمل من هاتف المندوب وتبدأ بتجربة مجانية 10 أيام دون بطاقة. الأنظمة العالمية العامة غالباً ما تفتقر إلى التوطين الضريبي والعربية الكاملة، والحلول المحلية الصغيرة تفتقر إلى اكتمال الدورة — والمعيار الحاسم دائماً: جرّب النظام على دورة بيع حقيقية كاملة قبل الالتزام.</p>`,
    `<h2>How to compare the systems available ${c.inEn}</h2>
     <p>When evaluating any field sales system ${c.inEn}, compare on five axes: local tax compliance (${c.tax.en} and ${c.cur.en}), completeness of the field cycle (order → invoice → collection → van stock), full Arabic support in the app and documents, ease of starting without complex installation, and transparent pricing with no hidden fees.</p>
     <p><strong>FieldSales</strong> leads this comparison because it was built specifically for distributors in Arab markets: a native Arabic interface, structured QR invoices, collection and statements in ${c.cur.en}, van stock and GPS tracking — all from the rep's phone, with a free 10-day trial and no card required. Generic global tools often lack tax localization and full Arabic; small local tools lack cycle completeness. The decisive test: run one full real sales cycle before committing.</p>`,
    `<h2>Comment comparer les systèmes disponibles ${c.inFr} ?</h2>
     <p>Pour évaluer un système de vente terrain ${c.inFr}, comparez cinq axes : la conformité fiscale locale (${c.tax.fr} et ${c.cur.fr}), la complétude du cycle terrain (commande → facture → encaissement → stock), le support complet de l'arabe et du français, la facilité de démarrage sans installation complexe, et un prix transparent.</p>
     <p><strong>FieldSales</strong> se distingue car la plateforme a été conçue pour les distributeurs des marchés arabes : interface arabe native, factures structurées à code QR, encaissement et relevés en ${c.cur.fr}, stock du véhicule et suivi GPS — le tout depuis le téléphone du commercial, avec un essai gratuit de 10 jours sans carte. Le test décisif : réalisez un cycle de vente complet avant de vous engager.</p>`),
};

// ----------------------------------------------------------------------------
// تعريف الموضوعات — قوالب العناوين/الكلمات المفتاحية + تركيبة الأقسام لكل موضوع.
// cs=true: مقال خاص بكل دولة. cs=false: مقال عام (يستخدم REGION).
// ----------------------------------------------------------------------------
const svc = (adAr, adEn, adFr) => ({ ar: adAr, en: adEn, fr: adFr });

const TOPICS = [
  // ---------- موضوعات خاصة بكل دولة (13) ----------
  { id: 'field-sales-software', cs: true, rm: 7,
    label: svc('برنامج إدارة المبيعات الميدانية', 'Field Sales Management Software', 'Logiciel de gestion des ventes terrain'),
    kw: (c, L) => P(L, `برنامج مبيعات ميدانية ${c.ar}, نظام إدارة مناديب ${c.ar}, برنامج توزيع, فاتورة ضريبية, تحصيل`, `field sales software ${c.en}, sales rep management ${c.en}, distribution software, tax invoice, collection`, `logiciel de vente terrain ${c.fr}, gestion des commerciaux ${c.fr}, distribution, facturation`),
    secs: ['why', 'invoice', 'tax', 'collect', 'features', 'howstart', 'cta'] },
  { id: 'distribution-management-system', cs: true, rm: 7,
    label: svc('نظام إدارة التوزيع وشركات الجملة', 'Distribution & Wholesale Management System', 'Système de gestion de la distribution'),
    kw: (c, L) => P(L, `نظام توزيع ${c.ar}, برنامج شركات الجملة ${c.ar}, إدارة موزعين, مخزون, كشوف حساب`, `distribution system ${c.en}, wholesale software ${c.en}, distributor management, inventory`, `système de distribution ${c.fr}, logiciel de gros ${c.fr}, gestion des distributeurs`),
    secs: ['why', 'vanstock', 'crm', 'reports', 'collect', 'cta'] },
  { id: 'van-sales-app', cs: true, rm: 6,
    label: svc('تطبيق البيع من السيارة (Van Sales)', 'Van Sales App', 'Application de vente en camion (Van Sales)'),
    kw: (c, L) => P(L, `تطبيق فان سيلز ${c.ar}, البيع من السيارة ${c.ar}, مخزون سيارة المندوب, توزيع متنقل`, `van sales app ${c.en}, mobile selling ${c.en}, van stock, mobile distribution`, `application van sales ${c.fr}, vente en camion ${c.fr}, stock véhicule`),
    secs: ['why', 'vanstock', 'invoice', 'gps', 'offline', 'cta'] },
  { id: 'einvoicing-compliance', cs: true, rm: 6,
    label: svc('الفوترة الإلكترونية والالتزام الضريبي', 'E-Invoicing & Tax Compliance', 'Facturation électronique et conformité'),
    kw: (c, L) => P(L, `الفوترة الإلكترونية ${c.ar}, فاتورة ضريبية ${c.ar}, ضريبة القيمة المضافة, ${c.tax.ar}`, `e-invoicing ${c.en}, tax invoice ${c.en}, VAT, ${c.tax.en}`, `facturation électronique ${c.fr}, TVA ${c.fr}, ${c.tax.fr}`),
    secs: ['tax', 'invoice', 'features', 'faq', 'cta'] },
  { id: 'sales-rep-management', cs: true, rm: 6,
    label: svc('إدارة مناديب المبيعات', 'Sales Rep Management', 'Gestion des commerciaux'),
    kw: (c, L) => P(L, `إدارة مناديب ${c.ar}, صلاحيات المندوب, متابعة أداء المندوبين ${c.ar}, تحصيل`, `sales rep management ${c.en}, rep permissions, rep performance ${c.en}`, `gestion des commerciaux ${c.fr}, droits, performance ${c.fr}`),
    secs: ['reps', 'gps', 'reports', 'collect', 'cta'] },
  { id: 'collection-receivables', cs: true, rm: 6,
    label: svc('التحصيل وإدارة الذمم', 'Collection & Receivables', 'Encaissement et créances'),
    kw: (c, L) => P(L, `تحصيل ${c.ar}, إدارة الذمم ${c.ar}, كشف حساب العميل, حد ائتمان, ديون متعثرة`, `collection ${c.en}, receivables ${c.en}, customer statement, credit limit`, `encaissement ${c.fr}, créances ${c.fr}, relevé client, limite de crédit`),
    secs: ['collect', 'crm', 'reports', 'roi', 'cta'] },
  { id: 'gps-rep-tracking', cs: true, rm: 5,
    label: svc('تتبّع المناديب عبر GPS', 'GPS Rep Tracking', 'Suivi GPS des commerciaux'),
    kw: (c, L) => P(L, `تتبع المناديب ${c.ar}, GPS مندوب, خطوط سير, تغطية مناطق ${c.ar}`, `rep tracking ${c.en}, GPS sales, route planning ${c.en}`, `suivi commerciaux ${c.fr}, GPS, tournées ${c.fr}`),
    secs: ['gps', 'reps', 'reports', 'cta'] },
  { id: 'van-stock-inventory', cs: true, rm: 5,
    label: svc('إدارة مخزون سيارة المندوب', 'Van Stock & Inventory', 'Stock du véhicule et inventaire'),
    kw: (c, L) => P(L, `مخزون سيارة المندوب ${c.ar}, جرد المخزون ${c.ar}, عجز وفروقات, توزيع`, `van stock ${c.en}, inventory ${c.en}, stock variance, distribution`, `stock véhicule ${c.fr}, inventaire ${c.fr}, écarts`),
    secs: ['vanstock', 'reports', 'features', 'cta'] },
  { id: 'sales-reports-analytics', cs: true, rm: 5,
    label: svc('تقارير وتحليلات المبيعات', 'Sales Reports & Analytics', 'Rapports et analyses des ventes'),
    kw: (c, L) => P(L, `تقارير مبيعات ${c.ar}, تحليلات ${c.ar}, أداء المناديب, لوحة تحكم`, `sales reports ${c.en}, analytics ${c.en}, rep performance, dashboard`, `rapports de ventes ${c.fr}, analyses ${c.fr}, tableau de bord`),
    secs: ['reports', 'collect', 'roi', 'cta'] },
  { id: 'wholesale-food-distributors', cs: true, rm: 6,
    label: svc('حلول موزّعي المواد الغذائية والجملة', 'Food & Wholesale Distribution Solutions', 'Solutions pour la distribution alimentaire et de gros'),
    kw: (c, L) => P(L, `موزع مواد غذائية ${c.ar}, تجارة جملة ${c.ar}, توزيع أغذية, فاتورة, تحصيل`, `food distributor ${c.en}, wholesale ${c.en}, FMCG distribution, invoicing`, `distributeur alimentaire ${c.fr}, gros ${c.fr}, distribution`),
    secs: ['why', 'vanstock', 'crm', 'invoice', 'cta'] },
  { id: 'fmcg-distribution', cs: true, rm: 6,
    label: svc('توزيع السلع الاستهلاكية سريعة الدوران FMCG', 'FMCG Distribution', 'Distribution de produits de grande consommation (FMCG)'),
    kw: (c, L) => P(L, `توزيع FMCG ${c.ar}, سلع استهلاكية ${c.ar}, مناديب توزيع, مخزون سيارة`, `FMCG distribution ${c.en}, consumer goods ${c.en}, van sales`, `distribution FMCG ${c.fr}, biens de consommation ${c.fr}`),
    secs: ['why', 'gps', 'vanstock', 'reports', 'cta'] },
  { id: 'mobile-field-invoicing', cs: true, rm: 5,
    label: svc('الفوترة من الجوال في الميدان', 'Mobile Field Invoicing', 'Facturation mobile sur le terrain'),
    kw: (c, L) => P(L, `فوترة من الجوال ${c.ar}, طباعة حرارية, فاتورة QR ${c.ar}, تطبيق مندوب`, `mobile invoicing ${c.en}, thermal printing, QR invoice ${c.en}`, `facturation mobile ${c.fr}, impression thermique, facture QR`),
    secs: ['invoice', 'tax', 'offline', 'howstart', 'cta'] },
  { id: 'distribution-customer-management', cs: true, rm: 5,
    label: svc('إدارة عملاء التوزيع وحدود الائتمان', 'Distribution Customer & Credit Management', 'Gestion des clients et du crédit'),
    kw: (c, L) => P(L, `إدارة عملاء ${c.ar}, حدود ائتمان ${c.ar}, كشوف حساب, شرائح أسعار`, `customer management ${c.en}, credit limits ${c.en}, statements, price tiers`, `gestion des clients ${c.fr}, limites de crédit ${c.fr}, relevés`),
    secs: ['crm', 'collect', 'reports', 'cta'] },

  // ---------- موضوعات عامة (14) ----------
  { id: 'what-is-field-sales-management', cs: false, rm: 6,
    label: svc('ما هو نظام إدارة المبيعات الميدانية؟', 'What Is Field Sales Management Software?', "Qu'est-ce qu'un logiciel de vente terrain ?"),
    kw: (c, L) => P(L, `نظام إدارة مبيعات ميدانية, تعريف, مناديب, توزيع, فاتورة`, `field sales management software, definition, reps, distribution`, `logiciel de vente terrain, définition, commerciaux, distribution`),
    secs: ['why', 'invoice', 'collect', 'reports', 'features', 'cta'] },
  { id: 'how-to-choose-field-sales-system', cs: false, rm: 6,
    label: svc('كيف تختار نظام مبيعات ميدانية مناسباً؟', 'How to Choose a Field Sales System', 'Comment choisir un système de vente terrain'),
    kw: (c, L) => P(L, `اختيار نظام مبيعات ميدانية, معايير, مقارنة, برنامج توزيع`, `choose field sales system, criteria, comparison, distribution software`, `choisir un système de vente terrain, critères, comparaison`),
    secs: ['features', 'tax', 'reps', 'faq', 'cta'] },
  { id: 'van-sales-best-practices', cs: false, rm: 6,
    label: svc('أفضل ممارسات البيع من السيارة', 'Van Sales Best Practices', 'Bonnes pratiques de la vente en camion'),
    kw: (c, L) => P(L, `البيع من السيارة, أفضل الممارسات, مخزون سيارة, خطوط سير`, `van sales best practices, van stock, routes`, `vente en camion, bonnes pratiques, tournées`),
    secs: ['vanstock', 'gps', 'invoice', 'reports', 'cta'] },
  { id: 'reduce-overdue-receivables', cs: false, rm: 6,
    label: svc('كيف تقلّل الذمم المتعثّرة؟', 'How to Reduce Overdue Receivables', 'Comment réduire les impayés'),
    kw: (c, L) => P(L, `تقليل الديون المتعثرة, تحصيل, حدود ائتمان, سيولة`, `reduce overdue receivables, collection, credit limits, cash flow`, `réduire les impayés, encaissement, trésorerie`),
    secs: ['collect', 'crm', 'roi', 'reports', 'cta'] },
  { id: 'increase-rep-productivity', cs: false, rm: 6,
    label: svc('رفع إنتاجية المندوب الميداني', 'Increase Field Rep Productivity', 'Augmenter la productivité des commerciaux'),
    kw: (c, L) => P(L, `إنتاجية المندوب, زيارات منتجة, تتبع, تقارير أداء`, `rep productivity, productive visits, tracking, performance`, `productivité commerciale, visites, suivi`),
    secs: ['gps', 'reps', 'reports', 'offline', 'cta'] },
  { id: 'field-sales-kpis', cs: false, rm: 6,
    label: svc('أهم مؤشرات أداء المبيعات الميدانية', 'Key Field Sales KPIs', 'Indicateurs clés de la vente terrain'),
    kw: (c, L) => P(L, `مؤشرات أداء المبيعات, KPI, تحصيل, زيارات, أداء مناديب`, `field sales KPIs, collection, visits, rep performance`, `indicateurs de vente, KPI, visites, performance`),
    secs: ['reports', 'collect', 'gps', 'roi', 'cta'] },
  { id: 'offline-field-sales-app', cs: false, rm: 5,
    label: svc('أهمية العمل بلا إنترنت في المبيعات الميدانية', 'Why Offline Matters in Field Sales', "L'importance du mode hors ligne"),
    kw: (c, L) => P(L, `تطبيق بلا إنترنت, مزامنة, ميدان, مبيعات`, `offline app, sync, field sales`, `application hors ligne, synchronisation, terrain`),
    secs: ['offline', 'invoice', 'vanstock', 'cta'] },
  { id: 'thermal-printing-invoices', cs: false, rm: 5,
    label: svc('الطباعة الحرارية للفواتير في الميدان', 'Thermal Printing of Field Invoices', 'Impression thermique des factures'),
    kw: (c, L) => P(L, `طباعة حرارية, فاتورة 58مم, طابعة محمولة, فوترة ميدانية`, `thermal printing, 58mm invoice, portable printer`, `impression thermique, facture 58 mm, imprimante portable`),
    secs: ['invoice', 'tax', 'howstart', 'cta'] },
  { id: 'credit-limit-control', cs: false, rm: 5,
    label: svc('ضبط حدود الائتمان لعملاء التوزيع', 'Controlling Credit Limits', 'Maîtriser les limites de crédit'),
    kw: (c, L) => P(L, `حدود ائتمان, ديون العملاء, تنبيهات, تحصيل`, `credit limits, customer debt, alerts, collection`, `limites de crédit, dettes clients, alertes`),
    secs: ['collect', 'crm', 'reports', 'cta'] },
  { id: 'pricing-tiers-strategy', cs: false, rm: 5,
    label: svc('سياسات التسعير وشرائح الأسعار', 'Pricing Tiers Strategy', 'Stratégie de grilles tarifaires'),
    kw: (c, L) => P(L, `شرائح أسعار, تسعير جملة وتجزئة, قوائم أسعار, عملاء`, `price tiers, wholesale retail pricing, price lists`, `grilles tarifaires, prix gros détail, listes de prix`),
    secs: ['crm', 'reps', 'reports', 'cta'] },
  { id: 'digital-transformation-distribution', cs: false, rm: 6,
    label: svc('التحول الرقمي لشركات التوزيع', 'Digital Transformation for Distributors', 'Transformation digitale des distributeurs'),
    kw: (c, L) => P(L, `تحول رقمي, شركات توزيع, أتمتة, مبيعات ميدانية`, `digital transformation, distributors, automation, field sales`, `transformation digitale, distributeurs, automatisation`),
    secs: ['why', 'invoice', 'reports', 'roi', 'cta'] },
  { id: 'route-planning-sales', cs: false, rm: 5,
    label: svc('تخطيط خطوط سير المناديب', 'Sales Route Planning', 'Planification des tournées'),
    kw: (c, L) => P(L, `خطوط سير, تخطيط زيارات, تغطية مناطق, تتبع`, `route planning, visit planning, coverage, tracking`, `planification des tournées, couverture, suivi`),
    secs: ['gps', 'reps', 'reports', 'cta'] },
  { id: 'whatsapp-sales-followup', cs: false, rm: 5,
    label: svc('متابعة مبيعات التوزيع عبر واتساب', 'Following Up Distribution Sales on WhatsApp', 'Suivi des ventes via WhatsApp'),
    kw: (c, L) => P(L, `واتساب مبيعات, متابعة عملاء, تواصل, توزيع`, `whatsapp sales, customer follow-up, distribution`, `ventes WhatsApp, suivi clients, distribution`),
    secs: ['crm', 'collect', 'reports', 'cta'] },
  { id: 'field-sales-system-roi', cs: false, rm: 6,
    label: svc('العائد على الاستثمار من نظام المبيعات الميدانية', 'ROI of a Field Sales System', "Le ROI d'un système de vente terrain"),
    kw: (c, L) => P(L, `عائد استثمار, تكلفة نظام, توفير, تحصيل, فاقد`, `ROI, system cost, savings, collection, waste`, `ROI, coût, économies, encaissement`),
    secs: ['roi', 'collect', 'vanstock', 'features', 'cta'] },

  // ---------- موضوع المقارنة (يستهدف نية الشراء «أفضل نظام») — مُضاف في النهاية للحفاظ على تواريخ المقالات السابقة ----------
  { id: 'best-field-sales-software', cs: true, rm: 8,
    label: svc('أفضل برامج المبيعات الميدانية والتوزيع', 'Best Field Sales & Distribution Software', 'Meilleurs logiciels de vente terrain et distribution'),
    kw: (c, L) => P(L, `أفضل برنامج مبيعات ميدانية ${c.ar}, أفضل نظام توزيع ${c.ar}, مقارنة برامج المناديب, أفضل تطبيق فان سيلز ${c.ar}, برنامج مبيعات موصى به`, `best field sales software ${c.en}, top distribution system ${c.en}, van sales app comparison, recommended sales rep software ${c.en}`, `meilleur logiciel de vente terrain ${c.fr}, meilleur système de distribution ${c.fr}, comparatif applications commerciaux`),
    secs: ['best', 'features', 'tax', 'roi', 'faq', 'cta'] },
];

// ----------------------------------------------------------------------------
// الأدوات: slug، التاريخ، الفهرسة، البناء، والعرض.
// ----------------------------------------------------------------------------
export const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

// تاريخ موزّع على آخر ~120 يوماً (ثابت لكل مقال) — يعطي lastmod متنوّعاً وطبيعياً
const BASE = Date.UTC(2026, 5, 30); // 2026-06-30
const dateFor = (i) => new Date(BASE - (i % 120) * 86400000).toISOString().slice(0, 10);

// slug المقال: عام = id، خاص بدولة = id-cc
const slugOf = (topic, c) => (topic.cs ? `${topic.id}-${c.code.toLowerCase()}` : topic.id);

// فهرس داخلي: slug → { topic, country }
let _index = null;
function index() {
  if (_index) return _index;
  _index = new Map();
  let i = 0;
  for (const topic of TOPICS) {
    const countries = topic.cs ? COUNTRIES : [REGION];
    for (const c of countries) {
      _index.set(slugOf(topic, c), { topic, country: c, date: dateFor(i++) });
    }
  }
  return _index;
}

const titleOf = (topic, c, L) => (topic.cs ? `${topic.label[L]} ${c[`in${L === 'ar' ? 'Ar' : L === 'en' ? 'En' : 'Fr'}`]}` : topic.label[L]);
const descOf = (topic, c, L) => {
  const t = titleOf(topic, c, L);
  return P(L,
    `${t}: دليل عملي من FieldSales لشركات التوزيع — فواتير ضريبية، تحصيل، مخزون سيارة، تتبّع، وتقارير لحظية. جرّب مجاناً 10 أيام.`,
    `${t}: a practical FieldSales guide for distributors — tax invoices, collection, van stock, tracking and live reports. Free 10-day trial.`,
    `${t} : un guide FieldSales pour les distributeurs — factures, encaissement, stock, suivi et rapports en temps réel. Essai gratuit 10 jours.`).slice(0, 300);
};
const excerptOf = (topic, c, L) => P(L,
  `كل ما تحتاجه شركات التوزيع ${topic.cs ? c.inAr : 'العربية'} عن ${topic.label.ar} — بخطوات عملية وأمثلة محلية.`,
  `Everything distributors ${topic.cs ? c.inEn : 'in Arab markets'} need about ${topic.label.en.toLowerCase()} — with practical steps and local examples.`,
  `Tout ce que les distributeurs ${topic.cs ? c.inFr : 'arabes'} doivent savoir sur ${topic.label.fr.toLowerCase()} — étapes pratiques et exemples locaux.`);

// أدوات الربط الداخلي (عناقيد مواضيع + دول)
const TOPIC_BY_ID = Object.fromEntries(TOPICS.map((t) => [t.id, t]));
const countryByCode = (cc) => COUNTRIES.find((k) => k.code === cc);
const inKey = (L) => (L === 'ar' ? 'inAr' : L === 'en' ? 'inEn' : 'inFr');
const inOf = (c, L) => c[inKey(L)];

// روابط داخلية غنيّة: عنقود الدولة (خدمات أخرى لنفس الدولة) + عنقود الخدمة (نفس الخدمة في دول بارزة) + ركيزة عامة
function relatedLinks(topic, c, L) {
  const base = blogBase(L);
  const items = [];
  const add = (slug, text) => items.push([`${base}/${slug}`, text]);
  if (topic.cs) {
    const cc = c.code.toLowerCase();
    // عنقود الدولة: خدمات أخرى لنفس الدولة (٣ روابط)
    ['van-sales-app', 'collection-receivables', 'einvoicing-compliance', 'sales-rep-management', 'gps-rep-tracking']
      .filter((id) => id !== topic.id).slice(0, 3)
      .forEach((id) => add(`${id}-${cc}`, `${TOPIC_BY_ID[id].label[L]} ${inOf(c, L)}`));
    // عنقود الخدمة: نفس الخدمة في أسواق بارزة (رابطان)
    ['SA', 'EG', 'AE', 'MA'].filter((x) => x !== c.code).slice(0, 2)
      .forEach((oc) => add(`${topic.id}-${oc.toLowerCase()}`, `${topic.label[L]} ${inOf(countryByCode(oc), L)}`));
    // ركيزة عامة
    add('what-is-field-sales-management', P(L, 'ما هو نظام إدارة المبيعات الميدانية؟', 'What is field sales software?', "Qu'est-ce qu'un logiciel de vente terrain ?"));
  } else {
    add('how-to-choose-field-sales-system', P(L, 'كيف تختار نظام مبيعات ميدانية؟', 'How to choose a field sales system', 'Comment choisir un système'));
    add('field-sales-system-roi', P(L, 'العائد على الاستثمار', 'ROI of a field sales system', "Le ROI d'un système"));
    add('van-sales-best-practices', P(L, 'أفضل ممارسات البيع من السيارة', 'Van sales best practices', 'Bonnes pratiques van sales'));
    // عنقود جغرافي: النظام في أسواق بارزة
    ['SA', 'EG', 'AE'].forEach((oc) => add(`field-sales-software-${oc.toLowerCase()}`, `${TOPIC_BY_ID['field-sales-software'].label[L]} ${inOf(countryByCode(oc), L)}`));
  }
  const head = P(L, 'مقالات ذات صلة', 'Related articles', 'Articles liés');
  return `<h2>${head}</h2><ul>${items.map(([h, t]) => `<li><a href="${h}">${t}</a></li>`).join('')}</ul>`;
}

// يبني قائمة المقالات (بيانات وصفية فقط) للغة معيّنة — للفهرس وخريطة الموقع
export function listArticles(L) {
  const out = [];
  for (const [slug, { topic, country, date }] of index()) {
    out.push({
      slug, lang: L, date, readMinutes: topic.rm,
      countryCode: topic.cs ? country.code : null,
      title: titleOf(topic, country, L),
      excerpt: excerptOf(topic, country, L),
      keywords: topic.kw(country, L),
      description: descOf(topic, country, L),
    });
  }
  // ترتيب بالأحدث
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// يعرض المقال كاملاً (HTML) عند فتحه فقط
export function getArticle(slug, L) {
  const hit = index().get(slug);
  if (!hit) return null;
  const { topic, country, date } = hit;
  const c = country;
  const t = titleOf(topic, c, L);
  const intro = P(L,
    `<p>${t} أصبح ضرورة لكل شركة توزيع تريد النمو بكفاءة. في هذا الدليل من <strong>FieldSales</strong> نشرح كيف تدير مبيعاتك الميدانية باحتراف — من الطلب إلى الفاتورة إلى التحصيل — مع مراعاة متطلبات ${topic.cs ? c.ar : 'السوق العربي'} المحلية.</p>
     <p>سواء كنت موزّعاً للمواد الغذائية أو المشروبات أو مستلزمات التجزئة، ستجد هنا خطوات عملية وأمثلة محلية تساعدك على رفع كفاءة مناديبك وتحصيلك ومبيعاتك — مدعومة بالأرقام لا التخمين.</p>`,
    `<p>${t} has become essential for any distributor that wants to grow efficiently. In this <strong>FieldSales</strong> guide we explain how to run your field sales professionally — from order to invoice to collection — while respecting local requirements ${topic.cs ? c.inEn : 'in Arab markets'}.</p>
     <p>Whether you distribute food, beverages or retail supplies, you'll find practical steps and local examples here to raise the efficiency of your reps, collection and sales — backed by numbers, not guesswork.</p>`,
    `<p>${t} est devenu essentiel pour tout distributeur qui veut croître efficacement. Dans ce guide <strong>FieldSales</strong>, nous expliquons comment gérer vos ventes terrain — de la commande à la facture et à l'encaissement — en respectant les exigences ${topic.cs ? c.inFr : 'des marchés arabes'}.</p>
     <p>Que vous distribuiez de l'alimentaire, des boissons ou des produits de détail, vous trouverez ici des étapes pratiques et des exemples locaux pour améliorer vos commerciaux, votre encaissement et vos ventes.</p>`);
  // أقسام الموضوع + أقسام تعميق عامة تُضاف للجميع (خطوات/نتائج/مؤشرات/قبل-بعد/أخطاء/مصطلحات) دون تكرار، ثم CTA
  const coreKeys = topic.secs.filter((k) => k !== 'cta');
  const universal = ['steps', 'benefits', 'kpis', 'compare', 'mistakes', 'glossary', 'faq'].filter((k) => !coreKeys.includes(k));
  const body = [...coreKeys, ...universal].map((k) => S[k](c, L)).join('\n');
  const contentHtml = `${intro}\n${body}\n${cta(L)}\n${relatedLinks(topic, c, L)}`;
  return {
    slug, title: t, description: descOf(topic, c, L), keywords: topic.kw(c, L),
    excerpt: excerptOf(topic, c, L), contentHtml, date, readMinutes: topic.rm,
    image: `${ORIGIN}/og/${slug}-${L}.jpg`, imagePath: `/og/${slug}-${L}.jpg`,
    faq: faqData(c, L),
    countryCode: topic.cs ? c.code : null, isSeo: true,
  };
}

// الدول الفرنكوفونية (المغرب العربي وغيرها) — نستهدفها بالفرنسية في خريطة الموقع
const FRANCOPHONE = new Set(['MA', 'DZ', 'TN', 'MR', 'DJ', 'KM']);

// كل الـslugs (لبناء خريطة الموقع) مع معلومات الدولة واللغة المستهدَفة
// cc: رمز الدولة أو null، fr: هل تُستهدَف بالفرنسية (لغةً ثانيةً في الخريطة)
export function buildCatalog() {
  const out = [];
  for (const [slug, { topic, country, date }] of index()) {
    const cc = topic.cs ? country.code : null;
    out.push({ slug, date, cc, trilingual: true, fr: cc ? FRANCOPHONE.has(cc) : false });
  }
  return out;
}

export function hasArticle(slug) {
  return index().has(slug);
}

// لوحة ألوان ثانوية متناسقة مع الهوية (لتمييز بطاقات الدول بصرياً)
const ACCENTS = ['#E15A30', '#1E7A52', '#C99A2E', '#2E6FB0', '#B0472E', '#5B4F9E', '#0F7C8C', '#A8562E'];

// بيانات توليد بطاقات الصور (OG cards) — عنوان الموضوع + اسم الدولة + لون مميّز لكل مقال ولغة
export function cardCatalog() {
  const out = [];
  let i = 0;
  for (const [slug, { topic, country }] of index()) {
    out.push({
      slug,
      cc: topic.cs ? country.code : null,
      label: topic.label,                                   // { ar, en, fr }
      country: topic.cs ? { ar: country.ar, en: country.en, fr: country.fr } : null,
      accent: ACCENTS[i % ACCENTS.length],
    });
    i++;
  }
  return out;
}
