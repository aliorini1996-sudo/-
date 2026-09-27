/**
 * حلقة التعلّم — ما يواجهه المندوب في الميدان (§3.7): إحصاء ليلي لكل شركة على حدة من نتائج زيارات مناديبها.
 *
 * الوحدة «حلقة» = (محل، نافذة ٣٠ يوماً) بأفضل نتيجة فيها — فخمس زيارات لمحل واحد في الشهر لا تُحسب خمس مرات.
 *   - وزن الحلقة = وزن الباب (عند المحل ١، غير معروف ٠٫٧، بعيد ٠٫٤) × سقف المندوب (لا يطغى مندوب نشيط على الشركة).
 *   - بوابة التعرّض: لا تُعرض خانة (للمندوب أو العقل أو الدروس أو الملخّص) إلا بوزن كافٍ ومناديب كافين وحصة أكبر مندوب محدودة.
 *   - القبول لكل نوع، والتحويل بعد الاهتمام، وأسباب الرفض (ديريشليه)، وما يحدث عند العودة، والإغلاق لكل فترة من اليوم (انكماش بيتا).
 * الحلقات التي كان المحل فيها عميلاً تُستبعد، والحلقات «مغلق فقط» تذهب لإحصاء الإغلاق وحده.
 * العزل: الاستعلامان مقيّدان بـ"tenantId" على طرفي الربط (الأحداث والمحلات).
 */
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { clamp } from './stats';
import { hourOfDayBand, normalizeAr, OBJECTION_CODES } from './signals';
import type { FieldCell, FieldStats, FieldTypeStats, ObjectionCode } from './types';

export interface EpisodeRow {
  type: string;
  outletId: string;
  /** floor(epoch / ٣٠ يوماً) */
  bucket: number;
  /** أفضل نتيجة: تحويل ٥، اهتمام/عرض سعر ٤، عُد لاحقاً ٣، رفض/مورّد حصري ١، مغلق ٠ */
  best: number;
  onlyClosed: boolean;
  /** مندوب أول حدث في الحلقة */
  rep: string;
  firstAt: Date;
  anyDoor: boolean | null;
  doorUnknown: boolean;
  /** أول اعتراض مسجَّل في الحلقة */
  objection: string | null;
  wasCustomer: boolean | null;
  convertedAt: Date | null;
}

export interface ClosedRow { type: string; h: number; rep: string; n: number; closed: number }

const DAY_MS = 86_400_000;
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** الاستعلامان (قراءة فقط، نافذة منذ since، الساعة المحلية بمنطقة الشركة tz). */
export async function loadFieldRows(tid: string, since: Date, tz: string): Promise<{ episodes: EpisodeRow[]; closedRows: ClosedRow[] }> {
  const [eps, closed] = await Promise.all([
    prisma.$queryRaw<EpisodeRow[]>(Prisma.sql`
      SELECT o."outletType" AS type, e."outletId" AS "outletId",
             floor(extract(epoch from e."occurredAt") / 2592000)::int AS bucket,
             MAX(CASE e.kind WHEN 'CONVERTED' THEN 5 WHEN 'QUOTE' THEN 4 WHEN 'INTERESTED' THEN 4
                  WHEN 'CALL_BACK' THEN 3 WHEN 'NOT_INTERESTED' THEN 1 WHEN 'EXCLUSIVE_SUPPLIER' THEN 1 ELSE 0 END)::int AS best,
             bool_and(e.kind = 'CLOSED') AS "onlyClosed",
             (array_agg(e."salesRepId" ORDER BY e."occurredAt"))[1] AS rep,
             MIN(e."occurredAt") AS "firstAt",
             bool_or(e."atDoor") AS "anyDoor", bool_and(e."atDoor" IS NULL) AS "doorUnknown",
             (array_agg(e.objection ORDER BY e."occurredAt") FILTER (WHERE e.objection IS NOT NULL))[1] AS objection,
             bool_or(e.relation = 'CUSTOMER') AS "wasCustomer",
             MIN(o."convertedAt") AS "convertedAt"
      FROM ai_outlet_events e
      JOIN ai_outlets o ON o.id = e."outletId" AND o."tenantId" = ${tid}
      WHERE e."tenantId" = ${tid} AND e."occurredAt" >= ${since}
      GROUP BY 1, 2, 3
      ORDER BY "firstAt" DESC
      LIMIT 20000`),
    // حدث التحويل يُكتب لحظة إنشاء العميل (غالباً من المكتب) — ليس زيارة، فلا يدخل مقام الإغلاق
    prisma.$queryRaw<ClosedRow[]>(Prisma.sql`
      SELECT o."outletType" AS type,
             extract(hour from (e."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::int AS h,
             e."salesRepId" AS rep, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE e.kind = 'CLOSED')::int AS closed
      FROM ai_outlet_events e
      JOIN ai_outlets o ON o.id = e."outletId" AND o."tenantId" = ${tid}
      WHERE e."tenantId" = ${tid} AND e."occurredAt" >= ${since} AND e.kind <> 'CONVERTED'
      GROUP BY 1, 2, 3
      LIMIT 20000`),
  ]);
  return {
    episodes: eps.map(r => ({
      type: r.type, outletId: r.outletId, bucket: Number(r.bucket), best: Number(r.best), onlyClosed: r.onlyClosed === true,
      rep: r.rep, firstAt: new Date(r.firstAt), anyDoor: r.anyDoor ?? null, doorUnknown: r.doorUnknown === true,
      objection: r.objection ?? null, wasCustomer: r.wasCustomer ?? null, convertedAt: r.convertedAt ? new Date(r.convertedAt) : null,
    })),
    closedRows: closed.map(r => ({ type: r.type, h: Number(r.h), rep: r.rep, n: Number(r.n), closed: Number(r.closed) })),
  };
}

// ───────────── الأوزان والبوابة ─────────────

/**
 * بوابة التعرّض: وزن ≥ (مندوبان فأكثر ? ١٢ : ٢٠)، ومناديب ≥ min(٣، النشطين)،
 * وحصة أكبر مندوب ≤ (٣ فأكثر ? ٠٫٥ : مندوبان ? ٠٫٧ : ١).
 */
export function exposureGate(cell: { sumW: number; reps: number; topRepShare: number }, activeReps: number): boolean {
  const minW = activeReps >= 2 ? 12 : 20;
  const maxShare = activeReps >= 3 ? 0.5 : activeReps === 2 ? 0.7 : 1;
  return cell.sumW + 1e-9 >= minW && cell.reps >= Math.min(3, activeReps) && cell.topRepShare <= maxShare + 1e-9;
}

/** سقف المندوب: R = مناديب لهم ≥٥ وحدات، cap = R≤1 ? 1 : max(0.35, 1.5/R)، والوزن = min(1, cap·N/n_rep). */
function repCapWeights(counts: Map<string, number>): Map<string, number> {
  let N = 0, R = 0;
  for (const n of counts.values()) { N += n; if (n >= 5) R++; }
  const cap = R <= 1 ? 1 : Math.max(0.35, 1.5 / R);
  const w = new Map<string, number>();
  for (const [rep, n] of counts) w.set(rep, n > 0 ? Math.min(1, (cap * N) / n) : 1);
  return w;
}

const doorWeight = (e: EpisodeRow): number => (e.anyDoor ? 1 : e.doorUnknown ? 0.7 : 0.4);

interface WEp { e: EpisodeRow; w: number }

/** خانة إحصاء: العدد الخام، والمناديب، وحصة أكبر مندوب من الوزن، ونتيجة البوابة. */
function cellOf(items: { rep: string; w: number }[], activeReps: number): { cell: FieldCell; sumW: number } {
  const byRep = new Map<string, number>();
  let sumW = 0;
  for (const it of items) { sumW += it.w; byRep.set(it.rep, (byRep.get(it.rep) ?? 0) + it.w); }
  let top = 0;
  for (const v of byRep.values()) top = Math.max(top, v);
  const topRepShare = sumW > 0 ? top / sumW : 0;
  const reps = byRep.size;
  return { cell: { n: items.length, reps, topRepShare: r4(topRepShare), exposed: exposureGate({ sumW, reps, topRepShare }, activeReps) }, sumW };
}

const sumOf = (items: WEp[], pred: (e: EpisodeRow) => boolean): number => items.reduce((s, x) => s + (pred(x.e) ? x.w : 0), 0);
const toRep = (x: WEp) => ({ rep: x.e.rep, w: x.w });
const KNOWN_OBJ = new Set<string>(OBJECTION_CODES);

// ───────────── الإحصاء ─────────────

/** إحصاء الميدان (صرف): الحلقات من الاستعلام الأول، والإغلاق لكل ساعة من الثاني. */
export function computeFieldStats(episodes: EpisodeRow[], closedRows: ClosedRow[], opts: { now: Date; activeReps: number }): FieldStats {
  const now = opts.now.getTime();
  // النشطون فعلاً لا يقلّون عمّن ظهر في البيانات (الاستعلام الثاني يغطّي كل حدث في النافذة)
  const seen = new Set<string>([...episodes.map(e => e.rep), ...closedRows.map(r => r.rep)]);
  const activeReps = Math.max(opts.activeReps, seen.size);

  const eps = episodes.filter(e => e.wasCustomer !== true);
  const rated = eps.filter(e => !e.onlyClosed);
  const perRep = new Map<string, number>();
  for (const e of rated) perRep.set(e.rep, (perRep.get(e.rep) ?? 0) + 1);
  const wRep = repCapWeights(perRep);
  const all: WEp[] = rated.map(e => ({ e, w: doorWeight(e) * (wRep.get(e.rep) ?? 1) }));

  const isPos = (e: EpisodeRow) => e.best >= 4;
  const totalW = all.reduce((s, x) => s + x.w, 0);
  const mu = totalW > 0 ? sumOf(all, isPos) / totalW : 0;

  // الإغلاق: سقف المندوب على صفوف كل مندوب (بعدد أحداثه)
  const perRepC = new Map<string, number>();
  for (const r of closedRows) perRepC.set(r.rep, (perRepC.get(r.rep) ?? 0) + r.n);
  const wRepC = repCapWeights(perRepC);

  const types = new Set<string>([...eps.map(e => e.type), ...closedRows.map(r => r.type)]);
  const byType: Record<string, FieldTypeStats> = {};
  for (const t of types) {
    const items = all.filter(x => x.e.type === t);
    const { cell, sumW } = cellOf(items.map(toRep), activeReps);
    const S = sumOf(items, isPos);
    const typeMult = sumW >= 8 && totalW >= 30 && mu > 0 ? clamp((S + 15 * mu) / (sumW + 15) / mu, 0.6, 1.6) : 1;

    // التحويل خلال ٣٠ يوماً من أول اهتمام (للحلقات التي مضى عليها ٣٠ يوماً)، لاحق بيتا(1+conv، 3+non)
    const matured = items.filter(x => isPos(x.e) && x.e.firstAt.getTime() <= now - 30 * DAY_MS);
    const convOf = (e: EpisodeRow) => !!e.convertedAt && e.convertedAt.getTime() >= e.firstAt.getTime() && e.convertedAt.getTime() <= e.firstAt.getTime() + 30 * DAY_MS;
    const conv = matured.length ? cellOf(matured.map(toRep), activeReps) : null;
    const convRate = conv ? { ...conv.cell, rate: r4((1 + sumOf(matured, convOf)) / (4 + conv.sumW)) } : null;

    // أسباب الرفض: متوسط ديريشليه(١…١) على الرموز العشرة — تُحفظ الرموز المرصودة وحدها
    const withObj = items.filter(x => x.e.objection);
    let objections: FieldTypeStats['objections'] = null;
    if (withObj.length) {
      const oc = cellOf(withObj.map(toRep), activeReps);
      const nCode = new Map<ObjectionCode, number>();
      for (const x of withObj) {
        const code = (KNOWN_OBJ.has(x.e.objection!) ? x.e.objection : 'OTHER') as ObjectionCode;
        nCode.set(code, (nCode.get(code) ?? 0) + x.w);
      }
      const shares: Partial<Record<ObjectionCode, number>> = {};
      for (const [code, n] of nCode) shares[code] = r4((1 + n) / (OBJECTION_CODES.length + oc.sumW));
      objections = { ...oc.cell, exposed: oc.cell.exposed && oc.cell.n >= 12, shares };
    }

    // العودة: محل أول حلقة له «عُد لاحقاً» وله حلقة لاحقة خلال ٦٠ يوماً — هل صارت إيجابية؟
    const byOutlet = new Map<string, WEp[]>();
    for (const x of items) {
      const l = byOutlet.get(x.e.outletId);
      if (l) l.push(x); else byOutlet.set(x.e.outletId, [x]);
    }
    const cbItems: WEp[] = [];
    const cbPos = new Set<WEp>();
    for (const list of byOutlet.values()) {
      list.sort((a, b) => a.e.firstAt.getTime() - b.e.firstAt.getTime());
      const first = list[0];
      if (first.e.best !== 3) continue;
      const t0 = first.e.firstAt.getTime();
      const later = list.slice(1).filter(x => x.e.firstAt.getTime() > t0 && x.e.firstAt.getTime() <= t0 + 60 * DAY_MS);
      if (!later.length) continue;
      cbItems.push(first);
      if (later.some(x => isPos(x.e))) cbPos.add(first);
    }
    const cb = cbItems.length ? cellOf(cbItems.map(toRep), activeReps) : null;
    const callback = cb ? { ...cb.cell, rate: r4(cbItems.reduce((s, x) => s + (cbPos.has(x) ? x.w : 0), 0) / cb.sumW) } : null;

    // الإغلاق لكل فترة: p_{t,b} = (مغلق_b + 8·p_t) / (n_b + 8)
    const cW = [0, 0, 0, 0, 0], nW = [0, 0, 0, 0, 0], nRaw = [0, 0, 0, 0, 0];
    for (const r of closedRows) {
      if (r.type !== t) continue;
      const b = hourOfDayBand(r.h), w = wRepC.get(r.rep) ?? 1;
      cW[b] += w * r.closed; nW[b] += w * r.n; nRaw[b] += r.n;
    }
    const nT = nW.reduce((s, v) => s + v, 0);
    const pT = nT > 0 ? cW.reduce((s, v) => s + v, 0) / nT : 0;
    const closed = { rate: r4(pT), byBand: cW.map((c, b) => r4((c + 8 * pT) / (nW[b] + 8))), nByBand: nRaw };

    byType[t] = {
      ...cell, posRate: r4(sumW > 0 ? S / sumW : 0), typeMult: Math.round(typeMult * 1000) / 1000,
      convRate, objections, callback, closed,
    };
  }

  return { v: 1, computedAt: opts.now.toISOString(), windowDays: 90, activeReps, tenantPosRate: r4(mu), byType };
}

// ───────────── اقتراحات للإدارة (لا تُحقن في العقل أبداً) ─────────────

/** جذور دليل البيع بعد التوحيد (آجل/أجل ← اجل، أسعار ← اسعار). */
const CREDIT_STEM = /اجل|دفع لاحق/;
const PRICE_STEM = /سعر|اسعار|خصم|عرض/;

/** ما ينقص دليل البيع بحسب ما يواجهه المناديب، والأنواع التي ينقصها تصنيف عملائها. */
export function fieldHints(i: {
  field: FieldStats | null; playbook: string | null; intentCounts: Record<string, number>; chatTotal: number;
  insufficientTypes: string[]; typeLabel: (code: string) => string;
}): { code: string; textAr: string }[] {
  const pb = normalizeAr(i.playbook ?? '');
  const cells = Object.values(i.field?.byType ?? {});
  const objHigh = (code: ObjectionCode) => cells.some(c => c.objections?.exposed && (c.objections.shares[code] ?? 0) >= 0.25);
  const asked = (intent: string) => i.chatTotal >= 30 && (i.intentCounts[intent] ?? 0) / i.chatTotal >= 0.1;
  const hints: { code: string; textAr: string }[] = [];
  if ((objHigh('NEEDS_CREDIT') || asked('OBJ_CREDIT')) && !CREDIT_STEM.test(pb)) {
    hints.push({ code: 'PLAYBOOK_CREDIT', textAr: 'مناديبك يواجهون طلب الآجل ودليل البيع لا يذكر سياستكم — أضفها ليجيب المستشار' });
  }
  if ((objHigh('PRICE') || asked('OBJ_PRICE')) && !PRICE_STEM.test(pb)) {
    hints.push({ code: 'PLAYBOOK_PRICE', textAr: 'مناديبك يُسألون عن الأسعار ودليل البيع لا يذكرها' });
  }
  for (const t of new Set(i.insufficientTypes)) {
    hints.push({ code: `CLASSIFY_TYPE:${t}`, textAr: `صنّف عملاء «${i.typeLabel(t)}» وأضف مواقعهم ليتحسّن التوقّع` });
  }
  return hints;
}
