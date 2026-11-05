// «المصمّم الحرّ» — مراجعة تجربة الاستخدام (طلب المالك ٣ نوفمبر ٢٠٢٦): ما يرسمه المصمّم فوق الورقة يطابق ما تطبعه الورقة نفسها،
// ومقبض اللوحة يبدأ من الارتفاع المرسوم، والأسهم تعمل بهندسة السحب نفسها، والتركيز بلوحة المفاتيح يحدّد العنصر، واللمس لا يحبس
// تمرير الشريط الحراري. كل اختبارٍ هنا فشل على الشيفرة قبل إصلاحه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ITEMS_REMOVE_WARNING, LAYOUT_BOUNDS, QR_FLOW_NOTE, QR_REMOVE_ACTION, QR_REMOVE_WARNING, QR_RESTORE_ACTION, STAMPS_REMOVE_ACTION,
  STAMPS_REMOVE_WARNING, STAMPS_RESTORE_ACTION, layoutOf, newProfile, withDesign, withLayout, type CanvasBox, type PrintProfile,
} from '../../../lib/print/printSettings';
import { freeIssues, upsertBox, withCanvas, withLogo, withQrRemoved, withSectionStyle, withStampsRemoved } from '../../../lib/print/designModel';
import { resolveCanvas, resolveLayout } from '../../../lib/print/layout';
import { canvasQrMinMm } from '../../../rep/RepDocuments';
import { lookFor } from '../../../rep/printLook';
import A4BandsCanvas, { addableBoxes, boxKeyRect, commitBoxRect, drawnBoxes, gripStart, qrMinMmFor } from './A4BandsCanvas';
import { logoPlacements } from './stripModel';
import { hiddenRollSections, stripTouchAction } from './RollStrip';
import { QrRemoveField, SectionStyleFields, StampsField, complianceWarning, hideConfirmText } from './SectionStyleFields';
import DesignInspector, { qrBoxMinFor } from './DesignInspector';

/** قالب صفحة/نقطية بلوحة رأسٍ فيها مربع QR بحدّ الخادم (47 مم) */
function withQr(printer: 'page' | 'impact'): PrintProfile {
  const p0 = newProfile(printer, 'x', []);
  const p1 = withCanvas(p0, { headerMm: 60, footerMm: 0, boxes: [] });
  return upsertBox(p1, { id: 'qr', band: 'header', x: 0, y: 0, w: LAYOUT_BOUNDS.qrBoxMinMm, h: LAYOUT_BOUNDS.qrBoxMinMm });
}

test('حدّ QR في المصمّم = حدّ الورقة الحقيقية (canvasQrMinMm): الصفحة 50.5 مم لا 47 — والنقطية بخانتها', () => {
  for (const printer of ['page', 'impact'] as const) {
    const p = withQr(printer);
    assert.equal(qrMinMmFor(p), canvasQrMinMm(lookFor(p)), printer);
    const kind = printer === 'impact' ? 'impact' : 'page';
    const designer = resolveCanvas(resolveLayout(p), { printer: kind, qrMinMm: qrMinMmFor(p), kind: 'invoice' });
    const sheet = resolveCanvas(resolveLayout(p), { printer: kind, qrMinMm: canvasQrMinMm(lookFor(p)), kind: 'invoice' });
    assert.deepEqual(designer?.header?.boxes.map((b) => b.px), sheet?.header?.boxes.map((b) => b.px), `${printer}: إطار المصمّم ≠ مربع الورقة`);
    assert.equal(designer?.header?.hMm, sheet?.header?.hMm, `${printer}: ارتفاع اللوحة`);
  }
  assert.equal(qrMinMmFor(withQr('page')), 50.5);
  // المفتّش: الحدّ المعروض وحدّ حقلي العرض والارتفاع هو حدّ الورقة نفسه
  for (const printer of ['page', 'impact'] as const) assert.equal(qrBoxMinFor(withQr(printer)), qrMinMmFor(withQr(printer)));
  assert.doesNotMatch(read('DesignInspector.tsx'), /≥ \{LAYOUT_BOUNDS\.qrBoxMinMm\} mm/);
});

test('إطار مربع QR فوق الورقة (طبقة التحرير) بمقاس مربعها المرسوم في الورقة نفسها', () => {
  const p = withQr('page');
  const html = renderToStaticMarkup(createElement(A4BandsCanvas, {
    p, update: () => {}, doc: 'invoice', selected: null, onSelect: () => {}, zoom: 1, phase2: true, company: null,
  }));
  const overlay = /data-designer-box="qr"[^>]*style="[^"]*width:([0-9.]+)px;height:([0-9.]+)px/.exec(html);
  const sheet = /data-canvas-box="qr"[^>]*style="[^"]*width:([0-9.]+)px;height:([0-9.]+)px/.exec(html);
  assert.ok(overlay && sheet, 'الإطاران');
  assert.ok(Math.abs(Number(overlay[1]) - Number(sheet[1])) < 0.05, `عرض الإطار ${overlay[1]} ≠ الورقة ${sheet[1]}`);
  assert.ok(Math.abs(Number(overlay[2]) - Number(sheet[2])) < 0.05, `ارتفاع الإطار ${overlay[2]} ≠ الورقة ${sheet[2]}`);
});

test('مقبض اللوحة يبدأ من الارتفاع المرسوم (لا المخزَّن) ولا يقصر عن أطول مربعٍ مرسوم — كالأسهم', () => {
  const p0 = newProfile('page', 'x', []);
  // لوحة تذييلٍ مخزَّنة 50 مم ومربع QR فيها 47 ⇒ تُرسم 50.5 (حدّ الورقة)
  const p = upsertBox(withCanvas(p0, { headerMm: 20, footerMm: 50, boxes: [] }), { id: 'qr', band: 'footer', x: 0, y: 0, w: 47, h: 47 });
  const c = layoutOf(p).canvas!;
  const r = resolveCanvas(resolveLayout(p), { printer: 'page', qrMinMm: qrMinMmFor(p), kind: 'invoice' })!;
  assert.equal(c.footerMm, 50);
  assert.equal(r.footer?.hMm, 50.5);
  const g = gripStart(c, r.footer!, 'footer');
  assert.equal(g.h0, 50.5, 'بداية السحب = المرسوم');
  assert.ok(g.lim.min >= 50.5, `الحدّ الأدنى ${g.lim.min} أقصر من QR المرسوم`);
});

test('الأسهم على مربع QR: Alt+← لا تصغّره تحت حدّ الورقة (المخزَّن = المرسوم)، والنقل داخل اللوحة', () => {
  const p = withQr('page');
  const r = resolveCanvas(resolveLayout(p), { printer: 'page', qrMinMm: qrMinMmFor(p), kind: 'invoice' })!;
  const qr = r.header!.boxes.find((b) => b.id === 'qr')!;
  const shrunk = boxKeyRect(qr, r.header!.hMm, r.contentWmm, qrMinMmFor(p), { dx: -0.5, dy: -0.5, resize: true });
  assert.ok(shrunk.w >= 50.5 && shrunk.h >= 50.5, `صغُر QR إلى ${shrunk.w}×${shrunk.h}`);
  const left = boxKeyRect(qr, r.header!.hMm, r.contentWmm, qrMinMmFor(p), { dx: -5, dy: 0, resize: false });
  assert.equal(left.x, 0, 'لا يخرج يسار المحتوى');
  const company: CanvasBox = { id: 'company', band: 'header', x: 100, y: 5, w: 40, h: 20 };
  const grown = boxKeyRect({ ...company }, 60, 188, LAYOUT_BOUNDS.boxMinMm, { dx: 0.5, dy: 0.5, resize: true });
  assert.deepEqual([grown.x, grown.y, grown.w, grown.h], [100, 5, 40.5, 20.5], 'Alt+سهم يكبّر من الحافة اليمنى/السفلى');
});

const dir = path.join(process.cwd(), 'src', 'components', 'print', 'designer');
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');

test('لوحة المفاتيح: التركيز على مربعٍ أو كتلةٍ يحدّدها (فيظهر إطارها ومفتّشها)، وللتركيز حلقةٌ مرئية', () => {
  const a4 = read('A4BandsCanvas.tsx');
  assert.match(a4, /data-designer-box[\s\S]*onFocus=\{\(\) => \{ if \(!isSel\) onSelect\(`box:\$\{b\.id\}`\); \}\}/);
  const strip = read('RollStrip.tsx');
  assert.match(strip, /onFocus=\{\(\) => \{ if \(!isSel\) onSelect\(b\.sel as DesignSel\); \}\}/);
  for (const s of [a4, strip]) assert.match(s, /focus-visible:ring-2/);
  // مقابض تغيير الحجم تستقبل الأسهم أيضاً (السحب يركّزها)
  assert.match(a4, /onPointerDown=\{\(e\) => boxDrag\(e, b, h\)\}\s*onKeyDown=\{\(e\) => onBoxKey\(e, b\.id\)\}/);
});

test('اللمس على الشريط الحراري: الكتلة غير المحدّدة تترك التمرير العمودي للصفحة، والمحدّدة تُسحب', () => {
  assert.equal(stripTouchAction(false), 'pan-y');
  assert.equal(stripTouchAction(true), 'none');
  const strip = read('RollStrip.tsx');
  assert.match(strip, /touchAction: stripTouchAction\(isSel\)/);
  // لمسةٌ على كتلةٍ غير محدّدة لا تحدّدها عند الضغط (قد تكون تمريراً) — بل عند النقر أو الإفلات بعد سحبٍ أفقي
  assert.match(strip, /e\.pointerType !== 'touch' \|\| selected === sel/);
});

// ─── مراجعة المصمّم (الجولة الثانية) ───

test('إفلات مربعٍ أو تحريكه بالأسهم في لوحةٍ طوّلها QR (المرسومة > المخزَّنة): يبقى حيث أُفلت، لا يُقصّ إلى المخزَّنة', () => {
  for (const printer of ['page', 'impact'] as const) {
    const kind = printer === 'impact' ? 'impact' : 'page';
    let p = withCanvas(newProfile(printer, 'x', []), { headerMm: 20, footerMm: 0, boxes: [] });
    p = upsertBox(p, { id: 'qr', band: 'footer', x: 0, y: 0, w: 47, h: 47 });
    p = upsertBox(p, { id: 'totals', band: 'footer', x: 100, y: 0, w: 80, h: 10 });
    const r = resolveCanvas(resolveLayout(p), { printer: kind, qrMinMm: qrMinMmFor(p), kind: 'invoice' })!;
    assert.ok(r.footer!.hMm > layoutOf(p).canvas!.footerMm, `${printer}: اللوحة المرسومة أطول من المخزَّنة`);
    const stored = layoutOf(p).canvas!.boxes.find((b) => b.id === 'totals')!;
    // السحب: أسفل اللوحة المرسومة
    const y = r.footer!.hMm - 10;
    const p2 = commitBoxRect(p, { ...stored, y }, r.footer!.hMm);
    const r2 = resolveCanvas(resolveLayout(p2), { printer: kind, qrMinMm: qrMinMmFor(p2), kind: 'invoice' })!;
    assert.equal(r2.footer!.boxes.find((b) => b.id === 'totals')!.y, y, `${printer}: قفز المربع عن موضع إفلاته`);
    assert.equal(r2.footer!.hMm, r.footer!.hMm, `${printer}: تغيّر ارتفاع اللوحة المرسوم`);
    assert.deepEqual(freeIssues(p2), [], `${printer}: الخادم يرفض ما التزمه المصمّم`);
    assert.deepEqual(r2.footer!.boxes.find((b) => b.id === 'qr')!.px, r.footer!.boxes.find((b) => b.id === 'qr')!.px, `${printer}: تحرّك QR`);
    // السهم ↓ من موضعٍ عند حدّ المخزَّنة يتحرّك فعلاً
    const at = { ...r.footer!.boxes.find((b) => b.id === 'totals')!, y: layoutOf(p).canvas!.footerMm - 10 };
    const k = boxKeyRect(at, r.footer!.hMm, r.contentWmm, LAYOUT_BOUNDS.boxMinMm, { dx: 0, dy: 0.5, resize: false });
    const p3 = commitBoxRect(p, { ...stored, ...k }, r.footer!.hMm);
    const r3 = resolveCanvas(resolveLayout(p3), { printer: kind, qrMinMm: qrMinMmFor(p3), kind: 'invoice' })!;
    assert.equal(r3.footer!.boxes.find((b) => b.id === 'totals')!.y, at.y + 0.5, `${printer}: السهم ↓ لا يحرّك`);
    // لوحةٌ مخزَّنة تكفي ⇒ commitBoxRect = upsertBox حرفياً (لا يُرفع شيء)
    assert.deepEqual(commitBoxRect(p, { ...stored, y: 5 }, layoutOf(p).canvas!.footerMm), upsertBox(p, { ...stored, y: 5 }));
  }
  const a4 = read('A4BandsCanvas.tsx');
  assert.equal((a4.match(/update\(commitBoxRect\(p, /g) ?? []).length, 2, 'السحب والأسهم كلاهما يلتزمان باللوحة المرسومة');
});

test('الشريط: الأسهم من «بعد الترويسة» (يصل إليها الإفلات والأدوات) تتحرّك جاراً لا قفزاً إلى «أعلى الورقة»', () => {
  const p = withLogo(withLayout(newProfile('thermal', 'رول', []), {}), { logoAfter: 'header' });
  assert.equal(layoutOf(p).logoAfter, 'header');
  const places = logoPlacements(p);
  const at = places.indexOf('header');
  assert.ok(at > 0, '«بعد الترويسة» من الأماكن');
  assert.equal(places[at - 1], null, '↑ يعيده داخل الترويسة');
  assert.equal(places[at + 1], 'info', '↓ ينقله بعد القسم التالي');
  assert.equal(new Set(places).size, places.length, 'بلا تكرار');
});

test('مقبض ارتفاع اللوحة تحت المربع المحدَّد (مقابضه s/se/sw على الحدّ تبقى قابلة للسحب) وفوق غير المحدَّد', () => {
  let p = withCanvas(newProfile('page', 'x', []), { headerMm: 30, footerMm: 0, boxes: [] });
  // مربعٌ ملتقطٌ إلى حدّ اللوحة السفلي (y + h = 30)
  p = upsertBox(p, { id: 'company', band: 'header', x: 100, y: 10, w: 80, h: 20 });
  p = upsertBox(p, { id: 'title', band: 'header', x: 0, y: 10, w: 60, h: 20 });
  const html = renderToStaticMarkup(createElement(A4BandsCanvas, {
    p, update: () => {}, doc: 'invoice', selected: 'box:company', onSelect: () => {}, zoom: 1, phase2: false, company: null,
  }));
  const z = (re: RegExp): number => Number((/z-index:(\d+)/.exec((re.exec(html) ?? [''])[0]) ?? [])[1]);
  const grip = z(/<button[^>]*style="[^"]*cursor:ns-resize;touch-action:none;pointer-events:auto;z-index:\d+/);
  const sel = z(/<div data-designer-box="company"[^>]*style="[^"]*z-index:\d+/);
  const other = z(/<div data-designer-box="title"[^>]*style="[^"]*z-index:\d+/);
  assert.ok(Number.isFinite(grip) && Number.isFinite(sel) && Number.isFinite(other), 'الطبقات');
  assert.ok(grip < sel, `المقبض (${grip}) يغطّي المربع المحدَّد (${sel})`);
  assert.ok(grip > other, `المقبض (${grip}) تحت المربع غير المحدَّد (${other})`);
});

test('المربّع الأصغر فوق الأكبر حين يتداخلان (الشعار على بيانات المستند يبقى قابلاً للنقر) — تجربة المتصفح ٤ نوفمبر', () => {
  let p = withCanvas(newProfile('page', 'x', []), { headerMm: 46, footerMm: 0, boxes: [] });
  // الشعار أُضيف أولاً ثم بيانات المستند فوقه — في ترتيب الحفظ يأتي الأكبر آخراً
  p = upsertBox(p, { id: 'logo', band: 'header', x: 40, y: 20, w: 11, h: 11 });
  p = upsertBox(p, { id: 'docInfo', band: 'header', x: 14, y: 14, w: 92, h: 30 });
  const html = renderToStaticMarkup(createElement(A4BandsCanvas, {
    p, update: () => {}, doc: 'invoice', selected: null, onSelect: () => {}, zoom: 1, phase2: false, company: null,
  }));
  const at = (id: string): number => html.indexOf(`data-designer-box="${id}"`);
  assert.ok(at('logo') > 0 && at('docInfo') > 0, 'المربعان مرسومان');
  assert.ok(at('logo') > at('docInfo'), 'الأصغر يُرسم بعد الأكبر فيعلوه بالطبقة نفسها');
});

test('الشعار المطفأ (افتراض الحراري) يُفعَّل من المصمّم مباشرةً بزرّ «تفعيل» — تجربة المتصفح ٤ نوفمبر', () => {
  const roll = newProfile('thermal', 'r', []);
  assert.equal(roll.options.showLogo, false, 'الحراري يبدأ بالشعار مطفأً');
  let got: typeof roll | null = null;
  const html = renderToStaticMarkup(createElement(DesignInspector, {
    p: roll, update: (n) => { got = n; }, selected: 'logo', onSelect: () => {}, phase2: false,
  }));
  assert.match(html, /data-logo-enable=""/, 'زرّ التفعيل بجانب التنبيه');
  const on = renderToStaticMarkup(createElement(DesignInspector, {
    p: { ...roll, options: { ...roll.options, showLogo: true } }, update: () => {}, selected: 'logo', onSelect: () => {}, phase2: false,
  }));
  assert.doesNotMatch(on, /data-logo-enable/, 'لا زرّ حين يكون ظاهراً');
  assert.equal(got, null);
});

// ─── قرار المالك ٤ نوفمبر ٢٠٢٦: «اجعل يمكن حذف كل شي حتى كيو ار» ───

const ident = (s: string): string => s;

test('حذف QR في المصمّم: لا مربع يُضاف ولا يُرسم، والتنبيه الأحمر مكان ملاحظة التدفّق — وبلا حذف الهندسة كما هي', () => {
  const p = withQr('page');
  // بلا حذف: QR قابل للإضافة على قالبٍ بلا مربعه، والمرسوم كما هو، وملاحظة التدفّق الجديدة
  const bare = withCanvas(newProfile('page', 'x', []), { headerMm: 30, footerMm: 0, boxes: [] });
  assert.ok(addableBoxes(bare, 'invoice').includes('qr'));
  assert.ok(!addableBoxes(bare, 'receipt').includes('qr'), 'السند بلا QR كاليوم');
  const r = resolveCanvas(resolveLayout(p), { printer: 'page', qrMinMm: qrMinMmFor(p), kind: 'invoice' })!;
  assert.deepEqual(drawnBoxes(p, r.header!.boxes).map((b) => b.id), r.header!.boxes.map((b) => b.id), 'بلا حذف: كل المربعات تُرسم');
  const live = renderToStaticMarkup(createElement(A4BandsCanvas, { p, update: () => {}, doc: 'invoice', selected: null, onSelect: () => {}, zoom: 1, phase2: true, company: null }));
  assert.match(live, /data-designer-box="qr"/);
  assert.ok(live.includes(QR_FLOW_NOTE), 'ملاحظة التدفّق');
  assert.doesNotMatch(live, /data-qr-removed-note/);
  assert.doesNotMatch(live, /رمز QR يطبع دائما/, 'لا «يطبع دائما» بعد قرار المالك');
  // بالحذف: لا إضافة ولا إطار، والتنبيه الأحمر الدائم — وعلامة نموذج الاختبار على الشاشة باقية
  const gone = withQrRemoved(bare, true);
  assert.ok(!addableBoxes(gone, 'invoice').includes('qr'));
  assert.deepEqual(drawnBoxes(gone, [{ id: 'qr' as const }, { id: 'company' as const }]).map((b) => b.id), ['company']);
  const removed = renderToStaticMarkup(createElement(A4BandsCanvas, { p: withQrRemoved(p, true), update: () => {}, doc: 'invoice', selected: null, onSelect: () => {}, zoom: 1, phase2: true, company: null }));
  assert.doesNotMatch(removed, /data-designer-box="qr"/);
  assert.match(removed, /role="note" data-qr-removed-note=""/);
  assert.ok(removed.includes(QR_REMOVE_WARNING));
  assert.ok(!removed.includes(QR_FLOW_NOTE));
  assert.match(removed, /نموذج اختبار/, 'علامة المعاينة على الشاشة باقية');
});

test('الأصناف ورمز QR يُخفيان من أدوات القسم بتأكيدٍ واحد قوي وتنبيهٍ أحمر دائم — لا زرّ معطّل ولا «لا تخفى»', () => {
  assert.equal(complianceWarning('qr'), QR_REMOVE_WARNING);
  assert.equal(complianceWarning('items'), ITEMS_REMOVE_WARNING);
  assert.equal(complianceWarning('note'), null);
  assert.equal(hideConfirmText('qr', ident), `${QR_REMOVE_ACTION}\n${QR_REMOVE_WARNING}`);
  assert.equal(hideConfirmText('items', ident), `إخفاء القسم: الأصناف\n${ITEMS_REMOVE_WARNING}`);
  assert.match(hideConfirmText('totals', ident)!, /^إخفاء القسم: /, 'الإلزامية الأخرى كما هي');
  assert.equal(hideConfirmText('note', ident), null, 'قسمٌ عادي بلا تأكيد');
  for (const printer of ['page', 'thermal'] as const) {
    const p = newProfile(printer, 'x', []);
    const shown = renderToStaticMarkup(createElement(SectionStyleFields, { p, update: () => {}, id: 'items', phase2: true }));
    assert.doesNotMatch(shown, /disabled=""[^>]*aria-pressed="true"|aria-pressed="true"[^>]*disabled=""/, `${printer}: زرّ الظهور معطّل`);
    assert.ok(!shown.includes(ITEMS_REMOVE_WARNING), 'لا تنبيه قبل الإخفاء');
    const hid = renderToStaticMarkup(createElement(SectionStyleFields, { p: withSectionStyle(p, 'items', { visible: false }), update: () => {}, id: 'items', phase2: true }));
    assert.match(hid, /role="note" data-compliance-note="items"/);
    assert.ok(hid.includes(ITEMS_REMOVE_WARNING));
  }
  const roll = withQrRemoved(newProfile('thermal', 'r', []), true);
  const q = renderToStaticMarkup(createElement(SectionStyleFields, { p: roll, update: () => {}, id: 'qr', phase2: true }));
  assert.match(q, /data-compliance-note="qr"/);
  assert.ok(q.includes(QR_REMOVE_WARNING));
  // شرائح «مخفي» في الشريط تشمل الأصناف وQR
  assert.deepEqual(hiddenRollSections(withSectionStyle(roll, 'items', { visible: false })).sort(), ['items', 'qr']);
  const src = read('SectionStyleFields.tsx');
  assert.doesNotMatch(src, /LOCKED_VISIBLE/);
  assert.equal((src.match(/window\.confirm\(/g) ?? []).length, 3, 'تأكيدٌ واحد لكل إجراء حذف (القسم، QR، الأختام)');
});

test('QrRemoveField وStampsField: زرّ الحذف/الإعادة والتنبيه الأحمر ما دام محذوفاً — وفي المفتّش بلا تحديد ومع مربع QR', () => {
  for (const p of [newProfile('page', 'x', []), newProfile('thermal', 'r', []), withDesign(newProfile('impact', 'i', []), 'grid_bilingual')]) {
    const on = renderToStaticMarkup(createElement(QrRemoveField, { p, update: () => {} }));
    assert.match(on, /data-qr-remove=""/);
    assert.ok(on.includes(QR_REMOVE_ACTION) && !on.includes(QR_REMOVE_WARNING), p.printer);
    const off = renderToStaticMarkup(createElement(QrRemoveField, { p: withQrRemoved(p, true), update: () => {} }));
    assert.match(off, /data-qr-remove="removed"/);
    assert.ok(off.includes(QR_RESTORE_ACTION) && off.includes(QR_REMOVE_WARNING), p.printer);
    assert.match(off, /role="note"/);
    const s0 = renderToStaticMarkup(createElement(StampsField, { p, update: () => {} }));
    assert.match(s0, /data-stamps=""/);
    assert.ok(s0.includes(STAMPS_REMOVE_ACTION) && !s0.includes(STAMPS_REMOVE_WARNING));
    const s1 = renderToStaticMarkup(createElement(StampsField, { p: withStampsRemoved(p, true), update: () => {} }));
    assert.match(s1, /data-stamps="removed"/);
    assert.ok(s1.includes(STAMPS_RESTORE_ACTION) && s1.includes(STAMPS_REMOVE_WARNING));
    // المفتّش بلا تحديد: الحقلان لكل طابعة قابلة للتحرير
    const insp = renderToStaticMarkup(createElement(DesignInspector, { p, update: () => {}, selected: null, onSelect: () => {}, phase2: true }));
    assert.match(insp, /data-qr-remove=/);
    assert.match(insp, /data-stamps=/);
  }
  // مربع QR محدَّد: «إعادة إلى مكانه التلقائي» (إخراجٌ من اللوحة) وبجانبه الحذف الصريح، وحدّ القراءة كما هو
  const p = withQr('page');
  const box = renderToStaticMarkup(createElement(DesignInspector, { p, update: () => {}, selected: 'box:qr', onSelect: () => {}, phase2: true }));
  assert.match(box, /إعادة رمز QR إلى مكانه التلقائي/);
  assert.match(box, /data-qr-remove=""/);
  assert.match(box, /رمز QR لا يصغر عن حد القراءة/);
});
