// «ربط الدفاتر» L6 — قيود المشتريات والمخزون وتكلفة المبيعات (الخطة §1 D/E وB5/B8/B11/B12، §3 L6): أمثلة الخطة المحلولة
// بالأرقام من محرّك التكلفة الحقيقي (services/costing replay) إلى الـbuilders، وحالات الحدّ الجوهرية، وحارس GRNI، والبوابة
// في المُرحِّل (لا ترحيل قبل اللقطة) ومعزل غير المربوطة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../services/costing/stepper';
import { parseCostKey, returnKey, saleCancelKey, saleOutKey, vanItemKey, whItemKey } from '../services/costing/keys';
import type { LocationKey, Move, MoveKind, MoveLinks, StepOutput } from '../services/costing/types';
import { buildStockMove, type CostSnapshotInput } from '../services/gl/builders/stock';
import { buildCogsMove } from '../services/gl/builders/cogs';
import { buildReceiptStockMove, buildSupplierEntryMove } from '../services/gl/builders/purchase';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { accountIdOf, taxIdOf, templateContextInput } from '../services/gl/testing/fixtures';
import { collectMoveIssues, resolveLineAccount, validateMove } from '../services/gl/validate';
import {
  createBuildContext, isNoMove,
  type BuildContext, type BuildResult, type GlSettingsSnapshot, type MoveDraft,
} from '../services/gl/types';
import type { SupplierEntryEventPayload } from '../services/gl/sync/types';
import { deriveAccountEntryEvents, deriveSupplierEntryEvents, deriveWarehouseEntryEvents, type DeriveContext } from '../services/gl/sync/desired';
import { parseSourceKey, supplierEntryKey, invoiceCogsRevKey } from '../services/gl/sync/keys';
import { FakePostingStore } from './gl-fake-posting-store';
import { postSourceEvent } from '../services/gl/sync/poster';
import type { CostSnapshotRecord } from '../services/gl/sync/postingStore';
import type { SourceEventRecord } from '../services/gl/sync/types';

// ═══ أدوات ═══

const ARABIC = /[؀-ۿ]/;
const T0 = Date.UTC(2027, 1, 1, 8, 0, 0);
const at = (n: number): Date => new Date(T0 + n * 60_000);

function ctxOf(settings: Partial<GlSettingsSnapshot> = {}, linked = true): BuildContext {
  const input = templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, {
    settings: { ...(linked ? { linkedPosting: true as const } : {}), inventoryMode: 'PERPETUAL', ...settings },
    extraAccounts: [...linkedAccountRefs(accountIdOf)],
  });
  return createBuildContext(input);
}

const CTX = ctxOf();

interface MvIn { n: number; kind: MoveKind; key: string; location: LocationKey; baseQty: number; toLocation?: LocationKey; inValueMilli?: bigint; links?: MoveLinks; memoQty?: number; refId?: string }

function mv(i: MvIn): Move {
  const p = parseCostKey(i.key)!;
  return {
    key: i.key, kind: i.kind, effectAt: at(i.n), cursor: { createdAt: at(i.n), id: `src${String(i.n).padStart(4, '0')}` },
    productId: 'A', location: i.location, toLocation: i.toLocation ?? null, baseQty: i.baseQty, memoQty: i.memoQty ?? null,
    inValueMilli: i.inValueMilli ?? null, links: i.links ?? null, reason: null,
    refType: p.refType, refId: i.refId ?? `ref-${i.n}`, itemId: p.itemId,
  };
}

const snap = (o: StepOutput): CostSnapshotInput => ({
  sourceKey: o.key, kind: o.kind, itemId: o.itemId, productId: o.productId, location: o.location, toLocation: o.toLocation ?? null,
  baseQty: o.baseQty, valueMilli: o.valueMilli, varianceMilli: o.varianceMilli, memoMilli: o.memoMilli,
});

/** قيد صالح: متوازن بالملّي، عربي، ويُرجع رصيد كل (رمز[|شريك]) موقّعاً (مدين +) */
function lines(r: BuildResult, ctx: BuildContext = CTX): Map<string, bigint> {
  assert.ok(!isNoMove(r), `المتوقع قيد لا NO_MOVE (${isNoMove(r) ? r.note : ''})`);
  const m = r as MoveDraft;
  const v = validateMove(m, ctx);
  assert.equal(v.totalDebitMilli, v.totalCreditMilli, 'قيد متوازن بالملّي');
  assert.match(m.narration, ARABIC);
  const out = new Map<string, bigint>();
  for (const l of m.lines) {
    assert.match(l.label, ARABIC, 'label عربي');
    const acc = resolveLineAccount(l, ctx.accounts)!;
    const partner = l.vendorId ?? l.salesRepId ?? null;
    const key = partner ? `${acc.code}|${partner}` : acc.code;
    out.set(key, (out.get(key) ?? 0n) + l.debitMilli - l.creditMilli);
  }
  return out;
}

const S = (n: number): bigint => BigInt(Math.round(n * 1000)); // ريال ⇒ ملّي

// ═══ أمثلة الخطة: الاستلام والفاتورة والمرتجع (100 كرتون @ 20، ضريبة 15٪) ═══

test('L6 مثال الخطة: استلام 100 كرتون ⇒ مد 114001 2000 / دا 211002، والفاتورة ⇒ مد 211002 2000 + مد 116001 300 / دا 211001 2300', () => {
  const rr = replay([mv({ n: 1, kind: 'RECEIVE', key: whItemKey('wi1'), location: 'WH', baseQty: 100, inValueMilli: S(2000), refId: 'we1' })], { currencyDecimals: 2 });
  const snaps = rr.outputs.map(snap);
  const stock = lines(buildReceiptStockMove({
    sourceId: 'we1', sourceKey: 'WH_ENTRY:we1', date: '2027-02-01', narration: 'استلام بضاعة في المستودع', snapshots: snaps,
  }, CTX));
  assert.deepEqual([...stock], [['114001', S(2000)], ['211002', -S(2000)]]);

  const bill: SupplierEntryEventPayload = {
    entryId: 'sl1', kind: 'BILL', vendorId: 'v1', vendorName: 'مورّد العصائر', amountMilli: String(S(2300)), netMilli: String(S(2000)),
    taxMilli: String(S(300)), entryDate: '2027-02-01', dueDate: '2027-03-03', ref: 'F-77', note: null, reversesId: null,
    warehouseEntry: { id: 'we1', type: 'RECEIVE', vatTreatment: 'RECOVERABLE', paidAccountRef: null, costRef: { at: at(1).toISOString(), id: 'we1' }, expectedItemIds: ['wi1'] },
    payment: null,
  };
  const r = buildSupplierEntryMove({ payload: bill, sourceKey: supplierEntryKey('sl1'), date: '2027-02-01', snapshots: snaps }, CTX);
  const b = lines(r);
  assert.deepEqual([...b].sort(), [['116001', S(300)], ['211001|v1', -S(2300)], ['211002', S(2000)]]);
  const m = r as MoveDraft;
  const vat = m.lines.find((l) => l.taxRole === 'TAX')!;
  assert.equal(vat.taxId, taxIdOf('S15_PURCH'));
  assert.equal(vat.vatBox, 'SA_7');
  assert.equal(vat.taxBaseMilli, S(2000));
  assert.equal(m.lines.find((l) => l.vendorId === 'v1')!.dueDate, '2027-03-03', 'الاستحقاق على سطر الذمة');
  assert.equal(m.journalSystemKey, 'PURCHASES');
  assert.equal(m.needsAttention, false);
  // GRNI يُقفل: مجموع 211002 في القيدين صفر
  assert.equal((stock.get('211002') ?? 0n) + (b.get('211002') ?? 0n), 0n);
});

test('L6 مثال الخطة: مرتجع 10 كراتين ⇒ مد 211001 230 / دا 114001 200 / دا 116001 30', () => {
  const rr = replay([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('wi1'), location: 'WH', baseQty: 100, inValueMilli: S(2000), refId: 'we1' }),
    mv({ n: 2, kind: 'VENDOR_RETURN', key: whItemKey('wr1'), location: 'WH', baseQty: -10, refId: 'we2' }),
  ], { currencyDecimals: 2 });
  const ret = rr.outputs.filter((o) => o.kind === 'VENDOR_RETURN').map(snap);
  assert.equal(ret[0].valueMilli, -S(200));
  const p: SupplierEntryEventPayload = {
    entryId: 'sl2', kind: 'RETURN', vendorId: 'v1', vendorName: 'مورّد العصائر', amountMilli: String(-S(230)), netMilli: String(S(200)),
    taxMilli: String(S(30)), entryDate: '2027-02-05', dueDate: null, ref: 'R-1', note: null, reversesId: null,
    warehouseEntry: { id: 'we2', type: 'RETURN', vatTreatment: 'RECOVERABLE', paidAccountRef: null, costRef: { at: at(2).toISOString(), id: 'we2' }, expectedItemIds: ['wr1'] },
    payment: null,
  };
  const r = buildSupplierEntryMove({ payload: p, sourceKey: supplierEntryKey('sl2'), date: '2027-02-05', snapshots: ret }, CTX);
  assert.deepEqual([...lines(r)].sort(), [['114001', -S(200)], ['116001', -S(30)], ['211001|v1', S(230)]]);
  const vat = (r as MoveDraft).lines.find((l) => l.taxRole === 'TAX')!;
  assert.equal(vat.taxBaseMilli, -S(200), 'الوعاء سالب في المرتجع');
  assert.equal((r as MoveDraft).moveType, 'IN_REFUND');
});

test('L6 مرتجع بسعر غير التكلفة ⇒ الفرق 514002، والضريبة غير المستردة مرسمَلة (لا 116001)', () => {
  // تكلفة المرتجع 190 والمردود صافياً 200 ⇒ دائن 514002 10
  const ret: CostSnapshotInput[] = [{ sourceKey: whItemKey('x'), kind: 'VENDOR_RETURN', itemId: 'x', productId: 'A', location: 'WH', toLocation: null, baseQty: -10, valueMilli: -S(190), varianceMilli: 0n, memoMilli: 0n }];
  const base = {
    entryId: 'sl3', kind: 'RETURN', vendorId: 'v1', vendorName: 'مورّد', entryDate: '2027-02-05', dueDate: null, ref: null, note: null,
    reversesId: null, payment: null,
  };
  const we = { id: 'we3', type: 'RETURN', paidAccountRef: null, costRef: { at: at(3).toISOString(), id: 'we3' }, expectedItemIds: ['x'] };
  const r1 = buildSupplierEntryMove({ payload: { ...base, amountMilli: String(-S(230)), netMilli: String(S(200)), taxMilli: String(S(30)), warehouseEntry: { ...we, vatTreatment: 'RECOVERABLE' } }, sourceKey: 'SUPPLIER_ENTRY:sl3', date: '2027-02-05', snapshots: ret }, CTX);
  assert.deepEqual([...lines(r1)].sort(), [['114001', -S(190)], ['116001', -S(30)], ['211001|v1', S(230)], ['514002', -S(10)]]);
  // فاتورة بضريبة غير مستردة: تكلفة الاستلام شاملة (unitCost إجمالي ⇒ G = 230) فلا سطر 116001
  const rec: CostSnapshotInput[] = [{ sourceKey: whItemKey('y'), kind: 'RECEIVE', itemId: 'y', productId: 'A', location: 'WH', toLocation: null, baseQty: 10, valueMilli: S(230), varianceMilli: 0n, memoMilli: 0n }];
  const r2 = buildSupplierEntryMove({ payload: { ...base, entryId: 'sl4', kind: 'BILL', amountMilli: String(S(230)), netMilli: String(S(200)), taxMilli: String(S(30)), warehouseEntry: { ...we, id: 'we4', type: 'RECEIVE', vatTreatment: 'NON_RECOVERABLE' } }, sourceKey: 'SUPPLIER_ENTRY:sl4', date: '2027-02-05', snapshots: rec }, CTX);
  assert.deepEqual([...lines(r2)].sort(), [['211001|v1', -S(230)], ['211002', S(230)]]);
});

// ═══ AVCO: وارد 100@20 ثم 50@23 ⇒ 21؛ تحميل 30؛ بيع 10 من السيارة ⇒ تكلفة 210 ═══

test('L6 مثال AVCO: متوسّط 21، التحميل 630، وبيع 10 من السيارة ⇒ مد 511001 210 / دا 114002(R1) 210، والإلغاء مرآته', () => {
  const rr = replay([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('i1'), location: 'WH', baseQty: 100, inValueMilli: S(2000) }),
    mv({ n: 2, kind: 'RECEIVE', key: whItemKey('i2'), location: 'WH', baseQty: 50, inValueMilli: S(1150) }),
    mv({ n: 3, kind: 'VAN_LOAD', key: vanItemKey('l1'), location: 'WH', toLocation: 'VAN:R1', baseQty: -30, refId: 'load1' }),
    mv({ n: 4, kind: 'VAN_SALE', key: saleOutKey('s1'), location: 'VAN:R1', baseQty: -10, refId: 'inv1' }),
    mv({ n: 5, kind: 'SALE_CANCEL', key: saleCancelKey('s1'), location: 'VAN:R1', baseQty: 10, refId: 'inv1', links: { mirrorOf: saleOutKey('s1'), locationOf: saleOutKey('s1') } }),
  ], { currencyDecimals: 2 });
  const o = rr.outputs;
  assert.equal(o[2].unitCostE4, 210000n, 'متوسّط المستودع 21 عند التحميل');
  const names = { R1: 'أحمد' };
  const load = lines(buildStockMove({
    sourceType: 'VAN_LOAD', sourceId: 'load1', sourceKey: 'VAN_LOAD:load1:POST', sourceEvent: 'POST', date: '2027-02-01',
    narration: 'تحميل سيارة — أحمد', snapshots: [snap(o[2])], salesRepId: 'R1', repNames: names,
  }, CTX));
  assert.deepEqual([...load], [['114001', -S(630)], ['114002|R1', S(630)]]);

  const all = [snap(o[3]), snap(o[4])];
  const sale = buildCogsMove({ invoiceId: 'inv1', number: 'INV-1', leg: 'OUT', sourceKey: 'INVOICE:inv1:COGS', date: '2027-02-01', snapshots: all, salesRepId: 'R1', repNames: names }, CTX);
  assert.deepEqual([...lines(sale)], [['114002|R1', -S(210)], ['511001', S(210)]]);
  assert.equal((sale as MoveDraft).moveType, 'COGS');
  assert.equal((sale as MoveDraft).sourceEvent, 'COGS');
  const cancel = buildCogsMove({ invoiceId: 'inv1', number: 'INV-1', leg: 'CANCEL', sourceKey: invoiceCogsRevKey('inv1'), date: '2027-02-02', snapshots: all, salesRepId: 'R1', repNames: names }, CTX);
  assert.deepEqual([...lines(cancel)], [['114002|R1', S(210)], ['511001', -S(210)]], 'الإلغاء بلقطة البيع نفسها');
});

test('L6 حدود: سدّ رصيد سالب بفرق (511001)، وفاتورة الإدارة من المستودع (OD8)، والمرتجع التالف 514001 (OD15)', () => {
  // المثال ب في العقد: VAN_LOAD 10 بفرق 6,000 ⇒ مد 114002 89 + مد 511001 6 / دا 114001 95
  const rr = replay([
    mv({ n: 1, kind: 'RECEIVE', key: whItemKey('b1'), location: 'WH', baseQty: 10, inValueMilli: S(80) }),
    mv({ n: 2, kind: 'VAN_SALE', key: saleOutKey('bs'), location: 'VAN:R2', baseQty: -4 }),
    mv({ n: 3, kind: 'RECEIVE', key: whItemKey('b2'), location: 'WH', baseQty: 10, inValueMilli: S(110) }),
    mv({ n: 4, kind: 'VAN_LOAD', key: vanItemKey('bl'), location: 'WH', toLocation: 'VAN:R2', baseQty: -10 }),
    mv({ n: 5, kind: 'WAREHOUSE_SALE', key: saleOutKey('ws'), location: 'WH', baseQty: -2 }),
    mv({ n: 6, kind: 'RETURN_WRITE_OFF', key: returnKey('rt'), location: 'VAN:R2', baseQty: 0, memoQty: 3, links: { mirrorOf: saleOutKey('bs') } }),
  ], { currencyDecimals: 2 });
  const o = rr.outputs;
  assert.equal(o[3].varianceMilli, S(6));
  const load = lines(buildStockMove({ sourceType: 'VAN_LOAD', sourceId: 'bl', sourceKey: 'VAN_LOAD:bl:POST', sourceEvent: 'POST', date: '2027-02-01', narration: 'تحميل سيارة', snapshots: [snap(o[3])], salesRepId: 'R2', repNames: { R2: 'سالم' } }, CTX));
  assert.deepEqual([...load].sort(), [['114001', -S(95)], ['114002|R2', S(89)], ['511001', S(6)]]);
  // فاتورة إدارة بلا مندوب: من المستودع 114001 بمتوسّطه 9.5
  const wh = lines(buildCogsMove({ invoiceId: 'w', number: 'INV-9', leg: 'OUT', sourceKey: 'INVOICE:w:COGS', date: '2027-02-01', snapshots: [snap(o[4])] }, CTX));
  assert.deepEqual([...wh].sort(), [['114001', -S(19)], ['511001', S(19)]]);
  // مرتجع تالف 3 من بيع 4 بـ32 ⇒ 24: مد 514001 / دا 511001، والسيارة لا تتغيّر
  const wo = lines(buildCogsMove({ invoiceId: 'r', number: 'RET-1', leg: 'RET', sourceKey: 'INVOICE:r:COGS', date: '2027-02-01', snapshots: [snap(o[5])] }, CTX));
  assert.deepEqual([...wo].sort(), [['511001', -S(24)], ['514001', S(24)]]);
});

test('L6 تسوية بسببها: عجز على المندوب 113003 (OD20)، عينات 611009 (OD16)، تالف 514001، جرد/تصفير 514002', () => {
  const dec: CostSnapshotInput = { sourceKey: vanItemKey('a'), kind: 'VAN_ADJUST', itemId: 'a', productId: 'A', location: 'VAN:R1', toLocation: null, baseQty: -2, valueMilli: -S(42), varianceMilli: 0n, memoMilli: 0n };
  const run = (reason: string | null, zeroRun = false) => lines(buildStockMove({
    sourceType: 'VAN_LOAD', sourceId: 'adj', sourceKey: 'VAN_LOAD:adj:POST', sourceEvent: 'POST', date: '2027-02-01', narration: 'تسوية مخزون السيارة',
    snapshots: [dec], reason, zeroRun, salesRepId: 'R1', repNames: { R1: 'أحمد' },
  }, CTX));
  assert.deepEqual([...run('SHORTAGE_REP')].sort(), [['113003|R1', S(42)], ['114002|R1', -S(42)]]);
  assert.deepEqual([...run('SAMPLE')].sort(), [['114002|R1', -S(42)], ['611009', S(42)]]);
  assert.deepEqual([...run('DAMAGE')].sort(), [['114002|R1', -S(42)], ['514001', S(42)]]);
  assert.deepEqual([...run('COUNT')].sort(), [['114002|R1', -S(42)], ['514002', S(42)]]);
  assert.deepEqual([...run('SAMPLE', true)].sort(), [['114002|R1', -S(42)], ['514002', S(42)]], 'التصفير فروقات جرد أياً كان السبب');
  // استيراد افتتاحي بعد البدء: الدائن 319002 مع تنبيه (D8)
  const rec: CostSnapshotInput = { sourceKey: whItemKey('o'), kind: 'RECEIVE', itemId: 'o', productId: 'A', location: 'WH', toLocation: null, baseQty: 5, valueMilli: S(50), varianceMilli: 0n, memoMilli: 0n };
  const r = buildReceiptStockMove({ sourceId: 'op', sourceKey: 'WH_ENTRY:op', date: '2027-02-01', narration: 'استلام بضاعة في المستودع', snapshots: [rec], grniCounter: 'OPENING_EQUITY' }, CTX);
  assert.deepEqual([...lines(r)].sort(), [['114001', S(50)], ['319002', -S(50)]]);
  assert.equal((r as MoveDraft).needsAttention, true);
  // لا قيمة ⇒ NO_MOVE(ZERO_VALUE)
  const z = buildStockMove({ sourceType: 'WH_ENTRY', sourceId: 'z', sourceKey: 'WH_ENTRY:z', sourceEvent: 'POST', date: '2027-02-01', narration: 'تسوية', snapshots: [{ ...rec, kind: 'WH_ADJUST', valueMilli: 0n }] }, CTX);
  assert.ok(isNoMove(z) && z.reason === 'ZERO_VALUE');
});

test('L6 سند صرف المورّد: من عهدة المندوب 111003، وإلغاؤه مرآته؛ والاسترداد النقدي من المورّد', () => {
  const pay: SupplierEntryEventPayload = {
    entryId: 'p1', kind: 'PAYMENT', vendorId: 'v1', vendorName: 'مورّد', amountMilli: String(-S(500)), netMilli: null, taxMilli: null,
    entryDate: '2027-02-03', dueDate: null, ref: null, note: null, reversesId: null, warehouseEntry: null,
    payment: { id: 'sp1', number: 4, method: 'REP_CUSTODY', salesRepId: 'R1', salesRepName: 'أحمد' },
  };
  const r = buildSupplierEntryMove({ payload: pay, sourceKey: 'SUPPLIER_ENTRY:p1', date: '2027-02-03' }, CTX);
  assert.deepEqual([...lines(r)].sort(), [['111003|R1', -S(500)], ['211001|v1', S(500)]]);
  assert.equal((r as MoveDraft).journalSystemKey, 'PAYMENTS');
  const rev = buildSupplierEntryMove({ payload: { ...pay, entryId: 'p2', kind: 'PAYMENT_REV', amountMilli: String(S(500)), reversesId: 'p1' }, sourceKey: 'SUPPLIER_ENTRY:p2', date: '2027-02-04' }, CTX);
  assert.deepEqual([...lines(rev)].sort(), [['111003|R1', S(500)], ['211001|v1', -S(500)]]);
  const bank = buildSupplierEntryMove({ payload: { ...pay, payment: { ...pay.payment!, method: 'BANK_TRANSFER', salesRepId: null } }, sourceKey: 'SUPPLIER_ENTRY:p1', date: '2027-02-03' }, CTX);
  assert.deepEqual([...lines(bank)].sort(), [['111101', -S(500)], ['211001|v1', S(500)]]);
  const refund = buildSupplierEntryMove({ payload: { ...pay, entryId: 'f1', kind: 'REFUND_IN', amountMilli: String(S(230)), payment: null, warehouseEntry: { id: 'we2', type: 'RETURN', vatTreatment: null, paidAccountRef: 'MAIN_CASH', costRef: { at: at(1).toISOString(), id: 'we2' }, expectedItemIds: [] } }, sourceKey: 'SUPPLIER_ENTRY:f1', date: '2027-02-05' }, CTX);
  assert.deepEqual([...lines(refund)].sort(), [['111001', S(230)], ['211001|v1', -S(230)]]);
});

test('L6 حارس GRNI: قيد يدوي على 211002 مرفوض للمربوطة وحدها، واليدوية كما كانت', () => {
  const manual: MoveDraft = {
    kind: 'MOVE', journalCode: 'MISC', moveType: 'ENTRY', origin: 'MANUAL', date: '2027-02-01', narration: 'قيد يدوي', needsAttention: false,
    currencyCode: 'SAR', currencyDecimals: 2,
    lines: [
      { accountCode: '211002', label: 'مشتريات مستلمة', debitMilli: S(10), creditMilli: 0n },
      { accountCode: '111001', label: 'الصندوق', debitMilli: 0n, creditMilli: S(10) },
    ],
  };
  const linkedIssues = collectMoveIssues(manual, CTX, { mode: 'MANUAL' }).issues;
  assert.ok(linkedIssues.some((i) => i.code === 'LEDGER_CONTROL_ACCOUNT_MANUAL' && i.accountCode === '211002'));
  const manualCtx = ctxOf({}, false);
  assert.deepEqual(collectMoveIssues(manual, manualCtx, { mode: 'MANUAL' }).issues, [], 'الدفاتر اليدوية: لا تغيير');
});

// ═══ المفاتيح والاشتقاق ═══

test('L6 المفاتيح والاشتقاق: COGS لغير المربوطة لا يُشتق، وSUPPLIER_ENTRY بلا حركة مستودع HELD', () => {
  assert.deepEqual(parseSourceKey('SUPPLIER_ENTRY:x1'), { sourceType: 'SUPPLIER_ENTRY', sourceId: 'x1', baseKey: 'SUPPLIER_ENTRY:x1', event: 'POST', repost: null, generation: null });
  assert.equal(parseSourceKey('INVOICE:i9:COGS_REV')?.event, 'COGS');
  const inv = {
    id: 'i1', number: 'INV-1', type: 'CREDIT', customerId: 'c1', salesRepId: 'R1', pricesIncludeTax: false, subtotal: 100, discountAmt: 0,
    taxAmt: 15, total: 115, dueDate: null, customerName: 'عميل', salesRepName: 'أحمد', items: [],
  };
  const row = { id: 'ae1', customerId: 'c1', invoiceId: 'i1', receiptId: null, type: 'INVOICE_DEBIT', debit: 115, credit: 0, description: null, entryDate: at(1), createdAt: at(1) };
  const base: DeriveContext = { timezone: 'Asia/Riyadh', currency: 'SAR', currencyDecimals: 2, invoices: new Map([['i1', inv]]), linked: true,
    costItems: new Map([['i1', [{ id: 'it1', invoiceId: 'i1', productId: 'A', qty: 2, baseQty: 2, unitFactor: 1, returnExpired: null, categoryId: null }]]]) };
  assert.deepEqual(deriveAccountEntryEvents([row], base).map((e) => e.sourceKey), ['INVOICE:i1:POST'], 'بلا inventoryPosting ⇒ لا COGS');
  const evs = deriveAccountEntryEvents([row], { ...base, inventoryPosting: true });
  assert.deepEqual(evs.map((e) => e.sourceKey), ['INVOICE:i1:POST', 'INVOICE:i1:COGS']);
  const cogs = evs[1].payload as unknown as { leg: string; costRef: { id: string }; expectedItemIds: string[] };
  assert.equal(cogs.leg, 'OUT');
  assert.equal(cogs.costRef.id, 'ae1');
  assert.deepEqual(cogs.expectedItemIds, ['it1']);
  // مصادر L6 لا تشتقّ شيئاً بلا inventoryPosting
  const weRow = { id: 'we1', type: 'RECEIVE', source: 'MANUAL', reason: null, zeroRunId: null, vendorId: null, supplierRef: null, note: null, billDate: null, totalMilli: null, createdAt: at(1), items: [{ id: 'wi1', qty: 5, baseQty: 5 }] };
  assert.deepEqual(deriveWarehouseEntryEvents([weRow], base), []);
  assert.equal(deriveWarehouseEntryEvents([weRow], { ...base, inventoryPosting: true })[0].sourceKey, 'WH_ENTRY:we1');
  const sl = { id: 's1', vendorId: 'v1', kind: 'BILL', amountMilli: S(115), netMilli: S(100), taxMilli: S(15), warehouseEntryId: 'missing', supplierPaymentId: null, reversesId: null, docDate: new Date('2027-02-01T00:00:00.000Z'), dueDate: null, ref: null, note: null, createdAt: at(2) };
  const held = deriveSupplierEntryEvents([sl], { ...base, inventoryPosting: true })[0];
  assert.equal(held.status, 'HELD');
  assert.equal((held.payload as unknown as { entryDate: string }).entryDate, '2027-02-01');
});

// ═══ المُرحِّل: البوابة والترحيل من اللقطة ═══

function cogsEvent(): SourceEventRecord {
  return {
    id: 'ev1', tenantId: 't1', sourceKey: 'INVOICE:inv1:COGS', sourceType: 'INVOICE', sourceId: 'inv1', event: 'COGS',
    effectAt: new Date('2027-02-10T08:00:00.000Z'), detectedAt: new Date('2027-02-10T08:05:00.000Z'),
    payload: {
      invoiceId: 'inv1', number: 'INV-1', invoiceType: 'CREDIT', leg: 'OUT', salesRepId: 'R1', salesRepName: 'أحمد',
      entryDate: '2027-02-10', costRef: { at: '2027-02-10T08:00:00.000Z', id: 'ae1' }, expectedItemIds: ['s1'], repNames: { R1: 'أحمد' },
      sourceCreatedAt: '2027-02-10T08:00:00.000Z',
    },
    status: 'PENDING', skipReason: null, attempts: 0, nextAttemptAt: null, lastError: null, moveId: null, processedAt: null,
    nonCustodyClearedMilli: null, shortageRecoveredMilli: null,
  };
}

test('L6 المُرحِّل: PENDING قبل أن يبلغ المحرّك الصفّ، ثم القيد من اللقطة؛ وغير المربوطة لا وصفة لها (كما كانت)', async () => {
  const snaps: CostSnapshotRecord[] = [];
  let cursor: { at: Date; id: string } | null = { at: new Date('2027-02-10T07:00:00.000Z'), id: 'z' };
  const store = new FakePostingStore({
    linked: true, now: () => Date.parse('2027-02-10T09:00:00.000Z'),
    settings: { cutoverDate: '2027-01-01', inventoryMode: 'PERPETUAL', activatedAt: new Date('2027-01-15T09:00:00.000Z'), openingSnapshotAt: new Date('2027-01-15T09:00:00.000Z') },
    costSnapshots: snaps, costCursor: () => cursor,
  });
  const ev = cogsEvent();
  store.state.events.set(ev.sourceKey, structuredClone(ev));
  const p1 = await postSourceEvent(store, store.settings, ev);
  assert.deepEqual(p1, { status: 'PENDING', reason: 'AWAITING_COST_SNAPSHOT' });
  assert.equal(store.state.moves.size, 0);

  // المحرّك تجاوز الصفّ ولم تُكتب لقطة البند (وصول متأخر) ⇒ BLOCKED لا قيد
  cursor = { at: new Date('2027-02-10T08:30:00.000Z'), id: 'z' };
  const p2 = await postSourceEvent(store, store.settings, ev);
  assert.equal(p2.status, 'BLOCKED');
  assert.equal(p2.status === 'BLOCKED' && p2.reason, 'AWAITING_COST_SNAPSHOT');

  snaps.push({
    sourceKey: saleOutKey('s1'), kind: 'VAN_SALE', refType: 'INVOICE', refId: 'inv1', itemId: 's1', productId: 'A', location: 'VAN:R1',
    toLocation: null, baseQty: -10, valueMilli: -S(210), varianceMilli: 0n, memoMilli: 0n,
  });
  const p3 = await postSourceEvent(store, store.settings, { ...ev, status: 'BLOCKED' });
  assert.equal(p3.status, 'DONE');
  const mvs = [...store.state.moves.values()];
  assert.equal(mvs.length, 1);
  assert.equal(mvs[0].moveType, 'COGS');
  assert.equal(mvs[0].date, '2027-02-10');
  const debit = mvs[0].lines.find((l) => l.debitMilli > 0n)!;
  assert.equal(debit.accountId, accountIdOf('511001'));
  assert.equal(debit.debitMilli, S(210));

  // غير المربوطة (القديمة): حدث COGS بلا وصفة كما كان — HELD(UNEXPECTED_ENTRY_SHAPE) ولا قيد
  const legacy = new FakePostingStore({ settings: { inventoryMode: 'PERPETUAL' }, costSnapshots: snaps, costCursor: () => cursor });
  legacy.state.events.set(ev.sourceKey, structuredClone(ev));
  const p4 = await postSourceEvent(legacy, legacy.settings, ev);
  assert.notEqual(p4.status, 'DONE');
  assert.equal(legacy.state.moves.size, 0);
});

// ═══ العزل: اليدوية وغير المربوطة لا يتغيّر لها شيء ═══

test('L6 العزل: مهمة اللقطات تقرأ gl_settings وحدها لغير المربوطة، والمؤشّرات الابتدائية لغير المربوطة كما كانت', async () => {
  const { runCostSnapshotJob } = await import('../services/gl/sync/scheduler');
  const { initialCursorRows } = await import('../services/gl/backfill');
  const touched: string[] = [];
  const client = new Proxy({}, {
    get: (_t, model: string) => new Proxy({}, {
      get: (_m, op: string) => async () => {
        touched.push(`${model}.${op}`);
        return model === 'glSettings' ? { setupMethod: 'CLEAN', activatedAt: new Date(), inventoryMode: 'PERPETUAL', currencyDecimals: 2 } : null;
      },
    }),
  });
  assert.equal(await runCostSnapshotJob(client as never, 't1'), null);
  assert.deepEqual(touched, ['glSettings.findUnique'], 'اليدوية: قراءة واحدة بلا كتابة ولا قفل');
  const wm = new Date('2027-01-01T00:00:00.000Z');
  assert.deepEqual(initialCursorRows('t1', 'PERPETUAL', wm).map((r) => r.source), ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY', 'WAREHOUSE_ENTRY', 'VAN_LOAD', 'RETURN_RESTOCK']);
  assert.deepEqual(initialCursorRows('t1', 'PERPETUAL', wm, { linked: true }).map((r) => r.source).slice(-2), ['USER_SETTLEMENT', 'SUPPLIER_ENTRY']);
});
