// ============================================================================
// «طلب بضاعة» المندوب — المنطق النقيّ (routes/repStockRequests.ts يستدعيه).
// المندوب يكتب ما يطلبه (requestedQty)، والإدارة تعدّل الكمية المعتمدة (qty)،
// والطلب العام للمشتريات يجمع المعتمد. لا شيء هنا يلمس المخزون.
// ============================================================================

/** سقفان يحرسان الجسم: طلبٌ بآلاف الأصناف أو بكمية فلكية خطأ إدخال لا طلب */
export const MAX_REQUEST_ITEMS = 500;
export const MAX_REQUEST_QTY = 1_000_000;

export interface ReqLine { productId: string; qty: number }
export interface StoredLine { productId: string; requestedQty: number; qty: number }

/** أربع خانات تكفي الكسور (كيلو، لتر) وتمنع فرق التمثيل العشريّ من أن يبدو «تغييراً» */
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const sameQty = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** ما أرسله المندوب: الصفر يُهمل (لم يطلب الصنف)، والمكرّر يُجمع في سطر واحد بترتيب أول ظهور */
export function normalizeRepLines(lines: ReqLine[]): ReqLine[] {
  const sum = new Map<string, number>();
  for (const l of lines) {
    const q = r4(l.qty);
    if (!(q > 0)) continue;
    sum.set(l.productId, r4((sum.get(l.productId) ?? 0) + q));
  }
  return [...sum].map(([productId, qty]) => ({ productId, qty }));
}

/**
 * رفعٌ جديد من المندوب فوق طلبه المعلّق. الصنف الذي لم يغيّر المندوب كميته يحتفظ بتعديل الإدارة —
 * وإلا محا كلُّ تصحيحٍ صغير من المندوب ما راجعته الإدارة في بقية الأصناف. والصنف الذي غيّره يعود
 * معتمَداً بما كتبه، والذي أزاله يخرج من الطلب.
 */
export function mergeRepUpdate(prev: StoredLine[], next: ReqLine[]): StoredLine[] {
  const old = new Map(prev.map((l) => [l.productId, l]));
  return next.map((n) => {
    const o = old.get(n.productId);
    return { productId: n.productId, requestedQty: n.qty, qty: o && sameQty(o.requestedQty, n.qty) ? o.qty : n.qty };
  });
}

/**
 * تعديل الإدارة: كميات معتمدة لأصنافٍ في الطلب نفسه (صفرٌ = حذف الصنف من طلب المندوب، ويبقى سطره
 * ليرى المندوب أنّ الإدارة ألغته). صنفٌ ليس في الطلب يُرفض: الإضافة للطلب العام تكون في كمياته لا هنا.
 */
export function applyAdminEdit(prev: StoredLine[], edits: ReqLine[]): { ok: true; lines: StoredLine[] } | { ok: false; productId: string } {
  const want = new Map<string, number>();
  for (const e of edits) want.set(e.productId, r4(e.qty));
  const known = new Set(prev.map((l) => l.productId));
  for (const id of want.keys()) if (!known.has(id)) return { ok: false, productId: id };
  return { ok: true, lines: prev.map((l) => (want.has(l.productId) ? { ...l, qty: Math.max(0, want.get(l.productId)!) } : l)) };
}
