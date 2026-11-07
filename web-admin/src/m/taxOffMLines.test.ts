import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { invoiceLine, addInvoiceLine, lineTaxPct, retaxInvoiceLines, type SalePick } from './mUnits';
import { invoiceTotals, lineTotal, type Line } from './docMath';
import {
  MTaxOffContext, M_COMPANY_REFETCH_EVENT, mTaxOffOf, requestCompanyRefetch, taxModeChangedOf, useMTaxOff,
} from './mTaxMode';
import { unitChoices } from '../rep/repUnits';
import { TAX_MODE_CODES } from '../lib/taxMode';

/**
 * «إزالة الضريبة» في فاتورة الجوال (/m) — طلب المالك ٧ نوفمبر ٢٠٢٦: نسبة البند فعليّة (صفرٌ للشركة بلا ضريبة)، والسعر الصافي
 * المكتوب نهائي (لا تعديل آلي)، وردّ 409 TAX_MODE_CHANGED يُعيد نسبة البنود بعد جلب الإعدادات. والشركة المطفأ عندها العلم
 * (غائبٌ أو false) كل ناتجٍ لها كما كان حرفاً.
 */

const OFF = { taxDisabled: true };
const ON = { taxDisabled: false };
const UNITS = [{ id: 'u-ctn', name: 'كرتون', factor: 24, price: 45, isActive: true }];
const water: SalePick = { id: 'p1', name: 'ماء', unit: 'قارورة', basePrice: 2, taxPct: 15, units: UNITS, primaryUnitId: 'u-ctn' };
const juice: SalePick = { id: 'p2', name: 'عصير', unit: 'علبة', basePrice: 10, taxPct: 5 };
const bare: SalePick = { id: 'p3', name: 'سكر', unit: 'كيس', basePrice: 7.5, taxPct: null };
const [, carton] = unitChoices(water);

test('lineTaxPct: الشركة بلا ضريبة ⇒ صفر لكل صنف، وغير ذلك نسبة الصنف وافتراضها ١٥ كما كان البند حرفاً', () => {
  for (const p of [water, juice, bare]) {
    assert.equal(lineTaxPct(p, OFF), 0, p.name);
    const today = Number(p.taxPct ?? 15);
    assert.equal(lineTaxPct(p), today, `${p.name}: بلا إعدادات = اليوم`);
    assert.equal(lineTaxPct(p, null), today);
    assert.equal(lineTaxPct(p, ON), today, `${p.name}: false = اليوم`);
    assert.equal(lineTaxPct(p, {}), today, 'كاشٌ قديم بلا العلم = اليوم');
  }
  // العلم === true وحده: قيمٌ تشبهه لا تُزيل الضريبة
  assert.equal(lineTaxPct(water, { taxDisabled: null }), 15);
  assert.equal(lineTaxPct(water, { taxDisabled: 'true' as unknown as boolean }), 15);
  // نسبةٌ مخزّنة نصّاً (Decimal) تُقرأ رقماً كما كان Number(...)
  assert.equal(lineTaxPct({ taxPct: '15.00' }), 15);
  assert.equal(lineTaxPct({ taxPct: '15.00' }, OFF), 0);
});

test('invoiceLine/addInvoiceLine: بند الشركة بلا ضريبة نسبته صفر والسعر الصافي كما هو — والمطفأ مطابقٌ حرفاً لما قبل الميزة', () => {
  for (const [p, c] of [[water, carton], [juice, undefined], [bare, undefined]] as const) {
    const today = invoiceLine(p, c);
    assert.deepEqual(invoiceLine(p, c, undefined, undefined, undefined), today);
    assert.deepEqual(invoiceLine(p, c, undefined, undefined, ON), today, `${p.name}: false = اليوم حرفاً`);
    const off = invoiceLine(p, c, undefined, undefined, OFF);
    assert.equal(off.taxPct, 0);
    assert.deepEqual({ ...off, taxPct: today.taxPct }, today, 'الفرق النسبة وحدها: السعر والوحدة والمرجع كما هي');
  }
  // الإضافة بالمسار الذي تستعمله الشاشة (addInvoiceLine)، والزيادة على بندٍ قائم لا تمسّ نسبته
  let ls = addInvoiceLine([], water, carton, undefined, OFF);
  ls = addInvoiceLine(ls, water, carton, undefined, OFF);
  ls = addInvoiceLine(ls, juice, undefined, undefined, OFF);
  assert.deepEqual(ls.map(l => [l.productId, l.qty, l.unitPrice, l.taxPct]), [['p1', 2, 45, 0], ['p2', 1, 10, 0]]);
  const today = addInvoiceLine(addInvoiceLine([], water, carton), juice);
  assert.deepEqual(addInvoiceLine(addInvoiceLine([], water, carton, undefined, ON), juice, undefined, undefined, ON), today);
  assert.deepEqual(today.map(l => l.taxPct), [15, 5]);
});

test('invoiceTotals: بنود الشركة بلا ضريبة ⇒ الضريبة صفر والإجمالي = المجموع − الخصم (السعر المكتوب نهائي)', () => {
  const lines = addInvoiceLine(addInvoiceLine([], water, carton, undefined, OFF), juice, undefined, undefined, OFF)
    .map(l => (l.productId === 'p1' ? { ...l, qty: 2, discountPct: 10 } : l));
  const t = invoiceTotals(lines, 5, OFF);
  assert.equal(t.tax, 0);
  // ٢ × ٤٥ = ٩٠ − ١٠٪ = ٨١ ، + ١٠ = ٩١ ⇒ خصم الفاتورة ٥٪ = ٤٫٥٥ ⇒ ٨٦٫٤٥
  assert.equal(t.subtotal, 100);
  assert.equal(t.total, 86.45);
  assert.equal(Math.round((t.subtotal - t.discount) * 100) / 100, t.total, 'بلا ضريبة: الإجمالي = المجموع − الخصم');
  // وإجمالي كل بند بلا ضريبة = أساسه بعد خصمه
  assert.equal(lineTotal(lines[0]), 81);
  assert.equal(lineTotal(lines[1]), 10);
});

test('invoiceTotals: النسبة الاحتياطية للمحرّك فعليّة — صفرٌ للشركة بلا ضريبة، و١٥ كما كانت لغيرها (المطفأ مطابق حرفاً)', () => {
  // بندٌ بلا نسبة (لا يحدث من الشاشة — كل بندٍ يحمل نسبته) يأخذ الاحتياطية: هي حدٌّ ثانٍ لا الأوّل
  const noPct = [{ productId: 'x', name: 'x', unit: 'حبة', qty: 1, unitPrice: 100, discountPct: 0 } as unknown as Line];
  assert.deepEqual(invoiceTotals(noPct, 0), { subtotal: 100, discount: 0, tax: 15, total: 115 });
  assert.deepEqual(invoiceTotals(noPct, 0, ON), invoiceTotals(noPct, 0));
  assert.deepEqual(invoiceTotals(noPct, 0, OFF), { subtotal: 100, discount: 0, tax: 0, total: 100 });
  // بنودٌ بنسبها: الثالث لا يغيّر شيئاً للمطفأ
  const taxed = addInvoiceLine(addInvoiceLine([], water, carton), juice);
  assert.deepEqual(invoiceTotals(taxed, 10, ON), invoiceTotals(taxed, 10));
  assert.deepEqual(invoiceTotals(taxed, 10, null), invoiceTotals(taxed, 10));
});

test('retaxInvoiceLines: تبدّل الوضع والفاتورة مفتوحة يعيد نسبة كل بند والسعر الصافي كما هو — ولا تغيّر ⇒ المصفوفة نفسها', () => {
  const catalog = { p1: water, p2: juice };
  const taxed = addInvoiceLine(addInvoiceLine([], water, carton), juice).map(l => ({ ...l, unitPrice: l.unitPrice + 1 })); // سعرٌ عدّله المستخدم
  const off = retaxInvoiceLines(taxed, catalog, OFF);
  assert.deepEqual(off.map(l => l.taxPct), [0, 0]);
  assert.deepEqual(off.map(l => l.unitPrice), taxed.map(l => l.unitPrice), 'السعر المكتوب لا يُمسّ');
  assert.equal(retaxInvoiceLines(off, catalog, OFF), off, 'لا تغيّر ⇒ المصفوفة نفسها (لا إعادة رسم)');
  // إعادة الضريبة تعيد نسبة كل صنف من الكتالوج (المخزّنة لم تُمسّ)
  const back = retaxInvoiceLines(off, catalog, ON);
  assert.deepEqual(back.map(l => l.taxPct), [15, 5]);
  assert.equal(retaxInvoiceLines(taxed, catalog, ON), taxed, 'المطفأ: البنود كما هي حرفاً');
  assert.equal(retaxInvoiceLines(taxed, catalog), taxed);
  assert.deepEqual(retaxInvoiceLines([], catalog, OFF), []);
  // بندٌ صنفه خارج الكتالوج: صفرٌ للشركة بلا ضريبة، ويبقى كما هو لغيرها
  const orphan = [{ ...taxed[0], productId: 'gone' }];
  assert.equal(retaxInvoiceLines(orphan, catalog, OFF)[0].taxPct, 0);
  assert.equal(retaxInvoiceLines(orphan, catalog, ON), orphan);
});

test('ردّ 409 TAX_MODE_CHANGED: يُعرف برمزه وحده، وبعد جلب الإعدادات يخرج الجسم بنسبٍ صفرية وبالأسعار نفسها', () => {
  const err = (status: number, code?: string) => ({ response: { status, data: { code, message: 'x' } } });
  assert.equal(taxModeChangedOf(err(409, TAX_MODE_CODES.changed)), true);
  assert.equal(taxModeChangedOf(err(409, 'TAX_MODE_ZATCA_CONFLICT')), false);
  assert.equal(taxModeChangedOf(err(422, TAX_MODE_CODES.disabled)), false, 'رمز مفاتيح API لا يخصّ الشاشة');
  assert.equal(taxModeChangedOf(err(409, 'PRODUCT_UNITS_CHANGED')), false);
  for (const e of [null, undefined, {}, new Error('net'), { response: {} }]) assert.equal(taxModeChangedOf(e), false);

  // الجهاز بنى البنود قبل القلب (بنسبة ١٥)، والخادم ردّها — الإعدادات الجديدة تصل فتُعاد النسبة، والجسم كما تبنيه الشاشة
  const before = addInvoiceLine([], water, carton);
  const after = retaxInvoiceLines(before, { p1: water }, OFF);
  const body = (ls: Line[]) => ls.map(l => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct }));
  assert.deepEqual(body(after), [{ productId: 'p1', qty: 1, unitPrice: 45, discountPct: 0, taxPct: 0 }]);
  assert.equal(invoiceTotals(after, 0, OFF).total, 45, 'العميل يدفع السعر المكتوب');
});

test('mTaxOffOf: === true وحده — الغائب والكاش القديم والقيم الشبيهة = الضريبة كما هي', () => {
  assert.equal(mTaxOffOf({ taxDisabled: true }), true);
  for (const c of [null, undefined, {}, { taxDisabled: false }, { taxDisabled: null }, { taxDisabled: 'true' }, { taxDisabled: 1 }, 'x']) {
    assert.equal(mTaxOffOf(c), false, JSON.stringify(c));
  }
});

test('MTaxOffContext: بلا مزوّد false (الشاشات كما كانت)، والمزوّد يوصل العلم', () => {
  const Probe = () => createElement('i', null, String(useMTaxOff()));
  assert.equal(renderToStaticMarkup(createElement(Probe)), '<i>false</i>');
  assert.equal(renderToStaticMarkup(createElement(MTaxOffContext.Provider, { value: true }, createElement(Probe))), '<i>true</i>');
  assert.equal(renderToStaticMarkup(createElement(MTaxOffContext.Provider, { value: false }, createElement(Probe))), '<i>false</i>');
});

test('requestCompanyRefetch: يعلن الحدث على window (القوقعة تستمع فتجلب /company فوراً) — وبلا window لا شيء', () => {
  const g = globalThis as { window?: EventTarget };
  const had = 'window' in g;
  const prev = g.window;
  try {
    delete g.window;
    assert.doesNotThrow(() => requestCompanyRefetch());
    const w = new EventTarget();
    let n = 0;
    w.addEventListener(M_COMPANY_REFETCH_EVENT, () => { n += 1; });
    g.window = w;
    requestCompanyRefetch();
    assert.equal(n, 1);
  } finally {
    if (had) g.window = prev; else delete g.window;
  }
});
