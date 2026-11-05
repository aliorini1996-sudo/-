// ═══ قواعد قوائم الأسعار (طلب المالك ٥ نوفمبر ٢٠٢٦ — على نسق قوائم أسعار Odoo) ═══
// ملفٌّ نقيّ بلا استيراد، ونسختان **متطابقتان حرفاً** (يثبته اختبارٌ في الطرفين):
//   backend/src/services/priceRules.ts  ⇄  web-admin/src/lib/priceRules.ts
// يستعمله حارس سعر المندوب في الخادم (routes/invoices.ts)، وفاتورة الإدارة، و/m، وتطبيق المندوب أوف‑لاين —
// فالسعر الذي يقترحه الجهاز هو المرجع الذي يحرسه الخادم بالحساب نفسه.
//
// ═══ النموذج ═══
// القائمة (PriceList) فيها:
//   • أسعار أصنافٍ ثابتة (PriceListItem): لكلّ صنفٍ سعرٌ واحد بلا شرط، لوحدة الأساس — «قاعدة صنفٍ» بلا حدّ ولا فترة.
//   • قواعد (PriceListRule): على صنف أو فئة أو كل الأصناف؛ سعرٌ ثابت أو نسبة؛ بحدٍّ أدنى للكمية وفترة صلاحية.
// ما لا تقول فيه القائمة شيئاً يُكمل سلّم اليوم حرفياً: سعر الوحدة المحدَّد ثم الأساس × المعامل.
// وسعر العميل الخاص (CustomerPrice) يغلب القائمة كلّها كاليوم — يقرّره المستدعي قبل هذا الملف.
//
// ═══ الأولوية بين ما ينطبق (كترتيب Odoo) ═══
//   ١. الأخصّ: صنف ثم فئة ثم كل الأصناف.
//   ٢. الأعلى حدّاً أدنى للكمية (شريحة ١٠ كراتين تغلب شريحة ١ حين تتحقّق الاثنتان).
//   ٣. المؤقّتة (لها فترة) قبل المفتوحة — العرض المؤقّت يغلب السعر الدائم.
//   ٤. قاعدةٌ مكتوبة قبل سعر الصنف الثابت في القائمة عند التساوي.
//   ٥. الأحدث تعديلاً، ثم المعرّف — ترتيبٌ ثابتٌ في كل الأجهزة.
//
// ═══ الوحدات ═══
//   • basePrice (صنف): صافٍ لوحدة الأساس (ستّ منازل) كـPriceListItem ⇒ مرجع البند = basePrice × معامل وحدة البند.
//   • primaryPrice (فئة): صافٍ للوحدة الرئيسية لكل صنف ⇒ لوحدة الأساس = تقريب(primaryPrice ÷ معامل الرئيسية، ٦).
//   • percent: من «سعر البند بلا قائمة» (سعر الوحدة المحدَّد وإلا الأساس × المعامل) — موجبة خصم وسالبة زيادة.
//   • minQty: بالوحدة الرئيسية، يُقارن بمجموع كمية الصنف في الفاتورة كلّها (كل بنوده بكل وحداتها) ÷ معامل الرئيسية.
//   • startsOn/endsOn: يوم الشركة 'YYYY-MM-DD' شاملاً الطرفين.

export type PriceRuleScope = 'product' | 'category' | 'all';
export type PriceRuleKind = 'fixed' | 'percent';

/** صفّ قاعدة كما يخزّنه الخادم ويرسله للأجهزة (الحقول الزائدة لا تضرّ) */
export interface PriceRuleRow {
  id: string;
  scope: string;
  productId?: string | null;
  categoryId?: string | null;
  kind: string;
  basePrice?: number | null;
  primaryPrice?: number | null;
  percent?: number | null;
  minQty?: number | null;
  startsOn?: string | null;
  endsOn?: string | null;
  updatedAt?: string | number | Date | null;
}

/** الصنف كما يحتاجه الحلّ */
export interface PriceRuleProduct {
  id: string;
  categoryId?: string | null;
  /** معامل الوحدة الرئيسية — 1 لصنفٍ بلا رئيسية */
  primaryFactor?: number | null;
}

export const PRICE_RULE_SCOPES: readonly PriceRuleScope[] = ['product', 'category', 'all'];
export const PRICE_RULE_KINDS: readonly PriceRuleKind[] = ['fixed', 'percent'];
/** حدود الكتابة: النسبة من −٥٠٠٪ (زيادة) إلى ١٠٠٪ (خصمٌ كامل)، والحدّ الأدنى للكمية، وعدد القواعد في القائمة */
export const PRICE_RULE_LIMITS = { percentMin: -500, percentMax: 100, minQtyMax: 1_000_000_000, perList: 2000 } as const;
/** منازل سعر الأساس المخزَّن (= LIST_PRICE_DECIMALS في services/priceLists.ts) */
export const PRICE_RULE_BASE_DECIMALS = 6;

/** رسائل رفض القاعدة — نصّ واحد للخادم (400 PRICE_RULE_INVALID) والواجهة (tr) */
export const PRICE_RULE_MESSAGES = {
  scope: 'اختر ما تطبق عليه القاعدة: صنف أو فئة أو كل الأصناف',
  product: 'اختر الصنف',
  category: 'اختر الفئة',
  kind: 'اختر نوع السعر: سعر ثابت أو نسبة',
  allFixed: 'كل الأصناف تقبل نسبة خصم أو زيادة فقط لا سعرا ثابتا',
  price: 'السعر رقم صفر أو أكثر',
  percent: 'النسبة بين 500- و100 ولا تكون صفرا',
  minQty: 'الحد الأدنى للكمية رقم صفر أو أكثر',
  day: 'التاريخ غير صحيح',
  range: 'تاريخ النهاية قبل تاريخ البداية',
} as const;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EPS = 1e-9;

/** يومٌ تقويميٌّ صحيح 'YYYY-MM-DD' */
export function isPriceRuleDay(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= days;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** تقريب نصف-لأعلى (نظير roundHalfUp في lib/money.ts — منسوخٌ هنا ليبقى الملف بلا استيراد) */
export function roundPriceRule(value: number, decimals: number = PRICE_RULE_BASE_DECIMALS): number {
  if (!Number.isFinite(value)) return value;
  const f = Math.pow(10, decimals);
  const scaled = Number((value * f).toPrecision(12));
  const sign = scaled < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(scaled))) / f;
}

/**
 * سبب رفض القاعدة أو null إن صلحت — للكتابة (الخادم) والنموذج (الواجهة). الحقول المرسلة كما هي:
 * للسعر الثابت لصنفٍ يُرسل `price` (بالوحدة الرئيسية كما يُدخَل) ويُحوَّل للأساس في المسار؛ ولفئةٍ `price` بالرئيسية.
 */
export function priceRuleProblem(r: {
  scope?: unknown; productId?: unknown; categoryId?: unknown; kind?: unknown;
  price?: unknown; percent?: unknown; minQty?: unknown; startsOn?: unknown; endsOn?: unknown;
}): string | null {
  const scope = r.scope;
  if (scope !== 'product' && scope !== 'category' && scope !== 'all') return PRICE_RULE_MESSAGES.scope;
  if (scope === 'product' && (typeof r.productId !== 'string' || r.productId.trim() === '')) return PRICE_RULE_MESSAGES.product;
  if (scope === 'category' && (typeof r.categoryId !== 'string' || r.categoryId.trim() === '')) return PRICE_RULE_MESSAGES.category;
  if (r.kind !== 'fixed' && r.kind !== 'percent') return PRICE_RULE_MESSAGES.kind;
  if (r.kind === 'fixed') {
    if (scope === 'all') return PRICE_RULE_MESSAGES.allFixed;
    const p = num(r.price);
    if (p === null || p < 0) return PRICE_RULE_MESSAGES.price;
  } else {
    const pct = num(r.percent);
    if (pct === null || Math.abs(pct) < EPS || pct < PRICE_RULE_LIMITS.percentMin || pct > PRICE_RULE_LIMITS.percentMax) {
      return PRICE_RULE_MESSAGES.percent;
    }
  }
  if (r.minQty !== undefined && r.minQty !== null && r.minQty !== '') {
    const q = num(r.minQty);
    if (q === null || q < 0 || q > PRICE_RULE_LIMITS.minQtyMax) return PRICE_RULE_MESSAGES.minQty;
  }
  const start = r.startsOn === '' ? null : r.startsOn ?? null;
  const end = r.endsOn === '' ? null : r.endsOn ?? null;
  if (start !== null && !isPriceRuleDay(start)) return PRICE_RULE_MESSAGES.day;
  if (end !== null && !isPriceRuleDay(end)) return PRICE_RULE_MESSAGES.day;
  if (start !== null && end !== null && (end as string) < (start as string)) return PRICE_RULE_MESSAGES.range;
  return null;
}

/** صفٌّ صالحٌ للحلّ (ما خالف يُتجاهل بصمت: كاشٌ قديم أو صفٌّ تالف لا يسعّر) */
function usable(r: PriceRuleRow | null | undefined): r is PriceRuleRow {
  if (!r || typeof r.id !== 'string') return false;
  if (r.scope === 'product') { if (!r.productId) return false; }
  else if (r.scope === 'category') { if (!r.categoryId) return false; }
  else if (r.scope !== 'all') return false;
  if (r.kind === 'fixed') {
    if (r.scope === 'all') return false;
    const v = num(r.scope === 'product' ? r.basePrice : r.primaryPrice);
    if (v === null || v < 0) return false;
  } else if (r.kind === 'percent') {
    const pct = num(r.percent);
    if (pct === null || pct < PRICE_RULE_LIMITS.percentMin || pct > PRICE_RULE_LIMITS.percentMax) return false;
  } else return false;
  const q = num(r.minQty) ?? 0;
  if (q < 0) return false;
  if (r.startsOn != null && !isPriceRuleDay(r.startsOn)) return false;
  if (r.endsOn != null && !isPriceRuleDay(r.endsOn)) return false;
  return true;
}

/** هل تنطبق القاعدة على الصنف بكميته (بالرئيسية) في يوم الشركة؟ */
export function priceRuleMatches(r: PriceRuleRow, p: PriceRuleProduct, qtyPrimary: number, day: string): boolean {
  if (!usable(r)) return false;
  if (r.scope === 'product' && r.productId !== p.id) return false;
  if (r.scope === 'category' && (!p.categoryId || r.categoryId !== p.categoryId)) return false;
  const q = Number.isFinite(qtyPrimary) ? qtyPrimary : 0;
  if ((num(r.minQty) ?? 0) > q + EPS) return false;
  if (r.startsOn != null && day < r.startsOn) return false;
  if (r.endsOn != null && day > r.endsOn) return false;
  return true;
}

const SCOPE_RANK: Record<string, number> = { product: 0, category: 1, all: 2 };
const stamp = (v: PriceRuleRow['updatedAt']): number => {
  if (v === null || v === undefined) return 0;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};
/** سعر الصنف الثابت في القائمة ممثَّلاً قاعدةً بلا معرّف (يُعرف بها في الترتيب) */
const ITEM_ID = '';

/** ترتيب الأولوية: السالب = a أولى */
export function comparePriceRules(a: PriceRuleRow, b: PriceRuleRow): number {
  const s = (SCOPE_RANK[a.scope] ?? 9) - (SCOPE_RANK[b.scope] ?? 9);
  if (s !== 0) return s;
  const q = (num(b.minQty) ?? 0) - (num(a.minQty) ?? 0);
  if (Math.abs(q) > EPS) return q;
  const dated = (r: PriceRuleRow) => (r.startsOn != null || r.endsOn != null ? 0 : 1);
  const d = dated(a) - dated(b);
  if (d !== 0) return d;
  const item = (r: PriceRuleRow) => (r.id === ITEM_ID ? 1 : 0);
  const it = item(a) - item(b);
  if (it !== 0) return it;
  const t = stamp(b.updatedAt) - stamp(a.updatedAt);
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** القاعدة الغالبة من قواعد قائمةٍ واحدة، أو null */
export function pickPriceRule(rules: readonly PriceRuleRow[] | null | undefined, p: PriceRuleProduct, qtyPrimary: number, day: string): PriceRuleRow | null {
  let best: PriceRuleRow | null = null;
  for (const r of rules ?? []) {
    if (!priceRuleMatches(r, p, qtyPrimary, day)) continue;
    if (best === null || comparePriceRules(r, best) < 0) best = r;
  }
  return best;
}

/** ما تقوله القائمة لصنف: سعرٌ لوحدة الأساس، أو نسبة، أو null (فيُكمل سلّم اليوم) */
export type ListPriceResult =
  | { kind: 'base'; perBase: number; ruleId: string | null }
  | { kind: 'percent'; percent: number; ruleId: string }
  | null;

/** معامل الرئيسية الصالح (1 لما سواه) */
export function primaryFactorOfRule(p: PriceRuleProduct): number {
  const f = num(p.primaryFactor);
  return f !== null && f > 0 ? f : 1;
}

/** كمية الصنف بالرئيسية من مجموع كميته بالأساس */
export function qtyPrimaryOf(totalBaseQty: number, p: PriceRuleProduct): number {
  const q = Number(totalBaseQty);
  return Number.isFinite(q) ? q / primaryFactorOfRule(p) : 0;
}

/**
 * سعر القائمة لصنف: `itemPerBase` = سعره الثابت فيها (PriceListItem) أو null، و`rules` قواعد **هذه القائمة** وحدها.
 * بلا قواعد ⇒ سلوك اليوم حرفياً: سعر الصنف الثابت إن وُجد، وإلا null.
 */
export function listPriceOf(
  itemPerBase: number | null | undefined,
  rules: readonly PriceRuleRow[] | null | undefined,
  p: PriceRuleProduct,
  qtyPrimary: number,
  day: string,
): ListPriceResult {
  const item = num(itemPerBase);
  const hasItem = item !== null && item >= 0;
  if (!rules || rules.length === 0) return hasItem ? { kind: 'base', perBase: item as number, ruleId: null } : null;
  const pool: PriceRuleRow[] = hasItem
    ? [...rules, { id: ITEM_ID, scope: 'product', productId: p.id, kind: 'fixed', basePrice: item, minQty: 0 }]
    : [...rules];
  const r = pickPriceRule(pool, p, qtyPrimary, day);
  if (!r) return null;
  const ruleId = r.id === ITEM_ID ? null : r.id;
  if (r.kind === 'percent') return { kind: 'percent', percent: num(r.percent) as number, ruleId: r.id };
  if (r.scope === 'product') return { kind: 'base', perBase: num(r.basePrice) as number, ruleId };
  return { kind: 'base', perBase: roundPriceRule((num(r.primaryPrice) as number) / primaryFactorOfRule(p)), ruleId };
}

/**
 * المرجع الصافي لوحدة البند من سعر القائمة، أو null (لا تقول القائمة شيئاً).
 * `lineFactor` معامل وحدة البند، و`noListRef` سعر البند بلا قائمة (سعر الوحدة المحدَّد وإلا الأساس × المعامل).
 */
export function listLineRef(lp: ListPriceResult, lineFactor: number, noListRef: number): number | null {
  if (!lp) return null;
  if (lp.kind === 'base') return lp.perBase * (Number.isFinite(lineFactor) && lineFactor > 0 ? lineFactor : 1);
  return noListRef * (1 - lp.percent / 100);
}

/**
 * ما يعادل سعر القائمة لوحدة الأساس (لتلميحٍ أو لتخمين وحدة الإعادة): الثابت كما هو، والنسبة من سعر الأساس.
 */
export function listPerBaseHint(lp: ListPriceResult, basePrice: number): number | null {
  if (!lp) return null;
  if (lp.kind === 'base') return lp.perBase;
  const b = Number(basePrice);
  return Number.isFinite(b) ? b * (1 - lp.percent / 100) : null;
}

/** هل في القائمة قاعدةٌ تتأثر بالكمية أو باليوم؟ (فيُعاد التسعير عند تغيّر الكمية) */
export function rulesDependOnQty(rules: readonly PriceRuleRow[] | null | undefined): boolean {
  return (rules ?? []).some(r => (num(r.minQty) ?? 0) > 0);
}
