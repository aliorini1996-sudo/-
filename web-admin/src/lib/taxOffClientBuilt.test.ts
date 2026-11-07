// «إزالة الضريبة» — مرحلة الإصلاح (CONTRACT2 E1/E2) في عملاء الإدارة: نافذة الفاتورة (components/forms/InvoiceModal)، وفاتورة الجوال
// (/m MInvoiceCreate)، وأجسام المرتجع (lib/returnInvoice).
// E1: كل جسم فاتورةٍ يبنيه عميلنا يعلن الوضع الذي سُعِّرت به بنوده `builtTaxFree: boolean` (= isTaxOff للشركة كما عرفها)، فيردّ الخادم
//     409 TAX_MODE_CHANGED على جهازٍ قديم بالاتجاهين (أُزيلت الضريبة، أو أُعيدت وبنوده صفر).
// E2: على ذلك الردّ تُجلب الشركة بالاتجاهين وتنقلب البنود: صفرٌ عند الإزالة، ونسبة الصنف عند العودة (والسعر الصافي كما هو)،
//     بالرسالة المحايدة من الأساس (TAX_MODE_MESSAGES عبر tr).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { retaxRestoredLines, type RetaxLine } from './invoiceModalRetax';
import { toLinkedSale, fillLinkedQty, buildLinkedReturnPayload, buildFreeReturnPayload, type ReturnHead } from './returnInvoice';
import { TAX_MODE_MESSAGES } from './taxMode';
import { computeInvoiceTotals } from '../rep/invoiceCalc';
import { retaxInvoiceLines } from '../m/mUnits';

const SRC = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

/** calcLine في النافذة حرفياً: المحرّك المشترك بنسبة البند */
const calc = (qty: number, unitPrice: number, discountPct: number, taxPct: number) =>
  computeInvoiceTotals([{ qty, unitPrice, discountPct, taxPct }], { companyVat: taxPct, decimals: 2, invoiceDiscountPct: 0 }).items[0].lineTotal;

const line = (productId: string, taxPct: number, over: Partial<RetaxLine> = {}): RetaxLine & { tag: string } => ({
  productId, qty: 2, unitPrice: 100, discountPct: 5, taxPct, lineTotal: calc(2, 100, 5, taxPct), tag: productId, ...over,
});
const PRODUCTS = [{ id: 'p-a', taxPct: 15 }, { id: 'p-b', taxPct: 0 }, { id: 'p-c', taxPct: '5' }, { id: 'p-x', taxPct: 15 }];
const ON = { taxDisabled: false };
const OFF = { taxDisabled: true };

// ═══ E2: عودة الضريبة والنافذة مفتوحة ═══

test('عودة الضريبة: البند المسعَّر بلا ضريبة يأخذ نسبة صنفه الفعلية، والسعر الصافي المكتوب كما هو والإجمالي يتبعه', () => {
  const ls = [line('p-a', 0), line('p-b', 0), line('p-c', 0), line('p-gone', 0), line('p-x', 7)];
  const out = retaxRestoredLines(ls, PRODUCTS, ON, calc);
  assert.notEqual(out, ls);
  assert.deepEqual(out.map(l => l.taxPct), [15, 0, 5, 0, 7]);
  assert.deepEqual(out.map(l => l.unitPrice), [100, 100, 100, 100, 100], 'السعر المكتوب نهائي');
  assert.equal(out[0].lineTotal, calc(2, 100, 5, 15));
  assert.ok(out[0].lineTotal > ls[0].lineTotal, 'الإجمالي لم يتبع النسبة');
  assert.equal(out[0].tag, 'p-a', 'حقول البند الأخرى تبقى');
  // ما لا يتغيّر هو الكائن نفسه: صنفٌ نسبته صفر، وصنفٌ غائب عن القائمة، وبندٌ بنسبةٍ غير الصفر
  assert.equal(out[1], ls[1]);
  assert.equal(out[3], ls[3]);
  assert.equal(out[4], ls[4]);
  assert.equal(out[2].lineTotal, calc(2, 100, 5, 5), 'نسبة الصنف النصّية تُقرأ عدداً');
});

test('لا عودة = لا تغيير: الشركة ما زالت بلا ضريبة، أو لا بند بصفر، أو لا أصناف — المصفوفة نفسها', () => {
  const zero = [line('p-a', 0)];
  assert.equal(retaxRestoredLines(zero, PRODUCTS, OFF, calc), zero, 'شركةٌ بلا ضريبة لا تُعاد نسبها');
  const taxed = [line('p-a', 15), line('p-c', 5)];
  assert.equal(retaxRestoredLines(taxed, PRODUCTS, ON, calc), taxed);
  assert.equal(retaxRestoredLines(zero, undefined, ON, calc), zero);
  assert.equal(retaxRestoredLines([], PRODUCTS, ON, calc).length, 0);
});

test('النافذة: الاتجاهان — الإزالة تصفّر (الأثر القائم) والعودة تعيد النسبة من الوضع السابق لا من أول قراءة', () => {
  const s = read('components', 'forms', 'InvoiceModal.tsx');
  assert.ok(s.includes("import { retaxRestoredLines } from '../../lib/invoiceModalRetax';"));
  // الإزالة كما كانت
  assert.match(s, /if \(taxOff\) setLines\(ls => \(ls\.some\(l => l\.taxPct !== 0\) \? ls\.map\(l => \(\{ \.\.\.l, taxPct: 0, lineTotal: calcLine\(l\.qty, l\.unitPrice, l\.discountPct, 0\) \}\)\) : ls\)\);\n\s+\}, \[taxOff\]\);/);
  // العودة: انقلابٌ من true إلى false وحده (أول قراءةٍ للشركة تبدأ بالوضع نفسه فلا تُعدّ عودة)
  assert.match(s, /const taxOffSeen = useRef\(taxOff\);\n\s+useEffect\(\(\) => \{\n\s+const wasOff = taxOffSeen\.current;\n\s+taxOffSeen\.current = taxOff;\n\s+if \(wasOff && !taxOff\) setLines\(ls => retaxRestoredLines\(ls, products, company, calcLine\)\);\n\s+\}, \[taxOff\]\);/);
  // الأثر بعد تعريف الأصناف والشركة (لا قراءة قبل التعريف)
  const at = s.indexOf('const taxOffSeen = useRef(taxOff);');
  assert.ok(s.indexOf('const { data: products } = useQuery({') < at && s.indexOf('const taxOff = isTaxOff(company);') < at);
});

// ═══ E2: ردّ 409 بالاتجاهين والرسالة المحايدة ═══

test('409 TAX_MODE_CHANGED في النافذة والجوال: تُجلب الشركة بلا شرطٍ على الاتجاه، والرسالة من الأساس بلا ذكرٍ للضريبة', () => {
  assert.doesNotMatch(TAX_MODE_MESSAGES.TAX_MODE_CHANGED, /ضريب|ض\.ق\.م|VAT|tax|أزيلت/i, 'رسالة الأساس تذكر الضريبة');
  const modal = read('components', 'forms', 'InvoiceModal.tsx');
  const branch = /=== TAX_MODE_CODES\.changed\) \{\n\s+void qc\.invalidateQueries\(\{ queryKey: \['company'\] \}\);\n\s+toast\.error\(tr\(TAX_MODE_MESSAGES\.TAX_MODE_CHANGED\), \{ duration: 8000 \}\);\n\s+return;\n\s+\}/;
  assert.match(modal, branch);
  // لا شرط على taxOff حول الفرع (يجلب في الاتجاهين)
  const at = modal.indexOf('=== TAX_MODE_CODES.changed) {');
  assert.doesNotMatch(modal.slice(modal.lastIndexOf('onError: (err: unknown, vars) => {', at), at), /taxOff/);
  const m = read('m', 'MInvoiceCreate.tsx');
  assert.match(m, /if \(taxModeChangedOf\(e\)\) \{\s*requestCompanyRefetch\(\);\s*toast\.error\(tr\(TAX_MODE_MESSAGES\.TAX_MODE_CHANGED\)\);\s*return;\s*\}/);
  // ولا نصّ «أزيلت الضريبة» حرفياً في أي منهما
  for (const src of [modal, m]) assert.doesNotMatch(stripComments(src), /أزيلت الضريبة/);
});

test('الجوال: عودة الضريبة تعيد نسبة الصنف (retaxInvoiceLines) والسعر الصافي كما هو', () => {
  const catalog = { 'p-a': { taxPct: 15 }, 'p-b': { taxPct: 0 } };
  const ls = [{ productId: 'p-a', taxPct: 0, unitPrice: 100 }, { productId: 'p-b', taxPct: 0, unitPrice: 50 }];
  const back = retaxInvoiceLines(ls, catalog, ON);
  assert.deepEqual(back.map(l => [l.taxPct, l.unitPrice]), [[15, 100], [0, 50]]);
  assert.equal(back[1], ls[1]);
  assert.equal(retaxInvoiceLines(back, catalog, OFF).every(l => l.taxPct === 0), true, 'والإزالة تصفّرها');
  const m = read('m', 'MInvoiceCreate.tsx');
  assert.match(m, /setLines\(ls => retaxInvoiceLines\(ls, catalog, taxCo\)\);[\s\S]{0,200}\}, \[taxOff\]\);/);
});

// ═══ E1: builtTaxFree في كل جسم ═══

/** جسم البيع في المصدر: من `mutation.mutate({` حتى أول بند */
const bodyOf = (src: string, start: string, end: string) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `بداية الجسم غائبة: ${start}`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `نهاية الجسم غائبة: ${end}`);
  return src.slice(a, b);
};

test('E1 النافذة: جسم البيع يعلن builtTaxFree من taxOff دائماً (لا شرط)، والمرتجع من رأسه', () => {
  const s = read('components', 'forms', 'InvoiceModal.tsx');
  const sale = bodyOf(s, '    mutation.mutate({\n      customerId, salesRepId, type', '      items: withSaleLots(');
  assert.match(sale, /\n\s+builtTaxFree: taxOff,\n/);
  assert.equal(s.split('builtTaxFree: taxOff,').length - 1, 1, 'مرّةً واحدة: البيع وحده (المرتجع يبنيه returnInvoice)');
  // المرتجع: الرأس يحمل العلم، والجسمان يُبنيان منه
  assert.ok(s.includes('...(taxOff && { taxOff: true }) };'));
  assert.ok(s.includes('mutation.mutate(buildLinkedReturnPayload(head, linked, retDec))'));
  assert.ok(s.includes('const base = { ...buildFreeReturnPayload(head, lines, discountPct), ...(priceListOn && { priceListId }) };'));
});

test('E1 الجوال: جسم الفاتورة يعلن builtTaxFree من taxOff دائماً، قبل البنود', () => {
  const s = read('m', 'MInvoiceCreate.tsx');
  const body = bodyOf(s, 'const res = await invoiceApi.create({', '        items: lines.map(l => ({');
  assert.match(body, /\n\s+builtTaxFree: taxOff,\n/);
  assert.ok(s.includes('const taxOff = isTaxOff(taxCo);'));
});

const head = (x: Partial<ReturnHead> = {}): ReturnHead => ({ customerId: 'c', salesRepId: 'r', returnReason: 'NORMAL', notes: '', phase2: false, ...x });
const SALE = toLinkedSale({
  id: 'inv-1', number: 'INV-1', invoiceDate: '2026-10-20T10:00:00.000Z',
  lines: [{ saleItemId: 'si-a', productId: 'p-a', name: 'عصير', code: 'A1', unit: 'كرتون', sold: 3, returned: 0, returnable: 3, refundUnitPrice: 103.5, taxPct: 15 }],
});
const FILLED = { ...SALE, lines: fillLinkedQty(SALE.lines, true) };
const FREE = [{ productId: 'p-a', qty: 2, unitPrice: 90, discountPct: 0, taxPct: 15 }];

test('E1 المرتجع: الجسمان (المرتبط والحرّ) يعلنان builtTaxFree دائماً — true للشركة بلا ضريبة وإلا false', () => {
  for (const [taxOff, want] of [[true, true], [false, false], [undefined, false]] as const) {
    const h = head(taxOff === undefined ? {} : { taxOff });
    const linked = buildLinkedReturnPayload(h, FILLED, 2);
    const free = buildFreeReturnPayload(h, FREE, 0);
    assert.equal(linked.builtTaxFree, want, `المرتبط taxOff=${taxOff}`);
    assert.equal(free.builtTaxFree, want, `الحرّ taxOff=${taxOff}`);
    assert.ok(!('taxOff' in linked) && !('taxOff' in free), 'علم الرأس تسرّب إلى الجسم');
  }
  // النسب تتبع الرأس كما كانت: صفرٌ بلا ضريبة، ونسبة البيع/البند لغيرها
  const off = buildLinkedReturnPayload(head({ taxOff: true }), FILLED, 2) as { items: { taxPct: number }[] };
  const on = buildLinkedReturnPayload(head(), FILLED, 2) as { items: { taxPct: number }[] };
  assert.deepEqual([off.items[0].taxPct, on.items[0].taxPct], [0, 15]);
  const offFree = buildFreeReturnPayload(head({ taxOff: true }), FREE, 0) as { items: { taxPct: number }[] };
  assert.equal(offFree.items[0].taxPct, 0);
});
