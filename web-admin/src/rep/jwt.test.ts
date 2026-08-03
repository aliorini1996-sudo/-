import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenExpiredOrMissing, tokenSecondsLeft } from './jwt';

/** يبني JWT صوريّاً (توقيع وهمي) بحمولة معطاة — base64url مطابق للمعيار */
function makeToken(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig-وهمي`;
}

const inHours = (h: number) => Math.floor(Date.now() / 1000) + h * 3600;

test('توكن صالح في المستقبل ⇒ ليس منتهياً', () => {
  const t = makeToken({ id: 'r1', role: 'SALES_REP', exp: inHours(8) });
  assert.equal(tokenExpiredOrMissing(t), false);
});

test('الاسم العربي في الحمولة لا يكسر الفكّ — النقطة الحرجة', () => {
  // فكٌّ ساذج ينهار هنا فيعدّه منتهياً ⇒ إخراج عند كل 401 بتوكن صالح
  const t = makeToken({ id: 'r1', name: 'محمد المنديب الميداني', role: 'SALES_REP', exp: inHours(8) });
  assert.equal(tokenExpiredOrMissing(t), false, 'التوكن الصالح باسم عربي يجب أن يُقرأ سليماً');
  assert.ok(tokenSecondsLeft(t) > 7 * 3600);
});

test('توكن منتهٍ ⇒ منتهٍ', () => {
  const t = makeToken({ id: 'r1', exp: inHours(-1) });
  assert.equal(tokenExpiredOrMissing(t), true);
  assert.equal(tokenSecondsLeft(t), 0);
});

test('exp في اللحظة نفسها يُعدّ منتهياً (<=)', () => {
  const t = makeToken({ id: 'r1', exp: Math.floor(Date.now() / 1000) });
  assert.equal(tokenExpiredOrMissing(t), true);
});

test('null/فارغ/undefined ⇒ منتهٍ', () => {
  assert.equal(tokenExpiredOrMissing(null), true);
  assert.equal(tokenExpiredOrMissing(''), true);
  assert.equal(tokenExpiredOrMissing(undefined), true);
});

test('توكن مشوّه (جزآن) ⇒ منتهٍ — لا نثق بما لا نفكّه', () => {
  assert.equal(tokenExpiredOrMissing('aaa.bbb'), true);
  assert.equal(tokenExpiredOrMissing('غير.توكن.إطلاقاً'), true);
});

test('توكن بلا exp ⇒ منتهٍ', () => {
  const t = makeToken({ id: 'r1', role: 'SALES_REP' });
  assert.equal(tokenExpiredOrMissing(t), true);
});

test('exp ليس رقماً ⇒ منتهٍ', () => {
  const t = makeToken({ id: 'r1', exp: 'ليس رقماً' });
  assert.equal(tokenExpiredOrMissing(t), true);
});

test('هامش الانحراف يُقدّم الانتهاء', () => {
  const t = makeToken({ id: 'r1', exp: inHours(0) + 30 }); // بعد 30 ثانية
  assert.equal(tokenExpiredOrMissing(t, 0), false);
  assert.equal(tokenExpiredOrMissing(t, 60_000), true, 'هامش دقيقة يعدّه منتهياً');
});
