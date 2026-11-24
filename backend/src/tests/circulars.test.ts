// «التعميمات» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — الموجّه الحقيقي /api/circulars بحرّاسه الحقيقيين (authenticate بتوكنات JWT
// حقيقية، وrequireAdmin، ونطاق المستخدم من services/adminScope) فوق Prisma مزيّف في الذاكرة (بلا قاعدة). يثبت:
//   • صلاحية كل جمهور: REPS ⇐ canManageSalesReps، USERS ⇐ canManageCompanyUsers؛ والمندوب لا يدير.
//   • عزل الشركات: تعميم شركةٍ أخرى لا يُرى ولا يُقرأ ولا يُسحب ولا يُؤكَّد، ومستلم شركةٍ أخرى مرفوض.
//   • «الكل» (الأعضاء المفعّلون الحاليّون — ومنهم من أُضيف بعد النشر) مقابل المحدَّدين.
//   • الناشر لا يصله تعميمه (في «الكل» وفي المحدَّدين).
//   • «المعلّق»: بلا المؤكَّد والمسحوب والمنتهي، الأقدم أولاً؛ والتأكيد متكرّرٌ بلا أثر بلقطة الاسم.
//   • جلسة «دخول» المالك أو الموظف: «المعلّق» [] والتأكيد ٤٠٣ — والإدارة لها باسم «الدعم الفني».
//   • المقيَّد النطاق: «الكل» منه قائمةُ نطاقه، ولا مستلم خارجه، ويرى ما نشره أو ما كل مستلميه في نطاقه.
//   • «الكل» المغلق (مسحوب أو منتهٍ) يُجمَّد على من وُجد لحظة إغلاقه — من أُضيف بعده لا يُعدّ ولا يُسرد «لم يقرأه».
//   • إقرارٌ صُفّ دون اتصال يُقبل بلحظة ضغطه (مصحَّحةً بانحراف الساعة ومحصورة) ولو وصل بعد السحب أو الانتهاء — وبعدهما ٤٠٤.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import express from 'express';

process.env.JWT_SECRET = 'circulars-test-secret';
delete process.env.STAFF_JWT_SECRET;
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ Prisma مزيّف: مطابِقٌ يرفض ما لا يعرفه من العوامل ═══
/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const MODELS = ['admin', 'salesRep', 'adminRepScope', 'circular', 'circularAck', 'superAdmin', 'platformStaff', 'platformAuditLog'] as const;
type Model = typeof MODELS[number];
const db: Record<Model, Row[]> = Object.fromEntries(MODELS.map((m) => [m, []])) as unknown as Record<Model, Row[]>;
let seq = 0;
let tick = 0;
const T0 = Date.now() - 3_600_000;
/** ساعة متزايدة لترتيب الإنشاء (أقدم من الآن بساعة فلا تتجاوز «الآن» الحقيقيّ) */
const stamp = () => new Date(T0 + (++tick) * 1000);

function cond(v: unknown, c: unknown): boolean {
  if (c === null) return v === null || v === undefined;
  if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
  if (typeof c !== 'object') return v === c;
  return Object.entries(c as Row).every(([op, x]) => {
    if (op === 'in') return (x as unknown[]).includes(v);
    if (op === 'has') return Array.isArray(v) && v.includes(x);
    if (op === 'gt') return v instanceof Date && x instanceof Date ? v.getTime() > x.getTime() : v != null && (v as number) > (x as number);
    if (op === 'not') return !cond(v, x);
    throw new Error(`عامل غير مدعوم في المزيّف: ${op}`);
  });
}
function match(model: Model, row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, c]) => {
    if (k === 'AND') return (c as Row[]).every((w) => match(model, row, w));
    if (k === 'OR') return (c as Row[]).some((w) => match(model, row, w));
    if (k === 'NOT') return !match(model, row, c as Row);
    if (model === 'circular' && k === 'acks') {
      assert.deepEqual(Object.keys(c as Row), ['none']);
      return !db.circularAck.some((a) => a.circularId === row.id && match('circularAck', a, (c as Row).none));
    }
    if (model === 'salesRep' && k === 'adminScopes') {
      assert.deepEqual(Object.keys(c as Row), ['some']);
      return db.adminRepScope.some((s) => s.salesRepId === row.id && match('adminRepScope', s, (c as Row).some));
    }
    if (c !== null && typeof c === 'object' && !(c instanceof Date) && !Object.keys(c as Row).every((op) => ['in', 'has', 'gt', 'not'].includes(op))) {
      throw new Error(`علاقة غير مدعومة في المزيّف: ${model}.${k}`);
    }
    return cond(row[k] ?? null, c);
  });
}
const pick = (row: Row, select?: Row): Row => {
  const src = select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };
  for (const [k, v] of Object.entries(src)) if (Array.isArray(v)) src[k] = [...v];
  return src;
};
function sortBy(rows: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return rows;
  const [[k, dir]] = Object.entries(orderBy);
  const val = (r: Row) => (r[k] instanceof Date ? r[k].getTime() : r[k]);
  return [...rows].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
}
const DEFAULTS: Partial<Record<Model, () => Row>> = {
  circular: () => ({ targetAll: true, targetIds: [], status: 'ACTIVE', createdByKind: null, createdById: null, createdByName: null, expiresAt: null, withdrawnAt: null, createdAt: stamp(), updatedAt: new Date() }),
  circularAck: () => ({ readerName: null, readAt: stamp() }),
};
const writes: string[] = [];
function delegate(name: Model) {
  return {
    async findUnique(a: { where: Row; select?: Row }) { const r = db[name].find((x) => match(name, x, a.where)); return r ? pick(r, a.select) : null; },
    async findFirst(a: { where: Row; select?: Row; orderBy?: Row }) { const r = sortBy(db[name].filter((x) => match(name, x, a.where)), a.orderBy)[0]; return r ? pick(r, a.select) : null; },
    async findMany(a: { where?: Row; select?: Row; orderBy?: Row; take?: number }) {
      const rows = sortBy(db[name].filter((x) => match(name, x, a.where)), a.orderBy);
      return rows.slice(0, a.take ?? rows.length).map((r) => pick(r, a.select));
    },
    async create(a: { data: Row; select?: Row }) {
      writes.push(`${name}.create`);
      const r = { id: `${name}-${++seq}`, ...(DEFAULTS[name]?.() ?? {}), ...a.data };
      db[name].push(r);
      return pick(r, a.select);
    },
    async createMany(a: { data: Row[]; skipDuplicates?: boolean }) {
      writes.push(`${name}.createMany`);
      let count = 0;
      for (const d of a.data) {
        const dup = name === 'circularAck' && db.circularAck.some((x) => x.circularId === d.circularId && x.readerKind === d.readerKind && x.readerId === d.readerId);
        if (dup) { if (a.skipDuplicates) continue; throw new Error('Unique constraint failed'); }
        db[name].push({ id: `${name}-${++seq}`, ...(DEFAULTS[name]?.() ?? {}), ...d }); count++;
      }
      return { count };
    },
    async updateMany(a: { where: Row; data: Row }) {
      writes.push(`${name}.updateMany`);
      const rows = db[name].filter((x) => match(name, x, a.where));
      for (const r of rows) Object.assign(r, a.data);
      return { count: rows.length };
    },
    async update(a: { where: Row; data: Row }) {
      const r = db[name].find((x) => match(name, x, a.where));
      if (!r) throw new Error('Record to update not found.');
      Object.assign(r, a.data);
      return { ...r };
    },
  };
}
const prisma = Object.fromEntries(MODELS.map((m) => [m, delegate(m)]));
stub('config/database', { default: prisma });

/* eslint-disable @typescript-eslint/no-var-requires */
const circularsRouter = (require('../routes/circulars') as typeof import('../routes/circulars')).default;
const svc = require('../services/circulars') as typeof import('../services/circulars');
const pa = require('../services/platformAccess') as typeof import('../services/platformAccess');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

const app = express();
app.use(express.json());
app.use('/api/circulars', circularsRouter);
app.use(errorHandler);
let base = '';
const server = http.createServer(app);
const ready = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }));
after(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));

async function call(method: 'GET' | 'POST', url: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Row }> {
  await ready;
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Row };
}

// ═══ عالم الشركتين ═══
const T1 = 'T1';
const T2 = 'T2';
const sign = (p: Row) => jwt.sign(p, SECRET, { expiresIn: '1h' });
/** لحظة إضافة أعضاء العالم الأوّلين — قبل كل تعميم */
const JOINED = new Date(T0 - 60_000);
function adminRow(id: string, o: Row = {}): Row {
  return {
    id, tenantId: T1, name: id, role: 'ADMIN', isActive: true, canDelete: true, lastSeenAt: new Date(), createdAt: JOINED,
    canManageSalesReps: true, canManageCompanyUsers: true, scopeEnabled: false, scopeMode: 'LISTS', ...o,
  };
}
const tokenOf = (a: Row) => sign({ id: a.id, role: a.role, name: a.name, tenantId: a.tenantId });
const repToken = (r: Row) => sign({ id: r.id, role: 'SALES_REP', name: r.name, tenantId: r.tenantId });
const ownerToken = (adminId: string, tenantId = T1) => sign({ id: adminId, role: 'ADMIN', name: 'مدير', tenantId, impersonated: true, by: 'o1', byKind: 'OWNER' });
const staffToken = (adminId: string) => sign({ id: adminId, role: 'ADMIN', name: 'مدير', tenantId: T1, impersonated: true, by: 'st1', byKind: 'STAFF', btv: 0 });

let A: Row; let B: Row; let NOREPS: Row; let NOUSERS: Row; let SCOPED: Row; let X: Row;
let r1: Row; let r2: Row; let r3: Row; let rOff: Row; let rX: Row;

beforeEach(() => {
  for (const m of MODELS) db[m].length = 0;
  writes.length = 0;
  A = adminRow('A', { name: 'أحمد المدير' });
  B = adminRow('B', { name: 'بدر', role: 'MANAGER' });
  NOREPS = adminRow('NOREPS', { name: 'بلا مناديب', role: 'ACCOUNTANT', canManageSalesReps: false });
  NOUSERS = adminRow('NOUSERS', { name: 'بلا مستخدمين', role: 'MANAGER', canManageCompanyUsers: false });
  SCOPED = adminRow('SCOPED', { name: 'مشرف مقيد', role: 'MANAGER', scopeEnabled: true, scopeMode: 'LISTS' });
  X = adminRow('X', { name: 'مدير الأخرى', tenantId: T2 });
  db.admin.push(A, B, NOREPS, NOUSERS, SCOPED, X, adminRow('OFF', { name: 'معطل', isActive: false }));
  r1 = { id: 'r1', tenantId: T1, name: 'خالد', isActive: true, createdAt: JOINED };
  r2 = { id: 'r2', tenantId: T1, name: 'سعد', isActive: true, createdAt: JOINED };
  r3 = { id: 'r3', tenantId: T1, name: 'فهد', isActive: true, createdAt: JOINED };
  rOff = { id: 'rOff', tenantId: T1, name: 'مندوب معطل', isActive: false, createdAt: JOINED };
  rX = { id: 'rX', tenantId: T2, name: 'مندوب الأخرى', isActive: true, createdAt: JOINED };
  db.salesRep.push(r1, r2, r3, rOff, rX);
  // نطاق المقيَّد: r1 وr2 (وr3 خارجه)
  db.adminRepScope.push({ id: 's1', tenantId: T1, adminId: 'SCOPED', salesRepId: 'r1' }, { id: 's2', tenantId: T1, adminId: 'SCOPED', salesRepId: 'r2' });
  db.superAdmin.push({ id: 'o1', isActive: true });
  db.platformStaff.push({ id: 'st1', name: 'موظف', isActive: true, tokenVersion: 0, permissions: ['tenants.impersonate'] });
});

const publish = (token: string, body: Row) => call('POST', '/api/circulars', token, body);
const REPS_ALL = { audience: 'REPS', title: 'قرار إداري', body: 'يبدأ الدوام الساعة السابعة', targetAll: true };
const USERS_ALL = { audience: 'USERS', title: 'إعلان', body: 'اجتماع الإدارة غداً', targetAll: true };
const pendingIds = async (token: string) => {
  const r = await call('GET', '/api/circulars/pending', token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.data as Row[]).map((c) => c.title);
};

// ═══════════════════ المخطط والتركيب ═══════════════════

test('المخطط: جدولان جديدان بعلاقتهما وفريد التأكيد، وTenant بعلاقة عكسية وحدها', () => {
  const schema = read('..', 'prisma', 'schema.prisma');
  const model = (n: string) => { const i = schema.indexOf(`model ${n} {`); assert.ok(i > 0, n); return schema.slice(i, schema.indexOf('\n}', i)); };
  const c = model('Circular');
  for (const f of [/tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/, /targetAll\s+Boolean\s+@default\(true\)/,
    /targetIds\s+String\[\]\s+@default\(\[\]\)/, /status\s+String\s+@default\("ACTIVE"\)/, /expiresAt\s+DateTime\?/, /withdrawnAt\s+DateTime\?/,
    /@@index\(\[tenantId, audience, createdAt\]\)/, /@@map\("circulars"\)/]) assert.match(c, f);
  const k = model('CircularAck');
  for (const f of [/circular\s+Circular\s+@relation\(fields: \[circularId\], references: \[id\], onDelete: Cascade\)/,
    /@@unique\(\[circularId, readerKind, readerId\]\)/, /@@index\(\[tenantId, readerKind, readerId\]\)/, /@@map\("circular_acks"\)/]) assert.match(k, f);
  assert.match(model('Tenant'), /\n\s+circulars\s+Circular\[\]/);
});

test('التركيب: /api/circulars بعد حارس الموقع، والبادئة مصنَّفة مفتوحة (لا عمل على عميل)', () => {
  const idx = read('index.ts');
  const at = idx.indexOf("app.use('/api/circulars', circularsRouter);");
  assert.ok(at > idx.indexOf("app.use('/api', requireRepLiveLocation);"));
  assert.ok(idx.includes("import circularsRouter from './routes/circulars';"));
  assert.ok(read('tests', 'rep-live-location.test.ts').includes("'/circulars'"));
});

// ═══════════════════ الصلاحيات ═══════════════════

test('الصلاحية لكل جمهور: REPS بصلاحية المناديب وUSERS بصلاحية مستخدمي الشركة — والمندوب لا يدير', async () => {
  assert.equal((await call('GET', '/api/circulars?audience=REPS', tokenOf(NOREPS))).status, 403);
  assert.equal((await publish(tokenOf(NOREPS), REPS_ALL)).status, 403);
  assert.equal((await call('GET', '/api/circulars?audience=USERS', tokenOf(NOREPS))).status, 200);
  assert.equal((await call('GET', '/api/circulars?audience=USERS', tokenOf(NOUSERS))).status, 403);
  assert.equal((await publish(tokenOf(NOUSERS), USERS_ALL)).status, 403);
  assert.equal((await call('GET', '/api/circulars?audience=REPS', tokenOf(NOUSERS))).status, 200);
  const denied = await call('GET', '/api/circulars?audience=REPS', tokenOf(NOREPS));
  assert.deepEqual([denied.body.code, denied.body.message], ['CIRCULAR_FORBIDDEN', svc.CIRCULAR_MESSAGES.FORBIDDEN]);
  // جمهورٌ مجهول 400، والمندوب على مسارات الإدارة 403 (requireAdmin)
  assert.equal((await call('GET', '/api/circulars?audience=ALL', tokenOf(A))).body.code, 'CIRCULAR_AUDIENCE_INVALID');
  assert.equal((await call('GET', '/api/circulars?audience=REPS', repToken(r1))).status, 403);
  assert.equal((await publish(repToken(r1), REPS_ALL)).status, 403);
  // سحب تعميم مناديب وقراءاته لمن لا يملك صلاحية المناديب: 403 بلا كتابة
  const c = (await publish(tokenOf(A), REPS_ALL)).body.data;
  writes.length = 0;
  assert.equal((await call('GET', `/api/circulars/${c.id}/reads`, tokenOf(NOREPS))).status, 403);
  assert.equal((await call('POST', `/api/circulars/${c.id}/withdraw`, tokenOf(NOREPS))).status, 403);
  assert.deepEqual(writes, []);
  assert.equal(db.circular[0].status, 'ACTIVE');
});

test('التحقّق: العنوان والنص وحدودهما، والمستلمون المحدَّدون، وتاريخ الانتهاء — برسائل عربية بلا كتابة', async () => {
  const M = svc.CIRCULAR_MESSAGES;
  const cases: Array<[Row, string]> = [
    [{ ...REPS_ALL, title: '   ' }, M.TITLE_REQUIRED],
    [{ ...REPS_ALL, title: 'x'.repeat(121) }, M.TITLE_TOO_LONG],
    [{ ...REPS_ALL, body: '' }, M.BODY_REQUIRED],
    [{ ...REPS_ALL, body: 'y'.repeat(4001) }, M.BODY_TOO_LONG],
    [{ ...REPS_ALL, targetAll: false }, M.TARGETS_REQUIRED],
    [{ ...REPS_ALL, targetAll: false, targetIds: [] }, M.TARGETS_REQUIRED],
    [{ ...REPS_ALL, targetAll: 'yes' }, M.INVALID],
    [{ ...REPS_ALL, audience: 'ALL' }, M.AUDIENCE_INVALID],
    [{ ...REPS_ALL, expiresAt: 'غداً' }, M.EXPIRY_INVALID],
    [{ ...REPS_ALL, expiresAt: new Date(Date.now() - 60_000).toISOString() }, M.EXPIRY_PAST],
    // مندوب شركةٍ أخرى، ومعطَّل، ومجهول
    [{ ...REPS_ALL, targetAll: false, targetIds: ['r1', 'rX'] }, M.TARGET_INVALID],
    [{ ...REPS_ALL, targetAll: false, targetIds: ['rOff'] }, M.TARGET_INVALID],
    [{ ...REPS_ALL, targetAll: false, targetIds: ['nope'] }, M.TARGET_INVALID],
    // مستخدم شركةٍ أخرى ومعطَّل
    [{ ...USERS_ALL, targetAll: false, targetIds: ['X'] }, M.TARGET_INVALID],
    [{ ...USERS_ALL, targetAll: false, targetIds: ['OFF'] }, M.TARGET_INVALID],
  ];
  for (const [body, message] of cases) {
    const r = await publish(tokenOf(A), body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.message, message, JSON.stringify(body));
  }
  assert.deepEqual(writes, []);
  // الحدود نفسها مقبولة، والنص يُقصّ ويُوحَّد سطره
  const ok = await publish(tokenOf(A), { ...REPS_ALL, title: ` ${'x'.repeat(120)} `, body: `  سطر\r\nثانٍ  `, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(ok.status, 201);
  assert.equal(db.circular[0].title, 'x'.repeat(120));
  assert.equal(db.circular[0].body, 'سطر\nثانٍ');
  assert.ok(db.circular[0].expiresAt instanceof Date);
});

// ═══════════════════ النشر والاستهداف ═══════════════════

test('«الكل» للمناديب: كل المفعّلين الحاليين — ومنهم من أُضيف بعد النشر — والصفّ بعدّاديه واسم ناشره', async () => {
  const r = await publish(tokenOf(A), REPS_ALL);
  assert.equal(r.status, 201);
  const row = r.body.data;
  assert.deepEqual(
    { ...row, id: undefined, createdAt: undefined },
    { id: undefined, createdAt: undefined, audience: 'REPS', title: 'قرار إداري', body: 'يبدأ الدوام الساعة السابعة', targetAll: true, targetCount: 3, readCount: 0, status: 'ACTIVE', createdByName: 'أحمد المدير', expiresAt: null },
  );
  assert.deepEqual([db.circular[0].createdByKind, db.circular[0].createdById, db.circular[0].targetIds], ['ADMIN', 'A', []]);
  for (const rep of [r1, r2, r3]) assert.deepEqual(await pendingIds(repToken(rep)), ['قرار إداري']);
  assert.deepEqual(await pendingIds(repToken(rOff)), [], 'المعطَّل لا يصله شيء');
  assert.deepEqual(await pendingIds(tokenOf(B)), [], 'تعميم المناديب لا يصل مستخدمي الشركة');
  // مندوبٌ جديد بعد النشر يصله «الكل»، والعدّاد يتّسع
  const r4 = { id: 'r4', tenantId: T1, name: 'نايف', isActive: true };
  db.salesRep.push(r4);
  assert.deepEqual(await pendingIds(repToken(r4)), ['قرار إداري']);
  const list = await call('GET', '/api/circulars?audience=REPS', tokenOf(A));
  assert.deepEqual([list.body.data[0].targetCount, list.body.data[0].readCount], [4, 0]);
});

test('المحدَّدون: يصل من اختير وحده، والمكرّر يُطوى', async () => {
  const r = await publish(tokenOf(A), { ...REPS_ALL, title: 'لخالد وسعد', targetAll: false, targetIds: ['r1', 'r2', 'r1'] });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.data.targetAll, r.body.data.targetCount], [false, 2]);
  assert.deepEqual(db.circular[0].targetIds, ['r1', 'r2']);
  assert.deepEqual(await pendingIds(repToken(r1)), ['لخالد وسعد']);
  assert.deepEqual(await pendingIds(repToken(r2)), ['لخالد وسعد']);
  assert.deepEqual(await pendingIds(repToken(r3)), []);
  // مستلمٌ عُطّل بعد النشر يسقط من العدّاد ومن غير المقروء
  db.salesRep.find((x) => x.id === 'r2')!.isActive = false;
  assert.deepEqual(await pendingIds(repToken(r2)), []);
  const reads = await call('GET', `/api/circulars/${r.body.data.id}/reads`, tokenOf(A));
  assert.deepEqual(reads.body.data, { read: [], unread: [{ id: 'r1', name: 'خالد' }] });
});

test('الناشر لا يصله تعميمه: «الكل» للمستخدمين يصل غيره، والمحدَّد يُحذف منه نفسه، ونفسه وحده 400', async () => {
  const all = await publish(tokenOf(A), USERS_ALL);
  assert.equal(all.status, 201);
  // المفعّلون في الشركة الأولى: A وB وNOREPS وNOUSERS وSCOPED — بلا الناشر أربعة
  assert.equal(all.body.data.targetCount, 4);
  assert.deepEqual(await pendingIds(tokenOf(A)), []);
  for (const u of [B, NOREPS, NOUSERS, SCOPED]) assert.deepEqual(await pendingIds(tokenOf(u)), ['إعلان']);
  assert.deepEqual(await pendingIds(tokenOf(X)), [], 'مستخدم شركةٍ أخرى');
  assert.deepEqual(await pendingIds(repToken(r1)), [], 'تعميم المستخدمين لا يصل المناديب');
  // والناشر لا يؤكّد تعميمه
  assert.equal((await call('POST', `/api/circulars/${all.body.data.id}/ack`, tokenOf(A))).status, 404);

  const some = await publish(tokenOf(A), { ...USERS_ALL, title: 'لبدر', targetAll: false, targetIds: ['A', 'B'] });
  assert.equal(some.status, 201);
  assert.deepEqual(db.circular[1].targetIds, ['B']);
  const self = await publish(tokenOf(A), { ...USERS_ALL, title: 'لنفسي', targetAll: false, targetIds: ['A'] });
  assert.deepEqual([self.status, self.body.code], [400, 'CIRCULAR_TARGETS_REQUIRED']);
  // شركةٌ لا مستخدم فيها غير ناشره: «الكل» بلا مستلمين 400
  const lone = await publish(tokenOf(X), USERS_ALL);
  assert.deepEqual([lone.status, lone.body.code], [400, 'CIRCULAR_NO_RECIPIENTS']);
});

// ═══════════════════ المعلّق والتأكيد ═══════════════════

test('المعلّق: الأقدم أولاً، بلا المؤكَّد والمسحوب والمنتهي — والتأكيد متكرّرٌ بلا أثر بلقطة الاسم', async () => {
  const first = (await publish(tokenOf(A), { ...REPS_ALL, title: 'الأول' })).body.data;
  const second = (await publish(tokenOf(A), { ...REPS_ALL, title: 'الثاني' })).body.data;
  const third = (await publish(tokenOf(A), { ...REPS_ALL, title: 'الثالث', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })).body.data;
  const fourth = (await publish(tokenOf(A), { ...REPS_ALL, title: 'الرابع' })).body.data;
  const p = await call('GET', '/api/circulars/pending', repToken(r1));
  assert.deepEqual(p.body.data.map((c: Row) => c.title), ['الأول', 'الثاني', 'الثالث', 'الرابع']);
  assert.deepEqual(Object.keys(p.body.data[0]).sort(), ['body', 'createdAt', 'createdByName', 'id', 'title']);
  assert.equal(p.body.data[0].createdByName, 'أحمد المدير');

  // التأكيد مرتين: صفٌّ واحد بلقطة الاسم
  assert.deepEqual((await call('POST', `/api/circulars/${first.id}/ack`, repToken(r1))).body, { success: true });
  assert.deepEqual((await call('POST', `/api/circulars/${first.id}/ack`, repToken(r1))).body, { success: true });
  const acks = db.circularAck.filter((a) => a.circularId === first.id);
  assert.equal(acks.length, 1);
  assert.deepEqual([acks[0].tenantId, acks[0].readerKind, acks[0].readerId, acks[0].readerName], [T1, 'REP', 'r1', 'خالد']);
  // المسحوب والمنتهي يختفيان
  assert.equal((await call('POST', `/api/circulars/${second.id}/withdraw`, tokenOf(A))).body.data.status, 'WITHDRAWN');
  db.circular.find((c) => c.id === third.id)!.expiresAt = new Date(Date.now() - 1000);
  assert.deepEqual(await pendingIds(repToken(r1)), ['الرابع']);
  assert.deepEqual(await pendingIds(repToken(r2)), ['الأول', 'الرابع'], 'تأكيد خالد لا يمسّ سعداً');
  // لا تأكيد لمسحوبٍ أو منتهٍ أو مجهول لم يؤكَّد من قبل — وتأكيدٌ سابق يبقى نجاحاً ولو سُحب التعميم بعده
  for (const id of [second.id, third.id, 'nope']) assert.equal((await call('POST', `/api/circulars/${id}/ack`, repToken(r2))).status, 404, id);
  await call('POST', `/api/circulars/${first.id}/withdraw`, tokenOf(A));
  assert.equal((await call('POST', `/api/circulars/${first.id}/ack`, repToken(r1))).status, 200);
  assert.equal(db.circularAck.length, 1);
  // مندوبٌ معطَّل بتوكنٍ قائم: لا معلّق ولا تأكيد
  db.salesRep.find((x) => x.id === 'r3')!.isActive = false;
  assert.deepEqual(await pendingIds(repToken(r3)), []);
  assert.equal((await call('POST', `/api/circulars/${fourth.id}/ack`, repToken(r3))).status, 404);
});

test('القراءات والعدّادات: من قرأ (بوقته) ومن لم يقرأ، وتأكيد المستخدم بنوعه ADMIN', async () => {
  const c = (await publish(tokenOf(A), REPS_ALL)).body.data;
  await call('POST', `/api/circulars/${c.id}/ack`, repToken(r2));
  const reads = await call('GET', `/api/circulars/${c.id}/reads`, tokenOf(A));
  assert.equal(reads.status, 200);
  assert.deepEqual(reads.body.data.read.map((x: Row) => [x.id, x.name, typeof x.readAt]), [['r2', 'سعد', 'string']]);
  assert.deepEqual(reads.body.data.unread, [{ id: 'r1', name: 'خالد' }, { id: 'r3', name: 'فهد' }]);
  const list = await call('GET', '/api/circulars?audience=REPS', tokenOf(A));
  assert.deepEqual([list.body.data[0].readCount, list.body.data[0].targetCount], [1, 3]);
  // قارئٌ عُطّل بعد قراءته يبقى في المقروء (قرأ فعلاً) والعدّاد لا يتجاوز المستلمين
  db.salesRep.find((x) => x.id === 'r2')!.isActive = false;
  const after2 = await call('GET', '/api/circulars?audience=REPS', tokenOf(A));
  assert.deepEqual([after2.body.data[0].readCount, after2.body.data[0].targetCount], [1, 3]);

  const u = (await publish(tokenOf(A), USERS_ALL)).body.data;
  assert.equal((await call('POST', `/api/circulars/${u.id}/ack`, tokenOf(B))).status, 200);
  assert.deepEqual(db.circularAck.filter((a) => a.circularId === u.id).map((a) => [a.readerKind, a.readerId, a.readerName]), [['ADMIN', 'B', 'بدر']]);
  // مندوبٌ لا يؤكّد تعميم مستخدمين ولا العكس
  assert.equal((await call('POST', `/api/circulars/${u.id}/ack`, repToken(r1))).status, 404);
  assert.equal((await call('POST', `/api/circulars/${c.id}/ack`, tokenOf(B))).status, 404);
});

// ═══════════════════ عزل الشركات ═══════════════════

test('عزل الشركات: تعميم شركةٍ أخرى لا يُعرض ولا يُقرأ ولا يُسحب ولا يُؤكَّد', async () => {
  const mine = (await publish(tokenOf(A), REPS_ALL)).body.data;
  const theirs = (await publish(tokenOf(X), { ...REPS_ALL, title: 'تعميم الأخرى' })).body.data;
  assert.equal(db.circular.find((c) => c.id === theirs.id)!.tenantId, T2);
  const list = await call('GET', '/api/circulars?audience=REPS', tokenOf(A));
  assert.deepEqual(list.body.data.map((c: Row) => c.id), [mine.id]);
  assert.equal(theirs.targetCount, 1, 'مناديب الأخرى وحدهم');
  assert.equal((await call('GET', `/api/circulars/${theirs.id}/reads`, tokenOf(A))).status, 404);
  writes.length = 0;
  assert.equal((await call('POST', `/api/circulars/${theirs.id}/withdraw`, tokenOf(A))).status, 404);
  assert.deepEqual(writes, []);
  assert.deepEqual(await pendingIds(repToken(r1)), ['قرار إداري']);
  assert.deepEqual(await pendingIds(repToken(rX)), ['تعميم الأخرى']);
  assert.equal((await call('POST', `/api/circulars/${theirs.id}/ack`, repToken(r1))).status, 404);
  assert.equal((await call('POST', `/api/circulars/${mine.id}/ack`, repToken(rX))).status, 404);
  // توكنٌ يزعم شركةً أخرى لمعرّف مندوب: لا صفّ مفعّل له فيها ⇒ لا شيء
  assert.deepEqual(await pendingIds(sign({ id: 'r1', role: 'SALES_REP', name: 'خالد', tenantId: T2 })), []);
  assert.equal(db.circularAck.length, 0);
});

// ═══════════════════ جلسات الدخول ومفتاح API ═══════════════════

test('جلسة «دخول» المالك أو الموظف: المعلّق [] والتأكيد 403 — والنشر لها باسم «الدعم الفني» ويصل صاحب الحساب', async () => {
  const c = (await publish(tokenOf(B), USERS_ALL)).body.data;
  for (const t of [ownerToken('A'), staffToken('A')]) {
    const p = await call('GET', '/api/circulars/pending', t);
    assert.deepEqual([p.status, p.body.data], [200, []]);
    const ack = await call('POST', `/api/circulars/${c.id}/ack`, t);
    assert.deepEqual([ack.status, ack.body.code], [403, 'CIRCULAR_ACK_NOT_ALLOWED']);
  }
  assert.equal(db.circularAck.length, 0);
  // صاحب الحساب نفسه يراه ويؤكّده
  assert.deepEqual(await pendingIds(tokenOf(A)), ['إعلان']);

  // النشر من جلسة المالك: كل صلاحية مفتوحة ولو كان حساب التوكن بلا صلاحية، والناشر «الدعم الفني» لا يُستثنى منه صاحب الحساب
  const byOwner = await publish(ownerToken('NOUSERS'), { ...USERS_ALL, title: 'من الدعم' });
  assert.equal(byOwner.status, 201);
  assert.equal(byOwner.body.data.createdByName, svc.SUPPORT_AUTHOR_NAME);
  const row = db.circular.find((x) => x.title === 'من الدعم')!;
  assert.deepEqual([row.createdByKind, row.createdById], ['OWNER', 'o1']);
  assert.equal(byOwner.body.data.targetCount, 5, 'المفعّلون الخمسة كلهم');
  assert.deepEqual(await pendingIds(tokenOf(NOUSERS)), ['إعلان', 'من الدعم']);
  assert.deepEqual(await pendingIds(tokenOf(A)), ['إعلان', 'من الدعم']);
  // والموظف ينشر للمناديب كذلك (سطر سجلّ نشاط المنصة قبل الكتابة)
  const bystaff = await publish(staffToken('NOREPS'), REPS_ALL);
  assert.equal(bystaff.status, 201);
  assert.equal(db.circular.find((x) => x.id === bystaff.body.data.id)!.createdById, 'st1');
  assert.ok(db.platformAuditLog.length >= 1);
  // جلسة دخول انتهى مُصدِرها: 401
  db.superAdmin[0].isActive = false;
  assert.equal((await call('GET', '/api/circulars/pending', ownerToken('A'))).status, 401);
});

test('مالك المنصة خارج الشركة: لا معلّق، ولا تأكيد، ولا إدارة', async () => {
  const owner = sign({ id: 'o1', role: 'SUPER_ADMIN', name: 'المالك' });
  assert.deepEqual((await call('GET', '/api/circulars/pending', owner)).body.data, []);
  assert.equal((await call('POST', '/api/circulars/x/ack', owner)).status, 403);
  assert.equal((await call('GET', '/api/circulars?audience=REPS', owner)).status, 403);
});

// ═══════════════════ المقيَّد النطاق ═══════════════════

test('المقيَّد النطاق: «الكل» قائمةُ مناديب نطاقه، ولا مستلم خارجه، ويرى ما نشره أو ما كل مستلميه في نطاقه', async () => {
  const all = await publish(tokenOf(SCOPED), { ...REPS_ALL, title: 'من المشرف' });
  assert.equal(all.status, 201);
  const row = db.circular.find((x) => x.title === 'من المشرف')!;
  assert.deepEqual([row.targetAll, row.targetIds.sort()], [false, ['r1', 'r2']]);
  assert.deepEqual([all.body.data.targetAll, all.body.data.targetCount], [false, 2]);
  assert.deepEqual(await pendingIds(repToken(r3)), [], 'خارج النطاق لا يصله');
  // مندوبٌ يُضاف للشركة بعده لا يدخل تعميم المشرف
  db.salesRep.push({ id: 'r5', tenantId: T1, name: 'جديد', isActive: true });
  assert.deepEqual(await pendingIds(repToken({ id: 'r5', tenantId: T1, name: 'جديد' })), []);
  const out = await publish(tokenOf(SCOPED), { ...REPS_ALL, targetAll: false, targetIds: ['r1', 'r3'] });
  assert.deepEqual([out.status, out.body.code], [400, 'CIRCULAR_TARGET_INVALID']);

  // ما ينشره غير المقيَّد: «الكل» لا يراه المشرف، والمحدَّد بنطاقه كله يراه، والمتجاوز نطاقه لا يراه
  const wide = (await publish(tokenOf(A), { ...REPS_ALL, title: 'للجميع' })).body.data;
  const inside = (await publish(tokenOf(A), { ...REPS_ALL, title: 'داخل النطاق', targetAll: false, targetIds: ['r1'] })).body.data;
  const across = (await publish(tokenOf(A), { ...REPS_ALL, title: 'عابر', targetAll: false, targetIds: ['r1', 'r3'] })).body.data;
  const list = await call('GET', '/api/circulars?audience=REPS', tokenOf(SCOPED));
  assert.deepEqual(list.body.data.map((c: Row) => c.title), ['داخل النطاق', 'من المشرف']);
  assert.deepEqual((await call('GET', '/api/circulars?audience=REPS', tokenOf(A))).body.data.map((c: Row) => c.title), ['عابر', 'داخل النطاق', 'للجميع', 'من المشرف']);
  for (const id of [wide.id, across.id]) {
    assert.equal((await call('GET', `/api/circulars/${id}/reads`, tokenOf(SCOPED))).status, 404);
    assert.equal((await call('POST', `/api/circulars/${id}/withdraw`, tokenOf(SCOPED))).status, 404);
  }
  assert.ok(db.circular.every((c) => c.status === 'ACTIVE'));
  assert.equal((await call('GET', `/api/circulars/${inside.id}/reads`, tokenOf(SCOPED))).status, 200);

  // نطاقه يضيق بعد النشر: قراءات مندوبٍ خرج منه لا تُعرض له (اسماً ولا عدّاً)
  await call('POST', `/api/circulars/${all.body.data.id}/ack`, repToken(r2));
  db.adminRepScope.splice(db.adminRepScope.findIndex((s) => s.salesRepId === 'r2'), 1);
  const reads = await call('GET', `/api/circulars/${all.body.data.id}/reads`, tokenOf(SCOPED));
  assert.deepEqual(reads.body.data, { read: [], unread: [{ id: 'r1', name: 'خالد' }] });
  const mineRow = (await call('GET', '/api/circulars?audience=REPS', tokenOf(SCOPED))).body.data.find((c: Row) => c.title === 'من المشرف');
  assert.deepEqual([mineRow.readCount, mineRow.targetCount], [0, 1]);
  // وغير المقيَّد يرى القراءة كاملة
  const full = await call('GET', `/api/circulars/${all.body.data.id}/reads`, tokenOf(A));
  assert.deepEqual(full.body.data.read.map((x: Row) => x.id), ['r2']);
  // تعميمات المستخدمين بلا نطاق: المشرف المقيَّد ينشرها لكل المستخدمين
  const users = await publish(tokenOf(SCOPED), USERS_ALL);
  assert.deepEqual([users.status, users.body.data.targetAll, users.body.data.targetCount], [201, true, 4]);
});

test('السحب: متكرّرٌ بلا أثر، ويختفي من المعلّق، ويبقى في القائمة مسحوباً بعدّاديه', async () => {
  const c = (await publish(tokenOf(A), REPS_ALL)).body.data;
  await call('POST', `/api/circulars/${c.id}/ack`, repToken(r1));
  const w1 = await call('POST', `/api/circulars/${c.id}/withdraw`, tokenOf(B));
  assert.deepEqual([w1.status, w1.body.data.status, w1.body.data.readCount, w1.body.data.targetCount], [200, 'WITHDRAWN', 1, 3]);
  writes.length = 0;
  const w2 = await call('POST', `/api/circulars/${c.id}/withdraw`, tokenOf(B));
  assert.deepEqual([w2.status, w2.body.data.status], [200, 'WITHDRAWN']);
  assert.deepEqual(writes, [], 'السحب الثاني بلا كتابة');
  assert.deepEqual(await pendingIds(repToken(r2)), []);
  const list = await call('GET', '/api/circulars?audience=REPS', tokenOf(A));
  assert.equal(list.body.data[0].status, 'WITHDRAWN');
  assert.equal((await call('POST', '/api/circulars/nope/withdraw', tokenOf(A))).status, 404);
});

test('«الكل» المغلق يُجمَّد على من وُجد لحظة إغلاقه: من أُضيف بعد السحب أو الانتهاء لا يُعدّ ولا يُسرد «لم يقرأه»', async () => {
  const w = (await publish(tokenOf(A), { ...REPS_ALL, title: 'مسحوب' })).body.data;
  const e = (await publish(tokenOf(A), { ...REPS_ALL, title: 'منتهٍ', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })).body.data;
  await publish(tokenOf(A), { ...REPS_ALL, title: 'قائم' });
  await call('POST', `/api/circulars/${w.id}/ack`, repToken(r1));
  await call('POST', `/api/circulars/${e.id}/ack`, repToken(r1));
  // أُضيف بعد النشر وقبل الإغلاق: وصله التعميم فيبقى «لم يقرأه»
  db.salesRep.push({ id: 'rMid', tenantId: T1, name: 'أنس', isActive: true, createdAt: new Date(Date.now() - 60_000) });
  const w1 = await call('POST', `/api/circulars/${w.id}/withdraw`, tokenOf(A));
  assert.deepEqual([w1.body.data.readCount, w1.body.data.targetCount], [1, 4]);
  const wRow = db.circular.find((c) => c.id === w.id)!;
  assert.ok(wRow.withdrawnAt instanceof Date, 'لحظة السحب محفوظة');
  db.circular.find((c) => c.id === e.id)!.expiresAt = new Date(Date.now() - 1000);
  // مندوبان يُضافان بعد الإغلاق: لم يصلهما شيء ولن يصلهما
  const later = new Date(Date.now() + 60_000);
  db.salesRep.push({ id: 'rNew1', tenantId: T1, name: 'جديد أول', isActive: true, createdAt: later }, { id: 'rNew2', tenantId: T1, name: 'جديد ثان', isActive: true, createdAt: later });
  const list = (await call('GET', '/api/circulars?audience=REPS', tokenOf(A))).body.data as Row[];
  const by = (t: string) => { const r = list.find((c) => c.title === t)!; return [r.readCount, r.targetCount]; };
  assert.deepEqual(by('مسحوب'), [1, 4], 'r1..r3 وrMid وحدهم');
  assert.deepEqual(by('منتهٍ'), [1, 4]);
  assert.deepEqual(by('قائم'), [0, 6], 'القائم يتّسع بمن أُضيف كما كان');
  for (const id of [w.id, e.id]) {
    const reads = await call('GET', `/api/circulars/${id}/reads`, tokenOf(A));
    assert.deepEqual(reads.body.data.unread.map((x: Row) => x.id).sort(), ['r2', 'r3', 'rMid'], id);
  }
  // السحب الثاني لا يحرّك لحظة السحب الأولى
  const at = wRow.withdrawnAt.getTime();
  await call('POST', `/api/circulars/${w.id}/withdraw`, tokenOf(B));
  assert.equal(wRow.withdrawnAt.getTime(), at);
  // ومستخدمو الشركة كذلك: من أُضيف بعد سحب «الكل» لا يُعدّ
  const u = (await publish(tokenOf(A), USERS_ALL)).body.data;
  await call('POST', `/api/circulars/${u.id}/withdraw`, tokenOf(A));
  db.admin.push(adminRow('NEWU', { name: 'مستخدم جديد', createdAt: later }));
  const uRow = (await call('GET', '/api/circulars?audience=USERS', tokenOf(A))).body.data.find((c: Row) => c.id === u.id);
  assert.equal(uRow.targetCount, 4, 'B وNOREPS وNOUSERS وSCOPED — بلا الناشر ولا الجديد');
});

test('إقرارٌ صُفّ دون اتصال قبل السحب أو الانتهاء يُقبل بلحظة ضغطه (مصحَّحةً بانحراف الساعة) — وبعد الإغلاق ٤٠٤', async () => {
  const H = (devNow: number) => ({ 'x-fs-device-now': String(devNow) });
  const w = (await publish(tokenOf(A), { ...REPS_ALL, title: 'مسحوب' })).body.data;
  const e = (await publish(tokenOf(A), { ...REPS_ALL, title: 'منتهٍ', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })).body.data;
  // ضغطوا «تمت القراءة» دون اتصال قبل عشر دقائق، ثم سُحب الأول وانتهى الثاني قبل خمس، ثم عاد الاتصال
  const pressed = Date.now() - 10 * 60_000;
  await call('POST', `/api/circulars/${w.id}/withdraw`, tokenOf(A));
  db.circular.find((c) => c.id === e.id)!.expiresAt = new Date(Date.now() - 5 * 60_000);
  const ackOf = (cid: string, rep: string) => db.circularAck.find((a) => a.circularId === cid && a.readerId === rep);

  assert.equal((await call('POST', `/api/circulars/${w.id}/ack`, repToken(r1), { readAt: pressed }, H(Date.now()))).status, 200);
  assert.ok(Math.abs(ackOf(w.id, 'r1')!.readAt.getTime() - pressed) < 5_000, 'لحظة الضغط لا لحظة الرفع');
  // ساعة جهاز r2 متقدّمة ساعتين: لحظته على ساعته تُصحَّح بالفرق نفسه
  const ahead = 2 * 3_600_000;
  assert.equal((await call('POST', `/api/circulars/${w.id}/ack`, repToken(r2), { readAt: new Date(pressed + ahead).toISOString() }, H(Date.now() + ahead))).status, 200);
  assert.ok(Math.abs(ackOf(w.id, 'r2')!.readAt.getTime() - pressed) < 5_000);
  // ضغطةٌ بعد السحب، والإقرار الحيّ بلا لحظة لمسحوب: ٤٠٤ بلا صفّ
  assert.equal((await call('POST', `/api/circulars/${w.id}/ack`, repToken(r3), { readAt: Date.now() }, H(Date.now()))).status, 404);
  assert.equal((await call('POST', `/api/circulars/${w.id}/ack`, repToken(r3))).status, 404);
  assert.equal(ackOf(w.id, 'r3'), undefined);
  // المنتهي: الضغطة قبل الانتهاء تُقبل، وبعده ٤٠٤
  assert.equal((await call('POST', `/api/circulars/${e.id}/ack`, repToken(r1), { readAt: pressed }, H(Date.now()))).status, 200);
  assert.equal((await call('POST', `/api/circulars/${e.id}/ack`, repToken(r2), { readAt: Date.now() - 60_000 }, H(Date.now()))).status, 404);
  // من قرأ بلحظة ضغطه، ومن لم يقرأ — والعدّاد بلا تغيير
  const reads = await call('GET', `/api/circulars/${w.id}/reads`, tokenOf(A));
  assert.deepEqual(reads.body.data.read.map((x: Row) => x.id).sort(), ['r1', 'r2']);
  assert.ok(Math.abs(Date.parse(reads.body.data.read[0].readAt) - pressed) < 5_000);
  assert.deepEqual(reads.body.data.unread, [{ id: 'r3', name: 'فهد' }]);
  // لا يفتح الإقرار المتأخّر ما لم يُوجَّه له: مندوبٌ أُضيف بعد السحب بلحظةٍ مزعومة قبله، وشركةٌ أخرى، والمعطَّل
  db.salesRep.push({ id: 'rLate', tenantId: T1, name: 'متأخر', isActive: true, createdAt: new Date() });
  assert.equal((await call('POST', `/api/circulars/${w.id}/ack`, repToken({ id: 'rLate', tenantId: T1, name: 'متأخر' }), { readAt: pressed }, H(Date.now()))).status, 404);
  assert.equal((await call('POST', `/api/circulars/${w.id}/ack`, repToken(rX), { readAt: pressed }, H(Date.now()))).status, 404);
  assert.equal(db.circularAck.filter((a) => a.circularId === w.id).length, 2);

  // تعميمٌ قائم: لحظةٌ أقدم من نشره تُحصر بلحظة نشره، والمستقبلية «الآن»، والتالفة «الآن»
  const open = (await publish(tokenOf(A), { ...REPS_ALL, title: 'قائم' })).body.data;
  const openRow = db.circular.find((c) => c.id === open.id)!;
  await call('POST', `/api/circulars/${open.id}/ack`, repToken(r1), { readAt: '2020-01-01T00:00:00Z' }, H(Date.now()));
  assert.equal(ackOf(open.id, 'r1')!.readAt.getTime(), openRow.createdAt.getTime());
  const before = Date.now();
  await call('POST', `/api/circulars/${open.id}/ack`, repToken(r2), { readAt: Date.now() + 86_400_000 });
  await call('POST', `/api/circulars/${open.id}/ack`, repToken(r3), { readAt: 'غداً' });
  for (const rep of ['r2', 'r3']) {
    const t = ackOf(open.id, rep)!.readAt.getTime();
    assert.ok(t >= before && t <= Date.now(), rep);
  }
});

// ═══════════════════ القواعد الصافية ═══════════════════

test('القواعد الصافية: المستلمون والناشر والعدّادات ورؤية المقيَّد', () => {
  const base = { audience: 'USERS', targetAll: true, targetIds: [] as string[], createdByKind: 'ADMIN', createdById: 'A' };
  assert.deepEqual(svc.circularTargets(base, ['A', 'B', 'C']), ['B', 'C']);
  assert.deepEqual(svc.circularTargets({ ...base, createdByKind: 'OWNER', createdById: 'o1' }, ['A', 'B']), ['A', 'B']);
  assert.deepEqual(svc.circularTargets({ ...base, targetAll: false, targetIds: ['B', 'Z', 'B', 'A'] }, ['A', 'B']), ['B']);
  assert.deepEqual(svc.circularTargets({ ...base, audience: 'REPS', createdById: 'r1' }, ['r1']), ['r1'], 'لا يُستثنى مندوبٌ بمعرّفٍ يطابق ناشراً');
  assert.deepEqual(svc.readStats(['a', 'b', 'c'], ['b', 'z']), { readCount: 2, targetCount: 4, unreadIds: ['a', 'c'] });
  const scope = new Set(['r1', 'r2']);
  assert.equal(svc.visibleToScoped({ ...base, audience: 'REPS', createdById: 'S' }, 'S', scope), true);
  assert.equal(svc.visibleToScoped({ ...base, audience: 'REPS' }, 'S', scope), false);
  assert.equal(svc.visibleToScoped({ ...base, audience: 'REPS', targetAll: false, targetIds: ['r1'] }, 'S', scope), true);
  assert.equal(svc.visibleToScoped({ ...base, audience: 'REPS', targetAll: false, targetIds: ['r1', 'r3'] }, 'S', scope), false);
  assert.equal(svc.visibleToScoped({ ...base, audience: 'REPS', targetAll: false, targetIds: [] }, 'S', scope), false);
  assert.equal(svc.parseAudience(' reps '), 'REPS');
  assert.equal(svc.parseAudience(['REPS']), null);
  // المعلّق: قيد الناشر للمستخدم وحده، و«لم يؤكّده» بنوعه
  const now = new Date();
  const w = svc.pendingWhere('T1', 'ADMIN', 'B', now) as Row;
  assert.deepEqual(w.NOT, { createdByKind: 'ADMIN', createdById: 'B' });
  assert.deepEqual(w.acks, { none: { readerKind: 'ADMIN', readerId: 'B' } });
  const wr = svc.pendingWhere('T1', 'REP', 'r1', now) as Row;
  assert.equal(wr.NOT, undefined);
  assert.equal(wr.audience, 'REPS');
  // الموجَّه أيّاً كانت حالته (للإقرار المتأخّر): بلا حالة ولا انتهاء — والموجَّه الآن فوقه بهما
  const a = svc.addressedWhere('T1', 'ADMIN', 'B') as Row;
  const t = svc.targetedWhere('T1', 'ADMIN', 'B', now) as Row;
  assert.deepEqual([a.status, a.AND.length, t.status, t.AND.length], [undefined, 1, 'ACTIVE', 2]);
  assert.deepEqual(t.NOT, a.NOT);
});

test('القواعد الصافية: لحظة الإغلاق، ومن وُجد عندها، ولحظة القراءة المصحَّحة المحصورة', () => {
  const at = (iso: string) => new Date(iso);
  const now = at('2026-11-24T12:00:00Z');
  assert.equal(svc.circularClosedAt({ status: 'ACTIVE', expiresAt: null }, now), null);
  assert.equal(svc.circularClosedAt({ status: 'ACTIVE', expiresAt: at('2026-11-25T00:00:00Z') }, now), null);
  assert.deepEqual(svc.circularClosedAt({ status: 'ACTIVE', expiresAt: at('2026-11-24T00:00:00Z') }, now), at('2026-11-24T00:00:00Z'));
  assert.deepEqual(svc.circularClosedAt({ status: 'WITHDRAWN', expiresAt: null, withdrawnAt: at('2026-11-20T00:00:00Z'), updatedAt: at('2026-11-22T00:00:00Z') }, now), at('2026-11-20T00:00:00Z'));
  assert.deepEqual(svc.circularClosedAt({ status: 'WITHDRAWN', expiresAt: null, withdrawnAt: null, updatedAt: at('2026-11-22T00:00:00Z') }, now), at('2026-11-22T00:00:00Z'), 'احتياط updatedAt');
  assert.deepEqual(svc.circularClosedAt({ status: 'WITHDRAWN', expiresAt: at('2026-11-21T00:00:00Z'), withdrawnAt: at('2026-11-23T00:00:00Z') }, now), at('2026-11-21T00:00:00Z'), 'الأسبق');

  const joined = new Map<string, Date | null>([['a', at('2026-11-01T00:00:00Z')], ['b', at('2026-11-21T00:00:00Z')], ['c', null]]);
  assert.deepEqual(svc.membersAt(joined, null), ['a', 'b', 'c']);
  assert.deepEqual(svc.membersAt(joined, at('2026-11-20T00:00:00Z')), ['a', 'c'], 'لحظةٌ مجهولة لا تُسقط صاحبها');
  assert.deepEqual(svc.membersAt(joined, at('2026-11-21T00:00:00Z')), ['a', 'b', 'c'], 'من أُضيف عند الإغلاق نفسه يُعدّ');

  const floor = at('2026-11-24T08:00:00Z');
  const iso = (i: { sent: unknown; deviceNow?: unknown }) => svc.ackReadAt({ deviceNow: undefined, ...i, now, floor }).toISOString();
  assert.equal(iso({ sent: undefined }), now.toISOString(), 'الإقرار الحيّ: الآن');
  for (const bad of ['x', '', -5, 0, Number.NaN, {}, 'y'.repeat(41)]) assert.equal(iso({ sent: bad }), now.toISOString(), String(bad));
  assert.equal(iso({ sent: at('2026-11-24T10:00:00Z').getTime(), deviceNow: String(now.getTime()) }), '2026-11-24T10:00:00.000Z');
  // ساعة جهازٍ متأخّرة ساعتين: ٠٨:٣٠ على ساعته = ١٠:٣٠ فعلاً
  assert.equal(iso({ sent: '2026-11-24T08:30:00Z', deviceNow: String(now.getTime() - 7_200_000) }), '2026-11-24T10:30:00.000Z');
  assert.equal(iso({ sent: '2026-11-24T10:00:00Z', deviceNow: 'تالف' }), '2026-11-24T10:00:00.000Z', 'ترويسةٌ تالفة: بلا تصحيح');
  assert.equal(iso({ sent: '2020-01-01T00:00:00Z' }), floor.toISOString(), 'قبل الحدّ ⇒ الحدّ');
  assert.equal(iso({ sent: now.getTime() + 3_600_000 }), now.toISOString(), 'بعد الآن ⇒ الآن');
});

test('parseCreateBody (zod): رمزٌ ورسالةٌ عربية لكل حالة — وأخطاء النوع العامة تصير «بيانات غير صحيحة» لا رسالة zod', () => {
  const M = svc.CIRCULAR_MESSAGES;
  const now = new Date('2026-11-23T10:00:00Z');
  const ok = { audience: 'reps', title: 't', body: 'b', targetAll: true };
  const bad = (body: unknown) => { const r = svc.parseCreateBody(body, now); assert.equal(r.ok, false, JSON.stringify(body)); return r.ok ? null : [r.code, r.message]; };
  assert.deepEqual(bad(null), ['CIRCULAR_INVALID', M.INVALID]);
  assert.deepEqual(bad([ok]), ['CIRCULAR_INVALID', M.INVALID]);
  assert.deepEqual(bad({ ...ok, audience: 7 }), ['CIRCULAR_AUDIENCE_INVALID', M.AUDIENCE_INVALID]);
  assert.deepEqual(bad({ ...ok, audience: undefined }), ['CIRCULAR_AUDIENCE_INVALID', M.AUDIENCE_INVALID]);
  assert.deepEqual(bad({ ...ok, title: 5 }), ['CIRCULAR_INVALID', M.INVALID]);
  assert.deepEqual(bad({ ...ok, title: null }), ['CIRCULAR_INVALID', M.TITLE_REQUIRED]);
  assert.deepEqual(bad({ ...ok, body: ['x'] }), ['CIRCULAR_INVALID', M.INVALID]);
  assert.deepEqual(bad({ ...ok, targetAll: undefined }), ['CIRCULAR_INVALID', M.INVALID]);
  assert.deepEqual(bad({ ...ok, targetAll: false, targetIds: 'r1' }), ['CIRCULAR_INVALID', M.INVALID]);
  assert.deepEqual(bad({ ...ok, targetAll: false, targetIds: ['r1', 3] }), ['CIRCULAR_INVALID', M.INVALID]);
  assert.deepEqual(bad({ ...ok, targetAll: false, targetIds: ['  '] }), ['CIRCULAR_INVALID', M.INVALID]);
  assert.deepEqual(bad({ ...ok, targetAll: false, targetIds: ['x'.repeat(65)] }), ['CIRCULAR_INVALID', M.INVALID]);
  assert.deepEqual(bad({ ...ok, targetAll: false, targetIds: null }), ['CIRCULAR_TARGETS_REQUIRED', M.TARGETS_REQUIRED]);
  assert.deepEqual(bad({ ...ok, expiresAt: 1764000000000 }), ['CIRCULAR_EXPIRY_INVALID', M.EXPIRY_INVALID]);
  assert.deepEqual(bad({ ...ok, expiresAt: `2026-12-01${' '.repeat(40)}` }), ['CIRCULAR_EXPIRY_INVALID', M.EXPIRY_INVALID]);
  assert.deepEqual(bad({ ...ok, expiresAt: '2026-11-23T10:00:00Z' }), ['CIRCULAR_EXPIRY_PAST', M.EXPIRY_PAST]);
  // المقبول: الجمهور بلا حساسية حالة، والمعرّفات مقصوصةٌ بلا تكرار، و«الكل» يُسقط المحدَّدين، وتاريخٌ بلا وقت يُقبل
  const some = svc.parseCreateBody({ ...ok, targetAll: false, targetIds: [' r1 ', 'r2', 'r1'], expiresAt: '2026-12-01', extra: 1 }, now);
  assert.ok(some.ok);
  assert.deepEqual({ ...some.data, expiresAt: some.data.expiresAt?.toISOString() }, {
    audience: 'REPS', title: 't', body: 'b', targetAll: false, targetIds: ['r1', 'r2'], expiresAt: '2026-12-01T00:00:00.000Z',
  });
  const all = svc.parseCreateBody({ ...ok, targetIds: ['r1'], expiresAt: '' }, now);
  assert.ok(all.ok);
  assert.deepEqual([all.data.targetIds, all.data.expiresAt], [[], null]);
});

test('كل رسالة عربية يردّها الخادم من رسائل الميزة ومترجمةٌ في ملف الترجمة المرافق', () => {
  const routeSrc = read('routes', 'circulars.ts');
  assert.ok(!/message: '[^']*[؀-ۿ]/.test(routeSrc), 'الرسائل من CIRCULAR_MESSAGES لا نصوصٌ مبعثرة');
  assert.equal(new Set(Object.values(svc.CIRCULAR_MESSAGES)).size, Object.values(svc.CIRCULAR_MESSAGES).length);
});
