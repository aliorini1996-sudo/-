/**
 * «تتبّع اللوط» — حركات السيارة ولقطة المندوب (المواصفة §٤.٧، §٧.١، D30). لا يستورد إعداد القاعدة: يأخذ tx أو db معاملاً.
 *
 * planVanMovementInTx تقرّر صفوف التوزيع لكل سطرٍ متتبَّع داخل معاملة الحركة بعد lockLotProducts، وتمنع السالب على مستوى
 * اللوط بلا استثناء (I1، I2):
 * - كل إنقاصٍ من السيارة (التنزيل، وتسوية النقص، وإزالة المنتهي والتالف) من مصدرٍ صريح (pickOutSources) بعد تجميع الطلب لكل
 *   (صنف، لوط أو فارغ) قبل أي مقارنة (D26)، وبلا صريح سحبٌ تلقائي من دلوه بالأقرب انتهاءً أولاً ثم غير المسمّى (pickOutFefoLines،
 *   طلب المالك ١ نوفمبر ٢٠٢٦ بدل LOT_REQUIRED لأكثر من مصدر في D10).
 * - التحميل في شركة المستودع إنقاصٌ من لوطات المستودع: allocateOutLines لكل صنفٍ بأسطره ومعامل وحدة كلٍّ (D22) — FEFO من
 *   المؤهَّل ثم غير المسمّى (D17)، والكرتون من لوطٍ واحد ما أمكن، والنقص 409 (D18).
 * - الزيادة بلا مصدر (التحميل بلا مستودع D4، والتسوية بالزيادة) بلوطٍ صريح أو رقمٍ يُحلّ أو يُنشأ بمصدر LOAD أو null صريح.
 * كل كمية بوحدة الأساس (D22)، موجبةٌ بأربع خانات (I7، isLotQty)، والصفوف بإشارة البند ومجموعها كميته (I3). الكتابة بنداء
 * الإنشاء الوحيد في routes/vanStock.ts (vanItemLotColumns).
 */
import type { Prisma } from '@prisma/client';
import {
  LOT_BUCKETS, LOT_EPS, LOT_UNKNOWN_KEY, LOT_VAN_REASONS, LotError, aggregateRequest, allocateOutLines, isLotExpiredOn,
  isLotQty, lotErr, lotMessage, multiLotWarning, normalizeLotNumber, parseLotRefsStrict, pickOutFefoLines, pickOutSources, refsOfByLot, floorLot, roundLot,
  splitAvailability, zeroBuckets,
  type AllocRow, type LotActor, type LotBalance, type LotBucket, type LotCertainty, type LotMeta, type LotRef, type LotWarning, type PlaceLotView,
  type VanLotSnapshotDto, type VanMoveType, type VanMovementPlan, type VanMovementPlanInput,
} from './lots';
import { companyDay, loadLotMetas, lockLotProducts, placeViews, recordLotEvent, resolveOrCreateLot, type LotDb, type LotEventActor, type LotTx } from './lotsDb';
import { unitFields } from './units';

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
export interface VanPlanContext {
  locked?: { tracked: ReadonlySet<string> } | null; actorName?: string | null; eventActor?: LotEventActor | null;
  /**
   * «حركات مفتاح الربط لا تُرفض باللوط» (طلب المالك ١٦ نوفمبر ٢٠٢٦): المسار يمرّره لمفتاح API وحده (req.user.apiKeyId)، فالواجهة
   * و/m وتطبيق المندوب كما كانت حرفياً. تصفير السيارة في Odoo كان يُرفض 409/422 فيبقى رصيد التشغيلات في فيلد — فصار تطبيق الحركة
   * أولى من رفض المستند: رقمٌ مجهول ⇒ سحبٌ تلقائي، والنقص ⇒ حصرٌ بالمتاح (LOT_CLAMPED)، والكسر الخامس ⇒ تقريب، والزيادة برقمٍ
   * جديد ⇒ إنشاءٌ بتحذير. ولا سالب أبداً (I1، I2)
   */
  lenient?: boolean;
}

/**
 * خطة السيارة ومعها ما طبّقه التسامح: `applied` الكمية الأساسية **بإشارة البند** لكل سطرٍ تغيّرت كميته (حُصر بالمتاح أو قُرّب) —
 * صفرٌ ⇒ لا يُكتب بنده. غائبٌ ⇒ السطر بكميته كما أُرسلت (كل غير المفتاح).
 */
export type VanMovementPlanResult = VanMovementPlan & { applied: Map<number, number> };

/** كل أسطر الحركة حُصرت إلى صفر ⇒ لا حركة تُكتب: المسار يردّ 200 noop بالتحذيرات (لا حركةٌ بلا بنود) */
export class VanPlanNoop extends Error {
  constructor(readonly warnings: readonly unknown[]) { super('VAN_PLAN_NOOP'); this.name = 'VanPlanNoop'; }
}

/** هل حُصرت كل أسطر الحركة إلى صفر؟ (`idxs` مواضع البنود كما تعرّف بها الخطة أسطرها) */
export function vanPlanWritesNothing(plan: VanMovementPlanResult | null | undefined, idxs: readonly number[]): boolean {
  // applied غائبة (خطةٌ بلا تسامح من مستدعٍ قديم) ⇒ كل البنود تُكتب
  return !!plan?.applied && idxs.length > 0 && idxs.every((i) => { const a = plan.applied.get(i); return a !== undefined && Math.abs(a) <= LOT_EPS; });
}

/**
 * أعمدة كمية البند المطبَّقة (تُنشر **بعد** unitFields فتغلبها): سطرٌ لم يتغيّر ⇒ {} والبند كما كان. والمحصور بوحدة سطره إن بقي
 * وحداتٍ كاملة، وإلا بوحدة الأساس — فمجموع صفوف لوطه = أساس البند دائماً (I3)
 */
export function vanAppliedItemFields(plan: VanMovementPlanResult | null | undefined, idx: number, unit: { name?: string | null; factor?: number | null }):
  ReturnType<typeof unitFields> | Record<string, never> {
  const a = plan?.applied?.get(idx);
  if (a === undefined) return {};
  const F = Number(unit.factor) || 1;
  const inUnits = a / F;
  return F > 1 && Math.abs(inUnits - Math.round(inUnits)) <= 1e-9 ? unitFields(Math.round(inUnits), unit) : unitFields(a, null);
}

// ═══ التسامح في الإنقاص (مفتاح الربط) ═══

/** سطر إنقاصٍ متسامح لصنفٍ واحد: كميته الأساسية الموجبة، وتشغيلاته المفضَّلة (مجموعها قد يخالف كميته)، وحصرٌ اختياري للمسمّاة */
export interface LenientOutLine { idx: number; qty: number; prefs?: LotRef[] | null; only?: ((m: LotMeta) => boolean) | null }
export interface LenientOutResult { lines: Map<number, AllocRow[]>; applied: Map<number, number>; warnings: LotWarning[] }

/**
 * إنقاصٌ لا يُرفض لصنفٍ من دلوٍ في مكان (السيارة أو المستودع) — لمفتاح الربط حين يرفض المسار الصارم (pickOutSources) أو حين لا
 * يساوي مجموع تشغيلاته كميته. لكل الأسطر معاً (D26): **المفضَّل أولاً** (اللوط المسمّى أيّاً كانت حالته — إنقاص تشغيلةٍ حقيقية مسموح
 * ولو موقوفة أو منتهية — وغير المسمّى الصريح) حتى صالحه، **ثم** بالأقرب انتهاءً من بقية المسمّاة، **ثم** غير المسمّى (D17).
 * وما زاد على ذلك يُحصر: الكمية المطبَّقة دون المطلوب بتحذير LOT_CLAMPED {idx, requested, applied}، ولا يُنزل شيءٌ دون الصفر:
 * - I1: من اللوط حتى صالحه الموجب وحده.
 * - I2: غير المسمّى حتى max(0, صالحه) — لا يُنقص دون min(0, قبله).
 * - ورصيد الصنف الصالح (المسمّى + غير المسمّى) لا ينزل دون الصفر: لوطٌ «شبح» فوق رصيد الصنف (غير المسمّى سالب) لا يُصرف منه
 *   ما لا يوجد في السيارة.
 * مفضَّلٌ لم يكفِه صالحه ⇒ LOT_EXPLICIT_FALLBACK {line, lotId, lotNumber, reason: 'SHORT', requested, taken, spilled[]}.
 * اليقين: المفضَّل المسمّى CONFIRMED، والتلقائي CONFIRMED إن كان المصدر الوحيد وإلا ASSUMED، وغير المسمّى UNKNOWN. الصفوف موجبة.
 */
export function lenientTakeLines(view: PlaceLotView, bucket: LotBucket, input: readonly LenientOutLine[]): LenientOutResult {
  const productId = view.productId;
  const warnings: LotWarning[] = [];
  const pool = new Map(view.lots.map((l) => [l.lotId, Math.max(0, l.usable[bucket])]));
  const byId = new Map(view.lots.map((l) => [l.lotId, l]));
  const uu = view.unknownUsable?.[bucket] ?? 0;
  let uLeft = Math.max(0, uu);
  const namedPos = view.lots.reduce((s, l) => s + Math.max(0, l.usable[bucket]), 0);
  // رصيد الصنف الصالح (سيارة مندوبٍ محذوف: غير المسمّى مجهول ⇒ المسمّى وحده)
  const productUsable = view.unknownUsable ? view.lots.reduce((s, l) => s + l.usable[bucket], 0) + uu : Infinity;
  // floorLot لا roundLot: التقريب لأعلى قد يأخذ فوق رصيدٍ أدقّ من أربع خانات بغبار < 0.00005 فيخرق I1/I2
  let capLeft = floorLot(Math.max(0, Math.min(namedPos + uLeft, productUsable)));
  const nSrc = view.lots.filter((l) => l.usable[bucket] > LOT_EPS).length + (uLeft > LOT_EPS ? 1 : 0);
  const autoCert: LotCertainty = nSrc === 1 ? 'CONFIRMED' : 'ASSUMED';
  const left = new Map(input.map((l) => [l.idx, roundLot(l.qty)]));
  const rows = new Map<number, Map<string, AllocRow>>(input.map((l) => [l.idx, new Map()]));
  const add = (idx: number, lotId: string | null, q: number, certainty: LotCertainty, expiryDate: string | null) => {
    const m = rows.get(idx)!;
    const k = keyOf(lotId);
    const r = m.get(k);
    if (r) r.qty = roundLot(r.qty + q);
    else m.set(k, { lotId, qty: q, certainty, flags: [], expiryDate });
  };
  const take = (idx: number, max: number): number => {
    const q = floorLot(Math.min(left.get(idx)!, max, capLeft));
    if (!(q > LOT_EPS)) return 0;
    left.set(idx, roundLot(left.get(idx)! - q));
    capLeft = roundLot(capLeft - q);
    return q;
  };
  const short = new Map<number, { lotId: string | null; lotNumber: string | null; requested: number; taken: number }[]>();
  // ١) المفضَّل لكل الأسطر قبل أي سحبٍ تلقائي — فلا يأخذ سطرٌ تلقائي صالحَ تشغيلةٍ سمّاها سطرٌ بعده
  for (const l of input) {
    const s: { lotId: string | null; lotNumber: string | null; requested: number; taken: number }[] = [];
    for (const r of l.prefs ?? []) {
      const want = roundLot(Math.min(r.qty, left.get(l.idx)!));
      if (!(want > LOT_EPS)) continue;
      let got = 0;
      if (r.lotId == null) {
        got = take(l.idx, Math.min(want, uLeft));
        uLeft = roundLot(uLeft - got);
        if (got) add(l.idx, null, got, 'UNKNOWN', null);
      } else {
        const lot = byId.get(r.lotId);
        if (lot && (!l.only || l.only(lot.meta))) {
          got = take(l.idx, Math.min(want, pool.get(r.lotId) ?? 0));
          pool.set(r.lotId, roundLot((pool.get(r.lotId) ?? 0) - got));
          if (got) add(l.idx, r.lotId, got, 'CONFIRMED', lot.meta.expiryDate);
        }
      }
      if (got < want - LOT_EPS) s.push({ lotId: r.lotId, lotNumber: r.lotId ? byId.get(r.lotId)?.meta.lotNumber ?? null : null, requested: want, taken: got });
    }
    short.set(l.idx, s);
  }
  // ٢) الباقي: الأقرب انتهاءً من المسمّاة (العرض مرتّبٌ بـfefoCompare)، ثم غير المسمّى — والمحصور تحذير
  for (const l of input) {
    const auto: { lotId: string | null; lotNumber: string | null; qty: number }[] = [];
    for (const lot of view.lots) {
      if (!(left.get(l.idx)! > LOT_EPS)) break;
      if (l.only && !l.only(lot.meta)) continue;
      const got = take(l.idx, pool.get(lot.lotId) ?? 0);
      if (!got) continue;
      pool.set(lot.lotId, roundLot((pool.get(lot.lotId) ?? 0) - got));
      add(l.idx, lot.lotId, got, autoCert, lot.meta.expiryDate);
      auto.push({ lotId: lot.lotId, lotNumber: lot.meta.lotNumber, qty: got });
    }
    if (!l.only && left.get(l.idx)! > LOT_EPS) {
      const got = take(l.idx, uLeft);
      uLeft = roundLot(uLeft - got);
      if (got) { add(l.idx, null, got, 'UNKNOWN', null); auto.push({ lotId: null, lotNumber: null, qty: got }); }
    }
    for (const s of short.get(l.idx) ?? []) {
      warnings.push({ code: 'LOT_EXPLICIT_FALLBACK', productId, detail: { line: l.idx, idx: l.idx, lotId: s.lotId, lotNumber: s.lotNumber, reason: 'SHORT', requested: s.requested, taken: s.taken, spilled: auto } });
    }
    const requested = roundLot(l.qty);
    const applied = roundLot(requested - left.get(l.idx)!);
    if (applied < requested - LOT_EPS) warnings.push({ code: 'LOT_CLAMPED', productId, detail: { idx: l.idx, bucket, requested, applied } });
  }
  const lines = new Map<number, AllocRow[]>();
  const applied = new Map<number, number>();
  for (const l of input) {
    lines.set(l.idx, [...rows.get(l.idx)!.values()]);
    applied.set(l.idx, roundLot(roundLot(l.qty) - left.get(l.idx)!));
  }
  return { lines, applied, warnings };
}

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
  /** مفتاح الربط وحده: التشغيلات كما أُرسلت (معرّفٌ أو رقم) قبل حلّها تحت القفل، وما يُنشأ منها في الزيادة */
  prefs?: Pref[] | null; creates?: Pref[] | null;
}

/** تشغيلةٌ مفضَّلة من مفتاح الربط: معرّف فيلد، أو null صريح لغير المسمّى، أو رقم التشغيلة (رقم Odoo) مطبَّعاً — بكميتها الأساسية */
interface Pref { lotId?: string | null; lotNumber?: string | null; qty: number; productionDate?: string | null; expiryDate?: string | null }

/**
 * سطرٌ متتبَّع من مفتاح الربط بلا رفضٍ للّوط (VanPlanContext.lenient): الإشارة (I7) كما هي، والكسر الخامس يُقرَّب بتحذير
 * LOT_CLAMPED {reason: 'DECIMALS'} (وما قُرّب إلى صفر لا يُكتب ⇒ null)، والتشغيلات تفضيلاتٌ لا شروط — lots[] بمعرّف فيلد أو برقم
 * التشغيلة (lotNumber داخل الصف)، أو رقمٌ أو معرّفٌ مسطَّح على البند — تُحلّ تحت القفل (resolvePrefs). صفٌّ بلا معرّفٍ ولا رقم
 * أو بكميةٍ غير موجبة لا تفضيل له (يوزّعه الخادم).
 */
function parseLineLenient(l: VanMovementPlanInput['lines'][number], type: VanMoveType, warnings: LotWarning[]): Line | null {
  const q = Number(l.qty);
  const at = { productId: l.productId, idx: l.idx };
  if (!Number.isFinite(q) || Math.abs(q) <= LOT_EPS) throw lotErr('LOT_QTY_INVALID', {}, { ...at, wanted: l.qty });
  if (q < 0 && type !== 'ADJUST') throw lotErr('LOT_QTY_INVALID', {}, { ...at, wanted: q, reason: 'NEGATIVE' });
  const dir: 1 | -1 = q > 0 ? 1 : -1;
  let abs = Math.abs(q);
  if (!isLotQty(abs)) {
    const r = roundLot(abs);
    warnings.push({ code: 'LOT_CLAMPED', productId: l.productId, detail: { idx: l.idx, reason: 'DECIMALS', requested: abs, applied: dir * r } });
    if (!(r > LOT_EPS)) return null;
    abs = r;
  }
  const reason = l.reason == null || l.reason === '' ? null : String(l.reason);
  if (reason != null) {
    if (!(LOT_VAN_REASONS as readonly string[]).includes(reason)) throw badRequest('وسم حركة التشغيلة غير معروف');
    if (!(type === 'ADJUST' && dir < 0)) throw badRequest('إتلاف المنتهي غير المباع تسويةُ نقصٍ (ADJUST بكمية سالبة) وحدها');
  }
  const spec = specOf(l.lotsRaw) as VanLotsRaw & { lotId?: unknown };
  const prefs: Pref[] = [];
  const numberOf = (v: unknown): string | null => {
    if (v == null || v === '') return null;
    const n = normalizeLotNumber(v);
    if (!n) warnings.push({ code: 'LOT_NUMBER_UNKNOWN', productId: l.productId, detail: { idx: l.idx, lotNumber: String(v).slice(0, 80), reason: 'INVALID' } });
    return n;
  };
  if (Array.isArray(spec.lots)) {
    for (const x of spec.lots.slice(0, 50)) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
      const o = x as Record<string, unknown>;
      const qty = roundLot(Math.abs(Number(o.qty)));
      if (!Number.isFinite(qty) || !(qty > LOT_EPS)) continue;
      const lotId = typeof o.lotId === 'string' && o.lotId.length > 0 && o.lotId.length <= 128 ? o.lotId : null;
      const lotNumber = lotId ? null : numberOf(o.lotNumber);
      // null الصريح بلا رقم = غير المسمّى صراحةً؛ والغائب بلا رقم لا تفضيل له
      if (!lotId && !lotNumber && o.lotId !== null) continue;
      prefs.push({ lotId: lotId ?? (lotNumber ? undefined : null), lotNumber, qty, productionDate: dayField(o.productionDate), expiryDate: dayField(o.expiryDate) });
    }
  }
  if (!prefs.length) {
    const flatId = typeof spec.lotId === 'string' && spec.lotId.length > 0 && spec.lotId.length <= 128 ? spec.lotId : null;
    const flatNum = flatId ? null : numberOf(spec.lotNumber);
    if (flatId || flatNum) prefs.push({ lotId: flatId ?? undefined, lotNumber: flatNum, qty: abs, productionDate: dayField(spec.productionDate), expiryDate: dayField(spec.expiryDate) });
  }
  return {
    idx: l.idx, productId: l.productId, productName: l.productName, shelfLifeOn: l.shelfLifeOn === true,
    unitFactor: Number.isFinite(l.unitFactor) && l.unitFactor > 0 ? l.unitFactor : 1,
    dir, abs, refs: null, lotNumber: null, productionDate: dayField(spec.productionDate), expiryDate: dayField(spec.expiryDate), reason,
    prefs: prefs.length ? prefs : null,
  };
}

/**
 * يحلّ تفضيلات مفتاح الربط تحت القفل، داخل الشركة والصنف وحدهما (عزل الشركات: معرّفٌ لشركةٍ أخرى «غير موجود» ولا يُكشف): المعرّف
 * ببطاقته (loadLotMetas)، والرقم مطبَّعاً (normalizeLotNumber: حالة الأحرف والأرقام العربية والمسافات) بقراءةٍ واحدة. الإنقاص: ما لم
 * يُحلّ أو كان لصنفٍ آخر يُترك وكميته للسحب التلقائي بتحذير LOT_NUMBER_UNKNOWN {fallback: 'FEFO'}. الزيادة: رقمٌ جديد يُنشأ
 * لاحقاً (creates)، ومعرّفٌ مجهول أو لصنفٍ آخر يدخل غير مسمّى بتحذير {fallback: 'UNNAMED'}.
 */
async function resolvePrefs(tx: LotTx, tid: string, lines: Line[], isOut: (l: Line) => boolean, warnings: LotWarning[]): Promise<Map<string, LotMeta>> {
  const withPrefs = lines.filter((l) => l.prefs?.length);
  if (!withPrefs.length) return new Map();
  const ids = uniq(withPrefs.flatMap((l) => l.prefs!.map((p) => p.lotId)).filter((x): x is string => typeof x === 'string'));
  const nums = uniq(withPrefs.flatMap((l) => l.prefs!.filter((p) => !p.lotId && p.lotNumber).map((p) => p.lotNumber!)));
  const byNumber = new Map<string, string>();
  if (nums.length) {
    const rows = await tx.productLot.findMany({
      where: { tenantId: tid, productId: { in: uniq(withPrefs.map((l) => l.productId)) }, lotNumber: { in: nums } },
      select: { id: true, productId: true, lotNumber: true },
    });
    for (const r of rows) byNumber.set(`${r.productId}|${r.lotNumber}`, r.id);
  }
  const allIds = uniq([...ids, ...byNumber.values()]);
  const metas = allIds.length ? await loadLotMetas(tx, tid, { lotIds: allIds }) : new Map<string, LotMeta>();
  for (const l of withPrefs) {
    const out = isOut(l);
    const refs: LotRef[] = [];
    const creates: Pref[] = [];
    for (const p of l.prefs!) {
      if (p.lotId === null) { refs.push({ lotId: null, qty: p.qty }); continue; }
      const id = p.lotId ?? byNumber.get(`${l.productId}|${p.lotNumber}`);
      const m = id ? metas.get(id) : undefined;
      if (m && m.productId === l.productId) { refs.push({ lotId: m.id, qty: p.qty }); continue; }
      if (!out && !p.lotId && p.lotNumber) { creates.push(p); continue; }
      warnings.push({
        code: 'LOT_NUMBER_UNKNOWN', productId: l.productId,
        detail: { idx: l.idx, ...(p.lotId ? { lotId: p.lotId } : { lotNumber: p.lotNumber }), reason: m ? 'PRODUCT_MISMATCH' : 'NOT_FOUND', qty: p.qty, fallback: out ? 'FEFO' : 'UNNAMED' },
      });
      if (!out) refs.push({ lotId: null, qty: p.qty });
    }
    l.refs = refs.length ? refs : null;
    l.creates = creates.length ? creates : null;
  }
  return metas;
}

/** مجموع صفوفٍ لا يساوي كمية السطر (مفتاح الربط): التفضيلات تُتبع حتى كميته والباقي يوزّعه الخادم — تحذيرٌ لا رفض */
function rowsSumWarning(l: Line, sum: number): LotWarning {
  return { code: 'LOT_EXPLICIT_FALLBACK', productId: l.productId, detail: { line: l.idx, idx: l.idx, reason: 'ROWS_SUM', requested: roundLot(sum), qty: l.abs } };
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
 * إنقاصٌ لصنفٍ واحد من دلوٍ في السيارة (D26): الأسطر الصريحة تُجمع لكل (لوط أو فارغ) وتُفحص معاً بـpickOutSources (I1، I2)،
 * وصفوف كل سطرٍ صريحه كما هو. ثم الأسطر بلا صريح من العرض بعد ما صرفته الصريحة: سحبٌ تلقائي بالأقرب انتهاءً أولاً ثم غير
 * المسمّى، ولكل سطرٍ قاعدة الكرتون (pickOutFefoLines). وإتلاف المنتهي غير المباع (EXPIRED_UNSOLD_DESTROY) أولاً من التشغيلات
 * المنتهية يوم العملية وحدها، ثم البقية مما ترك.
 */
function pickPlan(view: PlaceLotView, bucket: LotBucket, pl: Line[], lookup: ReadonlyMap<string, LotMeta> | null, day: string,
  warnings: LotWarning[]): Map<number, AllocRow[]> {
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
  const destroy = auto.filter((l) => l.reason === 'EXPIRED_UNSOLD_DESTROY');
  const rest = auto.filter((l) => l.reason !== 'EXPIRED_UNSOLD_DESTROY');
  for (const [group, only] of [[destroy, (m: LotMeta) => isLotExpiredOn(m, day)], [rest, undefined]] as const) {
    if (!group.length) continue;
    const res = pickOutFefoLines(v, bucket, group.map((l) => ({ idx: l.idx, qty: l.abs, unitFactor: l.unitFactor })), only ? { only } : undefined);
    if (!res.ok) throw fail(res.error, group);
    warnings.push(...res.warnings);
    for (const [idx, r] of res.lines) rows.set(idx, r);
    v = applyRows(v, bucket, [...res.lines.values()].flat(), -1);
  }
  return rows;
}

/**
 * إنقاص مفتاح الربط من السيارة لصنفٍ واحد: الصارم أولاً (pickPlan حرفياً — الكرتون من تشغيلةٍ واحدة وD26) حين تساوي صفوف كل سطرٍ
 * كميته؛ فإن رفض بخطأ لوط (نقصٌ في التشغيلة أو في الصنف) أو لم تتساوَ الصفوف ⇒ lenientTakeLines: المفضَّل ثم الأقرب انتهاءً ثم غير
 * المسمّى، والزائد يُحصر بتحذير. `applied` للمتسامح وحده (الصارم يطبّق الكمية كاملة).
 */
function lenientPick(view: PlaceLotView, bucket: LotBucket, pl: Line[], lookup: ReadonlyMap<string, LotMeta> | null, day: string,
  warnings: LotWarning[]): { rows: Map<number, AllocRow[]>; applied: Map<number, number> | null } {
  const sumOf = (l: Line) => (l.refs ?? []).reduce((s, r) => s + r.qty, 0);
  if (pl.every((l) => !l.refs || Math.abs(sumOf(l) - l.abs) <= LOT_EPS)) {
    const w: LotWarning[] = [];
    try {
      const rows = pickPlan(view, bucket, pl, lookup, day, w);
      warnings.push(...w);
      return { rows, applied: null };
    } catch (e) {
      if (!(e instanceof LotError)) throw e;
    }
  }
  for (const l of pl) if (l.refs && Math.abs(sumOf(l) - l.abs) > LOT_EPS) warnings.push(rowsSumWarning(l, sumOf(l)));
  const expiredOn = (m: LotMeta) => isLotExpiredOn(m, day);
  const g = lenientTakeLines(view, bucket, pl.map((l) => ({ idx: l.idx, qty: l.abs, prefs: l.refs, only: l.reason === 'EXPIRED_UNSOLD_DESTROY' ? expiredOn : null })));
  warnings.push(...g.warnings);
  return { rows: g.lines, applied: g.applied };
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
export async function planVanMovementInTx(tx: LotTx, input: VanMovementPlanInput, ctx: VanPlanContext = {}): Promise<VanMovementPlanResult> {
  const { tenantId: tid, type, vanKey, day } = input;
  const locked = ctx.locked ?? await lockLotProducts(tx, tid, input.lines.map((l) => l.productId));
  const src = input.lines.filter((l) => locked.tracked.has(l.productId));
  const warnings: LotWarning[] = [];
  // مفتاح الربط (طلب المالك ١٦ نوفمبر ٢٠٢٦) — وسيارة المندوب المحذوف (D30) صارمةٌ دائماً: إداريٌّ بلوطاتٍ صريحة
  const lenient = ctx.lenient === true && !input.deletedVan;
  const plan: VanMovementPlanResult = { tracked: new Set(src.map((l) => l.productId)), lines: new Map(), warnings, applied: new Map() };
  if (input.deletedVan) {
    if (type !== 'UNLOAD') throw badRequest('سيارة المندوب المحذوف تُفرَّغ بالتنزيل للمستودع وحده');
    if (src.length !== input.lines.length) throw badRequest('تنزيل سيارة مندوبٍ محذوف للأصناف المتتبَّعة وحدها');
  }
  // D9 تحت القفل: صنفٌ أُطفئ تتبّعه بين القراءة المسبقة والقفل وبنده يحمل تشغيلة — لا يُكتب بلا صفوف (المسار يرفضه قبلها).
  // ومفتاح الربط: تُهمل تشغيلة السطر بتحذير (الصنف يتحرّك كغير متتبَّع) لا رفض المستند كله
  for (const s of input.lines.filter((l) => !locked.tracked.has(l.productId) && vanLineCarriesLot({ ...specOf(l.lotsRaw), lotReason: l.reason }))) {
    if (!lenient) throw lotOnUntrackedError(s.productName, s.productId, s.idx);
    warnings.push({ code: 'LOT_NUMBER_UNKNOWN', productId: s.productId, detail: { idx: s.idx, reason: 'NOT_TRACKED', fallback: 'IGNORED' } });
  }
  if (!src.length) return plan;

  const lines: Line[] = [];
  for (const l of src) {
    if (!lenient) { lines.push(parseLine(l, type, input.actor)); continue; }
    const p = parseLineLenient(l, type, warnings);
    // كسرٌ خامس قُرّب: البند يُكتب بالكمية المقرَّبة (وما قُرّب إلى صفر لا يُكتب)
    if (!p) { plan.applied.set(l.idx, 0); continue; }
    if (Math.abs(p.abs - Math.abs(Number(l.qty))) > 1e-12) plan.applied.set(l.idx, p.dir * p.abs);
    lines.push(p);
  }
  if (!lines.length) return plan;
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
  // مفتاح الربط: تفضيلات التشغيلات (معرّفٌ أو رقم Odoo) تُحلّ تحت القفل — ما لم يُحلّ يُسحب تلقائياً أو يدخل غير مسمّى بتحذير
  if (lenient) for (const [id, m] of await resolvePrefs(tx, tid, lines, isOut, warnings)) metas.set(id, m);

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
        // مفتاح الربط: صفوفٌ لا يساوي مجموعها كمية سطرها لا تصلح صريحاً ⇒ يوزّعه الخادم بتحذير (لا LOT_QTY_INVALID)
        if (lenient) {
          for (const l of pl) {
            const sum = (l.refs ?? []).reduce((s, r) => s + r.qty, 0);
            if (l.refs && Math.abs(sum - l.abs) > LOT_EPS) { warnings.push(rowsSumWarning(l, sum)); l.refs = null; }
          }
        }
        // لكل سطرٍ معامله وصريحه على متاحٍ مشترك (D22، D26) — لا تجميع ثم distributeToLines: ذاك يشقّ الكرتون بلا وسم.
        // طلب المالك ١٦ نوفمبر ٢٠٢٦ («لا مانع من أن يأخذ من LOT آخر»): التحميل من المستودع مسار سحب، فالتشغيلة المختارة «استعملها
        // أولاً» لا «يجب»: ما لا يكفيه صالحها، أو كانت منتهية أو موقوفة (تمنح صفراً ولا يُسحب منها، I4)، يُكمَل بالأقرب انتهاءً ثم غير
        // المسمّى بوسم EXPLICIT_FALLBACK وتحذير LOT_EXPLICIT_FALLBACK — والرفض لنقص الصنف كله وحده (409 كالتلقائي)
        const res = allocateOutLines({
          productId: pid, productName: pl[0].productName, view, day, mode: 'LOAD', allowUnknown: input.allowUnknown, lookup,
          explicitShort: 'SPILL',
          lines: pl.map((l) => ({ idx: l.idx, qty: l.abs, unitFactor: l.unitFactor, explicit: l.refs })),
        });
        if (!res.ok) throw receiveFirst(res.error, view);
        warnings.push(...res.warnings);
        for (const [idx, r] of res.lines) rowsByLine.set(idx, r);
      } else if (lenient) {
        const got = lenientPick(view, bucket, pl, lookup, day, warnings);
        for (const [idx, r] of got.rows) rowsByLine.set(idx, r);
        for (const l of pl) {
          const a = got.applied?.get(l.idx);
          if (a !== undefined && Math.abs(a - l.abs) > LOT_EPS) plan.applied.set(l.idx, l.dir * a);
        }
      } else {
        for (const [idx, r] of pickPlan(view, bucket, pl, lookup, day, warnings)) rowsByLine.set(idx, r);
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
    if (lenient && (l.refs || l.creates)) {
      // مفتاح الربط: الصفوف المحلولة كما هي، والرقم الجديد يُنشأ بقواعد اليوم (resolveOrCreateLot بمصدر LOAD) بتحذير LOT_CREATED
      const want: { lotId: string | null; qty: number; expiryDate: string | null }[] = (l.refs ?? []).map((r) => ({ lotId: r.lotId, qty: r.qty, expiryDate: null }));
      for (const p of l.creates ?? []) {
        const r = await resolveOrCreateLot(tx, tid, { id: l.productId, name: l.productName, shelfLifeOn: l.shelfLifeOn },
          { lotNumber: p.lotNumber, productionDate: p.productionDate ?? null, expiryDate: p.expiryDate ?? null }, { source: 'LOAD', createdBy: input.createdBy, actor });
        metas.set(r.meta.id, r.meta);
        if (r.created) warnings.push({ code: 'LOT_CREATED', productId: l.productId, detail: { idx: l.idx, lotId: r.meta.id, lotNumber: r.meta.lotNumber } });
        want.push({ lotId: r.meta.id, qty: p.qty, expiryDate: r.meta.expiryDate });
      }
      // مجموعٌ يخالف كمية السطر: التفضيلات حتى كميته بترتيبها، والباقي غير مسمّى (لا رقم يُخترع) — بتحذير
      const sum = want.reduce((s, r) => s + r.qty, 0);
      if (Math.abs(sum - l.abs) > LOT_EPS) warnings.push(rowsSumWarning(l, sum));
      const mine = new Map<string, number>();
      let left = l.abs;
      for (const r of want) {
        const q = roundLot(Math.min(r.qty, left));
        if (!(q > LOT_EPS)) continue;
        mine.set(keyOf(r.lotId), roundLot((mine.get(keyOf(r.lotId)) ?? 0) + q));
        left = roundLot(left - q);
      }
      if (left > LOT_EPS) mine.set(LOT_UNKNOWN_KEY, roundLot((mine.get(LOT_UNKNOWN_KEY) ?? 0) + left));
      rows = [...mine].map(([k, qty]): AllocRow => (k === LOT_UNKNOWN_KEY
        ? { lotId: null, qty, certainty: 'UNKNOWN', flags: [], expiryDate: null }
        : { lotId: k, qty, certainty: 'CONFIRMED', flags: [], expiryDate: metas.get(k)?.expiryDate ?? null }));
    } else if (l.lotNumber) {
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
      // بلا رقمٍ ولا مرجع ⇒ لوطٌ جديد برقمٍ تلقائي LOT… (طلب المالك ١١ نوفمبر ٢٠٢٦ — بدل LOT_REQUIRED)
      const { meta } = await resolveOrCreateLot(tx, tid, { id: l.productId, name: l.productName, shelfLifeOn: l.shelfLifeOn },
        { lotNumber: null, productionDate: l.productionDate, expiryDate: l.expiryDate }, { source: 'LOAD', createdBy: input.createdBy, actor });
      metas.set(meta.id, meta);
      rows = [{ lotId: meta.id, qty: l.abs, certainty: 'CONFIRMED', flags: [], expiryDate: meta.expiryDate }];
    }
    for (const r of rows) {
      if (r.lotId == null) continue;
      const m = metas.get(r.lotId);
      if (!m) throw lotErr('LOT_NOT_FOUND', {}, { ...at, lotId: r.lotId });
      if (m.productId !== l.productId) throw lotErr('LOT_PRODUCT_MISMATCH', { lot: m.lotNumber, name: l.productName }, { ...at, lotId: r.lotId, lotProductId: m.productId });
      if (type === 'LOAD' && lenient && (m.status !== 'ACTIVE' || isLotExpiredOn(m, day))) {
        // مفتاح الربط بلا مستودع: التحميل يسجّل ما وصل السيارة فعلاً من نظامه — يُقبل بتحذيرٍ لا رفض (والبيع منه ممنوعٌ كما هو، I4)
        warnings.push({ code: 'LOT_INTO_BLOCKED', productId: l.productId, detail: { idx: l.idx, lotId: m.id, lotNumber: m.lotNumber, blockKind: m.blockKind, reason: m.status !== 'ACTIVE' ? 'BLOCKED' : 'EXPIRED' } });
      } else if (type === 'LOAD') {
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
    // المحصور (مفتاح الربط) يُكتب بكميته المطبَّقة — فمجموع صفوفه = كمية بنده المكتوبة (I3)
    const want = plan.applied.has(l.idx) ? Math.abs(plan.applied.get(l.idx)!) : l.abs;
    if (Math.abs(sum - want) > LOT_EPS) throw new Error(`LOT_I3_MISMATCH: ${l.productId} ${sum} != ${want}`);
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

// ═══ الجرد المطلق (POST /van-stock/loads بـmode: 'COUNT') وتصفير السيارة (POST /van-stock/zero) ═══
//
// طلب المالك ١٦ نوفمبر ٢٠٢٦: «تصفير مخزون السيارة في Odoo يبقى في فيلد كمية LOT». Odoo يرسل **الكمية المعدودة** لا الفرق، وفيلد
// لا يعرف إلا الفرق — فكان التصفير يُرفض أو يُطبَّق ناقصاً. الجرد يحسب الفرق بنفسه تحت الأقفال: حركة ADJUST واحدة (والإزالة
// EXPIRED_OUT/DAMAGED_OUT حين includeUnsellable) بصفوف لوطها، وإعادة تسميةٍ (LotRelabel بسبب CORRECTION) لتوزيع ما بقي بين التشغيلات
// وغير المسمّى — فلا نوع حركة جديد (foldStock والمزامنة والتقييم والتقارير كما هي)، وغير المسمّى مشتقٌّ دائماً.

/** تحذيرٌ في ردّ الجرد: تحذيرات اللوط ومعها رموز الجرد (COUNT_LOTS_EXCEED، LOT_HELD_REMAINS، COUNT_BUCKET_SKIPPED) */
export interface VanCountWarning { code: string; productId?: string; message?: string; detail?: Record<string, unknown> }

/** خطة دلوٍ لصنف: صفوف الفرق (بإشارته) وإعادات التسمية والأهداف النهائية للصالح */
export interface VanCountBucketPlan {
  net: number;                                   // الفرق الصافي بالأساس (سالب = إنقاص)
  moves: { lotId: string | null; qty: number }[]; // بإشارة الفرق، ومجموعها net (I3)
  relabels: { fromLotId: string | null; toLotId: string | null; qty: number }[];
  targets: Map<string, number>;                  // الصالح النهائي لكل مكوّن (lotId أو '∅')
}

/**
 * خطة جرد دلوٍ واحد لصنفٍ في السيارة (صرفة، على **الصالح** = الخام − المحجوز؛ المحجوز D24 لا يُمسّ). الهدف `usableTarget` ≥ 0.
 * - بأهداف تشغيلات (lotTargets، مكتملة: غير المذكورة صفر): كل تشغيلةٍ هدفها، وغير المسمّى الباقي (المستدعي يضمن ألّا يقلّ عن صفر).
 * - بلاها: الإنقاص من المسمّاة بالأقرب انتهاءً (أيّاً كانت حالتها) ثم غير المسمّى، والزيادة إلى غير المسمّى (لا رقم يُخترع) — وكل
 *   سالبٍ (عجزٌ تاريخي، أو لوطٌ «شبح» فوق رصيد الصنف) يُرفع إلى صفر.
 * ثم الفرق الصافي صفوفٌ على المكوّنات التي تتحرّك باتجاهه (المسمّاة أولاً ثم غير المسمّى)، وما بقي إعادة تسميةٍ من الناقص إلى
 * الزائد — فمجموع النهائي = الهدف، ولا مكوّن سالب (I1، I2).
 */
export function planVanCountBucket(view: PlaceLotView, bucket: LotBucket, usableTarget: number, lotTargets: ReadonlyMap<string, number> | null): VanCountBucketPlan {
  const comps: { key: string; lotId: string | null; u: number }[] = view.lots.map((l) => ({ key: l.lotId, lotId: l.lotId, u: l.usable[bucket] }));
  if (lotTargets) for (const id of lotTargets.keys()) if (id !== LOT_UNKNOWN_KEY && !comps.some((c) => c.key === id)) comps.push({ key: id, lotId: id, u: 0 });
  const all = [...comps, { key: LOT_UNKNOWN_KEY, lotId: null as string | null, u: view.unknownUsable?.[bucket] ?? 0 }];
  const N = roundLot(Math.max(0, usableTarget));
  const f = new Map<string, number>();
  if (lotTargets) {
    let s = 0;
    for (const c of comps) { const t = roundLot(Math.max(0, lotTargets.get(c.key) ?? 0)); f.set(c.key, t); s += t; }
    f.set(LOT_UNKNOWN_KEY, roundLot(Math.max(0, N - s)));
  } else {
    for (const c of all) f.set(c.key, roundLot(Math.max(0, c.u)));
    const P = roundLot([...f.values()].reduce((s, x) => s + x, 0));
    if (N <= P) {
      let R = roundLot(P - N);
      for (const c of all) {
        if (!(R > LOT_EPS)) break;
        const q = roundLot(Math.min(R, f.get(c.key)!));
        f.set(c.key, roundLot(f.get(c.key)! - q));
        R = roundLot(R - q);
      }
    } else f.set(LOT_UNKNOWN_KEY, roundLot(f.get(LOT_UNKNOWN_KEY)! + N - P));
  }
  const delta = new Map(all.map((c) => [c.key, roundLot(f.get(c.key)! - c.u)]));
  const net = roundLot([...delta.values()].reduce((s, x) => s + x, 0));
  const moves: { lotId: string | null; qty: number }[] = [];
  let rem = Math.abs(net);
  const sgn = net < 0 ? -1 : 1;
  for (const c of all) {
    if (!(rem > LOT_EPS)) break;
    const d = delta.get(c.key)!;
    if (!(sgn * d > LOT_EPS)) continue;
    const q = roundLot(Math.min(rem, sgn * d));
    moves.push({ lotId: c.lotId, qty: sgn * q });
    delta.set(c.key, roundLot(d - sgn * q));
    rem = roundLot(rem - q);
  }
  const relabels: VanCountBucketPlan['relabels'] = [];
  const srcs = all.filter((c) => delta.get(c.key)! < -LOT_EPS);
  const sinks = all.filter((c) => delta.get(c.key)! > LOT_EPS);
  let i = 0;
  let j = 0;
  while (i < srcs.length && j < sinks.length) {
    const a = srcs[i];
    const b = sinks[j];
    const q = roundLot(Math.min(-delta.get(a.key)!, delta.get(b.key)!));
    if (q > LOT_EPS) relabels.push({ fromLotId: a.lotId, toLotId: b.lotId, qty: q });
    delta.set(a.key, roundLot(delta.get(a.key)! + q));
    delta.set(b.key, roundLot(delta.get(b.key)! - q));
    if (!(delta.get(a.key)! < -LOT_EPS)) i++;
    if (!(delta.get(b.key)! > LOT_EPS)) j++;
  }
  return { net, moves, relabels, targets: f };
}

const COUNT_BUCKETS = ['SELLABLE', 'EXPIRED', 'DAMAGED'] as const;
const heldOf = (v: PlaceLotView, b: LotBucket): number =>
  roundLot(v.lots.reduce((s, l) => s + l.held[b], 0) + (v.unknown && v.unknownUsable ? v.unknown[b] - v.unknownUsable[b] : 0));

/** عرضٌ فارغ لصنفٍ لا أثر له في السيارة */
function blankVanView(productId: string, vanKey: string): PlaceLotView {
  return { productId, place: 'VAN', vanKey, total: zeroBuckets(), lots: [], unknown: zeroBuckets(), unknownUsable: zeroBuckets(), deficits: [], firstInAt: new Map(), approximate: false };
}

/** الصنف غير المتتبَّع: رصيده كله «غير مسمّى» (صفوف لوطٍ تاريخية من حقبةٍ سابقة لا تُقرأ له) — والمحجوز كما هو */
function untrackedView(v: PlaceLotView): PlaceLotView {
  const total = v.total ?? zeroBuckets();
  const unknownUsable = zeroBuckets();
  for (const b of LOT_BUCKETS) unknownUsable[b] = roundLot(total[b] - heldOf(v, b));
  return { ...v, lots: [], unknown: { ...total }, unknownUsable, deficits: [] };
}

/** سطر جردٍ لصنف: الكمية المعدودة بالأساس (≥ 0)، وتشغيلاته المعدودة اختياراً بالأساس (معرّف فيلد أو رقمٌ كرقم Odoo) */
export interface VanCountLine {
  productId: string; productName: string; shelfLifeOn: boolean; qty: number;
  lots?: { lotId?: string | null; lotNumber?: unknown; qty: number; productionDate?: string | null; expiryDate?: string | null }[] | null;
  lineRef?: string | null;
}
export interface VanCountInput {
  tenantId: string; vanKey: string; day: string; actorId: string | null; note: string | null; clientRef: string | null;
  includeUnsellable: boolean; lines: VanCountLine[];
  /** شكل ردّ الحركة (include المسار نفسه) */
  include: Prisma.VanLoadInclude;
  /** أول المعاملة: قفل المرجع والبحث به (D8) — والمكرَّر يُجهضها */
  gate?: (tx: LotTx) => Promise<void>;
  /** بعد قفل الأصناف: مقارنة الأساس («الوحدة الرئيسية» §3) تحت القفل نفسه */
  afterLock?: (locked: Awaited<ReturnType<typeof lockLotProducts>>) => void;
}
export interface VanCountProductSummary { productId: string; tracked: boolean; target: number; before: Record<LotBucket, number>; after: Record<LotBucket, number> }
export interface VanCountResult { noop: boolean; loads: unknown[]; relabels: number; products: VanCountProductSummary[]; warnings: (LotWarning | VanCountWarning)[] }

/** الجرد لم يبلغ هدفه بعد الكتابة (قراءةٌ ثانية تحت الأقفال) ⇒ تراجعٌ كامل و503 COUNT_POSTCONDITION — لا جردٌ نصف صحيح */
export class VanCountPostcondition extends Error {
  readonly status = 503;
  readonly code = 'COUNT_POSTCONDITION';
  constructor(readonly detail: Record<string, unknown>) { super('لم يطابق رصيد السيارة الجرد بعد التسجيل — أُلغيت العملية فأعد المحاولة'); this.name = 'VanCountPostcondition'; }
}

/**
 * الجرد المطلق لسيارة مندوبٍ قائم داخل معاملته — الترتيب: المرجع (gate)، ثم قفلا التالف والمنتهي (includeUnsellable، بترتيب
 * VAN_LOCK_ORDER)، ثم أقفال الأصناف (lockLotProducts؛ المتتبَّع تحت القفل هو المرجع D25)، ثم الأساس (afterLock)، ثم قفل المتاح
 * `van-sellable:`، ثم القراءة (placeViews بمجاميعها)، ثم الخطة (planVanCountBucket لكل دلو)، ثم الكتابة، ثم **إعادة القراءة**
 * (الهدف بلغ، وكل مكوّنٍ بهدفه، ولا مكوّن سالب) وإلا VanCountPostcondition.
 * - الهدف دون المحجوز (مرتجع إشعارٍ قياسي «01» قابلٌ للإبطال، D24) ⇒ المحجوز يبقى بتحذير LOT_HELD_REMAINS.
 * - مجموع التشغيلات المعدودة فوق كمية الصنف ⇒ الصنف بمجموعها بتحذير COUNT_LOTS_EXCEED.
 * - رقمٌ لا تعرفه الشركة بكمية ⇒ يُنشأ (resolveOrCreateLot بمصدر MANUAL) بتحذير LOT_CREATED، وبصفر ⇒ يُهمل LOT_NUMBER_UNKNOWN.
 * - الخطة الفارغة ⇒ noop بلا كتابة: إعادة الطلب نفسه لا تكتب شيئاً (متكرّرٌ بالبناء)، ومعه clientRef يردّ D8 الحركة المحفوظة.
 * أول حركةٍ تُكتب تحمل clientRef.
 */
export async function executeVanCountInTx(tx: LotTx, input: VanCountInput, ctx: { eventActor: LotEventActor }): Promise<VanCountResult> {
  const { tenantId: tid, vanKey } = input;
  const warnings: (LotWarning | VanCountWarning)[] = [];
  await input.gate?.(tx);
  // ترتيب الأقفال الكلّي (repSaleStock VAN_LOCK_ORDER): التالف ثم المنتهي قبل الأصناف، والمتاح بعدها
  if (input.includeUnsellable) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'van-damaged:' + vanKey}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'van-expired:' + vanKey}))`;
  }
  const pids = uniq(input.lines.map((l) => l.productId));
  const locked = await lockLotProducts(tx, tid, pids);
  input.afterLock?.(locked);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'van-sellable:' + vanKey}))`;
  const read = async () => (await placeViews(tx, tid, { vanKeys: [vanKey], productIds: pids, withTotals: true })).vans.get(vanKey) ?? new Map<string, PlaceLotView>();
  const views = await read();
  const viewOf = (m: Map<string, PlaceLotView>, pid: string) => {
    const v = m.get(pid) ?? blankVanView(pid, vanKey);
    return locked.tracked.has(pid) ? v : untrackedView(v);
  };

  // ── التشغيلات المعدودة: معرّفٌ أو رقمٌ داخل الشركة والصنف (عزل الشركات)، والجديد بكميةٍ يُنشأ ──
  const withLots = input.lines.filter((l) => locked.tracked.has(l.productId) && l.lots?.length);
  const nums = uniq(withLots.flatMap((l) => l.lots!.filter((r) => !r.lotId).map((r) => normalizeLotNumber(r.lotNumber)).filter((x): x is string => !!x)));
  const byNumber = new Map<string, string>();
  if (nums.length) {
    const rows = await tx.productLot.findMany({
      where: { tenantId: tid, productId: { in: uniq(withLots.map((l) => l.productId)) }, lotNumber: { in: nums } }, select: { id: true, productId: true, lotNumber: true },
    });
    for (const r of rows) byNumber.set(`${r.productId}|${r.lotNumber}`, r.id);
  }
  const ids = uniq([...withLots.flatMap((l) => l.lots!.map((r) => r.lotId).filter((x): x is string => typeof x === 'string' && x.length > 0)), ...byNumber.values()]);
  const metas = ids.length ? await loadLotMetas(tx, tid, { lotIds: ids }) : new Map<string, LotMeta>();
  const lotTargets = new Map<string, Map<string, number>>();
  for (const l of withLots) {
    const t = new Map<string, number>();
    for (const r of l.lots!) {
      const qty = roundLot(Math.max(0, Number(r.qty) || 0));
      const num = r.lotId ? null : normalizeLotNumber(r.lotNumber);
      const id = r.lotId || (num ? byNumber.get(`${l.productId}|${num}`) : undefined);
      let m = id ? metas.get(id) : undefined;
      if (!(m && m.productId === l.productId) && !r.lotId && num && qty > LOT_EPS) {
        const c = await resolveOrCreateLot(tx, tid, { id: l.productId, name: l.productName, shelfLifeOn: l.shelfLifeOn },
          { lotNumber: num, productionDate: r.productionDate ?? null, expiryDate: r.expiryDate ?? null }, { source: 'MANUAL', createdBy: input.actorId, actor: ctx.eventActor });
        m = c.meta;
        metas.set(m.id, m);
        if (c.created) warnings.push({ code: 'LOT_CREATED', productId: l.productId, detail: { lotId: m.id, lotNumber: m.lotNumber } });
      }
      if (!(m && m.productId === l.productId)) {
        warnings.push({ code: 'LOT_NUMBER_UNKNOWN', productId: l.productId, detail: { ...(r.lotId ? { lotId: r.lotId } : { lotNumber: num ?? null }), reason: m ? 'PRODUCT_MISMATCH' : 'NOT_FOUND', qty, fallback: 'UNNAMED' } });
        continue;
      }
      t.set(m.id, roundLot((t.get(m.id) ?? 0) + qty));
    }
    lotTargets.set(l.productId, t);
  }

  // ── الخطة لكل صنفٍ ودلو ──
  type Kind = 'ADJUST' | 'EXPIRED_OUT' | 'DAMAGED_OUT';
  type Item = { productId: string; qty: number; rows: { lotId: string | null; qty: number }[]; lineRef: string | null; tracked: boolean };
  const items: Record<Kind, Item[]> = { ADJUST: [], EXPIRED_OUT: [], DAMAGED_OUT: [] };
  const relabels: { productId: string; bucket: LotBucket; fromLotId: string | null; toLotId: string | null; qty: number }[] = [];
  const expect = new Map<string, { target: number; plans: Map<LotBucket, VanCountBucketPlan> }>();
  const summary: VanCountProductSummary[] = [];
  for (const l of input.lines) {
    const pid = l.productId;
    const isTracked = locked.tracked.has(pid);
    const v = viewOf(views, pid);
    const lt = isTracked ? lotTargets.get(pid) ?? null : null;
    let target = roundLot(Math.max(0, l.qty));
    const held = heldOf(v, 'SELLABLE');
    const lotSum = lt ? roundLot([...lt.values()].reduce((s, x) => s + x, 0)) : 0;
    if (lt && lotSum > roundLot(target - held) + LOT_EPS) {
      warnings.push({ code: 'COUNT_LOTS_EXCEED', productId: pid, message: 'مجموع التشغيلات المعدودة أكبر من كمية الصنف — اعتُمد مجموعها', detail: { requested: target, lots: lotSum } });
      target = roundLot(lotSum + held);
    }
    if (target < held - LOT_EPS) {
      warnings.push({ code: 'LOT_HELD_REMAINS', productId: pid, message: 'في السيارة مرتجعٌ محجوز بانتظار حالة الإشعار — بقي كما هو', detail: { requested: target, held } });
      target = held;
    }
    const plans = new Map<LotBucket, VanCountBucketPlan>();
    for (const b of COUNT_BUCKETS) {
      if (b !== 'SELLABLE' && !input.includeUnsellable) continue;
      const p = planVanCountBucket(v, b, b === 'SELLABLE' ? roundLot(target - held) : 0, b === 'SELLABLE' ? lt : null);
      // المنتهي والتالف يُزالان ولا يُزادان: رصيدٌ سالبٌ فيهما خللٌ قديم لا يصلحه الجرد
      if (b !== 'SELLABLE' && p.net > LOT_EPS) {
        warnings.push({ code: 'COUNT_BUCKET_SKIPPED', productId: pid, detail: { bucket: b, net: p.net } });
        continue;
      }
      plans.set(b, p);
      if (Math.abs(p.net) > LOT_EPS) {
        const kind: Kind = b === 'SELLABLE' ? 'ADJUST' : b === 'EXPIRED' ? 'EXPIRED_OUT' : 'DAMAGED_OUT';
        const sign = kind === 'ADJUST' ? 1 : -1; // الإزالة بكمياتٍ موجبة (vanMoveEffect يطرحها)
        items[kind].push({
          productId: pid, qty: roundLot(sign * p.net), rows: isTracked ? p.moves.map((m) => ({ lotId: m.lotId, qty: roundLot(sign * m.qty) })) : [],
          lineRef: kind === 'ADJUST' ? l.lineRef ?? null : null, tracked: isTracked,
        });
      }
      if (isTracked) for (const r of p.relabels) relabels.push({ productId: pid, bucket: b, ...r });
    }
    expect.set(pid, { target, plans });
    const total = v.total ?? zeroBuckets();
    summary.push({ productId: pid, tracked: isTracked, target, before: { ...total }, after: { ...total } });
  }

  const kinds = (['ADJUST', 'EXPIRED_OUT', 'DAMAGED_OUT'] as const).filter((k) => items[k].length);
  if (!kinds.length && !relabels.length) return { noop: true, loads: [], relabels: 0, products: summary, warnings };

  // ── الكتابة: حركةٌ لكل نوع (أولها تحمل clientRef)، والبنود بالأساس، وصفوف لوط الصنف المتتبَّع بإشارة البند (I3) ──
  const loads: unknown[] = [];
  for (const [n, kind] of kinds.entries()) {
    loads.push(await tx.vanLoad.create({
      data: {
        tenantId: tid, salesRepId: vanKey, type: kind, note: input.note ?? 'جرد السيارة (COUNT)',
        ...(kind === 'ADJUST' && { reason: 'COUNT' }),
        ...(n === 0 && input.clientRef && { clientRef: input.clientRef }),
        createdBy: 'ADMIN',
        items: {
          create: items[kind].map((it) => ({
            productId: it.productId, ...unitFields(it.qty, null),
            ...(it.lineRef && { lineRef: it.lineRef }),
            ...(it.tracked && it.rows.length > 0 && {
              lots: {
                create: it.rows.filter((r) => Math.abs(r.qty) > LOT_EPS).map((r) => ({
                  tenantId: tid, productId: it.productId, vanKey, moveType: kind, viaWarehouse: false,
                  lotId: r.lotId, qty: r.qty, certainty: r.lotId ? 'CONFIRMED' : 'UNKNOWN', reason: null,
                })),
              },
            }),
          })),
        },
      },
      include: input.include,
    }));
  }
  // إعادة التسمية: توزيعٌ بلا كمية جديدة (لا تقييم يتغيّر) — من الناقص إلى الزائد، بسبب CORRECTION وسطرٌ في سجلّ كل تشغيلةٍ مسمّاة.
  // هنا وحده يُتجاوز شرط «المصدر نشطٌ غير منتهٍ» (D27): تصحيحٌ يولّده النظام لرصيدٍ غير موجود فعلاً لا تسميةٌ يختارها مستخدم
  const note = 'تصحيح آلي من جرد السيارة (COUNT)';
  for (const r of relabels) {
    const row = await tx.lotRelabel.create({
      data: { tenantId: tid, productId: r.productId, place: 'VAN', vanKey, bucket: r.bucket, fromLotId: r.fromLotId, toLotId: r.toLotId, qty: r.qty, reason: 'CORRECTION', note, createdBy: input.actorId },
      select: { id: true },
    });
    const after = { relabelId: row.id, place: 'VAN', vanKey, bucket: r.bucket, fromLotId: r.fromLotId, toLotId: r.toLotId, qty: r.qty, relabelReason: 'CORRECTION', source: 'COUNT' };
    for (const lotId of [r.fromLotId, r.toLotId]) {
      if (lotId) await recordLotEvent(tx, { tenantId: tid, lotId, productId: r.productId, kind: 'RELABEL', after, reason: note, actor: ctx.eventActor });
    }
  }

  // ── الشرط اللاحق: إعادة القراءة في المعاملة نفسها ──
  const again = await read();
  const bad: Record<string, unknown>[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-4;
  for (const s of summary) {
    const v = viewOf(again, s.productId);
    const total = v.total ?? zeroBuckets();
    s.after = { ...total };
    const e = expect.get(s.productId)!;
    if (!near(total.SELLABLE, e.target)) bad.push({ productId: s.productId, bucket: 'SELLABLE', total: total.SELLABLE, target: e.target });
    for (const [b, p] of e.plans) {
      if (b !== 'SELLABLE' && !near(roundLot(total[b] - heldOf(v, b)), 0)) bad.push({ productId: s.productId, bucket: b, total: total[b] });
      if (!s.tracked) continue;
      for (const [k, t] of p.targets) {
        const now = k === LOT_UNKNOWN_KEY ? v.unknownUsable?.[b] ?? 0 : v.lots.find((x) => x.lotId === k)?.usable[b] ?? 0;
        if (!near(now, t)) bad.push({ productId: s.productId, bucket: b, lotId: k === LOT_UNKNOWN_KEY ? null : k, usable: now, target: t });
      }
    }
  }
  if (bad.length) throw new VanCountPostcondition({ mismatches: bad.slice(0, 20) });
  return { noop: false, loads, relabels: relabels.length, products: summary, warnings };
}
