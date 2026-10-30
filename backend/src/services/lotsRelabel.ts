/**
 * «تتبّع اللوط» — تسمية الرصيد القائم وإعادة التصنيف والتصحيح (المواصفة §٤.٦): بُعد اللوط وحده — لا يغيّر رصيد الصنف ولا
 * التقييم (R9)، ولا يكتب تسوية مستودع (addAtAvg يغيّر التقييم). لا يستورد إعداد القاعدة.
 *
 * - **المصدر** (D27): لوطٌ نشط غير منتهٍ يوم العملية، أو غير المسمّى (fromLotId = null). الموقوف والمنتهي لا يخرج رصيدهما
 *   إلا بالتنزيل أو تسوية النقص أو الإتلاف أو الإزالة — فلا يُدوَّر بتسميته لوطاً آخر ولا بإرجاعه إلى غير المسمّى.
 * - **منع السالب** بدلالة حارس الإزالة نفسه (removalKeepsLots) على عرض المكان تحت القفل، بعد جمع الأسطر (D26): صالح اللوط
 *   بعد التسمية ≥ −EPS (I1)، وصالح غير المسمّى ≥ min(0, قبله) − EPS (I2)، وغير المسمّى المجهول (سيارة مندوب محذوف) لا يُسمّى
 *   منه. والمحجوز (D24) خارج الصالح فلا يُسمّى.
 * - **الوجهة**: لوطٌ قائم أو رقمٌ يُحلّ أو يُنشأ بمصدر RELABEL؛ الموقوفة تُقبل بتحذير LOT_INTO_BLOCKED؛ والوجهة null (إرجاعٌ
 *   إلى غير المسمّى يمحو هوية الرصيد) تصحيحٌ يلزمه CORRECTION وملاحظة، ولمستخدمٍ غير مقيّد بنطاق.
 * - كل كمية بأربع خانات (isLotQty) وبوحدة الأساس (D22).
 */
import { shelfLifeOf } from './shelfLife';
import {
  LOT_BUCKETS, LOT_MAX_ROWS, LOT_NUMBER_MAX, LOT_PLACES, LOT_RELABEL_REASONS, LotError, isLotExpiredOn, isLotQty, lotErr, lotMessage, normalizeLotNumber,
  removalKeepsLots, roundLot,
  type LotBucket, type LotMeta, type LotWarning, type PlaceLotView, type RelabelInput,
} from './lots';
import { loadLotMetas, lockLotProducts, placeViews, recordLotEvent, resolveOrCreateLot, type LotEventActor, type LotTx } from './lotsDb';

const ACTOR_TYPES: readonly LotEventActor['type'][] = ['ADMIN', 'OWNER', 'STAFF', 'API_KEY', 'SYSTEM'];

/** فاعل سجل التدقيق من فاعل الطلب — نوعٌ غير معروف يُسجَّل ADMIN */
export function relabelActor(a: RelabelInput['actor']): LotEventActor {
  const type = (ACTOR_TYPES as readonly string[]).includes(a.type) ? (a.type as LotEventActor['type']) : 'ADMIN';
  return { type, id: a.id ?? null, name: a.name ?? null };
}

/** LOT_RELABEL_INVALID برسالةٍ تشرح السبب (الرمز والحالة 422 كما في §٣.٣) */
const relabelInvalid = (message: string, detail: Record<string, unknown>): LotError => new LotError('LOT_RELABEL_INVALID', message, 422, detail);

/** وجهة السطر: لوطٌ بمعرّفه، أو رقمٌ يُحلّ أو يُنشأ، أو غير المسمّى (null) */
export type RelabelDest = { kind: 'ID'; lotId: string } | { kind: 'NUMBER' } | { kind: 'UNKNOWN' };
export function relabelDestOf(line: RelabelInput['lines'][number]): RelabelDest {
  if (typeof line.toLotId === 'string' && line.toLotId.length > 0) return { kind: 'ID', lotId: line.toLotId };
  if (typeof line.lotNumber === 'string' && line.lotNumber.trim().length > 0) return { kind: 'NUMBER' };
  return { kind: 'UNKNOWN' };
}

/**
 * فحص الطلب بلا قاعدة: المكان والدلو والسبب، وعدد الأسطر، والكمية بأربع خانات (isLotQty)، والطرفان (from == to أو بلا طرفين
 * ⇒ LOT_RELABEL_INVALID)، والتصحيح إلى غير المسمّى (CORRECTION وملاحظة ولغير المقيّد). null ⇒ صالحٌ شكلاً، والمصدر والوجهة
 * يُفحصان تحت القفل.
 */
export function relabelRequestProblem(input: RelabelInput): LotError | null {
  if (!(LOT_PLACES as readonly string[]).includes(input.place)) return relabelInvalid('مكان التسمية غير صالح', { place: input.place });
  if (!(LOT_BUCKETS as readonly string[]).includes(input.bucket)) return relabelInvalid('دلو التسمية غير صالح', { bucket: input.bucket });
  if (!(LOT_RELABEL_REASONS as readonly string[]).includes(input.reason)) return relabelInvalid('سبب التسمية غير صالح', { reason: input.reason });
  if (input.place === 'WAREHOUSE' && input.bucket !== 'SELLABLE') return relabelInvalid('المستودع دلو واحد صالح للبيع', { bucket: input.bucket });
  if (input.place === 'VAN' && !(typeof input.vanKey === 'string' && input.vanKey.length > 0)) return relabelInvalid('حدد سيارة المندوب', { place: input.place });
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > LOT_MAX_ROWS) {
    return lotErr('LOT_QTY_INVALID', {}, { productId: input.productId, lines: Array.isArray(input.lines) ? input.lines.length : null, max: LOT_MAX_ROWS });
  }
  for (const [i, line] of input.lines.entries()) {
    if (typeof line.qty !== 'number' || !isLotQty(line.qty)) return lotErr('LOT_QTY_INVALID', {}, { productId: input.productId, line: i, qty: line.qty, decimals: 4 });
    const dest = relabelDestOf(line);
    if (dest.kind === 'UNKNOWN') {
      // من غير المسمّى إلى غير المسمّى: بلا طرفين
      if (input.fromLotId == null) return lotErr('LOT_RELABEL_INVALID', {}, { line: i });
      // إرجاع رصيدٍ مسمّى إلى غير المسمّى يمحو هويته — تصحيحٌ صريح بملاحظة، لغير المقيّد
      if (input.reason !== 'CORRECTION') return relabelInvalid('إرجاع الرصيد إلى غير المسمى تصحيح يلزمه سبب CORRECTION', { line: i, reason: input.reason });
      if (!(input.note ?? '').trim()) return lotErr('LOT_REASON_REQUIRED', {}, { line: i, reason: 'CORRECTION' });
      if (input.actor.scoped) return lotErr('LOT_SCOPED_USER', {}, { line: i, reason: 'CORRECTION' });
    } else if (dest.kind === 'ID' && dest.lotId === input.fromLotId) {
      return lotErr('LOT_RELABEL_INVALID', {}, { line: i, lotId: dest.lotId });
    } else if (dest.kind === 'NUMBER' && normalizeLotNumber(line.lotNumber) == null) {
      // أطول من الحدّ بعد التطبيع: لا يُقصّ (القصّ يدمج تشغيلتين)
      return relabelInvalid(`رقم التشغيلة ${LOT_NUMBER_MAX} حرفا على الأكثر`, { line: i, max: LOT_NUMBER_MAX });
    }
  }
  return null;
}

/**
 * قيود المصدر (D27) ومنع السالب (I1، I2) على عرض المكان: اللوط موجود في الشركة ومن الصنف، نشط، غير منتهٍ يوم العملية،
 * ومجموع الطلب ≤ صالحه في الدلو؛ وغير المسمّى لا يُنقص دون min(0, قبله)، والمجهول (total = null) لا يُسمّى منه. الفحص
 * بحارس الإزالة نفسه (removalKeepsLots) فلا دلالتان للسالب. صرفة لتُختبر وحدها.
 */
export function relabelSourceProblem(view: PlaceLotView, src: { fromLotId: string | null; bucket: LotBucket; qty: number; day: string },
  fromMeta: LotMeta | null): LotError | null {
  if (src.fromLotId != null) {
    if (!fromMeta) return lotErr('LOT_NOT_FOUND', {}, { lotId: src.fromLotId });
    if (fromMeta.productId !== view.productId) return lotErr('LOT_PRODUCT_MISMATCH', { lot: fromMeta.lotNumber }, { lotId: fromMeta.id, productId: view.productId });
    if (fromMeta.status !== 'ACTIVE') return lotErr('LOT_BLOCKED', { lot: fromMeta.lotNumber }, { lotId: fromMeta.id, blockKind: fromMeta.blockKind });
    if (isLotExpiredOn(fromMeta, src.day)) return lotErr('LOT_EXPIRED', { lot: fromMeta.lotNumber, date: fromMeta.expiryDate }, { lotId: fromMeta.id, expiryDate: fromMeta.expiryDate });
  }
  const keeps = removalKeepsLots(view, [{ productId: view.productId, lotId: src.fromLotId, bucket: src.bucket, qty: src.qty }]);
  if (!keeps) return null;
  return new LotError(keeps.code, keeps.message, keeps.status, { ...(keeps.detail ?? {}), reason: 'RELABEL' });
}

/**
 * داخل المعاملة (بعد الطابور): قفل الصنف (lockLotProducts) قبل أي قراءة رصيد أو كتابة، ثم قيود المصدر على عرض المكان، ثم
 * الوجهة (حلّ أو إنشاء بمصدر RELABEL؛ null تتطلب CORRECTION وملاحظة)، ثم صفّ LotRelabel لكل سطر وLotEvent RELABEL على كل لوطٍ
 * مسمّى في طرفيه. from == to أو غياب الطرفين ⇒ LOT_RELABEL_INVALID. والتحذيرات (LOT_INTO_BLOCKED) في الردّ.
 * صنفٌ غير متتبَّع الآن يُرفض: تسميته قبل التفعيل تسقط عنده (الحقبة تبدأ بعدها، D25) فتُكتب بلا أثر.
 */
export async function relabelInTx(tx: LotTx, input: RelabelInput): Promise<{ rows: number; warnings: LotWarning[] }> {
  const shape = relabelRequestProblem(input);
  if (shape) throw shape;
  const tid = input.tenantId;
  const { tracked } = await lockLotProducts(tx, tid, [input.productId]);
  const product = await tx.product.findFirst({
    where: { id: input.productId, tenantId: tid },
    select: { id: true, name: true, shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true },
  });
  // صنفٌ من شركةٍ أخرى أو محذوف: 404 كمسارات الأصناف (معالج 4xx في الموجّه)
  if (!product) throw Object.assign(new Error('الصنف غير موجود'), { status: 404 });
  if (!tracked.has(product.id)) throw relabelInvalid('الصنف غير متتبع بـLOT فعّل تتبعه أولا ثم سمّ رصيده', { productId: product.id });
  const vanKey = input.place === 'VAN' ? (input.vanKey as string) : null;
  if (input.place === 'WAREHOUSE') {
    const t = await tx.tenant.findUnique({ where: { id: tid }, select: { warehouseEnabled: true } });
    if (t?.warehouseEnabled !== true) throw relabelInvalid('مخزون الشركة غير مفعّل فلا تسمية فيه', { place: 'WAREHOUSE' });
  }

  // المصدر: البطاقة من الشركة (I5)، ثم العرض تحت القفل
  const fromMeta = input.fromLotId ? (await loadLotMetas(tx, tid, { lotIds: [input.fromLotId] })).get(input.fromLotId) ?? null : null;
  const views = await placeViews(tx, tid, {
    warehouse: input.place === 'WAREHOUSE', vanKeys: vanKey ? [vanKey] : [], productIds: [product.id], withTotals: true,
  });
  const view = input.place === 'WAREHOUSE' ? views.warehouse.get(product.id) : views.vans.get(vanKey as string)?.get(product.id);
  if (!view) throw lotErr('LOT_STOCK_INSUFFICIENT', { name: product.name }, { productId: product.id, place: input.place, vanKey, reason: 'RELABEL' });
  const qty = roundLot(input.lines.reduce((s, l) => s + l.qty, 0));
  const srcProblem = relabelSourceProblem(view, { fromLotId: input.fromLotId, bucket: input.bucket, qty, day: input.day }, fromMeta);
  if (srcProblem) throw srcProblem;

  // الوجهات: الشركة والصنف شرطٌ في الحلّ (I5)، والرقم القائم بتواريخ مختلفة يُرفض (I6)، والانتهاء إلزامي مع الصلاحية للجديد
  const actor = relabelActor(input.actor);
  const warnings: LotWarning[] = [];
  const productRef = { id: product.id, name: product.name, shelfLifeOn: shelfLifeOf(product) != null };
  const dests: (LotMeta | null)[] = [];
  for (const [i, line] of input.lines.entries()) {
    const d = relabelDestOf(line);
    if (d.kind === 'UNKNOWN') { dests.push(null); continue; }
    const { meta } = await resolveOrCreateLot(tx, tid, productRef,
      d.kind === 'ID' ? { lotId: d.lotId } : { lotNumber: line.lotNumber, productionDate: line.productionDate ?? null, expiryDate: line.expiryDate ?? null },
      { source: 'RELABEL', createdBy: input.actor.id, actor });
    // رقمٌ يُحلّ إلى لوط المصدر نفسه: من التشغيلة إليها
    if (meta.id === input.fromLotId) throw new LotError('LOT_RELABEL_INVALID', lotMessage('LOT_RELABEL_INVALID'), 422, { line: i, lotId: meta.id });
    if (meta.status !== 'ACTIVE' && !warnings.some((w) => w.detail?.lotId === meta.id)) {
      warnings.push({ code: 'LOT_INTO_BLOCKED', productId: product.id, detail: { lotId: meta.id, lotNumber: meta.lotNumber, blockKind: meta.blockKind } });
    }
    dests.push(meta);
  }

  const note = (input.note ?? '').trim() || null;
  for (const [i, line] of input.lines.entries()) {
    const to = dests[i];
    const row = await tx.lotRelabel.create({
      data: {
        tenantId: tid, productId: product.id, place: input.place, vanKey, bucket: input.bucket,
        fromLotId: input.fromLotId, toLotId: to ? to.id : null, qty: line.qty, reason: input.reason, note, createdBy: input.actor.id,
      },
      select: { id: true },
    });
    const after = {
      relabelId: row.id, place: input.place, vanKey, bucket: input.bucket,
      fromLotId: input.fromLotId, fromLotNumber: fromMeta?.lotNumber ?? null, toLotId: to ? to.id : null, toLotNumber: to ? to.lotNumber : null,
      qty: line.qty, relabelReason: input.reason,
    };
    // سطرٌ في سجلّ كل لوطٍ مسمّى في طرفي التسمية (المادة ٥٢، D27)
    for (const lotId of [input.fromLotId, to?.id ?? null]) {
      if (!lotId) continue;
      await recordLotEvent(tx, { tenantId: tid, lotId, productId: product.id, kind: 'RELABEL', after, reason: note, actor });
    }
  }
  return { rows: input.lines.length, warnings };
}
