import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CASH_ONLY_LABEL, CASH_ONLY_NOTE, PRICE_LIST_CASH_ONLY_MSG, cashOnlyListOf, effectiveSaleType, priceListsOf,
} from './priceLists';
import { PHRASES } from '../i18n/strings';

/**
 * «بيع نقدي فقط» لقائمة الأسعار (طلب المالك ١٢ نوفمبر ٢٠٢٦: «قائمة السعر لا يتم البيع فيها الا بيع نقدي فقط ولا يمكن بيع بها اجل»)
 * — شركةٌ لها «دفع كاش» نقديةً و«سعر الجملة» عادية. الدوال المشتركة في lib/priceLists.ts، ثم حرّاسٌ نصّية على شاشتي الإدارة
 * (فاتورة الويب و/m) ومحرّر القائمة ولوحتها: قائمة المستند النقدية تثبّت «نقدي» وتعطّل «آجل» و«تقسيط»، ولا يُرسل آجلٌ بها أبداً.
 */
const CASH = { id: 'l-cash', name: 'دفع كاش', sortOrder: 0, cashOnly: true };
const WHOLE = { id: 'l-whole', name: 'سعر الجملة', sortOrder: 1 };

// ═══ priceListsOf: العلم من ردّ GET /price-lists ═══

test('priceListsOf: cashOnly === true الصريحة وحدها تحمل المفتاح — وكل قيمةٍ أخرى أو غيابه (خادمٌ أقدم) بلا مفتاح', () => {
  const info = priceListsOf({
    basePriceLabel: null,
    lists: [
      { id: 'a', name: 'نقدي صريح', sortOrder: 0, cashOnly: true },
      { id: 'b', name: 'معطّل', sortOrder: 1, cashOnly: false },
      { id: 'c', name: 'نصّ', sortOrder: 2, cashOnly: 'true' },
      { id: 'd', name: 'رقم', sortOrder: 3, cashOnly: 1 },
      { id: 'e', name: 'null', sortOrder: 4, cashOnly: null },
      { id: 'f', name: 'خادم أقدم', sortOrder: 5 },
    ],
  });
  assert.deepEqual(info.lists.map(l => l.id), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(info.lists[0].cashOnly, true);
  for (const l of info.lists.slice(1)) assert.ok(!('cashOnly' in l), `${l.name}: مفتاحٌ لقيمةٍ غير true الصريحة`);
  // الشكل كما كان لقائمةٍ بلا العلم: لا مفتاح زائد (الشاشات الأخرى تقارن الصفوف)
  assert.deepEqual(info.lists[5], { id: 'f', name: 'خادم أقدم', sortOrder: 5 });
  // والعدّادات تبقى مع العلم
  const withCounts = priceListsOf({ lists: [{ id: 'x', name: 'س', sortOrder: 0, customersCount: 2, itemsCount: 3, rulesCount: 1, cashOnly: true }] });
  assert.deepEqual(withCounts.lists[0], { id: 'x', name: 'س', sortOrder: 0, customersCount: 2, itemsCount: 3, rulesCount: 1, cashOnly: true });
});

// ═══ cashOnlyListOf: قائمة المستند ═══

test('cashOnlyListOf: القائمة النقدية نفسها (لاسمها في التنبيه)، وغيرها null — الأساس (null) والفارغ والمجهولة والعادية بلا قيد', () => {
  const info = { lists: [CASH, WHOLE] };
  assert.equal(cashOnlyListOf(info, 'l-cash'), CASH);
  assert.equal(cashOnlyListOf(info, 'l-cash')?.name, 'دفع كاش');
  assert.equal(cashOnlyListOf(info, 'l-whole'), null, 'قائمةٌ عادية');
  assert.equal(cashOnlyListOf(info, null), null, 'السعر الأساسي بلا قائمة ولا قيد');
  assert.equal(cashOnlyListOf(info, undefined), null);
  assert.equal(cashOnlyListOf(info, ''), null);
  assert.equal(cashOnlyListOf(info, 'l-gone'), null, 'قائمةٌ لم تُقرأ بعد (أُنشئت بعد الذاكرة) — والخادم يحكم');
  // القوائم لم تصل بعد: لا قيد على الشاشة
  assert.equal(cashOnlyListOf(null, 'l-cash'), null);
  assert.equal(cashOnlyListOf(undefined, 'l-cash'), null);
  assert.equal(cashOnlyListOf({ lists: [] }, 'l-cash'), null);
  // العلم بغير true الصريحة (صفٌّ لم يمرّ بـpriceListsOf) لا يقيّد
  assert.equal(cashOnlyListOf({ lists: [{ ...WHOLE, cashOnly: false }] }, 'l-whole'), null);
  assert.equal(cashOnlyListOf({ lists: [{ ...WHOLE, cashOnly: 'true' as unknown as boolean }] }, 'l-whole'), null);
  // ومن ردّ الخادم مباشرةً
  assert.equal(cashOnlyListOf(priceListsOf({ lists: [CASH, WHOLE] }), 'l-cash')?.id, 'l-cash');
});

// ═══ effectiveSaleType ═══

test('effectiveSaleType: القائمة النقدية تثبّت CASH أيّاً كان المختار، وغيرها كما اختير حرفاً', () => {
  assert.equal(effectiveSaleType('CREDIT', true), 'CASH');
  assert.equal(effectiveSaleType('CASH', true), 'CASH');
  assert.equal(effectiveSaleType('CREDIT', false), 'CREDIT');
  assert.equal(effectiveSaleType('CASH', false), 'CASH');
  // التقسيط آجلٌ بخطة: نوعه CREDIT فيُثبَّت CASH كذلك (والخطة تسقط في الشاشتين)
  assert.equal(effectiveSaleType('CREDIT' as const, !!cashOnlyListOf({ lists: [CASH] }, 'l-cash')), 'CASH');
});

test('النصوص: رسالة الخادم حرفاً، والقيد والاسم بلا اسم القائمة (بيانات الشركة تُضاف قبله)', () => {
  assert.equal(PRICE_LIST_CASH_ONLY_MSG, 'قائمة الأسعار هذه للبيع النقدي فقط — لا يباع بها آجل ولا تقسيط');
  assert.equal(CASH_ONLY_LABEL, 'بيع نقدي فقط');
  assert.equal(CASH_ONLY_NOTE, 'هذه القائمة للبيع النقدي فقط — لا يباع بها آجل ولا تقسيط');
});

// ═══ حرّاس نصّية ═══
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

test('فاتورة الويب (InvoiceModal): قائمة المستند النقدية تثبّت «نقدي» وتعطّل الآجل والتقسيط، ولا يُرسل آجلٌ بها', () => {
  const s = read('components', 'forms', 'InvoiceModal.tsx');
  assert.match(s, /import \{[^}]*\bcashOnlyListOf\b[^}]*\} from '\.\.\/\.\.\/lib\/priceLists';/);
  // قائمة المستند كالخادم (المختارة ⇐ العميل ⇐ المندوب) — والمرتجع لا يمسّه القيد
  assert.ok(s.includes('const cashOnlyList = isReturn ? null : cashOnlyListOf(priceInfo, priceListId);'));
  assert.ok(s.indexOf('const priceListId = adminInvoiceListOf(') < s.indexOf('const cashOnlyList = '), 'بعد تعريف قائمة المستند');
  // الأثر: التبديل إلى قائمةٍ نقدية وعلى الفاتورة آجلٌ أو تقسيط ⇒ نقدي بلا خطة
  assert.match(s, /useEffect\(\(\) => \{\n\s+if \(cashOnlyList && \(type !== 'CASH' \|\| plan !== 'IMMEDIATE'\)\) \{ setType\('CASH'\); setPlan\('IMMEDIATE'\); \}\n\s+\}, \[cashOnlyList, type, plan\]\);/);
  // الخيارات: «آجل» و«تقسيط» معطّلان، والمعروض «نقدي»
  assert.ok(s.includes('<option value="CREDIT" disabled={!!cashOnlyList}>{tr(\'آجل\')}</option>'));
  assert.ok(s.includes('<option value="INSTALLMENT" disabled={!!cashOnlyList}>{tr(\'تقسيط\')}</option>'));
  assert.ok(s.includes("value={cashOnlyList ? 'CASH' : plan === 'INSTALLMENT' ? 'INSTALLMENT' : type}"));
  assert.doesNotMatch(s, /<option value="CASH" disabled/, 'النقدي لا يُعطَّل');
  // التنبيه باسم القائمة (بيانات لا tr) ثم القيد مترجماً
  assert.ok(s.includes('«{cashOnlyList.name}» — {tr(CASH_ONLY_NOTE)}'));
  assert.doesNotMatch(s, /tr\(cashOnlyList\.name\)/);
  // الحارس قبل الإرسال: نقرةٌ سبقت الأثر لا ترسل آجلاً — تُنقل إلى النقدي وتُقال
  const submit = s.slice(s.indexOf('const handleSubmit = () => {'), s.indexOf('    mutation.mutate({\n      customerId, salesRepId, type'));
  assert.ok(submit.length > 0, 'جسم البيع أو handleSubmit غاب');
  assert.match(submit, /if \(cashOnlyList && \(type !== 'CASH' \|\| plan !== 'IMMEDIATE'\)\) \{\n\s+setType\('CASH'\); setPlan\('IMMEDIATE'\);\n\s+toast\.error\(`«\$\{cashOnlyList\.name\}» — \$\{tr\(CASH_ONLY_NOTE\)\}`\);\n\s+return;\n\s+\}/);
  // 409 PRICE_LIST_CASH_ONLY: تُقرأ القوائم من جديد (مفتاح النافذة) والرسالة رسالة الخادم بلغة الواجهة
  assert.match(s, /if \(data\?\.code === 'PRICE_LIST_CASH_ONLY'\) \{\n\s+void qc\.invalidateQueries\(\{ queryKey: \['price-lists'\] \}\);\n\s+toast\.error\(tr\(PRICE_LIST_CASH_ONLY_MSG\), \{ duration: 8000 \}\);\n\s+return;\n\s+\}/);
});

test('فاتورة /m (MInvoiceCreate): النوع الفعّال في الجسم والمراجعة، والأزرار معطّلة، والتنبيه في الخطوتين', () => {
  const s = read('m', 'MInvoiceCreate.tsx');
  assert.ok(s.includes('const cashOnlyList = cashOnlyListOf(priceInfoQ.data, listId);'));
  assert.ok(s.indexOf('const listId: string | null = ') < s.indexOf('const cashOnlyList = '), 'بعد تعريف قائمة الفاتورة');
  assert.ok(s.includes('const saleType = effectiveSaleType(type, !!cashOnlyList);'));
  assert.ok(s.includes("const salePlan: 'IMMEDIATE' | 'INSTALLMENT' = cashOnlyList ? 'IMMEDIATE' : plan;"));
  assert.match(s, /if \(cashOnlyList && \(type !== 'CASH' \|\| plan !== 'IMMEDIATE'\)\) \{ setType\('CASH'\); setPlan\('IMMEDIATE'\); \}\n\s+\}, \[cashOnlyList, type, plan\]\);/);
  // الجسم بالنوع والخطة الفعّالين — لا `type` الخام ولا `plan` الخام
  const body = s.slice(s.indexOf('const res = await invoiceApi.create({'), s.indexOf('items: lines.map(l => ({'));
  assert.ok(body.length > 0);
  assert.ok(body.includes('customerId, salesRepId, type: saleType, discountPct,'));
  assert.ok(body.includes("...(salePlan === 'INSTALLMENT' && {"));
  assert.doesNotMatch(body, /\bsalesRepId, type,|\(plan === 'INSTALLMENT'/);
  // الأزرار: «آجل» و«تقسيط» معطّلان، والتحديد والمراجعة والأقساط بالفعّال
  assert.ok(s.includes("const blocked = !!cashOnlyList && k !== 'CASH';") && s.includes('<button key={k} disabled={blocked} onClick={() => {'));
  assert.ok(s.includes("const on = k === 'INSTALLMENT' ? salePlan === 'INSTALLMENT' : (saleType === k && salePlan !== 'INSTALLMENT');"));
  assert.ok(s.includes("v={salePlan === 'INSTALLMENT' ? tr('تقسيط') : (saleType === 'CASH' ? tr('نقدي') : tr('آجل'))}"));
  assert.ok(s.includes("{salePlan === 'INSTALLMENT' && ("), 'جدولة الأقساط لا تظهر بقائمةٍ نقدية');
  assert.ok(s.includes("() => (salePlan === 'INSTALLMENT' ? previewInstallments("));
  // التنبيه تحت أزرار النوع وفي صندوق القائمة (الرقاقة في خطوة الأصناف)
  assert.equal(s.split('«{cashOnlyList.name}» — {tr(CASH_ONLY_NOTE)}').length - 1, 2);
  assert.doesNotMatch(s, /tr\(cashOnlyList\.name\)/);
  // 409: القوائم بمفتاح /m من جديد، والرسالة رسالة الخادم بلغة الواجهة
  assert.match(s, /if \(data\?\.code === 'PRICE_LIST_CASH_ONLY'\) \{\n\s+qc\.invalidateQueries\(\{ queryKey: \['m-price-lists'\] \}\);\n\s+toast\.error\(tr\(PRICE_LIST_CASH_ONLY_MSG\)\);\n\s+return;\n\s+\}/);
});

test('محرّر القائمة ولوحتها: مفتاح «بيع نقدي فقط» يحفظ بنفسه ومعطَّلٌ أثناء الحفظ، والشارة على صفّ القائمة', () => {
  const ed = read('components', 'priceLists', 'PriceListEditor.tsx');
  assert.ok(ed.includes('mutationFn: (on: boolean) => priceListApi.update(list.id, { cashOnly: on }),'));
  // onSuccess يُنتظر (القوائم تُقرأ قبل أن يعود المفتاح فعّالاً) — ['price-lists'] يشمل مفتاح اللوحة ومفتاح فاتورة الإدارة
  assert.ok(ed.includes("onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['price-lists'] }); toast.success(tr('تم الحفظ')); },"));
  assert.match(ed, /onError: \(e\) => \{[\s\S]{0,200}toast\.error\(m \? tr\(m\) : tr\('تعذر الحفظ'\)\);/);
  assert.ok(ed.includes('const cashOnly = setCashOnly.isPending ? setCashOnly.variables === true : list.cashOnly === true;'));
  assert.ok(ed.includes('role="switch" aria-checked={cashOnly}') && ed.includes('disabled={setCashOnly.isPending}'));
  assert.ok(ed.includes('onClick={() => setCashOnly.mutate(!cashOnly)}'));
  assert.ok(ed.includes('{tr(CASH_ONLY_LABEL)}') && ed.includes('{tr(CASH_ONLY_NOTE)}'));
  const panel = read('components', 'priceLists', 'PriceListsPanel.tsx');
  assert.match(panel, /\{l\.cashOnly && \([\s\S]{0,200}\{tr\(CASH_ONLY_LABEL\)\}/);
  // العدّادات والعلم من مفتاح اللوحة نفسه (priceListsOf يحمل العلم)
  assert.ok(panel.includes("useQuery({ queryKey: ['price-lists', 'counts'], queryFn: async () => priceListsOf((await priceListApi.listWithCounts()).data.data) })"));
  const client = read('api', 'client.ts');
  assert.ok(client.includes('update: (id: string, data: { name?: string; sortOrder?: number; cashOnly?: boolean }) => api.put(`/price-lists/${id}`, data),'));
  // الإنشاء: الجسم { name } كما كان بلا العلم
  assert.ok(client.includes("create: (name: string, extra: { cashOnly?: boolean } = {}) => api.post('/price-lists', { name, ...extra }),"));
});

test('العبارات المارّة بـtr متغيّرةً (القيد والاسم ورسالة الخادم) مترجمةٌ بلغاتها الأربع', () => {
  for (const k of [CASH_ONLY_NOTE, CASH_ONLY_LABEL, PRICE_LIST_CASH_ONLY_MSG]) {
    const e = PHRASES[k];
    assert.ok(e, `غير موجودة في القاموس: ${k}`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(e[lang]?.trim(), `${k} بلا ${lang}`);
  }
});
