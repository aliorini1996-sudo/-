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
// ما لا يوجد عمداً (التصميم §1.6 و§4): لا خيار يصغّر رمز QR عن حدّ القراءة، وقرار الطباعة (zatcaPrintDecision) يحكم المحتوى
// الإلزامي. وقرار المالك ٤ نوفمبر ٢٠٢٦: كل شيء يُحذف بخيار الشركة الصريح وحده — رمز QR والأصناف (sections.*.visible = false)
// وأختام الحالة (stamps = false) — مع تحذيرٍ قويّ؛ والغياب = مطبوعة اليوم حرفياً (isQrRemoved/isItemsRemoved/areStampsRemoved).
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

// ─── التخطيط (طلب المالك ٣ نوفمبر ٢٠٢٦): مكان الشعار وحجمه، ولون التمييز، وشكل الجدول، وترتيب الأقسام، والتصميم ثنائي اللغة ───
// اختياريٌّ في كل قالب (options.layout): غيابه = مطبوعة اليوم حرفياً، وليس في defaultPrintOptions عمداً. الترتيب تبديلٌ
// لأقسامٍ ثابتة (sectionsFor)، ورمز QR يُطبع على مستند المرحلة الثانية في كل ترتيب (داخل الإجماليات أو بيانات المستند في الصفحة،
// وقسماً مستقلاً بعد الأصناف في الرول) ما لم تحذفه الشركة صراحةً (قرار المالك ٤ نوفمبر ٢٠٢٦: كل شيء يُحذف، isQrRemoved). والتصميم
// ثنائي اللغة ليس TemplateId: هاتفٌ قديم يُهمل المفتاح المجهول فيطبع تصميم اليوم، بينما تصميمٌ مجهول في z.enum كان يُسقط إعداد
// الشركة كله إلى الافتراضي.

export const LAYOUT_DESIGNS = ['standard', 'grid_bilingual'] as const;
/** standard = تصميم القالب اليوم · grid_bilingual = «كلاسيكي بإطارات — ثنائي اللغة» (للصفحة والنقطية وحدهما) */
export type LayoutDesign = (typeof LAYOUT_DESIGNS)[number];
export const LOGO_POSITIONS = ['start', 'center', 'end', 'none'] as const;
/** start = يمين الورقة (اتجاه RTL) وهو مكان اليوم · none = بلا شعار */
export type LogoPosition = (typeof LOGO_POSITIONS)[number];
export const LOGO_SIZES = ['s', 'm', 'l'] as const;
export type LogoSize = (typeof LOGO_SIZES)[number];
export const TABLE_STYLES = ['lines', 'grid', 'striped'] as const;
/** lines = خطوط اليوم · grid = شبكة كاملة · striped = صفوف متناوبة (خطوط سوداء رفيعة على الأحادي) */
export type TableStyle = (typeof TABLE_STYLES)[number];
export const SECTION_IDS = ['header', 'info', 'parties', 'customer', 'items', 'note', 'totals', 'installments', 'qr', 'signatures', 'footer'] as const;
export type SectionId = (typeof SECTION_IDS)[number];
/** ألوان التمييز الجاهزة — كلها بتباين 3:1 على الأقل مع الأبيض (حارس في الاختبار) */
export const ACCENT_PALETTE = ['#E15A30', '#1F2937', '#0F766E', '#1D4ED8', '#7C3AED', '#B91C1C', '#047857', '#92400E'] as const;
export const ACCENT_RE = /^#[0-9A-Fa-f]{6}$/;

// ─── التحرير الحرّ (طلب المالك ٣ نوفمبر ٢٠٢٦) — مفاتيح اختيارية: غيابها = مطبوعة اليوم حرفياً ───
// أربعة مفاتيح في PrintLayout (logoMm، logoAfter، sections، canvas) لا تدخل defaultPrintLayout: نسخةٌ قديمة تُهملها في القراءة
// المتسامحة فتطبع تخطيط المفاتيح الستة. الأبعاد بالملّيمتر على الورقة (بخطوة 0.5)، وx في المصمّم من الحافة اليسرى الفعلية
// لصندوق المحتوى (الواجهة RTL تعكس الأدوات وحدها). رمز QR المرحلة الثانية يُطبع ما لم تحذفه الشركة صراحةً بـsections.qr =
// { visible: false } (قسمٌ حقيقي في الرول، وافتراضيٌّ في الصفحة والنقطية لا يقبل إلا visible)، ومربعه في المصمّم لا يصغر عن حدّ
// القراءة، وإن غاب عن اللوحتين ولم يُحذف طُبع في مكانه من التدفّق. ومثله الأصناف (sections.items) وأختام الحالة (stamps: false).
export const ALIGNS = ['start', 'center', 'end'] as const; // start = يمين الورقة (RTL)
export type Align = (typeof ALIGNS)[number];
export const CANVAS_BANDS = ['header', 'footer'] as const;
export type CanvasBand = (typeof CANVAS_BANDS)[number];
export const CANVAS_BOX_IDS = ['logo', 'company', 'title', 'docInfo', 'customer', 'qr', 'totals', 'signatures', 'footer'] as const;
export type CanvasBoxId = (typeof CANVAS_BOX_IDS)[number];
/** بعد الأصناف دائماً — فلا تكون في رأس الورقة */
export const CANVAS_FOOTER_ONLY: readonly CanvasBoxId[] = ['totals', 'signatures'];
/** تُخفى بخيار الشركة الصريح وحده، مع تحذيرٍ قويّ: حذفها يجعل الفاتورة الضريبية غير مطابقة لمتطلبات الهيئة */
export const COMPLIANCE_HIDE_SECTIONS: readonly SectionId[] = Object.freeze(['items', 'qr'] as SectionId[]);
/** عرض صندوق المحتوى بالمم في قالب 794 بكسل: الصفحة (794−80)/MM_PX = 188.9، والنقطية 201.6 */
export const CANVAS_CONTENT_MM = Object.freeze({ page: 188, impact: 201 });
export const LAYOUT_BOUNDS = Object.freeze({
  logoMm: [6, 120] as const, fontPct: [70, 160] as const, spaceMm: [0, 30] as const,
  headerMm: [0, 150] as const, footerMm: [0, 120] as const, bandsTotalMm: 200,
  boxMinMm: 5, qrBoxMinMm: 47, maxBoxes: 9, stepMm: 0.5,
  /** ما يبقى للأصناف على الأقل من طول الصفحة بعد اللوحتين (bandsTotalFor) */
  minItemsMm: 40,
});

/** ما يلزم من الورق لحساب سقف اللوحتين — Paper كاملاً أو بعضه */
export type BandsPaper = Pick<Paper, 'lengthMm' | 'marginTopMm' | 'marginBottomMm'> & { feed?: PaperFeed };

/**
 * سقف مجموع اللوحتين (رأس الورقة + تذييلها) على هذا الورق: 200 مم، ولا أكثر مما يبقى من طول الصفحة بعد الهامشين و40 مم
 * للأصناف — فلا تأكل اللوحتان صفحة A5 (210 ⇒ 150) أو نصف الصفحة المتصلة ff_95x55 (139.7 ⇒ 89.5) كلها. الرول وما بلا طول: 200
 * كما هو، وA4 (277 − 40 ≥ 200) لا يتغيّر. على شبكة 0.5 (للأسفل)، ولا يقلّ عن 0.
 */
export function bandsTotalFor(paper: BandsPaper | null | undefined): number {
  const B = LAYOUT_BOUNDS;
  if (!paper || paper.feed === 'roll') return B.bandsTotalMm;
  const len = paper.lengthMm;
  if (typeof len !== 'number' || !Number.isFinite(len)) return B.bandsTotalMm;
  const m = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const room = len - m(paper.marginTopMm) - m(paper.marginBottomMm) - B.minItemsMm;
  return Math.min(B.bandsTotalMm, Math.max(0, Math.floor(room / B.stepMm + 1e-9) * B.stepMm));
}

export interface SectionStyle {
  visible?: boolean; // false = مخفي بخيار الشركة الصريح (الأصناف ورمز QR معه تحذير COMPLIANCE_HIDE_SECTIONS)؛ الغياب = اليوم
  align?: Align;
  fontPct?: number; // 70–160 عدد صحيح
  spaceBeforeMm?: number; // 0–30 بخطوة 0.5
  spaceAfterMm?: number;
}
export interface CanvasBox { id: CanvasBoxId; band: CanvasBand; x: number; y: number; w: number; h: number; align?: Align; fontPct?: number }
export interface PrintCanvas { headerMm: number; footerMm: number; boxes: CanvasBox[] }

export interface PrintLayout {
  design: LayoutDesign;
  logo: LogoPosition;
  logoSize: LogoSize;
  /** #RRGGBB بتباين ≥ 3:1 مع الأبيض — null = لون الشركة (company.primaryColor) كاليوم. لا أثر له على الأحادي */
  accent: string | null;
  tableStyle: TableStyle;
  /** تبديلٌ لـsectionsFor(printer, design) — لا يُحذف به قسم */
  order: SectionId[];
  /** أقصى عرض وارتفاع للشعار بمم الورقة — يتقدّم على logoSize متى وُجد (logoSize يبقى لنسخةٍ أقدم) */
  logoMm?: number;
  /** كتلة شعار مستقلة أعلى الورقة أو بعد قسم — غيابه = الشعار داخل الترويسة كاليوم */
  logoAfter?: SectionId | 'top';
  /** تنسيق كل قسم: إظهار ومحاذاة وحجم خط ومسافات */
  sections?: Partial<Record<SectionId, SectionStyle>>;
  /** المصمّم الحر: لوحتا رأس الورقة وتذييلها — للصفحة والنقطية بالتصميم القياسي فقط */
  canvas?: PrintCanvas;
  /**
   * false = حذفت الشركة أختام الحالة (وسم نسخة المحاكاة، وإشعار سند التسليم والإلغاء، وختم السند الملغى) بخيارها الصريح؛
   * الغياب أو true = اليوم. ليس في defaultPrintLayout عمداً
   */
  stamps?: boolean;
}

type HideLike = { sections?: Partial<Record<SectionId, { visible?: boolean } | undefined>>; stamps?: boolean } | null | undefined;
/** حذفت الشركة رمز QR صراحةً (sections.qr.visible === false) — الطريق الوحيد لقراءة هذا الخيار */
export function isQrRemoved(l: HideLike): boolean { return l?.sections?.qr?.visible === false; }
/** حذفت الشركة جدول الأصناف صراحةً */
export function isItemsRemoved(l: HideLike): boolean { return l?.sections?.items?.visible === false; }
/** حذفت الشركة أختام الحالة صراحةً (stamps === false) */
export function areStampsRemoved(l: HideLike): boolean { return l?.stamps === false; }

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
  /** التخطيط — غيابه = مطبوعة اليوم حرفياً (ومنه fontScale لا يُطبَّق على الصفحة والنقطية إلا معه) */
  layout?: PrintLayout;
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
  maxBytes: 48 * 1024, // لا صور (الشعار من company.logo) — الحدّ يحرس صفّ الشركة الذي يُقرأ مع كل /company (48 للتصاميم الحرّة)
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
  const num = z.number().finite();
  /** مفتاحٌ حرّ اختياري — المتسامح يُسقطه وحده إن لم يفهمه */
  const free = <T extends z.ZodTypeAny>(t: T) => (strict ? t.optional() : t.optional().catch(undefined));
  const style = objectOf({
    visible: z.boolean().optional(),
    align: z.enum(ALIGNS).optional(),
    fontPct: num.optional(),
    spaceBeforeMm: num.optional(),
    spaceAfterMm: num.optional(),
  }, strict);
  const sections = objectOf(
    Object.fromEntries(SECTION_IDS.map((id) => [id, strict ? style.optional() : style.optional().catch(undefined)])) as Record<SectionId, z.ZodOptional<typeof style>>,
    strict,
  );
  const box = objectOf({
    id: z.enum(CANVAS_BOX_IDS),
    band: z.enum(CANVAS_BANDS),
    x: num,
    y: num,
    w: num,
    h: num,
    align: z.enum(ALIGNS).optional(),
    fontPct: num.optional(),
  }, strict);
  const canvas = objectOf({ headerMm: num, footerMm: num, boxes: z.array(box).max(LAYOUT_BOUNDS.maxBoxes) }, strict);
  const layout = objectOf({
    design: z.enum(LAYOUT_DESIGNS),
    logo: z.enum(LOGO_POSITIONS),
    logoSize: z.enum(LOGO_SIZES),
    accent: z.string().regex(ACCENT_RE).nullable(),
    tableStyle: z.enum(TABLE_STYLES),
    order: z.array(z.enum(SECTION_IDS)).min(1).max(12),
    // التحرير الحرّ: الحفظ يرفض التالف 400، والقراءة تُسقط المفتاح الذي لا تفهمه وحده (لا التخطيط كله)
    logoMm: free(num),
    logoAfter: free(z.union([z.enum(SECTION_IDS), z.literal('top')])),
    sections: free(sections),
    canvas: free(canvas),
    stamps: free(z.boolean()),
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
    // الحفظ: تخطيطٌ تالف ⇒ 400. القراءة: تخطيطٌ لا تفهمه هذه النسخة يسقط وحده ويبقى القالب (لا يرجع الجهاز للافتراضي)
    layout: strict ? layout.optional() : layout.optional().catch(undefined),
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
    profiles: z.array(profile), // العدد في printSettingsIssues برسالته (والحجم 48 كيلوبايت يسبق في الخادم)
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
  tooLarge: 'إعدادات الطباعة أكبر من الحد المسموح 48 كيلوبايت',
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
  layoutClassic: 'الرول الكلاسيكي لا يقبل تخطيطاً مخصصاً',
  layoutDesignPrinter: 'التصميم ثنائي اللغة لطابعات A4 والنقطية فقط',
  layoutRoll: 'في الرول: التصميم القياسي وحده',
  layoutOrder: 'ترتيب الأقسام ناقص أو مكرر',
  layoutHeaderFirst: 'الترويسة أول المطبوعة دائماً',
  layoutFooterLast: 'التواقيع ثم التذييل في آخر المطبوعة دائماً',
  layoutItemsTotals: 'الإجماليات بعد جدول الأصناف',
  layoutQrAfterItems: 'رمز QR بعد جدول الأصناف',
  layoutAccent: 'لون التمييز فاتح جداً لا يقرأ على الورق — اختر لوناً أغمق',
  layoutLogoMm: 'حجم الشعار خارج الحدود (من 6 إلى 120 ملم)',
  layoutLogoAfter: 'مكان الشعار يجب أن يكون أعلى الورقة أو بعد قسمٍ من أقسام هذا القالب',
  layoutSectionUnknown: 'تنسيقٌ لقسمٍ ليس في هذا القالب',
  layoutSectionBounds: 'تنسيق القسم خارج الحدود: الخط من 70 إلى 160 بالمئة والمسافة من 0 إلى 30 ملم',
  layoutCanvasPrinter: 'التصميم الحر بالسحب للصفحة والنقطية بالتصميم القياسي فقط',
  layoutCanvasBands: 'ارتفاع رأس الورقة وتذييلها خارج الحدود (المجموع حتى 200 ملم)',
  layoutCanvasBandsPaper: 'رأس الورقة وتذييلها أطول مما يتسع له طول هذا الورق (يبقى 40 ملم على الأقل للأصناف)',
  layoutCanvasBox: 'مربعٌ خارج حدود الورقة أو أصغر من 5 ملم أو مكرر',
  layoutCanvasFooterOnly: 'الإجماليات والتوقيعات في تذييل الورقة فقط (بعد الأصناف)',
  layoutCanvasQr: 'مربع رمز QR أصغر من الحد المقروء (47 ملم)',
});

export interface PrintIssue { path: string; message: string }
/** اسمٌ آخر لـPrintIssue (عقد التخطيط) */
export type PrintSettingsIssue = PrintIssue;

// ─── أقسام المطبوعة وترتيبها ───

const SECTIONS_PAGE: readonly SectionId[] = Object.freeze(['header', 'info', 'items', 'note', 'totals', 'installments', 'signatures', 'footer'] as SectionId[]);
const SECTIONS_GRID: readonly SectionId[] = Object.freeze(['header', 'info', 'parties', 'items', 'note', 'totals', 'installments', 'signatures', 'footer'] as SectionId[]);
const SECTIONS_ROLL: readonly SectionId[] = Object.freeze(['header', 'info', 'customer', 'items', 'totals', 'signatures', 'qr', 'footer'] as SectionId[]);

/** أقسام المطبوعة بترتيب اليوم — الرول تصميمٌ واحد (ثنائي اللغة للصفحة والنقطية وحدهما) */
export function sectionsFor(printer: PrinterType, design: LayoutDesign): readonly SectionId[] {
  if (printer === 'thermal') return SECTIONS_ROLL;
  return design === 'grid_bilingual' ? SECTIONS_GRID : SECTIONS_PAGE;
}

/** التخطيط الافتراضي لتصميم — هو مطبوعة اليوم بترتيبها (والثنائي بشعارٍ في الوسط وشبكة) */
export function defaultPrintLayout(printer: PrinterType, design: LayoutDesign = 'standard'): PrintLayout {
  const d: LayoutDesign = printer === 'thermal' ? 'standard' : design;
  const grid = d === 'grid_bilingual';
  return {
    design: d,
    logo: grid || printer === 'thermal' ? 'center' : 'start',
    logoSize: 'm',
    accent: null,
    tableStyle: grid ? 'grid' : 'lines',
    order: [...sectionsFor(printer, d)],
  };
}

/** ما يُسمح أن يلي التواقيع: التذييل وحده، وفي الرول رمز QR ثم التذييل (ترتيب اليوم) */
const tailAfterSignaturesOk = (tail: readonly SectionId[], printer: PrinterType): boolean =>
  (tail.length === 1 && tail[0] === 'footer') || (printer === 'thermal' && tail.length === 2 && tail[0] === 'qr' && tail[1] === 'footer');

/**
 * ترتيبٌ صالح دائماً من أي مدخل: المعروف لهذا التصميم مرةً واحدة بترتيبه، والناقص في موضعه الافتراضي (بعد أقرب سابقٍ له)، ثم
 * الترويسة أولاً، والتواقيع ثم التذييل آخراً (وفي الرول رمز QR بينهما إن كان بعد التواقيع)، والإجماليات بعد الأصناف، وفي الرول
 * رمز QR بعد الأصناف. متساوي القوى: normalize(normalize(x)) = normalize(x)، والترتيب الصالح يعود كما هو.
 */
export function normalizeSectionOrder(order: readonly string[], printer: PrinterType, design: LayoutDesign): SectionId[] {
  const def = sectionsFor(printer, design);
  const seen: SectionId[] = [];
  for (const id of order) if ((def as readonly string[]).includes(id) && !seen.includes(id as SectionId)) seen.push(id as SectionId);
  const roll = printer === 'thermal';
  // رمز QR الرول في ذيله (بين التواقيع والتذييل كاليوم) إن جاء بعد التواقيع أو غاب، وإلا فبعد الأصناف
  const qi = seen.indexOf('qr');
  const si = seen.indexOf('signatures');
  const qrTail = roll && (qi < 0 || (si >= 0 && qi > si));
  const pinned = (id: SectionId): boolean => id === 'header' || id === 'signatures' || id === 'footer' || (qrTail && id === 'qr');
  const body = seen.filter((id) => !pinned(id));
  def.forEach((id, di) => {
    if (pinned(id) || body.includes(id)) return;
    let at = 0;
    for (let k = di - 1; k >= 0; k--) {
      const j = body.indexOf(def[k]);
      if (j >= 0) { at = j + 1; break; }
    }
    body.splice(at, 0, id);
  });
  const after = (id: SectionId, anchor: SectionId): void => {
    const i = body.indexOf(id);
    const a = body.indexOf(anchor);
    if (i >= 0 && a >= 0 && i < a) { body.splice(i, 1); body.splice(body.indexOf(anchor) + 1, 0, id); }
  };
  after('totals', 'items');
  if (roll && !qrTail) after('qr', 'items');
  return ['header', ...body, 'signatures', ...(qrTail ? (['qr'] as SectionId[]) : []), 'footer'];
}

/** تباين اللون مع الأبيض بمعيار WCAG (الإضاءة النسبية) ≥ 3:1 — أفتح منه لا يُقرأ عنواناً ولا خطاً على الورق */
export function accentContrastOk(hex: string): boolean {
  if (!ACCENT_RE.test(hex)) return false;
  const ch = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  return 1.05 / (lum + 0.05) >= 3;
}

const inRangeL = (n: unknown, [lo, hi]: readonly [number, number]): boolean => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
const EPS = 1e-9;

/** عيبٌ في مفتاحٍ حرّ — key يحدّد ما يُسقطه الإصلاح المتسامح (والقسم المعيب وحده في sections) */
interface FreeFault { key: 'logoMm' | 'logoAfter' | 'sections' | 'canvas'; section?: SectionId; path: string; message: string }

/**
 * قواعد المفاتيح الحرّة — فارغة بلا أيٍّ منها. لا قسم مقفلاً (قرار المالك ٤ نوفمبر ٢٠٢٦): إخفاء الأصناف ورمز QR خيار الشركة
 * الصريح. ورمز QR في الصفحة والنقطية قسمٌ افتراضي ليس في sectionsFor: يُقبل تنسيقه بمفتاح visible وحده (الحذف)، وغيره «ليس في القالب».
 */
function freeLayoutFaults(p: PrintProfile): FreeFault[] {
  const l = p.options.layout;
  if (!l) return [];
  const out: FreeFault[] = [];
  const B = LAYOUT_BOUNDS;
  const def = sectionsFor(p.printer, l.design);
  if (l.logoMm !== undefined && !inRangeL(l.logoMm, B.logoMm)) out.push({ key: 'logoMm', path: 'logoMm', message: PRINT_ISSUES.layoutLogoMm });
  if (l.logoAfter !== undefined && l.logoAfter !== 'top' && !def.includes(l.logoAfter)) out.push({ key: 'logoAfter', path: 'logoAfter', message: PRINT_ISSUES.layoutLogoAfter });
  if (l.sections !== undefined) {
    for (const [k, s] of Object.entries(l.sections) as Array<[SectionId, SectionStyle | undefined]>) {
      if (s === undefined) continue;
      const at = `sections.${k}`;
      if (!def.includes(k)) {
        if (k === 'qr' && Object.keys(s).every((key) => key === 'visible')) continue;
        out.push({ key: 'sections', section: k, path: at, message: PRINT_ISSUES.layoutSectionUnknown });
        continue;
      }
      if ((s.fontPct !== undefined && !inRangeL(s.fontPct, B.fontPct))
        || (s.spaceBeforeMm !== undefined && !inRangeL(s.spaceBeforeMm, B.spaceMm))
        || (s.spaceAfterMm !== undefined && !inRangeL(s.spaceAfterMm, B.spaceMm))) out.push({ key: 'sections', section: k, path: at, message: PRINT_ISSUES.layoutSectionBounds });
    }
  }
  const c = l.canvas;
  if (c !== undefined) {
    const fault = (path: string, message: string): void => { out.push({ key: 'canvas', path: `canvas.${path}`, message }); };
    if (p.printer === 'thermal' || l.design !== 'standard') fault('boxes', PRINT_ISSUES.layoutCanvasPrinter);
    else {
      const bandsOk = inRangeL(c.headerMm, B.headerMm) && inRangeL(c.footerMm, B.footerMm) && c.headerMm + c.footerMm <= B.bandsTotalMm + EPS;
      if (!bandsOk) fault('headerMm', PRINT_ISSUES.layoutCanvasBands);
      // الورق القصير (A5، نصف الصفحة المتصلة): اللوحتان لا تأكلان الصفحة — يبقى للأصناف 40 مم على الأقل
      else if (c.headerMm + c.footerMm > bandsTotalFor(p.paper) + EPS) fault('headerMm', PRINT_ISSUES.layoutCanvasBandsPaper);
      const contentW = CANVAS_CONTENT_MM[p.printer];
      if (c.boxes.length > B.maxBoxes) fault('boxes', PRINT_ISSUES.layoutCanvasBox);
      const seen = new Set<CanvasBoxId>();
      c.boxes.forEach((b, i) => {
        const bandH = b.band === 'header' ? c.headerMm : c.footerMm;
        const fin = [b.x, b.y, b.w, b.h].every((n) => typeof n === 'number' && Number.isFinite(n));
        if (!fin || b.x < -EPS || b.y < -EPS || b.w < B.boxMinMm - EPS || b.h < B.boxMinMm - EPS || b.x + b.w > contentW + EPS
          || !Number.isFinite(bandH) || bandH <= 0 || b.y + b.h > bandH + EPS || seen.has(b.id)
          || (b.fontPct !== undefined && !inRangeL(b.fontPct, B.fontPct))) fault(`boxes[${i}]`, PRINT_ISSUES.layoutCanvasBox);
        seen.add(b.id);
        if (b.band === 'header' && CANVAS_FOOTER_ONLY.includes(b.id)) fault(`boxes[${i}].band`, PRINT_ISSUES.layoutCanvasFooterOnly);
        if (b.id === 'qr' && fin && (b.w < B.qrBoxMinMm - EPS || b.h < B.qrBoxMinMm - EPS)) fault(`boxes[${i}]`, PRINT_ISSUES.layoutCanvasQr);
      });
    }
  }
  return out;
}

/**
 * القراءة المتسامحة على الورق القصير: لوحتان في حدودهما الثابتة لكن أطول مما يتّسع له الورق (bandsTotalFor) تُقصّان — التذييل
 * أولاً ثم الرأس كما يرسم resolveCanvas — ومربعاتهما تُرفع وتُقصّ داخلهما، والمربع الذي لا تتّسع له لوحته يعود إلى مكانه من
 * التدفّق (ورمز QR يُطبع هناك ما لم تحذفه الشركة صراحةً، isQrRemoved — وحذفه لا يغيّر السقف ولا حدّ 47). فلا يسقط التصميم بخطأ
 * الورق وحده؛ وغيره (أو ما في حدّ ورقه) يعود كما هو — الكائن نفسه.
 */
function fitCanvasToPaper(c: PrintCanvas, paper: Paper): PrintCanvas {
  const B = LAYOUT_BOUNDS;
  if (!inRangeL(c.headerMm, B.headerMm) || !inRangeL(c.footerMm, B.footerMm) || c.headerMm + c.footerMm > B.bandsTotalMm + EPS) return c;
  const total = bandsTotalFor(paper);
  if (c.headerMm + c.footerMm <= total + EPS) return c;
  const headerMm = Math.min(c.headerMm, total);
  const footerMm = Math.max(0, Math.min(c.footerMm, total - headerMm));
  const boxes: CanvasBox[] = [];
  for (const b of c.boxes) {
    const bandH = b.band === 'header' ? headerMm : footerMm;
    if (bandH < (b.id === 'qr' ? B.qrBoxMinMm : B.boxMinMm) - EPS) continue;
    const h = Math.min(b.h, bandH);
    boxes.push({ ...b, h, y: Math.max(0, Math.min(b.y, bandH - h)) });
  }
  return { headerMm, footerMm, boxes };
}

/** قواعد تخطيط القالب (المسار يبدأ بـat) — لا شيء بلا تخطيط. تُستدعى من profileIssues */
export function layoutIssues(p: PrintProfile, at: string): PrintIssue[] {
  const l = p.options.layout;
  if (!l) return [];
  const out: PrintIssue[] = [];
  const add = (path: string, message: string): void => { out.push({ path: `${at}.options.layout.${path}`, message }); };
  if (p.template === 'roll_classic' || p.id === LEGACY_THERMAL_ID) add('design', PRINT_ISSUES.layoutClassic);
  const roll = p.printer === 'thermal';
  // الرول بالتصميم القياسي وحده (layoutDesignPrinter كاليوم، وlayoutRoll معه) — والشعار بمواضعه الأربعة وأشكال الجدول الثلاثة
  // مقبولة فيه منذ التحرير الحرّ
  if (roll && l.design !== 'standard') { add('design', PRINT_ISSUES.layoutDesignPrinter); add('design', PRINT_ISSUES.layoutRoll); }
  if (l.accent !== null && !accentContrastOk(l.accent)) add('accent', PRINT_ISSUES.layoutAccent);
  for (const f of freeLayoutFaults(p)) add(f.path, f.message);
  const def = sectionsFor(p.printer, l.design);
  const o = l.order;
  if (o.length !== def.length || new Set(o).size !== o.length || o.some((id) => !def.includes(id))) {
    add('order', PRINT_ISSUES.layoutOrder);
    return out;
  }
  if (o[0] !== 'header') add('order', PRINT_ISSUES.layoutHeaderFirst);
  if (!tailAfterSignaturesOk(o.slice(o.indexOf('signatures') + 1), p.printer)) add('order', PRINT_ISSUES.layoutFooterLast);
  if (o.indexOf('totals') < o.indexOf('items')) add('order', PRINT_ISSUES.layoutItemsTotals);
  if (roll && o.indexOf('qr') < o.indexOf('items')) add('order', PRINT_ISSUES.layoutQrAfterItems);
  return out;
}

/**
 * قراءة الجهاز (المتسامحة): ترتيبٌ ناقص أو أقدم من أقسام هذه النسخة يُصلَح بـnormalizeSectionOrder، وتخطيطٌ يبقى بعدها غير صالح
 * يسقط وحده — القالب يطبع تصميم اليوم ولا يرجع الإعداد كله للافتراضي. (الحفظ الصارم يرفض الترتيب المكسور 400 ولا يُصلحه.)
 */
function repairLayout(p: PrintProfile): PrintProfile {
  const l = p.options.layout;
  if (!l) return p;
  const layout: PrintLayout = { ...l, order: normalizeSectionOrder(l.order, p.printer, l.design) };
  // لوحتان أطول مما يتّسع له الورق القصير تُقصّان لا تسقطان (fitCanvasToPaper)
  if (layout.canvas !== undefined) layout.canvas = fitCanvasToPaper(layout.canvas, p.paper);
  // المفاتيح الحرّة أولاً: كل مفتاحٍ معيب يسقط وحده (والقسم المعيب وحده؛ وإخفاء الأصناف أو QR الصريح يبقى) — ثم قواعد اليوم
  const faults = freeLayoutFaults({ ...p, options: { ...p.options, layout } });
  if (faults.length) {
    const sections: Partial<Record<SectionId, SectionStyle>> = { ...(layout.sections ?? {}) };
    for (const f of faults) {
      if (f.key !== 'sections') { delete layout[f.key]; continue; }
      delete sections[f.section as SectionId];
    }
    if (layout.sections !== undefined) {
      if (Object.keys(sections).length) layout.sections = sections;
      else delete layout.sections;
    }
  }
  const fixed: PrintProfile = { ...p, options: { ...p.options, layout } };
  if (layoutIssues(fixed, '').length === 0) return fixed;
  const options: PrintOptions = { ...p.options };
  delete options.layout;
  return { ...p, options };
}

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
  out.push(...layoutIssues(p, at));
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

/** المم بخطوة 0.5 */
const roundHalf = (n: number): number => Math.round(n * 2) / 2;
/** التقريب داخل الحدود وحدها — ما خارجها يبقى كما أُرسل ليُرفض برسالته (5.9 لا تصير 6 فتُقبل) */
const roundIn = (n: number, [lo, hi]: readonly [number, number], round: (v: number) => number): number => (n >= lo && n <= hi ? round(n) : n);
const B_ = LAYOUT_BOUNDS;

/** تنسيقات الأقسام: أقسام التصميم بترتيبها ثم غيرها (لتُرفض في الحفظ لا تختفي)، ومفاتيح بترتيب ثابت؛ الفارغ يسقط */
function canonicalSections(src: Partial<Record<SectionId, SectionStyle>>, def: readonly SectionId[]): Partial<Record<SectionId, SectionStyle>> | null {
  const ids = [...def, ...SECTION_IDS.filter((id) => !def.includes(id))];
  const out: Partial<Record<SectionId, SectionStyle>> = {};
  for (const id of ids) {
    const s = src[id];
    if (!s) continue;
    const c: SectionStyle = {};
    if (s.visible !== undefined) c.visible = s.visible;
    if (s.align !== undefined) c.align = s.align;
    if (s.fontPct !== undefined) c.fontPct = roundIn(s.fontPct, B_.fontPct, Math.round);
    if (s.spaceBeforeMm !== undefined) c.spaceBeforeMm = roundIn(s.spaceBeforeMm, B_.spaceMm, roundHalf);
    if (s.spaceAfterMm !== undefined) c.spaceAfterMm = roundIn(s.spaceAfterMm, B_.spaceMm, roundHalf);
    if (Object.keys(c).length) out[id] = c;
  }
  return Object.keys(out).length ? out : null;
}

/** اللوحتان: أطوال بخطوة 0.5، والمربعات بترتيب اللوحة (رأس ثم تذييل) ثم ترتيب CANVAS_BOX_IDS */
function canonicalCanvas(c: PrintCanvas): PrintCanvas {
  const boxes = c.boxes.map((b): CanvasBox => {
    const box: CanvasBox = { id: b.id, band: b.band, x: roundHalf(b.x), y: roundHalf(b.y), w: roundHalf(b.w), h: roundHalf(b.h) };
    if (b.align !== undefined) box.align = b.align;
    if (b.fontPct !== undefined) box.fontPct = roundIn(b.fontPct, B_.fontPct, Math.round);
    return box;
  });
  const rank = (b: CanvasBox): number => CANVAS_BANDS.indexOf(b.band) * 100 + CANVAS_BOX_IDS.indexOf(b.id);
  boxes.sort((a, b) => rank(a) - rank(b));
  return { headerMm: roundIn(c.headerMm, B_.headerMm, roundHalf), footerMm: roundIn(c.footerMm, B_.footerMm, roundHalf), boxes };
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
    // التخطيط بترتيب مفاتيح ثابت حين يوجد وحده — لا layout: undefined أبداً (الغياب = مطبوعة اليوم)
    if (o.layout) {
      const l = o.layout;
      const layout: PrintLayout = { design: l.design, logo: l.logo, logoSize: l.logoSize, accent: l.accent === null ? null : l.accent.toUpperCase(), tableStyle: l.tableStyle, order: [...l.order] };
      // المفاتيح الحرّة بعد الستة، كلٌّ حين يوجد وحده (لا undefined أبداً)
      if (l.logoMm !== undefined) layout.logoMm = roundIn(l.logoMm, B_.logoMm, roundHalf);
      if (l.logoAfter !== undefined) layout.logoAfter = l.logoAfter;
      if (l.sections !== undefined) {
        const sections = canonicalSections(l.sections, sectionsFor(p.printer, l.design));
        if (sections) layout.sections = sections;
      }
      if (l.canvas !== undefined) layout.canvas = canonicalCanvas(l.canvas);
      if (l.stamps !== undefined) layout.stamps = l.stamps;
      options.layout = layout;
    }
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
 * رسالة القاعدة لعطب بنيةٍ في مفتاحٍ حرّ (رقم غير منتهٍ، مكان شعار مجهول، أكثر من 9 مربعات، قسمٌ مجهول) بدل «البنية غير
 * صالحة» — والمفتاح المجهول داخل تنسيق قسمٍ أو مربعٍ أو اللوحتين يبقى «حقل غير معروف».
 */
function freeShapeMessage(path: ReadonlyArray<PropertyKey>, code: string): string | null {
  const at = path.indexOf('layout');
  if (at < 0) return null;
  const key = path[at + 1];
  const depth = path.length - at - 1;
  if (key === 'logoMm') return PRINT_ISSUES.layoutLogoMm;
  if (key === 'logoAfter') return PRINT_ISSUES.layoutLogoAfter;
  if (key === 'sections') {
    if (code === 'unrecognized_keys') return depth === 1 ? PRINT_ISSUES.layoutSectionUnknown : null;
    return PRINT_ISSUES.layoutSectionBounds;
  }
  if (key === 'canvas') {
    if (code === 'unrecognized_keys') return null;
    return path[at + 2] === 'headerMm' || path[at + 2] === 'footerMm' ? PRINT_ISSUES.layoutCanvasBands : PRINT_ISSUES.layoutCanvasBox;
  }
  return null;
}

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
        message: freeShapeMessage(i.path, i.code) ?? (i.code === 'unrecognized_keys' ? PRINT_ISSUES.unknownKey : PRINT_ISSUES.shape),
      })),
    };
  }
  const shaped: PrintSettingsV1 = parsed.data; // فحص تصريف: مخرج zod يطابق الواجهات أعلاه
  const canon = canonicalPrintSettings(shaped);
  // القراءة المتسامحة تُصلح الترتيب أو تُسقط التخطيط وحده (repairLayout)؛ والحفظ يفحصه كما أُرسل
  const value = strict ? canon : { ...canon, profiles: canon.profiles.map(repairLayout) };
  const issues = printSettingsIssues(value);
  return issues.length ? { ok: false, issues } : { ok: true, value };
}
