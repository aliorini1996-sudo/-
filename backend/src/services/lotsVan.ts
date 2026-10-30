/**
 * «تتبّع اللوط» — حركات السيارة ولقطة المندوب (المواصفة §٤.٧، §٧.١، D30). لا يستورد إعداد القاعدة: يأخذ tx أو db معاملاً.
 *
 * planVanMovementInTx تقرّر صفوف التوزيع لكل سطرٍ متتبَّع داخل معاملة الحركة بعد lockLotProducts، وتمنع السالب على مستوى
 * اللوط بلا استثناء (I1، I2):
 * - كل إنقاصٍ من السيارة (التنزيل، وتسوية النقص، وإزالة المنتهي والتالف) من مصدرٍ صريح أو وحيدٍ في دلوه (pickOutSources، D10)،
 *   بعد تجميع الطلب لكل (صنف، لوط أو فارغ) قبل أي مقارنة (D26).
 * - التحميل في شركة المستودع إنقاصٌ من لوطات المستودع: allocateOutLines لكل صنفٍ بأسطره ومعامل وحدة كلٍّ (D22) — FEFO من
 *   المؤهَّل ثم غير المسمّى (D17)، والكرتون من لوطٍ واحد ما أمكن، والنقص 409 (D18).
 * - الزيادة بلا مصدر (التحميل بلا مستودع D4، والتسوية بالزيادة) بلوطٍ صريح أو رقمٍ يُحلّ أو يُنشأ بمصدر LOAD أو null صريح.
 * كل كمية بوحدة الأساس (D22)، موجبةٌ بأربع خانات (I7، isLotQty)، والصفوف بإشارة البند ومجموعها كميته (I3). الكتابة بنداء
 * الإنشاء الوحيد في routes/vanStock.ts (vanItemLotColumns).
 */
import type { Prisma } from '@prisma/client';
import {
  LOT_BUCKETS, LOT_EPS, LOT_UNKNOWN_KEY, LOT_VAN_REASONS, LotError, aggregateRequest, allocateOutLines, distributeToLines, isLotExpiredOn,
  isLotQty, lotErr, lotMessage, multiLotWarning, normalizeLotNumber, parseLotRefsStrict, pickOutSources, refsOfByLot, roundLot,
  splitAvailability, zeroBuckets,
  type AllocRow, type LotActor, type LotBalance, type LotBucket, type LotMeta, type LotRef, type LotWarning, type PlaceLotView,
  type VanLotSnapshotDto, type VanMoveType, type VanMovementPlan, type VanMovementPlanInput,
} from './lots';
import { companyDay, loadLotMetas, lockLotProducts, placeViews, resolveOrCreateLot, type LotDb, type LotEventActor, type LotTx } from './lotsDb';

/** D17 (افتراض المواصفة بقرار المالك): التحميل من غير المسمّى بعد نفاد المسمّى المؤهَّل، بيقين UNKNOWN، ولا يُنقص دون الصفر (I2) */
export const VAN_LOT_ALLOW_UNKNOWN = true;

/** صفّ خطة السيارة: كميته **بإشارة البند** (تسوية النقص سالبة) كما يُكتب في van_load_item_lots */
export type VanPlanRow = AllocRow & { viaWarehouse: boolean; reason: string | null };

/**
 * lotsRaw كما يمرّره المسار: كائن {lots, lotNumber, productionDate, expiryDate} من بند الطلب، أو مصفوفة lots وحدها.
 * lots صفوفٌ صريحة بالكمية الأساسية (lotId: null = غير مسمّى)؛ lotNumber وتاريخاه لتشغيلةٍ تُحلّ أو تُنشأ في الزيادة بلا مصدر
 * (D4، والتسوية بالزيادة) والسطر كله إليها، وفي الإنقاص تشغيلةٌ قائمة برقمها.
 */
export interface VanLotsRaw { lots?: unknown; lotNumber?: unknown; productionDate?: unknown; expiryDate?: unknown }

/**
 * سياقٌ اختياري من المسار: الأقفال المأخوذة سلفاً (فلا تُؤخذ مرتين)، وفاعل سجل التدقيق كما يبنيه lotEventActorOf من req.user
 * (جلسة «دخول» بمُصدِرها STAFF أو OWNER، والمفتاح بمعرّفه) — بدونه يُشتقّ من createdBy واسم الفاعل كما كان، وبلا أقفال تأخذها الدالّة
 */
export interface VanPlanContext { locked?: { tracked: ReadonlySet<string> } | null; actorName?: string | null; eventActor?: LotEventActor | null }

/** خطأ طلبٍ بحالته — يردّه معالج 4xx في routes/vanStock.ts برسالته */
const badRequest = (message: string): Error => Object.assign(new Error(message), { status: 400 });

const keyOf = (lotId: string | null) => (lotId == null ? LOT_UNKNOWN_KEY : lotId);
const uniq = (xs: Iterable<string>): string[] => [...new Set(xs)];

function specOf(raw: unknown): VanLotsRaw {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as VanLotsRaw;
  return { lots: raw };
}

/** صفوف سطر تسوية النقص قد تصل بإشارته — تُقلب مطلقةً إن كانت كلها سالبة؛ والخليط يرفضه التحليل الصارم */
function absRefs(raw: unknown): unknown {
  if (!Array.isArray(raw) || !raw.length) return raw;
  const neg = (r: unknown) => !!r && typeof r === 'object' && typeof (r as { qty?: unknown }).qty === 'number' && (r as { qty: number }).qty < 0;
  return raw.every(neg) ? raw.map((r) => ({ ...(r as object), qty: -(r as { qty: number }).qty })) : raw;
}

/** حقول اللوط في بند حركة: صفوفٌ غير فارغة، أو رقمٌ أو تاريخٌ أو وسم — null والنصّ الفارغ والمصفوفة الفارغة غياب */
export function vanLineCarriesLot(i: VanLotsRaw & { lotReason?: unknown }): boolean {
  const has = (v: unknown) => v != null && v !== '';
  return (has(i.lots) && !(Array.isArray(i.lots) && i.lots.length === 0))
    || has(i.lotNumber) || has(i.productionDate) || has(i.expiryDate) || has(i.lotReason);
}

/**
 * D9: بندٌ يحمل تشغيلةً لصنفٍ غير متتبَّع (أُطفئ تتبّعه وواجهةٌ قديمة تعرض رصيد لوطه) يُرفض لا يُهمل — مسار غير المتتبَّع يُنقص
 * رصيد الصنف ويُبقي رصيد اللوط كما هو فيتكرّر التنزيل. رمزٌ قائم (422) بسببٍ في التفاصيل وموضع السطر في الطلب
 */
export function lotOnUntrackedError(name: string, productId: string, idx: number): LotError {
  return new LotError('LOT_PRODUCT_MISMATCH', `تتبع الصنف${name ? ` «${name}»` : ''} بالتشغيلات مطفأ أرسل السطر بلا تشغيلة`, 422,
    { productId, idx, reason: 'NOT_TRACKED' });
}

const dayField = (v: unknown): string | null => (v == null || v === '' ? null : typeof v === 'string' ? v : String(v));

/** اسم الصنف في رسالة خطأٍ صدر بلا اسم (pickOutSources)، والسطر في تفاصيله — الرمز والحالة كما هما */
function withLine(e: LotError, name: string, extra: Record<string, unknown>): LotError {
  let message = e.message;
  if (name && !message.includes('«')) {
    if (e.code === 'LOT_REQUIRED') message = lotMessage('LOT_REQUIRED', { name });
    else if (e.code === 'LOT_STOCK_INSUFFICIENT') message = message.replace(/^الكمية /, `الكمية من «${name}» `);
  }
  return new LotError(e.code, message, e.status, { ...(e.detail ?? {}), ...extra });
}

/**
 * العرض بعد صفوفٍ في دلو: sign −1 إنقاص و+1 زيادة، على الخام والصالح للوط، وعلى غير المسمّى وصالحه للصفّ الفارغ. رصيد الصنف
 * (total) لا يُمسّ: يكفي ما تقرؤه pickOutSources وmultiLotWarning. لوطٌ غائب عن العرض يُضاف ببطاقته من `metas`.
 */
function applyRows(view: PlaceLotView, bucket: LotBucket, rows: Pick<AllocRow, 'lotId' | 'qty'>[], sign: 1 | -1,
  metas?: ReadonlyMap<string, LotMeta>): PlaceLotView {
  const lots: LotBalance[] = view.lots.map((l) => ({ ...l, raw: { ...l.raw }, held: { ...l.held }, usable: { ...l.usable } }));
  const unknown = view.unknown ? { ...view.unknown } : null;
  const unknownUsable = view.unknownUsable ? { ...view.unknownUsable } : null;
  for (const r of rows) {
    const d = sign * Math.abs(r.qty);
    if (r.lotId == null) {
      if (unknown) unknown[bucket] = roundLot(unknown[bucket] + d);
      if (unknownUsable) unknownUsable[bucket] = roundLot(unknownUsable[bucket] + d);
      continue;
    }
    let l = lots.find((x) => x.lotId === r.lotId);
    if (!l) {
      const meta = metas?.get(r.lotId);
      if (!meta) continue;
      l = { lotId: r.lotId, meta, raw: zeroBuckets(), held: zeroBuckets(), usable: zeroBuckets() };
      lots.push(l);
    }
    l.raw[bucket] = roundLot(l.raw[bucket] + d);
    l.usable[bucket] = roundLot(l.usable[bucket] + d);
  }
  return { ...view, lots, unknown, unknownUsable };
}

interface Line {
  idx: number; productId: string; productName: string; shelfLifeOn: boolean; unitFactor: number;
  dir: 1 | -1; abs: number; refs: LotRef[] | null; lotNumber: string | null; productionDate: string | null; expiryDate: string | null;
  reason: string | null;
}

/** سطرٌ متتبَّع من المدخلات: الإشارة (I7) والكسر (isLotQty) والوسم والصريح (للإدارة والمفتاح؛ المندوب يوزّع له الخادم) */
function parseLine(l: VanMovementPlanInput['lines'][number], type: VanMoveType, actor: LotActor): Line {
  const q = Number(l.qty);
  const at = { productId: l.productId, idx: l.idx };
  if (!Number.isFinite(q) || Math.abs(q) <= LOT_EPS) throw lotErr('LOT_QTY_INVALID', {}, { ...at, wanted: l.qty });
  // I7: الكمية موجبة في التحميل والتنزيل والإزالة — السالب لتسوية النقص وحدها (ADJUST كما اليوم)
  if (q < 0 && type !== 'ADJUST') throw lotErr('LOT_QTY_INVALID', {}, { ...at, wanted: q, reason: 'NEGATIVE' });
  const dir: 1 | -1 = q > 0 ? 1 : -1;
  const abs = Math.abs(q);
  if (!isLotQty(abs)) throw lotErr('LOT_QTY_INVALID', {}, { ...at, wanted: q, decimals: 4 });
  const reason = l.reason == null || l.reason === '' ? null : String(l.reason);
  if (reason != null) {
    if (!(LOT_VAN_REASONS as readonly string[]).includes(reason)) throw badRequest('وسم حركة التشغيلة غير معروف');
    if (!(type === 'ADJUST' && dir < 0)) throw badRequest('إتلاف المنتهي غير المباع تسويةُ نقصٍ (ADJUST بكمية سالبة) وحدها');
  }
  const spec = specOf(l.lotsRaw);
  let refs: LotRef[] | null = null;
  let lotNumber: string | null = null;
  if (actor !== 'REP') {
    const r = parseLotRefsStrict(dir < 0 ? absRefs(spec.lots) : spec.lots, abs);
    if (r instanceof LotError) throw withLine(r, l.productName, at);
    refs = r.length ? r : null;
    if (spec.lotNumber != null && spec.lotNumber !== '') {
      lotNumber = normalizeLotNumber(spec.lotNumber);
      if (!lotNumber) throw lotErr('LOT_REQUIRED', { name: l.productName }, { ...at, reason: 'LOT_NUMBER_INVALID' });
      // السطر إلى تشغيلةٍ واحدة برقمها أو إلى صفوفٍ صريحة — لا الاثنان معاً
      if (refs) throw lotErr('LOT_QTY_INVALID', {}, { ...at, reason: 'LOTS_AND_NUMBER' });
    }
  }
  return {
    idx: l.idx, productId: l.productId, productName: l.productName, shelfLifeOn: l.shelfLifeOn === true,
    unitFactor: Number.isFinite(l.unitFactor) && l.unitFactor > 0 ? l.unitFactor : 1,
    dir, abs, refs, lotNumber, productionDate: dayField(spec.productionDate), expiryDate: dayField(spec.expiryDate), reason,
  };
}

/**
 * إنقاصٌ لصنفٍ واحد من دلوٍ في السيارة (D10، D26): الأسطر الصريحة تُجمع لكل (لوط أو فارغ) وتُفحص معاً بـpickOutSources (I1،
 * I2)، وصفوف كل سطرٍ صريحه كما هو. ثم الأسطر بلا صريح من العرض بعد ما صرفته الصريحة: مصدرٌ وحيد وإلا LOT_REQUIRED بالقائمة،
 * يُوزَّع على أسطرها بالترتيب (distributeToLines — مصدرٌ واحد فلا كرتون يُشقّ بين مصدرين).
 */
function pickPlan(view: PlaceLotView, bucket: LotBucket, pl: Line[], lookup: ReadonlyMap<string, LotMeta> | null): Map<number, AllocRow[]> {
  const rows = new Map<number, AllocRow[]>();
  const name = pl[0].productName;
  const fail = (e: LotError, lines: Line[]) => withLine(e, name, { productId: view.productId, lines: lines.map((l) => l.idx) });
  let v = view;
  const exp = pl.filter((l) => l.refs);
  const auto = pl.filter((l) => !l.refs);
  if (exp.length) {
    const g = aggregateRequest(exp.map((l) => ({ idx: l.idx, productId: l.productId, qty: l.abs, refs: l.refs })));
    const agg = g.get(view.productId)!;
    const res = pickOutSources(v, bucket, agg.qty, refsOfByLot(agg.byLot), lookup);
    if (!res.ok) throw fail(res.error, exp);
    const tmpl = new Map(res.rows.map((r) => [keyOf(r.lotId), r]));
    for (const l of exp) {
      const mine = new Map<string, number>();
      for (const r of l.refs!) mine.set(keyOf(r.lotId), (mine.get(keyOf(r.lotId)) ?? 0) + r.qty);
      rows.set(l.idx, [...mine].map(([k, qty]) => {
        const t = tmpl.get(k);
        const lotId = k === LOT_UNKNOWN_KEY ? null : k;
        return { lotId, qty, certainty: lotId ? 'CONFIRMED' : 'UNKNOWN', flags: [], expiryDate: t?.expiryDate ?? null };
      }));
    }
    v = applyRows(v, bucket, res.rows, -1);
  }
  if (auto.length) {
    const res = pickOutSources(v, bucket, auto.reduce((s, l) => s + l.abs, 0), null, lookup);
    if (!res.ok) throw fail(res.error, auto);
    for (const [idx, r] of distributeToLines(res.rows, auto.map((l) => ({ idx: l.idx, qty: l.abs })))) rows.set(idx, r);
  }
  return rows;
}

/** D18: لا تشغيلة صالحة في المستودع ولا رصيد غير مسمّى ⇒ الوارد أولاً (والنقص 409 كما هو) */
function receiveFirst(e: LotError, view: PlaceLotView): LotError {
  const empty = !view.lots.some((l) => l.usable.SELLABLE > LOT_EPS) && !((view.unknownUsable?.SELLABLE ?? 0) > LOT_EPS);
  if (e.code !== 'LOT_STOCK_INSUFFICIENT' || !empty) return e;
  return new LotError(e.code, `${e.message} — سجّل وارد التشغيلة أولاً`, e.status, { ...(e.detail ?? {}), hint: 'RECEIVE_FIRST' });
}

function eventActor(input: VanMovementPlanInput, name: string | null): LotEventActor {
  const by = input.createdBy ?? '';
  const type: LotEventActor['type'] = input.actor === 'API_KEY' ? 'API_KEY' : by.startsWith('OWNER:') ? 'OWNER' : 'ADMIN';
  return { type, id: by ? by.replace(/^OWNER:/, '') : null, name };
}

/**
 * خطة توزيع حركة سيارة على التشغيلات — داخل معاملة الحركة بعد lockLotProducts (وبعد قفل الدلو وassertOutAvailable للإزالة).
 * المجموعة المقروءة تحت القفل هي المرجع (D25): سطرٌ لصنفٍ غير متتبَّع الآن بلا صفوف، وصنفٌ صار متتبَّعاً بين القراءتين يُوزَّع.
 *
 * | النوع | السلوك |
 * |---|---|
 * | LOAD والمستودع مفعّل | allocateOutLines (LOAD) على عرض المستودع لكل صنفٍ بأسطره: الصريح يُحقَّق، والنقص 409 (D18). viaWarehouse |
 * | LOAD بلا مستودع (D4) | لوطٌ قائم مؤهَّل، أو رقمٌ يُحلّ أو يُنشأ بمصدر LOAD، أو null صريح؛ وإلا LOT_REQUIRED. والمندوب يُرفض |
 * | UNLOAD | pickOutSources على SELLABLE السيارة (الموقوف والمنتهي يُنزَّلان — مسار السحب). viaWarehouse = warehouseEnabled |
 * | ADJUST + | لوط، أو رقمٌ بمصدر LOAD، أو null صريح؛ الموقوف مقبول بتحذير LOT_INTO_BLOCKED |
 * | ADJUST − | pickOutSources على SELLABLE؛ وEXPIRED_UNSOLD_DESTROY وسمٌ لصفوف تشغيلاتٍ منتهية يوم العملية وحدها |
 * | EXPIRED_OUT، DAMAGED_OUT | pickOutSources على دلوهما |
 * | سيارة محذوفة (D30) | UNLOAD وحده، وكل الأصناف متتبَّعة بلوطاتٍ مسمّاة صريحة؛ رصيد صنفها مجهول فلا غير مسمّى (removal بلا unknown) |
 *
 * التحذيرات: LOT_FROM_UNKNOWN وLOT_SPLIT_UNIT من التوزيع، وLOT_INTO_BLOCKED، وLOT_MULTI_IN_VAN على السيارة بعد الإضافة.
 */
export async function planVanMovementInTx(tx: LotTx, input: VanMovementPlanInput, ctx: VanPlanContext = {}): Promise<VanMovementPlan> {
  const { tenantId: tid, type, vanKey, day } = input;
  const locked = ctx.locked ?? await lockLotProducts(tx, tid, input.lines.map((l) => l.productId));
  const src = input.lines.filter((l) => locked.tracked.has(l.productId));
  const warnings: LotWarning[] = [];
  const plan: { tracked: Set<string>; lines: Map<number, VanPlanRow[]>; warnings: LotWarning[] } = {
    tracked: new Set(src.map((l) => l.productId)), lines: new Map(), warnings,
  };
  if (input.deletedVan) {
    if (type !== 'UNLOAD') throw badRequest('سيارة المندوب المحذوف تُفرَّغ بالتنزيل للمستودع وحده');
    if (src.length !== input.lines.length) throw badRequest('تنزيل سيارة مندوبٍ محذوف للأصناف المتتبَّعة وحدها');
  }
  // D9 تحت القفل: صنفٌ أُطفئ تتبّعه بين القراءة المسبقة والقفل وبنده يحمل تشغيلة — لا يُكتب بلا صفوف (المسار يرفضه قبلها)
  const stray = input.lines.find((l) => !locked.tracked.has(l.productId) && vanLineCarriesLot({ ...specOf(l.lotsRaw), lotReason: l.reason }));
  if (stray) throw lotOnUntrackedError(stray.productName, stray.productId, stray.idx);
  if (!src.length) return plan;

  const lines = src.map((l) => parseLine(l, type, input.actor));
  if (input.deletedVan) {
    // رصيد صنف السيارة المحذوفة مجهول: لوطاتٌ مسمّاة صريحة وحدها، تُفحص على صالحها (I1)
    const bad = lines.find((l) => !(l.refs || l.lotNumber) || (l.refs ?? []).some((r) => r.lotId == null));
    if (bad) throw lotErr('LOT_REQUIRED', { name: bad.productName }, { productId: bad.productId, idx: bad.idx, reason: 'DELETED_VAN' });
  }

  const fromWarehouse = type === 'LOAD' && input.warehouseEnabled;
  const isOut = (l: Line) => fromWarehouse || type === 'UNLOAD' || type === 'EXPIRED_OUT' || type === 'DAMAGED_OUT' || (type === 'ADJUST' && l.dir < 0);
  const outLines = lines.filter(isOut);
  const inLines = lines.filter((l) => !isOut(l));
  const via = (type === 'LOAD' || type === 'UNLOAD') && input.warehouseEnabled; // D28
  const bucket: LotBucket = type === 'EXPIRED_OUT' ? 'EXPIRED' : type === 'DAMAGED_OUT' ? 'DAMAGED' : 'SELLABLE';
  const rowsByLine = new Map<number, AllocRow[]>();
  const metas = new Map<string, LotMeta>();
  const actor = ctx.eventActor ?? eventActor(input, ctx.actorName ?? null);

  // الإنقاص برقم تشغيلةٍ قائمة: يُحلّ إلى صفّها الصريح (لا إنشاء — التشغيلة الجديدة تدخل بالوارد أو بالزيادة)
  for (const l of outLines) {
    if (!l.lotNumber) continue;
    const row = await tx.productLot.findUnique({
      where: { tenantId_productId_lotNumber: { tenantId: tid, productId: l.productId, lotNumber: l.lotNumber } }, select: { id: true },
    });
    if (!row) throw lotErr('LOT_NOT_FOUND', {}, { productId: l.productId, idx: l.idx, lotNumber: l.lotNumber, ...(fromWarehouse && { hint: 'RECEIVE_FIRST' }) });
    l.refs = [{ lotId: row.id, qty: l.abs }];
    l.lotNumber = null;
  }

  // بطاقات اللوطات الصريحة كلها باستعلامٍ واحد — للوجود في الشركة والصنف (I5) والحالة خارج العرض
  const explicitIds = uniq(lines.flatMap((l) => (l.refs ?? []).map((r) => r.lotId)).filter((x): x is string => x != null));
  const lookup = explicitIds.length ? await loadLotMetas(tx, tid, { lotIds: explicitIds }) : null;
  for (const [id, m] of lookup ?? []) metas.set(id, m);

  // ── الإنقاص: عرض المكان المصدر برصيد صنفه (غير المسمّى)، ثم التوزيع لكل صنف ──
  let vanBefore: Map<string, PlaceLotView> | null = null;
  if (outLines.length) {
    const pids = uniq(outLines.map((l) => l.productId));
    const pv = await placeViews(tx, tid, fromWarehouse
      ? { warehouse: true, productIds: pids, withTotals: true }
      : { vanKeys: [vanKey], productIds: pids, withTotals: true });
    for (const [id, m] of pv.metas) metas.set(id, m);
    if (!fromWarehouse) vanBefore = pv.vans.get(vanKey) ?? new Map();
    for (const pid of pids) {
      const pl = outLines.filter((l) => l.productId === pid);
      const view = fromWarehouse ? pv.warehouse.get(pid) : pv.vans.get(vanKey)?.get(pid);
      if (!view) throw new Error(`LOT_VIEW_MISSING: ${pid}`);
      if (fromWarehouse) {
        // لكل سطرٍ معامله وصريحه على متاحٍ مشترك (D22، D26) — لا تجميع ثم distributeToLines: ذاك يشقّ الكرتون بلا وسم
        const res = allocateOutLines({
          productId: pid, productName: pl[0].productName, view, day, mode: 'LOAD', allowUnknown: input.allowUnknown, lookup,
          lines: pl.map((l) => ({ idx: l.idx, qty: l.abs, unitFactor: l.unitFactor, explicit: l.refs })),
        });
        if (!res.ok) throw receiveFirst(res.error, view);
        warnings.push(...res.warnings);
        for (const [idx, r] of res.lines) rowsByLine.set(idx, r);
      } else {
        for (const [idx, r] of pickPlan(view, bucket, pl, lookup)) rowsByLine.set(idx, r);
      }
    }
    // إتلاف المنتهي غير المباع: وسمٌ صادق في التقارير — كل صفّ من تشغيلةٍ منتهية يوم العملية
    for (const l of outLines) {
      if (l.reason !== 'EXPIRED_UNSOLD_DESTROY') continue;
      const bad = (rowsByLine.get(l.idx) ?? []).find((r) => r.lotId == null || !isLotExpiredOn({ expiryDate: r.expiryDate }, day));
      if (bad) throw badRequest(`إتلاف المنتهي غير المباع لتشغيلاتٍ منتهية وحدها — «${l.productName}»`);
    }
  }

  // ── الزيادة بلا مصدر: تحميلٌ بلا مستودع (D4) وتسويةٌ بالزيادة ──
  for (const l of inLines) {
    const at = { productId: l.productId, idx: l.idx };
    let rows: AllocRow[];
    if (l.lotNumber) {
      const { meta } = await resolveOrCreateLot(tx, tid, { id: l.productId, name: l.productName, shelfLifeOn: l.shelfLifeOn },
        { lotNumber: l.lotNumber, productionDate: l.productionDate, expiryDate: l.expiryDate }, { source: 'LOAD', createdBy: input.createdBy, actor });
      metas.set(meta.id, meta);
      rows = [{ lotId: meta.id, qty: l.abs, certainty: 'CONFIRMED', flags: [], expiryDate: meta.expiryDate }];
    } else if (l.refs) {
      const mine = new Map<string, number>();
      for (const r of l.refs) mine.set(keyOf(r.lotId), (mine.get(keyOf(r.lotId)) ?? 0) + r.qty);
      rows = [...mine].map(([k, qty]): AllocRow => (k === LOT_UNKNOWN_KEY
        ? { lotId: null, qty, certainty: 'UNKNOWN', flags: [], expiryDate: null }
        : { lotId: k, qty, certainty: 'CONFIRMED', flags: [], expiryDate: metas.get(k)?.expiryDate ?? null }));
    } else if (type === 'LOAD' && input.actor === 'REP') {
      throw new LotError('LOT_REQUIRED', 'تحميل الأصناف المتتبَّعة يتم من لوحة الإدارة', 422, { ...at, reason: 'REP_NO_WAREHOUSE' });
    } else {
      throw lotErr('LOT_REQUIRED', { name: l.productName }, at);
    }
    for (const r of rows) {
      if (r.lotId == null) continue;
      const m = metas.get(r.lotId);
      if (!m) throw lotErr('LOT_NOT_FOUND', {}, { ...at, lotId: r.lotId });
      if (m.productId !== l.productId) throw lotErr('LOT_PRODUCT_MISMATCH', { lot: m.lotNumber, name: l.productName }, { ...at, lotId: r.lotId, lotProductId: m.productId });
      if (type === 'LOAD') {
        // I4: التحميل من مؤهَّل — الموقوف والمنتهي لا يُحمَّلان (صريحاً أو برقمٍ قائم)
        if (m.status !== 'ACTIVE') throw lotErr('LOT_BLOCKED', { lot: m.lotNumber }, { ...at, lotId: m.id, blockKind: m.blockKind });
        if (isLotExpiredOn(m, day)) throw lotErr('LOT_EXPIRED', { lot: m.lotNumber, date: m.expiryDate }, { ...at, lotId: m.id, expiryDate: m.expiryDate });
      } else if (m.status !== 'ACTIVE') {
        warnings.push({ code: 'LOT_INTO_BLOCKED', productId: l.productId, detail: { lotId: m.id, lotNumber: m.lotNumber, blockKind: m.blockKind } });
      }
    }
    rowsByLine.set(l.idx, rows);
  }

  // ── الصفوف بإشارة البند، ومجموعها كميته (I3) ──
  for (const l of lines) {
    const rows = rowsByLine.get(l.idx) ?? [];
    const sum = rows.reduce((s, r) => s + r.qty, 0);
    if (Math.abs(sum - l.abs) > LOT_EPS) throw new Error(`LOT_I3_MISMATCH: ${l.productId} ${sum} != ${l.abs}`);
    plan.lines.set(l.idx, rows.map((r) => ({ ...r, qty: l.dir * r.qty, viaWarehouse: via, reason: l.reason })));
  }

  // ── تحذير اللوطين على السيارة بعد ما يدخلها (التحميل والتسوية بالزيادة) ──
  const added = lines.filter((l) => type === 'LOAD' || (type === 'ADJUST' && l.dir > 0));
  if (added.length) {
    const pids = uniq(added.map((l) => l.productId));
    const views = new Map(vanBefore ?? []);
    const missing = pids.filter((p) => !views.has(p));
    if (missing.length) {
      // الخام المسمّى وحده يكفي التحذير — بلا رصيد الصنف (withTotals: false) فلا يُطوى تاريخ بنود السيارة
      const pv = await placeViews(tx, tid, { vanKeys: [vanKey], productIds: missing, withTotals: false });
      for (const [pid, v] of pv.vans.get(vanKey) ?? []) views.set(pid, v);
      for (const [id, m] of pv.metas) if (!metas.has(id)) metas.set(id, m);
    }
    for (const pid of pids) {
      const before = views.get(pid);
      if (!before) continue;
      const pl = lines.filter((l) => l.productId === pid);
      const minus = fromWarehouse ? [] : pl.filter((l) => l.dir < 0).flatMap((l) => rowsByLine.get(l.idx) ?? []);
      const plus = pl.filter((l) => type === 'LOAD' || l.dir > 0).flatMap((l) => rowsByLine.get(l.idx) ?? []);
      const w = multiLotWarning(applyRows(applyRows(before, 'SELLABLE', minus, -1), 'SELLABLE', plus, 1, metas));
      if (w) warnings.push(w);
    }
  }
  return plan;
}

/**
 * أعمدة بند الحركة للصنف المتتبَّع، تُدمج في items.create بنداء الإنشاء الوحيد: lots.create بصفوف الخطة كما هي (بإشارة البند،
 * D2: البند لا يُشطر). سطرٌ بلا صفوف ⇒ {} فلا يتغيّر بند غير المتتبَّع.
 */
export function vanItemLotColumns(plan: VanMovementPlan | null | undefined, idx: number,
  ids: { tenantId: string; productId: string; vanKey: string; moveType: VanMoveType }): { lots?: { create: Prisma.VanLoadItemLotUncheckedCreateWithoutVanLoadItemInput[] } } {
  const rows = plan?.lines.get(idx);
  if (!rows || !rows.length) return {};
  return {
    lots: {
      create: rows.map((r) => ({
        tenantId: ids.tenantId, productId: ids.productId, vanKey: ids.vanKey, moveType: ids.moveType, viaWarehouse: r.viaWarehouse,
        lotId: r.lotId, qty: r.qty, certainty: r.certainty, reason: r.reason ?? null,
      })),
    },
  };
}

const hasBalance = (v: PlaceLotView): boolean =>
  (v.total != null && LOT_BUCKETS.some((b) => Math.abs(v.total![b]) > LOT_EPS))
  || v.lots.some((l) => LOT_BUCKETS.some((b) => Math.abs(l.raw[b]) > LOT_EPS));

/**
 * لقطة سيارة المندوب (GET /van-stock/lot-balances، §٧.١) بلا قفل: لكل صنفٍ متتبَّع له رصيدٌ في السيارة المتاحُ وأقسامه
 * (splitAvailability بيوم الشركة)، وصالح غير المسمّى للإنقاص (لا سالب: الجهاز يجمعه إلى المتاح)، ولوطاته بصالحها في SELLABLE
 * أيّاً كانت حالتها؛ ومعها قائمة tracked كاملة (المتتبَّع الغائب عن products متاحه صفر).
 */
export async function vanLotSnapshot(db: LotDb, tid: string, repId: string): Promise<VanLotSnapshotDto> {
  const serverTime = new Date().toISOString();
  const { day } = await companyDay(db, tid);
  const tracked = (await db.product.findMany({ where: { tenantId: tid, lotTracked: true }, select: { id: true }, orderBy: { id: 'asc' } })).map((p) => p.id);
  const snap: VanLotSnapshotDto = { serverTime, day, tracked, allowUnknown: VAN_LOT_ALLOW_UNKNOWN, products: [] };
  if (!tracked.length) return snap;
  const views = (await placeViews(db, tid, { vanKeys: [repId], productIds: tracked, withTotals: true })).vans.get(repId);
  for (const pid of tracked) {
    const v = views?.get(pid);
    if (!v || !hasBalance(v)) continue;
    const s = splitAvailability(v, day, { allowUnknown: VAN_LOT_ALLOW_UNKNOWN });
    const uu = v.unknownUsable?.SELLABLE ?? 0;
    snap.products.push({
      productId: pid, available: s.available, availableNamed: s.availableNamed, unknownUsable: uu > LOT_EPS ? roundLot(uu) : 0,
      quarantined: s.quarantined, held: s.held, expiredUnsold: s.expiredUnsold, expiredReturned: s.expiredReturned, damaged: s.damaged,
      lots: v.lots.filter((l) => l.usable.SELLABLE > LOT_EPS).map((l) => ({
        lotId: l.lotId, lotNumber: l.meta.lotNumber, expiryDate: l.meta.expiryDate, status: l.meta.status, blockKind: l.meta.blockKind,
        usable: l.usable.SELLABLE,
      })),
    });
  }
  return snap;
}
