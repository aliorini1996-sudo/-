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
  type PrintProfile, type PrintSettingsV1,
} from './printSettings';
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
  assert.deepEqual([...typeKeys].sort(), [...schemaKeys].sort(), 'المخطط والافتراضي بالمفاتيح نفسها');
  for (const k of typeKeys) assert.ok(!FORBIDDEN.includes(k), `خيار محظور: ${k}`);
  for (const k of typeKeys) assert.doesNotMatch(k, /qr(Hidden|Min|Off)|hide|title|tax|vat|notice|watermark|icv|uuid|seller|buyer/i, `خيار يمسّ محتوى إلزامياً: ${k}`);
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
  assert.ok(page.includes("useState<'general' | 'print' | 'zatca' | 'api' | 'teams'>"));
  assert.ok(page.includes("t === 'api' || t === 'teams' || t === 'print' ? t : 'general'"));
  assert.ok(page.includes("tr('إعدادات الطباعة')"));
  assert.ok(page.includes('<PrintSettingsPanel phase2={zatcaCollectOn(data)} />'));
  // ليس مشروطاً بالمحاسبة ولا بالمدير غير المقيّد: كل من بلغ الصفحة (صلاحية إعدادات الشركة)
  assert.match(page, /const printTabOn = true;/);
  // الإعدادات العامة مخفيّة لا مُزالة خلف التبويب
  assert.ok(page.includes('<div hidden={showApi || showTeams || showPrint}>'));
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
