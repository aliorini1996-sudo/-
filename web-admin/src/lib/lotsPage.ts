// ============================================================================
// صفحة «التشغيلات» (pages/LotsPage.tsx) — المنطق الصرف: أشكال ردود /api/lots كما يكتبها routes/lots.ts وservices/lotsTrace.ts،
// وأفعال الحالة، ومرايا قيود D27 قبل الإرسال، وجسم التنزيل بعد الإيقاف (D30)، وأوراق Excel لشاشة التتبّع.
// الخادم صاحب القرار في كل شيء؛ هذه للعرض والتحقق المسبق. كل كمية بوحدة الأساس (D22).
// ============================================================================

import {
  LOT_BUCKET_LABELS, LOT_CERTAINTY_LABELS, LOT_EPS, LOT_EVENT_KIND_LABELS, LOT_PLACE_LABELS, LOT_ROW_FLAG_LABELS, LOT_SOURCE_LABELS,
  LOT_STATUS_LABELS, LOT_BLOCK_KIND_LABELS, isLotExpiredOn, lotDatesProblem, lotDay, normalizeLotNumber, roundLot,
  type BucketQty, type LotBlockKind, type LotBucket, type LotEventKind, type LotPlace, type LotRelabelReason, type LotSource,
  type LotStatus, type LotTraceDto, type LotUnloadPlanDto, type PlaceLotViewDto, type ProductLotDto,
} from './lots';
import type { ExcelSheet } from '../utils/excel';

type Tr = (ar: string) => string;

// ─── أشكال الردود (routes/lots.ts) ───

/** رصيد اللوط في مكان (lotSummaries.places) */
export interface LotPlaceBalanceDto {
  place: LotPlace; salesRepId: string | null; repName: string | null; deleted: boolean;
  raw: BucketQty; held: BucketQty; usable: BucketQty;
}
/** ملخّص أرصدة البطاقة: خام المستودع، ومجموع دلاء السيارات المرئية، ومحجوزها، وعددها، والإجمالي، وتفصيل الأماكن */
export interface LotSummaryDto {
  warehouse: number; vans: BucketQty; held: number; vanCount: number; total: number;
  places?: LotPlaceBalanceDto[];
}
/** صفّ GET /lots */
export interface LotListRow extends ProductLotDto {
  productName: string; productCode: string | null; productUnit: string | null;
  summary: LotSummaryDto | null;
}
/** GET /lots/:id — inUse: للبطاقة حركات (لا تُحذف، ومدّ انتهائها لغير المقيّد بسبب) */
export interface LotDetailDto extends ProductLotDto {
  product: { id: string; name: string; code: string | null; unit: string | null; lotTracked: boolean; shelfLifeOn: boolean };
  expired: boolean; day: string; inUse: boolean; summary: LotSummaryDto | null; scoped: boolean;
}
/** عجزٌ في /lots/health — lotId: null = غير المسمّى */
export interface LotDeficitRow {
  productId: string; productName: string | null; place: LotPlace; salesRepId: string | null; repName: string | null;
  lotId: string | null; lotNumber: string | null; bucket: LotBucket; qty: number;
}
/** توافر المكان كما يحسبه splitAvailability في الخادم */
export interface LotAvailabilityDto {
  available: number; availableNamed: number; availableUnknown: number; quarantined: number; expiredUnsold: number;
  held: number; expiredReturned: number; damaged: number; unknownDeficit: number;
}
export type PlaceViewWithAvailability = PlaceLotViewDto & { availability?: LotAvailabilityDto };
/** GET /lots/balances كما يردّه موجّه اللوط (مع اليوم والنطاق) */
export interface LotBalancesResponse {
  asOf: string | null; day: string; scoped: boolean;
  warehouse: PlaceViewWithAvailability[];
  vans: { salesRepId: string; repName: string | null; deleted: boolean; view: PlaceViewWithAvailability }[];
}

// ─── الحالة والإيقاف والسحب (§٤.١٦) ───

export interface LotStatusAction { status: LotStatus; blockKind?: LotBlockKind; label: string; danger: boolean }

/**
 * أفعال الحالة المتاحة: النشطة تُوقف احترازياً أو تُسحب، والموقوفة احترازياً تُصعَّد سحباً أو تُعاد، والمسحوبة تُعاد وحدها.
 * التسميات مفاتيح القاموس (tr).
 */
export function statusActions(lot: Pick<ProductLotDto, 'status' | 'blockKind'>): LotStatusAction[] {
  const hold: LotStatusAction = { status: 'BLOCKED', blockKind: 'HOLD', label: 'إيقاف احترازي', danger: false };
  const recall: LotStatusAction = { status: 'BLOCKED', blockKind: 'RECALL', label: 'سحب من السوق', danger: true };
  const back: LotStatusAction = { status: 'ACTIVE', label: 'إعادة تنشيط التشغيلة', danger: false };
  if (lot.status !== 'BLOCKED') return [hold, recall];
  return lot.blockKind === 'RECALL' ? [back] : [recall, back];
}

/** النطاق الموسّع تلقائيٌّ في السحب: كل بيعٍ للصنف من السيارة في نافذة وجود اللوط فيها */
export const autoBroad = (lot: Pick<ProductLotDto, 'status' | 'blockKind'> | null | undefined): boolean =>
  !!lot && lot.status === 'BLOCKED' && lot.blockKind === 'RECALL';

/** حالة التشغيلة نصّاً (مفتاح قاموس): النشطة، أو نوع الإيقاف */
export const lotStatusLabel = (lot: Pick<ProductLotDto, 'status' | 'blockKind'>): string =>
  lot.status === 'BLOCKED' ? (lot.blockKind ? LOT_BLOCK_KIND_LABELS[lot.blockKind] : LOT_STATUS_LABELS.BLOCKED) : LOT_STATUS_LABELS.ACTIVE;

/** منتهية، أو تنتهي خلال soonDays، أو سارية، أو بلا انتهاء — يوم الانتهاء نفسه آخر يوم صالح */
export function expiryState(expiryDate: string | null | undefined, day: string, soonDays = 30): 'expired' | 'soon' | 'ok' | 'none' {
  const exp = lotDay(expiryDate);
  if (!exp) return 'none';
  if (isLotExpiredOn({ expiryDate: exp }, day)) return 'expired';
  const [y, m, d] = day.split('-').map(Number);
  const limit = new Date(Date.UTC(y, m - 1, d + soonDays)).toISOString().slice(0, 10);
  return exp <= limit ? 'soon' : 'ok';
}

/** مدّ الانتهاء (أو محوه) لتشغيلةٍ لها حركات — يلزمه سببٌ ومستخدمٌ غير مقيّد (D27، مرآة PATCH /lots/:id) */
export function extendsExpiry(before: string | null | undefined, after: string | null | undefined): boolean {
  const b = lotDay(before);
  if (b == null) return false;
  const a = lotDay(after);
  return a == null || a > b;
}

/**
 * جسم تنزيل التشغيلة من سيارة بعد إيقافها (POST /van-stock/loads): صالحها في «صالح للبيع» بلوطٍ صريح، والمحذوفة بـdeletedSalesRepId
 * (D30). الكمية أساسية (بلا وحدة ⇒ الأساس). لا صالح ⇒ null (المحجوز يُنزَّل بعد اعتماد إشعاره).
 */
export function unloadBody(lot: { id: string; productId: string }, row: LotUnloadPlanDto, note: string): {
  type: 'UNLOAD'; salesRepId?: string; deletedSalesRepId?: string; note: string;
  items: { productId: string; qty: number; lots: { lotId: string; qty: number }[] }[];
} | null {
  const qty = roundLot(row.usable?.SELLABLE ?? 0);
  if (!(qty > LOT_EPS)) return null;
  return {
    type: 'UNLOAD',
    ...(row.deleted ? { deletedSalesRepId: row.salesRepId } : { salesRepId: row.salesRepId }),
    note,
    items: [{ productId: lot.productId, qty, lots: [{ lotId: lot.id, qty }] }],
  };
}

// ─── التسمية وإعادة التصنيف (§٤.٦، D27) ───

/** مصدرٌ في مكانٍ ودلو: غير المسمّى (lotId: null) أو تشغيلة — usable صالحه للإنقاص، وblockedWhy سبب المنع (D27) */
export interface RelabelSource { lotId: string | null; lotNumber: string | null; usable: number; blockedWhy: string | null; expiryDate: string | null }

/** مصادر التسمية من عرض المكان: غير المسمّى إن كان صالحه موجباً، ثم كل تشغيلة لها صالح — الموقوفة والمنتهية ممنوعة بسببها */
export function relabelSources(view: PlaceLotViewDto | null | undefined, bucket: LotBucket, day: string): RelabelSource[] {
  if (!view) return [];
  const out: RelabelSource[] = [];
  const unk = roundLot(view.unknownUsable?.[bucket] ?? 0);
  if (unk > LOT_EPS) out.push({ lotId: null, lotNumber: null, usable: unk, blockedWhy: null, expiryDate: null });
  for (const l of view.lots) {
    const u = roundLot(l.usable?.[bucket] ?? 0);
    if (!(u > LOT_EPS)) continue;
    const blockedWhy = l.meta.status === 'BLOCKED' ? 'التشغيلة موقوفة لا يعاد تصنيفها'
      : isLotExpiredOn(l.meta, day) ? 'التشغيلة منتهية لا يعاد تصنيفها' : null;
    out.push({ lotId: l.lotId, lotNumber: l.meta.lotNumber, usable: u, blockedWhy, expiryDate: l.meta.expiryDate });
  }
  return out;
}

/**
 * المكان الذي تُفتح عليه نافذة التسمية: أول مكانٍ فيه المصدر الافتراضي صالحاً في «صالح للبيع» (غير المسمّى للتسمية، وهذه
 * التشغيلة لإعادة التصنيف) — فلا تُفتح على المستودع وصالح التشغيلة في سيارة. وإلا أول الأماكن، ولا أماكن ⇒ null.
 */
export function defaultRelabelPlace<P extends { view: PlaceLotViewDto | null | undefined }>(
  places: readonly P[], fromLotId: string | null, day: string,
): P | null {
  return places.find((p) => relabelSources(p.view, 'SELLABLE', day).some((s) => s.lotId === fromLotId && !s.blockedWhy))
    ?? places[0] ?? null;
}

/** سبب التسمية من طرفيها: من غير المسمّى «تسمية الرصيد القائم»، وإلى غير المسمّى «تصحيح»، وبين تشغيلتين «إعادة التصنيف» */
export function relabelReasonOf(fromLotId: string | null, toUnknown: boolean): LotRelabelReason {
  if (toUnknown) return 'CORRECTION';
  return fromLotId == null ? 'LABEL_EXISTING' : 'RECLASSIFY';
}

export interface RelabelLineForm { toLotId: string | null; lotNumber: string; productionDate: string; expiryDate: string; qty: string; mode: 'EXISTING' | 'NEW' | 'UNKNOWN' }

/** كمية موجبة بأربع خانات على الأكثر (isLotQty في الخادم) */
export function lotQtyOk(raw: string | number): boolean {
  const q = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isFinite(q) && q > 0 && Math.abs(roundLot(q) - q) <= 1e-9 * Math.max(1, Math.abs(q));
}

/**
 * فحص نموذج التسمية قبل الإرسال (مفتاح قاموس أو null): أسطرٌ صالحة، ومصدرٌ غير ممنوع (D27)، ولا وجهةٌ تساوي المصدر،
 * والتصحيح إلى غير المسمّى بملاحظة، والرقم الجديد بتواريخ صحيحة، والمجموع ضمن صالح المصدر.
 */
export function relabelProblem(input: {
  source: RelabelSource | null; lines: RelabelLineForm[]; note: string; expiryRequired: boolean;
}): string | null {
  const { source, lines } = input;
  if (!source) return 'اختر مصدر الكمية';
  if (source.blockedWhy) return source.blockedWhy;
  if (!lines.length) return 'أضف سطرا واحدا على الأقل';
  let sum = 0;
  for (const l of lines) {
    if (!lotQtyOk(l.qty)) return 'كمية غير صالحة';
    sum += Number(l.qty);
    if (l.mode === 'EXISTING') {
      if (!l.toLotId) return 'اختر التشغيلة';
      if (l.toLotId === source.lotId) return 'التسمية من التشغيلة إليها نفسها أو بلا طرفين';
    } else if (l.mode === 'NEW') {
      if (!normalizeLotNumber(l.lotNumber)) return 'اكتب رقم التشغيلة';
      const p = lotDatesProblem(l.productionDate || null, l.expiryDate || null, { expiryRequired: input.expiryRequired });
      if (p === 'LOT_EXPIRY_REQUIRED') return 'تاريخ انتهاء التشغيلة إلزامي لصنف صلاحيته مفعلة';
      if (p) return 'تاريخ الإنتاج بعد تاريخ الانتهاء أو تاريخ غير صالح';
    } else {
      if (source.lotId == null) return 'التسمية من التشغيلة إليها نفسها أو بلا طرفين';
      if (!input.note.trim()) return 'التصحيح إلى غير المسمى يحتاج ملاحظة';
    }
  }
  if (roundLot(sum) > source.usable + LOT_EPS) return 'الكمية أكبر من المتاح في المصدر';
  return null;
}

// ─── سلامة الأرصدة ───

/** عجوزات /lots/health مجمّعةً بالصنف (بترتيب أول ظهور) */
export function healthByProduct(rows: readonly LotDeficitRow[]): { productId: string; productName: string | null; rows: LotDeficitRow[] }[] {
  const out = new Map<string, { productId: string; productName: string | null; rows: LotDeficitRow[] }>();
  for (const r of rows) {
    let g = out.get(r.productId);
    if (!g) { g = { productId: r.productId, productName: r.productName, rows: [] }; out.set(r.productId, g); }
    g.rows.push(r);
  }
  return [...out.values()];
}

// ─── شاشة التتبّع ───

/** مجاميع شاشة التتبّع: المباع والمرتجع والصافي للعملاء، وعددهم وعدد الفواتير، وما أضافه النطاق الموسّع */
export function traceTotals(trace: Pick<LotTraceDto, 'customers'>): { sold: number; returned: number; net: number; customers: number; invoices: number; broad: number } {
  let sold = 0, returned = 0, invoices = 0, broad = 0;
  for (const c of trace.customers ?? []) {
    for (const i of c.invoices) {
      sold += i.sold; returned += i.returned; invoices++;
      if (i.broad) broad++;
    }
  }
  return { sold: roundLot(sold), returned: roundLot(returned), net: roundLot(sold - returned), customers: trace.customers?.length ?? 0, invoices, broad };
}

/** الاسم البديل الذي يرسله الخادم لسيارة المندوب المحذوف (LOT_REP_GONE_NAME في services/lotsTrace.ts) — نصٌّ عربي لا يُعرض كما هو */
export const LOT_REP_GONE_NAME = 'مندوب محذوف';

/**
 * اسم سيارةٍ في الشاشة والتصدير. المحذوفة «مندوب محذوف» **مترجماً** (لا اسم الخادم العربي) وذيلٌ من معرّفها يميّز المحذوفات
 * بعضها من بعض ويطابق بين الجداول. المحذوفة: علم deleted (/balances و/unload-plan) أو approximate (/trace)، وما لا علم له
 * (/health) فاسم الخادم البديل علامتها.
 */
export function vanName(v: { salesRepId: string | null; repName: string | null; deleted?: boolean; approximate?: boolean }, tr: Tr): string {
  const gone = v.deleted ?? v.approximate ?? v.repName === LOT_REP_GONE_NAME;
  if (gone) return v.salesRepId ? `${tr('مندوب محذوف')} · ${v.salesRepId.slice(0, 6)}` : tr('مندوب محذوف');
  return v.repName || tr(LOT_PLACE_LABELS.VAN);
}

/** اسم المكان في الشاشة والتصدير: المستودع، أو السيارة باسم مندوبها (vanName) */
export const placeName = (p: { place: LotPlace; salesRepId: string | null; repName: string | null; deleted?: boolean; approximate?: boolean }, tr: Tr): string =>
  p.place === 'WAREHOUSE' ? tr(LOT_PLACE_LABELS.WAREHOUSE) : vanName(p, tr);

/**
 * لحظة ISO بتوقيت المتصفّح — يومها «YYYY-MM-DD»، ومع withTime «YYYY-MM-DD HH:mm». كما تعرض صفحة الفواتير invoiceDate
 * (formatDate)؛ أمّا أول عشرة أحرف من ISO فيوم UTC: فاتورة ١:٣٠ فجراً بالرياض تقع في اليوم السابق. اليوم الخالص وغير الصالح كما هما.
 */
export function localStamp(iso: string, withTime = false): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return withTime ? `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}` : day;
}

type TracePlace = LotTraceDto['places'][number];
/**
 * أعمدة كميات «الأماكن» (§٤.١٧) — مصدرٌ واحد للشاشة وورقة PDF وExcel: الخام والصالح للإنقاص والمحجوز، ودلوا المنتهي والتالف،
 * ومجاميع الحركة. dash: الصفر «—» في الشاشة والورقة؛ strong: العمود الأساسي (والسالب أحمر في الشاشة).
 */
export const TRACE_PLACE_COLUMNS: readonly { label: string; qty: (p: TracePlace) => number; dash?: boolean; strong?: boolean }[] = [
  { label: LOT_BUCKET_LABELS.SELLABLE, qty: (p) => p.raw.SELLABLE, strong: true },
  { label: 'الصالح للإنقاص', qty: (p) => p.usable.SELLABLE },
  { label: 'محجوز', qty: (p) => p.held.SELLABLE, dash: true },
  { label: LOT_BUCKET_LABELS.EXPIRED, qty: (p) => p.raw.EXPIRED, dash: true },
  { label: LOT_BUCKET_LABELS.DAMAGED, qty: (p) => p.raw.DAMAGED, dash: true },
  { label: 'المحمل', qty: (p) => p.loaded },
  { label: 'المنزل', qty: (p) => p.unloaded },
  { label: 'المباع', qty: (p) => p.sold },
  { label: 'المرتجع', qty: (p) => p.returned },
];

/** تسمية نوع المصدر: مصدر البطاقة، أو نوع حركة المستودع أو السيارة */
export function originKindLabel(kind: string, tr: Tr): string {
  if (kind in LOT_SOURCE_LABELS) return tr(LOT_SOURCE_LABELS[kind as LotSource]);
  const MOVES: Record<string, string> = { ADJUST: 'تسوية', LOAD: 'تحميل مباشر للسيارة', RELABEL: 'تسمية أو إعادة تصنيف', RETURN: 'مرتجع' };
  return MOVES[kind] ? tr(MOVES[kind]) : kind;
}

export const eventKindLabel = (kind: string, tr: Tr): string =>
  kind in LOT_EVENT_KIND_LABELS ? tr(LOT_EVENT_KIND_LABELS[kind as LotEventKind]) : kind;

const q4 = (n: number) => roundLot(Number(n) || 0);

/**
 * أوراق Excel لشاشة التتبّع: البطاقة، والمصدر، والأماكن، والعملاء (فاتورةً فاتورة)، والسجل — العناوين بلغة العرض والكميات أرقامٌ
 * بأربع خانات. العملاء المحجوبون (بلا صلاحية العملاء) لا ورقة لهم.
 */
export function traceSheets(trace: LotTraceDto, tr: Tr): ExcelSheet[] {
  const lot = trace.lot;
  const t = traceTotals(trace);
  const sheets: ExcelSheet[] = [];
  const kv = (k: string, v: unknown) => ({ [tr('البيان')]: k, [tr('القيمة')]: v });
  sheets.push({
    name: tr('التشغيلة'),
    rows: [
      kv(tr('رقم التشغيلة'), lot.lotNumber),
      kv(tr('الصنف'), lot.productName),
      kv(tr('تاريخ الإنتاج'), lotDay(lot.productionDate) ?? ''),
      kv(tr('تاريخ الانتهاء'), lotDay(lot.expiryDate) ?? ''),
      kv(tr('الحالة'), tr(lotStatusLabel(lot))),
      kv(tr('المصدر'), originKindLabel(lot.source, tr)),
      kv(tr('النطاق'), trace.scope === 'BROAD' ? tr('النطاق الموسع') : tr('النطاق الدقيق')),
      kv(tr('المباع'), t.sold), kv(tr('المرتجع'), t.returned), kv(tr('الصافي'), t.net),
      kv(tr('عدد العملاء'), t.customers), kv(tr('عدد الفواتير'), t.invoices),
      ...(trace.scoped ? [kv(tr('ملاحظة'), tr('النتيجة مقيدة بنطاقك'))] : []),
    ],
    colWidths: [22, 36],
  });
  sheets.push({
    name: tr('المصدر'),
    rows: trace.origin.map((o) => ({ [tr('النوع')]: originKindLabel(o.kind, tr), [tr('التاريخ')]: localStamp(o.at), [tr('الكمية')]: q4(o.qty) })),
    colWidths: [26, 14, 12],
  });
  sheets.push({
    name: tr('الأماكن'),
    rows: trace.places.map((p) => ({
      [tr('المكان')]: placeName(p, tr) + (p.approximate ? ` (${tr('تقريبي')})` : ''),
      ...Object.fromEntries(TRACE_PLACE_COLUMNS.map((c) => [tr(c.label), q4(c.qty(p))])),
    })),
    colWidths: [24, 12, 12, 10, 12, 10, 10, 10, 10, 10],
  });
  if (trace.customers) {
    const rows: Record<string, unknown>[] = [];
    for (const c of trace.customers) {
      for (const i of c.invoices) {
        rows.push({
          [tr('العميل')]: c.name, [tr('الجوال')]: c.phone ?? '', [tr('المدينة')]: c.city ?? '', [tr('العنوان')]: c.address ?? '',
          [tr('رقم الفاتورة')]: i.number, [tr('التاريخ')]: localStamp(i.date),
          [tr('المباع')]: q4(i.sold), [tr('المرتجع')]: q4(i.returned), [tr('الصافي')]: q4(i.net),
          [tr('اليقين')]: tr(LOT_CERTAINTY_LABELS[i.weakest] ?? i.weakest),
          [tr('النطاق')]: i.broad ? tr('النطاق الموسع') : tr('النطاق الدقيق'),
          [tr('الوسوم')]: i.flags.map((f) => tr(LOT_ROW_FLAG_LABELS[f] ?? f)).join('، '),
        });
      }
    }
    sheets.push({ name: tr('العملاء'), rows, colWidths: [24, 14, 12, 24, 16, 12, 10, 10, 10, 12, 14, 30] });
  }
  sheets.push({
    name: tr('السجل'),
    rows: trace.events.map((e) => ({
      [tr('التاريخ')]: localStamp(e.at, true), [tr('الحدث')]: eventKindLabel(e.kind, tr),
      [tr('بواسطة')]: e.actorName ?? '', [tr('السبب')]: e.reason ?? '',
    })),
    colWidths: [18, 26, 18, 40],
  });
  return sheets;
}
