/**
 * رمز QR في «التحرير الحرّ» لا يُحذف إلا بحذف الشركة الصريح (طلب المالك ٣ نوفمبر ٢٠٢٦ — pd_spec B.3/B.4/E.4، الحزمة P9؛ وقرار
 * المالك ٤ نوفمبر ٢٠٢٦ «احذف كل شيء حتى QR»: sections.qr = { visible:false } — isQrRemoved):
 * لكل قالب (A4 الملوّن والعادي، والنقطية العادية والمطبوعة مسبقاً، والثنائي على الصفحة والنقطية، والرول المختصر 58/80 والمفصّل 80
 * ونسخة الكلاسيكي) × كل مستند (فاتورة المرحلة الثانية المختومة، وإشعارها الدائن، والمبسّطة بالمرحلة الأولى) × كل تركيبة:
 *   القسم الحامل مخفيّ، وكل قسمٍ مخفيّ، ولوحاتٌ بلا مربع QR، ومربع QR في الرأس أو التذييل، وأقصى خطٍّ ومسافة، وكل العبارات محذوفة —
 *   ١) الرمز حاضرٌ بعدد مرّات اليوم نفسه (لا يسقط ولا يتكرّر): <img alt="QR"> للصفحة والثنائي، وخانة data-qr-value للنقطية
 *      ولنسخة البلوتوث في الرول، و.qrbox لطباعة النظام في الرول؛
 *   ٢) الرمز لا يصغر عن مقاس اليوم (والمربع على النقطية يكبر إلى حدّ خانة اليوم)؛
 *   ٣) رمز المرحلة الثانية المختوم بقيمته حرفاً في الخانة (النقطية والبلوتوث تعيد رسمه بنقاط صحيحة).
 * والسند بلا رمز في كل تركيبة. وحذف الشركة الصريح للرمز (qrRemoved*) وحده يُسقطه كلّه: لا صورة ولا خانة ولا ICV/UUID، في كل قالب
 * ومستند — وإخفاء القسم الحامل وحده لا يُسقطه (hostHidden، canvasNoQrTotalsHidden).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, type Company, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { printThermalInvoice, printThermalReceipt, type ThermalPrintOptions } from './thermal';
import {
  LEGACY_THERMAL_ID, defaultPrintLayout, defaultPrintOptions, legacyPrintSettings, presetPaper, sectionsFor,
  type LayoutDesign, type PaperPresetId, type PrintLayout, type PrintProfile, type PrinterType, type SectionId, type TemplateId,
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

// ─── المستندات ───

const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا شارع التحلية', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: LOGO, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
};
const ZV_UUID = '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c';
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: ZV_UUID, icv: 41, warnings: 0, ...over,
});
const ITEMS: InvoiceDoc['items'] = [
  { name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46 },
  { name: 'عصير برتقال', unit: 'حبة', qty: 3, unitPrice: 2.5, discountPct: 10, taxPct: 15, lineTotal: 6.75 },
];
const invP2 = (): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-777', date: '2026-11-02T09:15:00.000Z', type: 'CREDIT', company: COMPANY,
  customer: { name: 'محمد العتيبي', businessName: 'مؤسسة الأفق', taxNumber: '311111111111113', phone: '0112345678', address: 'طريق الملك فهد' },
  repName: 'أحمد السالم', items: ITEMS, subtotal: 48.5, discount: 2.5, tax: 6.88, total: 52.75, pricesIncludeTax: true,
  paidAmt: 21.5, remainingAmt: 31.25, zatca: zv(),
});
const noteP2 = (): InvoiceDoc => ({
  ...invP2(), number: 'RET-55', isReturn: true, paidAmt: undefined, remainingAmt: undefined, billingReference: 'INV-500', noteReason: 'بضاعة تالفة',
  zatca: zv({ documentKind: 'CREDIT_NOTE' } as Partial<ZatcaDocView>),
});
const invP1 = (): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-778', date: '2026-11-02T10:00:00.000Z', type: 'CASH', company: COMPANY,
  customer: { name: 'بقالة الحي', phone: '0533333333' }, repName: 'أحمد السالم', items: ITEMS,
  subtotal: 48.5, discount: 0, tax: 6.88, total: 52.75, pricesIncludeTax: true, paidAmt: 52.75, remainingAmt: 0,
});
const rcp = (): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-02T11:00:00.000Z', company: COMPANY, customer: { name: 'بقالة النور' },
  repName: 'أحمد السالم', amount: 150, paymentMethod: 'CASH', invoices: [{ number: 'INV-777', amount: 150 }],
});
type Doc = InvoiceDoc | ReceiptDoc;
const DOCS: Record<string, { mk: () => Doc; stamped: boolean }> = {
  invP2: { mk: invP2, stamped: true }, noteP2: { mk: noteP2, stamped: true }, invP1: { mk: invP1, stamped: false }, rcp: { mk: rcp, stamped: false },
};
const ALL_DELETED: PrintTextsV1 = {
  version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null,
  edits: Object.fromEntries(PRINT_TEXT_CATALOG.map((e) => [e.key, { text: null, alt: null, hidden: true }])),
};
const withTexts = <D extends Doc>(doc: D, t: PrintTextsV1 | null): D => ({ ...doc, company: { ...doc.company!, printTexts: t } });

// ─── القوالب ───

interface Target { name: string; kind: 'a4' | 'grid' | 'roll'; printer: PrinterType; base: () => PrintProfile }
const plainProfile = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard'): PrintProfile => ({
  id: `p-${template}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), showLogo: true, layout: defaultPrintLayout(printer, design) },
});
const classicCopy = (): PrintProfile => {
  const { settings, newId } = editableClassicCopy(legacyPrintSettings(), LEGACY_THERMAL_ID);
  return settings.profiles.find((x) => x.id === newId)!;
};
const TARGETS: Target[] = [
  { name: 'page_branded', kind: 'a4', printer: 'page', base: () => plainProfile('page', 'page_branded', 'a4') },
  { name: 'page_plain', kind: 'a4', printer: 'page', base: () => plainProfile('page', 'page_plain', 'a4') },
  { name: 'impact_plain', kind: 'a4', printer: 'impact', base: () => plainProfile('impact', 'impact_plain', 'ff_a4') },
  { name: 'impact_preprinted', kind: 'a4', printer: 'impact', base: () => plainProfile('impact', 'impact_preprinted', 'ff_a4') },
  { name: 'grid_page', kind: 'grid', printer: 'page', base: () => plainProfile('page', 'page_branded', 'a4', 'grid_bilingual') },
  { name: 'grid_impact', kind: 'grid', printer: 'impact', base: () => plainProfile('impact', 'impact_plain', 'ff_a4', 'grid_bilingual') },
  { name: 'roll_compact58', kind: 'roll', printer: 'thermal', base: () => plainProfile('thermal', 'roll_compact', 'roll58') },
  { name: 'roll_compact80', kind: 'roll', printer: 'thermal', base: () => plainProfile('thermal', 'roll_compact', 'roll80') },
  { name: 'roll_detailed80', kind: 'roll', printer: 'thermal', base: () => plainProfile('thermal', 'roll_detailed', 'roll80') },
  { name: 'classic_copy58', kind: 'roll', printer: 'thermal', base: classicCopy },
];
const withFree = (p: PrintProfile, free: Partial<PrintLayout>): PrintProfile => ({
  ...p, options: { ...p.options, layout: { ...p.options.layout!, ...free } },
});
const designOf = (t: Target): LayoutDesign => (t.kind === 'grid' ? 'grid_bilingual' : 'standard');

// ─── التركيبات ───

const HEADER_BOXES: PrintCanvas['boxes'] = [
  { id: 'logo', band: 'header', x: 0, y: 0, w: 40, h: 25 },
  { id: 'company', band: 'header', x: 45, y: 0, w: 90, h: 30 },
  { id: 'title', band: 'header', x: 140, y: 0, w: 48, h: 20 },
  { id: 'docInfo', band: 'header', x: 0, y: 35, w: 90, h: 30 },
];
const FOOTER_BOXES: PrintCanvas['boxes'] = [
  { id: 'totals', band: 'footer', x: 0, y: 0, w: 100, h: 50 },
  { id: 'signatures', band: 'footer', x: 0, y: 55, w: 120, h: 20 },
  { id: 'footer', band: 'footer', x: 125, y: 55, w: 63, h: 20 },
];
const QR_FOOTER = { id: 'qr', band: 'footer', x: 120, y: 0, w: 50, h: 50 } as const;
const QR_HEADER = { id: 'qr', band: 'header', x: 140, y: 22, w: 47, h: 47 } as const;
/** أقصى ما يُضبط لكل قسمٍ ظاهر */
const maxStyles = (t: Target) => Object.fromEntries(sectionsFor(t.printer, designOf(t)).map((id) => [id, { align: 'end', fontPct: 160, spaceBeforeMm: 30, spaceAfterMm: 30 }]));
/** كل قسمٍ مخفيٌّ (والأصناف منها منذ ٤ نوفمبر) إلا رمز الرول — فإخفاؤه حذفٌ صريح للرمز له تركيبته (qrRemoved*) */
const allHidden = (t: Target) => Object.fromEntries(sectionsFor(t.printer, designOf(t)).filter((id) => id !== 'qr').map((id) => [id, { visible: false }]));
/** حذف الشركة الصريح للرمز: قسم الرمز في الرول، والقسم الافتراضي على الصفحة والثنائي */
const QR_REMOVED = { qr: { visible: false } } as const;
const HOST: Record<Target['kind'], SectionId> = { a4: 'totals', grid: 'info', roll: 'totals' };

/** removed: حذف الشركة الصريح للرمز ⇒ يغيب كلّه (لا صورة ولا خانة ولا ICV/UUID). وإلا: الرمز بعدد اليوم ومقاسه */
interface Fixture { name: string; removed?: boolean; free: (t: Target) => Partial<PrintLayout> | null }
const FIXTURES: Fixture[] = [
  { name: 'today6', free: () => ({}) },
  // القسم الحامل مخفيّ بلا حذفٍ للرمز ⇒ الرمز اليتيم كاليوم
  { name: 'hostHidden', free: (t) => ({ sections: { [HOST[t.kind]]: { visible: false } } }) },
  // قرار المالك ٤ نوفمبر ٢٠٢٦: حذف الرمز الصريح (كان «محاولةً» تُمحى) — يغيب في كل قالب، والرول بلا qrNoFit
  { name: 'qrRemoved', removed: true, free: () => ({ sections: { ...QR_REMOVED } }) as Partial<PrintLayout> },
  { name: 'qrRemovedHostHidden', removed: true, free: (t) => ({ sections: { [HOST[t.kind]]: { visible: false }, ...QR_REMOVED } }) as Partial<PrintLayout> },
  { name: 'qrRemovedAllHidden', removed: true, free: (t) => ({ sections: { ...allHidden(t), ...QR_REMOVED } }) as Partial<PrintLayout> },
  // لوحةٌ ما زال فيها مربع QR والرمز محذوف: المربع يُهمل (الخادم يقبله، والمصمّم يزيله)
  { name: 'qrRemovedCanvasBox', removed: true, free: (t) => (t.kind === 'a4' ? { canvas: { headerMm: 70, footerMm: 80, boxes: [...HEADER_BOXES, ...FOOTER_BOXES, QR_FOOTER] }, sections: { ...QR_REMOVED } } as Partial<PrintLayout> : null) },
  { name: 'allHidden', free: (t) => ({ sections: allHidden(t) }) },
  { name: 'maxStyle', free: (t) => ({ logoMm: 120, logoAfter: 'top', sections: maxStyles(t) }) },
  { name: 'qrMovedUp', free: (t) => (t.kind === 'roll' ? { order: ['header', 'info', 'customer', 'items', 'qr', 'totals', 'signatures', 'footer'], logoAfter: 'qr' } : null) },
  { name: 'canvasNoQr', free: (t) => (t.kind === 'a4' ? { canvas: { headerMm: 70, footerMm: 80, boxes: [...HEADER_BOXES, ...FOOTER_BOXES] } } : null) },
  { name: 'canvasNoQrTotalsHidden', free: (t) => (t.kind === 'a4' ? { canvas: { headerMm: 70, footerMm: 80, boxes: [...HEADER_BOXES, ...FOOTER_BOXES.filter((b) => b.id !== 'totals')] }, sections: { totals: { visible: false } } } : null) },
  { name: 'canvasQrFooter', free: (t) => (t.kind === 'a4' ? { canvas: { headerMm: 70, footerMm: 80, boxes: [...HEADER_BOXES, ...FOOTER_BOXES, QR_FOOTER] } } : null) },
  { name: 'canvasQrFooterOnly', free: (t) => (t.kind === 'a4' ? { canvas: { headerMm: 0, footerMm: 60, boxes: [{ ...QR_FOOTER, x: 0 }] }, sections: allHidden(t) } : null) },
  { name: 'canvasQrHeader', free: (t) => (t.kind === 'a4' ? { canvas: { headerMm: 70, footerMm: 80, boxes: [...HEADER_BOXES, ...FOOTER_BOXES, QR_HEADER] }, sections: { totals: { visible: false } } } : null) },
  // مربعٌ أصغر من حدّ القراءة وصل بقراءةٍ متسامحة (الخادم يرفضه 400): يُكبَّر لا يُصغَّر
  { name: 'canvasQrTiny', free: (t) => (t.kind === 'a4' ? { canvas: { headerMm: 0, footerMm: 60, boxes: [{ id: 'qr', band: 'footer', x: 0, y: 0, w: 10, h: 10 }] } } : null) },
];

// ─── التصيير والقياس ───

const norm = (h: string): string => h.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{60,}/g, 'data:QR');
const sheet = (p: PrintProfile, doc: Doc): string => norm(renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: lookFor(p) },
  doc.kind === 'invoice' ? createElement(PrintableInvoice, { doc }) : createElement(PrintableReceipt, { doc })) as ReactElement));
async function roll(p: PrintProfile, doc: Doc, raster: boolean): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile: p, tr: (s: string) => s };
  if (raster) opts.raster = async (h: string) => { out = h; }; else opts.capture = (h: string) => { out = h; };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  assert.ok(out, 'لم تُلتقط وثيقة الرول');
  return norm(out);
}
interface Mode { name: string; run: (p: PrintProfile, doc: Doc) => string | Promise<string> }
const modesOf = (t: Target): Mode[] => (t.kind === 'roll'
  ? [{ name: 'system', run: (p, d) => roll(p, d, false) }, { name: 'bt', run: (p, d) => roll(p, d, true) }]
  : [{ name: 'sheet', run: sheet }]);

/**
 * الرموز المنطقية في الورقة: العدد وأصغر مقاس (px للصفحة والنقطية، mm للرول). خانة data-qr-value (النقطية) تحيط بصورتها فتُعدّ
 * الخانة وحدها بمقاسها؛ وفي الرول مربع .qrbox (وخانة البلوتوث داخله) رمزٌ واحد بمقاس --qr.
 */
export interface QrInfo { count: number; minSize: number; values: string[] }
function qrInfo(t: Target, h: string): QrInfo {
  const sizes: number[] = [];
  const values = [...h.matchAll(/data-qr-value="([^"]*)"/g)].map((m) => m[1]);
  if (t.kind === 'roll') {
    for (const m of h.matchAll(/<div class="qrbox" style="--qr:([0-9.]+)mm">/g)) sizes.push(Number(m[1]));
  } else {
    const slots = [...h.matchAll(/<div style="([^"]*)" data-qr-value=/g)];
    for (const m of slots) sizes.push(Number(/(?:^|;)width:([0-9.]+)px/.exec(m[1])?.[1] ?? NaN));
    const imgs = [...h.matchAll(/<img width="([0-9.]+)" height="[0-9.]+" alt="QR"/g)];
    if (imgs.length > slots.length) for (const m of imgs.slice(slots.length)) sizes.push(Number(m[1]));
  }
  return { count: sizes.length, minSize: sizes.length ? Math.min(...sizes) : 0, values };
}

/** أخطاء الرمز لقالبٍ واحد بكل تركيبةٍ ومستند ووضع — `mutate` يحاكي قالباً معيباً (برهان الفشل) */
async function qrErrors(t: Target, mutate: (h: string) => string = (h) => h): Promise<string[]> {
  const errors: string[] = [];
  for (const mode of modesOf(t)) {
    for (const [docName, d] of Object.entries(DOCS)) {
      for (const texts of [null, ALL_DELETED]) {
        const doc = withTexts(d.mk(), texts);
        const today = qrInfo(t, await mode.run(t.base(), doc));
        const tag = `${t.name}/${mode.name}/${docName}${texts ? '/all-texts-deleted' : ''}`;
        if (d.stamped && today.count !== 1) errors.push(`${tag}: اليوم بلا رمزٍ مختوم واحد (${today.count})`);
        if (docName === 'rcp' && today.count !== 0) errors.push(`${tag}: سندٌ برمز`);
        for (const f of FIXTURES) {
          const free = f.free(t);
          if (!free) continue;
          const at = `${tag}/${f.name}`;
          const out = mutate(await mode.run(withFree(t.base(), free), doc));
          const q = qrInfo(t, out);
          if (f.removed) {
            if (q.count !== 0) errors.push(`${at}: الرمز المحذوف صراحةً مطبوع (${q.count})`);
            if (q.values.length) errors.push(`${at}: خانة data-qr-value لرمزٍ محذوف`);
            if (/\bICV \d/.test(out) || out.includes(ZV_UUID)) errors.push(`${at}: سطر ICV/UUID لرمزٍ محذوف`);
            continue;
          }
          if (q.count !== today.count) { errors.push(`${at}: الرمز ${q.count} مرة واليوم ${today.count}`); continue; }
          if (q.count && q.minSize + 0.01 < today.minSize) errors.push(`${at}: الرمز ${q.minSize} أصغر من اليوم ${today.minSize}`);
          if (d.stamped && today.values.includes(STAMPED) && !q.values.includes(STAMPED)) errors.push(`${at}: خانة الرمز بلا القيمة المختومة`);
        }
      }
    }
  }
  return errors;
}

test('حارس المصفوفة: عشرة قوالب، وكل تركيبةٍ للوحات على A4 والنقطية القياسية، وكل العبارات محذوفة', () => {
  assert.equal(TARGETS.length, 10);
  assert.equal(FIXTURES.length, 15);
  assert.deepEqual(FIXTURES.filter((f) => f.removed).map((f) => f.name), ['qrRemoved', 'qrRemovedHostHidden', 'qrRemovedAllHidden', 'qrRemovedCanvasBox']);
  // لا تركيبةٌ غير «الحذف الصريح» تُخفي الرمز (الإخفاء لا يقع عرَضاً)
  for (const f of FIXTURES.filter((x) => !x.removed)) for (const t of TARGETS) assert.notEqual((f.free(t)?.sections as Record<string, { visible?: boolean }> | undefined)?.qr?.visible, false, `${f.name}/${t.name}`);
  assert.equal(Object.keys(ALL_DELETED.edits).length, PRINT_TEXT_CATALOG.length);
  assert.ok(Object.values(ALL_DELETED.edits).every((e) => e.hidden === true));
  // الكاشف يرى الصيغ الثلاث (صورة، خانة الصفحة، خانة الرول ومربعه)
  assert.deepEqual(qrInfo(TARGETS[0], '<img width="176" height="176" alt="QR"/>'), { count: 1, minSize: 176, values: [] });
  assert.equal(qrInfo(TARGETS[2], '<div style="width:220px;height:220px" data-qr-value="x"></div>').minSize, 220);
  assert.equal(qrInfo(TARGETS[2], '<div style="width:220px;height:220px" data-qr-value="x"><img width="176" height="176" alt="QR"/></div>').count, 1);
  assert.equal(qrInfo(TARGETS[6], '<div class="qrbox" style="--qr:30mm"><div class="qrslot" data-qr-value="x" data-qr-ec="M" style="width:30mm;height:30mm"></div></div>').count, 1);
});

for (const t of TARGETS) {
  test(`QR لا يُحذف إلا بحذف الشركة الصريح، ولا يتكرّر ولا يصغر (${t.name}): كل تركيبةٍ حرّة × كل مستند × كل العبارات محذوفة`, async () => {
    assert.deepEqual(await qrErrors(t), []);
  });
}

test('النقطية: مربع QR في اللوحة يكبر إلى خانة اليوم على الأقل، ورمز المرحلة الثانية في الخانة بقيمته المختومة', () => {
  for (const name of ['impact_plain', 'impact_preprinted']) {
    const t = TARGETS.find((x) => x.name === name)!;
    const p = withFree(t.base(), { canvas: { headerMm: 0, footerMm: 60, boxes: [{ ...QR_FOOTER, x: 0, w: 47, h: 47 }] } });
    const look = lookFor(p);
    const out = sheet(p, invP2());
    assert.ok(out.includes(`data-qr-value="${STAMPED}"`), `${name}: الخانة بلا القيمة المختومة`);
    const q = qrInfo(t, out);
    assert.equal(q.count, 1);
    assert.ok(look.qrSlotPx && q.minSize >= look.qrSlotPx, `${name}: الخانة ${q.minSize} أصغر من ${look.qrSlotPx}`);
    // والرمز داخل لوحة التذييل لا في السريان
    assert.ok(out.indexOf('data-qr-value') > out.indexOf('data-section="canvas-footer"'), `${name}: الرمز ليس في لوحة التذييل`);
  }
});

test('المصفوفة تلتقط القالب المعيب (برهان الفشل قبل الإصلاح): رمزٌ يسقط أو يتكرّر أو يصغر', async () => {
  const page = TARGETS[0];
  const dropped = await qrErrors(page, (h) => h.replace(/<img width="[0-9.]+" height="[0-9.]+" alt="QR"[^>]*>/g, ''));
  assert.ok(dropped.some((e) => e.includes('invP2/hostHidden: الرمز 0 مرة')), 'لم تلتقط الرمز الساقط');
  const doubled = await qrErrors(page, (h) => h.replace(/(<img width="[0-9.]+" height="[0-9.]+" alt="QR"[^>]*>)/, '$1$1'));
  assert.ok(doubled.some((e) => e.includes('الرمز 2 مرة')), 'لم تلتقط الرمز المكرّر');
  const shrunk = await qrErrors(page, (h) => h.replace(/<img width="176" height="176" alt="QR"/g, '<img width="90" height="90" alt="QR"'));
  assert.ok(shrunk.some((e) => e.includes('أصغر من اليوم')), 'لم تلتقط الرمز المصغّر');
  const roll = TARGETS[7];
  const rollDropped = await qrErrors(roll, (h) => h.replace(/<div class="qrbox"/g, '<div class="gone"'));
  assert.ok(rollDropped.some((e) => e.includes('system/invP2/maxStyle: الرمز 0 مرة')), 'الرول: لم تلتقط الرمز الساقط');
  // قالبٌ يتجاهل حذف الشركة الصريح (يطبع الرمز أو سطر ICV رغمه) يُلتقط
  const ignored = await qrErrors(page, (h) => `${h}<img width="176" height="176" alt="QR"/>`);
  assert.ok(ignored.some((e) => e.includes('invP2/qrRemoved: الرمز المحذوف صراحةً مطبوع')), 'لم تلتقط رمزاً محذوفاً مطبوعاً');
  const icv = await qrErrors(roll, (h) => `${h}<div class="c muted">ICV 41</div>`);
  assert.ok(icv.some((e) => e.includes('invP2/qrRemoved: سطر ICV/UUID')), 'لم تلتقط سطر ICV لرمزٍ محذوف');
});
