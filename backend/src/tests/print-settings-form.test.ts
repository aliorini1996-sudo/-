// «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — design = 'preprinted' ومفتاحه الحرّ options.layout.form: مواضع
// الحقول وجدول الأصناف بالمم من ركن الورقة، ومرجع صورة النموذج (البايتات في جدولٍ مستقل)، ومعايرة الطابعة. الحفظ الصارم يرفض كل
// حدٍّ برسالته العربية (400) وكل مفتاحٍ مجهول في أيّ مستوى، والقراءة المتسامحة تُسقط الحقل أو العمود المعطوب وحده (وتُسقط التخطيط
// إن بقي النموذج غير صالح)، والصورة القانونية ترتّب وتقرّب، والتوجيه للفواتير وحدها ولا PDF و4 قوالب على الأكثر — والحجم يتّسع.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORM_BOUNDS, FORM_COLUMN_IDS, FORM_FIELD_IDS, FORM_IMPACT_QR_MIN_MM, FORM_LAST_SHEET_IDS, FORM_VALUE_LANGS, LAYOUT_DESIGNS, PRINT_ISSUES, PRINT_LIMITS,
  CANVAS_BOX_IDS, checkPrintSettings, defaultPrintLayout, defaultPrintOptions, formQrMinMm, formReachX, isFormProfile, layoutIssues, legacyPrintSettings,
  parsePrintSettings, presetPaper, printSettingsBytes, routingAllowsProfile, sectionsFor, storedPrintSettings,
  type FormColumn, type FormField, type LayoutDesign, type PrintForm, type PrintLayout, type PrintProfile, type PrintSettingsV1,
} from '../services/printSettings';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const profile = (over: Partial<PrintProfile> & Pick<PrintProfile, 'id' | 'printer' | 'template'>, preset: Parameters<typeof presetPaper>[0]): PrintProfile => ({
  name: over.id, paper: presetPaper(preset)!, options: defaultPrintOptions(over.printer), ...over,
});
function fleet(): PrintSettingsV1 {
  return {
    version: 1,
    profiles: [
      profile({ id: 'mip480', name: 'نقطية MIP480', printer: 'impact', template: 'impact_plain' }, 'ff_a4'),
      profile({ id: 'van-80', name: 'رول 80', printer: 'thermal', template: 'roll_detailed' }, 'roll80'),
      profile({ id: 'office', name: 'مكتب A4', printer: 'page', template: 'page_plain' }, 'a4'),
    ],
    routing: { invoice: 'mip480', receipt: 'van-80', statement: 'office', notices: null },
    pdfProfileId: 'office',
    repMayChoose: true,
  };
}
const IMG = { id: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b', v: 'abcdef0123456789', wPx: 1240, hPx: 1754 };
/** نموذجٌ صالح على A4: رقم المستند وتاريخه والإجمالي ورمز QR، وجدولٌ بعمودين */
const baseForm = (): PrintForm => ({
  image: null, dxMm: 0, dyMm: 0, background: false, latinDigits: true, valueLang: 'ar',
  fields: [
    { id: 'docNumber', x: 150, y: 40, w: 40, h: 6 },
    { id: 'docDate', x: 150, y: 47, w: 40, h: 6, align: 'center' },
    { id: 'totalDue', x: 120, y: 276, w: 40, h: 6, bold: true },
    { id: 'qr', x: 12, y: 268, w: 22, h: 22 },
  ],
  table: { y: 105, rowMm: 7, rows: 23, columns: [{ id: 'description', x: 70, w: 50, align: 'start' }, { id: 'qty', x: 120, w: 10 }] },
});
/** null = بلا مواضع */
const formLayout = (form: PrintForm | null = baseForm(), over: Partial<PrintLayout> = {}, design: LayoutDesign = 'preprinted'): PrintLayout => {
  const l: PrintLayout = { ...defaultPrintLayout('page', design), ...over };
  if (form !== null) l.form = form;
  return l;
};
const formp = (form: PrintForm | null = baseForm(), over: Partial<PrintLayout> = {}, design: LayoutDesign = 'preprinted', id = 'murouj'): PrintProfile => {
  const p = profile({ id, name: id, printer: 'page', template: 'page_plain' }, 'a4');
  return { ...p, paper: { ...p.paper, marginTopMm: 0, marginBottomMm: 0 }, options: { ...p.options, layout: formLayout(form, over, design) } };
};
/** الإعداد بالقالب موجَّهاً للفواتير */
const fleetWith = (p: PrintProfile): PrintSettingsV1 => ({ ...fleet(), profiles: [...fleet().profiles, p], routing: { ...fleet().routing, invoice: p.id } });
const messages = (s: unknown): { status: number; message: string; all: string[] } => {
  const r = parsePrintSettings(s);
  return r.ok ? { status: 200, message: '', all: [] } : { status: r.status, message: r.message, all: r.issues.map((i) => i.message) };
};
const rejects = (p: PrintProfile | Record<string, unknown>, message: string, label: string): void => {
  const r = messages(fleetWith(p as PrintProfile));
  assert.equal(r.status, 400, `${label}: ${JSON.stringify(r)}`);
  assert.ok(r.all.includes(message), `${label}: ${message} ⇐ ${JSON.stringify(r.all)}`);
};
const accepts = (p: PrintProfile, label: string): PrintSettingsV1 => {
  const r = checkPrintSettings(fleetWith(p), true);
  assert.ok(r.ok, `${label}: ${JSON.stringify(!r.ok && r.issues)}`);
  return (r as { value: PrintSettingsV1 }).value;
};
const withField = (patch: Partial<FormField> & { id: FormField['id'] }, base: PrintForm = baseForm()): PrintForm => {
  const f = base;
  const i = f.fields.findIndex((x) => x.id === patch.id);
  if (i >= 0) f.fields[i] = { ...f.fields[i], ...patch };
  else f.fields.push({ x: 10, y: 10, w: 20, h: 6, ...patch });
  return f;
};

// ─── النموذج على النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦: Tally Dascom MIP480) ───
/**
 * نموذجٌ نقطيّ صالح على ورقٍ عرضه W وطوله L كبداية المصمّم: مواضع A4 (x من 10 إلى 200) مُزاحةً أفقياً بـ(W − 210)/2 — لا تُكبَّر،
 * فالحزمة 203.2 مم في منتصف كل ورق — ومقيسةً رأسياً بـL/297، والجدول 16 صفاً (105 ⇒ 217) ورمز QR 55 مم تحته
 */
const impactForm = (W = 210, L = 297): PrintForm => {
  const tx = (W - 210) / 2;
  const sy = L / 297;
  return {
    image: null, dxMm: 0, dyMm: 0, background: false, latinDigits: true, valueLang: 'ar',
    fields: [
      { id: 'docNumber', x: 150 + tx, y: 40 * sy, w: 40, h: 6 },
      { id: 'docDate', x: 150 + tx, y: 47 * sy, w: 40, h: 6, align: 'center' },
      { id: 'totalDue', x: 140 + tx, y: 230 * sy, w: 50, h: 6, bold: true },
      { id: 'qr', x: 12 + tx, y: 226 * sy, w: 55, h: 55 },
    ],
    table: { y: 105 * sy, rowMm: 7, rows: 16, columns: [{ id: 'description', x: 70 + tx, w: 50, align: 'start' }, { id: 'qty', x: 120 + tx, w: 10 }] },
  };
};
/** قالب النموذج على النقطية كما يبنيه withDesign: impact_preprinted، والهامشان والإزاحة الأفقية صفر */
const impactp = (form: PrintForm | null = impactForm(), preset: Parameters<typeof presetPaper>[0] = 'ff_a4', over: Partial<PrintLayout> = {}, id = 'mip-form'): PrintProfile => {
  const p = profile({ id, name: id, printer: 'impact', template: 'impact_preprinted' }, preset);
  const layout: PrintLayout = { ...defaultPrintLayout('impact', 'preprinted'), ...over };
  if (form !== null) layout.form = form;
  return { ...p, paper: { ...p.paper, marginTopMm: 0, marginBottomMm: 0, offsetXmm: 0 }, options: { ...p.options, layout } };
};
const withImpactField = (patch: Partial<FormField> & { id: FormField['id'] }): PrintForm => withField(patch, impactForm());
const impactCols = (columns: FormColumn[]): PrintForm => ({ ...impactForm(), table: { ...impactForm().table!, columns } });

test('النموذج: الثوابت كما في العقد — تصميمٌ ثالث، ومعرّفاتٌ قيمٌ لا مفاتيح، والحدود، و4 قوالب، والافتراضي بلا نموذج', () => {
  assert.deepEqual([...LAYOUT_DESIGNS], ['standard', 'grid_bilingual', 'preprinted']);
  assert.deepEqual([...FORM_FIELD_IDS], [
    'docNumber', 'docDate', 'docTime', 'paymentType', 'dueDate', 'deliveryDate', 'docTitle', 'originalRef', 'noteReason',
    'customerName', 'customerBusiness', 'customerAddress', 'customerCity', 'customerPostal', 'customerPhone', 'customerVat', 'customerCr',
    'sellerName', 'sellerAddress', 'sellerCity', 'sellerPostal', 'sellerPhone', 'sellerVat', 'sellerCr',
    'repName', 'notes', 'subtotal', 'discount', 'vatAmount', 'totalDue', 'paidAmt', 'remainingAmt', 'pageNo', 'qr',
  ]);
  assert.deepEqual([...FORM_LAST_SHEET_IDS], ['notes', 'subtotal', 'discount', 'vatAmount', 'totalDue', 'paidAmt', 'remainingAmt', 'qr']);
  assert.deepEqual([...FORM_COLUMN_IDS], ['sr', 'itemCode', 'barcode', 'description', 'qty', 'unit', 'unitPrice', 'discountPct', 'vatPct', 'lineTotal']);
  assert.deepEqual([...FORM_VALUE_LANGS], ['ar', 'en']);
  assert.deepEqual(JSON.parse(JSON.stringify(FORM_BOUNDS)), {
    maxFields: 40, columns: [1, 12], rows: [1, 60], rowMm: [3, 25], fieldMinMm: 3, qrMinMm: 18, columnMinMm: 4, offsetMm: [-20, 20], imagePx: [200, 10000],
  });
  assert.equal(PRINT_LIMITS.maxForms, 4);
  for (const printer of ['thermal', 'impact', 'page'] as const) {
    for (const design of ['standard', 'grid_bilingual', 'preprinted'] as const) assert.ok(!('form' in defaultPrintLayout(printer, design)), `${printer}/${design}`);
  }
  // ترتيب أقسام التصميم الجديد = ترتيب الصفحة (لا يُطبع، لكنه يُحفظ صالحاً)
  assert.deepEqual([...sectionsFor('page', 'preprinted')], [...sectionsFor('page', 'standard')]);
  assert.ok(isFormProfile(formp()) && !isFormProfile(fleet().profiles[2]) && !isFormProfile(null));
  for (const kind of ['invoice', 'receipt', 'statement', 'notices'] as const) {
    assert.equal(routingAllowsProfile(kind, formp()), kind === 'invoice', kind);
    assert.equal(routingAllowsProfile(kind, fleet().profiles[2]), true, kind);
  }
  for (const k of ['layoutFormMissing', 'layoutFormDesign', 'layoutFormPrinter', 'layoutFormField', 'layoutFormFieldsCount', 'layoutFormFont', 'layoutFormQr',
    'layoutFormQrMissing', 'layoutFormTable', 'layoutFormColumn', 'layoutFormOffset', 'layoutFormImage', 'formsCount', 'routeForm', 'pdfForm',
    'layoutFormReach', 'layoutFormQrImpact', 'layoutFormBgImpact'] as const) {
    assert.equal(typeof PRINT_ISSUES[k], 'string', k);
  }
});

test('النموذج: الصالح يُحفظ — بصورةٍ وبلا صورة، ومعايرةٌ ±20، وبلا جدول، وبلا QR مع الحذف الصريح، وA5 وLetter', () => {
  accepts(formp(), 'base');
  accepts(formp({ ...baseForm(), image: IMG, dxMm: -20, dyMm: 20, background: true, latinDigits: false, valueLang: 'en' }), 'image + offsets');
  accepts(formp({ ...baseForm(), table: null }), 'no table');
  accepts(formp({ ...baseForm(), fields: [] }, { sections: { qr: { visible: false } }, stamps: false }), 'no fields, qr removed');
  accepts(formp(withField({ id: 'qr', w: 18, h: 18 })), 'qr 18');
  accepts(formp(withField({ id: 'docNumber', x: 0, y: 0, w: 210, h: 297 })), 'full sheet');
  accepts(formp(withField({ id: 'notes', fontPct: 70 })), 'font 70');
  accepts(formp({ ...baseForm(), table: { y: 0, rowMm: 3, rows: 60, fontPct: 160, columns: FORM_COLUMN_IDS.map((id, i) => ({ id, x: i * 21, w: 21 })) } }), '60 rows, 10 columns');
  for (const preset of ['a5', 'letter'] as const) {
    const p = profile({ id: 'small', printer: 'page', template: 'page_plain' }, preset);
    const form: PrintForm = { ...baseForm(), fields: [{ id: 'qr', x: 5, y: 5, w: 20, h: 20 }], table: { y: 50, rowMm: 5, rows: 20, columns: [{ id: 'sr', x: 5, w: 10 }] } };
    accepts({ ...p, options: { ...p.options, layout: formLayout(form) } }, preset);
  }
  // كل حقلٍ معروف مرةً واحدة يُقبل
  accepts(formp({ ...baseForm(), fields: FORM_FIELD_IDS.map((id, i) => ({ id, x: (i % 4) * 50, y: Math.floor(i / 4) * 30, w: 30, h: id === 'qr' ? 20 : 6 })) }), 'all 34 fields');
});

test('النموذج: كل حدٍّ يُرفض 400 برسالته العربية في الحفظ', () => {
  const I = PRINT_ISSUES;
  // التصميم والمواضع متلازمان
  rejects(formp(null), I.layoutFormMissing, 'preprinted without form');
  rejects(formp(baseForm(), {}, 'standard'), I.layoutFormDesign, 'form on standard');
  rejects(formp(baseForm(), {}, 'grid_bilingual'), I.layoutFormDesign, 'form on grid');
  // الطابعة العادية أو النقطية بطول صفحة (طلب المالك ١٣ نوفمبر ٢٠٢٦) — النقطية تُقبل بقواعدها (نموذج الصفحة بمربع QR 22 مم يُرفض
  // برسالة حدّ النقطية لا برسالة الطابعة، وبلا مواضع برسالة المواضع وحدها)، والحرارية مرفوضة كما كانت ولو بورق A4
  const imp = profile({ id: 'mip-2', printer: 'impact', template: 'impact_plain' }, 'ff_a4');
  const impPage = { ...imp, options: { ...imp.options, layout: formLayout() } };
  rejects(impPage, I.layoutFormQrImpact, 'impact: page qr 22');
  assert.ok(!messages(fleetWith(impPage)).all.includes(I.layoutFormPrinter), 'impact: not a printer fault');
  const impNone = { ...imp, options: { ...imp.options, layout: formLayout(null) } };
  rejects(impNone, I.layoutFormMissing, 'impact without form');
  assert.ok(!messages(fleetWith(impNone)).all.includes(I.layoutFormPrinter), 'impact without form: not a printer fault');
  accepts(impactp(), 'impact');
  const roll = profile({ id: 'van-2', printer: 'thermal', template: 'roll_compact' }, 'roll80');
  rejects({ ...roll, options: { ...roll.options, layout: { ...formLayout(), order: [...sectionsFor('thermal', 'standard')] } } }, I.layoutRoll, 'thermal');
  rejects({ ...roll, options: { ...roll.options, layout: { ...formLayout(), order: [...sectionsFor('thermal', 'standard')] } } }, I.layoutFormPrinter, 'thermal form');
  const rollA4 = profile({ id: 'van-a4', printer: 'thermal', template: 'roll_compact' }, 'roll_a4');
  rejects({ ...rollA4, options: { ...rollA4.options, layout: { ...formLayout(), order: [...sectionsFor('thermal', 'standard')] } } }, I.layoutFormPrinter, 'thermal A4 sheet');
  // اللوحتان لا تجتمعان مع النموذج
  rejects(formp(baseForm(), { canvas: { headerMm: 50, footerMm: 50, boxes: [] } }), I.layoutCanvasPrinter, 'canvas');
  assert.ok(CANVAS_BOX_IDS.length > 0);
  // الحقول
  for (const [label, patch] of [
    ['x<0', { x: -0.5 }], ['y<0', { y: -1 }], ['x+w>210', { x: 180, w: 30.5 }], ['y+h>297', { y: 292, h: 5.5 }], ['w<3', { w: 2.5 }], ['h<3', { h: 2.5 }],
    ['NaN', { x: NaN }], ['Infinity', { w: Infinity }],
  ] as Array<[string, Partial<FormField>]>) rejects(formp(withField({ id: 'docNumber', ...patch })), I.layoutFormField, label);
  const dup = baseForm();
  dup.fields.push({ id: 'docNumber', x: 10, y: 10, w: 20, h: 6 });
  rejects(formp(dup), I.layoutFormField, 'duplicate');
  rejects(formp(withField({ id: 'docNumber', id2: 1 } as never)), I.unknownKey, 'unknown field key');
  rejects(formp(withField({ id: 'qr', w: 17.5 })), I.layoutFormQr, 'qr w 17.5');
  rejects(formp(withField({ id: 'qr', h: 17 })), I.layoutFormQr, 'qr h 17');
  for (const fontPct of [69, 161, NaN]) rejects(formp(withField({ id: 'docDate', fontPct })), I.layoutFormFont, `font ${fontPct}`);
  const many = baseForm();
  for (let i = 0; i < 37; i++) many.fields.push({ id: FORM_FIELD_IDS[i % FORM_FIELD_IDS.length], x: 0, y: 0, w: 10, h: 6 });
  rejects(formp(many), I.layoutFormFieldsCount, '41 fields');
  // رمز QR: لازمٌ ما لم تحذفه الشركة صراحةً
  const noQr = { ...baseForm(), fields: baseForm().fields.filter((f) => f.id !== 'qr') };
  rejects(formp(noQr), I.layoutFormQrMissing, 'no qr');
  accepts(formp(noQr, { sections: { qr: { visible: false } } }), 'no qr, removed');
  // الجدول
  for (const [label, t] of [
    ['rows 0', { rows: 0 }], ['rows 61', { rows: 61 }], ['rows 60.6', { rows: 60.6 }], ['rowMm 2.9', { rowMm: 2.9 }], ['rowMm 25.5', { rowMm: 25.5 }],
    ['overflow', { y: 200, rows: 14 }], ['y<0', { y: -1 }],
  ] as Array<[string, Record<string, number>]>) rejects(formp({ ...baseForm(), table: { ...baseForm().table!, ...t } }), I.layoutFormTable, label);
  rejects(formp({ ...baseForm(), table: { ...baseForm().table!, fontPct: 200 } }), I.layoutFormFont, 'table font');
  // الصفوف داخل حدودها تُقرَّب إلى عددٍ صحيح (كالخط) — لا تُرفض
  assert.equal(accepts(formp({ ...baseForm(), table: { ...baseForm().table!, rows: 22.6 } }), 'rows 22.6').profiles[3].options.layout!.form!.table!.rows, 23);
  // الأعمدة
  const cols = (columns: unknown[]): PrintForm => ({ ...baseForm(), table: { ...baseForm().table!, columns: columns as never } });
  rejects(formp(cols([])), I.layoutFormColumn, 'no columns');
  rejects(formp(cols([{ id: 'qty', x: 10, w: 10 }, { id: 'qty', x: 30, w: 10 }])), I.layoutFormColumn, 'duplicate column');
  rejects(formp(cols([{ id: 'qty', x: 10, w: 3.5 }])), I.layoutFormColumn, 'narrow');
  rejects(formp(cols([{ id: 'qty', x: 200, w: 10.5 }])), I.layoutFormColumn, 'out of width');
  rejects(formp(cols([{ id: 'qty', x: -1, w: 10 }])), I.layoutFormColumn, 'x<0');
  rejects(formp(cols([{ id: 'qty', x: 'a', w: 10 }])), I.layoutFormColumn, 'column type');
  rejects(formp(cols([{ id: 'stock', x: 10, w: 10 }])), I.layoutFormColumn, 'unknown column id');
  const thirteen = Array.from({ length: 13 }, (_, i) => ({ id: FORM_COLUMN_IDS[i % 10], x: i * 15, w: 15 }));
  rejects(formp(cols(thirteen)), I.layoutFormColumn, '13 columns');
  // المعايرة والصورة
  for (const dxMm of [20.1, -21, NaN]) rejects(formp({ ...baseForm(), dxMm }), I.layoutFormOffset, `dx ${dxMm}`);
  rejects(formp({ ...baseForm(), dyMm: 'x' as never }), I.layoutFormOffset, 'dy type');
  for (const [label, image] of [
    ['id', { ...IMG, id: 'logo.png' }], ['v', { ...IMG, v: 'XYZ' }], ['v short', { ...IMG, v: 'abc' }], ['w small', { ...IMG, wPx: 199 }], ['h big', { ...IMG, hPx: 10001 }],
    ['fraction', { ...IMG, wPx: 1240.5 }], ['data url', 'data:image/png;base64,AAAA'], ['number', 5],
  ] as Array<[string, unknown]>) rejects(formp({ ...baseForm(), image: image as never }), I.layoutFormImage, `image ${label}`);
  // الأنواع الخاطئة في الحقول والجدول برسالة قاعدتها
  rejects(formp(withField({ id: 'docNumber', x: '10' as never })), I.layoutFormField, 'field x type');
  rejects(formp(withField({ id: 'unknown' as never })), I.layoutFormField, 'field id');
  rejects(formp({ ...baseForm(), table: { ...baseForm().table!, rows: 'x' as never } }), I.layoutFormTable, 'rows type');
  rejects(formp({ ...baseForm(), valueLang: 'fr' as never }), I.shape, 'valueLang');
  rejects(formp({ ...baseForm(), background: 'yes' as never }), I.shape, 'background');
});

test('النموذج: مفتاحٌ مجهول في أي مستوى ⇒ 400 «حقل غير معروف» (الصارم) — ولا صور داخل الإعداد', () => {
  for (const mut of [
    (f: Record<string, any>) => { f.scale = 2; },
    (f: Record<string, any>) => { f.fields[0].rotate = 90; },
    (f: Record<string, any>) => { f.table.header = true; },
    (f: Record<string, any>) => { f.table.columns[0].label = 'الكمية'; },
    (f: Record<string, any>) => { f.image = { ...IMG, dataUrl: 'data:image/png;base64,AAAA' }; },
  ]) {
    const form = clone(baseForm()) as unknown as Record<string, any>;
    mut(form);
    const r = messages(fleetWith(formp(form as PrintForm)));
    assert.deepEqual([r.status, r.message], [400, PRINT_ISSUES.unknownKey], JSON.stringify(form));
  }
});

test('النموذج: التوجيه للفواتير وحدها، ولا يكون قالب PDF، و4 قوالب على الأكثر', () => {
  const I = PRINT_ISSUES;
  const s = fleetWith(formp());
  assert.equal(checkPrintSettings(s, true).ok, true);
  for (const kind of ['receipt', 'statement', 'notices'] as const) {
    const r = messages({ ...s, routing: { ...s.routing, [kind]: 'murouj' } });
    assert.equal(r.status, 400, kind);
    assert.ok(r.all.includes(I.routeForm), `${kind}: ${JSON.stringify(r.all)}`);
  }
  const pdf = messages({ ...s, pdfProfileId: 'murouj' });
  assert.ok(pdf.status === 400 && pdf.all.includes(I.pdfForm), JSON.stringify(pdf));
  // وقالبٌ غير موجَّه يُحفظ (يختاره الجهاز للفاتورة إن سمحت الشركة)
  assert.equal(checkPrintSettings({ ...s, routing: fleet().routing }, true).ok, true);
  const forms = (n: number): PrintSettingsV1 => ({
    ...fleet(),
    profiles: [...fleet().profiles, ...Array.from({ length: n }, (_, i) => ({ ...formp(baseForm(), {}, 'preprinted', `form-${i}`), name: `نموذج ${i}` }))],
  });
  assert.equal(checkPrintSettings(forms(4), true).ok, true);
  const five = messages(forms(5));
  assert.ok(five.status === 400 && five.all.includes(I.formsCount), JSON.stringify(five));
});

test('النموذج: الصورة القانونية — مفاتيح بترتيبٍ ثابت بلا undefined، والحقول بترتيب المعرّفات والأعمدة من اليسار، والمم بخطوة 0.5', () => {
  const form: PrintForm = {
    table: {
      columns: [{ align: 'end', w: 10.2, x: 120.26, id: 'qty' }, { w: 50, id: 'description', x: 70.1 }, { x: 70.1, id: 'sr', w: 4.6 }],
      fontPct: 90.4, rows: 23, rowMm: 6.954, y: 105.3,
    },
    fields: [
      { bold: true, h: 22, w: 22, y: 268, x: 12, id: 'qr' },
      { fontPct: 119.6, align: 'center', h: 6.2, w: 40.26, y: 40.1, x: 150.24, id: 'docNumber' },
      { id: 'totalDue', x: 120, y: 276, w: 40, h: 6, align: undefined, bold: undefined },
    ],
    valueLang: 'en', latinDigits: false, background: true, dyMm: -1.26, dxMm: 0.04, image: { hPx: 1754, wPx: 1240, v: IMG.v, id: IMG.id },
  } as PrintForm;
  const v = accepts(formp(form, { stamps: false, sections: { qr: { visible: false } } }), 'canonical');
  const l = v.profiles[3].options.layout!;
  assert.deepEqual(Object.keys(l), ['design', 'logo', 'logoSize', 'accent', 'tableStyle', 'order', 'sections', 'stamps', 'form'], 'form آخر المفاتيح');
  const f = l.form!;
  assert.deepEqual(Object.keys(f), ['image', 'dxMm', 'dyMm', 'background', 'latinDigits', 'valueLang', 'fields', 'table']);
  assert.deepEqual(f.image, IMG);
  assert.deepEqual(Object.keys(f.image!), ['id', 'v', 'wPx', 'hPx']);
  assert.deepEqual([f.dxMm, f.dyMm], [0, -1.3]);
  assert.equal(JSON.stringify(f.fields), JSON.stringify([
    { id: 'docNumber', x: 150, y: 40, w: 40.5, h: 6, align: 'center', fontPct: 120 },
    { id: 'totalDue', x: 120, y: 276, w: 40, h: 6 },
    { id: 'qr', x: 12, y: 268, w: 22, h: 22, bold: true },
  ]));
  assert.equal(JSON.stringify(f.table), JSON.stringify({
    y: 105.5, rowMm: 6.95, rows: 23, fontPct: 90,
    columns: [{ id: 'sr', x: 70, w: 4.5 }, { id: 'description', x: 70, w: 50 }, { id: 'qty', x: 120.5, w: 10, align: 'end' }],
  }));
  assert.ok(!JSON.stringify(v).includes('undefined'));
  // متساوي القوى: ما حُفظ يُحفظ كما هو، والقراءة المتسامحة = الحفظ
  const again = checkPrintSettings(clone(v), true);
  assert.ok(again.ok);
  assert.equal(JSON.stringify((again as { value: PrintSettingsV1 }).value), JSON.stringify(v));
  const read = storedPrintSettings(clone(v));
  assert.equal(read.stored, true);
  assert.equal(JSON.stringify(read.settings), JSON.stringify(v));
  // بلا تصميم النموذج لا يظهر المفتاح، والتخطيط الستة كما هو
  const plain = accepts({ ...formp(null, {}, 'standard'), id: 'plain' }, 'plain').profiles[3].options.layout!;
  assert.deepEqual(Object.keys(plain), ['design', 'logo', 'logoSize', 'accent', 'tableStyle', 'order']);
});

test('النموذج: القراءة المتسامحة تُسقط الحقل أو العمود المعطوب وحده — وتُسقط التخطيط إن بقي النموذج غير صالح', () => {
  const good = (): PrintSettingsV1 => fleetWith(formp({ ...baseForm(), image: IMG }));
  const readBack = (mut: (f: Record<string, any>, l: Record<string, any>) => void): PrintLayout | undefined => {
    const raw = clone(good()) as unknown as { profiles: Array<{ options: { layout: Record<string, any> } }> };
    mut(raw.profiles[3].options.layout.form, raw.profiles[3].options.layout);
    assert.equal(checkPrintSettings(raw, true).ok, false, 'الحفظ يرفضه');
    const read = storedPrintSettings(raw);
    assert.equal(read.stored, true, 'الإعداد كله يبقى');
    assert.equal(read.settings.profiles.length, 4);
    assert.equal(read.settings.routing.invoice, 'murouj');
    return read.settings.profiles[3].options.layout;
  };
  const ids = (l: PrintLayout | undefined): string[] => l!.form!.fields.map((x) => x.id);
  const base = baseForm().fields.map((x) => x.id);
  // حقلٌ من نسخةٍ أحدث، أو خارج الورقة، أو مكرر، أو بنوعٍ خاطئ: يسقط وحده
  assert.deepEqual(ids(readBack((f) => { f.fields.push({ id: 'amountInWords', x: 10, y: 10, w: 50, h: 6 }); })), base);
  assert.deepEqual(ids(readBack((f) => { f.fields[1].x = 400; })), base.filter((id) => id !== 'docDate'));
  assert.deepEqual(ids(readBack((f) => { f.fields.push({ ...f.fields[0], x: 1 }); })), base);
  assert.deepEqual(ids(readBack((f) => { f.fields[1].w = 'wide'; })), base.filter((id) => id !== 'docDate'));
  // مفتاحٌ مجهول في حقل يُحذف وحده والحقل يبقى
  const extra = readBack((f) => { f.fields[0].rotate = 90; f.table.zebra = true; });
  assert.deepEqual(extra!.form!.fields[0], baseForm().fields[0]);
  assert.ok(!('zebra' in extra!.form!.table!));
  // خطٌّ خارج حدوده يسقط وحده (الحقل يبقى)
  const font = readBack((f) => { f.fields[1].fontPct = 500; f.table.fontPct = 10; });
  assert.deepEqual(font!.form!.fields[1], { id: 'docDate', x: 150, y: 47, w: 40, h: 6, align: 'center' });
  assert.ok(!('fontPct' in font!.form!.table!));
  // عمودٌ من نسخةٍ أحدث أو ضيّق يسقط وحده
  assert.deepEqual(readBack((f) => { f.table.columns.push({ id: 'weight', x: 150, w: 10 }); })!.form!.table!.columns.map((c) => c.id), ['description', 'qty']);
  assert.deepEqual(readBack((f) => { f.table.columns[1].w = 2; })!.form!.table!.columns.map((c) => c.id), ['description']);
  // الصفوف التي لا يتّسع لها الورق تُقصّ، والمعايرة تُقصّ إلى ±20، والصورة المعطوبة null، ولغة قيمٍ مجهولة ⇒ العربية
  assert.equal(readBack((f) => { f.table.y = 200; })!.form!.table!.rows, Math.floor(97 / 7));
  assert.deepEqual([readBack((f) => { f.dxMm = 50; f.dyMm = -33; })!.form!.dxMm, readBack((f) => { f.dyMm = -33; })!.form!.dyMm], [20, -20]);
  assert.equal(readBack((f) => { f.image.id = 'not-uuid'; })!.form!.image, null);
  assert.equal(readBack((f) => { f.image = 'data:image/png;base64,AAAA'; })!.form!.image, null);
  assert.equal(readBack((f) => { f.valueLang = 'ur'; })!.form!.valueLang, 'ar');
  // ما بقي غير صالح يُسقط التخطيط وحده (فيطبع القالب page_plain تصميم اليوم): رمز QR سقط ولم يُحذف صراحةً، وجدولٌ بلا عمود، وبنيةٌ معطوبة
  for (const [label, mut] of [
    ['qr small', (f: Record<string, any>) => { f.fields[3].w = 10; }],
    ['no columns left', (f: Record<string, any>) => { f.table.columns = [{ id: 'weight', x: 1, w: 9 }]; }],
    ['fields not array', (f: Record<string, any>) => { f.fields = 'all'; }],
    ['table broken', (f: Record<string, any>) => { f.table = { y: 1 }; }],
    ['no background', (f: Record<string, any>) => { delete f.background; }],
    ['form missing', (_f: Record<string, any>, l: Record<string, any>) => { delete l.form; }],
  ] as Array<[string, (f: Record<string, any>, l: Record<string, any>) => void]>) {
    assert.equal(readBack(mut), undefined, label);
  }
  // طابعةٌ تغيّرت في نسخةٍ أحدث (طلب المالك ١٣ نوفمبر ٢٠٢٦: النقطية تقبل النموذج بقواعدها): نموذج الصفحة نفسه على النقطية
  // بمربع QR 22 مم أصغر من حدّها (55) — يسقط الرمز ولم يُحذف صراحةً فيسقط التخطيط وحده؛ وبمربع 55 داخل الحزمة يبقى النموذج كله
  // وتُطفأ خلفيته؛ وعلى الحرارية (ولو بورق A4) يسقط التخطيط كما كان
  const moved = (printer: 'impact' | 'thermal', template: PrintProfile['template'], preset: Parameters<typeof presetPaper>[0], mut?: (f: Record<string, any>) => void): PrintLayout | undefined => {
    const raw = clone(good());
    if (mut) mut(raw.profiles[3].options.layout!.form as unknown as Record<string, any>);
    raw.profiles[3] = { ...raw.profiles[3], printer, template, paper: presetPaper(preset)! };
    raw.profiles[3].options = { ...defaultPrintOptions(printer), layout: raw.profiles[3].options.layout };
    raw.routing.invoice = 'murouj';
    const back = storedPrintSettings(raw);
    assert.equal(back.stored, true, `${printer}/${preset}`);
    assert.equal(back.settings.profiles[3].printer, printer);
    return back.settings.profiles[3].options.layout;
  };
  assert.equal(moved('impact', 'impact_plain', 'ff_a4'), undefined, 'impact: qr 22 < 55');
  const kept = moved('impact', 'impact_plain', 'ff_a4', (f) => { f.fields[3] = { id: 'qr', x: 12, y: 226, w: 55, h: 55 }; f.background = true; });
  assert.deepEqual(ids(kept), base, 'impact: qr 55 inside the band');
  assert.equal(kept!.form!.background, false, 'impact: background off');
  assert.deepEqual(kept!.form!.image, IMG);
  for (const preset of ['roll80', 'roll_a4'] as const) assert.equal(moved('thermal', 'roll_compact', preset), undefined, `thermal ${preset}`);
  // والمواضع على تصميمٍ آخر (نسخةٌ أحدث غيّرت التصميم) تسقط وحدها والتصميم يبقى
  const other = readBack((_f, l) => { l.design = 'standard'; });
  assert.equal(other!.design, 'standard');
  assert.ok(!('form' in other!));
});

test('النموذج: layoutIssues تحمل المسار options.layout.form للعرض بجوار الأداة', () => {
  const p = formp(withField({ id: 'docDate', x: 400 }));
  const iss = layoutIssues(p, 'profiles[3]');
  assert.deepEqual(iss, [{ path: 'profiles[3].options.layout.form.fields[1]', message: PRINT_ISSUES.layoutFormField }]);
  const missing = layoutIssues(formp(null), 'p');
  assert.deepEqual(missing, [{ path: 'p.options.layout.form', message: PRINT_ISSUES.layoutFormMissing }]);
});

test('النموذج: الحجم — أربعة نماذج بأسوأ حالاتها مع ستة تصاميم حرّة بأسوأ حالاتها (اثنا عشر قالباً) تحت 48 كيلوبايت', () => {
  const full = legacyPrintSettings();
  const style = { visible: true, align: 'center' as const, fontPct: 155, spaceBeforeMm: 29.5, spaceAfterMm: 29.5 };
  for (let i = 0; full.profiles.length < PRINT_LIMITS.maxProfiles - PRINT_LIMITS.maxForms; i++) {
    const p = profile({ id: `long-name-${i}`, name: `${i}`.padEnd(40, 'ق'), printer: 'impact', template: 'impact_plain' }, 'ff_a4');
    p.options.layout = {
      ...defaultPrintLayout('impact'), accent: '#1D4ED8', logoMm: 119.5, logoAfter: 'installments',
      sections: { ...Object.fromEntries(sectionsFor('impact', 'standard').map((id) => [id, style])), qr: { visible: false } },
      stamps: false,
      canvas: {
        headerMm: 80, footerMm: 120,
        boxes: CANVAS_BOX_IDS.map((id, k) => ({ ...(id === 'qr' ? { id, band: 'footer' as const, x: 0, y: 0, w: 47, h: 47 } : { id, band: 'footer' as const, x: 100.5, y: k * 13, w: 100.5, h: 12.5 }), align: 'center' as const, fontPct: 155 })),
      },
    };
    p.options.footerText = 'ذ'.repeat(160);
    full.profiles.push(p);
  }
  // أسوأ نموذج: الحقول الاثنان والثلاثون بكل تنسيق، والأعمدة العشرة، والجدول بخطّه، والصورة، والمعايرة
  const worst: PrintForm = {
    image: { ...IMG, v: 'f'.repeat(64), wPx: 10000, hPx: 10000 }, dxMm: -19.9, dyMm: -19.9, background: true, latinDigits: false, valueLang: 'en',
    fields: FORM_FIELD_IDS.map((id, i) => ({ id, x: (i % 4) * 50 + 0.5, y: Math.floor(i / 4) * 20 + 0.5, w: 49.5, h: 19.5, align: 'center' as const, fontPct: 155, bold: true })),
    table: { y: 170.5, rowMm: 6.25, rows: 19, fontPct: 155, columns: FORM_COLUMN_IDS.map((id, i) => ({ id, x: 0.5 + i * 20.5, w: 20.5, align: 'center' as const })) },
  };
  for (let i = 0; i < PRINT_LIMITS.maxForms; i++) {
    const p = { ...formp(worst, { sections: { qr: { visible: false } }, stamps: false }, 'preprinted', `form-long-${i}`), name: `${i}`.padEnd(40, 'ن') };
    p.options.footerText = 'ذ'.repeat(160);
    full.profiles.push(p);
  }
  assert.equal(full.profiles.length, PRINT_LIMITS.maxProfiles);
  const bytes = printSettingsBytes(full);
  const r = parsePrintSettings(full);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues.slice(0, 3)));
  assert.ok(bytes < PRINT_LIMITS.maxBytes, `${bytes}`);
});

// ─── النموذج على النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦): حزمة الإبرة في منتصف الورقة، ورمز QR ≥ 55، ولا خلفية ───

test('النموذج على النقطية: formReachX حزمة الإبرة في منتصف الورقة بلا إزاحة ولا هوامش، وحدّ رمز QR 55 مم', () => {
  const near = (got: readonly [number, number] | null, want: [number, number], label: string): void => {
    assert.ok(got, `${label}: null`);
    assert.ok(Math.abs(got![0] - want[0]) < 1e-9 && Math.abs(got![1] - want[1]) < 1e-9, `${label}: ${JSON.stringify(got)}`);
  };
  const impact = (preset: Parameters<typeof presetPaper>[0], over: Record<string, unknown> = {}): Pick<PrintProfile, 'printer' | 'paper'> =>
    ({ printer: 'impact', paper: { ...presetPaper(preset)!, ...over } }) as unknown as Pick<PrintProfile, 'printer' | 'paper'>;
  near(formReachX(impact('ff_a4')), [3.4, 206.6], 'A4 @1440');
  near(formReachX(impact('cut_a4')), [3.4, 206.6], 'cut A4');
  near(formReachX(impact('ff_95x11')), [18.9, 222.1], '241 mm');
  near(formReachX(impact('ff_95x55')), [18.9, 222.1], '241 mm half page');
  near(formReachX(impact('ff_85x11')), [12.75, 203.25], '216 mm @1350');
  // الإزاحة الأفقية والهامشان لا أثر لها (المعايرة dxMm/dyMm وحدها)، وحزمةٌ أضيق تبقى في المنتصف
  near(formReachX(impact('ff_a4', { offsetXmm: 5, marginTopMm: 20, marginBottomMm: 20 })), [3.4, 206.6], 'offset and margins ignored');
  near(formReachX(impact('ff_a4', { printableDots: 1080 })), [28.8, 181.2], '1080 dots (152.4 mm) centred');
  // غير النقطية، أو بلا دقةٍ أو نقاطٍ صالحة: null
  assert.equal(formReachX({ printer: 'page', paper: presetPaper('a4')! }), null);
  assert.equal(formReachX({ printer: 'thermal', paper: presetPaper('roll_a4')! }), null);
  assert.equal(formReachX({ printer: 'thermal', paper: presetPaper('roll80')! }), null);
  for (const [label, over] of [
    ['dpi null', { dpi: null }], ['dpi 150', { dpi: 150 }], ['dots null', { printableDots: null }], ['dots 0', { printableDots: 0 }],
    ['dots 1440.5', { printableDots: 1440.5 }], ['width NaN', { widthMm: NaN }], ['width 0', { widthMm: 0 }],
  ] as Array<[string, Record<string, unknown>]>) assert.equal(formReachX(impact('ff_a4', over)), null, label);
  assert.equal(FORM_IMPACT_QR_MIN_MM, 55);
  assert.deepEqual([formQrMinMm('impact'), formQrMinMm('page'), formQrMinMm('thermal')], [55, FORM_BOUNDS.qrMinMm, FORM_BOUNDS.qrMinMm]);
  assert.equal(FORM_BOUNDS.qrMinMm, 18, 'FORM_BOUNDS لا يتغيّر');
});

test('النموذج على النقطية: الصالح يُحفظ على كل ورق MIP480 — والقراءة المتسامحة تعيده كما هو', () => {
  for (const preset of ['ff_a4', 'cut_a4', 'ff_95x11', 'ff_95x12', 'ff_85x11'] as const) {
    const { widthMm, lengthMm } = presetPaper(preset)!;
    const v = accepts(impactp(impactForm(widthMm, lengthMm!), preset), preset);
    const l = v.profiles[3].options.layout!;
    assert.equal(l.design, 'preprinted', preset);
    assert.deepEqual(l.form!.fields.map((x) => x.id), ['docNumber', 'docDate', 'totalDue', 'qr'], preset);
    assert.equal(l.form!.table!.rows, 16, preset);
    const read = storedPrintSettings(clone(v));
    assert.equal(read.stored, true, preset);
    assert.equal(JSON.stringify(read.settings), JSON.stringify(v), `${preset}: القراءة = الحفظ`);
  }
  // نصف الصفحة المتصلة (139.7 مم): نموذجٌ مضغوط برمز 55
  const half: PrintForm = {
    ...impactForm(),
    fields: [{ id: 'docNumber', x: 170, y: 10, w: 40, h: 6 }, { id: 'qr', x: 20, y: 80, w: 55, h: 55 }],
    table: { y: 30, rowMm: 6, rows: 8, columns: [{ id: 'description', x: 80, w: 80 }, { id: 'qty', x: 165, w: 15 }] },
  };
  accepts(impactp(half, 'ff_95x55'), 'ff_95x55');
  // بقالب impact_plain كذلك (النواة لا تشترط القالب)، وبصورةٍ دليلاً بلا خلفية، وبمعايرةٍ تُبقي كل شيءٍ في الحزمة
  accepts({ ...impactp(), template: 'impact_plain' }, 'impact_plain');
  accepts(impactp({ ...impactForm(), image: IMG }), 'image as a guide');
  accepts(impactp({ ...impactForm(), dxMm: -8.6, dyMm: 12 }), 'offsets inside the band');
  // بلا رمز QR مع الحذف الصريح، والحقل حتى طرف الحزمة تماماً بعد المعايرة
  accepts(impactp({ ...impactForm(), fields: impactForm().fields.filter((f) => f.id !== 'qr') }, 'ff_a4', { sections: { qr: { visible: false } } }), 'qr removed');
  accepts(impactp(withImpactField({ id: 'docNumber', x: 160, w: 46.5 })), 'right edge 206.5');
  // والصفحة كما كانت: رمز 18 صالح، وحقلٌ فوق أول سطرٍ بعد المعايرة لا قيد عليه
  accepts(formp(withField({ id: 'qr', w: 18, h: 18 })), 'page qr 18');
  accepts(formp({ ...withField({ id: 'docNumber', y: 1 }), dyMm: -2 }), 'page: y + dy < 0');
  accepts(formp(withField({ id: 'docNumber', x: 1 })), 'page: x 1');
});

test('النموذج على النقطية: كل حدٍّ جديد يُرفض 400 برسالته — ما لا تبلغه الإبرة بعد المعايرة، ورمز QR دون 55، والخلفية', () => {
  const I = PRINT_ISSUES;
  // رمز QR: 54.5 مرفوض على النقطية (و18 صالحٌ على الصفحة أعلاه)
  rejects(impactp(withImpactField({ id: 'qr', w: 54.5, h: 54.5 })), I.layoutFormQrImpact, 'qr 54.5');
  rejects(impactp(withImpactField({ id: 'qr', h: 54.5 })), I.layoutFormQrImpact, 'qr h 54.5');
  rejects(impactp(withImpactField({ id: 'qr', w: 22, h: 22 })), I.layoutFormQrImpact, 'qr 22');
  // حقلٌ خارج الحزمة: x = 2 على A4 (الحزمة من 3.4)، وطرفه الأيمن 207 (داخل الورقة 210)
  rejects(impactp(withImpactField({ id: 'docNumber', x: 2 })), I.layoutFormReach, 'x 2');
  rejects(impactp(withImpactField({ id: 'docNumber', x: 170, w: 37 })), I.layoutFormReach, 'right edge 207');
  // حقلٌ داخل الحزمة تُخرجه المعايرة الأفقية: 160 + 46 = 206 ثم +1
  accepts(impactp(withImpactField({ id: 'docNumber', x: 160, w: 46 })), 'in band at 206');
  rejects(impactp({ ...withImpactField({ id: 'docNumber', x: 160, w: 46 }), dxMm: 1 }), I.layoutFormReach, 'pushed right by dx');
  rejects(impactp({ ...impactForm(), dxMm: -9 }), I.layoutFormReach, 'qr pushed left by dx (12 − 9 < 3.4)');
  // فوق أول سطرٍ تطبعه الإبرة (y + dy < 0) أو بعد طول الصفحة بعد المعايرة
  accepts(impactp(withImpactField({ id: 'docNumber', y: 1 })), 'y 1');
  rejects(impactp({ ...withImpactField({ id: 'docNumber', y: 1 }), dyMm: -2 }), I.layoutFormReach, 'y + dy < 0');
  rejects(impactp({ ...impactForm(), dyMm: 17 }), I.layoutFormReach, 'qr past L after dy (226 + 55 + 17)');
  // الأعمدة: خارج الحزمة يساراً أو يميناً أو بالمعايرة — وخارج الورقة برسالتها كما كانت
  rejects(impactp(impactCols([{ id: 'description', x: 2, w: 50 }, { id: 'qty', x: 120, w: 10 }])), I.layoutFormReach, 'column x 2');
  rejects(impactp(impactCols([{ id: 'description', x: 70, w: 50 }, { id: 'qty', x: 200, w: 8 }])), I.layoutFormReach, 'column right edge 208');
  rejects(impactp({ ...impactCols([{ id: 'description', x: 4, w: 50 }]), dxMm: -1 }), I.layoutFormReach, 'column pushed left by dx');
  rejects(impactp(impactCols([{ id: 'qty', x: 205, w: 6 }])), I.layoutFormColumn, 'column off the paper');
  // الجدول: آخره بعد طول الصفحة بعد المعايرة، أو أوله فوق أول سطر
  const low = (): PrintForm => ({ ...impactForm(), table: { ...impactForm().table!, y: 200, rows: 13 } });
  accepts(impactp(low()), 'table ends at 291');
  rejects(impactp({ ...low(), dyMm: 7 }), I.layoutFormReach, 'table past L after dy');
  rejects(impactp({ ...impactForm(), dyMm: -20, table: { ...impactForm().table!, y: 10 } }), I.layoutFormReach, 'table above the first line');
  // الخلفية: النقطية لا تطبعها
  rejects(impactp({ ...impactForm(), background: true }), I.layoutFormBgImpact, 'background');
  rejects(impactp({ ...impactForm(), image: IMG, background: true }), I.layoutFormBgImpact, 'background with image');
  // المسار لكل رسالة (للعرض بجوار الأداة) — ورسالة الطابعة لا تظهر للنقطية
  const at = (p: PrintProfile) => layoutIssues(p, 'p');
  assert.deepEqual(at(impactp({ ...impactForm(), background: true })), [{ path: 'p.options.layout.form.background', message: I.layoutFormBgImpact }]);
  assert.deepEqual(at(impactp(withImpactField({ id: 'docNumber', x: 2 }))), [{ path: 'p.options.layout.form.fields[0]', message: I.layoutFormReach }]);
  assert.deepEqual(at(impactp(withImpactField({ id: 'qr', w: 54.5 }))), [{ path: 'p.options.layout.form.fields[3]', message: I.layoutFormQrImpact }]);
  assert.deepEqual(at(impactp(impactCols([{ id: 'description', x: 70, w: 50 }, { id: 'qty', x: 200, w: 8 }]))), [{ path: 'p.options.layout.form.table.columns[1]', message: I.layoutFormReach }]);
  assert.deepEqual(at(impactp({ ...low(), dyMm: 7 })), [{ path: 'p.options.layout.form.table', message: I.layoutFormReach }]);
  assert.deepEqual(at(impactp(null)), [{ path: 'p.options.layout.form', message: I.layoutFormMissing }]);
  assert.deepEqual(at(impactp()), []);
});

test('النموذج على النقطية: القراءة المتسامحة تُسقط ما لا تبلغه الإبرة وحده وتُطفئ الخلفية — ورمز QR دون 55 يُسقط التخطيط', () => {
  const good = (): PrintSettingsV1 => fleetWith(impactp({ ...impactForm(), image: IMG }));
  accepts(impactp({ ...impactForm(), image: IMG }), 'good');
  const readBack = (mut: (f: Record<string, any>) => void): PrintLayout | undefined => {
    const raw = clone(good()) as unknown as { profiles: Array<{ options: { layout: Record<string, any> } }> };
    mut(raw.profiles[3].options.layout.form);
    assert.equal(checkPrintSettings(raw, true).ok, false, 'الحفظ يرفضه');
    const read = storedPrintSettings(raw);
    assert.equal(read.stored, true, 'الإعداد كله يبقى');
    assert.equal(read.settings.routing.invoice, 'mip-form');
    return read.settings.profiles[3].options.layout;
  };
  const ids = (l: PrintLayout | undefined): string[] => l!.form!.fields.map((x) => x.id);
  const base = impactForm().fields.map((x) => x.id);
  // حقلٌ خارج الحزمة يسقط وحده والتخطيط يبقى
  assert.deepEqual(ids(readBack((f) => { f.fields[0].x = 2; })), base.filter((id) => id !== 'docNumber'));
  // الخلفية تصير false والنموذج كله يبقى
  const bg = readBack((f) => { f.background = true; });
  assert.equal(bg!.form!.background, false);
  assert.deepEqual(ids(bg), base);
  assert.deepEqual(bg!.form!.image, IMG);
  // عمودٌ خارج الحزمة يسقط وحده
  assert.deepEqual(readBack((f) => { f.table.columns[1].x = 200; f.table.columns[1].w = 8; })!.form!.table!.columns.map((c: FormColumn) => c.id), ['description']);
  // المعايرة تُقصّ أولاً ثم تُقاس بها الحزمة: dx 50 ⇒ 20، فيسقط ما يتجاوز 206.6 بعدها ويبقى رمز QR والعمودان
  const shifted = readBack((f) => { f.dxMm = 50; });
  assert.equal(shifted!.form!.dxMm, 20);
  assert.deepEqual(ids(shifted), ['qr']);
  assert.deepEqual(shifted!.form!.table!.columns.map((c) => c.id), ['description', 'qty']);
  // الصفوف تُقصّ بالمعايرة الرأسية: من 200 بـ13 صفاً (291) ومعايرة +7 ⇒ floor((297 − 7 − 200) / 7) = 12
  assert.equal(readBack((f) => { f.table.y = 200; f.table.rows = 13; f.dyMm = 7; })!.form!.table!.rows, 12);
  // وما بقي معطوباً يُسقط التخطيط وحده: رمز QR دون 55 (نموذج الصفحة القديم) أو خارج الحزمة، ولم يُحذف صراحةً
  assert.equal(readBack((f) => { f.fields[3].w = 22; f.fields[3].h = 22; }), undefined, 'qr 22');
  assert.equal(readBack((f) => { f.fields[3].w = 54.5; }), undefined, 'qr 54.5');
  assert.equal(readBack((f) => { f.fields[3].x = 2; }), undefined, 'qr outside the band');
});
