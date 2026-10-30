// ============================================================================
// «تتبّع اللوط» في تطبيق المندوب (§٦.٣، §٧): المتاح المحلي من لقطة السيارة — منطقٌ صرف بلا IndexedDB ولا شبكة ولا React.
// ----------------------------------------------------------------------------
// - اللقطة: GET /van-stock/lot-balances (VanLotSnapshotDto) تُخزَّن في ref 'vanlots' بختم **بدء** الطلب (fetchedAt)، فما رُفع
//   أو صدر بعد بدئه قد لا تراه اللقطة فيُطرح منها. وقائمة tracked فيها هي المرجع: المتتبَّع الغائب عن products متاحه صفر.
// - المعلّق (pendingOut): فواتير البيع في الصفّ (منتظرة أو مرفوضة أو موسومة بمراجعة)، والمرسَلة بعد fetchedAt، وما صدر متصلاً
//   بعده ('vanlots:posted' بتشغيلات ردّ الخادم). المرتجع المعلّق لا يزيد شيئاً: الخادم يقرّر مكانه ودلوه.
// - التلميح يُطرح من تشغيلاته **للصنف كله أو لا شيء** (D16 كما يقبله الخادم)، وما بلا تلميح — أو تلميحٌ لا تسعه اللقطة — يُطرح
//   بـFEFO من المؤهَّل ثم من غير المسمّى، كطبقتي الإعادة ١ و٢.
// - FEFO هنا ترتيب اللقطة نفسها: الخادم يرسل التشغيلات بترتيب fefoCompare الكامل (الإنتاج وcreatedAt بعد الانتهاء).
// - كل كمية بوحدة الأساس (D22)، ويوم الانتهاء نفسه آخر يوم صالح، والقياس بيوم الجهاز (todayLocal). الخادم صاحب القرار.
// ============================================================================

import type { OutboxDoc } from './offlineDb';
import {
  LOT_EPS, LOT_MAX_ROWS, docLotsFrom, isLotExpiredOn, lotDay, roundLot, toBaseQty,
  type DocLotLine, type LotRef, type VanLotSnapshotDto,
} from '../lib/lots';

export const VANLOTS_KEY = 'vanlots';
export const VANLOTS_POSTED_KEY = 'vanlots:posted';
/** ردّ الخادم لفاتورة دون اتصال لا يكفيها رصيد السيارة (D20): يبقى المستند مصفوفاً بوسم مراجعة لا رفض */
export const LOT_REPLAY_HELD_CODE = 'LOT_REPLAY_HELD';
/** مفتاح «غير المسمّى» في byLot */
export const UNKNOWN_LOT_KEY = '∅';
/** المنع المحلي والجهاز متصل يعيد جلب اللقطة مرةً قبل الرسالة — ولا أكثر من مرةٍ في هذه المهلة (لا طلب لكل نقرة) */
export const VANLOTS_BLOCK_REFETCH_GAP_MS = 15_000;
/** سقف ما يُحفظ من الصادر متصلاً — يُقلَّم بكل لقطة جديدة، والسقف حارسُ جهازٍ لا يتّصل باللقطة أبداً */
export const VANLOTS_POSTED_MAX = 200;

export type SnapProduct = VanLotSnapshotDto['products'][number];
export type SnapLot = SnapProduct['lots'][number];
/** بند فاتورةٍ صدرت متصلاً — الكمية أساسية، والتشغيلات كما وزّعها الخادم */
export interface PostedItem { productId: string; qty: number; lots?: LotRef[] | null }
export interface PostedEntry { clientRef: string; at: number; items: PostedItem[] }
/** سجلّ ref 'vanlots' — repId صاحب اللقطة (جهاز مشترك)، وfetchedAt لحظة بدء الطلب */
export interface StoredVanLots { v: 1; repId: string; fetchedAt: number; snap: VanLotSnapshotDto }
export interface PendingProduct { total: number; byLot: Map<string /* lotId أو UNKNOWN_LOT_KEY */, number> }
export type PendingOut = Map<string /* productId */, PendingProduct>;

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const keyOf = (lotId: string | null): string => (lotId === null ? UNKNOWN_LOT_KEY : lotId);

// ─── اللقطة وسجلّها ───

function isSnapLot(x: unknown): x is SnapLot {
  if (!x || typeof x !== 'object') return false;
  const l = x as Record<string, unknown>;
  return typeof l.lotId === 'string' && l.lotId.length > 0 && typeof l.lotNumber === 'string' && finite(l.usable)
    && (l.status === 'ACTIVE' || l.status === 'BLOCKED')
    && (l.expiryDate == null || typeof l.expiryDate === 'string');
}

/** شكل اللقطة كما يردّها الخادم — ما خالفه يُرفض كله: لا متاح يُحسب من لقطةٍ نصف صالحة */
export function isVanLotSnapshot(x: unknown): x is VanLotSnapshotDto {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  if (!Array.isArray(s.tracked) || !s.tracked.every((t) => typeof t === 'string')) return false;
  if (typeof s.allowUnknown !== 'boolean' || !Array.isArray(s.products)) return false;
  return s.products.every((p) => {
    if (!p || typeof p !== 'object') return false;
    const q = p as Record<string, unknown>;
    return typeof q.productId === 'string' && finite(q.unknownUsable) && Array.isArray(q.lots) && q.lots.every(isSnapLot);
  });
}

/** سجلّ اللقطة المخزَّن — لصاحب الجلسة وحده (جهاز مشترك)، وما خالف الشكل null */
export function storedVanLotsOf(raw: unknown, repId: string | null | undefined): StoredVanLots | null {
  if (!raw || typeof raw !== 'object' || !repId) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || r.repId !== repId || !finite(r.fetchedAt) || !isVanLotSnapshot(r.snap)) return null;
  return { v: 1, repId, fetchedAt: r.fetchedAt, snap: r.snap };
}

/** سجلّ لقطةٍ جديدة من ردّ الخادم — fetchedAt لحظة بدء الطلب (لا fetchThenCache التي تختم بعد الردّ، §٧.١) */
export function vanLotsEntry(snap: unknown, repId: string | null | undefined, fetchedAt: number): StoredVanLots | null {
  if (!repId || !finite(fetchedAt) || !isVanLotSnapshot(snap)) return null;
  return { v: 1, repId, fetchedAt, snap };
}

/** الأصناف المتتبَّعة: قائمة اللقطة هي المرجع؛ وبلا لقطة علم الصنف في كتالوج الجهاز (ليُمنع بيعه دون اتصال) */
export function trackedIds(snap: VanLotSnapshotDto | null | undefined, products: readonly { id: string; lotTracked?: unknown }[]): Set<string> {
  if (snap) return new Set(snap.tracked);
  return new Set(products.filter((p) => p.lotTracked === true).map((p) => p.id));
}

/** صنفٌ في اللقطة — undefined للمتتبَّع بلا رصيد (متاحه صفر) */
export function snapProductOf(snap: VanLotSnapshotDto, productId: string): SnapProduct | undefined {
  return snap.products.find((p) => p.productId === productId);
}

// ─── الصادر متصلاً ───

/** قائمة 'vanlots:posted' المخزّنة — الصالح منها وحده */
export function postedListOf(raw: unknown): PostedEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is PostedEntry => !!e && typeof e === 'object'
    && typeof (e as PostedEntry).clientRef === 'string' && finite((e as PostedEntry).at) && Array.isArray((e as PostedEntry).items));
}

/** إضافة صادرٍ متصلاً (بديلٌ لمرجعه نفسه إن وُجد)، مقلَّمةً بلقطة الجهاز: ما صدر قبل بدء جلبها تعرفه اللقطة */
export function withPosted(list: readonly PostedEntry[], entry: PostedEntry, fetchedAt: number | null): PostedEntry[] {
  return prunePosted([...list.filter((e) => e.clientRef !== entry.clientRef), entry], fetchedAt);
}

/** ما بقي معلّقاً على لقطةٍ بدأ جلبها في fetchedAt (null = لا لقطة: يُحفظ كله)، والأحدث حتى السقف */
export function prunePosted(list: readonly PostedEntry[], fetchedAt: number | null): PostedEntry[] {
  const keep = list.filter((e) => fetchedAt == null || e.at >= fetchedAt);
  return keep.slice(Math.max(0, keep.length - VANLOTS_POSTED_MAX));
}

/** بنود فاتورةٍ أصدرها الخادم (ردّ 201) للأصناف المتتبَّعة: الكمية الأساسية وتشغيلاتها كما وُزّعت */
export function postedItemsFromServer(items: unknown, tracked: ReadonlySet<string>): PostedItem[] {
  if (!Array.isArray(items)) return [];
  const out: PostedItem[] = [];
  for (const it of items as Record<string, unknown>[]) {
    if (!it || typeof it !== 'object' || typeof it.productId !== 'string' || !tracked.has(it.productId)) continue;
    const qty = toBaseQty({ qty: Number(it.qty), unitFactor: it.unitFactor as number | null, baseQty: it.baseQty as number | null });
    if (!(qty > LOT_EPS)) continue;
    const lots = Array.isArray(it.lots)
      ? (it.lots as Record<string, unknown>[]).map((r) => ({ lotId: typeof r?.lotId === 'string' ? r.lotId : null, qty: Number(r?.quantity ?? r?.qty) }))
      : null;
    out.push({ productId: it.productId, qty, lots });
  }
  return out;
}

// ─── المعلّق ───

/** صفوف تلميحٍ صالحة كما يقبلها الخادم (parseLotHint): ≤ LOT_MAX_ROWS، معرّفٌ نصّي أو null، وكمية موجبة — وإلا null */
export function validLotRefs(raw: unknown): LotRef[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > LOT_MAX_ROWS) return null;
  const out: LotRef[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') return null;
    const okId = r.lotId === null || (typeof r.lotId === 'string' && r.lotId.length > 0 && r.lotId.length <= 128);
    if (!okId || !finite(r.qty) || !(r.qty > LOT_EPS)) return null;
    out.push({ lotId: r.lotId as string | null, qty: r.qty });
  }
  return out;
}

/** يضيف إلى المعلّق كمية صنفٍ وتشغيلاتها (يغيّر الخريطة) — refs غائبة = بلا تلميح، تُطرح بالقاعدة */
export function addPending(out: PendingOut, productId: string, qty: number, refs?: readonly LotRef[] | null): void {
  if (!(qty > LOT_EPS)) return;
  let g = out.get(productId);
  if (!g) { g = { total: 0, byLot: new Map() }; out.set(productId, g); }
  g.total += qty;
  for (const r of refs ?? []) g.byLot.set(keyOf(r.lotId), (g.byLot.get(keyOf(r.lotId)) ?? 0) + r.qty);
}

/** بنود مستندٍ واحد: تلميح الصنف يُقبل إن حمله كل سطرٍ منه بمجموعٍ يساوي كميته (D16)، وإلا يُطرح الصنف كله بالقاعدة */
function addDocItems(out: PendingOut, items: readonly { productId: string; qty: number; lots?: unknown }[]): void {
  const byProduct = new Map<string, { qty: number; refs: LotRef[] | null }[]>();
  for (const it of items) {
    if (!(it.qty > LOT_EPS)) continue;
    const refs = validLotRefs(it.lots);
    const ok = refs && Math.abs(refs.reduce((s, r) => s + r.qty, 0) - it.qty) <= LOT_EPS ? refs : null;
    const list = byProduct.get(it.productId) ?? [];
    list.push({ qty: it.qty, refs: ok });
    byProduct.set(it.productId, list);
  }
  for (const [productId, lines] of byProduct) {
    const allHinted = lines.every((l) => l.refs !== null);
    const qty = lines.reduce((s, l) => s + l.qty, 0);
    addPending(out, productId, qty, allHinted ? lines.flatMap((l) => l.refs ?? []) : null);
  }
}

/** فاتورة صفٍّ تُطرح من لقطةٍ بدأ جلبها في fetchedAt؟ — المنتظرة والمرفوضة والموسومة دائماً، والمرسَلة إن أُرسلت بعد بدئه */
function counts(d: OutboxDoc, fetchedAt: number): boolean {
  if (d.status === 'queued' || d.status === 'rejected' || d.reviewCode) return true;
  if (d.status !== 'sent' || !d.sentAt) return false;
  const at = Date.parse(d.sentAt);
  return Number.isFinite(at) && at >= fetchedAt;
}

/**
 * المعلّق على اللقطة لكل صنف: total = Σ الكميات الأساسية، وbyLot ما حمل تلميحاً (والباقي total − Σ byLot يُطرح بالقاعدة).
 * فواتير البيع وحدها، ولمستندات صاحب الجلسة (أو القديمة بلا repId — كما يرفعها الصندوق)؛ والمرتجع المعلّق لا يزيد.
 */
export function pendingOut(outbox: readonly OutboxDoc[], posted: readonly PostedEntry[], fetchedAt: number, repId: string | null | undefined): PendingOut {
  const out: PendingOut = new Map();
  for (const d of outbox) {
    if (d.kind !== 'invoice' || (d.repId && repId && d.repId !== repId) || !counts(d, fetchedAt)) continue;
    const p = d.payload as { type?: unknown; items?: unknown } | null;
    if (!p || typeof p !== 'object' || p.type === 'RETURN' || !Array.isArray(p.items)) continue;
    addDocItems(out, (p.items as Record<string, unknown>[])
      .filter((it) => it && typeof it.productId === 'string')
      .map((it) => ({
        productId: it.productId as string,
        qty: toBaseQty({ qty: Number(it.qty), unitFactor: it.unitFactor as number | null, baseQty: it.baseQty as number | null }),
        lots: it.lots,
      })));
  }
  for (const e of posted) if (e.at >= fetchedAt) addDocItems(out, e.items);
  return out;
}

function clonePending(p: PendingOut): PendingOut {
  return new Map([...p].map(([k, g]) => [k, { total: g.total, byLot: new Map(g.byLot) }]));
}

// ─── المتاح المحلي ───

/** المؤهَّل للبيع يوم today: نشطة، ويوم الانتهاء نفسه صالح، وصالحها موجب */
const sellableOn = (l: SnapLot, today: string): boolean => l.status === 'ACTIVE' && !isLotExpiredOn(l, today) && l.usable > LOT_EPS;

/** تشغيلات الصنف المؤهَّلة للبيع في اللقطة (بلا المعلّق) بترتيب FEFO كما أرسلها الخادم */
export function sellableLots(snap: VanLotSnapshotDto, productId: string, today: string): SnapLot[] {
  return (snapProductOf(snap, productId)?.lots ?? []).filter((l) => sellableOn(l, today));
}

export interface LocalLotView {
  /** كل تشغيلات الصنف في اللقطة بترتيبها، وما بقي من صالحها بعد المعلّق */
  lots: { lot: SnapLot; left: number; sellable: boolean }[];
  unknownLeft: number;
  /** المتاح للبيع: المؤهَّل + غير المسمّى إن سمحت به الشركة (D17) */
  available: number;
}

/**
 * ما يبقى في السيارة بعد المعلّق: التلميح من تشغيلاته إن وسعته كلها (D16)، وإلا الصنف كله بالقاعدة؛ وما بلا تلميح بـFEFO من
 * المؤهَّل ثم من غير المسمّى (طبقتا الإعادة ١ و٢ — allowUnknown لا يقيّدهما). ما زاد على كل ذلك عجزٌ: المتاح صفر.
 */
export function localLotView(snap: VanLotSnapshotDto, productId: string, today: string, pending: PendingOut): LocalLotView {
  const p = snapProductOf(snap, productId);
  const lots = p?.lots ?? [];
  const pool = new Map(lots.map((l) => [l.lotId, Math.max(0, l.usable)]));
  let unknown = Math.max(0, p?.unknownUsable ?? 0);
  let spill = 0;
  const pend = pending.get(productId);
  if (pend && pend.total > LOT_EPS) {
    let named = 0;
    let fits = true;
    for (const [k, q] of pend.byLot) {
      named += q;
      if (q > (k === UNKNOWN_LOT_KEY ? unknown : pool.get(k) ?? 0) + LOT_EPS) fits = false;
    }
    if (fits) {
      for (const [k, q] of pend.byLot) {
        if (k === UNKNOWN_LOT_KEY) unknown = Math.max(0, unknown - q);
        else pool.set(k, Math.max(0, (pool.get(k) ?? 0) - q));
      }
      spill = Math.max(0, pend.total - named);
    } else spill = pend.total;
  }
  for (const l of lots) {
    if (spill <= LOT_EPS) break;
    if (!sellableOn(l, today)) continue;
    const a = pool.get(l.lotId) ?? 0;
    const t = Math.min(a, spill);
    pool.set(l.lotId, a - t);
    spill -= t;
  }
  if (spill > LOT_EPS) unknown = Math.max(0, unknown - spill);
  const view = lots.map((l) => ({ lot: l, left: roundLot(Math.max(0, pool.get(l.lotId) ?? 0)), sellable: sellableOn(l, today) }));
  const named = view.reduce((s, x) => s + (x.sellable ? x.left : 0), 0);
  const unknownLeft = roundLot(unknown);
  return { lots: view, unknownLeft, available: roundLot(named + (snap.allowUnknown ? unknownLeft : 0)) };
}

/** المتاح المحلي للصنف (أساسي): Σ المؤهَّل − المعلّق المسمّى + (allowUnknown ? غير المسمّى − المعلّق الفارغ : 0)، بسماحية 1e-6 */
export function localAvailable(snap: VanLotSnapshotDto, productId: string, today: string, pending: PendingOut): number {
  return localLotView(snap, productId, today, pending).available;
}

const cartonFactor = (F: number | null | undefined): number => (finite(F) && F > 1 ? F : 1);

/**
 * تلميح التوزيع لسطرٍ (D16) بالكمية الأساسية: FEFO من المؤهَّل بعد المعلّق — وللسطر بوحدةٍ معاملها F > 1 مضاعفات F كاملةً من
 * تشغيلةٍ واحدة أولاً (قاعدة الكرتون، D22) — ثم غير المسمّى إن سمحت به الشركة. null إن لم يكفِ المتاح، و[] لكميةٍ صفرية.
 * الكميات بأربع خانات ومجموعها كمية السطر، فيقبلها parseLotHint.
 */
export function localHint(snap: VanLotSnapshotDto, productId: string, baseQty: number, today: string, pending: PendingOut,
  opts?: { unitFactor?: number | null }): LotRef[] | null {
  if (!finite(baseQty) || !(baseQty > LOT_EPS)) return [];
  const v = localLotView(snap, productId, today, pending);
  const cands = v.lots.filter((x) => x.sellable && x.left > LOT_EPS).map((x) => ({ lotId: x.lot.lotId, left: x.left }));
  const take = new Map<string, number>();
  let left = baseQty;
  const add = (k: string, t: number) => {
    take.set(k, (take.get(k) ?? 0) + t);
    left = Math.abs(left - t) <= LOT_EPS ? 0 : left - t;
  };
  const F = cartonFactor(opts?.unitFactor);
  if (F > 1) {
    for (const c of cands) {
      if (left <= LOT_EPS) break;
      const k = Math.floor((Math.min(c.left, left) + LOT_EPS) / F);
      if (k <= 0) continue;
      const t = Math.abs(k * F - left) <= LOT_EPS ? left : k * F;
      add(c.lotId, t);
      c.left -= t;
    }
  }
  for (const c of cands) {
    if (left <= LOT_EPS) break;
    if (c.left <= LOT_EPS) continue;
    const t = c.left >= left - LOT_EPS ? left : c.left;
    add(c.lotId, t);
    c.left -= t;
  }
  if (left > LOT_EPS && snap.allowUnknown && v.unknownLeft > LOT_EPS) add(UNKNOWN_LOT_KEY, v.unknownLeft >= left - LOT_EPS ? left : v.unknownLeft);
  if (left > LOT_EPS) return null;
  const rows = [...take].map(([k, q]) => ({ lotId: k === UNKNOWN_LOT_KEY ? null : k, qty: roundLot(q) })).filter((r) => r.qty > 0);
  // أربع خانات لكل صفّ، والأخير يحمل فرق التقريب فيبقى المجموع كمية السطر
  if (rows.length) {
    const others = rows.slice(0, -1).reduce((s, r) => s + r.qty, 0);
    rows[rows.length - 1].qty = roundLot(roundLot(baseQty) - others);
  }
  return rows.filter((r) => r.qty > 0);
}

export interface CartLotLine { productId: string; baseQty: number; unitFactor?: number | null; tracked: boolean }

/**
 * تلميحات السلّة كلها على متاحٍ مشترك: أسطر الصنف الواحد («٢ كرتون + ٥ حبة») يأخذ كلٌّ مما تركه ما قبله، والكرتون أولاً بمعامله
 * تنازلياً كما يخدمها الخادم (D22). لكل سطرٍ متتبَّع تلميحه أو null إن لم يكفِ المتاح، وundefined لغير المتتبَّع.
 */
export function cartHints(snap: VanLotSnapshotDto, lines: readonly CartLotLine[], today: string, pending: PendingOut): (LotRef[] | null | undefined)[] {
  const out: (LotRef[] | null | undefined)[] = lines.map(() => undefined);
  const pend = clonePending(pending);
  const order = lines.map((l, i) => ({ l, i })).filter((x) => x.l.tracked)
    .sort((a, b) => cartonFactor(b.l.unitFactor) - cartonFactor(a.l.unitFactor) || a.i - b.i);
  for (const { l, i } of order) {
    const h = localHint(snap, l.productId, l.baseQty, today, pend, { unitFactor: l.unitFactor });
    out[i] = h;
    if (h && h.length) addPending(pend, l.productId, h.reduce((s, r) => s + r.qty, 0), h);
  }
  return out;
}

/** أسطر ورقةٍ من تلميح الجهاز — الرقم والانتهاء من اللقطة، وغير المسمّى بلا رقم */
export function hintDocLots(snap: VanLotSnapshotDto, productId: string, hint: readonly LotRef[] | null | undefined): DocLotLine[] | undefined {
  if (!hint || !hint.length) return undefined;
  const byId = new Map((snapProductOf(snap, productId)?.lots ?? []).map((l) => [l.lotId, l]));
  return hint.map((r) => {
    const l = r.lotId ? byId.get(r.lotId) : undefined;
    return { lotNumber: l?.lotNumber ?? null, qty: roundLot(r.qty), expiryDate: lotDay(l?.expiryDate) };
  });
}

// ─── السلّة ───

/** Σ الكمية الأساسية لأسطر الصنف في السلّة (بنود فاتورة البيع المرتبطة خارجها)، عدا السطر skip */
export function cartBaseOf(lines: readonly { productId?: unknown; qty?: unknown; unitFactor?: unknown; saleItemId?: unknown }[], productId: string, skip?: number): number {
  let s = 0;
  lines.forEach((l, i) => {
    if (i === skip || l.productId !== productId || l.saleItemId) return;
    s += toBaseQty({ qty: Number(l.qty) || 0, unitFactor: l.unitFactor as number | null });
  });
  return roundLot(s);
}

/**
 * كمية السطر بوحدته مقصوصةً على ما يسعه المتاح (room أساسي) — بأربع خانات نزولاً، ولا تقلّ عن صفر. وبوحدةٍ أكبر من الأساس (F > 1)
 * يُقبل الكسر الذي يساوي المتّسع تماماً (30 حبة = 1.25 كرتون) وإلا فوحداتٌ كاملة: 0.4166 كرتون = 9.9984 حبة يترك غباراً من حبّةٍ
 * «متاحاً» في السيارة أبداً ويُطبع على الورقة — والباقي بعد الكراتين الكاملة لسطر الأساس
 */
export function capLineQty(want: number, unitFactor: number | null | undefined, room: number): number {
  const F = finite(unitFactor) && unitFactor > 0 ? unitFactor : 1;
  const w = Math.max(0, roundLot(finite(want) ? want : 0));
  const r = Math.max(0, finite(room) ? room : 0);
  let max = Math.floor((r / F) * 1e4 + 1e-6) / 1e4;
  if (F > 1 && Math.abs(max * F - r) > LOT_EPS) max = Math.floor(r / F + LOT_EPS);
  return Math.min(w, max);
}

/**
 * كمية سطرٍ متتبَّع بعد تعديلها (§٦.٣): ما وسعه المتّسع room (أساسي: المتاح − بقية أسطر الصنف) كما هو بأربع خانات، وما زاد يُقصّ
 * إليه بوحدته (capLineQty). وما لا متّسع له أصلاً لا يُصفَّر صامتاً — الخادم يرفض الكمية الصفرية فيُرفض المستند بكل أصنافه، ودون
 * اتصال بعد طباعة ورقته — بل يبقى ما كان (prev) ولا يكبر، ورسالة المنع تقول السبب، والفحص النهائي قبل الصفّ يمنع ما بقي فوقه.
 */
export function fitLineQty(want: number, prev: number, unitFactor: number | null | undefined, room: number): { qty: number; over: boolean } {
  const w = Math.max(0, roundLot(finite(want) ? want : 0));
  const fit = capLineQty(w, unitFactor, room);
  if (fit >= w - LOT_EPS) return { qty: w, over: false };
  if (fit > LOT_EPS) return { qty: fit, over: true };
  const p = Math.max(0, roundLot(finite(prev) ? prev : 0));
  return { qty: p > LOT_EPS ? Math.min(w, p) : w, over: true };
}

// ─── الفحص النهائي دون اتصال ───

/** سطر السلّة كما يفحصه الإصدار دون اتصال — tracked من التطبيق (قائمة اللقطة، وبلاها علم الكتالوج) */
export interface PlanLine { productId: string; qty?: unknown; unitFactor?: unknown; saleItemId?: unknown; tracked: boolean }
/** سبب منع الصفّ: بلا لقطة، أو سطرٌ متتبَّع كميته صفر، أو مجموع أسطر صنفٍ فوق متاحه (cap أساسي) */
export type OfflineLotBlock = { kind: 'noSnapshot' } | { kind: 'zeroQty'; productId: string } | { kind: 'over'; productId: string; cap: number };
export type OfflineLotPlan = { ok: true; hints: (LotRef[] | undefined)[] } | { ok: false; block: OfflineLotBlock };

const planBase = (l: PlanLine): number => toBaseQty({ qty: Number(l.qty) || 0, unitFactor: l.unitFactor as number | null });
const planTracked = (l: PlanLine): boolean => l.tracked === true && !l.saleItemId;

/** أول سطرٍ متتبَّع كميته الأساسية صفر (أو غير صالحة)، وإلا −1 — الخادم يرفض الفاتورة كلها به (qty موجبة) */
export function zeroQtyLine(lines: readonly PlanLine[]): number {
  return lines.findIndex((l) => planTracked(l) && !(planBase(l) > LOT_EPS));
}

/**
 * الفحص النهائي قبل صفّ فاتورة بيعٍ دون اتصال (§٦.٣، §٧.٢، D16): بلا صنفٍ متتبَّع لا شيء؛ وبلا لقطةٍ لا يُباع المتتبَّع؛ والسطر
 * المتتبَّع الصفري يُمنع؛ ومجموع أسطر كل صنفٍ (بالأساس) فوق متاحه المحلي يُمنع بالمتاح؛ وإلا تلميح التوزيع لكل سطرٍ متتبَّع
 * (cartHints: الكرتون أولاً على متاحٍ مشترك) — وundefined لغيره.
 */
export function offlineLotPlan(snap: VanLotSnapshotDto | null | undefined, lines: readonly PlanLine[], today: string, pending: PendingOut): OfflineLotPlan {
  if (!lines.some(planTracked)) return { ok: true, hints: lines.map(() => undefined) };
  if (!snap) return { ok: false, block: { kind: 'noSnapshot' } };
  const z = zeroQtyLine(lines);
  if (z >= 0) return { ok: false, block: { kind: 'zeroQty', productId: lines[z].productId } };
  for (const pid of new Set(lines.filter(planTracked).map((l) => l.productId))) {
    const cap = localAvailable(snap, pid, today, pending);
    if (cartBaseOf(lines, pid) > cap + LOT_EPS) return { ok: false, block: { kind: 'over', productId: pid, cap } };
  }
  const hints = cartHints(snap, lines.map((l) => ({
    productId: l.productId, baseQty: planBase(l), unitFactor: l.unitFactor as number | null, tracked: planTracked(l),
  })), today, pending);
  const short = hints.findIndex((h) => h === null);
  if (short >= 0) {
    const pid = lines[short].productId;
    return { ok: false, block: { kind: 'over', productId: pid, cap: localAvailable(snap, pid, today, pending) } };
  }
  return { ok: true, hints: hints.map((h) => h ?? undefined) };
}

// ─── ردّ الإصدار المتصل ───

/**
 * تشغيلات كل سطرٍ من ردّ 201 (`inv.items[].lots`): بند المرتجع المرتبط ببند بيعه (returnOfItemId)، وغيره بالصنف — والصنف نفسه
 * في سطرين («كرتون + حبة») يُطابَق بلقطة معامل وحدته ثم بكميته (البند لا يحمل معرّف الوحدة)، وكل بندٍ يُستعمل مرة.
 * سطرٌ بلا مطابقة undefined.
 */
export function matchServerItemLots(
  lines: readonly { productId: string; unitFactor?: unknown; qty?: unknown; saleItemId?: string | null }[],
  items: unknown,
): (DocLotLine[] | undefined)[] {
  const pool = Array.isArray(items) ? (items as Record<string, unknown>[]).filter((x) => x && typeof x === 'object') : [];
  const used = new Set<number>();
  const pick = (ok: (it: Record<string, unknown>) => boolean): Record<string, unknown> | undefined => {
    const i = pool.findIndex((it, j) => !used.has(j) && ok(it));
    if (i < 0) return undefined;
    used.add(i);
    return pool[i];
  };
  const factor = (x: unknown) => { const f = Number(x); return Number.isFinite(f) && f > 0 ? f : 1; };
  return lines.map((l) => {
    const same = (x: Record<string, unknown>) => x.productId === l.productId && !x.returnOfItemId;
    const sameUnit = (x: Record<string, unknown>) => same(x) && Math.abs(factor(x.unitFactor) - factor(l.unitFactor)) <= 1e-9;
    const it = l.saleItemId
      ? pick((x) => x.returnOfItemId === l.saleItemId)
      : pick((x) => sameUnit(x) && Number(x.qty) === Number(l.qty)) ?? pick(sameUnit) ?? pick(same);
    return it ? docLotsFrom(it.lots) : undefined;
  });
}

// ─── الصندوق ───

/** يُختم المستند لحظة انتقاله إلى «مُرسَل» (sentAt) — به يُعرف أأرسل قبل بدء جلب اللقطة أم بعده. والمختوم يبقى ختمه */
export function withSentAt<T extends { status?: string; sentAt?: string }>(doc: T, nowIso: string): T {
  return doc.status === 'sent' && !doc.sentAt ? { ...doc, sentAt: nowIso } : doc;
}

/** فاتورة دون اتصال بانتظار الإدارة لتسجيل التحميل الناقص (D20) — المصفوفة وحدها */
export function underLotReplayHeld(doc: Pick<OutboxDoc, 'reviewCode'> & Partial<Pick<OutboxDoc, 'status'>>): boolean {
  return doc.reviewCode === LOT_REPLAY_HELD_CODE && doc.status !== 'rejected' && doc.status !== 'sent';
}
