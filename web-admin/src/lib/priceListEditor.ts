/**
 * «قوائم الأسعار» بقواعدها (طلب المالك ٥ نوفمبر ٢٠٢٦) — منطق محرّر القائمة الصرف (لوحة «الأسعار والقواعد»): بلا React ولا شبكة،
 * يُختبر وحده (priceListEditor.test.ts).
 *
 *   • صفّ القائمة: «{n} صنف · {m} قاعدة · {k} عميل».
 *   • تبويب «أسعار الأصناف»: سعر الصنف الثابت في القائمة صافياً **بالوحدة الرئيسية** (الأساس بلاها) كما يردّه
 *     GET /price-lists/:id/items، والحفظ سطراً سطراً (PUT /price-lists/:id/items) ومعه أساس الصنف ورئيسيّته كما عُرضا (حارس 409).
 *     الخانة الفارغة تحذف سعر الصنف من القائمة، والمعاد كما كان لا يُرسل.
 *   • تبويب «القواعد»: نموذجٌ بنوعٍ ثلاثيّ (سعر ثابت / خصم بنسبة / زيادة بنسبة) والمستخدم يكتب النسبة موجبةً دائماً — الزيادة
 *     تُخزَّن نسبةً سالبة (نموذج lib/priceRules.ts). والتحقّق الأخير priceRuleProblem نفسه الذي يحكم به الخادم.
 *   • ملخّص القاعدة بلغة المالك: «خصم 10% على فئة العصائر · من 10 كرتون · 1–30 نوفمبر».
 */
import type { QueryClient } from '@tanstack/react-query';
import type { PriceList, PriceListItemRow, PriceListItemWrite, PriceListRule, PriceRuleInput } from '../types';
import { roundHalfUp } from './money';
import { listPriceInput, listShownPrice } from './priceLists';
import { PRICE_RULE_LIMITS, PRICE_RULE_MESSAGES, isPriceRuleDay, priceRuleProblem, type PriceRuleScope } from './priceRules';

type Tr = (s: string) => string;
type Fmt = (n: number) => string;

/** يملأ {key} في نصٍّ مترجم بقيمه — القيم (أسماء الأصناف والفئات) لا يُعاد فحصها */
export function fillText(s: string, vals: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vals, k) ? String(vals[k]) : m));
}

// ═══ صفّ القائمة في اللوحة ═══

/** «{n} صنف · {m} قاعدة · {k} عميل» — وخادمٌ لا يردّ عدّاً منها لا يُكتب جزؤه (يبقى عدد العملاء كما كان) */
export function priceListCountsText(
  l: Pick<PriceList, 'itemsCount' | 'rulesCount' | 'customersCount'>, tr: Tr, fmt: Fmt = String,
): string {
  const parts: string[] = [];
  if (l.itemsCount != null) parts.push(fillText(tr('{n} صنف'), { n: fmt(Number(l.itemsCount) || 0) }));
  if (l.rulesCount != null) parts.push(fillText(tr('{n} قاعدة'), { n: fmt(Number(l.rulesCount) || 0) }));
  parts.push(fillText(tr('{n} عميل'), { n: fmt(Number(l.customersCount) || 0) }));
  return parts.join(' · ');
}

// ═══ تبويب «أسعار الأصناف» ═══

/** حجم صفحة الجدول (الخادم يقبل حتى ٢٠٠) */
export const PRICE_LIST_ITEMS_PAGE = 50;
export type ItemsScope = 'priced' | 'all';

export interface ItemsPage {
  rows: PriceListItemRow[];
  pagination: { total: number; page: number; limit: number; pages: number };
  pricedCount: number;
}

const finiteOr = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** ردّ GET /price-lists/:id/items مطبَّعاً — صفٌّ بلا معرّف يُسقط، وردٌّ تالف ⇒ صفحةٌ فارغة */
export function itemsPageOf(data: unknown): ItemsPage {
  const d = (data ?? {}) as { rows?: unknown; pagination?: Record<string, unknown>; pricedCount?: unknown };
  const rows = (Array.isArray(d.rows) ? d.rows : [])
    .filter((r): r is PriceListItemRow => !!r && typeof (r as PriceListItemRow).productId === 'string')
    .map((r) => ({
      ...r,
      listPrice: r.listPrice == null || !Number.isFinite(Number(r.listPrice)) ? null : Number(r.listPrice),
      defaultPrice: finiteOr(r.defaultPrice, 0),
    }));
  const p = d.pagination ?? {};
  const limit = Math.max(1, finiteOr(p.limit, PRICE_LIST_ITEMS_PAGE));
  const total = Math.max(0, finiteOr(p.total, rows.length));
  return {
    rows,
    pagination: { total, page: Math.max(1, finiteOr(p.page, 1)), limit, pages: Math.max(1, finiteOr(p.pages, Math.ceil(total / limit) || 1)) },
    pricedCount: Math.max(0, finiteOr(d.pricedCount, 0)),
  };
}

/** سعر الصنف في القائمة كما تعرضه خانته: أربع منازل، و'' لصنفٍ ليس في القائمة */
export function itemShownPrice(listPrice: number | null | undefined): string {
  if (listPrice == null || !Number.isFinite(Number(listPrice))) return '';
  return String(roundHalfUp(Number(listPrice), 4));
}

/** ما يفعله الخروج من خانة السطر: لا شيء (كما كان)، أو رسالة (بـtr)، أو كتابةٌ لسطرٍ واحد */
export type ItemCommit =
  | { kind: 'same' }
  | { kind: 'invalid'; problem: string }
  | { kind: 'write'; write: PriceListItemWrite };

/**
 * الحفظ التلقائي لسطر: المكتوب مقابل المحفوظ. الفارغ يحذف (price null) والمعاد كما كان (ولو «100.0» مكان «100») لا يُرسل.
 * والكتابة بأساس الصنف ورئيسيّته كما عرضهما الصفّ — فتحويلٌ أو تبديل رئيسيةٍ بعد التحميل يُردّ 409 لا سعر كرتونٍ يُقرأ سعرَ حبّة
 */
export function itemCommitOf(
  row: Pick<PriceListItemRow, 'productId' | 'unit' | 'primaryUnit' | 'listPrice'>, raw: string | null | undefined,
): ItemCommit {
  const text = String(raw ?? '').trim();
  const shown = itemShownPrice(row.listPrice);
  if (text === shown) return { kind: 'same' };
  const v = listPriceInput(text);
  if (v === null) {
    return row.listPrice == null ? { kind: 'same' } : { kind: 'write', write: itemWriteOf(row, null) };
  }
  if (Number.isNaN(v) || v < 0) return { kind: 'invalid', problem: PRICE_RULE_MESSAGES.price };
  if (shown !== '' && Math.abs(v - Number(shown)) < 1e-9) return { kind: 'same' };
  return { kind: 'write', write: itemWriteOf(row, v) };
}

function itemWriteOf(row: Pick<PriceListItemRow, 'productId' | 'unit' | 'primaryUnit'>, price: number | null): PriceListItemWrite {
  return {
    productId: row.productId,
    price,
    expectedBaseName: row.unit,
    expectedPrimary: row.primaryUnit ? { id: row.primaryUnit.id, factor: Number(row.primaryUnit.factor) } : null,
  };
}

/** صفوف ردّ الحفظ ({productId, listPrice}) — وردٌّ بلاها ⇒ ما أُرسل نفسه (مقرَّباً لأربع منازل كما يعرضه الخادم) */
export function savedItemsOf(data: unknown, sent: readonly PriceListItemWrite[]): Array<{ productId: string; listPrice: number | null }> {
  const rows = (data as { rows?: unknown } | null | undefined)?.rows;
  if (Array.isArray(rows)) {
    const out = rows
      .filter((r): r is { productId: string; listPrice: unknown } => !!r && typeof (r as { productId?: unknown }).productId === 'string')
      .map((r) => ({ productId: r.productId, listPrice: r.listPrice == null || !Number.isFinite(Number(r.listPrice)) ? null : Number(r.listPrice) }));
    if (out.length) return out;
  }
  return sent.map((w) => ({ productId: w.productId, listPrice: w.price == null ? null : roundHalfUp(w.price, 4) }));
}

/**
 * رموز ٤٠٩ «وحدات الصنف تغيّرت منذ عُرض» (حارس الأساس والرئيسية) — في سطر الجدول أو في نموذج القاعدة. والمكتوب حينها كُتب
 * بالوحدات القديمة: يُسقط ولا يُعاد إرساله بالوحدات الجديدة أبداً (قرار D6)
 */
export const UNITS_CHANGED_CODES: ReadonlySet<string> = new Set(['BASE_UNIT_CHANGED', 'PRIMARY_UNIT_CHANGED', 'PRODUCT_UNITS_CHANGED']);
export const isUnitsChangedCode = (code: string | null | undefined): boolean => !!code && UNITS_CHANGED_CODES.has(code);

/**
 * هل غيّر الحفظ «المسعّرة في القائمة» (صنفٌ دخلها أو خرج منها)؟ — حينها تُعاد الصفحات المعروضة من الخادم، فصفحة «المسعّرة»
 * المخبّأة لا تبقى بلا الصنف المضاف من «كل الأصناف» (الترقيع لا يُدخل صفّاً ليس فيها). صنفٌ لا يُعرف ما كان ⇒ نعم
 */
export function pricedChangedOf(
  saved: ReadonlyArray<{ productId: string; listPrice: number | null }>, before: (productId: string) => number | null | undefined,
): boolean {
  return saved.some((s) => {
    const prev = before(s.productId);
    return prev === undefined || (prev === null) !== (s.listPrice === null);
  });
}

/** سطرٌ فشل حفظه — في قائمة الأخطاء الثابتة أعلى التبويب باسم صنفه (يبقى ظاهراً ولو غاب السطر عن الصفحة) */
export interface FailedItemRow { productId: string; name: string; message: string }

/** أخطاء الأسطر بترتيب وقوعها، وصنفٌ لا يُعرف اسمه يُسمّى بكوده أو معرّفه */
export function failedItemRowsOf(
  status: Readonly<Record<string, { state: string; message?: string }>>,
  rowOf: (productId: string) => Pick<PriceListItemRow, 'name' | 'code'> | undefined,
): FailedItemRow[] {
  const out: FailedItemRow[] = [];
  for (const [productId, s] of Object.entries(status)) {
    if (s.state !== 'error') continue;
    const r = rowOf(productId);
    out.push({ productId, name: r?.name || r?.code || productId, message: s.message ?? '' });
  }
  return out;
}

/** الصفحة المخبّأة بعد الحفظ: سعر السطر الجديد (والصفّ نفسه بلا إعادة جلب) — لا تغيّر ⇒ الصفحة نفسها */
export function patchItemsPage(page: ItemsPage, saved: ReadonlyArray<{ productId: string; listPrice: number | null }>): ItemsPage {
  const by = new Map(saved.map((s) => [s.productId, s.listPrice]));
  let changed = false;
  let priced = page.pricedCount;
  const rows = page.rows.map((r) => {
    if (!by.has(r.productId)) return r;
    const next = by.get(r.productId) ?? null;
    if (next === r.listPrice) return r;
    changed = true;
    if (r.listPrice == null && next != null) priced += 1;
    if (r.listPrice != null && next == null) priced -= 1;
    return { ...r, listPrice: next };
  });
  return changed ? { ...page, rows, pricedCount: Math.max(0, priced) } : page;
}

/**
 * إعادة جلب صفحات القائمة بعد الحفظ: صنفٌ دخل «المسعّرة» أو خرج منها، أو جلبٌ لصفحاتها جارٍ لحظة الردّ (قد قرأ قبل التزام الحفظ)
 * ⇒ 'active' (المعروضة تُعاد من الخادم)؛ وإلا 'none' — الترقيع يكفي، وغير المعروضة تُعاد عند فتحها (لا طلبٌ زائد لتعديل سعر)
 */
export function itemsRefetchTypeOf(pricedChanged: boolean, inFlight: boolean): 'active' | 'none' {
  return pricedChanged || inFlight ? 'active' : 'none';
}

/** ما يحتاجه ترقيع الكاش بعد الحفظ من QueryClient (عميلٌ حقيقيّ في الاختبار بلا React) */
export type ItemsCacheClient = Pick<QueryClient, 'isFetching' | 'cancelQueries' | 'setQueriesData' | 'invalidateQueries'>;

/**
 * كاش صفحات القائمة بعد حفظ سطرٍ منها (afterWrite في تبويب «أسعار الأصناف») — ويردّ نوع إعادة الجلب:
 *   ١. جلبٌ لصفحاتها جارٍ الآن (معروضةً أو لا، ببياناتٍ أو أول تحميل) قد قرأ قبل أن يُلتزم الحفظ: يُلغى ويعود حاله إلى ما قبله.
 *      وإلا هبط بالسعر القديم فوق الترقيع ومسح علامة «قديم» — فتعرض الخانة ٧ و«تم الحفظ» والخادم ٨، ويُسقَط إعادة كتابة ٧ «كما
 *      كان». والإلغاء قبل الترقيع لأنه يعيد الحال إلى ما قبل الجلب (ترقيعٌ قبله يضيع)؛ ولا يكفي refetch وحده: جلبٌ بلا بيانات بعد
 *      (صفحةٌ أو بحثٌ يُفتح أول مرة) ينضمّ إليه ولا يلغيه، وغير المعروض لا يُعاد.
 *   ٢. ترقيع الصفحات المخبّأة بسعر الردّ.
 *   ٣. كلها «قديمة»، والمعروضة تُعاد من الخادم حين تغيّرت «المسعّرة» أو أُلغي جلبٌ لها (itemsRefetchTypeOf).
 * وتعديل سعرٍ بلا جلبٍ جارٍ: ترقيعٌ وعلامةٌ بلا أيّ طلب — كما كان.
 */
export function syncItemsCacheAfterSave(
  qc: ItemsCacheClient, listId: string, saved: ReadonlyArray<{ productId: string; listPrice: number | null }>, pricedChanged: boolean,
): 'active' | 'none' {
  const queryKey = ['price-list-items', listId];
  const inFlight = qc.isFetching({ queryKey }) > 0;
  if (inFlight) void qc.cancelQueries({ queryKey, fetchStatus: 'fetching' });
  qc.setQueriesData<ItemsPage>({ queryKey }, (old) => (old ? patchItemsPage(old, saved) : old));
  const refetchType = itemsRefetchTypeOf(pricedChanged, inFlight);
  void qc.invalidateQueries({ queryKey, refetchType });
  return refetchType;
}

/**
 * الصفحة حين تصل بياناتها الحقيقية: الخادم لا يقصّ رقم الصفحة، فحذف آخر صنفٍ في الصفحة الأخيرة من «المسعّرة» (أو حذفٌ من مكانٍ
 * آخر) يردّها فارغةً بصفحاتٍ أقلّ — فتُنقل إلى آخر صفحةٍ موجودة (١ على الأقل)، وما دونها كما هو
 */
export function itemsPageClampOf(page: number, pages: number): number {
  const last = Math.max(1, Math.floor(Number(pages)) || 1);
  return page > last ? last : page;
}

/** شريط الصفحات: لأكثر من صفحة، أو لصفحةٍ بعد الأولى (فلا تبقى صفحةٌ فارغة بلا طريقٍ للرجوع) */
export const itemsPagerShown = (page: number, pages: number): boolean => page > 1 || pages > 1;

// ═══ تبويب «القواعد» ═══

/** نوع السعر في النموذج: الزيادة نسبةٌ سالبة في التخزين ويكتبها المستخدم موجبة */
export type RuleFormKind = 'fixed' | 'discount' | 'markup';

/** الصنف المختار في نموذج القاعدة: أساسه ورئيسيّته كما عُرضا (حارس السعر الثابت) */
export interface RuleProductRef {
  id: string;
  name: string;
  code?: string | null;
  unit: string;
  primaryUnit: { id: string; name: string; factor: number } | null;
}

/** مسودّة النموذج: خانات نصّية كما كُتبت */
export interface RuleDraft {
  scope: PriceRuleScope;
  productId: string;
  categoryId: string;
  kind: RuleFormKind;
  value: string;
  minQty: string;
  startsOn: string;
  endsOn: string;
}

export function emptyRuleDraft(scope: PriceRuleScope = 'product'): RuleDraft {
  return { scope, productId: '', categoryId: '', kind: 'discount', value: '', minQty: '', startsOn: '', endsOn: '' };
}

/** نوع النموذج من القاعدة المحفوظة: النسبة السالبة زيادة */
export function ruleFormKindOf(rule: Pick<PriceListRule, 'kind' | 'percent'>): RuleFormKind {
  if (rule.kind === 'fixed') return 'fixed';
  return Number(rule.percent) < 0 ? 'markup' : 'discount';
}

/** النسبة كما تُعرض/تُكتب: موجبةٌ بلا غبار الفاصلة */
export function percentShown(percent: number | null | undefined): string {
  const p = Number(percent);
  if (percent == null || !Number.isFinite(p)) return '';
  return String(roundHalfUp(Math.abs(p), 4));
}

/** السعر الثابت كما يُعرض: للصنف سعر الأساس × معامل رئيسيّته (أربع منازل)، وللفئة سعر الرئيسية كما كُتب */
export function ruleFixedShown(
  rule: Pick<PriceListRule, 'scope' | 'basePrice' | 'primaryPrice'>, primaryFactor: number | null | undefined,
): string {
  if (rule.scope === 'product') return listShownPrice(rule.basePrice, Number(primaryFactor) > 0 ? Number(primaryFactor) : 1);
  const v = Number(rule.primaryPrice);
  return rule.primaryPrice == null || !Number.isFinite(v) ? '' : String(roundHalfUp(v, 4));
}

/**
 * مسودّة تعديل قاعدة محفوظة. `primaryFactor` معامل رئيسية الصنف الذي يُعرض به سعره الثابت (من الصنف كما يراه النموذج)،
 * و`undefined` ⇒ من صفّ القاعدة نفسه
 */
export function ruleDraftOf(rule: PriceListRule, primaryFactor?: number | null): RuleDraft {
  const kind = ruleFormKindOf(rule);
  const minQ = Number(rule.minQty);
  return {
    scope: rule.scope,
    productId: rule.productId ?? '',
    categoryId: rule.categoryId ?? '',
    kind,
    value: kind === 'fixed'
      ? ruleFixedShown(rule, primaryFactor === undefined ? rule.primaryUnit?.factor ?? 1 : primaryFactor)
      : percentShown(rule.percent),
    minQty: Number.isFinite(minQ) && minQ > 0 ? String(roundHalfUp(minQ, 4)) : '',
    startsOn: rule.startsOn ?? '',
    endsOn: rule.endsOn ?? '',
  };
}

/**
 * تعديل مسودّة القاعدة بنقرة نطاقٍ أو نوع (قرار D6): الرقم المكتوب يُمسح حين يتغيّر معناه — نوعٌ يعبر بين السعر الثابت والنسبة،
 * أو نطاقٌ يتغيّر والسعر ثابت (سعر كرتون صنفٍ ليس سعر الوحدة الرئيسية لكل صنفٍ في الفئة)، و«كل الأصناف» تقلب الثابت خصماً. وبين
 * الخصم والزيادة يبقى (نسبةٌ موجبة في الحالين). فلا يُحفظ سعرٌ نسبةً ولا العكس
 */
export function ruleDraftPatch(draft: RuleDraft, patch: Partial<RuleDraft>): RuleDraft {
  const next: RuleDraft = { ...draft, ...patch };
  if (next.scope === 'all' && next.kind === 'fixed') next.kind = 'discount';
  if (!('value' in patch)) {
    const kindCrossed = (draft.kind === 'fixed') !== (next.kind === 'fixed');
    const scopeMoved = next.scope !== draft.scope && (draft.kind === 'fixed' || next.kind === 'fixed');
    if (kindCrossed || scopeMoved) next.value = '';
  }
  return next;
}

/**
 * في النموذج ما لم يُحفظ؟ — للتعديل: أيّ خانةٍ تغيّرت عمّا فُتح به. وللجديد: خانةٌ فيها شيء (اختيار النطاق والنوع وحده ليس عملاً
 * يضيع). يحكم سؤال «أتتركه بلا حفظ؟» عند الرجوع وتبديل التبويب وإغلاق النافذة
 */
export function ruleDraftDirty(draft: RuleDraft, initial: RuleDraft, isNew: boolean): boolean {
  const key = (d: RuleDraft) => [d.scope, d.productId, d.categoryId, d.kind, d.value.trim(), d.minQty.trim(), d.startsOn, d.endsOn].join('\u0001');
  if (key(draft) === key(initial)) return false;
  if (!isNew) return true;
  return !!(draft.productId || draft.categoryId || draft.value.trim() || draft.minQty.trim() || draft.startsOn || draft.endsOn);
}

/** سؤال ترك نموذج قاعدةٍ لم يُحفظ (رجوع، تبديل التبويب، إغلاق النافذة، فتح قاعدةٍ أخرى) — مفتاحٌ في القاموس */
export const RULE_FORM_DISCARD_ASK = 'في نموذج القاعدة ما لم يحفظ بعد — أتتركه بلا حفظ؟';

/** رسائل النسبة كما يكتبها المستخدم موجبةً (الحدود من PRICE_RULE_LIMITS) */
export const RULE_FORM_MESSAGES = {
  discount: 'نسبة الخصم أكبر من صفر وحتى 100',
  markup: 'نسبة الزيادة أكبر من صفر وحتى 500',
} as const;

export type RuleInputResult = { input: PriceRuleInput; problem: null } | { input: null; problem: string };

/**
 * جسم POST/PUT القاعدة من المسودّة، أو رسالة (بـtr). النسبة تُكتب موجبةً وتُخزَّن سالبةً للزيادة؛ والفارغ من الحدّ الأدنى صفر
 * (بلا حدّ) ومن التاريخين null (مفتوح). والسعر الثابت لصنفٍ بأساسه ورئيسيّته كما عُرضا (`product`)
 */
export function ruleInputOf(draft: RuleDraft, product: RuleProductRef | null | undefined): RuleInputResult {
  const scope = draft.scope;
  const kind = draft.kind === 'fixed' ? 'fixed' : 'percent';
  const v = listPriceInput(draft.value);
  let percent: number | null = null;
  let price: number | null = null;
  if (kind === 'percent') {
    const max = draft.kind === 'markup' ? -PRICE_RULE_LIMITS.percentMin : PRICE_RULE_LIMITS.percentMax;
    if (v === null || Number.isNaN(v) || v <= 0 || v > max) {
      return { input: null, problem: draft.kind === 'markup' ? RULE_FORM_MESSAGES.markup : RULE_FORM_MESSAGES.discount };
    }
    percent = draft.kind === 'markup' ? -v : v;
  } else {
    price = v;
  }
  const q = listPriceInput(draft.minQty);
  const body = {
    scope,
    productId: scope === 'product' ? draft.productId.trim() || null : null,
    categoryId: scope === 'category' ? draft.categoryId.trim() || null : null,
    kind,
    price,
    percent,
    minQty: q === null ? 0 : q,
    startsOn: draft.startsOn.trim() || null,
    endsOn: draft.endsOn.trim() || null,
  } as const;
  const problem = priceRuleProblem(body);
  if (problem) return { input: null, problem };
  const input: PriceRuleInput = { ...body, price: kind === 'fixed' ? price : null, percent: kind === 'percent' ? percent : null };
  if (scope === 'product' && kind === 'fixed') {
    if (!product || product.id !== input.productId || !product.unit) return { input: null, problem: PRICE_RULE_MESSAGES.product };
    input.expectedBaseName = product.unit;
    input.expectedPrimary = product.primaryUnit ? { id: product.primaryUnit.id, factor: Number(product.primaryUnit.factor) } : null;
  }
  return { input, problem: null };
}

/** ردّ GET /price-lists/:id/rules مطبَّعاً: صفوفٌ بمعرّف ونطاقٍ ونوعٍ معروفين بترتيب الخادم — وردٌّ تالف ⇒ لا قواعد */
export function priceRulesOf(data: unknown): PriceListRule[] {
  return (Array.isArray(data) ? data : []).filter((r): r is PriceListRule => !!r && typeof (r as PriceListRule).id === 'string'
    && ['product', 'category', 'all'].includes((r as PriceListRule).scope) && ['fixed', 'percent'].includes((r as PriceListRule).kind));
}

/** حالة القاعدة اليوم: سارية، أو انتهت، أو لم تبدأ بعد */
export function ruleTimingOf(rule: Pick<PriceListRule, 'startsOn' | 'endsOn'>, today: string): 'active' | 'expired' | 'upcoming' {
  if (rule.endsOn && isPriceRuleDay(rule.endsOn) && today > rule.endsOn) return 'expired';
  if (rule.startsOn && isPriceRuleDay(rule.startsOn) && today < rule.startsOn) return 'upcoming';
  return 'active';
}

const dayDate = (s: string): Date => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));

/**
 * فترة القاعدة بلغة الواجهة: «1–30 نوفمبر»، و«ابتداء من …» أو «حتى …» لطرفٍ واحد، وnull بلا فترة. السنة تُكتب حين
 * يقع طرفٌ في غير السنة الحالية
 */
export function ruleDatesText(
  startsOn: string | null | undefined, endsOn: string | null | undefined, tr: Tr, locale = 'ar-SA-u-nu-latn', now: Date = new Date(),
): string | null {
  const s = isPriceRuleDay(startsOn) ? startsOn : null;
  const e = isPriceRuleDay(endsOn) ? endsOn : null;
  if (!s && !e) return null;
  const year = now.getFullYear();
  const needYear = [s, e].some((x) => x !== null && Number(x.slice(0, 4)) !== year);
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(needYear && { year: 'numeric' }) });
  } catch {
    fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', ...(needYear && { year: 'numeric' }) });
  }
  if (s && e) {
    if (s === e) return fmt.format(dayDate(s));
    const ranged = fmt as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string };
    return typeof ranged.formatRange === 'function'
      ? ranged.formatRange(dayDate(s), dayDate(e))
      : `${fmt.format(dayDate(s))} – ${fmt.format(dayDate(e))}`;
  }
  if (s) return fillText(tr('ابتداء من {date}'), { date: fmt.format(dayDate(s)) });
  return fillText(tr('حتى {date}'), { date: fmt.format(dayDate(e as string)) });
}

/** ما يحتاجه الملخّص من صفّ القاعدة (GET /price-lists/:id/rules بحقول العرض) */
export type RuleSummaryInput = Pick<PriceListRule, 'scope' | 'kind' | 'basePrice' | 'primaryPrice' | 'percent' | 'minQty' | 'startsOn' | 'endsOn'>
  & Partial<Pick<PriceListRule, 'productName' | 'productCode' | 'categoryName' | 'primaryUnit' | 'unit'>>;

/**
 * ملخّص القاعدة بلغة المالك: «خصم 10% على فئة العصائر · من 10 كرتون · 1–30 نوفمبر». الأسماء بيانات الشركة لا tr،
 * والكمية بالوحدة الرئيسية للصنف (اسمها للصنف الواحد، و«بالوحدة الرئيسية» للفئة وكل الأصناف)
 */
export function ruleSummaryText(
  rule: RuleSummaryInput, tr: Tr, opts: { fmtNum?: Fmt; locale?: string; now?: Date } = {},
): string {
  const fmtNum = opts.fmtNum ?? ((n: number) => String(n));
  const unitName = rule.scope === 'product' ? (rule.primaryUnit?.name || rule.unit || null) : null;
  let value: string;
  if (rule.kind === 'percent') {
    const p = Number(rule.percent) || 0;
    value = fillText(tr(p < 0 ? 'زيادة {pct}%' : 'خصم {pct}%'), { pct: fmtNum(roundHalfUp(Math.abs(p), 4)) });
  } else {
    const shown = ruleFixedShown(rule, rule.primaryUnit?.factor ?? 1);
    const price = fmtNum(Number(shown || 0));
    value = rule.scope === 'product'
      ? (unitName ? fillText(tr('سعر ثابت {price} لكل {unit}'), { price, unit: unitName }) : fillText(tr('سعر ثابت {price}'), { price }))
      : fillText(tr('سعر ثابت {price} لكل وحدة رئيسية'), { price });
  }
  const target = rule.scope === 'product'
    ? fillText(tr('على الصنف {name}'), { name: rule.productName || rule.productCode || '—' })
    : rule.scope === 'category'
      ? fillText(tr('على فئة {name}'), { name: rule.categoryName || '—' })
      : tr('على كل الأصناف');
  const parts = [`${value} ${target}`];
  const q = Number(rule.minQty);
  if (Number.isFinite(q) && q > 0) {
    const qty = fmtNum(roundHalfUp(q, 4));
    parts.push(unitName ? fillText(tr('من {qty} {unit}'), { qty, unit: unitName }) : fillText(tr('من {qty} بالوحدة الرئيسية'), { qty }));
  }
  const dates = ruleDatesText(rule.startsOn, rule.endsOn, tr, opts.locale, opts.now);
  if (dates) parts.push(dates);
  return parts.join(' · ');
}

// ═══ تغيير الوحدة الرئيسية لصنفٍ تشمله قواعد بالوحدة الرئيسية (قرار D2) ═══
/*
 * سعر الفئة الثابت والحدّ الأدنى للكمية مكتوبان بالوحدة الرئيسية لكل صنف — فتغيير حجمها (تبديل الرئيسية، إضافة وحدةٍ رئيسية،
 * تعديل معاملها أو إيقافها أو حذفها، رقعة الرئيسية في حفظ الصنف، و«إضافة وحدة فرعية أصغر» بلا إبقاء الحالية رئيسية) يغيّر
 * معناهما. فيردّ الخادم 409 PRICE_RULES_UNIT_ACK لصنفٍ تشمله قاعدةٌ كهذه، وتسأل نافذة الصنف و/m بنصّه ثم تعيد الطلب نفسه
 * بـacknowledgePriceRules: true. وصنفٌ لا تشمله قاعدة (وكل شركةٍ بلا قوائم) لا يصله سؤالٌ ولا طلبٌ زائد.
 */
export const PRICE_RULES_UNIT_ACK_CODE = 'PRICE_RULES_UNIT_ACK';
/** نصّ الخادم نفسه (مفتاحٌ في القاموس) — وردٌّ بلا رسالة يُسأل به */
export const PRICE_RULES_UNIT_ACK_MESSAGE =
  'هذا الصنف تشمله قواعد في قوائم الأسعار محسوبة بوحدته الرئيسية (سعر فئة أو حد أدنى للكمية) وتغيير الوحدة الرئيسية يغير معناها — أكد للمتابعة';

/** 409 PRICE_RULES_UNIT_ACK ⇒ نصّه (أو الثابت) وعدد القواعد إن ورد، وغيره null */
export function priceRulesAckOf(err: unknown): { message: string; rulesCount: number | null } | null {
  const d = (err as { response?: { status?: number; data?: { code?: unknown; message?: unknown; rulesCount?: unknown } } } | null)?.response?.data;
  if (!d || d.code !== PRICE_RULES_UNIT_ACK_CODE) return null;
  const n = Number(d.rulesCount);
  return {
    message: typeof d.message === 'string' && d.message.trim() ? d.message : PRICE_RULES_UNIT_ACK_MESSAGE,
    rulesCount: d.rulesCount != null && Number.isFinite(n) ? n : null,
  };
}

/** رفض المستخدم سؤال الإقرار: لا شيء كُتب، ولا رسالة خطأ — يُعرف بـisPriceRulesAckDeclined في معالج الخطأ */
export class PriceRulesAckDeclined extends Error {
  constructor() { super(PRICE_RULES_UNIT_ACK_CODE); this.name = 'PriceRulesAckDeclined'; }
}
export const isPriceRulesAckDeclined = (e: unknown): boolean => e instanceof PriceRulesAckDeclined;

/**
 * الطلب كما هو (`first`)، و409 PRICE_RULES_UNIT_ACK ⇒ سؤالٌ بنصّ الخادم (`ask` — window.confirm بـtr) ثم الطلب نفسه بالإقرار
 * (`acked`) مرّةً واحدة. رفض السؤال يرمي PriceRulesAckDeclined، وأيّ خطأٍ آخر يُرمى كما هو
 */
export async function withPriceRulesAck<T>(first: () => Promise<T>, acked: () => Promise<T>, ask: (message: string) => boolean): Promise<T> {
  try {
    return await first();
  } catch (err) {
    const a = priceRulesAckOf(err);
    if (!a) throw err;
    if (!ask(a.message)) throw new PriceRulesAckDeclined();
    return acked();
  }
}

/** السؤال في المتصفح: نصّ الخادم بلغة الواجهة */
export const priceRulesAckAsker = (tr: Tr, confirmFn: (s: string) => boolean = (s) => window.confirm(s)) =>
  (message: string): boolean => confirmFn(tr(message));

/** عدد القواعد التي يتغيّر معناها في معاينة «إضافة وحدة فرعية أصغر» (dryRun.priceRulesAffected) — غائبٌ أو تالف ⇒ صفر */
export function priceRulesAffectedOf(dryRun: unknown): number {
  const n = Number((dryRun as { priceRulesAffected?: unknown } | null | undefined)?.priceRulesAffected);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** نصّ المعاينة حين يتغيّر معنى قواعد بالوحدة الرئيسية (مفتاحٌ في القاموس) */
export const PRICE_RULES_AFFECTED_TEXT =
  '{n} قاعدة في قوائم الأسعار تشمل هذا الصنف محسوبة بوحدته الرئيسية (سعر فئة أو حد أدنى للكمية) ويتغير معناها بهذه الإضافة — أبق الوحدة الحالية رئيسية ليبقى كما هو';
