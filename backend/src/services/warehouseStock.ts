// ============================================================================
// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات.
// ----------------------------------------------------------------------------
// الرصيد لكل منتج =
//     الوارد (RECEIVE − المرتجع للمورّد RETURN) + تسويات المستودع (ADJUST)
//   + العائد من السيارات (VanLoad UNLOAD)
//   − المحمّل للسيارات   (VanLoad LOAD)
// تسوية السيارة (VanLoad ADJUST) حركةٌ داخل السيارة لا تمسّ المستودع.
// والمرتجع للمورّد («ربط الدفاتر» L1) كمياته سالبة ويُقيَّم كتسويةٍ بالنقص تماماً — انظر `costKindOfWarehouseEntry`.
// والعائد يدخل بالكلفة التي خرج بها لا بمتوسّط لحظة عودته، وبكلفة **سيارته هو**
// لا كلفة حمولة زميله — انظر `valueStock`.
//
// الوحدات المتعددة: كل كميةٍ هنا **بوحدة الأساس** وكل تكلفةٍ **لوحدة الأساس**. التحويل
// يقع مرّةً واحدة عند حدّ القراءة (`loadWarehouseInputs`: baseQtyOf وunitCostPerBase)،
// فيبقى الحساب النقيّ (composeWarehouse/valueStock) صرفاً بالأساس واختباراته صالحة.
// ============================================================================
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { currencyDecimalsOf } from '../config/countries';
import { roundDecimal } from '../utils/helpers';
import {
  valueStock, valueVanQty, unitCostPerBase, costKindOfWarehouseEntry, warehouseEntryColumn, CostMove, VanLayer, DEFAULT_CURRENCY_DECIMALS,
} from './warehouseCost';
import { cleanMoney } from './netSales';
import { baseQtyOf, factorOf, productQtyText, type UnitDef } from './units';
import { majorTotals, type MajorUnitProduct, type UnitTotal } from './majorUnitTotals';

export interface WarehouseRow {
  productId: string;
  name: string;
  code: string;
  /** وحدة الأساس — كل كميات الصفّ بها */
  unit: string;
  /** وحدات الصنف بمعاملاتها — لعرض الرصيد «٢ كرتون و٣ حبة» (formatQty) لا لحسابه */
  units?: UnitDef[];
  /** «الوحدة الرئيسية» (القاعدة ١٢): عرضٌ فقط — الواجهة تعرض الرصيد والتكلفة بها (productQtyText). لا يدخل الحساب هنا */
  primaryUnitId?: string | null;
  /** حالة الصنف كما خُزّنت (ACTIVE | INACTIVE) — عرضٌ فقط: الواجهة توسم الموقوف وتنزله إلى ذيل الجدول. يغيب لمستدعٍ نقيّ لا يمرّرها */
  status?: string;
  /** صنفٌ مؤرشف (حذفُه وضع deletedAt) بقي له رصيد — يُوسم فلا يبدو الصنف مكرّراً بجانب بديله. يغيب كـstatus */
  archived?: boolean;
  received: number;        // الوارد للمستودع صافياً من المرتجع للمورّد (RECEIVE + RETURN السالب)
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

/** ما تقرؤه loadWarehouseInputs من القاعدة — prisma أو معاملة أو قاعدةٌ مزيّفة في الاختبار */
export type WarehouseInputsDb = Pick<Prisma.TransactionClient, 'product' | 'warehouseEntryItem' | 'vanLoadItem'>;

interface ProdMeta { id: string; name: string; code: string; unit: string; status?: string; deletedAt?: Date | null; units?: UnitDef[]; primaryUnitId?: string | null }
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
  /**
   * يُملأ بمتوسّط كل صنف **غير المقرَّب** (صنف ← تكلفة وحدة الأساس) — بديل ما زاد على طبقات السيارة في summarizeVansStock.
   * المقرَّب (avgCost في الصفّ) للعرض وحده: به كان تحويل وحدة الأساس يغيّر قيمة «في مخزون السيارات» (#13)
   */
  rawAvgOut?: Map<string, number>,
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
    // العمود: RECEIVE وRETURN «الوارد» (صافي ما ورد من الموردين) وغيرهما تسوية؛ والتقييم: RECEIVE وحده بسعره، وغيره —
    // ADJUST جردٌ أو تالف، وRETURN مرتجعٌ للمورّد بكمية سالبة — يخرج بلا ثمن بمتوسّط لحظته (warehouseCost.ts)
    ensure(it.productId)[warehouseEntryColumn(it.type)] += it.qty;
    if (costKindOfWarehouseEntry(it.type) === 'RECEIVE') {
      push(it.productId, { qty: it.qty, kind: 'RECEIVE', unitCost: it.unitCost }, it.at);
    } else {
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
    const out: { vanLayers?: Map<string, VanLayer[]>; rawAvgCost?: number } | undefined = layersOut || rawAvgOut ? {} : undefined;
    const val = valueStock(mv, decimals, out);
    if (layersOut && out?.vanLayers) layersOut.set(p.id, out.vanLayers);
    if (rawAvgOut && out?.rawAvgCost !== undefined) rawAvgOut.set(p.id, out.rawAvgCost);
    return {
      productId: p.id, name: p.name, code: p.code, unit: p.unit, ...(p.units && { units: p.units }),
      // عرضٌ فقط، ومن القراءة وحدها (loadWarehouseInputs) — مستدعٍ نقيّ لا يمرّره يبقى صفّه كما كان حرفياً
      ...(p.primaryUnitId !== undefined && { primaryUnitId: p.primaryUnitId }),
      // الحالة والأرشفة (S1) عرضٌ فقط ومن القراءة وحدها كذلك — لا رقم يتغيّر
      ...(p.status !== undefined && { status: p.status }),
      ...(p.deletedAt !== undefined && { archived: p.deletedAt != null }),
      ...m, onHand,
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
  // والمؤرشف كالموقوف (S1): صنفٌ أُعيد ACTIVE بعد أرشفته يبقى deletedAt عليه — لا يظهر صفّه صفراً بلا شيء
  const inactive = new Set(products.filter((p) => p.status === 'INACTIVE' || p.deletedAt != null).map((p) => p.id));
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
 * `db`: عميل القاعدة — الافتراضي prisma كما كان؛ و«تصفير المخزون» (services/stockZero.ts) يمرّر عميله المحقون فيُختبر تقييمه
 * بقاعدةٍ مزيّفة كمسار الإنتاج حرفياً.
 */
export async function loadWarehouseInputs(tid: string, opts: { includeInactive?: boolean; before?: Date } = {}, db: WarehouseInputsDb = prisma): Promise<{
  products: ProdMeta[];
  whItems: WhItem[];
  vanItems: (VanItem & { at: Date })[];
}> {
  const [products, whItems, vanItems] = await Promise.all([
    db.product.findMany({
      where: { tenantId: tid, ...(!opts.includeInactive && { status: { not: 'INACTIVE' } }) },
      // deletedAt (S1): وسم «مؤرشف» على صفّ المستودع — في القراءة نفسها بلا استعلام زائد
      select: { id: true, name: true, code: true, unit: true, status: true, deletedAt: true, units: { select: UNIT_SELECT }, primaryUnitId: true },
    }),
    db.warehouseEntryItem.findMany({
      where: { entry: { tenantId: tid, ...(opts.before && { createdAt: { lt: opts.before } }) } },
      select: { productId: true, qty: true, unitFactor: true, baseQty: true, unitCost: true, entry: { select: { type: true, createdAt: true } } },
    }),
    db.vanLoadItem.findMany({
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

// ═══ حكم أصناف البنود في مسارات كتابة المخزون (الوارد وحركة السيارة) ═══

/** صنف بندٍ كما يحتاجه حكم الوجود والأرشفة — من قراءة المسار نفسها */
export interface LineProductMeta { id: string; name: string; deletedAt?: Date | null }

/** ردّ رفضٍ جاهز: الحالة والجسم كما يُرسَلان */
export type LineProductRefusal =
  | { status: 400; body: { success: false; code: 'PRODUCT_NOT_FOUND'; message: string; productId: string; index: number; productIds: string[]; indexes: number[] } }
  | { status: 422; body: { success: false; code: 'PRODUCT_ARCHIVED'; message: string; productId: string; index: number } };

const ARCHIVED_MESSAGE = {
  RECEIVE: (name: string) => `الصنف «${name}» محذوف (مؤرشف) فلا يُستلم في المستودع — استلم على الصنف الحالي، وصحّح رصيد القديم بتسوية`,
  LOAD: (name: string) => `الصنف «${name}» محذوف (مؤرشف) فلا يُحمَّل للسيارة — حمّل الصنف الحالي، والتنزيل والتسوية متاحان لتصفية رصيده`,
} as const;

/**
 * حكم أصناف بنود حركة مخزون **قبل** حلّ وحداتها (#23): صنفٌ لا يتبع الشركة ⇒ 400 PRODUCT_NOT_FOUND بموضع سطره وكل
 * المواضع المرفوضة (كان «منتج غير صالح» بلا رمز ولا سطر، وسطرٌ يحمل unitId كان يأتيه UNIT_INVALID مضلِّلاً). و`rejectArchived`
 * (مراجعة المخزون H2: الوارد RECEIVE وتحميل السيارة LOAD وحدهما) ⇒ صنفٌ مؤرشف (deletedAt) 422 PRODUCT_ARCHIVED — زيادةٌ لا يبيعها أحد ولا يراها
 * منتقي الأصناف. والتسوية والتنزيل والإزالة تمرّ: هي طريق تصفية رصيده. الموقوف غير المؤرشف كما كان (وسمٌ في العرض وحده).
 * `index` موضع السطر في items كما أرسله العميل (من الصفر). null ⇒ يمضي المسار.
 */
export function lineProductRefusal(
  lines: readonly { productId: string; at: number }[],
  products: readonly LineProductMeta[],
  opts: { rejectArchived: 'RECEIVE' | 'LOAD' | null },
): LineProductRefusal | null {
  const byId = new Map(products.map((p) => [p.id, p]));
  const missing = lines.filter((l) => !byId.has(l.productId));
  if (missing.length) {
    const [first] = missing;
    const shown = missing.slice(0, 10).map((l) => l.at + 1).join('، ');
    return {
      status: 400,
      body: {
        success: false, code: 'PRODUCT_NOT_FOUND',
        message: missing.length === 1
          ? `منتج غير صالح — صنف السطر ${first.at + 1} غير موجود في هذه الشركة`
          : `منتج غير صالح — أصناف الأسطر ${shown}${missing.length > 10 ? '…' : ''} غير موجودة في هذه الشركة`,
        productId: first.productId, index: first.at,
        productIds: [...new Set(missing.map((l) => l.productId))], indexes: missing.map((l) => l.at),
      },
    };
  }
  if (!opts.rejectArchived) return null;
  const archived = lines.find((l) => byId.get(l.productId)?.deletedAt != null);
  if (!archived) return null;
  return {
    status: 422,
    body: {
      success: false, code: 'PRODUCT_ARCHIVED', message: ARCHIVED_MESSAGE[opts.rejectArchived](byId.get(archived.productId)!.name),
      productId: archived.productId, index: archived.at,
    },
  };
}

// ═══ «التحميل فوق رصيد المستودع يُمنع» (مراجعة المخزون S5، قرار المالك D2) ═══
// المستودع مفعّل ⇒ تحميل السيارة (LOAD) لا يتجاوز رصيد الصنف في المستودع بالأساس، لكل مُصدِر (اللوحة والجوال والمندوب ومفتاح API).
// الفحص والكتابة في معاملةٍ واحدة تحت قفل المستودع الاستشاري للشركة، فلا يمرّ تحميلان متزامنان معاً فوق الرصيد. والشركة بلا مستودع كما كانت.

/** صنفٌ لا يكفيه رصيد المستودع في ردّ 422 WAREHOUSE_INSUFFICIENT — أسطره مجموعة، والكميتان بوحدة الأساس */
export interface WarehouseShortLine {
  /** موضع أول سطرٍ للصنف في items كما أرسلها العميل (من الصفر) */
  index: number;
  /** مواضع كل أسطر الصنف في الطلب (الرصيد واحد فتُجمع) */
  indexes: number[];
  productId: string;
  /** رصيد المستودع قبل الحركة — قد يكون صفراً أو سالباً */
  availableBase: number;
  requestedBase: number;
}

/**
 * دالّة نقيّة: أسطر التحميل بالأساس مقابل رصيد المستودع لكل صنف. أسطر الصنف الواحد تُجمع، فسطرٌ واحد لكل صنفٍ ناقص بترتيب
 * أول ظهوره. صافي طلبٍ غير موجب لا يُحكم عليه، وصنفٌ رصيده صفر أو سالب لا يُحمَّل منه شيء.
 */
export function warehouseShortLines(
  lines: readonly { productId: string; baseQty: number; at: number }[], onHand: ReadonlyMap<string, number>,
): WarehouseShortLine[] {
  const want = new Map<string, { q: number; indexes: number[] }>();
  for (const l of lines) {
    const w = want.get(l.productId) ?? { q: 0, indexes: [] };
    w.q += l.baseQty;
    w.indexes.push(l.at);
    want.set(l.productId, w);
  }
  const out: WarehouseShortLine[] = [];
  for (const [productId, w] of want) {
    const requestedBase = roundDecimal(w.q, 4);
    const availableBase = roundDecimal(onHand.get(productId) ?? 0, 4);
    if (requestedBase > 1e-9 && requestedBase > availableBase + 1e-9) {
      out.push({ index: w.indexes[0], indexes: w.indexes, productId, availableBase, requestedBase });
    }
  }
  return out;
}

/** ما يقرؤه warehouseOnHandOf — prisma أو معاملة أو قاعدةٌ مزيّفة في الاختبار */
export type WarehouseOnHandDb = Pick<Prisma.TransactionClient, 'warehouseEntryItem' | 'vanLoadItem'>;

/**
 * رصيد المستودع الآن لأصنافٍ بعينها (بالأساس) بالمعادلة نفسها في composeWarehouse: الوارد والتسويات + العائد من السيارات − المحمَّل
 * لها (ومنه تحميلات المناديب المحذوفين). أسطر المستودع كلها بإشارتها أيّاً كان نوعها — والمرتجع للمورّد (RETURN) سالبٌ فيُنقصه. استعلامان مقيّدان بأصناف الحركة لا مستودع الشركة كله. داخل معاملة التحميل يقرأ الملتزَم
 * بعد قفل المستودع (READ COMMITTED): التحميل السابق التزم قبل أن يُفكّ قفله.
 */
export async function warehouseOnHandOf(tid: string, productIds: readonly string[], db: WarehouseOnHandDb = prisma): Promise<Map<string, number>> {
  const ids = [...new Set(productIds)];
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  if (!ids.length) return out;
  const [wh, van] = await Promise.all([
    db.warehouseEntryItem.findMany({
      where: { productId: { in: ids }, entry: { tenantId: tid } },
      select: { productId: true, qty: true, unitFactor: true, baseQty: true },
    }),
    db.vanLoadItem.findMany({
      where: { productId: { in: ids }, vanLoad: { tenantId: tid, type: { in: ['LOAD', 'UNLOAD'] } } },
      select: { productId: true, qty: true, unitFactor: true, baseQty: true, vanLoad: { select: { type: true } } },
    }),
  ]);
  for (const i of wh) out.set(i.productId, (out.get(i.productId) ?? 0) + baseQtyOf(i));
  for (const i of van) {
    const sign = i.vanLoad.type === 'UNLOAD' ? 1 : i.vanLoad.type === 'LOAD' ? -1 : 0;
    out.set(i.productId, (out.get(i.productId) ?? 0) + sign * baseQtyOf(i));
  }
  return out;
}

/** مفتاح قفل المستودع الاستشاري للشركة — كل تحميلٍ يُحكم على رصيده تحته */
export const WAREHOUSE_STOCK_LOCK_PREFIX = 'warehouse-stock:';

/** قفل المستودع للشركة داخل المعاملة (قفل معاملة لا جلسة: يُفكّ بالتزامها أو إجهاضها) */
export async function lockWarehouseStock(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, tid: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${WAREHOUSE_STOCK_LOCK_PREFIX + tid}))`;
}

/** صنف السطر كما يعرضه نصّ الرفض: اسمه ووحدته ووحداته ورئيسيّه */
type ShortProduct = { name: string; unit?: string | null; units?: UnitDef[]; primaryUnitId?: string | null };

/** نصّ الرفض: كل صنفٍ ناقص بالمتاح والمطلوب بوحدة عرضه («2 كرتون و3 حبة»)، والرصيد الصفري أو السالب «لا رصيد له» */
export function warehouseShortMessage(lines: readonly WarehouseShortLine[], products: ReadonlyMap<string, ShortProduct>): string {
  const qty = (q: number, p?: ShortProduct) => (p ? productQtyText(q, p) : String(q));
  const one = (l: WarehouseShortLine) => {
    const p = products.get(l.productId);
    const name = `«${p?.name ?? l.productId}»`;
    return l.availableBase > 1e-9
      ? `${name}: المتاح ${qty(l.availableBase, p)} والمطلوب ${qty(l.requestedBase, p)}`
      : `${name}: لا رصيد له في المستودع والمطلوب ${qty(l.requestedBase, p)}`;
  };
  const shown = lines.slice(0, 5).map(one).join('، ');
  const more = lines.length > 5 ? ` و${lines.length - 5} أصناف أخرى` : '';
  return `رصيد المستودع لا يكفي للتحميل — ${shown}${more}. سجّل الوارد أولاً أو خفّض الكمية`;
}

/** رفض التحميل فوق رصيد المستودع — يردّه المسار 422 بجسمه (body) ولا يُكتب شيء */
export class WarehouseInsufficientError extends Error {
  readonly status = 422;
  readonly code = 'WAREHOUSE_INSUFFICIENT';
  constructor(readonly lines: WarehouseShortLine[], message: string) { super(message); this.name = 'WarehouseInsufficientError'; }
  body() { return { success: false as const, code: this.code, message: this.message, lines: this.lines }; }
}

/** ما يحتاجه الحارس داخل المعاملة: القفل والقراءتان */
export type WarehouseGuardDb = Pick<Prisma.TransactionClient, '$executeRaw' | 'warehouseEntryItem' | 'vanLoadItem'>;

/**
 * حارس D2 داخل معاملة التحميل: قفل المستودع للشركة، ثم رصيد أصناف الحركة الملتزَم، ثم الرفض بـWarehouseInsufficientError لأي صنفٍ
 * لا يكفيه رصيده. يُستدعى قبل أي كتابة في المعاملة.
 */
export async function assertWarehouseCovers(
  tx: WarehouseGuardDb, tid: string, lines: readonly { productId: string; baseQty: number; at: number }[],
  products: ReadonlyMap<string, ShortProduct>,
): Promise<void> {
  await lockWarehouseStock(tx, tid);
  const short = warehouseShortLines(lines, await warehouseOnHandOf(tid, lines.map((l) => l.productId), tx));
  if (short.length) throw new WarehouseInsufficientError(short, warehouseShortMessage(short, products));
}

// ═══ «المشتريات الشهرية» في لوحة التحكم («ربط الدفاتر» L1: صافية من المرتجع وبلا المخزون الافتتاحي) ═══

/**
 * صفّ مجمَّع من حركات الشهر المسعَّرة (routes/dashboard.ts): بنوع الحركة وحالتها ومصدرها ومصدر الوارد الأصلي للمرتجع.
 * `value` = Σ الكمية × تكلفة الوحدة بوحدة الصفّ (سالبٌ للمرتجع: كمياته سالبة)، و`entries` عدد الحركات المتميّزة.
 */
export interface PurchaseAggRow {
  type: string;
  status: string | null;
  source: string | null;
  /** مصدر الوارد الذي يردّه هذا المرتجع (returnOfEntryId) — null لغير المرتجع أو لمرتجعٍ بلا أصل */
  returnOfSource: string | null;
  value: number | null;
  entries: number | bigint | null;
}

/** مصدر حركة المخزون الافتتاحي — جردٌ أُدخل لا شراء */
export const OPENING_IMPORT_SOURCE = 'OPENING_IMPORT';

/**
 * المشتريات الشهرية = الوارد المسعَّر (RECEIVE) + المرتجع للمورّد (RETURN، قيمته سالبة) — صافيةً كما يُنقص المرتجعُ المبيعات.
 * - المخزون الافتتاحي (source = OPENING_IMPORT) ليس شراءً فلا يدخل، ولا مرتجعُ وارده (إلغاء استيرادٍ خاطئ لا ينقص مشترياتٍ لم تُعدّ).
 * - عدد الحركات: الوارد غير الملغى وحده — الوارد الملغى (CANCELLED) تُصفّر قيمتَه حركةُ إلغائه (RETURN كاملة) فيبقى في المجموع
 *   صافياً صفراً، ولا يُعدّ شراءً. المرتجع لا يُعدّ حركة شراء.
 * - أي نوعٍ آخر (ADJUST) لا يدخل. والناتج منقّى من ضجيج الفاصلة العائمة كصافي المبيعات (cleanMoney).
 */
export function monthPurchasesOf(rows: readonly PurchaseAggRow[]): { purchasesTotal: number; entriesCount: number } {
  let total = 0;
  let count = 0;
  for (const r of rows) {
    if (r.source === OPENING_IMPORT_SOURCE || r.returnOfSource === OPENING_IMPORT_SOURCE) continue;
    const value = Number(r.value ?? 0);
    if (r.type === 'RECEIVE') {
      total += Number.isFinite(value) ? value : 0;
      if (r.status !== 'CANCELLED') count += Number(r.entries ?? 0);
    } else if (r.type === 'RETURN') {
      total += Number.isFinite(value) ? value : 0;
    }
  }
  return { purchasesTotal: cleanMoney(total), entriesCount: count };
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
  /** qty وuncostedQty وunsellableQty نفسها بالوحدة الكبرى لكل صنف (عرضٌ فقط) — حين يمرّر المستدعي أصنافه وحدها */
  major?: VansStockMajor;
}

/** مجاميع بطاقة «في مخزون السيارات» بالوحدة الكبرى: «22.75 كرتون · 40 حبة» بدل «8,191 بالوحدات الصغرى» */
export interface VansStockMajor { qty: UnitTotal[]; uncostedQty: UnitTotal[]; unsellableQty: UnitTotal[] }

/**
 * دالّة نقيّة: رصيد كل سيارة (من طيّ حركاتها كمسار مخزون السيارات) مقيَّماً بطبقاتها (valueVanQty)، وبمتوسّط المستودع لما
 * زاد عليها. الرصيد السالب (بيعٌ بلا مخزون) ليس بضاعة فلا يُنقص غيره.
 */
export function summarizeVansStock(
  perRep: { repId: string; products: { productId: string; remaining: number; unsellable: number }[] }[],
  layers: ReadonlyMap<string, ReadonlyMap<string, VanLayer[]>>,
  avgCost: ReadonlyMap<string, number>,
  decimals: number = DEFAULT_CURRENCY_DECIMALS,
  /** أصناف الشركة (صنف ← أساسه ووحداته ورئيسيّه) ⇒ يُضاف `major`. غيابها ⇒ الناتج كما كان حرفياً («تصفير المخزون») */
  productsMeta?: ReadonlyMap<string, MajorUnitProduct>,
): VansStockSummary {
  let qty = 0, value = 0, uncostedQty = 0, unsellableQty = 0, reps = 0;
  const products = new Set<string>();
  // الأرقام نفسها التي تصنع المجاميع أعلاه صنفاً صنفاً — فلا يفترق المجموعان بشرطٍ يُنسى في أحدهما
  type Part = { product?: MajorUnitProduct | null; baseQty: number };
  const mQty: Part[] = [], mUncosted: Part[] = [], mUnsellable: Part[] = [];
  for (const r of perRep) {
    let has = false;
    for (const p of r.products) {
      const meta = productsMeta?.get(p.productId);
      if (p.unsellable > 0) {
        unsellableQty += p.unsellable;
        if (productsMeta) mUnsellable.push({ product: meta, baseQty: p.unsellable });
      }
      if (!(p.remaining > 1e-9)) continue;
      has = true;
      products.add(p.productId);
      qty += p.remaining;
      const v = valueVanQty(layers.get(p.productId)?.get(r.repId), p.remaining, avgCost.get(p.productId) ?? 0);
      value += v.value;
      uncostedQty += v.uncostedQty;
      if (productsMeta) {
        mQty.push({ product: meta, baseQty: p.remaining });
        if (v.uncostedQty > 0) mUncosted.push({ product: meta, baseQty: v.uncostedQty });
      }
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
    ...(productsMeta && { major: { qty: majorTotals(mQty), uncostedQty: majorTotals(mUncosted), unsellableQty: majorTotals(mUnsellable) } }),
  };
}
