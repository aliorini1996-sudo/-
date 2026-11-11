// «تخطيط المطبوعات» في «إعدادات الطباعة» (طلب المالك ٣ نوفمبر ٢٠٢٦، الحزمة P7a): بطاقة «كلاسيكي بإطارات — ثنائي اللغة»، وكتلة
// «التخطيط» في الخطوة الرابعة (مكان الشعار وحجمه، اللون، الخط، الجدول، ترتيب الأقسام بالسحب و▲▼)، والمعاينة بالقالب الحقيقي
// ومظهر القالب المفتوح، وترجمة كل عبارةٍ جديدة. سلوكٌ بدوالّ اللوحة النقيّة وبرسم المعاينة فعلاً، وحرّاسٌ مصدرية للتوصيل.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ACCENT_PALETTE, PRINT_SAMPLE_WATERMARK, defaultPrintOptions, layoutIssues, legacyPageProfile, legacyThermalProfile, presetPaper, sectionsFor,
  withLayout, type PrintProfile,
} from '../../lib/print/printSettings';
import { PRINT_STATUS_TITLE_KEYS, PRINT_TEXT_CATALOG, PRINT_TEXT_WARNINGS, printTextEntry } from '../../lib/print/printTextsCore';
import { PHRASES } from '../../i18n/strings';
// حقول «التخطيط» ودوالّها في PrintPreview.tsx لا في اللوحة: اللوحة تستورد عميل الـAPI (import.meta.env وlocalStorage) فلا تُحمَّل هنا
import PrintPreview, {
  FormThumb, LAYOUT_FONT_SCALES, PaperPreview, accentInputState, applyDesignCard, designCardId, designCardSelected, designCards, effectiveFontScale, layoutEditable,
  logoChoices, orderIsDefault, previewFormDoc, previewInvoiceDoc, previewReceiptDoc, resetSectionOrder, sectionRows, withLayoutFontScale,
} from './PrintPreview';
import { FORM_COLUMN_LABELS, FORM_FIELD_LABELS, formOf, withFormField } from '../../lib/print/formModel';
import { TaxOffPrintContext } from './taxOffPrint';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const panel = () => read('src', 'components', 'print', 'PrintSettingsPanel.tsx');
const preview = () => read('src', 'components', 'print', 'PrintPreview.tsx');
const id = (s: string) => s;

const prof = (pid: string, printer: PrintProfile['printer'], template: PrintProfile['template'], preset: Parameters<typeof presetPaper>[0]): PrintProfile =>
  ({ id: pid, name: pid, printer, template, paper: presetPaper(preset)!, options: defaultPrintOptions(printer) });
const page = () => prof('office', 'page', 'page_branded', 'a4');
const mip = () => prof('mip480', 'impact', 'impact_plain', 'ff_a4');
const van = () => prof('van-80', 'thermal', 'roll_compact', 'roll80');

/** القالب صالحٌ بقواعد الخادم نفسها (layoutIssues) */
const valid = (p: PrintProfile) => assert.deepEqual(layoutIssues(p, 'p'), [], JSON.stringify(p.options.layout));

test('بطاقات التصميم: الثالثة «ثنائي اللغة» للصفحة والنقطية وحدهما، واختيارها يضع القالب الأحادي وتخطيطه — والعودة لقالبٍ تعيد التصميم الحالي', () => {
  // «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦): بطاقةٌ رابعة للطابعة العادية وحدها — تحديثٌ واعٍ للحارس
  const kinds = (p: PrintProfile) => designCards(p).map((c) => (c.kind === 'template' ? c.t : c.kind));
  assert.deepEqual(kinds(page()), ['page_branded', 'page_plain', 'grid', 'preprinted']);
  assert.deepEqual(kinds(mip()), ['impact_plain', 'impact_preprinted', 'grid']);
  assert.ok(!kinds(van()).includes('grid'), 'الرول بلا تصميم ثنائي اللغة');
  assert.ok(!kinds(van()).includes('preprinted') && !kinds(mip()).includes('preprinted'), 'النموذج المطبوع مسبقاً للطابعة العادية وحدها');

  const grid = applyDesignCard(page(), { kind: 'grid' });
  assert.equal(grid.template, 'page_plain');
  assert.equal(grid.options.layout?.design, 'grid_bilingual');
  assert.equal(grid.options.layout?.logo, 'center');
  assert.equal(grid.options.layout?.tableStyle, 'grid');
  assert.deepEqual(grid.options.layout?.order, [...sectionsFor('page', 'grid_bilingual')]);
  valid(grid);
  assert.ok(designCardSelected(grid, { kind: 'grid' }));
  assert.ok(!designCardSelected(grid, { kind: 'template', t: 'page_plain' }), 'القالب الأساسي لا يبدو مختاراً تحت ثنائي اللغة');
  const gridMip = applyDesignCard(mip(), { kind: 'grid' });
  assert.equal(gridMip.template, 'impact_plain');
  valid(gridMip);

  const back = applyDesignCard(grid, { kind: 'template', t: 'page_branded' });
  assert.equal(back.template, 'page_branded');
  assert.notEqual(back.options.layout?.design, 'grid_bilingual');
  assert.ok(designCardSelected(back, { kind: 'template', t: 'page_branded' }));
  // قالبٌ بلا تخطيط يبقى بلا تخطيط عند تبديل القالب (مطبوعة اليوم حرفياً)
  const plain = applyDesignCard(page(), { kind: 'template', t: 'page_plain' });
  assert.equal(plain.template, 'page_plain');
  assert.ok(!('layout' in plain.options));
});

test('ترتيب الأقسام: ▲▼ معطّلةٌ حيث تمنع القاعدة (الترويسة أولاً، التواقيع ثم التذييل آخراً، الإجماليات بعد الأصناف)', () => {
  const rows = sectionRows(page());
  assert.deepEqual(rows.map((r) => r.id), [...sectionsFor('page', 'standard')]);
  const at = (rs: typeof rows, sid: string) => rs.find((r) => r.id === sid)!;
  for (const pinned of ['header', 'signatures', 'footer']) {
    assert.equal(at(rows, pinned).up, false, pinned);
    assert.equal(at(rows, pinned).down, false, pinned);
  }
  assert.equal(at(rows, 'info').up, false, 'لا شيء فوق الترويسة');
  assert.equal(at(rows, 'items').up, true);
  assert.equal(at(rows, 'note').up, true);
  assert.equal(at(rows, 'installments').down, false, 'لا شيء بين التواقيع والتذييل');

  // نقل الإجماليات فوق الأصناف ممنوع، وتحت الملاحظة مسموح
  const p = page();
  const items = rows.findIndex((r) => r.id === 'items');
  const moved = sectionRows(p).find((r) => r.id === 'totals')!;
  assert.equal(moved.up, true, 'الإجماليات تصعد فوق ملاحظة الأسعار');
  const up1 = resetSectionOrder(p);
  assert.equal(up1, p, 'الترتيب الافتراضي لا يُنشئ تخطيطاً');
  assert.ok(orderIsDefault(p));

  // الرول: رمز QR يصعد فوق التواقيع (بعد الأصناف) ولا يتجاوز الأصناف
  const roll = sectionRows(van());
  assert.deepEqual(roll.map((r) => r.id), [...sectionsFor('thermal', 'standard')]);
  assert.equal(at(roll, 'qr').up, true);
  assert.equal(at(roll, 'customer').up, true);
  assert.ok(items > 0);
});

test('السحب و▲▼ يمرّان بـmoveSection: النقل صالحٌ بقواعد الخادم، و«إعادة الترتيب الافتراضي» تعيد ترتيب اليوم', async () => {
  const { moveSection } = await import('../../lib/print/printSettings');
  const p = page();
  const order0 = sectionsFor('page', 'standard');
  const noteAt = order0.indexOf('note');
  const q = moveSection(p, 'note', noteAt - 1); // الملاحظة فوق الأصناف
  assert.ok(q.options.layout, 'النقل يُنشئ التخطيط');
  assert.equal(q.options.layout!.order.indexOf('note'), noteAt - 1);
  valid(q);
  assert.ok(!orderIsDefault(q));
  assert.equal(sectionRows(q).find((r) => r.id === 'note')!.down, true);
  const r = resetSectionOrder(q);
  assert.deepEqual(r.options.layout!.order, [...order0]);
  assert.ok(orderIsDefault(r));
  // ممنوع: الإجماليات فوق الأصناف ⇒ القالب كما هو
  const itemsAt = order0.indexOf('items');
  assert.equal(moveSection(p, 'totals', itemsAt), p);
});

test('الخط والشعار والجدول واللون: الصفحة والنقطية بحجم خطٍّ يُنشئ التخطيط، والرول بمواضع شعاره، واللون الفاتح يُرفض برسالته', () => {
  assert.deepEqual([...LAYOUT_FONT_SCALES], [0.9, 1, 1.15]);
  const p = page();
  // حجم خطٍّ محفوظ بلا تخطيط لا أثر له على الصفحة اليوم ⇒ يُعرض 100%
  const stale = { ...p, options: { ...p.options, fontScale: 1.15 as const } };
  assert.equal(effectiveFontScale(stale), 1);
  const f = withLayoutFontScale(p, 1.15);
  assert.equal(f.options.fontScale, 1.15);
  assert.ok(f.options.layout, 'الخط على الصفحة يُنشئ التخطيط فيُطبَّق');
  assert.equal(effectiveFontScale(f), 1.15);
  valid(f);
  assert.equal(effectiveFontScale({ ...van(), options: { ...van().options, fontScale: 1.3 } }), 1.3, 'الرول يطبّق حجمه اليوم');

  // التحرير الحرّ (pd_spec B.3): الرول صار يقبل الشعار يميناً ويساراً أيضاً
  assert.deepEqual([...logoChoices(van())], ['start', 'center', 'end', 'none']);
  assert.deepEqual([...logoChoices(page())], ['start', 'center', 'end', 'none']);

  assert.equal(layoutEditable(page()), true);
  assert.equal(layoutEditable(legacyPageProfile()), false, 'الافتراضي يُنسخ ولا يُعدَّل');
  assert.equal(layoutEditable(legacyThermalProfile()), false);
  assert.equal(layoutEditable({ ...van(), template: 'roll_classic' }), false);

  for (const c of ACCENT_PALETTE) assert.equal(accentInputState(c), 'ok', c);
  assert.equal(accentInputState('#FFFF00'), 'light');
  assert.equal(accentInputState('#f5f5f5'), 'light');
  assert.equal(accentInputState('#12'), 'invalid');
  assert.equal(accentInputState('red'), 'invalid');
});

test('المستند النموذجي يحمل رمز الصنف وضريبة السطر والعنوان الوطني — ويُبقي بيانات الشركة المحفوظة ورمز المرحلة الثانية', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  const inv = previewInvoiceDoc(null, id, now);
  assert.ok(inv.items.length >= 2);
  for (const it of inv.items) {
    assert.match(String(it.code), /^P-\d{4}$/);
    assert.equal(typeof it.taxAmt, 'number');
  }
  const sumVat = Math.round(inv.items.reduce((a, it) => a + (it.taxAmt ?? 0), 0) * 100) / 100;
  assert.equal(sumVat, inv.tax, 'ضريبة الأسطر = ضريبة المستند');
  assert.ok(inv.company?.addrCity && inv.company.addrPostalCode);
  assert.ok(inv.customer.postalCode && inv.customer.city && inv.customer.taxNumber);
  assert.equal(inv.zatca?.phase, 2, 'رمز المرحلة الثانية التجريبي باقٍ في كل تخطيط');
  const own = previewInvoiceDoc({ name: 'شركة', addrCity: 'الدمام', addrPostalCode: '32241', printTexts: { version: 1 } }, id, now);
  assert.equal(own.company?.name, 'شركة');
  assert.equal(own.company?.addrCity, 'الدمام');
  assert.equal(own.company?.addrPostalCode, '32241');
  assert.deepEqual(own.company?.printTexts, { version: 1 }, 'نصوص الشركة تظهر في المعاينة كما تُطبع');
  assert.equal(own.company?.printSettings, undefined, 'المظهر من القالب المفتوح لا من المحفوظ');
  const rcp = previewReceiptDoc(null, id, now);
  assert.equal(rcp.kind, 'receipt');
  assert.equal(rcp.amount, inv.total);
  assert.ok(!('zatca' in rcp));
});

test('المعاينة ترسم القالب الحقيقي بمظهر القالب المفتوح: ثنائي اللغة بسمته، وقالبٌ بلا تخطيط بلا سمة — والعلامة المائية دائماً', () => {
  const render = (p: PrintProfile) => renderToStaticMarkup(createElement(PrintPreview, { profile: p, companyName: 'شركة', brandColor: '#1e3a8a', company: null }));
  const grid = render(applyDesignCard(page(), { kind: 'grid' }));
  assert.ok(grid.includes('data-preview="sheet"'));
  assert.ok(grid.includes('data-print-layout="grid_bilingual"'), 'القالب ثنائي اللغة نفسه في المعاينة');
  assert.ok(grid.includes('نموذج اختبار — ليس مستندا ضريبيا'));
  const today = render(page());
  assert.ok(today.includes('data-preview="sheet"'));
  assert.ok(!today.includes('data-print-layout'), 'بلا تخطيط ⇒ ورقة اليوم بلا سمة');
  const mono = render(mip());
  assert.ok(mono.includes('data-print-look="mono bold"'), 'النقطية بمظهرها الأحادي العريض');
});

test('التوصيل: كتلة «التخطيط» في الخطوة الرابعة، و▲▼ والسحب عبر moveSection/canMoveSection، والمعاينة بـlookFor والقالب الحقيقي', () => {
  const s = panel();
  const use = "<Section title={tr('التخطيط')} open><LayoutFields p={p} update={update} /></Section>";
  assert.ok(s.includes(use));
  assert.ok(s.indexOf(use) > s.indexOf('{editor.step === 4 && ('));
  // «نموذج الشركة المطبوع مسبقاً»: اللوحة تستورد معها مصغّرة البطاقة الرابعة ومفتاحها (FormThumb وdesignCardId) — تحديثٌ واعٍ للحارس
  const imp = /import PrintPreview, \{([^}]*)\} from '\.\/PrintPreview';/.exec(s);
  assert.ok(imp, 'استيراد المعاينة');
  for (const n of ['GridThumb', 'LayoutFields', 'applyDesignCard', 'designCardSelected', 'designCards']) assert.match(imp[1], new RegExp(`\\b${n}\\b`), n);
  assert.ok(s.includes('{designCards(p).map((c) => {'), 'بطاقات التصميم مع ثنائي اللغة');
  assert.ok(s.includes('onClick={() => update(applyDesignCard(p, c))}'));
  // «إزالة الضريبة» (E6): المصغّرتان بلا مربع الرمز لشركةٍ بلا ضريبة — تحديثٌ واعٍ للحارس
  // والمصغّرات كلها بعلم الشركة (FormThumb للبطاقة الرابعة إن وُصلت) — تحديثٌ واعٍ للحارس
  assert.ok(s.includes('<TemplateThumb t={t} taxOff={taxOff} />') && s.includes('<GridThumb taxOff={taxOff} />'));
  if (s.includes('<FormThumb')) assert.ok(s.includes('<FormThumb taxOff={taxOff} />'));
  const v = preview();
  const sec = v.slice(v.indexOf('export function LayoutFields('), v.indexOf('function AccentPicker('));
  assert.ok(sec.length > 1000);
  for (const frag of [
    // «إزالة الضريبة» (E6): السحب و▲▼ بمواضع layoutSectionRows (r.at وr.upTo وr.downTo = i وi ∓ 1 للشركة بضريبتها) — تحديثٌ واعٍ
    'draggable={movable}', 'onDragOver={(e) => { if (drag && drag !== r.id && canMoveSection(p, drag, r.at))', 'onDrop={(e) => {',
    // ▲▼ تمرّ بـmove، وتسجّل قبلها زرّ التركيز بعد النقل (printLayoutReview.test.ts)
    "disabled={!r.up} onClick={() => { refocus.current = { id: r.id, dir: 'up' }; move(r.id, r.upTo); }}",
    "disabled={!r.down} onClick={() => { refocus.current = { id: r.id, dir: 'down' }; move(r.id, r.downTo); }}",
    'const rows = layoutSectionRows(p, taxOff);',
    'const move = (id: SectionId, to: number) => update(moveSection(p, id, to));', "tr('إعادة الترتيب الافتراضي')", "tr('اسحب لتغيير الترتيب')",
    "tr('مكان الشعار')", "tr('حجم الشعار')", "tr('حجم الخط')", "tr('شكل الجدول')", "tr('ترتيب الأقسام')", '<AccentPicker',
  ]) assert.ok(sec.includes(frag), frag);
  assert.ok(v.includes("tr('لون مخصص')") && v.includes('tr(PRINT_ISSUES.layoutAccent)'), 'اللون المخصص برسالة التباين');
  assert.ok(s.includes('<PrintPreview profile={p} companyName={companyName} brandColor={brandColor} company={company} />'));
  // لا رمز حقيقي يُبنى في الإعدادات (§4.14) — ما يرسمه القالب الحقيقي رمزُ المعايرة التجريبي
  for (const f of [s, v]) assert.doesNotMatch(f, /from 'qrcode'|buildZatcaQr|QRCode\.|QrImage/);
  assert.ok(v.includes('const look = useMemo(() => lookFor(profile), [profile]);'));
  assert.ok(v.includes('<PrintLookContext.Provider value={look}>'));
  assert.ok(v.includes("{doc.kind === 'invoice' ? <PrintableInvoice doc={doc} /> : <PrintableReceipt doc={doc} />}"));
  assert.ok(v.includes('thermalPreviewHtml(doc, { tr, paperMm, profile })'), 'الرول بملفّ القالب المفتوح');
  assert.ok(v.includes('const d = sampleInvoiceDoc(company, tr, now);'), 'مستند المعايرة بعلامة التجربة');
  // كل زرٍّ في اللوحة والمعاينة type="button" (أوّل سماته بعد key) — لا إرسال نموذجٍ بالخطأ
  for (const [name, src] of [['panel', s], ['preview', v]] as const) {
    const all = src.match(/<button\b/g)?.length ?? 0;
    const typed = src.match(/<button(?:\s+key=\{[^}]*\})?\s+type="button"/g)?.length ?? 0;
    assert.equal(typed, all, name);
  }
});

test('الترجمة: عبارات B وC وقائمة المحرّرين وكل tr(\'…\') في اللوحة والمعاينة لها en/fr/tr/zh — والفرنسية بلا فاصلة علوية', () => {
  const want = new Set<string>([
    ...Object.values(PRINT_TEXT_WARNINGS), ...PRINT_TEXT_CATALOG.map((e) => e.ar),
    'حذف السطر', 'استعادة', 'السطور المحذوفة', 'تأكيد الحذف', 'لا توجد سطور محذوفة', 'التخطيط', 'مكان الشعار', 'حجم الشعار', 'لون التمييز',
    'لون مخصص', 'حجم الخط', 'شكل الجدول', 'ترتيب الأقسام', 'إعادة الترتيب الافتراضي', 'اسحب لتغيير الترتيب',
  ]);
  // الفاصلة العلوية تُفحص في عبارات الحزمة وحدها — عبارات اللوحة القديمة كما ترجمها أصحابها، وعناوين الحالة (قرار المالك ٤ نوفمبر
  // ٢٠٢٦) مترجمةٌ قبل الحزمة في ZATCA_PRINT_PHRASES وتُطبع ترجمتُها على الورقة اليوم — تغييرها يغيّر ورقة شركةٍ لغتها الثانية الفرنسية
  const ours = new Set(want);
  for (const k of PRINT_STATUS_TITLE_KEYS) ours.delete(printTextEntry(k)!.ar);
  for (const src of [panel(), preview()]) for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) want.add(m[1]);
  const missing: string[] = [];
  for (const ar of want) {
    if (!/[؀-ۿ]/.test(ar)) continue;
    const t = PHRASES[ar];
    if (!t) { missing.push(ar); continue; }
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${ar}» ${lang}`);
    if (ours.has(ar)) assert.ok(!/['’]/.test(t.fr), `«${ar}» فرنسية بفاصلة علوية`);
  }
  assert.deepEqual(missing, []);
});

test('حقول «التخطيط» مرسومةً: الثابت لا يُسحب وأزراره معطّلة، والمتحرّك يُسحب، وثنائي اللغة بشبكة وحدها، والكلاسيكي برسالته', async () => {
  const { LayoutFields } = await import('./PrintPreview');
  const html = (p: PrintProfile) => renderToStaticMarkup(createElement(LayoutFields, { p, update: () => {} }));
  const li = (h: string, sid: string) => {
    const at = h.indexOf(`<li data-section="${sid}"`);
    assert.ok(at >= 0, sid);
    return h.slice(at, h.indexOf('</li>', at));
  };
  const h = html(page());
  assert.ok(h.includes('data-layout-today'), 'بلا تخطيط: تلميح «كما هي اليوم»');
  for (const pinned of ['header', 'signatures', 'footer']) {
    const x = li(h, pinned);
    assert.ok(x.includes('draggable="false"'), pinned);
    assert.equal(x.match(/disabled=""/g)?.length, 2, `${pinned}: ▲▼ معطّلان`);
  }
  assert.ok(li(h, 'items').includes('draggable="true"'));
  const grid = html(applyDesignCard(page(), { kind: 'grid' }));
  assert.ok(grid.includes('data-section="parties"'), 'قسم البائع والمشتري في ثنائي اللغة');
  assert.ok(!grid.includes('data-layout-today'));
  const tables = grid.slice(grid.indexOf('aria-label="شكل الجدول"'));
  assert.equal(tables.slice(0, tables.indexOf('</div></div>')).match(/disabled=""/g)?.length, 2, 'الخطوط والمخطط معطّلان في ثنائي اللغة');
  assert.ok(!html(legacyPageProfile()).includes('data-section-order'), 'الافتراضي بلا حقول تخطيط (يُنسخ أولاً)');
  assert.ok(html({ ...van(), template: 'roll_classic' }).includes('الرول الكلاسيكي لا يقبل تخطيطاً مخصصاً'));
  assert.ok(!html(van()).includes('aria-label="شكل الجدول"'), 'الرول بلا شكل جدول');
});

test('مخطّط «المقاس والهوامش»: رمز QR وجدول الأصناف يُرسمان كاليوم ما لم تحذفهما الشركة صراحةً — والعلامة المائية باقية (شاشة لا ورق)', () => {
  const paper = (p: PrintProfile) => renderToStaticMarkup(createElement(PaperPreview, { profile: p, companyName: 'شركة', brandColor: '#1e3a8a' }));
  const qrSlot = /رمز QR · <span dir="ltr">≈/;
  for (const p of [page(), mip(), van()]) {
    const today = paper(p);
    assert.match(today, qrSlot, `${p.id}: الرمز كاليوم`);
    assert.ok(today.includes('صنف تجريبي'), `${p.id}: الأصناف كاليوم`);
    assert.ok(today.includes(PRINT_SAMPLE_WATERMARK));
    // إخفاء القسم الحامل وحده لا يحذف الرمز من المخطّط
    assert.match(paper(withLayout(p, { sections: { totals: { visible: false } } })), qrSlot, `${p.id}: الحامل المخفي`);
    const noQr = paper(withLayout(p, { sections: { qr: { visible: false } } }));
    assert.doesNotMatch(noQr, qrSlot, `${p.id}: الرمز المحذوف`);
    assert.ok(noQr.includes('صنف تجريبي') && noQr.includes(PRINT_SAMPLE_WATERMARK), `${p.id}: الباقي كما هو`);
    const noItems = paper(withLayout(p, { sections: { items: { visible: false } } }));
    assert.ok(!noItems.includes('صنف تجريبي'), `${p.id}: الأصناف المحذوفة`);
    assert.match(noItems, qrSlot);
    assert.ok(noItems.includes(PRINT_SAMPLE_WATERMARK), `${p.id}: علامة الشاشة باقية`);
    assert.ok(paper(withLayout(p, { stamps: false })).includes(PRINT_SAMPLE_WATERMARK), `${p.id}: الأختام لا تمسّ علامة المعاينة`);
  }
});

// ─── «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦): البطاقة الرابعة ومصغّرتها ومعاينتها ومخطّطها ───

test('بطاقة «نموذج الشركة المطبوع مسبقاً»: للطابعة العادية، واختيارها withDesign — والعودة منها لقالبٍ أو لثنائي اللغة تعيد الهامشين', () => {
  const f = applyDesignCard(page(), { kind: 'preprinted' });
  assert.equal(f.template, 'page_plain');
  assert.equal(f.options.layout?.design, 'preprinted');
  assert.ok(formOf(f), 'مواضع البداية');
  assert.deepEqual([f.paper.marginTopMm, f.paper.marginBottomMm], [0, 0], 'المواضع من ركن الورقة الفعلي');
  valid(f);
  assert.ok(designCardSelected(f, { kind: 'preprinted' }));
  assert.ok(!designCardSelected(f, { kind: 'grid' }));
  assert.ok(!designCardSelected(f, { kind: 'template', t: 'page_plain' }), 'القالب الأساسي لا يبدو مختاراً تحت النموذج');
  assert.ok(!designCardSelected(page(), { kind: 'preprinted' }));
  // اختياره ثانيةً لا يمسّ المواضع
  assert.equal(applyDesignCard(f, { kind: 'preprinted' }), f);
  const back = applyDesignCard(f, { kind: 'template', t: 'page_branded' });
  assert.equal(back.template, 'page_branded');
  assert.notEqual(back.options.layout?.design, 'preprinted');
  assert.ok(!back.options.layout || !('form' in back.options.layout), 'المواضع لا تنتقل إلى التصميم الحالي');
  assert.deepEqual([back.paper.marginTopMm, back.paper.marginBottomMm], [page().paper.marginTopMm, page().paper.marginBottomMm]);
  assert.ok(designCardSelected(back, { kind: 'template', t: 'page_branded' }));
  const grid = applyDesignCard(f, { kind: 'grid' });
  assert.equal(grid.options.layout?.design, 'grid_bilingual');
  assert.ok(!('form' in grid.options.layout!));
  valid(grid);
  // ورقٌ بلا طول: البطاقة تُعرض (تعطّلها اللوحة برسالتها) واختيارها لا يغيّر شيئاً — لا يقبله النموذج
  const endless: PrintProfile = { ...page(), paper: { ...page().paper, preset: 'custom', lengthMm: null } };
  assert.ok(designCards(endless).some((c) => c.kind === 'preprinted'));
  assert.equal(applyDesignCard(endless, { kind: 'preprinted' }), endless);
  // المفتاح الثابت لكل بطاقة
  assert.deepEqual(designCards(page()).map(designCardId), ['page_branded', 'page_plain', 'grid_bilingual', 'preprinted']);
});

test('فاتورة معاينة النموذج: فاتورة المعاينة نفسها بباركود كل صنفٍ وملاحظة — وفاتورة المعاينة والمستند التجريبيّ بلاهما كما هما', () => {
  const now = new Date('2026-11-11T10:00:00Z');
  const inv = previewInvoiceDoc(null, id, now);
  const doc = previewFormDoc(null, id, now);
  assert.deepEqual(doc.items.map((it) => it.barcode), ['6281000001001', '6281000001002']);
  assert.equal(doc.notes, 'ملاحظة تجريبية');
  const { notes: _n, items, ...rest } = doc;
  const { items: invItems, ...invRest } = inv;
  assert.deepEqual(rest, invRest);
  assert.deepEqual(items.map(({ barcode: _b, ...it }) => it), invItems);
  for (const it of inv.items) assert.ok(!('barcode' in it), 'فاتورة المعاينة بلا باركود (الحرّاس الذهبية)');
  assert.ok(!('notes' in inv));
  // بلا ضريبة: المستند نفسه بلا رقمٍ ضريبي ومختومٌ بلا ضريبة
  const off = previewFormDoc({ name: 'شركة', taxDisabled: true }, id, now);
  assert.equal(off.taxFree, true);
  assert.ok(!off.customer.taxNumber && !off.company?.taxNumber);
  assert.equal(off.items[0].barcode, '6281000001001');
});

test('معاينة النموذج: القالب الحقيقي بأوراقه بعرض الورق (بالمم) وفاتورته — بلا تبويب «سند قبض» — والعلامة المائية دائماً', () => {
  const render = (p: PrintProfile) => renderToStaticMarkup(createElement(PrintPreview, { profile: p, companyName: 'شركة', brandColor: '#1e3a8a', company: null }));
  const f = applyDesignCard(page(), { kind: 'preprinted' });
  const h = render(f);
  assert.ok(h.includes('data-preview="sheet"'));
  assert.ok(h.includes('data-print-layout="preprinted"'), 'جذر النموذج في المعاينة');
  assert.ok(h.includes(`width:${(210 * 96) / 25.4}px`), 'الورقة بعرض A4 بالمم');
  assert.ok(!h.includes('سند قبض'), 'النموذج للفواتير وحدها');
  assert.ok(h.includes('نموذج اختبار — ليس مستندا ضريبيا'));
  // غير النموذج: التبويبان والعرض 794 كما كانا
  const today = render(page());
  assert.ok(today.includes('سند قبض') && today.includes('width:794px'));
  const a5 = render(applyDesignCard(prof('a5', 'page', 'page_branded', 'a5'), { kind: 'preprinted' }));
  assert.ok(a5.includes(`width:${(148 * 96) / 25.4}px`), 'A5 بعرضه');
});

test('مخطّط «المقاس والهوامش» للنموذج: مربعٌ لكل حقلٍ وشريطٌ لكل عمودٍ باسمه في موضعه — بلا مستندٍ تخطيطيّ، وبلا حقول الضريبة والرمز لشركةٍ بلا ضريبة', () => {
  const f0 = applyDesignCard(page(), { kind: 'preprinted' });
  let form = formOf(f0)!;
  form = withFormField(form, f0.paper, { id: 'sellerVat' });
  const f: PrintProfile = { ...f0, options: { ...f0.options, layout: { ...f0.options.layout!, form } } };
  const paper = (p: PrintProfile, taxOff = false) => renderToStaticMarkup(createElement(TaxOffPrintContext.Provider, { value: taxOff },
    createElement(PaperPreview, { profile: p, companyName: 'شركة', brandColor: '#1e3a8a' })));
  const h = paper(f);
  assert.ok(h.includes('data-form-schematic'));
  for (const x of form.fields) assert.ok(h.includes(`data-field="${x.id}"`) && h.includes(FORM_FIELD_LABELS[x.id]), x.id);
  for (const c of form.table!.columns) assert.ok(h.includes(`data-column="${c.id}"`) && h.includes(FORM_COLUMN_LABELS[c.id]), c.id);
  assert.ok(!h.includes('صنف تجريبي') && !h.includes('فاتورة ضريبية مبسطة'), 'لا مستند تخطيطيّ فوق النموذج');
  assert.ok(h.includes(PRINT_SAMPLE_WATERMARK));
  const off = paper(f, true);
  assert.ok(!off.includes('data-field="sellerVat"') && !off.includes('data-field="qr"'));
  assert.ok(off.includes('data-field="docNumber"'));
  // غير النموذج: المستند التخطيطيّ كما كان
  assert.ok(!paper(page()).includes('data-form-schematic'));
});

test('مصغّرة النموذج: إطاراتٌ باهتة وقيمٌ داكنة، ومربع الرمز لشركةٍ بضريبتها وحدها', () => {
  const t = renderToStaticMarkup(createElement(FormThumb, {}));
  assert.ok(t.includes('data-thumb="preprinted"') && t.includes('aria-hidden="true"'));
  assert.ok(t.includes('repeating-conic-gradient'));
  assert.ok(!renderToStaticMarkup(createElement(FormThumb, { taxOff: true })).includes('repeating-conic-gradient'));
});
