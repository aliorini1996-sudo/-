/**
 * مُرمِّز TSPL النقطيّ للطابعات الحرارية بلغة الملصقات (طلب المالك ٣١ أكتوبر ٢٠٢٦: طابعة العميل Rongta RPP04 — 4 إنش، 203 نقطة،
 * لغة أوامرها TSPL لا ESC/POS). نقيّ كـescpos.ts: صورةٌ أحادية اللون (raster.ts) تدخل وبايتات تخرج. مرجعه دليل TSC TSPL/TSPL2.
 *
 *   GAP 0,0                                 ورقٌ متصل (إيصالات) — لا فجوة بين «الملصقات» (ص٣)
 *   DIRECTION 0|1                           0: الصفّ الأوّل يخرج أوّلاً بلا انعكاس كـGS v 0 (ص١٢، VIII)؛ 1 لطابعةٍ يخرج عندها مقلوباً
 *   ┌ SIZE w mm,h mm                        «ملصق» بعرض الحزمة وطول المقطع — مم صحيحة (الطابعة تأخذ الجزء الصحيح من النقاط)
 *   │ CLS
 *   │ BITMAP 0,0,<بايتات الصفّ>,<الصفوف>,0,<بيانات>CRLF   البت 0 = نقطة سوداء (عكس GS v 0، ص٤٤)، والبت الأعلى يساراً
 *   └ PRINT 1,1                             لكل مقطع
 *   [FEED n]                                تغذيةٌ إضافية بالنقاط بعد كل نسخة
 *
 * الإيصال الطويل يُقسَم «ملصقات» متتالية بلا فجوة: الطابعات تحدّ طول الملصق الواحد. والقطع على صفٍّ أبيض لا داخل رمز QR ولا سطر
 * نصّ (splitPages — كصفحات الورق المقطع)، بمقاطع متقاربة الطول (لا ذيلٌ من صفٍّ واحد) — فدورة الطباعة بين ملصقين لا تشقّ رمزاً.
 */
import { ByteSink, type EncodedJob } from './byteSink';
import { splitPages, type Bitmap } from './raster';

/** أطول «ملصق» في الأمر الواحد: 2400 صفّ = 300 مم على 203 — أقلّ من حدّ طول الملصق في طابعات TSPL المحمولة */
export const TSPL_MAX_LABEL_ROWS = 2400;
/** نافذة البحث عن صفٍّ أبيض للقطع قبل الحدّ (12 مم كصفحات الورق) */
export const TSPL_CUT_SEARCH_MM = 12;
/** الإلغاء: الطابعة لا تطبع ما لم يصلها PRINT — والإلغاء يكمل بيانات الصورة الجارية ثم يقف قبله (byteSink.ts) */
export const TSPL_CANCEL: readonly number[] = Object.freeze([]);

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0x7f);

/** صفحةٌ للمُرمِّز: صورتها، وصفوف رموز QR فيها (لا قطع داخلها) */
export interface TsplPage {
  bitmap: Bitmap;
  qrRows?: ReadonlyArray<readonly [number, number]>;
}

export interface TsplJob {
  /** النسخ، ولكل نسخةٍ صفحاتها (الرول صفحة واحدة بطول محتواها وحشوته) */
  copies: ReadonlyArray<ReadonlyArray<TsplPage>>;
  /** نقاط لكل مم (8 على 203) — لتحويل العرض والطول إلى مم في SIZE */
  dotsPerMm: number;
  /** تغذيةٌ إضافية بعد كل نسخة بالنقاط */
  afterDots: number;
  /** DIRECTION 1 (دورانٌ 180°) لطابعةٍ يخرج عندها الورق مقلوباً — والمقاطع تُرسل من آخرها فيبقى الإيصال متّصلاً بترتيبه */
  flip: boolean;
  /** أقصى صفوف «الملصق» الواحد */
  maxRows?: number;
}

/** صفوف المقطع معكوسة البتات: TSPL يطبع البت 0 أسود — وبتات الحشو آخر الصفّ (0 في الصورة) تصير 1 أبيض */
export function tsplBitmapData(bm: Bitmap, from: number, to: number): Uint8Array {
  const src = bm.data.subarray(from * bm.rowBytes, to * bm.rowBytes);
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = ~src[i] & 0xff;
  return out;
}

/** مقاطع الصفحة [من، إلى): واحدٌ لما دون الحدّ، وإلا مقاطع متقاربة الطول تُقطع على صفٍّ أبيض لا داخل رمز */
export function tsplChunks(pg: TsplPage, maxRows: number, searchRows: number): Array<[number, number]> {
  const h = pg.bitmap.height;
  if (h <= maxRows) return h > 0 ? [[0, h]] : [];
  const per = Math.ceil(h / Math.ceil(h / maxRows));
  const chunks = splitPages(pg.bitmap, per, searchRows, pg.qrRows ?? []);
  // splitPages تُسقط البياض بعد كل قطع (صفحات الورق) — وذيل الإيصال الأبيض هامش القطع (حشوة القالب والتغذية) فيبقى
  const last = chunks[chunks.length - 1];
  if (last && last[1] < h) {
    if (h - last[0] <= maxRows) last[1] = h;
    else chunks.push([last[1], h]);
  }
  return chunks;
}

export function encodeTspl(job: TsplJob): EncodedJob {
  const sink = new ByteSink();
  const maxRows = Math.max(8, Math.floor(job.maxRows ?? TSPL_MAX_LABEL_ROWS));
  const dpm = job.dotsPerMm > 0 ? job.dotsPerMm : 8;
  const searchRows = Math.round(TSPL_CUT_SEARCH_MM * dpm);
  sink.append(ascii(`GAP 0,0\r\nDIRECTION ${job.flip ? 1 : 0}\r\n`)).mark();
  for (const pages of job.copies) {
    for (const pg of pages) {
      const bm = pg.bitmap;
      const chunks = tsplChunks(pg, maxRows, searchRows);
      if (job.flip) chunks.reverse();
      for (const [a, b] of chunks) {
        const rows = b - a;
        // مم صحيحة بالتقريب لأعلى: ملصقٌ لا يقصر عن صورته (الطابعة تأخذ الجزء الصحيح من النقاط)، وزيادته دون 1 مم بيضاء
        sink.append(ascii(`SIZE ${Math.ceil((bm.rowBytes * 8) / dpm)} mm,${Math.ceil(rows / dpm)} mm\r\nCLS\r\nBITMAP 0,0,${bm.rowBytes},${rows},0,`));
        sink.append(tsplBitmapData(bm, a, b));
        sink.append(ascii('\r\n')).mark();
        sink.append(ascii('PRINT 1,1\r\n')).mark();
      }
    }
    const after = Math.min(9999, Math.max(0, Math.round(job.afterDots)));
    if (after > 0) sink.append(ascii(`FEED ${after}\r\n`)).mark();
  }
  return sink.done();
}
