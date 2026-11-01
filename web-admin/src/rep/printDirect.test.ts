// الطباعة المباشرة بالبلوتوث («إعدادات الطباعة» M3، التصميم §3.3): أيّ قالبٍ يُرسل (لا الكلاسيكي ولا العادية)، وطريقة الجهاز
// (نظام الطباعة افتراضاً)، والمُرمِّز لكل طابعة بهامشها وإزاحتها وطول صفحتها وقصّها، وخانة الرمز الأكبر للنقطية.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directAvailableFor, directHintFor, encodeForProfile, impactLeftDots, send, supportsDirect, transportFor } from './printDirect';
import { decodeBridgePayload } from '../lib/print/transport/bridgePayload';
import { TSPL_CANCEL } from '../lib/print/tspl';
import { DEFAULT_PRINT_LOOK, impactQrSlotPx, lookFor, qrSlotStyle } from './printLook';
import {
  STAMPED_QR_CELLS, defaultPrintOptions, legacyPageProfile, legacyThermalProfile, presetPaper,
  type PaperPresetId, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import { createBitmap, fillRect, type RasterPage } from '../lib/print/raster';
import { ESCPOS_CANCEL } from '../lib/print/escpos';
import { ESCP24_CANCEL, ESCP24_CANCEL_CONTINUOUS } from '../lib/print/escp24';

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
