/**
 * مستنداتٌ «أطول ما يحمله كل مربع» لقياس فيض مربعات اللوحة في المصمّم (مراجعة A4، طلب المالك ٣ نوفمبر ٢٠٢٦).
 *
 * لماذا: مستند المعاينة فاتورةٌ نقدية بلا خصم وسندٌ بفاتورةٍ واحدة. مربعٌ يُضبط عليه يقصّ (overflow:hidden) في المستند الحقيقي:
 *   · الإجماليات في فاتورةٍ آجلة بخصم: سطر الخصم يدفع «الإجمالي النهائي» تحت حافة المربع، و«المدفوع/المتبقي» يختفيان (+١١١ بكسل).
 *   · بيانات المستند في إشعارٍ دائن: «الفاتورة الأصلية» (BT-25) و«سبب الإرجاع» (KSA-10) إلزاميان ويُقصّان.
 *   · مربع المبلغ في سند قبضٍ لعدّة فواتير: أرقام الفواتير ومبالغها والرصيد الدائن.
 * فالمصمّم يرسم هذه المستندات مخفيّةً بالمظهر نفسه ويضمّ فيضها إلى شارة «النص أكبر من المربع» — والورقة المرئية تبقى المعاينة.
 * القيم تُشتقّ من مستند المعاينة نفسه (نصوصه مترجمة) — لا نصّ عرضٍ جديد هنا.
 */
import type { DocCustomer, InvoiceDoc, ReceiptDoc } from '../../../rep/RepDocuments';

/** العميل بكل حقوله الاختيارية (السجل والجوال والعنوان) */
function fullCustomer(c: DocCustomer): DocCustomer {
  const addr = c.address || c.businessName || c.name;
  return {
    ...c,
    businessName: c.businessName || c.name,
    commercialReg: c.commercialReg || '1010000000',
    taxNumber: c.taxNumber || '310000000000003',
    phone: c.phone || '0500000000',
    address: addr,
    district: c.district || addr,
    city: c.city || addr,
  };
}

/** فاتورةٌ آجلة بخصمٍ ومدفوعٍ ومتبقٍّ وتاريخ تسليم، وإشعارٌ دائن بمرجعه وسببه — صنفٌ واحد (الأصناف تسري لا مربع لها) */
export function stressInvoiceDocs(sample: InvoiceDoc): InvoiceDoc[] {
  const items = sample.items.slice(0, 1);
  const customer = fullCustomer(sample.customer);
  const total = Number(sample.total) || 0;
  const discount = Math.max(1, Math.round(total * 0.05 * 100) / 100);
  const credit: InvoiceDoc = {
    ...sample, items, customer, type: 'CREDIT', paymentPlan: null, isReturn: false, discount,
    paidAmt: Math.round((total / 2) * 100) / 100, remainingAmt: Math.round((total - total / 2) * 100) / 100,
    deliveryDate: sample.deliveryDate || sample.date,
  };
  const reason = [customer.businessName, customer.address, customer.city].filter(Boolean).join(' — ');
  const note: InvoiceDoc = {
    ...sample, items, customer, isReturn: true, billingReference: `${sample.number}-0000000001`, noteReason: reason,
    deliveryDate: sample.deliveryDate || sample.date,
  };
  return [credit, note];
}

/** سندٌ لأربع فواتير مع رصيدٍ دائن غير مخصّص وملاحظات وعميلٍ بكل حقوله */
export function stressReceiptDoc(sample: ReceiptDoc): ReceiptDoc {
  const base = sample.invoices?.[0]?.number || sample.number;
  const each = Math.max(1, Math.round((Number(sample.amount) || 100) * 100) / 100);
  const invoices = [1, 2, 3, 4].map((i) => ({ number: `${base}-${i}`, amount: each }));
  const customer = fullCustomer(sample.customer);
  return {
    ...sample, customer, invoices, amount: each * 4 + 50,
    notes: sample.notes || [customer.businessName, customer.address].filter(Boolean).join(' — '),
  };
}
