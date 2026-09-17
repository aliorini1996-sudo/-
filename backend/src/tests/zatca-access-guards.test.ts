// حرّاس الوصول إلى بيانات ربط فوترة ZATCA خارج مسارات الخدمة نفسها — بالموجّهات الإنتاجية الحقيقية (authenticate بتوقيع JWT
// حقيقي، productionZatcaDeps، /api/company، /api/company-users) فوق Prisma مزيّف في الذاكرة: لا قاعدة بيانات ولا شبكة.
//   1) الدور من القاعدة لا من التوكن: مدير خُفِّض إلى مشرف وتوكنه ما زال ADMIN يُمنع من /api/zatca فوراً.
//   2) PUT /api/company لشركة بعلم المالك: الرقم الضريبي والسجل التجاري والدولة لمدير الشركة (دوره من القاعدة) خارج الانتحال
//      وغير مقيّد النطاق، وبصيغ PUT /api/zatca/seller — وحفظ الشعار أو الاسم بالقيم نفسها لا يُرفض.
//   3) /api/company-users: مشرف أو محاسب يملك إدارة المستخدمين لا ينشئ حساب مدير ولا يرقّي إليه ولا يخفّضه ولا يغيّر كلمة مروره،
//      ولشركة بعلم المالك لا يفعل ذلك انتحالُ المالك ولا المدير المقيّد، ولا يغيّر تقييد نطاق مدير إلا مدير غير مقيّد خارج الانتحال
//      (وإلا رفع المقيّد تقييد نفسه بمشرف ينشئه)؛ والحذف بدور القاعدة لا التوكن.
import { guardHits } from '../compliance/zatca/__fixtures__/z3-netguard';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';

const SECRET = 'zatca-access-guards-test-jwt-secret';
const T1 = 'tenant-guard-1';
const T2 = 'tenant-guard-2';

after(() => {
  assert.equal(guardHits(), 0, 'محاولة شبكة حقيقية من اختبارات الحرّاس');
});

// ─── Prisma مزيّف في الذاكرة ───

type Row = Record<string, unknown>;

interface Db {
  admins: Map<string, Row>;
  tenants: Map<string, Row>;
  settings: Map<string, Row>;
  /** كل عملية كتابة (نموذج.عملية) بحمولتها. */
  writes: Array<{ op: string; data: unknown }>;
  /** كل قراءة لصفّ حساب (لإثبات مصدر الدور). */
  adminReads: Array<{ where: unknown; select: unknown }>;
  /** قراءات صفّ الشركة (لإثبات أن علم المالك يُقرأ عند الحاجة وحدها). */
  tenantReads: number;
}

const db: Db = { admins: new Map(), tenants: new Map(), settings: new Map(), writes: [], adminReads: [], tenantReads: 0 };

function pick(row: Row | undefined | null, select?: Record<string, unknown>): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, on] of Object.entries(select)) if (on) out[k] = row[k];
  return out;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in (v as Row)) return row[k] !== (v as Row).not;
    return row[k] === v;
  });
}

function adminRow(over: Row): Row {
  return {
    id: 'x', tenantId: T1, name: 'n', email: `${String(over.id)}@t.test`, passwordHash: 'h', role: 'ADMIN', isActive: true, lastSeenAt: new Date(),
    scopeEnabled: false, canAccessDashboard: true, canManageCompanySettings: true, canManageCompanyUsers: true, ...over,
  };
}

function reset(): void {
  db.admins.clear();
  db.tenants.clear();
  db.settings.clear();
  db.writes.length = 0;
  db.adminReads.length = 0;
  db.tenantReads = 0;
  for (const a of [
    adminRow({ id: 'admin-1', role: 'ADMIN' }),
    adminRow({ id: 'admin-2', role: 'ADMIN' }),
    adminRow({ id: 'manager-1', role: 'MANAGER' }),
    adminRow({ id: 'accountant-1', role: 'ACCOUNTANT' }),
    adminRow({ id: 'admin-other', role: 'ADMIN', tenantId: T2 }),
  ]) db.admins.set(a.id as string, a);
  db.tenants.set(T1, { id: T1, zatcaPhase2Enabled: true, maxAdminUsers: null, accountingSuiteEnabled: false, accountingEnabled: true });
  db.tenants.set(T2, { id: T2, zatcaPhase2Enabled: false, maxAdminUsers: null, accountingSuiteEnabled: false, accountingEnabled: true });
  db.settings.set(T1, {
    tenantId: T1, name: 'شركة', taxNumber: '399999999900003', commercialReg: '1010010101', countryCode: 'SA', currency: 'SAR', currencyOverride: null,
    legalName: 'شركة', logo: null, einvoiceClientSecret: null,
  });
}

function fakeModels(): Record<string, unknown> {
  return {
    admin: {
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        db.adminReads.push({ where, select });
        const row = typeof where.id === 'string' ? db.admins.get(where.id) : [...db.admins.values()].find(a => a.email === where.email);
        return pick(row, select);
      },
      findFirst: async ({ where, select }: { where: Row; select?: Row }) => pick([...db.admins.values()].find(a => matches(a, where)), select),
      count: async ({ where }: { where: Row }) => [...db.admins.values()].filter(a => matches(a, where)).length,
      updateMany: async () => ({ count: 1 }), // لمسة «آخر ظهور» في authenticate — ليست كتابة موضع الاختبار
      create: async ({ data, select }: { data: Row; select?: Row }) => {
        db.writes.push({ op: 'admin.create', data });
        const row = adminRow({ ...data, id: `new-${db.admins.size + 1}` });
        db.admins.set(row.id as string, row);
        return pick(row, select);
      },
      update: async ({ where, data, select }: { where: Row; data: Row; select?: Row }) => {
        db.writes.push({ op: 'admin.update', data });
        const row = db.admins.get(where.id as string);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return pick(row, select);
      },
      delete: async ({ where }: { where: Row }) => {
        db.writes.push({ op: 'admin.delete', data: where });
        const row = db.admins.get(where.id as string);
        db.admins.delete(where.id as string);
        return row;
      },
    },
    tenant: {
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        db.tenantReads++;
        return pick(db.tenants.get(where.id as string), select);
      },
    },
    // مسار الحذف: لا عقد في سلسلة التقرير اليومي، وتنظيف مستلمي التقرير الشامل ثم الحذف في «معاملة»
    dailyReportLevelOwner: { findMany: async () => [] },
    dailyReportDigestViewer: { deleteMany: async () => ({ count: 0 }) },
    // PUT /company-users/:id/scope بلا قوائم: عدّاد النطاق وحده
    adminCustomerScope: { count: async () => 0 },
    adminRepScope: { count: async () => 0 },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
    companySettings: {
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => pick(db.settings.get(where.tenantId as string), select),
      upsert: async ({ where, update, create }: { where: Row; update: Row; create: Row }) => {
        const tid = where.tenantId as string;
        const existing = db.settings.get(tid);
        db.writes.push({ op: 'companySettings.upsert', data: existing ? update : create });
        const row = existing ? Object.assign(existing, Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined))) : { ...create };
        db.settings.set(tid, row);
        return { ...row };
      },
    },
  };
}

// ─── الخادم ───

let port = 0;
let server: http.Server;

before(async () => {
  // قاعدة مستحيلة قبل تحميل Prisma (لو فات نموذجٌ المزيّف لفشل الاتصال بمنفذ مغلق محلياً لا بشبكة)
  process.env.DATABASE_URL = 'postgresql://offline:offline@127.0.0.1:9/offline?connect_timeout=1';
  process.env.JWT_SECRET = SECRET;
  const prisma = (await import('../config/database')).default as unknown as Record<string, unknown>;
  Object.assign(prisma, fakeModels());
  const companyRouter = (await import('../routes/company')).default;
  const companyUsersRouter = (await import('../routes/companyUsers')).default;
  const { createZatcaRouter, zatcaErrorGuard } = await import('../routes/zatca');
  const { productionZatcaDeps } = await import('../routes/zatcaDeps');
  const { errorHandler } = await import('../middleware/errorHandler');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/company', companyRouter);
  app.use('/api/company-users', companyUsersRouter);
  app.use('/api/zatca', createZatcaRouter(productionZatcaDeps({ NODE_ENV: 'test', ZATCA_ALLOWED_ENVS: 'simulation' })), zatcaErrorGuard);
  app.use(errorHandler);
  server = http.createServer(app);
  port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
});

after(async () => {
  await new Promise(res => server.close(res));
});

/** توكن كما يوقّعه /api/auth/login (أو /api/tenants/:id/impersonate مع impersonated). */
function token(id: string, role: string, tenantId = T1, impersonated = false): string {
  return jwt.sign({ id, role, name: id, tenantId, ...(impersonated ? { impersonated: true } : {}) }, SECRET, { expiresIn: '1h' });
}

interface Reply { status: number; body: any; text: string } // eslint-disable-line @typescript-eslint/no-explicit-any

function send(method: string, url: string, tok: string, body?: unknown): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: url,
      headers: {
        authorization: `Bearer ${tok}`,
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        try { parsed = JSON.parse(text); } catch { /* ليس JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, text });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const settingsWrites = () => db.writes.filter(w => w.op === 'companySettings.upsert');

// ─────────────────────────────────────────────────────────────────────────────
// 1) /api/zatca بالاعتماديات الإنتاجية
// ─────────────────────────────────────────────────────────────────────────────

test('productionZatcaDeps: توكن ADMIN وصفّ القاعدة MANAGER أو ACCOUNTANT (خُفِّض بعد الدخول) ⇒ 403 COMPANY_ADMIN_ONLY على الإنشاء والإيقاف والربط — والصفّ ADMIN يعبر البوابة', async () => {
  reset();
  const tok = token('admin-1', 'ADMIN');
  const unitId = '00000000-0000-4000-8000-000000000001';
  for (const demoted of ['MANAGER', 'ACCOUNTANT']) {
    db.admins.get('admin-1')!.role = demoted;
    for (const [m, u, b] of [
      ['POST', '/api/zatca/units', { environment: 'simulation' }], ['POST', `/api/zatca/units/${unitId}/retire`, { confirmation: 'إيقاف', reason: 'abandoned' }],
      ['POST', `/api/zatca/units/${unitId}/onboard`, { otp: '123456' }], ['PUT', '/api/zatca/seller', { legalName: 'x' }], ['GET', '/api/zatca/overview', undefined],
    ] as Array<[string, string, unknown]>) {
      const res = await send(m, u, tok, b);
      assert.equal(res.status, 403, `${demoted} ${m} ${u}: ${res.text}`);
      assert.equal(res.body.code, 'COMPANY_ADMIN_ONLY', `${demoted} ${m} ${u}`);
      assert.ok(!res.text.includes('123456'));
    }
  }
  assert.deepEqual(db.writes, [], 'مدير مخفَّض كتب شيئاً');
  // القراءة التي قرّرت: صفّ الحساب بالمعرّف بالدور والشركة والحياة والصلاحية
  assert.ok(db.adminReads.some(r => JSON.stringify(r.where) === '{"id":"admin-1"}'
    && JSON.stringify(r.select) === '{"isActive":true,"role":true,"tenantId":true,"canManageCompanySettings":true}'), JSON.stringify(db.adminReads));

  db.admins.get('admin-1')!.canManageCompanySettings = false;
  db.admins.get('admin-1')!.role = 'ADMIN';
  assert.equal((await send('POST', '/api/zatca/go-live', tok, {})).body.code, 'PERMISSION_DENIED', 'نزع صلاحية الإعدادات يسري فوراً');

  // ضبط: الصفّ نفسه مديراً بالصلاحية ⇒ يعبر كل البوابة (العلم والدولة والنطاق) إلى مسار التفعيل (409 دائماً قبل Z5)
  db.admins.get('admin-1')!.canManageCompanySettings = true;
  const golive = await send('POST', '/api/zatca/go-live', tok, {});
  assert.equal(golive.status, 409, golive.text);
  assert.equal(golive.body.code, 'GO_LIVE_UNAVAILABLE');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) PUT /api/company وحقول البائع
// ─────────────────────────────────────────────────────────────────────────────

const generalSave = (over: Row = {}): Row => ({
  name: 'شركة', address: '', taxNumber: '399999999900003', commercialReg: '1010010101', phone: '', email: '', logo: 'data:image/png;base64,AAAA',
  primaryColor: '#1e3a8a', headerStyle: 'classic', countryCode: 'SA', currencyOverride: '', numerals: 'arabic', ...over,
});

test('PUT /api/company بعلم المالك: المشرف والمحاسب (دورهما من القاعدة) لا يغيّران الرقم الضريبي ولا السجل ولا الدولة — وحفظهما للشعار بالقيم نفسها يمرّ بلا كتابتها', async () => {
  reset();
  for (const id of ['manager-1', 'accountant-1']) {
    const role = db.admins.get(id)!.role as string;
    for (const change of [{ taxNumber: '311111111111113' }, { commercialReg: '2020020202' }, { countryCode: 'AE' }, { taxNumber: '' }]) {
      const res = await send('PUT', '/api/company', token(id, role), generalSave(change));
      assert.equal(res.status, 403, `${id} ${JSON.stringify(change)}: ${res.text}`);
      assert.equal(res.body.code, 'SELLER_FIELDS_ADMIN_ONLY');
      assert.match(res.body.message, /مدير الشركة فقط/);
    }
    assert.equal(settingsWrites().length, 0, `${id} كتب حقول البائع`);
    // الحفظ العاديّ: القيم نفسها بمسافات أو أرقام عربية ⇒ ليس تغييراً ولا تُكتب
    const ok = await send('PUT', '/api/company', token(id, role), generalSave({ taxNumber: ' ٣٩٩٩٩٩٩٩٩٩٠٠٠٠٣ ', logo: `data:image/png;base64,${id}` }));
    assert.equal(ok.status, 200, ok.text);
    const w = settingsWrites().at(-1)!.data as Row;
    assert.equal(w.logo, `data:image/png;base64,${id}`);
    assert.ok(!('taxNumber' in w) && !('commercialReg' in w), `حفظ الشعار أعاد كتابة الرقم الضريبي: ${JSON.stringify(w)}`);
    db.writes.length = 0;
  }
  assert.equal(db.settings.get(T1)!.taxNumber, '399999999900003');
  assert.equal(db.settings.get(T1)!.countryCode, 'SA');
});

test('PUT /api/company بعلم المالك: توكن ADMIN وصفّ القاعدة MANAGER ⇒ 403، وانتحال المالك ⇒ 403 للاطلاع فقط، والمدير يغيّر بصيغ /api/zatca/seller (تطبيع وVAT سعودي)', async () => {
  reset();
  db.admins.get('admin-2')!.role = 'MANAGER';
  const demoted = await send('PUT', '/api/company', token('admin-2', 'ADMIN'), generalSave({ taxNumber: '311111111111113' }));
  assert.equal(demoted.status, 403, demoted.text);
  assert.equal(demoted.body.code, 'SELLER_FIELDS_ADMIN_ONLY');

  const imp = await send('PUT', '/api/company', token('admin-1', 'ADMIN', T1, true), generalSave({ countryCode: 'AE' }));
  assert.equal(imp.status, 403, imp.text);
  assert.equal(imp.body.code, 'SELLER_FIELDS_READ_ONLY');
  assert.deepEqual(imp.body.fields, ['countryCode']);
  assert.equal(settingsWrites().length, 0);
  // الانتحال بلا تغيير في هذه الحقول (شعار) يمرّ كما كان
  assert.equal((await send('PUT', '/api/company', token('admin-1', 'ADMIN', T1, true), generalSave({ logo: '' }))).status, 200);

  const bad = await send('PUT', '/api/company', token('admin-1', 'ADMIN'), generalSave({ taxNumber: '12345' }));
  assert.equal(bad.status, 400, bad.text);
  assert.equal(bad.body.code, 'SELLER_INVALID');
  assert.equal(bad.body.fieldErrors[0].field, 'taxNumber');
  const good = await send('PUT', '/api/company', token('admin-1', 'ADMIN'), generalSave({ taxNumber: ' ٣١١١١١١١١١١١١١٣', commercialReg: '٢٠٢٠٠٢٠٢٠٢' }));
  assert.equal(good.status, 200, good.text);
  assert.equal(db.settings.get(T1)!.taxNumber, '311111111111113', 'يُحفظ مطبَّعاً');
  assert.equal(db.settings.get(T1)!.commercialReg, '2020020202');
});

test('PUT /api/company بعلم المالك: مدير مقيّد النطاق (تردّه بوابة /api/zatca بـSCOPED_ADMIN) لا يغيّر الرقم الضريبي ولا السجل ولا الدولة — وحفظه للشعار بالقيم نفسها يمرّ، وغير المقيّد يغيّر', async () => {
  reset();
  db.admins.get('admin-1')!.scopeEnabled = true;
  const tok = token('admin-1', 'ADMIN');
  const seller = await send('PUT', '/api/zatca/seller', tok, { taxNumber: '311111111111113' });
  assert.equal(seller.status, 403, seller.text);
  assert.equal(seller.body.code, 'SCOPED_ADMIN');
  for (const change of [{ taxNumber: '311111111111113' }, { commercialReg: '2020020202' }, { countryCode: 'AE' }, { taxNumber: '' }]) {
    const res = await send('PUT', '/api/company', tok, generalSave(change));
    assert.equal(res.status, 403, `${JSON.stringify(change)}: ${res.text}`);
    assert.equal(res.body.code, 'SELLER_FIELDS_SCOPED');
    assert.match(res.body.message, /مقيد بنطاق/);
    assert.deepEqual(res.body.fields, [Object.keys(change)[0]]);
  }
  assert.equal(settingsWrites().length, 0, 'مدير مقيّد كتب حقول البائع');
  assert.equal(db.settings.get(T1)!.taxNumber, '399999999900003');
  assert.equal(db.settings.get(T1)!.countryCode, 'SA');
  // حفظ عاديّ (الشعار) بالقيم نفسها: لا تغيير في حقول البائع ⇒ يمرّ كما كان
  const logo = await send('PUT', '/api/company', tok, generalSave({ logo: 'data:image/png;base64,SCOPED' }));
  assert.equal(logo.status, 200, logo.text);
  assert.equal(db.settings.get(T1)!.logo, 'data:image/png;base64,SCOPED');
  // وبلا علم المالك: السلوك كما كان للمقيّد أيضاً
  db.tenants.get(T1)!.zatcaPhase2Enabled = false;
  assert.equal((await send('PUT', '/api/company', tok, generalSave({ taxNumber: '311111111111113' }))).status, 200);
  db.tenants.get(T1)!.zatcaPhase2Enabled = true;
  // رُفع التقييد ⇒ يغيّر (الشرط يُقرأ من القاعدة لكل طلب)
  db.admins.get('admin-1')!.scopeEnabled = false;
  const ok = await send('PUT', '/api/company', tok, generalSave({ taxNumber: '322222222222223' }));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(db.settings.get(T1)!.taxNumber, '322222222222223');
});

test('PUT /api/company بعلم المالك: جلسة لا تغيّر حقول البائع (مشرف أو انتحال) ولا ترسلها ⇒ حفظ الحقول الأخرى يمرّ ولو غيّر المدير الرقم الضريبي بعد تحميل صفحتها', async () => {
  reset();
  // المدير غيّر السجل التجاري في جلسة أخرى، والصفحة المقفلة لم تُحدَّث — الحفظ بلا الحقول الثلاثة (كما ترسله الواجهة المقفلة)
  db.settings.get(T1)!.commercialReg = '1010999999';
  const unlocked = Object.fromEntries(Object.entries(generalSave({ phone: '0501', headerStyle: 'banner' })).filter(([k]) => !['taxNumber', 'commercialReg', 'countryCode'].includes(k)));
  for (const tok of [token('manager-1', 'MANAGER'), token('admin-1', 'ADMIN', T1, true)]) {
    const res = await send('PUT', '/api/company', tok, unlocked);
    assert.equal(res.status, 200, res.text);
  }
  const s = db.settings.get(T1)!;
  assert.equal(s.phone, '0501');
  assert.equal(s.headerStyle, 'banner');
  assert.equal(s.commercialReg, '1010999999', 'الحفظ أعاد السجل القديم');
  assert.equal(s.taxNumber, '399999999900003');
  assert.equal(s.countryCode, 'SA');
  assert.equal(s.currency, 'SAR', 'العملة من الدولة المحفوظة');
  // ضبط: إرسال القيمة القديمة (السلوك السابق للواجهة) ⇒ 403 على حقلٍ لم يلمسه
  const stale = await send('PUT', '/api/company', token('manager-1', 'MANAGER'), generalSave());
  assert.equal(stale.status, 403, stale.text);
  assert.deepEqual(stale.body.fields, ['commercialReg']);
});

test('PUT /api/company بلا علم المالك: السلوك كما كان (المشرف يغيّر الرقم الضريبي كما أُرسل)', async () => {
  reset();
  db.tenants.get(T1)!.zatcaPhase2Enabled = false;
  const res = await send('PUT', '/api/company', token('manager-1', 'MANAGER'), generalSave({ taxNumber: ' 12345 ' }));
  assert.equal(res.status, 200, res.text);
  assert.equal(db.settings.get(T1)!.taxNumber, ' 12345 ');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) /api/company-users وحسابات مدير الشركة
// ─────────────────────────────────────────────────────────────────────────────

const newUser = (role: string): Row => ({ name: 'مستخدم', email: `u-${role}-${Math.random().toString(36).slice(2)}@t.test`, role, password: 'Passw0rd!!' });

test('company-users: مشرف أو محاسب يملك إدارة المستخدمين لا ينشئ مديراً ولا يرقّي إليه ولا يخفّضه ولا يغيّر كلمة مروره (403) — وما دون ذلك يمرّ، والمدير يمرّ', async () => {
  reset();
  for (const id of ['manager-1', 'accountant-1']) {
    const role = db.admins.get(id)!.role as string;
    const tok = token(id, role);
    const escalations: Array<[string, string, Row]> = [
      ['POST', '/api/company-users', newUser('ADMIN')],
      ['PUT', `/api/company-users/${id === 'manager-1' ? 'accountant-1' : 'manager-1'}`, { role: 'ADMIN' }],
      ['PUT', '/api/company-users/admin-2', { password: 'NewPassw0rd!!' }],
      ['PUT', '/api/company-users/admin-2', { role: 'MANAGER' }],
      ['PUT', '/api/company-users/admin-2', { name: 'مدير', email: 'admin-2@t.test', role: 'ADMIN', password: 'NewPassw0rd!!' }],
    ];
    for (const [m, u, b] of escalations) {
      const res = await send(m, u, tok, b);
      assert.equal(res.status, 403, `${id} ${m} ${u} ${JSON.stringify(b)}: ${res.text}`);
      assert.equal(res.body.code, 'COMPANY_ADMIN_ACCOUNT_ONLY');
    }
    assert.deepEqual(db.writes, [], `${id} كتب حساب مدير`);
    assert.equal(db.admins.get('admin-2')!.role, 'ADMIN');
    assert.equal(db.admins.get('admin-2')!.passwordHash, 'h');

    // ما ليس ترقيةً: إنشاء مشرف، وتعديل اسم المدير بدوره نفسه بلا كلمة مرور
    assert.equal((await send('POST', '/api/company-users', tok, newUser('MANAGER'))).status, 201);
    assert.equal((await send('PUT', '/api/company-users/admin-2', tok, { name: 'مدير المبيعات', role: 'ADMIN' })).status, 200);
    db.writes.length = 0;
  }

  // توكن ADMIN وصفّ القاعدة MANAGER ⇒ الدور من القاعدة
  db.admins.get('admin-1')!.role = 'MANAGER';
  const demoted = await send('POST', '/api/company-users', token('admin-1', 'ADMIN'), newUser('ADMIN'));
  assert.equal(demoted.status, 403, demoted.text);
  assert.equal(demoted.body.code, 'COMPANY_ADMIN_ACCOUNT_ONLY');
  db.admins.get('admin-1')!.role = 'ADMIN';

  // مدير الشركة: الإنشاء والترقية وإعادة تعيين كلمة مرور مدير آخر
  const adminTok = token('admin-1', 'ADMIN');
  assert.equal((await send('POST', '/api/company-users', adminTok, newUser('ADMIN'))).status, 201);
  assert.equal((await send('PUT', '/api/company-users/manager-1', adminTok, { role: 'ADMIN' })).status, 200);
  assert.equal((await send('PUT', '/api/company-users/admin-2', adminTok, { password: 'NewPassw0rd!!' })).status, 200);
  assert.notEqual(db.admins.get('admin-2')!.passwordHash, 'h');
});

test('company-users بعلم المالك: انتحال المالك والمدير المقيّد (تردّهما بوابة /api/zatca) لا ينشئان مديراً ولا يرقّيان إليه ولا يخفّضانه ولا يغيّران كلمة مروره — وما دون ذلك يمرّ، وبلا العلم كما كان', async () => {
  const escalations: Array<[string, string, Row]> = [
    ['POST', '/api/company-users', newUser('ADMIN')],
    ['PUT', '/api/company-users/manager-1', { role: 'ADMIN' }],
    ['PUT', '/api/company-users/admin-2', { password: 'NewPassw0rd!!' }],
    ['PUT', '/api/company-users/admin-2', { role: 'MANAGER' }],
    ['PUT', '/api/company-users/admin-1', { password: 'NewPassw0rd!!' }],
  ];
  const callers: Array<[string, () => string, string]> = [
    ['انتحال المالك', () => token('admin-1', 'ADMIN', T1, true), 'ADMIN_ACCOUNT_READ_ONLY'],
    ['مدير مقيّد النطاق', () => { db.admins.get('admin-1')!.scopeEnabled = true; return token('admin-1', 'ADMIN'); }, 'ADMIN_ACCOUNT_SCOPED'],
  ];
  for (const [label, tokOf, code] of callers) {
    reset();
    const tok = tokOf();
    for (const [m, u, b] of escalations) {
      const res = await send(m, u, tok, b);
      assert.equal(res.status, 403, `${label} ${m} ${u} ${JSON.stringify(b)}: ${res.text}`);
      assert.equal(res.body.code, code, `${label} ${m} ${u}`);
      assert.ok(!res.text.includes('NewPassw0rd') && !res.text.includes('Passw0rd'), 'صدى كلمة المرور');
    }
    assert.deepEqual(db.writes, [], `${label} كتب حساب مدير`);
    assert.equal(db.admins.get('admin-2')!.role, 'ADMIN');
    assert.equal(db.admins.get('admin-2')!.passwordHash, 'h');
    assert.equal(db.admins.get('admin-1')!.passwordHash, 'h');
    assert.equal(db.admins.get('manager-1')!.role, 'MANAGER');
    // ما ليس حساب مدير يمرّ كما كان: إنشاء مشرف، وكلمة مرور مشرف، واسم مدير بدوره نفسه
    assert.equal((await send('POST', '/api/company-users', tok, newUser('MANAGER'))).status, 201, label);
    assert.equal((await send('PUT', '/api/company-users/manager-1', tok, { password: 'NewPassw0rd!!' })).status, 200, label);
    assert.equal((await send('PUT', '/api/company-users/admin-2', tok, { name: 'مدير المبيعات', role: 'ADMIN' })).status, 200, label);

    // بلا علم المالك (لا بوابة ZATCA تُلتفّ): السلوك كما كان
    db.tenants.get(T1)!.zatcaPhase2Enabled = false;
    assert.equal((await send('POST', '/api/company-users', tok, newUser('ADMIN'))).status, 201, `${label} بلا العلم`);
    assert.equal((await send('PUT', '/api/company-users/admin-2', tok, { password: 'NewPassw0rd!!' })).status, 200, `${label} بلا العلم`);
  }

  // مدير غير مقيّد خارج الانتحال: لا يُقرأ علم الشركة أصلاً، وكل حسابات المدير كما كانت
  reset();
  const adminTok = token('admin-1', 'ADMIN');
  assert.equal((await send('POST', '/api/company-users', adminTok, newUser('ADMIN'))).status, 201);
  assert.equal((await send('PUT', '/api/company-users/manager-1', adminTok, { role: 'ADMIN' })).status, 200);
  assert.equal((await send('PUT', '/api/company-users/admin-2', adminTok, { password: 'NewPassw0rd!!' })).status, 200);
  assert.equal((await send('PUT', '/api/company-users/admin-2', adminTok, { role: 'MANAGER' })).status, 200);
  const flagReads = db.tenantReads;
  assert.equal((await send('PUT', '/api/company-users/manager-1', adminTok, { password: 'NewPassw0rd!!' })).status, 200);
  assert.equal(db.tenantReads, flagReads + 1, 'قراءة واحدة (ledgerSuiteOn) — لا قراءة للعلم لمدير غير مقيّد');
});

test('company-users/:id/scope بعلم المالك: مدير مقيّد لا يرفع تقييد نفسه عبر مشرف ينشئه أو يعيد تعيين كلمة مروره، ولا انتحال المالك — فتبقى بوابة /api/zatca وحقول البائع مغلقة؛ وما ليس تقييد مدير وبلا العلم كما كان', async () => {
  reset();
  db.admins.get('admin-1')!.scopeEnabled = true;
  const scopedTok = token('admin-1', 'ADMIN');
  // الخطوة ١ (مسموحة كما كانت — ليست حساب مدير): مشرف جديد يملك إدارة المستخدمين، وكلمة مرور يختارها لمشرف قائم مع الصلاحية
  const created = await send('POST', '/api/company-users', scopedTok, { ...newUser('MANAGER'), canManageCompanyUsers: true });
  assert.equal(created.status, 201, created.text);
  assert.equal((await send('PUT', '/api/company-users/manager-1', scopedTok, { canManageCompanyUsers: true, password: 'Chosen-Passw0rd' })).status, 200);
  // الخطوة ٢: المشرف أو المحاسب يرفع تقييد المدير ⇒ 403 بلا كتابة
  const liftBy: Array<[string, string]> = [[created.body.data.id as string, 'MANAGER'], ['manager-1', 'MANAGER'], ['accountant-1', 'ACCOUNTANT']];
  for (const [id, role] of liftBy) {
    const lift = await send('PUT', '/api/company-users/admin-1/scope', token(id, role), { scopeEnabled: false });
    assert.equal(lift.status, 403, `${id}: ${lift.text}`);
    assert.equal(lift.body.code, 'COMPANY_ADMIN_SCOPE_ONLY', id);
  }
  // ولا يقيّد المشرف مديراً غير مقيّد، ولا يرفع انتحال المالك التقييد
  const tighten = await send('PUT', '/api/company-users/admin-2/scope', token('manager-1', 'MANAGER'), { scopeEnabled: true });
  assert.equal(tighten.status, 403, tighten.text);
  assert.equal(tighten.body.code, 'COMPANY_ADMIN_SCOPE_ONLY');
  const imp = await send('PUT', '/api/company-users/admin-1/scope', token('admin-2', 'ADMIN', T1, true), { scopeEnabled: false });
  assert.equal(imp.status, 403, imp.text);
  assert.equal(imp.body.code, 'ADMIN_ACCOUNT_READ_ONLY');
  assert.ok(!db.writes.some(w => w.op === 'admin.update' && 'scopeEnabled' in (w.data as Row)), JSON.stringify(db.writes));
  assert.equal(db.admins.get('admin-1')!.scopeEnabled, true);
  assert.equal(db.admins.get('admin-2')!.scopeEnabled, false);
  // النتيجة: التوكن نفسه ما زال مردوداً من بوابة /api/zatca ومن حقول البائع
  const seller = await send('PUT', '/api/zatca/seller', scopedTok, { legalName: 'Evil' });
  assert.equal(seller.status, 403, seller.text);
  assert.equal(seller.body.code, 'SCOPED_ADMIN');
  const vat = await send('PUT', '/api/company', scopedTok, generalSave({ taxNumber: '311111111111113' }));
  assert.equal(vat.status, 403, vat.text);
  assert.equal(vat.body.code, 'SELLER_FIELDS_SCOPED');
  assert.equal(db.settings.get(T1)!.taxNumber, '399999999900003');

  // ما ليس تغيير تقييد مدير يمرّ كما كان: القيمة نفسها، وبلا المفتاح، وتقييد مشرف أو محاسب
  const manTok = token('manager-1', 'MANAGER');
  assert.equal((await send('PUT', '/api/company-users/admin-1/scope', manTok, { scopeEnabled: true })).status, 200, 'القيمة نفسها ليست تغييراً');
  assert.equal((await send('PUT', '/api/company-users/admin-1/scope', manTok, { customerIds: null })).status, 200, 'بلا scopeEnabled');
  assert.equal((await send('PUT', '/api/company-users/accountant-1/scope', manTok, { scopeEnabled: true })).status, 200, 'تقييد محاسب');
  assert.equal(db.admins.get('accountant-1')!.scopeEnabled, true);
  // مدير الشركة غير المقيّد خارج الانتحال يرفع التقييد ⇒ يعبر المقيَّد سابقاً البوابة (409 التفعيل قبل Z5)
  const byAdmin = await send('PUT', '/api/company-users/admin-1/scope', token('admin-2', 'ADMIN'), { scopeEnabled: false });
  assert.equal(byAdmin.status, 200, byAdmin.text);
  assert.equal(db.admins.get('admin-1')!.scopeEnabled, false);
  assert.equal((await send('POST', '/api/zatca/go-live', scopedTok, {})).body.code, 'GO_LIVE_UNAVAILABLE');

  // بلا علم المالك: المشرف يغيّر تقييد المدير كما كان
  reset();
  db.tenants.get(T1)!.zatcaPhase2Enabled = false;
  db.admins.get('admin-1')!.scopeEnabled = true;
  const off = await send('PUT', '/api/company-users/admin-1/scope', token('manager-1', 'MANAGER'), { scopeEnabled: false });
  assert.equal(off.status, 200, off.text);
  assert.equal(db.admins.get('admin-1')!.scopeEnabled, false);
});

test('رسائل رفض حسابات المدير لا تذكر ما يُسمح به: بلا علم المالك يُردّ المشرف والمحاسب بـCOMPANY_ADMIN_ACCOUNT_ONLY وحده ونصّه بلا تقييد النطاق (يغيّرانه 200)، وتقييد النطاق بعلمه برمزه ونصّه', async () => {
  const { ADMIN_ACCOUNT_REFUSALS, adminAccountChangeRefusal } = await import('../routes/companyUsers');
  const kinds: Array<[string, { targetRole: string | null; newRole?: string; password?: boolean; scope?: boolean }]> = [
    ['إنشاء مدير', { targetRole: null, newRole: 'ADMIN' }], ['ترقية', { targetRole: 'MANAGER', newRole: 'ADMIN' }], ['خفض', { targetRole: 'ADMIN', newRole: 'MANAGER' }],
    ['كلمة مرور', { targetRole: 'ADMIN', password: true }], ['تقييد النطاق', { targetRole: 'ADMIN', scope: true }],
  ];
  const emitted = new Map<string, Set<string>>(); // الرمز ⇒ حالات العلم التي يُردّ فيها
  for (const flag of [false, true]) {
    for (const role of ['ADMIN', 'MANAGER', 'ACCOUNTANT']) {
      for (const impersonated of [false, true]) {
        for (const scoped of [false, true]) {
          for (const [kind, change] of kinds) {
            const code = await adminAccountChangeRefusal({ role, impersonated }, change, { scoped: async () => scoped, zatcaPhase2On: async () => flag });
            const label = `علم=${flag} ${role} انتحال=${impersonated} مقيّد=${scoped} ${kind}`;
            if (role !== 'ADMIN' && kind === 'تقييد النطاق') assert.equal(code, flag ? 'COMPANY_ADMIN_SCOPE_ONLY' : null, label);
            else if (role !== 'ADMIN') assert.equal(code, 'COMPANY_ADMIN_ACCOUNT_ONLY', label);
            if (code) {
              if (!emitted.has(code)) emitted.set(code, new Set());
              emitted.get(code)!.add(`${flag}:${kind}`);
            }
          }
        }
      }
    }
  }
  // بلا العلم: رمز واحد، لا يُردّ به تقييد النطاق، ونصّه لا يذكره
  const offCodes = [...emitted].filter(([, cases]) => [...cases].some(c => c.startsWith('false:'))).map(([code]) => code);
  assert.deepEqual(offCodes, ['COMPANY_ADMIN_ACCOUNT_ONLY']);
  assert.ok(![...emitted.get('COMPANY_ADMIN_ACCOUNT_ONLY')!].some(c => c.endsWith(':تقييد النطاق')), 'COMPANY_ADMIN_ACCOUNT_ONLY لتقييد النطاق');
  assert.doesNotMatch(ADMIN_ACCOUNT_REFUSALS.COMPANY_ADMIN_ACCOUNT_ONLY, /نطاق/, 'نصّ يُعرض بلا العلم يذكر تقييد النطاق');
  // رموز تقييد النطاق تُردّ بعلم المالك وحده ونصوصها تذكره
  for (const [code, cases] of emitted) {
    if (![...cases].some(c => c.endsWith(':تقييد النطاق'))) continue;
    assert.ok([...cases].every(c => c.startsWith('true:')), `${code} بلا العلم`);
    assert.match((ADMIN_ACCOUNT_REFUSALS as Record<string, string>)[code], /تقييد نطاق/, code);
  }
  assert.deepEqual([...emitted.get('COMPANY_ADMIN_SCOPE_ONLY')!], ['true:تقييد النطاق']);
  assert.deepEqual(Object.keys(ADMIN_ACCOUNT_REFUSALS).filter(k => !emitted.has(k)), [], 'رمز رفض لا يُردّ');

  // الموجّه نفسه: بلا العلم رفض المشرف لإنشاء مدير بنصّ بلا تقييد النطاق، ثم يغيّر تقييد المدير 200؛ وبالعلم الرمز الجديد ونصّه
  reset();
  db.tenants.get(T1)!.zatcaPhase2Enabled = false;
  const manTok = token('manager-1', 'MANAGER');
  const create = await send('POST', '/api/company-users', manTok, newUser('ADMIN'));
  assert.equal(create.status, 403, create.text);
  assert.equal(create.body.code, 'COMPANY_ADMIN_ACCOUNT_ONLY');
  assert.equal(create.body.message, ADMIN_ACCOUNT_REFUSALS.COMPANY_ADMIN_ACCOUNT_ONLY);
  assert.doesNotMatch(create.body.message, /نطاق/);
  assert.equal((await send('PUT', '/api/company-users/admin-1/scope', manTok, { scopeEnabled: true })).status, 200);
  reset();
  const scope = await send('PUT', '/api/company-users/admin-1/scope', manTok, { scopeEnabled: true });
  assert.equal(scope.status, 403, scope.text);
  assert.equal(scope.body.code, 'COMPANY_ADMIN_SCOPE_ONLY');
  assert.equal(scope.body.message, ADMIN_ACCOUNT_REFUSALS.COMPANY_ADMIN_SCOPE_ONLY);
  assert.equal(db.admins.get('admin-1')!.scopeEnabled, false);
});

test('DELETE /api/company-users/:id: الدور من القاعدة لا التوكن — توكن ADMIN وصفّ القاعدة MANAGER (يملك إدارة المستخدمين) ⇒ 403 بلا حذف، والمدير يحذف', async () => {
  reset();
  db.admins.get('admin-2')!.role = 'MANAGER';
  const demoted = await send('DELETE', '/api/company-users/accountant-1', token('admin-2', 'ADMIN'));
  assert.equal(demoted.status, 403, demoted.text);
  assert.match(demoted.body.message, /للمدير الرئيسي فقط/);
  assert.ok(db.admins.has('accountant-1'));
  assert.deepEqual(db.writes, []);
  // الأدوار كما في التوكن والقاعدة: المشرف 403، والمدير يحذف
  assert.equal((await send('DELETE', '/api/company-users/accountant-1', token('manager-1', 'MANAGER'))).status, 403);
  const ok = await send('DELETE', '/api/company-users/accountant-1', token('admin-1', 'ADMIN'));
  assert.equal(ok.status, 200, ok.text);
  assert.ok(!db.admins.has('accountant-1'));
});
