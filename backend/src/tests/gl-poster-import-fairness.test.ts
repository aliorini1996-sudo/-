// استيراد البيانات إلى الدفاتر — البند 4 (أ، ب، ج) والبند 7 (أ) من خطة إصلاح التكامل (DESIGN.md §5.4، §5.5 P11، §5.6).
// بلا قاعدة: FakePostingStore موسَّعاً بترشيح النوع (مسارا العدالة) ومرشّحي حسم OPENING الجماعي كما يفعلهما
// PrismaPostingStore. المتجهات: آلاف SKIPPED(OPENING) بمعاملات قليلة؛ فاتورة حية واحدة تُرحَّل في النبضة الأولى رغم
// آلاف أحداث الاستيراد الأقدم؛ نسبة ~60٪ للحي؛ علامة «يحتاج انتباهاً» لحركة مستوردة بعد البدء فقط؛ تقدير الزمن من
// الإنتاجية المقيسة أو الحد المتحفظ؛ وحراس ثابتة لفهرس المخطط ولشرط updateMany.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { accountIdOf } from '../services/gl/testing/fixtures';
import { invoicePayloadFromRows } from '../services/gl/builders/invoice';
import { arEntryKey, invoiceKey } from '../services/gl/sync/keys';
import {
  createSyncBudget, cutoverContextOf, laneOf, markImportAfterCutover, openingCandidateQualifies, runPoster,
} from '../services/gl/sync/poster';
import type { ListDueEventsOptions, OpeningImportCandidate, PostingTx, WithPostLockOptions } from '../services/gl/sync/postingStore';
import {
  IMPORT_AFTER_CUTOVER_ATTENTION_REASON, OPENING_BULK_BATCH_SIZE, POSTER_LANE_PATTERN, SYNC_HEARTBEAT_MS, TICK_DB_BUDGET_MS, TICK_EVENT_BUDGET,
  type CompositeKey, type DesiredEvent, type SourceEventPayload, type SourceEventRecord,
} from '../services/gl/sync/types';
import {
  CONSERVATIVE_MS_PER_EVENT, MIN_MEASURED_EVENTS, backfillProgress, conservativeEventsPerMinute, estimateHistory, measuredEventsPerMinute,
} from '../services/gl/backfill';
import type { MoveDraft } from '../services/gl/types';
import { FakePostingStore } from './gl-fake-posting-store';

const AR = accountIdOf('113001');
const OPEQ = accountIdOf('319002');
const at = (iso: string) => new Date(iso);
const quiet = { log: () => undefined };

function clockAt(iso: string) {
  let t = at(iso).getTime();
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** FakePostingStore بما يضيفه PrismaPostingStore: ترشيح listDueEvents بالنوع، ومرشّحو حسم OPENING داخل المعاملة */
class LaneStore extends FakePostingStore {
  readonly filtersDueEventsBySourceType = true;
  bulkBatches = 0;
  lastListed: ListDueEventsOptions | null = null;

  async listDueEvents(t: string, opts: ListDueEventsOptions): Promise<SourceEventRecord[]> {
    this.lastListed = opts;
    const all = await super.listDueEvents(t, { ...opts, limit: Number.MAX_SAFE_INTEGER });
    const f = opts.sourceTypes;
    return all
      .filter((e) => !f || (f.in ? f.in.includes(e.sourceType) : f.notIn ? !f.notIn.includes(e.sourceType) : true))
      .slice(0, opts.limit);
  }

  async withPostLock<T>(tenantId: string, fn: (tx: PostingTx) => Promise<T>, opts?: WithPostLockOptions): Promise<T> {
    return super.withPostLock(tenantId, (tx) => fn(this.extend(tx)), opts);
  }

  private extend(tx: PostingTx): PostingTx {
    const store = this;
    const ext: Pick<PostingTx, 'listOpeningImportCandidates' | 'skipOpeningImports'> = {
      async listOpeningImportCandidates(o: { before: Date; after: CompositeKey | null; limit: number }): Promise<OpeningImportCandidate[]> {
        store.bulkBatches++;
        const key = (e: SourceEventRecord): [number, string] => [e.effectAt.getTime(), e.id];
        const gt = (a: [number, string], b: CompositeKey) => a[0] > b.at.getTime() || (a[0] === b.at.getTime() && a[1] > b.id);
        return [...store.state.events.values()]
          .filter((e) => e.sourceType === 'AR_ENTRY' && e.event === 'POST' && ['PENDING', 'BLOCKED', 'ERROR'].includes(e.status)
            && e.effectAt.getTime() < o.before.getTime() && (!o.after || gt(key(e), o.after)))
          .sort((a, b) => a.effectAt.getTime() - b.effectAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, o.limit)
          .map((e) => {
            const p = e.payload as Record<string, unknown> | null;
            return {
              id: e.id, sourceKey: e.sourceKey, sourceId: e.sourceId, effectAt: e.effectAt, status: e.status,
              createdAtHint: p ? (p.sourceCreatedAt ?? p.createdAt ?? null) : null,
              reverseStatus: store.state.events.get(arEntryKey(e.sourceId, 'REVERSE'))?.status ?? null,
            };
          });
      },
      async skipOpeningImports(ids: readonly string[], now: Date): Promise<number> {
        const set = new Set(ids);
        let n = 0;
        for (const e of store.state.events.values()) {
          if (!set.has(e.id) || e.sourceType !== 'AR_ENTRY' || e.event !== 'POST' || !['PENDING', 'BLOCKED', 'ERROR'].includes(e.status)) continue;
          Object.assign(e, { status: 'SKIPPED', skipReason: 'OPENING', processedAt: now, lastError: null, nextAttemptAt: null });
          n++;
        }
        return n;
      },
    };
    return Object.assign(Object.create(tx) as PostingTx, ext);
  }
}

function arEvent(id: string, opts: { entryDate: string; createdAt: string; debit?: string; credit?: string; customerId?: string }): DesiredEvent {
  const payload = {
    entryId: id, customerId: opts.customerId ?? 'c1', customerName: 'عميل مستورد', debit: opts.debit ?? '10.00', credit: opts.credit ?? '0.00',
    description: 'رصيد', entryDate: opts.entryDate, createdAt: opts.createdAt, origin: 'IMPORT' as const, sourceCreatedAt: opts.createdAt,
  };
  return { sourceKey: arEntryKey(id), sourceType: 'AR_ENTRY', sourceId: id, event: 'POST', effectAt: at(opts.entryDate), payload };
}

function invoiceEvent(id: string, entryDate: string): DesiredEvent {
  const payload = invoicePayloadFromRows({
    invoice: { id, number: `INV-${id}`, type: 'CREDIT', customerId: 'c9', salesRepId: null, pricesIncludeTax: false, subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115 },
    items: [{ qty: 1, unitPrice: 100, taxPct: 15, taxAmt: 15, lineTotal: 115 }],
    customerName: 'عميل حي', entryDate, currency: 'SAR', currencyDecimals: 2,
  });
  return {
    sourceKey: invoiceKey(id, 'POST'), sourceType: 'INVOICE', sourceId: id, event: 'POST', effectAt: at(`${entryDate}T08:00:00.000Z`),
    payload: { ...payload, sourceCreatedAt: `${entryDate}T08:00:00.000Z` } as SourceEventPayload,
  };
}

// البدء 2027-01-01 بتوقيت الرياض (= 2026-12-31T21:00Z)، واللقطة T0 = 2027-01-15T09:00Z (إعدادات المخزن المزيّف)

// ═══ (أ) حسم OPENING جماعياً ═══

test('(4 أ) 4000 حدث OPENING تُحسم SKIPPED(OPENING) بتسع معاملات لا 4000، بلا قيود ولا استهلاك لميزانية الأحداث', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new LaneStore({ now: clock.now });
  const events: DesiredEvent[] = [];
  for (let i = 0; i < 4000; i++) {
    events.push(arEvent(`o${String(i).padStart(4, '0')}`, { entryDate: '2026-12-20T08:00:00.000Z', createdAt: '2027-01-10T08:00:00.000Z', customerId: `c${i % 40}` }));
  }
  // وصول متأخر (أُنشئ بعد T0): ليس OPENING ⇒ يبقى للمسار الفردي فيُرحَّل بتاريخ البدء
  events.push(arEvent('late', { entryDate: '2026-12-25T08:00:00.000Z', createdAt: '2027-02-01T08:00:00.000Z' }));
  // شقيق REVERSE غير نهائي ⇒ الحسم الجماعي يتركه (المسار الفردي يحسمه OPENING بالقاعدة نفسها)
  events.push(arEvent('withrev', { entryDate: '2026-12-26T08:00:00.000Z', createdAt: '2027-01-10T08:00:00.000Z' }));
  s.seedEvents(events);
  s.seedEvents([{ ...arEvent('withrev', { entryDate: '2026-12-26T08:00:00.000Z', createdAt: '2027-01-10T08:00:00.000Z' }), sourceKey: arEntryKey('withrev', 'REVERSE'), event: 'REVERSE', effectAt: at('2027-02-20T08:00:00.000Z') }]);
  // بلا createdAt نصي ⇒ لا يُحسم جماعياً (المسار الفردي يقرأ المصدر)
  const noHint = arEvent('nohint', { entryDate: '2026-12-27T08:00:00.000Z', createdAt: '2027-01-10T08:00:00.000Z' });
  s.seedEvents([{ ...noHint, payload: { ...(noHint.payload as Record<string, unknown>), createdAt: undefined, sourceCreatedAt: undefined } as unknown as SourceEventPayload }]);

  const locksBefore = s.lockCalls;
  const r = await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 5, clock: clock.now }), quiet);
  assert.equal(r.bulkOpeningSkipped, 4000);
  assert.equal(s.bulkBatches, Math.ceil(4003 / OPENING_BULK_BATCH_SIZE), 'معاملة لكل دفعة من المئات');
  assert.ok(s.lockCalls - locksBefore <= s.bulkBatches + 5 + 2, 'لا معاملة لكل حدث مشمول');
  let skipped = 0;
  for (const e of s.state.events.values()) if (e.sourceKey.startsWith('AR_ENTRY:o') && e.status === 'SKIPPED' && e.skipReason === 'OPENING' && e.processedAt) skipped++;
  assert.equal(skipped, 4000);
  assert.equal(s.event(arEntryKey('late'))!.status, 'DONE', 'الوصول المتأخر رُحّل فردياً');
  assert.equal(s.event(arEntryKey('withrev'))!.skipReason, 'OPENING', 'المسار الفردي حسمه بعد الحسم الجماعي');
  const late = s.moves().find((m) => m.sourceId === 'late')!;
  assert.deepEqual([late.date, late.lateArrival, late.needsAttention], ['2027-01-01', true, false], 'الوصول المتأخر بلا علامة البند 7');
  assert.equal(s.moves().filter((m) => m.sourceId?.startsWith('o')).length, 0);
  assert.ok(r.attempted <= 5, 'الحسم الجماعي لا يستهلك ميزانية الأحداث');
  // نبضة ثانية: لا مرشّحين مؤهلين ⇒ لا حسم ولا قيود جديدة
  const r2 = await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 50, clock: clock.now }), quiet);
  assert.equal(r2.bulkOpeningSkipped ?? 0, 0);
  // بلا createdAt في الحمولة يقرّر المسار الفردي من المصدر (غائب هنا ⇒ detectedAt بعد T0 ⇒ وصول متأخر)، لا الحسم الجماعي
  assert.notEqual(s.event(arEntryKey('nohint'))!.skipReason, 'OPENING');
  assert.equal(s.event(arEntryKey('nohint'))!.status, 'DONE');
});

test('(4 أ) الحسم الجماعي يطابق القاعدة الفردية: OPENING فقط، ولا شقيق REVERSE غير نهائي، ولا حالة نهائية', () => {
  const s = new FakePostingStore();
  const cut = cutoverContextOf(s.settings);
  const base = { effectAt: at('2026-12-31T20:59:59.999Z'), status: 'PENDING' as const, createdAtHint: '2027-01-15T09:00:00.000Z', reverseStatus: null };
  assert.equal(openingCandidateQualifies(base, cut), true, 'آخر لحظة قبل البدء محلياً وcreatedAt = T0');
  assert.equal(openingCandidateQualifies({ ...base, effectAt: at('2026-12-31T21:00:00.000Z') }, cut), false, 'يوم البدء ليس افتتاحاً');
  assert.equal(openingCandidateQualifies({ ...base, createdAtHint: '2027-01-15T09:00:00.001Z' }, cut), false, 'بعد اللقطة = وصول متأخر');
  assert.equal(openingCandidateQualifies({ ...base, reverseStatus: 'PENDING' }, cut), false);
  assert.equal(openingCandidateQualifies({ ...base, reverseStatus: 'HELD' }, cut), false);
  assert.equal(openingCandidateQualifies({ ...base, reverseStatus: 'DONE' }, cut), true);
  assert.equal(openingCandidateQualifies({ ...base, status: 'HELD' as never }, cut), false);
  assert.equal(openingCandidateQualifies({ ...base, status: 'ERROR' }, cut), true);
  assert.equal(openingCandidateQualifies({ ...base, createdAtHint: null }, cut), false);
  assert.equal(openingCandidateQualifies({ ...base, createdAtHint: 'not a date' }, cut), false);
});

test('(4 أ) لا حسم جماعي للطريقة بلا تاريخ بدء أو مع اختلاف العملة، ومخزن بلا الدالتين يعمل كما كان', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const ev = arEvent('x1', { entryDate: '2026-12-20T08:00:00.000Z', createdAt: '2027-01-10T08:00:00.000Z' });
  const mismatch = new LaneStore({ now: clock.now, settings: { companyCurrency: 'USD' } });
  mismatch.seedEvents([ev]);
  const r = await runPoster(mismatch, mismatch.settings, createSyncBudget({ timeMs: 60_000, clock: clock.now }), quiet);
  assert.equal(r.bulkOpeningSkipped ?? 0, 0);
  assert.equal(mismatch.bulkBatches, 0);
  assert.equal(mismatch.event(arEntryKey('x1'))!.status, 'HELD', 'المسار الفردي يحجز اختلاف العملة أولاً');
  // المخزن المزيّف الأصلي (بلا listOpeningImportCandidates ولا ترشيح نوع): المسار الفردي يحسم OPENING
  const plain = new FakePostingStore({ now: clock.now });
  plain.seedEvents([ev]);
  const r2 = await runPoster(plain, plain.settings, createSyncBudget({ timeMs: 60_000, clock: clock.now }), quiet);
  assert.equal(r2.bulkOpeningSkipped, undefined);
  assert.equal(r2.lanes, undefined);
  assert.equal(plain.event(arEntryKey('x1'))!.skipReason, 'OPENING');
});

test('(4 أ) الحسم الجماعي لا يستهلك أكثر من نصف الزمن المتبقي', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new LaneStore({ now: clock.now });
  const events: DesiredEvent[] = [];
  for (let i = 0; i < 3 * OPENING_BULK_BATCH_SIZE; i++) events.push(arEvent(`t${String(i).padStart(4, '0')}`, { entryDate: '2026-12-20T08:00:00.000Z', createdAt: '2027-01-10T08:00:00.000Z' }));
  s.seedEvents(events);
  // كل دفعة «تستغرق» 1.1 ثانية من ميزانية 3 ثوانٍ ⇒ الدفعة الثانية تتجاوز الحصة (1.5 ثانية) فيتوقف قبل الثالثة
  const orig = s.withPostLock.bind(s);
  s.withPostLock = async (t, fn, o) => orig(t, async (tx) => { const v = await fn(tx); clock.advance(1100); return v; }, o);
  const r = await runPoster(s, s.settings, createSyncBudget({ timeMs: TICK_DB_BUDGET_MS, clock: clock.now }), quiet);
  assert.equal(s.bulkBatches, 2);
  assert.equal(r.bulkOpeningSkipped, 2 * OPENING_BULK_BATCH_SIZE);
});

test('(مراجعة 2) 5000 وصول متأخر قبل البدء (كشف تاريخي بعد التفعيل) ⇒ دفعة مسح واحدة لا عشر، والميزانية للمسار الفردي', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new LaneStore({ now: clock.now });
  const events: DesiredEvent[] = [];
  for (let i = 0; i < 5000; i++) {
    events.push(arEvent(`h${String(i).padStart(4, '0')}`, { entryDate: '2026-12-20T08:00:00.000Z', createdAt: '2027-02-25T08:00:00.000Z', customerId: `c${i % 50}` }));
  }
  s.seedEvents(events);
  // كل معاملة تحت القفل «تستغرق» 50ms من ميزانية النبضة (3 ثوانٍ)
  let bulkMs = 0;
  const orig = s.withPostLock.bind(s);
  s.withPostLock = async (t, fn, o) => orig(t, async (tx) => {
    const before = s.bulkBatches;
    const v = await fn(tx);
    clock.advance(50);
    if (s.bulkBatches > before) bulkMs += 50;
    return v;
  }, o);
  const r = await runPoster(s, s.settings, createSyncBudget({ timeMs: TICK_DB_BUDGET_MS, clock: clock.now }), quiet);
  assert.ok(s.bulkBatches <= 1, `دفعات المسح ${s.bulkBatches}`);
  assert.equal(r.bulkOpeningSkipped ?? 0, 0);
  assert.ok(bulkMs <= 50, 'لا زمن على دفعات مسح إضافية');
  assert.ok(r.attempted > 0, 'المسار الفردي يأخذ الميزانية');
  const done = [...s.state.events.values()].filter((e) => e.sourceKey.startsWith('AR_ENTRY:h') && e.status === 'DONE').length;
  assert.equal(done, r.attempted);
  assert.ok(s.moves().filter((m) => m.sourceId?.startsWith('h')).every((m) => m.lateArrival && m.date === '2027-01-01'), 'وصول متأخر بتاريخ البدء');
  // النبضة التالية: دفعة مسح واحدة أيضاً
  const b1 = s.bulkBatches;
  await runPoster(s, s.settings, createSyncBudget({ timeMs: TICK_DB_BUDGET_MS, clock: clock.now }), quiet);
  assert.ok(s.bulkBatches - b1 <= 1);
});

// ═══ (ب) العدالة ═══

test('(4 ب) 2000 حدث استيراد أقدم وفاتورة حية واحدة ⇒ الفاتورة تُرحَّل في النبضة الأولى، والمخزن القديم لا يصلها', async () => {
  const seed = (s: FakePostingStore) => {
    const events: DesiredEvent[] = [];
    for (let i = 0; i < 2000; i++) {
      events.push(arEvent(`a${String(i).padStart(4, '0')}`, { entryDate: `2027-02-${String(1 + (i % 20)).padStart(2, '0')}T08:00:00.000Z`, createdAt: '2027-02-25T08:00:00.000Z', customerId: `c${i % 25}` }));
    }
    events.push(invoiceEvent('live1', '2027-02-28'));
    s.seedEvents(events);
  };
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new LaneStore({ now: clock.now });
  seed(s);
  const r = await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 10, clock: clock.now }), quiet);
  assert.equal(s.event(invoiceKey('live1', 'POST'))!.status, 'DONE', 'الفاتورة الحية في النبضة الأولى');
  assert.deepEqual(r.lanes, { live: 1, import: 9 }, 'مسار حي فارغ يترك دوره للاستيراد');
  assert.equal(r.stoppedBy, 'EVENT_BUDGET');
  assert.equal(laneOf({ sourceType: 'AR_ENTRY' }), 'IMPORT');
  assert.equal(laneOf({ sourceType: 'INVOICE' }), 'LIVE');

  // المرجع: الحلقة الواحدة بترتيب effectAt (مخزن بلا ترشيح النوع) تستهلك الميزانية على الاستيراد الأقدم
  const plain = new FakePostingStore({ now: clock.now });
  seed(plain);
  await runPoster(plain, plain.settings, createSyncBudget({ timeMs: 60_000, events: 10, clock: clock.now }), quiet);
  assert.equal(plain.event(invoiceKey('live1', 'POST'))!.status, 'PENDING');
});

test('(4 ب) مساران ممتلئان ⇒ ~60٪ للمستندات الحية، وكلٌّ بترتيب effectAt داخل مساره', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new LaneStore({ now: clock.now });
  const events: DesiredEvent[] = [];
  for (let i = 0; i < 30; i++) {
    events.push(arEvent(`b${String(i).padStart(2, '0')}`, { entryDate: `2027-02-${String(1 + i % 27).padStart(2, '0')}T06:00:00.000Z`, createdAt: '2027-02-28T08:00:00.000Z' }));
    events.push(invoiceEvent(`v${String(i).padStart(2, '0')}`, `2027-02-${String(1 + i % 27).padStart(2, '0')}`));
  }
  s.seedEvents(events);
  const r = await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 20, clock: clock.now }), quiet);
  const live = POSTER_LANE_PATTERN.filter((l) => l === 'LIVE').length / POSTER_LANE_PATTERN.length;
  assert.equal(live, 0.6);
  assert.deepEqual(r.lanes, { live: 12, import: 8 });
  const doneInvoices = [...s.state.events.values()].filter((e) => e.sourceType === 'INVOICE' && e.status === 'DONE').map((e) => e.effectAt.getTime());
  const pendingInvoices = [...s.state.events.values()].filter((e) => e.sourceType === 'INVOICE' && e.status === 'PENDING').map((e) => e.effectAt.getTime());
  assert.ok(Math.max(...doneInvoices) <= Math.min(...pendingInvoices), 'الحي بترتيب effectAt');
  assert.ok(s.lastListed?.sourceTypes && (s.lastListed.sourceTypes.in || s.lastListed.sourceTypes.notIn), 'كل قراءة للطابور مرشّحة بالمسار');
  // الذمم: كل عميل = AccountEntry المرحّلة (لا مضاعفة بين المسارين)
  assert.equal(s.balance(AR), [...s.state.events.values()].filter((e) => e.status === 'DONE').reduce((t, e) => t + (e.sourceType === 'INVOICE' ? 115_000n : 10_000n), 0n));
});

// ═══ البند 7 (أ): علامة المراجعة ═══

test('(7 أ) صف مستورد بتاريخ ≥ البدء ⇒ needsAttention؛ الوصول المتأخر والافتتاح والعكس والطريقة (ب) بلا علامة', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new LaneStore({ now: clock.now });
  s.seedEvents([
    // يوم البدء نفسه (منتصف الليل بتوقيت الرياض)
    arEvent('after', { entryDate: '2026-12-31T21:00:00.000Z', createdAt: '2027-02-01T08:00:00.000Z', debit: '250.00' }),
    arEvent('late', { entryDate: '2026-12-31T20:59:59.000Z', createdAt: '2027-02-01T08:00:00.000Z' }),
    arEvent('open', { entryDate: '2026-12-01T08:00:00.000Z', createdAt: '2027-01-02T08:00:00.000Z' }),
  ]);
  await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, clock: clock.now }), quiet);
  const byId = (id: string) => s.moves().find((m) => m.sourceId === id && m.reversedMoveId === null);
  assert.deepEqual([byId('after')!.date, byId('after')!.needsAttention, byId('after')!.lateArrival], ['2027-01-01', true, false]);
  assert.equal(s.balance(OPEQ), -250_000n - 10_000n, 'المبالغ بلا تغيير: 319002 كما كان');
  assert.deepEqual([byId('late')!.needsAttention, byId('late')!.lateArrival], [false, true]);
  assert.equal(byId('open'), undefined);
  assert.equal(s.event(arEntryKey('open'))!.skipReason, 'OPENING');

  // التراجع عن الصف المرحَّل ⇒ عكس بلا علامة
  s.seedEvents([{ ...arEvent('after', { entryDate: '2026-12-31T21:00:00.000Z', createdAt: '2027-02-01T08:00:00.000Z', debit: '250.00' }), sourceKey: arEntryKey('after', 'REVERSE'), event: 'REVERSE', effectAt: at('2027-02-20T08:00:00.000Z') }]);
  await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, clock: clock.now }), quiet);
  const rev = s.moves().find((m) => m.reversedMoveId === byId('after')!.id)!;
  assert.equal(rev.needsAttention, false);

  // الدالة الصرفة: السبب، والطريقة (ب)، وحدث غير AR_ENTRY، وتاريخ قبل البدء
  const draft = { date: '2027-01-05', lateArrival: false, needsAttention: false, attentionReason: null } as unknown as MoveDraft;
  const plan = { mode: 'BUILD' as const, lateArrival: false };
  const env = { settings: s.settings };
  const marked = markImportAfterCutover(env, { sourceType: 'AR_ENTRY', event: 'POST' }, plan, draft);
  assert.deepEqual([marked.needsAttention, marked.attentionReason], [true, IMPORT_AFTER_CUTOVER_ATTENTION_REASON]);
  assert.match(IMPORT_AFTER_CUTOVER_ATTENTION_REASON, /319002/);
  assert.equal(markImportAfterCutover({ settings: { ...s.settings, setupMethod: 'FULL_HISTORY' } }, { sourceType: 'AR_ENTRY', event: 'POST' }, plan, draft).needsAttention, false);
  assert.equal(markImportAfterCutover(env, { sourceType: 'INVOICE', event: 'POST' }, plan, draft).needsAttention, false);
  assert.equal(markImportAfterCutover(env, { sourceType: 'AR_ENTRY', event: 'REVERSE' }, plan, draft).needsAttention, false);
  assert.equal(markImportAfterCutover(env, { sourceType: 'AR_ENTRY', event: 'POST' }, { mode: 'BUILD', lateArrival: true }, draft).needsAttention, false);
  assert.equal(markImportAfterCutover(env, { sourceType: 'AR_ENTRY', event: 'POST' }, plan, { ...draft, date: '2026-12-31' }).needsAttention, false);
});

// ═══ (ج) تقدير الزمن ═══

test('(4 ج) estimateHistory: الحد المتحفظ مقيّد بـTICK_DB_BUDGET_MS، والمقيسة مقيّدة بالسقف الاسمي', () => {
  const perTick = Math.min(TICK_EVENT_BUDGET, Math.floor(TICK_DB_BUDGET_MS / CONSERVATIVE_MS_PER_EVENT));
  const conservative = perTick * (60_000 / SYNC_HEARTBEAT_MS);
  assert.equal(conservativeEventsPerMinute(), conservative);
  assert.ok(conservative < TICK_EVENT_BUDGET * (60_000 / SYNC_HEARTBEAT_MS), 'أقل من السقف الاسمي القديم');
  const e = estimateHistory({ accountEntries: 30_000, repSettlements: 0, settlementEntries: 0 });
  assert.deepEqual([e.throughputBasis, e.eventsPerMinute, e.estimatedMinutes], ['CONSERVATIVE', conservative, Math.ceil(30_000 / conservative)]);
  const m = estimateHistory({ accountEntries: 30_000, repSettlements: 0, settlementEntries: 0 }, { measuredEventsPerMinute: 150 });
  assert.deepEqual([m.throughputBasis, m.estimatedMinutes], ['MEASURED', 200]);
  const capped = estimateHistory({ accountEntries: 30_000, repSettlements: 0, settlementEntries: 0 }, { measuredEventsPerMinute: 1e9 });
  assert.equal(capped.eventsPerMinute, TICK_EVENT_BUDGET * (60_000 / SYNC_HEARTBEAT_MS));
  assert.equal(estimateHistory({ accountEntries: 0, repSettlements: 0, settlementEntries: 0 }).estimatedMinutes, 0);

  const dbNow = at('2027-03-01T10:30:00.000Z');
  assert.equal(measuredEventsPerMinute({ processed: MIN_MEASURED_EVENTS - 1, firstProcessedAt: at('2027-03-01T10:00:00.000Z'), dbNow }), null);
  assert.equal(measuredEventsPerMinute({ processed: 600, firstProcessedAt: at('2027-03-01T10:00:00.000Z'), lastProcessedAt: at('2027-03-01T10:10:00.000Z'), dbNow }), 60, 'مدة العمل لا حتى الآن');
  assert.equal(measuredEventsPerMinute({ processed: 100, firstProcessedAt: at('2027-03-01T10:00:00.000Z'), lastProcessedAt: at('2027-03-01T10:00:05.000Z'), dbNow }), 100, 'حد أدنى دقيقة');

  const p = backfillProgress({
    state: 'RUNNING', sources: [], pendingEvents: 900, pendingImportEvents: 850, measuredEventsPerMinute: 90, openEvents: 900, doneEvents: 0, dbNow,
  });
  assert.deepEqual(p.pendingByLane, { import: 850, live: 50 });
  assert.deepEqual([p.etaMinutes, p.throughputBasis], [10, 'MEASURED']);
});

// ═══ حراس ثابتة ═══

test('حارس ثابت: فهرس [tenantId, status, sourceType, effectAt]، وupdateMany مشروط بالحالة، وترشيح النوع في listDueEvents', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const model = schema.slice(schema.indexOf('model GlSourceEvent {'), schema.indexOf('@@map("gl_source_events")'));
  assert.match(model, /@@index\(\[tenantId, status, sourceType, effectAt\]\)/);
  assert.match(model, /@@index\(\[tenantId, status, effectAt\]\)/, 'الفهرس القائم باقٍ (إضافي خالص)');
  const store = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'sync', 'postingStore.prisma.ts'), 'utf8');
  const skip = store.slice(store.indexOf('async skipOpeningImports('), store.indexOf('async updateEventByKey('));
  assert.match(skip, /updateMany\(/);
  assert.match(skip, /status: \{ in: \['PENDING', 'BLOCKED', 'ERROR'\] \}/);
  assert.match(skip, /sourceType: 'AR_ENTRY', event: 'POST'/);
  assert.match(store, /readonly filtersDueEventsBySourceType = true/);
  const poster = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'sync', 'poster.ts'), 'utf8');
  const bulk = poster.slice(poster.indexOf('export async function resolveOpeningImports('), poster.indexOf('function tally('));
  assert.match(bulk, /store\.withPostLock\(settings\.tenantId/, 'تحت قفل gl-post');
  assert.match(bulk, /limit: OPENING_BULK_BATCH_SIZE/);
});
