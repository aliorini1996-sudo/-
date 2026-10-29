// «صلاحية الحذف» لمستخدم الشركة (طلب المالك ٢٩ أكتوبر ٢٠٢٦: «في صفحة إضافة مستخدم أضف صلاحية إمكانية الحذف من عدمها»).
//
// الحارس واحدٌ في authenticate على كل طلب DELETE — بالجلسة وبالمفتاح البرمجي (يرثها من صاحبه) — وجلسة المالك تتجاوزه.
// ومنحها لا يكون إلا ممّن يملكها أو مدير الشركة، فلا يعيدها لنفسه مشرفٌ سُحبت منه. Prisma مزيّف: لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-delete-permission';
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');

const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const keys = require('../services/apiKeys') as typeof import('../services/apiKeys');
const fresh = keys.generateApiKey();

let adminRow: Row = { id: 'a1', tenantId: 't1', role: 'MANAGER', name: 'مشرف', isActive: true, lastSeenAt: new Date(), canDelete: false };
const keyRow = (): Row => ({
  id: 'k1', tenantId: 't1', readOnly: false, revokedAt: null, lastUsedAt: new Date(), createdBy: 'a1', keyHash: fresh.hash,
  admin: { id: 'a1', name: 'مشرف', role: 'MANAGER', isActive: true, tenantId: 't1', canDelete: adminRow.canDelete },
  tenant: { apiEnabled: true, isActive: true, subscriptionEndsAt: null },
});
const empty = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0, updateMany: async () => ({ count: 0 }) };
const db = new Proxy({
  apiKey: { async findUnique(a: Row) { const k = keyRow(); return a.where.keyHash === k.keyHash ? k : null; }, async updateMany() { return { count: 1 }; } },
  admin: { async findUnique() { return adminRow; }, async updateMany() { return { count: 0 }; } },
} as Row, { get: (t, k: string) => (k in t ? t[k] : k === 'then' ? undefined : empty) });
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const auth = require('../middleware/auth') as typeof import('../middleware/auth');
const { blocksDeleteGrant } = require('../routes/companyUsers') as typeof import('../routes/companyUsers');
/* eslint-enable @typescript-eslint/no-var-requires */

async function call(method: string, authorization: string) {
  const req: Row = { method, originalUrl: '/api/customers/c1', url: '/api/customers/c1', baseUrl: '/api/customers', path: '/c1', headers: { authorization }, query: {}, params: {}, body: {} };
  const res = {
    statusCode: 200, body: null as Row | null,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Row; return this; },
    setHeader() { /* حدود المفتاح */ },
  };
  let passed = false;
  await auth.authenticate(req as never, res as never, (e?: unknown) => { if (e) throw e; passed = true; });
  return { passed, status: res.statusCode, code: res.body?.code as string | undefined };
}
const session = () => `Bearer ${jwt.sign({ id: 'a1', role: 'MANAGER', name: 'مشرف', tenantId: 't1' }, SECRET, { expiresIn: '1h' })}`;
const apiKey = () => `Bearer ${fresh.key}`;

test('المسحوبة منه: كل DELETE مرفوض بالجلسة وبالمفتاح، وغير الحذف يمرّ', async () => {
  adminRow = { ...adminRow, canDelete: false };
  for (const authz of [session(), apiKey()]) {
    const del = await call('DELETE', authz);
    assert.equal(del.passed, false);
    assert.equal(del.status, 403);
    assert.equal(del.code, 'DELETE_NOT_ALLOWED');
    for (const m of ['GET', 'POST', 'PUT', 'PATCH']) assert.equal((await call(m, authz)).passed, true, m);
  }
});

test('الممنوحة له أو صفٌّ قديم بلا عمود: الحذف يمرّ', async () => {
  for (const canDelete of [true, undefined, null]) {
    adminRow = { ...adminRow, canDelete };
    assert.equal((await call('DELETE', session())).passed, true, String(canDelete));
    assert.equal((await call('DELETE', apiKey())).passed, true, String(canDelete));
  }
});

test('deleteRefused: جلسة المالك تتجاوزها، والحالة لا تهمّ في الطريقة', () => {
  assert.equal(auth.deleteRefused('delete', false), true);
  assert.equal(auth.deleteRefused('DELETE', false, true), false);
  assert.equal(auth.deleteRefused('POST', false), false);
  assert.equal(auth.deleteRefused(undefined, false), false);
});

test('منح الحذف: مدير الشركة أو من يملكها وحدهما — والسحب والإبقاء متاحان', () => {
  const manager = { role: 'MANAGER', canDelete: false };
  // مشرفٌ بلا حذف لا يمنحه لنفسه ولا لغيره، ولا يُنشئ مستخدماً به
  assert.equal(blocksDeleteGrant(manager, true, false), true);
  assert.equal(blocksDeleteGrant(manager, true, undefined), true);
  // لكنه يسحبه ويُبقي ما هو قائم
  assert.equal(blocksDeleteGrant(manager, false, true), false);
  assert.equal(blocksDeleteGrant(manager, true, true), false);
  assert.equal(blocksDeleteGrant(manager, undefined, false), false);
  // مدير الشركة ومن يملك الحذف يمنحانه
  assert.equal(blocksDeleteGrant({ role: 'ADMIN', canDelete: false }, true, false), false);
  assert.equal(blocksDeleteGrant({ role: 'ACCOUNTANT', canDelete: true }, true, false), false);
});
