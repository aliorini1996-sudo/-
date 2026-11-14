/**
 * C3 — أداء محرّك التكلفة على سنة كاملة (العقد §17 C3-3):
 *   • 50,000 حركة (500 صنف × 11 موقعاً: المستودع وعشر سيارات، كل أنواع الحركات بصلاتها) ⇒ replay ≤ 10 ثوانٍ وذاكرة < 300MB؛
 *   • الإعادة من نقطة حفظ عند الحركة 45,000 للخمسة آلاف الباقية ≤ ثانية واحدة، ومطابقة للإعادة الكاملة حرفياً (كل الحقول)؛
 *   • ذهاب-إياب checkpointRows/stateFromCheckpointRows (وsnapshotRow/snapshotRefFromRow للصلات) بلا فقد.
 *
 * لماذا يهمّ: قاعدة الإنتاج ٠٫١ نواة، والمحرّك يعمل في عملية الخادم نفسها (المعاينة L2 والتشغيل الحيّ L7)؛ فإعادة سنةٍ
 * يجب أن تكون ثوانيَ معدودة بذاكرةٍ محدودة، والاستئناف من نقطة حفظ يجب أن يساوي الإعادة الكاملة وإلا افترق الأستاذ بين
 * شركةٍ أُعيد حسابها من الصفر وأخرى استُؤنفت.
 *
 * المولّد حتمي (mulberry32) والوقت ثابت — لا Date.now في المدخلات. القياسات تُطبع سطراً (C3_PERF) لتنقلها الوثيقة.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { replay, compareMoves, locStateKey, stateTotals } from '../services/costing/stepper';
import { saleOutKey, saleCancelKey, returnKey, returnCancelKey, restockToggleKey, whItemKey, vanItemKey } from '../services/costing/keys';
import { glImpactOf } from '../services/costing/accounts';
import { checkpointRows, stateFromCheckpointRows, snapshotRow, snapshotRefFromRow } from '../services/costing/snapshots';
import { vanLocation, WH_LOCATION, type CostState, type LocationKey, type Move, type SnapshotRef, type StepOutput } from '../services/costing/types';
import { toMilli } from '../services/gl/money';

const TID = 'tenant-perf';
const DEC = 2;
const CFG = { currencyDecimals: DEC };
const PRODUCTS = 500;
const REPS = 10;
const TARGET_MOVES = 50_000;
const CHECKPOINT_AT = 45_000;
const YEAR_START = Date.UTC(2026, 0, 1, 5, 0, 0);
const YEAR_MS = 365 * 86_400_000;

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

interface SaleLine { itemId: string; pid: string; loc: LocationKey; qty: number; cancelled: boolean; returned: number }
interface RetLine {
  itemId: string; sale: SaleLine | null; pid: string; loc: LocationKey; qty: number;
  /** عائدٌ الآن؟ */ back: boolean; /** تالف/منتهٍ: مشطوبٌ أبداً */ fixedOff: boolean; cancelled: boolean;
  /** مفتاح آخر حركة شطب (لـmemoOf عند الإلغاء) */ lastOffKey: string | null;
}

/**
 * سنة تشغيل حتمية: مستندات (مؤشّر واحد لكل مستند، ١–٣ أسطر تتشارك المؤشّر فيُفصل بينها بالمفتاح) بكل أنواع §6.1،
 * والصلات صحيحة: إلغاء البيع ⇒ لقطة البيع، والمرتجع ⇒ بند البيع (وبعضه بلا صلة)، والتبديل والإلغاء ⇒ لقطة المرتجع.
 */
function genYear(seed: number): Move[] {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pid = () => `p${String(int(0, PRODUCTS - 1)).padStart(3, '0')}`;
  const rep = () => `r${int(0, REPS - 1)}`;
  const moves: Move[] = [];
  const sales: SaleLine[] = [];
  const rets: RetLine[] = [];
  const DOCS = Math.ceil(TARGET_MOVES / 1.45);
  let doc = 0;
  let item = 0;
  while (moves.length < TARGET_MOVES) {
    const d = doc++;
    // لحظة المستند: موزّعة على السنة، وكل ٥٠ مستنداً اثنان باللحظة نفسها (التعادل يُحسم بالمعرّف ثم المفتاح)
    const createdAt = new Date(YEAR_START + Math.floor((Math.min(d, DOCS) * YEAR_MS) / DOCS) - (d % 50 === 1 ? 1 : 0) * Math.floor(YEAR_MS / DOCS));
    const id = `d${String(d).padStart(6, '0')}`;
    const cursor = { createdAt, id };
    // تاريخ الأثر: غالباً لحظة التسجيل، والفواتير بتاريخها (منتصف الليل UTC وأحياناً يوماً قبله — مؤرّخ رجعياً)
    const day = new Date(Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate()));
    const invDate = rnd() < 0.05 ? new Date(day.getTime() - 86_400_000) : day;
    const left = TARGET_MOVES - moves.length;
    const lines = Math.min(left, int(1, 3));
    const push = (m: Omit<Move, 'cursor'>) => moves.push({ ...m, cursor });
    const r = rnd();
    if (r < 0.12) {
      for (let k = 0; k < lines; k++) {
        const it = `i${item++}`;
        const q = int(10, 200);
        const priced = rnd() < 0.85;
        const price = Math.round((1 + rnd() * 99) * 100) / 100;
        push({ key: whItemKey(it), kind: 'RECEIVE', effectAt: createdAt, productId: pid(), location: WH_LOCATION, baseQty: q, inValueMilli: priced ? toMilli(q * price, DEC) : null, refType: 'WH_ENTRY', refId: id, itemId: it });
      }
    } else if (r < 0.15) {
      const it = `i${item++}`;
      const q = int(1, 20) * (rnd() < 0.5 ? -1 : 1);
      push({ key: whItemKey(it), kind: rnd() < 0.15 ? 'ZERO_RUN' : 'WH_ADJUST', effectAt: createdAt, productId: pid(), location: WH_LOCATION, baseQty: q, reason: 'COUNT', refType: 'WH_ENTRY', refId: id, itemId: it });
    } else if (r < 0.16) {
      const it = `i${item++}`;
      push({ key: whItemKey(it), kind: 'VENDOR_RETURN', effectAt: createdAt, productId: pid(), location: WH_LOCATION, baseQty: -int(1, 20), refType: 'WH_ENTRY', refId: id, itemId: it });
    } else if (r < 0.31) {
      const V = vanLocation(rep());
      for (let k = 0; k < lines; k++) {
        const it = `i${item++}`;
        push({ key: vanItemKey(it), kind: 'VAN_LOAD', effectAt: createdAt, productId: pid(), location: WH_LOCATION, toLocation: V, baseQty: -int(5, 60), refType: 'VAN_LOAD', refId: id, itemId: it });
      }
    } else if (r < 0.36) {
      const V = vanLocation(rep());
      for (let k = 0; k < lines; k++) {
        const it = `i${item++}`;
        push({ key: vanItemKey(it), kind: 'VAN_UNLOAD', effectAt: createdAt, productId: pid(), location: V, toLocation: WH_LOCATION, baseQty: -int(1, 20), refType: 'VAN_LOAD', refId: id, itemId: it });
      }
    } else if (r < 0.385) {
      const it = `i${item++}`;
      const kind = rnd() < 0.15 ? 'ZERO_RUN' : 'VAN_ADJUST';
      push({ key: vanItemKey(it), kind, effectAt: createdAt, productId: pid(), location: vanLocation(rep()), baseQty: int(1, 10) * (rnd() < 0.6 ? -1 : 1), reason: 'COUNT', refType: 'VAN_LOAD', refId: id, itemId: it });
    } else if (r < 0.39) {
      const it = `i${item++}`;
      push({ key: vanItemKey(it), kind: 'DAMAGE_OUT', effectAt: createdAt, productId: pid(), location: vanLocation(rep()), baseQty: 0, reason: rnd() < 0.5 ? 'DAMAGED_OUT' : 'EXPIRED_OUT', refType: 'VAN_LOAD', refId: id, itemId: it });
    } else if (r < 0.83) {
      // فاتورة بيع: لمندوب (٩٠٪) أو فاتورة إدارة بلا مندوب (OD8)
      const salesRep = rnd() < 0.9 ? rep() : null;
      const loc = salesRep ? vanLocation(salesRep) : WH_LOCATION;
      for (let k = 0; k < lines; k++) {
        const it = `i${item++}`;
        const q = rnd() < 0.85 ? int(1, 10) : Math.round(rnd() * 5000) / 1000 + 0.001;
        const s: SaleLine = { itemId: it, pid: pid(), loc, qty: q, cancelled: false, returned: 0 };
        sales.push(s);
        push({ key: saleOutKey(it), kind: salesRep ? 'VAN_SALE' : 'WAREHOUSE_SALE', effectAt: invDate, productId: s.pid, location: loc, baseQty: -q, refType: 'INVOICE', refId: id, itemId: it });
      }
    } else if (r < 0.86) {
      // إلغاء فاتورة بيع (صفّ INVOICE_CREDIT): بنودٌ لم تُلغَ ولم يُرجَع منها
      for (let k = 0; k < lines; k++) {
        const s = sales.length ? sales[int(Math.max(0, sales.length - 3000), sales.length - 1)] : null;
        if (!s || s.cancelled || s.returned > 0) continue;
        s.cancelled = true;
        push({ key: saleCancelKey(s.itemId), kind: 'SALE_CANCEL', effectAt: invDate, productId: s.pid, location: s.loc, baseQty: s.qty, links: { mirrorOf: saleOutKey(s.itemId), locationOf: saleOutKey(s.itemId) }, refType: 'INVOICE', refId: id, itemId: s.itemId });
      }
    } else if (r < 0.95) {
      // فاتورة مرتجع: مرتبطٌ ببند بيع (٩٥٪) أو بلا صلة؛ عائد (٧٠٪) أو مشطوب (غير معاد/تالف/منتهٍ)
      for (let k = 0; k < lines; k++) {
        const s = sales.length && rnd() < 0.95 ? sales[int(Math.max(0, sales.length - 5000), sales.length - 1)] : null;
        if (s && (s.cancelled || s.returned >= s.qty)) continue;
        const it = `i${item++}`;
        const qty = s ? Math.min(s.qty - s.returned, int(1, 3)) : int(1, 3);
        if (s) s.returned += qty;
        const loc = s ? s.loc : (rnd() < 0.8 ? vanLocation(rep()) : WH_LOCATION);
        const back = rnd() < 0.7;
        const reason = back ? null : pick(['NOT_RESTOCKED', 'NOT_RESTOCKED', 'DAMAGED', 'EXPIRED'] as const);
        const rl: RetLine = { itemId: it, sale: s, pid: s ? s.pid : pid(), loc, qty, back, fixedOff: reason === 'DAMAGED' || reason === 'EXPIRED', cancelled: false, lastOffKey: back ? null : returnKey(it) };
        rets.push(rl);
        const mirrorOf = s ? saleOutKey(s.itemId) : null;
        if (back) push({ key: returnKey(it), kind: loc === WH_LOCATION ? 'WAREHOUSE_RETURN_RESTOCK' : 'VAN_RETURN_RESTOCK', effectAt: invDate, productId: rl.pid, location: loc, baseQty: qty, links: { mirrorOf }, refType: 'INVOICE', refId: id, itemId: it });
        else push({ key: returnKey(it), kind: 'RETURN_WRITE_OFF', effectAt: invDate, productId: rl.pid, location: loc, baseQty: 0, memoQty: qty, links: { mirrorOf }, reason, refType: 'INVOICE', refId: id, itemId: it });
      }
    } else if (r < 0.98) {
      // سجلّ تبديل «الإعادة للمخزون» (InvoiceRestockLog): لمرتجعٍ غير مكتوبٍ عليه ولم يُلغَ
      const cand = rets.slice(-2000).filter((x) => !x.fixedOff && !x.cancelled);
      if (!cand.length) continue;
      const rl = pick(cand);
      const logId = `log${d}`;
      const key = restockToggleKey(logId, rl.itemId);
      const to = !rl.back;
      push({
        key, kind: 'RESTOCK_TOGGLE', effectAt: createdAt, productId: rl.pid, location: rl.loc, baseQty: to ? rl.qty : -rl.qty,
        links: to ? { mirrorOf: rl.sale ? saleOutKey(rl.sale.itemId) : null, locationOf: returnKey(rl.itemId) } : { mirrorOf: null, locationOf: returnKey(rl.itemId) },
        refType: 'RESTOCK_LOG', refId: logId, itemId: rl.itemId,
      });
      rl.back = to;
      if (!to) rl.lastOffKey = key;
    } else {
      // إلغاء مرتجع (صفّ INVOICE_DEBIT): العائد يخرج بالمتوسّط، والمشطوب تُعكس مذكِّرة آخر شطب
      const cand = rets.slice(-3000).filter((x) => !x.cancelled);
      if (!cand.length) continue;
      const rl = pick(cand);
      rl.cancelled = true;
      push({
        key: returnCancelKey(rl.itemId), kind: 'RETURN_CANCEL', effectAt: invDate, productId: rl.pid, location: rl.loc,
        baseQty: rl.back ? -rl.qty : 0, links: rl.back ? { mirrorOf: null, locationOf: returnKey(rl.itemId) } : { mirrorOf: null, memoOf: rl.lastOffKey },
        refType: 'INVOICE', refId: id, itemId: rl.itemId,
      });
    }
  }
  return moves;
}

/** حالة قابلة للمقارنة: المواقع غير الصفرية مرتّبة بالمفتاح (نقطة الحفظ لا تكتب الصفرية — §7) */
function normalize(s: CostState) {
  const locs = [...s.locs.entries()]
    .filter(([, l]) => l.costedQtyU !== 0 || l.uncostedQtyU !== 0 || l.valueMilli !== 0n || l.lastAvg !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { locs, movesFolded: s.movesFolded, cursor: s.cursor };
}

const sameCursor = (a: Move, b: Move) => a.cursor.createdAt.getTime() === b.cursor.createdAt.getTime() && a.cursor.id === b.cursor.id;

const MOVES = genYear(20261114);
const PERF: Record<string, unknown> = {};

test('المولّد: 50,000 حركة، 500 صنف × 11 موقعاً، وكل أنواع الحركات', () => {
  assert.equal(MOVES.length, TARGET_MOVES);
  assert.equal(new Set(MOVES.map((m) => m.key)).size, TARGET_MOVES, 'المفاتيح فريدة (sourceKey)');
  const kinds = new Map<string, number>();
  for (const m of MOVES) kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + 1);
  for (const k of ['RECEIVE', 'VENDOR_RETURN', 'WH_ADJUST', 'ZERO_RUN', 'VAN_LOAD', 'VAN_UNLOAD', 'VAN_ADJUST', 'DAMAGE_OUT', 'VAN_SALE', 'WAREHOUSE_SALE', 'SALE_CANCEL', 'VAN_RETURN_RESTOCK', 'WAREHOUSE_RETURN_RESTOCK', 'RETURN_WRITE_OFF', 'RETURN_CANCEL', 'RESTOCK_TOGGLE']) {
    assert.ok((kinds.get(k) ?? 0) > 0, `النوع ${k} حاضر`);
  }
  const locs = new Set<string>();
  const prods = new Set<string>();
  for (const m of MOVES) { locs.add(m.location); if (m.toLocation) locs.add(m.toLocation); prods.add(m.productId); }
  assert.equal(locs.size, 1 + REPS, 'المستودع وعشر سيارات');
  assert.equal(prods.size, PRODUCTS);
  PERF.kinds = Object.fromEntries([...kinds].sort());
});

let FULL: ReturnType<typeof replay> | null = null;

test('الأداء: replay لسنة كاملة (50,000 حركة) ≤ 10 ثوانٍ وذاكرة < 300MB', () => {
  // المدخلات مقلوبة عمداً: replay يرتّب نسخةً بنفسه (compareMoves) — والفرز داخل الزمن المقيس
  const input = [...MOVES].reverse();
  const m0 = process.memoryUsage();
  let peakHeap = m0.heapUsed;
  let peakRss = m0.rss;
  // عيّنة ذاكرة كل 5,000 حركة (عشر عيّنات — لا تثقل القياس) لالتقاط الذروة أثناء الإعادة لا بعدها وحدها
  let n = 0;
  const sample = () => {
    const m = process.memoryUsage();
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
    if (m.rss > peakRss) peakRss = m.rss;
  };
  const t0 = performance.now();
  const r = replay(input, CFG, { onOutput: () => { if (++n % 5_000 === 0) sample(); } });
  const ms = performance.now() - t0;
  sample();
  FULL = r;
  const MB = 1048576;
  PERF.replayMs = Math.round(ms);
  PERF.heapBeforeMB = Math.round(m0.heapUsed / MB);
  PERF.heapPeakMB = Math.round(peakHeap / MB);
  PERF.replayHeapMB = Math.round((peakHeap - m0.heapUsed) / MB);
  PERF.rssBeforeMB = Math.round(m0.rss / MB);
  PERF.rssPeakMB = Math.round(peakRss / MB);
  PERF.replayRssMB = Math.round((peakRss - m0.rss) / MB);
  assert.equal(r.outputs.length, TARGET_MOVES);
  assert.equal(r.state.movesFolded, TARGET_MOVES);
  assert.ok(ms <= 10_000, `replay استغرق ${Math.round(ms)}ms`);
  // الحدّ على ما تضيفه الإعادة نفسها (ذروة الكومة ونموّ العملية) — لا على أساس العملية (tsx ومشغّل الاختبار والمدخلات)
  assert.ok(peakHeap - m0.heapUsed < 300 * MB, `ذروة كومة الإعادة ${PERF.replayHeapMB}MB`);
  assert.ok(peakRss - m0.rss < 300 * MB, `نموّ ذاكرة العملية أثناء الإعادة ${PERF.replayRssMB}MB`);
});

test('سنة كاملة: انعدام الانجراف — Σ مساهمات اللقطات لكل موقع = قيمة الحالة، وكل لقطة متوازنة (§4.7، §8)', () => {
  const full = FULL ?? replay(MOVES, CFG);
  const sum = new Map<string, bigint>();
  const add = (k: string, v: bigint) => sum.set(k, (sum.get(k) ?? 0n) + v);
  let cogs = 0n;
  for (const o of full.outputs) {
    add(locStateKey(o.productId, o.location), o.valueMilli);
    if (o.toLocation) add(locStateKey(o.productId, o.toLocation), -o.valueMilli - o.varianceMilli);
    const g = glImpactOf(o);
    const inv = g.inventory.reduce((s, x) => s + x.milli, 0n);
    assert.equal(inv + g.cogsMilli + g.writeOffMilli + g.counterMilli, 0n, `${o.key}: غير متوازنة`);
    cogs += g.cogsMilli;
  }
  for (const [k, l] of full.state.locs) {
    assert.equal(sum.get(k) ?? 0n, l.valueMilli, `${k}: انجراف`);
    if (l.costedQtyU === 0) assert.equal(l.valueMilli, 0n, `${k}: كمية مقيَّمة صفر بقيمة`);
  }
  const totals = stateTotals(full.state);
  assert.equal(totals.length, 1 + REPS);
  PERF.cogsMilli = String(cogs);
  PERF.endValueMilli = String(totals.reduce((s, t) => s + t.valueMilli, 0n));
});

test('الاستئناف: نقطة حفظ عند 45,000 ثم الخمسة آلاف الباقية ≤ ثانية ومطابقة للإعادة الكاملة حرفياً', () => {
  const full = FULL ?? replay(MOVES, CFG);
  const sorted = [...MOVES].sort(compareMoves);
  // نقاط الحفظ مجموعاتٌ كاملة بالمؤشّر (D3): لا تُقطع أسطر مستندٍ واحد بين جانبي النقطة
  let cut = CHECKPOINT_AT;
  while (cut < sorted.length && sameCursor(sorted[cut - 1], sorted[cut])) cut++;
  const head = sorted.slice(0, cut);
  const tail = sorted.slice(cut);
  const r1 = replay(head, CFG);
  assert.deepEqual(r1.state.cursor, sorted[cut - 1].cursor);

  // نقطة الحفظ كما تُكتب في gl_cost_checkpoints وتُقرأ
  const rows = checkpointRows(TID, r1.state, r1.state.cursor!);
  const restored = stateFromCheckpointRows(rows as unknown as Parameters<typeof stateFromCheckpointRows>[0]);
  assert.deepEqual(normalize(restored), normalize(r1.state), 'ذهاب-إياب نقطة الحفظ بلا فقد');

  // صلات الخمسة آلاف إلى ما قبل النقطة تُحلّ من gl_cost_snapshots (snapshotRow ⇒ snapshotRefFromRow) لا من الذاكرة
  const refs = new Map<string, SnapshotRef>();
  for (const o of r1.outputs) {
    const ref = snapshotRefFromRow(snapshotRow(TID, o) as unknown as Parameters<typeof snapshotRefFromRow>[0]);
    refs.set(ref.key, ref);
  }
  const t0 = performance.now();
  const r2 = replay(tail, CFG, { state: restored, lookup: { get: (k) => refs.get(k) } });
  const ms = performance.now() - t0;
  PERF.resumeMs = Math.round(ms);
  PERF.resumeMoves = tail.length;
  PERF.checkpointRows = rows.length;
  assert.ok(ms <= 1_000, `الاستئناف استغرق ${Math.round(ms)}ms`);
  assert.equal(r2.outputs.length, tail.length);
  assert.deepEqual(r2.outputs, full.outputs.slice(cut), 'كل حقول اللقطات = الإعادة الكاملة');
  assert.deepEqual(normalize(r2.state), normalize(full.state), 'الحالة النهائية = الإعادة الكاملة');
});

test('ذهاب-إياب: checkpointRows/stateFromCheckpointRows على حالة السنة كلها، وsnapshotRow/snapshotRefFromRow على كل لقطة', () => {
  const full = FULL ?? replay(MOVES, CFG);
  const rows = checkpointRows(TID, full.state, full.state.cursor!);
  const back = stateFromCheckpointRows(rows as unknown as Parameters<typeof stateFromCheckpointRows>[0]);
  assert.deepEqual(normalize(back), normalize(full.state));
  // حالةٌ فيها كل الأشكال: حفرة مقيَّمة سالبة، دلو خارج التقييم، وlastAvg
  let holes = 0, uncosted = 0, lastAvg = 0;
  for (const l of full.state.locs.values()) {
    if (l.costedQtyU < 0) holes++;
    if (l.uncostedQtyU > 0) uncosted++;
    if (l.lastAvg) lastAvg++;
  }
  assert.ok(holes > 0 && uncosted > 0 && lastAvg > 0, `أشكال الحالة: حفر ${holes}، خارج التقييم ${uncosted}، lastAvg ${lastAvg}`);
  // صفّ الرأس آخر الصفوف (§7)
  const last = rows[rows.length - 1] as { productId: string; location: string };
  assert.equal(last.productId, '*');
  assert.equal(last.location, '*');
  for (const o of full.outputs) {
    const ref = snapshotRefFromRow(snapshotRow(TID, o) as unknown as Parameters<typeof snapshotRefFromRow>[0]);
    assert.deepEqual(ref, snapshotRefOf(o), `${o.key}: اللقطة لا تعود كما كُتبت`);
  }
});

/** ما يحمله SnapshotRef من StepOutput (بلا الاعتماد على snapshotRefOf في stepper ليبقى الاختبار مستقلاً) */
function snapshotRefOf(o: StepOutput): SnapshotRef {
  return {
    key: o.key, kind: o.kind, productId: o.productId, location: o.location, toLocation: o.toLocation,
    baseQty: o.baseQty, uncostedQty: o.uncostedQty, valueMilli: o.valueMilli, varianceMilli: o.varianceMilli, memoMilli: o.memoMilli, effectAt: o.effectAt,
  };
}

test('الحتمية على السنة: ترتيبان مختلفان للمدخلات ⇒ المخرجات نفسها حرفياً', () => {
  const full = FULL ?? replay(MOVES, CFG);
  const rnd = mulberry32(7);
  const shuffled = [...MOVES];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const again = replay(shuffled, CFG);
  assert.deepEqual(again.outputs, full.outputs);
  console.log(`C3_PERF ${JSON.stringify(PERF)}`);
});
