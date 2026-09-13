// ============================================================================
// تنسيق نقيّ لبوابة السفير — بلا React ولا مخزن لغة ولا إعداد أرقام الشركة،
// فالناتج حتميّ ويُختبر في node.
// ============================================================================

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

/** «1,234.56 ر.س» */
export function formatSar(halalas: number | null | undefined): string {
  return `${sarNumber(halalas)} ر.س`;
}

/** نقاط أساس ⇒ نسبة: 3000 ⇒ «30%»، 2550 ⇒ «25.5%» */
export function formatRate(bps: number | null | undefined): string {
  const n = typeof bps === 'number' && Number.isFinite(bps) ? bps : 0;
  const pct = Math.round(n) / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
/** الرياض UTC+3 بلا توقيت صيفي — إزاحة ثابتة تُغني عن Intl وتبقي الناتج حتمياً */
const RIYADH_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

function toTime(v: string | Date | null | undefined): number {
  if (v == null || v === '') return NaN;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

/** تاريخ ISO ⇒ «13 سبتمبر 2026» بتوقيت الرياض، وغير الصالح ⇒ «—» */
export function formatDay(v: string | Date | null | undefined): string {
  const t = toTime(v);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t + RIYADH_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** تاريخ اليوم بتوقيت الرياض بصيغة YYYY-MM-DD — لحقول `<input type="date">` */
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

/** «يوم واحد» · «يومان» · «3 أيام» · «11 يوماً» — تمييز العدد العربي */
export function daysLabel(n: number): string {
  const k = Math.max(0, Math.trunc(n));
  if (k === 0) return 'اليوم';
  if (k === 1) return 'يوم واحد';
  if (k === 2) return 'يومان';
  if (k <= 10) return `${k} أيام`;
  return `${k} يوماً`;
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
