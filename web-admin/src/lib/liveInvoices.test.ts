import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSse } from './sse';
import { RECEIPT_TOUCHES } from './receiptEffects';
import { LIVE_REFETCH, LIVE_MARK_STALE, isFinalRejection, rateLimitWait } from './livePolicy';

/**
 * التحديث اللحظيّ لعمود «المدفوع» — طرف الواجهة (قرار المالك).
 * انظر backend/src/tests/live-events.test.ts لطرف الخادم.
 */

const SRC = path.join(process.cwd(), 'src');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

test('قارئ SSE: حدثٌ مكتمل، ونبضة تُتجاهل، وباقٍ غير مكتمل يُحفظ', () => {
  const r = parseSse('event: ready\ndata: {"at":1}\n\n: ping\n\nevent: invoices\ndata: {"at":2}\n\nevent: inv');
  assert.deepEqual(r.events, [
    { event: 'ready', data: '{"at":1}' },
    { event: 'invoices', data: '{"at":2}' },
  ]);
  assert.equal(r.rest, 'event: inv');
});

test('قارئ SSE: حدثٌ مقطوع بين دفعتين يكتمل في الثانية', () => {
  const a = parseSse('event: invoi');
  assert.equal(a.events.length, 0);
  const b = parseSse(a.rest + 'ces\ndata: {}\n\n');
  assert.deepEqual(b.events, [{ event: 'invoices', data: '{}' }]);
  assert.equal(b.rest, '');
});

test('قارئ SSE: نهايات CRLF من وسطاء الشبكة', () => {
  const r = parseSse('event: invoices\r\ndata: {}\r\n\r\n');
  assert.deepEqual(r.events, [{ event: 'invoices', data: '{}' }]);
});

test('المستمع مركَّب في قشرتي لوحة الويب وتطبيق الجوال', () => {
  assert.match(read('layouts/MainLayout.tsx'), /useLiveInvoiceUpdates\(/, 'لوحة الويب لا تستمع — «المدفوع» لا يتحدّث لحظياً');
  const mobile = read('m/MobileApp.tsx');
  const call = mobile.indexOf('useLiveInvoiceUpdates(');
  const firstReturn = mobile.indexOf('if (!token || !user) {');
  assert.ok(call > 0, 'تطبيق الجوال لا يستمع');
  assert.ok(call < firstReturn, 'الخطّاف بعد إرجاعٍ مبكّر — يخالف قواعد الخطّافات');
});

test('الحدث يُبطل قائمة الفواتير وما فات القائمةَ الأولى', () => {
  const hook = read('lib/liveInvoices.ts');
  assert.match(hook, /for \(const queryKey of LIVE_REFETCH\) void qc\.invalidateQueries\(\{ queryKey \}\)/, 'الحدث لا يعيد قراءة شاشات المدفوع');
  assert.match(hook, /for \(const queryKey of LIVE_MARK_STALE\) void qc\.invalidateQueries\(\{ queryKey, refetchType: 'none' \}\)/, 'الثقيل يُعاد قراءته مع كل سند');
  assert.match(hook, /Authorization: `Bearer \$\{token\}`/, 'التوكن لا يُرسل في الترويسة');
  assert.doesNotMatch(hook, /new EventSource\(|[?&]token=/, 'التوكن في الرابط يُكتب في السجلّات');
  const keys = RECEIPT_TOUCHES.map(k => k.join('/'));
  for (const k of ['invoices', 'm-docs/invoice', 'open-invoices', 'm-doc', 'statement', 'm-statement', 'rep-statement', 'customers-all']) {
    assert.ok(keys.includes(k), `المفتاح ${k} لا يُبطل بعد السند`);
  }
});

test('مندوبٌ محذوف لا يُسقط الصفحة بيضاء — salesRep قد يكون null', () => {
  for (const f of ['pages/InvoicesPage.tsx', 'pages/ReceiptsPage.tsx', 'pages/DashboardPage.tsx', 'components/forms/InvoiceDetailModal.tsx']) {
    assert.doesNotMatch(read(f), /\.salesRep\.name/, `${f}: قراءة salesRep.name بلا ?. تُسقط الصفحة عند حذف المندوب`);
  }
  assert.doesNotMatch(read('types/index.ts'), /salesRep: \{ id: string; name: string \};/, 'النوع يخفي أن المندوب قد يُحذف');
});

test('الرفض النهائيّ 400/401/403 وحده — 429 و404 و5xx عابرة يُعاد الاتصال بعدها', () => {
  for (const s of [400, 401, 403]) assert.equal(isFinalRejection(s), true, `${s} يجب أن يوقف`);
  for (const s of [404, 408, 429, 500, 502, 503]) assert.equal(isFinalRejection(s), false, `${s} أوقف التحديث بقيّة الجلسة`);
});

test('بعد 429 ينتظر ما يطلبه الخادم بسقف ربع ساعة', () => {
  assert.equal(rateLimitWait('120', 2000), 120_000);
  assert.equal(rateLimitWait(null, 4000), 4000);
  assert.equal(rateLimitWait('abc', 4000), 4000);
  assert.equal(rateLimitWait('99999', 2000), 15 * 60_000);
  assert.equal(rateLimitWait('1', 8000), 8000, 'مهلةٌ أقصر من التراجع الجاري');
});

test('المدفوع/المتبقي يُقرأ فوراً، والثقيل يُوسَم قديماً — وكلّ ما يمسّه السند مغطّى', () => {
  const k = (x: readonly string[]) => x.join('/');
  const fast = new Set(LIVE_REFETCH.map(k));
  for (const must of ['invoices', 'm-docs/invoice', 'm-doc', 'open-invoices', 'm-rcp-invoices']) {
    assert.ok(fast.has(must), `${must} لا يُقرأ فوراً — «المدفوع» لا يتحدّث لحظياً`);
  }
  for (const heavy of ['dashboard', 'm-dashboard', 'customers-all']) {
    assert.ok(!fast.has(heavy), `${heavy} يُعاد قراءته مع كل سند في الشركة`);
  }
  const all = new Set([...LIVE_REFETCH, ...LIVE_MARK_STALE].map(k));
  for (const t of RECEIPT_TOUCHES) assert.ok(all.has(k(t)), `${k(t)} يمسّه السند ولا يُحدَّث لحظياً`);
});

test('الالتقاط بعد الانقطاع عند تأكيد الاشتراك لا قبله، والإخفاء القصير لا يُغلق القناة', () => {
  const hook = read('lib/liveInvoices.ts');
  assert.match(hook, /if \(ev\.event === 'ready'\) \{\s*if \(needCatchUp\) refresh\(\);/, 'الالتقاط قبل أن يسجّل الخادم الاشتراك — نافذةٌ يضيع فيها سند');
  assert.match(hook, /needCatchUp = true;\s*await sleep\(wait\);/, 'محاولةٌ فاشلة لا تستوجب التقاطاً عند الاتصال التالي');
  assert.match(hook, /HIDDEN_GRACE_MS/, 'كل تبديلٍ سريع للتطبيق يُغلق القناة ويعيد القراءة');
  assert.match(hook, /MIN_GAP_MS/, 'لا حدّ أدنى بين جولات القراءة');
});
