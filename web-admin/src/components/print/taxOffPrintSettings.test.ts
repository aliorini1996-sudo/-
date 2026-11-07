// «إزالة الضريبة» (CONTRACT2 — E6 وE3، ٧ نوفمبر ٢٠٢٦): بقايا رمز الهيئة في «إعدادات الطباعة» لشركةٍ بلا ضريبة — شارة «بلا رمز QR»،
// وصفّ «رمز QR» في «ترتيب الأقسام»، ومربع الرمز في المصغّرات — تختفي لها، والشركة بضريبتها كما هي حرفاً. والنقل في «ترتيب الأقسام»
// بلا صفّ الرمز يتخطّاه بموضعه الحقيقي (فلا ضغطة ▲▼ بلا أثرٍ ظاهر). ومحرّر النصوص: افتراضيّ «إجمالي المرتجع» وترجمته على الورقة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  canMoveSection, defaultPrintOptions, layoutOf, moveSection, normalizeSectionOrder, presetPaper, withLayout, type PrintProfile, type SectionId,
} from '../../lib/print/printSettings';
import { printTextEntry } from '../../lib/print/printTextsCore';
import { GridThumb, LayoutFields, layoutSectionRows, moveFocusTarget, sectionRows } from './PrintPreview';
import { TaxOffPrintContext, printTextDefault } from './taxOffPrint';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const prof = (pid: string, printer: PrintProfile['printer'], template: PrintProfile['template'], preset: Parameters<typeof presetPaper>[0]): PrintProfile =>
  ({ id: pid, name: pid, printer, template, paper: presetPaper(preset)!, options: defaultPrintOptions(printer) });
const page = () => prof('office', 'page', 'page_branded', 'a4');
const van = () => prof('van-80', 'thermal', 'roll_compact', 'roll80');
const order = (p: PrintProfile): SectionId[] => { const l = layoutOf(p); return normalizeSectionOrder(l.order, p.printer, l.design); };
const shown = (p: PrintProfile): SectionId[] => order(p).filter((s) => s !== 'qr');
/** ترتيبٌ يضع الرمز بين قسمين متحرّكين — ليُختبر التخطّي في المنتصف لا في الطرف وحده */
const qrInMiddle = (p: PrintProfile): PrintProfile => {
  const o = order(p);
  const without = o.filter((s) => s !== 'qr');
  const at = without.indexOf('items');
  const next = [...without.slice(0, at + 1), 'qr' as SectionId, ...without.slice(at + 1)];
  const q = withLayout(p, { order: next });
  return order(q).join() === next.join() ? q : p;
};
// الصفحة بلا قسم رمز في ترتيبها (لوحتها مربع QR في المصمّم) — صفوفها كاليوم في الحالين؛ والرول برمزه، وبرمزه بين الأصناف والإجماليات
const PROFILES = (): PrintProfile[] => [page(), van(), qrInMiddle(van())];

test('E6: layoutSectionRows للشركة بضريبتها = sectionRows حرفاً (at=i، و▲▼ إلى i∓1) — اليوم بلا تغيير', () => {
  for (const p of PROFILES()) {
    const rows = sectionRows(p);
    assert.deepEqual(layoutSectionRows(p, false), rows.map((r, i) => ({ ...r, at: i, upTo: i - 1, downTo: i + 1 })), p.id);
    if (p.printer === 'thermal') assert.ok(rows.some((r) => r.id === 'qr'), `${p.id}: صفّ الرمز للشركة بضريبتها`);
    else assert.deepEqual(layoutSectionRows(p, true), layoutSectionRows(p, false), `${p.id}: بلا قسم رمز — كما هو`);
  }
});

test('E6: بلا ضريبة لا صفّ «رمز QR» — و▲▼ يبدّلان الصفّين الظاهرين المتجاورين حقاً (يتخطّيان الرمز المخفي) والرمز باقٍ في الترتيب', () => {
  for (const p of PROFILES()) {
    const rows = layoutSectionRows(p, true);
    assert.deepEqual(rows.map((r) => r.id), shown(p), p.id);
    assert.ok(rows.every((r) => order(p)[r.at] === r.id), `${p.id}: at = الموضع الحقيقي`);
    for (const [v, r] of rows.entries()) {
      for (const dir of ['up', 'down'] as const) {
        const ok = dir === 'up' ? r.up : r.down;
        const to = dir === 'up' ? r.upTo : r.downTo;
        if (!ok) continue;
        const q = moveSection(p, r.id, to);
        assert.notEqual(q, p, `${p.id}/${r.id}/${dir}: تحرّك`);
        const want = shown(p).slice();
        const w = dir === 'up' ? v - 1 : v + 1;
        [want[v], want[w]] = [want[w], want[v]];
        assert.deepEqual(shown(q), want, `${p.id}/${r.id}/${dir}: تبادل الظاهرَين`);
        assert.equal(order(q).includes('qr'), order(p).includes('qr'), `${p.id}: الرمز باقٍ في الترتيب المحفوظ`);
        // التركيز بعد النقل يُحسب على صفوف العرض نفسها: الصفّ المنقول ظاهرٌ فيها بزرٍّ متاح أو بلا زرّ (null)
        assert.ok(['up', 'down', null].includes(moveFocusTarget(layoutSectionRows(q, true), r.id, dir)));
      }
    }
    // الطرفان: لا ▲ للأول ولا ▼ للأخير — وما يتاح لأحد الظاهرين يتاح بقواعد canMoveSection نفسها
    assert.equal(rows[0].up, false, `${p.id}: الأول`);
    assert.equal(rows[rows.length - 1].down, false, `${p.id}: الأخير`);
    for (const r of rows) {
      if (r.up) assert.ok(canMoveSection(p, r.id, r.upTo));
      if (r.down) assert.ok(canMoveSection(p, r.id, r.downTo));
    }
  }
  // حالة التخطّي في المنتصف موجودة فعلاً (الرمز بين صفّين ظاهرين)
  const mid = qrInMiddle(van());
  const o = order(mid);
  const qi = o.indexOf('qr');
  assert.ok(qi > 0 && qi < o.length - 1, 'الرمز في المنتصف');
  const below = layoutSectionRows(mid, true).find((r) => r.at === qi + 1)!;
  assert.equal(below.upTo, qi - 1, '▲ يتخطّى الرمز');
});

test('E6: «ترتيب الأقسام» المرسوم — بلا صفّ الرمز ولا «رمز QR» لشركةٍ بلا ضريبة، وبه كاليوم بلا السياق', () => {
  for (const p of [van(), qrInMiddle(van())]) {
    const today = renderToStaticMarkup(createElement(LayoutFields, { p, update: () => undefined }));
    assert.ok(today.includes('<li data-section="qr"'), `${p.id}: صفّ الرمز اليوم`);
    const off = renderToStaticMarkup(createElement(TaxOffPrintContext.Provider, { value: true }, createElement(LayoutFields, { p, update: () => undefined })));
    assert.ok(!off.includes('data-section="qr"') && !off.includes('رمز QR') && !/\bQR\b/.test(off), `${p.id}: بلا ضريبة`);
    assert.equal((off.match(/<li data-section=/g) ?? []).length, shown(p).length, `${p.id}: بقية الصفوف`);
    // الترقيم متتابعٌ بلا فجوة الرمز
    const nums = [...off.matchAll(/<span class="text-\[11px\] text-\[#9A8F7E\] w-4" dir="ltr">(\d+)<\/span>/g)].map((m) => Number(m[1]));
    assert.deepEqual(nums, shown(p).map((_, i) => i + 1), `${p.id}: الترقيم`);
    const ctxFalse = renderToStaticMarkup(createElement(TaxOffPrintContext.Provider, { value: false }, createElement(LayoutFields, { p, update: () => undefined })));
    assert.equal(ctxFalse, today, `${p.id}: السياق false = اليوم حرفاً`);
  }
  // الصفحة (بلا قسم رمز): بلا ضريبة كما هي حرفاً
  const pg = page();
  const pageToday = renderToStaticMarkup(createElement(LayoutFields, { p: pg, update: () => undefined }));
  assert.equal(renderToStaticMarkup(createElement(TaxOffPrintContext.Provider, { value: true }, createElement(LayoutFields, { p: pg, update: () => undefined }))), pageToday);
});

test('E6: المصغّرات بلا مربع الرمز لشركةٍ بلا ضريبة — وبه كاليوم', () => {
  const today = renderToStaticMarkup(createElement(GridThumb));
  assert.ok(today.includes('repeating-conic-gradient'));
  assert.equal(renderToStaticMarkup(createElement(GridThumb, { taxOff: false })), today);
  assert.ok(!renderToStaticMarkup(createElement(GridThumb, { taxOff: true })).includes('repeating-conic-gradient'));
  // اللوحة لا تُحمَّل في node (تستورد عميل الـAPI): حارسٌ مصدريّ لمصغّرة القالب وللشارة
  const s = read('src', 'components', 'print', 'PrintSettingsPanel.tsx');
  const thumb = s.slice(s.indexOf('function TemplateThumb('), s.indexOf('function TemplateThumb(') + 2000);
  assert.ok(thumb.startsWith('function TemplateThumb({ t, taxOff = false }: { t: TemplateId; taxOff?: boolean })'));
  assert.ok(thumb.includes("{!taxOff && <span className=\"block mx-auto mt-1.5\" style={{ width: 14, height: 14, background: 'repeating-conic-gradient("));
  assert.equal(thumb.split('repeating-conic-gradient').length - 1, 1, 'مربعٌ واحد خلف الشرط');
  assert.ok(s.includes('{t ? <TemplateThumb t={t} taxOff={taxOff} /> : <GridThumb taxOff={taxOff} />}'));
  assert.ok(s.includes('{isQrRemoved(layoutOf(p)) && !taxOff && <span data-qr-removed=""'), 'الشارة خلف taxOff');
  assert.equal(s.split('data-qr-removed=""').length - 1, 1, 'شارةٌ واحدة');
  // taxOff في نطاق القائمة: من isTaxOff(company) في رأس اللوحة
  assert.ok(s.indexOf('const taxOff = isTaxOff(company);') < s.indexOf('data-qr-removed=""'));
});

test('E3 في محرّر النصوص: افتراضيّ سطر إجمالي المرتجع «إجمالي المرتجع» بلا ضريبة وترجمته على الورقة — وبضريبتها كما هو', () => {
  const e = printTextEntry('tot.returnGrand')!;
  assert.equal(printTextDefault(e, false), 'إجمالي المرتجع دائن');
  assert.equal(printTextDefault(e, true), 'إجمالي المرتجع');
  assert.equal(printTextDefault(printTextEntry('tot.grand')!, true), printTextEntry('tot.grand')!.ar);
  const ed = read('src', 'components', 'print', 'PrintTextsEditor.tsx');
  assert.ok(ed.includes('const altFallback = lang ? (edit.text !== null ? phraseIn(edit.text.trim(), lang) : taxFreeDefaultIn(entry.key, defaultText, lang) ?? phraseIn(defaultText, lang)) : null;'));
});
