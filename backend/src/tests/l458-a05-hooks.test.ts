// «ربط الدفاتر» L5 — خطاف حذف توريد عهدة المستخدم (العقد §5.5، الفجوة C14) والحارس الثابت لمسارات العهدة:
// يكتب USER_SETTLEMENT:<id>:POST و:REVERSE للمربوطة وحدها (عميل مزيّف)، ولغيرها قراءة gl_settings وحدها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import {
  settlementTombstoneEvents, settlementTombstonesWithReceiver, userSettlementTombstoneEvents, userSettlementTombstoneSettings,
  userSettlementTombstones,
} from '../services/gl/sync/tombstone';
import { userSettlementPayload } from '../services/gl/sync/desired';
import { CustodyBlocked } from '../services/userCustody';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

function ordered(text: string, needles: readonly string[], msg: string): void {
  let pos = -1;
  for (const n of needles) {
    const idx = text.indexOf(n, pos + 1);
    assert.ok(idx > pos, `${msg}: «${n}» مفقود أو خارج الترتيب`);
    pos = idx;
  }
}

/** جسم معالج من سطر تعريفه حتى `\n});` التالي */
function handler(src: string, head: string): string {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `المعالج مفقود: ${head}`);
  return src.slice(i, src.indexOf('\n});', i));
}

/** جسم دالة مُصدَّرة حتى `\n}` التالي */
function fnBody(src: string, head: string): string {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `الدالة مفقودة: ${head}`);
  return src.slice(i, src.indexOf('\n}\n', i));
}

// ═══ الحارس الثابت ═══

test('حذف التوريد: الخطاف أول ما في المعاملة قبل userSettlement.delete، وبالترتيب: الإعدادات ← القفل ← حارس التقسيم ← createMany(skipDuplicates)', () => {
  const src = read('routes/companyUsers.ts');
  const body = handler(src, "router.delete('/:id/settlements/:sid'");
  const tx = body.slice(body.indexOf('prisma.$transaction(async tx => {'));
  const firstAwait = tx.indexOf('await ');
  assert.match(tx.slice(firstAwait), /^await userSettlementDeleteLedgerHook\(tx, tid, row, target\);/, 'أول await في المعاملة ليس الخطاف');
  ordered(tx, ['userSettlementDeleteLedgerHook(tx', 'tx.userSettlement.delete(', 'tx.notification.create('], 'ترتيب معاملة الحذف');
  assert.doesNotMatch(body.slice(0, body.indexOf('prisma.$transaction(')), /userSettlement\.delete|glSourceEvent/, 'لا كتابة قبل المعاملة');
  assert.match(body, /err instanceof CustodyBlocked[\s\S]*status\(400\)/, 'رفض الحارس 400 لا 500');
  const hook = fnBody(src, 'export async function userSettlementDeleteLedgerHook(');
  ordered(hook, [
    'userSettlementTombstones(tx, tid', 'if (glTombstones.length === 0) return 0;', 'lockCustody(tx, tid, target.id)',
    'deliveryRemovalKeepsSplits(', 'throw new CustodyBlocked(', 'tx.glSourceEvent.createMany(', 'skipDuplicates: true',
  ], 'ترتيب الخطاف');
});

test('التوريد: السقف بطريقته (handoverAllowedFor) داخل المعاملة بعد القفل وقبل الكتابة؛ والقائمة بلا استعلام لكل مستخدم', () => {
  const src = read('routes/companyUsers.ts');
  const post = handler(src, "router.post('/:id/settlements'");
  ordered(post, ['$transaction(async tx', 'lockCustody(tx', 'userCustodyFold(tx', 'handoverAllowedFor(fold, method, amount)', 'tx.userSettlement.create('], 'ترتيب التوريد');
  const list = handler(src, "router.get('/',");
  assert.match(list, /await userCustodyMany\(prisma, tid\)/);
  assert.doesNotMatch(list.slice(list.indexOf('users.map(')), /await|prisma\./, 'لا استعلام داخل الدمج');
  // services/userCustody.ts خارج services/gl ولا يستوردها (تستعمله مسارات تشغيلية)
  const svc = read('services/userCustody.ts');
  const core = read('services/userCustodyCore.ts');
  for (const s of [svc, core]) assert.doesNotMatch(s, /from\s+['"][^'"]*\/gl[/'"]/, 'عهدة المستخدم لا تستورد services/gl');
  assert.doesNotMatch(core, /^import /m, 'النواة صرفة بلا استيراد');
});

test('دوال tombstone الجديدة في آخر الملف بلا SKIPPED، والمسار القائم لحذف الاستلام لم يُمسّ', () => {
  const s = read('services/gl/sync/tombstone.ts');
  const tail = s.slice(s.indexOf('// ═══ USER_SETTLEMENT'));
  assert.doesNotMatch(tail, /status:\s*'SKIPPED'/);
  assert.ok(s.indexOf('// ═══ USER_SETTLEMENT') > s.indexOf('export async function assertRepDeletable('), 'الإضافات بعد آخر دالة قائمة');
});

// ═══ السلوك بعميل مزيّف ═══

type Settings = { setupMethod: string | null; activatedAt: Date | null; currencyDecimals: number } | null;

function fakeTx(settings: Settings, data: { rec?: Record<string, unknown>[]; del?: Record<string, unknown>[] } = {}) {
  const calls: string[] = [];
  const created: unknown[] = [];
  const inList = (where: Record<string, unknown>, key: string, r: Record<string, unknown>) => {
    const v = where[key] as { in?: unknown[] } | undefined;
    return !v || (v.in ?? []).includes(r[key]);
  };
  const tx = {
    glSettings: { findUnique: async () => { calls.push('glSettings.findUnique'); return settings; } },
    $executeRaw: async () => { calls.push('$executeRaw'); return 0; },
    glSourceEvent: { createMany: async (a: { data: unknown[]; skipDuplicates: boolean }) => { calls.push('glSourceEvent.createMany'); created.push(a); return { count: a.data.length }; } },
    repSettlement: {
      groupBy: async ({ where }: { where: Record<string, unknown> }) => { calls.push('repSettlement.groupBy'); return (data.rec ?? []).filter((r) => inList(where, 'receivedByUserId', r)).map((r) => ({ receivedByUserId: r.receivedByUserId })); },
      findMany: async ({ where }: { where: Record<string, unknown> }) => { calls.push('repSettlement.findMany'); return (data.rec ?? []).filter((r) => inList(where, 'receivedByUserId', r)); },
    },
    userSettlement: {
      groupBy: async ({ where }: { where: Record<string, unknown> }) => { calls.push('userSettlement.groupBy'); return (data.del ?? []).filter((r) => inList(where, 'fromUserId', r)).map((r) => ({ fromUserId: r.fromUserId })); },
      findMany: async ({ where }: { where: Record<string, unknown> }) => { calls.push('userSettlement.findMany'); return (data.del ?? []).filter((r) => inList(where, 'fromUserId', r)); },
    },
    receipt: { findMany: async () => { calls.push('receipt.findMany'); return []; } },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, calls, created };
}

const T = (min: number) => new Date(Date.parse('2026-10-01T08:00:00Z') + min * 60_000);
const row = (id: string, amount: number, method: string, min: number) => ({
  id, tenantId: 't1', fromUserId: 'U1', amount, method, note: null, receivedBy: 'المدير', receivedByUserId: 'A1', settledAt: T(min), createdAt: T(min),
});
const LINKED: Settings = { setupMethod: 'LINKED', activatedAt: new Date('2026-01-01T00:00:00Z'), currencyDecimals: 2 };

// الاستيراد بعد تهيئة البيئة: المسار يبني PrismaClient عند التحميل (بلا اتصال)
async function hook() {
  process.env.DATABASE_URL ??= 'postgresql://offline:offline@127.0.0.1:9/offline?connect_timeout=1';
  return (await import('../routes/companyUsers')).userSettlementDeleteLedgerHook;
}

test('المربوطة: الخطاف يكتب USER_SETTLEMENT:<id>:POST و:REVERSE معاً PENDING بلقطة كاملة، تحت قفل العهدة', async () => {
  const h = await hook();
  const r = row('d1', 800.5, 'CASH', 10);
  const f = fakeTx(LINKED, { rec: [{ id: 's1', receivedByUserId: 'U1', amount: 1000, method: 'CASH', settledAt: T(0), createdAt: T(0) }], del: [r] });
  const n = await h(f.tx, 't1', r, { id: 'U1', name: 'سعد' });
  assert.equal(n, 2);
  assert.equal(f.calls[0], 'glSettings.findUnique');
  assert.ok(f.calls.indexOf('$executeRaw') < f.calls.indexOf('glSourceEvent.createMany'), 'القفل قبل الكتابة');
  const { data, skipDuplicates } = f.created[0] as { data: Record<string, unknown>[]; skipDuplicates: boolean };
  assert.equal(skipDuplicates, true);
  assert.deepEqual(data.map((d) => [d.sourceKey, d.sourceType, d.event, d.status, (d.effectAt as Date).toISOString()]), [
    ['USER_SETTLEMENT:d1:POST', 'USER_SETTLEMENT', 'POST', 'PENDING', T(10).toISOString()],
    ['USER_SETTLEMENT:d1:REVERSE', 'USER_SETTLEMENT', 'REVERSE', 'PENDING', (data[1].effectAt as Date).toISOString()],
  ]);
  assert.ok((data[1].effectAt as Date).getTime() > T(10).getTime(), 'REVERSE بلحظة الحذف');
  assert.deepEqual(data[0].payload, data[1].payload, 'الحمولة نفسها في المفتاحين');
  assert.deepEqual(data[0].payload, userSettlementPayload(r, 'سعد', 2), 'حمولة المُطابِق حرفاً');
  assert.equal((data[0].payload as { amount: string }).amount, '800.50');
  assert.equal(data[0].tenantId, 't1');
});

test('غير المربوطة (يدوية، قديمة، غير مفعّلة، بلا إعدادات): قراءة gl_settings وحدها ولا كتابة ولا قفل', async () => {
  const h = await hook();
  for (const s of [
    { setupMethod: 'CLEAN', activatedAt: new Date(), currencyDecimals: 2 },
    { setupMethod: 'OPENING', activatedAt: new Date(), currencyDecimals: 2 },
    { setupMethod: 'FULL_HISTORY', activatedAt: new Date(), currencyDecimals: 2 },
    { setupMethod: 'LINKED', activatedAt: null, currencyDecimals: 2 },
    null,
  ] as Settings[]) {
    const f = fakeTx(s);
    assert.equal(await h(f.tx, 't1', row('d1', 100, 'CASH', 1), { id: 'U1', name: 'سعد' }), 0);
    assert.deepEqual(f.calls, ['glSettings.findUnique'], JSON.stringify(s));
  }
});

test('المربوطة: حذفٌ يغيّر تقسيم توريدٍ لاحق ⇒ CustodyBlocked قبل أي كتابة؛ وحذف اللاحق يمرّ', async () => {
  const h = await hook();
  const rec = [
    { id: 's1', receivedByUserId: 'U1', amount: 500, method: 'CASH', settledAt: T(0), createdAt: T(0) },
    { id: 's2', receivedByUserId: 'U1', amount: 300, method: 'BANK_TRANSFER', settledAt: T(1), createdAt: T(1) },
  ];
  const del = [row('d1', 300, 'BANK_TRANSFER', 5), row('d2', 200, 'BANK_TRANSFER', 6)];
  const f = fakeTx(LINKED, { rec, del });
  await assert.rejects(h(f.tx, 't1', del[0], { id: 'U1', name: 'سعد' }), (e: unknown) => e instanceof CustodyBlocked);
  assert.ok(!f.calls.includes('glSourceEvent.createMany'), 'لا كتابة بعد الرفض');
  const g = fakeTx(LINKED, { rec, del });
  assert.equal(await h(g.tx, 't1', del[1], { id: 'U1', name: 'سعد' }), 2);
});

test('userSettlementTombstoneSettings/Events/Tombstones: المربوطة وحدها، والحمولة بمنازل العملة', async () => {
  const k = fakeTx({ ...LINKED!, currencyDecimals: 3 });
  assert.deepEqual(await userSettlementTombstoneSettings(k.tx as never, 't1'), { activatedAt: LINKED!.activatedAt, currencyDecimals: 3 });
  const rows = await userSettlementTombstones(k.tx as never, 't1', [{ ...row('d1', 1.2345, 'CHEQUE', 0), fromUserName: 'سعد' }], { deletedAt: T(60) });
  assert.equal((rows[0].payload as { amount: string }).amount, '1.235', 'نصف-لأعلى لثلاث منازل');
  assert.equal(rows[1].effectAt.toISOString(), T(60).toISOString());
  assert.deepEqual(await userSettlementTombstones(fakeTx({ setupMethod: 'CLEAN', activatedAt: new Date(), currencyDecimals: 2 }).tx as never, 't1', [row('d1', 1, 'CASH', 0)]), []);
  assert.deepEqual(await userSettlementTombstones(k.tx as never, 't1', []), []);
  const ev = userSettlementTombstoneEvents(row('d9', 50, 'POS', 3), 2, { deletedAt: T(9) });
  assert.deepEqual(ev.map((e) => [e.sourceKey, e.status]), [['USER_SETTLEMENT:d9:POST', 'PENDING'], ['USER_SETTLEMENT:d9:REVERSE', 'PENDING']]);
  assert.equal((ev[0].payload as { fromUserName: string | null }).fromUserName, null);
});

test('settlementTombstonesWithReceiver: المربوطة بحمولة المستلِم، والقديمة كـsettlementTombstones حرفاً، واليدوية لا شيء', async () => {
  const rep = { id: 's1', salesRepId: 'r1', amount: 800, method: 'CASH', note: null, settledAt: T(0), createdAt: T(0), receivedByUserId: 'U1' };
  const deletedAt = T(30);
  const linked = await settlementTombstonesWithReceiver(fakeTx(LINKED).tx as never, 't1', rep, { salesRepName: 'أحمد', receivedByName: 'سعد', deletedAt });
  assert.deepEqual(linked.map((r) => r.sourceKey), ['SETTLEMENT:s1:POST', 'SETTLEMENT:s1:REVERSE']);
  const p = linked[0].payload as Record<string, unknown>;
  assert.equal(p.receivedByUserId, 'U1');
  assert.equal(p.receivedByName, 'سعد');
  assert.equal(p.salesRepName, 'أحمد');
  const legacy = await settlementTombstonesWithReceiver(fakeTx({ setupMethod: 'OPENING', activatedAt: new Date(), currencyDecimals: 2 }).tx as never, 't1', rep, { salesRepName: 'أحمد', deletedAt });
  assert.deepEqual(legacy.map((r) => r.payload), settlementTombstoneEvents(rep, 2, { salesRepName: 'أحمد', deletedAt }).map((e) => e.payload));
  assert.ok(!('receivedByUserId' in (legacy[0].payload as object)), 'حمولة القديمة حرفاً بلا المستلِم');
  assert.deepEqual(await settlementTombstonesWithReceiver(fakeTx({ setupMethod: 'CLEAN', activatedAt: new Date(), currencyDecimals: 2 }).tx as never, 't1', rep), []);
  assert.deepEqual(await settlementTombstonesWithReceiver(fakeTx({ setupMethod: 'LINKED', activatedAt: null, currencyDecimals: 2 }).tx as never, 't1', rep), []);
});
