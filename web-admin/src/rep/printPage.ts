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

export const pageRule = (g: PagePrintGeom): string =>
  `@page { size: ${g.size}; margin: ${r1(g.marginTopMm)}mm 0 ${r1(g.marginBottomMm)}mm 0; }`;

const escText = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

/** سطر النسخة تحت الترويسة — صغيرٌ في المنتصف والعنوان لا يتغيّر */
export const copyLabelHtml = (label: string): string =>
  `<div data-copy-label="" style="text-align:center;font-weight:700;font-size:13px;margin:-10px 0 12px">${escText(label)}</div>`;

/** نصّ الوثيقة (نقيّ): الأنماط المنسوخة من الصفحة ثم @page ثم النسخ — كلٌّ في صفحته */
export function buildPageDocument(copies: readonly string[], g: PagePrintGeom, headHtml = ''): string {
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"/>${headHtml}
  <style>
    ${pageRule(g)}
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

async function settle(idoc: Document): Promise<void> {
  const waitFor = (els: Array<HTMLLinkElement | HTMLImageElement>) => Promise.all(els.map((el) => new Promise<void>((resolve) => {
    el.addEventListener('load', () => resolve(), { once: true });
    el.addEventListener('error', () => resolve(), { once: true });
  })));
  const links = Array.from(idoc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).filter((l) => !l.sheet);
  const imgs = Array.from(idoc.images).filter((img) => !(img.complete && img.naturalWidth > 0));
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
    if (!qrPending && imgs.every(loaded)) return true;
    if (Date.now() - start >= timeoutMs) return !qrPending;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * نسخة العقدة بوسمها (M3: مشتركةٌ بين نظام الطباعة والبلوتوث المباشر — النسخة نفسها تُطبع أو تُرسم): سطر «الأصل/نسخة» بعد
 * الترويسة، وفي الطباعة التجريبية شريط «نموذج اختبار» أوّلها (sampleBannerHtml من lib/print/calibration.ts).
 */
export function cloneWithLabel(node: HTMLElement, label: string | null, bannerHtml?: string | null): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement;
  // بعد الترويسة: أوّل عنصرٍ ليس أسلوب المظهر المحصور
  if (label) Array.from(clone.children).find((c) => c.tagName !== 'STYLE')?.insertAdjacentHTML('afterend', copyLabelHtml(label));
  // شريط التجربة أوّل الورقة وحده: الثاني آخرها كان يدفع ورقة A4 النموذجية إلى صفحةٍ ثانية فلا تشبه الفاتورة الحقيقية
  if (bannerHtml) clone.insertAdjacentHTML('afterbegin', bannerHtml);
  return clone;
}

/**
 * يطبع عقدة القالب المرسومة خارج الشاشة بمقاس قالب الطباعة. الوسمان مترجمان من الشاشة (null = بلا وسم).
 * يرمي إن تعذّر إنشاء الإطار — والشاشة تعرض «تعذرت الطباعة» وملف الـPDF يبقى.
 */
export async function printPageNode(node: HTMLElement, p: PrintProfile, labels: readonly [string, string] | null, bannerHtml?: string | null): Promise<void> {
  if (!(await sheetReady(node))) throw new Error('sheet images');
  const g = pagePrintGeom(p);
  const html = (label: string | null): string => cloneWithLabel(node, label, bannerHtml).outerHTML;
  const doc = buildPageDocument(copiesOf(html, p.options.copies, p.options.copyLabels ? labels : null), g, headStyles());

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  // الإطار بعرض الورق: التخطيط قبل الطباعة بالعرض الذي سيُطبع به
  iframe.style.cssText = `position:fixed;right:-9999px;bottom:0;width:${r1(p.paper.widthMm)}mm;height:0;border:0;`;
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const idoc = win?.document;
  if (!win || !idoc) { iframe.remove(); throw new Error('print frame'); }
  idoc.open(); idoc.write(doc); idoc.close();
  await settle(idoc);
  const cleanup = () => setTimeout(() => iframe.remove(), 1000);
  win.addEventListener('afterprint', cleanup, { once: true });
  try { win.focus(); win.print(); } finally {
    // نافذة الجوال لا تُطلق afterprint دائماً — مهلةٌ أطول من الشريط احتياطاً
    setTimeout(() => iframe.remove(), 60_000);
  }
}

/**
 * يطبع وثيقة HTML كاملة (بقاعدة @page فيها) عبر نظام الطباعة — صفحة المعايرة (lib/print/calibration.ts). الإطار بعرض الورق
 * فيُخطَّط المحتوى بعرضه الفعليّ.
 */
export async function printHtmlDocument(html: string, paperWidthMm: number): Promise<void> {
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
