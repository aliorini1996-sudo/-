/**
 * الطباعة المباشرة بالبلوتوث (المسار B في التصميم §3.3) — «إعدادات الطباعة» M3: من القالب المرسوم إلى بايتات الطابعة.
 *
 *   قالب الصفحة/النقطية (عقدة React خارج الشاشة، printPage.ts)  ┐
 *   الشريط الحراريّ الجديد (وثيقة thermalHtml.ts في إطار)         ├─ raster.ts: التقاط ⇒ أبيض وأسود ⇒ رمز QR بنقاط صحيحة ⇒ صفحات
 *   صفحة المعايرة (lib/print/calibration.ts في إطار)              ┘
 *        ⇒ escpos.ts (الحرارية) أو escp24.ts (MIP480) ⇒ transport/btSerial.ts (دفعات 512، تقدّم، إلغاء، إغلاق المنفذ)
 *
 * المصدر واحدٌ للمسارين: ما يطبعه نظام الطباعة هو ما يُرسم هنا (القالب نفسه، النسخة نفسها، الوسم نفسه) — فلا قالبٌ ثانٍ
 * للبلوتوث يفترق عن الأوّل. والقرار الضريبيّ لا يُتّخذ هنا: القالب أخذ عنوانه ورمزه وضريبته من zatcaPrintDecision، وخانة
 * الرمز تحمل قيمته كما هي.
 *
 * لا يُطبع بالبلوتوث: الشريط الكلاسيكي 58 مم (مجمَّدٌ على نظام الطباعة كاليوم) والطابعة العادية (ليزر/PDF).
 */
import {
  dotsPerMm, geometry, maxPrintableDots, type DevicePrintChoice, type PrintProfile, type PrinterDpi,
} from '../lib/print/printSettings';
import {
  PAGE_CUT_SEARCH_MM, applyQrSlots, captureElement, createBitmap, pageLabelRows, paginate, shiftRight, stackRows, textStrip,
  type Bitmap, type RasterPage,
} from '../lib/print/raster';
import { ESCPOS_CANCEL, encodeEscPos } from '../lib/print/escpos';
import { ESCP24_LINE_DOTS, encodeEscP24, escp24Cancel } from '../lib/print/escp24';
import { TSPL_CANCEL, encodeTspl } from '../lib/print/tspl';
import type { EncodedJob } from '../lib/print/byteSink';
import { directPrintAvailable, sendJob, type SerialPortLike } from '../lib/print/transport/btSerial';
import { cloneWithLabel, copiesOf, sheetReady } from './printPage';

export type PrintTransport = 'system' | 'bt-serial';

/** قالبٌ يُرسل للطابعة مباشرةً: حرارية بقالبٍ جديد أو نقطية، ولها دقة ونقاط — لا الكلاسيكي ولا العادية */
export function supportsDirect(p: PrintProfile | null | undefined): p is PrintProfile {
  return !!p && p.printer !== 'page' && p.template !== 'roll_classic' && p.paper.dpi !== null && p.paper.printableDots !== null;
}

/** طريقة هذا الجهاز للقالب: البلوتوث إن اختاره ودعمه المتصفح والقالب، وإلا نظام الطباعة (الافتراضي — كاليوم) */
export function transportFor(p: PrintProfile | null | undefined, choice: DevicePrintChoice | null | undefined, available: boolean = directPrintAvailable()): PrintTransport {
  return supportsDirect(p) && choice?.transport === 'bt-serial' && available ? 'bt-serial' : 'system';
}

export interface DirectUi {
  signal?: AbortSignal;
  /** المرحلة ونسبتها: التجهيز (الرسم) ثم الإرسال (نسبة البايتات) */
  onProgress?: (phase: 'prepare' | 'send', fraction: number) => void;
  /** «صفحة n من m» مترجمة */
  pageLabel: (n: number, m: number) => string;
  /** مهلة بين الدفعات (خيار الجهاز) */
  slow?: boolean;
  /** لغة الطابعة الحرارية المربوطة (خيار الجهاز) — TSPL لطابعات الملصقات كـRongta RPP04، وغيابها ESC/POS */
  lang?: 'tspl';
  /** TSPL: DIRECTION 0 */
  tsplFlip?: boolean;
}

const dpiOf = (p: PrintProfile): PrinterDpi => p.paper.dpi as PrinterDpi;

/** صفحات عنصرٍ واحد (نسخة): التقاط ثم رموز QR ثم تقسيمٌ للورق المقطع والمتصل مع سطر الترقيم */
export async function rasterPages(el: HTMLElement, p: PrintProfile, ui: DirectUi): Promise<RasterPage[]> {
  const dpi = dpiOf(p);
  const { bitmap, slots } = await captureElement(el, p.paper.printableDots as number);
  const qrRows = applyQrSlots(bitmap, slots, { dpi, size: p.options.qrSize });
  const g = geometry(p);
  const rows = g.feed === 'roll' ? null : g.rowsPerPage;
  const label = (n: number, m: number): Bitmap => {
    const r = pageLabelRows(dpi);
    return stackRows(createBitmap(bitmap.width, r.gap), textStrip(ui.pageLabel(n, m), bitmap.width, r.text));
  };
  return paginate(bitmap, qrRows, rows, Math.round(PAGE_CUT_SEARCH_MM * dotsPerMm(dpi)), label);
}

/**
 * إزاحة النقطية يميناً (نقاط) مقصورةً على ما يتركه عرض الصورة من سطر الطباعة 1440 — فلا يُدفع عمود حبرٍ وراءه (اسم البائع أو
 * طرف الرمز). ESC $ بوحدة 1/60 (3 نقاط) والمُرمِّز يقرّب لأقرب مضاعف 3؛ فإن جاوز التقريبُ ما بقي نزلنا لمضاعف 3 الأدنى.
 * القالب الصالح لا يصل هذا الحدّ (printSettingsCore يرفض الحزمة + الإزاحة فوق 1440) — هذا حدٌّ ثانٍ للصورة الفعلية.
 */
export function impactLeftDots(offsetDots: number, bitmapWidth: number): number {
  const off = Math.max(0, Math.round(offsetDots));
  const room = Math.max(0, ESCP24_LINE_DOTS - Math.max(0, Math.floor(bitmapWidth)));
  return Math.round(off / 3) * 3 <= room ? off : Math.floor(room / 3) * 3;
}

/**
 * بايتات المهمة وأمر إلغائها بحسب نوع الطابعة — الهامش العلوي والإزاحة وطول الصفحة والقصّ من القالب. والحرارية بلغة جهازها:
 * ESC/POS افتراضاً، أو TSPL (`lang`) لطابعات الملصقات — الصورة نفسها بأوامرٍ أخرى.
 */
export function encodeForProfile(
  p: PrintProfile, copies: RasterPage[][], device: { lang?: 'tspl'; tsplFlip?: boolean } = {},
): { job: EncodedJob; cancel: readonly number[] } {
  const g = geometry(p);
  const dpm = dotsPerMm(dpiOf(p));
  const offsetDots = Math.max(0, Math.round(p.paper.offsetXmm * dpm)); // لا يسار قبل أوّل نقطة في الرأس
  if (p.printer === 'impact') {
    const continuous = g.feed === 'continuous';
    const widest = Math.max(0, ...copies.flatMap((pages) => pages.map((pg) => pg.bitmap.width)));
    return {
      job: encodeEscP24({
        copies,
        continuous,
        pageLengthMm: g.paperLengthMm,
        topDots: Math.round(g.marginTopMm * dpm),
        leftDots: impactLeftDots(offsetDots, widest),
        draft: p.options.graphicsQuality === 'draft',
      }),
      // المتصل: لا ESC @ يمحو طول الصفحة فتنزاح النماذج التالية (escp24.ts)
      cancel: escp24Cancel(continuous, continuous ? g.paperLengthMm : null),
    };
  }
  const maxDots = maxPrintableDots('thermal', p.paper.widthMm, dpiOf(p));
  if (device.lang === 'tspl' && g.feed === 'roll') {
    // الرول وحده: يحمل هامشه وتغذيته في حشوة القالب كـESC/POS، وصفوف رموزه تمرّ فلا يُقطع «ملصق» داخلها. والورق المقطع
    // (طول الصفحة والهامش العلوي والقاطع) لا يُعرض لـTSPL — يبقى على ESC/POS كما كان
    return {
      job: encodeTspl({
        copies: copies.map((pages) => pages.map((pg) => ({ bitmap: shiftRight(pg.bitmap, offsetDots, maxDots, 8), qrRows: pg.qrRows }))),
        dotsPerMm: dpm,
        afterDots: 0,
        flip: device.tsplFlip === true,
      }),
      cancel: TSPL_CANCEL,
    };
  }
  const sheet = g.feed !== 'roll' && g.paperLengthMm !== null;
  return {
    job: encodeEscPos({
      copies: copies.map((pages) => pages.map((pg) => shiftRight(pg.bitmap, offsetDots, maxDots, 8))),
      // الرول يحمل هامشه وتغذيته في حشوة القالب (صفوف بيضاء تصير ESC J)؛ الورق المقطع: الهامش هنا والتكملة إلى طول الورقة
      topDots: sheet ? Math.round(g.marginTopMm * dpm) : 0,
      afterDots: 0,
      pageRows: sheet ? Math.round((g.paperLengthMm as number) * dpm) : null,
      cut: p.options.cutAfter,
    }),
    cancel: ESCPOS_CANCEL,
  };
}

async function send(port: SerialPortLike, p: PrintProfile, copies: RasterPage[][], ui: DirectUi): Promise<'done' | 'cancelled'> {
  if (ui.signal?.aborted) return 'cancelled';
  const { job, cancel } = encodeForProfile(p, copies, { lang: ui.lang, tsplFlip: ui.tsplFlip });
  return sendJob(port, job, { signal: ui.signal, cancelBytes: cancel, slow: ui.slow, onProgress: (f) => ui.onProgress?.('send', f) });
}

/** الصور والخطوط في إطارٍ قبل الالتقاط — بسقفٍ زمنيّ: صورةٌ معطوبة لا تحبس الطباعة */
async function settleFrame(idoc: Document): Promise<void> {
  const imgs = Array.from(idoc.images ?? []).filter((img) => !(img.complete && img.naturalWidth > 0));
  await Promise.race([
    Promise.all(imgs.map((img) => new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    }))),
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  ]);
  try { await idoc.fonts?.ready; } catch { /* خطّ النظام */ }
}

/**
 * وثيقة HTML كاملة (الشريط الحراريّ الجديد أو صفحة المعايرة) في إطارٍ خارج الشاشة بعرض الورق، ثم كل `section.copy` نسخةً
 * (الشريط) أو كل `section.cal` صفحةً من نسخةٍ واحدة (المعايرة).
 */
export async function printHtmlDirect(port: SerialPortLike, html: string, p: PrintProfile, kind: 'copies' | 'pages', ui: DirectUi): Promise<'done' | 'cancelled'> {
  ui.onProgress?.('prepare', 0);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${Math.ceil(p.paper.widthMm + 10)}mm;height:4000px;border:0;background:#fff;`;
  document.body.appendChild(iframe);
  try {
    const idoc = iframe.contentWindow?.document;
    if (!idoc) throw new Error('raster frame');
    idoc.open(); idoc.write(html); idoc.close();
    await settleFrame(idoc);
    const sections = Array.from(idoc.querySelectorAll<HTMLElement>(kind === 'copies' ? 'section.copy' : 'section.cal'));
    if (sections.length === 0) throw new Error('raster: no sections');
    const parts: RasterPage[][] = [];
    for (let i = 0; i < sections.length; i++) {
      if (ui.signal?.aborted) return 'cancelled';
      parts.push(await rasterPages(sections[i], p, ui));
      ui.onProgress?.('prepare', (i + 1) / sections.length);
    }
    const copies = kind === 'copies' ? parts : [parts.flat()];
    return await send(port, p, copies, ui);
  } finally {
    iframe.remove();
  }
}

/**
 * قالب صفحة/نقطية مرسوم خارج الشاشة: كل نسخةٍ نسخةُ العقدة بوسمها (cloneWithLabel — كنظام الطباعة) تُلحق بجانبها مؤقّتاً
 * فتُلتقط بأنماطها، ثم تُزال. الوسمان مترجمان (null بلا وسم)، وbannerHtml للطباعة التجريبية.
 */
export async function printNodeDirect(
  port: SerialPortLike, node: HTMLElement, p: PrintProfile, labels: readonly [string, string] | null, ui: DirectUi, bannerHtml?: string | null,
): Promise<'done' | 'cancelled'> {
  ui.onProgress?.('prepare', 0);
  // الشعار والتوقيع قبل الالتقاط؛ صورة الرمز لا تلزم (تُعاد رسمته من خانته)
  await sheetReady(node);
  const host = node.parentElement;
  if (!host) throw new Error('raster: detached sheet');
  const want = copiesOf((label) => label ?? '', p.options.copies, p.options.copyLabels ? labels : null);
  const copies: RasterPage[][] = [];
  for (let i = 0; i < want.length; i++) {
    if (ui.signal?.aborted) return 'cancelled';
    const clone = cloneWithLabel(node, want[i] || null, bannerHtml);
    host.appendChild(clone);
    try {
      copies.push(await rasterPages(clone, p, ui));
    } finally {
      clone.remove();
    }
    ui.onProgress?.('prepare', (i + 1) / want.length);
  }
  return send(port, p, copies, ui);
}
