// صفحة معايرة «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦): @page بمقاس الورق بلا هامش، ومربعٌ متقطّع لكل حقلٍ
// باسمه في موضعه بعد الإزاحة، وجدول الأصناف بحدود صفوفه وأعمدته، ومسطرتان على الحافتين بلا إزاحة، والعنوان بقيمتي الإزاحة —
// وبلا صورةٍ ولا رمزٍ ولا قيم، ولشركةٍ بلا ضريبة بلا حقول الضريبة وعمودها ومربع الرمز. وتوصيلها في «طباعة صفحة معايرة».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FORM_CALIBRATION_TEXTS, buildFormCalibration, calibrationInfoSpot, signedMm } from './formCalibration';
import {
  FORM_COLUMN_LABELS, FORM_FIELD_LABELS, fitForm, formOf, formPaperOf, formReachOf, formTableBox, printedBox, tableRowTop, withFormField, withFormProps,
  withFormTable, type PrintForm,
} from './formModel';
import { PAPER_PRESETS, defaultPrintOptions, presetPaper, withDesign, type PrintProfile } from './printSettings';
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

// ─── النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦): الصفحة نفسها تُرسم نقاطاً بدقة الطابعة (printFormHtmlDirect ← formSheetRaster) فيُرفض كل
// حبرٍ خارج ما تبلغه الإبرة — فلا يخرج منها شيء، والمسطرتان داخلها بنصف مم وأرقامهما من حافة الورقة، والعادية كما كانت حرفاً ───

const IMPACT_PRESETS = PAPER_PRESETS.filter((x) => x.printer === 'impact').map((x) => x.id);
const impactProfile = (preset: (typeof IMPACT_PRESETS)[number] = 'ff_a4'): PrintProfile =>
  withDesign({ id: 'mip-1', name: 'نقطية', printer: 'impact', template: 'impact_plain', paper: presetPaper(preset)!, options: defaultPrintOptions('impact') }, 'preprinted');
const EPS = 1e-6;
/** كل عنصرٍ مموضَع في الورقة: صنفه وقيمه بالمم (left/top/width/height) واتجاه توسيطه */
const placed = (h: string) => [...h.slice(h.indexOf('<section')).matchAll(/<(?:i|b|div) class="(t|n|f|c|r|rn|info)"[^>]*? style="([^"]*)"/g)].map((m) => {
  const v = (k: string): number | null => { const r = new RegExp(`(?:^|;)${k}:(-?[\\d.]+)mm`).exec(m[2]); return r ? Number(r[1]) : null; };
  return { cls: m[1], left: v('left') ?? 0, top: v('top') ?? 0, width: v('width') ?? 0, height: v('height') ?? 0, centred: m[2].includes('translateX(-50%)') };
});
/** المدى الأفقيّ للحبر بالمم: الأرقام بتقديرٍ محافظ لعرضها (ثلاث خانات ≤ 4 مم على 2.4 مم، وخانتان ≤ 3 مم على 2 مم) */
const inkSpan = (e: ReturnType<typeof placed>[number]): [number, number] => {
  if (e.cls === 'n') return e.centred ? [e.left - 3, e.left + 3] : [e.left, e.left + 4];
  if (e.cls === 'rn') return [e.left, e.left + 3];
  return [e.left, e.left + e.width];
};
const assertInBand = (h: string, p: PrintProfile, at: string) => {
  const r = formReachOf(p)!;
  const lo = r.x0 + 0.5; const hi = r.x1 - 0.5;
  const L = p.paper.lengthMm!;
  const all = placed(h);
  assert.ok(all.length > 300, `${at}: لا عناصر`);
  for (const e of all) {
    const [a, b] = inkSpan(e);
    // المربعات والأعمدة وحدود الصفوف داخل الحزمة نفسها (قاعدة النواة layoutFormReach)، وما يرسمه هذا الملف وحده داخلها بنصف مم
    const [min, max] = ['f', 'c', 'r'].includes(e.cls) ? [r.x0, r.x1] : [lo, hi];
    assert.ok(a >= min - EPS && b <= max + EPS, `${at}: .${e.cls} [${a}, ${b}] خارج [${min}, ${max}]`);
    if (e.cls === 'f') assert.ok(e.top >= -EPS && e.top + e.height <= L + EPS, `${at}: حقلٌ خارج طول الورقة`);
  }
};

test('المعايرة على النقطية: كل ما في الورقة داخل ما تبلغه الإبرة — على كل مقاسٍ نقطي، وبإزاحاتٍ وحقولٍ وأعمدةٍ على أطراف الورقة', () => {
  assert.ok(IMPACT_PRESETS.length >= 6);
  for (const preset of IMPACT_PRESETS) {
    const p0 = impactProfile(preset);
    const f0 = formOf(p0)!;
    assert.ok(f0, `${preset}: لا نموذج`);
    assertInBand(buildFormCalibration(p0, tr, { name: 'x' }), p0, preset);
    // قالبٌ غير محفوظ بمواضع خارج الحزمة (وحقلٌ أضيق من اسمه على حدّها، ورمزٌ أصغر من حدّ النقطية) — يُقصّ كالطباعة (formPaperOf)
    const edge: PrintForm = {
      ...f0,
      fields: [
        ...f0.fields.filter((x) => !['docNumber', 'customerName', 'customerPostal', 'qr'].includes(x.id)),
        { id: 'docNumber', x: 0, y: 0, w: 90, h: 6 },
        { id: 'customerName', x: 500, y: 500, w: 36, h: 6 },
        { id: 'customerPostal', x: 0, y: 40, w: 3, h: 3 },
        { id: 'qr', x: -20, y: 400, w: 22, h: 22 },
      ] as PrintForm['fields'],
      table: { ...f0.table!, columns: f0.table!.columns.map((c, i) => (i === 0 ? { ...c, x: -5 } : i === f0.table!.columns.length - 1 ? { ...c, x: 400 } : c)) },
    };
    for (const [dxMm, dyMm] of [[0, 0], [5, -3], [-7.5, 12], [20, -20], [-20, 20]]) {
      const p = withForm(p0, withFormProps(edge, { dxMm, dyMm }));
      const h = buildFormCalibration(p, tr, { name: 'ورق مروج' });
      assertInBand(h, p, `${preset} dx ${dxMm} dy ${dyMm}`);
      const fitted = fitForm(formOf(p)!, formPaperOf(p));
      for (const f of fitted.fields) assert.ok(h.includes(`<div class="f" data-field="${f.id}" style="${style(printedBox(fitted, f))}">`), `${preset}: ${f.id}`);
      assert.ok(h.includes(`data-field="qr" style="left:`) && /data-field="qr" style="[^"]*width:55mm;height:55mm"/.test(h), `${preset}: مربع الرمز بحدّ النقطية`);
      // اسم الحقل الضيّق لا يفيض خارج مربعه (ولا العنوان خارج صندوقه)
      assert.ok(h.includes('    .f, .info { overflow: hidden; }\n'));
    }
  }
});

test('المعايرة على النقطية: المسطرتان داخل الحزمة بنصف مم بلا إزاحة، وأرقامهما بالمم من حافة الورقة — والورقة data-form-sheet', () => {
  const p0 = impactProfile('ff_a4');
  const p = withForm(p0, withFormProps(formOf(p0)!, { dxMm: 5, dyMm: 5 }));
  const h = buildFormCalibration(p, tr);
  assert.equal(h.split('<section class="sheet" data-form-calibration="" data-form-sheet="1">').length - 1, 1, 'ورقة نموذجٍ واحدة');
  assert.ok(h.includes('@page { size: 210mm 297mm; margin: 0; }') && h.includes('height: 296.5mm;'), 'مشغّل ويندوز: الورقة بمقاسها كالعادية');
  // A4 على 1440 نقطة: الحزمة [3.4، 206.6] ⇒ العليا من 4 إلى 205 مم، واليسرى على 3.9 مم
  assert.equal(h.split('<i class="t"').length - 1, (205 - 4 + 1) + 296);
  assert.ok(h.includes('<i class="t" style="left:4mm;top:0;width:0.2mm;height:2mm"></i>'));
  assert.ok(h.includes('<i class="t" style="left:205mm;top:0;width:0.2mm;height:4mm"></i>'));
  assert.ok(!h.includes('left:3mm;top:0;') && !h.includes('left:206mm;top:0;') && !h.includes('<i class="t" style="left:0;') && !h.includes('left:0mm;'), 'لا علامة خارج الحزمة');
  for (const n of [10, 100, 200]) assert.ok(h.includes(`<b class="n" style="left:${n}mm;top:6.6mm;transform:translateX(-50%)">${n}</b>`), `أفقي ${n} من حافة الورقة`);
  assert.ok(h.includes('<i class="t" style="left:3.9mm;top:20mm;width:6mm;height:0.2mm"></i>'), 'اليسرى على x0 + ½ بلا إزاحة');
  for (const n of [10, 150, 290]) assert.ok(h.includes(`<b class="n" style="left:10.5mm;top:${n}mm;transform:translateY(-50%)">${n}</b>`), `رأسي ${n}`);
  // بلا إزاحة: المسطرتان نفساهما بإزاحةٍ وبدونها
  const rulers = (s: string) => [...s.matchAll(/<(?:i|b) class="(?:t|n)"[^>]*>(?:\d+<\/b>|<\/i>)/g)].map((m) => m[0]).join('');
  assert.equal(rulers(h), rulers(buildFormCalibration(p0, tr)));
  // 241 مم: الحزمة [18.9، 222.1] ⇒ من 20 إلى 221، والرقم 20 لا يتّسع داخلها (17 < 19.4) ولا 220 (223 > 221.6)
  const w = buildFormCalibration(impactProfile('ff_95x11'), tr);
  assert.ok(w.includes('<i class="t" style="left:20mm;top:0;width:0.2mm;height:6mm"></i>') && w.includes('<i class="t" style="left:221mm;top:0;'));
  assert.ok(!w.includes('left:19mm;top:0;') && !w.includes('left:222mm;top:0;'));
  assert.ok(!w.includes('left:20mm;top:6.6mm'), 'لا رقم 20 على حدّ الحزمة');
  assert.ok(w.includes('<b class="n" style="left:30mm;top:6.6mm;transform:translateX(-50%)">30</b>') && w.includes('<b class="n" style="left:210mm;top:6.6mm;transform:translateX(-50%)">210</b>'));
  assert.ok(!w.includes('left:220mm;top:6.6mm'));
  assert.ok(w.includes('<i class="t" style="left:19.4mm;top:10mm;width:6mm;height:0.2mm"></i>') && w.includes('<b class="n" style="left:26mm;top:10mm;transform:translateY(-50%)">10</b>'));
  // والطابعة العادية: لا ورقة نموذجٍ نقطية ولا قصّ — كما كانت حرفاً
  const page = buildFormCalibration(formProfile(), tr);
  assert.ok(!page.includes('data-form-sheet') && !page.includes('overflow: hidden; }\n  </style>') && page.includes('<section class="sheet" data-form-calibration="">'));
  assert.ok(page.includes('<i class="t" style="left:0mm;top:0;width:0.2mm;height:6mm"></i>') && page.includes('<i class="t" style="left:0;top:20mm;width:6mm;height:0.2mm"></i>'), 'العادية من حافة الورقة');
});

test('المعايرة على النقطية: رقم الصفّ داخل الحزمة — يساره إن خلا من المسطرة اليسرى، وإلا يمينه، وإلا يساره، وإلا بلا رقم', () => {
  const p0 = impactProfile('ff_a4');
  const f0 = formOf(p0)!;
  const withCols = (columns: Array<{ x: number; w: number }>) => withForm(p0, { ...f0, table: { ...f0.table!, columns: columns.map((c, i) => ({ id: (['description', 'qty'] as const)[i], ...c })) } });
  const rn = (h: string) => [...h.matchAll(/<b class="rn" style="left:([\d.]+)mm;/g)].map((m) => Number(m[1]));
  // جدول البداية (10..200): يساره على المسطرة (6 < 14.9) ⇒ يمينه
  const starter = rn(buildFormCalibration(p0, tr));
  assert.equal(starter.length, 16);
  assert.ok(starter.every((x) => x === 200.6));
  // يبدأ عند 20: يساره خالٍ ⇒ يساره (16)
  assert.ok(rn(buildFormCalibration(withCols([{ x: 20, w: 150 }]), tr)).every((x) => x === 16));
  // من 9 إلى 206.5: لا متّسع يمينه داخل الحزمة ⇒ يساره فوق علامات المسطرة (5 ≥ 3.9)
  const tight = rn(buildFormCalibration(withCols([{ x: 9, w: 150 }, { x: 159, w: 47.5 }]), tr));
  assert.ok(tight.length === 16 && tight.every((x) => x === 5), JSON.stringify(tight));
  // الحزمة كلها (3.5..206.5): لا رقم
  const full = buildFormCalibration(withCols([{ x: 3.5, w: 150 }, { x: 153.5, w: 53 }]), tr);
  assert.equal(rn(full).length, 0);
  assert.equal(full.split('data-row-line=').length - 1, 17, 'حدود الصفوف باقية');
  // والعادية للجدول نفسه: يساره كما كانت (4.5 ≤ 9)
  const pagePro = formProfile();
  const pf = formOf(pagePro)!;
  const pageTight = buildFormCalibration(withForm(pagePro, { ...pf, table: { ...pf.table!, columns: [{ id: 'description', x: 9, w: 150 }, { id: 'qty', x: 159, w: 47.5 }] } }), tr);
  assert.ok(rn(pageTight).every((x) => x === 5) && rn(pageTight).length === pf.table!.rows);
});

test('مربع العنوان على النقطية داخل الحزمة — وبلا reach (أو null) الحساب كما كان حرفاً', () => {
  assert.deepEqual(calibrationInfoSpot([], 210, 296.5, 30, null), calibrationInfoSpot([], 210, 296.5, 30));
  assert.deepEqual(calibrationInfoSpot([], 210, 296.5, 30, undefined), { x: 110, y: 10, w: 92, h: 30 });
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  // A4 على 1440: lo 3.9 وhi 206.1 ⇒ الأيمن 206.1 − 8 − 92، والأيسر بعد المسطرة 3.9 + 12
  const a4 = { x0: 3.4000000000000057, x1: 206.6 };
  const tr0 = calibrationInfoSpot([], 210, 296.5, 30, a4);
  assert.ok(near(tr0.x, 106.1) && tr0.y === 10 && tr0.w === 92 && tr0.h === 30, JSON.stringify(tr0));
  const tl = calibrationInfoSpot([{ x: 120, y: 12, w: 60, h: 20 }], 210, 296.5, 30, a4);
  assert.ok(near(tl.x, 15.9) && tl.y === 10, JSON.stringify(tl));
  // حزمةٌ ضيّقة (أضيق من العنوان المعتاد): العرض يُقصّ فلا يخرج منها أيّ ركن
  const narrow = { x0: 10, x1: 50 };
  const boxes = [[], [{ x: 0, y: 0, w: 60, h: 40 }], [{ x: 0, y: 0, w: 60, h: 40 }, { x: 0, y: 200, w: 60, h: 90 }]];
  for (const b of boxes) {
    const s = calibrationInfoSpot(b, 60, 296.5, 30, narrow);
    assert.ok(s.x >= 10.5 - EPS && s.x + s.w <= 49.5 + EPS && s.w > 0, JSON.stringify(s));
  }
  // وفي الورقة: الموضع المكتوب هو حساب الدالة بالحزمة
  const h = buildFormCalibration(impactProfile('ff_95x11'), tr);
  const m = /data-form-calibration-info="" style="left:([\d.]+)mm;top:([\d.]+)mm;width:([\d.]+)mm"/.exec(h);
  assert.ok(m);
  assert.ok(Number(m![1]) >= 19.4 && Number(m![1]) + Number(m![3]) <= 221.6 + EPS, m![0]);
});

test('تعليمات المعايرة النقطية: impactHelp بدل help (سطرها الثاني هو نفسه) ومترجمة — والعادية بتعليماتها كما كانت، وبلا ضريبة بلا عبارةٍ ضريبية', () => {
  const T = FORM_CALIBRATION_TEXTS;
  assert.equal(T.impactHelp.length, 3);
  assert.equal(T.impactHelp[1], T.help[1]);
  for (const ar of T.impactHelp) {
    const e = PHRASES[ar];
    assert.ok(e && e.en && e.fr && e.tr && e.zh, `ناقصة: ${ar}`);
    assert.ok(!/['’]/.test(e.fr), ar);
  }
  // البلوتوث المباشر (direct): impactHelp وحدها — لا نافذة طباعة فلا «100٪»
  const imp = buildFormCalibration(impactProfile('cut_a4'), tr, { direct: true });
  for (const l of T.impactHelp) assert.ok(imp.includes(`<div class="hp">• ${l}</div>`), l);
  for (const l of [T.help[0], T.help[2]]) assert.ok(!imp.includes(l), l);
  // نظام الطباعة (مشغّل ويندوز، الافتراضي): «100٪ بلا تكبير ولا تصغير» أولاً ثم impactHelp — تصغير المشغّل لا تصلحه إزاحةٌ واحدة
  const sys = buildFormCalibration(impactProfile('cut_a4'), tr);
  const hp = (h: string) => [...h.matchAll(/<div class="hp">• ([^<]*)<\/div>/g)].map((m) => m[1]);
  assert.deepEqual(hp(sys), [T.help[0], ...T.impactHelp]);
  assert.deepEqual(hp(imp), [...T.impactHelp]);
  assertInBand(sys, impactProfile('cut_a4'), 'نظام الطباعة');
  // والعادية: help كما كانت حرفاً، وdirect لا أثر له عليها
  const page = buildFormCalibration(formProfile(), tr);
  for (const l of T.help) assert.ok(page.includes(`<div class="hp">• ${l}</div>`), l);
  for (const l of [T.impactHelp[0], T.impactHelp[2]]) assert.ok(!page.includes(l), l);
  assert.deepEqual(hp(page), [...T.help]);
  assert.equal(buildFormCalibration(formProfile(), tr, { direct: true }), page);
  // بلا ضريبة على النقطية: لا حقول الضريبة ولا مربع الرمز ولا عبارة ضريبية
  const off = buildFormCalibration(impactProfile('ff_a4'), tr, { taxOff: true });
  assert.ok(!off.includes('data-field="qr"'));
  assert.equal(firstTaxMention(off.replace(/<style>[\s\S]*?<\/style>/, '')), null);
});

test('التوصيل: «طباعة صفحة معايرة» لقالب نموذجٍ نقطيّ بالبلوتوث المباشر = صفحة معايرة النموذج نقاطاً (printFormHtmlDirect) — وغيره كما كان', () => {
  const src = fs.readFileSync(new URL('../../components/print/PrintDeviceTools.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const cal = src.slice(src.indexOf('const calibrate = (via: PrintTransport)'), src.indexOf('const testPrint = (via: PrintTransport)'));
  const bt = "if (port && profile.printer === 'impact' && formOf(profile)) return direct.run((ui) => printFormHtmlDirect(port, buildFormCalibration(profile, tr, { name, taxOff, direct: true }), profile, ui), { ...directOpts(choice), label: tr('طباعة صفحة معايرة') });";
  assert.ok(cal.includes(bt), 'فرع النموذج النقطيّ بالبلوتوث');
  const at = cal.indexOf(bt);
  assert.ok(cal.indexOf('if (!port && formOf(sysProfile)) {') < at, 'بعد فرع نظام الطباعة');
  assert.ok(at < cal.indexOf('if (port) return direct.run('), 'قبل صفحة المعايرة العامة بالبلوتوث');
  // صفحة المعايرة العامة بالبلوتوث (الحرارية وغير النموذج) كما كانت
  assert.ok(cal.includes("if (port) return direct.run((ui) => printHtmlDirect(port, buildCalibrationDocument(profile, tr, { mode: 'raster', name }), profile, 'pages', ui), { ...directOpts(choice), label: tr('طباعة صفحة معايرة') });"));
  const imp = /import \{([^}]*)\} from '\.\.\/\.\.\/rep\/printDirect';/.exec(src);
  assert.ok(imp && /\bprintFormHtmlDirect\b/.test(imp[1]), 'printFormHtmlDirect من printDirect');
  assert.equal(src.split('printFormHtmlDirect(').length - 1, 1, 'استدعاءٌ واحد');
});
