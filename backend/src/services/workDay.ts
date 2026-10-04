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
 * والدوام المتقطّع (٩ص–١ظ ثم ٥م–٩م): فترات اليوم من **بصمات المندوب وحدها** — كل دخولٍ
 * يُسجَّل وكل خروجٍ يُسجَّل (قرار المالك)، فلكل حضورٍ→انصرافٍ فترة، والاستراحة ما بين
 * انصرافٍ والحضور التالي. لا عتبة زمنية تستنتج استراحةً من صمت الأثر: يومٌ بلا بصمة يبقى
 * امتداداً واحداً من أول أثرٍ إلى آخره موسوماً ACTIVITY، بلا فتراتٍ ولا استراحةٍ مخترعة.
 *
 * كل الدوال صرفة (بلا قاعدة بيانات) لتُختبر وحدها، والتوقيت المحلي يُمرَّر
 * إزاحةً بالدقائق شرقي UTC (الرياض = +180) لأن «اليوم» يوم المندوب لا يوم الخادم.
 */

export interface Interval { start: Date; end: Date }
export interface VisitLike {
  customerName: string;
  at: Date;
  durationSec: number | null;
  lat?: number | null;
  lng?: number | null;
  /** معرّف العميل — أدقّ من الاسم في المطابقة (عميلان بالاسم نفسه) حين يُمرَّر */
  customerId?: string | null;
}

/**
 * زيارةٌ واحدة كما يفهمها المشرف — لا كما تُخزَّن.
 *
 * تطبيق المندوب ينشئ **سجلَّين** للزيارة الواحدة: مؤقّتٌ يبدأ عند فتح ملفّ
 * العميل وينتهي عند الخروج (بمدّة)، وسجلٌّ آخر حين يكتب ملاحظةً أو يلتقط صورة
 * (بلا توقيت). فكان التقرير يعرض كل عميلٍ مرّتين — مرّةً بمدّة ومرّةً «بلا
 * توقيت» — ويضاعف عدد الزيارات. وهما حدثان في النظام، لكنهما **وقفةٌ واحدة**
 * عند عميلٍ واحد، والمشرف يعدّ الوقفات لا السجلّات.
 *
 * وهذه الدالّة **المصدر الوحيد** لهذا الدمج: كلّ شاشةٍ تعرض الزيارات أو
 * تعدّها تمرّ بها (ساعات العمل، زيارات العملاء، أداء المناديب، الخريطة
 * وعدّاداتها). شاشةٌ واحدة تعدّ السجلّات خاماً تكفي ليُناقض رقمُها رقمَ أختها.
 */
export interface MergedVisit<T extends VisitLike = VisitLike> {
  customerName: string;
  start: Date;
  /** نهاية الزيارة (بداية + مدّة) — null لزيارة بلا توقيت */
  end: Date | null;
  durationSec: number | null;
  /** رافقتها ملاحظة أو صورة */
  hasNote: boolean;
  /** كم سجلاً اندمج فيها (٢ = مؤقّت + ملاحظة) */
  parts: number;
  /** موقع الوقفة — من السجلّ المؤقّت، وإلّا من سجلّ الملاحظة الذي اندمج فيه */
  lat: number | null;
  lng: number | null;
  /** السجلّات التي اندمجت فيها — المؤقّت أوّلاً ثمّ الملاحظات بترتيبها */
  sources: T[];
}

/**
 * هامش الدمج: الملاحظة تُحفظ والمندوب يخرج، فيسبق طابعُها نهايةَ المؤقّت أو
 * يليها بدقائق. خمس دقائق تكفي ولا تبتلع زيارةً ثانية لنفس العميل.
 */
export const MERGE_TOLERANCE_MS = 5 * 60 * 1000;

/** العميل نفسه؟ بالمعرّف حين يحمله الطرفان، وإلّا بالاسم (السلوك السابق) */
function sameCustomer(a: VisitLike, b: VisitLike): boolean {
  if (a.customerId && b.customerId) return a.customerId === b.customerId;
  return a.customerName === b.customerName;
}

/** يدمج سجلَّي الزيارة الواحدة (المؤقّت + الملاحظة) في وقفةٍ واحدة — لمندوبٍ واحد */
export function mergeVisits<T extends VisitLike>(visits: T[]): MergedVisit<T>[] {
  const sorted = [...visits].sort((a, b) => a.at.getTime() - b.at.getTime());
  const isTimed = (v: VisitLike) => !!v.durationSec && v.durationSec > 0;

  const out: MergedVisit<T>[] = sorted.filter(isTimed).map((v) => ({
    customerName: v.customerName,
    start: v.at,
    end: new Date(v.at.getTime() + (v.durationSec as number) * 1000),
    durationSec: v.durationSec,
    hasNote: false,
    parts: 1,
    lat: v.lat ?? null,
    lng: v.lng ?? null,
    sources: [v],
  }));

  for (const u of sorted.filter((v) => !isTimed(v))) {
    const t = u.at.getTime();
    const host = out.find((h) =>
      h.durationSec != null &&
      sameCustomer(h.sources[0], u) &&
      t >= h.start.getTime() - MERGE_TOLERANCE_MS &&
      t <= (h.end ? h.end.getTime() : h.start.getTime()) + MERGE_TOLERANCE_MS);
    if (host) {
      host.hasNote = true;
      host.parts += 1;
      host.sources.push(u);
      // سجلّ الملاحظة يحمل موقعاً أحياناً والمؤقّت لا — فلا يُهدَر الموقع الوحيد
      if (host.lat == null && u.lat != null) { host.lat = u.lat; host.lng = u.lng ?? null; }
    } else {
      out.push({
        customerName: u.customerName, start: u.at, end: null, durationSec: null,
        hasNote: true, parts: 1, lat: u.lat ?? null, lng: u.lng ?? null, sources: [u],
      });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * الدمج لأكثر من مندوب: يجمّع حسب المندوب **قبل** الدمج — فلا تُلصَق ملاحظة
 * مندوبٍ بمؤقّت زميلٍ زار العميل نفسه في الوقت نفسه.
 */
export function mergeVisitsByRep<T extends VisitLike & { salesRepId: string }>(rows: T[]): MergedVisit<T>[] {
  const byRep = new Map<string, T[]>();
  for (const r of rows) {
    const arr = byRep.get(r.salesRepId);
    if (arr) arr.push(r); else byRep.set(r.salesRepId, [r]);
  }
  return [...byRep.values()].flatMap((arr) => mergeVisits(arr));
}

/** عدد الوقفات (لا السجلّات) لكلّ مندوب */
export function countStopsByRep<T extends VisitLike & { salesRepId: string }>(rows: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of mergeVisitsByRep(rows)) {
    const rep = m.sources[0].salesRepId;
    out[rep] = (out[rep] ?? 0) + 1;
  }
  return out;
}

/**
 * سجلّ زيارةٍ خام كما تقرؤه المسارات — يُحوَّل إلى شكل الدمج. `at` بداية
 * المؤقّت متى وُجدت (أدقّ)، وإلّا لحظة التسجيل.
 */
export function asVisitLike<R extends {
  salesRepId: string; createdAt: Date; startedAt?: Date | null; durationSec: number | null;
  lat?: number | null; lng?: number | null; customerId?: string | null; customer?: { name: string } | null;
}>(r: R): R & VisitLike {
  return {
    ...r,
    customerName: r.customer?.name || '',
    at: r.startedAt || r.createdAt,
  };
}

/** نشاط GPS مُجمَّعاً في القاعدة لكل (مندوب × يوم محلي): أول التقاطٍ وآخره */
export interface PingRange { day: string; min: Date; max: Date }

const roundMin = (ms: number) => Math.max(0, Math.round(ms / 60000));

/**
 * فترة عملٍ داخل اليوم.
 *   • PUNCH: حضورٌ→انصرافٌ مسجَّلان ببصمة المندوب (المفتوحة نهايتها null).
 *   • ACTIVITY: يومٌ بلا بصمة — امتدادٌ واحد من أول أثرٍ إلى آخره، لا تقسيم له.
 */
export interface WorkPeriod {
  start: Date;
  /** null = نوبةٌ مفتوحة بلا انصراف بعد (امتداد الأثر مغلقٌ دائماً) */
  end: Date | null;
  source: 'PUNCH' | 'ACTIVITY';
}

export interface WorkDay {
  date: string;               // YYYY-MM-DD بالتوقيت المحلي المُمرَّر
  firstActivity: Date;        // أول حضور (يومٌ ببصمة) وإلّا أول أثر (موقع/جلسة/زيارة)
  lastActivity: Date;         // آخر انصراف (يومٌ ببصمة) وإلّا آخر أثر
  spanMinutes: number;        // ببصمة: مجموع النوبات المغلقة (بلا الاستراحات)؛ بلا بصمة: آخر أثر − أوله كما كان
  /** فترات العمل مرتّبة — صفٌّ واحد لليوم يعرضها في خلية واحدة. بلا بصمة: امتدادٌ واحد ACTIVITY */
  periods: WorkPeriod[];
  /** ما بين انصرافٍ والحضور التالي (ببصمة فقط؛ ٠ ليومٍ بلا بصمة أو بنوبةٍ واحدة) */
  breakMinutes: number;
  appMinutes: number;         // نشاط التطبيق داخل اليوم (جلسات مقصوصة على حدوده)
  visits: MergedVisit[];      // وقفاتٌ مدموجة مرتّبة زمنياً
  visitsCount: number;        // عدد **الوقفات** لا السجلّات
  visitsSec: number;          // مجموع مدد الزيارات المؤقّتة (يطابق ملخّص خريطة التتبّع)
  /** يومٌ في المدى بلا أيّ أثر — يُعرض صفّاً فارغاً لا يُحذف */
  absent: boolean;
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
// ═══ بصمة الحضور والانصراف: مقياس «يعلنه المندوب» يعلو مقياس الأثر الرقمي ═══
// حين تُفعَّل الميزة ويبصم المندوب، تصير فترات اليوم نوباته المسجَّلة: كل حضورٍ يفتح فترة وكل انصرافٍ
// يغلقها، وإجمالي وقت العمل = مجموع النوبات المغلقة. «نشاط التطبيق» (appMinutes) يبقى كما هو (نبضة الاتصال).
export interface AttendanceShift { checkInAt: Date; checkOutAt: Date | null }
export interface AttendanceDay {
  start: Date; end: Date | null; minutes: number;
  /** نوبةٌ لكل فترة (المتداخلة تتّحد)، والمفتوحة بنهاية null */
  periods: WorkPeriod[];
  /** الفراغ بين انصرافٍ وحضورٍ تالٍ في اليوم نفسه — استراحة المندوب المعلنة ببصمته */
  breakMinutes: number;
}

/**
 * تجميع بصمات المندوب على يومه المحلي: فترةٌ لكل حضور→انصراف، أول حضور، آخر انصراف، ومجموع النوبات المغلقة.
 * المندوب الذي ينصرف ظهراً ويعود مساءً يبصم نوبتين ⇒ فترتان، والإجمالي مجموعهما لا ما بين طرفيهما،
 * وما بينهما استراحةٌ أعلنها ببصمته — مهما قصرت أو طالت (لا عتبة زمنية).
 */
export function attendanceByDay(shifts: readonly AttendanceShift[], tzOffsetMin: number): Map<string, AttendanceDay> {
  const byKey = new Map<string, AttendanceShift[]>();
  for (const s of shifts) {
    const key = dayKey(s.checkInAt, tzOffsetMin);
    const arr = byKey.get(key) ?? [];
    arr.push(s);
    byKey.set(key, arr);
  }

  const m = new Map<string, AttendanceDay>();
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.checkInAt.getTime() - b.checkInAt.getTime());
    // نوبتان مغلقتان متداخلتان (بيانات مكرّرة) تتّحدان فلا تُعدّ ساعاتهما مرّتين؛
    // والمفتوحة لا تُدمج — لا نهاية لها تُقارَن، فتبقى فترةً «بلا انصراف»
    const periods: WorkPeriod[] = [];
    for (const s of sorted) {
      const cur = periods[periods.length - 1];
      if (cur && cur.end && s.checkOutAt && s.checkInAt <= cur.end) {
        if (s.checkOutAt > cur.end) cur.end = s.checkOutAt;
      } else {
        periods.push({ start: s.checkInAt, end: s.checkOutAt, source: 'PUNCH' });
      }
    }
    let end: Date | null = null;
    let minutes = 0;
    let breakMinutes = 0;
    for (let i = 0; i < periods.length; i++) {
      const pEnd = periods[i].end;
      if (!pEnd) continue;
      if (!end || pEnd > end) end = pEnd;
      // نوبةٌ مغلقة فقط تُحسب دقائقها؛ نوبةٌ مفتوحة تُظهر بداية بلا نهاية ولا تُضاف حتى الانصراف
      minutes += roundMin(pEnd.getTime() - periods[i].start.getTime());
      // الاستراحة من انصرافٍ معلوم إلى الحضور التالي (ولو كانت النوبة التالية ما زالت مفتوحة)
      const next = periods[i + 1];
      if (next) breakMinutes += roundMin(next.start.getTime() - pEnd.getTime());
    }
    m.set(key, { start: periods[0].start, end, minutes, periods, breakMinutes });
  }
  return m;
}

/**
 * تركيب البصمة فوق أيام النشاط: يومٌ له بصمة تُؤخذ منه البداية والنهاية والإجمالي والفترات، ويُرفع عنه
 * «غياب» (فالمندوب أعلن حضوره). الأيام بلا بصمة تبقى على مقياس الأثر الرقمي كما كانت (توافق مع ما قبل الميزة).
 */
export function overlayAttendance(days: readonly WorkDay[], byDay: Map<string, AttendanceDay>): WorkDay[] {
  return days.map((d) => {
    const att = byDay.get(d.date);
    if (!att) return d;
    return {
      ...d, firstActivity: att.start, lastActivity: att.end ?? att.start, spanMinutes: att.minutes,
      periods: att.periods, breakMinutes: att.breakMinutes, absent: false,
    };
  });
}

export function composeWorkDays(input: {
  sessions: Interval[];
  pingRanges: PingRange[];   // مُجمَّعة مسبقاً لكل يوم محلي (min/max) — النقاط الخام كثيرة
  visits: VisitLike[];
  tzOffsetMin: number;
  /** مدى الأيام المحلّية (YYYY-MM-DD) — يُملأ الغائب منها بصفوفٍ فارغة */
  range?: { from: string; to: string };
}): WorkDay[] {
  const { sessions, pingRanges, visits, tzOffsetMin, range } = input;
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

  const built: WorkDay[] = [...days.entries()].map(([date, a]) => {
    const merged = mergeVisits(a.visits);
    return {
      date,
      firstActivity: a.first,
      lastActivity: a.last,
      spanMinutes: Math.round((a.last.getTime() - a.first.getTime()) / 60000),
      // بلا بصمة: امتدادٌ واحد موسومٌ بمصدره — لا يُقسَم بصمت الأثر ولا تُستنتج منه استراحة.
      // البصمة (overlayAttendance) تستبدله بنوباتها حين يبصم المندوب
      periods: [{ start: a.first, end: a.last, source: 'ACTIVITY' }],
      breakMinutes: 0,
      appMinutes: Math.round(a.appMs / 60000),
      visits: merged,
      visitsCount: merged.length,
      visitsSec: a.visitsSec,
      absent: false,
    };
  });

  let scoped = built;
  if (range) {
    // ١) قصٌّ على المدى المطلوب: أثرٌ من زيارةٍ عالقة بدأت قبل المدى (startedAt
    //    قديم وسجلُّها أُنشئ داخله) أو جلسةٍ تعبر منتصف ليل آخر يوم، كان يُظهر
    //    يوماً لم يحدّده المشرف (حدّد ١٩ فظهر ١٧). الأيام خارج المدى تُحذف.
    scoped = built.filter((d) => d.date >= range.from && d.date <= range.to);

    // ٢) أيامٌ بلا أثر تُملأ صفوفاً فارغة داخل المدى. حذفُها يُخفي الغياب:
    //    مندوبٌ غاب ثلاثة أيام من خمسة يبدو جدولُه مكتملاً لأن الأيام الغائبة لا
    //    تظهر أصلاً — والمشرف يقرأ ما أمامه لا ما نقص منه.
    const have = new Set(scoped.map((d) => d.date));
    for (let t = dayStartUtc(range.from, tzOffsetMin).getTime();
         t <= dayStartUtc(range.to, tzOffsetMin).getTime();
         t += DAY_MS) {
      const day = dayKey(new Date(t), tzOffsetMin);
      if (have.has(day)) continue;
      const at = new Date(t);
      scoped.push({
        date: day, firstActivity: at, lastActivity: at,
        spanMinutes: 0, periods: [], breakMinutes: 0, appMinutes: 0, visits: [], visitsCount: 0, visitsSec: 0, absent: true,
      });
    }
  }

  return scoped.sort((x, y) => x.date.localeCompare(y.date));
}
