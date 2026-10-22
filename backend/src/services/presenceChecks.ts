// ============================================================================
// التحقق العشوائي من التواجد (طلب المالك، ٢٢ أكتوبر ٢٠٢٦) — قيدٌ على المندوب (SalesRep.requirePresenceCheck).
//
// يصله إشعار «أثبت تواجدك» مرّتين إلى ثلاثاً في اليوم بأوقاتٍ عشوائية متفرّقة أثناء نوبته المفتوحة، فيفتح التطبيق ويضغط
// «أثبت تواجدي» خلال دقيقتين، فيُؤخذ موقعه بقراءةٍ طازجة ويظهر للإدارة: في الوقت، أو متأخراً، أو بلا ردّ، ومعه موقعه ومسافة
// أقرب عملائه وجهازه. الضغط شرط (لا ردٌّ تلقائي): جوالٌ متروك على طاولةٍ عند العميل لا يجيب عن صاحبه.
//
// المواعيد تُخطَّط على الخادم عند أول نوبةٍ مفتوحة في يوم المندوب، ولا تصل التطبيق قبل وقتها — فلا يُتنبّأ بها: كل موعدٍ
// يُسحب مستقلاً (crypto) على نافذة الدوام كلها بفاصلٍ أدنى قصير، وعددها (٢ أو ٣) سرّ — فلا «فترة آمنة» بعد طلبٍ ولا يُعرف
// أن اليوم انتهى من توقيت الثاني. وموعدٌ يحلّ والنوبة مغلقة (استراحة) يُؤجَّل عشوائياً داخل نافذته، فإن لم يبقَ منها شيء
// سقط (SKIPPED) — ونوبةٌ تالية بعد استراحةٍ طويلة (دوامٌ على فترتين) يُوزَّع عليها ما لم يُرسل.
// الحلقة كل ٣٠ ثانية داخل الخادم (startPresenceChecks)، وPRESENCE_CHECKS_ENABLED=false تطفئها.
// ============================================================================
import crypto from 'crypto';
import prisma from '../config/database';
import { sendPushToRep } from './webPush';
import { parseHM } from './attendanceAlerts';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** الردّ في الوقت: خلال دقيقتين من الإرسال */
export const PRESENCE_RESPONSE_MS = 2 * MIN;
/** هامش وصول الردّ عبر شبكةٍ ميدانية بطيئة — قراءة الموقع الطازجة نفسها تأخذ ثوانٍ */
export const PRESENCE_GRACE_MS = 20 * 1000;
/** بعد الدقيقتين يُقبل الردّ «متأخراً» حتى ربع ساعة، ثم «بلا ردّ» */
export const PRESENCE_LATE_MS = 15 * MIN;
/** لا تحقّق في أول عشرين دقيقة من الحضور ولا في آخر عشرين قبل نهاية الدوام */
export const PRESENCE_EDGE_MS = 20 * MIN;
/** أقلّ فاصل بين تحقّقين — قصيرٌ عمداً: فاصلٌ طويل «فترةٌ آمنة» مضمونة بعد كل طلب */
export const PRESENCE_MIN_GAP_MS = 20 * MIN;
/** مندوبٌ بلا موعد نهاية دوام: النافذة تسع ساعات من حضوره */
export const PRESENCE_NO_END_MS = 9 * 60 * MIN;
/** نافذةٌ أقصر من هذا لا تحقّق فيها */
export const PRESENCE_MIN_WINDOW_MS = 10 * MIN;
/** موعدٌ حلّ والنوبة مغلقة: يُؤجَّل بين هذين عشوائياً */
export const PRESENCE_POSTPONE_MIN_MS = 10 * MIN;
export const PRESENCE_POSTPONE_MAX_MS = 40 * MIN;
export const PRESENCE_TICK_MS = 30 * 1000;
/**
 * لحظة الضغط (tap) يُحكم بها ما دام الردّ وصل خلال هذه المدّة بعدها — قراءة الموقع (≤ ٢٠ث) والشبكة لا تُحسبان على المندوب.
 * وأطول منها نافذة غشّ: يضغط ثم يقطع الشبكة ويمشي إلى العميل ويرسل موقعه من هناك «في الوقت»
 */
export const PRESENCE_TAP_HOLD_MS = 75 * 1000;
/** استراحةٌ بين نوبتين في اليوم بهذا الطول فأكثر: مواعيدها المؤجَّلة تُوزَّع من جديد على النوبة التالية (لا تتكدّس فور العودة) */
export const PRESENCE_REPLAN_BREAK_MS = 30 * MIN;
/** بلا موعد نهاية وحضورٌ نهاري: النافذة لا تتجاوز الحادية عشرة ليلاً بتوقيته — لا طلب بعد منتصف الليل لدوامٍ نهاري */
const NO_END_CAP_MIN = 23 * 60;
/** حضورٌ من هذه الساعة فما بعدها بلا موعد نهاية: دوامٌ مسائي/ليلي — تسع ساعاتٍ كاملة (سقف الليل كان يضمن له ساعاتٍ آمنة) */
const EVENING_START_MIN = 17 * 60;
/** نوبةٌ مفتوحة منذ أيام (نسي الانصراف) ما زالت تُخطَّط لها أيامها — حتى هذا */
export const PRESENCE_STALE_OPEN_DAYS = 7;
export const PRESENCE_PLAN_EVERY_MS = 2 * MIN;
/** مندوبٌ لم يبلغ توقيت جواله بعد (لا اشتراك تنبيهات): يوم الرياض */
const DEFAULT_TZ_MIN = 180;

export type PresenceStatus = 'SCHEDULED' | 'SENT' | 'PASSED' | 'LATE' | 'MISSED' | 'SKIPPED';
export type Rand = () => number;

/** [0,1) من مولّد التشفير — مواعيدٌ لا يستنتجها من يعرف مواعيد الأيام السابقة */
export const secureRandom: Rand = () => crypto.randomInt(0, 2 ** 30) / 2 ** 30;

/** عدد تحقّقات اليوم: مرّتان أو ثلاث */
export const dailyCount = (rand: Rand = secureRandom): number => (rand() < 0.5 ? 2 : 3);

/**
 * مواعيد عشوائية داخل [start, end): كل موعدٍ يُسحب مستقلاً بتوزيعٍ منتظم على النافذة كلها، ويُعاد السحب كله إن تقارب
 * موعدان دون الفاصل الأدنى. لا أقسام: تقسيم النافذة كان يضمن «فترةً آمنة» بعد كل طلب، ويكشف من توقيت الثاني أن اليوم
 * انتهى. نافذةٌ لا تتّسع للعدد تُنقصه.
 */
export function planTimes(start: number, end: number, count: number, rand: Rand = secureRandom): number[] {
  const span = end - start;
  if (!(span >= PRESENCE_MIN_WINDOW_MS) || count <= 0) return [];
  for (let n = Math.min(count, Math.floor(span / PRESENCE_MIN_GAP_MS) + 1); n >= 1; n--) {
    for (let tries = 0; tries < 200; tries++) {
      const ts = Array.from({ length: n }, () => Math.floor(start + rand() * span)).sort((a, b) => a - b);
      if (ts.every((t, i) => i === 0 || t - ts[i - 1] >= PRESENCE_MIN_GAP_MS)) return ts;
    }
  }
  return [];
}

const localDay = (t: number, tz: number) => new Date(t + tz * MIN).toISOString().slice(0, 10);
const dayStartUtc = (day: string, tz: number) => Date.parse(`${day}T00:00:00.000Z`) - tz * MIN;

export interface PresenceRep { shiftStart: string | null; shiftEnd: string | null; tzOffsetMin: number | null }

/**
 * نافذة تحقّقات نوبة المندوب: من الحضور (بعد عشرين دقيقة) أو الآن، إلى نهاية دوامه (قبلها بعشرين دقيقة). وبلا موعد نهاية (أو
 * حضورٍ بعد موعده): تسع ساعات من الحضور لا تتجاوز الحادية عشرة ليلاً. ويوم المندوب بتوقيت جواله — وفي الدوام الليلي (البداية
 * بعد النهاية) حضورٌ بعد منتصف الليل من ليلة أمس.
 */
export function presenceWindow(rep: PresenceRep, checkInAt: Date, now: Date): { day: string; start: number; end: number; windowEndAt: number } {
  const tz = rep.tzOffsetMin ?? DEFAULT_TZ_MIN;
  const inAt = checkInAt.getTime();
  const endMin = parseHM(rep.shiftEnd);
  const startMin = parseHM(rep.shiftStart);
  const overnight = endMin != null && startMin != null && endMin <= startMin;
  const minuteOfDay = Math.floor((((inAt + tz * MIN) % DAY) + DAY) % DAY / MIN);
  const day = overnight && minuteOfDay < endMin! + 180 ? localDay(inAt - DAY, tz) : localDay(inAt, tz);
  const start = Math.max(now.getTime() + 5 * MIN, inAt + PRESENCE_EDGE_MS);
  const cap = minuteOfDay >= EVENING_START_MIN ? Infinity : dayStartUtc(localDay(inAt, tz), tz) + NO_END_CAP_MIN * MIN;
  let endAt = Math.min(inAt + PRESENCE_NO_END_MS, cap);
  if (endMin != null) {
    // حضورٌ قبل نهاية دوامه (ولو في دقائقه الأخيرة) نافذته إلى نهايته — مسار «بلا نهاية» لحضورٍ بعدها وحده
    const at = dayStartUtc(day, tz) + endMin * MIN + (overnight ? DAY : 0);
    if (at > inAt) endAt = at;
  }
  return { day, start, end: endAt - PRESENCE_EDGE_MS, windowEndAt: endAt };
}

/** حكم الردّ بلحظته (لحظة الضغط إن سُجّلت): في الوقت، أو متأخر، أو فات (null) */
export function presenceOutcome(sentAt: Date, at: Date): 'PASSED' | 'LATE' | null {
  const d = at.getTime() - sentAt.getTime();
  if (d <= PRESENCE_RESPONSE_MS + PRESENCE_GRACE_MS) return 'PASSED';
  if (d <= PRESENCE_LATE_MS) return 'LATE';
  return null;
}

/** طلب التحقق المعلّق للمندوب الآن (أُرسل ولم يُجَب ولم يَفُت) — ما يعرضه التطبيق، بلا أيّ موعدٍ قادم */
export async function pendingPresence(tid: string, repId: string, now = new Date()) {
  const c = await prisma.presenceCheck.findFirst({
    where: { tenantId: tid, salesRepId: repId, status: 'SENT', sentAt: { gt: new Date(now.getTime() - PRESENCE_LATE_MS) } },
    orderBy: { sentAt: 'desc' },
    select: { id: true, sentAt: true },
  });
  if (!c?.sentAt) return null;
  const sent = c.sentAt.getTime();
  return {
    id: c.id,
    sentAt: c.sentAt.toISOString(),
    deadline: new Date(sent + PRESENCE_RESPONSE_MS).toISOString(),
    until: new Date(sent + PRESENCE_LATE_MS).toISOString(),
    serverNow: now.getTime(),
  };
}

const TEXT: Record<string, { title: string; body: string }> = {
  ar: { title: 'أثبت تواجدك', body: 'افتح التطبيق خلال دقيقتين واضغط «أثبت تواجدي»' },
  en: { title: 'Confirm you’re on site', body: 'Open the app within 2 minutes and tap “Confirm my presence”' },
  fr: { title: 'Confirmez votre présence', body: 'Ouvrez l’application dans les 2 minutes et touchez « Confirmer ma présence »' },
  tr: { title: 'Konumunuzu doğrulayın', body: 'Uygulamayı 2 dakika içinde açın ve “Varlığımı doğrula”ya dokunun' },
  zh: { title: '请确认您在岗', body: '请在 2 分钟内打开应用并点击“确认我在岗”' },
};

/** نصّ الإشعار بلغة جهاز المندوب — ويفتح طلب التحقق في التطبيق */
export function presencePayload(lang: string | null | undefined, checkId?: string) {
  const tx = TEXT[lang ?? 'ar'] ?? TEXT.ar;
  // checkId: التطبيق يُغلق إشعار هذا الطلب وحده (لا إشعار طلبٍ أحدث)
  return { title: tx.title, body: tx.body, url: '/rep?screen=presence', tag: 'presence', ...(checkId ? { checkId } : {}) };
}

/** يوم عملٍ في أيام دوامه (بتات الأحد=1 … السبت=64) */
const isWorkday = (day: string, shiftDays: number) => (shiftDays & (1 << new Date(`${day}T00:00:00.000Z`).getUTCDay())) !== 0;

/** المندوب المؤهّل الآن: القيد مفعّل، نشط، وشركته فعّلت البصمة وما زالت نشطة */
const ELIGIBLE_REP = { requirePresenceCheck: true, isActive: true, tenant: { attendanceEnabled: true, isActive: true } } as const;

/** يُكتب تخطيطٌ جديد لليوم إن لم يُطالَب به قبلُ (مفتاح ops_markers قفلٌ ضد تكراره) */
async function writePlan(rep: { id: string; tenantId: string }, w: ReturnType<typeof presenceWindow>, rand: Rand): Promise<number> {
  const claimed = await prisma.opsMarker.create({ data: { key: `pc:plan:${rep.id}:${w.day}`, value: 'plan' } }).then(() => true, () => false);
  if (!claimed) return 0;
  const times = planTimes(w.start, w.end, dailyCount(rand), rand);
  if (!times.length) return 0;
  await prisma.presenceCheck.createMany({
    data: times.map((t) => ({ tenantId: rep.tenantId, salesRepId: rep.id, day: w.day, dueAt: new Date(t), windowEndAt: new Date(w.windowEndAt) })),
  });
  return times.length;
}

/**
 * تخطيط يوم المندوب من نوبته المفتوحة — كل نوبةٍ تُعالَج مرّةً (مفتاح pc:shift:<نوبة>):
 *  • أول نوبةٍ في يومه: خطّة اليوم (٢ أو ٣) في نافذتها.
 *  • نوبةٌ تالية بعد استراحةٍ طويلة (دوامٌ على فترتين): ما لم يُرسل بعد (مؤجَّلٌ أو سقط) يُوزَّع من جديد على نافذتها هي —
 *    لا يتكدّس فور العودة، ولا يبقى المساء بلا تحقّق. واستراحةٌ قصيرة لا تعيد التوزيع (فلا «إعادة سحب» بانصرافٍ وحضورٍ متتاليين).
 *  • نوبةٌ مفتوحة انتهت نافذتها (نسي الانصراف): يوم عملٍ جديد يُخطَّط له من موعد بداية دوامه (أو ساعة حضوره الأول) —
 *    فترك الانصراف لا يُعفي من التحقق، ولا يصله طلبٌ في منتصف الليل.
 */
async function planDays(now: Date, rand: Rand): Promise<number> {
  const reps = await prisma.salesRep.findMany({
    where: { ...ELIGIBLE_REP, attendance: { some: { checkOutAt: null, checkInAt: { gte: new Date(now.getTime() - PRESENCE_STALE_OPEN_DAYS * DAY) } } } },
    select: {
      id: true, tenantId: true, shiftStart: true, shiftEnd: true, shiftDays: true, tzOffsetMin: true,
      attendance: { where: { checkOutAt: null }, orderBy: { checkInAt: 'desc' }, take: 1, select: { id: true, checkInAt: true } },
    },
    take: 5000,
  });
  let planned = 0;
  for (const rep of reps) {
    const open = rep.attendance[0];
    if (!open) continue;
    const w = presenceWindow(rep, open.checkInAt, now);
    const tz = rep.tzOffsetMin ?? DEFAULT_TZ_MIN;
    const today = localDay(now.getTime(), tz);

    if (now.getTime() < w.windowEndAt) {
      // نوبةٌ جارية في نافذتها — تُعالَج مرّةً
      const shiftKey = `pc:shift:${open.id}`;
      if (await prisma.opsMarker.findUnique({ where: { key: shiftKey }, select: { key: true } })) continue;
      const dayRows = await prisma.presenceCheck.findMany({ where: { salesRepId: rep.id, day: w.day }, select: { id: true, status: true } });
      if (!dayRows.length) {
        planned += await writePlan(rep, w, rand);
      } else {
        const pending = dayRows.filter((r) => r.status === 'SCHEDULED' || r.status === 'SKIPPED');
        const lastOut = pending.length ? await prisma.repAttendance.findFirst({
          where: { salesRepId: rep.id, checkOutAt: { not: null, lte: open.checkInAt } },
          orderBy: { checkOutAt: 'desc' }, select: { checkOutAt: true },
        }) : null;
        const longBreak = lastOut?.checkOutAt != null && open.checkInAt.getTime() - lastOut.checkOutAt.getTime() >= PRESENCE_REPLAN_BREAK_MS;
        if (pending.length && longBreak) {
          // من الآن لا من الحضور + عشرين دقيقة: هامشٌ بعد كل عودة «فترةٌ آمنة» مضمونة يُستغلّ بحضورٍ وانصرافٍ متناوبين
          const times = planTimes(Math.max(now.getTime() + MIN, open.checkInAt.getTime()), w.end, pending.length, rand);
          for (let k = 0; k < times.length; k++) {
            await prisma.presenceCheck.updateMany({
              where: { id: pending[k].id, status: { in: ['SCHEDULED', 'SKIPPED'] } },
              data: { status: 'SCHEDULED', dueAt: new Date(times[k]), windowEndAt: new Date(w.windowEndAt) },
            });
          }
          planned += times.length;
        }
      }
      await prisma.opsMarker.create({ data: { key: shiftKey, value: 'shift' } }).catch(() => { /* دورةٌ متزامنة سبقت */ });
      continue;
    }

    // نوبةٌ مفتوحة انتهت نافذتها (نسي الانصراف): يومُ عملٍ جديد مرّةً (مفتاح pc:plan:<مندوب>:<يوم>)
    if (!isWorkday(today, rep.shiftDays)) continue;
    const startMin = parseHM(rep.shiftStart) ?? Math.floor(((open.checkInAt.getTime() + tz * MIN) % DAY) / MIN);
    const anchor = dayStartUtc(today, tz) + startMin * MIN;
    if (now.getTime() < anchor) continue;
    if (await prisma.presenceCheck.count({ where: { salesRepId: rep.id, day: today } })) continue;
    planned += await writePlan(rep, presenceWindow(rep, new Date(anchor), now), rand);
  }
  return planned;
}

/** إرسال ما حلّ موعده — والنوبة مغلقة تؤجّله، والمندوب غير المؤهّل يُسقطه */
async function dispatchDue(now: Date, rand: Rand): Promise<number> {
  const due = await prisma.presenceCheck.findMany({
    where: { status: 'SCHEDULED', dueAt: { lte: now } },
    orderBy: { dueAt: 'asc' },
    take: 200,
    select: { id: true, salesRepId: true, windowEndAt: true },
  });
  if (!due.length) return 0;
  const ids = [...new Set(due.map((d) => d.salesRepId))];
  const [reps, open] = await Promise.all([
    prisma.salesRep.findMany({
      where: { id: { in: ids }, ...ELIGIBLE_REP },
      select: { id: true, pushSubscriptions: { select: { lang: true }, orderBy: { updatedAt: 'desc' }, take: 1 } },
    }),
    prisma.repAttendance.findMany({ where: { salesRepId: { in: ids }, checkOutAt: null }, select: { salesRepId: true }, distinct: ['salesRepId'] }),
  ]);
  const eligible = new Map(reps.map((r) => [r.id, r]));
  const onShift = new Set(open.map((o) => o.salesRepId));
  // له طلبٌ ما زال معلّقاً أو أُرسل له قبل أقلّ من الفاصل الأدنى: طلبان متلاصقان (موعدان تأجّلا في استراحةٍ واحدة) يحلّ
  // إشعار ثانيهما محلّ الأول فيُحسب أحدهما «بلا ردّ» ظلماً — فيُؤجَّل الثاني
  const busy = new Set((await prisma.presenceCheck.findMany({
    where: { salesRepId: { in: ids }, sentAt: { gt: new Date(now.getTime() - PRESENCE_LATE_MS) } },
    select: { salesRepId: true, status: true, sentAt: true },
  })).filter((x) => x.status === 'SENT' || (x.sentAt != null && now.getTime() - x.sentAt.getTime() < PRESENCE_MIN_GAP_MS)).map((x) => x.salesRepId));
  let sent = 0;
  for (const c of due) {
    const rep = eligible.get(c.salesRepId);
    if (!rep) { await prisma.presenceCheck.updateMany({ where: { id: c.id, status: 'SCHEDULED' }, data: { status: 'SKIPPED' } }); continue; }
    if (!onShift.has(c.salesRepId) || busy.has(c.salesRepId)) {
      // استراحة أو انصرافٌ مبكر (أو طلبٌ قريب): يُؤجَّل عشوائياً داخل نافذته — فلا يُعرف أنه سيحلّ فور العودة، ولا يُنجى منه
      // بالانصراف
      const room = c.windowEndAt.getTime() - now.getTime();
      if (room < PRESENCE_POSTPONE_MIN_MS) {
        await prisma.presenceCheck.updateMany({ where: { id: c.id, status: 'SCHEDULED' }, data: { status: 'SKIPPED' } });
      } else {
        const hi = Math.min(PRESENCE_POSTPONE_MAX_MS, room);
        const at = now.getTime() + PRESENCE_POSTPONE_MIN_MS + Math.floor(rand() * (hi - PRESENCE_POSTPONE_MIN_MS));
        await prisma.presenceCheck.updateMany({ where: { id: c.id, status: 'SCHEDULED' }, data: { dueAt: new Date(at) } });
      }
      continue;
    }
    // التحويل الشرطيّ قفل: دورتان متزامنتان لا ترسلان الطلب مرّتين
    const claimed = await prisma.presenceCheck.updateMany({ where: { id: c.id, status: 'SCHEDULED' }, data: { status: 'SENT', sentAt: now } });
    if (claimed.count !== 1) continue;
    busy.add(c.salesRepId);
    // صلاحية الإشعار مدّة قبول الردّ: جوالٌ عاد للشبكة بعدها لا يُعرض عليه طلبٌ فات
    const pushSent = await sendPushToRep(rep.id, presencePayload(rep.pushSubscriptions[0]?.lang, c.id), { ttlSec: PRESENCE_LATE_MS / 1000 }).catch(() => 0);
    await prisma.presenceCheck.update({ where: { id: c.id }, data: { pushSent } });
    sent++;
  }
  return sent;
}

let lastPlan = 0;
let lastCleanup = 0;

/** دورةٌ واحدة: ما فات بلا ردّ ⇐ MISSED، وتخطيط الأيام الجديدة، وإرسال ما حلّ */
export async function runPresenceChecks(now = new Date(), rand: Rand = secureRandom): Promise<{ planned: number; sent: number; missed: number }> {
  // فات ربع الساعة بلا ردّ — إلا من ضغط وردُّه في الطريق (قراءة موقعه أو شبكته البطيئة) فيُمهَل حتى يصل
  const missed = (await prisma.presenceCheck.updateMany({
    where: {
      status: 'SENT', sentAt: { lt: new Date(now.getTime() - PRESENCE_LATE_MS) },
      OR: [{ tappedAt: null }, { tappedAt: { lt: new Date(now.getTime() - PRESENCE_TAP_HOLD_MS) } }],
    },
    data: { status: 'MISSED' },
  })).count;
  let planned = 0;
  if (now.getTime() - lastPlan >= PRESENCE_PLAN_EVERY_MS) {
    lastPlan = now.getTime();
    planned = await planDays(now, rand);
  }
  const sent = await dispatchDue(now, rand);
  if (now.getTime() - lastCleanup > 60 * MIN) {
    lastCleanup = now.getTime();
    await prisma.opsMarker.deleteMany({ where: { key: { startsWith: 'pc:plan:' }, createdAt: { lt: new Date(now.getTime() - (PRESENCE_STALE_OPEN_DAYS + 3) * DAY) } } });
    await prisma.opsMarker.deleteMany({ where: { key: { startsWith: 'pc:shift:' }, createdAt: { lt: new Date(now.getTime() - (PRESENCE_STALE_OPEN_DAYS + 3) * DAY) } } });
  }
  return { planned, sent, missed };
}

/** للاختبار وحده */
export const _resetPresenceLoop = (): void => { lastPlan = 0; lastCleanup = 0; };

/** الحلقة الدورية — تبدأ مع الخادم */
export function startPresenceChecks(): void {
  if ((process.env.PRESENCE_CHECKS_ENABLED || '').trim().toLowerCase() === 'false') return;
  let running = false;
  const tick = () => {
    if (running) return; // دورةٌ بطيئة لا تتداخل مع التالية
    running = true;
    runPresenceChecks()
      .catch((e) => console.error('presence-checks:', (e as Error).message))
      .finally(() => { running = false; });
  };
  setTimeout(tick, 45 * 1000).unref();
  setInterval(tick, PRESENCE_TICK_MS).unref();
}
