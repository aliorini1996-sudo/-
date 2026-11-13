// الطباعة المباشرة بالبلوتوث («إعدادات الطباعة» M3، التصميم §3.3): أيّ قالبٍ يُرسل (لا الكلاسيكي ولا العادية)، وطريقة الجهاز
// (نظام الطباعة افتراضاً)، والمُرمِّز لكل طابعة بهامشها وإزاحتها وطول صفحتها وقصّها، وخانة الرمز الأكبر للنقطية.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { directAvailableFor, directHintFor, encodeForProfile, formRasterPages, impactLeftDots, send, supportsDirect, transportFor } from './printDirect';
import { decodeBridgePayload, encodeBridgePayload } from '../lib/print/transport/bridgePayload';
import { MAX_PAYLOAD_CHARS } from '../lib/print/transport/bridgeContract';
import { TSPL_CANCEL } from '../lib/print/tspl';
import { DEFAULT_PRINT_LOOK, impactQrSlotPx, lookFor, qrSlotStyle } from './printLook';
import {
  STAMPED_QR_CELLS, defaultPrintOptions, dotsPerMm, formReachX, geometry, legacyPageProfile, legacyThermalProfile, presetPaper,
  type PaperPresetId, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import { PAGE_CUT_SEARCH_MM, createBitmap, fillRect, formSheetRaster, paginate, type RasterPage } from '../lib/print/raster';
import { ESCPOS_CANCEL } from '../lib/print/escpos';
import { ESCP24_CANCEL, ESCP24_CANCEL_CONTINUOUS, encodeEscP24 } from '../lib/print/escp24';
import { dummyQrValue } from '../lib/print/calibration';

const profile = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, patch?: Partial<PrintProfile['options']>): PrintProfile => ({
  id: 'p-1', name: 'p', printer, template, paper: presetPaper(preset)!, options: { ...defaultPrintOptions(printer), ...patch },
});
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const page = (w: number, h: number): RasterPage => { const b = createBitmap(w, h); fillRect(b, 0, 0, 8, 24, true); return { bitmap: b, qrRows: [] }; };

test('ما يُرسل بالبلوتوث: حرارية بقالبٍ جديد ونقطية — لا الشريط الكلاسيكي ولا الطابعة العادية', () => {
  assert.equal(supportsDirect(legacyThermalProfile()), false, 'الكلاسيكي مجمَّدٌ على نظام الطباعة');
  assert.equal(supportsDirect(legacyPageProfile()), false);
  assert.equal(supportsDirect(null), false);
  assert.equal(supportsDirect(profile('thermal', 'roll_compact', 'roll58')), true);
  assert.equal(supportsDirect(profile('impact', 'impact_preprinted', 'ff_a4')), true);
});

test('طريقة الجهاز: نظام الطباعة افتراضاً، والبلوتوث باختياره ودعم المتصفح والقالب معاً', () => {
  const imp = profile('impact', 'impact_plain', 'ff_a4');
  assert.equal(transportFor(imp, null, true), 'system');
  assert.equal(transportFor(imp, { transport: 'bt-serial' }, true), 'bt-serial');
  assert.equal(transportFor(imp, { transport: 'bt-serial' }, false), 'system', 'Samsung Internet أو Chrome قديم');
  assert.equal(transportFor(legacyThermalProfile(), { transport: 'bt-serial' }, true), 'system');
  assert.equal(transportFor(legacyPageProfile(), { transport: 'bt-serial' }, true), 'system');
});

test('MIP480 على A4 متصل: ESC/P بطول 297 مم، والهامش العلوي 5 مم = 35 نقطة، والإزاحة بمضاعف 3 — وإلغاء المتصل ESC U 0 ثم FF', () => {
  const p = profile('impact', 'impact_plain', 'ff_a4');
  p.paper.printableDots = 1424;
  p.paper.offsetXmm = 2; // 2 × 7.087 = 14 نقطة ⇒ 15 (1424 + 15 داخل السطر)
  const { job, cancel } = encodeForProfile(p, [[page(1424, 24)]]);
  const s = hex(job.bytes);
  assert.ok(s.startsWith('1b 40 1b 28 55 01 00 0a 1b 28 43 02 00 71 10 1b 28 55 01 00 3c 1b 4a 23 1b 24 05 00 1b 2a 27 08 00'), s.slice(0, 120));
  assert.ok(s.endsWith('0c'));
  assert.deepEqual(cancel, ESCP24_CANCEL_CONTINUOUS, 'لا ESC @ يمحو طول الصفحة على الورق المتصل');
  // المسودة من خيار القالب، والورق المقطع بلا طول صفحة وإلغاؤه ESC @ ثم FF
  const cut = profile('impact', 'impact_plain', 'cut_a4', { graphicsQuality: 'draft' });
  const enc = encodeForProfile(cut, [[page(1440, 24)]]);
  assert.ok(hex(enc.job.bytes).startsWith('1b 40 1b 4a 39 1b 24 00 00 1b 2a 21'), hex(enc.job.bytes).slice(0, 60));
  assert.deepEqual(enc.cancel, ESCP24_CANCEL);
});

test('إزاحة النقطية مقصورةٌ على ما يتركه عرض الصورة من سطر 1440 — فلا يُدفع حبرٌ وراءه (اسم البائع أو طرف الرمز)', () => {
  assert.equal(impactLeftDots(14, 1424), 14, 'يتسع: 14 ⇒ 15 في المُرمِّز ≤ 16');
  assert.equal(impactLeftDots(14, 1426), 12, 'التقريب لـ15 يتجاوز 14 الباقية ⇒ مضاعف 3 الأدنى');
  assert.equal(impactLeftDots(14, 1440), 0, 'حزمةٌ بعرض السطر كله: لا إزاحة');
  assert.equal(impactLeftDots(106, 1300), 106, '15 مم على 1300 نقطة تتسع');
  assert.equal(impactLeftDots(-5, 1000), 0);
  // قالبٌ بحزمة 1440 وإزاحةٍ موجبة (محفوظٌ قبل الحارس أو مُعدَّلٌ يدوياً): يُطبع كاملاً من الهامش لا يُقصّ ولا يُرفض
  const full = profile('impact', 'impact_plain', 'ff_a4');
  full.paper.offsetXmm = 15;
  const edge = createBitmap(1440, 24);
  fillRect(edge, 1430, 0, 10, 24, true);
  const s = hex(encodeForProfile(full, [[{ bitmap: edge, qrRows: [] }]]).job.bytes);
  assert.ok(s.includes('1b 24 dc 01 1b 2a 27 0c 00'), 'آخر عمودٍ عند 1439 كما هو');
});

test('الحرارية: الرول بلا هامشٍ من المُرمِّز (حشوة القالب) وقصٌّ إن طُلب، والورق المقطع A4 بهامشه وتكملةٍ لطول الورقة', () => {
  const roll = profile('thermal', 'roll_compact', 'roll80', { cutAfter: true });
  const r = encodeForProfile(roll, [[page(576, 24)]]);
  const s = hex(r.job.bytes);
  assert.ok(s.startsWith('1b 40 1d 76 30 00 48 00 18 00'), 'عرض 576 = 72 بايتاً');
  assert.ok(s.endsWith('1d 56 42 00'));
  assert.deepEqual(r.cancel, ESCPOS_CANCEL);
  // الإزاحة الموجبة أعمدةٌ بيضاء يساراً حتى عرض الورق (80 مم = 640 نقطة)
  const shifted = profile('thermal', 'roll_compact', 'roll80');
  shifted.paper.offsetXmm = 4;
  assert.ok(hex(encodeForProfile(shifted, [[page(576, 24)]]).job.bytes).startsWith('1b 40 1d 76 30 00 4c 00'), '576 + 32 = 608 نقطة = 76 بايتاً');
  shifted.paper.offsetXmm = -4;
  assert.ok(hex(encodeForProfile(shifted, [[page(576, 24)]]).job.bytes).startsWith('1b 40 1d 76 30 00 48 00'), 'لا يسار قبل أوّل نقطة');
  // A4 حراري: هامش 5 مم = 40 نقطة، والورقة 297 × 8 = 2376
  const a4 = profile('thermal', 'roll_detailed', 'roll_a4');
  const a = hex(encodeForProfile(a4, [[page(1664, 24)]]).job.bytes);
  assert.ok(a.startsWith('1b 40 1b 4a 28 1d 76 30 00 d0 00 18 00'));
  const fill = 2376 - 40 - 24;
  assert.ok(a.endsWith(`1b 4a ff ${'1b 4a ff '.repeat(Math.floor(fill / 255) - 1)}1b 4a ${(fill % 255).toString(16).padStart(2, '0')}`));
});

test('خانة رمز QR الأكبر للنقطية وحدها: (93 + 4) × 5 + 2 نقطة ⇒ 269 بكسل قالب — والافتراضي والعادية بلا خانة', () => {
  const imp = profile('impact', 'impact_plain', 'ff_a4');
  assert.equal(impactQrSlotPx(imp), Math.ceil((((STAMPED_QR_CELLS.max + 4) * 5 + 2) * 794) / 1440));
  assert.equal(lookFor(imp).qrSlotPx, 269);
  assert.equal(lookFor(profile('impact', 'impact_plain', 'ff_a4', { qrSize: 'large' })).qrSlotPx, Math.ceil((((93 + 4) * 6 + 2) * 794) / 1440));
  assert.equal(lookFor(legacyPageProfile()).qrSlotPx, null);
  assert.equal(lookFor(profile('page', 'page_plain', 'a5')).qrSlotPx, null);
  assert.equal(DEFAULT_PRINT_LOOK.qrSlotPx, null);
  assert.deepEqual(qrSlotStyle(DEFAULT_PRINT_LOOK), {}, 'صندوق اليوم كما هو');
  assert.deepEqual(qrSlotStyle(lookFor(imp)), { width: 269, height: 269, padding: 0, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center' });
});

// ─── تطبيق فيلد سيلز على الآيفون ───

test('directAvailableFor: النقطية لا تُرسل من تطبيق الآيفون — والحرارية تُرسل، وserial/app كما هما، وnone لا شيء', () => {
  const imp = profile('impact', 'impact_plain', 'ff_a4');
  const th = profile('thermal', 'roll_compact', 'roll80');
  assert.equal(directAvailableFor(imp, 'ios-app'), false, 'MIP480 بلوتوث كلاسيكيّ بلا BLE');
  assert.equal(directAvailableFor(th, 'ios-app'), true);
  assert.equal(directAvailableFor(legacyPageProfile(), 'ios-app'), true, 'supportsDirect يحكم بعدها');
  for (const path of ['serial', 'app'] as const) {
    assert.equal(directAvailableFor(imp, path), true, path);
    assert.equal(directAvailableFor(th, path), true, path);
  }
  assert.equal(directAvailableFor(imp, 'none'), false);
  assert.equal(directAvailableFor(th, 'none'), false);
  assert.equal(directAvailableFor(null, 'ios-app'), true);
  // اختيار البلوتوث للنقطية على الآيفون ⇒ نظام الطباعة؛ والحرارية بلوتوث
  assert.equal(transportFor(imp, { transport: 'bt-serial' }, directAvailableFor(imp, 'ios-app')), 'system');
  assert.equal(transportFor(th, { transport: 'bt-serial' }, directAvailableFor(th, 'ios-app')), 'bt-serial');
  // الافتراضيّ في Node (لا طريق) = نظام الطباعة كاليوم
  assert.equal(directAvailableFor(th), false);
  assert.equal(transportFor(th, { transport: 'bt-serial' }), 'system');
});

test('directHintFor: النقطية على الآيفون impactIos (التطبيق وسفاري) — وغيرها تلميح الجهاز', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
  const imp = profile('impact', 'impact_plain', 'ff_a4');
  const th = profile('thermal', 'roll_compact', 'roll80');
  const app = { ua: `${IPHONE} FieldSales`, maxTouchPoints: 5, hasSerial: false, iosBridge: 1, iosWrapper: true };
  const safari = { ua: IPHONE, maxTouchPoints: 5, hasSerial: false };
  assert.equal(directHintFor(imp, app), 'impactIos');
  assert.equal(directHintFor(imp, safari), 'impactIos');
  assert.equal(directHintFor(th, app), 'ready');
  assert.equal(directHintFor(th, safari), 'soon');
  // بوّابة أندرويد صريحةً (أيّاً كان APP_BRIDGE_FOR_ALL): مغلقة ⇒ soon، وبعلامة الجسر أو مفتوحة ⇒ ready
  const samsung = { ua: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36', hasSerial: false, bridgeForAll: false };
  assert.equal(directHintFor(imp, samsung), 'soon');
  assert.equal(directHintFor(imp, { ...samsung, bridgeFlag: true }), 'ready');
  assert.equal(directHintFor(imp, { ...samsung, bridgeForAll: true }), 'ready');
  assert.equal(directHintFor(imp, { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', hasSerial: false }), 'browser');
});

/** نافذة تطبيق الآيفون المزيّفة لـsend(): المعالج يلتقط الرسالة ويجيب done */
async function withIosWindow<T>(run: (posted: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const saved = Object.getOwnPropertyDescriptor(g, 'window');
  const posted: Array<Record<string, unknown>> = [];
  const w = {
    webkit: { messageHandlers: { fsPrint: { postMessage(msg: Record<string, unknown>) { posted.push(msg); return Promise.resolve({ ok: true, outcome: 'done' }); } } } },
    __fsIosBridge: { v: 1, caps: ['print', 'pick', 'cancel', 'systemPrint'] },
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(g, 'window', { value: w, configurable: true, writable: true });
  try { return await run(posted); } finally { if (saved) Object.defineProperty(g, 'window', saved); else delete g.window; }
}

test('send() بطابعة الآيفون ⇒ sendViaIos: البايتات والعلامات والإلغاء ونوع الطابعة والرابط البطيء والوسم كما رمّزها encodeForProfile', async () => {
  const th = profile('thermal', 'roll_compact', 'roll80');
  const copies = [[page(576, 48)]];
  await withIosWindow(async (posted) => {
    const outcome = await send({ via: 'fs-ios', name: 'RPP04' }, th, copies, { pageLabel: () => '', slow: true, lang: 'tspl', docLabel: 'فاتورة INV-9' });
    assert.equal(outcome, 'done');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].op, 'print');
    const d = await decodeBridgePayload(posted[0].payload as string);
    const want = encodeForProfile(th, copies, { lang: 'tspl' });
    assert.equal(want.kind, 'tspl');
    assert.equal(d.kind, 'tspl');
    assert.deepEqual(d.bytes, want.job.bytes);
    assert.deepEqual(d.marks, want.job.marks);
    assert.deepEqual(d.cancel, [...TSPL_CANCEL]);
    assert.equal(d.slow, true);
    assert.equal(d.label, 'فاتورة INV-9');
  });
  // ESC/POS بلا وسمٍ ولا بطء
  await withIosWindow(async (posted) => {
    assert.equal(await send({ via: 'fs-ios', name: null }, th, copies, { pageLabel: () => '' }), 'done');
    const d = await decodeBridgePayload(posted[0].payload as string);
    assert.equal(d.kind, 'escpos');
    assert.deepEqual(d.cancel, [...ESCPOS_CANCEL]);
    assert.equal(d.slow, false);
    assert.equal(d.label, '');
  });
});

/** صفحة تطبيق الآيفون بجسره (وكيلٌ وعلامةٌ ومعالج) — للقيم الافتراضية التي تقرأ الجهاز (directPath) */
async function withIosAppPage<T>(run: () => Promise<T> | T): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const keys = ['navigator', 'window'] as const;
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  const nav = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1 FieldSales', maxTouchPoints: 5 };
  const win = {
    webkit: { messageHandlers: { fsPrint: { postMessage: () => Promise.resolve({ ok: true, outcome: 'done' }) } } },
    __fsIosBridge: { v: 1, caps: ['print', 'pick', 'cancel', 'systemPrint'] },
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(g, 'navigator', { value: nav, configurable: true, writable: true });
  Object.defineProperty(g, 'window', { value: win, configurable: true, writable: true });
  try { return await run(); } finally { for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k]; } }
}

test('القيم الافتراضية في تطبيق الآيفون (ما تستعمله RepDocuments): البلوتوث للحرارية، والنقطية إلى نظام الطباعة', async () => {
  const imp = profile('impact', 'impact_plain', 'ff_a4');
  const th = profile('thermal', 'roll_compact', 'roll80');
  await withIosAppPage(() => {
    assert.equal(directAvailableFor(imp), false, 'النقطية لا تُرسل من الآيفون');
    assert.equal(directAvailableFor(th), true);
    // transportFor بلا وسيطٍ ثالث = directAvailableFor(القالب) — RepDocuments يناديها هكذا
    assert.equal(transportFor(imp, { transport: 'bt-serial' }), 'system');
    assert.equal(transportFor(th, { transport: 'bt-serial' }), 'bt-serial');
    assert.equal(transportFor(th, { transport: 'system' }), 'system');
  });
});

// ─── «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦، pd_spec E.7): لوحة A4 على MIP480 لا تُقطع، وسطر الطباعة 1440 ───

test('التحرير الحرّ — النقطية: لوحة تذييلٍ بإطار عابرةٌ لحدّ الصفحة تنتقل كاملةً للصفحة التالية، والسطر 1440 نقطة', () => {
  const p = profile('impact', 'impact_plain', 'cut_a4');
  const g = geometry(p);
  const per = g.rowsPerPage as number;
  assert.ok(per > 1000 && p.paper.printableDots === 1440);
  const H = Math.round(per * 1.7);
  const top = per - 200;
  const bottom = per + 300;
  const bm = createBitmap(1440, H);
  for (let y = 0; y < top; y++) if (y % 30 !== 29) fillRect(bm, 100, y, 1200, 1, true); // أسطرٌ بفراغاتٍ بينها
  fillRect(bm, 0, top, 1440, 2, true); fillRect(bm, 0, bottom - 2, 1440, 2, true);    // إطار اللوحة: لا صفّ أبيض داخلها
  fillRect(bm, 0, top, 2, bottom - top, true); fillRect(bm, 1438, top, 2, bottom - top, true);
  const search = Math.round(PAGE_CUT_SEARCH_MM * dotsPerMm(180));
  const plain = paginate(bm, [], per, search);
  assert.equal(plain[0].bitmap.height, per, 'بلا مدى: قطعٌ صلب داخل الإطار (اليوم)');
  const kept = paginate(bm, [], per, search, undefined, [[top, bottom]]);
  assert.equal(kept[0].bitmap.height, top, 'القصّ عند أعلى اللوحة');
  assert.equal(kept[1].bitmap.height, bottom - top, 'اللوحة كاملةً في الصفحة الثانية');
  assert.ok(kept.every((pg) => pg.bitmap.width === 1440));
  const { job, kind } = encodeForProfile(p, [kept]);
  assert.equal(kind, 'escp24');
  assert.ok(job.bytes.length > 0, 'سطر 1440 بلا حبرٍ وراءه');
});

// ─── «نموذج الشركة المطبوع مسبقاً» على النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦): مهمة النموذج بلا هامشٍ ولا إزاحة وأشرطةٌ مقسّمة ───

/** صفحة نموذج (بعرض الحزمة) بحبرٍ في الصفّ 0 عند العمود 0 وعند العمود 900 */
const formPage = (h = 48, w = 1440): RasterPage => { const b = createBitmap(w, h); fillRect(b, 0, 0, 3, 24, true); fillRect(b, 900, 0, 3, 24, true); return { bitmap: b, qrRows: [] }; };
const countOf = (s: string, needle: string): number => s.split(needle).length - 1;

test('النموذج — encodeForProfile({ form: true }): لا تغذية علوية وESC $ من 0 ولو كان للقالب هامشٌ وإزاحة، وأشرطةٌ مقسّمة على فجواتها', () => {
  const p = profile('impact', 'impact_preprinted', 'ff_a4');
  p.paper.offsetXmm = 2;
  p.paper.marginTopMm = 5;
  p.paper.printableDots = 1424; // صورةٌ أضيق من السطر: الإزاحة 2 مم (14 ⇒ 15 نقطة) تتسع لها بلا الخيار
  const narrow = (): RasterPage => formPage(48, 1424);
  const form = hex(encodeForProfile(p, [[narrow()]], {}, { form: true }).job.bytes);
  const HEAD = '1b 40 1b 28 55 01 00 0a 1b 28 43 02 00 71 10 1b 28 55 01 00 3c';
  assert.ok(form.startsWith(`${HEAD} 1b 24 00 00 1b 2a 27 03 00`), form.slice(0, 120));
  assert.ok(form.includes(' 1b 24 2c 01 1b 2a 27 03 00 '), 'المقطع الثاني عند 900 ⇒ ESC $ 300 (بلا أعمدةٍ بيضاء بينهما)');
  // والمهمة نفسها بلا الخيار كما كانت: تغذية 5 مم = 35 نقطة وإزاحة 15 نقطة وشريطٌ واحد
  const plain = hex(encodeForProfile(p, [[narrow()]]).job.bytes);
  assert.ok(plain.startsWith(`${HEAD} 1b 4a 23 1b 24 05 00 1b 2a 27 87 03`), plain.slice(0, 120));
  assert.deepEqual(encodeForProfile(p, [[narrow()]], {}, {}).job.bytes, encodeForProfile(p, [[narrow()]]).job.bytes, 'خياراتٌ فارغة = اليوم');
});

test('النموذج — الورق المتصل: ESC ( C بطول الورقة (279.4 مم = 3960)، وFF لكل ورقة، والنسخ تكرّر الأوراق كلها — والمقطع بلا طول وإلغاؤه ESC @ ثم FF', () => {
  const p = profile('impact', 'impact_preprinted', 'ff_95x11');
  const sheets = [formPage(), formPage(72)];
  const one = encodeForProfile(p, [sheets], {}, { form: true });
  const two = encodeForProfile(p, [sheets, sheets], {}, { form: true });
  const s1 = hex(one.job.bytes);
  assert.ok(s1.startsWith('1b 40 1b 28 55 01 00 0a 1b 28 43 02 00 78 0f 1b 28 55 01 00 3c 1b 24 00 00'));
  assert.equal(countOf(s1, ' 0c'), 2, 'FF لكل ورقة');
  assert.ok(s1.endsWith('0c'));
  assert.deepEqual(one.cancel, ESCP24_CANCEL_CONTINUOUS);
  const head = 21; // ESC @ + أوامر طول الصفحة
  const body = one.job.bytes.subarray(head);
  assert.equal(two.job.bytes.length, head + 2 * body.length, 'النسخة الثانية تكرارٌ حرفيّ للأولى');
  assert.deepEqual(two.job.bytes.subarray(head + body.length), body);
  const cut = encodeForProfile(profile('impact', 'impact_preprinted', 'cut_a4'), [sheets], {}, { form: true });
  assert.ok(hex(cut.job.bytes).startsWith('1b 40 1b 24 00 00'), 'المقطع: لا طول صفحة ولا هامش');
  assert.deepEqual(cut.cancel, ESCP24_CANCEL);
});

test('النموذج — الخيار للنقطية وحدها: على الحرارية أو العادية خطأٌ برمجيّ لا طباعة', () => {
  assert.throws(() => encodeForProfile(profile('thermal', 'roll_compact', 'roll80'), [[page(576, 24)]], {}, { form: true }), /non-impact/);
  assert.throws(() => encodeForProfile(legacyPageProfile(), [[page(576, 24)]], {}, { form: true }), /non-impact/);
});

test('النموذج — send(…, { form: true }) يمرّر الخيار إلى المُرمِّز (الحمولة كما رمّزها encodeForProfile بالخيار)', async () => {
  const p = profile('impact', 'impact_preprinted', 'ff_a4');
  p.paper.marginTopMm = 5;
  const copies = [[formPage()]];
  await withIosWindow(async (posted) => {
    assert.equal(await send({ via: 'fs-ios', name: null }, p, copies, { pageLabel: () => '' }, { form: true }), 'done');
    assert.equal(await send({ via: 'fs-ios', name: null }, p, copies, { pageLabel: () => '' }), 'done');
    const [form, plain] = await Promise.all(posted.map((m) => decodeBridgePayload(m.payload as string)));
    assert.equal(form.kind, 'escp24');
    assert.deepEqual(form.bytes, encodeForProfile(p, copies, {}, { form: true }).job.bytes);
    assert.deepEqual(plain.bytes, encodeForProfile(p, copies).job.bytes, 'بلا الخيار كما كان');
    assert.notDeepEqual(form.bytes, plain.bytes);
  });
});

test('النموذج — formRasterPages: للنقطية بحزمةٍ وحدها، وبلا أوراقٍ خطأ، وشريط «نموذج اختبار» من الجذر إلى أوّل الورقة الأولى', async () => {
  const ui = { pageLabel: () => '' };
  const rootOf = (sheets: unknown[], children: unknown[] = []) => ({ querySelectorAll: () => sheets, children }) as unknown as HTMLElement;
  await assert.rejects(formRasterPages(rootOf([]), profile('page', 'page_plain', 'a4'), ui), /impact/);
  await assert.rejects(formRasterPages(rootOf([]), profile('impact', 'impact_preprinted', 'ff_a4'), ui), /no form sheets/);
  // المرساة (formBannerHtml) خارج الأوراق لا يلتقطها التقاط الورقة: تُنقل أوّلها — والإلغاء قبل الالتقاط لا يرسم شيئاً
  const moved: unknown[] = [];
  const first = { firstChild: 'first-child', insertBefore: (n: unknown, ref: unknown) => { moved.push(n, ref); } };
  const banner = { hasAttribute: (a: string) => a === 'data-form-banner' };
  const other = { hasAttribute: () => false };
  const ctrl = new AbortController();
  ctrl.abort();
  const pages = await formRasterPages(rootOf([first, {}], [other, banner]), profile('impact', 'impact_preprinted', 'ff_a4'), { ...ui, signal: ctrl.signal });
  assert.deepEqual(pages, []);
  assert.deepEqual(moved, [banner, 'first-child']);
});

test('النموذج — حرّاس المصدر: printNodeDirect يتفرّع للنقطية بورقة نموذج إلى formRasterPages ومهمة { form: true } — والفرع العام كما هو', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/rep/printDirect.ts'), 'utf8');
  const node = src.slice(src.indexOf('export async function printNodeDirect('));
  const branch = node.indexOf("if (p.printer === 'impact' && isFormSheet(node)) {");
  assert.ok(branch > 0 && branch < node.indexOf('const want = copiesOf((label) => label ?? \'\', p.options.copies, p.options.copyLabels ? labels : null);'));
  assert.ok(node.includes('pages = await formRasterPages(clone, p, ui);'));
  assert.ok(node.includes('return send(port, p, Array.from({ length: n }, () => pages), ui, { form: true });'));
  assert.ok(node.includes('copies.push(await rasterPages(clone, p, ui));'), 'الفرع العام بلا تغيير');
  assert.ok(node.trimEnd().endsWith('return send(port, p, copies, ui);\n}'));
  const html = src.slice(src.indexOf('export async function printFormHtmlDirect('), src.indexOf('export async function printNodeDirect('));
  assert.ok(html.includes('const pages = await formRasterPages(idoc.body, p, ui);') && html.includes('return await send(port, p, [pages], ui, { form: true });'));
  // لا rasterPages ولا paginate في مسار النموذج (لا تصغير ولا ترقيم ولا تخطّي بياض)
  const fr = src.slice(src.indexOf('export async function formRasterPages('), src.indexOf('/**', src.indexOf('export async function formRasterPages(')));
  assert.ok(!/rasterPages\(|paginate\(|textStrip\(/.test(fr));
  assert.ok(fr.includes('captureElement(sheets[i], sheetDots)'));
});

/** مولّدٌ حتميّ (mulberry32) — الصورة نفسها في كل تشغيل */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** «نصٌّ» عريض في صندوقٍ بالمم على ورقةٍ بنقاطها: حروفٌ بعرض 6–14 نقطة بخطوطٍ رأسية وأفقية بسماكة 3 نقاط (11pt عريض ≈ 21 نقطة ارتفاعاً) */
function textBox(b: ReturnType<typeof createBitmap>, r: () => number, s: number, x: number, y: number, w: number, h: number, fill: number): void {
  const top = Math.round((y + h / 2) * s) - 10;
  const x1 = Math.round((x + w) * s) - 4;
  let gx = x1 - Math.round(w * s * fill);
  while (gx < x1) {
    const gw = 6 + Math.floor(r() * 9);
    fillRect(b, gx, top + 16, gw, 3, true);
    for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
      const vh = 8 + Math.floor(r() * 12);
      fillRect(b, gx + Math.floor(r() * (gw - 3)), top + 19 - vh, 3, vh, true);
    }
    if (r() < 0.4) fillRect(b, gx + 2, top + 22, 2, 2, true);
    gx += gw + 2 + (r() < 0.15 ? 8 : 0);
  }
}

/** ميزانية حمولة ورقة نموذجٍ كثيفة على جسر أندرويد (محارف، بعد deflate-raw وbase64) — تقديرٌ يُراجع بالاختبار الميدانيّ (SPEC §5.8، §13) */
const FORM_SHEET_PAYLOAD_BUDGET = 65_536;

test('النموذج — حمولة ورقة A4 كثيفة (رأسٌ و23 صفّاً ورمز 55 مم): التقسيم أصغر، والحمولة المضغوطة لكل ورقة في ميزانيتها (3 أوراق لكل مهمة جسر)', async (t) => {
  const p = profile('impact', 'impact_preprinted', 'ff_a4');
  const dpm = dotsPerMm(180);
  const sheetDots = Math.round(210 * dpm);
  const s = sheetDots / 210;
  const r = rng(13112026);
  const sheet = createBitmap(sheetDots, Math.ceil(296.5 * dpm));
  // الرأس: 20 حقلاً بعرض 50–80 مم
  for (let i = 0; i < 20; i++) textBox(sheet, r, s, i % 2 ? 110 : 20, 30 + Math.floor(i / 2) * 7, 50 + (i % 3) * 15, 6, 0.6 + r() * 0.35);
  // الجدول: 23 صفّاً × 7 أعمدة (70–200 مم) والرمز 55 مم يساره (12، 226)، و4 حقول إجماليات تحت الجدول
  const colsMm: Array<[number, number]> = [[70, 7], [77, 15], [92, 25], [117, 35], [152, 10], [162, 12], [174, 26]];
  for (let row = 0; row < 23; row++) for (const [x, w] of colsMm) textBox(sheet, r, s, x, 105 + row * 7, w, 7, 0.4 + r() * 0.5);
  for (let i = 0; i < 4; i++) textBox(sheet, r, s, 150, 268 + i * 7, 45, 6, 0.7);
  const qrSide = 55 * s;
  const page = formSheetRaster(
    { bitmap: sheet, slots: [{ value: dummyQrValue(), ec: 'L', rect: { x: 12 * s, y: 226 * s, w: qrSide, h: qrSide } }] },
    { x0: Math.round(formReachX(p)![0] * dpm), dots: 1440, maxRows: Math.floor(297 * dpm + 1e-9) },
    { dpi: 180, size: 'auto' },
  );
  const seg = encodeForProfile(p, [[page]], {}, { form: true }).job;
  // المهمة نفسها بلا تقسيم (شريطٌ من أوّل حبرٍ إلى آخره) للمقارنة
  const flat = encodeEscP24({ copies: [[page]], continuous: true, pageLengthMm: 297, topDots: 0, leftDots: 0, draft: false });
  const chars = async (bytes: Uint8Array, marks: number[]) => (await encodeBridgePayload({ kind: 'escp24', bytes, marks, cancel: [...ESCP24_CANCEL_CONTINUOUS], slow: false, label: '' })).length;
  const segChars = await chars(seg.bytes, seg.marks);
  const flatChars = await chars(flat.bytes, flat.marks);
  t.diagnostic(`A4 كثيفة: خام ${seg.bytes.length} بايت مقسّمةً مقابل ${flat.bytes.length}؛ حمولة الجسر ${segChars} محرفاً مقابل ${flatChars} (السقف ${MAX_PAYLOAD_CHARS})`);
  // التقسيم يوفّر البايتات الخام (Web Serial بلا ضغط، وذاكرة الطابعة) — أما حمولة الجسر المضغوطة فتكاد تتساوى: deflate يضغط الأعمدة
  // البيضاء أصلاً، فلا يُشترط إلا ألّا تكبر بأكثر من 10٪
  assert.ok(seg.bytes.length < flat.bytes.length, 'التقسيم أصغر خاماً');
  assert.ok(segChars <= flatChars * 1.1, `حمولة الجسر مقسّمةً ${segChars} مقابل ${flatChars}`);
  assert.ok(segChars <= FORM_SHEET_PAYLOAD_BUDGET, `ميزانية الورقة ${FORM_SHEET_PAYLOAD_BUDGET}: ${segChars}`);
  assert.ok(3 * FORM_SHEET_PAYLOAD_BUDGET <= MAX_PAYLOAD_CHARS, 'ثلاث أوراقٍ (أوراقٌ × نسخ) في مهمة جسرٍ واحدة');
});

test('التحرير الحرّ — rasterPages يمرّر مدى اللوحات (keep من captureElement) إلى paginate', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/rep/printDirect.ts'), 'utf8');
  assert.ok(src.includes('const { bitmap, slots, keep } = await captureElement(el, p.paper.printableDots as number);'));
  assert.ok(src.includes('return paginate(bitmap, qrRows, rows, Math.round(PAGE_CUT_SEARCH_MM * dotsPerMm(dpi)), label, keep);'));
  const raster = fs.readFileSync(path.join(process.cwd(), 'src/lib/print/raster.ts'), 'utf8');
  assert.ok(raster.includes("if (!el.hasAttribute('data-print-canvas')) return { bitmap, slots };"), 'الورقة بلا لوحات بلا keep');
});
