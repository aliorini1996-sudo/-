/**
 * أنواع محرّك التكلفة الوحيد («ربط الدفاتر» L3 — قرار المالك OD6: المتوسّط المرجّح المتحرّك لكل موقع: المستودع وكل سيارة).
 * العقد المُلزِم: scratchpad/l23_contract.md §3. هذا الملف يُنسخ من العقد حرفياً؛ أي تغيير فيه بقرار المعماري وحده.
 *
 * صرفٌ بلا prisma: الكميات بوحدة الأساس (Float بستّ منازل كـunits.roundQty، وفي الحساب أعداد صحيحة «ميكرو» ×10⁶)،
 * والمبالغ ملّي BigInt (١/١٠٠٠ من وحدة العملة، ومضاعفة دائماً لأصغر وحدة عملة unitMilli(decimals)).
 * خارج services/gl عمداً: الشاشات التشغيلية (المستودع والسيارات) تستورده لاحقاً بلا مساس بحارس gl-hooks-static.
 */

export type Milli = bigint;

// ═══ المواقع ═══

/** 'WH' المستودع، 'VAN:<repKey>' سيارة مندوب (repKey = salesRepId أو deletedSalesRepId بعد حذفه)، 'VAN:_' سيارة مجهولة */
export type LocationKey = 'WH' | `VAN:${string}`;
export const WH_LOCATION: LocationKey = 'WH';
export const UNKNOWN_VAN: LocationKey = 'VAN:_';

export function vanLocation(repKey: string | null | undefined): LocationKey {
  return repKey ? (`VAN:${repKey}` as LocationKey) : UNKNOWN_VAN;
}
export function isVanLocation(l: string): l is `VAN:${string}` {
  return l.startsWith('VAN:');
}
/** معرّف المندوب من موقع سيارة (null للمستودع وللسيارة المجهولة) */
export function repOfLocation(l: LocationKey): string | null {
  return l.startsWith('VAN:') && l !== UNKNOWN_VAN ? l.slice(4) : null;
}

// ═══ أنواع الحركات ═══

export const MOVE_KINDS = [
  /** وارد مستودع RECEIVE (كمية موجبة): بقيمة السطر إن سُعّر (inValueMilli)، وإلا يدخل دلو «خارج التقييم» */
  'RECEIVE',
  /** مرتجع للمورّد (WarehouseEntry RETURN — L1، كمية سالبة): خروج من المستودع بمتوسّطه */
  'VENDOR_RETURN',
  /** تسوية مستودع ADJUST بلا zeroRunId: السالب خروج بالمتوسّط، والموجب دخول بمتوسّط اللحظة (وإلا خارج التقييم) */
  'WH_ADJUST',
  /** «تصفير المخزون»: ADJUST بـzeroRunId على المستودع أو السيارة — كالتسوية */
  'ZERO_RUN',
  /** تحميل سيارة: سطر LOAD موجب أو سطر UNLOAD سالب — تحويل WH ⇒ VAN بقيمة خروجه من المستودع */
  'VAN_LOAD',
  /** تنزيل سيارة: سطر UNLOAD موجب أو سطر LOAD سالب — تحويل VAN ⇒ WH بمتوسّط السيارة */
  'VAN_UNLOAD',
  /** تسوية سيارة ADJUST بلا zeroRunId (±) */
  'VAN_ADJUST',
  /** إزالة التالف/المنتهي من السيارة (DAMAGED_OUT/EXPIRED_OUT): مذكِّرة بلا كمية ولا قيمة — شُطبت قيمته يوم المرتجع (OD15) */
  'DAMAGE_OUT',
  /** بند فاتورة نقدية/آجلة لمندوب: خروج من سيارته بمتوسّطها */
  'VAN_SALE',
  /** بند فاتورة نقدية/آجلة بلا مندوب (فاتورة الإدارة — OD8): خروج من المستودع بمتوسّطه */
  'WAREHOUSE_SALE',
  /** إلغاء فاتورة البيع: دخول بمرآة لقطة البيع إلى موقعه نفسه */
  'SALE_CANCEL',
  /** بند مرتجع لمندوب يعود للمخزون: دخول سيارته بمرآة لقطة بند البيع الأصلي */
  'VAN_RETURN_RESTOCK',
  /** بند مرتجع بلا مندوب يعود للمخزون: دخول المستودع بمرآة لقطة البيع (OD8 متماثلاً) */
  'WAREHOUSE_RETURN_RESTOCK',
  /** بند مرتجع لا يعود (تالف/منتهٍ/returnToStock=false): مذكِّرة memoMilli = مرآة البيع (مدين 514001 / دائن 511001) */
  'RETURN_WRITE_OFF',
  /** إلغاء مرتجع: إن كان عائداً فخروج بالمتوسّط، وإن كان مشطوباً فعكس مذكِّرته */
  'RETURN_CANCEL',
  /** سجلّ تبديل returnToStock: إلى true دخول بمرآة البيع ومذكِّرة سالبة، وإلى false خروج بالمتوسّط ومذكِّرة موجبة */
  'RESTOCK_TOGGLE',
] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

export const TRANSFER_KINDS: readonly MoveKind[] = ['VAN_LOAD', 'VAN_UNLOAD'];
/** حركات بلا كمية على الموقع (baseQty = 0) */
export const MEMO_KINDS: readonly MoveKind[] = ['DAMAGE_OUT', 'RETURN_WRITE_OFF'];
export const SALE_KINDS: readonly MoveKind[] = ['VAN_SALE', 'WAREHOUSE_SALE'];

export const COST_REF_TYPES = ['WH_ENTRY', 'VAN_LOAD', 'INVOICE', 'RESTOCK_LOG'] as const;
export type CostRefType = (typeof COST_REF_TYPES)[number];

/** مؤشّر الصف المصدر — ترتيب المحرّك الوحيد (لحظة التسجيل في النظام، كالمتوسّط المتحرّك في SAP) */
export interface CostCursor {
  createdAt: Date;
  id: string;
}

/** صلات حركةٍ بلقطات سابقة (مفاتيح sourceKey) — يحلّها المحرّك من SnapshotLookup */
export interface MoveLinks {
  /**
   * لقطة تُؤخذ منها قيمة الدخول بالتناسب (مرآة): SALE_CANCEL ⇐ البيع؛ *_RETURN_RESTOCK وRETURN_WRITE_OFF وRESTOCK_TOGGLE(دخول) ⇐ بند البيع الأصلي.
   * كان اسمه في العقد «valueOf» فأُعيدت تسميته عند التكامل: ذلك الاسم يرثه كل كائن من Object.prototype (دالّة)، فصلاتٌ بلا
   * خاصيةٍ ذاتية كانت تُقرأ «مرتبطةً» بدالّة عند أي مستهلك يقرأ `links.valueOf` مباشرة، ولا يقبل tsc حرفيّةً تُسقطه.
   */
  mirrorOf?: string | null;
  /** لقطة يُؤخذ منها الموقع إن وُجدت (تغلب location الممرَّر): SALE_CANCEL ⇐ البيع؛ RETURN_CANCEL وRESTOCK_TOGGLE ⇐ لقطة المرتجع RET */
  locationOf?: string | null;
  /** لقطة تُعكس مذكِّرتها كاملةً: RETURN_CANCEL لمرتجعٍ مشطوب ⇐ آخر حركة شطب للبند (RET أو تبديل خروج) */
  memoOf?: string | null;
}

/** حركة مخزون واحدة لسطر واحد كما تشتقّها streams.ts من الجداول الإلحاقية */
export interface Move {
  /** sourceKey (keys.ts) — فريد لكل شركة */
  key: string;
  kind: MoveKind;
  /** التاريخ المحاسبي للأثر (تاريخ قيده لاحقاً) — لا يحدّد الترتيب */
  effectAt: Date;
  /** الصف المصدر (createdAt, id) — يحدّد الترتيب: (cursor.createdAt, cursor.id, key) */
  cursor: CostCursor;
  productId: string;
  /** الموقع الذي تتغيّر كميته بـbaseQty (للتحويل: المصدر) */
  location: LocationKey;
  /** الهدف للتحويل وحده */
  toLocation?: LocationKey | null;
  /** الكمية بالأساس موقّعة على location: الخروج والتحويل سالب، الدخول موجب، المذكِّرات صفر */
  baseQty: number;
  /** RETURN_WRITE_OFF وحده: الكمية التي تُقيَّم بها المذكِّرة بمرآة البيع (> 0) */
  memoQty?: number | null;
  /** RECEIVE وحده: قيمة السطر الإجمالية = toMilli(qty × unitCost بوحدة السطر، منازل العملة)؛ null ⇒ بلا سعر */
  inValueMilli?: Milli | null;
  links?: MoveLinks | null;
  /** سبب التسوية (WarehouseEntry/VanLoad.reason) أو الشطب (DAMAGED | EXPIRED | NOT_RESTOCKED) — يمرّ إلى اللقطة */
  reason?: string | null;
  refType: CostRefType;
  refId: string;
  itemId: string;
  /** يضعه snapshots.ts لصفٍّ ظهر بعد تجاوز المؤشّر (نادر) */
  lateArrival?: boolean;
}

// ═══ الحالة ═══

/** حالة (صنف، موقع): دلو مقيَّم (قد يكون سالباً = حفرة) ودلو «خارج التقييم» (≥ 0)، وآخر رصيد مقيَّم موجب */
export interface LocState {
  /** ميكرو وحدة أساس (×10⁶) — عدد صحيح، قد يكون سالباً */
  costedQtyU: number;
  /** ميكرو، ≥ 0 */
  uncostedQtyU: number;
  /** قيمة الدلو المقيَّم بالملّي (سالبة مع الحفرة المقيَّمة) */
  valueMilli: Milli;
  /** آخر (قيمة، كمية) للدلو المقيَّم حين كان الرصيد موجباً لحظة خروج — مرجع المكشوف على موقع فارغ؛ null إن لم يُعرف */
  lastAvg: { valueMilli: Milli; qtyU: number } | null;
}

export interface CostState {
  /** المفتاح locStateKey(productId, location) = `${productId}|${location}` */
  locs: Map<string, LocState>;
  movesFolded: number;
  /** آخر مؤشّر طُوي (شاملاً) */
  cursor: CostCursor | null;
}

// ═══ اللقطات ═══

/** ما يُقرأ من لقطة سابقة (في الذاكرة أو gl_cost_snapshots) لحلّ الصلات */
export interface SnapshotRef {
  key: string;
  kind: MoveKind;
  productId: string;
  location: LocationKey;
  toLocation: LocationKey | null;
  baseQty: number;
  uncostedQty: number;
  valueMilli: Milli;
  varianceMilli: Milli;
  memoMilli: Milli;
  effectAt: Date;
}

export interface SnapshotLookup {
  get(key: string): SnapshotRef | undefined;
}

export interface StepperConfig {
  /** منازل عملة الشركة 0..3 — التقريب إلى unitMilli(decimals) */
  currencyDecimals: number;
}

export const STEP_WARNINGS = [
  /** الموقع سالب الكمية بعد الحركة */
  'NEGATIVE_STOCK',
  /** دخلٌ سدّ حفرة فنشأ فرق (varianceMilli ≠ 0) */
  'HOLE_FILLED',
  /** خروجٌ أخذ من دلو «خارج التقييم» */
  'UNCOSTED_OUT',
  /** صلة mirrorOf/locationOf/memoOf لم تُحلّ — استُعمل البديل (المتوسّط) */
  'LINK_NOT_FOUND',
  /** مرتجع بلا بند بيع مرتبط — قُيِّم بمتوسّط موقعه */
  'RETURN_UNLINKED',
  /** مكشوف سيارة قُيِّم بمتوسّط المستودع (لا متوسّط للسيارة) */
  'WH_RATE_FALLBACK',
  /** مكشوف بلا أي متوسّط معروف — قُيِّم صفراً */
  'ZERO_RATE_DEFICIT',
] as const;
export type StepWarningCode = (typeof STEP_WARNINGS)[number];

/** ناتج حركة واحدة — يُكتب لقطةً (snapshots.ts) ويُقرأ في المعاينة والمطابقة */
export interface StepOutput extends SnapshotRef {
  refType: CostRefType;
  refId: string;
  itemId: string;
  srcCreatedAt: Date;
  srcId: string;
  reason: string | null;
  lateArrival: boolean;
  /** |القيمة الإجمالية| × 10⁷ ÷ الكمية المقيَّمة بالميكرو (= تكلفة الوحدة × 10⁴) — للعرض */
  unitCostE4: bigint;
  /** حالة location بعد الحركة (ذاكرة فقط، لا تُخزَّن) */
  qtyAfter: number;
  valueAfter: Milli;
  /** حالة toLocation بعد التحويل (null لغيره) */
  toQtyAfter: number | null;
  toValueAfter: Milli | null;
  warnings: StepWarningCode[];
}

export interface ReplayOptions {
  /** حالة البدء (نقطة حفظ) — الافتراضي فارغة */
  state?: CostState;
  /** لقطات سابقة خارج الدفعة (gl_cost_snapshots) — نواتج الدفعة نفسها تُضاف تلقائياً فوقها */
  lookup?: SnapshotLookup;
  /** لحظات تُلتقط عندها الحالة: الحالة بعد كل حركة cursor.createdAt < اللحظة (نسخة مستقلة) */
  captureAt?: readonly Date[];
  onOutput?: (o: StepOutput) => void;
}

export interface ReplayResult {
  state: CostState;
  outputs: StepOutput[];
  /** بفهرس captureAt */
  captured: CostState[];
}

// ═══ الملخّصات (summary.ts) ═══

export interface LocationTotals {
  location: LocationKey;
  /** Σ الكمية الموقّعة بالأساس */
  qtyBase: number;
  uncostedQty: number;
  valueMilli: Milli;
}

export interface CostingSummary {
  moveCount: number;
  productCount: number;
  /** Σ تغيّر القيمة للحركات المشمولة بالافتتاح (أثر < linkedFrom وتسجيل ≤ T0) — مصدر سطور 114001/114002 الافتتاحية */
  openingByLocation: LocationTotals[];
  /** Σ كل الحركات = الحالة الآن */
  nowByLocation: LocationTotals[];
  /** Σ cogsMilli (accounts.ts) للحركات غير المشمولة بالافتتاح — متوقَّع 511001 للسنة (R9) */
  fyCogsMilli: Milli;
  fyVarianceMilli: Milli;
  fyWriteOffMilli: Milli;
  /** الرصيد بلا تكلفة في بداية السنة (الحالة الفعلية عند zonedStartOfDay(linkedFrom)) — P9 */
  uncostedAtCutover: { productId: string; location: LocationKey; uncostedQty: number }[];
  uncostedAtCutoverTotalQty: number;
  /** أرصدة سالبة عند بداية السنة */
  negativeAtCutover: { productId: string; location: LocationKey; qtyBase: number }[];
  /** حُفر سُدّت بفرق خلال السنة — P10 */
  holesFy: { count: number; varianceMilli: Milli; sample: { key: string; productId: string; location: LocationKey; varianceMilli: Milli }[] };
  /** عدّ تحذيرات المحرّك والمصادر */
  warnings: { code: string; count: number; sample: string[] }[];
}

// ═══ المصادر (streams.ts) والملخّص (summary.ts) ═══

export interface LoadMovesOptions {
  /** حدّ شامل لـcreatedAt الصف المصدر: dbNow للمعاينة (لقطة ثابتة)، وdbNow − LATE_COMMIT_WINDOW للتشغيل الحيّ */
  until: Date;
  /** مؤشّر حصري: (createdAt, id) > afterCursor — من نقطة الحفظ؛ null/غائب ⇒ من أول التاريخ */
  afterCursor?: CostCursor | null;
  currencyDecimals: number;
  /** صفوف كل مصدر لكل صفحة قراءة (الافتراضي 2000) */
  pageSize?: number;
  /** سقف الحركات المعادة (للتشغيل الحيّ بدفعات) — الغائب ⇒ كل ما حتى until */
  maxMoves?: number;
}

export const STREAM_WARNINGS = [
  'DUPLICATE_PRIMARY_ROW', 'UNKNOWN_INVOICE_TYPE', 'ITEM_WITHOUT_PRODUCT', 'NEGATIVE_RECEIVE', 'UNKNOWN_VAN_TYPE',
  'TOGGLE_AFTER_CANCEL', 'NON_POSITIVE_SALE_QTY',
] as const;
export type StreamWarningCode = (typeof STREAM_WARNINGS)[number];

export interface StreamWarning {
  code: StreamWarningCode;
  count: number;
  /** حتى 20 معرّفاً للتعمّق */
  sample: string[];
}

export interface LoadMovesResult {
  /** مرتّبة بـcompareMoves */
  moves: Move[];
  /** آخر مؤشّر مصدر مقروء بأمان (كل صف ≤ هذا قُرئ من كل المصادر) — null إن لم يُقرأ شيء */
  cursor: CostCursor | null;
  /** توقّف عند maxMoves */
  truncated: boolean;
  sourceRows: Record<CostRefType, number>;
  warnings: StreamWarning[];
}

export interface SummarizeOptions {
  /** linkedFrom (YYYY-MM-DD) */
  cutoverDate: string;
  /** zonedStartOfDay(linkedFrom) */
  cutoverStart: Date;
  /** T0 */
  openingSnapshotAt: Date;
  timezone: string;
  /** الحالة الملتقطة عند cutoverStart (replay captureAt) — لـuncostedAtCutover وnegativeAtCutover */
  atCutover: CostState | null;
  streamWarnings?: readonly StreamWarning[];
}

// ═══ أثر الدفاتر لكل لقطة (accounts.ts) ═══

export type CounterRole = 'GRNI' | 'VENDOR' | 'ADJUSTMENT' | 'NONE';

/**
 * أثر لقطة على الدفاتر بعلامة المدين (+) — متوازن دائماً:
 * Σ inventory + cogsMilli + writeOffMilli + counterMilli = 0.
 * المخزون: WH ⇒ 114001، VAN:<rep> ⇒ 114002 بمندوبه. cogs ⇒ 511001 (أو تكلفة الفئة). writeOff ⇒ 514001.
 * counter: GRNI ⇒ 211002 (الوارد)، VENDOR ⇒ مقابل مرتجع المورّد (L6)، ADJUSTMENT ⇒ 514002/514001/113003/611009 بسبب التسوية (L6).
 */
export interface GlImpact {
  inventory: { location: LocationKey; milli: Milli }[];
  cogsMilli: Milli;
  writeOffMilli: Milli;
  counterMilli: Milli;
  counterRole: CounterRole;
}
