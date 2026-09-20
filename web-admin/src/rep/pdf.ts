import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

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

// يحوّل عنصر DOM إلى PDF بصيغة Blob (صفحة A4، يدعم تعدد الصفحات)
// `singlePage`: يُصغَّر الالتقاط ليسع صفحة واحدة دائماً — عنصرٌ بمقاس 794×1123px أطول من
// نسبة A4 بجزءٍ من النقطة، فكان يُنتج صفحةً ثانية فارغة تقريباً
export async function elementToPdfBlob(el: HTMLElement, opts?: { singlePage?: boolean }): Promise<Blob> {
  await waitForImages(el);
  const canvas = await html2canvas(el, {
    scale: 2,
    useCORS: true,
    backgroundColor: '#ffffff',
    logging: false,
  });
  const imgData = canvas.toDataURL('image/jpeg', 0.95);
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  if (opts?.singlePage) {
    const fit = Math.min(pageW / canvas.width, pageH / canvas.height);
    const w = canvas.width * fit;
    const h = canvas.height * fit;
    pdf.addImage(imgData, 'JPEG', (pageW - w) / 2, 0, w, h);
    return pdf.output('blob');
  }

  const imgW = pageW;
  const imgH = (canvas.height * imgW) / canvas.width;

  let heightLeft = imgH;
  let position = 0;
  pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
  heightLeft -= pageH;

  while (heightLeft > 0) {
    position -= pageH;
    pdf.addPage();
    pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
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
    pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
    heightLeft -= pageH;
    while (heightLeft > 0.5) {
      position -= pageH;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
      heightLeft -= pageH;
    }
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
