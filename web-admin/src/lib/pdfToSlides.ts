/**
 * يحوّل ملفّ PDF إلى صور شرائح **في متصفّح المالك**.
 *
 * لماذا في المتصفّح لا على الخادم: خدمة الخادم على لينكس بلا بوربوينت ولا
 * poppler، وإضافة تبعية أصلية لأجل رفعةٍ في الشهر ثمنٌ لا يستحقّه. والمتصفّح
 * يملك محرّك تصيير كاملاً مجاناً، والعمل يجري مرّةً واحدة عند الرفع.
 *
 * والحزمة تُحمَّل عند الطلب (`import()` داخل الدالّة) فلا يدفع ثمنها زائرُ
 * الموقع ولا مستخدمُ اللوحة الذي لا يرفع بروفايلاً.
 */

export interface RenderedSlide {
  seq: number;
  dataBase64: string;
  mime: 'image/webp';
  width: number;
  height: number;
  title: string;
  lines: string[];
}

export interface ConvertProgress {
  page: number;
  total: number;
}

/** عرض الشريحة بالبكسل — ضعف عرضها على شاشة عادية فتبقى حادّة على الريتينا */
const TARGET_W = 2400;
/** جودة WebP — 86 توازنٌ مُقاس: حدّة بلا تضخّم */
const QUALITY = 0.86;
/**
 * مهلة تصيير الصفحة الواحدة.
 *
 * تصيير pdf.js يعتمد على إطارات الرسم، وبعض البيئات تجمّدها (تبويب مخفيّ،
 * متصفّح مُدار، تسريع رسوميّ معطوب) فلا ينتهي التصيير أبداً. وبلا مهلة يبقى
 * المالك أمام دوّارة لا تتحرّك ولا يعرف لماذا. فنقطع ونقول له السبب.
 */
const PAGE_TIMEOUT_MS = 60_000;

/**
 * سطور صفحة PDF من طبقة نصّها.
 *
 * تُجمَع العناصر بحسب موضعها الرأسيّ فيصير كل صفّ سطراً — وإلا خرج النصّ
 * كلماتٍ مبعثرة لا يفهمها قارئ الشاشة ولا محرّك البحث. والنصّ للآلة لا للعرض،
 * فتقريبُ الترتيب مقبول.
 */
async function pageLines(page: { getTextContent: () => Promise<unknown> }): Promise<string[]> {
  try {
    const tc = await page.getTextContent() as {
      items: { str?: string; transform?: number[] }[];
    };
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of tc.items) {
      const s = (it.str || '').trim();
      if (!s) continue;
      const y = Math.round((it.transform?.[5] ?? 0) / 6) * 6;   // تجميع بصفوف
      const x = it.transform?.[4] ?? 0;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push({ x, s });
    }
    return [...rows.entries()]
      .sort((a, b) => b[0] - a[0])                             // من أعلى الصفحة لأسفلها
      .map(([, parts]) => parts.sort((a, b) => b.x - a.x).map(p => p.s).join(' ').trim())
      .filter(l => l.length > 1);
  } catch {
    return [];                                                 // النصّ زينة هنا لا شرط
  }
}

/**
 * يصيّر كل صفحة من الملفّ صورةً WebP.
 *
 * @param file ملفّ PDF اختاره المالك
 * @param onProgress يُنادى بعد كل صفحة لتتحرّك شريحة التقدّم
 */
export async function pdfToSlides(
  file: File,
  onProgress?: (p: ConvertProgress) => void,
): Promise<RenderedSlide[]> {
  const pdfjs = await import('pdfjs-dist');
  // العامل يُحمَّل من الحزمة نفسها لا من شبكة خارجية (سياسة المحتوى تمنعها)
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  (pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } })
    .GlobalWorkerOptions.workerSrc = workerUrl;

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const out: RenderedSlide[] = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = TARGET_W / base.width;
    const vp = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('تعذر تهيئة لوحة الرسم في المتصفح');

    const task = page.render({ canvasContext: ctx as CanvasRenderingContext2D, viewport: vp });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            task.cancel();
            reject(new Error(
              `تعذر تصيير الصفحة ${n} خلال دقيقة — جرب متصفح كروم أو ايدج حديثا، `
              + 'أو ارفع الملف للتنزيل وحده من الزر الثاني',
            ));
          }, PAGE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const dataUrl = canvas.toDataURL('image/webp', QUALITY);
    if (!dataUrl.startsWith('data:image/webp')) {
      throw new Error('متصفحك لا يدعم صيغة WebP — استعمل كروم أو إيدج حديثا');
    }
    const lines = await pageLines(page as unknown as { getTextContent: () => Promise<unknown> });

    out.push({
      seq: n,
      dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      mime: 'image/webp',
      width: canvas.width,
      height: canvas.height,
      title: lines[0] || `شريحة ${n}`,
      lines,
    });

    canvas.width = canvas.height = 0;      // تحرير الذاكرة فوراً — عرضٌ من ٢٠ شريحة يُثقل الجوال
    onProgress?.({ page: n, total: doc.numPages });
  }

  await doc.destroy();
  return out;
}

/** يقرأ الملفّ كـbase64 لإرساله كما هو (للتنزيل من الصفحة) */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(new Error('تعذر قراءة الملف'));
    r.readAsDataURL(file);
  });
}
