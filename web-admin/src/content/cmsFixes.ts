/**
 * مساعد تصحيح CMS — استبدالات حرفية لما يقرؤه الزاحف ومحرّكات الإجابة في محتوى الموقع الحيّ.
 *
 * لماذا: ربط المرحلة الثانية مع منصة فاتورة حيّ، لكن مقالات CMS وأسئلتها ما زالت تنفيه («غير مبنية لدينا
 * حتى الآن» · "not built")، أو تحصر المنتج في «المرحلة الأولى»، أو تُسقط باقة 399 من جملة السعر، أو تَعِد
 * بفاتورة دون اتصال بلا قيد الشركات المفعّل لها الربط، أو تقول إن النظام «يمنع» البيع فوق حدّ الائتمان
 * والخادم ينبّه فقط (backend/src/routes/invoices.ts: إشعار CREDIT_LIMIT_EXCEEDED بعد الحفظ).
 * تحرير أكثر من مئة موضع يدوياً من اللوحة عرضة للخطأ، فهذه القائمة تُطبَّق بزرّ في محرّر المحتوى (للمالك).
 *
 * القواعد:
 *  - كل بند: مسار الحقل في محتوى الموقع + النص الحالي حرفياً (قِيس بطلب GET على /api/site-content
 *    في ٤ أكتوبر ٢٠٢٦) + النص الجديد.
 *  - يُطبَّق البند فقط إن وُجد نصّه الحالي **مرة واحدة بالضبط** في الحقل؛ وإلا لا يُمسّ شيء ويُبلَّغ
 *    «لم يُعثر عليه» أو «ملتبس». والتطبيق على مسودّة المحرّر وحدها — الحفظ بزرّ الحفظ القائم.
 *  - كل نص جديد يمرّ بقواعد scripts/claims-rules.mjs وبحارس الأسعار (cmsFixes.test.ts): الصيغة
 *    «ندعم ربط المرحلة الثانية مع منصة فاتورة» بلا اعتماد ولا موعد، وأسعار CMS وحدها (299/399/599
 *    حتى 5/10/20 مندوباً) ولا سعر سنوي، وقيد الاتصال للمفعّل لهم بجوار أي وعد «دون اتصال».
 *  - بند فيه سعر لا يُطبَّق إن لم تطابق أسعارُه باقات المسودّة نفسها (لو غيّر المالك الأسعار بعد كتابته).
 *
 * خارج القائمة عمداً: الذكر التعليمي للمرحلة الأولى («ما الفرق بين المرحلة الأولى والثانية؟»)، ومعادلة
 * العهدة في القاموس، وبقاء مقال المقارنة ذي الاسم (قرار المالك — هنا تُحذف منه «المرحلة الأولى» فقط).
 * بعد تطبيق القائمة كاملة لا يبقى في CMS ما تلتقطه قاعدة zatca-phase2-stale-denial (قِيس على اللقطة)،
 * فيُقلب PHASE2_CMS_CLEANED بعد الحفظ والبناء (docs/owner-actions.md §٨).
 */

export type CmsFixGroup = 'phase2' | 'offline' | 'price' | 'credit';

export interface CmsFix {
  /** معرّف ثابت للبند (يظهر في تقرير التطبيق) */
  id: string;
  group: CmsFixGroup;
  /** مسار الحقل: مفاتيح بنقاط، والمصفوفة بمحدِّد [مفتاح=قيمة] أو [رقم] — blog[slug=x].en.contentHtml */
  path: string;
  /** النص الحالي حرفياً */
  from: string;
  /** النص الجديد */
  to: string;
}

export const CMS_FIX_GROUP_LABEL: Record<CmsFixGroup, string> = {
  phase2: 'المرحلة الثانية',
  offline: 'قيد دون اتصال',
  price: 'الأسعار',
  credit: 'حد الائتمان',
};

// ── الصيغ الموحّدة ────────────────────────────────────────────────────────────
/** الصيغة الوحيدة المعلنة للربط */
const P2 = 'ندعم ربط المرحلة الثانية مع منصة فاتورة';
/** قيد الاتصال للشركات المفعّل لها الربط (RepApp.tsx: لا فاتورة ولا مرتجع دون اتصال حين phase===2) */
const LIMIT = 'وللشركات المفعّل لها الربط تحتاج الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار، وتعمل سندات القبض والزيارات دون اتصال.';
/** القيد نفسه حين لا يسبقه ذكر الربط في الجملة */
const LIMIT_FULL = 'وللشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة تحتاج الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار، وتعمل سندات القبض والزيارات دون اتصال.';
const P2_EN = 'We support Phase 2 integration with ZATCA’s Fatoora platform.';
const LIMIT_EN = 'For companies with the integration enabled, invoices (standard and simplified) and returns need a connection at the moment of issue; receipts and visits still work offline.';

const blog = (slug: string, field: string) => `blog[slug=${slug}].${field}`;

export const CMS_FIXES: CmsFix[] = [
  // ═══ الصفحة الرئيسية ═══
  {
    id: 'home-faq-zatca', group: 'phase2',
    path: 'faq.items[q=هل الفواتير متوافقة مع هيئة الزكاة والضريبة؟].a',
    from: 'نعم، يصدر النظام فواتير ضريبية  متوافقة مع متطلبات الفوترة الإلكترونية ZATCA مع رمز QR بشكل نظامي متكامل.',
    to: `نعم، يصدر النظام فواتير ضريبية برمز QR وفق متطلبات الفوترة الإلكترونية، و${P2}. والهيئة لا تعتمد مزوّدي البرمجيات، فلا ندّعي اعتماداً منها.`,
  },
  {
    id: 'home-faq-offline', group: 'offline',
    path: 'faq.items[q=هل يعمل التطبيق دون اتصال بالإنترنت؟].a',
    from: '— بلا تكرار ولا فقدان بيانات.',
    to: '— بلا تكرار ولا فقدان بيانات. أما الشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة فتحتاج فيها الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار، وتعمل سندات القبض والزيارات دون اتصال.',
  },
  {
    id: 'home-feature-invoices', group: 'phase2',
    path: 'features.items[title=الفواتير الضريبية].desc',
    from: 'إصدار فواتير ضريبية متوافقة مع هيئة الزكاة والضريبة (ZATCA) مع رمز QR، وإرسالها مباشرة للعميل.',
    to: `إصدار فواتير ضريبية متوافقة مع هيئة الزكاة والضريبة (ZATCA) مع رمز QR، وإرسالها مباشرة للعميل. و${P2}.`,
  },
  {
    id: 'home-feature-offline', group: 'offline',
    path: 'features.items[title=العمل دون اتصال بالإنترنت].desc',
    from: '— بلا تكرار ولا فقدان.',
    to: '— بلا تكرار ولا فقدان. وللشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة تحتاج الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار.',
  },

  // ═══ sales-rep-tracking-saudi ═══
  {
    id: 'rep-tracking-ar', group: 'phase2', path: blog('sales-rep-tracking-saudi', 'contentHtml'),
    from: 'و<strong>فاتورة مبسّطة برمز QR</strong> وفق المرحلة الأولى تصدر من الجوال نفسه، و<strong>عملاً بلا إنترنت</strong> يصمد في المستودعات والأطراف. منصّة FieldSales بُنيت على هذه الثلاثة تحديداً.',
    to: `و<strong>فاتورة مبسّطة برمز QR</strong> تصدر من الجوال نفسه، و<strong>عملاً بلا إنترنت</strong> يصمد في المستودعات والأطراف. منصّة FieldSales بُنيت على هذه الثلاثة تحديداً، ونحن ${P2}. ${LIMIT}`,
  },
  {
    id: 'rep-tracking-en-desc', group: 'phase2', path: blog('sales-rep-tracking-saudi', 'en.description'),
    from: 'road-matched routes, and ZATCA Phase-1 QR invoices from the rep phone — offline included.',
    to: `road-matched routes and QR tax invoices from the rep phone. ${P2_EN}`,
  },
  {
    id: 'rep-tracking-en-table', group: 'phase2', path: blog('sales-rep-tracking-saudi', 'en.contentHtml'),
    from: '<td>Simplified invoice with QR, Phase 1 (Generation)</td>',
    to: '<td>Simplified QR invoice; we support Phase 2 integration with ZATCA’s Fatoora platform</td>',
  },
  {
    id: 'rep-tracking-en-h2', group: 'phase2', path: blog('sales-rep-tracking-saudi', 'en.contentHtml'),
    from: '<h2>What we do not claim</h2>',
    to: '<h2>What we support, and what we do not claim</h2>',
  },
  {
    id: 'rep-tracking-en-denial', group: 'phase2', path: blog('sales-rep-tracking-saudi', 'en.contentHtml'),
    from: '<p>Phase 2 (Integration) of ZATCA e-invoicing is <strong>not built yet</strong> — we say that plainly. ZATCA does not certify software vendors, so no vendor should claim its endorsement. What you get today is a complete Phase-1 field invoicing and tracking cycle that your reps will actually use, in their language.</p>',
    to: `<p>${P2_EN} ${LIMIT_EN} ZATCA does not certify software vendors, so no vendor should claim its endorsement. What you get is a complete field invoicing and tracking cycle that your reps will actually use, in their language.</p>`,
  },
  {
    id: 'rep-tracking-en-price', group: 'price', path: blog('sales-rep-tracking-saudi', 'en.contentHtml'),
    from: '<td>Per company: SAR 299/month up to 5 reps, SAR 599 up to 20</td>',
    to: '<td>Per company: SAR 299/month up to 5 reps, SAR 399 up to 10, SAR 599 up to 20</td>',
  },

  // ═══ van-sales-software-saudi ═══
  {
    id: 'van-sales-ar', group: 'phase2', path: blog('van-sales-software-saudi', 'contentHtml'),
    from: 'بيع وفوترة <a href="/blog/offline-invoicing-for-reps/">أوف-لاين</a> برمز QR (المرحلة الأولى)، <a href="/blog/thermal-printing-field-invoices/">طباعة حرارية</a>، تحصيل فوري، ومطابقة مسائية تكشف أي فرق بالصنف.</p>',
    to: `بيع وفوترة <a href="/blog/offline-invoicing-for-reps/">أوف-لاين</a> برمز QR، <a href="/blog/thermal-printing-field-invoices/">طباعة حرارية</a>، تحصيل فوري، ومطابقة مسائية تكشف أي فرق بالصنف. ونحن ${P2}، ${LIMIT}</p>`,
  },
  {
    id: 'van-sales-en-desc', group: 'phase2', path: blog('van-sales-software-saudi', 'en.description'),
    from: 'offline invoicing with Phase-1 QR codes, Bluetooth thermal printing, per-item van stock reconciliation, and an Arabic-first rep app.',
    to: `QR invoicing from the rep phone, Bluetooth thermal printing, per-item van stock reconciliation and an Arabic-first rep app. ${P2_EN}`,
  },
  {
    id: 'van-sales-en-intro', group: 'phase2', path: blog('van-sales-software-saudi', 'en.contentHtml'),
    from: '<strong>FieldSales</strong> runs this exact cycle Arabic-first, offline-first, with simplified QR invoices under Phase 1 (the Generation phase) of ZATCA e-invoicing.</p>',
    to: '<strong>FieldSales</strong> runs this exact cycle Arabic-first, with simplified QR invoices, and we support Phase 2 integration with ZATCA’s Fatoora platform.</p>',
  },
  {
    id: 'van-sales-en-table', group: 'phase2', path: blog('van-sales-software-saudi', 'en.contentHtml'),
    from: '<td>Simplified invoice with QR under Phase 1 — printed at the door?</td>',
    to: '<td>Simplified QR invoice printed at the door — and Phase 2 integration with ZATCA’s Fatoora platform?</td>',
  },
  {
    id: 'van-sales-en-price', group: 'price', path: blog('van-sales-software-saudi', 'en.contentHtml'),
    from: 'Ours: SAR 299/month up to 5 reps, SAR 599 up to 20 — public, VAT included.',
    to: 'Ours: SAR 299/month up to 5 reps, SAR 399 up to 10, SAR 599 up to 20 — public, VAT included.',
  },
  {
    id: 'van-sales-en-denial', group: 'phase2', path: blog('van-sales-software-saudi', 'en.contentHtml'),
    from: '<p>ZATCA Phase 2 (Integration) is not built yet, and ZATCA does not certify vendors — treat any such claim, from anyone, with caution. What ships today is the complete Phase-1 van sales cycle above, live in production.</p>',
    to: `<p>We support Phase 2 integration with ZATCA’s Fatoora platform, and ZATCA does not certify vendors — treat any certification claim, from anyone, with caution. ${LIMIT_EN} The van sales cycle above is live in production.</p>`,
  },

  // ═══ dms-saudi-arabia ═══
  {
    id: 'dms-ar', group: 'phase2', path: blog('dms-saudi-arabia', 'contentHtml'),
    from: 'وفاتورة مبسّطة برمز QR من الميدان وفق المرحلة الأولى،',
    to: 'وفاتورة مبسّطة برمز QR من الميدان، وربطاً للمرحلة الثانية مع منصة فاتورة،',
  },
  {
    id: 'dms-en-desc', group: 'phase2', path: blog('dms-saudi-arabia', 'en.description'),
    from: 'offline Phase-1 QR invoicing,',
    to: 'QR invoicing with Phase 2 integration with ZATCA’s Fatoora platform,',
  },
  {
    id: 'dms-en-excerpt', group: 'phase2', path: blog('dms-saudi-arabia', 'en.excerpt'),
    from: 'cash vans and Phase-1 e-invoicing.',
    to: 'cash vans and ZATCA e-invoicing.',
  },
  {
    id: 'dms-en-intro', group: 'phase2', path: blog('dms-saudi-arabia', 'en.contentHtml'),
    from: 'the rep sells and invoices from a phone — offline if needed, with a simplified QR invoice under Phase 1 (the Generation phase) of e-invoicing —',
    to: 'the rep sells and invoices from a phone with a simplified QR invoice — offline if needed, except for companies with Phase 2 integration enabled, where invoices (standard and simplified) and returns need a connection at the moment of issue —',
  },
  {
    id: 'dms-en-price', group: 'price', path: blog('dms-saudi-arabia', 'en.contentHtml'),
    from: 'SAR 299/month up to 5 reps, SAR 599 up to 20, VAT included.',
    to: 'SAR 299/month up to 5 reps, SAR 399 up to 10, SAR 599 up to 20, VAT included.',
  },
  {
    id: 'dms-en-needs', group: 'phase2', path: blog('dms-saudi-arabia', 'en.contentHtml'),
    from: 'invoices that satisfy the local Phase-1 requirement out of the box,',
    to: 'QR invoices from the field plus Phase 2 integration with ZATCA’s Fatoora platform,',
  },
  {
    id: 'dms-en-table', group: 'phase2', path: blog('dms-saudi-arabia', 'en.contentHtml'),
    from: '<td>Phase-1 QR invoices from the field</td>',
    to: '<td>QR invoices from the field and Phase 2 integration with Fatoora</td>',
  },
  {
    id: 'dms-en-denial', group: 'phase2', path: blog('dms-saudi-arabia', 'en.contentHtml'),
    from: '<p>ZATCA Phase 2 (Integration) is not built yet, and ZATCA certifies no vendor. Everything else above is live in production today —',
    to: `<p>We support Phase 2 integration with ZATCA’s Fatoora platform, and ZATCA certifies no vendor. ${LIMIT_EN} Everything above is live in production —`,
  },

  // ═══ zatca-invoicing-for-field-reps ═══
  {
    id: 'zatca-reps-title', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'title'),
    from: 'فاتورة المرحلة الأولى من الميدان: دليل مناديب التوزيع',
    to: 'فاتورة ZATCA من الميدان: دليل مناديب التوزيع',
  },
  {
    id: 'zatca-reps-desc', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'description'),
    from: 'كيف يُصدر المندوب فاتورة مبسّطة برمز QR وفق المرحلة الأولى من جواله — أوف-لاين وبطباعة حرارية، مع حدود صريحة لما هو غير مبنيّ.',
    to: `كيف يُصدر المندوب فاتورة مبسّطة برمز QR من جواله بطباعة حرارية، ونحن ${P2}.`,
  },
  {
    id: 'zatca-reps-keywords', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'keywords'),
    from: 'المرحلة الأولى فاتورة',
    to: 'فاتورة المرحلة الثانية',
  },
  {
    id: 'zatca-reps-excerpt', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'excerpt'),
    from: 'متطلبات الفوترة الإلكترونية (المرحلة الأولى)',
    to: 'متطلبات الفوترة الإلكترونية بمرحلتيها',
  },
  {
    id: 'zatca-reps-denial', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'contentHtml'),
    from: '<p>المرحلة الثانية (الربط والتكامل) <strong>غير مبنية لدينا حتى الآن</strong>، والهيئة لا تعتمد ولا تصادق مزوّدي البرمجيات فلا ندّعي اعتماداً — وننصحك بالحذر من أي ادّعاء اعتماد أياً كان مصدره. ما نقدّمه اليوم هو دورة المرحلة الأولى الميدانية الكاملة أعلاه، حيّة في الإنتاج.',
    to: `<p><strong>${P2}</strong> (مرحلة الربط والتكامل). ${LIMIT} والهيئة لا تعتمد ولا تصادق مزوّدي البرمجيات فلا ندّعي اعتماداً — وننصحك بالحذر من أي ادّعاء اعتماد أياً كان مصدره. والدورة الميدانية الكاملة أعلاه حيّة في الإنتاج.`,
  },
  {
    id: 'zatca-reps-en-title', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'en.title'),
    from: 'ZATCA E-Invoicing for Van Sales Reps: Offline QR Invoices',
    to: 'ZATCA E-Invoicing for Van Sales Reps: QR Invoices and Phase 2 Integration',
  },
  {
    id: 'zatca-reps-en-desc', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'en.description'),
    from: 'How field reps issue simplified Phase-1 (Generation) QR invoices from a phone — offline, thermally printed at the customer — and what is honestly not built (Phase 2).',
    to: `How field reps issue simplified QR tax invoices from a phone, thermally printed at the customer. ${P2_EN}`,
  },
  {
    id: 'zatca-reps-en-excerpt', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'en.excerpt'),
    from: 'How does Phase-1 e-invoicing actually work',
    to: 'How does ZATCA e-invoicing actually work',
  },
  {
    id: 'zatca-reps-en-keywords', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'en.keywords'),
    from: 'phase 1 generation invoicing, offline zatca invoice',
    to: 'zatca phase 2 integration, fatoora integration for reps',
  },
  {
    id: 'zatca-reps-en-h2', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'en.contentHtml'),
    from: '<h2>What is honestly not built</h2>',
    to: '<h2>Phase 2 integration</h2>',
  },
  {
    id: 'zatca-reps-en-denial', group: 'phase2', path: blog('zatca-invoicing-for-field-reps', 'en.contentHtml'),
    from: '<p><strong>Phase 2 (Integration) is not built in FieldSales yet.</strong> We state that plainly because ZATCA does not certify or endorse software vendors, and compliance claims should be treated skeptically from any vendor. What ships today — and has shipped invoices in production — is the complete Phase-1 field cycle described above.</p>',
    to: `<p><strong>FieldSales supports Phase 2 integration with ZATCA’s Fatoora platform.</strong> ${LIMIT_EN} ZATCA does not certify or endorse software vendors, so compliance claims should be treated skeptically from any vendor. The field cycle described above is live in production.</p>`,
  },
  {
    id: 'zatca-reps-en-price', group: 'price', path: blog('zatca-invoicing-for-field-reps', 'en.contentHtml'),
    from: 'Pricing is public: SAR 299/month up to 5 reps, SAR 599 up to 20 — whole company, VAT included',
    to: 'Pricing is public: SAR 299/month up to 5 reps, SAR 399 up to 10, SAR 599 up to 20 — whole company, VAT included',
  },

  // ═══ distribution-owners-questions ═══
  {
    id: 'owners-questions', group: 'phase2', path: blog('distribution-owners-questions', 'contentHtml'),
    from: '(المرحلة الثانية — الربط والتكامل — شأن آخر، وغير مبنية لدينا حتى الآن.)',
    to: `(ونحن ${P2}، ${LIMIT.replace(/\.$/, '')}.)`,
  },

  // ═══ barcode-scanning-invoices ═══
  {
    id: 'barcode', group: 'phase2', path: blog('barcode-scanning-invoices', 'contentHtml'),
    from: 'وفاتورتك أنت تصدر برمز QR وفق المرحلة الأولى.',
    to: `وفاتورتك أنت تصدر برمز QR، ونحن ${P2}.`,
  },

  // ═══ paper-to-digital-invoicing ═══
  {
    id: 'paper-desc', group: 'phase2', path: blog('paper-to-digital-invoicing', 'description'),
    from: 'وبفاتورة QR وفق المرحلة الأولى.',
    to: 'وبفاتورة برمز QR.',
  },
  {
    id: 'paper-intro', group: 'phase2', path: blog('paper-to-digital-invoicing', 'contentHtml'),
    from: 'برمز QR وفق المرحلة الأولى (مرحلة الإصدار)، وتصل الإدارة فوراً، <a href="/blog/offline-invoicing-for-reps/">حتى بلا إنترنت</a> — ودفترُ الكربون إلى الأرشيف.</p>',
    to: `برمز QR وتصل الإدارة فوراً، <a href="/blog/offline-invoicing-for-reps/">حتى بلا إنترنت</a> — ودفترُ الكربون إلى الأرشيف. ونحن ${P2}، ${LIMIT}</p>`,
  },
  {
    id: 'paper-table', group: 'phase2', path: blog('paper-to-digital-invoicing', 'contentHtml'),
    from: '<td>منظّمة برمز QR (المرحلة الأولى)</td>',
    to: '<td>منظّمة برمز QR</td>',
  },

  // ═══ offline-invoicing-for-reps ═══
  {
    id: 'offline-intro', group: 'offline', path: blog('offline-invoicing-for-reps', 'contentHtml'),
    from: 'كل فاتورة تحمل رمز QR للفاتورة المبسّطة وفق المرحلة الأولى (مرحلة الإصدار)، وتُطبع حرارياً في مكان البيع، متصلاً كنت أم لا.</p>',
    to: 'كل فاتورة تحمل رمز QR للفاتورة المبسّطة وتُطبع حرارياً في مكان البيع، متصلاً كنت أم لا — إلا في الشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة، فالفواتير (القياسية والمبسّطة) والمرتجعات فيها تحتاج اتصالاً لحظة الإصدار.</p>',
  },
  {
    id: 'offline-qr-denial', group: 'phase2', path: blog('offline-invoicing-for-reps', 'contentHtml'),
    from: '<p>الفاتورة الصادرة أوف-لاين ليست «مسودة»: تصدر مكتملة البيانات برمز QR للفاتورة المبسّطة وفق <strong>المرحلة الأولى (مرحلة الإصدار)</strong> من الفوترة الإلكترونية، وتُطبع للعميل في مكانه عبر <a href="/blog/thermal-printing-field-invoices/">طابعة حرارية بالبلوتوث</a>. أما المرحلة الثانية (الربط والتكامل) فغير مبنية لدينا حتى الآن — نذكر ذلك بوضوح لأن الدقة في هذا الباب التزام لا خيار.</p>',
    to: `<p>الفاتورة الصادرة أوف-لاين ليست «مسودة»: تصدر مكتملة البيانات برمز QR للفاتورة المبسّطة، وتُطبع للعميل في مكانه عبر <a href="/blog/thermal-printing-field-invoices/">طابعة حرارية بالبلوتوث</a>. ونحن ${P2}، ${LIMIT.replace(/\.$/, '')} — نذكر ذلك بوضوح لأن الدقة في هذا الباب التزام لا خيار.</p>`,
  },
  {
    id: 'offline-price', group: 'price', path: blog('offline-invoicing-for-reps', 'contentHtml'),
    from: '(حتى 5 مناديب) و599 ر.س (حتى 20 مندوباً)',
    to: '(حتى 5 مناديب)، و399 ر.س (حتى 10 مناديب)، و599 ر.س (حتى 20 مندوباً)',
  },

  // ═══ thermal-printing-field-invoices ═══
  {
    id: 'thermal-intro', group: 'offline', path: blog('thermal-printing-field-invoices', 'contentHtml'),
    from: 'في منصّة FieldSales تخرج الفاتورة مكتملة برمز QR للفاتورة المبسّطة وفق المرحلة الأولى (مرحلة الإصدار)، ويعمل الإصدار والطباعة حتى <a href="/blog/offline-invoicing-for-reps/">بلا إنترنت</a> — لأن البيع الميداني لا ينتظر تغطية ولا مكتباً.</p>',
    to: 'في منصّة FieldSales تخرج الفاتورة مكتملة برمز QR للفاتورة المبسّطة، ويعمل الإصدار والطباعة حتى <a href="/blog/offline-invoicing-for-reps/">بلا إنترنت</a> — لأن البيع الميداني لا ينتظر تغطية ولا مكتباً. وللشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة تحتاج الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار، ثم تُطبع من الجهاز بلا إنترنت.</p>',
  },
  {
    id: 'thermal-denial', group: 'phase2', path: blog('thermal-printing-field-invoices', 'contentHtml'),
    from: 'ورمز QR وفق المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية — وهو ما يفعله التطبيق مع كل فاتورة، ورقية الطباعة أو مرسلة رقمياً. (المرحلة الثانية — الربط والتكامل — غير مبنية لدينا حتى الآن، ونذكر ذلك صراحةً.)',
    to: `ورمز QR — وهو ما يفعله التطبيق مع كل فاتورة، ورقية الطباعة أو مرسلة رقمياً. (ونحن ${P2}؛ وللشركات المفعّل لها الربط تحتاج الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار ثم تُطبع من الجهاز.)`,
  },

  // ═══ distributor-network-management-software ═══
  {
    id: 'distributor-sw-table', group: 'phase2', path: blog('distributor-network-management-software', 'contentHtml'),
    from: '<td>هل تصدر وفق المرحلة الأولى (مرحلة الإصدار)؟</td>',
    to: '<td>هل تصدر برمز QR، وهل يدعم النظام ربط المرحلة الثانية مع منصة فاتورة؟</td>',
  },
  {
    id: 'distributor-sw-day', group: 'offline', path: blog('distributor-network-management-software', 'contentHtml'),
    from: 'وكل فاتورة تحمل رمز QR للفاتورة المبسّطة وفق المرحلة الأولى (مرحلة الإصدار).',
    to: 'وكل فاتورة تحمل رمز QR للفاتورة المبسّطة (وللشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة تحتاج الفواتير القياسية والمبسّطة والمرتجعات اتصالاً لحظة الإصدار).',
  },
  {
    id: 'distributor-sw-offline-faq', group: 'offline', path: blog('distributor-network-management-software', 'contentHtml'),
    from: 'فلا يتوقف بيع الموزع في الطرق البعيدة والمستودعات.</p>',
    to: `فلا يتوقف بيع الموزع في الطرق البعيدة والمستودعات. ${LIMIT_FULL}</p>`,
  },
  {
    id: 'distributor-sw-faq', group: 'phase2', path: blog('distributor-network-management-software', 'contentHtml'),
    from: '<p>يُصدر النظام فاتورة ضريبية مبسّطة برمز QR وفق المرحلة الأولى (مرحلة الإصدار) من متطلبات الفوترة الإلكترونية، وتُطبع للعميل في الموقع عبر الطابعة الحرارية.</p>',
    to: `<p>يُصدر النظام فاتورة ضريبية مبسّطة برمز QR تُطبع للعميل في الموقع عبر الطابعة الحرارية، ونحن ${P2}.</p>`,
  },
  {
    id: 'distributor-sw-price', group: 'price', path: blog('distributor-network-management-software', 'contentHtml'),
    from: '<strong>299 ر.س شهرياً</strong> (حتى 5 مناديب أو موزعين) أو <strong>599 ر.س شهرياً</strong> (حتى 20)',
    to: '<strong>299 ر.س شهرياً</strong> (حتى 5 مناديب أو موزعين)، أو <strong>399 ر.س شهرياً</strong> (حتى 10)، أو <strong>599 ر.س شهرياً</strong> (حتى 20)',
  },

  // ═══ cash-van-software-guide ═══
  {
    id: 'cash-guide-credit', group: 'credit', path: blog('cash-van-software-guide', 'contentHtml'),
    from: 'والنظام يتحقّق تلقائياً من حدّ الائتمان قبل السماح بأي بيع آجل.',
    to: 'والنظام ينبّه الإدارة فوراً إن تجاوزت فاتورة آجلة حدّ ائتمان العميل.',
  },
  {
    id: 'cash-guide-li', group: 'offline', path: blog('cash-van-software-guide', 'contentHtml'),
    from: 'تصدر الفاتورة من الجوال وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، وإن انقطع الاتصال تُحفَظ على الجهاز وترتفع تلقائياً عند عودته.</li>',
    to: 'تصدر الفاتورة من الجوال، وإن انقطع الاتصال تُحفَظ على الجهاز وترتفع تلقائياً عند عودته — إلا في الشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة، فالفواتير (القياسية والمبسّطة) والمرتجعات فيها تحتاج اتصالاً لحظة الإصدار.</li>',
  },
  {
    id: 'cash-guide-table', group: 'phase2', path: blog('cash-van-software-guide', 'contentHtml'),
    from: '<td>رمز QR وفق المرحلة الأولى (مرحلة الإصدار) على كل فاتورة</td>',
    to: '<td>رمز QR على كل فاتورة، وربط المرحلة الثانية مع منصة فاتورة</td>',
  },
  {
    id: 'cash-guide-offline-faq', group: 'offline', path: blog('cash-van-software-guide', 'contentHtml'),
    from: 'ثم ترتفع تلقائياً حين يعود الاتصال — بلا أي خطوة يدوية.</p>',
    to: `ثم ترتفع تلقائياً حين يعود الاتصال — بلا أي خطوة يدوية. ${LIMIT_FULL}</p>`,
  },
  {
    id: 'cash-guide-faq', group: 'phase2', path: blog('cash-van-software-guide', 'contentHtml'),
    from: '<p>يُصدر النظام فاتورة ضريبية مبسّطة برمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية.</p>',
    to: `<p>يُصدر النظام فاتورة ضريبية مبسّطة برمز QR، ونحن ${P2}.</p>`,
  },
  {
    id: 'cash-guide-credit-mistake', group: 'credit', path: blog('cash-van-software-guide', 'contentHtml'),
    from: 'اضبط حدّاً لكل عميل ودع النظام يمنع تجاوزه تلقائياً — قاعدة نظام لا مجاملة بشرية.',
    to: 'اضبط حدّاً لكل عميل ودع النظام ينبّه الإدارة فور تجاوزه، وامنح صلاحية البيع الآجل لمن يستحقها من المناديب فقط — قاعدة نظام لا مجاملة بشرية.',
  },
  {
    id: 'cash-guide-price', group: 'price', path: blog('cash-van-software-guide', 'contentHtml'),
    from: '299 ر.س شهرياً حتى 5 مناديب، و599 ر.س حتى 20 مندوباً — للشركة كاملة وشاملة الضريبة',
    to: '299 ر.س شهرياً حتى 5 مناديب، و399 ر.س حتى 10، و599 ر.س حتى 20 مندوباً — للشركة كاملة وشاملة الضريبة',
  },

  // ═══ cash-van-software-saudi ═══
  {
    id: 'cash-saudi-title', group: 'phase2', path: blog('cash-van-software-saudi', 'title'),
    from: 'برنامج كاش فان في السعودية: فاتورة QR مبسطة وعمل أوف-لاين',
    to: 'برنامج كاش فان في السعودية: فاتورة QR وربط المرحلة الثانية مع منصة فاتورة',
  },
  {
    id: 'cash-saudi-intro', group: 'offline', path: blog('cash-van-software-saudi', 'contentHtml'),
    from: 'يُصدر مندوبك فاتورة ضريبية مبسّطة برمز QR وفق المرحلة الأولى (مرحلة الإصدار) بضريبة قيمة مضافة 15% محسوبة تلقائياً، ويعمل أوف-لاين بالكامل في الطرق الطويلة والمناطق ضعيفة التغطية ثم يرفع العمليات وحده عند عودة الاتصال، ويطبع الفاتورة حرارياً عبر البلوتوث عند باب العميل.',
    to: `يُصدر مندوبك فاتورة ضريبية مبسّطة برمز QR بضريبة قيمة مضافة 15% محسوبة تلقائياً، ونحن ${P2}. ويعمل التطبيق أوف-لاين في الطرق الطويلة والمناطق ضعيفة التغطية ثم يرفع العمليات وحده عند عودة الاتصال (عدا الفواتير القياسية والمبسّطة والمرتجعات في الشركات المفعّل لها الربط، فتحتاج اتصالاً لحظة الإصدار)، ويطبع الفاتورة حرارياً عبر البلوتوث عند باب العميل.`,
  },
  {
    id: 'cash-saudi-price-intro', group: 'price', path: blog('cash-van-software-saudi', 'contentHtml'),
    from: '299 ر.س شهرياً حتى 5 مناديب أو 599 ر.س حتى 20 — للشركة كاملة شاملة الضريبة',
    to: '299 ر.س شهرياً حتى 5 مناديب، أو 399 ر.س حتى 10، أو 599 ر.س حتى 20 — للشركة كاملة شاملة الضريبة',
  },
  {
    id: 'cash-saudi-vat', group: 'phase2', path: blog('cash-van-software-saudi', 'contentHtml'),
    from: 'تحمل رمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، مع حساب',
    to: 'تحمل رمز QR، مع حساب',
  },
  {
    id: 'cash-saudi-offline', group: 'offline', path: blog('cash-van-software-saudi', 'contentHtml'),
    from: 'بلا زر «مزامنة» ولا خطوة يدوية ينساها أحد.',
    to: `بلا زر «مزامنة» ولا خطوة يدوية ينساها أحد. ${LIMIT_FULL}`,
  },
  {
    id: 'cash-saudi-table', group: 'phase2', path: blog('cash-van-software-saudi', 'contentHtml'),
    from: '<td>هل يظهر رمز QR وفق المرحلة الأولى (مرحلة الإصدار) على كل فاتورة؟</td>',
    to: '<td>هل يظهر رمز QR على كل فاتورة، وهل يدعم البرنامج ربط المرحلة الثانية مع منصة فاتورة؟</td>',
  },
  {
    id: 'cash-saudi-price', group: 'price', path: blog('cash-van-software-saudi', 'contentHtml'),
    from: '299 ر.س شهرياً حتى 5 مناديب، و599 ر.س شهرياً حتى 20 مندوباً',
    to: '299 ر.س شهرياً حتى 5 مناديب، و399 ر.س شهرياً حتى 10، و599 ر.س شهرياً حتى 20 مندوباً',
  },
  {
    id: 'cash-saudi-price-faq', group: 'price', path: blog('cash-van-software-saudi', 'contentHtml'),
    from: '299 ر.س تغطي حتى 5 مناديب و599 ر.س حتى 20 مندوباً',
    to: '299 ر.س تغطي حتى 5 مناديب، و399 ر.س حتى 10، و599 ر.س حتى 20 مندوباً',
  },
  {
    id: 'cash-saudi-summary', group: 'phase2', path: blog('cash-van-software-saudi', 'contentHtml'),
    from: 'فاتورة مبسّطة برمز QR وفق المرحلة الأولى،',
    to: 'فاتورة مبسّطة برمز QR،',
  },

  // ═══ sales-reps-management-system ═══
  {
    id: 'reps-system-offline', group: 'offline', path: blog('sales-reps-management-system', 'contentHtml'),
    from: 'تُحفَظ العمليات على الجهاز وترتفع تلقائياً إلى النظام فور عودة الاتصال، دون تكرار ودون فقد.</p>',
    to: `تُحفَظ العمليات على الجهاز وترتفع تلقائياً إلى النظام فور عودة الاتصال، دون تكرار ودون فقد. ${LIMIT_FULL}</p>`,
  },
  {
    id: 'reps-system-qr', group: 'phase2', path: blog('sales-reps-management-system', 'contentHtml'),
    from: 'تحمل رمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، ويطبعها المندوب',
    to: 'تحمل رمز QR، ويطبعها المندوب',
  },
  {
    id: 'reps-system-table', group: 'phase2', path: blog('sales-reps-management-system', 'contentHtml'),
    from: '<td>هل تحمل رمز QR وفق المرحلة الأولى (مرحلة الإصدار)؟</td>',
    to: '<td>هل تحمل رمز QR، وهل يدعم النظام ربط المرحلة الثانية مع منصة فاتورة؟</td>',
  },
  {
    id: 'reps-system-price', group: 'price', path: blog('sales-reps-management-system', 'contentHtml'),
    from: 'حتى 5 مناديب، و599 ريالاً حتى 20 مندوباً، شاملة الضريبة، والسعر للشركة كلها',
    to: 'حتى 5 مناديب، و399 ريالاً حتى 10، و599 ريالاً حتى 20 مندوباً، شاملة الضريبة، والسعر للشركة كلها',
  },
  {
    id: 'reps-system-price-faq', group: 'price', path: blog('sales-reps-management-system', 'contentHtml'),
    from: 'تغطي حتى 5 مناديب مهما تبدّلوا، و599 ريالاً حتى 20 مندوباً',
    to: 'تغطي حتى 5 مناديب مهما تبدّلوا، و399 ريالاً حتى 10، و599 ريالاً حتى 20 مندوباً',
  },
  {
    id: 'reps-system-offline-faq', group: 'offline', path: blog('sales-reps-management-system', 'contentHtml'),
    from: 'فلا يتوقف العمل في المستودعات أو المناطق ضعيفة التغطية.</p>',
    to: 'فلا يتوقف العمل في المستودعات أو المناطق ضعيفة التغطية. وللشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة تحتاج الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار.</p>',
  },
  {
    id: 'reps-system-faq', group: 'phase2', path: blog('sales-reps-management-system', 'contentHtml'),
    from: '<p>نعم، يُصدر النظام فاتورة ضريبية مبسّطة برمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، وتُطبع حرارياً عبر البلوتوث من جوال المندوب.</p>',
    to: `<p>نعم، يُصدر النظام فاتورة ضريبية مبسّطة برمز QR تُطبع حرارياً عبر البلوتوث من جوال المندوب، ونحن ${P2}.</p>`,
  },

  // ═══ sales-reps-management-saudi ═══
  {
    id: 'reps-saudi-intro', group: 'phase2', path: blog('sales-reps-management-saudi', 'contentHtml'),
    from: 'برمز QR وفق المرحلة الأولى (مرحلة الإصدار) تصدر من جوال المندوب،',
    to: 'برمز QR تصدر من جوال المندوب،',
  },
  {
    id: 'reps-saudi-grocery', group: 'phase2', path: blog('sales-reps-management-saudi', 'contentHtml'),
    from: 'تحمل رمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية. عملياً',
    to: 'تحمل رمز QR وفق متطلبات الفوترة الإلكترونية. عملياً',
  },
  {
    id: 'reps-saudi-table', group: 'phase2', path: blog('sales-reps-management-saudi', 'contentHtml'),
    from: '<td>متطلبات المرحلة الأولى من الفوترة الإلكترونية</td>',
    to: '<td>متطلبات الفوترة الإلكترونية بمرحلتيها</td>',
  },
  {
    id: 'reps-saudi-offline-faq', group: 'offline', path: blog('sales-reps-management-saudi', 'contentHtml'),
    from: 'وترتفع تلقائياً إلى النظام فور عودة الاتصال دون أي إجراء يدوي.</p>',
    to: 'وترتفع تلقائياً إلى النظام فور عودة الاتصال دون أي إجراء يدوي. وللشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة تحتاج الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار.</p>',
  },
  {
    id: 'reps-saudi-faq', group: 'phase2', path: blog('sales-reps-management-saudi', 'contentHtml'),
    from: '<p>نعم؛ فاتورة ضريبية مبسّطة برمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، تُطبع في موقع العميل عبر طابعة حرارية بالبلوتوث.</p>',
    to: `<p>نعم؛ فاتورة ضريبية مبسّطة برمز QR تُطبع في موقع العميل عبر طابعة حرارية بالبلوتوث، ونحن ${P2}.</p>`,
  },
  {
    id: 'reps-saudi-price', group: 'price', path: blog('sales-reps-management-saudi', 'contentHtml'),
    from: 'حتى 5 مناديب، و599 ريالاً حتى 20 مندوباً — شاملة الضريبة',
    to: 'حتى 5 مناديب، و399 ريالاً حتى 10، و599 ريالاً حتى 20 مندوباً — شاملة الضريبة',
  },

  // ═══ distribution-companies-management-system ═══
  {
    id: 'dist-companies-credit', group: 'credit', path: blog('distribution-companies-management-system', 'contentHtml'),
    from: 'ويضبط <strong>حدّ ائتمان لكل عميل</strong> يمنع المندوب تلقائياً من البيع الآجل عند تجاوزه،',
    to: 'ويضبط <strong>حدّ ائتمان لكل عميل</strong> وينبّه الإدارة فور تجاوزه،',
  },
  {
    id: 'dist-companies-offline', group: 'offline', path: blog('distribution-companies-management-system', 'contentHtml'),
    from: 'وفي السوق السعودي يجب أن تحمل الفاتورة المبسّطة رمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية.</p>',
    to: `وفي السوق السعودي يجب أن تحمل الفاتورة المبسّطة رمز QR وفق متطلبات الفوترة الإلكترونية. وفي FieldSales ${P2}، ${LIMIT}</p>`,
  },
  {
    id: 'dist-companies-table', group: 'phase2', path: blog('distribution-companies-management-system', 'contentHtml'),
    from: '<td>نسبة ضريبة بلدك، ورمز QR للفاتورة المبسّطة في السعودية (المرحلة الأولى)</td>',
    to: '<td>نسبة ضريبة بلدك، ورمز QR للفاتورة المبسّطة وربط المرحلة الثانية مع منصة فاتورة في السعودية</td>',
  },
  {
    id: 'dist-companies-vat', group: 'phase2', path: blog('distribution-companies-management-system', 'contentHtml'),
    from: 'رمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية. تأكّد أن النظام',
    to: 'رمز QR وفق متطلبات الفوترة الإلكترونية، وتُبلَّغ إلى منصة فاتورة في المرحلة الثانية. تأكّد أن النظام',
  },
  {
    id: 'dist-companies-offline-faq', group: 'offline', path: blog('distribution-companies-management-system', 'contentHtml'),
    from: '— بلا مزامنة يدوية وبلا مستند مفقود.</p>',
    to: `— بلا مزامنة يدوية وبلا مستند مفقود. ${LIMIT_FULL}</p>`,
  },
  {
    id: 'dist-companies-price', group: 'price', path: blog('distribution-companies-management-system', 'contentHtml'),
    from: '299 ريالاً شهرياً حتى 5 مناديب، و599 ريالاً حتى 20 مندوباً — للشركة كاملة وشاملاً الضريبة',
    to: '299 ريالاً شهرياً حتى 5 مناديب، و399 ريالاً حتى 10، و599 ريالاً حتى 20 مندوباً — للشركة كاملة وشاملاً الضريبة',
  },
  {
    id: 'dist-companies-price-end', group: 'price', path: blog('distribution-companies-management-system', 'contentHtml'),
    from: '299 ريالاً شهرياً حتى 5 مناديب، و599 ريالاً حتى 20 مندوباً، للشركة كاملة وشاملةً الضريبة',
    to: '299 ريالاً شهرياً حتى 5 مناديب، و399 ريالاً حتى 10، و599 ريالاً حتى 20 مندوباً، للشركة كاملة وشاملةً الضريبة',
  },

  // ═══ field-sales-system-for-companies ═══
  {
    id: 'field-companies-intro', group: 'phase2', path: blog('field-sales-system-for-companies', 'contentHtml'),
    from: 'ويطبع فاتورة ضريبية مبسّطة برمز QR وفق المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية عبر طابعة حرارية بالبلوتوث،',
    to: 'ويطبع فاتورة ضريبية مبسّطة برمز QR عبر طابعة حرارية بالبلوتوث،',
  },
  {
    id: 'field-companies-li', group: 'offline', path: blog('field-sales-system-for-companies', 'contentHtml'),
    from: 'يصدر المندوب من جواله فاتورة ضريبية مبسّطة برمز QR وفق المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، ويطبعها للعميل عبر طابعة حرارية بالبلوتوث قبل مغادرة الموقع. وإن انقطع الإنترنت صدرت الفاتورة أوف-لاين وارتفعت تلقائياً عند عودة الاتصال.',
    to: 'يصدر المندوب من جواله فاتورة ضريبية مبسّطة برمز QR، ويطبعها للعميل عبر طابعة حرارية بالبلوتوث قبل مغادرة الموقع. وإن انقطع الإنترنت صدرت الفاتورة أوف-لاين وارتفعت تلقائياً عند عودة الاتصال — إلا في الشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة، فالفواتير (القياسية والمبسّطة) والمرتجعات فيها تحتاج اتصالاً لحظة الإصدار.',
  },
  {
    id: 'field-companies-credit', group: 'credit', path: blog('field-sales-system-for-companies', 'contentHtml'),
    from: 'ويمنع النظام البيع الآجل لعميل تجاوز حدّ ائتمانه.',
    to: 'وينبّه النظام الإدارة فوراً حين تتجاوز فاتورة آجلة حدّ ائتمان العميل.',
  },
  {
    id: 'field-companies-price', group: 'price', path: blog('field-sales-system-for-companies', 'contentHtml'),
    from: '299 ريالاً شهرياً للشركة كاملة حتى 5 مناديب، و599 ريالاً شهرياً حتى 20 مندوباً، شاملة الضريبة',
    to: '299 ريالاً شهرياً للشركة كاملة حتى 5 مناديب، و399 ريالاً شهرياً حتى 10، و599 ريالاً شهرياً حتى 20 مندوباً، شاملة الضريبة',
  },
  {
    id: 'field-companies-offline-faq', group: 'offline', path: blog('field-sales-system-for-companies', 'contentHtml'),
    from: 'دون أي إجراء يدوي منه ودون فقد أي عملية.</p>',
    to: `دون أي إجراء يدوي منه ودون فقد أي عملية. ${LIMIT_FULL}</p>`,
  },
  {
    id: 'field-companies-faq', group: 'phase2', path: blog('field-sales-system-for-companies', 'contentHtml'),
    from: '<p>يصدر النظام فاتورة ضريبية مبسّطة تتضمن رمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، وتُطبع للعميل في موقعه عبر الطابعة الحرارية.</p>',
    to: `<p>يصدر النظام فاتورة ضريبية مبسّطة تتضمن رمز QR وتُطبع للعميل في موقعه عبر الطابعة الحرارية، ونحن ${P2}.</p>`,
  },
  {
    id: 'field-companies-price-end', group: 'price', path: blog('field-sales-system-for-companies', 'contentHtml'),
    from: '299 ريالاً شهرياً حتى 5 مناديب أو 599 ريالاً حتى 20 مندوباً، شاملة الضريبة للشركة كاملة',
    to: '299 ريالاً شهرياً حتى 5 مناديب، أو 399 ريالاً حتى 10، أو 599 ريالاً حتى 20 مندوباً، شاملة الضريبة للشركة كاملة',
  },

  // ═══ field-sales-software-market-report-2026 ═══
  // شركة العشرة مناديب على باقة 399 (حتى 10) لا 599: 399×12 أقل من ربع 20,800 ⇒ وفر ≈ 77% في السنة الأولى.
  // لا يُكتب رقم سنوي لباقاتنا (عروض الأسعار تعرض سنوياً مختلفاً) — المقارنة بالنسبة لا بمجموع سنوي.
  {
    id: 'market-lead', group: 'price', path: blog('field-sales-software-market-report-2026', 'contentHtml'),
    from: 'مقابل 7,188 ريالاً على اشتراك ثابت «لكل شركة».',
    to: 'مقابل أقل من ربع ذلك على اشتراك ثابت «لكل شركة».',
  },
  {
    id: 'market-example', group: 'price', path: blog('field-sales-software-market-report-2026', 'contentHtml'),
    from: 'الشركة نفسها على اشتراك ثابت «لكل شركة» بـ599 ريالاً شهرياً (باقة حتى 20 مندوباً) تدفع 7,188 ريالاً في السنة — فارق يتجاوز 13,600 ريال في السنة الأولى وحدها، أي وفر يقارب 65%. والأهم من الفارق الرقمي أثره السلوكي: في النموذج الثابت، إضافة المندوب الحادي عشر لا تغيّر الفاتورة شيئاً،',
    to: 'الشركة نفسها على اشتراك ثابت «لكل شركة» بـ399 ريالاً شهرياً (باقة حتى 10 مناديب) وبلا رسوم تأسيس تدفع في سنتها الأولى أقل من ربع ذلك — وفر يقارب 77%. والأهم من الفارق الرقمي أثره السلوكي: في النموذج الثابت، إضافة مندوب ضمن حدّ الباقة لا تغيّر الفاتورة شيئاً،',
  },
  {
    id: 'market-table', group: 'price', path: blog('field-sales-software-market-report-2026', 'contentHtml'),
    from: '<td>599 ر.س شاملة الضريبة</td>',
    to: '<td>399 ر.س شاملة الضريبة (باقة حتى 10 مناديب)</td>',
  },
  {
    id: 'market-phase2', group: 'phase2', path: blog('field-sales-software-market-report-2026', 'contentHtml'),
    from: 'نظام FieldSales يُصدر فاتورة ضريبية مبسّطة برمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار)، وهذا هو النطاق الذي نعلنه حرفياً من دون زيادة.',
    to: `نظام FieldSales يُصدر فاتورة ضريبية مبسّطة برمز QR، ونحن ${P2}، ولا ندّعي اعتماداً من الهيئة لأنها لا تعتمد مزوّدي البرمجيات.`,
  },
  {
    id: 'market-faq-saving', group: 'price', path: blog('field-sales-software-market-report-2026', 'contentHtml'),
    from: 'عند عشرة مناديب يوفّر النموذج الثابت نحو 65% سنوياً مقارنة بالنمط المحلي الموثّق في المسح',
    to: 'عند عشرة مناديب يوفّر النموذج الثابت نحو 77% في السنة الأولى مقارنة بالنمط المحلي الموثّق في المسح',
  },
  {
    id: 'market-faq-cost', group: 'price', path: blog('field-sales-software-market-report-2026', 'contentHtml'),
    from: 'وعلى نموذج «لكل شركة» لدى FieldSales تدفع الشركة 599 ريالاً شهرياً حتى 20 مندوباً، شاملة الضريبة وبلا رسوم تأسيس.',
    to: 'وعلى نموذج «لكل شركة» لدى FieldSales تدفع شركة العشرة مناديب 399 ريالاً شهرياً (باقة حتى 10 مناديب)، شاملة الضريبة وبلا رسوم تأسيس.',
  },
  {
    id: 'market-price-end', group: 'price', path: blog('field-sales-software-market-report-2026', 'contentHtml'),
    from: '299 ريالاً شهرياً حتى 5 مناديب، و599 ريالاً شهرياً حتى 20 مندوباً، للشركة كاملة وشاملة الضريبة',
    to: '299 ريالاً شهرياً حتى 5 مناديب، و399 ريالاً شهرياً حتى 10، و599 ريالاً شهرياً حتى 20 مندوباً، للشركة كاملة وشاملة الضريبة',
  },

  // ═══ zatca-einvoicing-distribution ═══
  // ذكر الربط قبل «58مم»، ودعوة الإجراء بلا «خلال دقائق»: حارس الموعد يفحص ١٢٠ حرفاً بعد عبارة الربط
  {
    id: 'einvoicing-dist', group: 'phase2', path: blog('zatca-einvoicing-distribution', 'contentHtml'),
    from: '<a href="/signup">منصّة FieldSales</a> تُصدر فواتير ZATCA (مرحلة أولى) برمز QR وطباعة حرارية 58مم من جوال المندوب مباشرةً.</p>',
    to: '<a href="/signup">منصّة FieldSales</a> تدعم ربط المرحلة الثانية مع منصة فاتورة، وتُصدر فواتير ZATCA برمز QR وطباعة حرارية 58مم من جوال المندوب مباشرةً.</p>',
  },
  {
    id: 'einvoicing-dist-cta', group: 'phase2', path: blog('zatca-einvoicing-distribution', 'contentHtml'),
    from: '<p><strong>ابدأ تجربتك المجانية 10 أيام وأصدر أول فاتورة متوافقة خلال دقائق.</strong></p>',
    to: '<p><strong>ابدأ تجربتك المجانية 10 أيام وأصدر أول فاتورة برمز QR من جوال مندوبك.</strong></p>',
  },

  // ═══ order-to-cash-cycle ═══
  {
    id: 'order-to-cash-ar', group: 'phase2', path: blog('order-to-cash-cycle', 'contentHtml'),
    from: '<p>وبصراحة عن النطاق: ندعم الفوترة الإلكترونية المرحلة الأولى — الفاتورة المطبوعة تحمل رمز QR بترميز TLV. المرحلة الثانية غير مبنيّة.',
    to: `<p>وبصراحة عن النطاق: الفاتورة المطبوعة تحمل رمز QR بترميز TLV، ونحن ${P2}.`,
  },
  {
    id: 'order-to-cash-en', group: 'phase2', path: blog('order-to-cash-cycle', 'en.contentHtml'),
    from: '<p>On scope, plainly: we support Phase 1 e-invoicing — the printed invoice carries the QR code in TLV encoding. Phase 2 integration is not built.',
    to: '<p>On scope, plainly: the printed invoice carries the QR code in TLV encoding, and we support Phase 2 integration with ZATCA’s Fatoora platform.',
  },

  // ═══ how-to-manage-distributor-network ═══
  {
    id: 'manage-network-offline', group: 'offline', path: blog('how-to-manage-distributor-network', 'contentHtml'),
    from: 'فلا تتوقف الدورة اليومية على جودة التغطية.</p>',
    to: 'فلا تتوقف الدورة اليومية على جودة التغطية. وفي FieldSales تحتاج الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار للشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة، وتعمل سندات القبض دون اتصال.</p>',
  },
  {
    id: 'manage-network-price', group: 'price', path: blog('how-to-manage-distributor-network', 'contentHtml'),
    from: '299 ر.س شهرياً (حتى 5 مناديب أو موزعين) أو 599 ر.س (حتى 20)',
    to: '299 ر.س شهرياً (حتى 5 مناديب أو موزعين)، أو 399 ر.س (حتى 10)، أو 599 ر.س (حتى 20)',
  },

  // ═══ rep-visit-tracking-gps ═══
  {
    id: 'visit-tracking-price', group: 'price', path: blog('rep-visit-tracking-gps', 'contentHtml'),
    from: '(حتى 5 مناديب) و599 ر.س (حتى 20)،',
    to: '(حتى 5 مناديب)، و399 ر.س (حتى 10)، و599 ر.س (حتى 20)،',
  },

  // ═══ distribution-terms-glossary — تعريف لا ادّعاء، لكن قاعدة النفي القديم تلتقطه ═══
  {
    id: 'glossary-simplified', group: 'phase2', path: blog('distribution-terms-glossary', 'contentHtml'),
    from: '<p><strong>الفاتورة المبسّطة:</strong> فاتورة البيع للمستهلك/المنفذ برمز QR وفق المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية.</p>',
    to: '<p><strong>الفاتورة المبسّطة:</strong> فاتورة البيع للمستهلك/المنفذ برمز QR وفق متطلبات الفوترة الإلكترونية، وتُبلَّغ إلى منصة فاتورة في المرحلة الثانية.</p>',
  },

  // ═══ repzo-alternative-field-reps — بقاء المقال أو حذفه قرار المالك؛ هنا حذف «المرحلة الأولى» وحده ═══
  // بلا ذكر للربط عمداً: يسبق هذا البندَ في المقال بندُ «خلال دقائق»، وحارس الموعد يفحص ما قبل عبارة الربط
  {
    id: 'light-system-li', group: 'phase2', path: blog('repzo-alternative-field-reps', 'contentHtml'),
    from: '<li><strong>توافق ZATCA (المرحلة الأولى):</strong> إصدار فاتورة ضريبية نظامية برمز QR من جوال المندوب مباشرةً.</li>',
    to: '<li><strong>الفوترة الإلكترونية ZATCA:</strong> إصدار فاتورة ضريبية نظامية برمز QR من جوال المندوب مباشرةً.</li>',
  },
  {
    id: 'light-system-summary', group: 'phase2', path: blog('repzo-alternative-field-reps', 'contentHtml'),
    from: 'فاتورة برمز QR متوافقة مع المرحلة الأولى من ZATCA،',
    to: 'فاتورة ضريبية برمز QR،',
  },

  // ═══ field-collection-overdue-receivables — الخادم ينبّه ولا يمنع ═══
  {
    id: 'overdue-credit-h2', group: 'credit', path: blog('field-collection-overdue-receivables', 'contentHtml'),
    from: '<h2>2. اضبط حدّ ائتمان لكل عميل — وأوقف البيع عند تجاوزه</h2>',
    to: '<h2>2. اضبط حدّ ائتمان لكل عميل — وتدخّل فور تجاوزه</h2>',
  },
  {
    id: 'overdue-credit', group: 'credit', path: blog('field-collection-overdue-receivables', 'contentHtml'),
    from: 'واجعل النظام <strong>يمنع المندوب تلقائياً</strong> من إصدار فاتورة آجلة جديدة إذا تجاوز العميل حدّه. هذا يحوّل الانضباط من قرار بشري (يُجامَل فيه) إلى قاعدة نظام لا تُكسر. العميل الذي يريد بضاعة أكثر يجب أن يسدّد أولاً',
    to: 'واجعل النظام <strong>ينبّه الإدارة فوراً</strong> حين تتجاوز فاتورة آجلة حدّ العميل، وامنح صلاحية البيع الآجل لمن يستحقها من المناديب فقط. هذا ينقل الانضباط من قرار بشري (يُجامَل فيه) إلى تنبيه موثّق باسم العميل والمندوب. والعميل الذي يريد بضاعة أكثر يسدّد أولاً',
  },
];

// ── التطبيق ──────────────────────────────────────────────────────────────────

export type CmsFixStatus =
  | 'applied'        // وُجد النص مرة واحدة فاستُبدل
  | 'already'        // النص الجديد موجود أصلاً (طُبّق من قبل)
  | 'missing'        // النص الحالي غير موجود
  | 'ambiguous'      // النص الحالي موجود أكثر من مرة — لا يُمسّ
  | 'no-field'       // المسار لا يقود إلى نص (مقال حُذف أو سؤال تغيّر)
  | 'price-mismatch';// النص الجديد فيه سعر لا يطابق باقات المحتوى نفسه

export interface CmsFixResult {
  fix: CmsFix;
  status: CmsFixStatus;
}

type Seg = { key: string; sel?: { k: string; v: string } | number };

/** «blog[slug=x].en.contentHtml» ← مقاطع؛ النقطة داخل الأقواس لا تقسم */
function parsePath(path: string): Seg[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of path) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === '.' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => {
    const m = p.match(/^([^[]+)(?:\[(.*)\])?$/);
    if (!m) return { key: p };
    const [, key, inner] = m;
    if (inner == null) return { key };
    if (/^\d+$/.test(inner)) return { key, sel: Number(inner) };
    const eq = inner.indexOf('=');
    return { key, sel: { k: inner.slice(0, eq), v: inner.slice(eq + 1) } };
  });
}

/** الحاوية والمفتاح اللذان يحملان نص المسار، أو null إن لم يقُد المسار إلى نص */
function locate(root: unknown, path: string): { holder: Record<string, unknown>; key: string } | null {
  const segs = parsePath(path);
  let node: unknown = root;
  for (let i = 0; i < segs.length; i++) {
    const { key, sel } = segs[i];
    if (!node || typeof node !== 'object') return null;
    const isLast = i === segs.length - 1;
    if (sel === undefined) {
      if (isLast) {
        const holder = node as Record<string, unknown>;
        return typeof holder[key] === 'string' ? { holder, key } : null;
      }
      node = (node as Record<string, unknown>)[key];
      continue;
    }
    const arr = (node as Record<string, unknown>)[key];
    if (!Array.isArray(arr)) return null;
    let item: unknown;
    if (typeof sel === 'number') item = arr[sel];
    else {
      const hits = arr.filter((x) => x && typeof x === 'object' && String((x as Record<string, unknown>)[sel.k]) === sel.v);
      if (hits.length !== 1) return null; // محدِّد ملتبس (معرّف مكرّر) لا يُخمَّن
      item = hits[0];
    }
    if (isLast) return null; // المسار ينتهي بعنصر لا بنص
    node = item;
  }
  return null;
}

const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);

const toLatin = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

/**
 * الأسعار الواردة في نص بصيغة سعرية — الأنماط نفسها في scripts/verify-pricing.mjs (NNN ر.س · NNN ريال ·
 * NNN SAR) مع «SAR NNN» الإنجليزية.
 */
export function pricesIn(text: string): string[] {
  const t = toLatin(text);
  const out: string[] = [];
  for (const re of [/(\d{2,4})\s*(?:ر\.?\s?س|﷼|ريال)/g, /(\d{2,4})\s*SAR/gi, /SAR\s*(\d{2,4})/gi]) {
    for (const m of t.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/** أسعار الباقات الرقمية في المحتوى نفسه (pricing.plans[].price) */
export function planPrices(content: unknown): string[] {
  const plans = (content as { pricing?: { plans?: { price?: unknown }[] } } | null)?.pricing?.plans;
  if (!Array.isArray(plans)) return [];
  return plans.map((p) => toLatin(String(p?.price ?? '')).trim()).filter((p) => /^\d+$/.test(p));
}

function run(content: unknown, fixes: CmsFix[]) {
  const live = new Set(planPrices(content));
  const current = new Map<string, string>(); // المسار ← نصّه بعد البنود السابقة عليه
  const results: CmsFixResult[] = [];
  for (const fix of fixes) {
    const loc = locate(content, fix.path);
    if (!loc) { results.push({ fix, status: 'no-field' }); continue; }
    const text = current.get(fix.path) ?? (loc.holder[loc.key] as string);
    // بند إلحاق (الجديد يحوي القديم): بعد تطبيقه يبقى القديم موجوداً، فالحكم بوجود الجديد أولاً — وإلا أُلحق مرتين
    if (fix.to.includes(fix.from) && text.includes(fix.to)) { results.push({ fix, status: 'already' }); continue; }
    const n = count(text, fix.from);
    // النص الجديد القصير قد يوجد في موضع آخر من الحقل، فلا يُعدّ «مطبَّقاً» إلا حين يغيب القديم
    if (n === 0) { results.push({ fix, status: text.includes(fix.to) ? 'already' : 'missing' }); continue; }
    if (n > 1) { results.push({ fix, status: 'ambiguous' }); continue; }
    if (pricesIn(fix.to).some((p) => !live.has(p))) { results.push({ fix, status: 'price-mismatch' }); continue; }
    current.set(fix.path, text.replace(fix.from, () => fix.to));
    results.push({ fix, status: 'applied' });
  }
  return { results, current };
}

/** تشغيل جافّ: ما سيحدث لكل بند دون لمس المحتوى (لعدّاد الزر) */
export function planCmsFixes(content: unknown, fixes: CmsFix[] = CMS_FIXES): CmsFixResult[] {
  return run(content, fixes).results;
}

/**
 * يطبّق البنود على **نسخة** من المحتوى ويعيدها مع تقرير لكل بند. الأصل لا يُمسّ؛ وإن لم يطابق
 * أي بند فالقيمة المعادة مساوية للأصل.
 */
export function applyCmsFixes<T>(content: T, fixes: CmsFix[] = CMS_FIXES): { value: T; results: CmsFixResult[]; applied: number } {
  const { results, current } = run(content, fixes);
  if (!current.size) return { value: content, results, applied: 0 };
  const value = structuredClone(content);
  for (const [path, text] of current) {
    const loc = locate(value, path);
    if (loc) loc.holder[loc.key] = text;
  }
  return { value, results, applied: results.filter((r) => r.status === 'applied').length };
}
