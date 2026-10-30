// «تتبّع اللوط» (P0) — J1: خاصية نموذجية (المواصفة §٣.٢، §٨.١ lots-model).
//
// ألف تسلسل عشوائي من: وارد، وتسوية ±، وتحميل (بالمستودع وبدونه D4/D28)، وتنزيل، وتسوية السيارة ±، وإزالة المنتهي والتالف،
// وبيع (حيّاً وإعادةً بتلميح)، ومرتجع مرتبط وحرّ، وإلغاء، وإعادة للمخزون (والمرحلة الثانية)، وتسمية، وإيقاف، وتغيّر مرآة،
// وإبطال محجوز (ومنه ما كُتب قبل الحقبة)، وإطفاء الصنف والشركة وإعادة تفعيلهما (الحقبة)، وتبديل المستودع، وحذف مندوب
// وتنزيل سيارته (D30)، وكمياتٍ بخمس خانات تُرفض (isLotQty)، ومرور الأيام — فوق تاريخٍ سابق للتفعيل فيه بيعٌ بلا مخزون
// (سالب تاريخي) ومرتجعاتٌ قياسية محجوزة.
//
// «التنفيذ» هنا: صفوفٌ كما تكتبها المسارات، يُختار توزيعها بدوال الخطة الصرفة (allocateOut، allocateOutLines لكل سطرٍ
// بمعامل وحدته، pickOutSources، allocateReturnFromSale، lotRemovalsOf/removalKeepsLots)، وتُقرأ بمحاكاة تجميعات SQL (الحقبة والتوجيه
// والحجز) ثم assemblePlaceViews نفسها التي يركّب بها placeViews العروض، ورصيد الصنف والمحجوز الكلي من foldStock وcomposeWarehouse.
// «النموذج المرجعي»: دفترٌ مستقل يحدّث (صنف، مكان، لوط أو فارغ، دلو) بدلالة كل عملية مباشرةً.
// بعد كل خطوة: الطيّ = النموذج، ورصيد الصنف والمحجوز الكلي = النموذج = foldStock/composeWarehouse (ومجاميعهما)، ولا صالح
// مسمّى سالب (I1)، وغير المسمّى لا ينقص دون min(0, قبله) (I2)، وΣ صفوف كل بند = كميته (I3)، والبيع الحيّ من مؤهَّل أو غير مسمّى (I4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldStock, bucketRemaining, type LoadRow, type InvRow } from '../routes/vanStock';
import { composeWarehouse } from '../services/warehouseStock';
import { DAMAGED_VAN_SINCE } from '../services/vanDamaged';
import { baseQtyOf } from '../services/units';
import {
  LOT_BUCKETS, LOT_EPS, LOT_HOLD_MIRRORS, allocateOut, allocateOutLines, allocateReturnFromSale, distributeToLines, isLotExpiredOn, isLotQty,
  lotBaseQty, lotRemovalsOf, pickOutSources, removalKeepsLots, roundLot, stampFromRows, zeroBuckets,
  type AggInvLot, type AggRelabel, type AggVanLot, type AggWhLot, type AllocResult, type AllocRow, type BucketQty, type LotBucket,
  type LotMeta, type LotRef, type LotRemovalItem, type OutLine, type PlaceLotView, type SaleLotRow,
} from '../services/lots';
import {
  assemblePlaceViews, vanHeldFromAgg, vanTotalsFromAgg, warehouseOnHandAgg, type AggVanTotalInv, type AggVanTotalLoad, type WhTotalAgg,
} from '../services/lotsDb';

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    bool: (p = 0.5) => next() < p,
    /** كمية بنصف وحدة أو بثلاث خانات — مجاميعها دقيقة فيقارَن التقريب بلا حدود */
    qty: (max = 12) => (next() < 0.7 ? Math.max(0.5, Math.round(next() * max * 2) / 2) : Math.max(0.001, Math.round(next() * max * 1000) / 1000)),
    /** كمية بخمس خانات (أدقّ من الطيّ) — تُرفض لصنفٍ متتبَّع (isLotQty) */
    fine: (max = 12) => Math.floor(next() * max * 1e4) / 1e4 + 0.00005,
  };
}
type Rng = ReturnType<typeof rng>;

const PIDS = ['P1', 'P2'] as const;
const VANS = ['R1', 'R2'] as const;
const WH = 'WH';
const BASE_MS = DAMAGED_VAN_SINCE.getTime() + 86_400_000; // كل الفواتير بعد بدء «المرتجع التالف»
const DAY0 = Date.UTC(2026, 10, 1);
const dayStr = (d: number) => new Date(DAY0 + d * 86_400_000).toISOString().slice(0, 10);
const NOT_HELD_MIRROR = 'cleared';

interface LotRowW { id: string; lotId: string | null; qty: number; certainty: string; viaWarehouse: boolean; createdAt: number; expiryDate: string | null; sourceItemLotId: string | null }
interface WhRow { productId: string; type: 'RECEIVE' | 'ADJUST'; qty: number; lotId: string | null; createdAt: number }
interface VanItem { productId: string; vanKey: string; type: string; qty: number; createdAt: number; lots: LotRowW[] | null }
interface InvItem { id: string; productId: string; qty: number; returnExpired: boolean | null; lots: LotRowW[] | null; returnOfItemId: string | null }
interface Inv {
  id: string; type: 'CASH' | 'RETURN'; vanKey: string; status: 'CONFIRMED' | 'CANCELLED'; returnToStock: boolean; returnReason: string | null;
  phase2: boolean; mirror: string | null; createdAt: number; items: InvItem[];
}
interface RelRow { productId: string; place: 'WAREHOUSE' | 'VAN'; vanKey: string | null; bucket: LotBucket; fromLotId: string | null; toLotId: string | null; qty: number; createdAt: number }

const isHeld = (i: Inv) => i.type === 'RETURN' && i.phase2 && (i.mirror == null || (LOT_HOLD_MIRRORS as readonly string[]).includes(i.mirror));

/**
 * الوحدات المتعددة (D19، D22): كميات النموذج وصفوف اللوط بالأساس، وصفّ البند يُكتب كما تكتبه المسارات — بوحدة السطر ومعاملها
 * (١ أو ٦ أو ٢٤، ثابتٌ لكل بند)، والعمود المخزَّن حاضرٌ أو فارغٌ لم يملأه الترحيل. فرصيد الصنف يُقرأ بالأساس: foldStock
 * وcomposeWarehouse بـbaseQtyOf، والمجاميع بمرآة BASE_QTY_SQL، وI3 بـlotBaseQty.
 */
const UNIT_FACTORS = [1, 6, 24] as const;
function unitRow(base: number, key: string | number): { qty: number; unitFactor: number; baseQty: number | null } {
  const h = typeof key === 'number' ? key : [...key].reduce((s, c) => s + c.charCodeAt(0), 0);
  const unitFactor = UNIT_FACTORS[h % UNIT_FACTORS.length];
  return { qty: base / unitFactor, unitFactor, baseQty: h % 2 ? null : base };
}
/** مرآة BASE_QTY_SQL: COALESCE("baseQty", qty * COALESCE(NULLIF("unitFactor", 0), 1)) — بلا تقريبٍ لكل صفّ كـSUM */
const sqlBase = (x: { qty: number; unitFactor: number; baseQty: number | null }): number => x.baseQty ?? x.qty * (x.unitFactor === 0 ? 1 : x.unitFactor);

/** الدلو الذي يوجّهه المستند — دلالة العملية مكتوبةً مباشرةً (البيع يُنقص المتاح؛ المرتجع المنتهي ثم التالف ثم العائد) */
function bucketOf(inv: Inv, item: InvItem): { bucket: LotBucket; sign: 1 | -1 } | null {
  if (inv.type === 'CASH') return { bucket: 'SELLABLE', sign: -1 };
  if (item.returnExpired) return { bucket: 'EXPIRED', sign: 1 };
  if (inv.returnReason === 'DAMAGED') return { bucket: 'DAMAGED', sign: 1 };
  if (inv.returnToStock) return { bucket: 'SELLABLE', sign: 1 };
  return null;
}

class Sim {
  t = 0; d = 0; seq = 0;
  tenantOn = false; tenantSince: number | null = null;
  warehouseOn = true;
  deleted = new Set<string>();
  productTracked = new Map<string, boolean>(PIDS.map((p) => [p, false]));
  productSince = new Map<string, number | null>(PIDS.map((p) => [p, null]));
  metas = new Map<string, LotMeta>();
  wh: WhRow[] = []; vanItems: VanItem[] = []; invoices: Inv[] = []; relabels: RelRow[] = [];
  // النموذج المرجعي: المسمّى ومحجوزه، وغير المسمّى ومحجوزه، ورصيد الصنف، والمحجوز الكلي (كل التاريخ)
  named = new Map<string, number>(); heldN = new Map<string, number>();
  unk = new Map<string, number>(); heldU = new Map<string, number>();
  total = new Map<string, number>(); heldT = new Map<string, number>();

  now() { return BASE_MS + this.t; }
  day() { return dayStr(this.d); }
  tracked(pid: string) { return this.tenantOn && this.productTracked.get(pid) === true; }
  since(pid: string): number {
    const a = this.tenantSince ?? -Infinity, b = this.productSince.get(pid) ?? -Infinity;
    return Math.max(a, b);
  }
  counted(pid: string, at: number) { return at >= this.since(pid); }
  id(p: string) { return `${p}${++this.seq}`; }
  liveVans() { return VANS.filter((v) => !this.deleted.has(v)); }

  // ── النموذج ──
  static k(...xs: (string | null)[]) { return xs.map((x) => x ?? '∅').join('|'); }
  add(m: Map<string, number>, k: string, q: number) { m.set(k, (m.get(k) ?? 0) + q); }
  /**
   * أثرٌ على (صنف، مكان، دلو): الصفّ المحسوب في الحقبة يذهب إلى لوطه، وإلا إلى غير المسمّى. المحجوز يدخل المحجوز الكلي دائماً،
   * ومحجوز لوطه إن حُسب صفّه، وإلا محجوز غير المسمّى (D24: المرتجع المحجوز قبل الحقبة أو بلا صفوف محجوزٌ في غير المسمّى)
   */
  apply(pid: string, place: string, b: LotBucket, lotId: string | null, q: number, counted: boolean, held: boolean) {
    this.add(this.total, Sim.k(pid, place, b), q);
    if (held) this.add(this.heldT, Sim.k(pid, place, b), q);
    if (counted && lotId != null) {
      this.add(this.named, Sim.k(pid, place, lotId, b), q);
      if (held) this.add(this.heldN, Sim.k(pid, place, lotId, b), q);
    } else {
      this.add(this.unk, Sim.k(pid, place, b), q);
      if (held) this.add(this.heldU, Sim.k(pid, place, b), q);
    }
  }
  /** فكّ الحجز (المرآة صارت معتمدة): الخام باقٍ والمحجوز ينقص */
  unhold(pid: string, place: string, b: LotBucket, lotId: string | null, q: number, counted: boolean) {
    this.add(this.heldT, Sim.k(pid, place, b), -q);
    if (counted && lotId != null) this.add(this.heldN, Sim.k(pid, place, lotId, b), -q);
    else this.add(this.heldU, Sim.k(pid, place, b), -q);
  }
  /** بداية حقبة: المسمّى يُصفَّر ويصير الرصيد كله غير مسمّى، ومحجوزه المحجوز الكلي (D8، D9، D25) */
  resetEpoch(pid: string) {
    for (const m of [this.named, this.heldN, this.heldU]) for (const k of [...m.keys()]) if (k.startsWith(`${pid}|`)) m.delete(k);
    for (const [k, v] of this.total) if (k.startsWith(`${pid}|`)) this.unk.set(k, v);
    for (const [k, v] of this.heldT) if (k.startsWith(`${pid}|`)) this.heldU.set(k, v);
  }

  newLot(pid: string, r: Rng): LotMeta {
    const id = this.id('L');
    const m: LotMeta = {
      id, productId: pid, lotNumber: `N${id}`, productionDate: null,
      expiryDate: r.bool(0.1) ? null : dayStr(this.d + r.int(-4, 18)),
      status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date(this.now()),
    };
    this.metas.set(id, m);
    return m;
  }
  lotsOf(pid: string) { return [...this.metas.values()].filter((m) => m.productId === pid); }

  // ── «التنفيذ»: محاكاة تجميعات SQL ثم assemblePlaceViews ──
  aggregates() {
    const van: AggVanLot[] = [], inv: AggInvLot[] = [], rel: AggRelabel[] = [], wh: AggWhLot[] = [];
    for (const w of this.wh) if (w.lotId && this.counted(w.productId, w.createdAt)) wh.push({ productId: w.productId, lotId: w.lotId, qty: w.qty });
    for (const it of this.vanItems) {
      for (const l of it.lots ?? []) {
        if (!this.counted(it.productId, l.createdAt)) continue;
        van.push({ productId: it.productId, lotId: l.lotId, vanKey: it.vanKey, moveType: it.type as AggVanLot['moveType'], viaWarehouse: l.viaWarehouse, qty: l.qty, firstInAt: l.qty > 0 ? new Date(l.createdAt) : null });
      }
    }
    for (const i of this.invoices) {
      if (i.status !== 'CONFIRMED') continue;
      for (const item of i.items) {
        for (const l of item.lots ?? []) {
          if (!this.counted(item.productId, l.createdAt)) continue;
          inv.push({
            productId: item.productId, lotId: l.lotId, vanKey: i.vanKey,
            route: { type: i.type, returnToStock: i.returnToStock, returnExpired: item.returnExpired, damaged: i.returnReason === 'DAMAGED' },
            held: isHeld(i), qty: l.qty, firstAt: new Date(l.createdAt),
          });
        }
      }
    }
    for (const x of this.relabels) if (this.counted(x.productId, x.createdAt)) rel.push({ productId: x.productId, place: x.place, vanKey: x.vanKey, bucket: x.bucket, fromLotId: x.fromLotId, toLotId: x.toLotId, qty: x.qty, firstAt: new Date(x.createdAt) });
    return { van, inv, rel, wh };
  }
  /** صفوف البنود كما تكتبها المسارات بلقطة وحدتها (unitRow) — foldStock يطويها بالأساس (baseQtyOf) */
  loadRows(vanKey: string): LoadRow[] {
    return this.vanItems.map((v, i) => ({ v, i })).filter(({ v }) => v.vanKey === vanKey)
      .map(({ v, i }) => ({ productId: v.productId, ...unitRow(v.qty, i), vanLoad: { type: v.type, createdAt: new Date(v.createdAt) } }));
  }
  invRows(vanKey: string, heldOnly = false): InvRow[] {
    return this.invoices.filter((i) => i.vanKey === vanKey && i.status === 'CONFIRMED' && (!heldOnly || isHeld(i))).flatMap((i) => i.items.map((it) => ({
      productId: it.productId, ...unitRow(it.qty, it.id), returnExpired: it.returnExpired,
      invoice: { type: i.type, returnToStock: i.returnToStock, invoiceDate: new Date(i.createdAt), returnReason: i.returnReason, createdAt: new Date(i.createdAt) },
    })));
  }
  /** رصيد الصنف (أو المحجوز الكلي) بـfoldStock على الصفوف المفردة — كما يقرؤه computeStock */
  vanTotals(vanKey: string, heldOnly = false): Map<string, BucketQty> {
    const { bal } = foldStock(heldOnly ? [] : this.loadRows(vanKey), this.invRows(vanKey, heldOnly));
    const out = new Map<string, BucketQty>();
    for (const [pid, b] of bal) out.set(pid, { SELLABLE: bucketRemaining(b), EXPIRED: roundLot(b.expiredIn - b.expiredOut), DAMAGED: roundLot(b.damagedIn - b.damagedOut) });
    return out;
  }
  whTotals(): Map<string, number> {
    // الأساس من حدّ القراءة كـloadWarehouseInputs: baseQtyOf على لقطة الصفّ، بلا المعامل بعده
    const rows = composeWarehouse(
      PIDS.map((id) => ({ id, name: id, code: id, unit: 'u' })),
      this.wh.map((w, i) => ({ productId: w.productId, qty: baseQtyOf(unitRow(w.qty, `W${i}`)), type: w.type })),
      this.vanItems.map((v, i) => ({ productId: v.productId, qty: baseQtyOf(unitRow(v.qty, i)), type: v.type, salesRepId: v.vanKey })),
    );
    return new Map(rows.map((r) => [r.productId, r.onHand]));
  }
  views(): Map<string, PlaceLotView> {
    const a = this.aggregates();
    const live = this.liveVans();
    const res = assemblePlaceViews({
      productIds: [...PIDS], vanKeys: [...VANS], warehouse: true, withTotals: true,
      vanLots: a.van, invLots: a.inv, whVanLots: a.van, whLots: a.wh, rels: a.rel,
      vanTotals: new Map(live.map((v) => [v, this.vanTotals(v)])), heldTotals: new Map(live.map((v) => [v, this.vanTotals(v, true)])),
      whTotals: this.whTotals(), metas: this.metas, deletedVans: this.deleted,
    });
    const out = new Map<string, PlaceLotView>();
    for (const pid of PIDS) {
      out.set(Sim.k(pid, WH), res.warehouse.get(pid)!);
      for (const van of VANS) out.set(Sim.k(pid, van), res.vans.get(van)!.get(pid)!);
    }
    return out;
  }
}

const EXPECTED_REFUSALS = new Set(['LOT_STOCK_INSUFFICIENT', 'LOT_REQUIRED', 'LOT_QTY_INVALID', 'LOT_BLOCKED', 'LOT_EXPIRED', 'LOT_REPLAY_HELD']);

function refused(r: AllocResult, where: string): boolean {
  if (r.ok) return false;
  assert.ok(EXPECTED_REFUSALS.has(r.error.code), `${where}: رفضٌ غير متوقَّع ${r.error.code}`);
  return true;
}

/** كميةٌ بخمس خانات يجب أن تُرفض بـLOT_QTY_INVALID في المسار الحيّ (isLotQty) */
function fineRefused(r: AllocResult, q: number, where: string): boolean {
  if (isLotQty(q)) return false;
  assert.ok(!r.ok && r.error.code === 'LOT_QTY_INVALID', `${where}: كمية بخمس خانات (${q}) لم تُرفض`);
  return true;
}
/** صنفٌ متتبَّع: كميةٌ حيّة قد تكون بخمس خانات (تُرفض) */
const liveQty = (r: Rng, max?: number) => (r.bool(0.08) ? r.fine(max) : r.qty(max));

/** صريحٌ عشوائي من الإدارة: غالباً تقسيمٌ صالح على المصادر، وأحياناً عبثٌ يجب أن يُرفض بلا أثر */
function randomExplicit(r: Rng, view: PlaceLotView, bucket: LotBucket, q: number, eligibleOnly: string | null): LotRef[] {
  const uu = view.unknownUsable?.[bucket] ?? 0;
  const srcs: { lotId: string | null; usable: number }[] = view.lots
    .filter((l) => l.usable[bucket] > LOT_EPS && (!eligibleOnly || (l.meta.status === 'ACTIVE' && !isLotExpiredOn(l.meta, eligibleOnly))))
    .map((l) => ({ lotId: l.lotId, usable: l.usable[bucket] }));
  if (uu > LOT_EPS) srcs.push({ lotId: null, usable: uu });
  if (r.bool(0.15) || !srcs.length) {
    const any = view.lots.length ? r.pick(view.lots).lotId : null;
    return [{ lotId: r.bool(0.3) ? null : any, qty: q }];
  }
  const out: LotRef[] = [];
  let left = q;
  for (const s of srcs.sort(() => r.next() - 0.5)) {
    if (left <= LOT_EPS) break;
    const t = Math.min(s.usable, left);
    out.push({ lotId: s.lotId, qty: t });
    left = t === left ? 0 : left - t;
  }
  return out;
}

const sumQty = (rows: { qty: number }[]) => rows.reduce((s, x) => s + x.qty, 0);
/** تغطية D22 في البيع: أسطرٌ بوحدةٍ أكبر من الأساس وزّعها الخادم (ومنها في بيعٍ بسطرين)، وما وُسم منها، وما شُقّ بأكثر من صفٍّ كسري */
const cartonStats = { lines: 0, multi: 0, split: 0, odd: 0 };
const assertI3 = (rows: { qty: number }[], q: number, where: string) => assert.ok(Math.abs(sumQty(rows) - q) <= 1e-9, `${where}: Σ الصفوف ≠ الكمية (I3)`);

type Op = (s: Sim, r: Rng, pid: string) => string | null;

const ops: Record<string, Op> = {
  RECEIVE(s, r, pid) {
    if (!s.warehouseOn) return null; // الوارد يتطلب المستودع (warehouse.ts)
    if (!s.tracked(pid)) { const q = r.qty(); s.wh.push({ productId: pid, type: 'RECEIVE', qty: q, lotId: null, createdAt: s.now() }); s.apply(pid, WH, 'SELLABLE', null, q, false, false); return 'RECEIVE~'; }
    const q = liveQty(r);
    if (!isLotQty(q)) return 'QTY/refused'; // B3 يرفض الزيادة بخمس خانات (isLotQty)
    const lots = s.lotsOf(pid);
    const lot = lots.length && r.bool(0.4) ? r.pick(lots) : s.newLot(pid, r);
    s.wh.push({ productId: pid, type: 'RECEIVE', qty: q, lotId: lot.id, createdAt: s.now() });
    s.apply(pid, WH, 'SELLABLE', lot.id, q, true, false);
    return 'RECEIVE';
  },
  WH_ADJ(s, r, pid) {
    if (!s.warehouseOn) return null;
    const v = s.views().get(Sim.k(pid, WH))!;
    if (r.bool(0.4)) {
      const q = s.tracked(pid) ? liveQty(r) : r.qty();
      if (s.tracked(pid) && !isLotQty(q)) return 'QTY/refused';
      const lots = s.lotsOf(pid);
      const lotId = !s.tracked(pid) || r.bool(0.3) ? null : (lots.length && r.bool(0.6) ? r.pick(lots).id : s.newLot(pid, r).id);
      s.wh.push({ productId: pid, type: 'ADJUST', qty: q, lotId, createdAt: s.now() });
      s.apply(pid, WH, 'SELLABLE', lotId, q, s.tracked(pid), false);
      return 'WH_ADJ+';
    }
    if (!s.tracked(pid)) { const q = r.qty(); s.wh.push({ productId: pid, type: 'ADJUST', qty: -q, lotId: null, createdAt: s.now() }); s.apply(pid, WH, 'SELLABLE', null, -q, false, false); return 'WH_ADJ-~'; }
    const q = liveQty(r);
    const res = pickOutSources(v, 'SELLABLE', q, r.bool(0.6) ? randomExplicit(r, v, 'SELLABLE', q, null) : null);
    if (fineRefused(res, q, 'WH_ADJ-')) return 'QTY/refused';
    if (refused(res, 'WH_ADJ-') || !res.ok) return null;
    assertI3(res.rows, q, 'WH_ADJ-');
    for (const row of res.rows) {
      s.wh.push({ productId: pid, type: 'ADJUST', qty: -row.qty, lotId: row.lotId, createdAt: s.now() });
      s.apply(pid, WH, 'SELLABLE', row.lotId, -row.qty, true, false);
    }
    return 'WH_ADJ-';
  },
  LOAD(s, r, pid) {
    const van = r.pick(s.liveVans());
    if (!s.tracked(pid)) {
      const q = r.qty();
      s.vanItems.push({ productId: pid, vanKey: van, type: 'LOAD', qty: q, createdAt: s.now(), lots: null });
      s.apply(pid, WH, 'SELLABLE', null, -q, false, false); s.apply(pid, van, 'SELLABLE', null, q, false, false);
      return 'LOAD~';
    }
    const q = liveQty(r);
    if (!s.warehouseOn) {
      // D4: شركة بلا مستودع — صفوفٌ صريحة من الإدارة (لوطٌ قائم مؤهَّل، أو جديد بمصدر LOAD، أو null)، viaWarehouse = false (D28)
      if (!isLotQty(q)) return 'QTY/refused';
      const pickLot = (): string | null => {
        if (r.bool(0.25)) return null;
        const ok = s.lotsOf(pid).filter((m) => m.status === 'ACTIVE' && !isLotExpiredOn(m, s.day()));
        return ok.length && r.bool(0.6) ? r.pick(ok).id : s.newLot(pid, r).id;
      };
      const q1 = r.bool(0.3) && q >= 1 ? roundLot(Math.floor(q * 0.5 * 1000) / 1000) : q;
      const rows = q1 < q ? [{ lotId: pickLot(), qty: q1 }, { lotId: pickLot(), qty: roundLot(q - q1) }] : [{ lotId: pickLot(), qty: q }];
      assertI3(rows, q, 'LOAD/direct');
      s.vanItems.push({ productId: pid, vanKey: van, type: 'LOAD', qty: q, createdAt: s.now(), lots: rows.map((x) => lotRow(s, { ...x, certainty: x.lotId ? 'CONFIRMED' : 'UNKNOWN', expiryDate: null }, false, 1)) });
      for (const row of rows) { s.apply(pid, WH, 'SELLABLE', null, -row.qty, false, false); s.apply(pid, van, 'SELLABLE', row.lotId, row.qty, true, false); }
      return 'LOAD/direct';
    }
    const v = s.views().get(Sim.k(pid, WH))!;
    const explicit = r.bool(0.3) ? randomExplicit(r, v, 'SELLABLE', q, s.day()) : null;
    const res = allocateOut({ productId: pid, productName: pid, qty: q, unitFactor: r.pick([1, 1, 6]), view: v, day: s.day(), mode: 'LOAD', allowUnknown: r.bool(0.7), explicit });
    if (fineRefused(res, q, 'LOAD')) return 'QTY/refused';
    if (refused(res, 'LOAD') || !res.ok) return null;
    assertI3(res.rows, q, 'LOAD');
    for (const row of res.rows) if (row.lotId) {
      const m = s.metas.get(row.lotId)!;
      assert.ok(m.status === 'ACTIVE' && !isLotExpiredOn(m, s.day()), 'I4: تحميلٌ من غير مؤهَّل');
    }
    s.vanItems.push({ productId: pid, vanKey: van, type: 'LOAD', qty: q, createdAt: s.now(), lots: res.rows.map((x) => lotRow(s, x, true, 1)) });
    for (const row of res.rows) { s.apply(pid, WH, 'SELLABLE', row.lotId, -row.qty, true, false); s.apply(pid, van, 'SELLABLE', row.lotId, row.qty, true, false); }
    return 'LOAD';
  },
  UNLOAD(s, r, pid) {
    const van = r.pick(s.liveVans());
    const via = s.warehouseOn; // D28: viaWarehouse = warehouseEnabled لحظة الكتابة
    if (!s.tracked(pid)) {
      const q = r.qty(6);
      s.vanItems.push({ productId: pid, vanKey: van, type: 'UNLOAD', qty: q, createdAt: s.now(), lots: null });
      s.apply(pid, van, 'SELLABLE', null, -q, false, false); s.apply(pid, WH, 'SELLABLE', null, q, false, false);
      return 'UNLOAD~';
    }
    const q = liveQty(r, 6);
    const v = s.views().get(Sim.k(pid, van))!;
    const res = pickOutSources(v, 'SELLABLE', q, r.bool(0.7) ? randomExplicit(r, v, 'SELLABLE', q, null) : null);
    if (fineRefused(res, q, 'UNLOAD')) return 'QTY/refused';
    if (refused(res, 'UNLOAD') || !res.ok) return null;
    assertI3(res.rows, q, 'UNLOAD');
    s.vanItems.push({ productId: pid, vanKey: van, type: 'UNLOAD', qty: q, createdAt: s.now(), lots: res.rows.map((x) => lotRow(s, x, via, 1)) });
    for (const row of res.rows) { s.apply(pid, van, 'SELLABLE', row.lotId, -row.qty, true, false); s.apply(pid, WH, 'SELLABLE', row.lotId, row.qty, via, false); }
    return via ? 'UNLOAD' : 'UNLOAD/direct';
  },
  /** D30: تنزيلٌ إداري من سيارة مندوبٍ محذوف — بلوطاتٍ صريحة، ورصيد صنفها مجهول (لا غير مسمّى يُصرف) */
  UNLOAD_DEL(s, r, pid) {
    if (!s.deleted.size || !s.tracked(pid)) return null;
    const van = r.pick([...s.deleted]);
    const v = s.views().get(Sim.k(pid, van))!;
    assert.ok(v.approximate && v.total === null && v.unknownUsable === null, 'سيارة المحذوف تقريبية');
    const have = v.lots.reduce((a, l) => a + Math.max(0, l.usable.SELLABLE), 0);
    if (!(have > LOT_EPS)) return null;
    const via = s.warehouseOn;
    const q = Math.min(roundLot(have), r.qty(4));
    const explicit = randomExplicit(r, v, 'SELLABLE', q, null);
    const res = pickOutSources(v, 'SELLABLE', q, explicit);
    if (refused(res, 'UNLOAD_DEL') || !res.ok) return 'UNLOAD/deleted-refused';
    assert.ok(res.rows.every((x) => x.lotId != null), 'D30: لا غير مسمّى من سيارة محذوفة');
    s.vanItems.push({ productId: pid, vanKey: van, type: 'UNLOAD', qty: q, createdAt: s.now(), lots: res.rows.map((x) => lotRow(s, x, via, 1)) });
    for (const row of res.rows) { s.apply(pid, van, 'SELLABLE', row.lotId, -row.qty, true, false); s.apply(pid, WH, 'SELLABLE', row.lotId, row.qty, via, false); }
    return 'UNLOAD/deleted';
  },
  VAN_ADJ(s, r, pid) {
    const van = r.pick(s.liveVans());
    if (r.bool(0.5)) {
      const q = s.tracked(pid) ? liveQty(r, 5) : r.qty(5);
      if (s.tracked(pid) && !isLotQty(q)) return 'QTY/refused';
      const lots = s.lotsOf(pid);
      const lotId = !s.tracked(pid) || r.bool(0.3) ? null : (lots.length && r.bool(0.6) ? r.pick(lots).id : s.newLot(pid, r).id);
      s.vanItems.push({ productId: pid, vanKey: van, type: 'ADJUST', qty: q, createdAt: s.now(), lots: s.tracked(pid) ? [lotRow(s, { lotId, qty: q, certainty: 'CONFIRMED', expiryDate: null }, false, 1)] : null });
      s.apply(pid, van, 'SELLABLE', lotId, q, s.tracked(pid), false);
      return 'VAN_ADJ+';
    }
    if (!s.tracked(pid)) { const q = r.qty(5); s.vanItems.push({ productId: pid, vanKey: van, type: 'ADJUST', qty: -q, createdAt: s.now(), lots: null }); s.apply(pid, van, 'SELLABLE', null, -q, false, false); return 'VAN_ADJ-~'; }
    const q = liveQty(r, 5);
    const v = s.views().get(Sim.k(pid, van))!;
    const res = pickOutSources(v, 'SELLABLE', q, r.bool(0.6) ? randomExplicit(r, v, 'SELLABLE', q, null) : null);
    if (fineRefused(res, q, 'VAN_ADJ-')) return 'QTY/refused';
    if (refused(res, 'VAN_ADJ-') || !res.ok) return null;
    s.vanItems.push({ productId: pid, vanKey: van, type: 'ADJUST', qty: -q, createdAt: s.now(), lots: res.rows.map((x) => lotRow(s, x, false, -1)) });
    assertI3(s.vanItems[s.vanItems.length - 1].lots!, -q, 'VAN_ADJ-');
    for (const row of res.rows) s.apply(pid, van, 'SELLABLE', row.lotId, -row.qty, true, false);
    return 'VAN_ADJ-';
  },
  REMOVE(s, r, pid) {
    const van = r.pick(s.liveVans());
    const [type, bucket] = r.pick([['EXPIRED_OUT', 'EXPIRED'], ['DAMAGED_OUT', 'DAMAGED']] as const);
    const v = s.views().get(Sim.k(pid, van))!;
    const have = v.total![bucket];
    if (!(have > LOT_EPS)) return null;
    const q = Math.min(have, r.qty(4));
    if (!s.tracked(pid)) { s.vanItems.push({ productId: pid, vanKey: van, type, qty: q, createdAt: s.now(), lots: null }); s.apply(pid, van, bucket, null, -q, false, false); return `${type}~`; }
    const res = pickOutSources(v, bucket, q, r.bool(0.6) ? randomExplicit(r, v, bucket, q, null) : null);
    if (refused(res, type) || !res.ok) return null;
    assertI3(res.rows, q, type);
    s.vanItems.push({ productId: pid, vanKey: van, type, qty: q, createdAt: s.now(), lots: res.rows.map((x) => lotRow(s, x, false, 1)) });
    for (const row of res.rows) s.apply(pid, van, bucket, row.lotId, -row.qty, true, false);
    return type;
  },
  SALE(s, r, pid) {
    const van = r.pick(s.liveVans());
    const tracked = s.tracked(pid);
    const replay = tracked && r.bool(0.35) ? { at: new Date(s.now() - r.int(0, 30) * 3_600_000), clamped: r.bool(0.2) } : null;
    // الإعادة لا تُرفض بالكسر (R6) والجهاز يحدّ الكمية بأربع خانات؛ والحيّ قد يرسل خمس خانات فتُرفض
    const q = tracked && !replay ? liveQty(r, 8) : r.qty(8);
    const nLines = r.bool(0.3) ? 2 : 1;
    const q1 = nLines === 2 ? Math.round(q * 1000 * r.next()) / 1000 : q;
    // كميةٌ بخمس خانات سطرٌ واحد: تُرفض كما هي (قسمتها تقرّب الباقي فتُخفي الرفض)
    const lines = nLines === 2 && q1 > 0 && q1 < q && isLotQty(q) ? [{ idx: 0, qty: q1 }, { idx: 1, qty: roundLot(q - q1) }] : [{ idx: 0, qty: q }];
    const inv: Inv = { id: s.id('S'), type: 'CASH', vanKey: van, status: 'CONFIRMED', returnToStock: true, returnReason: null, phase2: false, mirror: null, createdAt: s.now(), items: [] };
    if (!tracked) {
      const v = s.vanTotals(van).get(pid)?.SELLABLE ?? 0;
      if (q > v + LOT_EPS && r.bool(0.6)) return null; // البيع بلا مخزون مسموحٌ لغير المتتبَّع (التاريخ السالب)
      inv.items = lines.map((l) => ({ id: s.id('I'), productId: pid, qty: l.qty, returnExpired: null, lots: null, returnOfItemId: null }));
      s.invoices.push(inv);
      s.apply(pid, van, 'SELLABLE', null, -q, false, false);
      return 'SALE~';
    }
    const v = s.views().get(Sim.k(pid, van))!;
    let hint: LotRef[] | null = null;
    if (replay && r.bool(0.6)) hint = randomExplicit(r, v, 'SELLABLE', q, null);
    const explicit = !replay && r.bool(0.25) ? randomExplicit(r, v, 'SELLABLE', q, s.day()) : null;
    // لكل سطرٍ صريحه أو تلميحه: المسحوب على الكمية يُقسم على الأسطر بترتيبها، والعبث (Σ ≠ الكمية) كله على السطر الأول فيُرفض
    const perLine = (refs: LotRef[] | null): (LotRef[] | null)[] => {
      if (!refs || lines.length === 1) return lines.map(() => refs);
      if (Math.abs(sumQty(refs) - q) > 1e-9) return [refs, null];
      const per = distributeToLines(refs.map((x) => ({ lotId: x.lotId, qty: x.qty, certainty: 'CONFIRMED' as const, flags: [], expiryDate: null })), lines);
      return lines.map((l) => per.get(l.idx)!.map((x) => ({ lotId: x.lotId, qty: x.qty })));
    };
    const ex = perLine(explicit), hi = perLine(hint);
    // معامل وحدة كل سطر (D22): الصنف قد يتكرّر بوحدتين في الفاتورة
    const outLines: OutLine[] = lines.map((l, i) => ({ idx: l.idx, qty: l.qty, unitFactor: r.pick([1, 1, 6, 24]), explicit: ex[i], hint: hi[i] }));
    const res = allocateOutLines({ productId: pid, productName: pid, lines: outLines, view: v, day: s.day(), mode: 'SALE', allowUnknown: r.bool(0.75), replay });
    if (!replay && fineRefused(res, q, 'SALE')) return 'QTY/refused';
    if (refused(res, 'SALE') || !res.ok) return null;
    assertI3(res.rows, q, 'SALE');
    // D22: سطرٌ وزّعه الخادم بوحدةٍ أكبر من الأساس لا يشقّ وحدةً بلا وسم — كرتونٌ سليم ⇒ صفٌّ واحد على الأكثر بغير مضاعفات F
    for (const l of outLines) {
      const rows = res.lines.get(l.idx)!;
      const byServer = !l.explicit?.length && (!l.hint?.length || rows.some((x) => x.flags.includes('HINT_REJECTED')));
      if (!byServer || !(l.unitFactor > 1)) continue;
      cartonStats.lines++;
      if (outLines.length > 1) cartonStats.multi++;
      if (rows.some((x) => x.flags.includes('SPLIT_UNIT'))) cartonStats.split++;
      const odd = rows.filter((x) => Math.abs(x.qty / l.unitFactor - Math.round(x.qty / l.unitFactor)) > 1e-6).length;
      if (odd < 2) continue;
      cartonStats.odd++;
      assert.ok(rows.some((x) => x.flags.includes('SPLIT_UNIT')), `D22: وحدةٌ مشقوقة بلا وسم ${JSON.stringify(rows)}`);
      assert.ok(res.warnings.some((w) => w.code === 'LOT_SPLIT_UNIT' && w.detail?.idx === l.idx), 'D22: بلا تحذيرٍ لسطره');
    }
    for (const row of res.rows) {
      if (!row.lotId) continue;
      const m = s.metas.get(row.lotId)!;
      const eligible = m.status === 'ACTIVE' && !isLotExpiredOn(m, s.day());
      if (!replay) assert.ok(eligible, 'I4: بيعٌ حيّ من غير مؤهَّل');
      else if (!eligible) assert.ok(row.flags.some((f) => f === 'REPLAY_BLOCKED' || f === 'REPLAY_RECALLED' || f === 'REPLAY_EXPIRED'), 'إعادةٌ من غير مؤهَّل بلا وسم');
    }
    inv.items = lines.map((l) => {
      const rows = res.lines.get(l.idx)!;
      assertI3(rows, l.qty, 'SALE line');
      const itemId = s.id('I');
      return { id: itemId, productId: pid, qty: l.qty, returnExpired: null, lots: rows.map((x) => lotRow(s, x, false, 1)), returnOfItemId: null };
    });
    s.invoices.push(inv);
    for (const row of res.rows) s.apply(pid, van, 'SELLABLE', row.lotId, -row.qty, true, false);
    return replay ? 'SALE/replay' : 'SALE';
  },
  RETURN(s, r, pid) {
    const linked = r.bool(0.6);
    const day = s.day();
    let van: string = r.pick(s.liveVans());
    let saleItem: InvItem | null = null;
    let q = r.qty(4);
    if (linked) {
      const sales = s.invoices.filter((i) => i.type === 'CASH' && i.status === 'CONFIRMED' && !s.deleted.has(i.vanKey)).flatMap((i) => i.items.filter((it) => it.productId === pid).map((it) => ({ i, it })));
      if (!sales.length) return null;
      const pickd = r.pick(sales);
      van = pickd.i.vanKey; saleItem = pickd.it;
      const returned = s.invoices.filter((i) => i.type === 'RETURN' && i.status === 'CONFIRMED').flatMap((i) => i.items).filter((it) => it.returnOfItemId === saleItem!.id).reduce((a, it) => a + it.qty, 0);
      const avail = roundLot(saleItem.qty - returned);
      if (!(avail > LOT_EPS)) return null;
      q = Math.min(avail, q);
    }
    const inv: Inv = {
      id: s.id('R'), type: 'RETURN', vanKey: van, status: 'CONFIRMED', returnToStock: r.bool(0.7), returnReason: r.bool(0.3) ? 'DAMAGED' : 'NORMAL',
      phase2: r.bool(0.25), mirror: r.pick([null, 'clearance_pending']), createdAt: s.now(), items: [],
    };
    const item: InvItem = { id: s.id('I'), productId: pid, qty: q, returnExpired: null, lots: null, returnOfItemId: saleItem?.id ?? null };
    inv.items = [item];
    if (s.tracked(pid)) {
      let rows: AllocRow[];
      if (saleItem) {
        const saleRows: SaleLotRow[] = (saleItem.lots ?? []).map((l) => ({ id: l.id, lotId: l.lotId, quantity: l.qty, certainty: l.certainty as SaleLotRow['certainty'], expiryDate: l.expiryDate }));
        const returnedBySource = new Map<string, number>();
        for (const i of s.invoices) {
          if (i.type !== 'RETURN' || i.status !== 'CONFIRMED') continue;
          for (const it of i.items) for (const l of it.lots ?? []) if (l.sourceItemLotId) returnedBySource.set(l.sourceItemLotId, (returnedBySource.get(l.sourceItemLotId) ?? 0) + l.qty);
        }
        rows = allocateReturnFromSale({ qty: q, returnDay: day, saleRows, returnedBySource });
      } else if (r.bool(0.5)) {
        rows = [{ lotId: null, qty: q, certainty: 'UNKNOWN', flags: [], expiryDate: null }]; // المندوب: غير معروف بلا نقرة (D5)
      } else {
        const lots = s.lotsOf(pid);
        const m = lots.length ? r.pick(lots) : s.newLot(pid, r); // الإدارة: لوطٌ صريح (الموقوف يدخل معزولاً)
        rows = [{ lotId: m.id, qty: q, certainty: 'CONFIRMED', flags: [], expiryDate: m.expiryDate }];
      }
      assertI3(rows, q, 'RETURN');
      const stamp = stampFromRows(rows, day);
      item.returnExpired = stamp ? stamp.returnExpired : r.pick([null, false]);
      item.lots = rows.map((x) => lotRow(s, x, false, 1));
    } else item.returnExpired = r.pick([null, false, true]);
    s.invoices.push(inv);
    const e = bucketOf(inv, item);
    if (e) for (const l of item.lots ?? [{ lotId: null, qty: q }]) s.apply(pid, van, e.bucket, l.lotId, l.qty, s.tracked(pid), isHeld(inv));
    return linked ? 'RETURN/linked' : 'RETURN/free';
  },
  CANCEL(s, r) {
    const cands = s.invoices.filter((i) => i.status === 'CONFIRMED' && !i.phase2); // المرحلة الثانية لا تُلغى يدوياً (invoices.ts)
    if (!cands.length) return null;
    const inv = r.pick(cands);
    if (inv.type === 'CASH') {
      const itemIds = new Set(inv.items.map((it) => it.id));
      if (s.invoices.some((i) => i.type === 'RETURN' && i.status === 'CONFIRMED' && i.items.some((it) => it.returnOfItemId && itemIds.has(it.returnOfItemId)))) return null;
      inv.status = 'CANCELLED';
      for (const it of inv.items) for (const l of rowsOrPseudo(it)) s.apply(it.productId, inv.vanKey, 'SELLABLE', l.lotId, l.qty, l.counted(s), false);
      return 'CANCEL/sale';
    }
    if (!keepsLots(s, inv, (it) => bucketOf(inv, it)?.bucket ?? null)) return 'CANCEL/return-refused';
    inv.status = 'CANCELLED';
    for (const it of inv.items) {
      const e = bucketOf(inv, it);
      if (e) for (const l of rowsOrPseudo(it)) s.apply(it.productId, inv.vanKey, e.bucket, l.lotId, -l.qty, l.counted(s), false);
    }
    return 'CANCEL/return';
  },
  RESTOCK(s, r) {
    // المسار (invoices.ts restock) لا يمنع المرحلة الثانية: المحجوز يتبدّل خامُه ومحجوزُه معاً
    const cands = s.invoices.filter((i) => i.type === 'RETURN' && i.status === 'CONFIRMED');
    if (!cands.length) return null;
    const inv = r.pick(cands);
    const held = isHeld(inv);
    const before = inv.items.map((it) => bucketOf(inv, it));
    if (inv.returnToStock && !keepsLots(s, inv, (it) => (bucketOf(inv, it)?.bucket === 'SELLABLE' ? 'SELLABLE' : null))) return 'RESTOCK/refused';
    inv.returnToStock = !inv.returnToStock;
    inv.items.forEach((it, i) => {
      const b0 = before[i], b1 = bucketOf(inv, it);
      if (b0?.bucket === b1?.bucket) return;
      for (const l of rowsOrPseudo(it)) {
        if (b0) s.apply(it.productId, inv.vanKey, b0.bucket, l.lotId, -l.qty, l.counted(s), held);
        if (b1) s.apply(it.productId, inv.vanKey, b1.bucket, l.lotId, l.qty, l.counted(s), held);
      }
    });
    if (held) return 'RESTOCK/held';
    return inv.returnToStock ? 'RESTOCK/on' : 'RESTOCK/off';
  },
  RELABEL(s, r, pid) {
    if (!s.tracked(pid)) return null;
    const place = s.warehouseOn && r.bool(0.4) ? WH : r.pick(s.liveVans());
    const bucket: LotBucket = place === WH ? 'SELLABLE' : r.pick(['SELLABLE', 'SELLABLE', 'EXPIRED', 'DAMAGED'] as const);
    const v = s.views().get(Sim.k(pid, place))!;
    const fromLot = v.lots.length && r.bool(0.6) ? r.pick(v.lots) : null;
    const fromUsable = fromLot ? fromLot.usable[bucket] : (v.unknownUsable?.[bucket] ?? 0);
    if (!(fromUsable > LOT_EPS)) return null;
    // D27: لا تدوير للموقوف والمنتهي
    if (fromLot && (fromLot.meta.status !== 'ACTIVE' || isLotExpiredOn(fromLot.meta, s.day()))) return 'RELABEL/refused';
    const q = Math.min(fromUsable, r.qty(5));
    const lots = s.lotsOf(pid);
    let toLotId: string | null = r.bool(0.15) ? null : (lots.length && r.bool(0.5) ? r.pick(lots).id : s.newLot(pid, r).id);
    if ((fromLot?.lotId ?? null) === toLotId) toLotId = toLotId == null ? s.newLot(pid, r).id : null;
    if (!fromLot && toLotId == null) return null;
    s.relabels.push({ productId: pid, place: place === WH ? 'WAREHOUSE' : 'VAN', vanKey: place === WH ? null : place, bucket, fromLotId: fromLot?.lotId ?? null, toLotId, qty: q, createdAt: s.now() });
    // بُعد اللوط وحده: رصيد الصنف لا يتغيّر
    s.add(fromLot ? s.named : s.unk, fromLot ? Sim.k(pid, place, fromLot.lotId, bucket) : Sim.k(pid, place, bucket), -q);
    s.add(toLotId ? s.named : s.unk, toLotId ? Sim.k(pid, place, toLotId, bucket) : Sim.k(pid, place, bucket), q);
    return 'RELABEL';
  },
  BLOCK(s, r, pid) {
    const lots = s.lotsOf(pid);
    if (!lots.length) return null;
    const m = r.pick(lots);
    if (m.status === 'ACTIVE') { m.status = 'BLOCKED'; m.blockKind = r.pick(['HOLD', 'RECALL'] as const); m.blockedAt = new Date(s.now()); return 'BLOCK'; }
    m.status = 'ACTIVE'; m.blockKind = null; m.blockedAt = null;
    return 'UNBLOCK';
  },
  MIRROR(s, r) {
    // الإبطال (رفض الهيئة أو السحب) يقع على أي مستندٍ محجوز — ومنه ما كُتب قبل الحقبة أو بلا صفوف — بلا فحص (D24)
    const cands = s.invoices.filter((i) => i.status === 'CONFIRMED' && isHeld(i));
    if (!cands.length) return null;
    const inv = r.pick(cands);
    const void_ = r.bool(0.5);
    let unnamed = false;
    for (const it of inv.items) {
      const e = bucketOf(inv, it);
      if (!e) continue;
      for (const l of rowsOrPseudo(it)) {
        const counted = l.counted(s);
        if (!counted || l.lotId == null) unnamed = true;
        if (void_) s.apply(it.productId, inv.vanKey, e.bucket, l.lotId, -l.qty, counted, true); // الخام والمحجوز معاً
        else s.unhold(it.productId, inv.vanKey, e.bucket, l.lotId, l.qty, counted);
      }
    }
    if (void_) { inv.status = 'CANCELLED'; inv.mirror = 'rejected'; return unnamed ? 'VOID/unnamed' : 'VOID'; }
    inv.mirror = NOT_HELD_MIRROR;
    return 'MIRROR/cleared';
  },
  TRACK(s, r, pid) {
    if (s.productTracked.get(pid)) {
      if (r.bool(0.5)) return null;
      s.productTracked.set(pid, false);
      return 'TRACK_OFF';
    }
    s.productTracked.set(pid, true);
    s.productSince.set(pid, s.now());
    if (s.tenantOn) s.resetEpoch(pid);
    return 'TRACK_ON';
  },
  TENANT(s, r) {
    if (s.tenantOn) {
      if (r.bool(0.6)) return null;
      s.tenantOn = false;
      return 'TENANT_OFF';
    }
    s.tenantOn = true;
    s.tenantSince = s.now();
    for (const p of PIDS) s.resetEpoch(p);
    return 'TENANT_ON';
  },
  /** تبديل المستودع (D4/D28): رصيده يبقى كما يحسبه composeWarehouse، ولوطاته لا تمسّها حركةٌ بلا مستودع */
  WAREHOUSE(s) { s.warehouseOn = !s.warehouseOn; return s.warehouseOn ? 'WH_ON' : 'WH_OFF'; },
  /** حذف المندوب R2 (الحذف يمضي دائماً) وفي سيارته لوطٌ صالح: سيارته تبقى بمفتاحها، ورصيد صنفها مجهول (approximate) */
  DELETE_REP(s) {
    if (s.deleted.has('R2')) return null;
    const views = s.views();
    if (!PIDS.some((p) => s.tracked(p) && views.get(Sim.k(p, 'R2'))!.lots.some((l) => l.usable.SELLABLE > LOT_EPS))) return null;
    s.deleted.add('R2');
    return 'DELETE_REP';
  },
  DAY(s, r) { s.d += r.int(1, 3); return 'DAY'; },
};

function lotRow(s: Sim, x: Pick<AllocRow, 'lotId' | 'qty' | 'certainty' | 'expiryDate'> & { sourceItemLotId?: string | null }, viaWarehouse: boolean, sign: 1 | -1): LotRowW {
  return { id: s.id('X'), lotId: x.lotId, qty: sign * x.qty, certainty: x.certainty, viaWarehouse, createdAt: s.now(), expiryDate: x.expiryDate, sourceItemLotId: x.sourceItemLotId ?? null };
}

/** صفوف البند (أو صفٌّ وهميّ غير محسوب لبندٍ كُتب والصنف غير متتبَّع) — counted: هل يدخل الخام الآن */
function rowsOrPseudo(it: InvItem): { lotId: string | null; qty: number; counted: (s: Sim) => boolean }[] {
  if (!it.lots) return [{ lotId: null, qty: it.qty, counted: () => false }];
  return it.lots.map((l) => ({ lotId: l.lotId, qty: l.qty, counted: (s: Sim) => s.counted(it.productId, l.createdAt) }));
}

/**
 * حارس إلغاء المرتجع وإطفاء عودته — الدالتان الصرفتان نفسهما اللتان يستعملهما assertReturnCancelKeepsLots/
 * assertRestockOffKeepsLots (§٤.١٢–٤.١٣): lotRemovalsOf (بندٌ بلا صفوف وصفٌّ قبل الحقبة على غير المسمّى، والمحجوز بلا فحص)
 * ثم removalKeepsLots على عرض السيارة لكل صنف.
 */
function keepsLots(s: Sim, inv: Inv, bucketFor: (it: InvItem) => LotBucket | null): boolean {
  const views = s.views();
  const items: LotRemovalItem[] = inv.items.map((it) => ({
    productId: it.productId, qty: it.qty, bucket: bucketFor(it), held: isHeld(inv),
    rows: it.lots ? it.lots.map((l) => ({ lotId: l.lotId, quantity: l.qty, createdAt: new Date(l.createdAt) })) : null,
  }));
  const since = new Map(PIDS.map((p) => { const x = s.since(p); return [p, Number.isFinite(x) ? new Date(x) : null] as const; }));
  const removals = lotRemovalsOf(items, since, new Set(PIDS.filter((p) => s.tracked(p))));
  for (const pid of new Set(removals.map((x) => x.productId))) {
    if (removalKeepsLots(views.get(Sim.k(pid, inv.vanKey))!, removals)) return false;
  }
  return true;
}

const PLACES = [WH, ...VANS];
const OP_WEIGHTS: [string, number][] = [
  ['RECEIVE', 12], ['WH_ADJ', 5], ['LOAD', 16], ['UNLOAD', 5], ['VAN_ADJ', 5], ['REMOVE', 8], ['SALE', 14], ['RETURN', 12],
  ['CANCEL', 5], ['RESTOCK', 5], ['RELABEL', 6], ['BLOCK', 4], ['MIRROR', 5], ['TRACK', 2], ['TENANT', 1], ['WAREHOUSE', 1], ['DELETE_REP', 2], ['DAY', 4],
];
const W_TOTAL = OP_WEIGHTS.reduce((s, [, w]) => s + w, 0);
function pickOp(r: Rng): string {
  let x = r.next() * W_TOTAL;
  for (const [n, w] of OP_WEIGHTS) { x -= w; if (x < 0) return n; }
  return 'DAY';
}

const eq = (a: number, b: number, msg: string) => assert.equal(roundLot(a) + 0, roundLot(b) + 0, msg);

function check(s: Sim, prev: Map<string, PlaceLotView> | null, opName: string, where: string, trackedBefore: Set<string>, whOnBefore: boolean): Map<string, PlaceLotView> {
  const views = s.views();
  const resets = opName === 'TRACK_ON' || opName === 'TENANT_ON';
  // رصيد الصنف والمحجوز الكلي: النموذج = foldStock/composeWarehouse = مجاميعهما (vanTotalsFromAgg، vanHeldFromAgg، warehouseOnHandAgg)
  const loads: AggVanTotalLoad[] = [], invs: AggVanTotalInv[] = [];
  for (const van of VANS) {
    for (const l of s.loadRows(van)) loads.push({ productId: l.productId, vanKey: van, type: l.vanLoad.type, qty: sqlBase(l as Parameters<typeof sqlBase>[0]) });
    for (const i of s.invoices) {
      if (i.vanKey !== van || i.status !== 'CONFIRMED') continue;
      for (const it of i.items) invs.push({ productId: it.productId, vanKey: van, type: i.type, returnToStock: i.returnToStock, returnExpired: it.returnExpired ?? null, damaged: i.returnReason === 'DAMAGED', held: isHeld(i), qty: sqlBase(unitRow(it.qty, it.id)) });
    }
  }
  const agg = vanTotalsFromAgg(loads, invs, { foldStock, bucketRemaining });
  const heldAgg = vanHeldFromAgg(invs, { foldStock, bucketRemaining });
  const whAgg = warehouseOnHandAgg([
    ...s.wh.map((w, i): WhTotalAgg => ({ productId: w.productId, source: 'WH', type: w.type, qty: sqlBase(unitRow(w.qty, `W${i}`)) })),
    ...s.vanItems.map((v, i): WhTotalAgg => ({ productId: v.productId, source: 'VAN', type: v.type, qty: sqlBase(unitRow(v.qty, i)) })),
  ]);
  for (const pid of PIDS) {
    eq(views.get(Sim.k(pid, WH))!.total!.SELLABLE, s.total.get(Sim.k(pid, WH, 'SELLABLE')) ?? 0, `${where}: رصيد المستودع ${pid}`);
    eq(whAgg.get(pid) ?? 0, s.total.get(Sim.k(pid, WH, 'SELLABLE')) ?? 0, `${where}: مجاميع المستودع ${pid}`);
    for (const van of VANS) for (const b of LOT_BUCKETS) {
      const want = s.total.get(Sim.k(pid, van, b)) ?? 0;
      if (!s.deleted.has(van)) eq(views.get(Sim.k(pid, van))!.total![b], want, `${where}: رصيد ${pid} في ${van} ${b}`);
      eq(agg.get(van)?.get(pid)?.[b] ?? 0, want, `${where}: مجاميع ${pid} في ${van} ${b}`);
      eq(heldAgg.get(van)?.get(pid)?.[b] ?? 0, s.heldT.get(Sim.k(pid, van, b)) ?? 0, `${where}: المحجوز الكلي ${pid} في ${van} ${b}`);
    }
  }
  for (const pid of PIDS) {
    if (!s.tracked(pid)) continue;
    for (const place of PLACES) {
      const v = views.get(Sim.k(pid, place))!;
      const buckets = place === WH ? (['SELLABLE'] as const) : LOT_BUCKETS;
      // الطيّ = النموذج، لوطاً لوطاً
      const seen = new Set<string>();
      for (const l of v.lots) {
        seen.add(l.lotId);
        for (const b of buckets) {
          eq(l.raw[b], s.named.get(Sim.k(pid, place, l.lotId, b)) ?? 0, `${where}: خام ${pid}/${place}/${l.lotId}/${b}`);
          eq(l.held[b], s.heldN.get(Sim.k(pid, place, l.lotId, b)) ?? 0, `${where}: محجوز ${pid}/${place}/${l.lotId}/${b}`);
          assert.ok(l.usable[b] >= -LOT_EPS, `${where}: I1 صالحٌ سالب ${pid}/${place}/${l.lotId}/${b} = ${l.usable[b]}`);
        }
      }
      for (const [k, q] of s.named) {
        const [kp, kpl, klot] = k.split('|');
        if (kp === pid && kpl === place && !seen.has(klot)) assert.ok(Math.abs(q) <= LOT_EPS, `${where}: لوط في النموذج غائب عن الطيّ ${k}=${q}`);
      }
      if (s.deleted.has(place)) { assert.equal(v.unknownUsable, null, `${where}: سيارة المحذوف بلا غير مسمّى`); continue; }
      for (const b of buckets) {
        const unk = s.unk.get(Sim.k(pid, place, b)) ?? 0;
        const hu = s.heldU.get(Sim.k(pid, place, b)) ?? 0;
        eq(v.unknown![b], unk, `${where}: غير المسمّى ${pid}/${place}/${b}`);
        eq(v.unknownUsable![b], unk - hu, `${where}: صالح غير المسمّى ${pid}/${place}/${b}`);
        // D28: I1/I2 للمستودع مشروطان بتفعيله — حركةٌ بلا مستودع تُنقص غير مسمّاه بلا فحص
        if (place === WH && !whOnBefore) continue;
        if (prev && !resets && trackedBefore.has(pid)) {
          const before = prev.get(Sim.k(pid, place))!.unknownUsable![b];
          assert.ok(v.unknownUsable![b] >= Math.min(0, before) - LOT_EPS, `${where}: I2 غير المسمّى نقص دون min(0, قبله): ${before} → ${v.unknownUsable![b]}`);
        }
      }
    }
  }
  // I3: صفوف كل بند = كميته الأساسية بإشارتها (lotBaseQty على صفّ البند بلقطة وحدته — D22)
  s.vanItems.forEach((it, i) => { if (it.lots) assertI3(it.lots, lotBaseQty(unitRow(it.qty, i)), `${where}: بند سيارة`); });
  for (const i of s.invoices) for (const it of i.items) if (it.lots) assertI3(it.lots, lotBaseQty(unitRow(it.qty, it.id)), `${where}: بند فاتورة`);
  return views;
}

test('J1 حالةٌ محدَّدة: إلغاء مرتجعٍ صفوفه من حقبةٍ سابقة يُفحص على غير المسمّى لا على لوطه (§٤.١٢)', () => {
  const s = new Sim();
  s.tenantOn = true; s.tenantSince = s.now(); s.productTracked.set('P1', true); s.productSince.set('P1', s.now());
  const L = s.newLot('P1', rng(1));
  // مرتجعٌ حرّ بخمسٍ من L في الحقبة الأولى
  s.t += 1000;
  const inv: Inv = { id: 'R', type: 'RETURN', vanKey: 'R1', status: 'CONFIRMED', returnToStock: true, returnReason: 'NORMAL', phase2: false, mirror: null, createdAt: s.now(), items: [] };
  inv.items = [{ id: 'I', productId: 'P1', qty: 5, returnExpired: false, lots: [lotRow(s, { lotId: L.id, qty: 5, certainty: 'CONFIRMED', expiryDate: L.expiryDate }, false, 1)], returnOfItemId: null }];
  s.invoices.push(inv);
  s.apply('P1', 'R1', 'SELLABLE', L.id, 5, true, false);
  // إطفاء تتبّع الصنف ثم إعادته: حقبةٌ جديدة، والخمس غير مسمّاة — ثم تُسمّى كلها إلى L
  s.t += 1000; s.productTracked.set('P1', false);
  s.t += 1000; s.productTracked.set('P1', true); s.productSince.set('P1', s.now()); s.resetEpoch('P1');
  s.t += 1000;
  s.relabels.push({ productId: 'P1', place: 'VAN', vanKey: 'R1', bucket: 'SELLABLE', fromLotId: null, toLotId: L.id, qty: 5, createdAt: s.now() });
  s.add(s.unk, Sim.k('P1', 'R1', 'SELLABLE'), -5);
  s.add(s.named, Sim.k('P1', 'R1', L.id, 'SELLABLE'), 5);
  const v = s.views().get(Sim.k('P1', 'R1'))!;
  assert.deepEqual([v.lots[0].usable.SELLABLE, v.unknownUsable!.SELLABLE], [5, 0]);
  // الإلغاء يُنقص غير المسمّى (صفوفه قبل الحقبة لا تدخل خام L) ⇒ يُرفض؛ ولو فُحص على L لقُبل وصار غير المسمّى −5 (I2)
  assert.equal(keepsLots(s, inv, (it) => bucketOf(inv, it)?.bucket ?? null), false);
});

test('J1: ألف تسلسل عشوائي — الطيّ = النموذج المرجعي، ورصيد الصنف = foldStock وcomposeWarehouse، وI1 وI2 وI3 وI4', () => {
  const stats = new Map<string, number>();
  for (let seed = 1; seed <= 1000; seed++) {
    const r = rng(seed * 7919);
    const s = new Sim();
    s.warehouseOn = r.bool(0.8);
    // تاريخ قبل التفعيل: وارد وتحميل وبيعٌ قد يتجاوز المخزون (سالب تاريخي) ومرتجعات (ومنها قياسيةٌ محجوزة) — بلا لوط
    const pre = r.int(3, 10);
    for (let i = 0; i < pre; i++) {
      s.t += 1000;
      const name = r.pick(['RECEIVE', 'LOAD', 'SALE', 'SALE', 'RETURN', 'RETURN', 'UNLOAD', 'VAN_ADJ']);
      ops[name](s, r, r.pick(PIDS));
    }
    s.t += 1000;
    if (r.bool(0.9)) s.productTracked.set('P1', true), s.productSince.set('P1', s.now());
    if (r.bool(0.6)) s.productTracked.set('P2', true), s.productSince.set('P2', s.now());
    ops.TENANT(s, r, 'P1');
    let prev = check(s, null, 'TENANT_ON', `seed ${seed} بداية`, new Set(), s.warehouseOn);
    const steps = r.int(15, 35);
    for (let step = 0; step < steps; step++) {
      s.t += 1000;
      // ما بقي مطفأً يعود غالباً — فأغلب الخطوات على صنفٍ متتبَّع، ويبقى المطفأ مختبَراً
      const off = PIDS.filter((p) => !s.productTracked.get(p));
      // وبعد حذف مندوبٍ يُنزَّل من سيارته أحياناً (D30)
      const name = !s.tenantOn && r.bool(0.3) ? 'TENANT' : off.length && r.bool(0.12) ? 'TRACK' : s.deleted.size && r.bool(0.12) ? 'UNLOAD_DEL' : pickOp(r);
      const pid = name === 'TRACK' && off.length && r.bool(0.8) ? r.pick(off) : r.pick(PIDS);
      const trackedBefore = new Set(PIDS.filter((p) => s.tracked(p)));
      const whOnBefore = s.warehouseOn;
      const done = ops[name](s, r, pid);
      const label = done ?? `${name}/skip`;
      stats.set(label, (stats.get(label) ?? 0) + 1);
      prev = check(s, prev, done ?? name, `seed ${seed} step ${step} ${label} ${pid}`, trackedBefore, whOnBefore && s.warehouseOn);
    }
  }
  // التغطية: كل عملية وقعت فعلاً مرات كافية (لا نجاح بالفراغ)
  for (const must of ['RECEIVE', 'LOAD', 'UNLOAD', 'SALE', 'SALE/replay', 'RETURN/linked', 'RETURN/free', 'CANCEL/sale', 'CANCEL/return', 'RESTOCK/off', 'RESTOCK/on',
    'RELABEL', 'BLOCK', 'UNBLOCK', 'MIRROR/cleared', 'VOID', 'TRACK_OFF', 'TRACK_ON', 'TENANT_OFF', 'TENANT_ON', 'WH_ADJ+', 'WH_ADJ-', 'VAN_ADJ+', 'VAN_ADJ-',
    'EXPIRED_OUT', 'DAMAGED_OUT', 'SALE~', 'LOAD~',
    // فجوات المراجعة: إبطال محجوزٍ غير مسمّى (قبل الحقبة أو بلا صفوف)، والمرحلة الثانية في restock، والتحميل والتنزيل بلا مستودع،
    // والسيارة المحذوفة، والكسر بخمس خانات
    'VOID/unnamed', 'RESTOCK/held', 'LOAD/direct', 'UNLOAD/direct', 'UNLOAD/deleted', 'DELETE_REP', 'WH_ON', 'WH_OFF', 'QTY/refused']) {
    assert.ok((stats.get(must) ?? 0) >= 20, `تغطية ضعيفة لـ${must}: ${stats.get(must) ?? 0}`);
  }
  // D22 لكل سطر: أسطر الكرتون وقعت فعلاً، ومنها في بيعٍ بسطرين، وفيها انشقاقٌ موسوم
  for (const [k, min] of [['lines', 100], ['multi', 40], ['split', 8], ['odd', 8]] as const) {
    assert.ok(cartonStats[k] >= min, `تغطية ضعيفة لقاعدة الكرتون (${k}): ${JSON.stringify(cartonStats)}`);
  }
  for (const refusedOp of ['CANCEL/return-refused', 'RESTOCK/refused']) assert.ok((stats.get(refusedOp) ?? 0) >= 1, `لم يقع رفضٌ واحد لـ${refusedOp}`);
});
