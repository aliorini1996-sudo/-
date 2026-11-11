// ============================================================================
// «تتبّع اللوط» (التشغيلة) في الواجهة — أساسٌ صرف تشترك فيه كل الشاشات.
// ----------------------------------------------------------------------------
// ١. الأنواع المرآة لعقود الخادم (backend/src/services/lots.ts §٢.٨) كما تصل عبر
//    الشبكة: كل تاريخ يوم YYYY-MM-DD وكل لحظة نصّ ISO، ولا Map.
// ٢. التسميات: نصوص عربية هي مفاتيح القاموس (strings.ts، كتلة W0) تُعرض بـtr(…).
//    والخرائط الثابتة لا يلتقطها حارس langs.test، فاختبار هذه الوحدة يحرس وجودها.
// ٣. التحقق قبل الإرسال ومرايا القواعد (الرقم المطبَّع، والتواريخ، والانتهاء،
//    وFEFO، والكمية الأساسية). الخادم صاحب القرار، وهذه للعرض والتحقق المسبق.
//
// كل كمية هنا **بوحدة الأساس** (D22)، و`lotId: null` = «غير مسمّى» صراحةً.
// ============================================================================

import { roundHalfUp } from './money';
import { baseQtyOf } from './units';

export const LOT_EPS = 1e-6;
/** صفوف لوط لكل سطر في الطلب */
export const LOT_MAX_ROWS = 20;
export const LOT_NUMBER_MAX = 64;

/** تقريب أربع خانات نصف لأعلى — كرصيد الصنف (roundLot = roundDecimal(n, 4) في الخادم)، و−0 يُعرض صفراً */
export const roundLot = (n: number): number => {
  const r = roundHalfUp(n, 4);
  return Object.is(r, -0) ? 0 : r;
};

export const LOT_STATUSES = ['ACTIVE', 'BLOCKED'] as const;
export const LOT_BLOCK_KINDS = ['HOLD', 'RECALL'] as const;
export const LOT_CERTAINTIES = ['CONFIRMED', 'ASSUMED', 'UNKNOWN'] as const;
export const LOT_BUCKETS = ['SELLABLE', 'EXPIRED', 'DAMAGED'] as const;
export const LOT_PLACES = ['WAREHOUSE', 'VAN'] as const;
export const LOT_SOURCES = ['RECEIVE', 'LOAD', 'OPENING_IMPORT', 'RELABEL', 'RETURN', 'MANUAL'] as const;
export const LOT_RELABEL_REASONS = ['LABEL_EXISTING', 'RECLASSIFY', 'CORRECTION'] as const;
export const LOT_ROW_FLAGS = ['REPLAY_BLOCKED', 'REPLAY_RECALLED', 'REPLAY_EXPIRED', 'REPLAY_CLAMPED', 'HINT_REJECTED', 'SPLIT_UNIT'] as const;
export const LOT_EVENT_KINDS = ['CREATE', 'UPDATE_DATES', 'UPDATE_NOTE', 'BLOCK', 'UNBLOCK', 'DELETE', 'RELABEL', 'TRACKING_ON', 'TRACKING_OFF'] as const;
export const LOT_VAN_REASONS = ['EXPIRED_UNSOLD_DESTROY'] as const;
/** = loadSchema.type في الخادم — لا نوع حركة جديد للّوط */
export const VAN_MOVE_TYPES = ['LOAD', 'UNLOAD', 'ADJUST', 'EXPIRED_OUT', 'DAMAGED_OUT'] as const;
/** تحذيرات لا تمنع — تأتي في warnings[] من ردود الإصدار والحركة */
export const LOT_WARNING_CODES = ['LOT_MULTI_IN_VAN', 'LOT_HINT_REJECTED', 'LOT_INTO_BLOCKED', 'LOT_SPLIT_UNIT', 'LOT_FROM_UNKNOWN', 'LOT_REPLAY_FLAGGED'] as const;
/** رموز LotError كما يكتبها الخادم حرفياً (§٣.٣) */
export const LOT_ERROR_CODES = [
  'LOTS_NOT_ALLOWED', 'LOTS_DISABLED', 'LOT_SCOPED_USER',
  'LOT_REQUIRED', 'LOT_NOT_FOUND', 'LOT_PRODUCT_MISMATCH', 'LOT_BLOCKED', 'LOT_EXPIRED', 'LOT_QTY_INVALID',
  'LOT_DATES_INVALID', 'LOT_EXPIRY_REQUIRED', 'LOT_RELABEL_INVALID', 'LOT_REASON_REQUIRED',
  'LOT_STOCK_INSUFFICIENT', 'LOT_DATES_MISMATCH', 'LOT_NUMBER_TAKEN', 'LOT_IN_USE', 'LOT_CHANGED',
  'LOT_TRACKING_HAS_BALANCE', 'LOT_REPLAY_HELD', 'LOT_RECORDS_RETAINED',
  'LOT_BUSY',
] as const;

export type LotStatus = typeof LOT_STATUSES[number];
export type LotBlockKind = typeof LOT_BLOCK_KINDS[number];
export type LotCertainty = typeof LOT_CERTAINTIES[number];
export type LotBucket = typeof LOT_BUCKETS[number];
export type LotPlace = typeof LOT_PLACES[number];
export type LotSource = typeof LOT_SOURCES[number];
export type LotRelabelReason = typeof LOT_RELABEL_REASONS[number];
export type LotRowFlag = typeof LOT_ROW_FLAGS[number];
export type LotEventKind = typeof LOT_EVENT_KINDS[number];
export type VanMoveType = typeof VAN_MOVE_TYPES[number];
export type LotWarningCode = typeof LOT_WARNING_CODES[number];
export type LotErrorCode = typeof LOT_ERROR_CODES[number];
export type BucketQty = Record<LotBucket, number>;
export const zeroBuckets = (): BucketQty => ({ SELLABLE: 0, EXPIRED: 0, DAMAGED: 0 });

// ─── الأشكال عبر الشبكة (مرآة §٢.٨) ───

/** LotMeta — productionDate وexpiryDate يوما YYYY-MM-DD، وblockedAt وcreatedAt لحظتان ISO */
export interface LotMetaDto {
  id: string; productId: string; lotNumber: string;
  productionDate: string | null; expiryDate: string | null;
  status: LotStatus; blockKind: LotBlockKind | null; blockedAt: string | null; createdAt: string;
}

/** صفّ ProductLot كما يُكشف (بلا tenantId ولا sourceEntryId) — أساس بطاقة اللوط وقائمته */
export interface ProductLotDto extends LotMetaDto {
  blockReason: string | null; blockedBy: string | null; note: string | null;
  source: LotSource; createdBy: string | null; updatedAt: string;
}

/** صفّ توزيعٍ في طلب — lotId: null = «غير مسمّى»، والكمية أساسية موجبة */
export interface LotRef { lotId: string | null; qty: number }

export interface LotBalanceDto { lotId: string; meta: LotMetaDto; raw: BucketQty; held: BucketQty; usable: BucketQty /* raw − held */ }

/** PlaceLotView عبر الشبكة — firstInAt داخليّ لطبقات الإعادة فلا يُعتمد عليه هنا */
export interface PlaceLotViewDto {
  productId: string; place: LotPlace; vanKey: string | null;
  total: BucketQty | null;          // رصيد الصنف القائم؛ null لسيارة مندوب محذوف
  lots: LotBalanceDto[];            // بترتيب FEFO
  unknown: BucketQty | null;        // total − Σ الخام المسمّى (قد يكون سالباً ⇒ «عجز غير مسمّى»)
  unknownUsable: BucketQty | null;  // unknown − المحجوز غير المسمّى
  deficits: LotDeficitDto[];
  approximate: boolean;
}
/** خامٌ أو صالحٌ سالب — للشارة و/lots/health؛ lotId: null = غير المسمّى */
export interface LotDeficitDto { lotId: string | null; bucket: LotBucket; qty: number }

/** ردّ GET /lots/balances */
export interface LotBalancesDto {
  warehouse: PlaceLotViewDto[];
  vans: { salesRepId: string; repName: string | null; deleted: boolean; view: PlaceLotViewDto }[];
}

export interface AllocRowDto {
  lotId: string | null; qty: number; certainty: LotCertainty; flags: LotRowFlag[]; expiryDate: string | null;
  sourceItemLotId?: string | null;
}
export interface LotWarning { code: LotWarningCode; productId: string; detail?: Record<string, unknown> }

/** تفصيل LOT_STOCK_INSUFFICIENT (allocateOut) — وهو shortage في ردّ /lots/fefo */
export interface LotShortageDetail {
  productId: string; wanted: number; available: number;
  byLot: { lotId: string; lotNumber: string; usable: number; status: LotStatus; expiryDate: string | null }[];
  unknownUsable: number;
}
/** ردّ GET /lots/fefo — اقتراح بلا قفل */
export interface LotFefoDto { rows: AllocRowDto[]; shortage?: LotShortageDetail; warnings: LotWarning[] }

/** لقطة سيارة المندوب (GET /van-stock/lot-balances) — مرجع المتاح دون اتصال (§٧) */
export interface VanLotSnapshotDto {
  serverTime: string; day: string; tracked: string[]; allowUnknown: boolean;
  products: {
    productId: string; available: number; availableNamed: number; unknownUsable: number; quarantined: number; held: number;
    expiredUnsold: number; expiredReturned: number; damaged: number;
    lots: { lotId: string; lotNumber: string; expiryDate: string | null; status: LotStatus; blockKind: LotBlockKind | null; usable: number }[];
  }[];
}

/** شاشة التتبّع (GET /lots/:id/trace) */
export interface LotTraceDto {
  lot: LotMetaDto & { productName: string; source: string; note: string | null };
  origin: { kind: string; at: string; ref: string | null; qty: number }[];
  places: {
    place: LotPlace; salesRepId: string | null; repName: string | null; raw: BucketQty; usable: BucketQty; held: BucketQty; approximate: boolean;
    loaded: number; unloaded: number; sold: number; returned: number;
  }[];
  customers: {
    customerId: string; name: string; phone: string | null; address: string | null; city: string | null;
    invoices: { invoiceId: string; number: string; date: string; sold: number; returned: number; net: number; weakest: LotCertainty; flags: LotRowFlag[]; broad: boolean }[];
  }[] | null;
  customersHidden: boolean; scoped: boolean; scope: 'STRICT' | 'BROAD';
  events: { kind: string; at: string; actorName: string | null; reason: string | null }[];
}

/** سجل التدقيق (GET /lots/:id/events) */
export interface LotEventDto {
  id: string; lotId: string | null; productId: string; kind: LotEventKind;
  before: unknown; after: unknown; reason: string | null; actorType: string; actorName: string | null; createdAt: string;
}

/** سيارةٌ في خطة التنزيل بعد الإيقاف (GET /lots/:id/unload-plan) — المحذوفة ضمنها وتُنزَّل بـdeletedSalesRepId */
export interface LotUnloadPlanDto { salesRepId: string; repName: string | null; deleted: boolean; usable: BucketQty; held: BucketQty }

/** ردّ التفعيل الجماعي (POST /lots/products/tracking) — ما يحتاج تسمية أو تصحيح سالب قبل البيع */
export interface LotTrackingResultDto {
  updated: number;
  needsAttention: {
    productId: string; name: string;
    warehouse: { total: number; unknown: number } | null;
    vans: { salesRepId: string; total: number; unknown: number }[];
  }[];
}

/** صفّ توزيع بند الفاتورة كما يضمّه الخادم (withLots=1 أو ردّ الإصدار) — expiryDate لقطة وقت الإصدار */
export interface InvoiceItemLotDto {
  id: string; invoiceItemId: string; invoiceId: string; productId: string; vanKey: string | null;
  lotId: string | null; quantity: number; certainty: LotCertainty; expiryDate: string | null;
  sourceItemLotId: string | null; flags: string | null; createdAt: string;
  lot?: { lotNumber: string; expiryDate: string | null } | null;
}

/** صفّ توزيع بند حركة السيارة (withLots=1 في /van-stock/loads و/movements) — qty بإشارة البند */
export interface VanLoadItemLotDto {
  id: string; vanLoadItemId: string; productId: string; vanKey: string; moveType: VanMoveType; viaWarehouse: boolean;
  lotId: string | null; qty: number; certainty: LotCertainty; reason: string | null; createdAt: string;
  lot?: { lotNumber: string; expiryDate: string | null } | null;
}

// ─── أجسام الطلبات ───

export interface LotListParams {
  q?: string; productId?: string; status?: LotStatus; expiringWithinDays?: number; page?: number; limit?: number;
}
export interface LotCreateRequest { productId: string; lotNumber?: string | null; productionDate?: string | null; expiryDate?: string | null; note?: string | null }
/** updatedAt نسخةٌ يرفض الخادم ما يخالفها (LOT_CHANGED)، ومدّ الانتهاء للوط له حركات يلزمه reason */
export interface LotUpdateRequest { productionDate?: string | null; expiryDate?: string | null; note?: string | null; reason?: string; updatedAt: string }
export interface LotStatusRequest { status: LotStatus; blockKind?: LotBlockKind; reason: string; updatedAt: string }
/** RelabelInput عبر الشبكة (بلا ما يشتقّه الخادم: الشركة واليوم والفاعل) */
export interface LotRelabelRequest {
  productId: string; place: LotPlace; vanKey: string | null; bucket: LotBucket;
  fromLotId: string | null; reason: LotRelabelReason; note: string | null;
  lines: { toLotId?: string | null; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null; qty: number }[];
}
export interface LotTrackingRequest { enabled: boolean; productIds?: string[]; categoryId?: string; all?: true; confirmLotBalances?: boolean }

// ─── التسميات (مفاتيح القاموس — تُعرض بـtr) ───

export const LOT_CERTAINTY_LABELS: Record<LotCertainty, string> = { CONFIRMED: 'مؤكد', ASSUMED: 'مفترض', UNKNOWN: 'غير معروف' };
export const LOT_STATUS_LABELS: Record<LotStatus, string> = { ACTIVE: 'نشطة', BLOCKED: 'تشغيلة موقوفة' };
export const LOT_BLOCK_KIND_LABELS: Record<LotBlockKind, string> = { HOLD: 'إيقاف احترازي', RECALL: 'سحب من السوق' };
export const LOT_BUCKET_LABELS: Record<LotBucket, string> = { SELLABLE: 'صالح للبيع', EXPIRED: 'منتهي الصلاحية', DAMAGED: 'تالف' };
export const LOT_PLACE_LABELS: Record<LotPlace, string> = { WAREHOUSE: 'المستودع', VAN: 'سيارة المندوب' };
export const VAN_MOVE_TYPE_LABELS: Record<VanMoveType, string> = {
  LOAD: 'تحميل', UNLOAD: 'تنزيل للمستودع', ADJUST: 'تسوية', EXPIRED_OUT: 'إزالة منتهي الصلاحية', DAMAGED_OUT: 'إزالة التالف',
};
export const LOT_SOURCE_LABELS: Record<LotSource, string> = {
  RECEIVE: 'وارد للمستودع', LOAD: 'تحميل مباشر للسيارة', OPENING_IMPORT: 'مخزون افتتاحي',
  RELABEL: 'تسمية أو إعادة تصنيف', RETURN: 'مرتجع', MANUAL: 'إدخال يدوي',
};
export const LOT_RELABEL_REASON_LABELS: Record<LotRelabelReason, string> = {
  LABEL_EXISTING: 'تسمية الرصيد القائم', RECLASSIFY: 'إعادة التصنيف', CORRECTION: 'تصحيح',
};
export const LOT_ROW_FLAG_LABELS: Record<LotRowFlag, string> = {
  REPLAY_BLOCKED: 'صرف دون اتصال من تشغيلة موقوفة',
  REPLAY_RECALLED: 'صرف دون اتصال من تشغيلة مسحوبة',
  REPLAY_EXPIRED: 'صرف دون اتصال من تشغيلة منتهية',
  REPLAY_CLAMPED: 'وقت الجهاز خارج المدى المقبول',
  HINT_REJECTED: 'رفض تلميح الجهاز ووزعت الكمية بالقاعدة',
  SPLIT_UNIT: 'وحدة موزعة على أكثر من تشغيلة',
};
export const LOT_EVENT_KIND_LABELS: Record<LotEventKind, string> = {
  CREATE: 'إنشاء التشغيلة', UPDATE_DATES: 'تعديل تواريخ التشغيلة', UPDATE_NOTE: 'تعديل ملاحظة التشغيلة',
  BLOCK: 'إيقاف التشغيلة', UNBLOCK: 'إعادة تنشيط التشغيلة', DELETE: 'حذف التشغيلة',
  RELABEL: 'تسمية أو إعادة تصنيف', TRACKING_ON: 'تفعيل تتبع الصنف بـLOT', TRACKING_OFF: 'إطفاء تتبع الصنف بـLOT',
};
export const LOT_WARNING_LABELS: Record<LotWarningCode, string> = {
  LOT_MULTI_IN_VAN: 'في السيارة أكثر من تشغيلة لهذا الصنف',
  LOT_HINT_REJECTED: 'رفض تلميح الجهاز ووزعت الكمية بالقاعدة',
  LOT_INTO_BLOCKED: 'أضيفت الكمية إلى تشغيلة موقوفة فتبقى معزولة',
  LOT_SPLIT_UNIT: 'وحدة موزعة على أكثر من تشغيلة',
  LOT_FROM_UNKNOWN: 'صرف جزء من الكمية من رصيد غير مسمى',
  LOT_REPLAY_FLAGGED: 'فاتورة دون اتصال صرفت بوسم مراجعة',
};

// ─── مرايا القواعد ───

/** يوم YYYY-MM-DD من نصّ يوم أو لحظة ISO (عمود @db.Date يصل "…T00:00:00.000Z") — وإلا null */
export function lotDay(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(v.trim());
  return m ? m[1] : null;
}

/** منتهية يوم day؟ — يوم الانتهاء نفسه آخر يوم صالح، وبلا انتهاء لا تنتهي (isLotExpiredOn في الخادم) */
export function isLotExpiredOn(meta: { expiryDate?: string | null }, day: string): boolean {
  const exp = lotDay(meta.expiryDate);
  return exp !== null && day > exp;
}

/** ترتيب FEFO: الانتهاء تصاعدياً ثم الإنتاج (null آخراً فيهما)، ثم createdAt، ثم الرقم، ثم المعرّف — ما غاب من الحقول يُتخطّى */
export function fefoCompare(
  a: { expiryDate?: string | null; productionDate?: string | null; createdAt?: string | null; lotNumber?: string | null; id?: string; lotId?: string | null },
  b: typeof a,
): number {
  const nullsLast = (x: string | null, y: string | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1);
  return nullsLast(lotDay(a.expiryDate), lotDay(b.expiryDate))
    || nullsLast(lotDay(a.productionDate), lotDay(b.productionDate))
    || cmp(a.createdAt ?? '', b.createdAt ?? '')
    || cmp(a.lotNumber ?? '', b.lotNumber ?? '')
    || cmp(a.id ?? a.lotId ?? '', b.id ?? b.lotId ?? '');
}
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** مصدرٌ للسحب التلقائي بصالحه بالأساس — lotId: null = «غير مسمّى» */
export interface FefoPullSource { lotId: string | null; expiryDate?: string | null; usable: number }
export interface FefoPullResult {
  /** صفوف كل سطرٍ بترتيب الأسطر (موجبة بالأساس، المسمّاة بترتيب السحب ثم غير المسمّى) — فارغةٌ كلها مع short */
  rows: LotRef[][];
  /** مجموع الأسطر فوق المتاح ⇒ الخادم يردّ LOT_STOCK_INSUFFICIENT */
  short: boolean;
  /** سطرٌ بكميةٍ أدقّ من أربع خانات ⇒ الخادم يردّه LOT_QTY_INVALID (isLotQty) — لا معاينة بتقريبه */
  qtyInvalid?: boolean;
  wanted: number;
  available: number;
}

/**
 * مرآة pickOutFefoLines في الخادم — السحب التلقائي لإنقاصٍ بلا صريح (طلب المالك ١ نوفمبر ٢٠٢٦ بدل «المصدر الوحيد وإلا
 * LOT_REQUIRED» في D10): التنزيل، وتسوية النقص في المستودع والسيارة، وإزالة المنتهي والتالف. المسمّاة بالأقرب انتهاءً أولاً
 * (بلا انتهاء آخرها، والموقوفة والمنتهية منها) ثم غير المسمّى آخراً (D17). والتعادل بترتيب `sources` كما وصلت: العرض مرتّبٌ
 * في الخادم بـfefoCompare كاملاً (الإنتاج والإنشاء لا يصلان هنا) فالفرز المستقرّ لا يقلبه. متاحٌ مشترك بين الأسطر (D26) **بترتيب
 * الخدمة** (D22، cartonRank كـallocateOutLines): الوحدة الأكبر أولاً (رتبة F إن كان > 1 وإلا ١) تنازلياً والتعادل بترتيب الأسطر —
 * فيأخذ الكرتون كراتينه كاملةً قبل أن تقتطع الحبّات منها — والصفوف تعود بترتيب الأسطر كما دخلت. ولكل سطرٍ قاعدة الكرتون:
 * مضاعفات معامله كاملةً من تشغيلةٍ واحدة بالترتيب أولاً، ثم الباقي قِطعاً بالترتيب، ثم غير المسمّى. للمعاينة وحدها — الخادم يحسم.
 */
export function fefoAutoPull(sources: readonly FefoPullSource[], lines: readonly { qty: number; unitFactor?: number | null }[]): FefoPullResult {
  const nullsLast = (x: string | null, y: string | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1);
  const named = sources.map((s, i) => ({ s, i }))
    .filter((x) => x.s.lotId !== null && x.s.usable > LOT_EPS)
    .sort((a, b) => nullsLast(lotDay(a.s.expiryDate), lotDay(b.s.expiryDate)) || a.i - b.i)
    .map((x) => x.s);
  const uu = Math.max(0, sources.filter((s) => s.lotId === null).reduce((t, s) => t + s.usable, 0));
  const raw = lines.map((l) => (Number.isFinite(Number(l.qty)) ? Math.abs(Number(l.qty)) : 0));
  const qtys = raw.map((q) => roundLot(q));
  if (raw.some((q, i) => Math.abs(qtys[i] - q) > 1e-9 * Math.max(1, q))) {
    return { rows: lines.map(() => []), short: false, qtyInvalid: true, wanted: roundLot(qtys.reduce((t, q) => t + q, 0)), available: 0 };
  }
  const wanted = roundLot(qtys.reduce((t, q) => t + q, 0));
  const available = roundLot(named.reduce((t, s) => t + s.usable, 0) + uu);
  if (wanted > available + LOT_EPS) return { rows: lines.map(() => []), short: true, wanted, available };
  const pool = new Map(named.map((s) => [s.lotId as string, s.usable]));
  /** صفوف سطرٍ واحد مما تركه ما خُدم قبله */
  const pullLine = (l: { qty: number; unitFactor?: number | null }, i: number): LotRef[] => {
    let left = qtys[i];
    if (left <= LOT_EPS) return [];
    const taken = new Map<string, number>();
    const take = (id: string, t: number) => {
      taken.set(id, (taken.get(id) ?? 0) + t);
      pool.set(id, (pool.get(id) ?? 0) - t);
      left = t === left ? 0 : left - t;
    };
    const F = Number(l.unitFactor);
    if (Number.isFinite(F) && F > 1) {
      for (const s of named) {
        if (left <= LOT_EPS) break;
        const k = Math.floor((Math.min(pool.get(s.lotId as string) ?? 0, left) + LOT_EPS) / F);
        if (k > 0) take(s.lotId as string, Math.abs(k * F - left) <= LOT_EPS ? left : k * F);
      }
    }
    for (const s of named) {
      if (left <= LOT_EPS) break;
      const a = pool.get(s.lotId as string) ?? 0;
      if (a > LOT_EPS) take(s.lotId as string, a >= left - LOT_EPS ? left : a);
    }
    const out: LotRef[] = named.filter((s) => taken.has(s.lotId as string)).map((s) => ({ lotId: s.lotId, qty: roundLot(taken.get(s.lotId as string)!) }));
    // المجموع ≤ المتاح فما بقي من السطر في غير المسمّى
    if (left > LOT_EPS) out.push({ lotId: null, qty: roundLot(left) });
    return out;
  };
  // ترتيب الخدمة (cartonRank في الخادم): الوحدة الأكبر أولاً والأساس (والمعامل التالف) آخراً، والتعادل بترتيب الأسطر
  const cartonRank = (f: number | null | undefined) => (Number.isFinite(Number(f)) && Number(f) > 1 ? Number(f) : 1);
  const rows: LotRef[][] = lines.map(() => []);
  lines.map((l, i) => ({ l, i }))
    .sort((a, b) => cartonRank(b.l.unitFactor) - cartonRank(a.l.unitFactor) || a.i - b.i)
    .forEach(({ l, i }) => { rows[i] = pullLine(l, i); });
  return { rows, short: false, wanted, available };
}

/** محارف الاتجاه غير المرئية (نسخٌ من نصّ عربي) — يحذفها الخادم قبل التطبيع */
const INVISIBLE_RE = /[​-‏‪-‮⁦-⁩﻿؜]/g;

/**
 * رقم التشغيلة المطبَّع (normalizeLotNumber في الخادم، والتفرّد عليه): حذف محارف الاتجاه، والأرقام العربية-الهندية
 * والفارسية إلى لاتينية، ودمج المسافات وقصّ الأطراف، والحروف اللاتينية كبيرة. الفارغ أو ما تجاوز ٦٤ حرفاً null.
 */
export function normalizeLotNumber(raw: unknown): string | null {
  let s: string;
  if (typeof raw === 'string') s = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) s = String(raw);
  else return null;
  s = s
    .replace(INVISIBLE_RE, '')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[a-z]/g, c => c.toUpperCase());
  return s && s.length <= LOT_NUMBER_MAX ? s : null;
}

const validDay = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

/** صحّة تاريخَي التشغيلة (lotDatesProblem في الخادم) — '' كغياب، والانتهاء إلزامي لصنفٍ صلاحيته مفعّلة */
export function lotDatesProblem(
  production: string | null | undefined, expiry: string | null | undefined, opts: { expiryRequired: boolean },
): 'LOT_DATES_INVALID' | 'LOT_EXPIRY_REQUIRED' | null {
  const p = production === '' || production === undefined ? null : production;
  const e = expiry === '' || expiry === undefined ? null : expiry;
  if (p != null && !validDay(p)) return 'LOT_DATES_INVALID';
  if (e != null && !validDay(e)) return 'LOT_DATES_INVALID';
  if (opts.expiryRequired && e == null) return 'LOT_EXPIRY_REQUIRED';
  if (p != null && e != null && p > e) return 'LOT_DATES_INVALID';
  return null;
}

/**
 * الكمية الأساسية (D19، الوحدات أولاً) = baseQtyOf (lib/units.ts) حرفياً، كما lotBaseQty في الخادم = baseQtyOf فيه:
 * العمود المخزَّن مقرَّباً، وإلا qty × المعامل (التالف ١).
 */
export function toBaseQty(row: { qty: number; baseQty?: number | null; unitFactor?: number | null }): number {
  return baseQtyOf(row);
}

/**
 * صفوف السطر قبل الإرسال — مرآة parseLotRefsStrict: مصفوفة حتى LOT_MAX_ROWS، كل صفّ بمعرّف نصّي أو null وكمية
 * موجبة، ومجموعها = الكمية الأساسية للسطر (بسماحية LOT_EPS). الغياب والمصفوفة الفارغة ليسا خطأً: الخادم يوزّع.
 */
export function lotRowsProblem(rows: readonly LotRef[] | null | undefined, lineBaseQty: number): 'LOT_QTY_INVALID' | null {
  if (rows == null || (Array.isArray(rows) && rows.length === 0)) return null;
  if (!Array.isArray(rows) || rows.length > LOT_MAX_ROWS || !Number.isFinite(lineBaseQty)) return 'LOT_QTY_INVALID';
  let sum = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') return 'LOT_QTY_INVALID';
    const idOk = r.lotId === null || (typeof r.lotId === 'string' && r.lotId.length > 0 && r.lotId.length <= 128);
    if (!idOk || typeof r.qty !== 'number' || !Number.isFinite(r.qty) || !(r.qty > LOT_EPS)) return 'LOT_QTY_INVALID';
    sum += r.qty;
  }
  return Math.abs(sum - lineBaseQty) <= LOT_EPS ? null : 'LOT_QTY_INVALID';
}

/** ما بقي من السطر بلا توزيع — موجبٌ ناقص وسالبٌ زائد (عدّاد الواجهة) */
export function lotRowsRemaining(rows: readonly LotRef[] | null | undefined, lineBaseQty: number): number {
  const sum = (rows ?? []).reduce((s, r) => s + (Number.isFinite(r?.qty) ? r.qty : 0), 0);
  return roundLot(lineBaseQty - sum);
}

/** وسوم صفّ التوزيع — عمودٌ نصّي مفصول بفاصلة، والمجهول منها يسقط */
export function parseLotFlags(flags: string | null | undefined): LotRowFlag[] {
  if (!flags) return [];
  const known = new Set<string>(LOT_ROW_FLAGS);
  return flags.split(',').map(f => f.trim()).filter((f): f is LotRowFlag => known.has(f));
}

/** علما الشركة من /company (أو المخزّنة) — نسخةٌ قديمة بلا العلم تُعامَل إطفاءً، والطباعة لا تسري إلا مع الميزة */
export function lotFlagsOf(company: { lotTrackingEnabled?: unknown; lotOnInvoice?: unknown } | null | undefined): { on: boolean; onInvoice: boolean } {
  const on = company?.lotTrackingEnabled === true;
  return { on, onInvoice: on && company?.lotOnInvoice === true };
}

export interface LotErrorInfo { status: number | null; code: LotErrorCode; message: string | null; detail: Record<string, unknown> | null }

/** خطأ اللوط من ردّ axios (code معروف وحده) — وإلا null فيعرض المستدعي رسالته العامة */
export function lotErrorOf(err: unknown): LotErrorInfo | null {
  const r = (err as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  const d = r && r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : null;
  if (!d || typeof d.code !== 'string' || !(LOT_ERROR_CODES as readonly string[]).includes(d.code)) return null;
  return {
    status: typeof r?.status === 'number' ? r.status : null,
    code: d.code as LotErrorCode,
    message: typeof d.message === 'string' ? d.message : null,
    detail: d.detail && typeof d.detail === 'object' && !Array.isArray(d.detail) ? (d.detail as Record<string, unknown>) : null,
  };
}

/** warnings[] من الردّ — المعروف منها وحده، وشكلٌ غير متوقَّع يعود فارغاً (التحذير لا يُسقط الشاشة) */
export function lotWarningsOf(raw: unknown): LotWarning[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(LOT_WARNING_CODES);
  return raw.filter((w): w is LotWarning => !!w && typeof w === 'object'
    && typeof (w as LotWarning).code === 'string' && known.has((w as LotWarning).code)
    && typeof (w as LotWarning).productId === 'string');
}

/** سطر تشغيلةٍ على ورقة مطبوعة — lotNumber: null = «غير معروف»، والكمية أساسية مطلقة */
export interface DocLotLine { lotNumber: string | null; qty: number; expiryDate?: string | null }

/**
 * صفوف توزيع بندٍ (فاتورة: quantity، أو حركة سيارة: qty بإشارتها) إلى أسطر الورقة. الانتهاء لقطة الصفّ إن حملها (صفّ
 * الفاتورة: انتهاء اللوط وقت الإصدار، ولو null — §٤.٣: تعديل اللوط بعدها لا يغيّر ورقةً بيد العميل)، وإلا من اللوط المضموم
 * (صفّ حركة السيارة لا عمود انتهاء له). غير المصفوفة أو الفارغة undefined: البند بلا تشغيلات لا يطبع شيئاً.
 */
export function docLotsFrom(rows: unknown): DocLotLine[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const out: DocLotLine[] = [];
  for (const r of rows as Partial<InvoiceItemLotDto & VanLoadItemLotDto>[]) {
    if (!r || typeof r !== 'object') continue;
    const q = Number(r.quantity ?? r.qty);
    if (!Number.isFinite(q) || Math.abs(q) <= LOT_EPS) continue;
    out.push({
      lotNumber: r.lotId ? r.lot?.lotNumber ?? null : null,
      qty: roundLot(Math.abs(q)),
      expiryDate: r.expiryDate !== undefined ? lotDay(r.expiryDate) : lotDay(r.lot?.expiryDate),
    });
  }
  return out.length ? out : undefined;
}
