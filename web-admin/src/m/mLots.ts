// ============================================================================
// «تتبّع اللوط» في تطبيق الإدارة على الجوال (/m) — منطقٌ صرف تختبره mLots.test.ts.
// ----------------------------------------------------------------------------
// الشاشات (MWarehouse وMRepLoad وMLots ومستنداتها) ترسم وتستدعي، وهنا وحدها:
//  - هويّة السطر (rowId): صنفٌ متتبَّع قد يحتاج سطرين بالوحدة نفسها (تشغيلتان في وارد واحد)، فمفتاح (الصنف، الوحدة)
//    لا يكفي — والصنف غير المتتبَّع يبقى على منع التكرار القائم حرفاً.
//  - مسودّة تشغيلة السطر (اختيار قائمة، أو جديدة برقمٍ وتاريخين، أو «غير مسمى») وتحقّقها وحقول جسمها.
//  - مصادر التنزيل من السيارة وتوزيعها الأوّلي (الموقوف والمنتهي أولاً: هو ما يُنزَّل في السحب).
//  - تشغيلات البنود على الأوراق (فاتورة، إشعار تحميل، إشعار مستودع) حين لا يضمّها بانيها.
// كل كمية هنا **بوحدة الأساس** (D22)، والخادم صاحب القرار: هذه للعرض والتحقق المسبق وحدهما.
// ============================================================================

import {
  LOT_EPS, roundLot, normalizeLotNumber, lotDatesProblem, isLotExpiredOn, fefoCompare, docLotsFrom, lotDay,
  type LotRef, type DocLotLine, type VanLotSnapshotDto, type LotStatus, type LotBlockKind,
} from '../lib/lots';

let seq = 0;
/** معرّف سطرٍ محلّي فريد في الجلسة — مفتاح React وهدف التعديل والحذف */
export function newRowId(): string {
  seq += 1;
  return `r${Date.now().toString(36)}${seq.toString(36)}`;
}

/** الكمية الأساسية المطلقة لسطرٍ بوحدته (المعامل التالف ١) — بأربع خانات كرصيد الصنف */
export function lineBaseQty(qty: number, unitFactor: number | null | undefined): number {
  const f = Number(unitFactor);
  const q = Number(qty);
  if (!Number.isFinite(q)) return 0;
  return roundLot(Math.abs(q) * (Number.isFinite(f) && f > 0 ? f : 1));
}

/** صلاحية الصنف مكتملة (shelfLifeOf في الخادم): مفعّلة بمدّة صحيحة موجبة ⇒ انتهاء التشغيلة الجديدة إلزامي */
export function shelfLifeOn(p: { shelfLifeEnabled?: boolean | null; shelfLifeValue?: number | null; shelfLifeUnit?: string | null } | null | undefined): boolean {
  if (!p?.shelfLifeEnabled) return false;
  const v = Number(p.shelfLifeValue);
  return Number.isInteger(v) && v > 0 && ['DAY', 'MONTH', 'YEAR'].includes(String(p.shelfLifeUnit));
}

/** صنفٌ متتبَّع فعلاً في الواجهة: علم الشركة وعلم الصنف معاً (المطفأة تُخفي ولا تحذف، D8) */
export const isTracked = (lotOn: boolean, p: { lotTracked?: boolean | null } | null | undefined): boolean =>
  lotOn && p?.lotTracked === true;

/**
 * أسطر اقتراح FEFO لصنفٍ في أسطره (GET /lots/fefo?lines=): «كمية:معامل» مفصولةً بفاصلة، والكمية **أساسية** بأربع خانات —
 * الخادم يوزّع الأسطر من متاحٍ مشترك بقاعدة الكرتون، فلا يأخذ اقتراحان مستقلّان التشغيلة نفسها. الأصفار تسقط.
 */
export function fefoLinesParam(lines: readonly { qty: number; unitFactor?: number | null }[]): string {
  return lines
    .map(l => ({ q: lineBaseQty(l.qty, l.unitFactor), f: Number(l.unitFactor) > 0 ? Number(l.unitFactor) : 1 }))
    .filter(l => l.q > LOT_EPS)
    .map(l => `${l.q}:${l.f}`)
    .join(',');
}

// ═══════════════ مسودّة تشغيلة السطر (الوارد والتسوية والتحميل بلا مستودع) ═══════════════

/** pick: '' لم يُختر (الخادم يختار المصدر الوحيد في النقص) · 'NEW' تشغيلة جديدة · 'UNNAMED' غير مسمّى صراحةً · وإلا معرّف لوط */
export interface LotDraft { pick: string; lotNumber: string; productionDate: string; expiryDate: string }
export const emptyLotDraft = (): LotDraft => ({ pick: '', lotNumber: '', productionDate: '', expiryDate: '' });

/**
 * ما يُسمح به لكل حركة:
 *  - IN_STRICT: وارد المستودع — تشغيلةٌ قائمة أو جديدة، لا «غير مسمّى» (§٤.٤ RECEIVE: LOT_REQUIRED).
 *  - IN: تسويةٌ بالزيادة، أو تحميلٌ في شركة بلا مستودع (D4) — قائمة أو جديدة أو «غير مسمّى» صريح.
 *  - OUT: تسوية نقص — قائمة (من المصادر) أو «غير مسمّى» أو بلا اختيار فيختار الخادم المصدر الوحيد (D10).
 */
export type LotDraftMode = 'IN_STRICT' | 'IN' | 'OUT';

/** رسالة المشكلة (مفتاح قاموس) أو null — مرآة قواعد الخادم قبل الإرسال */
export function lotDraftProblem(d: LotDraft, mode: LotDraftMode, opts: { shelfOn: boolean }): string | null {
  if (d.pick === '') return mode === 'OUT' ? null : 'اختر التشغيلة أو أضف تشغيلة جديدة';
  if (d.pick === 'UNNAMED') return mode === 'IN_STRICT' ? 'الوارد يلزمه رقم تشغيلة' : null;
  if (d.pick === 'NEW') {
    if (mode === 'OUT') return 'اختر التشغيلة التي ينقص منها الرصيد';
    if (!normalizeLotNumber(d.lotNumber)) return 'اكتب رقم التشغيلة';
    const p = lotDatesProblem(d.productionDate || null, d.expiryDate || null, { expiryRequired: opts.shelfOn });
    if (p === 'LOT_EXPIRY_REQUIRED') return 'تاريخ الانتهاء إلزامي لصنف له صلاحية';
    if (p) return 'تاريخ الإنتاج يجب أن يسبق تاريخ الانتهاء';
  }
  return null;
}

/** حقول تشغيلة سطر الوارد أو التسوية (warehouseApi.createEntry): سطرٌ = تشغيلةٌ واحدة */
export function entryLotFields(d: LotDraft): { lotId?: string | null; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null } {
  if (d.pick === '') return {};
  if (d.pick === 'UNNAMED') return { lotId: null };
  if (d.pick === 'NEW') {
    return { lotNumber: normalizeLotNumber(d.lotNumber) ?? d.lotNumber.trim(), productionDate: d.productionDate || null, expiryDate: d.expiryDate || null };
  }
  return { lotId: d.pick };
}

/**
 * حقول تشغيلة سطر التحميل في شركة بلا مستودع (D4، vanStockApi.createLoad): القائمة والـ«غير مسمّى» صفٌّ صريح بكمية السطر
 * الأساسية، والجديدة رقمٌ وتاريخان يُنشئها الخادم بمصدر LOAD.
 */
export function loadLotFields(d: LotDraft, baseQty: number): { lots?: LotRef[]; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null } {
  if (d.pick === '') return {};
  if (d.pick === 'NEW') {
    return { lotNumber: normalizeLotNumber(d.lotNumber) ?? d.lotNumber.trim(), productionDate: d.productionDate || null, expiryDate: d.expiryDate || null };
  }
  return { lots: [{ lotId: d.pick === 'UNNAMED' ? null : d.pick, qty: roundLot(baseQty) }] };
}

// ═══════════════ مصادر التنزيل من السيارة (UNLOAD، D10) ═══════════════

export interface OutSource {
  lotId: string | null; lotNumber: string | null; expiryDate: string | null;
  status: LotStatus | null; blockKind: LotBlockKind | null; usable: number; expired: boolean;
}

/**
 * مصادر صالح «صالح للبيع» في السيارة من لقطتها: كل تشغيلة صالحها > EPS أيّاً كانت حالتها، ثم غير المسمّى إن كان له صالح.
 * الترتيب: المسحوبة، ثم الموقوفة، ثم المنتهية، ثم FEFO — ما يجب إخراجه أولاً في الأعلى.
 */
export function vanOutSources(p: VanLotSnapshotDto['products'][number] | null | undefined, day: string): OutSource[] {
  if (!p) return [];
  const rank = (s: OutSource) => (s.status === 'BLOCKED' ? (s.blockKind === 'RECALL' ? 0 : 1) : s.expired ? 2 : 3);
  const named: OutSource[] = (p.lots ?? [])
    .filter(l => Number(l.usable) > LOT_EPS)
    .map(l => ({
      lotId: l.lotId, lotNumber: l.lotNumber, expiryDate: lotDay(l.expiryDate), status: l.status, blockKind: l.blockKind ?? null,
      usable: roundLot(Number(l.usable)), expired: isLotExpiredOn(l, day),
    }))
    .sort((a, b) => rank(a) - rank(b) || fefoCompare(a, b));
  const uu = Number(p.unknownUsable);
  return uu > LOT_EPS
    ? [...named, { lotId: null, lotNumber: null, expiryDate: null, status: null, blockKind: null, usable: roundLot(uu), expired: false }]
    : named;
}

/** توزيعٌ أوّلي بترتيب المصادر حتى الكمية — يعدّله المستخدم، والمجموع الناقص يبقى ناقصاً فيُرى لا يُخفى */
export function prefillOut(sources: readonly OutSource[], baseQty: number): LotRef[] {
  let left = roundLot(baseQty);
  const out: LotRef[] = [];
  for (const s of sources) {
    if (left <= LOT_EPS) break;
    const q = roundLot(Math.min(s.usable, left));
    if (q > LOT_EPS) { out.push({ lotId: s.lotId, qty: q }); left = roundLot(left - q); }
  }
  return out;
}

/** تعيين كمية مصدرٍ في صفوف السطر — الصفر والسالب يحذفان الصفّ، والترتيب يتبع المصادر */
export function setOutQty(rows: readonly LotRef[], sources: readonly OutSource[], lotId: string | null, qty: number): LotRef[] {
  const q = Number.isFinite(qty) ? roundLot(qty) : 0;
  const next = new Map(rows.map(r => [r.lotId, r.qty] as const));
  if (q > LOT_EPS) next.set(lotId, q); else next.delete(lotId);
  return sources.filter(s => next.has(s.lotId)).map(s => ({ lotId: s.lotId, qty: next.get(s.lotId)! }));
}

// ═══════════════ التشغيلات على الأوراق ═══════════════

/**
 * يضمّ تشغيلات كل بندٍ إلى بنود الورقة بموضعها (البانية تبني بندها من البند نفسه بالترتيب نفسه) — وما ضمّه بانيه أصلاً
 * يبقى كما هو، فلا تتكرّر حين تضيفه الحزمة المالكة للبانية. البند بلا صفوف لا يطبع شيئاً.
 */
export function withItemLots<T extends { lots?: DocLotLine[] }>(items: readonly T[], raw: readonly unknown[] | null | undefined): T[] {
  return items.map((it, i) => {
    if (it.lots !== undefined) return it;
    const r = raw?.[i] as { lots?: unknown } | null | undefined;
    const lots = docLotsFrom(r?.lots);
    return lots ? { ...it, lots } : it;
  });
}

/** تشغيلة سطر حركة المستودع (`lot` في السجل، سطرٌ = تشغيلة) — الكمية أساسية مطلقة. بلا تشغيلة: undefined */
export function entryDocLots(item: {
  lot?: { lotNumber?: string | null; expiryDate?: string | null } | null;
  qty: number; baseQty?: number | null; unitFactor?: number | null;
}): DocLotLine[] | undefined {
  if (!item.lot?.lotNumber) return undefined;
  const base = item.baseQty != null && Number.isFinite(Number(item.baseQty))
    ? roundLot(Math.abs(Number(item.baseQty)))
    : lineBaseQty(item.qty, item.unitFactor);
  if (base <= LOT_EPS) return undefined;
  return [{ lotNumber: item.lot.lotNumber, qty: base, expiryDate: lotDay(item.lot.expiryDate) }];
}

/** نصّ تشغيلةٍ مختصر في سطر: «L-12 · ينتهي 2026-12-01» — والرقم الغائب «غير مسمى» (المستدعي يترجم) */
export function lotLineLabel(l: { lotNumber: string | null; expiryDate?: string | null }, unnamed: string, expires: string): string {
  const d = lotDay(l.expiryDate);
  return [l.lotNumber ?? unnamed, d ? `${expires} ${d}` : ''].filter(Boolean).join(' · ');
}
