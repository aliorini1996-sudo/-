/**
 * الطباعة المباشرة بالبلوتوث (المسار B في التصميم §3.3) — «إعدادات الطباعة» M3: من القالب المرسوم إلى بايتات الطابعة.
 *
 *   قالب الصفحة/النقطية (عقدة React خارج الشاشة، printPage.ts)  ┐
 *   الشريط الحراريّ الجديد (وثيقة thermalHtml.ts في إطار)         ├─ raster.ts: التقاط ⇒ أبيض وأسود ⇒ رمز QR بنقاط صحيحة ⇒ صفحات
 *   صفحة المعايرة (lib/print/calibration.ts في إطار)              ┘
 *   ونموذج الشركة المطبوع مسبقاً على النقطية (ورقته ومعايرتها) ⇒ formRasterPages: كل ورقةٍ صفحةٌ بمواضعها الفعلية (لا paginate)
 *        ⇒ escpos.ts (الحرارية) أو escp24.ts (MIP480) ⇒ transport/btSerial.ts (دفعات 512، تقدّم، إلغاء، إغلاق المنفذ)
 *        أو أندرويد بلا Web Serial ⇒ transport/appBridge.ts: البايتات نفسها حمولةً لتطبيق فيلد سيلز يطبعها بالبلوتوث
 *        أو تطبيق فيلد سيلز على الآيفون ⇒ transport/iosBridge.ts: البايتات نفسها حمولةً خاماً يطبعها التطبيق بـBLE (والنقطية لا:
 *        بلوتوثها كلاسيكيّ لا يصله الآيفون — directAvailableFor)
 *
 * المصدر واحدٌ للمسارين: ما يطبعه نظام الطباعة هو ما يُرسم هنا (القالب نفسه، النسخة نفسها، الوسم نفسه) — فلا قالبٌ ثانٍ
 * للبلوتوث يفترق عن الأوّل. والقرار الضريبيّ لا يُتّخذ هنا: القالب أخذ عنوانه ورمزه وضريبته من zatcaPrintDecision، وخانة
 * الرمز تحمل قيمته كما هي.
 *
 * لا يُطبع بالبلوتوث: الشريط الكلاسيكي 58 مم (مجمَّدٌ على نظام الطباعة كاليوم) والطابعة العادية (ليزر/PDF).
 */
import {
  dotsPerMm, formReachX, geometry, maxPrintableDots, type DevicePrintChoice, type PrintProfile, type PrinterDpi,
} from '../lib/print/printSettings';
import {
  PAGE_CUT_SEARCH_MM, applyQrSlots, captureElement, createBitmap, formSheetRaster, pageLabelRows, paginate, shiftRight, stackRows, textStrip,
  type Bitmap, type RasterPage,
} from '../lib/print/raster';
import { ESCPOS_CANCEL, encodeEscPos } from '../lib/print/escpos';
import { ESCP24_LINE_DOTS, FORM_SEGMENT_GAP_DOTS, encodeEscP24, escp24Cancel } from '../lib/print/escp24';
import { TSPL_CANCEL, encodeTspl } from '../lib/print/tspl';
import type { EncodedJob } from '../lib/print/byteSink';
import { sendJob } from '../lib/print/transport/btSerial';
import { currentPlatformInput, directPath, isAppLink, isIosLink, type DirectLink } from '../lib/print/transport/direct';
import { sendViaApp } from '../lib/print/transport/appBridge';
import { sendViaIos } from '../lib/print/transport/iosBridge';
import { IOS_IMPACT_DIRECT, classifyPrintPlatform, directHint, type DirectHint, type DirectPath, type PlatformInput } from '../lib/print/transport/platform';
import { cloneWithLabel, copiesOf, isFormSheet, sheetReady } from './printPage';

export type PrintTransport = 'system' | 'bt-serial';
/** حصيلة الطباعة المباشرة: 'handed' = سُلّمت لتطبيق فيلد سيلز بلا مفتاح ثقة (لا يُعلم أطُبعت) */
export type DirectOutcome = 'done' | 'cancelled' | 'handed';

/** قالبٌ يُرسل للطابعة مباشرةً: حرارية بقالبٍ جديد أو نقطية، ولها دقة ونقاط — لا الكلاسيكي ولا العادية */
export function supportsDirect(p: PrintProfile | null | undefined): p is PrintProfile {
  return !!p && p.printer !== 'page' && p.template !== 'roll_classic' && p.paper.dpi !== null && p.paper.printableDots !== null;
}

/**
 * البلوتوث المباشر ممكنٌ لهذا القالب على هذا الجهاز: طريقٌ موجود — إلا النقطية (MIP480) في تطبيق الآيفون: بلوتوثها كلاسيكيّ بلا
 * BLE فلا يصلها (ما دام IOS_IMPACT_DIRECT مطفأً)
 */
export function directAvailableFor(p: PrintProfile | null | undefined, path: DirectPath = directPath()): boolean {
  if (path === 'none') return false;
  if (path === 'ios-app' && p?.printer === 'impact' && !IOS_IMPACT_DIRECT) return false;
  return true;
}

/** تلميح «بلوتوث مباشر» للقالب: النقطية على الآيفون impactIos (أيّاً كان المتصفح أو التطبيق)، وإلا تلميح الجهاز (platform.ts) */
export function directHintFor(p: PrintProfile | null | undefined, input: PlatformInput = currentPlatformInput()): DirectHint | 'impactIos' {
  if (p?.printer === 'impact' && !IOS_IMPACT_DIRECT && classifyPrintPlatform(input).os === 'ios') return 'impactIos';
  return directHint(input);
}

/** طريقة هذا الجهاز للقالب: البلوتوث إن اختاره ودعمه الجهاز (Web Serial أو تطبيق أندرويد أو الآيفون) والقالب، وإلا نظام الطباعة (الافتراضي — كاليوم) */
export function transportFor(p: PrintProfile | null | undefined, choice: DevicePrintChoice | null | undefined, available: boolean = directAvailableFor(p)): PrintTransport {
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
  /** وسمٌ قصير للمستند تعرضه شاشة التطبيق (مسار أندرويد؛ ويحمله الآيفون في الحمولة) */
  docLabel?: string;
  /** لمسةٌ ثانية حين انقضت صلاحية الإيماءة قبل فتح التطبيق — ترفض إن أُلغيت */
  requestTap?: () => Promise<void>;
  /** لحظة التسليم للتطبيق */
  onHandoff?: () => void;
}

const dpiOf = (p: PrintProfile): PrinterDpi => p.paper.dpi as PrinterDpi;

/** صفحات عنصرٍ واحد (نسخة): التقاط ثم رموز QR ثم تقسيمٌ للورق المقطع والمتصل مع سطر الترقيم */
export async function rasterPages(el: HTMLElement, p: PrintProfile, ui: DirectUi): Promise<RasterPage[]> {
  const dpi = dpiOf(p);
  const { bitmap, slots, keep } = await captureElement(el, p.paper.printableDots as number);
  const qrRows = applyQrSlots(bitmap, slots, { dpi, size: p.options.qrSize });
  const g = geometry(p);
  const rows = g.feed === 'roll' ? null : g.rowsPerPage;
  const label = (n: number, m: number): Bitmap => {
    const r = pageLabelRows(dpi);
    return stackRows(createBitmap(bitmap.width, r.gap), textStrip(ui.pageLabel(n, m), bitmap.width, r.text));
  };
  // لوحتا «التحرير الحرّ» (keep — ورقةٌ بـdata-print-canvas وحدها) لا تُقطعان بين صفحتين؛ وبلاها (undefined) التقسيم كاليوم
  return paginate(bitmap, qrRows, rows, Math.round(PAGE_CUT_SEARCH_MM * dotsPerMm(dpi)), label, keep);
}

/** محدِّد ورقة النموذج (FormInvoice في rep/printPreprinted.tsx، وورقة معايرة النموذج النقطية في lib/print/formCalibration.ts) */
const FORM_SHEET_SELECTOR = '[data-form-sheet]';

/**
 * «نموذج الشركة المطبوع مسبقاً» على النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦): كل ورقة `[data-form-sheet]` في الجذر (نسخة FormInvoice أو
 * جسم وثيقة المعايرة) ⇒ صفحةٌ واحدة بمواضعها الفعلية. لا rasterPages: كان يصغّر الورقة 210 مم إلى حزمة 1440 نقطة (3.2٪)، ويتخطّى
 * البياض أوّل الصفحة التالية (فيضيع y المطلق)، ويُلحق سطر ترقيم — والنموذج مواضعه بالمم من ركن الورقة.
 *  · الالتقاط بعرض الورقة كاملاً بنقاط الطابعة: round(W × نقاط/مم) (1488 لـA4 — 1.875 نقطة لكل بكسل CSS) فلا تصغير؛
 *  · ثم formSheetRaster: الحزمة [x0, x0 + النقاط) في وسط الورقة (formReachX — بلا offsetXmm ولا هوامش) وحتى طول الورقة، وحبرٌ خارجها رفضٌ؛
 *  · شريط «نموذج اختبار» (formBannerHtml — مرساةٌ في الجذر خارج الأوراق) يُنقل أوّل الورقة الأولى فيُلتقط معها. الجذر نسخةٌ لهذا الاستدعاء.
 */
export async function formRasterPages(root: HTMLElement, p: PrintProfile, ui: DirectUi): Promise<RasterPage[]> {
  const reach = p.printer === 'impact' ? formReachX(p) : null;
  if (!reach || p.paper.lengthMm === null) throw new Error('raster: form sheets need an impact profile');
  const dpi = dpiOf(p);
  const dpm = dotsPerMm(dpi);
  const sheetDots = Math.round(p.paper.widthMm * dpm);
  // +ε: طولٌ بمضاعفٍ صحيح من البوصة (279.4 مم = 1980 نقطة) لا يخسر صفّاً بخطأ الفاصلة العائمة (كـgeometry)
  const band = { x0: Math.round(reach[0] * dpm), dots: p.paper.printableDots as number, maxRows: Math.floor(p.paper.lengthMm * dpm + 1e-9) };
  const sheets = Array.from(root.querySelectorAll<HTMLElement>(FORM_SHEET_SELECTOR));
  if (sheets.length === 0) throw new Error('raster: no form sheets');
  const banner = Array.from(root.children).find((c) => c.hasAttribute('data-form-banner'));
  if (banner) sheets[0].insertBefore(banner, sheets[0].firstChild);
  const pages: RasterPage[] = [];
  for (let i = 0; i < sheets.length; i++) {
    if (ui.signal?.aborted) break; // المستدعي يُرجع 'cancelled' (send يفحص الإشارة قبل أيّ بايت)
    pages.push(formSheetRaster(await captureElement(sheets[i], sheetDots), band, { dpi, size: p.options.qrSize }));
    ui.onProgress?.('prepare', (i + 1) / sheets.length);
  }
  return pages;
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

/** خيارات المهمة فوق القالب */
export interface EncodeOpts {
  /**
   * صفحات «نموذج الشركة المطبوع مسبقاً» على النقطية (formRasterPages — طلب المالك ١٣ نوفمبر ٢٠٢٦): الصفّ 0 أوّل سطرٍ تطبعه الإبرة
   * والعمود 0 أوّل ما تبلغه، فلا هامش علويّ ولا إزاحة من القالب (المعايرة dxMm/dyMm وحدها، داخل الصورة) — وتقسيم الأشرطة على
   * فجواتها البيضاء (FORM_SEGMENT_GAP_DOTS). للنقطية وحدها.
   */
  form?: boolean;
}

/**
 * بايتات المهمة وأمر إلغائها بحسب نوع الطابعة — الهامش العلوي والإزاحة وطول الصفحة والقصّ من القالب. والحرارية بلغة جهازها:
 * ESC/POS افتراضاً، أو TSPL (`lang`) لطابعات الملصقات — الصورة نفسها بأوامرٍ أخرى.
 */
export function encodeForProfile(
  p: PrintProfile, copies: RasterPage[][], device: { lang?: 'tspl'; tsplFlip?: boolean } = {}, opts: EncodeOpts = {},
): { job: EncodedJob; cancel: readonly number[]; kind: 'escpos' | 'escp24' | 'tspl' } {
  // صفحات النموذج بعرض حزمة الإبرة ومن أوّل سطرٍ لها: على غير النقطية تقع في غير موضعها — خطأ برمجيّ لا طباعة
  if (opts.form && p.printer !== 'impact') throw new Error('raster: form job on a non-impact profile');
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
        // النموذج: هامش القالب وإزاحته يُهملان (formReachX في الوسط بلا offsetXmm) — والمهمة بلا مفتاح التقسيم غيره كما كانت حرفاً
        topDots: opts.form ? 0 : Math.round(g.marginTopMm * dpm),
        leftDots: opts.form ? 0 : impactLeftDots(offsetDots, widest),
        draft: p.options.graphicsQuality === 'draft',
        ...(opts.form ? { segmentGapDots: FORM_SEGMENT_GAP_DOTS } : {}),
      }),
      // المتصل: لا ESC @ يمحو طول الصفحة فتنزاح النماذج التالية (escp24.ts)
      cancel: escp24Cancel(continuous, continuous ? g.paperLengthMm : null),
      kind: 'escp24',
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
      kind: 'tspl',
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
    kind: 'escpos',
  };
}

/** صفحات النسخ إلى الطابعة بطريقها — مُصدَّرة لاختبار التوزيع (printDirect.test.ts) */
export async function send(port: DirectLink, p: PrintProfile, copies: RasterPage[][], ui: DirectUi, opts: EncodeOpts = {}): Promise<DirectOutcome> {
  if (ui.signal?.aborted) return 'cancelled';
  const { job, cancel, kind } = encodeForProfile(p, copies, { lang: ui.lang, tsplFlip: ui.tsplFlip }, opts);
  if (isIosLink(port)) return sendViaIos(port, { kind, bytes: job.bytes, marks: job.marks, cancel, slow: !!ui.slow, label: ui.docLabel ?? '' }, ui);
  if (isAppLink(port)) return sendViaApp(port, { kind, bytes: job.bytes, marks: job.marks, cancel, slow: !!ui.slow, label: ui.docLabel ?? '' }, ui);
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
export async function printHtmlDirect(port: DirectLink, html: string, p: PrintProfile, kind: 'copies' | 'pages', ui: DirectUi): Promise<DirectOutcome> {
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
 * صفحة معايرة «نموذج الشركة» على النقطية (buildFormCalibration — ورقةٌ بـdata-form-sheet): الوثيقة في إطارٍ خارج الشاشة بعرض الورق،
 * ثم أوراقها بمسار النموذج نفسه (formRasterPages) — فتقع المسطرتان والصناديق حيث ستقع قيم الفاتورة تماماً، لا بمسار الصفحات العام.
 */
export async function printFormHtmlDirect(port: DirectLink, html: string, p: PrintProfile, ui: DirectUi): Promise<DirectOutcome> {
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
    const pages = await formRasterPages(idoc.body, p, ui);
    if (ui.signal?.aborted) return 'cancelled';
    return await send(port, p, [pages], ui, { form: true });
  } finally {
    iframe.remove();
  }
}

/**
 * قالب صفحة/نقطية مرسوم خارج الشاشة: كل نسخةٍ نسخةُ العقدة بوسمها (cloneWithLabel — كنظام الطباعة) تُلحق بجانبها مؤقّتاً
 * فتُلتقط بأنماطها، ثم تُزال. الوسمان مترجمان (null بلا وسم)، وbannerHtml للطباعة التجريبية.
 */
export async function printNodeDirect(
  port: DirectLink, node: HTMLElement, p: PrintProfile, labels: readonly [string, string] | null, ui: DirectUi, bannerHtml?: string | null,
): Promise<DirectOutcome> {
  ui.onProgress?.('prepare', 0);
  // الشعار والتوقيع قبل الالتقاط؛ صورة الرمز لا تلزم (تُعاد رسمته من خانته)
  await sheetReady(node);
  const host = node.parentElement;
  if (!host) throw new Error('raster: detached sheet');
  // «نموذج الشركة المطبوع مسبقاً» على النقطية: أوراقه بمسار النموذج (formRasterPages) مرّةً واحدة — cloneWithLabel لا يضع وسم نسخةٍ
  // على النموذج فالنسخ متطابقة (كنظام الطباعة: copiesOf بلا وسوم) — ثم مهمة النموذج (بلا هامشٍ ولا إزاحة، وأشرطةٌ مقسّمة)
  if (p.printer === 'impact' && isFormSheet(node)) {
    const clone = cloneWithLabel(node, null, bannerHtml);
    host.appendChild(clone);
    let pages: RasterPage[];
    try {
      pages = await formRasterPages(clone, p, ui);
    } finally {
      clone.remove();
    }
    if (ui.signal?.aborted) return 'cancelled';
    const n = copiesOf(() => '', p.options.copies, null).length;
    return send(port, p, Array.from({ length: n }, () => pages), ui, { form: true });
  }
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
