// ============================================================================
// ZATCA المرحلة الثانية (Z1) — توقيت الرياض الثابت (UTC+3) لتاريخ ووقت الإصدار
// ----------------------------------------------------------------------------
// IssueDate/IssueTime تُكتب بتوقيت السعودية المحلي (AST) بلا لاحقة Z، كما في عيّنات
// الـSDK وكما تسمح BR-KSA-70 [XML p.58]. والسعودية لا تطبّق توقيتاً صيفياً، فالإزاحة
// ثابتة +03:00 — لذا نحسب بإزاحة ميلي ثانية صريحة ثم نقرأ حقول UTC، فلا يتأثر الناتج
// بمنطقة الخادم الزمنية (TZ) إطلاقاً (UNVERIFIED(U14): منطقة خادم Render — design §6.2).
// الكسور تحت الثانية تُقصّ (لا تُقرَّب) كي لا تقفز 23:59:59.999 إلى يوم تالٍ.
// UNVERIFIED(U2): قبول/اشتراط لاحقة Z في IssueTime وSigningTime ووسم QR 3 — design §6.2.
// ============================================================================

/** إزاحة الرياض عن UTC بالميلي ثانية (+03:00، بلا توقيت صيفي). */
export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** تاريخ ووقت الرياض: { date: "YYYY-MM-DD", time: "HH:mm:ss" } مستقلّان عن TZ الخادم. */
export function riyadhParts(d: Date): { date: string; time: string } {
  const ms = d instanceof Date ? d.getTime() : NaN;
  if (!Number.isFinite(ms)) throw new RangeError('riyadhParts: تاريخ غير صالح');
  const s = new Date(ms + RIYADH_OFFSET_MS);
  const year = s.getUTCFullYear();
  if (year < 0 || year > 9999) throw new RangeError(`riyadhParts: سنة خارج النطاق ${year}`);
  return {
    date: `${pad(year, 4)}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`,
    time: `${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}:${pad(s.getUTCSeconds())}`,
  };
}

/** "YYYY-MM-DDTHH:mm:ss" بتوقيت الرياض — لـSigningTime ووسم QR 3 في Z2. */
export function riyadhDateTime(d: Date): string {
  const p = riyadhParts(d);
  return `${p.date}T${p.time}`;
}

/** هل النص تاريخ تقويمي حقيقي بصيغة YYYY-MM-DD؟ (يرفض 2026-02-30) */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], da = +m[3];
  if (mo < 1 || mo > 12 || da < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return da <= days;
}

/** هل النص وقتاً بصيغة HH:mm:ss (بلا Z وبلا كسور)؟ */
export function isIsoTime(s: unknown): s is string {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(s);
}
