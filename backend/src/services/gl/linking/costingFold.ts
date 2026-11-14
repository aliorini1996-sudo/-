/**
 * طور COSTING في المعاينة طيّاً تزايدياً على دفعات (L2 — إصلاح ذاكرة المعاينة).
 *
 * كان الطور يحمّل حركات المخزون **لكل التاريخ** في مصفوفة واحدة (loadMoves بلا afterCursor ولا maxMoves)، ثم يُخرج replay ناتجاً
 * كاملاً لكل حركة، ثم يمرّ summarizeCosting على المصفوفة كلها — وتبقى الحركات حيّةً حتى نهاية المعاينة (sourceRows منها):
 * ~0.9KB حركة+ناتج لكل حركة على عمليةٍ ذاكرتها 512MB، فشركةٌ بنحو 120 ألف حركة تاريخية كانت تنفد ذاكرتها في replay نفسه.
 *
 * هنا: `loadMoves({afterCursor, maxMoves: batch})` ⇒ `replay(batch, {state, lookup})` بحالة الدفعة السابقة ⇒ `summarizeCosting`
 * للدفعة ⇒ دمج الملخّصات. الحتمية مضمونة بـD2 (الترتيب بلحظة تسجيل المصدر): الطيّ التزايدي = الإعادة الكاملة حرفياً، والدمج
 * يعيد ملخّص المصفوفة الواحدة حرفياً (اختبار linking-costing-fold يقارن الدفعات بأحجام 1 و2 و3 و… بالدفعة الواحدة). لا يبقى
 * من التاريخ إلا الحالة (صنف × موقع) ومراجع اللقطات **القابلة للإحالة** (بنود الفواتير وتبديلات الإعادة — mirrorOf/locationOf/
 * memoOf لا تشير إلى غيرها)، ويُرفض ما فوق PREVIEW_MAX_COST_MOVES بـTOO_LARGE لا بنفاد الذاكرة. وبين الدفعات تُترك حلقة الأحداث.
 */
import type { Prisma } from '@prisma/client';
import { compareLocations, snapshotRefOf, splitLocStateKey } from '../../costing/stepper';
import { HOLES_SAMPLE, SUMMARY_WARNING_SAMPLE } from '../../costing/summary';
import {
  STEP_WARNINGS,
  type CostCursor, type CostState, type CostingSummary, type LocationKey, type LocationTotals, type Move, type SnapshotRef,
  type StreamWarning,
} from '../../costing/types';
import { toQtyU, fromQtyU } from '../../costing/math';
import { STREAM_WARNING_SAMPLE } from '../../costing/streams';
import type { PreviewDeps } from './types';

/** حركات كل دفعة طيّ (≈ ذاكرة الدفعة: حركاتها ونواتجها وحدها) */
export const PREVIEW_COST_BATCH = 5_000;
/** سقف حركات التكلفة في المعاينة (كل التاريخ) — فوقه TOO_LARGE قبل أن تنفد الذاكرة (مراجع الإحالة ~0.3KB لكل بند فاتورة) */
export const PREVIEW_MAX_COST_MOVES = 300_000;

/** تجاوزت حركات التكلفة السقف */
export class CostingTooLargeError extends Error {
  readonly code = 'TOO_LARGE' as const;
  constructor(readonly moves: number, readonly maxMoves: number) {
    super(`حركات التكلفة ${moves} تتجاوز سقف المعاينة ${maxMoves}`);
    this.name = 'CostingTooLargeError';
  }
}

export interface CostingFoldInput {
  until: Date;
  currencyDecimals: number;
  cutoverDate: string;
  cutoverStart: Date;
  openingSnapshotAt: Date;
  timezone: string;
  /** للاختبار والقياس (الإنتاج يترك الثابتين) */
  batchMoves?: number;
  maxMoves?: number;
  /** بين الدفعات: نبض التقدّم وترك حلقة الأحداث */
  onBatch?: (folded: number) => Promise<void> | void;
}

export interface CostingFoldResult {
  summary: CostingSummary;
  sourceRows: Record<string, number>;
  /** عدد النواتج (اللقطات المستقبلية) */
  snapshots: number;
  batches: number;
}

/** لقطةٌ قد تُحال إليها حركةٌ لاحقة: بنود الفواتير (البيع والمرتجع وإلغاؤهما) وتبديلات الإعادة — لا الوارد ولا السيارة */
function referenceable(key: string): boolean {
  return key.startsWith('COST:INVOICE:') || key.startsWith('COST:RESTOCK_LOG:');
}

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

function mergeStreamWarnings(into: Map<string, { count: number; sample: string[] }>, order: string[], ws: readonly StreamWarning[]): void {
  for (const w of ws) {
    let a = into.get(w.code);
    if (!a) { a = { count: 0, sample: [] }; into.set(w.code, a); order.push(w.code); }
    a.count += w.count;
    for (const s of w.sample) if (a.sample.length < STREAM_WARNING_SAMPLE) a.sample.push(s);
  }
}

const absMilli = (v: bigint): bigint => (v < 0n ? -v : v);
const cmpStr = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

/**
 * يدمج ملخّصات الدفعات بقواعد summarizeCosting نفسها: الافتتاح بالجمع لكل موقع (بالميكرو، ويسقط الصفري كلياً)، والسنة بالجمع،
 * والحُفر بأكبرها |فرقاً| ثم المفتاح، وعيّنات تحذيرات الخطوات بترتيب النواتج — والآن والرصيد عند البدء وتحذيرات المصادر من
 * الدفعة الأخيرة (وحدها مُرّر لها atCutover وstreamWarnings). دفعةٌ واحدة ⇒ ملخّصها كما هو.
 */
export function mergeCostingSummaries(parts: readonly CostingSummary[], o: { productCount: number; streamWarningCount: number }): CostingSummary {
  if (parts.length === 0) throw new RangeError('لا ملخّصات للدمج');
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const opening = new Map<LocationKey, { qU: number; uqU: number; v: bigint }>();
  let moveCount = 0;
  let fyCogsMilli = 0n;
  let fyVarianceMilli = 0n;
  let fyWriteOffMilli = 0n;
  let holeCount = 0;
  let holeSum = 0n;
  const holes: CostingSummary['holesFy']['sample'] = [];
  const step = new Map<string, { count: number; sample: string[] }>();
  parts.forEach((p, i) => {
    moveCount += p.moveCount;
    fyCogsMilli += p.fyCogsMilli;
    fyVarianceMilli += p.fyVarianceMilli;
    fyWriteOffMilli += p.fyWriteOffMilli;
    holeCount += p.holesFy.count;
    holeSum += p.holesFy.varianceMilli;
    holes.push(...p.holesFy.sample);
    for (const t of p.openingByLocation) {
      const a = opening.get(t.location) ?? { qU: 0, uqU: 0, v: 0n };
      a.qU += toQtyU(t.qtyBase);
      a.uqU += toQtyU(t.uncostedQty);
      a.v += t.valueMilli;
      opening.set(t.location, a);
    }
    // تحذيرات الخطوات (أولاً في كل ملخّص) — وفي الأخير تليها تحذيرات المصادر المدموجة
    const ws = i === parts.length - 1 ? p.warnings.slice(0, p.warnings.length - o.streamWarningCount) : p.warnings;
    for (const w of ws) {
      const a = step.get(w.code) ?? { count: 0, sample: [] };
      a.count += w.count;
      for (const s of w.sample) if (a.sample.length < SUMMARY_WARNING_SAMPLE) a.sample.push(s);
      step.set(w.code, a);
    }
  });
  const openingByLocation: LocationTotals[] = [];
  for (const [location, a] of opening) {
    if (a.qU === 0 && a.uqU === 0 && a.v === 0n) continue;
    openingByLocation.push({ location, qtyBase: fromQtyU(a.qU), uncostedQty: fromQtyU(a.uqU), valueMilli: a.v });
  }
  openingByLocation.sort((x, y) => compareLocations(x.location, y.location));
  holes.sort((a, b) => {
    const d = absMilli(b.varianceMilli) - absMilli(a.varianceMilli);
    return d > 0n ? 1 : d < 0n ? -1 : cmpStr(a.key, b.key);
  });
  const warnings: CostingSummary['warnings'] = [];
  for (const code of STEP_WARNINGS) {
    const a = step.get(code);
    if (a) warnings.push({ code, count: a.count, sample: a.sample });
  }
  warnings.push(...last.warnings.slice(last.warnings.length - o.streamWarningCount));
  return {
    moveCount,
    productCount: o.productCount,
    openingByLocation,
    nowByLocation: last.nowByLocation,
    fyCogsMilli,
    fyVarianceMilli,
    fyWriteOffMilli,
    uncostedAtCutover: last.uncostedAtCutover,
    uncostedAtCutoverTotalQty: last.uncostedAtCutoverTotalQty,
    negativeAtCutover: last.negativeAtCutover,
    holesFy: { count: holeCount, varianceMilli: holeSum, sample: holes.slice(0, HOLES_SAMPLE) },
    warnings,
  };
}

/**
 * يطوي حركات الشركة كلها حتى until على دفعات، ويعيد ملخّصها (= summarizeCosting على المصفوفة الواحدة) وعدّ صفوف المصادر.
 * الرصيد عند بداية السنة يُلتقط في الدفعة التي تعبر cutoverStart (أو الأخيرة): replay يلتقط قبل أول حركة createdAt ≥ T.
 */
export async function foldCostingForPreview(
  deps: Pick<PreviewDeps, 'loadMoves' | 'replay' | 'summarizeCosting'>,
  db: Prisma.TransactionClient, tenantId: string, input: CostingFoldInput,
): Promise<CostingFoldResult> {
  const batch = input.batchMoves ?? PREVIEW_COST_BATCH;
  const maxMoves = input.maxMoves ?? PREVIEW_MAX_COST_MOVES;
  if (!(batch >= 1)) throw new RangeError(`batchMoves غير صالح: ${batch}`);
  const cfg = { currencyDecimals: input.currencyDecimals };
  const T = input.cutoverStart.getTime();

  let state: CostState | undefined;
  let cursor: CostCursor | null = null;
  let atCutover: CostState | null = null;
  const refs = new Map<string, SnapshotRef>();
  const lookup = { get: (k: string) => refs.get(k) };
  const products = new Set<string>();
  const sourceRows: Record<string, number> = {};
  const stream = new Map<string, { count: number; sample: string[] }>();
  const streamOrder: string[] = [];
  /** صفّ أساسي مكرَّر في دفعة لاحقة (loadMoves يكشفه داخل الاستدعاء وحده): مفتاحه مطويٌّ قبلاً ⇒ يُتخطّى ويُحذَّر كما يحذّر */
  const dupRows = new Set<string>();
  const parts: CostingSummary[] = [];
  let folded = 0;
  let outputs = 0;
  let batches = 0;

  for (;;) {
    const r = await deps.loadMoves(db, tenantId, {
      until: input.until, currencyDecimals: input.currencyDecimals, maxMoves: batch, ...(cursor ? { afterCursor: cursor } : {}),
    });
    batches += 1;
    for (const [k, n] of Object.entries(r.sourceRows)) sourceRows[k] = (sourceRows[k] ?? 0) + n;
    mergeStreamWarnings(stream, streamOrder, r.warnings);
    const moves: Move[] = [];
    for (const m of r.moves) {
      if (refs.has(m.key)) {
        if (!dupRows.has(m.cursor.id)) {
          dupRows.add(m.cursor.id);
          mergeStreamWarnings(stream, streamOrder, [{ code: 'DUPLICATE_PRIMARY_ROW', count: 1, sample: [m.cursor.id] } as StreamWarning]);
        }
        continue;
      }
      moves.push(m);
    }
    folded += moves.length;
    if (folded > maxMoves) throw new CostingTooLargeError(folded, maxMoves);
    const last = !r.truncated;
    const capture = !atCutover && (last || moves.some((m) => m.cursor.createdAt.getTime() >= T));
    const rr = deps.replay(moves, cfg, { ...(state ? { state } : {}), lookup, ...(capture ? { captureAt: [input.cutoverStart] } : {}) });
    if (capture) atCutover = rr.captured[0] ?? null;
    state = rr.state;
    outputs += rr.outputs.length;
    for (const o of rr.outputs) {
      products.add(o.productId);
      if (referenceable(o.key)) refs.set(o.key, snapshotRefOf(o));
    }
    const streamWarnings: StreamWarning[] = last
      ? streamOrder.map((code) => ({ code, count: stream.get(code)!.count, sample: [...stream.get(code)!.sample] }) as StreamWarning)
      : [];
    parts.push(deps.summarizeCosting(rr.outputs, state, {
      cutoverDate: input.cutoverDate, cutoverStart: input.cutoverStart, openingSnapshotAt: input.openingSnapshotAt, timezone: input.timezone,
      atCutover: last ? atCutover : null, streamWarnings,
    }));
    if (r.cursor) cursor = r.cursor;
    if (last) {
      for (const k of state.locs.keys()) products.add(splitLocStateKey(k).productId);
      const streamCount = streamWarnings.filter((w) => w.count > 0).length;
      return {
        summary: mergeCostingSummaries(parts, { productCount: products.size, streamWarningCount: streamCount }),
        sourceRows, snapshots: outputs, batches,
      };
    }
    // صفّ مصدرٍ لم يتقدّم المؤشّر بعده (لا يحدث: loadMoves يتوقّف عند حدّ صفّ) — حارسٌ من الدوران
    if (!r.cursor && r.moves.length === 0) throw new Error('loadMoves أعاد دفعة مقصوصة بلا مؤشّر');
    await input.onBatch?.(folded);
    await yieldLoop();
  }
}
