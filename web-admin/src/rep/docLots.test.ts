/**
 * «تتبّع اللوط» — W3: التشغيلة على الأوراق المطبوعة (rep/docLots.ts وعارضاتها في RepDocuments.tsx وthermal.ts).
 *
 * ١) المنطق الصرف: شرط lotOnInvoice مع الميزة، والصفوف الصالحة، والكمية بوحدة السطر حين تنقسم وإلا بالأساس موسومةً، واليوم نصّاً.
 * ٢) **العارضات الأربعة للفاتورة** (A4، والشريط الكلاسيكي، والقالبان الجديدان) تُرسم فعلاً: النصّ نفسه (lotLineText) تحت كل
 *    بند مع الشرط، وبدونه — أو والميزة مطفأة — الورقة **حرفاً بحرف** كورقةٍ بلا تشغيلات (§١٠.١). ورقم التشغيلة مُهرَّب.
 * ٣) الإشعاران (التحميل والمستودع): عمود «التشغيلة / الانتهاء» متى وُجدت تشغيلة، بلا شرط lotOnInvoice، وcolSpan والتذييل.
 * ٤) ما لا يُطبع: لا شيء في رمز QR.
 *
 * thermal.ts يُستورد كما هو (لا DOM في node): إطارٌ مزيّف يلتقط ما يُكتب فيه — كـthermalHtml.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { docLotRows, invoiceLotsOf, lotCellText, lotDayText, lotLineText, lotQtyInLine, noticeHasLots, warehouseLineLots } from './docLots';
import { localizeDigits, printThermalInvoice } from './thermal';
import {
  DocumentResult, PrintableInvoice, PrintableLoadNotice, PrintableWarehouseNotice, invoiceDocFromDetail, loadNoticeDocFromData, warehouseNoticeDocFromEntry,
  type InvoiceDoc, type LoadNoticeDoc, type WarehouseNoticeDoc,
} from './RepDocuments';
import { defaultPrintOptions, presetPaper, type PaperPresetId, type PrintProfile, type TemplateId } from '../lib/print/printSettings';
import type { DocLotLine } from '../lib/lots';

const same = (s: string) => s;
const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');

// ─── ١) المنطق الصرف ───

test('invoiceLotsOf: بشرط «طباعة التشغيلة على الفاتورة» مع الميزة — وغيابهما أو أحدهما لا شيء', () => {
  const item = { lots: [{ lotNumber: 'A', qty: 2 }, { lotNumber: 'B', qty: 0 }] };
  assert.deepEqual(invoiceLotsOf({ lotTrackingEnabled: true, lotOnInvoice: true }, item), [{ lotNumber: 'A', qty: 2 }], 'الصفريّ يسقط');
  assert.deepEqual(invoiceLotsOf({ lotTrackingEnabled: true, lotOnInvoice: false }, item), []);
  assert.deepEqual(invoiceLotsOf({ lotTrackingEnabled: false, lotOnInvoice: true }, item), [], 'الميزة المطفأة تُسكت الإعداد');
  assert.deepEqual(invoiceLotsOf({ lotOnInvoice: true }, item), [], 'نسخة شركة قديمة بلا العَلَم = مطفأة');
  assert.deepEqual(invoiceLotsOf({ lotTrackingEnabled: 'true', lotOnInvoice: 'true' }, item), [], 'true صريحة وحدها');
  assert.deepEqual(invoiceLotsOf(null, item), []);
  assert.deepEqual(invoiceLotsOf({ lotTrackingEnabled: true, lotOnInvoice: true }, {}), []);
});

test('docLotRows: الكمية الموجبة المحدودة وحدها، والمشوّه يسقط', () => {
  const rows = [
    { lotNumber: 'A', qty: 1 }, { lotNumber: 'B', qty: -1 }, { lotNumber: 'C', qty: Number.NaN }, null,
    { lotNumber: 'D', qty: 1e-9 }, { lotNumber: null, qty: 3 },
  ] as unknown as DocLotLine[];
  assert.deepEqual(docLotRows(rows).map((l) => l.lotNumber), ['A', null]);
  assert.deepEqual(docLotRows(undefined), []);
  assert.deepEqual(docLotRows('x' as unknown as DocLotLine[]), []);
});

test('lotQtyInLine: بوحدة السطر حين تنقسم على معامله تماماً، وإلا بالأساس موسومةً', () => {
  assert.deepEqual(lotQtyInLine(48, 24), { qty: 2, base: false }, 'كرتونان لا «٤٨»');
  assert.deepEqual(lotQtyInLine(30, 24), { qty: 30, base: true });
  assert.deepEqual(lotQtyInLine(5, 1), { qty: 5, base: false });
  assert.deepEqual(lotQtyInLine(5, null), { qty: 5, base: false });
  assert.deepEqual(lotQtyInLine(-12, 6), { qty: 2, base: false }, 'إشارة الحركة لا تُطبع');
  assert.deepEqual(lotQtyInLine(2.000001, 1), { qty: 2, base: false }, 'أربع خانات');
  assert.deepEqual(lotQtyInLine(6, 0), { qty: 6, base: false }, 'المعامل التالف ١');
});

test('lotDayText: يومٌ تقويمي من النصّ — لا إزاحة منطقة', () => {
  assert.equal(lotDayText('2026-12-01'), '01/12/2026');
  assert.equal(lotDayText('2026-12-01T00:00:00.000Z'), '01/12/2026');
  assert.equal(lotDayText(null), '');
  assert.equal(lotDayText('غدا'), '');
});

test('lotLineText وlotCellText: نصٌّ واحد للعارضات، والأرقام بأرقام العارض ورقم التشغيلة كما هو', () => {
  const tr = (s: string) => s;
  assert.equal(lotLineText({ lotNumber: 'A12', qty: 48, expiryDate: '2026-12-01' }, { tr, unitFactor: 24 }), 'تشغيلة A12 ×2 · ينتهي 01/12/2026');
  assert.equal(lotLineText({ lotNumber: null, qty: 5 }, { tr }), 'تشغيلة غير معروفة ×5');
  assert.equal(lotLineText({ lotNumber: 'B7', qty: 30 }, { tr, unitFactor: 24 }), 'تشغيلة B7 ×30 بوحدة الأساس');
  const ar = (s: string) => s.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
  assert.equal(lotLineText({ lotNumber: 'A12', qty: 48, expiryDate: '2026-12-01' }, { tr, unitFactor: 24, digits: ar }), 'تشغيلة A12 ×٢ · ينتهي ٠١/١٢/٢٠٢٦');
  assert.equal(lotCellText({ lotNumber: 'A12', qty: 48, expiryDate: '2026-12-01' }, { tr, unitFactor: 24, withQty: false }), 'A12 · ينتهي 01/12/2026');
  assert.equal(lotCellText({ lotNumber: 'A12', qty: 48, expiryDate: null }, { tr, unitFactor: 24, withQty: true }), 'A12 · ×2');
  assert.equal(lotCellText({ lotNumber: null, qty: 7 }, { tr, withQty: true }), 'غير مسمى · ×7');
  const brackets = (s: string) => `[${s}]`;
  assert.equal(lotLineText({ lotNumber: 'A', qty: 1, expiryDate: '2026-01-02' }, { tr: brackets }), '[تشغيلة] A ×1 · [ينتهي] 02/01/2026', 'كل كلمةٍ مترجمة');
});

test('noticeHasLots وwarehouseLineLots: العمود متى وُجدت تشغيلة، وسطر المستودع تشغيلةٌ واحدة بالأساس', () => {
  assert.equal(noticeHasLots([{}, { lots: [] }]), false);
  assert.equal(noticeHasLots([{}, { lots: [{ lotNumber: 'A', qty: 1 }] }]), true);
  assert.equal(noticeHasLots([{ lots: [{ lotNumber: 'A', qty: 0 }] }]), false);
  assert.deepEqual(warehouseLineLots({ lotNumber: 'W1', expiryDate: '2027-01-01T00:00:00.000Z' }, -24), [{ lotNumber: 'W1', qty: 24, expiryDate: '2027-01-01' }]);
  assert.equal(warehouseLineLots(null, 5), undefined);
  assert.equal(warehouseLineLots({ lotNumber: '' }, 5), undefined);
});

// ─── ٢) العارضات الأربعة للفاتورة ───

// إطارٌ مزيّف: ما يُكتب في iframe الطباعة الحرارية (thermalHtml.test.ts)
interface Frame { html: string }
const frames: Frame[] = [];
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => {
    const f: Frame = { html: '' };
    frames.push(f);
    const rule = { textContent: '' };
    const idoc = {
      open() {}, close() {}, write(h: string) { f.html = h; },
      images: [], fonts: { ready: Promise.resolve() },
      querySelectorAll: (sel: string) => (sel === 'section.copy'
        ? Array.from({ length: (f.html.match(/<section class="copy">/g) || []).length }, () => ({ getBoundingClientRect: () => ({ height: 400 }) }))
        : []),
      getElementById: (id: string) => (id === 'fs-page' ? rule : null),
    };
    return {
      setAttribute() {}, remove() {},
      style: { cssText: '' },
      contentWindow: { document: idoc, focus() {}, print() {} },
    };
  },
  body: { appendChild() {} },
};

const norm = (s: string) => s.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{200,}/g, 'data:QR');
const profile = (template: TemplateId, preset: PaperPresetId): PrintProfile => ({
  id: 'van-1', name: 'سيارة 1', printer: 'thermal', template, paper: presetPaper(preset)!, options: { ...defaultPrintOptions('thermal') },
});
async function thermalHtml(doc: InvoiceDoc, p: PrintProfile | undefined): Promise<string> {
  const before = frames.length;
  await printThermalInvoice(doc, p ? { profile: p } : undefined);
  assert.equal(frames.length, before + 1, 'إطار طباعة واحد');
  return norm(frames[frames.length - 1].html);
}

const companyBase = { name: 'شركة الاختبار للتوزيع', taxNumber: '300000000000003', address: 'الرياض حي العليا', phone: '0501234567', countryCode: 'SA' };
const LOTS: Record<string, DocLotLine[]> = {
  water: [{ lotNumber: 'A12', qty: 48, expiryDate: '2026-12-01' }, { lotNumber: 'B7', qty: 30, expiryDate: null }],
  juice: [{ lotNumber: null, qty: 3 }],
  evil: [{ lotNumber: 'X<1>&"', qty: 1, expiryDate: '2027-01-01' }],
};
const docOf = (company: InvoiceDoc['company'], withLots: boolean): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-8800', date: '2026-10-23T10:30:00', type: 'CASH', company, customer: { name: 'بقالة النور' }, repName: 'أحمد',
  items: [
    { name: 'ماء 330 مل', unit: 'كرتون', unitFactor: 24, qty: 3.25, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 74.75, ...(withLots && { lots: LOTS.water }) },
    { name: 'عصير برتقال', qty: 3, unitPrice: 11.5, discountPct: 10, taxPct: 15, lineTotal: 31.05, ...(withLots && { lots: LOTS.juice }) },
    { name: 'شاي', qty: 1, unitPrice: 5, discountPct: 0, taxPct: 15, lineTotal: 5, ...(withLots && { lots: LOTS.evil }) },
    { name: 'سكر', qty: 1, unitPrice: 4, discountPct: 0, taxPct: 15, lineTotal: 4 },
  ],
  subtotal: 114.8, discount: 0, tax: 17.22, total: 132.02,
});
const ON = { ...companyBase, lotTrackingEnabled: true, lotOnInvoice: true };
const OFFS = {
  'lotOnInvoice مطفأ': { ...companyBase, lotTrackingEnabled: true, lotOnInvoice: false },
  'الميزة مطفأة': { ...companyBase, lotTrackingEnabled: false, lotOnInvoice: true },
  'نسخة قديمة بلا العلمين': { ...companyBase },
};
const RENDERERS: [string, PrintProfile | undefined][] = [
  ['الشريط الكلاسيكي', undefined],
  ['القالب المختصر', profile('roll_compact', 'roll80')],
  ['القالب المفصّل', profile('roll_detailed', 'roll80')],
];
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('الشرائط الحرارية الثلاثة: سطرٌ لكل تشغيلة بالنصّ نفسه مع الشرط — وبدونه الورقة حرفاً بحرف كورقةٍ بلا تشغيلات', async () => {
  const items = docOf(ON, true).items;
  for (const [name, p] of RENDERERS) {
    const html = await thermalHtml(docOf(ON, true), p);
    let lines = 0;
    for (const it of items) {
      for (const l of it.lots ?? []) {
        const text = escHtml(lotLineText(l, { tr: same, unitFactor: it.unitFactor, digits: localizeDigits }));
        assert.ok(html.includes(`<div class="muted">${text}</div>`), `${name}: «${text}» غائب`);
        lines++;
      }
    }
    assert.equal((html.match(/<div class="muted">تشغيلة /g) ?? []).length, lines, `${name}: سطرٌ لكل تشغيلة لا أكثر`);
    assert.ok(html.includes('X&lt;1&gt;&amp;&quot;') && !html.includes('X<1>'), `${name}: رقم التشغيلة مُهرَّب`);
    // كرتونان من «A12» (٤٨ حبة) وثلاثون حبة من «B7» بالأساس — والسطر بالكرتون
    assert.ok(html.includes(`تشغيلة A12 ×${localizeDigits('2')} · ينتهي ${localizeDigits('01/12/2026')}`), name);
    assert.ok(html.includes(`تشغيلة B7 ×${localizeDigits('30')} بوحدة الأساس`), name);
    const plain = await thermalHtml(docOf(ON, false), p);
    for (const [why, company] of Object.entries(OFFS)) {
      const off = await thermalHtml(docOf(company, true), p);
      const offPlain = await thermalHtml(docOf(company, false), p);
      assert.equal(off, offPlain, `${name} (${why}): الورقة تغيّرت بلا شرطها`);
      assert.ok(!off.includes('تشغيلة'), `${name} (${why}): تشغيلةٌ مطبوعة`);
    }
    assert.ok(!plain.includes('تشغيلة'), `${name}: بندٌ بلا صفوف لا يطبع شيئاً`);
  }
});

test('قالب A4: النصّ نفسه تحت اسم البند مع الشرط — وبدونه الورقة حرفاً بحرف كورقةٍ بلا تشغيلات', () => {
  const a4 = (doc: InvoiceDoc) => renderToStaticMarkup(createElement(PrintableInvoice, { doc }));
  const doc = docOf(ON, true);
  const html = a4(doc);
  for (const it of doc.items) {
    for (const l of it.lots ?? []) {
      const text = escHtml(lotLineText(l, { tr: same, unitFactor: it.unitFactor }));
      assert.ok(html.includes(`>${text}</div>`), `A4: «${text}» غائب`);
    }
  }
  assert.ok(html.includes('تشغيلة A12 ×2 · ينتهي 01/12/2026'));
  assert.ok(!html.includes('X<1>'), 'A4: رقم التشغيلة مُهرَّب');
  for (const [why, company] of Object.entries(OFFS)) {
    assert.equal(a4(docOf(company, true)), a4(docOf(company, false)), `A4 (${why}): الورقة تغيّرت بلا شرطها`);
  }
  assert.ok(!a4(docOf(ON, false)).includes('تشغيلة'));
});

test('رمز QR لا يحمل التشغيلة: المرحلة الأولى تُبنى من بيانات الفاتورة وحدها', () => {
  const z = src('rep', 'zatca.ts');
  assert.ok(!/\blots?\b|lotNumber|docLots/i.test(z), 'zatca.ts يذكر التشغيلة');
});

test('حرّاسٌ نصّية: العارضات الثلاثة في thermal.ts وA4 تمرّ بـdocLots — لا يكتب أيٌّ منها سطر التشغيلة لنفسه', () => {
  const t = src('rep', 'thermal.ts');
  assert.equal((t.match(/\$\{lotRows\(doc, it, (asIs|tr)\)\}/g) ?? []).length, 3, 'الكلاسيكي والمختصر والمفصّل');
  assert.match(t, /return invoiceLotsOf\(doc\.company, it\)/);
  const r = src('rep', 'RepDocuments.tsx');
  assert.equal((r.match(/invoiceLotsOf\(doc\.company, it\)/g) ?? []).length, 1, 'A4');
  assert.match(r, /\{doc\.kind === 'invoice' && showLotsStrip && <InvoiceLotsStrip doc=\{doc\} \/>\}/, 'شريط «تشغيلات البنود» للإدارة خارج الورقة');
});

test('شريط «تشغيلات البنود» للإدارة وحدها (§٦.١): شاشة المندوب بلا شريط ولو حملت البنود تشغيلاتها، ولوحة الإدارة وتطبيق /m به', () => {
  // الميزة مفعّلة وlotOnInvoice مطفأ: المالك اختار ألّا تظهر التشغيلة على ما يُري المندوبُ العميلَ
  const doc = docOf(OFFS['lotOnInvoice مطفأ'], true);
  const rep = renderToStaticMarkup(createElement(DocumentResult, { doc, onClose: () => {} }));
  assert.ok(!rep.includes('تشغيلات البنود') && !rep.includes('A12'), 'المندوب: لا شريط ولا رقم تشغيلة');
  const admin = renderToStaticMarkup(createElement(DocumentResult, { doc, onClose: () => {}, showLotsStrip: true }));
  assert.ok(admin.includes('تشغيلات البنود') && admin.includes('A12'), 'الإدارة: الشريط بتشغيلات البنود');
  // ومن يمرّره: نافذة لوحة الإدارة وشاشة /m — لا تطبيق المندوب
  assert.match(src('components', 'DocumentModal.tsx'), /<DocumentResult doc=\{doc\} onClose=\{onClose\} showLotsStrip \/>/);
  assert.match(src('m', 'MDocScreen.tsx'), /<DocumentResult doc=\{doc\} onClose=\{onClose\} showLotsStrip \/>/);
  assert.ok(!/showLotsStrip/.test(src('rep', 'RepApp.tsx')), 'RepApp لا يمرّره');
});

// ─── ٣) الإشعاران ───

test('إشعار التحميل: عمود «التشغيلة / الانتهاء» متى وُجدت تشغيلة (سطرٌ لكل تشغيلة، وكمّيتها حين يتوزّع البند) — وبدونها كما كان', () => {
  const mv = (lots: boolean) => loadNoticeDocFromData('أحمد', {
    kind: 'LOAD', date: '2026-10-23T08:00:00.000Z', ref: 'ref-1', by: 'مدير',
    items: [
      { name: 'ماء', qty: 3, unitName: 'كرتون', unitFactor: 24, ...(lots && { lots: [
        { lotId: 'l1', qty: 48, lot: { lotNumber: 'A12', expiryDate: '2026-12-01T00:00:00.000Z' } },
        { lotId: null, qty: 24 },
      ] }) },
      { name: 'عصير', qty: 2, unit: 'علبة', ...(lots && { lots: [{ lotId: 'l2', qty: 2, lot: { lotNumber: 'J1', expiryDate: null } }] }) },
      { name: 'سكر', qty: 1, unit: 'كيس' },
    ],
  }, { ...companyBase });
  const render = (doc: LoadNoticeDoc) => renderToStaticMarkup(createElement(PrintableLoadNotice, { doc }));
  const withLots = mv(true);
  assert.deepEqual(withLots.items[0].lots, [{ lotNumber: 'A12', qty: 48, expiryDate: '2026-12-01' }, { lotNumber: null, qty: 24, expiryDate: null }]);
  assert.equal(withLots.items[2].lots, undefined);
  const html = render(withLots);
  assert.ok(html.includes('التشغيلة / الانتهاء'), 'العمود بلا شرط lotOnInvoice');
  assert.ok(html.includes('<div>A12 · ينتهي 01/12/2026 · ×2</div>'), 'الكمية بوحدة السطر حين يتوزّع البند');
  assert.ok(html.includes('<div>غير مسمى · ×1</div>'));
  assert.ok(html.includes('<div>J1</div>'), 'تشغيلةٌ واحدة بلا كمية');
  assert.equal((html.match(/<td[^>]*>-<\/td>/g) ?? []).length >= 1, true, 'البند بلا تشغيلات «-»');
  const plain = render(mv(false));
  assert.ok(!plain.includes('التشغيلة / الانتهاء'), 'بلا تشغيلات: بلا عمود');
  assert.equal((html.match(/<th/g) ?? []).length, (plain.match(/<th/g) ?? []).length + 1, 'عمودٌ واحد زائد');
  assert.equal((html.match(/<td/g) ?? []).length, (plain.match(/<td/g) ?? []).length + 3 + 1, 'خانةٌ لكل بند وللتذييل');
  const empty = render({ ...withLots, items: [] });
  assert.ok(empty.includes('colSpan="4"') || empty.includes('colspan="4"'));
});

test('إشعار حركة المستودع: تشغيلة كل سطرٍ من السجل، والعمود قبل السعر، وتذييل القيمة يمتدّ بعموده', () => {
  const entry = (lot: boolean) => warehouseNoticeDocFromEntry({
    id: 'e1', type: 'RECEIVE', createdAt: '2026-10-23T08:00:00.000Z', supplier: 'المورد', createdBy: 'مدير', totalCost: 120,
    items: [
      { qty: 2, unitName: 'كرتون', unitFactor: 24, unitCost: 48, lineCost: 96, product: { name: 'ماء', unit: 'حبة' }, ...(lot && { lot: { lotNumber: 'W-1', productionDate: null, expiryDate: '2027-02-01T00:00:00.000Z' } }) },
      { qty: 6, unitCost: 4, lineCost: 24, product: { name: 'عصير', unit: 'علبة' }, lot: null },
    ],
  }, { ...companyBase });
  const doc = entry(true);
  assert.deepEqual(doc.items[0].lots, [{ lotNumber: 'W-1', qty: 48, expiryDate: '2027-02-01' }], 'كمية التشغيلة بالأساس');
  assert.equal(doc.items[1].lots, undefined);
  const render = (d: WarehouseNoticeDoc) => renderToStaticMarkup(createElement(PrintableWarehouseNotice, { doc: d }));
  const html = render(doc);
  assert.ok(html.includes('<div>W-1 · ينتهي 01/02/2027</div>'));
  const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.ok(heads.indexOf('التشغيلة / الانتهاء') === heads.indexOf('الوحدة') + 1, 'بعد الوحدة');
  assert.ok(heads.indexOf('التشغيلة / الانتهاء') < heads.indexOf('سعر الوحدة قبل الضريبة'), 'قبل السعر');
  assert.ok(/colSpan="6"|colspan="6"/.test(html), 'تذييل القيمة: سبعة أعمدة إلا واحداً');
  const plain = render(entry(false));
  assert.ok(!plain.includes('التشغيلة / الانتهاء'));
  assert.ok(/colSpan="5"|colspan="5"/.test(plain), 'بلا تشغيلات: كما كان');
});

test('invoiceDocFromDetail: تشغيلات البند من صفوف الخادم (withLots)، وغيابها لا يضيف حقلاً', () => {
  const inv = (lots: unknown) => ({
    number: 'INV-1', invoiceDate: '2026-10-23', type: 'CASH', customer: { name: 'ع' }, salesRep: { name: 'م' },
    items: [{ product: { name: 'ماء', unit: 'حبة' }, qty: 2, unitPrice: 1, discountPct: 0, taxPct: 15, lineTotal: 2, ...(lots !== undefined && { lots }) }],
    subtotal: 2, discountAmt: 0, taxAmt: 0.3, total: 2.3,
  });
  const withRows = invoiceDocFromDetail(inv([{ lotId: 'l1', quantity: 2, lot: { lotNumber: 'A', expiryDate: '2027-01-01T00:00:00.000Z' } }]), '', null);
  assert.deepEqual(withRows.items[0].lots, [{ lotNumber: 'A', qty: 2, expiryDate: '2027-01-01' }]);
  assert.equal('lots' in invoiceDocFromDetail(inv(undefined), '', null).items[0], false, 'الشكل كما كان للشركة المطفأة');
  assert.equal('lots' in invoiceDocFromDetail(inv([]), '', null).items[0], false);
});
