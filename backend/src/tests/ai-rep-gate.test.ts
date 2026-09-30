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
const { repContext, clearGateCache, nextOutletStatus, notFoundConfirmed, outcomeWritesMemory, outcomePlace, REP_OUTCOME_KINDS } = require('../routes/aiRep') as typeof import('../routes/aiRep');

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

test('حالة المحل بعد النتيجة: المحوَّل يبقى محوَّلاً، و«مغلق الآن» لا يُغلق، و«لم أجده» يُغلق حين يتأكّد فقط', () => {
  assert.equal(nextOutletStatus(null, 'INTERESTED'), 'OPEN');
  assert.equal(nextOutletStatus('OPEN', 'CLOSED'), 'OPEN', '«مغلق الآن» لحظيّ');
  assert.equal(nextOutletStatus('OPEN', 'NOT_FOUND'), 'OPEN', 'بلاغ واحد لا يُغلق');
  assert.equal(nextOutletStatus('OPEN', 'NOT_FOUND', true), 'CLOSED');
  assert.equal(nextOutletStatus('CLOSED', 'INTERESTED'), 'OPEN');
  assert.equal(nextOutletStatus('CONVERTED', 'NOT_INTERESTED'), 'CONVERTED');
  assert.equal(nextOutletStatus('CONVERTED', 'NOT_FOUND', true), 'CONVERTED');
  assert.equal(nextOutletStatus('OPEN', 'CONVERTED'), 'CONVERTED');
});

const T0 = new Date('2026-09-20T07:00:00Z'); // ١٠ صباحاً بالرياض
const H = 3600000, D = 86400000;

test('تأكيد «لم أجده»: بلاغان من مندوبين أو في يومين، والمؤكَّد يبقى مؤكَّداً، والقديم والمقطوع بنتيجة أخرى لا يؤكّد', () => {
  const prev = (o: { status?: string; lastOutcome?: string | null; ago?: number; rep?: string }) =>
    ({ status: o.status ?? 'OPEN', lastOutcome: o.lastOutcome === undefined ? 'NOT_FOUND' : o.lastOutcome, lastOutcomeAt: new Date(T0.getTime() - (o.ago ?? H)), lastSalesRepId: o.rep ?? 'r1' });
  assert.equal(notFoundConfirmed(null, 'r1', T0), false, 'لا ذاكرة');
  assert.equal(notFoundConfirmed(prev({}), 'r1', T0), false, 'المندوب نفسه في يومه ⇒ بلاغ واحد');
  assert.equal(notFoundConfirmed(prev({}), 'r2', T0), true, 'مندوب آخر');
  assert.equal(notFoundConfirmed(prev({ ago: D }), 'r1', T0), true, 'المندوب نفسه في يوم آخر');
  assert.equal(notFoundConfirmed(prev({ lastOutcome: 'CLOSED' }), 'r2', T0), false, '«مغلق الآن» قبله لا يؤكّد');
  assert.equal(notFoundConfirmed(prev({ lastOutcome: 'INTERESTED', ago: D }), 'r2', T0), false);
  assert.equal(notFoundConfirmed(prev({ ago: 200 * D }), 'r2', T0), false, 'بلاغ أقدم من ذاكرة الإغلاق');
  assert.equal(notFoundConfirmed(prev({ status: 'CLOSED' }), 'r1', T0), true, 'تكرار البلاغ لا يُنزل المؤكَّد');
});

test('سلامة الذاكرة: الرفع المؤجَّل الأقدم لا يمحو الأحدث، والمحوَّل لا يُمسّ، و«أصبح عميلاً» ليس مما يرسله المندوب', () => {
  assert.equal(outcomeWritesMemory(null, T0), true);
  assert.equal(outcomeWritesMemory({ status: 'OPEN', lastOutcomeAt: null }, T0), true);
  assert.equal(outcomeWritesMemory({ status: 'OPEN', lastOutcomeAt: new Date(T0.getTime() - H) }, T0), true);
  assert.equal(outcomeWritesMemory({ status: 'OPEN', lastOutcomeAt: new Date(T0.getTime() + H) }, T0), false, 'نتيجة زميل أحدث');
  assert.equal(outcomeWritesMemory({ status: 'CONVERTED', lastOutcomeAt: new Date(T0.getTime() - D) }, T0), false);
  assert.ok(!(REP_OUTCOME_KINDS as readonly string[]).includes('CONVERTED'));
  assert.ok((REP_OUTCOME_KINDS as readonly string[]).includes('NOT_FOUND'));
});

test('موقع المحل لـ«عند الباب»: الجلسة ثم man: ثم ما أرسله الجهاز قرب موقع المندوب وحده', () => {
  const gps = { lat: 24.7, lng: 46.7 };
  const sess = { lat: 24.701, lng: 46.701 };
  assert.deepEqual(outcomePlace(sess, 'ChIJx', { lat: 1, lng: 1 }, gps), sess, 'الجلسة أولاً');
  assert.deepEqual(outcomePlace(null, 'man:24.7100,46.7200', null, gps), { lat: 24.71, lng: 46.72 });
  assert.deepEqual(outcomePlace(undefined, 'ChIJx', { lat: 24.702, lng: 46.7 }, gps), { lat: 24.702, lng: 46.7 }, 'رفع مؤجَّل بلا جلسة');
  assert.equal(outcomePlace(undefined, 'ChIJx', { lat: 25.5, lng: 46.7 }, gps), null, 'أبعد من حدّ المعقول ⇒ يُهمَل');
  assert.equal(outcomePlace(undefined, 'ChIJx', { lat: 24.702, lng: 46.7 }, null), null, 'بلا GPS لا يُقبل');
});
