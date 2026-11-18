// ============================================================================
// تنسيق نقيّ لبوابة السفير — بلا React ولا إعداد أرقام الشركة، فالناتج حتميّ
// ويُختبر في node. اللغة تُمرَّر صراحةً (العربية افتراضاً).
// ============================================================================
import type { Lang } from '../i18n/lang';
import { AX_LOCALE, translate } from './i18n';

/**
 * هللات ⇒ ريال بخانتين عشريتين وفواصل آلاف: 123456 ⇒ «1,234.56».
 * حسابٌ صحيح لا عشريّ: القسمة على 100 بالفاصلة العائمة تُنتج 0.1+0.2.
 */
export function sarNumber(halalas: number | null | undefined): string {
  const n = typeof halalas === 'number' && Number.isFinite(halalas) ? Math.trunc(halalas) : 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

/** رمز العملة بلغة العرض: «ر.س» بالعربية و«SAR» بغيرها */
export function sarSymbol(lang: Lang = 'ar'): string {
  return translate(lang, 'fmt.sar');
}

/** «1,234.56 ر.س» · «1,234.56 SAR» */
export function formatSar(halalas: number | null | undefined, lang: Lang = 'ar'): string {
  return `${sarNumber(halalas)} ${sarSymbol(lang)}`;
}

/** نقاط أساس ⇒ نسبة: 3000 ⇒ «30%»، 2550 ⇒ «25.5%» */
export function formatRate(bps: number | null | undefined): string {
  const n = typeof bps === 'number' && Number.isFinite(bps) ? bps : 0;
  const pct = Math.round(n) / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** الرياض UTC+3 بلا توقيت صيفي — إزاحة ثابتة لمفتاح اليوم */
const RIYADH_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

function toTime(v: string | Date | null | undefined): number {
  if (v == null || v === '') return NaN;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

const dayFormatters = new Map<Lang, Intl.DateTimeFormat>();
function dayFormatter(lang: Lang): Intl.DateTimeFormat {
  let f = dayFormatters.get(lang);
  if (!f) {
    // calendar صريحاً فوق ca-gregory في AX_LOCALE: ميلاديٌّ بكل لغة ولو كان تقويم الجهاز هجرياً، والوحدة باقية بلا تبعيّات
    f = new Intl.DateTimeFormat(AX_LOCALE[lang] ?? AX_LOCALE.ar, { calendar: 'gregory', timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long', year: 'numeric' });
    dayFormatters.set(lang, f);
  }
  return f;
}

/**
 * تاريخ ⇒ يومه بتوقيت الرياض بلغة العرض: «13 سبتمبر 2026» · «13 September 2026» ·
 * «2026年9月13日». حقول اليوم الخالص 'YYYY-MM-DD' تُقرأ منتصف ليل UTC فتبقى يومها
 * نفسه في الرياض. غير الصالح ⇒ «—».
 */
export function formatDay(v: string | Date | null | undefined, lang: Lang = 'ar'): string {
  const t = toTime(v);
  if (!Number.isFinite(t)) return '—';
  return dayFormatter(lang).format(new Date(t));
}

/** تاريخ اليوم بتوقيت الرياض بصيغة YYYY-MM-DD */
export function riyadhToday(now: number = Date.now()): string {
  const d = new Date(now + RIYADH_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** تاريخ من الخادم (ISO) ⇒ YYYY-MM-DD لحقل تاريخ */
export function toDateInput(v: string | null | undefined): string {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = toTime(v);
  return Number.isFinite(t) ? riyadhToday(t) : '';
}

/** الأيام المتبقية حتى لحظة ما (تقريبٌ لأعلى، وصفر إن مضت) */
export function daysUntil(v: string | Date | null | undefined, now: number = Date.now()): number {
  const t = toTime(v);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / DAY_MS));
}

/**
 * عدد الأيام بصيغته اللغوية. العربية بتمييز العدد: «يوم واحد» · «يومان» · «3 أيام» ·
 * «11 يوماً»؛ وغيرها من القاموس: «1 day» · «3 days».
 */
export function daysLabel(n: number, lang: Lang = 'ar'): string {
  const k = Math.max(0, Math.trunc(n));
  if (k === 0) return translate(lang, 'days.today');
  if (k === 1) return translate(lang, 'days.one');
  if (lang === 'ar') {
    if (k === 2) return 'يومان';
    if (k <= 10) return `${k} أيام`;
    return `${k} يوماً`;
  }
  return translate(lang, 'days.other', { n: k });
}

/** آخر أربعة من الآيبان بصيغة مُقنَّعة */
export function maskedIban(last4: string | null | undefined): string {
  return last4 ? `****${last4}` : '—';
}

/** نصّ المشاركة: الإفصاح أولاً ثم الرابط — الإفصاح لا يُحذف ولا يُؤخَّر */
export function shareText(disclosure: string, link: string): string {
  const d = (disclosure || '').trim();
  return d ? `${d}\n${link}` : link;
}

export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** الاسم الأول للتحية */
export function firstName(full: string | null | undefined): string {
  return (full || '').trim().split(/\s+/)[0] || '';
}

// ─────────────────────────── v2 (V2_SPEC §7) ───────────────────────────

/**
 * نصّ المشاركة الجاهز: الإفصاح أولاً (لا يُحذف ولا يُؤخَّر) ثم سطر الدعوة بلغة العرض ثم الرابط.
 * سطرٌ فارغ يُسقط — فلا أسطر خاوية في رسالة واتساب.
 */
export function inviteText(disclosure: string, invite: string, link: string): string {
  return [disclosure, invite, link].map((s) => (s || '').trim()).filter(Boolean).join('\n');
}

const monthFormatters = new Map<Lang, Intl.DateTimeFormat>();
/** 'YYYY-MM' ⇒ اسم الشهر المختصر بلغة العرض (ميلاديّ دائماً): «نوفمبر» · «Nov» · «11月» */
export function monthLabel(month: string, lang: Lang = 'ar'): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m) return month || '—';
  let f = monthFormatters.get(lang);
  if (!f) {
    f = new Intl.DateTimeFormat(AX_LOCALE[lang] ?? AX_LOCALE.ar, { calendar: 'gregory', timeZone: 'UTC', month: 'short' });
    monthFormatters.set(lang, f);
  }
  return f.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)));
}

/** معدّل التحويل (كسرٌ 0..1) ⇒ «12.5%»، وnull أو غير الصالح ⇒ «—» */
export function formatPercent(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return '—';
  const pct = Math.round(Math.min(rate, 1) * 1000) / 10;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/**
 * فترة دورة التسوية بتوقيت الرياض: نهاية الدورة لحظةٌ حصرية (00:00 من يوم 1 أو 11 أو 21)
 * فيُعرض اليوم الذي قبلها — «1 نوفمبر 2026 – 10 نوفمبر 2026». بلا فترة (دفعةٌ قبل v2) ⇒ «—».
 */
export function periodLabel(start: string | null | undefined, end: string | null | undefined, lang: Lang = 'ar'): string {
  const s = toTime(start);
  const e = toTime(end);
  if (!Number.isFinite(e)) return Number.isFinite(s) ? formatDay(start, lang) : '—';
  const last = new Date(e - 1);
  return Number.isFinite(s) ? `${formatDay(start, lang)} – ${formatDay(last, lang)}` : formatDay(last, lang);
}

/** حجم ملفٍ مقروء: «850 KB» · «2.4 MB» */
export function formatBytes(n: number | null | undefined): string {
  const b = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * ارتفاعات أعمدة الرسم (٪ من أعلى قيمة). القيمة الموجبة لا تقلّ عن 4٪ كي تُرى، والصفر
 * والسالب (شهرٌ خُصم فيه استرداد) صفر. كل القيم صفر ⇒ كلها صفر.
 */
export function barHeights(values: number[]): number[] {
  const max = Math.max(0, ...values.map((v) => (Number.isFinite(v) ? v : 0)));
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => (Number.isFinite(v) && v > 0 ? Math.max(4, Math.round((v / max) * 100)) : 0));
}

/** ريالاتٌ مختصرة فوق الأعمدة بلا كسور: 123456 هللة ⇒ «1.2k»، و98000 ⇒ «980» */
export function sarCompact(halalas: number | null | undefined): string {
  const r = Math.round((typeof halalas === 'number' && Number.isFinite(halalas) ? halalas : 0) / 100);
  const abs = Math.abs(r);
  if (abs >= 1_000_000) return `${(r / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1_000) return `${(r / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(r);
}

/** رابطٌ يُفتح من البوابة: http(s) وحده — `javascript:` وأمثاله لا تصل href أبداً */
export function safeHttpUrl(url: string | null | undefined): string | null {
  const s = (url || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try { return new URL(s).href; } catch { return null; }
}

/**
 * طول دورة التسوية (V2_SPEC §5: نهايات 1 و11 و21) — الاحتياط حين لا يرسل الخادم
 * `settlementEveryDays` (الشروط العامة قبل الدخول، أو خادمٌ أقدم).
 */
export const SETTLEMENT_EVERY_DAYS = 10;

/** رابط واتساب الدعم الرسمي (V2_SPEC §7) بنصٍّ أوّل جاهز */
export const SUPPORT_WHATSAPP = '966506061608';
export const SUPPORT_EMAIL = 'info@fieldsa.net';
export function supportWhatsappUrl(text: string): string {
  return `https://wa.me/${SUPPORT_WHATSAPP}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/** قائمةٌ بأداة العطف بلغة العرض («أ وب» · «a and b») — وفاصلةٌ بسيطة إن غاب Intl.ListFormat */
export function listJoin(items: string[], lang: Lang = 'ar'): string {
  const xs = items.filter(Boolean);
  try {
    const LF = (Intl as unknown as { ListFormat?: new (l: string, o: { type: string }) => { format: (x: string[]) => string } }).ListFormat;
    if (LF) return new LF(AX_LOCALE[lang] ?? AX_LOCALE.ar, { type: 'conjunction' }).format(xs);
  } catch { /* نرجع للفاصلة */ }
  return xs.join(lang === 'ar' ? '\u060C ' : lang === 'zh' ? '\u3001' : ', ');
}
