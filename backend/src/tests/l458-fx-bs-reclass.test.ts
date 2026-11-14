// «ربط الدفاتر» L8 — إصلاح مراجعة ١٤ نوفمبر: إعادة تصنيف أرصدة الشركاء في الميزانية (E5.15) موصولةٌ بالمسار الحقيقي.
//
// كان balanceSheetAdapter يمرّر settings بلا linkedPosting، ولا يستدعي أحدٌ loadPartnerReclass — فاختبار E5.15 الصرف أخضر والميزة
// غائبة في الإنتاج: ذمم العملاء صافية 4,700 بلا «مستردات العملاء وأرصدتهم الدائنة» ولا «دفعات مقدمة للموردين» ولا تحذير.
// هنا: GET /reports/balance-sheet فوق Prisma مزيّف بشركتين (مربوطة ويدوية) — المربوطة بالسطرين والتحذير ومتّزنة، وعمود المقارنة
// بأرصدة تاريخه، واليدوية كما كانت حرفاً بلا قراءة أرصدة الشركاء. بلا قاعدة ولا خادم.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';
import { FakeDb } from './l458-a10-fake-db';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const db = new FakeDb();
stub('config/database', { default: db.client() });
/* eslint-disable @typescript-eslint/no-var-requires */
const reportsMod = require('../routes/ledger/reports') as typeof import('../routes/ledger/reports');
/* eslint-enable @typescript-eslint/no-var-requires */

const LINKED = 'tenant-linked';
const MANUAL = 'tenant-manual';
const ACTOR = 'admin-1';
const ACTOR_M = 'admin-m';
const actorOf = (t: string) => (t === MANUAL ? ACTOR_M : ACTOR);
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const M = (sar: number) => BigInt(Math.round(sar * 1000));

/** E5.15 لكل شركة: العميل A مدين 5,000، والعميل B دائن 300 (سند غير مخصّص)، والمورّد V مدين 200 (دفعة مقدمة)، والمورّد W دائن 1,000 */
function seedTenant(t: string, setupMethod: string): void {
  const a = (id: string) => `${t}:${id}`;
  db.insert('glSettings', [{
    tenantId: t, setupMethod, activatedAt: new Date('2026-02-01T00:00:00Z'), currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh',
    fiscalYearEndMonth: 12, fiscalYearEndDay: 31, drawingsAfterNetProfit: false, depreciationInOperatingExpenses: false,
  }]);
  db.insert('glAccount', [
    { id: a('cash'), tenantId: t, code: '111001', name: 'الصندوق', nameI18n: null, type: 'asset_cash', controlKind: null },
    { id: a('ar'), tenantId: t, code: '113001', name: 'ذمم العملاء', nameI18n: null, type: 'asset_receivable', controlKind: 'AR' },
    { id: a('adv'), tenantId: t, code: '115003', name: 'دفعات مقدمة للموردين', nameI18n: null, type: 'asset_prepayments', controlKind: null },
    { id: a('ap'), tenantId: t, code: '211001', name: 'الموردون', nameI18n: null, type: 'liability_payable', controlKind: 'AP' },
    { id: a('cap'), tenantId: t, code: '311001', name: 'رأس المال', nameI18n: null, type: 'equity', controlKind: null },
  ]);
  const moves: [string, string, [string, number, number, Record<string, string>?][]][] = [
    ['M1', '2026-11-02', [['ar', 5000, 0, { customerId: 'A' }], ['cap', 0, 5000]]],
    ['M2', '2026-11-03', [['cash', 300, 0], ['ar', 0, 300, { customerId: 'B' }]]],
    ['M3', '2026-11-04', [['ap', 200, 0, { vendorId: 'V' }], ['cash', 0, 200]]],
    ['M4', '2026-11-05', [['cash', 1000, 0], ['ap', 0, 1000, { vendorId: 'W' }]]],
  ];
  for (const [id, date, lines] of moves) {
    db.insert('glMove', [{ id: a(id), tenantId: t, number: id, journalId: 'j', date: D(date), state: 'POSTED', moveType: 'ENTRY', createdAt: D(date) }]);
    db.insert('glMoveLine', lines.map(([acc, dr, cr, partner], i) => ({
      id: a(`${id}-${i}`), tenantId: t, moveId: a(id), accountId: a(acc), date: D(date), posted: true, taxRole: null, seq: i,
      debitMilli: M(dr), creditMilli: M(cr), customerId: null, vendorId: null, ...(partner ?? {}),
    })));
  }
}

function seed(): void {
  db.tables = {};
  db.calls = [];
  db.insert('admin', [
    { id: ACTOR, tenantId: LINKED, isActive: true, role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: false, canViewLedger: true },
    { id: ACTOR_M, tenantId: MANUAL, isActive: true, role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: false, canViewLedger: true },
  ]);
  seedTenant(LINKED, 'LINKED');
  seedTenant(MANUAL, 'CLEAN');
}

// ═══ سلسلة المسار الحقيقية بطلب/ردّ مقلَّدين (نمط l458-a10-routes) ═══

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }

function handlersFor(router: Router, method: 'get', routePath: string) {
  for (const layer of (router as unknown as { stack: RouteLayer[] }).stack) {
    const r = layer.route;
    if (r && r.path === routePath && r.methods[method] === true) return r.stack.map((s) => s.handle);
  }
  throw new Error(`نقطة غير مسجَّلة: ${routePath}`);
}

async function balanceSheet(tenantId: string, query: Record<string, string>) {
  const res = {
    statusCode: 200, body: null as Record<string, unknown> | null, headers: {} as Record<string, unknown>,
    locals: { ledger: { tenantId, actorId: actorOf(tenantId), impersonated: false } }, onSend: null as (() => void) | null,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p as Record<string, unknown>; this.onSend?.(); return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; }, getHeader(k: string) { return this.headers[k]; },
    removeHeader(k: string) { delete this.headers[k]; }, on() { return this; }, once() { return this; },
  };
  const req = {
    params: { key: 'balance-sheet' }, query, body: {}, headers: {}, ip: '127.0.0.1', app: { get: () => undefined },
    user: { id: actorOf(tenantId), role: 'ADMIN', tenantId, name: 'محاسب', impersonated: false },
  };
  for (const handle of handlersFor(reportsMod.default, 'get', '/reports/:key')) {
    const outcome = await new Promise<'next' | 'sent'>((resolve, reject) => {
      res.onSend = () => resolve('sent');
      Promise.resolve().then(() => handle(req, res, (err?: unknown) => (err ? reject(err) : resolve('next')))).catch(reject);
    });
    if (outcome === 'sent') break;
  }
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body!.data as Record<string, unknown>;
}

/** رصيد الحساب برمزه في أقسام الميزانية (أياً كان عمق العقدة) */
function amountByCode(sections: unknown, code: string): bigint | null {
  let found: bigint | null = null;
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const o = v as Record<string, unknown>;
    // amountMilli بإشارة العرض (الالتزامات موجبة دائنةً)، لا balanceMilli (مدين − دائن)
    if (o.code === code && typeof o.amountMilli === 'string') found = BigInt(o.amountMilli);
    for (const x of Object.values(o)) walk(x);
  };
  walk(sections);
  return found;
}

test('المربوطة: الميزانية تعيد تصنيف أرصدة الشركاء — 113001 = 5,000، و214002 = 300، و211001 = 1,000، و115003 = 200، متّزنة، وتحذير PARTNER_RECLASS', async () => {
  seed();
  const d = await balanceSheet(LINKED, { asOf: '2026-11-14' });
  const rows = d.rows;
  assert.equal(amountByCode(rows, '113001'), M(5000), 'ذمم العملاء بلا خصم الأرصدة الدائنة');
  assert.equal(amountByCode(rows, '214002'), M(300), 'مستردات العملاء وأرصدتهم الدائنة');
  assert.equal(amountByCode(rows, '115003'), M(200), 'دفعات مقدمة للموردين');
  assert.equal(amountByCode(rows, '211001'), M(1000), 'الموردون بلا خصم المدين');
  const totals = d.totals as Record<string, unknown>;
  assert.equal(totals.balanced, true);
  assert.equal(totals.imbalanceMilli, '0');
  assert.equal(totals.totalAssetsMilli, String(M(6300)));
  assert.equal(totals.totalLiabilitiesMilli, String(M(1300)));
  const pr = d.partnerReclass as Record<string, unknown>;
  assert.deepEqual([pr.customerCreditsMilli, pr.vendorDebitsMilli, pr.customers, pr.vendors], [String(M(300)), String(M(200)), 1, 1]);
  const warnings = d.warnings as { code: string; details?: unknown }[];
  assert.deepEqual(warnings.filter((w) => w.code === 'PARTNER_RECLASS').map((w) => w.details), [{ customers: 1, vendors: 1 }]);
  // القراءة بالشركة نفسها وحدها
  for (const c of db.calls.filter((x) => x.model === 'glMoveLine' && x.method === 'groupBy')) {
    const s = JSON.stringify(c.args, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    assert.ok(s.includes(LINKED) && !s.includes(MANUAL), s);
  }
});

test('المربوطة بمقارنة: كل عمودٍ بأرصدة شركائه «اعتباراً من» تاريخه — العمود السابق (قبل السند غير المخصّص) بلا 214002 ولا ملخّص', async () => {
  seed();
  const d = await balanceSheet(LINKED, { asOf: '2026-11-14', comparison: 'previousPeriod', comparisonCount: '1' });
  assert.equal(amountByCode(d.rows, '214002'), M(300), 'الأساسي بإعادة التصنيف');
  const cols = d.comparisonColumns as Record<string, unknown>[];
  assert.equal(cols.length, 1);
  assert.equal(amountByCode(cols[0].sections, '214002'), null, 'العمود السابق بأرصدة تاريخه: لا رصيد دائن لعميل');
  assert.equal(cols[0].partnerReclass, undefined);
  // قراءتان لأرصدة الشركاء لكل حساب رقابي: الأساسي والعمود (بتاريخين مختلفين)
  const reads = db.calls.filter((c) => c.model === 'glMoveLine' && c.method === 'groupBy')
    .map((c) => JSON.stringify((c.args as { where: { date: { lte: Date } } }).where.date.lte));
  assert.equal(new Set(reads).size, 2, reads.join(' | '));
});

test('balanceSheetReclassInputs: المربوطة تقرأ أرصدة الشركاء لكل عمود بتاريخه، واليدوية قراءة gl_settings وحدها', async () => {
  seed();
  const p = (to: string) => ({ from: '2026-01-01', to, fyStart: '2026-01-01' }) as never;
  const linked = await reportsMod.balanceSheetReclassInputs(db.client() as never, LINKED, p('2026-11-14'), [p('2026-11-02'), p('2026-11-03')]);
  assert.equal(linked.linkedPosting, true);
  assert.deepEqual(linked.base?.customerCredits.map((x) => [x.amountMilli, x.partners]), [[M(300), 1]]);
  assert.deepEqual(linked.base?.vendorDebits.map((x) => [x.amountMilli, x.partners]), [[M(200), 1]]);
  assert.deepEqual(linked.comparisons.map((c) => c?.customerCredits.length), [0, 1], '2026-11-02 قبل سند B، و2026-11-03 بعده');
  db.calls = [];
  const manual = await reportsMod.balanceSheetReclassInputs(db.client() as never, MANUAL, p('2026-11-14'), [p('2026-11-02')]);
  assert.deepEqual(manual, { linkedPosting: false, base: null, comparisons: [null] });
  assert.deepEqual(db.calls.map((c) => `${c.model}.${c.method}`), ['glSettings.findUnique'], 'اليدوية: لا قراءة أرصدة شركاء');
});

test('اليدوية (CLEAN): الميزانية كما كانت حرفاً — ذمم العملاء صافية 4,700 بلا 214002 ولا 115003 ولا تحذير ولا ملخّص', async () => {
  seed();
  const d = await balanceSheet(MANUAL, { asOf: '2026-11-14' });
  assert.equal(amountByCode(d.rows, '113001'), M(4700));
  assert.equal(amountByCode(d.rows, '214002'), null);
  assert.equal(amountByCode(d.rows, '211001'), M(800));
  assert.equal(d.partnerReclass, undefined);
  assert.ok(!(d.warnings as { code: string }[]).some((w) => w.code === 'PARTNER_RECLASS'));
  assert.ok(!db.calls.some((c) => c.model === 'glMoveLine' && c.method === 'groupBy'), 'لا قراءة أرصدة الشركاء');
});

test('statementWarnings: تحذيرات المخرَج وحدها بشكل ReportWarning، والغائب أو غير المصفوفة لا شيء', () => {
  assert.deepEqual(reportsMod.statementWarnings({ rows: [], totals: null }), []);
  assert.deepEqual(reportsMod.statementWarnings({ rows: [], totals: null, warnings: 'x' }), []);
  assert.deepEqual(reportsMod.statementWarnings({ rows: [], totals: null, warnings: [{ code: 'PARTNER_RECLASS', message: 'm', details: { customers: 1, vendors: 0 } }, null] }),
    [{ code: 'PARTNER_RECLASS', message: 'm', details: { customers: 1, vendors: 0 } }]);
});
