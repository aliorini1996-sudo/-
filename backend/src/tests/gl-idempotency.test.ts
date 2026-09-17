// M3 — الحماية من التكرار في المُرحِّل (DESIGN.md §5.4، §10.1 صف M3: gl-idempotency.test.ts).
// بلا قاعدة: المُرحِّل خلف PostingStore، بمخزن مزيّف يفرض فرادة [tenantId, sourceKey] ويرمي P2002 بشكل Prisma
// مع تراجع كامل لما كُتب في «المعاملة». فحص التزامن الحقيقي (نبضتان متوازيتان على قاعدة فعلية) خطوة يدوية
// موثقة على شركة admin@dsd.com بإذن المالك، لا في CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { accountIdOf } from '../services/gl/testing/fixtures';
import { invoicePayloadFromRows } from '../services/gl/builders/invoice';
import { arEntryKey, invoiceKey, receiptKey, settlementKey } from '../services/gl/sync/keys';
import { createSyncBudget, postSourceEvent, runPoster, missingAutoSalePercents } from '../services/gl/sync/poster';
import { decodeEventNote } from '../services/gl/sync/classify';
import { ERROR_BACKOFF_MS, MAX_ERROR_ATTEMPTS, type DesiredEvent, type SourceEventPayload } from '../services/gl/sync/types';
import { FakePostingStore, p2002 } from './gl-fake-posting-store';

const AR = accountIdOf('113001');
const at = (iso: string) => new Date(iso);

function clockAt(iso: string) {
  let t = at(iso).getTime();
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (s: string) => { t = at(s).getTime(); } };
}

function invoiceEvent(id: string, opts: { total?: number; taxPct?: number; type?: 'CREDIT' | 'CASH' | 'RETURN'; entryDate?: string; createdAt?: string; customerId?: string } = {}): DesiredEvent {
  const total = opts.total ?? 115;
  const taxPct = opts.taxPct ?? 15;
  const net = +(total / (1 + taxPct / 100)).toFixed(2);
  const tax = +(total - net).toFixed(2);
  const entryDate = opts.entryDate ?? '2027-02-10';
  const payload = invoicePayloadFromRows({
    invoice: { id, number: `INV-${id}`, type: opts.type ?? 'CREDIT', customerId: opts.customerId ?? 'c1', salesRepId: null, pricesIncludeTax: false, subtotal: net, discountAmt: 0, taxAmt: tax, total },
    items: total === 0 ? [] : [{ qty: 1, unitPrice: net, taxPct, taxAmt: tax, lineTotal: total }],
    customerName: 'عميل أول', entryDate, currency: 'SAR', currencyDecimals: 2,
  });
  return {
    sourceKey: invoiceKey(id, 'POST'), sourceType: 'INVOICE', sourceId: id, event: 'POST', effectAt: at(`${entryDate}T08:00:00.000Z`),
    payload: { ...payload, sourceCreatedAt: opts.createdAt ?? `${entryDate}T08:00:00.000Z` } as SourceEventPayload,
  };
}

function invoiceReverseEvent(id: string, entryDate = '2027-02-12', type: 'CREDIT' | 'CASH' | 'RETURN' = 'CREDIT'): DesiredEvent {
  return {
    sourceKey: invoiceKey(id, 'REVERSE'), sourceType: 'INVOICE', sourceId: id, event: 'REVERSE', effectAt: at(`${entryDate}T08:00:00.000Z`),
    payload: { invoiceId: id, type, entryDate, sourceCreatedAt: `${entryDate}T08:00:00.000Z` },
  };
}

function store(opts: ConstructorParameters<typeof FakePostingStore>[0] = {}) {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now, ...opts });
  return { s, clock };
}

const run = (s: FakePostingStore, events = 300) => runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events }), { log: () => undefined });

test('إعادة التشغيل: قيد واحد وDONE ولا أرصدة شهرية مضاعفة', async () => {
  const { s } = store();
  s.seedEvents([invoiceEvent('i1')]);
  const r1 = await run(s);
  assert.equal(r1.done, 1);
  const r2 = await run(s);
  assert.equal(r2.attempted, 0);
  assert.equal(s.moves().length, 1);
  const ev = s.event(invoiceKey('i1', 'POST'))!;
  assert.equal(ev.status, 'DONE');
  assert.equal(ev.moveId, s.moves()[0].id);
  assert.equal(s.balance(AR, 'c1'), 115_000n);
  assert.equal(s.periodBalanceTotal(AR), 115_000n);
  // إدراج الحدث نفسه مجدداً (المُطابِق/شبكة الأمان) لا يضيف شيئاً
  assert.equal(s.seedEvents([invoiceEvent('i1')]), 0);
  await run(s);
  assert.equal(s.moves().length, 1);
});

test('P2002 على [tenantId, sourceKey]: نبضتان تبنيان الحدث نفسه ⇒ DONE بـmoveId الأول بلا قيد يتيم', async () => {
  const { s } = store();
  s.seedEvents([invoiceEvent('i2')]);
  const ev = s.event(invoiceKey('i2', 'POST'))!;
  const stale = structuredClone(ev);
  // النبضة الأولى ترحّل
  await postSourceEvent(s, s.settings, stale, { log: () => undefined });
  const first = s.event(invoiceKey('i2', 'POST'))!.moveId!;
  assert.ok(first);
  // النبضة الثانية قرأت الحدث PENDING قبل التزام الأولى: نحاكي ذلك بإرجاع الحالة دون مسّ الربط
  Object.assign(s.event(invoiceKey('i2', 'POST'))!, { status: 'PENDING', moveId: null });
  const out = await postSourceEvent(s, s.settings, stale, { log: () => undefined });
  assert.deepEqual(out, { status: 'DONE', moveId: first, idempotent: true });
  assert.equal(s.moves().length, 1, 'لا قيد يتيم: المعاملة الساقطة تراجعت كاملة');
  assert.equal(s.periodBalanceTotal(AR), 115_000n);
  assert.equal(s.event(invoiceKey('i2', 'POST'))!.status, 'DONE');
  assert.equal(s.event(invoiceKey('i2', 'POST'))!.moveId, first);
});

test('P2002 بهدف [tenantId, number] ⇒ تراجع وattempts++ ثم ERROR نهائي بعد خمس، لا DONE ولا ربط', async () => {
  const { s, clock } = store({ beforePostMove: () => { throw p2002(['tenantId', 'number']); } });
  s.seedEvents([invoiceEvent('i3')]);
  const key = invoiceKey('i3', 'POST');
  for (let i = 1; i <= MAX_ERROR_ATTEMPTS; i++) {
    const r = await run(s);
    assert.equal(r.errors, 1, `محاولة ${i}`);
    const ev = s.event(key)!;
    assert.equal(ev.status, 'ERROR');
    assert.equal(ev.attempts, i);
    assert.equal(ev.moveId, null);
    if (i < MAX_ERROR_ATTEMPTS) {
      assert.equal(ev.nextAttemptAt!.getTime(), clock.now() + ERROR_BACKOFF_MS[i - 1]);
      // قبل الموعد لا يُلتقط
      assert.equal((await run(s)).attempted, 0);
      clock.advance(ERROR_BACKOFF_MS[i - 1]);
    } else {
      assert.equal(ev.nextAttemptAt, null);
    }
  }
  clock.advance(24 * 3600_000);
  assert.equal((await run(s)).attempted, 0, 'ERROR النهائي لا يُعاد');
  assert.equal(s.moves().length, 0);
  assert.equal(s.state.sources.size, 0);
  assert.equal(s.periodBalanceTotal(AR), 0n);
});

test('REVERSE لمصدر عُكس قيده الحيّ مسبقاً ⇒ DONE بـmoveId العكس القائم دون خطأ reversedMoveId', async () => {
  const { s } = store();
  s.seedEvents([invoiceEvent('i4')]);
  await run(s);
  const live = s.event(invoiceKey('i4', 'POST'))!.moveId!;
  // عكس سابق (مثلاً «إعادة الترحيل من المصدر» أو عكس آلي ساقط الحالة)
  const rev = await s.withPostLock('t1', (tx) => tx.reverseMove({ moveId: live, actor: { actorType: 'SYSTEM', actorId: null, impersonated: false }, reason: 'اختبار', mode: 'SYSTEM' }));
  s.seedEvents([invoiceReverseEvent('i4')]);
  const r = await run(s);
  assert.equal(r.errors, 0);
  const ev = s.event(invoiceKey('i4', 'REVERSE'))!;
  assert.equal(ev.status, 'DONE');
  assert.equal(ev.moveId, rev.reversal.id);
  assert.equal(s.moves().length, 2);
  assert.equal(s.balance(AR, 'c1'), 0n);
});

test('REVERSE بعد POST DONE ⇒ عكس القيد الحيّ بتاريخ صف العكس', async () => {
  const { s } = store();
  s.seedEvents([invoiceEvent('i5'), invoiceReverseEvent('i5', '2027-02-20')]);
  const r = await run(s);
  assert.equal(r.done, 2);
  const rev = s.moves().find((m) => m.reversedMoveId)!;
  assert.equal(rev.date, '2027-02-20');
  assert.equal(s.balance(AR, 'c1'), 0n);
});

test('فاتورة SKIPPED(ZERO_VALUE) لا تحبس عكسها', async () => {
  const { s } = store();
  s.seedEvents([invoiceEvent('z1', { total: 0 }), invoiceReverseEvent('z1')]);
  const r = await run(s);
  assert.equal(r.blocked, 0);
  assert.equal(s.event(invoiceKey('z1', 'POST'))!.skipReason, 'ZERO_VALUE');
  assert.equal(s.event(invoiceKey('z1', 'REVERSE'))!.status, 'SKIPPED');
  assert.equal(s.event(invoiceKey('z1', 'REVERSE'))!.skipReason, 'ZERO_VALUE');
  assert.equal(s.moves().length, 0);
});

test('AR_ENTRY:<id>:POST مُدرج مسبقاً DONE ثم تشغيل المُطابِق على صفه ⇒ قيد واحد بالضبط', async () => {
  const { s } = store();
  const payload = {
    entryId: 'e1', customerId: 'c2', customerName: 'عميل ثانٍ', debit: '50.00', credit: '0.00', description: 'رصيد', entryDate: '2027-02-05T08:00:00.000Z',
    createdAt: '2027-02-05T08:00:00.000Z', origin: 'IMPORT' as const, sourceCreatedAt: '2027-02-05T08:00:00.000Z',
  };
  const ev: DesiredEvent = { sourceKey: arEntryKey('e1'), sourceType: 'AR_ENTRY', sourceId: 'e1', event: 'POST', effectAt: at('2027-02-05T08:00:00.000Z'), payload };
  s.seedEvents([ev]);
  await run(s);
  assert.equal(s.moves().length, 1);
  assert.equal(s.seedEvents([ev]), 0, 'skipDuplicates');
  await run(s);
  assert.equal(s.moves().length, 1);
  assert.equal(s.balance(AR, 'c2'), 50_000n);
});

test('استيراد بعد البدء بمساري العدالة (خطة الاستيراد 4 و7): إعادة التشغيل وP2002 على مفتاح AR_ENTRY واحد ⇒ قيد واحد ولا مفتاح يتيم', async () => {
  const { s } = store();
  // المخزن يعلن ترشيح النوع (ولا يطبّقه): المُرحِّل يرشّح المسار بنفسه فلا يُعالج حدث مرتين
  Object.assign(s, { filtersDueEventsBySourceType: true });
  const payload = {
    entryId: 'e9', customerId: 'c3', customerName: 'عميل ثالث', debit: '80.00', credit: '0.00', description: 'كشف', entryDate: '2027-02-05T08:00:00.000Z',
    createdAt: '2027-02-06T08:00:00.000Z', origin: 'IMPORT' as const, sourceCreatedAt: '2027-02-06T08:00:00.000Z',
  };
  const ev: DesiredEvent = { sourceKey: arEntryKey('e9'), sourceType: 'AR_ENTRY', sourceId: 'e9', event: 'POST', effectAt: at('2027-02-05T08:00:00.000Z'), payload };
  s.seedEvents([ev, invoiceEvent('i9')]);
  const stale = structuredClone(s.event(arEntryKey('e9'))!);
  const r1 = await run(s);
  assert.deepEqual([r1.done, r1.lanes?.live, r1.lanes?.import], [2, 1, 1]);
  const moveId = s.event(arEntryKey('e9'))!.moveId!;
  assert.equal(s.moves().find((m) => m.id === moveId)!.needsAttention, true, 'حركة مستوردة بعد البدء ⇒ يحتاج انتباهاً');
  assert.equal((await run(s)).attempted, 0);
  assert.equal(s.seedEvents([ev]), 0);
  // نبضة ثانية قرأت الحدث PENDING قبل التزام الأولى ⇒ P2002 على [tenantId, sourceKey] ⇒ DONE بالربط القائم
  Object.assign(s.event(arEntryKey('e9'))!, { status: 'PENDING', moveId: null });
  const out = await postSourceEvent(s, s.settings, stale, { log: () => undefined });
  assert.deepEqual(out, { status: 'DONE', moveId, idempotent: true });
  assert.equal(s.moves().filter((m) => m.sourceId === 'e9').length, 1, 'لا قيد ثانٍ');
  assert.deepEqual([...s.state.sources.keys()].filter((k) => k.startsWith('AR_ENTRY:e9')), [arEntryKey('e9')], 'لا مفتاح يتيم');
  assert.equal(s.balance(AR, 'c3'), 80_000n);
});

test('BLOCKED: التراجع 1m ثم 5m ثم 30m ثم 2h، وإعادة الفحص لا تُحتسب في ميزانية الأحداث', async () => {
  const { s, clock } = store({ origin: () => ({ originEffectAt: at('2027-02-01T08:00:00.000Z'), originCreatedAt: at('2027-02-01T08:00:00.000Z'), sourceExists: true }) });
  s.seedEvents([invoiceEvent('b1', { entryDate: '2027-02-01' })]);
  Object.assign(s.event(invoiceKey('b1', 'POST'))!, { status: 'HELD', lastError: 'HELD:MISSING_MAPPING' });
  s.seedEvents([invoiceReverseEvent('b1', '2027-02-02')]);
  const key = invoiceKey('b1', 'REVERSE');
  const steps = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 2 * 3600_000];
  for (let i = 0; i < steps.length; i++) {
    const r = await run(s, 1);
    const ev = s.event(key)!;
    assert.equal(ev.status, 'BLOCKED');
    const note = decodeEventNote(ev.lastError);
    assert.deepEqual(note && note.kind === 'BLOCKED' ? [note.reason, note.step] : null, ['SIBLING_NOT_FINAL', i]);
    assert.equal(ev.nextAttemptAt!.getTime(), clock.now() + steps[i]);
    if (i > 0) {
      assert.equal(r.blockedRechecks, 1);
      assert.equal(r.attempted, 0, 'إعادة الفحص خارج الميزانية');
    }
    clock.advance(steps[i]);
  }
  assert.equal(s.event(key)!.attempts, 0);
});

test('HELD(MISSING_MAPPING) لحساب ناقص، وHELD(CURRENCY_MISMATCH) لعملة مختلفة', async () => {
  const { s } = store({ context: { mappings: { AR_CONTROL: null } } });
  s.seedEvents([invoiceEvent('h1')]);
  const r = await run(s);
  assert.equal(r.held, 1);
  const note = decodeEventNote(s.event(invoiceKey('h1', 'POST'))!.lastError);
  assert.equal(note?.kind === 'HELD' ? note.reason : null, 'MISSING_MAPPING');
  assert.equal(s.moves().length, 0);

  const { s: s2 } = store({ settings: { companyCurrency: 'USD' } });
  s2.seedEvents([invoiceEvent('h2')]);
  await run(s2);
  const n2 = decodeEventNote(s2.event(invoiceKey('h2', 'POST'))!.lastError);
  assert.equal(s2.event(invoiceKey('h2', 'POST'))!.status, 'HELD');
  assert.equal(n2?.kind === 'HELD' ? n2.reason : null, 'CURRENCY_MISMATCH');
});

test('التزام M2 (5): ضريبة AUTO_SALE_<pct> تُنشأ قبل postMove ويُعاد البناء عليها', async () => {
  const { s } = store();
  s.seedEvents([invoiceEvent('a5', { total: 105, taxPct: 5 })]);
  const r = await run(s);
  assert.equal(r.done, 1);
  assert.deepEqual(s.ensureCalls, [[5]]);
  const taxLines = s.moves()[0].lines.filter((l) => l.taxRole === 'TAX');
  assert.equal(taxLines.length, 1);
  assert.equal(taxLines[0].taxId, 'tax_AUTO_SALE_5');
  // فاتورة ثانية بالنسبة نفسها لا تنشئها مجدداً
  s.seedEvents([invoiceEvent('a6', { total: 105, taxPct: 5 })]);
  await run(s);
  assert.deepEqual(s.ensureCalls, [[5]]);
  assert.deepEqual(missingAutoSalePercents({ kind: 'NO_MOVE', reason: 'ZERO_VALUE' }, s.context()), []);
});

test('P7: SETTLEMENT_ORDER حتى يتجاوز مؤشر ACCOUNT_ENTRY الاستلام، ثم DONE مع r المخزّن (التزام 3 و8)', async () => {
  const receiptAt = '2027-02-10T07:00:00.000Z';
  const custody = () => ({
    receipts: [], onlineReceipts: [{ id: 'r1', salesRepId: 'rep1', amountMilli: 40_000n, effectAt: receiptAt }],
    outsideReceipts: [], cashInvoices: [], shortages: [], custodyExpenses: [],
    settlements: [{ id: 'old', salesRepId: 'rep1', amountMilli: 10_000n, effectAt: '2027-02-09T07:00:00.000Z', nonCustodyClearedMilli: 10_000n, shortageRecoveredMilli: 0n }],
    routing: { cashInvoice: 'MAIN_CASH' as const },
  });
  const { s, clock } = store({ custody });
  const payload = {
    settlementId: 'st1', amount: '100.00', method: 'CASH', salesRepId: 'rep1', settledAt: '2027-02-10T09:00:00.000Z',
    createdAt: '2027-02-10T09:00:00.000Z', salesRepName: 'مندوب', sourceCreatedAt: '2027-02-10T09:00:00.000Z',
  };
  s.seedEvents([{ sourceKey: settlementKey('st1', 'POST'), sourceType: 'SETTLEMENT', sourceId: 'st1', event: 'POST', effectAt: at(payload.settledAt), payload }]);
  s.setCursor('ACCOUNT_ENTRY', at('2027-02-10T08:00:00.000Z'), 'x');
  await run(s);
  const blocked = s.event(settlementKey('st1', 'POST'))!;
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(decodeEventNote(blocked.lastError)?.kind, 'BLOCKED');
  // سند للمندوب PENDING قبل الاستلام يحبسه أيضاً
  s.setCursor('ACCOUNT_ENTRY', at('2027-02-10T10:00:00.000Z'), 'y');
  s.seedEvents([{ sourceKey: receiptKey('rx', 'POST'), sourceType: 'RECEIPT', sourceId: 'rx', event: 'POST', effectAt: at('2027-02-10T06:00:00.000Z'), payload: { receiptId: 'rx', salesRepId: 'rep1', paymentMethod: 'CASH', amount: '0.00', customerId: 'c1', entryDate: '2027-02-10', sourceCreatedAt: '2027-02-10T06:00:00.000Z' } }]);
  clock.advance(60_000);
  await run(s);
  // السند الصفري SKIPPED(ZERO_VALUE) في النبضة نفسها، فيُفحص الاستلام بعد موعده
  clock.advance(5 * 60_000);
  await run(s);
  const ev = s.event(settlementKey('st1', 'POST'))!;
  assert.equal(ev.status, 'DONE');
  // لا عهدة في الأستاذ ⇒ covered = 0 وr = 100
  assert.equal(ev.nonCustodyClearedMilli, 100_000n);
  const move = s.moves().find((m) => m.id === ev.moveId)!;
  const suspense = move.lines.filter((l) => l.accountId === accountIdOf('911001')).reduce((a, l) => a + l.creditMilli, 0n);
  // الاستلام السابق (02-09) سبق السند الإلكتروني فقُيد r=10 كله معلّقاً ⇒ priorSuspense = 10 (التزام 3)،
  // والزائد التراكمي الآن 10 + 100 − 40 = 70 ⇒ يُقيد منه 70 − 10 = 60 فقط
  assert.equal(suspense, 60_000n);
  assert.ok(move.needsAttention);
});

test('حارس ثابت: poster.ts لا يستورد prisma بل PostingStore', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'sync', 'poster.ts'), 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l) || /require\(/.test(l));
  for (const l of imports) {
    assert.doesNotMatch(l, /@prisma\/client|config\/database|postingStore\.prisma|reconcilerStore\.prisma/, l);
  }
  assert.match(src, /from '\.\/postingStore'/);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /(^|[^.\w])prisma\s*\./m, 'لا استدعاء prisma.* في poster.ts');
});
