// «الربط البرمجي API» × الميزات الحديثة (طلب المالك ٢٦ أكتوبر ٢٠٢٦: «تأكد أن API تعمل بشكل جيد لجميع المميزات»).
//
// المفتاح لا مسارات له: authenticate يحوّله إلى هوية مُصدِره {id, role, name, tenantId, apiKeyId} ثم تسري عليه حرّاس اللوحة
// نفسها. فالخطر أن يقرأ حارسٌ جديد شيئاً لا تحمله تلك الهوية (حقل جلسة، أو صلاحية من التوكن، أو impersonated) فيُحجب المفتاح
// بصمت عن ميزةٍ يَعِد بها المستند. هنا: Prisma مزيّف في ذاكرة الوحدات، والمصادقة **الحقيقية** تحوّل المفتاح إلى هوية، ثم تُشغَّل
// وسائط كل موجّه وحرّاس كل مسارٍ جديد بالترتيب حتى المعالج (لا المعالج نفسه: منطقه مختبرٌ في اختبار ميزته) — لوكيشن،
// طرق الدفع وإدارتها، إعدادات الطباعة ونصوص المطبوعات، المرتجع من الويب، تعديل البصمات، الفرق، فكّ جهاز البصمة. والأعلام المطفأة والصلاحيات
// المسحوبة و«قراءة فقط» تمنع المفتاح برموزها نفسها كما تمنع الجلسة. و«تتبّع اللوط» (/api/lots، المواصفة §٥.٢ «وصول المفتاح»):
// المفتاح هوية مستخدم شركة فيمرّ بحرّاس الموجّه كلها، و«قراءة فقط» لا يتجاوز GET، والعَلَم المطفأ LOTS_NOT_ALLOWED. لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-api-key-guards';
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// —— قاعدة مزيّفة: صفّ المفتاح، ومُصدِره بكل صلاحياته، وأعلام الشركة — تُعدَّل لكل حالة ——
const PERMS = [
  'canAccessDashboard', 'canManageCustomers', 'canManageProducts', 'canManageSalesReps', 'canManageInvoices', 'canManageReceipts',
  'canViewReports', 'canManageVanStock', 'canManageTracking', 'canManageCompanySettings', 'canManageCompanyUsers', 'canManageDailyReport',
];
const fullAdmin = (): Row => ({
  id: 'a1', tenantId: 't1', role: 'ADMIN', name: 'مدير', isActive: true, lastSeenAt: new Date(), scopeEnabled: false, scopeMode: 'LISTS',
  ...Object.fromEntries(PERMS.map((p) => [p, true])),
});
const allFlags = (): Row => ({
  accountingEnabled: true, locationsEnabled: true, paymentMethodsEnabled: true, attendanceEnabled: true, warehouseEnabled: true,
  lotTrackingEnabled: true,
});
let adminRow: Row = fullAdmin();
let tenantRow: Row = allFlags();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const keys = require('../services/apiKeys') as typeof import('../services/apiKeys');
const fresh = keys.generateApiKey();
const keyRowOf = (readOnly: boolean) => ({
  id: 'k1', tenantId: 't1', readOnly, revokedAt: null, lastUsedAt: new Date(), createdBy: 'a1', keyHash: fresh.hash,
  admin: { id: 'a1', name: 'مدير', role: 'ADMIN', isActive: true, tenantId: 't1' },
  tenant: { apiEnabled: true, isActive: true, subscriptionEndsAt: null },
});
let keyRow: Row = keyRowOf(false);

/** كل نموذج آخر: لا صفّ — الحرّاس لا تقرؤه، وقراءةٌ منه في حارسٍ جديد تظهر هنا رفضاً لا مروراً صامتاً */
const empty = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0, updateMany: async () => ({ count: 0 }) };
const db = new Proxy({
  apiKey: { async findUnique(a: Row) { return a.where.keyHash === keyRow.keyHash ? keyRow : null; }, async updateMany() { return { count: 1 }; } },
  admin: { async findUnique() { return adminRow; }, async updateMany() { return { count: 0 }; } },
  tenant: { async findUnique() { return tenantRow; } },
} as Row, { get: (t, k: string) => (k in t ? t[k] : k === 'then' ? undefined : empty) });
stub('config/database', { default: db });
// اعتماديات فرع المرحلة الثانية لا تُبنى عند التحميل — ولا يبلغها هذا الاختبار (لا يُشغَّل معالج)
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('لا يُستدعى في اختبار الحرّاس'); } });

/* eslint-disable @typescript-eslint/no-var-requires */
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
const R = {
  locations: require('../routes/locations').default,
  reports: require('../routes/reports').default,
  paymentMethods: require('../routes/paymentMethodsConfig').default,
  printSettings: require('../routes/printSettings').default,
  printTexts: require('../routes/printTexts').default,
  teams: require('../routes/teams').default,
  attendance: require('../routes/attendanceAdmin').default,
  invoices: require('../routes/invoices').default,
  vanStock: require('../routes/vanStock').default,
  salesReps: require('../routes/salesReps').default,
  receipts: require('../routes/receipts').default,
  warehouse: require('../routes/warehouse').default,
  lots: require('../routes/lots').default,
};
/* eslint-enable @typescript-eslint/no-var-requires */

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] }; handle: Handler & { stack?: unknown }; match(p: string): boolean }
type Handler = (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown;

/**
 * سلسلة المسار كما يمشيها Express: وسائط الموجّه (router.use) المطابقة قبله، ثم حرّاس المسار بلا معالجه الأخير.
 * والموجّهات المركّبة تحت /api/company (الفرق والطباعة وطرق الدفع) تسبقها مصادقة موجّه الشركة.
 */
function chainOf(router: unknown, method: string, routePath: string, parentAuth: boolean): Handler[] {
  const stack = (router as { stack: Layer[] }).stack;
  const idx = stack.findIndex((l) => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(idx >= 0, `${method.toUpperCase()} ${routePath} غير موجود في الموجّه`);
  const concrete = routePath.replace(/:(\w+)/g, 'x1');
  const pre = stack.slice(0, idx)
    .filter((l) => !l.route && !l.handle.stack && l.handle.length < 4 && l.match(concrete))
    .map((l) => l.handle);
  const guards = stack[idx].route!.stack.map((l) => l.handle).slice(0, -1);
  return [...(parentAuth ? [authenticate as unknown as Handler] : []), ...pre, ...guards];
}

function mockRes() {
  const res = {
    statusCode: 200, body: null as Row | null, headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Row; return this; },
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
  };
  return res;
}

interface Case { router: keyof typeof R; method: string; path: string; url: string; parentAuth?: boolean }
/** المسار مختصراً في رسائل الفشل */
const label = (c: Case) => `${c.method.toUpperCase()} ${c.url}`;

async function runCase(c: Case, opts: { handler?: boolean } = {}) {
  const chain = chainOf(R[c.router], c.method, c.path, !!c.parentAuth);
  if (opts.handler) {
    const stack = (R[c.router] as unknown as { stack: Layer[] }).stack;
    chain.push(stack.find((l) => l.route?.path === c.path && l.route.methods[c.method])!.route!.stack.slice(-1)[0].handle);
  }
  const req: Row = {
    method: c.method.toUpperCase(), originalUrl: c.url, url: c.url,
    headers: { authorization: `Bearer ${fresh.key}` }, query: {}, params: {}, body: {},
  };
  const res = mockRes();
  for (const h of chain) {
    let passed = false;
    let err: unknown = null;
    await h(req, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) throw err;
    if (!passed) return { passed: false, req, status: res.statusCode, code: res.body?.code as string | undefined };
  }
  return { passed: true, req, status: res.statusCode, code: undefined };
}

const C = (router: Case['router'], method: string, p: string, url: string, parentAuth = false): Case => ({ router, method, path: p, url, parentAuth });
const LOCATIONS: Case[] = [
  C('locations', 'get', '/', '/api/locations'),
  C('locations', 'get', '/summary', '/api/locations/summary'),
  C('locations', 'get', '/reps', '/api/locations/reps'),
  C('locations', 'put', '/reps/:salesRepId', '/api/locations/reps/r1'),
  C('locations', 'post', '/', '/api/locations'),
  C('locations', 'put', '/:id', '/api/locations/l1'),
  C('locations', 'delete', '/:id', '/api/locations/l1'),
];
const PAYMENT_METHODS: Case[] = [
  C('reports', 'get', '/payment-methods', '/api/reports/payment-methods'),
  C('reports', 'get', '/collections', '/api/reports/collections'),
  C('paymentMethods', 'get', '/', '/api/company/payment-methods', true),
  C('paymentMethods', 'put', '/', '/api/company/payment-methods', true),
  C('receipts', 'post', '/', '/api/receipts'),
];
const OTHERS: Case[] = [
  C('printSettings', 'get', '/', '/api/company/print-settings', true),
  C('printSettings', 'put', '/', '/api/company/print-settings', true),
  C('invoices', 'get', '/', '/api/invoices'),
  C('invoices', 'get', '/returnable-sales', '/api/invoices/returnable-sales'),
  C('invoices', 'get', '/:id/returnable', '/api/invoices/i1/returnable'),
  C('invoices', 'post', '/', '/api/invoices'),
  C('vanStock', 'get', '/loads', '/api/van-stock/loads'),
  C('vanStock', 'post', '/loads', '/api/van-stock/loads'),
  C('warehouse', 'get', '/vans', '/api/warehouse/vans'),
  C('reports', 'get', '/returns', '/api/reports/returns'),
  C('reports', 'get', '/rep-ranking', '/api/reports/rep-ranking'),
  C('salesReps', 'get', '/', '/api/sales-reps'),
  C('salesReps', 'put', '/:id', '/api/sales-reps/r1'),
  C('salesReps', 'post', '/:id/unbind-device', '/api/sales-reps/r1/unbind-device'),
  C('attendance', 'get', '/rows', '/api/attendance-admin/rows'),
  C('attendance', 'post', '/rows', '/api/attendance-admin/rows'),
  C('attendance', 'put', '/rows/:id', '/api/attendance-admin/rows/x1'),
  C('attendance', 'delete', '/rows/:id', '/api/attendance-admin/rows/x1'),
  C('attendance', 'get', '/presence', '/api/attendance-admin/presence'),
  C('attendance', 'get', '/reps', '/api/attendance-admin/reps'),
  C('attendance', 'post', '/import', '/api/attendance-admin/import'),
  C('teams', 'get', '/settings', '/api/company/teams/settings', true),
  C('teams', 'patch', '/settings', '/api/company/teams/settings', true),
  C('teams', 'get', '/', '/api/company/teams', true),
  C('teams', 'post', '/', '/api/company/teams', true),
  C('teams', 'put', '/:id', '/api/company/teams/t9', true),
  C('teams', 'delete', '/:id', '/api/company/teams/t9', true),
  C('teams', 'put', '/:id/members', '/api/company/teams/t9/members', true),
  C('teams', 'put', '/:id/products', '/api/company/teams/t9/products', true),
  // «نصوص المطبوعات»: القراءة لكل مسجّل والحفظ بصلاحية إعدادات الشركة — بلا عَلَم
  C('printTexts', 'get', '/', '/api/company/print-texts', true),
  C('printTexts', 'put', '/', '/api/company/print-texts', true),
];
// «تتبّع اللوط»: كل مسارات الموجّه — الثابتة قبل /:id (المواصفة §٥.١)
const LOTS: Case[] = [
  C('lots', 'get', '/', '/api/lots'),
  C('lots', 'get', '/balances', '/api/lots/balances'),
  C('lots', 'get', '/fefo', '/api/lots/fefo'),
  C('lots', 'get', '/health', '/api/lots/health'),
  C('lots', 'post', '/', '/api/lots'),
  C('lots', 'post', '/relabel', '/api/lots/relabel'),
  C('lots', 'post', '/products/tracking', '/api/lots/products/tracking'),
  C('lots', 'put', '/settings', '/api/lots/settings'),
  C('lots', 'get', '/:id', '/api/lots/l1'),
  C('lots', 'patch', '/:id', '/api/lots/l1'),
  C('lots', 'patch', '/:id/status', '/api/lots/l1/status'),
  C('lots', 'delete', '/:id', '/api/lots/l1'),
  C('lots', 'get', '/:id/trace', '/api/lots/l1/trace'),
  C('lots', 'get', '/:id/unload-plan', '/api/lots/l1/unload-plan'),
  C('lots', 'get', '/:id/events', '/api/lots/l1/events'),
];
const ALL = [...LOCATIONS, ...PAYMENT_METHODS, ...OTHERS, ...LOTS];

function reset(): void {
  keys._resetApiKeyWindows();
  adminRow = fullAdmin();
  tenantRow = allFlags();
  keyRow = keyRowOf(false);
}

test('مفتاحٌ كامل من مدير الشركة يمرّ بحرّاس كل مسار جديد حتى معالجه — بهوية مُصدِره بلا انتحال', async () => {
  reset();
  for (const c of ALL) {
    const r = await runCase(c);
    assert.equal(r.passed, true, `${label(c)} ⇒ ${r.status} ${r.code ?? ''}`);
    assert.deepEqual(r.req.user, { id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: 't1', apiKeyId: 'k1' }, label(c));
  }
});

test('المفتاح «قراءة فقط»: القراءات تمرّ، وكل كتابة في المسارات الجديدة 403 API_KEY_FORBIDDEN قبل أي موجّه', async () => {
  reset();
  keyRow = keyRowOf(true);
  for (const c of ALL) {
    const r = await runCase(c);
    if (c.method === 'get') assert.equal(r.passed, true, label(c));
    else assert.deepEqual([r.passed, r.status, r.code], [false, 403, 'API_KEY_FORBIDDEN'], label(c));
  }
});

test('الأعلام المطفأة تمنع المفتاح برموز الجلسة نفسها: المحاسبة أولاً، ثم لوكيشن وطرق الدفع والبصمات — وما لا عَلَم له يبقى مفتوحاً', async () => {
  reset();
  tenantRow = { ...allFlags(), locationsEnabled: false, paymentMethodsEnabled: false, attendanceEnabled: false };
  for (const c of LOCATIONS) assert.equal((await runCase(c)).code, 'LOCATIONS_NOT_ALLOWED', label(c));
  const [report, collections, pmGet, pmPut, receipt] = PAYMENT_METHODS;
  assert.equal((await runCase(report)).code, 'PAYMENT_METHODS_NOT_ALLOWED');
  assert.equal((await runCase(pmPut)).code, 'PAYMENT_METHODS_NOT_ALLOWED', 'تعديل الطرق يعيش في الصفحة المدفوعة');
  // قراءة الطرق (مصدر أسماء paymentMethodKey) والسند بمفتاح الطريقة وتقرير التحصيل بلا عَلَم
  for (const c of [collections, pmGet, receipt]) assert.equal((await runCase(c)).passed, true, label(c));
  for (const c of OTHERS.filter((x) => x.router === 'attendance')) assert.equal((await runCase(c)).code, 'ATTENDANCE_DISABLED', label(c));
  // فلتر الموقع في الفواتير والتحميلات، والمرتجع، والطباعة، والفرق: بلا عَلَم
  for (const c of OTHERS.filter((x) => x.router !== 'attendance')) assert.equal((await runCase(c)).passed, true, label(c));

  tenantRow = { ...allFlags(), accountingEnabled: false };
  for (const c of [...LOCATIONS, report, pmPut]) assert.equal((await runCase(c)).code, 'ACCOUNTING_NOT_ALLOWED', `${label(c)}: المحاسبة قبل العَلَم`);
});

test('«تتبّع اللوط»: العَلَم المطفأ يمنع المفتاح بـLOTS_NOT_ALLOWED في كل مسار، والمحاسبة المطفأة قبله — كالجلسة', async () => {
  reset();
  tenantRow = { ...allFlags(), lotTrackingEnabled: false };
  for (const c of LOTS) {
    const r = await runCase(c);
    assert.deepEqual([r.passed, r.status, r.code], [false, 403, 'LOTS_NOT_ALLOWED'], label(c));
  }
  // غياب العَلَم (صفٌّ قبل db push، أو تعذّر القراءة) يمنع لا يفتح — الشرط !== true
  tenantRow = { accountingEnabled: true };
  for (const c of LOTS) assert.equal((await runCase(c)).code, 'LOTS_NOT_ALLOWED', label(c));
  tenantRow = { ...allFlags(), accountingEnabled: false };
  for (const c of LOTS) assert.equal((await runCase(c)).code, 'ACCOUNTING_NOT_ALLOWED', `${label(c)}: المحاسبة قبل العَلَم`);
  // والعَلَم المفعّل لا يمسّ بقية المسارات
  reset();
  for (const c of OTHERS.filter((x) => x.router !== 'attendance')) assert.equal((await runCase(c)).passed, true, label(c));
});

test('الصلاحية المسحوبة من مُصدِر المفتاح تسري على مفتاحه في الحال (تُقرأ من القاعدة لا من المفتاح)', async () => {
  reset();
  const denied = async (perm: string, c: Case) => {
    adminRow = { ...fullAdmin(), [perm]: false };
    const r = await runCase(c);
    assert.deepEqual([r.passed, r.status], [false, 403], `${label(c)} بلا ${perm}`);
  };
  await denied('canViewReports', LOCATIONS[1]); // الملخّص
  await denied('canManageSalesReps', LOCATIONS[3]); // الإسناد
  await denied('canManageCompanySettings', LOCATIONS[4]); // تعريف موقع
  await denied('canViewReports', PAYMENT_METHODS[0]);
  await denied('canManageCompanySettings', PAYMENT_METHODS[3]);
  await denied('canManageReceipts', PAYMENT_METHODS[4]);
  await denied('canManageCompanySettings', OTHERS[1]); // حفظ إعدادات الطباعة
  await denied('canManageCompanySettings', OTHERS.find((x) => x.router === 'printTexts' && x.method === 'put')!); // حفظ نصوص المطبوعات
  await denied('canManageInvoices', OTHERS[3]); // المرتجع من الويب
  await denied('canManageTracking', OTHERS.find((c) => c.router === 'attendance')!);
  // «تتبّع اللوط»: إدارة مخزون السيارات لكل الموجّه، والمنتجات للتفعيل الجماعي، والإعدادات لطباعة التشغيلة
  for (const c of LOTS) await denied('canManageVanStock', c);
  await denied('canManageProducts', LOTS.find((c) => c.path === '/products/tracking')!);
  await denied('canManageCompanySettings', LOTS.find((c) => c.path === '/settings')!);
  // وصاحبٌ عُطّل حسابه: المفتاح كلّه 401 قبل أي مسار
  reset();
  keyRow = { ...keyRowOf(false), admin: { ...keyRowOf(false).admin, isActive: false } };
  const r = await runCase(LOCATIONS[0]);
  assert.deepEqual([r.status, r.code], [401, 'API_KEY_OWNER_INACTIVE']);
});

test('تعيين مشرفي الفريق ممنوعٌ على المفتاح دائماً (نطاق مستخدمي الشركة) — بعد الحرّاس وقبل أي قراءة', async () => {
  reset();
  const r = await runCase(C('teams', 'put', '/:id/supervisors', '/api/company/teams/t9/supervisors', true), { handler: true });
  assert.deepEqual([r.passed, r.status, r.code], [false, 403, 'API_KEY_FORBIDDEN']);
});
