// قرار المالك ٤ نوفمبر ٢٠٢٦ («اجعل يمكن حذف كل شي حتى كيو ار»): في المصمّم الحرّ يبقى تنبيه حذف جدول الأصناف أحمرَ ظاهراً
// أيّاً كان العنصر المحدَّد (لا داخل أدوات القسم وحدها) — وبلا حذفٍ لا تنبيه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ITEMS_REMOVE_WARNING, newProfile, type PrintProfile } from '../../../lib/print/printSettings';
import { withSectionStyle } from '../../../lib/print/designModel';
import PrintDesigner from './PrintDesigner';

const render = (p: PrintProfile): string => renderToStaticMarkup(createElement(PrintDesigner, {
  profile: p, phase2: true, company: null, companyName: 'شركة', brandColor: '#E15A30', onApply: () => {}, onClose: () => {},
}));

test('المصمّم: جدول الأصناف المحذوف صراحةً له تنبيهٌ أحمر دائم على الصفحة والنقطية والرول — وبلا حذف لا تنبيه', () => {
  for (const printer of ['page', 'impact', 'thermal'] as const) {
    const p = newProfile(printer, 'x', []);
    const live = render(p);
    assert.doesNotMatch(live, /data-items-removed-note/, `${printer}: تنبيهٌ بلا حذف`);
    assert.ok(!live.includes(ITEMS_REMOVE_WARNING), `${printer}: نصّ التنبيه بلا حذف`);
    const hidden = withSectionStyle(p, 'items', { visible: false });
    const out = render(hidden);
    assert.match(out, /role="note" data-items-removed-note=""/, `${printer}: لا تنبيه أحمر للأصناف المحذوفة`);
    assert.ok(out.includes(ITEMS_REMOVE_WARNING), `${printer}: نصّ التنبيه غائب`);
  }
});
