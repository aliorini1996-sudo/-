/**
 * «أنواع الأسعار» (طلب المالك، ١ نوفمبر ٢٠٢٦) — أسعارٌ مسمّاة تحدّدها الشركة بحرّية («سعر الجملة»، «سعر التجزئة»…)، صرفةٌ هنا
 * بلا قاعدة ولا Express. الموجّه routes/priceLists.ts، وحارس الفاتورة في routes/invoices.ts.
 *
 * - **السعر لوحدة الأساس صافياً بستّ منازل** كـCustomerPrice تماماً: يُدخَل بالوحدة الرئيسية (أو الأساس بلاها) ويُقسم على
 *   معاملها، فتُشتقّ بقية الوحدات بمعاملها، ويقسمه convert-base على F مع أسعار العملاء.
 * - **الترتيب:** سعر العميل الخاص يغلب النوع، والنوع يغلب سعر الوحدة المحدَّد والأساس — أي سلسلة اليوم نفسها و«سعر العميل»
 *   فيها = سعر العميل ?? سعر النوع (refOverrideOf).
 * - **نوع المستند:** المرسل إن حضر مفتاحه، وإلا نوع العميل — فالعميل القديم وصندوق الأوف-لاين القديم بلا المفتاح كما كانا.
 * - شركةٌ بلا أنواع = سلوك اليوم حرفياً: لا استعلام زائد في مسار الإصدار.
 */
import { roundHalfUp } from '../lib/money';

/** أقصى طول لاسم نوع السعر واسم زرّ السعر الأساسي */
export const PRICE_LIST_NAME_MAX = 40;
/** منازل سعر النوع لوحدة الأساس — كسعر العميل المستورد من سعر كرتون (import.ts): ×٢٤ يعيد سعر الكرتون بالهللة */
export const LIST_PRICE_DECIMALS = 6;

export const PRICE_LIST_MESSAGES = Object.freeze({
  PRICE_LIST_INVALID: 'نوع السعر غير موجود',
  PRICE_LIST_FORBIDDEN: 'لا تملك صلاحية تبديل نوع السعر',
  PRICE_LIST_IN_USE: 'نوع السعر مستخدم لعملاء انقلهم إلى نوع آخر أولاً',
  PRICE_LIST_NAME_TAKEN: 'يوجد نوع سعر بهذا الاسم',
  PRICE_LIST_NAME_INVALID: `اسم نوع السعر من حرف إلى ${PRICE_LIST_NAME_MAX} حرفاً`,
});
export type PriceListCode = keyof typeof PRICE_LIST_MESSAGES;

/** اسم نوع السعر (أو زرّ الأساس) بعد القصّ — null إن كان فارغاً أو أطول من الحدّ */
export function priceListName(raw: unknown): string | null {
  const name = String(raw ?? '').trim();
  return name.length >= 1 && name.length <= PRICE_LIST_NAME_MAX ? name : null;
}

/**
 * سعر النوع لوحدة الأساس من سعرٍ صافٍ بالوحدة الرئيسية ومعاملها (١ = الأساس نفسه) — نصف-لأعلى بستّ منازل.
 * المعامل التالف يُقرأ ١ (كـfactorOf)، والسعر غير المنتهي null.
 */
export function listBasePriceOf(primaryNet: number, primaryFactor: number | null | undefined): number | null {
  const p = Number(primaryNet);
  if (!Number.isFinite(p) || p < 0) return null;
  const f = Number(primaryFactor);
  return roundHalfUp(p / (Number.isFinite(f) && f > 0 ? f : 1), LIST_PRICE_DECIMALS);
}

/**
 * نوع سعر المستند: المرسل إن حضر مفتاحه (`undefined` = غائب؛ null = السعر الأساسي صراحةً)، وإلا نوع العميل المحفوظ.
 */
export function docPriceListOf(sent: string | null | undefined, customerListId: string | null | undefined): string | null {
  return sent !== undefined ? (sent || null) : (customerListId ?? null);
}

/** سعر لوحدة الأساس يغلب سعر الوحدة والأساس في مرجع الحارس: سعر العميل الخاص، وإلا سعر نوع المستند، وإلا null */
export function refOverrideOf(custPrice: number | null | undefined, listPrice: number | null | undefined): number | null {
  if (custPrice != null && Number.isFinite(Number(custPrice))) return Number(custPrice);
  if (listPrice != null && Number.isFinite(Number(listPrice))) return Number(listPrice);
  return null;
}
