import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRICE_RULES_AFFECTED_TEXT, PRICE_RULES_UNIT_ACK_CODE, PRICE_RULES_UNIT_ACK_MESSAGE, PriceRulesAckDeclined, isPriceRulesAckDeclined,
  priceRulesAckAsker, priceRulesAckOf, priceRulesAffectedOf, withPriceRulesAck,
} from './priceListEditor';

/**
 * «قوائم الأسعار» (قرار D2، ٥ نوفمبر ٢٠٢٦): سعر الفئة الثابت والحدّ الأدنى للكمية بالوحدة الرئيسية لكل صنف — فكتابةٌ تغيّر حجمها
 * لصنفٍ تشمله قاعدةٌ كهذه يردّها الخادم 409 PRICE_RULES_UNIT_ACK، وتسأل نافذة الصنف و/m بنصّه (window.confirm بـtr) ثم تعيد الطلب
 * نفسه بـacknowledgePriceRules: true. والرفض لا يكتب شيئاً ولا يُقال خطأً. ومعاينة «إضافة وحدة فرعية أصغر» تقول عددها.
 */
const ackErr = (data: Record<string, unknown>) => Object.assign(new Error('409'), { response: { status: 409, data } });
const ACK = ackErr({ success: false, code: PRICE_RULES_UNIT_ACK_CODE, message: PRICE_RULES_UNIT_ACK_MESSAGE, rulesCount: 2 });

test('رفض الإقرار مفهوم: الرمز ونصّ الخادم وعدد القواعد، وغيره null', () => {
  assert.deepEqual(priceRulesAckOf(ACK), { message: PRICE_RULES_UNIT_ACK_MESSAGE, rulesCount: 2 });
  assert.deepEqual(priceRulesAckOf(ackErr({ code: PRICE_RULES_UNIT_ACK_CODE })), { message: PRICE_RULES_UNIT_ACK_MESSAGE, rulesCount: null },
    'ردٌّ بلا رسالة ⇒ النصّ الثابت');
  assert.equal(priceRulesAckOf(ackErr({ code: 'PRIMARY_UNIT_CHANGED', message: 'x' })), null);
  assert.equal(priceRulesAckOf(new Error('network')), null);
  assert.equal(priceRulesAckOf(null), null);
  // النصّ كما في القرار حرفاً (مفتاحٌ في القاموس): الشرطة الطويلة U+2014 وبلا تشكيل
  assert.equal(PRICE_RULES_UNIT_ACK_MESSAGE,
    'هذا الصنف تشمله قواعد في قوائم الأسعار محسوبة بوحدته الرئيسية (سعر فئة أو حد أدنى للكمية) وتغيير الوحدة الرئيسية يغير معناها — أكد للمتابعة');
  assert.doesNotMatch(PRICE_RULES_UNIT_ACK_MESSAGE + PRICE_RULES_AFFECTED_TEXT, /[ً-ْ]/, 'بلا تشكيل كبقية المفاتيح');
});

test('withPriceRulesAck: الطلب كما هو، و٤٠٩ الإقرار ⇒ سؤالٌ بنصّ الخادم ثم الطلب نفسه بالإقرار مرّةً واحدة', async () => {
  const calls: string[] = [];
  const asked: string[] = [];
  // لا ٤٠٩: الطلب وحده بلا سؤال
  assert.equal(await withPriceRulesAck(async () => { calls.push('first'); return 1; }, async () => { calls.push('acked'); return 2; },
    (m) => { asked.push(m); return true; }), 1);
  assert.deepEqual([calls, asked], [['first'], []]);
  // ٤٠٩ ونعم ⇒ الطلب بالإقرار
  calls.length = 0;
  assert.equal(await withPriceRulesAck(async () => { calls.push('first'); throw ACK; }, async () => { calls.push('acked'); return 2; },
    (m) => { asked.push(m); return true; }), 2);
  assert.deepEqual(calls, ['first', 'acked']);
  assert.deepEqual(asked, [PRICE_RULES_UNIT_ACK_MESSAGE], 'السؤال بنصّ الخادم');
  // ٤٠٩ ولا ⇒ PriceRulesAckDeclined ولا طلب ثانٍ
  calls.length = 0;
  await assert.rejects(
    withPriceRulesAck(async () => { calls.push('first'); throw ACK; }, async () => { calls.push('acked'); return 2; }, () => false),
    (e: unknown) => isPriceRulesAckDeclined(e) && e instanceof PriceRulesAckDeclined,
  );
  assert.deepEqual(calls, ['first'], 'الرفض لا يكتب شيئاً');
  // خطأٌ آخر يُرمى كما هو بلا سؤال
  const other = ackErr({ code: 'BASE_UNIT_CHANGED', message: 'تغيرت' });
  let askedOther = false;
  await assert.rejects(withPriceRulesAck(async () => { throw other; }, async () => 2, () => { askedOther = true; return true; }), (e: unknown) => e === other);
  assert.equal(askedOther, false);
  // وخطأ الطلب الثاني (سباقٌ مع تحويل) يُرمى كما هو — لا سؤال ثانٍ ولا حلقة
  let n = 0;
  await assert.rejects(withPriceRulesAck(async () => { throw ACK; }, async () => { throw other; }, () => { n += 1; return true; }), (e: unknown) => e === other);
  assert.equal(n, 1);
  assert.equal(isPriceRulesAckDeclined(new Error('x')), false);
});

test('السؤال بلغة الواجهة، ومعاينة التحويل تقول عدد القواعد (غائبٌ أو تالف ⇒ صفر)', () => {
  const shown: string[] = [];
  const ask = priceRulesAckAsker((s) => `«${s}»`, (s) => { shown.push(s); return false; });
  assert.equal(ask(PRICE_RULES_UNIT_ACK_MESSAGE), false);
  assert.deepEqual(shown, [`«${PRICE_RULES_UNIT_ACK_MESSAGE}»`]);
  assert.equal(priceRulesAffectedOf({ dryRun: true, priceRulesAffected: 3 }), 3);
  assert.equal(priceRulesAffectedOf({ dryRun: true }), 0, 'خادمٌ لا يقولها (لا قواعد تتبدّل) ⇒ المعاينة كما كانت');
  assert.equal(priceRulesAffectedOf({ priceRulesAffected: 'x' }), 0);
  assert.equal(priceRulesAffectedOf({ priceRulesAffected: -1 }), 0);
  assert.equal(priceRulesAffectedOf(null), 0);
  assert.ok(PRICE_RULES_AFFECTED_TEXT.includes('{n}'));
});

// ═══ حرّاس نصّية: كل كتابةٍ تغيّر الرئيسية في نافذة الصنف وصفحتها و/m تمرّ بـwithPriceRulesAck بالطلب نفسه ═══
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const count = (s: string, sub: string) => s.split(sub).length - 1;

test('نافذة الصنف: التبديل والإضافة الرئيسية والمعامل والإيقاف والحذف والتحويل — الطلب نفسه ثم بالإقرار، والرفض صامت', () => {
  const s = read('components', 'forms', 'ProductModal.tsx');
  const pairs: Array<[string, string]> = [
    ['productApi.setPrimaryUnit(product.id, { unitId, expectedPrimaryUnitId: primaryUnitId })',
      'productApi.setPrimaryUnit(product.id, { unitId, expectedPrimaryUnitId: primaryUnitId, acknowledgePriceRules: true })'],
    ['productApi.addUnit(productId, { ...unitFormPayload(adding), ...(addPrimary && { makePrimary: true }), expectedBaseName: baseUnit })',
      'productApi.addUnit(productId, { ...unitFormPayload(adding), ...(addPrimary && { makePrimary: true }), expectedBaseName: baseUnit, acknowledgePriceRules: true })'],
    ['productApi.updateUnit(productId, u.id, { ...unitFormPayload(editing), expectedBaseName: baseUnit })',
      'productApi.updateUnit(productId, u.id, { ...unitFormPayload(editing), expectedBaseName: baseUnit, acknowledgePriceRules: true })'],
    ['withRepRuleSync(() => productApi.updateUnit(productId, u.id, body))',
      'withRepRuleSync(() => productApi.updateUnit(productId, u.id, { ...body, acknowledgePriceRules: true }))'],
    ['productApi.removeUnit(productId, u.id, { clearPrimary: true, expectedBaseName: baseUnit })',
      'productApi.removeUnit(productId, u.id, { ...(clearing && { clearPrimary: true }), expectedBaseName: baseUnit, acknowledgePriceRules: true })'],
  ];
  for (const [first, acked] of pairs) {
    const i = s.indexOf(first);
    const j = s.indexOf(acked);
    assert.ok(i > 0 && j > i, `الطلب ثم إعادته بالإقرار: ${first}`);
    assert.ok(s.lastIndexOf('withPriceRulesAck(', i) > s.lastIndexOf(';', i), `داخل withPriceRulesAck: ${first}`);
  }
  assert.equal(count(s, 'withPriceRulesAck('), 6, 'ستة مواضع: التبديل وأربع كتابات وحدات والتحويل');
  assert.ok(s.includes('const run = (ackRules: boolean) => productApi.convertBase(productId, {'));
  assert.ok(s.includes('...(ackRules && { acknowledgePriceRules: true }),'));
  assert.ok(s.includes('await withPriceRulesAck(() => run(false), () => run(true), priceRulesAckAsker(tr));'));
  // الرفض: لا رسالة خطأ ولا إعادة جلب
  assert.ok(s.includes('if (isPriceRulesAckDeclined(err)) { /* رفض سؤال القواعد: لا شيء كُتب */ }'));
  assert.match(s, /const fail = \(err: unknown, fallback: string\) => \{\n\s*if \(isPriceRulesAckDeclined\(err\)\) return;/);
  assert.ok(s.includes('if (isPriceRulesAckDeclined(err)) { setBusy(false); return; }'));
  // معاينة التحويل تقول عدد القواعد التي يتبدّل معناها
  assert.ok(s.includes('const rulesAffected = priceRulesAffectedOf(fresh);'));
  assert.ok(s.includes('{fill(tr(PRICE_RULES_AFFECTED_TEXT), { n: formatNumber(rulesAffected) })}'));
  // D6: كتابات الوحدات والتحويل تُبطل جدول القائمة وقواعدها وقواعد الفاتورة (في المساعدَين كليهما)
  for (const k of ["['price-list-items']", "['price-list-rules-of']", "['price-list-rules']"]) {
    assert.equal(count(s, `qc.invalidateQueries({ queryKey: ${k} });`), 2, k);
  }
  // D5: النافذة تقرأ القوائم بلا عدّادات، وعدد قواعد القائمة المختارة من مفتاح اللوحة حين تُختار وحدها
  assert.ok(s.includes("queryKey: ['price-lists'],\n    queryFn: async () => priceListsOf((await priceListApi.list()).data.data),"));
  assert.ok(s.includes("queryKey: ['price-lists', 'counts'],\n    queryFn: async () => priceListsOf((await priceListApi.listWithCounts()).data.data),\n    enabled: !!activeList,"));
});

test('صفحة الأصناف: حفظ الصنف (رقعة الرئيسية) بالإقرار بعد السؤال، والرفض يُبقي النافذة، والنجاح يُبطل قواعد القوائم', () => {
  const s = read('pages', 'ProductsPage.tsx');
  assert.ok(s.includes('const res = await withPriceRulesAck(\n        () => productApi.update(selected.id, values),\n        () => productApi.update(selected.id, { ...values, acknowledgePriceRules: true }),\n        priceRulesAckAsker(tr));'));
  assert.match(s, /onError: \(err: unknown, values\) => \{\n[^\n]*\n\s*if \(isPriceRulesAckDeclined\(err\)\) return;/);
  assert.ok(s.includes("qc.invalidateQueries({ queryKey: ['price-list-rules-of'] }); qc.invalidateQueries({ queryKey: ['price-list-rules'] });"));
});

test('/m: حفظ الصنف والتبديل وكتابات الوحدات والتحويل بالإقرار بعد السؤال، والمعاينة تقول العدد، والإبطال يشمل قواعد القوائم', () => {
  const s = read('m', 'MProducts.tsx');
  for (const [first, acked] of [
    ['() => productApi.update(product.id, payload)', '() => productApi.update(product.id, { ...payload, acknowledgePriceRules: true })'],
    ['productApi.setPrimaryUnit(product!.id, { unitId, expectedPrimaryUnitId: livePrimaryId })',
      'productApi.setPrimaryUnit(product!.id, { unitId, expectedPrimaryUnitId: livePrimaryId, acknowledgePriceRules: true })'],
    ['() => productApi.updateUnit(product.id, u.id, body)', '() => productApi.updateUnit(product.id, u.id, { ...body, acknowledgePriceRules: true })'],
    ['productApi.removeUnit(product.id, u.id, { ...(u.id === p.primaryUnitId && { clearPrimary: true }), expectedBaseName: p.unit })',
      'productApi.removeUnit(product.id, u.id, { ...(u.id === p.primaryUnitId && { clearPrimary: true }), expectedBaseName: p.unit, acknowledgePriceRules: true })'],
    ['productApi.setPrimaryUnit(product.id, { unitId: u.id, expectedPrimaryUnitId: p.primaryUnitId ?? null })',
      'productApi.setPrimaryUnit(product.id, { unitId: u.id, expectedPrimaryUnitId: p.primaryUnitId ?? null, acknowledgePriceRules: true })'],
    ['productApi.updateUnit(product.id, unit.id, { ...body, expectedBaseName: product.unit })',
      'productApi.updateUnit(product.id, unit.id, { ...body, expectedBaseName: product.unit, acknowledgePriceRules: true })'],
    ['productApi.addUnit(product.id, { ...body, expectedBaseName: product.unit, ...(asPrimary && { makePrimary: true }) })',
      'productApi.addUnit(product.id, { ...body, expectedBaseName: product.unit, ...(asPrimary && { makePrimary: true }), acknowledgePriceRules: true })'],
    ['productApi.convertBase(product.id, subUnitBody(d, cur, { acknowledgeErp: ackErp, acknowledgeApi: ackApi }))',
      'productApi.convertBase(product.id, { ...subUnitBody(d, cur, { acknowledgeErp: ackErp, acknowledgeApi: ackApi }), acknowledgePriceRules: true })'],
  ] as Array<[string, string]>) {
    const i = s.indexOf(first);
    const j = s.indexOf(acked);
    assert.ok(i > 0 && j > i, `الطلب ثم إعادته بالإقرار: ${first}`);
    assert.ok(s.lastIndexOf('withPriceRulesAck(', i) > s.lastIndexOf(';', i), `داخل withPriceRulesAck: ${first}`);
  }
  assert.equal(count(s, 'withPriceRulesAck('), 8, 'ثمانية مواضع: الحفظ والتبديلان والإيقاف والحذف وتعديل الوحدة وإضافتها والتحويل');
  // كل معالج خطأٍ لهذه الكتابات يعرف الرفض (الحفظ، التبديل، شاشة الوحدات، ورقة الوحدة، التحويل)
  assert.equal(count(s, 'if (isPriceRulesAckDeclined(e)) return;'), 5);
  assert.ok(s.includes('const rulesAffected = priceRulesAffectedOf(shown);'));
  assert.ok(s.includes('{fill(tr(PRICE_RULES_AFFECTED_TEXT), { n: formatNumber(rulesAffected) })}'));
  assert.ok(s.includes("['m-products', 'm-inv-products', 'm-van-products', 'm-wh-products', 'products', 'price-list-rules', 'price-list-items', 'price-list-rules-of']"));
});

test('نصّ الإقرار هو نصّ الخادم حرفاً (وإلا لم يُترجم السؤال)', () => {
  const dir = path.resolve(process.cwd(), '..', 'backend', 'src');
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(d, e.name);
    return e.isDirectory() ? (e.name === 'tests' ? [] : walk(f)) : (/\.ts$/.test(e.name) ? [f] : []);
  });
  const hit = walk(dir).some((f) => fs.readFileSync(f, 'utf8').includes(PRICE_RULES_UNIT_ACK_MESSAGE));
  assert.ok(hit, 'رسالة 409 PRICE_RULES_UNIT_ACK في الخادم تختلف عن مفتاح الواجهة');
});
