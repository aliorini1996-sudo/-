// ============================================================================
// تنبيهات الحضور على جوال المندوب (طلب المالك، ٢١ أكتوبر ٢٠٢٦): «قبل بداية الدوام» و«نسيت تسجيل الانصراف».
//
// موعد الدوام اختياريّ لكل مندوب (SalesRep.shiftStart/shiftEnd/shiftDays، بتوقيت جواله tzOffsetMin):
//   • قبل الدوام: في الدقائق الخمس عشرة قبل بدايته، في يوم عمل، ولم يبصم حضوراً اليوم ولا نوبة مفتوحة.
//   • نسيت الانصراف: نوبةٌ مفتوحة بعد نهاية الدوام بنصف ساعة — وبلا موعد دوام: بعد ١٠ ساعات من الحضور.
// كل تنبيهٍ مرّةً واحدة: مفتاحه في ops_markers (الإنشاء الفريد قفل) — وإعادة تشغيل الخادم لا تكرّره.
// الحلقة كل خمس دقائق داخل الخادم (startAttendanceAlerts)، وATTENDANCE_ALERTS_ENABLED=false تطفئها.
// ============================================================================
import prisma from '../config/database';
import { sendPushToRep } from './webPush';

export const PRE_SHIFT_MIN = 15;
export const FORGOT_AFTER_END_MIN = 30;
export const FORGOT_NO_SHIFT_HOURS = 10;
export const ALERT_TICK_MS = 5 * 60 * 1000;
/** النوبات المفتوحة التي يُنبَّه على نسيان انصرافها: ما بدأ خلال هذه الأيام */
export const FORGOT_LOOKBACK_DAYS = 7;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** "HH:MM" ⇒ دقائق اليوم، أو null */
export function parseHM(v: string | null | undefined): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export interface AlertRep { id: string; shiftStart: string | null; shiftEnd: string | null; shiftDays: number; tzOffsetMin: number | null }
export interface AlertShift { id: string; checkInAt: Date; checkOutAt: Date | null }
export type AlertKind = 'PRE_SHIFT' | 'FORGOT_CHECKOUT';
export interface DueAlert { kind: AlertKind; key: string; at: Date }

const localDay = (t: number, tz: number) => new Date(t + tz * MIN).toISOString().slice(0, 10);
const dayStartUtc = (day: string, tz: number) => Date.parse(`${day}T00:00:00.000Z`) - tz * MIN;
const weekdayOf = (day: string) => new Date(`${day}T00:00:00.000Z`).getUTCDay(); // الأحد=0

/** التنبيهات المستحقّة الآن لمندوب — منطقٌ صرف (المفتاح يمنع التكرار عند المستدعي) */
export function dueAlerts(rep: AlertRep, shifts: readonly AlertShift[], now: Date): DueAlert[] {
  const out: DueAlert[] = [];
  const t = now.getTime();
  const tz = rep.tzOffsetMin;
  const open = shifts.filter((s) => !s.checkOutAt).sort((a, b) => b.checkInAt.getTime() - a.checkInAt.getTime())[0];
  const startMin = parseHM(rep.shiftStart);
  const endMin = parseHM(rep.shiftEnd);

  // قبل الدوام: موعدٌ اليوم أو غداً (دوامٌ يبدأ بعد منتصف الليل بقليل نافذته من مساء أمس)
  if (tz != null && startMin != null && !open) {
    for (const day of [localDay(t, tz), localDay(t + DAY, tz)]) {
      if ((rep.shiftDays & (1 << weekdayOf(day))) === 0) continue;
      const startAt = dayStartUtc(day, tz) + startMin * MIN;
      if (t < startAt - PRE_SHIFT_MIN * MIN || t >= startAt) continue;
      const dayStart = dayStartUtc(day, tz);
      const punched = shifts.some((s) => s.checkInAt.getTime() >= dayStart);
      if (!punched) out.push({ kind: 'PRE_SHIFT', key: `att:pre:${rep.id}:${day}`, at: new Date(startAt) });
      break;
    }
  }

  // نسيت الانصراف: نهاية الدوام في يوم الحضور (أو غده لدوامٍ ليليّ)، وإلّا ساعاتٌ من الحضور
  if (open) {
    const inAt = open.checkInAt.getTime();
    let deadline = inAt + FORGOT_NO_SHIFT_HOURS * 60 * MIN;
    if (tz != null && endMin != null) {
      let endAt = dayStartUtc(localDay(inAt, tz), tz) + endMin * MIN;
      if (endAt <= inAt && startMin != null && endMin <= startMin) endAt += DAY; // دوامٌ يعبر منتصف الليل
      if (endAt > inAt) deadline = endAt + FORGOT_AFTER_END_MIN * MIN;
    }
    if (t >= deadline) out.push({ kind: 'FORGOT_CHECKOUT', key: `att:out:${open.id}`, at: open.checkInAt });
  }
  return out;
}

const hhmm = (d: Date, tz: number | null) => new Date(d.getTime() + (tz ?? 0) * MIN).toISOString().slice(11, 16);

const TEXT: Record<string, Record<AlertKind, { title: string; body: (t: string) => string }>> = {
  ar: {
    PRE_SHIFT: { title: 'تذكير بالحضور', body: (t) => `يبدأ دوامك الساعة ${t} — لا تنسَ تسجيل الحضور` },
    FORGOT_CHECKOUT: { title: 'لم تسجّل انصرافك', body: (t) => `فترتك مفتوحة منذ ${t} — سجّل الانصراف إن انتهى عملك` },
  },
  en: {
    PRE_SHIFT: { title: 'Check-in reminder', body: (t) => `Your shift starts at ${t} — don’t forget to check in` },
    FORGOT_CHECKOUT: { title: 'You haven’t checked out', body: (t) => `Your shift has been open since ${t} — check out if you’ve finished` },
  },
  fr: {
    PRE_SHIFT: { title: 'Rappel de pointage', body: (t) => `Votre service commence à ${t} — n’oubliez pas de pointer l’arrivée` },
    FORGOT_CHECKOUT: { title: 'Sortie non pointée', body: (t) => `Votre période est ouverte depuis ${t} — pointez la sortie si vous avez terminé` },
  },
  tr: {
    PRE_SHIFT: { title: 'Giriş hatırlatması', body: (t) => `Mesainiz ${t}'de başlıyor — giriş yapmayı unutmayın` },
    FORGOT_CHECKOUT: { title: 'Çıkış yapmadınız', body: (t) => `Mesainiz ${t}'den beri açık — işiniz bittiyse çıkış yapın` },
  },
  zh: {
    PRE_SHIFT: { title: '签到提醒', body: (t) => `您的班次 ${t} 开始——别忘了签到` },
    FORGOT_CHECKOUT: { title: '您还未签退', body: (t) => `您的时段自 ${t} 起仍未结束——如已下班请签退` },
  },
};

/** نصّ التنبيه بلغة جهاز المندوب (العربية افتراضاً) */
export function alertPayload(kind: AlertKind, at: Date, tz: number | null, lang: string | null | undefined) {
  const tx = (TEXT[lang ?? 'ar'] ?? TEXT.ar)[kind];
  return { title: tx.title, body: tx.body(hhmm(at, tz)), url: '/rep?screen=attendance', tag: `att-${kind}` };
}

let lastCleanup = 0;

/** دورةٌ واحدة: المناديب المشتركون في شركاتٍ فعّلت البصمة، ثمّ تنبيهاتهم المستحقّة — كلٌّ بمفتاحه مرّةً واحدة */
export async function runAttendanceAlerts(now = new Date()): Promise<{ sent: number }> {
  const reps = await prisma.salesRep.findMany({
    where: { isActive: true, tenant: { attendanceEnabled: true, isActive: true }, pushSubscriptions: { some: {} } },
    select: { id: true, shiftStart: true, shiftEnd: true, shiftDays: true, tzOffsetMin: true, pushSubscriptions: { select: { lang: true }, orderBy: { updatedAt: 'desc' }, take: 1 } },
    take: 5000,
  });
  let sent = 0;
  if (reps.length) {
    const shifts = await prisma.repAttendance.findMany({
      // المفتوحة حتى أسبوعٍ مضى وحدها: نوبةٌ منسيّة أقدم نُبّه عليها في حينها، ومفتاحها باقٍ ما بقيت في هذه النافذة
      where: {
        salesRepId: { in: reps.map((r) => r.id) },
        OR: [{ checkOutAt: null, checkInAt: { gte: new Date(now.getTime() - FORGOT_LOOKBACK_DAYS * DAY) } }, { checkInAt: { gte: new Date(now.getTime() - 2 * DAY) } }],
      },
      select: { id: true, salesRepId: true, checkInAt: true, checkOutAt: true },
    });
    const byRep = new Map<string, AlertShift[]>();
    for (const s of shifts) { const a = byRep.get(s.salesRepId) ?? []; a.push(s); byRep.set(s.salesRepId, a); }
    // نوبةٌ منسيّة أقدم من النافذة لا يُنبَّه عليها ثانية، لكنها ما زالت نوبته المفتوحة (التطبيق يعرضه «حاضراً» والحضور
    // يعيدها): لا يُذكَّر بتسجيل حضورٍ لن يفتح نوبةً جديدة
    const staleOpen = new Set((await prisma.repAttendance.findMany({
      where: { salesRepId: { in: reps.map((r) => r.id) }, checkOutAt: null, checkInAt: { lt: new Date(now.getTime() - FORGOT_LOOKBACK_DAYS * DAY) } },
      select: { salesRepId: true }, distinct: ['salesRepId'],
    })).map((x) => x.salesRepId));
    for (const rep of reps) {
      for (const a of dueAlerts(rep, byRep.get(rep.id) ?? [], now)) {
        if (a.kind === 'PRE_SHIFT' && staleOpen.has(rep.id)) continue;
        // الإنشاء الفريد قفل: نسختان متزامنتان أو دورةٌ مكرّرة لا ترسلان التنبيه مرّتين
        const claimed = await prisma.opsMarker.create({ data: { key: a.key, value: a.kind } }).then(() => true, () => false);
        if (!claimed) continue;
        // عطلُ مندوبٍ واحد لا يوقف تنبيهات من بعده في كل الشركات
        sent += await sendPushToRep(rep.id, alertPayload(a.kind, a.at, rep.tzOffsetMin, rep.pushSubscriptions[0]?.lang)).catch(() => 0);
      }
    }
  }
  // تنظيفٌ كل ساعة: مفتاح «قبل الدوام» لا حاجة له بعد يومين، ومفتاح «نسيت الانصراف» يبقى بعد نافذة النوبات المفتوحة —
  // حذفُه قبلها يعيد التنبيه نفسه كل ثلاثة أيام لنوبةٍ منسيّة (وعد «مرّةً واحدة»)
  if (now.getTime() - lastCleanup > 60 * MIN) {
    lastCleanup = now.getTime();
    await prisma.opsMarker.deleteMany({ where: { key: { startsWith: 'att:pre:' }, createdAt: { lt: new Date(now.getTime() - 3 * DAY) } } });
    await prisma.opsMarker.deleteMany({ where: { key: { startsWith: 'att:out:' }, createdAt: { lt: new Date(now.getTime() - (FORGOT_LOOKBACK_DAYS + 3) * DAY) } } });
  }
  return { sent };
}

/** الحلقة الدورية — تبدأ مع الخادم */
export function startAttendanceAlerts(): void {
  if ((process.env.ATTENDANCE_ALERTS_ENABLED || '').trim().toLowerCase() === 'false') return;
  const tick = () => { runAttendanceAlerts().catch((e) => console.error('attendance-alerts:', (e as Error).message)); };
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, ALERT_TICK_MS).unref();
}
