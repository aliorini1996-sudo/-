/**
 * الصنف المحذوف حذفاً حقيقياً (أمر المالك ٥ نوفمبر ٢٠٢٦: «الحذف… حذف فعلي و حقيقي بدون نسخة ثانية»): قبل حذفه يُكتب اسمه
 * في بنود فواتيره (InvoiceItem.itemName — لقطة البند) ثم يُفكّ ربطها (productId ← null) فتبقى الفواتير.
 * وهنا قراءة تلك البنود: بندٌ بلا صنفٍ وله لقطة اسم يُعرض بصنفٍ اصطناعيّ من لقطته — فالفاتورة والطباعة وكشف الحساب تعرض
 * اسمه كما كان دون مسّ قوالبها. وبندٌ بلا صنفٍ ولا لقطة (سطر إشعارٍ مدين حرّ مثلاً) يبقى كما كان حرفياً.
 */
export interface DeletedProductStub { id: null; name: string; unit: string | null; code: null; primaryUnitId: null; units: never[] }

export function withDeletedProductName<T extends { product?: unknown; itemName?: string | null; unitName?: string | null }>(it: T): T {
  if (it.product || !it.itemName) return it;
  const stub: DeletedProductStub = { id: null, name: it.itemName, unit: it.unitName ?? null, code: null, primaryUnitId: null, units: [] };
  return { ...it, product: stub };
}
