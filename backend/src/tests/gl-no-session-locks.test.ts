// M3 — لا أقفال جلسة، وحيوية عقد الإيجار (DESIGN.md §5.1، §10.1 صف M3: gl-no-session-locks.test.ts).
// حارس ثابت على services/gl كلها، واختبارات بلا قاعدة للعقد بمخزن مزيّف بساعة قاعدة محقونة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { invoicePayloadFromRows } from '../services/gl/builders/invoice';
import { invoiceKey } from '../services/gl/sync/keys';
import { createSyncBudget } from '../services/gl/sync/poster';
import { runManualSync, runTenantTick } from '../services/gl/sync/tick';
import { createLedgerSyncScheduler } from '../services/gl/sync/scheduler';
import { MANUAL_SYNC_MIN_INTERVAL_MS, maxCompositeKey, type DesiredEvent } from '../services/gl/sync/types';
import { FakePostingStore } from './gl-fake-posting-store';

const GL_DIR = path.join(__dirname, '..', 'services', 'gl');

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? tsFiles(p) : d.name.endsWith('.ts') ? [p] : [];
  });
}

/** يزيل التعليقات مع الحفاظ على عدد الأسطر */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, (_m, p1: string) => p1);
}

test('حارس ثابت: لا pg_try_advisory_lock( ولا pg_advisory_lock( ولا pg_advisory_unlock( تحت services/gl', () => {
  const files = tsFiles(GL_DIR);
  assert.ok(files.length > 20);
  const offenders: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of [/pg_try_advisory_lock\s*\(/, /pg_advisory_lock\s*\(/, /pg_advisory_unlock(_all)?\s*\(/, /pg_try_advisory_xact_lock\s*\(/]) {
      if (re.test(src)) offenders.push(`${path.relative(GL_DIR, f)}: ${re}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('حارس ثابت: pg_advisory_xact_lock في الكود يُنفَّذ على عميل معاملة (tx.$executeRaw/$queryRaw) وحده', () => {
  const bad: string[] = [];
  let uses = 0;
  for (const f of tsFiles(GL_DIR)) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    code.split('\n').forEach((line, i) => {
      if (!/pg_advisory_xact_lock\s*\(/.test(line)) return;
      uses++;
      if (!/\btx\.\$(executeRaw|queryRaw)\s*`/.test(line)) bad.push(`${path.relative(GL_DIR, f)}:${i + 1}`);
    });
  }
  assert.ok(uses >= 1, 'acquirePostLock موجود');
  assert.deepEqual(bad, []);
});

test('حارس ثابت: المُرحِّل يأخذ القفل داخل $transaction، والعقد بـ$executeRaw وساعة القاعدة ويُفك في finally بالرمز', () => {
  const store = fs.readFileSync(path.join(GL_DIR, 'sync', 'postingStore.prisma.ts'), 'utf8');
  const withLock = /withPostLock[\s\S]*?\$transaction\(async \(tx\) => \{\s*await acquirePostLock\(tx, tenantId\);/.exec(store);
  assert.ok(withLock, 'withPostLock: أول عبارة في $transaction هي acquirePostLock');
  assert.match(store, /\$executeRaw`\s*UPDATE "gl_settings" SET "workerLeaseUntil" = NOW\(\) \+ INTERVAL '90 seconds', "workerLeaseToken" = \$\{token\}\s*WHERE "tenantId" = \$\{tenantId\} AND \("workerLeaseUntil" IS NULL OR "workerLeaseUntil" < NOW\(\)\)/);
  assert.match(store, /SET "workerLeaseUntil" = NULL, "workerLeaseToken" = NULL\s*WHERE "tenantId" = \$\{lease\.tenantId\} AND "workerLeaseToken" = \$\{lease\.token\}/);
  assert.doesNotMatch(stripComments(store), /updatedAt/, 'العقد وlastSyncAt لا يلمسان updatedAt');
  const tick = fs.readFileSync(path.join(GL_DIR, 'sync', 'tick.ts'), 'utf8');
  assert.match(tick, /randomUUID/);
  assert.match(tick, /finally \{\s*if \(leased\) \{\s*await store\.releaseLease\(\{ tenantId, token \}\)/);
  const poster = stripComments(fs.readFileSync(path.join(GL_DIR, 'sync', 'poster.ts'), 'utf8'));
  assert.match(poster, /store\.withPostLock\(/);
});

function clockAt(iso: string) {
  let t = new Date(iso).getTime();
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function invoiceEvent(id: string): DesiredEvent {
  const payload = invoicePayloadFromRows({
    invoice: { id, number: id, type: 'CREDIT', customerId: 'c1', salesRepId: null, pricesIncludeTax: false, subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115 },
    items: [{ qty: 1, unitPrice: 100, taxPct: 15, taxAmt: 15, lineTotal: 115 }],
    customerName: 'عميل', entryDate: '2027-02-10', currency: 'SAR', currencyDecimals: 2,
  });
  return {
    sourceKey: invoiceKey(id, 'POST'), sourceType: 'INVOICE', sourceId: id, event: 'POST', effectAt: new Date('2027-02-10T08:00:00.000Z'),
    payload: { ...payload, sourceCreatedAt: '2027-02-10T08:00:00.000Z' },
  };
}

const quiet = { log: () => undefined };

test('حيوية العقد: نبضة انهارت دون فك ⇒ التالية بعد 90 ثانية تأخذ العقد وترحّل', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now });
  s.seedEvents([invoiceEvent('i1')]);
  // نبضة سابقة أخذت العقد وانهارت (لا finally)
  assert.equal(await s.tryAcquireLease('t1', 'crashed-token'), true);
  const blocked = await runTenantTick({ store: s, inProcess: new Set(), ...quiet }, 't1', createSyncBudget({ clock: clock.now, timeMs: 60_000 }));
  assert.equal(blocked.skipped, 'LEASE_HELD');
  assert.equal(blocked.pendingEvents, 1);
  assert.equal(s.moves().length, 0);
  clock.advance(90_001);
  const r = await runTenantTick({ store: s, inProcess: new Set(), ...quiet }, 't1', createSyncBudget({ clock: clock.now, timeMs: 60_000 }));
  assert.equal(r.leaseAcquired, true);
  assert.equal(r.post?.done, 1);
  assert.equal(s.moves().length, 1);
  assert.equal(s.state.lease.token, null, 'فُك العقد في finally');
  assert.ok(s.state.lastSyncAt);
});

test('نبضتان متزامنتان ⇒ واحدة فقط تفوز بالعقد (النتيجة 1)', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now });
  const [a, b] = await Promise.all([s.tryAcquireLease('t1', 'a'), s.tryAcquireLease('t1', 'b')]);
  assert.equal([a, b].filter(Boolean).length, 1);
  // فك برمز آخر لا يحرّر عقد غيره
  await s.releaseLease({ tenantId: 't1', token: a ? 'b' : 'a' });
  assert.notEqual(s.state.lease.token, null);

  // نسختان مستقلتان (Set منفصل لكل عملية) تنبضان معاً: واحدة ترحّل والأخرى LEASE_HELD، وقيد واحد
  const s2 = new FakePostingStore({ now: clock.now });
  s2.seedEvents([invoiceEvent('i2')]);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const origList = s2.listDueEvents.bind(s2);
  let first = true;
  s2.listDueEvents = async (t, o) => {
    if (first) { first = false; await gate; }
    return origList(t, o);
  };
  const p1 = runTenantTick({ store: s2, inProcess: new Set(), ...quiet }, 't1', createSyncBudget({ clock: clock.now, timeMs: 60_000 }));
  await new Promise((r) => setImmediate(r));
  const r2 = await runTenantTick({ store: s2, inProcess: new Set(), ...quiet }, 't1', createSyncBudget({ clock: clock.now, timeMs: 60_000 }));
  release();
  const r1 = await p1;
  assert.deepEqual([r1.skipped, r2.skipped].sort(), [null, 'LEASE_HELD'].sort());
  assert.equal(s2.moves().length, 1);
});

test('Set داخل العملية: نبضة جديدة لا تتداخل مع بطيئة للشركة نفسها', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now });
  const inProcess = new Set(['t1']);
  const r = await runTenantTick({ store: s, inProcess, ...quiet }, 't1', createSyncBudget({ clock: clock.now }));
  assert.equal(r.skipped, 'IN_PROCESS');
  assert.equal(s.state.lease.token, null, 'لم يُطلب العقد أصلاً');
});

test('POST /sync دون العقد ⇒ {running: true, pendingEvents}، وبحد مرة كل 60 ثانية', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now });
  s.seedEvents([invoiceEvent('i3')]);
  await s.tryAcquireLease('t1', 'scheduler-token');
  const lastRun = new Map<string, number>();
  const held = await runManualSync({ store: s, inProcess: new Set(), ...quiet }, 't1', { clock: clock.now, lastRun });
  assert.deepEqual(held, { running: true, pendingEvents: 1 });
  const throttled = await runManualSync({ store: s, inProcess: new Set(), ...quiet }, 't1', { clock: clock.now, lastRun });
  assert.equal(throttled.running, true);
  assert.ok(throttled.running && (throttled.retryAfterSeconds ?? 0) > 0);
  await s.releaseLease({ tenantId: 't1', token: 'scheduler-token' });
  clock.advance(MANUAL_SYNC_MIN_INTERVAL_MS);
  const ok = await runManualSync({ store: s, inProcess: new Set(), ...quiet }, 't1', { clock: clock.now, lastRun });
  assert.equal(ok.running, false);
  assert.equal(ok.pendingEvents, 0);
  assert.equal(!ok.running && ok.result.post?.done, 1);
});

test('المجدول: WORKER_DISABLED وREQUEST_PRESSURE وTICK_IN_PROGRESS، والإطفاء يوقف الشركة', async () => {
  const clock = clockAt('2027-03-01T10:00:00.000Z');
  const s = new FakePostingStore({ now: clock.now });
  s.seedEvents([invoiceEvent('i4')]);
  assert.equal((await createLedgerSyncScheduler({ store: s, enabled: false, ...quiet }).tick()).skipped, 'WORKER_DISABLED');
  assert.equal((await createLedgerSyncScheduler({ store: s, inFlightRequests: () => 50, pressureThreshold: 20, ...quiet }).tick()).skipped, 'REQUEST_PRESSURE');
  s.settings.suiteEnabled = false;
  const off = await createLedgerSyncScheduler({ store: s, inFlightRequests: () => 0, ...quiet }).tick();
  assert.equal(off.tenants.length, 0, 'الشركة المطفأة ليست مؤهلة');
  s.settings.suiteEnabled = true;
  const sch = createLedgerSyncScheduler({ store: s, inFlightRequests: () => 0, clock: clock.now, inProcess: new Set(), ...quiet });
  const [r1, r2] = await Promise.all([sch.tick(), sch.tick()]);
  assert.deepEqual([r1.skipped, r2.skipped].sort(), [null, 'TICK_IN_PROGRESS'].sort());
  assert.equal(s.moves().length, 1);
});

test('المؤشر لا يتراجع: GREATEST يحفظ الأكبر حين تكتب نبضة انتهى عقدها مؤشراً أقدم', () => {
  const newer = { at: new Date('2027-03-01T10:00:00.000Z'), id: 'b' };
  const stale = { at: new Date('2027-03-01T09:59:00.000Z'), id: 'z' };
  assert.equal(maxCompositeKey(newer, stale), newer);
  assert.equal(maxCompositeKey(stale, newer), newer);
  // تنفيذ Prisma للمُطابِق يشترط التقدّم في التحديث (لا كتابة غير مشروطة للمؤشر)
  const rs = fs.readFileSync(path.join(GL_DIR, 'sync', 'reconcilerStore.prisma.ts'), 'utf8');
  assert.match(rs, /GREATEST|watermarkAt: \{ lt:|watermarkAt: \{ lte:|OR: \[\{ watermarkAt/, 'commitPage مشروط بتقدّم المؤشر');
});
