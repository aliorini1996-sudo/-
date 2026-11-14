/**
 * C3 — الاختبار التفاضلي لمحرّك التكلفة الوحيد (services/costing — «ربط الدفاتر» L3) مقابل المحرّك المجمَّد القائم
 * (services/warehouseCost.valueStock + warehouseStock.composeWarehouse/summarizeVansStock + routes/vanStock.foldStock).
 *
 * لماذا تفاضلي لا أمثلة فقط: المحرّك القائم هو ما تعرضه شاشة «مخزون الشركة» اليوم، وعليه جرى تحويل الرصيد الافتتاحي
 * سنوات. فقبل أن يحلّ الجديد محلّه (L3b — بإذن المالك بعد وثيقة الفروق) يجب أن يُثبت أنه يعطي **المستودع نفسه حرفياً**،
 * وأن كل فرقٍ في السيارات مقصودٌ ومشروح (قرار المالك OD6: متوسّط متحرّك لكل سيارة بدل طبقات LIFO).
 *
 * الأقسام:
 *   ١) كل سيناريو تقييم في tests/warehouse.test.ts — المستودع: الكمية بالميكرو والقيمة = toMilli(stockValue, dec) حرفياً،
 *      عدا ما ينزّل من سيارةٍ حُمّلت بسعرين (طبقات LIFO) فيُثبَّت فرقه بالأرقام.
 *   ٢) مولّد عشوائي حتمي (mulberry32) لـ5,000 تسلسل مستودع-فقط: الكمية متطابقة دائماً، و|فرق القيمة| ضمن ميزانية التقريب.
 *   ٣) فروق السيارات الموثّقة (docs/accounting/costing-avco-van-differences.md) — كل رقم في الوثيقة مُثبَّت هنا.
 *
 * لا قاعدة بيانات: المحرّكان صرفان. الوقت ثابت (لا Date.now) فالنتيجة حتمية.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, applyMove, createCostState, locStateKey, stateTotals } from '../services/costing/stepper';
import { toQtyU } from '../services/costing/math';
import { whItemKey, vanItemKey, saleOutKey, saleCancelKey, returnKey, returnCancelKey, restockToggleKey } from '../services/costing/keys';
import { glImpactOf } from '../services/costing/accounts';
import {
  vanLocation, WH_LOCATION,
  type CostState, type LocState, type LocationKey, type Move, type StepOutput, type SnapshotLookup,
} from '../services/costing/types';
import { toMilli, unitMilli } from '../services/gl/money';
import { valueStock, unitCostPerBase, netUnitCost, type CostMove, type VanLayer } from '../services/warehouseCost';
import { composeWarehouse, summarizeVansStock } from '../services/warehouseStock';
import { foldStock, bucketRemaining, type LoadRow, type InvRow } from '../routes/vanStock';
import { loadMoves, type CostingDb } from '../services/costing/streams';
import { CostingFakeDb, asPrisma } from './costing-fake-db';

// ════════════════════════════════════════════════════════════════════════════
// أدوات مشتركة
// ════════════════════════════════════════════════════════════════════════════

/** لحظة البدء الثابتة — كل حركة بعدها بدقيقة × ترتيبها (الترتيب = ترتيب المحرّكين معاً) */
const T0 = Date.UTC(2026, 0, 1, 6, 0, 0);
const at = (k: number) => new Date(T0 + k * 60_000);
const NO_LOOKUP: SnapshotLookup = { get: () => undefined };
const EMPTY_LOC: LocState = { costedQtyU: 0, uncostedQtyU: 0, valueMilli: 0n, lastAvg: null };
const locOf = (s: CostState, pid: string, loc: LocationKey): LocState => s.locs.get(locStateKey(pid, loc)) ?? EMPTY_LOC;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ════════════════════════════════════════════════════════════════════════════
// المحوِّل: مدخلات المحرّك القائم ⇒ حركات المحرّك الجديد (مرآة §6.1 من العقد للمستودع والسيارات)
// ════════════════════════════════════════════════════════════════════════════
//
// المدخلات بشكل composeWarehouse حرفياً (الكمية بالأساس، والتكلفة لوحدة الأساس كما يحوّلها loadWarehouseInputs)،
// فالمحرّكان يقرآن الصفوف نفسها. والترتيب ترتيب composeWarehouse: (at ثم ترتيب الورود: المستودع أولاً ثم السيارات).

interface WhIn {
  productId: string; qty: number; type: string; unitCost?: number | null; at?: number;
  /** قيمة السطر كما في الفاتورة (كمية السطر × تكلفة وحدته) — حين يختلف السطر عن الأساس (الكرتون) */
  line?: { qty: number; unitCost: number };
  zeroRun?: boolean;
}
interface VanIn { productId: string; qty: number; type: string; salesRepId?: string | null; at?: number }

/** ترتيب composeWarehouse: لحظة الحركة ثم ترتيب ورودها (المستودع ثم السيارات) — فرزٌ مستقرّ */
function orderInputs(wh: readonly WhIn[], van: readonly VanIn[]): ({ src: 'WH'; it: WhIn } | { src: 'VAN'; it: VanIn })[] {
  const all = [
    ...wh.map((it, i) => ({ src: 'WH' as const, it, t: it.at ?? 0, i })),
    ...van.map((it, i) => ({ src: 'VAN' as const, it, t: it.at ?? 0, i: wh.length + i })),
  ];
  all.sort((a, b) => a.t - b.t || a.i - b.i);
  return all.map(({ src, it }) => ({ src, it }) as { src: 'WH'; it: WhIn } | { src: 'VAN'; it: VanIn });
}

/** صفّ مستودع ⇒ حركة (§6.1): RECEIVE موجب بقيمة السطر، RECEIVE سالب ⇒ WH_ADJUST، RETURN ⇒ VENDOR_RETURN، ADJUST ⇒ WH_ADJUST/ZERO_RUN */
function whMove(it: WhIn, k: number, dec: number): Move | null {
  if (!Number.isFinite(it.qty) || it.qty === 0) return null; // المحرّك القائم يتخطّى الصفر كذلك
  const id = `w${String(k).padStart(6, '0')}`;
  const base = {
    key: whItemKey(id), effectAt: at(k), cursor: { createdAt: at(k), id }, productId: it.productId,
    location: WH_LOCATION, refType: 'WH_ENTRY' as const, refId: `e-${id}`, itemId: id,
  };
  if (it.type === 'RECEIVE') {
    if (it.qty < 0) return { ...base, kind: 'WH_ADJUST', baseQty: it.qty };
    const priced = it.unitCost != null && Number.isFinite(it.unitCost) && it.unitCost > 0;
    const lineValue = it.line ? it.line.qty * it.line.unitCost : it.qty * (it.unitCost ?? 0);
    return { ...base, kind: 'RECEIVE', baseQty: it.qty, inValueMilli: priced ? toMilli(lineValue, dec) : null };
  }
  if (it.type === 'RETURN') return { ...base, kind: 'VENDOR_RETURN', baseQty: -Math.abs(it.qty) };
  return { ...base, kind: it.zeroRun ? 'ZERO_RUN' : 'WH_ADJUST', baseQty: it.qty };
}

/** صفّ سيارة ⇒ حركة (§6.1): LOAD موجب/UNLOAD سالب ⇒ VAN_LOAD، UNLOAD موجب/LOAD سالب ⇒ VAN_UNLOAD، ADJUST ⇒ VAN_ADJUST */
function vanMove(it: VanIn, k: number): Move | null {
  if (!Number.isFinite(it.qty)) return null;
  const id = `v${String(k).padStart(6, '0')}`;
  const V = vanLocation(it.salesRepId ?? null);
  const base = {
    key: vanItemKey(id), effectAt: at(k), cursor: { createdAt: at(k), id }, productId: it.productId,
    refType: 'VAN_LOAD' as const, refId: `l-${id}`, itemId: id,
  };
  const q = Math.abs(it.qty);
  if (it.type === 'LOAD' || it.type === 'UNLOAD') {
    if (it.qty === 0) return null;
    const toVan = (it.type === 'LOAD') === (it.qty > 0);
    return toVan
      ? { ...base, kind: 'VAN_LOAD', location: WH_LOCATION, toLocation: V, baseQty: -q }
      : { ...base, kind: 'VAN_UNLOAD', location: V, toLocation: WH_LOCATION, baseQty: -q };
  }
  if (it.type === 'DAMAGED_OUT' || it.type === 'EXPIRED_OUT') return { ...base, kind: 'DAMAGE_OUT', location: V, baseQty: 0, reason: it.type };
  if (it.qty === 0) return null;
  return { ...base, kind: 'VAN_ADJUST', location: V, baseQty: it.qty };
}

function movesFromInputs(wh: readonly WhIn[], van: readonly VanIn[], dec: number): Move[] {
  const out: Move[] = [];
  orderInputs(wh, van).forEach((r, k) => {
    const m = r.src === 'WH' ? whMove(r.it, k, dec) : vanMove(r.it, k);
    if (m) out.push(m);
  });
  return out;
}

/** سلسلة valueStock (CostMove) ⇒ مدخلات composeWarehouse بالترتيب نفسه (at = الفهرس) */
function inputsFromCostMoves(pid: string, list: readonly CostMove[]): { wh: WhIn[]; van: VanIn[] } {
  const wh: WhIn[] = [];
  const van: VanIn[] = [];
  list.forEach((m, k) => {
    if (m.kind === 'RECEIVE') wh.push({ productId: pid, qty: m.qty, type: 'RECEIVE', unitCost: m.unitCost ?? null, at: k });
    else if (m.kind === 'OTHER') wh.push({ productId: pid, qty: m.qty, type: 'ADJUST', at: k });
    else if (m.kind === 'VAN_OUT') van.push({ productId: pid, qty: -m.qty, type: 'LOAD', salesRepId: m.vanId ?? null, at: k });
    else van.push({ productId: pid, qty: m.qty, type: 'UNLOAD', salesRepId: m.vanId ?? null, at: k });
  });
  return { wh, van };
}

/** حالة المستودع في المحرّك الجديد لصنف */
function newWarehouse(moves: readonly Move[], dec: number, pid: string) {
  const r = replay(moves, { currencyDecimals: dec });
  const s = locOf(r.state, pid, WH_LOCATION);
  return { qtyU: s.costedQtyU + s.uncostedQtyU, costedQtyU: s.costedQtyU, uncostedQtyU: s.uncostedQtyU, valueMilli: s.valueMilli, result: r };
}

// ════════════════════════════════════════════════════════════════════════════
// ١) كل سيناريو تقييم في tests/warehouse.test.ts — المستودع حرفياً
// ════════════════════════════════════════════════════════════════════════════

interface WhScenario {
  /** اسم الاختبار في warehouse.test.ts (وسطره) */
  name: string;
  dec?: number;
  /** سلسلة valueStock مباشرة (صنف واحد 'a') */
  cost?: CostMove[];
  /** أو مدخلات composeWarehouse (أصناف متعددة) */
  compose?: { wh: WhIn[]; van: VanIn[] };
  /**
   * فرقٌ معروف مُثبَّت بالأرقام (الوثيقة §2): قيمة الجديد لكل صنف، وقيمة القديم كما يكتبها warehouse.test.ts نفسه.
   * الكمية تبقى متطابقة حرفياً دائماً.
   */
  known?: Record<string, { old: bigint; neu: bigint; why: string }>;
  /** تقسيم الدلوين يختلف عمداً (سطرٌ قيمته دون نصف وحدة عملة — §3.3) والقيمة واحدة */
  splitDiffers?: boolean;
}

const PROD = [
  { id: 'a', name: 'صنف أ', code: 'A', unit: 'كرتون' },
  { id: 'b', name: 'صنف ب', code: 'B', unit: 'كرتون' },
];

/** التسلسلات الحقيقية المجهَّلة من warehouse.test.ts:588 حرفياً (بيانات اختبار — تُنسخ لأن ملف الاختبار لا يُصدِّر) */
const REAL: Record<string, string> = {
  P1: `
    La510 La20 Lb70 Lb30 Lb30 Lb20 Lb4 Lb20 A1212 R20 R10 Lb10 R20 Lb20 R12 R30 Lb10 R30 R8 Lb8 R20 R16
    Lb16 A20 R10 Lb10 R20 R100 Lb10 La10 R100 Lb16 R16 Lb20 La32 La12 La2 Lb22 La20 La8 La34 R22@90 Lb22
    R10@90 Lb10 La14 Lb30 R30@78.2609 La20 R20@73.0435 R40@72 La10 Lb30 A-16 R10@73.0435 La10
    R60@73.0435 R10@70.4348 Lb30 La40 R100@70.4348 Lb30 Lb30 La8 La4 La4
  `,
  P2: `
    La30 Lb20 Lb20 A150 R20 Lb2 R30 Lb30 R28 Lb10 R10 R40 Lb20 R20 R10 Lb10 Lb10 R20 R20 Lb20 R10 R10 R40
    Lb10 R10 Lb10 R20 R4 Lb4 A16 R30 Lb30 R10 R100 A80 A-160 R28 R30@87 Lb30 A-28 Lb20 R20@87 R20@87
    Lb20 Lb20 R20@75.6522 La10 R10@73.0435 La2 R100@70.4348 Lb14 La24 Lb30 R60@70.4348 La30 La24 Lb10
    La4 La2 R60@70.4348 R20@67.8261 Lb24 La6 Lb10 La28 Lb16 R40@70.4348 Lb20 La20 R60@67.8261 La20
    Lb40
  `,
  P3: `
    La4 Lb20 Lb20 A66 R12 Lb2 R20 Lb20 R20 Lb20 R20 Lb20 R10 Lb10 R10 Lb10 A6 R2 Lb2 R30 Lb30 R80 R20
    Lb40 R100 Lb36 Lb40 La8 La2 La2 Lb40 La4 Lb26 Lb20 Lb40 R40@73.0435 La10 R30@73.0435
    R100@70.4348 Lb30 R50@70.4348 Lb30 R30@67.8261 A-2 Ub2 La22 Lb20 Lb14 La20 Lb18 R26@65.2174
    Lb26 Ub2
  `,
};

function realInputs(codes: readonly string[]): { wh: WhIn[]; van: VanIn[] } {
  const wh: WhIn[] = [];
  const van: VanIn[] = [];
  for (const code of codes) {
    REAL[code].trim().split(/\s+/).forEach((tok, k) => {
      const t = k + 1;
      const kind = tok[0];
      const rest = tok.slice(1);
      if (kind === 'R') {
        const [q, c] = rest.split('@');
        wh.push({ productId: code, qty: Number(q), type: 'RECEIVE', unitCost: c ? Number(c) : null, at: t });
      } else if (kind === 'A') {
        wh.push({ productId: code, qty: Number(rest), type: 'ADJUST', at: t });
      } else {
        van.push({ productId: code, qty: Number(rest.slice(1)), type: kind === 'L' ? 'LOAD' : 'UNLOAD', salesRepId: rest[0], at: t });
      }
    });
  }
  return { wh, van };
}

/** كل سيناريو تقييم في warehouse.test.ts عدا: (L186) و(REAL P3) — تنزيلٌ من طبقات بسعرين — و(L376) خانات فاسدة (المحرّك الجديد يرفضها صراحةً) */
const WAREHOUSE_SCENARIOS: WhScenario[] = [
  { name: 'L17 الرصيد = الوارد − المحمل + العائد', compose: { wh: [{ productId: 'a', qty: 100, type: 'RECEIVE' }], van: [{ productId: 'a', qty: 30, type: 'LOAD' }, { productId: 'a', qty: 5, type: 'UNLOAD' }] } },
  { name: 'L33 تسوية المستودع ± وتسوية السيارة لا تمسّه', compose: { wh: [{ productId: 'a', qty: 50, type: 'RECEIVE' }, { productId: 'a', qty: -4, type: 'ADJUST' }], van: [{ productId: 'a', qty: 999, type: 'ADJUST' }] } },
  { name: 'L51 رصيد سالب', compose: { wh: [{ productId: 'a', qty: 10, type: 'RECEIVE' }], van: [{ productId: 'a', qty: 25, type: 'LOAD' }] } },
  { name: 'L56 صنفان', compose: { wh: [{ productId: 'a', qty: 5, type: 'RECEIVE' }, { productId: 'b', qty: 40, type: 'RECEIVE' }], van: [] } },
  { name: 'L93 بلا تكلفة خارج القيمة', cost: [{ qty: 10000, kind: 'RECEIVE' }, { qty: 10, kind: 'RECEIVE', unitCost: 12 }] },
  { name: 'L105 كله بلا تكلفة', cost: [{ qty: 20, kind: 'RECEIVE' }] },
  { name: 'L115 الطبقة المستهلكة تخرج من المتوسّط', cost: [{ qty: 1000, kind: 'RECEIVE', unitCost: 10 }, { qty: -1000, kind: 'OTHER' }, { qty: 1000, kind: 'RECEIVE', unitCost: 20 }] },
  { name: 'L127 مرتّب', cost: [{ qty: 1000, kind: 'RECEIVE', unitCost: 10 }, { qty: -1000, kind: 'OTHER' }, { qty: 1000, kind: 'RECEIVE', unitCost: 20 }] },
  { name: 'L127 مقلوب', cost: [{ qty: 1000, kind: 'RECEIVE', unitCost: 10 }, { qty: 1000, kind: 'RECEIVE', unitCost: 20 }, { qty: -1000, kind: 'OTHER' }] },
  { name: 'L142 مرجّح بالكمية', cost: [{ qty: 1000, kind: 'RECEIVE', unitCost: 1 }, { qty: 10, kind: 'RECEIVE', unitCost: 2 }] },
  { name: 'L150 الصرف ينقص الدلوين بنسبتهما', cost: [{ qty: 100, kind: 'RECEIVE' }, { qty: 100, kind: 'RECEIVE', unitCost: 10 }, { qty: -100, kind: 'OTHER' }] },
  { name: 'L163 العائد بلا شراء بينهما', cost: [{ qty: 100, kind: 'RECEIVE', unitCost: 4 }, { qty: -30, kind: 'VAN_OUT' }, { qty: 10, kind: 'VAN_IN' }] },
  { name: 'L174 العائد بكلفة خروجه', cost: [{ qty: 100, kind: 'RECEIVE', unitCost: 10 }, { qty: -50, kind: 'VAN_OUT' }, { qty: 100, kind: 'RECEIVE', unitCost: 20 }, { qty: 50, kind: 'VAN_IN' }] },
  { name: 'L199 ما خرج بلا كلفة يعود بلا كلفة', cost: [{ qty: 100, kind: 'RECEIVE' }, { qty: -50, kind: 'VAN_OUT' }, { qty: 100, kind: 'RECEIVE', unitCost: 20 }, { qty: 50, kind: 'VAN_IN' }] },
  { name: 'L212 التحميل المكشوف يعود بما خُصم به', cost: [{ qty: 10, kind: 'RECEIVE', unitCost: 2 }, { qty: -25, kind: 'VAN_OUT' }, { qty: 25, kind: 'VAN_IN' }] },
  { name: 'L223 عودة بلا تحميل بمتوسّط اللحظة', cost: [{ qty: 100, kind: 'RECEIVE', unitCost: 4 }, { qty: 10, kind: 'VAN_IN' }] },
  { name: 'L233 تسوية بلا ثمن بالمتوسّط', cost: [{ qty: 100, kind: 'RECEIVE', unitCost: 4 }, { qty: 10, kind: 'OTHER' }] },
  { name: 'L242 الرصيد السالب يقيَّم سالباً', cost: [{ qty: 10, kind: 'RECEIVE', unitCost: 2 }, { qty: -25, kind: 'OTHER' }] },
  {
    name: 'L253 الترتيب الزمني عبر composeWarehouse',
    compose: {
      wh: [
        { productId: 'a', qty: 1000, type: 'RECEIVE', unitCost: 20, at: Date.parse('2026-02-01') },
        { productId: 'a', qty: 1000, type: 'RECEIVE', unitCost: 10, at: Date.parse('2026-01-01') },
      ],
      van: [{ productId: 'a', qty: 1000, type: 'LOAD', at: Date.parse('2026-01-15') }],
    },
  },
  { name: 'L269 لكل سيارة مكدّسها', cost: [{ qty: 100, kind: 'RECEIVE', unitCost: 10 }, { qty: -100, kind: 'VAN_OUT', vanId: 'repA' }, { qty: 100, kind: 'RECEIVE', unitCost: 30 }, { qty: -40, kind: 'VAN_OUT', vanId: 'repB' }, { qty: 100, kind: 'VAN_IN', vanId: 'repA' }] },
  { name: 'L282 مكدّس السيارة لا يعبر حدّ الدلوين', cost: [{ qty: 100, kind: 'RECEIVE' }, { qty: -100, kind: 'VAN_OUT', vanId: 'repA' }, { qty: 100, kind: 'RECEIVE', unitCost: 20 }, { qty: -100, kind: 'VAN_OUT', vanId: 'repB' }, { qty: 100, kind: 'VAN_IN', vanId: 'repA' }] },
  {
    name: 'L295 عزل السيارات عبر المسار الكامل',
    compose: {
      wh: [{ productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 10, at: 1 }, { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 30, at: 3 }],
      van: [{ productId: 'a', qty: 100, type: 'LOAD', salesRepId: 'repA', at: 2 }, { productId: 'a', qty: 40, type: 'LOAD', salesRepId: 'repB', at: 4 }, { productId: 'a', qty: 100, type: 'UNLOAD', salesRepId: 'repA', at: 5 }],
    },
  },
  {
    name: 'L314 كلفة العائد عبر المسار الكامل',
    compose: {
      wh: [{ productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 10, at: 1 }, { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 20, at: 3 }],
      van: [{ productId: 'a', qty: 50, type: 'LOAD', at: 2 }, { productId: 'a', qty: 50, type: 'UNLOAD', at: 4 }],
    },
  },
  { name: 'L332 صنف نصفه مسعّر', compose: { wh: [{ productId: 'a', qty: 10000, type: 'RECEIVE', at: 1 }, { productId: 'a', qty: 10, type: 'RECEIVE', unitCost: 12, at: 2 }], van: [] } },
  { name: 'L350 الدينار بثلاث خانات', dec: 3, cost: [{ qty: 250, kind: 'RECEIVE', unitCost: 4.1235 }] },
  { name: 'L350 الدينار بخانتين', dec: 2, cost: [{ qty: 250, kind: 'RECEIVE', unitCost: 4.1235 }] },
  // 0.495 بلا كسور ⇒ toMilli = 0 ⇒ الجديد «بلا سعر» (§3.3) — والقيمة صفر في الاثنين كما يعلن الاختبار القديم
  { name: 'L367 عملة بلا كسور', dec: 0, cost: [{ qty: 3, kind: 'RECEIVE', unitCost: 0.165 }], splitDiffers: true },
  { name: 'L367 بخانتين', dec: 2, cost: [{ qty: 3, kind: 'RECEIVE', unitCost: 0.165 }] },
  { name: 'L367 بثلاث', dec: 3, cost: [{ qty: 3, kind: 'RECEIVE', unitCost: 0.165 }] },
  ...[0, 2, 3].map((dec): WhScenario => ({ name: `L383 الخانات تمسّ القيمة وحدها (${dec})`, dec, cost: [{ qty: 3, kind: 'RECEIVE', unitCost: 1 / 3 }, { qty: 0.5, kind: 'OTHER' }] })),
  // بلا كسور 0.3705 ⇒ toMilli = 0 ⇒ الجديد «بلا سعر» (§3.3) والقيمة صفر في الاثنين
  ...[3, 2, 0].map((dec): WhScenario => ({ name: `L420 0.3705 (${dec})`, dec, compose: { wh: [{ productId: 'a', qty: 3, type: 'RECEIVE', unitCost: 0.1235 }], van: [] }, splitDiffers: dec === 0 })),
  { name: 'L461 الحفرة ثم جرد بلا ثمن', cost: [{ qty: -352, kind: 'VAN_OUT', vanId: 'a' }, { qty: 606, kind: 'OTHER' }, { qty: -5, kind: 'VAN_OUT', vanId: 'a' }] },
  { name: 'L472 الحفرة ثم شراء مسعّر', cost: [{ qty: -10, kind: 'VAN_OUT', vanId: 'a' }, { qty: 20, kind: 'RECEIVE', unitCost: 121.7391 }] },
  { name: 'L482 بعد سدّ الجرد ينقص التحميل القيمة', cost: [{ qty: -352, kind: 'VAN_OUT', vanId: 'a' }, { qty: 606, kind: 'OTHER' }, { qty: 10, kind: 'RECEIVE', unitCost: 150 }, { qty: -132, kind: 'VAN_OUT', vanId: 'a' }] },
  { name: 'L495 الحفرة المسعّرة تُعمَّق بسعرها', cost: [{ qty: 10, kind: 'RECEIVE', unitCost: 2 }, { qty: -25, kind: 'VAN_OUT', vanId: 'a' }, { qty: -5, kind: 'OTHER' }, { qty: 30, kind: 'RECEIVE', unitCost: 3 }] },
  { name: 'L507 مكشوف بلا متوسّط يعود غير مقيَّم', cost: [{ qty: -10, kind: 'VAN_OUT', vanId: 'a' }, { qty: 20, kind: 'RECEIVE', unitCost: 10 }, { qty: 10, kind: 'VAN_IN', vanId: 'a' }] },
  { name: 'L519 مختلط الدلوين ذهاباً وإياباً', cost: [{ qty: 100, kind: 'RECEIVE' }, { qty: 100, kind: 'RECEIVE', unitCost: 10 }, { qty: -250, kind: 'VAN_OUT', vanId: 'a' }, { qty: 250, kind: 'VAN_IN', vanId: 'a' }] },
  {
    name: 'L536 سدّ الحفرة بالضبط (الجزء الأول)',
    cost: [
      { qty: 5, kind: 'RECEIVE' }, { qty: 2, kind: 'RECEIVE', unitCost: 10 },
      { qty: -6, kind: 'VAN_OUT', vanId: 'a' }, { qty: -2, kind: 'VAN_OUT', vanId: 'b' },
      { qty: 1, kind: 'RECEIVE', unitCost: 117.3913 },
    ],
  },
  { name: 'L554 مكشوف على مستودع فارغ — سند واحد', cost: [{ qty: 10, kind: 'RECEIVE', unitCost: 5 }, { qty: -15, kind: 'VAN_OUT', vanId: 'a' }, { qty: 20, kind: 'RECEIVE', unitCost: 6 }, { qty: 5, kind: 'VAN_IN', vanId: 'a' }] },
  { name: 'L554 مكشوف على مستودع فارغ — سندان', cost: [{ qty: 10, kind: 'RECEIVE', unitCost: 5 }, { qty: -10, kind: 'VAN_OUT', vanId: 'a' }, { qty: -5, kind: 'VAN_OUT', vanId: 'a' }, { qty: 20, kind: 'RECEIVE', unitCost: 6 }, { qty: 5, kind: 'VAN_IN', vanId: 'a' }] },
  { name: 'L570 آخر رصيد بلا سعر يبقى بلا قيمة', cost: [{ qty: 10, kind: 'RECEIVE', unitCost: 5 }, { qty: -10, kind: 'VAN_OUT', vanId: 'a' }, { qty: 3, kind: 'RECEIVE' }, { qty: -3, kind: 'VAN_OUT', vanId: 'a' }, { qty: -5, kind: 'VAN_OUT', vanId: 'a' }] },
  {
    // بلا تنزيل — لكن ٢٥ صرفاً جزئياً بكسور الدلوين (C 240.78389 من 674) يُقرَّب كلٌّ منها إلى الهللة، والقديم بالطفو ثم تقريبٌ
    // واحد: يتراكم +0.011 في P1 و+0.007 في P2 فيعبران نصف الهللة (الوثيقة §2.3)
    name: 'L636 تسلسل حقيقي P1 وP2 (بلا تنزيل)', compose: realInputs(['P1', 'P2']),
    known: {
      P1: { old: 17_762_260n, neu: 17_762_270n, why: 'تراكم تقريب ٢٥ صرفاً جزئياً (+0.011)' },
      P2: { old: 16_177_690n, neu: 16_177_700n, why: 'تراكم تقريب الصرف الجزئي (+0.007)' },
    },
  },
  {
    name: 'L690 المستودع في سيناريو بطاقة السيارات',
    compose: {
      wh: [{ productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 10, at: 1 }, { productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 20, at: 3 }],
      van: [{ productId: 'a', qty: 50, type: 'LOAD', salesRepId: 'A', at: 2 }, { productId: 'a', qty: 60, type: 'LOAD', salesRepId: 'A', at: 4 }, { productId: 'a', qty: 10, type: 'LOAD', salesRepId: 'B', at: 5 }],
    },
  },
  { name: 'L737 المخزون في تاريخ (قبل)', compose: { wh: [{ productId: 'a', qty: 10, type: 'RECEIVE', unitCost: 5, at: 1 }], van: [{ productId: 'a', qty: 4, type: 'LOAD', salesRepId: 'A', at: 2 }] } },
  { name: 'L737 المخزون في تاريخ (بعد)', compose: { wh: [{ productId: 'a', qty: 10, type: 'RECEIVE', unitCost: 5, at: 1 }, { productId: 'a', qty: 10, type: 'RECEIVE', unitCost: 9, at: 5 }], van: [{ productId: 'a', qty: 4, type: 'LOAD', salesRepId: 'A', at: 2 }] } },
  { name: 'L750 الصنف المعطّل يُقيَّم', compose: { wh: [{ productId: 'a', qty: 10, type: 'RECEIVE', unitCost: 5, at: 1 }], van: [] } },
  {
    name: 'L770 الوحدات: ألف كرتون بعشرة بالأساس',
    compose: { wh: [{ productId: 'a', qty: 24000, type: 'RECEIVE', unitCost: unitCostPerBase(10, { unitFactor: 24 }), line: { qty: 1000, unitCost: 10 } }], van: [] },
  },
  { name: 'L770 الوحدات: التكلفة المقرّبة قبل الضرب', compose: { wh: [{ productId: 'a', qty: 24000, type: 'RECEIVE', unitCost: netUnitCost(10 / 24, 0, false) }], van: [] } },
  {
    name: 'L788 الوحدات: تحميل بالكرتون وتنزيل بالحبّة',
    compose: {
      wh: [
        { productId: 'a', qty: 240, type: 'RECEIVE', unitCost: unitCostPerBase(120, { unitFactor: 24 }), line: { qty: 10, unitCost: 120 }, at: 1 },
        { productId: 'a', qty: 240, type: 'RECEIVE', unitCost: 9, at: 3 },
      ],
      van: [{ productId: 'a', qty: 24, type: 'LOAD', salesRepId: 'A', at: 2 }, { productId: 'a', qty: 24, type: 'UNLOAD', salesRepId: 'A', at: 4 }],
    },
  },
];

/** يقيّم سيناريو بالمحرّكين: لكل صنف (الكمية بالميكرو، القيمة بالملّي، والدلوان) */
function bothEngines(sc: WhScenario) {
  const dec = sc.dec ?? 2;
  const pids = sc.cost ? ['a'] : [...new Set([...sc.compose!.wh.map((i) => i.productId), ...sc.compose!.van.map((i) => i.productId)])];
  const inputs = sc.cost ? inputsFromCostMoves('a', sc.cost) : sc.compose!;
  const moves = movesFromInputs(inputs.wh, inputs.van, dec);
  const r = replay(moves, { currencyDecimals: dec });
  const out: { pid: string; old: { qtyU: number; valueMilli: bigint; costedQty: number; uncostedQty: number }; neu: LocState }[] = [];
  if (sc.cost) {
    // valueStock مباشرةً — النداء الحرفي في warehouse.test.ts — والكمية Σ الحركات (كلها حركات مستودع في هذه الصيغة)
    const v = valueStock(sc.cost, dec);
    const qty = sc.cost.reduce((s, m) => s + (Number.isFinite(m.qty) ? m.qty : 0), 0);
    out.push({ pid: 'a', old: { qtyU: toQtyU(qty), valueMilli: toMilli(v.stockValue, dec), costedQty: v.costedQty, uncostedQty: v.uncostedQty }, neu: locOf(r.state, 'a', WH_LOCATION) });
  } else {
    const products = pids.map((id) => ({ id, name: id, code: id, unit: 'u' }));
    const rows = composeWarehouse(products, inputs.wh, inputs.van, dec);
    for (const pid of pids) {
      const row = rows.find((x) => x.productId === pid)!;
      out.push({ pid, old: { qtyU: toQtyU(row.onHand), valueMilli: toMilli(row.stockValue, dec), costedQty: row.costedQty, uncostedQty: row.uncostedQty }, neu: locOf(r.state, pid, WH_LOCATION) });
    }
  }
  return { dec, out, result: r };
}

test('تفاضلي المستودع: كل سيناريو تقييم في warehouse.test.ts — الكمية بالميكرو والقيمة = toMilli(stockValue) حرفياً', () => {
  let compared = 0, exact = 0;
  for (const sc of WAREHOUSE_SCENARIOS) {
    const { out, dec } = bothEngines(sc);
    for (const { pid, old, neu } of out) {
      compared++;
      const qtyU = neu.costedQtyU + neu.uncostedQtyU;
      assert.equal(qtyU, old.qtyU, `${sc.name} [${pid}]: الكمية`);
      const known = sc.known?.[pid];
      if (known) {
        // الفرق المعروف مُثبَّت من الجهتين: القديم كما يكتبه warehouse.test.ts، والجديد برقمه، والفرق وحدة عملة واحدة
        assert.equal(old.valueMilli, known.old, `${sc.name} [${pid}]: القديم`);
        assert.equal(neu.valueMilli, known.neu, `${sc.name} [${pid}]: الجديد (${known.why})`);
        const d = neu.valueMilli - old.valueMilli;
        assert.ok((d < 0n ? -d : d) <= unitMilli(dec), `${sc.name} [${pid}]: فرق التقريب ${d} > وحدة`);
      } else {
        exact++;
        assert.equal(neu.valueMilli, old.valueMilli, `${sc.name} [${pid}]: القيمة ${neu.valueMilli} ≠ ${old.valueMilli}`);
      }
      // الدلوان أيضاً (بخانات الكمية الأربع في المحرّك القائم): التقسيم بين المقيَّم وخارج التقييم هو نفسه
      if (sc.splitDiffers) continue;
      assert.ok(Math.abs(neu.costedQtyU / 1e6 - old.costedQty) <= 1e-4, `${sc.name} [${pid}]: المقيَّم ${neu.costedQtyU / 1e6} ≠ ${old.costedQty}`);
      assert.ok(Math.abs(neu.uncostedQtyU / 1e6 - old.uncostedQty) <= 1e-4, `${sc.name} [${pid}]: خارج التقييم ${neu.uncostedQtyU / 1e6} ≠ ${old.uncostedQty}`);
    }
  }
  assert.ok(compared >= 50, `غطّى ${compared} مقارنة`);
  console.log(`C3_WAREHOUSE_SCENARIOS ${JSON.stringify({ scenarios: WAREHOUSE_SCENARIOS.length, compared, exact, known: compared - exact })}`);
});

test('تفاضلي المستودع: القيم المطلقة المعلنة في warehouse.test.ts تخرج من المحرّك الجديد كما هي', () => {
  // عيّنة من الأرقام المكتوبة في الاختبار القديم نفسه — لا من المحرّك القديم — فالمقارنة لا تعتمد على أنه «صحيح»
  const val = (name: string, pid = 'a') => {
    const sc = WAREHOUSE_SCENARIOS.find((s) => s.name === name)!;
    return bothEngines(sc).out.find((o) => o.pid === pid)!.neu.valueMilli;
  };
  assert.equal(val('L93 بلا تكلفة خارج القيمة'), 120_000n);
  assert.equal(val('L127 مقلوب'), 15_000_000n);
  assert.equal(val('L174 العائد بكلفة خروجه'), 3_000_000n);
  assert.equal(val('L269 لكل سيارة مكدّسها'), 2_800_000n);
  assert.equal(val('L350 الدينار بثلاث خانات'), 1_030_875n);
  assert.equal(val('L350 الدينار بخانتين'), 1_030_880n);
  assert.equal(val('L367 عملة بلا كسور'), 0n);
  assert.equal(val('L472 الحفرة ثم شراء مسعّر'), 1_217_390n);
  assert.equal(val('L554 مكشوف على مستودع فارغ — سندان'), 115_000n);
  assert.equal(val('L770 الوحدات: ألف كرتون بعشرة بالأساس'), 10_000_000n);
  assert.equal(val('L770 الوحدات: التكلفة المقرّبة قبل الضرب'), 10_000_800n);
});

test('تفاضلي المستودع: ثبات تحويل الأساس — الكرتون والحبّة يعطيان القيمة نفسها (§4.7-5)', () => {
  // ٢٤٠ حبّة = ١٠ كراتين × ٢٤ بـ١٢٠ للكرتون؛ تحميل ٢٤ حبّة ثم تنزيلها — بالأساس أو بالسطر سواء
  const mk = (line: boolean) => movesFromInputs([
    { productId: 'a', qty: 240, type: 'RECEIVE', unitCost: 5, ...(line && { line: { qty: 10, unitCost: 120 } }), at: 1 },
    { productId: 'a', qty: 240, type: 'RECEIVE', unitCost: 9, ...(line && { line: { qty: 20, unitCost: 108 } }), at: 3 },
  ], [{ productId: 'a', qty: 24, type: 'LOAD', salesRepId: 'A', at: 2 }, { productId: 'a', qty: 24, type: 'UNLOAD', salesRepId: 'A', at: 4 }], 2);
  const base = replay(mk(false), { currencyDecimals: 2 });
  const line = replay(mk(true), { currencyDecimals: 2 });
  assert.deepEqual(line.outputs.map((o) => [o.valueMilli, o.varianceMilli, o.unitCostE4]), base.outputs.map((o) => [o.valueMilli, o.varianceMilli, o.unitCostE4]));
  assert.equal(locOf(line.state, 'a', WH_LOCATION).valueMilli, 3_360_000n);
});

// ─── الفروق المعروفة في سيناريوهات warehouse.test.ts (مُثبَّتة بالأرقام — الوثيقة §2) ───

test('فرق معروف (L186): تنزيلٌ من سيارةٍ حُمّلت بسعرين — LIFO القديم ١٠٠٠ والمتوسّط الجديد ٧٥٠', () => {
  const cost: CostMove[] = [
    { qty: 100, kind: 'RECEIVE', unitCost: 10 },
    { qty: -100, kind: 'VAN_OUT' },
    { qty: 100, kind: 'RECEIVE', unitCost: 20 },
    { qty: -100, kind: 'VAN_OUT' },
    { qty: 50, kind: 'VAN_IN' },
  ];
  const { out } = bothEngines({ name: 'L186', cost });
  assert.equal(out[0].old.valueMilli, 1_000_000n, 'القديم: العائد من آخر طبقة (٢٠)');
  assert.equal(out[0].neu.valueMilli, 750_000n, 'الجديد: العائد بمتوسّط السيارة (٣٠٠٠ ÷ ٢٠٠ = ١٥)');
  assert.equal(out[0].old.qtyU, out[0].neu.costedQtyU + out[0].neu.uncostedQtyU, 'والكمية واحدة');
});

test('فرق معروف (L636 P3): تسلسل حقيقي بتنزيلين من سيارة حُمّلت بأسعار شتّى', () => {
  const { out } = bothEngines({ name: 'P3', compose: realInputs(['P3']) });
  const p3 = out[0];
  assert.equal(p3.old.valueMilli, 4_686_110n, 'القديم كما في warehouse.test.ts');
  assert.equal(p3.old.qtyU, p3.neu.costedQtyU + p3.neu.uncostedQtyU, 'الكمية متطابقة');
  assert.equal(p3.neu.valueMilli, P3_NEW_VALUE_MILLI, 'الجديد: التنزيلان بمتوسّط سيارة b');
});
/**
 * قيمة P3 في المحرّك الجديد — مُثبَّتة من تشغيلٍ موثَّق (الوثيقة §2.2): سيارة b حُمّلت ٢٠٠ قبل أول وارد مسعَّر فبقي فيها دلوٌ
 * «خارج التقييم» كبير لا يبيعه شيء في هذا التسلسل (مستودع-فقط)، فيعود كل تنزيل 2 بنسبة دلويها (0.26 مقيَّمة + 1.74
 * خارج التقييم) لا بطبقة آخر تحميل (2 مقيَّمتان بـ~73) ⇒ المستودع 66.000951 مقيَّمة + 1.999049 خارجها.
 */
const P3_NEW_VALUE_MILLI = 4_548_070n;

test('فرق معروف (L536 الجزء الثاني): تضخيم التقريب — مكشوفٌ بمتوسّط آخر رصيدٍ صغير مقرَّب', () => {
  // آخر رصيدٍ قائم قبل المكشوف: ٠٫٢٨٥٧١٤ مقيَّمة بقيمة 2.86 (المقرَّبة من 2.857142…)؛ المكشوف ٥ يضخّم فرق
  // التقريب ١٧٫٥ ضعفاً: 2.86 × 5 ÷ 0.285714 = 50.05 بدل 50 بالضبط في الطفو. (الوثيقة §3)
  const cost: CostMove[] = [
    { qty: 5, kind: 'RECEIVE' }, { qty: 2, kind: 'RECEIVE', unitCost: 10 },
    { qty: -6, kind: 'VAN_OUT', vanId: 'a' }, { qty: -2, kind: 'VAN_OUT', vanId: 'b' },
    { qty: 1, kind: 'RECEIVE', unitCost: 117.3913 },
    { qty: -5, kind: 'VAN_OUT', vanId: 'b' },
  ];
  const { out } = bothEngines({ name: 'L536b', cost });
  assert.equal(out[0].old.valueMilli, -50_000n, 'القديم كما في warehouse.test.ts:551');
  assert.equal(out[0].neu.costedQtyU, -5_000_000);
  assert.equal(out[0].neu.valueMilli, -50_050n, 'الجديد: 2860 × 5 ÷ 0.285714 = 50050.05 ⇒ 50.05');
});

test('فرق معروف: سطر واردٍ قيمته دون نصف وحدة عملة يقرؤه الجديد «بلا سعر» والقديم مسعَّراً', () => {
  // ٤٠ حبّة بـ0.0001 = 0.004 ريال ⇒ toMilli(…, 2) = 0 ⇒ inValueMilli = 0 ⇒ دلو «خارج التقييم» في الجديد (§4.6 RECEIVE)،
  // والقديم يُدخلها مقيَّمةً بقيمتها الضئيلة فتجرّ المتوسّط إلى 0.244. التسوية الموجبة بعدها تُقيَّم بمتوسّطين مختلفين.
  const cost: CostMove[] = [
    { qty: 40, kind: 'RECEIVE', unitCost: 0.0001 },
    { qty: 1, kind: 'RECEIVE', unitCost: 10 },
    { qty: 41, kind: 'OTHER' },
  ];
  const { out } = bothEngines({ name: 'sub-unit', cost });
  assert.equal(out[0].old.valueMilli, 20_010n, 'القديم: 82 مقيَّمة بـ20.008');
  assert.equal(out[0].old.costedQty, 82);
  assert.equal(out[0].neu.valueMilli, 420_000n, 'الجديد: 42 مقيَّمة بمتوسّط 10 + 40 خارج التقييم');
  assert.equal(out[0].neu.uncostedQtyU, 40_000_000);
  assert.equal(out[0].old.qtyU, out[0].neu.costedQtyU + out[0].neu.uncostedQtyU);
});

// ════════════════════════════════════════════════════════════════════════════
// ٢) مولّد عشوائي حتمي: 5,000 تسلسل مستودع-فقط
// ════════════════════════════════════════════════════════════════════════════
//
// «مستودع-فقط»: وارد مسعَّر وبلا سعر، تسويات ±، تصفير، مرتجع مورّد، تحميل سيارات، وتنزيلٌ من سيارةٍ حُمّلت **مرّة واحدة**
// (أو لم تُحمَّل قطّ — بضاعة سبقت النظام)؛ أي كل ما يمسّ المستودع عدا التنزيل من سيارةٍ بطبقات مختلفة السعر (فرق OD6 المقصود).
//
// ميزانية التقريب: كل قسمةٍ مقرَّبة في المحرّك الجديد خطأها ≤ نصف وحدة عملة (u/2)، والقديم بالطفو بلا تقريب ثم يقرّب
// القيمة النهائية مرّة. والفرق لا يتجاوز Σ (أنصاف وحدات) — لكن **مضخَّمةً** حين يُقيَّد بمتوسّطٍ محمولِ خطأٍ كميةٌ أكبر من
// كمية ذلك المتوسّط (تسويةٌ موجبة كبيرة على رصيد صغير، أو مكشوفٌ بمتوسّط رصيدٍ صغير — انظر L536 أعلاه). فتُحسب ميزانيتان:
//   • «ساذجة» (عدد أحداث التقريب كما في صيغة العقد ⌈n ÷ 2⌉ × u) — تُعدّ مرّات تجاوزها؛
//   • «مضخَّمة» (كل حدث يحمل ميزانية مصدره × نسبة الكميتين) — حدٌّ صارم يُؤكَّد على كل تسلسل.

interface Budget { B: number; Q: number }

/** ميزانية خطأ قيمة كل موقع بأنصاف الوحدات، تُطوى بجانب المحرّك الجديد حركةً حركة (تقرأ حالته قبل كل حركة) */
class RoundingBudget {
  private B = new Map<string, number>();
  private last = new Map<string, Budget | null>();
  naive = 0;
  /**
   * دلوٌ مقيَّم بكمية موجبة وقيمةٍ قرّبها المحرّك الجديد إلى الصفر (قسمة صغيرة): الجديد «لا متوسّط» فيُدخل التسوية
   * الموجبة خارج التقييم، والقديم بمتوسّطٍ ضئيل فيُدخلها مقيَّمة — يفترق تقسيم الدلوين (والقيمة تبقى ضمن الميزانية).
   */
  splitDiverged = false;

  get(loc: string): number { return this.B.get(loc) ?? 0; }

  /** خروج q (ميكرو) من loc بحالة s — يُرجع ميزانية القيمة الخارجة */
  out(loc: string, s: LocState, q: number, fallback: Budget | null): number {
    let B = this.get(loc);
    const C = s.costedQtyU, total = s.costedQtyU + s.uncostedQtyU;
    if (total > 0) this.last.set(loc, C > 0 ? { B, Q: C } : null);
    // قيمةٌ قرّبها الجديد إلى الصفر وفي ميزانيتها خطأ (B > 0): الجديد بلا متوسّط فينقل المكشوف «خارج التقييم» بصفر،
    // والقديم بمتوسّطٍ ضئيل ≤ B ÷ C فينقله مقيَّماً — القيمة تغطّيها الميزانية، والتقسيم يفترق
    if (B > 0 && s.valueMilli === 0n && q > Math.max(total, 0) && C !== 0) this.splitDiverged = true;
    const rate: Budget | null = C < 0 ? { B, Q: -C }
      : total > 0 ? (C > 0 ? { B, Q: C } : null)
        : (this.last.get(loc) ?? fallback);
    const share = total > 0 ? Math.min(q, total) : 0;
    let outB = 0;
    if (share > 0) {
      if (share === total) { outB = B; B = 0; }
      else {
        const f = share / total;
        outB = B * f + 1; B = B * (1 - f) + 2; // قسمة القيمة + قسمة الكمية بين الدلوين
        this.naive += 2;
      }
    }
    const d = q - share;
    if (d > 0 && rate) {
      const dvB = (rate.B * d) / rate.Q + 1;
      B += dvB; outB += dvB; this.naive += 1;
    }
    this.B.set(loc, B);
    return outB;
  }

  /** دخول (cq مقيَّم بقيمة ميزانيتها cvB، uq خارج التقييم) إلى loc بحالة s */
  in(loc: string, s: LocState, cq: number, cvB: number, uq: number): void {
    let B = this.get(loc);
    const C = s.costedQtyU;
    if (C < 0) {
      this.naive += 2;
      // الحفرة تُسدّ كلّها ⇒ قيمتها تخرج من الموقع كاملةً (إلى الفرق) ولا يبقى إلا باقي الوارد بقسمته
      B = cq + uq >= -C ? cvB + 1 : B + 1;
    } else B += cvB;
    this.B.set(loc, B);
  }

  addAtAvg(loc: string, s: LocState, q: number): void {
    if (s.costedQtyU > 0) {
      if (s.valueMilli <= 0n && this.get(loc) > 0) this.splitDiverged = true;
      this.naive += 1;
      this.in(loc, s, q, (this.get(loc) * q) / s.costedQtyU + 1, 0);
    } else this.in(loc, s, 0, 0, q);
  }

  avgBudget(loc: string, s: LocState): Budget | null {
    return s.costedQtyU > 0 && s.valueMilli > 0n ? { B: this.get(loc), Q: s.costedQtyU } : null;
  }
}

/** يطوي الحركات واحدةً واحدة (applyMove) ويحدّث الميزانية من حالة المحرّك قبل كل حركة */
function foldWithBudget(moves: readonly Move[], dec: number, pid: string): { state: CostState; budget: RoundingBudget; outputs: StepOutput[] } {
  const state = createCostState();
  const budget = new RoundingBudget();
  const outputs: StepOutput[] = [];
  // movesFromInputs يُخرجها بلحظات متزايدة، فترتيب المصفوفة هو ترتيب compareMoves نفسه (ما يفعله replay)
  for (const m of moves) {
    const q = Math.abs(toQtyU(m.baseQty));
    const pre = (loc: LocationKey): LocState => ({ ...locOf(state, pid, loc) });
    const wh = pre(WH_LOCATION);
    switch (m.kind) {
      case 'RECEIVE': {
        if (m.inValueMilli != null && m.inValueMilli > 0n) {
          // قيمة السطر مقرَّبة إلى خانات العملة (toMilli) والقديم يحملها بالطفو — حدثٌ واحد (احتياطاً ولو كانت دقيقة)
          budget.naive += 1;
          budget.in('WH', wh, q, 1, 0);
        } else budget.in('WH', wh, 0, 0, q);
        break;
      }
      case 'WH_ADJUST': case 'ZERO_RUN': case 'VENDOR_RETURN':
        if (m.baseQty < 0) budget.out('WH', wh, q, null);
        else budget.addAtAvg('WH', wh, q);
        break;
      case 'VAN_LOAD': {
        // ميزانية القيمة الخارجة تنتقل مع الحمولة إلى السيارة؛ والدخل يُعامَل بكميته كلها (يكفي لحكم «سُدّت الحفرة كلها»)
        const outB = budget.out('WH', wh, q, null);
        budget.in(m.toLocation!, pre(m.toLocation!), q, outB, 0);
        break;
      }
      case 'VAN_UNLOAD': {
        const src = pre(m.location);
        const outB = budget.out(m.location, src, q, budget.avgBudget('WH', wh));
        budget.in('WH', wh, q, outB, 0);
        break;
      }
      default:
        break; // لا أنواع أخرى في المولّد
    }
    outputs.push(applyMove(state, m, { currencyDecimals: dec }, NO_LOOKUP));
  }
  return { state, budget, outputs };
}

/**
 * تسلسل مستودع-فقط عشوائي حتمي لصنف واحد. «مختلط»: كميات صحيحة وكسرية بثلاث منازل وعملات بصفر ومنزلتين وثلاث؛
 * «صحيح»: كميات صحيحة وحدها (الكرتون والحبّة — أغلب الشركات) بالريال والدينار.
 */
function genWarehouseOnly(rnd: () => number, profile: 'MIXED' | 'INTEGER'): { wh: WhIn[]; van: VanIn[]; dec: number } {
  const dec = profile === 'MIXED' ? [2, 2, 2, 3, 0][Math.floor(rnd() * 5)] : [2, 2, 2, 3][Math.floor(rnd() * 4)];
  const n = 5 + Math.floor(rnd() * 36);
  const wh: WhIn[] = [];
  const van: VanIn[] = [];
  let onHand = 0;
  let vanSeq = 0;
  const open: { id: string; left: number }[] = [];
  const qty = (max: number) => {
    if (profile === 'INTEGER' || rnd() < 0.65) return 1 + Math.floor(rnd() * max);
    return Math.max(0.001, Math.round(rnd() * max * 1000) / 1000);
  };
  const part = (left: number) => (profile === 'INTEGER'
    ? 1 + Math.floor(rnd() * left)
    : Math.max(0.001, Math.round(rnd() * left * 1000) / 1000));
  const price = () => {
    const r = rnd();
    const raw = 0.05 + rnd() * 300;
    return r < 0.3 ? Math.max(1, Math.round(raw)) : r < 0.7 ? Math.round(raw * 100) / 100 : Math.round(raw * 10000) / 10000;
  };
  for (let k = 0; k < n; k++) {
    const r = rnd();
    const t = k + 1;
    if (r < 0.34) {
      const q = qty(120);
      // سطرٌ قيمته دون وحدة عملة يقرؤه الجديد «بلا سعر» (toMilli = 0) والقديم مسعَّراً — فرقٌ موثَّق مستقلّ (الوثيقة §3.3)،
      // فيُرفع السعر هنا حتى تبلغ قيمة السطر وحدة عملة على الأقل
      let c = price();
      const unit = 10 ** -dec;
      if (q * c < unit) c = Math.ceil((unit / q) * 10000) / 10000 + unit;
      wh.push({ productId: 'p', qty: q, type: 'RECEIVE', unitCost: c, at: t }); onHand += q;
    } else if (r < 0.42) {
      const q = qty(120);
      wh.push({ productId: 'p', qty: q, type: 'RECEIVE', unitCost: null, at: t }); onHand += q;
    } else if (r < 0.49) {
      const q = qty(30);
      wh.push({ productId: 'p', qty: q, type: 'ADJUST', at: t }); onHand += q;
    } else if (r < 0.56) {
      const q = qty(40);
      wh.push({ productId: 'p', qty: -q, type: 'ADJUST', at: t }); onHand -= q;
    } else if (r < 0.59) {
      if (Math.abs(onHand) < 1e-9) continue;
      const q = -Math.round(onHand * 1000) / 1000;
      wh.push({ productId: 'p', qty: q, type: 'ADJUST', zeroRun: true, at: t }); onHand += q;
    } else if (r < 0.63) {
      const q = qty(25);
      wh.push({ productId: 'p', qty: -q, type: 'RETURN', at: t }); onHand -= q;
    } else if (r < 0.82) {
      const q = qty(60);
      const id = `g${vanSeq++}`;
      van.push({ productId: 'p', qty: q, type: 'LOAD', salesRepId: id, at: t }); onHand -= q;
      open.push({ id, left: q });
    } else if (r < 0.96) {
      const cand = open.filter((o) => o.left > 1e-9);
      if (!cand.length) continue;
      const o = cand[Math.floor(rnd() * cand.length)];
      const take = Math.min(rnd() < 0.4 ? o.left : part(o.left), o.left);
      van.push({ productId: 'p', qty: take, type: 'UNLOAD', salesRepId: o.id, at: t }); onHand += take;
      o.left = Math.round((o.left - take) * 1000) / 1000;
    } else {
      // تنزيلٌ من سيارةٍ لم تُحمَّل قطّ (بضاعة سبقت النظام): القديم بمتوسّط لحظة المستودع، والجديد بديل السيارة = متوسّط المستودع
      const q = qty(20);
      van.push({ productId: 'p', qty: q, type: 'UNLOAD', salesRepId: `o${vanSeq++}`, at: t }); onHand += q;
    }
  }
  return { wh, van, dec };
}

interface RandomStats {
  profile: string; sequences: number; moves: number;
  /** توزيع |الفرق| بوحدات العملة (مقرَّباً لأعلى) */
  hist: { zero: number; one: number; upTo5: number; upTo50: number; over50: number };
  maxDiffU: number; maxDiffMilli: string; worstSeed: number; worstDec: number;
  /** تسلسلات تجاوز فرقها صيغة العقد الساذجة ⌈أحداث التقريب ÷ 2⌉ × u (كلها تضخيم) */
  naiveExceeded: number;
  /** تسلسلات افترق فيها تقسيم الدلوين (كلها مفسَّرة بقيمةٍ قرّبها الجديد إلى الصفر) */
  splitDiverged: number;
}

/** يشغّل المولّد ويؤكّد على كل تسلسل: الكمية حرفياً، والقيمة ضمن الميزانية المضخَّمة، وكل افتراق تقسيم مفسَّر */
function runRandom(profile: 'MIXED' | 'INTEGER', count: number, salt: number): RandomStats {
  const st: RandomStats = {
    profile, sequences: 0, moves: 0, hist: { zero: 0, one: 0, upTo5: 0, upTo50: 0, over50: 0 },
    maxDiffU: 0, maxDiffMilli: '0', worstSeed: -1, worstDec: -1, naiveExceeded: 0, splitDiverged: 0,
  };
  let worst = -1n;
  for (let seed = 1; seed <= count; seed++) {
    const rnd = mulberry32(salt ^ Math.imul(seed, 2654435761));
    const { wh, van, dec } = genWarehouseOnly(rnd, profile);
    const u = unitMilli(dec);
    const moves = movesFromInputs(wh, van, dec);
    const row = composeWarehouse([{ id: 'p', name: 'p', code: 'p', unit: 'u' }], wh, van, dec)[0];
    const { state, budget } = foldWithBudget(moves, dec, 'p');
    const s = locOf(state, 'p', WH_LOCATION);
    const tag = `${profile} seed ${seed} (dec ${dec})`;

    // الكمية: حرفياً بالميكرو دائماً
    assert.equal(s.costedQtyU + s.uncostedQtyU, toQtyU(row.onHand), `${tag}: الكمية`);
    // الدلوان بخانات الكمية الأربع — وكل افتراقٍ يجب أن يفسّره مسار «القيمة المقرَّبة إلى الصفر» (لا افتراق بلا سبب)
    const splitOff = Math.abs(s.costedQtyU / 1e6 - row.costedQty) > 2e-4;
    if (splitOff) {
      assert.ok(budget.splitDiverged, `${tag}: افترق التقسيم بلا سبب معروف — المقيَّم ${s.costedQtyU / 1e6} ≠ ${row.costedQty}`);
      st.splitDiverged++;
    }

    // القيمة: ضمن الميزانية المضخَّمة (+١ لتقريب القديم النهائي)
    const old = toMilli(row.stockValue, dec);
    const diff = s.valueMilli > old ? s.valueMilli - old : old - s.valueMilli;
    const amplified = BigInt(Math.ceil((budget.get('WH') + 1) / 2)) * u;
    const naive = BigInt(Math.ceil((budget.naive + 1) / 2)) * u;
    assert.ok(diff <= amplified, `${tag}: |${s.valueMilli} − ${old}| = ${diff} > ${amplified}`);

    st.sequences++;
    st.moves += moves.length;
    if (diff > naive) st.naiveExceeded++;
    const dU = Number(diff / u) + (diff % u === 0n ? 0 : 1);
    if (dU === 0) st.hist.zero++;
    else if (dU === 1) st.hist.one++;
    else if (dU <= 5) st.hist.upTo5++;
    else if (dU <= 50) st.hist.upTo50++;
    else st.hist.over50++;
    if (dU > st.maxDiffU || (dU === st.maxDiffU && diff > worst)) {
      st.maxDiffU = dU; worst = diff; st.maxDiffMilli = String(diff); st.worstSeed = seed; st.worstDec = dec;
    }
  }
  return st;
}

test('مولّد عشوائي (5,000 تسلسل مستودع-فقط، مختلط): الكمية متطابقة دائماً، والقيمة ضمن ميزانية التقريب المضخَّمة', () => {
  const st = runRandom('MIXED', 5_000, 0xc3c3);
  console.log(`C3_RANDOM_STATS ${JSON.stringify(st)}`);
  assert.equal(st.sequences, 5_000);
});

test('مولّد عشوائي (5,000 تسلسل مستودع-فقط، كميات صحيحة): الكمية متطابقة، والقيمة ضمن الميزانية المضخَّمة', () => {
  const st = runRandom('INTEGER', 5_000, 0x1d1d);
  console.log(`C3_RANDOM_STATS ${JSON.stringify(st)}`);
  assert.equal(st.sequences, 5_000);
});

// ════════════════════════════════════════════════════════════════════════════
// ٣) فروق السيارات (OD6) — كل رقم في docs/accounting/costing-avco-van-differences.md §4
// ════════════════════════════════════════════════════════════════════════════
//
// «القديم» هنا مسار البطاقة والشاشة حرفياً (routes/warehouse.ts GET /vans): composeWarehouse بطبقاته ومتوسّطه غير المقرَّب،
// وfoldStock للفواتير المؤكَّدة للمناديب الأحياء، وsummarizeVansStock/valueVanQty. و«الجديد» replay بحركات §6.1.

type VOp =
  | { op: 'R'; p?: string; q: number; cost?: number | null }
  | { op: 'A'; p?: string; q: number }
  | { op: 'L' | 'U' | 'VA'; p?: string; q: number; rep: string }
  | { op: 'SALE'; id: string; p?: string; q: number; rep: string | null }
  | { op: 'CANCEL'; id: string }
  | { op: 'RET'; id: string; p?: string; q: number; rep: string | null; of?: string | null; restock: boolean; reason?: 'DAMAGED' | 'EXPIRED' | 'NOT_RESTOCKED' }
  | { op: 'TOGGLE'; id: string; to: boolean }
  | { op: 'RETCANCEL'; id: string }
  | { op: 'DEL'; rep: string };

interface VanEval {
  old: { whValue: bigint; whQtyU: number; cardValue: bigint; cardQty: number; perVan: Record<string, bigint>; deletedVans: number };
  neu: { whValue: bigint; whQtyU: number; vans: Record<string, { qtyU: number; valueMilli: bigint }>; cogsMilli: bigint; writeOffMilli: bigint; varianceMilli: bigint };
  outputs: StepOutput[];
}

function runVan(ops: readonly VOp[], dec = 2): VanEval {
  const pidOf = (o: { p?: string }) => o.p ?? 'a';
  const deleted = new Set(ops.filter((o): o is { op: 'DEL'; rep: string } => o.op === 'DEL').map((o) => o.rep));
  const cancelled = new Set(ops.filter((o): o is { op: 'CANCEL'; id: string } => o.op === 'CANCEL').map((o) => o.id));
  const retCancelled = new Set(ops.filter((o): o is { op: 'RETCANCEL'; id: string } => o.op === 'RETCANCEL').map((o) => o.id));
  const sales = new Map<string, Extract<VOp, { op: 'SALE' }> & { k: number }>();
  const rets = new Map<string, Extract<VOp, { op: 'RET' }> & { k: number }>();
  // حالة returnToStock الحالية لكل مرتجع (آخر تبديل) — القديم يقرأ العمود الحالي
  const restockNow = new Map<string, boolean>();
  ops.forEach((o, k) => {
    if (o.op === 'SALE') sales.set(o.id, { ...o, k });
    if (o.op === 'RET') { rets.set(o.id, { ...o, k }); restockNow.set(o.id, o.restock); }
    if (o.op === 'TOGGLE') restockNow.set(o.id, o.to);
  });
  // المندوب «الحالي» على الفاتورة: يُفرَّغ بالحذف (D14) — قراءة اليوم بعد كل ما حدث
  const repNow = (rep: string | null) => (rep && !deleted.has(rep) ? rep : null);

  // ─── القديم ───
  const products = [...new Set(ops.filter((o) => 'q' in o).map((o) => pidOf(o as { p?: string })))].map((id) => ({ id, name: id, code: id, unit: 'u' }));
  const whItems: WhIn[] = [];
  const vanItems: VanIn[] = [];
  const invByRep = new Map<string, InvRow[]>();
  const loadsByRep = new Map<string, LoadRow[]>();
  ops.forEach((o, k) => {
    if (o.op === 'R') whItems.push({ productId: pidOf(o), qty: o.q, type: 'RECEIVE', unitCost: o.cost ?? null, at: k });
    if (o.op === 'A') whItems.push({ productId: pidOf(o), qty: o.q, type: 'ADJUST', at: k });
    if (o.op === 'L' || o.op === 'U' || o.op === 'VA') {
      const type = o.op === 'L' ? 'LOAD' : o.op === 'U' ? 'UNLOAD' : 'ADJUST';
      vanItems.push({ productId: pidOf(o), qty: o.q, type, salesRepId: o.rep, at: k }); // vanKeyOf: المحذوف بمعرّفه المحفوظ
      if (!deleted.has(o.rep)) {
        const list = loadsByRep.get(o.rep) ?? [];
        list.push({ productId: pidOf(o), qty: o.q, vanLoad: { type, createdAt: at(k) } });
        loadsByRep.set(o.rep, list);
      }
    }
    if ((o.op === 'SALE' && !cancelled.has(o.id)) || (o.op === 'RET' && !retCancelled.has(o.id))) {
      const rep = repNow(o.rep);
      if (!rep) return; // فاتورة بلا مندوب: لا يراها المحرّك القائم أصلاً (لا مستودع ولا سيارة)
      const list = invByRep.get(rep) ?? [];
      const isRet = o.op === 'RET';
      list.push({
        productId: pidOf(o), qty: o.q, returnExpired: isRet && o.reason === 'EXPIRED',
        invoice: {
          type: isRet ? 'RETURN' : 'CASH', returnToStock: isRet ? restockNow.get(o.id)! : null, invoiceDate: at(k),
          returnReason: isRet && o.reason === 'DAMAGED' ? 'DAMAGED' : null, createdAt: at(k),
        },
      });
      invByRep.set(rep, list);
    }
  });
  const layers = new Map<string, Map<string, VanLayer[]>>();
  const rawAvg = new Map<string, number>();
  const rows = composeWarehouse(products, whItems, vanItems, dec, layers, rawAvg);
  const liveReps = [...new Set(ops.flatMap((o) => ('rep' in o && o.rep ? [o.rep] : [])))].filter((r) => !deleted.has(r)).sort();
  const perRep = liveReps.map((repId) => {
    const { bal } = foldStock(loadsByRep.get(repId) ?? [], invByRep.get(repId) ?? []);
    return { repId, products: [...bal].map(([productId, b]) => ({ productId, remaining: bucketRemaining(b), unsellable: Math.max(0, b.damagedIn - b.damagedOut) + Math.max(0, b.expiredIn - b.expiredOut) })) };
  });
  const card = summarizeVansStock(perRep, layers, rawAvg, dec);
  const perVan: Record<string, bigint> = {};
  for (const r of perRep) perVan[r.repId] = toMilli(summarizeVansStock([r], layers, rawAvg, dec).value, dec);
  // سيارات المحذوفين كما يعدّها المسار
  const net = new Map<string, number>();
  for (const v of vanItems) {
    if (!v.salesRepId || !deleted.has(v.salesRepId)) continue;
    const sign = v.type === 'LOAD' || v.type === 'ADJUST' ? 1 : v.type === 'UNLOAD' ? -1 : 0;
    net.set(v.salesRepId, (net.get(v.salesRepId) ?? 0) + sign * v.qty);
  }
  const whRowsValue = rows.reduce((s, r) => s + toMilli(r.stockValue, dec), 0n);
  const whRowsQty = rows.reduce((s, r) => s + toQtyU(r.onHand), 0);

  // ─── الجديد (حركات §6.1 كما يقرؤها loadMoves بعد كل ما حدث: المندوب الحالي على الفاتورة) ───
  const moves: Move[] = [];
  const lastWriteOff = new Map<string, string>(); // مفتاح آخر حركة شطب لكل مرتجع (لـmemoOf)
  const retState = new Map<string, boolean>();    // عائد الآن؟ (لإلغاء المرتجع)
  ops.forEach((o, k) => {
    const id = `x${String(k).padStart(4, '0')}`;
    const cur = { effectAt: at(k), cursor: { createdAt: at(k), id } };
    if (o.op === 'R' || o.op === 'A') {
      const m = whMove(o.op === 'R'
        ? { productId: pidOf(o), qty: o.q, type: 'RECEIVE', unitCost: o.cost ?? null }
        : { productId: pidOf(o), qty: o.q, type: 'ADJUST' }, k, dec);
      if (m) moves.push(m);
    } else if (o.op === 'L' || o.op === 'U' || o.op === 'VA') {
      const m = vanMove({ productId: pidOf(o), qty: o.q, type: o.op === 'L' ? 'LOAD' : o.op === 'U' ? 'UNLOAD' : 'ADJUST', salesRepId: o.rep }, k);
      if (m) moves.push(m);
    } else if (o.op === 'SALE') {
      const rep = repNow(o.rep);
      moves.push({
        ...cur, key: saleOutKey(o.id), kind: rep ? 'VAN_SALE' : 'WAREHOUSE_SALE', productId: pidOf(o),
        location: rep ? vanLocation(rep) : WH_LOCATION, baseQty: -o.q, refType: 'INVOICE', refId: `inv-${o.id}`, itemId: o.id,
      });
    } else if (o.op === 'CANCEL') {
      const s = sales.get(o.id)!;
      const rep = repNow(s.rep);
      moves.push({
        ...cur, key: saleCancelKey(o.id), kind: 'SALE_CANCEL', productId: pidOf(s), location: rep ? vanLocation(rep) : WH_LOCATION,
        baseQty: s.q, links: { mirrorOf: saleOutKey(o.id), locationOf: saleOutKey(o.id) }, refType: 'INVOICE', refId: `inv-${o.id}`, itemId: o.id,
      });
    } else if (o.op === 'RET') {
      const rep = repNow(o.rep);
      const loc = rep ? vanLocation(rep) : WH_LOCATION;
      const mirrorOf = o.of ? saleOutKey(o.of) : null;
      const base = { ...cur, key: returnKey(o.id), productId: pidOf(o), location: loc, refType: 'INVOICE' as const, refId: `ret-${o.id}`, itemId: o.id };
      if (o.restock && !o.reason) {
        moves.push({ ...base, kind: rep ? 'VAN_RETURN_RESTOCK' : 'WAREHOUSE_RETURN_RESTOCK', baseQty: o.q, links: { mirrorOf } });
        retState.set(o.id, true);
      } else {
        moves.push({ ...base, kind: 'RETURN_WRITE_OFF', baseQty: 0, memoQty: o.q, links: { mirrorOf }, reason: o.reason ?? 'NOT_RESTOCKED' });
        retState.set(o.id, false); lastWriteOff.set(o.id, returnKey(o.id));
      }
    } else if (o.op === 'TOGGLE') {
      const r = rets.get(o.id)!;
      const key = restockToggleKey(`log${k}`, o.id);
      moves.push({
        ...cur, key, kind: 'RESTOCK_TOGGLE', productId: pidOf(r), location: repNow(r.rep) ? vanLocation(repNow(r.rep)) : WH_LOCATION,
        baseQty: o.to ? r.q : -r.q,
        links: o.to ? { mirrorOf: r.of ? saleOutKey(r.of) : null, locationOf: returnKey(o.id) } : { mirrorOf: null, locationOf: returnKey(o.id) },
        refType: 'RESTOCK_LOG', refId: `log${k}`, itemId: o.id,
      });
      retState.set(o.id, o.to);
      if (!o.to) lastWriteOff.set(o.id, key);
    } else if (o.op === 'RETCANCEL') {
      const r = rets.get(o.id)!;
      const back = retState.get(o.id)!;
      moves.push({
        ...cur, key: returnCancelKey(o.id), kind: 'RETURN_CANCEL', productId: pidOf(r), location: repNow(r.rep) ? vanLocation(repNow(r.rep)) : WH_LOCATION,
        baseQty: back ? -r.q : 0, links: back ? { mirrorOf: null, locationOf: returnKey(o.id) } : { mirrorOf: null, memoOf: lastWriteOff.get(o.id) ?? null },
        refType: 'INVOICE', refId: `ret-${o.id}`, itemId: o.id,
      });
    }
  });
  const res = replay(moves, { currencyDecimals: dec });
  const vans: Record<string, { qtyU: number; valueMilli: bigint }> = {};
  let whValue = 0n, whQtyU = 0;
  for (const t of stateTotals(res.state)) {
    if (t.location === WH_LOCATION) { whValue += t.valueMilli; whQtyU += toQtyU(t.qtyBase); }
    else vans[t.location] = { qtyU: toQtyU(t.qtyBase), valueMilli: t.valueMilli };
  }
  let cogsMilli = 0n, writeOffMilli = 0n, varianceMilli = 0n;
  for (const o of res.outputs) {
    const g = glImpactOf(o);
    cogsMilli += g.cogsMilli; writeOffMilli += g.writeOffMilli; varianceMilli += o.varianceMilli;
    // كل لقطة متوازنة (§8)
    const inv = g.inventory.reduce((s, x) => s + x.milli, 0n);
    assert.equal(inv + g.cogsMilli + g.writeOffMilli + g.counterMilli, 0n, `لقطة ${o.key} غير متوازنة`);
  }
  return {
    old: { whValue: whRowsValue, whQtyU: whRowsQty, cardValue: toMilli(card.value, dec), cardQty: card.qty, perVan, deletedVans: [...net.values()].filter((q) => q > 1e-9).length },
    neu: { whValue, whQtyU, vans, cogsMilli, writeOffMilli, varianceMilli },
    outputs: res.outputs,
  };
}

/** صون القيمة في الجديد: كل مسعَّرٍ دخل = المستودع + السيارات + تكلفة المبيعات + الشطب (بلا تسويات ولا مرتجع مورّد) */
function assertConservation(e: VanEval, purchasesMilli: bigint, label: string) {
  const vans = Object.values(e.neu.vans).reduce((s, v) => s + v.valueMilli, 0n);
  assert.equal(e.neu.whValue + vans + e.neu.cogsMilli + e.neu.writeOffMilli, purchasesMilli, `${label}: صون القيمة`);
}

/**
 * سيناريوهات فروق السيارات — كل واحد منها جدولٌ في الوثيقة §4 بالرقم نفسه (V1..V11).
 * مشتركة بين اختبارات الأرقام أدناه واختبار المرور بالمصدر الحقيقي (القسم ٤).
 */
const VAN: Record<string, VOp[]> = {
  /** V1 تحميلان بسعرين ثم تنزيل جزئي */
  V1: [{ op: 'R', q: 100, cost: 10 }, { op: 'L', q: 50, rep: 'r1' }, { op: 'R', q: 100, cost: 20 }, { op: 'L', q: 30, rep: 'r1' }, { op: 'U', q: 20, rep: 'r1' }],
  /** V2 بيعٌ ثم تنزيل (V2a قبل التنزيل) */
  V2a: [{ op: 'R', q: 100, cost: 10 }, { op: 'L', q: 60, rep: 'r1' }, { op: 'R', q: 100, cost: 16 }, { op: 'L', q: 40, rep: 'r1' }, { op: 'SALE', id: 's1', q: 70, rep: 'r1' }],
  V2: [{ op: 'R', q: 100, cost: 10 }, { op: 'L', q: 60, rep: 'r1' }, { op: 'R', q: 100, cost: 16 }, { op: 'L', q: 40, rep: 'r1' }, { op: 'SALE', id: 's1', q: 70, rep: 'r1' }, { op: 'U', q: 30, rep: 'r1' }],
  /** V3 مرتجعٌ عائد */
  V3: [{ op: 'R', q: 100, cost: 10 }, { op: 'L', q: 50, rep: 'r1' }, { op: 'R', q: 50, cost: 16 }, { op: 'L', q: 50, rep: 'r1' }, { op: 'SALE', id: 's1', q: 40, rep: 'r1' }, { op: 'RET', id: 't1', q: 10, rep: 'r1', of: 's1', restock: true }],
  /** V4 سيارة مندوبٍ محذوف (V4live: اللقطة قبل الحذف) */
  V4: [{ op: 'R', q: 100, cost: 10 }, { op: 'L', q: 40, rep: 'r2' }, { op: 'SALE', id: 's1', q: 25, rep: 'r2' }, { op: 'DEL', rep: 'r2' }],
  V4live: [{ op: 'R', q: 100, cost: 10 }, { op: 'L', q: 40, rep: 'r2' }, { op: 'SALE', id: 's1', q: 25, rep: 'r2' }],
  /** V5 مكشوف سيارة (V5a لحظة البيع المكشوف) */
  V5a: [{ op: 'R', q: 10, cost: 8 }, { op: 'SALE', id: 's1', q: 4, rep: 'r3' }],
  V5: [{ op: 'R', q: 10, cost: 8 }, { op: 'SALE', id: 's1', q: 4, rep: 'r3' }, { op: 'R', q: 10, cost: 11 }, { op: 'L', q: 10, rep: 'r3' }],
  /** V6 فاتورة الإدارة (OD8) */
  V6: [{ op: 'R', q: 100, cost: 10 }, { op: 'SALE', id: 'a1', q: 30, rep: null }],
  /** V7 مرتجعٌ بلا مندوب (مرتبط وغير مرتبط) */
  V7: [{ op: 'R', q: 100, cost: 10 }, { op: 'SALE', id: 'a1', q: 20, rep: null }, { op: 'R', q: 20, cost: 13 }, { op: 'RET', id: 't1', q: 5, rep: null, of: 'a1', restock: true }, { op: 'RET', id: 't2', q: 2, rep: null, of: null, restock: true }],
  /** V8 سيناريو بطاقة السيارات في warehouse.test.ts:690 */
  V8: [{ op: 'R', q: 100, cost: 10 }, { op: 'L', q: 50, rep: 'A' }, { op: 'R', q: 100, cost: 20 }, { op: 'L', q: 60, rep: 'A' }, { op: 'L', q: 10, rep: 'B' }, { op: 'SALE', id: 's1', q: 80, rep: 'A' }],
  /** V9 سطر تحميلٍ سالب */
  V9: [{ op: 'R', q: 100, cost: 10 }, { op: 'L', q: 50, rep: 'r1' }, { op: 'R', q: 100, cost: 20 }, { op: 'L', q: -10, rep: 'r1' }],
  /** V10 إلغاء فاتورة البيع */
  V10: [{ op: 'R', q: 100, cost: 10 }, { op: 'L', q: 50, rep: 'r1' }, { op: 'R', q: 50, cost: 16 }, { op: 'L', q: 50, rep: 'r1' }, { op: 'SALE', id: 's1', q: 40, rep: 'r1' }, { op: 'CANCEL', id: 's1' }],
  /** V11 مرتجعٌ لا يعود ثم تبديلان ثم إلغاء */
  V11: [
    { op: 'R', q: 100, cost: 21 }, { op: 'L', q: 30, rep: 'r1' }, { op: 'SALE', id: 's1', q: 10, rep: 'r1' },
    { op: 'RET', id: 't1', q: 3, rep: 'r1', of: 's1', restock: false, reason: 'NOT_RESTOCKED' },
    { op: 'TOGGLE', id: 't1', to: true }, { op: 'TOGGLE', id: 't1', to: false }, { op: 'RETCANCEL', id: 't1' },
  ],
};

test('فرق السيارات ١: تحميلان بسعرين ثم تنزيل جزئي — المجموع واحد والتوزيع يختلف', () => {
  const e = runVan(VAN.V1);
  // القديم: العائد من آخر طبقة (٢٠ × ١٦٫٦٧) ⇒ المستودع ١٤٠ بـ٢٣٣٣٫٣٣، والسيارة ٦٠ = ١٠ × ١٦٫٦٧ + ٥٠ × ١٠
  assert.equal(e.old.whValue, 2_333_330n);
  assert.equal(e.old.perVan.r1, 666_670n);
  // الجديد: السيارة ٨٠ بـ١٠٠٠ (١٢٫٥) ⇒ التنزيل ٢٠ × ١٢٫٥ = ٢٥٠
  assert.equal(e.neu.whValue, 2_250_000n);
  assert.deepEqual(e.neu.vans['VAN:r1'], { qtyU: 60_000_000, valueMilli: 750_000n });
  assert.equal(e.old.whQtyU, e.neu.whQtyU, 'كمية المستودع واحدة');
  assert.equal(e.old.whValue + e.old.perVan.r1, 3_000_000n);
  assertConservation(e, 3_000_000n, 'ف١');
});

test('فرق السيارات ٢: بيعٌ ثم تنزيل — LIFO القديم يعيد أغلى طبقة والجديد بمتوسّط السيارة', () => {
  // بعد البيع وقبل التنزيل كانت البطاقة القديمة: ٣٠ × ١٤٫٢٨٥٧ = ٤٢٨٫٥٧ (من أحدث طبقة)، والجديدة ٣٠ بـ٣٥١٫٤٣
  const before = runVan(VAN.V2a);
  assert.equal(before.old.perVan.r1, 428_570n);
  assert.deepEqual(before.neu.vans['VAN:r1'], { qtyU: 30_000_000, valueMilli: 351_430n });
  assert.equal(before.neu.cogsMilli, 820_000n, 'تكلفة المبيعات بمتوسّط السيارة ١١٫٧١٤٣');
  assert.equal(before.old.whValue, before.neu.whValue, 'المستودع واحد قبل التنزيل');
  // بعد التنزيل
  const e = runVan(VAN.V2);
  assert.equal(e.old.whValue, 1_857_140n, 'القديم: العائد ٣٠ من طبقة ١٤٫٢٨٥٧');
  assert.equal(e.neu.whValue, 1_780_000n, 'الجديد: العائد ٣٠ بـ٣٥١٫٤٣');
  assert.equal(e.old.perVan.r1, 0n);
  assert.deepEqual(e.neu.vans['VAN:r1'] ?? { qtyU: 0, valueMilli: 0n }, { qtyU: 0, valueMilli: 0n });
  assertConservation(e, 2_600_000n, 'ف٢');
});

test('فرق السيارات ٣: مرتجعٌ عائد — الجديد بمرآة لقطة البيع، والقديم بطبقات السيارة', () => {
  const e = runVan(VAN.V3);
  const ret = e.outputs.find((o) => o.key === returnKey('t1'))!;
  assert.equal(ret.kind, 'VAN_RETURN_RESTOCK');
  assert.equal(ret.valueMilli, 115_000n, 'مرآة البيع: ٤٦٠ × ١٠ ÷ ٤٠');
  assert.deepEqual(e.neu.vans['VAN:r1'], { qtyU: 70_000_000, valueMilli: 805_000n });
  assert.equal(e.old.perVan.r1, 850_000n, 'القديم: ٥٠ × ١٣ + ٢٠ × ١٠ من أحدث الطبقات');
  assert.equal(e.old.whValue, e.neu.whValue, 'المستودع لم يمسّه شيء من هذا');
  assertConservation(e, 1_800_000n, 'ف٣');
});

test('فرق السيارات ٤: سيارة مندوبٍ محذوف — مبيعاته تصير من المستودع في الإعادة الرجعية (D14)', () => {
  const e = runVan(VAN.V4);
  // القديم: البطاقة تستثني سيارة المحذوف وتعدّها، والمستودع لا يعرف البيع
  assert.equal(e.old.whValue, 600_000n);
  assert.equal(e.old.cardValue, 0n);
  assert.equal(e.old.deletedVans, 1);
  // الجديد: الفاتورة فقدت مندوبها ⇒ WAREHOUSE_SALE من المستودع، والسيارة VAN:r2 تحتفظ بحمولتها كاملة
  assert.equal(e.neu.whValue, 350_000n);
  assert.equal(e.neu.whQtyU, 35_000_000);
  assert.deepEqual(e.neu.vans['VAN:r2'], { qtyU: 40_000_000, valueMilli: 400_000n });
  assert.equal(e.outputs.find((o) => o.key === saleOutKey('s1'))!.kind, 'WAREHOUSE_SALE');
  // ولو حُسبت اللقطة قبل الحذف (التشغيل الحيّ L7) لبقي البيع من السيارة: المستودع ٦٠٠ والسيارة ١٥ بـ١٥٠
  const live = runVan(VAN.V4live);
  assert.equal(live.neu.whValue, 600_000n);
  assert.deepEqual(live.neu.vans['VAN:r2'], { qtyU: 15_000_000, valueMilli: 150_000n });
  assertConservation(e, 1_000_000n, 'ف٤');
});

test('فرق السيارات ٥: مكشوف سيارة — بديل متوسّط المستودع، ثم سدّ الحفرة بفرقٍ إلى تكلفة المبيعات', () => {
  const mid = runVan(VAN.V5a);
  assert.deepEqual(mid.neu.vans['VAN:r3'], { qtyU: -4_000_000, valueMilli: -32_000n }, 'الجديد: −٤ بـ−٣٢ (المثال ب)');
  assert.ok(mid.outputs[1].warnings.includes('WH_RATE_FALLBACK') && mid.outputs[1].warnings.includes('NEGATIVE_STOCK'));
  assert.equal(mid.old.perVan.r3, 0n, 'القديم: الرصيد السالب ليس بضاعة فلا يُقيَّم');
  const e = runVan(VAN.V5);
  const load = e.outputs.find((o) => o.kind === 'VAN_LOAD')!;
  assert.equal(load.valueMilli, -95_000n);
  assert.equal(load.varianceMilli, 6_000n, 'الفرق = ٤ × (٩٫٥ − ٨)');
  assert.deepEqual(e.neu.vans['VAN:r3'], { qtyU: 6_000_000, valueMilli: 57_000n });
  assert.equal(e.old.perVan.r3, 57_000n, 'القديم: ٦ من طبقة ٩٫٥ — القيمة نفسها');
  assert.equal(e.neu.cogsMilli, 38_000n, 'تكلفة المبيعات = ٣٢ يوم البيع + ٦ فرق يوم السدّ');
  assertConservation(e, 190_000n, 'ف٥');
});

test('فرق السيارات ٦: فاتورة الإدارة بلا مندوب (OD8) — المستودع ينقص في الجديد لا القديم', () => {
  const e = runVan(VAN.V6);
  assert.equal(e.old.whValue, 1_000_000n);
  assert.equal(e.old.whQtyU, 100_000_000);
  assert.equal(e.neu.whValue, 700_000n);
  assert.equal(e.neu.whQtyU, 70_000_000);
  assert.equal(e.neu.cogsMilli, 300_000n);
  assertConservation(e, 1_000_000n, 'ف٦');
});

test('فرق السيارات ٧: مرتجعٌ بلا مندوب يعود إلى المستودع بمرآة البيع، وغير المرتبط بمتوسّطه', () => {
  const e = runVan(VAN.V7);
  const t1 = e.outputs.find((o) => o.key === returnKey('t1'))!;
  const t2 = e.outputs.find((o) => o.key === returnKey('t2'))!;
  assert.equal(t1.kind, 'WAREHOUSE_RETURN_RESTOCK');
  assert.equal(t1.valueMilli, 50_000n, 'مرآة البيع (١٠) لا متوسّط اللحظة (١٠٫٦)');
  assert.ok(t2.warnings.includes('RETURN_UNLINKED'));
  assert.equal(t2.valueMilli, 21_140n, 'غير المرتبط بمتوسّط المستودع لحظته: 1,110,000 × 2 ÷ 105 = 21,142.86 ⇒ 21.14');
  assert.equal(e.neu.whValue, 1_131_140n);
  assert.equal(e.old.whValue, 1_260_000n, 'القديم لا يرى البيع ولا المرتجع');
  assert.equal(e.old.whQtyU, 120_000_000);
  assert.equal(e.neu.whQtyU, 107_000_000);
  assertConservation(e, 1_260_000n, 'ف٧');
});

test('فرق السيارات ٨: سيناريو بطاقة السيارات في warehouse.test.ts:690 — المتبقّي بمتوسّط السيارة لا بأحدث طبقة', () => {
  const e = runVan(VAN.V8);
  assert.equal(e.old.cardValue, 666_670n, 'القديم كما في الاختبار: ٤٠ × ١٦٫٦٦٧');
  assert.equal(e.old.perVan.A, 500_000n);
  assert.equal(e.old.perVan.B, 166_670n);
  assert.deepEqual(e.neu.vans['VAN:A'], { qtyU: 30_000_000, valueMilli: 409_090n });
  assert.deepEqual(e.neu.vans['VAN:B'], { qtyU: 10_000_000, valueMilli: 166_670n });
  assert.equal(e.neu.cogsMilli, 1_090_910n);
  assert.equal(e.old.whValue, e.neu.whValue, 'المستودع واحد');
  assertConservation(e, 3_000_000n, 'ف٨');
});

test('فرق السيارات ٩: سطر تحميلٍ سالب — القديم يعيده بمتوسّط المستودع ولا ينقص طبقة السيارة (قيمة وهمية)', () => {
  const e = runVan(VAN.V9);
  assert.equal(e.old.whValue, 2_666_670n, 'القديم: ١٠ بمتوسّط المستودع ١٦٫٦٧');
  assert.equal(e.old.perVan.r1, 400_000n);
  assert.equal(e.old.whValue + e.old.perVan.r1, 3_066_670n, 'القديم يخلق ٦٦٫٦٧ من لا شيء');
  assert.equal(e.neu.whValue, 2_600_000n, 'الجديد: VAN_UNLOAD بمتوسّط السيارة ١٠');
  assert.deepEqual(e.neu.vans['VAN:r1'], { qtyU: 40_000_000, valueMilli: 400_000n });
  assertConservation(e, 3_000_000n, 'ف٩');
});

test('فرق السيارات ١٠: إلغاء فاتورة البيع — القديم يُسقطها بالحالة والجديد يعكسها بمرآتها: النتيجة واحدة', () => {
  const e = runVan(VAN.V10);
  assert.equal(e.old.perVan.r1, 1_150_000n);
  assert.deepEqual(e.neu.vans['VAN:r1'], { qtyU: 100_000_000, valueMilli: 1_150_000n });
  assert.equal(e.neu.cogsMilli, 0n);
});

test('فرق السيارات ١١: مرتجعٌ لا يعود ثم تبديلات الإعادة ثم الإلغاء — الكمية كالقديم والشطب مذكِّرة', () => {
  const e = runVan(VAN.V11);
  const wo = e.outputs.find((o) => o.key === returnKey('t1'))!;
  assert.equal(wo.kind, 'RETURN_WRITE_OFF');
  assert.equal(wo.memoMilli, 63_000n, 'المثال هـ: ٢١٠ × ٣ ÷ ١٠');
  const cancel = e.outputs.find((o) => o.key === returnCancelKey('t1'))!;
  assert.equal(cancel.memoMilli, -63_000n, 'الإلغاء يعكس آخر شطب (تبديل إلى false)');
  assert.equal(e.neu.writeOffMilli, 0n, 'الشطب كله انعكس');
  assert.deepEqual(e.neu.vans['VAN:r1'], { qtyU: 20_000_000, valueMilli: 420_000n });
  assert.equal(e.old.perVan.r1, 420_000n, 'القديم: المرتجع الملغى لا أثر له');
});

// ════════════════════════════════════════════════════════════════════════════
// ٤) المصدر الحقيقي: السيناريوهات نفسها صفوفاً تشغيلية ⇒ loadMoves (C2) ⇒ replay — لقطةً لقطة كالتحويل اليدوي أعلاه
// ════════════════════════════════════════════════════════════════════════════
//
// أرقام الوثيقة مبنيّة على حركات §6.1 كما حوّلها هذا الاختبار يدوياً؛ وهنا تُبنى الصفوف التشغيلية نفسها (وارد، تحميل،
// فاتورة وصفّها الأساسي في account_entries، إلغاء، سجلّ تبديل، حذف مندوب) في القاعدة المزيّفة، ويقرؤها المصدر الحقيقي —
// فلا تبقى الوثيقة على تحويلٍ لا يطابق ما ستقرؤه المعاينة والتشغيل الحيّ.

async function viaStreams(ops: readonly VOp[], dec = 2): Promise<StepOutput[]> {
  const db = new CostingFakeDb();
  // الفواتير بعد DAMAGED_VAN_SINCE لا تمسّ شيئاً هنا (لا تالف في السيناريوهات)، والساعة الوهمية تحفظ ترتيب العمليات
  const saleItem = new Map<string, string>();
  const saleInv = new Map<string, string>();
  const retInv = new Map<string, string>();
  for (const o of ops) {
    const pid = 'p' in o && o.p ? o.p : 'a';
    switch (o.op) {
      case 'R': db.addReceipt(pid, o.q, o.cost ?? null); break;
      case 'A': db.addWarehouseEntry({ type: 'ADJUST', items: [{ productId: pid, qty: o.q }] }); break;
      case 'L': case 'U': case 'VA':
        db.addVanLoad({ salesRepId: o.rep, type: o.op === 'L' ? 'LOAD' : o.op === 'U' ? 'UNLOAD' : 'ADJUST', items: [{ productId: pid, qty: o.q }] });
        break;
      case 'SALE': {
        const r = db.addInvoice({ type: 'CREDIT', salesRepId: o.rep, items: [{ productId: pid, qty: o.q }] });
        saleItem.set(o.id, r.itemIds[0]); saleInv.set(o.id, r.id);
        break;
      }
      case 'CANCEL': db.cancelInvoice(saleInv.get(o.id)!); break;
      case 'RET': {
        const r = db.addInvoice({
          type: 'RETURN', salesRepId: o.rep, returnToStock: o.restock && !o.reason,
          items: [{ productId: pid, qty: o.q, returnOfItemId: o.of ? saleItem.get(o.of)! : null, returnExpired: o.reason === 'EXPIRED' }],
        });
        retInv.set(o.id, r.id);
        break;
      }
      case 'TOGGLE': db.toggleRestock(retInv.get(o.id)!, o.to); break;
      case 'RETCANCEL': db.cancelInvoice(retInv.get(o.id)!); break;
      case 'DEL':
        // حذف المندوب (salesReps.ts): تحميلاته تبقى بمعرّفه المحفوظ، وفواتيره تفقد مندوبها
        for (const v of db.tables.vanLoad) if (v.salesRepId === o.rep) { v.salesRepId = null; v.deletedSalesRepId = o.rep; }
        for (const i of db.tables.invoice) if (i.salesRepId === o.rep) i.salesRepId = null;
        break;
    }
  }
  const r = await loadMoves(asPrisma<CostingDb>(db), 't1', { until: new Date('2100-01-01T00:00:00Z'), currencyDecimals: dec });
  assert.equal(r.warnings.length, 0, `تحذيرات مصدر غير متوقّعة: ${JSON.stringify(r.warnings)}`);
  return replay(r.moves, { currencyDecimals: dec }).outputs;
}

/** ما يُقارن من اللقطة (المفاتيح ومعرّفات الصفوف تختلف بين التحويلين، والقيم والمواقع لا) */
const shape = (o: StepOutput) => [o.kind, o.location, o.toLocation, o.baseQty, o.uncostedQty, o.valueMilli, o.varianceMilli, o.memoMilli, o.reason, o.warnings.join(',')];

test('المصدر الحقيقي: كل سيناريو سيارات (V1..V11) عبر loadMoves = التحويل اليدوي لقطةً لقطة', async () => {
  for (const [name, ops] of Object.entries(VAN)) {
    const manual = runVan(ops).outputs.map(shape);
    const real = (await viaStreams(ops)).map(shape);
    assert.deepEqual(real, manual, `${name}: المصدر الحقيقي يختلف عن التحويل الموثَّق`);
  }
});
