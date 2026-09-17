import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckResult, ChecksReport } from '../../api/ledgerReview';
import { mergeChecksRun, worstStatus } from './checks';

const result = (key: CheckResult['key'], status: CheckResult['status']): CheckResult => ({
  key, status, title: key, summary: '', metrics: {}, rows: [], rowCount: 0, fix: null,
});
const report = (ranAt: string, results: CheckResult[]): ChecksReport => ({
  tenantId: 't', ranAt, durationMs: 1, overall: 'GREEN', results,
});

const shown = report('2026-09-17T10:00:00.000Z', [result('C1', 'GREEN'), result('C3', 'RED')]);

test('مقيَّد بلا تقرير مخزَّن (فحص مفرد أو كامل): لا تغيير ولا TypeError', () => {
  assert.equal(mergeChecksRun(shown, { report: null, throttled: true, retryAfterSeconds: 42 }, ['C3']), null);
  assert.equal(mergeChecksRun(shown, { report: null, throttled: true, retryAfterSeconds: 42 }), null);
  assert.equal(mergeChecksRun(null, { report: null, throttled: true, retryAfterSeconds: 42 }), null);
});

test('مقيَّد بتقرير مخزَّن: يُعرض إن لم يكن المعروض أحدث منه', () => {
  const cached = report('2026-09-17T10:05:00.000Z', [result('C1', 'RED'), result('C3', 'GREEN')]);
  assert.equal(mergeChecksRun(shown, { report: cached, throttled: true, retryAfterSeconds: 10 }), cached);
  assert.equal(mergeChecksRun(null, { report: cached, throttled: true, retryAfterSeconds: 10 }, ['C1']), cached);
  const older = report('2026-09-17T09:00:00.000Z', [result('C1', 'RED')]);
  assert.equal(mergeChecksRun(shown, { report: older, throttled: true, retryAfterSeconds: 10 }, ['C3']), null);
});

test('فحص مفرد غير مقيَّد: يُدمج في المعروض دون مسح بقية الفحوص', () => {
  const partial = report('2026-09-17T10:06:00.000Z', [result('C3', 'GREEN')]);
  const merged = mergeChecksRun(shown, { report: partial, throttled: false }, ['C3']);
  assert.ok(merged);
  assert.equal(merged.ranAt, shown.ranAt);
  assert.deepEqual(merged.results.map(r => [r.key, r.status]), [['C1', 'GREEN'], ['C3', 'GREEN']]);
});

test('دمج مفرد ثم تشغيل مقيَّد يعيد المخزَّن بنفس ranAt: لا يُمحى الدمج', () => {
  const full = report('2026-09-17T10:00:00.000Z', [result('C1', 'GREEN'), result('C3', 'RED')]);
  const merged = mergeChecksRun(full, { report: report('2026-09-17T10:02:00.000Z', [result('C3', 'GREEN')]), throttled: false }, ['C3']);
  assert.ok(merged);
  const cachedSame = report('2026-09-17T10:00:00.000Z', [result('C1', 'GREEN'), result('C3', 'RED')]);
  assert.equal(mergeChecksRun(merged, { report: cachedSame, throttled: true, retryAfterSeconds: 30 }), null);
  assert.equal(mergeChecksRun(merged, { report: cachedSame, throttled: true, retryAfterSeconds: 30 }, ['C3']), null);
});

test('دمج مفرد يعيد حساب overall من النتائج المدمجة (الأسوأ يغلب)', () => {
  const red = { ...report('2026-09-17T10:00:00.000Z', [result('C1', 'GREEN'), result('C3', 'RED')]), overall: 'RED' as const };
  const fixed = mergeChecksRun(red, { report: report('2026-09-17T10:02:00.000Z', [result('C3', 'GREEN')]), throttled: false }, ['C3']);
  assert.equal(fixed?.overall, 'GREEN');
  const yellow = mergeChecksRun(red, { report: report('2026-09-17T10:02:00.000Z', [result('C3', 'YELLOW')]), throttled: false }, ['C3']);
  assert.equal(yellow?.overall, 'YELLOW');
  const worse = mergeChecksRun({ ...red, overall: 'GREEN' }, { report: report('2026-09-17T10:02:00.000Z', [result('C1', 'RED'), result('C3', 'GREEN')]), throttled: false }, ['C1']);
  assert.equal(worse?.overall, 'RED');
});

test('worstStatus: الأسوأ يغلب وبلا حالات GREEN', () => {
  assert.equal(worstStatus([]), 'GREEN');
  assert.equal(worstStatus(['GREEN', 'YELLOW', 'GREEN']), 'YELLOW');
  assert.equal(worstStatus(['YELLOW', 'RED', 'GREEN']), 'RED');
});

test('تشغيل كامل غير مقيَّد: يستبدل المعروض', () => {
  const full = report('2026-09-17T10:07:00.000Z', [result('C1', 'YELLOW')]);
  assert.equal(mergeChecksRun(shown, { report: full, throttled: false }), full);
});
