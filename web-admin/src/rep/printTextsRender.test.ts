/**
 * «نصوص المطبوعات» على الورق (طلب المالك ٣١ أكتوبر ٢٠٢٦) — العارضات نفسها تُرسم: الشريط الحراريّ عبر `capture` (الوثيقة التي
 * كانت ستُطبع) وقالبا A4 بـrenderToStaticMarkup.
 *
 * ١) بلا نصوص (غياب العمود أو null أو عطب أو نسخة أحدث أو إعدادٌ فارغ) ⇒ الورقة حرفاً بحرف — الكلاسيكي والجديدان وA4.
 * ٢) بنصوص ⇒ الشريط الكلاسيكي يصير «المختصر» على 58 مم، والصياغة مُهرَّبة، واللغة الثانية تحت العربي في الضيّق وبجانبه في العريض.
 * ٣) الإخفاء: يُخفي صفّه، ولا يُخفي الإلزامي ولو حمله كائنٌ خام، و«القياسي» يبقى على الفاتورة القياسية.
 * ٤) العنوان: صياغة الشركة لمستند المرحلة الأولى، والمختوم يطبع عنوان القرار.
 * ٥) معاينة المحرّر: كل نصٍّ قابلٌ للنقر، والمخفيّ مشطوبٌ حاضر — وبقية المستندات (الإشعارات) لا تتأثّر بالنصوص.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { printThermalInvoice, printThermalReceipt, thermalPreviewHtml, type ThermalPrintOptions } from './thermal';
import { PrintableInvoice, PrintableLoadNotice, PrintableReceipt, type InvoiceDoc, type LoadNoticeDoc, type ReceiptDoc } from './RepDocuments';
import { PrintTextsPreviewContext } from './printTextsContext';
import { defaultPrintOptions, legacyThermalProfile, presetPaper, type PrintProfile } from '../lib/print/printSettings';
import { sampleInvoiceDoc } from '../lib/print/calibration';
import type { PrintTextsV1 } from '../lib/print/printTexts';

const same = (s: string) => s;
/** صور QR مولَّدة من الحمولة نفسها — تُطبَّع كي تُقارن الوثائق نصّاً */
const norm = (h: string) => h.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, 'data:QR');

const company = { name: 'شركة الاختبار للتوزيع', taxNumber: '300000000000003', address: 'الرياض حي العليا', phone: '0501234567', countryCode: 'SA' };
const invoice = (c: InvoiceDoc['company'], extra?: Partial<InvoiceDoc>): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-9100', date: '2026-10-31T10:30:00', type: 'CREDIT', company: c,
  customer: { name: 'بقالة النور', address: 'حي الملز', city: 'الرياض' }, repName: 'أحمد',
  items: [
    { name: 'ماء 330 مل', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46 },
    { name: 'عصير', qty: 1, unitPrice: 11.5, discountPct: 10, taxPct: 15, lineTotal: 10.35 },
  ],
  subtotal: 50, discount: 0, tax: 6.35, total: 56.35, pricesIncludeTax: true, paidAmt: 20, remainingAmt: 36.35,
  ...extra,
});
const receipt = (c: ReceiptDoc['company']): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-77', date: '2026-10-31T11:00:00', company: c, customer: { name: 'بقالة النور' }, repName: 'أحمد',
  amount: 100, paymentMethod: 'CASH', notes: 'دفعة أكتوبر',
});
const texts = (over: Partial<PrintTextsV1>): PrintTextsV1 => ({ version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null, edits: {}, ...over });
const profile = (template: PrintProfile['template'], preset: 'roll58' | 'roll80'): PrintProfile =>
  ({ id: `p-${template}-${preset}`, name: 'x', printer: 'thermal', template, paper: presetPaper(preset)!, options: defaultPrintOptions('thermal') });

async function thermal(doc: InvoiceDoc | ReceiptDoc, opts: ThermalPrintOptions = {}): Promise<string> {
  let html = '';
  const o = { ...opts, capture: (h: string) => { html = h; } };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, o); else await printThermalReceipt(doc, o);
  assert.ok(html, 'لم تُلتقط وثيقة');
  return norm(html);
}
const a4 = (doc: InvoiceDoc) => renderToStaticMarkup(createElement(PrintableInvoice, { doc }));
const a4r = (doc: ReceiptDoc) => renderToStaticMarkup(createElement(PrintableReceipt, { doc }));

const NONE: Record<string, unknown> = {
  'غياب العمود': undefined, 'null': null, 'عطب': { version: 1, edits: 'x' }, 'نسخة أحدث': { version: 2 },
  'إعدادٌ فارغ': texts({}), 'تعديلٌ بلا أثر': texts({ edits: { 'inv.rep': { text: '  ', alt: null, hidden: false } } }),
};

test('بلا نصوص: الشريط الكلاسيكي والجديدان وA4 والسند حرفاً بحرف كورقةٍ بلا العمود', async () => {
  const base = { ...company };
  const renderers: [string, ThermalPrintOptions][] = [
    ['الكلاسيكي', {}], ['الملف الافتراضي', { profile: legacyThermalProfile() }],
    ['المختصر 80', { profile: profile('roll_compact', 'roll80'), tr: same }], ['المفصّل 80', { profile: profile('roll_detailed', 'roll80'), tr: same }],
  ];
  for (const [name, opts] of renderers) {
    const ref = await thermal(invoice(base), opts);
    const refR = await thermal(receipt(base), opts);
    for (const [why, raw] of Object.entries(NONE)) {
      const c = { ...base, printTexts: raw };
      assert.equal(await thermal(invoice(c), opts), ref, `${name} (${why}): الفاتورة تغيّرت`);
      assert.equal(await thermal(receipt(c), opts), refR, `${name} (${why}): السند تغيّر`);
    }
  }
  const refA4 = a4(invoice(base));
  const refA4r = a4r(receipt(base));
  for (const [why, raw] of Object.entries(NONE)) {
    assert.equal(a4(invoice({ ...base, printTexts: raw })), refA4, `A4 (${why}): الفاتورة تغيّرت`);
    assert.equal(a4r(receipt({ ...base, printTexts: raw })), refA4r, `A4 (${why}): السند تغيّر`);
  }
  // الكلاسيكي بلا نصوص يبقى كلاسيكياً (ض.ق.م و58mm auto)
  assert.ok(refA4.includes('شكرا لتعاملكم معنا'));
  const classic = await thermal(invoice(base));
  assert.ok(classic.includes('size: 58mm auto') && classic.includes('ض.ق.م'));
});

test('بنصوص: الكلاسيكي يصير «المختصر» على 58 مم، واللغة الثانية تحت العربي، والصياغة مُهرَّبة', async () => {
  const c = { ...company, printTexts: texts({
    secondLang: 'en', companyNameAlt: 'Test Trading Co.',
    edits: { 'cust.name': { text: 'العميل <b>&"', alt: 'Client', hidden: false }, 'inv.rep': { text: null, alt: null, hidden: true } },
  }) };
  const html = await thermal(invoice(c));
  assert.ok(!html.includes('58mm auto') && !html.includes('ض.ق.م'), 'ما زال الشريط الكلاسيكي');
  assert.ok(html.includes('@page { size: 58mm'), 'المختصر بمقاسٍ صالح على ورق 58 مم');
  assert.ok(html.includes('العميل &lt;b&gt;&amp;&quot;') && !html.includes('<b>&'), 'صياغة الشركة غير مُهرَّبة');
  assert.ok(html.includes('style="display:block;font-weight:400;font-size:0.85em;unicode-bidi:isolate">Client</span>'), 'اللغة الثانية ليست تحت العربي');
  assert.ok(html.includes('VAT No.'), 'ترجمة الطباعة للرقم الضريبي');
  assert.ok(html.includes('>Test Trading Co.<'), 'اسم الشركة باللغة الثانية');
  assert.ok(!html.includes('أحمد'), 'صفّ المندوب المخفيّ ما زال مطبوعاً');
  assert.ok(html.includes('ضريبة القيمة المضافة') || html.includes('منها ضريبة القيمة المضافة'));
});

test('الرول العريض (80 مم): اللغة الثانية بجانب العربي — ورؤوس الأعمدة تحته', async () => {
  const c = { ...company, printTexts: texts({ secondLang: 'en' }) };
  const html = await thermal(invoice(c), { profile: profile('roll_detailed', 'roll80'), tr: same });
  assert.ok(html.includes('margin-right:4px;unicode-bidi:isolate">Date</span>'), 'التاريخ ليس بجانب العربي');
  assert.ok(html.includes('<th class="l">الصنف<span dir="ltr" style="display:block'), 'رأس العمود ليس مكدّساً');
});

test('الإخفاء: الإلزامي لا يُخفى ولو حمله كائنٌ خام، و«القياسي» يبقى على الفاتورة القياسية', async () => {
  const raw = {
    version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null,
    edits: {
      'inv.number': { text: null, alt: null, hidden: true }, // zatca — يُهمل
      'tot.vat': { text: 'رسوم', alt: null, hidden: true }, // fixed — لا صياغة ولا إخفاء
      'cust.address': { text: null, alt: null, hidden: true }, // standard
      'tot.paid': { text: null, alt: null, hidden: true },
    },
  };
  const c = { ...company, printTexts: raw };
  const detailed = { profile: profile('roll_detailed', 'roll80'), tr: same };
  const simple = await thermal(invoice(c), detailed);
  assert.ok(simple.includes('INV-9100'), 'رقم الفاتورة أُخفي');
  assert.ok(!simple.includes('رسوم') && simple.includes('ضريبة القيمة المضافة'), 'عبارة الضريبة أعيدت صياغتها');
  assert.ok(!simple.includes('حي الملز'), 'عنوان المشتري ظاهرٌ على المبسّطة رغم إخفائه');
  assert.ok(!simple.includes('المدفوع'), 'المدفوع المخفيّ مطبوع');
  const standard = await thermal(invoice(c, { customer: { name: 'شركة المشتري', taxNumber: '311111111111113', address: 'حي الملز', city: 'الرياض' } }), detailed);
  assert.ok(standard.includes('حي الملز'), 'عنوان المشتري أُخفي من الفاتورة القياسية');
  const page = a4(invoice(c));
  assert.ok(page.includes('INV-9100') && !page.includes('رسوم') && !page.includes('حي الملز') && !page.includes('المدفوع'));
});

test('العنوان: صياغة الشركة لمستند المرحلة الأولى، وإخفاؤه — والمختوم يطبع عنوان القرار', async () => {
  const c = { ...company, printTexts: texts({ edits: { 'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false } } }) };
  assert.ok(a4(invoice(c)).includes('فاتورة مبيعات') && !a4(invoice(c)).includes('فاتورة ضريبية مبسطة'));
  assert.ok((await thermal(invoice(c))).includes('فاتورة مبيعات'));
  const stamped = sampleInvoiceDoc(c, same);
  assert.ok(stamped.zatca, 'النموذج مختوم');
  assert.ok(a4(stamped).includes('فاتورة ضريبية مبسطة') && !a4(stamped).includes('فاتورة مبيعات'), 'المختوم أخذ صياغة الشركة');
  assert.ok((await thermal(stamped, { profile: profile('roll_compact', 'roll80'), tr: same })).includes('فاتورة ضريبية مبسطة'));
  const hidden = { ...company, printTexts: texts({ edits: { 'inv.title': { text: null, alt: null, hidden: true } } }) };
  assert.ok(!a4(invoice(hidden)).includes('فاتورة ضريبية'), 'العنوان المخفيّ مطبوع');
  // المرتجع بمفتاحه
  const ret = { ...company, printTexts: texts({ edits: { 'inv.returnTitle': { text: 'مرتجع مبيعات', alt: null, hidden: false } } }) };
  assert.ok(a4(invoice(ret, { isReturn: true })).includes('مرتجع مبيعات'));
});

test('A4 بلغتين: الإنجليزية بجانب العربي، والإخفاء يُسقط الصفّ والعمود، وسطر المنصّة ثابت', () => {
  const c = { ...company, printTexts: texts({
    secondLang: 'en',
    edits: {
      'inv.type': { text: null, alt: null, hidden: true }, 'col.discount': { text: null, alt: null, hidden: true },
      'foot.thanks': { text: null, alt: null, hidden: true }, 'h.phone': { text: null, alt: null, hidden: true },
    },
  }) };
  const html = a4(invoice(c));
  assert.ok(html.includes('>Invoice number</span>') && html.includes('>VAT No.</span>'), 'الإنجليزية غائبة');
  assert.ok(!html.includes('النوع') && !html.includes('0501234567'), 'المخفيّ مطبوع');
  assert.ok(!html.includes('>الخصم') && !html.includes('10%'), 'عمود الخصم المخفيّ مطبوع');
  assert.ok(!html.includes('شكرا لتعاملكم معنا') && html.includes('صدرت عبر منصة'), 'التذييل');
  assert.ok(html.includes('الرقم الضريبي') && html.includes('300000000000003'), 'الرقم الضريبي للبائع');
  const r = a4r(receipt({ ...c, printTexts: texts({ secondLang: 'en', edits: { 'rcp.method': { text: null, alt: null, hidden: true } } }) }));
  assert.ok(r.includes('>Amount received</span>') && !r.includes('طريقة الدفع'));
});

test('معاينة المحرّر: كل نصٍّ قابلٌ للنقر، والمخفيّ مشطوبٌ حاضر', () => {
  const c = { ...company, printTexts: texts({ edits: { 'inv.rep': { text: null, alt: null, hidden: true } } }) };
  const html = renderToStaticMarkup(createElement(PrintTextsPreviewContext.Provider, { value: { onPick: () => {}, active: 'inv.number' } },
    createElement(PrintableInvoice, { doc: invoice(c) })));
  assert.ok(html.includes('data-pt-key="inv.number"') && html.includes('data-pt-key="col.item"') && html.includes('data-pt-key="h.taxNumber"'));
  assert.match(html, /data-pt-key="inv\.rep"[^>]*text-decoration:line-through/, 'المخفيّ ليس مشطوباً');
  assert.ok(html.includes('أحمد'), 'المخفيّ اختفى من المعاينة');
  assert.ok(!a4(invoice(c)).includes('data-pt-key'), 'سمة المعاينة في الطباعة الحقيقية');
});

test('بقية المستندات لا تتأثّر بالنصوص — وثيقة المعاينة الحرارية تُبنى بلا طباعة', async () => {
  const notice = (co: LoadNoticeDoc['company']): LoadNoticeDoc => ({ kind: 'loadNotice', company: co, repName: 'أحمد', date: '2026-10-31T09:00:00', movementKind: 'LOAD', items: [{ name: 'ماء', qty: 5 }] });
  const withTexts = { ...company, printTexts: texts({ secondLang: 'en', edits: { 'h.phone': { text: null, alt: null, hidden: true } } }) };
  assert.equal(
    renderToStaticMarkup(createElement(PrintableLoadNotice, { doc: notice(withTexts) })),
    renderToStaticMarkup(createElement(PrintableLoadNotice, { doc: notice({ ...company }) })),
  );
  const p58 = await thermalPreviewHtml(invoice(withTexts), { tr: same, paperMm: 58 });
  const p80 = await thermalPreviewHtml(receipt(withTexts), { tr: same, paperMm: 80 });
  assert.ok(p58.startsWith('<!DOCTYPE html>') && p58.includes('size: 58mm'));
  assert.ok(p80.includes('size: 80mm') && p80.includes('Receipt'));
  assert.ok((await thermalPreviewHtml(invoice({ ...company }), { tr: same, paperMm: 58 })).includes('58mm auto'), 'بلا نصوص: معاينة 58 مم هي الكلاسيكي');
});

test('مراجعة: إخفاء تسميات فواتير السند يُطبَّق في A4 والرول — ورقم الفاتورة يبقى', async () => {
  const hide = (keys: string[]) => texts({ edits: Object.fromEntries(keys.map((k) => [k, { text: null, alt: null, hidden: true }])) });
  const one: ReceiptDoc = { ...receipt({ ...company, printTexts: hide(['rcp.forInvoice']) }), invoices: [{ number: 'INV-9100', amount: 100 }] };
  const many: ReceiptDoc = { ...receipt({ ...company, printTexts: hide(['rcp.forInvoices', 'rcp.invoiceNo', 'rcp.credit']) }), amount: 300, invoices: [{ number: 'INV-1', amount: 100 }, { number: 'INV-2', amount: 50 }] };
  const roll = { profile: profile('roll_compact', 'roll80'), tr: same };
  for (const [name, html] of [['A4', a4r(one)], ['الرول', await thermal(one, roll)]] as const) {
    assert.ok(!html.includes('مقابل الفاتورة رقم') && html.includes('INV-9100'), `${name}: التسمية المخفية مطبوعة أو الرقم سقط`);
  }
  for (const [name, html] of [['A4', a4r(many)], ['الرول', await thermal(many, roll)]] as const) {
    assert.ok(!html.includes('مقابل الفواتير') && !html.includes('رصيد دائن للعميل') && !html.includes('فاتورة رقم'), `${name}: مخفيٌّ مطبوع`);
    assert.ok(html.includes('INV-1') && html.includes('INV-2'), `${name}: أرقام الفواتير سقطت`);
  }
});

test('مراجعة: صندوق العميل يسقط كلّه حين تُخفى صفوفه على المبسّطة — ويبقى على القياسية', () => {
  const allHidden = texts({ edits: Object.fromEntries(['cust.heading', 'cust.name', 'cust.phone', 'cust.address', 'cust.business', 'cust.commercialReg']
    .map((k) => [k, { text: null, alt: null, hidden: true }])) });
  const c = { ...company, printTexts: allHidden };
  assert.ok(!a4(invoice(c)).includes('background:#f8fafc'), 'صندوقٌ رماديٌّ فارغ');
  const std = a4(invoice(c, { customer: { name: 'شركة المشتري', taxNumber: '311111111111113' } }));
  assert.ok(std.includes('background:#f8fafc') && std.includes('311111111111113'), 'الرقم الضريبي للمشتري سقط من القياسية');
});

test('مراجعة: صياغة الشركة لسطر الشكر تسبق نصّ تذييل القالب — وبلا صياغةٍ نصّ القالب كما كان', async () => {
  const p = { ...profile('roll_compact', 'roll80'), options: { ...defaultPrintOptions('thermal'), footerText: 'نص القالب' } };
  const reworded = { ...company, printTexts: texts({ edits: { 'foot.thanks': { text: 'نشكر زيارتكم', alt: null, hidden: false } } }) };
  const plain = { ...company, printTexts: texts({ secondLang: 'en' }) };
  const r1 = await thermal(invoice(reworded), { profile: p, tr: same });
  assert.ok(r1.includes('نشكر زيارتكم') && !r1.includes('نص القالب'));
  const r2 = await thermal(invoice(plain), { profile: p, tr: same });
  assert.ok(r2.includes('نص القالب'));
});
