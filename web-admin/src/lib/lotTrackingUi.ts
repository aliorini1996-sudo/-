// ============================================================================
// «تتبّع اللوط» — منطق الواجهة الصرف لتفعيله: نافذة المالك، ونافذة الصنف، والتفعيل
// الجماعي في صفحة المنتجات، وتحذير حذف المندوب (W1، المواصفة §٦.١ و§٤.١ و§٤.٢ و§٤.١٩).
// ----------------------------------------------------------------------------
// كل ما هنا بلا شبكة ولا React فيُختبر وحده (lotTrackingUi.test.ts). والقاعدة الحاكمة:
// الميزة المطفأة لا تغيّر شيئاً (§١٠.١) — لا حقل جديد في الحمولة، ولا طلب، ولا عنصر.
// كل كمية هنا بوحدة الأساس (D22).
// ============================================================================

import { LOT_EPS, lotErrorOf, roundLot, type LotTrackingRequest, type LotTrackingResultDto } from './lots';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

// ─── نافذة المالك (§٤.١، D8) ───

/**
 * التنبيه تحت مربع «تتبّع اللوط» في نافذة تعديل الشركة بحسب الانتقال:
 * - `OFF`: إطفاءٌ لشركةٍ مفعّلة — يُخفي ولا يحذف، والسجلات تُحفظ ١٨٠ يوماً (D8).
 * - `NEW_EPOCH`: إعادة تفعيلٍ لشركةٍ سبق تفعيلها (lotTrackingSince مضبوط) — حقبة جديدة، والمسمّى يصير غير مسمّى (D25).
 * - `FIRST_ON`: أول تفعيل — إجراء يوم التفعيل.
 */
export function tenantLotNote(
  tenant: { lotTrackingEnabled?: boolean | null; lotTrackingSince?: string | null },
  next: boolean,
): 'OFF' | 'NEW_EPOCH' | 'FIRST_ON' | null {
  const was = tenant.lotTrackingEnabled === true;
  if (was === next) return null;
  if (!next) return 'OFF';
  return tenant.lotTrackingSince ? 'NEW_EPOCH' : 'FIRST_ON';
}

/**
 * العلم في حمولة PUT /tenants/:id **حين يتغيّر وحده**: الخادم يقرأ السابق ويفتح معاملة الحقبة بمهلتها متى حمل الجسم المفتاح
 * (tenants.ts)، فحفظ النافذة لتعديلٍ آخر لا يمرّ بها.
 */
export function tenantLotPayload(tenant: { lotTrackingEnabled?: boolean | null }, next: boolean): { lotTrackingEnabled?: boolean } {
  return (tenant.lotTrackingEnabled === true) === next ? {} : { lotTrackingEnabled: next };
}

/** تفاصيل 409 LOT_RECORDS_RETAINED عند حذف الشركة (D31) — وإلا null */
export function lotRecordsRetainedOf(err: unknown): { lots: number; expiryFrom: string | null; retentionDays: number } | null {
  const e = lotErrorOf(err);
  if (!e || e.code !== 'LOT_RECORDS_RETAINED') return null;
  const d = e.detail ?? {};
  return { lots: Math.max(0, Math.trunc(num(d.lots))), expiryFrom: str(d.expiryFrom), retentionDays: num(d.retentionDays) || 180 };
}

// ─── نافذة الصنف (§٤.٢، D9) ───

/**
 * `lotTracked` في حمولة حفظ الصنف: لا يُرسل والميزة مطفأة، ولا يُرسل إلا حين يتغيّر (الصنف الجديد: حين يُفعَّل). الخادم يقرأ علم
 * الشركة ويقفل الصنف حين يحمل الجسم انتقالاً، فالحمولة بلا انتقال تبقى كما كانت.
 */
export function productLotPayload(
  product: { lotTracked?: boolean | null } | null, lotOn: boolean, value: boolean,
): { lotTracked?: boolean } {
  if (!lotOn) return {};
  if (!product) return value ? { lotTracked: true } : {};
  return (product.lotTracked === true) === value ? {} : { lotTracked: value };
}

/** التنبيه تحت مربع «تتبّع باللوط» في نافذة الصنف: إطفاءٌ يُخفي ولا يحذف، أو إعادة تفعيلٍ تبدأ حقبة جديدة */
export function productLotNote(
  product: { lotTracked?: boolean | null; lotTrackedSince?: string | null } | null, value: boolean,
): 'OFF' | 'NEW_EPOCH' | null {
  if (!product) return null;
  const was = product.lotTracked === true;
  if (was === value) return null;
  if (!value) return 'OFF';
  return product.lotTrackedSince ? 'NEW_EPOCH' : null;
}

export interface TrackingBalanceProduct {
  productId: string; name: string | null; warehouse: number; vans: { salesRepId: string; qty: number }[]; qty: number;
}

/**
 * تفاصيل 409 LOT_TRACKING_HAS_BALANCE (D9) من مساريه: تعديل الصنف (products.ts) والإطفاء الجماعي (routes/lots.ts) — كلاهما
 * `{updated, products: [{productId, name, warehouse, vans: [{salesRepId, qty}], qty}]}`. غير ذلك null.
 */
export function trackingBalanceOf(err: unknown): { updated: number; products: TrackingBalanceProduct[] } | null {
  const e = lotErrorOf(err);
  if (!e || e.code !== 'LOT_TRACKING_HAS_BALANCE') return null;
  const d = e.detail ?? {};
  const raw = Array.isArray(d.products) ? d.products : [];
  const products: TrackingBalanceProduct[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object' || !str(p.productId)) continue;
    const vans = (Array.isArray(p.vans) ? p.vans : [])
      .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !!str((v as Record<string, unknown>).salesRepId))
      .map(v => ({ salesRepId: String(v.salesRepId), qty: roundLot(num(v.qty)) }))
      .filter(v => v.qty > LOT_EPS);
    const warehouse = roundLot(num(p.warehouse));
    const qty = p.qty !== undefined ? roundLot(num(p.qty)) : roundLot(warehouse + vans.reduce((s, v) => s + v.qty, 0));
    products.push({ productId: String(p.productId), name: str(p.name), warehouse, vans, qty });
  }
  return { updated: Math.max(0, Math.trunc(num(d.updated))), products };
}

// ─── التفعيل الجماعي (§٤.٢) ───

/** سقف الأصناف المحدّدة في طلبٍ واحد (trackingSchema في routes/lots.ts) */
export const LOT_TRACKING_MAX_IDS = 1000;

export type TrackingScope =
  | { kind: 'selected'; ids: readonly string[] }
  | { kind: 'category'; categoryId: string }
  | { kind: 'all' };

/**
 * جسم POST /lots/products/tracking — نطاقٌ واحد بالضبط (المحدّد أو الفئة أو الكل) كما يشترط الخادم، والتأكيد مع الإطفاء وحده.
 * نطاقٌ فارغ أو فوق السقف ⇒ null فلا يُرسل.
 */
export function trackingRequest(scope: TrackingScope, enabled: boolean, confirmLotBalances = false): LotTrackingRequest | null {
  const confirm = !enabled && confirmLotBalances ? { confirmLotBalances: true } : {};
  if (scope.kind === 'selected') {
    const ids = [...new Set(scope.ids.filter(id => typeof id === 'string' && id.length > 0))];
    if (!ids.length || ids.length > LOT_TRACKING_MAX_IDS) return null;
    return { enabled, productIds: ids, ...confirm };
  }
  if (scope.kind === 'category') return scope.categoryId ? { enabled, categoryId: scope.categoryId, ...confirm } : null;
  return { enabled, all: true, ...confirm };
}

export interface AttentionRow {
  productId: string; name: string;
  warehouse: { total: number; unknown: number } | null;
  vans: { salesRepId: string; total: number; unknown: number }[];
  /** رصيدٌ سالب في مكانٍ ما — يُصحَّح بتسوية موجبة غير مسمّاة قبل البيع (إجراء يوم التفعيل ١) */
  negative: boolean;
}

/**
 * needsAttention من ردّ التفعيل الجماعي: الأصناف ذات الرصيد غير المسمّى أو السالب في المستودع أو سيارة. شكلٌ غير متوقَّع يسقط
 * (النافذة إرشادٌ لا يُسقط الصفحة)، والسالب أولاً لأنه يُصحَّح قبل التسمية.
 */
export function attentionRows(data: unknown): AttentionRow[] {
  const list = (data as Partial<LotTrackingResultDto> | null)?.needsAttention;
  if (!Array.isArray(list)) return [];
  const out: AttentionRow[] = [];
  for (const r of list as unknown as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object' || !str(r.productId)) continue;
    const w = r.warehouse && typeof r.warehouse === 'object' ? (r.warehouse as Record<string, unknown>) : null;
    const warehouse = w ? { total: roundLot(num(w.total)), unknown: roundLot(num(w.unknown)) } : null;
    const vans = (Array.isArray(r.vans) ? r.vans : [])
      .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !!str((v as Record<string, unknown>).salesRepId))
      .map(v => ({ salesRepId: String(v.salesRepId), total: roundLot(num(v.total)), unknown: roundLot(num(v.unknown)) }));
    const negative = [warehouse, ...vans].some(p => !!p && (p.total < -LOT_EPS || p.unknown < -LOT_EPS));
    out.push({ productId: String(r.productId), name: str(r.name) ?? '', warehouse, vans, negative });
  }
  return out.sort((a, b) => Number(b.negative) - Number(a.negative));
}

// ─── تحذير حذف المندوب (§٤.١٩) ───

/**
 * التشغيلات المسمّاة الباقية في سيارة المندوب من لقطتها (GET /van-stock/lot-balances): ما صالحه موجب أيّاً كانت حالته (الموقوفة
 * والمنتهية تبقى في السيارة المحذوفة أيضاً وتُنزَّل منها). شكلٌ غير متوقَّع يعود صفراً: التحذير لا يُسقط حوار الحذف.
 */
export function vanLotsLeft(snap: unknown): { lots: number; products: number; qty: number } {
  const products = (snap as { products?: unknown } | null)?.products;
  if (!Array.isArray(products)) return { lots: 0, products: 0, qty: 0 };
  let lots = 0;
  let withLots = 0;
  let qty = 0;
  for (const p of products as { lots?: unknown }[]) {
    if (!p || !Array.isArray(p.lots)) continue;
    let any = false;
    for (const l of p.lots as { usable?: unknown }[]) {
      const u = num(l?.usable);
      if (u <= LOT_EPS) continue;
      lots += 1;
      qty += u;
      any = true;
    }
    if (any) withLots += 1;
  }
  return { lots, products: withLots, qty: roundLot(qty) };
}

/** يملأ {lots} و{qty} في النصّ المترجَم — بعد tr لا قبله، فالمفتاح ثابت والرقم متغيّر */
export function fillVanLots(text: string, left: { lots: number; qty: number }, fmt: (n: number) => string = String): string {
  return text.split('{lots}').join(fmt(left.lots)).split('{qty}').join(fmt(left.qty));
}

/** نصّ تحذير حذف المندوب — مفتاح القاموس (strings.ts، علامة W1)، و{lots} و{qty} يُملآن بعد الترجمة */
export const REP_DELETE_LOTS = 'في سيارته {lots} تشغيلة بكمية {qty} وتبقى في سيارة محذوفة يمكن تنزيلها من شاشة التتبع';
