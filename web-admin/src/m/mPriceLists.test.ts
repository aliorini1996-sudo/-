import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  invoiceLine, addInvoiceLine, setInvoiceLineUnit, refreshInvoiceLines, repriceInvoiceLines, priceOverrideOf, suggestedNet, lineKey,
  type SalePick,
} from './mUnits';
import { unitChoices } from '../rep/repUnits';
import { invoiceTotals } from './docMath';

/**
 * «أنواع الأسعار» في تطبيق الإدارة على الجوال: رقاقات نوع السعر في الفاتورة ونوع السعر في ملف العميل و«تبديل نوع السعر» للمندوب.
 * ⚠️ الفخّ الحاكم هنا (docMath.ts): الأسعار **صافية قبل الضريبة** — سعر النوع يُقترح صافياً كما خُزِّن، لا شاملاً كتطبيق المندوب.
 *
 * ماء: القارورة أساسٌ بسعر ٢، والكرتون ٢٤ بسعرٍ محدَّد ٤٥ — و«سعر الجملة» للكرتون ١٠٠ (مخزَّنٌ للأساس 4.166667 بست منازل كما يكتبه
 * الخادم)، و«سعر التجزئة» للقارورة ٢٫٥. وسكر بلا وحدات وبلا سعرٍ في الأنواع.
 */
const UNITS = [{ id: 'u-ctn', name: 'كرتون', factor: 24, price: 45, isActive: true }];
const water: SalePick = {
  id: 'p1', name: 'ماء', unit: 'قارورة', basePrice: 2, taxPct: 15, units: UNITS, primaryUnitId: 'u-ctn', baseConvertedAt: null,
  listPrices: [{ priceListId: 'l-whole', price: 4.166667 }, { priceListId: 'l-retail', price: 2.5 }],
};
const sugar: SalePick = { id: 'p2', name: 'سكر', unit: 'كيس', basePrice: 7.5, taxPct: 15, listPrices: [] };
const [bottle, carton] = unitChoices(water);

test('priceOverrideOf: سعر العميل الخاص يغلب سعر النوع، والنوع من listPrices الصنف — ولا هذا ولا ذاك ⇒ null', () => {
  assert.equal(priceOverrideOf(water, 'l-whole', null), 4.166667);
  assert.equal(priceOverrideOf(water, 'l-retail', []), 2.5);
  assert.equal(priceOverrideOf(water, null, null), null, 'السعر الأساسي');
  assert.equal(priceOverrideOf(water, 'l-gone', null), null, 'نوعٌ لا سعر للصنف فيه');
  assert.equal(priceOverrideOf(sugar, 'l-whole', null), null);
  const cust = [{ productId: 'p1', price: 3, unit: 'قارورة', baseConvertedAt: null }, { productId: 'p2', price: 7, unit: 'كيس', baseConvertedAt: null }];
  assert.equal(priceOverrideOf(water, 'l-whole', cust), 3, 'العميل يغلب النوع');
  assert.equal(priceOverrideOf(sugar, null, cust), 7, 'وسعره يُقترح بلا أنواعٍ أصلاً');
  // صفّ عميلٍ من قبل تحويل الأساس (unit = كرتون) يُعاد إلى أساس الصنف الحالي (÷٢٤) لا يُضرب ×٢٤ مرّةً ثانية
  const converted = { ...water, baseConvertedAt: '2026-10-30T10:00:00.000Z' };
  assert.equal(priceOverrideOf(converted, null, [{ productId: 'p1', price: 48, unit: 'كرتون', baseConvertedAt: null }]), 2);
});

test('بند الفاتورة بسعر النوع ⚠️ صافياً: الكرتون ١٠٠ لا ١١٥، مقرَّباً لأربع منازل — وبلا override كما كان حرفاً', () => {
  const l = invoiceLine(water, carton, priceOverrideOf(water, 'l-whole', null));
  assert.equal(l.unitPrice, 100, 'سعر الجملة صافياً (4.166667 × 24 = 100.000008 مقرَّباً)');
  assert.equal(l.refPrice, 100);
  assert.equal(invoiceTotals([l], 0).total, 115, 'الضريبة يحسبها المحرّك فوق الصافي — لا مرّتين');
  assert.equal(invoiceLine(water, bottle, 4.166667).unitPrice, 4.1667);
  // بلا نوع ولا سعر عميل: سعر الكرتون المحدَّد ٤٥ — والنوع يغلبه
  assert.equal(invoiceLine(water, carton).unitPrice, 45);
  assert.equal(invoiceLine(water, carton, null).unitPrice, 45);
  assert.equal(invoiceLine(sugar).unitPrice, 7.5);
  assert.equal(suggestedNet(water, carton, 3), 72, 'سعر العميل للأساس × المعامل');
  // الإضافة تزيد البند القائم بالوحدة نفسها كما كانت، والجديد بالمقترح
  let ls = addInvoiceLine([], water, carton, 4.166667);
  ls = addInvoiceLine(ls, water, carton, 4.166667);
  assert.deepEqual(ls.map(x => [lineKey(x), x.qty, x.unitPrice]), [['p1:u-ctn', 2, 100]]);
});

test('تبديل وحدة البند يعيد تسعيره بسعر النوع بالوحدة الجديدة، ومعامل الوحدة الذي تغيّر كذلك', () => {
  const ls = addInvoiceLine([], water, carton, 2.5);
  assert.equal(ls[0].unitPrice, 60);
  const back = setInvoiceLineUnit(ls, 'p1:u-ctn', water, bottle, 2.5);
  assert.equal(back[0].unitPrice, 2.5);
  assert.equal(back[0].refPrice, 2.5);
  // الكرتون صار ١٢ ⇒ يُعاد تسعيره بسعر النوع × ١٢
  const smaller: SalePick = { ...water, units: [{ ...UNITS[0], factor: 12 }] };
  const r = refreshInvoiceLines(ls, smaller, 2.5);
  assert.equal(r[0].unitPrice, 30);
  assert.equal(r[0].refPrice, 30);
  assert.equal(refreshInvoiceLines(ls, water, 2.5), ls, 'بلا تغيير ⇒ القائمة نفسها');
});

test('تبديل النوع أو العميل: البند الذي لم يُمسّ يأخذ المقترح الجديد، والمعدَّل يدويّاً يبقى بسعره ويتبع مرجعه وحده', () => {
  const catalog = { p1: water, p2: sugar };
  const whole = (p: SalePick) => priceOverrideOf(p, 'l-whole', null);
  const lines = [
    invoiceLine(water, carton, whole(water)),                    // ١٠٠ لم يُمسّ
    { ...invoiceLine(water, bottle, whole(water)), unitPrice: 4 }, // عُدِّل يدويّاً
    invoiceLine(sugar, unitChoices(sugar)[0], whole(sugar)),      // ليس في النوع
  ];
  const retail = repriceInvoiceLines(lines, catalog, p => priceOverrideOf(p, 'l-retail', null));
  assert.equal(retail[0].unitPrice, 60, 'سعر التجزئة للكرتون');
  assert.equal(retail[0].refPrice, 60);
  assert.equal(retail[1].unitPrice, 4, 'المعدَّل يبقى');
  assert.equal(retail[1].refPrice, 2.5, 'ومرجعه يتبع النوع');
  assert.equal(retail[2], lines[2], 'سعر السكر لم يتغيّر');
  // العودة إلى السعر الأساسي: الكرتون بسعره المحدَّد ٤٥
  assert.equal(repriceInvoiceLines(retail, catalog, () => null)[0].unitPrice, 45);
  // لا تغيّر ⇒ المصفوفة نفسها، وصنفٌ خارج الكتالوج كما هو
  assert.equal(repriceInvoiceLines(retail, catalog, p => priceOverrideOf(p, 'l-retail', null)), retail);
  assert.equal(repriceInvoiceLines(retail, {}, () => 1), retail);
});

// ═══ حرّاس نصّية: التوصيل في الشاشات ═══
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

test('MInvoiceCreate: النوع من ملف العميل، والرقاقات تبدّله، وكل اقتراح سعرٍ بالقاعدة الواحدة صافياً — والجسم يحمل priceListId', () => {
  const s = read('m', 'MInvoiceCreate.tsx');
  assert.ok(s.includes("const listId: string | null = !listsOn ? null : listChoice !== undefined ? listChoice : (custListId ?? null);"));
  assert.ok(s.includes('const overrideOf = (p: SalePick) => priceOverrideOf(p, listId, custRows);'));
  assert.ok(s.includes('productApi.customerPrices(customerId)'), 'أسعار العميل الخاصة تغلب النوع');
  assert.ok(s.includes('setLines(ls => addInvoiceLine(ls, p, c, overrideOf(p)));'));
  assert.ok(s.includes('setLines(ls => setInvoiceLineUnit(ls, key, p, c, overrideOf(p)));'));
  assert.ok(s.includes('refreshInvoiceLines(acc, p, overrideOf(p))'));
  assert.match(s, /setLines\(ls => repriceInvoiceLines\(ls, catalog, overrideOf\)\);[\s\S]{0,200}\}, \[listId, custRows\]\);/);
  assert.ok(s.includes('...(listsOn && { priceListId: listId }),'), 'شركةٌ بلا أنواع: الجسم كما كان');
  assert.ok(s.includes('if (c.id !== customerId) setListChoice(undefined);'), 'عميلٌ آخر يأخذ نوعه');
  assert.ok(s.includes('onClick={() => setListChoice(o.id)}'));
  assert.ok(s.includes('baseLabelOf(priceInfoQ.data, tr)'), 'اسم الرقاقة الأولى كما سمّته الشركة');
  assert.doesNotMatch(s, /import \{[^}]*\bchoiceNet\b[^}]*\} from '\.\.\/rep\/repUnits';/, 'لا سعرٌ مقترح بلا ثالثه (سعر العميل ?? النوع): suggestedNet وحده');
  assert.equal(s.split('suggestedNet(p, ').length - 1, 2, 'تلميح السعر في القائمة بالمقترح نفسه (بوحدات وبلاها)');
  assert.doesNotMatch(s, /tr\(o\.name\)|tr\(l\.name\)/, 'أسماء الأنواع بيانات لا تمرّ بـtr');
  // أسماء الأنواع مرّةً كل ٥ دقائق لا مع كل فاتورة — ونوع عميلٍ لا تعرفه (أُنشئ بعدها) يعيد قراءتها مرّةً، وإلا لا مفتاح فيسعّر
  // الخادم بنوع العميل والبنود مقترحةٌ بالأساس
  assert.match(s, /queryKey: \['m-price-lists'\],[\s\S]{0,400}staleTime: 5 \* 60_000,/);
  const retry = s.slice(s.indexOf('const namesRetried = useRef<string | null>(null);'));
  assert.match(retry, /^const namesRetried[\s\S]{0,120}if \(!custListId \|\| priceLists\.some\(l => l\.id === custListId\) \|\| priceInfoQ\.isFetching \|\| namesRetried\.current === custListId\) return;\s*namesRetried\.current = custListId;\s*void priceInfoQ\.refetch\(\);/);
});

test('MCustomerForm وMSalesReps: «نوع السعر» يُرسل null صريحاً للسعر الأساسي والخانة الظاهرة وحدها، و«تبديل نوع السعر» بين صلاحيات التسعير', () => {
  const f = read('m', 'MCustomerForm.tsx');
  assert.ok(f.includes('if (showPriceList) payload.priceListId = form.priceListId || null;'));
  assert.ok(f.includes("const priceLists = accountingOn && (!customer || customer.priceListId !== undefined) ? priceInfoQ.data?.lists ?? [] : [];"),
    'صفٌّ بلا المفتاح (خادمٌ قبل الميزة) لا يُكتب فوقه null');
  assert.ok(f.includes('enabled: accountingOn,'), 'لا طلب والمحاسبة مطفأة');
  const r = read('m', 'MSalesReps.tsx');
  assert.ok(r.includes("{ title: 'صلاحيات التسعير', keys: ['canChangePrice', 'canSellBelowPrice', 'canChangePriceList'] },"));
  assert.ok(r.includes("canChangePriceList: 'تبديل نوع السعر',"));
  assert.ok(r.includes('canChangePrice: false, canSellBelowPrice: false, canChangePriceList: false,'), 'افتراض الخادم: مطفأة');
  // صلاحيةٌ مانحة (تُقلب مع «تحديد الكل») ومحاسبية (تُخفى والمحاسبة مطفأة)
  const grants = r.slice(r.indexOf('const GRANTS = ['), r.indexOf('] as const;', r.indexOf('const GRANTS = [')));
  assert.match(grants, /'canChangePriceList'/);
  const acc = r.slice(r.indexOf('const ACCOUNTING_PERMS = new Set<PermKey>(['), r.indexOf(']);', r.indexOf('const ACCOUNTING_PERMS')));
  assert.match(acc, /'canChangePriceList'/);
});
