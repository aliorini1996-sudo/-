/**
 * «نوع سعر المندوب» في نافذة فاتورة الإدارة (InvoiceModal — طلب المالك ٢ نوفمبر ٢٠٢٦) — منطقٌ صرف بلا React ولا شبكة، يُختبر وحده
 * (invoiceModalRepPrice.test.ts). القاعدة نفسها defaultPriceTypeOf المشتركة مع الخادم حرفاً — لا تُكرَّر هنا.
 *
 * نوع الفاتورة: ما اختاره المدير برقاقة إن اختار — والمدير حرٌّ بين كل الأنواع (قيد «الأنواع المسموحة» للمندوب وحده) — وإلا
 * الافتراضي: نوع العميل ?? النوع الافتراضي للمندوب المختار ?? السعر الأساسي (null). تغيير العميل يعيد الاختيار إلى الافتراضي كما كان،
 * وتغيير المندوب يغيّر الافتراضي وحده: النوع يتبعه ما لم يختر المدير رقاقة. والبنود التي لم يُعدَّل سعرها تُعاد بالنوع الجديد.
 */
import { defaultPriceTypeOf } from './priceLists';

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
