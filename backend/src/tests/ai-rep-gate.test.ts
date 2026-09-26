// المندوب الذكي — حارس المندوب: العلم مطفأ، الاشتراك معطّل، المندوب خارج النطاق أو معطّل ⇒ لا وصول.
// فوق Prisma مزيّف في الذاكرة، بلا قاعدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

let tenantRow: Record<string, unknown> | null = { isActive: true, aiRepEnabled: true, accountingEnabled: true };
let repRow: { isActive: boolean } | null = { isActive: true };
let settingsRow: Record<string, unknown> | null = null;
stub('config/database', {
  default: {
    tenant: { findUnique: async () => tenantRow },
    companySettings: { findUnique: async () => ({ countryCode: 'SA' }) },
    salesRep: { findFirst: async () => repRow },
    aiRepSettings: { findUnique: async () => settingsRow },
  },
});
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
stub('middleware/auth', {
  authenticate: pass, requireAdmin: pass, requireSalesRep: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
});
stub('services/customerScope', { customerScope: async () => ({}), isolationEnabled: async () => false });
stub('services/adminScope', { adminScopeEnabled: async () => false });
stub('ai-rep/estimateData', { loadEstimateData: async () => ({}), invalidateEstimateData: () => undefined });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { repContext, clearGateCache, nextOutletStatus } = require('../routes/aiRep') as typeof import('../routes/aiRep');

const req = (id: string) => ({ user: { role: 'SALES_REP', id, tenantId: 't1' } }) as never;
const fresh = () => clearGateCache('t1');

test('مفعّل للشركة والمندوب نشط والنطاق «الكل» ⇒ سياق، والمال ظاهر', async () => {
  fresh(); tenantRow = { isActive: true, aiRepEnabled: true, accountingEnabled: true }; repRow = { isActive: true }; settingsRow = null;
  const ctx = await repContext(req('r1'));
  assert.ok(ctx);
  assert.equal(ctx!.showMoney, true);
  assert.deepEqual(ctx!.settings.targetOutletTypes, ['GROCERY', 'MINIMARKET', 'SUPERMARKET']);
});

test('العلم مطفأ ⇒ لا وصول (مطفأ افتراضياً: غير true يمنع)', async () => {
  fresh(); tenantRow = { isActive: true, aiRepEnabled: false, accountingEnabled: true };
  assert.equal(await repContext(req('r1')), null);
  fresh(); tenantRow = null;
  assert.equal(await repContext(req('r1')), null, 'تعذّر قراءة الشركة يمنع');
});

test('اشتراك الشركة معطّل ⇒ لا وصول', async () => {
  fresh(); tenantRow = { isActive: false, aiRepEnabled: true, accountingEnabled: true };
  assert.equal(await repContext(req('r1')), null);
});

test('مندوب معطّل أو خارج «مناديب محدّدون» ⇒ لا وصول', async () => {
  fresh(); tenantRow = { isActive: true, aiRepEnabled: true, accountingEnabled: true }; repRow = { isActive: false }; settingsRow = null;
  assert.equal(await repContext(req('r1')), null);
  fresh(); repRow = { isActive: true }; settingsRow = { repScope: 'SELECTED', repIds: ['r2'] };
  assert.equal(await repContext(req('r1')), null);
  fresh();
  assert.ok(await repContext(req('r2')));
});

test('النظام المحاسبي مطفأ ⇒ لا مال ولو فعّلت الشركة عرضه', async () => {
  fresh(); tenantRow = { isActive: true, aiRepEnabled: true, accountingEnabled: false }; repRow = { isActive: true }; settingsRow = { showMoney: true };
  const ctx = await repContext(req('r1'));
  assert.equal(ctx!.showMoney, false);
});

test('حالة المحل بعد النتيجة: المحوَّل يبقى محوَّلاً', () => {
  assert.equal(nextOutletStatus(null, 'INTERESTED'), 'OPEN');
  assert.equal(nextOutletStatus('OPEN', 'CLOSED'), 'CLOSED');
  assert.equal(nextOutletStatus('CLOSED', 'INTERESTED'), 'OPEN');
  assert.equal(nextOutletStatus('CONVERTED', 'NOT_INTERESTED'), 'CONVERTED');
  assert.equal(nextOutletStatus('OPEN', 'CONVERTED'), 'CONVERTED');
});
