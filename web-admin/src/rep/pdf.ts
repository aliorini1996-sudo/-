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
