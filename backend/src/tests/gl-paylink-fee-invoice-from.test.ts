// M3 — تاريخ الفواتير الضريبية لعمولة الدفع الإلكتروني (قرار D2؛ DESIGN.md §8.1، §5.5 P9، §10.1 بند M3، ملحق ب).
// صرفة: validatePaylinkFeeInvoiceFrom وتجميع العمولات غير المرحّلة وledgerStatusOf. نصية: مسار المالك في tenants.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PAYLINK_FEE_INVOICE_FROM_MAX_FUTURE_DAYS, validatePaylinkFeeInvoiceFrom, type PaylinkFeeInvoiceFromInput,
} from '../services/gl/paylinkFee';
import {
  LEDGER_STUCK_AGE_MS, LEDGER_STUCK_EVENT_STATUSES, ledgerStatusOf, ledgerStuckCutoff, stuckCountsByTenant, summarizePendingFees,
} from '../services/gl/ownerLedger';
import { isPaylinkFeeVatRecoverable } from '../services/gl/builders/paylink';

const base: PaylinkFeeInvoiceFromInput = {
  from: '2026-10-01', current: null, lastPostedFeeDate: null, taxLockDate: null, hardLockDate: null, today: '2026-09-17',
};
const v = (o: Partial<PaylinkFeeInvoiceFromInput>) => validatePaylinkFeeInvoiceFrom({ ...base, ...o });
const invalidReason = (o: Partial<PaylinkFeeInvoiceFromInput>) => {
  const r = v(o);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error('unreachable');
  assert.equal(r.code, 'LEDGER_PAYLINK_FEE_INVOICE_DATE_INVALID');
  assert.equal(r.httpStatus, 422);
  return r.code === 'LEDGER_PAYLINK_FEE_INVOICE_DATE_INVALID' ? r.reason : null;
};

test('D2: from بعد آخر عمولة مرحّلة، وتاريخ ≤ آخر عمولة ⇒ LEDGER_PAYLINK_FEE_INVOICE_DATE_INVALID', () => {
  assert.deepEqual(v({ lastPostedFeeDate: '2026-09-10', from: '2026-09-11' }), { ok: true, from: '2026-09-11', current: null, unchanged: false });
  assert.equal(invalidReason({ lastPostedFeeDate: '2026-09-10', from: '2026-09-10' }), 'NOT_AFTER_LAST_POSTED_FEE');
  assert.equal(invalidReason({ lastPostedFeeDate: '2026-09-10', from: '2026-01-01' }), 'NOT_AFTER_LAST_POSTED_FEE');
  // عمود @db.Date
  assert.equal(invalidReason({ lastPostedFeeDate: new Date('2026-09-10T00:00:00Z'), from: '2026-09-10' }), 'NOT_AFTER_LAST_POSTED_FEE');
  const r = v({ lastPostedFeeDate: '2026-09-10', taxLockDate: '2026-06-30', from: '2026-09-01' });
  assert.ok(!r.ok && r.code === 'LEDGER_PAYLINK_FEE_INVOICE_DATE_INVALID' && r.minDate === '2026-09-11');
});

test('D2: تاريخ ≤ taxLockDate أو hardLockDate ⇒ الرمز نفسه', () => {
  assert.equal(invalidReason({ taxLockDate: '2026-06-30', from: '2026-06-30' }), 'NOT_AFTER_TAX_LOCK');
  assert.equal(invalidReason({ hardLockDate: '2026-03-31', from: '2026-03-31' }), 'NOT_AFTER_HARD_LOCK');
  assert.equal(invalidReason({ hardLockDate: new Date('2026-03-31T00:00:00Z'), from: '2026-02-01' }), 'NOT_AFTER_HARD_LOCK');
  assert.equal(v({ taxLockDate: '2026-06-30', hardLockDate: '2026-03-31', from: '2026-07-01' }).ok, true);
});

test('D2 today: الماضي جائز بعد القيود، والمستقبل حتى today + 90 يوماً وما بعدها مرفوض', () => {
  assert.equal(PAYLINK_FEE_INVOICE_FROM_MAX_FUTURE_DAYS, 90);
  assert.equal(v({ from: '2025-01-01' }).ok, true, 'ماضٍ بلا عمولات مرحّلة ولا إقفال');
  assert.equal(v({ from: '2026-12-16' }).ok, true, 'today + 90');
  assert.equal(invalidReason({ from: '2026-12-17' }), 'TOO_FAR_IN_FUTURE');
  assert.equal(invalidReason({ from: '2027-10-01' }), 'TOO_FAR_IN_FUTURE', 'خطأ إدخال السنة');
  assert.equal(invalidReason({ from: '2026-13-01' }), 'FORMAT');
  assert.throws(() => v({ today: 'x' as never }));
});

test('D2: تعديل أو مسح تاريخ قائم بعد ترحيل عمولة تاريخها ≥ القائم ⇒ LEDGER_PAYLINK_FEE_INVOICE_DATE_LOCKED', () => {
  const locked = { current: '2026-08-01', lastPostedFeeDate: '2026-08-01' } as const;
  for (const from of ['2026-09-01', '2026-07-01', null]) {
    const r = v({ ...locked, from });
    assert.equal(r.ok, false, String(from));
    assert.ok(!r.ok && r.code === 'LEDGER_PAYLINK_FEE_INVOICE_DATE_LOCKED' && r.httpStatus === 409);
  }
  assert.equal(v({ current: '2026-08-01', lastPostedFeeDate: '2026-09-15', from: null }).ok, false);
  // القيمة نفسها ⇒ بلا تغيير ولا رفض
  assert.deepEqual(v({ ...locked, from: '2026-08-01' }), { ok: true, from: '2026-08-01', current: '2026-08-01', unchanged: true });
  // كل العمولات المرحّلة قبل القائم ⇒ التعديل والمسح مسموحان (ما دام الجديد بعدها)
  assert.deepEqual(v({ current: '2026-08-01', lastPostedFeeDate: '2026-07-31', from: null }), { ok: true, from: null, current: '2026-08-01', unchanged: false });
  assert.equal(v({ current: '2026-08-01', lastPostedFeeDate: '2026-07-31', from: '2026-08-15' }).ok, true);
  assert.equal(invalidReason({ current: '2026-08-01', lastPostedFeeDate: '2026-07-31', from: '2026-07-31' }), 'NOT_AFTER_LAST_POSTED_FEE');
  assert.equal(v({ current: new Date('2026-08-01T00:00:00Z'), lastPostedFeeDate: null, from: '2026-08-01' }).ok, true);
});

test('القاعدة تتسق مع P9: العمولة المرحّلة قبل التاريخ الجديد تبقى غير مستردة', () => {
  // لا تاريخ مقبول ≤ آخر عمولة مرحّلة ⇒ لا عمولة مرحّلة تنتقل إلى «مستردة»
  const lastFee = new Date('2026-09-10T20:59:00Z'); // 23:59 الرياض
  const s = { paylinkFeeTaxInvoiceFrom: '2026-09-11', timezone: 'Asia/Riyadh' } as const;
  assert.equal(v({ lastPostedFeeDate: '2026-09-10', from: s.paylinkFeeTaxInvoiceFrom }).ok, true);
  assert.equal(isPaylinkFeeVatRecoverable(lastFee, s), false);
  assert.equal(isPaylinkFeeVatRecoverable(new Date('2026-09-10T21:00:00Z'), s), true);
});

test('pendingFeesAffected: العمولات غير النهائية وحدها بالقيمة المطلقة (amount = −feeGross)', () => {
  const r = summarizePendingFees(
    [{ id: 'a', amount: -41 }, { id: 'b', amount: -1.15 }, { id: 'c', amount: -10 }, { id: 'd', amount: '-2.5' }],
    new Set(['c']),
    2,
  );
  assert.deepEqual(r, { count: 3, feeMilli: 44650, fee: '44.65' });
  assert.deepEqual(summarizePendingFees([], new Set(), 2), { count: 0, feeMilli: 0, fee: '0.00' });
});

test('ledgerStatus: OFF / PENDING_SETUP / STUCK / RUNNING وأقدم من 24 ساعة', () => {
  const on = { accountingSuiteEnabled: true, accountingEnabled: true, activatedAt: new Date(), stuckEvents: 0 };
  assert.equal(ledgerStatusOf({ ...on, accountingSuiteEnabled: false }), 'OFF');
  assert.equal(ledgerStatusOf({ ...on, accountingSuiteEnabled: null }), 'OFF');
  assert.equal(ledgerStatusOf({ ...on, accountingEnabled: false }), 'OFF');
  assert.equal(ledgerStatusOf({ ...on, accountingEnabled: false, stuckEvents: 4 }), 'OFF');
  assert.equal(ledgerStatusOf({ ...on, activatedAt: null, stuckEvents: 2 }), 'PENDING_SETUP');
  assert.equal(ledgerStatusOf({ ...on, stuckEvents: 1 }), 'STUCK');
  assert.equal(ledgerStatusOf(on), 'RUNNING');
  assert.deepEqual([...LEDGER_STUCK_EVENT_STATUSES], ['ERROR', 'HELD', 'BLOCKED']);
  assert.equal(LEDGER_STUCK_AGE_MS, 86_400_000);
  assert.equal(ledgerStuckCutoff(new Date('2026-09-17T12:00:00Z')).toISOString(), '2026-09-16T12:00:00.000Z');
  const m = stuckCountsByTenant([{ tenantId: 't1', _count: { _all: 3 } }, { tenantId: 't2', _count: { _all: 1 } }]);
  assert.equal(m.get('t1'), 3);
  assert.equal(m.get('t3'), undefined);
});

// ── حراس نصية ──

const SRC = path.join(__dirname, '..');
const strip = (s: string) => s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const tenantsSrc = strip(fs.readFileSync(path.join(SRC, 'routes/tenants.ts'), 'utf8'));

function routeBody(s: string, method: string, route: string): string {
  const head = `router.${method}('${route}'`;
  const i = s.indexOf(head);
  assert.ok(i >= 0, `المسار مفقود: ${head}`);
  const next = s.slice(i + head.length).search(/\nrouter\.(get|post|put|delete|patch)\(/);
  return next < 0 ? s.slice(i) : s.slice(i, i + head.length + next);
}

test('حارس ثابت: PUT /:id/ledger-paylink-fee-invoice-from تحت authenticate+requireSuperAdmin، في معاملة تحت قفل gl-post، مع SETTINGS_CHANGE', () => {
  const guardUse = tenantsSrc.indexOf('router.use(authenticate, requireSuperAdmin)');
  const route = tenantsSrc.indexOf("router.put('/:id/ledger-paylink-fee-invoice-from'");
  assert.ok(guardUse >= 0 && route > guardUse, 'المسار بعد router.use(authenticate, requireSuperAdmin) القائم');
  const body = routeBody(tenantsSrc, 'put', '/:id/ledger-paylink-fee-invoice-from');
  const txm = /\$transaction\(\s*async\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{/.exec(body);
  assert.ok(txm, 'معاملة تفاعلية');
  const inner = body.slice(txm.index + txm[0].length);
  assert.match(/await\s+([^;]+);/.exec(inner)![1], /^acquirePostLock\(\s*tx\s*,/, 'القفل أول عبارة');
  const order = ['LEDGER_NOT_SETUP', 'validatePaylinkFeeInvoiceFrom(', 'glSettings.update(', "action: 'SETTINGS_CHANGE'", 'notification.create('];
  let pos = -1;
  for (const n of order) {
    const idx = inner.indexOf(n, pos + 1);
    assert.ok(idx > pos, `«${n}» مفقود أو خارج الترتيب`);
    pos = idx;
  }
  assert.match(body, /actor = ownerActor\(req\)/);
  assert.match(inner, /status: 'DONE'/, 'آخر عمولة مرحّلة من أحداث DONE');
  assert.match(inner, /pendingFeesAffected/);
  assert.match(inner, /before: \{ paylinkFeeTaxInvoiceFrom/);
  assert.match(inner, /after: \{ paylinkFeeTaxInvoiceFrom/);
  // ownerActor نفسه بـOWNER
  assert.match(tenantsSrc, /function ownerActor[\s\S]{0,200}actorType: 'OWNER'/);
});

test('حارس ثابت: مخطط PUT /api/ledger/settings لا يحتوي paylinkFeeTaxInvoiceFrom فلا يكتبه أدمن الشركة', () => {
  const cfg = strip(fs.readFileSync(path.join(SRC, 'routes/ledger/config.ts'), 'utf8'));
  const start = cfg.indexOf('const settingsUpdateSchema');
  assert.ok(start >= 0, 'settingsUpdateSchema');
  const end = cfg.indexOf("router.put('/settings'", start);
  assert.ok(end > start);
  assert.doesNotMatch(cfg.slice(start, end), /paylinkFeeTaxInvoiceFrom/);
  const put = cfg.slice(end, cfg.indexOf('\n}));', end));
  assert.doesNotMatch(put, /paylinkFeeTaxInvoiceFrom/);
  // ولا مسار آخر تحت routes/ledger يكتبه
  const dir = path.join(SRC, 'routes/ledger');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const s = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.doesNotMatch(s, /paylinkFeeTaxInvoiceFrom\s*:\s*(toDbDate|body|data|parsed|req)/, f);
  }
});
