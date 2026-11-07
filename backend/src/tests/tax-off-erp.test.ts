// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — تصدير ERP/Odoo (قرار E7) ورسالة 409 المحايدة (قرار E2).
//
// القاعدة: الشركة بلا ضريبة (CompanySettings.taxDisabled === true) ⇒ صفّ الصنف بـtaxPct صفر (النسبة الفعلية؛ المخزّنة باقية)،
// وصفّ العميل بـtaxNumber null — فلا يحمل الصنف في Odoo ضريبة بيع ولا الشريك رقماً ضريبياً. وقلب المفتاح لا يمسّ updatedAt،
// فيُرسل قسما المنتجات والعملاء كاملين مرةً بعد القلب (في الاتجاهين). والشركة بضريبتها (العلم false أو غائب) ⇒ الحمولة حرفاً كما كانت.
// المزامنة الحقيقية (syncErpResource) فوق Prisma مزيّف في الذاكرة وfetch مزيّف — بلا شبكة ولا قاعدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { customerPayloadRow, erpSinceAfterTaxToggle, ERP_WATERMARK_OVERLAP_MS, productPayloadRow } from '../services/erpPayload';
import { TAX_MODE_MESSAGES } from '../services/taxMode';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Row = Record<string, any>;
const T = '11111111-1111-4111-8111-111111111111';
const UPD = new Date('2026-11-06T08:00:00Z');
const PRODUCT: Row = {
  id: 'P1', tenantId: T, code: 'A', name: 'ماء', unit: 'حبة', taxPct: 15, basePrice: 10, vatCategory: null, status: 'ACTIVE',
  image: 'data:image/png;base64,AAAA', lotTracked: false, lotTrackedSince: null, primaryUnitId: null, baseConvertedAt: null,
  deletedAt: null, updatedAt: UPD, category: { name: 'مشروبات' }, priceTiers: [], units: [],
};
/** صفّ الصنف كما خرج قبل الميزة: بلا الصورة ولا مفاتيح اللوط ولا مفتاحَي العرض — والباقي بترتيبه */
const PRODUCT_TODAY = {
  id: 'P1', tenantId: T, code: 'A', name: 'ماء', unit: 'حبة', taxPct: 15, basePrice: 10, vatCategory: null, status: 'ACTIVE',
  deletedAt: null, updatedAt: UPD, category: { name: 'مشروبات' }, priceTiers: [], units: [],
};
const CUSTOMER: Row = { id: 'C1', tenantId: T, code: 'C-1', name: 'بقالة النور', taxNumber: '300000000000003', priceListId: 'L1', updatedAt: UPD };
const CUSTOMER_TODAY = { id: 'C1', tenantId: T, code: 'C-1', name: 'بقالة النور', taxNumber: '300000000000003', updatedAt: UPD };
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

// ───────────── Prisma مزيّف ─────────────
/** صفّ الشركة: taxDisabled غائب = صفٌّ قبل العمود؛ وآخر مزامنة نظيفة للقسم (null = أول مزامنة) */
let company: Row;
let lastClean: Date | null;
let st: { csSelects: Row[]; wheres: Record<string, Row[]>; posts: Row[]; logs: Row[] };
const reset = (c: Row, last: Date | null = null) => {
  company = c;
  lastClean = last;
  st = { csSelects: [], wheres: {}, posts: [], logs: [] };
};
reset({ countryCode: 'SA' });
const rows = (model: string, data: Row[]) => ({
  async findMany(a: Row) { (st.wheres[model] ??= []).push(a.where); return data; },
});
const db: Row = {
  erpIntegration: {
    async findUnique() {
      return {
        tenantId: T, enabled: true, provider: 'REST', baseUrl: 'https://93.184.216.34', authType: 'NONE',
        customersEndpoint: null, productsEndpoint: null, invoicesEndpoint: null, receiptsEndpoint: null,
        syncCustomers: true, syncProducts: true, syncInvoices: true, syncReceipts: true,
      };
    },
    async update() { return {}; },
  },
  erpSyncLog: {
    async findFirst() { return lastClean ? { startedAt: lastClean } : null; },
    async create(a: Row) { st.logs.push(a.data); return a.data; },
  },
  glSettings: { async findUnique() { return null; } },
  companySettings: {
    async findUnique(a: Row) { st.csSelects.push(a.select ?? null); return { ...company }; },
  },
  customer: rows('customer', [CUSTOMER]),
  product: rows('product', [PRODUCT]),
  invoice: rows('invoice', []),
  receipt: rows('receipt', []),
};
stub('config/database', { default: db });
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  st.posts.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ ok: true, created: 1 }), { status: 200 });
}) as unknown as typeof fetch;
const { syncErpResource } = require('../services/erp') as typeof import('../services/erp');

const sentRows = () => st.posts.flatMap((p) => p.data as Row[]);

// ───────────── E2 ─────────────
test('E2: رسالة 409 TAX_MODE_CHANGED محايدة بلا ذكرٍ للضريبة (تظهر لشركةٍ أزالت ضريبتها، وللتي أعادتها)', () => {
  assert.equal(TAX_MODE_MESSAGES.TAX_MODE_CHANGED, 'تغيرت إعدادات الشركة حدث الصفحة ثم أعد الإصدار');
  assert.doesNotMatch(TAX_MODE_MESSAGES.TAX_MODE_CHANGED, /ضريب|ض\.ق\.م|VAT|tax|أزيلت/i);
});

// ───────────── الصفوف الصرفة ─────────────
test('صفّ الصنف: بلا ضريبة ⇒ taxPct صفر في مكان المفتاح نفسه، والباقي حرفاً؛ وبضريبتها ⇒ كما كان (المخزّن لا يُمسّ)', () => {
  const p = { ...PRODUCT };
  assert.deepEqual(productPayloadRow(p), PRODUCT_TODAY);
  assert.deepEqual(productPayloadRow(p, false), PRODUCT_TODAY);
  const off = productPayloadRow(p, true) as Row;
  assert.deepEqual(off, { ...PRODUCT_TODAY, taxPct: 0 });
  assert.deepEqual(Object.keys(off), Object.keys(PRODUCT_TODAY), 'ترتيب المفاتيح كما هو');
  assert.equal(p.taxPct, 15, 'الصفّ المصدر لا يتغيّر');
});

test('صفّ العميل: بلا ضريبة ⇒ taxNumber null (والمفتاح باقٍ فيمحو الرقم في ERP)؛ وبضريبتها ⇒ الكائن نفسه حين لا نوع سعر', () => {
  assert.deepEqual(customerPayloadRow({ ...CUSTOMER }), CUSTOMER_TODAY);
  const off = customerPayloadRow({ ...CUSTOMER }, true) as Row;
  assert.deepEqual(off, { ...CUSTOMER_TODAY, taxNumber: null });
  assert.deepEqual(Object.keys(off), Object.keys(CUSTOMER_TODAY));
  const plain = { id: 'c', name: 'x', taxNumber: '3001' };
  assert.equal(customerPayloadRow(plain), plain, 'بضريبتها: الكائن نفسه حرفاً');
  assert.equal(customerPayloadRow(plain, false), plain);
  assert.deepEqual(customerPayloadRow({ id: 'c', name: 'x' }, true), { id: 'c', name: 'x', taxNumber: null }, 'عميلٌ بلا رقم: null صريح');
});

test('المؤشّر بعد قلب المفتاح: المنتجات والعملاء كاملين إن قُلب عند بدء آخر مزامنة نظيفة أو بعده؛ وغير ذلك المؤشّر نفسه', () => {
  const started = new Date('2026-11-06T10:00:00Z');
  const since = new Date(started.getTime() - ERP_WATERMARK_OVERLAP_MS);
  const after = new Date(started.getTime() + 60_000);
  for (const r of ['products', 'customers'] as const) {
    assert.equal(erpSinceAfterTaxToggle(r, since, after), null, `${r}: قُلب بعد آخر مزامنة ⇒ كامل`);
    assert.equal(erpSinceAfterTaxToggle(r, since, started), null, `${r}: قُلب لحظة البدء ⇒ كامل`);
    assert.equal(erpSinceAfterTaxToggle(r, since, after.toISOString()), null, `${r}: اللحظة نصّاً`);
    assert.equal(erpSinceAfterTaxToggle(r, since, new Date(started.getTime() - 1)), since, `${r}: قُلب قبل آخر مزامنة ⇒ المؤشّر`);
    assert.equal(erpSinceAfterTaxToggle(r, since, null), since, `${r}: لم يُقلب قط`);
    assert.equal(erpSinceAfterTaxToggle(r, since, undefined), since);
    assert.equal(erpSinceAfterTaxToggle(r, since, 'x'), since, 'لحظة تالفة ⇒ المؤشّر');
    assert.equal(erpSinceAfterTaxToggle(r, null, after), null, 'أول مزامنة كاملة أصلاً');
  }
  for (const r of ['invoices', 'receipts'] as const) assert.equal(erpSinceAfterTaxToggle(r, since, after), since, `${r}: بمؤشّرها (الختم يحكم كل مستند)`);
});

// ───────────── المزامنة الحقيقية ─────────────
test('المزامنة: الشركة بلا ضريبة ⇒ الصنف بـtaxPct 0 والعميل بـtaxNumber null، بقراءةٍ واحدة لصفّ الشركة', async () => {
  reset({ countryCode: 'SA', taxDisabled: true, taxModeChangedAt: null });
  const p = await syncErpResource(T, 'products');
  assert.equal(p.status, 'SUCCESS');
  assert.deepEqual(sentRows(), [json({ ...PRODUCT_TODAY, taxPct: 0 })]);
  assert.deepEqual(st.csSelects, [{ countryCode: true, taxDisabled: true, taxModeChangedAt: true }]);
  reset({ countryCode: 'SA', taxDisabled: true, taxModeChangedAt: null });
  const c = await syncErpResource(T, 'customers');
  assert.equal(c.status, 'SUCCESS');
  assert.deepEqual(sentRows(), [json({ ...CUSTOMER_TODAY, taxNumber: null })]);
  assert.equal(PRODUCT.taxPct, 15, 'المخزّن لا يُمسّ');
  assert.equal(CUSTOMER.taxNumber, '300000000000003');
});

test('المزامنة: الشركة بضريبتها (false، أو صفٌّ قبل العمود، أو تعذّر القراءة) ⇒ الحمولة حرفاً كما كانت', async () => {
  for (const c of [{ countryCode: 'SA', taxDisabled: false, taxModeChangedAt: null }, { countryCode: 'SA' }]) {
    reset(c);
    await syncErpResource(T, 'products');
    assert.equal(JSON.stringify(sentRows()), JSON.stringify([PRODUCT_TODAY]));
    reset(c);
    await syncErpResource(T, 'customers');
    assert.equal(JSON.stringify(sentRows()), JSON.stringify([CUSTOMER_TODAY]));
  }
  const keep = db.companySettings.findUnique;
  db.companySettings.findUnique = async () => { throw new Error('db down'); };
  try {
    reset({});
    await syncErpResource(T, 'products');
    assert.equal(JSON.stringify(sentRows()), JSON.stringify([PRODUCT_TODAY]), 'تعذّر قراءة الشركة ⇒ سلوك اليوم');
  } finally { db.companySettings.findUnique = keep; }
});

test('المزامنة: قلب المفتاح بعد آخر مزامنة نظيفة ⇒ المنتجات والعملاء كاملين (بلا updatedAt)، والفواتير والسندات بمؤشّرها؛ وقبلها ⇒ المؤشّر', async () => {
  const started = new Date('2026-11-06T10:00:00Z');
  const since = new Date(started.getTime() - ERP_WATERMARK_OVERLAP_MS);
  for (const taxDisabled of [true, false]) {
    // الإزالة تصفّر، والإعادة ترجع النسب والأرقام المخزّنة — كلاهما يحتاج إعادة إرسالٍ كاملة مرة
    reset({ countryCode: 'SA', taxDisabled, taxModeChangedAt: new Date(started.getTime() + 60_000) }, started);
    for (const r of ['products', 'customers', 'invoices', 'receipts'] as const) await syncErpResource(T, r);
    assert.deepEqual(st.wheres.product, [{ tenantId: T }], 'المنتجات كاملة');
    assert.deepEqual(st.wheres.customer, [{ tenantId: T }], 'العملاء كاملون');
    assert.deepEqual(st.wheres.invoice, [{ tenantId: T, updatedAt: { gt: since } }]);
    assert.deepEqual(st.wheres.receipt, [{ tenantId: T, updatedAt: { gt: since } }]);
    assert.equal((sentRows().find((x) => x.id === 'P1') as Row).taxPct, taxDisabled ? 0 : 15);
  }
  for (const changed of [new Date(started.getTime() - 3_600_000), null]) {
    reset({ countryCode: 'SA', taxDisabled: true, taxModeChangedAt: changed }, started);
    await syncErpResource(T, 'products');
    await syncErpResource(T, 'customers');
    assert.deepEqual(st.wheres.product, [{ tenantId: T, updatedAt: { gt: since } }], 'قُلب قبل آخر مزامنة أو لم يُقلب ⇒ المؤشّر');
    assert.deepEqual(st.wheres.customer, [{ tenantId: T, updatedAt: { gt: since } }]);
  }
});
