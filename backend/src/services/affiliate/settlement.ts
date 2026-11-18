/**
 * دورة تسوية السفراء كل ١٠ أيام (V2_SPEC §5 — قرار المالك ١٨ نوفمبر ٢٠٢٦).
 *
 * - **حدود الدورة**: نهاياتها أيام 1 و11 و21 من كلّ شهر 00:00 بتوقيت الرياض (+٣ بلا توقيتٍ صيفي).
 *   `cycleKey` = تاريخ النهاية `YYYY-MM-DD`، و`periodStart` = النهاية السابقة.
 * - **المهمّة** `runSettlementCycle(now)`: آخر نهايةٍ مرّت ← علامة `ax-settle:<cycleKey>` في OpsMarker
 *   (مرّةً واحدة ولو تعدّدت النسخ أو أُعيد التشغيل) ← المصالحة ← الاعتماد التلقائي ← مسودّة دفعةٍ لكلّ
 *   مرشّحٍ مؤهَّل ← ملخّصٌ لبريد المالك.
 * - **المنصّة لا تحرّك مالاً**: «التسوية التلقائية» = مسودّة `draft` منفّذها النظام + إشعار. المالك
 *   يحوّل من البنك ويسجّل «مدفوع» أو «فشل». وما دون الحدّ الأدنى يبقى معتمداً ويُرحَّل.
 */
import prisma from '../../config/database';
import { isUniqueViolation, PlatformActor } from './core';
import { LedgerError, reconcile, autoApproveEligible, payoutCandidates, createCyclePayout } from './ledger';
import { mailOwnerSettlementSummary } from './settlementMail';

const RIYADH_OFFSET_MS = 3 * 3600_000;
/** أيام نهايات الدورات في الشهر */
export const SETTLEMENT_DAYS = [1, 11, 21] as const;
export const SETTLEMENT_EVERY_DAYS = 10;

/** 00:00 بالرياض ليومٍ من شهرٍ (Date.UTC يطوي الشهر -1 و12) */
const riyadhMidnight = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d) - RIYADH_OFFSET_MS);
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** تاريخ الرياض الآن مفكَّكاً */
function riyadhParts(now: Date): { y: number; m: number; d: number } {
  const r = new Date(now.getTime() + RIYADH_OFFSET_MS);
  return { y: r.getUTCFullYear(), m: r.getUTCMonth(), d: r.getUTCDate() };
}

/** آخر دورةٍ انتهت (نهايتها ≤ now) — نهايةٌ تساوي اللحظة تُعدّ منتهية */
export function cycleBounds(now: Date = new Date()): { cycleKey: string; periodStart: Date; periodEnd: Date } {
  const { y, m, d } = riyadhParts(now);
  const endDay = d >= 21 ? 21 : d >= 11 ? 11 : 1;
  const [py, pm, pd] = endDay === 21 ? [y, m, 11] : endDay === 11 ? [y, m, 1] : [y, m - 1, 21];
  return { cycleKey: ymd(y, m, endDay), periodStart: riyadhMidnight(py, pm, pd), periodEnd: riyadhMidnight(y, m, endDay) };
}

/** نهاية الدورة القادمة (بعد now تماماً) — 1 أو 11 أو 21 00:00 بالرياض */
export function nextSettlementAt(now: Date = new Date()): Date {
  const { y, m, d } = riyadhParts(now);
  if (d < 11) return riyadhMidnight(y, m, 11);
  if (d < 21) return riyadhMidnight(y, m, 21);
  return riyadhMidnight(y, m + 1, 1);
}

export const settlementMarkerKey = (cycleKey: string) => `ax-settle:${cycleKey}`;

/** علامةٌ بقيت «running» أكثر من هذا = نسخةٌ ماتت أثناء الدورة؛ تُستأنف (الإنشاء آمنٌ للتكرار لكلّ سفير) */
const STALE_RUN_MS = 30 * 60_000;

/**
 * حجز الدورة في OpsMarker: الإنشاء الفريد هو القفل — نسختان متزامنتان تكسب إحداهما. علامةٌ «running»
 * قديمة (عمليةٌ ماتت في منتصف الدورة) يُستولى عليها ذرّياً فتُكمل الدورة. خطأٌ غير التعارض يُرمى
 * (القاعدة غير متاحة) فتُعاد المحاولة في النبضة التالية بدل أن تُعدّ الدورة منجزة.
 */
export async function claimMarker(key: string, now: Date = new Date()): Promise<boolean> {
  try {
    await prisma.opsMarker.create({ data: { key, value: 'running' } });
    return true;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  const stale = await prisma.opsMarker.updateMany({
    where: { key, value: 'running', updatedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } },
    data: { value: 'running' },
  });
  return stale.count === 1;
}

export interface SettlementResult {
  cycleKey: string;
  periodStart: string;
  periodEnd: string;
  ran: boolean;
  /** already_ran: الدورة أُنجزت (أو تجري الآن في نسخةٍ أخرى) */
  reason: 'already_ran' | null;
  manual: boolean;
  autoApproved: number;
  reconciled: { accrued: number; synced: number };
  payouts: Array<{ id: string; affiliateId: string; netHalalas: number }>;
  totalHalalas: number;
  skipped: Record<string, number>;
}

/**
 * دورة التسوية. التلقائية (من المجدول) مرّةً لكلّ دورة بعلامتها؛ واليدوية (زرّ المالك «تشغيل الدورة
 * الآن») تُعيد المرور على المرشّحين بالمفتاح نفسه — آمنةٌ للتكرار لأنّ لكلّ سفيرٍ دفعةً واحدة في الدورة
 * (`cycle_done`) — فتلتقط من أكمل ملفه بعد مرور الدورة.
 */
export async function runSettlementCycle(now: Date = new Date(), opts: { by?: PlatformActor } = {}): Promise<SettlementResult> {
  const bounds = cycleBounds(now);
  const manual = !!opts.by;
  const base = {
    cycleKey: bounds.cycleKey, periodStart: bounds.periodStart.toISOString(), periodEnd: bounds.periodEnd.toISOString(), manual,
  };
  const key = settlementMarkerKey(bounds.cycleKey);
  const claimed = await claimMarker(key, now);
  if (!claimed && !manual) {
    return { ...base, ran: false, reason: 'already_ran', autoApproved: 0, reconciled: { accrued: 0, synced: 0 }, payouts: [], totalHalalas: 0, skipped: {} };
  }

  const reconciled = await reconcile();
  const { approved: autoApproved } = await autoApproveEligible(now);
  const candidates = await payoutCandidates();
  const payouts: SettlementResult['payouts'] = [];
  const done: Array<{ fullName: string; code: string; netHalalas: number; ibanLast4: string }> = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  for (const c of candidates) {
    if (!c.eligible) {
      // ما دون الحدّ يُرحَّل بصمت؛ والباقي يُعدّ ليعرفه المالك
      if (c.blockedBy && c.blockedBy !== 'below_min') skip(c.blockedBy);
      continue;
    }
    try {
      const p = await createCyclePayout(c.affiliate.id, bounds);
      payouts.push({ id: p.id, affiliateId: p.affiliateId, netHalalas: p.netHalalas });
      done.push({ fullName: c.affiliate.fullName, code: c.affiliate.code, netHalalas: p.netHalalas, ibanLast4: p.ibanLast4 });
    } catch (e) {
      if (e instanceof LedgerError) { skip(e.code ?? 'other'); continue; }
      skip('error');
      console.error(`[affiliate] settlement ${bounds.cycleKey} for ${c.affiliate.id}:`, (e as Error).message);
    }
  }
  const totalHalalas = payouts.reduce((s, p) => s + p.netHalalas, 0);
  const result: SettlementResult = { ...base, ran: true, reason: null, autoApproved, reconciled, payouts, totalHalalas, skipped };

  await prisma.opsMarker.update({
    where: { key },
    data: { value: JSON.stringify({ payouts: payouts.length, totalHalalas, skipped, manual, at: now.toISOString() }).slice(0, 1000) },
  }).catch(e => console.error('[affiliate] settlement marker:', (e as Error).message));

  const waitingProfile = skipped.profile_incomplete ?? 0;
  const waitingIban = skipped.iban_failed ?? 0;
  if (payouts.length || (!manual && (waitingProfile || waitingIban))) {
    mailOwnerSettlementSummary({
      cycleKey: bounds.cycleKey, periodStart: bounds.periodStart, periodEnd: bounds.periodEnd,
      payouts: done, totalHalalas, waitingProfile, waitingIban, autoApproved,
    });
  }
  return result;
}

/** «آخر دورة» للوحة المالك: دفعات آخر دورةٍ انتهت (عدا الملغاة) ومتى أُنجزت */
export async function lastCycleSummary(now: Date = new Date()): Promise<{ cycleKey: string; payouts: number; totalHalalas: number; ranAt: string | null }> {
  const b = cycleBounds(now);
  const [agg, marker] = await Promise.all([
    prisma.affiliatePayout.aggregate({ where: { cycleKey: b.cycleKey, status: { not: 'void' } }, _count: { _all: true }, _sum: { netHalalas: true } }),
    prisma.opsMarker.findUnique({ where: { key: settlementMarkerKey(b.cycleKey) } }),
  ]);
  return {
    cycleKey: b.cycleKey, payouts: agg._count._all, totalHalalas: agg._sum.netHalalas ?? 0,
    ranAt: marker && marker.value !== 'running' ? marker.updatedAt.toISOString() : null,
  };
}

let running = false;

/**
 * المجدول: نبضةٌ كلّ ساعة (وتأخيرٌ بعد الإقلاع) — الاعتماد التلقائي لما انقضى حجزه في كلّ نبضة، ودورة
 * التسوية مرّةً لكلّ نهاية دورة. `unref` فلا يُبقي العملية حيّة، ومفتاح الإطفاء `AX_SETTLEMENT_ENABLED=0`.
 */
export function startAffiliateSettlementScheduler(): void {
  if (process.env.AX_SETTLEMENT_ENABLED === '0') {
    console.log('[affiliate] settlement scheduler disabled (AX_SETTLEMENT_ENABLED=0)');
    return;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      await autoApproveEligible(now);
      const r = await runSettlementCycle(now);
      if (r.ran) console.log(`[affiliate] settlement ${r.cycleKey}: ${r.payouts.length} payouts, ${r.totalHalalas} halalas`);
    } catch (e) {
      console.error('[affiliate] settlement tick:', (e as Error).message);
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void tick(); }, 2 * 60_000).unref?.();
  setInterval(() => { void tick(); }, 3600_000).unref?.();
}
