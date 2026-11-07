// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — ردّ GET/PUT /api/company لا يحمل taxModeChangedBy (معرّف من قلب المفتاح، و
// «OWNER:<المعرّف>» لجلسة المالك) لأجهزة المناديب ومفاتيح API — كأخيه returnPolicyChangedBy؛ والعلم taxDisabled وtaxModeChangedAt
// يبقيان (الأجهزة تحتاجهما). المعالجان الحقيقيان فوق Prisma مزيّف في الذاكرة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'tax-off-mask-test';
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const ROW: Row = {
  id: 's1', tenantId: 't1', name: 'شركة النور', taxDisabled: true, taxModeChangedAt: new Date('2026-11-07T09:00:00Z'),
  taxModeChangedBy: 'OWNER:admin-1', returnPolicyChangedBy: 'admin-1', einvoiceClientSecret: 'sec', lotOnInvoice: false,
  currencyOverride: null, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'none', zatcaPhase2StartedAt: null,
};
const empty = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0 };
const db = new Proxy({
  companySettings: {
    findUnique: async () => ({ ...ROW }),
    upsert: async (a: { update: Row }) => ({ ...ROW, ...a.update }),
  },
  tenant: { findUnique: async () => ({ zatcaPhase2Enabled: false }) },
} as Row, { get: (t, k: string) => (k in t ? t[k] : k === 'then' ? undefined : empty) });
stub('config/database', { default: db });
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('غير مستعمل'); } });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require(path.join(SRC, 'routes/company')).default as { stack: Row[] };
const handlerOf = (method: 'get' | 'put') => {
  const layer = router.stack.find((l) => l.route?.path === '/' && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} /`);
  return layer!.route.stack.slice(-1)[0].handle as (req: Row, res: Row, next: (e?: unknown) => void) => Promise<void>;
};
async function call(method: 'get' | 'put', user: Row, body: Row = {}) {
  let status = 200;
  let out: Row | null = null;
  let err: unknown = null;
  const res = { status(c: number) { status = c; return this; }, json(b: Row) { out = b; return this; }, on() { return this; }, locals: {} };
  await handlerOf(method)({ user, headers: {}, body, method: method.toUpperCase() }, res, (e?: unknown) => { err = e ?? null; });
  assert.equal(err, null, String(err));
  return { status, body: out as unknown as Row };
}

test('GET /api/company لمندوب: لا taxModeChangedBy (ولا returnPolicyChangedBy) — وtaxDisabled وtaxModeChangedAt يصلان الجهاز', async () => {
  const r = await call('get', { id: 'rep-1', role: 'SALES_REP', tenantId: 't1' });
  assert.equal(r.status, 200);
  const d = r.body.data as Row;
  assert.ok(!('taxModeChangedBy' in d), 'معرّف من قلب المفتاح لا يصل الجهاز');
  assert.ok(!('returnPolicyChangedBy' in d), 'السابقة نفسها');
  assert.ok(!('einvoiceClientSecret' in d));
  assert.equal(d.taxDisabled, true);
  assert.deepEqual(d.taxModeChangedAt, ROW.taxModeChangedAt);
  assert.doesNotMatch(JSON.stringify(r.body), /OWNER:admin-1/);
});

test('GET /api/company لمدير الشركة ولمفتاح API: الحقل نفسه محجوب', async () => {
  for (const user of [{ id: 'adm-1', role: 'ADMIN', tenantId: 't1' }, { id: 'adm-1', role: 'ADMIN', tenantId: 't1', apiKeyId: 'k1' }]) {
    const r = await call('get', user);
    assert.ok(!('taxModeChangedBy' in r.body.data), JSON.stringify(user));
    assert.equal(r.body.data.taxDisabled, true);
  }
});

test('PUT /api/company: ردّ الحفظ (maskCompany نفسه) بلا taxModeChangedBy', async () => {
  const r = await call('put', { id: 'adm-1', role: 'ADMIN', tenantId: 't1' }, { name: 'شركة النور' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(!('taxModeChangedBy' in r.body.data));
  assert.ok(!('returnPolicyChangedBy' in r.body.data));
  assert.equal(r.body.data.taxDisabled, true);
  assert.equal(r.body.data.einvoiceHasSecret, true);
});

test('حارس نصّي: maskCompany يحجب taxModeChangedBy بجانب returnPolicyChangedBy، والملف بـBOM', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes/company.ts'), 'utf8');
  assert.equal(src.charCodeAt(0), 0xfeff);
  const body = src.slice(src.indexOf('function maskCompany'), src.indexOf('router.get(\'/\''));
  assert.match(body, /returnPolicyChangedBy: _changedBy, taxModeChangedBy: _taxBy, \.\.\.rest/);
  assert.match(body, /void _taxBy;/);
});
