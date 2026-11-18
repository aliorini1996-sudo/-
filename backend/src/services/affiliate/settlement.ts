/**
 * دورة تسوية «سفير فيلد سيلز» كل ١٠ أيام (V2_SPEC §5) — **هذا الملف ملك الوكيل B**.
 *
 * أنشأه الوكيل A بالدالّتين النقيّتين من §11 وحدهما (nextSettlementAt وcycleBounds) لأنّ البوابة تعرض
 * «التسوية القادمة» — وفي الدمج يبقى تنفيذ B الأصلي (runSettlementCycle والمجدول وغيرهما).
 *
 * نهايات الدورات أيّام **1 و11 و21** من كل شهر الساعة 00:00 بتوقيت الرياض (+٣ بلا توقيت صيفي)،
 * و`cycleKey` تاريخ النهاية `YYYY-MM-DD`، و`periodStart` النهاية التي قبلها.
 */

const RIYADH_OFFSET_MS = 3 * 3600_000;
const CYCLE_DAYS = [1, 11, 21] as const;

/** نهايةٌ بالتقويم المحلّي للرياض ⇒ لحظتها الحقيقية (منتصف ليل الرياض = 21:00 UTC من اليوم السابق) */
function endAt(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day) - RIYADH_OFFSET_MS);
}

/** آخر نهايةٍ ≤ now، بالتقويم المحلّي { y, m (0..11), day } */
function lastEndLocal(now: Date): { y: number; m: number; day: number } {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  // منتصف الليل نفسه ينتمي لليوم الجديد: اليوم 11 الساعة 00:00 نهايةٌ مرّت (≤ now)
  const day = d >= 21 ? 21 : d >= 11 ? 11 : 1;
  return { y, m, day };
}

function stepLocal(p: { y: number; m: number; day: number }, dir: 1 | -1): { y: number; m: number; day: number } {
  const i = CYCLE_DAYS.indexOf(p.day as 1 | 11 | 21);
  const j = i + dir;
  if (j >= 0 && j < CYCLE_DAYS.length) return { y: p.y, m: p.m, day: CYCLE_DAYS[j] };
  // Date.UTC يطبّع الشهر 12 و-1 إلى السنة المجاورة
  const d = new Date(Date.UTC(p.y, p.m + dir, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: dir === 1 ? CYCLE_DAYS[0] : CYCLE_DAYS[CYCLE_DAYS.length - 1] };
}

const keyOf = (p: { y: number; m: number; day: number }) =>
  `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;

/** نهاية الدورة القادمة — أوّل نهايةٍ بعد `now` تماماً (1/11/21 الساعة 00:00 بالرياض) */
export function nextSettlementAt(now: Date = new Date()): Date {
  const n = stepLocal(lastEndLocal(now), 1);
  return endAt(n.y, n.m, n.day);
}

/** آخر دورةٍ انتهت عند `now` أو قبله: مفتاحها (تاريخ نهايتها) وبدايتها (النهاية السابقة) ونهايتها */
export function cycleBounds(now: Date = new Date()): { cycleKey: string; periodStart: Date; periodEnd: Date } {
  const end = lastEndLocal(now);
  const start = stepLocal(end, -1);
  return { cycleKey: keyOf(end), periodStart: endAt(start.y, start.m, start.day), periodEnd: endAt(end.y, end.m, end.day) };
}
