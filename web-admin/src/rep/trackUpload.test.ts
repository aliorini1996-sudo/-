import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  uploadDue, afterSuccess, afterFailure, retryable, requeue, metersBetween, initialUpload,
  MOVE_M, MOVING_GAP_MS, IDLE_GAP_MS, MAX_PENDING, RETRY_START_MS, RETRY_MAX_MS, type TrackPoint,
} from './trackUpload';

// علاج «تأخّر الموقع» (طلب المالك، ٢٢ أكتوبر ٢٠٢٦): كان الموقع يُرفع دفعةً كل ٤٥ث بقراءةٍ مخبّأة حتى ١٠ث فيصل بعد قرابة
// دقيقة، والدفعة الفاشلة تُرمى. الآن فوراً عند الفتح والعودة، وكل ١٥ث متحرّكاً، وكل ٣٠ث ساكناً، والفاشل يُعاد بتراجع.

const HERE = { lat: 24.7136, lng: 46.6753 };
// ~٥٥م شمالاً (٠٫٠٠٠٥ درجة عرض ≈ ٥٥٫٦م)
const MOVED = { lat: 24.7141, lng: 46.6753 };
// ~١١م — ضجيج GPS لجوالٍ ساكن
const JITTER = { lat: 24.7137, lng: 46.6753 };

test('المسافة بالأمتار تقريباً صحيحة', () => {
  assert.ok(Math.abs(metersBetween(HERE, MOVED) - 55.6) < 1);
  assert.ok(metersBetween(HERE, JITTER) < MOVE_M);
});

test('أول نقطةٍ تُرفع فوراً — لا انتظار ٤٥ث بعد فتح التطبيق', () => {
  assert.equal(uploadDue(initialUpload(), HERE, 1_000), true);
});

test('الساكن يُرفع كل ٣٠ث، وضجيج GPS ليس تحرّكاً', () => {
  const st = afterSuccess(HERE, 0);
  assert.equal(uploadDue(st, JITTER, MOVING_GAP_MS + 1), false);
  assert.equal(uploadDue(st, JITTER, IDLE_GAP_MS - 1), false);
  assert.equal(uploadDue(st, JITTER, IDLE_GAP_MS), true);
});

test('المتحرّك يُرفع كل ١٥ث، لا أسرع (حدّ الطلبات والقاعدة)', () => {
  const st = afterSuccess(HERE, 0);
  assert.equal(uploadDue(st, MOVED, MOVING_GAP_MS - 1), false);
  assert.equal(uploadDue(st, MOVED, MOVING_GAP_MS), true);
});

test('العودة للتطبيق أو عودة الاتصال (urgent) ترفع فوراً — لكن لا قبل نهاية تراجعٍ بعد فشل', () => {
  const st = { ...afterSuccess(HERE, 0), urgent: true };
  assert.equal(uploadDue(st, JITTER, 1_000), true);
  assert.equal(uploadDue({ ...st, retryAt: 20_000 }, JITTER, 10_000), false);
  assert.equal(uploadDue({ ...st, retryAt: 20_000 }, JITTER, 20_000), true);
});

test('التراجع بعد الفشل يبدأ ١٥ث ويتضاعف حتى دقيقتين، والنجاح يصفّره', () => {
  let st = initialUpload();
  st = afterFailure(st, 0);
  assert.equal(st.backoff, RETRY_START_MS);
  assert.equal(st.retryAt, RETRY_START_MS);
  for (let i = 0; i < 10; i++) st = afterFailure(st, 0);
  assert.equal(st.backoff, RETRY_MAX_MS);
  const ok = afterSuccess(HERE, 5);
  assert.equal(ok.backoff, 0);
  assert.equal(ok.retryAt, 0);
  assert.equal(ok.urgent, false);
});

test('يُعاد: الشبكة و401 و408 و429 و5xx. ويُرمى: 400 و403 (دفعةٌ لا تصلح)', () => {
  for (const s of [undefined, 401, 408, 429, 500, 503]) assert.equal(retryable(s), true, String(s));
  for (const s of [400, 403, 404, 422]) assert.equal(retryable(s), false, String(s));
});

test('الدفعة الفاشلة تعود أمام ما جُمع بعدها بترتيبها، والأقدم يسقط فوق السقف', () => {
  const pt = (i: number): TrackPoint => ({ lat: i, lng: i, capturedAt: new Date(i * 1000).toISOString() });
  assert.deepEqual(requeue([pt(1), pt(2)], [pt(3)]).map((p) => p.lat), [1, 2, 3]);
  // الأحدث يُرفع أولاً: دفعته الفاشلة أحدث مما بقي — تعود إلى مكانها الزمني
  assert.deepEqual(requeue([pt(5), pt(6)], [pt(1), pt(2), pt(7)]).map((p) => p.lat), [1, 2, 5, 6, 7]);
  const many = Array.from({ length: MAX_PENDING }, (_, i) => pt(i + 10));
  const out = requeue([pt(1), pt(2)], many);
  assert.equal(out.length, MAX_PENDING);
  assert.equal(out[0].lat, 10, 'الأقدم (الدفعة الفاشلة نفسها) سقط');
  assert.equal(out[out.length - 1].lat, MAX_PENDING + 9);
});

test('حارس ثابت: التتبّع بقراءةٍ طازجة، والرفع بالسياسة لا بمؤقّت ٤٥ث، والفاشل يُعاد لا يُرمى', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'src', 'rep', 'useRepTracking.ts'), 'utf8');
  assert.match(src, /\{ enableHighAccuracy: true, maximumAge: 0, timeout: 30000 \}/);
  assert.doesNotMatch(src, /setInterval\(flush, 45000\)/);
  assert.doesNotMatch(src, /buffer\.current\.length >= 8\) flush/);
  assert.match(src, /buffer\.current = requeue\(batch, buffer\.current\);/);
  assert.match(src, /if \(newest && uploadDue\(upload\.current, newest, Date\.now\(\)\)\) flush\(\);/);
  // الأحدث أولاً بعد انقطاع، والمتراكم يُفرَّغ بعد تحرير القفل (queueMicrotask قبله كان لا يفعل شيئاً)
  assert.match(src, /buffer\.current\.splice\(Math\.max\(0, buffer\.current\.length - MAX_BATCH\)\)/);
  assert.match(src, /\.finally\(\(\) => \{ inFlight\.current = false; if \(more\) flush\(false, true\); \}\);/);
  assert.doesNotMatch(src, /queueMicrotask/);
  // مهلةٌ للطلب فلا يعلق قفل الرفع، وردٌّ متأخر بعد تبدّل الصاحب لا يكتب حالة الرفع الجديدة
  assert.match(src, /\{ background: true, timeout: PING_TIMEOUT_MS \}/);
  assert.match(src, /postKeepalive\('\/tracking\/ping', \{ points: batch \}, PING_TIMEOUT_MS\)/);
  assert.match(src, /\.then\(\(\) => \{\s*\/\/[^\n]*\n\s*if \(cancelled \|\| currentRepId\(\) !== who\) return;/);
  // جهازٌ مشترك: نقاط من خرج لا تُرفع بتوكن من دخل بعده
  assert.match(src, /if \(!who \|\| who !== owner\.current\) \{ buffer\.current = \[\]; return; \}/);
  assert.match(src, /if \(currentRepId\(\) !== who\) return; \/\/ خرج صاحبها أثناء الطلب/);
  assert.match(src, /window\.addEventListener\('online', onOnline\);/);
  // قراءةٌ طازجة للساكن بعد أول قراءة وحدها — قبلها قد تكون نافذة الإذن معروضة
  assert.match(src, /lastKept\.current === 0 \|\|/);
  // الإخفاء والإغلاق بطلبٍ يكمل بعدهما (axios قد يُقطع فتضيع آخر النقاط)
  assert.match(src, /if \(document\.hidden\) \{ flush\(true\); return; \}/);
  assert.match(src, /const onUnload = \(\) => flush\(true\);/);
  const api = fs.readFileSync(path.resolve(process.cwd(), 'src', 'rep', 'repApi.ts'), 'utf8');
  assert.match(api, /keepalive: true,/);
  assert.match(api, /\.\.\.\(token \? \{ Authorization: `Bearer \$\{token\}` \} : \{\}\),/, 'التوكن في الترويسة لا في الرابط');
});
