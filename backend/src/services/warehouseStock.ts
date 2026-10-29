// ============================================================================
// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات.
// ----------------------------------------------------------------------------
// الرصيد لكل منتج =
//     الوارد (RECEIVE) + تسويات المستودع (ADJUST)
//   + العائد من السيارات (VanLoad UNLOAD)
//   − المحمّل للسيارات   (VanLoad LOAD)
// تسوية السيارة (VanLoad ADJUST) حركةٌ داخل السيارة لا تمسّ المستودع.
// والعائد يدخل بالكلفة التي خرج بها لا بمتوسّط لحظة عودته، وبكلفة **سيارته هو**
// لا كلفة حمولة زميله — انظر `valueStock`.
//
// الوحدات المتعددة: كل كميةٍ هنا **بوحدة الأساس** وكل تكلفةٍ **لوحدة الأساس**. التحويل
// يقع مرّةً واحدة عند حدّ القراءة (`loadWarehouseInputs`: baseQtyOf وunitCostPerBase)،
// فيبقى الحساب النقيّ (composeWarehouse/valueStock) صرفاً بالأساس واختباراته صالحة.
// ============================================================================
import prisma from '../config/database';
import { currencyDecimalsOf } from '../config/countries';
import { roundDecimal } from '../utils/helpers';
import { valueStock, valueVanQty, unitCostPerBase, CostMove, VanLayer, DEFAULT_CURRENCY_DECIMALS } from './warehouseCost';
import { baseQtyOf, factorOf, type UnitDef } from './units';

export interface WarehouseRow {
  productId: string;
  name: string;
  code: string;
  /** وحدة الأساس — كل كميات الصفّ بها */
  unit: string;
  /** وحدات الصنف بمعاملاتها — لعرض الرصيد «٢ كرتون و٣ حبة» (formatQty) لا لحسابه */
  units?: UnitDef[];
  received: number;        // الوارد للمستودع
  adjusted: number;        // تسويات المستودع (+/−)
  loadedToVans: number;    // خرج للسيارات
  returnedFromVans: number; // عاد من السيارات (UNLOAD)
  onHand: number;          // الرصيد المتبقّي في المستودع
  // ═══ التقييم بتكلفة الشراء ═══
  avgCost: number;         // متوسّط تكلفة **وحدة الأساس** المرجّح (من الوارد المسعّر وحده) — لا الكرتون
  stockValue: number;      // قيمة الرصيد = الكمّية المقيَّمة × متوسّطها
  costedQty: number;       // كمية من الرصيد تكلفتها معروفة (هي وحدها المقيَّمة)
  uncostedQty: number;     // كمية من الرصيد بلا تكلفة معروفة — خارج القيمة صراحةً
}

/** حقول وحدات الصنف كما يحتاجها العرض (formatQty) — النشطة والموقوفة معاً، وformatQty يُسقط الموقوفة */
export const UNIT_SELECT = { id: true, name: true, factor: true, isActive: true } as const;

interface ProdMeta { id: string; name: string; code: string; unit: string; status?: string; units?: UnitDef[] }
// `at` لحظة الحركة — التقييم متوسّطٌ متحرّك فترتيبه الزمنيّ جزءٌ من صحّته:
// المرور غير المرتَّب يعطي متوسّطاً خاطئاً بصمت. اختياريّ لتبقى الاختبارات
// النقيّة تمرّر ترتيبها بترتيب المصفوفة.
// والكمية **بالأساس** والتكلفة **لوحدة الأساس** — `loadWarehouseInputs` يحوّلهما من صفّ القاعدة.
interface WhItem { productId: string; qty: number; type: string; unitCost?: number | null; at?: Date | string | number }
interface VanItem { productId: string; qty: number; type: string; salesRepId?: string | null; at?: Date | string | number }

/**
 * مفتاح «السيارة» لحركة تحميل: مندوبها، أو معرّفه المحفوظ بعد حذفه.
 *
 * حذف المندوب يُفرّغ `salesRepId` ولا يمحو الحركة (الحذف كان يمحوها فيقفز
 * المستودع بكل ما حُمِّل وبيع). والكمّية لا تحتاج المفتاح أصلاً — LOAD وUNLOAD
 * يُحسبان أيّاً كان مندوبهما — لكن **التقييم** يحتاجه: طبقات كل سيارة مكدّسٌ
 * مستقلّ، ومندوبان محذوفان بلا مفتاح يقعان في مكدّسٍ واحد فيعود تنزيلُ أحدهما
 * بكلفة حمولة الآخر وتتغيّر قيمة المستودع بمجرّد الحذف.
 */
export function vanKeyOf(l: { salesRepId: string | null; deletedSalesRepId?: string | null }): string | null {
  return l.salesRepId ?? l.deletedSalesRepId ?? null;
}

/**
 * دالّة نقيّة (بلا قاعدة بيانات) — تُختبَر وحدها. تُظهر كل المنتجات المُمرَّرة.
 *
 * @param decimals خانات عملة الشركة لتقريب **قيمة الرصيد** لكل صنف. اختياريّ
 *   بافتراض خانتين كي لا ينكسر مستدعٍ لم يُحدَّث، لكنّ كل مستدعٍ إنتاجيّ يمرّرها:
 *   شركةٌ بالدينار (ثلاث خانات) كانت تفقد الخانة الثالثة في **كل صنف** — ألفُ
 *   صنفٍ بقيمة ٠٫١٢٣٥ تعطي ١٢٠ بخانتين و١٢٤ بثلاث، وأربعةُ دنانير تضيع من
 *   القيد الافتتاحيّ وشاشة المخزون معاً. والرقم يأتي من خانات عملة الشركة
 *   (`tenantCurrencyDecimals` أدناه) لا من تخمين.
 */
export function composeWarehouse(
  products: ProdMeta[],
  warehouseItems: WhItem[],
  vanItems: VanItem[],
  decimals: number = DEFAULT_CURRENCY_DECIMALS,
  /** يُملأ بطبقات كل سيارة لكل صنف (صنف ← سيارة ← طبقات) — لتقييم ما في السيارات */
  layersOut?: Map<string, Map<string, VanLayer[]>>,
): WarehouseRow[] {
  const acc = new Map<string, { received: number; adjusted: number; loadedToVans: number; returnedFromVans: number }>();
  const ensure = (pid: string) => {
    if (!acc.has(pid)) acc.set(pid, { received: 0, adjusted: 0, loadedToVans: 0, returnedFromVans: 0 });
    return acc.get(pid)!;
  };
  // حركات التقييم لكل منتج، بإشارتها الصحيحة (موجب يدخل، سالب يخرج).
  // تُجمع من المصدرين معاً ثم تُرتَّب زمنياً — انظر `valueStock`.
  const moves = new Map<string, (CostMove & { t: number; i: number })[]>();
  let seq = 0;
  const ms = (v?: Date | string | number) => {
    if (v == null) return 0;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const push = (pid: string, mv: CostMove, at?: Date | string | number) => {
    const list = moves.get(pid) || [];
    list.push({ ...mv, t: ms(at), i: seq++ });
    moves.set(pid, list);
  };

  for (const it of warehouseItems) {
    const m = ensure(it.productId);
    if (it.type === 'RECEIVE') {
      m.received += it.qty;
      push(it.productId, { qty: it.qty, kind: 'RECEIVE', unitCost: it.unitCost }, it.at);
    } else {
      m.adjusted += it.qty; // ADJUST — جردٌ أو تالف، بلا ثمن
      push(it.productId, { qty: it.qty, kind: 'OTHER' }, it.at);
    }
  }
  for (const it of vanItems) {
    if (it.type === 'LOAD') {
      ensure(it.productId).loadedToVans += it.qty;
      push(it.productId, { qty: -it.qty, kind: 'VAN_OUT', vanId: it.salesRepId }, it.at); // خروجٌ بكلفة اللحظة
    } else if (it.type === 'UNLOAD') {
      ensure(it.productId).returnedFromVans += it.qty;
      push(it.productId, { qty: it.qty, kind: 'VAN_IN', vanId: it.salesRepId }, it.at);  // عودةٌ بكلفة خروجها
    }
    // ADJUST للسيارة لا يمسّ المستودع
  }
  const rows: WarehouseRow[] = products.map((p) => {
    const m = acc.get(p.id) || { received: 0, adjusted: 0, loadedToVans: 0, returnedFromVans: 0 };
    const onHand = roundDecimal(m.received + m.adjusted + m.returnedFromVans - m.loadedToVans, 4);
    // الترتيب زمنيّ، وعند تساوي اللحظة يُحفظ ترتيب الورود (فرزٌ مستقرّ)
    const mv = (moves.get(p.id) || []).slice().sort((x, y) => x.t - y.t || x.i - y.i);
    const out: { vanLayers?: Map<string, VanLayer[]> } | undefined = layersOut ? {} : undefined;
    const val = valueStock(mv, decimals, out);
    if (layersOut && out?.vanLayers) layersOut.set(p.id, out.vanLayers);
    return {
      productId: p.id, name: p.name, code: p.code, unit: p.unit, ...(p.units && { units: p.units }), ...m, onHand,
      avgCost: val.avgCost,
      stockValue: val.stockValue,
      costedQty: val.costedQty,
      uncostedQty: val.uncostedQty,
    };
  });
  rows.sort((a, b) => b.onHand - a.onHand);
  return rows;
}

/** أقصى خانات عملة تقبلها الدفاتر (services/gl/money.ts) — ما جاوزها إعدادٌ فاسد */
const MAX_LEDGER_DECIMALS = 3;

/**
 * خانات عملة الشركة من **مصدرها الحقيقيّ**، بنفس أسبقية `importLedgerContext`
 * في `routes/import.ts`: خانات الدفاتر إن كانت مضبوطةً وصالحة، وإلّا فمن عملة
 * الشركة عبر `currencyDecimalsOf` (ثلاثٌ للدينار الكويتيّ والبحرينيّ والعمانيّ
 * والأردنيّ، وصفرٌ للدينار العراقيّ، وخانتان للريال).
 *
 * تُقرأ **مرّة واحدة لكل طلب** ثم تُمرَّر إلى الحساب: لا داخل حلقة الأصناف، ولا
 * داخل معاملةٍ تمسك قفل `gl-post` — فالقيد الافتتاحيّ يأخذ خاناته من
 * `opts.decimals` المقروءة قبل المعاملة (`services/gl/opening.ts`) لا من هنا.
 */
export async function tenantCurrencyDecimals(tid: string): Promise<number> {
  const s = await prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { currencyDecimals: true } });
  const d = s?.currencyDecimals;
  if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= MAX_LEDGER_DECIMALS) return d;
  const company = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { currency: true } });
  return currencyDecimalsOf(company?.currency);
}

/**
 * غلاف قاعدة البيانات: يجمع منتجات الشركة ووارد المستودع وحركات السيارات ثم يحسب.
 *
 * @param decimals خانات العملة حين يكون المسار قد قرأها أصلاً. وحين تُترك،
 *   تُقرأ هنا مرّةً واحدة ضمن نفس دفعة القراءات (لا استعلامٌ إضافيّ متسلسل).
 *   و`??` لا `||` عمداً: صفرُ خاناتٍ عملةٌ صحيحة (الدينار العراقيّ) لا غياب.
 */
export async function computeWarehouseStock(tid: string, decimals?: number, before?: Date): Promise<WarehouseRow[]> {
  const [dec, { products, whItems, vanItems }] = await Promise.all([
    decimals ?? tenantCurrencyDecimals(tid),
    loadWarehouseInputs(tid, { before, includeInactive: true }),
  ]);
  const inactive = new Set(products.filter((p) => p.status === 'INACTIVE').map((p) => p.id));
  return visibleWarehouseRows(composeWarehouse(products, whItems, vanItems, dec), inactive);
}

/**
 * الصنف المعطّل (أو المؤرشف بحذفه) يُقيَّم ما دام له رصيدٌ أو قيمة — في الحاضر وفي «المخزون في تاريخ» معاً — ويُخفى صفّه
 * حين لا شيء له. بدونه كانت قيمة المستودع تُسقط بضاعته (وبطاقة السيارات تعدّها)، وتتغيّر قيمة يومٍ مضى بتعطيلٍ لاحق.
 */
export function visibleWarehouseRows(rows: WarehouseRow[], inactive: ReadonlySet<string>): WarehouseRow[] {
  if (!inactive.size) return rows;
  return rows.filter((r) => !inactive.has(r.productId)
    || Math.abs(r.onHand) > 1e-9 || Math.abs(r.stockValue) > 1e-9 || r.uncostedQty > 1e-9);
}

/**
 * مدخلات تقييم المستودع للشركة: الأصناف وحركات المستودع وحركات السيارات (كل الأنواع — composeWarehouse يأخذ LOAD وUNLOAD،
 * وطيّ رصيد السيارة يأخذ الباقي). `includeInactive`: الأصناف المعطّلة أيضاً — بضاعتها قد تبقى في السيارات.
 * `before`: الحركات قبل هذه اللحظة وحدها — المخزون كما كان في تاريخٍ مضى (نهاية يومه بتوقيت الشركة: warehouseAsOf).
 */
export async function loadWarehouseInputs(tid: string, opts: { includeInactive?: boolean; before?: Date } = {}): Promise<{
  products: ProdMeta[];
  whItems: WhItem[];
  vanItems: (VanItem & { at: Date })[];
}> {
  const [products, whItems, vanItems] = await Promise.all([
    prisma.product.findMany({
      where: { tenantId: tid, ...(!opts.includeInactive && { status: { not: 'INACTIVE' } }) },
      select: { id: true, name: true, code: true, unit: true, status: true, units: { select: UNIT_SELECT } },
    }),
    prisma.warehouseEntryItem.findMany({
      where: { entry: { tenantId: tid, ...(opts.before && { createdAt: { lt: opts.before } }) } },
      select: { productId: true, qty: true, unitFactor: true, baseQty: true, unitCost: true, entry: { select: { type: true, createdAt: true } } },
    }),
    prisma.vanLoadItem.findMany({
      // تحميلات المناديب المحذوفين داخلة عمداً (salesRepId فارغ): خرجت من المستودع فعلاً
      where: { vanLoad: { tenantId: tid, ...(opts.before && { createdAt: { lt: opts.before } }) } },
      select: { productId: true, qty: true, unitFactor: true, baseQty: true, vanLoad: { select: { type: true, createdAt: true, salesRepId: true, deletedSalesRepId: true } } },
    }),
  ]);
  /* حدّ التحويل الوحيد إلى الأساس: الكمية من لقطة الصفّ نفسه (لا وحدة الصنف اليوم — تعديل معامل الكرتون لا يعيد كتابة
   * رصيدٍ مضى ولا «المخزون في تاريخ»)، والتكلفة لوحدة الأساس بلا تقريب. ولا يُمرَّر المعامل بعدها: الكمية صارت أساساً،
   * وحمله معها يضربها مرّةً ثانية عند أيّ طيٍّ يقرأ baseQtyOf. */
  return {
    products,
    whItems: whItems.map((i) => ({ productId: i.productId, qty: baseQtyOf(i), type: i.entry.type, unitCost: unitCostPerBase(i.unitCost, i), at: i.entry.createdAt })),
    vanItems: vanItems.map((i) => ({ productId: i.productId, qty: baseQtyOf(i), type: i.vanLoad.type, salesRepId: vanKeyOf(i.vanLoad), at: i.vanLoad.createdAt })),
  };
}

// ═══ وحدة البند في مسارات كتابة المخزون (تحميل/تفريغ/تسوية سيارة، وارد/تسوية مستودع، طلب بضاعة) ═══

/** وحدة بندٍ يُكتب — تُمرَّر إلى `unitFields(qty, unit)` فتُكتب لقطتها وكميته بالأساس */
export interface LineUnit { name: string | null; factor: number }

/** وحدة الأساس بمعامل ١ — حال كل بندٍ بلا `unitId` (سلوك ما قبل الميزة حرفياً) */
export const BASE_UNIT: LineUnit = Object.freeze({ name: null, factor: 1 }) as LineUnit;

/** صفّ `ProductUnit` كما يحتاجه الحلّ */
export interface UnitRow { id: string; productId: string; name: string; factor: number; isActive?: boolean | null }

/**
 * وحدة بندٍ من معرّفها — الخادم يحلّ المعامل من وحدات الصنف ولا يثق برقمٍ يرسله العميل (القاعدة ٦).
 * `unitId` غائبٌ، أو لوحدة صنفٍ آخر، أو لوحدةٍ موقوفة ⇒ الأساس بمعامل ١ — كمسار الفاتورة (routes/invoices.ts).
 */
/**
 * وحدةٌ غير صالحة في مسار كتابة مخزون — يُترجمها معالج الأخطاء إلى 400 UNIT_INVALID برسالتها.
 *
 * وكانت تُقرأ وحدة أساسٍ بصمت: تحميل «١٠ كراتين» من شاشةٍ بقائمة أصنافٍ قديمة (وحدةٌ أُوقفت أو
 * حُذفت أو لصنفٍ آخر) يُقيَّد عشر حبّات، فيختلّ رصيد السيارة والمستودع ولا يعلم أحد. والقرار
 * المدوّن في DESIGN.md: الرفض الظاهر في الحيّ كمسار الفاتورة (routes/invoices.ts resolveLineUnit).
 */
export class UnitInvalidError extends Error {
  readonly status = 400;
  readonly code = 'UNIT_INVALID';
  constructor(message: string) { super(message); this.name = 'UnitInvalidError'; }
}

/**
 * وحدة بندٍ من وحدات صنفه: لا معرّف ⇒ الأساس (جسم ما قبل الميزة). ومعرّفٌ لا يخصّ الصنف ⇒ رفض، وموقوفٌ ⇒ رفض
 * إلّا في إعادة الرفع أوف‑لاين (أُوقفت بعد تسجيل الحركة على الجهاز — القاعدة ٧).
 */
export function pickLineUnit(units: readonly UnitRow[], productId: string, unitId?: string | null, opts: { replay?: boolean } = {}): LineUnit {
  if (!unitId) return BASE_UNIT;
  const u = units.find((x) => x.id === unitId && x.productId === productId);
  if (!u) throw new UnitInvalidError('الوحدة المختارة ليست من وحدات الصنف — حدّث قائمة الأصناف ثم أعد الحفظ');
  if (u.isActive === false && !opts.replay) throw new UnitInvalidError(`وحدة «${u.name}» موقوفة لهذا الصنف — اختر وحدة أخرى`);
  return { name: u.name, factor: factorOf({ unitFactor: u.factor }) };
}

/**
 * وحدات بنود مسار كتابة، بترتيب البنود. استعلامٌ واحد لكل الطلب، ولا استعلام أصلاً حين لا يحمل بندٌ وحدة —
 * فعميلٌ قديم (أو مفتاح API) يرسل `{productId, qty}` يبقى مساره كما كان حرفياً.
 */
export async function resolveLineUnits(
  tid: string, lines: readonly { productId: string; unitId?: string | null }[], opts: { replay?: boolean } = {},
): Promise<LineUnit[]> {
  const ids = [...new Set(lines.map((l) => l.unitId).filter((x): x is string => typeof x === 'string' && !!x))];
  const units: UnitRow[] = ids.length
    ? await prisma.productUnit.findMany({ where: { tenantId: tid, id: { in: ids } }, select: { id: true, productId: true, name: true, factor: true, isActive: true } })
    : [];
  return lines.map((l) => pickLineUnit(units, l.productId, l.unitId, opts));
}

/** وحدات أصنافٍ للعرض (صنف ← وحداته) — لردٍّ يحمل كمياتٍ بالأساس فتعرضها الواجهة «X كرتون و Y حبة» */
export async function unitsByProduct(tid: string, productIds: readonly string[]): Promise<Map<string, UnitDef[]>> {
  const out = new Map<string, UnitDef[]>();
  if (!productIds.length) return out;
  const rows = await prisma.productUnit.findMany({
    where: { tenantId: tid, productId: { in: [...new Set(productIds)] } },
    select: { ...UNIT_SELECT, productId: true },
    orderBy: [{ sortOrder: 'asc' }, { factor: 'asc' }],
  });
  for (const { productId, ...u } of rows) {
    const list = out.get(productId) ?? [];
    list.push(u);
    out.set(productId, list);
  }
  return out;
}

/** ما في السيارات بتكلفة الشراء — بطاقة «في مخزون السيارات» في صفحة مخزون الشركة */
export interface VansStockSummary {
  qty: number;           // الرصيد المتاح للبيع في كل السيارات (الموجب وحده)
  value: number;         // قيمته بكلفة خروجه من المستودع
  uncostedQty: number;   // منه كمية بلا تكلفة معروفة — خارج القيمة صراحةً
  unsellableQty: number; // تالفٌ ومنتهٍ في السيارات لا يُباع — خارج الرصيد والقيمة
  reps: number;          // سيارات فيها بضاعة
  products: number;      // أصنافٌ في سيارةٍ واحدة على الأقل
  /** سيارات مناديب محذوفين حُمّلت ولم تُنزَّل كلها — بضاعتها غير معروفة (فواتيرهم فقدت مندوبها بالحذف) فلا تدخل هنا */
  deletedVans?: number;
}

/**
 * دالّة نقيّة: رصيد كل سيارة (من طيّ حركاتها كمسار مخزون السيارات) مقيَّماً بطبقاتها (valueVanQty)، وبمتوسّط المستودع لما
 * زاد عليها. الرصيد السالب (بيعٌ بلا مخزون) ليس بضاعة فلا يُنقص غيره.
 */
export function summarizeVansStock(
  perRep: { repId: string; products: { productId: string; remaining: number; unsellable: number }[] }[],
  layers: ReadonlyMap<string, ReadonlyMap<string, VanLayer[]>>,
  avgCost: ReadonlyMap<string, number>,
  decimals: number = DEFAULT_CURRENCY_DECIMALS,
): VansStockSummary {
  let qty = 0, value = 0, uncostedQty = 0, unsellableQty = 0, reps = 0;
  const products = new Set<string>();
  for (const r of perRep) {
    let has = false;
    for (const p of r.products) {
      if (p.unsellable > 0) unsellableQty += p.unsellable;
      if (!(p.remaining > 1e-9)) continue;
      has = true;
      products.add(p.productId);
      qty += p.remaining;
      const v = valueVanQty(layers.get(p.productId)?.get(r.repId), p.remaining, avgCost.get(p.productId) ?? 0);
      value += v.value;
      uncostedQty += v.uncostedQty;
    }
    if (has) reps += 1;
  }
  return {
    qty: roundDecimal(qty, 4),
    value: roundDecimal(value, decimals),
    uncostedQty: roundDecimal(uncostedQty, 4),
    unsellableQty: roundDecimal(unsellableQty, 4),
    reps,
    products: products.size,
  };
}
