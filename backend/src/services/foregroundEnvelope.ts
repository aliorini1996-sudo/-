// ============================================================================
// غلاف يوم العمل لنقاط الخلفية (قرار المالك، ٤ نوفمبر ٢٠٢٦).
//
// خدمة الموقع في التطبيق (RepLocation.source = 'device'، services/deviceTrack.ts) تسجّل من أول فتحٍ للتطبيق حتى منتصف الليل
// المحلي للجميع — ولو انصرف المندوب. فنقاطها وحدها لا تقول «كان يعمل»: المساء في البيت والطريق إليه أثرٌ لا عمل.
//
// القاعدة: نقطة الجهاز لا تمدّ يوم العمل أبعد من الأثر الأمامي لذلك اليوم المحلي —
//   • نقاط الصفحة (source IS NULL)، وجلسات التطبيق (RepSession: startedAt..lastBeatAt)، والزيارات (بدايتها ونهاية مؤقّتها)،
//     وبصمات الحضور والانصراف.
//   • الغلاف لكل يومٍ محلي = [أول أثرٍ أمامي، آخر أثرٍ أمامي]. نقطة الجهاز داخله تُعدّ (القيادة نهاراً والشاشة مقفلة صادقة)،
//     وخارجه لا (المساء بعد الانصراف، والتجوّل قبل أول فتح). ويومٌ بلا أثرٍ أمامي لا تُعدّ له نقطة جهازٍ واحدة.
//
// تقرير الساعات لا يحتاج الغلاف: نقطةٌ مقصوصة عليه لا تمدّ امتداداً أبداً، فاستبعاد نقاط الجهاز من طرفي اليوم هو المكافئ
// الدقيق (routes/reports.ts: "source" IS NULL). المسافة تحتاجه: الكيلو داخل اليوم يُجمع من النقاط نفسها.
//
// صرفٌ بلا قاعدة (tests/foreground-envelope.test.ts)، إلا جزء SQL يبنيه Prisma.sql بلا اتصال.
// ============================================================================
import { Prisma } from '@prisma/client';
import { dayKey, splitByLocalDay } from './workDay';

/** أثرٌ أمامي واحد: لحظة (end غائبة/null) أو فترة [start, end] — الفترة تُقسَم على الأيام المحلية */
export interface ForegroundEvidence { start: Date; end?: Date | null }

/** غلاف يومٍ محلي: من أول أثرٍ أمامي إلى آخره (شاملاً الطرفين) */
export interface EnvelopeWindow { day: string; start: Date; end: Date }

const valid = (d: Date | null | undefined): d is Date => d instanceof Date && Number.isFinite(d.getTime());

/** صفوف الأثر الأمامي كما تقرؤها القاعدة — بالمندوب والشركة وحدهما (routes/reports.ts، معيار distance) */
export interface ForegroundRows {
  /** طرفا نقاط الصفحة (source IS NULL) لكل (مندوب × يوم محلي) — مجمَّعان في القاعدة كتقرير الساعات */
  webDays: readonly { salesRepId: string; min: Date | string; max: Date | string }[];
  sessions: readonly { salesRepId: string; startedAt: Date; lastBeatAt: Date }[];
  visits: readonly { salesRepId: string; createdAt: Date; startedAt: Date | null; durationSec: number | null }[];
  shifts: readonly { salesRepId: string; checkInAt: Date; checkOutAt: Date | null }[];
}

/**
 * الأثر الأمامي لكل مندوب من صفوفه. كل مصدرٍ بمعناه في تقرير الساعات (services/workDay.ts composeWorkDays):
 *   • الجلسة فترةٌ (startedAt..lastBeatAt) تُقسَم على الأيام — التطبيق مفتوحٌ أمامه طوالها، ولو عبرت منتصف الليل.
 *   • الزيارة لحظة بدايتها (startedAt || createdAt)، ونهاية مؤقّتها لحظةٌ ثانية **في يومها نفسه وحده** — كما يمدّ composeWorkDays
 *     اليوم بها. مؤقّتٌ عالق بمدّةٍ تعبر الليل كان سيفتح المساء كلّه للجهاز.
 *   • البصمة لحظتها: الحضور لحظة والانصراف لحظة، لا النوبة بينهما فترة — نوبةٌ نُسي انصرافها حتى صباح الغد كانت ستفتح
 *     المساء والليل للجهاز بانصرافٍ من يومٍ آخر. والنوبة في يومٍ واحد (الغالب) غلافها هو نفسه باللحظتين.
 *   • نقاط الصفحة طرفاها لكل يوم.
 */
export function foregroundEvidenceByRep(rows: ForegroundRows, tzOffsetMin: number): Map<string, ForegroundEvidence[]> {
  const out = new Map<string, ForegroundEvidence[]>();
  const note = (rep: string, e: ForegroundEvidence) => { const a = out.get(rep); if (a) a.push(e); else out.set(rep, [e]); };
  for (const w of rows.webDays) { note(w.salesRepId, { start: new Date(w.min) }); note(w.salesRepId, { start: new Date(w.max) }); }
  for (const s of rows.sessions) note(s.salesRepId, { start: s.startedAt, end: s.lastBeatAt });
  for (const v of rows.visits) {
    const at = v.startedAt || v.createdAt;
    note(v.salesRepId, { start: at });
    if (v.durationSec && v.durationSec > 0 && valid(at)) {
      const end = new Date(at.getTime() + v.durationSec * 1000);
      if (dayKey(end, tzOffsetMin) === dayKey(at, tzOffsetMin)) note(v.salesRepId, { start: end });
    }
  }
  for (const a of rows.shifts) {
    note(a.salesRepId, { start: a.checkInAt });
    if (a.checkOutAt) note(a.salesRepId, { start: a.checkOutAt });
  }
  return out;
}

/**
 * غلاف كل يومٍ محلي من الأثر الأمامي، مرتّباً تصاعدياً. الفترة العابرة لمنتصف الليل (جلسة) تمدّ كل يومٍ بحصّته
 * (splitByLocalDay)، والفترة الفاسدة (نهاية قبل بدايتها) لحظتان. و`range` [from, to) يُسقط أغلفة الأيام التي لا تمسّه —
 * ومنها غلاف اليوم السابق الذي ينتهي عند `from` تماماً (حصّةُ جلسةٍ عبرت منتصف ليله): لحظة `from` ليومها هو، وغلافه يشملها.
 */
export function foregroundEnvelopes(
  evidence: readonly ForegroundEvidence[], tzOffsetMin: number, range?: { from: Date; to: Date },
): EnvelopeWindow[] {
  const byDay = new Map<string, EnvelopeWindow>();
  const widen = (day: string, at: Date) => {
    const w = byDay.get(day);
    if (!w) { byDay.set(day, { day, start: at, end: at }); return; }
    if (at < w.start) w.start = at;
    if (at > w.end) w.end = at;
  };
  for (const e of evidence) {
    if (!valid(e.start)) continue;
    const end = valid(e.end) ? e.end : null;
    if (end && end > e.start) {
      for (const part of splitByLocalDay({ start: e.start, end }, tzOffsetMin)) {
        widen(part.day, part.start);
        widen(part.day, part.end);
      }
      continue;
    }
    widen(dayKey(e.start, tzOffsetMin), e.start);
    if (end) widen(dayKey(end, tzOffsetMin), end);
  }
  return [...byDay.values()]
    .filter((w) => !range || (w.start < range.to && (w.end > range.from || w.start >= range.from)))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** لحظةٌ داخل أحد الأغلفة (شاملاً الطرفين) */
export function withinEnvelope(at: Date, windows: readonly EnvelopeWindow[]): boolean {
  const t = at.getTime();
  return windows.some((w) => t >= w.start.getTime() && t <= w.end.getTime());
}

/**
 * هل تُعدّ النقطة في المسافة؟ نقطة الصفحة (بلا مصدر) دائماً كما كانت، ونقطة الجهاز داخل غلاف يومها وحده.
 * المعنى نفسه الذي يكتبه deviceEnvelopeSql في القاعدة — مرجع الاختبار.
 */
export function countsTowardDistance(p: { capturedAt: Date; source?: string | null }, windows: readonly EnvelopeWindow[]): boolean {
  return p.source == null || withinEnvelope(p.capturedAt, windows);
}

/**
 * شرط SQL على rep_locations بمعنى countsTowardDistance: نقطة الصفحة ("source" IS NULL) أو لحظةٌ داخل أحد الأغلفة. يوضع في
 * WHERE نفسه قبل DISTINCT ON الدقيقة — لو قُصّ بعده لأزاحت نقطةُ جهازٍ ستُسقَط نقطةَ صفحةٍ في دقيقتها. اللحظات معاملاتٌ
 * كحدود المدى في الاستعلام نفسه (لا نصّ يُلصق)، وبلا غلافٍ تبقى نقاط الصفحة وحدها.
 */
export function deviceEnvelopeSql(windows: readonly EnvelopeWindow[]): Prisma.Sql {
  if (!windows.length) return Prisma.sql`("source" IS NULL)`;
  const inside = windows.map((w) => Prisma.sql`("capturedAt" >= ${w.start} AND "capturedAt" <= ${w.end})`);
  return Prisma.sql`("source" IS NULL OR ${Prisma.join(inside, ' OR ')})`;
}
