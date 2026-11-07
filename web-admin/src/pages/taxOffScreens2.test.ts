// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — شاشات الإدارة، المجموعة الثانية:
// نافذة الفاتورة والمرتجع، وتفصيل الفاتورة، ومخزون الشركة، والمنيو العام، والاستيراد، والمرتجع المرتبط.
// القاعدة: شركةٌ بلا ضريبة (CompanySettings.taxDisabled) أو مستندٌ مختوم بلاها (Invoice.taxFree) ⇒ لا ذكر للضريبة في أي سطرٍ ظاهر،
// والغائب = الشاشة كما كانت حرفاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IMPORT_TYPES, TAX_PCT_INVALID, TAX_FRACTION_NOTICE, PRICE_INCL_TAX_SUGGESTED_NOTICE, OPENING_STOCK_OPEN_NOTE, OPENING_STOCK_OPEN_NOTE_TAX_OFF, OPENING_STOCK_MATCH_NOTE, type TransformOut } from '../lib/importData';
import { importFieldLabel } from '../lib/importRevert';
import {
  toLinkedSale, fillLinkedQty, linkedReturnTotals, buildLinkedReturnPayload, buildFreeReturnPayload, type ReturnHead,
} from '../lib/returnInvoice';
import { computeInvoiceTotals } from '../rep/invoiceCalc';
import { CatalogPrices } from './CatalogPage';
import InvoiceDetailModal from '../components/forms/InvoiceDetailModal';
import type { Invoice } from '../types';

const SRC = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

/** كل ما يُعدّ ذكراً للضريبة في نصٍّ ظاهر (عقد الميزة): الكلمة بصيغها، ض.ق.م، VAT/tax، الرقم الضريبي، الفوترة الإلكترونية والهيئة */
const TAX_WORDS = /ضريب|ض\.ق\.م|\bVAT\b|\btax\b|الفوترة الإلكترونية|ZATCA|إشعار دائن|إشعار مدين|مبسطة/i;
const assertNoTax = (text: string, where: string) => {
  const m = TAX_WORDS.exec(text);
  assert.equal(m, null, `${where}: ذكرٌ للضريبة «${m?.[0]}» في: …${m ? text.slice(Math.max(0, m.index - 60), m.index + 60) : ''}…`);
};
/** نصّ المعاينة كما تعرضه لوحة الاستيراد: وسوم الحقول وعناوين أعمدة الملف المطابقة ومفاتيح التنبيهات والأخطاء والموانع */
const previewText = (t: TransformOut) => JSON.stringify({
  fields: (t.columns ?? []).map(c => importFieldLabel(c.field)),
  headers: (t.columns ?? []).filter(c => c.header).map(c => c.field),
  notices: (t.notices ?? []).map(n => n.key), warnings: t.warnings ?? [], blockers: t.blockers ?? [],
  errors: t.errors.map(e => `${e.message} ${e.field ?? ''}`),
  rows: t.valid.map(r => Object.keys(r).filter(k => r[k] !== undefined)),
  flags: { s: t.priceInclTaxSuggested ?? null, p: t.pricesIncludeTax ?? null },
});

// ═══ الاستيراد ═══

const PRODUCT_ROWS = [
  { 'الكود': 'P1', 'اسم الصنف': 'ماء', 'السعر شامل الضريبة': '11.5', 'نسبة الضريبة': '0.15' },
  { 'الكود': 'P2', 'اسم الصنف': 'عصير', 'السعر شامل الضريبة': '23', 'نسبة الضريبة': '150' },
];

test('استيراد المنتجات بلا ضريبة: عمود النسبة يُتجاهل — لا حقل ولا خطأ ولا تنبيه ولا اقتراح «شامل الضريبة»', () => {
  const off = IMPORT_TYPES.products.transform(PRODUCT_ROWS, { taxOff: true, pricesIncludeTax: true });
  assert.equal(off.valid.length, 2, 'نسبةٌ غير صالحة في عمودٍ مُتجاهَل لا تُسقط الصفّ');
  for (const r of off.valid) assert.equal(r.taxPct, undefined, 'نسبة الضريبة أُرسلت لشركةٍ بلا ضريبة');
  assert.ok(!(off.columns ?? []).some(c => c.field === 'taxPct'), 'خانة النسبة ظاهرة في «عمود الملف ← الحقل»');
  assert.equal(off.priceInclTaxSuggested, undefined);
  assert.equal(off.pricesIncludeTax, undefined, 'علم «الأسعار شاملة الضريبة» يُرسل لشركةٍ بلا ضريبة');
  assert.deepEqual(off.errors, []);
  assert.ok(!(off.notices ?? []).some(n => n.key === TAX_FRACTION_NOTICE || n.key === PRICE_INCL_TAX_SUGGESTED_NOTICE));
  // السعر كما في الملف: الويب لا يمسّه
  assert.deepEqual(off.valid.map(r => r.basePrice), [11.5, 23]);
  assertNoTax(previewText(off), 'معاينة المنتجات');
});

test('استيراد المنتجات للشركة العادية كما كان حرفاً (الغائب = اليوم)', () => {
  const on = IMPORT_TYPES.products.transform(PRODUCT_ROWS, {});
  const same = IMPORT_TYPES.products.transform(PRODUCT_ROWS, { taxOff: false });
  assert.deepEqual(same, on, 'taxOff:false غيّر التحويل');
  assert.ok((on.columns ?? []).some(c => c.field === 'taxPct' && c.header === 'نسبة الضريبة'));
  assert.equal(on.valid[0].taxPct, 15, 'الكسر يُحوَّل نسبةً كما كان');
  assert.deepEqual(on.errors.map(e => e.message), [TAX_PCT_INVALID]);
  assert.equal(on.priceInclTaxSuggested, true);
});

test('استيراد العملاء بلا ضريبة: الرقم الضريبي لا يُطابَق ولا يُرسل؛ والعادية كما كانت', () => {
  const rows = [{ 'الاسم': 'مؤسسة النور', 'الجوال': '0500000001', 'الرقم الضريبي': '300000000000003', 'المدينة': 'الرياض' }];
  const off = IMPORT_TYPES.customers.transform(rows, { taxOff: true });
  assert.equal(off.valid.length, 1);
  assert.equal(off.valid[0].taxNumber, undefined, 'الرقم الضريبي أُرسل لشركةٍ بلا ضريبة');
  assert.equal(off.valid[0].city, 'الرياض');
  assert.ok(!(off.columns ?? []).some(c => c.field === 'taxNumber'));
  assertNoTax(previewText(off), 'معاينة العملاء');
  const on = IMPORT_TYPES.customers.transform(rows, {});
  assert.equal(on.valid[0].taxNumber, '300000000000003');
  assert.ok((on.columns ?? []).some(c => c.field === 'taxNumber'));
});

test('استيراد الأسعار الخاصة بلا ضريبة: عنوان «شامل الضريبة» لا يرفع اقتراحاً ولا علماً', () => {
  const rows = [{ 'كود العميل': 'C1', 'كود الصنف': 'P1', 'السعر شامل الضريبة': '10' }];
  const off = IMPORT_TYPES.prices.transform(rows, { taxOff: true, pricesIncludeTax: true });
  assert.equal(off.valid.length, 1);
  assert.equal(off.priceInclTaxSuggested, undefined);
  assert.equal(off.pricesIncludeTax, undefined);
  assert.ok(!(off.notices ?? []).some(n => n.key === PRICE_INCL_TAX_SUGGESTED_NOTICE));
  const on = IMPORT_TYPES.prices.transform(rows, {});
  assert.equal(on.priceInclTaxSuggested, true, 'الشركة العادية: الاقتراح كما كان');
});

test('نصوص المخزون الافتتاحي لشركةٍ بلا ضريبة خالية من الضريبة، والأصل كما كان', () => {
  assertNoTax(OPENING_STOCK_OPEN_NOTE_TAX_OFF, 'بطاقة المخزون الافتتاحي');
  assertNoTax(OPENING_STOCK_MATCH_NOTE, 'وصف المعاينة');
  assert.match(OPENING_STOCK_OPEN_NOTE, /صافية من الضريبة/);
  assert.match(OPENING_STOCK_OPEN_NOTE_TAX_OFF, /ولا تدخل الدفاتر/);
});

test('لوحة الاستيراد: العلم من الشركة يصل التحويل والجسم، وخانتا «شاملة الضريبة» ونصّاهما خلفه', () => {
  const s = read('components', 'DataImportPanel.tsx');
  assert.ok(s.includes('const taxOff = isTaxOff(companyCfg);'));
  assert.ok(s.includes("conflict: null, ...(taxOff && { taxOff: true }) });"), 'العلم لا يُختم على الملف المرفوع');
  assert.ok(s.includes('...(preview.taxOff ? { taxOff: true } : {}),'), 'التحويل لا يعرف بالعلم');
  assert.ok(s.includes('const inclusiveDetected = !preview.taxOff && inclusiveTaxDetected('), 'العنوان يؤشّر الخانة لشركةٍ بلا ضريبة');
  assert.ok(s.includes('stockInclTax: stockInclTax && !preview.taxOff,'), 'علم «التكلفة شاملة الضريبة» يُرسل');
  assert.ok(s.includes('{inclusiveTaxKind(preview.kind) && !preview.taxOff && ('), 'خانة «الأسعار شاملة الضريبة» ظاهرة');
  assert.ok(s.includes('{preview.taxOff ? <p>{tr(OPENING_STOCK_MATCH_NOTE)}</p> : ('), 'خانة «التكلفة شاملة الضريبة» ظاهرة');
  assert.ok(s.includes("{tr('إجمالي تكلفة الملف')}{stockInclTax && !preview.taxOff ?"));
  assert.ok(s.includes("taxOff && stockGate.state === 'open'"), 'بطاقة المخزون الافتتاحي تقول «صافية من الضريبة»');
});

// ═══ المرتجع المرتبط والحرّ ═══

const SALE_DTO = {
  id: 'inv-1', number: 'INV-1', invoiceDate: '2026-10-20T10:00:00.000Z',
  lines: [
    { saleItemId: 'si-a', productId: 'p-a', name: 'عصير', code: 'A1', unit: 'كرتون', sold: 3, returned: 0, returnable: 3, refundUnitPrice: 103.5, taxPct: 15, lineTotal: 310.5 },
    { saleItemId: 'si-b', productId: 'p-b', name: 'حليب', code: 'B1', unit: 'علبة', sold: 5, returned: 0, returnable: 5, refundUnitPrice: 4.6, taxPct: 15, lineTotal: 23 },
  ],
};
const head = (x: Partial<ReturnHead> = {}): ReturnHead => ({ customerId: 'c', salesRepId: 'r', returnReason: 'NORMAL', notes: '', phase2: false, ...x });

test('المرتجع المرتبط بلا ضريبة: نسبة كل بندٍ صفر وبمبلغ الاسترداد نفسه، والمعاينة بلا ضريبة', () => {
  const sale = toLinkedSale(SALE_DTO);
  const filled = { ...sale, lines: fillLinkedQty(sale.lines, true) };
  const taxed = linkedReturnTotals(filled.lines, 2);
  const off = linkedReturnTotals(filled.lines, 2, 15, true);
  assert.ok(taxed.taxAmt > 0, 'عيّنة الاختبار بلا ضريبة أصلاً');
  assert.equal(off.taxAmt, 0);
  assert.equal(off.total, taxed.total, 'المرتجع بلا ضريبة غيّر مبلغ الاسترداد');
  assert.deepEqual(off.lineTotals, taxed.lineTotals);
  const body = buildLinkedReturnPayload(head({ taxOff: true }), filled, 2) as { items: { qty: number; unitPrice: number; discountPct: number; taxPct: number }[]; pricesIncludeTax: boolean };
  assert.deepEqual(body.items.map(i => i.taxPct), [0, 0]);
  // ما يحسبه الخادم من الجسم (كما في routes/invoices.ts) = المعاينة: المبلغ نفسه وضريبة صفر
  const engine = computeInvoiceTotals(body.items, { companyVat: 0, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: body.pricesIncludeTax });
  assert.equal(engine.taxAmt, 0);
  assert.equal(engine.total, taxed.total);
  // والشركة العادية: الجسم كما كان (نسبة البيع)
  const def = buildLinkedReturnPayload(head(), filled, 2) as { items: { taxPct: number }[] };
  assert.deepEqual(def.items.map(i => i.taxPct), [15, 15]);
  assert.ok(!('taxOff' in (def as object)), 'العلم تسرّب إلى جسم الطلب');
  assert.ok(!('taxOff' in (body as object)), 'العلم تسرّب إلى جسم الطلب');
});

test('المرتجع الحرّ بلا ضريبة: نسبة البند صفر؛ والعادي كما كان', () => {
  const line = { productId: 'p-a', qty: 2, unitPrice: 90, discountPct: 5, taxPct: 15 };
  const off = buildFreeReturnPayload(head({ taxOff: true }), [line], 0) as { items: { taxPct: number }[] };
  assert.deepEqual(off.items.map(i => i.taxPct), [0]);
  const on = buildFreeReturnPayload(head(), [line], 0) as { items: unknown[] };
  assert.deepEqual(on.items, [line]);
  assert.ok(!('taxOff' in (off as object)));
});

// ═══ تفصيل الفاتورة ═══

const invoice = (x: Record<string, unknown> = {}): Invoice => ({
  id: 'i1', number: 'INV-9', invoiceDate: '2026-11-07T08:00:00.000Z', type: 'CASH', status: 'CONFIRMED',
  customer: { id: 'c1', name: 'مؤسسة النور', phone: '0500000001' }, salesRep: { id: 'r1', name: 'سالم' },
  subtotal: 100, discountAmt: 0, taxAmt: 0, total: 100, paidAmt: 100, remainingAmt: 0, notes: null,
  einvoiceProvider: 'zatca', einvoiceStatus: 'ready', einvoiceUuid: null,
  items: [{ id: 'it1', qty: 2, unitPrice: 50, discountPct: 0, taxPct: 0, lineTotal: 100, unitName: null, product: { name: 'ماء', unit: 'حبة' } }],
  ...x,
}) as unknown as Invoice;

test('تفصيل فاتورةٍ مختومة بلا ضريبة: لا عمود نسبة ولا سطر ضريبة ولا شارة فوترة إلكترونية', () => {
  const html = renderToStaticMarkup(h(InvoiceDetailModal, { invoice: invoice({ taxFree: true }), onClose: () => {} }));
  assertNoTax(html, 'تفصيل الفاتورة');
  assert.ok(html.includes('مؤسسة النور') && html.includes('ماء'), 'الفاتورة لم تُصيَّر');
});

test('تفصيل فاتورةٍ قديمة بضريبتها (بلا ختم) كما صدرت', () => {
  const html = renderToStaticMarkup(h(InvoiceDetailModal, { invoice: invoice({ taxAmt: 15, total: 115 }), onClose: () => {} }));
  assert.ok(html.includes('>ضريبة<'), 'عمود الضريبة اختفى من فاتورةٍ صدرت بضريبتها');
  assert.ok(html.includes('الضريبة'), 'سطر الضريبة اختفى');
  assert.ok(html.includes('الفوترة الإلكترونية'), 'شارة الفوترة اختفت');
});

// ═══ المنيو العام ═══

test('المنيو بلا ضريبة: السعر المكتوب كما هو بلا رفعٍ بالنسبة، ولا «شاملة الضريبة»', () => {
  const p = { name: 'ماء', unit: 'حبة', basePrice: 10, taxPct: 15, units: [{ name: 'كرتون', factor: 24, price: 200 }] };
  const props = { brand: '#E15A30', dec: 2, sym: 'ر.س' };
  const off = renderToStaticMarkup(h(CatalogPrices, { p: { ...p, taxPct: 0 }, ...props }));
  const on = renderToStaticMarkup(h(CatalogPrices, { p, ...props }));
  assert.ok(off.includes((10).toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), 'سعر الحبة رُفع');
  assert.ok(on.includes((11.5).toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), 'الشركة العادية: السعر شامل كما كان');
  const s = read('pages', 'CatalogPage.tsx');
  assert.ok(s.includes("{taxOff ? 'منيو المنتجات' : 'منيو المنتجات · الاسعار شاملة الضريبة'}"), 'عبارة «شاملة الضريبة» بلا حارس');
  assert.ok(s.includes('<CatalogPrices p={taxOff ? { ...p, taxPct: 0 } : p}'), 'السعر يُرفع بالنسبة لشركةٍ بلا ضريبة');
  assert.ok(s.includes('const taxOff = isTaxOff(data?.company);'));
});

// ═══ مخزون الشركة ═══

test('مخزون الشركة بلا ضريبة: لا «قبل الضريبة» ولا خانة «شاملة الضريبة»، والتكلفة المكتوبة لا يُخصم منها', () => {
  const s = read('pages', 'CompanyWarehousePage.tsx');
  assert.ok(s.includes('const taxOff = isTaxOff(companyQ.data);'));
  assert.ok(s.includes('stockRows={rows} taxOff={taxOff}'), 'النافذة لا تعرف بالعلم');
  assert.ok(s.includes('const costsIncludeTax = !taxOff && costsIncludeTaxState;'), 'الخصم من التكلفة غير محروس');
  assert.ok(s.includes("costsIncludeTax: type === 'RECEIVE' ? costsIncludeTax : undefined,"), 'الجسم لا يمرّ بالعلم المحروس');
  // كل عبارة «قبل الضريبة» بقرينتها، وخانة «شاملة الضريبة» داخل حارسها
  for (const [off, on] of [['قيمة البضاعة', 'قيمة البضاعة قبل الضريبة'], ['قيمة السطر', 'قيمة السطر قبل الضريبة'], ['قيمة البضاعة المستلمة', 'قيمة البضاعة المستلمة قبل الضريبة']]) {
    assert.ok(s.includes(`taxOff ? tr('${off}') : tr('${on}')`), on);
  }
  const lines = s.split('\n');
  const unguarded = lines.filter(l => /tr\('[^']*ضريب/.test(l) && !/taxOff \?/.test(l));
  assert.deepEqual(unguarded.map(l => l.trim()), ["{tr('الأسعار المدخلة شاملة الضريبة')}"], 'عبارة ضريبة بلا حارس');
  const at = s.indexOf("{tr('الأسعار المدخلة شاملة الضريبة')}");
  assert.ok(s.lastIndexOf('{!taxOff && (', at) > s.lastIndexOf('</div>', at), 'خانة «شاملة الضريبة» خارج حارسها');
});

// ═══ نافذة الفاتورة ═══

test('نافذة الفاتورة: نسبة البند من effectiveTaxPct، و409 TAX_MODE_CHANGED يعيد قراءة الشركة، وختم الردّ يصل الورقة', () => {
  const s = read('components', 'forms', 'InvoiceModal.tsx');
  assert.ok(s.includes('const taxOff = isTaxOff(company);'));
  assert.ok(s.includes('discountPct: 0, taxPct: effectiveTaxPct(company, p.taxPct),'), 'البند الجديد يأخذ نسبة الصنف لشركةٍ بلا ضريبة');
  assert.ok(!/taxPct: Number\(p\.taxPct\)/.test(s));
  assert.match(s, /if \(taxOff\) setLines\(ls => \(ls\.some\(l => l\.taxPct !== 0\) \? ls\.map\(l => \(\{ \.\.\.l, taxPct: 0, lineTotal: calcLine\(l\.qty, l\.unitPrice, l\.discountPct, 0\) \}\)\) : ls\)\);\n\s+\}, \[taxOff\]\);/);
  assert.match(s, /onError: \(err: unknown, vars\) => \{[\s\S]{0,400}=== TAX_MODE_CODES\.changed\) \{\n\s+void qc\.invalidateQueries\(\{ queryKey: \['company'\] \}\);\n\s+toast\.error\(tr\(TAX_MODE_MESSAGES\.TAX_MODE_CHANGED\)/);
  assert.equal((s.match(/\.\.\.\(inv\.taxFree === true && \{ taxFree: true \}\),/g) ?? []).length, 2, 'ورقة البيع والمرتجع بعد الحفظ بلا ختم الخادم');
  assert.ok(s.includes('...(taxOff && { taxOff: true }) };'), 'المرتجع لا يعرف بالعلم');
  assert.ok(s.includes('defaultVatPct ?? 15), taxOff) : null;'), 'معاينة المرتبط بضريبة');
  // كل عبارة ضريبةٍ ظاهرة في النافذة محروسة (المرحلة الثانية ممتنعة مع إزالة الضريبة على الخادم)
  const lines = s.split('\n');
  const visible = lines.filter(l => /tr\('[^']*(ضريب|الفوترة الإلكترونية|إشعار)/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
  for (const l of visible) {
    const guarded = /taxOff/.test(l) || /phase2|PHASE2|phase 2/.test(l) || /إشعار|الإشعار|الفوترة الإلكترونية المرحلة الثانية/.test(l);
    assert.ok(guarded, `عبارة ضريبة بلا حارس: ${l.trim()}`);
  }
  assert.ok(s.includes("{!taxOff && <th>{tr('ضريبة%')}</th>}"));
  assert.ok(s.includes('colSpan={taxOff ? 6 : 7}'));
  assert.equal((s.match(/\{!taxOff && <div className="flex justify-between text-\[#E15A30\]"><span>\{tr\('ضريبة القيمة المضافة'\)\}/g) ?? []).length, 2);
});

/** يصيّر النافذة بذاكرة طلباتٍ مملوءة (بلا شبكة): الشركة والأصناف والمناديب والعملاء */
async function renderInvoiceModal(company: Record<string, unknown>): Promise<string> {
  // مخزن الجلسة (zustand) يقرأ localStorage عند الاستيراد — مخزنٌ في الذاكرة لبيئة node
  const g = globalThis as { localStorage?: Storage };
  if (!g.localStorage) {
    const m = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    } as Storage;
  }
  // `import.meta.env` بناءُ Vite لا وجود له في node (api/client يقرؤه في نطاق الوحدة): خطّافُ تحميلٍ يجعله كائناً فارغاً لملفات src
  // وحدها — فيصير أساس الواجهة '/api' ولا طلب يخرج (الاستعلامات معطّلة والذاكرة مملوءة). ومساحة الجلسة تُقرأ من مسار الصفحة
  // عند استيراد المخزن: مسار لوحة الشركة ثابتاً بدل window (نافذةٌ مزيّفة تجعل مكتبة التنبيهات تظنّ نفسها في متصفّح)
  const hook = `export async function load(url, ctx, next) {
    const r = await next(url, ctx);
    if (url.includes('/web-admin/src/') && r.source != null) {
      let src = String(r.source);
      if (src.includes('import.meta.env')) src = src.replace(/import\\.meta\\.env/g, '({})');
      if (url.endsWith('/src/store/authStore.ts')) src = src.replace(/window\\.location\\.pathname/g, '"/app"');
      return { ...r, source: src };
    }
    return r;
  }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
  const { default: InvoiceModal } = await import('../components/forms/InvoiceModal');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });
  qc.setQueryData(['company'], company);
  qc.setQueryData(['sales-reps-all'], []);
  qc.setQueryData(['customers-all'], []);
  qc.setQueryData(['products-all'], []);
  qc.setQueryData(['price-lists'], { lists: [], timezone: 'Asia/Riyadh' });
  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(InvoiceModal, { onClose: () => {}, onSaved: () => {} })));
}

test('نافذة الفاتورة مصيَّرةً: بلا ضريبة لا عمود نسبة ولا سطر ضريبة؛ والشركة العادية كما كانت', async () => {
  const off = await renderInvoiceModal({ name: 'شركة', country: 'SA', taxDisabled: true });
  assert.ok(off.includes('الإجمالي النهائي'), 'النافذة لم تُصيَّر');
  assertNoTax(off, 'نافذة الفاتورة');
  const on = await renderInvoiceModal({ name: 'شركة', country: 'SA' });
  assert.ok(on.includes('ضريبة%') && on.includes('ضريبة القيمة المضافة'), 'الشركة العادية فقدت عمود الضريبة');
  // الفرق بين الحالتين: العمود والسطر وحدهما (وعدد أعمدة صفّ «اختر صنفا»)
  const strip = (x: string) => x
    .replace('<th>ضريبة%</th>', '')
    .replace(/<div class="flex justify-between text-\[#E15A30\]"><span>ضريبة القيمة المضافة<\/span><span>[^<]*<\/span><\/div>/, '')
    .replace('colSpan="7"', 'colSpan="6"').replace('colspan="7"', 'colspan="6"');
  assert.equal(strip(on), off);
});
