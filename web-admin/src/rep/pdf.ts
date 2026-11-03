import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { linkAreas, type LinkBox } from '../lib/pdfLinks';
import { PRINT_LIMITS } from '../lib/print/printSettingsCore';

// ينتظر تحميل كل الصور داخل العنصر (مثل رمز QR) قبل الالتقاط — كي لا تُلتقط فارغة
async function waitForImages(el: HTMLElement, timeout = 4000): Promise<void> {
  const imgs = Array.from(el.querySelectorAll('img'));
  if (imgs.length === 0) return;
  await Promise.race([
    Promise.all(
      imgs.map((img) =>
        img.src && img.complete && img.naturalWidth > 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            })
      )
    ),
    new Promise<void>((resolve) => setTimeout(resolve, timeout)),
  ]);
}

/**
 * مقاس صفحة الـPDF من سمة جذر القالب `data-pdf-format` («إعدادات الطباعة» M2: قالب ملف PDF بمقاس A5 أو Letter أو مخصّص).
 * الغياب — كل قالبٍ بلا إعداد، وعروض الأسعار ومولّد الفاتورة — أو أيّ قيمةٍ غير مفهومة ⇒ A4 كما اليوم. والمخصّص «العرض×الطول»
 * بالمم يُحوَّل نقاطاً (72 للبوصة)، والأعرض من طوله أفقيّ (نصف صفحة 9.5×5.5 بوصة) كي لا يقلبه jsPDF.
 * والأضيق من A5 (PRINT_LIMITS.pageMinWidthMm) ⇒ A4 — حدٌّ ثانٍ بعد النواة: القالب يُصغَّر بعرض الصفحة فيصغر الرمز المختوم معه
 * (58 مم ⇒ ~0.14 مم للخلية لا تُمسح).
 */
export function pdfPageOf(v: string | undefined | null): { format: string | [number, number]; orientation: 'portrait' | 'landscape' } {
  if (v === 'a5' || v === 'letter') return { format: v, orientation: 'portrait' };
  const m = /^(\d{2,3}(?:\.\d+)?)x(\d{2,4}(?:\.\d+)?)$/.exec(v ?? '');
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w >= PRINT_LIMITS.pageMinWidthMm && w <= 270 && h >= 50 && h <= 1000) {
      const pt = (mm: number) => Math.round((mm * 72 / 25.4) * 100) / 100;
      return { format: [pt(w), pt(h)], orientation: w > h ? 'landscape' : 'portrait' };
    }
  }
  return { format: 'a4', orientation: 'portrait' };
}

/** صندوقٌ لا يُقصّ بين صفحتين (بكسل العنصر من أعلاه) */
export interface KeepBox { top: number; bottom: number }

/**
 * بدايات صفحات ورقةٍ بتخطيطٍ مخصّص (data-print-layout — «تخطيط المطبوعات»)، بكسل العنصر: القصّ لا يقع داخل صفّ جدولٍ ولا صندوقٍ
 * يتّسع لصفحة (keep) — يرتفع إلى أعلاه ما بقي من الصفحة نصفُها على الأقل، وإلا قصٌّ عاديّ. وورقةٌ تزيد على الصفحة بأقلّ من
 * `tolerancePx` (ورقة القالب ثنائي اللغة 794×1123 أطول من نسبة A4 بجزءٍ من النقطة) صفحةٌ واحدة لا ثانيةٌ بشريطٍ أبيض.
 */
export function layoutPageStarts(totalPx: number, pagePx: number, keep: readonly KeepBox[], tolerancePx = 3): number[] {
  const starts = [0];
  if (!(pagePx > 0) || !(totalPx > 0)) return starts;
  const boxes = keep.filter((b) => b.bottom > b.top && b.bottom - b.top <= pagePx);
  let pos = 0;
  while (totalPx - pos > pagePx + tolerancePx) {
    let cut = pos + pagePx;
    for (let guard = 0; guard < 20; guard++) {
      const crossing = boxes.filter((b) => b.top < cut - 0.5 && b.bottom > cut + 0.5 && b.top > pos);
      if (crossing.length === 0) break;
      const up = Math.min(...crossing.map((b) => b.top));
      if (up - pos < pagePx / 2) break;
      cut = up;
    }
    starts.push(cut);
    pos = cut;
  }
  return starts;
}

/** صناديق «لا تُقصّ» في ورقةٍ بتخطيط: صفوف الجداول والأقسام ووحدات «حذف السطر» (data-line) — بكسل العنصر */
function keepBoxesOf(el: HTMLElement): KeepBox[] {
  const base = el.getBoundingClientRect();
  return Array.from(el.querySelectorAll('tr, [data-section], [data-line]')).map((n) => {
    const r = n.getBoundingClientRect();
    return { top: r.top - base.top, bottom: r.bottom - base.top };
  });
}

/** ورقةٌ بتخطيط: كل صفحةٍ قطعةٌ من الالتقاط بين بدايتين — لا صورةٌ كاملة تُزاح فتُطبع تحت القصّ صفوفُ الصفحة التالية */
function layoutPdf(el: HTMLElement, canvas: HTMLCanvasElement, keep: KeepBox[], opts?: { lossless?: boolean }): Blob {
  const page = pdfPageOf(el.dataset?.pdfFormat);
  const pdf = new jsPDF({ unit: 'pt', format: page.format, orientation: page.orientation });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const cssW = el.offsetWidth || canvas.width;
  const k = canvas.width / cssW;                   // بكسل الالتقاط لكل بكسل عنصر
  const pagePx = (pageH / pageW) * cssW;            // طول الصفحة ببكسل العنصر (الصورة بعرض الصفحة)
  const totalPx = canvas.height / k;
  const starts = layoutPageStarts(totalPx, pagePx, keep);
  const fmt = opts?.lossless ? 'PNG' : 'JPEG';
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : totalPx;
    const sy = Math.round(start * k);
    const sh = Math.max(1, Math.min(canvas.height, Math.round(end * k)) - sy);
    const part = document.createElement('canvas');
    part.width = canvas.width;
    part.height = sh;
    const ctx = part.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, part.width, part.height);
    ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
    const data = opts?.lossless ? part.toDataURL('image/png') : part.toDataURL('image/jpeg', 0.95);
    if (i > 0) pdf.addPage();
    // صفحةٌ واحدة ضمن السماح: تُصغَّر لتسع الصفحة بدل شريطٍ في صفحةٍ ثانية
    const h = (sh / canvas.width) * pageW;
    const fit = starts.length === 1 && h > pageH ? pageH / h : 1;
    pdf.addImage(data, fmt, (pageW - pageW * fit) / 2, 0, pageW * fit, h * fit);
  });
  return pdf.output('blob');
}

// يحوّل عنصر DOM إلى PDF بصيغة Blob (صفحة A4، يدعم تعدد الصفحات)
// `singlePage`: يُصغَّر الالتقاط ليسع صفحة واحدة دائماً — عنصرٌ بمقاس 794×1123px أطول من
// نسبة A4 بجزءٍ من النقطة، فكان يُنتج صفحةً ثانية فارغة تقريباً
// `lossless`: PNG بدل JPEG — لورقةٍ تحمل رمز QR مختوماً من المرحلة الثانية. ضغط JPEG الفاقد يُلطّخ حواف
// الحُجَيرات في نمطٍ ثنائيّ دقيق، والورقة هذه هي التي يمسحها العميل والمفتّش. وغيرُها يبقى JPEG (أخفّ حجماً).
export async function elementToPdfBlob(el: HTMLElement, opts?: { singlePage?: boolean; lossless?: boolean }): Promise<Blob> {
  await waitForImages(el);
  // «تخطيط المطبوعات»: ورقةٌ بسمة data-print-layout تُقسَّم عند حدود الصفوف (قبل الالتقاط: المواضع من DOM نفسه) — وما سواها كما اليوم
  const keep = !opts?.singlePage && el.hasAttribute?.('data-print-layout') ? keepBoxesOf(el) : null;
  const canvas = await html2canvas(el, {
    scale: 2,
    useCORS: true,
    backgroundColor: '#ffffff',
    logging: false,
  });
  if (keep) return layoutPdf(el, canvas, keep, opts);
  const fmt = opts?.lossless ? 'PNG' : 'JPEG';
  const imgData = opts?.lossless ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.95);
  // مقاس الصفحة من جذر القالب (A4 بلا سمة) — والنداء المحروس في شاشة النتيجة يبقى كما هو بلا وسيطٍ جديد
  const page = pdfPageOf(el.dataset?.pdfFormat);
  const pdf = new jsPDF({ unit: 'pt', format: page.format, orientation: page.orientation });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  if (opts?.singlePage) {
    const fit = Math.min(pageW / canvas.width, pageH / canvas.height);
    const w = canvas.width * fit;
    const h = canvas.height * fit;
    pdf.addImage(imgData, fmt, (pageW - w) / 2, 0, w, h);
    return pdf.output('blob');
  }

  const imgW = pageW;
  const imgH = (canvas.height * imgW) / canvas.width;

  let heightLeft = imgH;
  let position = 0;
  pdf.addImage(imgData, fmt, 0, position, imgW, imgH);
  heightLeft -= pageH;

  while (heightLeft > 0) {
    position -= pageH;
    pdf.addPage();
    pdf.addImage(imgData, fmt, 0, position, imgW, imgH);
    heightLeft -= pageH;
  }
  return pdf.output('blob');
}

// حدود أبعاد canvas عبر المتصفّحات: Chrome يحدّ البُعد الواحد بـ~32767px،
// وiOS/Safari يحدّان المساحة بـ~16.7M بكسل. نبقى دون الحدّين باحتياط.
const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_AREA = 16_000_000;

/** أكبر مقياس لا يتجاوز به عنصرٌ بأبعاده (px) حدّي المتصفّح — بأرضية 0.6 */
export function safeScale(w: number, h: number, desired = 2): number {
  if (w <= 0 || h <= 0) return desired;
  const byDim = MAX_CANVAS_DIM / Math.max(w, h);
  const byArea = Math.sqrt(MAX_CANVAS_AREA / (w * h));
  return Math.max(0.6, Math.min(desired, byDim, byArea));
}

/**
 * يبني PDF متعدّد الصفحات من **عدّة عناصر** (كلٌّ شريحة صفوف مستقلّة).
 *
 * لماذا لا عنصرٌ واحد: جدولٌ طويل (تفاصيل زيارات آلاف المناديب) يصير أطول من
 * حدّ الـcanvas، فتُنتج html2canvas صورةً بيضاء بلا استثناء ⇒ صفحات PDF بيضاء
 * صامتة. التقطيعُ يُبقي كل التقاطٍ دون الحدّ، والحارسُ يرمي خطأً صريحاً بدل
 * تسليم بياضٍ للمستخدم. المُستدعي يقسّم الصفوف ويبني عنصراً لكل شريحة.
 */
export async function elementsToPdfBlob(els: HTMLElement[]): Promise<Blob> {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  let first = true;
  for (const el of els) {
    await waitForImages(el);
    // تنفّسٌ للمتصفّح بين الشرائح: html2canvas يحجب الخيط، فبلا هذا تبدو الصفحة
    // «معلّقة» طوال التقاط تقريرٍ متعدّد الشرائح
    await new Promise((r) => setTimeout(r, 0));
    const w = el.offsetWidth || 780;
    const h = el.offsetHeight || el.scrollHeight || 1;
    // مواضع الروابط قبل الالتقاط — الصورة تُسقطها، فتُعاد مناطقَ روابط فوقها
    const base = el.getBoundingClientRect();
    const boxes: LinkBox[] = Array.from(el.querySelectorAll('a[href]')).map((a) => {
      const r = a.getBoundingClientRect();
      return { url: (a as HTMLAnchorElement).href, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
    });
    const canvas = await html2canvas(el, {
      scale: safeScale(w, h), useCORS: true, backgroundColor: '#ffffff', logging: false,
    });
    // حارسٌ صريح: canvas فارغ أو التقاطٌ خاوٍ ⇒ خطأ يصل المستخدم، لا صفحة بيضاء
    if (!canvas.width || !canvas.height) throw new Error('تعذّر التقاط الجدول (كبير جداً)');
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    if (imgData.length < 2000) throw new Error('التقاط فارغ');
    const imgW = pageW;
    const imgH = (canvas.height * imgW) / canvas.width;
    let heightLeft = imgH;
    let position = 0;
    if (!first) pdf.addPage();
    first = false;
    const firstPage = pdf.getNumberOfPages();
    pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
    heightLeft -= pageH;
    while (heightLeft > 0.5) {
      position -= pageH;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
      heightLeft -= pageH;
    }
    const lastPage = pdf.getNumberOfPages();
    for (const l of linkAreas(boxes, w, pageW, pageH)) {
      if (firstPage + l.page > lastPage) continue;
      pdf.setPage(firstPage + l.page);
      pdf.link(l.x, l.y, l.w, l.h, { url: l.url });
    }
    pdf.setPage(lastPage);
  }
  return pdf.output('blob');
}

// تنزيلٌ فعليّ للملف (بلا مشاركة) — للوحة المكتبية حيث المتوقَّع حفظُ الملف
// مثل Excel، لا فتح نافذة مشاركة (canShare يقبل PDF على سطح المكتب فيحوّله
// مشاركةً، بينما يرفض xlsx فيُنزَّل — فاختلف سلوك الزرَّين على نفس الجهاز).
export function downloadPdf(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // إمهال المتصفّح لبدء التنزيل قبل إبطال الرابط
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// يشارك الملف عبر زر المشاركة في الجوال، وإلا يُنزّله
export async function shareOrDownloadPdf(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };

  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename } as ShareData);
      return 'shared';
    } catch {
      // المستخدم ألغى أو فشلت المشاركة → ننتقل للتنزيل
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return 'downloaded';
}
