/**
 * «تأكّد أن تعديلات نصوص المطبوعات تنعكس فعلياً على المستندات والفواتير والطباعة» (طلب المالك ٤ نوفمبر ٢٠٢٦) — اختبار انحدارٍ
 * لكل ثغرةٍ أكّدها الفحص في القوالب والمحلِّل، يفشل على f2645e0 وينجح بعد الإصلاح:
 *
 *   C-G1  القالب ثنائي اللغة: العمود الثاني بلغة الشركة الثانية (الفرنسية…) ونصّها بها — لا الإنجليزية دائماً.
 *   C-G2  صياغةٌ عربية بلا نصٍّ ثانٍ: لا تُطبع بجانبها إنجليزية الافتراضي القديم في القالب ثنائي اللغة.
 *   C-G3  القالب ثنائي اللغة يطبع نصّ الشركة الثاني للشكر وسطر المنصّة وملاحظة الأقساط.
 *   C-G4  نصّ الشركة الثاني لاسمها في التذييل (foot.company) يُطبع على A4 والرول والقالب ثنائي اللغة.
 *   C-G5  نصٌّ ثانٍ بلا صياغةٍ عربية يُطبع: تعليق الرمز المختوم (المرحلة الثانية) وسطر المنصّة و«#» — والرمز وICV باقيان.
 *   C-G6  عنوان الإشعار المدين (inv.debitTitle) يُصاغ ويُحذف على A4 والرول والقالب ثنائي اللغة — والرمز المختوم باقٍ.
 *   R-G2  «الأصل/نسخة» بالعربية لفاتورة/سند شركةٍ لها نصوص (كالشريط) — وبلغة الواجهة كاليوم بلا نصوص.
 *   C-G7  ترويسة كشف الحساب وإشعار التحميل تتبع النصوص (صياغة h.* وحذفها واسم الشركة بلغتها الثانية) — وبلا نصوص كاليوم حرفاً.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as RD from './RepDocuments';
import {
  PrintableInvoice, PrintableLoadNotice, PrintableReceipt, PrintableStatement,
  type Company, type InvoiceDoc, type LoadNoticeDoc, type ReceiptDoc, type StatementDoc,
} from './RepDocuments';
import { DEFAULT_PRINT_LOOK, PrintLookContext, lookFor, type PrintLook } from './printLook';
import { printThermalInvoice, printThermalReceipt, type ThermalPrintOptions } from './thermal';
import { defaultPrintOptions, presetPaper, withDesign, type PrintProfile } from '../lib/print/printSettings';
import { phraseIn, type PrintTextEdit, type PrintTextsV1 } from '../lib/print/printTexts';
import { zatcaPrintDecision } from '../lib/zatca/docPrint';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

// ─── المستندات ───

const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const UUID = '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا شارع التحلية', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: LOGO, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
  addrCity: 'الرياض', addrPostalCode: '12211',
};
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: UUID, icv: 41, warnings: 0, ...over,
});
const ITEMS: InvoiceDoc['items'] = [
  { name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46, code: 'P-100', taxAmt: 6 },
  { name: 'عصير برتقال', unit: 'حبة', qty: 3, unitPrice: 2.5, discountPct: 10, taxPct: 15, lineTotal: 6.75, code: 'P-200', taxAmt: 0.88, multiUnit: true },
];
/** قياسية بالمرحلة الثانية مختومة، آجلة بأقساط */
const invStd = (c: Company = COMPANY): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-777', date: '2026-11-02T09:15:00.000Z', type: 'CREDIT', company: c,
  customer: { name: 'محمد العتيبي', businessName: 'مؤسسة الأفق', taxNumber: '311111111111113', phone: '0112345678', address: 'طريق الملك فهد', city: 'جدة' },
  repName: 'أحمد السالم', items: ITEMS,
  subtotal: 48.5, discount: 2.5, tax: 6.88, total: 52.75, pricesIncludeTax: true, paidAmt: 21.5, remainingAmt: 31.25,
  paymentPlan: 'INSTALLMENT', installments: [
    { seq: 1, dueDate: '2026-12-02T00:00:00.000Z', amount: 26.38 }, { seq: 2, dueDate: '2027-01-02T00:00:00.000Z', amount: 26.37 },
  ],
  zatca: zv(),
});
/** إشعار مدين بالمرحلة الثانية (عنوان القرار «إشعار مدين») */
const debitNote = (c: Company = COMPANY): InvoiceDoc => ({ ...invStd(c), number: 'DN-12', zatca: zv({ documentKind: 'DEBIT_NOTE' } as Partial<ZatcaDocView>) });
const receipt = (c: Company = COMPANY): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-02T11:00:00.000Z', company: c, customer: { name: 'بقالة النور' },
  repName: 'أحمد السالم', amount: 150, paymentMethod: 'CASH', invoices: [{ number: 'INV-901', amount: 150 }],
});

// ─── النصوص ───

const ed = (e: Partial<PrintTextEdit>): PrintTextEdit => ({ text: null, alt: null, hidden: false, ...e });
const texts = (edits: Record<string, Partial<PrintTextEdit>>, over: Partial<Omit<PrintTextsV1, 'edits'>> = {}): PrintTextsV1 => ({
  version: 1, secondLang: 'en', companyNameAlt: null, companyAddressAlt: null, ...over,
  edits: Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, ed(v)])),
});
const co = (t: PrintTextsV1 | null): Company => ({ ...COMPANY, printTexts: t });

// ─── القوالب ───

const pageProfile = (): PrintProfile => ({ id: 'p-a4', name: 'A4', printer: 'page', template: 'page_branded', paper: presetPaper('a4')!, options: defaultPrintOptions('page') });
const GRID_LOOK = lookFor(withDesign(pageProfile(), 'grid_bilingual'));
const ROLL: PrintProfile = { id: 'van', name: 'سيارة', printer: 'thermal', template: 'roll_compact', paper: presetPaper('roll80')!, options: { ...defaultPrintOptions('thermal'), showLogo: true } };

const page = (doc: InvoiceDoc | ReceiptDoc, look: PrintLook = DEFAULT_PRINT_LOOK): string => renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: look },
  doc.kind === 'invoice' ? createElement(PrintableInvoice, { doc }) : createElement(PrintableReceipt, { doc })) as ReactElement);
const grid = (doc: InvoiceDoc | ReceiptDoc): string => page(doc, GRID_LOOK);
async function roll(doc: InvoiceDoc | ReceiptDoc): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile: ROLL, tr: (s: string) => s, capture: (h: string) => { out = h; } };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  assert.ok(out, 'لم تُلتقط وثيقة الرول');
  return out;
}
const count = (h: string, s: string): number => h.split(s).length - 1;
/** النصّ كما يُهرَّب في HTML (&) */
const esc = (s: string): string => s.replace(/&/g, '&amp;');

// ═══ C-G1 ═══

test('C-G1 ثنائي اللغة بلغةٍ ثانية فرنسية: نصّ الشركة الفرنسي لتسميةٍ غير معاد صياغتها يُطبع، وغير المعدّل بالفرنسية لا بالإنجليزية', () => {
  const fr = co(texts({ 'col.qty': { alt: 'Qté livrée' } }, { secondLang: 'fr' }));
  const h = grid(invStd(fr));
  assert.ok(h.includes('Qté livrée'), 'نصّ الشركة الفرنسي لعمود الكمية غائب');
  const dateFr = phraseIn('المندوب', 'fr');
  const dateEn = phraseIn('المندوب', 'en');
  assert.ok(dateFr && dateEn && dateFr !== dateEn);
  assert.ok(h.includes(esc(dateFr!)), `«المندوب» بلا فرنسيته «${dateFr}»`);
  assert.ok(!h.includes(`>${esc(dateEn!)}<`), `«المندوب» بالإنجليزية «${dateEn}» في ورقةٍ لغتها الثانية الفرنسية`);
  // الدولة والعنوان بالفرنسية أيضاً — لا لغتان على ورقة واحدة
  assert.ok(h.includes('Arabie saoudite'), 'سطر الدولة بالإنجليزية');
  assert.ok(!h.includes('Saudi Arabia'));
  // بلا نصوص: الإنجليزية كاليوم
  const off = grid(invStd(co(null)));
  assert.ok(off.includes('Saudi Arabia') && off.includes(esc(dateEn!)));
});

// ═══ C-G2 ═══

test('C-G2 ثنائي اللغة: صياغةٌ عربية خارج القاموس بلا نصٍّ ثانٍ لا تُطبع بجانبها إنجليزية الافتراضي القديم (بلا لغة ثانية وبالإنجليزية)', () => {
  const repEn = phraseIn('المندوب', 'en')!;
  assert.ok(repEn);
  for (const secondLang of [null, 'en'] as const) {
    const base = grid(invStd(co(texts({ 'h.phone': { text: 'الهاتف' } }, { secondLang }))));
    const h = grid(invStd(co(texts({ 'h.phone': { text: 'الهاتف' }, 'inv.rep': { text: 'مندوبنا الكريم' } }, { secondLang }))));
    assert.ok(h.includes('مندوبنا الكريم'), `${secondLang}: الصياغة غائبة`);
    assert.ok(count(base, repEn) > 0, `${secondLang}: «${repEn}» غير مطبوع أصلاً`);
    assert.equal(count(h, repEn), count(base, repEn) - 1, `${secondLang}: «${repEn}» القديمة بقيت بجانب «مندوبنا الكريم»`);
  }
});

// ═══ C-G3 ═══

test('C-G3 ثنائي اللغة: نصّ الشركة الثاني للشكر وسطر المنصّة وملاحظة الأقساط يُطبع', () => {
  const t = texts({
    'foot.thanks': { alt: 'Thank you for your business' },
    'foot.platform': { alt: 'Issued with Field Sales' },
    'inst.note': { alt: 'Full VAT due on supply; installments are a payment schedule' },
  });
  const h = grid(invStd(co(t)));
  for (const s of ['Thank you for your business', 'Issued with Field Sales', 'Full VAT due on supply; installments are a payment schedule']) {
    assert.ok(h.includes(s), `«${s}» غائب عن القالب ثنائي اللغة`);
  }
  // بلا لغةٍ ثانية لا يُطبع نصٌّ ثانٍ
  const ar = grid(invStd(co(texts({ 'foot.thanks': { alt: 'Thank you for your business' }, 'h.phone': { text: 'الهاتف' } }, { secondLang: null }))));
  assert.ok(!ar.includes('Thank you for your business'));
});

// ═══ C-G4 ═══

test('C-G4 نصّ الشركة الثاني لاسمها في التذييل (foot.company) يُطبع على A4 (الفاتورة والسند) والرول والقالب ثنائي اللغة', async () => {
  const c = co(texts({ 'foot.company': { alt: 'Test Distribution Co. Ltd' } }));
  const ALT = 'Test Distribution Co. Ltd';
  assert.ok(page(invStd(c)).includes(ALT), 'A4 الفاتورة');
  assert.ok(page(receipt(c)).includes(ALT), 'A4 السند');
  assert.ok((await roll(invStd(c))).includes(ALT), 'الرول الفاتورة');
  assert.ok((await roll(receipt(c))).includes(ALT), 'الرول السند');
  assert.ok(grid(invStd(c)).includes(ALT), 'ثنائي اللغة');
  // محذوفٌ ⇒ لا اسم ولا نصّ ثانٍ
  const gone = co(texts({ 'foot.company': { alt: ALT, hidden: true } }));
  assert.ok(!page(invStd(gone)).includes(ALT) && !(await roll(invStd(gone))).includes(ALT) && !grid(invStd(gone)).includes(ALT));
});

// ═══ C-G5 ═══

test('C-G5 نصٌّ ثانٍ بلا صياغةٍ عربية: تعليق الرمز المختوم وسطر المنصّة و«#» تُطبع بالعربية كاليوم ومعها نصّ الشركة — والرمز وICV باقيان', () => {
  const doc = invStd(co(texts({
    'qr.caption': { alt: 'ZATCA-approved invoice QR' },
    'foot.platform': { alt: 'Issued with Field Sales' },
    'col.seq': { alt: 'S.No' },
  })));
  const h = page(doc);
  const z = zatcaPrintDecision({ isReturn: false, buyerHasTaxNumber: true, saudi: true }, doc.zatca);
  assert.equal(z.qr.source, 'stamped');
  assert.ok(z.qr.caption && h.includes(z.qr.caption), 'تعليق القرار العربي تغيّر');
  assert.ok(h.includes('ZATCA-approved invoice QR'), 'نصّ الشركة الثاني لتعليق الرمز غائب');
  assert.ok(h.includes('صدرت عبر منصة') && h.includes('Issued with Field Sales'), 'سطر المنصّة بلا نصّ الشركة الثاني');
  assert.ok(h.includes('S.No'), 'نصّ «#» الثاني غائب');
  assert.ok(h.includes('alt="QR"'), 'الرمز المختوم سقط');
  assert.ok(h.includes(`ICV 41 · ${UUID}`), 'سطر ICV/UUID تغيّر');
});

// ═══ C-G6 ═══

test('C-G6 عنوان الإشعار المدين: صياغته تُطبع وحذفه يُسقطه على A4 والرول والقالب ثنائي اللغة — والرمز المختوم باقٍ', async () => {
  const NEW = 'إشعار مدين ضريبي';
  const reworded = debitNote(co(texts({ 'inv.debitTitle': { text: NEW, alt: 'Tax Debit Note' } })));
  const a4 = page(reworded);
  const r = await roll(reworded);
  const g = grid(reworded);
  for (const [name, h] of [['A4', a4], ['الرول', r], ['ثنائي اللغة', g]] as const) {
    assert.ok(h.includes(NEW), `${name}: صياغة العنوان غائبة`);
    assert.ok(h.includes('Tax Debit Note'), `${name}: نصّ العنوان الثاني غائب`);
  }
  assert.ok(a4.includes('alt="QR"') && g.includes('alt="QR"') && r.includes('class="qrbox"'), 'الرمز المختوم سقط');
  const hidden = debitNote(co(texts({ 'inv.debitTitle': { hidden: true } })));
  const a4h = page(hidden);
  const rh = await roll(hidden);
  const gh = grid(hidden);
  for (const [name, h] of [['A4', a4h], ['الرول', rh], ['ثنائي اللغة', gh]] as const) {
    assert.ok(!h.includes('إشعار مدين'), `${name}: العنوان المحذوف مطبوع`);
    assert.ok(!h.includes('Debit Note'), `${name}: ترجمة العنوان المحذوف مطبوعة`);
  }
  assert.ok(a4h.includes('alt="QR"') && gh.includes('alt="QR"') && rh.includes('class="qrbox"'), 'الرمز المختوم سقط مع العنوان');
  // بلا نصوص: «إشعار مدين» كاليوم
  assert.ok(page(debitNote(co(null))).includes('إشعار مدين'));
  // inv.title لا يمسّ عنوان الإشعار المدين
  assert.ok(page(debitNote(co(texts({ 'inv.title': { hidden: true } })))).includes('إشعار مدين'));
});

// ═══ R-G2 ═══

test('R-G2 «الأصل/نسخة»: بالعربية لفاتورة/سند شركةٍ لها نصوص على جهازٍ بواجهة إنجليزية — وبلغة الواجهة بلا نصوص ولغير الفاتورة والسند', () => {
  const docCopyLabels = (RD as unknown as { docCopyLabels?: (d: RD.AnyDoc, tr: (s: string) => string) => [string, string] }).docCopyLabels;
  assert.equal(typeof docCopyLabels, 'function', 'docCopyLabels غير موجود');
  const enTr = (s: string) => (s === 'الأصل' ? 'Original' : s === 'نسخة' ? 'Copy' : s);
  const on = co(texts({ 'h.phone': { text: 'الهاتف' } }, { secondLang: null }));
  assert.deepEqual(docCopyLabels!(invStd(on), enTr), ['الأصل', 'نسخة']);
  assert.deepEqual(docCopyLabels!(receipt(on), enTr), ['الأصل', 'نسخة']);
  assert.deepEqual(docCopyLabels!(invStd(co(null)), enTr), ['Original', 'Copy']);
  assert.deepEqual(docCopyLabels!(receipt({ ...COMPANY }), enTr), ['Original', 'Copy']);
  // إعدادٌ تالف أو بلا أثر = بلا نصوص
  assert.deepEqual(docCopyLabels!(invStd({ ...COMPANY, printTexts: { version: 2 } }), enTr), ['Original', 'Copy']);
  const ln: LoadNoticeDoc = { kind: 'loadNotice', company: on, repName: 'أحمد', date: '2026-10-31T09:00:00', movementKind: 'LOAD', items: [{ name: 'ماء', qty: 5 }] };
  assert.deepEqual(docCopyLabels!(ln, enTr), ['Original', 'Copy']);
});

// ═══ C-G7 ═══

const st = (c: Company): StatementDoc => ({
  kind: 'statement', company: c, customer: { name: 'بقالة النور', taxNumber: '399999999999993' }, repName: 'أحمد السالم', date: '2026-10-31T09:00:00',
  fromDate: '2026-10-01', toDate: '2026-10-31', timezone: 'Asia/Riyadh', openingBalance: 10, totalDebit: 52.75, totalCredit: 20, finalBalance: 42.75,
  entries: [{ date: '2026-10-05T09:00:00', description: 'فاتورة', ref: 'INV-777', debit: 52.75, credit: 0, balance: 62.75, type: 'INVOICE_DEBIT' }],
});
const ln = (c: Company): LoadNoticeDoc => ({ kind: 'loadNotice', company: c, repName: 'أحمد', date: '2026-10-31T09:00:00', movementKind: 'LOAD', items: [{ name: 'ماء', qty: 5 }] });
const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

test('C-G7 ترويسة كشف الحساب وإشعار التحميل تتبع النصوص: صياغة الرقم الضريبي وحذف الهاتف واسم الشركة بلغتها الثانية', () => {
  const c = co(texts({ 'h.taxNumber': { text: 'الرقم الضريبي للمنشأة' }, 'h.phone': { hidden: true } }, { companyNameAlt: 'Test Distribution Co.' }));
  for (const [name, html] of [
    ['كشف', renderToStaticMarkup(createElement(PrintableStatement, { doc: st(c) }))],
    ['إشعار', renderToStaticMarkup(createElement(PrintableLoadNotice, { doc: ln(c) }))],
  ] as const) {
    assert.ok(html.includes('الرقم الضريبي للمنشأة'), `${name}: صياغة الرقم الضريبي غائبة`);
    assert.ok(!html.includes('0501234567'), `${name}: الهاتف المحذوف مطبوع`);
    assert.ok(html.includes('Test Distribution Co.'), `${name}: اسم الشركة باللغة الثانية غائب`);
    assert.ok(html.includes('300000000000003'), `${name}: الرقم الضريبي نفسه سقط`);
  }
});

test('C-G7 بلا نصوص: ترويسة كشف الحساب وإشعار التحميل كاليوم حرفاً بحرف (بصمة f2645e0)', () => {
  // البصمتان من مخرج f2645e0 نفسه (قبل الإصلاح) — شركةٌ بلا نصوص لا يتغيّر في ورقتها حرف
  for (const raw of [undefined, null, { version: 2 }]) {
    const c: Company = { ...COMPANY, printTexts: raw };
    assert.equal(sha(renderToStaticMarkup(createElement(PrintableStatement, { doc: st(c) }))), STATEMENT_SHA, `كشف ${JSON.stringify(raw)}`);
    assert.equal(sha(renderToStaticMarkup(createElement(PrintableLoadNotice, { doc: ln(c) }))), NOTICE_SHA, `إشعار ${JSON.stringify(raw)}`);
  }
});

const STATEMENT_SHA = 'e59e0b3617255f94';
const NOTICE_SHA = '896953e60faeef22';
