// «إدارة طرق الدفع» (طلب المالك ٢٥ أكتوبر ٢٠٢٦) — services/paymentMethodsCore.ts + services/paymentMethodsConfig.ts +
// routes/paymentMethodsConfig.ts وأثرها في routes/receipts.ts وتقريري «طرق الدفع» والتحصيل وتصدير ERP.
// البنية الصارمة والقراءة المتسامحة والانتقال والاستعادة، ثم حلّ طريقة السند (الأساس من إعداد الشركة لا من الجهاز، والرفع
// المؤجَّل لا يُرفض لسبب اسم)، ثم المعالجات الحقيقية فوق Prisma مزيّف في الذاكرة، ثم التجميع، ثم حرّاس نصّية.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import {
  BUILTIN_METHODS, CUSTOM_METHOD_KEY_RE, DEFAULT_METHOD_ALIASES, DEFAULT_METHOD_ICON, DEFAULT_METHOD_LABELS, MANUAL_BASES,
  PAYMENT_METHODS_ISSUES, PAYMENT_METHODS_LIMITS, checkPaymentMethodsConfig, defaultPaymentMethodsConfig, isDefaultPaymentMethodsConfig,
  isPaymentMethodsReset, methodLabelKey, newPaymentMethodKey, normalizeMethodLabel, parsePaymentMethodsConfig, paymentMethodsList,
  paymentMethodsTransitionIssues, paymentMethodsView, readPaymentMethodsConfig, receiptMethodChoices, receiptMethodPayload,
  resetPaymentMethodsConfig, resolvePaymentMethod, resolveReceiptMethod, storedPaymentMethodsConfig,
  type PaymentMethodsConfigV1,
} from '../services/paymentMethodsConfig';
import { PAYMENT_METHODS, buildPaymentMethodsReport, summarizeCollectionsByMethod, type RepInfo } from '../services/paymentMethodsReport';
import { receiptPayloadRow } from '../services/erpPayload';

const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** شركةٌ سمّت «شبكة» «مدى»، وعطّلت الشيك، وأضافت STC Pay (تُعامل مثل النقدي) وتابي (مثل التحويل، معطّلة) */
function company(): PaymentMethodsConfigV1 {
  const c = defaultPaymentMethodsConfig();
  c.builtins.POS = { label: 'مدى', active: true };
  c.builtins.CHEQUE = { label: null, active: false };
  c.custom = [
    { key: 'c_stcpay01', label: 'STC Pay', base: 'CASH', icon: 'smartphone', active: true },
    { key: 'c_tabby001', label: 'تابي', base: 'BANK_TRANSFER', icon: 'credit-card', active: false },
  ];
  return c;
}
let seq = 0;
const keys = () => `c_gen${String(++seq).padStart(4, '0')}`;

// ═══ الافتراضي: null = سلوك اليوم حرفياً ═══

test('null ⇒ الطرق الخمس بأسمائها الافتراضية مفعّلة، والاختيار اليدوي أربعٌ بلا الإلكتروني', () => {
  const list = paymentMethodsList(null);
  assert.deepEqual(list.map((m) => m.id), [...BUILTIN_METHODS]);
  assert.deepEqual(list.map((m) => m.label), ['نقدي', 'شبكة', 'تحويل بنكي', 'شيك', 'دفع إلكتروني']);
  assert.ok(list.every((m) => m.companyLabel === null && m.active && !m.custom && m.key === null));
  assert.deepEqual(receiptMethodChoices(null).map((m) => m.id), [...MANUAL_BASES]);
  assert.equal(list.find((m) => m.id === 'ONLINE')!.manual, false);
  assert.ok(isDefaultPaymentMethodsConfig(null) && isDefaultPaymentMethodsConfig(defaultPaymentMethodsConfig()));
  assert.deepEqual(PAYMENT_METHODS, BUILTIN_METHODS, 'ترتيب التقرير وترتيب النواة واحد');
});

// ═══ الحفظ الصارم ═══

test('الصورة القانونية: الطرق المدمجة الخمس حاضرة، والاسم المساوي للافتراضي null، والمسافات والأسطر تُطبَّع', () => {
  const r = checkPaymentMethodsConfig({
    version: 1,
    builtins: { CASH: { label: 'نقدي' }, POS: { label: '  مدى \n  شبكة ' } },
    custom: [{ key: 'c_stcpay01', label: '‮STC\tPay ', base: 'CASH' }],
  });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
  assert.deepEqual(r.value.builtins, {
    CASH: { label: null, active: true }, POS: { label: 'مدى شبكة', active: true }, BANK_TRANSFER: { label: null, active: true },
    CHEQUE: { label: null, active: true }, ONLINE: { label: null, active: true },
  });
  assert.deepEqual(r.value.custom, [{ key: 'c_stcpay01', label: 'STC Pay', base: 'CASH', icon: DEFAULT_METHOD_ICON, active: true }]);
  assert.equal(normalizeMethodLabel(' a\u0000b‏ '), 'a b');
});

test('المفتاح: الجديدة بلا مفتاح يولَّد لها (لا يصطدم بمُرسَل)، والمُرسَل يطابق c_…، والمكرّر يُرفض، وبلا مولّد ⇒ مطلوب', () => {
  seq = 0;
  const r = checkPaymentMethodsConfig({ version: 1, custom: [{ label: 'أ', base: 'POS' }, { key: 'c_gen0001', label: 'ب', base: 'CASH' }] }, { newKey: keys });
  assert.ok(r.ok);
  assert.deepEqual(r.value.custom.map((c) => c.key), ['c_gen0002', 'c_gen0001'], 'المولَّد تخطّى المفتاح المُرسَل');
  const issue = (raw: unknown, opts = {}) => { const x = checkPaymentMethodsConfig(raw, opts); assert.equal(x.ok, false); return !x.ok ? x.issues[0] : null; };
  assert.deepEqual(issue({ version: 1, custom: [{ label: 'أ', base: 'CASH' }] }), { path: 'custom.0.key', message: PAYMENT_METHODS_ISSUES.keyRequired });
  assert.equal(issue({ version: 1, custom: [{ key: 'STC', label: 'أ', base: 'CASH' }] })!.message, PAYMENT_METHODS_ISSUES.keyInvalid);
  assert.equal(issue({ version: 1, custom: [{ key: 'c_aaaa1', label: 'أ', base: 'CASH' }, { key: 'c_aaaa1', label: 'ب', base: 'CASH' }] })!.message, PAYMENT_METHODS_ISSUES.keyDuplicate);
  for (let i = 0; i < 50; i++) assert.match(newPaymentMethodKey(), CUSTOM_METHOD_KEY_RE);
});

test('الأساس من الأربعة وحدها: الإلكتروني لا يكون أساساً، والقيمة المجهولة تُرفض برسالة الأساس', () => {
  for (const base of ['ONLINE', 'CARD', '']) {
    const r = checkPaymentMethodsConfig({ version: 1, custom: [{ key: 'c_xxxx1', label: 'أ', base }] });
    assert.equal(r.ok, false, base);
    if (!r.ok) assert.deepEqual(r.issues[0], { path: 'custom.0.base', message: PAYMENT_METHODS_ISSUES.base });
  }
});

test('الأسماء: مطلوبة، حتى 40 حرفاً، وفريدة بين كل الطرق ومنها الافتراضية والمعطّلة', () => {
  const first = (raw: unknown) => { const r = checkPaymentMethodsConfig(raw); return r.ok ? null : r.issues[0]; };
  assert.equal(first({ version: 1, custom: [{ key: 'c_xxxx1', label: '   ', base: 'CASH' }] })!.message, PAYMENT_METHODS_ISSUES.labelRequired);
  assert.equal(first({ version: 1, custom: [{ key: 'c_xxxx1', label: 'ق'.repeat(41), base: 'CASH' }] })!.message, PAYMENT_METHODS_ISSUES.labelTooLong);
  assert.equal(checkPaymentMethodsConfig({ version: 1, custom: [{ key: 'c_xxxx1', label: 'ق'.repeat(40), base: 'CASH' }] }).ok, true);
  assert.equal(first({ version: 1, builtins: { POS: { label: 'ق'.repeat(41) } } })!.message, PAYMENT_METHODS_ISSUES.labelTooLong);
  // مخصّصة باسم «نقدي» بجانب النقدي المدمج: جدولان بالاسم نفسه
  assert.deepEqual(first({ version: 1, custom: [{ key: 'c_xxxx1', label: 'نقدي', base: 'CASH' }] }), { path: 'custom.0.label', message: PAYMENT_METHODS_ISSUES.labelDuplicate });
  assert.deepEqual(first({ version: 1, builtins: { POS: { label: 'شيك' } } }), { path: 'builtins.POS.label', message: PAYMENT_METHODS_ISSUES.labelDuplicate });
  assert.equal(first({ version: 1, custom: [{ key: 'c_xxxx1', label: 'stc pay', base: 'CASH' }, { key: 'c_xxxx2', label: 'STC PAY', base: 'POS', active: false }] })!.message, PAYMENT_METHODS_ISSUES.labelDuplicate);
  // إعادة تسمية النقدي تحرّر «نقدي» لطريقة أخرى
  assert.equal(checkPaymentMethodsConfig({ version: 1, builtins: { CASH: { label: 'كاش' } }, custom: [{ key: 'c_xxxx1', label: 'نقدي', base: 'CASH' }] }).ok, true);
});

test('الأسماء: أسماء الشاشات للمدمجة غير المسمّاة محجوزة («تحويل»، «دفع الكتروني»، «نقد») بمفتاح مقارنةٍ مطبَّع', () => {
  const issues = (raw: unknown) => { const r = checkPaymentMethodsConfig(raw); return r.ok ? [] : r.issues; };
  const custom = (label: string, base = 'CASH') => ({ version: 1, custom: [{ key: 'c_xxxx1', label, base }] });
  const dup = [{ path: 'custom.0.label', message: PAYMENT_METHODS_ISSUES.labelDuplicate }];
  // «تحويل» بأساس النقدي بجانب «تحويل» القصير للتحويل البنكي: زرّان متطابقان بأساسين مختلفين في سند المندوب و/m
  assert.deepEqual(issues(custom('تحويل')), dup);
  assert.deepEqual(issues(custom('دفع الكتروني', 'POS')), dup, 'الإلكتروني بكلمة الشاشات بلا همزة');
  assert.deepEqual(issues(custom('نقد')), dup);
  for (const v of ['تحويـــل', 'تَحْوِيل', 'دفع إلكترونى', 'شبكه', 'شيـك', 'تحويل بنكى', 'ﺷﻴﻚ']) assert.deepEqual(issues(custom(v)), dup, v);
  assert.deepEqual(DEFAULT_METHOD_ALIASES, { CASH: ['نقد'], BANK_TRANSFER: ['تحويل'], ONLINE: ['دفع الكتروني'] });
  assert.equal(methodLabelKey(' دفع  إلكترونـيّ '), methodLabelKey('دفع الكتروني'));
  assert.equal(methodLabelKey('STC Pay'), 'stc pay');
  assert.equal(methodLabelKey(5), '');
  // المدمجة المسمّاة تعرض اسمها وحده ⇒ اسمها القصير يتحرّر، واسمها الجديد محجوزٌ مطبَّعاً
  assert.deepEqual(issues({ version: 1, builtins: { BANK_TRANSFER: { label: 'حوالة' } }, custom: [{ key: 'c_xxxx1', label: 'تحويل', base: 'CASH' }] }), []);
  assert.deepEqual(issues({ version: 1, builtins: { BANK_TRANSFER: { label: 'حوالة' } }, custom: [{ key: 'c_xxxx1', label: 'حواله', base: 'CASH' }] }), dup);
  // المدمجة تُسمّى باسمها القصير أو بكلمة الشاشات لنفسها ⇒ مقبول (الطريقة نفسها)
  assert.deepEqual(issues({ version: 1, builtins: { BANK_TRANSFER: { label: 'تحويل' }, ONLINE: { label: 'دفع الكتروني' } } }), []);
  // واسم الشاشات القصير لمدمجةٍ غير مسمّاة لا تأخذه مدمجةٌ أخرى
  assert.deepEqual(issues({ version: 1, builtins: { POS: { label: 'تحويل' } } }), [{ path: 'builtins.POS.label', message: PAYMENT_METHODS_ISSUES.labelDuplicate }]);
});

test('الأسماء: الخطأ على الصفّ الذي عدّله المستخدم — المدمجة غير المسمّاة أولاً ثم المسمّاة ثم المضافة', () => {
  const paths = (raw: unknown) => { const r = checkPaymentMethodsConfig(raw); return r.ok ? [] : r.issues.map((i) => [i.path, i.message]); };
  // تسمية «نقدي» «شبكة» (والشبكة بلا اسم): على النقدي لا على صفّ الشبكة الذي لم يُلمس
  assert.deepEqual(paths({ version: 1, builtins: { CASH: { label: 'شبكة' } } }), [['builtins.CASH.label', PAYMENT_METHODS_ISSUES.labelDuplicate]]);
  assert.deepEqual(paths({ version: 1, builtins: { CASH: { label: 'شبكه' } } }), [['builtins.CASH.label', PAYMENT_METHODS_ISSUES.labelDuplicate]], 'مطبَّعاً');
  // مدمجتان مسمّاتان بالاسم نفسه ⇒ الثانية في الترتيب
  assert.deepEqual(paths({ version: 1, builtins: { POS: { label: 'مدى' }, CHEQUE: { label: 'مدى' } } }), [['builtins.CHEQUE.label', PAYMENT_METHODS_ISSUES.labelDuplicate]]);
  // مدمجة مسمّاة ومضافة بالاسم نفسه ⇒ المضافة
  assert.deepEqual(paths({ version: 1, builtins: { POS: { label: 'مدى' } }, custom: [{ key: 'c_xxxx1', label: 'مدى', base: 'CASH' }] }), [['custom.0.label', PAYMENT_METHODS_ISSUES.labelDuplicate]]);
});

test('القواعد: الإلكتروني لا يُعطَّل، وطريقة مفعّلة واحدة على الأقل، وحدّ العدد، والحقول المجهولة والنسخ الأخرى تُرفض', () => {
  const first = (raw: unknown) => { const r = checkPaymentMethodsConfig(raw); return r.ok ? null : r.issues[0]; };
  assert.equal(first({ version: 1, builtins: { ONLINE: { active: false } } })!.message, PAYMENT_METHODS_ISSUES.onlineFixed);
  const off = { active: false };
  assert.deepEqual(first({ version: 1, builtins: { CASH: off, POS: off, BANK_TRANSFER: off, CHEQUE: off } }), { path: '', message: PAYMENT_METHODS_ISSUES.noneActive });
  assert.equal(checkPaymentMethodsConfig({ version: 1, builtins: { CASH: off, POS: off, BANK_TRANSFER: off, CHEQUE: off }, custom: [{ key: 'c_xxxx1', label: 'أ', base: 'CASH' }] }).ok, true, 'مخصّصة مفعّلة تكفي');
  assert.equal(first({ version: 1, builtins: { CASH: off, POS: off, BANK_TRANSFER: off, CHEQUE: off }, custom: [{ key: 'c_xxxx1', label: 'أ', base: 'CASH', active: false }] })!.message, PAYMENT_METHODS_ISSUES.noneActive);
  const many = Array.from({ length: PAYMENT_METHODS_LIMITS.maxCustom + 1 }, (_, i) => ({ key: `c_m${String(i).padStart(4, '0')}`, label: `طريقة ${i}`, base: 'CASH' }));
  assert.equal(first({ version: 1, custom: many })!.message, PAYMENT_METHODS_ISSUES.tooMany);
  assert.equal(checkPaymentMethodsConfig({ version: 1, custom: many.slice(0, PAYMENT_METHODS_LIMITS.maxCustom) }).ok, true);
  assert.equal(first({ version: 1, extra: 1 })!.message, PAYMENT_METHODS_ISSUES.unknownKey);
  assert.equal(first({ version: 1, builtins: { CARD: { label: 'x' } } })!.message, PAYMENT_METHODS_ISSUES.unknownKey);
  assert.equal(first({ version: 1, custom: [{ key: 'c_xxxx1', label: 'أ', base: 'CASH', color: 'red' }] })!.message, PAYMENT_METHODS_ISSUES.unknownKey);
  assert.equal(first({ version: 1, custom: [{ key: 'c_xxxx1', label: 'أ', base: 'CASH', icon: 'rocket' }] })!.message, PAYMENT_METHODS_ISSUES.icon);
  assert.equal(first({ version: 2 })!.message, PAYMENT_METHODS_ISSUES.version);
  assert.equal(first(null)!.message, PAYMENT_METHODS_ISSUES.shape);
});

test('الحجم قبل التحليل ⇒ 413، والمرفوض ⇒ 400 برسالة أول قاعدة، وعشرون طريقة بأطول اسم تحت الحدّ', () => {
  const big = parsePaymentMethodsConfig({ version: 1, pad: 'x'.repeat(PAYMENT_METHODS_LIMITS.maxBytes) });
  assert.equal(big.ok, false);
  if (!big.ok) assert.deepEqual([big.status, big.code, big.message], [413, 'PAYMENT_METHODS_TOO_LARGE', PAYMENT_METHODS_ISSUES.tooLarge]);
  const bad = parsePaymentMethodsConfig({ version: 1, custom: [{ label: 'أ', base: 'ONLINE' }] });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual([bad.status, bad.code, bad.message], [400, 'PAYMENT_METHODS_INVALID', PAYMENT_METHODS_ISSUES.base]);
  const full = { version: 1, custom: Array.from({ length: 20 }, (_, i) => ({ key: `c_${'k'.repeat(20)}${String(i).padStart(4, '0')}`, label: `${i}`.padEnd(40, 'ق'), base: 'BANK_TRANSFER', icon: 'credit-card', active: false })) };
  const ok = parsePaymentMethodsConfig(full);
  assert.ok(ok.ok, JSON.stringify(!ok.ok && ok.issues));
});

// ═══ القراءة المتسامحة (الخادم والجهاز) ═══

test('القراءة: نسخةٌ أخرى أو غير كائن ⇒ null، والحقل الزائد يُهمل، والمدخل التالف يسقط وحده، والأيقونة المجهولة افتراضية', () => {
  assert.equal(readPaymentMethodsConfig(null), null);
  assert.equal(readPaymentMethodsConfig({ ...company(), version: 2 }), null);
  assert.equal(readPaymentMethodsConfig('{"version":1}'), null);
  assert.deepEqual(readPaymentMethodsConfig(company()), company());
  const raw = clone(company()) as unknown as Record<string, any>;
  raw.future = { x: 1 };
  raw.builtins.POS.extra = true;
  raw.builtins.CASH = { label: 'ق'.repeat(60), active: 'no' };
  raw.builtins.ONLINE = { label: 'ميسر', active: false };
  raw.custom.push({ key: 'bad', label: 'x', base: 'CASH' }, { key: 'c_noonline1', label: 'y', base: 'ONLINE' }, { key: 'c_stcpay01', label: 'مكرر', base: 'POS' },
    { key: 'c_newicon1', label: 'z', base: 'POS', icon: 'rocket', active: 0 });
  const r = readPaymentMethodsConfig(raw)!;
  assert.deepEqual(r.builtins.CASH, { label: null, active: true }, 'اسمٌ طويل ⇒ الافتراضي، وactive غير false ⇒ مفعّلة');
  assert.deepEqual(r.builtins.ONLINE, { label: 'ميسر', active: true }, 'الإلكتروني لا يُعطَّل ولو خُزّن معطّلاً');
  assert.deepEqual(r.custom.map((c) => c.key), ['c_stcpay01', 'c_tabby001', 'c_newicon1']);
  assert.deepEqual([r.custom[2].icon, r.custom[2].active], [DEFAULT_METHOD_ICON, true]);
});

test('المخزَّن ⇒ ما يُعرض: null والافتراضي الحرفي «غير مخصّص»، والتالف افتراضي، والردّ يحمل كل الطرق والاختيارات', () => {
  assert.deepEqual(storedPaymentMethodsConfig(null), { config: null, stored: false });
  assert.deepEqual(storedPaymentMethodsConfig(defaultPaymentMethodsConfig()), { config: null, stored: false });
  assert.deepEqual(storedPaymentMethodsConfig({ version: 7 }), { config: null, stored: false });
  assert.deepEqual(storedPaymentMethodsConfig(company()), { config: company(), stored: true });
  const v = paymentMethodsView(company(), true);
  assert.deepEqual(v.methods.map((m) => [m.id, m.label, m.active]), [
    ['CASH', 'نقدي', true], ['POS', 'مدى', true], ['BANK_TRANSFER', 'تحويل بنكي', true], ['CHEQUE', 'شيك', false],
    ['ONLINE', 'دفع إلكتروني', true], ['c_stcpay01', 'STC Pay', true], ['c_tabby001', 'تابي', false],
  ]);
  assert.deepEqual(v.choices.map((m) => m.id), ['CASH', 'POS', 'BANK_TRANSFER', 'c_stcpay01'], 'المعطّلة والإلكتروني خارج نموذج السند');
  assert.deepEqual(v.methods.find((m) => m.id === 'POS')!.companyLabel, 'مدى');
  assert.equal(v.methods.find((m) => m.id === 'CASH')!.companyLabel, null, 'الافتراضي تترجمه الواجهة');
  assert.deepEqual(receiptMethodPayload(v.choices[3]), { paymentMethod: 'CASH', paymentMethodKey: 'c_stcpay01' });
  assert.deepEqual(receiptMethodPayload(v.choices[1]), { paymentMethod: 'POS' });
});

// ═══ الانتقال والاستعادة ═══

test('الانتقال: لا حذف لطريقة محفوظة ولا تبديل أساسها — والإضافة والتسمية والتعطيل والترتيب حرّة', () => {
  const prev = company();
  assert.deepEqual(paymentMethodsTransitionIssues(null, prev), []);
  const next = company();
  next.custom.reverse();
  next.custom[0].label = 'تابي بالتقسيط';
  next.custom[1].active = false;
  next.custom.push({ key: 'c_tamara01', label: 'تمارا', base: 'POS', icon: 'wallet', active: true });
  assert.deepEqual(paymentMethodsTransitionIssues(prev, next), []);
  const dropped = company();
  dropped.custom = dropped.custom.slice(1);
  assert.deepEqual(paymentMethodsTransitionIssues(prev, dropped), [{ path: 'custom', message: PAYMENT_METHODS_ISSUES.keyRemoved }]);
  const rebased = company();
  rebased.custom[0].base = 'POS';
  assert.deepEqual(paymentMethodsTransitionIssues(prev, rebased), [{ path: 'custom.0.base', message: PAYMENT_METHODS_ISSUES.baseChanged }]);
});

test('«استعادة الافتراضي»: المدمجة افتراضية والمخصّصة تبقى معطّلة بأسمائها — وبلا مخصّصة null', () => {
  const r = resetPaymentMethodsConfig(company())!;
  assert.deepEqual(r.builtins, defaultPaymentMethodsConfig().builtins);
  assert.deepEqual(r.custom.map((c) => [c.key, c.label, c.base, c.active]), [['c_stcpay01', 'STC Pay', 'CASH', false], ['c_tabby001', 'تابي', 'BANK_TRANSFER', false]]);
  assert.deepEqual(paymentMethodsTransitionIssues(company(), r), [], 'الاستعادة تمرّ بفحص الانتقال دائماً');
  assert.deepEqual(receiptMethodChoices(r).map((m) => m.id), [...MANUAL_BASES]);
  const renamedOnly = defaultPaymentMethodsConfig();
  renamedOnly.builtins.POS.label = 'مدى';
  assert.equal(resetPaymentMethodsConfig(renamedOnly), null);
  assert.equal(resetPaymentMethodsConfig(null), null);
  assert.ok(isPaymentMethodsReset({ reset: true }) && isPaymentMethodsReset(null));
  assert.ok(!isPaymentMethodsReset({ reset: true, x: 1 }) && !isPaymentMethodsReset({ reset: 'yes' }) && !isPaymentMethodsReset([]));
});

// ═══ طريقة السند الجديد ═══

test('السند: المفتاح المعروف يفرض أساسه أياً كان ما أرسله الجهاز، والمدمجة بلا مفتاح كما اليوم', () => {
  const c = company();
  assert.deepEqual(resolveReceiptMethod(c, { paymentMethod: 'POS', paymentMethodKey: 'c_stcpay01' }), { ok: true, paymentMethod: 'CASH', paymentMethodKey: 'c_stcpay01' });
  assert.deepEqual(resolveReceiptMethod(c, { paymentMethod: 'POS' }), { ok: true, paymentMethod: 'POS', paymentMethodKey: null });
  assert.deepEqual(resolveReceiptMethod(c, { paymentMethod: 'POS', paymentMethodKey: '  ' }), { ok: true, paymentMethod: 'POS', paymentMethodKey: null });
  for (const m of [...MANUAL_BASES, 'ONLINE']) {
    assert.deepEqual(resolveReceiptMethod(null, { paymentMethod: m }), { ok: true, paymentMethod: m, paymentMethodKey: null }, `${m} بلا إعداد = اليوم`);
  }
  assert.deepEqual(resolveReceiptMethod(c, { paymentMethod: 'ONLINE' }), { ok: true, paymentMethod: 'ONLINE', paymentMethodKey: null }, 'ONLINE بلا مفتاح يُقبل كما اليوم (API قائم)');
});

test('السند الحيّ يُرفض بـ422 على المجهول والمعطّل والإلكتروني مع مفتاح — والرفع المؤجَّل لا يُرفض لسبب اسم أبداً', () => {
  const c = company();
  const live = (input: { paymentMethod: string; paymentMethodKey?: string | null }) => resolveReceiptMethod(c, input);
  const replay = (input: { paymentMethod: string; paymentMethodKey?: string | null }) => resolveReceiptMethod(c, input, { replay: true });
  const code = (r: ReturnType<typeof live>) => (r.ok ? 'OK' : `${r.status} ${r.code}`);
  assert.equal(code(live({ paymentMethod: 'CASH', paymentMethodKey: 'c_unknown1' })), '422 PAYMENT_METHOD_UNKNOWN');
  assert.equal(code(resolveReceiptMethod(null, { paymentMethod: 'CASH', paymentMethodKey: 'c_stcpay01' })), '422 PAYMENT_METHOD_UNKNOWN', 'بلا إعداد لا مفتاح معروف');
  const off = live({ paymentMethod: 'BANK_TRANSFER', paymentMethodKey: 'c_tabby001' });
  assert.equal(code(off), '422 PAYMENT_METHOD_DISABLED');
  assert.ok(!off.ok && off.message.includes('«تابي»'));
  const cheque = live({ paymentMethod: 'CHEQUE' });
  assert.equal(code(cheque), '422 PAYMENT_METHOD_DISABLED');
  assert.ok(!cheque.ok && cheque.message.includes('«شيك»'));
  assert.equal(code(live({ paymentMethod: 'ONLINE', paymentMethodKey: 'c_stcpay01' })), '422 PAYMENT_METHOD_KEY_ONLINE');
  // المؤجَّل: المال قُبض — المعطّلة تُقبل بأساسها ومفتاحها، والمجهول يُسقط ويبقى الأساس، والإلكتروني يفقد المفتاح
  assert.deepEqual(replay({ paymentMethod: 'CASH', paymentMethodKey: 'c_tabby001' }), { ok: true, paymentMethod: 'BANK_TRANSFER', paymentMethodKey: 'c_tabby001' });
  assert.deepEqual(replay({ paymentMethod: 'POS', paymentMethodKey: 'c_unknown1' }), { ok: true, paymentMethod: 'POS', paymentMethodKey: null });
  assert.deepEqual(replay({ paymentMethod: 'CHEQUE' }), { ok: true, paymentMethod: 'CHEQUE', paymentMethodKey: null });
  assert.deepEqual(replay({ paymentMethod: 'ONLINE', paymentMethodKey: 'c_stcpay01' }), { ok: true, paymentMethod: 'ONLINE', paymentMethodKey: null });
});

test('وصف السند المخزّن: المفتاح المعروف باسمه وأساسه، والمجهول يرجع للأساس، والقيمة القديمة كما هي', () => {
  const c = company();
  assert.deepEqual([resolvePaymentMethod(c, 'CASH', 'c_stcpay01').id, resolvePaymentMethod(c, 'CASH', 'c_stcpay01').label], ['c_stcpay01', 'STC Pay']);
  assert.deepEqual([resolvePaymentMethod(c, 'POS', 'c_gone0001').id, resolvePaymentMethod(c, 'POS', 'c_gone0001').label], ['POS', 'مدى']);
  assert.deepEqual([resolvePaymentMethod(null, '', null).id, resolvePaymentMethod(null, null).label], ['CASH', DEFAULT_METHOD_LABELS.CASH]);
  assert.deepEqual([resolvePaymentMethod(c, 'LEGACY').label, resolvePaymentMethod(c, 'LEGACY').manual], ['LEGACY', false]);
});

// ═══ المعالجات الحقيقية فوق Prisma مزيّف ═══

type Row = Record<string, any>;
const T = 'T1';
const stub = (r: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, r));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
let st: { admin: Row | null; tenant: Row | null; settings: Row | null };
let writes: Row[] = [];
let locks: { sql: string; values: unknown[] }[] = [];
let created: Row[] = [];
function reset(): void {
  writes = []; locks = []; created = [];
  st = {
    admin: { isActive: true, canManageCompanySettings: true },
    tenant: { paymentMethodsEnabled: true, accountingEnabled: true },
    settings: { tenantId: T, name: 'شركة', paymentMethodsConfig: null },
  };
}
reset();
const db: Row = {
  admin: { async findUnique() { return st.admin; } },
  tenant: { async findUnique() { return st.tenant; } },
  companySettings: {
    async findUnique(a: Row) {
      if (!st.settings || a.where.tenantId !== st.settings.tenantId) return null;
      return { paymentMethodsConfig: clone(st.settings.paymentMethodsConfig) };
    },
    async updateMany(a: Row) {
      writes.push(a);
      if (!st.settings || a.where.tenantId !== st.settings.tenantId) return { count: 0 };
      // Prisma.DbNull = NULL في العمود (كما تكتبه قاعدة البيانات)
      st.settings.paymentMethodsConfig = a.data.paymentMethodsConfig === Prisma.DbNull ? null : clone(a.data.paymentMethodsConfig);
      return { count: 1 };
    },
  },
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    locks.push({ sql: strings.join('?'), values });
    return st.settings && values[0] === st.settings.tenantId ? [{ id: 'S1' }] : [];
  },
  async $transaction(fn: (tx: Row) => Promise<unknown>) { return fn(db); },
  // ─── مسار إصدار السند ───
  salesRep: {
    async findFirst() {
      return {
        id: 'R1', tenantId: T, canCreateReceipt: true, teamMemberships: [],
        tenant: { settings: st.settings ? { teamsEnabled: false, paymentMethodsConfig: clone(st.settings.paymentMethodsConfig) } : null },
      };
    },
  },
  customer: { async findFirst() { return { id: 'C1', tenantId: T }; } },
  invoice: { async findMany() { return []; } },
  receipt: {
    async findFirst() { return null; },
    async findUnique(a: Row) { return a.where?.id ? { id: a.where.id, ...created[created.length - 1], invoiceItems: [] } : null; },
    async create(a: Row) { created.push(a.data); return { id: `RC${created.length}`, ...a.data }; },
  },
};
stub('config/database', { default: db });
stub('services/adminScope', {
  scopedRecordWhere: async () => ({}), canAccessRep: async () => true, existingInScope: async () => true, SHAPE_INVOICE_RECEIPT: {},
  teamSupervisorIdOf: async () => null, composeTeamCustodyWhere: () => ({}), adminCustomerFilter: async () => ({}),
});
stub('services/customerScope', { canAccessCustomer: async () => true, redactCustomer: (c: unknown) => c });
stub('services/accounting', {
  postReceiptEntries: async () => { /* القيود خارج هذا الاختبار — لا تعرف الطريقة أصلاً */ },
  reverseReceiptEntries: async () => { /* — */ }, clean: (v: number) => Math.round(v * 1000) / 1000,
});
stub('services/liveEvents', { publishInvoicesChanged: () => { /* — */ } });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const configRouter = (require('../routes/paymentMethodsConfig') as typeof import('../routes/paymentMethodsConfig')).default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const receiptsRouter = (require('../routes/receipts') as typeof import('../routes/receipts')).default;

/** يشغّل مكدّس المسار كلّه (حرّاسه ثم معالجه) — حرّاس الراوتر العامّة (المصادقة…) قبله وخارج الاختبار */
async function call(router: unknown, method: string, req: Row): Promise<{ status: number; body: Row }> {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === '/' && l.route.methods?.[method]);
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
const manager = { id: 'M1', role: 'MANAGER', tenantId: T };

test('القراءة تشغيلاً: لكل مسجّل (والمندوب)، null ⇒ الافتراضي، والمحفوظ بطرقه واختياراته، والتالف ⇒ الافتراضي', async () => {
  reset();
  const legacy = await call(configRouter, 'get', { user: rep });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body, { success: true, ...paymentMethodsView(null, true) });
  assert.deepEqual(legacy.body.choices.map((m: Row) => m.id), [...MANUAL_BASES]);
  st.settings!.paymentMethodsConfig = company();
  const saved = await call(configRouter, 'get', { user: rep });
  assert.deepEqual([saved.body.data, saved.body.stored], [company(), true]);
  assert.deepEqual(saved.body.choices.map((m: Row) => m.id), ['CASH', 'POS', 'BANK_TRANSFER', 'c_stcpay01']);
  st.settings!.paymentMethodsConfig = { version: 9 };
  assert.deepEqual((await call(configRouter, 'get', {})).body.data, null);
  st.settings = null;
  assert.deepEqual((await call(configRouter, 'get', {})).body.hasCompany, false);
});

test('الحفظ تشغيلاً: المندوب والمستخدم بلا صلاحية إعدادات الشركة والصفحة المطفأة ⇒ 403 بلا كتابة', async () => {
  reset();
  const body = { version: 1, builtins: { POS: { label: 'مدى' } } };
  assert.equal((await call(configRouter, 'put', { user: rep, body })).status, 403, 'requireAdmin قبل requireAdminPermission (يمرّر المندوب)');
  st.admin = { isActive: true, canManageCompanySettings: false };
  assert.equal((await call(configRouter, 'put', { user: manager, body })).status, 403);
  st.admin = { isActive: true, canManageCompanySettings: true };
  st.tenant = { paymentMethodsEnabled: false, accountingEnabled: true };
  const flag = await call(configRouter, 'put', { user: manager, body });
  assert.deepEqual([flag.status, flag.body.code], [403, 'PAYMENT_METHODS_NOT_ALLOWED']);
  st.tenant = { paymentMethodsEnabled: true, accountingEnabled: false };
  assert.equal((await call(configRouter, 'put', { user: manager, body })).body.code, 'ACCOUNTING_NOT_ALLOWED');
  assert.equal(writes.length, 0, 'لا كتابة عند الرفض');
  assert.equal(locks.length, 0, 'ولا قفل');
});

test('الحفظ تشغيلاً: الجديدة تأخذ مفتاحاً من الخادم، كتابة واحدة تحت قفل الصفّ، والقراءة بعدها كما حُفظ', async () => {
  reset();
  const r = await call(configRouter, 'put', { user: manager, body: { version: 1, builtins: { CHEQUE: { active: false } }, custom: [{ label: ' STC Pay ', base: 'CASH', icon: 'smartphone' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const key = r.body.data.custom[0].key;
  assert.match(key, CUSTOM_METHOD_KEY_RE);
  assert.deepEqual(r.body.data.custom, [{ key, label: 'STC Pay', base: 'CASH', icon: 'smartphone', active: true }]);
  assert.equal(r.body.stored, true);
  assert.deepEqual(r.body.choices.map((m: Row) => m.id), ['CASH', 'POS', 'BANK_TRANSFER', key]);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].where, { tenantId: T });
  assert.equal(locks.length, 1);
  assert.match(locks[0].sql, /FROM company_settings WHERE "tenantId" = \? FOR UPDATE/);
  assert.deepEqual(locks[0].values, [T]);
  assert.deepEqual((await call(configRouter, 'get', { user: rep })).body.data, r.body.data);
  // جلسة دخول المالك تمرّ كالمدير الذي تمثّله (صلاحيةً لا عَلَماً)
  st.admin = { isActive: true, canManageCompanySettings: false };
  const again = clone(r.body.data);
  again.builtins.POS.label = 'مدى';
  assert.equal((await call(configRouter, 'put', { user: { id: 'ADM', role: 'ADMIN', tenantId: T, impersonated: true }, body: again })).status, 200);
});

test('الحفظ تشغيلاً: حذف طريقة محفوظة أو تبديل أساسها (تبويب قديم) ⇒ 409 بلا كتابة، وبلا صفّ ⇒ 409، والمرفوض 400 والكبير 413', async () => {
  reset();
  st.settings!.paymentMethodsConfig = company();
  const dropped = company();
  dropped.custom = [dropped.custom[1]];
  const r = await call(configRouter, 'put', { body: dropped });
  assert.deepEqual([r.status, r.body.code, r.body.message], [409, 'PAYMENT_METHODS_CONFLICT', PAYMENT_METHODS_ISSUES.keyRemoved]);
  const rebased = company();
  rebased.custom[1].base = 'POS';
  const b = await call(configRouter, 'put', { body: rebased });
  assert.deepEqual([b.status, b.body.code, b.body.issues[0].path], [409, 'PAYMENT_METHODS_CONFLICT', 'custom.1.base']);
  assert.equal(writes.length, 0);
  assert.deepEqual(st.settings!.paymentMethodsConfig, company());
  const bad = await call(configRouter, 'put', { body: { version: 1, custom: [{ label: 'أ', base: 'ONLINE' }] } });
  assert.deepEqual([bad.status, bad.body.code, bad.body.message], [400, 'PAYMENT_METHODS_INVALID', PAYMENT_METHODS_ISSUES.base]);
  assert.equal((await call(configRouter, 'put', { body: { version: 1, pad: 'x'.repeat(9000) } })).status, 413);
  assert.equal(locks.length, 2, 'المرفوض بنيةً لا يقفل الصفّ');
  st.settings = null;
  const none = await call(configRouter, 'put', { body: { version: 1 } });
  assert.deepEqual([none.status, none.body.code, none.body.message], [409, 'COMPANY_SETTINGS_MISSING', 'احفظ بيانات الشركة أولا']);
  assert.equal(writes.length, 0, 'لا إنشاء صفّ');
});

test('الحفظ تشغيلاً: ما يساوي الافتراضي يُكتب NULL، و«استعادة الافتراضي» تُبقي المخصّصة معطّلة ولا تمحوها', async () => {
  reset();
  st.settings!.paymentMethodsConfig = company();
  const r = await call(configRouter, 'put', { body: { reset: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.custom.map((c: Row) => [c.key, c.active]), [['c_stcpay01', false], ['c_tabby001', false]]);
  assert.deepEqual(r.body.data.builtins, defaultPaymentMethodsConfig().builtins);
  assert.deepEqual(r.body.choices.map((m: Row) => m.id), [...MANUAL_BASES]);
  // بلا مخصّصة: NULL حرفياً
  st.settings!.paymentMethodsConfig = { version: 1, builtins: { POS: { label: 'مدى', active: true } }, custom: [] };
  writes = [];
  const n = await call(configRouter, 'put', { body: { reset: true } });
  assert.deepEqual([n.status, n.body.data, n.body.stored], [200, null, false]);
  assert.equal(writes[0].data.paymentMethodsConfig, Prisma.DbNull);
  assert.equal(st.settings!.paymentMethodsConfig, null);
  writes = [];
  const def = await call(configRouter, 'put', { body: { version: 1, builtins: { CASH: { label: 'نقدي', active: true } } } });
  assert.deepEqual([def.status, def.body.stored], [200, false]);
  assert.equal(writes[0].data.paymentMethodsConfig, Prisma.DbNull, 'الافتراضي يُكتب NULL لا نسخةٌ منه');
  // المندوب لا يعيد الضبط
  writes = [];
  assert.equal((await call(configRouter, 'put', { user: rep, body: { reset: true } })).status, 403);
  assert.equal(writes.length, 0);
});

// ═══ إصدار السند تشغيلاً (POST /api/receipts) ═══

async function issue(body: Row, opts: { replay?: boolean; user?: Row } = {}) {
  return call(receiptsRouter, 'post', {
    user: opts.user ?? rep,
    headers: opts.replay ? { 'x-fs-replay': '1' } : {},
    body: { customerId: 'C1', salesRepId: 'R1', amount: 50, ...body },
  });
}

test('POST /receipts تشغيلاً: بلا إعداد كما اليوم، والمخصّصة بأساس الإعداد لا الجهاز، والمفتاح في عموده وحده', async () => {
  reset();
  const plain = await issue({ paymentMethod: 'POS' });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(created[0].paymentMethod, 'POS');
  assert.ok(!('paymentMethodKey' in created[0]), 'لا عمود جديد في سند المدمجة');
  st.settings!.paymentMethodsConfig = company();
  const stc = await issue({ paymentMethod: 'POS', paymentMethodKey: 'c_stcpay01' }, { user: manager });
  assert.equal(stc.status, 201, JSON.stringify(stc.body));
  assert.deepEqual([created[1].paymentMethod, created[1].paymentMethodKey], ['CASH', 'c_stcpay01'], 'الأساس CASH من الإعداد');
  assert.equal((await issue({ paymentMethod: 'ONLINE' })).status, 201, 'ONLINE بلا مفتاح كما اليوم');
});

test('POST /receipts تشغيلاً: الحيّ يُرفض 422 بلا إنشاء، والمؤجَّل (X-FS-Replay) يُقبل دائماً', async () => {
  reset();
  st.settings!.paymentMethodsConfig = company();
  for (const [body, codeExpected] of [
    [{ paymentMethod: 'CASH', paymentMethodKey: 'c_unknown1' }, 'PAYMENT_METHOD_UNKNOWN'],
    [{ paymentMethod: 'BANK_TRANSFER', paymentMethodKey: 'c_tabby001' }, 'PAYMENT_METHOD_DISABLED'],
    [{ paymentMethod: 'CHEQUE' }, 'PAYMENT_METHOD_DISABLED'],
    [{ paymentMethod: 'ONLINE', paymentMethodKey: 'c_stcpay01' }, 'PAYMENT_METHOD_KEY_ONLINE'],
  ] as const) {
    const r = await issue(body);
    assert.deepEqual([r.status, r.body.code], [422, codeExpected], JSON.stringify(body));
    assert.equal(typeof r.body.message, 'string');
  }
  assert.equal(created.length, 0, 'لا سند من طلبٍ مرفوض');
  const a = await issue({ paymentMethod: 'CASH', paymentMethodKey: 'c_tabby001' }, { replay: true });
  const b = await issue({ paymentMethod: 'POS', paymentMethodKey: 'c_unknown1' }, { replay: true });
  const c = await issue({ paymentMethod: 'CHEQUE' }, { replay: true });
  assert.deepEqual([a.status, b.status, c.status], [201, 201, 201]);
  assert.deepEqual(created.map((x) => [x.paymentMethod, x.paymentMethodKey ?? null]), [['BANK_TRANSFER', 'c_tabby001'], ['POS', null], ['CHEQUE', null]]);
});

// ═══ التجميع: صفحة «طرق الدفع» وتقرير التحصيل وتصدير ERP ═══

const REPS = new Map<string, RepInfo>([['r1', { name: 'محمد', isActive: true }], ['r2', { name: 'خالد', isActive: true }]]);

test('صفحة «طرق الدفع»: المخصّصة جدولٌ مستقلّ بمفتاحها ولو أساسها النقدي، والنقدي سنداته وفواتيره وحدها، والإجمالي لا يتغيّر', () => {
  const receipts = [
    { salesRepId: 'r1', paymentMethod: 'CASH', paymentMethodKey: null, amount: 100, count: 2 },
    { salesRepId: 'r1', paymentMethod: 'CASH', paymentMethodKey: 'c_stcpay01', amount: 70, count: 1 },
    { salesRepId: 'r2', paymentMethod: 'POS', paymentMethodKey: 'c_gone0001', amount: 30, count: 1 }, // مفتاحٌ لا يعرفه الإعداد ⇒ أساسه
    { salesRepId: null, paymentMethod: 'CASH', paymentMethodKey: 'c_stcpay01', amount: 5, count: 1 },
  ];
  const sales = [{ salesRepId: 'r1', amount: 40, count: 1 }];
  const plain = buildPaymentMethodsReport(receipts, sales, REPS);
  const r = buildPaymentMethodsReport(receipts, sales, REPS, company());
  assert.deepEqual(r.methods.map((m) => m.method), ['CASH', 'POS', 'BANK_TRANSFER', 'ONLINE', 'c_stcpay01'], 'الشيك والتابي المعطّلان بلا تحصيل لا جدول لهما');
  const cash = r.methods.find((m) => m.method === 'CASH')!;
  assert.deepEqual([cash.total.amount, cash.total.receiptsAmount, cash.total.invoicesAmount], [140, 100, 40]);
  const stc = r.methods.find((m) => m.method === 'c_stcpay01')!;
  assert.deepEqual([stc.base, stc.key, stc.custom, stc.label, stc.companyLabel, stc.icon, stc.active], ['CASH', 'c_stcpay01', true, 'STC Pay', 'STC Pay', 'smartphone', true]);
  assert.deepEqual([stc.total.amount, stc.total.invoicesAmount, stc.noRep], [70, 0, { amount: 5, count: 1 }]);
  const pos = r.methods.find((m) => m.method === 'POS')!;
  assert.deepEqual([pos.label, pos.companyLabel, pos.total.amount], ['مدى', 'مدى', 30]);
  assert.deepEqual([cash.label, cash.companyLabel], ['نقدي', null]);
  assert.deepEqual(r.total, plain.total, 'كل سندٍ في جدولٍ واحد — الإجمالي نفسه بلا إعداد');
  assert.deepEqual(r.noRep, plain.noRep);
  // بلا إعداد: المفتاح يُهمل والطرق الخمس كما كانت
  assert.deepEqual(plain.methods.map((m) => m.method), [...PAYMENT_METHODS]);
  assert.equal(plain.methods.find((m) => m.method === 'CASH')!.total.amount, 210);
});

test('صفحة «طرق الدفع»: المعطّلة التي حُصّل بها في الفترة تبقى جدولاً موسوماً، والمفعّلة الفارغة حاضرة، والترتيب ترتيب الشركة', () => {
  const c = company();
  c.custom.push({ key: 'c_tamara01', label: 'تمارا', base: 'POS', icon: 'wallet', active: true });
  const r = buildPaymentMethodsReport([
    { salesRepId: 'r2', paymentMethod: 'CHEQUE', amount: 900, count: 1 },
    { salesRepId: 'r2', paymentMethod: 'BANK_TRANSFER', paymentMethodKey: 'c_tabby001', amount: 200, count: 2 },
  ], [], REPS, c);
  assert.deepEqual(r.methods.map((m) => [m.method, m.active]), [
    ['CASH', true], ['POS', true], ['BANK_TRANSFER', true], ['CHEQUE', false], ['ONLINE', true],
    ['c_stcpay01', true], ['c_tabby001', false], ['c_tamara01', true],
  ]);
  assert.deepEqual(r.methods.find((m) => m.method === 'c_tamara01')!.rows, []);
  assert.deepEqual(r.total, { amount: 1100, count: 3 });
});

test('تقرير التحصيل: byMethod بالأساس كما هو، وbyMethodKey وmethods بطرق الشركة وأسمائها', () => {
  const rows = [
    { paymentMethod: 'CASH', paymentMethodKey: null, amount: 10 },
    { paymentMethod: 'CASH', paymentMethodKey: 'c_stcpay01', amount: 0.1 },
    { paymentMethod: 'CASH', paymentMethodKey: 'c_stcpay01', amount: 0.2 },
    { paymentMethod: 'POS', paymentMethodKey: null, amount: 5 },
    { paymentMethod: 'LEGACY', paymentMethodKey: null, amount: 1 },
  ];
  const s = summarizeCollectionsByMethod(rows, company());
  assert.deepEqual(s.byMethodKey, { CASH: 10, POS: 5, c_stcpay01: 0.3, LEGACY: 1 });
  assert.deepEqual(s.methods.map((m) => [m.id, m.base, m.label, m.count]), [['CASH', 'CASH', 'نقدي', 1], ['POS', 'POS', 'مدى', 1], ['c_stcpay01', 'CASH', 'STC Pay', 2], ['LEGACY', 'LEGACY', 'LEGACY', 1]]);
  assert.deepEqual(summarizeCollectionsByMethod(rows, null).byMethodKey, { CASH: 10.3, POS: 5, LEGACY: 1 }, 'بلا إعداد = بالأساس');
});

test('تصدير ERP: الأساس كما هو، واسم الطريقة دائماً، واسم الشركة وحده أو null (فيبقى وسم Odoo)', () => {
  const row = (extra: Row) => receiptPayloadRow({ id: 'r', receiptDate: '2026-10-25T08:00:00.000Z', invoiceItems: [], ...extra }, 'Asia/Riyadh', company());
  const stc = row({ paymentMethod: 'CASH', paymentMethodKey: 'c_stcpay01' });
  assert.deepEqual([stc.paymentMethod, stc.paymentMethodKey, stc.paymentMethodLabel, stc.paymentMethodCompanyLabel], ['CASH', 'c_stcpay01', 'STC Pay', 'STC Pay']);
  const cash = row({ paymentMethod: 'CASH', paymentMethodKey: null });
  assert.deepEqual([cash.paymentMethodLabel, cash.paymentMethodCompanyLabel], ['نقدي', null]);
  const legacy = receiptPayloadRow({ id: 'r', receiptDate: '2026-10-25T08:00:00.000Z', paymentMethod: 'POS' }, 'Asia/Riyadh');
  assert.deepEqual([legacy.paymentMethodLabel, legacy.paymentMethodCompanyLabel], ['شبكة', null]);
  const odoo = fs.readFileSync(path.join(SRC, '..', '..', 'integrations', 'odoo', 'fieldsales_connector', 'mapping.py'), 'utf8');
  assert.ok(odoo.includes("'payment_method': _s(row.get('paymentMethodCompanyLabel')) or _PAYMENT_LABEL.get(method, method),"));
});

// ═══ حرّاس نصّية ═══

test('حارس نصّي: السند يكتب الأساس المحلول لا ما أرسله الجهاز، والمفتاح في عموده، والتحقّق قبل الإنشاء من صفّ المندوب نفسه', () => {
  const r = read('routes', 'receipts.ts');
  const post = r.slice(r.indexOf("router.post('/'"), r.indexOf("router.patch('/:id/cancel'"));
  assert.ok(post.includes('paymentMethod: method.paymentMethod,'));
  assert.ok(post.includes('...(method.paymentMethodKey && { paymentMethodKey: method.paymentMethodKey }),'));
  assert.doesNotMatch(post, /^\s+paymentMethod: body\.paymentMethod,/m, 'أساس الجهاز لا يُكتب في السند');
  assert.ok(post.indexOf('resolveReceiptMethod(') > 0 && post.indexOf('resolveReceiptMethod(') < post.indexOf('tx.receipt.create('));
  assert.ok(post.includes("{ replay: String(req.headers['x-fs-replay'] || '') === '1' }"));
  assert.ok(post.includes('settings: { select: { teamsEnabled: true, paymentMethodsConfig: true } }'), 'الإعداد مع صفّ المندوب — لا استعلام جديد');
  assert.match(r, /paymentMethodKey: z\.string\(\)\.max\(64\)\.nullish\(\),/);
  assert.match(r, /paymentMethod: z\.enum\(\['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'ONLINE'\]\)\.default\('CASH'\),/, 'قاموس الأساس كما هو');
});

test('حارس نصّي: الدفاتر وروابط الدفع والتسويات لا تعرف المفتاح المخصّص — تعمل على الأساس', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  };
  const files = [...walk(path.join(SRC, 'services', 'gl')), path.join(SRC, 'services', 'paylink.ts'), path.join(SRC, 'services', 'settlement.ts'), path.join(SRC, 'services', 'accounting.ts')];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /paymentMethodKey|paymentMethodsConfig|paymentMethodsCore/, path.relative(SRC, f));
  // النواة صرفة (تُنسخ للواجهة): zod وحده
  const core = read('services', 'paymentMethodsCore.ts');
  assert.deepEqual([...core.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['zod']);
  assert.ok(core.startsWith('// ===='), 'رأس تعليقٍ يُقصّ عند مقارنة نسخة الواجهة');
});

test('حارس نصّي: الحفظ بالمدير وصلاحية إعدادات الشركة وعَلَم الصفحة، والقراءة بلا حارس، والتركيب بعد المصادقة تحت /api/company', () => {
  const r = read('routes', 'paymentMethodsConfig.ts');
  assert.ok(r.includes("router.put('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), requirePaymentMethods, async"));
  assert.ok(r.includes("router.get('/', async"));
  assert.doesNotMatch(r, /router\.use\(/);
  assert.doesNotMatch(r, /companySettings\.(upsert|create)\(/, 'لا صفّ مخترع');
  assert.ok(r.includes('FOR UPDATE'));
  const c = read('routes', 'company.ts');
  const auth = c.indexOf('router.use(authenticate);');
  const mount = c.indexOf("router.use('/payment-methods', paymentMethodsConfigRouter);");
  assert.ok(auth > 0 && mount > auth && mount < c.indexOf("router.get('/'"));
  const schemaBlock = c.slice(c.indexOf('const companySchema = z.object({'), c.indexOf('});', c.indexOf('const companySchema = z.object({')));
  assert.doesNotMatch(schemaBlock, /paymentMethods/, 'ليس حقلاً في PUT /api/company');
  const put = c.slice(c.indexOf("router.put('/'"), c.indexOf('export default router'));
  assert.doesNotMatch(put, /paymentMethodsConfig/);
});

test('حارس نصّي: العمودان إضافيان بلا افتراضي، ومصنّفان في مزامنة API، والاختبار في قائمة npm test', () => {
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const block = (m: string) => { const i = schema.indexOf(`model ${m} {`); return schema.slice(i, schema.indexOf('\n}', i)); };
  assert.match(block('Receipt'), /\n\s*paymentMethodKey\s+String\?\s*\n/);
  assert.match(block('Receipt'), /\n\s*paymentMethod\s+String\s+@default\("CASH"\)/, 'عمود الأساس كما هو');
  assert.match(block('CompanySettings'), /\n\s*paymentMethodsConfig\s+Json\?\s*\n/);
  assert.ok(read('services', 'apiSync.ts').includes("'paymentMethodKey',"));
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8')) as { scripts: { test: string } };
  // npm test نمطٌ يشمل كل ملفات src (القائمة الصريحة تجاوزت حدّ سطر ويندوز) — أو اسم الملف صراحةً
  assert.ok(pkg.scripts.test.includes('src/tests/payment-methods-config.test.ts') || /src\/\*\*\/\*\.test\.ts/.test(pkg.scripts.test));
});
