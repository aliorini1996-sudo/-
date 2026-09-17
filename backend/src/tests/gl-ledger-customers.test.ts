// M3 — قائمتا «العملاء» و«مراجعة ← سجل التدقيق» في الدفاتر (DESIGN.md §8.2، INV‑01، PAY‑01، §5.9 C4/C4b/C5، §9.3).
// صرفة بلا قاعدة: حالة الترحيل من حدثي POST/REVERSE، ومعاملات الاستعلام؛ وحراس ثابتة: النقاط قراءة فقط بصلاحياتها
// ومسجّلة في index.ts، ولا تستوردها المسارات التشغيلية.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { instantRange, listOf, pageOf, postingStateOf, INVOICE_TYPES } from '../routes/ledger/customers';
import { auditWhere } from '../routes/ledger/review';
import { LedgerHttpError } from '../routes/ledger/errors';

const ROUTES = path.join(__dirname, '../routes/ledger');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (f: string) => stripComments(fs.readFileSync(path.join(ROUTES, f), 'utf8'));
const ev = (status: string, skipReason: string | null = null) => ({ status, skipReason });

test('حالة الترحيل: لا حدث ⇒ NOT_SYNCED، وPOST غير النهائي بحالته', () => {
  assert.equal(postingStateOf(null, null), 'NOT_SYNCED');
  for (const s of ['PENDING', 'BLOCKED', 'ERROR', 'HELD']) assert.equal(postingStateOf(ev(s), null), s);
  // العكس المعلّق لا يغطّي POST غير المرحّل
  assert.equal(postingStateOf(ev('PENDING'), ev('PENDING')), 'PENDING');
});

test('حالة الترحيل: DONE ثم العكس، والمشمول بالافتتاح، والتخطي', () => {
  assert.equal(postingStateOf(ev('DONE'), null), 'POSTED');
  assert.equal(postingStateOf(ev('DONE'), ev('BLOCKED')), 'REVERSE_PENDING');
  assert.equal(postingStateOf(ev('DONE'), ev('DONE')), 'REVERSED');
  assert.equal(postingStateOf(ev('SKIPPED', 'OPENING'), null), 'IN_OPENING');
  // فاتورة قبل تاريخ البدء أُلغيت بعد التفعيل: POST = SKIPPED(OPENING) والعكس DONE
  assert.equal(postingStateOf(ev('SKIPPED', 'OPENING'), ev('DONE')), 'REVERSED');
  assert.equal(postingStateOf(ev('SKIPPED', 'OPENING'), ev('HELD')), 'REVERSE_PENDING');
  // أُنشئ وحُذف في نبضة واحدة ⇒ الحدثان SKIPPED
  assert.equal(postingStateOf(ev('SKIPPED', 'NEVER_MATERIALIZED'), ev('SKIPPED', 'NEVER_MATERIALIZED')), 'SKIPPED');
  assert.equal(postingStateOf(ev('SKIPPED', 'ZERO_VALUE'), null), 'SKIPPED');
  // عكس بلا POST (مصدر tombstone التُقط عكسه أولاً)
  assert.equal(postingStateOf(null, ev('PENDING')), 'REVERSE_PENDING');
  assert.equal(postingStateOf(null, ev('DONE')), 'REVERSED');
});

test('معاملات الاستعلام: القوائم المسموحة، والترقيم بسقفه، والتاريخ المحلي بتوقيت الشركة', () => {
  assert.deepEqual(listOf('CASH,FOO, RETURN', INVOICE_TYPES), ['CASH', 'RETURN']);
  assert.deepEqual(listOf(['A', ' ', 'B']), ['A', 'B']);
  assert.deepEqual(pageOf({}), { offset: 0, limit: 80 });
  assert.deepEqual(pageOf({ offset: '160', limit: '5000' }), { offset: 160, limit: 200 });
  assert.deepEqual(pageOf({ offset: '-3', limit: 'x' }, 200, 50), { offset: 0, limit: 50 });
  const r = instantRange({ dateFrom: '2026-09-01', dateTo: '2026-09-30' }, 'Asia/Riyadh');
  assert.equal(r?.gte?.toString(), new Date('2026-08-31T21:00:00.000Z').toString());
  assert.equal(r?.lt?.toString(), new Date('2026-09-30T21:00:00.000Z').toString());
  assert.equal(instantRange({}, 'Asia/Riyadh'), undefined);
  assert.throws(() => instantRange({ dateFrom: '2026-13-01' }, 'Asia/Riyadh'), (e: unknown) => e instanceof LedgerHttpError && e.status === 400 && e.details.reason === 'INVALID_DATE');
});

test('فلاتر سجل التدقيق: الكيان (رابط «عرض سجل التدقيق») والإجراءات والمنفّذ معزولة بالشركة', () => {
  const w = auditWhere('t1', { entityType: 'MOVE', entityId: 'm1', action: 'MOVE_POST,bad-action,EVENT_SKIP', actorType: 'SYSTEM,HACKER', q: ' عكس ' }, 'Asia/Riyadh');
  assert.equal(w.tenantId, 't1');
  assert.equal(w.entityType, 'MOVE');
  assert.equal(w.entityId, 'm1');
  assert.deepEqual(w.action, { in: ['MOVE_POST', 'EVENT_SKIP'] });
  assert.deepEqual(w.actorType, { in: ['SYSTEM'] });
  assert.deepEqual(w.summary, { contains: 'عكس', mode: 'insensitive' });
  assert.deepEqual(auditWhere('t2', {}, 'Asia/Riyadh'), { tenantId: 't2' });
});

test('حارس ثابت: نقاط العملاء GET بـcanViewLedger، والسجل GET بـcanConfigureLedger، ولا كتابة', () => {
  const customers = code('customers.ts');
  const review = code('review.ts');
  const routes = (s: string) => [...s.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*(\w+)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
  assert.deepEqual(routes(customers), [
    'get /customers/invoices VIEW', 'get /customers/receipts VIEW', 'get /customers/custody VIEW',
    'get /customers/paylink VIEW', 'get /customers/paylink/entries VIEW',
  ]);
  assert.match(customers, /const VIEW = requireLedgerPermission\('canViewLedger'\);/);
  assert.deepEqual(routes(review), ['get /audit CONFIGURE']);
  assert.match(review, /const CONFIGURE = requireLedgerPermission\('canConfigureLedger'\);/);
  for (const [f, s] of [['customers.ts', customers], ['review.ts', review]] as const) {
    assert.doesNotMatch(s, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$transaction|appendAudit/, `${f} يكتب`);
    assert.match(s, /tenantId/, `${f} بلا عزل الشركة`);
  }
});

test('حارس ثابت: المساران مركّبان بعد سلسلة الحراسة في index.ts، ولا تستوردهما المسارات التشغيلية', () => {
  const index = code('index.ts');
  const guard = index.indexOf('router.use(authenticate, requireAdmin, requireAccountingSuite, ledgerContext);');
  assert.ok(guard > 0);
  for (const name of ['customersRouter', 'reviewRouter']) {
    assert.match(index, new RegExp(`import ${name} from './${name === 'customersRouter' ? 'customers' : 'review'}';`));
    const at = index.indexOf(`router.use(${name});`);
    assert.ok(at > guard, `${name} غير مركّب بعد الحراسة`);
  }
  for (const f of ['../invoices.ts', '../receipts.ts']) {
    const s = fs.readFileSync(path.join(ROUTES, f), 'utf8');
    assert.doesNotMatch(s, /ledger\/customers|ledger\/review/);
  }
});
