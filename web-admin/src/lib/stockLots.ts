// ============================================================================
// «تتبّع اللوط» في شاشتي المخزون (W2): مخزون الشركة ومخزون السيارات.
// ----------------------------------------------------------------------------
// منطقٌ صرف بلا React ولا شبكة: مصادر الإنقاص من عرض المكان، ومسوّدات الصفوف
// التي يحرّرها المستخدم، وحقول تشغيلة سطر الوارد والتسوية، وملخّص صفّ الرصيد.
// الخادم صاحب القرار (I1/I2 وD10 وD27)، وهذه للتحقق المسبق والعرض وحدهما.
//
// كل كمية هنا **بوحدة الأساس** (D22)، و`lotId: null` = «غير مسمّى» صراحةً.
// ============================================================================

import {
  LOT_EPS, isLotExpiredOn, lotDatesProblem, lotRowsProblem, normalizeLotNumber, roundLot,
  type AllocRowDto, type LotBlockKind, type LotBucket, type LotRef, type LotStatus, type LotWarning,
  type PlaceLotViewDto, type VanLotSnapshotDto,
} from './lots';
import { primaryUnitOf, productQtyText, type PrimaryHolder } from './units';

/** مصدرٌ يُنقص منه (أو يُحمَّل منه): تشغيلةٌ مسمّاة أو «غير مسمّى» (lotId: null) بصالحها في الدلو */
export interface LotSource {
  lotId: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  status: LotStatus | null;
  blockKind: LotBlockKind | null;
  usable: number;
  /** منتهيةٌ يوم القياس (يوم الانتهاء نفسه آخر يوم صالح) */
  expired: boolean;
}

/** عرض مكانٍ كما يردّه /lots/balances (PlaceLotViewDto ومعه availability من splitAvailability) */
export interface PlaceViewWithAvailability extends PlaceLotViewDto {
  availability?: {
    available: number; availableNamed: number; availableUnknown: number;
    quarantined: number; expiredUnsold: number; held: number;
    expiredReturned: number; damaged: number; unknownDeficit: number;
  };
}
/** ردّ GET /lots/balances كما يكتبه الخادم (routes/lots.ts) */
export interface LotBalancesResponse {
  asOf: string | null; day: string; scoped?: boolean;
  warehouse: PlaceViewWithAvailability[];
  vans: { salesRepId: string; repName: string | null; deleted: boolean; view: PlaceViewWithAvailability }[];
}

/**
 * مصادر الإنقاص في دلوٍ (D10، pickOutSources في الخادم): كل تشغيلة صالحها في الدلو > EPS **أيّاً كانت حالتها** —
 * الموقوفة والمنتهية تخرج من هنا — مضافاً إليها غير المسمّى إن كان صالحه > EPS. بترتيب العرض (FEFO) وغير المسمّى آخراً.
 */
export function outSourcesOf(view: PlaceLotViewDto | null | undefined, bucket: LotBucket, day: string): LotSource[] {
  if (!view) return [];
  const out: LotSource[] = [];
  for (const l of view.lots ?? []) {
    const q = roundLot(Number(l.usable?.[bucket]) || 0);
    if (q <= LOT_EPS) continue;
    out.push({
      lotId: l.lotId, lotNumber: l.meta?.lotNumber ?? null, expiryDate: l.meta?.expiryDate ?? null,
      status: l.meta?.status ?? null, blockKind: l.meta?.blockKind ?? null, usable: q,
      expired: isLotExpiredOn({ expiryDate: l.meta?.expiryDate ?? null }, day),
    });
  }
  const unknown = roundLot(Number(view.unknownUsable?.[bucket]) || 0);
  if (unknown > LOT_EPS) out.push({ lotId: null, lotNumber: null, expiryDate: null, status: null, blockKind: null, usable: unknown, expired: false });
  return out;
}

/**
 * مصادر التحميل من المستودع (المؤهَّل للبيع والتحميل §٠.١): تشغيلة نشطة لم تنتهِ يوم القياس صالحها > EPS، ثم غير المسمّى
 * (D17: بعد نفاد المسمّى المؤهَّل). الموقوفة والمنتهية لا تُحمَّل (D27).
 */
export function loadSourcesOf(view: PlaceLotViewDto | null | undefined, day: string): LotSource[] {
  return outSourcesOf(view, 'SELLABLE', day).filter((s) => s.lotId === null || (s.status === 'ACTIVE' && !s.expired));
}

/** مصادر سيارةٍ من لقطتها (/van-stock/lot-balances — SELLABLE وحده): كل تشغيلة صالحها > EPS، ثم غير المسمّى */
export function snapshotSourcesOf(snap: VanLotSnapshotDto | null | undefined, productId: string): LotSource[] {
  const p = snap?.products?.find((x) => x.productId === productId);
  if (!p) return [];
  const day = snap!.day;
  const out: LotSource[] = [];
  for (const l of p.lots ?? []) {
    const q = roundLot(Number(l.usable) || 0);
    if (q <= LOT_EPS) continue;
    out.push({ lotId: l.lotId, lotNumber: l.lotNumber, expiryDate: l.expiryDate, status: l.status, blockKind: l.blockKind, usable: q, expired: isLotExpiredOn(l, day) });
  }
  const unknown = roundLot(Number(p.unknownUsable) || 0);
  if (unknown > LOT_EPS) out.push({ lotId: null, lotNumber: null, expiryDate: null, status: null, blockKind: null, usable: unknown, expired: false });
  return out;
}

/** D10: أكثر من مصدرٍ في الدلو ⇒ الإنقاص يتطلب اختياراً صريحاً، والمصدر الوحيد يأخذه الخادم تلقائياً */
export const needsExplicitSource = (sources: readonly LotSource[]): boolean => sources.length > 1;

/** مفتاح المصدر في منتقي الواجهة — '∅' لغير المسمّى ('' = لم يُختر بعد) */
export const UNKNOWN_KEY = '∅';
export const sourceKey = (lotId: string | null): string => (lotId === null ? UNKNOWN_KEY : lotId);
export const keyLotId = (key: string): string | null | undefined => (key === '' ? undefined : key === UNKNOWN_KEY ? null : key);

// ─── مسوّدة صفوف التوزيع (اقتراح FEFO قابل للتعديل والتقسيم، أو اختيار مصدر الإنقاص) ───

/** صفٌّ يحرّره المستخدم: المصدر بمفتاحه ('' لم يُختر) والكمية نصّاً كما كُتبت */
export interface LotRowDraft { key: string; source: string; qty: string }

let draftSeq = 0;
/** مفتاح صفٍّ أو سطرٍ في الواجهة — الفهرسة به لا بالصنف (صنفٌ في سطرين لدفعتين) */
export const newRowId = (prefix = 'r'): string => `${prefix}${Date.now().toString(36)}${(++draftSeq).toString(36)}`;

/** صفوف الاقتراح (AllocRowDto) مسوّدةً قابلة للتعديل */
export function draftFromRows(rows: readonly Pick<AllocRowDto, 'lotId' | 'qty'>[]): LotRowDraft[] {
  return rows.filter((r) => Math.abs(Number(r.qty)) > LOT_EPS)
    .map((r) => ({ key: newRowId('d'), source: sourceKey(r.lotId), qty: String(roundLot(Math.abs(Number(r.qty)))) }));
}

/** المسوّدة صفوفاً للطلب — الصفّ بلا مصدر أو بكمية غير رقمية يسقط (والتحقق قبله يمنع الإرسال) */
export function draftRefs(rows: readonly LotRowDraft[]): LotRef[] {
  const out: LotRef[] = [];
  for (const r of rows) {
    const lotId = keyLotId(r.source);
    const qty = Number(r.qty);
    if (lotId === undefined || !Number.isFinite(qty)) continue;
    out.push({ lotId, qty: roundLot(qty) });
  }
  return out;
}

export type DraftProblem = 'LOT_SOURCE_MISSING' | 'LOT_SOURCE_DUPLICATE' | 'LOT_OVER_SOURCE' | 'LOT_QTY_INVALID';

/**
 * مشكلة المسوّدة قبل الإرسال: كل صفٍّ بمصدرٍ مختار، ولا مصدر مكرّر (الخادم يجمعها، والواجهة تبقيها صفاً واحداً للوضوح)،
 * وكل صفٍّ ≤ صالح مصدره إن عُرف (I1/I2)، ثم الشكل والمجموع = كمية السطر الأساسية (lotRowsProblem).
 */
export function draftProblem(rows: readonly LotRowDraft[], lineBaseQty: number, sources?: readonly LotSource[] | null): DraftProblem | null {
  if (!rows.length) return 'LOT_QTY_INVALID';
  const seen = new Set<string>();
  for (const r of rows) {
    if (keyLotId(r.source) === undefined) return 'LOT_SOURCE_MISSING';
    if (seen.has(r.source)) return 'LOT_SOURCE_DUPLICATE';
    seen.add(r.source);
  }
  // كمية كل صفٍّ رقمٌ بأربع خانات على الأكثر (isLotQty) — draftRefs يقرّبها فلا يُخفي التقريبُ كسراً زائداً
  if (rows.some((r) => r.qty.trim() === '' || !isFourDecimals(Number(r.qty)))) return 'LOT_QTY_INVALID';
  const refs = draftRefs(rows);
  if (refs.length !== rows.length) return 'LOT_QTY_INVALID';
  const shape = lotRowsProblem(refs, roundLot(Math.abs(lineBaseQty)));
  if (shape) return shape;
  if (sources) {
    const cap = new Map(sources.map((s) => [sourceKey(s.lotId), s.usable]));
    for (const r of refs) {
      const have = cap.get(sourceKey(r.lotId));
      if (have === undefined || r.qty > have + LOT_EPS) return 'LOT_OVER_SOURCE';
    }
  }
  return null;
}

/**
 * «الوحدة الرئيسية» (D21 وR8): اسم الوحدة الصغرى لصنفٍ له رئيسية صالحة — يحلّ محلّ «بوحدة الأساس» في نصوص محرّر التشغيلات،
 * ويُلصق بالخانة بخطٍّ بارز. و`null` لصنفٍ بلا رئيسية: النصوص القائمة حرفاً (I1). الكميات بالأساس في الحالين (D22).
 */
export function lotSmallUnitOf(prod: (PrimaryHolder & { unit?: string | null }) | null | undefined): string | null {
  if (!primaryUnitOf(prod)) return null;
  return String(prod?.unit ?? '').trim() || null;
}

/** معادل كمية صفّ التشغيلة الحيّ تحته («= 2 كرتون و3 قارورة») لصنفٍ له رئيسية، و`null` لغيره أو لكميةٍ غير صالحة */
export function lotRowEquivalent(qty: unknown, prod: (PrimaryHolder & { unit?: string | null }) | null | undefined): string | null {
  if (!lotSmallUnitOf(prod)) return null;
  const n = Number(qty);
  if (qty === '' || qty == null || !Number.isFinite(n) || n <= 0) return null;
  return `= ${productQtyText(roundLot(n), prod)}`;
}

/** ما بقي من السطر بلا توزيع في المسوّدة — موجبٌ ناقص وسالبٌ زائد */
export function draftRemaining(rows: readonly LotRowDraft[], lineBaseQty: number): number {
  const sum = rows.reduce((s, r) => s + (Number.isFinite(Number(r.qty)) ? Number(r.qty) : 0), 0);
  return roundLot(Math.abs(lineBaseQty) - sum);
}

/** صفٌّ جديد للتقسيم: أول مصدرٍ لم يأخذه صفّ، بما بقي من السطر (أو صفراً) */
export function splitDraft(rows: readonly LotRowDraft[], lineBaseQty: number, sources: readonly LotSource[]): LotRowDraft[] {
  const taken = new Set(rows.map((r) => r.source));
  const next = sources.find((s) => !taken.has(sourceKey(s.lotId)));
  const left = Math.max(0, draftRemaining(rows, lineBaseQty));
  const qty = next ? Math.min(left, next.usable) : left;
  return [...rows, { key: newRowId('d'), source: next ? sourceKey(next.lotId) : '', qty: String(roundLot(qty)) }];
}

// ─── تشغيلة سطر الوارد أو التسوية (سطرٌ = تشغيلةٌ واحدة، §٤.٤) ───

/** NEW رقمٌ يُحلّ أو يُنشأ بتاريخيه؛ EXISTING تشغيلة قائمة؛ UNKNOWN غير مسمّى صراحةً؛ AUTO بلا تحديد (المصدر الوحيد للنقص) */
export type EntryLotMode = 'NEW' | 'EXISTING' | 'UNKNOWN' | 'AUTO';
export interface EntryLotDraft { mode: EntryLotMode; lotId: string; lotNumber: string; productionDate: string; expiryDate: string }
export const emptyEntryLot = (mode: EntryLotMode = 'NEW'): EntryLotDraft => ({ mode, lotId: '', lotNumber: '', productionDate: '', expiryDate: '' });

/** اتجاه السطر: وارد، أو زيادة تسوية (أو تحميل مباشر D4)، أو نقص */
export type EntryLotKind = 'RECEIVE' | 'INCREASE' | 'DECREASE';
/** الأوضاع المسموحة لكل اتجاه — الوارد لا يكون «غير مسمّى» (LOT_REQUIRED)، والنقص لا يُنشئ تشغيلة */
export function entryLotModes(kind: EntryLotKind): EntryLotMode[] {
  if (kind === 'RECEIVE') return ['NEW', 'EXISTING'];
  if (kind === 'INCREASE') return ['NEW', 'EXISTING', 'UNKNOWN'];
  return ['AUTO', 'EXISTING', 'UNKNOWN'];
}

/**
 * الوضع الفعلي للاتجاه: وضعٌ لا يسمح به (سطر تسويةٍ قُلبت إشارته فصار نقصاً) يأخذ أول المسموح — كما تعرضه الواجهة،
 * فيتطابق المعروض والمُتحقَّق منه والمُرسَل.
 */
export function normalizeEntryLot(d: EntryLotDraft, kind: EntryLotKind): EntryLotDraft {
  const modes = entryLotModes(kind);
  return modes.includes(d.mode) ? d : { ...d, mode: modes[0] };
}

export type EntryLotProblem = 'LOT_REQUIRED' | 'LOT_DATES_INVALID' | 'LOT_EXPIRY_REQUIRED' | 'LOT_OVER_SOURCE';

/**
 * مشكلة تشغيلة السطر قبل الإرسال (مرآة planWarehouseEntryInTx وD4) — sourcesCount لنقصٍ بلا تحديد (D10)، وautoOver
 * (autoDecreaseOver) لتلقائيٍّ فوق مصدره الوحيد الباقي (LOT_STOCK_INSUFFICIENT في الخادم)
 */
export function entryLotProblem(draft: EntryLotDraft, opts: { kind: EntryLotKind; expiryRequired: boolean; sourcesCount?: number; autoOver?: boolean }): EntryLotProblem | null {
  const d = normalizeEntryLot(draft, opts.kind);
  if (d.mode === 'NEW') {
    if (!normalizeLotNumber(d.lotNumber)) return 'LOT_REQUIRED';
    return lotDatesProblem(d.productionDate || null, d.expiryDate || null, { expiryRequired: opts.expiryRequired });
  }
  if (d.mode === 'EXISTING') return d.lotId ? null : 'LOT_REQUIRED';
  if (d.mode === 'AUTO') return (opts.sourcesCount ?? 0) > 1 ? 'LOT_REQUIRED' : opts.autoOver ? 'LOT_OVER_SOURCE' : null;
  return null;
}

/**
 * مصادر سطر النقص «التلقائي» مما بقي بعد صريح صنفه (D10) — مرآة planWarehouseEntryInTx (withoutRows، وpickPlan في السيارة):
 * أسطر نقص الصنف الصريحة (تشغيلة قائمة مختارة، أو «غير مسمّى») تُجمع لكل مصدر وتُطرح كمياتها الأساسية من صالحه، والمصدر الذي
 * لم يبقَ له صالحٌ > EPS لا ينافس — فـ[A −١٠ صريحة، تلقائي −٥] مع A:10 وB:5 مصدره B وحده.
 * والخادم يفحص الصريح مجمَّعاً قبل الطرح: صريحٌ فوق صالح مصدره (أو على غير مصدر)، أو صريحٌ يصفّي كل المصادر، يُرفض
 * (LOT_STOCK_INSUFFICIENT) — فلا يُطرح شيءٌ حينها ويبقى الحكم على المصادر كاملةً كما كان: الطرح لا يفتح طلباً سيُرفض.
 * `lines` أسطر النقص لصنفٍ واحد (المسوّدة كما هي، والكمية بالأساس بإشارتها)، و«التلقائي» منها لا يُطرح.
 */
export function autoDecreaseSources(sources: readonly LotSource[], lines: readonly { draft: EntryLotDraft; baseQty: number }[]): LotSource[] {
  const used = new Map<string, number>();
  for (const l of lines) {
    const dr = normalizeEntryLot(l.draft, 'DECREASE');
    const q = roundLot(Math.abs(Number(l.baseQty)));
    if (!Number.isFinite(q) || q <= LOT_EPS) continue;
    const key = dr.mode === 'EXISTING' && dr.lotId ? dr.lotId : dr.mode === 'UNKNOWN' ? UNKNOWN_KEY : null;
    if (key !== null) used.set(key, roundLot((used.get(key) ?? 0) + q));
  }
  if (!used.size) return [...sources];
  const cap = new Map(sources.map((s) => [sourceKey(s.lotId), s.usable]));
  for (const [k, q] of used) {
    const have = cap.get(k);
    if (have === undefined || q > have + LOT_EPS) return [...sources];
  }
  const rest = sources
    .map((s) => ({ ...s, usable: roundLot(s.usable - (used.get(sourceKey(s.lotId)) ?? 0)) }))
    .filter((s) => s.usable > LOT_EPS);
  return rest.length ? rest : [...sources];
}

/**
 * أسطر «التلقائي» لصنفٍ مجموعُها (D26) فوق صالح مصدرها الوحيد الباقي بعد صريحه (autoDecreaseSources) — مرآة pickOutSources على
 * العرض بعد withoutRows: الخادم يردّها LOT_STOCK_INSUFFICIENT. فـ[A −١٠ صريحة، تلقائي −٨] مع A:10 وB:5 لا يُفتح بعد أن صار
 * العدّ مما بقي. وأكثر من مصدرٍ باقٍ (LOT_REQUIRED يسبق) أو لا مصدر معروف (لم تصل المصادر) ⇒ false: لا يُمنع على ظنّ.
 */
export function autoDecreaseOver(sources: readonly LotSource[], lines: readonly { draft: EntryLotDraft; baseQty: number }[]): boolean {
  let want = 0;
  for (const l of lines) {
    const q = roundLot(Math.abs(Number(l.baseQty)));
    if (normalizeEntryLot(l.draft, 'DECREASE').mode === 'AUTO' && Number.isFinite(q) && q > LOT_EPS) want = roundLot(want + q);
  }
  if (want <= LOT_EPS) return false;
  const rest = autoDecreaseSources(sources, lines);
  return rest.length === 1 && want > rest[0].usable + LOT_EPS;
}

/** حقول التشغيلة في بند الطلب — AUTO لا يُرسل شيئاً (الخادم يأخذ المصدر الوحيد) */
export function entryLotFields(d: EntryLotDraft): { lotId?: string | null; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null } {
  if (d.mode === 'NEW') {
    return { lotNumber: normalizeLotNumber(d.lotNumber) ?? d.lotNumber.trim(), productionDate: d.productionDate || null, expiryDate: d.expiryDate || null };
  }
  if (d.mode === 'EXISTING') return { lotId: d.lotId };
  if (d.mode === 'UNKNOWN') return { lotId: null };
  return {};
}

/**
 * التحميل المباشر بلا مستودع (D4): بند السيارة يحمل `lots` صفوفاً لا `lotId` — القائمة والغير مسمّاة صفٌّ واحد بكمية السطر
 * الأساسية، والجديدة رقمٌ وتاريخان يحلّها الخادم أو ينشئها بمصدر LOAD.
 */
export function directLoadLotFields(draft: EntryLotDraft, lineBaseQty: number): { lots?: LotRef[]; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null } {
  const d = normalizeEntryLot(draft, 'INCREASE');
  const qty = roundLot(Math.abs(lineBaseQty));
  if (d.mode === 'EXISTING') return d.lotId ? { lots: [{ lotId: d.lotId, qty }] } : {};
  if (d.mode === 'UNKNOWN') return { lots: [{ lotId: null, qty }] };
  const f = entryLotFields(d);
  return { lotNumber: f.lotNumber, productionDate: f.productionDate ?? null, expiryDate: f.expiryDate ?? null };
}

/** كميةٌ ممثَّلة بأربع خانات (isLotQty في الخادم) — غيرها يُردّ LOT_QTY_INVALID في المسار الحيّ */
export const isFourDecimals = (q: number): boolean => Number.isFinite(q) && Math.abs(roundLot(q) - q) <= 1e-9 * Math.max(1, Math.abs(q));

/**
 * رقمٌ يطابق تشغيلةً قائمة (بعد التطبيع) يأخذ تاريخيها ما دام حقلاهما فارغين — فلا يُطلب انتهاءٌ مسجَّل أصلاً، ولا يخالفه
 * المستخدم سهواً فيُردّ LOT_DATES_MISMATCH.
 */
export function withKnownLotDates(d: EntryLotDraft, known: readonly { lotNumber: string; productionDate: string | null; expiryDate: string | null }[]): EntryLotDraft {
  const n = normalizeLotNumber(d.lotNumber);
  if (!n) return d;
  const hit = known.find((k) => k.lotNumber === n);
  if (!hit) return d;
  return {
    ...d,
    productionDate: d.productionDate || (hit.productionDate ? hit.productionDate.slice(0, 10) : ''),
    expiryDate: d.expiryDate || (hit.expiryDate ? hit.expiryDate.slice(0, 10) : ''),
  };
}

// ─── ملخّص صفّ الرصيد والتحذيرات ───

/** شارات صفّ الرصيد من عرض المكان: عدد التشغيلات ذات الرصيد، والمعزول (موقوف أو منتهٍ لم يُبع)، والمحجوز، وغير المسمّى، والعجز */
export interface LotRowSummary { lots: number; quarantined: number; held: number; unknown: number | null; deficit: boolean }
export function lotRowSummary(view: PlaceViewWithAvailability | null | undefined, day: string): LotRowSummary | null {
  if (!view) return null;
  let lots = 0, quarantined = 0, held = 0;
  for (const l of view.lots ?? []) {
    const u = Number(l.usable?.SELLABLE) || 0;
    const raw = Number(l.raw?.SELLABLE) || 0;
    if (Math.abs(raw) > LOT_EPS) lots += 1;
    held += Number(l.held?.SELLABLE) || 0;
    if (u > LOT_EPS && (l.meta?.status === 'BLOCKED' || isLotExpiredOn({ expiryDate: l.meta?.expiryDate ?? null }, day))) quarantined += u;
  }
  const unknown = view.unknown ? roundLot(Number(view.unknown.SELLABLE) || 0) : null;
  const deficit = (view.deficits ?? []).some((d) => Number(d.qty) < -LOT_EPS) || (unknown !== null && unknown < -LOT_EPS);
  return { lots, quarantined: roundLot(quarantined), held: roundLot(held), unknown, deficit };
}

/** تحذير «في السيارة أكثر من تشغيلة» لصنفٍ من warnings[] */
export const hasMultiLotWarning = (warnings: readonly LotWarning[] | null | undefined, productId: string): boolean =>
  (warnings ?? []).some((w) => w.code === 'LOT_MULTI_IN_VAN' && w.productId === productId);

/** مرآة shelfLifeOf في الخادم: الصلاحية مفعّلة بقيمة صحيحة موجبة ووحدة معروفة ⇒ انتهاء التشغيلة إلزامي */
export function shelfLifeOn(p: { shelfLifeEnabled?: boolean | null; shelfLifeValue?: number | null; shelfLifeUnit?: string | null } | null | undefined): boolean {
  if (!p?.shelfLifeEnabled) return false;
  const v = Number(p.shelfLifeValue);
  return ['DAY', 'MONTH', 'YEAR'].includes(String(p.shelfLifeUnit)) && Number.isInteger(v) && v > 0;
}
