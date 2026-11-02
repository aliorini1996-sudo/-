/**
 * «أنواع الأسعار» في تطبيق المندوب — قرارات صرفة بلا React ولا شبكة ولا IndexedDB (repPriceLists.test.ts). المكوّن (CreateInvoice في
 * RepApp.tsx) يجلب ويخبّئ، وهنا يُحكم: أيّ نوعٍ هو نوع العميل الآن، وهل في الجهاز أسعار نوع الفاتورة، وأيّ رقاقةٍ تُعرض، ومتى تكفي
 * أسماء الأنواع المخبّأة بلا طلب.
 *
 * ═══ لماذا ═══ الخادم يسعّر فاتورة المندوب بنوع العميل **الحالي** في ملفه، وإلا بنوع المندوب الافتراضي (المفتاح غائب)، أو بما أرسله
 * (بالصلاحية وضمن أنواعه المسموحة)، ويقيس السعر على
 * `(سعر العميل ?? سعر النوع) × المعامل`. فنوعٌ قديم في صفّ العميل المخبّأ، أو نوعٌ بلا أسعارٍ في كاش الجهاز (فيُسعَّر بالأساس صامتاً)،
 * يعني ردّ الفاتورة 403 «لا تملك صلاحية تغيير سعر البيع» — ودون اتصال بعد صفّها وطباعة ورقتها وتسليم البضاعة.
 */
import type { PriceListsInfo } from '../types';
import { allowedPriceTypesOf, priceListsOf, priceTypeAllowed, switchablePriceTypesOf } from '../lib/priceLists';
import { companyRefreshDue } from './companyRefresh';

/** معرّف نوعٍ صالح أو null (السعر الأساسي) — صفٌّ قديم بلا الحقل أو بقيمةٍ فارغة ⇒ null */
export function listIdOf(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/**
 * نوع سعر العميل الذي يسعّر به الخادم فاتورته الآن:
 *  • ما قُرئ من ملفه على الخادم عند فتح الفاتورة (`live`؛ undefined = لم يُقرأ: دون اتصال أو تعذّر) يغلب صفّه المخبّأ (`cached`) —
 *    قائمة العملاء قد تكون من الصباح والمدير نقل العميل إلى نوعٍ آخر بعدها، كما تُجلب أسعاره الخاصة مع كل فتح لهذا السبب نفسه.
 *  • نوعٌ ليس في أسماء الخادم **الطازجة** (`namesFromServer`) حُذف، والحذف يفرّغ نوع عملائه (SetNull) ⇒ السعر الأساسي. أما الأسماء
 *    من كاش الجهاز فلا تحكم بذلك (قد تسبق إنشاء النوع): يبقى النوع ويُفحص توفّر أسعاره (repListMissing).
 */
export function repCustomerListOf(
  cached: unknown,
  live: string | null | undefined,
  names: Pick<PriceListsInfo, 'lists'> | null,
  namesFromServer: boolean,
): string | null {
  const id = live !== undefined ? listIdOf(live) : listIdOf(cached);
  if (id && namesFromServer && names && !names.lists.some((l) => l.id === id)) return null;
  return id;
}

/**
 * «نوع سعر المندوب» (طلب المالك ٢ نوفمبر ٢٠٢٦): نوعه الافتراضي من rep_user (دمج /auth/me؛ null = السعر الأساسي) — يسعّر به الخادم
 * فاتورة عميلٍ بلا نوع (defaultPriceTypeOf). وحذف نوعٍ مندوبٌ عليه ممنوعٌ في الخادم (409)، فغيابه عن أسماء الخادم **الطازجة** يعني
 * rep_user أقدم من تبديل المدير لنوعه ثم حذف القديم ⇒ السعر الأساسي حتى تصل refreshUser (ورفضٌ سعريّ يستدعيها فوراً). وأسماء كاش
 * الجهاز لا تحكم بذلك كنوع العميل (قد تسبق إنشاءه): يبقى النوع ويُفحص توفّر أسعاره (repListMissing)
 */
export function repDefaultListOf(raw: unknown, names: Pick<PriceListsInfo, 'lists'> | null, namesFromServer: boolean): string | null {
  return repCustomerListOf(raw, undefined, names, namesFromServer);
}

/**
 * نوع سعر الفاتورة: افتراضيّها (`docDefault` = نوع العميل ?? نوع المندوب ?? الأساسي — defaultPriceTypeOf)، أو ما اختاره المندوب من
 * الرقاقات (`picked` undefined = لم يختر؛ null = السعر الأساسي صراحةً) — بصلاحية «تبديل نوع السعر» وحدها، وضمن أنواعه المسموحة
 * (`allowed` من allowedPriceTypesOf؛ null = بلا قيد كاليوم) كما يحكم الخادم (priceTypeAllowed). فصلاحيةٌ أو نوعٌ مسموحٌ سُحبا بعد
 * الاختيار (refreshUser) يعيدانه إلى الافتراضيّ بدل ردّ الفاتورة 403 PRICE_LIST_FORBIDDEN
 */
export function repInvoiceListOf(
  docDefault: string | null,
  picked: string | null | undefined,
  canSwitch: boolean,
  allowed: Array<string | null> | null = null,
): string | null {
  if (canSwitch && picked !== undefined && priceTypeAllowed(picked, allowed, docDefault)) return picked;
  return docDefault;
}

/**
 * نوع الفاتورة بلا أسعارٍ في الجهاز؟ — نوعٌ (لا السعر الأساسي) غائبٌ عن ردّ /price-lists/prices المخبّأ: كاشٌ أقدم من النوع أو من
 * إسناده للعميل، أو كاشٌ قُرئ والمندوب بلا «تبديل نوع السعر» (أنواع عملائه وحدها)، أو أسعارٌ لم تصل بعد. البنود حينها بالسعر الأساسي
 * والخادم يسعّر بالنوع ⇒ لا إصدار حتى تصل. ونوعٌ حاضرٌ بلا بنود (لا سعر فيه لأي صنف) ليس غائباً: سلسلة اليوم هي سعره فعلاً
 */
export function repListMissing(listId: string | null, rows: ReadonlyArray<{ id: string }> | null | undefined): boolean {
  return listId != null && !(rows ?? []).some((l) => l.id === listId);
}

/**
 * رقاقات التبديل بعد رقاقة السعر الأساسي: الأنواع التي وصلت أسعارها وحدها — نوعٌ بلا أسعارٍ في الجهاز يُسعّر بالأساس صامتاً والجسم
 * يحمل معرّفه فيسعّر الخادم بالنوع (صلاحيةٌ مُنحت بعد قراءة أسعارٍ محصورة بأنواع العملاء، أو أسماءٌ أحدث من الأسعار). ويُستثنى نوع
 * الفاتورة الحالي (`current`) فيبقى ظاهراً مختاراً مع تنبيه غيابه
 */
export function repListChipsOf<L extends { id: string }>(
  lists: readonly L[] | null | undefined,
  rows: ReadonlyArray<{ id: string }> | null | undefined,
  current: string | null,
): L[] {
  return (lists ?? []).filter((l) => l.id === current || (rows ?? []).some((r) => r.id === l.id));
}

/**
 * رقاقات المندوب المبدِّل («نوع سعر المندوب»): ما يبدّل إليه (switchablePriceTypesOf: بلا قيدٍ الأساسي وكل الأنواع كاليوم، وإلا
 * أنواعه المسموحة ∪ افتراضيّ الفاتورة) مما وصلت أسعاره (repListChipsOf) — ونوع الفاتورة الحالي يبقى ظاهراً مختاراً. `base` = رقاقة
 * السعر الأساسي (لا أسعار تلزمه). الترتيب ترتيب الشركة (الأساسي أولاً ثم الأنواع بترتيبها) كاليوم، لا ترتيب المسموح: الرقاقات لا
 * تتنقّل من عميلٍ لآخر
 */
export function repSwitchChipsOf<L extends { id: string }>(
  lists: readonly L[] | null | undefined,
  rows: ReadonlyArray<{ id: string }> | null | undefined,
  current: string | null,
  allowed: Array<string | null> | null,
  docDefault: string | null,
): { base: boolean; lists: L[] } {
  const can = switchablePriceTypesOf(allowed, docDefault, (lists ?? []).map((l) => l.id));
  const shown = (t: string | null) => t === current || can.includes(t);
  return { base: shown(null), lists: repListChipsOf(lists, rows, current).filter((l) => shown(l.id)) };
}

/**
 * أسماء الأنواع من كاش الجهاز تكفي بلا طلب؟ (القاعدة هي العنق الضيّق، وكل فتح فاتورةٍ لكل مندوب كان طلباً وثلاث جمل حتى لشركةٍ بلا
 * أنواع — والزيارات الميدانية تتباعد أكثر من ٥ دقائق فلا تكفي نافذة زمنية وحدها). null ⇒ اجلب:
 *  • كاشٌ لا **يعرف** نوع العميل المخبّأ أو نوع المندوب الافتراضي (`mustKnow`: نوعٌ أو أكثر، null يُهمل) أقدم منه ⇒ يُجلب.
 *  • شركةٌ بلا أنواع في آخر ردٍّ قرأه الجهاز، ومندوبٌ بلا «تبديل نوع السعر» (`canSwitch`) ولا نوعٍ افتراضيّ، وعميلٌ بلا نوع: لا يحتاج اسماً ولا سعراً
 *    فلا طلب أبداً — قرار المالك «لا استعلام زائد لشركةٍ لا تستعمل الميزة». فإن أنشأت الشركة أول نوعٍ وأسندته لعميل بعدها عرفه
 *    الجهاز من صفّ العميل حين تُجلب قائمة العملاء (`mustKnow` أعلاه)، وقبل ذلك يردّ الخادم الفاتورة مرّةً فتُقرأ الأنواع ونوع العميل
 *    من جديد (loadPriceLists(true)) ويعيد المندوب الإصدار.
 *  • وإلا (أنواعٌ قائمة، أو مندوبٌ يبدّل): ما قُرئ من الخادم خلال ٥ دقائق (companyRefreshDue، كإعدادات الشركة).
 * وكاشٌ تالفٌ بلا مصفوفة أنواع لا يُعدّ «شركةً بلا أنواع» ⇒ يُجلب
 */
export function repCachedNamesOf(
  hit: { data: unknown; updatedAt: number } | null | undefined,
  nowMs: number,
  mustKnow: string | null | ReadonlyArray<string | null>,
  canSwitch = false,
): PriceListsInfo | null {
  if (!hit || !Array.isArray((hit.data as { lists?: unknown } | null)?.lists)) return null;
  const info = priceListsOf(hit.data);
  const known = (Array.isArray(mustKnow) ? mustKnow : [mustKnow]) as ReadonlyArray<string | null>;
  if (known.some((id) => id && !info.lists.some((l) => l.id === id))) return null;
  if (!info.lists.length && !canSwitch) return info;
  return companyRefreshDue(hit.updatedAt, nowMs) ? null : info;
}

/** حقول «نوع سعر المندوب» في rep_user (دمج /auth/me) */
export interface RepPriceFields {
  defaultPriceListId?: unknown;
  allowedPriceTypes?: unknown;
  canChangePriceList?: unknown;
}

/**
 * كاش أسعار الأنواع في الجهاز ('pricelists' و'pricelists:names') يُجدَّد مع refreshUser؟ — نوع المندوب الافتراضي أو أنواعه المسموحة أو
 * «تبديل نوع السعر» تبدّلت في /auth/me: الخادم يحصر ردّ /price-lists/prices للمندوب بلا الصلاحية بأنواع عملائه ونوعه، والكاش لا
 * يُجلب إلا بفتح فاتورةٍ متصلاً، فإن انقطع الجهاز قبلها حمل افتراضيّاً لا أسعار له فيه (repListMissing) ومُنع الإصدار دون اتصال لكل
 * عميلٍ بلا نوع. والمقارنة بالمعنى لا بالحرف: صفٌّ قديم بلا الحقول = null (السعر الأساسي، بلا قيد، بلا صلاحية) — فمندوبٌ لم تُضبط
 * أنواعه وشركةٌ بلا أنواع لا يُطلب لهما شيءٌ زائد أبداً
 */
export function repPriceCacheStale(prev: RepPriceFields | null | undefined, next: RepPriceFields | null | undefined): boolean {
  const key = (u: RepPriceFields | null | undefined) =>
    JSON.stringify([listIdOf(u?.defaultPriceListId), allowedPriceTypesOf(u?.allowedPriceTypes), u?.canChangePriceList === true]);
  return key(prev) !== key(next);
}
