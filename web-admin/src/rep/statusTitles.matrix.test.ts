/**
 * عناوين الحالة في «نصوص المطبوعات» (قرار المالك ٤ نوفمبر ٢٠٢٦): «سند تسليم — ليست فاتورة ضريبية» و«مستند ملغى — لا يعتمد للخصم
 * الضريبي» و«مستند بانتظار اعتماد الهيئة» تُعاد صياغتها وتُترجم وتُحذف كغيرها — بمفاتيحها inv.deliveryNoteTitle وinv.voidTitle
 * وinv.pendingTitle — على كل قالبٍ وطريق: A4 القياسي والنقطية، والتحرير الحرّ (شعارٌ مستقل وتنسيق، واللوحة بمربع العنوان)،
 * والثنائي اللغة (وحرّه)، والرول 58/80 المختصر والمفصّل وحرّهما ونسخة الكلاسيكي الحرّة. والمُبطل والمعلَّق لا ورقة رول لهما.
 *
 * لكل قالبٍ ومستند حالة:
 *   ١) بلا نصوص: العنوان كما يقرّره القرار — والصفحة كما هي بنصوصٍ لا تمسّه (خطوط الأساس تثبت الحرف)؛
 *   ٢) الصياغة ونصّها الثاني يُطبعان مكان العنوان، ولا يبقى العنوان القديم؛
 *   ٣) الحذف يُسقط سطر العنوان كلّه (صياغته وترجمته) — وتنبيه القرار على الورقة باقٍ كما هو (لا يُقرأ المستند فاتورةً سارية بلا سببه)؛
 *   ٤) حذفها كلّها لا يغيّر الفاتورة الضريبية المختومة حرفاً، ورمز المرحلة الثانية باقٍ.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, type Company, type InvoiceDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { printThermalInvoice, type ThermalPrintOptions } from './thermal';
import {
  LEGACY_THERMAL_ID, defaultPrintLayout, defaultPrintOptions, legacyPrintSettings, legacyThermalProfile, presetPaper,
  type LayoutDesign, type PaperPresetId, type PrintLayout, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import type { PrintCanvas } from '../lib/print/printSettingsCore';
import { PRINT_STATUS_TITLE_KEYS, printTextEntry, type PrintTextEdit, type PrintTextsV1 } from '../lib/print/printTexts';
import { editableClassicCopy } from '../lib/print/designModel';
import { REHEARSAL_WATERMARK, zatcaPrintDecision } from '../lib/zatca/docPrint';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا شارع التحلية', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: LOGO, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
  addrCity: 'الرياض', addrPostalCode: '12211',
};
const B2B = { name: 'محمد العتيبي', businessName: 'مؤسسة الأفق', taxNumber: '311111111111113', address: 'طريق الملك فهد', city: 'جدة', postalCode: '23456' };
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c', icv: 41, warnings: 0, ...over,
});
const inv = (zatca: ZatcaDocView, number: string): InvoiceDoc => ({
  kind: 'invoice', number, date: '2026-11-02T09:15:00.000Z', type: 'CASH', company: COMPANY, customer: B2B, repName: 'أحمد السالم',
  items: [{ name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46, code: 'P-100', taxAmt: 6 }],
  subtotal: 40, discount: 0, tax: 6, total: 46, pricesIncludeTax: true, paidAmt: 46, remainingAmt: 0, zatca,
});

interface StatusCase { key: string; name: string; doc: () => InvoiceDoc; roll: boolean }
const CASES: StatusCase[] = [
  { key: 'inv.deliveryNoteTitle', name: 'سند تسليم', roll: true, doc: () => inv(zv({ mirror: 'clearance_pending', documentStatus: 'SUBMITTING', printable: false, qr: null }), 'INV-901') },
  { key: 'inv.voidTitle', name: 'مُبطل', roll: false, doc: () => inv(zv({ subtype: '02', mirror: 'rejected', documentStatus: 'REJECTED', printable: false, qr: null }), 'INV-902') },
  { key: 'inv.pendingTitle', name: 'معلَّق', roll: false, doc: () => inv(zv({ subtype: '02', mirror: 'signed', documentStatus: 'RETRY_WAIT', printable: false, qr: null }), 'INV-903') },
];
const decisionOf = (d: InvoiceDoc) => zatcaPrintDecision({ isReturn: false, buyerHasTaxNumber: true, saudi: true }, d.zatca);

// ─── القوالب ───

const profileOf = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard'): PrintProfile => ({
  id: `p-${template}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), showLogo: true, layout: defaultPrintLayout(printer, design) },
});
const withFree = (p: PrintProfile, free: Partial<PrintLayout>): PrintProfile => ({ ...p, options: { ...p.options, layout: { ...p.options.layout!, ...free } } });
const classicCopy = (): PrintProfile => {
  const { settings, newId } = editableClassicCopy(legacyPrintSettings(), LEGACY_THERMAL_ID);
  return settings.profiles.find((x) => x.id === newId)!;
};
const CANVAS: PrintCanvas = {
  headerMm: 75, footerMm: 85,
  boxes: [
    { id: 'logo', band: 'header', x: 0, y: 0, w: 40, h: 25 },
    { id: 'company', band: 'header', x: 45, y: 0, w: 90, h: 35 },
    { id: 'title', band: 'header', x: 140, y: 0, w: 48, h: 20, align: 'end' },
    { id: 'docInfo', band: 'header', x: 0, y: 38, w: 90, h: 35 },
    { id: 'customer', band: 'header', x: 95, y: 38, w: 93, h: 35 },
    { id: 'totals', band: 'footer', x: 0, y: 0, w: 115, h: 55 },
    { id: 'qr', band: 'footer', x: 125, y: 0, w: 63, h: 82 },
    { id: 'signatures', band: 'footer', x: 0, y: 58, w: 60, h: 25 },
    { id: 'footer', band: 'footer', x: 62, y: 58, w: 60, h: 25 },
  ],
};
const ROLL_FREE: Partial<PrintLayout> = {
  logo: 'end', logoMm: 20, logoAfter: 'customer', tableStyle: 'grid',
  sections: { header: { align: 'start', fontPct: 130 }, totals: { align: 'end', spaceBeforeMm: 3 }, footer: { fontPct: 70 } },
};
interface Target { name: string; kind: 'sheet' | 'roll'; profile: PrintProfile }
const TARGETS: Target[] = [
  { name: 'A4-branded', kind: 'sheet', profile: profileOf('page', 'page_branded', 'a4') },
  { name: 'A4-plain', kind: 'sheet', profile: profileOf('page', 'page_plain', 'a4') },
  { name: 'impact', kind: 'sheet', profile: profileOf('impact', 'impact_plain', 'ff_a4') },
  { name: 'A4-free', kind: 'sheet', profile: withFree(profileOf('page', 'page_branded', 'a4'), { logoAfter: 'top', logoMm: 30, sections: { header: { align: 'center', fontPct: 120 } } }) },
  { name: 'A4-canvas', kind: 'sheet', profile: withFree(profileOf('page', 'page_branded', 'a4'), { canvas: CANVAS }) },
  { name: 'impact-canvas', kind: 'sheet', profile: withFree(profileOf('impact', 'impact_plain', 'ff_a4'), { canvas: CANVAS, logoMm: 20 }) },
  { name: 'grid', kind: 'sheet', profile: profileOf('page', 'page_branded', 'a4', 'grid_bilingual') },
  { name: 'grid-impact', kind: 'sheet', profile: profileOf('impact', 'impact_plain', 'ff_a4', 'grid_bilingual') },
  { name: 'grid-free', kind: 'sheet', profile: withFree(profileOf('page', 'page_branded', 'a4', 'grid_bilingual'), { logoAfter: 'items', logoMm: 25, sections: { header: { align: 'end', fontPct: 120 } } }) },
  { name: 'roll58-classic', kind: 'roll', profile: legacyThermalProfile() },
  { name: 'roll58-compact', kind: 'roll', profile: profileOf('thermal', 'roll_compact', 'roll58') },
  { name: 'roll80-compact', kind: 'roll', profile: profileOf('thermal', 'roll_compact', 'roll80') },
  { name: 'roll80-detailed', kind: 'roll', profile: profileOf('thermal', 'roll_detailed', 'roll80') },
  { name: 'roll80-compact-free', kind: 'roll', profile: withFree(profileOf('thermal', 'roll_compact', 'roll80'), ROLL_FREE) },
  { name: 'roll80-detailed-free', kind: 'roll', profile: withFree(profileOf('thermal', 'roll_detailed', 'roll80'), ROLL_FREE) },
  { name: 'classic-copy-free', kind: 'roll', profile: withFree(classicCopy(), { ...ROLL_FREE, logo: 'center' }) },
];

const norm = (h: string): string => h.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, 'data:IMG');
async function render(t: Target, doc: InvoiceDoc): Promise<string> {
  if (t.kind === 'sheet') {
    return norm(renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: lookFor(t.profile) }, createElement(PrintableInvoice, { doc })) as ReactElement));
  }
  let out = '';
  const opts: ThermalPrintOptions = { profile: t.profile, tr: (s: string) => s, capture: (h: string) => { out = h; } };
  await printThermalInvoice(doc, opts);
  assert.ok(out, `${t.name}: لم تُلتقط وثيقة الرول`);
  return norm(out);
}
const count = (h: string, s: string): number => h.split(s).length - 1;
const esc = (s: string): string => s.replace(/&/g, '&amp;');

/** نصوصٌ للشركة بالإنجليزية لغةً ثانية: سطرٌ لا يمسّ العنوان (فالنصوص «مفعّلة») ومعه تعديلات المفاتيح المعطاة */
const textsWith = (edits: Record<string, Partial<PrintTextEdit>>): PrintTextsV1 => ({
  version: 1, secondLang: 'en', companyNameAlt: null, companyAddressAlt: null,
  edits: {
    'h.phone': { text: 'الهاتف', alt: null, hidden: false },
    ...Object.fromEntries(Object.entries(edits).map(([k, e]) => [k, { text: null, alt: null, hidden: false, ...e }])),
  },
});
const withTexts = (doc: InvoiceDoc, t: PrintTextsV1 | null): InvoiceDoc => ({ ...doc, company: { ...doc.company!, printTexts: t } });
const REWORD = 'ورقة حالة بصياغة الشركة';
const REWORD_ALT = 'Company worded status sheet';

test('عناوين الحالة مفاتيحٌ في القائمة بنصّ القرار نفسه حرفاً', () => {
  for (const c of CASES) assert.equal(printTextEntry(c.key)?.ar, decisionOf(c.doc()).title, c.key);
  assert.deepEqual(CASES.map((c) => c.key), [...PRINT_STATUS_TITLE_KEYS]);
});

for (const t of TARGETS) {
  test(`عناوين الحالة (${t.name}): بلا نصوص كما قرّرها القرار، والصياغة ونصّها الثاني مكانه، والحذف يُسقط السطر وتنبيه القرار باقٍ`, async () => {
    for (const c of CASES) {
      if (t.kind === 'roll' && !c.roll) continue;
      const doc = c.doc();
      const d = decisionOf(doc);
      const at = `${t.name}/${c.name}`;
      const today = await render(t, withTexts(doc, null));
      assert.ok(today.includes(esc(d.title)), `${at}: العنوان غائب بلا نصوص`);
      // نصوصٌ لا تمسّ العنوان: العنوان وترجمته الإنجليزية (القاموس) كما كانا
      const plain = await render(t, withTexts(doc, textsWith({})));
      const titleCount = count(plain, esc(d.title));
      assert.ok(titleCount > 0, `${at}: العنوان غائب بنصوصٍ لا تمسّه`);
      const notice = d.notice ? count(plain, d.notice) : 0;
      // تنبيه القرار مطبوعٌ فعلاً على هذا القالب — وإلا كانت مقارنات «باقٍ» أدناه 0 = 0 لا تحرس شيئاً
      if (d.notice) assert.ok(notice > 0, `${at}: تنبيه القرار غائب بلا تعديل`);

      const reworded = await render(t, withTexts(doc, textsWith({ [c.key]: { text: REWORD, alt: REWORD_ALT } })));
      assert.ok(reworded.includes(REWORD), `${at}: الصياغة لم تُطبع`);
      assert.ok(reworded.includes(REWORD_ALT), `${at}: نصّها الثاني لم يُطبع`);
      assert.ok(count(reworded, esc(d.title)) < titleCount, `${at}: العنوان القديم بقي بجانب الصياغة`);
      if (d.notice) assert.equal(count(reworded, d.notice), notice, `${at}: تنبيه القرار تغيّر بالصياغة`);

      const deleted = await render(t, withTexts(doc, textsWith({ [c.key]: { text: REWORD, alt: REWORD_ALT, hidden: true } })));
      assert.ok(!deleted.includes(REWORD) && !deleted.includes(REWORD_ALT), `${at}: الحذف أبقى الصياغة`);
      assert.equal(count(deleted, esc(d.title)), count(reworded, esc(d.title)), `${at}: الحذف أبقى العنوان`);
      if (d.notice) assert.equal(count(deleted, d.notice), notice, `${at}: الحذف أسقط تنبيه القرار`);
      if (t.name.startsWith('grid')) assert.doesNotMatch(deleted, new RegExp(`data-line="${c.key.replace('.', '\\.')}"`), `${at}: بقي من وحدة العنوان شيء`);

      // مفاتيح الحالتين الأخريين لا تمسّ هذا المستند حرفاً
      const others = Object.fromEntries(CASES.filter((o) => o.key !== c.key).map((o) => [o.key, { text: REWORD, alt: REWORD_ALT, hidden: true }]));
      assert.equal(await render(t, withTexts(doc, textsWith(others))), plain, `${at}: مفتاح حالةٍ أخرى غيّر الورقة`);
    }
  });
}

test('بيئة المحاكاة: حذف عناوين الحالة أو صياغتها لا يُسقط علامة البروفة ولا تنبيه القرار على أيّ قالب', async () => {
  const del = Object.fromEntries(PRINT_STATUS_TITLE_KEYS.map((k) => [k, { text: REWORD, alt: REWORD_ALT, hidden: true }]));
  const rew = Object.fromEntries(PRINT_STATUS_TITLE_KEYS.map((k) => [k, { text: 'فاتورة ضريبية', alt: 'Tax invoice' }]));
  for (const t of TARGETS) {
    for (const c of CASES) {
      if (t.kind === 'roll' && !c.roll) continue;
      const base = c.doc();
      const doc: InvoiceDoc = { ...base, zatca: { ...base.zatca!, mode: 'rehearsal' } };
      const d = decisionOf(doc);
      assert.equal(d.watermark, REHEARSAL_WATERMARK);
      const at = `${t.name}/${c.name}`;
      const plain = await render(t, withTexts(doc, textsWith({})));
      const wm = count(plain, d.watermark!);
      assert.ok(wm > 0, `${at}: علامة البروفة غائبة بلا تعديل`);
      for (const [name, edits] of [['حذف', del], ['صياغة', rew]] as const) {
        const out = await render(t, withTexts(doc, textsWith(edits)));
        assert.equal(count(out, d.watermark!), wm, `${at}/${name}: علامة البروفة تغيّرت`);
        if (d.notice) assert.equal(count(out, d.notice), count(plain, d.notice), `${at}/${name}: تنبيه القرار تغيّر`);
        assert.equal(out.includes('alt="QR"') || out.includes('class="qrbox"'), false, `${at}/${name}: رمزٌ على ورقة حالة`);
      }
    }
  }
});

test('حذف عناوين الحالة كلّها لا يغيّر الفاتورة الضريبية المختومة حرفاً على أيّ قالب — ورمز المرحلة الثانية باقٍ', async () => {
  const all = Object.fromEntries(PRINT_STATUS_TITLE_KEYS.map((k) => [k, { text: REWORD, alt: REWORD_ALT, hidden: true }]));
  for (const t of TARGETS) {
    for (const doc of [inv(zv(), 'INV-904'), inv(zv({ subtype: '02', mirror: 'reported', documentStatus: 'REPORTED' }), 'INV-905')]) {
      const base = await render(t, withTexts(doc, textsWith({})));
      const out = await render(t, withTexts(doc, textsWith(all)));
      assert.equal(out, base, `${t.name}/${doc.number}`);
      assert.ok(t.kind === 'roll' ? out.includes('class="qrbox"') : out.includes('alt="QR"'), `${t.name}/${doc.number}: الرمز المختوم غائب`);
    }
  }
});
