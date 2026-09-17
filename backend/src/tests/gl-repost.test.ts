// M3 — «إعادة الترحيل من المصدر» (DESIGN.md §6.1، ملحق أ `/moves/:id/repost-from-source`).
// بلا قاعدة: repostFromSource فوق PostingTx بالمخزن المزيّف والمُرحِّل الحقيقي. المتجهات: القيد الحيّ يُعكس بمفتاح
// <base>:REPOST_REV:<n> ويُعاد بناؤه بالربط الحالي بمفتاح <base>:REPOST:<n>؛ الأثر الصافي على 113001 صفر؛ n = 1 + عدد
// REPOST القائمة؛ الرفض لغير AUTO وللمؤمَّن ولغير الحيّ ولمصدر حدث REVERSE له DONE؛ الاستلام يُعاد بالتقسيم المخزَّن؛
// وحارس ثابت للمسار (canConfigureLedger، القفل أولاً، MOVE_REPOST، إشعار).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { accountIdOf } from '../services/gl/testing/fixtures';
import { invoicePayloadFromRows } from '../services/gl/builders/invoice';
import { SYSTEM_ACTOR } from '../services/gl/audit';
import { invoiceKey, settlementKey } from '../services/gl/sync/keys';
import { createSyncBudget, runPoster } from '../services/gl/sync/poster';
import { REPOST_REVERSAL_REASON, RepostRejectedError, repostFromSource, repostPrecheck, type RepostMoveFacts } from '../services/gl/sync/repost';
import type { DesiredEvent, SourceEventPayload } from '../services/gl/sync/types';
import { isLedgerError } from '../services/gl/types';
import { FakePostingStore, type FakeMove } from './gl-fake-posting-store';

const at = (iso: string) => new Date(iso);
const AR = accountIdOf('113001');
const REV_SALES = accountIdOf('411001');
const REV_SERVICE = accountIdOf('411002');
const CUSTODY = accountIdOf('111003');

function invoiceEvent(id: string): DesiredEvent {
  const payload = invoicePayloadFromRows({
    invoice: { id, number: `INV-${id}`, type: 'CREDIT', customerId: 'c1', salesRepId: null, pricesIncludeTax: false, subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115 },
    items: [{ qty: 1, unitPrice: 100, taxPct: 15, taxAmt: 15, lineTotal: 115 }],
    customerName: 'عميل أول', entryDate: '2027-02-10', currency: 'SAR', currencyDecimals: 2,
  });
  return {
    sourceKey: invoiceKey(id, 'POST'), sourceType: 'INVOICE', sourceId: id, event: 'POST', effectAt: at('2027-02-10T08:00:00.000Z'),
    payload: { ...payload, sourceCreatedAt: '2027-02-10T08:00:00.000Z' } as SourceEventPayload,
  };
}

async function postedInvoice() {
  const s = new FakePostingStore({ now: () => at('2027-03-01T10:00:00.000Z').getTime() });
  s.seedEvents([invoiceEvent('i1')]);
  await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 100 }), { log: () => undefined });
  const move = s.moves()[0];
  assert.ok(move, 'قيد الفاتورة مرحّل');
  return { s, move };
}

function factsOf(s: FakePostingStore, m: FakeMove, extra: Partial<RepostMoveFacts> = {}): RepostMoveFacts {
  const sources = [...s.state.sources.entries()].filter(([, id]) => id === m.id).map(([sourceKey]) => ({
    sourceKey, sourceType: m.sourceType ?? '', sourceId: m.sourceId ?? '', event: sourceKey.includes(':REPOST_REV:') ? 'REVERSE' : 'POST',
  }));
  return {
    id: m.id, number: m.number, state: 'POSTED', origin: 'AUTO', date: m.date, originalDate: m.originalDate, lateArrival: m.lateArrival,
    secureHash: null, sources, ...extra,
  };
}

const lineOn = (m: FakeMove, accountId: string) => m.lines.find((l) => l.accountId === accountId);

async function repost(s: FakePostingStore, facts: RepostMoveFacts) {
  return s.withPostLock('t1', (tx) => repostFromSource(tx, { move: facts, actor: SYSTEM_ACTOR, timezone: 'Asia/Riyadh' }));
}

async function rejectsWith(p: Promise<unknown>, reason: string) {
  await assert.rejects(p, (e: unknown) => e instanceof RepostRejectedError && e.reason === reason);
}

test('إعادة الترحيل: عكس القيد الحيّ بـREPOST_REV:1 وإعادة البناء بالربط الحالي بـREPOST:1، والأثر الصافي على 113001 صفر', async () => {
  const { s, move } = await postedInvoice();
  assert.ok(lineOn(move, REV_SALES));
  const arBefore = s.balance(AR, 'c1');

  // تعديل ربط الإيراد بعد الترحيل
  s.opts.context = { mappings: { SALES_REVENUE: '411002' } };
  const r = await repost(s, factsOf(s, move));
  const base = invoiceKey('i1', 'POST');
  assert.equal(r.n, 1);
  assert.equal(r.reversal.sourceKey, `${base}:REPOST_REV:1`);
  assert.equal(r.repost.sourceKey, `${base}:REPOST:1`);
  assert.equal(s.state.sources.get(`${base}:REPOST_REV:1`), r.reversal.id);
  assert.equal(s.state.sources.get(`${base}:REPOST:1`), r.repost.id);

  const reversal = s.state.moves.get(r.reversal.id)!;
  const reposted = s.state.moves.get(r.repost.id)!;
  assert.equal(reversal.reversedMoveId, move.id);
  assert.equal(reversal.date, move.date, 'العكس بتاريخ القيد الحيّ');
  assert.equal(reposted.date, move.date);
  assert.ok(lineOn(reposted, REV_SERVICE), 'الربط الحالي');
  assert.equal(lineOn(reposted, REV_SALES), undefined);
  assert.equal(s.balance(AR, 'c1'), arBefore, 'الأثر الصافي على 113001 صفر');
  assert.equal(s.balance(REV_SALES), 0n);
  assert.equal(s.balance(REV_SERVICE), -100_000n);

  // القيد الأصلي لم يعد حيّاً؛ الحيّ الآن REPOST:1، وإعادة ثانية n = 2
  await rejectsWith(repost(s, factsOf(s, s.state.moves.get(move.id)!)), 'NOT_LIVE_MOVE');
  await rejectsWith(repost(s, factsOf(s, reversal)), 'NOT_POST_SOURCE');
  s.opts.context = {};
  const r2 = await repost(s, factsOf(s, reposted));
  assert.equal(r2.n, 2);
  assert.equal(r2.repost.sourceKey, `${base}:REPOST:2`);
  assert.ok(lineOn(s.state.moves.get(r2.repost.id)!, REV_SALES));
  assert.equal(s.balance(AR, 'c1'), arBefore);
  assert.equal((await s.withPostLock('t1', (tx) => tx.findLiveMove(base))).liveMoveId, r2.repost.id);
});

test('الرفض: غير AUTO، والمؤمَّن LEDGER_SECURED_MOVE، ومصدر حدث REVERSE له DONE — بلا أي كتابة', async () => {
  const { s, move } = await postedInvoice();
  const movesBefore = s.moves().length;
  assert.throws(() => repostPrecheck(factsOf(s, move, { origin: 'MANUAL' })), (e: unknown) => e instanceof RepostRejectedError && e.reason === 'NOT_AUTO_ORIGIN');
  await rejectsWith(repost(s, factsOf(s, move, { origin: 'MANUAL' })), 'NOT_AUTO_ORIGIN');
  await assert.rejects(repost(s, factsOf(s, move, { secureHash: 'abc' })), (e: unknown) => isLedgerError(e, 'LEDGER_SECURED_MOVE'));
  await rejectsWith(repost(s, factsOf(s, move, { sources: [] })), 'NO_SOURCE');

  s.seedEvents([{ sourceKey: invoiceKey('i1', 'REVERSE'), sourceType: 'INVOICE', sourceId: 'i1', event: 'REVERSE', effectAt: at('2027-02-12T08:00:00.000Z'), payload: { invoiceId: 'i1', type: 'CREDIT', entryDate: '2027-02-12' } }]);
  await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 100 }), { log: () => undefined });
  assert.equal(s.event(invoiceKey('i1', 'REVERSE'))!.status, 'DONE');
  const count = s.moves().length;
  assert.equal(count, movesBefore + 1);
  await rejectsWith(repost(s, factsOf(s, move)), 'SOURCE_REVERSED');
  assert.equal(s.moves().length, count, 'لا قيد عكس ولا إعادة بعد الرفض');
});

test('الاستلام (P7) يُعاد بالتقسيم المخزَّن نفسه، فلا يتغير أثره على 111003', async () => {
  const settledAt = '2027-02-10T09:00:00.000Z';
  const custody = () => ({
    receipts: [{ id: 'rc1', salesRepId: 'rep1', amountMilli: 60_000n, effectAt: '2027-02-10T07:00:00.000Z' }],
    onlineReceipts: [], outsideReceipts: [], cashInvoices: [], shortages: [], custodyExpenses: [],
    settlements: [{
      id: 'st1', salesRepId: 'rep1', amountMilli: 100_000n, effectAt: settledAt, createdAt: settledAt,
      nonCustodyClearedMilli: s.event(settlementKey('st1', 'POST'))?.nonCustodyClearedMilli ?? null,
      shortageRecoveredMilli: s.event(settlementKey('st1', 'POST'))?.shortageRecoveredMilli ?? null,
    }],
    routing: { cashInvoice: 'MAIN_CASH' as const, receipt: { CASH: 'CUSTODY' as const } },
  });
  const s: FakePostingStore = new FakePostingStore({ now: () => at('2027-03-01T10:00:00.000Z').getTime(), custody });
  s.setCursor('ACCOUNT_ENTRY', at('2027-02-11T00:00:00.000Z'), 'z');
  s.seedEvents([{
    sourceKey: settlementKey('st1', 'POST'), sourceType: 'SETTLEMENT', sourceId: 'st1', event: 'POST', effectAt: at(settledAt),
    payload: { settlementId: 'st1', amount: '100.00', method: 'CASH', salesRepId: 'rep1', settledAt, createdAt: settledAt, salesRepName: 'مندوب' } as SourceEventPayload,
  }]);
  await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 100 }), { log: () => undefined });
  const ev = s.event(settlementKey('st1', 'POST'))!;
  assert.equal(ev.status, 'DONE');
  assert.equal(ev.nonCustodyClearedMilli, 40_000n, 'covered 60 وr 40');
  const move = s.state.moves.get(ev.moveId!)!;
  const custodyOf = () => s.moves().reduce((t, m) => t + m.lines.filter((l) => l.accountId === CUSTODY).reduce((a, l) => a + l.debitMilli - l.creditMilli, 0n), 0n);
  const before = custodyOf();
  const r = await repost(s, factsOf(s, move));
  const reposted = s.state.moves.get(r.repost.id)!;
  assert.deepEqual(
    reposted.lines.map((l) => [l.accountId, l.debitMilli, l.creditMilli]),
    move.lines.map((l) => [l.accountId, l.debitMilli, l.creditMilli]),
    'التقسيم نفسه',
  );
  assert.equal(custodyOf(), before);
  assert.equal(s.event(settlementKey('st1', 'POST'))!.nonCustodyClearedMilli, 40_000n);
});

test('حارس ثابت: المسار بصلاحية canConfigureLedger، القفل أول await، ثم repostFromSource وإشعار، وسبب العكس الآلي', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ledger', 'moves.ts'), 'utf8');
  const i = src.indexOf("router.post('/moves/:id/repost-from-source'");
  assert.ok(i >= 0);
  const route = src.slice(i, src.indexOf('const REPOST_REJECT_MESSAGES', i));
  assert.match(route, /^router\.post\('\/moves\/:id\/repost-from-source', requireLedgerPermission\('canConfigureLedger'\),/);
  const tx = route.slice(route.indexOf('prisma.$transaction(async (tx) => {'));
  assert.equal(/await\s+([\w.]+)\(/.exec(tx)?.[1], 'acquirePostLock');
  assert.ok(tx.indexOf('repostFromSource(') > tx.indexOf('acquirePostLock('));
  assert.ok(tx.indexOf('notification.create') > tx.indexOf('repostFromSource('));
  assert.match(route, /assertLedgerActivated\(tenantId\)/);
  const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'sync', 'repost.ts'), 'utf8');
  assert.match(service, /auditAction: 'MOVE_REPOST'/);
  assert.doesNotMatch(service, /from '@prisma\/client'|config\/database/, 'repost.ts لا يستورد prisma');
  assert.ok(REPOST_REVERSAL_REASON.trim().length > 0, 'G5: سبب العكس الآلي');
});
