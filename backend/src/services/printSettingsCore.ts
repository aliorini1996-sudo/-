// ============================================================================
// «إعدادات الطباعة» v1 — النواة الصرفة المشتركة بين الخادم والواجهة (طلب المالك ٢٣ أكتوبر ٢٠٢٦، التصميم §1)
// ----------------------------------------------------------------------------
// عمود واحد بنسخة: CompanySettings.printSettings Json?. null = سلوك اليوم حرفياً (legacyPrintSettings): شريط 58 مم
// الكلاسيكي للفواتير والسندات وA4 الصورة لملف PDF. الشركة تعرّف «قوالب طباعة» (طابعة + ورق + تصميم + تفاصيل) وتوجّه كل
// نوع مستند لقالب؛ والجهاز يختار بينها ويحفظ اتصال طابعته محلياً (لا عمود للمندوب).
//
// لماذا نواة واحدة منسوخة حرفياً: الخادم يرفض عند الحفظ، والجهاز يرفض عند القراءة (نسخة مخزّنة أقدم أو أحدث ⇒ السلوك
// الافتراضي). قاعدتان مختلفتان تعنيان إعداداً يقبله الخادم فيسقط في جوال المندوب صامتاً إلى 58 مم. ولذلك أيضاً: **تضييق
// قاعدة هنا لاحقاً خطِر** (إعداد محفوظ يصير غير صالح فيرجع كل جهاز للافتراضي) — والتوسيع آمن. فالقواعد صارمة من الآن.
//
// ما لا يوجد عمداً (التصميم §1.6 و§4): لا خيار يخفي أو يصغّر العنوان أو رمز QR أو تفصيل الضريبة أو التنبيه أو العلامة المائية
// أو اسم البائع ورقمه الضريبي أو رقم المشتري الضريبي أو ICV/UUID — قرار الطباعة (zatcaPrintDecision) يحكمها لا الشركة.
// ولا «حروف في السطر» ولا وضع نصّي: المخرج صورة دائماً (العربية لا تُرسل نصّاً للطابعة؛ CP864 لا يُستعمل).
//
// نسخة حرفية في web-admin/src/lib/print/printSettingsCore.ts (بعد هذا الرأس) — عدّل هنا ثم انسخ؛ الحارس
// web-admin/src/lib/print/printSettings.test.ts يفشل عند أي فرق.
// ============================================================================

import { z } from 'zod';

/** نسخة البنية — أيّ نسخة أخرى (هاتف قديم يقرأ إعداداً أحدث) تُعامَل كأنها لا إعدادات */
export const PRINT_SETTINGS_VERSION = 1;

export const PRINTER_TYPES = ['thermal', 'impact', 'page'] as const;
/** thermal = حرارية (رول/ورق) · impact = نقطية إبرية (Tally Dascom MIP480) · page = ليزر/حبر/PDF */
export type PrinterType = (typeof PRINTER_TYPES)[number];

export const TEMPLATE_IDS = [
  'roll_classic', // شريط اليوم 58 مم — مجمَّد للملف الافتراضي وحده (لا يُختار لقالب جديد)
  'roll_compact', 'roll_detailed',
  'impact_plain', 'impact_preprinted',
  'page_branded', 'page_plain',
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** التصاميم التي تُختار لكل نوع طابعة — roll_classic خارجها عمداً */
export const TEMPLATES_BY_PRINTER: Readonly<Record<PrinterType, readonly TemplateId[]>> = Object.freeze({
  thermal: ['roll_compact', 'roll_detailed'],
  impact: ['impact_plain', 'impact_preprinted'],
  page: ['page_branded', 'page_plain'],
});

/** نوع الطابعة الذي ينتمي له التصميم (بادئته) */
export function templatePrinter(t: TemplateId): PrinterType {
  return t.startsWith('roll_') ? 'thermal' : t.startsWith('impact_') ? 'impact' : 'page';
}

export const PAPER_FEEDS = ['roll', 'sheet', 'continuous'] as const;
/** roll = رول بلا طول صفحة · sheet = ورق مقطع · continuous = ورق متصل بثقوب سحب (fanfold) */
export type PaperFeed = (typeof PAPER_FEEDS)[number];
export const FEEDS_BY_PRINTER: Readonly<Record<PrinterType, readonly PaperFeed[]>> = Object.freeze({
  thermal: ['roll', 'sheet'],
  impact: ['sheet', 'continuous'],
  page: ['sheet'],
});

export const PRINTER_DPIS = [180, 203, 300] as const;
export type PrinterDpi = (typeof PRINTER_DPIS)[number];
/** الحرارية 203 أو 300 نقطة/بوصة، والنقطية 24 إبرة بدقة 180، والعادية بلا نقاط (رسم متجه بمقاس الصفحة) */
export const DPIS_BY_PRINTER: Readonly<Record<PrinterType, readonly PrinterDpi[]>> = Object.freeze({
  thermal: [203, 300],
  impact: [180],
  page: [],
});

export const PAPER_PRESET_IDS = [
  'roll58', 'roll80', 'roll82', 'roll85', 'roll112', 'roll_a4',
  'cut_a4', 'ff_a4', 'ff_95x11', 'ff_95x12', 'ff_85x11', 'ff_95x55',
  'a4', 'a5', 'letter',
  'custom',
] as const;
export type PaperPresetId = (typeof PAPER_PRESET_IDS)[number];

export interface Paper {
  /** المقاس الجاهز الذي بُني منه (كل قيمة تبقى قابلة للتعديل) — custom لما خرج عنه عرضاً أو طولاً */
  preset: PaperPresetId;
  widthMm: number; // 40–270
  lengthMm: number | null; // null = رول بلا نهاية
  feed: PaperFeed;
  dpi: PrinterDpi | null; // null للعادية
  /** عرض الحزمة المطبوعة بالنقاط — للحرارية من مضاعفات 8 (بايت لكل 8 نقاط في GS v 0)، وللنقطية أيّ عدد (أعمدة ESC *) */
  printableDots: number | null;
  /** إزاحة الحزمة المطبوعة عن **مركز** الورق (موجب = يميناً والورقة خارجة من الطابعة) — للمعايرة على الثقوب والدلائل */
  offsetXmm: number; // −15..+15
  marginTopMm: number; // 0–40
  marginBottomMm: number; // 0–40
}

export const FONT_SCALES = [0.9, 1, 1.15, 1.3] as const;
export type FontScale = (typeof FONT_SCALES)[number];
export const QR_SIZES = ['auto', 'large'] as const;
export type QrSize = (typeof QR_SIZES)[number];
export const PRINT_COPIES = [1, 2, 3] as const;
export type PrintCopies = (typeof PRINT_COPIES)[number];
export const GRAPHICS_QUALITIES = ['quality', 'draft'] as const;
export type GraphicsQuality = (typeof GRAPHICS_QUALITIES)[number];

/** تفاصيل الطباعة — لا مفتاح هنا يمسّ محتوى ZATCA الإلزامي (حارس المفاتيح المحظورة في اختبار الواجهة) */
export interface PrintOptions {
  showLogo: boolean; // افتراضياً مطفأ على الحرارية والنقطية (كاليوم) ومفعّل على العادية
  showContact: boolean; // العنوان والهاتف — اسم البائع ورقمه الضريبي ليسا خياراً
  showRepName: boolean;
  showSignatures: boolean; // ويبقى مشروطاً بعلم الشركة invoiceSignatureEnabled
  showItemUnit: boolean;
  showItemCodes: boolean; // M4: يحتاج رمز الصنف في بنود المستند
  showCustomerBalance: boolean; // M4: يحتاج الرصيد بعد المستند
  footerText: string | null; // ≤160؛ null = «شكرا لتعاملكم معنا»
  fontScale: FontScale;
  boldBody: boolean; // افتراضياً للنقطية (تباين الشريط والكربون)
  qrSize: QrSize; // لا يصغر أبداً عن الحد الأدنى لدقة الطابعة
  copies: PrintCopies; // مرّات طباعة كاملة — الكربون يعطي نسخه في مرور واحد
  copyLabels: boolean; // «الأصل» على الأولى و«نسخة» على البقية
  cutAfter: boolean; // حرارية بقاطع (GS V)
  feedAfterMm: number; // 0–30
  graphicsQuality: GraphicsQuality; // النقطية: 180×180 أو مسودة 120×180
}

export interface PrintProfile {
  id: string; // [a-z0-9-]{3,24}
  name: string; // ≤40 — تكتبه الشركة ولا يُترجم (إلا الافتراضيين)
  printer: PrinterType;
  template: TemplateId;
  paper: Paper;
  options: PrintOptions;
}

export const DOC_KINDS = ['invoice', 'receipt', 'statement', 'notices'] as const;
/** invoice تشمل المرتجع والإشعارات الدائنة والمدينة وسند التسليم (كلها doc.kind === 'invoice') · notices = التسوية والتحميل والمستودع وطلب المخزون */
export type PrintDocKind = (typeof DOC_KINDS)[number];
/** قالب الطباعة المباشرة لكل نوع مستند — null = لا زرّ طباعة مباشرة (ملف PDF يبقى دائماً) */
export type PrintRouting = Record<PrintDocKind, string | null>;

export interface PrintSettingsV1 {
  version: 1;
  profiles: PrintProfile[]; // 1–12
  routing: PrintRouting;
  pdfProfileId: string; // قالب لطابعة عادية — يقود «مشاركة/حفظ PDF»
  repMayChoose: boolean; // للجهاز أن يختار بين قوالب الشركة
}

export const PRINT_LIMITS = Object.freeze({
  maxProfiles: 12,
  maxBytes: 16 * 1024, // لا صور (الشعار من company.logo) — الحدّ يحرس صفّ الشركة الذي يُقرأ مع كل /company
  nameMax: 40,
  footerMax: 160,
  widthMm: [40, 270] as const,
  lengthMm: [50, 1000] as const,
  offsetXmm: [-15, 15] as const,
  marginMm: [0, 40] as const,
  feedAfterMm: [0, 30] as const,
  /** أضيق حزمة مقبولة (~32 مم على 203) — أضيق منها لا يتسع لرمز ZATCA بأي حجم */
  minPrintableDots: 256,
  /** التصميم المفصّل (جدول أعمدة) يحتاج 72 مم مطبوعة على الأقل */
  detailedMinMm: 72,
  /** ما يبقى من الصفحة بعد الهامشين */
  minBodyMm: 20,
  /**
   * سطر الطباعة النقطية (MIP480): 8.0 بوصة = 1440 نقطة على 180 — من الهامش الأيسر للإبرة. الحزمة وإزاحتها يميناً داخله
   * دائماً: ما وراءه لا تبلغه الإبرة، فيضيع حبرٌ قد يكون اسم البائع أو رقمه الضريبي أو طرف رمز QR المختوم.
   */
  impactLineDots: 1440,
  /**
   * أضيق ورق للطابعة العادية (A5): قالب الصفحة (794 بكسل) يُصغَّر بعرض الورق في الطباعة وملف PDF، ويصغر معه الرمز المختوم —
   * 148 مم ⇒ ~0.35 مم للخلية، و58 مم كانت تعطي ~0.14 مم لا تُمسح. الرول الضيّق مكانه الطابعة الحرارية بخانة رمزٍ بنقاط صحيحة.
   */
  pageMinWidthMm: 148,
});
export const PROFILE_ID_RE = /^[a-z0-9-]{3,24}$/;

export const LEGACY_THERMAL_ID = 'legacy-58';
export const LEGACY_PAGE_ID = 'legacy-a4';
/** اسما الملفين الافتراضيين — منّا لا من الشركة، فيُترجمان في الواجهة */
export const LEGACY_NAMES = Object.freeze({ thermal: 'حرارية 58 مم', page: 'صفحة A4 وملف PDF' });

/** النقاط لكل مم: 203 = 8 تماماً (رأس 203.2 نقطة/بوصة) — 72 مم = 576 نقطة كما تعدّها الطابعات؛ وغيرها dpi/25.4 (8.0 بوصة على 180 = 1440) */
export function dotsPerMm(dpi: PrinterDpi): number {
  return dpi === 203 ? 8 : dpi / 25.4;
}

/** أعرض حزمة يسمح بها عرض الورق — للحرارية مقرّبة لأسفل لمضاعف 8، وللنقطية لا تتجاوز سطر الطباعة (1440 مهما عرض الورق) */
export function maxPrintableDots(printer: PrinterType, widthMm: number, dpi: PrinterDpi): number {
  const raw = Math.floor(widthMm * dotsPerMm(dpi) + 1e-9);
  if (printer === 'thermal') return raw - (raw % 8);
  return printer === 'impact' ? Math.min(raw, PRINT_LIMITS.impactLineDots) : raw;
}

/** آخر نقطةٍ تبلغها حزمة النقطية من الهامش الأيسر: عرضها + إزاحتها يميناً (السالبة لا تُرسل — لا يسار قبل أوّل إبرة) */
export function impactRightDots(printableDots: number, offsetXmm: number, dpi: PrinterDpi): number {
  return printableDots + Math.max(0, Math.round(offsetXmm * dotsPerMm(dpi)));
}

/** هل يقبل نوع المستند طابعةً من هذا النوع — لا تصميم رول لكشف الحساب ومستندات المخزون في v1 */
export function routingAllowsPrinter(kind: PrintDocKind, printer: PrinterType): boolean {
  return !(printer === 'thermal' && (kind === 'statement' || kind === 'notices'));
}

// ─── المقاسات الجاهزة (التصميم §1.4) — قيمٌ افتراضية تُعايَر؛ النقطية والـ85 مم تنتظر صفحة المعايرة على الجهاز الحقيقي ───

export interface PaperPreset {
  id: Exclude<PaperPresetId, 'custom'>;
  printer: PrinterType;
  paper: Paper;
}

function presetOf(
  id: Exclude<PaperPresetId, 'custom'>, printer: PrinterType, widthMm: number, lengthMm: number | null, feed: PaperFeed,
  dpi: PrinterDpi | null, printableDots: number | null, marginTopMm: number, marginBottomMm: number,
): PaperPreset {
  return { id, printer, paper: { preset: id, widthMm, lengthMm, feed, dpi, printableDots, offsetXmm: 0, marginTopMm, marginBottomMm } };
}

export const PAPER_PRESETS: readonly PaperPreset[] = Object.freeze([
  // حرارية — 8 نقاط/مم على 203
  presetOf('roll58', 'thermal', 58, null, 'roll', 203, 384, 0, 0), // مقاس اليوم
  presetOf('roll80', 'thermal', 80, null, 'roll', 203, 576, 0, 0),
  presetOf('roll82', 'thermal', 82.5, null, 'roll', 203, 576, 0, 0),
  // 85 مم ليس عرض رول قياسياً (غالباً رأس أعرض بدليل قابل للضبط): 72 مم آمنة ثم يُعاير حتى ~80
  presetOf('roll85', 'thermal', 85, null, 'roll', 203, 576, 0, 0),
  presetOf('roll112', 'thermal', 112, null, 'roll', 203, 832, 0, 0),
  presetOf('roll_a4', 'thermal', 210, 297, 'sheet', 203, 1664, 5, 5), // 216 مم (1728) على رؤوس 8.5 بوصة
  // نقطية MIP480 — سطر الطباعة 8.0 بوصة (80 عموداً على 10 حروف/بوصة) = 1440 نقطة على 180، في منتصف الورقة
  presetOf('cut_a4', 'impact', 210, 297, 'sheet', 180, 1440, 8, 8),
  presetOf('ff_a4', 'impact', 210, 297, 'continuous', 180, 1440, 5, 5),
  presetOf('ff_95x11', 'impact', 241, 279.4, 'continuous', 180, 1440, 5, 5), // إن قبلت الطابعة 241 مم (المصادر تتعارض)
  presetOf('ff_95x12', 'impact', 241, 304.8, 'continuous', 180, 1440, 5, 5),
  presetOf('ff_85x11', 'impact', 216, 279.4, 'continuous', 180, 1350, 5, 5), // 7.5 بوصة بين شريطي الثقوب
  presetOf('ff_95x55', 'impact', 241, 139.7, 'continuous', 180, 1440, 5, 5), // نصف صفحة لفواتير السيارة القصيرة
  // عادية — هوامش CSS
  presetOf('a4', 'page', 210, 297, 'sheet', null, null, 10, 10),
  presetOf('a5', 'page', 148, 210, 'sheet', null, null, 10, 10),
  presetOf('letter', 'page', 215.9, 279.4, 'sheet', null, null, 10, 10),
]);

/** ورق المقاس الجاهز (نسخة جديدة) — null لـcustom */
export function presetPaper(id: PaperPresetId): Paper | null {
  const p = PAPER_PRESETS.find((x) => x.id === id);
  return p ? { ...p.paper } : null;
}

/** نوع الطابعة الذي يخصّه المقاس الجاهز — null لـcustom (يصلح لأي نوع) */
export function presetPrinter(id: PaperPresetId): PrinterType | null {
  return PAPER_PRESETS.find((x) => x.id === id)?.printer ?? null;
}

export function defaultPrintOptions(printer: PrinterType): PrintOptions {
  return {
    showLogo: printer === 'page',
    showContact: true, // شريط اليوم يطبع العنوان والهاتف
    showRepName: true,
    showSignatures: true,
    showItemUnit: true,
    showItemCodes: false,
    showCustomerBalance: false,
    footerText: null,
    fontScale: 1,
    boldBody: printer === 'impact',
    qrSize: 'auto',
    copies: 1,
    copyLabels: false,
    cutAfter: false,
    feedAfterMm: printer === 'thermal' ? 10 : 0,
    graphicsQuality: 'quality',
  };
}

/** الملف الحراري الافتراضي — شريط اليوم 58 مم كما هو (خياراته لا تُقرأ) */
export function legacyThermalProfile(): PrintProfile {
  return { id: LEGACY_THERMAL_ID, name: LEGACY_NAMES.thermal, printer: 'thermal', template: 'roll_classic', paper: presetPaper('roll58') as Paper, options: defaultPrintOptions('thermal') };
}

/** ملف PDF الافتراضي — قالب A4 اليوم كما هو */
export function legacyPageProfile(): PrintProfile {
  return { id: LEGACY_PAGE_ID, name: LEGACY_NAMES.page, printer: 'page', template: 'page_branded', paper: presetPaper('a4') as Paper, options: defaultPrintOptions('page') };
}

/** ما يعنيه printSettings = null: الزرّان كما اليوم — حرارية 58 مم للفواتير والسندات، وPDF الصورة A4 لكل شيء */
export function legacyPrintSettings(): PrintSettingsV1 {
  return {
    version: 1,
    profiles: [legacyThermalProfile(), legacyPageProfile()],
    routing: { invoice: LEGACY_THERMAL_ID, receipt: LEGACY_THERMAL_ID, statement: null, notices: null },
    pdfProfileId: LEGACY_PAGE_ID,
    repMayChoose: true,
  };
}

// ─── البنية (zod) — صارمة في الخادم (مفتاح مجهول ⇒ رفض)، ومتسامحة في الجهاز (مفتاح مجهول يُهمل) ───
// المدى والقواعد المتقاطعة في printSettingsIssues وحدها (رسائل عربية من مصدر واحد)؛ هنا الأنواع فقط.

function objectOf<T extends z.ZodRawShape>(shape: T, strict: boolean): z.ZodObject<T> {
  return (strict ? z.object(shape).strict() : z.object(shape)) as unknown as z.ZodObject<T>;
}

function makePrintSettingsSchema(strict: boolean) {
  const paper = objectOf({
    preset: z.enum(PAPER_PRESET_IDS),
    widthMm: z.number().finite(),
    lengthMm: z.number().finite().nullable(),
    feed: z.enum(PAPER_FEEDS),
    dpi: z.union([z.literal(180), z.literal(203), z.literal(300)]).nullable(),
    printableDots: z.number().int().nullable(),
    offsetXmm: z.number().finite(),
    marginTopMm: z.number().finite(),
    marginBottomMm: z.number().finite(),
  }, strict);
  const options = objectOf({
    showLogo: z.boolean(),
    showContact: z.boolean(),
    showRepName: z.boolean(),
    showSignatures: z.boolean(),
    showItemUnit: z.boolean(),
    showItemCodes: z.boolean(),
    showCustomerBalance: z.boolean(),
    footerText: z.string().nullable(),
    fontScale: z.union([z.literal(0.9), z.literal(1), z.literal(1.15), z.literal(1.3)]),
    boldBody: z.boolean(),
    qrSize: z.enum(QR_SIZES),
    copies: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    copyLabels: z.boolean(),
    cutAfter: z.boolean(),
    feedAfterMm: z.number().finite(),
    graphicsQuality: z.enum(GRAPHICS_QUALITIES),
  }, strict);
  const profile = objectOf({
    id: z.string(),
    name: z.string(),
    printer: z.enum(PRINTER_TYPES),
    template: z.enum(TEMPLATE_IDS),
    paper,
    options,
  }, strict);
  const routing = objectOf({
    invoice: z.string().nullable(),
    receipt: z.string().nullable(),
    statement: z.string().nullable(),
    notices: z.string().nullable(),
  }, strict);
  return objectOf({
    version: z.literal(1),
    profiles: z.array(profile), // العدد في printSettingsIssues برسالته (والحجم 16 كيلوبايت يسبق في الخادم)
    routing,
    pdfProfileId: z.string(),
    repMayChoose: z.boolean(),
  }, strict);
}

/** المخطط الصارم الذي يحفظ به PUT /api/company/print-settings */
export const printSettingsV1Schema = makePrintSettingsSchema(true);
const lenientSchema = makePrintSettingsSchema(false);

// ─── رسائل الرفض (عربية؛ مترجمة في قاموس الواجهة) ───

export const PRINT_ISSUES = Object.freeze({
  shape: 'بنية إعدادات الطباعة غير صالحة',
  unknownKey: 'حقل غير معروف في إعدادات الطباعة',
  tooLarge: 'إعدادات الطباعة أكبر من الحد المسموح 16 كيلوبايت',
  profilesCount: 'عدد قوالب الطباعة من 1 إلى 12',
  profileId: 'معرف قالب الطباعة غير صالح',
  duplicateId: 'معرف قالب الطباعة مكرر',
  nameRequired: 'اكتب اسم قالب الطباعة',
  nameTooLong: 'اسم قالب الطباعة أطول من 40 حرفا',
  duplicateName: 'يوجد قالب طباعة بهذا الاسم',
  templatePrinter: 'التصميم لا يناسب نوع الطابعة',
  classicReserved: 'الشريط الكلاسيكي 58 مم للإعداد الافتراضي وحده',
  presetPrinter: 'مقاس الورق لا يناسب نوع الطابعة',
  width: 'عرض الورق بين 40 و270 مم',
  feed: 'طريقة تغذية الورق لا تناسب نوع الطابعة',
  lengthRequired: 'حدد طول الصفحة',
  length: 'طول الصفحة بين 50 و1000 مم',
  margins: 'الهامش العلوي والسفلي بين 0 و40 مم',
  marginsTooBig: 'الهامشان لا يتركان من الصفحة ما يطبع عليه',
  offset: 'الإزاحة الأفقية بين سالب 15 وموجب 15 مم',
  dpi: 'دقة الطابعة لا تناسب نوعها',
  dotsRequired: 'حدد عرض الطباعة بالنقاط',
  dotsTooSmall: 'عرض الطباعة أقل من 256 نقطة',
  dotsTooWide: 'عرض الطباعة أعرض من الورق',
  dotsMultiple: 'عرض الطباعة الحرارية بالنقاط من مضاعفات 8',
  impactLine: 'عرض الطباعة النقطية مع إزاحتها يتجاوز سطر الطباعة 1440 نقطة (8 بوصات)',
  pageWidth: 'عرض ورق الطابعة العادية 148 مم على الأقل',
  detailedWidth: 'التصميم المفصل يحتاج عرض طباعة 72 مم على الأقل',
  footer: 'نص التذييل أطول من 160 حرفا',
  feedAfter: 'التغذية بعد الطباعة بين 0 و30 مم',
  routeMissing: 'القالب المختار لهذا المستند غير موجود',
  routeThermal: 'كشوف الحساب ومستندات المخزون لا تطبع على الطابعة الحرارية بعد',
  pdfMissing: 'قالب ملف PDF غير موجود',
  pdfNotPage: 'ملف PDF يحتاج قالبا لطابعة عادية',
});

export interface PrintIssue { path: string; message: string }

const charLen = (s: string): number => Array.from(s).length;
const inRange = (n: number, [lo, hi]: readonly [number, number]): boolean => Number.isFinite(n) && n >= lo && n <= hi;
const round1 = (n: number): number => Math.round(n * 10) / 10;
/** نصّ سطر واحد: محارف التحكم والأسطر والمسافات المتكررة ⇒ مسافة واحدة */
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();

/** طول JSON بالبايت (UTF-8) — بلا TextEncoder ليعمل في الخادم والمتصفح سواء */
export function printSettingsBytes(v: unknown): number {
  const s = JSON.stringify(v) ?? '';
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
  }
  return n;
}

/** قواعد قالبٍ واحد (المسار يبدأ بـat) */
export function profileIssues(p: PrintProfile, at: string): PrintIssue[] {
  const out: PrintIssue[] = [];
  const add = (path: string, message: string): void => { out.push({ path: `${at}.${path}`, message }); };
  const L = PRINT_LIMITS;
  if (!PROFILE_ID_RE.test(p.id)) add('id', PRINT_ISSUES.profileId);
  const name = p.name.trim();
  if (!name) add('name', PRINT_ISSUES.nameRequired);
  else if (charLen(name) > L.nameMax) add('name', PRINT_ISSUES.nameTooLong);
  if (templatePrinter(p.template) !== p.printer) add('template', PRINT_ISSUES.templatePrinter);
  if (p.template === 'roll_classic' && p.id !== LEGACY_THERMAL_ID) add('template', PRINT_ISSUES.classicReserved);

  const paper = p.paper;
  const owner = presetPrinter(paper.preset);
  if (owner !== null && owner !== p.printer) add('paper.preset', PRINT_ISSUES.presetPrinter);
  if (!inRange(paper.widthMm, L.widthMm)) add('paper.widthMm', PRINT_ISSUES.width);
  // الطابعة العادية: القالب يُصغَّر بعرض الورق ومعه الرمز المختوم — لا أضيق من A5 (الرول الضيّق للحرارية)
  else if (p.printer === 'page' && paper.widthMm < L.pageMinWidthMm) add('paper.widthMm', PRINT_ISSUES.pageWidth);
  if (!FEEDS_BY_PRINTER[p.printer].includes(paper.feed)) add('paper.feed', PRINT_ISSUES.feed);
  if (paper.feed !== 'roll') {
    if (paper.lengthMm === null) add('paper.lengthMm', PRINT_ISSUES.lengthRequired);
    else if (!inRange(paper.lengthMm, L.lengthMm)) add('paper.lengthMm', PRINT_ISSUES.length);
  }
  if (!inRange(paper.marginTopMm, L.marginMm) || !inRange(paper.marginBottomMm, L.marginMm)) add('paper.marginTopMm', PRINT_ISSUES.margins);
  else if (paper.lengthMm !== null && paper.marginTopMm + paper.marginBottomMm > paper.lengthMm - L.minBodyMm) add('paper.marginTopMm', PRINT_ISSUES.marginsTooBig);
  if (!inRange(paper.offsetXmm, L.offsetXmm)) add('paper.offsetXmm', PRINT_ISSUES.offset);

  if (p.printer !== 'page') {
    if (paper.dpi === null || !DPIS_BY_PRINTER[p.printer].includes(paper.dpi)) add('paper.dpi', PRINT_ISSUES.dpi);
    else if (paper.printableDots === null) add('paper.printableDots', PRINT_ISSUES.dotsRequired);
    else {
      const dots = paper.printableDots;
      const impact = p.printer === 'impact';
      if (dots < L.minPrintableDots) add('paper.printableDots', PRINT_ISSUES.dotsTooSmall);
      // النقطية: الحزمة وحدها ثم مع إزاحتها يميناً داخل سطر الطباعة 1440 — وإلا ضاع حبرٌ وراءه (اسم البائع أو طرف الرمز)
      else if (impact && dots > L.impactLineDots) add('paper.printableDots', PRINT_ISSUES.impactLine);
      else if (inRange(paper.widthMm, L.widthMm) && dots > maxPrintableDots(p.printer, paper.widthMm, paper.dpi)) add('paper.printableDots', PRINT_ISSUES.dotsTooWide);
      else if (impact && impactRightDots(dots, paper.offsetXmm, paper.dpi) > L.impactLineDots) add('paper.offsetXmm', PRINT_ISSUES.impactLine);
      if (p.printer === 'thermal' && dots % 8 !== 0) add('paper.printableDots', PRINT_ISSUES.dotsMultiple);
      // 72 مم كما تعدّها الطابعة: 576 على 203، و848 على 300 (مضاعف 8 الأدنى) — لا 850.4 لا تُطبع
      if (p.template === 'roll_detailed' && dots < maxPrintableDots(p.printer, L.detailedMinMm, paper.dpi)) add('template', PRINT_ISSUES.detailedWidth);
    }
  }

  const o = p.options;
  if (o.footerText !== null && charLen(o.footerText) > L.footerMax) add('options.footerText', PRINT_ISSUES.footer);
  if (!inRange(o.feedAfterMm, L.feedAfterMm)) add('options.feedAfterMm', PRINT_ISSUES.feedAfter);
  return out;
}

/** كل القواعد المتقاطعة — فارغة = صالح. تُشغَّل على الصورة القانونية (canonicalPrintSettings) */
export function printSettingsIssues(s: PrintSettingsV1): PrintIssue[] {
  const out: PrintIssue[] = [];
  if (s.profiles.length < 1 || s.profiles.length > PRINT_LIMITS.maxProfiles) out.push({ path: 'profiles', message: PRINT_ISSUES.profilesCount });
  const ids = new Set<string>();
  const names = new Set<string>();
  s.profiles.forEach((p, i) => {
    const at = `profiles[${i}]`;
    out.push(...profileIssues(p, at));
    if (ids.has(p.id)) out.push({ path: `${at}.id`, message: PRINT_ISSUES.duplicateId });
    ids.add(p.id);
    const key = p.name.trim().toLowerCase();
    if (key && names.has(key)) out.push({ path: `${at}.name`, message: PRINT_ISSUES.duplicateName });
    names.add(key);
  });
  const byId = new Map(s.profiles.map((p) => [p.id, p] as const));
  for (const kind of DOC_KINDS) {
    const id = s.routing[kind];
    if (id === null) continue;
    const p = byId.get(id);
    if (!p) out.push({ path: `routing.${kind}`, message: PRINT_ISSUES.routeMissing });
    else if (!routingAllowsPrinter(kind, p.printer)) out.push({ path: `routing.${kind}`, message: PRINT_ISSUES.routeThermal });
  }
  const pdf = byId.get(s.pdfProfileId);
  if (!pdf) out.push({ path: 'pdfProfileId', message: PRINT_ISSUES.pdfMissing });
  else if (pdf.printer !== 'page') out.push({ path: 'pdfProfileId', message: PRINT_ISSUES.pdfNotPage });
  return out;
}

/**
 * الصورة القانونية: ترتيب مفاتيح ثابت، وأطوال بعُشر مم، والاسم والتذييل سطراً واحداً (التذييل الفارغ null)، والرول بلا طول،
 * والعادية بلا نقاط ولا دقة — والملفان الافتراضيان يُعادان كما هما مهما أُرسل فيهما (يُنسخان ولا يُعدّلان).
 */
export function canonicalPrintSettings(s: PrintSettingsV1): PrintSettingsV1 {
  const profiles = s.profiles.map((p): PrintProfile => {
    if (p.id === LEGACY_THERMAL_ID) return legacyThermalProfile();
    if (p.id === LEGACY_PAGE_ID) return legacyPageProfile();
    const page = p.printer === 'page';
    const a = p.paper;
    const paper: Paper = {
      preset: a.preset,
      widthMm: round1(a.widthMm),
      lengthMm: a.feed === 'roll' || a.lengthMm === null ? null : round1(a.lengthMm),
      feed: a.feed,
      dpi: page ? null : a.dpi,
      printableDots: page ? null : a.printableDots,
      offsetXmm: round1(a.offsetXmm),
      marginTopMm: round1(a.marginTopMm),
      marginBottomMm: round1(a.marginBottomMm),
    };
    const o = p.options;
    const footer = o.footerText === null ? '' : oneLine(o.footerText);
    const options: PrintOptions = {
      showLogo: o.showLogo,
      showContact: o.showContact,
      showRepName: o.showRepName,
      showSignatures: o.showSignatures,
      showItemUnit: o.showItemUnit,
      showItemCodes: o.showItemCodes,
      showCustomerBalance: o.showCustomerBalance,
      footerText: footer ? footer : null,
      fontScale: o.fontScale,
      boldBody: o.boldBody,
      qrSize: o.qrSize,
      copies: o.copies,
      copyLabels: o.copyLabels,
      cutAfter: o.cutAfter,
      feedAfterMm: round1(o.feedAfterMm),
      graphicsQuality: o.graphicsQuality,
    };
    return { id: p.id, name: oneLine(p.name), printer: p.printer, template: p.template, paper, options };
  });
  return {
    version: 1,
    profiles,
    routing: { invoice: s.routing.invoice, receipt: s.routing.receipt, statement: s.routing.statement, notices: s.routing.notices },
    pdfProfileId: s.pdfProfileId,
    repMayChoose: s.repMayChoose,
  };
}

/**
 * إعدادٌ يساوي الافتراضي حرفياً (بصورته القانونية) — يُعامَل كـnull في القراءة: لا «مخصّص» في الخادم، ولا اختيار جهازٍ ولا سطر
 * «تغيير» في شاشة المستند. شبكة أمانٍ لـ«استعادة الافتراضي» إن حُفظ الافتراضي كائناً لا null (نسخة واجهةٍ أقدم مثلاً).
 */
export function isLegacyPrintSettings(s: PrintSettingsV1): boolean {
  return JSON.stringify(canonicalPrintSettings(s)) === JSON.stringify(legacyPrintSettings());
}

export type PrintSettingsCheck = { ok: true; value: PrintSettingsV1 } | { ok: false; issues: PrintIssue[] };

/**
 * البنية ثم الصورة القانونية ثم القواعد — strict للحفظ في الخادم (مفتاح مجهول ⇒ رفض)، وغير strict لقراءة الجهاز
 * (مفتاح أضافه خادم أحدث ضمن v1 يُهمل). نسخة غير 1 ترفض في الحالتين.
 */
export function checkPrintSettings(raw: unknown, strict: boolean): PrintSettingsCheck {
  const parsed = (strict ? printSettingsV1Schema : lenientSchema).safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join('.'),
        message: i.code === 'unrecognized_keys' ? PRINT_ISSUES.unknownKey : PRINT_ISSUES.shape,
      })),
    };
  }
  const shaped: PrintSettingsV1 = parsed.data; // فحص تصريف: مخرج zod يطابق الواجهات أعلاه
  const value = canonicalPrintSettings(shaped);
  const issues = printSettingsIssues(value);
  return issues.length ? { ok: false, issues } : { ok: true, value };
}
