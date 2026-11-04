/**
 * الرول المختصر/المفصّل بعد «تخطيط المطبوعات» و«حذف السطر» (pl_spec v2 — B2/B3، الحزمة P6):
 *
 * ١) التخطيط: الشعار في الوسط أو بلا شعار وحجمه، وترتيب الأقسام عبر rollSectionsHtml — وتخطيطٌ بقيم اليوم يُخرج وثيقة اليوم
 *    حرفاً بحرف، والكلاسيكي 58 لا يقرأ تخطيطاً أبداً.
 * ٢) الحذف: كل مفتاحٍ له موضعٌ في الرول يُسقط وحدته كاملة (التسمية وقيمتها، العمود رأساً وخلايا، صفّ الإجمالي، الخانة…) ولا
 *    يتغيّر غيرها؛ والمفتاح الذي لا موضع له في الرول لا يغيّر شيئاً. كل مفتاحٍ في PRINT_TEXT_LINE مصنَّفٌ هنا (حارس اكتمال).
 * ٣) رمز المرحلة الثانية المختوم يُطبع في كل ترتيب ومع حذف كل العبارات.
 *
 * بلا DOM: الطباعة تُلتقط (capture/raster) كما في rollThermal.baseline.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printThermalInvoice, printThermalReceipt, type ThermalPrintOptions } from './thermal';
import type { Company, InvoiceDoc, ReceiptDoc } from './RepDocuments';
import { defaultPrintOptions, legacyThermalProfile, presetPaper, type PaperPresetId, type PrintOptions, type PrintProfile, type TemplateId } from '../lib/print/printSettings';
import { PRINT_TEXT_LINE } from '../lib/print/printTextsCore';
import { DEFAULT_SECTIONS } from '../lib/print/layout';
import type { PrintTextsV1 } from '../lib/print/printTexts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
/** الأرقام بشكل الشركة النشط (العربية افتراضاً) — الأنماط تقبل الشكلين */
const STAMPED = 'AQ' + 'Zm'.repeat(150) + 'x'.repeat(398);
const same = (s: string): string => s;
const norm = (s: string): string => s.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{200,}/g, 'data:QR');
/** مقارنةٌ لا تتأثر بالمسافات بين الوسوم (سطرٌ محذوف يترك مسافته في القالب) */
const squash = (s: string): string => s.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

const company: Company = {
  name: 'شركة الاختبار', taxNumber: '300000000000003', address: 'الرياض حي العليا', phone: '0501234567', logo: PNG, countryCode: 'SA',
};
const BUYER = { name: 'مؤسسة الريان', businessName: 'أسواق الريان', taxNumber: '311111111111113', address: 'شارع الملك فهد', city: 'الرياض' };
const MIXED: InvoiceDoc['items'] = [
  { name: 'أرز', unit: 'كيس', qty: 4, unitPrice: 57.5, discountPct: 0, taxPct: 15, lineTotal: 230 },
  { name: 'حليب', unit: 'علبة', qty: 1, unitPrice: 40, discountPct: 0, taxPct: 0, lineTotal: 40, multiUnit: true },
  { name: 'زيت', unit: 'حبة', qty: 6, unitPrice: 12.25, discountPct: 5, taxPct: 15, lineTotal: 69.83 },
];
const inv = (over: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-2048', date: '2026-10-23T10:30:00', type: 'CREDIT', company,
  customer: BUYER, repName: 'أحمد', items: MIXED, deliveryDate: '2026-10-25T00:00:00',
  subtotal: 300.72, discount: 0, tax: 39.11, total: 339.83, pricesIncludeTax: true, paidAmt: 100, remainingAmt: 239.83,
  recipientSignature: PNG, repSignature: PNG, ...over,
});
/** غير شاملة وبخصم: «السعر» و«ضريبة القيمة المضافة» و«الخصم» */
const invExcl = (): InvoiceDoc => inv({ number: 'INV-2049', pricesIncludeTax: false, discount: 7.5, subtotal: 300.72, tax: 41, total: 334.22 });
const creditNote = (): InvoiceDoc => inv({
  number: 'RET-8', isReturn: true, billingReference: 'INV-1024', noteReason: 'بضاعة تالفة', paidAmt: undefined, remainingAmt: undefined,
});
const p2 = (): InvoiceDoc => inv({
  number: 'INV-4096', zatca: {
    phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE',
    qr: STAMPED, printable: true, overdue: false, reportDeadline: null, issuedAt: null,
    uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be', icv: 42, warnings: 0,
  } as NonNullable<InvoiceDoc['zatca']>,
});
/** إشعار مدين بالمرحلة الثانية — عنوان القرار «إشعار مدين» بمفتاحه inv.debitTitle */
const debitNote = (): InvoiceDoc => { const d = p2(); return { ...d, number: 'DN-12', zatca: { ...d.zatca!, documentKind: 'DEBIT_NOTE' } as NonNullable<InvoiceDoc['zatca']> }; };
/** سند تسليم (قياسية لم تُعتمد) — عنوان القرار بمفتاحه inv.deliveryNoteTitle (قرار المالك ٤ نوفمبر ٢٠٢٦) */
const deliveryNote = (): InvoiceDoc => { const d = p2(); return { ...d, number: 'INV-4097', zatca: { ...d.zatca!, mirror: 'clearance_pending', documentStatus: 'SUBMITTING', qr: null, printable: false } as NonNullable<InvoiceDoc['zatca']> }; };
const rcp = (over: Partial<ReceiptDoc> = {}): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-77', date: '2026-10-23T11:05:00', company, customer: { name: 'بقالة النور', taxNumber: '322222222222223', address: 'حي النسيم', city: 'الرياض' },
  repName: 'أحمد', amount: 137.05, paymentMethod: 'CASH', notes: 'دفعة أولى', invoices: [{ number: 'INV-1024', amount: 137.05 }], ...over,
});
const rcpMany = (): ReceiptDoc => rcp({ amount: 300, invoices: [{ number: 'INV-1', amount: 100 }, { number: 'INV-2', amount: 50 }] });

function prof(template: TemplateId, preset: PaperPresetId, o: Partial<PrintOptions> = {}, layout?: Record<string, unknown>): PrintProfile {
  const options = { ...defaultPrintOptions('thermal'), showLogo: true, ...o, ...(layout ? { layout } : {}) } as PrintOptions;
  return { id: 'van-1', name: 'سيارة', printer: 'thermal', template, paper: presetPaper(preset) as PrintProfile['paper'], options };
}
const layoutOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  design: 'standard', logo: 'center', logoSize: 'l', accent: null, tableStyle: 'lines', order: [...DEFAULT_SECTIONS.thermal], ...over,
});
const COMPACT = prof('roll_compact', 'roll80');
const DETAILED = prof('roll_detailed', 'roll80');

const texts = (deleted: readonly string[]): PrintTextsV1 => ({
  version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null,
  edits: Object.fromEntries(deleted.map((k) => [k, { text: null, alt: null, hidden: true }])),
});
const withTexts = <D extends InvoiceDoc | ReceiptDoc>(doc: D, t: PrintTextsV1 | null): D =>
  (t ? { ...doc, company: { ...doc.company, printTexts: t } } : doc) as D;

async function roll(doc: InvoiceDoc | ReceiptDoc, profile: PrintProfile | null, raster = false): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile, tr: same };
  if (raster) opts.raster = async (html) => { out = html; };
  else opts.capture = (html) => { out = html; };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  return norm(out);
}

// ─── أدوات الوحدات: صفٌّ بتسميته، وعمودٌ بموضعه في كل صفوف الجدول ───
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = (label: string): RegExp => new RegExp(`<div class="row(?: muted)?"><span>${esc(label)}</span><span[^>]*>[^<]*</span></div>`, 'g');
const div = (cls: string, text: string): RegExp => new RegExp(`<div class="${cls}">${esc(text)}[^<]*</div>`, 'g');
type Unit = RegExp | [RegExp, string] | ((html: string) => string);
const apply = (html: string, units: readonly Unit[]): string => units.reduce<string>((h, u) =>
  (typeof u === 'function' ? u(h) : Array.isArray(u) ? h.replace(u[0], u[1]) : h.replace(u, '')), html);
/** يُسقط الخلية رقم idx من كل صفّ في جدول الأصناف (رأساً وجسماً) */
const dropCol = (idx: number) => (html: string): string => html.replace(/<tr>([\s\S]*?)<\/tr>/g, (_m, inner: string) => {
  let i = -1;
  return `<tr>${inner.replace(/<t([hd])\b[^>]*>[\s\S]*?<\/t\1>/g, (cell) => (++i === idx ? '' : cell))}</tr>`;
});

interface Case { doc: () => InvoiceDoc | ReceiptDoc; compact?: Unit[]; detailed?: Unit[] }
/** كل مفتاحٍ له موضعٌ في الرول ⇒ وحدته في كل قالب (غياب القالب = لا موضع فيه فلا تغيير) */
const ROLL: Record<string, Case> = {
  'h.taxNumber': { doc: inv, compact: [div('c muted', 'الرقم الضريبي 300000000000003')], detailed: [div('c muted', 'الرقم الضريبي 300000000000003')] },
  'h.address': { doc: inv, compact: [div('c muted', 'الرياض حي العليا')], detailed: [div('c muted', 'الرياض حي العليا')] },
  'h.phone': { doc: inv, compact: [div('c muted', 'هاتف 0501234567')], detailed: [div('c muted', 'هاتف 0501234567')] },
  'foot.company': { doc: inv, compact: [div('c muted', 'شركة الاختبار')], detailed: [div('c muted', 'شركة الاختبار')] },
  'foot.thanks': { doc: inv, compact: [div('c muted', 'شكرا لتعاملكم معنا')], detailed: [div('c muted', 'شكرا لتعاملكم معنا')] },
  'inv.title': { doc: inv, compact: [div('c b', 'فاتورة ضريبية')], detailed: [div('c b', 'فاتورة ضريبية')] },
  'inv.returnTitle': { doc: creditNote, compact: [div('c b', 'إشعار دائن')], detailed: [div('c b', 'إشعار دائن')] },
  'inv.debitTitle': { doc: debitNote, compact: [div('c b', 'إشعار مدين')], detailed: [div('c b', 'إشعار مدين')] },
  'inv.deliveryNoteTitle': { doc: deliveryNote, compact: [div('c b', 'سند تسليم — ليست فاتورة ضريبية')], detailed: [div('c b', 'سند تسليم — ليست فاتورة ضريبية')] },
  'inv.number': { doc: inv, compact: [row('رقم')], detailed: [row('رقم')] },
  'inv.returnNumber': { doc: creditNote, compact: [row('رقم')], detailed: [row('رقم')] },
  'inv.date': { doc: inv, compact: [row('التاريخ')], detailed: [row('التاريخ')] },
  'inv.deliveryDate': { doc: inv, compact: [row('تاريخ التسليم')], detailed: [row('تاريخ التسليم')] },
  'inv.rep': { doc: inv, compact: [row('المندوب')], detailed: [row('المندوب')] },
  'inv.originalRef': { doc: creditNote, compact: [row('الفاتورة الأصلية')], detailed: [row('الفاتورة الأصلية')] },
  'inv.noteReason': { doc: creditNote, compact: [row('سبب الإرجاع')], detailed: [row('سبب الإرجاع')] },
  'cust.name': { doc: inv, compact: [row('العميل')], detailed: [row('العميل')] },
  'cust.business': { doc: inv, detailed: [row('المنشأة')] },
  'cust.taxNumber': { doc: inv, compact: [row('الرقم الضريبي')], detailed: [row('الرقم الضريبي')] },
  'cust.address': { doc: inv, detailed: [row('العنوان')] },
  'col.item': { doc: inv, compact: [/<div class="iname">[\s\S]*?<\/div>/g], detailed: [dropCol(0)] },
  'col.qty': { doc: inv, compact: [[/(<div class="row"><span>)[\d٠-٩.٫]+ × /g, '$1']], detailed: [dropCol(1)] },
  'col.priceIncl': { doc: inv, compact: [/ × [\d٠-٩.٫]+(?=( -[\d٠-٩.٫]+%)?<\/span><span class="b">)/g], detailed: [dropCol(2)] },
  'col.price': { doc: invExcl, compact: [/ × [\d٠-٩.٫]+(?=( -[\d٠-٩.٫]+%)?<\/span><span class="b">)/g], detailed: [dropCol(2)] },
  'col.tax': { doc: inv, detailed: [dropCol(3)] },
  'col.total': { doc: inv, compact: [/<span class="b">[\d٠-٩.٫]+<\/span>(?=<\/div>\s*<div class="muted">|<\/div>\s*<\/div>)/g], detailed: [dropCol(4)] },
  'col.discount': { doc: inv, compact: [/ -[\d٠-٩.٫]+%/g], detailed: [div('muted', 'الخصم ')] },
  'item.beforeTax': { doc: inv, compact: [div('muted', 'قبل الضريبة:')], detailed: [div('muted', 'قبل الضريبة:')] },
  'tot.taxable': { doc: inv, compact: [row('المجموع قبل الضريبة')], detailed: [row('المجموع قبل الضريبة')] },
  'tot.vatIncl': { doc: inv, compact: [row('منها ضريبة القيمة المضافة نسب متعددة')], detailed: [row('منها ضريبة القيمة المضافة نسب متعددة')] },
  'tot.vat': { doc: invExcl, compact: [row('ضريبة القيمة المضافة نسب متعددة')], detailed: [row('ضريبة القيمة المضافة نسب متعددة')] },
  'tot.discount': { doc: invExcl, compact: [row('الخصم')], detailed: [row('الخصم')] },
  'tot.grand': { doc: inv, compact: [/<div class="row b lg"><span>الإجمالي<\/span><span>[^<]*<\/span><\/div>/g], detailed: [/<div class="row b lg"><span>الإجمالي<\/span><span>[^<]*<\/span><\/div>/g] },
  'tot.returnGrand': { doc: creditNote, compact: [/<div class="row b lg"><span>إجمالي المرتجع دائن<\/span><span>[^<]*<\/span><\/div>/g], detailed: [/<div class="row b lg"><span>إجمالي المرتجع دائن<\/span><span>[^<]*<\/span><\/div>/g] },
  'tot.paid': { doc: inv, compact: [row('المدفوع')], detailed: [row('المدفوع')] },
  'tot.remaining': { doc: inv, compact: [row('المتبقي')], detailed: [row('المتبقي')] },
  'sig.recipient': { doc: inv, compact: [/<div class="c"><img [^>]*><div class="muted">توقيع المستلم<\/div><\/div><div class="sep"><\/div>/g], detailed: [/<div class="c"><img [^>]*><div class="muted">توقيع المستلم<\/div><\/div><div class="sep"><\/div>/g] },
  'sig.rep': { doc: inv, compact: [/<div class="c"><img [^>]*><div class="muted">توقيع المندوب<\/div><\/div><div class="sep"><\/div>/g], detailed: [/<div class="c"><img [^>]*><div class="muted">توقيع المندوب<\/div><\/div><div class="sep"><\/div>/g] },
  'rcp.title': { doc: rcp, compact: [div('c b', 'سند قبض')], detailed: [div('c b', 'سند قبض')] },
  'rcp.number': { doc: rcp, compact: [row('رقم')], detailed: [row('رقم')] },
  'rcp.date': { doc: rcp, compact: [row('التاريخ')], detailed: [row('التاريخ')] },
  'rcp.rep': { doc: rcp, compact: [row('المندوب')], detailed: [row('المندوب')] },
  'rcp.from': { doc: rcp, compact: [row('استلمنا من')], detailed: [row('استلمنا من')] },
  'rcp.taxNumber': { doc: rcp, compact: [row('الرقم الضريبي')], detailed: [row('الرقم الضريبي')] },
  'rcp.address': { doc: rcp, detailed: [row('العنوان')] },
  'rcp.method': { doc: rcp, compact: [row('طريقة الدفع')], detailed: [row('طريقة الدفع')] },
  'rcp.notes': { doc: rcp, compact: [row('ملاحظات')], detailed: [row('ملاحظات')] },
  'rcp.amount': { doc: rcp, compact: [div('c muted', 'المبلغ المستلم'), /<div class="c b xl">[^<]*<\/div>/g], detailed: [div('c muted', 'المبلغ المستلم'), /<div class="c b xl">[^<]*<\/div>/g] },
  'rcp.forInvoice': { doc: rcp, compact: [/<div class="row"><span>مقابل الفاتورة رقم<\/span><span class="b">INV-1024<\/span><\/div>/g], detailed: [/<div class="row"><span>مقابل الفاتورة رقم<\/span><span class="b">INV-1024<\/span><\/div>/g] },
  'rcp.forInvoices': {
    doc: rcpMany,
    compact: [div('c muted', 'مقابل الفواتير'), /<div class="row"><span>INV-[12]<\/span><span>[^<]*<\/span><\/div>/g],
    detailed: [div('c muted', 'مقابل الفواتير'), /<div class="row"><span>INV-[12]<\/span><span>[^<]*<\/span><\/div>/g],
  },
  'rcp.credit': { doc: rcpMany, compact: [row('رصيد دائن للعميل')], detailed: [row('رصيد دائن للعميل')] },
};
/** لا موضع لها في الرول (لا تسمية ولا قيمة تحكمها) — حذفها لا يغيّر الشريط حرفاً */
const NO_ROLL = [
  'h.commercialReg', 'h.email', 'inv.infoHeading', 'inv.returnInfoHeading', 'inv.time', 'inv.type', 'cust.heading', 'cust.commercialReg',
  'cust.phone', 'note.pricesIncl', 'tot.subtotal', 'inst.heading', 'inst.dueDate', 'inst.amount', 'inst.sum', 'inst.note', 'qr.caption',
  'rcp.time', 'rcp.invoiceNo', 'rcp.customerHeading', 'rcp.business', 'rcp.commercialReg', 'rcp.phone', 'rcp.sigPayer', 'rcp.sigCollector',
  'col.seq', 'col.code', 'col.unit', 'col.vatAmount', 'sel.heading', 'sel.name', 'sel.address', 'sel.city', 'sel.postalCode', 'sel.taxNumber',
  'cust.city', 'cust.postalCode', 'inv.paymentType', 'sig.warehouse', 'sig.remarks', 'tot.exclVat', 'tot.due', 'foot.platform',
  // المُبطل والمعلَّق لا ورقة رول لهما (thermal.ts يرفض طباعتهما) — فلا موضع لعنوانيهما فيه
  'inv.voidTitle', 'inv.pendingTitle',
];

test('حارس الاكتمال: كل مفتاحٍ في PRINT_TEXT_LINE إمّا له وحدةٌ في الرول أو مصنَّفٌ «بلا موضع» — لا ثالث ولا تكرار', () => {
  const all = Object.keys(PRINT_TEXT_LINE).sort();
  const mine = [...Object.keys(ROLL), ...NO_ROLL];
  assert.equal(new Set(mine).size, mine.length, 'مفتاحٌ مصنَّفٌ مرّتين');
  assert.deepEqual([...mine].sort(), all);
});

test('«حذف السطر» في الرول المختصر والمفصّل: الوحدة كاملةً تسقط ولا يتغيّر غيرها — لكل مفتاحٍ له موضع', async () => {
  for (const [key, c] of Object.entries(ROLL)) {
    for (const [name, profile, units] of [['compact', COMPACT, c.compact], ['detailed', DETAILED, c.detailed]] as const) {
      const before = await roll(c.doc(), profile);
      const after = await roll(withTexts(c.doc(), texts([key])), profile);
      if (!units) { assert.equal(squash(after), squash(before), `${key}/${name}: لا موضع له في هذا القالب لكنه غيّره`); continue; }
      const expected = apply(before, units);
      assert.notEqual(squash(expected), squash(before), `${key}/${name}: الوحدة غير موجودة في المرجع — الحالة لا تختبر شيئاً`);
      assert.equal(squash(after), squash(expected), `${key}/${name}: الحذف لم يُسقط الوحدة وحدها`);
    }
  }
});

test('مفتاحٌ بلا موضع في الرول: حذفه لا يغيّر الفاتورة ولا السند حرفاً', async () => {
  for (const profile of [COMPACT, DETAILED]) {
    for (const doc of [inv(), creditNote(), rcpMany()]) {
      const before = await roll(doc, profile);
      assert.equal(await roll(withTexts(doc, texts(NO_ROLL)), profile), before);
    }
  }
});

test('رمز المرحلة الثانية المختوم في كل ترتيب ومع حذف كل العبارات — صورةً لنظام الطباعة وخانةً بقيمتها للبلوتوث', async () => {
  const orders: string[][] = [
    [...DEFAULT_SECTIONS.thermal],
    ['header', 'qr', 'info', 'customer', 'items', 'totals', 'signatures', 'footer'],
    ['header', 'items', 'qr', 'totals', 'customer', 'info', 'signatures', 'footer'],
    ['header', 'customer', 'info', 'items', 'totals', 'qr', 'signatures', 'footer'],
  ];
  const everything = texts(Object.keys(PRINT_TEXT_LINE));
  for (const order of orders) {
    for (const t of [null, everything]) {
      for (const tpl of ['roll_compact', 'roll_detailed'] as const) {
        const p = prof(tpl, 'roll80', {}, layoutOf({ order }));
        const sys = await roll(withTexts(p2(), t), p);
        assert.match(sys, /<div class="qrbox" style="--qr:[\d٠-٩.٫]+mm"><div class="qr"><img src="data:QR" width="168" height="168"\/><\/div><\/div>/, `${order.join(',')}: الرمز سقط`);
        assert.match(sys, /ICV (42|٤٢)</, 'ICV سقط');
        const bt = await roll(withTexts(p2(), t), p, true);
        assert.ok(bt.includes(`data-qr-value="${STAMPED}"`), `${order.join(',')}: خانة البلوتوث سقطت`);
      }
    }
  }
});

test('ترتيب الأقسام: الرول يتبع ترتيب الشركة، والرأس أوّلاً والتذييل آخراً كما رُتِّبا، و«بيانات المستند» تأخذ فاصلها', async () => {
  const order = ['header', 'qr', 'items', 'totals', 'customer', 'info', 'signatures', 'footer'];
  const html = await roll(p2(), prof('roll_compact', 'roll80', {}, layoutOf({ order })));
  const at = (needle: string): number => { const i = html.indexOf(needle); assert.ok(i >= 0, `مفقود: ${needle}`); return i; };
  const pos = [at('class="c b lg"'), at('class="qrbox"'), at('class="iname"'), at('<span>الإجمالي</span>'), at('<span>العميل</span>'), at('<span>رقم</span>'), at('توقيع المستلم'), at('شكرا لتعاملكم معنا')];
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'الأقسام بغير ترتيب الشركة');
  // «بيانات المستند» قبل التواقيع (لا قبل العميل) ⇒ فاصلٌ بعد صفّ المندوب
  assert.match(html, /<span>المندوب<\/span><span>أحمد<\/span><\/div>\s*<div class="sep"><\/div>/);
  // السند: أقسامه الخمسة بالترتيب نفسه، والمبلغ وفواتيره قسم الإجماليات
  const r = await roll(rcp(), prof('roll_compact', 'roll80', {}, layoutOf({ order })));
  assert.ok(r.indexOf('المبلغ المستلم') < r.indexOf('استلمنا من') && r.indexOf('استلمنا من') < r.indexOf('<span>رقم</span>'));
});

test('تخطيطٌ بقيم اليوم (وسط، كبير = عرض اليوم، الترتيب الافتراضي) = وثيقة اليوم حرفاً بحرف — فاتورةً وسنداً، مختصراً ومفصّلاً', async () => {
  for (const tpl of ['roll_compact', 'roll_detailed'] as const) {
    for (const doc of [inv(), p2(), creditNote(), rcp(), rcpMany()]) {
      assert.equal(await roll(doc, prof(tpl, 'roll80', {}, layoutOf())), await roll(doc, prof(tpl, 'roll80')), `${tpl}/${doc.number}`);
    }
  }
});

test('الشعار: «بلا شعار» يسقطه، والحجم نسبةٌ من عرض اليوم (36/48/60%) في الوسط دائماً — وبلا تخطيط أسلوب اليوم', async () => {
  const today = await roll(inv(), prof('roll_compact', 'roll80'));
  assert.ok(today.includes(`<div class="c logo"><img src="${PNG}" alt=""/></div>`));
  const none = await roll(inv(), prof('roll_compact', 'roll80', {}, layoutOf({ logo: 'none' })));
  assert.ok(!none.includes('class="c logo"'));
  assert.equal(squash(none), squash(today.replace(`<div class="c logo"><img src="${PNG}" alt=""/></div>`, '')), 'بلا شعار غيّر غير الشعار');
  const s = await roll(inv(), prof('roll_compact', 'roll80', {}, layoutOf({ logoSize: 's' })));
  assert.ok(s.includes(`<div class="c logo"><img src="${PNG}" alt="" style="max-width:36%;max-height:9.6mm"/></div>`));
  const m = await roll(inv(), prof('roll_compact', 'roll80', {}, layoutOf({ logoSize: 'm' })));
  assert.ok(m.includes('style="max-width:48%;max-height:12.8mm"'));
  // showLogo مطفأ يغلب التخطيط
  assert.ok(!(await roll(inv(), prof('roll_compact', 'roll80', { showLogo: false }, layoutOf({ logoSize: 's' })))).includes('class="c logo"'));
});

test('الكلاسيكي 58 مجمَّد: تخطيطٌ على roll_classic أو الملف الافتراضي لا يُقرأ — والوثيقة كاليوم حرفاً بحرف', async () => {
  const layout = layoutOf({ logo: 'none', order: ['header', 'qr', 'info', 'customer', 'items', 'totals', 'signatures', 'footer'] });
  const classicWithLayout = { ...legacyThermalProfile(), options: { ...legacyThermalProfile().options, layout } as unknown as PrintOptions };
  for (const doc of [inv(), p2(), rcp()]) {
    const today = await roll(doc, null);
    assert.ok(today.includes('58mm auto'));
    assert.equal(await roll(doc, classicWithLayout), today);
    assert.equal(await roll(doc, { ...classicWithLayout, id: 'van-9' }), today, 'roll_classic بمعرّفٍ آخر');
  }
});

test('مراجعة الرول (٣ نوفمبر): رمز QR بين الأصناف والإجماليات (ترتيبٌ يقبله الخادم) يأخذ فاصله فلا يلتصق UUID بصفّ الإجمالي — والترتيب الافتراضي بلا فاصلٍ زائد', async () => {
  const sepAfterUuid = /3cf5ee18[^<]*<\/div>\s*<div class="sep"><\/div>/;
  for (const tpl of ['roll_compact', 'roll_detailed'] as const) {
    for (const order of [
      ['header', 'info', 'customer', 'items', 'qr', 'totals', 'signatures', 'footer'],
      ['header', 'info', 'customer', 'items', 'totals', 'qr', 'signatures', 'footer'],
    ]) {
      const html = await roll(p2(), prof(tpl, 'roll80', {}, layoutOf({ order })));
      const uuid = html.indexOf('3cf5ee18');
      assert.ok(uuid > 0, 'UUID غائب');
      assert.match(html, sepAfterUuid, `${tpl} ${order.join(',')}: لا فاصل بعد الرمز`);
    }
    // الترتيب الافتراضي: الرمز قبل التذييل بلا فاصل كاليوم
    assert.doesNotMatch(await roll(p2(), prof(tpl, 'roll80', {}, layoutOf())), sepAfterUuid);
    // مستندٌ بلا رمز: قسم الرمز فارغ فلا فاصل يتيم
    const noQr = await roll(inv(), prof(tpl, 'roll80', {}, layoutOf({ order: ['header', 'info', 'customer', 'items', 'qr', 'totals', 'signatures', 'footer'] })));
    assert.doesNotMatch(noQr, /<div class="sep"><\/div>\s*<div class="sep"><\/div>/, `${tpl}: فاصلان متتاليان`);
  }
});
