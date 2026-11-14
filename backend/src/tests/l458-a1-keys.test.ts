// «ربط الدفاتر» L5 (A1، العقد §3.2 وD13): مفتاحا USER_SETTLEMENT وPAYLINK_REFUND — تطابق الـbuilders حرفاً، والتحليل ذهاباً
// وإياباً (round-trip) مع REPOST، والشقيق، ومفاتيح POST/REVERSE لكل مصدر؛ وقوائم المصادر في sync/types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUnderPostPattern, nextRepostIndex, parseSourceKey, paylinkRefundKey, postKeyOf, repostKey, repostRevKey, reverseKeyOf,
  siblingPostKey, userSettlementKey,
} from '../services/gl/sync/keys';
import { paylinkRefundKey as builderPaylinkRefundKey } from '../services/gl/builders/paylink';
import { userSettlementKey as builderUserSettlementKey } from '../services/gl/builders/userCustody';
import {
  CURSOR_SOURCE_EVENT_TYPES, SALES_SOURCE_TYPES, SYNC_CURSOR_SOURCES, TOMBSTONE_SOURCE_TYPES,
} from '../services/gl/sync/types';

const ID = '3f1c2a9e-8b7d-4c6e-9a1b-2c3d4e5f6a7b';

test('المفتاحان يطابقان الـbuilders حرفاً', () => {
  for (const ev of ['POST', 'REVERSE'] as const) assert.equal(userSettlementKey(ID, ev), builderUserSettlementKey(ID, ev));
  assert.equal(paylinkRefundKey(ID), builderPaylinkRefundKey(ID));
  assert.equal(userSettlementKey('u', 'POST'), 'USER_SETTLEMENT:u:POST');
  assert.equal(userSettlementKey('u', 'REVERSE'), 'USER_SETTLEMENT:u:REVERSE');
  assert.equal(paylinkRefundKey('e'), 'PAYLINK_REFUND:e');
});

test('postKeyOf وreverseKeyOf: USER_SETTLEMENT بحدثيه، وPAYLINK_REFUND بلا عكس', () => {
  assert.equal(postKeyOf('USER_SETTLEMENT', ID), `USER_SETTLEMENT:${ID}:POST`);
  assert.equal(reverseKeyOf('USER_SETTLEMENT', ID), `USER_SETTLEMENT:${ID}:REVERSE`);
  assert.equal(postKeyOf('PAYLINK_REFUND', ID), `PAYLINK_REFUND:${ID}`);
  assert.equal(reverseKeyOf('PAYLINK_REFUND', ID), null);
});

test('parseSourceKey ذهاباً وإياباً: كل مفتاح يُحلَّل إلى مصدره وحدثه وأساسه، ويُعاد بناؤه حرفاً', () => {
  const cases = [
    { key: userSettlementKey(ID, 'POST'), sourceType: 'USER_SETTLEMENT', event: 'POST', repost: null },
    { key: userSettlementKey(ID, 'REVERSE'), sourceType: 'USER_SETTLEMENT', event: 'REVERSE', repost: null },
    { key: repostKey(userSettlementKey(ID, 'POST'), 2), sourceType: 'USER_SETTLEMENT', event: 'POST', repost: { kind: 'REPOST', n: 2 } },
    { key: repostRevKey(userSettlementKey(ID, 'POST'), 1), sourceType: 'USER_SETTLEMENT', event: 'REVERSE', repost: { kind: 'REPOST_REV', n: 1 } },
    { key: paylinkRefundKey(ID), sourceType: 'PAYLINK_REFUND', event: 'POST', repost: null },
    { key: repostKey(paylinkRefundKey(ID), 3), sourceType: 'PAYLINK_REFUND', event: 'POST', repost: { kind: 'REPOST', n: 3 } },
    { key: repostRevKey(paylinkRefundKey(ID), 1), sourceType: 'PAYLINK_REFUND', event: 'REVERSE', repost: { kind: 'REPOST_REV', n: 1 } },
  ] as const;
  for (const c of cases) {
    const p = parseSourceKey(c.key);
    assert.ok(p, c.key);
    assert.deepEqual(
      { sourceType: p.sourceType, sourceId: p.sourceId, event: p.event, repost: p.repost, generation: p.generation },
      { sourceType: c.sourceType, sourceId: ID, event: c.event, repost: c.repost, generation: null },
      c.key,
    );
    assert.equal(p.baseKey, postKeyOf(p.sourceType as 'USER_SETTLEMENT' | 'PAYLINK_REFUND', p.sourceId), c.key);
    // إعادة البناء من التحليل
    const rebuilt = p.repost
      ? (p.repost.kind === 'REPOST' ? repostKey(p.baseKey, p.repost.n) : repostRevKey(p.baseKey, p.repost.n))
      : p.event === 'REVERSE' ? reverseKeyOf(p.sourceType as 'USER_SETTLEMENT', p.sourceId) : p.baseKey;
    assert.equal(rebuilt, c.key);
  }
  for (const bad of [
    'USER_SETTLEMENT:x', 'USER_SETTLEMENT::POST', 'USER_SETTLEMENT:x:COGS', 'USER_SETTLEMENT:x:REVERSE:REPOST:1',
    'USER_SETTLEMENT:x:POST:REPOST:0', 'PAYLINK_REFUND:', 'PAYLINK_REFUND:x:POST', 'PAYLINK_REFUND:x:REVERSE',
  ]) assert.equal(parseSourceKey(bad), null, bad);
});

test('الشقيق ونمط القيد الحيّ وREPOST التالي للمفتاحين', () => {
  assert.equal(siblingPostKey(userSettlementKey(ID, 'REVERSE')), userSettlementKey(ID, 'POST'));
  assert.equal(siblingPostKey(userSettlementKey(ID, 'POST')), null);
  assert.equal(siblingPostKey(paylinkRefundKey(ID)), null);
  const base = userSettlementKey(ID, 'POST');
  assert.equal(isUnderPostPattern(repostKey(base, 1), base), true);
  assert.equal(isUnderPostPattern(userSettlementKey(ID, 'REVERSE'), base), false);
  assert.equal(nextRepostIndex([base, repostKey(base, 1), repostRevKey(base, 1)], base), 2);
  const pr = paylinkRefundKey(ID);
  assert.equal(isUnderPostPattern(repostRevKey(pr, 2), pr), true);
});

test('قوائم المزامنة: المصدران مبيعات، وUSER_SETTLEMENT tombstone ومؤشر بأحداثه، وREFUND من مؤشر الأمانات', () => {
  for (const t of ['USER_SETTLEMENT', 'PAYLINK_REFUND']) assert.ok((SALES_SOURCE_TYPES as readonly string[]).includes(t), t);
  assert.deepEqual([...TOMBSTONE_SOURCE_TYPES], ['SETTLEMENT', 'AR_ENTRY', 'USER_SETTLEMENT']);
  assert.deepEqual([...CURSOR_SOURCE_EVENT_TYPES.SETTLEMENT_ENTRY], ['PAYLINK_FEE', 'PAYOUT', 'PAYLINK_REFUND']);
  assert.deepEqual([...CURSOR_SOURCE_EVENT_TYPES.USER_SETTLEMENT], ['USER_SETTLEMENT']);
  // «ربط الدفاتر» L6: كشف المورّد أُلحق بعد USER_SETTLEMENT
  assert.deepEqual(SYNC_CURSOR_SOURCES.slice(-2), ['USER_SETTLEMENT', 'SUPPLIER_ENTRY']);
  // كل مؤشر له قائمة أحداث
  for (const s of SYNC_CURSOR_SOURCES) assert.ok(Array.isArray(CURSOR_SOURCE_EVENT_TYPES[s]), s);
});
