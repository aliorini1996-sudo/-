/**
 * ملخّص محرّك التكلفة للمعاينة والمطابقة («ربط الدفاتر» L2/L3 — العقد §7): صرفٌ بلا prisma ولا ساعة.
 *
 * - الافتتاح (openingByLocation): Σ مساهمات المواقع للّقطات **المشمولة بالافتتاح** — بقاعدة الأستاذ نفسها
 *   (classify.isIncludedInOpening بلا cleanStart): أثرٌ قبل linkedFrom وتسجيلٌ حتى T0. ليس «الحالة في تاريخ»: المؤرَّخ
 *   مستقبلاً المسجَّل قبل T0 يبقى خارج الافتتاح حتى تاريخه، والوارد المتأخّر (أثر قبل البدء وتسجيل بعد T0) يدخل السنة —
 *   فتلتقي سطور 114001/114002 الافتتاحية بما سيرحّله L4/L6 للسنة حرفياً بلا ازدواج ولا ثغرة.
 * - الآن (nowByLocation) = مجاميع الحالة الأخيرة (stateTotals) — والثابت: Σ المساهمات كلها = الآن (انعدام الانجراف).
 * - تكلفة السنة وفروقها وشطبها: Σ glImpactOf للّقطات غير المشمولة (R9 المتوقَّع).
 * - الرصيد بلا تكلفة والسالب عند بداية السنة: من الحالة الملتقطة عند zonedStartOfDay(linkedFrom) (replay captureAt) — P9.
 */
import { compareLocalDate, localDate } from '../gl/dates';
import { glImpactOf } from './accounts';
import { fromQtyU, toQtyU } from './math';
import { compareLocations, splitLocStateKey, stateTotals } from './stepper';
import {
  STEP_WARNINGS,
  type CostState, type CostingSummary, type LocationKey, type LocationTotals, type Milli, type StepOutput,
  type SummarizeOptions,
} from './types';

/** عيّنة الحُفر المسدودة بفرق (P10) */
export const HOLES_SAMPLE = 50;
/** عيّنة كل تحذير */
export const SUMMARY_WARNING_SAMPLE = 20;

/**
 * مشمولٌ بالافتتاح ⇔ localDate(effectAt) < cutoverDate و srcCreatedAt ≤ openingSnapshotAt — مرآة isIncludedInOpening
 * (services/gl/sync/classify.ts) بلا cleanStart: الربط يبني عكس ما قبل السنة من المصدر (القاعدة 7).
 */
export function includedInCostOpening(
  o: Pick<StepOutput, 'effectAt' | 'srcCreatedAt'>,
  opts: Pick<SummarizeOptions, 'cutoverDate' | 'openingSnapshotAt' | 'timezone'>,
): boolean {
  if (o.srcCreatedAt.getTime() > opts.openingSnapshotAt.getTime()) return false;
  return compareLocalDate(localDate(o.effectAt, opts.timezone), opts.cutoverDate) < 0;
}

interface Acc { qU: number; uqU: number; v: Milli }

function addTo(by: Map<LocationKey, Acc>, loc: LocationKey, qU: number, uqU: number, v: Milli): void {
  const a = by.get(loc) ?? { qU: 0, uqU: 0, v: 0n };
  a.qU += qU;
  a.uqU += uqU;
  a.v += v;
  by.set(loc, a);
}

/**
 * مساهمة لقطة في مواقعها (العقد §4.7-1): location ⇐ valueMilli وbaseQty، وtoLocation ⇐ −valueMilli − varianceMilli و−baseQty.
 * الكمية «خارج التقييم» تدفّقٌ: الداخل +uncostedQty والخارج −uncostedQty (والتحويل ينقلها)؛ هي للعرض — سدّ حفرةٍ بكميةٍ
 * غير مقيَّمة يجعلها تقريبية، والدقيق منها عند بداية السنة في uncostedAtCutover (من الحالة الملتقطة).
 */
function contribute(by: Map<LocationKey, Acc>, o: StepOutput): void {
  const qU = toQtyU(o.baseQty);
  const uqU = toQtyU(o.uncostedQty);
  const sign = qU < 0 ? -1 : qU > 0 ? 1 : 0;
  addTo(by, o.location, qU, sign * uqU, o.valueMilli);
  if (o.toLocation) addTo(by, o.toLocation, -qU, uqU, -o.valueMilli - o.varianceMilli);
}

function totalsOf(by: Map<LocationKey, Acc>): LocationTotals[] {
  const out: LocationTotals[] = [];
  for (const [location, a] of by) {
    if (!Number.isSafeInteger(a.qU) || !Number.isSafeInteger(a.uqU)) throw new RangeError('مجموع كميات الموقع خارج المدى الآمن');
    if (a.qU === 0 && a.uqU === 0 && a.v === 0n) continue;
    out.push({ location, qtyBase: fromQtyU(a.qU), uncostedQty: fromQtyU(a.uqU), valueMilli: a.v });
  }
  return out.sort((x, y) => compareLocations(x.location, y.location));
}

const cmpStr = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);
const absMilli = (v: Milli): Milli => (v < 0n ? -v : v);

export function summarizeCosting(outputs: readonly StepOutput[], finalState: CostState, opts: SummarizeOptions): CostingSummary {
  const opening = new Map<LocationKey, Acc>();
  const products = new Set<string>();
  let fyCogsMilli = 0n;
  let fyVarianceMilli = 0n;
  let fyWriteOffMilli = 0n;
  let holeCount = 0;
  let holeSum = 0n;
  const holes: { key: string; productId: string; location: LocationKey; varianceMilli: Milli }[] = [];
  const stepWarn = new Map<string, { count: number; sample: string[] }>();

  for (const o of outputs) {
    products.add(o.productId);
    for (const w of o.warnings) {
      const s = stepWarn.get(w) ?? { count: 0, sample: [] };
      s.count += 1;
      if (s.sample.length < SUMMARY_WARNING_SAMPLE) s.sample.push(o.key);
      stepWarn.set(w, s);
    }
    if (includedInCostOpening(o, opts)) {
      contribute(opening, o);
      continue;
    }
    const g = glImpactOf(o);
    fyCogsMilli += g.cogsMilli;
    fyWriteOffMilli += g.writeOffMilli;
    fyVarianceMilli += o.varianceMilli;
    if (o.varianceMilli !== 0n) {
      holeCount += 1;
      holeSum += o.varianceMilli;
      // الفرق يقع على الموقع المستقبِل: toLocation للتحويل، وإلا location
      holes.push({ key: o.key, productId: o.productId, location: o.toLocation ?? o.location, varianceMilli: o.varianceMilli });
    }
  }
  for (const k of finalState.locs.keys()) products.add(splitLocStateKey(k).productId);

  holes.sort((a, b) => {
    const d = absMilli(b.varianceMilli) - absMilli(a.varianceMilli);
    return d > 0n ? 1 : d < 0n ? -1 : cmpStr(a.key, b.key);
  });

  // الرصيد بلا تكلفة والسالب عند بداية السنة — من الحالة الفعلية الملتقطة (لا من التدفّق)
  const uncosted: { productId: string; location: LocationKey; uncostedQty: number; u: number }[] = [];
  const negative: { productId: string; location: LocationKey; qtyBase: number; u: number }[] = [];
  let uncostedTotalU = 0;
  if (opts.atCutover) {
    for (const [k, s] of opts.atCutover.locs) {
      const { productId, location } = splitLocStateKey(k);
      if (s.uncostedQtyU > 0) {
        uncosted.push({ productId, location, uncostedQty: fromQtyU(s.uncostedQtyU), u: s.uncostedQtyU });
        uncostedTotalU += s.uncostedQtyU;
      }
      const total = s.costedQtyU + s.uncostedQtyU;
      if (total < 0) negative.push({ productId, location, qtyBase: fromQtyU(total), u: total });
    }
  }
  const byQtyDesc = (a: { u: number; productId: string; location: LocationKey }, b: { u: number; productId: string; location: LocationKey }) =>
    Math.abs(b.u) - Math.abs(a.u) || cmpStr(a.productId, b.productId) || compareLocations(a.location, b.location);
  uncosted.sort(byQtyDesc);
  negative.sort(byQtyDesc);

  const warnings: CostingSummary['warnings'] = [];
  for (const code of STEP_WARNINGS) {
    const s = stepWarn.get(code);
    if (s) warnings.push({ code, count: s.count, sample: s.sample });
  }
  for (const w of opts.streamWarnings ?? []) {
    if (w.count > 0) warnings.push({ code: w.code, count: w.count, sample: [...w.sample] });
  }

  return {
    moveCount: outputs.length,
    productCount: products.size,
    openingByLocation: totalsOf(opening),
    nowByLocation: stateTotals(finalState),
    fyCogsMilli,
    fyVarianceMilli,
    fyWriteOffMilli,
    uncostedAtCutover: uncosted.map(({ productId, location, uncostedQty }) => ({ productId, location, uncostedQty })),
    uncostedAtCutoverTotalQty: fromQtyU(uncostedTotalU),
    negativeAtCutover: negative.map(({ productId, location, qtyBase }) => ({ productId, location, qtyBase })),
    holesFy: { count: holeCount, varianceMilli: holeSum, sample: holes.slice(0, HOLES_SAMPLE) },
    warnings,
  };
}
