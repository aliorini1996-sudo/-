// صفحة معايرة «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦): @page بمقاس الورق بلا هامش، ومربعٌ متقطّع لكل حقلٍ
// باسمه في موضعه بعد الإزاحة، وجدول الأصناف بحدود صفوفه وأعمدته، ومسطرتان على الحافتين بلا إزاحة، والعنوان بقيمتي الإزاحة —
// وبلا صورةٍ ولا رمزٍ ولا قيم، ولشركةٍ بلا ضريبة بلا حقول الضريبة وعمودها ومربع الرمز. وتوصيلها في «طباعة صفحة معايرة».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FORM_CALIBRATION_TEXTS, buildFormCalibration, calibrationInfoSpot, signedMm } from './formCalibration';
import {
  FORM_COLUMN_LABELS, FORM_FIELD_LABELS, fitForm, formOf, formTableBox, printedBox, tableRowTop, withFormField, withFormProps, withFormTable,
  type PrintForm,
} from './formModel';
import { defaultPrintOptions, presetPaper, withDesign, type PrintProfile } from './printSettings';
import { firstTaxMention } from './taxFreePrint';
import { PHRASES } from '../../i18n/strings';

const tr = (s: string) => s;
const base = (preset: 'a4' | 'a5' | 'letter' = 'a4'): PrintProfile =>
  ({ id: 'form-1', name: 'نموذج', printer: 'page', template: 'page_branded', paper: presetPaper(preset)!, options: defaultPrintOptions('page') });
const formProfile = (preset: 'a4' | 'a5' | 'letter' = 'a4'): PrintProfile => withDesign(base(preset), 'preprinted');
const withForm = (p: PrintProfile, f: PrintForm): PrintProfile => ({ ...p, options: { ...p.options, layout: { ...p.options.layout!, form: f } } });
const r2 = (n: number) => Math.round(n * 100) / 100;
const style = (b: { x: number; y: number; w: number; h: number }) => `left:${r2(b.x)}mm;top:${r2(b.y)}mm;width:${r2(b.w)}mm;height:${r2(b.h)}mm`;

test('المعايرة: @page بمقاس الورق بالمم بلا هامش، وورقةٌ واحدة أقصر من الصفحة بنصف مم', () => {
  const p = formProfile();
  assert.equal(p.options.layout?.design, 'preprinted', 'withDesign لم يضع تصميم النموذج');
  const h = buildFormCalibration(p, tr, { name: 'ورق مروج' });
  assert.ok(h.includes('@page { size: 210mm 297mm; margin: 0; }'));
  assert.ok(h.includes('.sheet { position: relative; width: 210mm; height: 296.5mm; overflow: hidden; }'));
  assert.equal(h.split('<section class="sheet"').length - 1, 1);
  const a5 = buildFormCalibration(formProfile('a5'), tr);
  assert.ok(a5.includes('@page { size: 148mm 210mm; margin: 0; }'));
  assert.ok(a5.includes('width: 148mm; height: 209.5mm;'));
  // العنوان واسم القالب
  assert.ok(h.includes(`<div class="h">${FORM_CALIBRATION_TEXTS.title} — ورق مروج</div>`));
});

test('المعايرة: مربعٌ متقطّع لكل حقلٍ باسمه في موضعه بعد الإزاحة (printedBox)', () => {
  const p0 = formProfile();
  const f0 = formOf(p0)!;
  const shifted = withFormProps(f0, { dxMm: 1.5, dyMm: -2 });
  const p = withForm(p0, shifted);
  const h = buildFormCalibration(p, tr);
  assert.ok(shifted.fields.length >= 10);
  for (const f of shifted.fields) {
    const b = printedBox(shifted, f);
    assert.ok(h.includes(`<div class="f" data-field="${f.id}" style="${style(b)}"><span>${FORM_FIELD_LABELS[f.id]}</span></div>`), f.id);
    assert.equal(b.x, r2(f.x + 1.5));
    assert.equal(b.y, r2(f.y - 2));
  }
  assert.equal(h.split('class="f"').length - 1, shifted.fields.length);
  assert.ok(h.includes('<span dir="ltr">dx +1.5 mm · dy -2.0 mm</span>'), 'قيمتا الإزاحة في العنوان');
  // بلا إزاحة: الموضع المحفوظ نفسه
  const h0 = buildFormCalibration(p0, tr);
  const doc = f0.fields.find((x) => x.id === 'docNumber')!;
  assert.ok(h0.includes(`data-field="docNumber" style="${style(doc)}"`));
  assert.ok(h0.includes('dx 0.0 mm · dy 0.0 mm'));
});

test('المعايرة: جدول الأصناف — شريطٌ متقطّع لكل عمودٍ باسمه وخطّ عند حدّ كل صفّ ورقمه، بالإزاحة نفسها', () => {
  const p0 = formProfile();
  const form = withFormProps(withFormTable(formOf(p0)!, p0.paper, { rows: 10, rowMm: 8 }), { dxMm: -0.5, dyMm: 3 });
  const p = withForm(p0, form);
  const t = form.table!;
  const box = formTableBox(t)!;
  const h = buildFormCalibration(p, tr);
  for (const c of t.columns) {
    const cb = printedBox(form, { x: c.x, y: t.y, w: c.w, h: box.h });
    assert.ok(h.includes(`<div class="c" data-column="${c.id}" style="${style(cb)}"><span>${FORM_COLUMN_LABELS[c.id]}</span></div>`), c.id);
  }
  assert.equal(h.split('data-row-line=').length - 1, t.rows + 1, 'حدّ كل صفّ وأسفل الأخير');
  const tb = printedBox(form, box);
  for (const i of [0, 4, t.rows]) {
    const y = r2(tableRowTop(t, i) + 3);
    assert.ok(h.includes(`<i class="r" data-row-line="${i}" style="left:${r2(tb.x)}mm;top:${y}mm;width:${r2(tb.w)}mm"></i>`), `الصفّ ${i}`);
  }
  assert.equal(h.split('class="rn"').length - 1, t.rows, 'رقم كل صفّ');
  assert.ok(h.includes(`${FORM_CALIBRATION_TEXTS.table}: <span dir="ltr">10 × 8 mm</span>`));
});

test('المعايرة: مسطرتان على الحافتين العليا واليسرى بلا إزاحة — علامة كل مم ورقم كل 10', () => {
  const p0 = formProfile();
  const p = withForm(p0, withFormProps(formOf(p0)!, { dxMm: 5, dyMm: 5 }));
  const h = buildFormCalibration(p, tr);
  // 211 علامة أفقية (0..210) و296 رأسية (1..296)
  assert.equal(h.split('<i class="t"').length - 1, 211 + 296);
  assert.ok(h.includes('<i class="t" style="left:10mm;top:0;width:0.2mm;height:6mm"></i>'), 'علامة 10 من الحافة اليسرى بلا إزاحة');
  assert.ok(h.includes('<i class="t" style="left:5mm;top:0;width:0.2mm;height:4mm"></i>'));
  assert.ok(h.includes('<i class="t" style="left:0;top:20mm;width:6mm;height:0.2mm"></i>'), 'علامة 20 من الحافة العليا بلا إزاحة');
  for (const n of [10, 100, 200]) assert.ok(h.includes(`<b class="n" style="left:${n}mm;top:6.6mm;transform:translateX(-50%)">${n}</b>`), `أفقي ${n}`);
  for (const n of [10, 150, 290]) assert.ok(h.includes(`<b class="n" style="left:6.6mm;top:${n}mm;transform:translateY(-50%)">${n}</b>`), `رأسي ${n}`);
  assert.ok(!h.includes('left:210mm;top:6.6mm') && !h.includes('>0</b>') && !h.includes('top:296mm;transform'), 'لا رقم على الطرفين');
});

test('المعايرة: بلا صورة النموذج ولا رمز QR ولا قيمة — وحقل الرمز مربعٌ متقطّع كغيره', () => {
  const p0 = formProfile();
  const form = withFormProps(formOf(p0)!, { image: { id: '0d9f5b9e-3f7a-4c1e-9d5a-2b6c8e1f4a70', v: '0123456789abcdef', wPx: 1240, hPx: 1754 }, background: true });
  const h = buildFormCalibration(withForm(p0, form), tr);
  assert.ok(!/<img|data-qr-value|<svg|url\(/.test(h), 'لا صورة ولا رمز في صفحة المعايرة');
  assert.ok(h.includes('data-field="qr"'));
  assert.ok(!h.includes('TEST-0001') && !h.includes('عميل تجريبي'), 'لا قيم مستندٍ نموذجي');
  // المصدر نفسه: لا مكتبة رمز ولا بناء رمز
  const src = fs.readFileSync(new URL('./formCalibration.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /qrcode|QRCode|buildZatcaQr|toDataURL|data-qr-value/);
});

test('المعايرة بلا ضريبة: لا حقول الضريبة ولا عمودها ولا مربع الرمز — ولا عبارةٍ ضريبية في الورقة', () => {
  const p0 = formProfile();
  let form = formOf(p0)!;
  for (const id of ['customerVat', 'sellerVat', 'vatAmount'] as const) form = withFormField(form, p0.paper, { id });
  form = withFormTable(form, p0.paper, { rows: 12 });
  const withVatCol = { ...form, table: { ...form.table!, columns: [...form.table!.columns.slice(0, -1), { id: 'vatPct' as const, x: 170.5, w: 12 }, { ...form.table!.columns[form.table!.columns.length - 1], x: 182.5, w: 17.5 }] } };
  const p = withForm(p0, fitForm(withVatCol, p0.paper));
  const withTax = buildFormCalibration(p, tr);
  for (const id of ['customerVat', 'sellerVat', 'vatAmount', 'qr']) assert.ok(withTax.includes(`data-field="${id}"`), id);
  assert.ok(withTax.includes('data-column="vatPct"'));
  const off = buildFormCalibration(p, tr, { taxOff: true });
  for (const id of ['customerVat', 'sellerVat', 'vatAmount', 'qr']) assert.ok(!off.includes(`data-field="${id}"`), id);
  assert.ok(!off.includes('data-column="vatPct"'));
  assert.equal(firstTaxMention(off.replace(/<style>[\s\S]*?<\/style>/, '')), null);
  assert.ok(off.includes('data-field="totalDue"') && off.includes('data-column="lineTotal"'), 'غير الضريبة كما هو');
});

test('المعايرة لقالبٍ ليس نموذجاً مطبوعاً مسبقاً: المسطرتان والعنوان وحدها', () => {
  const h = buildFormCalibration(base(), tr);
  assert.ok(h.includes('@page { size: 210mm 297mm; margin: 0; }'));
  assert.ok(!h.includes('class="f"') && !h.includes('class="c"') && !h.includes('dx '));
  assert.ok(h.includes(FORM_CALIBRATION_TEXTS.title));
});

test('الإزاحة بإشارتها وعُشرها، والمواضع خارج الورقة مقصوصةٌ كالطباعة (fitForm)', () => {
  assert.equal(signedMm(1.5), '+1.5');
  assert.equal(signedMm(-2), '-2.0');
  assert.equal(signedMm(0), '0.0');
  assert.equal(signedMm(-0.04), '0.0');
  assert.equal(signedMm(Number.NaN), '0.0');
  const p0 = formProfile();
  const f = formOf(p0)!;
  const out = { ...f, fields: f.fields.map((x) => (x.id === 'docNumber' ? { ...x, x: 500 } : x)) };
  const h = buildFormCalibration(withForm(p0, out), tr);
  const fitted = fitForm(out, p0.paper).fields.find((x) => x.id === 'docNumber')!;
  assert.ok(fitted.x + fitted.w <= 210);
  assert.ok(h.includes(`data-field="docNumber" style="${style(fitted)}"`));
});

test('التوصيل: «طباعة صفحة معايرة» لقالب النموذج بنظام الطباعة بصفحة النموذج — وغيره كما كان', () => {
  const src = fs.readFileSync(new URL('../../components/print/PrintDeviceTools.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const cal = src.slice(src.indexOf('const calibrate = (via: PrintTransport)'), src.indexOf('const testPrint = (via: PrintTransport)'));
  assert.ok(cal.includes('if (!port && formOf(sysProfile)) {\n      await printHtmlDocument(buildFormCalibration(sysProfile, tr, { name, taxOff }), sysProfile.paper.widthMm);\n      return;\n    }'));
  assert.ok(cal.indexOf('formOf(sysProfile)') < cal.indexOf('if (port) return'), 'فرع النموذج قبل مسار البلوتوث والصفحة العادية');
  assert.ok(cal.includes("await printHtmlDocument(buildCalibrationDocument(sysProfile, tr, { mode: 'system', name }), sysProfile.paper.widthMm);"), 'المعايرة العادية كما هي');
  assert.ok(src.includes("import { buildFormCalibration } from '../../lib/print/formCalibration';"));
});

test('عبارات صفحة المعايرة مترجمة في القاموس (بلا فاصلةٍ عليا في الفرنسية)', () => {
  const all = [FORM_CALIBRATION_TEXTS.title, FORM_CALIBRATION_TEXTS.offset, FORM_CALIBRATION_TEXTS.table, ...FORM_CALIBRATION_TEXTS.help];
  for (const ar of all) {
    const e = PHRASES[ar];
    assert.ok(e && e.en && e.fr && e.tr && e.zh, `ناقصة: ${ar}`);
    assert.ok(!/['’]/.test(e.fr), ar);
  }
});

test('المعايرة: مربع العنوان في الركن الأقلّ تغطيةً للحقول والجدول وبخلفيةٍ شفافة — فلا يحجب ما تقيسه الشركة', () => {
  // ركنٌ خالٍ يُختار، والأعلى الأيمن عند التساوي
  assert.deepEqual(calibrationInfoSpot([], 210, 296.5, 30), { x: 110, y: 10, w: 92, h: 30 });
  const topRight = { x: 120, y: 12, w: 60, h: 20 };
  assert.deepEqual(calibrationInfoSpot([topRight], 210, 296.5, 30), { x: 12, y: 10, w: 92, h: 30 });
  const tops = [topRight, { x: 20, y: 15, w: 60, h: 20 }];
  assert.equal(calibrationInfoSpot(tops, 210, 296.5, 30).y, 296.5 - 6 - 30, 'الأعلى مشغول ⇒ أسفل');
  // ورقة النموذج: لا أبيض يغطّي المربعات، والموضع ركنٌ بلا تداخلٍ أكثر من غيره
  const p = withForm(formProfile(), { ...formOf(formProfile())!, fields: [{ id: 'docTitle', x: 120, y: 12, w: 80, h: 30 }] });
  const h = buildFormCalibration(p, tr);
  assert.ok(h.includes('.info { position: absolute; font-size: 2.4mm; line-height: 1.35; background: transparent;'));
  assert.ok(!/\.info \{[^}]*background: #fff/.test(h));
  const m = /data-form-calibration-info="" style="left:([\d.]+)mm;top:([\d.]+)mm;width:([\d.]+)mm"/.exec(h);
  assert.ok(m, 'موضعٌ صريح');
  const info = { x: Number(m![1]), y: Number(m![2]), w: Number(m![3]) };
  assert.ok(info.x + info.w <= 120 || info.y >= 42, `لا يقع على العنوان (${JSON.stringify(info)})`);
});
