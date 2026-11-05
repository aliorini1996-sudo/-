import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminInvoiceListOf, adminListHintOf } from './invoiceModalRepPrice';
import { priceOverrides, repriceUntouched, suggestedNetOf } from './priceLists';
import { unitChoices } from '../rep/repUnits';

/**
 * «نوع سعر المندوب» في فاتورة الإدارة: عميلٌ بلا نوع والمندوب «سعر التجزئة» افتراضاً ⇒ الفاتورة بالتجزئة؛ وعميلٌ نوعه «الجملة»
 * يغلب المندوب؛ ورقاقة المدير تغلبهما بلا قيد المسموح للمندوب.
 */
const water = {
  id: 'p-water', unit: 'قارورة', basePrice: 2, units: [], primaryUnitId: null, baseConvertedAt: null,
  listPrices: [{ priceListId: 'l-whole', price: 1.5 }, { priceListId: 'l-retail', price: 2.5 }],
};

test('الافتراضي: نوع العميل ?? نوع المندوب المختار ?? الأساسي — ورقاقة المدير تغلبه، وشركةٌ بلا أنواع ⇒ null', () => {
  assert.equal(adminInvoiceListOf(true, undefined, 'l-whole', 'l-retail'), 'l-whole', 'نوع العميل يغلب المندوب');
  assert.equal(adminInvoiceListOf(true, undefined, null, 'l-retail'), 'l-retail', 'العميل بلا نوع ⇒ نوع المندوب');
  assert.equal(adminInvoiceListOf(true, undefined, undefined, 'l-retail'), 'l-retail', 'لا عميل بعد ⇒ نوع المندوب');
  assert.equal(adminInvoiceListOf(true, undefined, null, null), null, 'لا هذا ولا ذاك ⇒ الأساسي');
  assert.equal(adminInvoiceListOf(true, undefined, null, undefined), null, 'صفّ مندوبٍ قديم بلا الحقل ⇒ الأساسي كما كان');
  // المدير حرّ: أيّ نوعٍ ولو خارج أنواع المندوب المسموحة، والأساسي صريحاً يغلب نوع المندوب
  assert.equal(adminInvoiceListOf(true, 'l-other', 'l-whole', 'l-retail'), 'l-other');
  assert.equal(adminInvoiceListOf(true, null, null, 'l-retail'), null, 'الأساسي اختيارٌ صريح لا «لم يختر»');
  assert.equal(adminInvoiceListOf(false, 'l-whole', 'l-whole', 'l-retail'), null, 'بلا أنواع لا نوع');
});

test('التلميح: يخالف نوع العميل أو نوع المندوب — ولا تلميح على الافتراضي', () => {
  assert.equal(adminListHintOf('l-whole', 'l-whole', 'l-retail', true), null);
  assert.equal(adminListHintOf('l-retail', 'l-whole', 'l-retail', true), 'customer', 'نوع العميل هو الافتراضي');
  assert.equal(adminListHintOf(null, null, 'l-retail', true), 'rep', 'العميل بلا نوع فالافتراضي من المندوب');
  assert.equal(adminListHintOf('l-whole', null, 'l-retail', false), 'rep', 'المندوب وحده مختار');
  assert.equal(adminListHintOf('l-retail', null, 'l-retail', true), null);
  // كما كان: عميلٌ بلا نوع ومندوبٌ بلا نوع ⇒ «ليس نوع سعر العميل» على أي رقاقة غير الأساسي، ولا تلميح بلا عميل
  assert.equal(adminListHintOf('l-whole', null, null, true), 'customer');
  assert.equal(adminListHintOf('l-whole', null, null, false), null);
});

test('تغيير المندوب يعيد تسعير البنود التي لم تُعدَّل بنوعه، والمعدَّلة تبقى؛ واختيار المدير لا يتبع المندوب', () => {
  const c = unitChoices(water)[0];
  const priceIn = (list: string | null) => suggestedNetOf(c, water.basePrice, priceOverrides([water], list, null)[water.id]);
  const line = (unitPrice: number, refPrice: number) => ({ productId: water.id, unitPrice, refPrice });
  // بلا مندوب: الأساسي ٢ — بندٌ لم يُمسّ وبندٌ عُدّل إلى ٣
  const lines = [line(2, 2), line(3, 2)];
  // المندوب «سعر التجزئة» والعميل بلا نوع ⇒ ٢٫٥ للبند الذي لم يُمسّ، والمعدَّل يبقى ٣ ويتبع مرجعه وحده
  const t1 = adminInvoiceListOf(true, undefined, null, 'l-retail');
  const after = repriceUntouched(lines, () => priceIn(t1), (l, price) => ({ ...l, unitPrice: price }));
  assert.deepEqual(after.map(l => [l.unitPrice, l.refPrice]), [[2.5, 2.5], [3, 2.5]]);
  // مندوبٌ آخر «الجملة» ⇒ ١٫٥
  const t2 = adminInvoiceListOf(true, undefined, null, 'l-whole');
  const after2 = repriceUntouched(after, () => priceIn(t2), (l, price) => ({ ...l, unitPrice: price }));
  assert.deepEqual(after2.map(l => [l.unitPrice, l.refPrice]), [[1.5, 1.5], [3, 1.5]]);
  // المدير اختار التجزئة برقاقة: تغيير المندوب لا يبدّل النوع ⇒ لا إعادة تسعير (المصفوفة نفسها)
  const t3 = adminInvoiceListOf(true, 'l-retail', null, 'l-whole');
  assert.equal(t3, 'l-retail');
  const again = repriceUntouched(after, () => priceIn(t3), (l, price) => ({ ...l, unitPrice: price }));
  assert.equal(again, after);
  // عميلٌ نوعه الجملة: المندوب لا يغيّر شيئاً
  assert.equal(adminInvoiceListOf(true, undefined, 'l-whole', 'l-retail'), adminInvoiceListOf(true, undefined, 'l-whole', null));
});

// ═══ حرّاس نصّيّة على النافذة ═══
const modal = readFileSync(new URL('../components/forms/InvoiceModal.tsx', import.meta.url), 'utf8');

test('النافذة: النوع من المندوب المختار، ورقاقة المدير بلا قيد المسموح، والجسم كما كان', () => {
  assert.ok(modal.includes("const repDefaultListId = salesReps?.find(r => r.id === salesRepId)?.defaultPriceListId ?? null;"));
  assert.ok(modal.includes('const priceListId = adminInvoiceListOf(priceListOn, listChoice, custListId, repDefaultListId);'));
  assert.ok(modal.includes('value={priceListId} onChange={setListChoice}'), 'الرقاقة اختيار المدير');
  // تغيير العميل يعيد الاختيار إلى الافتراضي، وتغيير المندوب لا يمسّ اختيار المدير (الافتراضي وحده يتغيّر)
  assert.ok(modal.includes('unlinkSale(); pickCustomerList(v); }}'));
  assert.ok(modal.includes('if (id !== customerId) setListChoice(undefined);'));
  // اختيار المندوب يمرّ بـchangeRep (تشغيلات LOT، ٢ نوفمبر) وهو يضبط salesRepId، فيتبعه نوعه الافتراضي من المشتقّ أعلاه
  assert.ok(modal.includes('<select className="input" value={salesRepId} onChange={e => changeRep(e.target.value)}>'));
  assert.ok(modal.includes('    setSalesRepId(id);'));
  // المدير حرّ: لا قيد أنواع المندوب المسموحة في النافذة (الخادم يحرس المندوب وحده)
  assert.doesNotMatch(modal, /switchablePriceTypesOf|priceTypeAllowed|allowedPriceTypes/);
  assert.equal(modal.split('...(priceListOn && { priceListId })').length - 1, 2, 'البيع والمرتجع الحرّ كما كانا');
  // «قوائم الأسعار» (طلب المالك ٥ نوفمبر ٢٠٢٦): العبارتان باسم القائمة
  assert.ok(modal.includes("{listHint === 'customer' && <span className=\"text-[11px] text-amber-700\">{tr('ليست قائمة العميل')}</span>}"));
  assert.ok(modal.includes("{listHint === 'rep' && <span className=\"text-[11px] text-amber-700\">{tr('ليست قائمة المندوب')}</span>}"));
  assert.ok(modal.includes("<span className=\"text-xs font-semibold text-gray-500\">{tr('قائمة الأسعار')}</span>"));
  assert.doesNotMatch(modal, /tr\('(?:نوع السعر|ليس نوع سعر العميل|ليس نوع سعر المندوب)'\)/);
});

/* «قوائم الأسعار» بقواعدها في النافذة: القواعد تُجلب مع القوائم وحدها، والمقترح من المسعِّر الواحد بكمية الصنف ويوم الفاتورة، وكل
 * تغيّرٍ في كمية صنف (إضافة، كمية، وحدة، حذف) يعيد بنوده التي لم تُمسّ — والبنود المرتبطة بفاتورة بيعٍ في جدولها لا تُمسّ */
test('النافذة: القواعد مع القوائم وحدها، والمسعِّر بكمية الصنف ويوم الفاتورة، والكمية تعيد تسعير ما لم يُمسّ', () => {
  const m = modal.replace(/\r\n/g, '\n');
  assert.match(m, /queryKey: \['price-list-rules'\],\s*enabled: priceListOn,\s*queryFn: async \(\) => \(await priceListApi\.rules\(\)\)\.data\.data as PriceListRule\[\],/,
    'شركةٌ بلا قوائم: لا طلب');
  // يوم التسعير (مراجعة D1): التاريخ المختار حين يُرسل، وإلا يوم الشركة الآن بمنطقتها — والإشعار الدائن في المرحلة الثانية (حقل التاريخ
  // مخفيّ ولا يُرسل) بيوم الشركة الآن لا بتاريخٍ بقي من البيع (lib/docLinePricerPerf.test.ts)
  assert.ok(m.includes('const pricingDay = docPricingDayOf(invoiceDate, { dateSent: !(isReturn && phase2), timezone: priceInfo?.timezone });'));
  assert.ok(m.includes('() => docLinePricerOf({ listId: priceListId, custRows, rules: priceListOn ? priceRules : null, day: pricingDay }),'));
  assert.ok(m.includes('[priceListId, custRows, priceListOn, priceRules, pricingDay],'));
  // القائمة أو العميل أو القواعد أو اليوم (المسعِّر) أو الأصناف تغيّرت: ما لم يُمسّ يُعاد — البنود كلّها
  assert.match(m, /useEffect\(\(\) => \{\s*setLines\(ls => repriceLines\(ls\)\);\s*\}, \[pricer, products\]\);/);
  assert.ok(m.includes('const repriceLines = (ls: LineItem[], productId?: string) => repriceDocLines(ls, id => productById.get(id), suggestedNet,'));
  // الإضافة: الجديد بسعره عند كمية صنفه بعده، والزيادة على بندٍ قائم تعيد بنود الصنف (كانت لا تعيد) — بنوده وحدها (مراجعة D5)
  assert.ok(m.includes('const price = suggestedNet(p, c, (docBaseQty(lines).get(p.id) ?? 0) + lineUnitFields(p, c).unitFactor);'));
  assert.ok(m.includes('setLines(ls => repriceLines(ls.map(l => lineKey(l) === lineKey(existing)'));
  assert.ok(m.includes('setLines(ls => repriceLines([...ls, {'));
  // تبديل الوحدة بكمية الصنف بعده
  assert.ok(m.includes('const price = suggestedNet(p, c, docBaseQty(after).get(p.id) ?? 0);'));
  // تعديل الكمية (كان لا يعيد التسعير أبداً) والحذف — بنود الصنف وحده، والكمية بلا قاعدةٍ بحدٍّ أدنى لا تعيد شيئاً
  assert.ok(m.includes('setLines(ls => withQtyReprice(field, ls.map((l, i) => {'));
  assert.ok(m.includes("(field === 'qty' && pricer.dependsOnQty && productId ? repriceLines(ls, productId) : ls);"));
  assert.ok(m.includes('setLines(ls => repriceLines(ls.filter((_, j) => j !== i), ls[i]?.productId))'));
  // تلميح المنتقي بالمقترح نفسه كما سيُضاف (بكمية صنفه في الفاتورة بعد إضافته) — لا مقترح بغير المسعِّر
  assert.ok(m.includes('const net = suggestedNet(p, c, qtyInDoc + lineUnitFields(p, c).unitFactor);'));
  assert.ok(m.includes('options={pickOptions}'));
  assert.doesNotMatch(m, /suggestedNetOf|priceOverrides\(|choiceNet\(/);
  // المرتجع المرتبط بأسعار فاتورته: لا مسعِّر عليه
  assert.doesNotMatch(m, /setLinked\([^\n]*reprice/);
});

/* حفظ المندوب يُبطل قائمة نافذة الفاتورة: النافذة تقرأ نوعه الافتراضي من ['sales-reps-all'] — مفتاحٌ لا يطابقه إبطال ['sales-reps']
 * (البادئة عنصرٌ كامل لا نصّ) — وstaleTime العام ٣٠ ثانية، فبلا إبطالٍ تُسعَّر فاتورةٌ تُفتح بعد الحفظ بنوعه القديم وتُختم به بصمت */
test('حفظ المندوب يبطل [sales-reps-all] الذي تقرأ منه نافذة الفاتورة نوعه الافتراضي', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  const qc = new QueryClient();
  qc.setQueryData(['sales-reps-all'], [{ id: 'r1', defaultPriceListId: null }]);
  await qc.invalidateQueries({ queryKey: ['sales-reps'] });
  assert.equal(qc.getQueryState(['sales-reps-all'])?.isInvalidated, false, 'إبطال [sales-reps] وحده لا يبلغ قائمة النافذة');
  const page = readFileSync(new URL('../pages/SalesRepsPage.tsx', import.meta.url), 'utf8');
  const save = page.slice(page.indexOf('const saveMutation = useMutation({'), page.indexOf('const deleteMutation = useMutation({'));
  assert.ok(save.includes("qc.invalidateQueries({ queryKey: ['sales-reps-all'] });"), 'onSuccess الحفظ يبطلها');
  qc.clear();
});
