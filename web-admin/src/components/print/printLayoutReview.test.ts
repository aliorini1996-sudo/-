// مراجعة واجهة «التخطيط» (٣ نوفمبر ٢٠٢٦): ثلاثة خللٍ وُجدت في المراجعة، ولكلٍّ اختبارٌ يفشل قبل الإصلاح وينجح بعده.
// ١) ▲▼ بلوحة المفاتيح: React ينقل عقدة الصفّ المنقول لأسفل في DOM فيضيع تركيز زرّه، والزرّ الذي يُعطَّل عند الحدّ يُسقط التركيز —
//    فالتركيز يعود بعد النقل إلى زرّ الصفّ نفسه (moveFocusTarget + data-move).
// ٢) مخطّط «المقاس والهوامش» كان يكبّر الخط بـfontScale المحفوظ لصفحةٍ بلا تخطيط بينما الورقة تطبع 100% وزرّ الحجم يُظهر 100%.
// ٣) خانة «لون مخصص» كانت تُبقي لوناً فاتحاً مرفوضاً ورسالته بعد «العودة إلى تخطيط اليوم» (اللون المحفوظ صار لون الشركة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACCENT_PALETTE, defaultPrintOptions, moveSection, presetPaper, type PrintProfile } from '../../lib/print/printSettings';
import { LayoutFields, accentTextAfter, moveFocusTarget, schematicFontPx, sectionRows, withLayoutFontScale } from './PrintPreview';

const prof = (pid: string, printer: PrintProfile['printer'], template: PrintProfile['template'], preset: Parameters<typeof presetPaper>[0]): PrintProfile =>
  ({ id: pid, name: pid, printer, template, paper: presetPaper(preset)!, options: defaultPrintOptions(printer) });
const page = () => prof('office', 'page', 'page_branded', 'a4');
const mip = () => prof('mip480', 'impact', 'impact_plain', 'ff_a4');
const van = () => prof('van-80', 'thermal', 'roll_compact', 'roll80');

test('▲▼: بعد النقل يعود التركيز إلى الاتجاه نفسه إن بقي متاحاً، وإلا إلى الآخر — لا يسقط إلى الصفحة', () => {
  for (const p0 of [page(), mip(), van()]) {
    for (const [i, r] of sectionRows(p0).entries()) {
      for (const [dir, ok, to] of [['up', r.up, i - 1], ['down', r.down, i + 1]] as const) {
        if (!ok) continue;
        const p1 = moveSection(p0, r.id, to);
        const rows = sectionRows(p1);
        const target = moveFocusTarget(rows, r.id, dir);
        const row = rows.find((x) => x.id === r.id)!;
        // القسم الذي تحرّك يمكن دائماً إعادته — فللتركيز زرٌّ متاحٌ دائماً
        assert.ok(target !== null, `${p0.printer} ${r.id} ${dir}: لا زرّ للتركيز`);
        assert.ok(target === 'up' ? row.up : row.down, `${p0.printer} ${r.id} ${dir}: التركيز إلى زرٍّ معطّل`);
        if (dir === 'up' ? row.up : row.down) assert.equal(target, dir, 'الاتجاه نفسه أولاً فتتتابع الضغطات');
      }
    }
  }
  // «المعلومات» بعد الترويسة: رفع «الأصناف» إلى الموضع ١ يعطّل ▲ فيعود التركيز إلى ▼
  const p = moveSection(page(), 'items', 1);
  assert.equal(sectionRows(p)[1].id, 'items');
  assert.equal(moveFocusTarget(sectionRows(p), 'items', 'up'), 'down');
  assert.equal(moveFocusTarget(sectionRows(p), 'header', 'up'), null, 'الترويسة لا تتحرّك');
});

test('▲▼ مرسومةً بـdata-move، والنقرة تسجّل التركيز المطلوب قبل النقل والأثر يعيده', () => {
  const html = renderToStaticMarkup(createElement(LayoutFields, { p: withLayoutFontScale(page(), 1), update: () => undefined }));
  assert.match(html, /data-section="items"[^]*?data-move="up"[^]*?data-move="down"/);
  assert.equal((html.match(/data-move="up"/g) ?? []).length, sectionRows(page()).length);
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'PrintPreview.tsx'), 'utf8').replace(/\r\n/g, '\n');
  // «إزالة الضريبة» (E6): ▲▼ إلى upTo/downTo من layoutSectionRows (= i ∓ 1 للشركة بضريبتها) — تحديثٌ واعٍ للحارس
  assert.match(src, /refocus\.current = \{ id: r\.id, dir: 'up' \}; move\(r\.id, r\.upTo\)/);
  assert.match(src, /refocus\.current = \{ id: r\.id, dir: 'down' \}; move\(r\.id, r\.downTo\)/);
  assert.match(src, /moveFocusTarget\(layoutSectionRows\(p, taxOff\), want\.id, want\.dir\)/);
});

test('مخطّط «المقاس والهوامش»: الصفحة والنقطية بلا تخطيط بخطّ 100% مهما حُفظ fontScale — والرول وما له تخطيط بحجمه', () => {
  const big = (p: PrintProfile): PrintProfile => ({ ...p, options: { ...p.options, fontScale: 1.15 } });
  assert.equal(schematicFontPx(big(page())), 10.5, 'صفحة بلا تخطيط: الورقة تطبع 100%');
  assert.equal(schematicFontPx(big(mip())), 12, 'نقطية بلا تخطيط: الورقة تطبع 100%');
  assert.equal(schematicFontPx(withLayoutFontScale(page(), 1.15)), 10.5 * 1.15);
  assert.equal(schematicFontPx(withLayoutFontScale(mip(), 0.9)), 12 * 0.9);
  assert.equal(schematicFontPx(big(van())), 11 * 1.15, 'الرول يطبّق حجمه كاليوم');
  assert.equal(schematicFontPx(page()), 10.5);
});

test('«لون مخصص»: تغيّر اللون من خارج الخانة يزامنها — لا لون قديم ولا رسالة رفضٍ لما لم يعد محفوظاً، والمكتوب يبقى كما كُتب', () => {
  assert.equal(accentTextAfter(null, '#EEEEEE'), '', '«العودة إلى تخطيط اليوم» / «لون الشركة» تُفرغ الخانة');
  assert.equal(accentTextAfter(ACCENT_PALETTE[0], '#123456'), '', 'لونٌ من اللوحة يُفرغها');
  assert.equal(accentTextAfter(ACCENT_PALETTE[0].toLowerCase(), 'x'), '');
  assert.equal(accentTextAfter('#123456', '#123456'), '#123456');
  assert.equal(accentTextAfter('#ABCDEF', '#abcdef'), '#abcdef', 'ما كتبه المستخدم بحروفٍ صغيرة لا يُستبدل');
  assert.equal(accentTextAfter('#123456', ''), '#123456', 'لونٌ مخصّص من ملفٍّ آخر يظهر في الخانة');
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'PrintPreview.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(src.includes('useEffect(() => { setText((t) => accentTextAfter(value, t)); }, [value]);'));
});
