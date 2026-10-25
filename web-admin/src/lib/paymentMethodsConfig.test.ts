// «إدارة طرق الدفع» في الواجهة (طلب المالك ٢٥ أكتوبر ٢٠٢٦) — النواة نسخة حرفية من الخادم، وقاعدة الاسم الواحدة لكل شاشة
// (null = اليوم حرفياً، المضافة باسمها لا بمفتاحها ولا تُترجم، المفتاح المجهول باسم أساسه)، واختيارات السند (لا ONLINE أبداً،
// الأساس في paymentMethod)، ومسوّدة النافذة بقاعدة الخادم نفسها، وترجمة كل رسالة، وحرّاسٌ نصّية على التوصيل في كل شاشة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_METHOD_ALIASES, LABEL_MATCHES_TRANSLATED_DEFAULT, METHOD_CHOICE_UNAVAILABLE, PAYMENT_METHODS_ISSUES, RECEIPT_METHOD_MESSAGES,
  checkPaymentMethodsConfig, choicePayload, companyMethodLabel, companyMethodsConfig, defaultMethodLabel, draftFromConfig, draftIssues,
  draftLabelWarnings, draftToInput, draftsEqual, isDefaultPaymentMethodsConfig, methodIdentity, methodLabelFor, methodLabelKey, pickChoice,
  readPaymentMethodsConfig, receiptChoicesFor, resolvedMethodLabel,
  type PaymentMethodsConfigV1,
} from './paymentMethodsConfig';
import { hasCashLikeCustom, methodLabel, repListSheets, repMethodList, sumRows, type PaymentMethodsData, type PmRow } from './paymentMethods';
import { groupCollectionsByRep } from './collectionsByRep';
import { PHRASES } from '../i18n/strings';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const src = (...p: string[]) => read('src', ...p);
/** جسم الملف بعد أسطر التعليق // والفراغ في أوّله (كحارس نسخ إعدادات الطباعة) */
const copyBody = (s: string) => s.replace(/\r\n/g, '\n').replace(/^(?:[ \t]*\/\/[^\n]*\n|[ \t]*\n)*/, '');
const arTr = (s: string) => s;
const brackets = (s: string) => `[${s}]`;
const LANGS = ['en', 'fr', 'tr', 'zh'] as const;

/** شركةٌ سمّت «شبكة» مدى وعطّلت الشيك وأضافت STC Pay (مثل الشبكة) وتابي (معطّلة) و«دفعة» (مثل النقدي) — «دفعة» مفتاحٌ في القاموس */
const CFG = {
  version: 1,
  builtins: { POS: { label: 'مدى', active: true }, CHEQUE: { label: null, active: false } },
  custom: [
    { key: 'c_stcpay01', label: 'STC Pay', base: 'POS', icon: 'smartphone', active: true },
    { key: 'c_tabby001', label: 'تابي', base: 'BANK_TRANSFER', icon: 'credit-card', active: false },
    { key: 'c_drawer01', label: 'دفعة', base: 'CASH', icon: 'coins', active: true },
  ],
};
const co = (cfg: unknown = CFG) => ({ name: 'شركة', paymentMethodsConfig: cfg });
/** شركةٌ بالقيمة الخام كما هي (بلا وسيطٍ افتراضي يبدّل undefined) */
const bare = (raw: unknown): { name: string; paymentMethodsConfig?: unknown } => ({ name: 'x', paymentMethodsConfig: raw });

test('النواة نسخة حرفية من الخادم — قاعدة واحدة يحفظ بها الخادم ويختار بها الجوال أوف‑لاين', () => {
  const web = src('lib', 'paymentMethodsCore.ts');
  const server = read('..', 'backend', 'src', 'services', 'paymentMethodsCore.ts');
  assert.ok(web.startsWith('// ====') && web.includes('نسخة حرفية من backend/src/services/paymentMethodsCore.ts'));
  assert.equal(copyBody(web), copyBody(server), 'paymentMethodsCore.ts في الواجهة يختلف عن الخادم — انسخه من جديد');
});

test('القراءة: null أو عطب أو نسخة أحدث أو إعدادٌ يساوي الافتراضي ⇒ لا إعداد (سلوك اليوم)', () => {
  for (const raw of [undefined, null, 'x', 5, [], { version: 2, custom: [] }, { builtins: {} }]) assert.equal(companyMethodsConfig(bare(raw)), null, JSON.stringify(raw));
  assert.equal(companyMethodsConfig(null), null);
  assert.equal(companyMethodsConfig({ name: 'x' } as never), null);
  assert.equal(companyMethodsConfig(co({ version: 1, builtins: { CASH: { label: 'نقدي', active: true } }, custom: [] })), null, 'الاسم الافتراضي ليس تسمية');
  const c = companyMethodsConfig(co())!;
  assert.equal(c.builtins.POS.label, 'مدى');
  assert.equal(c.builtins.CHEQUE.active, false);
  assert.equal(c.custom.length, 3);
  // المرجع نفسه من الكاش يُقرأ مرّة (الجدول ينادي الاسم لكل صفّ)
  const raw = { ...CFG };
  assert.equal(companyMethodsConfig(co(raw)), companyMethodsConfig(co(raw)));
  // مدخلٌ تالف يُهمل وحده: مضافة بلا أساس صالح تسقط، والباقي يبقى
  const bad = companyMethodsConfig(co({ ...CFG, custom: [...CFG.custom, { key: 'c_onlinex1', label: 'X', base: 'ONLINE', icon: 'wallet', active: true }] }))!;
  assert.equal(bad.custom.length, 3, 'ONLINE ليس أساساً');
});

test('قاعدة الاسم: بلا إعداد حرفياً كاليوم، والمضافة باسمها لا بمفتاحها ولا تمرّ بالقاموس', () => {
  // بلا إعداد: قاموس الشاشات نفسه (paymentMethodLabels) — بلا tr كما في الشريط الكلاسيكي، ومعها مترجماً
  for (const company of [null, undefined, co(null), bare(undefined)]) {
    assert.equal(methodLabelFor(company, 'CASH'), 'نقدي');
    assert.equal(methodLabelFor(company, 'BANK_TRANSFER', null, brackets), '[تحويل بنكي]');
    assert.equal(methodLabelFor(company, 'ONLINE'), 'دفع الكتروني', 'الإلكتروني بكلمة الشاشات منذ ميسر');
    assert.equal(methodLabelFor(company, 'LEGACY', null, brackets), 'LEGACY', 'قيمةٌ غريبة كما هي بلا قاموس');
  }
  const c = co();
  assert.equal(methodLabelFor(c, 'POS', 'c_stcpay01', brackets), 'STC Pay', 'اسم الشركة لا يُترجم');
  // «دفعة» مفتاحٌ في القاموس — لو مرّ بـtr لصار «payments» بالإنجليزية وهو اسمٌ كتبته الشركة لطريقةٍ نقدية
  assert.ok(PHRASES['دفعة'], 'المثال يفترض «دفعة» مفتاحاً في القاموس');
  assert.equal(methodLabelFor(c, 'CASH', 'c_drawer01', (s) => PHRASES[s]?.en ?? s), 'دفعة');
  assert.equal(methodLabelFor(c, 'POS', null, brackets), 'مدى', 'المدمجة المسمّاة باسم الشركة');
  assert.equal(methodLabelFor(c, 'CASH', null, brackets), '[نقدي]', 'غير المسمّاة مترجمة كاليوم');
  assert.equal(methodLabelFor(c, 'CHEQUE'), 'شيك', 'المعطّلة باسمها — سنداتها القديمة تُعرض');
  assert.equal(methodLabelFor(c, 'BANK_TRANSFER', 'c_tabby001'), 'تابي', 'المضافة المعطّلة باسمها');
  // مفتاحٌ لا يعرفه الإعداد (أُعيد أو جهازٌ سبق الخادم) ⇒ اسم أساس السند، لا «c_…» الخام أبداً
  assert.equal(methodLabelFor(c, 'POS', 'c_unknown9'), 'مدى');
  assert.equal(methodLabelFor(null, 'CASH', 'c_unknown9'), 'نقدي');
  assert.equal(companyMethodLabel(c, 'CASH'), null);
  assert.equal(companyMethodLabel(c, 'POS'), 'مدى');
  assert.deepEqual(methodIdentity(c, 'POS', 'c_stcpay01'), { id: 'c_stcpay01', base: 'POS', icon: 'smartphone', custom: true });
  assert.deepEqual(methodIdentity(c, 'CASH', 'c_unknown9'), { id: 'CASH', base: 'CASH', icon: null, custom: false });
  // وصفٌ حلّه الخادم (كتل التقرير): اسم الشركة كما هو وإلا افتراضي الواجهة مترجماً
  assert.equal(resolvedMethodLabel({ method: 'c_x', base: 'CASH', custom: true, label: 'كاش', companyLabel: 'كاش' }, brackets), 'كاش');
  assert.equal(resolvedMethodLabel({ method: 'ONLINE', base: 'ONLINE', custom: false, label: 'دفع إلكتروني', companyLabel: null }, brackets), '[دفع الكتروني]');
  assert.equal(defaultMethodLabel('POS', brackets), '[شبكة]');
});

test('اختيارات السند: الأربع اليوم حرفياً بلا إعداد، ولا ONLINE أبداً، والمعطّلة تختفي والمضافة بعدها', () => {
  const REP = { order: ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'] as const, defaultLabels: { BANK_TRANSFER: 'تحويل' } };
  // قبل تحميل الشركة (null) وأوف‑لاين بلا ذاكرة: أزرار المندوب اليوم بترتيبها وأسمائها
  const none = receiptChoicesFor(null, brackets, { ...REP, order: [...REP.order] });
  assert.deepEqual(none.map((c) => [c.id, c.label]), [['CASH', '[نقدي]'], ['BANK_TRANSFER', '[تحويل]'], ['POS', '[شبكة]'], ['CHEQUE', '[شيك]']]);
  assert.ok(none.every((c) => !c.custom && c.key === null && c.base === c.id));
  assert.deepEqual(receiptChoicesFor(null, arTr).map((c) => c.label), ['نقدي', 'شبكة', 'تحويل بنكي', 'شيك'], 'ترتيب النواة وأسماء الشاشات افتراضياً');

  const list = receiptChoicesFor(co(), brackets, { ...REP, order: [...REP.order] });
  assert.deepEqual(list.map((c) => [c.id, c.base, c.label]), [
    ['CASH', 'CASH', '[نقدي]'], ['BANK_TRANSFER', 'BANK_TRANSFER', '[تحويل]'], ['POS', 'POS', 'مدى'],
    ['c_stcpay01', 'POS', 'STC Pay'], ['c_drawer01', 'CASH', 'دفعة'],
  ], 'الشيك المعطّل وتابي المعطّلة خارج النموذج، واسم الشركة لا يغلبه الاسم القصير ولا يُترجم');
  assert.ok(!list.some((c) => c.base === ('ONLINE' as string)), 'الإلكتروني من روابط ميسر وحدها');

  // جسم السند: الأساس دائماً، والمفتاح للمضافة وحدها — المدمجة بلا حقلٍ زائد فبصمة clientRef كما اليوم
  assert.deepEqual(choicePayload(list[0]), { paymentMethod: 'CASH' });
  assert.deepEqual(choicePayload(list[3]), { paymentMethod: 'POS', paymentMethodKey: 'c_stcpay01' });
  // لم يختر المستخدم بعد ⇒ الأول (الافتراضي المعروض)؛ واختياره المتاح كما هو
  assert.deepEqual(pickChoice(list, null), { chosen: list[0], unavailable: false });
  assert.deepEqual(pickChoice(list, undefined), { chosen: list[0], unavailable: false });
  assert.deepEqual(pickChoice(list, 'c_stcpay01'), { chosen: list[3], unavailable: false });
  // النقدي معطّل ⇒ أول المفعّلة افتراضياً لا CASH المخفي
  const noCash = receiptChoicesFor(co({ version: 1, builtins: { CASH: { label: null, active: false } }, custom: [] }), arTr);
  assert.equal(pickChoice(noCash, null).chosen!.id, 'POS');
  // قراءةٌ متسامحة أسقطت كل شيء (لا يقع من الحفظ) ⇒ الافتراضي لا نموذجٌ بلا زرّ
  const allOff = { version: 1, builtins: { CASH: { active: false }, POS: { active: false }, BANK_TRANSFER: { active: false }, CHEQUE: { active: false } }, custom: [] };
  assert.deepEqual(receiptChoicesFor(co(allOff), arTr).map((c) => c.id), ['CASH', 'POS', 'BANK_TRANSFER', 'CHEQUE']);
});

test('اختيارٌ اختفى بتحديث إعداد الشركة ⇒ لا بديل عنه أبداً والإصدار ممنوع (لا تحويل بنكي يُقيَّد نقداً)', () => {
  const before = receiptChoicesFor(co(), arTr);
  // المندوب اختار التحويل البنكي، ثم عطّلته الشركة فوصل الإعداد الجديد والنموذج مفتوح
  assert.equal(pickChoice(before, 'BANK_TRANSFER').chosen!.base, 'BANK_TRANSFER');
  const after = receiptChoicesFor(co({ ...CFG, builtins: { ...CFG.builtins, BANK_TRANSFER: { label: null, active: false } } }), arTr);
  assert.ok(!after.some((c) => c.id === 'BANK_TRANSFER'));
  assert.deepEqual(pickChoice(after, 'BANK_TRANSFER'), { chosen: null, unavailable: true }, 'لا يُستبدل به النقدي الأول');
  // مضافةٌ عُطّلت (تابي) أو سقطت من الإعداد ⇒ الأمر نفسه
  assert.deepEqual(pickChoice(after, 'c_tabby001'), { chosen: null, unavailable: true });
  assert.deepEqual(pickChoice(after, 'c_gone0001'), { chosen: null, unavailable: true });
  // عادت مفعّلة ⇒ يعود الاختيار نفسه بلا تدخّل
  assert.equal(pickChoice(before, 'BANK_TRANSFER').unavailable, false);
  // قائمةٌ فارغة (لا تقع — receiptChoicesFor لا يعيدها) لا تخترع اختياراً
  assert.deepEqual(pickChoice([], null), { chosen: null, unavailable: false });
  assert.ok(PHRASES[METHOD_CHOICE_UNAVAILABLE], 'رسالة المنع مترجمة');
});

test('أسماء الشاشات محجوزة بمفتاحٍ مطبَّع: «تحويل» و«دفع الكتروني» و«نقد» لا تكون مضافةً بجانب المدمجة غير المسمّاة', () => {
  const d0 = draftFromConfig(null);
  const add = (label: string, base: 'CASH' | 'POS' | 'BANK_TRANSFER' | 'CHEQUE' = 'CASH', d = d0) =>
    draftIssues({ ...d, custom: [...d.custom, { key: null, rowId: 'n', label, base, icon: 'wallet', active: true }] }).map((i) => [i.path, i.message]);
  const dup = (path: string) => [[path, PAYMENT_METHODS_ISSUES.labelDuplicate]];
  // زرّا «تحويل» في سند المندوب و/m بأساسين مختلفين — يُرفض قبل الإرسال وفي الخادم
  assert.deepEqual(add('تحويل'), dup('custom.0.label'));
  assert.deepEqual(add('دفع الكتروني', 'POS'), dup('custom.0.label'), 'الإلكتروني بكلمة الشاشات بلا همزة');
  assert.deepEqual(add('نقد'), dup('custom.0.label'));
  // التطبيع: التطويل والحركات والهمزات والتاء المربوطة والألف المقصورة وحالة الحروف
  for (const v of ['تحويـــل', 'تَحْوِيل', ' تحويل  ', 'دفع إلكترونى', 'دفع الكترونى', 'شبكه', 'شيـك', 'تحويل بنكى']) assert.deepEqual(add(v), dup('custom.0.label'), v);
  // التحويل البنكي سمّته الشركة ⇒ الشاشات تعرض اسمها وحده فيتحرّر «تحويل»
  const renamed = { ...d0, builtins: d0.builtins.map((b) => (b.method === 'BANK_TRANSFER' ? { ...b, label: 'حوالة' } : b)) };
  assert.deepEqual(add('تحويل', 'CASH', renamed), []);
  assert.deepEqual(add('حواله', 'CASH', renamed), dup('custom.0.label'), 'واسم الشركة نفسه محجوز مطبَّعاً');
  assert.equal(methodLabelKey('  دفع  إلكترونـيّ '), methodLabelKey('دفع الكتروني'));
  assert.deepEqual(DEFAULT_METHOD_ALIASES, { CASH: ['نقد'], BANK_TRANSFER: ['تحويل'], ONLINE: ['دفع الكتروني'] });
});

test('الخطأ على الصفّ الذي عدّله المستخدم: تسمية «نقدي» «شبكة» تُعلَّم على النقدي لا على الشبكة', () => {
  const d0 = draftFromConfig(null);
  const named = (m: string, label: string, d = d0) => ({ ...d, builtins: d.builtins.map((b) => (b.method === m ? { ...b, label } : b)) });
  assert.deepEqual(draftIssues(named('CASH', 'شبكة')).map((i) => [i.path, i.message]), [['builtins.CASH.label', PAYMENT_METHODS_ISSUES.labelDuplicate]]);
  // الشبكة (بعد النقدي في الترتيب) تسمّى «نقدي» ⇒ على الشبكة
  assert.deepEqual(draftIssues(named('POS', 'نقدي')).map((i) => i.path), ['builtins.POS.label']);
  // مدمجتان مسمّاتان بالاسم نفسه ⇒ الثانية في الترتيب
  assert.deepEqual(draftIssues(named('CHEQUE', 'مدى', named('POS', 'مدى'))).map((i) => i.path), ['builtins.CHEQUE.label']);
  // مدمجة مسمّاة ومضافة بالاسم نفسه ⇒ المضافة
  const withCustom = { ...named('POS', 'مدى'), custom: [{ key: null, rowId: 'n', label: 'مدى', base: 'CASH' as const, icon: 'wallet' as const, active: true }] };
  assert.deepEqual(draftIssues(withCustom).map((i) => i.path), ['custom.0.label']);
  // ورفض الخادم بالمسار نفسه (النافذة تعرض issues الخادم على صفوفها)
  const r = checkPaymentMethodsConfig(draftToInput(named('CASH', 'شبكة')));
  assert.ok(!r.ok && r.issues.length === 1 && r.issues[0].path === 'builtins.CASH.label');
});

test('تحذير النافذة: اسمٌ يطابق بلغة الواجهة الحالية اسم طريقة أساسية غير مسمّاة (النواة تحجز العربية وحدها)', () => {
  const en = (s: string) => PHRASES[s]?.en ?? s;
  const d0 = draftFromConfig(null);
  const withLabel = (label: string, d = d0) => ({ ...d, custom: [...d.custom, { key: null, rowId: 'n', label, base: 'POS' as const, icon: 'wallet' as const, active: true }] });
  const cashEn = en('نقدي');
  assert.notEqual(cashEn, 'نقدي', 'المثال يفترض ترجمة «نقدي»');
  // «Cash» بالإنجليزية تمرّ في النواة (لا قاموس في الخادم) لكن النافذة تحذّر
  assert.deepEqual(draftIssues(withLabel(cashEn)), []);
  assert.deepEqual(draftLabelWarnings(withLabel(cashEn), en), ['custom.0.label']);
  assert.deepEqual(draftLabelWarnings(withLabel(cashEn.toUpperCase()), en), ['custom.0.label'], 'بلا حساسية لحالة الحروف');
  assert.deepEqual(draftLabelWarnings(withLabel(en('تحويل')), en), ['custom.0.label'], 'واسم الشاشات القصير مترجماً');
  assert.deepEqual(draftLabelWarnings(withLabel('STC Pay'), en), []);
  // مدمجة مسمّاة باسم أخرى مترجماً ⇒ تحذير؛ وباسمها هي مترجماً ⇒ لا (الطريقة نفسها)
  const posAsCash = { ...d0, builtins: d0.builtins.map((b) => (b.method === 'POS' ? { ...b, label: cashEn } : b)) };
  assert.deepEqual(draftLabelWarnings(posAsCash, en), ['builtins.POS.label']);
  const posAsItself = { ...d0, builtins: d0.builtins.map((b) => (b.method === 'POS' ? { ...b, label: en('شبكة') } : b)) };
  assert.deepEqual(draftLabelWarnings(posAsItself, en), []);
  // النقدي سمّته الشركة ⇒ اسمه المترجم لم يعد معروضاً فلا تحذير
  const cashNamed = { ...withLabel(cashEn), builtins: d0.builtins.map((b) => (b.method === 'CASH' ? { ...b, label: 'كاش' } : b)) };
  assert.deepEqual(draftLabelWarnings(cashNamed, en), []);
  // اسمٌ يساوي الافتراضي ليس تسمية (يُحفظ null) ⇒ يبقى الافتراضي المترجم معروضاً
  const cashDefault = { ...withLabel(cashEn), builtins: d0.builtins.map((b) => (b.method === 'CASH' ? { ...b, label: 'نقدي' } : b)) };
  assert.deepEqual(draftLabelWarnings(cashDefault, en), ['custom.0.label']);
  assert.ok(PHRASES[LABEL_MATCHES_TRANSLATED_DEFAULT], 'التحذير مترجم');
});

test('المسوّدة: ذهاباً وإياباً بقاعدة الخادم نفسها — والافتراضي يبقى null', () => {
  const d0 = draftFromConfig(null);
  assert.deepEqual(d0.builtins.map((b) => b.method), ['CASH', 'POS', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE']);
  assert.deepEqual(draftIssues(d0), []);
  const back = checkPaymentMethodsConfig(draftToInput(d0), { newKey: () => 'c_new00001' });
  assert.ok(back.ok && isDefaultPaymentMethodsConfig(back.value), 'مسوّدة الافتراضي تُحفظ NULL');

  const cfg = readPaymentMethodsConfig(CFG) as PaymentMethodsConfigV1;
  const d = draftFromConfig(cfg);
  assert.ok(draftsEqual(d, draftFromConfig(cfg)));
  const input = draftToInput(d);
  assert.deepEqual(input.custom!.map((c) => c.key), ['c_stcpay01', 'c_tabby001', 'c_drawer01'], 'المحفوظة بمفاتيحها');
  const again = checkPaymentMethodsConfig(input);
  assert.ok(again.ok);
  assert.deepEqual(again.ok && again.value, cfg, 'ما يُقرأ يُحفظ كما هو');

  // طريقة جديدة بلا مفتاح: لا شكوى (الخادم يولّده) — والاسم المكرّر (ولو بافتراضي «نقدي») والفراغ يُرفضان
  const withNew = { ...d, custom: [...d.custom, { key: null, rowId: 'n1', label: 'تمارا', base: 'BANK_TRANSFER' as const, icon: 'wallet' as const, active: true }] };
  assert.deepEqual(draftIssues(withNew), []);
  assert.ok(!('key' in draftToInput(withNew).custom![3]), 'الجديدة تُرسل بلا key');
  const dup = { ...withNew, custom: withNew.custom.map((c, i) => (i === 3 ? { ...c, label: 'نقدي' } : c)) };
  assert.deepEqual(draftIssues(dup).map((i) => [i.path, i.message]), [['custom.3.label', PAYMENT_METHODS_ISSUES.labelDuplicate]]);
  const empty = { ...withNew, custom: withNew.custom.map((c, i) => (i === 3 ? { ...c, label: '  ' } : c)) };
  assert.equal(draftIssues(empty)[0].message, PAYMENT_METHODS_ISSUES.labelRequired);
  // كل الطرق اليدوية معطّلة ⇒ يُرفض قبل الإرسال
  const off = { builtins: d0.builtins.map((b) => ({ ...b, active: false })), custom: [] };
  assert.deepEqual(draftIssues(off).map((i) => i.message), [PAYMENT_METHODS_ISSUES.noneActive]);
  // الإلكتروني يُسمّى ولا يُعطَّل — المسوّدة تبقيه مفعّلاً مهما أُرسل
  const online = { ...d0, builtins: d0.builtins.map((b) => (b.method === 'ONLINE' ? { ...b, label: 'رابط ميسر', active: false } : b)) };
  assert.deepEqual(draftToInput(online).builtins!.ONLINE, { label: 'رابط ميسر', active: true });
  assert.deepEqual(draftIssues(online), []);
});

test('كل رسالة رفضٍ ثابتة مترجمة في اللغات الأربع (تُعرض عبر tr(متغيّر) فلا يلتقطها حارس القاموس الحرفيّ)', () => {
  const msgs = [...Object.values(PAYMENT_METHODS_ISSUES), RECEIPT_METHOD_MESSAGES.unknown, RECEIPT_METHOD_MESSAGES.keyOnline, METHOD_CHOICE_UNAVAILABLE, LABEL_MATCHES_TRANSLATED_DEFAULT];
  for (const m of msgs) {
    const e = PHRASES[m];
    assert.ok(e, `غير مترجمة: ${m}`);
    for (const l of LANGS) assert.ok(e[l] && e[l] !== m && !/[؀-ۿ]/.test(e[l]), `${l}: ${m}`);
  }
});

// ═══ صفحة «طرق الدفع»: أسماء الخادم، والمضافة النقدية سطرٌ مستقلّ، والإجمالي كما هو ═══

const row = (id: string, name: string, amount: number, count: number, over: Partial<PmRow> = {}): PmRow => ({
  salesRepId: id, repName: name, repActive: true, amount, count, receiptsAmount: amount, receiptsCount: count, invoicesAmount: 0, invoicesCount: 0, ...over,
});
const blk = (method: string, rows: PmRow[], over: Record<string, unknown> = {}) => ({ method, rows, total: sumRows(rows), noRep: { amount: 0, count: 0 }, ...over });

test('التقرير: المضافة باسمها لا بمفتاحها، والمدمجة المسمّاة باسم الشركة، والنقدي بشقّيه وحده', () => {
  const data: PaymentMethodsData = {
    range: { from: '2026-10-25', to: '2026-10-25', timezone: 'Asia/Riyadh' },
    methods: [
      blk('CASH', [row('r1', 'محمد', 150, 2, { receiptsAmount: 100, receiptsCount: 1, invoicesAmount: 50, invoicesCount: 1 })], { base: 'CASH', key: null, custom: false, label: 'نقدي', companyLabel: null, icon: null, active: true }),
      blk('POS', [row('r1', 'محمد', 40, 1)], { base: 'POS', key: null, custom: false, label: 'مدى', companyLabel: 'مدى', icon: null, active: true }),
      blk('c_drawer01', [row('r1', 'محمد', 25, 1)], { base: 'CASH', key: 'c_drawer01', custom: true, label: 'كاش الدرج', companyLabel: 'كاش الدرج', icon: 'coins', active: true }),
    ],
    total: { amount: 215, count: 4 }, noRep: { amount: 0, count: 0 }, repsCount: 1,
    roster: [{ salesRepId: 'r1', repName: 'محمد', repActive: true }],
  };
  assert.equal(methodLabel('c_drawer01', brackets, data), 'كاش الدرج');
  assert.equal(methodLabel('POS', brackets, data), 'مدى');
  assert.equal(methodLabel('CASH', brackets, data), '[نقدي]');
  assert.equal(methodLabel('CASH', brackets), '[نقدي]', 'التوقيع القديم بوسيطين كما هو');
  assert.ok(hasCashLikeCustom(data));
  assert.ok(!hasCashLikeCustom({ methods: data.methods.slice(0, 2) }));
  const groups = repMethodList(data);
  assert.equal(groups[0].total.amount, 215, 'كل سندٍ في سطرٍ واحد — الإجمالي لا يتغيّر');
  const [list, summary] = repListSheets(groups, data, brackets);
  const methodCol = '[طريقة الدفع]';
  assert.deepEqual(list.rows.slice(0, 3).map((r) => r[methodCol]), ['[نقدي]', 'مدى', 'كاش الدرج']);
  assert.equal(list.rows[2]['[من سندات القبض]'], '', 'شقّا النقدي للنقدي المدمج وحده — المضافة النقدية سطرٌ مستقلّ');
  assert.deepEqual(summary.rows.map((r) => r[methodCol]), ['[نقدي]', 'مدى', 'كاش الدرج']);
});

test('التحصيل حسب المندوب: عمودٌ لكل طريقة يعرفها الخادم، والافتراضي بالأساس كما اليوم', () => {
  const rc = (id: string, m: string, key: string | null, amount: number) => ({
    id, receiptNumber: id, amount, paymentMethod: m, paymentMethodKey: key, receiptDate: '2026-10-25', customer: null, salesRep: { id: 'r1', name: 'محمد' },
  });
  const rows = [rc('1', 'POS', 'c_stcpay01', 10), rc('2', 'POS', null, 5), rc('3', 'CASH', 'c_gone0001', 7)];
  assert.deepEqual(groupCollectionsByRep(rows)[0].byMethod, { POS: 15, CASH: 7 }, 'بلا محلّل: الأساس كما اليوم');
  const known = new Set(['c_stcpay01']);
  const g = groupCollectionsByRep(rows, (r) => (r.paymentMethodKey && known.has(r.paymentMethodKey) ? r.paymentMethodKey : r.paymentMethod))[0];
  assert.deepEqual(g.byMethod, { c_stcpay01: 10, POS: 5, CASH: 7 }, 'المفتاح المجهول في عمود أساسه');
  assert.equal(g.total, 22);
});

// ═══ حرّاس التوصيل: كل نموذج سند وكل عرض يمرّ بالمساعد الواحد ═══

test('نموذج سند المندوب (أونلاين وصندوق العمل دون اتصال): اختيارات الشركة والأساس والمفتاح', () => {
  const s = src('rep', 'RepApp.tsx');
  const body = s.slice(s.indexOf('function CreateReceipt('), s.indexOf('function AddCustomer('));
  assert.ok(body.includes('receiptChoicesFor(company, tr, REP_RECEIPT_METHODS)'), 'الاختيارات من إعداد الشركة المخزّن');
  assert.ok(body.includes('...choicePayload(chosen)'), 'الجسم (والحمولة التي يحملها الصندوق) يحمل الأساس والمفتاح');
  assert.ok(!body.includes("['BANK_TRANSFER', 'تحويل']"), 'القائمة المكتوبة يدوياً عادت');
  assert.ok(body.includes('paymentMethod: chosen.base, paymentMethodKey: chosen.key'), 'السند الأوف‑لاين يُطبع باسم الطريقة المضافة');
  // اختيارٌ اختفى ⇒ منعٌ ظاهر لا بديل صامت (قبل أي إرسال أو التقاط أوف‑لاين)
  assert.ok(body.includes('const { chosen, unavailable: methodUnavailable } = pickChoice(methodChoices, methodId);'));
  const guard = body.indexOf('if (!chosen) { setMsg(tr(METHOD_CHOICE_UNAVAILABLE)); return; }');
  assert.ok(guard > 0 && guard < body.indexOf('outboxAdd(') && guard < body.indexOf("repApi.post('/receipts'"), 'المنع قبل الإرسال والصندوق');
  assert.ok(body.includes('{methodUnavailable && <p') && !/pickChoice\([^)]*\)!/.test(body));
  assert.ok(!/paymentMethod: method\b/.test(body));
  assert.match(s, /const REP_RECEIPT_METHODS: ChoicesOptions = \{ order: \['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'\], defaultLabels: \{ BANK_TRANSFER: 'تحويل' \} \};/);
});

test('نموذج سند اللوحة و/m: اختيارات الشركة، وحقول الشيك/البنك على الأساس لا المعرّف', () => {
  const m = src('components', 'forms', 'ReceiptModal.tsx');
  assert.ok(m.includes('receiptChoicesFor(company, tr,') && m.includes('...choicePayload(chosen)'));
  assert.ok(m.includes('const paymentMethod = chosen?.base ?? null;') && m.includes("{paymentMethod === 'CHEQUE' && ("));
  assert.ok(m.includes('const { chosen, unavailable: methodUnavailable } = pickChoice(methodChoices, methodId);'));
  const mGuard = m.indexOf('if (!chosen) { toast.error(tr(METHOD_CHOICE_UNAVAILABLE)); return; }');
  assert.ok(mGuard > 0 && mGuard < m.indexOf('mutation.mutate({'), 'منع الإصدار قبل الإرسال');
  assert.ok(m.includes('{methodUnavailable && <p') && m.includes("value={chosen?.id ?? ''}"));
  assert.ok(m.includes('rcp.paymentMethod || sent.paymentMethod'), 'المستند من الجسم المُرسَل لا من اختيار الرسم الحالي');
  assert.ok(!m.includes('<option value="CHEQUE">'), 'القائمة المكتوبة يدوياً عادت');
  const mm = src('m', 'MReceiptCreate.tsx');
  assert.ok(mm.includes('receiptChoicesFor(company as CompanyWithMethods, tr, M_RECEIPT_METHODS)') && mm.includes('...choicePayload(chosen)'));
  assert.ok(mm.includes("const method: string = chosen ? chosen.base : '';"), 'شروط الشيك/البنك على الأساس');
  assert.ok(mm.includes('const { chosen, unavailable: methodUnavailable } = pickChoice(methodChoices, methodId);'));
  assert.ok(mm.includes('const ready = !!chosen &&') && mm.includes('if (!chosen) throw new Error(METHOD_CHOICE_UNAVAILABLE);'), 'زرّ الإصدار معطّل والإرسال ممنوع');
  assert.ok(mm.includes('{methodUnavailable && <p'));
  for (const f of [m, mm]) assert.doesNotMatch(f, /pickChoice\([^)]*\)!/, 'لا افتراض اختيارٍ دائم');
  assert.ok(src('m', 'MDocList.tsx').includes('<MReceiptCreate company={company}'));
  assert.ok(src('m', 'MCustomers.tsx').includes('<MReceiptCreate presetCustomerId={c.id} company={company}'));
  assert.ok(src('m', 'MobileApp.tsx').includes('<MReports accountingOn={accountingOn} company={company}'));
});

test('كل عرضٍ وطباعة بأسماء الشركة: A4 والحراري والقوائم والكشف والتقارير', () => {
  const docs = src('rep', 'RepDocuments.tsx');
  assert.ok(docs.includes("value={methodLabelFor(doc.company, doc.paymentMethod, doc.paymentMethodKey, tr)}"), 'سند A4/النقطية');
  assert.ok(docs.includes('paymentMethodKey: rcp.paymentMethodKey ?? null,'), 'فتح سندٍ قائم يحمل مفتاحه');
  const th = src('rep', 'thermal.ts');
  assert.ok(th.includes('<span>طريقة الدفع</span><span>${esc(methodLabelFor(doc.company, doc.paymentMethod, doc.paymentMethodKey))}</span>'), 'الكلاسيكي بلا tr');
  assert.ok(th.includes('${esc(methodLabelFor(doc.company, doc.paymentMethod, doc.paymentMethodKey, tr))}'));
  assert.ok(!th.includes('paymentMethodLabels'), 'لا قاموسٌ ثانٍ في الحراري');
  const rp = src('pages', 'ReceiptsPage.tsx');
  assert.ok(rp.includes('methodLabelFor(company, r.paymentMethod, r.paymentMethodKey, tr)') && rp.includes('methodBadge(r.paymentMethod, r.paymentMethodKey)'));
  assert.ok(!rp.includes('paymentMethodLabels'));
  const sr = src('pages', 'SalesRepsPage.tsx');
  assert.equal((sr.match(/rcpMethod\(r\)/g) || []).length, 3, 'كشف المندوب: الجدول والتصدير والطباعة');
  const rep = src('pages', 'ReportsPage.tsx');
  assert.ok(!rep.includes(": tr('شيك');"), 'الإلكتروني والقيم الغريبة لا تُقرأ «شيك»');
  assert.ok(rep.includes('methodLabel(rc.paymentMethod, rc.paymentMethodKey)'));
  assert.ok(src('m', 'MReports.tsx').includes('methodLabel(r.paymentMethod, tr, company, r.paymentMethodKey)'));
});

test('صفحة «طرق الدفع»: زرّ الإدارة لمن يملك «إعدادات الشركة» وحده، وبوّاباتها كما هي', () => {
  const p = src('pages', 'PaymentMethodsPage.tsx');
  assert.ok(p.includes("const canManageMethods = !!impersonating || (!!user && user.canManageCompanySettings !== false);"));
  assert.ok(p.includes("{canManageMethods && (") && p.includes("{managing && <PaymentMethodsManager onClose={() => setManaging(false)} />}"));
  assert.match(p, /const featureOn = companyQ\.data\?\.paymentMethodsEnabled === true;/);
  assert.match(p, /enabled: accountingReady && accountingOn && featureOn && !rangeBad,/);
  assert.ok(p.includes('methodLabel(b.method, tr, data)') && p.includes('methodLabel(l.method, tr, data)'));
  const mgr = src('components', 'PaymentMethodsManager.tsx');
  assert.ok(mgr.includes('companyApi.paymentMethods.put(draftToInput(d))') && mgr.includes('companyApi.paymentMethods.put(null)'));
  for (const k of ["['company']", "['company-payment-methods']", "['report-payment-methods']", "['report-collections']"]) {
    assert.ok(mgr.includes(`qc.invalidateQueries({ queryKey: ${k} })`), `لا تحديث بعد الحفظ: ${k}`);
  }
  assert.ok(mgr.includes('disabled={savedRow}'), 'أساس الطريقة المحفوظة لا يتغيّر');
  assert.ok(mgr.includes('draftLabelWarnings(draft, tr)') && mgr.includes('warnings.has(`custom.${i}.label`)') && mgr.includes('warnings.has(`builtins.${b.method}.label`)'), 'تحذير الاسم المترجم');
  assert.match(src('api', 'client.ts'), /put: \(data: PaymentMethodsConfigInput \| null\) => api\.put\('\/company\/payment-methods', data \?\? \{ reset: true \}\)/);
});
