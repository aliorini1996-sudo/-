/**
 * مصفوفة «التحرير الحرّ» عبر القوالب (طلب المالك ٣ نوفمبر ٢٠٢٦ — pd_spec E.3، الحزمة P9):
 * كل مفتاحٍ حرّ وحده ومجتمعةً على كل قالب — A4 الملوّن والعادي، والنقطية العادية والمطبوعة مسبقاً، و«ثنائي اللغة» على الصفحة
 * والنقطية، والرول المختصر 58/80 والمفصّل 80، ونسخة «تحرير الشريط الكلاسيكي» — للفاتورة والسند:
 *   ١) كل تركيبةٍ في المصفوفة صالحةٌ عند الخادم (layoutIssues = []) — فما يحفظه المحرّر يطبعه كل قالب؛
 *   ٢) الطباعة الحقيقية بلا وسم مصمّم (data-pd)، والوسم يظهر مع سياق المعاينة/markers وحدهما؛
 *   ٣) لا zoom ولا filter جديدان (html2canvas لا يعرفهما)؛
 *   ٤) الشعار مرةً واحدة وصندوقه ≤ logoMm (بعد قصّ حدود الهدف)، ومحاذاته كما ضُبطت (start = يمين)، وكتلته المستقلة في مكانها؛
 *   ٥) القسم المخفي غائب، والمسافتان والمحاذاة على غلافه، وحجم الخط مضروبٌ في النسبة؛
 *   ٦) لوحتا الرأس والتذييل على A4 والنقطية القياسية: data-print-canvas على الجذر وكل مربعٍ في لوحته مرةً واحدة.
 * والحارس الأكبر لما لم يُحرَّر: printA4.baseline وrollThermal.baseline وprintLayout6.baseline (لا تُمسّ).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, type Company, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { PrintDesignPreviewContext } from './printDesignContext';
import { printThermalInvoice, printThermalReceipt, type ThermalPrintOptions } from './thermal';
import {
  LEGACY_THERMAL_ID, defaultPrintLayout, defaultPrintOptions, geometry, layoutIssues, legacyPrintSettings, presetPaper, sectionsFor,
  type LayoutDesign, type PaperPresetId, type PrintLayout, type PrintProfile, type PrinterType, type SectionId, type TemplateId,
} from '../lib/print/printSettings';
import { CANVAS_BOX_IDS, type PrintCanvas } from '../lib/print/printSettingsCore';
import { logoMmBounds, mmToPx } from '../lib/print/layout';
import { editableClassicCopy } from '../lib/print/designModel';
import { sampleBannerHtml, sampleInvoiceDoc } from '../lib/print/calibration';
import { readFileSync } from 'node:fs';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

// ─── المستندات ───

/** PNG صالح الرأس 200×100 — المحرّك يقرأ IHDR وحده لنسبة الشعار */
function pngOf(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; b[25] = 6;
  return `data:image/png;base64,${b.toString('base64')}`;
}
const LOGO = pngOf(200, 100);
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'الرياض، حي العليا', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: LOGO, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
};
const inv = (): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-777', date: '2026-11-02T09:15:00.000Z', type: 'CREDIT', company: COMPANY,
  customer: { name: 'محمد العتيبي', businessName: 'مؤسسة الأفق', taxNumber: '311111111111113', phone: '0112345678', address: 'طريق الملك فهد' },
  repName: 'أحمد السالم',
  items: [
    { name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46 },
    { name: 'عصير برتقال', unit: 'حبة', qty: 3, unitPrice: 2.5, discountPct: 10, taxPct: 15, lineTotal: 6.75 },
  ],
  subtotal: 48.5, discount: 2.5, tax: 6.88, total: 52.75, pricesIncludeTax: true, paidAmt: 21.5, remainingAmt: 31.25,
});
const rcp = (): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-02T11:00:00.000Z', company: COMPANY,
  customer: { name: 'بقالة النور', phone: '0559998887', address: 'حي الروضة' },
  repName: 'أحمد السالم', amount: 150, paymentMethod: 'CASH', invoices: [{ number: 'INV-777', amount: 150 }],
});
type Doc = InvoiceDoc | ReceiptDoc;

// ─── القوالب ───

interface Target { name: string; kind: 'a4' | 'grid' | 'roll'; printer: PrinterType; base: () => PrintProfile }
const plainProfile = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard'): PrintProfile => ({
  id: `p-${template}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), showLogo: true, layout: defaultPrintLayout(printer, design) },
});
const classicCopy = (): PrintProfile => {
  const { settings, newId } = editableClassicCopy(legacyPrintSettings(), LEGACY_THERMAL_ID);
  const p = settings.profiles.find((x) => x.id === newId)!;
  return { ...p, options: { ...p.options, showLogo: true } };
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
const designOf = (p: PrintProfile): LayoutDesign => p.options.layout?.design ?? 'standard';

// ─── لوحتا الرأس والتذييل (ملّيمتر الورقة؛ صالحتان على الصفحة 188 والنقطية 201) ───

const CANVAS: PrintCanvas = {
  headerMm: 70, footerMm: 80,
  boxes: [
    { id: 'logo', band: 'header', x: 0, y: 0, w: 40, h: 25, align: 'start' },
    { id: 'company', band: 'header', x: 45, y: 0, w: 90, h: 30 },
    { id: 'title', band: 'header', x: 140, y: 0, w: 48, h: 20, align: 'end' },
    { id: 'docInfo', band: 'header', x: 0, y: 35, w: 90, h: 30, fontPct: 90 },
    { id: 'customer', band: 'header', x: 95, y: 35, w: 93, h: 30 },
    { id: 'totals', band: 'footer', x: 0, y: 0, w: 100, h: 50 },
    { id: 'qr', band: 'footer', x: 120, y: 0, w: 50, h: 50 },
    { id: 'signatures', band: 'footer', x: 0, y: 55, w: 120, h: 20 },
    { id: 'footer', band: 'footer', x: 125, y: 55, w: 63, h: 20 },
  ],
};

// ─── التركيبات ───

/** قسمٌ يُخفى في كل تصميم (لا الأصناف ولا QR الرول) */
const HIDE: Record<Target['kind'], SectionId> = { a4: 'info', grid: 'parties', roll: 'customer' };
interface Fixture { name: string; free: (t: Target) => Partial<PrintLayout> | null }
const FIXTURES: Fixture[] = [
  { name: 'logoMm30', free: () => ({ logoMm: 30 }) },
  { name: 'logoMmMax', free: () => ({ logoMm: 120 }) },
  { name: 'logoMmMin', free: () => ({ logoMm: 6, logo: 'start' }) },
  { name: 'logoEnd', free: () => ({ logoMm: 20, logo: 'end' }) },
  { name: 'logoTop', free: () => ({ logoAfter: 'top', logo: 'start' }) },
  { name: 'logoAfterItems', free: () => ({ logoAfter: 'items', logo: 'end', logoMm: 25 }) },
  { name: 'logoFooter', free: () => ({ logoAfter: 'footer', logo: 'center' }) },
  { name: 'hideOne', free: (t) => ({ sections: { [HIDE[t.kind]]: { visible: false } } }) },
  { name: 'styleHeader', free: () => ({ sections: { header: { align: 'end', fontPct: 160, spaceBeforeMm: 30, spaceAfterMm: 30 } } }) },
  { name: 'styleAll', free: (t) => ({ sections: Object.fromEntries(sectionsFor(t.printer, t.kind === 'grid' ? 'grid_bilingual' : 'standard').map((id) => [id, { align: 'start', fontPct: 70, spaceBeforeMm: 0.5, spaceAfterMm: 2 }])) }) },
  { name: 'canvas', free: (t) => (t.kind === 'a4' ? { canvas: CANVAS } : null) },
  {
    name: 'combined', free: (t) => ({
      logoMm: 25, logoAfter: 'items', logo: 'end',
      sections: { header: { align: 'center', fontPct: 120, spaceAfterMm: 4 }, footer: { fontPct: 70 }, [HIDE[t.kind]]: { visible: false } },
      ...(t.kind === 'roll' ? { tableStyle: 'grid' } : {}),
      ...(t.kind === 'a4' ? { canvas: { ...CANVAS, boxes: CANVAS.boxes.filter((b) => b.id !== 'logo') } } : {}),
    } as Partial<PrintLayout>),
  },
];

// ─── التصيير ───

const norm = (h: string): string => h.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{60,}/g, 'data:IMG');
function sheet(p: PrintProfile, doc: Doc, design = false): string {
  const inner = createElement(PrintLookContext.Provider, { value: lookFor(p) },
    doc.kind === 'invoice' ? createElement(PrintableInvoice, { doc }) : createElement(PrintableReceipt, { doc }));
  const tree = design ? createElement(PrintDesignPreviewContext.Provider, { value: { active: null } }, inner) : inner;
  return norm(renderToStaticMarkup(tree as ReactElement));
}
async function roll(p: PrintProfile, doc: Doc, markers = false): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile: p, tr: (s: string) => s, capture: (h: string) => { out = h; }, ...(markers ? { markers: true } : {}) };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  assert.ok(out, 'لم تُلتقط وثيقة الرول');
  return norm(out);
}
const render = (t: Target, p: PrintProfile, doc: Doc, design = false): Promise<string> | string =>
  (t.kind === 'roll' ? roll(p, doc, design) : sheet(p, doc, design));

/**
 * أقسام الورقة بترتيبها: الرول والثنائي بغلاف data-sec على المسار الحرّ (والثنائي يحمل كتلتي الشعار وQR المستقلتين data-section)،
 * وA4 القياسي data-section (بلا لوحتي canvas-*)
 */
const sectionIds = (t: Target, h: string): string[] => {
  if (t.kind === 'roll') return [...h.matchAll(/ data-sec="([a-z-]+)"/g)].map((m) => m[1]);
  if (t.kind === 'grid') return [...h.matchAll(/ (?:data-sec="([a-z-]+)"|data-section="(logo|qr)")/g)].map((m) => m[1] ?? m[2]);
  return [...h.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]).filter((id) => !id.startsWith('canvas-'));
};
const LOGO_SRC = LOGO.replace(/[/+]/g, (c) => `\\${c}`);
const logoTags = (h: string): string[] => [...h.matchAll(new RegExp(`<img src="${LOGO_SRC}"[^>]*>`, 'g'))].map((m) => m[0]);
const count = (h: string, s: string): number => h.split(s).length - 1;
/** أكبر بُعدٍ للشعار في وحدته (px للورقة، mm للرول): width/height صريحان أو max-width/max-height */
function logoDims(tag: string, unit: 'px' | 'mm'): number[] {
  return [...tag.matchAll(new RegExp(`(?:^|[;"\\s])(?:max-)?(?:width|height):([0-9.]+)${unit}`, 'g'))].map((m) => Number(m[1]));
}
/** HTML قسمٍ واحد في الورقة: من غلافه (وسمٌ في عنصر — لا قاعدة CSS) إلى الغلاف التالي (تقريبيٌّ كافٍ لاستخراج أسلوبه) */
const sectionHtml = (t: Target, h: string, id: string): string => {
  const attr = t.kind === 'a4' || id === 'logo' && t.kind === 'grid' ? 'data-section' : 'data-sec';
  const at = h.indexOf(` ${attr}="${id}"`);
  if (at < 0) return '';
  const next = h.indexOf(` ${attr}="`, at + 10);
  return h.slice(at, next < 0 ? undefined : next);
};

// ─── المصفوفة ───

const CASES: { t: Target; f: Fixture; free: Partial<PrintLayout>; p: PrintProfile }[] = [];
for (const t of TARGETS) for (const f of FIXTURES) {
  const free = f.free(t);
  if (free) CASES.push({ t, f, free, p: withFree(t.base(), free) });
}

test('حارس المصفوفة: كل القوالب العشرة وكل التركيبات حاضرة، واللوحات على A4 والنقطية القياسية وحدها', () => {
  assert.equal(TARGETS.length, 10);
  for (const t of TARGETS) assert.ok(CASES.filter((c) => c.t === t).length >= FIXTURES.length - 1, t.name);
  assert.equal(CASES.filter((c) => c.f.name === 'canvas').length, 4);
  assert.deepEqual([...new Set(CANVAS.boxes.map((b) => b.id))].sort(), [...CANVAS_BOX_IDS].sort(), 'اللوحة لا تحمل كل المربعات');
  // نسخة الكلاسيكي: مختصرٌ على 58 بشعارٍ مخفيّ (لا يُمسّ الكلاسيكي نفسه)
  const cc = classicCopy();
  assert.equal(cc.template, 'roll_compact');
  assert.equal(cc.paper.widthMm, 58);
  assert.equal(cc.options.layout?.logo, 'none');
});

test('كل تركيبةٍ في المصفوفة صالحةٌ عند الخادم (layoutIssues فارغة) — فما يحفظه المحرّر يُطبع', () => {
  const bad: string[] = [];
  for (const c of CASES) {
    const issues = layoutIssues(c.p, 'p');
    if (issues.length) bad.push(`${c.t.name}/${c.f.name}: ${issues.map((i) => `${i.path} ${i.message}`).join(' | ')}`);
  }
  assert.deepEqual(bad, []);
});

test('الطباعة الحقيقية بلا وسم مصمّم ولا zoom/filter جديد — والوسم يظهر مع سياق المعاينة أو markers', async () => {
  const errors: string[] = [];
  for (const t of TARGETS) {
    const plain = { inv: await render(t, t.base(), inv()), rcp: await render(t, t.base(), rcp()) };
    for (const c of CASES.filter((x) => x.t === t)) {
      for (const [k, doc] of [['inv', inv()], ['rcp', rcp()]] as const) {
        const at = `${t.name}/${c.f.name}/${k}`;
        const out = await render(t, c.p, doc);
        if (!out) { errors.push(`${at}: ورقة فارغة`); continue; }
        if (out.includes('data-pd=')) errors.push(`${at}: وسم مصمّم في طباعة حقيقية`);
        for (const word of ['zoom', 'filter']) {
          if (count(out, word) > count(plain[k], word)) errors.push(`${at}: ${word} جديد في المطبوعة الحرّة`);
        }
        const des = await render(t, c.p, doc, true);
        if (!des.includes('data-pd=')) errors.push(`${at}: لا وسم مصمّم في المعاينة`);
      }
    }
  }
  assert.deepEqual(errors, []);
});

test('الشعار: مرةً واحدة، وصندوقه ≤ logoMm بعد قصّ حدود الهدف، ومحاذاته (start = يمين)، وكتلته المستقلة في مكانها', async () => {
  const errors: string[] = [];
  for (const c of CASES) {
    const { t, p } = c;
    const l = p.options.layout!;
    const preprinted = p.template === 'impact_preprinted';
    for (const doc of [inv(), rcp()]) {
      const at = `${t.name}/${c.f.name}/${doc.kind}`;
      const out = await render(t, p, doc);
      const tags = logoTags(out);
      const expectLogo = !preprinted && l.logo !== 'none';
      if (!expectLogo) { if (tags.length) errors.push(`${at}: شعارٌ مطبوع وهو مخفي`); continue; }
      if (tags.length !== 1) { errors.push(`${at}: الشعار ${tags.length} مرة`); continue; }
      if (l.logoMm !== undefined) {
        const roll = t.kind === 'roll';
        const [lo, hi] = logoMmBounds(roll ? 'roll' : t.kind === 'grid' ? 'grid' : 'page', roll ? geometry(p).printableWidthMm : undefined);
        const mm = Math.min(Math.max(l.logoMm, lo), hi);
        const dims = logoDims(tags[0], roll ? 'mm' : 'px');
        const cap = roll ? mm : mmToPx(mm);
        if (dims.length === 0) errors.push(`${at}: الشعار بلا أبعاد صريحة`);
        else if (Math.max(...dims) > cap + 0.02) errors.push(`${at}: الشعار ${Math.max(...dims)} أكبر من صندوقه ${cap}`);
        if (/object-fit/.test(tags[0])) errors.push(`${at}: object-fit في الشعار الحرّ`);
      }
      const ids = sectionIds(t, out);
      if (l.logoAfter) {
        const want = l.logoAfter;
        const i = ids.indexOf('logo');
        if (i < 0) errors.push(`${at}: لا كتلة شعار مستقلة`);
        else if (want === 'top' && i !== 0) errors.push(`${at}: الكتلة ليست أعلى الورقة (${ids.join(',')})`);
        else if (want === 'footer' && i !== ids.length - 1) errors.push(`${at}: الكتلة ليست آخر الورقة (${ids.join(',')})`);
        else if (want !== 'top' && want !== 'footer' && ids.includes(want) && ids[i - 1] !== want) {
          errors.push(`${at}: الكتلة ليست بعد ${want} (${ids.join(',')})`);
        }
        // المحاذاة على الكتلة المستقلة: start = يمين (flex-start في RTL / text-align:right في الرول)
        const block = sectionHtml(t, out, 'logo');
        const want2 = t.kind === 'roll'
          ? { start: 'text-align:right', end: 'text-align:left', center: 'class="c logo"' }[l.logo as 'start' | 'end' | 'center']
          : { start: 'justify-content:flex-start', end: 'justify-content:flex-end', center: 'justify-content:center' }[l.logo as 'start' | 'end' | 'center'];
        const near = t.kind === 'roll' ? out.slice(Math.max(0, out.indexOf(' data-sec="logo"') - 40), out.indexOf(' data-sec="logo"') + 80) : block;
        if (want2 && !near.includes(want2)) {
          errors.push(`${at}: محاذاة الكتلة ليست ${l.logo}`);
        }
      } else if (ids.includes('logo')) errors.push(`${at}: كتلة شعار مستقلة بلا logoAfter`);
    }
  }
  assert.deepEqual(errors, []);
});

test('الأقسام: المخفي غائب، والمسافتان والمحاذاة (end = يسار) على الغلاف، والخط مضروبٌ في النسبة', async () => {
  const errors: string[] = [];
  for (const t of TARGETS) {
    const base = t.base();
    for (const doc of [inv(), rcp()]) {
      const at = `${t.name}/${doc.kind}`;
      // المخفي
      const hidden = HIDE[t.kind];
      const vis = await render(t, withFree(base, { sections: { [hidden]: { align: 'center' } } }), doc);
      const hid = await render(t, withFree(base, { sections: { [hidden]: { visible: false } } }), doc);
      if (sectionIds(t, vis).includes(hidden)) {
        if (sectionIds(t, hid).includes(hidden)) errors.push(`${at}: ${hidden} المخفي ما زال مطبوعاً`);
        if (hid.length >= vis.length) errors.push(`${at}: إخفاء ${hidden} لم يُنقص الورقة`);
      }
      // قرار المالك ٤ نوفمبر ٢٠٢٦: الأصناف تُخفى بإخفاء الشركة الصريح وحده — والإجماليات باقية؛ وتنسيقها بلا إخفاء يُبقيها
      const items = await render(t, withFree(base, { sections: { items: { visible: false, align: 'center' } } } as Partial<PrintLayout>), doc);
      const itemsKept = await render(t, withFree(base, { sections: { items: { align: 'center' } } } as Partial<PrintLayout>), doc);
      if (doc.kind === 'invoice') {
        if (items.includes('مياه معدنية')) errors.push(`${at}: الأصناف المخفيّة صراحةً ما زالت مطبوعة`);
        if (!items.includes('52.75')) errors.push(`${at}: الإجماليات سقطت مع الأصناف`);
        if (!itemsKept.includes('مياه معدنية')) errors.push(`${at}: الأصناف اختفت بلا إخفاء`);
      }
      // المسافة والمحاذاة
      const styled = await render(t, withFree(base, { sections: { header: { align: 'end', spaceBeforeMm: 30, spaceAfterMm: 30 } } }), doc);
      const head = sectionHtml(t, styled, 'header');
      const wrap = head.slice(0, head.indexOf('>') + 1);
      if (t.kind === 'roll') {
        if (!/text-align:left/.test(wrap) || !/margin-top:30mm/.test(wrap) || !/margin-bottom:30mm/.test(wrap)) errors.push(`${at}: غلاف الرأس بلا أسلوبه: ${wrap}`);
      } else {
        const m = mmToPx(30);
        if (!wrap.includes(`margin-top:${m}px`) || !wrap.includes(`margin-bottom:${m}px`)) errors.push(`${at}: غلاف الرأس بلا مسافته: ${wrap}`);
        if (!wrap.includes('text-align:left')) errors.push(`${at}: end ليس يساراً: ${wrap}`);
      }
      const startHead = sectionHtml(t, await render(t, withFree(base, { sections: { header: { align: 'start' } } }), doc), 'header');
      if (!startHead.slice(0, startHead.indexOf('>') + 1).includes('text-align:right')) errors.push(`${at}: start ليس يميناً`);
      // الخط: 160٪ يضرب بكسل القالب (A4)، أو قاعدة الرول، أو نسبة em في الثنائي
      const f100 = await render(t, withFree(base, { sections: { header: { align: 'end' } } }), doc);
      const f160 = await render(t, withFree(base, { sections: { header: { align: 'end', fontPct: 160 } } }), doc);
      if (t.kind === 'roll') {
        if (!/\[data-sec="header"\] \{ font-size: 17\.6px; \}/.test(f160)) errors.push(`${at}: قاعدة خط الرأس 160٪ غائبة`);
      } else if (t.kind === 'grid') {
        if (!sectionHtml(t, f160, 'header').slice(0, 400).includes('font-size:160%')) errors.push(`${at}: الثنائي بلا نسبة الخط`);
      } else {
        const sizes = (h: string): number[] => [...sectionHtml(t, h, 'header').matchAll(/font-size:([0-9.]+)px/g)].map((m) => Number(m[1]));
        const a = sizes(f100);
        const b = sizes(f160);
        if (a.length === 0 || a.length !== b.length) errors.push(`${at}: عدد أحجام الخط تغيّر ${a.length}→${b.length}`);
        else a.forEach((v, i) => { if (Math.abs(Math.round(v * 160) / 100 - b[i]) > 0.011) errors.push(`${at}: ${v}px ⇒ ${b[i]}px لا ${v * 1.6}`); });
      }
    }
  }
  assert.deepEqual(errors, []);
});

test('اللوحتان على A4 والنقطية القياسية: data-print-canvas على الجذر، وكل مربعٍ في لوحته مرةً واحدة، والسريان بين اللوحتين', () => {
  for (const t of TARGETS.filter((x) => x.kind === 'a4')) {
    const p = withFree(t.base(), { canvas: CANVAS });
    const out = sheet(p, inv());
    assert.match(out, /^<div [^>]*data-print-canvas="1"/, `${t.name}: الجذر بلا data-print-canvas`);
    const head = out.indexOf('data-section="canvas-header"');
    const foot = out.indexOf('data-section="canvas-footer"');
    const items = out.indexOf('مياه معدنية');
    assert.ok(head >= 0 && foot > head, `${t.name}: اللوحتان`);
    assert.ok(items > head && items < foot, `${t.name}: الأصناف ليست بين اللوحتين`);
    assert.equal(count(out, 'INV-777'), count(sheet(t.base(), inv()), 'INV-777'), `${t.name}: رقم المستند تكرّر أو سقط`);
    assert.equal(count(out, 'محمد العتيبي'), count(sheet(t.base(), inv()), 'محمد العتيبي'), `${t.name}: العميل تكرّر أو سقط`);
    // بلا لوحات: لا سمة ولا لوحة
    const plain = sheet(withFree(t.base(), { logoMm: 30 }), inv());
    assert.ok(!plain.includes('data-print-canvas') && !plain.includes('canvas-header'), `${t.name}: سمة لوحاتٍ بلا لوحات`);
    // السند: لوحاتٌ بلا QR ولا تعطّل
    const r = sheet(p, rcp());
    assert.ok(r.includes('RC-55') && r.includes('data-print-canvas'), `${t.name}: السند`);
  }
  // الثنائي والرول لا يقرآن اللوحات ولو وصلت (القراءة المتسامحة)
  for (const t of TARGETS.filter((x) => x.kind === 'grid')) {
    const out = sheet(withFree(t.base(), { canvas: CANVAS }), inv());
    assert.ok(!out.includes('data-print-canvas'), `${t.name}: لوحاتٌ على الثنائي`);
  }
});

test('المصفوفة تلتقط الخلل (برهان الفشل قبل الإصلاح): شعارٌ مكرّر أو أكبر من صندوقه، ووسم مصمّم في الطباعة', () => {
  const t = TARGETS[0];
  const out = sheet(withFree(t.base(), { logoMm: 20 }), inv());
  const tag = logoTags(out)[0];
  assert.ok(tag, 'لا شعار');
  // شعارٌ ممطوط: الأبعاد تُقرأ فتتجاوز الصندوق
  const stretched = tag.replace(/width:[0-9.]+px/, 'width:999px');
  assert.ok(Math.max(...logoDims(stretched, 'px')) > mmToPx(20));
  // شعارٌ مكرّر يُعدّ
  assert.equal(logoTags(out + tag).length, 2);
  // كتلةٌ في غير مكانها تُرى من ترتيب الأقسام
  const top = sheet(withFree(t.base(), { logoAfter: 'top' }), inv());
  assert.equal(sectionIds(t, top)[0], 'logo');
  assert.notEqual(sectionIds(t, top.replace('data-section="logo"', 'data-section="x"'))[0], 'logo');
});

test('الطباعة التجريبية بالتخطيط الحرّ: المستند النموذجيّ يُطبع بكل قالبٍ حرّ (ورقةً أو رولاً بعلامة التجربة)، وبلا وسوم معاينة', async () => {
  const sample = sampleInvoiceDoc(COMPANY, (x: string) => x, new Date('2026-11-03T08:00:00Z'));
  const banner = sampleBannerHtml('نموذج اختبار');
  for (const c of CASES.filter((x) => x.f.name === 'combined' || x.f.name === 'canvas')) {
    const at = `${c.t.name}/${c.f.name}`;
    if (c.t.kind === 'roll') {
      let out = '';
      await printThermalInvoice(sample, { profile: c.p, tr: (x: string) => x, sampleBanner: banner, capture: (h: string) => { out = h; } });
      assert.ok(out.includes('data-sample-banner') && out.includes('class="qrbox"'), `${at}: علامة التجربة أو الرمز`);
      assert.ok(out.includes(' data-sec='), `${at}: الرول التجريبي ليس على المسار الحرّ`);
      assert.ok(!out.includes('data-pd='), `${at}: وسم مصمّم في الطباعة التجريبية`);
    } else {
      const out = sheet(c.p, sample);
      assert.ok(out.includes('alt="QR"') || out.includes('data-qr-value'), `${at}: النموذج بلا رمز`);
      assert.ok(!out.includes('data-pd='), `${at}: وسم مصمّم في الورقة التجريبية`);
    }
  }
  // الورقة النموذجية خارج الشاشة محميّةٌ من سياقي المعاينة (المصمّم ونصوص المطبوعات) ولو فُتحت الأدوات داخل محرّر
  const src = readFileSync(new URL('../components/print/PrintDeviceTools.tsx', import.meta.url), 'utf8');
  assert.match(src, /<PrintDesignPreviewContext\.Provider value=\{null\}>\s*<PrintTextsPreviewContext\.Provider value=\{null\}>\s*<PrintLookContext\.Provider value=\{look\}>\{renderSheet\(sample, sheetRef\)\}/);
  // نافذة المستند في لوحة الإدارة لا تتجاوز عرض الجوال
  assert.match(readFileSync(new URL('../components/DocumentModal.tsx', import.meta.url), 'utf8'), /width: 400, maxWidth: '100%'/);
});
