/**
 * «اجعل يمكن حذف كل شي حتى كيو ار» (قرار المالك ٤ نوفمبر ٢٠٢٦) — قبول النواة للخيار الصريح، مستقلّاً عن المنفّذين:
 *
 * ١) الحفظ الصارم يقبل الحذوف الثلاثة (رمز QR = sections.qr.visible=false، الأصناف = sections.items.visible=false، الأختام =
 *    stamps:false) للحرارية والصفحة والنقطية القياسية والثنائي على الصفحة والنقطية — ويرفض QR الافتراضي على الصفحة بمفتاحٍ غير
 *    visible، وstamps غير منطقية، والمفتاح المجهول، ومربع QR أصغر من 47 مم ما دام الرمز لم يُحذف.
 * ٢) القراءة المتسامحة (الجهاز) تُبقي الحذوف كما هي.
 * ٣) الافتراضي والقديم بلا أيّ حذف — والغياب و{} وtrue = اليوم.
 * ٤) الرول الكلاسيكي لا يحمل تخطيطاً (فلا يحذف شيئاً).
 * ٥) نسختا النواة (الواجهة والخادم) حرفيتان.
 * ٦) مستند «الربط البرمجي API» يوثّق الحذوف الثلاثة ولا يَعِد بأن رمز QR لا يُحذف.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  COMPLIANCE_HIDE_SECTIONS, LEGACY_PAGE_ID, LEGACY_THERMAL_ID, PRINT_ISSUES, PRINT_WARNINGS,
  areStampsRemoved, checkPrintSettings, defaultPrintLayout, defaultPrintOptions, isItemsRemoved, isQrRemoved, legacyPrintSettings,
  legacyThermalProfile, normalizePrintSettings, presetPaper, profileWarnings, readPrintSettings,
  type LayoutDesign, type PaperPresetId, type PrintLayout, type PrintProfile, type PrintSettingsV1, type PrinterType, type TemplateId,
} from './printSettings';
import * as printSettingsModule from './printSettings';
import { starterForm } from './formModel';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
/** جسم الملف بعد أسطر التعليق // والفراغ في أوّله (كحارس النسخ في printSettings.test.ts) */
const copyBody = (s: string) => s.replace(/\r\n/g, '\n').replace(/^(?:[ \t]*\/\/[^\n]*\n|[ \t]*\n)*/, '');

// ─── القوالب الخمسة التي تحمل تخطيطاً ───

interface Kind { name: string; printer: PrinterType; template: TemplateId; preset: PaperPresetId; design: LayoutDesign; qrVirtual: boolean }
const KINDS: Kind[] = [
  { name: 'thermal', printer: 'thermal', template: 'roll_compact', preset: 'roll80', design: 'standard', qrVirtual: false },
  { name: 'page_standard', printer: 'page', template: 'page_branded', preset: 'a4', design: 'standard', qrVirtual: true },
  { name: 'impact_standard', printer: 'impact', template: 'impact_plain', preset: 'ff_a4', design: 'standard', qrVirtual: true },
  { name: 'page_grid', printer: 'page', template: 'page_branded', preset: 'a4', design: 'grid_bilingual', qrVirtual: true },
  { name: 'impact_grid', printer: 'impact', template: 'impact_plain', preset: 'ff_a4', design: 'grid_bilingual', qrVirtual: true },
];
const profileOf = (k: Kind, extra: Partial<PrintLayout> = {}, id = `p-${k.name.replace(/_/g, '-')}`): PrintProfile => ({
  id, name: k.name, printer: k.printer, template: k.template, paper: presetPaper(k.preset)!,
  options: { ...defaultPrintOptions(k.printer), layout: { ...defaultPrintLayout(k.printer, k.design), ...extra } },
});
/** إعدادٌ صالح بقالبٍ واحد (والـPDF على قالب صفحةٍ مساعد حين يكون القالب غير صفحة) */
function settingsWith(p: PrintProfile): PrintSettingsV1 {
  const pdf: PrintProfile = { id: 'pdf-a4', name: 'pdf', printer: 'page', template: 'page_plain', paper: presetPaper('a4')!, options: defaultPrintOptions('page') };
  const profiles = p.printer === 'page' ? [p] : [p, pdf];
  return {
    version: 1, profiles,
    routing: { invoice: p.id, receipt: p.id, statement: null, notices: null },
    pdfProfileId: p.printer === 'page' ? p.id : pdf.id, repMayChoose: true,
  };
}
const raw = (s: PrintSettingsV1): unknown => JSON.parse(JSON.stringify(s));
const layoutIn = (s: PrintSettingsV1, id: string): PrintLayout | undefined => s.profiles.find((x) => x.id === id)?.options.layout;

const QR_OFF: Partial<PrintLayout> = { sections: { qr: { visible: false } } };
const ITEMS_OFF: Partial<PrintLayout> = { sections: { items: { visible: false } } };
const STAMPS_OFF: Partial<PrintLayout> = { stamps: false };
const ALL_OFF: Partial<PrintLayout> = { sections: { items: { visible: false }, qr: { visible: false } }, stamps: false };
const HIDES: Array<{ name: string; extra: Partial<PrintLayout>; qr: boolean; items: boolean; stamps: boolean }> = [
  { name: 'qr', extra: QR_OFF, qr: true, items: false, stamps: false },
  { name: 'items', extra: ITEMS_OFF, qr: false, items: true, stamps: false },
  { name: 'stamps', extra: STAMPS_OFF, qr: false, items: false, stamps: true },
  { name: 'all', extra: ALL_OFF, qr: true, items: true, stamps: true },
];

// ─── ١) الحفظ الصارم ───

test('الحفظ الصارم يقبل الحذوف الثلاثة (ومجتمعةً) لكل قالبٍ يحمل تخطيطاً، والقيمة القانونية تحملها', () => {
  const errors: string[] = [];
  for (const k of KINDS) {
    for (const h of HIDES) {
      const p = profileOf(k, h.extra);
      const r = checkPrintSettings(raw(settingsWith(p)), true);
      if (!r.ok) { errors.push(`${k.name}/${h.name}: رُفض ${JSON.stringify(r.issues)}`); continue; }
      const l = layoutIn(r.value, p.id);
      if (isQrRemoved(l) !== h.qr) errors.push(`${k.name}/${h.name}: isQrRemoved=${isQrRemoved(l)}`);
      if (isItemsRemoved(l) !== h.items) errors.push(`${k.name}/${h.name}: isItemsRemoved=${isItemsRemoved(l)}`);
      if (areStampsRemoved(l) !== h.stamps) errors.push(`${k.name}/${h.name}: areStampsRemoved=${areStampsRemoved(l)}`);
      // الصورة القانونية ثابتة: حفظها ثانيةً يعيدها حرفاً
      const again = checkPrintSettings(raw(r.value), true);
      if (!again.ok || JSON.stringify(again.value) !== JSON.stringify(r.value)) errors.push(`${k.name}/${h.name}: الصورة القانونية غير ثابتة`);
      // رمز QR الافتراضي (الصفحة والنقطية) لا يدخل الترتيب
      if (k.qrVirtual && l?.order.includes('qr')) errors.push(`${k.name}/${h.name}: qr دخل الترتيب`);
    }
  }
  assert.deepEqual(errors, []);
});

test('الحفظ الصارم: QR الافتراضي على الصفحة والنقطية بمفتاح visible وحده — وغيره «ليس في القالب»؛ والرول يقبل تنسيق قسمه الحقيقي', () => {
  for (const k of KINDS) {
    for (const bad of [{ visible: false, align: 'end' }, { align: 'end' }, { fontPct: 120 }, { visible: false, spaceBeforeMm: 4 }] as const) {
      const r = checkPrintSettings(raw(settingsWith(profileOf(k, { sections: { qr: bad } }))), true);
      if (k.qrVirtual) {
        assert.equal(r.ok, false, `${k.name}: قُبل ${JSON.stringify(bad)}`);
        if (!r.ok) assert.ok(r.issues.some((i) => i.message === PRINT_ISSUES.layoutSectionUnknown && i.path.includes('sections.qr')), `${k.name}: ${JSON.stringify(r.issues)}`);
      } else {
        assert.equal(r.ok, true, `${k.name}: رُفض تنسيق قسم QR الحقيقي ${JSON.stringify(bad)}`);
      }
    }
    // مفتاحٌ مجهول داخل تنسيق QR مرفوضٌ في الجميع
    const unk = checkPrintSettings(raw(settingsWith(profileOf(k, { sections: { qr: { visible: false, hidden: true } as never } }))), true);
    assert.equal(unk.ok, false, `${k.name}: قُبل مفتاحٌ مجهول في sections.qr`);
  }
});

test('الحفظ الصارم: stamps منطقية فقط، والمفتاح المجهول مرفوض كما اليوم، وحذف الأختام ليس في التخطيط الافتراضي', () => {
  for (const k of KINDS) {
    for (const bad of ['false', 0, 1, null, 'no', {}]) {
      const r = checkPrintSettings(raw(settingsWith(profileOf(k, { stamps: bad as never }))), true);
      assert.equal(r.ok, false, `${k.name}: قُبلت stamps=${JSON.stringify(bad)}`);
      if (!r.ok) assert.ok(r.issues.some((i) => i.path.includes('stamps')), `${k.name}: المسار لا يذكر stamps ${JSON.stringify(r.issues)}`);
    }
    const ok = checkPrintSettings(raw(settingsWith(profileOf(k, { stamps: true }))), true);
    assert.equal(ok.ok, true, `${k.name}: رُفضت stamps=true`);
    const unknown = checkPrintSettings(raw(settingsWith(profileOf(k, { hideAll: true } as never))), true);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.ok(unknown.issues.some((i) => i.message === PRINT_ISSUES.unknownKey), JSON.stringify(unknown.issues));
    // الافتراضي لا يحمل المفتاح الجديد (نسخةٌ قديمة تقرؤه كما اليوم)
    assert.equal('stamps' in defaultPrintLayout(k.printer, k.design), false);
  }
});

test('الحفظ الصارم: لوحةٌ بمربع QR والرمز محذوف صالحة؛ ومربع QR أصغر من 47 مم مرفوضٌ ما دام الرمز لم يُحذف', () => {
  for (const k of KINDS.filter((x) => x.printer !== 'thermal' && x.design === 'standard')) {
    const canvas = (w: number) => ({ headerMm: 0, footerMm: 60, boxes: [{ id: 'qr' as const, band: 'footer' as const, x: 0, y: 0, w, h: w }] });
    const kept = checkPrintSettings(raw(settingsWith(profileOf(k, { canvas: canvas(50), ...QR_OFF }))), true);
    assert.equal(kept.ok, true, `${k.name}: لوحةٌ بمربع QR والرمز محذوف رُفضت ${kept.ok ? '' : JSON.stringify(kept.issues)}`);
    const tiny = checkPrintSettings(raw(settingsWith(profileOf(k, { canvas: canvas(20) }))), true);
    assert.equal(tiny.ok, false, `${k.name}: مربع QR 20 مم قُبل والرمز غير محذوف`);
    if (!tiny.ok) assert.ok(tiny.issues.some((i) => i.message === PRINT_ISSUES.layoutCanvasQr), JSON.stringify(tiny.issues));
  }
});

test('لا قسم مقفل: LOCKED_VISIBLE أُزيلت، والأصناف وQR في قائمة التحذير، ورسالة «لا يمكن إخفاء» أُزيلت من النواة', () => {
  assert.equal('LOCKED_VISIBLE' in printSettingsModule, false);
  assert.deepEqual([...COMPLIANCE_HIDE_SECTIONS].sort(), ['items', 'qr']);
  assert.equal('layoutLockedVisible' in PRINT_ISSUES, false);
});

// ─── ٢) القراءة المتسامحة ───

test('القراءة المتسامحة (الجهاز) تُبقي الحذوف الثلاثة لكل قالب — وstamps التالفة تسقط وحدها ويبقى الباقي', () => {
  const errors: string[] = [];
  for (const k of KINDS) {
    for (const h of HIDES) {
      const p = profileOf(k, h.extra);
      const tolerant = checkPrintSettings(raw(settingsWith(p)), false);
      if (!tolerant.ok) { errors.push(`${k.name}/${h.name}: رُفض في القراءة`); continue; }
      for (const [label, s] of [['check', tolerant.value], ['normalize', normalizePrintSettings(raw(settingsWith(p)))], ['read', readPrintSettings(raw(settingsWith(p))).settings]] as const) {
        const l = layoutIn(s, p.id);
        if (isQrRemoved(l) !== h.qr || isItemsRemoved(l) !== h.items || areStampsRemoved(l) !== h.stamps) {
          errors.push(`${k.name}/${h.name}/${label}: qr=${isQrRemoved(l)} items=${isItemsRemoved(l)} stamps=${areStampsRemoved(l)}`);
        }
      }
      if (!readPrintSettings(raw(settingsWith(p))).customized) errors.push(`${k.name}/${h.name}: قالبٌ بحذفٍ عُدّ افتراضياً`);
    }
    // stamps تالفة: تسقط وحدها في القراءة، والإخفاء الصريح باقٍ
    const broken = profileOf(k, { ...QR_OFF, stamps: 'no' as never });
    const r = checkPrintSettings(raw(settingsWith(broken)), false);
    assert.equal(r.ok, true, `${k.name}: القراءة رفضت الإعداد كله`);
    if (r.ok) {
      const l = layoutIn(r.value, broken.id);
      assert.ok(l, `${k.name}: سقط التخطيط كله`);
      assert.equal(l && 'stamps' in l, false, `${k.name}: stamps التالفة بقيت`);
      assert.equal(isQrRemoved(l), true, `${k.name}: سقط حذف الرمز مع stamps التالفة`);
    }
  }
  assert.deepEqual(errors, []);
});

// ─── ٣) الافتراضي والقديم ───

test('الافتراضي والقديم بلا أيّ حذف — والغياب و{} وtrue وnull = اليوم', () => {
  for (const s of [legacyPrintSettings(), normalizePrintSettings(null), normalizePrintSettings(undefined), normalizePrintSettings({ version: 2 })]) {
    for (const p of s.profiles) {
      const l = p.options.layout;
      assert.equal(isQrRemoved(l) || isItemsRemoved(l) || areStampsRemoved(l), false, `${p.id}: حذفٌ في الافتراضي`);
    }
  }
  for (const k of KINDS) {
    const l = defaultPrintLayout(k.printer, k.design);
    assert.equal(isQrRemoved(l) || isItemsRemoved(l) || areStampsRemoved(l), false, `${k.name}: حذفٌ في التخطيط الافتراضي`);
    // قالبٌ بلا حذفٍ صالحٌ ولا ينبّه بأيّ تحذير حذف
    const w = profileWarnings(profileOf(k), { phase2: true }).warnings;
    for (const key of ['qrRemoved', 'itemsRemoved', 'stampsRemoved'] as const) assert.equal(w.includes(PRINT_WARNINGS[key]), false, `${k.name}: ${key} بلا حذف`);
  }
  const blanks: unknown[] = [null, undefined, {}, { sections: {} }, { sections: { qr: {} } }, { sections: { qr: { visible: true }, items: { visible: true } } },
    { stamps: true }, { sections: { qr: undefined, items: undefined } }];
  for (const b of blanks) {
    const l = b as Parameters<typeof isQrRemoved>[0];
    assert.equal(isQrRemoved(l), false, JSON.stringify(b));
    assert.equal(isItemsRemoved(l), false, JSON.stringify(b));
    assert.equal(areStampsRemoved(l), false, JSON.stringify(b));
  }
  // والقيمة الحرفية false وحدها هي الحذف (لا الغياب ولا falsy غيرها)
  assert.equal(isQrRemoved({ sections: { qr: { visible: false } } }), true);
  assert.equal(isItemsRemoved({ sections: { items: { visible: false } } }), true);
  assert.equal(areStampsRemoved({ stamps: false }), true);
  assert.equal(areStampsRemoved({ stamps: 0 as never }), false);
  assert.equal(isQrRemoved({ sections: { qr: { visible: 0 as never } } }), false);
  // إخفاء القسم الحامل وحده ليس حذفاً للرمز
  assert.equal(isQrRemoved({ sections: { totals: { visible: false }, info: { visible: false } } }), false);
});

test('تحذيرات القالب: الحذف الصريح يُنبَّه عليه في كل طابعة، والرمز المحذوف لا يُسأل عن اتساعه على الرول الضيّق', () => {
  for (const k of KINDS) {
    for (const h of HIDES) {
      const w = profileWarnings(profileOf(k, h.extra), { phase2: true }).warnings;
      assert.equal(w.includes(PRINT_WARNINGS.qrRemoved), h.qr, `${k.name}/${h.name}: qrRemoved`);
      assert.equal(w.includes(PRINT_WARNINGS.itemsRemoved), h.items, `${k.name}/${h.name}: itemsRemoved`);
      assert.equal(w.includes(PRINT_WARNINGS.stampsRemoved), h.stamps, `${k.name}/${h.name}: stampsRemoved`);
    }
  }
  // رول 58 مم بعرض طباعة 320 نقطة: اليوم «لا يتسع» و«المرحلة الثانية تحتاج 384» — والرمز المحذوف بلا أيٍّ منهما
  const narrow: PrintProfile = {
    ...profileOf(KINDS[0]), id: 'narrow-58', template: 'roll_compact', paper: { ...presetPaper('roll58')!, printableDots: 320 },
  };
  const today = profileWarnings(narrow, { phase2: true }).warnings;
  assert.ok(today.includes(PRINT_WARNINGS.phase2Narrow), 'اليوم بلا تنبيه العرض');
  const removed = profileWarnings({ ...narrow, options: { ...narrow.options, layout: { ...narrow.options.layout!, ...QR_OFF } } }, { phase2: true }).warnings;
  assert.equal(removed.includes(PRINT_WARNINGS.phase2Narrow), false);
  assert.equal(removed.includes(PRINT_WARNINGS.qrNoFit), false);
  assert.ok(removed.includes(PRINT_WARNINGS.qrRemoved));
  // وما عدا ذلك المخرج نفسه: إزالة تنبيهات الرمز وإضافة تحذير الحذف فقط
  assert.deepEqual(removed.filter((x) => x !== PRINT_WARNINGS.qrRemoved), today.filter((x) => x !== PRINT_WARNINGS.phase2Narrow && x !== PRINT_WARNINGS.qrNoFit));
});

// ─── ٤) الرول الكلاسيكي ───

test('الرول الكلاسيكي لا يحمل تخطيطاً: الحفظ يرفض حذفاً عليه، والقراءة تعيده كما اليوم بلا حذف', () => {
  for (const extra of [QR_OFF, ITEMS_OFF, STAMPS_OFF, ALL_OFF]) {
    const s = legacyPrintSettings();
    const classic: PrintProfile = { ...legacyThermalProfile(), options: { ...legacyThermalProfile().options, layout: { ...defaultPrintLayout('thermal'), ...extra } } };
    s.profiles = s.profiles.map((p) => (p.id === LEGACY_THERMAL_ID ? classic : p));
    // الملفّان الافتراضيان يُعادان كما هما في الصورة القانونية — فلا يصل حذفٌ إلى الشريط الكلاسيكي في الحفظ ولا في القراءة
    for (const strict of [true, false]) {
      const r = checkPrintSettings(raw(s), strict);
      if (r.ok) {
        const p = r.value.profiles.find((x) => x.id === LEGACY_THERMAL_ID)!;
        assert.equal(p.options.layout, undefined, `strict=${strict}: الكلاسيكي حمل تخطيطاً`);
        assert.equal(p.template, 'roll_classic');
      }
    }
    // وقالبٌ كلاسيكيٌّ بمعرّفٍ آخر محجوز للافتراضي وحده (ومعه التخطيط مرفوض)
    const other: PrintProfile = { ...classic, id: 'my-classic', name: 'كلاسيكي' };
    const r2 = checkPrintSettings(raw({ ...legacyPrintSettings(), profiles: [...legacyPrintSettings().profiles, other] }), true);
    assert.equal(r2.ok, false);
    if (!r2.ok) {
      const msgs = r2.issues.map((i) => i.message);
      assert.ok(msgs.includes(PRINT_ISSUES.classicReserved) || msgs.includes(PRINT_ISSUES.layoutClassic), JSON.stringify(r2.issues));
    }
  }
  // صفحة PDF الافتراضية كذلك تُعاد كما هي
  const s = legacyPrintSettings();
  s.profiles = s.profiles.map((p) => (p.id === LEGACY_PAGE_ID ? { ...p, options: { ...p.options, layout: { ...defaultPrintLayout('page'), ...ALL_OFF } } } : p));
  const r = checkPrintSettings(raw(s), true);
  if (r.ok) assert.equal(r.value.profiles.find((x) => x.id === LEGACY_PAGE_ID)!.options.layout, undefined);
});

// ─── ٥) النسختان ───

test('النواة نسخة حرفية من الخادم بعد الحذف الصريح — ومساعدات القراءة الثلاثة في النسختين', () => {
  const web = read('src', 'lib', 'print', 'printSettingsCore.ts');
  const server = read('..', 'backend', 'src', 'services', 'printSettingsCore.ts');
  assert.equal(copyBody(web), copyBody(server), 'printSettingsCore.ts في الواجهة يختلف عن الخادم');
  for (const fn of ['isQrRemoved', 'isItemsRemoved', 'areStampsRemoved']) {
    assert.ok(new RegExp(`export function ${fn}\\(`).test(server), `${fn} ليست في نواة الخادم`);
  }
  assert.ok(/stamps:\s*free\(z\.boolean\(\)\)/.test(server), 'stamps ليست free(z.boolean()) في الخادم');
});

// ─── ٦) مستند الربط البرمجي ───

test('مستند «الربط البرمجي API» يوثّق الحذف الصريح (stamps وsections.qr وsections.items) ولا يَعِد بأن الرمز لا يُحذف', async () => {
  const { API_DOC_GROUPS } = await import('../apiDocsCatalog');
  const eps = API_DOC_GROUPS.flatMap((g) => g.endpoints);
  const ep = (method: string, p: string) => {
    const e = eps.find((x) => x.method === method && x.path === p);
    assert.ok(e, `${method} ${p} غير موثّق`);
    return e;
  };
  const getS = ep('GET', '/company/print-settings');
  const putS = ep('PUT', '/company/print-settings');
  const getT = ep('GET', '/company/print-texts');
  const all = [getS.response, ...getS.rules, ...putS.rules, ...getT.rules].join(' ');
  // ما يقوله المستند يطابق النواة: الحفظ الصارم يقبل الحذوف الثلاثة على الصفحة
  const k = KINDS.find((x) => x.name === 'page_standard')!;
  const r = checkPrintSettings(raw(settingsWith(profileOf(k, ALL_OFF))), true);
  assert.ok(r.ok, 'النواة ترفض الحذوف الثلاثة');
  assert.ok(getS.response.includes('stamps?: boolean'), 'stamps غير موثّق في بنية options.layout');
  assert.ok(all.includes('sections.qr.visible = false'), 'حذف رمز QR غير موثّق');
  assert.ok(/visible:false[^.]*items/.test(all), 'حذف الأصناف غير موثّق');
  assert.ok(putS.rules.some((x) => x.startsWith('options.layout اختياري') && x.includes('stamps')), 'قاعدة الحفظ لا تذكر stamps');
  assert.ok(getT.rules.some((x) => x.includes('ورمز QR ليس عبارة') && x.includes('sections.qr.visible = false')), 'قاعدة النصوص تَعِد بأن الرمز يُطبع دائماً');
  assert.doesNotMatch(all, /لا يُحذف أبداً|ولا إخفاء لـitems|ولا يُخفى بها items/, 'وعدٌ بقفلٍ أزاله قرار المالك ٤ نوفمبر ٢٠٢٦');
});

// ─── «نموذج الشركة المطبوع مسبقاً» (١٠–١١ نوفمبر ٢٠٢٦): الحذوف الصريحة تُحفظ عليه كما على غيره، وحذف QR يُغني عن حقله ───

test('النموذج المطبوع مسبقاً: الحفظ الصارم يقبل الحذوف الثلاثة (وبلا حقل QR مع حذفه)، والصورة القانونية ثابتة، والقراءة تُبقيها', () => {
  const errors: string[] = [];
  const pdf: PrintProfile = { id: 'pdf-a4', name: 'pdf', printer: 'page', template: 'page_plain', paper: presetPaper('a4')!, options: defaultPrintOptions('page') };
  for (const h of HIDES) {
    const paper = { ...presetPaper('a4')!, marginTopMm: 0, marginBottomMm: 0 };
    const form = starterForm(paper, { withQr: !h.qr });
    const p: PrintProfile = {
      id: 'p-form', name: 'نموذج', printer: 'page', template: 'page_plain', paper,
      options: { ...defaultPrintOptions('page'), layout: { ...defaultPrintLayout('page', 'preprinted'), ...h.extra, form } },
    };
    const s: PrintSettingsV1 = { version: 1, profiles: [p, pdf], routing: { invoice: p.id, receipt: null, statement: null, notices: null }, pdfProfileId: pdf.id, repMayChoose: true };
    const r = checkPrintSettings(raw(s), true);
    if (!r.ok) { errors.push(`${h.name}: رُفض ${JSON.stringify(r.issues)}`); continue; }
    const l = layoutIn(r.value, p.id);
    if (isQrRemoved(l) !== h.qr || isItemsRemoved(l) !== h.items || areStampsRemoved(l) !== h.stamps) errors.push(`${h.name}: الحذوف لم تُحمل`);
    if (l?.order.includes('qr')) errors.push(`${h.name}: qr دخل الترتيب`);
    if (Object.keys(l ?? {}).pop() !== 'form') errors.push(`${h.name}: form ليس آخر المفاتيح`);
    const again = checkPrintSettings(raw(r.value), true);
    if (!again.ok || JSON.stringify(again.value) !== JSON.stringify(r.value)) errors.push(`${h.name}: الصورة القانونية غير ثابتة`);
    const read = readPrintSettings(raw(r.value)).settings;
    if (JSON.stringify(layoutIn(read, p.id)) !== JSON.stringify(l)) errors.push(`${h.name}: القراءة ≠ الحفظ`);
    // وبلا حذف QR ولا حقله ⇒ رفضٌ برسالته
    if (!h.qr) {
      const noQr = { ...p, options: { ...p.options, layout: { ...p.options.layout!, form: { ...form, fields: form.fields.filter((f) => f.id !== 'qr') } } } };
      const bad = checkPrintSettings(raw({ ...s, profiles: [noQr, pdf] }), true);
      if (bad.ok || !bad.issues.some((i) => i.message === PRINT_ISSUES.layoutFormQrMissing)) errors.push(`${h.name}: بلا QR ولا حذف قُبل`);
    }
  }
  assert.deepEqual(errors, []);
});
