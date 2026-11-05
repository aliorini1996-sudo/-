/**
 * «نوع سعر المندوب» في نافذة فاتورة الإدارة (InvoiceModal — طلب المالك ٢ نوفمبر ٢٠٢٦) — منطقٌ صرف بلا React ولا شبكة، يُختبر وحده
 * (invoiceModalRepPrice.test.ts). القاعدة نفسها defaultPriceTypeOf المشتركة مع الخادم حرفاً — لا تُكرَّر هنا.
 *
 * نوع الفاتورة: ما اختاره المدير برقاقة إن اختار — والمدير حرٌّ بين كل الأنواع (قيد «الأنواع المسموحة» للمندوب وحده) — وإلا
 * الافتراضي: نوع العميل ?? النوع الافتراضي للمندوب المختار ?? السعر الأساسي (null). تغيير العميل يعيد الاختيار إلى الافتراضي كما كان،
 * وتغيير المندوب يغيّر الافتراضي وحده: النوع يتبعه ما لم يختر المدير رقاقة. والبنود التي لم يُعدَّل سعرها تُعاد بالنوع الجديد.
 *
 * ═══ «قوائم الأسعار» بقواعدها (طلب المالك ٥ نوفمبر ٢٠٢٦) — تسعير البند في فاتورة الإدارة و/m (MInvoiceCreate عبر mUnits) ═══
 * المسعِّر الواحد `docLinePricerOf`: سعر العميل الخاص يغلب كل شيء كاليوم، ثم ما تقوله قائمة الفاتورة (سعر الصنف الثابت فيها
 * وقواعدها: نسبة، فئة، حدٌّ أدنى للكمية، فترة) **بكمية الصنف في الفاتورة كلّها** ويوم الفاتورة (pricingDayOf)، ثم سلّم اليوم —
 * عبر lineNetWithList (lib/priceListPricing.ts) فيُقترح ما يحسبه حارس الخادم. ⚠️ صافياً قبل الضريبة، ويُقرَّب لأربع منازل حين يأتي
 * من سعر العميل أو القائمة كما كان suggestedNetOf (١٠٠ ÷ ٢٤ × ٢٤ = 100.000008)، وبلاهما choiceNet كما كان حرفاً.
 * والكمية تغيّر السعر الآن (شريحة «من ١٠ كراتين»)، فكل تغيّرٍ في كمية صنفٍ يعيد تسعير بنوده التي لم يمسّها المستخدم وحدها
 * (`repriceDocLines` ← repriceUntouched): المعدَّل يدويّاً يبقى بسعره ويتبع مرجعه وحده.
 * شركةٌ بلا قوائم: لا قواعد تُجلب ولا قائمة، فالمسعِّر سعر العميل ثم choiceNet — الناتج نفسه حرفاً، وإعادة التسعير بالكمية لا تغيّر شيئاً.
 *
 * الأداء (مراجعة D5 — ٢٠٠٠ قاعدة × ١٠٠٠ صنف كانت ثوانيَ مع كل حرفٍ في خانة الكمية): الحلّ يُقيَّم **مرّةً واحدة** لكل نداء (كان
 * مرّتين: lineNetWithList ثم listResultFor للتقريب)، وقواعدُ خارج يوم الفاتورة تُسقط مرّةً عند بناء المسعِّر (الشرطان نفساهما في
 * priceRuleMatches فلا يتغيّر ناتج)، وما يخصّ الصنف (سعر العميل وسعره الثابت وقواعده) يُحسب مرّةً لكل صنف، وما تقوله القائمة
 * محفوظٌ بكمية الصنف بالرئيسية — ولا كمية أصلاً حين لا قاعدة بحدٍّ أدنى (`dependsOnQty`). والحلّ يُقسم كما يرتّب هو (الأخصّ يغلب):
 * سعر الصنف الثابت وقواعده أولاً، ثم قواعد الفئة وكل الأصناف بناتجٍ مشتركٍ لأصناف الفئة والرئيسية نفسيهما — فـ٢٠٠٠ قاعدة «كل الأصناف»
 * تُقيَّم مرّةً لكل فئة لا لكل صنف (lib/docLinePricerPerf.test.ts يقارنه بالمسعِّر القديم حرفاً). والمستدعي لا يعيد تسعير الكتالوج
 * ولا البنود كلّها مع كل حرف: `pickOptionsAtQty` و`repriceDocLines(…, productId)`.
 * ويوم التسعير (مراجعة D1): التاريخ الذي يُرسل للخادم إن اختير، وإلا يوم الشركة الآن بمنطقتها — `docPricingDayOf`.
 */
import { defaultPriceTypeOf, listPriceMap, repriceUntouched } from './priceLists';
import { roundHalfUp } from './money';
import type { ProductListPrice } from '../types';
import { choiceById, choiceNet, rebaseCustPrices, type CustPriceInput, type UnitChoice, type UnitProduct } from '../rep/repUnits';
import { baseQtyByProduct, listDependsOnQty, pricingDayOf, ruleProductOf, type PricedProduct, type PriceRuleRow } from './priceListPricing';
import { listLineRef, listPriceOf, qtyPrimaryOf, type ListPriceResult, type PriceRuleProduct } from './priceRules';

/** اختيار المدير برقاقة: undefined = لم يختر (يتبع الافتراضي)، null = السعر الأساسي صريحاً، أو معرّف نوع */
export type AdminListChoice = string | null | undefined;

/** نوع سعر الفاتورة الذي تُسعَّر به البنود ويُرسل — شركةٌ بلا أنواع ⇒ null (ولا مفتاح في الجسم) */
export function adminInvoiceListOf(
  listsOn: boolean, choice: AdminListChoice, custList: string | null | undefined, repDefault: string | null | undefined,
): string | null {
  if (!listsOn) return null;
  return choice !== undefined ? choice : defaultPriceTypeOf(custList, repDefault);
}

/**
 * تلميح الرقاقة حين يخالف النوعُ افتراضيَّ الفاتورة: 'rep' حين يأتي الافتراضي من المندوب (العميل بلا نوع)، و'customer' لعميلٍ
 * مختار (نوعه أو السعر الأساسي كما كان)، وإلا null
 */
export function adminListHintOf(
  type: string | null, custList: string | null | undefined, repDefault: string | null | undefined, hasCustomer: boolean,
): 'customer' | 'rep' | null {
  if (type === defaultPriceTypeOf(custList, repDefault)) return null;
  if (!custList && repDefault) return 'rep';
  return hasCustomer ? 'customer' : null;
}

// ═══════════════ «قوائم الأسعار» بقواعدها: تسعير البند بكمية صنفه في الفاتورة ═══════════════

/** الصنف كما تسعّره فاتورة الإدارة و/m: وحداته وسعر أساسه وفئته وسعره الثابت في كل قائمة (listPrices في GET /products) */
export interface DocPricedProduct extends UnitProduct {
  id: string;
  /** سعر وحدة الأساس صافياً قبل الضريبة */
  basePrice?: number | string | null;
  /** فئة الصنف — بها تنطبق قواعد الفئة */
  categoryId?: string | null;
  listPrices?: ProductListPrice[] | null;
  /** حقبة أساس الصنف — بها تُعاد أسعار العميل وسعر قاعدة الصنف المقروءان قبل تحويلٍ إلى أساسه الحالي */
  baseConvertedAt?: string | Date | null;
}

/** قاعدة كما يردّها GET /price-lists/rules: صفّ الحلّ ومعرّف قائمته، ولقاعدة الصنف أساسه كما قُرئت (إن أرسله الخادم) */
export type DocPriceRule = PriceRuleRow & { priceListId?: string | null; unit?: string | null; baseConvertedAt?: string | Date | null };

/**
 * مسعِّر البند: السعر الصافي لوحدة البند `c` بكمية صنفه في الفاتورة كلّها (بالأساس). و`dependsOnQty`: في قائمة الفاتورة قاعدةٌ سارية
 * يومها بحدٍّ أدنى للكمية؟ لا ⇒ الكمية لا تغيّر مقترحاً أبداً، فلا يُعاد تسعيرٌ ولا تلميحٌ عند تغيّرها.
 * ⚠️ ذاكرته لكل **كائن** صنف: كائنات الكتالوج (ردّ react-query) لا تُعدَّل في مكانها — صنفٌ أحدث كائنٌ جديد يُحسب من جديد.
 */
export type DocLinePricer<P extends DocPricedProduct = DocPricedProduct> = ((p: P, c: UnitChoice, totalBaseQty: number) => number) & {
  readonly dependsOnQty: boolean;
};

const NO_RULES: readonly PriceRuleRow[] = Object.freeze([]) as readonly PriceRuleRow[];

/** قواعد قائمة الفاتورة وحدها من قواعد الشركة كلّها — بلا قائمة (السعر الأساسي) أو بلا قواعد (أو ردٌّ تالف) ⇒ [] */
export function rulesOfList<R extends { priceListId?: string | null }>(rules: readonly R[] | null | undefined, listId: string | null | undefined): R[] {
  if (!listId || !Array.isArray(rules) || !rules.length) return [];
  return rules.filter(r => !!r && r.priceListId === listId);
}

/**
 * سعر قاعدة الصنف الثابت (لوحدة الأساس) قُرئ على أساسٍ غير أساس الصنف المعروض (تحويلٌ بين جلب الأصناف وجلب القواعد): يُعاد إلى
 * أساسه الحالي بقاعدة أسعار العميل نفسها (rebaseCustPrices) — وما لا يُعرف أساسه يسقط فيُكمل الحلّ بغيره، لا يُضرب في معاملٍ
 * خاطئ. صفٌّ بلا حقبة الأساس (الخادم لم يرسلها) كما هو.
 */
function rebasedRule(r: DocPriceRule, p: DocPricedProduct): DocPriceRule | null {
  if (r.kind !== 'fixed' || !Object.prototype.hasOwnProperty.call(r, 'baseConvertedAt')) return r;
  const raw = Number(r.basePrice);
  if (r.basePrice == null || !Number.isFinite(raw)) return r;
  const v = rebaseCustPrices([{ productId: p.id, price: raw, unit: r.unit ?? null, baseConvertedAt: r.baseConvertedAt ?? null }], [p])[p.id];
  if (v === undefined || !Number.isFinite(v)) return null;
  return v === raw ? r : { ...r, basePrice: v };
}

/**
 * يقع يوم الفاتورة في فترة القاعدة؟ — الشرطان نفساهما في priceRuleMatches (lib/priceRules.ts) حرفاً، فالقاعدة التي تُسقط هنا لا تنطبق
 * هناك في هذا اليوم أبداً: إسقاطها مرّةً عند بناء المسعِّر لا يغيّر ناتجاً (والقاعدة التالفة يرفضها الحلّ كما كان)
 */
export function ruleOnDay(r: PriceRuleRow, day: string): boolean {
  if (r.startsOn != null && day < r.startsOn) return false;
  if (r.endsOn != null && day > r.endsOn) return false;
  return true;
}

/**
 * فهرس قواعد القائمة بالصنف والفئة: لا يمرّ الحلّ على كل قواعد القائمة لكل صنفٍ في المنتقي (حتى ٢٠٠٠ قاعدة × ١٠٠٠ صنف).
 * `own` قواعد الصنف بعد إعادة أساسها، و`shared` قواعد فئته ثم كل الأصناف — واحدةٌ لأصناف الفئة كلّها (بترتيب الحلّ نفسه:
 * [...own, ...shared] هو ما كان يُمرَّر له)
 */
function ruleIndexOf(rules: readonly DocPriceRule[]): (p: DocPricedProduct) => { own: readonly PriceRuleRow[]; shared: readonly PriceRuleRow[] } {
  if (!rules.length) return () => ({ own: NO_RULES, shared: NO_RULES });
  const byProduct = new Map<string, DocPriceRule[]>();
  const byCategory = new Map<string, DocPriceRule[]>();
  const all: DocPriceRule[] = [];
  const push = (m: Map<string, DocPriceRule[]>, k: string, r: DocPriceRule) => { const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); };
  for (const r of rules) {
    if (!r) continue;
    if (r.scope === 'product' && r.productId) push(byProduct, String(r.productId), r);
    else if (r.scope === 'category' && r.categoryId) push(byCategory, String(r.categoryId), r);
    else if (r.scope === 'all') all.push(r);
  }
  const sharedBy = new Map<string, readonly PriceRuleRow[]>();
  return (p) => {
    const own = (byProduct.get(p.id) ?? []).map(r => rebasedRule(r, p)).filter((r): r is DocPriceRule => r !== null);
    const ck = p.categoryId ? String(p.categoryId) : '';
    let shared = sharedBy.get(ck);
    if (!shared) {
      const cat = ck ? byCategory.get(ck) ?? [] : [];
      shared = cat.length || all.length ? [...cat, ...all] : NO_RULES;
      sharedBy.set(ck, shared);
    }
    return { own: own.length ? own : NO_RULES, shared };
  };
}

/** ما يُحسب مرّةً لكل صنف في عمر المسعِّر */
interface PricedEntry {
  pp: PricedProduct;
  /** سعر العميل الخاص لوحدة الأساس (بعد إعادة الأساس) حين يصلح رقماً — يغلب القائمة كلّها */
  cust: number | null;
  rp: PriceRuleProduct;
  item: number | undefined;
  own: readonly PriceRuleRow[];
  shared: readonly PriceRuleRow[];
  /**
   * سعر الصنف الثابت في القائمة قاعدةُ صنفٍ بلا شرط (listPriceOf): ينطبق على كل كميةٍ غير سالبة، والأخصّ يغلب (الصنف قبل الفئة
   * وكل الأصناف — comparePriceRules يقارن النطاق أولاً) — فقواعد الفئة وكل الأصناف لا تغيّر ناتجه، والحلّ يُقيَّم على قواعده وحدها
   */
  itemWins: boolean;
  /** حدٌّ أدنى للكمية في قواعد الصنف أو المشتركة؟ لا ⇒ ناتجها واحدٌ لكل كميةٍ غير سالبة (كل حدٍّ صفر) */
  ownByQty: boolean;
  sharedByQty: boolean;
  /** ذاكرة ما تقوله القائمة للصنف وحده */
  memo: Map<string, ListPriceResult>;
  /** مفتاح ناتج القواعد المشتركة: فئة الصنف ومعامل رئيسيّته — كل ما يقرؤه الحلّ من الصنف حين لا قاعدة صنفٍ ولا سعر ثابت */
  group: string;
}

/** سقف كل ذاكرة (كمياتٌ كثيرة كُتبت في عمر مسعِّرٍ واحد) — تُفرَّغ عند بلوغه فلا تكبر بلا حدّ */
const MEMO_MAX = 4096;

function memoized(m: Map<string, ListPriceResult>, key: string, f: () => ListPriceResult): ListPriceResult {
  if (m.has(key)) return m.get(key) as ListPriceResult;
  const v = f();
  if (m.size >= MEMO_MAX) m.clear();
  m.set(key, v);
  return v;
}

export interface DocPricingInput {
  /** قائمة الفاتورة (null = السعر الأساسي) — adminInvoiceListOf أو listId في /m */
  listId: string | null | undefined;
  /** أسعار العميل الخاصة كما يردّها /products/customer-prices (لوحدة الأساس) */
  custRows?: CustPriceInput[] | null;
  /** قواعد القوائم كلّها (GET /price-lists/rules) — تُصفّى هنا بقائمة الفاتورة. null/غائب ⇒ لا قواعد (شركةٌ بلا قوائم، أو قبل وصولها) */
  rules?: readonly DocPriceRule[] | null;
  /** يوم الفاتورة 'YYYY-MM-DD' — docPricingDayOf (التاريخ المرسل وإلا يوم الشركة الآن) */
  day: string;
}

/**
 * يوم تسعير فاتورة الإدارة و/m (مراجعة D1): التاريخ المختار حين **يُرسل** للخادم، وإلا يوم الشركة الآن بمنطقتها (`timezone` من
 * GET /price-lists) — وبلا منطقةٍ اليوم المحلي للجهاز. `dateSent: false` لتاريخٍ لا يُرسل: الإشعار الدائن في المرحلة الثانية يُصدر
 * بلحظته على الخادم (buildFreeReturnPayload يُسقط invoiceDate) فتاريخٌ مخفيٌّ بقي من البيع لا يسعّر مرتجعه.
 */
export function docPricingDayOf(
  invoiceDate: string | null | undefined,
  opts: { dateSent?: boolean; timezone?: string | null; now?: Date } = {},
): string {
  return pricingDayOf(opts.dateSent === false ? '' : invoiceDate, opts.now ?? new Date(), opts.timezone);
}

/**
 * المسعِّر الواحد لفاتورة الإدارة و/m (انظر رأس الملف): سعر العميل الخاص ⇐ القائمة (ثابتها وقواعدها بالكمية واليوم) ⇐ سلّم اليوم،
 * صافياً — مقرَّباً لأربع منازل حين يأتي من سعر العميل أو القائمة (suggestedNetOf)، وchoiceNet كما كان حرفاً بلاهما.
 * الحساب حساب lineNetWithList حرفاً (lib/priceListPricing.ts) بتقييمٍ واحدٍ للحلّ: listPriceOf(item, قواعده, صنفه, كميته
 * بالرئيسية, اليوم) = listResultFor، ثم listLineRef من سعر البند بلا قائمة.
 */
export function docLinePricerOf({ listId, custRows, rules, day }: DocPricingInput): DocLinePricer {
  const custBy = new Map<string, CustPriceInput[]>();
  for (const r of Array.isArray(custRows) ? custRows : []) {
    if (!r || r.productId == null) continue;
    const k = String(r.productId);
    const a = custBy.get(k);
    if (a) a.push(r); else custBy.set(k, [r]);
  }
  const listRules = rulesOfList(rules, listId).filter(r => ruleOnDay(r, day));
  const rulesOf = ruleIndexOf(listRules);
  const entries = new WeakMap<object, PricedEntry>();
  const shared = new Map<string, ListPriceResult>();

  const entryOf = (p: DocPricedProduct): PricedEntry => {
    const hit = entries.get(p);
    if (hit) return hit;
    const mine = custBy.get(p.id);
    const cv = mine ? rebaseCustPrices(mine, [p])[p.id] : undefined;
    const pp: PricedProduct = { id: p.id, basePrice: p.basePrice ?? 0, categoryId: p.categoryId ?? null, primaryUnitId: p.primaryUnitId ?? null, units: p.units ?? null };
    const rp = ruleProductOf(pp);
    const item = listId ? listPriceMap([p], listId)[p.id] : undefined;
    const { own, shared: sharedRules } = rulesOf(p);
    const e: PricedEntry = {
      pp, rp, item, own, shared: sharedRules,
      cust: cv != null && Number.isFinite(Number(cv)) ? Number(cv) : null,
      // صفّ السعر الثابت في الحلّ صالحٌ (معرّف صنفٍ وسعرٌ غير سالب) فينطبق بحدٍّ صفر
      itemWins: item !== undefined && Number.isFinite(item) && item >= 0 && !!p.id,
      ownByQty: listDependsOnQty(own),
      sharedByQty: listDependsOnQty(sharedRules),
      memo: new Map(),
      group: `${typeof rp.categoryId}:${String(rp.categoryId)}|${String(rp.primaryFactor)}|`,
    };
    entries.set(p, e);
    return e;
  };

  /**
   * ما تقوله القائمة للصنف بكميته — listResultFor حرفاً (listPriceOf(item, [...own, ...shared], صنفه, كميته بالرئيسية, اليوم))،
   * مقسوماً كما يقسمه الحلّ نفسه: الأخصّ يغلب، فما انطبق من قواعد الصنف (وسعره الثابت) هو الناتج، وإلا ما تقوله قواعد الفئة وكل
   * الأصناف — وهذه لا تقرأ من الصنف إلا فئته ورئيسيّته فناتجها مشتركٌ بين أصناف الفئة. وكلٌّ محفوظٌ بالكمية بالرئيسية، أو بلا كمية
   * حين لا حدّ أدنى (كل قاعدةٍ صالحة تنطبق على كل كميةٍ غير سالبة). كميةٌ سالبة أو صنفٌ بلا قواعد: الحلّ بقواعده كلّها كما كان.
   */
  const listOf = (e: PricedEntry, totalBaseQty: number): ListPriceResult => {
    const qp = qtyPrimaryOf(totalBaseQty, e.rp);
    const noRules = !e.own.length && !e.shared.length;
    if (noRules || !(qp >= 0)) {
      return memoized(e.memo, noRules ? 'f*' : `f${String(qp)}`, () => listPriceOf(e.item, [...e.own, ...e.shared], e.rp, qp, day));
    }
    const at = (byQty: boolean) => (byQty ? String(qp) : '*');
    if (e.itemWins) return memoized(e.memo, `i${at(e.ownByQty)}`, () => listPriceOf(e.item, e.own, e.rp, qp, day));
    if (e.own.length) {
      const mine = memoized(e.memo, `o${at(e.ownByQty)}`, () => listPriceOf(undefined, e.own, e.rp, qp, day));
      if (mine !== null) return mine;
    }
    return memoized(shared, e.group + at(e.sharedByQty), () => listPriceOf(undefined, e.shared, e.rp, qp, day));
  };

  const price = (p: DocPricedProduct, c: UnitChoice, totalBaseQty: number): number => {
    const e = entryOf(p);
    if (e.cust !== null) return roundHalfUp(choiceNet(c, e.pp.basePrice, e.cust), 4);
    const noList = choiceNet(c, e.pp.basePrice, null);
    const lp = listOf(e, totalBaseQty);
    return lp === null ? noList : roundHalfUp(listLineRef(lp, c.factor, noList) ?? noList, 4);
  };
  return Object.assign(price, { dependsOnQty: listDependsOnQty(listRules) });
}

/** مفتاح كميات أصناف الفاتورة بالأساس — يتغيّر بتغيّر كمية أي صنف (لذاكرة تلميحات المنتقي حين تتغيّر الأسعار بالكمية) */
export function docQtyKey(lines: ReadonlyArray<{ productId: string; qty: number; unitFactor?: number | null }>): string {
  return [...docBaseQty(lines)].map(([id, q]) => `${id}:${q}`).join('|');
}

/**
 * خيارات منتقي الأصناف بكميات الفاتورة (مراجعة D5): `base` الكتالوج كلّه مسعَّراً **مرّةً لكل مسعِّر** بكمية الصنف بعد إضافته إلى
 * فاتورةٍ ليس فيها، ثم أصناف الفاتورة وحدها تُعاد بكمياتها (`at`) — لا الكتالوج كلّه مع كل حرفٍ في خانة الكمية. ومسعِّرٌ لا تغيّره
 * الكمية (`dependsOnQty` false) أو فاتورةٌ فارغة ⇒ `base` نفسها. الناتج ما كان يُحسب لكل صنفٍ بكميته حرفاً.
 */
export function pickOptionsAtQty<O extends { value: string }>(
  base: O[],
  lines: ReadonlyArray<{ productId: string; qty: number; unitFactor?: number | null }>,
  dependsOnQty: boolean,
  at: (o: O, qtyInDoc: number) => O,
): O[] {
  if (!dependsOnQty || !lines.length) return base;
  const qty = docBaseQty(lines);
  if (!qty.size) return base;
  return base.map(o => {
    const q = qty.get(o.value);
    return q ? at(o, q) : o;
  });
}

/** كمية كل صنفٍ بالأساس في بنود المحرّر (البنود المرتبطة بفاتورة بيعٍ في جدولها وحدها فلا تدخل) */
export function docBaseQty(lines: ReadonlyArray<{ productId: string; qty: number; unitFactor?: number | null }>): Map<string, number> {
  return baseQtyByProduct(lines.map(l => ({ productId: l.productId, qty: l.qty, factor: l.unitFactor ?? 1 })));
}

/**
 * إعادة تسعير البنود التي لم يمسّها المستخدم (`unitPrice` ما زال `refPrice`) بالمسعِّر الحالي وكمية صنفها في الفاتورة كلّها —
 * repriceUntouched حرفاً: المعدَّل يدويّاً يبقى بسعره ويتبع مرجعه وحده، وصنفٌ لا يُعرف أو وحدةٌ لم تعد قائمة كما هو، ولا تغيّر ⇒
 * المصفوفة نفسها. تُستدعى عند تغيّر القائمة أو العميل أو القواعد أو اليوم، وعند كل تغيّرٍ في كمية صنف (إضافة، كمية، وحدة، حذف).
 * و`onlyProductId` (مراجعة D5): تغيّرت كمية صنفٍ واحد ⇒ بنوده وحدها تُعاد — كمية غيره لم تتغيّر فمقترحه كما هو (ومسعِّرٌ جديد
 * يعيد البنود كلّها بلا هذا القيد)، فلا تُعاد فاتورةٌ من مئتي بند مع كل حرفٍ في خانة كمية.
 */
export function repriceDocLines<
  L extends { productId: string; unitId?: string | null; qty: number; unitFactor?: number | null; unitPrice: number; refPrice: number },
  P extends UnitProduct,
>(
  lines: L[],
  productOf: (productId: string) => P | null | undefined,
  priceOf: (p: P, c: UnitChoice, totalBaseQty: number) => number,
  withPrice: (l: L, price: number) => L,
  onlyProductId?: string | null,
): L[] {
  if (!lines.length) return lines;
  const only = onlyProductId ?? null;
  if (only !== null && !lines.some(l => l.productId === only)) return lines;
  const qty = docBaseQty(lines);
  return repriceUntouched(lines, (l) => {
    if (only !== null && l.productId !== only) return null;
    const p = productOf(l.productId);
    const c = p ? choiceById(p, l.unitId ?? null) : null;
    return p && c ? priceOf(p, c, qty.get(l.productId) ?? 0) : null;
  }, withPrice);
}
