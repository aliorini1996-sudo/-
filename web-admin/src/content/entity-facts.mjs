/**
 * حقائق الكيان FieldSales: مصدر واحد لما يجب أن يتطابق في كل اللغات وكل الأسطح
 * (llms.txt وJSON-LD ووسوم og والرئيسيات المُصيَّرة والأجوبة الجاهزة).
 *
 * خطة GEO العالمية، البند ٣ (القسم ٣.١)، مع تصحيحات نقدها: يبقى ‎#software‎ معرّفاً لتطبيق المندوب
 * (النقد ٦)، وحقل التجربة المجانية (النقد ١٩)، وعملة السعر (النقد ٢٠)، وجملة لغات الواجهة الثابتة (النقد ٢١).
 *
 * الحالة: **مسودة غير مربوطة بالبناء.** لا يستورده gen-llms ولا prerender بعد، ونصوص الوصف والتغطية
 * تنتظر إقرار المالك (القرار ١ في القسم ٧ من الخطة). الحارس scripts/verify-facts.mjs يقرؤه.
 *
 * قاعدة الملف: كل حقيقة هنا منقولة من الكود الفعلي، ومصدرها مكتوب بجانبها. ما لم يُعرف له مصدر
 * لا يُكتب، بل يبقى null بسبب مذكور. وعدد الدول **يُحسب** من سجل src/i18n/countries.ts وقت التشغيل
 * ولا يُكتب رقماً: كل دولة تُضاف إلى السجل تصل إلى الحقائق بلا تعديل هنا.
 *
 * يصلح للمتصفح ولـNode معاً: لا استيراد ولا fs في رأس الملف. قراءة السجل وحدها تحتاج Node، وتتم
 * عند الطلب عبر process.getBuiltinModule (Node 20.16 وما بعده)، فلا تراها حزمة Vite إن استوردته صفحة.
 */

/** تاريخ آخر تعديل لهذه الحقائق — يُرفع مع كل تعديل، ويصير لاحقاً «Last updated» في llms وdateModified */
export const FACTS_VERSION = '2026-11-08';

/** مسودة حتى يقرّ المالك نص الوصف والتغطية والكيان القانوني (خطة GEO، القسم ٧، القرار ١) */
export const FACTS_STATUS = 'draft';

export const ORIGIN = 'https://fieldsa.net';

/**
 * معرّفات JSON-LD الثابتة (index.html).
 * ‎#software‎ يبقى لتطبيق المندوب: استبداله بـ‎#rep-app‎ يقطع استمرارية الكيان (نقد GEO، البند ٦).
 * ‎#admin-app‎ مقترح للخطة ولم يُنشر في index.html بعد.
 */
export const IDS = {
  organization: `${ORIGIN}/#organization`,
  repApp: `${ORIGIN}/#software`,
  adminApp: `${ORIGIN}/#admin-app`,
};

/**
 * الاسم وصيغه. المصدر: index.html (Organization.alternateName)، وgen-llms.mjs («Also known as»).
 * لا صيغ بكتابات أخرى (صينية أو روسية أو عبرية…): لا استعمال لها في المستودع، والخطة تمنع اختراعها (٤.١).
 * «Fieldsa» مستعملة فعلاً في alternateName بـindex.html وفي llms.txt.
 */
export const NAME = {
  official: 'FieldSales',
  arabic: 'فيلد سيلز',
  domain: 'fieldsa.net',
  alternates: ['فيلد سيلز', 'Field Sales', 'Fieldsa', 'fieldsa.net'],
  /** جملة التمييز — من gen-llms.mjs («Other products share the generic name…») */
  disambiguation: {
    en: 'Other products share the generic name “Field Sales”; this describes only FieldSales at fieldsa.net.',
    ar: 'منتجات أخرى تحمل الاسم العام «Field Sales»، وهذا يصف FieldSales على fieldsa.net وحده.',
  },
};

/**
 * الوصف القصير. مأخوذ من WHAT_IS في src/content/answers.mjs مع تبديل وحيد: «across Arab markets» و«في الأسواق
 * العربية» صارتا «في كل دول العالم» بقرار المالك (٨ نوفمبر ٢٠٢٦: المنصة لكل دول العالم). مسودة حتى الإقرار.
 */
export const DESCRIPTION = {
  en: 'FieldSales (fieldsa.net) is a cloud platform for managing field sales reps and van sales in distribution companies in every country. Reps issue and print invoices and receipt vouchers from their phone, log visits with location and photos and see their van stock per item, while managers follow sales, collections and customer balances as they happen.',
  ar: 'فيلد سيلز (FieldSales) منصة سحابية لإدارة مناديب المبيعات والتوزيع الميداني لشركات التوزيع في كل دول العالم، يصدر فيها المندوب من جواله الفاتورة وسند القبض ويطبعهما أمام العميل، ويسجّل زيارته بموقعها وصورها، ويرى مخزون سيارته لكل صنف، وتتابع الإدارة المبيعات والتحصيل وأرصدة العملاء لحظة حدوثها.',
};

/**
 * المنظّمة. المصادر:
 *  - المقر والتأسيس والمؤسس: index.html (address وfoundingDate وfounder)، وgen-llms.mjs («Headquarters: Riyadh…
 *    Founded: 2026. Founder: Ali Aloraini.»)، وsrc/blog/clusters.mjs (صفحة «FieldSales at a glance»).
 *  - الكيان القانوني والسجل التجاري: سياسة الخصوصية في src/landing/defaultContent.ts وdefaultContentEn/Fr/Tr.ts.
 *    أما legalName في JSON-LD فهو اليوم «FieldSales»؛ وضع الاسم القانوني فيه ينتظر تأكيد المالك (خطة GEO ٤.١).
 */
export const ORGANIZATION = {
  hq: { city: 'Riyadh', cityAr: 'الرياض', country: 'SA', countryName: 'Saudi Arabia', countryNameAr: 'السعودية' },
  founded: '2026',
  founder: 'Ali Aloraini',
  legalEntity: {
    nameAr: 'مؤسسة تكامل الميدان للتجارة والإستيراد',
    commercialRegistration: '7040371671',
    /** هل يُكتب في legalName بـJSON-LD؟ لا، حتى يقرّه المالك */
    useInSchema: false,
  },
  /** الرقم الضريبي (vatID) منشور في الفواتير بحسب الخطة، لكن لا مصدر له في المستودع — null حتى يؤكده المالك */
  vatId: null,
};

/**
 * التطبيقات. المصادر:
 *  - أندرويد المندوب net.fieldsa.twa: index.html (sameAs وdownloadUrl) وpublic/.well-known/assetlinks.json.
 *  - آيفون المندوب id6797991968 (net.fieldsa.rep) وآيفون الإدارة id6798083334 (net.fieldsa.admin): index.html
 *    (sameAs) وscripts/gen-ios-project.mjs. تحقّقت من الاثنين في iTunes lookup يوم ٨ نوفمبر ٢٠٢٦ (resultCount 1).
 *  - أندرويد الإدارة net.fieldsa.admin: في assetlinks.json فقط، وصفحته في Play تُرجع 404 (٨ نوفمبر) ⇒ غير منشور.
 *  - الويب: تطبيق المندوب /rep وتطبيق الإدارة على الجوال /m (src/i18n/lang.ts: isAppRoute).
 */
export const APPS = {
  repAndroid: {
    platform: 'android', id: 'net.fieldsa.twa', public: true,
    url: 'https://play.google.com/store/apps/details?id=net.fieldsa.twa',
  },
  repIos: {
    platform: 'ios', id: '6797991968', bundleId: 'net.fieldsa.rep', public: true,
    url: 'https://apps.apple.com/app/id6797991968',
  },
  adminIos: {
    platform: 'ios', id: '6798083334', bundleId: 'net.fieldsa.admin', public: true,
    url: 'https://apps.apple.com/app/id6798083334',
  },
  adminAndroid: { platform: 'android', id: 'net.fieldsa.admin', public: false, url: null },
  repWeb: { platform: 'web', path: '/rep' },
  adminWeb: { platform: 'web', path: '/m' },
};

/** روابط المتاجر المنشورة وحدها (downloadUrl وsameAs) */
export const storeUrls = () => Object.values(APPS).filter((a) => a.public && a.url).map((a) => a.url);

/**
 * لغات الواجهة: الخمس فعلاً. المصدر: النوع Lang في src/i18n/lang.ts، والقاموس DICT في src/i18n/strings.ts
 * (حقول ar وen وfr وtr وzh). الاختبار src/content/entityFacts.test.ts يطابق القائمة بالنوع، فلا تنحرف.
 * في المرحلة ب من خطة SEO تُقرأ من حقل uiAvailable في سجل اللغات (خطة GEO، البند ١٣).
 */
export const UI_LANGS = ['ar', 'en', 'fr', 'tr', 'zh'];

/**
 * أسماء اللغات الخمس بكل لغة من لغات الواجهة — يبني منها الحارس جملة اللغات ويكشف قوائم اللغات المخالفة.
 * الأسماء كما تُكتب في واجهة الموقع (قسم التغطية في src/pages/LandingPage.tsx وقوائم اللغات في الرئيسيات).
 */
export const LANG_NAMES = {
  ar: { ar: 'العربية', en: 'Arabic', fr: 'arabe', tr: 'Arapça', zh: '阿拉伯语' },
  en: { ar: 'الإنجليزية', en: 'English', fr: 'anglais', tr: 'İngilizce', zh: '英语' },
  fr: { ar: 'الفرنسية', en: 'French', fr: 'français', tr: 'Fransızca', zh: '法语' },
  tr: { ar: 'التركية', en: 'Turkish', fr: 'turc', tr: 'Türkçe', zh: '土耳其语' },
  zh: { ar: 'الصينية', en: 'Chinese', fr: 'chinois', tr: 'Çince', zh: '中文' },
};

/** اسم schema.org لكل لغة (availableLanguage يقبل الاسم الإنجليزي أو رمز BCP-47) */
export const SCHEMA_LANG_NAMES = UI_LANGS.map((l) => LANG_NAMES[l].en);

/**
 * جملة ثابتة عن لغات الواجهة (نقد GEO، البند ٢١): تُلزَم بها كل صفحة بلغة غير الخمس، كي لا تقول المحركات
 * «يدعم اليابانية». مسودة مشتقة من القوائم أعلاه، تنتظر إقرار المالك.
 */
export const UI_LANGS_SENTENCE = {
  ar: 'واجهة التطبيق متاحة بالعربية والإنجليزية والفرنسية والتركية والصينية.',
  en: 'The app interface is available in Arabic, English, French, Turkish and Chinese.',
  fr: 'L’interface de l’application est disponible en arabe, anglais, français, turc et chinois.',
  tr: 'Uygulama arayüzü Arapça, İngilizce, Fransızca, Türkçe ve Çince olarak kullanılabilir.',
  zh: '应用界面支持阿拉伯语、英语、法语、土耳其语和中文。',
};

/**
 * التغطية: كل دول العالم بلا استثناء (قرار المالك). الصياغة من شروط الخدمة في defaultContent*.ts
 * («available to companies in every country in the world» ونظائرها)، والعربية بلفظ المالك «لكل دول العالم».
 * العدد يُحسب من السجل: انظر countryRegistry() وcoverageFacts() أدناه.
 */
export const COVERAGE = {
  scope: 'worldwide',
  phrase: {
    ar: 'لكل دول العالم',
    en: 'every country in the world',
    fr: 'tous les pays du monde',
    tr: 'dünyanın tüm ülkeleri',
    zh: '全球所有国家',
  },
  /** سجل الدول الذي يُحسب منه العدد (نسبةً إلى هذا الملف) */
  registry: '../i18n/countries.ts',
  /** رمز «دولة أخرى» في السجل: لأي دولة غير مدرجة، فلا يُعدّ دولة */
  otherCountryCode: 'XX',
  /** areaServed في JSON-LD: عالمي (لا قائمة دول) */
  schemaAreaServed: 'Worldwide',
};

/**
 * الفوترة الإلكترونية والربط الحكومي.
 *  - الحيّ: السعودية وحدها. المصدر: backend/src/compliance/provider.ts (zatcaProvider مُنفَّذ، وETA وPeppol وTTN
 *    نقاط امتداد تُرجع not_implemented)، وتعليق رأس scripts/verify-claims.mjs.
 *  - الصيغة المعتمدة: «ندعم ربط المرحلة الثانية مع منصة فاتورة» بلا «معتمد» ولا مواعيد (قرار المالك،
 *    وscripts/claims-rules.mjs وsrc/content/answers.mjs). ونفي الاعتماد كما في llms اليوم.
 *  - غير السعودية: فواتير عادية بعملة الدولة وضريبتها، والربط الحكومي «عند الطلب» (قسم التغطية في
 *    src/pages/LandingPage.tsx، وملاحظة XX في src/i18n/countries.ts).
 */
export const E_INVOICING = {
  liveCountries: ['SA'],
  saudi: {
    authority: 'ZATCA',
    platform: 'Fatoora',
    phase2: {
      ar: 'ندعم ربط المرحلة الثانية مع منصة فاتورة',
      en: 'We support Phase 2 integration with ZATCA’s Fatoora platform',
    },
    noCertification: {
      ar: 'هيئة الزكاة والضريبة والجمارك لا تعتمد مزوّدي البرمجيات، فلا ندّعي اعتماداً.',
      en: 'ZATCA does not certify software vendors, so FieldSales claims no certification.',
    },
  },
  elsewhere: {
    status: 'on-request',
    phrase: { ar: 'عند الطلب', en: 'on request', fr: 'sur demande', tr: 'talep üzerine', zh: '按需' },
    /** معرّفات المحوّلات غير المنفَّذة في backend/src/compliance/provider.ts */
    notImplemented: ['eta', 'peppol', 'ttn'],
  },
};

/** حالة الربط الحكومي لدولة: 'live' للسعودية، و'on-request' لغيرها */
export const einvoiceStatus = (code) => (E_INVOICING.liveCountries.includes(String(code).toUpperCase()) ? 'live' : 'on-request');

/**
 * قنوات التواصل. المصادر:
 *  - طلب عرض السعر ‎/subscribe-request/?type=quote‎ والاجتماع ‎/meeting/‎ بكل بادئات اللغات: src/App.tsx
 *    (المسارات 269–341)، وquoteUrl في src/pages/LandingPage.tsx.
 *  - البريد: info للمبيعات وhelp للدعم — gen-llms.mjs (قسم Company) وsrc/components/SupportModal.tsx.
 *  - الهاتف ‎+966590633827‎: index.html (telephone) وgen-llms.mjs. ⚠️ يخالفه CMS الحيّ (contact.phone = ‎+966 58 183 5269‎)
 *    — تضارب ينتظر قرار المالك، ولم يُحسم هنا.
 *  - واتساب: لا رقم في defaultContent*.ts (الحقل فارغ). الرقم ‎966581835269‎ احتياطي الخادم في
 *    backend/src/routes/analytics.ts (‎/go/wa‎، ما لم يضبط WHATSAPP_NUMBER في Render) ويطابق contact.whatsapp في CMS الحيّ.
 *    والزرّ في الموقع يمرّ بالمحوّل لا بـwa.me مباشرة (src/components/WhatsAppFab.tsx).
 */
export const CONTACT = {
  quotePath: '/subscribe-request/?type=quote',
  meetingPath: '/meeting/',
  email: { sales: 'info@fieldsa.net', support: 'help@fieldsa.net' },
  phone: '+966590633827',
  whatsapp: {
    number: '+966581835269',
    redirect: 'https://api.fieldsa.net/api/analytics/go/wa',
  },
};

/** المسار بلغة: العربية بلا بادئة، وغيرها ‎/xx‎ (src/i18n/locale.ts: PREFIX) */
export const localePath = (p, lang = 'ar') => (lang === 'ar' ? p : `/${lang}${p}`);

/**
 * روابط sameAs كما في index.html اليوم (قراءة فقط). تُضاف YouTube وInstagram حين توجد (خطة GEO ٤.٢).
 * المطابقة تُطبّع رابط App Store ذا الدولة (apps.apple.com/sa/app/…) إلى صيغته العامة: انظر normalizeProfileUrl.
 */
export const SAME_AS = [
  'https://x.com/fieldsa_net',
  'https://www.facebook.com/profile.php?id=61591189934757',
  'https://www.linkedin.com/company/fieldsa/',
  'https://www.g2.com/products/fieldsales/reviews',
  'https://www.saashub.com/fieldsales',
  'https://play.google.com/store/apps/details?id=net.fieldsa.twa',
  'https://apps.apple.com/app/id6797991968',
  'https://apps.apple.com/app/id6798083334',
];

/** يوحّد رابط حساب للمقارنة: بلا شرطة أخيرة، وبلا رمز دولة App Store، وبلا اسم التطبيق في مساره */
export const normalizeProfileUrl = (u) => String(u).trim()
  .replace(/^http:\/\//i, 'https://')
  .replace(/^(https:\/\/apps\.apple\.com)\/[a-z]{2}\/app\/(?:[^/]+\/)?(id\d+).*$/i, '$1/app/$2')
  .replace(/^(https:\/\/apps\.apple\.com\/app)\/[^/]+\/(id\d+).*$/i, '$1/$2')
  .replace(/\/+$/, '');

/**
 * التجربة المجانية (نقد GEO، البند ١٩): عشرة أيام بلا بطاقة ائتمان. المصدر: answers.mjs (جواب السعر)،
 * وأجسام homeMeta في scripts/prerender.mjs، ووصف index.html. بقاؤها في كل الأسطح أو إزالتها منها كلها قرار المالك.
 */
export const TRIAL = { days: 10, creditCard: false, signupPath: '/signup/', ownerDecision: 'pending' };

/**
 * السعر: لا سعر ظاهر في الموقع (قرار المالك ٢٧ أكتوبر)، والأرقام من CMS وحده (scripts/pricing-source.mjs)
 * فلا تُكتب هنا. الاشتراك شهري لكل شركة لا لكل مستخدم (answers.mjs ووصف offers في index.html)، بالريال.
 * نقد GEO ٢٠: يُضاف إلى الأسطح «الأسعار بالريال السعودي، والعرض بعملتك عند الطلب» — بإقرار المالك.
 */
export const PRICING = {
  visibleOnSite: false,
  source: 'CMS',
  currency: 'SAR',
  model: 'per-company',
  otherCurrencies: 'on-request',
};

/**
 * العمل دون اتصال وحدوده — نص llms اليوم (scripts/gen-llms.mjs، سطر «Working offline»)، وأصله
 * RepApp.tsx (يمنع الفاتورة والمرتجع دون اتصال حين phase === 2).
 */
export const OFFLINE = {
  en: 'Receipts, visits and new customers work without a connection and sync automatically without duplicates, and companies without the integration also issue invoices offline. Saudi companies with Phase 2 integration enabled need a connection at the moment of issue for invoices (standard and simplified) and returns.',
};

// ————————————————————————————————————————————————————————————————————————————————
// سجل الدول: يُحسب ولا يُكتب
// ————————————————————————————————————————————————————————————————————————————————

/**
 * يحلّل نص src/i18n/countries.ts ويُرجع مدخلات COUNTRIES. دالة نقية (تقبل النص) كي يختبرها الاختبار
 * ويطابقها بالسجل نفسه مستورداً. تفشل بصوت عالٍ إن تغيّر شكل الملف فلم يطابق عدُّ المدخلات عدَّ رموزها.
 * @param {string} source
 * @returns {{ code: string, nameEn: string, einvoice: string }[]}
 */
export function parseCountryRegistry(source) {
  const src = String(source);
  const start = src.search(/export\s+const\s+COUNTRIES\b[^=]*=\s*\{/);
  if (start < 0) throw new Error('entity-facts: لم أجد COUNTRIES في سجل الدول');
  const end = src.indexOf('\n};', start);
  if (end < 0) throw new Error('entity-facts: لم أجد نهاية COUNTRIES في سجل الدول');
  const block = src.slice(start, end);
  const parts = block.split(/\n[ \t]+([A-Z]{2}):\s*\{/).slice(1);
  const entries = [];
  for (let i = 0; i < parts.length; i += 2) {
    const key = parts[i];
    const body = parts[i + 1] || '';
    const code = (body.match(/\bcode:\s*'([A-Z]{2})'/) || [])[1];
    const nameEn = (body.match(/\bnameEn:\s*'((?:[^'\\]|\\.)*)'/) || [])[1];
    const einvoice = (body.match(/\beinvoice:\s*'([a-z]+)'/) || [])[1];
    if (code !== key || !nameEn || !einvoice) throw new Error(`entity-facts: مدخل غير مفهوم في سجل الدول عند ${key}`);
    entries.push({ code, nameEn, einvoice });
  }
  const codes = (block.match(/\bcode:\s*'[A-Z]{2}'/g) || []).length;
  if (!entries.length || entries.length !== codes) {
    throw new Error(`entity-facts: عدد المدخلات (${entries.length}) لا يطابق عدد الرموز (${codes}) في سجل الدول`);
  }
  if (new Set(entries.map((e) => e.code)).size !== entries.length) throw new Error('entity-facts: رمز دولة مكرر في السجل');
  return entries;
}

let registryCache = null;

/**
 * مدخلات سجل الدول مقروءة من الملف (Node وحده). تُخزَّن بعد أول قراءة.
 * @returns {{ code: string, nameEn: string, einvoice: string }[]}
 */
export function countryRegistry() {
  if (registryCache) return registryCache;
  const proc = typeof globalThis !== 'undefined' ? globalThis.process : undefined;
  const fs = proc && typeof proc.getBuiltinModule === 'function' ? proc.getBuiltinModule('node:fs') : null;
  if (!fs) throw new Error('entity-facts: countryRegistry() تقرأ src/i18n/countries.ts فتحتاج Node 20.16 أو أحدث');
  // المسار متغيّر لا نصّ حرفي: Vite يحوّل new URL('حرفي', import.meta.url) إلى أصل يُنسخ في الحزمة
  const rel = COVERAGE.registry;
  registryCache = parseCountryRegistry(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
  return registryCache;
}

/**
 * حقائق التغطية محسوبة من السجل.
 *  - registryEntries: كل مدخلات السجل (ومنها «دولة أخرى» XX).
 *  - presetCountries: الدول ذات الإعدادات الجاهزة (عملة وضريبة ورقم ضريبي)، بلا XX.
 *  - einvoiceLive: الدول ذات الربط الحكومي الحيّ (من E_INVOICING، وكلها يجب أن تكون في السجل).
 */
export function coverageFacts(entries = countryRegistry()) {
  const presets = entries.filter((e) => e.code !== COVERAGE.otherCountryCode);
  const missingLive = E_INVOICING.liveCountries.filter((c) => !entries.some((e) => e.code === c));
  if (missingLive.length) throw new Error(`entity-facts: دولة ربط حيّ غير موجودة في السجل: ${missingLive.join(', ')}`);
  return {
    scope: COVERAGE.scope,
    phrase: COVERAGE.phrase,
    registryEntries: entries.length,
    presetCountries: presets.length,
    hasOtherCountry: entries.some((e) => e.code === COVERAGE.otherCountryCode),
    einvoiceLive: [...E_INVOICING.liveCountries],
    schemaAreaServed: COVERAGE.schemaAreaServed,
  };
}

/** كل الحقائق في كائن واحد (Node: التغطية تُحسب من السجل) */
export function getFacts() {
  return {
    version: FACTS_VERSION,
    status: FACTS_STATUS,
    origin: ORIGIN,
    ids: IDS,
    name: NAME,
    description: DESCRIPTION,
    organization: ORGANIZATION,
    apps: APPS,
    languages: { ui: [...UI_LANGS], names: LANG_NAMES, schemaNames: SCHEMA_LANG_NAMES, sentence: UI_LANGS_SENTENCE },
    coverage: coverageFacts(),
    eInvoicing: E_INVOICING,
    contact: CONTACT,
    sameAs: [...SAME_AS],
    trial: TRIAL,
    pricing: PRICING,
    offline: OFFLINE,
  };
}
