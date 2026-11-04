// نموذج «التحرير الحرّ» (lib/print/designModel.ts — pd_spec C.(ii)) — طلب المالك ٣ نوفمبر ٢٠٢٦.
// يثبت: تعديلٌ بلا أثر يعيد القالب نفسه ولا يُنشئ layout، ومحو آخر مفتاح حرّ يترك المفاتيح الستة، والقصّ إلى حدود النواة،
// وأن كل ناتجٍ من المساعدات (ومنها عيّنات عشوائية) يمرّ بقواعد الحفظ الصارمة في النواة بلا خطأ، ورمز QR لا يصغر عن 47 مم،
// ونسخة الكلاسيكي القابلة للتحرير بإعادة التوجيه دون مساس الكلاسيكي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  editableClassicCopy, freeIssues, logoMmOf, logoMmRange, nudgeBox, removeBox, resetCanvas, resetLogo, resetSection, resetSections,
  starterCanvas, upsertBox, withCanvas, withLogo, withSectionStyle,
} from './designModel';
import {
  LAYOUT_BOUNDS, PRINT_ISSUES, defaultPrintLayout, legacyPrintSettings, newProfile, presetPaper, printSettingsIssues, profileIssues,
  withDesign, withLayout, type CanvasBox, type PrintCanvas, type PrintLayout, type PrintProfile, type PrinterType, type SectionId,
} from './printSettings';

const mk = (printer: PrinterType, over: Partial<PrintProfile> = {}): PrintProfile => ({ ...newProfile(printer, 'تجربة', []), ...over });
const lay = (p: PrintProfile): PrintLayout | undefined => p.options.layout;
const ok = (p: PrintProfile, why = ''): void => assert.deepEqual(profileIssues(p, 'p'), [], `${why} ${JSON.stringify(lay(p))}`);
const six = (p: PrintProfile): string[] => Object.keys(lay(p) ?? {}).sort();
const SIX = ['accent', 'design', 'logo', 'logoSize', 'order', 'tableStyle'];

test('no-op edits return the same profile and never create a layout', () => {
  for (const printer of ['page', 'impact', 'thermal'] as PrinterType[]) {
    const p = mk(printer);
    assert.equal(lay(p), undefined);
    assert.equal(withSectionStyle(p, 'info', null), p, printer);
    assert.equal(withSectionStyle(p, 'info', { visible: true, fontPct: 100, spaceBeforeMm: 0 }), p, printer);
    assert.equal(withSectionStyle(p, 'items', { visible: false }), p, 'items cannot be hidden');
    assert.equal(withLogo(p, { logo: defaultPrintLayout(printer).logo }), p, printer);
    assert.equal(withLogo(p, { logoMm: null, logoAfter: null }), p, printer);
    assert.equal(withCanvas(p, null), p);
    assert.equal(resetLogo(p), p);
    assert.equal(resetSections(p), p);
    assert.equal(resetCanvas(p), p);
    assert.equal(resetSection(p, 'info'), p);
    assert.equal(removeBox(p, 'logo'), p);
    assert.equal(nudgeBox(p, 'logo', 1, 1), p);
  }
  // an unknown section for the design
  const pg = mk('page');
  assert.equal(withSectionStyle(pg, 'qr', { align: 'end' }), pg);
  assert.equal(withSectionStyle(pg, 'parties', { align: 'end' }), pg);
  // legacy and classic profiles never get a layout
  for (const p of legacyPrintSettings().profiles) {
    assert.equal(withSectionStyle(p, 'info', { align: 'end' }), p);
    assert.equal(withLogo(p, { logoMm: 30 }), p);
  }
  const classic = mk('thermal', { template: 'roll_classic' });
  assert.equal(withLogo(classic, { logoMm: 30 }), classic);
});

test('withSectionStyle: merges, clamps to core bounds, drops defaults; clearing the last free key leaves the plain 6-key layout', () => {
  const p0 = mk('page');
  const p1 = withSectionStyle(p0, 'info', { align: 'end', fontPct: 200, spaceBeforeMm: 2.26, spaceAfterMm: 31 });
  assert.deepEqual(lay(p1)!.sections, { info: { align: 'end', fontPct: 160, spaceBeforeMm: 2.5, spaceAfterMm: 30 } });
  ok(p1);
  const p2 = withSectionStyle(p1, 'info', { fontPct: 40, spaceAfterMm: undefined, visible: false });
  assert.deepEqual(lay(p2)!.sections, { info: { visible: false, align: 'end', fontPct: 70, spaceBeforeMm: 2.5 } });
  const p3 = withSectionStyle(p2, 'note', { spaceBeforeMm: -4 });
  assert.equal(p3, p2, 'negative spacing clamps to 0 = default ⇒ no-op');
  const cleared = withSectionStyle(p2, 'info', null);
  assert.deepEqual(six(cleared), SIX, 'plain 6-key layout');
  assert.equal(lay(cleared)!.sections, undefined);
  assert.ok(!('sections' in lay(cleared)!), 'no undefined key left behind');
  assert.equal(resetSections(p2).options.layout!.sections, undefined);
  assert.deepEqual(six(resetSections(p2)), SIX);
  // roll: the qr section is locked visible, other roll sections hide
  const r = withSectionStyle(mk('thermal'), 'customer', { visible: false, align: 'center' });
  assert.deepEqual(lay(r)!.sections, { customer: { visible: false, align: 'center' } });
  assert.equal(lay(withSectionStyle(mk('thermal'), 'qr', { visible: false, align: 'end' }))!.sections!.qr!.visible, undefined);
  ok(r);
  // non-finite input is ignored
  assert.equal(withSectionStyle(p0, 'info', { fontPct: NaN, spaceBeforeMm: Infinity }), p0);
});

test('withLogo: continuous size clamped and snapped per target; placement validated; resetLogo restores the default', () => {
  const p = mk('page');
  assert.equal(lay(withLogo(p, { logoMm: 200 }))!.logoMm, 120);
  assert.equal(lay(withLogo(p, { logoMm: 3 }))!.logoMm, 6);
  assert.equal(lay(withLogo(p, { logoMm: 22.3 }))!.logoMm, 22.5);
  const roll58 = mk('thermal', { paper: presetPaper('roll58')! });
  const [lo, hi] = logoMmRange(roll58);
  assert.equal(lo, 6);
  assert.ok(hi <= 48 && hi >= 47, `58 mm roll prints ~48 mm (got ${hi})`);
  const big = lay(withLogo(roll58, { logoMm: 100 }))!.logoMm!;
  assert.ok(big <= hi && big * 2 === Math.round(big * 2), 'clamped to the band and on the 0.5 grid');
  ok(withLogo(roll58, { logoMm: 100, logo: 'end', logoAfter: 'top' }));
  assert.equal(lay(withLogo(p, { logoAfter: 'parties' })), undefined, 'parties is not a page-standard section ⇒ no-op');
  assert.equal(lay(withLogo(p, { logoAfter: 'footer' }))!.logoAfter, 'footer');
  assert.equal(lay(withLogo(mk('thermal'), { logoAfter: 'qr' }))!.logoAfter, 'qr');
  const all = withLogo(p, { logo: 'center', logoMm: 30, logoAfter: 'top' });
  ok(all);
  assert.deepEqual(lay(withLogo(all, { logoMm: null }))!.logoMm, undefined);
  const reset = resetLogo(all);
  assert.deepEqual(six(reset), SIX);
  assert.equal(lay(reset)!.logo, 'start', 'page default');
  assert.equal(lay(resetLogo(withLogo(mk('thermal'), { logo: 'end', logoMm: 20 })))!.logo, 'center', 'roll default');
  // the slider value: saved size or today’s s/m/l in mm
  assert.equal(logoMmOf(all), 30);
  assert.equal(logoMmOf(p), Math.round((42 / (96 / 25.4)) * 2) / 2, 'page m = 42 px');
});

test('withCanvas: page/impact standard only; sanitised to the strict core rules (footer-only, qr ≥ 47, inside bands, no dup)', () => {
  const t = mk('thermal');
  assert.equal(withCanvas(t, { headerMm: 40, footerMm: 0, boxes: [] }), t);
  const g = withDesign(mk('page'), 'grid_bilingual');
  assert.equal(withCanvas(g, { headerMm: 40, footerMm: 0, boxes: [] }), g);
  const messy: PrintCanvas = {
    headerMm: 160, footerMm: 90,
    boxes: [
      { id: 'totals', band: 'header', x: 10, y: 10, w: 60, h: 30 },
      { id: 'qr', band: 'header', x: 170, y: 5, w: 20, h: 20 },
      { id: 'logo', band: 'header', x: -5, y: 140, w: 300, h: 2 },
      { id: 'logo', band: 'footer', x: 0, y: 0, w: 10, h: 10 },
      { id: 'company', band: 'header', x: 10.26, y: 0.24, w: 50.1, h: 20.4, fontPct: 999, align: 'center' },
      { id: 'footer', band: 'footer', x: 0, y: NaN, w: 10, h: 10 },
    ],
  };
  for (const printer of ['page', 'impact'] as PrinterType[]) {
    const p = withCanvas(mk(printer), messy);
    ok(p, printer);
    const c = lay(p)!.canvas!;
    assert.equal(c.headerMm, 150);
    assert.equal(c.footerMm, 50, 'sum ≤ 200');
    assert.deepEqual(c.boxes.map((b) => `${b.band}:${b.id}`), ['header:logo', 'header:company', 'header:qr', 'footer:totals'], 'canonical order, first id wins, NaN dropped');
    const qr = c.boxes.find((b) => b.id === 'qr')!;
    assert.ok(qr.w >= 47 && qr.h >= 47);
    assert.equal(c.boxes.find((b) => b.id === 'company')!.fontPct, 160);
    assert.equal(c.boxes.find((b) => b.id === 'company')!.x, 10.5);
  }
  const p = withCanvas(mk('page'), messy);
  assert.equal(withCanvas(p, lay(p)!.canvas!), p, 'idempotent');
  assert.deepEqual(six(withCanvas(p, null)), SIX);
  assert.deepEqual(six(resetCanvas(p)), SIX);
});

test('upsertBox/removeBox/nudgeBox: snap, grow the band to the box height, keep inside; qr never below 47 mm; remove returns it to the flow', () => {
  const p0 = mk('page');
  const p1 = upsertBox(p0, { id: 'logo', band: 'header', x: 150.2, y: 0, w: 30.3, h: 20 });
  const c1 = lay(p1)!.canvas!;
  assert.equal(c1.headerMm, 20, 'band grown from 0 to the box height');
  assert.deepEqual(c1.boxes, [{ id: 'logo', band: 'header', x: 150, y: 0, w: 30.5, h: 20 }]);
  ok(p1);
  const p2 = upsertBox(p1, { id: 'signatures', band: 'header', x: 0, y: 0, w: 80, h: 25 });
  assert.equal(lay(p2)!.canvas!.boxes.find((b) => b.id === 'signatures')!.band, 'footer', 'footer-only');
  assert.equal(lay(p2)!.canvas!.footerMm, 25);
  const p3 = upsertBox(p2, { id: 'qr', band: 'footer', x: 140, y: 0, w: 10, h: 10 });
  const qr = lay(p3)!.canvas!.boxes.find((b) => b.id === 'qr')!;
  assert.ok(qr.w >= LAYOUT_BOUNDS.qrBoxMinMm && qr.h >= LAYOUT_BOUNDS.qrBoxMinMm);
  assert.ok(lay(p3)!.canvas!.footerMm >= 47);
  ok(p3);
  const moved = upsertBox(p3, { ...(qr as CanvasBox), x: 500 });
  assert.equal(lay(moved)!.canvas!.boxes.find((b) => b.id === 'qr')!.x, 188 - qr.w, 'clamped to the content width');
  // nudge: move and resize within the band
  const n1 = nudgeBox(p3, 'logo', -0.5, 50);
  const nl = lay(n1)!.canvas!.boxes.find((b) => b.id === 'logo')!;
  assert.deepEqual([nl.x, nl.y], [149.5, 0], 'y clamped inside the 20 mm band');
  const n2 = nudgeBox(p3, 'logo', 5, -100, true);
  const rl = lay(n2)!.canvas!.boxes.find((b) => b.id === 'logo')!;
  assert.deepEqual([rl.w, rl.h], [35.5, 5], 'resize: min 5 mm');
  assert.ok(rl.x + rl.w <= 188);
  ok(n2);
  assert.equal(nudgeBox(p3, 'customer', 1, 1), p3, 'missing box ⇒ no-op');
  const r = removeBox(p3, 'qr');
  assert.ok(!lay(r)!.canvas!.boxes.some((b) => b.id === 'qr'));
  ok(r);
  const t = mk('thermal');
  assert.equal(upsertBox(t, { id: 'logo', band: 'header', x: 0, y: 0, w: 10, h: 10 }), t);
});

test('starterCanvas: today’s header as logo/company/title/docInfo boxes, valid on page and impact for every logo setting', () => {
  for (const printer of ['page', 'impact'] as PrinterType[]) {
    for (const logo of ['start', 'center', 'end', 'none'] as const) {
      for (const showLogo of [true, false]) {
        const base = withLayout(mk(printer, { options: { ...mk(printer).options, showLogo } }), { logo });
        const c = starterCanvas(base);
        const p = withCanvas(base, c);
        ok(p, `${printer}/${logo}/${showLogo}`);
        const ids = c.boxes.map((b) => b.id);
        assert.deepEqual(ids.filter((i) => i !== 'logo'), ['company', 'title', 'docInfo']);
        assert.equal(ids.includes('logo'), logo !== 'none' && showLogo, `${printer}/${logo}/${showLogo}`);
        assert.equal(c.footerMm, 0);
        assert.deepEqual(lay(p)!.canvas, c, 'already canonical');
        if (ids.includes('logo')) {
          const lb = c.boxes.find((b) => b.id === 'logo')!;
          const W = printer === 'impact' ? 201 : 188;
          if (logo === 'start') assert.equal(lb.x + lb.w, W, 'start = physical right in RTL');
          if (logo === 'end') assert.equal(lb.x, 0);
        }
      }
    }
  }
  const pre = mk('impact', { template: 'impact_preprinted', options: { ...mk('impact').options, showLogo: true } });
  assert.ok(!starterCanvas(pre).boxes.some((b) => b.id === 'logo'), 'preprinted never has a logo');
});

test('editableClassicCopy: a roll_compact copy on the classic paper with a starter layout, routing moved, classic untouched', () => {
  const s = legacyPrintSettings();
  const before = JSON.stringify(s);
  const { settings, newId } = editableClassicCopy(s, 'legacy-58', 'Editable strip');
  assert.equal(JSON.stringify(s), before, 'input not mutated');
  assert.ok(newId);
  const copy = settings.profiles.find((p) => p.id === newId)!;
  assert.equal(copy.template, 'roll_compact');
  assert.equal(copy.printer, 'thermal');
  assert.equal(copy.name, 'Editable strip');
  assert.deepEqual(copy.paper, s.profiles.find((p) => p.id === 'legacy-58')!.paper);
  assert.deepEqual(copy.options.layout, { ...defaultPrintLayout('thermal'), logo: 'none', tableStyle: 'lines' });
  assert.deepEqual(settings.profiles.find((p) => p.id === 'legacy-58'), s.profiles.find((p) => p.id === 'legacy-58'));
  for (const k of Object.keys(s.routing) as (keyof typeof s.routing)[]) {
    assert.equal(settings.routing[k], s.routing[k] === 'legacy-58' ? newId : s.routing[k], k);
  }
  assert.deepEqual(printSettingsIssues(settings), []);
  // the copy is editable through the model
  ok(withLogo(copy, { logo: 'end', logoMm: 30 }));
  // not a classic, or full ⇒ unchanged
  assert.deepEqual(editableClassicCopy(s, 'legacy-a4'), { settings: s, newId: '' });
  assert.deepEqual(editableClassicCopy(s, 'nope'), { settings: s, newId: '' });
  const full = { ...s, profiles: [...s.profiles, ...Array.from({ length: 10 }, (_, i) => ({ ...mk('thermal'), id: `thermal-${i + 1}`, name: `t${i}` }))] };
  assert.equal(editableClassicCopy(full, 'legacy-58').newId, '');
  // a duplicated roll_classic profile also counts
  const dup = { ...s, profiles: [...s.profiles, { ...s.profiles.find((p) => p.id === 'legacy-58')!, id: 'van-1', name: 'سيارة', template: 'roll_classic' as const }] };
  assert.ok(editableClassicCopy(dup, 'van-1').newId);
});

test('freeIssues: the core messages for the four free keys only', () => {
  const p = mk('page');
  assert.deepEqual(freeIssues(p), []);
  assert.deepEqual(freeIssues(withLogo(p, { logoMm: 30 })), []);
  const raw = (layout: Partial<PrintLayout>): PrintProfile => ({ ...p, options: { ...p.options, layout: { ...defaultPrintLayout('page'), ...layout } } });
  assert.deepEqual(freeIssues(raw({ logoMm: 200 })), [PRINT_ISSUES.layoutLogoMm]);
  assert.deepEqual(freeIssues(raw({ sections: { items: { visible: false } } })), [PRINT_ISSUES.layoutLockedVisible]);
  assert.deepEqual(freeIssues(raw({ canvas: { headerMm: 60, footerMm: 0, boxes: [{ id: 'qr', band: 'header', x: 0, y: 0, w: 30, h: 30 }] } })), [PRINT_ISSUES.layoutCanvasQr]);
  assert.deepEqual(freeIssues(raw({ accent: '#FFFFFF' })), [], 'a 6-key issue is not a free-key issue');
});

test('fuzz: any sequence of model edits yields a profile the strict core accepts', () => {
  let seed = 20261103;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const num = (lo: number, hi: number): number => (rnd() < 0.05 ? pick([NaN, Infinity, -Infinity]) : lo + rnd() * (hi - lo));
  const SECS: SectionId[] = ['header', 'info', 'parties', 'customer', 'items', 'note', 'totals', 'installments', 'qr', 'signatures', 'footer'];
  const BOXES = ['logo', 'company', 'title', 'docInfo', 'customer', 'qr', 'totals', 'signatures', 'footer'] as const;
  for (let run = 0; run < 60; run++) {
    const printer = pick(['page', 'impact', 'thermal'] as PrinterType[]);
    let p = mk(printer, printer === 'thermal' ? { paper: presetPaper(pick(['roll58', 'roll80'] as const))! } : {});
    if (printer !== 'thermal' && rnd() < 0.3) p = withDesign(p, 'grid_bilingual');
    for (let step = 0; step < 25; step++) {
      const op = Math.floor(rnd() * 9);
      if (op === 0) p = withSectionStyle(p, pick(SECS), { visible: rnd() < 0.5, align: pick(['start', 'center', 'end'] as const), fontPct: num(0, 300), spaceBeforeMm: num(-10, 50), spaceAfterMm: num(-10, 50) });
      else if (op === 1) p = withLogo(p, { logo: pick(['start', 'center', 'end', 'none'] as const), logoMm: rnd() < 0.2 ? null : num(-10, 300), logoAfter: rnd() < 0.3 ? null : pick([...SECS, 'top'] as const) });
      else if (op === 2) p = upsertBox(p, { id: pick(BOXES), band: pick(['header', 'footer'] as const), x: num(-50, 250), y: num(-50, 200), w: num(-5, 250), h: num(-5, 200), fontPct: num(0, 300) });
      else if (op === 3) p = nudgeBox(p, pick(BOXES), num(-30, 30), num(-30, 30), rnd() < 0.5);
      else if (op === 4) p = removeBox(p, pick(BOXES));
      else if (op === 5) p = withCanvas(p, rnd() < 0.2 ? null : { headerMm: num(-10, 200), footerMm: num(-10, 200), boxes: [{ id: pick(BOXES), band: pick(['header', 'footer'] as const), x: num(0, 200), y: num(0, 100), w: num(0, 100), h: num(0, 100) }] });
      else if (op === 6) p = rnd() < 0.5 ? withCanvas(p, starterCanvas(p)) : resetCanvas(p);
      else if (op === 7) p = pick([resetLogo, resetSections])(p);
      else p = resetSection(p, pick(SECS));
      assert.deepEqual(profileIssues(p, 'p'), [], `run ${run} step ${step} op ${op}: ${JSON.stringify(lay(p))}`);
      for (const k of Object.keys(lay(p) ?? {})) assert.notEqual((lay(p) as unknown as Record<string, unknown>)[k], undefined, k);
    }
  }
});

test('designModel.ts is framework-free and writes only through withLayout', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'print', 'designModel.ts'), 'utf8');
  assert.ok(!/from 'react'|document\.|window\./.test(src));
  assert.ok(!/options:\s*\{\s*\.\.\.p\.options,\s*layout/.test(src.replace(/editableClassicCopy[\s\S]*$/, '')), 'no direct layout writes');
});
