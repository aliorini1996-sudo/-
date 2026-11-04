// «التحرير الحرّ» للمطبوعات (طلب المالك ٣ نوفمبر ٢٠٢٦) — المفاتيح الأربعة الاختيارية في options.layout: logoMm وlogoAfter
// وsections وcanvas. الحفظ الصارم يرفض كل حدٍّ برسالته العربية (400)، والقراءة المتسامحة تُسقط المفتاح المعيب وحده وتُبقي
// تخطيط المفاتيح الستة، والصورة القانونية تقرّب وترتّب، والحجم 48 كيلوبايت يتّسع لأسوأ اثني عشر تصميماً حرّاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANVAS_BOX_IDS, CANVAS_CONTENT_MM, LAYOUT_BOUNDS, LOCKED_VISIBLE, PRINT_ISSUES, PRINT_LIMITS, SECTION_IDS, canonicalPrintSettings,
  checkPrintSettings, defaultPrintLayout, defaultPrintOptions, legacyPrintSettings, parsePrintSettings, presetPaper, printSettingsBytes,
  sectionsFor, storedPrintSettings,
  type CanvasBox, type LayoutDesign, type PrintCanvas, type PrintLayout, type PrintProfile, type PrintSettingsV1,
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
const withLayoutOf = (p: PrintProfile, layout: Partial<PrintLayout> = {}, design: LayoutDesign = 'standard'): PrintProfile =>
  ({ ...p, options: { ...p.options, layout: { ...defaultPrintLayout(p.printer, design), ...layout } } });
const fleetWith = (p: PrintProfile): PrintSettingsV1 => ({ ...fleet(), profiles: [...fleet().profiles, p] });
const pagep = () => profile({ id: 'office-2', printer: 'page', template: 'page_branded' }, 'a4');
const impactp = () => profile({ id: 'mip-2', printer: 'impact', template: 'impact_plain' }, 'ff_a4');
const rollp = () => profile({ id: 'van-2', printer: 'thermal', template: 'roll_compact' }, 'roll80');
const box = (id: CanvasBox['id'], band: CanvasBox['band'], x: number, y: number, w: number, h: number): CanvasBox => ({ id, band, x, y, w, h });
const canvasOf = (boxes: CanvasBox[], headerMm = 60, footerMm = 80): PrintCanvas => ({ headerMm, footerMm, boxes });
/** رسالة الحفظ الأولى (status 400) */
const firstMsg = (p: PrintProfile | Record<string, unknown>): { status: number; message: string; all: string[] } => {
  const r = parsePrintSettings({ ...fleet(), profiles: [...fleet().profiles, p] });
  return r.ok ? { status: 200, message: '', all: [] } : { status: r.status, message: r.message, all: r.issues.map((i) => i.message) };
};
const rejects = (p: PrintProfile, message: string, label: string): void => {
  const r = firstMsg(p);
  assert.equal(r.status, 400, `${label}: ${JSON.stringify(r)}`);
  assert.ok(r.all.includes(message), `${label}: ${message} ⇐ ${JSON.stringify(r.all)}`);
};
const accepts = (p: PrintProfile, label: string): void => {
  const r = firstMsg(p);
  assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.all)}`);
};

test('الحرّ: الثوابت كما في العقد — والمفاتيح الأربعة خارج التخطيط الافتراضي', () => {
  assert.deepEqual([...CANVAS_BOX_IDS], ['logo', 'company', 'title', 'docInfo', 'customer', 'qr', 'totals', 'signatures', 'footer']);
  assert.deepEqual([...LOCKED_VISIBLE], ['items', 'qr']);
  assert.deepEqual({ ...CANVAS_CONTENT_MM }, { page: 188, impact: 201 });
  assert.equal(LAYOUT_BOUNDS.maxBoxes, 9);
  assert.equal(PRINT_LIMITS.maxBytes, 48 * 1024);
  for (const printer of ['thermal', 'impact', 'page'] as const) {
    assert.deepEqual(Object.keys(defaultPrintLayout(printer)), ['design', 'logo', 'logoSize', 'accent', 'tableStyle', 'order']);
  }
  assert.ok(PRINT_ISSUES.tooLarge.includes('48 كيلوبايت'));
});

test('الحرّ: الحدود المقبولة تُحفظ — شعار 6 و120، مكانه أعلى أو بعد قسم، وتنسيق كل قسم، ولوحتان على الصفحة والنقطية', () => {
  for (const logoMm of [6, 120, 37.5]) accepts(withLayoutOf(pagep(), { logoMm }), `logoMm ${logoMm}`);
  accepts(withLayoutOf(rollp(), { logoMm: 40, logo: 'end', logoAfter: 'top', tableStyle: 'striped' }), 'roll');
  for (const id of sectionsFor('page', 'standard')) accepts(withLayoutOf(pagep(), { logoAfter: id }), `after ${id}`);
  accepts(withLayoutOf(pagep(), { sections: { header: { visible: false, align: 'center', fontPct: 70, spaceBeforeMm: 0, spaceAfterMm: 30 }, totals: { fontPct: 160 } } }), 'sections');
  accepts(withLayoutOf(rollp(), { sections: { qr: { align: 'end', spaceBeforeMm: 4 }, items: { visible: true } } }), 'locked visible:true');
  const full = canvasOf([
    box('logo', 'header', 0, 0, 40, 30), box('company', 'header', 50, 0, 138, 30), box('title', 'header', 0, 32, 188, 10),
    box('docInfo', 'header', 0, 44, 90, 16), box('customer', 'header', 98, 44, 90, 16),
    box('qr', 'footer', 0, 0, 47, 47), box('totals', 'footer', 60, 0, 128, 40), box('signatures', 'footer', 0, 50, 188, 20), box('footer', 'footer', 0, 72, 188, 8),
  ]);
  accepts(withLayoutOf(pagep(), { canvas: full }), 'page canvas');
  accepts(withLayoutOf(profile({ id: 'pre-1', printer: 'impact', template: 'impact_preprinted' }, 'ff_a4'), { canvas: canvasOf([box('qr', 'header', 154, 0, 47, 47)]) }), 'impact x+w=201');
  accepts(withLayoutOf(pagep(), { canvas: canvasOf([], 150, 50) }), 'bands 200');
  accepts(withLayoutOf(pagep(), { canvas: canvasOf([box('footer', 'footer', 0, 0, 188, 10)], 0, 10) }), 'header 0');
});

test('الحرّ: كل حدٍّ يُرفض 400 برسالته العربية في الحفظ', () => {
  const I = PRINT_ISSUES;
  for (const logoMm of [5.9, 121, NaN, Infinity, -Infinity]) rejects(withLayoutOf(pagep(), { logoMm }), I.layoutLogoMm, `logoMm ${logoMm}`);
  rejects(withLayoutOf(pagep(), { logoAfter: 'qr' }), I.layoutLogoAfter, 'logoAfter qr on page');
  rejects(withLayoutOf(pagep(), { logoAfter: 'parties' }), I.layoutLogoAfter, 'logoAfter parties on standard');
  rejects(withLayoutOf(pagep(), { logoAfter: 'magazine' as never }), I.layoutLogoAfter, 'logoAfter unknown');
  rejects(withLayoutOf(pagep(), { sections: { parties: { align: 'center' } } }), I.layoutSectionUnknown, 'section parties on standard');
  rejects(withLayoutOf(pagep(), { sections: { qr: { align: 'center' } } }), I.layoutSectionUnknown, 'section qr on page');
  rejects(withLayoutOf(pagep(), { sections: { zz: { align: 'center' } } as never }), I.layoutSectionUnknown, 'section zz');
  for (const s of [{ fontPct: 69 }, { fontPct: 161 }, { spaceBeforeMm: -0.5 }, { spaceAfterMm: 30.5 }, { fontPct: NaN }]) {
    rejects(withLayoutOf(pagep(), { sections: { info: s } }), I.layoutSectionBounds, JSON.stringify(s));
  }
  rejects(withLayoutOf(pagep(), { sections: { items: { visible: false } } }), I.layoutLockedVisible, 'items hidden');
  rejects(withLayoutOf(rollp(), { sections: { qr: { visible: false } } }), I.layoutLockedVisible, 'roll qr hidden');
  // اللوحتان
  const qr = box('qr', 'footer', 0, 0, 47, 47);
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([qr]) }, 'grid_bilingual'), I.layoutCanvasPrinter, 'grid');
  rejects(withLayoutOf(rollp(), { canvas: canvasOf([]) }), I.layoutCanvasPrinter, 'thermal');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([], 150, 51) }), I.layoutCanvasBands, 'sum 201');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([], 151, 0) }), I.layoutCanvasBands, 'header 151');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([], 0, 121) }), I.layoutCanvasBands, 'footer 121');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([], -1, 10) }), I.layoutCanvasBands, 'header -1');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('logo', 'header', -0.5, 0, 20, 20)]) }), I.layoutCanvasBox, 'x<0');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('logo', 'header', 0, -1, 20, 20)]) }), I.layoutCanvasBox, 'y<0');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('logo', 'header', 170, 0, 18.5, 20)]) }), I.layoutCanvasBox, 'x+w>188 page');
  rejects(withLayoutOf(impactp(), { canvas: canvasOf([box('logo', 'header', 190, 0, 11.5, 20)]) }), I.layoutCanvasBox, 'x+w>201 impact');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('logo', 'header', 0, 50, 20, 10.5)]) }), I.layoutCanvasBox, 'y+h>band');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('logo', 'header', 0, 0, 4.5, 20)]) }), I.layoutCanvasBox, 'w<5');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('logo', 'header', 0, 0, 20, 4.5)]) }), I.layoutCanvasBox, 'h<5');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('logo', 'header', 0, 0, 20, 20), box('logo', 'footer', 0, 0, 20, 20)]) }), I.layoutCanvasBox, 'duplicate');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('footer', 'footer', 0, 0, 20, 20)], 60, 0) }), I.layoutCanvasBox, 'band 0');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([{ ...box('company', 'header', 0, 0, 20, 20), fontPct: 200 }]) }), I.layoutCanvasBox, 'box font');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('logo', 'header', NaN, 0, 20, 20)]) }), I.layoutCanvasBox, 'NaN');
  const ten = [...CANVAS_BOX_IDS, 'logo' as const].map((id, i) => box(id, 'footer', 0, i * 6, 10, 5));
  rejects(withLayoutOf(pagep(), { canvas: canvasOf(ten, 0, 120) }), I.layoutCanvasBox, '10 boxes');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('totals', 'header', 0, 0, 50, 20)]) }), I.layoutCanvasFooterOnly, 'totals header');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('signatures', 'header', 0, 0, 50, 20)]) }), I.layoutCanvasFooterOnly, 'signatures header');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('qr', 'footer', 0, 0, 46, 60)]) }), I.layoutCanvasQr, 'qr 46 w');
  rejects(withLayoutOf(pagep(), { canvas: canvasOf([box('qr', 'footer', 0, 0, 60, 46.5)]) }), I.layoutCanvasQr, 'qr 46.5 h');
});

test('الحرّ: مفتاحٌ مجهول في أي مستوى جديد ⇒ 400 «حقل غير معروف» (الصارم)', () => {
  for (const mut of [
    (l: Record<string, any>) => { l.sections = { items: { hidden: true } }; },
    (l: Record<string, any>) => { l.canvas = { ...canvasOf([]), grid: 2 }; },
    (l: Record<string, any>) => { l.canvas = canvasOf([{ ...box('logo', 'header', 0, 0, 20, 20), rotate: 90 } as never]); },
  ]) {
    const p = clone(withLayoutOf(pagep())) as unknown as { options: { layout: Record<string, any> } };
    mut(p.options.layout);
    const r = firstMsg(p as unknown as PrintProfile);
    assert.deepEqual([r.status, r.message], [400, PRINT_ISSUES.unknownKey], JSON.stringify(p.options.layout));
  }
});

test('الحرّ: القراءة المتسامحة تُسقط المفتاح المعيب وحده وتُبقي الستة وبقية المفاتيح', () => {
  const good = withLayoutOf(pagep(), { logo: 'end', logoMm: 30, logoAfter: 'info', sections: { totals: { fontPct: 120 } }, canvas: canvasOf([box('qr', 'footer', 0, 0, 47, 47)]) });
  const readBack = (mut: (l: Record<string, any>) => void): PrintLayout | undefined => {
    const raw = clone(fleetWith(good)) as unknown as { profiles: Array<{ options: { layout: Record<string, any> } }> };
    mut(raw.profiles[3].options.layout);
    assert.equal(checkPrintSettings(raw, true).ok, false, 'الحفظ يرفضه');
    const read = storedPrintSettings(raw);
    assert.equal(read.stored, true);
    assert.equal(read.settings.profiles.length, 4);
    return read.settings.profiles[3].options.layout;
  };
  const cases: Array<[string, (l: Record<string, any>) => void, string]> = [
    ['logoMm', (l) => { l.logoMm = 500; }, 'logoMm'],
    ['logoMm type', (l) => { l.logoMm = 'big'; }, 'logoMm'],
    ['logoAfter', (l) => { l.logoAfter = 'qr'; }, 'logoAfter'],
    ['logoAfter future', (l) => { l.logoAfter = 'watermark'; }, 'logoAfter'],
    ['canvas future enum', (l) => { l.canvas.boxes[0].id = 'freeText'; }, 'canvas'],
    ['canvas bounds', (l) => { l.canvas.headerMm = 199; }, 'canvas'],
    ['canvas qr small', (l) => { l.canvas.boxes[0].w = 20; }, 'canvas'],
  ];
  for (const [label, mut, dropped] of cases) {
    const l = readBack(mut);
    assert.ok(l, label);
    assert.ok(!(dropped in l!), `${label}: ${dropped} يسقط`);
    assert.equal(l!.logo, 'end', label);
    for (const k of ['logoMm', 'logoAfter', 'sections', 'canvas'].filter((k) => k !== dropped)) assert.ok(k in l!, `${label}: ${k} يبقى`);
  }
  // القسم المعيب وحده يسقط، وإخفاء الأصناف يُمحى بصمت ويبقى باقي تنسيقها
  const l2 = readBack((l) => { l.sections = { info: { fontPct: 500 }, items: { visible: false, fontPct: 90 }, totals: { fontPct: 120 } }; });
  assert.deepEqual(l2!.sections, { items: { fontPct: 90 }, totals: { fontPct: 120 } });
  const l3 = readBack((l) => { l.sections = { items: { visible: false } }; });
  assert.ok(l3 && !('sections' in l3), 'تنسيقٌ لم يبقَ منه شيء يسقط');
  // قسمٌ من نسخةٍ أحدث (مجهول) يسقط وحده
  const l4 = readBack((l) => { l.sections = { totals: { fontPct: 120 }, stamp: { align: 'center' } }; });
  assert.deepEqual(l4!.sections, { totals: { fontPct: 120 } });
  // قيمة تنسيقٍ مجهولة تُسقط تنسيق ذلك القسم وحده
  const l5 = readBack((l) => { l.sections = { totals: { fontPct: 120 }, info: { align: 'justify' } }; });
  assert.deepEqual(l5!.sections, { totals: { fontPct: 120 } });
  // عطبٌ في الستة يُسقط التخطيط كله كاليوم
  const raw = clone(fleetWith(good));
  raw.profiles[3].options.layout!.accent = '#FFFFFF';
  assert.ok(!('layout' in storedPrintSettings(raw).settings.profiles[3].options));
  // تغيير التصميم في نسخةٍ أحدث: اللوحتان على ثنائي اللغة تسقطان وحدهما
  const grid = clone(fleetWith(good)) as unknown as { profiles: Array<{ options: { layout: Record<string, any> } }> };
  grid.profiles[3].options.layout.design = 'grid_bilingual';
  grid.profiles[3].options.layout.order = [...sectionsFor('page', 'grid_bilingual')];
  const lg = storedPrintSettings(grid).settings.profiles[3].options.layout!;
  assert.equal(lg.design, 'grid_bilingual');
  assert.ok(!('canvas' in lg) && lg.logoMm === 30 && lg.logoAfter === 'info');
});

test('الحرّ: الصورة القانونية — مم بخطوة 0.5 وخطٌّ صحيح، وترتيب مفاتيح ثابت، والفارغ يسقط، والستة كما هي', () => {
  const p = withLayoutOf(pagep(), {
    canvas: { footerMm: 79.8, headerMm: 60.26, boxes: [box('footer', 'footer', 0.24, 70.3, 188, 9.7), { ...box('qr', 'footer', 0, 0, 47.2, 47.2), fontPct: 99.6, align: 'center' }, box('logo', 'header', 1.1, 0, 30, 30)] },
    sections: { footer: { spaceAfterMm: 2.3, visible: true }, header: { fontPct: 110.4, align: 'end' }, info: {} },
    logoAfter: 'top',
    logoMm: 33.3,
  });
  const r = checkPrintSettings(fleetWith(p), true);
  assert.ok(r.ok, JSON.stringify(r));
  const l = r.value.profiles[3].options.layout!;
  assert.deepEqual(Object.keys(l), ['design', 'logo', 'logoSize', 'accent', 'tableStyle', 'order', 'logoMm', 'logoAfter', 'sections', 'canvas']);
  assert.equal(l.logoMm, 33.5);
  assert.deepEqual(Object.keys(l.sections!), ['header', 'footer'], 'ترتيب التصميم، والفارغ يسقط');
  assert.deepEqual(l.sections!.header, { align: 'end', fontPct: 110 });
  assert.deepEqual(Object.keys(l.sections!.footer!), ['visible', 'spaceAfterMm']);
  assert.equal(l.sections!.footer!.spaceAfterMm, 2.5);
  assert.deepEqual(l.canvas, {
    headerMm: 60.5, footerMm: 80,
    boxes: [box('logo', 'header', 1, 0, 30, 30), { ...box('qr', 'footer', 0, 0, 47, 47), align: 'center', fontPct: 100 }, box('footer', 'footer', 0, 70.5, 188, 9.5)],
  });
  assert.equal(JSON.stringify(canonicalPrintSettings(r.value)), JSON.stringify(r.value), 'متساوي القوى');
  // تنسيقاتٌ فارغة كلها ⇒ لا مفتاح sections
  const empty = checkPrintSettings(fleetWith(withLayoutOf(pagep(), { sections: { info: {}, totals: {} } })), true);
  assert.ok(empty.ok && !('sections' in empty.value.profiles[3].options.layout!));
  // تخطيط الستة يُحفظ كما هو بلا أيّ مفتاح حرّ
  const six = checkPrintSettings(fleetWith(withLayoutOf(pagep(), { logo: 'end' })), true);
  assert.ok(six.ok);
  if (six.ok) assert.deepEqual(Object.keys(six.value.profiles[3].options.layout!), ['design', 'logo', 'logoSize', 'accent', 'tableStyle', 'order']);
  // بلا مفتاح undefined في أي مكان
  assert.ok(!JSON.stringify(r.value).includes('undefined'));
  for (const v of Object.values(l.sections!)) for (const x of Object.values(v!)) assert.notEqual(x, undefined);
});

test('الحرّ: الحجم — اثنا عشر تصميماً حرّاً بأسوأ حالاتها تحت 48 كيلوبايت، وما فوقه 413', () => {
  const full = legacyPrintSettings();
  const style = { visible: true, align: 'center' as const, fontPct: 155, spaceBeforeMm: 29.5, spaceAfterMm: 29.5 };
  for (let i = 0; full.profiles.length < 12; i++) {
    const p = withLayoutOf(profile({ id: `long-name-${i}`, name: `${i}`.padEnd(40, 'ق'), printer: 'impact', template: 'impact_plain' }, 'ff_a4'), {
      accent: '#1D4ED8', logoMm: 119.5, logoAfter: 'installments',
      sections: Object.fromEntries(sectionsFor('impact', 'standard').map((id) => [id, LOCKED_VISIBLE.includes(id) ? { ...style, visible: true } : style])),
      // تسعة مربعات في التذييل: QR يساراً بحدّه الأدنى، والبقية عموداً يميناً حتى حافة النقطية 201
      canvas: canvasOf(CANVAS_BOX_IDS.map((id, k) => ({
        ...(id === 'qr' ? box(id, 'footer', 0, 0, 47, 47) : box(id, 'footer', 100.5, k * 13, 100.5, 12.5)), align: 'center' as const, fontPct: 155,
      })), 80, 120),
    });
    p.options.footerText = 'ذ'.repeat(160);
    full.profiles.push(p);
  }
  const bytes = printSettingsBytes(full);
  const r = parsePrintSettings(full);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues.slice(0, 3)));
  assert.ok(bytes < PRINT_LIMITS.maxBytes, `${bytes}`);
  assert.ok(bytes > 16 * 1024, `${bytes} — الحدّ القديم ما كان يتّسع`);
  const big = parsePrintSettings({ ...fleet(), pad: 'x'.repeat(PRINT_LIMITS.maxBytes) });
  assert.ok(!big.ok && big.status === 413 && big.message === PRINT_ISSUES.tooLarge);
});

test('الحرّ: كل رسائل القواعد الجديدة مبلوغة ومن المصدر الواحد', () => {
  const free = ['layoutLogoMm', 'layoutLogoAfter', 'layoutSectionUnknown', 'layoutSectionBounds', 'layoutLockedVisible', 'layoutCanvasPrinter', 'layoutCanvasBands', 'layoutCanvasBox', 'layoutCanvasFooterOnly', 'layoutCanvasQr'] as const;
  for (const k of free) assert.equal(typeof PRINT_ISSUES[k], 'string', k);
  assert.equal(PRINT_ISSUES.layoutRoll, 'في الرول: التصميم القياسي وحده');
  assert.ok(SECTION_IDS.length === 11);
});
