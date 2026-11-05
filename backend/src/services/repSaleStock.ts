/**
 * حرّاس مخزون سيارة المندوب للأصناف غير المتتبَّعة باللوط (مراجعة المخزون نوفمبر ٢٠٢٦، البنود ٥ و٨ و٩ و١٦).
 *
 * - البند ٩: فحص «البيع بدون مخزون» قبل المعاملة لا يكفي — بيعان متزامنان (إعادة رفع من الصندوق وبيعٌ حيّ) يقرآن المتبقّي
 *   نفسه فيُقبلان معاً. فداخل معاملة الإصدار قفلٌ استشاريّ لسيارة المندوب (`van-sellable:<repId>`) ثم إعادة حساب المتبقّي
 *   لأصناف الفاتورة وحدها. والقراءة بعميل المعاملة نفسه: تحت READ COMMITTED يرى كل استعلامٍ ما التزم قبله، والقفل لا يُمنح
 *   إلا بعد التزام الممسك.
 * - البند ٥ (قرار المالك D5): إعادة رفع الصندوق (X-FS-Replay بجلسة المندوب، لا مفتاح API) لا تُرفض بعجز السيارة — سُلّمت
 *   بضاعتها وطُبعت ورقتها — بل تُحجز 409 VAN_STOCK_REPLAY_HELD فيبقيها الصندوق «بانتظار الإدارة» كحجز اللوط، وتُبلَّغ الإدارة.
 * - البندان ٨ و١٦ (قرار المالك D10): إلغاء مرتجع، أو إطفاء «يعود للمخزون»، أو سحب إشعارٍ دائن قياسي — يُمنع إن صار به رصيد
 *   السيارة سالباً في دلوه (المتاح أو المنتهي أو التالف) ⇒ 409 RETURN_CANCEL_STOCK_SHORT. والمتتبَّع باللوط حارسه في lotsInvoice.
 *
 * مفاتيح الأقفال: `van-sellable:` جديد هنا، و`van-expired:`/`van-damaged:` هما مفتاحا إزالة المنتهي والتالف في routes/vanStock.ts
 * فيتسلسل الإلغاء معها. ومن يأخذ أكثر من مفتاح يأخذها بترتيبٍ ثابت (VAN_LOCK_ORDER) فلا تعطّل متبادل.
 */
import type { Prisma } from '@prisma/client';
import { bucketRemaining, foldStock, type StockBucket } from '../routes/vanStock';
import { isDamagedVanReturn } from './vanDamaged';
import { baseQtyOf } from './units';

const EPS = 1e-9;

/** رمز الحجز للمراجعة — يقرؤه صندوق تطبيق المندوب (web-admin/src/rep/offlineSync.ts) */
export const VAN_STOCK_REPLAY_HELD = 'VAN_STOCK_REPLAY_HELD';

/** مفتاح قفل المتاح للبيع في سيارة المندوب — مشترَكٌ مع أي حارسٍ يُنقص المتاح نفسه (التنزيل مثلاً) فيتسلسلان */
export const VAN_SELLABLE_LOCK_PREFIX = 'van-sellable:';

/** دلاء السيارة كما يطويها foldStock: المتاح للبيع، والمنتهي، والتالف */
export type VanBucket = 'sellable' | 'expired' | 'damaged';

/**
 * ترتيب الأقفال الثابت لمن يأخذ أكثر من دلو — وإزالة المنتهي/التالف والبيع يأخذ كلٌّ منها دلواً واحداً.
 * والترتيب الكلّي مع أقفال الأصناف: `van-damaged` ⇒ `van-expired` ⇒ أقفال الأصناف واللوط (lockBases/lockLotProducts) ⇒ `van-sellable`
 * — إزالة المنتهي/التالف تأخذ دلوها قبل أصنافها، والبيع والتنزيل والتسوية بالسالب يأخذون المتاح بعدها، وإلغاء المرتجع
 * يأخذ دلوَي المنتهي والتالف قبل حارس اللوط (preLockReturnOutBuckets) والمتاح بعده — فلا تعطّل متبادل بينها.
 */
export const VAN_LOCK_ORDER: readonly VanBucket[] = ['damaged', 'expired', 'sellable'];

/** مفتاح قفل الدلو — `van-expired:`/`van-damaged:` كما في routes/vanStock.ts حرفياً */
export const vanLockKey = (bucket: VanBucket, salesRepId: string) =>
  (bucket === 'sellable' ? VAN_SELLABLE_LOCK_PREFIX : `van-${bucket}:`) + salesRepId;

export const vanStockHeldMessage = (name: string) =>
  `فاتورة دون اتصال تتجاوز مخزون سيارتك من «${name}» — محفوظة بانتظار الإدارة لتسجيل التحميل الناقص`;

/** جسم ردّ الحجز (409) — رسالةٌ بالعربية والصنف الذي عجزت عنه السيارة */
export function vanStockHeldBody(name: string, productId: string, availableBase: number, requestedBase: number) {
  return {
    success: false as const, code: VAN_STOCK_REPLAY_HELD, message: vanStockHeldMessage(name),
    detail: { productId, availableBase: round4(availableBase), requestedBase: round4(requestedBase) },
  };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** عجز السيارة داخل معاملة الإصدار (البند ٩) — يحوّله المسار إلى 403 للحيّ أو 409 الحجز لإعادة الرفع */
export class VanStockShort extends Error {
  constructor(readonly productId: string, readonly wanted: number, readonly available: number) {
    super('VAN_STOCK_SHORT');
  }
}

/** أول صنفٍ يتجاوز مطلوبُه (بالأساس) متبقّيه، أو null. `skip`: أصنافٌ لا تُفحص هنا (المتتبَّعة — حارسها التوزيع) */
export function vanShortage(want: ReadonlyMap<string, number>, remaining: ReadonlyMap<string, number>, skip?: ReadonlySet<string>):
  { productId: string; wanted: number; available: number } | null {
  for (const [productId, wanted] of want) {
    if (skip?.has(productId)) continue;
    const available = remaining.get(productId) ?? 0;
    if (wanted > available + EPS) return { productId, wanted, available };
  }
  return null;
}

/** قفل دلاء سيارة المندوب داخل المعاملة بالترتيب الثابت — يُفكّ مع التزامها */
export async function lockVanBuckets(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, salesRepId: string, buckets: Iterable<VanBucket>): Promise<void> {
  const want = new Set(buckets);
  for (const b of VAN_LOCK_ORDER) {
    if (!want.has(b)) continue;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${vanLockKey(b, salesRepId)}))`;
  }
}

/** قفل المتاح للبيع في سيارة المندوب داخل المعاملة */
export function lockVanSellable(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, salesRepId: string): Promise<void> {
  return lockVanBuckets(tx, salesRepId, ['sellable']);
}

export type VanStockDb = Pick<Prisma.TransactionClient, 'vanLoadItem' | 'invoiceItem'>;

/** دلاء سيارة المندوب (بالأساس) لأصنافٍ بعينها — طيّ computeStock نفسه (foldStock) مقصوراً عليها */
export async function vanBucketsFor(db: VanStockDb, tenantId: string, salesRepId: string, productIds: readonly string[]): Promise<Map<string, StockBucket>> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Map();
  const [loads, invs] = await Promise.all([
    db.vanLoadItem.findMany({
      where: { productId: { in: ids }, vanLoad: { tenantId, salesRepId } },
      select: { productId: true, qty: true, unitFactor: true, baseQty: true, vanLoad: { select: { type: true, createdAt: true } } },
    }),
    db.invoiceItem.findMany({
      where: { productId: { in: ids }, invoice: { tenantId, salesRepId, status: 'CONFIRMED' } },
      select: {
        productId: true, qty: true, unitFactor: true, baseQty: true, returnExpired: true,
        invoice: { select: { type: true, returnToStock: true, invoiceDate: true, returnReason: true, createdAt: true } },
      },
    }),
  ]);
  return foldStock((loads ?? []) as never, (invs ?? []) as never).bal;
}

/** متبقّي سيارة المندوب (المتاح للبيع، بالأساس) لأصنافٍ بعينها */
export async function vanRemainingFor(db: VanStockDb, tenantId: string, salesRepId: string, productIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const [pid, b] of await vanBucketsFor(db, tenantId, salesRepId, productIds)) out.set(pid, bucketRemaining(b));
  return out;
}

/** رصيد الدلو من دلاء الصنف — المتاح بـbucketRemaining، والمنتهي والتالف الوارد ناقص المُزال */
export function bucketBalance(b: StockBucket | undefined, bucket: VanBucket): number {
  if (!b) return 0;
  if (bucket === 'sellable') return bucketRemaining(b);
  if (bucket === 'expired') return round4(b.expiredIn - b.expiredOut);
  return round4(b.damagedIn - b.damagedOut);
}

/**
 * دلو بند المرتجع في السيارة — منطق foldStock (addInv) حرفياً: المنتهي أولاً، ثم التالف منذ DAMAGED_VAN_SINCE، ثم المتاح إن
 * عاد للمخزون؛ وغيرها (لا يعود) null لا أثر له.
 */
export function returnItemBucket(
  inv: { returnToStock: boolean | null; returnReason?: string | null; createdAt?: Date | null },
  item: { returnExpired?: boolean | null },
): VanBucket | null {
  if (item.returnExpired) return 'expired';
  if (isDamagedVanReturn(inv)) return 'damaged';
  if (inv.returnToStock) return 'sellable';
  return null;
}

/** سطر ردّ 409 RETURN_CANCEL_STOCK_SHORT */
export interface ReturnCancelShortLine { productId: string; availableBase: number; requiredBase: number; bucket: VanBucket }

export const RETURN_CANCEL_STOCK_SHORT = 'RETURN_CANCEL_STOCK_SHORT';

/** ما يُسحب من السيارة بالتغيير: لكل صنفٍ ودلو مجموع الكمية بالأساس */
export type ReturnRemoval = { productId: string; bucket: VanBucket; base: number };

/**
 * ما يسحبه التغيير من السيارة (نقيّ): الإلغاء (CANCEL) يسحب كل أثر المرتجع من دلائه، وإطفاء العودة (RESTOCK_OFF) يسحب ما في
 * المتاح وحده (المنتهي والتالف لا تحكمهما returnToStock). بنود `skip` (المتتبَّعة — حارسها حارس اللوط) لا تُحسب.
 */
export function returnRemovals(
  inv: { returnToStock: boolean | null; returnReason?: string | null; createdAt?: Date | null },
  items: ReadonlyArray<{ productId: string | null; qty: number; unitFactor?: number | null; baseQty?: number | null; returnExpired?: boolean | null }>,
  mode: 'CANCEL' | 'RESTOCK_OFF',
  skip?: ReadonlySet<string>,
): ReturnRemoval[] {
  const acc = new Map<string, ReturnRemoval>();
  for (const it of items) {
    if (!it.productId || skip?.has(it.productId)) continue;
    const bucket = returnItemBucket(inv, it);
    if (!bucket || (mode === 'RESTOCK_OFF' && bucket !== 'sellable')) continue;
    const key = `${it.productId}|${bucket}`;
    const row = acc.get(key) ?? { productId: it.productId, bucket, base: 0 };
    row.base += baseQtyOf({ qty: Number(it.qty), unitFactor: it.unitFactor ?? null, baseQty: it.baseQty ?? null });
    acc.set(key, row);
  }
  return [...acc.values()].filter((r) => r.base > EPS);
}

/** السطور التي يصير بها الدلو سالباً بعد السحب (نقيّ) — الرصيد قبل التغيير من `buckets` والمرتجع ما زال فيها */
export function returnCancelShortLines(buckets: ReadonlyMap<string, StockBucket>, removals: readonly ReturnRemoval[]): ReturnCancelShortLine[] {
  const out: ReturnCancelShortLine[] = [];
  for (const r of removals) {
    const available = bucketBalance(buckets.get(r.productId), r.bucket);
    if (available - r.base < -EPS) out.push({ productId: r.productId, availableBase: round4(available), requiredBase: round4(r.base), bucket: r.bucket });
  }
  return out;
}

const BUCKET_AR: Record<VanBucket, string> = { sellable: 'المتاح للبيع', expired: 'منتهي الصلاحية', damaged: 'التالف' };

/** رفض السحب: بضاعة المرتجع خرجت من السيارة (بيعت أو أُزيلت) — يحوّله المسار إلى 409 */
export class ReturnCancelStockShort extends Error {
  constructor(readonly lines: ReturnCancelShortLine[], readonly names: ReadonlyMap<string, string>) {
    super(RETURN_CANCEL_STOCK_SHORT);
  }

  body() {
    const fmt = (n: number) => String(Number(n.toFixed(4)));
    // كل الأصناف القاصرة لا أوّلها وحده (المراجعة UX9): شاشةٌ لا تعرف أسماء الأصناف تعرض هذه الرسالة كما هي
    const each = this.lines.map((l) =>
      `«${this.names.get(l.productId) || 'الصنف'}» (${BUCKET_AR[l.bucket]}): الموجود ${fmt(l.availableBase)} والمطلوب سحبه ${fmt(l.requiredBase)}`);
    return {
      success: false as const,
      code: RETURN_CANCEL_STOCK_SHORT,
      message: each.length
        ? `بضاعة هذا المرتجع خرجت من سيارة المندوب — سيصبح الرصيد سالباً في ${each.join('، ')} بوحدة الأساس. سجّل تحميلاً أو تسوية للسيارة أولاً`
        : 'بضاعة هذا المرتجع خرجت من سيارة المندوب — لا يمكن سحبها',
      lines: this.lines,
    };
  }
}

/**
 * حارس D10 داخل المعاملة — بعد أن يقفل المستدعي صفّ الفاتورة (فقراءة عودتها وسببها هنا هي الحاكمة): قفل دلاء السيارة التي
 * يمسّها السحب ثم الرصيد تحتها — يرمي ReturnCancelStockShort إن صار دلوٌ سالباً. المرتجع ما زال CONFIRMED بقيمته القديمة حين
 * يُنادى (قبل الكتابة). غير مرتجع، أو ملغى، أو بلا مندوبٍ (محذوف)، أو بلا سحبٍ: لا شيء.
 */
export async function assertReturnRemovalKeepsVan(
  tx: VanStockDb & Pick<Prisma.TransactionClient, '$executeRaw' | 'product' | 'invoice'>,
  tenantId: string,
  invoiceId: string,
  mode: 'CANCEL' | 'RESTOCK_OFF',
  skip?: ReadonlySet<string>,
): Promise<void> {
  const inv = await tx.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    select: { type: true, status: true, salesRepId: true, returnToStock: true, returnReason: true, createdAt: true },
  });
  if (!inv || inv.type !== 'RETURN' || inv.status !== 'CONFIRMED' || !inv.salesRepId) return;
  const items = await tx.invoiceItem.findMany({
    where: { invoiceId },
    select: { productId: true, qty: true, unitFactor: true, baseQty: true, returnExpired: true },
  });
  const removals = returnRemovals(inv, items ?? [], mode, skip);
  if (!removals.length) return;
  await lockVanBuckets(tx, inv.salesRepId, removals.map((r) => r.bucket));
  const buckets = await vanBucketsFor(tx, tenantId, inv.salesRepId, removals.map((r) => r.productId));
  const short = returnCancelShortLines(buckets, removals);
  if (!short.length) return;
  const names = await tx.product.findMany({ where: { id: { in: short.map((s) => s.productId) }, tenantId }, select: { id: true, name: true } });
  throw new ReturnCancelStockShort(short, new Map((names ?? []).map((p) => [p.id, p.name])));
}

/**
 * إلغاء مرتجعٍ فيه أصنافٌ متتبَّعة: دلوا المنتهي والتالف لبنوده غير المتتبَّعة **قبل** حارس اللوط (أقفال أصنافه) — بترتيب إزالة
 * المنتهي/التالف نفسه (الدلو ثم الأصناف)، وإلا تعاكس القفلان مع EXPIRED_OUT/DAMAGED_OUT متزامن (40P01). المتاح لا يُقفل هنا:
 * البيع يأخذه بعد أقفال اللوط. assertReturnRemovalKeepsVan يعيد أخذها لاحقاً (القفل الاستشاريّ متكرّرٌ في الجلسة نفسها).
 */
export async function preLockReturnOutBuckets(
  tx: Pick<Prisma.TransactionClient, '$executeRaw' | 'invoice' | 'invoiceItem'>,
  tenantId: string,
  invoiceId: string,
  skip?: ReadonlySet<string>,
): Promise<void> {
  const inv = await tx.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    select: { type: true, status: true, salesRepId: true, returnToStock: true, returnReason: true, createdAt: true },
  });
  if (!inv || inv.type !== 'RETURN' || inv.status !== 'CONFIRMED' || !inv.salesRepId) return;
  const items = await tx.invoiceItem.findMany({
    where: { invoiceId },
    select: { productId: true, qty: true, unitFactor: true, baseQty: true, returnExpired: true },
  });
  const out = returnRemovals(inv, items ?? [], 'CANCEL', skip).map((r) => r.bucket).filter((b) => b !== 'sellable');
  if (out.length) await lockVanBuckets(tx, inv.salesRepId, out);
}

/**
 * إشعار إدارة واحد لكل clientRef لفاتورةٍ دون اتصال حُجزت بعجز السيارة (D5) — بنمط LOT_REPLAY_HELD. خارج المعاملة ولا يرمي.
 */
export async function recordVanStockHeld(db: Pick<Prisma.TransactionClient, 'notification'>, input: {
  tenantId: string; clientRef: string; salesRepId: string | null; customerId: string | null; productName?: string | null; detail?: unknown;
}): Promise<void> {
  try {
    const prior = await db.notification.findFirst({
      where: { tenantId: input.tenantId, type: VAN_STOCK_REPLAY_HELD, data: { contains: input.clientRef } },
      select: { id: true },
    });
    if (prior) return;
    const what = input.productName ? ` من «${input.productName}»` : '';
    await db.notification.create({
      data: {
        tenantId: input.tenantId,
        type: VAN_STOCK_REPLAY_HELD,
        title: 'فاتورة دون اتصال بانتظار تحميل ناقص',
        body: `فاتورة دون اتصال تتجاوز مخزون سيارة المندوب${what} — محجوزة في جهازه حتى تسجّل الإدارة التحميل الناقص`,
        salesRepId: input.salesRepId,
        customerId: input.customerId,
        data: JSON.stringify({ clientRef: input.clientRef, detail: input.detail ?? null }),
      },
    });
  } catch (e) {
    console.error('van stock replay-held notice failed:', input.clientRef, (e as Error)?.message);
  }
}
