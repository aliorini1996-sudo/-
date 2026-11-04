// «حذف السطر» في محرّر نصوص المطبوعات (طلب المالك ٣ نوفمبر ٢٠٢٦): لا عبارة مقفلة — كل عبارةٍ تُعاد صياغتها وتُحذف بسطرها كاملاً،
// والسطور المحذوفة تُستعاد، وما كان إلزامياً للفاتورة الضريبية يحمل تنبيهاً لا يمنع وتأكيداً واحداً عند حذفه.
//
// ١) منطق المحرّر الخالص (PrintTextsCard: withTextEdit/deleteConfirmClass/deleteConfirmText/deletedLines) على كل مفتاح في القائمة،
//    والمسودة الناتجة يقبلها فحص الخادم الصارم نفسه (checkPrintTexts — النسخة الحرفية).
// ٢) المعاينة بالقوالب الحقيقية: السطر المحذوف مشطوبٌ قابلٌ للنقر (لا غائب) في التصميمين، والتصميم ثنائي اللغة يُظهر الإنجليزية.
// ٣) حارس مصدري على المحرّر: زرّ «حذف السطر» بجانب كل عبارة، بلا قفل ولا خانة معطّلة، والتنبيه والتأكيد من القائمة نفسها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PRINT_TEXT_CATALOG, PRINT_TEXT_LINE, PRINT_TEXT_WARNINGS, canonicalPrintTexts, checkPrintTexts, emptyPrintTexts, printTextWarning,
  type PrintTextsV1,
} from '../../lib/print/printTexts';
import { newProfile, withDesign } from '../../lib/print/printSettings';
import { PrintableInvoice, PrintableReceipt, type InvoiceDoc, type ReceiptDoc } from '../../rep/RepDocuments';
import { DEFAULT_PRINT_LOOK, PrintLookContext, lookFor, type PrintLook } from '../../rep/printLook';
import { PrintTextsPreviewContext } from '../../rep/printTextsContext';
import { deleteConfirmClass, deleteConfirmText, deletedLines, lineWarning, withTextEdit } from './PrintTextsCard';

const root = process.cwd();
const editor = () => fs.readFileSync(path.join(root, 'src', 'components', 'print', 'PrintTextsEditor.tsx'), 'utf8').replace(/\r\n/g, '\n');
const KEYS = PRINT_TEXT_CATALOG.map((e) => e.key);
const same = (s: string) => s;

test('كل مفتاح في القائمة: «حذف السطر» يقبله الفحص الصارم ويحفظه، و«استعادة» تعيد المسودة فارغة', () => {
  assert.ok(KEYS.length >= 90, `القائمة ${KEYS.length}`);
  for (const key of KEYS) {
    const del = withTextEdit(emptyPrintTexts(), key, { hidden: true });
    assert.deepEqual(del.edits[key], { text: null, alt: null, hidden: true }, key);
    const r = checkPrintTexts(del, true);
    assert.ok(r.ok, `${key}: الحذف مرفوض — ${r.ok ? '' : JSON.stringify(r.issues)}`);
    assert.equal(canonicalPrintTexts(r.value).edits[key]?.hidden, true, `${key}: الحذف لا يُحفظ`);
    const back = withTextEdit(del, key, { hidden: false });
    assert.deepEqual(back.edits, {}, `${key}: الاستعادة لا تعيد المسودة فارغة`);
  }
});

test('كل مفتاح في القائمة: الصياغة العربية والترجمة مقبولتان، والحذف يحفظ الصياغة لتعود بالاستعادة', () => {
  for (const key of KEYS) {
    let d: PrintTextsV1 = { ...emptyPrintTexts(), secondLang: 'en' };
    d = withTextEdit(d, key, { text: 'صياغة بديلة' });
    d = withTextEdit(d, key, { alt: 'Custom' });
    const r = checkPrintTexts(d, true);
    assert.ok(r.ok, `${key}: الصياغة مرفوضة — ${r.ok ? '' : JSON.stringify(r.issues)}`);
    const del = withTextEdit(d, key, { hidden: true });
    assert.ok(checkPrintTexts(del, true).ok, `${key}: صياغة + حذف مرفوضة`);
    assert.deepEqual(withTextEdit(del, key, { hidden: false }).edits[key], { text: 'صياغة بديلة', alt: 'Custom', hidden: false });
    assert.deepEqual(r.ok && r.value.edits[key], { text: 'صياغة بديلة', alt: 'Custom', hidden: false }, `${key}: الصورة القانونية بحقولها الثلاثة`);
    // «إعادة النص الافتراضي» (null) يمحو التعديل كله
    assert.deepEqual(withTextEdit(del, key, null).edits, {});
  }
});

test('التأكيد: مرّةً واحدة لما كان إلزامياً للفاتورة الضريبية (tax/standard) ولعناوين الحالة (status) — لا لسطر المنصة ولا للحرّ', () => {
  for (const entry of PRINT_TEXT_CATALOG) {
    // عنوان صندوقٍ (block) يرث أشدّ تنبيهٍ في صفوفه التي تسقط معه (lineWarning) — وغيره تنبيه عبارته
    const w = lineWarning(entry.key);
    if (PRINT_TEXT_LINE[entry.key] !== 'block') assert.equal(w, printTextWarning(entry), entry.key);
    const want = w === 'tax' || w === 'standard' || w === 'status' ? w : null;
    assert.equal(deleteConfirmClass(entry.key), want, entry.key);
    const text = deleteConfirmText(entry.key, same);
    if (want) {
      assert.ok(text?.includes(entry.ar), `${entry.key}: السؤال بلا اسم السطر`);
      assert.ok(text?.includes(PRINT_TEXT_WARNINGS[want]), `${entry.key}: السؤال بلا التنبيه`);
    } else {
      assert.equal(text, null, entry.key);
    }
  }
  // عيّنات صريحة من صورة المالك: «الكمية» و«السعر شامل الضريبة» كانا مقفلين ⇒ تنبيه وتأكيد، لا منع
  assert.equal(deleteConfirmClass('col.qty'), 'tax');
  assert.equal(deleteConfirmClass('col.priceIncl'), 'tax');
  // قرار المالك ٤ نوفمبر ٢٠٢٦: عناوين الحالة تُحذف بتنبيهها وتأكيدٍ واحد يذكر أنّ المستند قد يبدو فاتورةً سارية
  for (const k of ['inv.deliveryNoteTitle', 'inv.voidTitle', 'inv.pendingTitle']) {
    assert.equal(deleteConfirmClass(k), 'status', k);
    assert.ok(deleteConfirmText(k, same)?.includes('يبدو كفاتورة سارية'), k);
  }
  assert.equal(deleteConfirmClass('inv.title'), 'tax');
  assert.equal(deleteConfirmClass('cust.name'), 'standard');
  assert.equal(deleteConfirmClass('foot.platform'), null);
  assert.equal(deleteConfirmClass('h.phone'), null);
  assert.equal(deleteConfirmClass('no.such.key'), null);
  // الإلزامي سابقاً كله يحمل تنبيهاً: كل مفتاحٍ قفله غير none أو كان «يُخفى فقط»
  for (const entry of PRINT_TEXT_CATALOG.filter((e) => (e.lock !== 'none' || e.hideOnly) && e.key !== 'foot.platform')) {
    assert.notEqual(deleteConfirmClass(entry.key), null, `${entry.key}: كان إلزامياً ولا يُسأل عن حذفه`);
  }
});

test('السطور المحذوفة: بترتيب القائمة، ولكل تبويب نصوصه والمشتركة', () => {
  let d = emptyPrintTexts();
  for (const k of ['rcp.notes', 'col.qty', 'foot.platform', 'h.taxNumber', 'tot.due']) d = withTextEdit(d, k, { hidden: true });
  d = withTextEdit(d, 'inv.number', { text: 'رقم' }); // صياغة بلا حذف — ليست في القائمة
  const order = (keys: string[]) => KEYS.filter((k) => keys.includes(k));
  assert.deepEqual(deletedLines(d).map((e) => e.key), order(['rcp.notes', 'col.qty', 'foot.platform', 'h.taxNumber', 'tot.due']));
  assert.deepEqual(deletedLines(d, 'invoice').map((e) => e.key), order(['col.qty', 'foot.platform', 'h.taxNumber', 'tot.due']));
  assert.deepEqual(deletedLines(d, 'receipt').map((e) => e.key), order(['rcp.notes', 'foot.platform', 'h.taxNumber']));
  assert.deepEqual(deletedLines(null), []);
  assert.deepEqual(deletedLines(emptyPrintTexts(), 'invoice'), []);
});

// ── المعاينة بالقوالب الحقيقية ──
const company = (texts: PrintTextsV1 | null) => ({
  name: 'شركة المعاينة', taxNumber: '300000000000003', commercialReg: '1010000000', address: 'الرياض حي العليا', phone: '0110000000',
  email: 'info@example.com', countryCode: 'SA', addrCity: 'الرياض', addrPostalCode: '12211', printTexts: texts,
});
const invoice = (texts: PrintTextsV1 | null): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-1024', date: '2026-11-03T10:30:00', type: 'CREDIT', company: company(texts),
  customer: { name: 'عميل تجريبي', businessName: 'مؤسسة تجريبية', commercialReg: '4030000000', phone: '0500000000', address: 'جدة - حي الروضة', city: 'جدة', postalCode: '23435', taxNumber: '310000000000003' },
  repName: 'مندوب تجريبي', pricesIncludeTax: true, deliveryDate: '2026-11-04T10:30:00',
  items: [
    { name: 'صنف تجريبي 1', code: 'P-101', unit: 'حبة', qty: 2, unitPrice: 28.75, discountPct: 0, taxPct: 15, lineTotal: 57.5, taxAmt: 7.5 },
    { name: 'صنف تجريبي 2', code: 'P-102', unit: 'حبة', qty: 1, unitPrice: 57.5, discountPct: 10, taxPct: 15, lineTotal: 51.75, taxAmt: 6.75 },
  ],
  subtotal: 95, discount: 5, tax: 14.25, total: 109.25, paidAmt: 50, remainingAmt: 59.25,
});
const receipt = (texts: PrintTextsV1 | null): ReceiptDoc => ({
  kind: 'receipt', number: 'RCP-0207', date: '2026-11-03T11:00:00', company: company(texts),
  customer: { name: 'عميل تجريبي', businessName: 'مؤسسة تجريبية', phone: '0500000000', address: 'جدة - حي الروضة', taxNumber: '310000000000003' },
  repName: 'مندوب تجريبي', amount: 300, paymentMethod: 'CASH', notes: 'ملاحظة',
  invoices: [{ number: 'INV-1024', amount: 143.75 }, { number: 'INV-1019', amount: 106.25 }],
});
const GRID_LOOK: PrintLook = lookFor(withDesign(newProfile('page', 'preview', []), 'grid_bilingual'));
const render = (el: ReactElement, look: PrintLook, preview: boolean): string => {
  const inner = createElement(PrintLookContext.Provider, { value: look }, el);
  return renderToStaticMarkup(preview ? createElement(PrintTextsPreviewContext.Provider, { value: { onPick: () => {}, active: null } }, inner) : inner);
};
/** مفاتيح المعاينة القابلة للنقر في الورقة */
const pickKeys = (html: string): Set<string> => new Set([...html.matchAll(/data-pt-key="([^"]+)"/g)].map((m) => m[1]));
const esc = (key: string) => key.replace(/\./g, '\\.');
/** وسوم المفتاح في المعاينة — كلٌّ بأسلوبه */
const pickTags = (html: string, key: string): string[] => [...html.matchAll(new RegExp(`<[^>]*data-pt-key="${esc(key)}"[^>]*>`, 'g'))].map((m) => m[0]);
/** مشطوبٌ في المعاينة: وسم المفتاح نفسه (التصميم الحالي) أو وحدته كلها (data-line في التصميم ثنائي اللغة) */
const struck = (html: string, key: string): boolean =>
  pickTags(html, key).some((t) => /line-through/.test(t))
  || [...html.matchAll(new RegExp(`<[^>]*data-line="(?:[^"]* )?${esc(key)}(?: [^"]*)?"[^>]*>`, 'g'))].some((m) => /line-through/.test(m[0]));

test('المعاينة: التصميم ثنائي اللغة مُتاحٌ من ملفٍّ جديد (القالب الحقيقي) ويُظهر التسميات الإنجليزية', () => {
  assert.equal(GRID_LOOK.layout?.design, 'grid_bilingual', 'المظهر بلا التصميم ثنائي اللغة');
  assert.equal(DEFAULT_PRINT_LOOK.layout, undefined);
  const g = render(createElement(PrintableInvoice, { doc: invoice(null) }), GRID_LOOK, true);
  const s = render(createElement(PrintableInvoice, { doc: invoice(null) }), DEFAULT_PRINT_LOOK, true);
  assert.match(g, /data-print-layout="grid_bilingual"/);
  assert.doesNotMatch(s, /data-print-layout=/);
  for (const en of [/Invoice n(?:o|umber)/i, /Item Code/i, /VAT N(?:o|umber)/i, /Total Amount Due/i]) assert.match(g, en);
  assert.doesNotMatch(s, /Item Code|Total Amount Due/i);
  // ما لا يطبعه إلا التصميم ثنائي اللغة قابلٌ للنقر فيه
  const keys = pickKeys(g);
  for (const k of ['sel.name', 'col.code', 'col.vatAmount', 'sig.warehouse', 'sig.remarks', 'tot.due']) assert.ok(keys.has(k), `${k} ليس في معاينة التصميم ثنائي اللغة`);
});

for (const [name, look] of [['التصميم الحالي', DEFAULT_PRINT_LOOK], ['ثنائي اللغة', GRID_LOOK]] as const) {
  for (const [docName, make] of [['الفاتورة', (t: PrintTextsV1 | null) => createElement(PrintableInvoice, { doc: invoice(t) })], ['السند', (t: PrintTextsV1 | null) => createElement(PrintableReceipt, { doc: receipt(t) })]] as const) {
    test(`المعاينة (${name} — ${docName}): كل سطرٍ ظاهرٍ إذا حُذف يبقى مشطوباً قابلاً للنقر — لا يغيب فيتعذّر اختياره واستعادته`, () => {
      const base = render(make(null), look, true);
      const keys = [...pickKeys(base)];
      assert.ok(keys.length >= 10, `مفاتيح قليلة في المعاينة: ${keys.length}`);
      for (const key of keys) {
        const html = render(make(withTextEdit(emptyPrintTexts(), key, { hidden: true })), look, true);
        const tags = pickTags(html, key);
        assert.ok(tags.length > 0, `${key}: المحذوف غاب من المعاينة`);
        assert.ok(struck(html, key), `${key}: المحذوف غير مشطوب في المعاينة`);
        // غير المحذوف لا يُشطب بسببه
        assert.ok(!struck(base, key), `${key}: مشطوبٌ بلا حذف`);
      }
    });
  }
}

test('الطباعة الحقيقية (بلا معاينة): السطر المحذوف يغيب، وبلا نصوص لا أثر لأي مفتاح', () => {
  const plain = render(createElement(PrintableInvoice, { doc: invoice(null) }), DEFAULT_PRINT_LOOK, false);
  assert.doesNotMatch(plain, /data-pt-key=/);
  assert.doesNotMatch(plain, /line-through/);
  const del = render(createElement(PrintableInvoice, { doc: invoice(withTextEdit(emptyPrintTexts(), 'inv.rep', { hidden: true })) }), DEFAULT_PRINT_LOOK, false);
  assert.ok(plain.includes('مندوب تجريبي'));
  assert.ok(!del.includes('مندوب تجريبي'), 'صفّ المندوب (التسمية وقيمتها) باقٍ بعد حذفه');
  assert.doesNotMatch(del, /data-pt-key=|line-through/);
});

test('حارس المحرّر: «حذف السطر» بجانب كل عبارة، بلا قفل ولا خانة معطّلة، والتنبيه والتأكيد من القائمة', () => {
  const e = editor();
  // لا منطق قفل
  for (const gone of ['LOCK_REASONS', 'STANDARD_HINT', 'PHASE2_TITLE_NOTE', 'printTextHideable', 'printTextRewordable', 'printTextAltEditable', '<Lock ', 'hideOnly', 'disabled={!rewordable}', 'disabled={!altEditable}', "tr('سطر صدرت عبر منصة Field Sales ثابت في التذييل')"]) {
    assert.ok(!e.includes(gone), `بقايا القفل: ${gone}`);
  }
  // صفّ كل عبارة: الزرّ نفسه وتنبيهه
  const row = e.slice(e.indexOf('function TextRow('));
  assert.ok(row.length > 0);
  assert.match(row, /<LineButton deleted=\{deleted\} scope=\{scope\} onDelete=\{onDelete\} onRestore=\{onRestore\} \/>/);
  assert.match(row, /const warning = lineWarning\(entry\.key\);/);
  assert.match(row, /\{tr\(PRINT_TEXT_WARNINGS\[warning\]\)\}/);
  assert.doesNotMatch(row, /disabled=/, 'خانةٌ أو زرٌّ معطّل في صفّ العبارة');
  const btn = e.slice(e.indexOf('function LineButton('), e.indexOf('function TextRow('));
  assert.ok(btn.includes("{tr('حذف السطر')}") && btn.includes("{tr('استعادة')}"));
  assert.match(btn, /<button type="button" data-line-delete=""/);
  // كل صفٍّ في القائمة يمرّر الحذف والاستعادة
  assert.match(e, /onDelete=\{\(\) => deleteLine\(entry\.key\)\} onRestore=\{\(\) => restoreLine\(entry\.key\)\}/);
  // التأكيد مرّةً واحدة عند الحذف (لا عند الاستعادة) — من deleteConfirmText (PRINT_TEXT_WARNINGS)
  assert.match(e, /const ask = deleteConfirmText\(key, tr\);\n\s*if \(ask !== null && !window\.confirm\(ask\)\) return;\n\s*setEdit\(key, \{ hidden: true \}\);/);
  assert.match(e, /const restoreLine = useCallback\(\(key: string\) => setEdit\(key, \{ hidden: false \}\), \[setEdit\]\);/);
  // قائمة السطور المحذوفة باستعادة لكلٍّ منها، والسطر المختار في المعاينة يُحذف أو يُستعاد من شريطه
  assert.ok(e.includes("{tr('السطور المحذوفة')}") && e.includes("{tr('لا توجد سطور محذوفة')}"));
  assert.match(e, /data-restore-line=\{entry\.key\} onClick=\{\(\) => restoreLine\(entry\.key\)\}/);
  assert.match(e, /<div data-pt-actions=\{activeEntry\.key\}[\s\S]{0,600}<LineButton deleted=\{activeDeleted\}/);
  // «استعادة النصوص الافتراضية» كما هي
  assert.match(e, /const resetAll = \(\) => \{[\s\S]*?save\.mutate\(null\);/);
  // معاينة التصميم ثنائي اللغة بالقالب الحقيقي
  assert.ok(e.includes("return lookFor(withDesign(newProfile('page', 'preview', []), 'grid_bilingual'));"));
  // كل وحدة حذفٍ في القائمة لها تلميح
  const hints = e.slice(e.indexOf('const LINE_SCOPE_HINTS'), e.indexOf('});', e.indexOf('const LINE_SCOPE_HINTS')));
  for (const scope of new Set(Object.values(PRINT_TEXT_LINE))) assert.match(hints, new RegExp(`\\b${scope}: '`), `وحدة بلا تلميح: ${scope}`);
});

test('عنوان الفاتورة/الإشعار في المحرّر كأي عبارة (قرار المالك ٣ نوفمبر ٢٠٢٦ «طبّقها تلقائياً»): لا وسم مرحلة ولا تنبيه «القواعد السابقة» ولا زرّ «تطبيقه على المرحلتين»', () => {
  const saved: PrintTextsV1 = { ...emptyPrintTexts(), edits: { 'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false } } };
  // تعديل مفتاحٍ آخر لا يمسّ العنوان المحفوظ، ولمسُ العنوان يكتب الحقول الثلاثة وحدها
  const other = withTextEdit(saved, 'h.phone', { text: 'الهاتف' });
  assert.deepEqual(other.edits['inv.title'], { text: 'فاتورة مبيعات', alt: null, hidden: false });
  assert.deepEqual(withTextEdit(saved, 'inv.title', {}).edits['inv.title'], { text: 'فاتورة مبيعات', alt: null, hidden: false });
  assert.deepEqual(withTextEdit(saved, 'inv.returnTitle', { hidden: true }).edits['inv.returnTitle'], { text: null, alt: null, hidden: true });
  const r = checkPrintTexts(other, true);
  assert.equal(JSON.stringify(r.ok && r.value.edits['inv.title']), '{"text":"فاتورة مبيعات","alt":null,"hidden":false}');
  const e = editor();
  const card = fs.readFileSync(path.join(root, 'src', 'components', 'print', 'PrintTextsCard.tsx'), 'utf8');
  for (const gone of ['titleEditPhase1Only', 'data-pt-phase1-only', 'printTextEditOnPhase2', 'phase2', 'تطبيقه على المرحلتين', 'هذا التعديل محفوظ بالقواعد السابقة']) {
    assert.ok(!e.includes(gone), `المحرّر: ${gone}`);
    assert.ok(!card.includes(gone), `البطاقة: ${gone}`);
  }
  // تحذير العنوان (الرقم الضريبي) باقٍ كما هو
  assert.ok(e.includes('{tr(TITLE_WARNING)}'));
});
