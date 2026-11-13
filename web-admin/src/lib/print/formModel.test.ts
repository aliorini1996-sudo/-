// «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — نموذج الواجهة الخالص lib/print/formModel.ts: الورقة والأوراق،
// والبداية المقترحة، والمحرّرات (كل ناتجٍ صالحٌ بقواعد النواة وقانونيٌّ كما يحفظه الخادم حرفياً)، والتسميات المترجمة، والتنبيهات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FORM_BASE_FONT_PT, FORM_BOUNDS, FORM_COLUMN_IDS, FORM_COLUMN_LABELS, FORM_FIELD_GROUPS, FORM_FIELD_IDS, FORM_FIELD_LABELS, FORM_IMAGE_DPI,
  FORM_LAST_SHEET_IDS, FORM_NOTES, FORM_REF_SHEET, FORM_TAX_COLUMN_IDS, FORM_TAX_FIELD_IDS, FORM_VALUE_LANG_LABELS, FORM_WARNINGS,
  defaultFormColumn, defaultFormField, defaultFormTable, fitForm, formFieldMinMm, formFontPt, formIssues, formOf, formOverlaps, formQrMissing,
  formPaperOf, formReachBox, formReachOf,
  formRasterPx, formSheetSize, formSheets, formTableBox, formWarnings, isLastSheetField, moveFormColumn, moveFormField, moveFormTable,
  printedBox, reorderFormColumn, resetFormPositions, scaleForm, sheetFields, starterForm, tableRowTop, withForm, withFormColumn, withFormField,
  withFormProps, withFormTable, withoutFormColumn, withoutFormField,
  type FormColumnId, type FormFieldId, type PrintForm,
} from './formModel';
import {
  LAYOUT_BOUNDS, PRINT_ISSUES, checkPrintSettings, legacyPrintSettings, newProfile, presetPaper, profileIssues, withDesign, withLayout,
  type Paper, type PrintProfile, type PrintSettingsV1,
} from './printSettings';
import { withQrRemoved } from './designModel';
import { PHRASES } from '../../i18n/strings';

const A4 = presetPaper('a4') as Paper;
const A5 = presetPaper('a5') as Paper;
const LETTER = presetPaper('letter') as Paper;
const IMG = { id: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b', v: 'abcdef0123456789', wPx: 1240, hPx: 1754 };

/** قالب طابعة عادية بتصميم النموذج على هذا الورق */
const formProfile = (paper: Paper = A4): PrintProfile => withDesign({ ...newProfile('page', 'نموذج', []), paper }, 'preprinted');
const withF = (p: PrintProfile, form: PrintForm): PrintProfile => ({ ...p, options: { ...p.options, layout: { ...p.options.layout!, form } } });
const issues = (p: PrintProfile): string[] => profileIssues(p, 'p').map((i) => i.message);
/** ما يحفظه الخادم (الصارم ثم القانوني) لهذا النموذج */
function saved(p: PrintProfile): PrintForm {
  const s: PrintSettingsV1 = { ...legacyPrintSettings(), profiles: [...legacyPrintSettings().profiles, p] };
  const r = checkPrintSettings(s, true);
  assert.ok(r.ok, JSON.stringify(r));
  return (r as { value: PrintSettingsV1 }).value.profiles[2].options.layout!.form!;
}
/** صالحٌ بقواعد النواة، وقانونيٌّ: الخادم يحفظه حرفياً (بترتيب المفاتيح نفسه) */
function valid(p: PrintProfile, why = ''): void {
  assert.deepEqual(issues(p), [], `${why} ${JSON.stringify(p.options.layout?.form)}`);
  assert.equal(JSON.stringify(saved(p)), JSON.stringify(p.options.layout!.form), `${why}: ليس قانونياً`);
}
const onGrid = (v: number): boolean => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;

// النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦، MIP480): ورق النموذج يحمل ما تبلغه الإبرة (formPaperOf)
const FF_A4 = presetPaper('ff_a4') as Paper;
const CUT_A4 = presetPaper('cut_a4') as Paper;
const FF_WIDE = presetPaper('ff_95x11') as Paper;
const FF_85 = presetPaper('ff_85x11') as Paper;
const FF_HALF = presetPaper('ff_95x55') as Paper;
const IMPACT_PAPERS: readonly Paper[] = ['cut_a4', 'ff_a4', 'ff_95x11', 'ff_95x12', 'ff_85x11', 'ff_95x55'].map((id) => presetPaper(id as Paper['preset']) as Paper);
/** ورق النموذج النقطي (بلا هامشين كما يضعه withDesign) */
const ip = (paper: Paper = FF_A4) => formPaperOf({ printer: 'impact', paper: { ...paper, marginTopMm: 0, marginBottomMm: 0 } });
/** قالب نقطي بتصميم النموذج على هذا الورق */
const impactProfile = (paper: Paper = FF_A4): PrintProfile => withDesign({ ...newProfile('impact', 'نقطي', []), paper }, 'preprinted');
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
const box6 = (b: { x: number; y: number; w: number; h: number } | null) => (b ? [b.x, b.y, b.w, b.h].map((v) => Math.round(v * 1e6) / 1e6) : b);

// ─── الورقة والأوراق ───

test('formSheetSize / formRasterPx / formFontPt / printedBox / tableRowTop / formTableBox', () => {
  assert.deepEqual(formSheetSize(null), { widthMm: 210, lengthMm: 297 });
  assert.deepEqual(formSheetSize({ widthMm: 148, lengthMm: null }), { widthMm: 148, lengthMm: 297 }, 'بلا طول ⇒ طول A4');
  assert.deepEqual(formSheetSize(A5), { widthMm: 148, lengthMm: 210 });
  assert.deepEqual(FORM_REF_SHEET, { widthMm: 210, lengthMm: 297 });
  assert.equal(FORM_IMAGE_DPI, 150);
  assert.deepEqual(formRasterPx(A4), { wPx: 1240, hPx: 1754 });
  assert.deepEqual(formRasterPx(A5), { wPx: 874, hPx: 1240 });
  assert.equal(FORM_BASE_FONT_PT, 11);
  assert.equal(formFontPt(undefined), 11);
  assert.equal(formFontPt(null), 11);
  assert.equal(formFontPt(120), 13.2);
  assert.equal(formFontPt(500), 17.6, 'مقصوصٌ إلى 160٪');
  assert.equal(formFontPt(10), 7.7, 'مقصوصٌ إلى 70٪');
  assert.deepEqual(printedBox({ dxMm: 1.5, dyMm: -2.3 }, { x: 10, y: 20, w: 30, h: 6 }), { x: 11.5, y: 17.7, w: 30, h: 6 });
  assert.deepEqual(printedBox({ dxMm: Number.NaN, dyMm: 0 }, { x: 10, y: 20, w: 30, h: 6 }), { x: 10, y: 20, w: 30, h: 6 });
  assert.equal(tableRowTop({ y: 105, rowMm: 7 }, 0), 105);
  assert.equal(tableRowTop({ y: 105, rowMm: 6.95 }, 22), 257.9);
  assert.equal(formTableBox(null), null);
  assert.equal(formTableBox({ y: 1, rowMm: 5, rows: 2, columns: [] }), null);
  assert.deepEqual(formTableBox({ y: 100, rowMm: 7, rows: 10, columns: [{ id: 'qty', x: 150, w: 10 }, { id: 'sr', x: 10, w: 8 }] }), { x: 10, y: 100, w: 150, h: 70 });
});

test('formSheets: rows صنفاً لكل ورقة، وورقةٌ واحدة على الأقل، والإجماليات على الأخيرة وحدها', () => {
  assert.deepEqual(formSheets([], 23).map((s) => [s.index, s.count, s.first, s.last, s.items.length, s.offset]), [[0, 1, true, true, 0, 0]]);
  assert.equal(formSheets(null, 23).length, 1);
  const items = Array.from({ length: 50 }, (_, i) => i);
  const sheets = formSheets(items, 23);
  assert.deepEqual(sheets.map((s) => [s.index, s.count, s.first, s.last, s.items.length, s.offset]),
    [[0, 3, true, false, 23, 0], [1, 3, false, false, 23, 23], [2, 3, false, true, 4, 46]]);
  assert.deepEqual(sheets.flatMap((s) => s.items), items);
  assert.equal(formSheets(items.slice(0, 23), 23).length, 1, 'تماماً ⇒ ورقةٌ واحدة');
  assert.equal(formSheets(items.slice(0, 24), 23).length, 2);
  // بلا جدول (rows غير صالح) ⇒ ورقةٌ واحدة بكل الأصناف
  for (const rows of [null, undefined, 0, -3, Number.NaN]) assert.deepEqual(formSheets(items, rows).map((s) => s.items.length), [50]);
  assert.deepEqual(formSheets(items, 20.9).map((s) => s.items.length), [20, 20, 10], 'الكسر يُقصّ');
  // الإجماليات
  assert.deepEqual([...FORM_LAST_SHEET_IDS], ['notes', 'subtotal', 'discount', 'vatAmount', 'totalDue', 'paidAmt', 'remainingAmt', 'qr']);
  for (const id of FORM_FIELD_IDS) assert.equal(isLastSheetField(id), FORM_LAST_SHEET_IDS.includes(id), id);
  const f = starterForm(A4);
  assert.deepEqual(sheetFields(f, true), f.fields);
  assert.deepEqual(sheetFields(f, false).map((x) => x.id), f.fields.filter((x) => !FORM_LAST_SHEET_IDS.includes(x.id)).map((x) => x.id));
  assert.ok(!sheetFields(f, false).some((x) => x.id === 'qr' || x.id === 'totalDue'));
  assert.ok(sheetFields(f, false).some((x) => x.id === 'docNumber'), 'الرأس يتكرّر');
});

// ─── البداية المقترحة ───

test('starterForm: مواضع A4 مثل نموذج «مروج» — صالحة قانونية بلا تداخل، ومقيسة على A5 وLetter، وبلا QR لمن حذفه', () => {
  const f = starterForm(A4);
  assert.deepEqual([f.image, f.dxMm, f.dyMm, f.background, f.latinDigits, f.valueLang], [null, 0, 0, false, true, 'ar']);
  assert.deepEqual(f.fields.map((x) => x.id).slice(0, 4), ['docNumber', 'docDate', 'paymentType', 'docTitle'], 'بترتيب FORM_FIELD_IDS');
  for (const id of ['docNumber', 'docDate', 'paymentType', 'docTitle', 'customerName', 'sellerName', 'totalDue', 'qr'] as FormFieldId[]) {
    assert.ok(f.fields.some((x) => x.id === id), id);
  }
  assert.deepEqual([f.table!.y, f.table!.rowMm, f.table!.rows], [105, 7, 23]);
  assert.deepEqual(f.table!.columns.map((c) => c.id), ['sr', 'itemCode', 'barcode', 'description', 'qty', 'unit', 'unitPrice', 'lineTotal']);
  assert.deepEqual(formOverlaps(f), []);
  const qr = f.fields.find((x) => x.id === 'qr')!;
  assert.ok(qr.w >= FORM_BOUNDS.qrMinMm && qr.h >= FORM_BOUNDS.qrMinMm);
  assert.deepEqual(defaultFormTable(A4), f.table);
  for (const paper of [A4, A5, LETTER, { ...A4, widthMm: 160, lengthMm: 240, preset: 'custom' } as Paper]) {
    const p = formProfile(paper);
    assert.deepEqual(p.options.layout!.form, starterForm({ ...paper, marginTopMm: 0, marginBottomMm: 0 } as Paper));
    valid(p, `${paper.widthMm}×${paper.lengthMm}`);
    assert.deepEqual(formOverlaps(p.options.layout!.form!), [], `${paper.widthMm}×${paper.lengthMm}`);
    for (const x of p.options.layout!.form!.fields) assert.ok([x.x, x.y, x.w, x.h].every(onGrid), x.id);
  }
  assert.ok(!starterForm(A4, { withQr: false }).fields.some((x) => x.id === 'qr'));
  assert.equal(starterForm(A4, { withQr: false }).fields.length, f.fields.length - 1);
});

test('fitForm: المعروف بلا تكرار، مقصوصاً داخل الورقة على الشبكة، والجدول بلا أعمدة يسقط، والصورة المعطوبة null، والمعايرة ±20', () => {
  const raw = {
    image: { id: 'not-a-uuid', v: 'x', wPx: 1, hPx: 1 },
    dxMm: 33.33, dyMm: -7.06, background: 'yes', latinDigits: undefined, valueLang: 'fr',
    fields: [
      { id: 'docNumber', x: 205, y: -4, w: 30.2, h: 6 },
      { id: 'docNumber', x: 1, y: 1, w: 10, h: 6 },
      { id: 'bogus', x: 1, y: 1, w: 10, h: 6 },
      null,
      { id: 'qr', x: 10, y: 290, w: 5, h: 5, fontPct: 100, bold: false, align: 'middle' },
      { id: 'customerName', x: 50, y: 60, w: 40, h: 6, fontPct: 333, bold: true, align: 'end' },
    ],
    table: { y: 280, rowMm: 1, rows: 99, fontPct: 100, columns: [{ id: 'qty', x: -5, w: 2 }, { id: 'qty', x: 50, w: 9 }, { id: 'nope', x: 1, w: 9 }] },
  } as unknown as PrintForm;
  const f = fitForm(raw, A4);
  assert.equal(f.image, null);
  assert.deepEqual([f.dxMm, f.dyMm, f.background, f.latinDigits, f.valueLang], [20, -7.1, false, true, 'ar']);
  assert.deepEqual(f.fields, [
    { id: 'docNumber', x: 180, y: 0, w: 30, h: 6 },
    { id: 'customerName', x: 50, y: 60, w: 40, h: 6, align: 'end', fontPct: 160, bold: true },
    { id: 'qr', x: 10, y: 279, w: 18, h: 18 },
  ]);
  assert.deepEqual(f.table, { y: 280, rowMm: 3, rows: 5, columns: [{ id: 'qty', x: 0, w: 4 }] }, 'الأعلى يبقى والصفوف تُقصّ إلى ما يتّسع');
  // جدولٌ بلا عمودٍ صالح يسقط، والصورة الصالحة تبقى بمفاتيحها وحدها
  const g = fitForm({ ...starterForm(A4), image: { ...IMG, extra: 1 } as never, table: { y: 100, rowMm: 7, rows: 3, columns: [{ id: 'nope', x: 1, w: 9 }] } as never }, A4);
  assert.equal(g.table, null);
  assert.deepEqual(g.image, IMG);
  // متساوي القوى، وما تبدؤه البداية لا يتغيّر
  assert.deepEqual(fitForm(f, A4), f);
  assert.deepEqual(fitForm(starterForm(A4), A4), starterForm(A4));
  // مدخلٌ معطوب كلياً لا يرمي
  const empty = fitForm({} as PrintForm, A4);
  assert.deepEqual([empty.fields, empty.table, empty.image], [[], null, null]);
});

test('resetFormPositions / scaleForm: المواضع من البداية أو بالنسبة، والصورة والمعايرة والخلفية والأرقام ولغة القيم تبقى', () => {
  const start = starterForm(A4);
  assert.equal(resetFormPositions(start, A4), start, 'لا تغيير ⇒ النموذج نفسه');
  const custom = withFormProps(withFormField(start, A4, { id: 'docNumber', x: 3, y: 3 }), { image: IMG, dxMm: 1.2, dyMm: -0.4, background: true, latinDigits: false, valueLang: 'en' });
  const reset = resetFormPositions(custom, A4);
  assert.deepEqual(reset.fields, start.fields);
  assert.deepEqual(reset.table, start.table);
  assert.deepEqual([reset.image, reset.dxMm, reset.dyMm, reset.background, reset.latinDigits, reset.valueLang], [IMG, 1.2, -0.4, true, false, 'en']);
  assert.ok(!resetFormPositions(custom, A4, { withQr: false }).fields.some((x) => x.id === 'qr'));
  // نقل A4 ⇒ A5 ⇒ A4: صالحٌ في كلٍّ، والخصائص كما هي
  const a5 = scaleForm(custom, A4, A5);
  valid(withF(formProfile(A5), a5), 'A5');
  assert.deepEqual([a5.image, a5.dxMm, a5.background, a5.valueLang], [IMG, 1.2, true, 'en']);
  valid(withF(formProfile(A4), scaleForm(a5, A5, A4)), 'A4 again');
  assert.equal(scaleForm(start, A4, A4), start, 'المقاس نفسه بلا تغيير ⇒ النموذج نفسه');
});

// ─── القالب ───

test('formOf / withForm / formQrMissing / formIssues: لتصميم النموذج وحده', () => {
  const plain = newProfile('page', 'عادي', []);
  assert.equal(formOf(plain), null);
  assert.equal(formOf(null), null);
  assert.equal(withForm(plain, starterForm(A4)), plain, 'لا مواضع لغير تصميمه');
  assert.equal(formQrMissing(plain), false);
  assert.deepEqual(formIssues(plain), []);
  assert.deepEqual(formIssues(null), []);
  const p = formProfile();
  const f = formOf(p)!;
  assert.deepEqual(f, starterForm({ ...A4, marginTopMm: 0, marginBottomMm: 0 } as Paper));
  assert.equal(withForm(p, f), p);
  assert.equal(withForm(p, JSON.parse(JSON.stringify(f))), p, 'المساوي ⇒ القالب نفسه');
  const moved = withForm(p, { ...f, fields: f.fields.map((x) => (x.id === 'docNumber' ? { ...x, x: 999 } : x)) });
  assert.notEqual(moved, p);
  valid(moved, 'withForm يقصّ داخل الورقة');
  assert.equal(formOf(moved)!.fields.find((x) => x.id === 'docNumber')!.x, 120);
  // رمز QR: لازمٌ ما لم تحذفه الشركة صراحةً
  const noQr = withForm(p, withoutFormField(f, 'qr'));
  assert.equal(formQrMissing(noQr), true);
  assert.deepEqual(formIssues(noQr), [PRINT_ISSUES.layoutFormQrMissing]);
  const removed = withQrRemoved(p, true);
  assert.equal(formQrMissing(removed), false);
  assert.ok(!formOf(removed)!.fields.some((x) => x.id === 'qr'), 'الحذف الصريح يزيل حقله');
  valid(removed, 'محذوف صراحةً');
  // والإعادة تعيد حقله في موضعٍ خالٍ فتُحفظ
  const restored = withQrRemoved(removed, false);
  assert.ok(formOf(restored)!.fields.some((x) => x.id === 'qr'));
  assert.equal(formQrMissing(restored), false);
  valid(restored, 'الإعادة');
  // رسائل المواضع وحدها
  const broken = withF(p, { ...f, dxMm: 50, fields: [...f.fields, { ...f.fields[0] }] });
  assert.deepEqual(formIssues(broken).sort(), [PRINT_ISSUES.layoutFormField, PRINT_ISSUES.layoutFormOffset].sort());
});

// ─── المحرّرات ───

test('withFormField / withoutFormField / moveFormField: المقترح في موضعٍ خالٍ، والدمج والحذف بمفتاح undefined، والقصّ بالشبكة وحدّ QR', () => {
  const f = starterForm(A4);
  // حقلٌ جديد: حجمه المقترح وسط الورقة في أول موضعٍ خالٍ
  const d = defaultFormField(f, A4, 'repName');
  assert.deepEqual([d.w, d.h], [45, 6]);
  assert.ok(!formOverlaps({ fields: [...f.fields, d], table: f.table }).some(([a, b]) => a === 'repName' || b === 'repName'));
  const added = withFormField(f, A4, { id: 'repName' });
  assert.deepEqual(added.fields.find((x) => x.id === 'repName'), d);
  assert.ok(added.fields.findIndex((x) => x.id === 'repName') > added.fields.findIndex((x) => x.id === 'sellerPostal'), 'بترتيب FORM_FIELD_IDS');
  // تعديل: الدمج، وundefined يحذف المفتاح، و100٪ وغير العريض لا يُكتبان
  const styled = withFormField(added, A4, { id: 'repName', align: 'center', fontPct: 120, bold: true });
  assert.deepEqual(styled.fields.find((x) => x.id === 'repName'), { ...d, align: 'center', fontPct: 120, bold: true });
  const unstyled = withFormField(styled, A4, { id: 'repName', align: undefined, fontPct: 100, bold: false });
  assert.deepEqual(unstyled.fields.find((x) => x.id === 'repName'), d);
  assert.equal(withFormField(unstyled, A4, { id: 'repName', x: d.x }), unstyled, 'بلا أثر ⇒ النموذج نفسه');
  assert.equal(withFormField(f, A4, { id: 'bogus' as FormFieldId }), f);
  // القصّ: داخل الورقة، على الشبكة، وأصغر ضلعٍ 3 مم (QR 18)
  const out = withFormField(f, A4, { id: 'docNumber', x: 207.3, y: -9, w: 1, h: 400 });
  assert.deepEqual(out.fields.find((x) => x.id === 'docNumber'), { id: 'docNumber', x: 207, y: 0, w: 3, h: 297, align: 'center' });
  const tinyQr = withFormField(f, A4, { id: 'qr', w: 4, h: 4 });
  assert.deepEqual(['w', 'h'].map((k) => tinyQr.fields.find((x) => x.id === 'qr')![k as 'w']), [18, 18]);
  assert.equal(formFieldMinMm('qr'), 18);
  assert.equal(formFieldMinMm('docDate'), 3);
  // الحذف
  const without = withoutFormField(f, 'docTitle');
  assert.ok(!without.fields.some((x) => x.id === 'docTitle'));
  assert.equal(withoutFormField(without, 'docTitle'), without);
  // التحريك بالمم (x من اليسار الفعلي) يقف عند الحافة، والتكبير لا يزيح الحقل
  const n = f.fields.find((x) => x.id === 'docNumber')!;
  assert.deepEqual(moveFormField(f, A4, 'docNumber', 2.3, -1.2).fields.find((x) => x.id === 'docNumber'), { ...n, x: n.x + 2.5, y: n.y - 1 });
  assert.equal(moveFormField(f, A4, 'docNumber', 1000, 0).fields.find((x) => x.id === 'docNumber')!.x, 210 - n.w);
  assert.equal(moveFormField(f, A4, 'docNumber', -1000, -1000).fields.find((x) => x.id === 'docNumber')!.y, 0);
  const grown = moveFormField(f, A4, 'docNumber', 1000, 3, true).fields.find((x) => x.id === 'docNumber')!;
  assert.deepEqual([grown.x, grown.y, grown.w, grown.h], [n.x, n.y, 210 - n.x, n.h + 3]);
  const shrunk = moveFormField(f, A4, 'docNumber', -1000, -1000, true).fields.find((x) => x.id === 'docNumber')!;
  assert.deepEqual([shrunk.x, shrunk.w, shrunk.h], [n.x, 3, 3]);
  assert.equal(moveFormField(f, A4, 'repName', 5, 5), f, 'حقلٌ غائب');
  assert.equal(moveFormField(f, A4, 'docNumber', 0, 0), f);
});

test('withFormTable / moveFormTable: الحذف، والتحريك يُبقي الصفوف، وتغيير الصفوف أو ارتفاعها يقصّها إلى ما يتّسع', () => {
  const f = starterForm(A4);
  const t = f.table!;
  assert.equal(withFormTable(f, A4, null).table, null);
  const none = withFormTable(f, A4, null);
  assert.equal(withFormTable(none, A4, null), none);
  // بلا جدول: يُنشأ جدول البداية
  assert.deepEqual(withFormTable(none, A4, {}).table, defaultFormTable(A4));
  // التحريك: الصفوف كما هي وأعلاه يُقصّ
  assert.deepEqual([moveFormTable(f, A4, -10).table!.y, moveFormTable(f, A4, -10).table!.rows], [95, 23]);
  const low = moveFormTable(f, A4, 1000).table!;
  assert.deepEqual([low.rows, low.y], [23, 297 - 23 * 7]);
  assert.equal(moveFormTable(none, A4, 5), none);
  // الصفوف وارتفاعها: الأعلى يبقى والصفوف تُقصّ
  assert.equal(withFormTable(f, A4, { rows: 60 }).table!.rows, Math.floor((297 - 105) / 7));
  assert.deepEqual([withFormTable(f, A4, { rowMm: 1 }).table!.rowMm, withFormTable(f, A4, { rowMm: 99 }).table!.rowMm], [3, 25]);
  const tall = withFormTable(f, A4, { rowMm: 25 }).table!;
  assert.equal(tall.rows, Math.floor((297 - 105) / 25));
  assert.equal(withFormTable(f, A4, { rows: 0 }).table!.rows, 1);
  assert.equal(withFormTable(f, A4, { rowMm: 6.954 }).table!.rowMm, 6.95, 'بجزءٍ من مئة');
  // الخط: يُكتب وundefined يحذفه
  assert.equal(withFormTable(f, A4, { fontPct: 90 }).table!.fontPct, 90);
  assert.ok(!('fontPct' in withFormTable(withFormTable(f, A4, { fontPct: 90 }), A4, { fontPct: undefined }).table!));
  assert.equal(withFormTable(f, A4, { y: t.y }), f, 'بلا أثر');
  for (const g of [withFormTable(f, A4, { rows: 60 }), moveFormTable(f, A4, 1000), withFormTable(f, A4, { rowMm: 25 })]) valid(withF(formProfile(), g));
});

test('أعمدة الجدول: المقترح بعد آخر عمود أو في فراغ، والتعديل والحذف (لا آخر عمود)، والتحريك والتكبير، وإعادة الترتيب متلاصقة', () => {
  const f = starterForm(A4);
  const cols = (g: PrintForm): FormColumnId[] => g.table!.columns.map((c) => c.id);
  // عمودٌ جديد: لا فراغ بعد آخر عمود (ينتهي عند 200) ⇒ داخل الورقة على الأقل
  const d = defaultFormColumn(f.table, A4, 'discountPct');
  assert.ok(d.x >= 0 && d.x + d.w <= 210);
  assert.deepEqual(defaultFormColumn({ columns: [{ id: 'sr', x: 10, w: 8 }] }, A4, 'qty'), { id: 'qty', x: 18, w: 12, align: 'center' });
  assert.deepEqual(defaultFormColumn({ columns: [{ id: 'sr', x: 30, w: 170 }] }, A4, 'qty'), { id: 'qty', x: 0, w: 12, align: 'center' }, 'فراغٌ قبل الأول');
  assert.deepEqual(defaultFormColumn(null, A4, 'description'), { id: 'description', x: 10, w: 50, align: 'start' });
  const added = withFormColumn(f, A4, { id: 'vatPct' });
  assert.ok(cols(added).includes('vatPct'));
  assert.equal(added.table!.columns.length, 9);
  // بلا جدول: جدول البداية بهذا العمود وحده
  const fresh = withFormColumn(withFormTable(f, A4, null), A4, { id: 'qty' });
  assert.deepEqual(cols(fresh), ['qty']);
  assert.deepEqual([fresh.table!.y, fresh.table!.rows], [105, 23]);
  // التعديل والقصّ
  const right = withFormColumn(f, A4, { id: 'lineTotal', x: 300, align: 'end' }).table!.columns.find((c) => c.id === 'lineTotal')!;
  assert.deepEqual(right, { id: 'lineTotal', x: 180.5, w: 29.5, align: 'end' });
  assert.equal(withFormColumn(f, A4, { id: 'qty', w: 1 }).table!.columns.find((c) => c.id === 'qty')!.w, 4);
  assert.equal(withFormColumn(f, A4, { id: 'nope' as FormColumnId }), f);
  // الحذف — وآخر عمودٍ لا يُحذف
  assert.ok(!cols(withoutFormColumn(f, 'barcode')).includes('barcode'));
  assert.equal(withoutFormColumn(f, 'vatPct'), f);
  let one = f;
  for (const id of cols(f).slice(1)) one = withoutFormColumn(one, id);
  assert.deepEqual(cols(one), ['sr']);
  assert.equal(withoutFormColumn(one, 'sr'), one);
  // التحريك والتكبير داخل العرض
  const qty = f.table!.columns.find((c) => c.id === 'qty')!;
  assert.equal(moveFormColumn(f, A4, 'qty', 3.2).table!.columns.find((c) => c.id === 'qty')!.x, qty.x + 3);
  const wide = moveFormColumn(f, A4, 'qty', 1000, true).table!.columns.find((c) => c.id === 'qty')!;
  assert.deepEqual([wide.x, wide.w], [qty.x, 210 - qty.x]);
  assert.equal(moveFormColumn(f, A4, 'vatPct', 3), f);
  // إعادة الترتيب: من أيسر عمود متلاصقةً بعروضها
  const re = reorderFormColumn(f, A4, 'lineTotal', 0);
  assert.deepEqual(cols(re), ['lineTotal', 'sr', 'itemCode', 'barcode', 'description', 'qty', 'unit', 'unitPrice']);
  let cursor = f.table!.columns[0].x;
  for (const c of re.table!.columns) { assert.equal(c.x, cursor, c.id); cursor += c.w; }
  assert.equal(reorderFormColumn(f, A4, 'sr', 0), f);
  assert.equal(reorderFormColumn(f, A4, 'vatPct', 0), f);
  assert.equal(reorderFormColumn(f, A4, 'sr', 1.5), f);
  for (const g of [added, fresh, re, moveFormColumn(f, A4, 'qty', 1000, true)]) valid(withF(formProfile(), g));
});

test('withFormProps: الصورة الصالحة أو null، والمعايرة ±20 بعُشر مم، والمنطقيّات ولغة القيم', () => {
  const f = starterForm(A4);
  assert.equal(withFormProps(f, {}), f);
  assert.deepEqual(withFormProps(f, { image: IMG }).image, IMG);
  assert.equal(withFormProps(f, { image: { ...IMG, id: 'x' } }).image, null);
  assert.equal(withFormProps(f, { image: { ...IMG, wPx: 50 } }).image, null);
  assert.equal(withFormProps(withFormProps(f, { image: IMG }), { image: null }).image, null);
  assert.deepEqual([withFormProps(f, { dxMm: 1.26 }).dxMm, withFormProps(f, { dyMm: -99 }).dyMm, withFormProps(f, { dxMm: Number.NaN }).dxMm], [1.3, -20, 0]);
  assert.equal(withFormProps(f, { background: true }).background, true);
  assert.equal(withFormProps(f, { latinDigits: false }).latinDigits, false);
  assert.equal(withFormProps(f, { valueLang: 'en' }).valueLang, 'en');
  assert.equal(withFormProps(f, { valueLang: 'fr' as never }), f);
  assert.equal(withFormProps(f, { dxMm: 0, background: false }), f, 'بلا أثر');
  valid(withF(formProfile(), withFormProps(f, { image: IMG, dxMm: -19.96, dyMm: 20, background: true, latinDigits: false, valueLang: 'en' })));
});

test('كل محرّرٍ يُخرج نموذجاً صالحاً قانونياً على كل ورق — مشيٌ عشوائي (بلا حذف QR)', () => {
  const fieldIds = FORM_FIELD_IDS.filter((id) => id !== 'qr');
  for (const paper of [A4, A5, LETTER]) {
    const p0 = formProfile(paper);
    let f = formOf(p0)!;
    let seed = 2026;
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const mm = (): number => (rnd(4001) - 2000) / 10;
    for (let step = 0; step < 300; step++) {
      const fid = fieldIds[rnd(fieldIds.length)];
      const cid = FORM_COLUMN_IDS[rnd(FORM_COLUMN_IDS.length)];
      switch (rnd(14)) {
        case 0: f = withFormField(f, paper, { id: fid }); break;
        case 1: f = withoutFormField(f, fid); break;
        case 2: f = moveFormField(f, paper, rnd(5) ? fid : 'qr', mm(), mm()); break;
        case 3: f = moveFormField(f, paper, rnd(5) ? fid : 'qr', mm(), mm(), true); break;
        case 4: f = withFormField(f, paper, { id: fid, align: (['start', 'center', 'end', undefined] as const)[rnd(4)], fontPct: 60 + rnd(120), bold: rnd(2) === 0 }); break;
        case 5: f = withFormTable(f, paper, { rows: rnd(70), rowMm: rnd(300) / 10 }); break;
        case 6: f = moveFormTable(f, paper, mm()); break;
        case 7: f = withFormColumn(f, paper, { id: cid }); break;
        case 8: f = withoutFormColumn(f, cid); break;
        case 9: f = moveFormColumn(f, paper, cid, mm(), rnd(2) === 0); break;
        case 10: f = reorderFormColumn(f, paper, cid, rnd(12)); break;
        case 11: f = withFormProps(f, { dxMm: mm() / 5, dyMm: mm() / 5, background: rnd(2) === 0, valueLang: rnd(2) ? 'ar' : 'en' }); break;
        case 12: f = rnd(8) ? f : withFormTable(f, paper, null); break;
        default: f = withFormTable(f, paper, { y: rnd(400), fontPct: rnd(2) ? undefined : 70 + rnd(91) });
      }
      const p = withForm(p0, f);
      assert.deepEqual(formOf(p), f, `step ${step}: withForm يحفظ ما أخرجه المحرّر كما هو`);
      valid(p, `${paper.preset} step ${step}`);
    }
  }
});

// ─── النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦، MIP480): ما تبلغه الإبرة ورمز QR ≥ 55 ولا خلفية ───

test('النقطية: formReachOf / formPaperOf / formReachBox / formFieldMinMm — الحزمة في الوسط بلا offsetXmm، والعادية بلا reach', () => {
  assert.equal(formReachOf({ printer: 'page', paper: A4 }), null);
  assert.equal(formReachOf({ printer: 'thermal', paper: presetPaper('roll80') as Paper }), null);
  const r = formReachOf({ printer: 'impact', paper: FF_A4 })!;
  assert.ok(near(r.x0, 3.4) && near(r.x1, 206.6) && r.qrMinMm === 55, JSON.stringify(r));
  const w = formReachOf({ printer: 'impact', paper: FF_WIDE })!;
  assert.ok(near(w.x0, 18.9) && near(w.x1, 222.1), JSON.stringify(w));
  const n = formReachOf({ printer: 'impact', paper: FF_85 })!;
  assert.ok(near(n.x0, 12.75) && near(n.x1, 203.25), JSON.stringify(n));
  // offsetXmm والهامشان لا يمسّان الحزمة (المعايرة dx/dy وحدها)
  assert.deepEqual(formReachOf({ printer: 'impact', paper: { ...FF_A4, offsetXmm: 10, marginTopMm: 30 } }), r);
  assert.deepEqual(formPaperOf({ printer: 'page', paper: A4 }), { widthMm: 210, lengthMm: 297, reach: null });
  assert.deepEqual(formPaperOf({ printer: 'impact', paper: FF_A4 }), { widthMm: 210, lengthMm: 297, reach: r });
  // حدّ رمز QR بالورق: 18 على العادية (وبلا ورق كاليوم)، و55 على النقطية — وغيره 3 في كلٍّ
  assert.equal(formFieldMinMm('qr'), FORM_BOUNDS.qrMinMm);
  assert.equal(formFieldMinMm('qr', formPaperOf({ printer: 'page', paper: A4 })), 18);
  assert.equal(formFieldMinMm('qr', ip()), 55);
  assert.equal(formFieldMinMm('docNumber', ip()), FORM_BOUNDS.fieldMinMm);
  // ما تبلغه الإبرة من المواضع المحفوظة: [x0 − dx, x1 − dx] × [−dy, L − dy] مقطوعاً بالورقة
  assert.equal(formReachBox({ dxMm: 0, dyMm: 0 }, A4), null, 'بلا reach');
  assert.equal(formReachBox({ dxMm: 0, dyMm: 0 }, formPaperOf({ printer: 'page', paper: A4 })), null);
  assert.equal(formReachBox({ dxMm: 0, dyMm: 0 }, null), null);
  assert.deepEqual(box6(formReachBox({ dxMm: 0, dyMm: 0 }, ip())), [3.4, 0, 203.2, 297]);
  assert.deepEqual(box6(formReachBox({ dxMm: 2, dyMm: -3 }, ip())), [1.4, 3, 203.2, 294]);
  assert.deepEqual(box6(formReachBox({ dxMm: -5, dyMm: 4 }, ip())), [8.4, 0, 201.6, 293], 'الحافة اليمنى عند حافة الورقة');
  assert.deepEqual(box6(formReachBox({ dxMm: 5, dyMm: Number.NaN }, ip())), [0, 0, 201.6, 297], 'اليسرى عند حافة الورقة، وغير المنتهي 0');
  assert.deepEqual(box6(formReachBox({ dxMm: 0, dyMm: 0 }, ip(FF_WIDE))), [18.9, 0, 203.2, 279.4]);
});

test('النقطية: starterForm — مواضع A4 مُزاحة أفقياً ومقيسة طولاً، 16 صفاً، ورمز QR بحدّه 55 تحت الجدول — صالحٌ قانونيٌّ على كل مقاسٍ نقطي', () => {
  const page = starterForm(A4);
  const f = starterForm(ip(FF_A4));
  assert.deepEqual([f.image, f.dxMm, f.dyMm, f.background, f.latinDigits, f.valueLang], [null, 0, 0, false, true, 'ar']);
  assert.deepEqual(f.fields.find((x) => x.id === 'qr'), { id: 'qr', x: 12, y: 226, w: 55, h: 55 });
  assert.deepEqual(f.fields.filter((x) => x.id !== 'qr'), page.fields.filter((x) => x.id !== 'qr'), 'الرأس والإجماليات كمواضع A4');
  assert.deepEqual([f.table!.y, f.table!.rowMm, f.table!.rows], [105, 7, 16], 'الجدول ينتهي عند 217 قبل مربع QR');
  assert.deepEqual(f.table!.columns, page.table!.columns);
  assert.deepEqual(formOverlaps(f), []);
  assert.deepEqual(defaultFormTable(ip(FF_A4)), f.table);
  // 241 مم: إزاحةٌ بنصف فرق العرض (+15.5) لا قياس، والطول بنسبته
  const wide = starterForm(ip(FF_WIDE));
  for (const x of page.fields.filter((q) => q.id !== 'qr')) {
    const y = wide.fields.find((q) => q.id === x.id)!;
    assert.deepEqual([y.x, y.w], [x.x + 15.5, x.w], x.id);
  }
  assert.deepEqual(wide.table!.columns.map((c) => [c.x, c.w]), page.table!.columns.map((c) => [c.x + 15.5, c.w]));
  const wq = wide.fields.find((q) => q.id === 'qr')!;
  assert.deepEqual([wq.x, wq.w, wq.h], [27.5, 55, 55]);
  assert.equal(wide.table!.rows, 16);
  for (const paper of IMPACT_PAPERS) {
    const p = impactProfile(paper);
    const form = p.options.layout!.form!;
    assert.deepEqual(form, starterForm(ip(paper)), paper.preset);
    valid(p, paper.preset);
    const reach = formReachOf(p)!;
    for (const x of form.fields) {
      assert.ok([x.x, x.y, x.w, x.h].every(onGrid), `${paper.preset} ${x.id}`);
      assert.ok(x.x >= reach.x0 - 1e-9 && x.x + x.w <= reach.x1 + 1e-9, `${paper.preset} ${x.id}`);
    }
    assert.deepEqual(form.fields.filter((x) => x.id === 'qr').map((x) => [x.w, x.h]), [[55, 55]], paper.preset);
    // نصف الصفحة: المربع يُنزَل إلى آخر الورقة بجوار الجدول فيظهر تنبيه التداخل ليعدّله المستخدم — وغيره بلا تداخل
    if (paper.preset === 'ff_95x55') assert.ok(formOverlaps(form).some(([a, b]) => a === 'qr' && b === 'table'));
    else assert.deepEqual(formOverlaps(form), [], paper.preset);
  }
  assert.ok(!starterForm(ip(), { withQr: false }).fields.some((x) => x.id === 'qr'));
  // العادية بـformPaperOf كما بالورق وحده حرفياً
  assert.deepEqual(starterForm(formPaperOf({ printer: 'page', paper: A5 })), starterForm(A5));
});

test('النقطية: fitForm يقصّ داخل ما تبلغه الإبرة بعد المعايرة (المقصوصة أولاً)، ورمز QR ≥ 55، والخلفية false — متساوي القوى', () => {
  const paper = ip();
  const raw = {
    ...starterForm(paper), dxMm: 4, dyMm: -6, background: true,
    fields: [
      { id: 'docNumber', x: 0, y: 0, w: 30, h: 6 },
      { id: 'totalDue', x: 190, y: 295, w: 40, h: 6 },
      { id: 'qr', x: 150, y: 250, w: 22, h: 22 },
    ],
    table: { y: 0, rowMm: 7, rows: 60, columns: [{ id: 'sr', x: 0, w: 8 }, { id: 'lineTotal', x: 195, w: 25 }] },
  } as unknown as PrintForm;
  const f = fitForm(raw, paper);
  // dx 4 ⇒ المحفوظ من 0 (3.4 − 4 خارج الورقة) إلى 202.5 (206.6 − 4 للأسفل على الشبكة)؛ dy −6 ⇒ من 6 إلى 297
  assert.deepEqual([f.dxMm, f.dyMm, f.background], [4, -6, false]);
  assert.deepEqual(f.fields, [
    { id: 'totalDue', x: 162.5, y: 291, w: 40, h: 6 },
    { id: 'docNumber', x: 0, y: 6, w: 30, h: 6 },
    { id: 'qr', x: 147.5, y: 242, w: 55, h: 55 },
  ].sort((a, b) => FORM_FIELD_IDS.indexOf(a.id as FormFieldId) - FORM_FIELD_IDS.indexOf(b.id as FormFieldId)));
  assert.deepEqual(f.table, { y: 6, rowMm: 7, rows: 41, columns: [{ id: 'sr', x: 0, w: 8 }, { id: 'lineTotal', x: 177.5, w: 25 }] });
  assert.deepEqual(fitForm(f, paper), f, 'متساوي القوى');
  valid(withF(impactProfile(), f), 'impact fit');
  // معايرةٌ خارج ±20 تُقصّ أولاً ثم تُقاس بها الحزمة
  const far = fitForm({ ...raw, dxMm: 40 }, paper);
  assert.equal(far.dxMm, 20);
  for (const x of far.fields) assert.ok(x.x + 20 >= 3.4 - 1e-9 && x.x + 20 + x.w <= 206.6 + 1e-9, x.id);
  valid(withF(impactProfile(), far), 'dx 20');
  // المدخل نفسه على العادية: كما كان (الخلفية تبقى ورمز QR 22)
  const pf = fitForm(raw, A4);
  assert.equal(pf.background, true);
  assert.deepEqual(pf.fields.find((x) => x.id === 'qr'), { id: 'qr', x: 150, y: 250, w: 22, h: 22 });
  assert.deepEqual(pf.fields.find((x) => x.id === 'docNumber'), { id: 'docNumber', x: 0, y: 0, w: 30, h: 6 });
});

test('النقطية: scaleForm يُزيح أفقياً بنصف فرق العرض ويقيس طولاً، ورمز QR لا يصغر عن 55 — والمقاس نفسه بلا تغيير', () => {
  const a = starterForm(ip(FF_A4));
  const b = scaleForm(a, ip(FF_A4), ip(FF_WIDE));
  for (const x of a.fields) {
    const y = b.fields.find((q) => q.id === x.id)!;
    assert.deepEqual([y.x, y.w], [x.x + 15.5, x.w], x.id);
  }
  assert.deepEqual(b.table!.columns.map((c) => c.x), a.table!.columns.map((c) => c.x + 15.5));
  assert.deepEqual(b.fields.filter((x) => x.id === 'qr').map((x) => [x.w, x.h]), [[55, 55]]);
  valid(withF(impactProfile(FF_WIDE), b), 'ff_95x11');
  // والعودة: −15.5
  const back = scaleForm(b, ip(FF_WIDE), ip(FF_A4));
  assert.deepEqual(back.fields.map((x) => x.x), a.fields.map((x) => x.x));
  valid(withF(impactProfile(FF_A4), back), 'ff_a4 again');
  // الورق المقطع والمتصل بالمقاس نفسه: النموذج نفسه
  assert.equal(scaleForm(a, ip(FF_A4), ip(CUT_A4)), a);
  // نصف الصفحة: الطول بنسبته ورمز QR بحدّه داخل الورقة
  const half = scaleForm(a, ip(FF_A4), ip(FF_HALF));
  valid(withF(impactProfile(FF_HALF), half), 'ff_95x55');
  assert.deepEqual(half.fields.filter((x) => x.id === 'qr').map((x) => [x.w, x.h]), [[55, 55]]);
});

test('النقطية: المحرّرات — حقل QR الجديد بـ55 داخل الحزمة، والتحريك والتكبير يقفان عند حدّها بعد المعايرة، وكل ناتجٍ صالح', () => {
  const paper = ip();
  const p0 = impactProfile();
  const f0 = formOf(p0)!;
  const noQr = withoutFormField(f0, 'qr');
  const d = defaultFormField(noQr, paper, 'qr');
  assert.deepEqual([d.w, d.h], [55, 55]);
  assert.ok(d.x >= 3.4 && d.x + d.w <= 206.6);
  const f1 = withFormField(noQr, paper, { id: 'qr' });
  assert.deepEqual(f1.fields.filter((x) => x.id === 'qr').map((x) => [x.w, x.h]), [[55, 55]]);
  valid(withF(p0, f1), 'qr restored');
  assert.equal(withFormField(f1, paper, { id: 'qr', w: 30, h: 30 }), f1, 'لا يصغر عن 55');
  // التحريك: يقف عند أول ما تبلغه الإبرة (3.4 ⇒ 3.5 على الشبكة) وآخره (206.6 ⇒ 206.5)
  const get = (f: PrintForm, id: FormFieldId) => f.fields.find((x) => x.id === id)!;
  assert.equal(get(moveFormField(f1, paper, 'docNumber', -500, 0), 'docNumber').x, 3.5);
  assert.equal(get(moveFormField(f1, paper, 'docNumber', 500, 0), 'docNumber').x, 206.5 - 90);
  assert.equal(get(moveFormField(f1, paper, 'docNumber', 500, 0, true), 'docNumber').w, 206.5 - 60, 'التكبير يقف عند الحزمة');
  // بالمعايرة: dx = 3 ⇒ المحفوظ من 0.5 (0.4 للأعلى على الشبكة)، وdy = −10 ⇒ لا شيء فوق 10
  const shifted = withFormProps(f1, { dxMm: 3, dyMm: -10 });
  assert.equal(get(moveFormField(shifted, paper, 'docNumber', -500, 0), 'docNumber').x, 0.5);
  assert.equal(get(moveFormField(shifted, paper, 'docTitle', 0, -500), 'docTitle').y, 10);
  assert.equal(moveFormTable(shifted, paper, -500).table!.y, 10);
  assert.equal(moveFormTable(f1, paper, -500).table!.y, 0);
  // الأعمدة
  const col = (f: PrintForm, id: FormColumnId) => f.table!.columns.find((c) => c.id === id)!;
  assert.equal(col(moveFormColumn(f1, paper, 'sr', -500), 'sr').x, 3.5);
  assert.equal(col(moveFormColumn(f1, paper, 'lineTotal', 500), 'lineTotal').x, 206.5 - 29.5);
  assert.equal(col(moveFormColumn(f1, paper, 'lineTotal', 500, true), 'lineTotal').w, 206.5 - 170.5);
  // الصفوف تُقصّ إلى ما يتّسع بعد المعايرة الرأسية (L − dy)
  const tall = withFormTable(withFormProps(f1, { dyMm: 15 }), paper, { rows: 60 });
  assert.ok(tall.table!.y + 15 + tall.table!.rows * tall.table!.rowMm <= 297 + 1e-9);
  // جدولٌ جديد بعمودٍ واحد، وعمودٌ مقترح داخل الحزمة
  const bare = withFormTable(f1, paper, null);
  const one = withFormColumn(bare, paper, { id: 'qty' });
  assert.ok(one.table && one.table.rows === 16 && one.table.columns.length === 1);
  const dc = defaultFormColumn({ columns: [] }, paper, 'qty');
  assert.ok(dc.x >= 3.4 && dc.x + dc.w <= 206.6);
  for (const [why, f] of [['moved', moveFormField(f1, paper, 'docNumber', -500, 0)], ['tall', tall], ['one column', one],
    ['shifted', fitForm(shifted, paper)], ['reordered', reorderFormColumn(f1, paper, 'lineTotal', 0)]] as Array<[string, PrintForm]>) {
    valid(withF(p0, f), why);
  }
});

test('النقطية: كل محرّرٍ يُخرج نموذجاً صالحاً قانونياً داخل ما تبلغه الإبرة على كل مقاسٍ نقطي — مشيٌ عشوائي', () => {
  const fieldIds = FORM_FIELD_IDS.filter((id) => id !== 'qr');
  for (const sheet of [FF_A4, FF_WIDE, FF_85, FF_HALF]) {
    const p0 = impactProfile(sheet);
    const paper = formPaperOf(p0);
    let f = formOf(p0)!;
    let seed = 1311;
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const mm = (): number => (rnd(4001) - 2000) / 10;
    for (let step = 0; step < 300; step++) {
      const fid = fieldIds[rnd(fieldIds.length)];
      const cid = FORM_COLUMN_IDS[rnd(FORM_COLUMN_IDS.length)];
      let props = false;
      switch (rnd(14)) {
        case 0: f = withFormField(f, paper, { id: fid }); break;
        case 1: f = withoutFormField(f, fid); break;
        case 2: f = moveFormField(f, paper, rnd(5) ? fid : 'qr', mm(), mm()); break;
        case 3: f = moveFormField(f, paper, rnd(5) ? fid : 'qr', mm(), mm(), true); break;
        case 4: f = withFormField(f, paper, { id: rnd(6) ? fid : 'qr', align: (['start', 'center', 'end', undefined] as const)[rnd(4)], fontPct: 60 + rnd(120), bold: rnd(2) === 0 }); break;
        case 5: f = withFormTable(f, paper, { rows: rnd(70), rowMm: rnd(300) / 10 }); break;
        case 6: f = moveFormTable(f, paper, mm()); break;
        case 7: f = withFormColumn(f, paper, { id: cid }); break;
        case 8: f = withoutFormColumn(f, cid); break;
        case 9: f = moveFormColumn(f, paper, cid, mm(), rnd(2) === 0); break;
        case 10: f = reorderFormColumn(f, paper, cid, rnd(12)); break;
        case 11: f = withFormProps(f, { dxMm: mm() / 5, dyMm: mm() / 5, background: rnd(2) === 0, valueLang: rnd(2) ? 'ar' : 'en' }); props = true; break;
        case 12: f = rnd(8) ? f : withFormTable(f, paper, null); break;
        default: f = withFormTable(f, paper, { y: rnd(400), fontPct: rnd(2) ? undefined : 70 + rnd(91) });
      }
      const p = withForm(p0, f);
      // المعايرة والخلفية تُكتبان بلا ورق (withFormProps) فيقصّهما withForm كما يفعل المصمّم؛ وغيرهما يخرج مقصوصاً بالفعل
      if (props) f = formOf(p)!;
      else assert.deepEqual(formOf(p), f, `${sheet.preset} step ${step}: withForm يحفظ ما أخرجه المحرّر كما هو`);
      assert.equal(f.background, false);
      valid(p, `${sheet.preset} step ${step}`);
    }
  }
});

test('النقطية: formWarnings — ملاحظة «صفحة المعايرة»، والورق المقطع ينصح بالمتصل، ولا تنبيه خلفية — والعادية كما كانت', () => {
  const p = impactProfile(FF_A4);
  assert.deepEqual(formWarnings(p), { warnings: [FORM_WARNINGS.imageMissing], notes: [FORM_NOTES.impactCalibrate, FORM_NOTES.pageNo] });
  const cut = impactProfile(CUT_A4);
  assert.deepEqual(formWarnings(cut).notes, [FORM_NOTES.impactCalibrate, FORM_NOTES.impactCutSheet, FORM_NOTES.pageNo]);
  // بلا جدولٍ ورقةٌ واحدة: لا نصيحة بالمتصل
  assert.deepEqual(formWarnings(withForm(cut, withFormTable(formOf(cut)!, ip(CUT_A4), null))).notes, [FORM_NOTES.impactCalibrate]);
  // خلفيةٌ وصلت بلا قصّ (صفٌّ قديم): لا تنبيه خلفية — النقطية لا تطبعها أصلاً
  const bg = withF(p, { ...formOf(p)!, background: true });
  assert.ok(!formWarnings(bg).warnings.includes(FORM_WARNINGS.background));
  // withForm يُطفئها
  assert.equal(formOf(withForm(p, withFormProps(formOf(p)!, { background: true })))!.background, false);
  // العادية: لا ملاحظة نقطية
  assert.ok(!formWarnings(formProfile()).notes.includes(FORM_NOTES.impactCalibrate));
});

// ─── التسميات والتنبيهات ───

test('التسميات: لكل حقلٍ وعمود، ومجموعات اللوحة تغطّي الحقول مرةً واحدة، وحقول الضريبة — وكلها مترجمة بلا فواصل علوية', () => {
  assert.deepEqual(Object.keys(FORM_FIELD_LABELS), [...FORM_FIELD_IDS]);
  assert.deepEqual(Object.keys(FORM_COLUMN_LABELS), [...FORM_COLUMN_IDS]);
  assert.deepEqual(FORM_FIELD_GROUPS.flatMap((g) => g.ids).sort(), [...FORM_FIELD_IDS].sort());
  assert.equal(new Set(FORM_FIELD_GROUPS.flatMap((g) => g.ids)).size, FORM_FIELD_IDS.length);
  assert.deepEqual([...FORM_TAX_FIELD_IDS], ['customerVat', 'sellerVat', 'vatAmount']);
  assert.deepEqual([...FORM_TAX_COLUMN_IDS], ['vatPct']);
  assert.deepEqual(Object.keys(FORM_VALUE_LANG_LABELS), ['ar', 'en']);
  const all = [
    ...Object.values(FORM_FIELD_LABELS), ...Object.values(FORM_COLUMN_LABELS), ...FORM_FIELD_GROUPS.map((g) => g.title),
    ...Object.values(FORM_VALUE_LANG_LABELS), ...Object.values(FORM_WARNINGS), ...Object.values(FORM_NOTES),
    ...Object.entries(PRINT_ISSUES).filter(([k]) => k.startsWith('layoutForm') || ['formsCount', 'routeForm', 'pdfForm'].includes(k)).map(([, v]) => v),
  ];
  assert.equal(new Set(Object.values(FORM_FIELD_LABELS)).size, FORM_FIELD_IDS.length, 'تسمياتٌ مميّزة');
  for (const ar of all) {
    const t = PHRASES[ar];
    assert.ok(t, `«${ar}» بلا مدخل في القاموس`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${ar}» بلا ترجمة ${lang}`);
    assert.ok(!t.fr.includes("'"), `«${ar}» فرنسية بفاصلة علوية`);
  }
});

test('formWarnings: فارغة لغير النموذج، وبلا صورة، والخلفية، وبلا جدول/رقم/إجمالي/عنوان، والتداخل — والملاحظات: رقم الصفحة والضريبة على المعفى', () => {
  assert.deepEqual(formWarnings(newProfile('page', 'عادي', [])), { warnings: [], notes: [] });
  const p = formProfile();
  const f = formOf(p)!;
  assert.deepEqual(formWarnings(p), { warnings: [FORM_WARNINGS.imageMissing], notes: [FORM_NOTES.pageNo] });
  const withImg = withForm(p, withFormProps(withFormField(f, A4, { id: 'pageNo' }), { image: IMG }));
  assert.deepEqual(formWarnings(withImg), { warnings: [], notes: [] });
  const bg = withForm(withImg, withFormProps(formOf(withImg)!, { background: true }));
  assert.deepEqual(formWarnings(bg).warnings, [FORM_WARNINGS.background]);
  let bare = formOf(withImg)!;
  for (const id of ['docNumber', 'totalDue', 'docTitle'] as FormFieldId[]) bare = withoutFormField(bare, id);
  bare = withFormTable(bare, A4, null);
  assert.deepEqual(formWarnings(withForm(withImg, bare)).warnings, [FORM_WARNINGS.noTable, FORM_WARNINGS.noNumber, FORM_WARNINGS.noTotal, FORM_WARNINGS.noTitle]);
  assert.deepEqual(formWarnings(withForm(withImg, bare)).notes, [], 'بلا جدول لا ملاحظة صفحات');
  // التداخل
  const n = f.fields.find((x) => x.id === 'docNumber')!;
  const over = withForm(withImg, withFormField(formOf(withImg)!, A4, { id: 'docDate', x: n.x, y: n.y }));
  assert.ok(formWarnings(over).warnings.includes(FORM_WARNINGS.overlap));
  assert.deepEqual(formOverlaps(formOf(over)!).filter(([a]) => a === 'docNumber').map(([, b]) => b), ['docDate']);
  const onTable = withFormField(f, A4, { id: 'repName', x: 50, y: 150 });
  assert.ok(formOverlaps(onTable).some(([a, b]) => a === 'repName' && b === 'table'));
  // المعفى: مربع QR لا يُطبع ولا يُرسم في المصمّم — فتداخلٌ معه وحده لا ينبّه
  const q = f.fields.find((x) => x.id === 'qr');
  assert.ok(q, 'النموذج المبدئي بحقل QR');
  const onQr = withForm(withImg, withFormField(formOf(withImg)!, A4, { id: 'repName', x: q.x + 1, y: q.y + 1, w: 10, h: 5 }));
  assert.ok(formWarnings(onQr).warnings.includes(FORM_WARNINGS.overlap));
  assert.ok(!formWarnings(onQr, { taxFree: true }).warnings.includes(FORM_WARNINGS.overlap));
  // الضريبة على المعفى: ملاحظةٌ حين يحمل النموذج حقلاً أو عموداً ضريبياً
  assert.ok(!formWarnings(p, { taxFree: true }).notes.includes(FORM_NOTES.taxFree));
  const vat = withForm(p, withFormField(f, A4, { id: 'sellerVat' }));
  assert.ok(formWarnings(vat, { taxFree: true }).notes.includes(FORM_NOTES.taxFree));
  assert.ok(!formWarnings(vat).notes.includes(FORM_NOTES.taxFree));
  assert.ok(formWarnings(withForm(p, withFormColumn(f, A4, { id: 'vatPct' })), { taxFree: true }).notes.includes(FORM_NOTES.taxFree));
});

test('formModel.ts خالص: بلا React ولا DOM، ويستورد النواة وحدها', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'print', 'formModel.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!/from 'react'|document\.|window\./.test(src));
  const from = [...src.matchAll(/^(?:import|export) [\s\S]*? from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(from.length > 0 && from.every((m) => m === './printSettingsCore'), from.join(','));
  assert.equal(LAYOUT_BOUNDS.stepMm, 0.5);
  assert.deepEqual(withLayout(formProfile(), { design: 'preprinted' }).options.layout!.form, formOf(formProfile()));
});
