// ============================================================================
// «أرشيف العميل — السجل الزمني» (طلب المالك ٢٦ نوفمبر ٢٠٢٦): طلب المنيو في سجلّ عميله
// ----------------------------------------------------------------------------
// طلب المنيو (CatalogOrder) بلا customerId: صاحبه يُعرف بجواله وحده. فالحدث يُنسب لعميل الشركة المطابق بقاعدة مطابقة تطبيق
// المندوب حرفياً (routes/catalogOrders.ts — ترجمة الأرقام الهندية وآخر ثمانية أرقام في SQL ثم المفتاح الكامل في JS)، بلا قيد
// نطاق: السجلّ للعميل لا للمندوب، وقراءته محروسةٌ بنطاق العميل نفسه. وطلبٌ لا يطابق عميلاً لا حدث له (لا عميل يُسجَّل عليه) —
// إلا إغلاقه بفاتورة: عميله عميل الفاتورة.
// ============================================================================

import { matchableKey, phoneTail, pickMatchedCustomer, type CustomerCandidate } from './catalogOrders';

type CatalogDb = { $queryRaw: <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T> };

/** أحدث عميلٍ غير محذوف في الشركة جوّاله بمفتاح الطلب — أو null. المفتاح غير الصالح للمطابقة ⇒ null بلا استعلام */
export async function matchCatalogCustomer(db: CatalogDb, tenantId: string, phoneKey: string | null | undefined): Promise<{ id: string; name: string } | null> {
  if (!matchableKey(phoneKey)) return null;
  const tail = phoneTail(phoneKey);
  const rows = await db.$queryRaw<CustomerCandidate[]>`
    SELECT id, name, phone, "createdAt" FROM customers
    WHERE "tenantId" = ${tenantId} AND status <> 'DELETED'
      AND right(regexp_replace(translate(coalesce(phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), 8) = ${tail}
    ORDER BY "createdAt" DESC, id DESC
    LIMIT 50`;
  return pickMatchedCustomer(phoneKey, Array.isArray(rows) ? rows : [], () => true);
}

/** المبلغ التقديري للطلب كما رآه العميل: Σ الكمية × السعر الصافي × (١ + الضريبة) — بمنزلتين */
export function catalogOrderEstimate(lines: readonly { qty: number; unitPrice: number; taxPct?: number | null }[]): number {
  let t = 0;
  for (const l of lines ?? []) {
    const q = Number(l.qty); const p = Number(l.unitPrice); const tax = Number(l.taxPct ?? 0);
    if (Number.isFinite(q) && Number.isFinite(p)) t += q * p * (1 + (Number.isFinite(tax) ? tax : 0) / 100);
  }
  return Math.round(t * 100) / 100;
}
