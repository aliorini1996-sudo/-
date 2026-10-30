// «تتبّع اللوط» — إصدار المرحلة الثانية والإشعار الدائن (المواصفة §٤.٩، §٨.٢ lots-phase2). تملكه الحزمة B6.
//
// بلا قاعدة ولا شبكة: الفرع (routes/invoicesZatca.ts) ووصل الإشعارات (routes/invoicesNotes.ts) يُستدعيان مباشرةً باعتماديات
// الذاكرة نفسها التي تبني بها اختبارات الفرع القائمة (z5-submit)، وخطّاف اللوط مزيّفٌ يسجّل ترتيب النداءات. ما يُثبَت هنا:
//   ١) الفحص المسبق قبل التوقيع (openIssuanceSigning): الرفض لا يستهلك ICV ولا يفتح معاملة.
//   ٢) التوزيع داخل createInvoice بعد قفل السلسلة وقبل إدراج الصفّ وقبل afterDocument، بمعرّفٍ مولَّد مسبقاً تحمله الصفوف.
//   ٣) الإشعار الدائن يرث من الأصل المقفل (link CREDITED، saleItemId = بند الأصل) بسيارة مندوب الإشعار، ويوم الخادم.
//   ٤) القياسيّ «01» يُكتب بأعمدة الحجز (D24)، والمدين بلا توزيع، وغياب الخطّاف أو الخطة = سلوك الفرع القائم حرفاً.
//   ٥) مراجعة B6: رفض الفحص المسبق لطلبٍ التزم توأمه بالـclientRef لا يُردّ، وانتظار قفل اللوط داخل المعاملة LOT_BUSY 503
//      (D14)، واللقطة القائمة تُختم داخل المعاملة لبندٍ ورث «غير معروف» (D12)، وإعادة الصندوق لا تُرفض بالكسور (R6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubmitHarness, type SubmitHarness } from '../compliance/zatca/__fixtures__/z5-submit';
import { CUSTOMERS, COMPANY_VAT, PRODUCTS, REQ_SIMPLIFIED_Z1, Z5_TENANT, engineOf } from '../compliance/zatca/__fixtures__/z5-sources';
import { REQ_STANDARD_NO_HEAD_DISCOUNT, originalInvoice } from '../compliance/zatca/__fixtures__/z5-notes';
import type { NoteOriginalInvoice } from '../compliance/zatca/notes';
import {
  issuePhase2Invoice, withLotWarnings,
  type Phase2IssuanceContext, type Phase2LegacyItem, type Phase2LotHooks, type Phase2Tx,
} from '../routes/invoicesZatca';
import { creditNoteLotPlan, issueCreditNote, issueDebitNote, type NoteIssuanceDeps } from '../routes/invoicesNotes';
import {
  ClientRefRace, LOT_HOLD_MIRRORS, LotError, lotHttpError,
  type InvoiceLotAllocation, type InvoiceLotPlan, type ItemExpiryStamp, type LotWarning,
} from '../services/lots';
import { precheckInvoiceLots } from '../services/lotsInvoice';

const DAY = '2026-12-01';

// ═══ العُدّة ═══

interface Rig {
  h: SubmitHarness;
  log: string[];
  rows: Map<string, Record<string, unknown>>;
  created: Record<string, unknown>[];
  ledger: string[];
  plans: InvoiceLotPlan[];
  prechecked: InvoiceLotPlan[];
  /** clientRef صفوفٍ ملتزمة (توأمٌ سبق) — يقرؤها db.invoice.findUnique */
  twins: Set<string>;
  /** نداءات linkedStamps: [الشركة، بنود البيع، اللحظة] */
  stampCalls: [string, readonly string[], Date][];
}

const PRODUCT_ROWS = PRODUCTS.map(p => ({
  id: p.id, name: p.name, unit: 'حبة',
  vatCategory: p.vatCategory ?? null, vatExemptionCode: p.vatExemptionCode ?? null, vatExemptionReason: p.vatExemptionReason ?? null,
}));

/** صفّ الأصل كما يقرؤه محمّل الإشعار، وبطاقة صنف كل بند بعَلَم «تتبّع باللوط». */
function dbRow(o: NoteOriginalInvoice, tracked: ReadonlySet<string>): Record<string, unknown> {
  return {
    ...o, einvoiceSnapshot: null, teamId: null, locationId: null, invoiceDate: null,
    items: o.items.map(i => ({
      ...i, unitName: null, unitFactor: 1, baseQty: null, lineTotal: null,
      product: { name: i.itemName, unit: 'حبة', damagedReturnToStock: i.damagedReturnToStock, units: [], lotTracked: !!i.productId && tracked.has(i.productId) },
    })),
  };
}

function txAdapter(rig: Rig): Record<string, unknown> {
  return {
    invoice: {
      findFirst: async ({ where }: { where: { id: string } }) => { rig.log.push('tx.invoice.findFirst'); return rig.rows.get(where.id) ?? null; },
      findMany: async () => { rig.log.push('tx.invoice.findMany'); return []; },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rig.log.push('tx.invoice.create');
        const id = typeof data.id === 'string' ? data.id : `row-${rig.created.length + 1}`;
        const nested = data.items as { create?: Record<string, unknown>[] } | undefined;
        const row: Record<string, unknown> = { ...data, id, status: 'CONFIRMED', items: nested?.create ?? [], customer: null };
        rig.rows.set(id, row);
        rig.created.push(row);
        rig.h.docs.invoices.set(id, {
          id, tenantId: String(data.tenantId), zatcaPhase: 2, einvoiceStatus: (data.einvoiceStatus as string) ?? null,
          einvoiceQr: (data.einvoiceQr as string) ?? null, einvoiceWarnings: null, einvoiceSubmittedAt: null,
        });
        return row;
      },
      update: async ({ where }: { where: { id: string } }) => rig.rows.get(where.id) ?? null,
    },
    notification: { create: async () => ({ id: 'n' }) },
  };
}

function lotHooks(rig: Rig, o: {
  enabled?: boolean; pre?: LotError | null; inTx?: (plan: InvoiceLotPlan) => InvoiceLotAllocation;
  /** اللقطة القائمة لبنود البيع (linkedReturnExpiry في الإنتاج) — غيابها = خطّافٌ بلا linkedStamps */
  stamps?: ReadonlyMap<string, ItemExpiryStamp>;
} = {}): Phase2LotHooks {
  return {
    enabled: async () => { rig.log.push('lots.enabled'); return o.enabled !== false; },
    day: async () => { rig.log.push('lots.day'); return DAY; },
    precheck: async plan => { rig.log.push('lots.precheck'); rig.prechecked.push(plan); return o.pre ?? null; },
    allocateInTx: async (_tx, plan) => {
      rig.log.push('lots.allocateInTx');
      rig.plans.push(plan);
      return o.inTx ? o.inTx(plan) : { tracked: new Set(plan.lines.map(l => l.productId)), lines: new Map(), warnings: [] };
    },
    ...(o.stamps ? {
      linkedStamps: async (tenantId: string, saleItemIds: readonly string[], at: Date) => {
        rig.log.push('lots.linkedStamps');
        rig.stampCalls.push([tenantId, [...saleItemIds], at]);
        return new Map([...o.stamps!].filter(([k]) => saleItemIds.includes(k)));
      },
    } : {}),
  };
}

function buildRig(lots: ((rig: Rig) => Phase2LotHooks) | null): { rig: Rig; deps: NoteIssuanceDeps } {
  const h = createSubmitHarness();
  const rig: Rig = { h, log: [], rows: new Map(), created: [], ledger: [], plans: [], prechecked: [], twins: new Set(), stampCalls: [] };
  const u = h.units.units.get(h.unitId);
  const db = {
    zatcaEgsUnit: {
      findMany: async (args: { where?: { environment?: string } }) => (args.where?.environment === 'production'
        ? [{ id: h.unitId, tenantId: Z5_TENANT, environment: u?.environment, status: u?.status, keyVersion: u?.keyVersion, vatNumber: u?.vatNumber, certNotAfter: new Date('2031-01-01T00:00:00Z'), lastIcv: 0, lastInvoiceHash: null }]
        : []),
    },
    tenant: { findUnique: async () => ({ zatcaPhase2Enabled: false }) },
    companySettings: { findUnique: async () => null },
    product: { findMany: async (args: { where?: { id?: { in?: string[] } } }) => PRODUCT_ROWS.filter(p => (args.where?.id?.in ?? []).includes(p.id)) },
    invoice: {
      findFirst: async ({ where }: { where: { id: string } }) => rig.rows.get(where.id) ?? null,
      findMany: async () => [],
      findUnique: async ({ where }: { where: { tenantId_clientRef: { tenantId: string; clientRef: string } } }) => {
        rig.log.push('db.invoice.findUnique');
        const k = where.tenantId_clientRef;
        return k.tenantId === Z5_TENANT && rig.twins.has(k.clientRef) ? { id: `twin-${k.clientRef}` } : null;
      },
    },
  };
  // openIssuanceSigning يقرأ الوحدة (loadUnit) — به يُعرف موضع التوقيع في السجلّ
  const units = new Proxy(h.units, {
    get: (t, k, r) => {
      const v = Reflect.get(t, k, r);
      if (k === 'loadUnit' && typeof v === 'function') return (...a: unknown[]) => { rig.log.push('sign'); return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
  const deps: NoteIssuanceDeps = {
    db: db as unknown as NoteIssuanceDeps['db'],
    units: units as unknown as NoteIssuanceDeps['units'],
    documents: {
      insertSigned: (_tx, doc) => { rig.log.push('documents.insertSigned'); return h.docs.insertSigned(null, doc); },
      advanceUnitChain: (_tx, a) => h.docs.advanceUnitChain(null, a),
      loadProjection: (tenantId, invoiceId) => h.docs.loadProjection(tenantId, invoiceId),
    },
    chain: {
      lockChainHead: (_tx, unitId) => { rig.log.push('chain.lockChainHead'); return h.chain.lockChainHead(null, unitId); },
      nextNumberInTx: async (_tx, _tenantId, prefix) => `${prefix}${String(rig.created.length + 1).padStart(6, '0')}`,
    },
    keyring: () => h.keyring,
    ledger: {
      postCashInvoice: async () => { rig.log.push('ledger.cash'); rig.ledger.push('CASH'); },
      postCreditInvoice: async () => { rig.log.push('ledger.credit'); rig.ledger.push('CREDIT'); },
      creditLimitNotice: async () => { /* لا حدّ */ },
      postReturn: async () => { rig.log.push('ledger.return'); rig.ledger.push('RETURN'); },
      postDebitNote: async () => { rig.log.push('ledger.debit'); rig.ledger.push('DEBIT'); },
    },
    transaction: <T>(fn: (tx: Phase2Tx) => Promise<T>): Promise<T> => fn(txAdapter(rig) as unknown as Phase2Tx),
    publish: () => { /* لا بثّ */ },
    now: () => h.clock.now(),
    env: {} as NodeJS.ProcessEnv,
    mutex: null,
    ...(lots ? { lots: lots(rig) } : {}),
  };
  return { rig, deps };
}

const before = (log: readonly string[], a: string, b: string): boolean => log.indexOf(a) >= 0 && log.indexOf(b) >= 0 && log.indexOf(a) < log.indexOf(b);

// ═══ الفاتورة (فرع POST /invoices) ═══

const SALE_REQ = REQ_SIMPLIFIED_Z1; // نقدية مبسّطة لفرد: 201 بلا انتظار اعتماد
const SALE_ENGINE = engineOf(SALE_REQ);

function saleCtx(lots: InvoiceLotPlan | null): Phase2IssuanceContext {
  const calc = SALE_ENGINE as unknown as { items: { discountPct: number; discountAmt: number; taxPct: number; taxAmt: number; lineTotal: number }[] };
  const items: Phase2LegacyItem[] = SALE_REQ.items.map((it, idx) => ({
    productId: it.productId, qty: it.qty, unitPrice: it.unitPrice,
    discountPct: calc.items[idx].discountPct, discountAmt: calc.items[idx].discountAmt, taxPct: calc.items[idx].taxPct,
    taxAmt: calc.items[idx].taxAmt, lineTotal: calc.items[idx].lineTotal, unitName: null, unitFactor: 1, unitCode: null,
  }));
  return {
    tenantId: Z5_TENANT, caps: { caps: 'zatca2' },
    body: {
      type: 'CASH', paymentPlan: null, pricesIncludeTax: SALE_REQ.pricesIncludeTax, discountPct: 0,
      items: SALE_REQ.items.map(i => ({ productId: i.productId, qty: i.qty, unitPrice: i.unitPrice, discountPct: i.discountPct ?? 0, taxPct: i.taxPct ?? null })),
    },
    customerId: 'c-walkin', customer: CUSTOMERS.individual, customerName: 'عميل', customerBalance: 0, customerCreditLimit: 0,
    salesRepId: 'rep-1', companyVat: COMPANY_VAT, engine: SALE_ENGINE, items, installments: [], signatureImages: null, creditCheck: false,
    ...(lots ? { lots } : {}),
  };
}

const SALE_PLAN: InvoiceLotPlan = {
  tenantId: Z5_TENANT, customerId: 'c-walkin', vanKey: 'rep-1', docType: 'CASH', link: 'NONE', actor: 'REP',
  replay: null, day: DAY, returnDay: null, allowUnknown: true, clientRef: null,
  lines: [{ idx: 0, productId: 'p-water', productName: 'مياه', qty: 2, unitFactor: 1 }],
  fallbackStamps: new Map(),
};

const SALE_ALLOC = (): InvoiceLotAllocation => ({
  tracked: new Set(['p-water']),
  lines: new Map([[0, {
    rows: [{ lotId: 'lot-A', qty: 2, certainty: 'CONFIRMED', flags: [], expiryDate: '2027-01-31' }],
    stamp: { expiresAt: new Date('2027-01-31T00:00:00.000Z'), returnExpired: null, expirySaleInvoiceId: null },
  }]]),
  warnings: [{ code: 'LOT_MULTI_IN_VAN', productId: 'p-water' }],
});

test('الفرع: الفحص المسبق قبل التوقيع، والتوزيع بعد قفل السلسلة وقبل إدراج الصفّ وقبل قيود العميل (afterDocument)', async () => {
  const { rig, deps } = buildRig(r => lotHooks(r, { inTx: SALE_ALLOC }));
  const r = await issuePhase2Invoice(saleCtx(SALE_PLAN), deps);
  assert.ok(r, 'الفرع أعاد null لشركة حيّة');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const log = rig.log;
  assert.ok(before(log, 'lots.precheck', 'sign'), `الفحص المسبق بعد التوقيع: ${log.join(' → ')}`);
  assert.ok(before(log, 'chain.lockChainHead', 'lots.allocateInTx'), 'التوزيع قبل قفل السلسلة');
  assert.ok(before(log, 'lots.allocateInTx', 'tx.invoice.create'), 'التوزيع بعد إدراج الصفّ');
  assert.ok(before(log, 'tx.invoice.create', 'ledger.cash'), 'قيود العميل قبل الصفّ');
  assert.ok(before(log, 'lots.allocateInTx', 'documents.insertSigned'), 'التوزيع بعد إدراج المستند');
  assert.equal(log.filter(x => x === 'lots.enabled').length, 0, 'الفاتورة تقرأ العلم ثانيةً — الخطة من المسار القديم');
  assert.deepEqual(rig.prechecked, [SALE_PLAN]);
  assert.deepEqual(rig.plans, [SALE_PLAN], 'الخطة الممرَّرة للمعاملة ليست خطة السياق');
});

test('الفرع: صفوف التوزيع متداخلة في البند بمعرّفٍ مولَّد مسبقاً وسيارة الخطة، والختم يغلب، والتحذير في الردّ', async () => {
  const { rig, deps } = buildRig(r => lotHooks(r, { inTx: SALE_ALLOC }));
  const r = await issuePhase2Invoice(saleCtx(SALE_PLAN), deps);
  assert.equal(r?.status, 201);
  const row = rig.created[0];
  assert.equal(typeof row.id, 'string');
  assert.match(String(row.id), /^[0-9a-f-]{36}$/, 'المعرّف لم يُولَّد مسبقاً');
  const items = row.items as Record<string, unknown>[];
  const lots = (items[0].lots as { create: Record<string, unknown>[] }).create;
  assert.equal(lots.length, 1);
  assert.deepEqual(
    { invoiceId: lots[0].invoiceId, tenantId: lots[0].tenantId, productId: lots[0].productId, vanKey: lots[0].vanKey, lotId: lots[0].lotId, quantity: lots[0].quantity, certainty: lots[0].certainty },
    { invoiceId: row.id, tenantId: Z5_TENANT, productId: 'p-water', vanKey: 'rep-1', lotId: 'lot-A', quantity: 2, certainty: 'CONFIRMED' },
  );
  assert.equal((items[0].expiresAt as Date).toISOString().slice(0, 10), '2027-01-31', 'ختم الصلاحية من التشغيلة لم يُكتب');
  assert.equal(items[1].lots, undefined, 'بندٌ بلا توزيع حمل صفوفاً');
  // أعمدة المرحلة الثانية محفوظة فوق القديمة (seq ورمز الوحدة)
  assert.equal(items[0].seq, 1);
  assert.deepEqual((r!.body.warnings as LotWarning[]).map(w => w.code), ['LOT_MULTI_IN_VAN']);
  assert.equal(((r!.body.data as Record<string, unknown>).einvoice as Record<string, unknown>).phase, 2);
});

test('الفرع: رفض الفحص المسبق يُرمى برمزه ولا توقيع ولا معاملة ولا ICV', async () => {
  const refusal = new LotError('LOT_STOCK_INSUFFICIENT', 'الكمية أكبر من المتاح', 409, { productId: 'p-water' });
  const { rig, deps } = buildRig(r => lotHooks(r, { pre: refusal }));
  await assert.rejects(issuePhase2Invoice(saleCtx(SALE_PLAN), deps), (e: unknown) => e === refusal);
  assert.ok(!rig.log.includes('sign'), 'وُقّع ما سيُرفض حتماً');
  assert.ok(!rig.log.includes('chain.lockChainHead'), 'فُتحت معاملة الإصدار');
  assert.equal(rig.h.docs.documents.size, 0, 'استُهلك ICV');
  assert.equal(rig.created.length, 0);
});

test('الفرع: رفض التوزيع داخل المعاملة يُلغيها قبل إدراج الصفّ والمستند والقيود', async () => {
  const refusal = new LotError('LOT_BLOCKED', 'التشغيلة موقوفة', 422);
  const { rig, deps } = buildRig(r => lotHooks(r, { inTx: () => { throw refusal; } }));
  await assert.rejects(issuePhase2Invoice(saleCtx(SALE_PLAN), deps), (e: unknown) => e === refusal);
  assert.equal(rig.created.length, 0, 'أُدرج صفّ الفاتورة رغم الرفض');
  assert.ok(!rig.log.includes('documents.insertSigned'), 'أُدرج المستند رغم الرفض');
  assert.equal(rig.ledger.length, 0, 'قُيّدت الفاتورة رغم الرفض');
});

test('الفرع: بلا خطة في السياق أو بلا خطّاف ⇒ سلوك الفرع القائم حرفاً (لا معرّف مسبق ولا صفوف ولا تحذيرات)', async () => {
  for (const [lots, plan] of [[true, null], [false, SALE_PLAN]] as const) {
    const { rig, deps } = buildRig(lots ? r => lotHooks(r, { inTx: SALE_ALLOC }) : null);
    const r = await issuePhase2Invoice(saleCtx(plan), deps);
    assert.equal(r?.status, 201, JSON.stringify(r?.body));
    assert.ok(!rig.log.some(x => x.startsWith('lots.')), `خطّاف اللوط نودي: ${rig.log.join(' → ')}`);
    const row = rig.created[0];
    assert.ok(String(row.id).startsWith('row-'), 'معرّفٌ مولَّد مسبقاً بلا توزيع');
    assert.ok((row.items as Record<string, unknown>[]).every(i => !('lots' in i) && !('expiresAt' in i)));
    assert.equal('warnings' in r!.body, false);
  }
});

test('withLotWarnings: لا تحذيرات ⇒ الردّ نفسه حرفاً', () => {
  const r = { status: 201, body: { success: true, data: { id: 'x' } } };
  assert.equal(withLotWarnings(r, []), r);
  assert.deepEqual(withLotWarnings(r, [{ code: 'LOT_FROM_UNKNOWN', productId: 'p' }]).body.warnings, [{ code: 'LOT_FROM_UNKNOWN', productId: 'p' }]);
});

// ═══ الإشعار الدائن والمدين ═══

/** أصلٌ نقديّ مبسّط (01 لا يلزم) — الإشعار 201 بلا انتظار اعتماد */
function cashOriginal(tracked: ReadonlySet<string>, rig: Rig, over: Partial<Parameters<typeof originalInvoice>[0]> = {}): NoteOriginalInvoice {
  const o = originalInvoice({ request: REQ_SIMPLIFIED_Z1, subtype: '02', einvoiceStatus: 'reported', customerId: 'c-walkin', ...over });
  rig.rows.set(o.id, dbRow(o, tracked));
  return o;
}

const creditCtx = (o: NoteOriginalInvoice, over: Record<string, unknown> = {}) => ({
  tenantId: Z5_TENANT, caps: { caps: 'zatca2' }, originalInvoiceId: o.id, customer: CUSTOMERS.individual,
  salesRepId: 'rep-9', reason: 'إرجاع بضاعة من العميل', lines: [{ invoiceItemId: 'it-1', qty: 1 }], clientRef: 'cr-1', ...over,
});

test('الإشعار الدائن: يرث من الأصل المقفل (CREDITED، بند الأصل) بسيارة مندوب الإشعار ويوم الخادم، والتوزيع بعد القفل وقبل الإدراج', async () => {
  const { rig, deps } = buildRig(r => lotHooks(r, {
    inTx: plan => ({
      tracked: new Set(['p-water']),
      lines: new Map([[0, { rows: [{ lotId: 'lot-A', qty: plan.lines[0].qty, certainty: 'CONFIRMED', flags: [], expiryDate: '2027-01-31', sourceItemLotId: 'sl-1' }], stamp: null }]]),
      warnings: [],
    }),
  }));
  const o = cashOriginal(new Set(['p-water']), rig);
  const r = await issueCreditNote(creditCtx(o) as never, deps);
  assert.equal(r?.status, 201, JSON.stringify(r?.body));
  const log = rig.log;
  assert.ok(before(log, 'lots.enabled', 'lots.precheck') && before(log, 'lots.day', 'lots.precheck'));
  assert.ok(before(log, 'lots.precheck', 'sign'), `الفحص المسبق بعد التوقيع: ${log.join(' → ')}`);
  assert.ok(before(log, 'tx.invoice.findFirst', 'lots.allocateInTx'), 'التوزيع قبل قفل الأصل');
  assert.ok(before(log, 'tx.invoice.findMany', 'lots.allocateInTx'), 'التوزيع قبل قراءة الإشعارات السابقة تحت القفل');
  assert.ok(before(log, 'lots.allocateInTx', 'tx.invoice.create'));
  assert.ok(before(log, 'tx.invoice.create', 'ledger.return'));

  const plan = rig.plans[0];
  assert.equal(plan.link, 'CREDITED');
  assert.equal(plan.docType, 'RETURN');
  assert.equal(plan.vanKey, 'rep-9', 'السيارة ليست سيارة مندوب الإشعار');
  assert.equal(plan.replay, null);
  assert.equal(plan.day, DAY);
  assert.equal(plan.returnDay, DAY);
  assert.equal(plan.actor, 'ADMIN');
  assert.equal(plan.clientRef, 'cr-1');
  assert.deepEqual(plan.lines.map(l => ({ idx: l.idx, productId: l.productId, qty: l.qty, unitFactor: l.unitFactor, saleItemId: l.saleItemId })),
    [{ idx: 0, productId: 'p-water', qty: 1, unitFactor: 1, saleItemId: 'it-1' }]);
  assert.deepEqual(rig.prechecked[0], plan, 'خطة الفحص المسبق تخالف الحاكمة');

  const row = rig.created[0];
  assert.equal(row.salesRepId, 'rep-9');
  const lots = ((row.items as Record<string, unknown>[])[0].lots as { create: Record<string, unknown>[] }).create;
  assert.equal(lots[0].invoiceId, row.id);
  assert.equal(lots[0].vanKey, 'rep-9');
  assert.equal(lots[0].sourceItemLotId, 'sl-1');
  assert.equal(lots[0].quantity, 1);
});

test('الإشعار الدائن بلا مندوبٍ مُصدِر: السيارة سيارة مندوب الأصل (= salesRepId صفّه)', async () => {
  const { rig, deps } = buildRig(r => lotHooks(r));
  const o = cashOriginal(new Set(['p-water']), rig);
  const r = await issueCreditNote(creditCtx(o, { salesRepId: null, actor: { role: 'SALES_REP', canCreateInvoice: true } }) as never, deps);
  assert.equal(r?.status, 201, JSON.stringify(r?.body));
  assert.equal(rig.plans[0].vanKey, 'rep-1');
  assert.equal(rig.created[0].salesRepId, 'rep-1');
  assert.equal(rig.plans[0].actor, 'REP');
});

test('الإشعار الدائن على صنفٍ غير متتبَّع، أو والعلم مطفأ: لا خطة ولا توزيع — والعلم لا يُقرأ إلا لأصلٍ فيه صنف متتبَّع', async () => {
  {
    const { rig, deps } = buildRig(r => lotHooks(r));
    const o = cashOriginal(new Set(['p-juice']), rig); // المتتبَّع بندٌ لا يمسّه الإشعار
    const r = await issueCreditNote(creditCtx(o) as never, deps);
    assert.equal(r?.status, 201);
    assert.ok(!rig.log.some(x => x.startsWith('lots.')), `استعلام علم بلا صنف متتبَّع: ${rig.log.join(' → ')}`);
    assert.ok(String(rig.created[0].id).startsWith('row-'));
  }
  {
    const { rig, deps } = buildRig(r => lotHooks(r, { enabled: false }));
    const o = cashOriginal(new Set(['p-water']), rig);
    const r = await issueCreditNote(creditCtx(o) as never, deps);
    assert.equal(r?.status, 201);
    assert.deepEqual(rig.log.filter(x => x.startsWith('lots.')), ['lots.enabled'], 'العلم مطفأ ونودي غيره');
    assert.ok(((rig.created[0].items as Record<string, unknown>[])[0].lots) === undefined);
  }
});

test('الإشعار الدائن: رفض الفحص المسبق يُرمى ولا توقيع ولا مستند', async () => {
  const refusal = new LotError('LOT_QTY_INVALID', 'كميات التشغيلات', 422);
  const { rig, deps } = buildRig(r => lotHooks(r, { pre: refusal }));
  const o = cashOriginal(new Set(['p-water']), rig);
  await assert.rejects(issueCreditNote(creditCtx(o) as never, deps), (e: unknown) => e === refusal);
  assert.ok(!rig.log.includes('sign'));
  assert.equal(rig.h.docs.documents.size, 0);
  assert.equal(rig.created.length, 0);
});

test('D24: الإشعار القياسيّ «01» يُكتب بأعمدة الحجز (مرتجع، مرحلة ثانية، 01، مرآة قابلة للإبطال) فبضاعته محجوزة حتى اعتماده', async () => {
  const { rig, deps } = buildRig(r => lotHooks(r));
  const o = originalInvoice({ request: REQ_STANDARD_NO_HEAD_DISCOUNT, subtype: '01', einvoiceStatus: 'cleared' });
  rig.rows.set(o.id, dbRow(o, new Set(['p-rice'])));
  const r = await issueCreditNote({
    tenantId: Z5_TENANT, caps: { caps: 'zatca2' }, originalInvoiceId: o.id, customer: CUSTOMERS.b2bComplete,
    salesRepId: 'rep-9', reason: 'إرجاع بضاعة من العميل', lines: [{ invoiceItemId: 'it-1', qty: 2 }], clientRef: 'cr-01',
  }, deps);
  assert.equal(r?.status, 202, JSON.stringify(r?.body)); // بلا اعتماد حيّ: «بانتظار الاعتماد»
  assert.equal(rig.plans.length, 1, 'لم يُوزَّع الإشعار القياسي');
  const row = rig.created[0];
  assert.equal(row.type, 'RETURN');
  assert.equal(row.zatcaPhase, 2);
  assert.equal(row.invoiceSubtype, '01');
  const mirror = row.einvoiceStatus as string | null;
  assert.ok(mirror == null || (LOT_HOLD_MIRRORS as readonly string[]).includes(mirror), `مرآة غير محجوزة: ${mirror}`);
});

test('الإشعار المدين: بلا توزيع ولا علم ولا فحص — ولو حمل الأصل صنفاً متتبَّعاً', async () => {
  const { rig, deps } = buildRig(r => lotHooks(r));
  const o = cashOriginal(new Set(['p-water', 'p-juice']), rig);
  const r = await issueDebitNote({
    tenantId: Z5_TENANT, caps: { caps: 'zatca2' }, originalInvoiceId: o.id, customer: CUSTOMERS.individual, salesRepId: null,
    reason: 'فرق سعر على الفاتورة', lines: [{ description: 'فرق', qty: 1, unitPrice: 5, taxPct: 15 }], clientRef: 'cr-d',
  }, deps);
  assert.equal(r?.status, 201, JSON.stringify(r?.body));
  assert.ok(!rig.log.some(x => x.startsWith('lots.')), `خطّاف اللوط نودي للمدين: ${rig.log.join(' → ')}`);
  assert.ok((rig.created[0].items as Record<string, unknown>[]).every(i => i.productId === null && !('lots' in i)));
});

test('الإشعار الدائن بلا خطّاف: سلوك الوصل القائم حرفاً', async () => {
  const { rig, deps } = buildRig(null);
  const o = cashOriginal(new Set(['p-water']), rig);
  const r = await issueCreditNote(creditCtx(o) as never, deps);
  assert.equal(r?.status, 201, JSON.stringify(r?.body));
  assert.ok(String(rig.created[0].id).startsWith('row-'));
  assert.ok((rig.created[0].items as Record<string, unknown>[]).every(i => !('lots' in i)));
});

// ═══ الخطة (منطق صرف) ═══

test('creditNoteLotPlan: الكمية بالأساس من كمية البند ومعامل وحدة الإشعار (D22)، وبند الأصل، والبند بلا صنف يُتخطّى', () => {
  const line = (o: Record<string, unknown>) => ({ invoiceItemId: 'it-1', productId: 'p1', itemName: 'حليب', creditQty: 1, creditUnitFactor: 1, ...o });
  const plan = creditNoteLotPlan({
    lines: [line({ creditQty: 2, creditUnitFactor: 24 }), line({ invoiceItemId: 'it-2', productId: null }), line({ invoiceItemId: 'it-3', creditQty: 5, creditUnitFactor: 0 })] as never,
    engine: { items: [{ qty: 2 }, { qty: 1 }, { qty: 5 }] } as never,
  }, { tenantId: 't', customerId: 'c', vanKey: 'r', day: DAY, clientRef: null, actor: 'API_KEY' });
  assert.ok(plan);
  assert.deepEqual(plan.lines.map(l => [l.idx, l.qty, l.unitFactor, l.saleItemId]), [[0, 48, 24, 'it-1'], [2, 5, 1, 'it-3']]);
  assert.equal(plan.link, 'CREDITED');
  assert.equal(plan.fallbackStamps.size, 0);
  assert.equal(creditNoteLotPlan({ lines: [line({ productId: null })] as never, engine: { items: [{ qty: 1 }] } as never },
    { tenantId: 't', customerId: 'c', vanKey: null, day: DAY, clientRef: null, actor: 'ADMIN' }), null);
});

// ═══ مراجعة B6 ═══

const TWIN_REFUSALS = (): LotError[] => [
  new LotError('LOT_STOCK_INSUFFICIENT', 'الكمية أكبر من المتاح', 409, { productId: 'p-water' }),
  new LotError('LOT_REPLAY_HELD', 'بانتظار تسجيل التحميل الناقص', 409, { productId: 'p-water' }),
];

test('clientRef: رفض الفحص المسبق لطلبٍ التزم توأمه لا يُردّ — يمضي فيرمي التوزيع ClientRefRace (فرع P2002 ⇒ 200) والمعاملة تُلغى', async () => {
  for (const pre of TWIN_REFUSALS()) {
    const { rig, deps } = buildRig(r => lotHooks(r, { pre, inTx: () => { throw new ClientRefRace(); } }));
    rig.twins.add('cr-twin');
    await assert.rejects(issuePhase2Invoice(saleCtx({ ...SALE_PLAN, clientRef: 'cr-twin' }), deps),
      (e: unknown) => e instanceof ClientRefRace, `${pre.code}: رُدّ رفض الفحص المسبق (409 كاذب) لطلبٍ صدر توأمه`);
    assert.ok(before(rig.log, 'lots.precheck', 'db.invoice.findUnique'), `التوأم يُسأل عنه قبل الفحص: ${rig.log.join(' → ')}`);
    assert.ok(rig.log.includes('lots.allocateInTx'), 'لم يبلغ الطلب التوزيع داخل المعاملة');
    assert.equal(rig.created.length, 0);
    assert.ok(!rig.log.includes('documents.insertSigned'), 'أُدرج مستند');
  }
  // الإشعار الدائن بالقاعدة نفسها، والسباق يصل المسار P2002 لا LotError (lotReply لا يلتقطه)
  for (const pre of TWIN_REFUSALS()) {
    const { rig, deps } = buildRig(r => lotHooks(r, { pre, inTx: () => { throw new ClientRefRace(); } }));
    rig.twins.add('cr-1');
    const o = cashOriginal(new Set(['p-water']), rig);
    await assert.rejects(issueCreditNote(creditCtx(o) as never, deps), (e: unknown) => e instanceof ClientRefRace && lotHttpError(e) === null);
    assert.equal(rig.created.length, 0);
  }
});

test('clientRef: بلا توأم يُردّ الرفض برمزه بلا توقيع، والفحص الناجح لا يسأل عن التوأم (لا استعلام في المسار السعيد)', async () => {
  for (const pre of TWIN_REFUSALS()) {
    const { rig, deps } = buildRig(r => lotHooks(r, { pre }));
    await assert.rejects(issuePhase2Invoice(saleCtx({ ...SALE_PLAN, clientRef: 'cr-new' }), deps), (e: unknown) => e === pre);
    assert.ok(rig.log.includes('db.invoice.findUnique'));
    assert.ok(!rig.log.includes('sign'), 'وُقّع ما سيُرفض حتماً');
  }
  {
    const { rig, deps } = buildRig(r => lotHooks(r, { pre: TWIN_REFUSALS()[0] }));
    await assert.rejects(issuePhase2Invoice(saleCtx(SALE_PLAN), deps)); // بلا clientRef: لا توأم يُسأل عنه
    assert.ok(!rig.log.includes('db.invoice.findUnique'));
  }
  {
    const { rig, deps } = buildRig(r => lotHooks(r, { inTx: SALE_ALLOC }));
    const r = await issuePhase2Invoice(saleCtx({ ...SALE_PLAN, clientRef: 'cr-ok' }), deps);
    assert.equal(r?.status, 201, JSON.stringify(r?.body));
    assert.ok(!rig.log.includes('db.invoice.findUnique'), 'استعلام توأمٍ والفحص ناجح');
  }
});

test('D14: انتظار قفل اللوط داخل المعاملة (55P03، 40P01) ⇒ LotError LOT_BUSY 503 في الإشعار الدائن والفاتورة — وما عداه كما هو', async () => {
  const busyErrors = [
    Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    // شكل Prisma لاستعلامٍ خامٍ فشل: P2010 ورمز Postgres في meta
    Object.assign(new Error('Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`'), { code: 'P2010', meta: { code: '55P03' } }),
  ];
  const isBusy = (e: unknown) => e instanceof LotError && e.code === 'LOT_BUSY' && e.status === 503 && lotHttpError(e)?.status === 503;
  for (const busy of busyErrors) {
    {
      const { rig, deps } = buildRig(r => lotHooks(r, { inTx: () => { throw busy; } }));
      const o = cashOriginal(new Set(['p-water']), rig);
      // مسار POST /:id/credit-note لا يحوّل إلا LotError (lotReply(err, false)) — فالانتظار الخام كان 500
      await assert.rejects(issueCreditNote(creditCtx(o) as never, deps), isBusy, `الإشعار الدائن: ${busy.message}`);
      assert.equal(rig.created.length, 0);
    }
    {
      const { deps } = buildRig(r => lotHooks(r, { inTx: () => { throw busy; } }));
      await assert.rejects(issuePhase2Invoice(saleCtx(SALE_PLAN), deps), isBusy, `الفاتورة: ${busy.message}`);
    }
  }
  // خطأٌ آخر يمرّ كما هو (لا يُوسَم انشغالاً)
  const boom = new Error('boom');
  {
    const { rig, deps } = buildRig(r => lotHooks(r, { inTx: () => { throw boom; } }));
    const o = cashOriginal(new Set(['p-water']), rig);
    await assert.rejects(issueCreditNote(creditCtx(o) as never, deps), (e: unknown) => e === boom);
  }
  // ومهلة المعاملة P2028 تبقى ZATCA_UNIT_BUSY 503 كما كانت (issuanceHttpError)
  {
    const p2028 = Object.assign(new Error('Transaction already closed'), { code: 'P2028' });
    const { rig, deps } = buildRig(r => lotHooks(r, { inTx: () => { throw p2028; } }));
    const o = cashOriginal(new Set(['p-water']), rig);
    const r = await issueCreditNote(creditCtx(o) as never, deps);
    assert.equal(r?.status, 503);
    assert.equal(r?.body.code, 'ZATCA_UNIT_BUSY');
  }
});

const STAMP_IT1: ItemExpiryStamp = { expiresAt: new Date('2026-11-20T00:00:00.000Z'), returnExpired: true, expirySaleInvoiceId: 'inv-sale' };

test('D12: بندٌ ورث «غير معروف» وحده يُختم داخل المعاملة من اللقطة القائمة (linkedStamps بلحظة الخادم) لا بالختم اللاحق', async () => {
  const { rig, deps } = buildRig(r => lotHooks(r, {
    stamps: new Map([['it-1', STAMP_IT1], ['it-2', { ...STAMP_IT1, returnExpired: false }]]),
    // مرآة allocateLinkedReturn: صفوف البيع كلها بلا تشغيلة ⇒ stampFromRows = null ⇒ الختم fallbackStamps[idx]
    inTx: plan => ({
      tracked: new Set(['p-water']),
      lines: new Map(plan.lines.map(l => [l.idx, {
        rows: [{ lotId: null, qty: l.qty, certainty: 'UNKNOWN' as const, flags: [], expiryDate: null, sourceItemLotId: 'sl-u' }],
        stamp: plan.fallbackStamps.get(l.idx) ?? null,
      }])),
      warnings: [],
    }),
  }));
  const o = cashOriginal(new Set(['p-water']), rig);
  const r = await issueCreditNote(creditCtx(o) as never, deps);
  assert.equal(r?.status, 201, JSON.stringify(r?.body));
  // بنود الإشعار المتتبَّعة وحدها، بلحظة الخادم (يوم مرتجع الإشعار يوم الخادم، §٤.٩)، وقبل الفحص المسبق فخطّته هي الحاكمة
  assert.deepEqual(rig.stampCalls.map(([t, ids]) => [t, ids]), [[Z5_TENANT, ['it-1']]]);
  assert.equal(rig.stampCalls[0][2].getTime(), rig.h.clock.now().getTime());
  assert.ok(before(rig.log, 'lots.linkedStamps', 'lots.precheck'), rig.log.join(' → '));
  assert.deepEqual([...rig.plans[0].fallbackStamps], [[0, STAMP_IT1]], 'لا لقطة بفهرس بند الإشعار');
  assert.deepEqual(rig.prechecked[0], rig.plans[0]);
  const item = (rig.created[0].items as Record<string, unknown>[])[0];
  assert.equal(item.returnExpired, true, 'المنتهي دخل SELLABLE بلا ختم داخل المعاملة');
  assert.equal((item.expiresAt as Date).toISOString(), STAMP_IT1.expiresAt.toISOString());
  assert.equal(item.expirySaleInvoiceId, 'inv-sale');
});

test('creditNoteLotPlan: اللقطة القائمة بمفتاح بند الأصل تصير fallbackStamps بفهرس بند الإشعار الحاكم، وغيابها فارغة', () => {
  const line = (o: Record<string, unknown>) => ({ invoiceItemId: 'it-1', productId: 'p1', itemName: 'حليب', creditQty: 1, creditUnitFactor: 1, ...o });
  const stampB = { ...STAMP_IT1, expirySaleInvoiceId: 'inv-b' };
  // البنود المقفلة قد تخالف المعاينة (FULL بعد إشعارٍ سابق): المفتاح بند الأصل لا موضع المعاينة
  const plan = creditNoteLotPlan({
    lines: [line({ invoiceItemId: 'it-2' }), line({ invoiceItemId: 'it-9', productId: null }), line({ invoiceItemId: 'it-1' })] as never,
    engine: { items: [{ qty: 1 }, { qty: 1 }, { qty: 1 }] } as never,
  }, { tenantId: 't', customerId: 'c', vanKey: 'r', day: DAY, clientRef: null, actor: 'ADMIN', stamps: new Map([['it-1', STAMP_IT1], ['it-2', stampB], ['it-9', STAMP_IT1]]) });
  assert.ok(plan);
  assert.deepEqual([...plan.fallbackStamps].sort((a, b) => a[0] - b[0]), [[0, stampB], [2, STAMP_IT1]]);
});

test('R6: إشعارٌ دائن من صندوق المندوب (X-FS-Replay + clientRef + لحظة الجهاز) خطته إعادة — ويومه يوم الخادم (§٤.٩)', async () => {
  const replayCtx = (o: NoteOriginalInvoice, over: Record<string, unknown> = {}) => creditCtx(o, {
    caps: { caps: 'zatca2', replay: '1' }, clientCreatedAt: '2026-11-30T08:00:00.000Z',
    actor: { role: 'SALES_REP', canCreateInvoice: true }, ...over,
  });
  {
    const { rig, deps } = buildRig(r => lotHooks(r));
    const o = cashOriginal(new Set(['p-water']), rig);
    const r = await issueCreditNote(replayCtx(o) as never, deps);
    assert.equal(r?.status, 201, JSON.stringify(r?.body));
    const plan = rig.plans[0];
    assert.ok(plan.replay, 'إعادة الصندوق عوملت طلباً حيّاً فتُرفض بالكسور ويُعدمها الصندوق');
    assert.equal(plan.day, DAY);
    assert.equal(plan.returnDay, DAY);
    assert.deepEqual(rig.prechecked[0], plan);
  }
  // الإدارة لا تنال الإعادة (D23)، وبلا ترويسة طلبٌ حيّ، وبلا لحظة جهازٍ صالحة لا إعادة
  for (const over of [{ actor: { role: 'ADMIN' } }, { caps: { caps: 'zatca2' } }, { clientCreatedAt: 'not-a-date' }]) {
    const { rig, deps } = buildRig(r => lotHooks(r));
    const o = cashOriginal(new Set(['p-water']), rig);
    const r = await issueCreditNote(replayCtx(o, over) as never, deps);
    assert.equal(r?.status, 201, JSON.stringify(r?.body));
    assert.equal(rig.plans[0].replay, null, JSON.stringify(over));
  }
});

test('R6 على خدمة B5 نفسها: كمية أساسٍ بأكثر من أربع خانات تُرفض حيّةً (LOT_QTY_INVALID) وتمرّ إعادةً', async () => {
  const note = {
    lines: [{ invoiceItemId: 'it-1', productId: 'p1', itemName: 'حليب', creditQty: 0.123456, creditUnitFactor: 1 }],
    engine: { items: [{ qty: 0.123456 }] },
  } as never;
  const at = { tenantId: 't', customerId: 'c', vanKey: 'r', day: DAY, clientRef: 'cr', actor: 'REP' as const };
  const fakeDb = {
    product: { findMany: async () => [{ id: 'p1' }] },
    invoiceItemLot: { findMany: async () => [] },
    invoiceItem: { findMany: async () => [] },
  };
  const live = creditNoteLotPlan(note, at);
  assert.ok(live);
  assert.equal((await precheckInvoiceLots(fakeDb as never, live))?.code, 'LOT_QTY_INVALID');
  const replay = creditNoteLotPlan(note, { ...at, replay: { at: new Date('2026-12-01T08:00:00.000Z'), clamped: false } });
  assert.ok(replay);
  assert.equal(await precheckInvoiceLots(fakeDb as never, replay), null);
  assert.equal(replay.day, DAY);
});

// ═══ D25 في فرع المرحلة الثانية بلا خطة (البوابة B-d25-guards) ═══
// الخطة تُبنى من القراءة المسبقة وحدها: صنفٌ صار متتبَّعاً بين القراءة وقفل الأصناف داخل المعاملة كان يُصدر مستنداً موقَّعاً بلا صفوف
// توزيع (يُنقص غير المسمّى بلا فحص، I2). الحارس من صفوف lockProductBases المقفلة نفسها قبل إدراج الصفّ — فلا مستند ولا ICV.

/** معاملةٌ بـ$queryRaw: صفوف الأصناف المقفلة FOR KEY SHARE كما «يراها» القفل، وعلم الشركة لحظتها */
function lockedRowsTx(rig: Rig, deps: NoteIssuanceDeps, tracked: ReadonlySet<string>, tenantOnNow: boolean): string[] {
  const sqls: string[] = [];
  deps.transaction = <T>(fn: (tx: Phase2Tx) => Promise<T>): Promise<T> => fn({
    ...txAdapter(rig),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      sqls.push(sql);
      if (sql.includes('FROM products') && sql.includes('FOR KEY SHARE')) {
        rig.log.push('tx.lockProducts');
        const ids = (values.find(Array.isArray) ?? []) as string[];
        return ids.map(id => ({ id, unit: 'حبة', lotTracked: tracked.has(id) }));
      }
      if (sql.includes('FROM tenants')) { rig.log.push('tx.tenantFlag'); return [{ lotTrackingEnabled: tenantOnNow }]; }
      return [];
    },
  } as unknown as Phase2Tx);
  return sqls;
}

const isTrackingChanged = (ids: string[]) => (e: unknown) => e instanceof LotError && e.code === 'LOT_BUSY'
  && lotHttpError(e)?.status === 503 && (e.detail as { reason?: string; productIds?: string[] })?.reason === 'TRACKING_CHANGED'
  && JSON.stringify((e.detail as { productIds?: string[] }).productIds) === JSON.stringify(ids);

test('D25 (المرحلة الثانية): صنفٌ صار متتبَّعاً بين القراءة المسبقة والقفل والميزة مفعّلة ⇒ 503 LOT_BUSY TRACKING_CHANGED قبل إدراج الصفّ والمستند والقيود', async () => {
  for (const hooks of [true, false]) {
    const { rig, deps } = buildRig(hooks ? r => lotHooks(r, { inTx: SALE_ALLOC }) : null);
    lockedRowsTx(rig, deps, new Set(['p-water']), true);
    await assert.rejects(issuePhase2Invoice({ ...saleCtx(null), lotsOn: true }, deps), isTrackingChanged(['p-water']));
    assert.equal(rig.created.length, 0, 'أُدرج صفّ فاتورةٍ بلا توزيع لصنفٍ متتبَّع');
    assert.ok(!rig.log.includes('documents.insertSigned'), 'أُدرج المستند (ICV) رغم الرفض');
    assert.equal(rig.h.docs.documents.size, 0, 'استُهلك ICV');
    assert.equal(rig.ledger.length, 0);
    assert.ok(!rig.log.includes('tx.tenantFlag'), 'العلم مفعّلٌ في القراءة المسبقة: لا قراءة ثانية له');
    assert.ok(!rig.log.some(x => x.startsWith('lots.')), 'لا خطة ⇒ لا خطّاف لوط');
  }
});

test('D25 (المرحلة الثانية): علم الشركة مطفأٌ في القراءة المسبقة ثم فُعّل — يُعاد قراءته تحت القفل حين يكون صفٌّ مقفل متتبَّعاً وحده', async () => {
  // فُعّل بين القراءتين ⇒ الرفض نفسه
  {
    const { rig, deps } = buildRig(r => lotHooks(r, { inTx: SALE_ALLOC }));
    lockedRowsTx(rig, deps, new Set(['p-juice']), true);
    await assert.rejects(issuePhase2Invoice(saleCtx(null), deps), isTrackingChanged(['p-juice']));
    assert.ok(before(rig.log, 'tx.lockProducts', 'tx.tenantFlag'), `قراءة العلم قبل قفل الأصناف: ${rig.log.join(' → ')}`);
    assert.equal(rig.created.length, 0);
    assert.equal(rig.h.docs.documents.size, 0, 'استُهلك ICV');
  }
  // ما زال مطفأً (علم صنفٍ باقٍ من حقبةٍ سابقة) ⇒ يُصدر كما كان بلا صفوف، بقراءةٍ واحدة للعلم
  {
    const { rig, deps } = buildRig(r => lotHooks(r, { inTx: SALE_ALLOC }));
    lockedRowsTx(rig, deps, new Set(['p-juice']), false);
    const r = await issuePhase2Invoice(saleCtx(null), deps);
    assert.equal(r?.status, 201, JSON.stringify(r?.body));
    assert.equal(rig.log.filter(x => x === 'tx.tenantFlag').length, 1);
    assert.ok((rig.created[0].items as Record<string, unknown>[]).every(i => !('lots' in i)));
  }
});

test('D25 (المرحلة الثانية) §١٠.١: لا صفّ مقفل متتبَّع ⇒ الفرع كما كان — القفل نفسه بلا قراءة للعلم ولا رفض، مطفأةً أو مفعّلة', async () => {
  for (const lotsOn of [false, true]) {
    const { rig, deps } = buildRig(null);
    const sqls = lockedRowsTx(rig, deps, new Set(), true);
    const r = await issuePhase2Invoice({ ...saleCtx(null), ...(lotsOn && { lotsOn }) }, deps);
    assert.equal(r?.status, 201, JSON.stringify(r?.body));
    assert.equal(rig.created.length, 1);
    assert.deepEqual(sqls.filter(s => s.includes('FROM')).map(s => s.split(' WHERE')[0]), ['SELECT id, unit, "lotTracked" FROM products'], 'استعلامٌ واحد: قفل الأصناف القائم');
    assert.ok(!rig.log.includes('tx.tenantFlag'));
  }
});
