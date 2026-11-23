// ============================================================================
// «تذكير بالانصراف عند الخمول ثم انصراف تلقائي» (طلب المالك، ٢٣ نوفمبر ٢٠٢٦) — قيدٌ على المندوب يُفعَّل ويُطفأ
// (SalesRep.idlePunchOutEnabled) بمدّتين تحدّدهما الإدارة لكل مندوب كالمسافة: دقائق الخمول قبل التذكير
// (idlePunchOutMinutes، ٤٥ افتراضاً، ١٠–٤٨٠) ومهلة الردّ بعده قبل الانصراف التلقائي (idlePunchOutGraceMinutes، ١٥ افتراضاً، ٥–١٢٠).
//
// نوبةٌ مفتوحة ومندوبٌ «غير نشط ولا يحدّد موقعه» منذ دقائق الخمول ⇒ إشعار «سجّل بصمة الانصراف إن انتهى عملك» مرّةً لكل فترة
// خمول (RepAttendance.idleRemindedAt). فإن لم يُرصد له نشاطٌ بعد التذكير حتى تنقضي المهلة ⇒ انصرافٌ تلقائي **بوقت آخر نشاطٍ له**
// لا بوقت الدورة (قرار المالك)، موسومٌ RepAttendance.checkOutAuto («انصراف تلقائي»)، وسطرٌ في AttendanceAudit باسم «النظام».
//
// «النشاط» أحدث هذه — وما قبل بصمة الحضور لا يُحسب (الحضور نفسه أرضيّته):
//   • آخر ظهور (SalesRep.lastSeenAt، بساعة الخادم): نبضة التطبيق المفتوح كل دقيقة (وهي RepSession.lastBeatAt نفسها) ونقاط
//     موقع الصفحة. وضغطة «ما زلت أعمل» (POST /api/tracking/attendance/still-working) تكتبه الآن.
//   • آخر **حركة** من تتبّع الخلفية الأصلي (RepLocation.source='device'): الخدمة تحفظ نقطةً كل ٣٠ث والجوال ساكن وتستمرّ حتى
//     منتصف الليل ولو انصرف (services/deviceTrack.ts) — فمجرّد وصول نقطةٍ منها لا يشهد بعمل، وإلا لما خمل صاحب التطبيق الأصلي
//     قبل منتصف الليل. يشهد انتقاله وحده: نقطةٌ دقيقة تبعد عن سابقتها المعتمدة أكثر من IDLE_MOVE_M وأكثر من هامشَي خطئهما —
//     بوقتٍ بساعة الخادم (لحظة الاستلام، pointActivityAt) لا بساعة جوالٍ قد تتأخّر فتُصرف حركةُ من يقود الآن.
// وأيّ نشاطٍ بعد التذكير يعيد الدورة من أوّلها تلقائياً (idleDecision): لا انصراف، وتذكيرٌ جديد بعد خمولٍ جديد كامل.
//
// الحلقة كل دقيقة داخل الخادم (startIdlePunchOut) بجانب التحقق من التواجد، وIDLE_PUNCH_OUT_ENABLED=false تطفئها. لا ترمي أبداً.
// ============================================================================
import prisma from '../config/database';
import { sendPushToRep } from './webPush';
import { lockRepAttendance, auditTimes, REP_LOCK_TX } from './attendanceEdit';
import { haversineM } from './routeShape';
import { LOCATION_SOURCE_DEVICE } from './deviceTrack';
import { AUTO_CHECKOUT_EDITOR } from './workDay';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** دقائق الخمول قبل التذكير: الافتراض والحدّان (التحقّق في routes/salesReps.ts) */
export const IDLE_MINUTES_DEFAULT = 45;
export const IDLE_MINUTES_MIN = 10;
export const IDLE_MINUTES_MAX = 480;
/** مهلة الردّ بعد التذكير قبل الانصراف التلقائي */
export const IDLE_GRACE_DEFAULT = 15;
export const IDLE_GRACE_MIN = 5;
export const IDLE_GRACE_MAX = 120;
export const IDLE_TICK_MS = 60 * 1000;
/** نوبةٌ مفتوحة منذ أكثر من هذا (نسي الانصراف قبل أيام) لا تُمسّ — كـPRESENCE_STALE_OPEN_DAYS */
export const IDLE_STALE_OPEN_DAYS = 7;
/** أقلّ انتقالٍ يشهد بحركة من نقاط الخلفية — فوق انجراف GPS لجوالٍ ساكن داخل مبنى */
export const IDLE_MOVE_M = 150;
/** نقطةٌ أرخى دقّةً من هذا لا تُحسب في الحركة (قفزات الشبكة الخلوية) */
export const IDLE_MOVE_MAX_ACCURACY_M = 100;
/** أقصى نقاط الخلفية في قراءةٍ أولى لنوبة — الأحدث منها (ساعاتٌ من الأثر)، ثم قراءاتٌ تزايدية صغيرة */
export const IDLE_DEVICE_SCAN_MAX = 3000;
/**
 * أقصى تأخّرٍ يُصدَّق بين التقاط نقطة الخلفية واستلامها: الرفع العاديّ يصل خلال ٣٠–٦٠ث، وما تأخّر أكثر (ساعة جهازٍ متأخّرة،
 * أو دفعةٌ رُفعت بعد انقطاع) يُحسب نشاطاً قبل استلامه بهذا القدر وحده — ساعة الخادم هي الحَكَم لا ساعة الجوال
 */
export const IDLE_UPLOAD_LAG_MS = 5 * MIN;
/**
 * حدٌّ رخوٌ على لحظة الالتقاط (بساعة الجهاز) يُبقي القراءة في مدى فهرس (tenantId, salesRepId, capturedAt) — والفرز الحقيقيّ
 * على createdAt (ساعة الخادم). جهازٌ تتأخّر ساعته أكثر منه لا تُرى نقاطه (كـNATIVE_ROW_LOOKBACK_MS في deviceTrack.ts)
 */
export const IDLE_SKEW_WINDOW_MS = 12 * 60 * MIN;
/** «ما زال التذكير معلّقاً» في التطبيق: داخل المهلة وهامش دورتين — بعدها والنوبة مفتوحة فقد رُصد نشاطٌ أعاد الدورة */
export const IDLE_PENDING_SLACK_MS = 2 * MIN;
/** «ما زلت أعمل» بعد أن سبقه الانصراف التلقائي: نافذة نسبة ردّ 409 إليه (autoCheckedOut) منذ لحظة القرار — تتّسع للمهلة القصوى */
export const IDLE_AUTO_OUT_RECENT_MS = 12 * 60 * MIN;
/** رمز رفض الإعدادات خارج الحدّين */
export const IDLE_RANGE_CODE = 'IDLE_PUNCH_OUT_RANGE';
/** سبب سطر التدقيق ومنفّذه */
export const IDLE_AUDIT_ACTION = 'AUTO_CHECKOUT';
export const IDLE_AUDIT_REASON = 'انصراف تلقائي بعد خمول';
export const IDLE_ACTOR_ID = 'system';
export const IDLE_ACTOR_NAME = AUTO_CHECKOUT_EDITOR;

const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
/** المدّتان كما خُزّنتا — وقيمةٌ فاسدة (يدويّاً في القاعدة) تعود إلى الافتراض فلا يسقط القيد ولا ينصرف أحدٌ بعد دقيقة */
export const idleMinutesOf = (v: unknown): number => (intIn(v, IDLE_MINUTES_MIN, IDLE_MINUTES_MAX) ? v : IDLE_MINUTES_DEFAULT);
export const idleGraceOf = (v: unknown): number => (intIn(v, IDLE_GRACE_MIN, IDLE_GRACE_MAX) ? v : IDLE_GRACE_DEFAULT);

/** رفض إعدادَي القيد خارج حدّيهما برسالةٍ عربية — المرسل منهما وحده يُفحص (null = سليم) */
export function idleSettingsError(b: { idlePunchOutMinutes?: unknown; idlePunchOutGraceMinutes?: unknown }): string | null {
  if (b.idlePunchOutMinutes !== undefined && !intIn(b.idlePunchOutMinutes, IDLE_MINUTES_MIN, IDLE_MINUTES_MAX)) {
    return `دقائق الخمول قبل التذكير عددٌ صحيح من ${IDLE_MINUTES_MIN} إلى ${IDLE_MINUTES_MAX} دقيقة`;
  }
  if (b.idlePunchOutGraceMinutes !== undefined && !intIn(b.idlePunchOutGraceMinutes, IDLE_GRACE_MIN, IDLE_GRACE_MAX)) {
    return `مهلة الرد قبل الانصراف التلقائي عددٌ صحيح من ${IDLE_GRACE_MIN} إلى ${IDLE_GRACE_MAX} دقيقة`;
  }
  return null;
}

// ═══ القرار — منطقٌ صرف ═══

export type IdleVerdict = 'NONE' | 'REMIND' | 'AUTO_OUT';
export interface IdleInput {
  checkInAt: Date;
  /** آخر نشاطٍ معروف (null = لا أثر) — ما قبل الحضور يُرفع إليه */
  lastActive: Date | null;
  idleRemindedAt: Date | null;
  now: Date;
  idleMinutes: number;
  graceMinutes: number;
  /** القيد مفعّلٌ والمندوب نشط (غائبٌ = نعم: الدورة تختار المؤهّلين في الاستعلام، وهذا حارسٌ ثانٍ صرف) — false ⇒ NONE دائماً */
  enabled?: boolean;
}
export interface IdleResult {
  verdict: IdleVerdict;
  /** آخر نشاطٍ بعد رفعه إلى الحضور (ولا يتجاوز الآن) */
  lastActive: Date;
  /** وقت الانصراف التلقائي = آخر نشاط (AUTO_OUT وحدها) */
  checkOutAt: Date | null;
}

/**
 * حكم نوبةٍ مفتوحة الآن:
 *  • لم يُذكَّر في فترة الخمول هذه (لا تذكير، أو تذكيرٌ سبق نشاطاً أحدث منه) وبلغ خموله دقائق القيد ⇒ REMIND.
 *  • ذُكِّر ولم يُرصد بعده نشاط (التذكير ≥ آخر نشاط)، وانقضت المهلة منذ التذكير ⇒ AUTO_OUT بوقت آخر نشاط (لا قبل الحضور).
 *    ويُشترط معها بلوغ الخمول دقائق القيد: مدّةٌ رفعتها الإدارة بعد التذكير لا تُنصرف بها نوبةٌ قبل أوانها الجديد.
 *  • مندوبٌ أُطفئ قيده أو عُطّل، أو نوبةٌ مفتوحة منذ أكثر من IDLE_STALE_OPEN_DAYS (نسي الانصراف قبل أيام) ⇒ NONE.
 *  • وإلا NONE.
 */
export function idleDecision(i: IdleInput): IdleResult {
  const now = i.now.getTime();
  const inAt = i.checkInAt.getTime();
  const la = Math.min(Math.max(i.lastActive ? i.lastActive.getTime() : inAt, inAt), Math.max(now, inAt));
  const lastActive = new Date(la);
  if (i.enabled === false || now - inAt > IDLE_STALE_OPEN_DAYS * DAY) return { verdict: 'NONE', lastActive, checkOutAt: null };
  const idleEnough = now - la >= idleMinutesOf(i.idleMinutes) * MIN;
  const reminded = i.idleRemindedAt != null && i.idleRemindedAt.getTime() >= la;
  if (!reminded) return { verdict: idleEnough ? 'REMIND' : 'NONE', lastActive, checkOutAt: null };
  const graceOver = now - i.idleRemindedAt!.getTime() >= idleGraceOf(i.graceMinutes) * MIN;
  if (graceOver && idleEnough) return { verdict: 'AUTO_OUT', lastActive, checkOutAt: lastActive };
  return { verdict: 'NONE', lastActive, checkOutAt: null };
}

export interface IdlePoint { lat: number; lng: number; accuracy: number | null; at: Date }

/** نقطةٌ صالحة للحكم بالحركة: إحداثيّان سليمان ودقّةٌ معقولة (غائبة = مقبولة كما يعطيها جهازٌ قديم) */
const goodPoint = (p: IdlePoint): boolean =>
  Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.at.getTime())
  && (p.accuracy == null || (Number.isFinite(p.accuracy) && p.accuracy <= IDLE_MOVE_MAX_ACCURACY_M));

export interface MoveScan { anchor: IdlePoint | null; lastMove: Date | null }

/**
 * آخر حركةٍ في نقاط الخلفية (مرتّبةً تصاعدياً): مرساةٌ أولى، وكل نقطةٍ تبعد عنها أكثر من IDLE_MOVE_M وأكثر من مجموع هامشَي
 * خطئهما حركةٌ بوقتها وتصير المرساة. الجوال الساكن (نقطةٌ كل ٣٠ث في مكانه، بانجرافه) لا يتحرّك أبداً. `from` حالةُ مسحٍ سابق
 * يُكمَل عليها (القراءة التزايدية) — صرفٌ بلا قاعدة.
 */
export function scanMoves(points: readonly IdlePoint[], from: MoveScan = { anchor: null, lastMove: null }): MoveScan {
  let { anchor, lastMove } = from;
  for (const p of points) {
    if (!goodPoint(p)) continue;
    if (!anchor) { anchor = p; continue; }
    const need = Math.max(IDLE_MOVE_M, (anchor.accuracy ?? 0) + (p.accuracy ?? 0));
    if (haversineM(anchor, p) > need) {
      if (!lastMove || p.at > lastMove) lastMove = p.at;
      anchor = p;
    }
  }
  return { anchor, lastMove };
}

/**
 * وقت نقطة الخلفية كنشاط بساعة الخادم: لحظة التقاطها محصورةً بين [الاستلام − IDLE_UPLOAD_LAG_MS، الاستلام]. ساعة جهازٍ متقدّمة
 * لا تمدّ النشاط إلى المستقبل، ومتأخّرةٌ (ساعةً مثلاً) لا تُقدِّم حركةَ مندوبٍ يقود الآن فتصرفه وهو يعمل. بلا لحظة استلام ⇒ الالتقاط
 */
export const pointActivityAt = (capturedAt: Date, createdAt: Date | null | undefined): Date => {
  if (!createdAt || !Number.isFinite(createdAt.getTime())) return capturedAt;
  const rec = createdAt.getTime();
  return new Date(Math.min(rec, Math.max(capturedAt.getTime(), rec - IDLE_UPLOAD_LAG_MS)));
};

// ═══ الإشعار ═══

// المصطلحات نفسها التي يراها المندوب في التطبيق (web-admin/src/i18n/strings.ts: «هل ما زلت تعمل؟»، «انصراف تلقائي»، «بصمة الانصراف»)
// — فلا يقرأ في الإشعار اسماً وفي الشاشة اسماً آخر للحدث نفسه
const REMIND_TEXT: Record<string, { title: string; body: (m: number) => string }> = {
  ar: { title: 'هل ما زلت تعمل؟', body: (m) => `لم يُرصد نشاط منذ ${m} دقيقة — سجّل بصمة الانصراف إن انتهى عملك` },
  en: { title: 'Are you still working?', body: (m) => `No activity for ${m} minutes — check out if your work is done` },
  fr: { title: 'Travaillez-vous toujours ?', body: (m) => `Aucune activité depuis ${m} minutes — pointez votre sortie si votre travail est terminé` },
  tr: { title: 'Hâlâ çalışıyor musunuz?', body: (m) => `${m} dakikadır etkinlik yok — işiniz bittiyse çıkış yapın` },
  zh: { title: '您还在工作吗？', body: (m) => `已 ${m} 分钟没有活动——如工作已结束，请签退` },
};
const AUTO_TEXT: Record<string, { title: string; body: string }> = {
  ar: { title: 'انصراف تلقائي', body: 'سُجّل انصرافك تلقائياً بوقت آخر نشاطٍ لك — سجّل حضورك من جديد إن كنت ما زلت تعمل' },
  en: { title: 'Automatic check-out', body: 'You were checked out automatically at your last activity time — check in again if you are still working' },
  fr: { title: 'Sortie automatique', body: 'Votre sortie a été enregistrée automatiquement à l’heure de votre dernière activité — pointez une nouvelle entrée si vous travaillez encore' },
  tr: { title: 'Otomatik çıkış', body: 'Son etkinliğiniz saatinde otomatik çıkışınız yapıldı — hâlâ çalışıyorsanız yeniden giriş yapın' },
  zh: { title: '自动签退', body: '已按您最后一次活动时间自动签退——如仍在工作，请重新签到' },
};

/** إشعار التذكير بلغة جهاز المندوب — يفتح شاشة البصمة (public/sw.js يعرف screen=attendance) */
export function idleRemindPayload(lang: string | null | undefined, idleMinutes: number) {
  const tx = REMIND_TEXT[lang ?? 'ar'] ?? REMIND_TEXT.ar;
  return { title: tx.title, body: tx.body(idleMinutesOf(idleMinutes)), url: '/rep?screen=attendance', tag: 'idle-punch' };
}
/** إشعار الانصراف التلقائي — الوسم نفسه فيحلّ محلّ التذكير على الجهاز */
export function idleAutoOutPayload(lang: string | null | undefined) {
  const tx = AUTO_TEXT[lang ?? 'ar'] ?? AUTO_TEXT.ar;
  return { title: tx.title, body: tx.body, url: '/rep?screen=attendance', tag: 'idle-punch' };
}

// ═══ التذكير المعلّق للتطبيق ═══

export interface PendingIdle {
  /** لحظة التذكير (ISO) */
  remindedAt: string;
  /** دقائق الخمول التي بلغها — لنصّ «لم يُرصد نشاط منذ X دقيقة» */
  idleMinutes: number;
  graceMinutes: number;
  serverNow: number;
}

/** حكمٌ صرف: تذكيرٌ ما زال يُسأل عنه في التطبيق — القيد مفعّل، والتذكير داخل مهلته (وهامش دورتين) */
export function pendingIdleOf(
  rep: { idlePunchOutEnabled: boolean; idlePunchOutMinutes: number; idlePunchOutGraceMinutes: number } | null | undefined,
  idleRemindedAt: Date | null | undefined, now: Date,
): PendingIdle | null {
  if (!rep?.idlePunchOutEnabled || !idleRemindedAt) return null;
  const grace = idleGraceOf(rep.idlePunchOutGraceMinutes);
  const age = now.getTime() - idleRemindedAt.getTime();
  if (age < 0 || age > grace * MIN + IDLE_PENDING_SLACK_MS) return null;
  return { remindedAt: idleRemindedAt.toISOString(), idleMinutes: idleMinutesOf(rep.idlePunchOutMinutes), graceMinutes: grace, serverNow: now.getTime() };
}

/**
 * التذكير المعلّق للمندوب الآن (null = لا شيء) — يعيده ردّ النبضة و/attendance/today فيعرض التطبيق «هل ما زلت تعمل؟».
 * يبقى معلّقاً حتى «ما زلت أعمل» (يمسحه) أو الانصراف أو انقضاء المهلة؛ وفتح التطبيق نفسه نشاطٌ يلغي الانصراف التلقائي.
 */
export async function pendingIdleReminder(tid: string, repId: string, now = new Date()): Promise<PendingIdle | null> {
  const open = await prisma.repAttendance.findFirst({
    where: { tenantId: tid, salesRepId: repId, checkOutAt: null, idleRemindedAt: { not: null } },
    orderBy: { checkInAt: 'desc' },
    select: { idleRemindedAt: true, salesRep: { select: { idlePunchOutEnabled: true, idlePunchOutMinutes: true, idlePunchOutGraceMinutes: true } } },
  });
  return open ? pendingIdleOf(open.salesRep, open.idleRemindedAt, now) : null;
}

// ═══ الدورة ═══

/** حالة مسح نقاط الخلفية لكل مندوب — قراءةٌ تزايدية بعد الأولى (ذاكرة نسخةٍ واحدة؛ إعادة التشغيل تقرأ من جديد مرّة) */
type MoveState = MoveScan & { shiftId: string; floor: number; cursor: number };
const moveCache = new Map<string, MoveState>();

/**
 * آخر حركةٍ للمندوب بعد `floor` (آخر ظهورٍ أو الحضور): أول مرّةٍ للنوبة وأرضيّتها أحدث IDLE_DEVICE_SCAN_MAX نقطةً **استُلمت**
 * بعدها، ثم ما استجدّ وحده (createdAt بعد آخر نقطةٍ قُرئت). الفرز والمؤشّر بساعة الخادم (createdAt) لا بساعة الجوال: جوالٌ
 * متأخّر الساعة لا تسقط نقاطه ولا تُقدَّم حركته (pointActivityAt). وأرضيّةٌ تغيّرت (فتح التطبيق فصار نشطاً ثم خمل) تبدأ مسحاً جديداً.
 */
async function deviceLastMove(tid: string, repId: string, shiftId: string, floor: Date): Promise<Date | null> {
  const prev = moveCache.get(repId);
  const fresh = !prev || prev.shiftId !== shiftId || prev.floor !== floor.getTime();
  const after = fresh ? floor : new Date(prev!.cursor);
  const rows = await prisma.repLocation.findMany({
    where: {
      tenantId: tid, salesRepId: repId, source: LOCATION_SOURCE_DEVICE,
      capturedAt: { gte: new Date(floor.getTime() - IDLE_SKEW_WINDOW_MS) },
      createdAt: fresh ? { gte: after } : { gt: after },
    },
    // دفعةٌ واحدة تحمل لحظة استلامٍ واحدة: الالتقاط يرتّب نقاطها
    orderBy: [{ createdAt: 'desc' }, { capturedAt: 'desc' }],
    take: IDLE_DEVICE_SCAN_MAX,
    select: { lat: true, lng: true, accuracy: true, capturedAt: true, createdAt: true },
  });
  rows.reverse();
  const points: IdlePoint[] = rows.map((r) => ({
    lat: Number(r.lat), lng: Number(r.lng), accuracy: r.accuracy == null ? null : Number(r.accuracy),
    at: pointActivityAt(new Date(r.capturedAt), new Date(r.createdAt)),
  }));
  const scan = scanMoves(points, fresh ? undefined : prev);
  const cursor = rows.length ? new Date(rows[rows.length - 1].createdAt).getTime() : (fresh ? floor.getTime() - 1 : prev!.cursor);
  moveCache.set(repId, { ...scan, shiftId, floor: floor.getTime(), cursor });
  return scan.lastMove;
}

/** المندوب المؤهّل الآن: القيد مفعّل، نشط، وشركته فعّلت البصمة وما زالت نشطة */
const ELIGIBLE_REP = { idlePunchOutEnabled: true, isActive: true, tenant: { attendanceEnabled: true, isActive: true } } as const;

interface OpenShiftRow { id: string; checkInAt: Date; idleRemindedAt: Date | null }

/** الانصراف التلقائي تحت قفل بصمات المندوب — يعيد false إن تغيّر شيءٌ منذ الحكم (انصرف، ضغط «ما زلت أعمل»، نشاطٌ وصل للتوّ) */
async function autoCheckOut(tid: string, repId: string, shift: OpenShiftRow, lastActive: Date, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockRepAttendance(tx, repId);
    const cur = await tx.repAttendance.findFirst({
      where: { id: shift.id, tenantId: tid, checkOutAt: null },
      select: { id: true, checkInAt: true, idleRemindedAt: true },
    });
    if (!cur?.idleRemindedAt || cur.idleRemindedAt.getTime() !== shift.idleRemindedAt?.getTime()) return false;
    const rep = await tx.salesRep.findUnique({ where: { id: repId }, select: { lastSeenAt: true, idlePunchOutEnabled: true } });
    if (!rep?.idlePunchOutEnabled) return false;
    if (rep.lastSeenAt && rep.lastSeenAt.getTime() > lastActive.getTime()) return false;
    const checkOutAt = new Date(Math.max(lastActive.getTime(), cur.checkInAt.getTime()));
    // editedAt لحظة القرار: وقت الانصراف آخر نشاطٍ مضى، فبلا ختمٍ الآن لا تراه المزامنة (فلترها checkOutAt/editedAt ≥ مؤشّرها).
    // وختم النظام (editedBy) ليس «تعديلاً إدارياً» في تقرير الساعات (workDay.ts)
    await tx.repAttendance.update({
      where: { id: cur.id },
      data: { checkOutAt, checkOutAuto: true, editedAt: now, editedBy: IDLE_ACTOR_NAME },
    });
    await tx.attendanceAudit.create({
      data: {
        tenantId: tid, salesRepId: repId, attendanceId: cur.id, action: IDLE_AUDIT_ACTION,
        before: auditTimes({ checkInAt: cur.checkInAt, checkOutAt: null }),
        after: { ...auditTimes({ checkInAt: cur.checkInAt, checkOutAt }), idleRemindedAt: cur.idleRemindedAt.toISOString(), decidedAt: now.toISOString() },
        reason: IDLE_AUDIT_REASON, actorId: IDLE_ACTOR_ID, actorName: IDLE_ACTOR_NAME,
      },
    });
    return true;
  }, REP_LOCK_TX);
}

/** دورةٌ واحدة: تذكير من بلغ خموله، وانصراف من انقضت مهلته بلا نشاط. لا ترمي — خطأ مندوبٍ لا يوقف الباقين */
export async function runIdlePunchOut(now = new Date()): Promise<{ reminded: number; autoOut: number }> {
  let reminded = 0;
  let autoOut = 0;
  const since = new Date(now.getTime() - IDLE_STALE_OPEN_DAYS * DAY);
  const reps = await prisma.salesRep.findMany({
    where: { ...ELIGIBLE_REP, attendance: { some: { checkOutAt: null, checkInAt: { gte: since } } } },
    select: {
      id: true, tenantId: true, isActive: true, lastSeenAt: true, idlePunchOutEnabled: true, idlePunchOutMinutes: true, idlePunchOutGraceMinutes: true,
      attendance: {
        where: { checkOutAt: null, checkInAt: { gte: since } }, orderBy: { checkInAt: 'desc' }, take: 1,
        select: { id: true, checkInAt: true, idleRemindedAt: true },
      },
      pushSubscriptions: { select: { lang: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
    },
    take: 5000,
  });
  const live = new Set<string>();
  for (const rep of reps) {
    const shift = rep.attendance[0];
    if (!shift) continue;
    live.add(rep.id);
    try {
      const idleMinutes = idleMinutesOf(rep.idlePunchOutMinutes);
      const graceMinutes = idleGraceOf(rep.idlePunchOutGraceMinutes);
      const inAt = shift.checkInAt.getTime();
      const floor = new Date(Math.max(rep.lastSeenAt ? rep.lastSeenAt.getTime() : inAt, inAt));
      let lastActive = floor;
      // آخر ظهورٍ حديث ⇒ لا حكم غير NONE أيّاً كانت حركته (النشاط لا يقلّ عنه) — فلا تُقرأ نقاط الخلفية إلا لمن خمل ظاهرياً
      if (now.getTime() - floor.getTime() >= idleMinutes * MIN) {
        const move = await deviceLastMove(rep.tenantId, rep.id, shift.id, floor);
        if (move && move.getTime() > lastActive.getTime()) lastActive = move;
      }
      const d = idleDecision({
        checkInAt: shift.checkInAt, lastActive, idleRemindedAt: shift.idleRemindedAt, now, idleMinutes, graceMinutes,
        enabled: rep.idlePunchOutEnabled === true && rep.isActive === true,
      });
      if (d.verdict === 'REMIND') {
        // التحويل الشرطيّ قفل: دورتان متزامنتان لا ترسلان التذكير مرّتين، ونشاطٌ أحدث من تذكيرٍ سابق وحده يفتح تذكيراً جديداً
        const claimed = await prisma.repAttendance.updateMany({
          where: { id: shift.id, checkOutAt: null, OR: [{ idleRemindedAt: null }, { idleRemindedAt: { lt: d.lastActive } }] },
          data: { idleRemindedAt: now },
        });
        if (claimed.count !== 1) continue;
        reminded++;
        // صلاحية الإشعار مهلة الردّ: جوالٌ عاد للشبكة بعدها لا يُسأل عن تذكيرٍ فات
        await sendPushToRep(rep.id, idleRemindPayload(rep.pushSubscriptions[0]?.lang, idleMinutes), { ttlSec: graceMinutes * 60 }).catch(() => 0);
      } else if (d.verdict === 'AUTO_OUT') {
        if (!(await autoCheckOut(rep.tenantId, rep.id, shift, d.lastActive, now))) continue;
        autoOut++;
        moveCache.delete(rep.id);
        await sendPushToRep(rep.id, idleAutoOutPayload(rep.pushSubscriptions[0]?.lang), { ttlSec: 12 * 60 * 60 }).catch(() => 0);
      }
    } catch (e) {
      console.error('idle-punch-out:', rep.id, (e as Error).message);
    }
  }
  // حالات مسحٍ لنوباتٍ لم تعد مفتوحة أو مندوبٍ أُطفئ قيده
  for (const id of [...moveCache.keys()]) if (!live.has(id)) moveCache.delete(id);
  return { reminded, autoOut };
}

/** للاختبار وحده */
export const _resetIdleLoop = (): void => { moveCache.clear(); };

/** الحلقة الدورية — تبدأ مع الخادم بجانب startPresenceChecks */
export function startIdlePunchOut(): void {
  if ((process.env.IDLE_PUNCH_OUT_ENABLED || '').trim().toLowerCase() === 'false') return;
  let running = false;
  const tick = () => {
    if (running) return; // دورةٌ بطيئة لا تتداخل مع التالية
    running = true;
    runIdlePunchOut()
      .catch((e) => console.error('idle-punch-out:', (e as Error).message))
      .finally(() => { running = false; });
  };
  setTimeout(tick, 50 * 1000).unref();
  setInterval(tick, IDLE_TICK_MS).unref();
}
