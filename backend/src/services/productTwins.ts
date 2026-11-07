/**
 * «التوائم المؤرشفة» — أداة لمالك المنصة وحده (routes/ownerPurge.ts) لعلاج أثرٍ قديم في مخزون السيارات.
 *
 * قبل ٥ نوفمبر ٢٠٢٦ كان حذف صنفٍ له تحميلات أو فواتير **يؤرشفه** فقط (Product.deletedAt، الحالة INACTIVE) ويُبقي كوده محجوزاً،
 * فأعاد المديرون إنشاء «الصنف نفسه» باسمه وبكودٍ جديد. فبقي المؤرشف (A) يحمل رصيد التحميلات (VanLoadItem.productId = A) ويظهر
 * في مخزون السيارة (computeStock لا يرشّح الأرشفة)، بينما يبيع المناديب الجديد القائم (B) — فيظهر صفّان بالاسم نفسه: A محمَّلٌ لا
 * ينقص، وB سالب. ومنذ c666089 الحذف حقيقي فلا أرشيف جديد، لكن التوائم القديمة باقية في الشركات.
 *
 * العلاج:
 * - findArchivedProducts: الأصناف المؤرشفة للشركة، ولكلٍّ توأمه القائم المقترح (الاسم المطبَّع ووحدة الأساس نفسها)، ورصيده
 *   الباقي في السيارات (بـfoldStock وbucketRemaining **نفسيهما** عبر مجاميع lotsDb)، وعدد حركاته.
 * - mergeArchivedProduct: **الدمج** داخل معاملةٍ واحدة — كل صفّ تاريخٍ أو حركةٍ يشير إلى A يُعاد توجيهه إلى B (فيصير رصيد A
 *   المحمَّل رصيدَ B ويزول سالبه)، ثم يُحذف A حذفاً حقيقياً بمحرّك الحذف النهائي (purgeInTx) مع ما بقي له من **إعداد** (وحداته
 *   وأسعاره وقواعد قوائم الأسعار وفرقه). صفوف الحركات لا تشير إلى وحدات الصنف بمفتاح (تحمل لقطة الوحدة: unitName/unitFactor/
 *   baseQty) فلا يلزم ربط وحدات A بوحدات B، والكميات تبقى صادقة بالأساس.
 * - الصنف المؤرشف بلا توأم يُحذف حذفاً حقيقياً بالمسار القائم POST /api/owner-purge/delete (model 'Product').
 */
import { Prisma } from '@prisma/client';
import { bucketRemaining, foldStock } from '../routes/vanStock';
import { aggVanTotals, LOT_LOCK_TIMEOUT, vanTotalsFromAgg } from './lotsDb';
import { delegateOf, purgeInTx, type PurgeResult } from './ownerPurge';
import { productNameKey } from './productNames';
import { baseQtyOf, roundQty, toBase } from './units';

type Tx = Prisma.TransactionClient;
type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];

// ═══ التطبيع والتوأم ═══

/** مفتاح مقارنة الاسم: قصّ الأطراف ودمج المسافات الداخلية وأحرف لاتينية صغيرة (productNameKey نفسه — تحذير الاسم المكرَّر) */
export function normalizeName(s: string | null | undefined): string {
  return productNameKey(s);
}

/** مفتاح مقارنة وحدة الأساس (Product.unit) — التطبيع نفسه */
export function normalizeUnit(s: string | null | undefined): string {
  return productNameKey(s);
}

export type TwinReason = 'NAME' | 'NONE' | 'AMBIGUOUS' | 'UNIT_MISMATCH';
export interface TwinRef { id: string; code: string; name: string; unit: string }
export interface ProductLite { id: string; code: string; name: string; unit: string; status?: string | null }

const refOf = (p: ProductLite): TwinRef => ({ id: p.id, code: p.code, name: p.name, unit: p.unit });

/** فهرس الأصناف القائمة (deletedAt فارغ) بالاسم المطبَّع */
export function indexByName(actives: readonly ProductLite[]): Map<string, ProductLite[]> {
  const out = new Map<string, ProductLite[]>();
  for (const p of actives) {
    const k = normalizeName(p.name);
    if (!k) continue;
    const list = out.get(k);
    if (list) list.push(p); else out.set(k, [p]);
  }
  return out;
}

/**
 * توأم الصنف المؤرشف: الصنف القائم **الوحيد** في الشركة الذي يطابق اسمه المطبَّع اسمَ A ووحدةُ أساسه المطبَّعة وحدتَه.
 * لا تطابق اسم ⇒ NONE. تطابق اسمٍ بوحدةٍ أخرى وحدها ⇒ UNIT_MISMATCH. أكثر من واحدٍ بالوحدة نفسها ⇒ يُفضَّل الواحد بحالة ACTIVE
 * (الموقوف غالباً توأمٌ قديم آخر)، وإلا AMBIGUOUS. والمالك يؤكّد كل دمجٍ بنفسه — الاقتراح لا يدمج شيئاً.
 */
export function detectTwin(a: ProductLite, index: Map<string, ProductLite[]>): { twin: TwinRef | null; twinReason: TwinReason } {
  const key = normalizeName(a.name);
  const cands = key ? (index.get(key) ?? []).filter((p) => p.id !== a.id) : [];
  if (!cands.length) return { twin: null, twinReason: 'NONE' };
  const unit = normalizeUnit(a.unit);
  let same = cands.filter((p) => normalizeUnit(p.unit) === unit);
  if (!same.length) return { twin: null, twinReason: 'UNIT_MISMATCH' };
  if (same.length > 1) {
    const active = same.filter((p) => (p.status ?? 'ACTIVE') === 'ACTIVE');
    if (active.length === 1) same = active;
  }
  if (same.length !== 1) return { twin: null, twinReason: 'AMBIGUOUS' };
  return { twin: refOf(same[0]), twinReason: 'NAME' };
}

// ═══ قائمة المؤرشفة ═══

export interface ArchivedVan { salesRepId: string; repName: string | null; remaining: number }
export interface ArchivedProductRow {
  id: string; code: string; name: string; unit: string; deletedAt: Date;
  twin: TwinRef | null; twinReason: TwinReason;
  /** مجموع المتاح الباقي من A (بالأساس) في كل السيارات */
  vanBalance: number;
  vans: ArchivedVan[];
  counts: { invoiceItems: number; vanLoadItems: number; warehouseEntryItems: number };
}

/** صنف ⇒ (مندوب ⇒ المتاح الباقي بالأساس) */
export type VanBalances = Map<string, Map<string, number>>;
export type VanBalancesFn = (db: Tx, tenantId: string, productIds: string[], repIds: string[]) => Promise<VanBalances>;

/** «له رصيد»: أصغر من أصغر كسرٍ ذي معنى ولا يبتلع حبّة */
const BAL_EPS = 1e-9;

/**
 * رصيد الأصناف في سيارات المناديب القائمين بمرشّحات computeStock نفسها (aggVanTotals) مطويّةً بـfoldStock وbucketRemaining
 * **نفسيهما** (vanTotalsFromAgg) — المتاح للبيع (SELLABLE) كعمود «المتبقّي» في مخزون السيارة.
 */
export const dbVanBalances: VanBalancesFn = async (db, tenantId, productIds, repIds) => {
  const out: VanBalances = new Map();
  if (!productIds.length || !repIds.length) return out;
  const { loads, invs } = await aggVanTotals(db, tenantId, { vanKeys: repIds, productIds });
  const byVan = vanTotalsFromAgg(loads, invs, { foldStock, bucketRemaining });
  for (const [rep, m] of byVan) {
    for (const [pid, b] of m) {
      let per = out.get(pid);
      if (!per) { per = new Map(); out.set(pid, per); }
      per.set(rep, b.SELLABLE);
    }
  }
  return out;
};

/** عدد الصفوف لكل صنف من نتيجة groupBy */
const countsOf = (rows: Array<{ productId: string | null; _count: { _all: number } }>): Map<string, number> =>
  new Map(rows.filter((r) => r.productId).map((r) => [String(r.productId), Number(r._count?._all) || 0]));

/**
 * حمولة GET /api/owner-purge/archived-products: الأصناف المؤرشفة للشركة مع توأمها المقترح ورصيدها في السيارات وعدد حركاتها.
 * الترتيب: الأكبر رصيداً (بالقيمة المطلقة) أولاً ثم بالاسم. قراءةٌ فقط.
 */
export async function findArchivedProducts(db: Tx, tenantId: string, deps: { vanBalances?: VanBalancesFn } = {}): Promise<ArchivedProductRow[]> {
  const archived = await db.product.findMany({
    where: { tenantId, deletedAt: { not: null } },
    select: { id: true, code: true, name: true, unit: true, deletedAt: true },
  });
  if (!archived.length) return [];
  const actives = await db.product.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true, code: true, name: true, unit: true, status: true },
  });
  const ids = archived.map((a) => a.id);
  const reps = await db.salesRep.findMany({ where: { tenantId }, select: { id: true, name: true } });
  const repName = new Map(reps.map((r) => [r.id, r.name]));

  const where = { productId: { in: ids } };
  const [inv, van, wh] = await Promise.all([
    db.invoiceItem.groupBy({ by: ['productId'], where, _count: { _all: true } }),
    db.vanLoadItem.groupBy({ by: ['productId'], where, _count: { _all: true } }),
    db.warehouseEntryItem.groupBy({ by: ['productId'], where, _count: { _all: true } }),
  ]);
  const invN = countsOf(inv as never);
  const vanN = countsOf(van as never);
  const whN = countsOf(wh as never);
  const balances = await (deps.vanBalances ?? dbVanBalances)(db, tenantId, ids, reps.map((r) => r.id));

  const index = indexByName(actives);
  const rows: ArchivedProductRow[] = archived.map((a) => {
    const vans: ArchivedVan[] = [...(balances.get(a.id) ?? new Map<string, number>())]
      .filter(([, q]) => Math.abs(q) > BAL_EPS)
      .map(([salesRepId, q]) => ({ salesRepId, repName: repName.get(salesRepId) ?? null, remaining: roundQty(q) }))
      .sort((x, y) => y.remaining - x.remaining);
    const { twin, twinReason } = detectTwin(a, index);
    return {
      id: a.id, code: a.code, name: a.name, unit: a.unit, deletedAt: a.deletedAt as Date,
      twin, twinReason,
      vanBalance: roundQty(vans.reduce((s, v) => s + v.remaining, 0)),
      vans,
      counts: { invoiceItems: invN.get(a.id) ?? 0, vanLoadItems: vanN.get(a.id) ?? 0, warehouseEntryItems: whN.get(a.id) ?? 0 },
    };
  });
  rows.sort((x, y) => Math.abs(y.vanBalance) - Math.abs(x.vanBalance) || x.name.localeCompare(y.name, 'ar'));
  return rows;
}

// ═══ خطة الدمج: أي الجداول يُعاد توجيهها وأيها يُحذف مع A ═══

/**
 * جداول **الإعداد**: معنى صفّها «إعداد هذا الصنف» لا حدثٌ وقع — تُحذف مع A (purgeInTx) ولا تُنقل إلى B، فلـB إعداده
 * (وحداته وأسعاره وشرائحه وأسعار عملائه وبنود وقواعد قوائم الأسعار وفرقه وسجلّ تحويل أساسه).
 */
export const CONFIG_MODELS: ReadonlySet<string> = new Set([
  'ProductUnit', 'ProductBaseConversion', 'PriceTier', 'CustomerPrice', 'PriceListItem', 'PriceListRule', 'ProductTeam',
]);

/**
 * جداول تاريخٍ لها قيدٌ فريد يشمل productId — تُعالَج قبل إعادة التوجيه:
 * - ProductLot (tenantId, productId, lotNumber): تشغيلةٌ بالرقم نفسه في الصنفين ⇒ يُرفض الدمج LOTS_CONFLICT.
 * - RepStockRequestItem (requestId, productId): الصنفان في طلب بضاعةٍ واحد ⇒ يُجمع سطر A في سطر B ثم يُحذف (combineRequestItems).
 */
export const SPECIAL_MODELS: Readonly<Record<string, 'LOTS' | 'REQUEST_ITEMS'>> = { ProductLot: 'LOTS', RepStockRequestItem: 'REQUEST_ITEMS' };

export interface RepointTarget {
  model: string;
  field: string;
  /** FK: مفتاح أجنبي إلى Product؛ PLAIN: نصٌّ بلا مفتاح (جداول اللوط وأسطر القيود) */
  kind: 'FK' | 'PLAIN';
  /** للجدول عمود tenantId فيُقيَّد به التحديث أيضاً */
  tenantScoped: boolean;
  special: 'LOTS' | 'REQUEST_ITEMS' | null;
}
export interface MergePlanModels {
  /** يُعاد توجيه productId فيها من A إلى B */
  repoint: RepointTarget[];
  /** جداول إعدادٍ تشير إلى Product — تُحذف صفوف A فيها مع A */
  deleteWith: string[];
  /** جداول تاريخٍ بقيدٍ فريدٍ على productId بلا معالجة — الدمج يُرفض حتى تُعالَج (حارس تغيّر المخطط) */
  unhandled: string[];
}

const hasScalar = (m: DmmfModel, name: string) => m.fields.some((f) => f.name === name && f.kind === 'scalar');

/**
 * يشتقّ خطة الجداول من نموذج Prisma نفسه (Prisma.dmmf) — بلا قائمة يدوية تتقادم: كل علاقةٍ إلى Product (FK بحقلٍ واحد)، وكل
 * عمود productId نصّيٍّ بلا علاقة. ما ليس إعداداً تاريخٌ يُعاد توجيهه (الافتراض يحفظ التاريخ). صرفةٌ فتُختبر وحدها.
 */
export function mergePlanModels(models: readonly DmmfModel[] = Prisma.dmmf.datamodel.models): MergePlanModels {
  const repoint: RepointTarget[] = [];
  const deleteWith: string[] = [];
  const unhandled: string[] = [];
  for (const m of models) {
    if (m.name === 'Product') continue;
    const fkFields = new Set<string>();
    for (const f of m.fields) {
      const from = f.kind === 'object' ? (f.relationFromFields ?? []) : [];
      for (const x of from) fkFields.add(x);
      if (f.kind !== 'object' || f.type !== 'Product' || from.length !== 1) continue;
      if (CONFIG_MODELS.has(m.name)) { if (!deleteWith.includes(m.name)) deleteWith.push(m.name); continue; }
      repoint.push({ model: m.name, field: from[0], kind: 'FK', tenantScoped: hasScalar(m, 'tenantId'), special: SPECIAL_MODELS[m.name] ?? null });
    }
    // productId نصّيٌّ بلا مفتاح أجنبي (مكرَّرٌ في جداول اللوط، وسطر القيد)
    const plain = m.fields.find((f) => f.name === 'productId' && f.kind === 'scalar' && f.type === 'String' && !f.isList);
    if (plain && !fkFields.has('productId')) {
      if (CONFIG_MODELS.has(m.name)) { if (!deleteWith.includes(m.name)) deleteWith.push(m.name); }
      else repoint.push({ model: m.name, field: 'productId', kind: 'PLAIN', tenantScoped: hasScalar(m, 'tenantId'), special: SPECIAL_MODELS[m.name] ?? null });
    }
  }
  for (const t of repoint) {
    const m = models.find((x) => x.name === t.model)!;
    const uniques: ReadonlyArray<ReadonlyArray<string>> = [
      ...((m as { uniqueFields?: ReadonlyArray<ReadonlyArray<string>> }).uniqueFields ?? []),
      ...m.fields.filter((f) => (f as { isUnique?: boolean }).isUnique).map((f) => [f.name]),
    ];
    if (!t.special && uniques.some((u) => u.includes(t.field))) unhandled.push(t.model);
  }
  repoint.sort((a, b) => a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model));
  deleteWith.sort();
  return { repoint, deleteWith, unhandled };
}

// ═══ الدمج ═══

export const MERGE_CODES = Object.freeze({
  SAME_PRODUCT: 'لا يدمج الصنف في نفسه',
  NOT_FOUND: 'الصنف غير موجود في هذه الشركة',
  NOT_ARCHIVED: 'الصنف المصدر ليس صنفا محذوفا مؤرشفا',
  TARGET_ARCHIVED: 'الصنف الهدف محذوف مؤرشف اختر صنفا قائما',
  UNIT_MISMATCH: 'وحدة الأساس مختلفة بين الصنفين فلا يدمجان',
  LOTS_CONFLICT: 'للصنفين تشغيلات بالرقم نفسه فلا يدمجان',
  SCHEMA_UNSUPPORTED: 'جدول حركات جديد بقيد فريد على الصنف لم يعالج بعد',
});
export type MergeCode = keyof typeof MERGE_CODES;

/** رفض دمج زوجٍ برمزه — يذهب إلى failed[] في الردّ ولا يوقف بقية الأزواج */
export class MergeRefused extends Error {
  constructor(readonly code: MergeCode) {
    super(MERGE_CODES[code]);
    this.name = 'MergeRefused';
  }
}

export interface RequestItemRow {
  id: string; requestId: string; qty: number; requestedQty: number;
  unitName: string | null; unitFactor: number | null; baseQty: number | null;
}

/**
 * سطرا طلب بضاعةٍ واحد للصنفين (القيد الفريد requestId+productId): الوحدة نفسها (الاسم المطبَّع والمعامل) ⇒ تُجمع الكميات
 * كما هي؛ وإلا يصير السطر المجموع بوحدة الأساس (unitName فارغ ومعامل ١) فلا تُجمع كرتونات A إلى حبّات B.
 */
export function combineRequestItems(a: RequestItemRow, b: RequestItemRow): { qty: number; requestedQty: number; unitName: string | null; unitFactor: number; baseQty: number } {
  const fa = Number(a.unitFactor) > 0 ? Number(a.unitFactor) : 1;
  const fb = Number(b.unitFactor) > 0 ? Number(b.unitFactor) : 1;
  const baseQty = roundQty(baseQtyOf(a) + baseQtyOf(b));
  if (normalizeUnit(a.unitName) === normalizeUnit(b.unitName) && Math.abs(fa - fb) < 1e-9) {
    return { qty: roundQty(Number(a.qty) + Number(b.qty)), requestedQty: roundQty(Number(a.requestedQty) + Number(b.requestedQty)), unitName: b.unitName, unitFactor: fb, baseQty };
  }
  return {
    qty: baseQty,
    requestedQty: roundQty(toBase(a.requestedQty, a) + toBase(b.requestedQty, b)),
    unitName: null, unitFactor: 1, baseQty,
  };
}

export interface MergeResult {
  /** صفوفٌ أُعيد توجيهها من A إلى B لكل جدول (غير الصفرية) */
  moved: Record<string, number>;
  /** ما حذفه حذف A النهائي (إعداده الباقي وصفّه) */
  deleted: Record<string, number>;
}

type Delegate = {
  findMany(a: unknown): Promise<Array<Record<string, unknown>>>;
  count(a: unknown): Promise<number>;
  updateMany(a: unknown): Promise<{ count: number }>;
  update(a: unknown): Promise<unknown>;
  delete(a: unknown): Promise<unknown>;
};

/**
 * يدمج الصنف المؤرشف `fromId` (A) في الصنف القائم `toId` (B) داخل المعاملة `tx` (المستدعي يفتحها بمهلة ٦٠ ثانية):
 * ١) قفل الصفّين FOR UPDATE بترتيب المعرّف (بمهلة قفلٍ محلية كحذف الصنف) — بندٌ أو حركةٌ أو تشغيلةٌ تُكتب لأيٍّ منهما تنتظر.
 * ٢) التحقق: الصنفان في الشركة، A مؤرشف وB غير مؤرشف (أيّ حالة)، وحدة الأساس المطبَّعة واحدة، ولا تشغيلة بالرقم نفسه.
 * ٣) لقطة اسم A ووحدته في بنود فواتيره بلا لقطة حين يختلف النصّ عن B — فتبقى الفاتورة القديمة بما طُبع عليها.
 * ٤) إعادة توجيه كل جداول التاريخ والحركات (mergePlanModels) — وطلب البضاعة المشترك يُجمع سطراه.
 * ٥) حذف A حذفاً حقيقياً (purgeInTx) مع إعداده الباقي.
 */
export async function mergeArchivedProduct(
  tx: Tx, tenantId: string, fromId: string, toId: string,
  deps: { purge?: (tx: Tx, tenantId: string, model: string, ids: string[]) => Promise<PurgeResult> } = {},
): Promise<MergeResult> {
  if (fromId === toId) throw new MergeRefused('SAME_PRODUCT');
  const plan = mergePlanModels();
  if (plan.unhandled.length) throw new MergeRefused('SCHEMA_UNSUPPORTED');

  // ١) القفل — بترتيب المعرّف فلا يتقاطع دمجان على الصنفين نفسيهما بترتيبين
  const ids = [fromId, toId].sort();
  const prev = await tx.$queryRaw<{ lock_timeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOT_LOCK_TIMEOUT}, true)`;
  await tx.$queryRaw`SELECT id FROM products WHERE id IN (${Prisma.join(ids)}) AND "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${prev?.[0]?.lock_timeout ?? '0'}, true)`;

  // ٢) التحقق على الصفّين المقفلين
  const rows = await tx.product.findMany({
    where: { id: { in: ids }, tenantId },
    select: { id: true, name: true, unit: true, deletedAt: true },
  });
  const a = rows.find((r) => r.id === fromId);
  const b = rows.find((r) => r.id === toId);
  if (!a || !b) throw new MergeRefused('NOT_FOUND');
  if (a.deletedAt == null) throw new MergeRefused('NOT_ARCHIVED');
  if (b.deletedAt != null) throw new MergeRefused('TARGET_ARCHIVED');
  if (normalizeUnit(a.unit) !== normalizeUnit(b.unit)) throw new MergeRefused('UNIT_MISMATCH');

  const d = tx as unknown as Record<string, Delegate>;
  if (plan.repoint.some((t) => t.special === 'LOTS')) {
    const aLots = await d.productLot.findMany({ where: { tenantId, productId: fromId }, select: { lotNumber: true } });
    if (aLots.length) {
      const clash = await d.productLot.count({ where: { tenantId, productId: toId, lotNumber: { in: aLots.map((l) => l.lotNumber) } } });
      if (clash) throw new MergeRefused('LOTS_CONFLICT');
    }
  }

  // ٣) لقطة الاسم والوحدة كما طُبعت — حين يختلف النصّ وحده (التطبيع واحد)
  if (a.name !== b.name) await tx.invoiceItem.updateMany({ where: { productId: fromId, itemName: null }, data: { itemName: a.name } });
  if (a.unit && a.unit !== b.unit) await tx.invoiceItem.updateMany({ where: { productId: fromId, unitName: null }, data: { unitName: a.unit } });

  const moved: Record<string, number> = {};
  const add = (model: string, n: number) => { if (n) moved[model] = (moved[model] ?? 0) + n; };

  // ٤) طلب بضاعةٍ فيه الصنفان معاً: سطر A يُجمع في سطر B ثم يُحذف (قبل إعادة التوجيه — القيد الفريد)
  if (plan.repoint.some((t) => t.special === 'REQUEST_ITEMS')) {
    const sel = { id: true, requestId: true, qty: true, requestedQty: true, unitName: true, unitFactor: true, baseQty: true };
    const aItems = (await d.repStockRequestItem.findMany({ where: { productId: fromId }, select: sel })) as unknown as RequestItemRow[];
    if (aItems.length) {
      const bItems = (await d.repStockRequestItem.findMany({
        where: { productId: toId, requestId: { in: aItems.map((x) => x.requestId) } }, select: sel,
      })) as unknown as RequestItemRow[];
      const bByReq = new Map(bItems.map((x) => [x.requestId, x]));
      for (const it of aItems) {
        const other = bByReq.get(it.requestId);
        if (!other) continue;
        await d.repStockRequestItem.update({ where: { id: other.id }, data: combineRequestItems(it, other) });
        await d.repStockRequestItem.delete({ where: { id: it.id } });
        add('RepStockRequestItem', 1);
      }
    }
  }

  for (const t of plan.repoint) {
    const r = await d[delegateOf(t.model)].updateMany({
      where: { [t.field]: fromId, ...(t.tenantScoped && { tenantId }) },
      data: { [t.field]: toId },
    });
    add(t.model, Number(r?.count) || 0);
  }

  // ٥) A بلا تاريخ الآن: حذفٌ حقيقي بمحرّك الحذف النهائي (إعداده الباقي وصفّه)
  const purged = await (deps.purge ?? purgeInTx)(tx, tenantId, 'Product', [fromId]);
  return { moved, deleted: purged.counts };
}
