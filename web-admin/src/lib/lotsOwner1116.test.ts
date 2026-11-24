// «تتبّع اللوط» — طلب المالك ١٦ نوفمبر ٢٠٢٦ في الويب (الشكويان ١ و٣):
//  ١) المرتجع لا يدخل «غير مسمّى» ما وُجدت تشغيلة: منتقي المرتجع الحرّ يبدأ بما اشتراه هذا العميل (/lots/customer-history)،
//     والمرتبط يختار من صفوف بند البيع (المرحلة B)، والورقة تطبع رقم التشغيلة المنسوبة ومعه «(تقديري)».
//  ٣) التشغيلة المختارة «تُستعمل أولاً» لا «تُستعمل حتماً» في البيع والتحميل من المستودع: نفادها أو انتهاؤها أو إيقافها تنبيهٌ
//     كهرماني لا منع (explicitFallback مرآة explicitShort: 'SPLIT' في الخادم)، والرفض الباقي نقص الصنف كله.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DOC_NOTE_FLAGS, LOT_ASSUMED_MARK, LOT_FALLBACK_NOTICE, LOT_ROW_FLAGS, LOT_ROW_FLAG_LABELS, LOT_WARNING_CODES, LOT_WARNING_LABELS,
  docLotsFrom, lotWarningsOf, parseLotFlags, type PlaceLotViewDto,
} from './lots';
import { explicitFallback, loadDraftCheck, type LotSource } from './stockLots';
import {
  customerLotHistoryOf, freeReturnLotOptions, linkedReturnBaseQty, linkedReturnLotChoices, linkedReturnLotProblem, lotErrorText, withLinkedReturnLots,
  type SaleLotRow,
} from './invoiceLots';
import { lotFlagNotes, lotLineText } from '../rep/docLots';

const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const tr = (s: string) => s;

// ─── الوسوم والتحذيرات الجديدة ───

test('الوسوم الأربعة والتحذيرات الأربعة: في القوائم المجمّدة وبتسمياتها، وparseLotFlags يبقيها', () => {
  for (const f of ['EXPLICIT_FALLBACK', 'RETURN_GUESS_CUSTOMER', 'RETURN_GUESS_VAN', 'RETURN_GUESS_COMPANY'] as const) {
    assert.ok((LOT_ROW_FLAGS as readonly string[]).includes(f), f);
    assert.ok(LOT_ROW_FLAG_LABELS[f], `تسمية ${f}`);
  }
  for (const w of ['LOT_EXPLICIT_FALLBACK', 'LOT_CLAMPED', 'LOT_NUMBER_UNKNOWN', 'LOT_CREATED'] as const) {
    assert.ok((LOT_WARNING_CODES as readonly string[]).includes(w), w);
    assert.ok(LOT_WARNING_LABELS[w], `تسمية ${w}`);
  }
  assert.deepEqual(parseLotFlags('EXPLICIT_FALLBACK,SPLIT_UNIT,RETURN_GUESS_VAN,NOPE'), ['EXPLICIT_FALLBACK', 'SPLIT_UNIT', 'RETURN_GUESS_VAN']);
  // تحذير الإكمال يمرّ من الردّ فيُقال في نافذة الفاتورة (lotWarns)
  assert.deepEqual(lotWarningsOf([{ code: 'LOT_EXPLICIT_FALLBACK', productId: 'p1', detail: { reason: 'SHORT' } }, { code: 'X', productId: 'p1' }]).map((w) => w.code), ['LOT_EXPLICIT_FALLBACK']);
  assert.deepEqual([...DOC_NOTE_FLAGS].sort(), ['EXPLICIT_FALLBACK', 'RETURN_GUESS_COMPANY', 'RETURN_GUESS_CUSTOMER', 'RETURN_GUESS_VAN']);
  // النصّان الثابتان بلا فاصلةٍ عليا (مدخل PHRASES) وبنصّ القرار
  assert.equal(LOT_FALLBACK_NOTICE, 'التشغيلة المختارة لا تكفي — سيُكمَل الباقي من تشغيلة أخرى (الأقرب انتهاءً)');
  assert.equal(LOT_ASSUMED_MARK, 'تقديري');
});

// ─── الورقة: رقم التشغيلة المنسوبة و«(تقديري)» ───

const row = (o: Record<string, unknown>) => ({ quantity: 2, expiryDate: '2027-01-01T00:00:00.000Z', lot: { lotNumber: 'A-1', expiryDate: '2027-01-01' }, ...o });

test('docLotsFrom: مرتجعٌ منسوبٌ تقديراً (ASSUMED بوسم تقدير أو موروث من بيع) يحمل assumed — والبيع ASSUMED كما كان', () => {
  const guessed = docLotsFrom([row({ lotId: 'L1', certainty: 'ASSUMED', flags: 'RETURN_GUESS_VAN' })])!;
  assert.deepEqual(guessed, [{ lotNumber: 'A-1', qty: 2, expiryDate: '2027-01-01', assumed: true, flags: ['RETURN_GUESS_VAN'] }]);
  const inherited = docLotsFrom([row({ lotId: 'L1', certainty: 'ASSUMED', flags: null, sourceItemLotId: 's1' })])!;
  assert.equal(inherited[0].assumed, true, 'موروثٌ من بيعٍ متعدّد الصفوف');
  assert.equal('flags' in inherited[0], false);
  // صفّ بيعٍ ASSUMED (الأقرب انتهاءً من أكثر من مصدر) لا يُوسم — الورقة كما كانت حرفاً
  const sale = docLotsFrom([row({ lotId: 'L1', certainty: 'ASSUMED', flags: null })])!;
  assert.deepEqual(sale, [{ lotNumber: 'A-1', qty: 2, expiryDate: '2027-01-01' }]);
  // إكمالٌ من تشغيلة أخرى: الوسم للشريط لا «(تقديري)»
  const spill = docLotsFrom([row({ lotId: 'L2', certainty: 'ASSUMED', flags: 'EXPLICIT_FALLBACK' })])!;
  assert.deepEqual(spill[0].flags, ['EXPLICIT_FALLBACK']);
  assert.equal(spill[0].assumed, undefined);
  // المؤكَّد والمجهول بلا وسم
  assert.equal(docLotsFrom([row({ lotId: 'L1', certainty: 'CONFIRMED', sourceItemLotId: 's1' })])![0].assumed, undefined);
  assert.equal(docLotsFrom([row({ lotId: null, certainty: 'UNKNOWN', sourceItemLotId: 's1', lot: null })])![0].assumed, undefined);
});

test('lotLineText: «تشغيلة A-1 (تقديري)» للمنسوبة — لا «تشغيلة غير معروفة» — وغير الموسوم كما كان حرفاً', () => {
  assert.equal(lotLineText({ lotNumber: 'A-1', qty: 2, expiryDate: '2027-01-01', assumed: true }, { tr }), 'تشغيلة A-1 (تقديري) ×2 · ينتهي 01/01/2027');
  assert.equal(lotLineText({ lotNumber: 'A-1', qty: 2, expiryDate: '2027-01-01' }, { tr }), 'تشغيلة A-1 ×2 · ينتهي 01/01/2027');
  assert.equal(lotLineText({ lotNumber: null, qty: 2 }, { tr }), 'تشغيلة غير معروفة ×2');
  assert.equal(lotFlagNotes({ lotNumber: 'A-1', qty: 1, flags: ['RETURN_GUESS_CUSTOMER'] }, tr), ' · تشغيلة مقدرة من مشتريات العميل');
  assert.equal(lotFlagNotes({ lotNumber: 'A-1', qty: 1 }, tr), '');
  // الشريط في الإدارة وحده يذكر الوسوم، والورقة لا
  const docs = src('rep', 'RepDocuments.tsx');
  assert.match(docs, /\{l\.flags\?\.length \? <span className="text-amber-700">\{lotFlagNotes\(l, tr\)\}<\/span> : null\}/);
  assert.equal((docs.match(/lotFlagNotes\(/g) ?? []).length, 1, 'لا وسوم على ورقة العميل');
});

// ─── «يُكمَل من غيرها» ───

const S = (lotId: string | null, usable: number, o: Partial<LotSource> = {}): LotSource => ({
  lotId, lotNumber: lotId, expiryDate: null, status: lotId === null ? null : 'ACTIVE', blockKind: null, usable, expired: false, ...o,
});

test('explicitFallback: المختارة أولاً ثم الأقرب انتهاءً ثم غير المسمّى — والموقوفة والمنتهية لا تعطي شيئاً (I4)', () => {
  const src0 = [
    S('A', 3, { expiryDate: '2026-12-01' }), S('B', 20, { expiryDate: '2027-03-01' }),
    S('X', 2, { expired: true, expiryDate: '2026-10-01' }), S('H', 5, { status: 'BLOCKED', blockKind: 'HOLD' }), S(null, 4),
  ];
  const a = explicitFallback([{ lotId: 'A', qty: 10 }], src0, { allowUnknown: true })!;
  assert.deepEqual(a.events, [{ lotId: 'A', lotNumber: 'A', reason: 'SHORT', requested: 10, taken: 3 }]);
  assert.deepEqual(a.preview, [{ lotId: 'B', qty: 7 }]);
  assert.equal(a.short, false);
  assert.equal(explicitFallback([{ lotId: 'A', qty: 3 }], src0, { allowUnknown: true }), null, 'تكفي: لا تنبيه');
  const x = explicitFallback([{ lotId: 'X', qty: 2 }], src0, { allowUnknown: true })!;
  assert.deepEqual([x.events[0].reason, x.events[0].taken, x.fromPicked], ['EXPIRED', 0, 0]);
  assert.deepEqual(x.preview, [{ lotId: 'A', qty: 2 }]);
  const h = explicitFallback([{ lotId: 'H', qty: 1 }], src0, { allowUnknown: true })!;
  assert.equal(h.events[0].reason, 'BLOCKED');
  // الباقي يتجاوز المسمّاة المؤهَّلة ⇒ غير المسمّى آخراً، وما فوقه نقص الصنف كله
  assert.deepEqual(explicitFallback([{ lotId: 'A', qty: 27 }], src0, { allowUnknown: true })!.preview, [{ lotId: 'B', qty: 20 }, { lotId: null, qty: 4 }]);
  assert.equal(explicitFallback([{ lotId: 'A', qty: 28 }], src0, { allowUnknown: true })!.short, true);
  assert.equal(explicitFallback([{ lotId: 'A', qty: 24 }], src0, { allowUnknown: false })!.short, true, 'بلا غير المسمّى');
  // صفٌّ صريحٌ لغير المسمّى: يعطي متاحه (I2) والباقي من المسمّاة
  const u = explicitFallback([{ lotId: null, qty: 5 }], src0, { allowUnknown: true })!;
  assert.deepEqual([u.events[0].reason, u.events[0].taken], ['UNKNOWN_SHORT', 4]);
  assert.deepEqual(u.preview, [{ lotId: 'A', qty: 1 }]);
  // المتاح مشتركٌ بين الصفوف بترتيبها (D26)، والكسور على شبكة الأربع خانات
  const d = explicitFallback([{ lotId: 'A', qty: 2 }, { lotId: 'B', qty: 1 }], [S('A', 1.3333), S('B', 30)], { allowUnknown: false })!;
  assert.deepEqual(d.events, [{ lotId: 'A', lotNumber: 'A', reason: 'SHORT', requested: 2, taken: 1.3333 }]);
  assert.equal(d.remainder, 0.6667);
  assert.deepEqual(d.preview, [{ lotId: 'B', qty: 0.6667 }]);
  assert.equal(explicitFallback(null, src0, { allowUnknown: true }), null);
});

test('loadDraftCheck: التحميل بتوزيعٍ معدَّل يمنعه الشكل ونقص الصنف وحدهما — فوق متاح التشغيلة تنبيه', () => {
  const day = '2026-11-18';
  const lot = (lotId: string, usable: number, meta: Record<string, unknown> = {}) => ({
    lotId, meta: { id: lotId, productId: 'p1', lotNumber: lotId, productionDate: null, expiryDate: null, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: '', ...meta },
    raw: { SELLABLE: usable, EXPIRED: 0, DAMAGED: 0 }, held: { SELLABLE: 0, EXPIRED: 0, DAMAGED: 0 }, usable: { SELLABLE: usable, EXPIRED: 0, DAMAGED: 0 },
  });
  const view = {
    productId: 'p1', place: 'WAREHOUSE', vanKey: null,
    lots: [lot('A', 3, { expiryDate: '2026-12-01' }), lot('B', 20, { expiryDate: '2027-03-01' }), lot('H', 4, { status: 'BLOCKED' })],
    unknownUsable: { SELLABLE: 0, EXPIRED: 0, DAMAGED: 0 },
  } as unknown as PlaceLotViewDto;
  const rows = (...r: [string, string][]) => r.map(([source, qty], i) => ({ key: `k${i}`, source, qty }));
  const over = loadDraftCheck(rows(['A', '10']), 10, view, day);
  assert.equal(over.problem, null, 'فوق متاح A لم يعد يمنع');
  assert.equal(over.short, false);
  assert.deepEqual(over.fallback!.preview, [{ lotId: 'B', qty: 7 }]);
  assert.equal(loadDraftCheck(rows(['H', '4']), 4, view, day).fallback!.events[0].reason, 'BLOCKED');
  assert.equal(loadDraftCheck(rows(['A', '24']), 24, view, day).short, true, 'الصنف كله ٢٣');
  assert.equal(loadDraftCheck(rows(['A', '5']), 10, view, day).problem, 'LOT_QTY_INVALID', 'المجموع ≠ الكمية يمنع');
  assert.equal(loadDraftCheck(rows(['', '10']), 10, view, day).problem, 'LOT_SOURCE_MISSING');
  assert.deepEqual(loadDraftCheck(rows(['A', '10']), 10, undefined, day), { problem: null, short: false, fallback: null }, 'بلا عرضٍ لا حكم');
  // الشاشة: التحميل بالفحص الجديد ونصّ نقص المستودع، والتنزيل بتشغيلةٍ صريحة صارمٌ كما كان
  const page = src('pages', 'VanStockPage.tsx');
  assert.match(page, /const c = loadDraftCheck\(r\.lotEdit, base, whViewOf\(r\.productId\), day, factorOfRow\(r\)\);/);
  assert.match(page, /if \(r\.lotEdit\) return draftProblemText\(draftProblem\(r\.lotEdit, base, sources\), tr, productOf\(r\.productId\)\);/, 'التنزيل كما كان');
  assert.match(page, /\{load && !issue && fallback && <LotFallbackNote plan=\{fallback\}/);
});

test('نافذة الفاتورة: منتقي البيع يُمرَّر تنبيه الإكمال، والمنتقي يعرضه كهرمانياً لا خطأً', () => {
  const m = src('components', 'forms', 'InvoiceModal.tsx');
  assert.match(m, /fallback=\{saleLotState === 'READY' \? saleLotFallback\(lines, vanLots, i\) : null\}/);
  const p = src('components', 'SaleLotPicker.tsx');
  assert.match(p, /\{pick && !problem && fallback && \(\n\s*<LotFallbackNote plan=\{fallback\} sources=\{sources\.all\}/);
  const f = src('components', 'StockLotFields.tsx');
  assert.match(f, /<p className="text-amber-700">\{tr\(LOT_FALLBACK_NOTICE\)\}/);
});

// ─── المرتجع: تشغيلات العميل أولاً، والمرتبط من صفوف بند البيع ───

test('customerLotHistoryOf: صفوفٌ صالحة بترتيب الخادم، والمكرّر أوّله، وما ليس مصفوفةً []', () => {
  const rows = customerLotHistoryOf([
    { lotId: 'L2', lotNumber: ' B-2 ', expiryDate: '2027-02-01T00:00:00.000Z', status: 'ACTIVE', blockKind: 'HOLD', lastSoldAt: '2026-11-10T08:00:00.000Z', soldBase: 12, returnedBase: '2' },
    { lotId: 'L1', lotNumber: 'A-1', expiryDate: null, status: 'BLOCKED', blockKind: 'RECALL', lastSoldAt: null, soldBase: null, returnedBase: null },
    { lotId: 'L2', lotNumber: 'dup', status: 'ACTIVE' },
    { lotId: '', lotNumber: 'x', status: 'ACTIVE' }, { lotId: 'L9', lotNumber: 'x', status: 'GONE' }, null, 'x',
  ]);
  assert.deepEqual(rows, [
    { lotId: 'L2', lotNumber: 'B-2', expiryDate: '2027-02-01', status: 'ACTIVE', blockKind: null, lastSoldAt: '2026-11-10T08:00:00.000Z', soldBase: 12, returnedBase: 2 },
    { lotId: 'L1', lotNumber: 'A-1', expiryDate: null, status: 'BLOCKED', blockKind: 'RECALL', lastSoldAt: null, soldBase: null, returnedBase: null },
  ]);
  assert.deepEqual(customerLotHistoryOf({ lots: [] }), []);
  assert.deepEqual(customerLotHistoryOf(undefined), []);
  assert.equal(customerLotHistoryOf(Array.from({ length: 80 }, (_, i) => ({ lotId: `L${i}`, lotNumber: `N${i}`, status: 'ACTIVE' }))).length, 50);
});

test('freeReturnLotOptions: ما اشتراه العميل أولاً بترتيبه ثم تشغيلات الصنف الأخرى — كل تشغيلة مرة، ولا صنفٌ آخر', () => {
  const hist = customerLotHistoryOf([
    { lotId: 'L3', lotNumber: 'C-3', status: 'ACTIVE' }, { lotId: 'L1', lotNumber: 'A-1', status: 'ACTIVE' },
  ]);
  const lots = [
    { id: 'L1', productId: 'p1', lotNumber: 'A-1', expiryDate: '2026-12-01', status: 'ACTIVE' as const },
    { id: 'L2', productId: 'p1', lotNumber: 'B-2', expiryDate: null, status: 'BLOCKED' as const, blockKind: 'HOLD' as const },
    { id: 'Q9', productId: 'p9', lotNumber: 'Z', expiryDate: null, status: 'ACTIVE' as const },
  ];
  const o = freeReturnLotOptions(hist, lots, 'p1');
  assert.deepEqual(o.map((x) => [x.lotId, x.group]), [['L3', 'CUSTOMER'], ['L1', 'CUSTOMER'], ['L2', 'OTHER']]);
  assert.equal(o[2].blockKind, 'HOLD');
  assert.deepEqual(freeReturnLotOptions(null, null, 'p1'), [], 'لا شيء ⇒ «تلقائي» وحده');
  assert.deepEqual(freeReturnLotOptions([], lots, 'p1').map((x) => x.group), ['OTHER', 'OTHER'], 'بلا سجلّ: تشغيلات الصنف');
  // النافذة: السجلّ بصلاحية الفواتير، والقائمة الأخرى بصلاحية مخزون السيارات، و«تلقائي» الافتراضي
  const m = src('components', 'forms', 'InvoiceModal.tsx');
  assert.match(m, /queryFn: async \(\) => customerLotHistoryOf\(\(await lotsApi\.customerHistory\(\{ customerId, productId \}\)\)\.data\.data\),/);
  assert.match(m, /enabled: lotOn && !!productId && canListLots,/);
  assert.match(m, /<FreeReturnLotPicker productId=\{l\.productId\} customerId=\{customerId\} lotOn=\{lotOn\} canListLots=\{canVanStock\}/);
  assert.match(m, /<option value="">\{tr\('التشغيلة'\)\}: \{tr\('تلقائي من مبيعات العميل السابقة'\)\}<\/option>/);
  assert.match(src('api', 'client.ts'), /customerHistory: \(params: \{ customerId: string; productId: string \}\) => api\.get\('\/lots\/customer-history', \{ params \}\),/);
});

test('المرتجع المرتبط (المرحلة B): الاختيار من صفوف بند البيع المسمّاة، وفوق المتاح إرجاعه يُمنع، والجسم بلا اختيار كما كان', () => {
  const rows: SaleLotRow[] = [
    { lotId: 'L1', lotNumber: 'A-1', expiryDate: null, sold: 10, returned: 4, returnable: 6, certainty: 'CONFIRMED' },
    { lotId: 'L2', lotNumber: 'B-2', expiryDate: null, sold: 2, returned: 2, returnable: 0, certainty: 'ASSUMED' },
    { lotId: null, lotNumber: null, expiryDate: null, sold: 3, returned: 0, returnable: 3, certainty: 'UNKNOWN' },
  ];
  assert.deepEqual(linkedReturnLotChoices(rows).map((r) => r.lotId), ['L1'], 'المسمّاة وفيها ما يُرجَع');
  assert.equal(linkedReturnBaseQty({ qty: 2, retUnitFactor: 3 }), 6);
  assert.equal(linkedReturnLotProblem(rows, 'L1', 6), null);
  assert.equal(linkedReturnLotProblem(rows, 'L1', 6.0001), 'LOT_OVER_RETURNABLE');
  assert.equal(linkedReturnLotProblem(rows, 'L9', 1), 'LOT_NOT_IN_SALE');
  assert.equal(linkedReturnLotProblem(rows, '', 1), null, '«تلقائي»');
  assert.equal(linkedReturnLotProblem(rows, 'L1', 0), null, 'سطرٌ لا يُرجَع');
  const payload = { type: 'RETURN', items: [{ productId: 'p1', invoiceItemId: 's1', qty: 2 }, { productId: 'p2', invoiceItemId: 's2', qty: 1 }] };
  const lines = [{ saleItemId: 's1', qty: 2, retUnitFactor: 3 }, { saleItemId: 's2', qty: 1, retUnitFactor: 1 }];
  const out = withLinkedReturnLots(payload, lines, (sid) => (sid === 's1' ? 'L1' : undefined)) as { items: Record<string, unknown>[] };
  assert.deepEqual(out.items[0], { productId: 'p1', invoiceItemId: 's1', qty: 2, lots: [{ lotId: 'L1', qty: 6 }] });
  assert.equal(out.items[1], payload.items[1], 'البند «تلقائي» كما هو');
  assert.equal(withLinkedReturnLots(payload, lines, () => undefined), payload, 'لا اختيار ⇒ الجسم نفسه');
  // النافذة: سطر الجسم القديم باقٍ حرفاً لغير المختار، والحجب قبل الإرسال
  const m = src('components', 'forms', 'InvoiceModal.tsx');
  assert.ok(m.includes('if (linked) { mutation.mutate(buildLinkedReturnPayload(head, linked, retDec)); return; }'));
  assert.match(m, /mutation\.mutate\(withLinkedReturnLots\(buildLinkedReturnPayload\(head, linked, retDec\), linked\.lines, sid => linkedLots\[sid\]\)\);/);
  assert.match(m, /if \(bad\) \{ toast\.error\(/);
  assert.match(m, /const unlinkSale = \(\) => \{[^\n]*setLinkedLots\(\{\}\);/);
});

test('رفض تشغيلة المرتجع المرتبط من الخادم (LOT_QTY_INVALID وسببه) بلغة الواجهة — والنافذة تعيد صفوف البيع حين نقص المتاح', () => {
  const info = (reason: string) => ({ status: 422, code: 'LOT_QTY_INVALID' as const, message: 'رسالة الخادم', detail: { reason, line: 0 } });
  assert.equal(lotErrorText(info('LOT_OVER_RETURNABLE'), tr), 'الكمية أكبر من المتاح إرجاعه من هذه التشغيلة');
  assert.equal(lotErrorText(info('LOT_NOT_IN_SALE'), tr), 'التشغيلة المختارة ليست من تشغيلات بند فاتورة البيع');
  assert.equal(lotErrorText(info('OTHER'), tr), 'رسالة الخادم', 'سببٌ آخر رسالة الخادم كما كانت');
  const m = src('components', 'forms', 'InvoiceModal.tsx');
  assert.match(m, /le\.detail\?\.reason === 'LOT_OVER_RETURNABLE'\) \{[\s\S]{0,200}?void refreshLinked\(linked\);/);
});
