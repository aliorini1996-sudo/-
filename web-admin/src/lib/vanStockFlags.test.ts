import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DUP_NAME_TEXT, EXTRA_KIND_META, PRODUCT_FLAG_LABELS, VAN_MOVE_TEXT, archivedErrorOf, baseByProduct, dupNameIds, fillCode, fillNames,
  isIndeterminateError, isReplayResponse, loadOverWarehouse, movementKey, overAvailable, sendWithRefRecovery, productFlagOf, productNameKey, refFor, repRemainingView, unloadOverVan,
  vanPickList, vanRemainingOf, vanRowsTotals, warehouseAvailOf, warehouseInsufficientOf, withClientRef, withServerAvail,
} from './vanStockFlags';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');

test('حالة الصنف: «محذوف» يغلب «موقوف»، والحقول الغائبة (خادمٌ أقدم) بلا وسم', () => {
  assert.equal(productFlagOf({ archived: true, status: 'INACTIVE' }), 'ARCHIVED');
  assert.equal(productFlagOf({ deletedAt: '2026-11-01T00:00:00Z' }), 'ARCHIVED');
  assert.equal(productFlagOf({ status: 'INACTIVE' }), 'INACTIVE');
  assert.equal(productFlagOf({ status: 'ACTIVE', archived: false }), null);
  assert.equal(productFlagOf({}), null);
  assert.equal(productFlagOf(null), null);
});

test('«اسم مكرر»: الاسم بعد تطبيعه لأكثر من صنف — والمعرّف نفسه مرّتين صنفٌ واحد', () => {
  assert.equal(productNameKey('  كرتون   بيض M '), productNameKey('كرتون بيض m'));
  // UX4: مفتاح الخادم نفسه — بلا تطبيعٍ للعربية، فلا وسم حيث لم يحذّر الإنشاء
  assert.notEqual(productNameKey('أرز'), productNameKey('ارز'));
  const ids = dupNameIds([
    { id: 'old', name: 'كرتون بيض M' }, { id: 'new', name: 'كرتون  بيض m' },
    { id: 'x', name: 'سموم' }, { id: 'x', name: 'سموم' }, null, { id: 'e', name: '' },
  ]);
  assert.deepEqual([...ids].sort(), ['new', 'old']);
  assert.equal(fillCode('اسم مكرر — كود {code}', 'SP-6'), 'اسم مكرر — كود SP-6');
  assert.equal(fillCode('اسم مكرر — كود {code}', undefined), 'اسم مكرر — كود —');
});

test('منتقي التحميل: المحذوف لا يُحمَّل ويبقى تنزيلاً ما دام في السيارة، والموقوف موسومٌ يُحمَّل', () => {
  const catalog = [
    { id: 'a', name: 'ماء', status: 'ACTIVE' },
    { id: 'b', name: 'عصير', status: 'INACTIVE' },
    { id: 'c', name: 'كرتون بيض M' },
  ];
  const van = [
    { id: 'old', name: 'كرتون بيض M', archived: true, remaining: 25 },
    { id: 'gone0', name: 'لبن', archived: true, remaining: 0 },
    { id: 'a', name: 'ماء', remaining: 4 },
  ];
  const list = vanPickList(catalog, van);
  assert.deepEqual(list.map(e => [e.p.id, e.flag, e.unloadOnly, e.dup]), [
    ['a', null, false, false],
    ['b', 'INACTIVE', false, false],
    ['c', null, false, true],
    ['old', 'ARCHIVED', true, true],
  ]);
  // صنف الكتالوج المؤرشف (نافذةٌ قديمة) بلا رصيدٍ في السيارة لا يُعرض
  assert.equal(vanPickList([{ id: 'z', name: 'ز', archived: true }], []).length, 0);
});

test('D2: التحميل فوق المتاح في المستودع يُمنع — أسطر الصنف بوحداتها تُجمع، والصفر والسالب لا يُحمَّل منهما شيء', () => {
  const avail = new Map([['a', 48], ['neg', -14], ['zero', 0]]);
  // كرتون ×24 + ٢٤ حبة = ٧٢ > ٤٨
  assert.deepEqual(loadOverWarehouse([{ productId: 'a', qty: 2, factor: 24 }, { productId: 'a', qty: 24, factor: 1 }], avail),
    [{ productId: 'a', wantBase: 72, haveBase: 48 }]);
  assert.deepEqual(loadOverWarehouse([{ productId: 'a', qty: 2, factor: 24 }], avail), []);
  assert.deepEqual(loadOverWarehouse([{ productId: 'neg', qty: 1 }, { productId: 'zero', qty: 0.5 }, { productId: 'missing', qty: 1 }], avail).map(o => o.productId),
    ['neg', 'zero', 'missing']);
  // التنزيل لا يدخل حكم المستودع، والمتاح غير المعروف لا حكم له
  assert.deepEqual(loadOverWarehouse([{ productId: 'neg', qty: -5 }], avail), []);
  assert.deepEqual(loadOverWarehouse([{ productId: 'a', qty: 999 }], null), []);
  assert.deepEqual(overAvailable([{ productId: 'a', qty: 49 }], avail), [{ productId: 'a', wantBase: 49, haveBase: 48 }]);
  assert.deepEqual([...baseByProduct([{ productId: 'a', qty: 0.1, factor: 3 }, { productId: 'a', qty: 0.2, factor: 3 }], 'load')], [['a', 0.9]]);
});

test('#4: التنزيل فوق رصيد السيارة يُسمّى (يُؤكَّد) — والغائب صفر', () => {
  const rem = (id: string) => ({ a: 10, b: 3 } as Record<string, number>)[id];
  assert.deepEqual(unloadOverVan([{ productId: 'a', qty: -100 }, { productId: 'b', qty: -3 }, { productId: 'c', qty: -1 }], rem),
    [{ productId: 'a', wantBase: 100, haveBase: 10 }, { productId: 'c', wantBase: 1, haveBase: 0 }]);
  assert.deepEqual(unloadOverVan([{ productId: 'a', qty: 50 }], rem), []);
});

test('أرصدة المستودع والسيارة من صفوف الخادم — شكلٌ غير متوقَّع ⇒ لا حكم، وما ردّه 422 يغلب حتى تصل الصفوف', () => {
  assert.deepEqual([...warehouseAvailOf([{ productId: 'a', onHand: 5 }, { productId: 'b', onHand: 'x' }, null])!], [['a', 5]]);
  assert.equal(warehouseAvailOf({ rows: [] }), null);
  assert.deepEqual([...vanRemainingOf([{ productId: 'a', remaining: -2 }])!], [['a', -2]]);
  assert.equal(vanRemainingOf(undefined), null);
  assert.deepEqual([...withServerAvail(new Map([['a', 5], ['b', 1]]), new Map([['a', 2]]))!], [['a', 2], ['b', 1]]);
  assert.equal(withServerAvail(null, new Map()), null);
});

test('422 WAREHOUSE_INSUFFICIENT وPRODUCT_ARCHIVED يُقرآن بأسطرهما — وغيرهما null', () => {
  const e = { response: { status: 422, data: { success: false, code: 'WAREHOUSE_INSUFFICIENT', message: 'م', lines: [
    { index: 0, productId: 'a', availableBase: 10, requestedBase: 48 },
    { index: 1, productId: 'a', availableBase: 10, requestedBase: 48 },
    { index: 2, productId: 'b', availableBase: '-3', requestedBase: 1 },
    { productId: 7 },
  ] } } };
  assert.deepEqual(warehouseInsufficientOf(e), { message: 'م', lines: [
    { index: 0, productId: 'a', availableBase: 10, requestedBase: 48 },
    { index: 2, productId: 'b', availableBase: -3, requestedBase: 1 },
  ] });
  assert.equal(warehouseInsufficientOf({ response: { data: { code: 'OTHER' } } }), null);
  assert.equal(warehouseInsufficientOf(new Error('net')), null);
  assert.deepEqual(archivedErrorOf({ response: { data: { code: 'PRODUCT_ARCHIVED', productId: 'p', index: 3, message: 'مؤرشف' } } }),
    { productId: 'p', index: 3, message: 'مؤرشف' });
  assert.equal(archivedErrorOf({ response: { data: { code: 'WAREHOUSE_INSUFFICIENT' } } }), null);
});

test('#10: «المتبقي» الموجب والعجز منفصلاً — وخادمٌ بلا totalDeficit كما كان', () => {
  assert.deepEqual(repRemainingView({ totalRemaining: 0, totalDeficit: 40, deficitCount: 1 }), { onVan: 40, deficit: 40, deficitCount: 1 });
  assert.deepEqual(repRemainingView({ totalRemaining: 12 }), { onVan: 12, deficit: 0, deficitCount: 0 });
  assert.deepEqual(vanRowsTotals([
    { remaining: 40, expired: 2 }, { remaining: -40, damaged: 3 }, { remaining: 0, expired: -1 },
  ]), { products: 1, onVan: 40, deficitCount: 1, deficit: 40, expired: 2, damaged: 3 });
});

test('D8: المرجع واحدٌ للمحتوى نفسه (إعادةٌ بعد ضياع الردّ) وجديدٌ لمحتوى آخر — والإعادة تُعرف بـ200', () => {
  let n = 0;
  const gen = () => `ref-${++n}`;
  const body = { salesRepId: 'r', type: 'LOAD', items: [{ productId: 'a', qty: 5 }] };
  const m1 = refFor(undefined, body, gen);
  assert.equal(m1.ref, 'ref-1');
  assert.equal(refFor(m1, { ...body, items: [{ productId: 'a', qty: 5 }] }, gen), m1, 'المحتوى نفسه ⇒ المرجع نفسه');
  assert.equal(refFor(m1, { ...body, items: [{ productId: 'a', qty: 6 }] }, gen).ref, 'ref-2', 'تعديل الأسطر مستندٌ آخر');
  const sent = withClientRef(body, m1.ref) as typeof body & { clientRef?: string };
  assert.equal(sent.clientRef, 'ref-1');
  assert.equal((body as { clientRef?: string }).clientRef, undefined, 'الجسم الأصلي لا يُمسّ');
  // المولّد الافتراضي uuid يقبله الخادم (≤ ٦٤ من [A-Za-z0-9_-])
  assert.match(refFor(null, body).ref, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(isReplayResponse({ status: 200, data: { success: true } }), true);
  assert.equal(isReplayResponse({ status: 201, data: { success: true, replay: true } }), true);
  assert.equal(isReplayResponse({ status: 201, data: { success: true } }), false);
});

test('#11: المرتجع الذي لا يعود والمنتهي والإلغاء أنواعٌ بلا «+» مضلِّلة — ونوعٌ مجهول تسويةٌ إشارتها من الكمية', () => {
  assert.equal(movementKey({ kind: 'RETURN', returnToStock: false }), 'RETURN_NO_STOCK');
  assert.equal(movementKey({ kind: 'RETURN', returnExpired: true }), 'RETURN_EXPIRED');
  assert.equal(movementKey({ kind: 'RETURN' }), 'RETURN');
  assert.equal(movementKey({ kind: 'RETURN_NOT_RESTOCKED' }), 'RETURN_NO_STOCK');
  assert.equal(movementKey({ kind: 'CANCEL_SALE' }), 'SALE_CANCELLED');
  assert.equal(movementKey({ kind: 'RETURN_CANCELLED' }), 'RETURN_CANCELLED');
  assert.equal(movementKey({ kind: 'RETURN_DAMAGED' }), 'RETURN_DAMAGED');
  assert.equal(movementKey({ kind: 'SOMETHING_NEW' }), 'ADJUST');
  assert.equal(EXTRA_KIND_META.RETURN_NO_STOCK.sign, '');
  assert.equal(EXTRA_KIND_META.RETURN_CANCELLED.sign, '−');
});

test('النصوص مترجمة باللغات الأربع والمواضع تبقى في كل ترجمة', () => {
  const keys = [...Object.values(VAN_MOVE_TEXT), ...Object.values(PRODUCT_FLAG_LABELS), DUP_NAME_TEXT, ...Object.values(EXTRA_KIND_META).map(m => m.label)];
  for (const key of keys) {
    const row = PHRASES[key];
    assert.ok(row, `لا ترجمة: ${key}`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(row[lang]?.trim(), `${lang} فارغة: ${key}`);
      for (const ph of ['{names}', '{code}']) if (key.includes(ph)) assert.ok(row[lang].includes(ph), `${lang} تُسقط ${ph}: ${key}`);
    }
  }
  assert.equal(fillNames('x {names}', ['أ', '', 'ب']), 'x أ، ب');
  assert.equal(fillNames('x {names}', []), 'x —');
});

test('الشاشتان: التحميل فوق المستودع لا يُحفظ، وكل وثيقةٍ بمرجعها، والحركة تُبطل أرصدة المستودع', () => {
  for (const f of [read('pages', 'VanStockPage.tsx'), read('m', 'MRepLoad.tsx')]) {
    assert.match(f, /warehouseInsufficientOf\(e\)/, 'ردّ 422 WAREHOUSE_INSUFFICIENT غير مقروء');
    assert.match(f, /archivedErrorOf\(e\)/);
    assert.equal((f.match(/const ref = refs\.current\.(load|unload)\.ref;/g) ?? []).length, 2, 'وثيقتا التحميل والتنزيل بمرجعهما');
    // F1: ردٌّ ضاع ⇒ يُسأل الخادم عن المرجع نفسه قبل أن يُظنّ الحفظ فاشلاً، والإعادة بالمحتوى نفسه لا يحجبها فحص المستودع
    assert.equal((f.match(/sendWithRefRecovery\(\(\) => vanStockApi\.createLoad\(withClientRef\(body, ref\)\), \(\) => vanStockApi\.loadsByClientRef\(ref, /g) ?? []).length, 2);
    assert.match(f, /if \(isIndeterminateError\(e\)\) setUncertain\(true\);/);
    assert.match(f, /uncertain \? \[\] : loadOverWarehouse\(moveLines, whAvail, whPartial\)/);
    assert.match(f, /refs\.current\.load = undefined;/, 'المرجع يُنسى بعد النجاح');
    assert.match(f, /STOCK_CACHE_KEYS/, '#20: أرصدة المستودع تُبطَل بعد الحركة');
    assert.match(f, /loadOverWarehouse\(moveLines, whAvail, whPartial\)/);
    assert.doesNotMatch(f, /WAREHOUSE_SHORT\b|warehouseShortOf/, 'التحذير القديم (لا يمنع) عاد');
  }
  const page = read('pages', 'VanStockPage.tsx');
  assert.match(page, /!vanPending && !whPending && overWhIds\.size === 0/, 'زرّ الحفظ لا يُعطَّل فوق المستودع');
  assert.match(page, /qc\.setQueriesData<SummaryBody>\(\{ queryKey: \['van-summary'\] \}/, 'التحديث المتفائل لا يصيب مفاتيح الملخّص');
  const m = read('m', 'MRepLoad.tsx');
  assert.match(m, /disabled=\{!hasMovement \|\| lotBlocked \|\| stockBlocked \|\| save\.isPending\}/);
});

test('نافذة الفاتورة: المرتجع بمرجع محاولته (D8)، والبيع يعرض متاح السيارة ويُؤكَّد فوقه (#17) — والبيع جسمه كما كان', () => {
  const s = read('components', 'forms', 'InvoiceModal.tsx').replace(/\r\n/g, '\n');
  assert.match(s, /if \(\(data as \{ type\?: string \} \| null\)\?\.type !== 'RETURN'\) return invoiceApi\.create\(data\);/, 'البيع بلا مرجع');
  assert.match(s, /retRef\.current = refFor\(retRef\.current, data\);\n\s+return invoiceApi\.create\(withClientRef\(data as object, retRef\.current\.ref\)\);/);
  assert.match(s, /retRef\.current = undefined;/, 'المرجع يُنسى بعد النجاح');
  assert.match(s, /overAvailable\(lines\.filter\(l => !trackedIds\.has\(l\.productId\)\)/, 'المتتبَّع بمنتقي تشغيلته لا بهذا التلميح');
  assert.match(s, /if \(vanShort\.length && !vanShortOk\.current\) \{ setAskVanShort\(true\); return; \}/);
  assert.match(s, /onConfirm=\{\(\) => \{ vanShortOk\.current = true; handleSubmit\(\); \}\}/);
});

test('D9: عهدة المناديب المحذوفين ظاهرةٌ وتُستلم، وسجلّ التحميلات يقول «مندوب محذوف»', () => {
  const page = read('pages', 'VanStockPage.tsx');
  assert.match(page, /deletedTools: Array\.isArray\(body\.deletedTools\)/, 'إضافةٌ قد تغيب (خادمٌ أقدم ⇒ [])');
  assert.match(page, /<ToolsModal deleted repId=\{toolsGone\.deletedSalesRepId\}/);
  assert.match(page, /disabled=\{\(t === 'RETURN' && balances\.length === 0\) \|\| \(t === 'ISSUE' && deleted\)\}/, 'لا تسليم لمندوبٍ محذوف');
  assert.match(read('components', 'VanLoadsLog.tsx'), /deletedSalesRepId \? <span className="text-\[#9A8F7E\]">\{tr\('مندوب محذوف'\)\}<\/span>/);
});

test('F1: ردٌّ ضاع بعد الالتزام — السؤال بالمرجع يجد الحركة فتُعامَل إعادةً (200 replay)؛ وغائبةٌ أو تعذّر السؤال ⇒ الخطأ الأصلي', async () => {
  const lost = Object.assign(new Error('Network Error'), { response: undefined });
  const ok = await sendWithRefRecovery(async () => { throw lost; }, async () => [{ id: 'L1' }]);
  assert.equal(isReplayResponse(ok), true);
  assert.deepEqual((ok as { data: { data: unknown } }).data.data, { id: 'L1' });
  await assert.rejects(sendWithRefRecovery(async () => { throw lost; }, async () => []), (e) => e === lost);
  await assert.rejects(sendWithRefRecovery(async () => { throw lost; }, async () => { throw new Error('offline'); }), (e) => e === lost);
  // 4xx جوابٌ حاسم: لا سؤال
  let asked = 0;
  const e422 = { response: { status: 422, data: { code: 'WAREHOUSE_INSUFFICIENT' } } };
  await assert.rejects(sendWithRefRecovery(async () => { throw e422; }, async () => { asked++; return [{}]; }), (e) => e === e422);
  assert.equal(asked, 0);
  // 502/504 من الوكيل بلا جواب حاسم ⇒ يُسأل
  assert.equal(isIndeterminateError({ response: { status: 504 } }), true);
  assert.equal(isIndeterminateError({ response: { status: 409 } }), false);
  assert.equal(isIndeterminateError(new Error('x')), true);
  // النجاح كما هو
  assert.deepEqual(await sendWithRefRecovery(async () => ({ status: 201 }), async () => []), { status: 201 });
});

test('UX6: خريطةٌ جزئية (ما ردّه الخادم وحده وصفوف المستودع لم تصل) لا تحكم على الغائب منها', () => {
  const server = withServerAvail(null, new Map([['a', 2]]))!;
  const lines = [{ productId: 'a', qty: 5 }, { productId: 'b', qty: 9 }];
  assert.deepEqual(loadOverWarehouse(lines, server, true).map((o) => o.productId), ['a']);
  assert.deepEqual(loadOverWarehouse(lines, server).map((o) => o.productId), ['a', 'b'], 'الكاملة: الغائب صفر كما كان');
});
