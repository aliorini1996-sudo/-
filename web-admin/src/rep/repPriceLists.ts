/**
 * «أنواع الأسعار» في تطبيق المندوب — قرارات صرفة بلا React ولا شبكة ولا IndexedDB (repPriceLists.test.ts). المكوّن (CreateInvoice في
 * RepApp.tsx) يجلب ويخبّئ، وهنا يُحكم: أيّ نوعٍ هو نوع العميل الآن، وهل في الجهاز أسعار نوع الفاتورة، وأيّ رقاقةٍ تُعرض، ومتى تكفي
 * أسماء الأنواع المخبّأة بلا طلب.
 *
 * ═══ لماذا ═══ الخادم يسعّر فاتورة المندوب بنوع العميل **الحالي** في ملفه (المفتاح غائب) أو بما أرسله (بالصلاحية)، ويقيس السعر على
 * `(سعر العميل ?? سعر النوع) × المعامل`. فنوعٌ قديم في صفّ العميل المخبّأ، أو نوعٌ بلا أسعارٍ في كاش الجهاز (فيُسعَّر بالأساس صامتاً)،
 * يعني ردّ الفاتورة 403 «لا تملك صلاحية تغيير سعر البيع» — ودون اتصال بعد صفّها وطباعة ورقتها وتسليم البضاعة.
 */
import type { PriceListsInfo } from '../types';
import { priceListsOf } from '../lib/priceLists';
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
 * أسماء الأنواع من كاش الجهاز تكفي بلا طلب؟ (القاعدة هي العنق الضيّق، وكل فتح فاتورةٍ لكل مندوب كان طلباً وثلاث جمل حتى لشركةٍ بلا
 * أنواع — والزيارات الميدانية تتباعد أكثر من ٥ دقائق فلا تكفي نافذة زمنية وحدها). null ⇒ اجلب:
 *  • كاشٌ لا **يعرف** نوع العميل المخبّأ (`mustKnow`) أقدم منه ⇒ يُجلب.
 *  • شركةٌ بلا أنواع في آخر ردٍّ قرأه الجهاز، ومندوبٌ بلا «تبديل نوع السعر» (`canSwitch`)، وعميلٌ بلا نوع: لا يحتاج اسماً ولا سعراً
 *    فلا طلب أبداً — قرار المالك «لا استعلام زائد لشركةٍ لا تستعمل الميزة». فإن أنشأت الشركة أول نوعٍ وأسندته لعميل بعدها عرفه
 *    الجهاز من صفّ العميل حين تُجلب قائمة العملاء (`mustKnow` أعلاه)، وقبل ذلك يردّ الخادم الفاتورة مرّةً فتُقرأ الأنواع ونوع العميل
 *    من جديد (loadPriceLists(true)) ويعيد المندوب الإصدار.
 *  • وإلا (أنواعٌ قائمة، أو مندوبٌ يبدّل): ما قُرئ من الخادم خلال ٥ دقائق (companyRefreshDue، كإعدادات الشركة).
 * وكاشٌ تالفٌ بلا مصفوفة أنواع لا يُعدّ «شركةً بلا أنواع» ⇒ يُجلب
 */
export function repCachedNamesOf(
  hit: { data: unknown; updatedAt: number } | null | undefined,
  nowMs: number,
  mustKnow: string | null,
  canSwitch = false,
): PriceListsInfo | null {
  if (!hit || !Array.isArray((hit.data as { lists?: unknown } | null)?.lists)) return null;
  const info = priceListsOf(hit.data);
  if (mustKnow && !info.lists.some((l) => l.id === mustKnow)) return null;
  if (!info.lists.length && !canSwitch) return info;
  return companyRefreshDue(hit.updatedAt, nowMs) ? null : info;
}
