/**
 * حساب مدّة الزيارة — دالّة **صرفة** بلا Prisma.
 *
 * لماذا يُحسب على الخادم لا يُؤخذ من العميل: مدّة الزيارة مقياس أداء يراه
 * المدير، فلو أرسلها العميل رقماً جاهزاً لأمكن تزويرها (ساعة تطبيق معدّلة،
 * أو حقل مُحرّر يدوياً). نأخذ الطابعين الزمنيين ونشتقّ المدّة هنا، ونتحقّق
 * من معقوليتها. رقم العميل — إن أُرسل — للمقارنة والتشخيص لا للاعتماد.
 *
 * قراران حاكمان:
 *  ١) **سقف أعلى للمدّة.** المؤقّت يبدأ بضغطة ويتوقّف عند الخروج من ملفّ
 *     العميل. لكن المندوب قد ينسى ويبقى الملفّ مفتوحاً (أو ينقطع اتصاله
 *     ساعات). بلا سقف تتضخّم «مدّة الزيارة» إلى ساعات فتُفسد كل متوسط.
 *     نقصّها عند سقف معقول ونُعلمها `capped` كي تُعرَض بصدق لا صامتةً.
 *  ٢) **مدّة سالبة أو صفرية = بيانات فاسدة**، لا زيارة مدّتها صفر: ساعة
 *     العميل قد ترتدّ، أو يصل endedAt قبل startedAt. نردّها لاغيةً لا صفراً.
 */

/** سقف المدّة المعقول لزيارة ميدانية واحدة: ٤ ساعات. ما فوقه = توكن منسيّ. */
export const MAX_VISIT_SECONDS = 4 * 3600;

/** أدنى مدّة تُقبل: ثانيتان. أقلّ = ضغطة خاطئة أو ساعة مرتدّة. */
export const MIN_VISIT_SECONDS = 2;

export interface DurationInput {
  /** بداية المؤقّت (ISO أو Date) — لحظة ضغط أيقونة البدء */
  startedAt: string | Date;
  /** نهايته — لحظة الخروج من ملفّ العميل */
  endedAt: string | Date;
  /** ما قاسه العميل (اختياري) — للمقارنة لا للاعتماد */
  clientDurationSec?: number;
}

export interface DurationResult {
  /** صالحة للتخزين؟ */
  ok: boolean;
  /** المدّة المعتمَدة بالثواني (بعد القصّ عند السقف) — null إن لاغية */
  durationSec: number | null;
  /** المدّة الخام قبل القصّ */
  rawSec: number | null;
  /** هل قُصّت عند السقف؟ (توكن منسيّ غالباً) */
  capped: boolean;
  /** فرق ملموس بين ما قاسه العميل والخادم (>60ث) — إشارة تلاعب/انحراف ساعة */
  clientMismatch: boolean;
  reason?: string;
}

const ms = (v: string | Date): number => {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
};

export function computeVisitDuration(input: DurationInput): DurationResult {
  const start = ms(input.startedAt);
  const end = ms(input.endedAt);

  if (Number.isNaN(start) || Number.isNaN(end)) {
    return { ok: false, durationSec: null, rawSec: null, capped: false, clientMismatch: false, reason: 'طابع زمني غير صالح' };
  }

  const rawSec = Math.round((end - start) / 1000);

  if (rawSec < MIN_VISIT_SECONDS) {
    return { ok: false, durationSec: null, rawSec, capped: false, clientMismatch: false, reason: 'مدّة غير معقولة (سالبة أو أقصر من ثانيتين)' };
  }

  const capped = rawSec > MAX_VISIT_SECONDS;
  const durationSec = capped ? MAX_VISIT_SECONDS : rawSec;

  // مقارنة برقم العميل إن وُجد — لا نرفض بسببه، بل نرفع علماً للتشخيص
  let clientMismatch = false;
  if (typeof input.clientDurationSec === 'number' && Number.isFinite(input.clientDurationSec)) {
    clientMismatch = Math.abs(input.clientDurationSec - rawSec) > 60;
  }

  return { ok: true, durationSec, rawSec, capped, clientMismatch };
}

/** «12:05» أو «1:03:20» — تنسيق عربي بسيط للعرض (يُستعمل في الواجهة والتقارير) */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
