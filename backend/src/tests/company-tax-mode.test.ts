// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — GET|PATCH /api/company/tax-mode بقاعدة مزيّفة في الذاكرة وخادم على 127.0.0.1
// (لا قاعدة ولا شبكة): القراءة لكل مستخدم شركة، والقلب لمدير الشركة غير المقيّد أو جلسة المالك بلا مفتاح API وبسطر تدقيق،
// و«بلا ضريبة» وربط المرحلة الثانية لا يجتمعان في الاتجاهين: 409 TAX_MODE_ZATCA_CONFLICT للقلب، و409 TAX_OFF_BLOCKS_ZATCA للتسليح
// والتفعيل الحيّ وعلم المالك — مع حرّاس نصّية على التركيب (company.ts بـBOM، وcompanySchema بلا المفتاح، وPUT /api/tenants/:id).
import { guardHits } from '../compliance/zatca/__fixtures__/z3-netguard';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { NextFunction, Request, Response } from 'express';
import {
  TAX_MODE_AUDIT_EVENT, TAX_MODE_ROUTE_CODES, createTaxModeRouter, taxModeAuditLine, type TaxModeDeps,
} from '../routes/companyTaxMode';
import {
  TAX_MODE_ZATCA_REASONS, ownerZatcaEnableBlock, taxModeZatcaConflictBody, taxModeZatcaConflicts, taxOffBlocksZatcaBody,
} from '../compliance/zatca/settingsGuards';
import { memoryGoLiveStore, type MemoryGoLiveStore } from '../compliance/zatca/goLiveStore';
import { ACTOR, TENANT as Z_TENANT, harness } from '../compliance/zatca/__fixtures__/z4-harness';
import { createZatcaRouter, zatcaEnvConfig, zatcaErrorGuard } from '../routes/zatca';
import { TAX_MODE_CODES, TAX_MODE_MESSAGES } from '../services/taxMode';
import { errorHandler } from '../middleware/errorHandler';
import type { AuthRequest } from '../types';

after(() => { assert.equal(guardHits(), 0, 'محاولة شبكة حقيقية'); });

const SRC = path.join(__dirname, '..');
const raw = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const TENANT = 'tenant-tax';
const NOW = new Date('2026-11-07T09:00:00.000Z');
type AdminRow = { id: string; role: string; tenantId: string; isActive: boolean };
type SettingsRow = {
  taxDisabled: boolean; taxModeChangedAt: Date | null; taxModeChangedBy: string | null;
  zatcaPhase2StartedAt: Date | null; zatcaGoLiveArmedAt: Date | null;
};
type Where = Record<string, unknown>;

const baseRow = (over: Partial<SettingsRow> = {}): SettingsRow => ({
  taxDisabled: false, taxModeChangedAt: null, taxModeChangedBy: null, zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null, ...over,
});

function fakeDb(o: { settings?: SettingsRow | null; tenantFlag?: boolean; admins?: AdminRow[]; beforeWrite?: (row: SettingsRow) => void } = {}) {
  const calls: string[] = [];
  const wheres: Where[] = [];
  let row: SettingsRow | null = o.settings === undefined ? baseRow() : o.settings;
  const admins = o.admins ?? [];
  const pick = (r: Record<string, unknown>, select: Record<string, boolean>) => Object.fromEntries(Object.keys(select).map(k => [k, r[k]]));
  const db = {
    companySettings: {
      findUnique: async (a: { where: { tenantId: string }; select: Record<string, boolean> }) => {
        calls.push(`companySettings.findUnique:${Object.keys(a.select).join(',')}`);
        return a.where.tenantId === TENANT && row ? pick(row, a.select) : null;
      },
      updateMany: async (a: { where: Where; data: Partial<SettingsRow> }) => {
        calls.push(`companySettings.updateMany:${Object.keys(a.data).join(',')}`);
        wheres.push(a.where);
        if (row && o.beforeWrite) o.beforeWrite(row);
        if (a.where.tenantId !== TENANT || !row) return { count: 0 };
        for (const [k, v] of Object.entries(a.where)) {
          if (k === 'tenantId') continue;
          if ((row as unknown as Record<string, unknown>)[k] !== v) return { count: 0 };
        }
        row = { ...row, ...a.data };
        return { count: 1 };
      },
    },
    tenant: {
      findUnique: async (a: { where: { id: string }; select: Record<string, boolean> }) => {
        calls.push(`tenant.findUnique:${Object.keys(a.select).join(',')}`);
        return a.where.id === TENANT ? { zatcaPhase2Enabled: o.tenantFlag === true } : null;
      },
    },
    admin: {
      findUnique: async (a: { where: { id: string }; select: Record<string, boolean> }) => {
        calls.push('admin.findUnique');
        const r = admins.find(x => x.id === a.where.id);
        return r ? pick(r as unknown as Record<string, unknown>, a.select) : null;
      },
    },
  };
  return { db: db as unknown as TaxModeDeps['db'], calls, wheres, current: () => row };
}

const ADMIN = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
const MANAGER = { id: 'mgr-1', role: 'MANAGER', name: 'مشرف', tenantId: TENANT };
const REP = { id: 'rep-1', role: 'SALES_REP', name: 'مندوب', tenantId: TENANT };
const ADMINS: AdminRow[] = [
  { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, isActive: true },
  { id: 'admin-scoped', role: 'ADMIN', tenantId: TENANT, isActive: true },
  { id: 'mgr-1', role: 'MANAGER', tenantId: TENANT, isActive: true },
  { id: 'admin-off', role: 'ADMIN', tenantId: TENANT, isActive: false },
  // مديرُ شركةٍ أخرى بتوكنٍ يحمل هذه الشركة — العزل من صفّه في القاعدة لا من التوكن
  { id: 'admin-moved', role: 'ADMIN', tenantId: 'tenant-other', isActive: true },
];

async function serve(db: TaxModeDeps['db'], user: () => object, o: { scoped?: string[]; audit?: string[]; permitted?: boolean; env?: Record<string, string> } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => { (req as AuthRequest).user = user() as AuthRequest['user']; next(); });
  app.use('/api/company/tax-mode', createTaxModeRouter({
    db,
    scopeEnabled: async req => req.user?.impersonated !== true && (o.scoped ?? []).includes(req.user?.id ?? ''),
    tenantId: req => req.user!.tenantId!,
    audit: line => o.audit?.push(line),
    permission: (_req, res, next) => {
      if (o.permitted === false) { res.status(403).json({ success: false, message: 'لا تملك صلاحية الوصول لهذا القسم' }); return; }
      next();
    },
    env: o.env ?? {},
    now: () => NOW,
  }));
  app.use(errorHandler);
  const server = http.createServer(app);
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const call = (method: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: '/api/company/tax-mode', agent: false, headers: { connection: 'close', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
  return { call, close: () => new Promise(r => server.close(r)) };
}

const writes = (calls: string[]) => calls.filter(c => c.startsWith('companySettings.updateMany')).length;

test('GET: مطفأ افتراضاً لكل مستخدم شركة (ولمفتاح القراءة) بقراءة عمودين، وبلا صفّ إعدادات false/null — والمندوب 403', async () => {
  const f = fakeDb();
  let user: object = MANAGER;
  const s = await serve(f.db, () => user);
  try {
    let res = await s.call('GET');
    assert.deepEqual([res.status, res.body], [200, { success: true, data: { taxDisabled: false, taxModeChangedAt: null } }]);
    assert.deepEqual(f.calls, ['companySettings.findUnique:taxDisabled,taxModeChangedAt']);
    user = { ...ADMIN, apiKeyId: 'key-ro' };
    assert.equal((await s.call('GET')).status, 200);
    user = REP;
    assert.equal((await s.call('GET')).status, 403);
  } finally { await s.close(); }
  const none = fakeDb({ settings: null });
  const s2 = await serve(none.db, () => ADMIN);
  try {
    assert.deepEqual((await s2.call('GET')).body, { success: true, data: { taxDisabled: false, taxModeChangedAt: null } });
  } finally { await s2.close(); }
});

test('PATCH بمدير الشركة: الإزالة تكتب العلم ومرجعه وفاعله بشرط «لا تسليح ولا تفعيل»، وسطر تدقيق — ثم الإعادة', async () => {
  const f = fakeDb({ admins: ADMINS });
  const audit: string[] = [];
  const s = await serve(f.db, () => ADMIN, { audit });
  try {
    let res = await s.call('PATCH', { taxDisabled: true });
    assert.deepEqual([res.status, res.body], [200, { success: true, data: { taxDisabled: true, taxModeChangedAt: NOW.toISOString() } }]);
    assert.deepEqual(f.current(), baseRow({ taxDisabled: true, taxModeChangedAt: NOW, taxModeChangedBy: 'admin-1' }));
    assert.ok(f.calls.includes('companySettings.updateMany:taxDisabled,taxModeChangedAt,taxModeChangedBy'));
    assert.deepEqual(f.wheres[0], { tenantId: TENANT, taxDisabled: false, zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null });
    assert.ok(f.calls.includes('tenant.findUnique:zatcaPhase2Enabled'), 'علم المالك يُقرأ للإزالة');
    assert.deepEqual(JSON.parse(audit[0]), { event: TAX_MODE_AUDIT_EVENT, tenantId: TENANT, actorId: 'admin-1', role: 'ADMIN', impersonated: false, taxDisabled: true });
    assert.equal(TAX_MODE_AUDIT_EVENT, 'TAX_MODE_TOGGLE');
    assert.deepEqual((await s.call('GET')).body.data, { taxDisabled: true, taxModeChangedAt: NOW.toISOString() });
    const before = f.calls.length;
    res = await s.call('PATCH', { taxDisabled: false });
    assert.deepEqual([res.status, res.body.data], [200, { taxDisabled: false, taxModeChangedAt: NOW.toISOString() }]);
    assert.deepEqual(f.wheres[1], { tenantId: TENANT, taxDisabled: true }, 'الإعادة حرّة: لا شرط على المرحلة الثانية');
    assert.ok(!f.calls.slice(before).some(c => c.startsWith('tenant.findUnique')), 'الإعادة لا تقرأ علم المالك');
    assert.equal(JSON.parse(audit[1]).taxDisabled, false);
    assert.equal(f.current()?.taxDisabled, false);
  } finally { await s.close(); }
});

test('PATCH بالقيمة نفسها: لا كتابة ولا تدقيق، والمرجع taxModeChangedAt لا يتقدّم', async () => {
  const at = new Date('2026-11-01T00:00:00.000Z');
  const f = fakeDb({ admins: ADMINS, settings: baseRow({ taxDisabled: true, taxModeChangedAt: at, taxModeChangedBy: 'admin-1' }) });
  const audit: string[] = [];
  const s = await serve(f.db, () => ADMIN, { audit });
  try {
    const res = await s.call('PATCH', { taxDisabled: true });
    assert.deepEqual([res.status, res.body.data], [200, { taxDisabled: true, taxModeChangedAt: at.toISOString() }]);
  } finally { await s.close(); }
  assert.equal(writes(f.calls), 0);
  assert.deepEqual(audit, []);
  const g = fakeDb({ admins: ADMINS });
  const s2 = await serve(g.db, () => ADMIN, { audit });
  try {
    assert.deepEqual((await s2.call('PATCH', { taxDisabled: false })).body.data, { taxDisabled: false, taxModeChangedAt: null });
  } finally { await s2.close(); }
  assert.equal(writes(g.calls), 0);
  assert.deepEqual(audit, []);
});

test('PATCH مرفوض: مشرف 403 TAX_MODE_ADMIN_ONLY، مقيّد 403 TAX_MODE_SCOPED، مفتاح API 403 API_KEY_FORBIDDEN، معطّل ومجهول ومنقول — بلا كتابة ولا تدقيق', async () => {
  const f = fakeDb({ admins: ADMINS });
  const audit: string[] = [];
  let user: object = MANAGER;
  const s = await serve(f.db, () => user, { scoped: ['admin-scoped'], audit });
  try {
    let res = await s.call('PATCH', { taxDisabled: true });
    assert.deepEqual([res.status, res.body.code, res.body.message], [403, 'TAX_MODE_ADMIN_ONLY', TAX_MODE_ROUTE_CODES.TAX_MODE_ADMIN_ONLY]);
    user = { ...ADMIN, id: 'admin-scoped' };
    res = await s.call('PATCH', { taxDisabled: true });
    assert.deepEqual([res.status, res.body.code], [403, 'TAX_MODE_SCOPED']);
    user = { ...ADMIN, apiKeyId: 'key-1' };
    res = await s.call('PATCH', { taxDisabled: true });
    assert.deepEqual([res.status, res.body.code, res.body.message], [403, 'API_KEY_FORBIDDEN', 'هذا الإجراء غير متاح بمفتاح API']);
    // ولا جلسة المالك تتجاوز رفض المفتاح
    user = { ...ADMIN, apiKeyId: 'key-2', impersonated: true };
    assert.deepEqual((await s.call('PATCH', { taxDisabled: true })).body.code, 'API_KEY_FORBIDDEN');
    for (const id of ['admin-off', 'ghost', 'admin-moved']) {
      user = { ...ADMIN, id };
      res = await s.call('PATCH', { taxDisabled: true });
      assert.deepEqual([res.status, res.body.code], [403, 'TAX_MODE_ADMIN_ONLY'], id);
    }
    user = REP;
    assert.equal((await s.call('PATCH', { taxDisabled: true })).status, 403);
  } finally { await s.close(); }
  assert.deepEqual(f.current(), baseRow());
  assert.equal(writes(f.calls), 0);
  assert.deepEqual(audit, []);
  const g = fakeDb({ admins: ADMINS });
  const s2 = await serve(g.db, () => ADMIN, { permitted: false });
  try {
    assert.equal((await s2.call('PATCH', { taxDisabled: true })).status, 403);
  } finally { await s2.close(); }
  assert.deepEqual(g.calls, [], 'حارس الصلاحية قبل كل قراءة');
});

test('PATCH بجلسة مالك المنصة: مسموح ولو عبر حساب مشرف أو مقيّد، والفاعل OWNER:<المعرّف> وimpersonated:true — والعزل باقٍ', async () => {
  const f = fakeDb({ admins: ADMINS });
  const audit: string[] = [];
  let user: object = { ...MANAGER, impersonated: true };
  const s = await serve(f.db, () => user, { scoped: ['mgr-1'], audit });
  try {
    const res = await s.call('PATCH', { taxDisabled: true });
    assert.deepEqual([res.status, res.body.data], [200, { taxDisabled: true, taxModeChangedAt: NOW.toISOString() }]);
    assert.equal(f.current()?.taxModeChangedBy, 'OWNER:mgr-1');
    assert.deepEqual(JSON.parse(audit[0]), { event: 'TAX_MODE_TOGGLE', tenantId: TENANT, actorId: 'mgr-1', role: 'MANAGER', impersonated: true, taxDisabled: true });
    user = { ...ADMIN, id: 'admin-moved', impersonated: true };
    assert.deepEqual((await s.call('PATCH', { taxDisabled: false })).body.code, 'TAX_MODE_ADMIN_ONLY');
  } finally { await s.close(); }
  assert.equal(audit.length, 1);
});

test('الإزالة مع ربط المرحلة الثانية: 409 TAX_MODE_ZATCA_CONFLICT لكل سبب (علم المالك، الحيّ، التسليح، البروفة) بلا كتابة — والإعادة حرّة', async () => {
  const LIVE = new Date('2026-10-02T00:00:00.000Z');
  const cases: Array<{ name: string; o: Parameters<typeof fakeDb>[0]; env?: Record<string, string>; reasons: string[] }> = [
    { name: 'flag', o: { tenantFlag: true }, reasons: ['TENANT_FLAG'] },
    { name: 'live', o: { settings: baseRow({ zatcaPhase2StartedAt: LIVE }) }, reasons: ['LIVE'] },
    { name: 'armed', o: { settings: baseRow({ zatcaGoLiveArmedAt: LIVE }) }, reasons: ['ARMED'] },
    { name: 'rehearsal', o: {}, env: { ZATCA_REHEARSAL_TENANT_IDS: `other, ${TENANT}` }, reasons: ['REHEARSAL'] },
    { name: 'all', o: { tenantFlag: true, settings: baseRow({ zatcaPhase2StartedAt: LIVE, zatcaGoLiveArmedAt: LIVE }) }, env: { ZATCA_REHEARSAL_TENANT_IDS: TENANT }, reasons: ['TENANT_FLAG', 'LIVE', 'ARMED', 'REHEARSAL'] },
  ];
  for (const c of cases) {
    const f = fakeDb({ admins: ADMINS, ...c.o });
    const audit: string[] = [];
    const s = await serve(f.db, () => ADMIN, { audit, env: c.env });
    try {
      const res = await s.call('PATCH', { taxDisabled: true });
      assert.deepEqual([res.status, res.body], [409, {
        success: false, code: 'TAX_MODE_ZATCA_CONFLICT', message: TAX_MODE_MESSAGES.TAX_MODE_ZATCA_CONFLICT, reasons: c.reasons,
      }], c.name);
    } finally { await s.close(); }
    assert.equal(writes(f.calls), 0, c.name);
    assert.deepEqual(audit, [], c.name);
  }
  // بروفة شركةٍ أخرى لا تمنع
  const other = fakeDb({ admins: ADMINS });
  const s0 = await serve(other.db, () => ADMIN, { env: { ZATCA_REHEARSAL_TENANT_IDS: 'other' } });
  try { assert.equal((await s0.call('PATCH', { taxDisabled: true })).status, 200); } finally { await s0.close(); }
  // حالةٌ متناقضة (سباقٌ سابق): الإعادة تمرّ رغم الربط
  const f = fakeDb({ admins: ADMINS, tenantFlag: true, settings: baseRow({ taxDisabled: true, zatcaGoLiveArmedAt: LIVE }) });
  const s = await serve(f.db, () => ADMIN);
  try {
    const res = await s.call('PATCH', { taxDisabled: false });
    assert.deepEqual([res.status, res.body.data.taxDisabled], [200, false]);
  } finally { await s.close(); }
  assert.equal(f.current()?.taxDisabled, false);
});

test('سباق: تسليحٌ بين القراءة والكتابة ⇒ الكتابة المشروطة لا تُطبَّق و409 بالسبب؛ وقلبٌ مماثل سبقنا ⇒ 200 بلا تدقيق', async () => {
  const ARMED = new Date('2026-11-07T08:59:59.000Z');
  const f = fakeDb({ admins: ADMINS, beforeWrite: row => { row.zatcaGoLiveArmedAt = ARMED; } });
  const audit: string[] = [];
  const s = await serve(f.db, () => ADMIN, { audit });
  try {
    const res = await s.call('PATCH', { taxDisabled: true });
    assert.deepEqual([res.status, res.body.code, res.body.reasons], [409, 'TAX_MODE_ZATCA_CONFLICT', ['ARMED']]);
  } finally { await s.close(); }
  assert.equal(f.current()?.taxDisabled, false);
  assert.deepEqual(audit, []);
  const EARLIER = new Date('2026-11-07T08:59:00.000Z');
  const g = fakeDb({ admins: ADMINS, beforeWrite: row => { row.taxDisabled = true; row.taxModeChangedAt = EARLIER; } });
  const s2 = await serve(g.db, () => ADMIN, { audit });
  try {
    const res = await s2.call('PATCH', { taxDisabled: true });
    assert.deepEqual([res.status, res.body.data], [200, { taxDisabled: true, taxModeChangedAt: EARLIER.toISOString() }]);
  } finally { await s2.close(); }
  assert.deepEqual(audit, []);
});

test('PATCH: بلا صفّ إعدادات 409 COMPANY_SETTINGS_MISSING بلا إنشاء؛ وجسمٌ خاطئ 400 بلا كتابة', async () => {
  const none = fakeDb({ settings: null, admins: ADMINS });
  const audit: string[] = [];
  let s = await serve(none.db, () => ADMIN, { audit });
  try {
    const res = await s.call('PATCH', { taxDisabled: true });
    assert.deepEqual([res.status, res.body.code, res.body.message], [409, 'COMPANY_SETTINGS_MISSING', 'احفظ بيانات الشركة أولا']);
  } finally { await s.close(); }
  assert.deepEqual(audit, []);
  assert.equal(writes(none.calls), 0);
  const f = fakeDb({ admins: ADMINS });
  s = await serve(f.db, () => ADMIN);
  try {
    for (const body of [{}, { taxDisabled: 'true' }, { taxDisabled: 1 }, { taxDisabled: null }, { enabled: true }]) {
      assert.equal((await s.call('PATCH', body)).status, 400, JSON.stringify(body));
    }
  } finally { await s.close(); }
  assert.equal(writes(f.calls), 0);
});

test('الحارس النقيّ: أسباب التعارض وأجسام الرفض برموز services/taxMode ورسائله، وحارس علم المالك على الانتقال وحده', () => {
  assert.deepEqual([...TAX_MODE_ZATCA_REASONS], ['TENANT_FLAG', 'LIVE', 'ARMED', 'REHEARSAL']);
  assert.deepEqual(taxModeZatcaConflicts({ tenantFlag: false, liveAt: null, armedAt: null, rehearsal: false }), []);
  assert.deepEqual(taxModeZatcaConflicts({ tenantFlag: null, liveAt: undefined, armedAt: undefined, rehearsal: false }), []);
  assert.deepEqual(taxModeZatcaConflicts({ tenantFlag: true, liveAt: NOW, armedAt: NOW, rehearsal: true }), ['TENANT_FLAG', 'LIVE', 'ARMED', 'REHEARSAL']);
  assert.deepEqual(taxModeZatcaConflictBody(['LIVE']), { success: false, code: TAX_MODE_CODES.zatcaConflict, message: TAX_MODE_MESSAGES.TAX_MODE_ZATCA_CONFLICT, reasons: ['LIVE'] });
  assert.deepEqual(taxOffBlocksZatcaBody(), { success: false, code: 'TAX_OFF_BLOCKS_ZATCA', message: TAX_MODE_MESSAGES.TAX_OFF_BLOCKS_ZATCA });
  const off = { zatcaPhase2Enabled: false, settings: { taxDisabled: true } };
  assert.deepEqual(ownerZatcaEnableBlock(off, true), { status: 409, body: taxOffBlocksZatcaBody() });
  assert.equal(ownerZatcaEnableBlock(off, false), null, 'الإطفاء حرّ');
  assert.equal(ownerZatcaEnableBlock(off, undefined), null, 'الجسم بلا العلم');
  assert.equal(ownerZatcaEnableBlock({ ...off, zatcaPhase2Enabled: true }, true), null, 'القيمة نفسها تمرّ');
  assert.equal(ownerZatcaEnableBlock({ zatcaPhase2Enabled: false, settings: { taxDisabled: false } }, true), null);
  assert.equal(ownerZatcaEnableBlock({ zatcaPhase2Enabled: false, settings: null }, true), null, 'بلا صفّ إعدادات = سلوك اليوم');
  assert.equal(ownerZatcaEnableBlock(null, true), null, 'شركة غير موجودة: يقرّرها التحديث كما اليوم');
  const line = JSON.parse(taxModeAuditLine({ tenantId: 't'.repeat(300), actorId: '', role: 'ADMIN', impersonated: false, taxDisabled: true }));
  assert.equal(line.tenantId.length, 128);
  assert.equal(line.actorId, null);
  assert.deepEqual(Object.keys(line), ['event', 'tenantId', 'actorId', 'role', 'impersonated', 'taxDisabled']);
});

// ─── الاتجاه العكسي: التسليح والتفعيل الحيّ عبر موجّه ZATCA الحقيقي (مخزن ذاكرة) ───

async function zatcaRig(store: Parameters<typeof createZatcaRouter>[0]['goLiveStore']) {
  const h = harness({ env: 'production', productionBackend: true });
  const ADMIN_Z = { id: ACTOR, role: 'ADMIN', name: 'a', tenantId: Z_TENANT };
  const router = createZatcaRouter({
    authenticate: (req: AuthRequest, _res: Response, next: NextFunction) => { req.user = ADMIN_Z as AuthRequest['user']; next(); },
    loadAdmin: async () => ({ isActive: true, role: 'ADMIN', tenantId: Z_TENANT, canManageCompanySettings: true }),
    isScopeRestricted: async () => false,
    loadTenantFlag: async () => true,
    store: h.store,
    writeSeller: async () => true,
    loadKeyring: () => h.keyring,
    clientFactory: h.client,
    now: h.clock.now,
    config: zatcaEnvConfig({ NODE_ENV: 'production', ZATCA_ALLOWED_ENVS: 'production' }),
    log: () => {},
    audit: () => {},
    goLiveStore: store,
    goLiveEnv: { ZATCA_GO_LIVE: 'on' },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/zatca', router, zatcaErrorGuard);
  const server = http.createServer(app);
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const post = (url: string, body: Record<string, unknown> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({ host: '127.0.0.1', port, path: `/api/zatca${url}`, method: 'POST', agent: false, headers: { connection: 'close', 'content-type': 'application/json', 'content-length': payload.length } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
  return { post, close: async () => { await router.idle(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); } };
}

test('التسليح والتفعيل الحيّ لشركةٍ «بلا ضريبة»: 409 TAX_OFF_BLOCKS_ZATCA بلا تسليح — وغيرها كما اليوم', async () => {
  const store: MemoryGoLiveStore = memoryGoLiveStore({ taxOff: [Z_TENANT] });
  let r = await zatcaRig(store);
  try {
    let res = await r.post('/go-live/arm');
    assert.deepEqual([res.status, res.body], [409, { success: false, code: 'TAX_OFF_BLOCKS_ZATCA', message: TAX_MODE_MESSAGES.TAX_OFF_BLOCKS_ZATCA }]);
    assert.equal(store.armed.get(Z_TENANT) ?? null, null, 'لم يُسلَّح');
    res = await r.post('/go-live', { repsSynced: true, typedConfirmation: 'تفعيل' });
    assert.deepEqual([res.status, res.body.code], [409, 'TAX_OFF_BLOCKS_ZATCA']);
    // تسليحٌ سبق القلب بلحظة: التفعيل الحيّ يبقى مرفوضاً
    store.armed.set(Z_TENANT, new Date('2026-09-16T08:00:00.000Z'));
    res = await r.post('/go-live', { repsSynced: true, typedConfirmation: 'تفعيل' });
    assert.deepEqual([res.status, res.body.code], [409, 'TAX_OFF_BLOCKS_ZATCA']);
    // نزع التسليح (التعافي) غير محروس
    res = await r.post('/go-live/disarm');
    assert.equal(res.status, 200);
  } finally { await r.close(); }
  // بالضريبة: التسليح كما اليوم
  const normal = memoryGoLiveStore();
  r = await zatcaRig(normal);
  try {
    const res = await r.post('/go-live/arm');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.applied, true);
  } finally { await r.close(); }
  // مخزنٌ بلا القارئ (قديم): لا فحص
  const legacy = memoryGoLiveStore({ taxOff: [Z_TENANT] });
  const { loadTaxDisabled: _drop, ...rest } = legacy;
  void _drop;
  r = await zatcaRig(rest);
  try {
    assert.equal((await r.post('/go-live/arm')).status, 200);
  } finally { await r.close(); }
});

// ─── حرّاس نصّية ───

test('حرّاس نصّية: التركيب في company.ts بـBOM، وcompanySchema بلا العلم، والموجّه بحرّاسه، وPUT /api/tenants/:id يحرس علم المالك', () => {
  const company = raw('routes/company.ts');
  assert.equal(company.charCodeAt(0), 0xfeff, 'company.ts يبدأ بـBOM');
  assert.ok(company.includes("import companyTaxModeRouter from './companyTaxMode';"));
  assert.ok(company.includes("router.use('/tax-mode', companyTaxModeRouter);"));
  const schema = company.slice(company.indexOf('const companySchema'), company.indexOf('});', company.indexOf('const companySchema')));
  assert.ok(schema.length > 0);
  assert.doesNotMatch(schema, /taxDisabled|taxMode/);
  const route = raw('routes/companyTaxMode.ts');
  assert.ok(route.includes("deps.permission ?? requireAdminPermission('canManageCompanySettings')"));
  assert.ok(route.includes('router.use(requireAdmin);'));
  for (const code of ['TAX_MODE_ADMIN_ONLY', 'TAX_MODE_SCOPED', 'API_KEY_FORBIDDEN', 'COMPANY_SETTINGS_MISSING']) assert.ok(route.includes(`'${code}'`), code);
  assert.match(route, /export default createTaxModeRouter\(\{\s*db: prisma,\s*scopeEnabled: adminScopeEnabled,/);
  // PUT /api/tenants/:id: الحارس قبل معاملة التحديث، ومشروطٌ بالتفعيل في الجسم
  const tenants = raw('routes/tenants.ts');
  const put = tenants.slice(tenants.indexOf("router.put('/:id'"), tenants.indexOf('\n});', tenants.indexOf("router.put('/:id'")));
  const guard = put.indexOf('if (body.zatcaPhase2Enabled === true) {');
  assert.ok(guard > 0 && put.indexOf('ownerZatcaEnableBlock(zCur, body.zatcaPhase2Enabled)') > guard);
  assert.ok(guard < put.indexOf('prisma.$transaction('), 'قبل أي كتابة');
  // مسارا التسليح والتفعيل: الحارس بعد علم البيئة وقبل الكتابة/البوابة
  const z = raw('routes/zatca.ts');
  const arm = z.slice(z.indexOf("router.post('/go-live/arm'"), z.indexOf("router.post('/go-live/disarm'"));
  assert.ok(arm.indexOf('if (await taxOffFor(ctx.tenantId))') > arm.indexOf('goLiveEnvAllows(') && arm.indexOf('if (await taxOffFor(ctx.tenantId))') < arm.indexOf('store.setArmedAtOnce('));
  const live = z.slice(z.indexOf("router.post('/go-live', h(log"), z.indexOf('// ─── مراجعة الانتقال'));
  assert.ok(live.indexOf('if (await taxOffFor(ctx.tenantId))') > 0 && live.indexOf('if (await taxOffFor(ctx.tenantId))') < live.indexOf('await goLiveGateFor(ctx)'));
  const store = raw('compliance/zatca/goLiveStore.prisma.ts');
  assert.match(store, /async loadTaxDisabled\(tenantId\) \{\s*\/\/[^\n]*\n\s*const s = await prisma\.companySettings\.findUnique\(\{ where: \{ tenantId \}, select: \{ taxDisabled: true \} \}\);\s*return s\?\.taxDisabled === true;/);
});
