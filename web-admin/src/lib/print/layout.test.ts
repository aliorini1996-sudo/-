// محرّك «تخطيط المطبوعات» (lib/print/layout.ts — pl_spec v2 C(iii)) — طلب المالك ٣ نوفمبر ٢٠٢٦.
// يثبت: null ⇒ قيم اليوم حرفياً (أحجام شعار الترويسة تُقرأ من RepDocuments نفسه)، وتطبيع الترتيب، وfmtQty4، وlineVat نصف-لأعلى،
// ولون التمييز على mono، وcssText، ومطابقة نسخة الأقسام المحلية لـsectionsFor() في النواة متى صدّرتها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import {
  DEFAULT_SECTIONS, accentColor, cssText, fmtQty4, lineVat, logoBox, orderedSections, resolveLayout, rollSectionsHtml, scaleStyle, tableCss,
  ENGINE_CORE_COPIES, MM_PX, clampBox, fontPx, hasFreeLayout, logoMmBounds, logoPlan, mmToPx, physicalAlign, qrHost, qrOrphan, resolveCanvas,
  sectionCss, sectionCssText, sectionLook, snapMm, visibleOrder,
  type ResolvedLayout,
} from './layout';
import { defaultPrintOptions, legacyPrintSettings, newProfile, presetPaper, type PrintProfile } from './printSettings';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

type Printer = PrintProfile['printer'];
const profile = (printer: Printer, layout?: unknown, extra: Partial<PrintProfile['options']> = {}): PrintProfile => {
  const p = newProfile(printer, 'تجربة', []);
  // layout عمداً unknown: المحرّك يُختبر على قيم معطوبة أيضاً (مسودّة محرّر أو صفّ قديم)
  const options: Record<string, unknown> = { ...p.options, ...extra };
  if (layout !== undefined) options.layout = layout;
  return { ...p, options } as unknown as PrintProfile;
};
const fullLayout = (over: Record<string, unknown> = {}) => ({
  design: 'standard', logo: 'center', logoSize: 'l', accent: '#0F766E', tableStyle: 'grid',
  order: ['header', 'info', 'items', 'totals', 'note', 'installments', 'signatures', 'footer'], ...over,
});

// ─── مسار اليوم: null في كل حالة لا تخطيط فيها ───

test('resolveLayout: null for no profile, legacy profiles, roll_classic, and profiles without options.layout', () => {
  assert.equal(resolveLayout(null), null);
  assert.equal(resolveLayout(undefined), null);
  for (const p of legacyPrintSettings().profiles) {
    assert.equal(resolveLayout(p), null, p.id);
    // حتى لو حمل الملف الافتراضي تخطيطاً بالخطأ يبقى مجمّداً
    assert.equal(resolveLayout({ ...p, options: { ...p.options, layout: fullLayout() } as PrintProfile['options'] }), null, p.id);
  }
  const classic = { ...profile('thermal', fullLayout({ order: DEFAULT_SECTIONS.thermal })), template: 'roll_classic' } as PrintProfile;
  assert.equal(resolveLayout(classic), null);
  for (const printer of ['page', 'impact', 'thermal'] as Printer[]) {
    assert.equal(resolveLayout(profile(printer)), null, printer);
    assert.equal(resolveLayout(profile(printer, null)), null, printer);
    assert.equal(resolveLayout(profile(printer, 'grid')), null, printer);
  }
  // defaultPrintOptions لا تكتسب layout (غيابه = اليوم)
  for (const printer of ['page', 'impact', 'thermal'] as Printer[]) assert.ok(!('layout' in defaultPrintOptions(printer)));
});

test('null layout ⇒ today’s values in every helper', () => {
  assert.deepEqual(orderedSections(null, 'page'), DEFAULT_SECTIONS.page);
  assert.deepEqual(orderedSections(null, 'impact'), DEFAULT_SECTIONS.page);
  assert.deepEqual(orderedSections(null, 'page', 'grid_bilingual'), DEFAULT_SECTIONS.grid);
  assert.deepEqual(orderedSections(null, 'thermal'), DEFAULT_SECTIONS.thermal);
  assert.deepEqual(logoBox(null, 'classic', 'page'), { show: true, align: 'start', px: 42 });
  assert.deepEqual(logoBox(null, 'banner', 'page'), { show: true, align: 'start', px: 46 });
  assert.deepEqual(logoBox(null, 'minimal', 'page'), { show: true, align: 'start', px: 34 });
  assert.deepEqual(logoBox(null, 'classic', 'roll'), { show: true, align: 'center', px: 60 });
  assert.equal(accentColor(null, '#123456', false, '#1e3a8a'), '#123456');
  assert.equal(accentColor(null, null, false, '#1e3a8a'), '#1e3a8a');
  assert.equal(accentColor(null, undefined, false, '#1e3a8a'), '#1e3a8a');
  assert.equal(accentColor(null, '', false, '#1e3a8a'), '#1e3a8a', 'كـ brandColor(): primaryColor || BRAND');
  assert.deepEqual(tableCss(null, false), { table: {}, th: {}, td: {}, rowAlt: null });
  assert.deepEqual(tableCss(null, true), { table: {}, th: {}, td: {}, rowAlt: null });
  assert.equal(scaleStyle(null), undefined);
});

test('today’s logo sizes and roll logo width match the pinned baseline goldens (drift guard)', () => {
  // القوالب صارت تقرأ هذه القيم من logoBox(null) — فالمرجع هو خط الأساس المثبَّت قبل التخطيط (f037417) لا المصدر الحيّ
  const a4 = brotliDecompressSync(fs.readFileSync(path.join(root, 'src', 'rep', '__baseline__', 'a4.markup.json.br'))).toString('utf8');
  for (const style of ['classic', 'banner', 'minimal'] as const) {
    const px = logoBox(null, style, 'page').px;
    assert.ok(a4.includes(`width:${px}px;height:${px}px`), `${style}: ${px}px في خط الأساس`);
  }
  const roll = read('src', 'rep', '__baseline__', 'roll.samples.json');
  assert.ok(roll.includes(`.logo img { max-width: ${logoBox(null, 'classic', 'roll').px}%;`), 'roll logo max-width');
});

// ─── تخطيط محفوظ ───

test('resolveLayout: carries the saved layout, fontScale and printer', () => {
  const r = resolveLayout(profile('page', fullLayout(), { fontScale: 1.15 }))!;
  assert.deepEqual(r, {
    design: 'standard', logo: 'center', logoSize: 'l', accent: '#0F766E', tableStyle: 'grid', fontScale: 1.15,
    order: ['header', 'info', 'items', 'totals', 'note', 'installments', 'signatures', 'footer'], printer: 'page',
  } satisfies ResolvedLayout);
  assert.ok(Object.isFrozen(r.order));
  assert.deepEqual(orderedSections(r, 'page'), r.order);
  const g = resolveLayout(profile('impact', fullLayout({ design: 'grid_bilingual', tableStyle: 'lines', order: DEFAULT_SECTIONS.grid })))!;
  assert.equal(g.design, 'grid_bilingual');
  assert.equal(g.tableStyle, 'grid', 'grid_bilingual يفرض grid');
  assert.deepEqual(g.order, DEFAULT_SECTIONS.grid);
});

test('order normalisation: any non-permutation falls back to the default order', () => {
  const bad: unknown[] = [
    undefined, 'header', [],
    ['header', 'info', 'items', 'note', 'totals', 'installments', 'signatures'], // ناقص
    ['header', 'info', 'items', 'items', 'totals', 'installments', 'signatures', 'footer'], // مكرر
    ['header', 'info', 'items', 'note', 'totals', 'installments', 'signatures', 'bogus'], // مجهول
    ['header', 'info', 'items', 'note', 'totals', 'installments', 'signatures', 'qr'], // قسم رول على الصفحة
    ['header', 'info', 'parties', 'items', 'note', 'totals', 'installments', 'signatures', 'footer'], // قسم ثنائي اللغة على القياسي
  ];
  for (const order of bad) {
    assert.deepEqual(resolveLayout(profile('page', fullLayout({ order })))!.order, DEFAULT_SECTIONS.page, JSON.stringify(order));
  }
  // تبديل صحيح يُحترم كما هو
  const custom = ['header', 'items', 'info', 'totals', 'note', 'installments', 'signatures', 'footer'];
  assert.deepEqual(resolveLayout(profile('page', fullLayout({ order: custom })))!.order, custom);
  // التصميم ثنائي اللغة يقبل parties ولا يقبل ترتيب القياسي
  assert.deepEqual(resolveLayout(profile('page', fullLayout({ design: 'grid_bilingual', order: DEFAULT_SECTIONS.page })))!.order, DEFAULT_SECTIONS.grid);
});

test('roll: standard design enforced; logo start/center/end/none and every table style allowed since free editing (pd_spec B.1/B.3)', () => {
  const r = resolveLayout(profile('thermal', fullLayout({ design: 'grid_bilingual', logo: 'end', tableStyle: 'striped', order: DEFAULT_SECTIONS.thermal })))!;
  assert.equal(r.design, 'standard');
  assert.equal(r.logo, 'end');
  assert.equal(r.tableStyle, 'striped');
  assert.equal(resolveLayout(profile('thermal', fullLayout({ logo: 'start', tableStyle: 'grid', order: DEFAULT_SECTIONS.thermal })))!.logo, 'start');
  assert.equal(resolveLayout(profile('thermal', fullLayout({ logo: 'bogus', tableStyle: 'dots', order: DEFAULT_SECTIONS.thermal })))!.logo, 'center');
  assert.equal(resolveLayout(profile('thermal', fullLayout({ logo: 'bogus', tableStyle: 'dots', order: DEFAULT_SECTIONS.thermal })))!.tableStyle, 'lines');
  assert.deepEqual(r.order, DEFAULT_SECTIONS.thermal);
  assert.equal(resolveLayout(profile('thermal', fullLayout({ logo: 'none', order: DEFAULT_SECTIONS.thermal })))!.logo, 'none');
  const qrFirst = ['header', 'qr', 'info', 'customer', 'items', 'totals', 'signatures', 'footer'];
  assert.deepEqual(resolveLayout(profile('thermal', fullLayout({ order: qrFirst })))!.order, qrFirst, 'إعادة تثبيت القيود مهمة النواة');
});

test('resolveLayout: unknown enum values and bad accents fall back to defaults (never throws)', () => {
  const r = resolveLayout(profile('page', { design: 'x', logo: 'top', logoSize: 'xl', accent: 'red', tableStyle: 'dots', order: 7 }))!;
  assert.deepEqual(r, {
    design: 'standard', logo: 'start', logoSize: 'm', accent: null, tableStyle: 'lines', fontScale: 1,
    order: DEFAULT_SECTIONS.page, printer: 'page',
  });
  assert.equal(resolveLayout(profile('page', { design: 'grid_bilingual' }))!.logo, 'center');
});

test('local section defaults equal sectionsFor() in the core once it exports it', async (t) => {
  const core = await import('./printSettingsCore') as Record<string, unknown>;
  const sectionsFor = core.sectionsFor as ((p: string, d: string) => readonly string[]) | undefined;
  if (typeof sectionsFor !== 'function') { t.skip('printSettingsCore.sectionsFor غير منشور بعد (P1)'); return; }
  assert.deepEqual([...sectionsFor('page', 'standard')], [...DEFAULT_SECTIONS.page]);
  assert.deepEqual([...sectionsFor('impact', 'standard')], [...DEFAULT_SECTIONS.page]);
  assert.deepEqual([...sectionsFor('page', 'grid_bilingual')], [...DEFAULT_SECTIONS.grid]);
  assert.deepEqual([...sectionsFor('impact', 'grid_bilingual')], [...DEFAULT_SECTIONS.grid]);
  assert.deepEqual([...sectionsFor('thermal', 'standard')], [...DEFAULT_SECTIONS.thermal]);
  const ids = core.SECTION_IDS as readonly string[] | undefined;
  if (ids) for (const list of Object.values(DEFAULT_SECTIONS)) for (const id of list) assert.ok(ids.includes(id), id);
  const designs = core.LAYOUT_DESIGNS as readonly string[] | undefined;
  if (designs) assert.deepEqual([...designs], ['standard', 'grid_bilingual']);
  const defaultPrintLayout = core.defaultPrintLayout as ((p: string, d?: string) => unknown) | undefined;
  if (typeof defaultPrintLayout === 'function') {
    // الافتراضي من النواة يمرّ في المحرّك كما هو
    for (const [printer, design] of [['page', 'standard'], ['impact', 'grid_bilingual'], ['thermal', 'standard']] as const) {
      const lay = defaultPrintLayout(printer, design) as Record<string, unknown>;
      const r = resolveLayout(profile(printer, lay))!;
      for (const k of ['design', 'logo', 'logoSize', 'accent', 'tableStyle']) assert.equal(r[k as keyof ResolvedLayout], lay[k], `${printer}.${k}`);
      assert.deepEqual([...r.order], [...(lay.order as string[])]);
    }
  }
});

// ─── الشعار ───

test('logoBox: position and size per target', () => {
  const lay = (logo: string, logoSize: string, design = 'standard') => resolveLayout(profile('page', fullLayout({ logo, logoSize, design, order: design === 'standard' ? DEFAULT_SECTIONS.page : DEFAULT_SECTIONS.grid })))!;
  assert.deepEqual(logoBox(lay('start', 's'), 'banner', 'page'), { show: true, align: 'start', px: 34 });
  assert.deepEqual(logoBox(lay('center', 'm'), 'classic', 'page'), { show: true, align: 'center', px: 42 });
  assert.deepEqual(logoBox(lay('end', 'l'), 'minimal', 'page'), { show: true, align: 'end', px: 56 });
  assert.deepEqual(logoBox(lay('center', 's', 'grid_bilingual'), 'classic', 'grid'), { show: true, align: 'center', px: 48 });
  assert.deepEqual(logoBox(lay('center', 'm', 'grid_bilingual'), 'classic', 'grid'), { show: true, align: 'center', px: 64 });
  assert.deepEqual(logoBox(lay('start', 'l', 'grid_bilingual'), 'classic', 'grid'), { show: true, align: 'start', px: 84 });
  assert.equal(logoBox(lay('none', 'm'), 'classic', 'page').show, false);
  const roll = (logoSize: string, logo = 'center') => resolveLayout(profile('thermal', fullLayout({ logo, logoSize, order: DEFAULT_SECTIONS.thermal })))!;
  assert.deepEqual(logoBox(roll('s'), 'classic', 'roll'), { show: true, align: 'center', px: 36 });
  assert.deepEqual(logoBox(roll('m'), 'classic', 'roll'), { show: true, align: 'center', px: 48 });
  assert.deepEqual(logoBox(roll('l'), 'classic', 'roll'), { show: true, align: 'center', px: 60 });
  assert.equal(logoBox(roll('m', 'none'), 'classic', 'roll').show, false);
});

// ─── اللون والجدول والتكبير ───

test('accentColor: mono ⇒ #000 always; chosen accent overrides the company colour', () => {
  const r = resolveLayout(profile('page', fullLayout()))!;
  assert.equal(accentColor(r, '#123456', false, '#1e3a8a'), '#0F766E');
  assert.equal(accentColor(r, '#123456', true, '#1e3a8a'), '#000');
  assert.equal(accentColor(null, '#123456', true, '#1e3a8a'), '#000');
  const noAccent = resolveLayout(profile('page', fullLayout({ accent: null })))!;
  assert.equal(accentColor(noAccent, '#123456', false, '#1e3a8a'), '#123456');
  assert.equal(accentColor(noAccent, null, false, '#1e3a8a'), '#1e3a8a');
});

test('tableCss: lines = today; grid/striped styles; mono uses only #000 and no fills', () => {
  const t = (tableStyle: string, design = 'standard') =>
    resolveLayout(profile('page', fullLayout({ tableStyle, design, order: design === 'standard' ? DEFAULT_SECTIONS.page : DEFAULT_SECTIONS.grid })))!;
  assert.deepEqual(tableCss(t('lines'), false), { table: {}, th: {}, td: {}, rowAlt: null });
  const grid = tableCss(t('grid'), false);
  assert.equal(grid.table.borderCollapse, 'collapse');
  assert.ok(String(grid.td.border).startsWith('1px solid'));
  assert.equal(grid.rowAlt, null);
  assert.equal(tableCss(t('grid', 'grid_bilingual'), false).td.border, '1px solid #000', 'الإطارات الكلاسيكية سوداء');
  assert.ok(tableCss(t('striped'), false).rowAlt);
  for (const style of ['grid', 'striped']) {
    const css = tableCss(t(style), true);
    assert.equal(css.rowAlt, null, `${style}: لا تعبئة رمادية على mono`);
    const all = JSON.stringify([css.table, css.th, css.td]);
    assert.ok(!/background/i.test(all), style);
    for (const m of all.match(/#[0-9a-fA-F]{3,8}/g) ?? []) assert.equal(m, '#000', `${style}: ${m}`);
  }
});

test('scaleStyle: zoom only when the layout exists and fontScale ≠ 1', () => {
  assert.equal(scaleStyle(resolveLayout(profile('page', fullLayout(), { fontScale: 1 }))), undefined);
  assert.deepEqual(scaleStyle(resolveLayout(profile('page', fullLayout(), { fontScale: 1.15 }))), { zoom: 1.15 });
  assert.deepEqual(scaleStyle(resolveLayout(profile('impact', fullLayout(), { fontScale: 0.9 }))), { zoom: 0.9 });
  // بلا تخطيط يبقى fontScale خارج A4/النقطية كاليوم
  assert.equal(scaleStyle(resolveLayout(profile('page', undefined, { fontScale: 1.15 }))), undefined);
});

// ─── الأرقام ───

test('fmtQty4: ≤4 decimals, trailing zeros trimmed, Latin digits, half-up', () => {
  const cases: Array<[number, string]> = [
    [10, '10'], [10.0, '10'], [1.5, '1.5'], [12.34, '12.34'], [1.23456, '1.2346'], [1.23455, '1.2346'],
    [0.00005, '0.0001'], [0.00004, '0'], [1e-7, '0'], [-0, '0'], [-2.5, '-2.5'], [1234567.125, '1234567.125'],
    [0.1 + 0.2, '0.3'], [NaN, '0'], [Infinity, '0'],
  ];
  for (const [q, s] of cases) assert.equal(fmtQty4(q), s, String(q));
  assert.ok(!/[٠-٩]/.test(fmtQty4(123.4567)));
});

test('lineVat: stored taxAmt wins; otherwise derived half-up to 2dp (inclusive and exclusive)', () => {
  assert.equal(lineVat({ taxAmt: 7.77, lineTotal: 100, taxPct: 15 }, false), 7.77);
  assert.equal(lineVat({ taxAmt: 0, lineTotal: 100, taxPct: 15 }, false), 0);
  assert.equal(lineVat({ taxAmt: null, lineTotal: 100, taxPct: 15 }, false), 15);
  assert.equal(lineVat({ lineTotal: 115, taxPct: 15 }, true), 15);
  assert.equal(lineVat({ lineTotal: 100, taxPct: 0 }, false), 0);
  // 10.05×10% = 1.005 ⇒ 1.01 (Math.round العاري يعطي 1.00)
  assert.equal(lineVat({ lineTotal: 10.05, taxPct: 10 }, false), 1.01);
  // 0.1×15% = 0.015 ⇒ 0.02
  assert.equal(lineVat({ lineTotal: 0.1, taxPct: 15 }, false), 0.02);
  // شامل: 11.5 − 11.5/1.15 = 1.5
  assert.equal(lineVat({ lineTotal: 11.5, taxPct: 15 }, true), 1.5);
  assert.equal(lineVat({ lineTotal: 1, taxPct: 15 }, true), 0.13);
});

// ─── الرول النصّي ───

test('rollSectionsHtml joins sections in order and skips empty/missing ones', () => {
  const parts = { header: '<h>', info: '<i>', items: '', totals: '<t>', qr: '<q>', footer: '<f>' };
  assert.equal(rollSectionsHtml(DEFAULT_SECTIONS.thermal, parts), '<h><i><t><q><f>');
  assert.equal(rollSectionsHtml(['header', 'qr', 'info', 'footer'], parts), '<h><q><i><f>');
  assert.equal(rollSectionsHtml([], parts), '');
});

test('cssText: kebab-case, px for numbers except unitless props, skips empty values', () => {
  assert.equal(
    cssText({ fontSize: 12, lineHeight: 1.4, zoom: 1.15, borderTop: '1px solid #000', fontWeight: 700, opacity: 0.8, marginTop: 0, WebkitPrintColorAdjust: 'exact', color: '' }),
    'font-size:12px;line-height:1.4;zoom:1.15;border-top:1px solid #000;font-weight:700;opacity:0.8;margin-top:0px;-webkit-print-color-adjust:exact',
  );
  assert.equal(cssText({}), '');
  assert.equal(cssText(tableCss(null, true).td), '');
});

// ─── حرّاس المصدر ───

test('layout.ts is framework-free, imports the core as types only, and has no letterSpacing', () => {
  const src = read('src', 'lib', 'print', 'layout.ts');
  assert.ok(!/from 'react'|from "react"|document\.|window\./.test(src));
  assert.ok(!/letterSpacing|letter-spacing/.test(src.replace(/\/\/.*$/gm, '')));
  for (const m of src.matchAll(/^import (.+) from '([^']+)';$/gm)) {
    if (m[2] === './printSettingsCore') assert.match(m[1], /^type /, 'النواة type-only');
    else assert.equal(m[2], '../money');
  }
  // paper presets untouched by the engine (sanity: the helper we use in tests still exists)
  assert.ok(presetPaper('a4'));
});

// ─── التحرير الحرّ (pd_spec C.(ii)) ───

const page = (over: Record<string, unknown> = {}, printer: Printer = 'page') =>
  resolveLayout(profile(printer, fullLayout({ order: printer === 'thermal' ? DEFAULT_SECTIONS.thermal : DEFAULT_SECTIONS.page, ...over })))!;

test('free keys: absent ⇒ resolveLayout keeps exactly the 8 keys and every free helper returns null/{} (6-key layouts untouched)', () => {
  const six = page();
  assert.deepEqual(Object.keys(six).sort(), ['accent', 'design', 'fontScale', 'logo', 'logoSize', 'order', 'printer', 'tableStyle']);
  for (const l of [null, six]) {
    assert.equal(hasFreeLayout(l), false);
    assert.equal(logoPlan(l, 'classic', 'page'), null);
    assert.equal(logoPlan(l, 'classic', 'roll', 72), null);
    assert.equal(sectionLook(l, 'info'), null);
    assert.equal(qrOrphan(l, 'page', 'standard'), false);
    assert.equal(resolveCanvas(l, { printer: 'page', qrMinMm: 47, kind: 'invoice' }), null);
    assert.equal(fontPx(13, sectionLook(l, 'items')), 13);
  }
  assert.deepEqual(visibleOrder(six, 'page'), six.order);
  assert.deepEqual(visibleOrder(null, 'thermal'), DEFAULT_SECTIONS.thermal);
});

test('free keys: valid values are carried; invalid ones drop individually (never the layout)', () => {
  const r = page({
    logoMm: 22.5, logoAfter: 'info',
    sections: { info: { visible: false, align: 'end', fontPct: 120, spaceBeforeMm: 3, spaceAfterMm: 1.5 }, items: { visible: false, fontPct: 90 }, qr: { align: 'center' } },
    canvas: { headerMm: 40, footerMm: 0, boxes: [{ id: 'logo', band: 'header', x: 0, y: 0, w: 20, h: 20 }] },
  });
  assert.equal(r.logoMm, 22.5);
  assert.equal(r.logoAfter, 'info');
  assert.deepEqual(r.sections, { info: { visible: false, align: 'end', fontPct: 120, spaceBeforeMm: 3, spaceAfterMm: 1.5 }, items: { fontPct: 90 } }, 'items لا يُخفى، وqr ليس من أقسام الصفحة');
  assert.equal(r.canvas!.boxes.length, 1);
  assert.equal(hasFreeLayout(r), true);
  const bad = page({ logoMm: 5.9, logoAfter: 'parties', sections: { info: { fontPct: 161, spaceBeforeMm: -1, align: 'left' } }, canvas: { headerMm: 151, footerMm: 0, boxes: [] } });
  for (const k of ['logoMm', 'logoAfter', 'sections', 'canvas'] as const) assert.equal(bad[k], undefined, k);
  assert.equal(bad.tableStyle, 'grid', 'the 6-key layout survives');
  for (const v of [NaN, Infinity, '30', null]) assert.equal(page({ logoMm: v }).logoMm, undefined, String(v));
  assert.equal(page({ logoMm: 6 }).logoMm, 6);
  assert.equal(page({ logoMm: 120 }).logoMm, 120);
  // canvas only on page/impact standard
  const cv = { headerMm: 40, footerMm: 10, boxes: [] };
  assert.equal(page({ canvas: cv }, 'thermal').canvas, undefined);
  assert.equal(resolveLayout(profile('page', fullLayout({ design: 'grid_bilingual', order: DEFAULT_SECTIONS.grid, canvas: cv })))!.canvas, undefined);
  assert.ok(page({ canvas: cv }, 'impact').canvas);
  // logoAfter must belong to the design: parties only on grid, qr only on roll
  assert.equal(page({ logoAfter: 'qr' }).logoAfter, undefined);
  assert.equal(page({ logoAfter: 'qr' }, 'thermal').logoAfter, 'qr');
  assert.equal(page({ logoAfter: 'top' }, 'thermal').logoAfter, 'top');
  // the roll qr section is locked visible
  assert.equal(page({ sections: { qr: { visible: false } } }, 'thermal').sections, undefined);
});

test('MM_PX/mmToPx: 96 px per inch on the 794 px template', () => {
  assert.equal(MM_PX, 96 / 25.4);
  assert.equal(mmToPx(25.4), 96);
  assert.equal(mmToPx(10), 37.8);
  assert.equal(mmToPx(0), 0);
});

test('logoMmBounds and logoPlan: continuous size wins over s/m/l, clamped per target; placement and alignment', () => {
  assert.deepEqual(logoMmBounds('page'), [6, 120]);
  assert.deepEqual(logoMmBounds('grid'), [6, 120]);
  assert.deepEqual(logoMmBounds('roll', 48), [6, 48]);
  assert.deepEqual(logoMmBounds('roll', 104), [6, 80]);
  assert.deepEqual(logoMmBounds('roll'), [6, 80]);
  const p = logoPlan(page({ logo: 'end', logoMm: 30 }), 'classic', 'page')!;
  assert.deepEqual(p, { show: true, align: 'end', maxWmm: 30, maxHmm: 30, maxPx: mmToPx(30), at: 'header' });
  const roll = logoPlan(page({ logo: 'start', logoMm: 100 }, 'thermal'), 'classic', 'roll', 48)!;
  assert.equal(roll.maxWmm, 48, 'roll: ≤ printable width');
  assert.equal(roll.align, 'start');
  // logoAfter alone: today's s/m/l size, standalone placement
  const top = logoPlan(page({ logoSize: 'l', logoAfter: 'top' }), 'classic', 'page')!;
  assert.equal(top.at, 'top');
  assert.equal(top.maxWmm, Math.round((56 / MM_PX) * 100) / 100);
  const rollTop = logoPlan(page({ logoSize: 'm', logoAfter: 'footer' }, 'thermal'), 'classic', 'roll', 72)!;
  assert.equal(rollTop.at, 'footer');
  assert.equal(rollTop.maxWmm, 34.56, '48% of 72 mm (today m)');
  assert.equal(rollTop.maxHmm, 12.8, '16 mm × 48/60');
  const none = logoPlan(page({ logo: 'none', logoMm: 20 }), 'classic', 'page')!;
  assert.equal(none.show, false);
});

test('sectionLook/sectionCss/sectionCssText/fontPx: physical RTL alignment, px/mm spacing, never zoom or fontSize', () => {
  const l = page({ sections: { info: { align: 'start', fontPct: 130, spaceBeforeMm: 2, spaceAfterMm: 0.5 }, totals: { align: 'end' } } });
  const info = sectionLook(l, 'info')!;
  assert.deepEqual(info, { visible: true, align: 'start', fontPct: 130, spaceBeforeMm: 2, spaceAfterMm: 0.5 });
  assert.deepEqual(sectionCss(info), { textAlign: 'right', marginTop: mmToPx(2), marginBottom: mmToPx(0.5) });
  assert.equal(sectionCssText(info), 'text-align:right;margin-top:2mm;margin-bottom:0.5mm');
  assert.deepEqual(sectionCss(sectionLook(l, 'totals')!), { textAlign: 'left' });
  // a section without style under a free layout: a wrapper with no style
  const items = sectionLook(l, 'items')!;
  assert.deepEqual(items, { visible: true, align: null, fontPct: 100, spaceBeforeMm: 0, spaceAfterMm: 0 });
  assert.deepEqual(sectionCss(items), {});
  assert.equal(sectionCssText(items), '');
  assert.equal(physicalAlign('center'), 'center');
  assert.equal(fontPx(13, info), 16.9, '13 × 130%');
  assert.equal(fontPx(13, items), 13);
  assert.equal(fontPx(13, null), 13);
  for (const css of [sectionCss(info), sectionCss(sectionLook(l, 'totals')!)]) {
    assert.ok(!('zoom' in css) && !('fontSize' in css) && !('filter' in css));
  }
  assert.ok(!/zoom|font-size|filter/.test(sectionCssText(info)));
});

test('visibleOrder hides sections but never items or the roll QR; qrHost/qrOrphan', () => {
  const l = page({ sections: { info: { visible: false }, note: { visible: false } } });
  assert.deepEqual(visibleOrder(l, 'page'), ['header', 'items', 'totals', 'installments', 'signatures', 'footer']);
  const roll = page({ sections: { customer: { visible: false } } }, 'thermal');
  assert.deepEqual(visibleOrder(roll, 'thermal'), ['header', 'info', 'items', 'totals', 'signatures', 'qr', 'footer']);
  assert.equal(qrHost('page', 'standard'), 'totals');
  assert.equal(qrHost('impact', 'grid_bilingual'), 'info');
  assert.equal(qrHost('thermal', 'standard'), 'qr');
  assert.equal(qrOrphan(page({ sections: { totals: { visible: false } } }), 'page', 'standard'), true);
  assert.equal(qrOrphan(page({ sections: { info: { visible: false } } }), 'page', 'standard'), false);
  const grid = resolveLayout(profile('page', fullLayout({ design: 'grid_bilingual', order: DEFAULT_SECTIONS.grid, sections: { info: { visible: false } } })))!;
  assert.equal(qrOrphan(grid, 'page', 'grid_bilingual'), true);
  assert.equal(qrOrphan(roll, 'thermal', 'standard'), false);
  // a canvas qr box prints the QR, so no orphan block
  const placed = page({ sections: { totals: { visible: false } }, canvas: { headerMm: 0, footerMm: 60, boxes: [{ id: 'qr', band: 'footer', x: 0, y: 0, w: 50, h: 50 }] } });
  assert.equal(qrOrphan(placed, 'page', 'standard'), false);
});

test('snapMm and clampBox: 0.5 grid, inside band and content, min size, non-finite safe', () => {
  assert.equal(snapMm(10.26), 10.5);
  assert.equal(snapMm(10.24), 10);
  assert.equal(snapMm(-0.1), 0);
  assert.ok(!Object.is(snapMm(-0.1), -0));
  assert.equal(snapMm(7, 2), 8);
  assert.equal(snapMm(NaN), 0);
  const b = { id: 'company' as const, band: 'header' as const, x: 180, y: 35, w: 30, h: 20 };
  assert.deepEqual(clampBox(b, 40, 188, 5), { ...b, x: 158, y: 20, w: 30, h: 20 });
  assert.deepEqual(clampBox({ ...b, w: 2, h: 1, x: -3, y: -1 }, 40, 188, 5), { ...b, x: 0, y: 0, w: 5, h: 5 });
  assert.deepEqual(clampBox({ ...b, w: 500, h: 500 }, 40, 188, 5), { ...b, x: 0, y: 0, w: 188, h: 40 });
  assert.deepEqual(clampBox({ ...b, x: NaN, y: Infinity, w: NaN, h: NaN }, 40, 188, 5), { ...b, x: 0, y: 0, w: 5, h: 5 });
  const c = clampBox({ ...b, x: 100.3, y: 3.7, w: 40.2, h: 10.1 }, 40, 201.6, 5);
  for (const v of [c.x, c.y, c.w, c.h]) assert.equal(v * 2, Math.round(v * 2), 'on the 0.5 grid');
  assert.ok(c.x + c.w <= 201.6 && c.y + c.h <= 40);
});

test('resolveCanvas: bands, px, placed/hostOf, qr grown to qrMinMm with its band, receipt drops qr, invalid boxes flow', () => {
  const l = page({
    canvas: {
      headerMm: 40, footerMm: 30,
      boxes: [
        { id: 'logo', band: 'header', x: 160, y: 0, w: 28, h: 20, align: 'center' },
        { id: 'company', band: 'header', x: 100, y: 0, w: 60, h: 30, fontPct: 120 },
        { id: 'totals', band: 'header', x: 0, y: 0, w: 60, h: 30 },
        { id: 'qr', band: 'footer', x: 0, y: 0, w: 47, h: 47 },
        { id: 'signatures', band: 'footer', x: 60, y: 5, w: 80, h: 20 },
      ],
    },
  });
  const rc = resolveCanvas(l, { printer: 'page', qrMinMm: 50, kind: 'invoice' })!;
  assert.equal(rc.contentWmm, 188);
  assert.equal(rc.header!.hMm, 40);
  assert.equal(rc.header!.hPx, mmToPx(40));
  assert.deepEqual(rc.header!.boxes.map((b) => b.id), ['logo', 'company']);
  assert.deepEqual(rc.header!.boxes[0].px, { left: mmToPx(160), top: 0, width: mmToPx(28), height: mmToPx(20) });
  assert.equal(rc.header!.boxes[0].align, 'center');
  assert.equal(rc.header!.boxes[1].align, 'start');
  assert.equal(rc.header!.boxes[1].fontPct, 120);
  assert.equal(rc.header!.boxes[0].fontPct, 100);
  const qr = rc.footer!.boxes.find((b) => b.id === 'qr')!;
  assert.ok(qr.w >= 50 && qr.h >= 50, 'grown to qrMinMm');
  assert.ok(rc.footer!.hMm >= qr.y + qr.h, 'band grown to fit the qr');
  assert.deepEqual([...rc.placed].sort(), ['company', 'logo', 'qr', 'signatures'], 'totals in the header is footer-only ⇒ flows');
  assert.equal(rc.hostOf.qr, 'totals');
  assert.equal(rc.hostOf.docInfo, 'info');
  assert.equal(rc.hostOf.company, 'header');
  // receipts: no QR box
  const rr = resolveCanvas(l, { printer: 'page', qrMinMm: 47, kind: 'receipt' })!;
  assert.ok(!rr.placed.has('qr'));
  // impact content width
  assert.equal(resolveCanvas(page({ canvas: { headerMm: 20, footerMm: 0, boxes: [] } }, 'impact'), { printer: 'impact', qrMinMm: 47, kind: 'invoice' })!.contentWmm, 201);
  // zero bands ⇒ null; box in a zero band flows
  assert.equal(resolveCanvas(page({ canvas: { headerMm: 0, footerMm: 0, boxes: [{ id: 'logo', band: 'header', x: 0, y: 0, w: 10, h: 10 }] } }), { printer: 'page', qrMinMm: 47, kind: 'invoice' }), null);
  const half = resolveCanvas(page({ canvas: { headerMm: 20, footerMm: 0, boxes: [{ id: 'qr', band: 'footer', x: 0, y: 0, w: 50, h: 50 }] } }), { printer: 'page', qrMinMm: 47, kind: 'invoice' })!;
  assert.equal(half.footer, null);
  assert.ok(!half.placed.has('qr'), 'qr omitted from the bands ⇒ auto-placed in the flow');
  // a QR smaller than legible (corrupt draft) is grown, never shrunk
  const tiny = resolveCanvas(page({ canvas: { headerMm: 30, footerMm: 0, boxes: [{ id: 'qr', band: 'header', x: 150, y: 10, w: 10, h: 10 }] } }), { printer: 'page', qrMinMm: 46.57, kind: 'invoice' })!;
  const tq = tiny.header!.boxes[0];
  assert.ok(tq.w >= 47 && tq.h >= 47 && tq.x + tq.w <= 188 && tq.y + tq.h <= tiny.header!.hMm);
  // never on roll or grid
  assert.equal(resolveCanvas(page({}, 'thermal'), { printer: 'page', qrMinMm: 47, kind: 'invoice' }), null);
});

test('engine copies of the core free-editing constants equal printSettingsCore', async () => {
  const core = await import('./printSettingsCore') as Record<string, unknown>;
  for (const [k, v] of Object.entries(ENGINE_CORE_COPIES)) assert.deepEqual(JSON.parse(JSON.stringify(core[k])), JSON.parse(JSON.stringify(v)), k);
});
