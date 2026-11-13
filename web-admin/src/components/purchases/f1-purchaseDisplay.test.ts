import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useLang } from '../../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../../utils/format';
import { AdjustReasonSelect, EntryPurchaseActions, EntryPurchaseInfo, PurchaseSummary } from './PurchaseDisplay';
import type { PurchaseEntry } from './purchaseTypes';

/**
 * «ربط الدفاتر» L1 — مكوّنات العرض مرسومةً (بلا DOM): الملخّص بالصافي والضريبة والإجمالي و«إزالة الضريبة» بالإجمالي وحده،
 * وسطر السجلّ (نقدي بمصدره، آجل باستحقاقه ومتبقّيه، ملغاة، مرتجع، غير مصنَّف)، وخادمٌ أقدم بلا status لا يرسم شيئاً.
 * ثم حرّاس التوصيل في الصفحة: بلا نوع شراء يبقى جسم الحفظ كما كان.
 */

useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
// علامات الاتجاه (RLM/LRM) التي يضعها Intl حول العملة تُزال قبل المطابقة
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ');

test('الملخّص: الصافي والضريبة والإجمالي، والآجل باستحقاقه ومدته، والنقدي بمصدره', () => {
  const credit = text(html(createElement(PurchaseSummary, { totals: { net: 1080, tax: 154, total: 1234 }, taxOff: false, mode: 'CREDIT', dueDate: '2026-12-13', paymentDays: 30 })));
  assert.match(credit, /الصافي قبل الضريبة/);
  assert.match(credit, /ضريبة المشتريات/);
  assert.match(credit, /إجمالي فاتورة المورد/);
  assert.match(credit, /1,234\.00/);
  assert.match(credit, /154\.00/);
  assert.match(credit, /تاريخ الاستحقاق/);
  assert.match(credit, /\(30 يوم\)/);
  const cash = text(html(createElement(PurchaseSummary, { totals: { net: 100, tax: 15, total: 115 }, taxOff: false, mode: 'CASH', paidFrom: 'REP_CUSTODY', repName: 'سالم' })));
  assert.match(cash, /يصرف كامل المبلغ من عهدة مندوب · سالم/);
  assert.doesNotMatch(cash, /تاريخ الاستحقاق/);
});

test('الملخّص مع «إزالة الضريبة»: الإجمالي وحده بلا أي ذكرٍ للضريبة', () => {
  const s = text(html(createElement(PurchaseSummary, { totals: { net: 1234, tax: 0, total: 1234 }, taxOff: true, mode: 'CASH', paidFrom: 'MAIN_CASH' })));
  assert.doesNotMatch(s, /ضريب/);
  assert.match(s, /إجمالي فاتورة المورد/);
  assert.match(s, /الصندوق الرئيسي/);
  const ret = text(html(createElement(PurchaseSummary, { totals: { net: 10, tax: 1.5, total: 11.5 }, taxOff: false, mode: null, title: 'إجمالي المرتجع' })));
  assert.match(ret, /إجمالي المرتجع/);
});

const base: PurchaseEntry = {
  id: 'E1', type: 'RECEIVE', supplier: 'مورد', note: null, createdAt: '2026-11-13T08:00:00.000Z', items: [], totalCost: 100, status: 'POSTED',
};

test('سطر السجلّ: آجل باستحقاقه ومتبقّيه، ونقدي بمصدره، وملغاة، وغير مصنَّف، ومرتجع', () => {
  const info = (e: Partial<PurchaseEntry>, opts: { taxOff?: boolean; returned?: boolean } = {}) =>
    text(html(createElement(EntryPurchaseInfo, { e: { ...base, ...e }, taxOff: !!opts.taxOff, returned: !!opts.returned, repName: () => 'سالم' })));
  const credit = info({ paymentMode: 'CREDIT', supplierRef: 'F-77', billDate: '2026-11-01T00:00:00.000Z', dueDate: '2099-12-01', net: 100, tax: 15, total: 115, outstanding: 40 });
  assert.match(credit, /آجل/);
  assert.match(credit, /فاتورة المورد F-77/);
  assert.match(credit, /الصافي 100\.00/);
  assert.match(credit, /الضريبة 15\.00/);
  assert.match(credit, /الإجمالي 115\.00/);
  assert.match(credit, /يستحق/);
  assert.match(credit, /المتبقي 40\.00/);
  assert.match(info({ paymentMode: 'CREDIT', total: 115, outstanding: 0 }), /مسددة/);
  const cash = info({ paymentMode: 'CASH', paidAccountRef: 'REP_CUSTODY:r1', total: 115, net: 100, tax: 15 });
  assert.match(cash, /نقدي · عهدة مندوب · سالم/);
  assert.doesNotMatch(cash, /المتبقي|يستحق/);
  // «إزالة الضريبة»: الإجمالي وحده
  const off = info({ paymentMode: 'CASH', paidAccountRef: 'BANK', total: 115, net: 115, tax: 0 }, { taxOff: true });
  assert.doesNotMatch(off, /الصافي|الضريبة/);
  assert.match(off, /الإجمالي 115\.00/);
  assert.match(info({ paymentMode: 'CREDIT', total: 115, outstanding: 0, status: 'CANCELLED' }), /ملغاة/);
  assert.match(info({ paymentMode: 'CREDIT', total: 115 }, { returned: true }), /عليها مرتجع/);
  // غير المصنَّف: وسمٌ بلا مبالغ (سطر «قيمة البضاعة» القائم في الصفحة)، والافتتاحي ليس «غير مصنف»
  const unc = info({ paymentMode: null });
  assert.match(unc, /غير مصنف/);
  assert.doesNotMatch(unc, /الإجمالي/);
  assert.doesNotMatch(info({ paymentMode: null, source: 'OPENING_IMPORT' }), /غير مصنف/);
  const ret = info({ type: 'RETURN', returnOfEntryId: 'E0', total: -23, net: -20, tax: -3, supplierRef: 'CN-1' });
  assert.match(ret, /إجمالي المرتجع 23\.00/);
  assert.match(ret, /إشعار المورد CN-1/);
  assert.match(info({ type: 'ADJUST', reason: 'DAMAGE' }), /تالف/);
});

test('خادمٌ أقدم بلا status: لا سطر شراء ولا أفعال — الصفّ كما كان', () => {
  const { status: _s, ...old } = base;
  assert.equal(html(createElement(EntryPurchaseInfo, { e: old as PurchaseEntry, taxOff: false, returned: false, repName: () => null })), '');
  const noop = () => {};
  assert.equal(html(createElement(EntryPurchaseActions, { acts: { classify: false, ret: false, cancel: false }, onClassify: noop, onReturn: noop, onCancel: noop })), '');
  const all = text(html(createElement(EntryPurchaseActions, { acts: { classify: true, ret: true, cancel: true }, onClassify: noop, onReturn: noop, onCancel: noop })));
  assert.match(all, /تصنيف.*مرتجع للمورد.*إلغاء الحركة/);
});

test('سبب التسوية: خمسة أزرار بترتيب الخادم، والمختار مضغوط', () => {
  const h = html(createElement(AdjustReasonSelect, { value: 'EXPIRY', onChange: () => {} }));
  assert.deepEqual([...h.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(m => m[1]), ['جرد', 'تالف', 'منتهي الصلاحية', 'عينات', 'أخرى']);
  assert.equal((h.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.match(h, /aria-pressed="true"[^>]*>منتهي الصلاحية/);
});

// ─── حرّاس التوصيل في الصفحة ───
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

test('نافذة الاستلام: بلا نوع شراء الجسم كما كان، ومعه المورّد والحقول ونسبة كل سطر والسعر إلزاميّ', () => {
  const s = read('pages', 'CompanyWarehousePage.tsx');
  // حقول الشراء من الدالّة المختبَرة (بلا نوع ⇒ {})، والمورّد للوارد، والسبب للتسوية — كلٌّ لنوع حركته
  assert.ok(s.includes("...(type === 'RECEIVE' && vendor && { vendorId: vendor.id }),"));
  assert.ok(s.includes("...(type === 'RECEIVE' && purchaseBodyFields(purchase, { taxOff })),"));
  assert.ok(s.includes("...(type === 'ADJUST' && reason && { reason }),"));
  // نسبة السطر مع نوع الشراء وحده
  assert.ok(s.includes('...(purchaseMode && { taxPct: lineTaxPct(taxTextOf(r), taxOff) }),'));
  assert.ok(s.includes("const purchaseMode = type === 'RECEIVE' ? purchase.mode : null;"));
  // الحفظ ممنوعٌ بمشكلة الشراء، والملخّص من الدالّة المطابقة للخادم (draftBillTotals ⇐ entryBillTotals) بمنازل العملة النشطة
  assert.match(s, /\}\) && !purchaseIssue;/);
  assert.match(s, /draftBillTotals\([\s\S]{0,160}\{ inclusive: costsIncludeTax, taxOff \}, activeDecimals\(\)\)/);
  assert.ok(!/billTotals\(draftBillLines\(/.test(s), 'الملخّص لا يُحسب بالتكلفة المخزَّنة بأربع منازل (computeBillTotals) — الخادم يحسب بالسعر المُدخل');
  // سطر «قيمة البضاعة المستلمة» القائم لغير المصنَّف وحده — والمصنَّف بملخّصه
  assert.ok(s.includes('{!purchaseMode && entryTotal > 0 && ('));
  assert.ok(s.includes('{bill && ('));
});

test('السجلّ: الفلتر بالمورّد والنوع، وشارة المرتجع، والأفعال لمن يسجّل الحركات، والنوافذ الثلاث', () => {
  const s = read('pages', 'CompanyWarehousePage.tsx');
  assert.match(s, /queryKey: \['warehouse-entries', entryVendor\?\.id \?\? '', entryType\]/);
  assert.ok(s.includes('const shownEntries = filterEntries(allEntries, { type: entryType, vendorId: entryVendor?.id });'));
  assert.ok(s.includes("{e.type === 'RETURN' ? ("));
  assert.ok(s.includes('const acts = entryActions(e, { canEdit: canEditEntries, anyRemaining });'));
  for (const m of ['<ClassifyEntryModal entry={classifyOf}', '<ReturnEntryModal entry={returnOf} all={allEntries}', '<CancelEntryModal entry={cancelOf}']) assert.ok(s.includes(m), m);
});

test('العميل: classifyEntry وreturnEntry وcancelEntry بمساراتها، والسجلّ بلا فلتر كما كان', () => {
  const s = read('api', 'client.ts');
  assert.ok(s.includes('classifyEntry: (id: string, body: WarehouseClassifyBody) => api.post(`/warehouse/entries/${id}/classify`, body),'));
  assert.ok(s.includes('returnEntry: (id: string, body: WarehouseReturnBody) => api.post(`/warehouse/entries/${id}/return`, body),'));
  assert.match(s, /cancelEntry: \(id: string, reason\?: string\) => api\.post\(`\/warehouse\/entries\/\$\{id\}\/cancel`/);
  assert.ok(s.includes("return api.get('/warehouse/entries', Object.keys(params).length ? { params } : undefined);"), 'بلا فلتر لا params');
});

test('تسوية سيارة المندوب في الويب: إتلاف المنتهي غير المباع بسبب «منتهي الصلاحية»', () => {
  const s = read('pages', 'VanStockPage.tsx');
  assert.match(s, /type: 'ADJUST', note: tr\('إتلاف تشغيلة منتهية لم تبع'\),\n[^\n]*\n\s+reason: VAN_DESTROY_REASON,/);
  assert.ok(read('components', 'purchases', 'purchaseCalc.ts').includes("export const VAN_DESTROY_REASON: VanAdjustReason = 'EXPIRY';"));
});
