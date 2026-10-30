/**
 * «تتبّع اللوط» — وارد المستودع وتسوياته، والاستيراد الافتتاحي والتراجع عنه، وما لا يُباع من السيارات في بطاقة المستودع
 * (المواصفة §٤.٤ و§٤.٥، الحزمة B3). لا يستورد إعداد القاعدة: `db` أو `tx` معاملاً (lots-warehouse وlots-import بقاعدة مزيّفة).
 *
 * كل كتابةٍ هنا داخل معاملةٍ تمسك قفل أصنافها (lockLotProducts): الصنف المتتبَّع **تحت القفل** هو المرجع (D25)، وغيره يمرّ
 * بلا لوط (lotId null) كما كان. كل كمية بوحدة الأساس (D22) وبأربع خانات (isLotQty). وكل إنقاص لا يجعل صالح لوطٍ سالباً (I1)،
 * ولا يُنقص غير المسمّى دون min(0, قبله) (I2) — والتراجع عن الافتتاحي إنقاصٌ كذلك.
 */
import type { LotDb, LotEventActor, LotTx } from './lotsDb';
import { companyDay, loadLotMetas, lockLotProducts, placeViews, resolveOrCreateLot } from './lotsDb';
import {
  LOT_EPS, LOT_UNKNOWN_KEY, LotError, aggregateRequest, isLotQty, lotDatesProblem, lotErr, lotRemovalsOf, normalizeLotNumber, pickOutSources,
  refsOfByLot, removalKeepsLots, roundLot, splitAvailability,
  type LotActor, type LotMeta, type LotRef, type LotRemovalItem, type LotSource, type LotWarning, type PlaceLotView, type WarehouseEntryPlan, type WarehouseEntryPlanInput,
} from './lots';
import { shelfLifeOf, type ShelfLifeSettings } from './shelfLife';
import { baseQtyOf } from './units';

// ═══ الفاعل وأعمدة الصنف ═══

/** هوية الطلب كما يحملها req.user — ما يلزم لفاعل اللوط وسجل تدقيقه */
export interface LotRequestUser {
  id?: string; name?: string; role?: string; impersonated?: boolean; by?: string; byKind?: 'OWNER' | 'STAFF'; apiKeyId?: string;
}

/** فاعل الخطة: المفتاح، أو المندوب، أو الإدارة */
export function lotActorOf(user: LotRequestUser | null | undefined): LotActor {
  if (user?.apiKeyId) return 'API_KEY';
  return user?.role === 'SALES_REP' ? 'REP' : 'ADMIN';
}

/**
 * فاعل سجل التدقيق (LotEvent، المادة ٥٢): جلسة «دخول» المالك أو موظف المنصة موسومةٌ بمُصدِرها لا باسم المدير الذي وُقّع به
 * التوكن (وعد «لا يدخل حسابك إلا مديره»)، والمفتاح بمعرّفه، والإدارة بمعرّفها واسمها.
 */
export function lotEventActorOf(user: LotRequestUser | null | undefined): LotEventActor {
  if (!user) return { type: 'SYSTEM', id: null, name: null };
  if (user.impersonated) {
    return user.byKind === 'STAFF'
      ? { type: 'STAFF', id: user.by ?? null, name: 'موظف المنصة' }
      : { type: 'OWNER', id: user.by ?? null, name: 'الدعم الفني' };
  }
  if (user.apiKeyId) return { type: 'API_KEY', id: user.apiKeyId, name: user.name ?? null };
  return { type: 'ADMIN', id: user.id ?? null, name: user.name ?? null };
}

/**
 * أعمدة الصنف التي تلزم الوارد والاستيراد: العلم وحقول صلاحيته (انتهاء اللوط الجديد إلزامي مع الصلاحية). تُضمّ إلى قراءة
 * الأصناف القائمة نفسها — أعمدةٌ في الاستعلام نفسه لا استعلامٌ زائد، والميزة مطفأة لا تُقرأ منها قيمة.
 */
export const LOT_PRODUCT_SELECT = { lotTracked: true, shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true } as const;

/** صلاحية الصنف مفعّلة ومكتملة ⇒ انتهاء اللوط الجديد إلزامي (LOT_EXPIRY_REQUIRED) */
export function lotShelfLifeOn(p: ShelfLifeSettings | null | undefined): boolean {
  return !!p && shelfLifeOf(p) != null;
}

/**
 * بنود الطلب ⇒ أسطر الخطة: idx موضع البند، والكمية **بالأساس** (`baseQtys` بترتيب البنود، من unitFields نفسها التي تكتب السطر)،
 * والاسم وإلزام الانتهاء من صفّ الصنف المقروء.
 */
export function warehousePlanLines(
  items: readonly { productId: string; lotId?: string | null; lotNumber?: string | null; productionDate?: string | null; expiryDate?: string | null }[],
  baseQtys: readonly number[],
  products: readonly ({ id: string; name?: string | null } & ShelfLifeSettings)[],
): WarehouseEntryPlanInput['lines'] {
  const byId = new Map(products.map((p) => [p.id, p]));
  return items.map((i, idx) => {
    const p = byId.get(i.productId);
    return {
      idx, productId: i.productId, productName: p?.name ?? '', shelfLifeOn: lotShelfLifeOn(p), qty: baseQtys[idx],
      ...(i.lotId !== undefined && { lotId: i.lotId }),
      ...(i.lotNumber != null && { lotNumber: i.lotNumber }),
      productionDate: i.productionDate ?? null, expiryDate: i.expiryDate ?? null,
    };
  });
}

// ═══ خطة الوارد والتسوية (§٤.٤) ═══

/** أقفال المعاملة كما تعيدها lockLotProducts */
export interface LotLocks { tracked: ReadonlySet<string>; since: ReadonlyMap<string, Date | null> }

/** خيارات تُضاف إلى عقد الخطة المجمَّد دون تغييره */
export interface WarehouseEntryPlanOptions {
  /** نتيجة lockLotProducts في المعاملة نفسها — المسار يقفل صراحةً قبل الخطة؛ الغائب ⇒ تقفل الخطة بنفسها */
  locked?: LotLocks | null;
  /** فاعل سجل التدقيق؛ الغائب ⇒ من actor وcreatedBy */
  eventActor?: LotEventActor | null;
}

type PlanLine = WarehouseEntryPlanInput['lines'][number];

const blank = (s: string | null | undefined): boolean => s == null || String(s).trim() === '';
const uniq = (xs: Iterable<string>): string[] => [...new Set(xs)];

/** خطأ من pickOutSources باسم الصنف (رسالته بلا اسم) — الرمز والحالة والتفاصيل كما هي */
function named(e: LotError, name: string): LotError {
  if (!name) return e;
  if (e.code === 'LOT_REQUIRED') return lotErr('LOT_REQUIRED', { name }, e.detail);
  const message = e.code === 'LOT_STOCK_INSUFFICIENT' ? e.message.replace('الكمية أكبر', `الكمية من «${name}» أكبر`) : e.message;
  return new LotError(e.code, message, e.status, { ...e.detail, productName: name });
}

/**
 * العرض بعد إنقاص صفوفٍ من صالح SELLABLE (اللوط، أو غير المسمّى للصفّ الفارغ) — ما تقرؤه pickOutSources وحده لاختيار مصدر
 * الأسطر بلا لوط مما بقي بعد صريح الصنف. الخام والرصيد لا يُمسّان: الفحص المجمَّع بعده على العرض الأصلي.
 */
function withoutRows(view: PlaceLotView, rows: readonly { lotId: string | null; qty: number }[]): PlaceLotView {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.lotId ?? LOT_UNKNOWN_KEY, (by.get(r.lotId ?? LOT_UNKNOWN_KEY) ?? 0) + Math.abs(r.qty));
  const lots = view.lots.map((l) => (by.has(l.lotId) ? { ...l, usable: { ...l.usable, SELLABLE: roundLot(l.usable.SELLABLE - by.get(l.lotId)!) } } : l));
  const u = by.get(LOT_UNKNOWN_KEY);
  const unknownUsable = u != null && view.unknownUsable ? { ...view.unknownUsable, SELLABLE: roundLot(view.unknownUsable.SELLABLE - u) } : view.unknownUsable;
  return { ...view, lots, unknownUsable };
}

/**
 * خطة اللوط لحركة مستودع داخل معاملتها بعد lockLotProducts (المتتبَّع تحت القفل هو المرجع، D25). أي رفضٍ LotError يُلغي
 * المعاملة كلها: لا نصف حركة.
 * - **غير المتتبَّع:** lotId null بلا فحص — المستودع السالب جائزٌ له كما كان.
 * - **الكمية:** لكل سطرٍ متتبَّع بالأساس وبأربع خانات (isLotQty) وإلا LOT_QTY_INVALID: الطيّ مقرَّب لأربع خانات، فكسرٌ أدقّ
 *   يُعرض صالحه أكبر من خامه فيُصرف فوقه (I1).
 * - **النقص أولاً** (ADJUST سالب)، على عرض المستودع تحت القفل قبل إنشاء أي لوط في الحركة — فزيادةٌ في الحركة نفسها لا تغطّي
 *   نقصها: يُجمع الطلب لكل صنف ولوط (D26) ثم pickOutSources: الصريح (لوط، أو رقمٌ قائم، أو null لغير المسمّى) ≤ صالحه (I1)،
 *   وغير المسمّى لا ينزل دون min(0, قبله) (I2)؛ والسطر بلا لوط يأخذ المصدر الوحيد في المستودع وإلا LOT_REQUIRED بقائمتها (D10).
 *   الموقوف والمنتهي يخرجان من هنا (الإتلاف في المستودع تسوية نقص باللوط، §٤.١٦).
 * - **ثم الزيادة:** RECEIVE ⇒ lotId أو lotNumber إلزامي (LOT_REQUIRED) وresolveOrCreateLot بمصدر RECEIVE والانتهاء إلزامي مع
 *   الصلاحية؛ ADJUST موجب ⇒ لوط، أو رقمٌ يُنشأ بمصدر MANUAL، أو null صريح لغير المسمّى. لوطٌ بمعرّفه وتواريخ مخالفة
 *   LOT_DATES_MISMATCH، والزيادة إلى لوطٍ موقوف مقبولة بتحذير LOT_INTO_BLOCKED.
 */
export async function planWarehouseEntryInTx(tx: LotTx, input: WarehouseEntryPlanInput & WarehouseEntryPlanOptions): Promise<WarehouseEntryPlan> {
  const tid = input.tenantId;
  const pids = uniq(input.lines.map((l) => l.productId));
  const locked = input.locked ?? await lockLotProducts(tx, tid, pids);
  const tracked = new Set(pids.filter((p) => locked.tracked.has(p)));
  const lotIdByLine = new Map<number, string | null>();
  const warnings: LotWarning[] = [];
  const actor: LotEventActor = input.eventActor
    ?? { type: input.actor === 'API_KEY' ? 'API_KEY' : 'ADMIN', id: null, name: input.createdBy ?? null };
  const source: LotSource = input.sourceEntryId ? 'OPENING_IMPORT' : input.type === 'RECEIVE' ? 'RECEIVE' : 'MANUAL';

  const ins: PlanLine[] = [];
  const outs: PlanLine[] = [];
  for (const l of input.lines) {
    if (!tracked.has(l.productId)) { lotIdByLine.set(l.idx, null); continue; }
    if (!Number.isFinite(l.qty) || !isLotQty(Math.abs(l.qty)) || (input.type === 'RECEIVE' && l.qty < 0)) {
      throw lotErr('LOT_QTY_INVALID', {}, { productId: l.productId, productName: l.productName, idx: l.idx, qty: l.qty, decimals: 4 });
    }
    // «∅» مفتاح غير المسمّى في خرائط التجميع لا معرّف تشغيلة: يُحسب في النقص على غير المسمّى ثم يُكتب حرفياً lotId للسطر
    // (مفتاحٌ أجنبي بلا صفّ ⇒ 500). غير المسمّى يُطلب بـnull الصريح وحده
    if (l.lotId === LOT_UNKNOWN_KEY) throw lotErr('LOT_NOT_FOUND', {}, { productId: l.productId, productName: l.productName, idx: l.idx, lotId: l.lotId });
    (l.qty > 0 ? ins : outs).push(l);
  }

  // ── النقص: التسوية السالبة من عرض المستودع تحت القفل (I1، I2) ──
  if (outs.length) {
    const refOf = new Map<number, LotRef>();
    // رقمٌ لإنقاص: لوطٌ قائمٌ وحده (لا يُنشأ لوطٌ من نقص) — قراءةٌ واحدة لأرقام الحركة
    const byNumber = outs.filter((l) => !(typeof l.lotId === 'string' && l.lotId) && !blank(l.lotNumber));
    const found = new Map<string, string>();
    if (byNumber.length) {
      const nums = uniq(byNumber.map((l) => normalizeLotNumber(l.lotNumber)).filter((x): x is string => x != null));
      const rows = nums.length ? await tx.productLot.findMany({
        where: { tenantId: tid, productId: { in: uniq(byNumber.map((l) => l.productId)) }, lotNumber: { in: nums } },
        select: { id: true, productId: true, lotNumber: true },
      }) : [];
      for (const r of rows) found.set(`${r.productId}|${r.lotNumber}`, r.id);
    }
    for (const l of outs) {
      const q = Math.abs(l.qty);
      if (typeof l.lotId === 'string' && l.lotId) refOf.set(l.idx, { lotId: l.lotId, qty: q });
      else if (!blank(l.lotNumber)) {
        const num = normalizeLotNumber(l.lotNumber);
        const id = num ? found.get(`${l.productId}|${num}`) : undefined;
        if (!id) throw lotErr('LOT_NOT_FOUND', {}, { productId: l.productId, productName: l.productName, idx: l.idx, lotNumber: num ?? l.lotNumber });
        refOf.set(l.idx, { lotId: id, qty: q });
      } else if (l.lotId === null) {
        if (!input.allowUnknown) throw lotErr('LOT_REQUIRED', { name: l.productName }, { productId: l.productId, idx: l.idx });
        refOf.set(l.idx, { lotId: null, qty: q });
      }
    }
    const outPids = uniq(outs.map((l) => l.productId));
    const views = await placeViews(tx, tid, { warehouse: true, productIds: outPids, withTotals: true });
    const explicitIds = uniq([...refOf.values()].map((r) => r.lotId).filter((x): x is string => x != null));
    const lookup: ReadonlyMap<string, LotMeta> | null = explicitIds.length ? await loadLotMetas(tx, tid, { lotIds: explicitIds }) : null;
    const groups = aggregateRequest(outs.map((l) => ({ idx: l.idx, productId: l.productId, qty: Math.abs(l.qty), refs: refOf.has(l.idx) ? [refOf.get(l.idx)!] : null })));
    for (const [pid, g] of groups) {
      const view = views.warehouse.get(pid);
      const lines = outs.filter((l) => l.productId === pid);
      const name = lines[0]?.productName ?? '';
      if (!view) throw lotErr('LOT_STOCK_INSUFFICIENT', { name, place: 'المستودع', available: 0 }, { productId: pid, wanted: g.qty });
      // الأسطر بلا لوط: المصدر الوحيد في المستودع **مما بقي بعد صريح الصنف** (D10، كـpickPlan في السيارة)، وأكثر من مصدر ⇒
      // LOT_REQUIRED بقائمتها. الصريح يُفحص مجمَّعاً أولاً ثم يُطرح من العرض — صريحٌ يصفّي لوطاً لا يُبقيه مصدراً منافساً
      const auto = lines.filter((l) => !refOf.has(l.idx));
      if (auto.length) {
        let rest = view;
        if (g.byLot.size) {
          const ex = pickOutSources(view, 'SELLABLE', [...g.byLot.values()].reduce((s, q) => s + q, 0), refsOfByLot(g.byLot), lookup);
          if (!ex.ok) throw named(ex.error, name);
          rest = withoutRows(view, ex.rows);
        }
        const pick = pickOutSources(rest, 'SELLABLE', auto.reduce((s, l) => s + Math.abs(l.qty), 0));
        if (!pick.ok) throw named(pick.error, name);
        const src = pick.rows[0]?.lotId ?? null;
        if (src == null && !input.allowUnknown) throw lotErr('LOT_REQUIRED', { name }, { productId: pid });
        for (const l of auto) {
          refOf.set(l.idx, { lotId: src, qty: Math.abs(l.qty) });
          const k = src ?? LOT_UNKNOWN_KEY;
          g.byLot.set(k, (g.byLot.get(k) ?? 0) + Math.abs(l.qty));
        }
      }
      // الطلب مجمَّعاً على كل (لوط أو غير المسمّى) قبل المقارنة (D26): سطران على لوطٍ واحد يُفحصان معاً لا كلٌّ وحده
      const all = pickOutSources(view, 'SELLABLE', g.qty, refsOfByLot(g.byLot), lookup);
      if (!all.ok) throw named(all.error, name);
    }
    for (const l of outs) lotIdByLine.set(l.idx, refOf.get(l.idx)?.lotId ?? null);
  }

  // ── الزيادة: الوارد والتسوية الموجبة ──
  for (const l of ins) {
    const hasId = typeof l.lotId === 'string' && l.lotId.length > 0;
    const hasNumber = !blank(l.lotNumber);
    if (!hasId && !hasNumber) {
      // التسوية بالزيادة تقبل غير المسمّى صراحةً (null)؛ والوارد يلزمه لوط
      if (input.type === 'ADJUST' && l.lotId === null && input.allowUnknown) { lotIdByLine.set(l.idx, null); continue; }
      throw lotErr('LOT_REQUIRED', { name: l.productName }, { productId: l.productId, idx: l.idx });
    }
    const production = blank(l.productionDate) ? null : String(l.productionDate);
    const expiry = blank(l.expiryDate) ? null : String(l.expiryDate);
    if (hasId && (production != null || expiry != null)) {
      const bad = lotDatesProblem(production, expiry, { expiryRequired: false });
      if (bad) throw lotErr(bad, {}, { productId: l.productId, idx: l.idx });
    }
    const r = await resolveOrCreateLot(tx, tid, { id: l.productId, name: l.productName, shelfLifeOn: l.shelfLifeOn },
      { lotId: hasId ? l.lotId : null, lotNumber: hasId ? null : l.lotNumber ?? null, productionDate: production, expiryDate: expiry },
      { source, sourceEntryId: input.sourceEntryId ?? null, createdBy: input.createdBy, actor });
    // لوطٌ بمعرّفه وتواريخ مُرسَلة: تطابق المسجَّل (كالرقم في resolveOrCreateLot) — لا يُصحَّح تاريخ لوطٍ من وارد
    if (hasId && ((production != null && production !== r.meta.productionDate) || (expiry != null && expiry !== r.meta.expiryDate))) {
      throw lotErr('LOT_DATES_MISMATCH', { lot: r.meta.lotNumber }, { lotId: r.meta.id, productionDate: r.meta.productionDate, expiryDate: r.meta.expiryDate });
    }
    if (r.meta.status !== 'ACTIVE') {
      warnings.push({ code: 'LOT_INTO_BLOCKED', productId: l.productId, detail: { idx: l.idx, lotId: r.meta.id, lotNumber: r.meta.lotNumber, blockKind: r.meta.blockKind } });
    }
    lotIdByLine.set(l.idx, r.meta.id);
  }

  return { tracked, lotIdByLine, warnings };
}

// ═══ ما لا يُباع من السيارات في بطاقة المستودع (§٤.٤ البند ٧) ═══

export interface VansLotUnsellable {
  /** صالح SELLABLE للوطات موقوفة، أو نشطةٍ منتهية لم تُبع (حكمها حكم المعزول) — مجموع الأصناف المتتبَّعة في سيارات النطاق */
  lotQuarantined: number;
  /** المحجوز في SELLABLE (مرتجع إشعارٍ قياسي «01» قابلٌ للإبطال، D24) — المسمّى وغير المسمّى */
  lotHeld: number;
  /** لكل صنفٍ متتبَّع له منهما شيء */
  lotProducts: { productId: string; lotQuarantined: number; lotHeld: number }[];
}

/**
 * المعزول والمحجوز في سيارات `repIds` لكل صنف متتبَّع — داخلان في «المتاح» (bucketRemaining) ولا يُباعان، فتضيفهما الواجهة إلى
 * «لا يُباع». قراءةٌ بلا قفل؛ `day` يوم القياس («المخزون في تاريخ» إن طُلب، وإلا يوم الشركة الآن)، و`before` حدّه.
 */
export async function vansLotUnsellable(db: LotDb, tid: string, repIds: readonly string[], q: { day?: string | null; before?: Date }): Promise<VansLotUnsellable> {
  const out: VansLotUnsellable = { lotQuarantined: 0, lotHeld: 0, lotProducts: [] };
  if (!repIds.length) return out;
  const tracked = (await db.product.findMany({ where: { tenantId: tid, lotTracked: true }, select: { id: true } })).map((p) => p.id);
  if (!tracked.length) return out;
  const day = q.day ?? (await companyDay(db, tid)).day;
  const views = await placeViews(db, tid, { vanKeys: [...repIds], productIds: tracked, withTotals: true, ...(q.before && { before: q.before }) });
  const per = new Map<string, { q: number; h: number }>();
  for (const byProduct of views.vans.values()) {
    for (const [pid, view] of byProduct) {
      const s = splitAvailability(view, day, { allowUnknown: true });
      const quarantined = Math.max(0, s.quarantined + s.expiredUnsold);
      const held = Math.max(0, s.held);
      if (quarantined <= LOT_EPS && held <= LOT_EPS) continue;
      const acc = per.get(pid) ?? { q: 0, h: 0 };
      acc.q += quarantined;
      acc.h += held;
      per.set(pid, acc);
    }
  }
  for (const [productId, acc] of per) {
    out.lotProducts.push({ productId, lotQuarantined: roundLot(acc.q), lotHeld: roundLot(acc.h) });
    out.lotQuarantined += acc.q;
    out.lotHeld += acc.h;
  }
  out.lotQuarantined = roundLot(out.lotQuarantined);
  out.lotHeld = roundLot(out.lotHeld);
  return out;
}

// ═══ الاستيراد الافتتاحي (§٤.٥) ═══

/**
 * لوط صفّ الاستيراد بعد التحقق الصرف (resolveOpeningStockRows): الرقم مطبَّعاً والتاريخان YYYY-MM-DD، و`expiryRequired` لصنفٍ
 * صلاحيته مفعّلة (الانتهاء إلزامي للتشغيلة الجديدة وحدها)
 */
export interface OpeningLotRef { lotNumber: string; productionDate: string | null; expiryDate: string | null; expiryRequired?: boolean }
/** سطر الجرد كما يمرّ إلى الخطة: الكمية بوحدة الصفّ ولقطتها (الأساس منها) ولوطه إن كان صنفه متتبَّعاً */
export interface OpeningLotLine { row: number; productId: string; qty: number; unitFactor?: number; lot?: OpeningLotRef | null }
export interface OpeningLotRejection { row: number; code: 'LOT_REQUIRED' | 'LOT_DATES_MISMATCH' | 'LOT_EXPIRY_REQUIRED'; value?: string; field?: string }

const dayDate = (d: string | null): Date | null => (d ? new Date(`${d}T00:00:00.000Z`) : null);
const isoDay = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString().slice(0, 10) : null);

/**
 * لوطات بنود الجرد الافتتاحي داخل معاملته بعد lockLotProducts وتوليد معرّف الحركة — قواعد resolveOrCreateLot نفسها **دفعةً
 * واحدة** (قراءةٌ، فإدراجٌ ON CONFLICT DO NOTHING، فقراءة، فسجلّ تدقيق) لا أربعة استعلامات لكل صفّ: المعاملة تمسك قفل
 * gl-post ومهلتها ٣٠ ثانية وملفٌّ بخمسة آلاف صفّ لا يتّسع لعشرين ألف استعلام. وتحت قفل الأصناف لا يُنشئ أحدٌ لوطاً لها
 * (كل منشئٍ يأخذه)، فالقراءة المسبقة هي الحقيقة.
 * - صنفٌ متتبَّع تحت القفل وصفّه بلا لوط ⇒ LOT_REQUIRED (صار متتبَّعاً بعد القراءة المسبقة). وصنفٌ لم يعد متتبَّعاً ⇒ بلا لوط.
 * - رقمٌ مسجَّل بتواريخ مخالفة، أو مكرَّرٌ في الملف بتواريخ تخالف أول صفوفه ⇒ LOT_DATES_MISMATCH. الفارغ يطابق أيّاً كان.
 * - الانتهاء إلزامي مع الصلاحية (`expiryRequired`) **للجديد وحده** ⇒ LOT_EXPIRY_REQUIRED، كـresolveOrCreateLot في الوارد: القائم بلا
 *   انتهاء (أُنشئ قبل تفعيل الصلاحية) يُقبل بالفارغ، وانتهاءٌ له مخالفةٌ لا تصحيح. والصفّ المرفوض لا يحدّد تاريخي رقمه الجديد.
 * - كلها أخطاء صفوف تُحسم **قبل** أي إنشاء: لا يُنشأ لوطٌ لصفٍّ مرفوض، ولا لوطٌ بلا حركة.
 * - الجديد بمصدر OPENING_IMPORT وsourceEntryId = معرّف الحركة (للتراجع)، ومعه LotEvent CREATE. والوارد إلى لوطٍ قائمٍ موقوف
 *   مقبولٌ بتحذير LOT_INTO_BLOCKED كالوارد اليدوي.
 */
export async function planOpeningLotsInTx<L extends OpeningLotLine>(tx: LotTx, input: {
  tenantId: string; entryId: string; createdBy: string | null; actor: LotEventActor; locked: LotLocks; lines: readonly L[];
}): Promise<{ lines: L[]; rejected: OpeningLotRejection[]; lotIdByRow: Map<number, string | null>; warnings: LotWarning[] }> {
  const tid = input.tenantId;
  const rejected: OpeningLotRejection[] = [];
  const warnings: LotWarning[] = [];
  const lotIdByRow = new Map<number, string | null>();
  const isTracked = (l: L) => input.locked.tracked.has(l.productId);
  const lotted = input.lines.filter((l) => isTracked(l) && l.lot);
  const key = (pid: string, num: string) => `${pid}|${num}`;
  const existing = new Map<string, { id: string; productionDate: string | null; expiryDate: string | null; status?: string; blockKind?: string | null }>();
  if (lotted.length) {
    const rows = await tx.productLot.findMany({
      where: { tenantId: tid, productId: { in: uniq(lotted.map((l) => l.productId)) }, lotNumber: { in: uniq(lotted.map((l) => l.lot!.lotNumber)) } },
      select: { id: true, productId: true, lotNumber: true, productionDate: true, expiryDate: true, status: true, blockKind: true },
    });
    for (const r of rows) {
      existing.set(key(r.productId, r.lotNumber), { id: r.id, productionDate: isoDay(r.productionDate), expiryDate: isoDay(r.expiryDate), status: r.status, blockKind: r.blockKind });
    }
  }
  const differs = (want: OpeningLotRef, have: { productionDate: string | null; expiryDate: string | null }) =>
    (want.productionDate != null && want.productionDate !== have.productionDate) || (want.expiryDate != null && want.expiryDate !== have.expiryDate);
  const fresh = new Map<string, { productId: string; ref: OpeningLotRef }>();   // يُنشأ: أول صفّ للرقم يحدّد تاريخيه
  const accepted: L[] = [];
  for (const l of input.lines) {
    if (!isTracked(l)) { accepted.push(l); continue; }
    if (!l.lot) { rejected.push({ row: l.row, code: 'LOT_REQUIRED', field: 'lotNumber' }); continue; }
    const k = key(l.productId, l.lot.lotNumber);
    const have = existing.get(k) ?? (fresh.has(k) ? fresh.get(k)!.ref : null);
    if (have && differs(l.lot, have)) { rejected.push({ row: l.row, code: 'LOT_DATES_MISMATCH', value: l.lot.lotNumber, field: 'lotNumber' }); continue; }
    if (!have && l.lot.expiryRequired && l.lot.expiryDate == null) { rejected.push({ row: l.row, code: 'LOT_EXPIRY_REQUIRED', value: l.lot.lotNumber, field: 'expiryDate' }); continue; }
    if (!existing.has(k) && !fresh.has(k)) fresh.set(k, { productId: l.productId, ref: l.lot });
    accepted.push(l);
  }
  // صفّ الرقم الجديد الذي رُفض كل ما بعده لا يُنشئ شيئاً: الإنشاء لما بقي في المقبول وحده
  const wanted = new Set(accepted.filter((l) => isTracked(l) && l.lot).map((l) => key(l.productId, l.lot!.lotNumber)));
  const toCreate = [...fresh].filter(([k]) => wanted.has(k)).map(([, v]) => v);
  if (toCreate.length) {
    await tx.productLot.createMany({
      data: toCreate.map((c) => ({
        tenantId: tid, productId: c.productId, lotNumber: c.ref.lotNumber, productionDate: dayDate(c.ref.productionDate), expiryDate: dayDate(c.ref.expiryDate),
        source: 'OPENING_IMPORT', sourceEntryId: input.entryId, createdBy: input.createdBy, note: null,
      })),
      skipDuplicates: true,
    });
    const rows = await tx.productLot.findMany({
      where: { tenantId: tid, productId: { in: uniq(toCreate.map((c) => c.productId)) }, lotNumber: { in: uniq(toCreate.map((c) => c.ref.lotNumber)) } },
      select: { id: true, productId: true, lotNumber: true, productionDate: true, expiryDate: true, sourceEntryId: true },
    });
    const created: { id: string; productId: string; lotNumber: string; productionDate: string | null; expiryDate: string | null }[] = [];
    for (const r of rows) {
      const k = key(r.productId, r.lotNumber);
      if (!wanted.has(k) || existing.has(k)) continue;
      existing.set(k, { id: r.id, productionDate: isoDay(r.productionDate), expiryDate: isoDay(r.expiryDate) });
      if (r.sourceEntryId === input.entryId) created.push({ id: r.id, productId: r.productId, lotNumber: r.lotNumber, productionDate: isoDay(r.productionDate), expiryDate: isoDay(r.expiryDate) });
    }
    if (created.length) {
      await tx.lotEvent.createMany({
        data: created.map((c) => ({
          tenantId: tid, lotId: c.id, productId: c.productId, kind: 'CREATE',
          after: { lotNumber: c.lotNumber, productionDate: c.productionDate, expiryDate: c.expiryDate, source: 'OPENING_IMPORT', sourceEntryId: input.entryId },
          reason: null, actorType: input.actor.type, actorId: input.actor.id ?? null, actorName: input.actor.name ?? null,
        })),
      });
    }
  }
  // بترتيب الصفوف: غير المتتبَّع تحت القفل بلا لوط، والمتتبَّع بلوطه
  for (const l of accepted) {
    if (!isTracked(l) || !l.lot) { lotIdByRow.set(l.row, null); continue; }
    const e = existing.get(key(l.productId, l.lot.lotNumber));
    if (!e) throw new Error('LOT_CREATE_LOST');
    lotIdByRow.set(l.row, e.id);
    if (e.status != null && e.status !== 'ACTIVE') {
      warnings.push({ code: 'LOT_INTO_BLOCKED', productId: l.productId, detail: { row: l.row, lotId: e.id, lotNumber: l.lot.lotNumber, blockKind: e.blockKind ?? null } });
    }
  }
  return { lines: accepted, rejected, lotIdByRow, warnings };
}

/** حركة المستودع الافتتاحية المراد التراجع عنها */
export interface OpeningEntryRef { id: string; createdAt: Date; productIds: string[] }

export const OPENING_LOTS_USED_MESSAGE = 'استُعملت تشغيلات المخزون الافتتاحي بعد الاستيراد';

/**
 * يُمنع التراجع عن حركةٍ افتتاحية (LotError('LOT_IN_USE', 409) بالرسالة «استُعملت تشغيلات المخزون الافتتاحي بعد الاستيراد»)
 * داخل معاملة التراجع بعد قفل صفّ الحركة وlockLotProducts لأصنافها كلها (ن١-١١: القفل قبل أي فحص؛ `locked` نتيجته، والغائب
 * ⇒ يُقفل هنا). يُمنع إن وُجد **بعد الحركة** صفّ VanLoadItemLot على لوطاتها، أو LotRelabel منها أو إليها، أو سطر مستودعٍ سالب
 * عليها — أو إن جعل طرحُ أسطرها صالحَ لوطٍ في المستودع سالباً (I1) أو أنقص غير المسمّى دون min(0, قبله) (I2)، بدلالة الطيّ نفسها
 * (lotRemovalsOf/removalKeepsLots): السطر بلا لوط، أو الأقدم من حقبة صنفه، يُطرح من غير المسمّى. الكمية بالأساس.
 */
export async function assertOpeningRevertKeepsLots(tx: LotTx, tid: string, entry: OpeningEntryRef, locked?: LotLocks | null): Promise<void> {
  const locks = locked ?? await lockLotProducts(tx, tid, entry.productIds);
  const tracked = new Set(entry.productIds.filter((p) => locks.tracked.has(p)));
  if (!tracked.size) return;
  const used = (reason: string) => new LotError('LOT_IN_USE', OPENING_LOTS_USED_MESSAGE, 409, { entryId: entry.id, reason });
  const lines = (await tx.warehouseEntryItem.findMany({
    where: { entryId: entry.id }, select: { productId: true, qty: true, unitFactor: true, baseQty: true, lotId: true },
  })).filter((l) => tracked.has(l.productId));
  if (!lines.length) return;
  const after = { gte: entry.createdAt };
  const lotIds = uniq(lines.map((l) => l.lotId).filter((x): x is string => x != null));
  if (lotIds.length) {
    if (await tx.vanLoadItemLot.count({ where: { tenantId: tid, lotId: { in: lotIds }, createdAt: after } }) > 0) throw used('VAN_MOVEMENT');
    if (await tx.lotRelabel.count({ where: { tenantId: tid, createdAt: after, OR: [{ fromLotId: { in: lotIds } }, { toLotId: { in: lotIds } }] } }) > 0) throw used('RELABEL');
    if (await tx.warehouseEntryItem.count({ where: { lotId: { in: lotIds }, qty: { lt: 0 }, entryId: { not: entry.id }, entry: { tenantId: tid, createdAt: after } } }) > 0) {
      throw used('WAREHOUSE_OUT');
    }
  }
  // الحقبة الفعلية لكل صنف = max(حقبة الشركة، حقبة الصنف) — كما يطبّقها SQL التجميع
  const t = await tx.tenant.findUnique({ where: { id: tid }, select: { lotTrackingSince: true } });
  const since = new Map<string, Date | null>();
  for (const p of tracked) {
    const a = t?.lotTrackingSince ?? null;
    const b = locks.since.get(p) ?? null;
    since.set(p, a && b ? (a > b ? a : b) : a ?? b);
  }
  const items: LotRemovalItem[] = lines.map((l) => {
    const qty = baseQtyOf(l);
    return { productId: l.productId, qty, bucket: 'SELLABLE', held: false, rows: [{ lotId: l.lotId ?? null, quantity: qty, createdAt: entry.createdAt }] };
  });
  const removals = lotRemovalsOf(items, since, tracked);
  if (!removals.length) return;
  const views = await placeViews(tx, tid, { warehouse: true, productIds: uniq(removals.map((r) => r.productId)), withTotals: true });
  for (const pid of uniq(removals.map((r) => r.productId))) {
    const view = views.warehouse.get(pid);
    const bad = view ? removalKeepsLots(view, removals.filter((r) => r.productId === pid)) : lotErr('LOT_STOCK_INSUFFICIENT', {}, { productId: pid });
    if (bad) throw new LotError('LOT_IN_USE', OPENING_LOTS_USED_MESSAGE, 409, { entryId: entry.id, reason: 'REMOVAL', ...bad.detail });
  }
}

/**
 * بعد حذف الحركة: لوطاتٌ أنشأها هذا الاستيراد (sourceEntryId = entryId) ولم يبقَ لها مرجعٌ في الجداول الأربعة (أسطر المستودع،
 * وصفوف السيارة، وصفوف الفواتير، والتسميات منها أو إليها) تُحذف مع LotEvent DELETE لكلٍّ منها — يعيد عددها. اللوط القائم الذي
 * أعاد الملف استعماله ليس من إنشائه فيبقى، وما استُعمل بعده يبقى.
 */
export async function deleteOrphanOpeningLots(tx: LotTx, tid: string, entryId: string, actor?: LotEventActor | null): Promise<number> {
  const lots = await tx.productLot.findMany({
    where: { tenantId: tid, sourceEntryId: entryId },
    select: { id: true, productId: true, lotNumber: true, productionDate: true, expiryDate: true, source: true },
  });
  if (!lots.length) return 0;
  const ids = lots.map((l) => l.id);
  const used = new Set<string>();
  for (const r of await tx.warehouseEntryItem.findMany({ where: { lotId: { in: ids } }, select: { lotId: true } })) if (r.lotId) used.add(r.lotId);
  for (const r of await tx.vanLoadItemLot.findMany({ where: { lotId: { in: ids } }, select: { lotId: true } })) if (r.lotId) used.add(r.lotId);
  for (const r of await tx.invoiceItemLot.findMany({ where: { lotId: { in: ids } }, select: { lotId: true } })) if (r.lotId) used.add(r.lotId);
  for (const r of await tx.lotRelabel.findMany({ where: { OR: [{ fromLotId: { in: ids } }, { toLotId: { in: ids } }] }, select: { fromLotId: true, toLotId: true } })) {
    if (r.fromLotId) used.add(r.fromLotId);
    if (r.toLotId) used.add(r.toLotId);
  }
  const orphans = lots.filter((l) => !used.has(l.id));
  if (!orphans.length) return 0;
  const del = await tx.productLot.deleteMany({ where: { tenantId: tid, id: { in: orphans.map((l) => l.id) } } });
  const who = actor ?? { type: 'SYSTEM' as const, id: null, name: null };
  await tx.lotEvent.createMany({
    data: orphans.map((l) => ({
      tenantId: tid, lotId: l.id, productId: l.productId, kind: 'DELETE',
      before: { lotNumber: l.lotNumber, productionDate: isoDay(l.productionDate), expiryDate: isoDay(l.expiryDate), source: l.source, sourceEntryId: entryId },
      reason: 'التراجع عن استيراد المخزون الافتتاحي', actorType: who.type, actorId: who.id ?? null, actorName: who.name ?? null,
    })),
  });
  return del.count;
}
