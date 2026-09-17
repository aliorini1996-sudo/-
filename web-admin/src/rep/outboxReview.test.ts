import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CUTOVER_REVIEW_CODE, REVIEW_RECHECK_MS, clearReview, heartbeatPayload, reviewRecheckDue, underCutoverReview } from './outboxReview';
import { COMPANY_REFRESH_MIN_GAP_MS, companyRefreshDue } from './companyRefresh';
import type { OutboxDoc } from './offlineDb';

/**
 * فوترة ZATCA المرحلة الثانية (Z5.0 — خامل حتى Z5.8) في تطبيق المندوب:
 *  • نبضة المندوب تحمل الحزمة وعدّي الصفّ الصادر لكل المناديب على الجهاز (نقد الخطة 23) — والشكل يطابق ما يقبله الخادم.
 *  • ZATCA_CUTOVER_REVIEW يُبقي المستند مصفوفاً «قيد مراجعة الإدارة» والمزامنة تتابع (continue لا break — نقد الخطة 3)،
 *    بلا «إزالة»، ولا يُسأل عنه قبل المهلة. إعادة الرفع من الصفّ تحمل X-FS-Replay: 1.
 *  • /company يتجدّد عند العودة أو الاتصال مرة كل 5 دقائق على الأكثر (نقد الخطة 28).
 */

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const T = Date.parse('2026-12-01T09:00:00.000Z');

const doc = (over: Partial<OutboxDoc>): Pick<OutboxDoc, 'kind' | 'status'> => ({ kind: 'invoice', status: 'queued', ...over });

test('جسم النبضة: الحزمة دائماً؛ العدّان لكل غير المرفوع (منتظر أو مرفوض) والضريبي = الفواتير؛ تعذّر القراءة ⇒ بلا عدّ', () => {
  const docs = [
    doc({}), doc({ status: 'rejected' }), doc({ status: 'sent' }), doc({ kind: 'receipt' }), doc({ kind: 'visit', status: 'rejected' }),
    doc({ kind: 'customer', status: 'sent' }), doc({ kind: 'dailyReport' }),
  ];
  assert.deepEqual(heartbeatPayload('b1', docs), { bundle: 'b1', outboxPending: 5, outboxTaxPending: 2 });
  assert.deepEqual(heartbeatPayload('b1', []), { bundle: 'b1', outboxPending: 0, outboxTaxPending: 0 });
  assert.deepEqual(heartbeatPayload('b1', null), { bundle: 'b1' });
  const p = heartbeatPayload('b1', docs);
  assert.ok((p.outboxTaxPending ?? 0) <= (p.outboxPending ?? 0), 'الخادم يرفض ضريبياً أكبر من الكلي');
});

test('مستند قيد المراجعة: لا يُعاد سؤاله قبل المهلة؛ غيره يُرفع دائماً', () => {
  assert.equal(reviewRecheckDue({}, T), true);
  assert.equal(reviewRecheckDue({ reviewCode: 'OTHER', reviewCheckedAt: new Date(T).toISOString() }, T), true);
  const at = new Date(T).toISOString();
  assert.equal(reviewRecheckDue({ reviewCode: CUTOVER_REVIEW_CODE, reviewCheckedAt: at }, T + REVIEW_RECHECK_MS - 1), false);
  assert.equal(reviewRecheckDue({ reviewCode: CUTOVER_REVIEW_CODE, reviewCheckedAt: at }, T + REVIEW_RECHECK_MS), true);
  assert.equal(reviewRecheckDue({ reviewCode: CUTOVER_REVIEW_CODE }, T), true, 'بلا وقت = يُسأل');
  assert.equal(reviewRecheckDue({ reviewCode: CUTOVER_REVIEW_CODE, reviewCheckedAt: 'x' }, T), true);
  assert.equal(underCutoverReview({ reviewCode: CUTOVER_REVIEW_CODE }), true);
  assert.equal(underCutoverReview({}), false);
});

test('الخروج من المراجعة: المرفوض والمرفوع بلا وسمها («إزالة» تظهر للمرفوض)، والمُعاد يدوياً لا يُوسم «قيد مراجعة الإدارة»', () => {
  const at = new Date(T).toISOString();
  assert.equal(underCutoverReview({ reviewCode: CUTOVER_REVIEW_CODE, status: 'queued' }), true);
  assert.equal(underCutoverReview({ reviewCode: CUTOVER_REVIEW_CODE, status: 'rejected' }), false, 'وسم قديم على مرفوض');
  assert.equal(underCutoverReview({ reviewCode: CUTOVER_REVIEW_CODE, status: 'sent' }), false);
  const cleared = clearReview({ clientRef: 'r1', status: 'queued' as const, reviewCode: CUTOVER_REVIEW_CODE, reviewCheckedAt: at });
  assert.deepEqual(cleared, { clientRef: 'r1', status: 'queued', reviewCode: undefined, reviewCheckedAt: undefined });
  assert.equal(underCutoverReview(cleared), false);
  assert.equal(reviewRecheckDue(cleared, T), true);

  const s = read('src', 'rep', 'offlineSync.ts');
  assert.ok(s.includes("import { CUTOVER_REVIEW_CODE, clearReview, reviewRecheckDue } from './outboxReview';"));
  assert.ok(s.includes("await outboxUpdate({ ...clearReview(doc), status: 'sent', serverNumber: server.number, serverId: server.id });"), 'المرفوع');
  assert.ok(s.includes("await outboxUpdate({ ...clearReview(doc), status: 'rejected', error: msg || 'رفضه الخادم' });"), 'المرفوض');
  // كل انتقال إلى sent أو rejected أو queued (إعادة) يمرّ بـclearReview — ووسم المراجعة يُكتب في موضعه وحده
  const transitions = [...s.matchAll(/outboxUpdate\(\{ \.\.\.([^,]+),[^\n]*?status: '(sent|rejected|queued)'/g)];
  assert.equal(transitions.length, 3);
  for (const m of transitions) assert.equal(m[1], 'clearReview(doc)', m[0]);
  assert.equal(s.split('reviewCode: CUTOVER_REVIEW_CODE').length - 1, 1);
});

test('المزامنة: X-FS-Replay على كل رفع من الصفّ، وZATCA_CUTOVER_REVIEW يُبقي المستند ويتابع قبل فرع الرفض — وبقية الاستثناءات كما هي', () => {
  const s = read('src', 'rep', 'offlineSync.ts');
  assert.ok(s.includes("const res = await repApi.post(endpoint, doc.payload, { headers: { 'X-FS-Replay': '1' } });"));
  assert.equal(s.split('repApi.post(').length - 1, 1, 'رفع واحد فقط في المزامنة');
  assert.ok(s.includes(".filter((d) => d.status === 'queued' && ownedByCurrentRep(d) && reviewRecheckDue(d, startedAt))"));
  const i = s.indexOf('if (code === CUTOVER_REVIEW_CODE) {');
  const block = s.slice(i, s.indexOf('\n        }', i));
  assert.ok(i > s.indexOf("code === 'ACCOUNTING_NOT_ALLOWED'"), 'بعد استثناء المحاسبة');
  assert.ok(i < s.indexOf("status: 'rejected'"), 'قبل فرع رفض الأعمال');
  assert.match(block, /await outboxUpdate\(\{ \.\.\.doc, reviewCode: CUTOVER_REVIEW_CODE, reviewCheckedAt: new Date\(\)\.toISOString\(\), error: msg \|\| undefined \}\);\s*continue;$/);
  assert.doesNotMatch(block, /stopped = true|break;|status: 'rejected'|status: 'sent'/, 'لا توقّف ولا رفض ولا إعدام');
  // استثناءات إطفاء الميزات كما كانت (توقّف لا إعدام)
  assert.match(s, /if \(code === 'ACCOUNTING_NOT_ALLOWED'\) \{[\s\S]*?stopped = true;\s*break;/);
  assert.ok(s.includes("await outboxUpdate({ ...clearReview(doc), status: 'queued', error: undefined }); notify();"), 'إعادة المحاولة تسأل الآن وبلا وسم المراجعة');
});

test('لوحة الصفّ: «قيد مراجعة الإدارة» للمنتظر قيد المراجعة، ولا «إزالة» لمستند قيد المراجعة', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  const panel = app.slice(app.indexOf('function OutboxPanel('), app.indexOf('\n}\n', app.indexOf('function OutboxPanel(')));
  assert.ok(panel.includes("{underCutoverReview(d) ? tr('قيد مراجعة الإدارة') : new Date(d.clientCreatedAt)"));
  const remove = panel.indexOf("{tr('إزالة')}</button>");
  const guard = panel.lastIndexOf('{!underCutoverReview(d) && (', remove);
  assert.ok(guard > 0 && remove - guard < 400, '«إزالة» خارج شرط المراجعة');
  assert.ok(app.includes("import { underCutoverReview } from './outboxReview';"));
});

test('نبضة المندوب ترسل جسم heartbeatPayload(BUILD_ID, صفّ الجهاز) — خلفية وبلا تغيير في مواعيدها', () => {
  const s = read('src', 'rep', 'useHeartbeat.ts');
  assert.match(s, /outboxAllOrNull\(\)\s*\.then\(\(docs\) => repApi\.post\('\/tracking\/heartbeat', heartbeatPayload\(BUILD_ID, docs\), \{ background: true \}\)\)/);
  assert.ok(s.includes('const timer = setInterval(beat, 60000);'));
  assert.ok(s.includes("import { BUILD_ID } from '../lib/buildId';"));
  const db = read('src', 'rep', 'offlineDb.ts');
  assert.match(db, /export async function outboxAllOrNull\(\): Promise<OutboxDoc\[\] \| null> \{\s*try \{ return \(await tx<OutboxDoc\[\]>\(STORE_OUTBOX, 'readonly', \(s\) => s\.getAll\(\)\)\) \|\| \[\]; \}\s*catch \{ return null; \}/);
  // الخادم: نفس أسماء الحقول وحدود الحزمة
  const server = read('..', 'backend', 'src', 'services', 'repHeartbeat.ts');
  for (const k of ['b.bundle', 'b.outboxPending', 'b.outboxTaxPending']) assert.ok(server.includes(k), k);
});

test('/company في تطبيق المندوب: يتجدّد عند العودة أو الاتصال مرة كل 5 دقائق على الأكثر، وخلفياً', () => {
  assert.equal(COMPANY_REFRESH_MIN_GAP_MS, 5 * 60 * 1000);
  assert.equal(companyRefreshDue(null, T), true);
  assert.equal(companyRefreshDue(T, T + COMPANY_REFRESH_MIN_GAP_MS - 1), false);
  assert.equal(companyRefreshDue(T, T + COMPANY_REFRESH_MIN_GAP_MS), true);
  assert.equal(companyRefreshDue(Number.NaN, T), true);
  const app = read('src', 'rep', 'RepApp.tsx');
  const i = app.indexOf('let last = Date.now(); // الجلب الأول في المؤثّر أعلاه');
  assert.ok(i > app.indexOf("fetchThenCache<Company>('company'"), 'بعد مؤثّر الجلب الأول');
  const effect = app.slice(i, app.indexOf('}, [token]);', i));
  assert.match(effect, /if \(!navigator\.onLine \|\| document\.hidden \|\| !companyRefreshDue\(last, Date\.now\(\)\)\) return;/);
  assert.match(effect, /repApi\.get\('\/company', \{ background: true \}\)/);
  assert.match(effect, /document\.addEventListener\('visibilitychange', refresh\);\s*window\.addEventListener\('online', refresh\);/);
  assert.match(effect, /document\.removeEventListener\('visibilitychange', refresh\);\s*window\.removeEventListener\('online', refresh\);/);
});
