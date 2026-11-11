// «إعدادات الطباعة» في الواجهة (lib/print/printSettings.ts + printSettingsCore.ts) — طلب المالك ٢٣ أكتوبر ٢٠٢٦.
// النواة نسخة حرفية من الخادم، والقراءة تعود للسلوك الافتراضي عند أي عطب، وحساب النقاط والرمز، واختيار الجهاز، وحارسا
// ZATCA (لا خيار يخفي محتوىً إلزامياً، والحد الأدنى لنقاط الخلية لا ينزل)، وترجمة كل تسمية، وتوصيل التبويب.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PAPER_PRESETS, PRESET_LABELS, PRINTER_HINTS, PRINTER_LABELS, PRINT_ISSUES, PRINT_NOTES, PRINT_SAMPLE_WATERMARK, PRINT_WARNINGS,
  QR_DOTS_PER_CELL, STAMPED_QR_CELLS, TEMPLATE_HINTS, TEMPLATE_LABELS, DOC_KIND_LABELS, DOC_KIND_SHORT, FEED_LABELS, LEGACY_NAMES, PRINTER_SHORT,
  COMPANY_SETTINGS_MISSING_MSG, defaultPrintOptions, duplicateProfile, geometry, inchesToDots, legacyPrintSettings, maxPrintableDots, mmToDots,
  newProfile, normalizePrintSettings, pdfProfileOf, presetPaper, printSaveErrorMessage, printSettingsV1Schema, profileFor,
  profileUsage, profileWarnings, qrCellsForVersion, qrDotsPerCell, qrFits, qrPlan, rescaleDots, uniqueProfileName, withDpi,
  withPaper, withPrinter, withoutProfile, checkPrintSettings,
  ACCENT_PALETTE, DESIGN_HINTS, DESIGN_LABELS, LOGO_POSITION_LABELS, LOGO_SIZE_LABELS, SECTION_IDS, SECTION_LABELS, TABLE_STYLE_LABELS,
  accentContrastOk, canMoveSection, defaultPrintLayout, designsFor, layoutOf, moveSection, normalizeSectionOrder, sectionsFor, withDesign, withLayout,
  ALIGN_LABELS, CANVAS_BAND_LABELS, CANVAS_BOX_IDS, CANVAS_BOX_LABELS, ALIGNS, CANVAS_BANDS,
  COMPLIANCE_HIDE_SECTIONS, areStampsRemoved, isItemsRemoved, isQrRemoved,
  QR_REMOVE_WARNING, ITEMS_REMOVE_WARNING, STAMPS_REMOVE_WARNING, QR_REMOVED_BADGE, QR_REMOVE_ACTION, QR_RESTORE_ACTION, STAMPS_LABEL, STAMPS_HINT,
  STAMPS_REMOVE_ACTION, STAMPS_RESTORE_ACTION, QR_FLOW_NOTE, QR_PANEL_NOTE, QR_ORPHAN_NOTE,
  PRINT_FORM_IMAGE_MISSING_MSG, PRINT_LIMITS, deviceProfilesFor, formDesignBlock, isFormProfile, profileIssues, routingAllowsProfile, withPreset,
  type PrintProfile, type PrintSettingsV1,
} from './printSettings';
import * as printSettingsModule from './printSettings';
import {
  FORM_COLUMN_LABELS, FORM_FIELD_GROUPS, FORM_FIELD_LABELS, FORM_NOTES, FORM_VALUE_LANG_LABELS, FORM_WARNINGS, formIssues, starterForm,
} from './formModel';
import { PHRASES } from '../../i18n/strings';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
/** جسم الملف بعد أسطر التعليق // والفراغ في أوّله (كحارس نسخ ZATCA) */
const copyBody = (s: string) => s.replace(/\r\n/g, '\n').replace(/^(?:[ \t]*\/\/[^\n]*\n|[ \t]*\n)*/, '');

const profile = (id: string, printer: PrintProfile['printer'], template: PrintProfile['template'], preset: Parameters<typeof presetPaper>[0]): PrintProfile =>
  ({ id, name: id, printer, template, paper: presetPaper(preset)!, options: defaultPrintOptions(printer) });
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

test('النواة نسخة حرفية من الخادم — قاعدة واحدة تحفظ وتقرأ', () => {
  const web = read('src', 'lib', 'print', 'printSettingsCore.ts');
  const server = read('..', 'backend', 'src', 'services', 'printSettingsCore.ts');
  assert.ok(web.startsWith('// ====') && web.includes('نسخة حرفية من backend/src/services/printSettingsCore.ts'));
  assert.equal(copyBody(web), copyBody(server), 'printSettingsCore.ts في الواجهة يختلف عن الخادم — انسخه من جديد');
});

test('null ⇒ السلوك الافتراضي حرفياً (التصميم §1.7)', () => {
  const legacy = {
    version: 1,
    profiles: [
      {
        id: 'legacy-58', name: 'حرارية 58 مم', printer: 'thermal', template: 'roll_classic',
        paper: { preset: 'roll58', widthMm: 58, lengthMm: null, feed: 'roll', dpi: 203, printableDots: 384, offsetXmm: 0, marginTopMm: 0, marginBottomMm: 0 },
        options: {
          showLogo: false, showContact: true, showRepName: true, showSignatures: true, showItemUnit: true, showItemCodes: false, showCustomerBalance: false,
          footerText: null, fontScale: 1, boldBody: false, qrSize: 'auto', copies: 1, copyLabels: false, cutAfter: false, feedAfterMm: 10, graphicsQuality: 'quality',
        },
      },
      {
        id: 'legacy-a4', name: 'صفحة A4 وملف PDF', printer: 'page', template: 'page_branded',
        paper: { preset: 'a4', widthMm: 210, lengthMm: 297, feed: 'sheet', dpi: null, printableDots: null, offsetXmm: 0, marginTopMm: 10, marginBottomMm: 10 },
        options: {
          showLogo: true, showContact: true, showRepName: true, showSignatures: true, showItemUnit: true, showItemCodes: false, showCustomerBalance: false,
          footerText: null, fontScale: 1, boldBody: false, qrSize: 'auto', copies: 1, copyLabels: false, cutAfter: false, feedAfterMm: 0, graphicsQuality: 'quality',
        },
      },
    ],
    routing: { invoice: 'legacy-58', receipt: 'legacy-58', statement: null, notices: null },
    pdfProfileId: 'legacy-a4',
    repMayChoose: true,
  };
  assert.deepEqual(normalizePrintSettings(null), legacy);
  assert.deepEqual(normalizePrintSettings(undefined), legacy);
  assert.equal(JSON.stringify(normalizePrintSettings(null)), JSON.stringify(legacy), 'ترتيب المفاتيح ثابت');
  // حفظ الافتراضي كما هو = null تماماً في الأثر
  assert.deepEqual(normalizePrintSettings(JSON.parse(JSON.stringify(legacy))), normalizePrintSettings(null));
  // الأزرار كاليوم: الحراري للفواتير والسندات، ولا طباعة مباشرة لكشف الحساب ومستندات المخزون، وPDF الـA4
  const s = normalizePrintSettings(null);
  assert.equal(profileFor(s, 'invoice')?.id, 'legacy-58');
  assert.equal(profileFor(s, 'receipt')?.id, 'legacy-58');
  assert.equal(profileFor(s, 'statement'), null);
  assert.equal(profileFor(s, 'notices'), null);
  assert.equal(pdfProfileOf(s).id, 'legacy-a4');
});

test('القراءة لا ترمي: نسخة أحدث أو بنية تالفة أو قاعدة مكسورة ⇒ الافتراضي، والمفتاح المجهول يُهمل', () => {
  const legacy = legacyPrintSettings();
  for (const raw of [{ ...fleet(), version: 2 }, 'x', 42, [], {}, { ...fleet(), routing: { ...fleet().routing, statement: 'van-80' } }, { ...fleet(), profiles: [] }]) {
    assert.deepEqual(normalizePrintSettings(raw), legacy, JSON.stringify(raw).slice(0, 60));
  }
  assert.deepEqual(normalizePrintSettings(fleet()), fleet());
  const future = JSON.parse(JSON.stringify(fleet()));
  future.profiles[0].options.showItemBarcode = true; // خيارٌ أضافه خادمٌ أحدث ضمن v1
  future.routing.delivery = null;
  assert.deepEqual(normalizePrintSettings(future), fleet());
  // والحفظ صارم: الخادم يرفض المفتاح نفسه
  assert.equal(checkPrintSettings(future, true).ok, false);
});

test('النقاط والهندسة: 72 مم على 203 = 576، و8.0 بوصة على 180 = 1440، وعرض التخطيط الفعلي', () => {
  assert.equal(mmToDots(72, 203), 576);
  assert.equal(inchesToDots(8.0, 180), 1440);
  assert.equal(mmToDots(203.2, 180), 1440);
  const mip = geometry(profile('m', 'impact', 'impact_plain', 'ff_a4'));
  assert.equal(mip.cssWidthPx, 768);
  assert.ok(Math.abs(mip.printableWidthMm - 203.2) < 1e-9);
  assert.ok(Math.abs(mip.bandLeftMm - 3.4) < 1e-9, 'الحزمة في منتصف A4: 3.4 مم من كل جانب');
  assert.equal(mip.usableLengthMm, 287);
  assert.equal(mip.rowsPerPage, Math.floor(287 * 180 / 25.4));
  const r80 = geometry(profile('r', 'thermal', 'roll_compact', 'roll80'));
  assert.ok(Math.abs(r80.cssWidthPx - 272.3) < 0.1, `${r80.cssWidthPx}`);
  assert.equal(r80.printableWidthMm, 72);
  assert.equal(r80.rowsPerPage, null, 'الرول بلا صفحات');
  const shifted = profile('s', 'thermal', 'roll_compact', 'roll80');
  shifted.paper.offsetXmm = 2;
  assert.equal(geometry(shifted).bandLeftMm, 6);
  const a4 = geometry(profile('a', 'page', 'page_branded', 'a4'));
  assert.deepEqual([a4.dpi, a4.printableDots, a4.printableWidthMm, a4.rowsPerPage], [null, null, 190, null]);
  // تغيير الدقة بالمم نفسه
  assert.equal(rescaleDots(576, 203, 300, 'thermal', 80), 848);
  assert.equal(rescaleDots(848, 300, 203, 'thermal', 80), 576);
  assert.equal(withDpi(profile('r', 'thermal', 'roll_detailed', 'roll80'), 300).paper.printableDots, 848);
  // النقطية: سطر الطباعة 1440 سقفٌ مهما عرض الورق (كان 1488 على 210 مم و1708 على 241 مم فيضيع ما وراء 1440)
  assert.equal(maxPrintableDots('impact', 210, 180), 1440);
  assert.equal(maxPrintableDots('impact', 241, 180), 1440);
  assert.equal(rescaleDots(1708, 180, 180, 'impact', 241), 1440);
  assert.equal(rescaleDots(1488, 180, 180, 'impact', 210), 1440);
  const wide = profile('w', 'impact', 'impact_plain', 'ff_95x12');
  // 1700 نقطة على 203 = 212.5 مم ⇒ 1506 على 180 — فوق السطر ⇒ 1440
  assert.equal(withDpi({ ...wide, paper: { ...wide.paper, dpi: 203, printableDots: 1700 } }, 180).paper.printableDots, 1440, 'نقلٌ من دقةٍ أخرى لا يتجاوز السطر');
  // وكل مقاسٍ نقطيّ جاهز صالحٌ داخل السطر، والإزاحة الموجبة على حزمةٍ كاملة مرفوضةٌ برسالتها
  const offsetFull = profile('m', 'impact', 'impact_plain', 'ff_a4');
  offsetFull.paper.offsetXmm = 3.4;
  const bad = checkPrintSettings({ ...legacyPrintSettings(), profiles: [...legacyPrintSettings().profiles, offsetFull] }, true);
  assert.ok(!bad.ok && bad.issues.some((i) => i.message === PRINT_ISSUES.impactLine));
});

test('رمز QR: جدول نقاط الخلية لا ينزل حدّه الأدنى، والاتساع (الخلايا + 4) × النقاط ≤ الحزمة', () => {
  // حارس (d): الحد الأدنى لكل دقة لا ينزل عن هذه القيم أبداً — والتلقائي والكبير فوقه
  const FLOOR = { 203: 3, 300: 5, 180: 4 } as const;
  for (const dpi of [203, 300, 180] as const) {
    const t = QR_DOTS_PER_CELL[dpi];
    assert.ok(t.min >= FLOOR[dpi], `الحد الأدنى لـ${dpi} نزل`);
    assert.ok(t.min <= t.auto && t.auto <= t.large);
    assert.equal(qrDotsPerCell(dpi, 'min'), t.min);
  }
  assert.ok(Object.isFrozen(QR_DOTS_PER_CELL) && Object.isFrozen(QR_DOTS_PER_CELL[203]));
  assert.deepEqual([qrCellsForVersion(18), STAMPED_QR_CELLS.typical, STAMPED_QR_CELLS.max], [89, 89, 93]);
  assert.equal(qrFits(89, 4, 384), true);
  assert.equal(qrFits(93, 4, 384), false);
  // 58 مم: الرمز المختوم المعتاد بـ4 نقاط و~3.5 خلية صامتة (الوضع القائم)، والأكبر ينزل إلى 3 لا أقل
  const r58 = profile('r', 'thermal', 'roll_compact', 'roll58');
  const typical = qrPlan(r58, 89)!;
  assert.deepEqual([typical.fits, typical.dotsPerCell, typical.reduced, typical.quietCells], [true, 4, false, 3.5]);
  const worst = qrPlan(r58, 93)!;
  assert.deepEqual([worst.fits, worst.dotsPerCell, worst.reduced], [true, 3, true]);
  // MIP480: 5 نقاط ≈ 63 مم، و«كبير» 6
  const mip = profile('m', 'impact', 'impact_plain', 'ff_a4');
  const plan = qrPlan(mip, 89)!;
  assert.equal(plan.dotsPerCell, 5);
  assert.equal(Math.round(plan.sizeMm), 63);
  mip.options.qrSize = 'large';
  assert.equal(qrPlan(mip, 89)!.dotsPerCell, 6);
  // أضيق من أن يتسع حتى بالحد الأدنى ⇒ لا يتسع (الطباعة المباشرة تُرفض وPDF يبقى)
  const narrow = profile('n', 'thermal', 'roll_compact', 'roll58');
  narrow.paper.printableDots = 256;
  assert.equal(qrPlan(narrow, 93)!.fits, false);
  assert.equal(qrPlan(profile('a', 'page', 'page_branded', 'a4'), 89), null, 'العادية بمقاسات A4 اليوم');
});

test('التنبيهات: الرمز لا يتسع، والمرحلة الثانية تحت 384 نقطة، و85 مم، والنقطية بنسخها وطبقتها العليا', () => {
  const narrow = profile('n', 'thermal', 'roll_compact', 'roll58');
  narrow.paper.printableDots = 256;
  assert.ok(profileWarnings(narrow, { phase2: false }).warnings.includes(PRINT_WARNINGS.qrNoFit));
  assert.ok(profileWarnings(narrow, { phase2: true }).warnings.includes(PRINT_WARNINGS.phase2Narrow));
  assert.deepEqual(profileWarnings(profile('r', 'thermal', 'roll_compact', 'roll58'), { phase2: true }).warnings, [], '58 مم (384 نقطة) = الوضع القائم بلا تنبيه');
  assert.deepEqual(profileWarnings(profile('r', 'thermal', 'roll_compact', 'roll80'), { phase2: true }).warnings, []);
  assert.ok(profileWarnings(profile('r', 'thermal', 'roll_compact', 'roll85'), { phase2: false }).warnings.includes(PRINT_WARNINGS.roll85));
  const mip = profile('m', 'impact', 'impact_plain', 'ff_95x11');
  mip.options.copies = 2;
  const w = profileWarnings(mip, { phase2: false });
  assert.ok(w.warnings.includes(PRINT_WARNINGS.wide241) && w.warnings.includes(PRINT_WARNINGS.impactCopies));
  assert.ok(w.notes.includes(PRINT_NOTES.impactTopPly) && w.notes.includes(PRINT_NOTES.directChrome));
  assert.deepEqual(profileWarnings(profile('a', 'page', 'page_branded', 'a4'), { phase2: true }), { warnings: [], notes: [] });
});

test('اختيار الجهاز: يُحترم بإذن الشركة وقالبٍ موجود يصلح للنوع — وتوجيه الشركة null يبقى null', () => {
  const s = fleet();
  s.profiles.push(profile('van-58', 'thermal', 'roll_compact', 'roll58'));
  assert.equal(profileFor(s, 'invoice')?.id, 'mip480');
  assert.equal(profileFor(s, 'invoice', { byKind: { invoice: 'van-58' } })?.id, 'van-58', 'سيارة برول بجانب شاحنات MIP480');
  assert.equal(profileFor(s, 'invoice', { byKind: { invoice: 'ghost' } })?.id, 'mip480', 'قالب حُذف ⇒ اختيار الشركة');
  assert.equal(profileFor(s, 'statement', { byKind: { statement: 'van-58' } })?.id, 'office', 'لا رول لكشف الحساب');
  assert.equal(profileFor(s, 'notices', { byKind: { notices: 'mip480' } }), null, 'الشركة أغلقت الطباعة المباشرة لهذا النوع');
  assert.equal(profileFor({ ...s, repMayChoose: false }, 'invoice', { byKind: { invoice: 'van-58' } })?.id, 'mip480', 'الشركة لم تسمح');
  assert.equal(profileFor(s, 'receipt', null)?.id, 'van-80');
});

test('المحرّر: قالب جديد صالح لكل نوع، وتغيير النوع والمقاس، والنسخ، والحذف المحروس', () => {
  let s = legacyPrintSettings();
  for (const printer of ['thermal', 'impact', 'page'] as const) {
    const p = newProfile(printer, 'قالب', s.profiles);
    s = { ...s, profiles: [...s.profiles, p] };
  }
  assert.deepEqual(s.profiles.map((p) => p.id), ['legacy-58', 'legacy-a4', 'thermal-1', 'impact-1', 'page-1']);
  assert.deepEqual(s.profiles.map((p) => p.name).slice(2), ['قالب', 'قالب 2', 'قالب 3']);
  assert.equal(checkPrintSettings(s, true).ok, true, JSON.stringify(checkPrintSettings(s, true)));
  // نسخ الكلاسيكي ⇒ شريط مختصر بالمقاس نفسه (الكلاسيكي محجوز)
  const dup = duplicateProfile(s.profiles[0], 'حرارية 58 مم', s.profiles);
  assert.deepEqual([dup.id, dup.name, dup.template, dup.paper.printableDots], ['thermal-2', 'حرارية 58 مم 2', 'roll_compact', 384]);
  assert.equal(checkPrintSettings({ ...s, profiles: [...s.profiles, dup] }, true).ok, true);
  // تغيير النوع: تصميمه وورقه الافتراضيان، ويبقى التذييل
  const t = { ...s.profiles[2], options: { ...s.profiles[2].options, footerText: 'شكرا' } };
  const asImpact = withPrinter(t, 'impact');
  assert.deepEqual([asImpact.template, asImpact.paper.preset, asImpact.options.footerText, asImpact.options.boldBody], ['impact_plain', 'ff_a4', 'شكرا', true]);
  // تعديل العرض يُخرج من المقاس الجاهز، والمعايرة لا؛ والرول بلا طول
  assert.equal(withPaper(t, { widthMm: 79 }).paper.preset, 'custom');
  assert.equal(withPaper(t, { offsetXmm: 1.5 }).paper.preset, 'roll80');
  assert.equal(withPaper(t, { feed: 'sheet' }).paper.lengthMm, 297);
  assert.equal(withPaper(withPaper(t, { feed: 'sheet' }), { feed: 'roll' }).paper.lengthMm, null);
  // الحذف: لا لقالب مستعمل في التوجيه أو الـPDF
  assert.deepEqual(profileUsage(s, 'legacy-58'), ['invoice', 'receipt']);
  assert.deepEqual(profileUsage(s, 'legacy-a4'), ['pdf']);
  assert.equal(withoutProfile(s, 'legacy-58'), null);
  assert.equal(withoutProfile(s, 'legacy-a4'), null);
  assert.deepEqual(withoutProfile(s, 'impact-1')?.profiles.map((p) => p.id), ['legacy-58', 'legacy-a4', 'thermal-1', 'page-1']);
  assert.equal(uniqueProfileName('ق'.repeat(45), []).length, 40);
  assert.equal(Array.from(uniqueProfileName('ق'.repeat(45), [{ ...t, name: 'ق'.repeat(40) }])).length, 40);
});

test('حارس (c): لا خيار طباعة يخفي أو يصغّر محتوى ZATCA الإلزامي — في الأنواع ولا في مخطط الخادم', () => {
  const FORBIDDEN = [
    'showQr', 'hideQr', 'qrHidden', 'qrMin', 'qrSmall', 'showTitle', 'hideTitle', 'title', 'docTitle',
    'showTaxNumber', 'hideTaxNumber', 'showSellerTaxNumber', 'showSellerName', 'hideSellerName', 'showBuyerTaxNumber', 'hideBuyerTaxNumber',
    'showTaxBreakdown', 'hideTaxBreakdown', 'showVat', 'hideVat', 'showNotice', 'hideNotice', 'showWatermark', 'hideWatermark',
    'showIcv', 'hideIcv', 'showUuid', 'hideUuid', 'showTotalLabel', 'hideTotal', 'totalLabel',
  ];
  const typeKeys = Object.keys(defaultPrintOptions('page'));
  const schemaKeys = Object.keys(printSettingsV1Schema.shape.profiles.element.shape.options.shape);
  // التخطيط (٣ نوفمبر ٢٠٢٦) اختياريٌّ خارج الافتراضي عمداً: غيابه = مطبوعة اليوم
  assert.deepEqual([...typeKeys, 'layout'].sort(), [...schemaKeys].sort(), 'المخطط = مفاتيح الافتراضي + layout');
  for (const printer of ['thermal', 'impact', 'page'] as const) assert.ok(!('layout' in defaultPrintOptions(printer)), 'الافتراضي بلا تخطيط');
  const layoutKeys = Object.keys(defaultPrintLayout('page'));
  assert.deepEqual(layoutKeys, ['design', 'logo', 'logoSize', 'accent', 'tableStyle', 'order']);
  // التحرير الحرّ: خمسة مفاتيح اختيارية في مخطط التخطيط وحده. قرار المالك ٤ نوفمبر ٢٠٢٦ «كل شيء يُحذف»: رمز QR يُطبع ما لم تحذفه
  // الشركة صراحةً (sections.qr.visible = false)، ومثله الأصناف وأختام الحالة (stamps = false) — لا مفتاح «إخفاء» عامّ، والغياب = اليوم
  const layoutSchemaKeys = Object.keys((printSettingsV1Schema.shape.profiles.element.shape.options.shape.layout as unknown as { unwrap(): { shape: Record<string, unknown> } }).unwrap().shape);
  // و«نموذج الشركة المطبوع مسبقاً» (١٠–١١ نوفمبر ٢٠٢٦): مفتاحٌ حرّ سادس form بعد stamps — مواضع وحدها، ومعرّفات حقوله (docTitle وsellerVat…)
  // قيمٌ في مصفوفاتٍ لا مفاتيح، فلا خيار فيه يخفي محتوىً إلزامياً (والضريبة على المعفى يقرّرها قرار الطباعة لا النموذج)
  assert.deepEqual(layoutSchemaKeys, [...layoutKeys, 'logoMm', 'logoAfter', 'sections', 'canvas', 'stamps', 'form']);
  assert.ok(!('stamps' in defaultPrintLayout('page')) && !('stamps' in defaultPrintLayout('thermal')), 'الافتراضي بلا حذف');
  for (const k of [...schemaKeys, ...layoutSchemaKeys]) assert.ok(!FORBIDDEN.includes(k), `خيار محظور: ${k}`);
  for (const k of [...schemaKeys, ...layoutSchemaKeys]) assert.doesNotMatch(k, /qr(Hidden|Min|Off)|hide|title|tax|vat|notice|watermark|icv|uuid|seller|buyer/i, `خيار يمسّ محتوى إلزامياً: ${k}`);
  // والترتيب لا يُسقط قسماً: تبديلٌ كامل لأقسام التصميم، وقسم QR في الرول دائماً (الحذف بـvisible لا بالترتيب)
  assert.ok(sectionsFor('thermal', 'standard').includes('qr'));
  // حجم الرمز «تلقائي» أو «كبير» وحدهما — لا «صغير»
  assert.deepEqual(printSettingsV1Schema.shape.profiles.element.shape.options.shape.qrSize.options, ['auto', 'large']);
});

test('رسالة رفض الحفظ: بلا صفّ إعدادات، والكبير، وقاعدة النواة كما هي، وغيرها عامّة', () => {
  const err = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });
  assert.equal(printSaveErrorMessage(err(409, { code: 'COMPANY_SETTINGS_MISSING', message: 'x' })), COMPANY_SETTINGS_MISSING_MSG);
  assert.equal(printSaveErrorMessage(err(413, { code: 'PRINT_SETTINGS_TOO_LARGE' })), PRINT_ISSUES.tooLarge);
  assert.equal(printSaveErrorMessage(err(400, { code: 'PRINT_SETTINGS_INVALID', message: PRINT_ISSUES.routeThermal })), PRINT_ISSUES.routeThermal);
  assert.equal(printSaveErrorMessage(err(500, { message: 'connect ECONNREFUSED 10.0.0.1' })), 'حدث خطأ في الحفظ', 'لا رسالة خادم خام');
  assert.equal(printSaveErrorMessage(new Error('Network')), 'حدث خطأ في الحفظ');
});

test('كل تسمية ورسالة وتنبيه مترجم إلى اللغات الأربع — والفرنسية بلا فواصل علوية', () => {
  const all = [
    ...Object.values(PRINT_ISSUES), ...Object.values(PRINT_WARNINGS), ...Object.values(PRINT_NOTES), ...Object.values(LEGACY_NAMES),
    ...Object.values(PRINTER_LABELS), ...Object.values(PRINTER_HINTS), ...Object.values(TEMPLATE_LABELS), ...Object.values(TEMPLATE_HINTS),
    ...Object.values(PRESET_LABELS), ...Object.values(FEED_LABELS), ...Object.values(DOC_KIND_LABELS), PRINT_SAMPLE_WATERMARK, COMPANY_SETTINGS_MISSING_MSG,
    ...Object.values(PRINTER_SHORT), ...Object.values(DOC_KIND_SHORT),
    ...Object.values(DESIGN_LABELS), ...(Object.values(DESIGN_HINTS) as string[]), ...Object.values(SECTION_LABELS), ...Object.values(LOGO_POSITION_LABELS),
    ...Object.values(LOGO_SIZE_LABELS), ...Object.values(TABLE_STYLE_LABELS),
    ...Object.values(ALIGN_LABELS), ...Object.values(CANVAS_BOX_LABELS), ...Object.values(CANVAS_BAND_LABELS),
    QR_REMOVE_WARNING, ITEMS_REMOVE_WARNING, STAMPS_REMOVE_WARNING, QR_REMOVED_BADGE, QR_REMOVE_ACTION, QR_RESTORE_ACTION, STAMPS_LABEL, STAMPS_HINT,
    STAMPS_REMOVE_ACTION, STAMPS_RESTORE_ACTION, QR_FLOW_NOTE, QR_PANEL_NOTE, QR_ORPHAN_NOTE,
    PRINT_FORM_IMAGE_MISSING_MSG, ...Object.values(FORM_FIELD_LABELS), ...Object.values(FORM_COLUMN_LABELS), ...FORM_FIELD_GROUPS.map((g) => g.title),
    ...Object.values(FORM_VALUE_LANG_LABELS), ...Object.values(FORM_WARNINGS), ...Object.values(FORM_NOTES),
  ].filter((s) => /[؀-ۿ]/.test(s));
  const missing: string[] = [];
  for (const ar of all) {
    const t = PHRASES[ar];
    if (!t) { missing.push(ar); continue; }
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${ar}» بلا ترجمة ${lang}`);
    }
    assert.ok(!t.fr.includes("'"), `«${ar}» فرنسية بفاصلة علوية`);
  }
  assert.deepEqual(missing, [], 'بلا مدخل في القاموس');
  // كل مقاس جاهز له تسمية
  for (const p of PAPER_PRESETS) assert.ok(PRESET_LABELS[p.id]);
});

test('التوصيل: تبويب «إعدادات الطباعة» كسول في إعدادات الشركة بـ?tab=print، والعميل، ونوع الشركة', () => {
  const page = read('src', 'pages', 'CompanySettingsPage.tsx');
  assert.ok(page.includes("const loadPrintPanel = () => import('../components/print/PrintSettingsPanel');"));
  // «أنواع الأسعار» و«فرق العمل» نُقلتا إلى المنتجات والمناديب (طلب المالك ٢ نوفمبر ٢٠٢٦) — والطباعة كما كانت
  assert.ok(page.includes("useState<'general' | 'print' | 'zatca' | 'api'>"));
  assert.ok(page.includes("t === 'api' || t === 'print' ? t : 'general'"));
  assert.ok(page.includes("tr('إعدادات الطباعة')"));
  assert.ok(page.includes('<PrintSettingsPanel phase2={zatcaCollectOn(data)} />'));
  // ليس مشروطاً بالمحاسبة ولا بالمدير غير المقيّد: كل من بلغ الصفحة (صلاحية إعدادات الشركة)
  assert.match(page, /const printTabOn = true;/);
  // الإعدادات العامة مخفيّة لا مُزالة خلف التبويب
  assert.ok(page.includes('<div hidden={showApi || showPrint}>'));
  const client = read('src', 'api', 'client.ts');
  assert.ok(client.includes("get: () => api.get('/company/print-settings'),"));
  assert.ok(client.includes("put: (data: PrintSettingsV1 | null) => api.put('/company/print-settings', data ?? { reset: true }),"), 'null = استعادة الافتراضي (العمود null)');
  const panel = read('src', 'components', 'print', 'PrintSettingsPanel.tsx');
  assert.ok(panel.includes("queryKey: ['company', 'print']"));
  assert.ok(panel.includes("qc.invalidateQueries({ queryKey: ['company'] })"), 'الحفظ يحدّث ردّ /company الذي يقرؤه المندوب');
  assert.ok(panel.includes('normalizePrintSettings('), 'لا قراءة للقيمة الخام');
  // «استعادة الافتراضي» تُحفظ إعادةً (العمود null) لا نسخةً من الافتراضي كائناً — ما دامت المسودة الافتراضيَّ حرفياً
  const resetFn = panel.slice(panel.indexOf('const resetDefault = () => {'), panel.indexOf('const full = s.profiles.length'));
  assert.ok(resetFn.includes('setDraft(legacyPrintSettings());') && resetFn.includes('setPendingClear(true);'));
  assert.ok(resetFn.includes('save.mutate(pendingClear && isLegacyPrintSettings(draft) ? null : draft);'));
  assert.ok(panel.includes('onClick={saveDraft}>'), 'زرّ الحفظ يمرّ بالإعادة');
  assert.ok(panel.includes('mutationFn: (v: PrintSettingsV1 | null) => companyApi.printSettings.put(v),'));
  assert.ok(panel.includes('setPendingClear(false);'), 'الحفظ الناجح يمحو العلامة');
  // المعاينة لا ترسم رمزاً حقيقياً: لا مكتبة QR ولا بناء رمز المرحلة الأولى في التبويب ولا معاينته (§4.14)
  const preview = read('src', 'components', 'print', 'PrintPreview.tsx');
  for (const f of [panel, preview]) assert.doesNotMatch(f, /from 'qrcode'|buildZatcaQr|QRCode\.|QrImage/);
  assert.ok(preview.includes('{tr(PRINT_SAMPLE_WATERMARK)}'), 'المعاينة موسومة «نموذج اختبار — ليس مستندا ضريبيا»');
  assert.ok(panel.includes('<PrintPreview profile={p}'));
  const rep = read('src', 'rep', 'RepDocuments.tsx');
  assert.match(rep, /printSettings\?: unknown;/);
});

// ─── التخطيط (طلب المالك ٣ نوفمبر ٢٠٢٦) ───

const roleProfile = (printer: PrintProfile['printer']): PrintProfile =>
  printer === 'thermal' ? profile('van', 'thermal', 'roll_compact', 'roll80')
    : printer === 'impact' ? profile('mip', 'impact', 'impact_plain', 'ff_a4') : profile('office', 'page', 'page_plain', 'a4');
const withOne = (p: PrintProfile): PrintSettingsV1 => ({ ...legacyPrintSettings(), profiles: [...legacyPrintSettings().profiles, p] });

test('التخطيط: غيابه = اليوم حرفياً، والقراءة المتسامحة تُصلح الترتيب أو تُسقط التخطيط وحده ولا تُسقط القالب', () => {
  // قالبٌ بلا تخطيط يعود بلا مفتاح layout (لا layout: undefined)
  const plain = normalizePrintSettings(fleet());
  for (const p of plain.profiles) assert.ok(!('layout' in p.options));
  assert.equal(JSON.stringify(plain), JSON.stringify(fleet()));
  // تخطيطٌ صالح يُقرأ كما هو (اللون بأحرف كبيرة) وفي آخر الخيارات
  const s = fleet();
  s.profiles[2] = withDesign(s.profiles[2], 'grid_bilingual');
  s.profiles[2].options.layout!.accent = '#0f766e';
  const r = normalizePrintSettings(s);
  assert.equal(Object.keys(r.profiles[2].options).slice(-1)[0], 'layout');
  assert.equal(r.profiles[2].options.layout!.accent, '#0F766E');
  assert.deepEqual(r.profiles[2].options.layout!.order, [...sectionsFor('page', 'grid_bilingual')]);
  // ترتيبٌ ناقص ⇒ يُصلح في القراءة (و400 في الحفظ)
  const partial = JSON.parse(JSON.stringify(s));
  partial.profiles[2].options.layout.order = ['footer', 'items', 'header'];
  assert.deepEqual(normalizePrintSettings(partial).profiles[2].options.layout!.order, [...sectionsFor('page', 'grid_bilingual')]);
  const ps = checkPrintSettings(partial, true);
  assert.ok(!ps.ok && ps.issues.some((i) => i.message === PRINT_ISSUES.layoutOrder));
  // تصميمٌ مجهول (نسخة أحدث) ⇒ يسقط التخطيط وحده ويبقى القالب والإعداد
  const future = JSON.parse(JSON.stringify(s));
  future.profiles[2].options.layout.design = 'magazine';
  const fr = normalizePrintSettings(future);
  assert.equal(fr.profiles.length, 3, 'القالب باقٍ');
  assert.ok(!('layout' in fr.profiles[2].options), 'التخطيط وحده سقط');
  assert.deepEqual([fr.profiles[2].template, fr.routing.invoice], ['page_plain', 'mip480']);
  // تخطيطٌ يخالف قاعدةً لا يُصلحها الترتيب (لون فاتح) ⇒ يسقط وحده في القراءة، و400 في الحفظ
  const pale = JSON.parse(JSON.stringify(s));
  pale.profiles[2].options.layout.accent = '#FFFF00';
  assert.ok(!('layout' in normalizePrintSettings(pale).profiles[2].options));
  const strict = checkPrintSettings(pale, true);
  assert.ok(!strict.ok && strict.issues.some((i) => i.message === PRINT_ISSUES.layoutAccent));
});

test('ترتيب الأقسام: التطبيع متساوي القوى ويحفظ القواعد، وكل ناتجٍ يُحفظ صالحاً', () => {
  for (const printer of ['thermal', 'impact', 'page'] as const) {
    for (const design of designsFor(printer)) {
      const def = sectionsFor(printer, design);
      assert.deepEqual(normalizeSectionOrder(def, printer, design), [...def], `${printer}/${design}`);
      assert.deepEqual(normalizeSectionOrder([], printer, design), [...def]);
      const base = withLayout(roleProfile(printer), { design });
      let seed = 7;
      for (let n = 0; n < 150; n++) {
        const shuffled = [...def];
        for (let i = shuffled.length - 1; i > 0; i--) {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          const j = seed % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const once = normalizeSectionOrder(shuffled, printer, design);
        assert.deepEqual(normalizeSectionOrder(once, printer, design), once);
        assert.deepEqual([...once].sort(), [...def].sort());
        assert.equal(once[0], 'header');
        assert.equal(once[once.length - 1], 'footer');
        assert.ok(once.indexOf('totals') > once.indexOf('items'));
        if (printer === 'thermal') assert.ok(once.indexOf('qr') > once.indexOf('items'));
        const p: PrintProfile = { ...base, options: { ...base.options, layout: { ...layoutOf(base), order: once } } };
        const ok = checkPrintSettings(withOne(p), true);
        assert.equal(ok.ok, true, JSON.stringify(ok));
      }
    }
  }
  // مكرر ومجهول ⇒ يُطبَّع
  assert.deepEqual(normalizeSectionOrder(['items', 'items', 'bogus', 'header'], 'page', 'standard'), ['header', 'info', 'items', 'note', 'totals', 'installments', 'signatures', 'footer']);
  // الرول: QR بين التواقيع والتذييل (اليوم) أو مبكراً بعد الأصناف
  assert.deepEqual(normalizeSectionOrder(['header', 'qr', 'info', 'customer', 'items', 'totals', 'signatures', 'footer'], 'thermal', 'standard'),
    ['header', 'info', 'customer', 'items', 'qr', 'totals', 'signatures', 'footer']);
  for (const id of SECTION_IDS) assert.ok(SECTION_LABELS[id]);
});

test('المحرّر: withLayout وwithDesign ونقل الأقسام بقواعده', () => {
  const page = profile('office', 'page', 'page_branded', 'a4');
  assert.deepEqual(layoutOf(page), defaultPrintLayout('page'));
  assert.deepEqual(defaultPrintLayout('page'), { design: 'standard', logo: 'start', logoSize: 'm', accent: null, tableStyle: 'lines', order: [...sectionsFor('page', 'standard')] });
  assert.equal(defaultPrintLayout('thermal', 'grid_bilingual').design, 'standard', 'الرول تصميمٌ واحد');
  assert.equal(defaultPrintLayout('thermal').logo, 'center');
  const centered = withLayout(page, { logo: 'center', logoSize: 'l' });
  assert.deepEqual([centered.options.layout!.logo, centered.options.layout!.logoSize, centered.template], ['center', 'l', 'page_branded']);
  assert.ok(!('layout' in withLayout(centered, null).options), 'null يعيد مطبوعة اليوم');
  assert.equal(withLayout(page, null), page);
  // ثنائي اللغة: التصميم الأساسي وشعارٌ في الوسط وشبكة وقسم البائع والمشتري
  const grid = withDesign(withLayout({ ...page, id: 'office-grid', name: 'office-grid' }, { accent: '#1D4ED8' }), 'grid_bilingual');
  assert.equal(grid.template, 'page_plain');
  assert.deepEqual([grid.options.layout!.design, grid.options.layout!.logo, grid.options.layout!.tableStyle, grid.options.layout!.accent], ['grid_bilingual', 'center', 'grid', '#1D4ED8']);
  assert.ok(grid.options.layout!.order.includes('parties'));
  assert.equal(withDesign(profile('m', 'impact', 'impact_preprinted', 'ff_a4'), 'grid_bilingual').template, 'impact_plain');
  const back = withDesign(grid, 'standard');
  assert.deepEqual([back.options.layout!.design, back.options.layout!.accent], ['standard', '#1D4ED8']);
  assert.ok(!back.options.layout!.order.includes('parties'));
  const roll = profile('van', 'thermal', 'roll_compact', 'roll80');
  assert.equal(withDesign(roll, 'grid_bilingual'), roll, 'لا ثنائي على الرول');
  for (const legacy of legacyPrintSettings().profiles) assert.ok(!('layout' in withLayout(legacy, { logo: 'none' }).options), 'الافتراضيان مجمَّدان');
  // النقل: الإجماليات لا تسبق الأصناف، والترويسة لا تتحرّك، والتواقيع والتذييل آخراً
  assert.equal(canMoveSection(page, 'totals', 1), false);
  assert.equal(canMoveSection(page, 'header', 2), false);
  assert.equal(canMoveSection(page, 'footer', 3), false);
  assert.equal(canMoveSection(page, 'info', 0), false);
  assert.equal(canMoveSection(page, 'info', 1), false, 'لا حركة');
  assert.equal(canMoveSection(page, 'note', 4), true);
  const moved = moveSection(page, 'note', 4);
  assert.deepEqual(moved.options.layout!.order, ['header', 'info', 'items', 'totals', 'note', 'installments', 'signatures', 'footer']);
  assert.equal(moveSection(page, 'totals', 1), page, 'المكسور لا يُطبَّق');
  assert.equal(canMoveSection(roll, 'qr', 4), true, 'QR بعد الأصناف في الرول');
  assert.equal(canMoveSection(roll, 'qr', 2), false);
  const rollMoved = moveSection(roll, 'qr', 4);
  assert.deepEqual(rollMoved.options.layout!.order, ['header', 'info', 'customer', 'items', 'qr', 'totals', 'signatures', 'footer']);
  const s = { ...legacyPrintSettings(), profiles: [...legacyPrintSettings().profiles, moved, rollMoved, grid] };
  assert.equal(checkPrintSettings(s, true).ok, true, JSON.stringify(checkPrintSettings(s, true)));
});

test('ألوان التمييز الجاهزة كلها مقروءة على الأبيض (3:1)، والفاتح مرفوض', () => {
  for (const c of ACCENT_PALETTE) assert.ok(accentContrastOk(c), c);
  for (const c of ['#FFFFFF', '#FFFF00', '#F5F5F5', '#E0E0E0', 'red', '#FFF']) assert.equal(accentContrastOk(c), false, c);
  assert.equal(accentContrastOk('#000000'), true);
});

test('التحرير الحرّ: التسميات لكل قيمة، وwithDesign يحمل حجم الشعار وما يصلح من مكانه وتنسيقاته ويُسقط اللوحتين على ثنائي اللغة', () => {
  for (const a of ALIGNS) assert.ok(ALIGN_LABELS[a]);
  for (const b of CANVAS_BANDS) assert.ok(CANVAS_BAND_LABELS[b]);
  for (const id of CANVAS_BOX_IDS) assert.ok(CANVAS_BOX_LABELS[id]);
  const page = withLayout(profile('office', 'page', 'page_branded', 'a4'), {
    logoMm: 30, logoAfter: 'note', sections: { note: { align: 'center' }, totals: { fontPct: 120 } },
    canvas: { headerMm: 60, footerMm: 0, boxes: [{ id: 'logo', band: 'header', x: 0, y: 0, w: 30, h: 30 }] },
  });
  const grid = withDesign(page, 'grid_bilingual');
  const gl = grid.options.layout!;
  assert.equal(gl.design, 'grid_bilingual');
  assert.equal(gl.logoMm, 30);
  assert.equal(gl.logoAfter, 'note', 'note قسمٌ في ثنائي اللغة');
  assert.deepEqual(gl.sections, { note: { align: 'center' }, totals: { fontPct: 120 } });
  assert.ok(!('canvas' in gl), 'لا لوحات على ثنائي اللغة');
  const back = withDesign(withLayout(grid, { logoAfter: 'parties', sections: { parties: { fontPct: 90 }, totals: { fontPct: 120 } } }), 'standard').options.layout!;
  assert.ok(!('logoAfter' in back), 'parties ليس في التصميم القياسي');
  assert.deepEqual(back.sections, { totals: { fontPct: 120 } });
  assert.equal(back.logoMm, 30);
  // بلا مفاتيح حرّة: كما كان (لا مفتاح جديد)
  const plain = withDesign(withLayout(profile('o2', 'page', 'page_branded', 'a4'), { accent: '#1D4ED8' }), 'grid_bilingual');
  assert.deepEqual(Object.keys(plain.options.layout!), ['design', 'logo', 'logoSize', 'accent', 'tableStyle', 'order']);
  const s = { ...legacyPrintSettings(), profiles: [...legacyPrintSettings().profiles, { ...grid, id: 'g-1', name: 'g-1' }] };
  assert.equal(checkPrintSettings(s, true).ok, true, JSON.stringify(checkPrintSettings(s, true)));
});

test('التحرير الحرّ: الجهاز يقرأ ما يحفظه الخادم، ويُسقط المفتاح المعيب وحده (نسخة أحدث) ويطبع بالستة', () => {
  const roll = withLayout(profile('van', 'thermal', 'roll_compact', 'roll58'), { logo: 'end', tableStyle: 'grid', logoMm: 20, logoAfter: 'top', sections: { qr: { align: 'start' } } });
  const s = { ...fleet(), profiles: [...fleet().profiles, roll] };
  const strict = checkPrintSettings(s, true);
  assert.ok(strict.ok, JSON.stringify(strict));
  assert.deepEqual(normalizePrintSettings(s).profiles[3].options.layout, strict.ok ? strict.value.profiles[3].options.layout : null);
  const raw = JSON.parse(JSON.stringify(s));
  raw.profiles[3].options.layout.logoMm = 'xl';
  raw.profiles[3].options.layout.canvas = { headerMm: 10, footerMm: 0, boxes: [] };
  const l = normalizePrintSettings(raw).profiles[3].options.layout!;
  assert.ok(!('logoMm' in l) && !('canvas' in l), 'المعيب يسقط وحده');
  assert.deepEqual([l.logo, l.tableStyle, l.logoAfter], ['end', 'grid', 'top']);
});

test('الحذف الصريح (قرار المالك ٤ نوفمبر ٢٠٢٦): رمز QR والأصناف وأختام الحالة — الحفظ يقبلها في كل قالب والقراءة تُبقيها', () => {
  const hideAll = { sections: { qr: { visible: false }, items: { visible: false } }, stamps: false };
  const targets: PrintProfile[] = [
    withLayout(profile('van-h', 'thermal', 'roll_compact', 'roll80'), hideAll),
    withLayout(profile('office-h', 'page', 'page_branded', 'a4'), hideAll),
    withLayout(profile('mip-h', 'impact', 'impact_plain', 'ff_a4'), hideAll),
    withLayout(withDesign(profile('office-g', 'page', 'page_branded', 'a4'), 'grid_bilingual'), hideAll),
    withLayout(withDesign(profile('mip-g', 'impact', 'impact_plain', 'ff_a4'), 'grid_bilingual'), hideAll),
  ];
  for (const p of targets) {
    const s = { ...fleet(), profiles: [...fleet().profiles, p] };
    const strict = checkPrintSettings(s, true);
    assert.ok(strict.ok, `${p.id}: ${JSON.stringify(strict)}`);
    const l = normalizePrintSettings(s).profiles[3].options.layout;
    assert.ok(isQrRemoved(l) && isItemsRemoved(l) && areStampsRemoved(l), `${p.id}: القراءة تُبقي الحذف`);
    assert.deepEqual(l, strict.ok ? strict.value.profiles[3].options.layout : null);
  }
  // الصفحة: رمز QR قسمٌ افتراضي يقبل visible وحده
  const page = profile('office-x', 'page', 'page_branded', 'a4');
  for (const qr of [{ align: 'center' as const }, { fontPct: 120 }, { visible: false, align: 'center' as const }]) {
    const r = checkPrintSettings({ ...fleet(), profiles: [...fleet().profiles, withLayout(page, { sections: { qr } })] }, true);
    assert.ok(!r.ok && r.issues.some((i) => i.message === PRINT_ISSUES.layoutSectionUnknown), JSON.stringify(qr));
  }
  const bad = JSON.parse(JSON.stringify({ ...fleet(), profiles: [...fleet().profiles, withLayout(page, { logo: 'end' })] }));
  bad.profiles[3].options.layout.stamps = 'no';
  const rb = checkPrintSettings(bad, true);
  assert.ok(!rb.ok && rb.issues.some((i) => i.message === PRINT_ISSUES.shape && i.path.endsWith('stamps')));
  const lb = normalizePrintSettings(bad).profiles[3].options.layout!;
  assert.ok(!('stamps' in lb) && lb.logo === 'end', 'المتسامح يُسقط stamps المعيب وحده');
  // الكلاسيكي والافتراضيان لا يُعدَّلان (انسخ أولاً)
  const classic = { ...profile('van-c', 'thermal', 'roll_compact', 'roll58'), template: 'roll_classic' as const };
  const rc = checkPrintSettings({ ...fleet(), profiles: [...fleet().profiles, { ...classic, options: { ...classic.options, layout: { ...defaultPrintLayout('thermal'), ...hideAll } } }] }, true);
  assert.ok(!rc.ok && rc.issues.some((i) => i.message === PRINT_ISSUES.layoutClassic));
  for (const legacy of legacyPrintSettings().profiles) assert.ok(!('layout' in withLayout(legacy, hideAll).options));
  // الدوال: الغياب والافتراضي = لا حذف
  for (const l of [undefined, null, defaultPrintLayout('page'), defaultPrintLayout('thermal'), defaultPrintLayout('impact', 'grid_bilingual')]) {
    assert.deepEqual([isQrRemoved(l), isItemsRemoved(l), areStampsRemoved(l)], [false, false, false]);
  }
  assert.equal('LOCKED_VISIBLE' in printSettingsModule, false);
  assert.deepEqual([...COMPLIANCE_HIDE_SECTIONS], ['items', 'qr']);
  // تغيير التصميم لا يُعيد ما حذفته الشركة
  const back = withDesign(targets[3], 'standard').options.layout;
  assert.ok(isQrRemoved(back) && isItemsRemoved(back) && areStampsRemoved(back));
});

test('التنبيهات مع الحذف: رمزٌ محذوف بلا qrNoFit/phase2Narrow ومع qrRemoved — وبلا حذفٍ المخرج كما هو', () => {
  const narrow = profile('n', 'thermal', 'roll_compact', 'roll58');
  narrow.paper.printableDots = 256;
  const hidden = withLayout(narrow, { sections: { qr: { visible: false } } });
  const w = profileWarnings(hidden, { phase2: true }).warnings;
  assert.ok(w.includes(PRINT_WARNINGS.qrRemoved));
  assert.ok(!w.includes(PRINT_WARNINGS.qrNoFit) && !w.includes(PRINT_WARNINGS.phase2Narrow));
  const page = withLayout(profile('o', 'page', 'page_branded', 'a4'), { sections: { items: { visible: false } }, stamps: false });
  assert.deepEqual(profileWarnings(page, { phase2: true }).warnings, [PRINT_WARNINGS.itemsRemoved, PRINT_WARNINGS.stampsRemoved]);
  assert.equal(PRINT_WARNINGS.qrRemoved, QR_REMOVE_WARNING);
  // بلا حذف: كل قالبٍ افتراضي وكل مقاسٍ جاهز بالتنبيهات نفسها، ولا تنبيه حذف
  const removal: string[] = [PRINT_WARNINGS.qrRemoved, PRINT_WARNINGS.itemsRemoved, PRINT_WARNINGS.stampsRemoved];
  for (const lp of legacyPrintSettings().profiles) for (const phase2 of [true, false]) {
    assert.ok(!profileWarnings(lp, { phase2 }).warnings.some((x) => removal.includes(x)));
  }
  assert.ok(profileWarnings(narrow, { phase2: true }).warnings.includes(PRINT_WARNINGS.qrNoFit), 'بلا حذف: كما اليوم');
  assert.deepEqual(profileWarnings(withLayout(narrow, { logo: 'end' }), { phase2: true }), profileWarnings(narrow, { phase2: true }));
});

// ─── «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — المحرّرات والتوجيه في الواجهة ───

const profileIssuesOf = (p: PrintProfile): string[] => profileIssues(p, 'p').map((i) => i.message);

test('النموذج المطبوع مسبقاً: للطابعة العادية وحدها، وwithDesign يضع page_plain وورقاً بلا هامشين ومواضع البداية، والخروج يعيد الهامشين', () => {
  assert.deepEqual([...designsFor('page')], ['standard', 'grid_bilingual', 'preprinted']);
  assert.deepEqual([...designsFor('impact')], ['standard', 'grid_bilingual']);
  assert.deepEqual([...designsFor('thermal')], ['standard']);
  for (const p of [roleProfile('impact'), roleProfile('thermal'), ...legacyPrintSettings().profiles]) assert.equal(withDesign(p, 'preprinted'), p);
  const office = profile('office', 'page', 'page_branded', 'a4');
  const pre = withDesign(office, 'preprinted');
  assert.equal(pre.template, 'page_plain', 'جهازٌ قديم يُسقط التخطيط فيطبع أحادياً بلا شعار');
  assert.deepEqual([pre.paper.preset, pre.paper.widthMm, pre.paper.lengthMm, pre.paper.marginTopMm, pre.paper.marginBottomMm], ['a4', 210, 297, 0, 0]);
  assert.equal(pre.options.layout!.design, 'preprinted');
  assert.deepEqual(pre.options.layout!.form, starterForm(pre.paper));
  assert.ok(pre.options.layout!.form!.fields.some((f) => f.id === 'qr'));
  assert.ok(isFormProfile(pre) && !isFormProfile(office));
  assert.deepEqual(profileIssuesOf(pre), []);
  // اختياره ثانيةً لا يمسّ المواضع
  assert.equal(withDesign(pre, 'preprinted'), pre);
  // الخروج: هامشا المقاس الجاهز يعودان، ولا مواضع في غيره
  for (const d of ['standard', 'grid_bilingual'] as const) {
    const out = withDesign(pre, d);
    assert.equal(out.options.layout!.design, d);
    assert.ok(!('form' in out.options.layout!), d);
    assert.deepEqual([out.paper.marginTopMm, out.paper.marginBottomMm], [10, 10], d);
    assert.deepEqual(profileIssuesOf(out), [], d);
  }
  // withLayout: تصميمٌ آخر يُسقط المواضع، وتصميم النموذج بلا مواضع يأخذ مواضع البداية
  assert.ok(!('form' in withLayout(pre, { design: 'standard' }).options.layout!));
  assert.deepEqual(withLayout(office, { design: 'preprinted' }).options.layout!.form, starterForm(office.paper));
  // حذف رمز QR الصريح وأختام الحالة ينتقلان إلى النموذج وحدهما (لا شعار ولا أقسام ولا لوحتان) — والبداية بلا حقل QR
  const removed = withLayout(office, { sections: { qr: { visible: false }, info: { fontPct: 120 } }, stamps: false, logoMm: 30 });
  const preR = withDesign(removed, 'preprinted');
  const l = preR.options.layout!;
  assert.deepEqual(l.sections, { qr: { visible: false } });
  assert.equal(l.stamps, false);
  assert.ok(!('logoMm' in l) && !('canvas' in l));
  assert.ok(!l.form!.fields.some((f) => f.id === 'qr'));
  assert.deepEqual(profileIssuesOf(preR), []);
  // والعودة منه تُبقي الحذفين
  const back = withDesign(preR, 'standard').options.layout;
  assert.ok(isQrRemoved(back) && areStampsRemoved(back));
  // وبلا حذفٍ ولا حقل QR: قاعدة النواة
  const form = pre.options.layout!.form!;
  const noQr = withLayout(pre, { form: { ...form, fields: form.fields.filter((f) => f.id !== 'qr') } });
  assert.deepEqual(formIssues(noQr), [PRINT_ISSUES.layoutFormQrMissing]);
});

test('النموذج المطبوع مسبقاً: تغيير المقاس الجاهز يقيس المواضع بلا هامشين، وغير النموذج كما كان', () => {
  const pre = withDesign(profile('office', 'page', 'page_branded', 'a4'), 'preprinted');
  const a5 = withPreset(pre, 'a5');
  assert.deepEqual([a5.paper.widthMm, a5.paper.lengthMm, a5.paper.marginTopMm, a5.paper.marginBottomMm], [148, 210, 0, 0]);
  assert.deepEqual(profileIssuesOf(a5), []);
  const f = a5.options.layout!.form!;
  for (const x of f.fields) assert.ok(x.x + x.w <= 148 && x.y + x.h <= 210, x.id);
  assert.ok(f.table && f.table.y + f.table.rows * f.table.rowMm <= 210 + 1e-9);
  assert.deepEqual(profileIssuesOf(withPreset(a5, 'a4')), []);
  assert.deepEqual(profileIssuesOf(withPreset(pre, 'letter')), []);
  const std = profile('office', 'page', 'page_branded', 'a4');
  assert.deepEqual(withPreset(std, 'a5').paper, presetPaper('a5'));
});

test('النموذج المطبوع مسبقاً: للفواتير وحدها في التوجيه واختيار الجهاز، ولا يكون PDF، و4 على الأكثر — formDesignBlock برسائل النواة', () => {
  const pre = { ...withDesign(profile('murouj', 'page', 'page_branded', 'a4'), 'preprinted'), name: 'مروج' };
  const s: PrintSettingsV1 = { ...fleet(), profiles: [...fleet().profiles, pre], routing: { ...fleet().routing, invoice: 'murouj' } };
  assert.equal(checkPrintSettings(s, true).ok, true, JSON.stringify(checkPrintSettings(s, true)));
  for (const kind of ['invoice', 'receipt', 'statement', 'notices'] as const) {
    assert.equal(routingAllowsProfile(kind, pre), kind === 'invoice', kind);
    assert.equal(deviceProfilesFor(s, kind).some((p) => p.id === 'murouj'), kind === 'invoice', kind);
  }
  // اختيار الجهاز: النموذج للفاتورة يُقبل، ولسند القبض يعود لتوجيه الشركة
  const choose: PrintSettingsV1 = { ...s, repMayChoose: true };
  assert.equal(profileFor(choose, 'invoice', { byKind: { invoice: 'murouj' } })?.id, 'murouj');
  assert.equal(profileFor(choose, 'receipt', { byKind: { receipt: 'murouj' } })?.id, s.routing.receipt);
  // الحفظ يرفض توجيهه لغير الفواتير وجعله قالب PDF
  const bad = (x: PrintSettingsV1): string[] => { const r = checkPrintSettings(x, true); return r.ok ? [] : r.issues.map((i) => i.message); };
  assert.ok(bad({ ...s, routing: { ...s.routing, receipt: 'murouj' } }).includes(PRINT_ISSUES.routeForm));
  assert.ok(bad({ ...s, routing: { ...s.routing, statement: 'murouj' } }).includes(PRINT_ISSUES.routeForm));
  assert.ok(bad({ ...s, pdfProfileId: 'murouj' }).includes(PRINT_ISSUES.pdfForm));
  // formDesignBlock: ما يمنع اختيار التصميم قبل الحفظ — والقالب الذي هو نموذجٌ أصلاً لا يُمنع
  assert.equal(formDesignBlock(s, 'murouj'), null);
  assert.equal(formDesignBlock(s, 'office'), PRINT_ISSUES.pdfForm);
  assert.equal(formDesignBlock(s, 'van-80'), PRINT_ISSUES.layoutFormPrinter);
  assert.equal(formDesignBlock(s, 'mip480'), PRINT_ISSUES.layoutFormPrinter);
  assert.equal(formDesignBlock(s, 'nope'), null);
  const page2 = profile('page-2', 'page', 'page_plain', 'a4');
  const s2: PrintSettingsV1 = { ...s, profiles: [...s.profiles, page2], routing: { ...s.routing, receipt: 'page-2' } };
  assert.equal(formDesignBlock(s2, 'page-2'), PRINT_ISSUES.routeForm);
  assert.equal(formDesignBlock({ ...s2, routing: { ...s2.routing, receipt: s.routing.receipt } }, 'page-2'), null);
  // أربعة قوالب نموذج على الأكثر: الخامس يُمنع ويرفضه الحفظ
  assert.equal(PRINT_LIMITS.maxForms, 4);
  const forms = [1, 2, 3, 4].map((i) => ({ ...withDesign(profile(`form-${i}`, 'page', 'page_plain', 'a4'), 'preprinted'), name: `نموذج ${i}` }));
  const four: PrintSettingsV1 = { ...s, profiles: [...fleet().profiles, ...forms, page2], routing: { ...fleet().routing, invoice: 'form-1' } };
  assert.equal(checkPrintSettings(four, true).ok, true, JSON.stringify(checkPrintSettings(four, true)));
  assert.equal(formDesignBlock(four, 'page-2'), PRINT_ISSUES.formsCount);
  const five: PrintSettingsV1 = { ...four, profiles: four.profiles.map((p) => (p.id === 'page-2' ? withDesign(p, 'preprinted') : p)) };
  assert.ok(bad(five).includes(PRINT_ISSUES.formsCount));
  // ورسالة رفض مرجع الصورة من الخادم
  assert.equal(printSaveErrorMessage({ response: { status: 400, data: { code: 'PRINT_FORM_IMAGE_MISSING', message: 'x' } } }), PRINT_FORM_IMAGE_MISSING_MSG);
});
