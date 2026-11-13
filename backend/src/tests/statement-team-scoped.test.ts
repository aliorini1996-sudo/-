// كشف حساب العميل لمشرف الفرق: معنونٌ «لفريقك» ومعه أسماء فرقه (تدقيق دقّة التقارير، طلب المالك ١٣ نوفمبر ٢٠٢٦ — البند ١٢).
//
// القرار: لا يتغيّر ما يراه المشرف (قيود فرقه وإجمالياتها كما هي)؛ يُعنوَن الردّ وحده. teamScoped = true للمشرف ومعه
// teamNames من الاستعلام نفسه الذي يجلب فرقه، وغيره (مدير غير مقيَّد، مندوب) بالردّ كما كان حرفاً بلا teamNames.
// المسار الحقيقي GET /customers/:id/statement فوق Prisma مزيّف، والنطاق الحقيقيّ (adminScope) يقرأ وضع المستخدم منه.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'statement-team-scoped-test-secret';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// العميل: فاتورة ٣٬٠٠٠ لفريق الشمال وفاتورة ٢٬٠٠٠ لفريق آخر — رصيده الكامل المخزَّن ٥٬٠٠٠
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 9));
const entry = (id: string, teamId: string, debit: number, d: number) => ({
  id, tenantId: 'T1', customerId: 'C1', type: 'INVOICE_DEBIT', debit, credit: 0, receiptId: null, entryDate: day(d), createdAt: day(d),
  description: `فاتورة ${id}`, invoice: { id: `inv-${id}`, number: `INV-${id}`, teamId, items: [] }, receipt: null,
});
const ENTRIES = [entry('e1', 'team-north', 3000, 1), entry('e2', 'team-other', 2000, 2)];
const CUSTOMER = { id: 'C1', tenantId: 'T1', name: 'بقالة', status: 'ACTIVE', balance: 5000, totalSales: 5000, totalCollected: 0 };
// المشرف يشرف على فريقين — أحدهما بلا مستندات لهذا العميل
const SUPERVISIONS = [
  { teamId: 'team-north', team: { name: 'فريق الشمال' } },
  { teamId: 'team-south', team: { name: 'فريق الجنوب' } },
];

let mode: 'TEAMS' | 'NONE' = 'NONE';
let calls: [string, Row][] = [];
const empty = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0, aggregate: async () => ({ _sum: {}, _count: {} }) };
const db = new Proxy({
  admin: { async findUnique() { return mode === 'TEAMS' ? { scopeEnabled: true, scopeMode: 'TEAMS' } : { scopeEnabled: false, scopeMode: null }; } },
  teamSupervisor: {
    async findMany(a: Row) { calls.push(['teamSupervisor.findMany', a]); return SUPERVISIONS.map((s) => ({ ...s, team: { ...s.team } })); },
  },
  accountEntry: {
    // قيد الفريق (OR بوسم الفاتورة/السند) ⇒ قيود فرق المشرف وحدها؛ بلا قيد ⇒ الكشف كاملاً
    async findMany(a: Row) {
      calls.push(['accountEntry.findMany', a]);
      const supTeams = new Set(SUPERVISIONS.map((s) => s.teamId));
      return ENTRIES.filter((e) => !a.where?.OR || supTeams.has(e.invoice.teamId)).map((e) => ({ ...e }));
    },
  },
  receipt: { async findMany() { return []; } },
  customer: { async findFirst() { return { ...CUSTOMER }; } },
  salesRep: { async findFirst() { return { canViewStatement: true }; } },
  glSettings: { async findUnique() { return null; } },
} as Row, { get: (t, k: string) => (k in t ? t[k] : k === 'then' ? undefined : empty) });
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const customers = require('../routes/customers').default;
/* eslint-enable @typescript-eslint/no-var-requires */

async function statement(user: Row, query: Row = {}) {
  calls = [];
  const layer = (customers as { stack: Row[] }).stack.find((l) => l.route?.path === '/:id/statement' && l.route.methods.get);
  assert.ok(layer, 'GET /:id/statement غير موجود');
  const handler = layer.route.stack.slice(-1)[0].handle;
  let body: Row | null = null;
  let status = 200;
  const res = { status(s: number) { status = s; return this; }, json(b: Row) { body = b; return this; } };
  let err: unknown = null;
  await handler({ query, params: { id: 'C1' }, user }, res, (e: unknown) => { err = e; });
  if (err) throw err;
  assert.equal(status, 200);
  return body!.data;
}
const ADMIN = { id: 'a1', role: 'ADMIN', tenantId: 'T1' };

test('مشرف الفرق: teamScoped وأسماء فرقه مرتّبة، والأرقام لفريقه كما كانت', async () => {
  mode = 'TEAMS';
  const d = await statement(ADMIN);
  assert.equal(d.teamScoped, true);
  assert.deepEqual(d.teamNames, ['فريق الجنوب', 'فريق الشمال'], 'كل فرقه بالاسم مرتّبةً');
  // ما يراه لم يتغيّر: قيود فريقه وإجمالياتها
  assert.deepEqual(d.entries.map((e: Row) => e.id), ['e1']);
  assert.equal(d.closingBalance, 3000);
  assert.equal(d.customer.balance, 3000);
  assert.equal(d.customer.totalSales, 3000);
  assert.equal(d.customer.totalCollected, 0);
  // أسماء الفرق من استعلام الفرق نفسه — لا ذهاب ثانٍ إلى القاعدة
  const sup = calls.filter(([op]) => op === 'teamSupervisor.findMany');
  assert.equal(sup.length, 1);
  assert.deepEqual(sup[0][1].where, { tenantId: 'T1', adminId: 'a1' });
  assert.deepEqual(sup[0][1].select, { teamId: true, team: { select: { name: true } } });
});

test('مشرف الفرق بفترة: العنوان نفسه، والإجماليات لكل الزمن كما كانت', async () => {
  mode = 'TEAMS';
  const d = await statement(ADMIN, { from: '2026-11-02', to: '2026-11-30' });
  assert.equal(d.teamScoped, true);
  assert.deepEqual(d.teamNames, ['فريق الجنوب', 'فريق الشمال']);
  assert.equal(d.customer.balance, 3000);
});

test('غير المشرف: الردّ كما كان حرفاً — teamScoped=false ولا teamNames ولا استعلام فرق', async () => {
  mode = 'NONE';
  const d = await statement(ADMIN);
  assert.equal(d.teamScoped, false);
  assert.equal('teamNames' in d, false);
  assert.deepEqual(Object.keys(d).sort(), ['closingBalance', 'customer', 'entries', 'openingBalance', 'teamScoped', 'timezone']);
  assert.equal(d.customer.balance, 5000, 'الرصيد الكامل المخزَّن');
  assert.equal(d.closingBalance, 5000);
  assert.equal(calls.some(([op]) => op === 'teamSupervisor.findMany'), false);
});

test('المندوب: لا عنوان فريق ولا أسماء', async () => {
  mode = 'NONE';
  const d = await statement({ id: 'rep-1', role: 'SALES_REP', tenantId: 'T1' });
  assert.equal(d.teamScoped, false);
  assert.equal('teamNames' in d, false);
  assert.equal(d.customer.balance, 5000);
});
