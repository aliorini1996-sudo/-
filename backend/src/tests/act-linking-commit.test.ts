// «ربط الدفاتر» — POST /linking/commit (L7/L9 مبسّطة) عبر سلسلة الموجّه الحقيقية (requireLedgerPermission ثم requireCompanyOwner ثم
// ledgerHandler) فوق Prisma مزيّف في الذاكرة. معالج الاعتماد (setup.ts runSetupCommitRoute) مزيّف هنا — شروطه وعكسه مختبرة في
// act-activate؛ والمسار اليدوي POST /setup/commit بلا خطّافات (res.locals فارغة) فلا يتغيّر.
//   ١) الحرّاس: غير المالك ⇒ 403 OWNER_ONLY، مفتاح API ⇒ 403 INTERACTIVE_ONLY، بلا canConfigureLedger ⇒ 403 — ولا معاملة.
//   ٢) بلا إقرار «نهائي» ⇒ 422 LINKING_ACK_REQUIRED، وبلا اسم ⇒ 422 LINKING_NAME_MISMATCH — ولا معاملة.
//   ٣) المالك بإقرار واسم ⇒ معالج الاعتماد بخطّافات الربط في res.locals (الاسم المكتوب، FY_RESTATED) وجسمٍ بالإقرار النظامي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Router } from 'express';
import { ZodError } from 'zod';
import { createFakeLinkingDb, type Row } from './p5-linking-jobs-fake';
import type { LinkingCommitHooks } from '../services/gl/linking/activate';

delete process.env.DATABASE_URL;

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const f = createFakeLinkingDb();
stub('config/database', { default: f.db });

const commits: { body: Record<string, unknown>; linking: LinkingCommitHooks | null }[] = [];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realSetup = require('../routes/ledger/setup');
stub('routes/ledger/setup', {
  ...realSetup,
  runSetupCommitRoute: async (req: { body: Record<string, unknown> }, res: { locals: Record<string, unknown>; status(c: number): { json(p: unknown): void } }) => {
    commits.push({ body: req.body, linking: (res.locals[realSetup.LINKING_COMMIT_LOCAL] as LinkingCommitHooks | undefined) ?? null });
    res.status(201).json({ success: true, data: { linking: { linkedFrom: '2026-01-01', converted: false, restated: [] } } });
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const linkingRouter = require('../routes/ledger/linking').default as Router;

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handle }[] } }

function handlers(): Handle[] {
  for (const layer of (linkingRouter as unknown as { stack: RouteLayer[] }).stack) {
    const r = layer.route;
    if (r && r.path === '/linking/commit' && r.methods.post === true) return r.stack.map((s) => s.handle);
  }
  throw new Error('POST /linking/commit غير مسجَّلة');
}

interface MockRes { statusCode: number; body: Record<string, unknown> | null; locals: Record<string, unknown>; onSend: (() => void) | null; status(c: number): MockRes; json(p: unknown): MockRes; setHeader(): void }

async function call(user: Row, body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res: MockRes = {
    statusCode: 200, body: null, onSend: null, locals: { ledger: { tenantId: 't-1', actorId: String(user.id), impersonated: false } },
    status(c) { this.statusCode = c; return this; }, json(p) { this.body = p as Record<string, unknown>; this.onSend?.(); return this; }, setHeader() { /* لا شيء */ },
  };
  const req = { params: {}, query: {}, body, headers: {}, ip: '127.0.0.1', user };
  for (const h of handlers()) {
    const outcome = await new Promise<'next' | 'sent'>((resolve, reject) => {
      res.onSend = () => resolve('sent');
      Promise.resolve().then(() => h(req, res, (err?: unknown) => (err ? reject(err) : resolve('next')))).catch(reject);
    });
    if (outcome === 'sent') break;
  }
  return { status: res.statusCode, body: res.body };
}

function adminRow(id: string, over: Row = {}): Row {
  return {
    id, isActive: true, tenantId: 't-1', role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: false,
    canViewLedger: false, canPostJournals: false, canManagePayables: false, canManageBank: false, canCloseLedgerPeriods: false, canConfigureLedger: false,
    ...over,
  };
}

function seed(): void {
  f.reset();
  commits.length = 0;
  f.tenants.set('t-1', { id: 't-1', accountingSuiteEnabled: true, accountingEnabled: true, warehouseEnabled: false });
  f.admins.set('owner-1', adminRow('owner-1'));
  f.admins.set('acct-1', adminRow('acct-1', { role: 'ACCOUNTANT', canManageCompanyUsers: false, canConfigureLedger: true }));
  f.admins.set('admin-noowner', adminRow('admin-noowner', { canManageCompanyUsers: false, canConfigureLedger: true }));
  f.admins.set('viewer', adminRow('viewer', { role: 'ACCOUNTANT', canManageCompanyUsers: false, canViewLedger: true }));
}

const user = (id: string, over: Row = {}): Row => ({ id, role: (f.admins.get(id)?.role as string) ?? 'ADMIN', tenantId: 't-1', name: 'مستخدم', impersonated: false, ...over });
const GOOD = { companyName: 'شركة النور', acknowledgeFinal: true };

test('الحرّاس: غير المالك ⇒ 403 OWNER_ONLY، ومفتاح API ⇒ 403 INTERACTIVE_ONLY، وبلا canConfigureLedger ⇒ 403 — بلا معاملة', async () => {
  for (const id of ['acct-1', 'admin-noowner']) {
    seed();
    const out = await call(user(id), GOOD);
    assert.equal(out.status, 403, id);
    assert.equal(out.body?.code, 'LEDGER_LINKING_OWNER_ONLY');
    assert.equal(commits.length, 0);
  }
  seed();
  const api = await call(user('owner-1', { apiKeyId: 'k1' }), GOOD);
  assert.equal(api.status, 403);
  assert.equal(commits.length, 0);
  seed();
  const viewer = await call(user('viewer'), GOOD);
  assert.equal(viewer.status, 403);
  assert.equal(commits.length, 0);
});

test('بلا إقرار «نهائي» ⇒ 422 LINKING_ACK_REQUIRED، وبلا اسم ⇒ 422 LINKING_NAME_MISMATCH، وحقل مجهول ⇒ ZodError (400) — ولا معاملة', async () => {
  for (const body of [{ companyName: 'شركة النور' }, { companyName: 'شركة النور', acknowledgeFinal: false }, { companyName: 'شركة النور', acknowledgeFinal: 'yes' }]) {
    seed();
    const out = await call(user('owner-1'), body);
    assert.equal(out.status, 422);
    assert.equal(out.body?.code, 'LINKING_ACK_REQUIRED');
    assert.equal(out.body?.field, 'acknowledgeFinal');
  }
  for (const body of [{ acknowledgeFinal: true }, { acknowledgeFinal: true, companyName: '   ' }]) {
    seed();
    const out = await call(user('owner-1'), body);
    assert.equal(out.status, 422);
    assert.equal(out.body?.code, 'LINKING_NAME_MISMATCH');
  }
  // حقل مجهول (strict) ⇒ ZodError إلى معالج الأخطاء العام (400)
  seed();
  await assert.rejects(call(user('owner-1'), { ...GOOD, unlink: true }), (e: unknown) => e instanceof ZodError);
  assert.equal(commits.length, 0);
});

test('المالك بإقرار واسم ⇒ 201 ومعاملة الاعتماد بخطّافات الربط (الاسم المكتوب، FY_RESTATED) والإقرار النظامي ضمناً', async () => {
  seed();
  const out = await call(user('owner-1'), { ...GOOD, acknowledgePostCutoverImports: true });
  assert.equal(out.status, 201);
  assert.equal(out.body?.success, true);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].body, { acknowledgeStatutory: true, acknowledgePostCutoverImports: true });
  seed();
  await call(user('owner-1'), { ...GOOD, acknowledgeOpeningStockExcluded: true });
  assert.deepEqual(commits[0].body, { acknowledgeStatutory: true, acknowledgeOpeningStockExcluded: true });
  assert.equal(commits[0].linking?.typedCompanyName, 'شركة النور');
  assert.equal(commits[0].linking?.basis, 'FY_RESTATED');
  // جلسة مالك المنصّة تمرّ (OD18 كما في المعاينة)
  seed();
  const owner = await call(user('owner-1', { impersonated: true, ownerSession: true, role: 'ADMIN' }), GOOD);
  assert.equal(owner.status, 201);
  assert.deepEqual(commits[0].body, { acknowledgeStatutory: true });
});

test('ثابت: الخطّافات من res.locals وحدها (المسار اليدوي بلا خطّافات كما كان)، وsetup.ts لا يستورد وحدات الربط إلا أنواعاً', () => {
  const s = fs.readFileSync(path.join(SRC, 'routes', 'ledger', 'setup.ts'), 'utf8');
  assert.match(s, /router\.post\('\/setup\/commit', CONFIGURE, ledgerHandler\(setupCommitImpl = async \(req, res\) => \{\r?\n {2}const \{ tenantId, actorId \} = ledgerOf\(res\);\r?\n {2}const linking = linkingOf\(res\);/);
  // الخطّافات لا تأتي إلا من res.locals (يضعها POST /linking/commit) — لا من الجسم ولا الاستعلام
  assert.match(s, /const linkingOf = \(res: Response\): LinkingCommitHooks \| null => \(res\.locals\[LINKING_COMMIT_LOCAL\]/);
  assert.equal(realSetup.LINKING_COMMIT_LOCAL, 'linkingCommit');
  for (const m of s.matchAll(/^\s*import(\s+type)?\s[^;']*?from '([^']+linking[^']*)'/gm)) assert.ok(m[1], `استيراد قيمي: ${m[2]}`);
  // الفرع المربوط مشروط بالخطّافات: لا LINKED حرفية في المقارنة (حارس b1-books-mode)
  assert.doesNotMatch(s, /[!=]==?\s*'(CLEAN|LINKED)'|'(CLEAN|LINKED)'\s*[!=]==?/);
});

test('GET /company — حالة البطاقة booksLinking: غير مفعّلة/يدوية/جارٍ البناء/مربوطة منذ …/قديمة', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { booksLinkingStatus } = require('../routes/company') as typeof import('../routes/company');
  const ACT = new Date('2026-10-01T08:00:00.000Z');
  assert.deepEqual(booksLinkingStatus(null), { state: 'NONE', backfillState: null, linkedFrom: null, linkedAt: null });
  // صفّ مسودة يدويّ بلا تفعيل ⇒ غير مفعّلة بعد
  assert.equal(booksLinkingStatus({ setupMethod: 'CLEAN', activatedAt: null }).state, 'NONE');
  assert.equal(booksLinkingStatus({ setupMethod: 'CLEAN', activatedAt: ACT, backfillState: 'DONE' }).state, 'MANUAL');
  assert.equal(booksLinkingStatus({ setupMethod: 'LINKED', activatedAt: ACT, backfillState: 'RUNNING' }).state, 'BUILDING');
  assert.equal(booksLinkingStatus({ setupMethod: 'LINKED', activatedAt: ACT, backfillState: 'PAUSED' }).state, 'BUILDING');
  assert.deepEqual(
    booksLinkingStatus({ setupMethod: 'LINKED', activatedAt: ACT, backfillState: 'DONE', linkedFrom: new Date('2026-01-01T00:00:00.000Z'), linkedAt: new Date('2026-11-14T08:00:00.000Z') }),
    { state: 'LINKED', backfillState: 'DONE', linkedFrom: '2026-01-01', linkedAt: '2026-11-14T08:00:00.000Z' },
  );
  assert.equal(booksLinkingStatus({ setupMethod: 'OPENING', activatedAt: ACT, backfillState: 'DONE' }).state, 'LEGACY');
});
