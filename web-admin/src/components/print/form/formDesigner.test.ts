// «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — مصمّم النموذج بلا DOM: هندسة السحب الخالصة (formCanvasMath)، ورسم
// اللوحة والمفتّش والنافذة بـrenderToStaticMarkup (المؤثّرات لا تعمل: الصورة لا تُجلب، والمقياس الاحتياطي 0.5)، وتوصيل اللوحة مصدرياً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  columnDragSpan, columnSel, fieldDragRect, fieldSel, fieldSnapOthers, formDragLimits, formTouchAction, liveSel, ptToScreenPx, reachStrips, rowMmCapped,
  rowMmFromDrag, rowMmKeyDelta, selColumn, selField, tableDragY, touchMayDrag, type FormSel,
} from './formCanvasMath';
import { PX_PER_MM } from '../designer/designerMath';
import {
  FORM_FIELD_IDS, FORM_NOTES, formOf, formPaperOf, formQrMissing, formReachBox, formSheetSize, moveFormField, printedBox, starterForm, withForm, withFormField,
  withFormProps, withoutFormField, type PrintForm,
} from '../../../lib/print/formModel';
import { isQrRemoved, layoutIssues, layoutOf, newProfile, presetPaper, withDesign, type PrintProfile } from '../../../lib/print/printSettings';
import { PHRASES } from '../../../i18n/strings';
import { withQrRemoved } from '../../../lib/print/designModel';
import FormCanvas, { formTextAlign, type FormCanvasProps } from './FormCanvas';
import FormInspector, { FORM_QR_MISSING_NOTE, clampOffsetMm } from './FormInspector';
import FormDesigner, { FORM_STEPS, initialFormStep, scrubFormImages } from './FormDesigner';
import { TaxOffPrintContext } from '../taxOffPrint';

const A4 = { widthMm: 210, lengthMm: 297 };
const IMG = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', v: 'a1b2c3d4e5f60718', wPx: 1240, hPx: 1754 };
const noop = () => {};
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/** قالب صفحة A4 بتصميم النموذج ومواضع البداية */
const formProfile = (): PrintProfile => withDesign(newProfile('page', 'نموذج', []), 'preprinted');
const withImage = (p: PrintProfile): PrintProfile => withForm(p, withFormProps(formOf(p)!, { image: IMG }));

// ─── التحديد ───

test('التحديد: حقل وعمود وجدول — والتحديد لعنصرٍ غاب (حذفٌ أو تراجع) يسقط', () => {
  assert.equal(fieldSel('docNumber'), 'field:docNumber');
  assert.equal(columnSel('qty'), 'col:qty');
  assert.equal(selField('field:totalDue'), 'totalDue');
  assert.equal(selField('col:qty'), null);
  assert.equal(selColumn('col:lineTotal'), 'lineTotal');
  assert.equal(selColumn('table'), null);
  const f = starterForm(A4);
  assert.equal(liveSel(f, 'field:docNumber'), 'field:docNumber');
  assert.equal(liveSel(f, 'field:customerVat'), null, 'حقلٌ غير موضوع');
  assert.equal(liveSel(f, 'col:qty'), 'col:qty');
  assert.equal(liveSel(f, 'col:vatPct'), null);
  assert.equal(liveSel(f, 'table'), 'table');
  assert.equal(liveSel({ ...f, table: null }, 'table'), null);
  assert.equal(liveSel({ ...f, table: null }, 'col:qty'), null);
  assert.equal(liveSel(null, 'table'), null);
  assert.equal(liveSel(withoutFormField(f, 'docNumber'), 'field:docNumber'), null);
});

// ─── سحب الحقل ───

test('سحب الحقل: النقل يلتقط الشبكة وحواف الحقول الأخرى ويبقى داخل الورقة، وتغيير الحجم لا يصغر عن 3 مم (QR ‏18)', () => {
  const f = starterForm(A4);
  const num = f.fields.find((x) => x.id === 'docNumber')!;
  const others = fieldSnapOthers(f, 'docNumber');
  assert.ok(!others.some((o) => o.x === num.x && o.y === num.y && o.w === num.w), 'الحقل نفسه ليس من خطوط الالتقاط');
  assert.ok(others.length === f.fields.length, 'الحقول الأخرى + مستطيل الجدول');
  // نقلٌ صغير: الشبكة 0.5
  const m = fieldDragRect(num, null, 10.26, 0, [], A4, 'docNumber');
  assert.equal(m.rect.x, num.x + 10.5);
  assert.equal(m.rect.y, num.y);
  // خارج الورقة يقف عند حافتها
  const out = fieldDragRect(num, null, 500, 500, [], A4, 'docNumber');
  assert.equal(out.rect.x + out.rect.w, 210);
  assert.equal(out.rect.y + out.rect.h, 297);
  // يلتصق بحافة حقلٍ آخر ضمن 1.5 مم (خطّ إرشاد)
  const snap = fieldDragRect({ x: 20, y: 20, w: 30, h: 6 }, null, 0, 0, [{ x: 51, y: 100, w: 20, h: 6 }], A4, 'docNumber');
  assert.equal(snap.rect.x + snap.rect.w, 51);
  assert.ok(snap.guides.some((g) => g.axis === 'x' && g.at === 51));
  // تغيير الحجم من الركن: لا يصغر عن الحدّ، والحافة المقابلة ثابتة
  const r = fieldDragRect({ x: 20, y: 20, w: 30, h: 6 }, 'se', -100, -100, [], A4, 'docNumber');
  assert.deepEqual(r.rect, { x: 20, y: 20, w: 3, h: 3 });
  const q = fieldDragRect({ x: 20, y: 20, w: 22, h: 22 }, 'nw', 50, 50, [], A4, 'qr');
  assert.deepEqual([q.rect.w, q.rect.h, q.rect.x + q.rect.w, q.rect.y + q.rect.h], [18, 18, 42, 42]);
});

// ─── الأعمدة ───

test('سحب العمود: النقل بعرضه يلتصق بحافة جاره، والحافتان تغيّران العرض والمقابلة ثابتة — داخل الورقة ولا يضيق عن 4 مم', () => {
  const others = [{ x: 10, w: 7 }, { x: 40, w: 20 }];
  // نقل: الحافة اليسرى قرب 17 (يمين الجار الأول) تلتصق بها
  const a = columnDragSpan({ x: 25, w: 10 }, 'move', -7.2, others, 210);
  assert.deepEqual([a.x, a.w, a.guide], [17, 10, 17]);
  // نقل: الحافة اليمنى قرب 40 تلتصق
  const b = columnDragSpan({ x: 25, w: 10 }, 'move', 4.6, others, 210);
  assert.deepEqual([b.x, b.w, b.guide], [30, 10, 40]);
  // بلا جارٍ قريب: الشبكة
  const c = columnDragSpan({ x: 100, w: 10 }, 'move', 3.3, others, 210);
  assert.deepEqual([c.x, c.guide], [103.5, null]);
  // خارج الورقة
  assert.equal(columnDragSpan({ x: 190, w: 15 }, 'move', 50, [], 210).x, 195);
  assert.equal(columnDragSpan({ x: 5, w: 15 }, 'move', -50, [], 210).x, 0);
  // الحافة اليمنى: العرض يتغيّر واليسرى ثابتة، ولا يضيق عن 4
  const e = columnDragSpan({ x: 100, w: 20 }, 'e', -30, [], 210);
  assert.deepEqual([e.x, e.w], [100, 4]);
  const e2 = columnDragSpan({ x: 100, w: 20 }, 'e', 500, [], 210);
  assert.deepEqual([e2.x, e2.w], [100, 110]);
  // الحافة اليسرى: اليمنى ثابتة (120)، وتلتصق بيمين جار
  const w = columnDragSpan({ x: 62, w: 20 }, 'w', -1.3, others, 210);
  assert.deepEqual([w.x, w.x + w.w, w.guide], [60, 82, 60]);
  const w2 = columnDragSpan({ x: 100, w: 20 }, 'w', 50, [], 210);
  assert.deepEqual([w2.x, w2.w], [116, 4]);
  for (const s of [a, b, c, e, e2, w, w2]) assert.ok([s.x, s.w].every(Number.isFinite));
  assert.ok(Number.isFinite(columnDragSpan({ x: Number.NaN, w: 10 }, 'move', Number.NaN, [], 210).x));
});

// ─── الجدول ───

test('الجدول: سحبه رأسياً يبقي صفوفه داخل الورقة، ومقبض أسفله يضبط ارتفاع الصف بجزءٍ من مئة بين 3 و25 وحتى آخر الورقة', () => {
  // 23 صفاً × 7 = 161 ⇒ أعلاه بين 0 و136
  assert.equal(tableDragY(105, 10.2, 23, 7, 297), 115);
  assert.equal(tableDragY(105, 500, 23, 7, 297), 136);
  assert.equal(tableDragY(105, -500, 23, 7, 297), 0);
  // حافة آخر صفٍّ تتبع المؤشّر: +2.3 مم على 23 صفاً = +0.1 لكل صف
  assert.equal(rowMmFromDrag(7, 23, 105, 2.3, 297), 7.1);
  assert.equal(rowMmFromDrag(7, 23, 105, -1000, 297), 3);
  // لا يتجاوز آخر صفٍّ طول الورقة: (297 − 105) / 23 = 8.347…
  assert.equal(rowMmFromDrag(7, 23, 105, 1000, 297), 8.34);
  assert.ok(105 + 23 * rowMmFromDrag(7, 23, 105, 1000, 297) <= 297);
  assert.equal(rowMmFromDrag(7, 1, 0, 1000, 297), 25, 'سقف 25 مم');
  assert.equal(rowMmKeyDelta('ArrowDown', false), 0.1);
  assert.equal(rowMmKeyDelta('ArrowUp', true), -1);
  assert.equal(rowMmKeyDelta('ArrowLeft', false), null);
});

test('الخط والمحاذاة على الشاشة: نقاط الطباعة إلى بكسل بمقياس المعاينة، وstart يمين الصندوق', () => {
  near(ptToScreenPx(11, 1), 11 * 96 / 72);
  near(ptToScreenPx(12, 0.5), 8);
  assert.ok(Number.isFinite(ptToScreenPx(11, 0)));
  assert.equal(formTextAlign(undefined), 'right');
  assert.equal(formTextAlign('start'), 'right');
  assert.equal(formTextAlign('center'), 'center');
  assert.equal(formTextAlign('end'), 'left');
  assert.equal(clampOffsetMm(25), 20);
  assert.equal(clampOffsetMm(-1.26), -1.3);
});

// ─── اللوحة مرسومةً ───

const canvasHtml = (form: PrintForm, extra: Partial<FormCanvasProps> = {}) => renderToStaticMarkup(createElement(FormCanvas, {
  form, paper: A4, onChange: noop, selected: null, onSelect: noop, zoom: 0, ...extra,
}));

test('اللوحة: الورقة بمقاسها، وصندوق كل حقلٍ زرٌّ قابل للسحب، والمحدَّد بمقابضه الثمانية، والجدول بلسانه ومقبض صفّه وأعمدته', () => {
  const f = starterForm(A4);
  const html = canvasHtml(f, { selected: 'field:docNumber' });
  // المقياس الاحتياطي 0.5 بلا قياس
  assert.match(html, new RegExp(`data-form-sheet=""[^>]*width:${210 * PX_PER_MM * 0.5}px`));
  for (const x of f.fields) assert.match(html, new RegExp(`data-form-field="${x.id}"`), x.id);
  for (const c of f.table!.columns) assert.match(html, new RegExp(`data-form-column="${c.id}"`), c.id);
  assert.equal(html.match(/aria-label="تغيير الحجم/g)?.length, 8);
  assert.match(html, /touch-action:none/);
  assert.match(html, /data-form-table=""/);
  assert.match(html, /جدول الأصناف/);
  assert.match(html, /ارتفاع الصف/);
  // موضع الحقل بالمم × المقياس
  const num = f.fields.find((x) => x.id === 'docNumber')!;
  assert.match(html, new RegExp(`data-form-field="docNumber"[^>]*left:${num.x * PX_PER_MM * 0.5}px;top:${num.y * PX_PER_MM * 0.5}px`));
  // بلا صورة: دعوة الرفع، ولا <img>
  assert.doesNotMatch(html, /data-form-image/);
  assert.match(html, /لم ترفع صورة النموذج بعد/);
  // عمودٌ محدَّد: مقبضا الحافتين
  const col = canvasHtml(f, { selected: 'col:qty' });
  assert.equal(col.match(/عرض العمود من/g)?.length, 2);
  // كل زرٍّ type="button"
  assert.equal(html.match(/<button\b/g)?.length, html.match(/<button type="button"/g)?.length);
});

test('اللوحة: وضع المعايرة يرسم المواضع المطبوعة (+ الإزاحة) متقطّعةً بلا أزرار تحرير — وإخفاء QR لشركةٍ بلا ضريبة', () => {
  const f = withFormProps(starterForm(A4), { dxMm: 2.5, dyMm: -1 });
  const html = canvasHtml(f, { mode: 'calibrate' });
  assert.match(html, /data-form-printed=""/);
  assert.doesNotMatch(html, /data-form-field=/);
  assert.doesNotMatch(html, /<button/);
  const num = f.fields.find((x) => x.id === 'docNumber')!;
  const b = printedBox(f, num);
  assert.equal(b.x, num.x + 2.5);
  assert.ok(html.includes(`left:${b.x * PX_PER_MM * 0.5}px;top:${b.y * PX_PER_MM * 0.5}px`), 'الحقل في موضعه المطبوع');
  const noQr = canvasHtml(starterForm(A4), { hideQr: true });
  assert.doesNotMatch(noQr, /data-form-field="qr"/);
  assert.match(canvasHtml(starterForm(A4)), /data-form-field="qr"/);
});

// ─── المفتّش ───

const inspectorHtml = (p: PrintProfile, selected: FormSel | null, mode: 'fields' | 'calibrate' = 'fields', taxOff = false) =>
  renderToStaticMarkup(createElement(TaxOffPrintContext.Provider, { value: taxOff },
    createElement(FormInspector, { p, update: noop, selected: selected as FormSel | null, onSelect: noop, mode, onUpload: noop })));

test('المفتّش بلا تحديد: لوحة الحقول بمجموعاتها (الموضوع بزرّ حذف)، والجدول، والصورة، وخيارات الطباعة، و«اقتراح مواضع افتراضية»', () => {
  const p = formProfile();
  const html = inspectorHtml(p, null);
  assert.match(html, /data-form-inspector="form"/);
  assert.match(html, /بيانات المستند/);
  assert.match(html, /الإجماليات/);
  assert.match(html, /اقتراح مواضع افتراضية/);
  assert.match(html, /طباعة الخلفية/);
  assert.match(html, /لغة القيم/);
  assert.match(html, /رفع صورة النموذج/);
  // الموضوع مضغوط وبجواره حذف، وغير الموضوع «+»
  assert.match(html, /aria-pressed="true"[^>]*>رقم المستند</);
  assert.match(html, /aria-pressed="false"[^>]*>.*الرقم الضريبي للعميل/);
  // «طباعة الخلفية» معطّلة بلا صورة، ومفعّلة معها
  assert.match(html, /type="checkbox"[^>]*disabled=""/);
  const withImg = inspectorHtml(withImage(p), null);
  assert.match(withImg, /صورة النموذج مرفوعة/);
  assert.match(withImg, /1240 × 1754 px/);
  assert.match(withImg, /استبدال الصورة/);
  // بلا ضريبة: لا حقول ضريبة ولا رمز في اللوحة
  const off = inspectorHtml(p, null, 'fields', true);
  assert.doesNotMatch(off, /الرقم الضريبي للعميل/);
  assert.doesNotMatch(off, />رمز QR</);
  assert.equal(html.match(/<button\b/g)?.length, html.match(/<button type="button"/g)?.length);
});

test('المفتّش: الحقل المحدَّد بموضعه ومقاسه وخطّه، والجدول بصفوفه وأعمدته، والعمود بترتيبه — والمعايرة بإزاحتيها', () => {
  const p = formProfile();
  const field = inspectorHtml(p, 'field:totalDue');
  assert.match(field, /data-form-inspector="field:totalDue"/);
  assert.match(field, /الإجمالي المستحق/);
  assert.match(field, /يطبع في الورقة الأخيرة وحدها/);
  assert.match(field, /حذف الحقل/);
  const head = inspectorHtml(p, 'field:docNumber');
  assert.match(head, /يتكرر في كل ورقة/);
  const table = inspectorHtml(p, 'table');
  assert.match(table, /data-form-inspector="table"/);
  assert.match(table, /صفوف كل ورقة/);
  assert.match(table, /data-form-columns=""/);
  assert.match(table, /value="23"/);
  assert.match(table, /حذف جدول الأصناف/);
  const col = inspectorHtml(p, 'col:sr');
  assert.match(col, /data-form-inspector="col:sr"/);
  // أيسر عمود: «انقل يساراً» معطّل
  assert.match(col, /aria-label="انقل العمود يسارا"[^>]*disabled=""/);
  const cal = inspectorHtml(p, null, 'calibrate');
  assert.match(cal, /data-form-inspector="calibrate"/);
  assert.match(cal, /إزاحة أفقية/);
  assert.match(cal, /إزاحة رأسية/);
});

test('رمز QR لازم: بلا حقله ولا حذفٍ صريح يظهر المساعد بزرّيه، و«لا أحتاج» وحده لشركةٍ بلا ضريبة — والحذف الصريح يرفع القاعدة', () => {
  const p0 = formProfile();
  assert.equal(formQrMissing(p0), false);
  const p = withForm(p0, withoutFormField(formOf(p0)!, 'qr'));
  assert.equal(formQrMissing(p), true);
  const html = inspectorHtml(p, null);
  assert.match(html, /data-form-qr-missing=""/);
  assert.ok(html.includes(FORM_QR_MISSING_NOTE));
  assert.match(html, /أضف حقل QR/);
  assert.match(html, /لا أحتاج رمز QR/);
  const off = inspectorHtml(p, null, 'fields', true);
  assert.doesNotMatch(off, /أضف حقل QR/);
  assert.match(off, /لا أحتاج رمز QR/);
  // «أضف حقل QR» = withFormField بحدّه 18 مم
  const added = withFormField(formOf(p)!, p.paper, { id: 'qr' });
  assert.ok(added.fields.find((x) => x.id === 'qr')!.w >= 18);
  // «لا أحتاج» = الحذف الصريح: القاعدة ترتفع
  const removed = withQrRemoved(p, true);
  assert.equal(isQrRemoved(layoutOf(removed)), true);
  assert.equal(formQrMissing(removed), false);
  assert.doesNotMatch(inspectorHtml(removed, null), /data-form-qr-missing/);
});

// ─── النافذة ───

test('النافذة: خطوة الرفع أولاً بلا صورة ووضع الحقول معها، والخطوات الثلاث، و«تطبيق» معطّلٌ ما دامت قاعدة النموذج غير مستوفاة', () => {
  const p = formProfile();
  assert.equal(initialFormStep(p), 1);
  assert.equal(initialFormStep(withImage(p)), 2);
  assert.deepEqual(FORM_STEPS.map((s) => s.n), [1, 2, 3]);
  const html = renderToStaticMarkup(createElement(FormDesigner, {
    profile: withImage(p), phase2: true, company: null, companyName: 'ش', onApply: noop, onClose: noop,
  }));
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /تصميم النموذج/);
  assert.match(html, /data-form-step="2"/);
  for (const s of FORM_STEPS) assert.ok(html.includes(s.label), s.label);
  assert.match(html, /data-form-sheet=""/);
  assert.match(html, /<button type="button"[^>]*class="btn-primary[^"]*"[^>]*>.*تطبيق/);
  assert.doesNotMatch(html, /role="alert"/);
  // خطوة الرفع
  const up = renderToStaticMarkup(createElement(FormDesigner, { profile: p, phase2: true, company: null, companyName: 'ش', onApply: noop, onClose: noop }));
  assert.match(up, /data-form-step="1"/);
  assert.match(up, /data-form-upload-step=""/);
  // بلا حقل QR: التنبيه، و«تطبيق» معطّل
  const bad = withForm(withImage(p), withoutFormField(formOf(withImage(p))!, 'qr'));
  const b = renderToStaticMarkup(createElement(FormDesigner, { profile: bad, phase2: true, company: null, companyName: 'ش', onApply: noop, onClose: noop }));
  assert.match(b, /role="alert"/);
  assert.match(b, /disabled=""[^>]*>(<svg[^]*?<\/svg>)?تطبيق/);
  // ليس قالب نموذج: رسالةٌ وزرّ إلغاء وحده
  const plain = renderToStaticMarkup(createElement(FormDesigner, { profile: newProfile('page', 'ص', []), phase2: true, company: null, companyName: 'ش', onApply: noop, onClose: noop }));
  assert.doesNotMatch(plain, /تطبيق/);
  assert.equal(html.match(/<button\b/g)?.length, html.match(/<button type="button"/g)?.length);
});

// ─── التوصيل في اللوحة (مصدرياً: اللوحة تستورد عميل الـAPI فلا تُحمَّل في node) ───

test('التوصيل: «تصميم النموذج» كسولاً خلف الحاجز بدل المصمّم الحرّ، وحالة النموذج وتنبيهاته، وبطاقته الرابعة بمصغّرتها', () => {
  const s = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'PrintSettingsPanel.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(s.includes("const loadFormDesigner = () => import('./form/FormDesigner');"));
  assert.ok(s.includes('lazy(loadFormDesigner)'));
  assert.doesNotMatch(s, /from '\.\/form\/FormDesigner'/, 'لا استيراد مباشر يُدخل المصمّم في حزمة اللوحة');
  assert.ok(s.includes('<FormDesigner profile={p}') && s.includes('onApply={update} onClose={() => setFormOpen(false)} />'));
  assert.ok(s.includes('<DesignerBoundary form '));
  assert.ok(s.includes("{tr('تصميم النموذج')}"));
  assert.ok(s.includes('data-form-status=""'));
  assert.ok(s.includes('formWarnings(p, { taxFree: taxOff })'));
  // المصمّم الحرّ والتخطيط وأدوات التصميم لغير النموذج وحده
  assert.ok(s.includes("{!form && <Section title={tr('التخطيط')} open><LayoutFields p={p} update={update} /></Section>}"));
  assert.ok(s.includes("{!form && (<Section title={tr('أدوات التصميم')} open>"));
  // البطاقة: مفتاحها ومصغّرتها بعلم الشركة، وورقٌ بلا طول يعطّلها
  assert.ok(s.includes('const cardKey = designCardId(c);'));
  assert.ok(s.includes('<FormThumb taxOff={taxOff} />'));
  assert.ok(s.includes("const noLength = isForm && p.paper.lengthMm === null;"));
  // كل حقل في FORM_FIELD_IDS له مكانٌ في لوحة الحقول (مجموعات النواة) — حارسٌ في formModel.test؛ هنا اللوحة لا تحذف أحداً
  assert.equal(new Set(FORM_FIELD_IDS).size, FORM_FIELD_IDS.length);
});

// ─── مراجعة: اللمس والطبقات والتداخل وارتفاع الصف وصور الجلسة ───

test('اللمس: صندوق الحقل وشريط العمود pan-y قبل التحديد (الإصبع يمرّر اللوحة) — والحقل المحدَّد none، والعمود pan-y دائماً (سحبه أفقي)', () => {
  assert.equal(formTouchAction(false), 'pan-y');
  assert.equal(formTouchAction(true), 'none');
  assert.equal(formTouchAction(true, true), 'pan-y');
  assert.equal(touchMayDrag('touch', false), false, 'إصبعٌ على غير المحدَّد: تمريرٌ أو نقرة');
  assert.equal(touchMayDrag('touch', true), true);
  assert.equal(touchMayDrag('mouse', false), true);
  assert.equal(touchMayDrag('pen', false), true);
  const f = starterForm(A4);
  const box = (html: string, attr: string) => { const at = html.indexOf(attr); return html.slice(at, html.indexOf('</button>', at)); };
  const none = canvasHtml(f);
  assert.match(box(none, 'data-form-field="docNumber"'), /touch-action:pan-y/);
  assert.match(box(none, 'data-form-column="qty"'), /touch-action:pan-y/);
  const sel = canvasHtml(f, { selected: 'field:docNumber' });
  assert.match(box(sel, 'data-form-field="docNumber"'), /touch-action:none/);
  // المقابض واللسان والمقبض none دائماً
  assert.match(box(none, 'aria-label="جدول الأصناف'), /touch-action:none/);
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'form', 'FormCanvas.tsx'), 'utf8');
  assert.ok(src.includes("if (h === null && !touchMayDrag(e.pointerType, selF === f.id)) return;"));
  assert.ok(src.includes("if (edge === 'move' && !touchMayDrag(e.pointerType, selC === c.id)) return;"));
  assert.ok(src.includes("onClick={() => { if (!isSel) onSelect(fieldSel(f.id)); }}"), 'النقرة تحدّد الحقل');
  assert.ok(src.includes("onClick={() => { if (!isSel) onSelect(columnSel(c.id)); }}"), 'والعمود');
});

test('الطبقات: غلاف الجدول بلا z-index (لا سياق تكديس) فلسان الجدول ومقبض صفّه (4) فوق الحقول (3) في سياق الورقة نفسه', () => {
  const html = canvasHtml(starterForm(A4));
  const wrap = html.slice(html.indexOf('data-form-table=""'), html.indexOf('>', html.indexOf('data-form-table=""')));
  assert.doesNotMatch(wrap, /z-index/);
  assert.match(html, /aria-label="جدول الأصناف[^"]*"[^>]*z-index:4/);
  assert.match(html, /aria-label="ارتفاع الصف[^"]*"[^>]*z-index:4/);
});

test('المعفى (hideQr): مربع QR الخفيّ لا يُحسب في التداخل — فلا تنبيه بلا سببٍ يُرى', () => {
  const f = starterForm(A4);
  const qr = f.fields.find((x) => x.id === 'qr')!;
  // حقلٌ فوق مربع QR وحده
  const onQr = withFormField(f, A4, { id: 'repName', x: qr.x, y: qr.y, w: qr.w, h: 6 });
  assert.match(canvasHtml(onQr), /بعض الحقول متداخلة/);
  const hidden = canvasHtml(onQr, { hideQr: true });
  assert.doesNotMatch(hidden, /بعض الحقول متداخلة/);
  assert.doesNotMatch(hidden, /data-form-field="qr"/);
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'form', 'FormCanvas.tsx'), 'utf8');
  assert.ok(src.includes('const others = fieldSnapOthers(shown, f.id);'), 'ولا التقاط بحوافّه');
});

test('ارتفاع الصف بالأسهم وحقل المفتّش: بحدّ ما يُبقي الصفوف كما هي (كالسحب) — لا يُنقصها بصمت', () => {
  // A4: الأعلى 105 و23 صفاً — أقصى ارتفاعٍ يتّسع 8.34
  assert.equal(rowMmCapped(8.4, 23, 105, 297), 8.34);
  assert.equal(rowMmCapped(7.1, 23, 105, 297), 7.1);
  assert.equal(rowMmCapped(2, 23, 105, 297), 3);
  assert.ok(105 + 23 * rowMmCapped(99, 23, 105, 297) <= 297);
  // النموذج على النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦): الحدّ آخر ما يبلغه الجدول (formDragLimits.bottom = طول الورقة على العادية) —
  // تحديثٌ واعٍ للحارس
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'form', 'FormCanvas.tsx'), 'utf8');
  assert.ok(src.includes('rowMm: rowMmCapped(t.rowMm + d, t.rows, t.y, lim.bottom)'));
  const insp = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'form', 'FormInspector.tsx'), 'utf8');
  assert.ok(insp.includes('clampFn={(v) => rowMmCapped(round2(clamp(v, h0, h1)), t.rows, t.y, lim.bottom)}'));
  assert.equal(formDragLimits({ dxMm: 0, dyMm: 0 }, A4).bottom, 297, 'العادية: آخر الورقة كما كان');
});

test('صور الجلسة عند سقف الشركة: المحذوفة من الخادم تُمحى من سجلّ التراجع كله (القالب يعود بلا صورة) — والباقي كما هو', () => {
  const IMG2 = { ...IMG, id: '1f8fad5b-d9cb-469f-a165-70867728950e', v: 'b1b2c3d4e5f60718' };
  const a = withImage(formProfile());
  const b = withForm(a, withFormProps(formOf(a)!, { image: IMG2 }));
  const h = { past: [formProfile(), a], cur: b, future: [a] };
  const out = scrubFormImages(h, new Set([IMG.id]));
  assert.equal(formOf(out.past[1])!.image, null);
  assert.equal(formOf(out.future[0])!.image, null);
  assert.deepEqual(formOf(out.cur)!.image, IMG2);
  assert.equal(out.past[0], h.past[0], 'ما لا يشير إليها كما هو');
  assert.equal(scrubFormImages(h, new Set()), h);
  // التوصيل: خطوة الرفع تعيد المحاولة مرّة بعد تحرير صور الجلسة، والإغلاق بصورةٍ مختارة لم تُرفع يؤكّد
  const d = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'form', 'FormDesigner.tsx'), 'utf8');
  assert.ok(d.includes('onPendingChange={setUploadPending} onLimit={freeUploads}'));
  assert.ok(d.includes('if ((dirty || (step === 1 && uploadPending)) && !window.confirm(tr(FORM_DISCARD_CONFIRM))) return;'));
  const u = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'form', 'FormUploadStep.tsx'), 'utf8');
  assert.ok(u.includes("if (formUploadErrorCode(err) !== 'limit' || !onLimit || !mounted.current || !(await onLimit()) || !mounted.current) throw err;"));
  assert.ok(u.includes('useEffect(() => { pendingRef.current?.(!!src); }, [src]);'));
});

// ─── النموذج على الطابعة النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦، Tally Dascom MIP480) ───

/** قالب نقطي بتصميم النموذج ومواضع البداية — A4 متصل (ff_a4) افتراضاً، أو مقاسٌ نقطيٌّ آخر */
const impactProfile = (preset: 'ff_a4' | 'cut_a4' | 'ff_95x11' = 'ff_a4'): PrintProfile =>
  withDesign({ ...newProfile('impact', 'نقطي', []), paper: presetPaper(preset)! }, 'preprinted');

test('النقطية: حدود السحب ما تبلغه الإبرة من المواضع المحفوظة (بعد المعايرة) على الشبكة للداخل، والشرائط ما خارجه — والعادية الورقة كلها بلا شرائط', () => {
  const paper = formPaperOf(impactProfile());
  assert.ok(paper.reach, 'ورق النقطية يحمل reach');
  const lim = formDragLimits({ dxMm: 0, dyMm: 0 }, paper);
  // A4 على 1440 نقطة: الإبرة من 3.4 إلى 206.6 مم — والشبكة للداخل 3.5..206.5
  assert.deepEqual([lim.x0, lim.x1, lim.y0, lim.y1, lim.bottom, lim.qrMinMm], [3.5, 206.5, 0, 297, 297, 55]);
  near(lim.box!.x, 3.4);
  near(lim.box!.x + lim.box!.w, 206.6);
  // المعايرة dx = +2: ما يُحفظ يُطبع أبعد 2 مم يميناً فيزيح ما تبلغه المواضع المحفوظة يساراً؛ وdy = −3 يحجب أعلى 3 مم
  const cal = formDragLimits({ dxMm: 2, dyMm: -3 }, paper);
  assert.deepEqual([cal.x0, cal.x1, cal.y0, cal.y1, cal.bottom], [1.5, 204.5, 3, 297, 297]);
  const S = formSheetSize(paper);
  const strips = reachStrips(formReachBox({ dxMm: 2, dyMm: -3 }, paper), S);
  assert.deepEqual(strips.map((s) => s.side), ['left', 'right', 'top']);
  near(strips[0].w, 1.4);
  near(strips[1].x, 204.6);
  near(strips[1].w, 5.4);
  near(strips[2].h, 3);
  // dy = +4: آخر 4 مم من المواضع المحفوظة تُطبع خارج الورقة
  const down = reachStrips(formReachBox({ dxMm: 0, dyMm: 4 }, paper), S);
  assert.ok(down.some((s) => s.side === 'bottom' && Math.abs(s.y - 293) < 1e-9 && Math.abs(s.h - 4) < 1e-9));
  assert.equal(formDragLimits({ dxMm: 0, dyMm: 4 }, paper).bottom, 293);
  // 241 مم: نحو 19 مم من كل جانب
  const wide = formDragLimits({ dxMm: 0, dyMm: 0 }, formPaperOf(impactProfile('ff_95x11')));
  assert.deepEqual([wide.x0, wide.x1], [19, 222]);
  // العادية: الورقة كلها كما كانت ولا شرائط
  assert.deepEqual(formDragLimits({ dxMm: 5, dyMm: 5 }, A4), { x0: 0, x1: 210, y0: 0, y1: 297, bottom: 297, box: null, qrMinMm: 18 });
  assert.deepEqual(reachStrips(null, A4), []);
  assert.deepEqual(reachStrips({ x: 0, y: 0, w: 210, h: 297 }, A4), [], 'الحزمة بعرض الورقة: لا شريط');
});

test('النقطية: السحب الحيّ داخل ما تبلغه الإبرة (وحافّتاه خطّا التقاط) ومربع QR لا يصغر عن 55 — والعمود والجدول ومقبض الصف كذلك، والعادية كما كانت حرفاً', () => {
  const paper = formPaperOf(impactProfile());
  const lim = formDragLimits({ dxMm: 0, dyMm: -3 }, paper);
  const start = { x: 20, y: 20, w: 30, h: 6 };
  const left = fieldDragRect(start, null, -100, -100, [], A4, 'docNumber', lim);
  assert.deepEqual([left.rect.x, left.rect.y], [3.5, 3], 'يقف عند أول ما تبلغه الإبرة لا عند حافة الورقة');
  const right = fieldDragRect(start, null, 500, 500, [], A4, 'docNumber', lim);
  assert.deepEqual([right.rect.x + right.rect.w, right.rect.y + right.rect.h], [206.5, 297]);
  const snap = fieldDragRect({ x: 4.6, y: 50, w: 30, h: 6 }, null, 0, 0, [], A4, 'docNumber', lim);
  assert.equal(snap.rect.x, 3.5);
  assert.ok(snap.guides.some((g) => g.axis === 'x' && g.at === 3.5), 'خطّ إرشادٍ عند حافة ما تبلغه الإبرة');
  const q = fieldDragRect({ x: 20, y: 200, w: 55, h: 55 }, 'nw', 30, 30, [], A4, 'qr', lim);
  assert.deepEqual([q.rect.w, q.rect.h, q.rect.x + q.rect.w, q.rect.y + q.rect.h], [55, 55, 75, 255], 'QR ‏55 والحافة المقابلة ثابتة');
  // العادية: حدود الورقة كلها ⇒ القيد نفسه حرفاً كما بلا حدود (و QR ‏18)
  const pageLim = formDragLimits({ dxMm: 0, dyMm: 0 }, A4);
  for (const [s, h, dx, dy, id] of [
    [start, null, -100, -100, 'docNumber'], [start, null, 500, 500, 'docNumber'], [{ x: 20, y: 20, w: 22, h: 22 }, 'nw', 50, 50, 'qr'],
    [{ x: 51.2, y: 20, w: 30, h: 6 }, 'e', 3.3, 0, 'docNumber'],
  ] as const) {
    assert.deepEqual(fieldDragRect(s, h, dx, dy, [], A4, id, pageLim), fieldDragRect(s, h, dx, dy, [], A4, id));
  }
  // العمود: داخل [3.5، 206.5]، وحافّتا ما تبلغه الإبرة خطّا التقاط
  assert.equal(columnDragSpan({ x: 10, w: 15 }, 'move', -50, [], lim).x, 3.5);
  assert.equal(columnDragSpan({ x: 190, w: 15 }, 'move', 50, [], lim).x, 191.5);
  const e = columnDragSpan({ x: 180, w: 20 }, 'e', 100, [], lim);
  assert.equal(e.x + e.w, 206.5);
  const w = columnDragSpan({ x: 20, w: 20 }, 'w', -15.8, [], lim);
  assert.deepEqual([w.x, w.guide], [3.5, 3.5]);
  assert.deepEqual(columnDragSpan({ x: 100, w: 20 }, 'move', 3.3, [], { x0: 0, x1: 210 }), columnDragSpan({ x: 100, w: 20 }, 'move', 3.3, [], 210));
  // الجدول: أعلاه لا يعلو أول ما تبلغه الإبرة بعد المعايرة، ولا يتجاوز آخره آخرَها
  assert.equal(tableDragY(105, -500, 16, 7, lim.bottom, lim.y0), 3);
  assert.equal(tableDragY(105, 500, 16, 7, lim.bottom, lim.y0), 185);
  const low = formDragLimits({ dxMm: 0, dyMm: 4 }, paper);
  assert.ok(105 + 16 * rowMmFromDrag(7, 16, 105, 1000, low.bottom) <= 293);
  // الأسهم: محرّرات formModel على ورق النقطية تقصّ داخل ما تبلغه الإبرة أيضاً
  const f = formOf(impactProfile())!;
  const num = f.fields.find((x) => x.id === 'docNumber')!;
  const moved = moveFormField(f, paper, 'docNumber', -500, 0).fields.find((x) => x.id === 'docNumber')!;
  assert.equal(moved.x, 3.5);
  assert.equal(moved.y, num.y);
});

test('النقطية: اللوحة ترسم شرائط «لا تبلغه الطابعة النقطية» بلا تفاعل تحت الحقول — في التحرير بالمواضع المحفوظة وفي المعايرة بالمطبوعة — ومفتاحها تحتها', () => {
  const p = impactProfile('ff_95x11');
  const paper = formPaperOf(p);
  const f = withFormProps(formOf(p)!, { dyMm: -2 });
  const html = canvasHtml(f, { paper });
  for (const side of ['left', 'right', 'top']) assert.match(html, new RegExp(`data-form-reach-strip="${side}"`), side);
  assert.doesNotMatch(html, /data-form-reach-strip="bottom"/);
  assert.match(html, /data-form-reach-legend=""[^>]*>.*لا تبلغه الطابعة النقطية/);
  const tag = (attr: string) => { const at = html.indexOf(attr); return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at)); };
  const strip = tag('data-form-reach-strip="left"');
  assert.match(strip, /aria-hidden="true"/);
  assert.match(strip, /pointer-events:none/);
  assert.match(strip, /z-index:1/, 'تحت الجدول (2) والحقول (3)');
  // الشريط الأيسر بعرض ما قبل الحزمة (18.9 مم على 241) — مقياس 0.5 الاحتياطي، وتسميته داخله (يتّسع)
  const box = formReachBox(f, paper)!;
  assert.ok(strip.includes(`width:${box.x * PX_PER_MM * 0.5}px`));
  const leftStrip = html.slice(html.indexOf('data-form-reach-strip="left"'), html.indexOf('</div>', html.indexOf('data-form-reach-strip="left"')));
  assert.match(leftStrip, /writing-mode:vertical-rl[^>]*>لا تبلغه الطابعة النقطية/);
  // الحقول كلها داخل ما تبلغه الإبرة (القصّ في formModel)
  for (const x of f.fields) assert.ok(x.x >= box.x - 1e-9 && x.x + x.w <= box.x + box.w + 1e-9 && x.y >= box.y - 1e-9, x.id);
  // المعايرة: المطبوعة (+ dx/dy) — خارج [x0, x1] وحده، بطول الورقة
  const cal = canvasHtml(f, { paper, mode: 'calibrate' });
  assert.match(cal, /data-form-reach-strip="left"/);
  assert.match(cal, /data-form-reach-strip="right"/);
  assert.doesNotMatch(cal, /data-form-reach-strip="top"/);
  assert.match(cal, /data-form-reach-legend=""/);
  // العادية: لا شرائط ولا مفتاح
  assert.doesNotMatch(canvasHtml(starterForm(A4)), /data-form-reach-strip|data-form-reach-legend/);
  // التوصيل: المصمّم يمرّر ورق النموذج (formPaperOf) إلى اللوحة والرفع، واللوحة تقيّد السحب بحدودها
  const d = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'form', 'FormDesigner.tsx'), 'utf8');
  assert.ok(d.includes('const paper = useMemo(() => formPaperOf({ printer: p.printer, paper: p.paper }), [p.printer, p.paper]);'));
  assert.ok(d.includes('<FormCanvas form={form} paper={paper}') && d.includes('<FormUploadStep paper={paper}'));
  const c = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'form', 'FormCanvas.tsx'), 'utf8');
  for (const frag of [
    'others, sheet, f.id, lim)', 'others, lim)', 'tableDragY(t.y, dy / PX_PER_MM / scale, t.rows, t.rowMm, lim.bottom, lim.y0)',
    'rowMmFromDrag(t.rowMm, t.rows, t.y, dy / PX_PER_MM / scale, lim.bottom)',
  ]) assert.ok(c.includes(frag), frag);
});

test('النقطية: المفتّش بحدّ QR ‏55 وتلميحه، و«طباعة الخلفية» مخفيّةٌ بملاحظتها، وملاحظتا المعايرة والورق المقطع، ومعايرة النقطية بخطواتها', () => {
  const p = withImage(impactProfile('cut_a4'));
  assert.deepEqual(layoutIssues(p, 'p'), [], 'مواضع البداية صالحةٌ صارماً');
  const qr = inspectorHtml(p, 'field:qr');
  assert.ok(qr.includes('لا يصغر مربع رمز QR عن 55 ملم على الطابعة النقطية'));
  assert.ok(!qr.includes('لا يصغر مربع رمز QR عن 18 ملم'));
  assert.match(qr, /data-form-qr-min="55"/);
  const pageQr = inspectorHtml(formProfile(), 'field:qr');
  assert.ok(pageQr.includes('لا يصغر مربع رمز QR عن 18 ملم') && !pageQr.includes('55 ملم'));
  assert.match(pageQr, /data-form-qr-min="18"/);
  // الخلفية: لا مفتاح على النقطية (ولو بصورة) — ملاحظةٌ مكانه؛ والعادية كما كانت
  const html = inspectorHtml(p, null);
  assert.ok(!html.includes('طباعة الخلفية'));
  assert.match(html, /data-form-bg-impact=""[^>]*>الطابعة النقطية تطبع القيم وحدها بلا خلفية/);
  assert.match(inspectorHtml(withImage(formProfile()), null), /طباعة الخلفية/);
  assert.doesNotMatch(inspectorHtml(withImage(formProfile()), null), /data-form-bg-impact/);
  // ملاحظتا النقطية (formWarnings): «صفحة معايرة» قبل أول فاتورة، والورق المقطع ينصح بالمتصل للفواتير الطويلة (قرار المالك س٢)
  assert.ok(html.includes(FORM_NOTES.impactCalibrate));
  assert.ok(html.includes(FORM_NOTES.impactCutSheet));
  const cont = inspectorHtml(withImage(impactProfile('ff_a4')), null);
  assert.ok(cont.includes(FORM_NOTES.impactCalibrate) && !cont.includes(FORM_NOTES.impactCutSheet), 'المتصل بلا نصيحة');
  // «أضف حقل QR» على النقطية: داخل ما تبلغه الإبرة بحدّه 55
  const noQr = withForm(p, withoutFormField(formOf(p)!, 'qr'));
  assert.match(inspectorHtml(noQr, null), /أضف حقل QR/);
  const added = withFormField(formOf(noQr)!, formPaperOf(noQr), { id: 'qr' }).fields.find((x) => x.id === 'qr')!;
  assert.deepEqual([added.w, added.h], [55, 55]);
  const insp = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'form', 'FormInspector.tsx'), 'utf8');
  assert.ok(insp.includes("withFormField(form, formPaperOf(p), { id: 'qr' })"));
  assert.doesNotMatch(insp, /p\.paper\b/, 'كل محرّرٍ في المفتّش على ورق النموذج (formPaperOf)');
  // المعايرة على النقطية: ورق النموذج محمّلاً كالفواتير وإشارة الإزاحة — و«100%» لنافذة الطباعة وحدها (مشغّل ويندوز؛ البلوتوث يرسم
  // النقاط بمقاسها) لا سطر الطابعة العادية المطلق
  const cal = inspectorHtml(p, null, 'calibrate');
  assert.match(cal, /data-form-calibrate-impact=""/);
  for (const line of [
    'طبّق التصميم ثم اطبع «صفحة معايرة» من «الطباعة على هذا الجهاز» على ورق النموذج محمّلاً كما ستطبع الفواتير',
    'إن طبعت من نافذة الطباعة (مشغّل ويندوز) فاطبعها بالحجم الفعلي 100% دون ملاءمة الصفحة',
    'قس بالمسطرة كم تبعد الإطارات المتقطعة عن فراغات النموذج ثم أدخل الإزاحة هنا',
    'إن نزلت كل المواضع عن فراغاتها فاجعل الإزاحة الرأسية بالسالب، وإن انزاحت يميناً فاجعل الأفقية بالسالب',
  ]) assert.ok(cal.includes(line), line);
  assert.ok(!cal.includes('اطبع بالحجم الفعلي 100% دون ملاءمة الصفحة') && !cal.includes('على ورقك المطبوع مسبقا'));
  assert.match(cal, /إزاحة أفقية/);
  const pageCal = inspectorHtml(formProfile(), null, 'calibrate');
  assert.ok(pageCal.includes('اطبع بالحجم الفعلي 100% دون ملاءمة الصفحة') && !pageCal.includes('data-form-calibrate-impact'));
  assert.ok(!pageCal.includes('مشغّل ويندوز'), 'العادية بخطواتها كما كانت');
});

test('الخط العريض للقالب (options.boldBody — افتراضيٌّ للنقطية): اللوحة ترسم القيم عريضةً كالورقة، وشريحة الحقل مضغوطةٌ معطّلة بملاحظتها، و«الخط» ظاهرٌ للنموذج ليُطفأ', () => {
  const imp = withImage(impactProfile());
  assert.equal(imp.options.boldBody, true, 'النقطية عريضةٌ افتراضاً (والورقة data-print-look="bold")');
  const f = formOf(imp)!;
  // وزن نصّ القيمة في صندوقها (valueText) وحده — لا أوزان عناصر الواجهة الأخرى
  const weights = (html: string) => [...html.matchAll(/font-size:[0-9.]+px;font-weight:(\d+);text-align/g)].map((m) => m[1]);
  // اللوحة: كل قيمةٍ عريضة مع boldAll (في التحرير والمعايرة)، وبدونه العريض لما عُلّم وحده كما كان
  for (const mode of ['edit', 'calibrate'] as const) {
    const all = canvasHtml(f, { paper: formPaperOf(imp), boldAll: true, mode });
    assert.ok(weights(all).length >= f.fields.length && !weights(all).includes('400'), `${mode}: قيمةٌ عادية على الشاشة وتُطبع عريضة`);
  }
  const sf = starterForm(A4);
  const bolds = (x: PrintForm) => x.fields.filter((y) => y.bold === true).length;
  const page = canvasHtml(sf);
  assert.ok(weights(page).includes('400'));
  assert.equal(weights(page).filter((w) => w === '700').length, bolds(sf), 'العادية كما كانت: العريض ما عُلّم وحده');
  const one = withFormField(sf, A4, { id: 'docNumber', bold: true });
  assert.equal(weights(canvasHtml(one)).filter((w) => w === '700').length, bolds(one));
  // المفتّش: الشريحة مضغوطةٌ معطّلة «عريض» وملاحظةٌ تدلّ على مفتاح القالب — والعادية (boldBody false) قابلةٌ للضغط كما كانت
  const chip = (html: string) => { const at = html.indexOf('<svg', html.indexOf('خط عريض')); return html.slice(html.lastIndexOf('<button', at), at); };
  const impField = inspectorHtml(imp, 'field:customerName');
  assert.match(chip(impField), /aria-pressed="true"/);
  assert.match(chip(impField), /disabled=""/);
  assert.match(impField, /data-form-bold-all=""[^>]*>كل القيم تطبع بخط عريض من «خط عريض للنص» في إعدادات القالب/);
  const pageField = inspectorHtml(formProfile(), 'field:customerName');
  assert.equal(formProfile().options.boldBody, false);
  assert.match(chip(pageField), /aria-pressed="false"/);
  assert.doesNotMatch(chip(pageField), /disabled=""/);
  assert.doesNotMatch(pageField, /data-form-bold-all/);
  // النافذة تمرّر الخيار إلى اللوحة، ولوحة الإعدادات تُظهر «الخط» (مفتاح «خط عريض للنص») لقالب النموذج كذلك
  const designer = renderToStaticMarkup(createElement(FormDesigner, { profile: imp, phase2: true, company: null, companyName: 'ش', onApply: noop, onClose: noop }));
  assert.ok(!weights(designer.slice(designer.indexOf('data-form-field='))).includes('400'), 'نافذة المصمّم بالوزن المطبوع');
  const d = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'form', 'FormDesigner.tsx'), 'utf8');
  assert.ok(d.includes('boldAll={p.options.boldBody === true}'));
  const s = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'print', 'PrintSettingsPanel.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!s.includes("{!form && (<Section title={tr('الخط')}>"), '«الخط» مخفيٌّ عن النموذج');
  assert.ok(s.includes("              <Section title={tr('الخط')}>\n"));
  assert.ok(s.includes("<Toggle label={tr('خط عريض للنص')} checked={p.options.boldBody} onChange={(v) => setOpt('boldBody', v)} />"));
});

test('النقطية: نافذة المصمّم بقالبٍ نقطي — الشرائط في وضع الحقول والمعايرة، و«تطبيق» متاحٌ بمواضع البداية', () => {
  const p = withImage(impactProfile());
  const html = renderToStaticMarkup(createElement(FormDesigner, { profile: p, phase2: true, company: null, companyName: 'ش', onApply: noop, onClose: noop }));
  assert.match(html, /data-form-step="2"/);
  assert.match(html, /data-form-reach-strip="left"/);
  assert.match(html, /data-form-reach-legend=""/);
  assert.doesNotMatch(html, /role="alert"/, 'لا قاعدة مخالفة');
  assert.match(html, /<button type="button"[^>]*class="btn-primary[^"]*"[^>]*>.*تطبيق/);
  assert.doesNotMatch(html, /طباعة الخلفية/);
});

test('الترجمة: كل tr(\'…\') في ملفات مصمّم النموذج لها en/fr/tr/zh — وعبارات النقطية الجديدة فيها بلا فاصلة علوية في الفرنسية', () => {
  const dir = path.join(process.cwd(), 'src', 'components', 'print', 'form');
  const want = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((x) => /\.tsx?$/.test(x) && !x.endsWith('.test.ts'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) want.add(m[1]);
  }
  const impact = [
    'لا تبلغه الطابعة النقطية', 'لا يصغر مربع رمز QR عن 55 ملم على الطابعة النقطية', 'الطابعة النقطية تطبع القيم وحدها بلا خلفية',
    'طبّق التصميم ثم اطبع «صفحة معايرة» من «الطباعة على هذا الجهاز» على ورق النموذج محمّلاً كما ستطبع الفواتير',
    'إن نزلت كل المواضع عن فراغاتها فاجعل الإزاحة الرأسية بالسالب، وإن انزاحت يميناً فاجعل الأفقية بالسالب',
    'إن طبعت من نافذة الطباعة (مشغّل ويندوز) فاطبعها بالحجم الفعلي 100% دون ملاءمة الصفحة',
    'كل القيم تطبع بخط عريض من «خط عريض للنص» في إعدادات القالب',
    'يصحح النظام الميل ويقص الورقة إلى مقاس القالب {w} × {h} مم ({px} بكسل) — والصورة دليل للتصميم على الشاشة وحدها',
  ];
  for (const k of impact) assert.ok(want.has(k), `مستعملة: ${k}`);
  const missing: string[] = [];
  for (const ar of want) {
    if (!/[؀-ۿ]/.test(ar)) continue;
    const t = PHRASES[ar];
    if (!t) { missing.push(ar); continue; }
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${ar}» ${lang}`);
  }
  assert.deepEqual(missing, []);
  for (const k of [...impact, FORM_NOTES.impactCalibrate, FORM_NOTES.impactCutSheet]) assert.ok(PHRASES[k] && !/['’]/.test(PHRASES[k].fr), `«${k}» فرنسية بفاصلة علوية`);
});
