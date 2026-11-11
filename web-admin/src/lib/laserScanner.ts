/**
 * «قارئ الباركود الليزر» (طلب المالك ١١ نوفمبر ٢٠٢٦ — شركةٌ مشتركة تستخدم قارئ ليزر لا الكاميرا).
 *
 * قارئ الليزر — مدمجٌ في جهازٍ يدوي (Sunmi/Zebra/Urovo/Honeywell) أو بلوتوث/USB — يتصرّف كلوحة مفاتيح: يكتب أرقام الباركود
 * بسرعةٍ لا يبلغها إنسان (أقل من ~٥٠ جزءاً من الثانية بين الحرفين) ثم يضغط Enter. فالكاشف هنا يميّز «دفعةً» سريعةً تنتهي
 * بـEnter (أو Tab) من كتابة الإنسان، بلا حقلٍ مركَّز ولا نافذة كاميرا.
 *
 * ⚠️ فخّ لوحة المفاتيح العربية (والفرنسية AZERTY): القارئ يرسل **مواضع مفاتيح** (رموز HID بتخطيط US) لا حروفاً، والنظام
 * يترجمها بلغة لوحة المفاتيح النشطة — فباركود Code128 «AB12» يصل «شلا12» بالعربية، و«1» يصل «&» بالفرنسية. لذا الحرف
 * يُقرأ من `event.code` (الموضع الفعلي بتخطيط US) أولاً، ومن `event.key` احتياطاً حين يغيب الموضع (أحداثٌ يحقنها نظام
 * أندرويد بلا scancode) — والأرقام الهندية (٠-٩) تُردّ لاتينية. إلا الأرقام: `event.key` يُصدَّق إن كان رقماً (قارئٌ مضبوطٌ
 * على تخطيط الجهاز نفسه يرسل Shift+موضع الرقم على AZERTY والعربية ١٠٢، فيقرؤه تخطيط US «!@#»).
 */

/** ما يلزم الكاشف من حدث لوحة المفاتيح (KeyboardEvent يطابقه) — حتى يُختبر بلا DOM */
export interface WedgeKey {
  key: string;
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  /** تكرار المفتاح المضغوط طويلاً: القارئ لا يكرّر، والإنسان الضاغط على «1» يولّد «1111» سريعةً — تُرفض دائماً */
  repeat?: boolean;
  timeStamp: number;
}

export interface WedgeOptions {
  /** أطول فاصلٍ بين حرفين متتاليين في الدفعة (ms) */
  maxGapMs?: number;
  /** أقصر باركود يُقبل عند Enter */
  minLength?: number;
  /** دفعةٌ بلا Enter (قارئٌ مضبوطٌ بلا لاحقة) تُقبل بعد سكونٍ قصير إن بلغت هذا الطول — أطول من minLength احتياطاً */
  idleMinLength?: number;
}

export const WEDGE_DEFAULTS: Required<WedgeOptions> = { maxGapMs: 50, minLength: 4, idleMinLength: 8 };

const US_SHIFTED: Record<string, [string, string]> = {
  Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], Backquote: ['`', '~'],
  Space: [' ', ' '],
};
const DIGIT_SHIFTED = [')', '!', '@', '#', '$', '%', '^', '&', '*', '('];
const NUMPAD: Record<string, string> = {
  NumpadDecimal: '.', NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/',
};
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** الأرقام الهندية والفارسية إلى لاتينية */
export function latinDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    const e = EASTERN_INDIC.indexOf(ch);
    out += a >= 0 ? String(a) : e >= 0 ? String(e) : ch;
  }
  return out;
}

/**
 * حرف المفتاح كما قصده القارئ (تخطيط US) — أو null لمفتاحٍ ليس حرفاً (Shift وBackspace والأسهم…).
 * الموضع أولاً (event.code) فلا تفسده لغة لوحة المفاتيح، ثم event.key إن كان حرفاً واحداً.
 * وموضع الرقم: event.key إن كان رقماً — قارئٌ بتخطيط الجهاز (Shift+Digit1 على AZERTY يكتب «1») — وإلا تخطيط US
 * (قارئٌ بتخطيط US على جهازٍ فرنسي: Digit1 يكتب «&» والمقصود «1»).
 */
export function wedgeChar(e: Pick<WedgeKey, 'key' | 'code' | 'shiftKey'>): string | null {
  const code = e.code || '';
  const shift = !!e.shiftKey;
  const k = e.key || '';
  const one = [...k].length === 1 ? latinDigits(k) : '';
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return shift ? m[1] : m[1].toLowerCase();
  m = /^Digit([0-9])$/.exec(code);
  if (m) return /^[0-9]$/.test(one) ? one : shift ? DIGIT_SHIFTED[Number(m[1])] : m[1];
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return m[1];
  if (NUMPAD[code]) return NUMPAD[code];
  if (US_SHIFTED[code]) return US_SHIFTED[code][shift ? 1 : 0];
  // بلا موضعٍ معروف: الحرف نفسه إن كان واحداً (أحداث أندرويد المحقونة، لوحاتٌ بلا code)
  return one || null;
}

const TERMINATORS = new Set(['Enter', 'NumpadEnter', 'Tab']);
/** LF/CR بصيغة Ctrl+J/Ctrl+M (جدول Zebra لـUSB) — خاتمٌ ثانٍ بعد Enter */
const isCtrlBreak = (e: WedgeKey) =>
  !!e.ctrlKey && !e.altKey && !e.metaKey && (e.code === 'KeyJ' || e.code === 'KeyM' || /^[jm]$/i.test(e.key));

/**
 * نافذة الدفعة (3×maxGapMs): تأخّر القارئ المحتمل (تقطّع البلوتوث، أو لاحقةٌ متأخّرة). Enter فيها بعد آخر حرفٍ يختم الدفعة،
 * وحرفٌ فيها بعد فاصلٍ أطول من maxGapMs «تعثّر» داخل الدفعة نفسها، ولا يُحسم سكونٌ (قبولٌ بلا لاحقة أو إسقاط) قبل انقضائها.
 */
export const burstWindowMs = (maxGapMs: number = WEDGE_DEFAULTS.maxGapMs) => maxGapMs * 3;

export type WedgeResult =
  | { kind: 'none' }
  /** أول حرفٍ في دفعةٍ جديدة — keydown يسبق إدخاله، فهي لحظة حفظ قيمة الحقل المركَّز قبل أن يصله شيء */
  | { kind: 'start' }
  /** دفعةٌ اكتملت: code الباركود، وconsume = أوقف المفتاح الخاتم (Enter) كي لا يرسل نموذجاً أو يختار خياراً */
  | { kind: 'scan'; code: string; consume: boolean }
  /** دفعة قارئٍ تعثّرت (توقّفٌ وسطها أو قبل خاتمها): لا تُقبل أبداً — يُوقف خاتمها ويُنبَّه بالفشل فيعيد المستخدم المسح */
  | { kind: 'broken' }
  /** خاتمٌ ثانٍ يلي مسحاً انتهى للتوّ (CR+LF، Tab+Enter): يُوقف كي لا يضغط زرّاً مركَّزاً */
  | { kind: 'swallow' };

export interface WedgeDetector {
  /** يُغذّى بكل keydown — ويعيد «scan» عند Enter يختم دفعةً صالحة */
  key(e: WedgeKey): WedgeResult;
  /** يُستدعى بعد سكونٍ أطول من نافذة الدفعة: دفعةٌ بلا Enter بلغت idleMinLength تُقبل، والمتعثّرة «broken» */
  idle(now: number): WedgeResult;
  /** طول الدفعة الجارية (0 = لا دفعة) */
  pending(): number;
  reset(): void;
}

/**
 * آلة الحالة: الحروف تتراكم ما دامت متقاربة (≤ maxGapMs). Enter في نافذة الدفعة بعد آخر حرف يختم دفعةً بطول minLength
 * فأكثر. وأي مفتاح تحكّم (Ctrl/Alt/Meta) أو مفتاحٍ غير حرفي (Backspace…) أو تكرار يُسقط الدفعة. Shift وحده لا يُحسب ولا
 * يُسقط (القارئ يرسله قبل الحرف الكبير، أحياناً تقريراً مستقلاً فيُحسب توقيته من الدفعة).
 *
 * والتعثّر يُغلق لا يُفتح: فاصلٌ بين maxGapMs ونافذة الدفعة لا يبدأ دفعةً جديدة من الذيل (ذيلٌ كـ«0123456» قد يطابق كود صنفٍ
 * آخر فيُضاف خطأً بنغمة نجاح) — تبقى الدفعة واحدةً موسومةً متعثّرة، وإن كان فيها جريٌ سريع بطول minLength (أي قارئٌ لا
 * إنسان) فخاتمها «broken» وسكونها «broken»، لا مسح. والفاصل الأطول من النافذة يبدأ دفعةً جديدة (مفتاح إنسانٍ قبل المسح).
 */
export function createWedgeDetector(opts: WedgeOptions = {}): WedgeDetector {
  const o = { ...WEDGE_DEFAULTS, ...opts };
  const win = burstWindowMs(o.maxGapMs);
  let buf = '';
  let last = -Infinity;
  let run = 0; // الجري السريع الحالي (فواصل ≤ maxGapMs)
  let longest = 0; // أطول جريٍ سريع: بلوغه minLength علامة القارئ — كتابة الإنسان السريعة أزواجٌ لا تبلغه
  let stalled = false;
  let lastEnd = -Infinity; // ختام آخر مسح (أو دفعةٍ متعثّرة) — يبقى بعد reset لابتلاع الخاتم الثاني

  const reset = () => { buf = ''; last = -Infinity; run = 0; longest = 0; stalled = false; };
  const stall = () => { stalled = true; run = 0; };

  return {
    key(e) {
      const t = e.timeStamp;
      if (e.key === 'Shift' || e.key === 'CapsLock') {
        // Shift تقريراً مستقلاً بين حرفين: نبضةٌ من الدفعة (وإلا تجاوز الحرف الكبير بعده الفاصل) — لا الضغط الطويل المتكرّر
        if (buf && !e.repeat && t - last <= win) { if (t - last > o.maxGapMs) stall(); last = t; }
        return { kind: 'none' };
      }
      if (!buf && t - lastEnd <= win && isCtrlBreak(e)) { lastEnd = t; return { kind: 'swallow' }; }
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) { reset(); return { kind: 'none' }; }
      if (TERMINATORS.has(e.key) || TERMINATORS.has(e.code || '')) {
        if (!buf) {
          if (t - lastEnd > win) return { kind: 'none' };
          lastEnd = t;
          return { kind: 'swallow' };
        }
        const inWin = t - last <= win;
        const code = buf;
        const clean = !stalled && buf.length >= o.minLength;
        // «متعثّرة» تُمسح ويُبلَّغ عنها بجريٍ سريعٍ طويل وحده (idleMinLength): الكاتب السريع يبلغ ٤ مفاتيح متلاحقة أحياناً
        // (تداخل الأصابع، أو حزم سطح المكتب البعيد) فلا يُمحى ما كتبه — والذيل لا يُقبل مسحاً في الحالين
        const scanLike = longest >= o.idleMinLength;
        reset();
        if (inWin && clean) { lastEnd = t; return { kind: 'scan', code, consume: true }; }
        if (inWin && scanLike) { lastEnd = t; return { kind: 'broken' }; }
        return { kind: 'none' };
      }
      const ch = wedgeChar(e);
      if (ch === null) { reset(); return { kind: 'none' }; }
      let start = !buf;
      if (buf && t - last > win) { reset(); start = true; }
      else if (buf && t - last > o.maxGapMs) stall();
      buf += ch;
      run += 1;
      if (run > longest) longest = run;
      last = t;
      return start ? { kind: 'start' } : { kind: 'none' };
    },
    idle(now) {
      // داخل النافذة قد يصل حرفٌ متأخّر أو Enter: لا قبول ولا إسقاط قبل انقضائها
      if (!buf || now - last <= win) return { kind: 'none' };
      const code = buf;
      const wasStalled = stalled;
      const scanLike = longest >= o.idleMinLength;
      reset();
      // نصٌّ بمسافات (مُوسِّع نصوص يحقن مفاتيحه سريعةً) ليس باركوداً: يبقى حيث كُتب
      if (/\s/.test(code)) return { kind: 'none' };
      if (wasStalled) {
        if (!scanLike) return { kind: 'none' };
        lastEnd = now;
        return { kind: 'broken' };
      }
      if (code.length < o.idleMinLength) return { kind: 'none' };
      lastEnd = now;
      return { kind: 'scan', code, consume: false };
    },
    pending: () => buf.length,
    reset,
  };
}

/** تنظيف الباركود المقروء: مسافات الأطراف وأحرف التحكّم، والأرقام الهندية لاتينية */
export function cleanScan(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return latinDigits(String(raw ?? '')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

/** صنفٌ يُطابَق بالمسح: باركوده، ثم كوده الداخلي (شركاتٌ تطبع كود الصنف باركوداً) */
export interface ScanMatchable { barcode?: string | number | null; code?: string | number | null }

const stripZeros = (s: string) => s.replace(/^0+(?=\d)/, '');

/**
 * هل يطابق الصنفُ الباركودَ المقروء؟ تطابقٌ تام أولاً، ثم رقميّان بعد حذف الأصفار البادئة (UPC-A ذو ١٢ رقماً يقرؤه بعض
 * القرّاء EAN-13 بصفرٍ بادئ، والعكس) — والكود الداخلي بلا حساسية لحالة الحروف.
 */
export function barcodeMatches(p: ScanMatchable, rawCode: string): boolean {
  const code = cleanScan(rawCode);
  if (!code) return false;
  const bc = p.barcode == null ? '' : cleanScan(String(p.barcode));
  if (bc) {
    if (bc === code) return true;
    if (/^\d+$/.test(bc) && /^\d+$/.test(code) && stripZeros(bc) === stripZeros(code)) return true;
  }
  return false;
}

/** مطابقة الكود الداخلي للصنف (احتياطٌ بعد الباركود) */
export function codeMatches(p: ScanMatchable, rawCode: string): boolean {
  const code = cleanScan(rawCode);
  const c = p.code == null ? '' : cleanScan(String(p.code));
  return !!code && !!c && c.toLowerCase() === code.toLowerCase();
}

/**
 * طبقة مطابقة المسح: الباركود إن طابق **أيَّ** صنفٍ في القائمة الكاملة، وإلا الكود الداخلي. تُقرَّر على الأصناف كلها ثم يُبحث بها
 * في قائمةٍ مصفّاة (أصناف الفريق): فصاحب الباركود المستبعَد بالتصفية يُقال سببه، ولا يخطف مسحَه صنفٌ آخر كودُه يساوي الباركود.
 */
export function scanMatcher(
  all: readonly ScanMatchable[] | null | undefined,
  rawCode: string,
): (p: ScanMatchable, rawCode: string) => boolean {
  return (all ?? []).some(p => barcodeMatches(p, rawCode)) ? barcodeMatches : codeMatches;
}

/** الصنف المقصود بالمسح من قائمة: الباركود أولاً على القائمة كلها، ثم الكود — فباركودٌ يساوي كود صنفٍ آخر لا يخطفه */
export function findByScan<T extends ScanMatchable>(list: readonly T[] | null | undefined, rawCode: string): T | undefined {
  const all = list ?? [];
  const match = scanMatcher(all, rawCode);
  return all.find(p => match(p, rawCode));
}
