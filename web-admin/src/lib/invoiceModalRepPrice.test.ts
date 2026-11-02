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
  assert.ok(modal.includes('<select className="input" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>'));
  // المدير حرّ: لا قيد أنواع المندوب المسموحة في النافذة (الخادم يحرس المندوب وحده)
  assert.doesNotMatch(modal, /switchablePriceTypesOf|priceTypeAllowed|allowedPriceTypes/);
  assert.equal(modal.split('...(priceListOn && { priceListId })').length - 1, 2, 'البيع والمرتجع الحرّ كما كانا');
  assert.ok(modal.includes("{listHint === 'customer' && <span className=\"text-[11px] text-amber-700\">{tr('ليس نوع سعر العميل')}</span>}"));
  assert.ok(modal.includes("{listHint === 'rep' && <span className=\"text-[11px] text-amber-700\">{tr('ليس نوع سعر المندوب')}</span>}"));
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
