// ============================================================================
// «طلب بضاعة» المندوب — المنطق النقيّ (routes/repStockRequests.ts يستدعيه).
// المندوب يكتب ما يطلبه (requestedQty)، والإدارة تعدّل الكمية المعتمدة (qty)،
// والطلب العام للمشتريات يجمع المعتمد. لا شيء هنا يلمس المخزون.
//
// الوحدات المتعددة: للصنف في الطلب **سطرٌ واحد** (@@unique([requestId, productId])) بوحدةٍ
// واحدة تحملها لقطته (unitName/unitFactor)، وrequestedQty وqty كلاهما بها. سطران للصنف
// نفسه بوحدةٍ واحدة يُجمعان بها؛ وبوحدتين («٥ كرتون» و«٣ حبة») يصيران سطراً بالأساس —
// الأساس يحمل كل كميةٍ بلا كسر، وأيّ وحدةٍ أكبر قد لا تحملها (٣ حبة = ٠٫١٢٥ كرتون).
// ============================================================================
import { factorOf, toBase } from './units';

/** سقفان يحرسان الجسم: طلبٌ بآلاف الأصناف أو بكمية فلكية خطأ إدخال لا طلب — والكمية تُقاس بالأساس */
export const MAX_REQUEST_ITEMS = 500;
export const MAX_REQUEST_QTY = 1_000_000;

/** وحدة السطر: اسمها ومعاملها (null/1 = الأساس، سلوك ما قبل الميزة) */
interface LineUnit { unitName?: string | null; unitFactor?: number | null }
export interface ReqLine extends LineUnit { productId: string; qty: number }
export interface StoredLine extends LineUnit { productId: string; requestedQty: number; qty: number }
/** سطرٌ يُكتب: الوحدة صريحة دائماً (الكتابة تمرّ بـunitFields) */
export interface OutLine { productId: string; requestedQty: number; qty: number; unitName: string | null; unitFactor: number }
/**
 * تعديل الإدارة لكمية صنف. الوحدة **غائبة** ⇒ بوحدة سطر المندوب نفسه (الإداري يكتب رقماً بجانب وحدة السطر)؛
 * وحاضرةً بوحدةٍ أخرى ⇒ يصير السطر بالأساس.
 */
export interface AdminEdit extends LineUnit { productId: string; qty: number }

/** أربع خانات تكفي الكسور (كيلو، لتر) وتمنع فرق التمثيل العشريّ من أن يبدو «تغييراً» */
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const sameQty = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const nameOf = (u: LineUnit) => u.unitName?.trim() || null;
const sameUnit = (a: LineUnit, b: LineUnit) => factorOf(a) === factorOf(b) && nameOf(a) === nameOf(b);
const unitOf = (u: LineUnit) => ({ unitName: nameOf(u), unitFactor: factorOf(u) });

/** المندوب يرسل ما يطلبه: الصفر يُهمل (لم يطلب الصنف)، والمكرّر يُجمع في سطر واحد بترتيب أول ظهور */
export function normalizeRepLines(lines: ReqLine[]): (ReqLine & { unitName: string | null; unitFactor: number })[] {
  const byProduct = new Map<string, ReqLine[]>();
  for (const l of lines) {
    const q = r4(l.qty);
    if (!(q > 0)) continue;
    const list = byProduct.get(l.productId) ?? [];
    list.push({ ...l, qty: q });
    byProduct.set(l.productId, list);
  }
  return [...byProduct].map(([productId, ls]) => {
    // وحدةٌ واحدة ⇒ يُجمع بها كما كتبها المندوب؛ وحدتان ⇒ بالأساس (لا يُقرَب «٣ حبة» إلى كسر كرتون)
    if (ls.every((l) => sameUnit(l, ls[0]))) {
      return { productId, qty: r4(ls.reduce((s, l) => s + l.qty, 0)), ...unitOf(ls[0]) };
    }
    return { productId, qty: r4(ls.reduce((s, l) => s + toBase(l.qty, l), 0)), unitName: null, unitFactor: 1 };
  });
}

/** السطر المخزَّن بالحقول التي تُكتب وحدها — لا يحمل معه معرّفاً أو baseQty قديماً */
const outOf = (l: StoredLine): OutLine => ({ productId: l.productId, requestedQty: l.requestedQty, qty: l.qty, ...unitOf(l) });

/**
 * رفعٌ جديد من المندوب فوق طلبه المعلّق. الصنف الذي لم يغيّر المندوب كميته يحتفظ بتعديل الإدارة —
 * وإلا محا كلُّ تصحيحٍ صغير من المندوب ما راجعته الإدارة في بقية الأصناف. والصنف الذي غيّره يعود
 * معتمَداً بما كتبه، والذي أزاله يخرج من الطلب.
 *
 * «لم يغيّر» تُقاس **بالأساس**: «٢٤ حبة» بعد «١ كرتون» الطلبُ نفسه فيبقى السطر بوحدته وتعديله، و«٢ كرتون» بعد
 * «٢ حبة» تغييرٌ ولو تساوى الرقمان.
 */
export function mergeRepUpdate(prev: StoredLine[], next: ReqLine[]): OutLine[] {
  const old = new Map(prev.map((l) => [l.productId, l]));
  return next.map((n) => {
    const o = old.get(n.productId);
    if (o && sameQty(toBase(o.requestedQty, o), toBase(n.qty, n))) return outOf(o);
    return { productId: n.productId, requestedQty: n.qty, qty: n.qty, ...unitOf(n) };
  });
}

/**
 * تعديل الإدارة: كميات معتمدة لأصنافٍ في الطلب نفسه (صفرٌ = حذف الصنف من طلب المندوب، ويبقى سطره
 * ليرى المندوب أنّ الإدارة ألغته). صنفٌ ليس في الطلب يُرفض: الإضافة للطلب العام تكون في كمياته لا هنا.
 *
 * الكمية بوحدة السطر ما لم يحمل التعديل وحدة. وبوحدةٍ غير وحدة السطر يُعاد السطر كلّه إلى الأساس —
 * طلبُ المندوب ومعتمدُ الإدارة على سطرٍ واحد بوحدةٍ واحدة لا تُخلط: «طلب ٥ كرتون، اعتُمد ١٠٠ حبة»
 * يصير «طلب ١٢٠ حبة، اعتُمد ١٠٠ حبة».
 */
export function applyAdminEdit(prev: StoredLine[], edits: AdminEdit[]): { ok: true; lines: OutLine[] } | { ok: false; productId: string } {
  const want = new Map<string, AdminEdit>();
  for (const e of edits) want.set(e.productId, { ...e, qty: r4(e.qty) });
  const known = new Set(prev.map((l) => l.productId));
  for (const id of want.keys()) if (!known.has(id)) return { ok: false, productId: id };
  return {
    ok: true,
    lines: prev.map((l) => {
      const line = outOf(l);
      const e = want.get(l.productId);
      if (!e) return line;
      const qty = Math.max(0, e.qty);
      if (e.unitFactor == null || sameUnit(e, line)) return { ...line, qty };
      return { productId: l.productId, requestedQty: r4(toBase(l.requestedQty, l)), qty: r4(toBase(qty, e)), unitName: null, unitFactor: 1 };
    }),
  };
}
