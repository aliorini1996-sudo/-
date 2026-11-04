// «المصمّم الحرّ» على الورق القصير (فحص ٤ نوفمبر ٢٠٢٦): لوحتا الرأس والتذييل كانتا تبلغان 200 مم أياً كان طول الورق، فتأكلان
// صفحة A5 (210 مم) أو نصف الصفحة المتصلة ff_95x55 (139.7 مم) كلها. السقف الآن بطول الورق (bandsTotalFor): النواة في الواجهة،
// والمحرّك (resolveLayout/resolveCanvas)، ونموذج التصميم (withCanvas/upsertBox/starterCanvas)، والمقبض والمفتّش — وA4 كما كان حرفياً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_BOUNDS, PAPER_PRESETS, PRINT_ISSUES, bandsTotalFor, checkPrintSettings, layoutIssues, layoutOf, legacyPrintSettings, newProfile,
  presetPaper, type PaperPresetId, type PrintCanvas, type PrintProfile,
} from '../../../lib/print/printSettings';
import { canvasBoundsFor, starterCanvas, upsertBox, withCanvas } from '../../../lib/print/designModel';
import { paperBandsTotal, resolveCanvas, resolveLayout } from '../../../lib/print/layout';
import { bandHeightFromDrag, bandLimits } from './designerMath';
import { gripStart } from './A4BandsCanvas';
import { withBandHeight } from './DesignInspector';

const onPaper = (printer: 'page' | 'impact', preset: Exclude<PaperPresetId, 'custom'>): PrintProfile => ({ ...newProfile(printer, `p-${preset}`, []), paper: presetPaper(preset)! });
/** يكتب اللوحتين كما هما (بلا تطبيع designModel) — كإعدادٍ مخزّنٍ قبل الإصلاح */
const rawCanvas = (p: PrintProfile, canvas: PrintCanvas): PrintProfile => ({ ...p, options: { ...p.options, layout: { ...layoutOf(p), canvas } } });
const total = (p: PrintProfile): number => (p.options.layout?.canvas ? p.options.layout.canvas.headerMm + p.options.layout.canvas.footerMm : 0);
const ctx = { printer: 'page' as const, qrMinMm: 50.5, kind: 'invoice' as const };

test('نواة الواجهة: السقف بطول الورق — A4 200، وA5 150، ونصف الصفحة 89.5، والرول 200', () => {
  assert.equal(bandsTotalFor(presetPaper('a4')), LAYOUT_BOUNDS.bandsTotalMm);
  assert.equal(bandsTotalFor(presetPaper('a5')), 150);
  assert.equal(bandsTotalFor(presetPaper('ff_95x55')), 89.5);
  assert.equal(bandsTotalFor(presetPaper('roll80')), 200);
});

test('المحرّك: paperBandsTotal نسخة bandsTotalFor في كل مقاس جاهز وحالات الحافة', () => {
  for (const pr of PAPER_PRESETS) assert.equal(paperBandsTotal(pr.paper), bandsTotalFor(pr.paper), pr.id);
  for (const paper of [null, undefined, {}, { lengthMm: 60, marginTopMm: 30, marginBottomMm: 30 }, { lengthMm: 180.3, marginTopMm: -2, marginBottomMm: 0 },
    { lengthMm: 300, marginTopMm: 0, marginBottomMm: 0, feed: 'roll' as const }]) {
    assert.equal(paperBandsTotal(paper), bandsTotalFor(paper as Parameters<typeof bandsTotalFor>[0]), JSON.stringify(paper));
  }
});

test('النواة المتسامحة في الواجهة: تقصّ لوحتي A5 ولا تُسقطهما، والصارمة ترفض برسالة الورق', () => {
  const p = rawCanvas(onPaper('page', 'a5'), { headerMm: 120, footerMm: 60, boxes: [{ id: 'company', band: 'header', x: 0, y: 90, w: 80, h: 30 }] });
  const s = { ...legacyPrintSettings(), profiles: [...legacyPrintSettings().profiles, p] };
  const strict = checkPrintSettings(s, true);
  assert.ok(!strict.ok && strict.issues.some((i) => i.message === PRINT_ISSUES.layoutCanvasBandsPaper));
  const lenient = checkPrintSettings(s, false);
  assert.ok(lenient.ok);
  if (lenient.ok) {
    const c = lenient.value.profiles.find((x) => x.id === p.id)!.options.layout?.canvas;
    assert.deepEqual(c && [c.headerMm, c.footerMm, c.boxes[0].y], [120, 30, 90]);
  }
});

test('المحرّك: resolveCanvas يقصّ اللوحتين بطول الورق — وA4 بلا مفتاحٍ جديد ولا تغيير', () => {
  // A4: 150 + 50 كما هي، وresolveLayout بلا bandsTotalMm (تخطيط اليوم حرفياً)
  const a4 = rawCanvas(onPaper('page', 'a4'), { headerMm: 150, footerMm: 50, boxes: [] });
  const la4 = resolveLayout(a4)!;
  assert.equal('bandsTotalMm' in la4, false);
  const ra4 = resolveCanvas(la4, ctx)!;
  assert.deepEqual([ra4.header?.hMm, ra4.footer?.hMm], [150, 50]);
  // A5: 120 + 60 مخزّنة ⇒ تُرسم 120 + 30
  const a5 = rawCanvas(onPaper('page', 'a5'), { headerMm: 120, footerMm: 60, boxes: [] });
  const la5 = resolveLayout(a5)!;
  assert.equal(la5.bandsTotalMm, 150);
  const r5 = resolveCanvas(la5, ctx)!;
  assert.deepEqual([r5.header?.hMm, r5.footer?.hMm], [120, 30]);
  // نصف الصفحة: رأسٌ وحده 120 ⇒ 89.5 والتذييل يختفي
  const half = rawCanvas(onPaper('impact', 'ff_95x55'), { headerMm: 120, footerMm: 40, boxes: [] });
  const rh = resolveCanvas(resolveLayout(half), { ...ctx, printer: 'impact' })!;
  assert.deepEqual([rh.header?.hMm, rh.footer], [89.5, null]);
});

test('نموذج التصميم: withCanvas وupsertBox وstarterCanvas لا تتجاوز سقف الورق — وA4 كما كان', () => {
  const a4 = withCanvas(onPaper('page', 'a4'), { headerMm: 150, footerMm: 120, boxes: [] });
  assert.deepEqual([a4.options.layout!.canvas!.headerMm, a4.options.layout!.canvas!.footerMm], [150, 50]);
  assert.equal(canvasBoundsFor(a4), LAYOUT_BOUNDS);
  const a5 = withCanvas(onPaper('page', 'a5'), { headerMm: 150, footerMm: 120, boxes: [] });
  assert.deepEqual([a5.options.layout!.canvas!.headerMm, a5.options.layout!.canvas!.footerMm], [150, 0]);
  const half = withCanvas(onPaper('impact', 'ff_95x55'), { headerMm: 60, footerMm: 120, boxes: [] });
  assert.deepEqual([half.options.layout!.canvas!.headerMm, half.options.layout!.canvas!.footerMm], [60, 29.5]);
  // مربع QR في تذييل نصف صفحةٍ رأسها 60: لا يتّسع (29.5 < 47) ⇒ يبقى في التدفّق، ولا تكبر اللوحة فوق السقف
  const q = upsertBox(half, { id: 'qr', band: 'footer', x: 0, y: 0, w: 47, h: 47 });
  assert.ok(total(q) <= 89.5);
  assert.equal(q.options.layout!.canvas!.boxes.some((b) => b.id === 'qr'), false);
  // مربعٌ أطول من المتاح: اللوحة تكبر حتى السقف وحده
  const tall = upsertBox(half, { id: 'customer', band: 'footer', x: 0, y: 0, w: 60, h: 60 });
  assert.ok(total(tall) <= 89.5, String(total(tall)));
  for (const p of [a5, half, q, tall, withCanvas(onPaper('page', 'a5'), starterCanvas(onPaper('page', 'a5')))]) {
    assert.deepEqual(layoutIssues(p, 'p'), [], JSON.stringify(p.options.layout?.canvas));
  }
});

test('المقبض والمفتّش: السحب يقف عند سقف الورق — وA4 عند 200 كما كان', () => {
  const a5 = withCanvas(onPaper('page', 'a5'), { headerMm: 100, footerMm: 30, boxes: [] });
  const c = a5.options.layout!.canvas!;
  const bandR = resolveCanvas(resolveLayout(a5), ctx)!.footer!;
  const { h0, lim } = gripStart(c, bandR, 'footer', canvasBoundsFor(a5));
  assert.equal(bandHeightFromDrag(h0, 500, lim), 50); // 150 − 100
  assert.equal(bandLimits(c, 'header', canvasBoundsFor(a5)).max, 150);
  assert.equal(total(withBandHeight(a5, 'footer', 120)), 150);
  assert.equal(withBandHeight(a5, 'footer', 120).options.layout!.canvas!.footerMm, 50);
  // A4: الحدود القديمة نفسها (التذييل حتى 100 مع رأسٍ 100)
  const a4 = withCanvas(onPaper('page', 'a4'), { headerMm: 100, footerMm: 30, boxes: [] });
  const ga4 = gripStart(a4.options.layout!.canvas!, resolveCanvas(resolveLayout(a4), ctx)!.footer!, 'footer', canvasBoundsFor(a4));
  assert.deepEqual(ga4.lim, gripStart(a4.options.layout!.canvas!, resolveCanvas(resolveLayout(a4), ctx)!.footer!, 'footer').lim);
  assert.equal(bandHeightFromDrag(ga4.h0, 500, ga4.lim), 100);
  assert.equal(withBandHeight(a4, 'footer', 120).options.layout!.canvas!.footerMm, 100);
});
