/**
 * سلّة «منيو المنتجات» (طلب المالك ٢٤ نوفمبر ٢٠٢٦): منطق السلّة الصرف مقيَّماً (الوحدة الافتراضية، والإضافة والعدّاد والحدود،
 * والإجمالي بمعادلة البطاقة حرفاً، وجسم الطلب، ومرجع الإعادة الآمنة، والحفظ المحلي بتخزينٍ مزيّف أو رامٍ)، ثم حرّاسٌ نصّية على
 * الصفحة (React والمتصفّح): السلّة خلف علم الخادم، و«أضف» و«إتمام الطلب» و«إرسال الطلب»، والفخّ، وخانة الجوال، والمسار.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CART_MAX_LINES, CART_MAX_QTY, ORDER_NAME_MAX, ORDER_NOTE_MAX, ORDER_PHONE_MAX, ORDER_PHONE_MIN,
  catalogGross, cartLineKey, cartQty, cartStorageKey, cartUnitOptions, checkoutProblem, cleanCheckout, defaultUnitId,
  formatQty, loadCart, normalizeQty, orderDraft, orderFailure, orderSignature, parseQtyInput, pickClientRef, pickedUnitId,
  reconcileCart, resolveCart, sanitizeCart, saveCart, setCartQty, stepCartQty,
  type CartLine, type CartProductLike, type CartStorage, type CheckoutForm,
} from './catalogCart';
import { CardOrder, CatalogPrices, CheckoutSheet, OrderDone } from '../pages/CatalogPage';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const page = () => read('pages', 'CatalogPage.tsx');

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const CTN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// عصير بوحدتين (الكرتون رئيسية) وماء بلا وحدات
const juice: CartProductLike = {
  id: P1, name: 'عصير', unit: 'حبة', basePrice: 2, taxPct: 15,
  units: [{ id: CTN, name: 'كرتون', factor: 24, price: 45, isPrimary: true }, { id: PAL, name: 'طبلية', factor: 1200, price: 2000 }],
};
const water: CartProductLike = { id: P2, name: 'ماء', unit: 'حبة', basePrice: 1.1, taxPct: 15, units: [] };
const products = [juice, water];

const form = (over: Partial<CheckoutForm> = {}): CheckoutForm => ({ name: 'محمد أحمد', phone: '0555123456', note: '', website: '', ...over });

function memStorage(init: Record<string, string> = {}): CartStorage & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}
const throwing: CartStorage = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

// ═══ الوحدات ═══

test('منتقي الوحدة: الرئيسية أولاً ثم الأساس ثم البقية — وبلا رئيسية الأساس أولاً؛ والافتراضية الرئيسية وإلا الأساس', () => {
  assert.deepEqual(cartUnitOptions(juice).map(o => [o.unitId, o.name, o.price]), [[CTN, 'كرتون', 45], [null, 'حبة', 2], [PAL, 'طبلية', 2000]]);
  assert.equal(defaultUnitId(juice), CTN);
  const noPrimary = { ...juice, units: juice.units!.map(u => ({ ...u, isPrimary: undefined })) };
  assert.deepEqual(cartUnitOptions(noPrimary).map(o => o.unitId), [null, CTN, PAL]);
  assert.equal(defaultUnitId(noPrimary), null, 'بلا رئيسية: الأساس');
  assert.deepEqual(cartUnitOptions(water).map(o => o.unitId), [null], 'صنفٌ بلا وحدات: الأساس وحده (لا منتقي)');
  // خادمٌ أقدم بلا معرّف وحدة: لا تُعرض خياراً ولا تكون افتراضية
  const old = { ...juice, units: [{ name: 'كرتون', factor: 24, price: 45, isPrimary: true }] };
  assert.deepEqual(cartUnitOptions(old).map(o => o.unitId), [null]);
  assert.equal(defaultUnitId(old), null);
});

test('الوحدة المختارة في البطاقة: اختيار الجلسة الصالح ← وحدة الصنف في السلّة ← الافتراضية', () => {
  assert.equal(pickedUnitId(juice, [], {}), CTN);
  assert.equal(pickedUnitId(juice, [{ productId: P1, unitId: null, qty: 3 }], {}), null, 'سلّةٌ محفوظة بالحبة تُظهر عدّاد الحبة');
  assert.equal(pickedUnitId(juice, [{ productId: P1, unitId: null, qty: 3 }], { [P1]: PAL }), PAL);
  assert.equal(pickedUnitId(juice, [], { [P1]: null }), null, 'null اختيارٌ صريح للأساس لا غياب');
  assert.equal(pickedUnitId(juice, [], { [P1]: 'gone' }), CTN, 'وحدةٌ لم تعد خياراً تعود للافتراضية');
});

// ═══ العدّاد والحدود ═══

test('أضف و+ و−: الصنف بوحدتين سطران، و− من ١ يحذف، والتعيين بصفرٍ يحذف', () => {
  let c: CartLine[] = [];
  c = stepCartQty(c, P1, CTN, 1);
  c = stepCartQty(c, P1, CTN, 1);
  c = stepCartQty(c, P1, null, 1);
  assert.deepEqual(c, [{ productId: P1, unitId: CTN, qty: 2 }, { productId: P1, unitId: null, qty: 1 }]);
  assert.equal(cartQty(c, P1, CTN), 2);
  assert.equal(cartQty(c, P2, null), 0);
  assert.notEqual(cartLineKey(P1, CTN), cartLineKey(P1, null));
  c = stepCartQty(c, P1, null, -1);
  assert.deepEqual(c, [{ productId: P1, unitId: CTN, qty: 2 }]);
  c = setCartQty(c, P1, CTN, 0);
  assert.deepEqual(c, []);
  const same = [{ productId: P1, unitId: CTN, qty: 2 }];
  assert.equal(setCartQty(same, P1, CTN, 2), same, 'لا تغيير = المصفوفة نفسها (لا إعادة رسمٍ بلا سبب)');
  assert.equal(setCartQty(same, P2, null, 0), same, 'حذف ما ليس في السلّة لا يغيّرها');
});

test('حدود الخادم: الكمية ≤ ١٠٠٠٠٠ بثلاث خانات، و١٠٠ سطر', () => {
  assert.equal(normalizeQty(1.23456), 1.235);
  assert.equal(normalizeQty(CART_MAX_QTY + 5), CART_MAX_QTY);
  assert.equal(normalizeQty(-2), 0);
  assert.equal(normalizeQty(NaN), 0);
  let c: CartLine[] = [];
  for (let i = 0; i < CART_MAX_LINES + 5; i++) c = stepCartQty(c, `p${i}`, null, 1);
  assert.equal(c.length, CART_MAX_LINES, 'السطر بعد المئة لا يُضاف');
  assert.equal(CART_MAX_LINES, 100);
  assert.equal(CART_MAX_QTY, 100000);
});

test('خانة الكمية: الأرقام العربية والفاصلة العربية تُقرأ، والعبث صفر، والعرض يُقرأ كما هو', () => {
  assert.equal(parseQtyInput('١٢'), 12);
  assert.equal(parseQtyInput('۳'), 3);
  assert.equal(parseQtyInput('2.5'), 2.5);
  assert.equal(parseQtyInput('٢٫٥'), 2.5);
  assert.equal(parseQtyInput('2,5'), 2.5);
  assert.equal(parseQtyInput(''), 0);
  assert.equal(parseQtyInput('abc'), 0);
  assert.equal(parseQtyInput('1e5'), 0);
  assert.equal(parseQtyInput('-3'), 0);
  assert.equal(parseQtyInput('999999'), CART_MAX_QTY);
  for (const q of [1, 12, 1500, 2.5, 0.125, 100000]) assert.equal(parseQtyInput(formatQty(q)), q, `formatQty(${q}) = «${formatQty(q)}»`);
});

// ═══ الإجمالي ═══

test('الإجمالي التقريبي: سعر وحدة السطر شاملاً الضريبة بمعادلة البطاقة × الكمية، وأسطرٌ لم تعد في المنيو تسقط', () => {
  const cart: CartLine[] = [
    { productId: P1, unitId: CTN, qty: 2 },
    { productId: P2, unitId: null, qty: 3 },
    { productId: 'gone', unitId: null, qty: 1 },
    { productId: P1, unitId: 'gone-unit', qty: 1 },
  ];
  const r = resolveCart(cart, products, { dec: 2, taxOff: false });
  assert.equal(r.count, 2);
  assert.deepEqual(r.lines.map(l => [l.name, l.unitLabel, l.netPrice, l.grossUnit, l.lineTotal]), [
    ['عصير', 'كرتون (24 حبة)', 45, 51.75, 103.5],
    ['ماء', 'حبة', 1.1, 1.27, 3.81],
  ]);
  assert.equal(r.total, 107.31);
  // «إزالة الضريبة»: السعر المكتوب هو السعر
  const off = resolveCart(cart, products, { dec: 2, taxOff: true });
  assert.deepEqual(off.lines.map(l => [l.taxPct, l.grossUnit, l.lineTotal]), [[0, 45, 90], [0, 1.1, 3.3]]);
  assert.equal(off.total, 93.3);
  // عملةٌ بثلاث خانات
  const kwd = resolveCart([{ productId: P2, unitId: null, qty: 3 }], [{ ...water, basePrice: 1.0505 }], { dec: 3, taxOff: false });
  assert.equal(kwd.lines[0].grossUnit, 1.208); // 1.208075 نصف-لأعلى بثلاث خانات
  assert.equal(kwd.total, 3.624);
});

test('معادلة السلّة = سعر البطاقة حرفاً: CatalogPrices تعرض catalogGross نفسه (مصدرٌ واحد)', () => {
  const html = renderToStaticMarkup(createElement(CatalogPrices, { p: juice, brand: '#E15A30', dec: 2, sym: 'ر.س' }));
  for (const price of [45, 2, 2000]) {
    const shown = catalogGross(price, 15, 2).toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    assert.ok(html.includes(shown), `سعر ${price} في البطاقة`);
  }
  const s = page();
  assert.ok(s.includes('const gross = (price: number) => catalogGross(price, p.taxPct, dec);'), 'البطاقة لا تستعمل المعادلة المشتركة');
  assert.ok(!s.includes("from '../rep/invoiceCalc'"), 'معادلةٌ ثانية في الصفحة');
});

test('مطابقة السلّة المحفوظة بالمنيو الحالي: الساقط يُحذف والسليمة تبقى كما هي', () => {
  const cart: CartLine[] = [{ productId: P1, unitId: CTN, qty: 1 }, { productId: P2, unitId: PAL, qty: 1 }];
  assert.deepEqual(reconcileCart(cart, products), [{ productId: P1, unitId: CTN, qty: 1 }], 'وحدة صنفٍ آخر لا تُقبل');
  const ok = [{ productId: P2, unitId: null, qty: 1 }];
  assert.equal(reconcileCart(ok, products), ok);
  assert.deepEqual(reconcileCart(ok, [{ ...water, id: undefined }]), [], 'منيو خادمٍ أقدم بلا معرّفات: لا سلّة');
});

// ═══ الإرسال ═══

test('فحص الإتمام قبل الخادم: السلّة والاسم والجوال (بالأرقام العربية) والملاحظة', () => {
  assert.equal(checkoutProblem(form(), 1), null);
  assert.match(checkoutProblem(form(), 0)!, /السلة فارغة/);
  assert.match(checkoutProblem(form({ name: ' م ' }), 1)!, /اسمك/);
  assert.match(checkoutProblem(form({ name: 'م'.repeat(ORDER_NAME_MAX + 1) }), 1)!, /اسمك/);
  assert.match(checkoutProblem(form({ phone: '' }), 1)!, /جوال/);
  assert.match(checkoutProblem(form({ phone: '12345' }), 1)!, /جوال/, 'خمسة أرقام لا يتواصل بها المندوب');
  assert.match(checkoutProblem(form({ phone: '1'.repeat(ORDER_PHONE_MAX + 1) }), 1)!, /جوال/);
  assert.equal(checkoutProblem(form({ phone: '٠٥٥٥١٢٣٤٥٦' }), 1), null, 'لوحة مفاتيح عربية');
  assert.equal(checkoutProblem(form({ phone: '+966 55 512 3456' }), 1), null);
  assert.match(checkoutProblem(form({ note: 'x'.repeat(ORDER_NOTE_MAX + 1) }), 1)!, /الملاحظة/);
  assert.equal(ORDER_PHONE_MIN, 5);
});

test('جسم الطلب: حقولٌ نظيفة، والجوال لاتيني، وبلا أسعار، والملاحظة والفخّ يغيبان فارغين', () => {
  const cart: CartLine[] = [{ productId: P1, unitId: CTN, qty: 2 }, { productId: 'gone', unitId: null, qty: 1 }, { productId: P2, unitId: null, qty: 1.5 }];
  const d = orderDraft(form({ name: '  محمد   أحمد ', phone: ' ٠٥٥٥١٢٣٤٥٦ ', note: '  بعد العصر  ' }), cart, products);
  assert.deepEqual(d, {
    name: 'محمد أحمد', phone: '0555123456', note: 'بعد العصر',
    items: [{ productId: P1, unitId: CTN, qty: 2 }, { productId: P2, unitId: null, qty: 1.5 }],
  });
  assert.ok(!JSON.stringify(d).includes('price'), 'السعر لا يُرسَل — الخادم يلتقطه من القاعدة');
  const plain = orderDraft(form(), cart, products);
  assert.ok(!('note' in plain) && !('website' in plain));
  assert.equal(orderDraft(form({ website: 'http://spam' }), cart, products).website, 'http://spam', 'الروبوت يُرسَل فخّه فيردّ الخادم بنجاحٍ وهميّ');
  assert.deepEqual(cleanCheckout(form({ phone: '۰۵۵ ۵۱۲' })).phone, '055 512');
});

test('مرجع الإعادة الآمنة: الجسم نفسه يعيد المرجع نفسه، وتغيّر السلّة أو البيانات يولّد مرجعاً جديداً', () => {
  let n = 0;
  const gen = () => `ref-${++n}`;
  const cart: CartLine[] = [{ productId: P1, unitId: CTN, qty: 2 }];
  const sig1 = orderSignature(orderDraft(form(), cart, products));
  const a = pickClientRef(null, sig1, gen);
  assert.deepEqual(a, { sig: sig1, ref: 'ref-1' });
  assert.equal(pickClientRef(a, orderSignature(orderDraft(form(), cart, products)), gen), a, 'إعادة المحاولة');
  const sig2 = orderSignature(orderDraft(form(), stepCartQty(cart, P1, CTN, 1), products));
  assert.deepEqual(pickClientRef(a, sig2, gen), { sig: sig2, ref: 'ref-2' }, 'سلّةٌ تغيّرت');
  const sig3 = orderSignature(orderDraft(form({ phone: '0555000000' }), cart, products));
  assert.equal(pickClientRef(a, sig3, gen).ref, 'ref-3', 'جوالٌ صُحّح');
  assert.equal(pickClientRef({ sig: sig1, ref: '' }, sig1, gen).ref, 'ref-4', 'مرجعٌ فارغ من تخزينٍ عابث لا يُعاد');
});

test('رسائل الفشل بحالة الردّ', () => {
  assert.deepEqual(orderFailure(429), { msg: 'طلبات كثيرة — حاول بعد قليل' });
  assert.deepEqual(orderFailure(400), { msg: 'تغيرت قائمة الأصناف — حدّث الصفحة', reload: true });
  assert.equal(orderFailure(413).reload, true);
  assert.deepEqual(orderFailure(null), { msg: 'تعذر الإرسال — تحقق من الاتصال وأعد المحاولة' });
  assert.deepEqual(orderFailure(500), orderFailure(null));
  assert.match(orderFailure(404).msg, /لم يعد متاحا/);
});

// ═══ الحفظ المحلي ═══

test('الحفظ لكل رابط: يُحفظ ويُقرأ، والفارغ يُمحى، وسلّتا مندوبَين لا تختلطان', () => {
  const st = memStorage();
  const lines: CartLine[] = [{ productId: P1, unitId: CTN, qty: 2 }];
  saveCart('t1', 'r1', { lines, pending: { sig: 's', ref: 'r' } }, st);
  assert.ok(st.data[cartStorageKey('t1', 'r1')]);
  assert.deepEqual(loadCart('t1', 'r1', st), { lines, pending: { sig: 's', ref: 'r' } });
  assert.deepEqual(loadCart('t1', 'r2', st), { lines: [], pending: null }, 'مندوبٌ آخر');
  assert.notEqual(cartStorageKey('t1', 'r1'), cartStorageKey('t1', 'r2'));
  saveCart('t1', 'r1', { lines: [], pending: { sig: 's', ref: 'r' } }, st);
  assert.deepEqual(st.data, {}, 'السلّة الفارغة تُمحى بمرجعها');
});

test('التخزين غير موثوق: عبثٌ أو JSON تالف أو تخزينٌ رامٍ أو غائب — لا سقوط', () => {
  assert.deepEqual(loadCart('t', 'r', memStorage({ [cartStorageKey('t', 'r')]: '{not json' })), { lines: [], pending: null });
  assert.deepEqual(loadCart('t', 'r', throwing), { lines: [], pending: null });
  assert.deepEqual(loadCart('t', 'r', null), { lines: [], pending: null });
  assert.doesNotThrow(() => saveCart('t', 'r', { lines: [{ productId: P1, unitId: null, qty: 1 }], pending: null }, throwing));
  assert.doesNotThrow(() => saveCart('t', 'r', { lines: [], pending: null }, throwing));
  // التخزين الافتراضي في node (غائبٌ أو فارغ بحسب النسخة): لا خطأ ولا سلّة
  assert.deepEqual(loadCart('t', 'r'), { lines: [], pending: null });
  const s = sanitizeCart({
    lines: [
      { productId: P1, unitId: CTN, qty: 2 },
      { productId: P1, unitId: CTN, qty: 1 },           // مكرّر يُدمج
      { productId: P2, qty: 999999 },                    // unitId غائب = الأساس، والكمية تُسقف
      { productId: '', unitId: null, qty: 1 },
      { productId: P2, unitId: 5, qty: 1 },
      { productId: P2, unitId: PAL, qty: 'x' },
      null, 'junk',
    ],
    pending: { sig: 1, ref: 'r' },
  });
  assert.deepEqual(s, { lines: [{ productId: P1, unitId: CTN, qty: 3 }, { productId: P2, unitId: null, qty: CART_MAX_QTY }], pending: null });
  assert.deepEqual(sanitizeCart('junk'), { lines: [], pending: null });
});

// ═══ العرض (تصييرٌ ثابت — الصفحة بلا خادم ولا متصفّح) ═══

const noop = () => {};
// تعليقات React بين أجزاء النص لا أثر لها في العرض
const strip = (html: string) => html.replace(/<!-- -->/g, '');
const money = (v: number) => v.toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

test('العرض: بطاقة الصنف — «أضف» بالرئيسية مختارةً، ثم العدّاد بكمية السلّة وعدّاد الوحدة على شارتها، وبلا وحدات لا منتقي', () => {
  const props = { p: juice, pid: P1, picked: {} as Record<string, string | null>, brand: '#E15A30', onPick: noop, onStep: noop, onQty: noop };
  const empty = strip(renderToStaticMarkup(createElement(CardOrder, { ...props, cart: [] })));
  assert.ok(empty.includes('أضف'));
  assert.match(empty, /aria-pressed="true"[^>]*>كرتون</, 'الرئيسية مختارة افتراضاً');
  assert.match(empty, /aria-pressed="false"[^>]*>حبة</);
  const inCart = strip(renderToStaticMarkup(createElement(CardOrder, { ...props, cart: [{ productId: P1, unitId: CTN, qty: 3 }] })));
  assert.ok(!inCart.includes('أضف'), 'السطر في السلّة: العدّاد بدل «أضف»');
  assert.ok(inCart.includes(`value="${formatQty(3)}"`));
  assert.ok(inCart.includes(`> · ${formatQty(3)}</span>`), 'شارة الكرتون بلا عدّاده');
  const plain = renderToStaticMarkup(createElement(CardOrder, { ...props, p: water, pid: P2, cart: [] }));
  assert.ok(!plain.includes('role="group"'), 'صنفٌ بلا وحدات: لا منتقي');
});

test('العرض: نافذة الإتمام — الأسطر والإجمالي، والحقول والفخّ، و«شامل الضريبة» محروسة، والخطأ والإرسال الجاري', () => {
  const cart: CartLine[] = [{ productId: P1, unitId: CTN, qty: 2 }, { productId: P2, unitId: null, qty: 3 }];
  const base = {
    brand: '#E15A30', dec: 2, sym: 'ر.س', taxOff: false, repName: 'خالد', form: form(), sending: false, error: null,
    onForm: noop, onStep: noop, onQty: noop, onClose: noop, onSubmit: noop,
  };
  const html = strip(renderToStaticMarkup(createElement(CheckoutSheet, { ...base, resolved: resolveCart(cart, products, { dec: 2, taxOff: false }) })));
  for (const s of ['عصير', 'كرتون (24 حبة)', 'ماء', money(51.75), money(103.5), money(107.31), 'الإجمالي التقريبي · 2 صنف', 'شامل الضريبة', 'خالد', 'إرسال الطلب']) {
    assert.ok(html.includes(s), s);
  }
  assert.match(html, /id="co-phone" type="tel" inputMode="tel"/i);
  assert.match(html, /<input name="website" type="text" tabindex="-1" autoComplete="off" value=""\/>/i);
  assert.ok(html.includes('aria-hidden="true"'));

  const off = strip(renderToStaticMarkup(createElement(CheckoutSheet, { ...base, taxOff: true, resolved: resolveCart(cart, products, { dec: 2, taxOff: true }) })));
  assert.ok(!off.includes('ضريب'), '«إزالة الضريبة»: لا ذكر للضريبة');
  assert.ok(off.includes(money(93.3)));

  const err = strip(renderToStaticMarkup(createElement(CheckoutSheet, { ...base, resolved: resolveCart(cart, products, { dec: 2, taxOff: false }), error: orderFailure(400) })));
  assert.ok(err.includes('تغيرت قائمة الأصناف — حدّث الصفحة') && err.includes('تحديث'));
  const busy = strip(renderToStaticMarkup(createElement(CheckoutSheet, { ...base, resolved: resolveCart(cart, products, { dec: 2, taxOff: false }), sending: true })));
  assert.ok(busy.includes('جاري الإرسال') && !busy.includes('إرسال الطلب'));
});

test('العرض: شاشة النجاح باسم المندوب وأنه سيتواصل', () => {
  const html = strip(renderToStaticMarkup(createElement(OrderDone, { repName: 'خالد', brand: '#E15A30', onBack: noop })));
  assert.ok(html.includes('وصل طلبك إلى مندوبك خالد'));
  assert.ok(html.includes('سيتواصل معك'));
});

// ═══ الصفحة ═══

test('الصفحة: السلّة خلف علم الخادم وحده، وأداة البطاقة لصنفٍ بمعرّف', () => {
  const s = page();
  assert.ok(s.includes('const canOrder = data?.orderEnabled === true;'));
  assert.ok(s.includes("if (!data || data.orderEnabled !== true || !tenantId || !repId) return;"), 'التخزين يُلمس بلا العلم');
  assert.ok(s.includes('{canOrder && p.id && ('), 'أداة الطلب بلا حارس العلم');
  assert.ok(s.includes('resolveCart(canOrder ? cart : []'), 'الشريط يظهر بلا العلم');
  assert.ok(s.includes('if (cartReady && tenantId && repId) saveCart('), 'الكتابة قبل القراءة تمحو سلّة الأمس');
  // ما كان قبل الميزة باقٍ
  assert.ok(s.includes("{taxOff ? 'منيو المنتجات' : 'منيو المنتجات · الاسعار شاملة الضريبة'}"));
  assert.ok(s.includes('<CatalogPrices p={taxOff ? { ...p, taxPct: 0 } : p}'));
});

test('الصفحة: «أضف» والشريط «إتمام الطلب · N صنف · الإجمالي التقريبي» يختفي فارغاً، ونافذة الإتمام بحقولها والفخّ', () => {
  const s = page();
  assert.ok(s.includes('<Plus size={16} /> أضف'));
  assert.ok(s.includes('{hasCart && !sheetOpen && ('), 'الشريط بلا حارس السلّة الفارغة');
  assert.ok(s.includes('إتمام الطلب</span>') && s.includes('{resolved.count} صنف · الإجمالي التقريبي'));
  assert.ok(s.includes('id="co-phone" type="tel" inputMode="tel"'), 'خانة الجوال بلوحة الأرقام');
  assert.ok(s.includes('<input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />'), 'حقل الفخّ');
  assert.ok(s.includes("namedItem('website')"), 'الفخّ يُقرأ من الـDOM عند الإرسال');
  assert.ok(s.includes("'إرسال الطلب'"));
  assert.ok(s.includes('وصل طلبك إلى مندوبك {repName}'));
  assert.ok(s.includes("{taxOff ? 'السعر النهائي يؤكده مندوبك عند الفاتورة' : 'شامل الضريبة · "), '«شامل الضريبة» بلا حارس «إزالة الضريبة»');
  // كل عبارة ضريبةٍ جديدة في الصفحة داخل حارس taxOff (ما عدا التعليقات)
  const taxLines = s.split('\n').filter(l => /ضريب/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l) && !/taxOff \?/.test(l));
  assert.deepEqual(taxLines, [], 'عبارة ضريبة بلا حارس');
});

test('الصفحة: الإرسال بمسار الخادم وعنوانه نفسيهما، ومرجع الإعادة المحفوظ، وتفريغ السلّة بعد النجاح', () => {
  const s = page();
  assert.ok(s.includes('fetch(`${apiBase()}/public/catalog/${tenantId}/${repId}`)'), 'GET المنيو تغيّر');
  assert.ok(s.includes('fetch(`${apiBase()}/public/catalog/${tenantId}/${repId}/orders`, {'));
  assert.ok(s.includes("method: 'POST'"));
  assert.ok(s.includes('const ref = pickClientRef(pending, orderSignature(draft), newUuid);'));
  assert.ok(s.includes('body: JSON.stringify({ clientRef: ref.ref, ...draft }),'));
  const ok = s.slice(s.indexOf('if (!r.ok) { setOrderErr(orderFailure(r.status)); return; }'));
  assert.ok(ok.indexOf('setCart([]);') > 0 && ok.indexOf('setPending(null);') > 0, 'السلّة لا تُفرّغ بعد النجاح');
  // عنوان الخادم يُقرأ عند النداء — الصفحة تُستورد في node (هذا الملف يستوردها) بلا import.meta.env
  assert.ok(s.includes('const apiBase = () => (import.meta.env.VITE_API_URL'));
  // لا tr() في الصفحة — نصوصها العربية حرفية كبقية المنيو
  assert.ok(!/\btr\(/.test(s));
});
