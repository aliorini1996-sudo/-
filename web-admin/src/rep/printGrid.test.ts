/**
 * القالب «كلاسيكي بإطارات — ثنائي اللغة» (rep/printGrid.tsx — pl_spec v2 §B1، الحزمة P5):
 *
 * ١) تسميات بلغتين: العربي أولاً والإنجليزي من `pt.en` في الترويسة والصناديق ورؤوس الجدول والإجماليات والتواقيع.
 * ٢) «حذف السطر»: كل مفتاحٍ يرسمه القالب يُسقط وحدته كاملة (العربي والإنجليزي والقيمة / العمود / صفّ الإجمالي / الخانة / الصندوق)
 *    ولا يمسّ وحدةً أخرى خارجها — وفي المعاينة لا يُحذف بل يُشطب ويبقى قابلاً للنقر.
 * ٣) فجوات البيانات تُسقط صفوفها، وعمود «رقم الصنف» يسقط حين لا رمز لأيّ بند.
 * ٤) أحادي اللون (page_plain والنقطية بـlookFor) ⇒ لا لون في أنماط العناصر إلا الأسود والأبيض.
 * ٥) رمز QR عقدةٌ ممرَّرة: يُطبع متى مُرِّر ولو حُذفت كل النصوص، ولا رمز في سند القبض.
 * ٦) حرّاس المصدر: لا بناء رمز ولا قيمة رمز ولا تباعد أحرف ولا نصّ ملاحظة المشتري، ولا استيراد تشغيليّ من RepDocuments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GRID_INVOICE_KEYS, GRID_RECEIPT_KEYS, GridInvoice, GridReceipt, type GridInvoiceFacts } from './printGrid';
import type { InvoiceDoc, ReceiptDoc } from './RepDocuments';
import { DEFAULT_PRINT_LOOK, lookFor, type PrintLook } from './printLook';
import { zatcaPrintDecision } from '../lib/zatca/docPrint';
import { makePrintTexts, phraseIn, type PrintTexts, type PrintTextsPreview } from '../lib/print/printTexts';
import { printTextEntry } from '../lib/print/printTextsCore';
import { DEFAULT_SECTIONS, type ResolvedLayout } from '../lib/print/layout';
import { defaultPrintOptions, presetPaper, type PrintProfile } from '../lib/print/printSettings';

// ─── محلِّل نصوص مزيّف بعقد C(ii) — مستقلٌّ عن تقدّم الحزمة P2 (المحلِّل الحقيقيّ يُختبر في printTexts.test.ts) ───
function fakePt(o: { deleted?: readonly string[]; edits?: Record<string, string>; preview?: PrintTextsPreview | null } = {}): PrintTexts {
  const deleted = new Set(o.deleted ?? []);
  const edits = o.edits ?? {};
  const preview = o.preview ?? null;
  const text = (k: string, ar: string) => edits[k] ?? ar;
  const pt = {
    on: true, tr: (s: string) => s, lang: null,
    hidden: (k: string) => !preview && deleted.has(k),
    hiddenInSettings: (k: string) => deleted.has(k),
    text,
    alt: () => null,
    valueAlt: () => null,
    title: (decided: string, t: { isReturn: boolean }) => {
      const k = t.isReturn ? 'inv.returnTitle' : 'inv.title';
      return !preview && deleted.has(k) ? { text: '', alt: null } : { text: text(k, decided), alt: null };
    },
    companyNameAlt: null, companyAddressAlt: null, preview,
    en: (k: string, ar: string) => (deleted.has(k) && !preview ? null
      : phraseIn(text(k, ar), 'en') ?? phraseIn(printTextEntry(k)?.ar ?? ar, 'en') ?? null),
    warning: () => null,
  };
  return pt as unknown as PrintTexts;
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const company = {
  name: 'مؤسسة مروج الخليج للتجارة', address: 'حي السلي، شارع الخرج', taxNumber: '300123456700003', commercialReg: '1010456789',
  phone: '0551234567', email: 'info@murouj.sa', logo: PNG, countryCode: 'SA', primaryColor: '#0F766E',
  addrCity: 'الرياض', addrPostalCode: '14322',
};
const customer = {
  name: 'سوبرماركت النخبة', businessName: 'مؤسسة النخبة', commercialReg: '1010999888', taxNumber: '310987654300003',
  phone: '0500000000', address: 'طريق أنس بن مالك', district: 'حي الملقا', city: 'جدة', postalCode: '13524',
};
const items = [
  { name: 'مياه نوفا 330 مل', code: 'P-1001', unit: 'كرتون', multiUnit: true, qty: 5, unitPrice: 16.675, discountPct: 0, taxPct: 15, lineTotal: 83.38, taxAmt: 10.88 },
  { name: 'عصير برتقال', code: 'P-1002', unit: 'حبة', multiUnit: true, qty: 12.5, unitPrice: 4.6, discountPct: 10, taxPct: 15, lineTotal: 51.75, taxAmt: 6.75 },
];
const invoice = (extra: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', number: 'SI-2026-004817', date: '2026-11-03T10:42:00', type: 'CREDIT', paymentPlan: 'INSTALLMENT',
  installments: [{ seq: 1, dueDate: '2026-12-01', amount: 60 }, { seq: 2, dueDate: '2027-01-01', amount: 75.13 }],
  deliveryDate: '2026-11-04', recipientSignature: PNG, repSignature: PNG,
  company: company as InvoiceDoc['company'], customer: customer as InvoiceDoc['customer'], repName: 'خالد العتيبي',
  items: items as InvoiceDoc['items'],
  subtotal: 120, discount: 2.6, tax: 17.63, total: 135.13, pricesIncludeTax: true, paidAmt: 35.13, remainingAmt: 100,
  ...extra,
});
const returnDoc = () => invoice({ isReturn: true, billingReference: 'SI-2026-000100', noteReason: 'تلف في العبوة', paymentPlan: null, installments: [] });
const receipt = (extra: Partial<ReceiptDoc> = {}): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-77', date: '2026-11-03T11:00:00', company: company as ReceiptDoc['company'],
  customer: customer as ReceiptDoc['customer'], repName: 'خالد العتيبي', amount: 300, paymentMethod: 'CASH', notes: 'دفعة نوفمبر',
  invoices: [{ number: 'SI-1', amount: 100 }, { number: 'SI-2', amount: 150 }],
  ...extra,
});

const layout = (o: Partial<ResolvedLayout> = {}): ResolvedLayout => ({
  design: 'grid_bilingual', logo: 'center', logoSize: 'm', accent: null, tableStyle: 'grid', fontScale: 1,
  order: DEFAULT_SECTIONS.grid, printer: 'page', ...o,
} as ResolvedLayout);
const QR = createElement('div', { 'data-test-qr': '1' }, createElement('img', { alt: 'QR', src: PNG }));

function factsFor(doc: InvoiceDoc, pt: PrintTexts): GridInvoiceFacts {
  const zDecision = zatcaPrintDecision({ isReturn: !!doc.isReturn, buyerHasTaxNumber: !!doc.customer.taxNumber, saudi: true }, doc.zatca);
  return {
    pt, zDecision, title: pt.title(zDecision.title, { isReturn: !!doc.isReturn, phase2: false }),
    inclusiveDoc: !!doc.pricesIncludeTax, vatRate: '15%',
    noteRefs: doc.isReturn ? { ref: doc.billingReference ?? null, reason: doc.noteReason ?? null } : { ref: null, reason: null },
  };
}
const gridInv = (doc: InvoiceDoc, pt: PrintTexts, o: { look?: PrintLook; lay?: ResolvedLayout; qr?: ReactNode | null } = {}) =>
  renderToStaticMarkup(createElement(GridInvoice, {
    doc, facts: factsFor(doc, pt), look: o.look ?? DEFAULT_PRINT_LOOK, layout: o.lay ?? layout(), qr: o.qr === undefined ? QR : o.qr,
  }));
const gridRcp = (doc: ReceiptDoc, pt: PrintTexts, o: { look?: PrintLook } = {}) =>
  renderToStaticMarkup(createElement(GridReceipt, {
    doc, pt, title: { text: pt.hidden('rcp.title') ? '' : pt.text('rcp.title', 'سند قبض'), alt: null },
    look: o.look ?? DEFAULT_PRINT_LOOK, layout: layout(),
  }));

/** عدد العناصر التي تحمل المفتاح في `data-line` (قائمة مفاتيح مفصولة بمسافة) */
function lineCounts(html: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const [, v] of html.matchAll(/data-line="([^"]*)"/g)) for (const k of v.split(' ')) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/** المفاتيح التي تقع وحداتها داخل وحدة المفتاح (الصندوق والأزواج) — حذفه يُسقطها معه */
const INSIDE: Record<string, readonly string[]> = {
  'inv.infoHeading': ['inv.number', 'inv.date', 'inv.time', 'inv.paymentType', 'inv.deliveryDate', 'inv.rep'],
  'inv.returnInfoHeading': ['inv.returnNumber', 'inv.date', 'inv.time', 'inv.deliveryDate', 'inv.originalRef', 'inv.noteReason', 'inv.rep'],
  'inv.date': ['inv.time'],
  'cust.heading': ['cust.name', 'cust.business', 'cust.address', 'cust.city', 'cust.postalCode', 'cust.commercialReg', 'cust.taxNumber'],
  'sel.heading': ['sel.name', 'sel.address', 'sel.city', 'sel.postalCode', 'sel.taxNumber'],
  'col.price': ['col.priceIncl'], 'col.priceIncl': ['col.price'],
  'col.vatAmount': ['col.tax'],
  'tot.vat': ['tot.vatIncl'], 'tot.vatIncl': ['tot.vat'], 'tot.due': ['tot.grand'], 'tot.grand': ['tot.due'],
  'inst.heading': ['inst.dueDate', 'inst.amount', 'inst.sum', 'inst.note'],
  'inst.sum': ['inst.amount'],
  'rcp.date': ['rcp.time'],
  'rcp.customerHeading': ['rcp.from', 'rcp.business', 'rcp.commercialReg', 'rcp.taxNumber', 'rcp.phone', 'rcp.address'],
  'rcp.forInvoices': ['rcp.invoiceNo'],
};

function assertWholeLine(name: string, render: (pt: PrintTexts) => string, keys: readonly string[]) {
  const base = render(fakePt());
  const before = lineCounts(base);
  for (const k of keys) {
    assert.ok((before.get(k) ?? 0) > 0, `${name}: «${k}» غير مرسوم في الورقة الكاملة`);
    const after = lineCounts(render(fakePt({ deleted: [k] })));
    assert.equal(after.get(k) ?? 0, 0, `${name}: حذف «${k}» أبقى من وحدته شيئاً`);
    for (const [j, n] of before) {
      if (j === k || INSIDE[k]?.includes(j)) continue;
      // inst.sum يحمل خليّة مبلغ المجموع (inst.amount) — حذفه يُنقصها واحدة
      assert.equal(after.get(j) ?? 0, n, `${name}: حذف «${k}» غيّر وحدة «${j}»`);
    }
  }
}

test('ثنائي اللغة: العربي أولاً والإنجليزي من pt.en في كل قسم', () => {
  const html = gridInv(invoice(), fakePt());
  // الترويسة: الاسم بالعربية والإنجليزية (اسم الشركة بلا ترجمة ⇒ لا سطر إنجليزي مخترَع) والبلد
  assert.match(html, /مؤسسة مروج الخليج للتجارة/);
  assert.match(html, /المملكة العربية السعودية - الرياض/);
  assert.match(html, /Saudi Arabia/);
  // العنوان بلغتين
  assert.match(html, /فاتورة ضريبية/);
  assert.match(html, /Tax Invoice/);
  // كل تسمية إنجليزية متاحة في القاموس تُطبع بجانب عربيّها
  let checked = 0;
  for (const [k, def] of [
    ['inv.number', 'رقم الفاتورة'], ['col.code', 'رقم الصنف'], ['sel.postalCode', 'الرمز البريدي'], ['cust.taxNumber', 'الرقم الضريبي'],
    ['sig.remarks', 'ملاحظات وتعليمات'], ['col.qty', 'الكمية'], ['col.total', 'الإجمالي'], ['tot.vat', 'ضريبة القيمة المضافة'],
  ] as const) {
    const en = phraseIn(def, 'en');
    if (!en) continue;
    checked++;
    assert.ok(html.includes(en.replace(/&/g, '&amp;')), `«${k}»: الإنجليزي «${en}» غائب`);
    assert.ok(html.includes(def), `«${k}»: العربي «${def}» غائب`);
  }
  assert.ok(checked >= 5, `ترجماتٌ إنجليزية قليلة (${checked})`);
  // قيمة طريقة الدفع بلغتين، والكمية بأربع خانات على الأكثر وأرقام لاتينية، والعملة SAR
  assert.match(html, /آجل|تقسيط/);
  assert.match(html, />12\.5</);
  assert.match(html, />SAR</);
  // الإنجليزي والأرقام معزولة اتجاهاً
  assert.match(html, /dir="ltr"[^>]*unicode-bidi:isolate/);
});

test('«حذف السطر» في الفاتورة: كل مفتاحٍ يُسقط وحدته كاملة ولا يمسّ غيرها', () => {
  const saleKeys = GRID_INVOICE_KEYS.filter((k) => ![
    'inv.returnTitle', 'inv.returnInfoHeading', 'inv.returnNumber', 'inv.originalRef', 'inv.noteReason', 'tot.returnGrand', 'tot.subtotal',
  ].includes(k));
  assertWholeLine('بيع', (pt) => gridInv(invoice(), pt), saleKeys);
  assertWholeLine('مرتجع', (pt) => gridInv(returnDoc(), pt),
    ['inv.returnTitle', 'inv.returnInfoHeading', 'inv.returnNumber', 'inv.originalRef', 'inv.noteReason', 'tot.returnGrand']);
  // سند التسليم بخصمٍ: المجموع قبل الخصم بلا تفصيل ضريبة
  const delivery = invoice({ zatca: undefined });
  const asDelivery = (pt: PrintTexts) => renderToStaticMarkup(createElement(GridInvoice, {
    doc: delivery, facts: { ...factsFor(delivery, pt), zDecision: { ...factsFor(delivery, pt).zDecision, showTaxBreakdown: false } },
    look: DEFAULT_PRINT_LOOK, layout: layout(), qr: null,
  }));
  assertWholeLine('سند تسليم', asDelivery, ['tot.subtotal']);
});

test('«حذف السطر» يُسقط العربي والإنجليزي والقيمة معاً — أمثلة بقيمها', () => {
  const full = gridInv(invoice(), fakePt());
  const cases: [string, string[]][] = [
    ['cust.postalCode', ['13524']],
    ['sel.postalCode', ['14322']],
    ['sel.taxNumber', ['300123456700003']],
    ['col.code', ['P-1001', 'P-1002', phraseIn('رقم الصنف', 'en') ?? 'Item Code']],
    ['col.vatAmount', ['10.88', '6.75']],
    ['inv.time', ['10:42']],
    ['foot.platform', ['Field Sales']],
  ];
  for (const [k, needles] of cases) {
    const h = gridInv(invoice(), fakePt({ deleted: [k] }));
    for (const n of needles) {
      assert.ok(full.includes(n), `«${n}» غير مطبوع أصلاً`);
      assert.ok(!h.includes(n), `حذف «${k}» أبقى «${n}»`);
    }
  }
  // خانة المندوب تذهب باسمه (ويبقى صفّ «المندوب» في صندوق البيانات)
  const reps = (h: string) => h.split('خالد العتيبي').length - 1;
  assert.equal(reps(gridInv(invoice(), fakePt({ deleted: ['sig.rep'] }))), reps(full) - 1);
  // الزوج: حذف السعر الشامل يُسقط عمود السعر نفسه
  assert.equal(lineCounts(gridInv(invoice(), fakePt({ deleted: ['col.priceIncl'] }))).get('col.price') ?? 0, 0);
  // العنوان المحذوف لا يترك سطراً فارغاً
  const noTitle = gridInv(invoice(), fakePt({ deleted: ['inv.title'] }));
  assert.ok(!noTitle.includes('Tax Invoice'));
});

test('«حذف السطر» في سند القبض: كل مفتاح بوحدته — والفاتورة الواحدة صفّها', () => {
  const keys = GRID_RECEIPT_KEYS.filter((k) => k !== 'rcp.forInvoice');
  assertWholeLine('سند', (pt) => gridRcp(receipt(), pt), keys);
  assertWholeLine('سند بفاتورة واحدة', (pt) => gridRcp(receipt({ invoices: [{ number: 'SI-9', amount: 300 }] }), pt), ['rcp.forInvoice']);
  const one = (pt: PrintTexts) => gridRcp(receipt({ invoices: [{ number: 'SI-9', amount: 300 }] }), pt);
  assert.ok(one(fakePt()).includes('SI-9'));
  assert.ok(!one(fakePt({ deleted: ['rcp.forInvoice'] })).includes('SI-9'));
  // المبلغ المحذوف يذهب بقيمته
  assert.ok(gridRcp(receipt(), fakePt()).includes('300.00'));
  assert.ok(!gridRcp(receipt(), fakePt({ deleted: ['rcp.amount'] })).includes('300.00'));
});

test('معاينة المحرّر: المحذوف مشطوبٌ حاضر وقابل للنقر — لا يختفي', () => {
  const preview: PrintTextsPreview = { onPick: () => {}, active: null };
  const h = gridInv(invoice(), fakePt({ deleted: ['cust.postalCode', 'col.code'], preview }));
  assert.ok(h.includes('13524') && h.includes('P-1001'), 'المعاينة حذفت ما يجب أن يُشطب');
  assert.match(h, /data-line="cust\.postalCode"[^>]*text-decoration:line-through/);
  assert.match(h, /data-pt-key="cust\.postalCode"/);
  assert.match(h, /data-pt-key="col\.code"/);
  // بلا معاينة: لا data-pt-key على الورقة الحقيقية
  assert.ok(!gridInv(invoice(), fakePt()).includes('data-pt-key'));
});

test('فجوات البيانات: الصفّ بلا قيمة لا يُطبع فارغاً — ورقم الصنف يسقط بلا رموز', () => {
  const bare = invoice({
    company: { name: 'شركة', countryCode: 'SA' } as InvoiceDoc['company'],
    customer: { name: 'عميل نقدي' },
    items: items.map(({ code: _c, taxAmt: _t, ...it }) => it) as InvoiceDoc['items'],
    deliveryDate: undefined,
  });
  const h = gridInv(bare, fakePt());
  const c = lineCounts(h);
  for (const k of ['sel.city', 'sel.postalCode', 'sel.taxNumber', 'sel.address', 'cust.postalCode', 'cust.taxNumber', 'cust.city',
    'cust.address', 'cust.business', 'cust.commercialReg', 'inv.deliveryDate', 'col.code', 'h.phone', 'h.address', 'h.commercialReg']) {
    assert.equal(c.get(k) ?? 0, 0, `«${k}» طُبع بلا بيانات`);
  }
  assert.ok(!h.includes(phraseIn('رقم الصنف', 'en') ?? 'Item Code'));
  // ضريبة البند بلا taxAmt تُحسب من إجماليه (lineVat)
  assert.ok((c.get('col.vatAmount') ?? 0) > 0);
  // البلد بلا مدينة
  assert.match(h, /المملكة العربية السعودية</);
});

test('أحادي اللون: page_plain والنقطية (lookFor) — أسود وأبيض فقط في أنماط العناصر', () => {
  const impact: PrintProfile = {
    id: 'imp', name: 'نقطية', printer: 'impact', template: 'impact_plain', paper: presetPaper('ff_a4')!, options: defaultPrintOptions('impact'),
  };
  const impactLook = lookFor(impact);
  assert.equal(impactLook.mono, true);
  for (const [name, look, lay] of [
    ['page_plain', { ...DEFAULT_PRINT_LOOK, mono: true }, layout()],
    ['impact', impactLook, layout({ printer: 'impact', accent: '#B91C1C' })],
  ] as const) {
    for (const html of [gridInv(invoice(), fakePt(), { look, lay }), gridInv(returnDoc(), fakePt(), { look, lay }), gridRcp(receipt(), fakePt(), { look })]) {
      const styles = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(';');
      const colors = styles.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [];
      const bad = colors.filter((c) => !['#000', '#000000', '#fff', '#ffffff'].includes(c.toLowerCase()));
      assert.deepEqual(bad, [], `${name}: ألوانٌ غير الأسود/الأبيض`);
      assert.ok(!/letter-spacing/.test(html));
    }
  }
  // ملوّن: لون التمييز على خط الترويسة ورؤوس الجدول
  const colored = gridInv(invoice(), fakePt(), { lay: layout({ accent: '#1D4ED8' }) });
  assert.match(colored, /border-bottom:2px solid #1D4ED8/);
  assert.match(colored, /background:#1D4ED8/);
  // بلا لون مختار ⇒ لون الشركة
  assert.match(gridInv(invoice(), fakePt()), /background:#0F766E/);
});

test('رمز QR: عقدةٌ ممرَّرة تُطبع ولو حُذفت كل النصوص — وسند القبض بلا رمز', () => {
  const all = [...new Set([...GRID_INVOICE_KEYS, ...GRID_RECEIPT_KEYS])];
  for (const order of [DEFAULT_SECTIONS.grid, ['header', 'parties', 'items', 'totals', 'info', 'note', 'installments', 'signatures', 'footer']] as const) {
    const h = gridInv(invoice(), fakePt({ deleted: all }), { lay: layout({ order: order as ResolvedLayout['order'] }) });
    assert.match(h, /data-test-qr="1"/);
    assert.match(h, /alt="QR"/);
  }
  assert.ok(!gridInv(invoice(), fakePt(), { qr: null }).includes('alt="QR"'));
  assert.ok(!gridRcp(receipt(), fakePt()).includes('alt="QR"'));
});

test('ترتيب الأقسام والشعار: الترتيب المحفوظ يُتّبع، والشعار في مكانه وحجمه أو غائب', () => {
  const pos = (h: string, s: string) => h.indexOf(`data-section="${s}"`);
  const def = gridInv(invoice(), fakePt());
  assert.ok(pos(def, 'header') < pos(def, 'info') && pos(def, 'info') < pos(def, 'parties') && pos(def, 'parties') < pos(def, 'items'));
  const moved = gridInv(invoice(), fakePt(), { lay: layout({ order: ['header', 'parties', 'info', 'items', 'totals', 'note', 'installments', 'signatures', 'footer'] as ResolvedLayout['order'] }) });
  assert.ok(pos(moved, 'parties') < pos(moved, 'info'));
  assert.ok(pos(moved, 'totals') < pos(moved, 'note'));
  // الشعار: الوسط افتراضاً بحجم متوسط، ولا شعار مع none أو showLogo:false
  assert.match(def, /<img src="data:image\/png;base64,iVBORw0KGgo="[^>]*border-radius:50%/);
  const noLogo = gridInv(invoice(), fakePt(), { lay: layout({ logo: 'none' }) });
  assert.ok(!/border-radius:50%/.test(noLogo));
  assert.ok(!/border-radius:50%/.test(gridInv(invoice(), fakePt(), { look: { ...DEFAULT_PRINT_LOOK, showLogo: false } })));
  const big = gridInv(invoice(), fakePt(), { lay: layout({ logoSize: 'l' }) });
  const small = gridInv(invoice(), fakePt(), { lay: layout({ logoSize: 's' }) });
  const w = (h: string) => Number(/border-radius:50%/.test(h) && /<img[^>]*width:(\d+)px[^>]*border-radius:50%/.exec(h)?.[1]);
  assert.ok(w(big) > w(def) && w(def) > w(small), 'أحجام الشعار لا تتدرّج');
  // يمين (start) قبل كتلة العربي، ويسار (end) بعد الإنجليزي
  const start = gridInv(invoice(), fakePt(), { lay: layout({ logo: 'start' }) });
  assert.ok(start.indexOf('border-radius:50%') < start.indexOf('مؤسسة مروج الخليج للتجارة'));
  const end = gridInv(invoice(), fakePt(), { lay: layout({ logo: 'end' }) });
  assert.ok(end.indexOf('border-radius:50%') > end.indexOf('Saudi Arabia'));
});

test('ورقة A4: مرنةٌ بارتفاع A4 وصفّ حشوٍ لفاتورة الصفحة الواحدة، وبلا حشوٍ لمتعدّدة الصفحات', () => {
  const one = gridInv(invoice(), fakePt());
  assert.match(one, /min-height:1123px/);
  assert.match(one, /data-grid-filler/);
  const many = invoice({ items: Array.from({ length: 40 }, (_, i) => ({ ...items[0], name: `صنف ${i}` })) as InvoiceDoc['items'] });
  assert.ok(!gridInv(many, fakePt()).includes('data-grid-filler'));
});

test('حرّاس المصدر: printGrid.tsx لا يبني رمزاً ولا يكتب قيمته ولا يستورد من RepDocuments إلا أنواعاً', () => {
  const src = readFileSync(new URL('./printGrid.tsx', import.meta.url), 'utf8');
  for (const banned of ['buildZatcaQr(', 'data-qr-value', 'letterSpacing', 'letter-spacing', 'buyerNotice', 'QRCode']) {
    assert.ok(!src.includes(banned), `ممنوع في printGrid.tsx: ${banned}`);
  }
  const fromRd = [...src.matchAll(/^import\s+(type\s+)?[^;]*from\s+'\.\/RepDocuments';/gm)];
  assert.ok(fromRd.length > 0);
  for (const m of fromRd) assert.ok(m[1], `استيراد تشغيليّ من RepDocuments: ${m[0]}`);
});

// المحلِّل الحقيقيّ (P2): بلا نصوص ⇒ en = القاموس، وحذفٌ محفوظ يُسقط الوحدة — يعمل متى وصل `pt.en` من الحزمة P2
const realHasEn = typeof (makePrintTexts(null, (s) => s) as unknown as { en?: unknown }).en === 'function';
test('المحلِّل الحقيقيّ: بلا نصوص العربي أولاً والإنجليزي من القاموس، والحذف المحفوظ يُسقط الوحدة', { skip: realHasEn ? false : 'pt.en (P2) غير موجود بعد' }, () => {
  const off = makePrintTexts(null, (s) => `UI:${s}`);
  const h = gridInv(invoice(), off);
  // لغة واجهة الجهاز لا تمسّ القالب العربيّ
  assert.deepEqual(h.match(/UI:[^<]*/g) ?? [], [], 'نصٌّ أُخذ من مترجم الواجهة');
  assert.ok(h.includes('رقم الفاتورة'));
  const en = phraseIn('رقم الفاتورة', 'en');
  if (en) assert.ok(h.includes(en));
  const on = makePrintTexts({
    version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null,
    edits: { 'cust.taxNumber': { text: null, alt: null, hidden: true }, 'foot.platform': { text: null, alt: null, hidden: true } },
  } as Parameters<typeof makePrintTexts>[0], (s) => s, { standard: true });
  const d = lineCounts(gridInv(invoice(), on));
  assert.equal(d.get('cust.taxNumber') ?? 0, 0);
  assert.equal(d.get('foot.platform') ?? 0, 0);
  assert.ok((d.get('sel.taxNumber') ?? 0) > 0);
});

/* مراجعة المطابقة (٣ نوفمبر): lineTotal المخزَّن **شاملٌ الضريبة في الوضعين** (computeInvoiceTotals: الحصري net+tax والشامل
 * الأساس الشامل) — فالقالب الحالي يطبعه «الإجمالي» كما هو ومجموعه = doc.total. والقالب الجديد كان يضيف ضريبة السطر فوقه
 * في الفاتورة الحصرية (٢٣٠ ⇒ ٢٦٠) ويشتقّ ضريبةً بلا taxAmt من إجماليٍّ شامل كأنه صافٍ (٢٣٠×١٥٪ = ٣٤٫٥ بدل ٣٠). */
test('أرقام البنود: الإجمالي = lineTotal المخزَّن (كالقالب الحالي) ومجموعه = إجمالي الفاتورة — حصرياً وشاملاً', () => {
  // ٢ × ١٠٠ صافٍ @١٥٪: الوعاء ٢٠٠ والضريبة ٣٠ والإجمالي المخزَّن ٢٣٠ (حصري) — و٢ × ١١٥ شاملاً يعطي الأرقام نفسها
  const line = (excl: boolean, withTaxAmt: boolean) => ({
    name: 'صنف', code: 'P-1', unit: 'كرتون', multiUnit: true, qty: 2, unitPrice: excl ? 100 : 115, discountPct: 0, taxPct: 15, lineTotal: 230,
    ...(withTaxAmt ? { taxAmt: 30 } : {}),
  });
  for (const excl of [true, false]) {
    for (const withTaxAmt of [true, false]) {
      const doc = invoice({
        items: [line(excl, withTaxAmt), line(excl, withTaxAmt)] as InvoiceDoc['items'],
        subtotal: 400, discount: 0, tax: 60, total: 460, pricesIncludeTax: !excl, paymentPlan: null, installments: [], type: 'CASH',
      });
      const h = gridInv(doc, fakePt());
      const cells = (k: string) => [...h.matchAll(new RegExp(`<td data-line="${k.replace(/\./g, '\\.')}"[^>]*>(.*?)</td>`, 'g'))]
        .map((m) => m[1].replace(/<[^>]+>/g, '|').split('|').filter(Boolean)[0]).filter((v) => v !== undefined); // صفّ الحشو فارغ
      const tag = `${excl ? 'حصري' : 'شامل'}${withTaxAmt ? '' : ' بلا taxAmt'}`;
      assert.deepEqual(cells('col.total'), ['230.00', '230.00'], `${tag}: «الإجمالي» للسطر`);
      assert.deepEqual(cells('col.vatAmount'), ['30.00', '30.00'], `${tag}: ضريبة السطر`);
      assert.deepEqual(cells('col.price col.priceIncl'), ['100.00', '100.00'], `${tag}: السعر الإفرادي قبل الضريبة`);
      assert.ok(h.includes('460.00'), `${tag}: الإجمالي المستحق`);
    }
  }
});

test('صفّ الحشو يمدّ شبكة الجدول إلى التذييل: الجدول نفسه يتمدّد (flex) لا الغلاف وحده', () => {
  // height:100% داخل عنصرٍ مرن بلا ارتفاعٍ محدَّد لا يُحلّ (الورقة min-height فقط) — قيس في كروم: الجدول 151px وصفّ الحشو 3px
  // والفراغ تحته أبيض بلا خطوط أعمدة. بـflex على الجدول نفسه: الجدول 415px وصفّ الحشو 266px كنموذج المالك.
  const one = gridInv(invoice(), fakePt());
  assert.match(one, /<table style="[^"]*flex:1 1 auto/);
  const many = invoice({ items: Array.from({ length: 40 }, (_, i) => ({ ...items[0], name: `صنف ${i}` })) as InvoiceDoc['items'] });
  assert.doesNotMatch(gridInv(many, fakePt()), /<table style="[^"]*flex:1 1 auto/);
});
