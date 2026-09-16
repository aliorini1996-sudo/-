// حارس الشبكة لاختبارات Z3: يُستورد أولاً في كل ملف اختبار. يستبدل globalThis.fetch بدالة ترمي فوراً ويعدّ
// كل محاولة، وafter() على مستوى الملف يُفشل التشغيل إن حدثت محاولة لم يُصرَّح بها (العميل يحوّل الرمي إلى
// RETRY network فلا يكفي الرمي وحده ليظهر الخطأ). لا يُعاد fetch الحقيقي أبداً داخل العملية.
import { after } from 'node:test';
import assert from 'node:assert/strict';

export const NET_GUARD_MESSAGE = 'Z3 NETWORK GUARD: a real network call was attempted from a test';

const state = { hits: 0, expected: 0 };

export const guardFetch = ((..._args: unknown[]): never => {
  state.hits++;
  throw new Error(NET_GUARD_MESSAGE);
}) as unknown as typeof fetch;

(globalThis as { fetch: unknown }).fetch = guardFetch;

/** يُستدعى قبل لمس الحارس عمداً (اختبار الحارس نفسه). */
export function expectGuardHit(): void {
  state.expected++;
}

export function guardHits(): number {
  return state.hits;
}

after(() => {
  assert.equal(globalThis.fetch, guardFetch, `${NET_GUARD_MESSAGE}: globalThis.fetch was replaced and not restored`);
  assert.equal(state.hits, state.expected, `${NET_GUARD_MESSAGE} (${state.hits - state.expected} unexpected attempt(s))`);
});
