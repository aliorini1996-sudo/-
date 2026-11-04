// «المصمّم الحرّ» على الورق القصير (فحص ٤ نوفمبر ٢٠٢٦): لوحتا رأس الورقة وتذييلها كانتا تبلغان 200 مم أياً كان طول الورق، فتأكلان
// صفحة A5 (210 مم) أو نصف الصفحة المتصلة ff_95x55 (139.7 مم) كلها. السقف صار بطول الورق: min(200، الطول − الهامشين − 40 مم للأصناف).
// الحفظ الصارم يرفضه 400 برسالته العربية، والقراءة المتسامحة تقصّ اللوحتين ولا تُسقط التصميم، وA4 والرول كما كانا حرفياً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_BOUNDS, PRINT_ISSUES, bandsTotalFor, checkPrintSettings, defaultPrintLayout, defaultPrintOptions, parsePrintSettings, presetPaper,
  type CanvasBox, type PaperPresetId, type PrintCanvas, type PrintProfile, type PrintSettingsV1,
} from '../services/printSettings';

const profile = (id: string, printer: PrintProfile['printer'], template: PrintProfile['template'], preset: Exclude<PaperPresetId, 'custom'>): PrintProfile => ({
  id, name: id, printer, template, paper: presetPaper(preset)!, options: defaultPrintOptions(printer),
});
function fleet(): PrintSettingsV1 {
  return {
    version: 1,
    profiles: [
      profile('mip480', 'impact', 'impact_plain', 'ff_a4'),
      profile('van-80', 'thermal', 'roll_detailed', 'roll80'),
      profile('office', 'page', 'page_plain', 'a4'),
    ],
    routing: { invoice: 'mip480', receipt: 'van-80', statement: 'office', notices: null },
    pdfProfileId: 'office',
    repMayChoose: true,
  };
}
const box = (id: CanvasBox['id'], band: CanvasBox['band'], x: number, y: number, w: number, h: number): CanvasBox => ({ id, band, x, y, w, h });
const withCanvasOn = (p: PrintProfile, canvas: PrintCanvas): PrintProfile =>
  ({ ...p, options: { ...p.options, layout: { ...defaultPrintLayout(p.printer, 'standard'), canvas } } });
const settingsWith = (p: PrintProfile): PrintSettingsV1 => ({ ...fleet(), profiles: [...fleet().profiles, p] });
const a5 = () => profile('a5-office', 'page', 'page_branded', 'a5');
const half = () => profile('mip-half', 'impact', 'impact_plain', 'ff_95x55');
const a4 = () => profile('office-2', 'page', 'page_branded', 'a4');

test('سقف اللوحتين بطول الورق: A4 وما فوقه 200، وA5 150، ونصف الصفحة 89.5، والرول وما بلا طول 200', () => {
  assert.equal(LAYOUT_BOUNDS.bandsTotalMm, 200);
  assert.equal(LAYOUT_BOUNDS.minItemsMm, 40);
  for (const id of ['a4', 'cut_a4', 'ff_a4', 'letter', 'ff_95x11', 'ff_95x12', 'ff_85x11', 'roll_a4'] as const) assert.equal(bandsTotalFor(presetPaper(id)), 200, id);
  assert.equal(bandsTotalFor(presetPaper('a5')), 150); // 210 − 10 − 10 − 40
  assert.equal(bandsTotalFor(presetPaper('ff_95x55')), 89.5); // 139.7 − 5 − 5 − 40 = 89.7 ⇒ شبكة 0.5 للأسفل
  for (const id of ['roll58', 'roll80', 'roll112'] as const) assert.equal(bandsTotalFor(presetPaper(id)), 200, id);
  assert.equal(bandsTotalFor(null), 200);
  assert.equal(bandsTotalFor({ lengthMm: 1000, marginTopMm: 0, marginBottomMm: 0, feed: 'roll' }), 200);
  assert.equal(bandsTotalFor({ lengthMm: 50, marginTopMm: 10, marginBottomMm: 10 }), 0); // لا سالب
});

test('الحفظ الصارم: لوحتان أطول من ورقهما ⇒ 400 برسالة الورق — وفي الحدّ تُقبلان، وA4 كما كان', () => {
  const tooTallA5 = withCanvasOn(a5(), { headerMm: 100, footerMm: 60, boxes: [box('company', 'header', 0, 0, 90, 30)] });
  const r = parsePrintSettings(settingsWith(tooTallA5));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.ok(r.issues.some((i) => i.message === PRINT_ISSUES.layoutCanvasBandsPaper && i.path.endsWith('options.layout.canvas.headerMm')), JSON.stringify(r.issues));
  }
  assert.ok(/الورق/.test(PRINT_ISSUES.layoutCanvasBandsPaper) && /40/.test(PRINT_ISSUES.layoutCanvasBandsPaper));
  // في الحدّ تماماً (150 على A5)
  assert.equal(parsePrintSettings(settingsWith(withCanvasOn(a5(), { headerMm: 100, footerMm: 50, boxes: [] }))).ok, true);
  // نصف الصفحة المتصلة: 90 مرفوضة و89.5 مقبولة
  const h90 = parsePrintSettings(settingsWith(withCanvasOn(half(), { headerMm: 60, footerMm: 30, boxes: [] })));
  assert.ok(!h90.ok && h90.status === 400 && h90.issues.some((i) => i.message === PRINT_ISSUES.layoutCanvasBandsPaper));
  assert.equal(parsePrintSettings(settingsWith(withCanvasOn(half(), { headerMm: 60, footerMm: 29.5, boxes: [] }))).ok, true);
  // A4: 150 + 50 = 200 مقبول كما كان، و150 + 60 بالرسالة القديمة وحدها (لا رسالة الورق)
  assert.equal(parsePrintSettings(settingsWith(withCanvasOn(a4(), { headerMm: 150, footerMm: 50, boxes: [] }))).ok, true);
  const over = parsePrintSettings(settingsWith(withCanvasOn(a4(), { headerMm: 150, footerMm: 60, boxes: [] })));
  assert.ok(!over.ok && over.status === 400);
  if (!over.ok) {
    assert.ok(over.issues.some((i) => i.message === PRINT_ISSUES.layoutCanvasBands));
    assert.ok(!over.issues.some((i) => i.message === PRINT_ISSUES.layoutCanvasBandsPaper));
  }
});

test('القراءة المتسامحة: تقصّ اللوحتين بطول الورق (التذييل أولاً) وتُبقي التصميم ومربعاته داخلها', () => {
  const stored = withCanvasOn(a5(), {
    headerMm: 100, footerMm: 80,
    boxes: [box('company', 'header', 0, 60, 90, 30), box('totals', 'footer', 0, 20, 90, 55), box('qr', 'footer', 100, 0, 50.5, 50.5)],
  });
  const r = checkPrintSettings(settingsWith(stored), false);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
  if (!r.ok) return;
  const p = r.value.profiles.find((x) => x.id === 'a5-office')!;
  const c = p.options.layout?.canvas;
  assert.ok(c, 'التصميم الحرّ لا يسقط');
  assert.deepEqual([c!.headerMm, c!.footerMm], [100, 50]);
  // المربعات داخل لوحاتها: الإجماليات قُصّت إلى 50 ورُفعت، وQR بقي (50.5 > 50 ⇒ قُصّ إلى 50 ≥ 47)
  assert.deepEqual(c!.boxes.find((b) => b.id === 'company'), box('company', 'header', 0, 60, 90, 30));
  assert.deepEqual(c!.boxes.find((b) => b.id === 'totals'), box('totals', 'footer', 0, 0, 90, 50));
  assert.deepEqual(c!.boxes.find((b) => b.id === 'qr'), box('qr', 'footer', 100, 0, 50.5, 50));
  // الناتج يمرّ بالحفظ الصارم كما هو
  assert.equal(checkPrintSettings(r.value, true).ok, true);
});

test('القراءة المتسامحة: لوحة لا تتّسع لمربعٍ تعيده إلى التدفّق (QR يُطبع هناك)، والرأس وحده أطول من الورق يُقصّ', () => {
  const stored = withCanvasOn(half(), {
    headerMm: 120, footerMm: 50,
    boxes: [box('logo', 'header', 0, 0, 30, 30), box('qr', 'footer', 0, 0, 47, 47)],
  });
  const r = checkPrintSettings(settingsWith(stored), false);
  assert.ok(r.ok);
  if (!r.ok) return;
  const c = r.value.profiles.find((x) => x.id === 'mip-half')!.options.layout?.canvas;
  assert.ok(c);
  assert.deepEqual([c!.headerMm, c!.footerMm], [89.5, 0]);
  assert.deepEqual(c!.boxes.map((b) => b.id), ['logo']);
});

test('القراءة المتسامحة: A4 والورق الطويل بلا أي تغيير — والمعيب في حدوده الثابتة يسقط كما اليوم', () => {
  const okA4 = withCanvasOn(a4(), { headerMm: 150, footerMm: 50, boxes: [box('company', 'header', 0, 0, 90, 30)] });
  const r = checkPrintSettings(settingsWith(okA4), false);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.profiles.find((x) => x.id === 'office-2')!.options.layout?.canvas, okA4.options.layout!.canvas);
  // 150 + 60 على A4 (فوق 200): يسقط canvas وحده كما كان قبل هذا الإصلاح — لا قصّ
  const bad = withCanvasOn(a4(), { headerMm: 150, footerMm: 60, boxes: [] });
  const r2 = checkPrintSettings(settingsWith(bad), false);
  assert.ok(r2.ok);
  if (r2.ok) {
    const l = r2.value.profiles.find((x) => x.id === 'office-2')!.options.layout;
    assert.ok(l && l.canvas === undefined);
  }
});
