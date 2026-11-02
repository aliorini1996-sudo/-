/**
 * «أنواع الأسعار» (طلب المالك: رقاقات تبديلٍ بأسماء تختارها الشركة — سعر الجملة، سعر التجزئة…) — منطق لوحة الإدارة الصرف بلا
 * React ولا شبكة، يُختبر وحده (priceLists.test.ts).
 *
 * ═══ القاعدة الواحدة (مطابقة لحارس الخادم حرفاً) ═══
 * سعر النوع مخزَّنٌ صافياً **لوحدة الأساس** بست منازل (= سعر الوحدة الرئيسية ÷ معاملها) كسعر العميل الخاص، فمرجع البند:
 * `choiceNet(c, basePrice, سعر العميل ?? سعر النوع)` — سعر العميل الخاص يغلب النوع، والنوع يغلب سعر الوحدة المحدَّد والأساس.
 * ويُدخَل ويُعرض بالوحدة الرئيسية (الأساس بلاها)، والوحدات الأخرى مشتقّةٌ بمعاملها.
 *
 * والرقاقة الأولى السعر الافتراضي نفسه (Product.basePrice كما كان حرفاً) باسمٍ تختاره الشركة (null ⇒ «السعر الأساسي»).
 * والأسماء بيانات الشركة لا تمرّ بـtr. وشركةٌ بلا أنواع: لا رقاقات ولا مفتاح في الجسم — كما قبل الميزة.
 */
import type { PriceList, PriceListsInfo, ProductListPrice } from '../types';
import { roundHalfUp } from './money';
import { primaryUnitOf, type UnitDef } from './units';
import { choiceNet, rebaseCustPrices, type CustPriceInput, type UnitChoice, type UnitProduct } from '../rep/repUnits';

/** اسم الرقاقة الأولى حين لم تسمّها الشركة — عبارةٌ قائمة في القاموس */
export const DEFAULT_BASE_PRICE_LABEL = 'السعر الأساسي';
/** حدّ اسم النوع (والرقاقة الأولى) — مطابقٌ لمخطّط الخادم */
export const PRICE_LIST_NAME_MAX = 40;

/** ردّ GET /price-lists مطبَّعاً: صفوفٌ صالحة بترتيبها — وردٌّ تالف أو غائب ⇒ لا أنواع */
export function priceListsOf(data: unknown): PriceListsInfo {
  const d = (data ?? {}) as { basePriceLabel?: unknown; lists?: unknown };
  const lists: PriceList[] = (Array.isArray(d.lists) ? d.lists : [])
    .filter((l): l is PriceList => !!l && typeof (l as PriceList).id === 'string' && typeof (l as PriceList).name === 'string')
    .map((l) => ({
      id: l.id, name: l.name, sortOrder: Number(l.sortOrder) || 0,
      ...(l.customersCount != null && { customersCount: Number(l.customersCount) || 0 }),
    }))
    // ثابتٌ على ترتيب الخادم (sortOrder ثم الاسم) — المتساويان يبقيان كما ردّهما
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const label = typeof d.basePriceLabel === 'string' && d.basePriceLabel.trim() ? d.basePriceLabel.trim() : null;
  return { basePriceLabel: label, lists };
}

/** اسم الرقاقة الأولى: ما سمّته الشركة كما هو (بيانات)، وإلا «السعر الأساسي» مترجماً */
export function baseLabelOf(info: Pick<PriceListsInfo, 'basePriceLabel'> | null | undefined, tr: (s: string) => string): string {
  const own = info?.basePriceLabel?.trim();
  return own || tr(DEFAULT_BASE_PRICE_LABEL);
}

/** اسم نوعٍ أو الرقاقة الأولى: مقصوصٌ بين ١ و٤٠ حرفاً (رسالة للعرض بـtr، أو null) */
export function priceListNameProblem(name: string): string | null {
  const n = String(name ?? '').trim();
  if (!n) return 'اكتب اسم نوع السعر';
  if (n.length > PRICE_LIST_NAME_MAX) return 'اسم نوع السعر 40 حرفا على الأكثر';
  return null;
}

/** أسعار الصنف في الأنواع لوحدة الأساس بمعرّف النوع — صفٌّ بلا سعرٍ صالح يُسقط */
export function listBaseMap(rows: ProductListPrice[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) {
    const v = Number(r?.price);
    if (r?.priceListId && Number.isFinite(v)) out[r.priceListId] = v;
  }
  return out;
}

/** معامل الوحدة التي يُدخَل بها سعر النوع: الرئيسية الصالحة (primaryUnitOf)، وإلا الأساس (١) */
export function listEntryFactor(p: { primaryUnitId?: string | null; units?: UnitDef[] | null } | null | undefined): number {
  const u = primaryUnitOf(p);
  return u ? Number(u.factor) : 1;
}

/** سعر النوع كما يُعرض في خانته: سعر الأساس × معامل الوحدة الرئيسية بأربع منازل (يكفي لست منازل الأساس ×٢ فأكثر) */
export function listShownPrice(basePrice: number | null | undefined, factor: number): string {
  const v = Number(basePrice);
  if (basePrice == null || !Number.isFinite(v)) return '';
  return String(roundHalfUp(v * (Number(factor) || 1), 4));
}

/** رقمٌ من خانة (الأرقام الهندية والفاصلة العربية كاللاتينية): '' ⇒ null (لا سعر)، وغير الرقم ⇒ NaN */
export function listPriceInput(raw: string | null | undefined): number | null {
  const s = String(raw ?? '').trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace('٫', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** بندٌ في PUT /products/:id/list-prices — price سعر الوحدة الرئيسية صافياً، وnull يحذف سعر النوع */
export interface ListPriceItem { priceListId: string; price: number | null }
/** ما تحمله نافذة الصنف إلى صفحته مع الحفظ: البنود المتغيّرة والرئيسية كما أُدخلت بها (null = بلا رئيسية) */
export interface ListPriceEdits { items: ListPriceItem[]; expectedPrimary: { id: string; factor: number } | null }

/**
 * ما تغيّر من خانات الأنواع وحده (المسودّة مقابل المعروض عند الفتح) — فالنوع الذي لم يُلمس لا يُعاد كتابته بقيمةٍ مقرَّبة.
 * سعرٌ غير رقمٍ أو سالب ⇒ `problem` باسم النوع (يُعرض بـtr ثم يُبدَّل {name})
 *
 * `resendAll`: عدد الفرعية في الرئيسية يتغيّر في الحفظ نفسه (الطريقة العكسية لصنفٍ قائم). المخزَّن للأساس، فمعاملٌ جديد يقلب
 * سعر الكرتون في كل نوعٍ لم يُلمس (٤ للقارورة × ١٢ = ٤٨ لا ٩٦ المعروضة)، فيُرسل كل نوعٍ له سعرٌ بما تعرضه خانته — ويقسمه
 * الخادم على المعامل الجديد، فيبقى سعر الكرتون كما رآه المدير وتُشتقّ القارورة منه كالسعر الافتراضي
 */
export function listPriceEditsOf(
  lists: Pick<PriceList, 'id' | 'name'>[],
  drafts: Record<string, string>,
  shown: (id: string) => string,
  resendAll = false,
): { items: ListPriceItem[]; problem: { listId: string; name: string } | null } {
  const items: ListPriceItem[] = [];
  for (const l of lists) {
    const drafted = Object.prototype.hasOwnProperty.call(drafts, l.id);
    if (!drafted && !resendAll) continue;
    const raw = String(drafted ? drafts[l.id] ?? '' : shown(l.id)).trim();
    if (raw === shown(l.id).trim() && !(resendAll && raw !== '')) continue;
    const v = listPriceInput(raw);
    if (v !== null && (Number.isNaN(v) || v < 0)) return { items: [], problem: { listId: l.id, name: l.name } };
    items.push({ priceListId: l.id, price: v });
  }
  return { items, problem: null };
}

/** حمولة إنشاء الصنف: listPrices بالأسعار المكتوبة وحدها (الفارغ لا معنى له لصنفٍ جديد) — وبلاها لا مفتاح */
export function listPricesCreateBody(edits: ListPriceEdits | null | undefined): { listPrices?: { priceListId: string; price: number }[] } {
  const rows = (edits?.items ?? []).filter((i): i is { priceListId: string; price: number } => i.price != null);
  return rows.length ? { listPrices: rows } : {};
}

/** أسعار نوعٍ لكل صنف (لوحدة الأساس) من قائمة الأصناف — null ⇒ السعر الافتراضي: لا شيء */
export function listPriceMap(
  products: Array<{ id: string; listPrices?: ProductListPrice[] | null }> | null | undefined,
  listId: string | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!listId) return out;
  for (const p of products ?? []) {
    const row = (p.listPrices ?? []).find((r) => r && r.priceListId === listId);
    const v = Number(row?.price);
    if (row && Number.isFinite(v)) out[p.id] = v;
  }
  return out;
}

/**
 * السعر الذي يُمرَّر ثالثاً لـchoiceNet لكل صنف: سعر العميل الخاص (على أساس الكتالوج الحالي — rebaseCustPrices) **يغلب** سعر
 * النوع، كمرجع حارس الخادم (`cpMap.get(pid) ?? listMap.get(pid)`)
 */
export function priceOverrides(
  products: Array<UnitProduct & { id: string; baseConvertedAt?: string | Date | null; listPrices?: ProductListPrice[] | null }> | null | undefined,
  listId: string | null | undefined,
  custRows: CustPriceInput[] | null | undefined,
): Record<string, number> {
  return { ...listPriceMap(products, listId), ...(custRows?.length ? rebaseCustPrices(custRows, products) : {}) };
}

/**
 * السعر الصافي المقترح لوحدة البند في فاتورة الإدارة: `choiceNet` بثالثه (سعر العميل أو النوع)، وحين يأتي منهما يُقرَّب لأربع منازل —
 * مخزَّنٌ للأساس بست منازل فضربه في المعامل يحمل غبار القسمة (١٠٠ ÷ ٢٤ × ٢٤ = 100.000008). وبلاهما كما كان حرفاً
 */
export function suggestedNetOf(c: UnitChoice, basePrice: number | string, override?: number | null): number {
  const n = choiceNet(c, basePrice, override);
  return override == null || !Number.isFinite(Number(override)) ? n : roundHalfUp(n, 4);
}

/**
 * إعادة تسعير البنود حين يتغيّر العميل أو نوع السعر أو تصل أسعار العميل: البند الذي لم يمسّه المستخدم (سعره ما زال مرجعه
 * `refPrice`) يأخذ المرجع الجديد، والمعدَّل يدويّاً يبقى بسعره ويتبع مرجعه وحده — كقاعدة تطبيق المندوب. `freshOf` null ⇒ كما هو.
 * لا تغيّر ⇒ المصفوفة نفسها.
 */
export function repriceUntouched<L extends { unitPrice: number; refPrice: number }>(
  lines: L[],
  freshOf: (l: L) => number | null,
  withPrice: (l: L, price: number) => L,
): L[] {
  let changed = false;
  const next = lines.map((l) => {
    const fresh = freshOf(l);
    if (fresh == null || !Number.isFinite(fresh) || fresh === l.refPrice) return l;
    changed = true;
    const untouched = Math.abs(Number(l.unitPrice) - Number(l.refPrice)) < 1e-9;
    return untouched ? { ...withPrice(l, fresh), refPrice: fresh } : { ...l, refPrice: fresh };
  });
  return changed ? next : lines;
}

// ─── نافذة المندوب: «أنواع الأسعار» (النوع الافتراضي والمسموح) — عرضٌ وحده، والقواعد في النسخة المشتركة أسفل الملف ───

/** رموز خانات «أنواع الأسعار المسموحة» بترتيب الشركة: 'base' (السعر الأساسي) أولاً ثم معرّفات الأنواع */
export function repPriceTypeTokens(allLists: readonly string[]): string[] {
  return [BASE_PRICE_TYPE, ...allLists];
}

/**
 * المحدَّد من allowedPriceTypes المحفوظ رموزاً بترتيب الشركة — ورمزٌ لم يعد في أنواعها يُسقط. لا تحديد ⇒ null (كل الأنواع):
 * فالخانات الفارغة تعني «بلا قيد» كما كانت قبل الميزة
 */
export function repAllowedTokensOf(raw: unknown, allLists: readonly string[]): string[] | null {
  const allowed = allowedPriceTypesOf(raw);
  if (allowed === null) return null;
  const out = repPriceTypeTokens(allLists).filter((tok) => allowed.includes(tok === BASE_PRICE_TYPE ? null : tok));
  return out.length ? out : null;
}

/**
 * تبديل خانة نوعٍ مسموح: المحدَّد يبقى بترتيب الشركة، والنوع الافتراضي يبقى ما دام محدَّداً وإلا صار أوّل المحدَّد (الخادم يردّ
 * افتراضياً خارج المسموح 400 PRICE_TYPE_DEFAULT_NOT_ALLOWED). وآخر خانةٍ تُلغى ⇒ null (كل الأنواع) والافتراضي كما هو.
 * وأوّل خانةٍ من «كل الأنواع» تُحدِّد معها الافتراضي المحفوظ: فلا يتبدّل نوع المندوب الافتراضي في الخفاء بنقرة تقييد.
 * `defaultId` معرّف نوعٍ أو null للسعر الأساسي (كعمود defaultPriceListId)
 */
export function repToggleAllowedType(
  cur: { allowed: string[] | null; defaultId: string | null },
  token: string,
  on: boolean,
  allLists: readonly string[],
): { allowed: string[] | null; defaultId: string | null } {
  const set = new Set(cur.allowed ?? (on ? [cur.defaultId ?? BASE_PRICE_TYPE] : []));
  if (on) set.add(token); else set.delete(token);
  const allowed = repPriceTypeTokens(allLists).filter((t) => set.has(t));
  if (!allowed.length) return { allowed: null, defaultId: cur.defaultId };
  const curTok = cur.defaultId ?? BASE_PRICE_TYPE;
  const defTok = allowed.includes(curTok) ? curTok : allowed[0];
  return { allowed, defaultId: defTok === BASE_PRICE_TYPE ? null : defTok };
}

/** خيارات «النوع الافتراضي»: المحدَّد وحده، أو السعر الأساسي وكل الأنواع بلا تحديد — null = السعر الأساسي */
export function repDefaultChoices(allowed: string[] | null, allLists: readonly string[]): Array<string | null> {
  return (allowed ?? repPriceTypeTokens(allLists)).map((t) => (t === BASE_PRICE_TYPE ? null : t));
}

/**
 * سطر «نوع السعر» في جدول المناديب: الافتراضي باسمه، ثم ما يبدّل بينه — كل الأنواع، أو المحدَّد بأسمائه، أو «بلا تبديل» بلا
 * صلاحية. الأسماء بيانات الشركة (لا tr)، ونوعٌ لم يعد موجوداً يُسقط
 */
export function repPriceTypesSummary(
  rep: { defaultPriceListId?: string | null; allowedPriceTypes?: unknown; canChangePriceList?: boolean },
  info: PriceListsInfo,
  tr: (s: string) => string,
): { defaultName: string; switchable: string } {
  const nameOf = (t: string | null) => (t === null ? baseLabelOf(info, tr) : info.lists.find((l) => l.id === t)?.name ?? null);
  const defaultName = nameOf(rep.defaultPriceListId ?? null) ?? baseLabelOf(info, tr);
  if (!rep.canChangePriceList) return { defaultName, switchable: tr('بلا تبديل') };
  const allowed = repAllowedTokensOf(rep.allowedPriceTypes, info.lists.map((l) => l.id));
  if (allowed === null) return { defaultName, switchable: tr('كل الأنواع') };
  const names = allowed.map((t) => nameOf(t === BASE_PRICE_TYPE ? null : t)).filter((n): n is string => !!n);
  return { defaultName, switchable: names.join('، ') };
}

/**
 * رسالة ٤٠٩ PRICE_LIST_IN_USE عند حذف نوع: بعدد العملاء والمناديب الذين عليه (customersCount · repsCount) مترجمةً — وغيرها null
 * (فتُعرض رسالة الخادم كما هي)
 */
export function priceListInUseMessage(data: unknown, tr: (s: string) => string): string | null {
  const d = (data ?? {}) as { code?: unknown; customersCount?: unknown; repsCount?: unknown };
  if (d.code !== 'PRICE_LIST_IN_USE') return null;
  const customers = Math.max(0, Number(d.customersCount) || 0);
  const reps = Math.max(0, Number(d.repsCount) || 0);
  const fill = (s: string) => s.replace('{customers}', String(customers)).replace('{reps}', String(reps));
  if (customers > 0 && reps > 0) return fill(tr('نوع السعر مستخدم لعملاء ({customers}) ومناديب ({reps}) انقلهم إلى نوع آخر أولا'));
  if (reps > 0) return fill(tr('نوع السعر مستخدم لمناديب ({reps}) أزله من نوعهم الافتراضي وأنواعهم المسموحة أولا'));
  if (customers > 0) return fill(tr('نوع السعر مستخدم لعملاء ({customers}) انقلهم إلى نوع آخر من ملفاتهم أولا'));
  return null;
}


// ═══ نوع سعر المندوب (طلب المالك ٢ نوفمبر ٢٠٢٦) — نسختان متطابقتان: backend/src/services/priceLists.ts وweb-admin/src/lib/priceLists.ts ═══

/** «السعر الأساسي» في allowedPriceTypes — يقابله null في نوع المستند */
export const BASE_PRICE_TYPE = 'base';

/** نوع المستند الافتراضي: نوع العميل، وإلا نوع المندوب الافتراضي، وإلا السعر الأساسي (null) */
export function defaultPriceTypeOf(customerListId: string | null | undefined, repDefaultListId: string | null | undefined): string | null {
  return customerListId || repDefaultListId || null;
}

/**
 * الأنواع المسموحة للمندوب من عمود JSON: null = بلا قيد (كل الأنواع والأساسي، كاليوم)؛ وإلا مصفوفة أنواعٍ بلا تكرار بترتيبها،
 * 'base' فيها = null. ما ليس نصّاً يُهمل، ومصفوفةٌ فارغة تبقى فارغة (لا مسموح إلا الافتراضي)
 */
export function allowedPriceTypesOf(raw: unknown): Array<string | null> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<string | null> = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !v) continue;
    const t = v === BASE_PRICE_TYPE ? null : v;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** هل يبدّل المندوب (بصلاحية التبديل) إلى هذا النوع: بلا قيد ⇒ نعم؛ وإلا إن كان افتراضيَّ المستند أو ضمن المسموح */
export function priceTypeAllowed(type: string | null, allowed: Array<string | null> | null, docDefault: string | null): boolean {
  if (allowed === null) return true;
  return type === docDefault || allowed.includes(type);
}

/**
 * الأنواع التي يبدّل بينها المندوب بالترتيب: افتراضيّ المستند أولاً، ثم المسموح (أو الأساسي وكل الأنواع بلا قيد) — بلا تكرار،
 * ومعرّفٌ لم يعد في أنواع الشركة يُسقط (allLists = معرّفات الأنواع الموجودة)
 */
export function switchablePriceTypesOf(
  allowed: Array<string | null> | null, docDefault: string | null, allLists: readonly string[],
): Array<string | null> {
  const pool: Array<string | null> = allowed === null ? [null, ...allLists] : allowed;
  const out: Array<string | null> = [docDefault];
  for (const t of pool) {
    if (t !== null && !allLists.includes(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
