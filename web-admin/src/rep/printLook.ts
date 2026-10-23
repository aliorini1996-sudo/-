/**
 * مظهر الطباعة لقوالب الصفحة (A4/A5/Letter والنقطية) — «إعدادات الطباعة» M2، التصميم §1.5.
 *
 * القوالب السبعة في RepDocuments.tsx تبقى قالباً واحداً لكل مستند، ويقرأ كلٌّ منها هذا السياق (PrintLookContext):
 * · page_branded  — قالب اليوم بترويسة الشركة ولونها (الافتراضي: مطابقٌ لليوم حرفاً بحرف فلا يتغيّر شيء بلا إعدادات).
 * · page_plain    — القالب نفسه «أحادي اللون»: بلا تعبئة ولا رمادي، خطوطٌ سوداء — يوفّر الحبر.
 * · impact_plain  — أحادي اللون + ترويسة بسيطة إجبارية + خطّ عريض: الرمادي على الإبرية نمطُ نقاطٍ يُتلف الشريط ويضعف الكربون.
 * · impact_preprinted — كالسابق بلا شعار، وإزاحةٌ علوية من هامش القالب لنماذج NCR المطبوعة مسبقاً. **اسم البائع ورقمه الضريبي
 *   وعنوان المستند تبقى مطبوعة** (ZATCA) — لا خيار هنا يخفيها (§1.6).
 *
 * لماذا «أحادي اللون» قاعدةُ CSS محصورة بسمة الجذر لا تعديلٌ في كل سطر: القوالب أنماطها مضمّنة (inline) ومئات الألوان
 * فيها؛ وقاعدةٌ بـ!important تغلب النمط المضمّن، فيصير القالب كلّه أسود على أبيض بلا لمس أسطره المحروسة (عنوان الضريبة
 * والرمز والجداول). وhtml2canvas يقرأ النمط المحسوب فيلتقط الـPDF المظهرَ نفسه.
 */
import { createContext, useContext, type CSSProperties } from 'react';
import { STAMPED_QR_CELLS, qrPlan, type Paper, type PrintProfile } from '../lib/print/printSettings';

/** عرض قوالب الصفحة الطبيعيّ (PAGE في RepDocuments.tsx = عرض A4 بـ96 بكسل/بوصة) */
export const SHEET_WIDTH_PX = 794;

export interface PrintLook {
  /** بلا تعبئة ولا رمادي — أسود على أبيض */
  mono: boolean;
  /** ترويسة «بسيط» مهما اختارت الشركة (الإبرية) */
  minimalHeader: boolean;
  showLogo: boolean;
  /** العنوان والهاتف والبريد — الاسم والرقم الضريبي والسجل التجاري ليست خياراً */
  showContact: boolean;
  showRepName: boolean;
  showSignatures: boolean;
  showItemUnit: boolean;
  /** null = «شكرا لتعاملكم معنا» */
  footerText: string | null;
  boldBody: boolean;
  /** حشوة الورقة الداخلية (بكسل CSS) — الإبرية أضيق: حزمتها داخل الورق أصلاً */
  pagePadding: number;
  /** مقاس صفحة الـPDF (يُقرأ في elementToPdfBlob من data-pdf-format) */
  pdfFormat: string;
  /**
   * خانة رمز QR الأكبر (بكسل القالب) للنقطية — M3، التصميم §3.3 الخطوة 3: الرمز المختوم (~93 خلية) بنقاط خلية الإبرية
   * (5 تلقائياً على 180) ومنطقته الصامتة لا يتسع في صندوق اليوم (176 بكسل). فالخانة تكبر وتحمل القيمة (data-qr-value)
   * ليُرسم فيها الرمز بنقاط صحيحة في البلوتوث، وتكبر صورته فيها عبر تعريف Windows. null = صندوق اليوم كما هو.
   */
  qrSlotPx: number | null;
}

/** مظهر اليوم: كل قالب كما كان قبل «إعدادات الطباعة» — حارسٌ يثبت أنّ legacy-a4 يساويه */
export const DEFAULT_PRINT_LOOK: PrintLook = Object.freeze({
  mono: false,
  minimalHeader: false,
  showLogo: true,
  showContact: true,
  showRepName: true,
  showSignatures: true,
  showItemUnit: true,
  footerText: null,
  boldBody: false,
  pagePadding: 40,
  pdfFormat: 'a4',
  qrSlotPx: null,
});

/**
 * خانة الرمز للنقطية بكسل القالب: (خلايا الرمز المختوم الأقصى + 4 صامتة) × نقاط الخلية في qrPlan + نقطتا سماح، ثم إلى بكسل
 * القالب بنسبة عرضه إلى حزمة الإبرة (794 بكسل ⇒ 1440 نقطة). بلا دقة أو نقاط (لا يقع لنقطيةٍ صالحة) ⇒ null.
 */
export function impactQrSlotPx(p: PrintProfile): number | null {
  const dots = p.paper.printableDots;
  const plan = qrPlan(p, STAMPED_QR_CELLS.max);
  if (!plan || !dots) return null;
  const slotDots = (STAMPED_QR_CELLS.max + 4) * plan.dotsPerCell + 2;
  return Math.ceil((slotDots * SHEET_WIDTH_PX) / dots);
}

/** a4/a5/letter باسمها، وغيرها «العرض×الطول» بالمم (يحوّلها pdf.ts نقاطاً) */
export function pdfFormatOfPaper(paper: Paper): string {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.6;
  if (paper.lengthMm !== null) {
    if (near(paper.widthMm, 210) && near(paper.lengthMm, 297)) return 'a4';
    if (near(paper.widthMm, 148) && near(paper.lengthMm, 210)) return 'a5';
    if (near(paper.widthMm, 215.9) && near(paper.lengthMm, 279.4)) return 'letter';
    return `${paper.widthMm}x${paper.lengthMm}`;
  }
  return 'a4';
}

/** مظهر قالب صفحة أو نقطية — والحرارية ليست هنا (لها thermal.ts) فتعود بالافتراضي */
export function lookFor(p: PrintProfile): PrintLook {
  if (p.printer === 'thermal') return DEFAULT_PRINT_LOOK;
  const o = p.options;
  const impact = p.printer === 'impact';
  const preprinted = p.template === 'impact_preprinted';
  return {
    mono: p.template !== 'page_branded',
    minimalHeader: impact,
    showLogo: preprinted ? false : o.showLogo,
    showContact: o.showContact,
    showRepName: o.showRepName,
    showSignatures: o.showSignatures,
    showItemUnit: o.showItemUnit,
    footerText: o.footerText,
    boldBody: o.boldBody,
    pagePadding: impact ? 16 : 40,
    pdfFormat: pdfFormatOfPaper(p.paper),
    qrSlotPx: impact ? impactQrSlotPx(p) : null,
  };
}

/**
 * سمات خانة الرمز وأسلوبها (M3): القيمة كما وصلت من القرار أو من رمز المرحلة الأولى المحروس — يمرّرها القالب ولا تُبنى هنا.
 * المظهر بلا خانة (null) لا يضيف سمةً ولا أسلوباً: DOM اليوم كما هو.
 */
export function qrSlotStyle(look: PrintLook): CSSProperties {
  if (!look.qrSlotPx) return {};
  return {
    width: look.qrSlotPx, height: look.qrSlotPx, padding: 0, boxSizing: 'border-box',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}

export const PrintLookContext = createContext<PrintLook>(DEFAULT_PRINT_LOOK);
export const usePrintLook = (): PrintLook => useContext(PrintLookContext);

/**
 * أحادي اللون: كل لونٍ أسود وكل خلفيةٍ شفافة وكل حدٍّ أسود — بـ!important لأنها تغلب النمط المضمّن وحده.
 * إطار الرمز (صندوقٌ يحوي صورة QR) بلا حدّ: خطٌّ أسود قريبٌ من الرمز يأكل منطقته الصامتة. والصورة نفسها بلا مرشّح.
 */
export const PRINT_LOOK_CSS = [
  '[data-print-look~="mono"], [data-print-look~="mono"] * { color: #000 !important; background: transparent !important; border-color: #000 !important; box-shadow: none !important; }',
  '[data-print-look~="mono"] th { border-bottom: 1.5px solid #000 !important; }',
  '[data-print-look~="mono"] div:has(> img[alt="QR"]) { border-color: transparent !important; }',
  '[data-print-look~="mono"] img:not([alt="QR"]) { filter: grayscale(1) contrast(1.3); }',
  '[data-print-look~="bold"] { font-weight: 700; }',
  // خانة الرمز الأكبر (النقطية): الصورة تملؤها إلا منطقةً صامتة، بلا تنعيمٍ يطمس حدود الخلايا عبر تعريف Windows
  '[data-print-look] [data-qr-value] > img[alt="QR"] { width: 92% !important; height: 92% !important; image-rendering: pixelated; }',
].join('\n');

/** سمات جذر الورقة — المظهر الافتراضي لا يضيف سمةً واحدة (DOM اليوم كما هو) */
export function lookRootAttrs(look: PrintLook): { 'data-print-look'?: string; 'data-pdf-format'?: string } {
  const tokens = [look.mono ? 'mono' : '', look.boldBody ? 'bold' : ''].filter(Boolean).join(' ');
  return {
    ...(tokens ? { 'data-print-look': tokens } : {}),
    ...(look.pdfFormat !== 'a4' ? { 'data-pdf-format': look.pdfFormat } : {}),
  };
}

/** هل يحتاج الجذر أسلوب «أحادي اللون/عريض» المحصور؟ */
export const lookNeedsCss = (look: PrintLook): boolean => look.mono || look.boldBody;
