/**
 * محرّك التكلفة الوحيد: المتوسّط المرجّح المتحرّك لكل موقع («ربط الدفاتر» L3 — قرار المالك OD6).
 * العقد المُلزِم: scratchpad/l23_contract.md §3، §4 (القواعد الدقيقة)، §5 (الأمثلة المحلولة).
 *
 * المستودع: نقلٌ حرفيّ لدلالة valueStock القائمة (warehouseCost.ts) — دلوان مقيَّم/خارج التقييم، الصرف بنسبتهما،
 * سدّ الحفرة أولاً بدلوها، المكشوف على مستودع فارغ بآخر متوسّط — لكن بحساب صحيح بالملّي بلا EPS ولا انجراف.
 * السيارات: AVCO لكل سيارة بدل طبقات LIFO، والمكشوف على سيارة لا متوسّط لها بمتوسّط المستودع (D5).
 *
 * الترتيب بلحظة تسجيل المصدر (cursor.createdAt, cursor.id, key) لا بالتاريخ المحاسبي (D2): الحركة تُقيَّم بمتوسّط
 * لحظة ترحيلها كـSAP، فلا تُعاد كتابة لقطة مضت، والتشغيل التزايدي من نقطة حفظ = الإعادة الكاملة حرفياً.
 *
 * صرفٌ تماماً: لا prisma ولا ساعة ولا عشوائية، ولا يعتمد ناتجٌ على ترتيب تكرار Map (costing-static.test.ts).
 * لا تستدعيه أي شاشة في هذه الدفعة (D6) — المعاينة وحدها، ثم L3b بإذن المالك.
 */
import { roundMilli, unitMilli } from '../gl/money';
import { fromQtyU, mulDivRound, qtyMulDiv, toQtyU, unitCostE4Of } from './math';
import {
  MEMO_KINDS, STEP_WARNINGS, TRANSFER_KINDS, WH_LOCATION, isVanLocation,
  type CostCursor, type CostState, type LocState, type LocationKey, type LocationTotals, type Milli, type Move,
  type MoveKind, type MoveLinks, type ReplayOptions, type ReplayResult, type SnapshotLookup, type SnapshotRef, type StepOutput,
  type StepWarningCode, type StepperConfig,
} from './types';

// ═══ الحالة ═══

/** مفتاح حالة (صنف، موقع) في CostState.locs */
export function locStateKey(productId: string, location: LocationKey): string {
  return `${productId}|${location}`;
}

/** عكس locStateKey — لصفوف نقاط الحفظ وللتجميع بالموقع (المعرّفات لا تحوي «|») */
export function splitLocStateKey(key: string): { productId: string; location: LocationKey } {
  const i = key.indexOf('|');
  if (i <= 0 || i === key.length - 1) throw new RangeError(`مفتاح حالة تكلفة غير صالح: ${key}`);
  return { productId: key.slice(0, i), location: key.slice(i + 1) as LocationKey };
}

export function createCostState(): CostState {
  return { locs: new Map(), movesFolded: 0, cursor: null };
}

/** نسخة مستقلة تماماً (الكائنات الداخلية لا تُشارَك) — لنقاط الالتقاط وحالة البدء */
export function cloneCostState(s: CostState): CostState {
  const locs = new Map<string, LocState>();
  for (const [k, v] of s.locs) {
    locs.set(k, {
      costedQtyU: v.costedQtyU,
      uncostedQtyU: v.uncostedQtyU,
      valueMilli: v.valueMilli,
      lastAvg: v.lastAvg ? { valueMilli: v.lastAvg.valueMilli, qtyU: v.lastAvg.qtyU } : null,
    });
  }
  return {
    locs,
    movesFolded: s.movesFolded,
    cursor: s.cursor ? { createdAt: new Date(s.cursor.createdAt.getTime()), id: s.cursor.id } : null,
  };
}

/** مقارنة نصوص بوحدات الترميز (لا localeCompare: الترتيب لا يتبع لغة الجهاز) */
function cmpStr(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

export function compareCursors(a: CostCursor, b: CostCursor): number {
  const ta = a.createdAt.getTime();
  const tb = b.createdAt.getTime();
  if (ta !== tb) return ta < tb ? -1 : 1;
  return cmpStr(a.id, b.id);
}

/** ترتيب المحرّك الوحيد (D2): لحظة تسجيل المصدر ثم معرّفه ثم المفتاح (بنود الصف الواحد بمعرّف البند) */
export function compareMoves(a: Move, b: Move): number {
  return compareCursors(a.cursor, b.cursor) || cmpStr(a.key, b.key);
}

/** المستودع أولاً ثم السيارات بمعرّفها — ترتيب سطور المخزون الافتتاحية (§11) */
export function compareLocations(a: LocationKey, b: LocationKey): number {
  if (a === b) return 0;
  if (a === WH_LOCATION) return -1;
  if (b === WH_LOCATION) return 1;
  return cmpStr(a, b);
}

// ═══ العمليات الأساسية (§4.2–4.5) ═══

/** متوسّط قائم: قيمة موجبة لكمية مقيَّمة موجبة — وإلا «لا متوسّط» */
interface Avg {
  valueMilli: Milli;
  qtyU: number;
}

/** أجزاء دخلٍ: مقيَّم cq بقيمة إجمالية cv، وخارج التقييم uq (كلها ≥ 0) */
interface InParts {
  cq: number;
  cv: Milli;
  uq: number;
}

interface OutResult {
  outCq: number;
  outV: Milli;
  outUq: number;
  /** مكشوف قُيِّم بالبديل (متوسّط المستودع لسيارة) */
  fallbackUsed: boolean;
  /** مكشوف بلا أي متوسّط — قُيِّم صفراً وانتقل «خارج التقييم» */
  zeroRate: boolean;
}

function avgOf(s: LocState | undefined): Avg | null {
  return s && s.costedQtyU > 0 && s.valueMilli > 0n ? { valueMilli: s.valueMilli, qtyU: s.costedQtyU } : null;
}

function assertSafeState(s: LocState): void {
  if (!Number.isSafeInteger(s.costedQtyU) || !Number.isSafeInteger(s.uncostedQtyU)) {
    throw new RangeError('كمية الموقع خارج المدى الآمن');
  }
}

/**
 * IN — نقل absorb: الدخل يسدّ الحفرة أولاً بدلوها (حفرة لها قيمة يسدّها المقيَّم، وحفرة بلا قيمة يسدّها غير المقيَّم)،
 * ثم يدخل دلويه. الجزء الذي يسدّ الحفرة يُصفّرها بقيمتها هي، وفرق السعر بين ما خرج منها وما سدّها يعود variance
 * (تكلفة مبيعات — E6). يُرجع Δ قيمة الموقع؛ والفرق = cv − Δ.
 */
function absorbIn(s: LocState, cq: number, cv: Milli, uq: number, u: Milli): Milli {
  if (cq < 0 || uq < 0 || cv < 0n || (cq === 0 && cv !== 0n)) {
    throw new Error(`COSTING_INTERNAL: دخل غير صالح (cq=${cq}, cv=${cv}, uq=${uq})`);
  }
  const before = s.valueMilli;
  if (s.costedQtyU < 0) {
    const costedFirst = s.valueMilli < 0n;
    for (let pass = 0; pass < 2 && s.costedQtyU < 0; pass++) {
      const hole = -s.costedQtyU;
      if ((pass === 0) === costedFirst) {
        if (cq > 0) {
          const f = Math.min(cq, hole);
          // «الدلو المصفَّر يأخذ قيمته كلها»: سدٌّ كامل يأخذ قيمة الحفرة بلا تقريب، ونصيب الدخل كله إن استُنفد
          const holePart = f === hole ? s.valueMilli : mulDivRound(s.valueMilli, f, hole, u);
          const inPart = f === cq ? cv : mulDivRound(cv, f, cq, u);
          s.valueMilli -= holePart;
          s.costedQtyU += f;
          cv -= inPart;
          cq -= f;
        }
      } else if (uq > 0) {
        const f = Math.min(uq, hole);
        const holePart = f === hole ? s.valueMilli : mulDivRound(s.valueMilli, f, hole, u);
        s.valueMilli -= holePart;
        s.costedQtyU += f;
        uq -= f;
      }
    }
  }
  s.costedQtyU += cq;
  s.valueMilli += cv;
  s.uncostedQtyU += uq;
  assertSafeState(s);
  return s.valueMilli - before;
}

/**
 * OUT — نقل فرع الخروج في valueStock: المتوسّط يُلتقط قبل الاستنزاف، والموجود يُصرف بنسبة دلويه، والمكشوف يُقيَّد
 * على الدلو المقيَّم بسعر الحفرة (تعميقٌ بسعرها) أو المتوسّط الحالي أو — على موقع فارغ — آخر متوسّط قائم ثم البديل.
 * المكشوف بلا أي متوسّط ينتقل «خارج التقييم» (كطبقة VAN_OUT القديمة): لو انتقل مقيَّماً بصفر لخفّض متوسّط الهدف.
 */
function takeOut(s: LocState, q: number, fallback: () => Avg | null, u: Milli): OutResult {
  if (q <= 0) return { outCq: 0, outV: 0n, outUq: 0, fallbackUsed: false, zeroRate: false };
  const total = s.costedQtyU + s.uncostedQtyU;
  // آخر رصيد قائم: يُحدَّث عند الخروج وحده، وبمتوسّطٍ حقيقي وحده (رصيد بلا قيمة ⇒ لا متوسّط، كـavgOf القديم = 0)
  if (total > 0) s.lastAvg = avgOf(s);
  let rate: Avg | null;
  let fromFallback = false;
  if (s.costedQtyU < 0) {
    // الحفرة قيمتها ≤ 0 دائماً (absorbIn يسدّها قبل أي دخل)، فسعرها |القيمة| ÷ |الكمية|
    rate = s.valueMilli < 0n ? { valueMilli: -s.valueMilli, qtyU: -s.costedQtyU } : null;
  } else if (total > 0) {
    rate = avgOf(s);
  } else if (s.lastAvg) {
    rate = { valueMilli: s.lastAvg.valueMilli, qtyU: s.lastAvg.qtyU };
  } else {
    rate = fallback();
    fromFallback = rate !== null;
  }

  const share = total > 0 ? Math.min(q, total) : 0;
  let outCq = 0;
  let outV = 0n;
  let outUq = 0;
  if (share > 0) {
    if (share === total) {
      // استنزاف كامل: الدلوان يُصفَّران بقيمتهما كلها — لا بقايا تقريب
      outCq = s.costedQtyU;
      outV = s.valueMilli;
      outUq = s.uncostedQtyU;
      s.costedQtyU = 0;
      s.valueMilli = 0n;
      s.uncostedQtyU = 0;
    } else {
      const fc = qtyMulDiv(share, s.costedQtyU, total);
      const v = fc === s.costedQtyU ? s.valueMilli : mulDivRound(s.valueMilli, fc, s.costedQtyU, u);
      s.costedQtyU -= fc;
      s.valueMilli -= v;
      s.uncostedQtyU -= share - fc;
      outCq = fc;
      outV = v;
      outUq = share - fc;
    }
  }

  const deficit = q - share;
  let zeroRate = false;
  if (deficit > 0) {
    const dv = rate ? mulDivRound(rate.valueMilli, deficit, rate.qtyU, u) : 0n;
    s.costedQtyU -= deficit;
    s.valueMilli -= dv;
    outV += dv;
    if (rate) outCq += deficit;
    else {
      outUq += deficit;
      zeroRate = true;
    }
  }
  assertSafeState(s);
  return { outCq, outV, outUq, fallbackUsed: deficit > 0 && fromFallback, zeroRate };
}

/** ADD_AT_AVG (§4.4): دخلٌ بلا ثمن موثَّق — بالمتوسّط المعطى إن وُجد، وإلا خارج التقييم (addAtAvg القائم) */
function atAvgParts(q: number, avg: Avg | null, u: Milli): InParts {
  return avg ? { cq: q, cv: mulDivRound(avg.valueMilli, q, avg.qtyU, u), uq: 0 } : { cq: 0, cv: 0n, uq: q };
}

/**
 * MIRROR (§4.5): دخلٌ بقيمة لقطة خروج سابقة بالتناسب — كمية m من أصلٍ Q_o خرج منه U_o خارج التقييم بقيمة G_o.
 * الكمية الأكبر من الأصل (مرتجع أكثر من المبيع) تُمدّ بالنسبة نفسها. لقطة لا تصلح مرآةً (بلا كمية، أو دخلٌ لا خروج) ⇒ null.
 */
function mirrorParts(ref: SnapshotRef, m: number, u: Milli): InParts | null {
  if (m <= 0) return null;
  const qo = Math.abs(toQtyU(ref.baseQty));
  if (qo === 0 || ref.valueMilli > 0n) return null;
  const go = -ref.valueMilli;
  const uo = Math.min(qo, Math.abs(toQtyU(ref.uncostedQty)));
  const co = qo - uo;
  const cq = m === qo ? co : qtyMulDiv(co, m, qo);
  // غبارٌ مقيَّم يُقرَّب إلى صفر كمية لا يحمل قيمة: كمية مقيَّمة صفرية بقيمة ≠ 0 تكسر «الكمية صفر ⇒ القيمة صفر»
  const cv = cq === 0 ? 0n : m === qo ? go : mulDivRound(go, m, qo, u);
  return { cq, cv, uq: m - cq };
}

function isTransferKind(k: MoveKind): boolean {
  return TRANSFER_KINDS.includes(k);
}

function isMemoKind(k: MoveKind): boolean {
  return MEMO_KINDS.includes(k);
}

/**
 * مفتاح صلةٍ نصّي من خصائص كائن الصلات **نفسه** (لا الموروثة من النموذج الأولي): دفاعٌ عن كائنٍ يبنيه مستهلكٌ بلا خاصية
 * الصلة. لا يُقبل إلا نصٌّ غير فارغ؛ وغيره ⇒ null (بلا صلة).
 */
function linkKey(links: MoveLinks | null, field: keyof MoveLinks): string | null {
  if (!links || !Object.prototype.hasOwnProperty.call(links, field)) return null;
  const v: unknown = links[field];
  return typeof v === 'string' && v !== '' ? v : null;
}

function isEmptyLoc(s: LocState): boolean {
  return s.costedQtyU === 0 && s.uncostedQtyU === 0 && s.valueMilli === 0n && s.lastAvg === null;
}

/**
 * لقطةٌ أدخلت بضاعة بند المرتجع للمخزون: RET عائد، أو تبديل إلى «يعود». **الأثر المجمَّد هو الحَكَم** لا حالة البند الآن:
 * returnExpired يُختم بعد الإصدار وخارج معاملته (وقد يتأخّر حتى إعادة رفع الجهاز)، فمرتجعٌ طُوي عائداً قد يصير «منتهياً»
 * بعدها — وقراءة الحالة الحالية عند إلغائه أو تبديله تترك بضاعة وهمية في الموقع إلى الأبد.
 */
function isRestockRef(r: SnapshotRef): boolean {
  return (r.kind === 'VAN_RETURN_RESTOCK' || r.kind === 'WAREHOUSE_RETURN_RESTOCK' || r.kind === 'RESTOCK_TOGGLE') && toQtyU(r.baseQty) > 0;
}

// ═══ الخطوة (§4.6) ═══

/**
 * يطوي حركة واحدة على الحالة (يعدّلها) ويُرجع لقطتها.
 * - valueMilli = Δ قيمة location دائماً (للتحويل Δ المصدر = −G)، وvarianceMilli = G − Δ للدخول (و G − Δ_الهدف للتحويل)، و0 للخروج.
 * - الصلات (mirrorOf/locationOf/memoOf) تُحلّ من lookup؛ غيابها ⇒ البديل وتحذير، لا رمي.
 * - يرمي فقط لخطأ برمجي (تحويل بلا هدف، نوع مجهول، كمية غير منتهية) — فشل مغلق بلا رقم كاذب.
 */
export function applyMove(state: CostState, move: Move, cfg: StepperConfig, lookup: SnapshotLookup): StepOutput {
  const u = unitMilli(cfg.currencyDecimals);
  const kind = move.kind;
  const pid = move.productId;
  const links = move.links ?? null;
  const mirrorOfKey = linkKey(links, 'mirrorOf');
  const locationOfKey = linkKey(links, 'locationOf');
  const memoOfKey = linkKey(links, 'memoOf');
  const warn = new Set<StepWarningCode>();
  const transfer = isTransferKind(kind);

  const resolve = (key: string | null): SnapshotRef | undefined => (key ? lookup.get(key) : undefined);
  const locOf = (loc: LocationKey): LocState | undefined => state.locs.get(locStateKey(pid, loc));
  const ensure = (loc: LocationKey): LocState => {
    const k = locStateKey(pid, loc);
    let s = state.locs.get(k);
    if (!s) {
      s = { costedQtyU: 0, uncostedQtyU: 0, valueMilli: 0n, lastAvg: null };
      state.locs.set(k, s);
    }
    return s;
  };

  // الموقع: لقطة locationOf تغلب الممرَّر — الإلغاء يعود لموقع البيع، وإلغاء المرتجع والتبديل لموقع المرتجع الفعلي
  let location: LocationKey = move.location;
  const locRef = resolve(locationOfKey);
  if (locationOfKey) {
    if (locRef) location = locRef.location;
    else warn.add('LINK_NOT_FOUND');
  }
  const toLocation: LocationKey | null = transfer ? (move.toLocation ?? null) : null;
  if (transfer && !toLocation) throw new Error(`COSTING_TRANSFER_WITHOUT_TARGET: ${move.key}`);

  // المذكِّرات بلا كمية على الموقع أياً كان الممرَّر
  const q = isMemoKind(kind) ? 0 : toQtyU(move.baseQty);

  let qU = 0;
  let valueMilli = 0n;
  let varianceMilli = 0n;
  let memoMilli = 0n;
  let movedUncostedU = 0;
  let gross = 0n;
  let costedQ = 0;
  let decreased = false;

  /** بديل مكشوف السيارة: متوسّط مستودع الصنف الآن (D5)؛ المستودع بلا بديل */
  const fallbackFor = (loc: LocationKey) => (): Avg | null => (isVanLocation(loc) ? avgOf(locOf(WH_LOCATION)) : null);

  const takeFrom = (loc: LocationKey, amt: number): OutResult => {
    const t = takeOut(ensure(loc), amt, fallbackFor(loc), u);
    if (t.fallbackUsed) warn.add('WH_RATE_FALLBACK');
    if (t.zeroRate) warn.add('ZERO_RATE_DEFICIT');
    if (t.outUq > 0) warn.add('UNCOSTED_OUT');
    return t;
  };
  const outMove = (amt: number): OutResult => {
    const t = takeFrom(location, amt);
    qU = 0 - amt;
    valueMilli = -t.outV;
    movedUncostedU = t.outUq;
    gross = t.outV;
    costedQ = t.outCq;
    decreased = true;
    return t;
  };
  const inMove = (p: InParts): void => {
    const d = absorbIn(ensure(location), p.cq, p.cv, p.uq, u);
    qU = p.cq + p.uq;
    valueMilli = d;
    varianceMilli = p.cv - d;
    movedUncostedU = p.uq;
    gross = p.cv;
    costedQ = p.cq;
    if (varianceMilli !== 0n) warn.add('HOLE_FILLED');
  };
  const atLocAvg = (amt: number): InParts => atAvgParts(amt, avgOf(locOf(location)), u);
  /**
   * قيمة بضاعة مرتجعة: مرآة بند البيع الأصلي، وإلا متوسّط موقع المرتجع، ولسيارة بلا متوسّط متوسّط المستودع
   * (البديل نفسه للعائد وللمشطوب وللتبديل إلى «يعود»، فلا يختلف تقييم البضاعة المرتجعة نفسها باختلاف حالتها).
   */
  const returnParts = (amt: number): InParts => {
    const ref = resolve(mirrorOfKey);
    const p = ref ? mirrorParts(ref, amt, u) : null;
    if (p) return p;
    warn.add(mirrorOfKey ? 'LINK_NOT_FOUND' : 'RETURN_UNLINKED');
    let avg = avgOf(locOf(location));
    if (!avg && isVanLocation(location)) {
      avg = avgOf(locOf(WH_LOCATION));
      if (avg) warn.add('WH_RATE_FALLBACK');
    }
    return atAvgParts(amt, avg, u);
  };
  /**
   * آخر أثرٍ مجمَّد لبند المرتجع قبل هذه الحركة (memoOf: RET أو آخر تبديلٍ اشتقّه المصدر للبند) — للإلغاء والتبديل.
   * تبديلٌ بلا أثر (وافق ما كان عليه البند) لقطته صفرية لا تحمل حالة؛ ولا يقع إلا أولَ تبديلٍ للبند (بعده تتّفق السلسلة
   * المجمَّدة واتجاه المصدر — streams.ts)، فسابقه RET نفسه (locationOf). غائب ⇒ LINK_NOT_FOUND وnull (تخمين المصدر).
   */
  const priorEffect = (): SnapshotRef | null => {
    const r = resolve(memoOfKey);
    if (!r) {
      warn.add('LINK_NOT_FOUND');
      return null;
    }
    if (r.kind === 'RESTOCK_TOGGLE' && toQtyU(r.baseQty) === 0) return locRef ?? null;
    return r;
  };

  switch (kind) {
    case 'VAN_LOAD':
    case 'VAN_UNLOAD': {
      const amt = Math.abs(q);
      if (amt > 0) {
        // الخروج من المصدر بمتوسّطه أولاً (والبديل يُقرأ قبل أي دخل)، ثم يدخل الهدفَ بالأجزاء نفسها
        const t = takeFrom(location, amt);
        const d = absorbIn(ensure(toLocation as LocationKey), t.outCq, t.outV, t.outUq, u);
        qU = 0 - amt;
        valueMilli = -t.outV;
        varianceMilli = t.outV - d;
        movedUncostedU = t.outUq;
        gross = t.outV;
        costedQ = t.outCq;
        decreased = true;
        if (varianceMilli !== 0n) warn.add('HOLE_FILLED');
      }
      break;
    }
    case 'DAMAGE_OUT':
      // قيمته شُطبت يوم المرتجع (OD15) — مذكِّرة بلا كمية ولا قيمة
      break;
    case 'RETURN_WRITE_OFF': {
      const m = Math.abs(toQtyU(move.memoQty ?? 0));
      if (m > 0) {
        const p = returnParts(m);
        memoMilli = p.cv;
        gross = p.cv;
        costedQ = p.cq;
      }
      break;
    }
    case 'RETURN_CANCEL': {
      // الإلغاء للبند كله دائماً ويعكس **أثره المجمَّد** (memoOf = آخر أثرٍ للبند): دخلٌ ⇒ خروج كميته المجمَّدة بالمتوسّط الحالي
      // من موقع RET (D4)؛ شطبٌ ⇒ عكس مذكِّرته كاملةً. فمرتجعٌ طُوي عائداً ثم خُتم «منتهياً» يخرج عند إلغائه (المصدر يخمّنه
      // مشطوباً). بلا memoOf (شكلٌ قديم) أو بمرجعٍ غائب ⇒ تخمين المصدر: الكمية السالبة خروج، والصفر عكس مذكِّرة لا مرجع لها.
      const prior = memoOfKey ? priorEffect() : null;
      if (prior) {
        if (isRestockRef(prior)) outMove(Math.abs(toQtyU(prior.baseQty)));
        else memoMilli = -prior.memoMilli;
      } else if (q < 0) outMove(0 - q);
      else if (q > 0) inMove(atLocAvg(q));
      else warn.add('LINK_NOT_FOUND');
      break;
    }
    case 'RESTOCK_TOGGLE': {
      // الاتجاه من المصدر، والأثر بالسلسلة المجمَّدة (memoOf = الأثر السابق للبند): تبديلٌ يوافق ما البند عليه (إلى «يعود»
      // وهو عائد، أو إلى «لا يعود» وهو مشطوب — كمكتوبٍ عليه يوم إصداره) لا أثر له، فلا تدخل البضاعة مرتين ولا تخرج من
      // موقعٍ لم تدخله. بلا memoOf (شكلٌ قديم) أو بمرجعٍ غائب ⇒ الاتجاه كما هو.
      const prior = memoOfKey ? priorEffect() : null;
      const inStock = prior ? isRestockRef(prior) : null;
      if (q > 0 && inStock !== true) {
        // إلى «يعود»: دخلٌ بمرآة البيع، ومذكِّرة سالبة تعكس الشطب (D4)
        inMove(returnParts(q));
        memoMilli = -gross;
      } else if (q < 0 && inStock !== false) {
        // إلى «لا يعود»: خروجٌ بالمتوسّط الحالي، والمذكِّرة تتبعه (D4)
        const t = outMove(0 - q);
        memoMilli = t.outV;
      }
      break;
    }
    case 'SALE_CANCEL': {
      if (q > 0) {
        const ref = resolve(mirrorOfKey);
        const p = ref ? mirrorParts(ref, q, u) : null;
        if (p) inMove(p);
        else {
          warn.add('LINK_NOT_FOUND');
          inMove(atLocAvg(q));
        }
      } else if (q < 0) outMove(0 - q);
      break;
    }
    case 'VAN_RETURN_RESTOCK':
    case 'WAREHOUSE_RETURN_RESTOCK': {
      if (q > 0) inMove(returnParts(q));
      else if (q < 0) outMove(0 - q);
      break;
    }
    case 'RECEIVE': {
      if (q > 0) {
        const v = move.inValueMilli == null ? 0n : roundMilli(move.inValueMilli, cfg.currencyDecimals);
        inMove(v > 0n ? { cq: q, cv: v, uq: 0 } : { cq: 0, cv: 0n, uq: q });
      } else if (q < 0) outMove(0 - q);
      break;
    }
    case 'ZERO_RUN': {
      // «تصفير المخزون» هدفٌ مطلق لا فرق: معناه «الرصيد صفر» (stockZero.ts)، وسطره = −رصيد الشاشة القديمة لحظتها، وتلك
      // لا ترى ما يخصمه المحرّك وحده (فاتورة الإدارة من المستودع — OD8). تطبيقه فرقاً يترك الموقع سالباً بنقص تلك الفواتير
      // ويحمّل المصروف مرتين (خسارة تسوية بكامل السطر ثم سدّ الحفرة إلى تكلفة المبيعات). فيُستنزف (الصنف، الموقع) كله بمتوسّطه،
      // أو تُسدّ حفرته بلا ثمن (كتسويةٍ موجبة — ADD_AT_AVG، والفرق إلى تكلفة المبيعات). كمية السطر لا تُقرأ: فرقها عن الحالة
      // = baseQty اللقطة مقابل سطر المصدر. (الدلو السالب لا يجتمع مع رصيدٍ خارج التقييم: absorbIn يسدّ الحفرة أولاً.)
      const s = locOf(location);
      const have = s ? s.costedQtyU + s.uncostedQtyU : 0;
      if (have > 0) outMove(have);
      else if (have < 0) inMove(atLocAvg(0 - have));
      break;
    }
    case 'VENDOR_RETURN':
    case 'WH_ADJUST':
    case 'VAN_ADJUST':
    case 'VAN_SALE':
    case 'WAREHOUSE_SALE': {
      if (q < 0) outMove(0 - q);
      else if (q > 0) inMove(atLocAvg(q));
      break;
    }
    default: {
      const never: never = kind;
      throw new Error(`COSTING_UNKNOWN_KIND: ${String(never)}`);
    }
  }

  // التاريخ المحاسبي: الإلغاء والتبديل لا يسبقان أصلهما (لا عكسٌ قبل ما يعكسه)
  let effectAt = move.effectAt;
  const notBefore = (r: SnapshotRef | undefined): void => {
    if (r && r.effectAt.getTime() > effectAt.getTime()) effectAt = r.effectAt;
  };
  if (kind === 'SALE_CANCEL') {
    notBefore(resolve(mirrorOfKey));
    notBefore(locRef);
  } else if (kind === 'RETURN_CANCEL') {
    notBefore(locRef);
    notBefore(resolve(memoOfKey));
  } else if (kind === 'RESTOCK_TOGGLE') {
    notBefore(locRef);
  }

  const after = locOf(location);
  const qtyAfterU = after ? after.costedQtyU + after.uncostedQtyU : 0;
  if (decreased && qtyAfterU < 0) warn.add('NEGATIVE_STOCK');
  const toAfter = toLocation ? locOf(toLocation) : undefined;

  const out: StepOutput = {
    key: move.key,
    kind,
    productId: pid,
    location,
    toLocation,
    baseQty: fromQtyU(qU),
    uncostedQty: fromQtyU(movedUncostedU),
    valueMilli,
    varianceMilli,
    memoMilli,
    effectAt: new Date(effectAt.getTime()),
    refType: move.refType,
    refId: move.refId,
    itemId: move.itemId,
    srcCreatedAt: new Date(move.cursor.createdAt.getTime()),
    srcId: move.cursor.id,
    reason: move.reason ?? null,
    lateArrival: move.lateArrival === true,
    unitCostE4: unitCostE4Of(gross, costedQ),
    qtyAfter: fromQtyU(qtyAfterU),
    valueAfter: after ? after.valueMilli : 0n,
    toQtyAfter: toLocation ? fromQtyU(toAfter ? toAfter.costedQtyU + toAfter.uncostedQtyU : 0) : null,
    toValueAfter: toLocation ? (toAfter ? toAfter.valueMilli : 0n) : null,
    warnings: STEP_WARNINGS.filter((w) => warn.has(w)),
  };

  // حالة قانونية: (صنف، موقع) صفريٌّ بالكامل بلا آخر متوسّط لا يبقى — فالإعادة الكاملة = الاستئناف من نقطة حفظ
  // (نقاط الحفظ لا تكتب الصفري) حرفياً
  for (const loc of toLocation ? [location, toLocation] : [location]) {
    const k = locStateKey(pid, loc);
    const s = state.locs.get(k);
    if (s && isEmptyLoc(s)) state.locs.delete(k);
  }
  state.movesFolded += 1;
  if (!state.cursor || compareCursors(move.cursor, state.cursor) > 0) {
    state.cursor = { createdAt: new Date(move.cursor.createdAt.getTime()), id: move.cursor.id };
  }
  return out;
}

// ═══ الإعادة ═══

/** بحثٌ في لقطات معطاة (نواتج سابقة أو صفوف gl_cost_snapshots محوَّلة) */
export function snapshotLookupOf(refs: Iterable<SnapshotRef>): SnapshotLookup {
  const m = new Map<string, SnapshotRef>();
  for (const r of refs) m.set(r.key, r);
  return { get: (k) => m.get(k) };
}

/**
 * يرتّب نسخة من الحركات بـcompareMoves ثم يطويها على نسخة من حالة البدء (لا يعدّل المدخلات).
 * نواتج الدفعة نفسها تُحلّ صلاتها قبل opts.lookup. مفتاحٌ مكرَّر في الدفعة خطأ مصدر ⇒ يرمي (لا يُطوى مرتين).
 * captureAt: لكل لحظة T نسخة من الحالة بعد كل حركة cursor.createdAt < T.
 */
export function replay(moves: readonly Move[], cfg: StepperConfig, opts: ReplayOptions = {}): ReplayResult {
  unitMilli(cfg.currencyDecimals);
  const state = opts.state ? cloneCostState(opts.state) : createCostState();
  const sorted = moves.slice().sort(compareMoves);
  const local = new Map<string, SnapshotRef>();
  const base = opts.lookup;
  const lookup: SnapshotLookup = { get: (k) => local.get(k) ?? base?.get(k) };

  const caps = (opts.captureAt ?? []).map((d, i) => ({ t: d.getTime(), i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const captured: CostState[] = new Array<CostState>(caps.length);
  let ci = 0;

  const outputs: StepOutput[] = [];
  for (const m of sorted) {
    const t = m.cursor.createdAt.getTime();
    while (ci < caps.length && caps[ci].t <= t) captured[caps[ci++].i] = cloneCostState(state);
    if (local.has(m.key)) throw new Error(`COSTING_DUPLICATE_MOVE_KEY: ${m.key}`);
    const o = applyMove(state, m, cfg, lookup);
    local.set(o.key, o);
    outputs.push(o);
    opts.onOutput?.(o);
  }
  while (ci < caps.length) captured[caps[ci++].i] = cloneCostState(state);
  return { state, outputs, captured };
}

// ═══ الملخّصات ═══

/**
 * مجاميع كل موقع (Σ الأصناف): الكمية والخارج عن التقييم والقيمة — مرتّبة المستودع أولاً ثم السيارات بمعرّفها،
 * ويُسقط الموقع الصفريّ تماماً (لا يختلف الناتج بين إعادةٍ كاملة واستئنافٍ من نقطة حفظ).
 */
export function stateTotals(state: CostState): LocationTotals[] {
  const by = new Map<LocationKey, { q: number; uq: number; v: Milli }>();
  for (const [k, s] of state.locs) {
    const { location } = splitLocStateKey(k);
    const t = by.get(location) ?? { q: 0, uq: 0, v: 0n };
    t.q += s.costedQtyU + s.uncostedQtyU;
    t.uq += s.uncostedQtyU;
    t.v += s.valueMilli;
    by.set(location, t);
  }
  const out: LocationTotals[] = [];
  for (const [location, t] of by) {
    if (!Number.isSafeInteger(t.q) || !Number.isSafeInteger(t.uq)) throw new RangeError('مجموع كميات الموقع خارج المدى الآمن');
    if (t.q === 0 && t.uq === 0 && t.v === 0n) continue;
    out.push({ location, qtyBase: fromQtyU(t.q), uncostedQty: fromQtyU(t.uq), valueMilli: t.v });
  }
  return out.sort((a, b) => compareLocations(a.location, b.location));
}

/** ما يلزم لحلّ الصلات من لقطة (بلا حقول الذاكرة) */
export function snapshotRefOf(o: StepOutput): SnapshotRef {
  return {
    key: o.key,
    kind: o.kind,
    productId: o.productId,
    location: o.location,
    toLocation: o.toLocation,
    baseQty: o.baseQty,
    uncostedQty: o.uncostedQty,
    valueMilli: o.valueMilli,
    varianceMilli: o.varianceMilli,
    memoMilli: o.memoMilli,
    effectAt: o.effectAt,
  };
}
