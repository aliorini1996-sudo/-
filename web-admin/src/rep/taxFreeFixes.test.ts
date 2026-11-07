/**
 * «إزالة الضريبة» — قرارات مرحلة الإصلاح (CONTRACT2، ٧ نوفمبر ٢٠٢٦) على قوالب المستند:
 *
 * E3) إجمالي المرتجع المختوم بلا ضريبة «إجمالي المرتجع» لا «إجمالي المرتجع دائن» — في A4 والقالب ثنائي اللغة والشريط (المختصر
 *     والمفصّل؛ والكلاسيكي كان كذلك)، وسطره الثاني بكل لغة بلا «(Credit)/(avoir)/alacak/贷记». صياغة الشركة للسطر تسري كاليوم،
 *     والمرتجع بضريبته كما هو حرفاً.
 * E4) لا أثر على الشركة بضريبتها: «فاتورة مرتجع» خرجت من PRINT_PHRASES — شركةٌ بضريبتها صاغت عنوان مرتجعها «فاتورة مرتجع» تُترجم
 *     من القاموس كما قبل الميزة ('Return invoice'، 'İade faturası'، '退货单')، والمستند بلا ضريبة وحده بترجمة الورقة ('Return Invoice').
 *     ودخول «إجمالي المرتجع» القاموسَ (لشاشات الواجهة) لا يغيّر ترجمةً تطبعها اليوم شركةٌ صاغت سطراً بهذا النصّ.
 * E5) الشريط الحراري: الفاتورة المختومة بلا ضريبة تُسقط عرض المرحلة الثانية (doc.zatca) — فلا ICV ولا UUID في أيّ قالب.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, type Company, type InvoiceDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { printThermalInvoice, type ThermalPrintOptions } from './thermal';
import {
  defaultPrintLayout, defaultPrintOptions, presetPaper,
  type LayoutDesign, type PaperPresetId, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import { makePrintTexts, normalizePrintTexts, phraseIn, taxFreeDefaultIn, taxFreeDefaultOf } from '../lib/print/printTexts';
import type { PrintSecondLang } from '../lib/print/printTextsCore';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { TAX_FREE_TITLES } from '../lib/taxMode';
import { PHRASES } from '../i18n/strings';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

// ─── المستندات ───

const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const UUID = '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c';
const ON: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا', taxNumber: '300000000000003', phone: '0501234567', logo: LOGO,
  primaryColor: '#1e3a8a', countryCode: 'SA',
};
const OFF: Company = { ...ON, taxDisabled: true };
const ITEMS: InvoiceDoc['items'] = [
  { name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 0, lineTotal: 46, taxAmt: 0 },
];
const freeReturn = (o: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', taxFree: true, isReturn: true, number: 'RET-31', date: '2026-11-07T09:15:00.000Z', type: 'CASH', company: OFF,
  customer: { name: 'بقالة الحي' }, repName: 'أحمد', items: ITEMS, subtotal: 46, discount: 0, tax: 0, total: 46, pricesIncludeTax: false,
  billingReference: 'INV-900', noteReason: 'تالف', zatca: null, ...o,
});
/** مرتجعٌ بضريبته (شركةٌ بضريبتها، بلا ختم) — ورقة اليوم */
const taxedReturn = (o: Partial<InvoiceDoc> = {}): InvoiceDoc => freeReturn({
  taxFree: undefined, company: ON, tax: 6, total: 46, pricesIncludeTax: true,
  items: ITEMS.map((it) => ({ ...it, taxPct: 15, taxAmt: 6 })), ...o,
});
const freeSale = (o: Partial<InvoiceDoc> = {}): InvoiceDoc => freeReturn({
  isReturn: false, number: 'INV-901', billingReference: undefined, noteReason: undefined, ...o,
});
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'reported', documentStatus: 'REPORTED', subtype: '02', documentKind: 'INVOICE', qr: null, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-07T09:15:00.000Z', uuid: UUID, icv: 41, warnings: 0, ...over,
});

const texts = (secondLang: PrintSecondLang | null, edits: Record<string, unknown> = {}) =>
  ({ version: 1, secondLang, companyNameAlt: null, companyAddressAlt: null, edits });
const withTexts = (c: Company, t: ReturnType<typeof texts> | null): Company => ({ ...c, printTexts: t } as Company);

// ─── القوالب ───

const plain = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard'): PrintProfile => ({
  id: `p-${template.replace(/_/g, '-')}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), showLogo: true, layout: defaultPrintLayout(printer, design) },
});
const SHEETS: readonly { name: string; p: PrintProfile | null }[] = [
  { name: 'a4', p: null },
  { name: 'a4-standard', p: plain('page', 'page_branded', 'a4') },
  { name: 'grid', p: plain('page', 'page_branded', 'a4', 'grid_bilingual') },
];
const sheet = (p: PrintProfile | null, doc: InvoiceDoc): string => {
  const el = createElement(PrintableInvoice, { doc });
  return renderToStaticMarkup((p ? createElement(PrintLookContext.Provider, { value: lookFor(p) }, el) : el) as ReactElement);
};
const rollProf = (template: TemplateId, preset: PaperPresetId): PrintProfile => ({
  id: 'van-1', name: 'سيارة', printer: 'thermal', template, paper: presetPaper(preset) as PrintProfile['paper'],
  options: { ...defaultPrintOptions('thermal'), showLogo: true },
});
const ROLLS: readonly { name: string; p: PrintProfile | null; raster?: boolean }[] = [
  { name: 'classic', p: null },
  { name: 'compact58', p: rollProf('roll_compact', 'roll58') },
  { name: 'compact80', p: rollProf('roll_compact', 'roll80') },
  { name: 'detailed80', p: rollProf('roll_detailed', 'roll80') },
  { name: 'detailed112-bt', p: rollProf('roll_detailed', 'roll112'), raster: true },
];
async function roll(doc: InvoiceDoc, p: PrintProfile | null, raster = false): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile: p, tr: (s) => s };
  if (raster) opts.raster = async (h) => { out = h; };
  else opts.capture = (h) => { out = h; };
  await printThermalInvoice(doc, opts);
  return out;
}

const LANGS: readonly (PrintSecondLang | null)[] = [null, 'en', 'fr', 'tr', 'zh'];
const FREE_TOTAL_ALT: Readonly<Record<PrintSecondLang, string>> = { en: 'Total Return', fr: 'Total du retour', tr: 'Toplam İade', zh: '退货合计' };
const CREDIT_WORDS = /إجمالي المرتجع دائن|\(Credit\)|avoir|alacak|贷记|Credit Note|Dekont|通知单/;

// ─── E3 ───

test('E3: المرتجع المختوم بلا ضريبة «إجمالي المرتجع» بسطرٍ ثانٍ بلا «دائن» — A4 والقالب ثنائي اللغة والشريط، بكل لغةٍ ثانية', async () => {
  for (const lang of LANGS) {
    const doc = freeReturn({ company: withTexts(OFF, lang === null ? null : texts(lang)) });
    const outs: [string, string][] = SHEETS.map(({ name, p }) => [name, sheet(p, doc)]);
    for (const { name, p, raster } of ROLLS) outs.push([name, await roll(doc, p, raster)]);
    for (const [name, html] of outs) {
      const label = `${name}/${lang ?? 'none'}`;
      assert.ok(html.includes('إجمالي المرتجع'), `${label}: «إجمالي المرتجع»`);
      assert.doesNotMatch(html, CREDIT_WORDS, label);
      if (lang && name !== 'classic') assert.ok(html.includes(FREE_TOTAL_ALT[lang]), `${label}: ${FREE_TOTAL_ALT[lang]}`);
    }
  }
});

test('E3: القالب ثنائي اللغة بلا نصوص يطبع «Total Return» بجوار «إجمالي المرتجع» — والمرتجع بضريبته «Total Return (Credit)» كاليوم', () => {
  const grid = SHEETS.find((s) => s.name === 'grid')!.p;
  const free = sheet(grid, freeReturn());
  assert.ok(free.includes('إجمالي المرتجع') && free.includes('Total Return') && !free.includes('(Credit)'));
  const taxed = sheet(grid, taxedReturn());
  assert.ok(taxed.includes('إجمالي المرتجع دائن') && taxed.includes('Total Return (Credit)'), 'المرتجع بضريبته كما هو');
});

test('E3: صياغة الشركة لسطر إجمالي المرتجع (tot.returnGrand) تسري على المستند بلا ضريبة — وحذفه يحذفه', async () => {
  const edits = { 'tot.returnGrand': { text: 'صافي المرتجع', alt: 'Net return', hidden: false } };
  const doc = freeReturn({ company: withTexts(OFF, texts('en', edits)) });
  for (const { name, p } of SHEETS) {
    const h = sheet(p, doc);
    assert.ok(h.includes('صافي المرتجع') && h.includes('Net return') && !h.includes('Total Return'), name);
  }
  for (const { name, p } of ROLLS.filter((r) => r.p)) {
    const h = await roll(doc, p);
    assert.ok(h.includes('صافي المرتجع') && h.includes('Net return'), name);
  }
  const gone = freeReturn({ company: withTexts(OFF, texts('en', { 'tot.returnGrand': { text: null, alt: null, hidden: true } })) });
  for (const { name, p } of ROLLS.filter((r) => r.p)) assert.ok(!(await roll(gone, p)).includes('إجمالي المرتجع'), `${name}: محذوف`);
});

test('E3: المرتجع بضريبته (بلا ختم) — «إجمالي المرتجع دائن» وسطره الثاني كما هما حرفاً في كل قالب، والختم false كالغائب', async () => {
  for (const lang of LANGS) {
    const c = withTexts(ON, lang === null ? null : texts(lang));
    const doc = taxedReturn({ company: c });
    for (const { name, p } of SHEETS) {
      const h = sheet(p, doc);
      assert.ok(h.includes('إجمالي المرتجع دائن'), `${name}/${lang}`);
      assert.equal(sheet(p, { ...doc, taxFree: false }), h, `${name}/${lang}: taxFree:false`);
    }
    for (const { name, p, raster } of ROLLS.filter((r) => r.p)) {
      const h = await roll(doc, p, raster);
      assert.ok(h.includes('إجمالي المرتجع دائن'), `${name}/${lang}`);
      if (lang === 'fr') assert.ok(h.includes('Total du retour (avoir)'), `${name}: ترجمة اليوم`);
    }
  }
});

test('E3: ترجمة افتراضيّ المستند بلا ضريبة بمفتاحه وحده — taxFreeDefaultOf/In', () => {
  assert.equal(taxFreeDefaultOf('tot.returnGrand'), 'إجمالي المرتجع');
  assert.equal(taxFreeDefaultOf('inv.returnTitle'), TAX_FREE_TITLES.return);
  assert.equal(taxFreeDefaultOf('tot.grand'), null);
  assert.equal(taxFreeDefaultOf('constructor'), null);
  for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
    assert.equal(taxFreeDefaultIn('tot.returnGrand', 'إجمالي المرتجع', lang), FREE_TOTAL_ALT[lang]);
    assert.equal(taxFreeDefaultIn('tot.returnGrand', 'إجمالي المرتجع دائن', lang), null, 'افتراضيّ اليوم لا يُمسّ');
    assert.equal(taxFreeDefaultIn('tot.grand', 'إجمالي المرتجع', lang), null, 'مفتاحٌ آخر');
    assert.doesNotMatch(taxFreeDefaultIn('inv.returnTitle', TAX_FREE_TITLES.return, lang) as string, CREDIT_WORDS);
  }
});

// ─── E4 ───

/** ترجمة «فاتورة مرتجع» قبل الميزة: القاموس (8833e90 — PRINT_PHRASES لم يحملها) */
const DICT_RETURN: Readonly<Record<PrintSecondLang, string>> = { en: 'Return invoice', fr: 'Facture de retour', tr: 'İade faturası', zh: '退货单' };

test('E4: شركةٌ بضريبتها صاغت عنوان مرتجعها «فاتورة مرتجع» — سطره الثاني من القاموس كما قبل الميزة في A4 والقالب ثنائي اللغة والشريط', async () => {
  for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
    assert.equal(phraseIn(TAX_FREE_TITLES.return, lang), DICT_RETURN[lang], `phraseIn/${lang}`);
    assert.equal(phraseIn(TAX_FREE_TITLES.return, lang), PHRASES[TAX_FREE_TITLES.return][lang], `${lang}: القاموس وحده`);
    const edits = { 'inv.returnTitle': { text: TAX_FREE_TITLES.return, alt: null, hidden: false } };
    const pt = makePrintTexts(normalizePrintTexts(texts(lang, edits)), (s) => s);
    assert.deepEqual(pt.title('إشعار دائن مرتجع', { isReturn: true, phase2: false }), { text: TAX_FREE_TITLES.return, alt: DICT_RETURN[lang] }, lang);
    const doc = taxedReturn({ company: withTexts(ON, texts(lang, edits)) });
    for (const { name, p } of SHEETS) {
      const h = sheet(p, doc);
      assert.ok(h.includes(DICT_RETURN[lang]), `${name}/${lang}: ${DICT_RETURN[lang]}`);
      if (lang !== 'fr') assert.ok(!h.includes('Return Invoice') && !h.includes('İade Faturası') && !h.includes('退货发票'), `${name}/${lang}`);
    }
    for (const { name, p } of ROLLS.filter((r) => r.p)) {
      const h = await roll(doc, p);
      assert.ok(h.includes(DICT_RETURN[lang]), `${name}/${lang}`);
    }
  }
  // القالب ثنائي اللغة بلا لغةٍ ثانية: السطر الإنجليزي من القاموس ('Return invoice') كما قبل الميزة
  const grid = SHEETS.find((s) => s.name === 'grid')!.p;
  const noLang = sheet(grid, taxedReturn({ company: withTexts(ON, texts(null, { 'inv.returnTitle': { text: TAX_FREE_TITLES.return, alt: null, hidden: false } })) }));
  assert.ok(noLang.includes('Return invoice') && !noLang.includes('Return Invoice'));
});

test('E4: المستند بلا ضريبة وحده بترجمة الورقة «Return Invoice» — بلا نصوص، وبلغةٍ ثانية، وبنصٍّ ثانٍ محفوظٍ لعنوانٍ آخر', async () => {
  const grid = SHEETS.find((s) => s.name === 'grid')!.p;
  assert.ok(sheet(grid, freeReturn()).includes('Return Invoice'), 'القالب ثنائي اللغة بلا نصوص');
  assert.ok(sheet(grid, freeReturn({ company: withTexts(OFF, texts(null, { 'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false } })) })).includes('Return Invoice'));
  const alts: Record<PrintSecondLang, string> = { en: 'Return Invoice', fr: 'Facture de retour', tr: 'İade Faturası', zh: '退货发票' };
  for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
    const pt = makePrintTexts(normalizePrintTexts(texts(lang)), (s) => s);
    assert.deepEqual(pt.title(TAX_FREE_TITLES.return, { isReturn: true, phase2: false }), { text: TAX_FREE_TITLES.return, alt: alts[lang] }, lang);
    // نصٌّ ثانٍ كُتب لـ«إشعار دائن مرتجع» بلا صياغة عربية لا يُطبع تحت «فاتورة مرتجع»
    const altOnly = makePrintTexts(normalizePrintTexts(texts(lang, { 'inv.returnTitle': { text: null, alt: 'Credit Note', hidden: false } })), (s) => s);
    assert.deepEqual(altOnly.title(TAX_FREE_TITLES.return, { isReturn: true, phase2: false }), { text: TAX_FREE_TITLES.return, alt: alts[lang] }, `${lang}: نصٌّ ثانٍ لعنوانٍ آخر`);
    const doc = freeReturn({ company: withTexts(OFF, texts(lang)) });
    for (const { name, p } of SHEETS) assert.ok(sheet(p, doc).includes(alts[lang]), `${name}/${lang}`);
    for (const { name, p } of ROLLS.filter((r) => r.p)) assert.ok((await roll(doc, p)).includes(alts[lang]), `${name}/${lang}`);
  }
  // البيع بلا ضريبة: «فاتورة»/«Invoice» كما هو
  assert.ok(sheet(grid, freeSale()).includes('>Invoice<'));
});

test('E4: دخول «إجمالي المرتجع» القاموسَ (مفتاح واجهة) لا يغيّر سطراً ثانياً تطبعه شركةٌ صاغت سطراً بهذا النصّ', () => {
  const key = 'إجمالي المرتجع';
  assert.equal(phraseIn(key, 'tr'), null);
  assert.equal(phraseIn(key, 'zh'), null);
  assert.equal(phraseIn(key, 'en'), 'Total Return', 'ترجمة الورقة القائمة');
  const had = Object.prototype.hasOwnProperty.call(PHRASES, key);
  const saved = PHRASES[key];
  PHRASES[key] = { en: 'Total return', fr: 'Total du retour', tr: 'Toplam iade', zh: '退货合计' };
  try {
    assert.equal(phraseIn(key, 'tr'), null, 'التركية كما كانت');
    assert.equal(phraseIn(key, 'zh'), null, 'الصينية كما كانت');
    assert.equal(phraseIn(key, 'en'), 'Total Return');
    assert.equal(phraseIn(key, 'fr'), 'Total du retour');
    for (const lang of ['tr', 'zh'] as const) {
      const pt = makePrintTexts(normalizePrintTexts(texts(lang, { 'tot.grand': { text: key, alt: null, hidden: false } })), (s) => s);
      assert.equal(pt.alt('tot.grand', 'الإجمالي'), null, `${lang}: صياغة الشركة بلا سطرٍ ثانٍ كاليوم`);
      // والمستند بلا ضريبة بافتراضيّه: ترجمة الورقة
      const free = makePrintTexts(normalizePrintTexts(texts(lang)), (s) => s);
      assert.equal(free.alt('tot.returnGrand', key), FREE_TOTAL_ALT[lang]);
    }
  } finally {
    if (had) PHRASES[key] = saved; else delete PHRASES[key];
  }
});

// ─── E5 ───

test('E5: الشريط الحراري — الفاتورة المختومة بلا ضريبة لا تطبع ICV ولا UUID ولو حملت عرض مرحلةٍ ثانية، بكل قالب وبكل لغة', async () => {
  const views = [zv(), zv({ subtype: '01', documentStatus: 'CLEARANCE_PENDING' as ZatcaDocView['documentStatus'] }), zv({ mode: 'rehearsal' as ZatcaDocView['mode'] })];
  for (const z of views) {
    for (const make of [freeSale, freeReturn]) {
      for (const lang of LANGS) {
        const doc = make({ zatca: z, company: withTexts(OFF, lang === null ? null : texts(lang)) });
        for (const { name, p, raster } of ROLLS) {
          const h = await roll(doc, p, raster);
          const label = `${name}/${lang ?? 'none'}/${z.mode}/${z.subtype}`;
          assert.ok(h.length > 300, `${label}: لا وثيقة`);
          assert.ok(!h.includes('ICV') && !h.includes(UUID), `${label}: ICV/UUID`);
        }
      }
    }
  }
});

test('E5: بلا ختم — عرض المرحلة الثانية يطبع ICV وUUID كاليوم (الحارس حسّاس)، والمستند الأصلي لا يتغيّر', async () => {
  const doc = freeSale({ taxFree: undefined, company: ON, zatca: zv({ qr: null }) });
  const h = await roll(doc, rollProf('roll_compact', 'roll80'));
  assert.ok(h.includes('ICV') && h.includes(UUID), 'المستند بضريبته');
  const stamped = freeSale({ zatca: zv() });
  await roll(stamped, rollProf('roll_compact', 'roll80'));
  assert.equal(stamped.zatca?.icv, 41, 'نسخةٌ للطباعة — لا يُمسّ المستند الممرَّر');
});
