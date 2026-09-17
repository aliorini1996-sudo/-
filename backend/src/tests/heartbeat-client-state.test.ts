// فوترة ZATCA (Z5.0) — نبضة المندوب تحمل حالة جهازه اختيارياً: {bundle, outboxPending, outboxTaxPending}.
// المحلِّل النقيّ (القيم غير الصالحة تُهمل، والعدّان زوج متّسق مع وقت الخادم) + فحص نصّي: المسار ما زال كتابة repSession واحدة
// وكتابة salesRep واحدة (الحالة في تحديث lastSeenAt نفسه — لا استعلام إضافي)، والحزمة القديمة بلا جسم تكتب lastSeenAt وحده.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_BUNDLE_RE, MAX_OUTBOX_COUNT, heartbeatClientState } from '../services/repHeartbeat';

const NOW = new Date('2026-09-17T10:00:00.000Z');

test('بلا جسم أو جسم غير كائن ⇒ لا شيء (النبضة كما اليوم)', () => {
  for (const b of [undefined, null, '', 'x', 5, [], [1, 2], true]) assert.deepEqual(heartbeatClientState(b, NOW), {}, JSON.stringify(b));
  assert.deepEqual(heartbeatClientState({}, NOW), {});
});

test('الحزمة: محارف آمنة حتى 40، وإلا تُهمل', () => {
  assert.deepEqual(heartbeatClientState({ bundle: '20260917T1000Z-abc123' }, NOW), { clientBundle: '20260917T1000Z-abc123' });
  assert.deepEqual(heartbeatClientState({ bundle: 'a'.repeat(40) }, NOW), { clientBundle: 'a'.repeat(40) });
  for (const bad of ['', 'a'.repeat(41), 'bundle with space', '<script>', 'حزمة', 12, null]) {
    assert.deepEqual(heartbeatClientState({ bundle: bad }, NOW), {}, String(bad));
  }
  assert.ok(CLIENT_BUNDLE_RE.test('1.2.3+build:zatca2'));
});

test('العدّان زوج: صحيحان غير سالبين ≤ الحدّ والضريبي ≤ الكلي، ومعهما outboxReportedAt بوقت الخادم؛ وإلا يُهملان معاً', () => {
  const ok = heartbeatClientState({ bundle: 'b1', outboxPending: 3, outboxTaxPending: 2 }, NOW);
  assert.deepEqual(ok, { clientBundle: 'b1', outboxPending: 3, outboxTaxPending: 2, outboxReportedAt: NOW });
  assert.notEqual(ok.outboxReportedAt, NOW, 'نسخة لا مرجع');
  assert.deepEqual(heartbeatClientState({ outboxPending: 0, outboxTaxPending: 0 }, NOW), { outboxPending: 0, outboxTaxPending: 0, outboxReportedAt: NOW });
  assert.deepEqual(heartbeatClientState({ outboxPending: MAX_OUTBOX_COUNT, outboxTaxPending: MAX_OUTBOX_COUNT }, NOW).outboxPending, MAX_OUTBOX_COUNT);
  const bad: Array<[unknown, unknown]> = [
    [3, undefined], [undefined, 1], [-1, 0], [1.5, 1], ['3', '2'], [3, 4], [MAX_OUTBOX_COUNT + 1, 0], [Number.NaN, 0], [Infinity, 0], [null, null],
  ];
  for (const [p, t] of bad) {
    const r = heartbeatClientState({ bundle: 'b2', outboxPending: p, outboxTaxPending: t }, NOW);
    assert.deepEqual(r, { clientBundle: 'b2' }, JSON.stringify([p, t]));
  }
});

test('المسار: كتابة repSession واحدة (تحديث أو إنشاء) وكتابة salesRep واحدة تحمل الحالة، ولا استعلام إضافي', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tracking.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf("router.post('/heartbeat',");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('\n});', start));
  const calls = [...body.matchAll(/prisma\.(\w+)\.(\w+)\(/g)].map(m => `${m[1]}.${m[2]}`);
  assert.deepEqual(calls, ['repSession.findFirst', 'repSession.update', 'repSession.create', 'salesRep.update']);
  assert.match(body, /await prisma\.salesRep\.update\(\{ where: \{ id: repId \}, data: \{ lastSeenAt: now, \.\.\.heartbeatClientState\(req\.body, now\) \} \}\);/);
  assert.match(body, /if \(last && .*\) \{\n\s*await prisma\.repSession\.update\(.*\n\s*\} else \{\n\s*await prisma\.repSession\.create\(/);
  assert.match(src, /^import \{ heartbeatClientState \} from '\.\.\/services\/repHeartbeat';$/m);
});
