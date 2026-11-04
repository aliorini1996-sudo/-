/**
 * «التحرير الحرّ» لا يُسقط وسم «سند ملغى» (مراجعة الامتثال/الدمج، ٤ نوفمبر ٢٠٢٦).
 *
 * الوسم يسكن قسماً واحداً: «الترويسة» في الرول، و«البيانات» في القالب ثنائي اللغة، و«البيانات» في A4 (وله فيها شريطٌ بديل منذ
 * P3). وإخفاء القسم (sections.<id>.visible=false، مسموحٌ بقرار المالك) كان يطبع على الرول والثنائي سندَ قبضٍ ملغى بلا وسمه —
 * ورقةً تُقرأ سنداً صالحاً. الحارس: الوسم يُطبع بعدد مرّات اليوم (ولا يغيب) في كل تركيبة إخفاء.
 * وقرار المالك ٤ نوفمبر ٢٠٢٦ («احذف كل شيء»): الوسم ختم حالة يُحذف بحذف الشركة الصريح لأختام الحالة وحده (layout.stamps=false —
 * areStampsRemoved) — في مكانه وفي شريطه المعاد؛ وإخفاء مضيفه بلا ذلك يبقيه كاليوم.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableReceipt, type Company, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { printThermalReceipt, type ThermalPrintOptions } from './thermal';
import {
  defaultPrintLayout, defaultPrintOptions, presetPaper, sectionsFor,
  type LayoutDesign, type PaperPresetId, type PrintLayout, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

const MARK = 'سند ملغى';
const COMPANY: Company = { name: 'شركة الاختبار للتوزيع', address: 'حي العليا', taxNumber: '300000000000003', phone: '0501234567', primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA' };
const rcp = (): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-02T11:00:00.000Z', company: COMPANY, customer: { name: 'بقالة النور' },
  repName: 'أحمد السالم', amount: 150, paymentMethod: 'CASH', invoices: [{ number: 'INV-777', amount: 150 }], cancelled: true,
});

interface Target { name: string; kind: 'a4' | 'grid' | 'roll'; printer: PrinterType; base: () => PrintProfile }
const profile = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard'): PrintProfile => ({
  id: `p-${template.replace(/_/g, '-')}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), layout: defaultPrintLayout(printer, design) },
});
const TARGETS: Target[] = [
  { name: 'page_branded', kind: 'a4', printer: 'page', base: () => profile('page', 'page_branded', 'a4') },
  { name: 'impact_plain', kind: 'a4', printer: 'impact', base: () => profile('impact', 'impact_plain', 'ff_a4') },
  { name: 'grid_page', kind: 'grid', printer: 'page', base: () => profile('page', 'page_branded', 'a4', 'grid_bilingual') },
  { name: 'grid_impact', kind: 'grid', printer: 'impact', base: () => profile('impact', 'impact_plain', 'ff_a4', 'grid_bilingual') },
  { name: 'roll_compact58', kind: 'roll', printer: 'thermal', base: () => profile('thermal', 'roll_compact', 'roll58') },
  { name: 'roll_detailed80', kind: 'roll', printer: 'thermal', base: () => profile('thermal', 'roll_detailed', 'roll80') },
];
const designOf = (t: Target): LayoutDesign => (t.kind === 'grid' ? 'grid_bilingual' : 'standard');
const withFree = (p: PrintProfile, free: Partial<PrintLayout>): PrintProfile => ({ ...p, options: { ...p.options, layout: { ...p.options.layout!, ...free } } });
const hide = (t: Target, ids: string[]) => Object.fromEntries(sectionsFor(t.printer, designOf(t)).filter((id) => ids.includes(id)).map((id) => [id, { visible: false }]));
const allIds = (t: Target) => sectionsFor(t.printer, designOf(t)) as readonly string[];

/** off: حذف الشركة الصريح لأختام الحالة ⇒ لا وسم أبداً. وإلا بعدد مرّات اليوم */
const FIXTURES: Array<{ name: string; off?: boolean; free: (t: Target) => Partial<PrintLayout> }> = [
  { name: 'today', free: () => ({}) },
  { name: 'headerHidden', free: (t) => ({ sections: hide(t, ['header']) }) },
  { name: 'infoHidden', free: (t) => ({ sections: hide(t, ['info']) }) },
  { name: 'allHidden', free: (t) => ({ sections: hide(t, [...allIds(t)]) }) },
  { name: 'allHiddenLogoTop', free: (t) => ({ logoAfter: 'top', sections: hide(t, [...allIds(t)]) }) },
  { name: 'stampsOn', free: () => ({ stamps: true }) },
  { name: 'stampsOff', off: true, free: () => ({ stamps: false }) },
  { name: 'stampsOffHeaderHidden', off: true, free: (t) => ({ stamps: false, sections: hide(t, ['header']) }) },
  { name: 'stampsOffInfoHidden', off: true, free: (t) => ({ stamps: false, sections: hide(t, ['info']) }) },
  { name: 'stampsOffAllHidden', off: true, free: (t) => ({ stamps: false, logoAfter: 'top', sections: hide(t, [...allIds(t)]) }) },
];

const render = async (t: Target, p: PrintProfile, raster: boolean): Promise<string> => {
  if (t.kind !== 'roll') {
    return renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: lookFor(p) }, createElement(PrintableReceipt, { doc: rcp() })) as ReactElement);
  }
  let out = '';
  const opts: ThermalPrintOptions = { profile: p, tr: (s: string) => s };
  if (raster) opts.raster = async (h: string) => { out = h; }; else opts.capture = (h: string) => { out = h; };
  await printThermalReceipt(rcp(), opts);
  assert.ok(out, 'لم تُلتقط وثيقة الرول');
  return out;
};
const count = (h: string): number => h.split(MARK).length - 1;

for (const t of TARGETS) {
  test(`وسم «سند ملغى» لا يسقط بإخفاء قسمه — ويسقط بحذف الشركة الصريح لأختام الحالة وحده (${t.name})`, async () => {
    const errors: string[] = [];
    for (const raster of t.kind === 'roll' ? [false, true] : [false]) {
      const today = count(await render(t, t.base(), raster));
      if (today < 1) errors.push(`${t.name}${raster ? '/bt' : ''}: اليوم بلا وسم`);
      for (const f of FIXTURES) {
        const n = count(await render(t, withFree(t.base(), f.free(t)), raster));
        const want = f.off ? 0 : today;
        if (n !== want) errors.push(`${t.name}${raster ? '/bt' : ''}/${f.name}: ${n} والمتوقّع ${want}`);
      }
    }
    assert.deepEqual(errors, []);
  });
}
