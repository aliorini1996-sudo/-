/**
 * «تتبّع اللوط» — شاشة التتبّع وخطة التنزيل وسلامة الأرصدة وملخّصات البطاقات (قراءات بلا قفل).
 * المواصفة §٤.١٦ (خطة التنزيل)، و§٤.١٧ (التتبّع STRICT وBROAD)، و/lots/health، و§٤.٢ (أرصدة الإطفاء وما يحتاج تسميةً بعد
 * التفعيل الجماعي). لا يستورد إعداد القاعدة: كل دالّة تأخذ `db` (العميل أو المعاملة).
 *
 * الأرصدة (الخام والمحجوز والصالح) من placeViews نفسها — بالحقبة كشاشات الأرصدة. أمّا المصدر ومجاميع الحركة والعملاء فكل
 * التاريخ بلا حقبة: التتبّع للسحب والتدقيق، وإعادة التفعيل لا تمحو من باع لمن. وكل كمية بوحدة الأساس (D22): صفوف جداول
 * اللوط بالأساس أصلاً، وبنود المستندات بـbaseQtyOf (لقطة وحدتها).
 */
import { placeViews, type LotDb } from './lotsDb';
import { baseQtyOf } from './units';
import { isDamagedVanReturn } from './vanDamaged';
import {
  LOT_BUCKETS, LOT_CERTAINTIES, LOT_EPS, LOT_ROW_FLAGS, invEffect, lotErr, roundLot, vanMoveEffect, zeroBuckets,
  type BucketQty, type LotBucket, type LotCertainty, type LotMeta, type LotPlace, type LotRowFlag, type LotTraceDto, type PlaceLotView, type VanMoveType,
} from './lots';

/** اسم سيارة مندوبٍ حُذف — كسجلّ التحميلات (REP_GONE_NAME في vanStock.ts) */
export const LOT_REP_GONE_NAME = 'مندوب محذوف';

const uniq = (xs: Iterable<string | null | undefined>): string[] => [...new Set([...xs].filter((x): x is string => typeof x === 'string' && x.length > 0))];
const chunks = <T>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const iso = (d: Date | string | null | undefined): string => (d ? new Date(d).toISOString() : '');
const isoDay = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString().slice(0, 10) : null);
const anyPositive = (b: BucketQty) => LOT_BUCKETS.some((k) => b[k] > LOT_EPS);
const anyNonZero = (b: BucketQty) => LOT_BUCKETS.some((k) => Math.abs(b[k]) > LOT_EPS);
const addBuckets = (a: BucketQty, b: BucketQty): BucketQty => ({ SELLABLE: a.SELLABLE + b.SELLABLE, EXPIRED: a.EXPIRED + b.EXPIRED, DAMAGED: a.DAMAGED + b.DAMAGED });
const roundB = (b: BucketQty): BucketQty => ({ SELLABLE: roundLot(b.SELLABLE), EXPIRED: roundLot(b.EXPIRED), DAMAGED: roundLot(b.DAMAGED) });

// ═══ مفاتيح السيارات والمراجع ═══

/**
 * السيارات التي مرّ بها لوطٌ أو صنف: مفاتيح صفوف التوزيع (حركات السيارة، والفواتير، والتسميات في السيارة) — ومنها سيارات
 * المناديب المحذوفين (المفتاح نصّ يبقى بعد الحذف).
 */
export async function lotVanKeys(db: LotDb, tid: string, q: { lotIds?: string[]; productIds?: string[] }): Promise<string[]> {
  const lotIds = q.lotIds ? uniq(q.lotIds) : [];
  const productIds = q.productIds ? uniq(q.productIds) : [];
  if (!lotIds.length && !productIds.length) return [];
  const by = lotIds.length ? { lotId: { in: lotIds } } : { productId: { in: productIds } };
  const van = await db.vanLoadItemLot.findMany({ where: { tenantId: tid, ...by }, select: { vanKey: true }, distinct: ['vanKey'] });
  const inv = await db.invoiceItemLot.findMany({ where: { tenantId: tid, ...by, vanKey: { not: null } }, select: { vanKey: true }, distinct: ['vanKey'] });
  const rel = await db.lotRelabel.findMany({
    where: {
      tenantId: tid, place: 'VAN', vanKey: { not: null },
      ...(lotIds.length ? { OR: [{ fromLotId: { in: lotIds } }, { toLotId: { in: lotIds } }] } : { productId: { in: productIds } }),
    },
    select: { vanKey: true }, distinct: ['vanKey'],
  });
  return uniq([...van.map((r) => r.vanKey), ...inv.map((r) => r.vanKey), ...rel.map((r) => r.vanKey)]).sort();
}

/**
 * حدث سجل اللوط مرئيٌّ للنطاق؟ حدثٌ في سيارةٍ (تسمية: after.place = 'VAN' وvanKey) لمقيّدٍ مرئيٌّ إن كانت من مناديب نطاقه
 * وحدهم — بلا سيارات المحذوفين (visibleReps فيها القائمون وحدهم)، كما تُسقطها الأماكن والمصدر وخطة التنزيل. وغير المقيّد
 * (null) يرى كل شيء، وما ليس في سيارة (المستودع والإنشاء والتواريخ والحالة) مرئيٌّ للجميع.
 */
export function lotEventVisible(after: unknown, visibleReps: ReadonlySet<string> | null | undefined): boolean {
  if (!visibleReps || !after || typeof after !== 'object' || Array.isArray(after)) return true;
  const a = after as { place?: unknown; vanKey?: unknown };
  if (a.place !== 'VAN') return true;
  return typeof a.vanKey === 'string' && visibleReps.has(a.vanKey);
}

/** أسماء المناديب القائمين بين المفاتيح — الغائب محذوف */
async function repNames(db: LotDb, tid: string, keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const reps = await db.salesRep.findMany({ where: { tenantId: tid, id: { in: keys } }, select: { id: true, name: true } });
  return new Map(reps.map((r) => [r.id, r.name]));
}

/** هل للّوط أي مرجع في الجداول الأربعة (حركات له)؟ — منع الحذف (LOT_IN_USE) وشرط نطاق مدّ الانتهاء (D27) */
export async function lotHasReferences(db: LotDb, tid: string, lotId: string): Promise<boolean> {
  if (await db.warehouseEntryItem.findFirst({ where: { lotId, entry: { tenantId: tid } }, select: { id: true } })) return true;
  if (await db.vanLoadItemLot.findFirst({ where: { tenantId: tid, lotId }, select: { id: true } })) return true;
  if (await db.invoiceItemLot.findFirst({ where: { tenantId: tid, lotId }, select: { id: true } })) return true;
  return !!(await db.lotRelabel.findFirst({ where: { tenantId: tid, OR: [{ fromLotId: lotId }, { toLotId: lotId }] }, select: { id: true } }));
}

// ═══ عرض المكان عبر الشبكة ═══

export type PlaceLotViewDto = Omit<PlaceLotView, 'firstInAt'>;
/** PlaceLotView ⇒ ما يُرسل: بلا firstInAt (خريطةٌ داخلية لطبقات الإعادة لا تُسلسَل) */
export function placeViewDto(view: PlaceLotView): PlaceLotViewDto {
  const { firstInAt: _firstInAt, ...rest } = view;
  void _firstInAt;
  return rest;
}

// ═══ ملخّصات البطاقات ═══

export interface LotPlaceBalance {
  place: LotPlace; salesRepId: string | null; repName: string | null; deleted: boolean;
  raw: BucketQty; held: BucketQty; usable: BucketQty;
}
export interface LotSummary {
  /** خام المستودع (دلوٌ واحد) */
  warehouse: number;
  /** Σ الخام في السيارات المرئية لكل دلو */
  vans: BucketQty;
  /** Σ المحجوز في السيارات (مرتجع إشعارٍ قياسي بانتظار الاعتماد، D24) */
  held: number;
  /** عدد السيارات التي فيها خامٌ موجب */
  vanCount: number;
  /** المستودع + كل دلاء السيارات */
  total: number;
  places: LotPlaceBalance[];
}

/**
 * أرصدة لوطاتٍ في أماكنها (المستودع وكل سيارة مرّت بها، والمحذوفة ضمنها) — الخام المسمّى بلا رصيد الصنف (withTotals: false):
 * الخام والمحجوز المسمّيان لا يحتاجان رصيد الصنف. `visibleVan` يرشّح السيارات (المقيّد: مناديبه وحدهم، بلا المحذوفة).
 */
export async function lotSummaries(db: LotDb, tid: string, lots: { id: string; productId: string }[],
  opts: { warehouse: boolean; visibleVan?: ((key: string, live: boolean) => boolean) | null }): Promise<Map<string, LotSummary>> {
  const out = new Map<string, LotSummary>();
  if (!lots.length) return out;
  const allKeys = await lotVanKeys(db, tid, { lotIds: lots.map((l) => l.id) });
  const names = await repNames(db, tid, allKeys);
  const keys = allKeys.filter((k) => !opts.visibleVan || opts.visibleVan(k, names.has(k)));
  const views = await placeViews(db, tid, { warehouse: opts.warehouse, vanKeys: keys, productIds: uniq(lots.map((l) => l.productId)), withTotals: false });
  for (const lot of lots) {
    const s: LotSummary = { warehouse: 0, vans: zeroBuckets(), held: 0, vanCount: 0, total: 0, places: [] };
    const wl = views.warehouse.get(lot.productId)?.lots.find((l) => l.lotId === lot.id);
    if (wl && Math.abs(wl.raw.SELLABLE) > LOT_EPS) {
      s.warehouse = wl.raw.SELLABLE;
      s.places.push({ place: 'WAREHOUSE', salesRepId: null, repName: null, deleted: false, raw: wl.raw, held: wl.held, usable: wl.usable });
    }
    for (const key of keys) {
      const l = views.vans.get(key)?.get(lot.productId)?.lots.find((x) => x.lotId === lot.id);
      if (!l || !(anyNonZero(l.raw) || anyNonZero(l.held))) continue;
      s.vans = addBuckets(s.vans, l.raw);
      s.held += l.held.SELLABLE;
      if (anyPositive(l.raw)) s.vanCount++;
      s.places.push({ place: 'VAN', salesRepId: key, repName: names.get(key) ?? LOT_REP_GONE_NAME, deleted: !names.has(key), raw: l.raw, held: l.held, usable: l.usable });
    }
    s.vans = roundB(s.vans);
    s.held = roundLot(s.held);
    s.total = roundLot(s.warehouse + s.vans.SELLABLE + s.vans.EXPIRED + s.vans.DAMAGED);
    out.set(lot.id, s);
  }
  return out;
}

// ═══ خطة التنزيل (§٤.١٦) ═══

export interface UnloadPlanRow { salesRepId: string; repName: string | null; deleted: boolean; usable: BucketQty; held: BucketQty }

/**
 * لكل سيارة فيها اللوط (ومنها المحذوفة): صالحه ومحجوزه — لتنزيله بعد الإيقاف أو السحب (POST /van-stock/loads، والمحذوفة
 * بـdeletedSalesRepId، D30). صالحٌ موجب أو محجوزٌ موجب (يُنزَّل بعد اعتماد إشعاره). القائمة أولاً بالاسم ثم المحذوفة.
 * صنفٌ أُطفئ تتبّعه (D9) خطته فارغة: رصيد لوطه للسجلّ وحده، وتنزيله باللوط مرفوضٌ في /van-stock/loads (لا يُنقص رصيده فيتكرّر).
 */
export async function unloadPlan(db: LotDb, tid: string, lotId: string): Promise<UnloadPlanRow[]> {
  const lot = await db.productLot.findFirst({
    where: { id: lotId, tenantId: tid }, select: { id: true, productId: true, product: { select: { lotTracked: true } } },
  });
  if (!lot) throw lotErr('LOT_NOT_FOUND', {}, { lotId });
  if (lot.product?.lotTracked !== true) return [];
  const keys = await lotVanKeys(db, tid, { lotIds: [lot.id] });
  if (!keys.length) return [];
  const names = await repNames(db, tid, keys);
  const views = await placeViews(db, tid, { vanKeys: keys, productIds: [lot.productId], withTotals: false });
  const rows: UnloadPlanRow[] = [];
  for (const key of keys) {
    const l = views.vans.get(key)?.get(lot.productId)?.lots.find((x) => x.lotId === lot.id);
    if (!l || !(anyPositive(l.usable) || anyPositive(l.held))) continue;
    rows.push({ salesRepId: key, repName: names.get(key) ?? LOT_REP_GONE_NAME, deleted: !names.has(key), usable: l.usable, held: l.held });
  }
  return rows.sort((a, b) => Number(a.deleted) - Number(b.deleted) || String(a.repName).localeCompare(String(b.repName), 'ar') || a.salesRepId.localeCompare(b.salesRepId));
}

// ═══ سلامة الأرصدة (/lots/health) ═══

export interface LotHealthDto {
  deficits: {
    productId: string; productName: string | null; place: LotPlace; salesRepId: string | null; repName: string | null;
    lotId: string | null; lotNumber: string | null; bucket: LotBucket; qty: number;
  }[];
}

/**
 * العجوزات لكل الأصناف المتتبَّعة والأماكن (بدل مهمة مجدولة: القاعدة هي العنق الضيّق): كل خامٍ أو صالحٍ سالب في لوطٍ
 * مسمّى، وكل غير مسمّى سالب (عجزٌ من تاريخٍ قبل التفعيل، يُصحَّح بتسويةٍ موجبة غير مسمّاة). دفعاتٌ بمئة صنف. سيارة المندوب
 * المحذوف بلوطاتها المسمّاة وحدها (رصيد صنفها مجهول).
 */
export async function lotHealth(db: LotDb, tid: string): Promise<LotHealthDto> {
  const tenant = await db.tenant.findUnique({ where: { id: tid }, select: { lotTrackingEnabled: true, warehouseEnabled: true } });
  if (tenant?.lotTrackingEnabled !== true) return { deficits: [] };
  const products = await db.product.findMany({ where: { tenantId: tid, lotTracked: true }, select: { id: true, name: true }, orderBy: { id: 'asc' } });
  if (!products.length) return { deficits: [] };
  const productName = new Map(products.map((p) => [p.id, p.name]));
  const reps = await db.salesRep.findMany({ where: { tenantId: tid }, select: { id: true, name: true } });
  const names = new Map(reps.map((r) => [r.id, r.name]));
  const deleted = (await lotVanKeys(db, tid, { productIds: products.map((p) => p.id) })).filter((k) => !names.has(k));
  const keys = [...reps.map((r) => r.id).sort(), ...deleted];
  const out: LotHealthDto['deficits'] = [];
  for (const batch of chunks(products.map((p) => p.id), 100)) {
    const res = await placeViews(db, tid, { warehouse: tenant.warehouseEnabled === true, vanKeys: keys, productIds: batch, withTotals: true });
    const push = (view: PlaceLotView) => {
      for (const d of view.deficits) {
        out.push({
          productId: view.productId, productName: productName.get(view.productId) ?? null, place: view.place,
          salesRepId: view.vanKey, repName: view.vanKey ? names.get(view.vanKey) ?? LOT_REP_GONE_NAME : null,
          lotId: d.lotId, lotNumber: d.lotId ? res.metas.get(d.lotId)?.lotNumber ?? null : null, bucket: d.bucket, qty: d.qty,
        });
      }
    };
    for (const pid of batch) {
      const w = res.warehouse.get(pid);
      if (w) push(w);
    }
    for (const key of keys) for (const pid of batch) { const v = res.vans.get(key)?.get(pid); if (v) push(v); }
  }
  return { deficits: out };
}

// ═══ الإطفاء والتفعيل الجماعي (§٤.٢) ═══

export interface NamedLotBalance { productId: string; warehouse: number; vans: { salesRepId: string; qty: number }[] }

/**
 * أرصدة المسمّى لكل صنف في كل الأماكن (بعد الحقبة) — شرط D9: إطفاء تتبّع صنفٍ له خامٌ مسمّى موجب يلزمه confirmLotBalances.
 * يُستدعى تحت قفل الأصناف في معاملة الإطفاء (وقراءةٌ مسبقة بلا قفل تمنع إطفاءً جزئياً بين الدفعات). المستودع دائماً: لوطاته
 * باقية ولو أُطفئ مخزون الشركة.
 */
export async function namedLotBalances(db: LotDb, tid: string, productIds: string[]): Promise<NamedLotBalance[]> {
  const pids = uniq(productIds);
  if (!pids.length) return [];
  const keys = await lotVanKeys(db, tid, { productIds: pids });
  const views = await placeViews(db, tid, { warehouse: true, vanKeys: keys, productIds: pids, withTotals: false });
  const sumPositive = (v: PlaceLotView | undefined) => roundLot((v?.lots ?? []).reduce((s, l) => s + LOT_BUCKETS.reduce((t, b) => t + Math.max(0, l.raw[b]), 0), 0));
  const out: NamedLotBalance[] = [];
  for (const pid of pids) {
    const warehouse = sumPositive(views.warehouse.get(pid));
    const vans = keys.map((k) => ({ salesRepId: k, qty: sumPositive(views.vans.get(k)?.get(pid)) })).filter((x) => x.qty > LOT_EPS);
    if (warehouse > LOT_EPS || vans.length) out.push({ productId: pid, warehouse, vans });
  }
  return out;
}

export interface TrackingAttention {
  productId: string; name: string;
  warehouse: { total: number; unknown: number } | null;
  vans: { salesRepId: string; total: number; unknown: number }[];
}

/**
 * ما يحتاج عملاً بعد التفعيل (إجراء يوم التفعيل، §٤.٢): الأصناف ذات الرصيد غير المسمّى أو السالب في أي مكان (SELLABLE)، أو
 * أي عجز. السالب يُصحَّح أولاً بتسويةٍ موجبة غير مسمّاة (I2 يمنع إنقاص غير المسمّى السالب)، ثم يُسمّى الرصيد. السيارات
 * `vanKeys` (المرئية للمستخدم، القائمة وحدها: رصيد صنف المحذوفة مجهول).
 */
export async function trackingAttention(db: LotDb, tid: string, products: { id: string; name: string }[],
  opts: { warehouse: boolean; vanKeys: string[] }): Promise<TrackingAttention[]> {
  const out: TrackingAttention[] = [];
  const flagged = (v: PlaceLotView | undefined) => !!v && (Math.abs(v.unknown?.SELLABLE ?? 0) > LOT_EPS || v.deficits.length > 0);
  for (const batch of chunks(products, 100)) {
    const res = await placeViews(db, tid, { warehouse: opts.warehouse, vanKeys: opts.vanKeys, productIds: batch.map((p) => p.id), withTotals: true });
    for (const p of batch) {
      const wv = opts.warehouse ? res.warehouse.get(p.id) : undefined;
      const vans = opts.vanKeys
        .map((k) => res.vans.get(k)?.get(p.id))
        .filter((v): v is PlaceLotView => flagged(v))
        .map((v) => ({ salesRepId: v.vanKey as string, total: v.total?.SELLABLE ?? 0, unknown: v.unknown?.SELLABLE ?? 0 }));
      if (!flagged(wv) && !vans.length) continue;
      out.push({
        productId: p.id, name: p.name,
        warehouse: wv ? { total: wv.total?.SELLABLE ?? 0, unknown: wv.unknown?.SELLABLE ?? 0 } : null,
        vans,
      });
    }
  }
  return out;
}

// ═══ شاشة التتبّع (§٤.١٧) ═══

export interface LotTraceOptions {
  scope: 'STRICT' | 'BROAD';
  /** canManageCustomers — وإلا customersHidden */
  canSeeCustomers: boolean;
  /** شرط نطاق المستخدم المقيّد على الفواتير (scopedRecordWhere) — null لغير المقيّد */
  scopeWhere: Record<string, unknown> | null;
  /** سيارات النطاق (مناديب المستخدم المقيّد؛ بلا المحذوفة) — null = كل السيارات ومنها المحذوفة */
  visibleReps?: ReadonlySet<string> | null;
  /** «الآن» لنافذة BROAD المفتوحة (للاختبار) */
  now?: Date;
}

/** ترتيب الضعف: المفترض أضعف من المؤكَّد، وغير المعروف أضعفها */
const weaker = (a: LotCertainty, b: LotCertainty): LotCertainty => (LOT_CERTAINTIES.indexOf(a) >= LOT_CERTAINTIES.indexOf(b) ? a : b);
const flagsOf = (s: string | null | undefined): LotRowFlag[] =>
  (s ? s.split(',').map((x) => x.trim()).filter((x): x is LotRowFlag => (LOT_ROW_FLAGS as readonly string[]).includes(x)) : []);
const certaintyOf = (s: string): LotCertainty => ((LOT_CERTAINTIES as readonly string[]).includes(s) ? (s as LotCertainty) : 'UNKNOWN');

type TraceCustomer = NonNullable<LotTraceDto['customers']>[number];
type TraceInvoice = TraceCustomer['invoices'][number];
interface CustomerInfo { id: string; name: string; phone: string | null; address: string | null; city: string | null }
interface InvoiceInfo { id: string; number: string; invoiceDate: Date; customer: CustomerInfo }

/** حدث رصيد الصنف في SELLABLE السيارة (لنافذة BROAD) */
export interface SellableEvent { at: number; delta: number }

/**
 * نوافذ وجود اللوط في السيارة (BROAD، §٤.١٧): لكل دخولٍ للوط نافذةٌ منه حتى أول حدثٍ بعده يُنقص رصيد الصنف كله في SELLABLE
 * إلى ≤ EPS (والحدث نفسه داخلها: البيع الذي أفرغ السيارة قد يحمل اللوط)، ومفتوحةً حتى `now` إن لم تفرغ. الرصيد تراكمي من أول
 * التاريخ. اشتراط الإنقاص: تحميلٌ يبقي سيارةً سالبةً تاريخياً لا يغلق نافذةً. صرفة لتُختبر وحدها.
 */
export function presenceWindows(events: SellableEvent[], entries: number[], now: number): { from: number; to: number }[] {
  const ev = events.map((e, i) => ({ ...e, i })).sort((a, b) => a.at - b.at || a.i - b.i);
  const after: number[] = [];
  let bal = 0;
  for (const e of ev) { bal += e.delta; after.push(roundLot(bal)); }
  const windows: { from: number; to: number }[] = [];
  for (const start of [...new Set(entries)].sort((a, b) => a - b)) {
    let end = now;
    for (let i = 0; i < ev.length; i++) {
      if (ev[i].at <= start) continue;
      if (ev[i].delta < 0 && after[i] <= LOT_EPS) { end = ev[i].at; break; }
    }
    windows.push({ from: start, to: Math.max(start, end) });
  }
  return windows;
}

/**
 * مصدر اللوط وأماكنه وعملاؤه وسجلّه:
 * - **المصدر** (كل التاريخ بلا حقبة): أسطر المستودع باللوط (بإشارتها؛ الافتتاحي باسمه)، والتحميلات المباشرة (viaWarehouse =
 *   false) والتسويات الموجبة في السيارات، والتسميات (+ إليه، − منه)، والمرتجع الحرّ إليه صراحةً.
 * - **الأماكن**: المستودع وكل سيارة بالخام والمحجوز والصالح (بالحقبة كالأرصدة)، ومجاميع المحمَّل والمنزَّل والمباع والمرتجع
 *   (كل التاريخ). المحذوفة «مندوب محذوف» بعلم approximate.
 * - **العملاء (STRICT)**: صفوف اللوط في الفواتير المؤكَّدة بالعميل ثم بالفاتورة — كل من بيع له وإن كان صافيه صفراً (ن١-٢).
 *   المرتجع الموروث من صفّ بيعٍ لهذا اللوط يُنسب إلى فاتورة البيع، والمرتجع الحرّ سطرٌ وحده.
 * - **BROAD**: لكل سيارةٍ قائمة حملت اللوط، كل بيعٍ للصنف منها في نوافذ وجوده (presenceWindows) لم يرد في الدقيقة — بوسم
 *   broad ويقين «مفترض» وبكمية بنده كلها. السيارة المحذوفة بصفوفها وحدها (فواتيرها فقدت مندوبها).
 * - النطاق: الفواتير بـscopeWhere، والسيارات بـvisibleReps؛ والعملاء بشرط canSeeCustomers.
 */
export async function lotTrace(db: LotDb, tid: string, lotId: string, opts: LotTraceOptions): Promise<LotTraceDto> {
  const lot = await db.productLot.findFirst({
    where: { id: lotId, tenantId: tid },
    select: {
      id: true, productId: true, lotNumber: true, productionDate: true, expiryDate: true, status: true, blockKind: true, blockedAt: true,
      createdAt: true, source: true, note: true, sourceEntryId: true, product: { select: { name: true } },
    },
  });
  if (!lot) throw lotErr('LOT_NOT_FOUND', {}, { lotId });
  const productId = lot.productId;
  const now = opts.now ?? new Date();
  const visibleKey = (key: string, live: boolean) => (opts.visibleReps ? live && opts.visibleReps.has(key) : true);

  // ── صفوف اللوط كلها (كل التاريخ) ──
  const whItems = await db.warehouseEntryItem.findMany({
    where: { lotId: lot.id, entry: { tenantId: tid } },
    select: { qty: true, unitFactor: true, baseQty: true, entry: { select: { id: true, type: true, createdAt: true } } },
  });
  const vanRows = await db.vanLoadItemLot.findMany({
    where: { tenantId: tid, lotId: lot.id },
    select: { vanKey: true, moveType: true, viaWarehouse: true, qty: true, createdAt: true, vanLoadItem: { select: { vanLoadId: true } } },
  });
  const rels = await db.lotRelabel.findMany({
    where: { tenantId: tid, OR: [{ fromLotId: lot.id }, { toLotId: lot.id }] },
    select: { id: true, place: true, vanKey: true, bucket: true, fromLotId: true, toLotId: true, qty: true, createdAt: true },
  });
  const invRows = await db.invoiceItemLot.findMany({
    where: { tenantId: tid, lotId: lot.id },
    select: {
      id: true, vanKey: true, quantity: true, certainty: true, flags: true, sourceItemLotId: true, invoiceId: true, createdAt: true,
      invoiceItem: { select: { returnExpired: true } },
    },
  });
  const invIds = uniq(invRows.map((r) => r.invoiceId));
  const invoices = invIds.length ? await db.invoice.findMany({
    where: { tenantId: tid, id: { in: invIds }, status: 'CONFIRMED' },
    select: { id: true, number: true, type: true, returnToStock: true, returnReason: true, invoiceDate: true, createdAt: true, clientCreatedAt: true, customerId: true },
  }) : [];
  const invById = new Map(invoices.map((i) => [i.id, i]));
  const confirmed = invRows.filter((r) => invById.has(r.invoiceId));

  // ── الأماكن ──
  const allKeys = uniq([
    ...vanRows.map((v) => v.vanKey), ...invRows.map((r) => r.vanKey), ...rels.filter((r) => r.place === 'VAN').map((r) => r.vanKey),
  ]).sort();
  const names = await repNames(db, tid, allKeys);
  const keys = allKeys.filter((k) => visibleKey(k, names.has(k)));
  const keySet = new Set(keys);

  // ── المصدر ──
  const origin: LotTraceDto['origin'] = [];
  for (const w of whItems) {
    const opening = lot.source === 'OPENING_IMPORT' && w.entry.id === lot.sourceEntryId;
    origin.push({ kind: opening ? 'OPENING_IMPORT' : w.entry.type, at: iso(w.entry.createdAt), ref: w.entry.id, qty: roundLot(baseQtyOf(w)) });
  }
  for (const v of vanRows) {
    if (v.viaWarehouse || !(v.moveType === 'LOAD' || v.moveType === 'ADJUST') || !(v.qty > 0) || !keySet.has(v.vanKey)) continue;
    origin.push({ kind: v.moveType, at: iso(v.createdAt), ref: v.vanLoadItem?.vanLoadId ?? null, qty: roundLot(v.qty) });
  }
  for (const r of rels) {
    if (r.place === 'VAN' && !(r.vanKey && keySet.has(r.vanKey))) continue;
    const sign = (r.toLotId === lot.id ? 1 : 0) - (r.fromLotId === lot.id ? 1 : 0);
    if (sign !== 0) origin.push({ kind: 'RELABEL', at: iso(r.createdAt), ref: r.id, qty: roundLot(sign * r.qty) });
  }
  for (const r of confirmed) {
    const inv = invById.get(r.invoiceId)!;
    if (inv.type !== 'RETURN' || r.sourceItemLotId || (r.vanKey && !keySet.has(r.vanKey))) continue;
    origin.push({ kind: 'RETURN', at: iso(inv.createdAt), ref: inv.id, qty: roundLot(r.quantity) });
  }
  origin.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const hasWarehouse = whItems.length > 0 || vanRows.some((v) => v.viaWarehouse) || rels.some((r) => r.place === 'WAREHOUSE');
  const views = await placeViews(db, tid, { warehouse: hasWarehouse, vanKeys: keys, productIds: [productId], withTotals: false });
  const lotIn = (v: PlaceLotView | undefined) => v?.lots.find((l) => l.lotId === lot.id);
  const places: LotTraceDto['places'] = [];
  if (hasWarehouse) {
    // المستودع: المحمَّل منه إلى السيارات والمنزَّل إليه منها (D28: صفوف viaWarehouse وحدها)
    let loaded = 0, unloaded = 0;
    for (const v of vanRows) {
      if (!v.viaWarehouse) continue;
      if (v.moveType === 'LOAD') loaded += v.qty;
      else if (v.moveType === 'UNLOAD') unloaded += Math.abs(v.qty);
    }
    const l = lotIn(views.warehouse.get(productId));
    places.push({
      place: 'WAREHOUSE', salesRepId: null, repName: null,
      raw: l?.raw ?? zeroBuckets(), usable: l?.usable ?? zeroBuckets(), held: l?.held ?? zeroBuckets(), approximate: false,
      loaded: roundLot(loaded), unloaded: roundLot(unloaded), sold: 0, returned: 0,
    });
  }
  for (const key of keys) {
    let loaded = 0, unloaded = 0, sold = 0, returned = 0;
    for (const v of vanRows) {
      if (v.vanKey !== key) continue;
      if (v.moveType === 'LOAD') loaded += v.qty;
      else if (v.moveType === 'UNLOAD') unloaded += Math.abs(v.qty);
    }
    for (const r of confirmed) {
      if (r.vanKey !== key) continue;
      if (invById.get(r.invoiceId)!.type === 'RETURN') returned += r.quantity; else sold += r.quantity;
    }
    const l = lotIn(views.vans.get(key)?.get(productId));
    places.push({
      place: 'VAN', salesRepId: key, repName: names.get(key) ?? LOT_REP_GONE_NAME,
      raw: l?.raw ?? zeroBuckets(), usable: l?.usable ?? zeroBuckets(), held: l?.held ?? zeroBuckets(), approximate: !names.has(key),
      loaded: roundLot(loaded), unloaded: roundLot(unloaded), sold: roundLot(sold), returned: roundLot(returned),
    });
  }

  // ── العملاء ──
  const scoped = !!opts.visibleReps || (!!opts.scopeWhere && Object.keys(opts.scopeWhere).length > 0);
  let customers: LotTraceDto['customers'] = null;
  if (opts.canSeeCustomers) {
    const scopeWhere = opts.scopeWhere && Object.keys(opts.scopeWhere).length ? opts.scopeWhere : null;
    const loadInvoices = async (ids: string[]): Promise<Map<string, InvoiceInfo>> => {
      if (!ids.length) return new Map();
      const rows = await db.invoice.findMany({
        where: { tenantId: tid, id: { in: ids }, status: 'CONFIRMED', ...(scopeWhere ?? {}) },
        select: { id: true, number: true, invoiceDate: true, customer: { select: { id: true, name: true, phone: true, address: true, city: true } } },
      });
      return new Map(rows.map((r) => [r.id, {
        id: r.id, number: r.number, invoiceDate: r.invoiceDate,
        customer: { id: r.customer.id, name: r.customer.name, phone: r.customer.phone ?? null, address: r.customer.address ?? null, city: r.customer.city ?? null },
      }]));
    };
    const strictInfo = await loadInvoices(uniq(confirmed.map((r) => r.invoiceId)));
    const byCustomer = new Map<string, { info: CustomerInfo; invoices: Map<string, TraceInvoice & { at: string }> }>();
    const entry = (inv: InvoiceInfo, broad: boolean) => {
      let c = byCustomer.get(inv.customer.id);
      if (!c) { c = { info: inv.customer, invoices: new Map() }; byCustomer.set(inv.customer.id, c); }
      let e = c.invoices.get(inv.id);
      if (!e) {
        e = { invoiceId: inv.id, number: inv.number, date: iso(inv.invoiceDate), sold: 0, returned: 0, net: 0, weakest: 'CONFIRMED', flags: [], broad, at: iso(inv.invoiceDate) };
        c.invoices.set(inv.id, e);
      }
      return e;
    };
    const mark = (e: TraceInvoice, certainty: string, flags: string | null) => {
      e.weakest = weaker(e.weakest, certaintyOf(certainty));
      const fl = new Set<LotRowFlag>([...e.flags, ...flagsOf(flags)]);
      e.flags = LOT_ROW_FLAGS.filter((f) => fl.has(f));
    };
    // صفوف البيع أولاً: كل من بيع له يُدرج، ثم المرتجعات تُنسب إلى بيعها فيظهر صافي الصفر
    const saleRowInvoice = new Map<string, InvoiceInfo>();
    for (const r of confirmed) {
      const info = strictInfo.get(r.invoiceId);
      if (!info || invById.get(r.invoiceId)!.type === 'RETURN') continue;
      const e = entry(info, false);
      e.sold += r.quantity;
      mark(e, r.certainty, r.flags);
      saleRowInvoice.set(r.id, info);
    }
    for (const r of confirmed) {
      const info = strictInfo.get(r.invoiceId);
      if (!info || invById.get(r.invoiceId)!.type !== 'RETURN') continue;
      const src = r.sourceItemLotId ? saleRowInvoice.get(r.sourceItemLotId) : undefined;
      const e = entry(src ?? info, false);
      e.returned += r.quantity;
      mark(e, r.certainty, r.flags);
    }

    if (opts.scope === 'BROAD') {
      const strictIds = new Set(confirmed.map((r) => r.invoiceId));
      for (const key of keys) {
        if (!names.has(key)) continue; // سيارة المحذوف بصفوفها وحدها
        // دخول اللوط إلى SELLABLE السيارة: تحميلٌ أو تسويةٌ موجبة، وتسميةٌ إليه، ومرتجعٌ عائد للمخزون منه
        const entries: number[] = [];
        // لحظة المستند كالبيع (§٤.١٧): clientCreatedAt ?? createdAt — مرتجعٌ دون اتصال يُدخل اللوط لحظة أخذه لا لحظة المزامنة
        const atOf = (inv: { clientCreatedAt: Date | null; createdAt: Date }) => new Date(inv.clientCreatedAt ?? inv.createdAt).getTime();
        for (const v of vanRows) if (v.vanKey === key && (v.moveType === 'LOAD' || v.moveType === 'ADJUST') && v.qty > 0) entries.push(new Date(v.createdAt).getTime());
        for (const r of rels) if (r.place === 'VAN' && r.vanKey === key && r.bucket === 'SELLABLE' && r.toLotId === lot.id && r.qty > 0) entries.push(new Date(r.createdAt).getTime());
        for (const r of confirmed) {
          const inv = invById.get(r.invoiceId)!;
          if (r.vanKey !== key || inv.type !== 'RETURN') continue;
          const e = invEffect({ type: inv.type, returnToStock: inv.returnToStock, returnExpired: r.invoiceItem?.returnExpired ?? null, damaged: isDamagedVanReturn(inv) });
          if (e && e.bucket === 'SELLABLE' && e.sign > 0) entries.push(atOf(inv));
        }
        if (!entries.length) continue;
        const loads = await db.vanLoadItem.findMany({
          where: { productId, vanLoad: { tenantId: tid, salesRepId: key } },
          select: { qty: true, unitFactor: true, baseQty: true, vanLoad: { select: { type: true, createdAt: true } } },
        });
        const items = await db.invoiceItem.findMany({
          where: { productId, invoice: { tenantId: tid, salesRepId: key, status: 'CONFIRMED' } },
          select: {
            qty: true, unitFactor: true, baseQty: true, returnExpired: true,
            invoice: { select: { id: true, type: true, returnToStock: true, returnReason: true, createdAt: true, clientCreatedAt: true } },
          },
        });
        const events: SellableEvent[] = [];
        for (const ld of loads) {
          const e = vanMoveEffect(ld.vanLoad.type as VanMoveType);
          if (e.bucket === 'SELLABLE') events.push({ at: new Date(ld.vanLoad.createdAt).getTime(), delta: e.sign * baseQtyOf(ld) });
        }
        for (const it of items) {
          const e = invEffect({ type: it.invoice.type, returnToStock: it.invoice.returnToStock, returnExpired: it.returnExpired, damaged: isDamagedVanReturn(it.invoice) });
          if (e && e.bucket === 'SELLABLE') events.push({ at: atOf(it.invoice), delta: e.sign * baseQtyOf(it) });
        }
        const windows = presenceWindows(events, entries, now.getTime());
        const soldBy = new Map<string, number>();
        for (const it of items) {
          if (it.invoice.type === 'RETURN' || strictIds.has(it.invoice.id)) continue;
          const at = atOf(it.invoice);
          if (!windows.some((w) => at >= w.from && at <= w.to)) continue;
          soldBy.set(it.invoice.id, (soldBy.get(it.invoice.id) ?? 0) + baseQtyOf(it));
        }
        const broadInfo = await loadInvoices([...soldBy.keys()]);
        for (const [invId, qty] of soldBy) {
          const info = broadInfo.get(invId);
          if (!info) continue; // خارج النطاق
          const e = entry(info, true);
          e.sold += qty;
          e.weakest = weaker(e.weakest, 'ASSUMED');
        }
      }
    }

    customers = [...byCustomer.values()]
      .map((c): TraceCustomer => ({
        customerId: c.info.id, name: c.info.name, phone: c.info.phone, address: c.info.address, city: c.info.city,
        invoices: [...c.invoices.values()]
          .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.invoiceId.localeCompare(b.invoiceId)))
          .map(({ at: _at, ...x }) => { void _at; return { ...x, sold: roundLot(x.sold), returned: roundLot(x.returned), net: roundLot(x.sold - x.returned) }; }),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar') || a.customerId.localeCompare(b.customerId));
  }

  // ── السجلّ ── (تسميات سياراتٍ خارج النطاق تسقط كأماكنها، وسبب التسمية ملاحظتها)
  const evs = (await db.lotEvent.findMany({
    where: { tenantId: tid, lotId: lot.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { kind: true, createdAt: true, actorName: true, reason: true, after: !!opts.visibleReps },
  })).filter((e) => lotEventVisible(e.after, opts.visibleReps));

  const meta: LotMeta = {
    id: lot.id, productId, lotNumber: lot.lotNumber,
    productionDate: isoDay(lot.productionDate), expiryDate: isoDay(lot.expiryDate),
    status: lot.status === 'ACTIVE' ? 'ACTIVE' : 'BLOCKED', blockKind: lot.blockKind === 'HOLD' || lot.blockKind === 'RECALL' ? lot.blockKind : null,
    blockedAt: lot.blockedAt ?? null, createdAt: lot.createdAt,
  };
  return {
    lot: { ...meta, productName: lot.product?.name ?? '', source: lot.source, note: lot.note ?? null },
    origin, places, customers,
    customersHidden: !opts.canSeeCustomers, scoped, scope: opts.scope,
    events: evs.map((e) => ({ kind: e.kind, at: iso(e.createdAt), actorName: e.actorName ?? null, reason: e.reason ?? null })),
  };
}
