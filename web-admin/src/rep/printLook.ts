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
import { STAMPED_QR_CELLS, qrPlan, type Paper, type PrintForm, type PrintProfile } from '../lib/print/printSettings';
import { resolveLayout, type ResolvedLayout } from '../lib/print/layout';

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
  /**
   * «تخطيط المطبوعات» (options.layout): مكان الشعار وحجمه ولون التمييز وشكل الجدول وترتيب الأقسام والتصميم (الحالي أو «كلاسيكي
   * بإطارات — ثنائي اللغة»). **غيابه = ورقة اليوم حرفاً بحرف** — لا يُضاف المفتاح إلا لملفٍّ يحمل تخطيطاً (resolveLayout غير null)،
   * فيبقى DEFAULT_PRINT_LOOK ومظهر legacy-a4 متساويين.
   */
  layout?: ResolvedLayout;
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

/** بكسل CSS لكل مم (96 بكسل/بوصة) */
export const CSS_PX_PER_MM = 96 / 25.4;

/**
 * خانة رمز QR في «نموذج الشركة المطبوع مسبقاً» على النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦) = ضلع حقل الرمز min(w,h) ببكسل CSS بلا
 * تقريب — لا impactQrSlotPx (269 بكسل ≈ 71 مم): حقلٌ بضلع 55 مم كانت خانته تفيض عنه، فيمسح الرسم النقطيّ (drawQr) ما حوله من قيم،
 * وتكبر صورة الرمز عبر تعريف Windows (قاعدة 92٪ في PRINT_LOOK_CSS) فيقصّها الحقل. الخانة ركن الحقل الأعلى (flex-start) فيُرسم
 * الرمز داخله تماماً: 55 مم ≈ 389.8 نقطة ≥ (93 + 4) × 4. وعبر تعريف Windows لا تُصغّر قاعدة الـ92٪ صورته (0.92 × 55 تنزل بالخلية عن
 * 4 نقاط): قاعدةٌ أخصّ في qrCss (rep/printPreprinted.tsx) تجعلها بضلع الحقل كاملاً. null بلا حقل رمز.
 */
export function formQrSlotPx(form: Pick<PrintForm, 'fields'> | null | undefined): number | null {
  const f = form?.fields?.find((x) => x.id === 'qr');
  if (!f) return null;
  const side = Math.min(f.w, f.h);
  return Number.isFinite(side) && side > 0 ? side * CSS_PX_PER_MM : null;
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
  const layout = resolveLayout(p);
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
    // نموذج الشركة على النقطية: الخانة بمقاس حقل الرمز (formQrSlotPx) — وغيره كما كان
    qrSlotPx: impact ? (layout?.design === 'preprinted' && layout.form ? formQrSlotPx(layout.form) : impactQrSlotPx(p)) : null,
    ...(layout ? { layout } : {}),
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
export function lookRootAttrs(look: PrintLook): { 'data-print-look'?: string; 'data-pdf-format'?: string; 'data-print-layout'?: string; 'data-print-canvas'?: string } {
  const tokens = [look.mono ? 'mono' : '', look.boldBody ? 'bold' : ''].filter(Boolean).join(' ');
  return {
    ...(tokens ? { 'data-print-look': tokens } : {}),
    ...(look.pdfFormat !== 'a4' ? { 'data-pdf-format': look.pdfFormat } : {}),
    // «تخطيط المطبوعات»: التصميم على الجذر (PDF والنقطية والطباعة تتعرّف منه على الورقة ذات الإطارات) — وبلا تخطيط لا سمة
    ...(look.layout ? { 'data-print-layout': look.layout.design } : {}),
    // «التحرير الحرّ»: ورقةٌ بلوحتَي رأسٍ/تذييلٍ حرّتين (canvas) — منها تعرف الطباعة والنقطية أنّ اللوحتين لا تُقطعان. بلا لوحات لا سمة
    ...(lookHasCanvas(look) ? { 'data-print-canvas': '1' } : {}),
  };
}

/** هل لهذا المظهر لوحاتٌ حرّة (page/impact بالتصميم القياسي)؟ — المحرّك لا يضع canvas في التخطيط المحلول إلا صالحاً */
export function lookHasCanvas(look: PrintLook): boolean {
  const l = look.layout;
  return !!l && l.printer !== 'thermal' && l.design === 'standard' && !!l.canvas
    && ((l.canvas.headerMm ?? 0) > 0 || (l.canvas.footerMm ?? 0) > 0);
}

// ─── «التحرير الحرّ»: حجم الشعار بلا object-fit (html2canvas 1.4.1 لا يعرفه فيمطّ الصورة) ───

/** أبعاد الصورة الطبيعية من رأس data URL (PNG/GIF/JPEG/WebP) — null لغيرها (SVG مثلاً) أو لعطب. نقيّة بلا DOM. */
export function imageNaturalSize(src: string | null | undefined): { w: number; h: number } | null {
  if (typeof src !== 'string') return null;
  if (src === lastSizeSrc) return lastSize;
  const out = sniffSize(src);
  lastSizeSrc = src;
  lastSize = out;
  return out;
}
let lastSizeSrc: string | null = null;
let lastSize: { w: number; h: number } | null = null;

const SNIFF_HEAD = /^data:image\/(png|gif|jpeg|jpg|webp);base64,/i;

function b64Bytes(b64: string, maxChars: number): Uint8Array | null {
  const part = b64.slice(0, maxChars - (maxChars % 4)).replace(/[^A-Za-z0-9+/]/g, '');
  const clean = part.slice(0, part.length - (part.length % 4));
  try {
    const bin = typeof atob === 'function' ? atob(clean) : '';
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

function sniffSize(src: string): { w: number; h: number } | null {
  const m = SNIFF_HEAD.exec(src);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const body = src.slice(m[0].length);
  const ok = (w: number, h: number) => (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null);
  if (kind === 'png') {
    const b = b64Bytes(body, 48);
    if (!b || b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
    return ok(((b[16] << 24) >>> 0) + (b[17] << 16) + (b[18] << 8) + b[19], ((b[20] << 24) >>> 0) + (b[21] << 16) + (b[22] << 8) + b[23]);
  }
  if (kind === 'gif') {
    const b = b64Bytes(body, 16);
    if (!b || b.length < 10 || b[0] !== 0x47) return null;
    return ok(b[6] | (b[7] << 8), b[8] | (b[9] << 8));
  }
  if (kind === 'webp') {
    const b = b64Bytes(body, 44);
    if (!b || b.length < 30 || b[8] !== 0x57) return null;
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === 'VP8 ') return ok((b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff);
    if (tag === 'VP8L') return ok(1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)));
    if (tag === 'VP8X') return ok(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    return null;
  }
  // JPEG: أول مقطع SOF (حتى 96 ك.ب من الرأس)، مع اتجاه EXIF (5–8 ⇒ تبديل العرض والارتفاع كما يعرضها المتصفح)
  const b = b64Bytes(body, 131072);
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let swap = false;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const mk = b[i + 1];
    if (mk === 0xff) { i++; continue; }
    if (mk === 0xd8 || (mk >= 0xd0 && mk <= 0xd7) || mk === 0x01) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    if (mk === 0xe1 && jpegExifSwaps(b, i + 4, len - 2)) swap = true;
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      const h = (b[i + 5] << 8) | b[i + 6];
      const w = (b[i + 7] << 8) | b[i + 8];
      return swap ? ok(h, w) : ok(w, h);
    }
    i += 2 + len;
  }
  return null;
}

/** اتجاه EXIF (الوسم 0x0112) بقيمة 5–8 = الصورة مدوّرة ربعاً فيعرضها المتصفح بأبعادٍ مبدّلة */
function jpegExifSwaps(b: Uint8Array, at: number, len: number): boolean {
  if (len < 14 || String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]) !== 'Exif') return false;
  const t = at + 6;
  const le = b[t] === 0x49;
  const u16 = (p: number) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
  const u32 = (p: number) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 16777216 : ((b[p] << 16) | (b[p + 1] << 8) | b[p + 2]) * 256 + b[p + 3]);
  const ifd = t + u32(t + 4);
  if (ifd + 2 > at + len || ifd + 2 > b.length) return false;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 10 > b.length) return false;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 5 && v <= 8; }
  }
  return false;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * أسلوب صورة الشعار داخل صندوقٍ أقصى W×H (بكسل القالب) محافظاً على نسبتها: أبعادٌ صريحة محسوبة من رأس الصورة (تكبيراً
 * وتصغيراً — يلتقطها html2canvas كما يعرضها المتصفح)، وإن تعذّرت القراءة (SVG) فـmax-width/max-height مع auto. لا object-fit أبداً.
 */
export function logoImgStyle(src: string | null | undefined, maxW: number, maxH: number): CSSProperties {
  const W = Number.isFinite(maxW) && maxW > 0 ? maxW : 1;
  const H = Number.isFinite(maxH) && maxH > 0 ? maxH : 1;
  const n = imageNaturalSize(src);
  if (n) {
    const s = Math.min(W / n.w, H / n.h);
    return { display: 'block', width: Math.max(1, r2(n.w * s)), height: Math.max(1, r2(n.h * s)) };
  }
  return { display: 'block', maxWidth: r2(W), maxHeight: r2(H), width: 'auto', height: 'auto' };
}

/** هل يحتاج الجذر أسلوب «أحادي اللون/عريض» المحصور؟ */
export const lookNeedsCss = (look: PrintLook): boolean => look.mono || look.boldBody;
