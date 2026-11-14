// «ربط الدفاتر» L8 (A10) — تقارير الشركاء الصرفة: دفتر الشريك (الافتتاح + الحركة = الختام)، والأعمار (E8.2، وتطابقها مع
// remainingAmt التشغيلي لكل عميل وعمود)، والوصول المتأخر (E8.4)، وتقرير الأصناف (E4.5 وR6)، وإعادة تصنيف الميزانية (E5.15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPartnerLedger, serializePartnerLedger, comparePartnerLines, type PartnerLedgerLineInput } from '../services/gl/reports/partnerLedger';
import { agingBucketOf, buildAging, parseAgingBuckets, serializeAging, type AgingItem } from '../services/gl/reports/aging';
import { buildLateArrivals, lateArrivalReason, serializeLateArrivals } from '../services/gl/reports/lateArrivals';
import { buildProductLedger, serializeProductLedger } from '../services/gl/reports/productLedger';
import {
  buildBalanceSheet, balanceSheetAmount, partnerReclassPlan, CUSTOMER_CREDITS_RECLASS_CODE,
} from '../services/gl/reports/balanceSheet';
import { zeroBalance } from '../services/gl/reports/balances';
import type { AccountBalance, ReportAccount } from '../services/gl/reports/types';
import { reconcileAfterPost } from '../services/gl/reconcile/apply';
import { distributeMilli, toMilli } from '../services/gl/money';
import { addDays } from '../services/gl/dates';
import { MemReconcileStore, M } from './l458-a10-mem-reconcile-store';

// ═══ دفتر الشريك ═══

const line = (o: Partial<PartnerLedgerLineInput> & Pick<PartnerLedgerLineInput, 'lineId' | 'date'>): PartnerLedgerLineInput => ({
  moveId: `m-${o.lineId}`, moveNumber: `N-${o.lineId}`, journalCode: 'INV', ref: null, label: null, sourceType: 'INVOICE', sourceId: `s-${o.lineId}`,
  seq: 0, debitMilli: 0n, creditMilli: 0n, dueDate: null, productId: null, quantity: null, ...o,
});

test('دفتر الشريك: الافتتاح + الحركة = الختام، والرصيد الجاري صحيح في كل صفحة', () => {
  const lines = [
    line({ lineId: 'c', date: '2026-02-01', creditMilli: M(600) }),
    line({ lineId: 'a', date: '2026-01-10', debitMilli: M(575), dueDate: '2026-02-10' }),
    line({ lineId: 'b', date: '2026-01-10', debitMilli: M(575), dueDate: '2026-03-10', seq: 1, moveId: 'm-a', moveNumber: 'N-a' }),
    line({ lineId: 'd', date: '2026-03-01', debitMilli: M(100) }),
  ];
  const partials = [
    { id: 'p1', debitLineId: 'a', creditLineId: 'c', debitMoveId: 'm-a', creditMoveId: 'm-c', amountMilli: M(575) },
    { id: 'p2', debitLineId: 'b', creditLineId: 'c', debitMoveId: 'm-a', creditMoveId: 'm-c', amountMilli: M(25) },
    { id: 'p2', debitLineId: 'b', creditLineId: 'c', debitMoveId: 'm-a', creditMoveId: 'm-c', amountMilli: M(25) }, // تكرار من دفعتين
  ];
  const base = {
    partner: { type: 'customer' as const, id: 'C', name: 'عميل' }, currency: 'SAR', decimals: 2, from: '2026-01-01', to: '2026-12-31',
    openingMilli: M(200), lines, partials, includeReconciled: true,
  };
  const all = buildPartnerLedger({ ...base, page: 1, pageSize: null });
  assert.deepEqual(all.lines.map((l) => l.lineId), ['a', 'b', 'c', 'd']);
  assert.equal(all.totalDebitMilli, M(1250));
  assert.equal(all.totalCreditMilli, M(600));
  assert.equal(all.closingMilli, all.openingMilli + all.totalDebitMilli - all.totalCreditMilli);
  assert.equal(all.closingMilli, M(850));
  assert.deepEqual(all.lines.map((l) => l.balanceMilli), [M(775), M(1350), M(750), M(850)]);
  assert.deepEqual(all.lines.map((l) => l.residualMilli), [0n, M(550), 0n, M(100)]);
  assert.deepEqual(all.lines.map((l) => l.fullyReconciled), [true, false, true, false]);
  assert.deepEqual(all.lines[2].matches.map((m) => [m.lineId, m.amountMilli]), [['a', M(575)], ['b', M(25)]]);

  const p2 = buildPartnerLedger({ ...base, page: 2, pageSize: 3 });
  assert.equal(p2.pages, 2);
  assert.deepEqual(p2.lines.map((l) => [l.lineId, l.balanceMilli]), [['d', M(850)]]);
  assert.equal(p2.closingMilli, all.closingMilli);

  // غير المطابَقة: تُسقط a وc، والافتتاح يمرّره المستدعي بالقاعدة نفسها، والثابت قائم
  const open = buildPartnerLedger({ ...base, includeReconciled: false, openingMilli: M(50), page: 1, pageSize: null });
  assert.deepEqual(open.lines.map((l) => l.lineId), ['b', 'd']);
  assert.equal(open.closingMilli, M(50) + M(675));

  const json = serializePartnerLedger(all, { moveNumbers: new Map([['m-a', 'INV/1']]), attachments: new Map([['c', { count: 2, kinds: ['RECEIPT_PHOTO'] }]]), documentsCount: 3 });
  const jl = json.lines as Record<string, unknown>[];
  assert.equal(json.opening, 200);
  assert.equal(json.closing, 850);
  assert.equal(jl[1].residual, 550);
  assert.equal(jl[2].residual, 0);
  assert.deepEqual(jl[2].matches, [{ lineId: 'a', moveId: 'm-a', moveNumber: 'INV/1', amount: 575 }, { lineId: 'b', moveId: 'm-a', moveNumber: 'INV/1', amount: 25 }]);
  assert.deepEqual(jl[2].attachments, { count: 2, kinds: ['RECEIPT_PHOTO'] });
  assert.deepEqual(json.documents, { count: 3 });
  // لا BigInt في الردّ (res.json ينهار به)
  assert.doesNotThrow(() => JSON.stringify(json));
});

test('دفتر الشريك: سطر دائن مفتوح متبقّيه سالب، وترتيب القيود داخل اليوم بلحظة إنشائها', () => {
  const l = buildPartnerLedger({
    partner: { type: 'vendor', id: 'V', name: null }, currency: 'SAR', decimals: 2, from: '2026-01-01', to: '2026-01-31', openingMilli: 0n,
    lines: [
      line({ lineId: 'late', date: '2026-01-05', moveCreatedAt: 2000, creditMilli: M(10), moveNumber: 'A' }),
      line({ lineId: 'early', date: '2026-01-05', moveCreatedAt: 1000, creditMilli: M(5), moveNumber: 'Z' }),
    ],
    partials: [], includeReconciled: true, page: 1, pageSize: 100,
  });
  assert.deepEqual(l.lines.map((x) => x.lineId), ['early', 'late']);
  assert.deepEqual(l.lines.map((x) => x.residualMilli), [-M(5), -M(10)]);
  assert.equal(l.closingMilli, -M(15));
  assert.throws(() => buildPartnerLedger({ ...l, partials: [], lines: [], openingMilli: 0n, from: '2026-02-01', to: '2026-01-01', page: 1, pageSize: 1 }));
  assert.ok(comparePartnerLines(line({ lineId: 'x', date: '2026-01-01' }), line({ lineId: 'y', date: '2026-01-02' })) < 0);
});

// ═══ الأعمار ═══

test('parseAgingBuckets وagingBucketOf: الحدود شاملة، والافتراضي 30/60/90/120', () => {
  assert.deepEqual(parseAgingBuckets(undefined), [30, 60, 90, 120]);
  assert.deepEqual(parseAgingBuckets('15,30,45,60'), [15, 30, 45, 60]);
  for (const bad of ['30,60,90', '30,30,90,120', '0,60,90,120', '30,60,abc,120', '30,60,90,99999']) assert.equal(parseAgingBuckets(bad), null, bad);
  const b = [30, 60, 90, 120];
  assert.deepEqual([-3, 0, 1, 30, 31, 60, 61, 90, 91, 120, 121].map((d) => agingBucketOf(d, b)),
    ['notDue', 'notDue', 'b1', 'b1', 'b2', 'b2', 'b3', 'b3', 'b4', 'b4', 'older']);
});

test('E8.2: في 2027-01-20 القسط الثاني (استحقاق 2027-01-13) في عمود 1–30 بـ550، وغير المستحق 0', () => {
  const items: AgingItem[] = [{ partnerId: 'C', lineId: 'L2', moveNumber: 'INV-1001', date: '2026-11-14', dueDate: '2027-01-13', residualMilli: M(550) }];
  const r = buildAging({ kind: 'AR', asOf: '2027-01-20', basis: 'due', buckets: [30, 60, 90, 120], items, names: new Map([['C', 'عميل C']]), detail: true });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].b1, M(550));
  assert.equal(r.rows[0].notDue, 0n);
  assert.equal(r.rows[0].total, M(550));
  assert.deepEqual(r.detail?.map((d) => [d.daysOverdue, d.bucket]), [[7, 'b1']]);
  // basis=date: من تاريخ الفاتورة 67 يوماً ⇒ العمود الثالث
  const byDate = buildAging({ kind: 'AR', asOf: '2027-01-20', basis: 'date', buckets: [30, 60, 90, 120], items, names: new Map() });
  assert.equal(byDate.rows[0].b3, M(550));
  const json = serializeAging(r) as { rows: Record<string, unknown>[]; totals: Record<string, unknown> };
  assert.equal(json.rows[0].b1, 550);
  assert.equal(json.totals.total, 550);
});

test('الأعمار: الدائن المفتوح للعميل في unappliedCredits سالباً، والموردون بالجانب الدائن', () => {
  const ar = buildAging({
    kind: 'AR', asOf: '2026-12-31', basis: 'due', buckets: [30, 60, 90, 120], names: new Map(),
    items: [
      { partnerId: 'C', date: '2026-12-01', dueDate: '2027-01-01', residualMilli: M(100) },
      { partnerId: 'C', date: '2026-12-05', dueDate: null, residualMilli: -M(40) },
      { partnerId: 'D', date: '2026-06-01', dueDate: null, residualMilli: -M(5) },
    ],
  });
  assert.deepEqual(ar.rows.map((r) => [r.partnerId, r.notDue, r.unappliedCredits, r.total]), [['C', M(100), -M(40), M(60)], ['D', 0n, -M(5), -M(5)]]);
  assert.equal(ar.totals.total, M(55));
  const ap = buildAging({
    kind: 'AP', asOf: '2026-12-31', basis: 'due', buckets: [30, 60, 90, 120], names: new Map(),
    items: [{ partnerId: 'V', date: '2026-10-01', dueDate: '2026-11-15', residualMilli: -M(400) }, { partnerId: 'V', date: '2026-12-01', dueDate: null, residualMilli: M(50) }],
  });
  assert.equal(ap.rows[0].b2, M(400));
  assert.equal(ap.rows[0].unappliedCredits, -M(50));
  assert.equal(ap.rows[0].total, M(350));
});

/** مولّد حتمي (LCG) */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('الأعمار من الدفاتر = remainingAmt التشغيلي لكل عميل وعمود (سيناريو بلا إشعار دائن، 3 منازل و2 و0)', async () => {
  for (const dec of [2, 3, 0]) {
    for (const seed of [7, 11, 2026]) {
      const rand = rng(seed + dec);
      const store = new MemReconcileStore();
      const customers = ['C1', 'C2', 'C3'];
      const unit = 10n ** BigInt(3 - dec);
      const money = (max: number) => (BigInt(Math.floor(rand() * max * 10 ** dec)) + 1n) * unit;
      type Inv = { id: string; customer: string; date: string; installments: { due: string; amount: bigint }[]; total: bigint; paid: bigint; posted: boolean };
      const invoices: Inv[] = [];
      const asOf = '2026-12-31';
      // فواتير آجلة: نصفها بأقساط
      for (let i = 0; i < 18; i++) {
        const customer = customers[i % 3];
        const date = addDays('2026-06-01', Math.floor(rand() * 150));
        const total = money(5000);
        const n = rand() < 0.5 ? 1 + Math.floor(rand() * 3) : 1;
        const weights = Array.from({ length: n }, () => money(100));
        const shares = distributeMilli(total, weights, dec);
        const installments = shares.map((amount, k) => ({ due: addDays(date, 30 * (k + 1)), amount }));
        invoices.push({ id: `I${i}`, customer, date, installments, total, paid: 0n, posted: false });
      }
      const postInvoice = async (inv: Inv) => {
        store.addMove({
          id: `M-${inv.id}`, date: inv.date, lines: inv.installments.map((t, k) => ({
            id: `${inv.id}-L${k}`, accountId: 'AR', kind: 'AR' as const, partnerId: inv.customer, debit: t.amount, credit: 0n, dueDate: t.due,
          })),
        });
        store.live.set(`INVOICE:${inv.id}:POST`, `M-${inv.id}`);
        inv.posted = true;
        await reconcileAfterPost(store, { sourceType: 'INVOICE', sourceId: inv.id, event: 'POST', moveId: `M-${inv.id}`, payload: { type: 'CREDIT', invoiceId: inv.id } as never });
      };
      // نصف الفواتير تُرحَّل أولاً، والباقي بعد سنداتها (مسار pendingAllocationsForInvoice)
      for (const inv of invoices.filter((_, k) => k % 2 === 0)) await postInvoice(inv);
      let unallocated = new Map<string, bigint>();
      for (let r = 0; r < 14; r++) {
        const customer = customers[r % 3];
        const mine = invoices.filter((i) => i.customer === customer && i.paid < i.total);
        const allocs: { id: string; invoiceId: string; amount: bigint }[] = [];
        for (const inv of mine.slice(0, 1 + Math.floor(rand() * 2))) {
          const left = inv.total - inv.paid;
          const amt = rand() < 0.4 ? left : (left * BigInt(1 + Math.floor(rand() * 90))) / 100n / unit * unit;
          if (amt <= 0n) continue;
          inv.paid += amt;
          allocs.push({ id: `R${r}-${inv.id}`, invoiceId: inv.id, amount: amt });
        }
        const extra = rand() < 0.3 ? money(50) : 0n;
        const amount = allocs.reduce((a, x) => a + x.amount, 0n) + extra;
        if (amount === 0n) continue;
        unallocated.set(customer, (unallocated.get(customer) ?? 0n) + extra);
        const date = addDays('2026-11-01', r);
        store.addMove({ id: `M-R${r}`, date, lines: [{ id: `R${r}-c`, accountId: 'AR', kind: 'AR', partnerId: customer, debit: 0n, credit: amount }] });
        for (const a of allocs) {
          if (!invoices.find((i) => i.id === a.invoiceId)!.posted) {
            store.pending.push({ invoiceId: a.invoiceId, sourceRef: `RI:${a.id}`, creditMoveId: `M-R${r}`, amountMilli: a.amount });
          }
        }
        await reconcileAfterPost(store, {
          sourceType: 'RECEIPT', sourceId: `R${r}`, event: 'POST', moveId: `M-R${r}`,
          payload: { allocations: allocs.map((a) => ({ id: a.id, invoiceId: a.invoiceId, amount: (Number(a.amount) / 1000).toFixed(dec) })) } as never,
        });
      }
      for (const inv of invoices.filter((i) => !i.posted)) await postInvoice(inv);

      // الدفاتر: البنود المفتوحة من متبقّي كل سطر ذمة
      const items: AgingItem[] = store.allLines().filter((l) => l.kind === 'AR').map((l) => ({
        partnerId: l.partnerId as string, date: l.date, dueDate: l.dueDate, residualMilli: l.debit > 0n ? store.residual(l.id) : -store.residual(l.id),
      }));
      const ledger = buildAging({ kind: 'AR', asOf, basis: 'due', buckets: [30, 60, 90, 120], items, names: new Map() });

      // التشغيل: remainingAmt لكل فاتورة يُسقط من أقساطها الأقدم استحقاقاً أولاً، والسندات غير المخصّصة رصيد دائن
      const want = new Map<string, Record<string, bigint>>();
      for (const inv of invoices) {
        let paid = inv.paid;
        for (const t of inv.installments) {
          const take = paid < t.amount ? paid : t.amount;
          paid -= take;
          const open = t.amount - take;
          if (open === 0n) continue;
          const row = want.get(inv.customer) ?? {};
          const k = agingBucketOf(Math.round((Date.parse(asOf) - Date.parse(t.due)) / 86400000), [30, 60, 90, 120]);
          row[k] = (row[k] ?? 0n) + open;
          want.set(inv.customer, row);
        }
        assert.equal(inv.total - inv.paid, inv.installments.reduce((a, t) => a + t.amount, 0n) - inv.paid, 'remainingAmt');
      }
      for (const c of customers) {
        const got = ledger.rows.find((r) => r.partnerId === c);
        const w = want.get(c) ?? {};
        for (const k of ['notDue', 'b1', 'b2', 'b3', 'b4', 'older'] as const) {
          assert.equal(got?.[k] ?? 0n, w[k] ?? 0n, `dec=${dec} seed=${seed} ${c} ${k}`);
        }
        assert.equal(got?.unappliedCredits ?? 0n, -(unallocated.get(c) ?? 0n), `dec=${dec} seed=${seed} ${c} غير مخصّص`);
        const remaining = invoices.filter((i) => i.customer === c).reduce((a, i) => a + i.total - i.paid, 0n);
        assert.equal((got?.total ?? 0n) + (unallocated.get(c) ?? 0n), remaining, 'Σ الأعمدة = Σ remainingAmt');
      }
      unallocated = new Map();
    }
  }
});

// ═══ الوصول المتأخر ═══

test('E8.4: فاتورة 2026-10-02 رُحّلت 2026-11-01 بعد إقفال المبيعات ⇒ PERIOD_LOCKED، وما قبل البداية ⇒ AFTER_CUTOVER', () => {
  const r = buildLateArrivals([
    { moveId: 'm1', moveNumber: 'INV/9', sourceType: 'INVOICE', sourceId: 'i1', ref: 'INV-9', partnerName: 'C', date: '2026-11-01', originalDate: '2026-10-02', lateArrival: true, totalMilli: M(115) },
    { moveId: 'm2', moveNumber: 'INV/2', sourceType: 'INVOICE', sourceId: 'i2', ref: null, partnerName: null, date: '2026-01-01', originalDate: '2025-12-20', lateArrival: true, totalMilli: M(50) },
    { moveId: 'm3', moveNumber: 'INV/3', sourceType: 'INVOICE', sourceId: 'i3', ref: null, partnerName: null, date: '2026-05-01', originalDate: null, lateArrival: false, totalMilli: M(9) },
    { moveId: 'm4', moveNumber: 'INV/4', sourceType: 'RECEIPT', sourceId: 'r4', ref: null, partnerName: null, date: '2026-05-03', originalDate: '2026-05-01', lateArrival: false, totalMilli: M(7) },
  ], { cutoverDate: '2026-01-01' });
  assert.deepEqual(r.rows.map((x) => [x.moveId, x.originalDate, x.postedDate, x.reason]), [
    ['m2', '2025-12-20', '2026-01-01', 'AFTER_CUTOVER'],
    ['m4', '2026-05-01', '2026-05-03', 'PERIOD_LOCKED'],
    ['m1', '2026-10-02', '2026-11-01', 'PERIOD_LOCKED'],
  ]);
  assert.equal(r.totalMilli, M(172));
  assert.equal(lateArrivalReason('2025-01-01', null), 'PERIOD_LOCKED');
  const j = serializeLateArrivals(r) as { rows: Record<string, unknown>[]; total: number };
  assert.equal(j.total, 172);
  assert.equal(j.rows[2].amount, 115);
});

// ═══ تقرير الأصناف ═══

test('E4.5 وR6: إيراد لكل صنف وخصم منفصل، ومرتجع على 412001، وإلغاء فاتورة — Σ net = (411001) − 412001 − 413001', () => {
  const DISC = 'a413001';
  const RET = 'a412001';
  const REV = 'a411001';
  const lines = [
    // E4.5: P1 2×50=100 خصم 10؛ P2 1×100=100 خصم 10
    { productId: 'P1', accountId: REV, isReturnMove: false, debitMilli: 0n, creditMilli: M(100), creditQuantity: 2, debitQuantity: 0 },
    { productId: 'P2', accountId: REV, isReturnMove: false, debitMilli: 0n, creditMilli: M(100), creditQuantity: 1, debitQuantity: 0 },
    { productId: 'P1', accountId: DISC, isReturnMove: false, debitMilli: M(10), creditMilli: 0n, creditQuantity: 0, debitQuantity: 0 },
    { productId: 'P2', accountId: DISC, isReturnMove: false, debitMilli: M(10), creditMilli: 0n, creditQuantity: 0, debitQuantity: 0 },
    // مرتجع P1 واحدة على 412001 بـ50 وعكس خصمه 5
    { productId: 'P1', accountId: RET, isReturnMove: true, debitMilli: M(50), creditMilli: 0n, creditQuantity: 0, debitQuantity: 1 },
    { productId: 'P1', accountId: DISC, isReturnMove: true, debitMilli: 0n, creditMilli: M(5), creditQuantity: 0, debitQuantity: 0 },
    // مرتجع بلا contra (على 411001 في قيد مرتجع) لـP2 بـ20
    { productId: 'P2', accountId: REV, isReturnMove: true, debitMilli: M(20), creditMilli: 0n, creditQuantity: 0, debitQuantity: 0.25 },
    // إلغاء فاتورة P2 أخرى (بيع 30 ثم عكسه)
    { productId: 'P2', accountId: REV, isReturnMove: false, debitMilli: 0n, creditMilli: M(30), creditQuantity: 3, debitQuantity: 0 },
    { productId: 'P2', accountId: REV, isReturnMove: false, debitMilli: M(30), creditMilli: 0n, creditQuantity: 0, debitQuantity: 3 },
  ];
  const p = buildProductLedger({ lines, discountAccountIds: new Set([DISC]), returnsAccountIds: new Set([RET]), names: new Map([['P1', 'صنف 1'], ['P2', 'صنف 2']]) });
  const by = new Map(p.rows.map((r) => [r.productId, r]));
  assert.deepEqual([by.get('P1')!.revenueMilli, by.get('P1')!.discountMilli, by.get('P1')!.returnsMilli, by.get('P1')!.netMilli], [M(100), M(5), M(50), M(45)]);
  assert.deepEqual([by.get('P1')!.soldQuantity, by.get('P1')!.returnedQuantity, by.get('P1')!.quantity], [2, 1, 1]);
  assert.deepEqual([by.get('P2')!.revenueMilli, by.get('P2')!.discountMilli, by.get('P2')!.returnsMilli, by.get('P2')!.netMilli], [M(100), M(10), M(20), M(70)]);
  assert.deepEqual([by.get('P2')!.soldQuantity, by.get('P2')!.returnedQuantity, by.get('P2')!.quantity], [1, 0.25, 0.75]);
  // R6: Σ(411001 دائن − مدين) − 412001(مدين − دائن) − 413001(مدين − دائن)
  const sum = (acc: string, f: (l: typeof lines[number]) => bigint) => lines.filter((l) => l.accountId === acc).reduce((a, l) => a + f(l), 0n);
  const r6 = sum(REV, (l) => l.creditMilli - l.debitMilli) - sum(RET, (l) => l.debitMilli - l.creditMilli) - sum(DISC, (l) => l.debitMilli - l.creditMilli);
  assert.equal(p.totals.netMilli, r6);
  assert.equal(p.totals.netMilli, M(115));
  assert.deepEqual(p.rows.map((r) => r.productId), ['P2', 'P1'], 'الأعلى صافياً أولاً');
  const j = serializeProductLedger(p) as { totals: Record<string, unknown> };
  assert.equal(j.totals.net, 115);
});

// ═══ إعادة تصنيف الميزانية ═══

const acc = (id: string, code: string, type: ReportAccount['type']): ReportAccount => ({ id, code, name: code, nameI18n: null, type });

function bal(accountId: string, net: bigint): AccountBalance {
  return { ...zeroBalance(accountId), debitMilli: net > 0n ? net : 0n, creditMilli: net < 0n ? -net : 0n };
}

test('E5.15: العميل A مدين 5,000 وB دائن 300 والمورد V مدين 200 ⇒ ذمم العملاء 5,000 ودفعات مقدمة 200 ومستردات 300 — متّزنة', () => {
  const accounts = [
    acc('ar', '113001', 'asset_receivable'), acc('cash', '111001', 'asset_cash'), acc('ap', '211001', 'liability_payable'),
    acc('cap', '311001', 'equity'), acc('rev', '411001', 'income'), acc('adv', '115003', 'asset_prepayments'),
  ];
  // AR الصافي 4,700؛ AP: V مدين 200 ومورد آخر دائن 1,000 ⇒ صافي −800؛ النقد يوازن
  const balances = [bal('ar', M(4700)), bal('ap', -M(800)), bal('cash', M(1100)), bal('cap', -M(5000))];
  const period = { from: '2026-01-01', to: '2026-12-31', fyStart: '2026-01-01' };
  const plain = buildBalanceSheet({ period, accounts, balances });
  assert.equal(plain.partnerReclass, undefined);
  assert.equal(plain.warnings, undefined);
  assert.equal(balanceSheetAmount(plain, 'assetReceivable'), M(4700));
  const reclass = { customerCredits: [{ accountId: 'ar', amountMilli: M(300), partners: 1 }], vendorDebits: [{ accountId: 'ap', amountMilli: M(200), partners: 1 }] };
  // بلا «مربوطة» ولا خيار: كما كانت حرفاً
  assert.deepEqual(buildBalanceSheet({ period, accounts, balances, partnerReclass: reclass }), plain);
  const s = buildBalanceSheet({ period, accounts, balances, partnerReclass: reclass, settings: { linkedPosting: true } });
  assert.equal(balanceSheetAmount(s, 'assetReceivable'), M(5000));
  assert.equal(balanceSheetAmount(s, 'assetPrepayments'), M(200));
  assert.equal(balanceSheetAmount(s, 'liabilityCurrent'), M(300));
  assert.equal(balanceSheetAmount(s, 'liabilityPayable'), M(1000));
  assert.ok(s.balanced);
  assert.equal(s.imbalanceMilli, 0n);
  assert.equal(s.totalEquityMilli, plain.totalEquityMilli, 'حقوق الملكية لا تتغيّر');
  assert.equal(s.totalAssetsMilli - s.totalLiabilitiesMilli, plain.totalAssetsMilli - plain.totalLiabilitiesMilli, 'الصافي لا يتغيّر');
  assert.deepEqual(s.warnings, [{ code: 'PARTNER_RECLASS', message: s.warnings![0].message, details: { customers: 1, vendors: 1 } }]);
  // 214002 غائب من الدليل ⇒ صفّ تركيبي باسمه
  const liab = s.sections[1].children[0].children[0];
  assert.deepEqual(liab.accounts.map((a) => [a.code, a.amountMilli]), [[CUSTOMER_CREDITS_RECLASS_CODE, M(300)]]);
  assert.equal(s.partnerReclass?.customerCreditsAccountId, 'reclass:214002');
  assert.equal(s.partnerReclass?.vendorAdvancesAccountId, 'adv');
  // الخيار الصريح لغير المربوطة يطبّقها أيضاً، ومدخل صفري لا يطبّق شيئاً
  assert.ok(buildBalanceSheet({ period, accounts, balances, partnerReclass: reclass, reclassifyPartnerBalances: true }).partnerReclass);
  assert.equal(partnerReclassPlan({ partnerReclass: { customerCredits: [], vendorDebits: [] }, settings: { linkedPosting: true } }, accounts), null);
  // حساب مجهول في المدخل يُتجاهل (لا ينكسر التوازن)
  const odd = buildBalanceSheet({ period, accounts, balances, settings: { linkedPosting: true },
    partnerReclass: { customerCredits: [{ accountId: 'nope', amountMilli: M(1), partners: 1 }], vendorDebits: [] } });
  assert.equal(odd.partnerReclass, undefined);
  assert.ok(odd.balanced);
  assert.equal(toMilli('5000', 2), M(5000));
});
