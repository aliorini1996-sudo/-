// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — أطراف الخادم: وارد المستودع، والاستيراد، والمنيو العام، والمندوب الذكي،
// وقيد الفاتورة في الدفاتر، وحمولة ERP، والمزامنة. المعالجات الحقيقية فوق Prisma مزيّف في الذاكرة، والدوالّ الصرفة مباشرةً.
//
// القاعدة المحروسة في كل مسار: الشركة بلا ضريبة (CompanySettings.taxDisabled) ⇒ النسبة الفعلية صفر فلا يُردّ مبلغٌ مكتوب
// ولا يُذكر «قبل الضريبة»؛ والشركة بضريبتها (العلم false أو غائب) ⇒ المخرج والاستعلامات حرفاً كما كانت.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { netFromInclusive, roundHalfUp } from '../lib/money';
import { netUnitCost } from '../services/warehouseCost';
import { invoicePayloadRow } from '../services/erpPayload';
import { buildInvoiceMove, invoicePayloadFromRows, type InvoicePayload } from '../services/gl/builders/invoice';
import { saContext } from '../services/gl/testing/fixtures';
import type { MoveDraft } from '../services/gl/types';
import { advisorSystemPrompt } from '../ai-rep/advisorTools';
import { ruleGuideText } from '../ai-rep/guide';
import { computeInvoiceTotals } from '../lib/invoiceCalc';

const SRC = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ───────────── Prisma مزيّف ─────────────
type Row = Record<string, any>;
const T = '11111111-1111-4111-8111-111111111111';
const REP_ID = '22222222-2222-4222-8222-222222222222';
const PRODUCTS: Row[] = [
  {
    id: 'P1', tenantId: T, code: 'A', name: 'ماء', unit: 'حبة', taxPct: 15, basePrice: 10, status: 'ACTIVE', deletedAt: null,
    primaryUnitId: null, baseConvertedAt: null, image: null, category: { name: 'مشروبات' }, units: [],
  },
];
/** العلم في صفّ الشركة: true ⇒ بلا ضريبة، false ⇒ بضريبتها، undefined ⇒ صفٌّ قبل العمود (كاشٌ قديم) */
let taxDisabled: boolean | undefined;
let st: { csSelects: Row[]; entries: Row[]; created: Row[]; units: Row[]; upserts: Row[]; batches: Row[] };
const reset = (flag: boolean | undefined) => {
  taxDisabled = flag;
  st = { csSelects: [], entries: [], created: [], units: [], upserts: [], batches: [] };
};
reset(false);

const inIds = (v: any, x: unknown) => (v === undefined ? true : v && typeof v === 'object' && 'in' in v ? (v.in as unknown[]).includes(x) : v === x);
const db: Row = {
  admin: { async findUnique() { return { isActive: true, scopeEnabled: false, scopeMode: 'LISTS' }; } },
  glSettings: { async findUnique() { return null; } },
  tenant: { async findUnique() { return { isActive: true, catalogEnabled: true, warehouseEnabled: true, lotTrackingEnabled: false }; } },
  companySettings: {
    async findUnique(a: Row) {
      st.csSelects.push(a.select ?? null);
      return {
        name: 'شركة النور', logo: null, primaryColor: '#E15A30', currency: 'SAR', phone: null, countryCode: 'SA', defaultVatPct: 15,
        ...(taxDisabled !== undefined && { taxDisabled }),
      };
    },
  },
  salesRep: { async findFirst() { return { id: REP_ID, name: 'خالد', phone: '0500000000' }; } },
  workChannel: { async findFirst() { return null; } },
  customer: { async findMany() { return [{ id: 'C1', code: 'K-1', phone: '0500000001', name: 'بقالة النور' }]; } },
  customerPrice: {
    async findUnique() { return null; },
    async upsert(a: Row) { st.upserts.push(a); return { id: `CP-${a.where.customerId_productId.productId}` }; },
  },
  productCategory: { async findMany() { return []; } },
  product: {
    async findMany(a: Row) { return PRODUCTS.filter((p) => inIds(a.where?.id, p.id) && (a.where?.tenantId === undefined || a.where.tenantId === p.tenantId)); },
    async create(a: Row) { const p = { id: `NEW${st.created.length + 1}`, ...a.data }; st.created.push(p); return { id: p.id }; },
    async update(a: Row) { return { id: a.where.id }; },
  },
  productUnit: {
    async findMany() { return []; },
    async createMany(a: Row) { st.units.push(...(a.data as Row[])); return { count: a.data.length }; },
  },
  warehouseEntry: {
    async findFirst() { return null; },
    async create(a: Row) { st.entries.push(a.data); return { id: 'E1', ...a.data }; },
  },
  importBatch: {
    async findFirst() { return null; },
    async findMany() { return []; },
    async create(a: Row) { st.batches.push(a.data); return { id: 'B1' }; },
    async update() { return {}; },
    async deleteMany() { return { count: 1 }; },
  },
};
const sqlOf = (strings: TemplateStringsArray) => strings.join('$').replace(/\s+/g, ' ').trim();
const tx: Row = Object.assign(Object.create(db), {
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = sqlOf(strings);
    if (sql.includes('FOR KEY SHARE')) {
      const ids = values.find((v): v is string[] => Array.isArray(v)) ?? [];
      return PRODUCTS.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, unit: p.unit, lotTracked: false, lotTrackedSince: null }));
    }
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
    return [];
  },
  async $executeRaw() { return 1; },
});
db.$transaction = async (fn: (t: Row) => Promise<unknown>) => fn(tx);
db.$executeRaw = tx.$executeRaw;
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const warehouseRouter = (require('../routes/warehouse') as typeof import('../routes/warehouse')).default;
const importRouter = (require('../routes/import') as typeof import('../routes/import')).default;
const catalogRouter = (require('../routes/publicCatalog') as typeof import('../routes/publicCatalog')).default;
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: T, name: 'المدير' };
/** معالج المسار الأخير وحده (بعد حرّاس الموجّه والصلاحية) */
async function call(router: unknown, method: 'get' | 'post', p: string, req: Row): Promise<{ status: number; body: Row }> {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  let err: unknown = null;
  await (layer.route.stack as Row[]).at(-1)!.handle({ query: {}, params: {}, headers: {}, body: {}, user: ADMIN, ...req }, res, (e?: unknown) => { err = e ?? null; });
  if (err) throw err;
  return { status: res.statusCode, body: res.body };
}
const TAX_FLAG_SELECT = { taxDisabled: true };

// ═══ وارد المستودع ═══

const receive = (costsIncludeTax?: boolean) => call(warehouseRouter, 'post', '/entries', {
  body: { type: 'RECEIVE', ...(costsIncludeTax !== undefined && { costsIncludeTax }), items: [{ productId: 'P1', qty: 2, unitCost: 115 }] },
});

test('وارد «شامل الضريبة» لشركةٍ بضريبتها: يُردّ إلى صافيه كما كان (115 ⇒ 100) — والعلم غائباً كالـfalse حرفاً', async () => {
  for (const flag of [false, undefined]) {
    reset(flag);
    const r = await receive(true);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(st.entries[0].items.create[0].unitCost, 100);
    assert.equal(st.entries[0].items.create[0].unitCost, netUnitCost(115, 15, true));
    assert.deepEqual(st.csSelects, [TAX_FLAG_SELECT], 'قراءة العلم وحده');
  }
});

test('وارد «شامل الضريبة» لشركةٍ بلا ضريبة: النسبة الفعلية صفر فالتكلفة المخزَّنة ما كُتب (115)', async () => {
  reset(true);
  const r = await receive(true);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(st.entries[0].items.create[0].unitCost, 115);
  assert.equal(netUnitCost(115, 0, true), netUnitCost(115, 15, false), 'netFromInclusive(x, 0) = x');
});

test('وارد بلا «شامل الضريبة» (الافتراضي): لا استعلام عن الشركة أصلاً — المسار القائم حرفاً، والتكلفة ما كُتب في الوضعين', async () => {
  for (const flag of [false, true]) {
    reset(flag);
    for (const opt of [undefined, false]) {
      const r = await receive(opt);
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    assert.deepEqual(st.entries.map((e) => e.items.create[0].unitCost), [115, 115]);
    assert.deepEqual(st.csSelects, [], 'لا استعلام زائد');
  }
});

// ═══ الاستيراد ═══

const importProducts = (pricesIncludeTax: boolean) => call(importRouter, 'post', '/products', {
  body: {
    pricesIncludeTax,
    rows: [
      { code: 'N1', name: 'شاي', unit: 'علبة', basePrice: 11.5, taxPct: 15, units: [{ name: 'كرتون', factor: 12, price: 138 }] },
      { code: 'N2', name: 'سكر', unit: 'كيس', basePrice: 23 },
    ],
  },
});

test('استيراد المنتجات «شاملة الضريبة» لشركةٍ بضريبتها: الصافي كما كان، والعلم في استعلام الشركة القائم نفسه', async () => {
  reset(false);
  const r = await importProducts(true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(st.created.map((p) => [p.code, p.basePrice, p.taxPct]), [['N1', 10, 15], ['N2', 20, 15]]);
  assert.equal(st.units[0].price, roundHalfUp(netFromInclusive(138, 15), 2));
  assert.equal(r.body.data.netFromInclusive, 2);
  assert.deepEqual(st.csSelects, [{ defaultVatPct: true, currency: true, taxDisabled: true }], 'استعلامٌ واحد كما كان + العمود');
});

test('استيراد المنتجات «شاملة الضريبة» لشركةٍ بلا ضريبة: السعر كما كُتب (لا ردّ)، والنسبة المخزَّنة للصنف كما كانت (للإعادة)', async () => {
  reset(true);
  const r = await importProducts(true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(st.created.map((p) => [p.code, p.basePrice, p.taxPct]), [['N1', 11.5, 15], ['N2', 23, 15]]);
  assert.equal(st.units[0].price, 138);
  assert.equal(r.body.data.netFromInclusive, 0, 'لا سطر «حُوِّل من الشامل»');
});

const importPrices = (pricesIncludeTax: boolean) => call(importRouter, 'post', '/prices', {
  body: { pricesIncludeTax, rows: [{ customerCode: 'K-1', productCode: 'A', price: 11.5 }] },
});

test('استيراد أسعار العملاء «شاملة الضريبة»: بضريبتها ⇒ الصافي كما كان، وبلا ضريبة ⇒ السعر كما كُتب', async () => {
  reset(false);
  let r = await importPrices(true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(st.upserts.map((u) => u.update.price), [10]);
  assert.equal(r.body.data.netFromInclusive, 1);
  assert.deepEqual(st.csSelects, [{ defaultVatPct: true, currency: true, taxDisabled: true }]);

  reset(true);
  r = await importPrices(true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(st.upserts.map((u) => u.update.price), [11.5]);
  assert.equal(r.body.data.netFromInclusive, 0);

  // بلا الخيار: لا استعلام عن الشركة في الوضعين (كما كان)
  for (const flag of [false, true]) {
    reset(flag);
    r = await importPrices(false);
    assert.deepEqual([st.upserts.map((u) => u.update.price), st.csSelects], [[11.5], []]);
  }
});

test('المخزون الافتتاحي: «التكلفة شاملة الضريبة» يسقط للشركة بلا ضريبة قبل حلّ الصفوف — والعلم يُقرأ حين يُطلب الخيار وحده', () => {
  const src = read('routes/import.ts');
  const body = src.slice(src.indexOf("router.post('/opening-stock'"), src.indexOf('\nrouter.', src.indexOf("router.post('/opening-stock'") + 10));
  const gate = "if (body.pricesIncludeTax && isTaxOff(await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { taxDisabled: true } }))) {";
  const at = body.indexOf(gate);
  assert.ok(at > 0, 'بوّابة العلم');
  assert.match(body.slice(at, at + gate.length + 60), /body\.pricesIncludeTax = false;/);
  // بعد البصمة (الخيار لا يدخلها) وقبل حلّ الصفوف بالتكلفة
  assert.ok(body.indexOf('openingStockContentHash(rows)') < at);
  assert.ok(at < body.indexOf('resolveOpeningStockRows(rows, openingStockProductMatcher(products), body.pricesIncludeTax, { lotsOn })'));
});

// ═══ المنيو العام ═══

const catalog = () => call(catalogRouter, 'get', '/catalog/:tenantId/:repId', { params: { tenantId: T, repId: REP_ID }, user: undefined });

test('المنيو العام لشركةٍ بضريبتها: JSON العلن حرفاً كما كان (النسبة المخزَّنة، ولا مفتاح taxDisabled)', async () => {
  for (const flag of [false, undefined]) {
    reset(flag);
    const r = await catalog();
    assert.equal(r.status, 200);
    assert.equal(JSON.stringify(r.body), JSON.stringify({
      success: true,
      data: {
        company: { name: 'شركة النور', logo: null, primaryColor: '#E15A30', currency: 'SAR' },
        rep: { name: 'خالد', contact: '0500000000' },
        products: [{ name: 'ماء', unit: 'حبة', basePrice: 10, taxPct: 15, image: null, category: 'مشروبات', units: [] }],
      },
    }));
    assert.equal(st.csSelects.length, 1);
    assert.deepEqual(st.csSelects[0], { name: true, logo: true, primaryColor: true, currency: true, phone: true, taxDisabled: true }, 'العمود في الاستعلام القائم');
  }
});

test('المنيو العام لشركةٍ بلا ضريبة: نسبة كل صنفٍ صفر (السعر المعروض = المكتوب) وعلم الشركة taxDisabled للواجهة', async () => {
  reset(true);
  const r = await catalog();
  assert.equal(r.status, 200);
  assert.equal(r.body.data.company.taxDisabled, true);
  assert.deepEqual(r.body.data.products.map((p: Row) => [p.basePrice, p.taxPct]), [[10, 0]]);
  assert.equal(st.csSelects.length, 1, 'بلا استعلامٍ زائد');
});

// ═══ المندوب الذكي ═══

test('تعليمات المستشار: «وقبل الضريبة» تسقط للشركة بلا ضريبة وحدها — والغائب نصّ اليوم حرفاً', () => {
  const base = { companyName: 'النور', playbook: null, showMoney: true, currency: 'SAR' };
  const today = advisorSystemPrompt(base);
  assert.ok(today.includes('القيم المالية بعملة SAR وقبل الضريبة.'));
  assert.equal(advisorSystemPrompt({ ...base, taxOff: false }), today);
  const off = advisorSystemPrompt({ ...base, taxOff: true });
  assert.ok(off.includes('القيم المالية بعملة SAR.'));
  assert.doesNotMatch(off, /ضريب/);
  assert.equal(off, today.replace('القيم المالية بعملة SAR وقبل الضريبة.', 'القيم المالية بعملة SAR.'), 'السطر وحده');
  // بلا مال: النصّ نفسه في الوضعين
  assert.equal(advisorSystemPrompt({ ...base, showMoney: false, taxOff: true }), advisorSystemPrompt({ ...base, showMoney: false }));
});

test('نصّ التوجيه الحتمي: «شهرياً قبل الضريبة» ⇒ «شهرياً» للشركة بلا ضريبة، والغائب حرفاً كما كان', () => {
  const estimate = { ok: true, monthlyTotalValue: { low: 300, high: 500 }, products: [] };
  const byRef = new Map([['P1', { ref: 'P1', lat: 24.7, lng: 46.7, distanceM: 120, relation: 'NEW', lastOutcome: null, outletType: 'grocery', typeLabel: 'بقالة', estimate }]]);
  const today = ruleGuideText(['P1'], byRef as never, null, 'SAR');
  assert.ok(today.includes('متوقع 300–500 SAR شهرياً قبل الضريبة'));
  assert.equal(ruleGuideText(['P1'], byRef as never, null, 'SAR', { taxOff: false }), today);
  const off = ruleGuideText(['P1'], byRef as never, null, 'SAR', { taxOff: true });
  assert.equal(off, today.replace(' قبل الضريبة', ''));
  assert.doesNotMatch(off, /ضريب/);
});

// ═══ قيد الفاتورة في الدفاتر ═══

function zeroInvoice(taxFree?: boolean): InvoicePayload {
  const calc = computeInvoiceTotals([{ qty: 3, unitPrice: 40, discountPct: 0, taxPct: 0 }], { companyVat: 0, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: false });
  return invoicePayloadFromRows({
    invoice: {
      id: 'inv1', number: 'INV-0001', type: 'CREDIT', customerId: 'cust1', salesRepId: 'rep1', pricesIncludeTax: false,
      subtotal: calc.subtotal, discountAmt: calc.discountAmt, taxAmt: calc.taxAmt, total: calc.total,
      ...(taxFree !== undefined && { taxFree }),
    },
    items: calc.items.map((it) => ({ productId: 'p0', categoryId: null, qty: it.qty, unitPrice: it.unitPrice, taxPct: it.taxPct, taxAmt: it.taxAmt, lineTotal: it.lineTotal })),
    customerName: 'مؤسسة النور', salesRepName: 'خالد', entryDate: '2026-11-07', currency: 'SAR', currencyDecimals: 2,
  });
}

test('الحمولة: taxFree يدخلها حين يكون true وحده — والفاتورة بضريبتها (false أو غائب) حمولتها حرفاً كما كانت', () => {
  assert.equal(JSON.stringify(zeroInvoice(false)), JSON.stringify(zeroInvoice()));
  assert.ok(!('taxFree' in zeroInvoice(false)));
  assert.equal(zeroInvoice(true).taxFree, true);
});

test('قيد فاتورة مختومة بلا ضريبة: لا علامة ولا مفتاح ضريبة ولا «0٪» — والصفرية غير المختومة كما كانت (علامة Z_SALE)', () => {
  const ctx = saContext();
  const before = buildInvoiceMove(zeroInvoice(), ctx) as MoveDraft;
  assert.equal(before.kind, 'MOVE');
  assert.equal(before.lines.filter((l) => l.taxRole === 'MARKER').length, 1, 'سلوك اليوم: علامة الصفرية');
  assert.deepEqual(buildInvoiceMove(zeroInvoice(false), ctx), before, 'false = الغائب حرفاً');

  const m = buildInvoiceMove(zeroInvoice(true), ctx) as MoveDraft;
  assert.equal(m.kind, 'MOVE');
  assert.deepEqual(m.lines.filter((l) => l.taxRole || l.taxId || l.taxCode || l.vatBox), [], 'لا أثر ضريبي في أي سطر');
  for (const l of m.lines) assert.doesNotMatch(l.label, /٪|ضريب/, l.label);
  // المبالغ نفسها: الذمة والإيراد كما في القيد الصفري
  const sums = (x: MoveDraft) => x.lines.filter((l) => l.taxRole !== 'MARKER').map((l) => [l.debitMilli, l.creditMilli]);
  assert.deepEqual(sums(m), sums(before));
});

// ═══ حمولة ERP والمزامنة ═══

test('حمولة ERP: الختم taxFree لا يخرج (payloadVersion 3 حرفاً) — صفّ الفاتورة بالعمود false أو true يساوي صفّها قبل العمود', () => {
  const inv = {
    id: 'i1', number: 'INV-1', invoiceDate: new Date('2026-11-07T10:00:00Z'), pricesIncludeTax: false, total: 120, taxAmt: 0,
    einvoiceProvider: 'none', einvoiceStatus: null,
    items: [{ unitPrice: 40, taxPct: 0, taxAmt: 0, lineTotal: 120, qty: 3 }],
  };
  const legacy = invoicePayloadRow(inv, 'Asia/Riyadh');
  for (const taxFree of [false, true]) {
    const row = invoicePayloadRow({ ...inv, taxFree }, 'Asia/Riyadh');
    assert.ok(!('taxFree' in row));
    assert.equal(JSON.stringify(row), JSON.stringify(legacy));
  }
  assert.equal(legacy.payloadVersion, 3);
});

test('المزامنة: Invoice.taxFree مكشوفٌ في قائمة سماح الفواتير بسببه، وCompanySettings ليس مورد مزامنة', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sync = require('../services/apiSync') as typeof import('../services/apiSync');
  const inv = sync.syncResource('invoices')!;
  assert.equal((inv.select as Row).taxFree, true);
  assert.ok(!('taxFree' in inv.denied));
  assert.ok(!sync.SYNC_RESOURCES.some((r) => r.model === 'companySettings'), 'أعمدة الشركة الثلاثة خارج المزامنة');
  assert.match(read('services/apiSync.ts'), /«إزالة الضريبة»: ختم بلا ضريبة[^\n]*\n[^\n]*\n\s*'taxFree',/);
});
