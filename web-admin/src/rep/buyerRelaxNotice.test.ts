/**
 * «فك قيد الرقم الضريبي والعنوان الوطني» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — ما يُرسم فعلاً:
 *  • قسم بيانات المشتري (BuyerDataFields): بلا relaxed/warnings أو بـfalse/[] الرسم حرفاً كما اليوم؛ ومعهما سطر «تصدر له فاتورة
 *    ضريبية مبسطة…» للمنشأة الناقصة وقائمة «تنبيهات لا تمنع الحفظ».
 *  • إشعار «صدرت مبسطة» (InvoiceDoc.buyerNotice): على شاشة النتيجة وحدها — لا في ورقة A4 ولا في الشريط الحراري.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BuyerDataFields from '../components/BuyerDataFields';
import { buyerFormValues, buyerRelaxWarnings } from '../lib/zatca/buyerForm';
import { printThermalInvoice } from './thermal';
import { DocumentResult, PrintableInvoice, type InvoiceDoc } from './RepDocuments';

const B2B = {
  name: 'مؤسسة النور', buyerType: 'BUSINESS', taxNumber: '300000000000003', addrStreet: 'شارع الملك فهد', addrBuildingNo: '1234',
  addrPostalCode: '12345', city: 'الرياض', district: 'الملز', countryCode: 'SA',
};
const RELAX_LINE = 'تصدر له فاتورة ضريبية مبسطة حتى تكتمل بياناته ولا يستطيع خصم ضريبتها';
const WARN_TITLE = 'تنبيهات لا تمنع الحفظ';

const fields = (extra: Record<string, unknown>, values: Record<string, string>, stored: Record<string, string | null> | null = B2B) =>
  renderToStaticMarkup(createElement(BuyerDataFields, { values, stored, onChange: () => {}, include: 'all', ...extra }));

test('قسم بيانات المشتري: غياب الخاصيتين = false و[] — الرسم نفسه حرفاً، لكل حالة', () => {
  const states: Array<Record<string, string>> = [
    buyerFormValues(B2B),
    { ...buyerFormValues(B2B), addrBuildingNo: '12' },
    { ...buyerFormValues(B2B), taxNumber: '3123' },
    { ...buyerFormValues(null), name: 'x' },
    { ...buyerFormValues(null), businessName: 'مؤسسة' },
  ];
  for (const v of states) {
    const today = fields({}, v);
    assert.equal(fields({ relaxed: false, warnings: [] }, v), today);
    assert.equal(fields({ relaxed: undefined, warnings: undefined }, v), today);
    assert.ok(!today.includes(RELAX_LINE) && !today.includes(WARN_TITLE));
  }
});

test('قسم بيانات المشتري مع فكّ القيد: سطر المبسطة للمنشأة الناقصة وحدها، وقائمة التنبيهات بالعربية وبغيرها', () => {
  const bad = { ...buyerFormValues(B2B), addrBuildingNo: '12', taxNumber: '3123' };
  const warnings = buyerRelaxWarnings(bad, B2B);
  assert.deepEqual(warnings.map(w => w.field).sort(), ['addrBuildingNo', 'taxNumber']);
  const html = fields({ relaxed: true, warnings }, bad);
  assert.ok(html.includes(RELAX_LINE), 'سطر المبسطة غائب عن المنشأة الناقصة');
  assert.ok(html.includes(WARN_TITLE));
  for (const w of warnings) assert.ok(html.includes(w.messageAr), w.field);
  // المكتملة ضريبية والفرد مبسطة أصلاً: لا سطر
  assert.ok(!fields({ relaxed: true, warnings: [] }, buyerFormValues(B2B)).includes(RELAX_LINE));
  assert.ok(!fields({ relaxed: true, warnings: [] }, { ...buyerFormValues(null), name: 'x' }, null).includes(RELAX_LINE));
  // relaxed وحده بلا تنبيهات: لا قائمة
  assert.ok(!fields({ relaxed: true }, bad).includes(WARN_TITLE));
  // (الرسم على الخادم يقرأ حال اللغة الابتدائية «ar» دائماً — فرع اللغات الأخرى نسخة errorOf القائمة: اسم الحقل وعبارة عامة)
});

const NOTICE = 'صدرت فاتورة ضريبية مبسطة لأن بيانات العميل ناقصة للفاتورة الضريبية — ناقص للفاتورة الضريبية: رقم المبنى (4 أرقام)';
const doc = (over: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-7', date: '2026-10-31T10:00:00', type: 'CASH',
  company: { name: 'شركة', taxNumber: '300000000000003', countryCode: 'SA' }, customer: { name: 'مؤسسة النور' }, repName: 'أحمد',
  items: [{ name: 'ماء', qty: 1, unitPrice: 11.5, discountPct: 0, taxPct: 15, lineTotal: 11.5 }],
  subtotal: 10, discount: 0, tax: 1.5, total: 11.5, pricesIncludeTax: true, ...over,
});

test('إشعار «صدرت مبسطة»: على شاشة النتيجة وحدها — وبلاه الشاشة كما اليوم', () => {
  const withNotice = renderToStaticMarkup(createElement(DocumentResult, { doc: doc({ buyerNotice: NOTICE }), onClose: () => {} }));
  assert.ok(withNotice.includes('data-buyer-notice'));
  assert.ok(withNotice.includes(NOTICE));
  // الإشعار خارج المعاينة: الورقة المصغّرة لا تحمله (يظهر مرّة واحدة في الشاشة)
  assert.equal(withNotice.split(NOTICE).length - 1, 1);
  const plain = renderToStaticMarkup(createElement(DocumentResult, { doc: doc(), onClose: () => {} }));
  assert.ok(!plain.includes('data-buyer-notice'));
  assert.equal(renderToStaticMarkup(createElement(DocumentResult, { doc: doc({ buyerNotice: null }), onClose: () => {} })), plain);
});

test('إشعار «صدرت مبسطة» لا يدخل الورقة: A4 والحراري حرفاً كما بلا إشعار', async () => {
  const a4 = (d: InvoiceDoc) => renderToStaticMarkup(createElement(PrintableInvoice, { doc: d }));
  assert.equal(a4(doc({ buyerNotice: NOTICE })), a4(doc()));
  assert.ok(!a4(doc({ buyerNotice: NOTICE })).includes('صدرت فاتورة ضريبية مبسطة'));
  const thermal = async (d: InvoiceDoc) => {
    let html = '';
    await printThermalInvoice(d, { tr: (s: string) => s, capture: (h) => { html = h; } });
    return html;
  };
  const t = await thermal(doc({ buyerNotice: NOTICE }));
  assert.ok(t.length > 0, 'الحراري لم يُلتقط');
  assert.equal(t, await thermal(doc()));
});
