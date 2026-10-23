/**
 * مُرمِّز Epson ESC/P بإبر 24 للطابعة النقطية Tally Dascom MIP480 — «إعدادات الطباعة» M3، التصميم §3.3 الخطوة 5 و§3.5 و§3.7.
 * نقيّ ومختبرٌ بايتاً بايتاً (escp24.test.ts). يفترض محاكاة Epson ESC/P2 في لوحة الطابعة (لا IBM Proprinter).
 *
 * البداية:
 *   ESC @                                   تهيئة
 *   [الورق المتصل] ESC ( U 1 0 10           وحدة 1/360 بوصة…
 *                  ESC ( C 2 0 nL nH         …فطول الصفحة بها (297 مم = 4209 وحدة، انجرافٌ نحو 0.03 مم لكل صفحة)
 *                  ESC ( U 1 0 60           ثم الوحدة 1/60 بوصة من جديد — لماذا: في ESC/P2 يغيّر ESC ( U وحدة ESC $
 *                                            أيضاً، فلو بقيت 1/360 لوقع كل شريطٍ في سدس موضعه. وبعدها ESC $ بـ1/60 في
 *                                            ESC/P2 وفي ESC/P القديمة التي تتجاهل ESC ( (فطول الصفحة من لوحتها).
 * لكل شريط 24 صفّاً (24 إبرة = 24/180 بوصة):
 *   الأبيض كله ⇒ لا شيء — يُضاف 24 للتغذية المعلّقة، وتُرسل ESC J n (n ≤ 255، n/180 بوصة) قبل أوّل شريطٍ فيه حبر
 *   [ESC U 1]                               اتجاهٌ واحد لأشرطة رمز QR (لا تنزاح حواف الخلايا بين ذهابٍ وإياب)
 *   ESC $ nL nH                             بداية الحبر بعد قصّ الأعمدة البيضاء يساراً (1/60 بوصة = 3 نقاط، فتُقرَّب لأسفل لمضاعف 3)
 *   ESC * 39 nL nH <3 بايت لكل عمود>        180 نقطة/بوصة، البت الأعلى للإبرة العليا — حتى آخر عمودٍ فيه حبر
 *   (المسودة: ESC * 33 بـ120 نقطة/بوصة والأعمدة ثلثاها — ثلث بيانات أقل؛ وأشرطة الرمز تبقى 39 دائماً كي يُمسح)
 *   ثم تقدّم 24 يُدمج في التغذية المعلّقة (ESC J تطبع ما في ذاكرة السطر ثم تتقدّم)
 * نهاية الصفحة: [ESC U 0] ثم FF — للمتصل: إلى رأس الصفحة التالية بطولها المحدّد؛ وللمقطع: إخراج الورقة. والتغذية المعلّقة
 * بعد آخر شريطٍ تُهمل (FF يكفيها).
 *
 * وحيدةٌ عن التصميم بوعي: لا CR بعد الشريط. ESC $ مطلقٌ فلا حاجة لإرجاع العربة، وفي لوائح الإبرية خيار «CR = CR+LF»
 * لو كان مفعّلاً لفصل سطرٌ فارغ بين كل شريطين فتتمزّق الصورة.
 *
 * وما وراء سطر الطباعة 8.0 بوصة (1440 نقطة) **يُرفض لا يُقصّ**: الطابعة تلفّه سطراً جديداً فيفسد ما بعده، وقصّه صامتاً كان يُسقط
 * اسم البائع أو رقمه الضريبي أو طرف رمز QR المختوم من ورقةٍ تبدو سليمة. فحبرٌ وراء السطر ⇒ PrintRefusedError (رسالة الرمز
 * لأشرطة الرمز، ورسالة سطر الطباعة لغيرها) وملف PDF يبقى. والقالب لا يصل هنا كذلك أصلاً: printSettingsCore يرفض حزمةً
 * أو إزاحةً تتجاوز السطر، وprintDirect.ts يقصر الإزاحة على ما بقي منه.
 *
 * الإلغاء (escp24Cancel): الورق المقطع ESC @ ثم FF. والمتصل ESC U 0 ثم FF بلا ESC @ — التهيئة تعيد طول الصفحة لقيمة اللوحة
 * فيقف FF على غير رأس النموذج التالي وتنزاح النماذج بعده؛ ولا ESC ( C من جديد: إرساله في منتصف الصفحة يجعل الموضع الحاليّ
 * رأس الصفحة (Epson ESC/P2). فطول المهمة يبقى، وFF يطبع ما في ذاكرة السطر ثم يقف على رأس النموذج التالي.
 */
import { ByteSink, feedCommands, type EncodedJob } from './byteSink';
import { dotAt, inkColumns, type Bitmap } from './raster';
import { PRINT_ISSUES, PRINT_WARNINGS } from './printSettings';
import { PrintRefusedError } from './printErrors';

export const ESCP24_DPI = 180;
export const ESCP24_BAND_ROWS = 24;
/** سطر الطباعة في MIP480: 8.0 بوصة = 80 عموداً على 10 حروف/بوصة = 1440 نقطة على 180 */
export const ESCP24_LINE_DOTS = 1440;
/** إلغاء الورق المقطع: تهيئة ثم إخراج الورقة — بعد اكتمال الشريط الجاري (byteSink.ts) */
export const ESCP24_CANCEL: readonly number[] = Object.freeze([0x1b, 0x40, 0x0c]);
/** إلغاء الورق المتصل: إلغاء الاتجاه الواحد ثم FF — بلا ESC @ يمحو طول الصفحة (انظر رأس الملف) */
export const ESCP24_CANCEL_CONTINUOUS: readonly number[] = Object.freeze([0x1b, 0x55, 0x00, 0x0c]);

const ESC = 0x1b;
const FF = 0x0c;

/**
 * أمر الإلغاء بحسب الورق: المتصل الذي أرسلت المهمة طول صفحته ⇒ ESC U 0 ثم FF (الطول يبقى فيقف FF على رأس النموذج التالي)؛
 * وغيره (المقطع، أو متصلٌ بطول اللوحة) ⇒ ESC @ ثم FF كما كان.
 */
export function escp24Cancel(continuous: boolean, pageLengthMm: number | null): readonly number[] {
  return continuous && pageLengthMm !== null ? ESCP24_CANCEL_CONTINUOUS : ESCP24_CANCEL;
}

/** مم ⇒ وحدات 1/360 بوصة (ESC ( C) */
export const units360 = (mm: number): number => Math.round((mm / 25.4) * 360);

/** أوامر الوحدة وطول الصفحة للورق المتصل (انظر رأس الملف) */
export function escpPageLength(mm: number): number[] {
  const n = Math.max(1, Math.min(0xffff, units360(mm)));
  return [
    ESC, 0x28, 0x55, 0x01, 0x00, 10,
    ESC, 0x28, 0x43, 0x02, 0x00, n & 0xff, (n >> 8) & 0xff,
    ESC, 0x28, 0x55, 0x01, 0x00, 60,
  ];
}

/** ESC $ — الموضع الأفقيّ المطلق بوحدات 1/60 بوصة من الهامش الأيسر */
export const escpAbsX = (units60: number): number[] => [ESC, 0x24, units60 & 0xff, (units60 >> 8) & 0xff];

/** بايتات الأعمدة [x0, x1] لشريط يبدأ بالصفّ y: ثلاثة لكل عمود، البت 7 من الأوّل للصفّ y */
export function band24Columns(bm: Bitmap, y: number, x0: number, x1: number): Uint8Array {
  const n = Math.max(0, x1 - x0 + 1);
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = x0 + i;
    for (let r = 0; r < ESCP24_BAND_ROWS; r++) {
      if (dotAt(bm, x, y + r)) out[i * 3 + (r >> 3)] |= 0x80 >> (r & 7);
    }
  }
  return out;
}

/** المسودة: 120 نقطة/بوصة — العمود j يجمع (OR) العمودين اللذين يغطّيهما من 180 فلا يضيع خطٌّ رفيع */
export function band24Draft(bm: Bitmap, y: number, x0: number, x1: number): Uint8Array {
  const src = band24Columns(bm, y, x0, x1);
  const nSrc = src.length / 3;
  const n = Math.ceil((nSrc * 2) / 3);
  const out = new Uint8Array(n * 3);
  for (let j = 0; j < n; j++) {
    const a = Math.floor(j * 1.5);
    for (const s of [a, a + 1]) {
      if (s >= nSrc) continue;
      for (let k = 0; k < 3; k++) out[j * 3 + k] |= src[s * 3 + k];
    }
  }
  return out;
}

export interface EscP24Page {
  bitmap: Bitmap;
  qrRows: ReadonlyArray<readonly [number, number]>;
}

export interface EscP24Job {
  /** النسخ (مرّات طباعة كاملة)، ولكلٍّ صفحاتها — الكربون يعطي نسخه في مرور واحد فالافتراضي نسخة */
  copies: ReadonlyArray<ReadonlyArray<EscP24Page>>;
  /** ورق متصل: يُرسل طول الصفحة (ESC ( C) */
  continuous: boolean;
  pageLengthMm: number | null;
  /** الهامش العلوي بالنقاط (1/180) من رأس الصفحة */
  topDots: number;
  /** إزاحة الحزمة يميناً بالنقاط — تُقرَّب لمضاعف 3 (وحدة ESC $) */
  leftDots: number;
  draft: boolean;
}

export function encodeEscP24(job: EscP24Job): EncodedJob {
  const sink = new ByteSink();
  sink.push(ESC, 0x40);
  if (job.continuous && job.pageLengthMm !== null) sink.push(...escpPageLength(job.pageLengthMm));
  sink.mark();
  const left = Math.max(0, Math.min(ESCP24_LINE_DOTS - 3, Math.round(job.leftDots / 3) * 3));
  const lastCol = ESCP24_LINE_DOTS - 1 - left;
  for (const pages of job.copies) {
    for (const page of pages) {
      const bm = page.bitmap;
      let pending = Math.max(0, Math.round(job.topDots));
      let uni = false;
      for (let y = 0; y < bm.height; y += ESCP24_BAND_ROWS) {
        const span = inkColumns(bm, y, y + ESCP24_BAND_ROWS);
        if (!span) { pending += ESCP24_BAND_ROWS; continue; }
        const qr = page.qrRows.some(([a, b]) => a < y + ESCP24_BAND_ROWS && b > y);
        // حبرٌ وراء سطر الطباعة: رفضٌ لا قصّ (رأس الملف) — قبل أن يُرسل بايتٌ واحد، فلا ورقةٌ ناقصة
        if (span[1] > lastCol) throw new PrintRefusedError(qr ? PRINT_WARNINGS.qrNoFit : PRINT_ISSUES.impactLine);
        if (pending) { sink.push(...feedCommands(pending)); pending = 0; }
        if (qr !== uni) { sink.push(ESC, 0x55, qr ? 1 : 0); uni = qr; }
        const start = Math.floor(span[0] / 3) * 3;
        sink.push(...escpAbsX((left + start) / 3));
        if (job.draft && !qr) {
          const data = band24Draft(bm, y, start, span[1]);
          const n = data.length / 3;
          sink.push(ESC, 0x2a, 33, n & 0xff, (n >> 8) & 0xff).append(data);
        } else {
          const data = band24Columns(bm, y, start, span[1]);
          const n = data.length / 3;
          sink.push(ESC, 0x2a, 39, n & 0xff, (n >> 8) & 0xff).append(data);
        }
        sink.mark();
        pending = ESCP24_BAND_ROWS;
      }
      if (uni) sink.push(ESC, 0x55, 0);
      sink.push(FF).mark();
    }
  }
  return sink.done();
}
