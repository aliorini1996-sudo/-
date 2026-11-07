import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * ربط المكالمة بعميل بعد فكّ قيد جوال العميل (طلب المالك ٧ نوفمبر: الجوال اختياري وبلا حدٍّ أدنى):
 * ١) جوالٌ فارغ ('') أو قصير أو عبثي لا يطابق أي مكالمة — '' لا يساوي ''، ولا يُستعلم بطرفٍ مجهول.
 * ٢) رقمٌ يحمله أكثر من عميل (رقمٌ مؤقّت مشترك) لا تُنسب مكالمته لأحدهم اعتباطاً.
 * ٣) المطابقة الصحيحة (‎+9665… و9665… و05…) باقية كما كانت.
 * بلا قاعدة بيانات: نماذج Prisma مزيّفة تطبّق مرشّح phone ‎{ in, not } وtake كما يطبّقه Prisma.
 */

type Row = { id: string; tenantId: string; phone: string; status?: string };
const customers: Row[] = [];
const calls: Array<{ customerId: string | null }> = [];
const queries: unknown[] = [];

let customerPhoneCandidates: (peer: string | null | undefined) => string[];
let recordCallEvent: typeof import('../services/telephony').recordCallEvent;

before(async () => {
  // قاعدة مستحيلة قبل تحميل Prisma (لو فات نموذجٌ المزيّف لفشل الاتصال بمنفذ مغلق محلياً لا بشبكة)
  process.env.DATABASE_URL = 'postgresql://offline:offline@127.0.0.1:9/offline?connect_timeout=1';
  const prisma = (await import('../config/database')).default as unknown as Record<string, unknown>;
  Object.assign(prisma, {
    workChannel: { findFirst: async () => null },
    customer: {
      findMany: async (args: { where: { tenantId: string; status?: { not: string }; phone: { in: string[]; not?: string } }; take?: number }) => {
        queries.push(args);
        const f = args.where.phone;
        const s = args.where.status;
        const hits = customers.filter((c) => c.tenantId === args.where.tenantId
          && (s === undefined || (c.status ?? 'ACTIVE') !== s.not)
          && f.in.includes(c.phone) && (f.not === undefined || c.phone !== f.not));
        return hits.slice(0, args.take ?? hits.length).map((c) => ({ id: c.id }));
      },
      findFirst: async () => { throw new Error('findFirst يعيد أول تطابق اعتباطاً — المطابقة بالجوال تشترط عميلاً وحيداً'); },
    },
    callLog: { create: async ({ data }: { data: { customerId: string | null } }) => { calls.push({ customerId: data.customerId }); return data; } },
  });
  ({ customerPhoneCandidates, recordCallEvent } = await import('../services/telephony'));
});

function reset(rows: Row[]) {
  customers.length = 0; calls.length = 0; queries.length = 0;
  customers.push(...rows);
}

let seq = 0;
function call(peer: string | null, direction: 'IN' | 'OUT' = 'IN') {
  seq += 1;
  return {
    direction, fromE164: direction === 'IN' ? peer : '+966112223333', toE164: direction === 'IN' ? '+966112223333' : peer,
    startedAt: new Date('2026-11-07T08:00:00Z'), durationSec: 30, recordingUrl: null, transcript: null, aiSummary: null,
    providerCallId: `c${seq}`, channelProviderId: null, channelE164: null,
  } as unknown as Parameters<typeof recordCallEvent>[1];
}

test('customerPhoneCandidates: رقم سعودي صالح ⇒ صيغه الثلاث كما تُخزَّن', () => {
  assert.deepEqual(customerPhoneCandidates('+966501234567'), ['+966501234567', '966501234567', '0501234567']);
  assert.deepEqual(customerPhoneCandidates('+201001234567'), ['+201001234567', '201001234567']);
});

test('customerPhoneCandidates: طرفٌ فارغ أو مجهول أو قصير ⇒ لا مرشّح (لا فارغ ولا رقم قصير أبداً)', () => {
  for (const peer of [null, undefined, '', ' ', '+', '123', '0000', 'anonymous', '+1234567']) {
    assert.deepEqual(customerPhoneCandidates(peer), [], `المدخل: ${String(peer)}`);
  }
  // كل مرشّح ٨ خانات فأكثر — فجوال عميلٍ من خانات قليلة (مسموحٌ الآن) لا يطابق مكالمة
  for (const peer of ['+96650123', '+966501234567', '+12025550123']) {
    for (const c of customerPhoneCandidates(peer)) assert.ok(c.replace(/\D/g, '').length >= 8, `مرشّح قصير: ${c}`);
  }
});

test('recordCallEvent: جوالٌ فارغ لا يطابق — عملاء بلا جوال لا تُنسب لهم مكالمة', async () => {
  reset([{ id: 'empty1', tenantId: 't1', phone: '' }, { id: 'empty2', tenantId: 't1', phone: '' }]);
  assert.equal(await recordCallEvent('t1', call('+966501234567')), 'created');
  assert.equal(calls[0].customerId, null);
  // المرشّح يستبعد '' صراحةً (حزامٌ فوق البناء) ولا يحوي فارغاً
  const q = queries[0] as { where: { phone: { in: string[]; not: string } } };
  assert.equal(q.where.phone.not, '');
  assert.ok(!q.where.phone.in.includes(''));
});

test('recordCallEvent: طرفٌ مجهول (محجوب) ⇒ لا استعلام عن العملاء أصلاً', async () => {
  reset([{ id: 'empty1', tenantId: 't1', phone: '' }]);
  await recordCallEvent('t1', call(null));
  assert.equal(queries.length, 0);
  assert.equal(calls[0].customerId, null);
});

test('recordCallEvent: المطابقة الصحيحة بالصيغ الثلاث باقية', async () => {
  for (const stored of ['0501234567', '966501234567', '+966501234567']) {
    reset([{ id: 'c1', tenantId: 't1', phone: stored }, { id: 'x', tenantId: 't1', phone: '' }, { id: 'other', tenantId: 't2', phone: stored }]);
    await recordCallEvent('t1', call('+966501234567'));
    assert.equal(calls[0].customerId, 'c1', `الصيغة المخزّنة: ${stored}`);
  }
  // الصادر يطابق بالمستقبِل
  reset([{ id: 'c1', tenantId: 't1', phone: '0501234567' }]);
  await recordCallEvent('t1', call('+966501234567', 'OUT'));
  assert.equal(calls[0].customerId, 'c1');
});

test('recordCallEvent: رقمٌ مشترك بين عميلين ⇒ بلا عميل (لا نسبة اعتباطية)', async () => {
  reset([{ id: 'a', tenantId: 't1', phone: '0500000000' }, { id: 'b', tenantId: 't1', phone: '+966500000000' }]);
  await recordCallEvent('t1', call('+966500000000'));
  assert.equal(calls[0].customerId, null);
  assert.equal((queries[0] as { take: number }).take, 2);
});

test('recordCallEvent: جوال عميلٍ قصير أو عبثي لا يطابق مكالمة', async () => {
  reset([{ id: 's1', tenantId: 't1', phone: '123' }, { id: 's2', tenantId: 't1', phone: '0' }, { id: 's3', tenantId: 't1', phone: '+' }]);
  await recordCallEvent('t1', call('+966501234567'));
  assert.equal(calls[0].customerId, null);
});

test('recordCallEvent: المؤرشف القديم (DELETED) لا يزاحم العميل الحيّ بجواله نفسه', async () => {
  reset([
    { id: 'old', tenantId: 't1', phone: '0501234567', status: 'DELETED' },
    { id: 'live', tenantId: 't1', phone: '+966501234567', status: 'ACTIVE' },
  ]);
  await recordCallEvent('t1', call('+966501234567'));
  assert.equal(calls[0].customerId, 'live', 'المكالمة ضاعت لأنّ المؤرشف عُدّ رقماً مشتركاً');
  assert.deepEqual((queries[0] as { where: { status: unknown } }).where.status, { not: 'DELETED' });
  // والمؤرشف وحده لا تُنسب له مكالمة
  reset([{ id: 'old', tenantId: 't1', phone: '0501234567', status: 'DELETED' }]);
  await recordCallEvent('t1', call('+966501234567'));
  assert.equal(calls[0].customerId, null);
});
