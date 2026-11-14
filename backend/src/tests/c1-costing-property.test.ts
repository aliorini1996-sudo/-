// «ربط الدفاتر» L3 — ثوابت محرّك التكلفة الستّة (العقد §4.7) باختبار خاصية: 2,000 تسلسل عشوائي حتمي (mulberry32)
// يغطّي الأنواع الستة عشر، والعملات بمنازل 0 و1 و2 و3، والكميات الكسرية بستّ منازل، والصلات المكسورة والمكشوف والحُفر.
//   1) انعدام الانجراف: Σ مساهمات اللقطات لكل (صنف، موقع) ولكل موقع = تقييم الحالة حرفياً (والكمية كذلك).
//   2) التوازن: Σ glImpact = 0 لكل لقطة، وΣ سطور المخزون لكل موقع = قيمته.
//   3) الكمية المقيَّمة صفر ⇒ القيمة صفر، بعد كل حركة (ومعه بنية الدلوين: الحفرة بلا خارج تقييم وقيمتها ≤ 0).
//   4) الحتمية: أي تبديل للمدخلات ⇒ الناتج نفسه حرفياً، والاستئناف من أي نقطة = الإعادة الكاملة.
//   5) ثبات تحويل الأساس: الوارد نفسه بالكراتين أو بالحبّات ⇒ القيم نفسها.
//   6) كل valueMilli/varianceMilli/memoMilli (وقيم الحالة) مضاعف لأصغر وحدة عملة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMove, compareMoves, createCostState, locStateKey, replay, snapshotLookupOf, snapshotRefOf, splitLocStateKey,
  stateTotals,
} from '../services/costing/stepper';
import { glImpactOf } from '../services/costing/accounts';
import { fromQtyU, toQtyU } from '../services/costing/math';
import {
  restockToggleKey, returnCancelKey, returnKey, saleCancelKey, saleOutKey, vanItemKey, whItemKey,
} from '../services/costing/keys';
import { toMilli, unitMilli } from '../services/gl/money';
import {
  MOVE_KINDS, STEP_WARNINGS, isVanLocation,
  type CostRefType, type LocationKey, type Move, type MoveKind, type MoveLinks, type SnapshotLookup, type StepOutput,
} from '../services/costing/types';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const roundQty = (x: number): number => Math.round(x * 1e6) / 1e6;
const T0 = Date.UTC(2026, 0, 1, 6);
const DAY = 86_400_000;

interface Sale { key: string; productId: string; location: LocationKey; qty: number; cancelled: boolean }
interface Ret {
  itemId: string; productId: string; location: LocationKey; qty: number; saleKey: string | null;
  restocked: boolean; damaged: boolean; cancelled: boolean; memoKey: string;
}

interface Generated { dec: number; moves: Move[]; cartons: Move[] }

/** تسلسل حركات واقعي البنية (صلات صحيحة غالباً ومكسورة أحياناً) — حتمي بالبذرة */
function generate(seed: number): Generated {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const dec = pick([0, 1, 2, 2, 3, 3]);
  const products = ['P1', 'P2', 'P3'].slice(0, 1 + Math.floor(r() * 3));
  const vans: LocationKey[] = ['VAN:R1', 'VAN:R2', 'VAN:_'];
  const n = 5 + Math.floor(r() * 46);
  const moves: Move[] = [];
  const cartons: Move[] = [];
  const sales: Sale[] = [];
  const rets: Ret[] = [];
  let row = 0;
  let t = T0;
  let item = 0;

  const qty = (): number => {
    const x = r();
    if (x < 0.5) return 1 + Math.floor(r() * 20);
    if (x < 0.8) return (1 + Math.floor(r() * 20_000_000)) / 1e6;
    return roundQty((1 + Math.floor(r() * 30)) / 3);
  };
  const cost4 = (): number => (1 + Math.floor(r() * 500_000)) / 10_000;
  /**
   * صلات بلا mirrorOf: نصفها بـmirrorOf: null صريح، ونصفها بلا الخاصية أصلاً (كما قد يبنيها مصدر) — ويُختبر أن
   * الشكلين سواء عند المحرّك (بلا صلة)
   */
  const noValue = (l: { locationOf?: string | null; memoOf?: string | null }): MoveLinks =>
    r() < 0.5 ? { mirrorOf: null, ...l } : (l as unknown as MoveLinks);

  const newRow = (): { createdAt: Date; id: string } => {
    row += 1;
    t += Math.floor(r() * 4) * 60_000;
    // معرّفات فريدة لكنها لا تتبع ترتيب الإنشاء (يُختبر كسر التعادل بالمعرّف)
    return { createdAt: new Date(t), id: `${(row * 7919) % 10007}-${row}` };
  };
  const refTypeOf = (key: string): CostRefType => key.split(':')[1] as CostRefType;
  const push = (
    cur: { createdAt: Date; id: string }, kind: MoveKind, key: string, productId: string, location: LocationKey, baseQty: number,
    o: { to?: LocationKey; inValue?: bigint | null; cartonInValue?: bigint | null; memoQty?: number; links?: MoveLinks; reason?: string; itemId?: string } = {},
  ): void => {
    const effectAt = new Date(cur.createdAt.getTime() + Math.floor((r() - 0.5) * 20) * DAY);
    const m: Move = {
      key, kind, effectAt, cursor: cur, productId, location, toLocation: o.to ?? null, baseQty,
      memoQty: o.memoQty ?? null, inValueMilli: o.inValue ?? null, links: o.links ?? null, reason: o.reason ?? null,
      refType: refTypeOf(key), refId: `doc-${cur.id}`, itemId: o.itemId ?? key.split(':')[2], lateArrival: r() < 0.03,
    };
    moves.push(m);
    cartons.push(o.cartonInValue !== undefined ? { ...m, inValueMilli: o.cartonInValue } : m);
  };

  const KINDS: [MoveKind, number][] = [
    ['RECEIVE', 15], ['VAN_LOAD', 12], ['VAN_UNLOAD', 6], ['VAN_SALE', 14], ['WAREHOUSE_SALE', 6], ['SALE_CANCEL', 5],
    ['VAN_RETURN_RESTOCK', 5], ['WAREHOUSE_RETURN_RESTOCK', 3], ['RETURN_WRITE_OFF', 4], ['RETURN_CANCEL', 4],
    ['RESTOCK_TOGGLE', 6], ['WH_ADJUST', 5], ['VAN_ADJUST', 4], ['ZERO_RUN', 3], ['VENDOR_RETURN', 3], ['DAMAGE_OUT', 2],
  ];
  const totalW = KINDS.reduce((s, [, w]) => s + w, 0);
  const pickKind = (): MoveKind => {
    let x = r() * totalW;
    for (const [k, w] of KINDS) if ((x -= w) < 0) return k;
    return 'RECEIVE';
  };

  for (let i = 0; i < n; i++) {
    const kind = pickKind();
    const p = pick(products);
    const cur = newRow();
    switch (kind) {
      case 'RECEIVE': {
        if (r() < 0.5) {
          // سطر بالكراتين: k كرتون × f حبّة، بسعر الكرتون = سعر الحبّة × f
          const f = pick([6, 12, 24]);
          const k = (1 + Math.floor(r() * 5)) + (r() < 0.3 ? 0.5 : 0);
          const c = cost4();
          const priced = r() < 0.85;
          push(cur, 'RECEIVE', whItemKey(`w${++item}`), p, 'WH', k * f, {
            inValue: priced ? toMilli(k * f * c, dec) : null,
            cartonInValue: priced ? toMilli(k * (c * f), dec) : null,
          });
        } else {
          const q = qty();
          push(cur, 'RECEIVE', whItemKey(`w${++item}`), p, 'WH', q, { inValue: r() < 0.8 ? toMilli(q * cost4(), dec) : null });
        }
        break;
      }
      case 'VAN_LOAD':
        push(cur, 'VAN_LOAD', vanItemKey(`v${++item}`), p, 'WH', -qty(), { to: pick(vans) });
        break;
      case 'VAN_UNLOAD':
        push(cur, 'VAN_UNLOAD', vanItemKey(`v${++item}`), p, pick(vans), -qty(), { to: 'WH' });
        break;
      case 'VAN_SALE':
      case 'WAREHOUSE_SALE': {
        // فاتورة ببند إلى ثلاثة على الصف نفسه
        const loc: LocationKey = kind === 'VAN_SALE' ? pick(vans) : 'WH';
        const lines = 1 + Math.floor(r() * 3);
        for (let l = 0; l < lines; l++) {
          const key = saleOutKey(`s${++item}`);
          const q = qty();
          const prod = pick(products);
          push(cur, kind, key, prod, loc, -q);
          sales.push({ key, productId: prod, location: loc, qty: q, cancelled: false });
        }
        break;
      }
      case 'SALE_CANCEL': {
        const open = sales.filter((s) => !s.cancelled);
        if (!open.length) break;
        const s = pick(open);
        s.cancelled = true;
        const itemId = s.key.split(':')[2];
        const broken = r() < 0.1;
        const link = broken ? saleOutKey(`ghost${item}`) : s.key;
        push(cur, 'SALE_CANCEL', saleCancelKey(itemId), s.productId, s.location, s.qty, { links: { mirrorOf: link, locationOf: link }, itemId });
        break;
      }
      case 'VAN_RETURN_RESTOCK':
      case 'WAREHOUSE_RETURN_RESTOCK':
      case 'RETURN_WRITE_OFF': {
        const linked = sales.length > 0 && r() < 0.85;
        const s = linked ? pick(sales) : null;
        const loc: LocationKey = s ? s.location : kind === 'WAREHOUSE_RETURN_RESTOCK' ? 'WH' : pick(vans);
        const q = s ? Math.max(0.000001, roundQty(s.qty * r() * 1.3)) : qty();
        const itemId = `ri${++item}`;
        const restock = kind !== 'RETURN_WRITE_OFF';
        const damaged = !restock && r() < 0.5;
        const saleKey = s ? (r() < 0.05 ? saleOutKey(`ghost${item}`) : s.key) : null;
        if (restock) {
          push(cur, isVanLocation(loc) ? 'VAN_RETURN_RESTOCK' : 'WAREHOUSE_RETURN_RESTOCK', returnKey(itemId), s?.productId ?? p, loc, q, { links: { mirrorOf: saleKey }, itemId });
        } else {
          push(cur, 'RETURN_WRITE_OFF', returnKey(itemId), s?.productId ?? p, loc, 0, {
            memoQty: q, links: { mirrorOf: saleKey }, reason: damaged ? 'DAMAGED' : 'NOT_RESTOCKED', itemId,
          });
        }
        rets.push({ itemId, productId: s?.productId ?? p, location: loc, qty: q, saleKey, restocked: restock, damaged, cancelled: false, memoKey: returnKey(itemId) });
        break;
      }
      case 'RESTOCK_TOGGLE': {
        const open = rets.filter((x) => !x.cancelled && !x.damaged);
        if (!open.length) break;
        const x = pick(open);
        const key = restockToggleKey(`L${row}`, x.itemId);
        // الموقع الممرَّر خاطئ أحياناً — locationOf (لقطة المرتجع) يغلبه
        const passed = r() < 0.2 ? pick(vans) : x.location;
        if (x.restocked) {
          push(cur, 'RESTOCK_TOGGLE', key, x.productId, passed, -x.qty, { links: noValue({ locationOf: returnKey(x.itemId) }), itemId: x.itemId });
          x.memoKey = key;
        } else {
          push(cur, 'RESTOCK_TOGGLE', key, x.productId, passed, x.qty, { links: { mirrorOf: x.saleKey, locationOf: returnKey(x.itemId) }, itemId: x.itemId });
        }
        x.restocked = !x.restocked;
        break;
      }
      case 'RETURN_CANCEL': {
        const open = rets.filter((x) => !x.cancelled);
        if (!open.length) break;
        const x = pick(open);
        x.cancelled = true;
        if (x.restocked) {
          push(cur, 'RETURN_CANCEL', returnCancelKey(x.itemId), x.productId, x.location, -x.qty, { links: noValue({ locationOf: returnKey(x.itemId) }), itemId: x.itemId });
        } else {
          const memoOf = r() < 0.1 ? returnKey(`ghost${item}`) : x.memoKey;
          push(cur, 'RETURN_CANCEL', returnCancelKey(x.itemId), x.productId, x.location, 0, { links: noValue({ memoOf, locationOf: returnKey(x.itemId) }), itemId: x.itemId });
        }
        break;
      }
      case 'WH_ADJUST':
        push(cur, 'WH_ADJUST', whItemKey(`a${++item}`), p, 'WH', (r() < 0.5 ? -1 : 1) * qty(), { reason: pick(['COUNT', 'DAMAGE', 'SAMPLE']) });
        break;
      case 'VAN_ADJUST':
        push(cur, 'VAN_ADJUST', vanItemKey(`a${++item}`), p, pick(vans), (r() < 0.5 ? -1 : 1) * qty(), { reason: 'COUNT' });
        break;
      case 'ZERO_RUN': {
        const loc: LocationKey = r() < 0.5 ? 'WH' : pick(vans);
        const key = loc === 'WH' ? whItemKey(`z${++item}`) : vanItemKey(`z${++item}`);
        push(cur, 'ZERO_RUN', key, p, loc, (r() < 0.8 ? -1 : 1) * qty());
        break;
      }
      case 'VENDOR_RETURN':
        push(cur, 'VENDOR_RETURN', whItemKey(`vr${++item}`), p, 'WH', -qty());
        break;
      case 'DAMAGE_OUT':
        push(cur, 'DAMAGE_OUT', vanItemKey(`x${++item}`), p, pick(vans), 0, { reason: 'DAMAGED_OUT' });
        break;
      default:
        break;
    }
  }
  return { dec, moves, cartons };
}

function shuffle<T>(xs: readonly T[], r: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const SEQUENCES = 2_000;

test(`الثوابت الستّة على ${SEQUENCES} تسلسل عشوائي (منازل 0–3، كميات بستّ منازل، كل الأنواع)`, () => {
  const kindCount = new Map<MoveKind, number>();
  const warnCount = new Map<string, number>();
  const decs = new Set<number>();
  let totalMoves = 0;
  let fractional = 0;
  let cartonDiffs = 0;

  for (let seed = 1; seed <= SEQUENCES; seed++) {
    const { dec, moves, cartons } = generate(seed);
    const u = unitMilli(dec);
    const cfg = { currencyDecimals: dec };
    decs.add(dec);
    totalMoves += moves.length;
    const tag = `seed ${seed}`;

    // ── الطيّ خطوةً خطوة مع فحص الحالة بعد كل حركة ──
    const sorted = moves.slice().sort(compareMoves);
    const state = createCostState();
    const refs = new Map<string, StepOutput>();
    const lookup: SnapshotLookup = { get: (k) => refs.get(k) };
    const outs: StepOutput[] = [];
    const contribV = new Map<string, bigint>();
    const contribQ = new Map<string, number>();
    const add = (k: string, v: bigint, q: number) => {
      contribV.set(k, (contribV.get(k) ?? 0n) + v);
      contribQ.set(k, (contribQ.get(k) ?? 0) + q);
    };
    const invByLoc = new Map<LocationKey, bigint>();

    for (const m of sorted) {
      const o = applyMove(state, m, cfg, lookup);
      refs.set(o.key, o);
      outs.push(o);
      kindCount.set(o.kind, (kindCount.get(o.kind) ?? 0) + 1);
      for (const w of o.warnings) warnCount.set(w, (warnCount.get(w) ?? 0) + 1);
      if (!Number.isInteger(m.baseQty)) fractional++;

      // (6) مضاعفات الوحدة
      assert.equal(o.valueMilli % u, 0n, `${tag} ${o.key}: valueMilli`);
      assert.equal(o.varianceMilli % u, 0n, `${tag} ${o.key}: varianceMilli`);
      assert.equal(o.memoMilli % u, 0n, `${tag} ${o.key}: memoMilli`);
      assert.ok(o.unitCostE4 >= 0n);
      assert.ok(o.uncostedQty >= 0 && o.uncostedQty <= Math.abs(o.baseQty), `${tag} ${o.key}: uncostedQty`);
      // الخروج لا فرق له
      if (o.valueMilli < 0n && o.kind !== 'VAN_LOAD' && o.kind !== 'VAN_UNLOAD') assert.equal(o.varianceMilli, 0n, `${tag} ${o.key}: خروج بفرق`);
      // التاريخ المحاسبي: كما هو، أو لا يسبق أصله للإلغاء والتبديل
      if (o.kind === 'SALE_CANCEL' || o.kind === 'RETURN_CANCEL' || o.kind === 'RESTOCK_TOGGLE') assert.ok(o.effectAt.getTime() >= m.effectAt.getTime());
      else assert.equal(o.effectAt.getTime(), m.effectAt.getTime());

      // (2) التوازن
      const g = glImpactOf(o);
      const inv = g.inventory.reduce((s, l) => s + l.milli, 0n);
      assert.equal(inv + g.cogsMilli + g.writeOffMilli + g.counterMilli, 0n, `${tag} ${o.key}: أثر غير متوازن`);
      for (const l of g.inventory) invByLoc.set(l.location, (invByLoc.get(l.location) ?? 0n) + l.milli);

      // (1) المساهمات
      add(locStateKey(o.productId, o.location), o.valueMilli, toQtyU(o.baseQty));
      if (o.toLocation) add(locStateKey(o.productId, o.toLocation), -o.valueMilli - o.varianceMilli, -toQtyU(o.baseQty));

      // (3) وبنية الدلوين لكل (صنف، موقع) بعد كل حركة
      for (const [k, s] of state.locs) {
        assert.ok(Number.isSafeInteger(s.costedQtyU) && Number.isSafeInteger(s.uncostedQtyU), `${tag} ${k}`);
        assert.ok(s.uncostedQtyU >= 0, `${tag} ${k}: خارج تقييم سالب`);
        if (s.costedQtyU === 0) assert.equal(s.valueMilli, 0n, `${tag} ${k}: كمية صفر بقيمة`);
        if (s.costedQtyU < 0) {
          assert.equal(s.uncostedQtyU, 0, `${tag} ${k}: حفرة بجوار خارج تقييم`);
          assert.ok(s.valueMilli <= 0n, `${tag} ${k}: حفرة بقيمة موجبة`);
        }
        if (s.costedQtyU > 0) assert.ok(s.valueMilli >= 0n, `${tag} ${k}: رصيد بقيمة سالبة`);
        assert.equal(s.valueMilli % u, 0n, `${tag} ${k}: قيمة الحالة`);
        if (s.lastAvg) assert.ok(s.lastAvg.valueMilli > 0n && s.lastAvg.qtyU > 0, `${tag} ${k}: آخر متوسّط`);
        assert.ok(!(s.costedQtyU === 0 && s.uncostedQtyU === 0 && s.valueMilli === 0n && s.lastAvg === null), `${tag} ${k}: حالة صفرية باقية`);
      }
      const after = state.locs.get(locStateKey(o.productId, o.location));
      assert.equal(o.qtyAfter, after ? fromQtyU(after.costedQtyU + after.uncostedQtyU) : 0);
      assert.equal(o.valueAfter, after ? after.valueMilli : 0n);
    }

    // (1) انعدام الانجراف لكل (صنف، موقع)
    const keys = new Set([...contribV.keys(), ...state.locs.keys()]);
    for (const k of keys) {
      const s = state.locs.get(k);
      assert.equal(contribV.get(k) ?? 0n, s ? s.valueMilli : 0n, `${tag} ${k}: انجراف القيمة`);
      assert.equal(contribQ.get(k) ?? 0, s ? s.costedQtyU + s.uncostedQtyU : 0, `${tag} ${k}: انجراف الكمية`);
    }
    // ولكل موقع (stateTotals)، ومن سطور الأثر كذلك
    const byLoc = new Map<LocationKey, bigint>();
    for (const [k, v] of contribV) {
      const { location } = splitLocStateKey(k);
      byLoc.set(location, (byLoc.get(location) ?? 0n) + v);
    }
    const totals = stateTotals(state);
    for (const tt of totals) {
      assert.equal(byLoc.get(tt.location) ?? 0n, tt.valueMilli, `${tag} ${tt.location}: Σ اللقطات`);
      assert.equal(invByLoc.get(tt.location) ?? 0n, tt.valueMilli, `${tag} ${tt.location}: Σ سطور المخزون`);
    }
    for (const [loc, v] of byLoc) if (v !== 0n) assert.ok(totals.some((tt) => tt.location === loc), `${tag}: ${loc} مفقود من stateTotals`);

    // (4) الحتمية: replay بأي ترتيب = الطيّ خطوةً خطوة حرفياً
    const r = rng(seed * 31 + 7);
    const full = replay(shuffle(moves, r), cfg);
    assert.deepEqual(full.outputs, outs, `${tag}: replay ≠ الطيّ`);
    assert.deepEqual(full.state, state, `${tag}: حالة replay`);
    // الاستئناف من نقطة عشوائية (حالة + لقطات سابقة)
    const k = Math.floor(r() * (sorted.length + 1));
    const head = replay(shuffle(sorted.slice(0, k), r), cfg);
    const tail = replay(shuffle(sorted.slice(k), r), cfg, { state: head.state, lookup: snapshotLookupOf(head.outputs.map(snapshotRefOf)) });
    assert.deepEqual([...head.outputs, ...tail.outputs], outs, `${tag}: الاستئناف عند ${k}`);
    assert.deepEqual(tail.state, state, `${tag}: حالة الاستئناف`);

    // (5) ثبات تحويل الأساس: الوارد نفسه بالكراتين
    for (let i = 0; i < moves.length; i++) {
      if (moves[i].inValueMilli !== cartons[i].inValueMilli) cartonDiffs++;
    }
    assert.deepEqual(replay(cartons, cfg).outputs, outs, `${tag}: الكراتين ≠ الحبّات`);
  }

  // التغطية: كل نوع وكل تحذير وكل منازل ظهرت فعلاً — فلا تمرّ الخصائص على مسارات لم تُطرق
  for (const k of MOVE_KINDS) assert.ok((kindCount.get(k) ?? 0) >= 200, `النوع ${k} قليل: ${kindCount.get(k) ?? 0}`);
  for (const w of STEP_WARNINGS) assert.ok((warnCount.get(w) ?? 0) >= 20, `التحذير ${w} قليل: ${warnCount.get(w) ?? 0}`);
  assert.deepEqual([...decs].sort(), [0, 1, 2, 3]);
  assert.ok(totalMoves > 40_000, `حركات: ${totalMoves}`);
  assert.ok(fractional > 10_000, `كسرية: ${fractional}`);
  assert.equal(cartonDiffs, 0, 'قيمة سطر الكرتون = قيمة سطر الحبّات');
});
