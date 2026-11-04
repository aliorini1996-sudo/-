/**
 * مصفوفة «حذف السطر» (طلب المالك ٣ نوفمبر ٢٠٢٦، pl_spec v2 — الحزمة P4b): كل مفتاحٍ في PRINT_TEXT_LINE للفاتورة والسند والمشترك
 * يُحذف وحده على كل قالب — A4 الحالي، و«كلاسيكي بإطارات — ثنائي اللغة»، والرول المختصر والمفصّل — فتسقط وحدته ولا يتغيّر غيرها.
 *
 * الطريقة: كل عبارةٍ تُعاد صياغتها بوسمٍ فريد (⟪k12⟫) — والصياغة مسموحةٌ لكل مفتاح الآن — فيُعرف من الورقة أيّ عبارةٍ طُبعت. ثم
 * يُحذف مفتاحٌ واحد ويُقارن:
 *   ١) وسمه غاب، وقيمته (إن كانت في المستند) نقص عددها — فالسطر كلّه سقط لا تسميته وحدها؛
 *   ٢) لم يغب وسمٌ آخر إلا ما تحويه وحدته (صفوف الصندوق المحذوف، أو قرينه في الوحدة نفسها: السعر/شامل الضريبة…)؛
 *   ٣) مفتاحٌ لا موضع له في القالب لا يغيّر الورقة حرفاً؛
 *   ٤) في القالب ثنائي اللغة لا يبقى عنصرٌ يحمل data-line للمفتاح (العربي والإنجليزي والقيمة معاً)؛
 *   ٥) رمز المرحلة الثانية المختوم باقٍ دائماً.
 * ثم: كل المفاتيح محذوفةً معاً بكل ترتيبٍ للأقسام والرمز باقٍ؛ وبقية المستندات (الكشف والإشعارات) لا تتأثّر بالنصوص.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PrintableInvoice, PrintableLoadNotice, PrintableReceipt, PrintableStatement,
  type Company, type InvoiceDoc, type LoadNoticeDoc, type ReceiptDoc, type StatementDoc,
} from './RepDocuments';
import { DEFAULT_PRINT_LOOK, PrintLookContext, lookFor, type PrintLook } from './printLook';
import { printThermalInvoice, printThermalReceipt, type ThermalPrintOptions } from './thermal';
import { PrintTextsPreviewContext } from './printTextsContext';
import {
  defaultPrintLayout, defaultPrintOptions, presetPaper, sectionsFor, withDesign,
  type PrintLayout, type PrintProfile, type SectionId,
} from '../lib/print/printSettings';
import { PRINT_TEXT_CATALOG, PRINT_TEXT_LINE, type PrintTextsV1 } from '../lib/print/printTexts';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { geometry } from '../lib/print/printSettings';
import { sampleInvoiceDoc } from '../lib/print/calibration';
import { TEMPLATE_WIDTH_PX, LAYOUT_BREAK_CSS, buildPageDocument, gridSheetHeightPx, pagePrintGeom } from './printPage';
import { layoutPageStarts, type KeepBox } from './pdf';
import { readFileSync } from 'node:fs';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

// ─── المستندات ───

const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا شارع التحلية', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: LOGO, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
  addrCity: 'الرياض', addrPostalCode: '12211',
};
const B2B = {
  name: 'محمد العتيبي', businessName: 'مؤسسة الأفق', commercialReg: '1010202020', taxNumber: '311111111111113', phone: '0112345678',
  address: 'طريق الملك فهد', city: 'جدة', postalCode: '23456',
};
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c', icv: 41, warnings: 0, ...over,
});
const ITEMS: InvoiceDoc['items'] = [
  { name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46, code: 'P-100', taxAmt: 6 },
  { name: 'عصير برتقال', unit: 'حبة', qty: 3, unitPrice: 2.5, discountPct: 10, taxPct: 15, lineTotal: 6.75, code: 'P-200', taxAmt: 0.88, multiUnit: true },
];

/** قياسية B2B بالمرحلة الثانية مختومة، آجلة بأقساط، شاملة الضريبة بخصم بند، وتاريخ تسليم وتوقيعان */
const invStd = (): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-777', date: '2026-11-02T09:15:00.000Z', type: 'CREDIT', company: COMPANY, customer: B2B, repName: 'أحمد السالم',
  deliveryDate: '2026-11-05T00:00:00.000Z', recipientSignature: SIG, repSignature: SIG, items: ITEMS,
  subtotal: 48.5, discount: 2.5, tax: 6.88, total: 52.75, pricesIncludeTax: true, paidAmt: 21.5, remainingAmt: 31.25,
  paymentPlan: 'INSTALLMENT', installments: [
    { seq: 1, dueDate: '2026-12-02T00:00:00.000Z', amount: 26.38 }, { seq: 2, dueDate: '2027-01-02T00:00:00.000Z', amount: 26.37 },
  ],
  zatca: zv(),
});
/** مبسّطة بالمرحلة الأولى (رمزها من رقم البائع)، نقدية غير شاملة بخصم على الفاتورة */
const invSimple = (): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-778', date: '2026-11-02T10:00:00.000Z', type: 'CASH', company: COMPANY,
  customer: { name: 'بقالة الحي', phone: '0533333333', address: 'حي النسيم', city: 'الرياض' }, repName: 'أحمد السالم',
  items: ITEMS.map((it) => ({ ...it, unitPrice: it.unitPrice / 1.15, lineTotal: Math.round((it.lineTotal / 1.15) * 100) / 100 })),
  subtotal: 46.87, discount: 1.5, tax: 6.8, total: 52.17, pricesIncludeTax: false, paidAmt: 52.17, remainingAmt: 0,
});
/** إشعار دائن (مرتجع) بمرجع الفاتورة الأصلية وسببه */
const creditNote = (): InvoiceDoc => ({
  ...invStd(), number: 'RET-55', isReturn: true, paymentPlan: null, installments: undefined, paidAmt: undefined, remainingAmt: undefined,
  billingReference: 'INV-500', noteReason: 'بضاعة تالفة', zatca: zv({ documentKind: 'CREDIT_NOTE' } as Partial<ZatcaDocView>),
});
/** إشعار مدين بالمرحلة الثانية — عنوانه بمفتاحه inv.debitTitle (طلب المالك ٤ نوفمبر ٢٠٢٦) */
const debitNote = (): InvoiceDoc => ({ ...invStd(), number: 'DN-12', zatca: zv({ documentKind: 'DEBIT_NOTE' } as Partial<ZatcaDocView>) });
const rcpOne = (): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-02T11:00:00.000Z', company: COMPANY,
  customer: { name: 'بقالة النور', businessName: 'مؤسسة النور', commercialReg: '4030303030', taxNumber: '399999999999993', phone: '0559998887', address: 'حي الروضة' },
  repName: 'أحمد السالم', amount: 150, paymentMethod: 'CASH', notes: 'دفعة نوفمبر', invoices: [{ number: 'INV-901', amount: 150 }],
});
const rcpMany = (): ReceiptDoc => ({ ...rcpOne(), number: 'RC-56', amount: 300, invoices: [{ number: 'INV-901', amount: 100 }, { number: 'INV-902', amount: 50 }] });

type Doc = InvoiceDoc | ReceiptDoc;
const DOCS: Record<string, () => Doc> = { invStd, invSimple, creditNote, debitNote, rcpOne, rcpMany };
const PHASE2 = new Set(['invStd', 'creditNote', 'debitNote']);

// ─── النصوص: كل عبارةٍ بوسمٍ فريد، وحذف مفتاحٍ واحد ───

const KEYS = PRINT_TEXT_CATALOG.map((e) => e.key);
const TOKEN: Record<string, string> = Object.fromEntries(KEYS.map((k, i) => [k, `⟪k${i}⟫`]));
const tokensText = (deleted: readonly string[] = []): PrintTextsV1 => ({
  version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null,
  edits: Object.fromEntries(KEYS.map((k) => [k, { text: TOKEN[k], alt: null, hidden: deleted.includes(k) }])),
});
const deleteOnly = (deleted: readonly string[]): PrintTextsV1 => ({
  version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null,
  edits: Object.fromEntries(deleted.map((k) => [k, { text: null, alt: null, hidden: true }])),
});
const withTexts = <D extends Doc>(doc: D, t: PrintTextsV1 | null): D => ({ ...doc, company: { ...doc.company!, printTexts: t } });

// ─── القوالب ───

const pageProfile = (layout?: PrintLayout): PrintProfile => ({
  id: 'p-a4', name: 'A4', printer: 'page', template: 'page_branded', paper: presetPaper('a4')!,
  options: { ...defaultPrintOptions('page'), ...(layout ? { layout } : {}) },
});
const GRID_PROFILE = withDesign(pageProfile(), 'grid_bilingual');
const GRID_LOOK = lookFor(GRID_PROFILE);
const gridLookWith = (order: readonly SectionId[]): PrintLook => lookFor({ ...GRID_PROFILE, options: { ...GRID_PROFILE.options, layout: { ...GRID_PROFILE.options.layout!, order: [...order] } } });
const standardLookWith = (order: readonly SectionId[]): PrintLook => lookFor(pageProfile({ ...defaultPrintLayout('page'), order: [...order] }));
const rollProfile = (template: 'roll_compact' | 'roll_detailed'): PrintProfile => ({
  id: `van-${template}`, name: 'سيارة', printer: 'thermal', template, paper: presetPaper('roll80')!,
  options: { ...defaultPrintOptions('thermal'), showLogo: true },
});

/** الصور المضمّنة (الشعار والتوقيع والرمز) تُطبَّع — فلا يطابق وسمٌ نصّاً داخل base64 */
const norm = (h: string): string => h.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, 'data:IMG');
const page = (doc: Doc, look: PrintLook): string => norm(renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: look },
  doc.kind === 'invoice' ? createElement(PrintableInvoice, { doc }) : createElement(PrintableReceipt, { doc })) as ReactElement));
async function roll(doc: Doc, p: PrintProfile): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile: p, tr: (s: string) => s, capture: (h: string) => { out = h; } };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  assert.ok(out, 'لم تُلتقط وثيقة الرول');
  return norm(out);
}

type Renderer = { name: string; grid?: boolean; roll?: boolean; run: (doc: Doc) => string | Promise<string> };
const RENDERERS: Renderer[] = [
  { name: 'A4', run: (d) => page(d, DEFAULT_PRINT_LOOK) },
  { name: 'grid', grid: true, run: (d) => page(d, GRID_LOOK) },
  { name: 'roll-compact', roll: true, run: (d) => roll(d, rollProfile('roll_compact')) },
  { name: 'roll-detailed', roll: true, run: (d) => roll(d, rollProfile('roll_detailed')) },
];

// ─── الوحدات: ما يجوز أن يغيب مع المفتاح ───

const keysOfGroup = (group: string, docs: readonly string[]): string[] =>
  PRINT_TEXT_CATALOG.filter((e) => e.group === group && docs.includes(e.doc)).map((e) => e.key);
/** الصندوق/القسم يُسقط صفوفه؛ والعمود والصفّ ما يحويانه (نسبة الضريبة داخل عمود مبلغها، والوقت داخل صفّ التاريخ) */
const CHILDREN: Record<string, readonly string[]> = {
  'inv.infoHeading': keysOfGroup('info', ['invoice']),
  'inv.returnInfoHeading': keysOfGroup('info', ['invoice']),
  'cust.heading': keysOfGroup('customer', ['invoice', 'shared']),
  'sel.heading': keysOfGroup('seller', ['invoice']),
  'inst.heading': keysOfGroup('installments', ['invoice']),
  'rcp.customerHeading': keysOfGroup('customer', ['receipt']),
  'rcp.amount': keysOfGroup('amount', ['receipt']),
  'rcp.forInvoices': ['rcp.invoiceNo', 'rcp.credit'],
  'col.vatAmount': ['col.tax'],
  // «قبل الضريبة» سطرٌ تحت سعر البند — جزءٌ من عمود السعر
  'col.price': ['item.beforeTax'],
  'col.priceIncl': ['item.beforeTax'],
  'inv.date': ['inv.time'],
  'rcp.date': ['rcp.time'],
};
/** قرائن الوحدة الواحدة (D5): حذف أيٍّ منها يُسقط الوحدة المشتركة */
const PAIRS: readonly (readonly string[])[] = [
  ['col.price', 'col.priceIncl'], ['tot.vat', 'tot.vatIncl'], ['tot.grand', 'tot.due', 'tot.returnGrand'],
  ['inv.number', 'inv.returnNumber'], ['inv.title', 'inv.returnTitle', 'inv.debitTitle'], ['inv.infoHeading', 'inv.returnInfoHeading'],
];
/** في الرول المفصّل خصم البند سطرٌ تحت اسمه داخل خلية الصنف */
const ROLL_CHILDREN: Record<string, readonly string[]> = { 'col.item': ['col.discount'] };
function mayVanish(key: string, r: Renderer): Set<string> {
  const out = new Set<string>([key, ...(CHILDREN[key] ?? []), ...((r.roll && ROLL_CHILDREN[key]) || [])]);
  for (const p of PAIRS) if (p.includes(key)) for (const k of p) { out.add(k); for (const c of CHILDREN[k] ?? []) out.add(c); }
  return out;
}

/** قيمة السطر في المستندات أعلاه — حذف السطر يُنقص عددها (لا التسمية وحدها) */
const VALUES: Record<string, readonly string[]> = {
  'h.taxNumber': ['300000000000003'], 'h.commercialReg': ['1010101010'], 'h.phone': ['0501234567'], 'h.email': ['info@example.sa'],
  'h.address': ['حي العليا شارع التحلية'],
  'inv.number': ['INV-777', 'INV-778'], 'inv.returnNumber': ['RET-55'], 'inv.rep': ['أحمد السالم'],
  'inv.originalRef': ['INV-500'], 'inv.noteReason': ['بضاعة تالفة'],
  'cust.name': ['محمد العتيبي', 'بقالة الحي'], 'cust.business': ['مؤسسة الأفق'], 'cust.commercialReg': ['1010202020'],
  'cust.taxNumber': ['311111111111113'], 'cust.phone': ['0112345678', '0533333333'], 'cust.address': ['طريق الملك فهد', 'حي النسيم'],
  'cust.city': ['جدة'], 'cust.postalCode': ['23456'],
  'sel.name': ['شركة الاختبار للتوزيع'], 'sel.address': ['حي العليا شارع التحلية'], 'sel.postalCode': ['12211'], 'sel.taxNumber': ['300000000000003'],
  'col.item': ['مياه معدنية', 'عصير برتقال'], 'col.code': ['P-100', 'P-200'],
  'rcp.number': ['RC-55', 'RC-56'], 'rcp.rep': ['أحمد السالم'], 'rcp.from': ['بقالة النور'], 'rcp.business': ['مؤسسة النور'],
  'rcp.commercialReg': ['4030303030'], 'rcp.taxNumber': ['399999999999993'], 'rcp.phone': ['0559998887'], 'rcp.address': ['حي الروضة'],
  'rcp.notes': ['دفعة نوفمبر'], 'rcp.forInvoice': ['INV-901'], 'rcp.forInvoices': ['INV-901', 'INV-902'],
};
const count = (h: string, s: string): number => h.split(s).length - 1;
const qrPresent = (h: string, r: Renderer): boolean => (r.roll ? h.includes('class="qrbox"') : h.includes('alt="QR"'));
const keysFor = (doc: Doc): string[] => PRINT_TEXT_CATALOG
  .filter((e) => e.doc === 'shared' || e.doc === (doc.kind === 'invoice' ? 'invoice' : 'receipt')).map((e) => e.key);

/** المفاتيح التي ظهر وسمها على قالبٍ واحدٍ على الأقل، وما غيّر حذفُه ورقةً بلا تسمية — حارس التغطية في آخر الملف */
const exercised = new Set<string>();
const affected = new Set<string>();

test('حارس المصفوفة: PRINT_TEXT_LINE يغطّي القائمة كلّها، وكل مفتاحٍ لمستند فاتورة أو سند أو مشترك', () => {
  assert.deepEqual(Object.keys(PRINT_TEXT_LINE).sort(), [...KEYS].sort());
  for (const e of PRINT_TEXT_CATALOG) assert.ok(['invoice', 'receipt', 'shared'].includes(e.doc), e.key);
  // الوسوم لا يحوي أحدها آخر
  for (const a of KEYS) for (const b of KEYS) if (a !== b) assert.ok(!TOKEN[a].includes(TOKEN[b]), `${a}/${b}`);
});

/**
 * وحداتٌ بلا تسمية مطبوعة في قالبٍ ما — قيمةٌ وحدها: اسم الشركة في التذييل، والعنوان في سطر الرول، ووقت الإصدار ونسبة الضريبة
 * (مقطعان في القالب ثنائي اللغة)، وأعمدة الرول المختصر (لا رؤوس له)، وصندوقا الطرفين في ثنائي اللغة (لا عنوان مطبوع لهما).
 * يُقبل تغييرها الورقةَ بشرط أن يكون نقصاً لا إضافة ولا تبديل (لا وسم سقط معها إلا ما تحويه وحدتها — يُفحص أعلاه).
 */
const LABELLESS: Readonly<Record<string, readonly string[]>> = {
  A4: ['foot.company'],
  grid: ['foot.company', 'inv.time', 'rcp.time', 'col.tax', 'cust.heading', 'sel.heading'],
  'roll-compact': ['foot.company', 'h.address', 'col.item', 'col.qty', 'col.price', 'col.priceIncl', 'col.total', 'col.discount'],
  'roll-detailed': ['foot.company', 'h.address'],
};
/** محذوفٌ من الوثيقة بلا إضافة: كل محرفٍ من الناتج في مكانه من الأصل بالترتيب (تتابعٌ جزئيّ) */
function isDeletionOf(out: string, base: string): boolean {
  if (out.length >= base.length) return false;
  let i = 0;
  for (let j = 0; j < base.length && i < out.length; j++) if (base[j] === out[i]) i++;
  return i === out.length;
}

/** أخطاء المصفوفة لقالبٍ واحد على كل المستندات — فارغةٌ = كل حذفٍ أسقط وحدته وحدها */
async function matrixErrors(r: Renderer): Promise<string[]> {
  const errors: string[] = [];
  const check = (ok: boolean, msg: string) => { if (!ok) errors.push(msg); };
  for (const [docName, mk] of Object.entries(DOCS)) {
    const base = await r.run(withTexts(mk(), tokensText()));
    const present = KEYS.filter((k) => base.includes(TOKEN[k]));
    for (const k of present) exercised.add(k);
    if (PHASE2.has(docName)) check(qrPresent(base, r), `${r.name}/${docName}: الرمز غائبٌ قبل الحذف`);
    for (const key of keysFor(mk())) {
      const out = await r.run(withTexts(mk(), tokensText([key])));
      const at = `${r.name}/${docName}/${key}`;
      if (out !== base) affected.add(key);
      check(!out.includes(TOKEN[key]), `${at}: العبارة بقيت بعد حذف سطرها`);
      const allowed = mayVanish(key, r);
      const vanished = present.filter((k) => !out.includes(TOKEN[k]));
      const stray = vanished.filter((k) => !allowed.has(k));
      check(stray.length === 0, `${at}: سقطت معه عباراتٌ خارج وحدته: ${stray.join(',')}`);
      if (PHASE2.has(docName)) check(qrPresent(out, r), `${at}: الرمز المختوم سقط`);
      if (vanished.length === 0) {
        if (out === base) continue;
        if ((LABELLESS[r.name] ?? []).includes(key) && isDeletionOf(out, base)) continue;
        errors.push(`${at}: لا موضع لعبارته في هذا القالب لكنه غيّر الورقة`);
        continue;
      }
      for (const v of VALUES[key] ?? []) {
        const before = count(base, v);
        if (before > 0) check(count(out, v) < before, `${at}: قيمة السطر «${v}» بقيت — حُذفت التسمية وحدها`);
      }
      if (r.grid) check(!new RegExp(`data-line="(?:[^"]* )?${key.replace('.', '\.')}(?: [^"]*)?"`).test(out), `${at}: بقي عنصرٌ من وحدته (data-line)`);
    }
  }
  return errors;
}

for (const r of RENDERERS) {
  test(`حذف السطر (${r.name}): كل مفتاحٍ يُسقط وحدته كاملة ولا يتغيّر غيرها، والرمز المختوم باقٍ`, async () => {
    assert.deepEqual(await matrixErrors(r), []);
  });
}

test('المصفوفة تلتقط قالباً يتجاهل الحذف أو يحذف التسمية وحدها (برهان أنها تفشل قبل الإصلاح)', async () => {
  // قالبٌ يتجاهل الحذف: معاينة المحرّر ترسم المحذوف مشطوباً حاضراً — كقالب اليوم قبل الطلب للمفاتيح المقفلة
  const ignoring: Renderer = {
    name: 'A4', run: (d) => norm(renderToStaticMarkup(createElement(PrintTextsPreviewContext.Provider, { value: { onPick: () => {}, active: null } },
      createElement(PrintLookContext.Provider, { value: GRID_LOOK }, d.kind === 'invoice' ? createElement(PrintableInvoice, { doc: d }) : createElement(PrintableReceipt, { doc: d }))) as ReactElement)),
  };
  const e1 = await matrixErrors(ignoring);
  assert.ok(e1.some((m) => m.includes('cust.taxNumber: العبارة بقيت')), 'لم تلتقط تجاهل الحذف');
  // قالبٌ يحذف التسمية وحدها: يُعيد القيمة بعد الحذف
  const labelOnly: Renderer = {
    name: 'A4', run: (d) => {
      const h = page(d, DEFAULT_PRINT_LOOK);
      const t = (d.company?.printTexts as PrintTextsV1 | null)?.edits ?? {};
      return t['cust.taxNumber']?.hidden ? `${h}<span>311111111111113</span>` : h;
    },
  };
  const e2 = await matrixErrors(labelOnly);
  assert.ok(e2.some((m) => m.includes('cust.taxNumber: قيمة السطر «311111111111113» بقيت')), 'لم تلتقط حذف التسمية وحدها');
});

test('التغطية: كل مفتاحٍ طُبع وحُذف على قالبٍ واحدٍ على الأقل — والقالب ثنائي اللغة يطبع مفاتيحه الجديدة', async () => {
  // تُعاد هنا إن شُغِّل الاختبار وحده (--test-name-pattern)
  if (exercised.size === 0) {
    for (const r of RENDERERS) for (const mk of Object.values(DOCS)) {
      const h = await r.run(withTexts(mk(), tokensText()));
      for (const k of KEYS) if (h.includes(TOKEN[k])) exercised.add(k);
    }
  }
  if (affected.size > 0) assert.deepEqual(KEYS.filter((k) => !exercised.has(k) && !affected.has(k)), [], 'مفاتيح لم تطبعها ولم يغيّرها حذفٌ في أيّ ورقة');
  // اسم الشركة في التذييل تُطبع صياغته (foot.company) — فلا يبقى بلا موضعٍ مطبوع إلا عنوان صندوق البائع (لا عنوان مطبوع له)
  else assert.deepEqual(KEYS.filter((k) => !exercised.has(k)), ['sel.heading'], 'مفاتيح لم تطبعها أيّ ورقة في المصفوفة');
  const grid = page(withTexts(invStd(), tokensText()), GRID_LOOK);
  for (const k of ['col.seq', 'col.code', 'col.unit', 'col.vatAmount', 'sel.name', 'sel.city', 'sel.postalCode', 'cust.city', 'cust.postalCode',
    'inv.paymentType', 'sig.warehouse', 'sig.remarks', 'tot.exclVat', 'tot.due', 'foot.platform']) {
    assert.ok(grid.includes(TOKEN[k]), `ثنائي اللغة: ${k} غير مطبوع`);
  }
});

test('ثنائي اللغة: حذف العبارة يُسقط العربي والإنجليزي والقيمة معاً', () => {
  const cases: [string, string, string][] = [
    ['cust.taxNumber', 'VAT No.', '311111111111113'], ['inv.paymentType', 'Payment Type Name', 'تقسيط'],
    ['col.code', 'Item Code', 'P-100'], ['sig.warehouse', 'Warehouse', ''], ['tot.due', 'Total Amount Due', ''],
    ['sel.postalCode', 'Postal Code', '12211'], ['foot.platform', 'صدرت عبر منصة', ''],
  ];
  const base = page(withTexts(invStd(), deleteOnly([])), GRID_LOOK);
  for (const [key, en, value] of cases) {
    const out = page(withTexts(invStd(), deleteOnly([key])), GRID_LOOK);
    assert.ok(count(base, en) > count(out, en), `${key}: الإنجليزي «${en}» بقي`);
    if (value) assert.ok(count(base, value) > count(out, value), `${key}: القيمة «${value}» بقيت`);
  }
});

test('كل العبارات محذوفة بكل ترتيبٍ للأقسام: رمز المرحلة الثانية المختوم يُطبع على A4 والقالب ثنائي اللغة', () => {
  const all = deleteOnly(KEYS);
  const orders = (design: 'standard' | 'grid_bilingual'): SectionId[][] => {
    const d = [...sectionsFor('page', design)];
    const mid = d.slice(1, -2); // بين الترويسة والتواقيع/التذييل
    return [d, ['header', ...[...mid].reverse(), 'signatures', 'footer'] as SectionId[], ['header', ...mid.slice(1), mid[0], 'signatures', 'footer'] as SectionId[]];
  };
  for (const doc of [invStd(), creditNote()]) {
    for (const order of orders('standard')) {
      const h = page(withTexts(doc, all), standardLookWith(order));
      assert.ok(h.includes('alt="QR"'), `A4 ${order.join(',')}: الرمز سقط`);
    }
    for (const order of orders('grid_bilingual')) {
      const h = page(withTexts(doc, all), gridLookWith(order));
      assert.ok(h.includes('alt="QR"'), `ثنائي اللغة ${order.join(',')}: الرمز سقط`);
    }
  }
});

test('بقية المستندات (الكشف وإشعار التحميل): ترويستها تتبع النصوص (حذف سطور h.*) وجسمها لا يتأثّر — ولو حُذفت كل العبارات', () => {
  const st = (c: Company): StatementDoc => ({
    kind: 'statement', company: c, customer: { name: 'بقالة النور', taxNumber: '399999999999993' }, repName: 'أحمد السالم', date: '2026-10-31T09:00:00',
    fromDate: '2026-10-01', toDate: '2026-10-31', timezone: 'Asia/Riyadh', openingBalance: 10, totalDebit: 52.75, totalCredit: 20, finalBalance: 42.75,
    entries: [{ date: '2026-10-05T09:00:00', description: 'فاتورة', ref: 'INV-777', debit: 52.75, credit: 0, balance: 62.75, type: 'INVOICE_DEBIT' },
      { date: '2026-10-06T09:00:00', description: 'سند قبض', ref: 'RC-55', debit: 0, credit: 20, balance: 42.75, type: 'RECEIPT_CREDIT' }],
  });
  const ln = (c: Company): LoadNoticeDoc => ({ kind: 'loadNotice', company: c, repName: 'أحمد', date: '2026-10-31T09:00:00', movementKind: 'LOAD', items: [{ name: 'ماء', qty: 5 }] });
  const plain = { ...COMPANY };
  const deleted = { ...COMPANY, printTexts: deleteOnly(KEYS) };
  /* C-G7 (طلب المالك ٤ نوفمبر ٢٠٢٦): سطور الترويسة (العنوان والرقم الضريبي والسجل والهاتف والبريد) تُحذف بحذف مفاتيحها كترويسة
   * الفاتورة — ولا شيء غيرها: الورقة = ورقة اليوم بلا تلك السطور حرفاً بحرف (الجسم والتذييل كما هما) */
  const headerLines = /<div style="font-size:11.5px;color:#4b5563">.*?<\/div>/g;
  for (const [name, html, ref] of [
    ['كشف', renderToStaticMarkup(createElement(PrintableStatement, { doc: st(deleted) })), renderToStaticMarkup(createElement(PrintableStatement, { doc: st(plain) }))],
    ['إشعار', renderToStaticMarkup(createElement(PrintableLoadNotice, { doc: ln(deleted) })), renderToStaticMarkup(createElement(PrintableLoadNotice, { doc: ln(plain) }))],
  ] as const) {
    assert.ok((ref.match(headerLines) ?? []).length >= 4, `${name}: سطور الترويسة غير مرسومة أصلاً`);
    assert.equal(html, ref.replace(headerLines, ''), `${name}: حذف سطور الترويسة غيّر غيرها`);
  }
});

// ═══ مسارات إخراج A4 للقالب ثنائي اللغة: طباعة النظام وPDF والنقطية والبانيات (الحزمة P4b) ═══

test('طباعة النظام: ورقة ثنائي اللغة تُضبط على طول الصفحة بعد الهامشين وzoom — فلا تفيض صفحةً بيضاء (A4 وA5 وLetter والنقطية 1440)', () => {
  const pg = (preset: 'a4' | 'a5' | 'letter'): PrintProfile => ({ ...pageProfile(), paper: presetPaper(preset)! });
  for (const p of [pg('a4'), pg('a5'), pg('letter')]) {
    const h = gridSheetHeightPx(p);
    const g = pagePrintGeom(p);
    assert.ok(h !== null && h > 600, p.paper.preset);
    const usableCssPx = ((p.paper.lengthMm! - g.marginTopMm - g.marginBottomMm) * 96) / 25.4;
    assert.ok(h * g.zoom <= usableCssPx, `${p.paper.preset}: الورقة أطول من الصفحة`);
    assert.ok(h * g.zoom >= usableCssPx - 4, `${p.paper.preset}: الورقة أقصر من الصفحة بكثير`);
  }
  // A4: أقصر من 1123 (= حدّ القالب الأدنى) — الحدّ الأدنى وحده كان يفيض بشريطٍ إلى صفحةٍ ثانية
  assert.ok(gridSheetHeightPx(pg('a4'))! < 1123);
  // النقطية: الحزمة 1440 نقطة كما هي، والورقة بطول صفوف الصفحة بمقياس القالب (794 بكسل = 1440 نقطة)
  const impact: PrintProfile = { id: 'imp', name: 'MIP480', printer: 'impact', template: 'impact_plain', paper: presetPaper('ff_a4')!, options: defaultPrintOptions('impact') };
  const gi = geometry(impact);
  assert.equal(gi.printableDots, 1440);
  const hi = gridSheetHeightPx(impact)!;
  const rowsPx = (gi.rowsPerPage! * TEMPLATE_WIDTH_PX) / gi.printableDots!;
  assert.ok(hi <= rowsPx + 1 && hi >= rowsPx - 6, `النقطية: ${hi} مقابل ${rowsPx}`);
  // الحرارية: لا ضبط
  assert.equal(gridSheetHeightPx(rollProfile('roll_compact')), null);
});

test('وثيقة طباعة النظام: قاعدة «لا تقصّ الصفّ» لأوراق التخطيط وحدها — وثيقة كل ورقةٍ بلا تخطيط حرفاً كاليوم', () => {
  const g = pagePrintGeom(pageProfile());
  const plain = buildPageDocument(['<div>A</div>'], g, '');
  assert.ok(!plain.includes('break-inside: avoid') && !plain.includes(LAYOUT_BREAK_CSS), 'وثيقة اليوم تغيّرت');
  const grid = buildPageDocument(['<div data-print-layout="grid_bilingual">A</div>'], g, '');
  assert.ok(grid.includes(LAYOUT_BREAK_CSS));
  // الفرق القاعدة وحدها
  const other = buildPageDocument(['<div data-x="grid_bilingual">A</div>'], g, '').replace('data-x', 'data-print-layout');
  assert.equal(grid.replace(`\n    ${LAYOUT_BREAK_CSS}`, ''), other);
  // الجذر يحمل السمة التي تقرؤها printPage وpdf: ثنائي اللغة على A4 والنقطية، ولا سمة بلا تخطيط
  assert.match(page(invStd(), GRID_LOOK), /^<div style="[^"]*min-height:1123px[^"]*"[^>]* data-print-layout="grid_bilingual"/);
  assert.ok(!page(invStd(), DEFAULT_PRINT_LOOK).includes('data-print-layout'));
  const impactGrid = lookFor(withDesign({ id: 'imp', name: 'MIP480', printer: 'impact', template: 'impact_plain', paper: presetPaper('ff_a4')!, options: defaultPrintOptions('impact') }, 'grid_bilingual'));
  const ih = page(withTexts(invStd(), null), impactGrid);
  assert.ok(ih.includes('data-print-layout="grid_bilingual"') && ih.includes('data-print-look="mono'), 'النقطية: ثنائي اللغة بلا أحادي اللون');
  assert.ok(ih.includes(`data-qr-value="${STAMPED}"`), 'النقطية: خانة الرمز المختوم بقيمتها (إعادة رسمه بنقاط الإبرة)');
  // نسخة الطباعة ونسخة البلوتوث تمرّان بـcloneWithLabel نفسها: الضبط فيها لا في القالب
  const src = readFileSync(new URL('./printPage.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('if (sheetHeightPx && isGridSheet(clone)) clone.style.minHeight = `${sheetHeightPx}px`;'));
  assert.ok(src.includes('cloneWithLabel(node, label, bannerHtml, sheetPx)'));
});

test('PDF: ورقة التخطيط تُقسَّم عند حدود الصفوف — لا قصّ داخل صفّ، وصفحةٌ واحدة لما يزيد عليها بكسر', () => {
  // ثنائي اللغة بمقاس A4 (794×1123) أطول من نسبة صفحة PDF بجزءٍ من النقطة: صفحةٌ واحدة لا ثانية بشريط
  const pagePx = (841.89 / 595.28) * 794;
  assert.ok(1123 > pagePx);
  assert.deepEqual(layoutPageStarts(1123, pagePx, []), [0]);
  // صفّ يعبر حدّ الصفحة يُنقل كلّه إلى التالية
  const rows: KeepBox[] = Array.from({ length: 60 }, (_, i) => ({ top: 100 + i * 41, bottom: 141 + i * 41 }));
  const starts = layoutPageStarts(2600, pagePx, rows);
  assert.ok(starts.length >= 2);
  for (const s of starts.slice(1)) {
    assert.ok(!rows.some((r) => r.top < s && r.bottom > s), `قصٌّ داخل صفّ عند ${s}`);
    assert.ok(rows.some((r) => r.top === s), 'القصّ ليس عند أعلى صفّ');
  }
  // صندوقٌ أطول من صفحة لا يُلزم (يُقصّ كما اليوم)، ولا صفحةٌ أقصر من نصف صفحة بسبب صفّ
  assert.deepEqual(layoutPageStarts(2000, 1000, [{ top: 0, bottom: 2000 }]), [0, 1000]);
  assert.deepEqual(layoutPageStarts(2000, 1000, [{ top: 300, bottom: 1200 }]), [0, 1000]);
  // مسار اليوم (بلا سمة) لم يتغيّر: الشرط على السمة وحدها
  const src = readFileSync(new URL('./pdf.ts', import.meta.url), 'utf8');
  assert.ok(src.includes("const keep = !opts?.singlePage && el.hasAttribute?.('data-print-layout') ? keepBoxesOf(el) : null;"));
  assert.ok(src.includes('if (keep) return layoutPdf(el, canvas, keep, opts);'));
});

test('البانيات (تطبيق المندوب ولوحة الإدارة والمعايرة): رمز الصنف وضريبة السطر والرمز البريدي للمشتري على الورقة', () => {
  const rep = readFileSync(new URL('./RepApp.tsx', import.meta.url), 'utf8');
  assert.ok(rep.includes('...docItemCode(products.find(x => x.id === l.productId)?.code ?? l.code),'), 'المندوب: رمز الصنف');
  assert.ok(rep.includes('lineTotal: repCalc.items[i].lineTotal, taxAmt: repCalc.items[i].taxAmt,'), 'المندوب: ضريبة السطر');
  assert.equal((rep.match(/company, customer: docBuyer, repName, items: /g) || []).length, 3, 'المندوب: المشتري برمزه البريدي في الأوراق الثلاث');
  const modal = readFileSync(new URL('../components/forms/InvoiceModal.tsx', import.meta.url), 'utf8');
  assert.equal((modal.match(/customer: docCustomerOf\(selectedCustomer as Customer\)/g) || []).length, 2, 'اللوحة: المشتري برمزه البريدي');
  assert.ok(modal.includes('...docGridFields(Array.isArray(inv.items) ? inv.items[i] : undefined, l.productId, l.productCode),'), 'اللوحة: البيع');
  assert.ok(modal.includes('return { ...it, ...docGridFields(row, pid, (products || []).find(p => p.id === pid)?.code) };'), 'اللوحة: المرتجع');
  // المعايرة: الفاتورة النموذجية تملأ عمودي رقم الصنف وضريبة السطر في ثنائي اللغة
  const sample = sampleInvoiceDoc(COMPANY, (s: string) => s, new Date('2026-11-03T08:00:00Z'));
  assert.deepEqual(sample.items.map((it) => [it.code, it.taxAmt]), [['TST-001', 7.5], ['TST-002', 7.5]]);
  const g = page(sample, GRID_LOOK);
  assert.ok(g.includes('TST-001') && g.includes('Item Code') && g.includes('alt="QR"'));
  // والقالب الحالي لا يقرأ الحقلين: ورقة المعايرة القياسية كما كانت
  const strip = (d: InvoiceDoc): InvoiceDoc => ({ ...d, items: d.items.map(({ code: _c, taxAmt: _t, ...rest }) => rest) });
  assert.equal(page(sample, DEFAULT_PRINT_LOOK), page(strip(sample), DEFAULT_PRINT_LOOK));
});
