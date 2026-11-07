// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — تطبيق المندوب: التسعير والسلّة والحمولة والورقة لشركةٍ «بلا ضريبة».
//  • نسبة البند الجديد effectiveTaxPct(الشركة، نسبة الصنف): صفرٌ للشركة «بلا ضريبة» فالسعر المعروض والمرسل صافٍ (السعر المكتوب نهائي)،
//    وبلا العلم نسبة الصنف كما كانت حرفاً.
//  • انقلاب الوضع والسلّة مفتوحة (repRetaxLines): غير المعدَّل بمرجعه الجديد، والمعدَّل بسعره، وبند فاتورة البيع بمبلغه.
//  • ورقة الإصدار دون اتصال «بلا ضريبة» حين الشركة كذلك وكل البنود صفر (repOfflineTaxFree)، و409 TAX_MODE_CHANGED (isTaxModeChanged).
// المكوّن يعتمد IndexedDB والكاميرا فلا يُرسم هنا: inclOf وaddLine وonPickSale ومؤثّر الانقلاب تُستخرج من RepApp.tsx حرفاً وتُترجم وتُشغَّل
// على المساعدات الحقيقية (نمط repPriceRules.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { lineUnitOf, linkedLineUnit, sameUnit, unitChoices, type UnitChoice } from './repUnits';
import { computeInvoiceTotals, roundDecimal } from './invoiceCalc';
import { repBaseQtyByProduct, repProductBaseQty } from './repPriceLists';
import { lineNetWithList } from '../lib/priceListPricing';
import { fillLinkedQty, linkedUnitPrice, toLinkedSale } from '../lib/returnInvoice';
import { effectiveTaxPct } from '../lib/taxMode';
import { isTaxModeChanged, repOfflineTaxFree, repRetaxLines } from './repTaxMode';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const repApp = read('rep', 'RepApp.tsx');
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, `غائب: ${from}`);
  const b = s.indexOf(to, a + from.length);
  assert.ok(b > a, `غائب بعده: ${to}`);
  return s.slice(a, b + to.length);
};
function compile<T>(src: string, name: string, deps: Record<string, unknown>): T {
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(deps), `${js}\nreturn ${name};`)(...Object.values(deps)) as T;
}

const OFF = { taxDisabled: true };
const ON = { taxDisabled: false };
type Line = Record<string, any>;
type Incl = (p: unknown, c: UnitChoice, baseQty?: number) => number;

/** inclOf من CreateInvoice حرفاً — بلا قوائم ولا قواعد، وبوضع الشركة المعطى */
const inclOfFor = (company: unknown): Incl =>
  compile<Incl>(between(repApp, 'const inclOf = ', ';\n'), 'inclOf', {
    custPrices: {}, listPrices: {}, listRules: [], lineNetWithList, roundDecimal,
    priceDay: '2026-11-07', currencyDecimals: () => 2, getActiveCurrency: () => 'SAR', effectiveTaxPct, company,
  });
/** addLine من CreateInvoice حرفاً */
const addLineFor = (company: unknown) =>
  compile<(prev: Line[], p: unknown, c0: UnitChoice) => Line[]>(
    between(repApp, 'const addLine = (prev: any[], p: any, c0: UnitChoice): any[] => {', '\n  };\n'), 'addLine',
    { sameUnit, lineUnitOf, repProductBaseQty, inclOf: inclOfFor(company), effectiveTaxPct, company });

// ماء بسعر ١٠ صافٍ ونسبة ١٥ مخزّنة، وعصير بحبّة ٢ وكرتون ١٢ (٢٤ = الأساس × المعامل)
const water = { id: 'p-w', name: 'ماء', unit: 'قارورة', basePrice: 10, taxPct: 15, units: [] as never[] };
const juice = {
  id: 'p-j', name: 'عصير', unit: 'حبة', basePrice: 2, taxPct: '15', primaryUnitId: 'u-c',
  units: [{ id: 'u-c', name: 'كرتون', factor: 12, price: null as number | null, isActive: true }],
};
const [BOTTLE] = unitChoices(water);
const [, CARTON] = unitChoices(juice);

test('inclOf: الشركة «بلا ضريبة» ⇒ السعر الصافي نفسه (السعر المكتوب نهائي)، وبلا العلم شاملٌ بنسبة الصنف كما كان حرفاً', () => {
  for (const company of [null, undefined, {}, ON]) {
    assert.equal(inclOfFor(company)(water, BOTTLE), 11.5, `الافتراض ${JSON.stringify(company)}`);
    assert.equal(inclOfFor(company)(juice, CARTON), 27.6);
  }
  assert.equal(inclOfFor(OFF)(water, BOTTLE), 10);
  assert.equal(inclOfFor(OFF)(juice, CARTON), 24);
});

test('addLine: نسبة البند الجديد صفر والسعر صافٍ للشركة «بلا ضريبة» — وبلا العلم نسبة الصنف رقماً كما كانت (Number(p.taxPct))', () => {
  const off = addLineFor(OFF)([], water, BOTTLE)[0];
  assert.deepEqual([off.taxPct, off.unitPrice, off.refPrice], [0, 10, 10]);
  const offJuice = addLineFor(OFF)([], juice, CARTON)[0];
  assert.deepEqual([offJuice.taxPct, offJuice.unitPrice], [0, 24]);
  const on = addLineFor(null)([], water, BOTTLE)[0];
  assert.deepEqual([on.taxPct, on.unitPrice, on.refPrice], [15, 11.5, 11.5]);
  // نسبةٌ نصّية من الكاش (Decimal) تصير رقماً كما كان Number(p.taxPct)
  assert.equal(addLineFor(ON)([], juice, CARTON)[0].taxPct, 15);
  assert.equal(typeof addLineFor(ON)([], juice, CARTON)[0].taxPct, 'number');
});

test('المحرّك على سلّة «بلا ضريبة»: الإجمالي = السعر × الكمية، والضريبة صفر في البند والفاتورة', () => {
  const lines = [{ qty: 3, unitPrice: 10, discountPct: 0, taxPct: 0 }, { qty: 2, unitPrice: 24, discountPct: 10, taxPct: 0 }];
  // كما يستدعيه CreateInvoice (companyVat احتياطيٌّ صفرٌ عند الإزالة)
  assert.match(repApp, /\{ companyVat: taxOff \? 0 : 15, decimals: dec, invoiceDiscountPct: 0, pricesIncludeTax: true \}/);
  const c = computeInvoiceTotals(lines, { companyVat: 0, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
  assert.equal(c.taxAmt, 0);
  assert.equal(c.total, 30 + 43.2);
  assert.deepEqual(c.items.map((x) => x.taxAmt), [0, 0]);
  assert.deepEqual(c.items.map((x) => x.lineTotal), [30, 43.2]);
});

test('المرتجع من فاتورة بيع (onPickSale): نسبة بند البيع صفرٌ عند الإزالة بمبلغ الاسترداد نفسه — وبلا العلم نسبة بند البيع كما كانت', () => {
  const fn = between(repApp, 'const onPickSale = (sale: ReturnableSale) => {', '\n  };\n');
  const run = (company: unknown) => {
    const set: Line[][] = [];
    const pick = compile<(s: unknown) => void>(fn, 'onPickSale', {
      setManualMode: () => undefined, setSaleRef: () => undefined, setLines: (x: Line[]) => { set.push(x); }, fillLinkedQty, linkedLineUnit,
      products: [], linkedUnitPrice, retDec: () => 2, effectiveTaxPct, company, setPickSale: () => undefined, setShowCart: () => undefined,
      setMsg: () => undefined, tr: (s: string) => s,
    });
    pick(sale);
    return set[0];
  };
  // بيعٌ بقارورتين بإجمالي ٢٣ شاملاً (١٠ + ١٥٪)، لم يُرجَع منه شيء
  const sale = toLinkedSale({
    id: 's1', number: 'INV-1', invoiceDate: '2026-11-01',
    lines: [{ saleItemId: 'si1', productId: 'p-w', name: 'ماء', unit: 'قارورة', sold: 2, returned: 0, returnable: 2, refundUnitPrice: 11.5, taxPct: 15, lineTotal: 23 }],
  });
  const off = run(OFF)[0];
  const on = run(null)[0];
  assert.deepEqual([off.taxPct, off.unitPrice, off.qty], [0, 11.5, 2], 'المبلغ المسترد نفسه بنسبة صفر');
  assert.deepEqual([on.taxPct, on.unitPrice, on.qty], [15, 11.5, 2]);
  const total = (l: Line) => computeInvoiceTotals([{ qty: l.qty, unitPrice: l.unitPrice, discountPct: 0, taxPct: l.taxPct }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
  assert.equal(total(off).total, total(on).total, 'المسترد لا يتغيّر');
  assert.deepEqual([total(off).taxAmt, total(on).taxAmt], [0, 3]);
});

test('repRetaxLines: الضريبة أُزيلت والسلّة مفتوحة — غير المعدَّل صافٍ، والمعدَّل بسعره المكتوب، وبند فاتورة البيع بمبلغه، والغائب صفر', () => {
  const lines: Line[] = [
    { productId: 'p-w', unitPrice: 11.5, refPrice: 11.5, taxPct: 15 },                              // لم يُمسّ
    { productId: 'p-j', unitId: 'u-c', unitPrice: 30, refPrice: 27.6, taxPct: 15 },                 // معدَّل يدوياً
    { productId: 'p-w', saleItemId: 'si1', link: { taxPct: 15 }, unitPrice: 11.5, refPrice: 11.5, taxPct: 15 }, // من فاتورة بيع
    { productId: 'p-gone', unitPrice: 9.2, refPrice: 9.2, taxPct: 15 },                             // غاب عن الكتالوج
  ];
  const products: Record<string, { taxPct: unknown; net: number }> = { 'p-w': { taxPct: 15, net: 10 }, 'p-j': { taxPct: 15, net: 24 } };
  const refOf = (company: unknown) => (l: Line, p: { taxPct: unknown; net: number }) => roundDecimal(p.net * (1 + effectiveTaxPct(company as never, p.taxPct as number) / 100), 2);
  const off = repRetaxLines(lines as never[], { company: OFF, productOf: (l: Line) => products[l.productId], refOf: refOf(OFF), floor: true }) as Line[];
  assert.deepEqual(off.map((l) => [l.taxPct, l.unitPrice, l.refPrice]), [[0, 10, 10], [0, 30, 24], [0, 11.5, 11.5], [0, 9.2, 9.2]]);
  // لا ضريبة في الإجمالي بعدها
  const calc = computeInvoiceTotals(off.map((l) => ({ qty: 1, unitPrice: l.unitPrice, discountPct: 0, taxPct: l.taxPct })),
    { companyVat: 0, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
  assert.equal(calc.taxAmt, 0);
  assert.equal(calc.total, 10 + 30 + 11.5 + 9.2);

  // عادت الضريبة: غير المعدَّل شاملٌ بنسبة صنفه، والمعدَّل يُرفع إلى المرجع لمن لا يبيع بأقل (صافيه صار دون الأرضية)، وبند البيع بنسبته
  const back = (floor: boolean) => repRetaxLines(off as never[], { company: ON, productOf: (l: Line) => products[l.productId], refOf: refOf(ON), floor }) as Line[];
  assert.deepEqual(back(true).map((l) => [l.taxPct, l.unitPrice, l.refPrice]), [[15, 11.5, 11.5], [15, 30, 27.6], [15, 11.5, 11.5], [0, 9.2, 9.2]]);
  const manualOff: Line[] = [{ productId: 'p-w', unitPrice: 10.5, refPrice: 10, taxPct: 0 }];
  const lift = (floor: boolean) => (repRetaxLines(manualOff as never[], { company: ON, productOf: (l: Line) => products[l.productId], refOf: refOf(ON), floor }) as Line[])[0];
  assert.deepEqual([lift(true).unitPrice, lift(true).taxPct], [11.5, 15], 'بلا «البيع بأقل»: يُرفع إلى المرجع');
  assert.deepEqual([lift(false).unitPrice, lift(false).taxPct], [10.5, 15], 'بالصلاحية: سعره المكتوب');
});

test('repRetaxLines: لا انقلاب فعليّ ⇒ المصفوفة نفسها (لا رسم ولا إسقاط توقيع)', () => {
  const products: Record<string, { taxPct: unknown }> = { 'p-w': { taxPct: 15 } };
  const lines = [{ productId: 'p-w', unitPrice: 11.5, refPrice: 11.5, taxPct: 15 }, { productId: 'p-w', saleItemId: 'x', link: { taxPct: 15 }, unitPrice: 5, refPrice: 5, taxPct: 15 }];
  assert.equal(repRetaxLines(lines, { company: null, productOf: (l) => products[l.productId], refOf: () => 11.5, floor: true }), lines);
  const zero = [{ productId: 'p-w', unitPrice: 10, refPrice: 10, taxPct: 0 }];
  assert.equal(repRetaxLines(zero, { company: OFF, productOf: (l) => products[l.productId], refOf: () => 10, floor: true }), zero);
  assert.deepEqual(repRetaxLines([], { company: OFF, productOf: () => null, refOf: () => 0, floor: true }), []);
});

test('مؤثّر الانقلاب في CreateInvoice حرفاً: بوحدة البند ومجموع الصنف ووضع الشركة الحالي — صافٍ عند الإزالة', () => {
  const src = between(repApp, 'setLines(prev => {\n      const qtyOf = repBaseQtyByProduct(prev);\n      return repRetaxLines(prev, {', '\n      });\n    });');
  const body = src.slice('setLines('.length, -');'.length);
  const run = (company: unknown, perms: unknown, prev: Line[]) =>
    compile<(prev: Line[]) => Line[]>(`const retax = ${body};`, 'retax', {
      repBaseQtyByProduct, repRetaxLines, company, products: [water, juice], inclOf: inclOfFor(company), perms,
    })(prev);
  const cart: Line[] = [
    { productId: 'p-w', ...lineUnitOf(BOTTLE, water.unit), qty: 2, unitPrice: 11.5, refPrice: 11.5, taxPct: 15 },
    { productId: 'p-j', ...lineUnitOf(CARTON, juice.unit), qty: 1, unitPrice: 27.6, refPrice: 27.6, taxPct: 15 },
  ];
  const off = run(OFF, { canSellBelowPrice: false }, cart);
  assert.deepEqual(off.map((l) => [l.taxPct, l.unitPrice, l.refPrice]), [[0, 10, 10], [0, 24, 24]], 'الكرتون بوحدته (٢٤) لا بالحبّة');
  const back = run(null, { canSellBelowPrice: false }, off);
  assert.deepEqual(back.map((l) => [l.taxPct, l.unitPrice]), [[15, 11.5], [15, 27.6]]);
  // المؤثّر لا يجري عند الفتح ولا بلا انقلاب: يقارن بالوضع السابق
  const eff = between(repApp, 'const taxOffSeen = useRef(taxOff);', '}, [taxOff]);');
  assert.match(eff, /if \(taxOffSeen\.current === taxOff\) return;\n\s+taxOffSeen\.current = taxOff;/);
  assert.match(eff, /floor: !perms\?\.canSellBelowPrice,/);
});

test('repOfflineTaxFree: ورقة الأوف‑لاين «بلا ضريبة» للشركة بلا ضريبة وكل البنود صفر وحدها', () => {
  assert.equal(repOfflineTaxFree(OFF, [{ taxPct: 0 }, { taxPct: 0 }]), true);
  assert.equal(repOfflineTaxFree(OFF, [{ taxPct: 0 }, { taxPct: 15 }]), false, 'بندٌ بنسبة ⇒ يُحفظ بضريبته على الخادم');
  assert.equal(repOfflineTaxFree(OFF, []), false);
  for (const c of [null, undefined, {}, ON]) assert.equal(repOfflineTaxFree(c, [{ taxPct: 0 }]), false, 'الافتراض: الورقة كما كانت');
  // في RepApp: من بنود الحمولة المصفوفة نفسها، ومفتاحٌ يغيب بلا الإزالة
  const offline = between(repApp, 'paidAmt: paid, remainingAmt: isReturn ? 0 : total - paid,', '});');
  assert.match(offline, /\.\.\.\(repOfflineTaxFree\(company, payload\.items\) && \{ taxFree: true \}\),/);
  // الإصدار المتصل: ختم الخادم نفسه (Invoice.taxFree) في مساري 201 و202
  assert.match(repApp, /\.\.\.\(inv\.taxFree === true && \{ taxFree: true \}\),/);
  assert.match(repApp, /\.\.\.\(row\.taxFree === true && \{ taxFree: true \}\),/);
  // والصندوق يُعاد كما بُني (لا فرض نسبةٍ عند الرفع): الحمولة نفسها في outboxAdd
  assert.match(repApp, /await outboxAdd\(\{ clientRef, repId: currentRepId\(\), kind: 'invoice', payload, status: 'queued', clientCreatedAt, localNumber \}\);/);
  assert.doesNotMatch(read('rep', 'offlineSync.ts'), /taxPct|taxDisabled|taxFree/);
});

test('409 TAX_MODE_CHANGED: تُجلب /company الآن (الكاش معها) برسالةٍ بلا ذكرٍ للضريبة — قبل رسالة الخادم العامة', () => {
  assert.equal(isTaxModeChanged({ response: { status: 409, data: { code: 'TAX_MODE_CHANGED', message: 'x' } } }), true);
  for (const e of [null, undefined, {}, { response: { status: 409, data: { code: 'PRODUCT_UNITS_CHANGED' } } }, { response: { status: 422, data: { code: 'TAX_DISABLED' } } }, new Error('net')]) {
    assert.equal(isTaxModeChanged(e), false);
  }
  const fail = between(repApp, 'if (isZatcaOutdatedClient(err)) setNeedsUpdate(true);', 'const refreshUnits = async');
  const line = fail.split('\n').find((l) => l.includes('isTaxModeChanged(err)'));
  assert.ok(line, 'الرمز غير معالج');
  assert.match(line!, /if \(isTaxModeChanged\(err\)\) \{ onCompanyStale\?\.\(\); setMsg\(tr\('([^']+)'\)\); setLoading\(false\); return; \}/);
  const msg = /tr\('([^']+)'\)/.exec(line!)![1];
  assert.doesNotMatch(msg, /ضريب|VAT/i, 'الرسالة تذكر الضريبة');
  assert.ok(fail.indexOf('isTaxModeChanged(err)') < fail.indexOf("setMsg(err?.response?.data?.message || tr('تعذر إصدار المستند حاول مجددا'))"));
  // المُصدِر للبيع والمرتجع يجلب الشركة بمرجع الجلب نفسه (النبضة الدورية) — فيتجدّد كاشها ويتبعها المستند المفتوح
  assert.equal((repApp.match(/<CreateInvoice [^\n]*onCompanyStale=\{\(\) => pullCompanyRef\.current\(\)\}/g) ?? []).length, 2, 'البيع والمرتجع');
  const pull = between(repApp, 'const pull = () => {', 'pullCompanyRef.current = pull;');
  assert.match(pull, /await cacheSet\('company', fresh\);\s*setCompany\(fresh\);/);
});
