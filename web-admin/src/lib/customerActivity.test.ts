import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ACTION_LABELS, ACTIVITY_CATEGORIES, ACTIVITY_FILTERS, ACTOR_KIND_LABELS, CATEGORY_LABELS, CUSTOMER_ACTIONS, FIELD_LABELS,
  actionLabel, activityQuery, actorDisplay, actorKindLabel, allocationsOf, amountOf, categoryOf, changeValue, changesOf, describeChange, detailsOf,
  formatDuration, groupByDay, itemsOf, mergeItems, normalizeItem, normalizePage, noteOf, statusBadgeOf, type ActivityItem,
} from './customerActivity';
import { formatCurrency } from '../utils/format';

// «سجلّ العميل» الثابت (طلب المالك ٢٦ نوفمبر ٢٠٢٦): كل إجراءٍ مع العميل من أيّ أحد، بلا تعديلٍ ولا حذف

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const AR = /[؀-ۿ]/;

const item = (over: Partial<ActivityItem> & { id: string; at: string; action: string }): ActivityItem => ({
  category: categoryOf(over.action), actor: { kind: 'REP', name: 'أحمد' }, refType: null, refId: null, refNo: null,
  amount: null, data: null, historical: false, ...over,
});

// ═══ العقد ═══

test('كل إجراءٍ له اسمٌ عربي وقسم — ولا اسم لإجراءٍ خارج القائمة', () => {
  assert.deepEqual(Object.keys(ACTION_LABELS).sort(), [...CUSTOMER_ACTIONS].sort());
  for (const a of CUSTOMER_ACTIONS) {
    assert.ok(AR.test(ACTION_LABELS[a]), a);
    assert.ok((ACTIVITY_CATEGORIES as readonly string[]).includes(categoryOf(a)), a);
  }
  assert.equal(new Set(Object.values(ACTION_LABELS)).size, CUSTOMER_ACTIONS.length, 'اسمان متطابقان لإجراءين');
});

const BACKEND = path.resolve(SRC, '..', '..', 'backend', 'src', 'services', 'customerActivity.ts');
test('قائمة الإجراءات مرآة الخادم (services/customerActivity.ts)', { skip: !fs.existsSync(BACKEND) && 'الخادم لم يُكتب بعد' }, () => {
  const s = fs.readFileSync(BACKEND, 'utf8');
  const m = s.match(/CUSTOMER_ACTIONS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(m, 'CUSTOMER_ACTIONS غائبة عن الخادم');
  const server = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...server].sort(), [...CUSTOMER_ACTIONS].sort());
  // قسم كل إجراء كما يصنّفه الخادم (ACTION_CATEGORY) — فلا يختلف لون البند عن زرّ القسم الذي جاء به
  const cat = s.match(/ACTION_CATEGORY[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(cat, 'ACTION_CATEGORY غائبة عن الخادم');
  const pairs = [...cat[1].matchAll(/([A-Z_]+):\s*'([a-z]+)'/g)];
  assert.equal(pairs.length, CUSTOMER_ACTIONS.length);
  for (const [, a, c] of pairs) assert.equal(categoryOf(a), c, a);
  // كل حقلٍ يتتبّعه customerDiff له اسمٌ عربي
  const tracked = s.match(/TRACKED_CUSTOMER_FIELDS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(tracked, 'TRACKED_CUSTOMER_FIELDS غائبة عن الخادم');
  for (const [, f] of tracked[1].matchAll(/'(\w+)'/g)) assert.notEqual(describeChange(f), 'حقل آخر', f);
});

test('الأقسام: الزيارة والفاتورة والمرتجع والسند والوثيقة والتعديل — وما لا يُعرف «أخرى»', () => {
  assert.equal(categoryOf('VISIT_RECORDED'), 'visits');
  assert.equal(categoryOf('ROUTE_STOP_ADDED'), 'visits');
  assert.equal(categoryOf('CALL_LOGGED'), 'visits');
  assert.equal(categoryOf('INVOICE_ISSUED'), 'sales');
  assert.equal(categoryOf('CATALOG_ORDER_PLACED'), 'sales');
  assert.equal(categoryOf('RETURN_ISSUED'), 'returns');
  assert.equal(categoryOf('CREDIT_NOTE_ISSUED'), 'returns');
  assert.equal(categoryOf('RECEIPT_ISSUED'), 'money');
  assert.equal(categoryOf('CARD_PAYMENT_COMPLETED'), 'money');
  assert.equal(categoryOf('DOCUMENT_REMOVED'), 'docs');
  assert.equal(categoryOf('CUSTOMER_UPDATED'), 'edits');
  assert.equal(categoryOf('SOMETHING_NEW'), 'other');
  assert.deepEqual([...ACTIVITY_FILTERS], ['all', ...ACTIVITY_CATEGORIES]);
  for (const f of ACTIVITY_FILTERS) assert.ok(AR.test(CATEGORY_LABELS[f]), f);
});

test('عنوان البند: إجراءٌ مجهول «إجراء آخر»، و«إزالة الضريبة» بلا ذكر للضريبة', () => {
  assert.equal(actionLabel('INVOICE_ISSUED'), 'إصدار فاتورة بيع');
  assert.equal(actionLabel('FUTURE_ACTION'), 'إجراء آخر');
  assert.match(actionLabel('CUSTOMER_TAX_DATA_UPDATED'), /الضريبية/);
  assert.doesNotMatch(actionLabel('CUSTOMER_TAX_DATA_UPDATED', { taxOff: true }), /ضريب/);
});

test('المنفّذ: الأدوار السبعة، والاسم المحفوظ لحظة الإجراء وإلا الدور نفسه', () => {
  assert.deepEqual(Object.keys(ACTOR_KIND_LABELS).sort(), ['ADMIN', 'API', 'CUSTOMER', 'OWNER', 'REP', 'STAFF', 'SYSTEM']);
  assert.equal(actorKindLabel('REP'), 'مندوب');
  assert.equal(actorKindLabel('ADMIN'), 'إداري');
  // مالك المنصة وموظفها «الدعم الفني» للشركة — كقاعدة المنصّة (services/customerDocs.ts docUploader)
  assert.equal(actorKindLabel('OWNER'), 'الدعم الفني');
  assert.equal(actorKindLabel('STAFF'), 'الدعم الفني');
  assert.equal(actorKindLabel('API'), 'الربط البرمجي');
  assert.equal(actorKindLabel('CUSTOMER'), 'العميل');
  assert.equal(actorKindLabel('???'), 'النظام');
  assert.equal(actorKindLabel(null), 'النظام');
  assert.deepEqual(actorDisplay({ kind: 'API', name: 'مفتاح أودو' }), { text: 'مفتاح أودو', translate: false });
  assert.deepEqual(actorDisplay({ kind: 'CUSTOMER', name: null }), { text: 'العميل', translate: true });
  assert.deepEqual(actorDisplay({ kind: 'SYSTEM', name: '  ' }), { text: 'النظام', translate: true });
  assert.deepEqual(actorDisplay(null), { text: 'النظام', translate: true });
});

// ═══ تعديل بيانات العميل ═══

test('أسماء الحقول: حقول customerDiff كلها بالعربية — وحقلٌ مجهول «حقل آخر» لا اسمٌ برمجي', () => {
  for (const f of ['name', 'businessName', 'phone', 'email', 'address', 'city', 'district', 'status', 'creditLimit', 'paymentTermDays',
    'paymentDays', 'priceListId', 'channel', 'taxNumber', 'crNumber', 'commercialReg', 'notes', 'location', 'buyerType', 'addrPostalCode']) {
    assert.ok(AR.test(describeChange(f)), f);
  }
  assert.equal(describeChange('balance'), 'حقل آخر');
  assert.equal(describeChange('updatedAt'), 'حقل آخر');
  for (const v of Object.values(FIELD_LABELS)) assert.ok(AR.test(v), v);
});

test('قيم التعديل: الحالة والقناة مترجمتان، والمعرّف الآلي لا يُعرض، والموقع إحداثيان', () => {
  assert.deepEqual(changeValue('status', 'BLOCKED'), { text: 'محظور', translate: true, ltr: false });
  assert.deepEqual(changeValue('channel', 'WHOLESALE'), { text: 'الجملة', translate: true, ltr: false });
  assert.deepEqual(changeValue('phone', '0501234567'), { text: '0501234567', translate: false, ltr: true });
  assert.deepEqual(changeValue('name', null), { text: '—', translate: false, ltr: false });
  assert.equal(changeValue('priceListId', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'), null);
  assert.deepEqual(changeValue('location', { lat: 24.7136, lng: 46.6753 }), { text: '24.71360, 46.67530', translate: false, ltr: true });
  // الحد الائتماني مبلغٌ بعملة الشركة كسائر مبالغ البطاقة (لا رقماً خاماً)، ومدة السداد رقمٌ كما هو
  assert.deepEqual(changeValue('creditLimit', 5000), { text: formatCurrency(5000), translate: false, ltr: true });
  assert.deepEqual(changeValue('paymentDays', 30), { text: '30', translate: false, ltr: true });
  assert.equal(changeValue('x', { a: 1 }), null);
  assert.ok(changeValue('notes', 'x'.repeat(400))!.text.length <= 161);
});

test('تغييرات البند: لا مال حين يُطفأ النظام المحاسبي، ولا ضريبة تحت «إزالة الضريبة»، وlat/lng سطرٌ واحد', () => {
  const it = { data: { changes: [
    { field: 'name', from: 'بقالة', to: 'بقالة النور' },
    { field: 'creditLimit', from: 0, to: 5000 },
    { field: 'taxNumber', from: null, to: '300000000000003' },
    { field: 'lat', from: null, to: 24.7 }, { field: 'lng', from: null, to: 46.6 },
    { field: '', from: 1, to: 2 }, 'junk',
  ] } };
  assert.deepEqual(changesOf(it, { accountingOn: true }).map((c) => c.field), ['name', 'creditLimit', 'taxNumber', 'location']);
  assert.deepEqual(changesOf(it, { accountingOn: false }).map((c) => c.field), ['name', 'taxNumber', 'location']);
  assert.deepEqual(changesOf(it, { accountingOn: true, taxOff: true }).map((c) => c.field), ['name', 'creditLimit', 'location']);
  assert.deepEqual(changesOf({ data: null }, { accountingOn: true }), []);
  assert.deepEqual(changesOf({ data: { changes: 'x' } }, { accountingOn: true }), []);
});

// ═══ التفاصيل والمبلغ ═══

test('التفاصيل: طريقة البيع وعدد الأصناف والسبب — والضريبة والسعر لا يظهران بلا نظام محاسبي، والضريبة لا تظهر تحت «إزالة الضريبة»', () => {
  const inv = { action: 'INVOICE_ISSUED', amount: 115, data: { paymentType: 'CREDIT', itemsCount: 3, taxTotal: 15, total: 115, reason: 'طلب العميل' } };
  const on = detailsOf(inv, { accountingOn: true });
  assert.deepEqual(on.map((d) => [d.label, d.value]), [['طريقة البيع', 'آجل'], ['عدد الأصناف', 3], ['الضريبة', 15], ['السبب', 'طلب العميل']]);
  assert.ok(!detailsOf(inv, { accountingOn: false }).some((d) => d.kind === 'money'));
  assert.ok(!detailsOf(inv, { accountingOn: true, taxOff: true }).some((d) => d.label === 'الضريبة'));
  const price = { action: 'CUSTOMER_PRICE_SET', amount: null, data: { productName: 'ماء ٣٣٠', unitPrice: 2.5 } };
  assert.deepEqual(detailsOf(price, { accountingOn: true }).map((d) => d.label), ['الصنف', 'السعر']);
  assert.deepEqual(detailsOf(price, { accountingOn: false }).map((d) => d.label), ['الصنف']);
  const doc = { action: 'DOCUMENT_ADDED', amount: null, data: { kind: 'CR' } };
  assert.deepEqual(detailsOf(doc, { accountingOn: true, docKindLabel: (k) => (k === 'CR' ? 'السجل التجاري' : '?') }).map((d) => d.value), ['السجل التجاري']);
  const visit = { action: 'VISIT_RECORDED', amount: null, data: { durationSec: 754, photosCount: 2, note: 'وعد بالسداد', fromRep: 'أحمد', toRep: 'صالح' } };
  assert.deepEqual(detailsOf(visit, { accountingOn: true }).map((d) => d.label), ['من المندوب', 'إلى المندوب', 'مدة الزيارة', 'الصور']);
  assert.equal(noteOf(visit), 'وعد بالسداد');
  assert.equal(noteOf({ data: { note: '   ' } }), null);
  // مفاتيح غير متّفق عليها لا تُعرض (لا JSON خام ولا أسرار)
  assert.deepEqual(detailsOf({ action: 'OTHER', amount: null, data: { token: 'abc', image: 'data:image/png;base64,xx' } }, { accountingOn: true }), []);
});

test('تفاصيل المستندات كما يكتبها الخادم: نوع الفاتورة والخصم والأقساط وسبب الإرجاع والشيك والفاتورة المرتبطة وقائمة الأسعار', () => {
  const ret = { action: 'RETURN_ISSUED', amount: 50, refNo: 'RET-1', data: { returnReason: 'DAMAGED', returnToStock: false, discount: 5, invoiceNo: 'RET-1' } };
  assert.deepEqual(detailsOf(ret, { accountingOn: true }).map((d) => [d.label, d.value]),
    [['الخصم', 5], ['سبب الإرجاع', 'بضاعة تالفة'], ['أعيد إلى المخزون', 'لا']]);
  assert.ok(!detailsOf(ret, { accountingOn: false }).some((d) => d.label === 'الخصم'));
  const cancel = { action: 'INVOICE_CANCELLED', amount: 10, data: { invoiceType: 'CREDIT', installmentsCount: 3 } };
  assert.deepEqual(detailsOf(cancel, { accountingOn: true }).map((d) => [d.label, d.value]), [['نوع الفاتورة', 'آجل'], ['عدد الأقساط', 3]]);
  const rc = { action: 'RECEIPT_ISSUED', amount: 100, refNo: 'RC-9', data: { paymentMethod: 'CHEQUE', chequeNumber: '000123', bankName: 'الراجحي' } };
  assert.deepEqual(detailsOf(rc, { accountingOn: true }).map((d) => [d.label, d.value]), [['طريقة الدفع', 'شيك'], ['رقم الشيك', '000123'], ['البنك', 'الراجحي']]);
  const card = { action: 'CARD_PAYMENT_COMPLETED', amount: 20, refNo: 'REF-7', data: { invoiceNo: 'INV-2611-000003' } };
  assert.deepEqual(detailsOf(card, { accountingOn: true }).map((d) => d.value), ['INV-2611-000003']);
  const pl = { action: 'CUSTOMER_PRICE_LIST_CHANGED', amount: null, data: { from: null, to: 'pl-1', toName: 'قائمة الجملة' } };
  assert.deepEqual(detailsOf(pl, { accountingOn: true }).map((d) => [d.label, d.value]), [['القائمة السابقة', 'السعر الأساسي'], ['القائمة الجديدة', 'قائمة الجملة']]);
  assert.deepEqual(detailsOf(pl, { accountingOn: false }), []);
  const created = { action: 'CUSTOMER_CREATED', amount: null, data: { name: 'بقالة النور', number: 12, phone: '0500000000', city: 'الرياض', hasLocation: true, code: 'cxyz' } };
  assert.deepEqual(detailsOf(created, { accountingOn: true }).map((d) => d.value), ['بقالة النور', '#12', '0500000000', 'الرياض', 'محدد']);
  const link = { action: 'PAYLINK_CREATED', amount: 30, data: { expiresAt: '2026-12-01T00:00:00.000Z' } };
  assert.deepEqual(detailsOf(link, { accountingOn: true }).map((d) => [d.label, d.kind]), [['ينتهي في', 'date']]);
});

test('عقد التفاصيل مع مواضع الكتابة: رموز الأسباب والحالات والطرق بالعربية، والرمز المجهول لا يظهر، والعناوين بحسب data', () => {
  const lv = (x: { action: string; data: Record<string, unknown>; actor?: { name: string | null } }) =>
    detailsOf({ amount: null, ...x }, { accountingOn: true }).map((d) => [d.label, d.value]);
  // سببٌ رمزيّ معروف ⇒ عربي، ومجهول ⇒ لا يظهر، ونصٌّ حرّ كتبه المستخدم ⇒ كما هو
  assert.deepEqual(lv({ action: 'PAYLINK_CANCELLED', data: { reason: 'REPLACED' } }), [['السبب', 'استبدل برابط جديد']]);
  assert.deepEqual(lv({ action: 'PAYLINK_CANCELLED', data: { reason: 'SOME_NEW_CODE' } }), []);
  assert.deepEqual(lv({ action: 'INVOICE_CANCELLED', data: { reason: 'خطأ في الكمية' } }), [['السبب', 'خطأ في الكمية']]);
  // حالة البطاقة/الرابط بأحرفٍ صغيرة، وطريق السند
  assert.deepEqual(lv({ action: 'CARD_PAYMENT_FAILED', data: { status: 'declined' } }), [['الحالة', 'مرفوضة']]);
  assert.deepEqual(lv({ action: 'RECEIPT_ISSUED', data: { via: 'PAYLINK' } }), [['عبر', 'رابط دفع']]);
  assert.equal(statusBadgeOf({ action: 'PAYLINK_CREATED', data: { status: 'canceled' } }), 'ملغى');
  assert.deepEqual(lv({ action: 'PAYLINK_CREATED', data: { status: 'canceled' } }), [], 'الشارة تكفي');
  // المندوب المعنيّ (لا يتكرّر إن كان هو المنفّذ)، والفريق، وعدد القيود
  assert.deepEqual(lv({ action: 'CUSTOMER_ASSIGNED', data: { repName: 'صالح' }, actor: { name: 'سارة' } }), [['المندوب', 'صالح']]);
  assert.deepEqual(lv({ action: 'VISIT_RECORDED', data: { repName: 'أحمد' }, actor: { name: 'أحمد' } }), []);
  assert.deepEqual(lv({ action: 'INVOICE_REASSIGNED', data: { kind: 'TEAM', fromTeam: 'الشمال', count: 4, reason: 'TEAM_DELETED' } }),
    [['من الفريق', 'الشمال'], ['العدد', 4], ['السبب', 'حذف الفريق']]);
  assert.deepEqual(lv({ action: 'CALL_LOGGED', data: { durationSec: 65 } }), [['مدة المكالمة', 65]]);
  // تحويل وحدة الأساس: السعر قبل وبعد والوحدتان
  assert.deepEqual(lv({ action: 'CUSTOMER_PRICE_SET', data: { productName: 'ماء', from: 12, to: 1, fromUnit: 'حبة', toUnit: 'كرتون', reason: 'BASE_UNIT_CONVERTED' } }).map((x) => x[0]),
    ['الصنف', 'السعر السابق', 'السعر الجديد', 'الوحدة السابقة', 'الوحدة الجديدة', 'السبب']);
  // العناوين: نطاق مستخدم الشركة لا إسناد مندوب، والحذف النهائي بنوع ما حُذف
  assert.equal(actionLabel('CUSTOMER_ASSIGNED', { data: { kind: 'ADMIN_SCOPE' } }), 'إضافة العميل إلى نطاق مستخدم');
  assert.equal(actionLabel('OTHER', { data: { kind: 'OWNER_PURGE', model: 'Invoice' } }), 'حذف فاتورة نهائيا');
  assert.equal(actionLabel('OTHER', { data: { kind: 'OWNER_PURGE', model: 'Nope' } }), 'حذف نهائي بواسطة مالك المنصة');
  // قيم الحقول: نوع المنفذ ونوع المشتري بالعربية
  assert.equal(changeValue('outletType', 'GROCERY')?.text, 'بقالة / تموينات');
  assert.equal(changeValue('buyerType', 'BUSINESS')?.text, 'منشأة');
  assert.equal(describeChange('returnToStock'), 'أعيد إلى المخزون');
  // أصناف دفعة الأسعار وطلب المنيو
  assert.deepEqual(itemsOf({ data: { items: [{ productName: 'ماء', from: null, to: 2 }, { productName: 'عصير', qty: 3, unitName: 'كرتون' }] } }, { accountingOn: true }),
    [{ name: 'ماء', from: null, to: 2, price: null, qty: null, unit: null }, { name: 'عصير', from: null, to: null, price: null, qty: 3, unit: 'كرتون' }]);
});

test('تحديد الموقع ({from, to}) سطر تغييرٍ واحد، وتوزيع السند على الفواتير', () => {
  const loc = changesOf({ action: 'CUSTOMER_LOCATION_SET', data: { from: null, to: { lat: 24.5, lng: 46.5 } } }, { accountingOn: true });
  assert.deepEqual(loc.map((c) => [c.field, c.from?.text, c.to?.text]), [['location', '—', '24.50000, 46.50000']]);
  assert.deepEqual(allocationsOf({ data: { allocations: [{ invoiceId: 'x', invoiceNo: 'INV-1', amount: 70, settled: true }, { invoiceId: 'y', amount: '30' }, 'junk'] } }),
    [{ invoiceNo: 'INV-1', amount: 70, settled: true, restored: false }, { invoiceNo: null, amount: 30, settled: false, restored: false }]);
  assert.deepEqual(allocationsOf({ data: null }), []);
});

test('المبلغ: amount وإلا data.total — وشارة «ملغى» للبند التاريخي الملغى لا لبند الإلغاء نفسه', () => {
  assert.equal(amountOf({ amount: 10, data: { total: 99 } }), 10);
  assert.equal(amountOf({ amount: null, data: { total: '99.5' } }), 99.5);
  assert.equal(amountOf({ amount: null, data: null }), null);
  assert.equal(statusBadgeOf({ action: 'INVOICE_ISSUED', data: { status: 'CANCELLED' } }), 'ملغى');
  assert.equal(statusBadgeOf({ action: 'RECEIPT_ISSUED', data: { cancelled: true } }), 'ملغى');
  assert.equal(statusBadgeOf({ action: 'PAYLINK_CREATED', data: { status: 'EXPIRED' } }), 'منتهي');
  assert.equal(statusBadgeOf({ action: 'INVOICE_CANCELLED', data: { status: 'CANCELLED' } }), null);
  assert.equal(statusBadgeOf({ action: 'INVOICE_ISSUED', data: { status: 'CONFIRMED' } }), null);
});

test('مدّة الزيارة: دد:ثث أو س:دد:ثث', () => {
  assert.equal(formatDuration(754), '12:34');
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(formatDuration(0), null);
  assert.equal(formatDuration(null), null);
});

// ═══ الصفحات والأيام ═══

test('الصفحة من الخادم بشكلٍ مضمون: بندٌ بلا معرّف أو لحظة يُسقط، والمبلغ رقم، والقسم من الإجراء إن غاب', () => {
  const p = normalizePage({
    items: [
      { id: 'a', at: '2026-11-26T08:00:00Z', action: 'RECEIPT_ISSUED', actor: { kind: 'REP', name: 'أحمد' }, amount: '250.50', refNo: 'RC-1', historical: true },
      { id: 'b', at: 'not-a-date', action: 'INVOICE_ISSUED' },
      { at: '2026-11-26T08:00:00Z', action: 'INVOICE_ISSUED' },
      null,
      { id: 'c', at: '2026-11-25T08:00:00Z', action: 'VISIT_RECORDED', category: 'bogus', data: [1, 2] },
    ],
    nextBefore: '2026-11-25T08:00:00Z',
  });
  assert.deepEqual(p.items.map((x) => x.id), ['a', 'c']);
  assert.equal(p.items[0].amount, 250.5);
  assert.equal(p.items[0].category, 'money');
  assert.equal(p.items[0].historical, true);
  assert.equal(p.items[1].category, 'visits');
  assert.equal(p.items[1].data, null);
  assert.deepEqual(p.items[1].actor, { kind: 'SYSTEM', name: null });
  assert.equal(p.nextBefore, '2026-11-25T08:00:00Z');
  assert.deepEqual(normalizePage(undefined), { items: [], nextBefore: null });
  assert.equal(normalizeItem({ id: 'x', at: '2026-11-26T08:00:00Z' })?.action, 'OTHER');
});

test('دمج الصفحات: بلا تكرار والأحدث أولاً — والتجميع بالأيام بترتيبها', () => {
  const a = item({ id: 'a', at: '2026-11-26T10:00:00' , action: 'VISIT_RECORDED' });
  const b = item({ id: 'b', at: '2026-11-26T09:00:00', action: 'INVOICE_ISSUED' });
  const c = item({ id: 'c', at: '2026-11-24T09:00:00', action: 'RECEIPT_ISSUED' });
  const merged = mergeItems([a, b], [b, c]);
  assert.deepEqual(merged.map((x) => x.id), ['a', 'b', 'c']);
  const groups = groupByDay(merged);
  assert.deepEqual(groups.map((g) => g.items.map((x) => x.id)), [['a', 'b'], ['c']]);
});

test('معاملات الطلب: before وcategory (لا «all») وlimit بسقف ٣٠٠', () => {
  assert.deepEqual(activityQuery(), {});
  assert.deepEqual(activityQuery({ before: '', category: 'all' }), {});
  assert.deepEqual(activityQuery({ before: '2026-11-26T00:00:00Z', category: 'money', limit: 999 }), { before: '2026-11-26T00:00:00Z', category: 'money', limit: 300 });
  assert.deepEqual(activityQuery({ limit: 0 }), {});
});

// ═══ الترجمة ═══

test('كل نصٍّ عربيٍّ في منطق السجلّ مترجمٌ في القاموس (tr بمتغيّر لا يحرسه langs.test)', async () => {
  const { PHRASES } = await import('../i18n/strings');
  const lib = read('lib', 'customerActivity.ts');
  const code = lib.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // نصوصٌ بحرفٍ عربي (لا فاصلة الجمع «، » وحدها)
  const literals = [...new Set([...code.matchAll(/'([^'\n]*[ء-ي][^'\n]*)'/g)].map((m) => m[1]))];
  assert.ok(literals.length > 80, `عدد النصوص ${literals.length} أقلّ من المتوقّع`);
  const comp = ['ActivityList.tsx', 'ActivityTimeline.tsx'].map((f) => read('components', 'customerActivity', f)).join('\n');
  const trCalls = [...comp.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)].map((m) => m[1]);
  const missing = [...literals, ...trCalls].filter((k) => {
    const p = PHRASES[k];
    return !(p && p.en && p.fr && p.tr && p.zh);
  });
  assert.deepEqual([...new Set(missing)], [], 'نصوصٌ بلا ترجمة كاملة');
});

// ═══ حرّاس الواجهة: سجلٌّ للقراءة وحدها ═══

test('المكوّن للقراءة وحدها: لا زرّ تعديلٍ ولا حذف، ولا طلبٌ يكتب — أزراره الفرز و«تحميل المزيد» و«إعادة المحاولة» وحدها', () => {
  const list = read('components', 'customerActivity', 'ActivityList.tsx');
  const tl = read('components', 'customerActivity', 'ActivityTimeline.tsx');
  for (const [name, s] of [['ActivityList', list], ['ActivityTimeline', tl]] as const) {
    assert.doesNotMatch(s, /\b(Trash2?|Pencil|Edit3?|SquarePen|FilePen)\b/, `${name}: أيقونة تعديلٍ أو حذف`);
    assert.doesNotMatch(s, /\bon(Delete|Edit|Remove|Update)\b/, `${name}: معالج تعديلٍ أو حذف`);
    assert.doesNotMatch(s, /\.(delete|put|patch|post)\(/, `${name}: طلبٌ يكتب`);
    assert.doesNotMatch(s, /contentEditable|<input|<textarea|<select/, `${name}: خانة إدخال`);
  }
  assert.doesNotMatch(list, /<button/, 'قائمة البنود بلا أزرار');
  const handlers = [...tl.matchAll(/onClick=\{([^}]*)\}/g)].map((m) => m[1].trim());
  assert.deepEqual(handlers, ['() => setCategory(c)', '() => setReload((n) => n + 1)', 'loadMore']);
  assert.ok(tl.includes("tr('سجل ثابت لا يمكن تعديله أو حذفه')"), 'سطر القفل');
});

test('المال خلف accountingOn: المبلغ وسعر التفاصيل لا يُرسمان حين يُطفأ النظام المحاسبي', () => {
  const list = read('components', 'customerActivity', 'ActivityList.tsx');
  const uses = [...list.matchAll(/formatCurrency\(/g)].length;
  assert.equal(uses, 6);
  // أسعار الأصناف (دفعة الأسعار الخاصة): خلف accountingOn في الرسم، وitemsOf لا يعيدها أصلاً حين يُطفأ
  assert.ok(list.includes('{accountingOn && (l.from !== null || l.to !== null) && ('));
  assert.ok(list.includes('{accountingOn && l.from === null && l.to === null && l.price !== null && <span dir="ltr">{formatCurrency(l.price)}</span>}'));
  assert.deepEqual(itemsOf({ data: { items: [{ productName: 'ماء', from: 2, to: 3, price: 4 }] } }, { accountingOn: false })
    .map((l) => [l.name, l.from, l.to, l.price]), [['ماء', null, null, null]]);
  assert.ok(list.includes("if (d.kind === 'money') return accountingOn ? <span dir=\"ltr\">{formatCurrency(Number(d.value))}</span> : null;"));
  assert.ok(list.includes('{accountingOn && amount !== null && ('));
  assert.ok(list.includes('{accountingOn && a.amount !== null && <span dir="ltr" className="font-semibold">{formatCurrency(a.amount)}</span>}'));
  assert.ok(list.includes(".filter((d) => d.kind !== 'money' || accountingOn)"));
});

test('الرسم: المبلغ يظهر مع النظام المحاسبي ويختفي بدونه، والمنفّذ ودوره و«سجل تاريخي» ورقم المستند', async () => {
  const { default: ActivityList } = await import('../components/customerActivity/ActivityList');
  const items = [
    item({ id: 'i1', at: '2026-11-26T08:00:00Z', action: 'INVOICE_ISSUED', refType: 'INVOICE', refNo: 'INV-2611-000012', amount: 1234.5,
      actor: { kind: 'ADMIN', name: 'سارة' }, data: { paymentType: 'CASH', taxTotal: 161.02, itemsCount: 2 } }),
    item({ id: 'v1', at: '2026-11-25T08:00:00Z', action: 'VISIT_RECORDED', historical: true, data: { note: 'وعد بالسداد', durationSec: 600 } }),
    item({ id: 'u1', at: '2026-11-24T08:00:00Z', action: 'CUSTOMER_UPDATED', actor: { kind: 'SYSTEM', name: null },
      data: { changes: [{ field: 'phone', from: '0500000000', to: '0511111111' }, { field: 'creditLimit', from: 0, to: 9000 }] } }),
    item({ id: 'r1', at: '2026-11-23T08:00:00Z', action: 'RECEIPT_ISSUED', refType: 'RECEIPT', refNo: 'RC-77', amount: 777.25,
      data: { allocations: [{ invoiceId: 'x', invoiceNo: 'INV-9', amount: 333.75, settled: true }] } }),
  ];
  const money = formatCurrency(1234.5);
  for (const n of [777.25, 333.75]) {
    assert.ok(renderToStaticMarkup(h(ActivityList, { items, accountingOn: true })).includes(formatCurrency(n)), `${n} غائب`);
    assert.ok(!renderToStaticMarkup(h(ActivityList, { items, accountingOn: false })).includes(formatCurrency(n)), `${n} ظاهر بلا نظام محاسبي`);
  }
  const on = renderToStaticMarkup(h(ActivityList, { items, accountingOn: true }));
  assert.ok(on.includes(money), 'المبلغ غائب والنظام المحاسبي مفعّل');
  assert.ok(on.includes(formatCurrency(161.02)), 'الضريبة غائبة');
  assert.ok(on.includes('INV-2611-000012'));
  assert.ok(on.includes('سارة') && on.includes('إداري'), 'المنفّذ ودوره');
  assert.ok(on.includes('سجل تاريخي'));
  assert.ok(on.includes('وعد بالسداد'));
  assert.ok(on.includes('0511111111') && on.includes('الحد الائتماني'));
  assert.ok(on.includes('النظام'), 'منفّذٌ بلا اسم ⇒ دوره');
  const off = renderToStaticMarkup(h(ActivityList, { items, accountingOn: false }));
  assert.ok(!off.includes(money), 'المبلغ ظاهر والنظام المحاسبي مطفأ');
  assert.ok(!off.includes(formatCurrency(161.02)), 'الضريبة ظاهرة والنظام المحاسبي مطفأ');
  assert.ok(!off.includes('الحد الائتماني'), 'تعديل الحد الائتماني ظاهر والنظام المحاسبي مطفأ');
  assert.ok(off.includes('INV-2611-000012') && off.includes('إصدار فاتورة بيع'), 'البند نفسه يبقى');
  const taxOff = renderToStaticMarkup(h(ActivityList, { items, accountingOn: true, taxOff: true }));
  assert.ok(!taxOff.includes('الضريبة'), 'ذكر الضريبة تحت «إزالة الضريبة»');
  assert.doesNotMatch(on + off, /<button/, 'زرٌّ في قائمة البنود');
});

test('الرسم: السجلّ قبل وصول الصفحة — سطر القفل وأزرار الأقسام وحدها', async () => {
  const { default: ActivityTimeline } = await import('../components/customerActivity/ActivityTimeline');
  const html = renderToStaticMarkup(h(ActivityTimeline, { fetchPage: async () => ({ items: [], nextBefore: null }), accountingOn: true }));
  assert.ok(html.includes('سجل ثابت لا يمكن تعديله أو حذفه'));
  assert.equal([...html.matchAll(/<button/g)].length, ACTIVITY_FILTERS.length);
  assert.equal([...html.matchAll(/role="tab"/g)].length, ACTIVITY_FILTERS.length);
});

test('أرشيف العميل في اللوحة: «السجل الزمني» هو السجلّ الثابت، و«أين توقفنا» والصور باقيان، وعارض صور السجلّ بلا حذف', () => {
  const s = read('components', 'CustomerStudioModal.tsx');
  assert.ok(s.includes("import ActivityTimeline from './customerActivity/ActivityTimeline';"));
  assert.match(s, /<ActivityTimeline key=\{`\$\{customer\.id\}-\$\{tlRound\}`\} fetchPage=\{fetchActivity\} accountingOn=\{accountingOn\}/);
  assert.ok(s.includes('customerApi.activity(customer.id, { before, category, limit })'));
  assert.ok(s.includes("tr('أين توقفنا مع العميل')"));
  assert.ok(s.includes("label: 'الصور والوثائق'"));
  assert.doesNotMatch(s, /buildEntries|filterEntries|sortEntries/, 'السجلّ القديم (زيارات وحدها) ما زال');
  const tlViewer = s.slice(s.indexOf('{tlViewer && ('), s.indexOf('</div>\n  );\n}', s.indexOf('{tlViewer && (')));
  assert.ok(tlViewer.includes('canDelete={false}'), 'عارض صور السجلّ يحذف');
  // المال في السجلّ خلف إعداد الشركة — ولا قبل معرفته
  assert.ok(s.includes('const accountingOn = accountingReady && accountingFlag;'));
  const client = read('api', 'client.ts');
  assert.ok(client.includes('api.get(`/customers/${id}/activity`, { params: activityQuery(params) })'));
  assert.doesNotMatch(client, /api\.(delete|put|patch|post)\(`\/customers\/\$\{id\}\/activity/, 'مسار كتابةٍ على السجلّ');
});
