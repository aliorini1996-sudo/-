/**
 * مراجعة «حذف السطر» (طلب المالك ٣ نوفمبر ٢٠٢٦: «لا يوجد عبارة لا يمكن تحريرها أو حذفها») — ثلاثة عيوبٍ وجدتها المراجعة:
 *   ١) «اسم الشركة في التذييل» (foot.company): المحرّر يقبل صياغته والقوالب كانت تطبع اسم الشركة متجاهلةً الصياغة (A4 والسند
 *      والقالب ثنائي اللغة والرول).
 *   ٢) تعليق رمز المرحلة الثانية المختوم كان مكتوباً في القالب: حذف qr.caption وصياغته لا يمسّانه (والرمز نفسه يبقى دائماً).
 *   ٣) حذف عنوان صندوقٍ (وحدته block) يحذف صفوفه الإلزامية سابقاً (رقم الفاتورة وتاريخها، رقم المشتري الضريبي، بيانات البائع)
 *      بلا تنبيهٍ ولا تأكيد — لأن العنوان نفسه لم يكن مقفلاً.
 * وبلا نصوص (الافتراضي) الورقة كما هي: التعليق المختوم واسم الشركة بحرفهما.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, type Company, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { DEFAULT_PRINT_LOOK, PrintLookContext, lookFor, type PrintLook } from './printLook';
import { printThermalInvoice, printThermalReceipt } from './thermal';
import { defaultPrintOptions, newProfile, presetPaper, withDesign, type PrintProfile } from '../lib/print/printSettings';
import { PRINT_TEXT_CATALOG, PRINT_TEXT_LINE, type PrintTextsV1 } from '../lib/print/printTexts';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { deleteConfirmClass, deleteConfirmText, lineWarning } from '../components/print/PrintTextsCard';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const STAMPED_CAPTION = 'رمز الفاتورة المعتمد من هيئة الزكاة والضريبة والجمارك';
const NAME = 'شركة المراجعة للتوزيع';
const COMPANY: Company = {
  name: NAME, address: 'حي العليا', taxNumber: '300000000000003', commercialReg: '1010101010', phone: '0501234567', countryCode: 'SA',
};
const zv = (): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '02', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c', icv: 41, warnings: 0,
});
const texts = (edits: PrintTextsV1['edits']): PrintTextsV1 => ({ version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null, edits });
const inv = (t: PrintTextsV1 | null, phase2 = false): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-9', date: '2026-11-02T09:15:00.000Z', type: 'CASH', company: { ...COMPANY, printTexts: t },
  customer: { name: 'بقالة الحي' }, repName: 'أحمد',
  items: [{ name: 'مياه', unit: 'كرتون', qty: 2, unitPrice: 20, discountPct: 0, taxPct: 15, lineTotal: 46 }],
  subtotal: 40, discount: 0, tax: 6, total: 46, pricesIncludeTax: false, ...(phase2 ? { zatca: zv() } : {}),
});
const rcp = (t: PrintTextsV1 | null): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-1', date: '2026-11-02T11:00:00.000Z', company: { ...COMPANY, printTexts: t },
  customer: { name: 'بقالة النور' }, repName: 'أحمد', amount: 10, paymentMethod: 'CASH', invoices: [{ number: 'INV-9', amount: 10 }],
});
const GRID: PrintLook = lookFor(withDesign(newProfile('page', 'review', []), 'grid_bilingual'));
const page = (doc: InvoiceDoc | ReceiptDoc, look: PrintLook = DEFAULT_PRINT_LOOK): string => renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: look },
  doc.kind === 'invoice' ? createElement(PrintableInvoice, { doc }) : createElement(PrintableReceipt, { doc })) as ReactElement);
const rollProfile = (template: 'roll_compact' | 'roll_detailed'): PrintProfile => ({
  id: 'r', name: 'r', printer: 'thermal', template, paper: presetPaper('roll80')!, options: defaultPrintOptions('thermal'),
});
async function roll(doc: InvoiceDoc | ReceiptDoc, template: 'roll_compact' | 'roll_detailed'): Promise<string> {
  let out = '';
  const opts = { profile: rollProfile(template), tr: (s: string) => s, capture: (h: string) => { out = h; } };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  return out;
}
const count = (h: string, s: string): number => h.split(s).length - 1;

test('foot.company: صياغة الشركة لاسمها في التذييل تُطبع على A4 والسند وثنائي اللغة والرول — وبلا صياغة الاسم كما هو', async () => {
  const FOOT = 'مؤسسة المراجعة — الفرع الرئيسي';
  const re = texts({ 'foot.company': { text: FOOT, alt: null, hidden: false } });
  for (const [name, html] of [
    ['A4 invoice', page(inv(re))], ['A4 receipt', page(rcp(re))], ['grid invoice', page(inv(re), GRID)], ['grid receipt', page(rcp(re), GRID)],
    ['roll compact', await roll(inv(re), 'roll_compact')], ['roll detailed receipt', await roll(rcp(re), 'roll_detailed')],
  ] as const) {
    assert.ok(html.includes(FOOT), `${name}: صياغة اسم التذييل لم تُطبع`);
  }
  // بلا صياغة: اسم الشركة في التذييل كما هو (الترويسة تحمله أيضاً — فالعدد لا يتغيّر بالصياغة إلا بسطر التذييل)
  const plain = page(inv(texts({ 'h.phone': { text: 'جوال', alt: null, hidden: false } })));
  const reworded = page(inv(re));
  assert.equal(count(reworded, NAME), count(plain, NAME) - 1, 'A4: الصياغة لم تحلّ محلّ اسم التذييل');
});

test('رمز المرحلة الثانية المختوم: تعليقه يُحذف بـqr.caption ويُعاد صياغته — والرمز نفسه باقٍ، وبلا نصوص التعليق كما هو', () => {
  const base = page(inv(null, true));
  assert.ok(base.includes(STAMPED_CAPTION) && base.includes('alt="QR"'), 'الافتراضي تغيّر');
  for (const look of [DEFAULT_PRINT_LOOK, GRID]) {
    const del = page(inv(texts({ 'qr.caption': { text: null, alt: null, hidden: true } }), true), look);
    assert.ok(!del.includes(STAMPED_CAPTION), 'حذف تعليق الرمز لم يحذف تعليق المرحلة الثانية');
    assert.ok(del.includes('alt="QR"'), 'الرمز المختوم سقط مع تعليقه');
    assert.ok(del.includes('ICV 41'), 'سطر ICV سقط مع التعليق');
    const re = page(inv(texts({ 'qr.caption': { text: 'امسح الرمز للتحقق', alt: null, hidden: false } }), true), look);
    assert.ok(re.includes('امسح الرمز للتحقق') && !re.includes(STAMPED_CAPTION), 'صياغة تعليق الرمز لا تُطبع على المرحلة الثانية');
  }
  // نصوصٌ لا تمسّ التعليق: تعليق القرار كما هو
  const other = page(inv(texts({ 'h.phone': { text: 'جوال', alt: null, hidden: false } }), true));
  assert.ok(other.includes(STAMPED_CAPTION));
});

test('عنوان صندوقٍ يحذف صفوفه الإلزامية سابقاً: تنبيهٌ وتأكيدٌ مرّةً واحدة كصفوفه (لا حذفٌ صامت لرقم الفاتورة أو رقم المشتري)', () => {
  // كل عنوان block: أشدّ تنبيهٍ في صفوف مجموعته (ما يسقط معه)
  assert.equal(deleteConfirmClass('inv.infoHeading'), 'tax');
  assert.equal(deleteConfirmClass('inv.returnInfoHeading'), 'tax');
  assert.equal(deleteConfirmClass('cust.heading'), 'tax');
  assert.equal(deleteConfirmClass('sel.heading'), 'tax');
  assert.equal(lineWarning('inv.infoHeading'), 'tax');
  assert.ok(deleteConfirmText('inv.infoHeading', (s) => s)?.includes('بيانات الفاتورة'));
  // صندوقٌ لا إلزامي فيه: بلا تنبيه
  assert.equal(deleteConfirmClass('rcp.forInvoices'), null);
  // غير العناوين: تنبيه المفتاح نفسه كما كان
  for (const e of PRINT_TEXT_CATALOG) {
    if (PRINT_TEXT_LINE[e.key] === 'block') continue;
    const own = deleteConfirmClass(e.key);
    assert.equal(lineWarning(e.key) === 'tax' || lineWarning(e.key) === 'standard' ? lineWarning(e.key) : null, own, e.key);
  }
});
