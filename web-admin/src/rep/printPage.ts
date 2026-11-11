/**
 * طباعة الصفحة والنقطية عبر نظام الطباعة (المسار A في التصميم §3.2) — «إعدادات الطباعة» M2.
 *
 * الزرّ «طباعة — {القالب}» لقالبٍ عاديّ أو نقطيّ يستنسخ القالب نفسه المرسوم خارج الشاشة (عقدة React بمظهر PrintLook) في
 * إطارٍ مخفيّ بقاعدة `@page { size: A4|A5|letter|<W>mm <L>mm }` ثم print(). النصّ يبقى متّجهاً: حادٌّ على الليزر، وسريعٌ عبر
 * تعريف Windows لطابعة MIP480 على الكمبيوتر. (على الجوال لا خدمة طباعة تعرف ESC/P بالبلوتوث — الطباعة المباشرة M3.)
 *
 * والقالب يُخطَّط بعرضه الطبيعيّ (794 بكسل = عرض A4) ثم يُكبَّر أو يُصغَّر بـzoom إلى عرض الورق (العادية) أو عرض حزمة
 * الإبرة (النقطية: 1440 نقطة ÷ 180 = 8.0 بوصة = 768 بكسل) — zoom لا transform: الأوّل يعيد التخطيط فتنكسر الصفحات صحيحة.
 * والنسخ (§3.6) تُكرَّر في الوثيقة نفسها بفاصل صفحة وسطر «الأصل/نسخة» تحت الترويسة؛ عدّاد نسخ نافذة الطباعة يكرّر الوسم نفسه.
 */
import { geometry, type Paper, type PrintProfile } from '../lib/print/printSettings';
import { SHEET_WIDTH_PX } from './printLook';
import { iosSystemPrint, iosSystemPrintAvailable } from '../lib/print/transport/iosBridge';

/** عرض القالب الطبيعيّ (PAGE في RepDocuments.tsx) */
export const TEMPLATE_WIDTH_PX = SHEET_WIDTH_PX;
const PX_PER_MM = 96 / 25.4;

export interface PagePrintGeom {
  /** قيمة size في @page */
  size: string;
  /** عرض المحتوى المطبوع (مم) وبدايته من الحافة اليسرى */
  widthMm: number;
  leftMm: number;
  marginTopMm: number;
  marginBottomMm: number;
  /** نسبة القالب إلى عرض المحتوى */
  zoom: number;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** الكلمات المعروفة لمقاساتها (يطابقها التعريف بلا مقاسٍ مخصّص) — وغيرها بالمم */
export function pageSizeOf(paper: Paper): string {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.6;
  const L = paper.lengthMm ?? 297;
  if (near(paper.widthMm, 210) && near(L, 297)) return 'A4';
  if (near(paper.widthMm, 148) && near(L, 210)) return 'A5';
  if (near(paper.widthMm, 215.9) && near(L, 279.4)) return 'letter';
  return `${r1(paper.widthMm)}mm ${r1(L)}mm`;
}

export function pagePrintGeom(p: PrintProfile): PagePrintGeom {
  const g = geometry(p);
  const zoomTo = (px: number) => {
    const z = px / TEMPLATE_WIDTH_PX;
    return Math.abs(z - 1) < 0.005 ? 1 : Math.round(z * 10000) / 10000;
  };
  if (p.printer === 'impact') {
    // الحزمة في منتصف الورق ثم إزاحة المعايرة — ولا تخرج عنه
    const room = Math.max(0, g.paperWidthMm - g.printableWidthMm);
    return {
      size: pageSizeOf(p.paper),
      widthMm: r1(g.printableWidthMm),
      leftMm: r1(Math.min(room, Math.max(0, g.bandLeftMm))),
      marginTopMm: g.marginTopMm,
      marginBottomMm: g.marginBottomMm,
      zoom: zoomTo(g.cssWidthPx),
    };
  }
  // العادية: القالب بعرض الورق وحشوته الداخلية (40 بكسل ≈ 10.6 مم) هامشه الجانبيّ — كملف الـPDF اليوم
  return {
    size: pageSizeOf(p.paper),
    widthMm: r1(g.paperWidthMm),
    leftMm: 0,
    marginTopMm: g.marginTopMm,
    marginBottomMm: g.marginBottomMm,
    zoom: zoomTo(g.paperWidthMm * PX_PER_MM),
  };
}

/**
 * ارتفاع ورقة القالب ثنائي اللغة (بكسل القالب) ليملأ صفحةً واحدة بلا فيضٍ إلى ثانية — «تخطيط المطبوعات» (pl_spec v2 B1).
 * الورقة مرنة بحدٍّ أدنى 1123 بكسل (A4 بعرض 794) فيستقرّ التذييل أسفلها؛ لكن هوامش @page أعلى وأسفل، وعرض حزمة النقطية (1440
 * نقطة = 768 بكسل لا 794) تجعل صفحة الطباعة الفعلية أقصر بالبكسل — فيفيض الحدّ الأدنى ذاته صفحةً بيضاء بشريط. هنا طول الصفحة
 * المتاح (الطول − الهامشين) بمقياس القالب بعد zoom، ناقص بكسلين احتياطاً للتقريب. ورقٌ متصل بلا طول ⇒ null (الحدّ كما هو).
 */
export function gridSheetHeightPx(p: PrintProfile): number | null {
  if (p.printer === 'thermal' || p.paper.lengthMm === null) return null;
  const g = pagePrintGeom(p);
  const usableMm = p.paper.lengthMm - g.marginTopMm - g.marginBottomMm;
  if (!(usableMm > 0) || !(g.zoom > 0)) return null;
  return Math.max(200, Math.floor((usableMm * PX_PER_MM) / g.zoom) - 2);
}

/** سمة جذر القالب ثنائي اللغة (lookRootAttrs) — الورقة الوحيدة التي تُضبط على طول الصفحة */
const GRID_SHEET_ATTR = 'data-print-layout';
const isGridSheet = (el: Element): boolean => el.getAttribute(GRID_SHEET_ATTR) === 'grid_bilingual';

// ─── «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) ───
// جذر القالب (FormInvoice في rep/printPreprinted.tsx، data-print-layout="preprinted") أوراقٌ بالمم من ركن الورقة الفعلي: تُطبع بمقاس
// الورق نفسه بلا هوامش ولا تكبير (zoom 1)، بلا وسم «الأصل/نسخة» في التدفّق (ورق الشركة مطبوعٌ لا فراغ فيه له) ولا ضبط طول ورقة
// ثنائي اللغة، والنسخ تكرّر الأوراق كلها كلٌّ في صفحاته. وثيقة كل ورقةٍ غيرها كما هي حرفاً (buildPageDocument وpagePrintGeom).

/** قيمة سمة جذر النموذج المطبوع مسبقاً */
export const FORM_SHEET_LAYOUT = 'preprinted';
/** جذر عقدة القالب ورقةُ نموذجٍ مطبوعٍ مسبقاً */
export const isFormSheet = (el: Pick<Element, 'getAttribute'>): boolean => el.getAttribute(GRID_SHEET_ATTR) === FORM_SHEET_LAYOUT;

/** هندسة صفحة النموذج: مقاس الورقة نفسه بالمم (بلا طولٍ ⇒ 297) بلا هامشين ولا إزاحة ولا تكبير — المواضع من ركن الورقة الفعلي */
export function formPrintGeom(p: PrintProfile): PagePrintGeom {
  const w = r1(p.paper.widthMm);
  const l = r1(p.paper.lengthMm ?? 297);
  return { size: `${w}mm ${l}mm`, widthMm: w, leftMm: 0, marginTopMm: 0, marginBottomMm: 0, zoom: 1 };
}

/** @page النموذج: المقاس بالمم وهامشٌ صفر */
export const formPageRule = (g: PagePrintGeom): string => `@page { size: ${g.size}; margin: 0; }`;

/**
 * وثيقة النموذج (نقيّة): الأنماط المنسوخة ثم @page بلا هامش ثم النسخ — كل نسخةٍ أوراق القالب كلها (فاصل الصفحة بين أوراقها من
 * القالب نفسه) وتبدأ في صفحةٍ جديدة. بلا zoom ولا قاعدة «لا تقصّ الصفّ»: الأوراق بارتفاعٍ ثابت دون طول الصفحة.
 */
export function buildFormDocument(copies: readonly string[], g: PagePrintGeom, headHtml = ''): string {
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"/>${headHtml}
  <style>
    ${formPageRule(g)}
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .fs-form { width: ${g.widthMm}mm; margin: 0; padding: 0; }
    .fs-copy + .fs-copy { break-before: page; page-break-before: always; }
  </style></head><body><div class="fs-form">${copies.map((c) => `<div class="fs-copy">${c}</div>`).join('')}</div></body></html>`;
}

/** أسلوب صورة الخلفية في جذر النموذج (rep/printPreprinted.tsx — formBgCss) */
const FORM_BG_CSS_RE = /<style data-form-bg-css="">[\s\S]*?<\/style>/g;

/**
 * صورة خلفية النموذج مرّةً في الوثيقة: أسلوبها (data URL) يُرفع من كل نسخةٍ إلى رأس الوثيقة — فلا يتكرّر الرابط بعدد النسخ (والأوراق
 * طبقاتٌ فارغة تحمله أصلاً). بلا أسلوب: النسخ كما هي و'' (نقيّة).
 */
export function hoistFormBgCss(copies: readonly string[]): { copies: string[]; css: string } {
  let css = '';
  const out = copies.map((c) => c.replace(FORM_BG_CSS_RE, (m) => { if (!css) css = m; return ''; }));
  return { copies: out, css };
}

/** رابط صورة الخلفية من أسلوبها المرفوع — لتُنتظر قبل الطباعة (لا <img> تنتظره settle) */
export const formBgUrlOf = (css: string): string | null => /url\(\s*["']?(data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)["']?\s*\)/.exec(css)?.[1] ?? null;

/** صورة الخلفية قيد الجلب في عقدة النموذج (data-form-bg="loading" على الجذر) */
const formBgLoading = (node: HTMLElement): boolean =>
  node.getAttribute?.('data-form-bg') === 'loading' || !!node.querySelector?.('[data-print-layout="preprinted"][data-form-bg="loading"]');

/**
 * شريط «نموذج اختبار» على ورقة النموذج: مرساةٌ بلا ارتفاع أوّل الجذر والشريط فوقها مطلقاً أعلى الورقة الأولى — فلا يدفع الأوراق
 * عن مواضعها ولا يفيض بالورقة إلى صفحةٍ ثانية كما يفعل الشريط في التدفّق.
 */
export const formBannerHtml = (bannerHtml: string): string =>
  `<div data-form-banner="" style="position:relative;height:0;overflow:visible;z-index:2"><div style="position:absolute;top:1.5mm;left:0;right:0;display:flex;justify-content:center">${bannerHtml}</div></div>`;

/** الشريط نفسه داخل شريط علامات القرار (data-form-marks) حين يوجد — سطرٌ أوّلٌ في تدفّقه فلا يتراكب النصّان */
export const formMarksBannerHtml = (bannerHtml: string): string =>
  `<div data-form-banner="" style="display:flex;justify-content:center">${bannerHtml}</div>`;

export const pageRule = (g: PagePrintGeom): string =>
  `@page { size: ${g.size}; margin: ${r1(g.marginTopMm)}mm 0 ${r1(g.marginBottomMm)}mm 0; }`;

const escText = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

/** سطر النسخة تحت الترويسة — صغيرٌ في المنتصف والعنوان لا يتغيّر */
export const copyLabelHtml = (label: string): string =>
  `<div data-copy-label="" style="text-align:center;font-weight:700;font-size:13px;margin:-10px 0 12px">${escText(label)}</div>`;

/**
 * ورقةٌ بتخطيطٍ مخصّص (data-print-layout): صفّ الجدول وصندوق القسم لا يُقصّان بين صفحتين ما اتّسعت لهما الصفحة. قاعدةٌ تُضاف
 * لتلك الأوراق وحدها — فوثيقة كل ورقةٍ بلا تخطيط كما هي حرفاً.
 */
export const LAYOUT_BREAK_CSS = '[data-print-layout] tr, [data-print-layout] [data-section="totals"], [data-print-layout] [data-section="signatures"] { break-inside: avoid; page-break-inside: avoid; }';

/**
 * «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦): لوحتا الرأس/التذييل (data-section="canvas-…") وكتلة الشعار المستقلة ورمز QR
 * المستقلّ لا تُقصّ بين صفحتين. ثابتٌ ثانٍ لا يمسّ LAYOUT_BREAK_CSS: يُضاف لوثيقةٍ فيها ورقةٌ حرّة وحدها (freeSheetHtml).
 */
export const LAYOUT_FREE_BREAK_CSS = '[data-print-layout] [data-section^="canvas-"], [data-print-layout] [data-section="logo"], [data-print-layout] [data-section="qr"] { break-inside: avoid; page-break-inside: avoid; }';

/** ورقةٌ حرّة: لوحات (data-print-canvas) أو مرساة وسم النسخة (data-copy-anchor — رأس المسار الحرّ وحده) أو كتلةٌ مستقلة */
export const freeSheetHtml = (html: string): boolean =>
  html.includes('data-print-canvas=') || html.includes('data-copy-anchor=') || html.includes('data-section="logo"') || html.includes('data-section="qr"');

/** نصّ الوثيقة (نقيّ): الأنماط المنسوخة من الصفحة ثم @page ثم النسخ — كلٌّ في صفحته */
export function buildPageDocument(copies: readonly string[], g: PagePrintGeom, headHtml = ''): string {
  const layoutCss = copies.some((c) => c.includes(`${GRID_SHEET_ATTR}=`)) ? `
    ${LAYOUT_BREAK_CSS}` : '';
  const freeCss = layoutCss && copies.some(freeSheetHtml) ? `
    ${LAYOUT_FREE_BREAK_CSS}` : '';
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"/>${headHtml}
  <style>
    ${pageRule(g)}${layoutCss}${freeCss}
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .fs-band { width: ${g.widthMm}mm; margin: 0 auto 0 ${g.leftMm}mm; }
    .fs-copy { zoom: ${g.zoom}; }
    .fs-copy + .fs-copy { break-before: page; page-break-before: always; }
  </style></head><body><div class="fs-band">${copies.map((c) => `<div class="fs-copy">${c}</div>`).join('')}</div></body></html>`;
}

/** نسخ القالب: الأولى «الأصل» والبقية «نسخة» بعد أوّل عنصر (الترويسة) — بلا وسمٍ إن لم تطلبه الشركة */
export function copiesOf(nodeHtml: (label: string | null) => string, count: number, labels: readonly [string, string] | null): string[] {
  const n = Math.max(1, Math.min(3, Math.floor(count) || 1));
  return Array.from({ length: n }, (_, i) => nodeHtml(labels ? (i === 0 ? labels[0] : labels[1]) : null));
}

/** أنماط الصفحة (الخطوط وقواعد Tailwind الأساسية) — فيطابق المطبوعُ ما يلتقطه ملف الـPDF من الصفحة نفسها */
function headStyles(): string {
  const base = `<base href="${escText(window.location.origin)}/"/>`;
  return base + Array.from(document.querySelectorAll('head link[rel="stylesheet"], head style')).map((n) => n.outerHTML).join('');
}

async function settle(idoc: Document, bgUrl: string | null = null): Promise<void> {
  const waitFor = (els: Array<HTMLLinkElement | HTMLImageElement>) => Promise.all(els.map((el) => new Promise<void>((resolve) => {
    el.addEventListener('load', () => resolve(), { once: true });
    el.addEventListener('error', () => resolve(), { once: true });
  })));
  const links = Array.from(idoc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).filter((l) => !l.sheet);
  const imgs = Array.from(idoc.images).filter((img) => !(img.complete && img.naturalWidth > 0));
  // خلفية النموذج في أسلوبٍ لا في <img>: تُفكّ بصورةٍ خارج الوثيقة (المصدر نفسه من الذاكرة) فتُرسم قبل نافذة الطباعة
  if (bgUrl) { const pre = idoc.createElement('img'); pre.src = bgUrl; if (!(pre.complete && pre.naturalWidth > 0)) imgs.push(pre); }
  await Promise.race([waitFor([...links, ...imgs]), new Promise<void>((resolve) => setTimeout(resolve, 2500))]);
  try { await idoc.fonts?.ready; } catch { /* خطّ النظام */ }
}

/**
 * صور القالب جاهزة قبل الاستنساخ: رمز QR يُرسم بأثرٍ غير متزامن (QrImage)، ونسخةٌ تُؤخذ قبل جهوزيته ورقةٌ ضريبية بلا رمز.
 * فالرمز شرط (false بعد المهلة ⇒ لا طباعة)، وغيره (الشعار والتوقيع) يُنتظر في المهلة نفسها ثم يُمضى بدونه.
 */
export async function sheetReady(node: HTMLElement, timeoutMs = 4000): Promise<boolean> {
  const loaded = (img: HTMLImageElement) => !!img.getAttribute('src') && img.complete && img.naturalWidth > 0;
  const start = Date.now();
  for (;;) {
    const imgs = Array.from(node.querySelectorAll('img'));
    const qrPending = imgs.some((img) => img.alt === 'QR' && !loaded(img));
    // خلفية النموذج قيد الجلب (أول طباعةٍ بعد الفتح): تُنتظر في المهلة نفسها ثم يُمضى بدونها (القيم وحدها)
    if (!qrPending && imgs.every(loaded) && !formBgLoading(node)) return true;
    if (Date.now() - start >= timeoutMs) return !qrPending;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * موضع وسم النسخة: مرساةٌ صريحة (data-copy-anchor — رأس المسار الحرّ أو لوحة الرأس) إن وُجدت، وإلا أوّل عنصرٍ ليس
 * أسلوب المظهر المحصور (كاليوم حرفاً). فكتلة شعارٍ مستقلة أعلى الورقة لا تُنزل الوسم تحتها.
 */
export function copyAnchorOf(root: Pick<ParentNode, 'children' | 'querySelector'>): Element | undefined {
  return root.querySelector('[data-copy-anchor]') ?? Array.from(root.children).find((c) => c.tagName !== 'STYLE');
}

/**
 * نسخة العقدة بوسمها (M3: مشتركةٌ بين نظام الطباعة والبلوتوث المباشر — النسخة نفسها تُطبع أو تُرسم): سطر «الأصل/نسخة» بعد
 * الترويسة، وفي الطباعة التجريبية شريط «نموذج اختبار» أوّلها (sampleBannerHtml من lib/print/calibration.ts).
 * `sheetHeightPx` (gridSheetHeightPx): ورقة القالب ثنائي اللغة تُضبط على طول صفحة الطابعة — وغيرها لا يُمسّ.
 */
export function cloneWithLabel(node: HTMLElement, label: string | null, bannerHtml?: string | null, sheetHeightPx?: number | null): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement;
  // النموذج المطبوع مسبقاً: الأوراق كما رُسمت — لا وسم في التدفّق ولا ضبط طول، والشريط التجريبيّ فوقها بلا ارتفاع
  if (isFormSheet(clone)) {
    if (bannerHtml) {
      // شريط علامات القرار (data-form-marks) أعلى الورقة الأولى في موضع الشريط نفسه: الشريط داخله أوّلاً فوق العلامات لا عليها
      const marks = clone.querySelector?.('[data-form-marks]') ?? null;
      if (marks) marks.insertAdjacentHTML('afterbegin', formMarksBannerHtml(bannerHtml));
      else clone.insertAdjacentHTML('afterbegin', formBannerHtml(bannerHtml));
    }
    return clone;
  }
  if (sheetHeightPx && isGridSheet(clone)) clone.style.minHeight = `${sheetHeightPx}px`;
  // بعد الترويسة: المرساة الصريحة، وإلا أوّل عنصرٍ ليس أسلوب المظهر المحصور
  if (label) copyAnchorOf(clone)?.insertAdjacentHTML('afterend', copyLabelHtml(label));
  // شريط التجربة أوّل الورقة وحده: الثاني آخرها كان يدفع ورقة A4 النموذجية إلى صفحةٍ ثانية فلا تشبه الفاتورة الحقيقية
  if (bannerHtml) clone.insertAdjacentHTML('afterbegin', bannerHtml);
  return clone;
}

/**
 * يطبع عقدة القالب المرسومة خارج الشاشة بمقاس قالب الطباعة. الوسمان مترجمان من الشاشة (null = بلا وسم).
 * يرمي إن تعذّر إنشاء الإطار — والشاشة تعرض «تعذرت الطباعة» وملف الـPDF يبقى.
 * وفي تطبيق الآيفون (iosSystemPrintAvailable) الوثيقة نفسها إلى نافذة الطباعة في التطبيق: print() في WKWebView لا يفتحها.
 */
export async function printPageNode(node: HTMLElement, p: PrintProfile, labels: readonly [string, string] | null, bannerHtml?: string | null): Promise<void> {
  if (!(await sheetReady(node))) throw new Error('sheet images');
  // النموذج المطبوع مسبقاً: وثيقته بمقاس الورق بلا هوامش ولا zoom (formPrintGeom/buildFormDocument) — وغيره كما كان حرفاً
  const form = isFormSheet(node);
  const g = form ? formPrintGeom(p) : pagePrintGeom(p);
  const sheetPx = form ? null : gridSheetHeightPx(p);
  const html = (label: string | null): string => cloneWithLabel(node, label, bannerHtml, sheetPx).outerHTML;
  // النموذج: صورة الخلفية مرّةً في رأس الوثيقة لا في كل نسخة (hoistFormBgCss)
  const formCopies = form ? hoistFormBgCss(copiesOf(html, p.options.copies, null)) : null;
  const doc = formCopies
    ? buildFormDocument(formCopies.copies, g, headStyles() + formCopies.css)
    : buildPageDocument(copiesOf(html, p.options.copies, p.options.copyLabels ? labels : null), g, headStyles());
  if (iosSystemPrintAvailable()) { await iosSystemPrint(doc, p.paper.widthMm, ''); return; }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  // الإطار بعرض الورق: التخطيط قبل الطباعة بالعرض الذي سيُطبع به
  iframe.style.cssText = `position:fixed;right:-9999px;bottom:0;width:${r1(p.paper.widthMm)}mm;height:0;border:0;`;
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const idoc = win?.document;
  if (!win || !idoc) { iframe.remove(); throw new Error('print frame'); }
  idoc.open(); idoc.write(doc); idoc.close();
  await settle(idoc, formCopies ? formBgUrlOf(formCopies.css) : null);
  const cleanup = () => setTimeout(() => iframe.remove(), 1000);
  win.addEventListener('afterprint', cleanup, { once: true });
  try { win.focus(); win.print(); } finally {
    // نافذة الجوال لا تُطلق afterprint دائماً — مهلةٌ أطول من الشريط احتياطاً
    setTimeout(() => iframe.remove(), 60_000);
  }
}

/**
 * يطبع وثيقة HTML كاملة (بقاعدة @page فيها) عبر نظام الطباعة — صفحة المعايرة (lib/print/calibration.ts). الإطار بعرض الورق
 * فيُخطَّط المحتوى بعرضه الفعليّ. وفي تطبيق الآيفون إلى نافذة الطباعة في التطبيق (كـprintPageNode).
 */
export async function printHtmlDocument(html: string, paperWidthMm: number): Promise<void> {
  if (iosSystemPrintAvailable()) { await iosSystemPrint(html, paperWidthMm, ''); return; }
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = `position:fixed;right:-9999px;bottom:0;width:${r1(paperWidthMm)}mm;height:0;border:0;`;
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const idoc = win?.document;
  if (!win || !idoc) { iframe.remove(); throw new Error('print frame'); }
  idoc.open(); idoc.write(html); idoc.close();
  await settle(idoc);
  win.addEventListener('afterprint', () => setTimeout(() => iframe.remove(), 1000), { once: true });
  try { win.focus(); win.print(); } finally {
    setTimeout(() => iframe.remove(), 60_000);
  }
}
