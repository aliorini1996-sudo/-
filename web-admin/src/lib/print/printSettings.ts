/**
 * «إعدادات الطباعة» في الواجهة (طلب المالك ٢٣ أكتوبر ٢٠٢٦، التصميم §1–§3 و§5) — منطقٌ صرف معزول عن React ليُختبر وحده.
 *
 * القاعدة الأولى: القيمة الخام (CompanySettings.printSettings، تصل مع /company وذاكرة المندوب أوف-لاين) لا تُقرأ إلا عبر
 * normalizePrintSettings — null أو نسخة أحدث أو أيّ عطب ⇒ السلوك الافتراضي حرفياً (legacyPrintSettings: شريط 58 مم وPDF
 * الـA4). فجوال مندوبٍ بنسخة قديمة لا يطبع ورقةً لم يُصمَّم لها أبداً، بل يعود لما يعرفه.
 *
 * والجهاز يختار بين قوالب الشركة إن سمحت (repMayChoose)، ويحفظ اختياره واتصال طابعته عنده (M2) — الطابعة صفةُ السيارة
 * أو الجوال لا المندوب ولا الشركة: شاحنات MIP480 ورول 80 مم جنباً إلى جنب في شركة واحدة.
 *
 * رمز QR هنا حساب مقاسات فقط (نقاط الخلية، الاتساع، المقاس الفعلي) — لا بناء رمز ولا قيمة: القرار الضريبي يبقى لـ
 * zatcaPrintDecision في كل قالب، والحدّ الأدنى لكل دقة لا ينزل أبداً (حارس في الاختبار).
 */
import {
  DOC_KINDS, LEGACY_NAMES, LEGACY_PAGE_ID, LEGACY_THERMAL_ID, PRINT_ISSUES, TEMPLATES_BY_PRINTER, checkPrintSettings, defaultPrintOptions, dotsPerMm,
  isLegacyPrintSettings, legacyPrintSettings, legacyThermalProfile, maxPrintableDots, presetPaper, routingAllowsPrinter,
  type Paper, type PaperFeed, type PaperPresetId, type PrintDocKind, type PrintProfile, type PrintSettingsV1, type PrinterDpi,
  type PrinterType, type QrSize, type TemplateId,
} from './printSettingsCore';

export * from './printSettingsCore';

type Tr = (ar: string) => string;

// ─── القراءة ───

let warnedInvalid = false;

/** القيمة الخام ⇒ إعدادات صالحة دائماً. لا يرمي ولا يعيد null */
export function normalizePrintSettings(raw: unknown): PrintSettingsV1 {
  if (raw === null || raw === undefined) return legacyPrintSettings();
  const r = checkPrintSettings(raw, false);
  if (r.ok) return r.value;
  // مرة في الجلسة — القراءة تتكرّر مع كل رسم
  if (!warnedInvalid) {
    warnedInvalid = true;
    console.warn('[print] إعدادات الطباعة غير صالحة أو أحدث من هذه النسخة — يعمل الجهاز بالسلوك الافتراضي', r.issues.slice(0, 3));
  }
  return legacyPrintSettings();
}

/**
 * القراءة في شاشة المستند (M2): الإعدادات ومعها «هل خصّصتها الشركة؟». غير المخصّصة (null أو عطب ⇒ الافتراضي) تعمل
 * كاليوم حرفياً: لا يُقرأ اختيار الجهاز ولا يظهر سطر «تغيير» — فجهازٌ اختار قالباً أيام إعدادٍ مخصّص ثم أعادته الشركة
 * للافتراضي لا يبقى على قالبٍ غير زرّ اليوم. وكائنٌ يساوي الافتراضي حرفياً (isLegacyPrintSettings) غير مخصّصٍ كذلك —
 * شبكة أمانٍ لـ«استعادة الافتراضي» إن وصلت كائناً لا null.
 */
export function readPrintSettings(raw: unknown): { settings: PrintSettingsV1; customized: boolean } {
  if (raw === null || raw === undefined) return { settings: legacyPrintSettings(), customized: false };
  const r = checkPrintSettings(raw, false);
  return r.ok ? { settings: r.value, customized: !isLegacyPrintSettings(r.value) } : { settings: normalizePrintSettings(raw), customized: false };
}

/** نوع المستند في التوجيه: الفاتورة (ومعها المرتجع والإشعارات وسند التسليم) والسند والكشف، وكل ما عداها «مستندات المخزون» */
export function printKindOf(docKind: string): PrintDocKind {
  return docKind === 'invoice' ? 'invoice' : docKind === 'receipt' ? 'receipt' : docKind === 'statement' ? 'statement' : 'notices';
}

/** القوالب التي يختار الجهاز بينها لنوع مستند — ما يصلح للنوع (لا رول لكشف الحساب ومستندات المخزون) */
export function deviceProfilesFor(s: PrintSettingsV1, kind: PrintDocKind): PrintProfile[] {
  return s.profiles.filter((p) => routingAllowsPrinter(kind, p.printer));
}

/** ردّ GET /company/print-settings — data خام تُطبَّع؛ stored = محفوظ صالح؛ hasCompany = صفّ الإعدادات موجود (الحفظ ممكن) */
export interface PrintSettingsResponse { success?: boolean; data?: unknown; stored?: boolean; hasCompany?: boolean }

export const isLegacyProfileId = (id: string): boolean => id === LEGACY_THERMAL_ID || id === LEGACY_PAGE_ID;

/** معرّفا قالب الجهاز — بعلامة @ خارج PROFILE_ID_RE: لا يلتبسان بقالبٍ للشركة، ولا يُحفظان في الخادم ولا في اختيار byKind */
export const DEVICE_ROLL_IDS = Object.freeze({ 58: '@device-58', 80: '@device-80' } as const);
export const isDeviceRollId = (id: string): boolean => id === DEVICE_ROLL_IDS[58] || id === DEVICE_ROLL_IDS[80];

/**
 * قالب البلوتوث المباشر على الجهاز (طلب المالك ٣١ أكتوبر ٢٠٢٦: «خيار البلوتوث للمندوب دائماً، بلا إعدادات طباعة»). الشريط
 * الكلاسيكي لا يُرسل بالبلوتوث (مجمَّدٌ على نظام الطباعة) — فجهازٌ يوجّهه قالب شركته إليه، أو شركته بلا إعدادات، ثم يختار
 * «بلوتوث مباشر» يطبع «الشريط المختصر» بعرض رولِه (58 أو 80 مم من اختياره) وخيارات الحرارية الافتراضية.
 */
export function deviceRollProfile(rollMm: 58 | 80 = 58): PrintProfile {
  return {
    ...legacyThermalProfile(),
    id: DEVICE_ROLL_IDS[rollMm],
    name: rollMm === 80 ? 'حرارية 80 مم' : LEGACY_NAMES.thermal,
    template: 'roll_compact',
    paper: presetPaper(rollMm === 80 ? 'roll80' : 'roll58') as Paper,
  };
}

/** اختيار الجهاز (localStorage، M2): قالبٌ لكل نوع مستند، وطريقة الاتصال وتلميح المنفذ — و«رابط بطيء» (M3: مهلة بين الدفعات) */
export interface DevicePrintChoice {
  byKind?: Partial<Record<PrintDocKind, string>>;
  transport?: 'bt-serial' | 'system';
  portHint?: { name?: string };
  slow?: boolean;
  /** عرض رول الجهاز للبلوتوث المباشر حين قالب الشركة كلاسيكيّ أو لا إعدادات لها (deviceRollProfile) — الغياب 58 */
  rollMm?: 58 | 80;
  /**
   * طريقة قالب الجهاز وحده (الغياب = نظام الطباعة) — مستقلةٌ عن transport قوالب الشركة: جهازٌ يطبع فاتورته بالبلوتوث على نقطية
   * وسنده الكلاسيكي بنظام الطباعة لا يُحوَّل سنده إلى البلوتوث، وشركةٌ أعادت إعداداتها للافتراضي لا يرث مندوبها بلوتوث قالبٍ زال
   */
  rollVia?: 'bt-serial';
}

/**
 * قالب الطباعة المباشرة لنوع مستند على هذا الجهاز — null = لا زرّ طباعة مباشرة (PDF يبقى).
 * توجيه الشركة null يبقى null (لا يفتح الجهاز طباعةً أغلقتها الشركة)؛ واختيار الجهاز يُحترم إن سمحت الشركة وبقي القالب
 * موجوداً ويصلح للنوع (لا رول لكشف الحساب) — وإلا فاختيار الشركة. النوعان مختلفان مقبولان: شاحنة MIP480 بجانب رول 80.
 */
export function profileFor(s: PrintSettingsV1, kind: PrintDocKind, device?: DevicePrintChoice | null): PrintProfile | null {
  const companyId = s.routing[kind];
  if (companyId === null) return null;
  const byId = (id: string): PrintProfile | null => s.profiles.find((p) => p.id === id) ?? null;
  const chosen = s.repMayChoose ? device?.byKind?.[kind] : undefined;
  if (typeof chosen === 'string') {
    const p = byId(chosen);
    if (p && routingAllowsPrinter(kind, p.printer)) return p;
  }
  return byId(companyId);
}

/** قالب «مشاركة/حفظ PDF» — موجود دائماً في إعداد صالح */
export function pdfProfileOf(s: PrintSettingsV1): PrintProfile {
  return s.profiles.find((p) => p.id === s.pdfProfileId) ?? (legacyPrintSettings().profiles[1]);
}

// ─── الهندسة ───

export const CSS_PX_PER_INCH = 96;
/** هامش جانبي للطابعة العادية (الحزمة في منتصف الصفحة) — يطبّقه القالب بحشوته الداخلية (40 بكسل ≈ 10.6 مم، rep/printPage.ts) */
export const PAGE_SIDE_MARGIN_MM = 10;

export const mmToDots = (mm: number, dpi: PrinterDpi): number => Math.round(mm * dotsPerMm(dpi));
export const inchesToDots = (inches: number, dpi: PrinterDpi): number => Math.round(inches * dpi);

export interface PrintGeometry {
  printer: PrinterType;
  feed: PaperFeed;
  paperWidthMm: number;
  paperLengthMm: number | null;
  dpi: PrinterDpi | null;
  printableDots: number | null;
  printableWidthMm: number;
  /** عرض التخطيط بمقاسه الفعلي: النقاط ÷ الدقة × 96 بكسل CSS (MIP480: 1440 ⇒ 768، رول 80: 576 ⇒ ≈272) */
  cssWidthPx: number;
  /** بداية الحزمة المطبوعة من حافة الورق اليسرى: في المنتصف ثم الإزاحة */
  bandLeftMm: number;
  offsetXmm: number;
  marginTopMm: number;
  marginBottomMm: number;
  /** طول المتن المطبوع لكل صفحة — null للرول */
  usableLengthMm: number | null;
  /** صفوف النقاط لكل صفحة (تقسيم الورق المقطع والمتصل) — null للرول وللعادية */
  rowsPerPage: number | null;
}

export function geometry(p: PrintProfile): PrintGeometry {
  const a = p.paper;
  const raster = p.printer !== 'page' && a.dpi !== null && a.printableDots !== null;
  const printableWidthMm = raster ? (a.printableDots as number) / dotsPerMm(a.dpi as PrinterDpi) : Math.max(0, a.widthMm - 2 * PAGE_SIDE_MARGIN_MM);
  const cssWidthPx = raster ? ((a.printableDots as number) / (a.dpi as number)) * CSS_PX_PER_INCH : (printableWidthMm / 25.4) * CSS_PX_PER_INCH;
  const usableLengthMm = a.lengthMm === null ? null : Math.max(0, a.lengthMm - a.marginTopMm - a.marginBottomMm);
  return {
    printer: p.printer,
    feed: a.feed,
    paperWidthMm: a.widthMm,
    paperLengthMm: a.lengthMm,
    dpi: raster ? a.dpi : null,
    printableDots: raster ? a.printableDots : null,
    printableWidthMm,
    cssWidthPx,
    bandLeftMm: (a.widthMm - printableWidthMm) / 2 + a.offsetXmm,
    offsetXmm: a.offsetXmm,
    marginTopMm: a.marginTopMm,
    marginBottomMm: a.marginBottomMm,
    usableLengthMm,
    rowsPerPage: raster && usableLengthMm !== null ? Math.floor(usableLengthMm * dotsPerMm(a.dpi as PrinterDpi) + 1e-9) : null,
  };
}

/**
 * نقل عرض الطباعة لدقة أخرى بالمم نفسه (576 على 203 ⇒ 848 على 300) — للحرارية لأقرب مضاعف 8، وبلا تجاوز عرض الورق ولا
 * سطر الطباعة النقطية 1440 (maxPrintableDots)
 */
export function rescaleDots(dots: number, from: PrinterDpi, to: PrinterDpi, printer: PrinterType, widthMm: number): number {
  let d = Math.round((dots / dotsPerMm(from)) * dotsPerMm(to));
  if (printer === 'thermal') d = Math.round(d / 8) * 8;
  return Math.min(d, maxPrintableDots(printer, widthMm, to));
}

// ─── رمز QR (التصميم §3.4) — يُحسب ولا تصغّره الشركة ───

/**
 * قالب الصفحة (A4 اليوم، والـPDF، والطابعة العادية): 794 بكسل عرضاً (A4 بـ96 بكسل/بوصة) يُكبَّر أو يُصغَّر بعرض الورق، ورمزه
 * المختوم صورةٌ 176 بكسل بهامش خليةٍ على كل جانب (QrImage في RepDocuments.tsx). فالرمز الفعليّ يتبع عرض الورق: A4 ⇒ ~46.6 مم،
 * وA5 (أضيق ما يُقبل، PRINT_LIMITS.pageMinWidthMm) ⇒ ~32.8 مم. والمعاينة ترسمه بهذا المقاس لا بمقاس A4 الثابت.
 */
export const PAGE_TEMPLATE_WIDTH_PX = 794;
export const PAGE_STAMPED_QR_PX = 176;

/** مقاس صورة الرمز المختوم بالمم على ورقٍ عادي بهذا العرض (مع هامشها) */
export const pageQrImageMm = (paperWidthMm: number): number => (PAGE_STAMPED_QR_PX / PAGE_TEMPLATE_WIDTH_PX) * paperWidthMm;
/** خلية الرمز المختوم بالمم على ورقٍ عادي بهذا العرض — الصورة 176 بكسل تحمل الخلايا وهامش خليةٍ على كل جانب */
export const pageQrModuleMm = (paperWidthMm: number, cells: number): number => pageQrImageMm(paperWidthMm) / (cells + 2);

/** نقاط لكل خلية: الحد الأدنى / التلقائي / الكبير لكل دقة. الحد الأدنى لا ينزل أبداً (حارس) */
export const QR_DOTS_PER_CELL: Readonly<Record<PrinterDpi, { readonly min: number; readonly auto: number; readonly large: number }>> = Object.freeze({
  203: Object.freeze({ min: 3, auto: 4, large: 5 }), // 0.375 / 0.5 / 0.625 مم
  300: Object.freeze({ min: 5, auto: 6, large: 7 }), // 0.42 / 0.51 / 0.59 مم
  180: Object.freeze({ min: 4, auto: 5, large: 6 }), // 0.56 / 0.71 / 0.85 مم
});

/** خلايا رمز QR لنسخته: 17 + 4×النسخة */
export const qrCellsForVersion = (version: number): number => 17 + 4 * version;
/** الرمز المختوم في المرحلة الثانية (~700 محرف، تصحيح L): النسخة 18 غالباً (89 خلية) وحتى 19 (93) */
export const STAMPED_QR_CELLS = Object.freeze({ typical: qrCellsForVersion(18), max: qrCellsForVersion(19) });

export function qrDotsPerCell(dpi: PrinterDpi, size: QrSize | 'min'): number {
  return QR_DOTS_PER_CELL[dpi][size];
}

/** الاتساع: (الخلايا + 4) × النقاط ≤ عرض الحزمة — خليتان صامتتان على الأقل داخل الحزمة، وهامش الورق خارجها */
export function qrFits(cells: number, dotsPerCell: number, printableDots: number): boolean {
  return (cells + 4) * dotsPerCell <= printableDots;
}

export interface QrPlan {
  fits: boolean;
  dotsPerCell: number;
  /** صغُر عن اختيار الشركة (تلقائي/كبير) ليتسع — ولا ينزل عن الحد الأدنى */
  reduced: boolean;
  sizeMm: number;
  /** الخلايا الصامتة على كل جانب داخل الحزمة */
  quietCells: number;
}

/** مقاس الرمز على هذا القالب لعدد خلايا معلوم — null للعادية (مقاسات A4 اليوم كما هي) */
export function qrPlan(p: PrintProfile, cells: number): QrPlan | null {
  const { dpi, printableDots: dots } = p.paper;
  if (p.printer === 'page' || dpi === null || dots === null) return null;
  const t = QR_DOTS_PER_CELL[dpi];
  const want = qrDotsPerCell(dpi, p.options.qrSize);
  const plan = (d: number, fits: boolean): QrPlan => ({ fits, dotsPerCell: d, reduced: d < want, sizeMm: (cells * d) / dotsPerMm(dpi), quietCells: (dots / d - cells) / 2 });
  for (let d = want; d >= t.min; d--) if (qrFits(cells, d, dots)) return plan(d, true);
  return plan(t.min, false);
}

// ─── التنبيهات (لا تمنع الحفظ) ───

export const PRINT_WARNINGS = Object.freeze({
  qrNoFit: 'عرض الورق لا يتسع لرمز الفاتورة المعتمد — اختر قالبا أعرض',
  phase2Narrow: 'رمز الفاتورة المعتمد في المرحلة الثانية يحتاج عرض طباعة 48 مم على الأقل (384 نقطة)',
  roll85: 'عرض 85 مم ليس رولا قياسيا — ابدأ بعرض طباعة 72 مم ثم زده بعد المعايرة',
  wide241: 'تأكد أن طابعتك تقبل ورقا متصلا بعرض 241 مم',
  impactCopies: 'الورق الكربوني يعطي نسخه في مرور واحد — اجعل النسخ أكثر من واحدة للورق ذي الطبقة الواحدة فقط',
});
export const PRINT_NOTES = Object.freeze({
  impactTopPly: 'الطبقة العليا وحدها يقرأ الماسح رمزها — النسخ الكربونية لا تمسح',
  directChrome: 'الطباعة المباشرة بالبلوتوث تتطلب Chrome 138 أو أحدث وإقران الطابعة أولا — وإلا فنظام الطباعة في الجهاز أو ملف PDF',
  impactDesktop: 'على الكمبيوتر تطبع النقطية عبر تعريف Windows الخاص بها',
  staleness: 'تصل التغييرات إلى أجهزة المناديب عند تحديث بيانات الشركة خلال دقائق وهم متصلون',
});

export function profileWarnings(p: PrintProfile, ctx: { phase2: boolean }): { warnings: string[]; notes: string[] } {
  const warnings: string[] = [];
  const notes: string[] = [];
  if (p.printer !== 'page' && p.paper.printableDots !== null) {
    const plan = qrPlan(p, STAMPED_QR_CELLS.max);
    // نزول الرمز للحد الأدنى ليتسع ليس تنبيهاً (58 مم برمز مختوم كبير = الوضع القائم) — التنبيه حين لا يتسع أصلاً (§3.4)
    if (plan && !plan.fits) warnings.push(PRINT_WARNINGS.qrNoFit);
    if (ctx.phase2 && p.paper.printableDots < 384) warnings.push(PRINT_WARNINGS.phase2Narrow);
    if (p.paper.preset === 'roll85') warnings.push(PRINT_WARNINGS.roll85);
    notes.push(PRINT_NOTES.directChrome);
  }
  if (p.printer === 'impact') {
    if (p.paper.widthMm >= 241) warnings.push(PRINT_WARNINGS.wide241);
    if (p.options.copies > 1) warnings.push(PRINT_WARNINGS.impactCopies);
    notes.push(PRINT_NOTES.impactTopPly, PRINT_NOTES.impactDesktop);
  }
  return { warnings, notes };
}

// ─── التسميات (عربية؛ مترجمة في القاموس — حارس في الاختبار) ───

export const PRINTER_LABELS: Readonly<Record<PrinterType, string>> = Object.freeze({
  thermal: 'حرارية (رول)',
  impact: 'نقطية (مثل Tally Dascom MIP480)',
  page: 'عادية / PDF',
});
export const PRINTER_HINTS: Readonly<Record<PrinterType, string>> = Object.freeze({
  thermal: 'طابعات البلوتوث 58 و80 و85 مم وA4 والأجهزة المحمولة بطابعة مدمجة',
  impact: 'طابعة إبرية بورق A4 مقطع أو متصل ونسخ كربونية',
  page: 'ليزر أو حبر أو ملف PDF بمقاس A4 أو A5 أو Letter',
});
export const TEMPLATE_LABELS: Readonly<Record<TemplateId, string>> = Object.freeze({
  roll_classic: 'الشريط الكلاسيكي 58 مم',
  roll_compact: 'شريط مختصر',
  roll_detailed: 'شريط مفصل بجدول',
  impact_plain: 'نقطي واضح',
  impact_preprinted: 'على نموذج مطبوع مسبقا',
  page_branded: 'بهوية الشركة',
  page_plain: 'بسيط موفر للحبر',
});
export const TEMPLATE_HINTS: Readonly<Record<TemplateId, string>> = Object.freeze({
  roll_classic: 'شريط اليوم كما هو بلا تغيير',
  roll_compact: 'كل بند في سطرين بأي عرض مع شعار وتذييل اختياريين',
  roll_detailed: 'جدول كمية وسعر وإجمالي مع ملخص الضريبة — من 72 مم',
  impact_plain: 'بلا تظليل بخطوط سوداء وخط عريض ورمز QR أكبر',
  impact_preprinted: 'بلا شعار ولا زخرفة مع إزاحة علوية — اسم البائع ورقمه الضريبي وعنوان المستند تطبع دائما',
  page_branded: 'ترويسة الشركة ولونها كملف PDF اليوم',
  page_plain: 'أبيض وأسود بلا تعبئة لونية',
});
export const PRESET_LABELS: Readonly<Record<PaperPresetId, string>> = Object.freeze({
  roll58: 'رول 58 مم',
  roll80: 'رول 80 مم',
  roll82: 'رول 82.5 مم',
  roll85: 'رول 85 مم',
  roll112: 'رول 112 مم',
  roll_a4: 'A4 حراري',
  cut_a4: 'A4 ورق مقطع',
  ff_a4: 'A4 ورق متصل',
  ff_95x11: 'متصل 9.5 × 11 بوصة',
  ff_95x12: 'متصل 9.5 × 12 بوصة',
  ff_85x11: 'متصل 8.5 × 11 بوصة',
  ff_95x55: 'متصل نصف صفحة 9.5 × 5.5 بوصة',
  a4: 'A4',
  a5: 'A5',
  letter: 'Letter',
  custom: 'مقاس مخصص',
});
export const PRINTER_SHORT: Readonly<Record<PrinterType, string>> = Object.freeze({ thermal: 'حرارية', impact: 'نقطية', page: 'عادية' });
export const FEED_LABELS: Readonly<Record<PaperFeed, string>> = Object.freeze({ roll: 'رول', sheet: 'ورق مقطع', continuous: 'ورق متصل' });
/** invoice يشمل المرتجع والإشعارات وسند التسليم — كلها مستند فاتورة في الطباعة */
export const DOC_KIND_LABELS: Readonly<Record<PrintDocKind, string>> = Object.freeze({
  invoice: 'الفواتير والمرتجعات والإشعارات',
  receipt: 'سندات القبض',
  statement: 'كشوف الحساب',
  notices: 'مستندات المخزون والتسويات',
});
/** وسم الاستعمال في قائمة القوالب */
export const DOC_KIND_SHORT: Readonly<Record<PrintDocKind | 'pdf', string>> = Object.freeze({
  invoice: 'الفواتير', receipt: 'السندات', statement: 'كشوف الحساب', notices: 'المخزون', pdf: 'PDF',
});
/** علامة كل نسخة اختبار أو معاينة (التصميم §4.14) — لا رمز ضريبي حقيقي يُطبع من الإعدادات */
export const PRINT_SAMPLE_WATERMARK = 'نموذج اختبار — ليس مستندا ضريبيا';
export const COMPANY_SETTINGS_MISSING_MSG = 'احفظ بيانات الشركة أولا';

/** اسم القالب للعرض: الافتراضيان منّا فيُترجمان، وما كتبته الشركة كما هو */
export const profileDisplayName = (p: PrintProfile, tr: Tr): string => (isLegacyProfileId(p.id) || isDeviceRollId(p.id) ? tr(p.name) : p.name);

/** عرض الطباعة بالمم لعرضه (عُشر مم) — null للعادية */
export function printableMm(p: PrintProfile): number | null {
  const { dpi, printableDots } = p.paper;
  return p.printer === 'page' || dpi === null || printableDots === null ? null : Math.round((printableDots / dotsPerMm(dpi)) * 10) / 10;
}

// ─── محرّر القوالب ───

export const DEFAULT_PRESET: Readonly<Record<PrinterType, Exclude<PaperPresetId, 'custom'>>> = Object.freeze({ thermal: 'roll80', impact: 'ff_a4', page: 'a4' });
export const DEFAULT_TEMPLATE: Readonly<Record<PrinterType, TemplateId>> = Object.freeze({ thermal: 'roll_compact', impact: 'impact_plain', page: 'page_branded' });

export function uniqueProfileId(printer: PrinterType, existing: readonly PrintProfile[]): string {
  const ids = new Set(existing.map((p) => p.id));
  for (let n = 1; ; n++) if (!ids.has(`${printer}-${n}`)) return `${printer}-${n}`;
}

/** اسم لا يتكرّر (بلا فرق حالة الأحرف) وبحدّ 40 — «اسم 2» ثم «اسم 3» */
export function uniqueProfileName(base: string, existing: readonly PrintProfile[], skipId?: string): string {
  const taken = new Set(existing.filter((p) => p.id !== skipId).map((p) => p.name.trim().toLowerCase()));
  const clip = (s: string, n: number) => Array.from(s).slice(0, n).join('').trim();
  const root = clip(base.replace(/\s+/g, ' ').trim(), 40) || '—';
  if (!taken.has(root.toLowerCase())) return root;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = `${clip(root, 40 - suffix.length)}${suffix}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function newProfile(printer: PrinterType, name: string, existing: readonly PrintProfile[]): PrintProfile {
  return {
    id: uniqueProfileId(printer, existing),
    name: uniqueProfileName(name, existing),
    printer,
    template: DEFAULT_TEMPLATE[printer],
    paper: presetPaper(DEFAULT_PRESET[printer]) as Paper,
    options: defaultPrintOptions(printer),
  };
}

/** تغيير نوع الطابعة: تصميمها وورقها وتفاصيلها الافتراضية — ويبقى نصّ التذييل */
export function withPrinter(p: PrintProfile, printer: PrinterType): PrintProfile {
  if (p.printer === printer) return p;
  return { ...p, printer, template: DEFAULT_TEMPLATE[printer], paper: presetPaper(DEFAULT_PRESET[printer]) as Paper, options: { ...defaultPrintOptions(printer), footerText: p.options.footerText } };
}

/** مقاس جاهز: ورقه كاملاً — و«مخصص» يُبقي القيم الحالية بلا اسم مقاس */
export function withPreset(p: PrintProfile, preset: PaperPresetId): PrintProfile {
  const paper = preset === 'custom' ? { ...p.paper, preset } : presetPaper(preset);
  return paper ? { ...p, paper } : p;
}

/** تعديل حقل ورق: العرض والطول يُخرجانه من المقاس الجاهز (يصير مخصصاً)، وغيرهما معايرةٌ تُبقي اسمه */
export function withPaper(p: PrintProfile, patch: Partial<Paper>): PrintProfile {
  const paper: Paper = { ...p.paper, ...patch };
  if (('widthMm' in patch && patch.widthMm !== p.paper.widthMm) || ('lengthMm' in patch && patch.lengthMm !== p.paper.lengthMm)) paper.preset = 'custom';
  if (paper.feed === 'roll') paper.lengthMm = null;
  else if (paper.lengthMm === null) paper.lengthMm = 297;
  return { ...p, paper };
}

/** تغيير الدقة بالعرض المطبوع نفسه بالمم */
export function withDpi(p: PrintProfile, dpi: PrinterDpi): PrintProfile {
  const { dpi: from, printableDots } = p.paper;
  if (from === null || printableDots === null || from === dpi) return { ...p, paper: { ...p.paper, dpi } };
  return { ...p, paper: { ...p.paper, dpi, printableDots: rescaleDots(printableDots, from, dpi, p.printer, p.paper.widthMm) } };
}

/** نسخ قالب — الكلاسيكي محجوز للافتراضي فنسخته «شريط مختصر» بالمقاس نفسه */
export function duplicateProfile(p: PrintProfile, name: string, existing: readonly PrintProfile[]): PrintProfile {
  const copy: PrintProfile = JSON.parse(JSON.stringify(p)) as PrintProfile;
  copy.id = uniqueProfileId(p.printer, existing);
  copy.name = uniqueProfileName(name, existing);
  if (copy.template === 'roll_classic') copy.template = 'roll_compact';
  return copy;
}

/** أين يُستعمل القالب: أنواع المستندات و«pdf» */
export function profileUsage(s: PrintSettingsV1, id: string): Array<PrintDocKind | 'pdf'> {
  const out: Array<PrintDocKind | 'pdf'> = DOC_KINDS.filter((k) => s.routing[k] === id);
  if (s.pdfProfileId === id) out.push('pdf');
  return out;
}

/** إضافة قالب (index null) أو استبداله */
export function withProfile(s: PrintSettingsV1, profile: PrintProfile, index: number | null): PrintSettingsV1 {
  const profiles = index === null ? [...s.profiles, profile] : s.profiles.map((p, i) => (i === index ? profile : p));
  return { ...s, profiles };
}

/** حذف قالب — null إن كان مستعملاً في التوجيه أو الـPDF (يُغيَّر التوجيه أولاً) أو كان الأخير */
export function withoutProfile(s: PrintSettingsV1, id: string): PrintSettingsV1 | null {
  if (profileUsage(s, id).length > 0 || s.profiles.length <= 1) return null;
  return { ...s, profiles: s.profiles.filter((p) => p.id !== id) };
}

/** التصاميم التي تُختار لنوع الطابعة (الكلاسيكي لا يُختار) */
export const templatesFor = (printer: PrinterType): readonly TemplateId[] => TEMPLATES_BY_PRINTER[printer];

/** رسالة رفض الحفظ (عربية تُترجم): بلا صفّ إعدادات، أو قاعدة من النواة، وإلا الرسالة العامة */
export function printSaveErrorMessage(err: unknown): string {
  const r = (err as { response?: { data?: { code?: string; message?: string } } } | null)?.response;
  if (r?.data?.code === 'COMPANY_SETTINGS_MISSING') return COMPANY_SETTINGS_MISSING_MSG;
  if (r?.data?.code === 'PRINT_SETTINGS_TOO_LARGE') return PRINT_ISSUES.tooLarge;
  const m = r?.data?.message;
  if (typeof m === 'string' && (Object.values(PRINT_ISSUES) as string[]).includes(m)) return m;
  return 'حدث خطأ في الحفظ';
}
