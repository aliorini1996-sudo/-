import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { RULES, checkText, findViolation, findViolations, norm, PHASE2_CMS_CLEANED, cmsCorpus, fromCms, GOV_EINVOICING, GOV_EINVOICING_RE, jsonLdLines } from '../../scripts/claims-rules.mjs';
import { checkMarketingStrings, govEinvoicingName } from '../../scripts/claims-i18n.mjs';
import * as claimsRules from '../../scripts/claims-rules.mjs';
import { buildCatalog, getArticle, LANGS } from '../blog/seo/catalog.mjs';
import { PROFILE_DEFAULTS } from './profileContent';
import { TEMPLATES } from './templates';
import { defaultContent } from '../landing/defaultContent';
import { defaultContentEn } from '../landing/defaultContentEn';
import { defaultContentFr } from '../landing/defaultContentFr';
import { defaultContentTr } from '../landing/defaultContentTr';
import { defaultContentZh } from '../landing/defaultContentZh';
import { FEATURES } from './features.mjs';
import { PRICING_TEXT } from './pricingText';
import { SECTORS, SECTOR_FAIRNESS_NOTE, SECTOR_FAIRNESS_TITLE } from './sectors';
import { POSTS } from '../blog/posts';

/**
 * حرّاس حارس الادّعاءات (scripts/verify-claims.mjs) — بالقواعد نفسها التي تحرس dist.
 *
 * قرار المالك: «ربط المرحلة الثانية مع منصة فاتورة» يُعلَن بعد اكتمال التفعيل الفعلي.
 * فصيغة الدعم تمرّ، ويبقى محجوباً ولو بعد التفعيل: الاعتماد/المصادقة/الترخيص من الهيئة،
 * والشراكة الرسمية معها، وأي موعد أو رقم مقرون بالمرحلة الثانية. والنفي القديم
 * («غير مبنية» · «الأولى فقط» · «يُصدر وفق المرحلة الأولى») يُكشف تحذيراً حتى يُحرَّر من CMS.
 *
 * حارسٌ لا يعضّ ينجح كاذباً، وحارسٌ يعضّ المحتوى الصحيح يُعطَّل — فيُختبر الطرفان.
 */

const APPROVED = 'zatca-approved';
const DATED = 'zatca-phase2-dated';
const STALE = 'zatca-phase2-stale-denial';

const expectHits = (text: string, expected: string[]) => {
  assert.deepEqual(checkText(text), expected, `«${text}»`);
};

test('صيغة دعم ربط المرحلة الثانية تمرّ بلغات الموقع الخمس', () => {
  for (const t of [
    'ندعم ربط المرحلة الثانية مع منصة فاتورة (هيئة الزكاة والضريبة والجمارك).',
    'ربط المرحلة الثانية مع منصة فاتورة مفعّل.',
    'ربط المرحلة الثانية مع منصة فاتورة مُفعَّل.',
    'We support Phase 2 integration with ZATCA’s Fatoora platform.',
    'Phase 2 integration with the Fatoora platform is enabled.',
    'Nous prenons en charge l’intégration phase 2 avec la plateforme Fatoora (ZATCA).',
    'Fatoora platformu ile 2. Aşama entegrasyonunu destekliyoruz.',
    '支持与 Fatoora 平台（ZATCA）的第二阶段对接。',
    'Phase 2 integration enabled. Nothing else.',
    'We support Phase 2 integration with Fatoora; requirements may vary by business size.',
    // صيغة صادقة تجمع المرحلتين: «المرحلة الأولى» هنا ليست تموضعاً قديماً
    'نصدر فاتورة المرحلة الأولى برمز QR وندعم ربط المرحلة الثانية مع منصة فاتورة',
    // قيد الاتصال للشركات المربوطة (قرار المالك: لا فاتورة ضريبية دون اتصال لها)
    'وللشركات المفعل لها ربط المرحلة الثانية تحتاج الفاتورة الضريبية والمرتجع اتصالا لحظة الإصدار بينما تبقى سندات القبض والزيارات متاحة بلا إنترنت',
    'For companies with Phase 2 integration enabled, tax invoices and returns need a connection at issuance; receipts and visits still work offline.',
  ]) expectHits(t, []);
});

test('النفي الصادق للاعتماد والنص التعليمي لا يُحجبان', () => {
  for (const t of [
    'وهيئة الزكاة والضريبة والجمارك لا تعتمد ولا تصادق مزوّدي البرمجيات، فلا ندّعي اعتماداً منها.',
    'ZATCA does not certify software vendors, so we claim no certification from it.',
    'لسنا معتمدين من الهيئة، فالهيئة لا تعتمد المزودين.',
    'We are not a ZATCA-certified vendor.',
    'ولا مصادق من الهيئة',
    'المرحلة الثانية (الربط والتكامل): ربط أنظمة الفوترة مباشرةً بمنصّة «فاتورة» التابعة للهيئة، مع توقيع تشفيري، وتُطبَّق على دفعات حسب حجم المنشأة.',
    'من بين 123 مورّداً في المسح، لا يعلن اكتمال الربط بـ«المرحلة الثانية (الربط والتكامل)» سوى 7 مورّدين.',
    'ZATCA e-invoicing (Fatoora) is mandatory in two phases.',
    'رمز QR متطلب أساسي في المرحلة الأولى من فوترة ZATCA.',
    'المرحلة 2 (أسبوع): سيارة الإثبات.',
    'العملة المعتمدة في فاتورة المبيعات تتبع إعداد الشركة',
    // سؤال يطرحه القارئ على مورّده ليس تموضعاً
    'اسأل مورّدك: هل تُصدر وفق المرحلة الأولى (مرحلة الإصدار)؟',
  ]) expectHits(t, []);
});

test('لا إنذار كاذب على الأرقام العادية قرب الادّعاء: 15% و58مم و299 ر.س و«View-only» و«ممارسات» و«maintenant»', () => {
  for (const t of [
    'كل فاتورة تحمل ضريبة 15% ونطبعها على 58مم، وندعم ربط المرحلة الثانية مع منصة فاتورة. من 299 ر.س شهرياً.',
    'فاتورة ضريبية مبسطة برمز QR وندعم ربط المرحلة الثانية مع منصة فاتورة وطباعة حرارية 58مم',
    'Tax invoice from the field Not included Simplified invoice with QR, Phase 1 (Generation) Offline day of work View-only at best',
    // حدود الكلمة: «مارس» داخل «ممارسات» و«mai» داخل «maintenant» ليستا شهرين
    'ندعم ربط المرحلة الثانية مع منصة فاتورة وممارسات التحصيل الميداني',
    'Nous prenons en charge l’intégration phase 2 avec la plateforme Fatoora maintenant et dans le domaine',
    'الفاتورة منظمة مرقمة برمز QR وندعم ربط المرحلة الثانية مع منصة فاتورة وكشوف حساب العميل جاهزة بضغطة',
  ]) expectHits(t, []);
});

test('يحجب ادّعاء الاعتماد أو المصادقة أو الترخيص أو الشراكة الرسمية مع الهيئة — ولو بعد التفعيل', () => {
  for (const t of [
    'نظام معتمد من هيئة الزكاة والضريبة والجمارك.',
    'نظام مُعتمَد من الهيئة لربط المرحلة الثانية.',
    'نظامنا مصادق من الهيئة.',
    'منصة مُصادَقة من ZATCA',
    'مرخّص من ZATCA',
    'شريك رسمي لهيئة الزكاة.',
    'شريك رسمي للهيئة.',
    'معتمدة · ZATCA',
    'ZATCA-approved e-invoicing',
    'Certified by ZATCA for Phase 2',
    'Solution certifiée par la ZATCA',
    'ZATCA onaylı e-fatura',
    // نفيٌ بعيد لا يُعفي ادّعاءً صريحاً (ثغرة نافذة ±220 القديمة)
    'الهيئة لا تعتمد المزودين، لكن نظامنا معتمد من الهيئة.',
    // بلا حرف جر — كان النمط الأقدم يحجبها فتراجع عنها الأحدث
    'نظام معتمد هيئة الزكاة',
    'حل مرخص ZATCA للمرحلة الثانية',
    'مُعتمد الزكاة',
    'فواتيرنا معتمدة ZATCA',
    'نظامنا معتمد من قبل هيئة الزكاة',
    'نظامنا حل معتمد في منصة فاتورة',
    'معتمد عند الزكاة',
    'نظامنا معتمد من فاتورة',
    'حاصلون على اعتماد هيئة الزكاة والضريبة والجمارك',
    'حاصلون على اعتماد الهيئة لربط المرحلة الثانية',
    'بشهادة هيئة الزكاة والضريبة والجمارك',
    'شريك تقني رسمي للهيئة',
    'الشريك الرسمي لمنصة فاتورة',
    'بالشراكة مع هيئة الزكاة والضريبة والجمارك',
    'A Fatoora-certified e-invoicing solution',
    'ZATCA-compliant and certified Phase 2 solution',
    'ZATCA Phase 2 certified',
    'an approved ZATCA e-invoicing provider',
    'certifiée ZATCA phase 2',
    'homologuée ZATCA',
    'ZATCA tarafından onaylanmış',
    'ZATCA 认可的发票系统',
    // كلمة تنتهي بـ«لا» أو «no» ليست نفياً (ثغرة الاستثناء بلا حدّ كلمة)
    'نظامنا فعلاً معتمد من الهيئة',
    'نحن أصلاً معتمدون من هيئة الزكاة',
    'حل كامل مثلا مرخص من الهيئة',
    'Casino certified by ZATCA',
  ]) assert.ok(checkText(t).includes(APPROVED), `مرّ ادّعاء اعتماد: «${t}»`);
});

test('يحجب أي موعد أو رقم مقرون بالمرحلة الثانية', () => {
  for (const t of [
    'ندعم ربط المرحلة الثانية منذ سبتمبر 2026.',
    'ربط المرحلة الثانية مفعّل قبل موعد الموجة 25.',
    'Phase 2 integration enabled for 16 companies.',
    'ندعم المرحلة الثانية لأكثر من ١٠٠ شركة',
    'We support Phase 2 integration since January.',
    '2. Aşama entegrasyonu 2027 itibaren destekleniyor',
    // أفعال إعلان لم تكن في القائمة
    'تم تفعيل ربط المرحلة الثانية مع منصة فاتورة في سبتمبر 2026',
    'أطلقنا ربط المرحلة الثانية مع منصة فاتورة عام 2026',
    'المرحلة الثانية جاهزة منذ يناير 2027',
    'Phase 2 integration went live in September 2026',
    'ربط المرحلة الثانية متاح الآن لأكثر من 40 شركة',
    'Phase 2 live since January',
    'Phase II integration live for 30 distributors',
    // مواعيد وأرقام لم يعرفها النمط
    'ندعم ربط المرحلة الثانية في مارس',
    'ندعم ربط المرحلة الثانية من إبريل',
    'La phase 2 est prise en charge en mars',
    'La phase 2 est prise en charge en juin',
    'ندعم ربط المرحلة الثانية في رمضان ١٤٤٨',
    'ربطنا أكثر من ١٠٠٠٠ فاتورة بالمرحلة الثانية مع منصة فاتورة',
    'Phase 2 integration supported for 500+ businesses',
    'ندعم ربط المرحلة الثانية لـ٥٠ مؤسسة',
    'ندعم ربط المرحلة الثانية لمئات الشركات',
    'Phase 2 integration enabled for dozens of companies',
    'Phase 2 integration ready for Wave 24',
    'متوافق 100% مع المرحلة الثانية',
    'ربط المرحلة الثانية مفعل خلال أيام',
    'ندعم ربط المرحلة الثانية مع منصة فاتورة وأصدر أول فاتورة خلال دقائق',
    // الموعد قبل المصطلح، والتاء المربوطة هاءً
    'منذ يناير وإحنا ندعم ربط المرحلة الثانية مع منصة فاتورة',
    'ندعم ربط المرحلة الثانية مع منصة فاتورة قبل الموجة ٢٥',
    'ربط المرحلة الثانية مفعّل عند أكثر من ٤٠ شركة',
    'المرحله الثانيه مفعله من سنة ٢٠٢٦',
  ]) assert.ok(checkText(t).includes(DATED), `مرّ موعد أو رقم: «${t}»`);
  // الوعد المستقبلي يُحجب موعداً (ويُكشف نفياً قديماً معه)
  for (const t of ['سندعم ربط المرحلة الثانية قريباً', 'Phase 2 integration is coming soon']) {
    assert.ok(checkText(t).includes(DATED), `مرّ وعد مستقبلي: «${t}»`);
  }
});

test('يكشف النفي القديم للمرحلة الثانية وتموضع «المرحلة الأولى» بلغاته الخمس', () => {
  for (const t of [
    'المرحلة الثانية (الربط والتكامل) غير مبنية لدينا حتى الآن.',
    'We support phase one of e-invoicing (TLV QR) only; phase two is not built.',
    'Phase 2 (Integration) of ZATCA e-invoicing is not built yet — we say that plainly.',
    'La Phase 2 (intégration) n’est pas encore disponible.',
    'Nous prenons en charge la phase un de la facturation électronique (QR TLV) uniquement.',
    '2. Aşama (entegrasyon) henüz hazır değildir.',
    '第二阶段（对接阶段）尚未上线。',
    'ندعم الفاتورة الإلكترونية المرحلة الأولى رمز QR بترميز TLV فقط',
    // الحالات الخمس التي فاتت القاعدة على CMS الحي
    'نظام FieldSales يُصدر فاتورة ضريبية مبسّطة برمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار)، وهذا هو النطاق الذي نعلنه حرفياً من دون زيادة',
    'what is honestly not built (Phase 2)',
    'Phase 2 is not supported yet',
    'We don’t support Phase 2 yet',
    'المرحلة الثانية قيد التطوير',
    'لا نربط مع منصة فاتورة',
    'E-invoicing supports phase one (TLV QR)',
    'منصّة FieldSales تُصدر فواتير ZATCA (مرحلة أولى) برمز QR وطباعة حرارية 58مم',
    'with Saudi e-invoicing phase one (QR) support',
  ]) assert.deepEqual(checkText(t), [STALE], `«${t}»`);
  for (const t of ['ربط المرحلة الثانية قريباً', 'Phase 2 integration is coming soon']) {
    assert.ok(checkText(t).includes(STALE), `مرّ نفي قديم: «${t}»`);
  }
});

test('يكشف صيغ تموضع «المرحلة الأولى» بلا فعل دعم — الحيّة في CMS (أكتوبر 2026)', () => {
  for (const t of [
    'ZATCA Phase-1 QR invoices from the rep phone — offline included.',
    'offline invoicing with Phase-1 QR codes, Bluetooth thermal printing',
    'بيع وفوترة أوف-لاين برمز QR (المرحلة الأولى)، طباعة حرارية',
    'منظمة برمز QR (المرحلة الأولى) الأرشيف',
    'وفاتورة مبسطة برمز QR من الميدان وفق المرحلة الأولى، وتسعيرا لا يعاد التفاوض عليه',
    'فاتورة مبسطة برمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية',
    'What ships today is the complete Phase-1 van sales cycle above, live in production.',
    'What you get today is a complete Phase-1 field invoicing and tracking cycle',
    'What ships today — and has shipped invoices in production — is the complete Phase-1 field cycle described above.',
    'ما نقدمه اليوم هو دورة المرحلة الأولى الميدانية الكاملة أعلاه، حية في الإنتاج.',
  ]) assert.deepEqual(checkText(t), [STALE], `«${t}»`);
  // الشرح التعليمي والسؤال والجملة التي تذكر المرحلة الثانية معها ليست تموضعاً
  for (const t of [
    'هل يظهر رمز QR وفق المرحلة الأولى (مرحلة الإصدار) على كل فاتورة؟',
    'الفوترة الإلكترونية على مرحلتين: الإصدار (المرحلة الأولى) والربط (المرحلة الثانية).',
    'نصدر فاتورة برمز QR وفق المرحلة الأولى وندعم ربط المرحلة الثانية مع منصة فاتورة',
    'ZATCA e-invoicing has two phases: generation (Phase 1) and integration (Phase 2).',
    'رمز QR متطلب أساسي في المرحلة الأولى من فوترة ZATCA.',
  ]) assert.deepEqual(checkText(t), [], `«${t}»`);
});

/** fromCmsContext ليس في claims-rules.d.mts (الملف خارج نطاق هذا التعديل) — يُقرأ من الوحدة نفسها */
type Violation = { index: number; match: string };
const fromCmsContext = (claimsRules as unknown as {
  fromCmsContext: (haystack: string, v: Violation, corpus: string | null, ctx?: number) => boolean;
}).fromCmsContext;
const NAMES = 'competitor-name-attributed';

test('أسماء المنافسين المسنَدة: تُكشف بصيغها، وحاجبة للمستودع لا تحذيراً عاماً، والقاعدة الأصلية حاجبة كما هي', () => {
  for (const t of ['قارن FieldSales مع Repzo', 'بدائل ريبزو لإدارة المناديب', 'وريبزو وغيرها', 'لريبزو', 'SalesBuzz', 'Sales Buzz', 'سيلز بز',
    '<a href="/blog/repzo-alternative-field-reps/">']) {
    assert.ok(checkText(t).includes(NAMES), `مرّ اسم منافس: «${t}»`);
  }
  for (const t of ['ريبزوت', 'سيلز بزنس', 'Repzoology', 'نظام إدارة مناديب أخفّ']) {
    assert.ok(!checkText(t).includes(NAMES), `إنذار كاذب: «${t}»`);
  }
  const rule = RULES.find((r) => r.id === NAMES)!;
  assert.equal(rule.severity, undefined, 'قاعدة الأسماء حاجبة لنصوص المستودع — التحذير لنصوص CMS يقرّره الإسناد لا severity');
  assert.equal((rule as unknown as { cmsWarn?: boolean }).cmsWarn, true);
  const original = RULES.find((r) => r.id === 'competitor-name')!;
  assert.equal(original.severity, undefined, 'قاعدة الأسماء الأصلية يجب أن تبقى حاجبة');
  assert.equal((original as unknown as { cmsWarn?: boolean }).cmsWarn, undefined, 'لا إسناد للأسماء الأصلية: حجبها مطلق كما كان');
});

test('أسماء منافسي الأسواق العالمية في القاعدة الأصلية الحاجبة — بلا إنذار على كلمات عامة', () => {
  const rule = RULES.find((r) => r.id === 'competitor-name')!;
  for (const t of ['Kolonell', 'FieldPro', 'MáximaTech', 'Maxima Tech', 'Omie', 'Conta Azul', 'Azuvio', 'BeatRoute', 'Bizom', 'FieldAssist',
    'Skynamo', 'ForceManager', 'Mobilvendor', '勤策', '纷享销客', 'Агент Плюс', 'Daftra', 'qoyod.com']) {
    assert.ok(findViolation(rule, t), `مرّ اسم منافس: «${t}»`);
  }
  for (const t of ['Field Sales', 'field assistant', 'predictive routing', 'beat route planning', 'sales on credit', 'omitted', 'Odoo', 'SAP', 'Sage ERP',
    'دفترة الحسابات', '外勤销售']) {
    assert.equal(findViolation(rule, t), null, `إنذار كاذب: «${t}»`);
  }
});

test('أسماء موردي تقرير المنافسين ودراسة تسويقهم (١١ نوفمبر) في القاعدة الحاجبة — والكلمات العامة منها خارجها أو بسياقها', () => {
  const rule = RULES.find((r) => r.id === 'competitor-name')!;
  for (const t of ['Bitrix24', 'Onyx Pro', 'Motakamel', 'TrioCashVan', 'Phenix Van Sales', 'PDAMAROC', 'TASSARUF TIJARI', 'Vatoce SalesUp',
    'Al-Ameen Software', 'Wafeq', 'wafeq', 'Rewaa', 'DEXEF', 'AccFlex', 'Edara ERP', 'TallyPrime', 'Lystloc', 'SalesJump', 'mSELL', 'Unolo', 'TrackoField',
    'bMobile', 'Advantage Route Systems', 'Al Badr Sales', 'SalesRabbit', 'Route4Me', 'Onfleet', 'Repsly', 'SPOTIO', 'SimplyDepo', 'Pepperi', 'Badger Maps',
    'LeadSquared', 'Fieldproxy', 'Connecteam', 'Hubstaff', 'Timeero', 'Housecall Pro', 'ServiceTitan', 'SynTrack', 'SAP DSD', 'Salesforce Consumer Goods Cloud',
    'Resco', 'xkzero', 'StayinFront', 'eoStar', 'Encompass Distribution Cloud', 'Silver Bullet Suite', 'SalesWorx', 'Focus Softnet', 'ERPGulf', 'Dolibarr',
    'EspoCRM', 'Vtiger', 'Foodics', 'TapFood', 'Grubtech', 'Petpooja', 'Loyverse', 'SambaPOS', 'قارن FieldSales مع Foodics',
    // مراجعة ١١ نوفمبر: ما فات من التقرير، والسعوديون بسياق منتجهم، والعربية التي لا تلتبس
    'AFS-TELUS', 'AFS/TELUS', 'AFS Technologies', 'Zoho RouteIQ', 'Zoho FSM', 'Posist', 'Restroworks (Posist)', 'Mezan ERP', 'mezan.sa', 'Sahl POS',
    'Marn POS', 'فودكس', 'قارن مع فودكس', 'وفودكس']) {
    assert.ok(findViolation(rule, t), `مرّ اسم منافس: «${t}»`);
  }
  for (const t of ['ميزان المراجعة', 'برنامج سهل الاستخدام', 'نظام مرن', 'وافق العميل', 'Zoho CRM', 'Sahl', 'Marn', 'AFS']) {
    assert.equal(findViolation(rule, t), null, `إنذار كاذب: «${t}»`);
  }
  // كلمات عامة أو تكاملات: «jobber» فعل نرويجي في no.json، وZoho خيار ربط في صفحة تكامل ERP، وSalesforce وSAP وحدهما أنظمة تُربط
  for (const t of ['Selgerne jobber ute hos kundene', 'Jobber', 'the outfield', 'Motive', 'Square', 'Toast', 'Lightspeed', 'Medusa', 'Marn', 'Sahl',
    'Mezan', 'comezan a vender', 'Edara', 'pengedaran', 'Al-Ameen Street', 'take advantage: route planning', 'a blue link', 'to encompass all reps',
    'there is no silver bullet', 'Creative Solutions', 'Zoho Books', 'Salesforce', 'SAP ERP', 'Geidea', 'anyPos', 'AI2Bot', 'Recordable', 'Related articles']) {
    assert.equal(findViolation(rule, t), null, `إنذار كاذب: «${t}»`);
  }
});

const GOV = 'gov-einvoice-abroad';

test('ربط حكومي خارج السعودية: يُحجب ادّعاء الربط أو التكامل أو التوافق المنسوب إلينا بلغات الموقع ولغات الطبقة', () => {
  for (const t of [
    // لغات الموقع الخمس
    'FieldSales integrates with SAT to stamp every CFDI.',
    'Our platform supports Peppol e-invoicing in the UAE.',
    'Our app sends invoices directly to KSeF.',
    'We are fully compliant with LHDN MyInvois.',
    'Integrates with KRA eTIMS.',
    'FieldSales is connected to the FBR Digital Invoicing system via PRAL.',
    'نربط فواتيرك مع منظومة ETA المصرية.',
    'منصة FieldSales متوافقة مع منظومة الفاتورة الإلكترونية المصرية.',
    'FieldSales هو الحل المتوافق مع JoFotara في الأردن.',
    'FieldSales يرتبط مباشرة بالهيئة الاتحادية للضرائب.',
    'FieldSales يصدر فواتير ETA مباشرة من الميدان.',
    'نتكامل مع منظومة Fawtara في عُمان.',
    'FieldSales est compatible avec Chorus Pro.',
    'FieldSales est intégrée à la plateforme FNE de la DGI.',
    'Nous prenons en charge la FNE de la DGI.',
    'FieldSales, GİB e-Fatura sistemine entegre çalışır.',
    'e-Arşiv faturalarını destekliyoruz.',
    'FieldSales 支持全电发票。',
    '支持数电发票与金税对接',
    // لغات الطبقة
    'FieldSales se integra con el SAT y timbra cada CFDI 4.0.',
    'Integramos la facturación con el SAT.',
    'Compatible con CFDI 4.0',
    'FieldSales emite la factura electrónica validada por la DIAN.',
    'FieldSales transmite las facturas a la DIAN.',
    'O FieldSales emite NF-e autorizada pela SEFAZ.',
    'O FieldSales é integrado à SEFAZ.',
    'FieldSales terintegrasi dengan Coretax DJP.',
    'FieldSales ist mit XRechnung kompatibel.',
    'FieldSales는 국세청 전자세금계산서와 연동됩니다.',
    'FieldSales подключён к ЭСФ.',
    // صفحات الدول المراجَعة بعد حذف نفيها — الحارس يعضّ على الصيغة نفسها
    'FieldSales est raccordé à la plateforme FNE et à son API.',
    'FieldSales emite y timbra CFDI.',
    'FieldSales sends invoices to KRA as electronic tax invoices.',
    'FieldSales has a connection to FBR’s Digital Invoicing system.',
    'O FieldSales substitui o emissor de NF-e da sua empresa.',
  ]) assert.ok(checkText(t).includes(GOV), `مرّ ادّعاء ربط حكومي: «${t}»`);
});

test('ربط حكومي خارج السعودية: الصيغ العربية الشائعة (التنوين المحذوف والضمير المتصل والظرف قبل حرف الصلة) تُحجب', () => {
  // norm يحذف التنوين وتبقى ألفه: «ربطاً» ⇒ «ربطا» — كان حدّ الكلمة بعد «ربط» يفشل فتمرّ كلها (مراجعة ١١ نوفمبر)
  for (const t of [
    'FieldSales يوفر ربطاً مباشراً مع الهيئة الاتحادية للضرائب.',
    'FieldSales يوفر تكاملاً كاملاً مع منظومة JoFotara.',
    'نوفر ربطاً فورياً مع جهاز الضرائب في عُمان.',
    'FieldSales يتيح ربطه مع منظومة ETA.',
    'FieldSales متوافق تماماً مع منظومة ETA.',
    'FieldSales متكامل تماماً مع منظومة JoFotara.',
    'لدينا ربط مباشر مع منظومة ETA.',
    'نحن متوافقون تماماً مع منظومة ETA.',
    'نساعد الموزعين على الربط مع منظومة ETA.',
    'نوفر لكم تكاملاً كاملاً مع هيئة الضرائب المصرية.',
    'لـFieldSales ربط مباشر مع منظومة ETA',
  ]) assert.ok(checkText(t).includes(GOV), `مرّ ادّعاء ربط حكومي: «${t}»`);
  for (const t of [
    // الصفة بلا حرف صلة وصفٌ، والظرف وحده يُقبل بينهما لا أي كلمة
    'FieldSales منصة متكاملة لإدارة المناديب بالكامل وتشرف مصلحة الضرائب على الفاتورة',
    // «نقدم/نوفر» شرحاً لا ربطاً
    'نقدم شرحاً لكيفية ربط الشركات بمنظومة ETA.',
    'لا نصدر الفاتورة الرسمية ولا نربطها مع منظومة ETA.',
    'ولا يرتبط FieldSales بمنظومة الإيصال الإلكتروني.',
    'ربط FieldSales مع منظومة ETA غير متاح حالياً.',
  ]) assert.ok(!checkText(t).includes(GOV), `إنذار كاذب: «${t}»`);
});

test('ربط حكومي خارج السعودية: النفي مربوط بفعل الربط، و«عند الطلب» قرب الاسم، والموصولة بعد اسمنا لا تقطع', () => {
  for (const t of [
    // كلمة نفي في الجملة لا تتعلّق بفعل الربط — والعمل دون اتصال ميزة أساسية تتكرّر في التسويق
    'FieldSales integrates with SAT without any manual work.',
    'FieldSales transmet vos factures à la DGI, même sans connexion.',
    'FieldSales timbra el CFDI con el SAT incluso sin conexión.',
    'O FieldSales emite NF-e na SEFAZ mesmo sem conexão.',
    'FieldSales not only integrates with SAT but also with your ERP.',
    'FieldSales is not a PAC but integrates with SAT.',
    'FieldSales no es un PAC pero se integra con el SAT.',
    'FieldSales offre une intégration avec la DGI, sans frais.',
    // «عند الطلب» و«حسب متطلبات» في غير موضعهما
    'FieldSales يصدر فواتير متوافقة مع منظومة الفاتورة الإلكترونية المصرية حسب متطلبات مصلحة الضرائب.',
    'FieldSales integrates with SAT, and custom reports are available on request.',
    'FieldSales integrates with SAT and generates reports on demand.',
    // الموصولة بعد اسمنا تصفنا
    'FieldSales, which integrates with SAT, stamps every invoice.',
    'FieldSales, qui est intégré à la DGI, émet chaque facture.',
    'FieldSales, que se integra con el SAT, timbra cada factura.',
    'FieldSales sends invoices to KRA, which validates them.',
    // الضمير يليه فعل الربط عبر حشو أو اسم المنظومة، أو فعل تمكين
    'We offer SAT integration.',
    'We help distributors connect to SEFAZ.',
    'We are now fully integrated with the Kenya Revenue Authority.',
    'Nous sommes intégrés à la DGI.',
    'FieldSales se connecte à la DGI.',
    'Field Sales is integrated with KRA eTIMS.',
    'The Field Sales app sends invoices to KRA.',
  ]) assert.ok(checkText(t).includes(GOV), `مرّ ادّعاء ربط حكومي: «${t}»`);
  for (const t of [
    // نفي صادق بصيغه — قبل الفعل أو متضمَّن فيه أو بعده (الاسمي وتركي/ألماني/كوري)
    'FieldSales does not currently connect to KRA.',
    "FieldSales n'est pas raccordé à la DGI.",
    "FieldSales n'est pas, aujourd'hui, raccordé à la DGI.",
    'FieldSales ne se connecte pas à la DGI.',
    'FieldSales tidak terhubung ke Coretax DJP.',
    "FieldSales, GİB'e entegre değildir.",
    'FieldSales unterstützt XRechnung nicht.',
    'FieldSales는 국세청과 연동되지 않습니다.',
    'SAT integration is not available in FieldSales today.',
    'La integración de FieldSales con el SAT no está disponible.',
    'FieldSales works offline, without a connection to the DGI.',
    'FieldSales fonctionne sans connexion à la DGI.',
    'FieldSales integrates with your ERP but not with SAT.',
    'FieldSales does not issue the Nota Fiscal Eletrônica; your ERP does.',
    // صفحة غانا المراجَعة: «issued» لا يجعل GRA مفعولاً له، والنفي بينهما
    'FieldSales is not part of this system: documents issued in FieldSales are not validated by GRA and do not carry GRA’s QR code or signature.',
    // «عند الطلب» بصيغ صفحات الدول
    'A connection to KRA eTIMS is available on request after we study the requirements.',
    'La conexión con el SAT está disponible bajo solicitud.',
    'Uma conexão direta com a SEFAZ fica disponível sob demanda.',
    // «we» التحريرية و«support» اسماً واسم الفئة بحرف صغير أو بصيغة العنوان — لا فاعل منّا
    'We explain how businesses connect to SEFAZ through an accredited provider.',
    'Our support team can explain KRA eTIMS rules.',
    'Field sales teams in Kenya must issue invoices through KRA eTIMS.',
    'Field sales software in Egypt has to be compatible with the ETA e-receipt system.',
    'Field Sales Software in Kenya Must Integrate with KRA eTIMS',
    'Field Sales Teams in Egypt Must Be Compatible with ETA',
    // الموصولة بعد غير اسمنا تُقطع
    'Nigeria’s NRS runs the MBS platform, which connects taxpayers to the e-invoicing system.',
  ]) assert.ok(!checkText(t).includes(GOV), `إنذار كاذب: «${t}»`);
});

test('ربط حكومي خارج السعودية: الأسماء الرسمية الكاملة للجهات والمنظومات تُحجب كاختصاراتها', () => {
  for (const t of [
    'FieldSales is integrated with the Kenya Revenue Authority.',
    'FieldSales est intégré à la Direction générale des impôts du Cameroun.',
    'O FieldSales emite a Nota Fiscal Eletrônica automaticamente.',
    'FieldSales está integrado con la Dirección de Impuestos y Aduanas Nacionales.',
    'FieldSales terhubung langsung dengan Direktorat Jenderal Pajak.',
    'FieldSales menerbitkan faktur pajak untuk Anda.',
    'FieldSales est intégré à l’Autorité fiscale d’Oman.',
    "FieldSales est intégré à l'Autorité fédérale des impôts.",
    'FieldSales submits invoices to the Bureau of Internal Revenue.',
    'FieldSales is compliant with South African Revenue Service rules.',
    'FieldSales est compatible avec la Facture Normalisée Électronique.',
    'FieldSales is integrated with MBS.',
    'FieldSales est intégré à la Commission générale des impôts.',
    'FieldSales is connected to the General Commission for Taxes.',
  ]) assert.ok(checkText(t).includes(GOV), `مرّ ادّعاء ربط حكومي: «${t}»`);
});

test('ربط حكومي خارج السعودية: الذكر الواقعي والنفي والسؤال و«عند الطلب» وربط ZATCA تمرّ', () => {
  for (const t of [
    'CFDI 4.0 إلزامي في المكسيك.',
    'CFDI 4.0 is mandatory in Mexico for B2B and B2C sales.',
    'يشترط SAT أن تتوافق الفاتورة مع CFDI 4.0.',
    'El SAT exige que cada factura sea compatible con CFDI 4.0.',
    'In Kenya, KRA requires every VAT-registered business to transmit invoices through eTIMS.',
    'Nigeria’s NRS runs the MBS platform, which connects taxpayers to the e-invoicing system.',
    // سؤال
    'Does FieldSales integrate with SAT?',
    '¿FieldSales se integra con el SAT?',
    'Puis-je émettre mes FNE avec FieldSales ?',
    // نفي وفكّ صلة (من صفحات الدول المراجَعة)
    'FieldSales does not integrate with SAT today.',
    'FieldSales has no SAT integration yet.',
    'FieldSales no está integrado con el SAT.',
    'FieldSales no timbra CFDI; tu empresa lo sigue emitiendo con su PAC.',
    'FieldSales no emite ni timbra CFDI.',
    'لا نربط مع منظومة ETA حالياً.',
    "FieldSales n'émet ni FNE ni RNE : ses factures et reçus sont des documents de gestion interne.",
    "FieldSales n'est aujourd'hui raccordé ni à la plateforme FNE ni à son API.",
    "La FNE, elle, s'émet par les canaux de la DGI, indépendamment de FieldSales.",
    'FieldSales does not send invoices to KRA, and the invoices it prints are not electronic tax invoices.',
    'FieldSales has no connection to FBR’s Digital Invoicing system today.',
    // «عند الطلب» بلا وعد (قرار المالك)
    'In Mexico, integration with SAT is available on request.',
    'الربط مع SAT في المكسيك عند الطلب.',
    'FieldSales ينظم فوترتك ويصدر فواتير برمز QR؛ ويبقى ربط منظومة ETA الرسمية حسب متطلبات كل منشأة.',
    // الجملة الفرعية: الفاعل منّا في جملة والمنظومة في أخرى
    'FieldSales issues invoices in Mexican pesos, while SAT requires CFDI-compliant XML stamped by a PAC.',
    'FieldSales منصة متكاملة لموزعي مصر، حيث منظومة ETA إلزامية.',
    // الصفة العامة ليست ربطاً، وفعل الإصدار لا يُدين اسماً قبله (نصوص الكتالوج العربية بلا ترقيم)
    'FieldSales منصة متكاملة لإدارة المناديب في مصر وتشرف مصلحة الضرائب على الفاتورة',
    'FieldSales is an integrated platform for distributors in Mexico and SAT requires CFDI',
    'ضريبة القيمة المضافة ١٤٪ تشرف عليها مصلحة الضرائب المصرية والفاتورة والإيصال الإلكتروني إلزاميان تدريجيا تصدر منصة FieldSales الفاتورة وسند القبض',
    // السعودية خارج القاعدة: الربط حيّ
    'We support Phase 2 integration with ZATCA’s Fatoora platform.',
    'ندعم ربط المرحلة الثانية مع منصة فاتورة.',
    // المصطلح العام للفوترة الإلكترونية في لغات الطبقة ليس اسم منظومة
    'FieldSales: Die Anbindung an ein staatliches E-Rechnung-System ist auf Anfrage verfügbar.',
    'Devlet e-fatura entegrasyonu Suudi Arabistan’da canlıdır; FieldSales e-fatura sistemine bağlanır.',
  ]) assert.ok(!checkText(t).includes(GOV), `إنذار كاذب: «${t}»`);
});

test('ربط حكومي خارج السعودية: نطاق «الكتل» يفصل العنوان عن الفقرة، والقاعدة حاجبة', () => {
  const rule = RULES.find((r) => r.id === GOV)!;
  assert.equal(rule.severity, undefined, 'القاعدة حاجبة');
  assert.equal(rule.scope, 'blocks');
  // عنوان H1 فيه الاسم، وفقرة واقعية بعده: النصّ المسطّح يلصقهما فيصير FieldSales فاعلاً لـ«compatible»
  const flat = 'FieldSales en México El SAT exige que el software emisor sea compatible con CFDI 4.0';
  const blocks = 'FieldSales en México\nEl SAT exige que el software emisor sea compatible con CFDI 4.0';
  assert.ok(findViolation(rule, flat), 'النصّ المسطّح يُظهر سبب نطاق «الكتل»');
  assert.equal(findViolation(rule, blocks), null, 'السطر حدّ جملة');
  // «CFDI 4.0» ليست نهاية جملة: النقطة بين رقمين لا تقطع
  assert.ok(findViolation(rule, 'Compatible with CFDI 4.0 and the SAT catalogs, FieldSales stamps every invoice.'));
});

/**
 * مكوّنات منظومات الحقائق المدقّقة (D:/claude-work/country-facts، ١١ نوفمبر ٢٠٢٦) وجهاتها — **كل اسم كامل وكل اختصار على حدة**،
 * بصيغها في صفحات الدول والكتالوج (الفرنسية والعربية والإنجليزية). صياغات مختارة من الحقائق لا نسخ حرفية منها.
 * يُشترط أن يطابق الحارس الاسمَ **كاملاً**: الاختبار القديم كان يكتفي بمطابقة واحدة في نصّ يجمع systemName والجهة، فينجح
 * بالاختصار وحده بينما «FieldSales is integrated with the Kenya Revenue Authority» تمرّ.
 */
const AUDITED_COMPONENTS: Record<string, string[]> = {
  AE: ['Federal Tax Authority', 'FTA', 'EmaraTax', 'Peppol', 'PINT-AE', 'UAE Electronic Invoicing System', 'الهيئة الاتحادية للضرائب', 'Autorité fédérale des impôts'],
  BR: ['NF-e', 'NFC-e', 'Nota Fiscal Eletrônica', 'Nota Fiscal de Consumidor Eletrônica', 'nota fiscal eletrônica', 'SEFAZ', 'Secretarias da Fazenda', 'ENCAT',
    'Receita Federal', 'RFB', 'CGIBS'],
  CI: ['FNE', 'RNE', 'TERNE', 'Facture Normalisée Électronique', 'Reçu Normalisé Électronique', 'DGI', 'Direction Générale des Impôts'],
  CM: ['DGI', 'Direction Générale des Impôts', 'Direction générale des impôts'],
  CO: ['DIAN', 'RADIAN', 'SFE', 'Dirección de Impuestos y Aduanas Nacionales'],
  EG: ['ETA', 'Egyptian Tax Authority', 'مصلحة الضرائب المصرية', 'مصلحة الضرائب', 'هيئة الضرائب المصرية', 'Administration fiscale égyptienne', 'Autorité fiscale égyptienne',
    'منظومة الإيصال الإلكتروني', 'منظومة الفاتورة الإلكترونية المصرية'],
  GH: ['GRA', 'Ghana Revenue Authority', 'E-VAT', 'VSDC', 'Virtual Sales Data Controller', 'Certified Invoicing System'],
  ID: ['e-Faktur', 'Faktur Pajak Elektronik', 'faktur pajak', 'Coretax', 'DJP', 'Direktorat Jenderal Pajak', 'Directorate General of Taxes'],
  IQ: ['الهيئة العامة للضرائب', 'General Commission for Taxes', 'GCT', 'Commission générale des impôts'],
  KE: ['eTIMS', 'TIMS', 'Electronic Tax Invoice Management System', 'KRA', 'Kenya Revenue Authority'],
  MA: ['DGI', 'Direction Générale des Impôts', 'المديرية العامة للضرائب', 'General Directorate of Taxes'],
  MX: ['CFDI', 'Comprobante Fiscal Digital por Internet', 'SAT', 'Servicio de Administración Tributaria'],
  NG: ['NRS', 'NRSMBS', 'MBS', 'EFS', 'Merchant Buyer Solution', 'Nigeria Revenue Service', 'FIRS', 'Federal Inland Revenue Service'],
  OM: ['Fawtara', 'جهاز الضرائب', 'Oman Tax Authority', 'Autorité fiscale d’Oman', "Autorité fiscale d'Oman", 'Autorité fiscale omanaise'],
  PH: ['BIR', 'Bureau of Internal Revenue', 'EIS'],
  PK: ['FBR', 'Federal Board of Revenue', 'PRAL', 'Pakistan Revenue Automation'],
  SN: ['DGID', 'Direction Générale des Impôts et des Domaines'],
  ZA: ['SARS', 'South African Revenue Service'],
};
/** ما بين قوسين في الحقائق وليس اسم منظومة ولا جهة فوترة — مستثنى بسببه فلا يدخل الحارس */
const NOT_A_SYSTEM: Record<string, string> = {
  'Decentralized Continuous Transaction Control and Exchange': 'وصف النموذج التقني (DCTCE) لا اسم منظومة',
  DCTCE: 'اختصار النموذج التقني',
  'Ministry of Finance': 'وزارة لا جهة فوترة (والاسم عامّ في كل دولة)',
  'Accredited Service Providers': 'فئة مزوّدين لا جهة',
  ASP: 'اختصار الفئة نفسها',
  MINFI: 'وزارة المالية الكاميرونية لا جهة فوترة',
  MEFP: 'وزارة المالية السنغالية لا جهة فوترة',
  'E-Invoice': 'مصطلح عامّ (والصيغة المصرية بـ«المصرية» معروفة)',
  'E-Receipt': 'مصطلح عامّ (ومنظومة الإيصال الإلكتروني معروفة)',
  CIS: 'اختصار عامّ (رابطة الدول المستقلة) — Certified Invoicing System معروف',
  FED: 'اختصار عامّ — Fiscal Electronic Devices لم تُطرح بعد',
  DI: 'حرفان عامّان — FBR معروف',
};

test('كل اسم كامل وكل اختصار في حقائق الدول المدقّقة يعرفه الحارس على حدة (وملفات src/content/country-facts إن وُجدت)', () => {
  const full = new RegExp(`^(?:${GOV_EINVOICING_RE.source})$`, 'u');
  for (const [cc, names] of Object.entries(AUDITED_COMPONENTS)) {
    for (const n of names) assert.ok(full.test(n), `${cc}: لا يطابقه gov-einvoice-abroad كاملاً — «${n}»`);
    // cc ليس زينة: لكل دولة مدقّقة مُدخلٌ باسمها
    assert.ok(GOV_EINVOICING.some((e) => e.cc.includes(cc)), `${cc}: لا مُدخل له في GOV_EINVOICING`);
  }
  assert.ok(GOV_EINVOICING.every((e) => !e.cc.includes('IL')), 'رمز دولة لا تُضاف في بيانات مصدَّرة (قرار المالك)');
  // بعد دمج فرع صفحات الدول تُفحص ملفاته نفسها: دولة جديدة بلا مكوّنات، أو اسمٌ بين قوسين لا يعرفه الحارس، تُفشل الاختبار حتى يُضاف
  const dir = new URL('./country-facts/', import.meta.url);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => /^[A-Z]{2}\.json$/.test(x))) {
    const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    const e = j.einvoicing || {};
    if (j.code === 'SA' || (!e.systemName && !e.authority)) continue;
    const known = AUDITED_COMPONENTS[j.code];
    assert.ok(known, `${f}: دولة مدقّقة بلا مكوّنات في AUDITED_COMPONENTS`);
    for (const s of [e.systemName, e.authority, j.tax?.authority]) {
      if (!s) continue;
      for (const m of String(s).matchAll(/\(([^()]*)\)/g)) {
        for (const raw of m[1].split(/\s*[,/;،؛]\s*|\s+[–—-]\s+/)) {
          const p = raw.trim();
          if (p.length < 2 || !/^\p{Lu}[\p{L}'’ -]*$/u.test(p) || NOT_A_SYSTEM[p]) continue;
          assert.ok(known.includes(p), `${f}: «${p}» بين قوسين لا في AUDITED_COMPONENTS ولا في NOT_A_SYSTEM`);
        }
      }
    }
  }
});

/**
 * خطأ معروف في ملف منسوخ حرفياً لا يُعدَّل هنا (فرع صفحات الدول ينسخ الملف نفسه): عنوانا مصدرٍ في SA.json يقرنان «ربط المرحلة
 * الثانية» برقم الموجة وتاريخها فيطلقان zatca-phase2-dated الحاجبة. بُلِّغ به فرع الصفحات (إعادة صياغة العنوان أو استثناء كتلة
 * المصادر)؛ ويُستثنى هنا بنصّه الحرفي وحده، فأي مطابقة أخرى للقاعدة في صفحات الدول تُفشل الاختبار.
 */
const KNOWN_PAGE_ISSUES: Record<string, string[]> = {
  [DATED]: [
    'EY Global Tax News — إعلان الموجة 25 من ربط المرحلة الثانية (10 أغسطس 2026)',
    'EY Global Tax News — annonce de la 25e vague d’intégration de la phase 2 (10 août 2026)',
  ],
};

test('صفحات الدول المراجَعة (src/content/country-pages إن وُجدت) تمرّ من ربط الحكومي وأسماء المنافسين وموعد المرحلة الثانية', () => {
  const dir = new URL('./country-pages/', import.meta.url);
  if (!existsSync(dir)) return;
  const rules = RULES.filter((r) => [GOV, 'competitor-name', NAMES, 'eta-egypt-claim', APPROVED, DATED].includes(r.id));
  const bad: string[] = [];
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => /^[A-Z]{2}\.json$/.test(x))) {
    const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    if (!['publish', 'publish-with-notes'].includes(j.review?.quality)) continue;
    for (const [lang, c] of Object.entries(j.content || {})) {
      const blocks: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === 'string') blocks.push(v.replace(/<[^>]+>/g, ' '));
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(c);
      n += blocks.length;
      for (const r of rules) {
        const known = KNOWN_PAGE_ISSUES[r.id] || [];
        const v = findViolation(r, blocks.filter((b) => !known.includes(b)).join('\n'));
        if (v) bad.push(`${f} ${lang} [${r.id}] «${v.match}»`);
      }
    }
  }
  assert.ok(n > 100, `لم تُقرأ صفحات الدول (${n})`);
  assert.deepEqual(bad, [], 'صفحة دولة مراجَعة يدينها الحارس');
});

test('JSON-LD سطراً لكل قيمة نصية: جواب FAQPage لا ينقطع عند فواصله (verify-claims وverify-i18n)', () => {
  const rule = RULES.find((r) => r.id === GOV)!;
  const ld = JSON.stringify({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'SAT?', acceptedAnswer: { '@type': 'Answer', text: 'FieldSales, the van sales app, is integrated with SAT.' } }] });
  assert.ok(findViolation(rule, jsonLdLines(ld)), 'ادّعاء داخل جواب FAQPage مرّ');
  // التقسيم القديم عند كل فاصلة كان يفصل FieldSales عن ادّعائه
  assert.equal(findViolation(rule, ld.replace(/["{}[\],]/g, '\n')), null);
  // تعذّر التحليل ⇒ التقسيم القديم وحده
  assert.equal(jsonLdLines('{"a": "x, y"'), '\n\na\n: \nx\n y\n');
});

test('مكافئ الطبقة: اسم منظومة حكومية في نصّ مترجم يُرفض، وملفات الطبقة المنشورة خالية منها', () => {
  assert.equal(govEinvoicingName('La conexión con el SAT está disponible bajo pedido.'), 'SAT');
  assert.equal(govEinvoicingName('Staatliche E-Rechnung: auf Anfrage.'), null, 'المصطلح العام ليس اسم منظومة');
  const v = checkMarketingStrings({ 'tierB.home.faq.3.a': 'FieldSales ይዋሃዳል ከ CFDI ጋር።' }, { code: 'am' });
  assert.ok(v.some((x) => x.id === 'i18n-gov-einvoicing' && x.key === 'tierB.home.faq.3.a'), 'اسم منظومة في ترجمة أمهرية مرّ');
  const dir = new URL('../i18n/marketing/', import.meta.url);
  const offenders: string[] = [];
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    for (const [k, s] of Object.entries((j.strings || j) as Record<string, unknown>)) {
      if (typeof s !== 'string') continue;
      n++;
      const name = govEinvoicingName(s);
      if (name) offenders.push(`${f} ${k}: «${name}»`);
    }
  }
  assert.ok(n > 10000, `لم تُقرأ ملفات الطبقة (${n})`);
  assert.deepEqual(offenders, []);
});

test('حصر الاستهداف في «الأسواق العربية»: يُكشف في رأس الصفحات غير العربية ومقالاتها، ومقصور عليها', () => {
  const rule = RULES.find((r) => r.id === 'arab-only-targeting')! as typeof RULES[number] & { paths: RegExp; exceptPaths?: RegExp };
  assert.equal(rule.scope, 'head', 'العنوان والوصف وH1 لا المتن');
  for (const t of ['Field Sales & Distribution Management Software for Arab Markets', 'pour les marchés arabes', 'dans le monde arabe',
    'Arap pazarları için', 'Arap dünyasındaki dağıtımcılar', '面向阿拉伯市场', '阿拉伯世界', 'across the Arab world']) {
    assert.ok(findViolation(rule, t), `مرّ حصر عربي: «${t}»`);
  }
  for (const t of ['Saudi Arabia', 'Arabie saoudite', 'Arabic-first', 'Arab countries', 'Arapça', '阿拉伯语', 'Arab League']) {
    assert.equal(findViolation(rule, t), null, `إنذار كاذب: «${t}»`);
  }
  for (const p of ['en/index.html', 'fr\\about\\index.html', 'tr/index.html', 'zh/meeting/index.html', 'en/blog/index.html']) assert.ok(rule.paths.test(p), p);
  for (const p of ['index.html', 'about/index.html', 'meeting/index.html']) assert.ok(!rule.paths.test(p), `صفحة عربية في نطاق القاعدة: ${p}`);
  // منذ ٨ نوفمبر (طلب المالك «صحّح العناوين») المقالات داخلة في القاعدة: لاحقة REGION صارت «worldwide / partout dans le monde»
  assert.equal(rule.exceptPaths, undefined, 'لا استثناء للمقالات');
  for (const p of ['en/blog/field-sales-software/index.html', 'fr\\blog\\van-sales-app\\index.html']) assert.ok(rule.paths.test(p), p);
  assert.ok(RULES.filter((r) => r.scope !== 'head').every((r) => r.id !== 'arab-only-targeting'));
});

test('إسناد اسم المنافس بسياقه: عنوان مقال CMS ورابطه ونصّه تحذير، وجملة المستودع حاجبة', () => {
  const rule = RULES.find((r) => r.id === NAMES)!;
  const corpus = cmsCorpus({ blog: [{
    slug: 'repzo-alternative-field-reps',
    title: 'بدائل ريبزو (Repzo) لإدارة المناديب: متى يناسبك نظام أخفّ؟',
    contentHtml: '<p>يعرف كثيرون <strong>ريبزو</strong> كنظام شامل.</p>',
  }] });
  const page = '<html><head><title>بدائل ريبزو (Repzo) لإدارة المناديب: متى يناسبك نظام أخفّ؟ | مدوّنة FieldSales</title>'
    + '<link rel="canonical" href="https://fieldsa.net/blog/repzo-alternative-field-reps/"/>'
    + '<script type="application/ld+json">{"name":"بدائل ريبزو (Repzo) لإدارة المناديب: متى يناسبك نظام أخفّ؟"}</script></head>'
    + '<body><p>يعرف كثيرون ريبزو كنظام شامل.</p><p>قارن FieldSales مع Repzo اليوم</p></body></html>';
  const found = findViolations(rule, page);
  assert.equal(found.length, 7, `عدد المطابقات (${found.length})`);
  const repo = found.filter((v) => !fromCmsContext(page, v, corpus));
  assert.equal(repo.length, 1, `أُسند للمستودع غير المزروع: ${repo.map((v) => v.match).join('،')}`);
  assert.ok(norm(page).slice(0, repo[0].index).endsWith('قارن FieldSales مع '), 'المُسند للمستودع ليس الجملة المزروعة');
  // الاسم وحده موجود في CMS ما دام المقال حيّاً — fromCms القديم كان سيُسند الجملة المزروعة إلى CMS
  assert.ok(fromCms(repo[0].match, corpus));
  // بلا corpus لا إسناد
  assert.equal(fromCmsContext(page, found[0], null), false);
});

test('شدّة قاعدة النفي القديم يحكمها علم واحد (PHASE2_CMS_CLEANED)، وقاعدتا الاعتماد والموعد حاجبتان', () => {
  const byId = (id: string) => RULES.find((r) => r.id === id);
  // خطوة ما بعد تحرير CMS هي قلب العلم وحده — فلا يُفشل هذا الاختبار web-ci
  assert.equal(byId(STALE)?.severity, PHASE2_CMS_CLEANED ? undefined : 'warn');
  assert.equal(byId(APPROVED)?.severity, undefined, 'قاعدة الاعتماد يجب أن تبقى حاجبة');
  assert.equal(byId(DATED)?.severity, undefined, 'قاعدة الموعد يجب أن تبقى حاجبة');
  assert.equal(byId('zatca-phase2-claim'), undefined, 'القاعدة القديمة تحجب صيغة الدعم المعتمدة');
});

test('تُفحص كل المطابقات: نفيٌ يُعفي الذكر الأول لا يُعفي ادّعاءً لاحقاً في الصفحة نفسها', () => {
  const rule = RULES.find((r) => r.id === APPROVED)!;
  const page = 'لسنا معتمدين من الهيئة. ' + 'نص محايد '.repeat(30) + 'لكن نظامنا معتمد من الهيئة.';
  const v = findViolation(rule, page);
  assert.ok(v, 'مرّ ادّعاء لاحق بعد ذكر أول مُعفى');
  assert.ok(v.index > 30, 'أُدين الذكر المنفي الأول بدل الادّعاء اللاحق');
});

test('التطبيع يحذف التشكيل والتطويل', () => {
  assert.equal(norm('مُفعَّل ومُعتمَد وجاهز لـ'), 'مفعل ومعتمد وجاهز ل');
});

/** كل سلسلة نصية في بنية المحتوى مع مسارها — لا نسخ ملصوقة تنحرف عن المشحون */
const collectStrings = (v: unknown, path: string, out: [string, string][] = []): [string, string][] => {
  if (typeof v === 'string') out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => collectStrings(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collectStrings(x, `${path}.${k}`, out);
  return out;
};
const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\*\*/g, '');

test('النصوص المشحونة فعلاً (مستوردة من مصادرها) تمرّ من الحارس ولا تحمل نفياً قديماً', () => {
  // ما يراه الزائر بعد تحميل React — verify-claims لا يرى حزم JS، فهذا حارسها الوحيد
  const sources: Record<string, unknown> = {
    defaultContent, defaultContentEn, defaultContentFr, defaultContentTr, defaultContentZh,
    FEATURES, PRICING_TEXT, SECTORS,
    sectorFairness: { SECTOR_FAIRNESS_TITLE, SECTOR_FAIRNESS_NOTE },
    POSTS, // احتياطي CMS: يظهر حين يتعذّر جلب المقالات
  };
  const all = Object.entries(sources).flatMap(([name, src]) => collectStrings(src, name));
  assert.ok(all.length > 500, `المجمِّع لم يقرأ المصادر (${all.length} سلسلة) — الاختبار سينجح كاذباً`);
  const offenders = all
    .map(([p, s]) => [p, checkText(stripTags(s))] as const)
    .filter(([, ids]) => ids.length)
    .map(([p, ids]) => `${p}: ${ids.join(',')}`);
  assert.deepEqual(offenders, [], `نصوص مشحونة يدينها الحارس:\n${offenders.join('\n')}`);

  // الحارس يرى الصيغة المعلنة فعلاً في المصادر (وإلا مرّ حذفها أو استبدالها بنفي دون أن نلاحظ)
  assert.match(PRICING_TEXT.ar.fairBody, /ربط المرحلة الثانية/);
  assert.match(PRICING_TEXT.en.fairBody, /Phase 2 integration/);
  assert.match(PRICING_TEXT.fr.fairBody, /intégration phase 2/);
  assert.match(SECTOR_FAIRNESS_NOTE, /ربط المرحلة الثانية مع منصة فاتورة/);
  for (const [name, c] of Object.entries({ defaultContent, defaultContentEn, defaultContentFr, defaultContentTr, defaultContentZh })) {
    assert.ok(collectStrings(c.faq.items, name).some(([, s]) => /ربط المرحلة الثانية|Phase 2 integration|intégration de la phase 2|2\. Aşama entegrasyon|第二阶段对接/.test(s)), `${name}: سؤال الامتثال فقد صيغة الربط`);
  }

  // والحارس يعضّ على المصدر نفسه: نفيٌ مزروع في نسخة من صندوق الإنصاف يُكشف
  const planted = PRICING_TEXT.en.fairBody.replace('We support **Phase 2 integration**', 'Phase 2 integration is not built yet');
  assert.ok(checkText(stripTags(planted)).includes(STALE), 'نفيٌ مزروع في نص التسعير لم يُكشف');
});

test('النصوص المصيَّرة للزاحف في المصادر الخام (index.html · قالب llms · prerender · القطاعات) بلا ادّعاء محظور ولا نفي قديم', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  // public/llms.txt يُولَّد عند البناء من عناوين مقالات CMS (يفحصه verify-claims في dist) — يُفحص قالبه هنا
  for (const rel of ['../../index.html', '../../scripts/gen-llms.mjs', '../../scripts/sectors-data.mjs']) {
    const ids = checkText(stripTags(read(rel)));
    assert.deepEqual(ids, [], `${rel}: ${ids.join(',')}`);
  }
  // prerender.mjs شيفرة ونصوص: تُفحص قوالبه النصية وحدها (سطور تحمل حروفاً عربية أو وسوم HTML)
  const pre = read('../../scripts/prerender.mjs').split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter((l) => /[؀-ۿ]|<p>|<li>|<h[1-3]/.test(l))
    .join('\n');
  assert.ok(pre.length > 5000, 'لم تُقرأ قوالب prerender.mjs');
  const ids = checkText(stripTags(pre));
  assert.deepEqual(ids, [], `scripts/prerender.mjs: ${ids.join(',')}`);
});

/**
 * قواعد الامتثال وأسماء المنافسين — قاعدة «الرأس» (dead-keyword-targeting) تخصّ العنوان والوصف لا حقول keywords.
 * أسماء المنافسين هنا بلا إسناد: الكتالوج والبروفايل والنماذج نصوص مستودع، فالاسم فيها حاجب دائماً.
 */
const COMPLIANCE_RULES = RULES.filter((r) => [APPROVED, DATED, STALE, 'eta-egypt-claim', 'gov-einvoice-abroad', 'competitor-name', NAMES].includes(r.id));

test('مقالات catalog المولّدة بلغاتها الثلاث والبروفايل وبنك النماذج بلا ادّعاء امتثال محظور ولا نفي قديم ولا اسم منافس', () => {
  // أكثر من ٣٠٠ مقال تُصيَّر للزاحف وللزائر من المستودع مباشرة — نفيٌ قديم فيها خطأ مستودع لا بند CMS
  const all: [string, string][] = [];
  for (const e of buildCatalog()) {
    for (const L of LANGS) {
      const a = getArticle(e.slug, L);
      if (a) collectStrings(a, `catalog.${e.slug}.${L}`, all);
    }
  }
  const nCatalog = all.length;
  collectStrings(PROFILE_DEFAULTS, 'PROFILE_DEFAULTS', all);
  collectStrings(TEMPLATES, 'TEMPLATES', all);
  assert.ok(nCatalog > 5000, `المجمِّع لم يقرأ مقالات catalog (${nCatalog} سلسلة) — الاختبار سينجح كاذباً`);
  // السلاسل نفسها تتكرّر عبر الدول — يُفحص كل نصّ فريد مرّة (بأول مسار له) فلا يطول web-ci بلا فائدة
  const unique = new Map<string, string>();
  for (const [p, s] of all) if (!unique.has(s)) unique.set(s, p);
  const offenders = [...unique].map(([s, p]) => [p, s] as const)
    .map(([p, s]) => [p, COMPLIANCE_RULES.filter((r) => findViolation(r, stripTags(s))).map((r) => r.id)] as const)
    .filter(([, ids]) => ids.length)
    .map(([p, ids]) => `${p}: ${ids.join(',')}`);
  assert.deepEqual(offenders, [], `نصوص مستودع يدينها الحارس:\n${offenders.join('\n')}`);
  // سؤال «بلا إنترنت» السعودي يحمل قيد الاتصال للشركات المربوطة بالصيغة الدقيقة: «الفاتورة الضريبية» وحدها
  // كانت توهم أن المبسّطة تصدر دون اتصال، وRepApp يمنع كل فاتورة وكل مرتجع دون اتصال حين phase === 2
  assert.ok(all.some(([, s]) => /ربط المرحلة الثانية مع منصة فاتورة فتحتاج فيها الفواتير القياسية والمبسطة والمرتجعات اتصالا لحظة الإصدار/.test(s)), 'فُقد قيد الاتصال للشركات المربوطة من مقالات catalog');
});

test('إسناد النفي القديم: نصّ CMS يبقى تحذيراً ونصّ المستودع يُحجب (verify-claims)', () => {
  const rule = RULES.find((r) => r.id === STALE)!;
  // شكل CMS الحيّ: وسوم وتشكيل وMarkdown خفيف
  const cms = {
    blog: [{
      slug: 'x',
      title: 'فاتورة المرحلة الأولى من الميدان: دليل مناديب التوزيع',
      contentHtml: '<p>أما <strong>المرحلة الثانية</strong> (الربط والتكامل) فغير مَبنيّة لدينا حتى الآن.</p>',
      en: { contentHtml: 'On scope, plainly: we support **Phase 1** e-invoicing. Phase 2 integration is not built.' },
    }],
    split: { a: 'لا علاقة: المرحلة الثانية', b: 'غير مبنية' },
  };
  const corpus = cmsCorpus(cms);
  // الشكل في dist: الوسوم مسافات، وعنوان الصفحة ملحق به
  const page = 'فاتورة المرحلة الأولى من الميدان: دليل مناديب التوزيع | Field Sales . أما  المرحلة الثانية  (الربط والتكامل) فغير مبنية لدينا حتى الآن. On scope, plainly: we support Phase 1 e-invoicing. Phase 2 integration is not built.';
  const found = findViolations(rule, page);
  assert.ok(found.length >= 4, `لم تُكشف مطابقات CMS كلها (${found.length})`);
  for (const v of found) assert.ok(fromCms(v.match, corpus), `مطابقة CMS أُسندت للمستودع: «${v.match}»`);
  // نصّ مستودع مزروع في الصفحة نفسها يُسند للمستودع فيُحجب
  const repo = findViolations(rule, `${page} . المرحلة الثانية قيد التطوير.`).filter((v) => !fromCms(v.match, corpus));
  assert.equal(repo.length, 1, 'نفيٌ مزروع من المستودع لم يُفصل عن نفي CMS');
  assert.match(repo[0].match, /قيد التطوير/);
  // مطابقة تعبر حقلين في CMS ليست نصّ CMS، وبلا corpus لا إسناد
  assert.equal(fromCms('المرحلة الثانية غير مبني', corpus), false);
  assert.equal(fromCms(found[0].match, null), false);
});

test('وعد إصدار الفاتورة بلا اتصال في صفحات القطاعات يحمل قيد الاتصال للشركات المربوطة', () => {
  // صفحة القطاع تعلن «ندعم ربط المرحلة الثانية» في صندوق الإنصاف، فوعدٌ مطلق بإصدار الفاتورة دون اتصال
  // في الصفحة نفسها يَعِد الشركة المربوطة بما لا تملكه (قرار المالك: فاتورتها الضريبية تحتاج اتصالاً).
  // النسختان: src/content/sectors.ts (React) وscripts/sectors-data.mjs (prerender للزاحف).
  const OFFLINE_ISSUE = /(?:يصدر|تصدر)[^.؟\n]{0,80}(?:دون اتصال|بلا اتصال|بلا إنترنت)/;
  const raw = readFileSync(new URL('../../scripts/sectors-data.mjs', import.meta.url), 'utf8');
  const strings = [
    ...collectStrings(SECTORS, 'SECTORS').map(([, s]) => s),
    ...[...raw.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]),
  ].map(norm);
  const promises = strings.filter((s) => OFFLINE_ISSUE.test(s));
  assert.ok(promises.length >= 6, `لم تُقرأ وعود الإصدار دون اتصال في النسختين (${promises.length})`);
  const bare = promises.filter((s) => !/ربط المرحلة الثانية/.test(s));
  assert.deepEqual(bare, [], 'وعد إصدار دون اتصال بلا قيد الشركات المربوطة');
});

test('صفحات الكتالوج السعودية وأسواق المقاصّة اللحظية: لا وعد بإصدار الفاتورة أو ببيع لا يتوقف دون اتصال بلا قيده في الصفحة', () => {
  // قسما offline وfeatures كانا قالباً واحداً لكل الدول، فوعدت الصفحة السعودية «يضمن ألا تتوقف المبيعات»
  // و«it issues the invoice… with no connection at all» بجوار إعلان الربط نفسه، وRepApp.tsx يمنع إصدار الفاتورة
  // والمرتجع دون اتصال حين zatcaPhase2، وفي أسواق eta/peppol/ttn. (التحقق المستقل لدفعة الظهور)
  const UNCONDITIONAL = /يضمن ألا تتوقف المبيعات|garantit la continuit[ée] des ventes|turns a dead zone from a stopped sale/i;
  const OFFLINE = /بلا إنترنت|بدون إنترنت|دون اتصال|بلا اتصال|offline|no connection|hors ligne|sans connexion/i;
  const QUAL = /لحظة الإصدار|needs? a connection (?:at the moment of issue|at issue|to issue)|requires a live connection|exigent une connexion|exige (?:en revanche )?une connexion/i;
  let saPages = 0;
  const bad: string[] = [];
  for (const e of buildCatalog()) {
    const m = /-(sa|eg|ae|tn)$/.exec(e.slug);
    if (!m) continue;
    for (const L of LANGS) {
      const a = getArticle(e.slug, L);
      if (!a) continue;
      const text = norm(stripTags(a.contentHtml));
      if (m[1] === 'sa') saPages++;
      if (UNCONDITIONAL.test(text)) bad.push(`${e.slug}.${L}: وعد مطلق «${text.match(UNCONDITIONAL)![0]}»`);
      else if (OFFLINE.test(text) && !QUAL.test(text)) bad.push(`${e.slug}.${L}: «${text.match(OFFLINE)![0]}» بلا قيد الاتصال`);
    }
  }
  assert.ok(saPages >= 30, `لم تُقرأ صفحات الكتالوج السعودية (${saPages})`);
  assert.deepEqual(bad, [], 'وعد العمل دون اتصال بلا قيده في صفحة سعودية أو صفحة سوق مقاصّة لحظية');
  // قسم offline في الصفحة السعودية يحمل القيد بصيغته المعتمدة كاملة، بلغاتها الثلاث
  const sa = (L: 'ar' | 'en' | 'fr') => norm(stripTags(getArticle('van-sales-app-sa', L)!.contentHtml));
  assert.match(sa('ar'), /وللشركات المفعل لها ربط المرحلة الثانية مع منصة فاتورة تحتاج الفواتير القياسية والمبسطة والمرتجعات اتصالا لحظة الإصدار/);
  assert.match(sa('en'), /Phase 2 integration with ZATCA’s Fatoora platform enabled, invoices \(standard and simplified\) and returns need a connection at the moment of issue/);
  assert.match(sa('fr'), /phase 2 avec la plateforme Fatoora est activée, factures \(standard et simplifiées\) et retours exigent une connexion à l’émission/);
});
