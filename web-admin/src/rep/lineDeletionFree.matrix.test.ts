/**
 * «حذف السطر» مع «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦ — pd_spec، الحزمة P9): نصوص المطبوعات وتخطيطها الحرّ يعملان معاً.
 * لكل قالبٍ حرّ — A4 بشعارٍ مستقل وتنسيق أقسام، وA4 والنقطية بلوحتي رأسٍ وتذييل تحملان المربعات التسعة، وA4 بأقسامٍ مخفية،
 * والثنائي بتنسيقٍ وشعارٍ مستقل، والرول المختصر والمفصّل ونسخة الكلاسيكي بشعارٍ مستقل وتنسيق وجدول بإطار — وقرينه بتخطيط اليوم:
 *   ١) العبارات المطبوعة هي نفسها (إلا ما في قسمٍ مخفي) — التخطيط لا يضيف عبارةً ولا يُسقطها؛
 *   ٢) حذف أيّ مفتاحٍ يُسقط في الحرّ ما يُسقطه في قرينه حرفاً (الوحدة نفسها)، ومفتاحٌ في قسمٍ مخفي لا يغيّر شيئاً؛
 *   ٣) قيمة السطر تنقص في الحرّ متى نقصت في قرينه — فالسطر كله سقط لا تسميته وحدها، ولو كان داخل مربعٍ في اللوحة؛
 *   ٤) رمز المرحلة الثانية المختوم باقٍ بعد كل حذف.
 * والمصفوفة الأمّ (lineDeletion.matrix) تثبت وحدات الحذف نفسها على تخطيط اليوم.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, type Company, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { printThermalInvoice, printThermalReceipt, type ThermalPrintOptions } from './thermal';
import {
  LEGACY_THERMAL_ID, defaultPrintLayout, defaultPrintOptions, legacyPrintSettings, presetPaper,
  type LayoutDesign, type PaperPresetId, type PrintLayout, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import type { PrintCanvas } from '../lib/print/printSettingsCore';
import { PRINT_TEXT_CATALOG, type PrintTextsV1 } from '../lib/print/printTexts';
import { editableClassicCopy } from '../lib/print/designModel';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

// ─── المستندات (كالمصفوفة الأمّ) ───

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
const invStd = (): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-777', date: '2026-11-02T09:15:00.000Z', type: 'CREDIT', company: COMPANY, customer: B2B, repName: 'أحمد السالم',
  deliveryDate: '2026-11-05T00:00:00.000Z', recipientSignature: SIG, repSignature: SIG, items: ITEMS,
  subtotal: 48.5, discount: 2.5, tax: 6.88, total: 52.75, pricesIncludeTax: true, paidAmt: 21.5, remainingAmt: 31.25,
  paymentPlan: 'INSTALLMENT', installments: [
    { seq: 1, dueDate: '2026-12-02T00:00:00.000Z', amount: 26.38 }, { seq: 2, dueDate: '2027-01-02T00:00:00.000Z', amount: 26.37 },
  ],
  zatca: zv(),
});
const invSimple = (): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-778', date: '2026-11-02T10:00:00.000Z', type: 'CASH', company: COMPANY,
  customer: { name: 'بقالة الحي', phone: '0533333333', address: 'حي النسيم', city: 'الرياض' }, repName: 'أحمد السالم',
  items: ITEMS.map((it) => ({ ...it, unitPrice: it.unitPrice / 1.15, lineTotal: Math.round((it.lineTotal / 1.15) * 100) / 100 })),
  subtotal: 46.87, discount: 1.5, tax: 6.8, total: 52.17, pricesIncludeTax: false, paidAmt: 52.17, remainingAmt: 0,
});
const creditNote = (): InvoiceDoc => ({
  ...invStd(), number: 'RET-55', isReturn: true, paymentPlan: null, installments: undefined, paidAmt: undefined, remainingAmt: undefined,
  billingReference: 'INV-500', noteReason: 'بضاعة تالفة', zatca: zv({ documentKind: 'CREDIT_NOTE' } as Partial<ZatcaDocView>),
});
const rcpOne = (): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-02T11:00:00.000Z', company: COMPANY,
  customer: { name: 'بقالة النور', businessName: 'مؤسسة النور', commercialReg: '4030303030', taxNumber: '399999999999993', phone: '0559998887', address: 'حي الروضة' },
  repName: 'أحمد السالم', amount: 150, paymentMethod: 'CASH', notes: 'دفعة نوفمبر', invoices: [{ number: 'INV-901', amount: 150 }],
});
const rcpMany = (): ReceiptDoc => ({ ...rcpOne(), number: 'RC-56', amount: 300, invoices: [{ number: 'INV-901', amount: 100 }, { number: 'INV-902', amount: 50 }] });
type Doc = InvoiceDoc | ReceiptDoc;
const DOCS: Record<string, () => Doc> = { invStd, invSimple, creditNote, rcpOne, rcpMany };
const PHASE2 = new Set(['invStd', 'creditNote']);

// ─── النصوص: كل عبارةٍ بوسمٍ فريد، وحذف مفتاحٍ واحد ───

const KEYS = PRINT_TEXT_CATALOG.map((e) => e.key);
const TOKEN: Record<string, string> = Object.fromEntries(KEYS.map((k, i) => [k, `⟪k${i}⟫`]));
const tokensText = (deleted: readonly string[] = []): PrintTextsV1 => ({
  version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null,
  edits: Object.fromEntries(KEYS.map((k) => [k, { text: TOKEN[k], alt: null, hidden: deleted.includes(k) }])),
});
const withTexts = <D extends Doc>(doc: D, t: PrintTextsV1 | null): D => ({ ...doc, company: { ...doc.company!, printTexts: t } });
const keysFor = (doc: Doc): string[] => PRINT_TEXT_CATALOG
  .filter((e) => e.doc === 'shared' || e.doc === (doc.kind === 'invoice' ? 'invoice' : 'receipt')).map((e) => e.key);
/** قيم السطور في المستندات أعلاه — حذف السطر يُنقص عددها */
const VALUES: readonly string[] = [
  '300000000000003', '1010101010', '0501234567', 'info@example.sa', 'INV-500', 'بضاعة تالفة', 'محمد العتيبي', 'بقالة الحي', 'مؤسسة الأفق',
  '1010202020', '311111111111113', '0112345678', '0533333333', 'طريق الملك فهد', 'حي النسيم', '23456', 'P-100', 'مياه معدنية',
  'RC-55', 'RC-56', 'بقالة النور', 'مؤسسة النور', '4030303030', '399999999999993', '0559998887', 'حي الروضة', 'دفعة نوفمبر', 'INV-901', 'INV-902',
];

// ─── القوالب: الحرّ وقرينه بتخطيط اليوم ───

const profileOf = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard'): PrintProfile => ({
  id: `p-${template}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), showLogo: true, layout: defaultPrintLayout(printer, design) },
});
const classicCopy = (): PrintProfile => {
  const { settings, newId } = editableClassicCopy(legacyPrintSettings(), LEGACY_THERMAL_ID);
  const p = settings.profiles.find((x) => x.id === newId)!;
  return { ...p, options: { ...p.options, showLogo: true } };
};
const withFree = (p: PrintProfile, free: Partial<PrintLayout>): PrintProfile => ({ ...p, options: { ...p.options, layout: { ...p.options.layout!, ...free } } });

const CANVAS: PrintCanvas = {
  headerMm: 75, footerMm: 85,
  boxes: [
    { id: 'logo', band: 'header', x: 0, y: 0, w: 40, h: 25 },
    { id: 'company', band: 'header', x: 45, y: 0, w: 90, h: 35 },
    { id: 'title', band: 'header', x: 140, y: 0, w: 48, h: 20, align: 'end' },
    { id: 'docInfo', band: 'header', x: 0, y: 38, w: 90, h: 35, fontPct: 90 },
    { id: 'customer', band: 'header', x: 95, y: 38, w: 93, h: 35 },
    { id: 'totals', band: 'footer', x: 0, y: 0, w: 115, h: 55 },
    // مربع QR أطول من عرضه: التعليق وسطر ICV تحته (المربع المربّع يحمل الرمز وحده — RepDocuments InvoiceQrBlock fit)
    { id: 'qr', band: 'footer', x: 125, y: 0, w: 63, h: 82 },
    { id: 'signatures', band: 'footer', x: 0, y: 58, w: 60, h: 25 },
    { id: 'footer', band: 'footer', x: 62, y: 58, w: 60, h: 25 },
  ],
};
const STYLES = { header: { align: 'center', fontPct: 120 }, info: { spaceBeforeMm: 4 }, totals: { align: 'end', fontPct: 110 }, footer: { fontPct: 80 } } as const;

interface Pair { name: string; kind: 'sheet' | 'roll'; plain: PrintProfile; free: PrintProfile; hidden?: boolean }
const pair = (name: string, kind: Pair['kind'], plain: PrintProfile, free: Partial<PrintLayout>, hidden = false): Pair =>
  ({ name, kind, plain, free: withFree(plain, free), hidden });
const ROLL_FREE: Partial<PrintLayout> = {
  logo: 'end', logoMm: 20, logoAfter: 'customer', tableStyle: 'grid',
  sections: { header: { align: 'start', fontPct: 130 }, totals: { align: 'end', spaceBeforeMm: 3 }, footer: { fontPct: 70 } },
};
const PAIRS: Pair[] = [
  pair('A4-free', 'sheet', profileOf('page', 'page_branded', 'a4'), { logoAfter: 'top', logoMm: 30, sections: STYLES }),
  pair('A4-canvas', 'sheet', profileOf('page', 'page_branded', 'a4'), { canvas: CANVAS, sections: STYLES }),
  pair('A4-hidden', 'sheet', profileOf('page', 'page_plain', 'a4'), { sections: { note: { visible: false }, installments: { visible: false }, info: { visible: false } } }, true),
  pair('impact-canvas', 'sheet', profileOf('impact', 'impact_plain', 'ff_a4'), { canvas: CANVAS, logoMm: 20 }),
  pair('grid-free', 'sheet', profileOf('page', 'page_branded', 'a4', 'grid_bilingual'), { logoAfter: 'items', logoMm: 25, sections: { header: { align: 'end', fontPct: 120 }, totals: { spaceBeforeMm: 2 } } }),
  pair('roll-compact-free', 'roll', profileOf('thermal', 'roll_compact', 'roll80'), ROLL_FREE),
  pair('roll-detailed-free', 'roll', profileOf('thermal', 'roll_detailed', 'roll80'), ROLL_FREE),
  pair('classic-copy-free', 'roll', classicCopy(), { ...ROLL_FREE, logo: 'center' }),
];

// ─── التصيير ───

const norm = (h: string): string => h.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, 'data:IMG');
const sheet = (p: PrintProfile, doc: Doc): string => norm(renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: lookFor(p) },
  doc.kind === 'invoice' ? createElement(PrintableInvoice, { doc }) : createElement(PrintableReceipt, { doc })) as ReactElement));
async function roll(p: PrintProfile, doc: Doc): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile: p, tr: (s: string) => s, capture: (h: string) => { out = h; } };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  assert.ok(out, 'لم تُلتقط وثيقة الرول');
  return norm(out);
}
const run = (kind: Pair['kind'], p: PrintProfile, doc: Doc): string | Promise<string> => (kind === 'roll' ? roll(p, doc) : sheet(p, doc));
const count = (h: string, s: string): number => h.split(s).length - 1;
const qrPresent = (kind: Pair['kind'], h: string): boolean => (kind === 'roll' ? h.includes('class="qrbox"') : h.includes('alt="QR"'));
const tokensIn = (h: string): Set<string> => new Set(KEYS.filter((k) => h.includes(TOKEN[k])));

/** أخطاء قالبٍ حرّ مقابل قرينه — `mutate` يحاكي قالباً حرّاً معيباً (برهان الفشل) */
async function pairErrors(pr: Pair, mutate: (h: string, deleted: string | null) => string = (h) => h): Promise<string[]> {
  const errors: string[] = [];
  for (const [docName, mk] of Object.entries(DOCS)) {
    const baseP = await run(pr.kind, pr.plain, withTexts(mk(), tokensText()));
    const baseF = mutate(await run(pr.kind, pr.free, withTexts(mk(), tokensText())), null);
    const presP = tokensIn(baseP);
    const presF = tokensIn(baseF);
    const extra = [...presF].filter((k) => !presP.has(k));
    if (extra.length) errors.push(`${pr.name}/${docName}: عباراتٌ لا يطبعها تخطيط اليوم: ${extra.join(',')}`);
    if (!pr.hidden) {
      const missing = [...presP].filter((k) => !presF.has(k));
      if (missing.length) errors.push(`${pr.name}/${docName}: التخطيط الحرّ أسقط عبارات: ${missing.join(',')}`);
    }
    if (PHASE2.has(docName) && !qrPresent(pr.kind, baseF)) errors.push(`${pr.name}/${docName}: الرمز غائب قبل الحذف`);
    for (const key of keysFor(mk())) {
      const at = `${pr.name}/${docName}/${key}`;
      const outP = await run(pr.kind, pr.plain, withTexts(mk(), tokensText([key])));
      const outF = mutate(await run(pr.kind, pr.free, withTexts(mk(), tokensText([key]))), key);
      if (outF.includes(TOKEN[key])) errors.push(`${at}: العبارة بقيت بعد حذف سطرها`);
      const goneP = [...presP].filter((k) => !outP.includes(TOKEN[k]) && presF.has(k)).sort();
      const goneF = [...presF].filter((k) => !outF.includes(TOKEN[k])).sort();
      if (goneP.join() !== goneF.join()) errors.push(`${at}: سقط في الحرّ [${goneF.join(',')}] وفي اليوم [${goneP.join(',')}]`);
      if (!presF.has(key) && presP.has(key) && outF !== baseF) errors.push(`${at}: مفتاحٌ في قسمٍ مخفي غيّر الورقة`);
      for (const v of VALUES) {
        const dropP = count(outP, v) < count(baseP, v);
        if (dropP && presF.has(key) && count(baseF, v) > 0 && count(outF, v) >= count(baseF, v)) errors.push(`${at}: قيمة السطر «${v}» بقيت — حُذفت التسمية وحدها`);
      }
      if (PHASE2.has(docName) && !qrPresent(pr.kind, outF)) errors.push(`${at}: الرمز المختوم سقط`);
    }
  }
  return errors;
}

test('حارس المصفوفة: ثمانية قوالب حرّة بقرائنها، واللوحة تحمل المربعات التسعة', () => {
  assert.equal(PAIRS.length, 8);
  assert.equal(new Set(CANVAS.boxes.map((b) => b.id)).size, 9);
  for (const pr of PAIRS) assert.notDeepEqual(pr.free.options.layout, pr.plain.options.layout, pr.name);
});

for (const pr of PAIRS) {
  test(`حذف السطر مع التحرير الحرّ (${pr.name}): الوحدة نفسها كتخطيط اليوم، والقيمة تسقط مع تسميتها، والرمز باقٍ`, async () => {
    assert.deepEqual(await pairErrors(pr), []);
  });
}

test('المصفوفة تلتقط القالب الحرّ المعيب (برهان الفشل قبل الإصلاح): يتجاهل الحذف، أو يحذف التسمية وحدها، أو يُسقط الرمز', async () => {
  const pr = PAIRS[1];
  const ignoring = await pairErrors(pr, (h, deleted) => (deleted ? `${h}${TOKEN[deleted]}` : h));
  assert.ok(ignoring.some((e) => e.includes('cust.taxNumber: العبارة بقيت')), 'لم تلتقط تجاهل الحذف');
  const labelOnly = await pairErrors(pr, (h, deleted) => (deleted === 'cust.taxNumber' ? `${h}<span>311111111111113</span>` : h));
  assert.ok(labelOnly.some((e) => e.includes('cust.taxNumber: قيمة السطر «311111111111113» بقيت')), 'لم تلتقط حذف التسمية وحدها');
  const qrLost = await pairErrors(pr, (h, deleted) => (deleted === 'tot.grand' ? h.replace(/alt="QR"/g, 'alt=""') : h));
  assert.ok(qrLost.some((e) => e.includes('invStd/tot.grand: الرمز المختوم سقط')), 'لم تلتقط سقوط الرمز');
  const wider = await pairErrors(pr, (h, deleted) => (deleted === 'h.phone' ? h.replace(TOKEN['h.email'], '') : h));
  assert.ok(wider.some((e) => e.includes('h.phone: سقط في الحرّ')), 'لم تلتقط حذفاً أوسع من وحدته');
});
