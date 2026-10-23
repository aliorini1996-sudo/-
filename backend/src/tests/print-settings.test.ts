// «إعدادات الطباعة» v1 (services/printSettingsCore.ts + services/printSettings.ts + routes/printSettings.ts) — طلب المالك
// ٢٣ أكتوبر ٢٠٢٦. البنية الصارمة والقواعد المتقاطعة والحدود والافتراضي (null = سلوك اليوم)، ثم المعالجات الحقيقية فوق Prisma
// مزيّف في الذاكرة (القراءة لكل مسجّل، الحفظ بصلاحية إعدادات الشركة، 409 بلا صفّ)، ثم حرّاس نصّية على التركيب وعلى بقاء
// PUT /api/company كما هو.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import {
  LEGACY_PAGE_ID, LEGACY_THERMAL_ID, PAPER_PRESETS, PRINT_ISSUES, PRINT_LIMITS, canonicalPrintSettings, checkPrintSettings,
  defaultPrintOptions, dotsPerMm, impactRightDots, isLegacyPrintSettings, isPrintSettingsReset, legacyPrintSettings, maxPrintableDots,
  parsePrintSettings, presetPaper, printSettingsBytes, storedPrintSettings, type PrintProfile, type PrintSettingsV1,
} from '../services/printSettings';

const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const profile = (over: Partial<PrintProfile> & Pick<PrintProfile, 'id' | 'printer' | 'template'>, preset: Parameters<typeof presetPaper>[0]): PrintProfile => ({
  name: over.id, paper: presetPaper(preset)!, options: defaultPrintOptions(over.printer), ...over,
});
/** شركة بشاحنات MIP480 وأخرى برول 80 مم وطابعة مكتب — المثال الذي بُني له التصميم */
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
const issuesOf = (s: unknown) => { const r = checkPrintSettings(s, true); return r.ok ? [] : r.issues.map((i) => i.message); };

// ═══ النواة ═══

test('الافتراضي (null): ملفّا اليوم — شريط 58 مم الكلاسيكي للفواتير والسندات، وA4 للـPDF، ولا طباعة مباشرة لغيرهما', () => {
  const s = legacyPrintSettings();
  assert.deepEqual(s.routing, { invoice: LEGACY_THERMAL_ID, receipt: LEGACY_THERMAL_ID, statement: null, notices: null });
  assert.equal(s.pdfProfileId, LEGACY_PAGE_ID);
  assert.equal(s.repMayChoose, true);
  assert.deepEqual(s.profiles.map((p) => [p.id, p.printer, p.template]), [['legacy-58', 'thermal', 'roll_classic'], ['legacy-a4', 'page', 'page_branded']]);
  assert.deepEqual(s.profiles[0].paper, { preset: 'roll58', widthMm: 58, lengthMm: null, feed: 'roll', dpi: 203, printableDots: 384, offsetXmm: 0, marginTopMm: 0, marginBottomMm: 0 });
  assert.equal(s.profiles[1].paper.preset, 'a4');
  assert.deepEqual(issuesOf(s), [], 'الافتراضي نفسه صالح');
  assert.deepEqual(storedPrintSettings(null), { settings: s, stored: false });
  assert.deepEqual(storedPrintSettings(undefined), { settings: s, stored: false });
  // نسخة جديدة في كل نداء (لا يعدّل أحدٌ الافتراضيَّ المشترك)
  assert.notEqual(legacyPrintSettings().profiles[0].paper, legacyPrintSettings().profiles[0].paper);
});

test('النقاط: 72 مم على 203 = 576، و8.0 بوصة على 180 = 1440، والحدّ الأعرض للحرارية من مضاعفات 8', () => {
  assert.equal(72 * dotsPerMm(203), 576);
  assert.equal(Math.round(203.2 * dotsPerMm(180)), 1440);
  assert.equal(maxPrintableDots('thermal', 58, 203), 464);
  assert.equal(maxPrintableDots('thermal', 82.5, 203), 656);
  // النقطية: سطر الطباعة 8.0 بوصة (1440) سقفٌ مهما عرض الورق — 210 مم كانت تسمح بـ1488 و241 بـ1708 فيضيع ما وراء 1440
  assert.equal(maxPrintableDots('impact', 210, 180), 1440);
  assert.equal(maxPrintableDots('impact', 241, 180), 1440);
  assert.equal(maxPrintableDots('impact', 150, 180), 1062, 'الورق الأضيق من السطر يبقى حدّه');
  assert.equal(PRINT_LIMITS.impactLineDots, 1440);
  assert.equal(maxPrintableDots('thermal', 80, 300) % 8, 0);
});

test('النقطية داخل سطر الطباعة 1440: الحزمة وحدها ثم مع إزاحتها يميناً — والإزاحة السالبة لا تُحسب (لا يسار قبل أوّل إبرة)', () => {
  const mut = (fn: (p: PrintProfile) => void) => { const s = fleet(); fn(s.profiles[0]); return issuesOf(s); };
  assert.deepEqual(mut(() => {}), [], 'A4 متصل 1440 بلا إزاحة');
  assert.deepEqual(mut((p) => { p.paper.printableDots = 1488; }), [PRINT_ISSUES.impactLine], '210 مم كاملة');
  assert.deepEqual(mut((p) => { p.paper = presetPaper('ff_95x11')!; p.paper.printableDots = 1708; }), [PRINT_ISSUES.impactLine], '241 مم كاملة');
  assert.deepEqual(mut((p) => { p.paper.offsetXmm = 1; }), [PRINT_ISSUES.impactLine], '1440 + 7 نقاط');
  assert.deepEqual(mut((p) => { p.paper.offsetXmm = -15; }), []);
  assert.deepEqual(mut((p) => { p.paper.printableDots = 1405; p.paper.offsetXmm = 5; }), [], '1405 + 35 = 1440 بالضبط');
  assert.deepEqual(mut((p) => { p.paper.printableDots = 1406; p.paper.offsetXmm = 5; }), [PRINT_ISSUES.impactLine]);
  assert.equal(impactRightDots(1405, 5, 180), 1440);
  assert.equal(impactRightDots(1440, -3, 180), 1440);
  // المسار: العرض وحده على حقل النقاط، والإزاحة على حقلها
  const s = fleet();
  s.profiles[0].paper.offsetXmm = 2;
  const r = checkPrintSettings(s, true);
  assert.ok(!r.ok && r.issues.some((i) => i.path === 'profiles[0].paper.offsetXmm' && i.message === PRINT_ISSUES.impactLine));
  // كل مقاسٍ نقطيّ جاهز داخل السطر
  for (const p of PAPER_PRESETS.filter((x) => x.printer === 'impact')) assert.ok((p.paper.printableDots as number) <= 1440, p.id);
});

test('الطابعة العادية لا أضيق من 148 مم (A5): قالب الصفحة يُصغَّر بعرض الورق ومعه الرمز المختوم', () => {
  const mut = (fn: (p: PrintProfile) => void) => { const s = fleet(); fn(s.profiles[2]); return issuesOf(s); };
  assert.equal(PRINT_LIMITS.pageMinWidthMm, 148);
  for (const w of [58, 80, 147.9]) {
    assert.deepEqual(mut((p) => { p.paper = { ...p.paper, preset: 'custom', widthMm: w, lengthMm: 200 }; }), [PRINT_ISSUES.pageWidth], `${w}`);
  }
  assert.deepEqual(mut((p) => { p.paper = { ...p.paper, preset: 'custom', widthMm: 148, lengthMm: 200 }; }), []);
  assert.deepEqual(mut((p) => { p.paper = presetPaper('a5')!; }), []);
  // والحرارية بالعرض نفسه مقبولة (خانة رمزٍ بنقاط صحيحة)
  assert.deepEqual(mut((p) => { p.printer = 'thermal'; p.template = 'roll_compact'; p.paper = presetPaper('roll58')!; p.options = defaultPrintOptions('thermal'); }).filter((m) => m === PRINT_ISSUES.pageWidth), []);
});

test('كل مقاس جاهز صالح لنوع طابعته بتصميمه الافتراضي — ولا يقبله نوع آخر', () => {
  const tpl = { thermal: 'roll_compact', impact: 'impact_plain', page: 'page_branded' } as const;
  const s: PrintSettingsV1 = {
    ...legacyPrintSettings(),
    profiles: [...legacyPrintSettings().profiles, ...PAPER_PRESETS.slice(0, 10).map((p, i) => profile({ id: `p-${i}`, printer: p.printer, template: tpl[p.printer] }, p.id))],
  };
  assert.deepEqual(issuesOf(s), []);
  const rest: PrintSettingsV1 = { ...legacyPrintSettings(), profiles: PAPER_PRESETS.slice(10).map((p, i) => profile({ id: `q-${i}`, printer: p.printer, template: tpl[p.printer] }, p.id)).concat(legacyPrintSettings().profiles) };
  assert.deepEqual(issuesOf(rest), []);
  const wrong = fleet();
  wrong.profiles[1].paper = presetPaper('cut_a4')!; // ورق نقطي لطابعة حرارية
  assert.ok(issuesOf(wrong).includes(PRINT_ISSUES.presetPrinter));
});

test('الأسطول: نقطية وحرارية وعادية بتوجيه كامل — يُحفظ بصورته القانونية (ترتيب المفاتيح ثابت ويعيد نفسه)', () => {
  const r = parsePrintSettings(fleet());
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.value, fleet());
  assert.deepEqual(canonicalPrintSettings(r.value), r.value, 'ثابتة');
  // ترتيب مفاتيح مختلف ومسافات في الاسم ⇒ الصورة نفسها
  const messy = clone(fleet()) as unknown as Record<string, unknown>;
  const p0 = (messy.profiles as Record<string, unknown>[])[0];
  (messy.profiles as Record<string, unknown>[])[0] = { options: p0.options, paper: p0.paper, template: p0.template, printer: p0.printer, name: '  نقطية   MIP480 ', id: p0.id };
  const again = parsePrintSettings(messy);
  assert.ok(again.ok);
  if (again.ok) assert.equal(JSON.stringify(again.value), JSON.stringify(r.value));
});

test('البنية الصارمة: مفتاح مجهول في أي مستوى أو نسخة غير 1 أو نوع خاطئ ⇒ رفض', () => {
  const add = (fn: (s: Record<string, any>) => void) => { const s = clone(fleet()) as Record<string, any>; fn(s); return s; };
  for (const s of [
    add((s) => { s.extra = 1; }),
    add((s) => { s.profiles[0].logo = 'data:image/png;base64,AAAA'; }), // لا صور — الشعار من company.logo
    add((s) => { s.profiles[0].paper.cpl = 48; }), // لا حروف في السطر (المخرج صورة دائماً)
    add((s) => { s.profiles[0].options.showQr = false; }), // لا خيار يخفي رمز QR
    add((s) => { s.routing.return = 'mip480'; }),
  ]) assert.deepEqual(issuesOf(s), [PRINT_ISSUES.unknownKey], JSON.stringify(s).slice(0, 80));
  assert.deepEqual(issuesOf(add((s) => { s.version = 2; })), [PRINT_ISSUES.shape]);
  assert.deepEqual(issuesOf(add((s) => { s.profiles[0].options.copies = 4; })), [PRINT_ISSUES.shape]);
  assert.deepEqual(issuesOf(add((s) => { s.profiles[0].paper.dpi = 600; })), [PRINT_ISSUES.shape]);
  assert.deepEqual(issuesOf(add((s) => { s.profiles[0].paper.printableDots = 1440.5; })), [PRINT_ISSUES.shape]);
  assert.deepEqual(issuesOf(null), [PRINT_ISSUES.shape]);
  assert.deepEqual(issuesOf('{}'), [PRINT_ISSUES.shape]);
  // القراءة المتسامحة (الجهاز/العرض) تُهمل المفتاح المجهول — والنسخة غير 1 تبقى مرفوضة
  const extra = add((s) => { s.profiles[0].options.futureOption = true; });
  assert.deepEqual(storedPrintSettings(extra), { settings: fleet(), stored: true });
  assert.deepEqual(storedPrintSettings(add((s) => { s.version = 2; })), { settings: legacyPrintSettings(), stored: false });
});

test('القواعد المتقاطعة: التصميم لنوع طابعته، والكلاسيكي محجوز، والتوجيه والـPDF موجودان، ولا رول لكشف الحساب', () => {
  const mut = (fn: (s: PrintSettingsV1) => void) => { const s = fleet(); fn(s); return issuesOf(s); };
  assert.ok(mut((s) => { s.profiles[0].template = 'roll_compact'; }).includes(PRINT_ISSUES.templatePrinter));
  assert.ok(mut((s) => { s.profiles[1].template = 'roll_classic'; }).includes(PRINT_ISSUES.classicReserved));
  assert.ok(mut((s) => { s.routing.invoice = 'ghost'; }).includes(PRINT_ISSUES.routeMissing));
  assert.ok(mut((s) => { s.routing.statement = 'van-80'; }).includes(PRINT_ISSUES.routeThermal));
  assert.ok(mut((s) => { s.routing.notices = 'van-80'; }).includes(PRINT_ISSUES.routeThermal));
  assert.deepEqual(mut((s) => { s.routing.notices = 'mip480'; }), [], 'النقطية تطبع مستندات المخزون');
  assert.ok(mut((s) => { s.pdfProfileId = 'mip480'; }).includes(PRINT_ISSUES.pdfNotPage));
  assert.ok(mut((s) => { s.pdfProfileId = 'ghost'; }).includes(PRINT_ISSUES.pdfMissing));
  assert.ok(mut((s) => { s.profiles[2].id = 'mip480'; }).includes(PRINT_ISSUES.duplicateId));
  assert.ok(mut((s) => { s.profiles[2].name = ' رول   80 '; }).includes(PRINT_ISSUES.duplicateName));
  assert.ok(mut((s) => { s.profiles[2].id = 'Office!'; }).includes(PRINT_ISSUES.profileId));
  assert.ok(mut((s) => { s.profiles[2].name = '   '; }).includes(PRINT_ISSUES.nameRequired));
  assert.ok(mut((s) => { s.profiles[2].name = 'ق'.repeat(41); }).includes(PRINT_ISSUES.nameTooLong));
  assert.ok(mut((s) => { s.profiles = []; }).includes(PRINT_ISSUES.profilesCount));
  const many = fleet();
  for (let i = 0; many.profiles.length < 13; i++) many.profiles.push(profile({ id: `extra-${i}`, name: `x${i}`, printer: 'page', template: 'page_plain' }, 'a5'));
  assert.ok(issuesOf(many).includes(PRINT_ISSUES.profilesCount), '١٣ قالباً');
  many.profiles.pop();
  assert.deepEqual(issuesOf(many), [], '١٢ قالباً');
});

test('الورق: العرض والطول والتغذية والدقة والنقاط والهوامش والإزاحة والتفصيل الأعرض من 72 مم', () => {
  const mut = (i: number, fn: (p: PrintProfile) => void) => { const s = fleet(); fn(s.profiles[i]); return issuesOf(s); };
  assert.ok(mut(0, (p) => { p.paper.widthMm = 300; }).includes(PRINT_ISSUES.width));
  assert.ok(mut(0, (p) => { p.paper.feed = 'roll'; }).includes(PRINT_ISSUES.feed), 'النقطية بلا رول');
  assert.ok(mut(2, (p) => { p.paper.feed = 'continuous'; }).includes(PRINT_ISSUES.feed));
  assert.ok(mut(0, (p) => { p.paper.lengthMm = null; }).includes(PRINT_ISSUES.lengthRequired));
  assert.ok(mut(0, (p) => { p.paper.lengthMm = 20; }).includes(PRINT_ISSUES.length));
  assert.ok(mut(0, (p) => { p.paper.marginTopMm = 41; }).includes(PRINT_ISSUES.margins));
  assert.ok(mut(0, (p) => { p.paper.lengthMm = 60; p.paper.marginTopMm = 20; p.paper.marginBottomMm = 25; }).includes(PRINT_ISSUES.marginsTooBig));
  assert.ok(mut(0, (p) => { p.paper.offsetXmm = -15.5; }).includes(PRINT_ISSUES.offset));
  assert.deepEqual(mut(0, (p) => { p.paper.offsetXmm = -15; }), []);
  assert.ok(mut(0, (p) => { p.paper.dpi = 203; }).includes(PRINT_ISSUES.dpi), 'النقطية 180 وحدها');
  assert.ok(mut(1, (p) => { p.paper.dpi = 180; }).includes(PRINT_ISSUES.dpi));
  assert.ok(mut(1, (p) => { p.paper.printableDots = null; }).includes(PRINT_ISSUES.dotsRequired));
  assert.ok(mut(1, (p) => { p.paper.printableDots = 580; }).includes(PRINT_ISSUES.dotsMultiple));
  assert.ok(mut(1, (p) => { p.paper.printableDots = 648; }).includes(PRINT_ISSUES.dotsTooWide), '81 مم على رول 80');
  assert.ok(mut(1, (p) => { p.paper.printableDots = 248; p.template = 'roll_compact'; }).includes(PRINT_ISSUES.dotsTooSmall));
  assert.deepEqual(mut(0, (p) => { p.paper = presetPaper('ff_85x11')!; }), [], 'النقطية بعدد نقاط ليس من مضاعفات 8 (1350)');
  // المفصّل على 58 مم مرفوض، و72 مم بالضبط مقبول، و300 نقطة/بوصة تحتاج 848
  assert.ok(mut(1, (p) => { p.paper = presetPaper('roll58')!; }).includes(PRINT_ISSUES.detailedWidth));
  assert.deepEqual(mut(1, (p) => { p.paper = presetPaper('roll85')!; }), []);
  assert.ok(mut(1, (p) => { p.paper.dpi = 300; }).includes(PRINT_ISSUES.detailedWidth), '576 على 300 = 49 مم');
  assert.deepEqual(mut(1, (p) => { p.paper.dpi = 300; p.paper.printableDots = 848; }), [], '72 مم على 300 كما تعدّها الطابعة');
  assert.ok(mut(1, (p) => { p.paper.dpi = 300; p.paper.printableDots = 840; }).includes(PRINT_ISSUES.detailedWidth));
  // الصورة القانونية: الرول بلا طول، والعادية بلا دقة ولا نقاط، وعُشر المم
  const s = fleet();
  s.profiles[1].paper.lengthMm = 200;
  s.profiles[2].paper.dpi = 300;
  s.profiles[2].paper.printableDots = 2400;
  s.profiles[0].paper.offsetXmm = -3.14159;
  const r = parsePrintSettings(s);
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) {
    assert.equal(r.value.profiles[1].paper.lengthMm, null);
    assert.equal(r.value.profiles[2].paper.dpi, null);
    assert.equal(r.value.profiles[2].paper.printableDots, null);
    assert.equal(r.value.profiles[0].paper.offsetXmm, -3.1);
  }
});

test('التفاصيل: التذييل سطراً واحداً بحدّ 160 والفارغ null، والتغذية 0–30', () => {
  const s = fleet();
  s.profiles[0].options.footerText = '  شكراً\nلكم  ';
  s.profiles[1].options.footerText = '   ';
  const r = parsePrintSettings(s);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.profiles[0].options.footerText, 'شكراً لكم');
    assert.equal(r.value.profiles[1].options.footerText, null);
  }
  const long = fleet();
  long.profiles[0].options.footerText = 'ت'.repeat(161);
  assert.ok(issuesOf(long).includes(PRINT_ISSUES.footer));
  long.profiles[0].options.footerText = 'ت'.repeat(160);
  assert.deepEqual(issuesOf(long), []);
  const feed = fleet();
  feed.profiles[1].options.feedAfterMm = 31;
  assert.ok(issuesOf(feed).includes(PRINT_ISSUES.feedAfter));
});

test('الملفّان الافتراضيان يُنسخان ولا يُعدّلان: ما أُرسل فيهما يُستبدل بالمجمَّد', () => {
  const s = legacyPrintSettings();
  s.profiles[0].paper.widthMm = 80;
  s.profiles[0].paper.printableDots = 576;
  s.profiles[0].options.copies = 3;
  s.profiles[0].name = 'اسم آخر';
  s.profiles[1].options.showLogo = false;
  const r = parsePrintSettings(s);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value, legacyPrintSettings());
  // والمعرّف المحجوز لا يحمل غير تصميمه: نسخة legacy-58 بنوع آخر تُعاد حرارية كلاسيكية
  const other = legacyPrintSettings();
  other.profiles[0] = profile({ id: LEGACY_THERMAL_ID, printer: 'page', template: 'page_plain' }, 'a4');
  const r2 = parsePrintSettings(other);
  assert.ok(r2.ok);
  if (r2.ok) assert.equal(r2.value.profiles[0].template, 'roll_classic');
});

test('شبكة أمان «استعادة الافتراضي»: كائنٌ يساوي الافتراضي حرفياً يُقرأ غير محفوظ — وجسم الإعادة null أو { reset: true } وحده', () => {
  assert.equal(isLegacyPrintSettings(legacyPrintSettings()), true);
  assert.equal(isLegacyPrintSettings(fleet()), false);
  assert.equal(isLegacyPrintSettings({ ...legacyPrintSettings(), repMayChoose: false }), false);
  assert.deepEqual(storedPrintSettings(clone(legacyPrintSettings())), { settings: legacyPrintSettings(), stored: false });
  // الملفّان المجمَّدان يُعادان كما هما: الافتراضي بقيمٍ عبثية فيهما ما زال الافتراضي
  const noisy = legacyPrintSettings();
  noisy.profiles[0].options.copies = 3;
  assert.equal(storedPrintSettings(noisy).stored, false);
  for (const b of [null, { reset: true }]) assert.equal(isPrintSettingsReset(b), true, JSON.stringify(b));
  for (const b of [undefined, {}, { reset: false }, { reset: 'true' }, { reset: true, version: 1 }, [], 'reset', legacyPrintSettings()]) {
    assert.equal(isPrintSettingsReset(b), false, JSON.stringify(b));
  }
});

test('الحجم: أكبر من 16 كيلوبايت ⇒ 413 قبل التحليل', () => {
  const big = fleet() as unknown as Record<string, unknown>;
  big.pad = 'x'.repeat(PRINT_LIMITS.maxBytes);
  const r = parsePrintSettings(big);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual([r.status, r.code, r.message], [413, 'PRINT_SETTINGS_TOO_LARGE', PRINT_ISSUES.tooLarge]);
  assert.equal(printSettingsBytes('ق'), 4, 'UTF-8: حرف عربي بايتان بين علامتي تنصيص');
  // اثنا عشر قالباً بأطول اسم وتذييل تبقى تحت الحدّ
  const full = legacyPrintSettings();
  for (let i = 0; full.profiles.length < 12; i++) {
    const p = profile({ id: `long-name-${i}`, name: `${i}`.padEnd(40, 'ق'), printer: 'impact', template: 'impact_plain' }, 'ff_a4');
    p.options.footerText = 'ذ'.repeat(160);
    full.profiles.push(p);
  }
  assert.ok(printSettingsBytes(full) < PRINT_LIMITS.maxBytes, `${printSettingsBytes(full)}`);
  assert.ok(parsePrintSettings(full).ok);
  const bad = parsePrintSettings({ ...fleet(), version: 3 });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual([bad.status, bad.code], [400, 'PRINT_SETTINGS_INVALID']);
});

// ═══ المعالجات الحقيقية فوق Prisma مزيّف ═══

type Row = Record<string, any>;
const T = 'T1';
const stub = (r: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, r));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
let st: { admin: Row | null; settings: Row | null };
let writes: Row[] = [];
function reset(): void {
  writes = [];
  st = { admin: { isActive: true, canManageCompanySettings: true }, settings: { tenantId: T, name: 'شركة', printSettings: null } };
}
reset();
const db: Row = {
  admin: { async findUnique() { return st.admin; } },
  companySettings: {
    async findUnique(a: Row) {
      if (!st.settings || a.where.tenantId !== st.settings.tenantId) return null;
      return { printSettings: st.settings.printSettings };
    },
    async updateMany(a: Row) {
      writes.push(a);
      if (!st.settings || a.where.tenantId !== st.settings.tenantId) return { count: 0 };
      // Prisma.DbNull = NULL في العمود (كما تكتبه قاعدة البيانات)
      Object.assign(st.settings, a.data, a.data.printSettings === Prisma.DbNull ? { printSettings: null } : {});
      return { count: 1 };
    },
  },
};
stub('config/database', { default: db });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = (require('../routes/printSettings') as typeof import('../routes/printSettings')).default;

/** يشغّل مكدّس المسار كلّه (حرّاسه ثم معالجه) — المصادقة قبله في routes/company.ts */
async function call(method: string, req: Row): Promise<{ status: number; body: Row }> {
  const layer = (router as unknown as { stack: Row[] }).stack.find((l) => l.route?.path === '/' && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} / مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { query: {}, params: {}, body: {}, headers: {}, user: { id: 'ADM', role: 'ADMIN', tenantId: T }, ...req };
  for (const h of layer.route.stack as Row[]) {
    let passed = false;
    let err: unknown;
    await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) throw err;
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body };
}
const rep = { id: 'R1', role: 'SALES_REP', tenantId: T };

test('القراءة تشغيلاً: لكل مسجّل (والمندوب)، null ⇒ الافتراضي، والمحفوظ الصالح كما هو، والتالف ⇒ الافتراضي', async () => {
  reset();
  const legacy = await call('get', { user: rep });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body, { success: true, data: legacyPrintSettings(), stored: false, hasCompany: true });
  st.settings!.printSettings = fleet();
  assert.deepEqual((await call('get', { user: rep })).body.data, fleet());
  assert.equal((await call('get', {})).body.stored, true);
  st.settings!.printSettings = { ...fleet(), version: 9 };
  const broken = await call('get', {});
  assert.deepEqual([broken.body.data, broken.body.stored], [legacyPrintSettings(), false]);
  st.settings = null;
  assert.deepEqual((await call('get', {})).body, { success: true, data: legacyPrintSettings(), stored: false, hasCompany: false });
});

test('الحفظ تشغيلاً: المندوب والمستخدم بلا صلاحية إعدادات الشركة ⇒ 403 بلا كتابة، والمخوَّل يكتب الصورة القانونية', async () => {
  reset();
  assert.equal((await call('put', { user: rep, body: fleet() })).status, 403);
  st.admin = { isActive: true, canManageCompanySettings: false };
  assert.equal((await call('put', { user: { id: 'M1', role: 'MANAGER', tenantId: T }, body: fleet() })).status, 403);
  assert.equal(writes.length, 0, 'لا كتابة عند الرفض');
  st.admin = { isActive: true, canManageCompanySettings: true };
  const body = fleet();
  body.profiles[0].name = '  نقطية MIP480  ';
  const ok = await call('put', { user: { id: 'M1', role: 'MANAGER', tenantId: T }, body });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.data, fleet());
  assert.deepEqual(writes, [{ where: { tenantId: T }, data: { printSettings: fleet() } }], 'كتابة واحدة على صفّ الشركة');
  // جلسة دخول المالك تمرّ كالمدير الذي تمثّله (requireAdminPermission)
  st.admin = { isActive: true, canManageCompanySettings: false };
  assert.equal((await call('put', { user: { id: 'ADM', role: 'ADMIN', tenantId: T, impersonated: true }, body: legacyPrintSettings() })).status, 200);
});

test('الحفظ تشغيلاً: بلا صفّ إعدادات ⇒ 409 بلا إنشاء، والمرفوض ⇒ 400 برسالة القاعدة، والكبير ⇒ 413 — بلا كتابة', async () => {
  reset();
  st.settings = null;
  const none = await call('put', { body: fleet() });
  assert.deepEqual([none.status, none.body.code, none.body.message], [409, 'COMPANY_SETTINGS_MISSING', 'احفظ بيانات الشركة أولا']);
  reset();
  const bad = fleet();
  bad.routing.statement = 'van-80';
  const r = await call('put', { body: bad });
  assert.deepEqual([r.status, r.body.code, r.body.message], [400, 'PRINT_SETTINGS_INVALID', PRINT_ISSUES.routeThermal]);
  assert.ok(Array.isArray(r.body.issues) && r.body.issues[0].path === 'routing.statement');
  const big = await call('put', { body: { ...fleet(), pad: 'x'.repeat(17000) } });
  assert.equal(big.status, 413);
  assert.equal(writes.length, 0);
  assert.equal(st.settings!.printSettings, null);
});

test('«استعادة الافتراضي» تشغيلاً: { reset: true } أو null ⇒ العمود null (لا كائن)، والقراءة بعدها غير مخصّصة — بحرّاس الحفظ نفسها', async () => {
  reset();
  st.settings!.printSettings = fleet();
  const r = await call('put', { body: { reset: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true, data: legacyPrintSettings(), stored: false, hasCompany: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.printSettings, Prisma.DbNull, 'NULL حرفياً لا نسخةٌ من الافتراضي');
  assert.equal(st.settings!.printSettings, null);
  assert.deepEqual((await call('get', { user: rep })).body, { success: true, data: legacyPrintSettings(), stored: false, hasCompany: true });
  // JSON null (لمن يصل به) كذلك
  st.settings!.printSettings = fleet();
  assert.equal((await call('put', { body: null })).status, 200);
  assert.equal(st.settings!.printSettings, null);
  // الحرّاس نفسها: المندوب 403 بلا كتابة، وبلا صفّ 409
  writes = [];
  st.settings!.printSettings = fleet();
  assert.equal((await call('put', { user: rep, body: { reset: true } })).status, 403);
  assert.equal(writes.length, 0);
  assert.deepEqual(st.settings!.printSettings, fleet());
  st.settings = null;
  const none = await call('put', { body: { reset: true } });
  assert.deepEqual([none.status, none.body.code], [409, 'COMPANY_SETTINGS_MISSING']);
  // ما ليس إعادةً صريحة يمرّ بالتحليل الصارم
  reset();
  assert.equal((await call('put', { body: { reset: false } })).status, 400);
  assert.equal((await call('put', { body: { reset: true, extra: 1 } })).status, 400);
  assert.equal(writes.length, 0);
});

test('حفظ كائنٍ يساوي الافتراضي: يُكتب كما هو لكن الردّ والقراءة «غير مخصّص» (شبكة الأمان)', async () => {
  reset();
  const r = await call('put', { body: legacyPrintSettings() });
  assert.deepEqual([r.status, r.body.stored], [200, false]);
  assert.deepEqual((await call('get', {})).body, { success: true, data: legacyPrintSettings(), stored: false, hasCompany: true });
  assert.equal((await call('put', { body: fleet() })).body.stored, true);
});

// ═══ حرّاس نصّية ═══

test('حارس نصّي: الحفظ بصلاحية إعدادات الشركة، والقراءة بلا حارس إضافي، والتركيب بعد المصادقة تحت /api/company', () => {
  const r = read('routes', 'printSettings.ts');
  assert.ok(r.includes("router.put('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), async"));
  assert.ok(r.includes("router.get('/', async"), 'القراءة لكل مسجّل — المندوب يطبع بها');
  assert.doesNotMatch(r, /router\.use\(/, 'لا حارس عامّ يمنع المندوب من القراءة');
  assert.ok(r.includes('prisma.companySettings.updateMany({ where: { tenantId: tid }, data: { printSettings: parsed.value'), 'لا upsert يخترع صفّاً');
  assert.doesNotMatch(r, /companySettings\.(upsert|create)\(/);
  assert.ok(r.includes('prisma.companySettings.updateMany({ where: { tenantId: tid }, data: { printSettings: Prisma.DbNull } })'), 'الإعادة NULL في العمود');
  const c = read('routes', 'company.ts');
  const auth = c.indexOf('router.use(authenticate);');
  const mount = c.indexOf("router.use('/print-settings', printSettingsRouter);");
  assert.ok(auth > 0 && mount > auth, 'المسار بعد المصادقة');
  assert.ok(mount < c.indexOf("router.get('/'"), 'قبل مسارات الشركة');
});

test('حارس نصّي: PUT /api/company وcompanySchema لم يُمسّا — والعمود إضافي اختياري في CompanySettings', () => {
  const c = read('routes', 'company.ts');
  const schemaBlock = c.slice(c.indexOf('const companySchema = z.object({'), c.indexOf('});', c.indexOf('const companySchema = z.object({')));
  assert.doesNotMatch(schemaBlock, /print/i, 'إعدادات الطباعة ليست حقلاً في PUT /api/company');
  const put = c.slice(c.indexOf("router.put('/'"), c.indexOf('export default router'));
  assert.doesNotMatch(put, /printSettings/);
  assert.equal(put.split('prisma.companySettings.findUnique(').length - 1, 2, 'قراءتا قفل ZATCA كما هما');
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const i = schema.indexOf('model CompanySettings {');
  const block = schema.slice(i, schema.indexOf('\n}', i));
  assert.match(block, /\n\s*printSettings\s+Json\?\s*\n/, 'printSettings Json? بلا افتراضي (null = سلوك اليوم)');
});
