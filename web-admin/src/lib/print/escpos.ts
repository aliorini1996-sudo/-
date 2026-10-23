/**
 * مُرمِّز ESC/POS النقطيّ للطابعات الحرارية بالبلوتوث (PRO-V وطابعات 58/80/85 مم وA4 الحرارية) — «إعدادات الطباعة» M3،
 * التصميم §3.3 الخطوة 5. نقيّ: صورةٌ أحادية اللون (raster.ts) تدخل وبايتات تخرج، ومختبرٌ بايتاً بايتاً (escpos.test.ts).
 *
 *   ESC @                                   تهيئة
 *   [ESC J n]…                              تغذية بالنقاط (الهامش العلوي والصفوف البيضاء الطويلة) n ≤ 255
 *   GS v 0 0 xL xH yL yH <بيانات>           شريط صورة ≤ 255 صفّاً، الصفّ ceil(النقاط÷8) بايتاً والبت الأعلى يساراً
 *   [ESC J n]…                              التغذية بعد النسخة (الهامش السفلي والتغذية — من حشوة القالب)
 *   [GS V 66 0]                             قصّ جزئيّ بعد التغذية لموضع القاطع (إن كان للطابعة قاطع)
 *
 * وحيدةٌ عن التصميم بوعي: التغذية بـESC J (بالنقاط، 0.125 مم على 203) لا ESC d (بالأسطر، وطول السطر يختلف بين الطابعات) —
 * فالهامش والتغذية بالمم كما كتبتهما الشركة. والصفوف البيضاء القصيرة (أقل من 32 صفّاً، 4 مم) تبقى داخل الصورة: أوامر
 * كثيرة صغيرة أبطأ من أصفارٍ قليلة، وبعض الطابعات الرخيصة تترك فراغاً بين أمرين.
 *
 * الورق المقطع (A4 الحراري): كل صفحةٍ هامشها العلوي ثم محتواها ثم تغذيةٌ تكمل طولها — فتبدأ التالية من رأس الورقة التالية.
 */
import { ByteSink, feedCommands, type EncodedJob } from './byteSink';
import { rowBlank, type Bitmap } from './raster';

export const ESCPOS_MAX_BAND_ROWS = 255;
/** أقصر شريطٍ أبيض يصير تغذيةً بدل صفوفٍ صفرية داخل الصورة */
export const ESCPOS_MIN_GAP_ROWS = 32;
/** الإلغاء: تهيئةٌ تفرغ ما بقي في ذاكرة الطابعة — بعد اكتمال الشريط الجاري (byteSink.ts) */
export const ESCPOS_CANCEL: readonly number[] = Object.freeze([0x1b, 0x40]);

export const escposInit = (): number[] => [0x1b, 0x40];
export const escposCut = (): number[] => [0x1d, 0x56, 0x42, 0x00];

/** رأس شريط GS v 0 (الوضع العادي) لعرضٍ بالبايتات وارتفاعٍ بالصفوف */
export function escposRasterHeader(rowBytes: number, rows: number): number[] {
  return [0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, (rowBytes >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff];
}

export interface EscPosJob {
  /** النسخ، ولكل نسخةٍ صفحاتها (الرول صفحة واحدة بطول محتواها وحشوته) */
  copies: ReadonlyArray<ReadonlyArray<Bitmap>>;
  /** تغذيةٌ قبل كل صفحة (الهامش العلوي للورق المقطع؛ الرول يحمله في حشوة الصورة) */
  topDots: number;
  /** تغذيةٌ إضافية بعد كل نسخة */
  afterDots: number;
  /** الورق المقطع: طول الصفحة كاملاً بالنقاط (تُكمَّل إليه) — null للرول */
  pageRows: number | null;
  /** قصٌّ بعد كل نسخة */
  cut: boolean;
  /** أقصى صفوف الشريط (≤ 255) */
  bandRows?: number;
}

/** مقاطع الصفحة: [بداية، نهاية، أبيض؟] — الأبيض في الطرفين تغذيةٌ بأيّ طول، وفي الوسط من ESCPOS_MIN_GAP_ROWS */
export function escposSegments(bm: Bitmap, minGap = ESCPOS_MIN_GAP_ROWS): Array<[number, number, boolean]> {
  const runs: Array<[number, number, boolean]> = [];
  for (let y = 0; y < bm.height; y++) {
    const blank = rowBlank(bm, y);
    const last = runs[runs.length - 1];
    if (last && last[2] === blank) last[1] = y + 1;
    else runs.push([y, y + 1, blank]);
  }
  // شريطٌ أبيض قصير بين حبرين يُضمّ للصورة
  const out: Array<[number, number, boolean]> = [];
  runs.forEach((r, i) => {
    const inner = i > 0 && i < runs.length - 1;
    const keepAsImage = r[2] && inner && r[1] - r[0] < minGap;
    const seg: [number, number, boolean] = [r[0], r[1], r[2] && !keepAsImage];
    const prev = out[out.length - 1];
    if (prev && !prev[2] && !seg[2]) prev[1] = seg[1];
    else out.push(seg);
  });
  return out;
}

export function encodeEscPos(job: EscPosJob): EncodedJob {
  const sink = new ByteSink();
  const band = Math.max(1, Math.min(ESCPOS_MAX_BAND_ROWS, Math.floor(job.bandRows ?? ESCPOS_MAX_BAND_ROWS)));
  sink.push(...escposInit()).mark();
  for (const pages of job.copies) {
    for (const bm of pages) {
      let pending = Math.max(0, Math.round(job.topDots));
      for (const [a, b, blank] of escposSegments(bm)) {
        if (blank) { pending += b - a; continue; }
        if (pending) { sink.push(...feedCommands(pending)).mark(); pending = 0; }
        for (let y = a; y < b; y += band) {
          const rows = Math.min(band, b - y);
          sink.push(...escposRasterHeader(bm.rowBytes, rows));
          sink.append(bm.data.subarray(y * bm.rowBytes, (y + rows) * bm.rowBytes)).mark();
        }
      }
      // الورق المقطع: ما بقي من طول الصفحة بعد هامشها وصفوفها (البيضاء الأخيرة منها في التغذية المعلّقة أصلاً) —
      // فتقدّم الورقة = طول الصفحة تماماً. والصفحة الأطول (لا تقع: التقسيم بحدّها) لا تُقصّ
      if (job.pageRows !== null) pending += Math.max(0, job.pageRows - Math.max(0, Math.round(job.topDots)) - bm.height);
      if (pending) sink.push(...feedCommands(pending)).mark();
    }
    if (job.afterDots > 0) sink.push(...feedCommands(job.afterDots)).mark();
    if (job.cut) sink.push(...escposCut()).mark();
  }
  return sink.done();
}
