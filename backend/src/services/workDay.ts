/**
 * محرّك «يوم العمل الميداني» — يجمع ثلاثة مصادر زمنية في مقياس واحد لكل يوم.
 *
 * لماذا ثلاثة مصادر؟ لأن كل واحد يرى جزءاً من اليوم ويعمى عن الباقي:
 *   • **جلسات التطبيق** (RepSession): نبضة كل دقيقة تشترط اتصالاً، وفجوة ٣ دقائق
 *     تقطع الجلسة — فالقيادة بلا شبكة أو بشاشة مقفلة لا تُحسب. هذا سبب الفجوة
 *     التي لاحظها المالك بين تقرير الساعات وخريطة التتبّع.
 *   • **نقاط الموقع** (RepLocation): تُلتقط بوقت الجهاز وتُرفع دفعاتٍ لاحقاً،
 *     فترى فترات الانقطاع — لكنها مشروطة بتفعيل التتبّع وإذن الموقع.
 *   • **الزيارات** (RepVisit): أثرٌ مؤكّد بوقته حتى لو غاب المصدران.
 *
 * «من خروجه من بيته إلى عودته» لا يعرفه أي نظام لا يعرف بيت المندوب؛ أصدقُ
 * مقياسٍ متاح هو **من أول أثر رقمي في اليوم إلى آخره** — وهو ما يحسبه هذا
 * الملف، مع إبقاء «نشاط التطبيق» رقماً مستقلاً لا بديلاً.
 *
 * كل الدوال صرفة (بلا قاعدة بيانات) لتُختبر وحدها، والتوقيت المحلي يُمرَّر
 * إزاحةً بالدقائق شرقي UTC (الرياض = +180) لأن «اليوم» يوم المندوب لا يوم الخادم.
 */

export interface Interval { start: Date; end: Date }
export interface VisitLike { customerName: string; at: Date; durationSec: number | null }
export interface PingRange { day: string; min: Date; max: Date }

export interface WorkDay {
  date: string;               // YYYY-MM-DD بالتوقيت المحلي المُمرَّر
  firstActivity: Date;        // أول أثر (موقع/جلسة/زيارة)
  lastActivity: Date;         // آخر أثر
  spanMinutes: number;        // يوم العمل الميداني = آخره − أوله
  appMinutes: number;         // نشاط التطبيق داخل اليوم (جلسات مقصوصة على حدوده)
  visits: VisitLike[];        // مرتّبة زمنياً
  visitsCount: number;
  visitsSec: number;          // مجموع مدد الزيارات المؤقّتة (يطابق ملخّص خريطة التتبّع)
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** مفتاح اليوم المحلي (YYYY-MM-DD) لطابعٍ زمني، بإزاحة دقائق شرقي UTC */
export function dayKey(d: Date, tzOffsetMin: number): string {
  return new Date(d.getTime() + tzOffsetMin * 60000).toISOString().slice(0, 10);
}

/** بداية اليوم المحلي (كلحظة UTC حقيقية) لمفتاح يوم */
export function dayStartUtc(day: string, tzOffsetMin: number): Date {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() - tzOffsetMin * 60000);
}

/**
 * يقصّ فترةً على حدود الأيام المحلية ويوزّع دقائقها.
 * جلسةٌ تعبر منتصف الليل تُحسب لكل يومٍ حصّته — لا لليوم الذي بدأت فيه كاملةً.
 */
export function splitByLocalDay(iv: Interval, tzOffsetMin: number): Array<{ day: string; start: Date; end: Date }> {
  if (iv.end.getTime() <= iv.start.getTime()) return [];
  const out: Array<{ day: string; start: Date; end: Date }> = [];
  let cursor = iv.start;
  // حارس ضدّ فترة فاسدة تمتدّ سنين (بيانات معطوبة) — سقف ٦٢ قطعة يكفي أي شهرين
  for (let i = 0; i < 62 && cursor < iv.end; i++) {
    const day = dayKey(cursor, tzOffsetMin);
    const nextMidnight = new Date(dayStartUtc(day, tzOffsetMin).getTime() + DAY_MS);
    const end = iv.end < nextMidnight ? iv.end : nextMidnight;
    out.push({ day, start: cursor, end });
    cursor = end;
  }
  return out;
}

/** يجمع المصادر الثلاثة في قائمة أيام عمل مرتّبة تصاعدياً */
export function composeWorkDays(input: {
  sessions: Interval[];
  pingRanges: PingRange[];   // مُجمَّعة مسبقاً لكل يوم محلي (min/max) — النقاط الخام كثيرة
  visits: VisitLike[];
  tzOffsetMin: number;
}): WorkDay[] {
  const { sessions, pingRanges, visits, tzOffsetMin } = input;
  type Acc = { first: Date; last: Date; appMs: number; visits: VisitLike[]; visitsSec: number };
  const days = new Map<string, Acc>();
  const touch = (day: string, at: Date): Acc => {
    const a = days.get(day) || { first: at, last: at, appMs: 0, visits: [], visitsSec: 0 };
    if (at < a.first) a.first = at;
    if (at > a.last) a.last = at;
    days.set(day, a);
    return a;
  };

  for (const s of sessions) {
    for (const part of splitByLocalDay(s, tzOffsetMin)) {
      const a = touch(part.day, part.start);
      if (part.end > a.last) a.last = part.end;
      a.appMs += part.end.getTime() - part.start.getTime();
    }
  }
  for (const p of pingRanges) {
    touch(p.day, p.min);
    touch(p.day, p.max);
  }
  for (const v of visits) {
    const day = dayKey(v.at, tzOffsetMin);
    const a = touch(day, v.at);
    // نهاية الزيارة المؤقّتة أثرٌ أيضاً — زيارة تنتهي بعد آخر نبضة تمدّ اليوم
    if (v.durationSec && v.durationSec > 0) {
      const end = new Date(v.at.getTime() + v.durationSec * 1000);
      if (dayKey(end, tzOffsetMin) === day && end > a.last) a.last = end;
      a.visitsSec += v.durationSec;
    }
    a.visits.push(v);
  }

  return [...days.entries()]
    .map(([date, a]) => ({
      date,
      firstActivity: a.first,
      lastActivity: a.last,
      spanMinutes: Math.round((a.last.getTime() - a.first.getTime()) / 60000),
      appMinutes: Math.round(a.appMs / 60000),
      visits: a.visits.sort((x, y) => x.at.getTime() - y.at.getTime()),
      visitsCount: a.visits.length,
      visitsSec: a.visitsSec,
    }))
    .sort((x, y) => x.date.localeCompare(y.date));
}
