/**
 * «تتبّع اللوط» (التشغيلة) — القواعد الصرفة: الثوابت والطيّ والعروض والتوزيع والأقفال والأخطاء.
 *
 * صرفةٌ بلا قاعدة ولا Prisma ولا مسار: تستورد node:crypto و./shelfLife وحدهما، لأن فرعي إصدار المرحلة الثانية يستوردان
 * منها وهما ممنوعان من القاعدة (invoices-phase2-static.test.ts). التجميع في SQL والأقفال في services/lotsDb.ts.
 *
 * المبادئ (المواصفة §٠):
 * - **الرصيد مشتق لا مخزَّن** (D1): الخام لكل (لوط، مكان، دلو) طيُّ صفوف التوزيع بعد حقبة الصنف، مقرَّباً لأربع خانات
 *   كرصيد الصنف. فالإلغاء والإبطال وتبديل العودة للمخزون تغيّر حالة المستند وحدها والخام يتبعها.
 * - **لا تطبيع** (D3): غير المسمّى = رصيد الصنف − Σ الخام المسمّى، وقد يكون سالباً من تاريخٍ سالب قبل التفعيل فيُعرض
 *   «عجزاً»، ولا يُقتطع من لوط مسمّى أبداً لسدّ نقصٍ في رصيد الصنف.
 * - **المحجوز** (D24): مرتجع إشعارٍ قياسي «01» ما زال قابلاً للإبطال داخلٌ في الخام وخارجٌ عن الصالح للإنقاص، فإبطاله
 *   لا يُنتج سالباً بالبناء.
 * - I1: لا تجعل عملية مُنقِصة صالحَ لوطٍ مسمّى سالباً. I2: ولا تُنقص صالح غير المسمّى دون min(0, قبلها) − EPS.
 * - كل كمية هنا بوحدة الأساس (D22).
 *
 * التواقيع المصدَّرة مجمَّدة (§٢): لا يغيّرها أحد إلا بطلبٍ إلى مالك الأساس.
 */
import { createHash } from 'node:crypto';
import { localDateIn } from './shelfLife';

// ═══ §٢.١ الثوابت والأنواع ═══

export const LOT_EPS = 1e-6;

/**
 * تقريب ٤ خانات نصف لأعلى — مساوٍ لـroundDecimal(n, 4) الذي يقرّب به رصيد الصنف (vanStock.ts:163، warehouseStock.ts:114).
 * نسخة حرفية من roundHalfUp (lib/money.ts) لأن الوحدة لا تستورد غير shelfLife؛ واختبار lots-fold يثبّت تطابقهما.
 */
export function roundLot(n: number): number {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, 4);
  const scaled = Number((n * f).toPrecision(12));
  const sign = scaled < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(scaled))) / f;
}

/**
 * كميةٌ صالحة لصنفٍ متتبَّع: موجبة ومُمثَّلة بأربع خانات — دقّة الطيّ ورصيد الصنف (roundLot). كسرٌ أدقّ يجعل الصالح المعروض
 * (المقرَّب) أكبر من الخام الفعلي فيُنقَص بأكثر منه (I1): وارد 1.00105 يُعرض 1.0011 فيُصرف كله والخام −0.00005.
 * يرفضها LOT_QTY_INVALID في المسار الحيّ والإداري والمفتاح (هنا وفي كل حزمة تكتب زيادة)؛ والإعادة لا تُرفض بها (R6).
 */
export function isLotQty(q: number): boolean {
  return Number.isFinite(q) && q > LOT_EPS && Math.abs(roundLot(q) - q) <= 1e-9 * Math.max(1, Math.abs(q));
}

export const LOT_STATUSES = ['ACTIVE', 'BLOCKED'] as const;
export const LOT_BLOCK_KINDS = ['HOLD', 'RECALL'] as const;
export const LOT_CERTAINTIES = ['CONFIRMED', 'ASSUMED', 'UNKNOWN'] as const;
export const LOT_BUCKETS = ['SELLABLE', 'EXPIRED', 'DAMAGED'] as const;
export const LOT_PLACES = ['WAREHOUSE', 'VAN'] as const;
export const LOT_SOURCES = ['RECEIVE', 'LOAD', 'OPENING_IMPORT', 'RELABEL', 'RETURN', 'MANUAL'] as const;
export const LOT_RELABEL_REASONS = ['LABEL_EXISTING', 'RECLASSIFY', 'CORRECTION'] as const;
export const LOT_ROW_FLAGS = ['REPLAY_BLOCKED', 'REPLAY_RECALLED', 'REPLAY_EXPIRED', 'REPLAY_CLAMPED', 'HINT_REJECTED', 'SPLIT_UNIT'] as const;
export const LOT_EVENT_KINDS = ['CREATE', 'UPDATE_DATES', 'UPDATE_NOTE', 'BLOCK', 'UNBLOCK', 'DELETE', 'RELABEL', 'TRACKING_ON', 'TRACKING_OFF'] as const;
export const LOT_VAN_REASONS = ['EXPIRED_UNSOLD_DESTROY'] as const;
/** = loadSchema.type (vanStock.ts:28) — لا نوع حركة جديد (حارس نصّي: كل نوع غيرها يقع في m.adjusted، vanStock.ts:134) */
export const VAN_MOVE_TYPES = ['LOAD', 'UNLOAD', 'ADJUST', 'EXPIRED_OUT', 'DAMAGED_OUT'] as const;
/** = VOIDABLE_MIRRORS (compliance/zatca/void.ts:54) حرفياً — اختبار مساواة (D24) */
export const LOT_HOLD_MIRRORS = ['clearance_pending', 'clearance_blocked', 'rejected', 'withdrawn'] as const;
export const LOT_REPLAY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const LOT_MAX_ROWS = 20;            // صفوف لوط لكل سطر في الطلب
export const LOT_NUMBER_MAX = 64;

export type LotStatus = typeof LOT_STATUSES[number];
export type LotBlockKind = typeof LOT_BLOCK_KINDS[number];
export type LotCertainty = typeof LOT_CERTAINTIES[number];
export type LotBucket = typeof LOT_BUCKETS[number];
export type LotPlace = typeof LOT_PLACES[number];
export type LotRowFlag = typeof LOT_ROW_FLAGS[number];
export type VanMoveType = typeof VAN_MOVE_TYPES[number];
export type LotSource = typeof LOT_SOURCES[number];
export type LotRelabelReason = typeof LOT_RELABEL_REASONS[number];
export type LotEventKind = typeof LOT_EVENT_KINDS[number];
export type LotActor = 'REP' | 'ADMIN' | 'API_KEY';
export type BucketQty = Record<LotBucket, number>;
export function zeroBuckets(): BucketQty {
  return { SELLABLE: 0, EXPIRED: 0, DAMAGED: 0 };
}

export interface LotMeta {
  id: string; productId: string; lotNumber: string;
  productionDate: string | null; expiryDate: string | null;   // YYYY-MM-DD
  status: LotStatus; blockKind: LotBlockKind | null; blockedAt: Date | null; createdAt: Date;
}

// ═══ §٢.٢ صفوف التجميع (تنتجها lotsDb.ts من SQL) ═══
// كل الكميات مجاميع أساسية. الحقبة مطبَّقة في SQL على صفوف اللوط، أما مجاميع رصيد الصنف فتشمل التاريخ كله.

/** مفاتيح التوجيه كما يقرؤها foldStock (vanStock.ts:136-145) — damaged محسوب في SQL من returnReason وcreatedAt وDAMAGED_VAN_SINCE (vanDamaged.ts:10-14) */
export interface InvRouteKey { type: string; returnToStock: boolean | null; returnExpired: boolean | null; damaged: boolean }

export interface AggWhLot   { productId: string; lotId: string | null; qty: number }                          // warehouse_entry_items بإشارتها
export interface AggVanLot  { productId: string; lotId: string | null; vanKey: string; moveType: VanMoveType; viaWarehouse: boolean; qty: number; firstInAt: Date | null }
/** firstAt: أقدم صفّ في المجموعة — لأول دخول اللوط إلى السيارة بمرتجعٍ عائد للمخزون (طبقة الإعادة ١) */
export interface AggInvLot  { productId: string; lotId: string | null; vanKey: string | null; route: InvRouteKey; held: boolean; qty: number; firstAt?: Date | null } // فواتير CONFIRMED وحدها
/** firstAt: أقدم تسميةٍ موجبة في المجموعة — التسمية إلى لوطٍ في السيارة دخولٌ له (طبقة الإعادة ١) */
export interface AggRelabel { productId: string; place: LotPlace; vanKey: string | null; bucket: LotBucket; fromLotId: string | null; toLotId: string | null; qty: number; firstAt?: Date | null }

// ═══ §٢.٣ القواعد الصرفة ═══

const ARABIC_INDIC_ZERO = 0x0660;
const PERSIAN_ZERO = 0x06f0;
/** محارف اتجاه وعرضٍ صفري تلتصق بالنص المنسوخ من واجهة عربية — لا تُرى فتصنع رقمين «متطابقين» مختلفين */
const INVISIBLE_RE = /[​-‏‪-‮⁦-⁩﻿؜]/g;

/**
 * تطبيع رقم التشغيلة: قصّ الأطراف، دمج المسافات، الأرقام العربية-الهندية والفارسية إلى لاتينية، الحروف اللاتينية كبيرة،
 * وحذف محارف الاتجاه غير المرئية. الفارغ null، والأطول من LOT_NUMBER_MAX null أيضاً (لا قصّ: القصّ يدمج تشغيلتين).
 */
export function normalizeLotNumber(raw: unknown): string | null {
  let s: string;
  if (typeof raw === 'string') s = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) s = String(raw);
  else return null;
  s = s
    .replace(INVISIBLE_RE, '')
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - ARABIC_INDIC_ZERO))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - PERSIAN_ZERO))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[a-z]/g, (c) => c.toUpperCase());
  if (!s || s.length > LOT_NUMBER_MAX) return null;
  return s;
}

/** تاريخٌ مجرّد صالح YYYY-MM-DD (لا ٣٠ فبراير) */
function isIsoDay(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** تاريخا اللوط: صيغةٌ صالحة، والإنتاج لا يتأخر عن الانتهاء، والانتهاء إلزامي لصنف صلاحيته مفعّلة. الفارغ '' كغياب */
export function lotDatesProblem(production: string | null, expiry: string | null, opts: { expiryRequired: boolean }): 'LOT_DATES_INVALID' | 'LOT_EXPIRY_REQUIRED' | null {
  const p = production === '' ? null : production;
  const e = expiry === '' ? null : expiry;
  if (p != null && !isIsoDay(p)) return 'LOT_DATES_INVALID';
  if (e != null && !isIsoDay(e)) return 'LOT_DATES_INVALID';
  if (opts.expiryRequired && e == null) return 'LOT_EXPIRY_REQUIRED';
  if (p != null && e != null && p > e) return 'LOT_DATES_INVALID';
  return null;
}

/** منتهٍ يوم `day` (YYYY-MM-DD)؟ يوم الانتهاء نفسه آخر يومٍ صالح (isExpiredOn في invoiceExpiry.ts:31-33) */
export function isLotExpiredOn(meta: Pick<LotMeta, 'expiryDate'>, day: string): boolean {
  return meta.expiryDate != null && day > meta.expiryDate;
}

const cmpNullLast = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
};
const cmpStr = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

/** FEFO: الانتهاء تصاعدياً (null آخراً)، ثم الإنتاج تصاعدياً (null آخراً)، ثم createdAt، ثم lotNumber، ثم id */
export function fefoCompare(a: LotMeta, b: LotMeta): number {
  return cmpNullLast(a.expiryDate, b.expiryDate)
    || cmpNullLast(a.productionDate, b.productionDate)
    || (a.createdAt.getTime() - b.createdAt.getTime())
    || cmpStr(a.lotNumber, b.lotNumber)
    || cmpStr(a.id, b.id);
}

/**
 * أثر صفّ فاتورةٍ مؤكَّدة على دلاء السيارة — مطابقة حرفية لـaddInv (vanStock.ts:136-145):
 * غير المرتجع ⇒ SELLABLE −؛ المرتجع المنتهي ⇒ EXPIRED +؛ ثم التالف ⇒ DAMAGED +؛ ثم العائد للمخزون ⇒ SELLABLE +؛ وإلا لا أثر.
 */
export function invEffect(route: InvRouteKey): { bucket: LotBucket; sign: 1 | -1 } | null {
  if (route.type !== 'RETURN') return { bucket: 'SELLABLE', sign: -1 };
  if (route.returnExpired) return { bucket: 'EXPIRED', sign: 1 };
  if (route.damaged) return { bucket: 'DAMAGED', sign: 1 };
  if (route.returnToStock) return { bucket: 'SELLABLE', sign: 1 };
  return null;
}

/**
 * أثر حركة سيارة — مطابقة لـaddLoad (vanStock.ts:129-135) مع bucketRemaining (163): LOAD ⇒ SELLABLE +؛ UNLOAD ⇒ SELLABLE −؛
 * EXPIRED_OUT ⇒ EXPIRED −؛ DAMAGED_OUT ⇒ DAMAGED −؛ وADJUST (وأي نوعٍ غيرها كما في foldStock) ⇒ SELLABLE بإشارة الكمية.
 */
export function vanMoveEffect(t: VanMoveType): { bucket: LotBucket; sign: 1 | -1 } {
  if (t === 'LOAD') return { bucket: 'SELLABLE', sign: 1 };
  if (t === 'UNLOAD') return { bucket: 'SELLABLE', sign: -1 };
  if (t === 'EXPIRED_OUT') return { bucket: 'EXPIRED', sign: -1 };
  if (t === 'DAMAGED_OUT') return { bucket: 'DAMAGED', sign: -1 };
  return { bucket: 'SELLABLE', sign: 1 };
}

/** الكمية الأساسية للسطر: baseQty ?? qty × (unitFactor ?? 1) — على master = qty (D22، D19) */
export function lotBaseQty(row: { qty: number; baseQty?: number | null; unitFactor?: number | null }): number {
  if (row.baseQty != null && Number.isFinite(row.baseQty)) return row.baseQty;
  const f = row.unitFactor != null && Number.isFinite(row.unitFactor) ? row.unitFactor : 1;
  return row.qty * f;
}

/**
 * لحظة البيع ويومه عند الإعادة دون اتصال (D23): clientCreatedAt محصوراً بين «الآن − ٧ أيام» و«الآن»، ويُوسَم الحصر.
 * null إن لم يكن تاريخاً صالحاً. الشروط (مندوب، ترويسة الإعادة، clientRef) يفحصها المستدعي.
 */
export function replayMoment(clientCreatedAt: unknown, now: Date, tz: string): { at: Date; day: string; clamped: boolean } | null {
  let t: number;
  if (clientCreatedAt instanceof Date) t = clientCreatedAt.getTime();
  else if (typeof clientCreatedAt === 'string' && clientCreatedAt.trim()) t = Date.parse(clientCreatedAt);
  else if (typeof clientCreatedAt === 'number') t = clientCreatedAt;
  else return null;
  if (!Number.isFinite(t)) return null;
  const hi = now.getTime();
  const lo = hi - LOT_REPLAY_MAX_AGE_MS;
  const c = Math.min(hi, Math.max(lo, t));
  const at = new Date(c);
  return { at, day: localDateIn(at, tz), clamped: c !== t };
}

/** يوم الشركة للحظة بمنطقتها = localDateIn (shelfLife.ts:55) */
export function companyDayOf(at: Date, tz: string): string {
  return localDateIn(at, tz);
}

// ═══ §٢.٤ الطيّ والعروض ═══

export interface LotRaw { raw: BucketQty; held: BucketQty }

const roundBuckets = (b: BucketQty): BucketQty => ({ SELLABLE: roundLot(b.SELLABLE), EXPIRED: roundLot(b.EXPIRED), DAMAGED: roundLot(b.DAMAGED) });
const nz = (n: number) => (n === 0 ? 0 : n); // -0 ⇒ 0 للعرض

function nested<V>(m: Map<string, Map<string, V>>, a: string, b: string, init: () => V): V {
  let inner = m.get(a);
  if (!inner) { inner = new Map(); m.set(a, inner); }
  let v = inner.get(b);
  if (v === undefined) { v = init(); inner.set(b, v); }
  return v;
}

/**
 * خام لوطات المستودع لكل صنف: Σ أسطر المستودع + Σ تنزيلات السيارات بـviaWarehouse − Σ تحميلاتها بـviaWarehouse ± التسميات
 * في المستودع. الصفوف الفارغة (lotId null) تُتخطّى (D3)، وتحميلٌ بلا مستودع (viaWarehouse=false، D4) لا يمسّه (D28).
 */
export function foldWarehouseLots(wh: AggWhLot[], van: AggVanLot[], rel: AggRelabel[]): Map<string /*productId*/, Map<string /*lotId*/, number>> {
  const acc = new Map<string, Map<string, { v: number }>>();
  const add = (pid: string, lotId: string | null, q: number) => {
    if (lotId == null) return;
    nested(acc, pid, lotId, () => ({ v: 0 })).v += q;
  };
  for (const r of wh) add(r.productId, r.lotId, r.qty);
  for (const r of van) {
    if (!r.viaWarehouse) continue;
    if (r.moveType === 'UNLOAD') add(r.productId, r.lotId, r.qty);
    else if (r.moveType === 'LOAD') add(r.productId, r.lotId, -r.qty);
  }
  for (const r of rel) {
    if (r.place !== 'WAREHOUSE') continue;
    add(r.productId, r.fromLotId, -r.qty);
    add(r.productId, r.toLotId, r.qty);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [pid, m] of acc) out.set(pid, new Map([...m].map(([lot, x]) => [lot, nz(roundLot(x.v))])));
  return out;
}

/**
 * خام لوطات سيارة `vanKey` لكل صنف ودلو: vanMoveEffect لصفوف الحركة، وinvEffect لصفوف الفواتير المؤكَّدة، ± التسميات فيها.
 * held يجمع صفوف الفواتير المحجوزة (D24) في دلوها؛ وheldUnknown المحجوز من الصفوف الفارغة بعد الحقبة وحدها (والعرض يحسب
 * المحجوز غير المسمّى الكامل بـheldUnknownOf). firstInAt أول دخول موجب للوط إلى SELLABLE في السيارة — تحميل أو تسوية
 * بالزيادة أو تسمية إليه أو مرتجعٌ عائد للمخزون — لطبقة الإعادة ١.
 */
export function foldVanLots(van: AggVanLot[], inv: AggInvLot[], rel: AggRelabel[], vanKey: string):
  { named: Map<string, Map<string, LotRaw>>; heldUnknown: Map<string, BucketQty>; firstInAt: Map<string, Map<string, Date>> } {
  const named = new Map<string, Map<string, LotRaw>>();
  const heldUnknown = new Map<string, BucketQty>();
  const firstInAt = new Map<string, Map<string, Date>>();
  const lot = (pid: string, lotId: string) => nested(named, pid, lotId, () => ({ raw: zeroBuckets(), held: zeroBuckets() }));
  const entered = (pid: string, lotId: string, at: Date | null | undefined) => {
    if (!at) return;
    let m = firstInAt.get(pid);
    if (!m) { m = new Map(); firstInAt.set(pid, m); }
    const prev = m.get(lotId);
    if (!prev || at < prev) m.set(lotId, at);
  };
  for (const r of van) {
    if (r.vanKey !== vanKey || r.lotId == null) continue;
    const e = vanMoveEffect(r.moveType);
    lot(r.productId, r.lotId).raw[e.bucket] += e.sign * r.qty;
    if (r.moveType === 'LOAD' || r.moveType === 'ADJUST') entered(r.productId, r.lotId, r.firstInAt);
  }
  for (const r of inv) {
    if (r.vanKey !== vanKey) continue;
    const e = invEffect(r.route);
    if (!e) continue;
    const q = e.sign * r.qty;
    if (r.lotId == null) {
      if (r.held) {
        let h = heldUnknown.get(r.productId);
        if (!h) { h = zeroBuckets(); heldUnknown.set(r.productId, h); }
        h[e.bucket] += q;
      }
      continue;
    }
    const x = lot(r.productId, r.lotId);
    x.raw[e.bucket] += q;
    if (r.held) x.held[e.bucket] += q;
    if (e.bucket === 'SELLABLE' && e.sign > 0 && r.qty > 0) entered(r.productId, r.lotId, r.firstAt);
  }
  for (const r of rel) {
    if (r.place !== 'VAN' || r.vanKey !== vanKey) continue;
    if (r.fromLotId != null) lot(r.productId, r.fromLotId).raw[r.bucket] -= r.qty;
    if (r.toLotId != null) {
      lot(r.productId, r.toLotId).raw[r.bucket] += r.qty;
      if (r.bucket === 'SELLABLE' && r.qty > 0) entered(r.productId, r.toLotId, r.firstAt);
    }
  }
  for (const m of named.values()) {
    for (const x of m.values()) { x.raw = roundBuckets(x.raw); x.held = roundBuckets(x.held); }
  }
  for (const [pid, h] of heldUnknown) heldUnknown.set(pid, roundBuckets(h));
  return { named, heldUnknown, firstInAt };
}

/**
 * المحجوز غير المسمّى (D24) = المحجوز الكلي في المكان − Σ محجوز اللوطات المسمّاة. المحجوز الكلي من **بنود** الفواتير
 * المحجوزة لكل التاريخ (كرصيد الصنف، بلا حقبة)، والمسمّى من صفوف اللوط بعد الحقبة. فمرتجعٌ قياسي «01» قابلٌ للإبطال كُتب قبل
 * التفعيل أو في حقبةٍ سابقة أو بلا صفوف داخلٌ في غير المسمّى ومحجوزٌ فيه: إبطاله يُنقص غير المسمّى ومحجوزه معاً فلا يمسّ صالحه.
 */
export function heldUnknownOf(heldTotal: BucketQty, named: ReadonlyMap<string, LotRaw>): BucketQty {
  const out = { ...heldTotal };
  for (const x of named.values()) for (const b of LOT_BUCKETS) out[b] -= x.held[b];
  return roundBuckets(out);
}

export interface LotBalance { lotId: string; meta: LotMeta; raw: BucketQty; held: BucketQty; usable: BucketQty /* raw − held */ }
export interface PlaceLotView {
  productId: string; place: LotPlace; vanKey: string | null;
  total: BucketQty | null;          // رصيد الصنف القائم؛ null لسيارة مندوب محذوف (approximate)
  lots: LotBalance[];               // بترتيب fefoCompare
  unknown: BucketQty | null;        // total − Σ raw (قد يكون سالباً)
  unknownUsable: BucketQty | null;  // unknown − heldUnknown
  deficits: { lotId: string | null; bucket: LotBucket; qty: number }[]; // كل خام أو صالح سالب — للشارة و/lots/health
  firstInAt: Map<string, Date>;     // أول دخول موجب لكل لوط إلى السيارة (لطبقة الإعادة ١)
  approximate: boolean;
}

/** لوطٌ بلا بطاقة في `metas` (لا يقع إلا بخلل): يُعرض موقوفاً فلا يُباع ولا يُحمَّل منه (فشلٌ مغلق) ويبقى في Σ الخام */
function orphanMeta(lotId: string, productId: string): LotMeta {
  return { id: lotId, productId, lotNumber: '?', productionDate: null, expiryDate: null, status: 'BLOCKED', blockKind: null, blockedAt: null, createdAt: new Date(0) };
}

/**
 * عرض صنفٍ في مكان: الخام والمحجوز والصالح لكل لوط مسمّى، وغير المسمّى = total − Σ الخام (قد يكون سالباً، ولا يُقتطع من لوط)،
 * والعجوزات. total = null (سيارة مندوب محذوف، أو قراءة بلا مجاميع) ⇒ غير المسمّى مجهول وapproximate.
 */
export function buildPlaceView(input: {
  productId: string; place: LotPlace; vanKey: string | null; total: BucketQty | null;
  named: ReadonlyMap<string, LotRaw>; heldUnknown: BucketQty; metas: ReadonlyMap<string, LotMeta>; firstInAt?: ReadonlyMap<string, Date>;
}): PlaceLotView {
  const lots: LotBalance[] = [];
  const sumRaw = zeroBuckets();
  for (const [lotId, x] of input.named) {
    const raw = roundBuckets(x.raw);
    const held = roundBuckets(x.held);
    const usable = roundBuckets({ SELLABLE: raw.SELLABLE - held.SELLABLE, EXPIRED: raw.EXPIRED - held.EXPIRED, DAMAGED: raw.DAMAGED - held.DAMAGED });
    for (const b of LOT_BUCKETS) sumRaw[b] += raw[b];
    lots.push({ lotId, meta: input.metas.get(lotId) ?? orphanMeta(lotId, input.productId), raw, held, usable });
  }
  lots.sort((a, b) => fefoCompare(a.meta, b.meta));
  const total = input.total ? roundBuckets(input.total) : null;
  const unknown = total
    ? roundBuckets({ SELLABLE: total.SELLABLE - sumRaw.SELLABLE, EXPIRED: total.EXPIRED - sumRaw.EXPIRED, DAMAGED: total.DAMAGED - sumRaw.DAMAGED })
    : null;
  const hu = roundBuckets(input.heldUnknown);
  const unknownUsable = unknown
    ? roundBuckets({ SELLABLE: unknown.SELLABLE - hu.SELLABLE, EXPIRED: unknown.EXPIRED - hu.EXPIRED, DAMAGED: unknown.DAMAGED - hu.DAMAGED })
    : null;
  const deficits: PlaceLotView['deficits'] = [];
  for (const l of lots) {
    for (const b of LOT_BUCKETS) {
      const worst = Math.min(l.raw[b], l.usable[b]);
      if (worst < -LOT_EPS) deficits.push({ lotId: l.lotId, bucket: b, qty: worst });
    }
  }
  if (unknown && unknownUsable) {
    for (const b of LOT_BUCKETS) {
      const worst = Math.min(unknown[b], unknownUsable[b]);
      if (worst < -LOT_EPS) deficits.push({ lotId: null, bucket: b, qty: worst });
    }
  }
  return {
    productId: input.productId, place: input.place, vanKey: input.vanKey,
    total, lots, unknown, unknownUsable, deficits,
    firstInAt: new Map(input.firstInAt ?? []),
    approximate: total === null,
  };
}

/** مؤهَّل للبيع والتحميل يوم `day`: ACTIVE، لم ينتهِ، وصالحه في SELLABLE > EPS */
function isEligible(l: LotBalance, day: string): boolean {
  return l.meta.status === 'ACTIVE' && !isLotExpiredOn(l.meta, day) && l.usable.SELLABLE > LOT_EPS;
}

const unknownUsableOf = (view: PlaceLotView, bucket: LotBucket): number => view.unknownUsable?.[bucket] ?? 0;

/** تقسيم المتاح لعرض المكان يوم `day` — للقطة والشاشات ورسائل النقص */
export function splitAvailability(view: PlaceLotView, day: string, opts: { allowUnknown: boolean }): {
  available: number; availableNamed: number; availableUnknown: number;
  quarantined: number;      // صالح SELLABLE لـBLOCKED
  expiredUnsold: number;    // صالح SELLABLE لـACTIVE منتهٍ
  held: number;             // Σ المحجوز في SELLABLE (مسمّى + فارغ)
  expiredReturned: number; damaged: number;
  unknownDeficit: number;   // max(0, −unknown.SELLABLE)
} {
  let availableNamed = 0, quarantined = 0, expiredUnsold = 0, heldNamed = 0;
  const rawSum = zeroBuckets();
  for (const l of view.lots) {
    const u = l.usable.SELLABLE;
    heldNamed += l.held.SELLABLE;
    for (const b of LOT_BUCKETS) rawSum[b] += l.raw[b];
    if (isEligible(l, day)) availableNamed += u;
    else if (u > LOT_EPS) {
      if (l.meta.status !== 'ACTIVE') quarantined += u;
      else if (isLotExpiredOn(l.meta, day)) expiredUnsold += u;
    }
  }
  const uu = unknownUsableOf(view, 'SELLABLE');
  const availableUnknown = opts.allowUnknown && uu > LOT_EPS ? uu : 0;
  const heldUnknownS = view.unknown && view.unknownUsable ? view.unknown.SELLABLE - view.unknownUsable.SELLABLE : 0;
  return {
    available: nz(roundLot(availableNamed + availableUnknown)),
    availableNamed: nz(roundLot(availableNamed)),
    availableUnknown: nz(roundLot(availableUnknown)),
    quarantined: nz(roundLot(quarantined)),
    expiredUnsold: nz(roundLot(expiredUnsold)),
    held: nz(roundLot(heldNamed + heldUnknownS)),
    expiredReturned: nz(roundLot(view.total ? view.total.EXPIRED : rawSum.EXPIRED)),
    damaged: nz(roundLot(view.total ? view.total.DAMAGED : rawSum.DAMAGED)),
    unknownDeficit: view.unknown && view.unknown.SELLABLE < -LOT_EPS ? nz(roundLot(-view.unknown.SELLABLE)) : 0,
  };
}

// ═══ §٢.٥ التجميع والتحقق من الطلب ═══

export interface LotRef { lotId: string | null; qty: number }
/** مفتاح الفارغ (غير المسمّى) في خرائط التجميع */
export const LOT_UNKNOWN_KEY = '∅';
const keyOf = (lotId: string | null) => (lotId == null ? LOT_UNKNOWN_KEY : lotId);
const lotOfKey = (k: string) => (k === LOT_UNKNOWN_KEY ? null : k);

/** صفوف لوطٍ من جسم الطلب — null عند أي خلل (ومنه كميةٌ بأكثر من أربع خانات، isLotQty) */
function refsFrom(raw: unknown): LotRef[] | null {
  if (!Array.isArray(raw) || raw.length > LOT_MAX_ROWS) return null;
  const out: LotRef[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    const { lotId, qty } = x as { lotId?: unknown; qty?: unknown };
    if (!(lotId === null || (typeof lotId === 'string' && lotId.length > 0 && lotId.length <= 128))) return null;
    if (typeof qty !== 'number' || !isLotQty(qty)) return null;
    out.push({ lotId, qty });
  }
  return out;
}

/**
 * صفوف اللوط الصريحة من الإدارة أو المفتاح: مصفوفة ≤ LOT_MAX_ROWS من {lotId: نصّ أو null، qty موجبة بأربع خانات}، ومجموعها = كمية السطر
 * الأساسية. الغائب أو المصفوفة الفارغة ⇒ [] (بلا صريح: يوزّع الخادم). أي خلل ⇒ LotError('LOT_QTY_INVALID').
 */
export function parseLotRefsStrict(raw: unknown, lineBaseQty: number): LotRef[] | LotError {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw) && raw.length === 0) return [];
  const refs = refsFrom(raw);
  if (!refs) return lotErr('LOT_QTY_INVALID');
  const sum = refs.reduce((s, r) => s + r.qty, 0);
  if (!Number.isFinite(lineBaseQty) || Math.abs(sum - lineBaseQty) > LOT_EPS) return lotErr('LOT_QTY_INVALID', {}, { wanted: lineBaseQty, sum });
  return refs;
}

/** تلميح الجهاز عند الإعادة (D16، ن٢-٩): بتسامح — أي خلل ⇒ null فيوزّع الخادم بالطبقات */
export function parseLotHint(raw: unknown): LotRef[] | null {
  if (raw === undefined || raw === null) return null;
  const refs = refsFrom(raw);
  return refs && refs.length ? refs : null;
}

/** يجمع الطلب كله لكل (صنف، لوط أو فارغ) قبل أي فحص (D26) — صفّان على لوط واحد يُفحصان معاً لا كلٌّ وحده */
export function aggregateRequest(lines: { idx: number; productId: string; qty: number; refs?: LotRef[] | null }[]):
  Map<string /*productId*/, { qty: number; byLot: Map<string /*lotId أو '∅'*/, number>; lines: { idx: number; qty: number }[] }> {
  const out = new Map<string, { qty: number; byLot: Map<string, number>; lines: { idx: number; qty: number }[] }>();
  for (const l of lines) {
    let g = out.get(l.productId);
    if (!g) { g = { qty: 0, byLot: new Map(), lines: [] }; out.set(l.productId, g); }
    g.qty += l.qty;
    g.lines.push({ idx: l.idx, qty: l.qty });
    for (const r of l.refs ?? []) {
      const k = keyOf(r.lotId);
      g.byLot.set(k, (g.byLot.get(k) ?? 0) + r.qty);
    }
  }
  return out;
}

/** خريطة byLot من aggregateRequest ⇒ صفوف LotRef لـallocateOut */
export function refsOfByLot(byLot: ReadonlyMap<string, number>): LotRef[] {
  return [...byLot].map(([k, qty]) => ({ lotId: lotOfKey(k), qty }));
}

// ═══ §٢.٦ خوارزميات التوزيع ═══

export interface AllocRow { lotId: string | null; qty: number; certainty: LotCertainty; flags: LotRowFlag[]; expiryDate: string | null; sourceItemLotId?: string | null }
export interface LotWarning { code: 'LOT_MULTI_IN_VAN' | 'LOT_HINT_REJECTED' | 'LOT_INTO_BLOCKED' | 'LOT_SPLIT_UNIT' | 'LOT_FROM_UNKNOWN' | 'LOT_REPLAY_FLAGGED'; productId: string; detail?: Record<string, unknown> }
export type AllocResult = { ok: true; rows: AllocRow[]; warnings: LotWarning[] } | { ok: false; error: LotError };

/** وسوم الإعادة التي تستحق إشعار الإدارة (LOT_REPLAY_FLAGGED) — SPLIT_UNIT تحذيرٌ عادي */
const REPLAY_NOTICE_FLAGS: ReadonlySet<LotRowFlag> = new Set(['REPLAY_BLOCKED', 'REPLAY_RECALLED', 'REPLAY_EXPIRED', 'REPLAY_CLAMPED', 'HINT_REJECTED']);

const placeLabel = (p: LotPlace) => (p === 'WAREHOUSE' ? 'المستودع' : 'سيارة المندوب');
const fmtQty = (n: number) => Number(Math.max(0, n).toFixed(3));

/** المصادر المادية في دلو: كل لوط صالحه > EPS أيّاً كانت حالته، وغير المسمّى إن كان صالحه > EPS */
function physicalSources(view: PlaceLotView, bucket: LotBucket): number {
  let n = 0;
  for (const l of view.lots) if (l.usable[bucket] > LOT_EPS) n++;
  if (unknownUsableOf(view, bucket) > LOT_EPS) n++;
  return n;
}

const blockFlag = (m: LotMeta): LotRowFlag => (m.blockKind === 'RECALL' ? 'REPLAY_RECALLED' : 'REPLAY_BLOCKED');

interface Cand { lot: LotBalance | null; avail: number; flags: LotRowFlag[]; certainty: LotCertainty }

/**
 * يأخذ `qty` من مرشّحين مرتّبين. قاعدة الكرتون (D22) حين `carton` وF > 1: أولاً مضاعفات F كاملةً من لوطٍ واحد بالترتيب،
 * ثم الباقي بالترتيب نفسه؛ والباقي إن توزّع على لوطين أو أكثر فقد انقسمت وحدة (SPLIT_UNIT). القطعة الأخيرة تأخذ الباقي كما
 * هو حين يكفيها المتاح ضمن EPS، فمجموع الصفوف = الكمية.
 */
function takeOrdered(cands: Cand[], qty: number, unitFactor: number, carton: boolean): { taken: Map<Cand, number>; left: number; split: Set<Cand> } {
  const taken = new Map<Cand, number>();
  const split = new Set<Cand>();
  const availLeft = new Map<Cand, number>(cands.map((c) => [c, c.avail]));
  let left = qty;
  const take = (c: Cand, t: number) => {
    taken.set(c, (taken.get(c) ?? 0) + t);
    availLeft.set(c, (availLeft.get(c) ?? 0) - t);
    left = t === left ? 0 : left - t;
  };
  const F = unitFactor;
  if (carton && Number.isFinite(F) && F > 1) {
    for (const c of cands) {
      if (left <= LOT_EPS) break;
      const k = Math.floor((Math.min(availLeft.get(c) ?? 0, left) + LOT_EPS) / F);
      if (k > 0) take(c, Math.abs(k * F - left) <= LOT_EPS ? left : k * F);
    }
  }
  const phaseB: Cand[] = [];
  for (const c of cands) {
    if (left <= LOT_EPS) break;
    const a = availLeft.get(c) ?? 0;
    if (a <= LOT_EPS) continue;
    take(c, a >= left - LOT_EPS ? left : a);
    phaseB.push(c);
  }
  if (carton && Number.isFinite(F) && F > 1 && phaseB.length >= 2) for (const c of phaseB) split.add(c);
  return { taken, left: left <= LOT_EPS ? 0 : left, split };
}

function rowsOf(cands: Cand[], taken: Map<Cand, number>, split: Set<Cand>, extraFlags: LotRowFlag[]): AllocRow[] {
  const rows: AllocRow[] = [];
  for (const c of cands) {
    const q = taken.get(c);
    if (!q || q <= 0) continue;
    const flags = new Set<LotRowFlag>(c.flags);
    if (split.has(c)) flags.add('SPLIT_UNIT');
    for (const f of extraFlags) flags.add(f);
    rows.push({
      lotId: c.lot ? c.lot.lotId : null, qty: q, certainty: c.lot ? c.certainty : 'UNKNOWN',
      flags: LOT_ROW_FLAGS.filter((f) => flags.has(f)), expiryDate: c.lot ? c.lot.meta.expiryDate : null,
    });
  }
  return rows;
}

function insufficient(input: { productId: string; productName: string; qty: number; view: PlaceLotView; day: string; allowUnknown: boolean }): LotError {
  const { view } = input;
  const available = splitAvailability(view, input.day, { allowUnknown: input.allowUnknown }).available;
  return lotErr('LOT_STOCK_INSUFFICIENT', { name: input.productName, place: placeLabel(view.place), available: fmtQty(available) }, {
    productId: input.productId, wanted: input.qty, available,
    byLot: view.lots.map((l) => ({ lotId: l.lotId, lotNumber: l.meta.lotNumber, usable: l.usable.SELLABLE, status: l.meta.status, expiryDate: l.meta.expiryDate })),
    unknownUsable: unknownUsableOf(view, 'SELLABLE'),
  });
}

/** يجمع صفوفاً بلوطها (الصريح والتلميح قد يكرّران لوطاً) بترتيب أول ظهور */
function mergeRefs(refs: LotRef[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of refs) m.set(keyOf(r.lotId), (m.get(keyOf(r.lotId)) ?? 0) + r.qty);
  return m;
}

/**
 * بطاقة لوطٍ صريح: من `lookup` (loadLotMetas للمعرّفات الصريحة) ثم من العرض. lookup مُمرَّر ولا بطاقة ⇒ LOT_NOT_FOUND؛
 * ثم صنفٌ آخر ⇒ LOT_PRODUCT_MISMATCH. فلوط صنفٍ آخر أو لوطٌ بلا رصيدٍ في المكان يأخذ رمزه لا «أكبر من المتاح (0)».
 */
function explicitMeta(k: string, l: LotBalance | undefined, lookup: ReadonlyMap<string, LotMeta> | null | undefined,
  productId: string, productName: string | null): { meta: LotMeta | null } | { error: LotError } {
  const meta = lookup?.get(k) ?? l?.meta ?? null;
  if (!meta && lookup) return { error: lotErr('LOT_NOT_FOUND', {}, { productId, lotId: k }) };
  if (meta && meta.productId !== productId) {
    return { error: lotErr('LOT_PRODUCT_MISMATCH', { lot: meta.lotNumber, name: productName }, { productId, lotId: k, lotProductId: meta.productId }) };
  }
  return { meta };
}

/**
 * توزيع إنقاصٍ من SELLABLE للبيع أو التحميل (I1، I4).
 * - **الكمية** بأربع خانات (isLotQty) وإلا LOT_QTY_INVALID — في المسار الحيّ والصريح؛ والإعادة لا تُرفض بها (R6).
 * - **الصريح** (الإدارة/المفتاح، مُجمَّع): بالترتيب — اللوط موجود في الشركة (بـ`lookup`) ومن الصنف، ACTIVE، غير منتهٍ يوم
 *   `day`، مجموعه ≤ صالحه؛ والفارغ ≤ unknownUsable وبشرط allowUnknown؛ ثم Σ = qty. اليقين CONFIRMED. البطاقة من `lookup`
 *   (loadLotMetas للمعرّفات الصريحة) ثم من العرض؛ ولوطٌ غائب عن العرض صالحه صفر.
 * - **بلا صريح، حيّاً**: المؤهَّلون بـFEFO بقاعدة الكرتون، ثم غير المسمّى إن كان allowUnknown (D17)، والباقي LOT_STOCK_INSUFFICIENT.
 * - **الإعادة** (`replay`، R6): التلميح إن صلح، وإلا الطبقات ١ (المؤهَّلون والموقوفون بعد البيع، بتقدّم firstInAt ≤ at)، ٢
 *   (غير المسمّى)، ٣ (HOLD ثم المنتهي ثم RECALL، ASSUMED بوسمها)؛ والنقص الباقي LOT_REPLAY_HELD (D20). allowUnknown لا يقيّدها.
 * - اليقين: صفّ مسمّى CONFIRMED إن كان المصدر المادي الوحيد (n_phys = 1) وإلا ASSUMED، وغير المسمّى UNKNOWN.
 */
export function allocateOut(input: {
  productId: string; productName: string; qty: number; unitFactor: number;
  view: PlaceLotView; day: string; mode: 'SALE' | 'LOAD';
  allowUnknown: boolean;                                  // D17
  explicit?: LotRef[] | null;                             // الإدارة/المفتاح (مُجمَّع)
  hint?: LotRef[] | null;                                 // الإعادة (مُجمَّع)
  replay?: { at: Date; clamped: boolean } | null;
  lookup?: ReadonlyMap<string, LotMeta> | null;           // بطاقات اللوطات الصريحة (loadLotMetas) — للوجود والصنف والحالة خارج العرض
}): AllocResult {
  const { view, day, productId } = input;
  const qty = input.qty;
  const warnings: LotWarning[] = [];
  if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: lotErr('LOT_QTY_INVALID', {}, { productId, wanted: qty }) };
  if (qty <= LOT_EPS) return { ok: true, rows: [], warnings };
  if (!input.replay && !isLotQty(qty)) return { ok: false, error: lotErr('LOT_QTY_INVALID', {}, { productId, wanted: qty, decimals: 4 }) };
  const byId = new Map(view.lots.map((l) => [l.lotId, l]));
  const nPhys = physicalSources(view, 'SELLABLE');
  const namedCertainty: LotCertainty = nPhys === 1 ? 'CONFIRMED' : 'ASSUMED';
  const uu = unknownUsableOf(view, 'SELLABLE');

  // ── الصريح ──
  if (input.explicit && input.explicit.length) {
    const want = mergeRefs(input.explicit);
    const rows: AllocRow[] = [];
    for (const [k, q] of want) {
      if (k === LOT_UNKNOWN_KEY) continue;
      const l = byId.get(k);
      const found = explicitMeta(k, l, input.lookup, productId, input.productName);
      if ('error' in found) return { ok: false, error: found.error };
      const m = found.meta;
      if (m && m.status !== 'ACTIVE') {
        return { ok: false, error: lotErr('LOT_BLOCKED', { lot: m.lotNumber }, { productId, lotId: k, blockKind: m.blockKind }) };
      }
      if (m && isLotExpiredOn(m, day)) {
        return { ok: false, error: lotErr('LOT_EXPIRED', { lot: m.lotNumber, date: m.expiryDate }, { productId, lotId: k, expiryDate: m.expiryDate }) };
      }
      const usable = l ? l.usable.SELLABLE : 0;
      if (q > usable + LOT_EPS) {
        return {
          ok: false,
          error: lotErr('LOT_STOCK_INSUFFICIENT', { name: input.productName, place: placeLabel(view.place), available: fmtQty(usable) },
            { productId, lotId: k, lotNumber: m?.lotNumber ?? null, wanted: q, usable }),
        };
      }
      rows.push({ lotId: k, qty: q, certainty: 'CONFIRMED', flags: [], expiryDate: m ? m.expiryDate : null });
    }
    const uq = want.get(LOT_UNKNOWN_KEY);
    if (uq != null) {
      if (!input.allowUnknown || uq > Math.max(0, uu) + LOT_EPS) {
        return {
          ok: false,
          error: lotErr('LOT_STOCK_INSUFFICIENT', { name: input.productName, place: placeLabel(view.place), available: fmtQty(input.allowUnknown ? uu : 0) },
            { productId, lotId: null, wanted: uq, unknownUsable: uu, allowUnknown: input.allowUnknown }),
        };
      }
      rows.push({ lotId: null, qty: uq, certainty: 'UNKNOWN', flags: [], expiryDate: null });
    }
    const sum = rows.reduce((s, r) => s + r.qty, 0);
    if (Math.abs(sum - qty) > LOT_EPS) return { ok: false, error: lotErr('LOT_QTY_INVALID', {}, { productId, wanted: qty, sum }) };
    return { ok: true, rows, warnings };
  }

  // ── الإعادة (R6) ──
  if (input.replay) {
    const at = input.replay.at;
    const base: LotRowFlag[] = input.replay.clamped ? ['REPLAY_CLAMPED'] : [];
    const markOf = (l: LotBalance): LotRowFlag[] => {
      const f: LotRowFlag[] = [];
      if (l.meta.status !== 'ACTIVE') f.push(blockFlag(l.meta));
      if (isLotExpiredOn(l.meta, day)) f.push('REPLAY_EXPIRED');
      return f;
    };
    let hintRejected = false;
    // الطبقة ٠: التلميح — يُلتزم به ما دام مجموعه على كل لوط ≤ صالحه أيّاً كانت حالته، ومجموعه = الكمية (D16)
    if (input.hint && input.hint.length) {
      const want = mergeRefs(input.hint);
      let ok = Math.abs([...want.values()].reduce((s, q) => s + q, 0) - qty) <= LOT_EPS;
      for (const [k, q] of want) {
        if (!ok) break;
        if (k === LOT_UNKNOWN_KEY) ok = q <= Math.max(0, uu) + LOT_EPS;
        else { const l = byId.get(k); ok = !!l && l.meta.productId === productId && q <= l.usable.SELLABLE + LOT_EPS; }
      }
      if (ok) {
        const rows: AllocRow[] = [];
        let fromUnknown = false;
        for (const [k, q] of want) {
          if (k === LOT_UNKNOWN_KEY) {
            fromUnknown = true;
            rows.push({ lotId: null, qty: q, certainty: 'UNKNOWN', flags: LOT_ROW_FLAGS.filter((f) => base.includes(f)), expiryDate: null });
          } else {
            const l = byId.get(k)!;
            const fl = new Set<LotRowFlag>([...markOf(l), ...base]);
            rows.push({ lotId: k, qty: q, certainty: namedCertainty, flags: LOT_ROW_FLAGS.filter((f) => fl.has(f)), expiryDate: l.meta.expiryDate });
          }
        }
        if (fromUnknown) warnings.push({ code: 'LOT_FROM_UNKNOWN', productId });
        if (rows.some((r) => r.flags.some((f) => REPLAY_NOTICE_FLAGS.has(f)))) warnings.push({ code: 'LOT_REPLAY_FLAGGED', productId, detail: { flags: [...new Set(rows.flatMap((r) => r.flags))] } });
        return { ok: true, rows, warnings };
      }
      hintRejected = true;
    }
    const extra: LotRowFlag[] = hintRejected ? [...base, 'HINT_REJECTED'] : base;
    // الطبقة ١: المؤهَّلون يوم day ومعهم الموقوفون بعد لحظة البيع؛ ما دخل السيارة قبل البيع أولاً ثم FEFO
    const l1: LotBalance[] = [];
    const l1Set = new Set<string>();
    for (const l of view.lots) {
      if (!(l.usable.SELLABLE > LOT_EPS) || isLotExpiredOn(l.meta, day)) continue;
      const blockedAfter = l.meta.status !== 'ACTIVE' && l.meta.blockedAt != null && l.meta.blockedAt > at;
      if (l.meta.status === 'ACTIVE' || blockedAfter) { l1.push(l); l1Set.add(l.lotId); }
    }
    const entered = (l: LotBalance) => { const t = view.firstInAt.get(l.lotId); return t != null && t <= at ? 0 : 1; };
    l1.sort((a, b) => entered(a) - entered(b) || fefoCompare(a.meta, b.meta));
    const c1: Cand[] = l1.map((l) => ({ lot: l, avail: l.usable.SELLABLE, flags: l.meta.status !== 'ACTIVE' ? [blockFlag(l.meta)] : [], certainty: namedCertainty }));
    const t1 = takeOrdered(c1, qty, input.unitFactor, true);
    let left = t1.left;
    const rows: AllocRow[] = rowsOf(c1, t1.taken, t1.split, extra);
    // الطبقة ٢: غير المسمّى
    if (left > LOT_EPS && uu > LOT_EPS) {
      const t = uu >= left - LOT_EPS ? left : uu;
      rows.push({ lotId: null, qty: t, certainty: 'UNKNOWN', flags: LOT_ROW_FLAGS.filter((f) => extra.includes(f)), expiryDate: null });
      warnings.push({ code: 'LOT_FROM_UNKNOWN', productId });
      left = t === left ? 0 : left - t;
    }
    // الطبقة ٣: الموقوف HOLD، ثم المنتهي، ثم المسحوب RECALL آخراً — مفترَضةً بوسمها
    if (left > LOT_EPS) {
      const group = (l: LotBalance) => (l.meta.status !== 'ACTIVE' ? (l.meta.blockKind === 'RECALL' ? 2 : 0) : 1);
      const l3 = view.lots.filter((l) => !l1Set.has(l.lotId) && l.usable.SELLABLE > LOT_EPS)
        .sort((a, b) => group(a) - group(b) || fefoCompare(a.meta, b.meta));
      const c3: Cand[] = l3.map((l) => ({ lot: l, avail: l.usable.SELLABLE, flags: markOf(l), certainty: 'ASSUMED' }));
      const t3 = takeOrdered(c3, left, input.unitFactor, false);
      left = t3.left;
      rows.push(...rowsOf(c3, t3.taken, t3.split, extra));
    }
    if (left > LOT_EPS) {
      return {
        ok: false,
        error: lotErr('LOT_REPLAY_HELD', {}, {
          productId, wanted: qty, missing: roundLot(left),
          usable: roundLot(view.lots.reduce((s, l) => s + Math.max(0, l.usable.SELLABLE), 0) + Math.max(0, uu)),
        }),
      };
    }
    if (hintRejected) warnings.push({ code: 'LOT_HINT_REJECTED', productId });
    if (t1.split.size) warnings.push({ code: 'LOT_SPLIT_UNIT', productId, detail: { unitFactor: input.unitFactor } });
    if (rows.some((r) => r.flags.some((f) => REPLAY_NOTICE_FLAGS.has(f)))) warnings.push({ code: 'LOT_REPLAY_FLAGGED', productId, detail: { flags: [...new Set(rows.flatMap((r) => r.flags))] } });
    return { ok: true, rows, warnings };
  }

  // ── المسار الحيّ بلا صريح ──
  const eligible = view.lots.filter((l) => isEligible(l, day)).sort((a, b) => fefoCompare(a.meta, b.meta));
  const cands: Cand[] = eligible.map((l) => ({ lot: l, avail: l.usable.SELLABLE, flags: [], certainty: namedCertainty }));
  const t = takeOrdered(cands, qty, input.unitFactor, true);
  let left = t.left;
  const rows = rowsOf(cands, t.taken, t.split, []);
  if (left > LOT_EPS && input.allowUnknown && uu > LOT_EPS) {
    const q = uu >= left - LOT_EPS ? left : uu;
    rows.push({ lotId: null, qty: q, certainty: 'UNKNOWN', flags: [], expiryDate: null });
    warnings.push({ code: 'LOT_FROM_UNKNOWN', productId });
    left = q === left ? 0 : left - q;
  }
  if (left > LOT_EPS) return { ok: false, error: insufficient({ ...input, view }) };
  if (t.split.size) warnings.push({ code: 'LOT_SPLIT_UNIT', productId, detail: { unitFactor: input.unitFactor } });
  return { ok: true, rows, warnings };
}

/**
 * مصادر إنقاصٍ من دلوٍ بلا بيع (التنزيل، وتسوية النقص، وإزالة المنتهي أو التالف، والتسمية من مصدر) — D10:
 * المصادر لوطات صالحها في الدلو > EPS أيّاً كانت حالتها (الموقوف والمنتهي يخرجان من هنا)، وغير المسمّى إن كان صالحه > EPS.
 * بلا صريح: المصدر الوحيد يُستعمل، وأكثر من مصدر ⇒ 422 LOT_REQUIRED بقائمتها. الصريح: اللوط موجود ومن الصنف (بـ`lookup`)،
 * وهو ≤ صالحه (I1)، والفارغ لا يُنقص صالح غير المسمّى دون min(0, قبله) (I2)، وΣ = qty. الكمية بأربع خانات (isLotQty).
 * الصفوف بكميات موجبة والإشارة للمستدعي.
 */
export function pickOutSources(view: PlaceLotView, bucket: LotBucket, qty: number, explicit?: LotRef[] | null,
  lookup?: ReadonlyMap<string, LotMeta> | null): AllocResult {
  const productId = view.productId;
  const warnings: LotWarning[] = [];
  if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: lotErr('LOT_QTY_INVALID', {}, { productId, wanted: qty }) };
  if (qty <= LOT_EPS) return { ok: true, rows: [], warnings };
  if (!isLotQty(qty)) return { ok: false, error: lotErr('LOT_QTY_INVALID', {}, { productId, wanted: qty, decimals: 4 }) };
  const uu = unknownUsableOf(view, bucket);
  const sources = view.lots.filter((l) => l.usable[bucket] > LOT_EPS);
  const unknownSource = uu > LOT_EPS;
  const listSources = () => [
    ...sources.map((l) => ({ lotId: l.lotId, lotNumber: l.meta.lotNumber, usable: l.usable[bucket], status: l.meta.status, expiryDate: l.meta.expiryDate })),
    ...(unknownSource ? [{ lotId: null, lotNumber: null, usable: uu, status: null, expiryDate: null }] : []),
  ];
  const short = (available: number, extra: Record<string, unknown>) =>
    lotErr('LOT_STOCK_INSUFFICIENT', { place: placeLabel(view.place), available: fmtQty(available) }, { productId, bucket, wanted: qty, ...extra, sources: listSources() });

  if (!explicit || !explicit.length) {
    const n = sources.length + (unknownSource ? 1 : 0);
    if (n > 1) return { ok: false, error: lotErr('LOT_REQUIRED', {}, { productId, bucket, sources: listSources() }) };
    if (n === 0) return { ok: false, error: short(0, {}) };
    if (sources.length === 1) {
      const l = sources[0];
      if (qty > l.usable[bucket] + LOT_EPS) return { ok: false, error: short(l.usable[bucket], { lotId: l.lotId }) };
      return { ok: true, rows: [{ lotId: l.lotId, qty, certainty: 'CONFIRMED', flags: [], expiryDate: l.meta.expiryDate }], warnings };
    }
    if (qty > uu + LOT_EPS) return { ok: false, error: short(uu, { lotId: null }) };
    return { ok: true, rows: [{ lotId: null, qty, certainty: 'UNKNOWN', flags: [], expiryDate: null }], warnings };
  }

  const byId = new Map(view.lots.map((l) => [l.lotId, l]));
  const rows: AllocRow[] = [];
  for (const [k, q] of mergeRefs(explicit)) {
    if (k === LOT_UNKNOWN_KEY) {
      // I2: بعده ≥ min(0, قبله) − EPS ⇔ q ≤ max(0, قبله) + EPS
      if (q > Math.max(0, uu) + LOT_EPS) return { ok: false, error: short(Math.max(0, uu), { lotId: null }) };
      rows.push({ lotId: null, qty: q, certainty: 'UNKNOWN', flags: [], expiryDate: null });
      continue;
    }
    const l = byId.get(k);
    const found = explicitMeta(k, l, lookup, productId, null);
    if ('error' in found) return { ok: false, error: found.error };
    const usable = l ? l.usable[bucket] : 0;
    if (q > usable + LOT_EPS) return { ok: false, error: short(usable, { lotId: k, lotNumber: found.meta?.lotNumber ?? null }) };
    rows.push({ lotId: k, qty: q, certainty: 'CONFIRMED', flags: [], expiryDate: found.meta ? found.meta.expiryDate : null });
  }
  const sum = rows.reduce((s, r) => s + r.qty, 0);
  if (Math.abs(sum - qty) > LOT_EPS) return { ok: false, error: lotErr('LOT_QTY_INVALID', {}, { productId, wanted: qty, sum }) };
  return { ok: true, rows, warnings };
}

/** بند مستندٍ يُزال أثره من المكان: إلغاء مرتجع (§٤.١٢)، أو إطفاء عودته للمخزون (§٤.١٣) */
export interface LotRemovalItem {
  productId: string;
  qty: number;                    // الكمية الأساسية للبند
  bucket: LotBucket | null;       // الدلو الذي يغادره أثر البند (invEffect، أو SELLABLE وحده لإطفاء العودة)؛ null ⇒ لا أثر
  held: boolean;                  // مستندٌ محجوز (D24): إزالته تُنقص الخام والمحجوز معاً فلا تمسّ الصالح
  rows: { lotId: string | null; quantity: number; createdAt: Date }[] | null; // صفوف توزيعه؛ null أو [] ⇒ كُتب بلا تتبّع
}
export interface LotRemoval { productId: string; lotId: string | null; bucket: LotBucket; qty: number }

/**
 * ما يُزال من (لوط أو غير المسمّى، دلو) لكل بند، بدلالة الطيّ نفسها (§٤.١٢–٤.١٣):
 * - صنفٌ غير متتبَّع فعلياً الآن (`tracked` من lockLotProducts مع علم الشركة): لا فحص.
 * - بندٌ محجوز، أو بلا دلو: لا شيء.
 * - بندٌ بلا صفوف (كُتب قبل تتبّع صنفه): كميته كلها من غير المسمّى — كانت فيه عبر رصيد الصنف.
 * - صفٌّ أقدم من الحقبة: من غير المسمّى لا من لوطه (لا يدخل الخام). `since` = الحقبة **الفعلية** لكل صنف
 *   max(Tenant.lotTrackingSince, Product.lotTrackedSince)، والغائب أو null بلا حقبة.
 * - وإلا من لوط الصف، والصفّ الفارغ من غير المسمّى.
 */
export function lotRemovalsOf(items: LotRemovalItem[], since: ReadonlyMap<string, Date | null>, tracked: ReadonlySet<string>): LotRemoval[] {
  const out: LotRemoval[] = [];
  for (const it of items) {
    if (!it.bucket || it.held || !tracked.has(it.productId)) continue;
    const bucket = it.bucket;
    const epoch = since.get(it.productId) ?? null;
    if (!it.rows || !it.rows.length) {
      if (it.qty > LOT_EPS) out.push({ productId: it.productId, lotId: null, bucket, qty: it.qty });
      continue;
    }
    for (const r of it.rows) {
      if (!(r.quantity > 0)) continue;
      const counted = epoch == null || r.createdAt.getTime() >= epoch.getTime();
      out.push({ productId: it.productId, lotId: counted ? r.lotId : null, bucket, qty: r.quantity });
    }
  }
  return out;
}

/**
 * حارس الإزالة (I1، I2) على عرض صنفٍ في مكان، بعد التجميع لكل (لوط أو فارغ، دلو) — D26: صالح اللوط بعد الطرح ≥ −EPS،
 * وصالح غير المسمّى بعده ≥ min(0, قبله) − EPS. غير المسمّى المجهول (سيارة مندوب محذوف، total = null) لا يُتحقَّق منه فيُرفض.
 * إزالات أصنافٍ أخرى تُتجاهل (المستدعي يمرّر عرض كل صنف). null ⇒ آمن؛ وإلا LOT_STOCK_INSUFFICIENT بالتفاصيل.
 */
export function removalKeepsLots(view: PlaceLotView, removals: LotRemoval[]): LotError | null {
  const want = new Map<string, { lotId: string | null; bucket: LotBucket; qty: number }>();
  for (const r of removals) {
    if (r.productId !== view.productId || !(r.qty > 0)) continue;
    const k = `${keyOf(r.lotId)}|${r.bucket}`;
    const g = want.get(k) ?? { lotId: r.lotId, bucket: r.bucket, qty: 0 };
    g.qty += r.qty;
    want.set(k, g);
  }
  const byId = new Map(view.lots.map((l) => [l.lotId, l]));
  for (const g of want.values()) {
    const fail = (usable: number | null, lotNumber: string | null) => lotErr('LOT_STOCK_INSUFFICIENT',
      { place: placeLabel(view.place), available: fmtQty(usable ?? 0) },
      { productId: view.productId, lotId: g.lotId, lotNumber, bucket: g.bucket, wanted: roundLot(g.qty), usable, reason: 'REMOVAL' });
    if (g.lotId == null) {
      const uu = view.unknownUsable ? view.unknownUsable[g.bucket] : null;
      if (uu == null || uu - g.qty < Math.min(0, uu) - LOT_EPS) return fail(uu, null);
      continue;
    }
    const l = byId.get(g.lotId);
    const usable = l ? l.usable[g.bucket] : 0;
    if (usable - g.qty < -LOT_EPS) return fail(usable, l?.meta.lotNumber ?? null);
  }
  return null;
}

export interface SaleLotRow { id: string; lotId: string | null; quantity: number; certainty: LotCertainty; expiryDate: string | null }

/**
 * وراثة المرتجع المرتبط من صفوف توزيع بيعه (ن١-٢):
 * - بلا صفوف بيع ⇒ صفٌّ واحد غير معروف.
 * - المتاح لكل صف = quantity − ما أُرجع منه في مرتجعات وإشعارات غير ملغاة.
 * - الترتيب الهجين: إن وُجد صفٌّ منتهٍ يوم المرتجع متاحُه > EPS ⇒ الأقرب انتهاءً أولاً (يرجع المنتهي)، وإلا الأبعد انتهاءً
 *   أولاً (المحلّ يبيع الأقدم فيرجع آخر ما وصله — invoiceExpiry.ts:10-11). صفوف البيع غير المعروفة آخراً.
 * - اليقين: يقين صفّ البيع إن كان البيع صفّاً واحداً (لا ما بقي منه بعد مرتجعاتٍ سابقة: قسمتها افتراض)، وإلا ASSUMED؛
 *   والفائض صفٌّ UNKNOWN.
 */
export function allocateReturnFromSale(input: {
  qty: number; returnDay: string; saleRows: SaleLotRow[];
  returnedBySource: ReadonlyMap<string, number>;   // Σ quantity لصفوف مرتجعات وإشعارات غير ملغاة sourceItemLotId = id
}): AllocRow[] {
  const { qty, returnDay } = input;
  if (!(qty > LOT_EPS)) return [];
  if (!input.saleRows.length) return [{ lotId: null, qty, certainty: 'UNKNOWN', flags: [], expiryDate: null, sourceItemLotId: null }];
  const cands = input.saleRows
    .map((r, i) => ({ r, i, avail: r.quantity - (input.returnedBySource.get(r.id) ?? 0) }))
    .filter((c) => c.avail > LOT_EPS);
  const expiredNow = (r: SaleLotRow) => r.lotId != null && r.expiryDate != null && returnDay > r.expiryDate;
  const nearestFirst = cands.some((c) => expiredNow(c.r));
  cands.sort((a, b) => {
    const an = a.r.lotId == null ? 1 : 0, bn = b.r.lotId == null ? 1 : 0;
    if (an !== bn) return an - bn;
    const ae = a.r.expiryDate, be = b.r.expiryDate;
    if (ae !== be) {
      if (nearestFirst) return cmpNullLast(ae, be);
      if (ae == null) return -1; // بلا انتهاء = الأبعد
      if (be == null) return 1;
      return ae > be ? -1 : 1;
    }
    return a.i - b.i;
  });
  const single = input.saleRows.filter((r) => r.quantity > LOT_EPS).length === 1;
  const rows: AllocRow[] = [];
  let left = qty;
  for (const c of cands) {
    if (left <= LOT_EPS) break;
    const t = c.avail >= left - LOT_EPS ? left : c.avail;
    rows.push({
      lotId: c.r.lotId, qty: t,
      certainty: c.r.lotId == null ? 'UNKNOWN' : single ? c.r.certainty : 'ASSUMED',
      flags: [], expiryDate: c.r.lotId == null ? null : c.r.expiryDate, sourceItemLotId: c.r.id,
    });
    left = t === left ? 0 : left - t;
  }
  if (left > LOT_EPS) rows.push({ lotId: null, qty: left, certainty: 'UNKNOWN', flags: [], expiryDate: null, sourceItemLotId: null });
  return rows;
}

/**
 * يوزّع صفوف صنفٍ مجمَّع على أسطر الطلب بالترتيب (الصف يُقسم بين سطرين حين يلزم) — Σ صفوف كل سطر = كميته (I3).
 * الصريح لكل سطر يُستعمل كما هو عند المستدعي؛ هذه للتوزيع التلقائي. اختلاف المجموعين خطأ برمجي فيرمي.
 */
export function distributeToLines(rows: AllocRow[], lines: { idx: number; qty: number }[]): Map<number, AllocRow[]> {
  const out = new Map<number, AllocRow[]>();
  const totalRows = rows.reduce((s, r) => s + r.qty, 0);
  const totalLines = lines.reduce((s, l) => s + l.qty, 0);
  if (Math.abs(totalRows - totalLines) > LOT_EPS * Math.max(1, rows.length + lines.length)) {
    throw new Error(`LOT_DISTRIBUTE_MISMATCH: ${totalRows} != ${totalLines}`);
  }
  let ri = 0;
  let rowLeft = rows.length ? rows[0].qty : 0;
  for (const line of lines) {
    const list: AllocRow[] = [];
    out.set(line.idx, list);
    let need = line.qty;
    while (need > LOT_EPS && ri < rows.length) {
      const r = rows[ri];
      // يكفي الصفُّ السطرَ ضمن EPS ⇒ يأخذ السطر كميته كما هي، فمجموع صفوفه = كميته بلا غبار عائمة
      const piece = rowLeft >= need - LOT_EPS ? need : rowLeft;
      if (piece > 0) list.push({ ...r, flags: [...r.flags], qty: piece });
      need = piece === need ? 0 : need - piece;
      rowLeft = piece === rowLeft ? 0 : rowLeft - piece;
      if (rowLeft <= LOT_EPS) { ri++; rowLeft = ri < rows.length ? rows[ri].qty : 0; }
    }
    // غبارٌ دون التسامح بعد نفاد الصفوف يُضمّ إلى آخر قطعة (Σ = كمية السطر)
    if (need > 0 && list.length) list[list.length - 1].qty += need;
  }
  return out;
}

/**
 * ختم الصلاحية من صفوف التوزيع (D12، ن١-٣): null إن لم يوجد صفّ مسمّى له انتهاء (فتبقى اللقطة القائمة)؛ expiresAt = أقرب
 * انتهاء؛ returnExpired = أي صفّ مسمّى منتهٍ يوم المرتجع (D6: البند المختلط يُوجَّه كله إلى EXPIRED)، وnull بلا يوم مرتجع.
 */
export function stampFromRows(rows: Pick<AllocRow, 'lotId' | 'expiryDate'>[], returnDay?: string | null):
  { expiresAt: string; returnExpired: boolean | null } | null {
  const dated = rows.filter((r) => r.lotId != null && r.expiryDate != null).map((r) => r.expiryDate as string);
  if (!dated.length) return null;
  const expiresAt = dated.reduce((a, b) => (b < a ? b : a));
  const returnExpired = returnDay ? dated.some((d) => returnDay > d) : null;
  return { expiresAt, returnExpired };
}

/** تحذير LOT_MULTI_IN_VAN: لوطان مسمّيان أو أكثر صالحهما SELLABLE > EPS */
export function multiLotWarning(view: PlaceLotView): LotWarning | null {
  const lots = view.lots.filter((l) => l.usable.SELLABLE > LOT_EPS);
  if (lots.length < 2) return null;
  return {
    code: 'LOT_MULTI_IN_VAN', productId: view.productId,
    detail: { lots: lots.map((l) => ({ lotId: l.lotId, lotNumber: l.meta.lotNumber, usable: l.usable.SELLABLE, expiryDate: l.meta.expiryDate, status: l.meta.status })) },
  };
}

export interface ItemExpiryStamp { expiresAt: Date; returnExpired: boolean | null; expirySaleInvoiceId: string | null }

const dayToDate = (d: string | null) => (d ? new Date(`${d}T00:00:00.000Z`) : null);

/**
 * أعمدة بند الفاتورة للصنف المتتبَّع، تُدمج في items.create **بعد** linkedExpiry فتغلبه: lots.create (صفوف متداخلة) وأعمدة
 * الصلاحية من stamp إن وُجد. سطرٌ بلا توزيع ⇒ {} فلا يتغيّر بند غير المتتبَّع.
 */
export function invoiceItemLotColumns(lines: ReadonlyMap<number, { rows: AllocRow[]; stamp: ItemExpiryStamp | null }> | null, idx: number,
  ids: { tenantId: string; invoiceId: string; productId: string; vanKey: string | null }): Record<string, unknown> {
  const entry = lines?.get(idx);
  if (!entry) return {};
  const out: Record<string, unknown> = {};
  if (entry.rows.length) {
    out.lots = {
      create: entry.rows.map((r) => ({
        tenantId: ids.tenantId, invoiceId: ids.invoiceId, productId: ids.productId, vanKey: ids.vanKey,
        lotId: r.lotId, quantity: r.qty, certainty: r.certainty, expiryDate: dayToDate(r.expiryDate),
        sourceItemLotId: r.sourceItemLotId ?? null, flags: r.flags.length ? r.flags.join(',') : null,
      })),
    };
  }
  if (entry.stamp) {
    out.expiresAt = entry.stamp.expiresAt;
    out.returnExpired = entry.stamp.returnExpired;
    out.expirySaleInvoiceId = entry.stamp.expirySaleInvoiceId;
  }
  return out;
}

// ═══ §٢.٧ القفل والأخطاء ═══

/** مفتاح القفل الاستشاري: أول ٨ بايت من sha256('lot:'+tenantId+':'+productId) عدداً موقَّعاً (D29) */
export function lotLockKey(tenantId: string, productId: string): bigint {
  return createHash('sha256').update(`lot:${tenantId}:${productId}`).digest().readBigInt64BE(0);
}

/** مفاتيح أصناف العملية: فريدة، مرتّبة بالمفتاح نفسه (ترتيبٌ واحد في المنصّة كلها فلا تعطّل متبادل بين مسارين) */
export function sortedLockKeys(tenantId: string, productIds: Iterable<string>): { productId: string; key: bigint }[] {
  const ids = [...new Set([...productIds].filter((p) => typeof p === 'string' && p.length > 0))];
  return ids
    .map((productId) => ({ productId, key: lotLockKey(tenantId, productId) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : cmpStr(a.productId, b.productId)));
}

export type LotErrorCode =
  | 'LOTS_NOT_ALLOWED' | 'LOTS_DISABLED' | 'LOT_SCOPED_USER'
  | 'LOT_REQUIRED' | 'LOT_NOT_FOUND' | 'LOT_PRODUCT_MISMATCH' | 'LOT_BLOCKED' | 'LOT_EXPIRED' | 'LOT_QTY_INVALID'
  | 'LOT_DATES_INVALID' | 'LOT_EXPIRY_REQUIRED' | 'LOT_RELABEL_INVALID' | 'LOT_REASON_REQUIRED'
  | 'LOT_STOCK_INSUFFICIENT' | 'LOT_DATES_MISMATCH' | 'LOT_NUMBER_TAKEN' | 'LOT_IN_USE' | 'LOT_CHANGED'
  | 'LOT_TRACKING_HAS_BALANCE' | 'LOT_REPLAY_HELD' | 'LOT_RECORDS_RETAINED'
  | 'LOT_BUSY';
export class LotError extends Error {
  constructor(readonly code: LotErrorCode, message: string, readonly status: number, readonly detail?: Record<string, unknown>) { super(message); this.name = 'LotError'; }
}

/** حالة HTTP لكل رمز (§٣.٣) — LOT_NOT_FOUND 422 في الجسم، والمسار يردّه 404 بنفسه */
export const LOT_ERROR_STATUS: Readonly<Record<LotErrorCode, number>> = Object.freeze({
  LOTS_NOT_ALLOWED: 403, LOTS_DISABLED: 403, LOT_SCOPED_USER: 403,
  LOT_REQUIRED: 422, LOT_NOT_FOUND: 422, LOT_PRODUCT_MISMATCH: 422, LOT_BLOCKED: 422, LOT_EXPIRED: 422, LOT_QTY_INVALID: 422,
  LOT_DATES_INVALID: 422, LOT_EXPIRY_REQUIRED: 422, LOT_RELABEL_INVALID: 422, LOT_REASON_REQUIRED: 422,
  LOT_STOCK_INSUFFICIENT: 409, LOT_DATES_MISMATCH: 409, LOT_NUMBER_TAKEN: 409, LOT_IN_USE: 409, LOT_CHANGED: 409,
  LOT_TRACKING_HAS_BALANCE: 409, LOT_REPLAY_HELD: 409, LOT_RECORDS_RETAINED: 409,
  LOT_BUSY: 503,
});

export interface LotMsgVars { name?: string | null; lot?: string | null; date?: string | null; available?: number | string | null; place?: string | null }

/** الرسالة العربية لكل رمز (§٣.٣) — اسم الصنف اختياري فيُسقط «» حين يغيب */
export function lotMessage(code: LotErrorCode, v: LotMsgVars = {}): string {
  const nm = v.name ? ` «${v.name}»` : '';
  const lot = v.lot ? ` ${v.lot}` : '';
  switch (code) {
    case 'LOTS_NOT_ALLOWED': return 'تتبع اللوط غير مفعّل لهذه الشركة تواصل مع مزود الخدمة';
    case 'LOTS_DISABLED': return 'ميزة تتبع اللوط غير مفعلة لشركتك';
    case 'LOT_SCOPED_USER': return 'هذا الإجراء على التشغيلات لمستخدم غير مقيد بنطاق';
    case 'LOT_REQUIRED': return `حدّد التشغيلة للصنف${nm}`;
    case 'LOT_NOT_FOUND': return 'التشغيلة غير موجودة';
    case 'LOT_PRODUCT_MISMATCH': return `التشغيلة${lot} لا تخص الصنف${nm}`;
    case 'LOT_BLOCKED': return `التشغيلة${lot} موقوفة لا تحمّل ولا تباع ولا يعاد تصنيفها`;
    case 'LOT_EXPIRED': return `التشغيلة${lot} منتهية الصلاحية${v.date ? ` منذ ${v.date}` : ''}`;
    case 'LOT_QTY_INVALID': return 'كميات التشغيلات يجب أن تكون موجبة ومجموعها يساوي كمية السطر';
    case 'LOT_DATES_INVALID': return 'تاريخ الإنتاج بعد تاريخ الانتهاء أو تاريخ غير صالح';
    case 'LOT_EXPIRY_REQUIRED': return 'تاريخ انتهاء التشغيلة إلزامي لصنف صلاحيته مفعّلة';
    case 'LOT_RELABEL_INVALID': return 'التسمية من التشغيلة إليها نفسها أو بلا طرفين';
    case 'LOT_REASON_REQUIRED': return 'اكتب سبب هذا التعديل على التشغيلة';
    case 'LOT_STOCK_INSUFFICIENT':
      return `الكمية${nm ? ` من${nm}` : ''} أكبر من المتاح في تشغيلات ${v.place ?? 'المكان'}${v.available != null ? ` (${v.available})` : ''}`;
    case 'LOT_DATES_MISMATCH': return `التشغيلة${lot} مسجلة بتواريخ مختلفة`;
    case 'LOT_NUMBER_TAKEN': return 'رقم التشغيلة مسجل لهذا الصنف';
    case 'LOT_IN_USE': return 'للتشغيلة حركات فلا تحذف';
    case 'LOT_CHANGED': return 'تغيّرت التشغيلة منذ فتحها أعد التحميل';
    case 'LOT_TRACKING_HAS_BALANCE': return 'للصنف أرصدة في تشغيلات أكّد الإطفاء';
    case 'LOT_REPLAY_HELD': return 'فاتورة دون اتصال لا يكفيها رصيد السيارة بانتظار تسجيل الإدارة للتحميل الناقص';
    case 'LOT_RECORDS_RETAINED': return 'للشركة سجلات تتبع تشغيلات يجب حفظها 180 يوما صدّرها ثم أكّد الحذف';
    case 'LOT_BUSY': return 'الصنف مشغول بعملية أخرى أعد المحاولة';
  }
}

/** ينشئ LotError بالرسالة والحالة المعتمدتين للرمز */
export function lotErr(code: LotErrorCode, vars: LotMsgVars = {}, detail?: Record<string, unknown>): LotError {
  return new LotError(code, lotMessage(code, vars), LOT_ERROR_STATUS[code], detail);
}

export function lotErrorBody(e: LotError): { success: false; code: string; message: string; detail?: unknown } {
  return { success: false, code: e.code, message: e.message, ...(e.detail !== undefined && { detail: e.detail }) };
}

const BUSY_SQLSTATES = new Set(['55P03', '40P01']);
/** 55P03 أو 40P01 أو P2028 أو انشغال الطابور ⇒ LotError('LOT_BUSY', 503)؛ وإلا null */
export function asLotBusy(e: unknown): LotError | null {
  if (e instanceof LotError) return e.code === 'LOT_BUSY' ? e : null;
  const o = e as { code?: unknown; meta?: { code?: unknown } | null; message?: unknown } | null | undefined;
  const code = typeof o?.code === 'string' ? o.code : '';
  const metaCode = typeof o?.meta?.code === 'string' ? o.meta.code : '';
  const msg = typeof o?.message === 'string' ? o.message : '';
  const busy = code === 'P2028' || code === 'P2034' || BUSY_SQLSTATES.has(code) || BUSY_SQLSTATES.has(metaCode)
    || /\b55P03\b|\b40P01\b|lock timeout|deadlock detected|Transaction already closed|expired transaction/i.test(msg);
  return busy ? lotErr('LOT_BUSY', {}, { cause: code || metaCode || 'LOCK' }) : null;
}

/**
 * للمعالجات: LotError أو انشغال ⇒ {status, body}؛ وإلا null.
 * ⚠️ P2028 يصير LOT_BUSY: يُستدعى في مسارات اللوط (حين يحمل المستند صنفاً متتبَّعاً) لا في كل catch.
 */
export function lotHttpError(e: unknown): { status: number; body: ReturnType<typeof lotErrorBody> } | null {
  const le = e instanceof LotError ? e : asLotBusy(e);
  return le ? { status: le.status, body: lotErrorBody(le) } : null;
}

/** طلبٌ مكرَّر بالـclientRef وجد الفاتورة تحت القفل — يحاكي P2002 فيلتقطه فرع السباق القائم (invoices.ts:903-904) */
export class ClientRefRace extends Error {
  readonly code = 'P2002';
  readonly meta = { target: ['tenantId', 'clientRef'] };
  constructor(message = 'Unique constraint failed on the fields: (`tenantId`,`clientRef`)') { super(message); this.name = 'ClientRefRace'; }
}

// ═══ §٢.٨ أنواع العقود المشتركة (يكتبها الأساس هنا، وتنفّذها الحزم) ═══

export interface InvoiceLotLine { idx: number; productId: string; productName: string; qty: number /*أساسية*/; unitFactor: number; saleItemId?: string | null; lotsRaw?: unknown }
export interface InvoiceLotPlan {
  tenantId: string; customerId: string; vanKey: string | null;
  docType: 'CASH' | 'CREDIT' | 'RETURN'; link: 'NONE' | 'RETURN_OF' | 'CREDITED';
  actor: LotActor; replay: { at: Date; clamped: boolean } | null;
  day: string; returnDay: string | null;             // محسوبان قبل المعاملة (ن٢-٢)
  allowUnknown: boolean; clientRef: string | null;
  lines: InvoiceLotLine[];
  fallbackStamps: ReadonlyMap<number, ItemExpiryStamp>; // اللقطة القائمة (linkedExpiry أو «آخر بيع») محسوبة قبل المعاملة
}
export interface InvoiceLotAllocation {
  tracked: ReadonlySet<string>;                         // من FOR KEY SHARE داخل المعاملة (D25)
  lines: Map<number, { rows: AllocRow[]; stamp: ItemExpiryStamp | null }>;
  warnings: LotWarning[];
}
export interface VanMovementPlanInput {
  tenantId: string; vanKey: string; deletedVan: boolean; type: VanMoveType; warehouseEnabled: boolean;
  actor: LotActor; createdBy: string | null; day: string; allowUnknown: boolean;
  lines: { idx: number; productId: string; productName: string; shelfLifeOn: boolean; qty: number /*أساسية بإشارتها*/; unitFactor: number; lotsRaw?: unknown; reason?: string | null }[];
}
export interface VanMovementPlan { tracked: ReadonlySet<string>; lines: Map<number, (AllocRow & { viaWarehouse: boolean; reason: string | null })[]>; warnings: LotWarning[] }
export interface WarehouseEntryPlanInput {
  tenantId: string; type: 'RECEIVE' | 'ADJUST'; actor: LotActor; createdBy: string | null; day: string; allowUnknown: boolean; sourceEntryId?: string | null;
  lines: { idx: number; productId: string; productName: string; shelfLifeOn: boolean; qty: number; lotId?: string | null; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null }[];
}
export interface WarehouseEntryPlan { tracked: ReadonlySet<string>; lotIdByLine: Map<number, string | null>; warnings: LotWarning[] }
export interface RelabelInput {
  tenantId: string; productId: string; place: LotPlace; vanKey: string | null; bucket: LotBucket;
  fromLotId: string | null; reason: 'LABEL_EXISTING' | 'RECLASSIFY' | 'CORRECTION'; note: string | null; day: string;
  actor: { type: string; id: string | null; name: string | null; scoped: boolean };
  lines: { toLotId?: string | null; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null; qty: number }[];
}
export interface VanLotSnapshotDto {
  serverTime: string; day: string; tracked: string[]; allowUnknown: boolean;
  products: { productId: string; available: number; availableNamed: number; unknownUsable: number; quarantined: number; held: number;
    expiredUnsold: number; expiredReturned: number; damaged: number;
    lots: { lotId: string; lotNumber: string; expiryDate: string | null; status: LotStatus; blockKind: LotBlockKind | null; usable: number }[] }[];
}
export interface LotTraceDto {
  lot: LotMeta & { productName: string; source: string; note: string | null };
  origin: { kind: string; at: string; ref: string | null; qty: number }[];
  places: { place: LotPlace; salesRepId: string | null; repName: string | null; raw: BucketQty; usable: BucketQty; held: BucketQty; approximate: boolean;
    loaded: number; unloaded: number; sold: number; returned: number }[];
  customers: { customerId: string; name: string; phone: string | null; address: string | null; city: string | null;
    invoices: { invoiceId: string; number: string; date: string; sold: number; returned: number; net: number; weakest: LotCertainty; flags: LotRowFlag[]; broad: boolean }[] }[] | null;
  customersHidden: boolean; scoped: boolean; scope: 'STRICT' | 'BROAD';
  events: { kind: string; at: string; actorName: string | null; reason: string | null }[];
}
