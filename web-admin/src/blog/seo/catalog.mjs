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

// خطوات عملية كبيانات منظّمة (تُغذّي HowTo schema) — تقتبسها محركات AI لأسئلة «كيف تبدأ»
const howToData = (c, L) => [
  { name: P(L, 'هيّئ أساسك', 'Set your base', 'Préparez la base'),
    text: P(L, `أدخِل منتجاتك وأسعارك وعملاءك بعملة ${c.cur.ar} وحدود ائتمانهم.`,
      `Add your products, prices in ${c.cur.en}, customers and their credit limits.`,
      `Ajoutez vos produits, prix en ${c.cur.fr}, clients et limites de crédit.`) },
  { name: P(L, 'جهّز فريقك', 'Prepare your team', "Préparez l'équipe"),
    text: P(L, 'امنح كل مندوب حساباً بصلاحيات محدّدة وحمّله التطبيق على جواله.',
      'Give each rep an account with defined permissions and install the app on their phone.',
      'Donnez à chaque commercial un compte avec des droits définis et installez l\'application.') },
  { name: P(L, 'ابدأ من الميدان', 'Start from the field', 'Démarrez sur le terrain'),
    text: P(L, `أصدِر أول فاتورة وسند قبض من ${c.cap.ar} أو أي مدينة تعمل بها.`,
      `Issue your first invoice and receipt from ${c.cap.en} or any city you cover.`,
      `Émettez votre première facture depuis ${c.cap.fr} ou toute ville couverte.`) },
  { name: P(L, 'راقب لحظياً', 'Monitor live', 'Suivez en direct'),
    text: P(L, 'تابع المبيعات والتحصيل ومخزون السيارة على لوحة تحكم واحدة.',
      'Track sales, collection and van stock on one dashboard.',
      'Suivez ventes, encaissement et stock sur un seul tableau de bord.') },
  { name: P(L, 'حسّن أسبوعياً', 'Improve weekly', 'Améliorez chaque semaine'),
    text: P(L, 'استخدم التقارير لضبط خطوط السير والأسعار والصلاحيات.',
      'Use reports to tune routes, prices and permissions.',
      'Utilisez les rapports pour ajuster tournées, prix et droits.') },
];

// ----------------------------------------------------------------------------
// بطاقة السوق — محتوى **مُفرَّد بالكامل** لكل سوق أولوية (لا قالب مبدَّل القيم).
// الغرض: كسر تشابه صفحات الأولوية (كان ~64٪ جُمل متطابقة بين الدول) كي يحترم
// جوجل الـcanonical الذاتيّ بدل دمجها في الركيزة. كل بطاقة مبنيّة على بيانات
// COUNTRIES المُتحقَّقة + فوارق تشغيلية حقيقية (خانات العملة، الجغرافيا، بنية
// التجزئة). ⚠️ بلا أي فعل «دعم/امتثال» قرب جهة ضريبية (حارس verify-claims).
// ----------------------------------------------------------------------------
const PRIORITY_BRIEF = {
  SA: {
    ar: `<h2>التوزيع في السوق السعودي — الأكبر خليجياً</h2>
     <p>السعودية أكبر أسواق التوزيع خليجياً مساحةً وسكاناً، وتجمع بين سلاسل التجزئة الحديثة والبقالات التقليدية في مدن متباعدة من الرياض إلى جدة والدمام. هذا الاتّساع يجعل تخطيط خطوط السير وتغطية المنافذ عاملاً حاسماً في كلفة التوزيع وزمن التوريد.</p>
     <p>ضريبة القيمة المضافة ١٥٪ — الأعلى خليجياً — تعني أن كل فاتورة ميدانية تُصدَر منظّمة برمز QR لا ورقة بخطّ اليد، والفوترة الإلكترونية «فاتورة» مطبّقة على مراحل. تُصدر منصّة FieldSales الفاتورة المنظّمة بالريال السعودي وتخصم المبيعة من مخزون السيارة لحظياً، فيبقى سجلّك جاهزاً للمراجعة من أوّل زيارة.</p>`,
    en: `<h2>Distribution in Saudi Arabia — the Gulf's largest market</h2>
     <p>Saudi Arabia is the Gulf's largest distribution market by area and population, mixing modern retail chains with traditional grocers across cities as far apart as Riyadh, Jeddah and Dammam. That spread makes route planning and outlet coverage decisive for distribution cost and lead time.</p>
     <p>VAT at 15% — the highest in the Gulf — means every field invoice is issued structured with a QR code rather than a handwritten slip, and ZATCA's Fatoora e-invoicing is being applied in phases. FieldSales issues the structured invoice in Saudi Riyal and deducts each sale from van stock in real time, keeping your records audit-ready from the first visit.</p>`,
    fr: `<h2>La distribution en Arabie saoudite — le plus grand marché du Golfe</h2>
     <p>L'Arabie saoudite est le plus grand marché de distribution du Golfe par sa superficie et sa population, mêlant chaînes modernes et épiceries traditionnelles dans des villes aussi éloignées que Riyad, Djeddah et Dammam. Cette étendue rend la planification des tournées décisive pour le coût de distribution.</p>
     <p>La TVA à 15 % — la plus élevée du Golfe — impose une facture structurée à code QR sur le terrain plutôt qu'un ticket manuscrit, et la facturation électronique Fatoora est déployée par phases. FieldSales émet la facture en riyal saoudien et déduit chaque vente du stock du véhicule en temps réel.</p>`,
  },
  AE: {
    ar: `<h2>التوزيع في الإمارات — أسواق متعدّدة بين البرّ والمناطق الحرّة</h2>
     <p>تتوزّع تجارة الجملة في الإمارات بين مناطق حرّة ومناطق برّية عبر سبع إمارات، ودبي مركز إعادة تصدير إقليمي. هذا التنوّع يعني قاعدة عملاء متعدّدة الجنسيات وأصنافاً واسعة، فتحتاج إدارة الأصناف وحدود الائتمان لكل عميل إلى نظام دقيق لا جداول متفرّقة.</p>
     <p>ضريبة القيمة المضافة ٥٪ تتولّاها الهيئة الاتحادية للضرائب، والفوترة الإلكترونية (Peppol) في مرحلة تطبيق مرحلي. تسجّل منصّة FieldSales كل بيع من الميدان بالدرهم الإماراتي مع فاتورة منظّمة برمز QR، وتتيح متابعة المخزون والتحصيل بين دبي وأبوظبي والشارقة على لوحة واحدة.</p>`,
    en: `<h2>Distribution in the UAE — multiple markets between mainland and free zones</h2>
     <p>Wholesale trade in the UAE spans free zones and mainland across seven emirates, with Dubai as a regional re-export hub. That diversity means a multinational customer base and a wide product range, so managing items and per-customer credit limits needs a precise system, not scattered spreadsheets.</p>
     <p>VAT at 5% is administered by the Federal Tax Authority, and Peppol-based e-invoicing is being phased in. FieldSales records every field sale in UAE Dirham with a structured QR invoice, and lets you track stock and collection across Dubai, Abu Dhabi and Sharjah on one dashboard.</p>`,
    fr: `<h2>La distribution aux Émirats — des marchés multiples entre continent et zones franches</h2>
     <p>Le commerce de gros aux Émirats se répartit entre zones franches et continent à travers sept émirats, Dubaï servant de plateforme de réexportation régionale. Cette diversité implique une clientèle multinationale et une large gamme de références, d'où le besoin d'un système précis.</p>
     <p>La TVA à 5 % est gérée par l'Autorité fédérale des impôts, et la facturation électronique (Peppol) est en cours de déploiement. FieldSales enregistre chaque vente en dirham des Émirats avec une facture structurée, et suit stock et encaissement entre Dubaï, Abou Dabi et Charjah.</p>`,
  },
  EG: {
    ar: `<h2>التوزيع في السوق المصري — تجزئة تقليدية واسعة ومجزّأة</h2>
     <p>يقوم التوزيع في مصر على شبكة ضخمة من منافذ التجزئة التقليدية الصغيرة الممتدّة من القاهرة إلى الإسكندرية والجيزة والصعيد، مع اعتماد كبير على البيع الآجل. هذا يجعل ضبط الذمم وأعمار الديون أهمّ من حجم المبيعة نفسها.</p>
     <p>ضريبة القيمة المضافة ١٤٪ تشرف عليها مصلحة الضرائب المصرية، والفاتورة والإيصال الإلكتروني إلزاميان تدريجياً. تُصدر منصّة FieldSales الفاتورة وسند القبض بالجنيه المصري من الميدان، وتعرض على المندوب رصيد العميل وأعمار ديونه قبل البيع، فيتحوّل التحصيل من تقدير إلى رقم.</p>`,
    en: `<h2>Distribution in Egypt — a vast, fragmented traditional retail market</h2>
     <p>Distribution in Egypt runs on a huge network of small traditional outlets stretching from Cairo to Alexandria, Giza and Upper Egypt, with heavy reliance on credit sales. That makes controlling receivables and debt ageing more important than the size of any single sale.</p>
     <p>VAT at 14% is overseen by the Egyptian Tax Authority, and e-invoice and e-receipt are being enforced gradually. FieldSales issues the invoice and receipt in Egyptian Pound from the field and shows the rep the customer's balance and debt ageing before selling — turning collection from a guess into a number.</p>`,
    fr: `<h2>La distribution en Égypte — un marché de détail traditionnel vaste et fragmenté</h2>
     <p>La distribution en Égypte repose sur un immense réseau de petits points de vente traditionnels, du Caire à Alexandrie, Gizeh et la Haute-Égypte, avec une forte dépendance à la vente à crédit. Contrôler les créances et leur ancienneté compte donc plus que la taille d'une vente.</p>
     <p>La TVA à 14 % est supervisée par l'Autorité fiscale égyptienne, et la facture et le reçu électroniques sont progressivement obligatoires. FieldSales émet la facture et le reçu en livre égyptienne depuis le terrain et affiche le solde du client avant la vente.</p>`,
  },
  KW: {
    ar: `<h2>التوزيع في السوق الكويتي — كثافة حضرية وقيمة عالية للزيارة</h2>
     <p>يتركّز التوزيع في الكويت في نطاق حضريّ مكتنز حول مدينة الكويت وحولي والأحمدي، مع قوّة شرائية مرتفعة وقيمة عالية لكل زيارة. قِصَر المسافات يجعل عدد الزيارات المنجزة يومياً — لا المسافة — مقياس كفاءة المندوب.</p>
     <p>لا تُطبَّق ضريبة قيمة مضافة بعد، فالفاتورة أبسط، لكن الدينار الكويتي يُحتسب بثلاث خانات عشرية (١٠٠٠ فلس)، فأي خطأ تقريب يتراكم عبر آلاف الفواتير. تحسب منصّة FieldSales المبالغ بدقّة ثلاث خانات وتطبع فاتورة منظّمة، وتضبط حدود الائتمان ومخزون السيارة لحظياً.</p>`,
    en: `<h2>Distribution in Kuwait — urban density and high value per visit</h2>
     <p>Distribution in Kuwait concentrates in a compact urban belt around Kuwait City, Hawalli and Ahmadi, with high purchasing power and high value per visit. Short distances make the number of visits completed per day — not mileage — the real measure of a rep's efficiency.</p>
     <p>No VAT applies yet, so the invoice is simpler, but the Kuwaiti Dinar is calculated to three decimal places (1000 fils), so any rounding error compounds across thousands of invoices. FieldSales computes amounts to three-decimal precision, prints a structured invoice, and enforces credit limits and van stock in real time.</p>`,
    fr: `<h2>La distribution au Koweït — densité urbaine et forte valeur par visite</h2>
     <p>La distribution au Koweït se concentre dans une ceinture urbaine compacte autour de Koweït, Hawalli et Ahmadi, avec un fort pouvoir d'achat. Les courtes distances font du nombre de visites réalisées par jour — et non du kilométrage — la vraie mesure d'efficacité.</p>
     <p>Aucune TVA ne s'applique encore, mais le dinar koweïtien se calcule à trois décimales (1000 fils) ; toute erreur d'arrondi s'accumule sur des milliers de factures. FieldSales calcule à trois décimales, imprime une facture structurée et applique limites de crédit et stock du véhicule.</p>`,
  },
  BH: {
    ar: `<h2>التوزيع في السوق البحريني — جزيرة مكتنزة وطرق سريعة</h2>
     <p>صِغَر مساحة البحرين يجعل خطوط السير قصيرة وسريعة بين المنامة والمحرّق والرفاع، فيغطّي المندوب منافذ أكثر في اليوم. التحدّي ليس المسافة بل كثافة الزيارات ودقّة الفوترة والتحصيل في كل منفذ.</p>
     <p>ضريبة القيمة المضافة ١٠٪ يتولّاها الجهاز الوطني للإيرادات، والدينار البحريني يُحتسب بثلاث خانات عشرية (١٠٠٠ فلس). تُصدر منصّة FieldSales فاتورة منظّمة بالدينار البحريني برمز QR وتقريب دقيق، وتُطابق مخزون السيارة آخر اليوم فيظهر أي عجز بالصنف.</p>`,
    en: `<h2>Distribution in Bahrain — a compact island with fast routes</h2>
     <p>Bahrain's small size keeps routes short and fast between Manama, Muharraq and Riffa, so a rep can cover more outlets per day. The challenge is not distance but visit density and the accuracy of invoicing and collection at each outlet.</p>
     <p>VAT at 10% is administered by the National Bureau for Revenue, and the Bahraini Dinar is calculated to three decimal places (1000 fils). FieldSales issues a structured Bahraini Dinar invoice with a QR code and precise rounding, and reconciles van stock at day's end so any shortage surfaces per item.</p>`,
    fr: `<h2>La distribution à Bahreïn — une île compacte aux tournées rapides</h2>
     <p>La petite taille de Bahreïn rend les tournées courtes et rapides entre Manama, Muharraq et Riffa ; un commercial couvre donc plus de points de vente par jour. L'enjeu n'est pas la distance mais la densité des visites et la précision de la facturation.</p>
     <p>La TVA à 10 % est gérée par le Bureau national des revenus, et le dinar bahreïni se calcule à trois décimales (1000 fils). FieldSales émet une facture structurée en dinar bahreïni à code QR avec un arrondi précis, et rapproche le stock du véhicule en fin de journée.</p>`,
  },
  OM: {
    ar: `<h2>التوزيع في السوق العُماني — مسافات طويلة وتخطيط خطوط سير</h2>
     <p>تمتدّ عُمان جغرافياً من مسقط شمالاً إلى صلالة جنوباً مروراً بصحار، فتصبح المسافات وتخطيط خطوط السير عاملاً رئيسياً في كلفة التوزيع وزمن التوريد. تغطية المنافذ البعيدة بكفاءة تحتاج جدولة زيارات مبنيّة على الموقع لا على التقدير.</p>
     <p>ضريبة القيمة المضافة ٥٪ يتولّاها جهاز الضرائب، والريال العُماني يُحتسب بثلاث خانات عشرية (١٠٠٠ بيسة). تسجّل منصّة FieldSales كل زيارة بموقعها ووقتها وتطبع فاتورة منظّمة بالريال العُماني، وتربط المبيعة بمخزون السيارة والتحصيل في خطّ سير واحد.</p>`,
    en: `<h2>Distribution in Oman — long distances and route planning</h2>
     <p>Oman stretches geographically from Muscat in the north to Salalah in the south via Sohar, making distances and route planning a primary factor in distribution cost and lead time. Covering distant outlets efficiently needs location-based visit scheduling, not guesswork.</p>
     <p>VAT at 5% is administered by the Oman Tax Authority, and the Omani Rial is calculated to three decimal places (1000 baisa). FieldSales records each visit with its location and time, prints a structured Omani Rial invoice, and ties the sale to van stock and collection on one route.</p>`,
    fr: `<h2>La distribution à Oman — longues distances et planification des tournées</h2>
     <p>Oman s'étend géographiquement de Mascate au nord à Salalah au sud via Sohar, faisant des distances et de la planification des tournées un facteur majeur de coût et de délai. Couvrir efficacement les points de vente éloignés exige une planification basée sur la localisation.</p>
     <p>La TVA à 5 % est gérée par l'Autorité fiscale omanaise, et le rial omanais se calcule à trois décimales (1000 baisas). FieldSales enregistre chaque visite avec sa localisation et son heure, imprime une facture structurée en rial omanais, et relie la vente au stock et à l'encaissement.</p>`,
  },
  QA: {
    ar: `<h2>التوزيع في السوق القطري — سوق مكتنز وقوّة شرائية مرتفعة</h2>
     <p>يتركّز التوزيع في قطر حول الدوحة والريان والوكرة في نطاق جغرافيّ مكتنز، مع قوّة شرائية مرتفعة وقيمة عالية لكل منفذ. قِصَر المسافات ينقل تركيز الكفاءة إلى جودة الزيارة ودقّة الفاتورة والتحصيل لا إلى المسافة المقطوعة.</p>
     <p>لا تُطبَّق ضريبة قيمة مضافة بعد، لكن يبقى إصدار فواتير منظّمة وكشوف حساب دقيقة بالريال القطري ضرورة إدارية لضبط الذمم. تُصدر منصّة FieldSales الفاتورة وسند القبض من الميدان، وتضبط حدود الائتمان ومخزون السيارة على لوحة واحدة لحظية.</p>`,
    en: `<h2>Distribution in Qatar — a compact market with high purchasing power</h2>
     <p>Distribution in Qatar concentrates around Doha, Al Rayyan and Al Wakrah in a compact geography, with high purchasing power and high value per outlet. Short distances shift the efficiency focus to visit quality and invoice and collection accuracy rather than mileage.</p>
     <p>No VAT applies yet, but issuing structured invoices and accurate statements in Qatari Riyal remains an operational necessity for controlling receivables. FieldSales issues the invoice and receipt from the field and manages credit limits and van stock on one live dashboard.</p>`,
    fr: `<h2>La distribution au Qatar — un marché compact à fort pouvoir d'achat</h2>
     <p>La distribution au Qatar se concentre autour de Doha, Al Rayyan et Al Wakrah dans une géographie compacte, avec un fort pouvoir d'achat et une valeur élevée par point de vente. Les courtes distances déplacent l'efficacité vers la qualité de la visite et la précision de la facturation.</p>
     <p>Aucune TVA ne s'applique encore, mais émettre des factures structurées et des relevés précis en riyal qatarien reste indispensable pour maîtriser les créances. FieldSales émet la facture et le reçu depuis le terrain et gère limites de crédit et stock sur un tableau de bord en direct.</p>`,
  },
};

// فقرة تشغيلية ثانية مُفرَّدة لكل سوق أولوية — زاوية مؤشّرات/كفاءة مختلفة عن البطاقة
// أعلاه، لزيادة المحتوى الفريد وخفض التطابق أكثر. تُلحَق بـmarketBrief.
const PRIORITY_OPS = {
  SA: {
    ar: `<p>عملياً، يقيس فريق التوزيع الكبير في السعودية نفسه بنسبة تغطية المنافذ المخطّطة أسبوعياً وبدقّة تحميل السيارة قبل الجولة. تربط منصّة FieldSales كل زيارة بخطّ سيرها، وتُظهر المنافذ غير المزارة، ونسبة الإنجاز لكل مندوب ومنطقة.</p>`,
    en: `<p>In practice, a large Saudi distribution team measures itself by weekly planned-outlet coverage and by van-loading accuracy before the route. FieldSales ties each visit to its route, surfaces unvisited outlets, and shows completion rate per rep and region.</p>`,
    fr: `<p>Concrètement, une grande équipe de distribution saoudienne se mesure au taux de couverture hebdomadaire des points de vente et à la précision du chargement avant la tournée. FieldSales relie chaque visite à sa tournée et fait apparaître les points non visités.</p>`,
  },
  AE: {
    ar: `<p>مع تنوّع القنوات بين البرّ والمناطق الحرّة، يصبح هامش الربح لكل قناة وصنف أهمّ من إجمالي المبيعات. تُظهر منصّة FieldSales المبيعات والتحصيل لكل عميل وصنف، وتضبط قوائم أسعار متعدّدة فلا يبيع المندوب بأقلّ من المعتمد.</p>`,
    en: `<p>With channels split between mainland and free zones, margin per channel and per item matters more than gross sales. FieldSales shows sales and collection per customer and item, and enforces multiple price lists so a rep cannot sell below the approved price.</p>`,
    fr: `<p>Avec des canaux répartis entre continent et zones franches, la marge par canal et par article compte plus que le chiffre brut. FieldSales affiche ventes et encaissement par client et article, et applique plusieurs listes de prix.</p>`,
  },
  EG: {
    ar: `<p>في سوق يغلب عليه البيع الآجل، المقياس الأهمّ هو معدّل التحصيل وعمر الدَّين لا حجم البيع. تقسّم منصّة FieldSales الذمم إلى شرائح عمرية (١–٣٠، ٣١–٦٠، ٦١–٩٠، وما فوق ٩٠ يوماً)، وتمنع البيع لعميل تجاوز حدّه الائتماني.</p>`,
    en: `<p>In a credit-driven market, the key metric is collection rate and debt age, not sale size. FieldSales splits receivables into ageing buckets (1–30, 31–60, 61–90, 90+ days) and blocks selling to a customer over their credit limit.</p>`,
    fr: `<p>Dans un marché à crédit, l'indicateur clé est le taux d'encaissement et l'ancienneté de la dette, pas la taille de la vente. FieldSales répartit les créances par tranches d'âge (1–30, 31–60, 61–90, plus de 90 jours).</p>`,
  },
  KW: {
    ar: `<p>حين تكون قيمة الزيارة عالية والمسافات قصيرة، يصبح عدد الزيارات المنجزة ومتوسّط قيمة الطلب مقياسَي الكفاءة. تعرض منصّة FieldSales زيارات كل مندوب يومياً ومتوسّط الطلب، وتربط الفاتورة بموقع العميل ووقتها.</p>`,
    en: `<p>When visit value is high and distances short, visits completed and average order value become the efficiency metrics. FieldSales shows each rep's daily visits and average order, and ties the invoice to the customer's location and time.</p>`,
    fr: `<p>Quand la valeur de la visite est élevée et les distances courtes, le nombre de visites et le panier moyen deviennent les indicateurs. FieldSales affiche les visites quotidiennes de chaque commercial et le panier moyen.</p>`,
  },
  BH: {
    ar: `<p>في سوق مكتنز، الكفاءة تُقاس بكثافة الزيارات اليومية ودقّة المطابقة آخر اليوم لا بالمسافة. تُطابق منصّة FieldSales مخزون السيارة مع المبيعات فيظهر أي فرق بالصنف، وتعرض إنجاز كل مندوب على لوحة واحدة.</p>`,
    en: `<p>In a compact market, efficiency is measured by daily visit density and end-of-day reconciliation accuracy, not distance. FieldSales reconciles van stock against sales so any per-item gap surfaces, and shows each rep's completion on one dashboard.</p>`,
    fr: `<p>Dans un marché compact, l'efficacité se mesure à la densité des visites et à la précision du rapprochement de fin de journée. FieldSales rapproche le stock du véhicule des ventes et fait apparaître tout écart par article.</p>`,
  },
  OM: {
    ar: `<p>مع طول المسافات، تصبح كلفة كل زيارة والالتزام بخطّ السير مقياسَي الكفاءة. تسجّل منصّة FieldSales خطّ السير الفعلي وتطابقه مع المخطّط، وتُظهر الزمن والمسافة لكل زيارة فتتّضح كلفة تغطية المناطق البعيدة.</p>`,
    en: `<p>With long distances, cost per visit and route adherence become the efficiency metrics. FieldSales records the actual route against the plan and shows time and distance per visit, so the cost of covering distant regions becomes clear.</p>`,
    fr: `<p>Avec de longues distances, le coût par visite et le respect de la tournée deviennent les indicateurs. FieldSales enregistre la tournée réelle par rapport au plan et affiche temps et distance par visite.</p>`,
  },
  QA: {
    ar: `<p>في سوق عالي القيمة ومكتنز، تُقاس الكفاءة بجودة الزيارة واكتمال الطلب لا بعددها فقط. تربط منصّة FieldSales كل فاتورة بموقعها ووقتها، وتعرض التحصيل وحدود الائتمان لكل عميل على لوحة لحظية.</p>`,
    en: `<p>In a compact, high-value market, efficiency is measured by visit quality and order completeness, not count alone. FieldSales ties each invoice to its location and time, and shows collection and credit limits per customer on a live dashboard.</p>`,
    fr: `<p>Dans un marché compact et à forte valeur, l'efficacité se mesure à la qualité de la visite et à la complétude de la commande. FieldSales relie chaque facture à son lieu et son heure, et affiche encaissement et limites de crédit par client.</p>`,
  },
};

// ----------------------------------------------------------------------------
// بُناة الأقسام — كلٌّ يُرجع HTML (عنوان + فقرات) مُوطَّناً ومُخصَّصاً للدولة.
// ----------------------------------------------------------------------------
const S = {
  // بطاقة السوق المُفرَّدة (أسواق الأولوية فقط) — تُرجع '' لغيرها فلا تُحقَن.
  marketBrief: (c, L) => {
    const b = PRIORITY_BRIEF[c.code], o = PRIORITY_OPS[c.code];
    return b ? P(L, b.ar, b.en, b.fr) + (o ? P(L, o.ar, o.en, o.fr) : '') : '';
  },

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
     <p><strong>نظام إدارة الموزّعين (DMS):</strong> منصّة موحّدة تدير طلبات وفواتير وتحصيل ومخزون الموزّع وكشوف حساب نقاط البيع في مكان واحد.
     <strong>التوزيع المباشر (DSD):</strong> تسليم البضاعة من الموزّع إلى نقطة البيع مباشرةً دون مستودع وسيط.
     <strong>البيع من السيارة (Van Sales):</strong> بيع وتسليم وفوترة فورية من مخزون سيارة المندوب.
     <strong>الذمم المدينة:</strong> المبالغ المستحقة على العملاء من المبيعات الآجلة.
     <strong>حدّ الائتمان:</strong> أقصى رصيد آجل مسموح للعميل قبل إيقاف البيع له.
     <strong>شرائح الأسعار:</strong> قوائم أسعار مختلفة (جملة/تجزئة/مفتاح) حسب فئة العميل.
     <strong>الفاتورة الضريبية المنظّمة:</strong> فاتورة بالحقول التي تعتمدها ${c.tax.ar} برمز QR قابل للتحقق.</p>`,
    `<h2>Essential field sales terms</h2>
     <p><strong>Distributor Management System (DMS):</strong> a unified platform that manages a distributor's orders, invoicing, collection, stock and retailer statements in one place.
     <strong>Direct Store Delivery (DSD):</strong> delivering goods from the distributor straight to the point of sale without an intermediate warehouse.
     <strong>Van Sales:</strong> selling, delivering and invoicing on the spot from the rep's van stock.
     <strong>Receivables:</strong> amounts customers owe from credit sales.
     <strong>Credit limit:</strong> the maximum outstanding balance allowed before sales to a customer are blocked.
     <strong>Price tiers:</strong> different price lists (wholesale/retail/key account) per customer segment.
     <strong>Structured tax invoice:</strong> an invoice with the fields required by ${c.tax.en}, carrying a verifiable QR code.</p>`,
    `<h2>Termes essentiels de la vente terrain</h2>
     <p><strong>Système de gestion des distributeurs (DMS) :</strong> une plateforme unifiée qui gère commandes, facturation, encaissement, stock et relevés des points de vente en un seul endroit.
     <strong>Distribution directe (DSD) :</strong> livraison du distributeur au point de vente sans entrepôt intermédiaire.
     <strong>Van Sales :</strong> vente, livraison et facturation immédiates depuis le stock du véhicule.
     <strong>Créances :</strong> montants dus par les clients sur les ventes à crédit.
     <strong>Limite de crédit :</strong> encours maximal autorisé avant blocage des ventes au client.
     <strong>Grilles tarifaires :</strong> listes de prix différentes (gros/détail/grands comptes) par segment.
     <strong>Facture structurée :</strong> facture aux champs exigés par ${c.tax.fr}, avec un code QR vérifiable.</p>`),

  // قسم مُفرَّد لكل دولة: يحوّل البيانات التنظيمية الحقيقية (الجهة الضريبية/الفوترة/العملة/المدن + خانات العملة)
  // إلى فقرات تختلف فعلاً بين الدول — يكسر تكرار القالب ويمنح جوجل محتوى محلياً أصيلاً.
  localContext: (c, L) => {
    const dec3 = ['KW', 'BH', 'OM', 'TN', 'JO', 'LY'].includes(c.code);
    const cities = P(L,
      [c.cap.ar, ...c.cities.map((x) => x.ar)],
      [c.cap.en, ...c.cities.map((x) => x.en)],
      [c.cap.fr, ...c.cities.map((x) => x.fr)]);
    const cityJoin = L === 'ar' ? cities.join(' و') : cities.join(', ');
    const dAr = dec3 ? ` وتُحتسب ${c.cur.ar} بثلاث خانات عشرية، فيجب أن يراعي نظامك التقريب الصحيح في كل فاتورة وكشف حساب.` : '';
    const dEn = dec3 ? ` The ${c.cur.en} uses three decimal places, so your system must handle rounding correctly on every invoice and statement.` : '';
    const dFr = dec3 ? ` Le ${c.cur.fr} utilise trois décimales ; votre système doit donc gérer correctement les arrondis.` : '';
    if (c.vat != null) {
      return P(L,
        `<h2>البيئة التنظيمية للتوزيع ${c.inAr}</h2>
     <p>تعمل شركات التوزيع ${c.inAr} ضمن إطار ${c.tax.ar}: تبلغ ضريبة القيمة المضافة نحو ${c.vat}٪، و${c.einv.ar}. عملياً يعني ذلك أن كل فاتورة تصدر من الميدان يجب أن تكون منظّمة وقابلة للتحقق — لا ورقة مكتوبة بخط اليد.${dAr}</p>
     <p>تصدر منصّة FieldSales فاتورة منظّمة برمز QR وطباعة حرارية بعملة ${c.cur.ar}، وتضبط التحصيل وكشوف الحساب وحدود الائتمان — سواء عمل فريقك في ${cityJoin} أو المدن الأصغر. هكذا يلتزم مندوبك بمتطلبات ${c.tax.ar} من أوّل زيارة، ويبقى سجلّك جاهزاً للمراجعة.</p>`,
        `<h2>The regulatory environment for distribution ${c.inEn}</h2>
     <p>Distributors ${c.inEn} operate under ${c.tax.en}: value added tax is around ${c.vat}%, and ${c.einv.en}. In practice, every invoice issued from the field must be structured and verifiable — not a handwritten note.${dEn}</p>
     <p>FieldSales issues a structured invoice with a QR code and thermal printing in ${c.cur.en}, and manages collection, statements and credit limits — whether your team covers ${cityJoin} or smaller towns. Your reps stay aligned with ${c.tax.en} from the first visit, and your records stay audit-ready.</p>`,
        `<h2>L'environnement réglementaire de la distribution ${c.inFr}</h2>
     <p>Les distributeurs ${c.inFr} opèrent sous ${c.tax.fr} : la TVA est d'environ ${c.vat} %, et ${c.einv.fr}. Concrètement, chaque facture émise sur le terrain doit être structurée et vérifiable — pas une note manuscrite.${dFr}</p>
     <p>FieldSales émet une facture structurée à code QR et impression thermique en ${c.cur.fr}, et gère l'encaissement, les relevés et les limites de crédit — que votre équipe couvre ${cityJoin} ou de plus petites villes.</p>`);
    }
    return P(L,
      `<h2>البيئة التنظيمية للتوزيع ${c.inAr}</h2>
     <p>${c.einv.ar} ${c.inAr}، وتشرف ${c.tax.ar} على الجوانب الضريبية. ومع غياب ضريبة قيمة مضافة عامة، يبقى إصدار فواتير منظّمة وكشوف حساب دقيقة ضرورة إدارية ورقابية لكل موزّع يريد ضبط ذممه وحماية هوامشه.${dAr}</p>
     <p>تصدر منصّة FieldSales فاتورة منظّمة برمز QR بعملة ${c.cur.ar}، وتضبط التحصيل وحدود الائتمان ومخزون السيارة — سواء عمل فريقك في ${cityJoin} أو المدن الأصغر — فتبقى بياناتك دقيقة وقراراتك مبنيّة على أرقام لحظية.</p>`,
      `<h2>The regulatory environment for distribution ${c.inEn}</h2>
     <p>${c.einv.en} ${c.inEn}, with ${c.tax.en} overseeing tax matters. With no general VAT in place, issuing structured invoices and accurate statements is still an operational necessity for any distributor that wants to control receivables and protect margins.${dEn}</p>
     <p>FieldSales issues a structured invoice with a QR code in ${c.cur.en}, and manages collection, credit limits and van stock — whether your team covers ${cityJoin} or smaller towns — keeping your data accurate and your decisions based on live numbers.</p>`,
      `<h2>L'environnement réglementaire de la distribution ${c.inFr}</h2>
     <p>${c.einv.fr} ${c.inFr}, ${c.tax.fr} supervisant les questions fiscales. En l'absence de TVA générale, émettre des factures structurées et des relevés précis reste indispensable pour tout distributeur.${dFr}</p>
     <p>FieldSales émet une facture structurée à code QR en ${c.cur.fr}, et gère l'encaissement, les limites de crédit et le stock du véhicule — que votre équipe couvre ${cityJoin} ou de plus petites villes.</p>`);
  },

  // جدول مقارنة الدول — محتوى حصريّ للصفحة الجامعة، مبنيّ على بيانات COUNTRIES الحقيقية
  // (ضريبة، جهة، فوترة، عملة). هذا ما يجعلها صفحة واحدة قويّة بدل 22 نسخة متشابهة.
  countryTable: (_c, L) => {
    const head = P(L,
      ['الدولة', 'ضريبة القيمة المضافة', 'الجهة الضريبية', 'الفوترة الإلكترونية', 'العملة'],
      ['Country', 'VAT', 'Tax authority', 'E-invoicing', 'Currency'],
      ['Pays', 'TVA', 'Autorité fiscale', 'Facturation électronique', 'Devise']);
    const rows = COUNTRIES.map((k) => {
      const vat = k.vat != null ? `${k.vat}%` : P(L, 'لا تُطبَّق', 'None', 'Aucune');
      return `<tr><td><strong>${k[L]}</strong></td><td>${vat}</td><td>${k.tax[L]}</td><td>${k.einv[L]}</td><td>${k.cur[L]}</td></tr>`;
    }).join('');
    const title = P(L, 'مقارنة الضريبة والفوترة الإلكترونية في الدول العربية',
      'VAT & e-invoicing across Arab countries — compared',
      'TVA et facturation électronique dans les pays arabes');
    const intro = P(L,
      'تختلف نسبة الضريبة والجهة المشرفة ومتطلبات الفوترة الإلكترونية من دولة إلى أخرى، وهذا الجدول يلخّصها لتعرف ما ينطبق على سوقك قبل اختيار النظام:',
      'VAT rates, supervising authorities and e-invoicing requirements differ by country. This table summarizes them so you know what applies to your market before choosing a system:',
      "Les taux de TVA, les autorités et les exigences de facturation électronique diffèrent selon le pays. Ce tableau les résume :");
    const note = P(L,
      'النِّسب والمتطلبات إرشادية وتتغيّر بقرارات محلية — راجعها مع مستشار ضريبي في بلدك قبل الاعتماد عليها.',
      'Rates and requirements are indicative and change by local decree — confirm them with a local tax advisor before relying on them.',
      'Les taux et exigences sont indicatifs et évoluent — confirmez-les auprès d’un conseiller fiscal local.');
    return `<h2>${title}</h2>\n<p>${intro}</p>\n<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>\n<p><em>${note}</em></p>`;
  },

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
// كتل الإجابة المباشرة (GEO) — أوّل ما يقرؤه محرّك التوليد في كل مقال.
//
// لماذا في الأعلى وقائمة بذاتها: محرّكات الإجابة (ChatGPT/Perplexity/AI
// Overviews) تقتبس فقرة تُجيب السؤال كاملاً **دون سياق ما قبلها**. فقرة تبدأ
// بـ«في هذا الدليل سنشرح…» غير قابلة للاقتباس مهما كان ما بعدها جيّداً.
//
// قواعد الكتابة الملزِمة لكل نصّ هنا:
//   ١) الجملة الأولى تعريفية أو إجابة صريحة — لا تمهيد ولا إحالة للمقال.
//   ٢) تفاصيل قابلة للتحقّق (خطوات الدورة، آليّة العمل) لا أوصاف تسويقية.
//   ٣) ٤٠–٩٠ كلمة: أقصر من ذلك لا يكفي للاقتباس، وأطول يُقصّ في منتصفه.
//   ٤) لا رقم مُخترَع ولا ادّعاء امتثال — حارس verify-claims يفحص المخرجات.
// ----------------------------------------------------------------------------
const ANSWERS = {
  /* ---------- موضوعات خاصة بكل دولة ---------- */
  'field-sales-software': (c, L) => P(L,
    `برنامج إدارة المبيعات الميدانية نظام يدير دورة بيع المندوب كاملةً من جواله: زيارة العميل، إصدار الفاتورة وطباعتها فوراً، تحصيل النقد أو الآجل، وخصم المبيعة من مخزون سيارته لحظياً. الفارق عن برامج المحاسبة العامّة أن المدخلات تُسجَّل في الميدان لا في المكتب، فتصل الإدارة بيانات المبيعة والتحصيل والموقع في وقتها. ${topicVat(c, L)}`,
    `Field sales management software runs the rep's entire selling cycle from a phone: visiting the customer, issuing and printing an invoice on the spot, collecting cash or recording credit, and deducting the sale from van stock in real time. Unlike general accounting software, data is captured in the field rather than re-keyed at the office, so management sees sales, collection and location as they happen. ${topicVat(c, L)}`,
    `Un logiciel de gestion des ventes terrain exécute tout le cycle du commercial depuis son téléphone : visite du client, émission et impression immédiate de la facture, encaissement comptant ou à crédit, et déduction en temps réel du stock du véhicule. Contrairement à un logiciel comptable généraliste, les données sont saisies sur le terrain, pas ressaisies au bureau. ${topicVat(c, L)}`),

  'distribution-management-system': (c, L) => P(L,
    `نظام إدارة الموزّعين (DMS) يربط المستودع بسيارات المناديب بنقاط البيع في سلسلة واحدة: يُحمَّل المخزون على السيارة، يبيع المندوب منه ويصدر الفاتورة، ويعود آخر اليوم فيُطابَق المتبقّي مع المتوقّع فيظهر أي عجز بالصنف. يختلف عن نظام ERP في أنه مبنيّ حول خطّ السير والزيارة لا حول أمر الشراء، وعن تطبيق CRM في أنه يحرّك مخزوناً ونقداً فعليّين.`,
    `A distributor management system (DMS) connects warehouse, van and outlet in one chain: stock is loaded onto the van, the rep sells from it and issues the invoice, and at day's end the remaining stock is reconciled against what was expected so any shortage surfaces per item. It differs from ERP in being built around the route and the visit rather than the purchase order, and from CRM in that it moves real stock and real cash.`,
    `Un système de gestion des distributeurs (DMS) relie l'entrepôt, le camion et le point de vente en une seule chaîne : le stock est chargé, le commercial vend et facture, puis en fin de journée le reliquat est rapproché de l'attendu et tout écart apparaît par article. Il se distingue de l'ERP en s'articulant autour de la tournée et de la visite plutôt que du bon de commande.`),

  'van-sales-app': (c, L) => P(L,
    `تطبيق البيع من السيارة (Van Sales) يجعل سيارة المندوب مستودعاً متنقّلاً ونقطة بيع في آن: المندوب يعرض ما بحوزته فعلاً، يبيع، يطبع الفاتورة من طابعة حرارية بجانبه، ويُخصم الصنف من رصيد سيارته مباشرة. الفرق الجوهري عن نموذج البيع المسبق (Pre-Sales) أن التسليم والفوترة والتحصيل تتمّ في الزيارة نفسها، فلا توجد فجوة بين الطلب والتوريد يضيع فيها المخزون أو يتغيّر فيها الطلب.`,
    `A van sales app turns the rep's vehicle into both a mobile warehouse and a point of sale: the rep sees exactly what is on board, sells it, prints the invoice from a thermal printer on the spot, and the item is deducted from the van's balance immediately. The key difference from pre-sales is that delivery, invoicing and collection all happen inside the same visit, leaving no gap between order and fulfilment where stock goes missing or the order changes.`,
    `Une application de vente en camion transforme le véhicule du commercial en entrepôt mobile et en point de vente : il voit exactement ce qu'il transporte, vend, imprime la facture sur une imprimante thermique, et l'article est déduit immédiatement du solde du véhicule. La différence essentielle avec la prévente : livraison, facturation et encaissement se font dans la même visite.`),

  'einvoicing-compliance': (c, L) => P(L,
    `الفوترة الإلكترونية تعني إصدار الفاتورة بصيغة رقمية منظَّمة تقرأها الأنظمة لا الإنسان وحده، بدل ورقة مكتوبة يدوياً. عملياً على المندوب: تحمل الفاتورة بيانات البائع والمشتري والتاريخ والمبلغ والضريبة في رمز QR مقروء آلياً، وتُخزَّن نسخة منها لا تُعدَّل بأثر رجعي. السياق الضريبي ${c.inAr}: ${c.einv.ar}. وراجع دائماً متطلبات ${c.tax.ar} السارية قبل اعتماد أي إعداد.`,
    `E-invoicing means issuing the invoice in a structured digital format that systems can read, rather than a hand-written slip. In practice for the rep: the invoice carries seller, buyer, date, amount and tax in a machine-readable QR code, and a copy is stored that cannot be edited retroactively. Tax context ${c.inEn}: ${c.einv.en}. Always check the current requirements of ${c.tax.en} before settling on a configuration.`,
    `La facturation électronique consiste à émettre la facture dans un format numérique structuré, lisible par les systèmes, plutôt qu'un ticket manuscrit. Concrètement pour le commercial : la facture porte vendeur, acheteur, date, montant et taxe dans un code QR lisible par machine, et une copie non modifiable est conservée. Contexte fiscal ${c.inFr} : ${c.einv.fr}. Vérifiez toujours les exigences en vigueur de ${c.tax.fr}.`),

  'sales-rep-management': (c, L) => P(L,
    `إدارة مناديب المبيعات تقوم على ثلاثة أشياء يمكن قياسها لا الانطباع: ماذا باع كل مندوب، وكم حصّل من ذممه، وأين كان خلال يوم العمل. النظام يمنح كل مندوب صلاحيات محدّدة — أي عملاء يراهم، وهل يبيع بأقلّ من سعر القائمة، وهل يبيع لعميل تجاوز حدّ ائتمانه — فيتحوّل الضبط من متابعة شخصية إلى قاعدة تُطبَّق تلقائياً على كل فاتورة.`,
    `Managing sales reps rests on three measurable things rather than impressions: what each rep sold, how much they collected against receivables, and where they were during the working day. The system gives each rep explicit permissions — which customers they see, whether they may sell below list price, whether they may sell to a customer over their credit limit — turning control from personal supervision into a rule applied automatically to every invoice.`,
    `La gestion des commerciaux repose sur trois éléments mesurables plutôt que sur des impressions : ce que chacun a vendu, ce qu'il a encaissé sur les créances, et où il se trouvait pendant la journée. Le système attribue des droits explicites — quels clients il voit, s'il peut vendre sous le prix catalogue, s'il peut vendre à un client au-delà de sa limite de crédit.`),

  'collection-receivables': (c, L) => P(L,
    `التحصيل في التوزيع يفشل غالباً لسبب واحد: لا أحد يعرف الرصيد الحقيقي للعميل لحظة الزيارة. الحلّ أن يرى المندوب على جواله — قبل أن يبيع — رصيد العميل وأعمار ديونه وحدّ ائتمانه، وأن يُصدر سند القبض في مكانه فيُخصم من الرصيد فوراً. عمليّاً تُقسَّم الذمم إلى شرائح (١–٣٠، ٣١–٦٠، ٦١–٩٠، أكثر من ٩٠ يوماً) لأن دَيناً عمره أربعة أشهر يحتاج تدخّلاً مختلفاً عن دَين هذا الأسبوع.`,
    `Collection in distribution usually fails for one reason: nobody knows the customer's true balance at the moment of the visit. The fix is for the rep to see — before selling — the balance, the ageing of the debt and the credit limit on their phone, and to issue the receipt on the spot so the balance drops immediately. In practice receivables are split into buckets (1–30, 31–60, 61–90, 90+ days) because a four-month-old debt needs a different intervention from this week's.`,
    `L'encaissement en distribution échoue souvent pour une seule raison : personne ne connaît le solde réel du client au moment de la visite. La solution : que le commercial voie sur son téléphone — avant de vendre — le solde, l'ancienneté de la créance et la limite de crédit, et qu'il émette le reçu sur place. Les créances se répartissent en tranches (1–30, 31–60, 61–90, plus de 90 jours).`),

  'gps-rep-tracking': (c, L) => P(L,
    `تتبّع المناديب عبر GPS ليس مراقبة شخصية بل ربط كل فاتورة بمكانها ووقتها. الفائدة التشغيلية الحقيقية ثلاثة أسئلة يجيب عنها: هل زار المندوب المنافذ المخطّطة أم بعضها فقط، وكم استغرقت الزيارة فعلاً، وهل صدرت الفاتورة من موقع العميل أم من مكان آخر. تُسجَّل النقاط على خطّ سير يُطابَق مع الطرق الفعلية، فتظهر المسافة والزمن بدل التقدير.`,
    `GPS rep tracking is not personal surveillance; it ties each invoice to a place and a time. Its real operational value is three questions it answers: did the rep visit the planned outlets or only some, how long did the visit actually take, and was the invoice issued at the customer's location or somewhere else. Points are recorded as a route matched to real roads, so distance and time are measured rather than estimated.`,
    `Le suivi GPS des commerciaux n'est pas une surveillance personnelle : il rattache chaque facture à un lieu et une heure. Sa valeur opérationnelle tient à trois questions : le commercial a-t-il visité les points de vente prévus, combien de temps a duré la visite, et la facture a-t-elle été émise chez le client. Les points forment une tournée alignée sur les routes réelles.`),

  'van-stock-inventory': (c, L) => P(L,
    `مخزون سيارة المندوب يُضبَط بمعادلة اتزان واحدة: المتوقّع آخر اليوم = رصيد أول اليوم + المُحمَّل − المُباع + المرتجع − التالف. يُقارَن الناتج بالجرد الفعلي، والفرق هو العجز أو الزيادة بالصنف والقيمة. أهمية الحساب اليومي أن الفروقات الصغيرة تتراكم صامتةً حين تُجرَد السيارة شهرياً، فيصبح تحديد أين ومتى حدث الفاقد مستحيلاً.`,
    `Van stock is controlled by a single balance equation: expected at day's end = opening balance + loaded − sold + returned − damaged. The result is compared with the physical count, and the gap is the shortage or surplus, per item and in value. Daily reconciliation matters because small variances accumulate silently when the van is counted only monthly, making it impossible to locate where and when the loss occurred.`,
    `Le stock du véhicule se contrôle par une équation d'équilibre : attendu en fin de journée = solde d'ouverture + chargé − vendu + retourné − endommagé. Le résultat est comparé à l'inventaire physique, et l'écart constitue le manquant ou l'excédent, par article et en valeur. Un rapprochement quotidien évite l'accumulation silencieuse des écarts.`),

  'sales-reports-analytics': (c, L) => P(L,
    `تقارير المبيعات الميدانية المفيدة تجيب عن قرار، لا تعرض أرقاماً. أربعة تقارير تكفي معظم شركات التوزيع: مبيعات كل مندوب مقابل هدفه، التحصيل مقابل المستحقّ، الأصناف الراكدة في السيارات، والعملاء الذين لم تصلهم زيارة منذ مدّة. الشرط أن تُبنى على بيانات مُلتقَطة لحظة الحدث في الميدان — تقرير مبنيّ على إدخال مكتبي بعد يومين يقيس ذاكرة المُدخِل لا الواقع.`,
    `Useful field sales reports answer a decision rather than display numbers. Four reports cover most distributors: sales per rep against target, collection against what is due, slow-moving items sitting in vans, and customers not visited for a while. The condition is that they are built on data captured at the moment of the event in the field — a report built on office data entry two days later measures the typist's memory, not reality.`,
    `Des rapports de vente terrain utiles répondent à une décision plutôt qu'ils n'affichent des chiffres. Quatre suffisent à la plupart des distributeurs : ventes par commercial contre objectif, encaissement contre échu, articles dormants dans les véhicules, et clients non visités depuis un certain temps. Encore faut-il qu'ils reposent sur des données saisies sur le terrain, au moment de l'événement.`),

  'wholesale-food-distributors': (c, L) => P(L,
    `توزيع المواد الغذائية يفرض قيداً لا تعرفه القطاعات الأخرى: للصنف تاريخ صلاحية، فترتيب الصرف يجب أن يتبع الأقدم-أولاً وإلا تحوّل المخزون إلى خسارة مؤكّدة. عمليّاً يعني ذلك تتبّع الصنف بتشغيلته لا بكمّيته فقط، ومعرفة ما في كل سيارة الآن، وقبول المرتجعات بسبب واضح يُميّز التالف عن غير المطلوب — لأن أحدهما مشكلة تخزين والآخر مشكلة طلب.`,
    `Food distribution imposes a constraint other sectors do not have: items expire, so issuing must follow oldest-first or stock becomes guaranteed loss. In practice this means tracking items by batch and not only by quantity, knowing what is on each van right now, and accepting returns with an explicit reason that separates damaged from unwanted — because one is a storage problem and the other is a demand problem.`,
    `La distribution alimentaire impose une contrainte propre : les produits périment, la sortie doit donc suivre le premier-périmé-premier-sorti sous peine de perte certaine. Concrètement : suivre les articles par lot et pas seulement en quantité, savoir ce que transporte chaque véhicule, et accepter les retours avec un motif explicite distinguant l'endommagé du non désiré.`),

  'fmcg-distribution': (c, L) => P(L,
    `توزيع السلع سريعة الدوران (FMCG) يُدار بالتكرار لا بحجم الصفقة: منافذ كثيرة، فواتير صغيرة، وزيارات متقاربة. ما يحسم الربحية ليس هامش الصنف بل تكلفة الزيارة الواحدة — عدد المنافذ التي يغطّيها المندوب يومياً، ونسبة الزيارات التي تنتهي بطلب فعلي. لذلك تُقاس هذه العمليات بمؤشّرَي التغطية والزيارة المنتجة قبل أي مؤشّر مالي آخر.`,
    `FMCG distribution is run on frequency rather than deal size: many outlets, small invoices, close visit intervals. Profitability is decided not by item margin but by the cost of a single visit — how many outlets a rep covers per day, and the share of visits that end in an actual order. That is why these operations are measured on coverage and productive-visit rate before any other financial indicator.`,
    `La distribution FMCG se pilote par la fréquence plutôt que par la taille des affaires : beaucoup de points de vente, de petites factures, des visites rapprochées. La rentabilité se joue sur le coût d'une visite — combien de points de vente un commercial couvre par jour, et la part des visites débouchant sur une commande réelle.`),

  'mobile-field-invoicing': (c, L) => P(L,
    `الفوترة من جوال المندوب تعني إصدار الفاتورة وطباعتها أمام العميل في الزيارة نفسها، بطابعة حرارية بلوتوث بعرض ٥٨ أو ٨٠ ملّيمتراً. الأثر التشغيلي ليس الطباعة بل التزامن: الفاتورة تُسجَّل باسم العميل، ويُخصم الصنف من السيارة، ويتحدّث الرصيد — في اللحظة ذاتها. والشرط العملي أن يعمل ذلك بلا إنترنت، لأن كثيراً من المنافذ داخل مبانٍ لا تصلها شبكة مستقرّة.`,
    `Mobile field invoicing means issuing and printing the invoice in front of the customer during the visit, on a 58mm or 80mm Bluetooth thermal printer. The operational effect is not the printing but the simultaneity: the invoice is booked to the customer, the item is deducted from the van, and the balance updates — at the same moment. The practical requirement is that it works offline, because many outlets sit inside buildings with no stable signal.`,
    `La facturation mobile consiste à émettre et imprimer la facture devant le client pendant la visite, sur une imprimante thermique Bluetooth 58 ou 80 mm. L'effet opérationnel n'est pas l'impression mais la simultanéité : la facture est imputée au client, l'article déduit du véhicule et le solde mis à jour au même instant. Encore faut-il que cela fonctionne hors ligne.`),

  'distribution-customer-management': (c, L) => P(L,
    `إدارة عملاء التوزيع تختلف عن CRM المبيعات في أن العميل هنا رصيد مستمرّ لا صفقة تُغلَق. كل عميل يحمل: قائمة أسعار خاصّة به (جملة أو تجزئة أو شريحة كمّية)، وحدّ ائتمان يمنع البيع فوقه، ومدّة سداد متّفقاً عليها يُقاس التأخير بها. حدّ الائتمان المعقول يُشتقّ من الواقع لا من التقدير: متوسط مشتريات العميل الشهرية مضروباً في مدّة السداد مقسومة على ثلاثين.`,
    `Managing distribution customers differs from sales CRM in that the customer here is a running balance, not a deal to close. Each customer carries a price list of their own (wholesale, retail or quantity tier), a credit limit that blocks selling above it, and an agreed payment term against which lateness is measured. A sensible credit limit is derived from reality rather than guessed: the customer's average monthly purchases multiplied by the payment term divided by thirty.`,
    `La gestion des clients en distribution diffère d'un CRM de vente : le client est ici un solde courant, pas une affaire à conclure. Chaque client porte sa propre liste de prix (gros, détail ou palier de quantité), une limite de crédit qui bloque la vente au-delà, et un délai de paiement convenu. Une limite raisonnable se déduit du réel : achats mensuels moyens × délai ÷ trente.`),

  'best-field-sales-software': (c, L) => P(L,
    `لا يوجد «أفضل نظام» مطلق — يوجد أنسب نظام لحجمك وقطاعك. اختبر أي مرشّح على خمسة محاور قابلة للفحص قبل الالتزام: هل يُغطّي الدورة كاملةً (طلب ← فاتورة ← تحصيل ← مخزون سيارة)، هل يعمل بلا إنترنت، هل الواجهة والمستندات بالعربية فعلاً لا مترجمة آلياً، هل يتوافق مع متطلبات ${c.tax.ar}، وهل السعر معلن. الاختبار الحاسم واحد: نفّذ دورة بيع حقيقية كاملة على النظام قبل الشراء.`,
    `There is no absolute "best system" — there is the system that fits your size and sector. Test any candidate on five checkable axes before committing: does it cover the full cycle (order → invoice → collection → van stock), does it work offline, is the interface and are the documents genuinely in Arabic rather than machine-translated, does it meet the requirements of ${c.tax.en}, and is the price published. The decisive test is one thing: run a complete real sales cycle on it before buying.`,
    `Il n'existe pas de « meilleur système » absolu — il existe celui qui convient à votre taille et à votre secteur. Évaluez tout candidat sur cinq axes vérifiables : couvre-t-il le cycle complet (commande → facture → encaissement → stock), fonctionne-t-il hors ligne, l'interface est-elle réellement en arabe, répond-il aux exigences de ${c.tax.fr}, et le prix est-il publié. Le test décisif : réaliser un cycle de vente réel complet avant d'acheter.`),

  /* ---------- موضوعات عامة ---------- */
  'what-is-field-sales-management': (c, L) => P(L,
    `نظام إدارة المبيعات الميدانية برنامج يُدير عمل الفريق خارج المكتب: المندوب في الشارع، والعميل في محلّه، والبضاعة في السيارة. يفعل ثلاثة أشياء لا يفعلها برنامج المحاسبة: يلتقط البيانات لحظة حدوثها في الميدان، ويعمل بلا إنترنت ثم يزامن، ويربط كل فاتورة بمن أصدرها وأين ومتى. من لا يملكه يجمع دفاتر المناديب آخر اليوم ويُدخلها يدوياً — فيعرف ما حدث بعد يوم أو يومين لا الآن.`,
    `Field sales management software runs the work that happens outside the office: the rep on the street, the customer in their shop, the goods in the van. It does three things accounting software does not: it captures data at the moment it happens in the field, it works offline then syncs, and it ties every invoice to who issued it, where and when. Without it, companies collect rep notebooks at day's end and re-key them — learning what happened a day or two later rather than now.`,
    `Un logiciel de gestion des ventes terrain pilote le travail qui se déroule hors du bureau : le commercial dans la rue, le client dans sa boutique, la marchandise dans le camion. Il fait trois choses qu'un logiciel comptable ne fait pas : capter la donnée au moment de l'événement, fonctionner hors ligne puis synchroniser, et rattacher chaque facture à son émetteur, son lieu et son heure.`),

  'retail-execution': (c, L) => P(L,
    `التنفيذ في نقاط البيع (Retail Execution) هو التأكّد من أن ما اتُّفق عليه مع المنفذ حدث فعلاً على الرفّ: الصنف موجود، السعر صحيح، والعرض الترويجي مطبَّق. يُقاس بالدليل لا بالتقرير الشفهي — صورة ملتقَطة في الزيارة، موقعها وتوقيتها مسجَّلان. الفجوة التي يعالجها هذا المفهوم معروفة في التوزيع: اتفاق تجاري سليم على الورق لا ينفَّذ في المنفذ، ولا أحد يكتشف ذلك إلا بعد انتهاء الحملة.`,
    `Retail execution is verifying that what was agreed with the outlet actually happened on the shelf: the item is present, the price is right, the promotion is applied. It is measured by evidence rather than a verbal report — a photo taken during the visit, with its location and timestamp recorded. The gap it addresses is familiar in distribution: a sound commercial agreement on paper that is never executed in the outlet, discovered only after the campaign ends.`,
    `L'exécution retail consiste à vérifier que ce qui a été convenu avec le point de vente s'est réellement produit en rayon : article présent, prix correct, promotion appliquée. Elle se mesure par la preuve plutôt que par un rapport verbal — une photo prise pendant la visite, horodatée et localisée. Elle comble un écart classique : un accord commercial valable sur le papier mais jamais exécuté en magasin.`),

  'how-to-choose-field-sales-system': (c, L) => P(L,
    `اختيار نظام مبيعات ميدانية يُحسَم بخمسة أسئلة لا بقائمة ميزات: هل يُغطّي دورتك كاملةً أم يترك حلقة تُدار يدوياً، هل يعمل بلا إنترنت، هل الواجهة والفواتير بالعربية أصلاً، هل يتوافق مع متطلبات الفوترة في بلدك، وهل السعر معلن أم «تواصل معنا». وقبل التوقيع، شغّل دورة بيع حقيقية واحدة من الطلب إلى التحصيل — معظم ما يفشل بعد الشراء يظهر في هذه الدورة الواحدة.`,
    `Choosing a field sales system is settled by five questions rather than a feature list: does it cover your whole cycle or leave a link handled manually, does it work offline, are the interface and invoices natively in your language, does it meet your country's invoicing requirements, and is the price published or "contact us". Before signing, run one real sales cycle from order to collection — most of what fails after purchase shows up in that single cycle.`,
    `Le choix d'un système de vente terrain se règle par cinq questions plutôt que par une liste de fonctionnalités : couvre-t-il tout votre cycle, fonctionne-t-il hors ligne, l'interface et les factures sont-elles nativement dans votre langue, répond-il aux exigences de facturation de votre pays, et le prix est-il publié. Avant de signer, exécutez un cycle de vente réel de la commande à l'encaissement.`),

  'van-sales-best-practices': (c, L) => P(L,
    `أفضل ممارسات البيع من السيارة تدور حول ضبط ثلاثة أشياء يومياً: تحميل السيارة بناءً على مبيعات الخطّ فعلياً لا على تقدير المندوب، إصدار الفاتورة في الزيارة لا تجميعها آخر اليوم، وجرد السيارة عند العودة بمطابقة المتبقّي مع المتوقّع. الخطأ الأكثر كلفةً هو تأجيل الجرد إلى نهاية الشهر: عندها يظهر العجز مجمّعاً بلا وسيلة لمعرفة أين ومتى حدث.`,
    `Van sales best practice comes down to controlling three things daily: loading the van from the route's actual sales rather than the rep's estimate, issuing the invoice during the visit rather than batching at day's end, and counting the van on return by reconciling remaining against expected. The costliest mistake is deferring the count to month-end: the shortage then appears as one aggregate figure with no way to know where or when it occurred.`,
    `Les bonnes pratiques de la vente en camion tiennent à trois contrôles quotidiens : charger le véhicule d'après les ventes réelles de la tournée et non l'estimation du commercial, facturer pendant la visite plutôt qu'en fin de journée, et inventorier au retour en rapprochant le reliquat de l'attendu. L'erreur la plus coûteuse est de reporter l'inventaire à la fin du mois.`),

  'reduce-overdue-receivables': (c, L) => P(L,
    `الذمم المتعثّرة تُعالَج بالمنع لا بالملاحقة. ثلاثة إجراءات تُحدث الفرق: حدّ ائتمان مُفعَّل يمنع البيع فوقه بدل تنبيه يُتجاهَل، عرض رصيد العميل وأعمار ديونه على شاشة المندوب قبل أن يبيع، وسند قبض يُصدَر في الزيارة فيُخصم فوراً. أما التصنيف بشرائح ١–٣٠ و٣١–٦٠ و٦١–٩٠ وأكثر، فوظيفته ترتيب الأولوية: الدين الأقدم أقلّ احتمالاً للتحصيل وأولى بالتدخّل.`,
    `Overdue receivables are solved by prevention, not pursuit. Three measures make the difference: an enforced credit limit that blocks the sale rather than an alert that gets ignored, showing the customer's balance and debt ageing on the rep's screen before they sell, and issuing the receipt during the visit so the balance drops immediately. Bucketing into 1–30, 31–60, 61–90 and 90+ days exists to rank priority: older debt is less likely to be recovered and deserves intervention first.`,
    `Les impayés se traitent par la prévention, pas par la poursuite. Trois mesures font la différence : une limite de crédit qui bloque réellement la vente plutôt qu'une alerte ignorée, l'affichage du solde et de l'ancienneté de la dette sur l'écran du commercial avant qu'il ne vende, et l'émission du reçu pendant la visite. Les tranches 1–30, 31–60, 61–90 et plus servent à hiérarchiser.`),

  'increase-rep-productivity': (c, L) => P(L,
    `إنتاجية المندوب الميداني تُقاس بالزيارة المنتجة لا بعدد الزيارات: كم زيارة انتهت بطلب فعلي. رفعها يبدأ بإزالة ما يستهلك وقته دون بيع — كتابة الفواتير يدوياً، الاتصال بالمكتب للسؤال عن رصيد عميل أو توفّر صنف، وإعادة الإدخال آخر اليوم. حين تتمّ هذه الثلاثة على جواله في ثوانٍ، يتحوّل الوقت المستردّ إلى منافذ إضافية في اليوم نفسه.`,
    `Field rep productivity is measured by productive visits rather than visit count: how many visits ended in an actual order. Raising it starts by removing what consumes time without selling — writing invoices by hand, calling the office to ask about a customer's balance or an item's availability, and re-keying everything at day's end. When those three happen on the phone in seconds, the recovered time converts into additional outlets on the same day.`,
    `La productivité d'un commercial terrain se mesure aux visites productives plutôt qu'au nombre de visites : combien se sont conclues par une commande réelle. L'améliorer commence par supprimer ce qui consomme du temps sans vendre — rédiger les factures à la main, appeler le bureau pour un solde ou une disponibilité, et tout ressaisir en fin de journée.`),

  'field-sales-kpis': (c, L) => P(L,
    `ستّة مؤشّرات تكفي لقيادة فريق ميداني: نسبة التغطية (المنافذ المزارة ÷ المخطّطة)، الزيارة المنتجة (الزيارات المنتهية بطلب ÷ الزيارات)، متوسط قيمة الفاتورة، نسبة التحصيل إلى المستحقّ، عمر الدين المتوسط، ونسبة العجز في مخزون السيارة. ما يجعل هذه المؤشرات صالحة ليس تعريفها بل مصدرها: إن كانت مبنيّة على إدخال مكتبي مؤجَّل فهي تقيس الإدخال، وإن كانت مُلتقَطة في الميدان لحظة الحدث فهي تقيس العمل.`,
    `Six indicators are enough to run a field team: coverage rate (outlets visited ÷ planned), productive visit rate (visits ending in an order ÷ visits), average invoice value, collection against amount due, average debt age, and van stock shortage rate. What makes these valid is not their definition but their source: built on deferred office entry they measure the data entry; captured in the field at the moment of the event they measure the work.`,
    `Six indicateurs suffisent à piloter une équipe terrain : taux de couverture (points visités ÷ prévus), visites productives (visites avec commande ÷ visites), valeur moyenne de la facture, encaissement rapporté à l'échu, âge moyen de la créance, et taux d'écart sur le stock du véhicule. Leur validité tient à leur source : saisis sur le terrain, ils mesurent le travail.`),

  'offline-field-sales-app': (c, L) => P(L,
    `العمل بلا إنترنت ليس ميزة كمالية في المبيعات الميدانية بل شرط تشغيلي: كثير من المنافذ داخل أسواق ومبانٍ لا تصلها شبكة مستقرّة، والمندوب لا يستطيع تأجيل البيع حتى تعود التغطية. التطبيق الصحيح يُصدر الفاتورة ويطبعها ويُنقص المخزون محلياً على الجهاز، ثم يرفعها عند عودة الاتصال بمعرّف فريد لكل عملية يمنع تكرارها إن أُعيد الإرسال — وهذا المعرّف، لا المزامنة نفسها، هو ما يمنع الفواتير المكرّرة.`,
    `Offline operation is not a nice-to-have in field sales but an operational requirement: many outlets sit inside markets and buildings with no stable signal, and the rep cannot postpone the sale until coverage returns. A correct app issues and prints the invoice and decrements stock locally on the device, then uploads it when connectivity returns with a unique identifier per operation that prevents duplication on retry — and that identifier, not the sync itself, is what stops duplicate invoices.`,
    `Le mode hors ligne n'est pas un confort en vente terrain mais une exigence opérationnelle : beaucoup de points de vente se trouvent dans des marchés et des bâtiments sans signal stable. Une application correcte émet et imprime la facture et décrémente le stock localement, puis l'envoie au retour du réseau avec un identifiant unique par opération qui empêche les doublons.`),

  'thermal-printing-invoices': (c, L) => P(L,
    `الطباعة الحرارية في الميدان تعتمد طابعة بلوتوث محمولة بعرض ٥٨ أو ٨٠ ملّيمتراً تطبع بالحرارة على ورق حسّاس بلا حبر. ما يهمّ عمليّاً ثلاثة: أن يُطبَع النصّ العربي بشكل صحيح لا معكوساً أو متقطّعاً، أن يكون رمز QR واضحاً بما يكفي ليُقرأ من الجوال، وأن تعمل الطباعة بلا إنترنت لأن الطابعة متّصلة بالجهاز مباشرة. ورق ٨٠ ملّيمتراً أوضح للفواتير متعدّدة الأصناف، و٥٨ أخفّ حملاً.`,
    `Field thermal printing uses a portable 58mm or 80mm Bluetooth printer that prints by heat on sensitive paper with no ink. Three things matter in practice: that Arabic text prints correctly rather than reversed or broken, that the QR code is crisp enough to be read from a phone, and that printing works offline since the printer is paired directly to the device. 80mm paper is clearer for multi-line invoices; 58mm is lighter to carry.`,
    `L'impression thermique sur le terrain utilise une imprimante Bluetooth portable de 58 ou 80 mm qui imprime par la chaleur, sans encre. Trois points comptent : que le texte arabe s'imprime correctement, que le code QR soit assez net pour être lu depuis un téléphone, et que l'impression fonctionne hors ligne puisque l'imprimante est appairée directement à l'appareil.`),

  'credit-limit-control': (c, L) => P(L,
    `حدّ الائتمان يعمل فعلاً حين يمنع الفاتورة، لا حين ينبّه بعدها. الفرق جوهري: التنبيه يُتجاهَل تحت ضغط البيع، أما المنع فيحوّل القرار من المندوب إلى سياسة الشركة، ويجعل تجاوزه استثناءً موثّقاً بموافقة لا حدثاً صامتاً. تحديد الحدّ نفسه يُشتقّ من الواقع: متوسط مشتريات العميل الشهرية × (مدّة السداد ÷ ٣٠)، ثم يُراجَع دورياً مع تغيّر سلوك السداد.`,
    `A credit limit works when it blocks the invoice, not when it warns after the fact. The difference is structural: a warning is ignored under selling pressure, whereas a block moves the decision from the rep to company policy and turns an override into a documented, approved exception rather than a silent event. The limit itself is derived from reality: the customer's average monthly purchases × (payment term ÷ 30), reviewed periodically as payment behaviour changes.`,
    `Une limite de crédit fonctionne lorsqu'elle bloque la facture, pas lorsqu'elle avertit après coup. La différence est structurelle : un avertissement est ignoré sous la pression commerciale, alors qu'un blocage déplace la décision du commercial vers la politique de l'entreprise. La limite se déduit du réel : achats mensuels moyens × (délai de paiement ÷ 30).`),

  'pricing-tiers-strategy': (c, L) => P(L,
    `شرائح الأسعار في التوزيع تُبنى على واحد من ثلاثة أسس: نوع العميل (جملة أو نصف جملة أو تجزئة)، أو الكمّية المشتراة، أو اتفاق خاصّ بعميل بعينه. الشرط التقني الذي يجعلها تعمل هو أن يُطبَّق السعر تلقائياً حين يختار المندوب العميل والصنف — لا أن يتذكّره أو يحسبه. أي سعر يُدخَل يدوياً في الميدان يصبح مصدر خلاف مع العميل ونزيف هامش لا يظهر إلا في تقرير آخر الشهر.`,
    `Price tiers in distribution rest on one of three bases: customer type (wholesale, semi-wholesale, retail), purchased quantity, or an agreement specific to one customer. The technical condition that makes them work is that the price applies automatically once the rep selects the customer and the item — not that the rep remembers or calculates it. Any price typed by hand in the field becomes a dispute with the customer and a margin leak that only surfaces in month-end reporting.`,
    `Les grilles tarifaires en distribution reposent sur l'une de trois bases : le type de client (gros, demi-gros, détail), la quantité achetée, ou un accord propre à un client. La condition technique : que le prix s'applique automatiquement dès que le commercial choisit le client et l'article. Tout prix saisi à la main devient un litige et une fuite de marge.`),

  'digital-transformation-distribution': (c, L) => P(L,
    `التحوّل الرقمي في شركات التوزيع لا يبدأ بالنظام بل بتحديد الحلقة التي تُدار على الورق وتكلّف أكثر: عادةً الفاتورة المكتوبة يدوياً، أو مخزون السيارة المجهول حتى نهاية الشهر، أو رصيد العميل الذي لا يعرفه إلا المحاسب. الترتيب العملي أن تُرقمَن حلقة واحدة حتى تستقرّ، ثم التالية — لأن تحويل كل شيء دفعة واحدة يخلق مقاومة من المناديب وفوضى بيانات في الشهر الأول.`,
    `Digital transformation in distribution does not start with the system but with identifying which link is run on paper and costs the most: usually the hand-written invoice, or van stock that stays unknown until month-end, or the customer balance only the accountant knows. The practical order is to digitise one link until it settles, then the next — converting everything at once creates rep resistance and data chaos in the first month.`,
    `La transformation digitale en distribution ne commence pas par le système mais par l'identification du maillon géré sur papier et le plus coûteux : souvent la facture manuscrite, le stock du véhicule inconnu jusqu'à la fin du mois, ou le solde client que seul le comptable connaît. L'ordre pratique : numériser un maillon jusqu'à stabilisation, puis le suivant.`),

  'route-planning-sales': (c, L) => P(L,
    `تخطيط خطّ السير يعني تثبيت أي منفذ يُزار في أي يوم وبأيّ تكرار، بدل ترك الترتيب لاجتهاد المندوب اليومي. الفائدة ليست تقصير المسافة وحدها بل انتظام التغطية: العميل الذي يُزار في موعد ثابت يُجهّز طلبه، والعميل المنسيّ يظهر في تقرير «لم تصله زيارة منذ». المقارنة بين الخطّ المخطّط والمسار الفعلي المسجَّل بـGPS هي ما يحوّل الخطّة من ورقة إلى أداة.`,
    `Route planning means fixing which outlet is visited on which day and at what frequency, instead of leaving the order to the rep's daily judgement. The benefit is not only shorter distance but regular coverage: a customer visited on a fixed schedule prepares their order, and a forgotten customer surfaces in a "not visited since" report. Comparing the planned route against the actual GPS-recorded path is what turns the plan from a document into a tool.`,
    `La planification des tournées consiste à fixer quel point de vente est visité quel jour et à quelle fréquence, plutôt que de laisser l'ordre au jugement quotidien du commercial. Le bénéfice n'est pas seulement la distance : un client visité à échéance fixe prépare sa commande, et un client oublié apparaît dans un rapport « non visité depuis ».`),

  'whatsapp-sales-followup': (c, L) => P(L,
    `واتساب هو قناة التواصل الفعلية بين موزّعي المنطقة وعملائهم، لكنه يفشل كأداة إدارة لسبب واحد: الرسالة لا تُسجَّل في حساب العميل. الاستخدام السليم أن يبقى واتساب قناة التنبيه — تأكيد طلب، تذكير باستحقاق، إرسال كشف حساب — بينما يبقى مصدر الحقيقة هو النظام. ما يُتّفق عليه في محادثة ولا يُسجَّل كطلب أو سند لا وجود له عند المراجعة بعد شهر.`,
    `WhatsApp is the real communication channel between distributors in the region and their customers, but it fails as a management tool for one reason: the message is never recorded against the customer's account. The sound use is to keep WhatsApp as the notification channel — confirming an order, reminding of a due amount, sending a statement — while the system remains the source of truth. Whatever is agreed in a chat and not recorded as an order or receipt does not exist when reviewed a month later.`,
    `WhatsApp est le canal réel entre les distributeurs de la région et leurs clients, mais échoue comme outil de gestion pour une raison : le message n'est jamais enregistré sur le compte du client. Le bon usage : garder WhatsApp comme canal de notification — confirmation de commande, rappel d'échéance, envoi de relevé — tandis que le système reste la source de vérité.`),

  'field-sales-system-roi': (c, L) => P(L,
    `عائد نظام المبيعات الميدانية يُحسَب من أربعة بنود قابلة للقياس في شركتك أنت، لا من متوسط سوقي: الوقت المستردّ من الفوترة والإدخال اليدوي، العجز المكتشَف في مخزون السيارات، الذمم المُستردّة بفضل ضبط حدود الائتمان، والمنافذ الإضافية التي يغطّيها المندوب بعد اختصار الأعمال الورقية. الطريقة الصحيحة أن تُدخل أرقامك الفعلية في كل بند وتقارنها بالتكلفة السنوية — ولا تقبل رقم عائد جاهزاً من أي مورّد.`,
    `The return on a field sales system is computed from four items measurable inside your own company, not from a market average: time recovered from manual invoicing and data entry, shortages discovered in van stock, receivables recovered thanks to enforced credit limits, and additional outlets a rep covers once paperwork is cut. The correct method is to enter your own actual figures for each item and compare against the annual cost — and to accept no ready-made ROI number from any vendor.`,
    `Le retour d'un système de vente terrain se calcule à partir de quatre postes mesurables dans votre propre entreprise, non d'une moyenne de marché : le temps récupéré sur la facturation manuelle, les écarts découverts sur le stock des véhicules, les créances récupérées grâce aux limites de crédit, et les points de vente supplémentaires couverts. Entrez vos chiffres réels et comparez au coût annuel.`),
};

// ملاحظة الضريبة تُلحَق بإجابات الموضوعات التي تمسّ الفوترة — تُصاغ من بيانات
// الدولة نفسها فلا تُكرَّر حرفياً عبر ٢٢ دولة، ولا تحمل ادّعاء امتثال.
function topicVat(c, L) {
  if (!c.vat) return P(L,
    `تختلف متطلبات الفوترة بين الدول، فتحقّق من الساري لدى ${c.tax.ar} قبل اعتماد أي إعداد.`,
    `Invoicing requirements differ by country, so check what currently applies with ${c.tax.en} before settling on a configuration.`,
    `Les exigences de facturation varient selon les pays ; vérifiez ce qui s'applique auprès de ${c.tax.fr}.`);
  return P(L,
    `وتُحتسب ضريبة القيمة المضافة ${c.inAr} بنسبة ${c.vat}% وتظهر مفصّلة في الفاتورة، مع مراجعة الساري لدى ${c.tax.ar}.`,
    `VAT ${c.inEn} is charged at ${c.vat}% and shown as a separate line on the invoice; check current rules with ${c.tax.en}.`,
    `La TVA ${c.inFr} s'élève à ${c.vat}% et figure en ligne distincte sur la facture ; vérifiez les règles en vigueur auprès de ${c.tax.fr}.`);
}

// تثبيت محلّي يُلحَق بإجابة كل موضوع خاصّ بالدول. الغرض ليس التزيين: بدونه
// تحمل مقالات الدول الاثنتين والعشرين الإجابة ذاتها حرفياً، فتصير حشواً
// مكرّراً يُضعف الصفحة بدل أن يقوّيها. كل جملة هنا تضيف واقعة محلّية فعلية
// (العملة، المدن، الجهة الضريبية) لا صفة عامّة.
const LOCAL_ANCHOR = {
  'field-sales-software': (c, L) => P(L,
    `وتُدار بهذا الشكل ${c.inAr} خطوط سير تربط بين ${c.cap.ar} و${c.cities[0].ar}، وتُسجَّل المبالغ بـ${c.cur.ar}.`,
    `Run this way ${c.inEn}, routes link ${c.cap.en} with ${c.cities[0].en}, and amounts are recorded in ${c.cur.en}.`,
    `Ainsi organisées ${c.inFr}, les tournées relient ${c.cap.fr} à ${c.cities[0].fr}, et les montants sont enregistrés en ${c.cur.fr}.`),
  'best-field-sales-software': (c, L) => P(L,
    `ونفّذها على بيانات حقيقية من خطّ سير فعلي ${c.inAr} وبالمبالغ بـ${c.cur.ar}، لا على بيانات عرض جاهزة.`,
    `Run it on real data from an actual route ${c.inEn}, with amounts in ${c.cur.en}, not on a prepared demo dataset.`,
    `Faites-le sur des données réelles d'une tournée effective ${c.inFr}, avec des montants en ${c.cur.fr}, et non sur un jeu de démonstration.`),
  'distribution-management-system': (c, L) => P(L,
    `والتطبيق العملي ${c.inAr} يعني أن تصدر الفواتير وكشوف الحساب بـ${c.cur.ar}، وأن يغطّي خطّ السير الواحد منافذ متباعدة بين ${c.cap.ar} و${c.cities[0].ar}.`,
    `In practice ${c.inEn}, invoices and statements are issued in ${c.cur.en}, and a single route often spans outlets scattered between ${c.cap.en} and ${c.cities[0].en}.`,
    `En pratique ${c.inFr}, les factures et relevés sont émis en ${c.cur.fr}, et une seule tournée couvre souvent des points de vente dispersés entre ${c.cap.fr} et ${c.cities[0].fr}.`),
  'van-sales-app': (c, L) => P(L,
    `ويُستخدم هذا النموذج ${c.inAr} لتغطية المنافذ الصغيرة المتناثرة في ${c.cap.ar} و${c.cities[0].ar}، حيث الطلب يومي والكمّيات صغيرة فلا تحتمل دورة طلب وتوريد منفصلة.`,
    `This model is used ${c.inEn} to cover small outlets scattered across ${c.cap.en} and ${c.cities[0].en}, where demand is daily and quantities small — too small to justify a separate order-then-deliver cycle.`,
    `Ce modèle est utilisé ${c.inFr} pour couvrir les petits points de vente dispersés entre ${c.cap.fr} et ${c.cities[0].fr}, où la demande est quotidienne et les quantités faibles.`),
  'sales-rep-management': (c, L) => P(L,
    `ويُقاس أداء المندوب ${c.inAr} بمبيعاته وتحصيله بـ${c.cur.ar} مقابل هدف معلن، لا بعدد الساعات التي قضاها في الشارع.`,
    `Rep performance ${c.inEn} is measured by sales and collection in ${c.cur.en} against a stated target, not by hours spent on the road.`,
    `La performance du commercial ${c.inFr} se mesure aux ventes et encaissements en ${c.cur.fr} face à un objectif annoncé, non aux heures passées sur la route.`),
  'collection-receivables': (c, L) => P(L,
    `وتُحسب الأرصدة ${c.inAr} بـ${c.cur.ar} ضمن مدّة السداد المتّفق عليها مع كل عميل على حدة، لا بمدّة موحّدة للجميع.`,
    `Balances ${c.inEn} are tracked in ${c.cur.en} against the payment term agreed with each customer individually, not a single term applied to all.`,
    `Les soldes ${c.inFr} sont suivis en ${c.cur.fr} selon le délai convenu avec chaque client, et non un délai unique pour tous.`),
  'gps-rep-tracking': (c, L) => P(L,
    `وفي مدن مثل ${c.cap.ar} و${c.cities[0].ar} حيث يلتهم الزحام ساعات اليوم، يكشف الفصل بين زمن التنقّل وزمن الزيارة أين يذهب الوقت فعلاً.`,
    `In cities such as ${c.cap.en} and ${c.cities[0].en}, where traffic consumes hours of the day, separating travel time from visit time reveals where the day actually goes.`,
    `Dans des villes comme ${c.cap.fr} et ${c.cities[0].fr}, où les embouteillages dévorent des heures, séparer le temps de trajet du temps de visite révèle où passe réellement la journée.`),
  'van-stock-inventory': (c, L) => P(L,
    `وتُقوَّم الفروقات بـ${c.cur.ar} لتصير رقماً يُقارَن بتكلفة الضبط اليومي، فيُتّخذ القرار على أساس مقارنة لا انطباع.`,
    `Variances are valued in ${c.cur.en} so they become a figure comparable against the cost of daily control, turning the decision into a comparison rather than an impression.`,
    `Les écarts sont valorisés en ${c.cur.fr} afin de devenir un montant comparable au coût du contrôle quotidien.`),
  'sales-reports-analytics': (c, L) => P(L,
    `وتُعرض المبالغ ${c.inAr} بـ${c.cur.ar} حتى تُقارَن الفترات مباشرةً بلا تحويل يدوي يُدخل الخطأ.`,
    `Amounts ${c.inEn} are presented in ${c.cur.en} so periods compare directly, without a manual conversion step that introduces error.`,
    `Les montants ${c.inFr} sont présentés en ${c.cur.fr} afin de comparer les périodes directement, sans conversion manuelle source d'erreurs.`),
  'wholesale-food-distributors': (c, L) => P(L,
    `و${c.inAr} يشتدّ أثر ذلك في المواسم التي يقفز فيها الطلب فجأةً فتُحمَّل السيارات فوق المعتاد ويصعب تتبّع ما خرج منها.`,
    `This bites hardest ${c.inEn} in seasons when demand jumps suddenly, vans are loaded beyond the norm and tracking what left them becomes hard.`,
    `L'effet est maximal ${c.inFr} lors des saisons où la demande bondit, les véhicules étant chargés au-delà de la normale.`),
  'fmcg-distribution': (c, L) => P(L,
    `وتتركّز هذه المنافذ ${c.inAr} في ${c.cap.ar} و${c.cities[0].ar}، فيصير تخطيط خطّ السير هو ما يحدّد كم منفذاً يمكن تغطيته في اليوم الواحد.`,
    `These outlets cluster ${c.inEn} around ${c.cap.en} and ${c.cities[0].en}, so route planning is what determines how many can be covered in a single day.`,
    `Ces points de vente se concentrent ${c.inFr} autour de ${c.cap.fr} et ${c.cities[0].fr} ; la planification de la tournée détermine donc combien peuvent être couverts en une journée.`),
  'mobile-field-invoicing': (c, L) => P(L,
    `وتُصدَر الفاتورة ${c.inAr} بـ${c.cur.ar} وفق ما يسري لدى ${c.tax.ar} وقت الإصدار.`,
    `The invoice ${c.inEn} is issued in ${c.cur.en} according to what applies at ${c.tax.en} at the time of issue.`,
    `La facture ${c.inFr} est émise en ${c.cur.fr} selon ce qui s'applique auprès de ${c.tax.fr} au moment de l'émission.`),
  'distribution-customer-management': (c, L) => P(L,
    `وتُحدَّد الحدود ${c.inAr} بـ${c.cur.ar}، وتُراجَع دورياً مع تغيّر سلوك السداد لكل عميل بدل تثبيتها مرّة واحدة.`,
    `Limits ${c.inEn} are set in ${c.cur.en} and revisited periodically as each customer's payment behaviour changes, rather than fixed once.`,
    `Les limites ${c.inFr} sont fixées en ${c.cur.fr} et révisées périodiquement selon l'évolution du comportement de paiement de chaque client.`),
};

// يبني كتلة الإجابة. تسبق المقدّمة في contentHtml — الترتيب هو الغرض كلّه.
const answerBlock = (topic, c, L) => {
  const fn = ANSWERS[topic.id];
  if (!fn) return '';
  const head = P(L, 'الإجابة المختصرة', 'The short answer', 'La réponse courte');
  const local = LOCAL_ANCHOR[topic.id];
  const body = local ? `${fn(c, L)} ${local(c, L)}` : fn(c, L);
  return `<div class="geo-answer">
     <h2>${head}</h2>
     <p>${body}</p>
   </div>`;
};

// ----------------------------------------------------------------------------
// تعريف الموضوعات — قوالب العناوين/الكلمات المفتاحية + تركيبة الأقسام لكل موضوع.
// cs=true: مقال خاص بكل دولة. cs=false: مقال عام (يستخدم REGION).
// ----------------------------------------------------------------------------
const svc = (adAr, adEn, adFr) => ({ ar: adAr, en: adEn, fr: adFr });

const TOPICS = [
  // ---------- موضوعات خاصة بكل دولة (13) ----------
  { id: 'field-sales-software', cs: true, rm: 7,
    label: svc('برنامج إدارة مناديب المبيعات الميدانية', 'Field Sales Management Software', 'Logiciel de gestion des ventes terrain'),
    kw: (c, L) => P(L, `برنامج مبيعات ميدانية ${c.ar}, نظام إدارة مناديب ${c.ar}, برنامج توزيع, فاتورة ضريبية, تحصيل`, `field sales software ${c.en}, sales rep management ${c.en}, distribution software, tax invoice, collection`, `logiciel de vente terrain ${c.fr}, gestion des commerciaux ${c.fr}, distribution, facturation`),
    secs: ['why', 'invoice', 'tax', 'collect', 'features', 'howstart', 'cta'] },
  { id: 'distribution-management-system', cs: true, rm: 7,
    // «Distributor Management System Software» = الصيغة الصاعدة +140% في مؤشرات Google — مطابقة تامّة في العنوان/H1.
    label: svc('نظام إدارة الموزّعين وشركات التوزيع والجملة (DMS)', 'Distributor Management System (DMS) Software', 'Logiciel de gestion des distributeurs (DMS)'),
    kw: (c, L) => P(L, `نظام إدارة الموزّعين ${c.ar}, نظام توزيع ${c.ar}, برنامج شركات الجملة ${c.ar}, مخزون, كشوف حساب`, `distributor management system software ${c.en}, distributor management system ${c.en}, DMS software ${c.en}, distribution management system ${c.en}, wholesale software ${c.en}`, `logiciel de gestion des distributeurs ${c.fr}, DMS ${c.fr}, logiciel de gros ${c.fr}`),
    secs: ['why', 'vanstock', 'crm', 'reports', 'collect', 'cta'] },
  { id: 'van-sales-app', cs: true, rm: 6,
    // ⚠️ «البيع من السيارة» يُرجع 10/10 مواقع سيارات مستعملة (قياس SERP مصر والخليج) — انقلاب نيّة تامّ.
    // المصطلح العامل هو المنقول «كاش فان» + «مناديب التوزيع» (يعمل في مصر أيضاً).
    label: svc('تطبيق كاش فان لمناديب التوزيع (Van Sales)', 'Van Sales App', 'Application de vente en camion (Van Sales)'),
    kw: (c, L) => P(L, `تطبيق فان سيلز ${c.ar}, البيع من السيارة ${c.ar}, مخزون سيارة المندوب, توزيع متنقل`, `van sales app ${c.en}, mobile selling ${c.en}, van stock, mobile distribution`, `application van sales ${c.fr}, vente en camion ${c.fr}, stock véhicule`),
    secs: ['why', 'vanstock', 'invoice', 'gps', 'offline', 'cta'] },
  { id: 'einvoicing-compliance', cs: true, rm: 6,
    label: svc('الفوترة الإلكترونية والالتزام الضريبي', 'E-Invoicing & Tax Compliance', 'Facturation électronique et conformité'),
    kw: (c, L) => P(L, `الفوترة الإلكترونية ${c.ar}, فاتورة ضريبية ${c.ar}, ضريبة القيمة المضافة, ${c.tax.ar}`, `e-invoicing ${c.en}, tax invoice ${c.en}, VAT, ${c.tax.en}`, `facturation électronique ${c.fr}, TVA ${c.fr}, ${c.tax.fr}`),
    secs: ['tax', 'invoice', 'features', 'faq', 'cta'] },
  { id: 'sales-rep-management', cs: true, rm: 6,
    label: svc('برنامج متابعة المناديب والتحصيل', 'Sales Rep Management', 'Gestion des commerciaux'),
    kw: (c, L) => P(L, `إدارة مناديب ${c.ar}, صلاحيات المندوب, متابعة أداء المندوبين ${c.ar}, تحصيل`, `sales rep management ${c.en}, rep permissions, rep performance ${c.en}`, `gestion des commerciaux ${c.fr}, droits, performance ${c.fr}`),
    secs: ['reps', 'gps', 'reports', 'collect', 'cta'] },
  { id: 'collection-receivables', cs: true, rm: 6,
    label: svc('برنامج تحصيل المناديب والذمم والمديونيات', 'Collection & Receivables', 'Encaissement et créances'),
    kw: (c, L) => P(L, `تحصيل ${c.ar}, إدارة الذمم ${c.ar}, كشف حساب العميل, حد ائتمان, ديون متعثرة`, `collection ${c.en}, receivables ${c.en}, customer statement, credit limit`, `encaissement ${c.fr}, créances ${c.fr}, relevé client, limite de crédit`),
    secs: ['collect', 'crm', 'reports', 'roi', 'cta'] },
  { id: 'gps-rep-tracking', cs: true, rm: 5,
    label: svc('برنامج متابعة وتتبّع المناديب GPS وخط السير', 'GPS Rep Tracking', 'Suivi GPS des commerciaux'),
    kw: (c, L) => P(L, `تتبع المناديب ${c.ar}, GPS مندوب, خطوط سير, تغطية مناطق ${c.ar}`, `rep tracking ${c.en}, GPS sales, route planning ${c.en}`, `suivi commerciaux ${c.fr}, GPS, tournées ${c.fr}`),
    secs: ['gps', 'reps', 'reports', 'cta'] },
  { id: 'van-stock-inventory', cs: true, rm: 5,
    label: svc('جرد عهدة المندوب وبضاعة سيارة التوزيع', 'Van Stock & Inventory', 'Stock du véhicule et inventaire'),
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
    label: svc('برنامج مناديب توزيع FMCG والمواد الغذائية', 'FMCG Distribution', 'Distribution de produits de grande consommation (FMCG)'),
    kw: (c, L) => P(L, `توزيع FMCG ${c.ar}, سلع استهلاكية ${c.ar}, مناديب توزيع, مخزون سيارة`, `FMCG distribution ${c.en}, consumer goods ${c.en}, van sales`, `distribution FMCG ${c.fr}, biens de consommation ${c.fr}`),
    secs: ['why', 'gps', 'vanstock', 'reports', 'cta'] },
  { id: 'mobile-field-invoicing', cs: true, rm: 5,
    label: svc('تطبيق فواتير المناديب من الجوال', 'Mobile Field Invoicing', 'Facturation mobile sur le terrain'),
    kw: (c, L) => P(L, `فوترة من الجوال ${c.ar}, طباعة حرارية, فاتورة QR ${c.ar}, تطبيق مندوب`, `mobile invoicing ${c.en}, thermal printing, QR invoice ${c.en}`, `facturation mobile ${c.fr}, impression thermique, facture QR`),
    secs: ['invoice', 'tax', 'offline', 'howstart', 'cta'] },
  { id: 'distribution-customer-management', cs: true, rm: 5,
    label: svc('إدارة عملاء التوزيع وحدود الائتمان', 'Distribution Customer & Credit Management', 'Gestion des clients et du crédit'),
    kw: (c, L) => P(L, `إدارة عملاء ${c.ar}, حدود ائتمان ${c.ar}, كشوف حساب, شرائح أسعار`, `customer management ${c.en}, credit limits ${c.en}, statements, price tiers`, `gestion des clients ${c.fr}, limites de crédit ${c.fr}, relevés`),
    secs: ['crm', 'collect', 'reports', 'cta'] },

  // ---------- موضوعات عامة (14) ----------
  { id: 'what-is-field-sales-management', cs: false, rm: 6,
    label: svc('ما هو برنامج إدارة المناديب (نظام المبيعات الميدانية)؟', 'What Is Field Sales Management Software?', "Qu'est-ce qu'un logiciel de vente terrain ?"),
    kw: (c, L) => P(L, `نظام إدارة مبيعات ميدانية, تعريف, مناديب, توزيع, فاتورة`, `field sales management software, definition, reps, distribution`, `logiciel de vente terrain, définition, commerciaux, distribution`),
    secs: ['why', 'invoice', 'collect', 'reports', 'features', 'cta'] },
  // مقال ركيزة عام (صفحة واحدة لا 22) — «retail execution» طلبه ضعف DMS في مؤشرات Google،
  // ومصطلح دقيق بلا التباس، وميزاته قائمة فعلاً (زيارات ميدانية بصور + تصنيف قنوات البيع).
  { id: 'retail-execution', cs: false, rm: 7,
    label: svc('التنفيذ في نقاط البيع (Retail Execution)', 'Retail Execution for FMCG Distributors', 'Exécution retail pour les distributeurs FMCG'),
    kw: (c, L) => P(L, `التنفيذ في نقاط البيع, زيارات المناديب, قنوات البيع, تغطية المنافذ, حصة الرف`, `retail execution, retail execution software, field visits, outlet coverage, sales channel, perfect store`, `exécution retail, visites terrain, couverture des points de vente, canaux de vente`),
    secs: ['why', 'crm', 'gps', 'reports', 'features', 'cta'] },
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
    label: svc('تطبيق مناديب يعمل بدون إنترنت (أوفلاين)', 'Why Offline Matters in Field Sales', "L'importance du mode hors ligne"),
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
    label: svc('أفضل برنامج إدارة مناديب وتوزيع', 'Best Field Sales & Distribution Software', 'Meilleurs logiciels de vente terrain et distribution'),
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

/**
 * آخر تعديل جوهري على قالب المقالات المولَّدة (أقسام/روابط/CTA).
 *
 * **ارفعه يدوياً عند تغيير محتوى القالب فعلاً — ولا تجعله `اليوم` أبداً.**
 * خريطة تقول «كل شيء تعدّل اليوم» في كل بناء تجعل جوجل يتجاهل lastmod كلياً،
 * فنخسر الإشارة التي نريدها. وهو غير `date` (تاريخ النشر) الذي يبقى حقيقياً
 * للقارئ ولـdatePublished.
 *
 * 2026-07-17: أُعيدت صياغة كتلة «مقالات ذات صلة» (الشرطة الأخيرة في كل رابط).
 * 2026-07-23: قسم localContext مُفرَّد لكل دولة + استهداف «distributor management system» (DMS).
 * 2026-07-25: صيغة «DMS Software» (استعلام صاعد +140%) + مقال ركيزة «retail execution».
 * 2026-07-29: إعادة توجيه العناوين العربية لمفردات المشتري (مناديب أولاً) + إصلاح «البيع من السيارة»→«كاش فان».
 */
export const CONTENT_VERSION = '2026-07-29';

// تاريخ التعديل = الأحدث بين النشر ونسخة القالب (يبقى صحيحاً لو صار النشر أحدث لاحقاً)
export const modifiedOf = (date) => (date > CONTENT_VERSION ? date : CONTENT_VERSION);

// slug المقال: عام = id، خاص بدولة = id-cc
// الصفحة الجامعة لموضوع قُطري تأخذ المعرّف مجرّداً (REGION)؛ وصفحات الدول تأخذ اللاحقة.
const slugOf = (topic, c) => (topic.cs && c.code !== 'REGION' ? `${topic.id}-${c.code.toLowerCase()}` : topic.id);

// فهرس داخلي: slug → { topic, country }
let _index = null;
function index() {
  if (_index) return _index;
  _index = new Map();
  let i = 0;
  for (const topic of TOPICS) {
    // الموضوع القُطري يُنتج صفحة جامعة (REGION) + صفحة لكل دولة؛ والعام يُنتج واحدة فقط.
    const countries = topic.cs ? [REGION, ...COUNTRIES] : [REGION];
    for (const c of countries) {
      _index.set(slugOf(topic, c), { topic, country: c, date: dateFor(i++) });
    }
  }
  return _index;
}

/**
 * الرابط الأساسي (canonical) للمقال: صفحة دولة **غير ذات أولوية** تُشير إلى الصفحة الجامعة
 * لتجميع إشارات الترتيب بدل تشتيتها؛ وما عداها يُشير إلى نفسه.
 * تبقى الصفحة حيّة للزائر — التغيير إشارة لمحركات البحث فقط.
 */
export function canonicalSlug(slug) {
  const hit = index().get(slug);
  if (!hit || !hit.topic.cs) return slug;
  const cc = hit.country.code;
  if (cc === 'REGION' || PRIORITY_MARKETS.has(cc)) return slug;
  return pillarSlug(hit.topic.id);
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
  // الشرطة الأخيرة إلزامية: الصفحات تُكتب مجلّدات (blog/x/index.html)، والرابط بلا شرطة يُخدَم قوقعة SPA
  const add = (slug, text) => items.push([`${base}/${slug}/`, text]);
  if (topic.cs) {
    const cc = c.code.toLowerCase();
    // عنقود الدولة: خدمات أخرى لنفس الدولة (٤ روابط). DMS أولاً — كلمة مثبَتة الطلب (GSC)،
    // فتتدفّق إليها روابط داخلية بنصّ رابط دقيق «Distributor Management System (DMS)».
    ['distribution-management-system', 'van-sales-app', 'collection-receivables', 'einvoicing-compliance', 'sales-rep-management', 'gps-rep-tracking']
      .filter((id) => id !== topic.id).slice(0, 4)
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
// طبقة كلمات مفتاحية عالية النية تُضاف لكل مقال — تقوّي تغطية مصطلحات الشراء في الأسواق العربية
const EXTRA_KW = (c, L) => P(L,
  `فان سيلز ${c.ar}, البيع من السيارة ${c.ar}, DSD ${c.ar}, أتمتة قوة المبيعات, برنامج مناديب ${c.ar}, برنامج توزيع FMCG ${c.ar}, برنامج شركات الجملة ${c.ar}, تطبيق مندوب مبيعات ${c.ar}, حسابات خطوط السير, إدارة الموزّعين ${c.ar}, برنامج توزيع مواد غذائية ${c.ar}, نظام نقاط بيع متنقّل`,
  `distributor management system ${c.en}, DMS software ${c.en}, van sales software ${c.en}, DSD software ${c.en}, sales force automation ${c.en}, field force automation, FMCG distribution software ${c.en}, wholesale distribution software ${c.en}, route accounting ${c.en}, mobile sales app ${c.en}, food distribution software ${c.en}`,
  `logiciel van sales ${c.fr}, DSD ${c.fr}, automatisation force de vente ${c.fr}, gestion des distributeurs ${c.fr}, logiciel distribution FMCG ${c.fr}, logiciel de gros ${c.fr}, comptabilité de tournée, application commerciale mobile ${c.fr}`);

export function listArticles(L) {
  const out = [];
  for (const [slug, { topic, country, date }] of index()) {
    out.push({
      slug, lang: L, date, modified: modifiedOf(date), readMinutes: topic.rm,
      countryCode: topic.cs ? country.code : null,
      title: titleOf(topic, country, L),
      excerpt: excerptOf(topic, country, L),
      keywords: topic.kw(country, L) + ', ' + EXTRA_KW(country, L),
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
  // الصفحة الجامعة (REGION لموضوع قُطري) تحمل جدول مقارنة الدول — محتواها الحصريّ الذي
  // يبرّر وجودها ويجعلها غير مكرّرة؛ وصفحات الدول تحمل localContext المُفرَّد لكل دولة.
  const isPillar = topic.cs && c.code === 'REGION';
  const universal = [
    ...(isPillar ? ['countryTable'] : topic.cs ? ['localContext'] : []),
    // بطاقة السوق المُفرَّدة لأسواق الأولوية فقط — تكسر تشابه صفحاتها فيحترم جوجل canonical الذاتيّ.
    ...(topic.cs && PRIORITY_BRIEF[c.code] ? ['marketBrief'] : []),
    'steps', 'benefits', 'kpis', 'compare', 'mistakes', 'glossary', 'faq',
  ].filter((k) => !coreKeys.includes(k));
  const body = [...coreKeys, ...universal].map((k) => S[k](c, L)).join('\n');
  // كتلة الإجابة تسبق المقدّمة عمداً: محرّك التوليد يقتبس أوّل فقرة تُجيب
  // السؤال قائمةً بذاتها، والمقدّمة التسويقية ليست كذلك مهما جوّدناها.
  const contentHtml = `${answerBlock(topic, c, L)}\n${intro}\n${body}\n${cta(L)}\n${relatedLinks(topic, c, L)}`;
  return {
    slug, title: t, description: descOf(topic, c, L), keywords: topic.kw(c, L) + ', ' + EXTRA_KW(c, L),
    excerpt: excerptOf(topic, c, L), contentHtml, date, modified: modifiedOf(date), readMinutes: topic.rm,
    image: `${ORIGIN}/og/${slug}-${L}.jpg`, imagePath: `/og/${slug}-${L}.jpg`,
    faq: faqData(c, L),
    howto: howToData(c, L),
    countryCode: topic.cs ? c.code : null, isSeo: true,
  };
}

// الدول الفرنكوفونية (المغرب العربي وغيرها) — نستهدفها بالفرنسية في خريطة الموقع
const FRANCOPHONE = new Set(['MA', 'DZ', 'TN', 'MR', 'DJ', 'KM']);

/**
 * تقليم الفهرسة: دول بلا طلب بحث **إنجليزي** فعلي على برمجيات التوزيع.
 * القياس (Google Trends، يوليو 2026): هذه الأسواق تحت عتبة القياس تماماً بالإنجليزية،
 * والدليل من فهرس Bing: فهرس ~10 صفحات فقط من 1136 فاختار الصومال وسوريا لا الخليج —
 * أي أنه يأخذ عيّنة عشوائية من كتلة صفحات متشابهة بدل إبراز الأفضل.
 *
 * الأثر: نسختها **الإنجليزية** تبقى حيّة للزائر لكن `noindex,follow` وخارج الخريطة،
 * فتنكمش كتلة الصفحات المتشابهة التي تخفض تقدير النطاق كلّه (Scaled Content)
 * وتتركّز ميزانية الزحف على صفحات الخليج.
 *
 * ⚠️ العربية والفرنسية **لا تُمسّان** (العربية حيث يترتّب الموقع فعلاً، وDJ/KM/MR فرنكوفونية).
 * القرار عكوس: احذف الرمز من المجموعة فتعود الصفحة للفهرسة عند البناء التالي.
 */
export const NO_EN_INDEX = new Set(['SO', 'DJ', 'KM', 'YE', 'SY', 'LY', 'SD', 'MR', 'PS']);

/**
 * الدمج (Consolidation) — قرار مبنيّ على حكم جوجل نفسه لا على تقدير.
 *
 * Search Console (29 يوليو 2026): **683 صفحة مرفوضة** بسبب «نسخة طبق الأصل — اختار Google
 * صفحة أساسية غير اختيار المستخدم»، وأمثلتها هي صفحات الدول المُقولَبة حرفياً
 * (…-dj, -mr, -so, -lb, -ye, -iq, -dz, **-kw**, **-bh**, -eg). وجود الكويت والبحرين
 * يثبت أن العطل في **بنية «موضوع × 22 دولة»** لا في ضعف الأسواق.
 *
 * العلاج: لكل موضوع قُطري **صفحة جامعة واحدة** (slug = معرّف الموضوع، بيانات REGION
 * + جدول مقارنة الدول بحقائق حقيقية) تتجمّع فيها إشارات الترتيب؛ وصفحات الدول
 * غير ذات الأولوية تُشير إليها بـcanonical بدل أن تتنافس معها.
 * ⇒ نؤكّد حكم جوجل بدل مصارعته: 22 صفحة ضعيفة تتنافس ← صفحة واحدة قويّة.
 *
 * تبقى أسواق الأولوية بصفحاتها القُطرية (طلب حقيقي + محتوى مُفرَّد فعلاً عبر localContext).
 */
export const PRIORITY_MARKETS = new Set(['SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'EG']);

/** slug الصفحة الجامعة لموضوع قُطري (بلا لاحقة دولة). */
export const pillarSlug = (topicId) => topicId;

/** هل تُفهرَس نسخة اللغة L من مقال الدولة cc؟ (cc=null للمقالات العامّة ⇒ دائماً نعم) */
export const isIndexable = (cc, L) => !(L === 'en' && cc && NO_EN_INDEX.has(cc));

// كل الـslugs (لبناء خريطة الموقع) مع معلومات الدولة واللغة المستهدَفة
// cc: رمز الدولة أو null، fr: هل تُستهدَف بالفرنسية (لغةً ثانيةً في الخريطة)
export function buildCatalog() {
  const out = [];
  for (const [slug, { topic, country, date }] of index()) {
    // REGION ليست دولة — الصفحة الجامعة تُعامَل كعامّة (cc=null) في التقليم والخرائط
    const cc = topic.cs && country.code !== 'REGION' ? country.code : null;
    const canon = canonicalSlug(slug);
    out.push({ slug, date, modified: modifiedOf(date), cc, canonical: canon, isCanonical: canon === slug, trilingual: true, fr: cc ? FRANCOPHONE.has(cc) : false });
  }
  return out;
}

// الإجابة المختصرة نصّاً صرفاً — تُستهلَك في llms-full.txt الذي يقرؤه محرّك
// التوليد مباشرةً. الفصل عن answerBlock مقصود: هناك HTML للصفحة، وهنا نصّ للآلة.
export function shortAnswer(slug, L) {
  const hit = index().get(slug);
  if (!hit) return '';
  const { topic, country } = hit;
  const fn = ANSWERS[topic.id];
  if (!fn) return '';
  const local = LOCAL_ANCHOR[topic.id];
  const t = local ? `${fn(country, L)} ${local(country, L)}` : fn(country, L);
  return t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
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
