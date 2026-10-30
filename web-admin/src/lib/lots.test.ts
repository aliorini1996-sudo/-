// أساس «تتبّع اللوط» في الواجهة (lib/lots.ts): مرايا قواعد الخادم، والتحقق قبل الإرسال، وحرّاس القاموس والعلامات
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LOT_BLOCK_KINDS, LOT_BLOCK_KIND_LABELS, LOT_BUCKETS, LOT_BUCKET_LABELS, LOT_CERTAINTIES, LOT_CERTAINTY_LABELS, LOT_ERROR_CODES,
  LOT_EVENT_KINDS, LOT_EVENT_KIND_LABELS, LOT_MAX_ROWS, LOT_PLACES, LOT_PLACE_LABELS, LOT_RELABEL_REASONS, LOT_RELABEL_REASON_LABELS,
  LOT_ROW_FLAGS, LOT_ROW_FLAG_LABELS, LOT_SOURCES, LOT_SOURCE_LABELS, LOT_STATUSES, LOT_STATUS_LABELS, LOT_WARNING_CODES,
  LOT_WARNING_LABELS, VAN_MOVE_TYPES, VAN_MOVE_TYPE_LABELS, LOT_EPS, LOT_NUMBER_MAX, LOT_VAN_REASONS,
  docLotsFrom, fefoCompare, isLotExpiredOn, lotDatesProblem, lotDay, lotErrorOf, lotFlagsOf, lotRowsProblem, lotRowsRemaining,
  lotWarningsOf, normalizeLotNumber, parseLotFlags, roundLot, toBaseQty, zeroBuckets,
} from './lots';
import { baseQtyOf } from './units';

const stringsSrc = () => fs.readFileSync(path.join(process.cwd(), 'src', 'i18n', 'strings.ts'), 'utf8');
/** كتلة PHRASES وحدها — من إعلانها إلى أول إغلاق بعده */
const phrasesBlock = (s: string) => {
  const at = s.indexOf('export const PHRASES');
  assert.ok(at >= 0, 'PHRASES غير موجودة');
  return { at, end: s.indexOf('\n};\n', at) };
};

test('كل تسمية تغطي قيم نوعها — ولها ترجمة بالأربع في PHRASES (الخرائط لا يلتقطها حارس langs.test)', () => {
  const s = stringsSrc();
  const { at, end } = phrasesBlock(s);
  const body = s.slice(at, end);
  const have = new Map<string, string>();
  for (const m of body.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*:\s*\{(.*)\},?\s*$/gm)) have.set(m[1], m[2]);
  const maps: [readonly string[], Record<string, string>][] = [
    [LOT_CERTAINTIES, LOT_CERTAINTY_LABELS], [LOT_STATUSES, LOT_STATUS_LABELS], [LOT_BLOCK_KINDS, LOT_BLOCK_KIND_LABELS],
    [LOT_BUCKETS, LOT_BUCKET_LABELS], [LOT_PLACES, LOT_PLACE_LABELS], [VAN_MOVE_TYPES, VAN_MOVE_TYPE_LABELS],
    [LOT_SOURCES, LOT_SOURCE_LABELS], [LOT_RELABEL_REASONS, LOT_RELABEL_REASON_LABELS], [LOT_ROW_FLAGS, LOT_ROW_FLAG_LABELS],
    [LOT_EVENT_KINDS, LOT_EVENT_KIND_LABELS], [LOT_WARNING_CODES, LOT_WARNING_LABELS],
  ];
  for (const [values, labels] of maps) {
    assert.deepEqual(Object.keys(labels).sort(), [...values].sort(), `تسميات ناقصة أو زائدة: ${values.join(',')}`);
    for (const ar of Object.values(labels)) {
      const tr = have.get(ar);
      assert.ok(tr, `التسمية «${ar}» بلا مدخل في PHRASES`);
      for (const l of ['en', 'fr', 'tr', 'zh']) assert.match(tr, new RegExp(`\\b${l}:\\s*'`), `«${ar}» بلا ${l}`);
    }
  }
});

test('علامات الحزم الست داخل PHRASES مرةً واحدة ومتباعدة ٢٠ سطراً على الأقل — و nav.lots بخمس لغات', () => {
  const s = stringsSrc();
  const { at, end } = phrasesBlock(s);
  const lineOf = (i: number) => s.slice(0, i).split('\n').length;
  const lines: number[] = [];
  for (let w = 1; w <= 6; w++) {
    const mark = `// ═══ تتبّع اللوط — W${w} ═══`;
    const i = s.indexOf(mark);
    assert.ok(i > at && i < end, `العلامة W${w} غائبة أو خارج PHRASES`);
    assert.equal(s.indexOf(mark, i + 1), -1, `العلامة W${w} مكرّرة`);
    lines.push(lineOf(i));
  }
  lines.sort((a, b) => a - b);
  for (let k = 1; k < lines.length; k++) assert.ok(lines[k] - lines[k - 1] > 20, `علامتان متقاربتان عند السطرين ${lines[k - 1]} و${lines[k]}`);
  assert.match(s.slice(0, at), /^\s*'nav\.lots': \{ ar: '[^']+', en: '[^']+', fr: '[^']+', tr: '[^']+', zh: '[^']+' \},$/m);
});

test('التقريب أربع خانات نصف لأعلى كرصيد الصنف، والدلاء تبدأ أصفاراً', () => {
  assert.equal(roundLot(0.1 + 0.2), 0.3);
  assert.equal(roundLot(1.00005), 1.0001);
  assert.equal(roundLot(-1.00005), -1.0001);
  assert.ok(Object.is(roundLot(-0.00001), 0), 'لا «-0» في العرض');
  assert.ok(Number.isNaN(roundLot(Number.NaN)), 'العطب لا يُخفى صفراً');
  assert.deepEqual(zeroBuckets(), { SELLABLE: 0, EXPIRED: 0, DAMAGED: 0 });
});

test('يوم الانتهاء نفسه آخر يوم صالح — والعمود يصل لحظة ISO', () => {
  assert.equal(lotDay('2026-10-29T00:00:00.000Z'), '2026-10-29');
  assert.equal(lotDay('2026-10-29'), '2026-10-29');
  assert.equal(lotDay(new Date('2026-10-29T00:00:00Z')), '2026-10-29');
  assert.equal(lotDay('29/10/2026'), null);
  assert.equal(lotDay(null), null);
  assert.equal(isLotExpiredOn({ expiryDate: '2026-10-29T00:00:00.000Z' }, '2026-10-29'), false);
  assert.equal(isLotExpiredOn({ expiryDate: '2026-10-29' }, '2026-10-30'), true);
  assert.equal(isLotExpiredOn({ expiryDate: null }, '2099-01-01'), false, 'بلا انتهاء لا تنتهي');
});

test('FEFO: الأقرب انتهاءً أولاً، وبلا انتهاء آخراً، ثم الإنتاج ثم الإنشاء ثم الرقم ثم المعرّف', () => {
  const lots = [
    { id: 'e', lotNumber: 'E', expiryDate: null, productionDate: '2026-01-01', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'd', lotNumber: 'D', expiryDate: '2026-12-01', productionDate: null, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'c', lotNumber: 'C', expiryDate: '2026-11-01', productionDate: null, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'b', lotNumber: 'B', expiryDate: '2026-11-01', productionDate: '2026-02-01', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'a2', lotNumber: 'A', expiryDate: '2026-11-01', productionDate: '2026-01-01', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'a1', lotNumber: 'A', expiryDate: '2026-11-01', productionDate: '2026-01-01', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'z', lotNumber: 'Z', expiryDate: '2026-11-01', productionDate: '2026-01-01', createdAt: '2026-01-01T00:00:00Z' },
  ];
  assert.deepEqual([...lots].sort(fefoCompare).map(l => l.id), ['z', 'a1', 'a2', 'b', 'c', 'd', 'e']);
  // صفوف اللقطة بلا إنتاج ولا إنشاء: الانتهاء ثم الرقم ثم lotId
  const snap = [{ lotId: 'y', lotNumber: 'L2', expiryDate: '2026-11-01' }, { lotId: 'x', lotNumber: 'L1', expiryDate: '2026-11-01' }];
  assert.deepEqual([...snap].sort(fefoCompare).map(l => l.lotId), ['x', 'y']);
});

test('الرقم المطبَّع: مسافات وأرقام عربية وفارسية وحروف لاتينية كبيرة، والفارغ والطويل null', () => {
  assert.equal(normalizeLotNumber('  ab-١٢٣   x '), 'AB-123 X');
  assert.equal(normalizeLotNumber('lot ۴۵'), 'LOT 45');
  assert.equal(normalizeLotNumber('تشغيلة 7'), 'تشغيلة 7', 'الحروف غير اللاتينية كما هي');
  assert.equal(normalizeLotNumber('straße'), 'STRAßE', 'الحروف خارج a-z لا تُكبَّر (ß لا تصير SS)');
  assert.equal(normalizeLotNumber('‏ab‎ 12﻿'), 'AB 12', 'محارف الاتجاه المنسوخة مع النصّ العربي تُحذف');
  assert.equal(normalizeLotNumber('   '), null);
  assert.equal(normalizeLotNumber(''), null);
  assert.equal(normalizeLotNumber(123), '123', 'رقمٌ من ملف Excel يُقبل نصّاً');
  assert.equal(normalizeLotNumber(Number.NaN), null);
  assert.equal(normalizeLotNumber(null), null);
  assert.equal(normalizeLotNumber('x'.repeat(LOT_NUMBER_MAX)), 'X'.repeat(LOT_NUMBER_MAX));
  assert.equal(normalizeLotNumber('x'.repeat(LOT_NUMBER_MAX + 1)), null);
});

test('تاريخا التشغيلة: الإنتاج لا يتجاوز الانتهاء، والتاريخ الحقيقي وحده، والانتهاء إلزامي مع الصلاحية', () => {
  assert.equal(lotDatesProblem('2026-01-01', '2027-01-01', { expiryRequired: true }), null);
  assert.equal(lotDatesProblem('2026-01-01', '2026-01-01', { expiryRequired: true }), null, 'اليوم نفسه جائز');
  assert.equal(lotDatesProblem('2027-01-02', '2027-01-01', { expiryRequired: false }), 'LOT_DATES_INVALID');
  assert.equal(lotDatesProblem(null, '2026-02-30', { expiryRequired: false }), 'LOT_DATES_INVALID');
  assert.equal(lotDatesProblem('2026/01/01', null, { expiryRequired: false }), 'LOT_DATES_INVALID');
  assert.equal(lotDatesProblem('2026-01-01', null, { expiryRequired: true }), 'LOT_EXPIRY_REQUIRED');
  assert.equal(lotDatesProblem('', '', { expiryRequired: false }), null, 'الفارغ غياب');
  assert.equal(lotDatesProblem('', '', { expiryRequired: true }), 'LOT_EXPIRY_REQUIRED');
  assert.equal(lotDatesProblem(undefined, undefined, { expiryRequired: false }), null);
  assert.equal(lotDatesProblem(' 2026-01-01', null, { expiryRequired: false }), 'LOT_DATES_INVALID', 'لا قصّ — كالخادم');
});

test('الكمية الأساسية = baseQtyOf (lib/units.ts، D19): baseQty أولاً وإلا qty × المعامل، والمعامل التالف ١', () => {
  assert.equal(toBaseQty({ qty: 3 }), 3);
  assert.equal(toBaseQty({ qty: 2, unitFactor: 12 }), 24);
  assert.equal(toBaseQty({ qty: 2, unitFactor: null }), 2);
  assert.equal(toBaseQty({ qty: 2, baseQty: 5, unitFactor: 12 }), 5);
  assert.equal(toBaseQty({ qty: 2, baseQty: Number.NaN, unitFactor: Number.NaN }), 2, 'غير المنتهي يُتجاهل كالخادم');
  assert.equal(toBaseQty({ qty: 2, unitFactor: 0 }), 2, 'المعامل الصفري ١ كـfactorOf');
  assert.equal(toBaseQty({ qty: 2, unitFactor: -6 }), 2, 'والسالب ١');
  assert.equal(toBaseQty({ qty: 0, baseQty: 0, unitFactor: 24 }), 0, 'الصفر المخزَّن كمية لا غياب');
  assert.equal(toBaseQty({ qty: 0.1 + 0.2, unitFactor: 1 }), 0.3, 'غبار الطفو يُقرَّب كـroundQty');
  for (const row of [{ qty: 1.5, unitFactor: 24 }, { qty: 2, baseQty: 48.0000004, unitFactor: 24 }, { qty: 7 }]) {
    assert.equal(toBaseQty(row), baseQtyOf(row), JSON.stringify(row));
  }
});

test('صفوف السطر: موجبة بمعرّف أو null، حتى ٢٠ صفاً، ومجموعها كمية السطر بسماحية الطفو', () => {
  assert.equal(lotRowsProblem(null, 5), null, 'بلا صفوف: الخادم يوزّع');
  assert.equal(lotRowsProblem(undefined, 5), null);
  assert.equal(lotRowsProblem([{ lotId: 'a', qty: 3 }, { lotId: null, qty: 2 }], 5), null);
  assert.equal(lotRowsProblem([{ lotId: 'a', qty: 0.1 }, { lotId: 'b', qty: 0.2 }], 0.3), null, 'غبار الطفو لا يرفض');
  assert.equal(lotRowsProblem([{ lotId: 'a', qty: 2 }, { lotId: 'a', qty: 3 }], 5), null, 'الصفّان على لوطٍ واحد يُجمعان في الخادم');
  assert.equal(lotRowsProblem([{ lotId: 'a', qty: 3 }], 5), 'LOT_QTY_INVALID', 'المجموع ناقص');
  assert.equal(lotRowsProblem([{ lotId: 'a', qty: 6 }], 5), 'LOT_QTY_INVALID', 'المجموع زائد');
  assert.equal(lotRowsProblem([{ lotId: 'a', qty: 5 }, { lotId: 'b', qty: 0 }], 5), 'LOT_QTY_INVALID', 'صفّ صفريّ');
  assert.equal(lotRowsProblem([{ lotId: 'a', qty: 6 }, { lotId: 'b', qty: -1 }], 5), 'LOT_QTY_INVALID', 'صفّ سالب');
  assert.equal(lotRowsProblem([{ lotId: 'a', qty: Number.NaN }], 5), 'LOT_QTY_INVALID');
  assert.equal(lotRowsProblem([{ lotId: '', qty: 5 }], 5), 'LOT_QTY_INVALID', 'معرّف فارغ ليس «غير مسمّى»');
  assert.equal(lotRowsProblem([{ lotId: 'a', qty: 1e-7 }, { lotId: 'b', qty: 5 }], 5), 'LOT_QTY_INVALID', 'غبارٌ دون السماحية ليس كمية');
  assert.equal(lotRowsProblem([], 5), null, 'المصفوفة الفارغة غياب: الخادم يوزّع (parseLotRefsStrict ⇒ [])');
  assert.equal(lotRowsProblem([{ lotId: 'a', qty: 5 }], 0), 'LOT_QTY_INVALID');
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ lotId: `l${i}`, qty: 1 }));
  assert.equal(lotRowsProblem(rows(LOT_MAX_ROWS), LOT_MAX_ROWS), null);
  assert.equal(lotRowsProblem(rows(LOT_MAX_ROWS + 1), LOT_MAX_ROWS + 1), 'LOT_QTY_INVALID');
});

test('الباقي من السطر: موجبٌ ناقص وسالبٌ زائد، بلا غبار طفو', () => {
  assert.equal(lotRowsRemaining([{ lotId: 'a', qty: 3 }, { lotId: null, qty: 2.5 }], 10), 4.5);
  assert.equal(lotRowsRemaining([{ lotId: 'a', qty: 12 }], 10), -2);
  assert.equal(lotRowsRemaining([{ lotId: 'a', qty: 0.1 }, { lotId: 'b', qty: 0.2 }], 0.3), 0);
  assert.equal(lotRowsRemaining(null, 10), 10);
});

test('وسوم الصفّ: نصّ مفصول بفاصلة، والمجهول يسقط', () => {
  assert.deepEqual(parseLotFlags('REPLAY_BLOCKED, HINT_REJECTED,FOO'), ['REPLAY_BLOCKED', 'HINT_REJECTED']);
  assert.deepEqual(parseLotFlags(null), []);
  assert.deepEqual(parseLotFlags(''), []);
});

test('علما الشركة: الغائب إطفاء، والطباعة لا تسري إلا مع الميزة', () => {
  assert.deepEqual(lotFlagsOf(undefined), { on: false, onInvoice: false });
  assert.deepEqual(lotFlagsOf({}), { on: false, onInvoice: false }, 'نسخة /company قديمة بلا العلم');
  assert.deepEqual(lotFlagsOf({ lotTrackingEnabled: true }), { on: true, onInvoice: false });
  assert.deepEqual(lotFlagsOf({ lotOnInvoice: true }), { on: false, onInvoice: false });
  assert.deepEqual(lotFlagsOf({ lotTrackingEnabled: true, lotOnInvoice: true }), { on: true, onInvoice: true });
  assert.deepEqual(lotFlagsOf({ lotTrackingEnabled: 'true' }), { on: false, onInvoice: false }, 'true الصريحة وحدها');
});

test('خطأ اللوط من ردّ axios: الرمز المعروف وحده، مع الحالة والرسالة والتفصيل', () => {
  const err = { response: { status: 409, data: { success: false, code: 'LOT_STOCK_INSUFFICIENT', message: 'الكمية أكبر من المتاح', detail: { productId: 'p', wanted: 5, available: 3 } } } };
  assert.deepEqual(lotErrorOf(err), { status: 409, code: 'LOT_STOCK_INSUFFICIENT', message: 'الكمية أكبر من المتاح', detail: { productId: 'p', wanted: 5, available: 3 } });
  const busy = lotErrorOf({ response: { status: 503, data: { code: 'LOT_BUSY', message: 'مشغول' } } });
  assert.equal(busy?.code, 'LOT_BUSY');
  assert.equal(busy?.detail, null);
  assert.equal(lotErrorOf({ response: { status: 400, data: { code: 'INSUFFICIENT_STOCK' } } }), null, 'رمز غير لوطي');
  assert.equal(lotErrorOf(new Error('network')), null);
  assert.equal(lotErrorOf(null), null);
  assert.equal(lotErrorOf({ response: { status: 409, data: { code: 'LOT_IN_USE', detail: [1] } } })?.detail, null);
});

test('التحذيرات: المعروف بصنفه وحده، وغير المصفوفة فارغة', () => {
  const ws = lotWarningsOf([
    { code: 'LOT_MULTI_IN_VAN', productId: 'p' },
    { code: 'LOT_FROM_UNKNOWN', productId: 'q', detail: { qty: 2 } },
    { code: 'SOMETHING_ELSE', productId: 'p' },
    { code: 'LOT_SPLIT_UNIT' },
    null,
  ]);
  assert.deepEqual(ws.map(w => w.code), ['LOT_MULTI_IN_VAN', 'LOT_FROM_UNKNOWN']);
  assert.deepEqual(lotWarningsOf(undefined), []);
  assert.deepEqual(lotWarningsOf({ code: 'LOT_MULTI_IN_VAN' }), []);
});

test('أسطر الورقة من صفوف التوزيع: رقم اللوط وانتهاؤه، وغير المسمّى بلا رقم، والكمية مطلقة', () => {
  const inv = docLotsFrom([
    { lotId: 'l1', quantity: 4, expiryDate: '2026-12-01T00:00:00.000Z', lot: { lotNumber: 'A1', expiryDate: '2026-12-01T00:00:00.000Z' } },
    { lotId: null, quantity: 1, expiryDate: null, lot: null },
  ]);
  assert.deepEqual(inv, [{ lotNumber: 'A1', qty: 4, expiryDate: '2026-12-01' }, { lotNumber: null, qty: 1, expiryDate: null }]);
  // حركة التنزيل: qty بإشارة البند ⇒ تُطبع مطلقة؛ والانتهاء من لقطة الصفّ إن لم يُضمّ اللوط
  assert.deepEqual(docLotsFrom([{ lotId: 'l2', qty: -3, lot: { lotNumber: 'B2', expiryDate: null } }]), [{ lotNumber: 'B2', qty: 3, expiryDate: null }]);
  assert.deepEqual(docLotsFrom([{ lotId: 'l3', quantity: 2, expiryDate: '2027-01-01' }]), [{ lotNumber: null, qty: 2, expiryDate: '2027-01-01' }]);
  assert.equal(docLotsFrom([{ lotId: 'l1', quantity: 0 }]), undefined, 'الصفريّ يسقط');
  assert.equal(docLotsFrom([]), undefined);
  assert.equal(docLotsFrom(undefined), undefined);
});

// ─── المرآة: الثوابت نفسها في الخادم (يكتبها P0 في backend/src/services/lots.ts) ───
const backendLots = path.join(process.cwd(), '..', 'backend', 'src', 'services', 'lots.ts');
test('مرآة الخادم: القوائم والرموز والحدود نفسها في services/lots.ts', { skip: !fs.existsSync(backendLots) && 'services/lots.ts لم يُكتب بعد' }, () => {
  const src = fs.readFileSync(backendLots, 'utf8');
  const quoted = (s: string) => [...s.matchAll(/'([^']*)'/g)].map(m => m[1]).sort();
  const arrays: [string, readonly string[]][] = [
    ['LOT_STATUSES', LOT_STATUSES], ['LOT_BLOCK_KINDS', LOT_BLOCK_KINDS], ['LOT_CERTAINTIES', LOT_CERTAINTIES], ['LOT_BUCKETS', LOT_BUCKETS],
    ['LOT_PLACES', LOT_PLACES], ['LOT_SOURCES', LOT_SOURCES], ['LOT_RELABEL_REASONS', LOT_RELABEL_REASONS], ['LOT_ROW_FLAGS', LOT_ROW_FLAGS],
    ['LOT_EVENT_KINDS', LOT_EVENT_KINDS], ['LOT_VAN_REASONS', LOT_VAN_REASONS], ['VAN_MOVE_TYPES', VAN_MOVE_TYPES],
  ];
  for (const [name, mine] of arrays) {
    const m = new RegExp(`export const ${name}\\b[^=]*=\\s*(?:Object\\.freeze\\()?\\[([\\s\\S]*?)\\]`).exec(src);
    assert.ok(m, `${name} غائبة عن الخادم`);
    assert.deepEqual(quoted(m[1]), [...mine].sort(), `${name} تختلف عن الخادم`);
  }
  const errs = /export type LotErrorCode\s*=([\s\S]*?);/.exec(src);
  assert.ok(errs, 'LotErrorCode غائب عن الخادم');
  assert.deepEqual(quoted(errs[1]), [...LOT_ERROR_CODES].sort(), 'رموز الأخطاء تختلف عن الخادم');
  const warns = /interface LotWarning\s*\{\s*code:\s*([^;]+);/.exec(src);
  assert.ok(warns, 'LotWarning غائب عن الخادم');
  assert.deepEqual(quoted(warns[1]), [...LOT_WARNING_CODES].sort(), 'رموز التحذيرات تختلف عن الخادم');
  for (const [name, mine] of [['LOT_EPS', LOT_EPS], ['LOT_MAX_ROWS', LOT_MAX_ROWS], ['LOT_NUMBER_MAX', LOT_NUMBER_MAX]] as const) {
    const m = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`).exec(src);
    assert.ok(m, `${name} غائب عن الخادم`);
    assert.equal(Number(m[1].trim()), mine, `${name} يختلف عن الخادم`);
  }
});

test('مرآة الخادم بالسلوك: الحالات نفسها تعطي النتيجة نفسها في الطرفين', { skip: !fs.existsSync(backendLots) && 'services/lots.ts لم يُكتب بعد' }, async () => {
  // الوحدة صرفة (لا تستورد إلا node:crypto و./shelfLife و./units، والأخيرتان بلا import) فتُحمَّل هنا بلا قاعدة
  const be = await import(pathToFileURL(backendLots).href) as {
    normalizeLotNumber(raw: unknown): string | null;
    lotDatesProblem(p: string | null, e: string | null, o: { expiryRequired: boolean }): string | null;
    isLotExpiredOn(meta: { expiryDate: string | null }, day: string): boolean;
    lotBaseQty(row: { qty: number; baseQty?: number | null; unitFactor?: number | null }): number;
    parseLotRefsStrict(raw: unknown, lineBaseQty: number): unknown;
  };
  const x64 = 'x'.repeat(LOT_NUMBER_MAX);
  for (const raw of ['  ab-١٢٣   x ', 'lot ۴۵', 'تشغيلة 7', 'straße', '   ', '', 123, Number.NaN, null, '‏ab‎ 12﻿', x64, `${x64}x`, 'a\tb\nc']) {
    assert.equal(normalizeLotNumber(raw), be.normalizeLotNumber(raw), `normalizeLotNumber(${JSON.stringify(raw)})`);
  }
  const days = [null, '', '2026-01-01', '2027-01-01', '2026-02-30', '2026/01/01', ' 2026-01-01'];
  for (const p of days) for (const e of days) for (const expiryRequired of [true, false]) {
    assert.equal(lotDatesProblem(p, e, { expiryRequired }), be.lotDatesProblem(p, e, { expiryRequired }), `lotDatesProblem(${p}, ${e}, ${expiryRequired})`);
  }
  for (const [exp, day] of [['2026-10-29', '2026-10-29'], ['2026-10-29', '2026-10-30'], [null, '2099-01-01']] as const) {
    assert.equal(isLotExpiredOn({ expiryDate: exp }, day), be.isLotExpiredOn({ expiryDate: exp }, day));
  }
  for (const row of [{ qty: 3 }, { qty: 2, unitFactor: 12 }, { qty: 2, unitFactor: null }, { qty: 2, baseQty: 5, unitFactor: 12 }, { qty: 2, baseQty: Number.NaN },
    { qty: 2, unitFactor: 0 }, { qty: 2, unitFactor: -6 }, { qty: 0.1 + 0.2, unitFactor: 1 }, { qty: 2, baseQty: 48.0000004, unitFactor: 24 }]) {
    assert.equal(toBaseQty(row), be.lotBaseQty(row), `toBaseQty(${JSON.stringify(row)})`);
  }
  const rowsCases: [unknown, number][] = [
    [null, 5], [[], 5], [[{ lotId: 'a', qty: 3 }, { lotId: null, qty: 2 }], 5], [[{ lotId: 'a', qty: 0.1 }, { lotId: 'b', qty: 0.2 }], 0.3],
    [[{ lotId: 'a', qty: 3 }], 5], [[{ lotId: 'a', qty: 5 }, { lotId: 'b', qty: 0 }], 5], [[{ lotId: 'a', qty: -1 }], -1],
    [[{ lotId: '', qty: 5 }], 5], [[{ lotId: 'a', qty: 1e-7 }, { lotId: 'b', qty: 5 }], 5], [[{ lotId: 'a', qty: 5 }], 0],
    [Array.from({ length: LOT_MAX_ROWS + 1 }, (_, i) => ({ lotId: `l${i}`, qty: 1 })), LOT_MAX_ROWS + 1],
  ];
  for (const [raw, qty] of rowsCases) {
    const serverRejects = !Array.isArray(be.parseLotRefsStrict(raw, qty));
    assert.equal(lotRowsProblem(raw as never, qty) === 'LOT_QTY_INVALID', serverRejects, `lotRowsProblem(${JSON.stringify(raw)}, ${qty})`);
  }
});
