// «طلبات المنيو» في تطبيق المندوب (طلب المالك ٢٤ نوفمبر ٢٠٢٦) — المنطق الصرف (catalogOrders.ts) وحرّاسٌ نصّية على ربطه في
// RepApp.tsx وapi/client.ts: البطاقة لا تظهر إلا بطلبٍ مفتوح وللشركة المفعَّل لها المنيو، والتعبئة بمسار الفاتورة المعتاد.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  catalogOrderOf, catalogOrdersCountOf, catalogOrdersOf, isOpenOrder, orderAge, orderLineTotal, orderTelHref, orderTotal, orderUnitGross,
  ordersBadgeText, planPrefill, prefillOf, prefillUnitOf, sortOrdersNewest, withOrderStatus, type CatalogOrder,
} from './catalogOrders';
import { repUnitChoices } from './repProductRules';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => fs.readFileSync(path.join(here, ...p), 'utf8').replace(/\r\n/g, '\n');

const rawOrder = {
  id: 'o1', customerName: ' أبو خالد ', customerPhone: '0551234567', note: '  بعد العصر ', status: 'NEW', createdAt: '2026-11-24T10:00:00.000Z',
  invoiceId: null, matchedCustomer: { id: 'c9', name: 'بقالة الخير' },
  items: [
    { id: 'i1', productId: 'p-water', productName: 'مياه', unitName: 'كرتون', unitFactor: 24, qty: 2, unitPrice: 20, taxPct: 15 },
    { id: 'i2', productId: 'p-juice', productName: 'عصير', unitName: null, unitFactor: 1, qty: 3, unitPrice: 1.5, taxPct: 15 },
    { id: 'i3', productId: null, productName: 'صنف محذوف', unitName: null, unitFactor: 1, qty: 1, unitPrice: 5, taxPct: 0 },
  ],
};

test('تطبيع الطلب: الحقول مقصوصة، والملاحظة الفارغة null، والعميل المطابق، والبند بلا كمية موجبة يسقط', () => {
  const o = catalogOrderOf(rawOrder)!;
  assert.equal(o.customerName, 'أبو خالد');
  assert.equal(o.note, 'بعد العصر');
  assert.deepEqual(o.matchedCustomer, { id: 'c9', name: 'بقالة الخير' });
  assert.equal(o.items.length, 3);
  assert.equal(o.items[2].productId, null, 'صنفٌ حُذف بعد الطلب يبقى باسمه');
  assert.equal(catalogOrderOf({ ...rawOrder, note: '   ' })!.note, null);
  assert.equal(catalogOrderOf({ ...rawOrder, matchedCustomer: null })!.matchedCustomer, null);
  assert.equal(catalogOrderOf({ ...rawOrder, matchedCustomer: { name: 'بلا معرّف' } })!.matchedCustomer, null);
  assert.equal(catalogOrderOf({ ...rawOrder, status: 'WHATEVER' })!.status, 'NEW');
  assert.equal(catalogOrderOf({ ...rawOrder, id: '' }), null, 'بلا معرّف لا يُفتح ولا تُغيَّر حالته');
  const bad = catalogOrderOf({ ...rawOrder, items: [{ productId: 'p', productName: 'x', qty: 0 }, { productId: 'p', productName: 'y', qty: '2', unitFactor: -3 }, null] })!;
  assert.equal(bad.items.length, 1);
  assert.equal(bad.items[0].qty, 2);
  assert.equal(bad.items[0].unitFactor, 1, 'معاملٌ غير صالح = الأساس');
});

test('القائمة والعدّاد: ردٌّ غائب أو غريب لا يُسقط الشاشة ولا يُظهر بطاقةً بعددٍ كاذب', () => {
  assert.equal(catalogOrdersOf([rawOrder, null, 5, { id: 'o2' }]).length, 2);
  assert.equal(catalogOrdersOf({ orders: [rawOrder] }).length, 1);
  assert.deepEqual(catalogOrdersOf(undefined), []);
  assert.deepEqual(catalogOrdersCountOf({ open: 3, fresh: 1 }), { open: 3, fresh: 1 });
  assert.deepEqual(catalogOrdersCountOf({ open: '2', fresh: 9 }), { open: 2, fresh: 2 }, 'الجديدة لا تزيد على المفتوحة');
  assert.deepEqual(catalogOrdersCountOf(null), { open: 0, fresh: 0 });
  assert.deepEqual(catalogOrdersCountOf({ open: -4, fresh: 'x' }), { open: 0, fresh: 0 });
  assert.equal(ordersBadgeText(7), '7');
  assert.equal(ordersBadgeText(120), '99+');
});

test('الإجمالي التقريبي بمعادلة بطاقة المنيو: سعر الوحدة شاملاً مقرَّباً ثم × الكمية', () => {
  const o = catalogOrderOf(rawOrder)!;
  assert.equal(orderUnitGross(o.items[0], 2), 23);
  assert.equal(orderLineTotal(o.items[0], 2), 46);
  // 1.5 × 1.15 = 1.725 ⇒ 1.73 (نصف لأعلى) ثم × 3 = 5.19 — لا 5.175 ⇒ 5.18
  assert.equal(orderUnitGross(o.items[1], 2), 1.73);
  assert.equal(orderLineTotal(o.items[1], 2), 5.19);
  assert.equal(orderTotal(o, 2), 56.19);
  assert.equal(orderUnitGross({ unitPrice: 1.5, taxPct: 15 }, 3), 1.725, 'بخانات عملة الدينار');
});

test('الترتيب والحالة والعمر', () => {
  const a = { id: 'a', status: 'NEW' as const, createdAt: '2026-11-24T08:00:00Z' };
  const b = { id: 'b', status: 'SEEN' as const, createdAt: '2026-11-24T09:00:00Z' };
  const c = { id: 'c', status: 'NEW' as const, createdAt: 'غير تاريخ' };
  assert.deepEqual(sortOrdersNewest([a, c, b]).map(x => x.id), ['b', 'a', 'c']);
  assert.equal(isOpenOrder(a), true);
  assert.equal(isOpenOrder({ status: 'DONE' }), false);
  assert.deepEqual(withOrderStatus([a, b], 'a', 'SEEN').map(x => x.status), ['SEEN', 'SEEN'], 'المطّلع عليه يبقى في القائمة');
  assert.deepEqual(withOrderStatus([a, b], 'b', 'DONE').map(x => x.id), ['a'], 'المنجَز يخرج');
  assert.deepEqual(withOrderStatus([a, b], 'a', 'CANCELLED').map(x => x.id), ['b'], 'الملغى يخرج');
  const now = Date.parse('2026-11-24T12:00:00Z');
  assert.deepEqual(orderAge('2026-11-24T11:59:40Z', now), { unit: 'now' });
  assert.deepEqual(orderAge('2026-11-24T12:00:30Z', now), { unit: 'now' }, 'ساعة الجوال متأخّرة قليلاً');
  assert.deepEqual(orderAge('2026-11-24T11:35:00Z', now), { unit: 'min', n: 25 });
  assert.deepEqual(orderAge('2026-11-24T07:00:00Z', now), { unit: 'hour', n: 5 });
  assert.deepEqual(orderAge('2026-11-22T07:00:00Z', now), { unit: 'date' });
  assert.deepEqual(orderAge('', now), { unit: 'date' });
});

test('رابط الاتصال: أرقامٌ وحدها (والعربية أرقاماً) و«+» الدولية — وما لا رقم فيه لا رابط له', () => {
  assert.equal(orderTelHref('055 123 4567'), 'tel:0551234567');
  assert.equal(orderTelHref('+966 55-123-4567'), 'tel:+966551234567');
  assert.equal(orderTelHref('٠٥٥١٢٣٤٥٦٧'), 'tel:0551234567');
  assert.equal(orderTelHref('javascript:alert(1)'), 'tel:1', 'لا يُبنى رابطٌ إلا من الأرقام');
  assert.equal(orderTelHref('بدون'), null);
  assert.equal(orderTelHref(null), null);
});

test('التعبئة: البنود بأصنافها، والمحذوف يُسمّى ولا يُضاف', () => {
  const p = prefillOf(catalogOrderOf(rawOrder)!);
  assert.equal(p.orderId, 'o1');
  assert.deepEqual(p.items.map(i => i.productId), ['p-water', 'p-juice']);
  assert.deepEqual(p.missing, ['صنف محذوف']);
  assert.deepEqual(p.items[0], { productId: 'p-water', name: 'مياه', unitName: 'كرتون', unitFactor: 24, qty: 2 });
});

const water = { id: 'p-water', unit: 'حبة', units: [{ id: 'u-6', name: 'علبة', factor: 6, isActive: true }, { id: 'u-24', name: 'كرتون', factor: 24, isActive: true }] };
const sale = (p: typeof water & Record<string, unknown>) => repUnitChoices(p, 'SALE');

test('وحدة البند: الاسم والمعامل معاً، وإلا الأساس بالكمية × المعامل', () => {
  assert.deepEqual(prefillUnitOf(sale(water), { unitName: 'كرتون', unitFactor: 24, qty: 2 }), { choice: sale(water)[2], qty: 2 });
  // أُعيدت تسمية الوحدة أو تغيّر معاملها بعد الطلب: عدد الحبّات الذي طلبه العميل لا يتغيّر
  assert.deepEqual(prefillUnitOf(sale(water), { unitName: 'صندوق', unitFactor: 24, qty: 2 }), { choice: sale(water)[0], qty: 48 });
  assert.deepEqual(prefillUnitOf(sale(water), { unitName: 'كرتون', unitFactor: 12, qty: 2 }), { choice: sale(water)[0], qty: 24 });
  assert.deepEqual(prefillUnitOf(sale(water), { unitName: null, unitFactor: 1, qty: 5 }), { choice: sale(water)[0], qty: 5 });
  // غبار الضرب العشريّ يزول (٣ × ٠٫١)
  assert.equal(prefillUnitOf([{ id: null, name: 'كغ', factor: 1 }], { unitName: 'x', unitFactor: 0.1, qty: 3 })!.qty, 0.3);
  assert.equal(prefillUnitOf(sale(water), { unitName: null, unitFactor: 1, qty: 0 }), null);
});

test('قيد «الكبرى فقط»: الأساس غير مسموح ⇒ أكبر وحدةٍ مسموحة تقسم الكمية — وإلا يُتخطّى', () => {
  const big = { ...water, repSaleUnit: 'LARGE' };
  const r = prefillUnitOf(sale(big), { unitName: null, unitFactor: 1, qty: 48 })!;
  assert.equal(r.choice.name, 'كرتون');
  assert.equal(r.qty, 2);
  assert.equal(prefillUnitOf(sale(big), { unitName: null, unitFactor: 1, qty: 18 })!.choice.name, 'علبة', '١٨ حبة = ٣ علب');
  assert.equal(prefillUnitOf(sale(big), { unitName: null, unitFactor: 1, qty: 5 }), null, '٥ حبات لا تُباع بعلبةٍ ولا كرتون');
});

test('خطة التعبئة على أصناف المندوب القابلة للبيع: غير المتاح يُسمّى مرّةً، والصنف بالوحدة نفسها سطرٌ واحد', () => {
  const juice = { id: 'p-juice', unit: 'علبة', units: [] };
  const blocked = { id: 'p-blocked', unit: 'حبة', units: [], repSaleAllowed: false };
  const items = [
    { productId: 'p-water', name: 'مياه', unitName: 'كرتون', unitFactor: 24, qty: 1 },
    { productId: 'p-water', name: 'مياه', unitName: 'باكيت', unitFactor: 12, qty: 1 }, // وحدةٌ أُلغيت ⇒ ١٢ حبة
    { productId: 'p-water', name: 'مياه', unitName: null, unitFactor: 1, qty: 3 },      // + ٣ حبات ⇒ ١٥ حبة سطراً واحداً
    { productId: 'p-juice', name: 'عصير', unitName: null, unitFactor: 1, qty: 2 },
    { productId: 'p-gone', name: 'صنف أوقف', unitName: null, unitFactor: 1, qty: 1 },
    { productId: 'p-gone', name: 'صنف أوقف', unitName: 'كرتون', unitFactor: 6, qty: 1 },
    { productId: 'p-blocked', name: 'ممنوع', unitName: null, unitFactor: 1, qty: 1 },
  ];
  // sellable كما يمرّره CreateInvoice: teamProducts (الفريق + قيود المندوب) — الممنوع لا يصل أصلاً، والموقوف ليس في الكتالوج النشط
  const sellable = [water, juice].filter(p => p.id !== blocked.id);
  const plan = planPrefill(items, sellable, (p) => repUnitChoices(p as typeof water, 'SALE'));
  assert.deepEqual(plan.lines.map(l => [l.product.id, l.choice.name, l.qty]), [['p-water', 'كرتون', 1], ['p-water', 'حبة', 15], ['p-juice', 'علبة', 2]]);
  assert.deepEqual(plan.skipped, ['صنف أوقف', 'ممنوع']);
});

// ═══ حرّاسٌ نصّية على الربط ═══
const app = read('RepApp.tsx');
const client = read('..', 'api', 'client.ts');

test('حارس العميل: المسارات الأربعة، وتطبيق المندوب يبنيها على repApi لا على api الإدارة', () => {
  const api = client.slice(client.indexOf('export const catalogOrdersApiOf'), client.indexOf('export const catalogOrdersApi = catalogOrdersApiOf(api);'));
  assert.ok(api.length > 100, 'catalogOrdersApiOf غائب');
  assert.match(api, /mine: \(status: 'open' \| 'all' = 'open', config\?: AxiosRequestConfig\) => http\.get\('\/catalog-orders\/mine', \{ \.\.\.config, params: \{ status \} \}\)/);
  assert.match(api, /count: \(config\?: AxiosRequestConfig\) => http\.get\('\/catalog-orders\/mine\/count', config\)/);
  assert.match(api, /seen: \(id: string\) => http\.post\(`\/catalog-orders\/\$\{encodeURIComponent\(id\)\}\/seen`\)/);
  assert.match(api, /http\.post\(`\/catalog-orders\/\$\{encodeURIComponent\(id\)\}\/status`, \{ status, \.\.\.\(invoiceId \? \{ invoiceId \} : \{\}\) \}\)/);
  assert.match(app, /const catalogOrders = catalogOrdersApiOf\(repApi\);/);
  assert.doesNotMatch(app, /import \{[^}]*\bcatalogOrdersApi\b[^}]*\} from '\.\.\/api\/client'/, 'api الإدارة يقرأ توكن مساحةٍ أخرى');
});

test('حارس البطاقة: لا تظهر إلا والمنيو مفعّل وطلبٌ مفتوح، والعدّ خلفيّ كل دقيقة والصفحة ظاهرة — والميزة مطفأة لا طلب', () => {
  assert.match(app, /type Screen = [^;]*\| 'orders';/);
  const home = app.slice(app.indexOf('function RepHome('), app.indexOf('// ============ قائمة العملاء'));
  assert.match(home, /\{menuOn && ordersOpen > 0 && \(\n\s*<button onClick=\{\(\) => onQuick\('orders'\)\}/);
  // بعد «تقرير اليوم» مباشرةً (موضعها في لقطة المالك)
  assert.ok(home.indexOf("'dailyreport')}") < home.indexOf("onQuick('orders')"));
  assert.match(home, /if \(!menuOn\) \{ setOrdersOpen\(0\); return; \}/);
  assert.match(home, /if \(document\.visibilityState !== 'visible' \|\| !navigator\.onLine\) return;/);
  assert.match(home, /catalogOrders\.count\(\{ background: true \}\)/);
  assert.match(home, /window\.setInterval\(loadOrdersCount, ORDERS_POLL_MS\)/);
  assert.match(home, /\}, \[menuOn, refreshKey, user\.id\]\);/);
  assert.match(app, /const ORDERS_POLL_MS = 60_000;/);
});

test('حارس الشاشة: إشعار الطلب يفتحها، والمنيو المطفأ يعيدها للرئيسية بعد وصول الإعدادات، ولا عرض بلا المنيو', () => {
  assert.match(app, /if \(s === 'orders'\) \{\n\s*setScreen\('orders'\);/);
  assert.match(app, /else if \(e\.data\.screen === 'orders'\) setScreen\('orders'\);/);
  assert.match(app, /if \(companyReady && !menuOn && screen === 'orders'\) setScreen\('home'\);/);
  assert.match(app, /\{screen === 'orders' && menuOn && \(\n\s*<RepCatalogOrders /);
  const screen = app.slice(app.indexOf('function RepCatalogOrders('), app.indexOf('function RepHome('));
  // دون اتصال: لافتةٌ ولا صفّ
  assert.doesNotMatch(screen, /outboxAdd/);
  assert.match(screen, /if \(!navigator\.onLine\) \{ setOnline\(false\); return; \}/);
  assert.match(screen, /catalogOrders\.seen\(o\.id\)/);
  assert.match(screen, /window\.confirm\(`\$\{tr\('إلغاء الطلب'\)\}؟`\)/, 'الإلغاء بتأكيد');
});

test('حارس الفاتورة: التعبئة بمسار «+١» المعتاد على أصناف المندوب القابلة للبيع، وصدورها يُنجز الطلب، والمقيَّد بالنطاق يمرّ بملف العميل', () => {
  const inv = app.slice(app.indexOf('function CreateInvoice('), app.indexOf('function CreateReceipt('));
  assert.match(inv, /const fill = planPrefill\(prefill\.items, teamProducts, \(p\) => repUnitChoices\(p, repAction\)\);/);
  assert.match(inv, /rows = addLine\(rows, p, c\);/);
  assert.match(inv, /if \(!prefill \|\| isReturn \|\| prefillDone\.current \|\| loadingProducts\) return;/);
  assert.match(inv, /\}, \{ invoiceId: typeof inv\.id === 'string' \? inv\.id : null \}\);/);
  assert.match(inv, /\}, \{ invoiceId: null \}\);/);
  assert.match(app, /setModal\(proximityOn \? 'customerDetail' : 'createInvoice'\);/);
  assert.match(app, /if \(orderInvoice && orderInvoice\.customerId === String\(selectedCustomer\.id\)\) finishOrder\(orderInvoice\.prefill\.orderId, issued\?\.invoiceId \?\? null\);/);
  // الخروج من صفحة العميل يُسقط الطلب المعلّق
  assert.match(app, /useEffect\(\(\) => \{ if \(modal === null\) \{ setOrderInvoice\(null\); setOrderContact\(null\); \} \}, \[modal\]\);/);
  // عميلٌ بلا مطابق: «إضافة عميل» بالاسم والجوال ثم فاتورته
  assert.match(app, /setOrderContact\(\{ name: o\.customerName, phone: o\.customerPhone, prefill \}\);/);
  assert.match(app, /if \(orderContact\) \{ const o = orderContact; setOrderContact\(null\); startOrderInvoice\(c, o\.prefill\); return; \}/);
  const add = app.slice(app.indexOf('function AddCustomer('), app.indexOf('function EditCustomer('));
  assert.match(add, /name: contact\?\.name \?\? '', businessName: prefill\?\.businessName \?\? '', phone: contact\?\.phone \?\? ''/);
});

test('الصيغ: نصوص الميزة الجديدة مستعملةٌ بـtr وعربيةٌ بلا تشكيلٍ ولا فاصلةٍ عليا (تُدمج ترجماتها في strings.ts)', () => {
  const keys = new Set([...app.matchAll(/tr\('([^']+)'\)/g)].map(m => m[1]));
  const offline = /const ORDERS_OFFLINE_MSG = '([^']+)';/.exec(app)?.[1];
  assert.ok(offline && app.includes('tr(ORDERS_OFFLINE_MSG)'), 'لافتة دون اتصال');
  const mine = [
    'طلب جديد', 'طلبات المنيو', 'الإجمالي التقريبي', 'إلغاء الطلب', 'لا طلبات مفتوحة الآن', 'تعذر تحميل الطلبات', 'فاتورة من طلب المنيو',
    'منذ {n} د', 'منذ {n} س', 'مسجل في عملائك باسم {names}', 'ليس في عملائك يضاف عميلا جديدا قبل فاتورته', 'حذف هذا الصنف بعد الطلب',
    'أسعار المنيو للعلم وتسعر الفاتورة بأسعارك المعتادة', 'لا تملك صلاحية إضافة عميل اطلب من الإدارة إضافته ثم أنشئ فاتورته',
    'تعذر حفظ حالة الطلب تحقق من الاتصال', 'تعذر فتح ملف العميل تحقق من الاتصال', 'لم تضف أصناف غير متاحة للبيع الآن: {names}',
  ];
  for (const k of mine) assert.ok(keys.has(k), `غائب: ${k}`);
  for (const k of [...mine, offline!]) {
    assert.doesNotMatch(k, /[ً-ْ]/, `تشكيلٌ في المفتاح: ${k}`);
    assert.doesNotMatch(k, /['’]/, `فاصلةٌ عليا في المفتاح: ${k}`);
  }
});

// تحقّقٌ صغير أن النوع يُصدَّر كما يستعمله RepApp
const _typed: CatalogOrder | null = catalogOrderOf(rawOrder);
void _typed;
