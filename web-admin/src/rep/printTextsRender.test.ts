/**
 * «نصوص المطبوعات» على الورق (طلب المالك ٣١ أكتوبر ٢٠٢٦) — العارضات نفسها تُرسم: الشريط الحراريّ عبر `capture` (الوثيقة التي
 * كانت ستُطبع) وقالبا A4 بـrenderToStaticMarkup.
 *
 * ١) بلا نصوص (غياب العمود أو null أو عطب أو نسخة أحدث أو إعدادٌ فارغ) ⇒ الورقة حرفاً بحرف — الكلاسيكي والجديدان وA4.
 * ٢) بنصوص ⇒ الشريط الكلاسيكي يصير «المختصر» على 58 مم، والصياغة مُهرَّبة، واللغة الثانية تحت العربي في الضيّق وبجانبه في العريض.
 * ٣) الحذف (طلب المالك ٣ نوفمبر ٢٠٢٦): كل سطرٍ يُحذف بقيمته — ومنه ما كان إلزامياً — على المبسّطة والقياسية، وكل عبارةٍ تُصاغ.
 * ٤) العنوان: صياغة الشركة وحذفه في المرحلتين، والرمز المختوم باقٍ.
 * ٥) معاينة المحرّر: كل نصٍّ قابلٌ للنقر، والمخفيّ مشطوبٌ حاضر — وبقية المستندات (الإشعارات): ترويستها وحدها تتبع النصوص.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { printThermalInvoice, printThermalReceipt, thermalPreviewHtml, type ThermalPrintOptions } from './thermal';
import { PrintableInvoice, PrintableLoadNotice, PrintableReceipt, invoiceDocFromDetail, type InvoiceDoc, type LoadNoticeDoc, type ReceiptDoc } from './RepDocuments';
import { PrintTextsPreviewContext } from './printTextsContext';
import { defaultPrintOptions, legacyThermalProfile, newProfile, presetPaper, withDesign, type PrintProfile } from '../lib/print/printSettings';
import { PrintLookContext, lookFor } from './printLook';
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

test('الحذف بلا قفل (طلب المالك ٣ نوفمبر ٢٠٢٦): كل سطرٍ يُحذف بقيمته ولو كان إلزامياً، وعلى القياسية أيضاً — والصياغة لكل عبارة', async () => {
  const raw = {
    version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null,
    edits: {
      'inv.number': { text: null, alt: null, hidden: true }, // كان zatca — يُحذف السطر برقمه
      'tot.vatIncl': { text: 'رسوم', alt: null, hidden: true }, // كان fixed — يُحذف صفّه
      'cust.address': { text: null, alt: null, hidden: true }, // كان standard — يُحذف على القياسية أيضاً
      'tot.paid': { text: null, alt: null, hidden: true },
    },
  };
  const c = { ...company, printTexts: raw };
  const detailed = { profile: profile('roll_detailed', 'roll80'), tr: same };
  const simple = await thermal(invoice(c), detailed);
  assert.ok(!simple.includes('INV-9100'), 'سطر رقم الفاتورة المحذوف ما زال مطبوعاً');
  assert.ok(!simple.includes('رسوم') && !simple.includes('منها ضريبة القيمة المضافة'), 'صفّ الضريبة المحذوف مطبوع');
  assert.ok(!simple.includes('حي الملز'), 'عنوان المشتري ظاهرٌ على المبسّطة رغم حذفه');
  assert.ok(!simple.includes('المدفوع'), 'المدفوع المحذوف مطبوع');
  const standard = await thermal(invoice(c, { customer: { name: 'شركة المشتري', taxNumber: '311111111111113', address: 'حي الملز', city: 'الرياض' } }), detailed);
  assert.ok(!standard.includes('حي الملز') && standard.includes('311111111111113'), 'الحذف لم يسرِ على القياسية أو أسقط ما لم يُحذف');
  const page = a4(invoice(c));
  assert.ok(!page.includes('INV-9100') && !page.includes('رسوم') && !page.includes('حي الملز') && !page.includes('المدفوع'));
  assert.ok(page.includes('الإجمالي النهائي') && page.includes('المتبقي'), 'صفوف الإجمالي غير المحذوفة سقطت');
  // الصياغة: ما كان مقفلاً (zatca وfixed) يُعاد صياغته الآن
  const reworded = { ...company, printTexts: texts({ edits: {
    'inv.number': { text: 'رقم المستند', alt: null, hidden: false }, 'tot.vatIncl': { text: 'الضريبة المضمّنة', alt: null, hidden: false },
  } }) };
  for (const html of [a4(invoice(reworded)), await thermal(invoice(reworded), detailed)]) {
    assert.ok(html.includes('رقم المستند') && html.includes('INV-9100'), 'صياغة رقم الفاتورة لم تُطبَّق');
    assert.ok(html.includes('الضريبة المضمّنة') && !html.includes('منها ضريبة القيمة المضافة'), 'صياغة عبارة الضريبة لم تُطبَّق');
  }
});

test('العنوان: صياغة الشركة وحذفه في المرحلتين (طلب المالك ٣ نوفمبر ٢٠٢٦) — والرمز المختوم باقٍ', async () => {
  const c = { ...company, printTexts: texts({ edits: { 'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false } } }) };
  assert.ok(a4(invoice(c)).includes('فاتورة مبيعات') && !a4(invoice(c)).includes('فاتورة ضريبية مبسطة'));
  assert.ok((await thermal(invoice(c))).includes('فاتورة مبيعات'));
  const stamped = sampleInvoiceDoc(c, same);
  assert.ok(stamped.zatca, 'النموذج مختوم');
  assert.ok(a4(stamped).includes('فاتورة مبيعات') && !a4(stamped).includes('فاتورة ضريبية مبسطة'), 'المختوم لم يأخذ صياغة الشركة');
  assert.ok(a4(stamped).includes('alt="QR"'), 'الرمز المختوم سقط مع الصياغة');
  const rollStamped = await thermal(stamped, { profile: profile('roll_compact', 'roll80'), tr: same });
  assert.ok(rollStamped.includes('فاتورة مبيعات') && !rollStamped.includes('فاتورة ضريبية مبسطة'));
  const hidden = { ...company, printTexts: texts({ edits: { 'inv.title': { text: null, alt: null, hidden: true } } }) };
  assert.ok(!a4(invoice(hidden)).includes('فاتورة ضريبية'), 'العنوان المحذوف مطبوع');
  const stampedHidden = sampleInvoiceDoc(hidden, same);
  // («ليست فاتورة ضريبية» في علامة بيئة المحاكاة ليست العنوان — قرار الطباعة يبقى)
  assert.ok(!a4(stampedHidden).includes('فاتورة ضريبية مبسطة') && a4(stampedHidden).includes('alt="QR"'), 'المختوم: العنوان المحذوف مطبوع أو الرمز سقط');
  // المرتجع بمفتاحه
  const ret = { ...company, printTexts: texts({ edits: { 'inv.returnTitle': { text: 'مرتجع مبيعات', alt: null, hidden: false } } }) };
  assert.ok(a4(invoice(ret, { isReturn: true })).includes('مرتجع مبيعات'));
});

test('العنوان المحفوظ قبل ٣ نوفمبر ٢٠٢٦ يسري على المختوم تلقائياً (قرار المالك ٣ نوفمبر ٢٠٢٦) — A4 والرول والقالب ثنائي اللغة، والرمز باقٍ', async () => {
  for (const edit of [{ text: 'فاتورة مبيعات', alt: null, hidden: false }, { text: null, alt: null, hidden: true }]) {
    const c = { ...company, printTexts: texts({ edits: { 'inv.title': edit } }) };
    const tag = JSON.stringify(edit);
    const reworded = edit.text !== null;
    const p1 = a4(invoice(c));
    assert.ok(!p1.includes('فاتورة ضريبية مبسطة') && p1.includes('فاتورة مبيعات') === reworded, `المرحلة الأولى لم تأخذ تعديلها ${tag}`);
    const stamped = sampleInvoiceDoc(c, same);
    assert.ok(stamped.zatca, 'النموذج مختوم');
    const page = a4(stamped);
    assert.ok(!page.includes('فاتورة ضريبية مبسطة') && page.includes('فاتورة مبيعات') === reworded, `A4 المختوم لم يأخذ التعديل المحفوظ ${tag}`);
    assert.ok(page.includes('alt="QR"'), `A4 المختوم بلا الرمز ${tag}`);
    const roll = await thermal(stamped, { profile: profile('roll_compact', 'roll80'), tr: same });
    assert.ok(!roll.includes('فاتورة ضريبية مبسطة') && roll.includes('فاتورة مبيعات') === reworded, `الرول المختوم لم يأخذ التعديل المحفوظ ${tag}`);
    assert.ok(roll.includes('class="qr"'), `الرول المختوم بلا الرمز ${tag}`);
    const grid = renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: lookFor(withDesign(newProfile('page', 'preview', []), 'grid_bilingual')) }, createElement(PrintableInvoice, { doc: stamped })));
    assert.ok(!grid.includes('فاتورة ضريبية مبسطة') && grid.includes('فاتورة مبيعات') === reworded, `ثنائي اللغة: المختوم لم يأخذ التعديل المحفوظ ${tag}`);
    assert.ok(grid.includes('alt="QR"'), `ثنائي اللغة: المختوم بلا الرمز ${tag}`);
  }
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

test('بقية المستندات: ترويستها وحدها تتبع النصوص وجسمها كما هو — وثيقة المعاينة الحرارية تُبنى بلا طباعة', async () => {
  const notice = (co: LoadNoticeDoc['company']): LoadNoticeDoc => ({ kind: 'loadNotice', company: co, repName: 'أحمد', date: '2026-10-31T09:00:00', movementKind: 'LOAD', items: [{ name: 'ماء', qty: 5 }] });
  const withTexts = { ...company, printTexts: texts({ secondLang: 'en', edits: { 'h.phone': { text: null, alt: null, hidden: true } } }) };
  // C-G7: الهاتف المحذوف يسقط من ترويسة الإشعار وتسمياتها بلغتين — وما بعد الترويسة حرفاً بحرف
  const body = (h: string) => h.slice(h.indexOf('<div style="display:flex;justify-content:space-between;gap:14px'));
  const on = renderToStaticMarkup(createElement(PrintableLoadNotice, { doc: notice(withTexts) }));
  const off = renderToStaticMarkup(createElement(PrintableLoadNotice, { doc: notice({ ...company }) }));
  assert.ok(off.includes('0501234567') && !on.includes('0501234567'), 'الهاتف المحذوف بقي في ترويسة الإشعار');
  assert.ok(on.includes('VAT No.') && !off.includes('VAT No.'), 'تسمية الترويسة بلا لغتها الثانية');
  assert.equal(body(on), body(off), 'جسم الإشعار تغيّر');
  const p58 = await thermalPreviewHtml(invoice(withTexts), { tr: same, paperMm: 58 });
  const p80 = await thermalPreviewHtml(receipt(withTexts), { tr: same, paperMm: 80 });
  assert.ok(p58.startsWith('<!DOCTYPE html>') && p58.includes('size: 58mm'));
  assert.ok(p80.includes('size: 80mm') && p80.includes('Receipt'));
  assert.ok((await thermalPreviewHtml(invoice({ ...company }), { tr: same, paperMm: 58 })).includes('58mm auto'), 'بلا نصوص: معاينة 58 مم هي الكلاسيكي');
});

test('حذف سطور فواتير السند في A4 والرول: السطر كلّه (التسمية ورقم الفاتورة)، والقائمة كلّها بعنوانها — والمبلغ باقٍ', async () => {
  const hide = (keys: string[]) => texts({ edits: Object.fromEntries(keys.map((k) => [k, { text: null, alt: null, hidden: true }])) });
  const one: ReceiptDoc = { ...receipt({ ...company, printTexts: hide(['rcp.forInvoice']) }), invoices: [{ number: 'INV-9100', amount: 100 }] };
  const manyDoc = (t: PrintTextsV1): ReceiptDoc => ({ ...receipt({ ...company, printTexts: t }), amount: 300, invoices: [{ number: 'INV-1', amount: 100 }, { number: 'INV-2', amount: 50 }] });
  const roll = { profile: profile('roll_compact', 'roll80'), tr: same };
  for (const [name, html] of [['A4', a4r(one)], ['الرول', await thermal(one, roll)]] as const) {
    assert.ok(!html.includes('مقابل الفاتورة رقم') && !html.includes('INV-9100'), `${name}: سطر الفاتورة المحذوف ما زال مطبوعاً`);
    assert.ok(html.includes('100.00') || html.includes('100'), `${name}: المبلغ سقط`);
  }
  // «مقابل الفواتير» عنوان قائمة (block): يُسقطها بأرقامها؛ وحذف «فاتورة رقم» والرصيد الدائن يُسقط صفوفهما وحدها
  for (const [name, html] of [['A4', a4r(manyDoc(hide(['rcp.forInvoices'])))], ['الرول', await thermal(manyDoc(hide(['rcp.forInvoices'])), roll)]] as const) {
    assert.ok(!html.includes('مقابل الفواتير') && !html.includes('INV-1') && !html.includes('INV-2'), `${name}: قائمة الفواتير المحذوفة مطبوعة`);
  }
  const rows = a4r(manyDoc(hide(['rcp.invoiceNo', 'rcp.credit'])));
  assert.ok(rows.includes('مقابل الفواتير') && !rows.includes('فاتورة رقم') && !rows.includes('INV-1') && !rows.includes('رصيد دائن للعميل'), 'A4: صفوف الفواتير المحذوفة');
});

test('صندوق العميل: حذف صفوفه يُسقطها وحدها (والرقم الضريبي للقياسية باقٍ)، وحذف عنوانه يُسقط الصندوق كلّه ولو قياسية', () => {
  const del = (keys: string[]) => texts({ edits: Object.fromEntries(keys.map((k) => [k, { text: null, alt: null, hidden: true }])) });
  const rowsOnly = { ...company, printTexts: del(['cust.name', 'cust.phone', 'cust.address', 'cust.business', 'cust.commercialReg']) };
  const simple = a4(invoice(rowsOnly));
  assert.ok(!simple.includes('بقالة النور') && !simple.includes('حي الملز'), 'المبسّطة: صفوف العميل المحذوفة مطبوعة');
  const stdCustomer = { customer: { name: 'شركة المشتري', taxNumber: '311111111111113' } };
  const std = a4(invoice(rowsOnly, stdCustomer));
  assert.ok(std.includes('background:#f8fafc') && std.includes('311111111111113') && !std.includes('شركة المشتري'), 'القياسية: الصفّ الباقي سقط أو المحذوف بقي');
  const block = a4(invoice({ ...company, printTexts: del(['cust.heading']) }, stdCustomer));
  assert.ok(!block.includes('بيانات العميل') && !block.includes('311111111111113') && !block.includes('شركة المشتري'), 'عنوان الصندوق المحذوف لم يُسقط الصندوق');
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

test('الإشعار الدائن: مرجع الفاتورة الأصلية وسبب الإرجاع على A4 والكلاسيكي والجديدين — ومستندٌ بلا مرجع كما كان حرفاً بحرف', async () => {
  const base = { ...company };
  const ret = (c: InvoiceDoc['company'], extra?: Partial<InvoiceDoc>) => invoice(c, { isReturn: true, number: 'RET-2610-000007', ...extra });
  const note = (c: InvoiceDoc['company']) => ret(c, { billingReference: 'OLD-2024/0115 <x>', noteReason: 'بضاعة تالفة & مكسورة' });
  // A4: الصفّان في صندوق بيانات المرتجع، والمرجع باتجاهه اللاتينيّ، والقيمتان مُهرَّبتان
  const page = a4(note(base));
  assert.ok(page.includes('الفاتورة الأصلية: </span>') && page.includes('سبب الإرجاع: </span>'), 'التسميتان غائبتان');
  assert.ok(page.includes('<span dir="ltr" style="unicode-bidi:isolate">OLD-2024/0115 &lt;x&gt;</span>'), 'المرجع ليس باتجاهه');
  assert.ok(page.includes('بضاعة تالفة &amp; مكسورة') && !page.includes('<x>'));
  assert.ok(page.indexOf('RET-2610-000007') < page.indexOf('الفاتورة الأصلية') && page.indexOf('الفاتورة الأصلية') < page.indexOf('سبب الإرجاع'));
  // بلا مرجع (غياب، null، فراغ) ⇒ ورقة المرتجع كما كانت؛ وفاتورة البيع لا تطبعهما ولو حملتهما
  const plainA4 = a4(ret(base));
  for (const extra of [{ billingReference: null, noteReason: null }, { billingReference: '  ', noteReason: '' }]) {
    assert.equal(a4(ret(base, extra)), plainA4, JSON.stringify(extra));
  }
  assert.equal(a4(invoice(base, { billingReference: 'X-1', noteReason: 'سبب' })), a4(invoice(base)), 'فاتورة البيع تغيّرت');
  // الحرارية بلا نصوص: الكلاسيكي والجديدان
  const renderers: [string, ThermalPrintOptions][] = [
    ['الكلاسيكي', {}], ['المختصر 58', { profile: profile('roll_compact', 'roll58'), tr: same }],
    ['المختصر 80', { profile: profile('roll_compact', 'roll80'), tr: same }], ['المفصّل 80', { profile: profile('roll_detailed', 'roll80'), tr: same }],
  ];
  for (const [name, opts] of renderers) {
    const html = await thermal(note(base), opts);
    assert.ok(html.includes('<span>الفاتورة الأصلية</span><span dir="ltr">OLD-2024/0115 &lt;x&gt;</span>'), `${name}: المرجع`);
    assert.ok(html.includes('<span>سبب الإرجاع</span><span>بضاعة تالفة &amp; مكسورة</span>'), `${name}: السبب`);
    assert.equal(await thermal(ret(base, { billingReference: null, noteReason: ' ' }), opts), await thermal(ret(base), opts), `${name}: المرتجع بلا مرجع تغيّر`);
  }
  // بنصوص الشركة: الصياغة واللغة الثانية تُطبَّقان — والحذف (طلب المالك ٣ نوفمبر ٢٠٢٦) يُسقط السطر بقيمته ولو كان إلزامياً على الإشعار
  const edited = (originalRefHidden: boolean, reasonHidden: boolean) => ({ ...company, printTexts: {
    version: 1, secondLang: 'en', companyNameAlt: null, companyAddressAlt: null,
    edits: {
      'inv.originalRef': { text: 'رقم الفاتورة المرتجع منها', alt: 'Original invoice no.', hidden: originalRefHidden },
      'inv.noteReason': { text: null, alt: null, hidden: reasonHidden },
    },
  } });
  const sheets = async (c: InvoiceDoc['company']) => [
    ['A4', a4(note(c))],
    ['المختصر 58', await thermal(note(c))],
    ['المفصّل 80', await thermal(note(c), { profile: profile('roll_detailed', 'roll80'), tr: same })],
  ] as const;
  for (const [name, html] of await sheets(edited(false, false))) {
    assert.ok(html.includes('رقم الفاتورة المرتجع منها') && html.includes('Original invoice no.'), `${name}: صياغة الشركة`);
    assert.ok(html.includes('OLD-2024/0115 &lt;x&gt;'), `${name}: المرجع سقط`);
    assert.ok(html.includes('سبب الإرجاع') && html.includes('بضاعة تالفة &amp; مكسورة'), `${name}: السبب سقط`);
  }
  for (const [name, html] of await sheets(edited(true, true))) {
    assert.ok(!html.includes('رقم الفاتورة المرتجع منها') && !html.includes('OLD-2024/0115'), `${name}: سطر المرجع المحذوف مطبوع`);
    assert.ok(!html.includes('سبب الإرجاع') && !html.includes('بضاعة تالفة'), `${name}: سطر السبب المحذوف مطبوع`);
    assert.ok(html.includes('RET-2610-000007'), `${name}: رقم المرتجع سقط`);
  }
});

test('invoiceDocFromDetail: مرجع الفاتورة الأصلية وسببه من صفّ الخادم إلى الورقة (إعادة الطباعة واللوحة و/m) — وغيابهما null', () => {
  const row = (extra: Record<string, unknown>) => ({
    number: 'RET-2610-000007', invoiceDate: '2026-10-31T10:30:00', type: 'RETURN', customer: { name: 'بقالة النور' },
    subtotal: 10, discountAmt: 0, taxAmt: 1.3, total: 10, paidAmt: 0, remainingAmt: 0,
    items: [{ product: { name: 'ماء', unit: 'كرتون' }, qty: 1, unitPrice: 10, discountPct: 0, taxPct: 15, lineTotal: 10 }], ...extra,
  });
  const doc = invoiceDocFromDetail(row({ billingReference: 'OLD-2024/0115', noteReason: 'بضاعة تالفة' }), 'أحمد', { ...company });
  assert.deepEqual([doc.isReturn, doc.billingReference, doc.noteReason], [true, 'OLD-2024/0115', 'بضاعة تالفة']);
  assert.ok(a4(doc).includes('OLD-2024/0115') && a4(doc).includes('بضاعة تالفة'));
  for (const extra of [{}, { billingReference: null, noteReason: null }, { billingReference: 7, noteReason: {} }]) {
    const d = invoiceDocFromDetail(row(extra), 'أحمد', { ...company });
    assert.deepEqual([d.billingReference, d.noteReason], [null, null], JSON.stringify(extra));
    assert.ok(!a4(d).includes('الفاتورة الأصلية'));
  }
});
