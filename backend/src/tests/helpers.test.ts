// اختبارات مساعدات الترقيم والتقريب — خاصة إعادة المحاولة عند تصادم الرقم (P2002)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withNumberRetry, roundDecimal } from '../utils/helpers';

// خطأ يحاكي تصادم unique(tenantId, number) من Prisma
const numberClash = () => Object.assign(new Error('Unique constraint failed'), {
  code: 'P2002', meta: { target: ['tenantId', 'number'] },
});

test('ينجح من أول محاولة دون إعادة', async () => {
  let calls = 0;
  const out = await withNumberRetry(async () => { calls++; return 'INV-1'; });
  assert.equal(out, 'INV-1');
  assert.equal(calls, 1);
});

test('يعيد المحاولة عند P2002 على الرقم وينجح', async () => {
  let calls = 0;
  const out = await withNumberRetry(async () => {
    calls++;
    if (calls < 3) throw numberClash();
    return 'INV-3';
  });
  assert.equal(out, 'INV-3');
  assert.equal(calls, 3);
});

test('يستسلم بعد استنفاد المحاولات ويرمي آخر خطأ', async () => {
  let calls = 0;
  await assert.rejects(
    () => withNumberRetry(async () => { calls++; throw numberClash(); }, 3),
    (e: { code?: string }) => e.code === 'P2002'
  );
  assert.equal(calls, 3);
});

test('الأخطاء الأخرى تُرمى فوراً بلا إعادة (لا نخفي أخطاء حقيقية)', async () => {
  let calls = 0;
  await assert.rejects(
    () => withNumberRetry(async () => { calls++; throw new Error('DB down'); }),
    /DB down/
  );
  assert.equal(calls, 1);
});

test('P2002 على قيد آخر (ليس الرقم) لا يُعاد بل يُرمى', async () => {
  let calls = 0;
  const emailClash = Object.assign(new Error('unique email'), { code: 'P2002', meta: { target: ['email'] } });
  await assert.rejects(
    () => withNumberRetry(async () => { calls++; throw emailClash; }),
    /unique email/
  );
  assert.equal(calls, 1);
});

test('roundDecimal: خانتان افتراضاً وثلاث للدينار', () => {
  assert.equal(roundDecimal(1.006), 1.01);
  assert.equal(roundDecimal(1.2344, 3), 1.234);
  assert.equal(roundDecimal(2.5, 0), 3);
});
