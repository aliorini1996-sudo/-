// ============================================================================
// «تذكير بالانصراف عند الخمول ثم انصراف تلقائي» (طلب المالك، ٢٣ نوفمبر ٢٠٢٦) — قيدٌ على المندوب يُفعَّل ويُطفأ
// (SalesRep.idlePunchOutEnabled) بمدّتين تحدّدهما الإدارة لكل مندوب كالمسافة: دقائق الخمول قبل التذكير
// (idlePunchOutMinutes، ٤٥ افتراضاً، ١٠–٤٨٠) ومهلة الردّ بعده قبل الانصراف التلقائي (idlePunchOutGraceMinutes، ١٥ افتراضاً، ٥–١٢٠).
//
// قرار المالك (٢٣ نوفمبر) بمرحلتين:
//  ١) قبل التذكير — الخمول «بلا استخدامٍ للتطبيق ولا موقعٍ يصل من جواله»: كلّ نشاطٍ يُحسب، بساعة الخادم:
//     • آخر ظهور (SalesRep.lastSeenAt): نبضة التطبيق المفتوح كل دقيقة ونقاط موقع الصفحة («ما زلت أعمل» تكتبه أيضاً).
//     • أيّ نقطة موقعٍ استُلمت من جواله — تتبّع الخلفية الأصلي (source='device') ونقاط الصفحة معاً — بلحظة استلامها (createdAt)
//       لا بساعة الجوال. ساكنةً كانت أو متحرّكة: الجوال الذي ما زال يرسل موقعه ليس خاملاً.
//     نوبةٌ مفتوحة بلا شيءٍ من هذا منذ دقائق الخمول ⇒ إشعار «سجّل بصمة الانصراف إن انتهى عملك» ونافذة «هل ما زلت تعمل؟» بعدٍّ
//     تنازليّ، مرّةً لكل فترة خمول (RepAttendance.idleRemindedAt)، ويُختم معه آخر نشاطٍ سبقه (RepAttendance.idleLastActiveAt).
//  ٢) بعد التذكير — لا يلغي الانصراف التلقائي إلا واحدٌ من ثلاثة:
//     • «ما زلت أعمل» (POST /api/tracking/attendance/still-working) يمحو التذكير.
//     • تنقّلٌ فعلي: نقطةٌ دقيقة تبعد عن سابقتها المعتمدة أكثر من IDLE_MOVE_M وأكثر من هامشَي خطئهما، **استُلمت** بعد التذكير
//       (createdAt بساعة الخادم لا لحظة التقاطها بساعة الجوال: ساعةٌ متأخّرة أو دفعةٌ رُفعت بعد انقطاع لا تُسقط تنقّلاً يصل الآن).
//     • مستندٌ أصدره المندوب بعد التذكير: فاتورة أو مرتجع (Invoice) أو سند قبض (Receipt) أو زيارة (RepVisit) — بلحظة وصوله للخادم.
//     أمّا النبضة (فتح التطبيق) ونقاط الموقع الساكنة بعد التذكير فلا تلغيه. ما ألغاه ⇒ التذكير يُمحى وتبدأ دورةٌ جديدة من لحظته.
//     وبلا شيءٍ منها حتى تنقضي المهلة ⇒ انصرافٌ تلقائي **بوقت آخر نشاطٍ سبق التذكير** (idleLastActiveAt) لا بوقت الدورة،
//     موسومٌ RepAttendance.checkOutAuto («انصراف تلقائي»)، وسطرٌ في AttendanceAudit باسم «النظام».
// وما قبل بصمة الحضور لا يُحسب في شيءٍ من هذا (الحضور نفسه أرضيّته).
//
// الحلقة كل دقيقة داخل الخادم (startIdlePunchOut) بجانب التحقق من التواجد، وIDLE_PUNCH_OUT_ENABLED=false تطفئها. لا ترمي أبداً.
// ============================================================================
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { sendPushToRep } from './webPush';
import { lockRepAttendance, auditTimes, REP_LOCK_TX } from './attendanceEdit';
import { haversineM } from './routeShape';
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
/** أقلّ انتقالٍ يشهد بتنقّلٍ فعلي بعد التذكير — فوق انجراف GPS لجوالٍ ساكن داخل مبنى */
export const IDLE_MOVE_M = 150;
/** نقطةٌ أرخى دقّةً من هذا لا تُحسب في التنقّل (قفزات الشبكة الخلوية) */
export const IDLE_MOVE_MAX_ACCURACY_M = 100;
/** أقصى نقاط الموقع في قراءةٍ أولى لنوبة — الأحدث منها (ساعاتٌ من الأثر)، ثم قراءاتٌ تزايدية صغيرة */
export const IDLE_LOC_SCAN_MAX = 3000;
/**
 * حدٌّ رخوٌ على لحظة الالتقاط (بساعة الجهاز) يُبقي القراءة في مدى فهرس (tenantId, salesRepId, capturedAt) — والفرز الحقيقيّ
 * على createdAt (ساعة الخادم). جهازٌ تتأخّر ساعته أكثر منه لا تُرى نقاطه (كـNATIVE_ROW_LOOKBACK_MS في deviceTrack.ts).
 * وبالقدر نفسه حدٌّ على تاريخ المستند (invoiceDate/receiptDate، ولحظة الزيارة على الجهاز) في فحص «مستندٌ بعد التذكير»: مستندٌ
 * التُقط دون اتصالٍ قبل التذكير بأكثر منه لا يشهد بعملٍ الآن (وفي الفواتير والزيارات يُبقي القراءة في مدى فهرسها أيضاً)
 */
export const IDLE_SKEW_WINDOW_MS = 12 * 60 * MIN;
/** «ما زال التذكير معلّقاً» في التطبيق: داخل المهلة وهامش دورتين — تتّسع لتأخّر الدورة عن انقضاء المهلة */
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

/** NONE لا شيء · REMIND تذكير · AUTO_OUT انصرافٌ تلقائي · CANCEL تنقّلٌ فعلي أو مستندٌ بعد التذكير ألغاه (يُمحى وتبدأ دورةٌ جديدة) */
export type IdleVerdict = 'NONE' | 'REMIND' | 'AUTO_OUT' | 'CANCEL';
export interface IdleInput {
  checkInAt: Date;
  /**
   * آخر نشاطٍ بمعنى ما قبل التذكير (null = لا أثر): أحدث آخر ظهور وأحدث نقطة موقعٍ استُلمت — ما قبل الحضور يُرفع إليه.
   * لا يُقرأ وتذكيرٌ قائم: النبضة ونقاط الموقع بعد التذكير لا تلغيه
   */
  lastActive: Date | null;
  idleRemindedAt: Date | null;
  /**
   * RepAttendance.idleLastActiveAt: مع تذكيرٍ قائم آخرُ نشاطٍ سبقه (وقت الانصراف التلقائي)، وبلا تذكير لحظةُ ما ألغى التذكير
   * السابق (أرضيّة النشاط في الدورة الجديدة). تذكيرٌ بلا هذا الختم (صفٌّ شاذّ) لا يُعدّ قائماً — فلا انصرافٌ بلا وقتٍ معروف
   */
  remindedActiveAt?: Date | null;
  /** أحدث ما يلغي التذكير القائم إن وقع بعده: تنقّلٌ فعلي أو مستندٌ أصدره المندوب (null = لا شيء) */
  cancelAt?: Date | null;
  now: Date;
  idleMinutes: number;
  graceMinutes: number;
  /** القيد مفعّلٌ والمندوب نشط (غائبٌ = نعم: الدورة تختار المؤهّلين في الاستعلام، وهذا حارسٌ ثانٍ صرف) — false ⇒ NONE دائماً */
  enabled?: boolean;
}
export interface IdleResult {
  verdict: IdleVerdict;
  /**
   * آخر نشاطٍ بعد رفعه إلى الحضور (ولا يتجاوز الآن): قبل التذكير أحدث النشاط (REMIND يختمه مع التذكير)، ومع تذكيرٍ قائم آخر
   * نشاطٍ سبقه، ومع CANCEL لحظة ما ألغاه (أرضيّة الدورة الجديدة)
   */
  lastActive: Date;
  /** وقت الانصراف التلقائي = آخر نشاطٍ سبق التذكير (AUTO_OUT وحدها) */
  checkOutAt: Date | null;
}

/**
 * حكم نوبةٍ مفتوحة الآن:
 *  • لا تذكير قائم وبلغ خموله دقائق القيد — منذ أحدث نشاطه أو لحظة ما ألغى التذكير السابق أيّهما أحدث ⇒ REMIND.
 *  • تذكيرٌ قائم (مختومٌ بآخر نشاطٍ سبقه) وبعده تنقّلٌ فعلي أو مستند ⇒ CANCEL بلحظته. والنبضة والنقاط الساكنة لا تلغيه.
 *  • تذكيرٌ قائم بلا ما يلغيه، وانقضت المهلة منذ التذكير ⇒ AUTO_OUT بوقت آخر نشاطٍ سبق التذكير (لا قبل الحضور).
 *    ويُشترط معها بلوغ الخمول دقائق القيد: مدّةٌ رفعتها الإدارة بعد التذكير لا تُنصرف بها نوبةٌ قبل أوانها الجديد.
 *  • مندوبٌ أُطفئ قيده أو عُطّل، أو نوبةٌ مفتوحة منذ أكثر من IDLE_STALE_OPEN_DAYS (نسي الانصراف قبل أيام) ⇒ NONE.
 *  • وإلا NONE.
 */
export function idleDecision(i: IdleInput): IdleResult {
  const now = i.now.getTime();
  const inAt = i.checkInAt.getTime();
  const clamp = (t: number) => Math.min(Math.max(t, inAt), Math.max(now, inAt));
  const remindedAt = i.idleRemindedAt ? i.idleRemindedAt.getTime() : null;
  const stamped = i.remindedActiveAt ? i.remindedActiveAt.getTime() : null;
  const pending = remindedAt != null && stamped != null;
  // قبل التذكير: كل نشاط، ولحظة ما ألغى التذكير السابق أرضيّةٌ له (لا يُذكَّر من جديدٍ فوراً بخمولٍ سبقها)
  const floor = remindedAt == null && stamped != null ? stamped : -Infinity;
  const la = clamp(Math.max(i.lastActive ? i.lastActive.getTime() : inAt, floor));
  const none = (at: number): IdleResult => ({ verdict: 'NONE', lastActive: new Date(at), checkOutAt: null });
  if (i.enabled === false || now - inAt > IDLE_STALE_OPEN_DAYS * DAY) return none(pending ? clamp(stamped!) : la);
  const idleMs = idleMinutesOf(i.idleMinutes) * MIN;
  if (!pending) return { verdict: now - la >= idleMs ? 'REMIND' : 'NONE', lastActive: new Date(la), checkOutAt: null };
  // بعد التذكير: لا يلغيه إلا تنقّلٌ فعلي أو مستندٌ بعده («ما زلت أعمل» يمحوه في القاعدة فلا يبلغ هذا)
  const cancel = i.cancelAt ? i.cancelAt.getTime() : null;
  if (cancel != null && cancel > remindedAt!) return { verdict: 'CANCEL', lastActive: new Date(clamp(cancel)), checkOutAt: null };
  const before = clamp(stamped!);
  const graceOver = now - remindedAt! >= idleGraceOf(i.graceMinutes) * MIN;
  if (graceOver && now - before >= idleMs) return { verdict: 'AUTO_OUT', lastActive: new Date(before), checkOutAt: new Date(before) };
  return none(before);
}

export interface IdlePoint { lat: number; lng: number; accuracy: number | null; at: Date }

/** نقطةٌ صالحة للحكم بالتنقّل: إحداثيّان سليمان ودقّةٌ معقولة (غائبة = مقبولة كما يعطيها جهازٌ قديم) */
const goodPoint = (p: IdlePoint): boolean =>
  Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.at.getTime())
  && (p.accuracy == null || (Number.isFinite(p.accuracy) && p.accuracy <= IDLE_MOVE_MAX_ACCURACY_M));

export interface MoveScan { anchor: IdlePoint | null; lastMove: Date | null }

/**
 * آخر تنقّلٍ فعليّ في نقاط الموقع (مرتّبةً تصاعدياً): مرساةٌ أولى، وكل نقطةٍ تبعد عنها أكثر من IDLE_MOVE_M وأكثر من مجموع
 * هامشَي خطئهما تنقّلٌ بوقتها (`at`: لحظة استلامها في الخادم كما يمرّرها repLocationScan) وتصير المرساة. الجوال الساكن (نقطةٌ كل
 * ٣٠ث في مكانه، بانجرافه) لا يتنقّل أبداً. `from` حالةُ مسحٍ سابق يُكمَل عليها (القراءة التزايدية) — صرفٌ بلا قاعدة.
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
// وقت الانصراف آخر نشاطٍ **سبق التذكير** — فتح التطبيق بعده نشاطٌ لا يلغيه، فلا يُقال «بوقت آخر نشاطٍ لك» مطلقاً
const AUTO_TEXT: Record<string, { title: string; body: string }> = {
  ar: { title: 'انصراف تلقائي', body: 'سُجّل انصرافك تلقائياً بوقت آخر نشاطٍ لك قبل التذكير — سجّل حضورك من جديد إن كنت ما زلت تعمل' },
  en: { title: 'Automatic check-out', body: 'You were checked out automatically at your last activity time before the reminder — check in again if you are still working' },
  fr: { title: 'Sortie automatique', body: 'Votre sortie a été enregistrée automatiquement à l’heure de votre dernière activité avant le rappel — pointez une nouvelle entrée si vous travaillez encore' },
  tr: { title: 'Otomatik çıkış', body: 'Hatırlatmadan önceki son etkinliğinizin saatinde otomatik çıkışınız yapıldı — hâlâ çalışıyorsanız yeniden giriş yapın' },
  zh: { title: '自动签退', body: '已按您提醒前最后一次活动的时间自动签退——如仍在工作，请重新签到' },
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
  /** لحظة التذكير (ISO) — والانصراف التلقائي عند remindedAt + graceMinutes */
  remindedAt: string;
  /** دقائق الخمول التي بلغها — لنصّ «بلا استخدامٍ للتطبيق ولا موقع منذ X دقيقة» */
  idleMinutes: number;
  graceMinutes: number;
  /** ساعة الخادم لحظة الردّ (ms): بها يصحّح التطبيق ساعة الجوال في العدّ التنازليّ إلى الانصراف التلقائي */
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
 * التذكير المعلّق للمندوب الآن (null = لا شيء) — يعيده ردّ النبضة و/attendance/today فيعرض التطبيق «هل ما زلت تعمل؟» بعدٍّ
 * تنازليّ. يبقى معلّقاً حتى «ما زلت أعمل» أو تنقّلٍ فعليّ أو مستندٍ (تمحوه الدورة) أو الانصراف أو انقضاء المهلة — وفتح التطبيق
 * نفسه (النبضة التي تحمله) لا يلغي الانصراف التلقائي.
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

/** حالة مسح نقاط الموقع لكل مندوب — قراءةٌ تزايدية بعد الأولى (ذاكرة نسخةٍ واحدة؛ إعادة التشغيل تقرأ من جديد مرّة) */
type LocState = MoveScan & { shiftId: string; floor: number; cursor: number; lastRecv: number | null };
const locCache = new Map<string, LocState>();

/**
 * نقاط موقع المندوب — الخلفية والصفحة معاً — المستلَمة منذ `floor`: أحدث لحظة استلامٍ (lastRecv، نشاط ما قبل التذكير: أيّ نقطةٍ
 * وصلت ساكنةً أو متحرّكة) وآخر تنقّلٍ فعليّ (lastMove، يلغي التذكير القائم). أول مرّةٍ للنوبة وأرضيّتها أحدث IDLE_LOC_SCAN_MAX
 * نقطةً **استُلمت** منذها، ثم ما استجدّ وحده (createdAt بعد آخر نقطةٍ قُرئت). الفرز والمؤشّر ووقت التنقّل كلّها بساعة الخادم
 * (createdAt) لا بساعة الجوال (قرار المالك): جوالٌ متأخّر الساعة لا تسقط نقاطه، وتنقّلٌ يصل بعد التذكير يلغيه ولو التُقط قبله
 * (ساعةٌ متأخّرة، أو دفعةٌ رُفعت بعد انقطاع) — فلا يتوقّف الحكم على تأخّر الرفع. وأرضيّةٌ تغيّرت (فتح التطبيق، أو تذكيرٌ خُتم بآخر
 * نشاطٍ سبقه) تبدأ مسحاً جديداً.
 */
async function repLocationScan(tid: string, repId: string, shiftId: string, floor: Date): Promise<{ lastRecv: Date | null; lastMove: Date | null }> {
  const prev = locCache.get(repId);
  const fresh = !prev || prev.shiftId !== shiftId || prev.floor !== floor.getTime();
  const after = fresh ? floor.getTime() : prev!.cursor;
  const rows = await prisma.repLocation.findMany({
    where: {
      tenantId: tid, salesRepId: repId,
      // ما استُلم بعد المؤشّر التُقط بعده بقدر انحراف الساعة على الأكثر — فالحدّ الرخو يتبع المؤشّر ولا يتّسع مع طول النوبة
      capturedAt: { gte: new Date(after - IDLE_SKEW_WINDOW_MS) },
      createdAt: fresh ? { gte: floor } : { gt: new Date(after) },
    },
    // دفعةٌ واحدة تحمل لحظة استلامٍ واحدة: الالتقاط يرتّب نقاطها
    orderBy: [{ createdAt: 'desc' }, { capturedAt: 'desc' }],
    take: IDLE_LOC_SCAN_MAX,
    select: { lat: true, lng: true, accuracy: true, capturedAt: true, createdAt: true },
  });
  rows.reverse();
  // وقت النقطة لحظة استلامها: نقاط الدفعة الواحدة تتشارك وقتها، والالتقاط يرتّبها في المسح وحده
  const points: IdlePoint[] = rows.map((r) => ({
    lat: Number(r.lat), lng: Number(r.lng), accuracy: r.accuracy == null ? null : Number(r.accuracy),
    at: new Date(r.createdAt),
  }));
  const scan = scanMoves(points, fresh ? undefined : prev);
  const newest = rows.length ? new Date(rows[rows.length - 1].createdAt).getTime() : null;
  const cursor = newest ?? (fresh ? floor.getTime() - 1 : prev!.cursor);
  const lastRecv = newest ?? (fresh ? null : prev!.lastRecv);
  locCache.set(repId, { ...scan, shiftId, floor: floor.getTime(), cursor, lastRecv });
  return { lastRecv: lastRecv == null ? null : new Date(lastRecv), lastMove: scan.lastMove };
}

type DocDb = Pick<Prisma.TransactionClient, 'invoice' | 'receipt' | 'repVisit'>;

/**
 * مستندٌ أصدره المندوب بعد `after` (لحظة التذكير) — يعيد لحظة وصوله للخادم أو null: فاتورةٌ أو مرتجع (Invoice) أو سند قبض
 * (Receipt) بـcreatedAt (ساعة الخادم؛ invoiceDate/receiptDate قد تكون لحظة الجهاز لمستندٍ دون اتصال)، أو زيارة (RepVisit)
 * بـreceivedAt (createdAt فيها لحظة الجهاز). كلٌّ findFirst واحد في مدى فهرس: (tenantId, invoiceDate) للفواتير بحدٍّ رخو على
 * تاريخها (IDLE_SKEW_WINDOW_MS قبل التذكير)، و(tenantId, salesRepId, createdAt) للسندات (سندات المندوب منذ التذكير وحدها، والحدّ
 * الرخو على receiptDate مرشّحٌ على ما يجده فقط) وللزيارات (بالحدّ الرخو على لحظة الجهاز). يجري كل دورةٍ لكل تذكيرٍ قائم وتحت قفل
 * البصمات في الانصراف، فلا مسحَ لمستندات الشركة. ويتوقّف عند أوّل ما يجد — يكفي مستندٌ واحد. للمندوب وحده: مستند مندوبٍ آخر لا يلغي تذكيره.
 */
export async function repDocumentAfter(db: DocDb, tid: string, repId: string, after: Date): Promise<Date | null> {
  const lo = new Date(after.getTime() - IDLE_SKEW_WINDOW_MS);
  const inv = await db.invoice.findFirst({
    where: { tenantId: tid, salesRepId: repId, invoiceDate: { gte: lo }, createdAt: { gt: after } },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  if (inv) return inv.createdAt;
  // فهرس Receipt (tenantId, salesRepId, createdAt) — schema.prisma
  const rcp = await db.receipt.findFirst({
    where: { tenantId: tid, salesRepId: repId, createdAt: { gt: after }, receiptDate: { gte: lo } },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  if (rcp) return rcp.createdAt;
  const visit = await db.repVisit.findFirst({
    where: { tenantId: tid, salesRepId: repId, createdAt: { gte: lo }, receivedAt: { gt: after } },
    orderBy: { receivedAt: 'desc' }, select: { receivedAt: true },
  });
  return visit ? visit.receivedAt : null;
}

/** المندوب المؤهّل الآن: القيد مفعّل، نشط، وشركته فعّلت البصمة وما زالت نشطة */
const ELIGIBLE_REP = { idlePunchOutEnabled: true, isActive: true, tenant: { attendanceEnabled: true, isActive: true } } as const;

interface OpenShiftRow { id: string; checkInAt: Date; idleRemindedAt: Date | null; idleLastActiveAt: Date | null }

/**
 * الانصراف التلقائي تحت قفل بصمات المندوب — يعيد false إن تغيّر شيءٌ منذ الحكم: انصرف، أو ضغط «ما زلت أعمل» (التذكير مُحي)،
 * أو أُطفئ قيده، أو وصل للتوّ مستندٌ أصدره بعد التذكير (تلغيه الدورة التالية). أمّا نبضةٌ بعد التذكير فلا تمنعه (قرار المالك)
 */
async function autoCheckOut(tid: string, repId: string, shift: OpenShiftRow, at: Date, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockRepAttendance(tx, repId);
    const cur = await tx.repAttendance.findFirst({
      where: { id: shift.id, tenantId: tid, checkOutAt: null },
      select: { id: true, checkInAt: true, idleRemindedAt: true },
    });
    if (!cur?.idleRemindedAt || cur.idleRemindedAt.getTime() !== shift.idleRemindedAt?.getTime()) return false;
    const rep = await tx.salesRep.findUnique({ where: { id: repId }, select: { idlePunchOutEnabled: true } });
    if (!rep?.idlePunchOutEnabled) return false;
    if (await repDocumentAfter(tx, tid, repId, cur.idleRemindedAt)) return false;
    const checkOutAt = new Date(Math.max(at.getTime(), cur.checkInAt.getTime()));
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

export interface IdleRunResult { reminded: number; autoOut: number; cancelled: number }

/**
 * دورةٌ واحدة: تذكير من بلغ خموله، وإلغاء تذكير من تنقّل فعلاً أو أصدر مستنداً بعده، وانصراف من انقضت مهلته بلا شيءٍ منهما.
 * لا ترمي — خطأ مندوبٍ لا يوقف الباقين
 */
export async function runIdlePunchOut(now = new Date()): Promise<IdleRunResult> {
  let reminded = 0;
  let autoOut = 0;
  let cancelled = 0;
  const since = new Date(now.getTime() - IDLE_STALE_OPEN_DAYS * DAY);
  const reps = await prisma.salesRep.findMany({
    where: { ...ELIGIBLE_REP, attendance: { some: { checkOutAt: null, checkInAt: { gte: since } } } },
    select: {
      id: true, tenantId: true, isActive: true, lastSeenAt: true, idlePunchOutEnabled: true, idlePunchOutMinutes: true, idlePunchOutGraceMinutes: true,
      attendance: {
        where: { checkOutAt: null, checkInAt: { gte: since } }, orderBy: { checkInAt: 'desc' }, take: 1,
        select: { id: true, checkInAt: true, idleRemindedAt: true, idleLastActiveAt: true },
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
      const enabled = rep.idlePunchOutEnabled === true && rep.isActive === true;
      const inAt = shift.checkInAt.getTime();
      const remindedAt = shift.idleRemindedAt;
      const stamped = shift.idleLastActiveAt;
      let lastActive: Date | null = null;
      let cancelAt: Date | null = null;
      if (enabled && remindedAt && stamped) {
        // تذكيرٌ قائم: النبضة والنقاط الساكنة بعده لا تُقرأ نشاطاً — يُبحث عمّا يلغيه وحده: تنقّلٌ فعليّ في نقاطٍ استُلمت منذ آخر
        // نشاطٍ سبقه (آخر نقطةٍ قبله مرساةٌ لأوّل ما بعده)، ثم مستندٌ أصدره بعده
        const scan = await repLocationScan(rep.tenantId, rep.id, shift.id, new Date(Math.max(stamped.getTime(), inAt)));
        if (scan.lastMove && scan.lastMove.getTime() > remindedAt.getTime()) cancelAt = scan.lastMove;
        else cancelAt = await repDocumentAfter(prisma, rep.tenantId, rep.id, remindedAt);
      } else if (enabled) {
        // قبل التذكير: آخر ظهورٍ (والحضور، ولحظة ما ألغى التذكير السابق) أرضيّةٌ — حديثةً لا حكم غير NONE (النشاط لا يقلّ عنها)،
        // فلا تُقرأ نقاط الموقع إلا لمن خمل ظاهرياً؛ وأيّ نقطةٍ استُلمت بعدها نشاط
        const floorMs = Math.max(rep.lastSeenAt ? rep.lastSeenAt.getTime() : inAt, inAt, !remindedAt && stamped ? stamped.getTime() : inAt);
        lastActive = new Date(floorMs);
        if (now.getTime() - floorMs >= idleMinutes * MIN) {
          const scan = await repLocationScan(rep.tenantId, rep.id, shift.id, lastActive);
          if (scan.lastRecv && scan.lastRecv.getTime() > floorMs) lastActive = scan.lastRecv;
        }
      }
      const d = idleDecision({
        checkInAt: shift.checkInAt, lastActive, idleRemindedAt: remindedAt, remindedActiveAt: stamped, cancelAt,
        now, idleMinutes, graceMinutes, enabled,
      });
      if (d.verdict === 'REMIND') {
        // التحويل الشرطيّ قفل: دورتان متزامنتان لا ترسلان التذكير مرّتين (لا تذكير قائم = لا لحظة أو لا ختم)، ونشاطٌ وصل بعد
        // القراءة (نبضةٌ أو «ما زلت أعمل» كتبا آخر ظهورٍ أحدث) يمنعه. ويُختم معه آخر نشاطٍ سبقه: وقت الانصراف التلقائي إن لم يُلغَ
        const claimed = await prisma.repAttendance.updateMany({
          where: {
            id: shift.id, checkOutAt: null, OR: [{ idleRemindedAt: null }, { idleLastActiveAt: null }],
            salesRep: { is: { OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: d.lastActive } }] } },
          },
          data: { idleRemindedAt: now, idleLastActiveAt: d.lastActive },
        });
        if (claimed.count !== 1) continue;
        reminded++;
        // صلاحية الإشعار مهلة الردّ: جوالٌ عاد للشبكة بعدها لا يُسأل عن تذكيرٍ فات
        await sendPushToRep(rep.id, idleRemindPayload(rep.pushSubscriptions[0]?.lang, idleMinutes), { ttlSec: graceMinutes * 60 }).catch(() => 0);
      } else if (d.verdict === 'CANCEL') {
        // تنقّلٌ فعلي أو مستندٌ بعد التذكير: يُمحى فتسقط نافذة «هل ما زلت تعمل؟» من النبضة التالية، ولحظته أرضيّة الدورة الجديدة.
        // شرطيّاً على التذكير نفسه: «ما زلت أعمل» أو تذكيرٌ أحدث سبقاه لا يُكتب فوقهما
        const done = await prisma.repAttendance.updateMany({
          where: { id: shift.id, checkOutAt: null, idleRemindedAt: remindedAt },
          data: { idleRemindedAt: null, idleLastActiveAt: d.lastActive },
        });
        if (done.count === 1) cancelled++;
      } else if (d.verdict === 'AUTO_OUT') {
        if (!(await autoCheckOut(rep.tenantId, rep.id, shift, d.checkOutAt!, now))) continue;
        autoOut++;
        locCache.delete(rep.id);
        await sendPushToRep(rep.id, idleAutoOutPayload(rep.pushSubscriptions[0]?.lang), { ttlSec: 12 * 60 * 60 }).catch(() => 0);
      }
    } catch (e) {
      console.error('idle-punch-out:', rep.id, (e as Error).message);
    }
  }
  // حالات مسحٍ لنوباتٍ لم تعد مفتوحة أو مندوبٍ أُطفئ قيده
  for (const id of [...locCache.keys()]) if (!live.has(id)) locCache.delete(id);
  return { reminded, autoOut, cancelled };
}

/** للاختبار وحده */
export const _resetIdleLoop = (): void => { locCache.clear(); };

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
