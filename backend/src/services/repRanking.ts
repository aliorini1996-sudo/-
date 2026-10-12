/**
 * تقييم أداء المناديب (طلب المالك ١٢ أكتوبر ٢٠٢٦) — ترتيب المناديب حسب معيارٍ يختاره المشرف: عدد الزيارات، أو كمية صنفٍ
 * بعينه، أو قيمة المبيعات، أو المسافة المقطوعة بالكيلو، أو وقت استخدام التطبيق. صرفٌ بلا قاعدة؛ المسار في routes/reports.ts.
 */
import { haversineM } from './routeShape';

export const RANKING_METRICS = ['visits', 'product', 'sales', 'distance', 'appTime'] as const;
export type RankingMetric = (typeof RANKING_METRICS)[number];

/** معايير مالية — تختفي مع «النظام المحاسبي» المطفأ */
export const FINANCIAL_METRICS: readonly RankingMetric[] = ['product', 'sales'];

export interface TrackPoint { lat: number; lng: number; accuracy?: number | null; capturedAt: Date }

export interface TrackedOpts {
  /** نقطةٌ أسوأ دقّةً من هذا تُسقط (إلا إن كانت كل النقاط كذلك) */
  maxAccuracyM: number;
  /** حركةٌ أقصر من هذا تذبذبُ GPS في مكانه لا مشي */
  minMoveM: number;
  /** فجوةٌ أطول من هذا بلا نقاط = التتبّع متوقّف (التطبيق مغلق): لا يُفترض خطٌّ مستقيم عبرها */
  maxGapMs: number;
  /** سرعةٌ ضمنية فوق هذا قفزةُ GPS خاطئة لا حركة */
  maxSpeedKmh: number;
}

export const TRACKED_DEFAULTS: TrackedOpts = { maxAccuracyM: 150, minMoveM: 15, maxGapMs: 20 * 60_000, maxSpeedKmh: 150 };

/**
 * المسافة **المرصودة** بالأمتار من نقاط GPS مندوبٍ واحد — مجموع المقاطع المتصلة وحدها:
 *  - النقاط رديئة الدقّة تُسقط، والتذبذب في المكان (أقصر من minMoveM) لا يُحسب حركة لكنه يُبقي «الحضور» حيّاً؛
 *  - فجوةٌ أطول من maxGapMs تبدأ مقطعاً جديداً بلا وصلٍ وهمي (تطبيقٌ أُغلق ثم فُتح في مكانٍ آخر)؛
 *  - قفزةٌ بسرعةٍ مستحيلة تُتجاهل.
 * فالرقم أقلّ من الحقيقة حين يتوقّف التتبّع، ولا يضخّمه خطأ GPS.
 */
export function trackedMeters(points: TrackPoint[], opts: TrackedOpts = TRACKED_DEFAULTS): number {
  const sorted = [...points].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const accurate = sorted.filter((p) => p.accuracy == null || p.accuracy <= opts.maxAccuracyM);
  const pts = accurate.length >= 2 ? accurate : sorted;
  if (pts.length < 2) return 0;

  let total = 0;
  let anchor = { lat: pts[0].lat, lng: pts[0].lng, t: pts[0].capturedAt.getTime() };
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const t = p.capturedAt.getTime();
    const dt = t - anchor.t;
    if (dt > opts.maxGapMs) { anchor = { lat: p.lat, lng: p.lng, t }; continue; }
    const d = haversineM(anchor, p);
    if (d < opts.minMoveM) { anchor = { ...anchor, t }; continue; } // ما زال هنا: الحضور يتجدّد والموضع ثابت
    if (dt <= 0 || (d / 1000) / (dt / 3_600_000) > opts.maxSpeedKmh) continue; // قفزة GPS
    total += d;
    anchor = { lat: p.lat, lng: p.lng, t };
  }
  return Math.round(total);
}

export interface RankingRow { repId: string; name: string; value: number; rank: number }

/** ترتيبٌ تنازلي بالقيمة؛ المتساويان يأخذان المرتبة نفسها (١، ٢، ٢، ٤)، والاسم يحسم ترتيب العرض بينهما */
export function rankRows(rows: { repId: string; name: string; value: number }[]): RankingRow[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'ar'));
  const out: RankingRow[] = [];
  sorted.forEach((r, i) => {
    const rank = i > 0 && Math.abs(r.value - sorted[i - 1].value) < 1e-9 ? out[i - 1].rank : i + 1;
    out.push({ ...r, rank });
  });
  return out;
}
