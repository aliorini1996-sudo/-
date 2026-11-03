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

test('roll constraints are enforced defensively: standard design, centre/none logo, lines table', () => {
  const r = resolveLayout(profile('thermal', fullLayout({ design: 'grid_bilingual', logo: 'end', tableStyle: 'striped', order: DEFAULT_SECTIONS.thermal })))!;
  assert.equal(r.design, 'standard');
  assert.equal(r.logo, 'center');
  assert.equal(r.tableStyle, 'lines');
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
