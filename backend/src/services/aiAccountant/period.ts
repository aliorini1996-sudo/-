/**
 * «المحاسب الذكي AI» — فترة السؤال بأيام الشركة المحلية (المواصفة §٣.٣).
 *
 * «شهر 11» = [١ نوفمبر، ١ ديسمبر) بتوقيت الشركة لا UTC: الحدّان لحظتا منتصف ليل الشركة (gl/dates.ts zonedStartOfDay)،
 * فلا تنزاح فاتورة الحادية عشرة ليلاً إلى الشهر التالي. ⚠️ صفحات التقارير التشغيلية القائمة تقرأ 'YYYY-MM-DD' منتصفَ ليل UTC،
 * فقد يختلف مجموعٌ عنها بما وقع بين ٠٠:٠٠ و٠٣:٠٠ (الرياض) — يُذكر للمستخدم إن سأل عن المطابقة.
 *
 * دالّةٌ صرفة بلا قاعدة: النموذج يمرّر النصّ كما فهمه (أرقام هندية، «11»، «2026/11/5»)، والخادم وحده يقرّر الحدود.
 */
import { addDays, endOfMonth, formatLocalDate, isLocalDate, startOfMonth, zonedStartOfDay } from '../gl/dates';

/** فترة مقرَّرة: النصّان المحليّان للعرض، واللحظتان [gte, lt) للاستعلام */
export interface AcctPeriod { fromLocal: string; toLocal: string; gte: Date; lt: Date }

/** أطول فترة تقبلها أدوات التشغيل (≈ ثلاث سنوات) — سؤالٌ أوسع يُقسَّم، فلا يسحب استعلامٌ واحد تاريخ الشركة كله */
export const MAX_PERIOD_DAYS = 1100;

const DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/** توحيد نصّ تاريخ: الأرقام الهندية/الفارسية لاتينية، والفواصل (/ . ‏_) شَرطة، وبلا مسافات */
function norm(v: string | undefined | null): string {
  if (v == null) return '';
  return String(v)
    .trim()
    .replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d] ?? d)
    .replace(/[\\/._\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 'YYYY-M-D' أو 'YYYY-MM-DD' ⇒ تاريخ محلي صالح، وإلا null */
function localDateOf(raw: string): string | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (!m) return null;
  const s = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return isLocalDate(s) ? s : null;
}

/** الشهر: 'YYYY-MM' أو 'MM-YYYY' أو 'MM' وحده ⇒ {y?, m}، وإلا null */
function monthOf(raw: string): { y: number | null; m: number } | null {
  let mm: RegExpExecArray | null;
  if ((mm = /^(\d{4})-(\d{1,2})$/.exec(raw))) return { y: +mm[1], m: +mm[2] };
  if ((mm = /^(\d{1,2})-(\d{4})$/.exec(raw))) return { y: +mm[2], m: +mm[1] };
  if ((mm = /^(\d{1,2})$/.exec(raw))) return { y: null, m: +mm[1] };
  return null;
}

const span = (fromLocal: string, toLocal: string, tz: string): AcctPeriod => ({
  fromLocal,
  toLocal,
  gte: zonedStartOfDay(fromLocal, tz),
  lt: zonedStartOfDay(addDays(toLocal, 1), tz),
});

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * يقرّر فترة السؤال:
 *  - `month` ('YYYY-MM' أو 'MM'): الشهر كاملاً [أوله، أول التالي). 'MM' وحده = شهر السنة الحالية للشركة — وإن لم يبدأ بعد
 *    (يناير و«شهر 12») فهو شهر السنة الماضية: لا يُسأل محاسبٌ عن شهرٍ لم يأتِ. ويغلب `from/to` إن جاءا معه.
 *  - `from`/`to` (YYYY-MM-DD، شاملان): «من» وحده ⇒ حتى اليوم؛ «إلى» وحده ⇒ من أول شهره.
 *  - لا شيء ⇒ الشهر الحالي حتى اليوم (todayLocal للشركة).
 * المدخل الفاسد (تاريخ غير موجود، شهر 13، بداية بعد النهاية، فترة أطول من MAX_PERIOD_DAYS) ⇒ {error} بالعربية — لا يُسقَط إلى
 * «كل الفترات» صامتاً.
 */
export function parsePeriod(
  args: { from?: string; to?: string; month?: string },
  tz: string,
  todayLocal: string,
): AcctPeriod | { error: string } {
  if (!isLocalDate(todayLocal)) return { error: 'تاريخ اليوم للشركة غير صالح' };
  const month = norm(args.month);
  if (month) {
    const p = monthOf(month);
    if (!p || p.m < 1 || p.m > 12) return { error: `الشهر «${args.month}» غير صالح — اكتب YYYY-MM أو رقم الشهر من 1 إلى 12` };
    const todayY = +todayLocal.slice(0, 4);
    let y = p.y ?? todayY;
    if (y < 1900 || y > 9999) return { error: `السنة في «${args.month}» غير صالحة` };
    // «شهر 12» في يناير = ديسمبر الماضي — الشهر بلا سنة لا يقع في المستقبل
    if (p.y == null && formatLocalDate(y, p.m, 1) > startOfMonth(todayLocal)) y -= 1;
    const first = formatLocalDate(y, p.m, 1);
    return span(first, endOfMonth(first), tz);
  }

  const fromRaw = norm(args.from);
  const toRaw = norm(args.to);
  const from = fromRaw ? localDateOf(fromRaw) : null;
  const to = toRaw ? localDateOf(toRaw) : null;
  if (fromRaw && !from) return { error: `تاريخ البداية «${args.from}» غير صالح — الصيغة YYYY-MM-DD` };
  if (toRaw && !to) return { error: `تاريخ النهاية «${args.to}» غير صالح — الصيغة YYYY-MM-DD` };

  let f: string;
  let t: string;
  if (!from && !to) {
    f = startOfMonth(todayLocal);
    t = todayLocal;
  } else if (from && !to) {
    f = from;
    t = from > todayLocal ? from : todayLocal;
  } else if (!from && to) {
    f = startOfMonth(to);
    t = to;
  } else {
    f = from!;
    t = to!;
  }
  if (f > t) return { error: `تاريخ البداية ${f} بعد تاريخ النهاية ${t}` };
  if (daysBetween(f, t) + 1 > MAX_PERIOD_DAYS) return { error: `الفترة أطول من ${MAX_PERIOD_DAYS} يوماً — قسّمها إلى فترات أقصر` };
  return span(f, t, tz);
}

/** حارس النوع لنتيجة parsePeriod */
export const isPeriodError = (p: AcctPeriod | { error: string }): p is { error: string } => 'error' in p;
