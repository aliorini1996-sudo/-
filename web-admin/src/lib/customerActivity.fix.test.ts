/**
 * «سجلّ العميل» — اختبارات انحدار جولة الإصلاح (الواجهة وتطبيق المندوب، ٢٦ نوفمبر ٢٠٢٦):
 *   C1  صور وقفة الزيارة مرّةً واحدة في أرشيف اللوحة (data.visitIds، ولا تُعاد صور ملاحظةٍ لها بندها).
 *   C3  ورقة المندوب: لا مبلغ بلا صلاحية «كشف الحساب» ولو كانت المحاسبة مفعّلة.
 *   C4  علامة «طلب من المنيو — غير موثّق».
 *   C11 رمز سبب الإرجاع بالعربية ولو وصل في data.reason، و«أعيد إلى المخزون».
 *   C21 ترتيب الخادم في اللحظة نفسها يبقى، وبند الصفحة التالية لا يقفز فوق ما عُرض.
 *   C22 البحث و«من نفّذ» و«الأقدم أولاً» في الأرشيف، والتحميل التلقائي حتى السقف بملاحظةٍ ظاهرة.
 *   C23 ورقة المندوب وقائمتها لا تُعاد مع نبضة مؤقّت الزيارة كل ثانية.
 *   C24 مالك المنصة وموظفها «الدعم الفني».
 *   والإجراءات الجديدة في العقد بأسمائها وأقسامها.
 * بالتركيب الحقيقي (React 18 createRoot + act) على DOM مصغّر في الذاكرة حيث يلزم تأثيرٌ أو نقرة — بلا شبكة.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ACTION_LABELS, CUSTOMER_ACTIONS, VIEW_LOAD_CAP, VIEW_PAGE_LIMIT, actionLabel, actorKindLabel, applyView, categoryOf, detailsOf,
  matchesWho, mergeItems, normalizeItem, normalizeSearch, repWho, unverifiedBadgeOf, viewActive, visitPhotoIdsOf, whoOf, whoOptions,
  type ActivityItem, type ActivityPage, type ActivityView,
} from './customerActivity';
import { OBJECTIONS, OUTCOME_LABEL } from '../rep/aiRepLogic';
import { PHRASES } from '../i18n/strings';

process.env.TZ = 'Asia/Riyadh';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const item = (over: Partial<ActivityItem> & { id: string; action: string }): ActivityItem => ({
  at: '2026-03-01T09:00:00Z', category: categoryOf(over.action), actor: { kind: 'REP', name: 'أحمد' }, refType: null, refId: null,
  refNo: null, amount: null, data: null, historical: false, ...over,
});
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

// ═══════════════════ العقد: الإجراءات الجديدة ═══════════════════

test('الإجراءات الجديدة: عناوين عربية مميّزة وأقسام العقد — المال تحرّك فلا «محاولة لم تكتمل» ولا «إلغاء رابط»', () => {
  const expected: Record<string, string> = {
    CARD_PAYMENT_REVERSED: 'money', CARD_PAYMENT_HELD: 'money', PAYLINK_REFUNDED: 'money', RECEIPT_DELETED: 'money',
    LEDGER_JOURNAL_POSTED: 'money', LEDGER_JOURNAL_REVERSED: 'money', INVOICE_DELETED: 'sales', SMART_REP_OUTCOME: 'visits',
  };
  for (const [a, cat] of Object.entries(expected)) {
    assert.ok((CUSTOMER_ACTIONS as readonly string[]).includes(a), `${a} غائب عن CUSTOMER_ACTIONS`);
    assert.equal(categoryOf(a), cat, a);
    const title = actionLabel(a);
    assert.notEqual(title, ACTION_LABELS.OTHER, `${a}: «إجراء آخر»`);
    const p = PHRASES[title];
    assert.ok(p && p.en && p.fr && p.tr && p.zh, `${a}: «${title}» بلا ترجمة كاملة`);
  }
  assert.notEqual(actionLabel('CARD_PAYMENT_REVERSED'), actionLabel('CARD_PAYMENT_FAILED'));
  assert.notEqual(actionLabel('CARD_PAYMENT_HELD'), actionLabel('CARD_PAYMENT_FAILED'));
  assert.notEqual(actionLabel('PAYLINK_REFUNDED'), actionLabel('PAYLINK_CANCELLED'));
  const titles = CUSTOMER_ACTIONS.map((a) => ACTION_LABELS[a]);
  assert.equal(new Set(titles).size, titles.length, 'عنوانان متطابقان');
});

test('نتيجة زيارة المندوب الذكي: النتيجة والاعتراض بالعربية وطريقها «المندوب الذكي» — وكل أسمائها مترجمة في القاموس العامّ', () => {
  const d = detailsOf({ action: 'SMART_REP_OUTCOME', amount: null, data: { kind: 'NOT_INTERESTED', objection: 'PRICE', via: 'AI_REP', note: 'يشتكي من السعر' } },
    { accountingOn: true }).map((x) => [x.label, x.value]);
  assert.deepEqual(d, [['النتيجة', 'غير مهتم'], ['الاعتراض', 'السعر مرتفع'], ['عبر', 'المندوب الذكي']]);
  // رمزٌ مجهول لا يظهر لاتينياً
  assert.deepEqual(detailsOf({ action: 'SMART_REP_OUTCOME', amount: null, data: { kind: 'FUTURE_KIND' } }, { accountingOn: true }), []);
  for (const label of [...Object.values(OUTCOME_LABEL), ...OBJECTIONS.map((o) => o.label)]) {
    const p = PHRASES[label];
    assert.ok(p && p.en && p.fr && p.tr && p.zh, `«${label}» بلا ترجمة في strings.ts`);
  }
});

test('حذف السند نهائياً: المبلغ المعاد إلى الفاتورة مالٌ يختفي بلا نظام محاسبي', () => {
  const it = { action: 'INVOICE_UPDATED', amount: null, data: { reason: 'OWNER_PURGE', receiptNo: 'RC-5', restoredAmount: 120 } };
  assert.deepEqual(detailsOf(it, { accountingOn: true }).map((x) => [x.label, x.value]),
    [['رقم السند', 'RC-5'], ['المبلغ المعاد إلى الفاتورة', 120], ['السبب', 'حذف نهائي بواسطة مالك المنصة']]);
  assert.ok(!detailsOf(it, { accountingOn: false }).some((x) => x.kind === 'money'));
});

test('قراءة التعديلات: نوع هوية المشتري والدولة بأسمائهما، والحد الائتماني بعملة الشركة، وطرفٌ لا يُقرأ بلا خانةٍ فارغة، ورقم العميل «#7»، والرفض بلا ضريبة', async () => {
  const { formatCurrency } = await import('../utils/format');
  const { changeValue, refNoOf } = await import('./customerActivity');
  assert.deepEqual(changeValue('buyerIdScheme', 'CRN'), { text: 'السجل التجاري', translate: true, ltr: false });
  const sa = changeValue('countryCode', 'SA')!;
  assert.ok(sa.text.includes('السعودية') && sa.translate === false, sa.text);
  assert.equal(changeValue('countryCode', 'ZZ')?.text, 'ZZ', 'رمزٌ لا يُعرف يبقى');
  assert.equal(changeValue('creditLimit', '2500.5')?.text, formatCurrency(2500.5));
  assert.equal(refNoOf({ refType: 'CUSTOMER', refNo: '7' }), '#7');
  assert.equal(refNoOf({ refType: 'INVOICE', refNo: '7' }), '7');
  assert.equal(refNoOf({ refType: 'CUSTOMER', refNo: '  ' }), null);
  const voided = { action: 'INVOICE_VOIDED', amount: null, data: { reason: 'REJECTED' } };
  assert.deepEqual(detailsOf(voided, { accountingOn: true, taxOff: true }).map((d) => d.value), ['رفض الفاتورة الإلكترونية']);
  assert.deepEqual(detailsOf(voided, { accountingOn: true }).map((d) => d.value), ['رفض هيئة الزكاة والضريبة']);
  const { default: ActivityList } = await import('../components/customerActivity/ActivityList');
  const html = renderToStaticMarkup(React.createElement(ActivityList, { items: [
    item({ id: 'k', action: 'CUSTOMER_UPDATED', data: { changes: [{ field: 'code', from: 'ckx9q2w3e4r5t6y7u8i9o0p1a', to: 'C-001' }] } }),
    item({ id: 'r', action: 'CUSTOMER_UPDATED', data: { changes: [{ field: 'createdBySalesRepId', from: null, to: '6fa459ea-ee8a-3ca4-894e-db77e160355e' }] } }),
    item({ id: 'h', action: 'CUSTOMER_CREATED', refType: 'CUSTOMER', refNo: '7', historical: true }),
  ], accountingOn: true }));
  assert.doesNotMatch(html, /<span class="(?:text-\[#9A8F7E\] line-through decoration-\[#D9CDB8\]|font-semibold)"><\/span>/, 'خانةٌ فارغة بجوار السهم');
  const text = textOf(html);
  assert.ok(text.includes('C-001') && text.includes('تغير') && text.includes('#7'), text);
  for (const k of ['رفض الفاتورة الإلكترونية']) assert.ok(PHRASES[k]?.zh, k);
});

// ═══════════════════ C24: «الدعم الفني» ═══════════════════

test('C24: مالك المنصة وموظفها «الدعم الفني» — بلا اسمٍ يُعرض الدور، وباسمٍ (لقارئ المنصّة) الاسم وشارة «الدعم الفني»', async () => {
  assert.equal(actorKindLabel('OWNER'), 'الدعم الفني');
  assert.equal(actorKindLabel('STAFF'), 'الدعم الفني');
  const { default: ActivityList } = await import('../components/customerActivity/ActivityList');
  const anon = textOf(renderToStaticMarkup(React.createElement(ActivityList, { items: [
    item({ id: 'o', action: 'DOCUMENT_ADDED', actor: { kind: 'OWNER', name: null } }),
    item({ id: 's', action: 'CUSTOMER_UPDATED', actor: { kind: 'STAFF', name: null } }),
  ], accountingOn: true })));
  assert.equal(anon.split('الدعم الفني').length - 1, 2, anon);
  assert.ok(!anon.includes('مالك المنصة') && !anon.includes('موظف المنصة'), anon);
  const named = textOf(renderToStaticMarkup(React.createElement(ActivityList, { items: [
    item({ id: 'n', action: 'CUSTOMER_UPDATED', actor: { kind: 'STAFF', name: 'ريم' } }),
  ], accountingOn: true })));
  assert.ok(named.includes('ريم') && named.includes('الدعم الفني'), named);
});

// ═══════════════════ C21: ترتيب الخادم ═══════════════════

test('C21: الأحداث في اللحظة نفسها بترتيب الخادم كما أرسله — والدمج لا يقلبه', () => {
  const at = '2026-11-26T10:00:00.123Z';
  const page = [item({ id: 'f-receipt', at, action: 'RECEIPT_ISSUED' }), item({ id: '1-paylink', at, action: 'PAYLINK_PAID' })];
  assert.deepEqual(mergeItems([], page).map((x) => x.action), ['RECEIPT_ISSUED', 'PAYLINK_PAID']);
});

test('C21: بند الصفحة التالية في لحظة الحدّ يأتي بعد ما عُرض لا فوقه — ولا تكرار، والنسخة المعروضة أولاً تبقى', () => {
  const at = '2026-11-26T10:00:00.123Z';
  const p1 = [item({ id: 'z0', at: '2026-11-26T11:00:00Z', action: 'VISIT_RECORDED' }), item({ id: 'f3', at, action: 'INVOICE_ISSUED' }), item({ id: 'f2', at, action: 'INVOICE_PAID' })];
  const p2 = [item({ id: 'f2', at, action: 'INVOICE_PAID', refNo: 'DUP' }), item({ id: 'a1', at, action: 'RECEIPT_ISSUED' }), item({ id: 'b0', at: '2026-11-25T10:00:00Z', action: 'CALL_LOGGED' })];
  const merged = mergeItems(mergeItems([], p1), p2);
  assert.deepEqual(merged.map((x) => x.id), ['z0', 'f3', 'f2', 'a1', 'b0']);
  assert.equal(merged.find((x) => x.id === 'f2')!.refNo, null);
  // مدخلٌ غير مرتّب باللحظة يُرتَّب الأحدث أولاً (فرزٌ ثابت لا يمسّ التساوي)
  assert.deepEqual(mergeItems([], [p2[2], p1[0]]).map((x) => x.id), ['z0', 'b0']);
});

// ═══════════════════ C11: سبب الإرجاع ═══════════════════

test('C11: سبب الإرجاع رمزاً بالعربية — الحيّ (returnReason) والتاريخيّ القديم (reason) — و«أعيد إلى المخزون»، والرمز المجهول لا يظهر', () => {
  const lv = (data: Record<string, unknown>, action = 'RETURN_ISSUED') => detailsOf({ action, amount: 30, data }, { accountingOn: true }).map((d) => [d.label, d.value]);
  assert.deepEqual(lv({ reason: 'DAMAGED', status: 'CONFIRMED' }), [['سبب الإرجاع', 'بضاعة تالفة']]);
  assert.deepEqual(lv({ returnReason: 'EXCHANGE', returnToStock: true }), [['سبب الإرجاع', 'استبدال'], ['أعيد إلى المخزون', 'نعم']]);
  // سبب الإرجاع وسبب الإشعار معاً: كلٌّ بعنوانه
  assert.deepEqual(lv({ returnReason: 'NORMAL', reason: 'خطأ في الكمية' }), [['سبب الإرجاع', 'مرتجع عادي'], ['السبب', 'خطأ في الكمية']]);
  assert.deepEqual(lv({ returnReason: 'NEW_CODE' }), []);
  // رمز الإرجاع على غير مرتجع لا يُقرأ سبب إرجاع
  assert.deepEqual(lv({ reason: 'DAMAGED' }, 'INVOICE_CANCELLED'), []);
});

// ═══════════════════ C4: غير موثّق ═══════════════════

test('C4: طلب المنيو غير الموثّق موسومٌ «طلب من المنيو — غير موثّق» في البطاقة، والموثّق بلا وسم', async () => {
  assert.equal(unverifiedBadgeOf({ action: 'CATALOG_ORDER_PLACED', data: { unverified: true } }), 'طلب من المنيو — غير موثّق');
  assert.equal(unverifiedBadgeOf({ action: 'CATALOG_ORDER_PLACED', data: { unverified: false } }), null);
  assert.equal(unverifiedBadgeOf({ action: 'OTHER', data: { unverified: true } }), 'غير موثّق');
  const { default: ActivityList } = await import('../components/customerActivity/ActivityList');
  const html = renderToStaticMarkup(React.createElement(ActivityList, { items: [
    item({ id: 'u', action: 'CATALOG_ORDER_PLACED', actor: { kind: 'CUSTOMER', name: null }, data: { unverified: true, itemsCount: 2 } }),
    item({ id: 'v', action: 'CATALOG_ORDER_UPDATED', data: { newStatus: 'DONE' } }),
  ], accountingOn: true }));
  assert.equal(textOf(html).split('طلب من المنيو — غير موثّق').length - 1, 1, textOf(html));
  for (const k of ['طلب من المنيو — غير موثّق', 'غير موثّق']) assert.ok(PHRASES[k]?.zh, k);
});

// ═══════════════════ C1: صور الوقفة مرّةً واحدة ═══════════════════

const photoIdx = () => ({
  // وقفة الأرشيف المدموجة برأسها (المؤقّت vT): صورتا الملاحظة vN وصورةٌ لم تصل قائمة الصور (سقف ٣٠٠) فلا يُعرف سجلّها
  stops: new Map([['vT', ['p1', 'p2', 'p3']]]),
  photoSource: new Map([['p1', 'vN'], ['p2', 'vN']]),
  sourcePhotos: new Map([['vN', ['p1', 'p2']]]),
});

test('C1: الوقفة المدموجة (data.visitIds) تُرسم صورها كلها تحت بندها مرّةً واحدة', () => {
  const merged = visitPhotoIdsOf({ refId: 'vT', data: { visitIds: ['vT', 'vN'] } }, photoIdx());
  assert.deepEqual(merged, { headId: 'vT', photoIds: ['p1', 'p2', 'p3'] });
});

test('C1: بندان لسجلّي الوقفة (المؤقّت والملاحظة): كل صورةٍ تحت بندٍ واحد — لا تُعاد صور الملاحظة تحت المؤقّت', () => {
  const timer = visitPhotoIdsOf({ refId: 'vT', data: null }, photoIdx());
  const note = visitPhotoIdsOf({ refId: 'vN', data: null }, photoIdx());
  assert.deepEqual(timer, { headId: 'vT', photoIds: ['p3'] });
  assert.deepEqual(note, { headId: null, photoIds: ['p1', 'p2'] });
  const all = [...timer.photoIds, ...note.photoIds];
  assert.equal(new Set(all).size, all.length, 'صورةٌ مرسومةٌ مرّتين');
  assert.deepEqual([...all].sort(), ['p1', 'p2', 'p3']);
});

// ═══════════════════ C22: البحث و«من نفّذ» والترتيب ═══════════════════

const archiveItems = () => [
  item({ id: 'a', at: '2026-03-03T10:00:00Z', action: 'VISIT_RECORDED', actor: { kind: 'REP', name: 'أحمد' }, data: { note: 'وعد بالسداد يوم الخميس', salesRepId: 'r1' } }),
  item({ id: 'b', at: '2026-03-02T10:00:00Z', action: 'INVOICE_ISSUED', actor: { kind: 'ADMIN', name: 'سارة' }, refNo: 'INV-2611-000012', data: { salesRepId: 'r1' } }),
  item({ id: 'c', at: '2026-03-01T10:00:00Z', action: 'RECEIPT_ISSUED', actor: { kind: 'REP', name: 'خالد', id: 'r2' }, refNo: 'RC-77' }),
  item({ id: 'd', at: '2026-02-28T10:00:00Z', action: 'CUSTOMER_UPDATED', actor: { kind: 'OWNER', name: null }, data: { reason: 'إعادة تصنيف' } }),
];

test('C22: البحث في الملاحظة والرقم والاسم والعنوان — بلا حساسيةٍ للهمزات والتاء المربوطة والأرقام الهندية', () => {
  const items = archiveItems();
  const ids = (v: ActivityView) => applyView(items, v).map((x) => x.id);
  assert.deepEqual(ids({ q: 'السداد' }), ['a']);
  assert.deepEqual(ids({ q: 'الخميس وعد' }), ['a'], 'كل كلمةٍ في البند ولو بغير ترتيبها');
  assert.deepEqual(ids({ q: 'inv-2611' }), ['b']);
  assert.deepEqual(ids({ q: '٧٧' }), ['c'], 'الأرقام الهندية');
  assert.deepEqual(ids({ q: 'ساره' }), ['b'], 'التاء المربوطة هاءً');
  assert.deepEqual(ids({ q: 'اعادة' }), ['d'], 'الهمزة ألفاً');
  assert.deepEqual(ids({ q: 'سند قبض' }), ['c'], 'عنوان البند');
  assert.deepEqual(ids({ q: 'لا يوجد' }), []);
  assert.equal(normalizeSearch('  إعادةُ  '), 'اعاده');
});

test('C22: «من نفّذ» — مندوب الأرشيف بمعرّفه منفّذاً أو صاحب المستند أو باسمه، والمنفّذ بمعرّفه أو اسمه ودوره', () => {
  const items = archiveItems();
  const r1 = repWho('r1', 'أحمد');
  assert.deepEqual(applyView(items, { who: r1 }).map((x) => x.id), ['a', 'b'], 'زيارته وفاتورةٌ هو مندوبها');
  assert.deepEqual(applyView(items, { who: repWho('r2', 'خالد') }).map((x) => x.id), ['c']);
  assert.deepEqual(applyView(items, { who: whoOf(items[1].actor) }).map((x) => x.id), ['b']);
  assert.deepEqual(applyView(items, { who: whoOf(items[3].actor) }).map((x) => x.id), ['d']);
  // المنفّذ بمعرّفه لا يطابق منفّذاً آخر بالاسم نفسه ومعرّفٍ غيره، ولا دوراً آخر بالاسم نفسه
  assert.equal(matchesWho(items[2], { key: 'REP#r9', kind: 'REP', name: 'خالد', id: 'r9' }), false);
  assert.equal(matchesWho(items[0], { key: 'ADMIN:أحمد', kind: 'ADMIN', name: 'أحمد' }), false);
  // الخيارات: مناديب الأرشيف أولاً ثم المنفّذون — المندوب لا يتكرّر باسمه أو معرّفه
  const opts = whoOptions(items, [r1, repWho('r2', 'خالد')]);
  assert.deepEqual(opts.map((o) => o.key), ['REP@r1', 'REP@r2', 'ADMIN:سارة', 'OWNER']);
});

test('C22: «الأقدم أولاً» قلبٌ لترتيب الخادم نفسه — وبلا عرضٍ فعّال تعود القائمة ذاتها', () => {
  const items = archiveItems();
  assert.deepEqual(applyView(items, { order: 'asc' }).map((x) => x.id), ['d', 'c', 'b', 'a']);
  assert.equal(applyView(items, {}), items);
  assert.equal(applyView(items, { q: '   ', order: 'desc' }), items);
  assert.equal(viewActive({ q: ' ' }), false);
  assert.equal(viewActive({ order: 'asc' }), true);
  assert.equal(viewActive({ who: repWho('r1', null) }), true);
});

test('الخادم يرسل معرّف المنفّذ أحياناً: يُحفظ في البند، وغيابه لا يغيّر شكله', () => {
  assert.deepEqual(normalizeItem({ id: 'x', at: '2026-03-01T00:00:00Z', action: 'VISIT_RECORDED', actor: { kind: 'REP', name: 'أحمد', id: 'r1' } })?.actor,
    { kind: 'REP', name: 'أحمد', id: 'r1' });
  assert.deepEqual(normalizeItem({ id: 'x', at: '2026-03-01T00:00:00Z', action: 'VISIT_RECORDED', actor: { kind: 'REP', name: 'أحمد' } })?.actor,
    { kind: 'REP', name: 'أحمد' });
});

test('حرّاس: أدوات العرض لا تكتب شيئاً ولا تعدّل السجلّ، والورقة محفوظة وإغلاقها ثابت، وصلاحية كشف الحساب تصلها', () => {
  const bar = read('components', 'customerActivity', 'ActivityFilterBar.tsx');
  assert.doesNotMatch(bar, /\b(Trash2?|Pencil|Edit3?|SquarePen|FilePen)\b/);
  assert.doesNotMatch(bar, /\.(delete|put|patch|post)\(|\bfetch\(|\b(customerApi|repApi|api)\b/);
  const tl = read('components', 'customerActivity', 'ActivityTimeline.tsx');
  assert.match(tl, /export default memo\(ActivityTimeline\);/);
  assert.match(read('components', 'customerActivity', 'ActivityList.tsx'), /const ActivityList = memo\(ActivityListView\);/);
  const sheet = read('rep', 'RepCustomerTimeline.tsx');
  assert.match(sheet, /export default memo\(RepCustomerTimeline\);/);
  assert.ok(sheet.includes('const accountingOn = accountingFlag && canViewStatement !== false;'));
  const app = read('rep', 'RepApp.tsx');
  assert.ok(app.includes('const closeTimeline = useCallback(() => setTimelineOpen(false), []);'));
  assert.ok(app.includes('{timelineOpen && <RepCustomerTimeline customer={customer} accountingOn={accountingOn} canViewStatement={canViewStatement} taxOff={isTaxOff(company)} onClose={closeTimeline} />}'));
});

// ═══════════════════ DOM مصغّر يكفي react-dom (للتأثيرات والنقرات) ═══════════════════

const ELEM = 1, TEXT = 3, COMMENT = 8, DOC = 9;
const HTML_NS = 'http://www.w3.org/1999/xhtml';
/* eslint-disable @typescript-eslint/no-explicit-any */
class FNode {
  nodeType: number; nodeName: string; ownerDocument: any; parentNode: any = null; childNodes: any[] = []; nodeValue: string | null = null;
  constructor(t: number, n: string, d: any) { this.nodeType = t; this.nodeName = n; this.ownerDocument = d; }
  get firstChild(): any { return this.childNodes[0] ?? null; }
  get lastChild(): any { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): any { const s = this.parentNode?.childNodes as any[] | undefined; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  get parentElement(): any { return this.parentNode && this.parentNode.nodeType === ELEM ? this.parentNode : null; }
  appendChild(c: any) { c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c: any, ref: any) {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c;
  }
  removeChild(c: any) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  get textContent(): string { return this.nodeType === TEXT ? (this.nodeValue ?? '') : this.nodeType === COMMENT ? '' : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) {
    if (this.nodeType === TEXT || this.nodeType === COMMENT) { this.nodeValue = v; return; }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  get data(): string { return this.nodeValue ?? ''; }
  set data(v: string) { this.nodeValue = v; }
  addEventListener() { /* الأحداث تُستدعى من خصائص React مباشرة */ }
  removeEventListener() { /* — */ }
  contains(n: any) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
}
class FElement extends FNode {
  tagName: string; namespaceURI: string; attrs = new Map<string, string>(); style: any;
  constructor(tag: string, d: any, ns = HTML_NS) {
    super(ELEM, tag.toUpperCase(), d);
    this.tagName = ns === HTML_NS ? tag.toUpperCase() : tag; this.namespaceURI = ns;
    const st: Record<string, unknown> = {};
    this.style = Object.assign(st, { setProperty: (k: string, v: string) => { st[k] = v; }, removeProperty: (k: string) => { delete st[k]; } });
  }
  setAttribute(n: string, v: unknown) { this.attrs.set(n, String(v)); }
  setAttributeNS(_ns: string, n: string, v: unknown) { this.attrs.set(n, String(v)); }
  getAttribute(n: string) { return this.attrs.has(n) ? this.attrs.get(n)! : null; }
  removeAttribute(n: string) { this.attrs.delete(n); }
  hasAttribute(n: string) { return this.attrs.has(n); }
  get innerHTML(): string { return this.textContent; }
  set innerHTML(v: string) { this.textContent = v; }
  /** خيارات <select> كما يقرؤها react-dom */
  get options(): any[] { return walk(this, (x) => x.tagName === 'OPTION'); }
  focus() { /* — */ }
  blur() { /* — */ }
}
class FDocument extends FNode {
  documentElement: any; body: any; head: any; activeElement: any = null;
  constructor() {
    super(DOC, '#document', null);
    this.documentElement = new FElement('html', this); this.head = new FElement('head', this); this.body = new FElement('body', this);
    this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body); this.appendChild(this.documentElement);
  }
  createElement(t: string) { return new FElement(t, this); }
  createElementNS(ns: string, t: string) { return new FElement(t, this, ns); }
  createTextNode(s: string) { const n = new FNode(TEXT, '#text', this); n.nodeValue = s; return n; }
  createComment(s: string) { const n = new FNode(COMMENT, '#comment', this); n.nodeValue = s; return n; }
}

const doc = new FDocument();
const g = globalThis as any;
const storage = new Map<string, string>();
g.window = g;
g.document = doc;
g.HTMLIFrameElement = class {};
g.localStorage = {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); }, clear: () => storage.clear(), key: () => null, get length() { return storage.size; },
};
g.sessionStorage = g.localStorage;
g.location = { pathname: '/app', search: '', hash: '', href: 'http://localhost/app', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
g.addEventListener = () => {}; g.removeEventListener = () => {};
g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0); g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
g.IS_REACT_ACT_ENVIRONMENT = true;

// import.meta.env (Vite) غير موجود في Node
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  if (url.includes('/web-admin/src/') && r.source != null) {
    const src = String(r.source);
    if (src.includes('import.meta.env')) return { ...r, source: src.replace(/import\\.meta\\.env/g, '({})') };
  }
  return r;
}`)}`);

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (n = 12) => { await act(async () => { for (let i = 0; i < n; i++) await tick(); }); };

let reactDom: { createRoot: (c: any) => { render(el: unknown): void; unmount(): void } } | null = null;
async function mount(el: React.ReactElement) {
  reactDom ??= (await import('react-dom/client')) as any;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = reactDom!.createRoot(container);
  await act(async () => { root.render(el); await tick(); });
  return {
    container,
    rerender: async (next: React.ReactElement) => { await act(async () => { root.render(next); await tick(); }); },
    unmount: async () => { await act(async () => { root.unmount(); }); container.parentNode?.removeChild(container); },
  };
}
function walk(n: any, pred: (x: any) => boolean, out: any[] = []): any[] {
  if (pred(n)) out.push(n);
  for (const c of n.childNodes ?? []) walk(c, pred, out);
  return out;
}
const buttons = (root: any) => walk(root, (x) => x.tagName === 'BUTTON');
const button = (root: any, label: string) => {
  const b = buttons(root).find((x) => x.textContent.trim() === label) ?? buttons(root).find((x) => x.getAttribute('aria-label') === label)
    ?? buttons(root).find((x) => x.textContent.includes(label));
  assert.ok(b, `لا زرّ «${label}» — الأزرار: ${buttons(root).map((x) => x.textContent.trim() || x.getAttribute('aria-label')).join(' | ')}`);
  return b;
};
const cards = (root: any) => walk(root, (x) => x.tagName === 'LI' && x.parentNode?.tagName === 'OL');
const propsOf = (el: any) => el[Object.keys(el).find((k) => k.startsWith('__reactProps$'))!];
async function click(el: any) {
  await act(async () => { propsOf(el).onClick?.({ preventDefault() {}, stopPropagation() {}, currentTarget: el, target: el }); await tick(); });
}
async function change(el: any, value: string) {
  await act(async () => { propsOf(el).onChange?.({ target: { value }, currentTarget: { value } }); await tick(); });
}

// ═══════════════════ C22: التحميل التلقائي والسقف (ActivityTimeline) ═══════════════════

/** سجلٌّ طويل بصفحات الخادم: الأولى بحجمها الافتراضي (٢٠٠) والتالية بما يطلبه limit — بندان فقط فيهما «نادر» */
function longLog(total: number) {
  const all = Array.from({ length: total }, (_, i) => item({
    id: `L${i}`, at: new Date(Date.UTC(2026, 2, 1) - i * 60_000).toISOString(), action: 'VISIT_RECORDED',
    data: { note: i === 5 || i === 1990 ? 'طلب نادر' : 'زيارة' },
  }));
  const calls: { before?: string; category?: string; limit?: number }[] = [];
  const fetchPage = async (before?: string, category?: string, limit?: number): Promise<ActivityPage> => {
    calls.push({ before, category, limit });
    const start = before ? Number(before) : 0;
    const size = limit ?? 200;
    const end = Math.min(total, start + size);
    return { items: all.slice(start, end), nextBefore: end < total ? String(end) : null };
  };
  return { fetchPage, calls };
}

function Controlled({ fetchPage, initial }: { fetchPage: (b?: string, c?: string, l?: number) => Promise<ActivityPage>; initial: ActivityView }) {
  const [view, setView] = React.useState<ActivityView>(initial);
  return h(TimelineRef.current!, { fetchPage, accountingOn: true, view, onViewChange: setView });
}
const TimelineRef: { current: any } = { current: null };
async function timeline() {
  TimelineRef.current ??= (await import('../components/customerActivity/ActivityTimeline')).default;
  return TimelineRef.current;
}

test('C22: بلا عرضٍ فعّال لا تحميل تلقائي — صفحةٌ واحدة و«تحميل المزيد»، ولا أدوات عرض بلا onViewChange', async () => {
  const ActivityTimeline = await timeline();
  const log = longLog(500);
  const v = await mount(h(ActivityTimeline, { fetchPage: log.fetchPage, accountingOn: true }));
  await settle();
  assert.equal(log.calls.length, 1);
  assert.equal(walk(v.container, (x) => x.tagName === 'INPUT' || x.tagName === 'SELECT').length, 0);
  assert.ok(button(v.container, 'تحميل المزيد'));
  await v.unmount();
});

test('C22: البحث يُكمل تحميل السجلّ تلقائياً (صفحات ٣٠٠) حتى السقف، ويجد ما في الصفحات البعيدة، وملاحظة السقف ظاهرة', async () => {
  await timeline();
  const log = longLog(3000);
  const v = await mount(h(Controlled, { fetchPage: log.fetchPage, initial: {} }));
  await settle();
  assert.equal(log.calls.length, 1, 'تحميلٌ تلقائي بلا بحث');
  const input = walk(v.container, (x) => x.tagName === 'INPUT')[0];
  assert.ok(input, 'خانة البحث');
  await change(input, 'نادر');
  await settle(40);
  // ٢٠٠ + ٦ × ٣٠٠ = ٢٠٠٠ = السقف ⇒ يتوقّف
  assert.equal(log.calls.length, 1 + (VIEW_LOAD_CAP - 200) / VIEW_PAGE_LIMIT, `عدد الطلبات ${log.calls.length}`);
  assert.ok(log.calls.slice(1).every((c) => c.limit === VIEW_PAGE_LIMIT && c.before), 'صفحات التحميل التلقائي بمؤشّرٍ وحجم ٣٠٠');
  assert.equal(cards(v.container).length, 2, 'البند في الصفحة البعيدة (١٩٩٠) لم يُوجد');
  const text = v.container.textContent;
  assert.ok(text.includes('يشمل البحث والترتيب أحدث'), 'ملاحظة السقف غائبة');
  assert.ok(!text.includes('جار تحميل بقية السجل'), 'مؤشّر التحميل باقٍ بعد السقف');
  // ما بعد السقف يُحمَّل يدوياً
  await click(button(v.container, 'تحميل المزيد'));
  await settle();
  assert.equal(log.calls[log.calls.length - 1]!.limit, undefined);
  await v.unmount();
});

test('C22: «الأقدم أولاً» يحمّل السجلّ كله ثم يعرضه مقلوباً — ولا نتائج ⇒ «لا نتائج مطابقة»', async () => {
  await timeline();
  const log = longLog(450);
  const v = await mount(h(Controlled, { fetchPage: log.fetchPage, initial: { order: 'asc' } }));
  await settle(30);
  assert.equal(log.calls.length, 2, 'صفحة الـ٢٠٠ ثم صفحة ٣٠٠ تكمل الـ٤٥٠');
  const first = cards(v.container)[0];
  assert.ok(first, 'بنود');
  assert.equal(cards(v.container).length, 450);
  assert.ok(!v.container.textContent.includes('تحميل المزيد'));
  await change(walk(v.container, (x) => x.tagName === 'INPUT')[0], 'لا شيء بهذا');
  await settle();
  assert.ok(v.container.textContent.includes('لا نتائج مطابقة'));
  assert.equal(cards(v.container).length, 0);
  await v.unmount();
});

test('C22: مؤشّرٌ لا يتقدّم (خللٌ في الخادم) لا يُدير التحميل التلقائي بلا نهاية', async () => {
  await timeline();
  let calls = 0;
  const fetchPage = async (): Promise<ActivityPage> => { calls++; return { items: [item({ id: 'same', action: 'VISIT_RECORDED' })], nextBefore: 'STUCK' }; };
  const v = await mount(h(Controlled, { fetchPage, initial: { order: 'asc' } }));
  await settle(30);
  assert.equal(calls, 2, `طلباتٌ متكرّرة: ${calls}`);
  assert.ok(!v.container.textContent.includes('تحميل المزيد'));
  await v.unmount();
});

test('C22: «من نفّذ» يرشّح بالمنفّذ، وزرّ الترتيب يقلب المعروض', async () => {
  await timeline();
  const items = archiveItems();
  const fetchPage = async () => ({ items, nextBefore: null }) as ActivityPage;
  const v = await mount(h(Controlled, { fetchPage, initial: {} }));
  await settle();
  assert.equal(cards(v.container).length, 4);
  const sel = walk(v.container, (x) => x.tagName === 'SELECT')[0];
  assert.ok(sel, 'قائمة «من نفّذ»');
  const opts = walk(sel, (x) => x.tagName === 'OPTION').map((o) => o.textContent);
  assert.ok(opts.includes('سارة · إداري') && opts.some((o) => o === 'الدعم الفني'), opts.join(' | '));
  await change(sel, 'ADMIN:سارة');
  assert.equal(cards(v.container).length, 1);
  assert.ok(cards(v.container)[0].textContent.includes('INV-2611-000012'));
  await change(sel, '');
  await click(button(v.container, 'الأحدث أولا'));
  const order = cards(v.container).map((c) => (c.textContent.includes('RC-77') ? 'c' : c.textContent.includes('INV-2611') ? 'b' : c.textContent.includes('وعد') ? 'a' : 'd'));
  assert.deepEqual(order, ['d', 'c', 'b', 'a']);
  assert.ok(button(v.container, 'الأقدم أولا'));
  await v.unmount();
});

// ═══════════════════ ورقة المندوب: C3 وC23 ═══════════════════

async function repEnv(reply: () => unknown) {
  const { default: repApi } = await import('../rep/repApi');
  const { default: RepCustomerTimeline } = await import('../rep/RepCustomerTimeline');
  const reqs: string[] = [];
  (repApi.defaults as any).adapter = async (cfg: any) => {
    reqs.push(`${cfg.method} ${cfg.url}`);
    return { data: { success: true, data: reply() }, status: 200, statusText: 'OK', headers: {}, config: cfg, request: {} };
  };
  return { RepCustomerTimeline, reqs };
}
const moneyItems = () => [
  item({ id: 'i', at: '2026-03-01T10:00:00Z', action: 'INVOICE_ISSUED', refNo: 'INV-9', amount: 4321.75, data: { taxTotal: 563.71 } }),
  item({ id: 'r', at: '2026-03-01T09:00:00Z', action: 'RECEIPT_ISSUED', refNo: 'RC-9', amount: 2468.13, data: { allocations: [{ invoiceNo: 'INV-9', amount: 1357.91 }] } }),
];

test('C3: ورقة المندوب بلا صلاحية «كشف الحساب» لا تعرض مبلغاً ولو كانت المحاسبة مفعّلة — والبنود نفسها باقية', async () => {
  const { formatCurrency } = await import('../utils/format');
  for (const [canViewStatement, shows] of [[false, false], [true, true]] as const) {
    const env = await repEnv(() => ({ items: moneyItems(), nextBefore: null }));
    const v = await mount(h(env.RepCustomerTimeline, { customer: { id: 'c9', name: 'بقالة' }, accountingOn: true, canViewStatement, onClose: () => {} }));
    await settle();
    const text = v.container.textContent;
    assert.ok(text.includes('INV-9') && text.includes('RC-9'), 'البنود غابت');
    for (const n of [4321.75, 563.71, 2468.13, 1357.91]) {
      assert.equal(text.includes(formatCurrency(n)), shows, `${n} (canViewStatement=${canViewStatement})`);
    }
    await v.unmount();
  }
});

test('C23: نبضة مؤقّت الزيارة (إعادة رسم الملفّ كل ثانية) لا تعيد رسم الورقة ولا بطاقاتها', async () => {
  const env = await repEnv(() => ({ items: moneyItems(), nextBefore: null }));
  const customer = { id: 'c9', name: 'بقالة' };
  const onClose = () => {};
  let setTick: (n: number) => void = () => {};
  let setTaxOff: (b: boolean) => void = () => {};
  function Detail() {
    const [t, set] = React.useState(0);
    const [taxOff, setTax] = React.useState(false);
    setTick = set; setTaxOff = setTax;
    return h('div', { 'data-tick': t }, h(env.RepCustomerTimeline, { customer, accountingOn: true, canViewStatement: true, taxOff, onClose }));
  }
  const v = await mount(h(Detail));
  await settle();
  assert.equal(cards(v.container).length, 2);
  // كل بطاقةٍ تُرسم تبني منسّق وقتٍ (formatTime) — نعدّها عبر نبضاتٍ عدّة
  const Real = Intl.DateTimeFormat;
  let built = 0;
  (Intl as any).DateTimeFormat = new Proxy(Real, { construct(t, args) { built++; return Reflect.construct(t, args); } });
  let control = 0;
  try {
    for (let i = 1; i <= 3; i++) await act(async () => { setTick(i); await tick(); });
    assert.equal(v.container.firstChild.getAttribute('data-tick'), '3', 'النبضة لم تُرسم');
    assert.equal(built, 0, `أُعيد رسم البطاقات مع النبضة (${built} منسّقاً)`);
    // ضابط: تغيّر خاصيّةٍ حقيقية يعيد رسمها فعلاً (العدّاد يعمل)
    await act(async () => { setTaxOff(true); await tick(); });
    control = built;
  } finally { (Intl as any).DateTimeFormat = Real; }
  assert.ok(control > 0, 'العدّاد لا يلتقط رسم البطاقات — الاختبار بلا معنى');
  assert.equal(env.reqs.length, 1, 'النبضة أعادت الجلب');
  await v.unmount();
});

// ═══════════════════ أرشيف اللوحة: C1 وC22 في الشاشة نفسها ═══════════════════

async function studioEnv(activity: () => { items: unknown[]; nextBefore: string | null }) {
  storage.set('user', JSON.stringify({ id: 'u1', role: 'ADMIN', canDelete: true }));
  const { default: api } = await import('../api/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { default: CustomerStudioModal } = await import('../components/CustomerStudioModal');
  const reqs: { url: string; params: unknown }[] = [];
  (api.defaults as any).adapter = async (cfg: any) => {
    reqs.push({ url: cfg.url, params: cfg.params });
    let data: unknown = null;
    if (cfg.url === '/company') data = { accountingEnabled: true };
    else if (cfg.url === '/customers/c1/studio') {
      data = {
        customer: { id: 'c1', name: 'بقالة النور', businessName: null },
        // صورتا الوقفة التُقطتا مع الملاحظة (vN) والوقفة المدموجة برأسها المؤقّت (vT)
        items: [
          { source: 'visit', id: 'p1', at: '2026-03-01T10:29:00Z', by: 'أحمد', visitId: 'vN', note: 'وعد بالسداد' },
          { source: 'visit', id: 'p2', at: '2026-03-01T10:29:00Z', by: 'أحمد', visitId: 'vN', note: 'وعد بالسداد' },
        ],
        visits: [{ id: 'vT', at: '2026-03-01T10:00:00Z', repId: 'r1', rep: 'أحمد', note: 'وعد بالسداد', durationSec: 1800, startedAt: null, endedAt: null, lat: null, lng: null, photoIds: ['p1', 'p2'] }],
        receiptsHidden: false, truncated: { visit: false, receipt: false }, limits: { perRequest: 10, perCustomer: 50, docCount: 0 },
      };
    } else if (cfg.url === '/customers/c1/activity') data = activity();
    return { data: { success: true, data }, status: 200, statusText: 'OK', headers: {}, config: cfg, request: {} };
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const v = await mount(h(QueryClientProvider, { client: qc }, h(CustomerStudioModal, { customer: { id: 'c1', name: 'بقالة النور' }, onClose: () => {} })));
  await settle(20);
  return { v, reqs, qc };
}
const visitPhotoThumbs = (root: any) => walk(root, (x) => x.tagName === 'BUTTON' && x.getAttribute('title') === 'صورة زيارة');

test('C1: سجلّا الوقفة الواحدة (المؤقّت والملاحظة) بندان في السجلّ — وصورها تُرسم مرّةً واحدة لا مرّتين', async () => {
  const { v, qc } = await studioEnv(() => ({ items: [
    item({ id: 'L1', at: '2026-03-01T10:30:00Z', action: 'VISIT_RECORDED', refType: 'VISIT', refId: 'vT', data: { durationSec: 1800, salesRepId: 'r1' } }),
    item({ id: 'L2', at: '2026-03-01T10:29:00Z', action: 'VISIT_RECORDED', refType: 'VISIT', refId: 'vN', data: { note: 'وعد بالسداد', photosCount: 2, salesRepId: 'r1' } }),
  ], nextBefore: null }));
  assert.equal(cards(v.container).length, 2);
  assert.equal(visitPhotoThumbs(v.container).length, 2, `صور الوقفة رُسمت ${visitPhotoThumbs(v.container).length} مرّة`);
  await v.unmount();
  qc.clear();
});

test('C1: الوقفة المدموجة من الخادم (data.visitIds) بندٌ واحد بصورها كلها مرّةً واحدة', async () => {
  const { v, qc } = await studioEnv(() => ({ items: [
    item({ id: 'L1', at: '2026-03-01T10:30:00Z', action: 'VISIT_RECORDED', refType: 'VISIT', refId: 'vT', data: { visitIds: ['vT', 'vN'], parts: 2, photosCount: 2 } }),
  ], nextBefore: null }));
  assert.equal(visitPhotoThumbs(v.container).length, 2);
  await v.unmount();
  qc.clear();
});

test('C22: في الأرشيف — البحث و«من نفّذ» والترتيب، والنقر على مندوبٍ في «من خدم العميل» يرشّح السجلّ بعمله ونقرةٌ ثانية تلغيه', async () => {
  const { v, reqs, qc } = await studioEnv(() => ({ items: archiveItems(), nextBefore: null }));
  assert.equal(cards(v.container).length, 4);
  assert.equal(walk(v.container, (x) => x.tagName === 'INPUT' && x.getAttribute('type') === 'search').length, 1, 'خانة البحث');
  const rep = buttons(v.container).find((b) => b.getAttribute('aria-pressed') != null && b.textContent.includes('أحمد'));
  assert.ok(rep, '«من خدم العميل»: صفّ المندوب زرّ');
  await click(rep);
  assert.equal(cards(v.container).length, 2, 'ترشيح المندوب: زيارته وفاتورةٌ هو مندوبها');
  assert.equal(rep.getAttribute('aria-pressed'), 'true');
  await click(rep);
  assert.equal(cards(v.container).length, 4, 'النقرة الثانية لم تلغِ الترشيح');
  await change(walk(v.container, (x) => x.tagName === 'INPUT' && x.getAttribute('type') === 'search')[0], 'الخميس');
  assert.equal(cards(v.container).length, 1);
  assert.equal(reqs.filter((r) => r.url === '/customers/c1/activity').length, 1, 'صفحةٌ واحدة تكفي سجلاً بلا تالية');
  await v.unmount();
  qc.clear();
});
