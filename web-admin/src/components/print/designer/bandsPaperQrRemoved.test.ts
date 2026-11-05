// التقاء «سقف اللوحتين بطول الورق» (origin/master aba9176) مع «حذف رمز QR من المطبوعة» (قرار المالك ٤ نوفمبر ٢٠٢٦): الرمز المحذوف
// لا يفرض حدّ القراءة (47 مم) ولا يُطيل لوحةً — لا في نموذج التصميم ولا في المحرّك ولا في المقبض والمفتّش — والسقف بطول الورق كما
// هو (A4 200، وA5 150، ونصف الصفحة المتصلة 89.5) حذف الرمز أم لا؛ وما يُخرجه المصمّم يقبله الحفظ الصارم، والقراءة المتسامحة (الجهاز)
// تقصّ لوحتي الورق القصير وتُبقي الحذف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_BOUNDS, PRINT_ISSUES, bandsTotalFor, checkPrintSettings, isQrRemoved, layoutIssues, layoutOf, legacyPrintSettings, newProfile, presetPaper,
  type PaperPresetId, type PrintCanvas, type PrintProfile,
} from '../../../lib/print/printSettings';
import { canvasBoundsFor, drawnCanvasOf, starterCanvas, upsertBox, withCanvas, withQrRemoved } from '../../../lib/print/designModel';
import { resolveCanvas, resolveLayout } from '../../../lib/print/layout';
import { gripStart } from './A4BandsCanvas';
import { withBandHeight } from './DesignInspector';

const PAPERS: Array<[Exclude<PaperPresetId, 'custom'>, 'page' | 'impact', number]> = [['a4', 'page', 200], ['a5', 'page', 150], ['ff_95x55', 'impact', 89.5]];
const onPaper = (printer: 'page' | 'impact', preset: Exclude<PaperPresetId, 'custom'>): PrintProfile => ({ ...newProfile(printer, `p-${preset}`, []), paper: presetPaper(preset)! });
/** يكتب اللوحتين والحذف كما هما (بلا تطبيع designModel) — كإعدادٍ حفظه عميلٌ آخر */
const raw = (p: PrintProfile, canvas: PrintCanvas, qrRemoved: boolean): PrintProfile => ({
  ...p, options: { ...p.options, layout: { ...layoutOf(p), canvas, ...(qrRemoved ? { sections: { qr: { visible: false } } } : {}) } },
});
const canvasOf = (p: PrintProfile): PrintCanvas => p.options.layout!.canvas!;
const strictOk = (p: PrintProfile): boolean => checkPrintSettings({ ...legacyPrintSettings(), profiles: [...legacyPrintSettings().profiles, p] }, true).ok;
const ctx = (p: PrintProfile) => ({ printer: p.printer === 'impact' ? 'impact' as const : 'page' as const, qrMinMm: 50.5, kind: 'invoice' as const });

test('السقف بطول الورق لا يتغيّر بحذف الرمز: الحدود نفسها في النموذج والمحرّك والمصمّم', () => {
  for (const [preset, printer, total] of PAPERS) {
    const p = withCanvas(onPaper(printer, preset), { headerMm: 40, footerMm: 0, boxes: [] });
    const off = withQrRemoved(p, true);
    assert.equal(isQrRemoved(layoutOf(off)), true, preset);
    assert.equal(bandsTotalFor(off.paper), total, preset);
    assert.deepEqual(canvasBoundsFor(off), canvasBoundsFor(p), preset);
    assert.equal(canvasBoundsFor(off).bandsTotalMm, total, preset);
    assert.equal(resolveLayout(off)?.bandsTotalMm, resolveLayout(p)?.bandsTotalMm, preset);
  }
  assert.equal(canvasBoundsFor(withQrRemoved(onPaper('page', 'a4'), true)), LAYOUT_BOUNDS);
});

test('نموذج التصميم والرمز محذوف: لا مربع QR ولا لوحةٌ تطول لأجله، وما يخرجه يقبله الحفظ الصارم على كل ورق', () => {
  for (const [preset, printer, total] of PAPERS) {
    const base = withCanvas(onPaper(printer, preset), { headerMm: 30, footerMm: 10, boxes: [{ id: 'company', band: 'header', x: 0, y: 0, w: 60, h: 25 }] });
    const off = withQrRemoved(base, true);
    // مربع QR مرفوضٌ والقالب كما هو (الكائن نفسه)
    assert.equal(upsertBox(off, { id: 'qr', band: 'footer', x: 0, y: 0, w: 60, h: 60 }), off, preset);
    // لوحتان فيهما مربع QR طويل: يسقط المربع ولا تطول التذييل عن 10 (والرمز ظاهرٌ يطيلها إن اتّسع السقف)
    const withBox: PrintCanvas = { ...canvasOf(off), boxes: [...canvasOf(off).boxes, { id: 'qr', band: 'footer', x: 0, y: 0, w: 82, h: 82 }] };
    const c = canvasOf(withCanvas(off, withBox));
    assert.equal(c.boxes.some((b) => b.id === 'qr'), false, preset);
    assert.deepEqual([c.headerMm, c.footerMm], [30, 10], preset);
    const shown = canvasOf(withCanvas(base, withBox));
    if (total - 30 >= LAYOUT_BOUNDS.qrBoxMinMm) assert.ok(shown.footerMm >= LAYOUT_BOUNDS.qrBoxMinMm && shown.boxes.some((b) => b.id === 'qr'), `${preset}: الرمز الظاهر لم يُطِل لوحته`);
    else assert.equal(shown.boxes.some((b) => b.id === 'qr'), false, `${preset}: مربع QR لا يتّسع له السقف بقي`);
    // لوحة البداية والمخرجات كلها في سقف الورق وقواعد النواة
    const starter = withCanvas(off, starterCanvas(off));
    for (const p of [off, withCanvas(off, withBox), starter]) {
      const cc = canvasOf(p);
      assert.ok(cc.headerMm + cc.footerMm <= total, `${preset}: ${cc.headerMm}+${cc.footerMm} فوق ${total}`);
      assert.deepEqual(layoutIssues(p, 'p'), [], preset);
      assert.ok(strictOk(p), `${preset}: الحفظ الصارم رفض ما أخرجه المصمّم`);
      assert.equal(isQrRemoved(layoutOf(p)), true, preset);
    }
  }
});

test('حذف الرمز من قالبٍ فيه مربع QR على A5: يسقط المربع واللوحتان كما هما؛ والإعادة تعيده إلى التدفّق لا إلى اللوحة', () => {
  const p = upsertBox(withCanvas(onPaper('page', 'a5'), { headerMm: 60, footerMm: 0, boxes: [] }), { id: 'qr', band: 'footer', x: 0, y: 0, w: 50, h: 50 });
  assert.ok(canvasOf(p).boxes.some((b) => b.id === 'qr') && canvasOf(p).footerMm >= 50);
  const off = withQrRemoved(p, true);
  assert.equal(canvasOf(off).boxes.some((b) => b.id === 'qr'), false);
  assert.deepEqual([canvasOf(off).headerMm, canvasOf(off).footerMm], [canvasOf(p).headerMm, canvasOf(p).footerMm]);
  const back = withQrRemoved(off, false);
  assert.equal(isQrRemoved(layoutOf(back)), false);
  assert.equal(canvasOf(back).boxes.some((b) => b.id === 'qr'), false);
  assert.ok(strictOk(off) && strictOk(back));
});

test('مربع QR باقٍ في لوحةٍ والرمز محذوف (حفظه عميلٌ آخر): المحرّك لا يرسمه ولا يُطيل لوحته، والمقبض والمفتّش لا يحدّهما', () => {
  const stored: PrintCanvas = {
    headerMm: 60, footerMm: 10,
    boxes: [{ id: 'totals', band: 'footer', x: 0, y: 0, w: 80, h: 10 }, { id: 'qr', band: 'footer', x: 100, y: 0, w: 50, h: 10 }],
  };
  // المحرّك: الرمز الظاهر يُطيل التذييل لحدّ القراءة (الرمز أولى من السقف) — والمحذوف لا
  const shownR = resolveCanvas(resolveLayout(raw(onPaper('page', 'a5'), stored, false)), ctx(onPaper('page', 'a5')))!;
  assert.ok(shownR.footer!.hMm >= 50.5 && shownR.footer!.boxes.some((b) => b.id === 'qr'));
  const offP = raw(onPaper('page', 'a5'), stored, true);
  const offR = resolveCanvas(resolveLayout(offP), ctx(offP))!;
  assert.equal(offR.footer!.hMm, 10);
  assert.deepEqual(offR.footer!.boxes.map((b) => b.id), ['totals']);

  // المصمّم: لوحةٌ بمربع QR طوله 50 والرمز محذوف — التذييل ينزل حتى أطول مربعٍ مرسوم (20) لا حتى مربع الرمز
  const tall: PrintCanvas = { headerMm: 60, footerMm: 60, boxes: [{ id: 'totals', band: 'footer', x: 0, y: 0, w: 80, h: 20 }, { id: 'qr', band: 'footer', x: 100, y: 0, w: 50, h: 50 }] };
  const p = raw(onPaper('page', 'a5'), tall, true);
  assert.ok(strictOk(p), 'الحفظ الصارم يقبل مربع QR ≥ 47 والرمز محذوف (حماية الأجهزة القديمة)');
  const drawn = drawnCanvasOf(p)!;
  assert.deepEqual(drawn.boxes.map((b) => b.id), ['totals']);
  const lowered = withBandHeight(p, 'footer', 5);
  assert.deepEqual([canvasOf(lowered).footerMm, canvasOf(lowered).boxes.map((b) => b.id)], [20, ['totals']]);
  assert.ok(strictOk(lowered));
  const bandR = resolveCanvas(resolveLayout(p), ctx(p))!.footer!;
  assert.equal(gripStart(drawn, bandR, 'footer', canvasBoundsFor(p)).lim.min, 20);
  assert.equal(gripStart(drawn, bandR, 'footer', canvasBoundsFor(p)).lim.max, 120);
  // والرمز ظاهر: مربعه مرسومٌ يُطبع — فيبقى حدّه
  const kept = raw(onPaper('page', 'a5'), tall, false);
  assert.equal(drawnCanvasOf(kept), canvasOf(kept), 'بلا حذف: اللوحتان المخزّنتان نفسهما');
  assert.equal(canvasOf(withBandHeight(kept, 'footer', 5)).footerMm, 50);
});

test('الورق القصير والرمز محذوف: الحفظ الصارم يرفض لوحتين فوق سقف الورق، والقراءة المتسامحة تقصّهما وتُبقي الحذف فيقبلها الصارم', () => {
  const p = raw(onPaper('page', 'a5'), {
    headerMm: 140, footerMm: 60,
    boxes: [{ id: 'company', band: 'header', x: 0, y: 0, w: 80, h: 30 }, { id: 'qr', band: 'footer', x: 0, y: 0, w: 50, h: 50 }],
  }, true);
  const s = { ...legacyPrintSettings(), profiles: [...legacyPrintSettings().profiles, p] };
  const strict = checkPrintSettings(s, true);
  assert.ok(!strict.ok && strict.issues.some((i) => i.message === PRINT_ISSUES.layoutCanvasBandsPaper));
  const lenient = checkPrintSettings(s, false);
  assert.ok(lenient.ok);
  if (!lenient.ok) return;
  const read = lenient.value.profiles.find((x) => x.id === p.id)!;
  assert.equal(isQrRemoved(layoutOf(read)), true, 'القراءة أسقطت الحذف');
  const c = canvasOf(read);
  assert.deepEqual([c.headerMm, c.footerMm, c.boxes.map((b) => b.id)], [140, 10, ['company']]);
  assert.ok(strictOk(read));
  const r = resolveCanvas(resolveLayout(read), ctx(read))!;
  assert.deepEqual([r.header?.hMm, r.footer?.hMm, [...r.placed]], [140, 10, ['company']]);
});
