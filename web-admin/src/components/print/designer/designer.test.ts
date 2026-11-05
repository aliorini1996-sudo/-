// «المصمّم الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦، pd_spec E.6) — هندسة السحب الخالصة، وآلة حالة المؤشّر بأحداثٍ اصطناعية (لا بيئة
// DOM في المشروع)، ومنطق الشريط الحراري عبر قواعد الترتيب الحقيقية، وحرّاسٌ مصدرية للأزرار واللمس والترجمة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PX_PER_MM, alignFromDrag, bandAllows, bandHeightFromDrag, bandLimits, boxMinMm, constrainRect, fitBoxesToBand, indexFromY, keyDelta,
  logoAfterFromDrop, logoMmFromDrag, logoMmStep, moveIndexBefore, moveRect, pushHistory, redoHistory, resizeRect, screenToMm, snapGrid,
  snapRect, stepAlign, undoHistory, type History,
} from './designerMath';
import { createDragTracker, type DragPoint } from './usePointerDrag';
import { logoPlacements, rollAlignOf, sectionDrop, withSectionBefore } from './stripModel';
import { canMoveSection, layoutOf, newProfile, withLayout, type PrintProfile, type SectionId } from '../../../lib/print/printSettings';
import { PHRASES } from '../../../i18n/strings';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ─── الهندسة ───

test('الشاشة ← الملّيمتر: بكسل ÷ المقياس ÷ 96/25.4 (0.45 و1)', () => {
  near(PX_PER_MM, 96 / 25.4);
  near(screenToMm(PX_PER_MM * 10, 1), 10, 1e-3);
  near(screenToMm(PX_PER_MM * 0.45 * 20, 0.45), 20, 1e-3);
  near(screenToMm(-PX_PER_MM * 0.45 * 4, 0.45), -4, 1e-3);
  // مقياسٌ غير صالح لا ينتج NaN/Infinity
  assert.ok(Number.isFinite(screenToMm(100, 0)));
  assert.ok(Number.isFinite(screenToMm(Number.NaN, 1)));
});

test('الالتقاط: الشبكة 0.5 ملم، ثم الحواف والمنتصفات ضمن 1.5 ملم تتقدّم (مع خط إرشاد)', () => {
  assert.equal(snapGrid(10.26), 10.5);
  assert.equal(snapGrid(10.24), 10);
  // شبكة فقط (بعيداً عن كل خط): بلا خطوط إرشاد
  const g = snapRect({ x: 50.3, y: 20.2, w: 30, h: 10 }, null, [], 188, 90);
  assert.deepEqual(g.rect, { x: 50.5, y: 20, w: 30, h: 10 });
  assert.equal(g.guides.length, 0);
  // الحافة اليسرى للوحة (0) ضمن 1.2 ملم
  const e = snapRect({ x: 1.2, y: 30, w: 30, h: 10 }, null, [], 188, 90);
  assert.equal(e.rect.x, 0);
  assert.deepEqual(e.guides.find((x) => x.axis === 'x'), { axis: 'x', at: 0 });
  // المنتصف: مركز المربع (x + w/2) يلتصق بمنتصف اللوحة 94
  const c = snapRect({ x: 78.8, y: 30, w: 30, h: 10 }, null, [], 188, 90);
  assert.equal(c.rect.x, 79);
  assert.ok(c.guides.some((x) => x.axis === 'x' && x.at === 94));
  // حافة مربعٍ آخر: الحافة اليمنى للمربع تلتصق بيسار الآخر
  const o = snapRect({ x: 68.9, y: 50, w: 30, h: 10 }, null, [{ x: 100, y: 0, w: 20, h: 20 }], 188, 90);
  assert.equal(o.rect.x + o.rect.w, 100);
  // تغيير الحجم: الحافة المسحوبة وحدها
  const r = snapRect({ x: 10, y: 10, w: 82.9, h: 10 }, 'e', [], 188, 90);
  assert.equal(r.rect.x, 10);
  assert.equal(r.rect.x + r.rect.w, 94);
});

test('القيد الحيّ: داخل اللوحة وعرض المحتوى، وحدّ أدنى، والحافة المقابلة ثابتة مع المقبض', () => {
  const lim = { bandH: 60, contentW: 188, minW: 5, minH: 5 };
  assert.deepEqual(constrainRect({ x: -10, y: -3, w: 40, h: 20 }, lim), { x: 0, y: 0, w: 40, h: 20 });
  assert.deepEqual(constrainRect({ x: 170, y: 50, w: 40, h: 20 }, lim), { x: 148, y: 40, w: 40, h: 20 });
  // أكبر من اللوحة ⇒ يُقصّ إلى حدودها
  assert.deepEqual(constrainRect({ x: 0, y: 0, w: 400, h: 400 }, lim), { x: 0, y: 0, w: 188, h: 60 });
  // NaN لا يمرّ
  const n = constrainRect({ x: Number.NaN, y: Number.POSITIVE_INFINITY, w: 20, h: 10 }, lim);
  assert.ok([n.x, n.y, n.w, n.h].every(Number.isFinite));
  // السحب من اليسار تحت الحدّ الأدنى: الحافة اليمنى (60) تبقى
  const w = constrainRect(resizeRect({ x: 20, y: 10, w: 40, h: 20 }, 'w', 50, 0), lim, 'w');
  assert.equal(w.x + w.w, 60);
  assert.equal(w.w, 5);
  // السحب من الأسفل خارج اللوحة يقف عندها
  const s = constrainRect(resizeRect({ x: 20, y: 10, w: 40, h: 20 }, 's', 0, 100), lim, 's');
  assert.deepEqual(s, { x: 20, y: 10, w: 40, h: 50 });
});

test('مقبض تغيير الحجم يغيّر العرض والارتفاع (والزاوية الشمالية الغربية تُزيح الأصل)', () => {
  assert.deepEqual(resizeRect({ x: 10, y: 10, w: 40, h: 20 }, 'se', 5, 7), { x: 10, y: 10, w: 45, h: 27 });
  assert.deepEqual(resizeRect({ x: 10, y: 10, w: 40, h: 20 }, 'nw', 5, 4), { x: 15, y: 14, w: 35, h: 16 });
  assert.deepEqual(resizeRect({ x: 10, y: 10, w: 40, h: 20 }, 'n', 99, -3), { x: 10, y: 7, w: 40, h: 23 });
  assert.deepEqual(moveRect({ x: 10, y: 10, w: 40, h: 20 }, 0.1, 0.2), { x: 10.1, y: 10.2, w: 40, h: 20 });
});

test('التذييل وحده للإجماليات والتوقيعات، وQR لا يصغر عن حدّ القراءة', () => {
  const FO = ['totals', 'signatures'] as const;
  assert.equal(bandAllows('totals', 'header', FO), false);
  assert.equal(bandAllows('signatures', 'header', FO), false);
  assert.equal(bandAllows('totals', 'footer', FO), true);
  assert.equal(bandAllows('qr', 'header', FO), true);
  assert.equal(boxMinMm('qr', 5, 47), 47);
  assert.equal(boxMinMm('qr', 5, 52.3), 52.3);
  assert.equal(boxMinMm('company', 5, 47), 5);
  const q = constrainRect({ x: 0, y: 0, w: 10, h: 10 }, { bandH: 80, contentW: 188, minW: 47, minH: 47 });
  assert.deepEqual(q, { x: 0, y: 0, w: 47, h: 47 });
});

test('لوحة المفاتيح: السهم 0.5 ملم، Shift ‏5 ملم، Alt تغيير حجم — والاتجاه ماديّ', () => {
  assert.deepEqual(keyDelta('ArrowLeft', {}), { dx: -0.5, dy: 0, resize: false });
  assert.deepEqual(keyDelta('ArrowDown', { shiftKey: true }), { dx: 0, dy: 5, resize: false });
  assert.deepEqual(keyDelta('ArrowRight', { altKey: true }), { dx: 0.5, dy: 0, resize: true });
  assert.equal(keyDelta('Enter', {}), null);
});

test('ارتفاع اللوحة: لا يقصر عن أطول مربع، ولا يتجاوز حدّه ولا مجموع 200 ملم، والمربعات تُرفع لتبقى داخلها', () => {
  const B = { headerMm: [0, 150] as const, footerMm: [0, 120] as const, bandsTotalMm: 200 };
  const c = { headerMm: 60, footerMm: 80, boxes: [{ band: 'header' as const, y: 30, h: 25 }, { band: 'footer' as const, y: 0, h: 47 }] };
  const lh = bandLimits(c, 'header', B);
  assert.deepEqual(lh, { min: 25, max: 150, other: 80, total: 200 });
  assert.equal(bandHeightFromDrag(60, -100, lh), 25);
  assert.equal(bandHeightFromDrag(60, 200, lh), 120); // 200 − 80
  assert.equal(bandHeightFromDrag(60, 10.3, lh), 70.5);
  assert.equal(bandLimits(c, 'footer', B).min, 47);
  assert.deepEqual(fitBoxesToBand(c.boxes, 'header', 40), [{ band: 'header', y: 15, h: 25 }, { band: 'footer', y: 0, h: 47 }]);
});

// ─── المؤشّر (أحداث اصطناعية) ───

const pt = (x: number, y: number, pointerId = 1): DragPoint => ({ pointerId, clientX: x, clientY: y });
function harness() {
  const log: string[] = [];
  const t = createDragTracker({
    onMove: (dx, dy) => log.push(`move ${dx},${dy}`),
    onCommit: (dx, dy) => log.push(`commit ${dx},${dy}`),
    onCancel: () => log.push('cancel'),
    onClick: () => log.push('click'),
  });
  return { t, log };
}

test('السحب يلتزم مرّةً واحدة عند الإفلات، والحركة قبله حيّة بلا التزام', () => {
  const { t, log } = harness();
  t.down(pt(100, 100));
  t.move(pt(110, 100));
  t.move(pt(130, 120));
  assert.deepEqual(log, ['move 10,0', 'move 30,20']);
  t.up(pt(131, 121));
  assert.deepEqual(log, ['move 10,0', 'move 30,20', 'commit 31,21']);
  assert.equal(t.active, false);
  // إفلاتٌ ثانٍ بلا ضغط لا يلتزم مجدداً
  t.up(pt(131, 121));
  assert.equal(log.filter((x) => x.startsWith('commit')).length, 1);
});

test('الإلغاء (pointercancel/Esc) يُرجع ولا يلتزم', () => {
  const { t, log } = harness();
  t.down(pt(0, 0));
  t.move(pt(40, 0));
  t.cancel(pt(40, 0));
  t.up(pt(40, 0));
  assert.deepEqual(log, ['move 40,0', 'cancel']);
});

test('نقرةٌ بلا حركة (ضمن 3 بكسل) تختار فقط — لا move ولا commit', () => {
  const { t, log } = harness();
  t.down(pt(50, 50));
  t.move(pt(52, 51));
  t.up(pt(52, 51));
  assert.deepEqual(log, ['click']);
  // إلغاءٌ بلا حركة لا يُرجع شيئاً
  const h2 = harness();
  h2.t.down(pt(0, 0));
  h2.t.cancel();
  assert.deepEqual(h2.log, []);
});

test('إصبعٌ ثانٍ يُتجاهل حتى ينتهي الأول، والحركات تُدمج في إطارٍ واحد (rAF)', () => {
  const queued: Array<() => void> = [];
  const log: string[] = [];
  const t = createDragTracker({ onMove: (dx, dy) => log.push(`${dx},${dy}`), onCommit: (dx) => log.push(`commit ${dx}`) }, (f) => queued.push(f));
  t.down(pt(0, 0, 1));
  t.down(pt(500, 500, 2));
  t.move(pt(10, 0, 1));
  t.move(pt(20, 0, 1));
  t.move(pt(999, 999, 2));
  t.move(pt(30, 0, 1));
  assert.equal(queued.length, 1);
  queued.shift()?.();
  assert.deepEqual(log, ['30,0']);
  t.up(pt(9, 9, 2));
  assert.equal(t.active, true);
  t.up(pt(35, 0, 1));
  assert.deepEqual(log, ['30,0', 'commit 35']);
});

// ─── الشريط الحراري ───

const roll = (): PrintProfile => withLayout(newProfile('thermal', 'رول', []), {});

test('الشريط: السحب العمودي يستدعي moveSection فقط حين تسمح canMoveSection', () => {
  const p = roll();
  const order = layoutOf(p).order;
  assert.deepEqual(order, ['header', 'info', 'customer', 'items', 'totals', 'signatures', 'qr', 'footer']);
  // العميل قبل بيانات المستند: مسموح
  const a = withSectionBefore(p, 'customer', 'info');
  assert.deepEqual(layoutOf(a).order.slice(0, 3), ['header', 'customer', 'info']);
  // الإجماليات قبل الأصناف: ممنوع ⇒ القالب نفسه
  const to = moveIndexBefore(order, 'totals', 'items');
  assert.equal(to, 3);
  assert.equal(canMoveSection(p, 'totals', to as number), false);
  assert.equal(withSectionBefore(p, 'totals', 'items'), p);
  // قبل الترويسة: ممنوع
  assert.equal(withSectionBefore(p, 'info', 'header'), p);
  // الإفلات بالمواضع المقيسة
  const blocks = order.map((sel, i) => ({ sel, top: i * 40, height: 30 }));
  const d1 = sectionDrop(p, blocks, 'totals', 10 * 1); // أعلى الشريط
  assert.equal(d1.ok, false);
  const d2 = sectionDrop(p, blocks, 'customer', 50); // بين الترويسة وبيانات المستند
  assert.equal(d2.beforeId, 'info');
  assert.equal(d2.ok, true);
  assert.equal(d2.changed, true);
  // الإفلات في الموضع نفسه ليس مخالفة
  const d3 = sectionDrop(p, blocks, 'customer', 2 * 40 + 15);
  assert.equal(d3.changed, false);
  assert.equal(d3.ok, true);
});

test('الشريط: موضع الإدراج من منتصفات الكتل', () => {
  assert.equal(indexFromY([10, 50, 90], 5), 0);
  assert.equal(indexFromY([10, 50, 90], 60), 2);
  assert.equal(indexFromY([10, 50, 90], 999), 3);
  assert.equal(moveIndexBefore(['a', 'b', 'c'] as unknown as SectionId[], 'a' as SectionId, null), 2);
  assert.equal(moveIndexBefore(['a', 'b'] as unknown as SectionId[], 'z' as SectionId, null), null);
});

test('الشريط: السحب الأفقي بعد 24 بكسل يضع المحاذاة (البداية يمين الورقة)، وأقلّ منه لا شيء', () => {
  assert.equal(alignFromDrag('center', 20, 200), null);
  // شريطٌ ضيّق: 23 بكسل تحت العتبة لا تغيّر شيئاً ولو بلغت نسبتها جهة اليمين، و24 تغيّر
  assert.equal(alignFromDrag('center', 23, 60), null);
  assert.equal(alignFromDrag('center', 24, 60), 'start');
  assert.equal(alignFromDrag('center', 40, 200), 'start'); // يميناً
  assert.equal(alignFromDrag('center', -40, 200), 'end'); // يساراً
  assert.equal(alignFromDrag('start', -70, 200), 'center');
  assert.equal(alignFromDrag('start', 30, 200), null); // يمينٌ أصلاً
  assert.equal(stepAlign('center', 'ArrowRight'), 'start');
  assert.equal(stepAlign('center', 'ArrowLeft'), 'end');
  assert.equal(stepAlign('start', 'ArrowRight'), 'start');
  assert.equal(rollAlignOf(roll(), 'items'), 'center');
});

test('الشريط: مقبض الشعار يضع logoMm ضمن الحدود (ملتقطاً 0.5)', () => {
  const B = [6, 48] as const;
  // شعارٌ يميناً: المقبض يساره، فالسحب يساراً يكبّره
  assert.equal(logoMmFromDrag(20, 'start', -PX_PER_MM * 5, PX_PER_MM, B), 25);
  assert.equal(logoMmFromDrag(20, 'end', PX_PER_MM * 5, PX_PER_MM, B), 25);
  // الموسَّط يكبر من جهتيه
  assert.equal(logoMmFromDrag(20, 'center', PX_PER_MM * 5, PX_PER_MM, B), 30);
  assert.equal(logoMmFromDrag(20, 'center', PX_PER_MM * 500, PX_PER_MM, B), 48);
  assert.equal(logoMmFromDrag(20, 'end', -PX_PER_MM * 500, PX_PER_MM, B), 6);
  assert.equal(logoMmFromDrag(20, 'end', PX_PER_MM * 1.3, PX_PER_MM, B), 21.5);
  assert.equal(logoMmStep(47.5, 1, B), 48);
  assert.equal(logoMmStep(6, -1, B), 6);
});

test('الشريط: إفلات الشعار — داخل الترويسة يعيده إليها، وفوقها «أعلى الورقة»، وتحت قسمٍ بعده', () => {
  const blocks = [
    { sel: 'header', top: 0, height: 60 }, { sel: 'logo', top: 10, height: 30 }, { sel: 'info', top: 70, height: 30 },
    { sel: 'items', top: 110, height: 80 }, { sel: 'footer', top: 200, height: 20 },
  ];
  assert.equal(logoAfterFromDrop(blocks, 30), null);
  assert.equal(logoAfterFromDrop(blocks, -5), 'top');
  assert.equal(logoAfterFromDrop(blocks, 105), 'info');
  assert.equal(logoAfterFromDrop(blocks, 999), 'footer');
  assert.deepEqual(logoPlacements(roll()).slice(0, 4), ['top', null, 'header', 'info']);
});

test('سجلّ التراجع: 50 خطوة، والمساوي لا يُكتب، والإعادة تُمحى بخطوةٍ جديدة', () => {
  let h: History<number> = { past: [], cur: 0, future: [] };
  for (let i = 1; i <= 60; i++) h = pushHistory(h, i);
  assert.equal(h.past.length, 50);
  assert.equal(h.past[0], 10);
  assert.equal(pushHistory(h, 60), h);
  h = undoHistory(undoHistory(h));
  assert.equal(h.cur, 58);
  assert.deepEqual(h.future, [59, 60]);
  h = redoHistory(h);
  assert.equal(h.cur, 59);
  h = pushHistory(h, 100);
  assert.deepEqual(h.future, []);
  const empty: History<number> = { past: [], cur: 1, future: [] };
  assert.equal(undoHistory(empty), empty);
  assert.equal(redoHistory(empty), empty);
});

// ─── حرّاس مصدرية ───

const dir = path.join(process.cwd(), 'src', 'components', 'print', 'designer');
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
const TSX = ['PrintDesigner.tsx', 'A4BandsCanvas.tsx', 'RollStrip.tsx', 'DesignInspector.tsx', 'SectionStyleFields.tsx'];
const ALL = [...TSX, 'usePointerDrag.ts', 'designerMath.ts', 'stripModel.ts'];

test('حارس: كل <button نوعه type="button" (المصمّم قد يُفتح من داخل نموذج)', () => {
  for (const f of TSX) {
    const s = read(f);
    const all = s.match(/<button\b/g)?.length ?? 0;
    const typed = s.match(/<button(?:\s+key=\{[^}]*\})?\s+type="button"/g)?.length ?? 0;
    const typed2 = s.match(/<button\s+type="button"/g)?.length ?? 0;
    assert.ok(all > 0, `${f}: بلا أزرار؟`);
    assert.equal(Math.max(typed, typed2), all, `${f}: زرٌّ بلا type="button"`);
  }
});

test('حارس: المقابض touch-action:none (اللمس لا يمرّر الصفحة)، والسحب بأحداث المؤشّر لا HTML5 DnD', () => {
  for (const f of ['A4BandsCanvas.tsx', 'RollStrip.tsx']) {
    const s = read(f);
    // الشريط: مقبض الشعار none، وكتله none متى حُدّدت وpan-y قبلها (تمرير الشريط الطويل بالإصبع — designerUx.test.ts)
    const n = (s.match(/touchAction: 'none'/g)?.length ?? 0) + (s.match(/touchAction: stripTouchAction\(isSel\)/g)?.length ?? 0);
    assert.ok(n >= 2, `${f}: مقبضٌ بلا touch-action:none`);
    assert.match(s, /onPointerDown=/);
    assert.doesNotMatch(s, /draggable|onDragStart|onDrop=/);
  }
  const hook = read('usePointerDrag.ts');
  assert.match(hook, /setPointerCapture/);
  assert.match(hook, /try \{ el\?\.setPointerCapture/);
  assert.match(hook, /pointercancel/);
  assert.match(hook, /requestAnimationFrame/);
});

test('حارس: لا مكتبة QR ولا zoom ولا filter في المصمّم، والمعاينة القالب الحقيقي داخل سياق المصمّم', () => {
  for (const f of ALL) {
    const s = read(f);
    assert.doesNotMatch(s, /from ['"]qrcode['"]|buildZatcaQr/, `${f}: استيراد QR`);
    assert.doesNotMatch(s, /\bzoom:\s*['"\d]|filter:/, `${f}: zoom/filter`);
  }
  const a4 = read('A4BandsCanvas.tsx');
  assert.match(a4, /<PrintDesignPreviewContext\.Provider value=\{ctx\}>/);
  assert.match(a4, /lookFor\(p\)/);
  assert.match(a4, /upsertBox\(p,/);
  const strip = read('RollStrip.tsx');
  assert.match(strip, /markers: true/);
  assert.match(strip, /thermalPreviewHtml\(sample, opts\)/);
  const d = read('PrintDesigner.tsx');
  assert.match(d, /role="dialog" aria-modal="true"/);
  assert.match(d, /createPortal\(body, document\.body\)/);
  assert.match(d, /beforeunload/);
});

/** ثوابت الحذف المشتركة التي يمرّرها المصمّم إلى tr() باسمها */
const SHARED_REMOVAL_CONSTS = [
  'QR_REMOVE_WARNING', 'QR_REMOVE_ACTION', 'QR_RESTORE_ACTION', 'QR_FLOW_NOTE',
  'STAMPS_LABEL', 'STAMPS_HINT', 'STAMPS_REMOVE_ACTION', 'STAMPS_RESTORE_ACTION', 'STAMPS_REMOVE_WARNING',
] as const;

/** كل tr('…') حرفيّ في ملفات المصمّم وكل ثابت عربيٍّ يُمرَّر إلى tr() */
function designerPhrases(): string[] {
  const out = new Set<string>();
  for (const f of ALL) {
    const s = read(f);
    for (const m of s.matchAll(/\btr\('([^']+)'\)/g)) out.add(m[1]);
  }
  // الثوابت التي تُمرَّر إلى tr() باسمها
  const consts = read('SectionStyleFields.tsx') + read('PrintDesigner.tsx') + read('A4BandsCanvas.tsx');
  for (const name of ['HIDE_MANDATORY_WARNING', 'DESIGNER_DISCARD_CONFIRM', 'MONO_PREVIEW_HINT']) {
    const m = consts.match(new RegExp(`export const ${name} = '([^']+)'`));
    assert.ok(m, name);
    out.add(m[1]);
  }
  // الثوابت المشتركة لحذف QR والأصناف وأختام الحالة (قرار المالك ٤ نوفمبر ٢٠٢٦) — من printSettings.ts، يمرّرها المصمّم إلى tr()
  const shared = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'print', 'printSettings.ts'), 'utf8');
  const designerSrc = ALL.map(read).join('\n');
  for (const name of [...SHARED_REMOVAL_CONSTS, 'ITEMS_REMOVE_WARNING']) {
    // ITEMS_REMOVE_WARNING يمرّ عبر complianceWarning(id) ثم tr(strong)
    if (name !== 'ITEMS_REMOVE_WARNING') assert.match(designerSrc, new RegExp(`tr\\(${name}\\)`), `${name}: لا يُمرَّر إلى tr() في المصمّم`);
    const m = shared.match(new RegExp(`export const ${name} = '([^']+)'`));
    assert.ok(m, name);
    out.add(m[1]);
  }
  const h = read('A4BandsCanvas.tsx');
  const block = h.slice(h.indexOf('const HANDLE_LABELS'), h.indexOf('/** المقاس الافتراضي'));
  for (const m of block.matchAll(/: '([^']+)'/g)) out.add(m[1]);
  return [...out];
}

test('ترجمة: كل نصّ في المصمّم له en/fr/tr/zh (الفرنسية بلا فاصلة عليا)', () => {
  const missing: string[] = [];
  for (const ar of designerPhrases()) {
    const e = (PHRASES as Record<string, { en?: string; fr?: string; tr?: string; zh?: string }>)[ar];
    if (!e || !e.en || !e.fr || !e.tr || !e.zh) { missing.push(ar); continue; }
    assert.doesNotMatch(e.fr, /'/, `فاصلة عليا في الفرنسية: ${ar}`);
  }
  assert.deepEqual(missing, [], `نصوص بلا ترجمة: ${missing.join(' | ')}`);
});

// ─── الرسم (بلا DOM: renderToStaticMarkup — المؤثّرات لا تعمل، فمواضع اللوحتين احتياطية) ───

test('الرسم: ورقة A4 بلوحةٍ بادئة — إطار كل مربع زرٌّ قابل للسحب، والمحدَّد بمقابضه الثمانية؛ والقالب الافتراضي لا يُحرَّر', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: A4BandsCanvas } = await import('./A4BandsCanvas');
  const { default: PrintDesigner } = await import('./PrintDesigner');
  const { starterCanvas, withCanvas } = await import('../../../lib/print/designModel');
  const { LEGACY_PAGE_ID } = await import('../../../lib/print/printSettings');
  const page = newProfile('page', 'صفحة', []);
  const p = withCanvas(page, starterCanvas(page));
  const boxes = layoutOf(p).canvas?.boxes ?? [];
  assert.ok(boxes.length >= 3);
  const html = renderToStaticMarkup(createElement(A4BandsCanvas, {
    p, update: () => {}, doc: 'invoice', selected: 'box:company', onSelect: () => {}, zoom: 0, phase2: true, company: null,
  }));
  for (const b of boxes) assert.match(html, new RegExp(`data-designer-box="${b.id}"`));
  assert.equal(html.match(/aria-label="تغيير الحجم/g)?.length, 8);
  assert.match(html, /touch-action:none/);
  // بلا لوحة بعد: زرّ البدء
  const fresh = renderToStaticMarkup(createElement(A4BandsCanvas, {
    p: page, update: () => {}, doc: 'invoice', selected: null, onSelect: () => {}, zoom: 0, phase2: false, company: null,
  }));
  assert.match(fresh, /ابدأ التصميم بالسحب/);
  assert.doesNotMatch(fresh, /data-designer-box=/);
  const legacy = renderToStaticMarkup(createElement(PrintDesigner, {
    profile: { ...page, id: LEGACY_PAGE_ID }, phase2: false, company: null, companyName: 'ش', brandColor: '#E15A30', onApply: () => {}, onClose: () => {},
  }));
  assert.match(legacy, /role="dialog"/);
  assert.match(legacy, /لا يعدل مباشرة/);
  assert.doesNotMatch(legacy, /تطبيق/);
});
