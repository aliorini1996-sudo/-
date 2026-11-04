/**
 * «التحرير الحرّ» لا يُسقط العلامة المائية للبروفة ولا صندوق التنبيه (مراجعة الامتثال، ٣ نوفمبر ٢٠٢٦).
 *
 * العلامة («نسخة تجريبية — بيئة محاكاة الهيئة، ليست فاتورة ضريبية») والتنبيه (سند التسليم: «سلمت البضاعة وبانتظار اعتماد الهيئة…»)
 * من قرار الطباعة (zatcaPrintDecision) لا من «نصوص المطبوعات» — فلا تحذفهما الشركة بسطرهما، ورأس النواة يقول: لا خيار يخفي التنبيه
 * أو العلامة المائية. وكانا يسكنان قسم «الترويسة» وحده في القوالب الثلاثة، فإخفاء الترويسة (sections.header.visible=false، مسموحٌ
 * بقرار المالك) كان يطبع فاتورة بروفةٍ برمزها المختوم بلا وسمها — ورقةً تُقرأ فاتورةً حقيقية — وسندَ تسليمٍ بلا سببه.
 * الحارس: كل نصٍّ منهما يُطبع مرّةً واحدة بالضبط في كل تركيبة (اليوم، الترويسة مخفيّة، كل قسمٍ مخفيّ، ولوحات A4 بالعنوان فيها أو بدونه).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, type Company, type InvoiceDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { printThermalInvoice, type ThermalPrintOptions } from './thermal';
import {
  defaultPrintLayout, defaultPrintOptions, presetPaper, sectionsFor,
  type LayoutDesign, type PaperPresetId, type PrintLayout, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import { LOCKED_VISIBLE } from '../lib/print/printSettingsCore';
import { REHEARSAL_WATERMARK } from '../lib/zatca/docPrint';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const DELIVERY_NOTICE = 'سلمت البضاعة وبانتظار اعتماد الهيئة وتصلك الفاتورة الضريبية المعتمدة بعد الاعتماد';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
};
const zv = (over: Partial<ZatcaDocView>): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c', icv: 41, warnings: 0, ...over,
});
const inv = (z: ZatcaDocView): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-777', date: '2026-11-02T09:15:00.000Z', type: 'CREDIT', company: COMPANY,
  customer: { name: 'محمد العتيبي', taxNumber: '311111111111113' }, repName: 'أحمد السالم',
  items: [{ name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46 }],
  subtotal: 40, discount: 0, tax: 6, total: 46, pricesIncludeTax: true, paidAmt: 0, remainingAmt: 46, zatca: z,
});
/** فاتورة البروفة المختومة (علامة مائية) وسند التسليم (تنبيه) — والنصّ الذي يجب أن يُطبع مرّةً واحدة */
const DOCS: Array<{ name: string; doc: () => InvoiceDoc; text: string }> = [
  { name: 'rehearsal', doc: () => inv(zv({ mode: 'rehearsal', mirror: 'reported', subtype: '02' })), text: REHEARSAL_WATERMARK },
  { name: 'deliveryNote', doc: () => inv(zv({ mirror: 'clearance_pending', printable: false, qr: null })), text: DELIVERY_NOTICE },
];

interface Target { name: string; kind: 'a4' | 'grid' | 'roll'; printer: PrinterType; base: () => PrintProfile }
const profile = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard'): PrintProfile => ({
  id: `p-${template}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), layout: defaultPrintLayout(printer, design) },
});
const TARGETS: Target[] = [
  { name: 'page_branded', kind: 'a4', printer: 'page', base: () => profile('page', 'page_branded', 'a4') },
  { name: 'impact_plain', kind: 'a4', printer: 'impact', base: () => profile('impact', 'impact_plain', 'ff_a4') },
  { name: 'grid_page', kind: 'grid', printer: 'page', base: () => profile('page', 'page_branded', 'a4', 'grid_bilingual') },
  { name: 'grid_impact', kind: 'grid', printer: 'impact', base: () => profile('impact', 'impact_plain', 'ff_a4', 'grid_bilingual') },
  { name: 'roll_compact80', kind: 'roll', printer: 'thermal', base: () => profile('thermal', 'roll_compact', 'roll80') },
  { name: 'roll_detailed80', kind: 'roll', printer: 'thermal', base: () => profile('thermal', 'roll_detailed', 'roll80') },
];
const designOf = (t: Target): LayoutDesign => (t.kind === 'grid' ? 'grid_bilingual' : 'standard');
const withFree = (p: PrintProfile, free: Partial<PrintLayout>): PrintProfile => ({ ...p, options: { ...p.options, layout: { ...p.options.layout!, ...free } } });
const allHidden = (t: Target) => Object.fromEntries(sectionsFor(t.printer, designOf(t)).filter((id) => !LOCKED_VISIBLE.includes(id)).map((id) => [id, { visible: false }]));

const FIXTURES: Array<{ name: string; free: (t: Target) => Partial<PrintLayout> | null }> = [
  { name: 'today', free: () => ({}) },
  { name: 'headerHidden', free: () => ({ sections: { header: { visible: false } } }) },
  { name: 'allHidden', free: (t) => ({ sections: allHidden(t) }) },
  { name: 'headerHiddenLogoTop', free: () => ({ logoAfter: 'top', sections: { header: { visible: false } } }) },
  // لوحات A4: العنوان في لوحةٍ يحمل الوسم معه (والترويسة ظاهرة أو مخفيّة)، والشركة وحدها في لوحة لا تنقله
  { name: 'canvasTitle', free: (t) => (t.kind === 'a4' ? { canvas: { headerMm: 40, footerMm: 0, boxes: [{ id: 'title', band: 'header', x: 100, y: 0, w: 88, h: 35 }] } } : null) },
  { name: 'canvasTitleHeaderHidden', free: (t) => (t.kind === 'a4' ? { canvas: { headerMm: 40, footerMm: 0, boxes: [{ id: 'title', band: 'header', x: 100, y: 0, w: 88, h: 35 }] }, sections: { header: { visible: false } } } : null) },
  { name: 'canvasCompanyHeaderHidden', free: (t) => (t.kind === 'a4' ? { canvas: { headerMm: 40, footerMm: 0, boxes: [{ id: 'company', band: 'header', x: 0, y: 0, w: 90, h: 35 }] }, sections: { header: { visible: false } } } : null) },
];

const render = async (t: Target, p: PrintProfile, doc: InvoiceDoc, raster: boolean): Promise<string> => {
  if (t.kind !== 'roll') {
    return renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: lookFor(p) }, createElement(PrintableInvoice, { doc })) as ReactElement);
  }
  let out = '';
  const opts: ThermalPrintOptions = { profile: p, tr: (s: string) => s };
  if (raster) opts.raster = async (h: string) => { out = h; }; else opts.capture = (h: string) => { out = h; };
  await printThermalInvoice(doc, opts);
  assert.ok(out, 'لم تُلتقط وثيقة الرول');
  return out;
};
const count = (h: string, s: string): number => h.split(s).length - 1;

for (const t of TARGETS) {
  test(`العلامة المائية والتنبيه يُطبعان مرّةً واحدة في كل تركيبةٍ حرّة (${t.name})`, async () => {
    const errors: string[] = [];
    for (const raster of t.kind === 'roll' ? [false, true] : [false]) {
      for (const d of DOCS) {
        for (const f of FIXTURES) {
          const free = f.free(t);
          if (!free) continue;
          const n = count(await render(t, withFree(t.base(), free), d.doc(), raster), d.text);
          if (n !== 1) errors.push(`${t.name}${raster ? '/bt' : ''}/${d.name}/${f.name}: ${n}`);
        }
      }
    }
    assert.deepEqual(errors, []);
  });
}
