// «سجلّ العميل» — قرار المالك (٢٧ نوفمبر ٢٠٢٦): «بعد حذف العميل يحذف سجله معه».
// كل مسارٍ يحذف عميلاً يحذف أسطر سجلّه في معاملة الحذف نفسها: إذن المعاملة لمُطلِق القاعدة (allowActivityPurge) أولاً ثم
// customerActivity.deleteMany لهذا العميل وحده في شركته — ولا حدث CUSTOMER_DELETED بعد اليوم:
//   • حذف المدير للعميل DELETE /customers/:id (routes/customers.ts ← services/ownerPurge.ts purgeInTx الحقيقي).
//   • الحذف النهائي لمالك المنصة POST /owner-purge/delete { model: 'Customer', ids } (routes/ownerPurge.ts ← purgeInTx).
//   • التراجع عن دفعة استيراد العملاء POST /import/batches/:id/revert (routes/import.ts).
// فوق قاعدةٍ في الذاكرة (بلا قاعدة بيانات ولا شبكة) تفرض المفاتيح الأجنبية من نموذج Prisma، وتحاكي المعاملة (تراجعٌ كامل عند
// الرمي أو فشل الالتزام) ومُطلِق السجلّ (services/customerActivityGuard.ts): حذف أسطره مرفوضٌ إلا بإذن المعاملة نفسها، والتعديل
// مرفوضٌ دائماً. وحارسٌ ثابت: لا حذفَ مباشرٍ لصفّ العميل في المصدر إلا ومعه حذف سجلّه (أو هو حذف الشركة كلها).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
type Row = Record<string, any>;

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const MODELS = Prisma.dmmf.datamodel.models;
const SKIP = MODELS.some((m) => m.name === 'CustomerActivity') ? false : 'عميل Prisma المثبَّت قديم (لا يرى CustomerActivity) — شغّل prisma generate';

// ═══ قاعدة في الذاكرة: مفاتيح أجنبية من نموذج Prisma، ومعاملات بتراجعٍ كامل، ومُطلِق السجلّ ═══

const delegateOf = (m: string): string => m.charAt(0).toLowerCase() + m.slice(1);
const modelOfDelegate = new Map(MODELS.map((m) => [delegateOf(m.name), m.name]));

interface Rel { child: string; fk: string; parent: string; ref: string; onDelete: string }
const RELS: Rel[] = [];
for (const m of MODELS) {
  for (const f of m.fields) {
    if (f.kind !== 'object' || f.relationFromFields?.length !== 1) continue;
    const fkField = m.fields.find((x) => x.name === f.relationFromFields![0]);
    // افتراض Prisma حين لا onDelete: الإلزامي Restrict والاختياري SetNull
    const onDelete = (f as { relationOnDelete?: string }).relationOnDelete ?? (fkField?.isRequired ? 'Restrict' : 'SetNull');
    RELS.push({ child: m.name, fk: f.relationFromFields[0], parent: f.type, ref: f.relationToFields![0], onDelete });
  }
}

class FkError extends Error { code = 'P2003'; }
/** ما يرميه مُطلِق القاعدة fs_customer_activity_immutable */
class LogImmutableError extends Error { code = 'P2010'; }

type Op = { op: string; tx: number | null; args?: any; sql?: string };
let tables = new Map<string, Row[]>();
let ops: Op[] = [];
let txSeq = 0;
let autoId = 0;
/** المعاملات التي ضبطت fs.activity_purge = on محلياً (set_config(..., true)) — يموت الإذن بانتهائها */
const purgeAllowed = new Set<number>();
let failCommits = 0;
/** «نموذج.دالّة» ترمي P2003 عند أول نداءٍ لها (فشلٌ في منتصف معاملة الحذف) */
let failOn: string | null = null;

const table = (m: string): Row[] => { let t = tables.get(m); if (!t) { t = []; tables.set(m, t); } return t; };

function seed(s: Record<string, Row[]>): void {
  tables = new Map(Object.entries(s).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  ops = []; txSeq = 0; autoId = 0; purgeAllowed.clear(); failCommits = 0; failOn = null;
}

function match(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v === null) return row[k] == null;
    if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
    if (typeof v === 'object') {
      return Object.entries(v as Row).every(([op, x]) => {
        const c = row[k];
        switch (op) {
          case 'in': return (x as unknown[]).includes(c);
          case 'not': return x === null ? c != null : c !== x;
          case 'gt': return c != null && c > x;
          case 'gte': return c != null && c >= x;
          case 'lt': return c != null && c < x;
          case 'lte': return c != null && c <= x;
          default: throw new Error(`fake: unsupported filter ${k}.${op}`);
        }
      });
    }
    return row[k] === v;
  });
}
const pick = (row: Row, select?: Row): Row => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : { ...row });

/** حذفٌ كما في PostgreSQL: التعاقب ثم SetNull، والمفتاح Restrict/NoAction الباقي ⇒ P2003 — ومُطلِق السجلّ قبل أي تغيير */
function deleteRows(model: string, rows: Row[], tx: number | null): number {
  const doomed = new Map<string, Set<Row>>();
  const queue: Array<[string, Row[]]> = [[model, rows]];
  while (queue.length) {
    const [m, rs] = queue.shift()!;
    const set = doomed.get(m) ?? new Set<Row>();
    doomed.set(m, set);
    const fresh = rs.filter((r) => !set.has(r));
    fresh.forEach((r) => set.add(r));
    if (!fresh.length) continue;
    for (const rel of RELS.filter((x) => x.parent === m && x.onDelete === 'Cascade')) {
      const keys = new Set(fresh.map((r) => r[rel.ref]));
      queue.push([rel.child, table(rel.child).filter((c) => keys.has(c[rel.fk]))]);
    }
  }
  if ((doomed.get('CustomerActivity')?.size ?? 0) > 0 && !(tx !== null && purgeAllowed.has(tx))) {
    throw new LogImmutableError('customer_activities is append-only: DELETE is not allowed');
  }
  for (const [m, set] of doomed) {
    for (const rel of RELS.filter((x) => x.parent === m && x.onDelete !== 'Cascade' && x.onDelete !== 'SetNull')) {
      const keys = new Set([...set].map((r) => r[rel.ref]));
      const gone = doomed.get(rel.child);
      if (table(rel.child).some((c) => c[rel.fk] != null && keys.has(c[rel.fk]) && !gone?.has(c))) {
        throw new FkError(`P2003: ${rel.child}.${rel.fk} → ${m} (${rel.onDelete}) still referenced`);
      }
    }
  }
  for (const [m, set] of doomed) tables.set(m, table(m).filter((r) => !set.has(r)));
  for (const [m, set] of doomed) {
    for (const rel of RELS.filter((x) => x.parent === m && x.onDelete === 'SetNull')) {
      const keys = new Set([...set].map((r) => r[rel.ref]));
      for (const c of table(rel.child)) if (c[rel.fk] != null && keys.has(c[rel.fk])) c[rel.fk] = null;
    }
  }
  return rows.length;
}

function delegate(name: string, tx: number | null): Row {
  const model = modelOfDelegate.get(name);
  if (!model) throw new Error(`fake: unknown delegate ${name}`);
  const log = (method: string, args: unknown): void => {
    ops.push({ op: `${name}.${method}`, tx, args });
    if (failOn === `${name}.${method}`) { failOn = null; throw new FkError(`P2003: injected failure on ${name}.${method}`); }
  };
  const immutable = (): void => { if (model === 'CustomerActivity') throw new LogImmutableError('customer_activities is append-only: UPDATE is not allowed'); };
  const rows = (where?: Row): Row[] => table(model).filter((r) => match(r, where));
  return {
    findMany: async (a: Row = {}) => { log('findMany', a); return rows(a.where).map((r) => pick(r, a.select)); },
    findFirst: async (a: Row = {}) => { log('findFirst', a); const r = rows(a.where)[0]; return r ? pick(r, a.select) : null; },
    findUnique: async (a: Row = {}) => { log('findUnique', a); const r = rows(a.where)[0]; return r ? pick(r, a.select) : null; },
    count: async (a: Row = {}) => { log('count', a); return rows(a.where).length; },
    create: async (a: Row) => { log('create', a); const r = { id: `${name}-${++autoId}`, ...a.data }; table(model).push(r); return pick(r, a.select); },
    createMany: async (a: Row) => {
      log('createMany', a);
      const list = (Array.isArray(a.data) ? a.data : [a.data]) as Row[];
      for (const d of list) table(model).push({ id: `${name}-${++autoId}`, ...d });
      return { count: list.length };
    },
    update: async (a: Row) => {
      log('update', a); immutable();
      const r = rows(a.where)[0];
      if (!r) throw Object.assign(new Error(`fake: ${name}.update — not found`), { code: 'P2025' });
      Object.assign(r, a.data);
      return pick(r, a.select);
    },
    updateMany: async (a: Row) => { log('updateMany', a); immutable(); const rs = rows(a.where); rs.forEach((r) => Object.assign(r, a.data)); return { count: rs.length }; },
    deleteMany: async (a: Row = {}) => { log('deleteMany', a); return { count: deleteRows(model, rows(a.where), tx) }; },
  };
}

const PURGE_SQL = /set_config\('fs\.activity_purge', 'on', true\)/;

function client(tx: number | null): Row {
  return new Proxy({}, {
    get: (_t, key: string) => {
      if (key === 'then') return undefined;
      if (key === '$transaction') {
        return async (arg: unknown) => {
          if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
          if (tx !== null) return (arg as (t: Row) => Promise<unknown>)(client(tx)); // لا معاملة متداخلة في Prisma
          const id = ++txSeq;
          const snapshot = new Map([...tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
          ops.push({ op: '$begin', tx: id });
          try {
            const out = await (arg as (t: Row) => Promise<unknown>)(client(id));
            if (failCommits > 0) { failCommits--; throw Object.assign(new Error('simulated COMMIT failure'), { code: 'P2034' }); }
            ops.push({ op: '$commit', tx: id });
            return out;
          } catch (e) {
            tables = snapshot;
            ops.push({ op: '$rollback', tx: id });
            throw e;
          } finally {
            purgeAllowed.delete(id);
          }
        };
      }
      if (key === '$queryRaw' || key === '$executeRaw') {
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = Array.from(strings).join('?').replace(/\s+/g, ' ');
          ops.push({ op: key, tx, sql, args: values });
          // set_config(..., true) محليٌّ للمعاملة: خارجها لا أثر له
          if (PURGE_SQL.test(sql) && tx !== null) purgeAllowed.add(tx);
          if (/FROM customers WHERE id = \?/.test(sql)) {
            return table('Customer').filter((c) => c.id === values[0] && (values.length < 2 || c.tenantId === values[1])).map((c) => ({ id: c.id }));
          }
          return key === '$queryRaw' ? [] : 0;
        };
      }
      return delegate(key, tx);
    },
  });
}
const db = client(null);

// ═══ الحقن قبل تحميل المسارات — المحرّك (services/ownerPurge.ts) حقيقيّ غير مزيّف ═══

const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: db });
const realAuth = require('../middleware/auth') as Row;
stub('middleware/auth', {
  ...realAuth,
  authenticate: pass, requireAdmin: pass, requireAdminPermission: () => pass, requireAccounting: pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});
const customersRouter = SKIP ? null : require('../routes/customers').default;
const ownerPurgeRouter = SKIP ? null : require('../routes/ownerPurge').default;
const importRouter = SKIP ? null : require('../routes/import').default;
const guard = require('../services/customerActivityGuard') as typeof import('../services/customerActivityGuard');
const { IMPORT_BATCH_DONE, FK_BLOCK_REASON } = require('../services/importLedger') as typeof import('../services/importLedger');

/** يشغّل مكدّس المسار نفسه (حرّاس الموجّه العامة خارج الاختبار — الهويّة في req.user) */
async function call(router: unknown, method: string, p: string, req: Row): Promise<{ status: number; body: any }> {
  const layer = (router as { stack: any[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} مفقود`);
  const res: any = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  const full = { method: method.toUpperCase(), query: {}, params: {}, body: {}, headers: {}, ip: '127.0.0.1', ...req };
  for (const h of layer.route.stack as any[]) {
    let passed = false;
    let err: unknown;
    await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) throw err;
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const e = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = e; }
}

// ═══ العالم ═══

const T = 'T1';
const T2 = 'T2';
const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: T, name: 'سارة' };
const OWNER_SESSION = { id: 'ADM', role: 'ADMIN', tenantId: T, name: 'مدير الشركة', impersonated: true, by: 'owner-1', byKind: 'OWNER' };

const customer = (id: string, tenantId = T): Row => ({ id, tenantId, name: `عميل ${id}`, number: Number(id.replace(/\D/g, '')) || 1, code: `K-${id}`, status: 'ACTIVE', balance: 0 });
const log = (id: string, customerId: string, tenantId = T): Row => ({
  id, tenantId, customerId, at: new Date('2026-11-26T10:00:00Z'), action: 'CUSTOMER_UPDATED', actorKind: 'ADMIN', refType: 'CUSTOMER', refId: customerId,
});
/**
 * أسطر السجلّ: لـc1 سطران، ولـc2 وc3 سطرٌ لكلٍّ، وسطرٌ في شركةٍ أخرى (T2، وعميلها d1) يحمل customerId نفسه c1 — السجلّ بلا مفتاح
 * أجنبي، فالحذف مقصورٌ على شركة العميل المحذوف أيضاً لا على معرّفه وحده
 */
const LOGS = (): Row[] => [log('a1', 'c1'), log('a2', 'c1'), log('a3', 'c2'), log('a4', 'c3'), log('x1', 'c1', T2)];
const logIds = (): string[] => table('CustomerActivity').map((r) => r.id).sort();
const customerIds = (): string[] => table('Customer').map((r) => `${r.tenantId}/${r.id}`).sort();

/** إذن المعاملة ثم حذف السجلّ، في معاملة حذف العميل نفسها — ويعيد معرّف المعاملة */
function assertLogPurgedInDeletionTx(where: Row): number {
  const dels = ops.filter((o) => o.op === 'customerActivity.deleteMany');
  assert.equal(dels.length, 1, 'حذفٌ واحد للسجلّ');
  const del = ops.indexOf(dels[0]);
  const tx = dels[0].tx;
  assert.ok(tx !== null, 'حذف السجلّ داخل معاملة');
  const flag = ops.findIndex((o) => o.op === '$queryRaw' && o.tx === tx && PURGE_SQL.test(o.sql ?? ''));
  assert.ok(flag >= 0 && flag < del, 'إذن المعاملة (set_config المحلي) قبل حذف السجلّ وفي معاملته');
  assert.ok(ops.some((o) => o.op === 'customer.deleteMany' && o.tx === tx), 'حذف صفّ العميل في المعاملة نفسها');
  assert.deepEqual(dels[0].args, { where }, 'الحذف مقصورٌ على العميل المحذوف في شركته');
  assert.equal(ops.filter((o) => PURGE_SQL.test(o.sql ?? '')).length, 1, 'لا إذن في غير معاملة حذف العميل');
  return tx!;
}
const noDeletedEvent = (): void => {
  const written = ops.filter((o) => o.op === 'customerActivity.createMany').flatMap((o) => (Array.isArray(o.args.data) ? o.args.data : [o.args.data]));
  assert.deepEqual(written.filter((r: Row) => r.action === 'CUSTOMER_DELETED'), [], 'لا حدث CUSTOMER_DELETED');
};

// ═══ المحاكاة نفسها: المُطلِق يرفض بلا إذن، والإذن يموت بانتهاء المعاملة ═══

test('القاعدة المزيّفة كالمُطلِق: حذف السجلّ بلا إذن المعاملة مرفوض، والتعديل مرفوض دائماً، والإذن لا يعبر معاملته', { skip: SKIP }, async () => {
  seed({ Customer: [customer('c1')], CustomerActivity: LOGS() });
  await assert.rejects(db.customerActivity.deleteMany({ where: { customerId: 'c1' } }), LogImmutableError, 'خارج معاملة');
  await assert.rejects(db.$transaction(async (tx: Row) => tx.customerActivity.deleteMany({ where: { customerId: 'c1' } })), LogImmutableError, 'بلا إذن');
  await assert.rejects(db.$transaction(async (tx: Row) => {
    await guard.allowActivityPurge(tx as never);
    await tx.customerActivity.updateMany({ where: { customerId: 'c1' }, data: { action: 'OTHER' } });
  }), LogImmutableError, 'لا تعديل ولو بالإذن');
  await guard.allowActivityPurge(db as never); // خارج معاملة: set_config المحلي لا أثر له
  await assert.rejects(db.$transaction(async (tx: Row) => tx.customerActivity.deleteMany({ where: { customerId: 'c1' } })), LogImmutableError, 'الإذن لا يعبر معاملته');
  assert.deepEqual(logIds(), ['a1', 'a2', 'a3', 'a4', 'x1']);
});

// ═══ ١) حذف المدير للعميل: DELETE /customers/:id ═══

test('DELETE /customers/:id: سجلّ العميل يُحذف معه بالمحرّك في معاملة الحذف (الإذن قبل الحذف) — وسجلّ غيره باقٍ، ولا حدث حذف', { skip: SKIP }, async () => {
  seed({ Customer: [customer('c1'), customer('c2'), customer('c3'), customer('d1', T2)], CustomerActivity: LOGS() });
  const r = await call(customersRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'c1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(customerIds(), ['T1/c2', 'T1/c3', 'T2/d1']);
  assert.deepEqual(logIds(), ['a3', 'a4', 'x1'], 'أسطر c1 في شركته وحدها حُذفت');
  const tx = assertLogPurgedInDeletionTx({ tenantId: T, customerId: { in: ['c1'] } });
  assert.ok(ops.some((o) => o.op === '$commit' && o.tx === tx), 'والتزمت');
  noDeletedEvent();
});

test('DELETE /customers/:id: الحذف الفاشل لا يمسّ السجلّ — رميٌ في منتصف المعاملة، وفشل الالتزام بعد حذفه، والرفض لمستنداته', { skip: SKIP }, async () => {
  // رميٌ عند حذف صفّ العميل (قبل حذف السجلّ): لا شيء يُحذف
  seed({ Customer: [customer('c1'), customer('c2')], CustomerActivity: LOGS() });
  failOn = 'customer.deleteMany';
  await assert.rejects(call(customersRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'c1' } }), FkError);
  assert.deepEqual(customerIds(), ['T1/c1', 'T1/c2']);
  assert.deepEqual(logIds(), ['a1', 'a2', 'a3', 'a4', 'x1']);

  // فشل الالتزام بعد أن حذف المحرّك السجلّ بإذنه: التراجع يعيد كل شيء
  seed({ Customer: [customer('c1'), customer('c2')], CustomerActivity: LOGS() });
  failCommits = 1;
  await assert.rejects(call(customersRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'c1' } }), /simulated COMMIT failure/);
  const tx = assertLogPurgedInDeletionTx({ tenantId: T, customerId: { in: ['c1'] } });
  assert.ok(ops.some((o) => o.op === '$rollback' && o.tx === tx));
  assert.deepEqual(customerIds(), ['T1/c1', 'T1/c2']);
  assert.deepEqual(logIds(), ['a1', 'a2', 'a3', 'a4', 'x1'], 'السجلّ كما كان');

  // المرفوض لمستنداته (409): لا إذن ولا حذف
  seed({ Customer: [customer('c1')], Invoice: [{ id: 'inv1', tenantId: T, customerId: 'c1', status: 'CONFIRMED', type: 'CASH', total: 10 }], CustomerActivity: LOGS() });
  const r = await call(customersRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'c1' } });
  assert.equal(r.status, 409);
  assert.equal(ops.some((o) => o.op === 'customerActivity.deleteMany' || PURGE_SQL.test(o.sql ?? '')), false);
  assert.deepEqual(logIds(), ['a1', 'a2', 'a3', 'a4', 'x1']);
});

// ═══ ٢) الحذف النهائي لمالك المنصة: POST /owner-purge/delete ═══

test('الحذف النهائي لعملاء (جماعياً مع مستنداتهم): سجلّاتهم تُحذف معهم في معاملة الحذف — وسجلّ غيرهم باقٍ، ولا حدث حذف', { skip: SKIP }, async () => {
  seed({
    Customer: [customer('c1'), customer('c2'), customer('c3'), customer('d1', T2)],
    Invoice: [{ id: 'inv1', tenantId: T, customerId: 'c1', status: 'CONFIRMED', type: 'CREDIT', total: 100 }],
    CustomerActivity: LOGS(),
  });
  const r = await quiet(() => call(ownerPurgeRouter, 'post', '/delete', { user: OWNER_SESSION, body: { model: 'Customer', ids: ['c1', 'c2'] } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(customerIds(), ['T1/c3', 'T2/d1']);
  assert.deepEqual(table('Invoice'), [], 'مستنداته معه');
  assert.deepEqual(logIds(), ['a4', 'x1']);
  const tx = assertLogPurgedInDeletionTx({ tenantId: T, customerId: { in: ['c1', 'c2'] } });
  assert.ok(ops.some((o) => o.op === '$commit' && o.tx === tx));
  assert.equal(ops.some((o) => o.op === 'customerActivity.createMany'), false, 'لا حدث لهم ولا لمستنداتهم');
  noDeletedEvent();
});

test('الحذف النهائي لعميل: فشل الالتزام بعد حذف السجلّ يعيده كاملاً — وحذف غير العميل (زيارة) لا يأذن ولا يحذف من السجلّ', { skip: SKIP }, async () => {
  seed({ Customer: [customer('c1'), customer('c2')], CustomerActivity: LOGS() });
  failCommits = 1;
  await assert.rejects(quiet(() => call(ownerPurgeRouter, 'post', '/delete', { user: OWNER_SESSION, body: { model: 'Customer', ids: ['c1'] } })), /simulated COMMIT failure/);
  assertLogPurgedInDeletionTx({ tenantId: T, customerId: { in: ['c1'] } });
  assert.deepEqual(customerIds(), ['T1/c1', 'T1/c2']);
  assert.deepEqual(logIds(), ['a1', 'a2', 'a3', 'a4', 'x1']);

  // حذف زيارةٍ للعميل: العميل باقٍ فسجلّه باقٍ، ويُلحق به حدث حذف الزيارة كما كان
  seed({
    Customer: [customer('c1')],
    RepVisit: [{ id: 'v1', tenantId: T, customerId: 'c1', salesRepId: 'rep-1', createdAt: new Date('2026-11-20T08:00:00Z') }],
    CustomerActivity: LOGS(),
  });
  const r = await quiet(() => call(ownerPurgeRouter, 'post', '/delete', { user: OWNER_SESSION, body: { model: 'RepVisit', ids: ['v1'] } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(ops.some((o) => o.op === 'customerActivity.deleteMany' || PURGE_SQL.test(o.sql ?? '')), false);
  assert.deepEqual(table('CustomerActivity').filter((x) => x.customerId === 'c1' && x.tenantId === T).map((x) => x.action).sort(), ['CUSTOMER_UPDATED', 'CUSTOMER_UPDATED', 'VISIT_DELETED']);
});

// ═══ ٣) التراجع عن دفعة استيراد العملاء: POST /import/batches/:id/revert ═══

const importWorld = (): Record<string, Row[]> => ({
  Admin: [{ id: 'ADM', tenantId: T, scopeEnabled: false, canManageCustomers: true, canManageProducts: true, canManageVanStock: true }],
  ImportBatch: [{
    id: 'B1', tenantId: T, kind: 'customers', count: 2, recordIds: JSON.stringify(['c1', 'c2']), reverted: false,
    status: IMPORT_BATCH_DONE, heartbeatAt: null, createdAt: new Date('2026-11-01T00:00:00Z'),
  }],
  // c2 له فاتورة فيُمنع حذفه (وسجلّه باقٍ)، وc3 خارج الدفعة
  Customer: [customer('c1'), customer('c2'), customer('c3'), customer('d1', T2)],
  Invoice: [{ id: 'inv2', tenantId: T, customerId: 'c2', status: 'CONFIRMED', type: 'CASH', total: 5 }],
  CustomerActivity: LOGS(),
});

test('التراجع عن استيراد العملاء: سجلّ المحذوف يُحذف معه في معاملته (الإذن ثم السجلّ ثم العميل) — والممنوع وغيره باقيان، ولا حدث حذف', { skip: SKIP }, async () => {
  seed(importWorld());
  const r = await call(importRouter, 'post', '/batches/:id/revert', { user: ADMIN, params: { id: 'B1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.removed, 1);
  assert.deepEqual(r.body.data.blocked.map((b: Row) => b.id), ['c2']);
  assert.deepEqual(customerIds(), ['T1/c2', 'T1/c3', 'T2/d1']);
  assert.deepEqual(logIds(), ['a3', 'a4', 'x1'], 'أسطر c1 في شركته وحدها حُذفت');
  const tx = assertLogPurgedInDeletionTx({ tenantId: T, customerId: 'c1' });
  const del = ops.findIndex((o) => o.op === 'customerActivity.deleteMany');
  assert.ok(del < ops.findIndex((o) => o.op === 'customer.deleteMany' && o.tx === tx), 'السجلّ قبل صفّ العميل');
  assert.ok(ops.some((o) => o.op === '$commit' && o.tx === tx));
  noDeletedEvent();
});

test('التراجع عن استيراد العملاء: فشل حذف العميل بعد حذف سجلّه يتراجع بمعاملته فيبقى السجلّ كاملاً', { skip: SKIP }, async () => {
  seed(importWorld());
  failOn = 'customer.deleteMany';
  const r = await call(importRouter, 'post', '/batches/:id/revert', { user: ADMIN, params: { id: 'B1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.removed, 0);
  assert.deepEqual(r.body.data.blocked.map((b: Row) => [b.id, b.reason]).sort(), [['c1', FK_BLOCK_REASON], ['c2', 'للعميل فواتير']]);
  const tx = assertLogPurgedInDeletionTx({ tenantId: T, customerId: 'c1' });
  assert.ok(ops.some((o) => o.op === '$rollback' && o.tx === tx), 'تراجعت المعاملة');
  assert.deepEqual(customerIds(), ['T1/c1', 'T1/c2', 'T1/c3', 'T2/d1']);
  assert.deepEqual(logIds(), ['a1', 'a2', 'a3', 'a4', 'x1'], 'السجلّ كما كان');
});

// ═══ ٤) حارسٌ ثابت على المصدر ═══

function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['tests', 'scripts', 'node_modules'].includes(e.name)) out.push(...sourceFiles(p)); continue; }
    if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('حارس: كل حذفٍ مباشر لصفّ العميل في المصدر يحذف سجلّه في معاملته — أو هو حذف الشركة كلها، والمحرّك لكل عميلٍ في خطته', () => {
  const direct: string[] = [];
  const deletedEvent: string[] = [];
  for (const f of sourceFiles()) {
    const text = stripComments(fs.readFileSync(f, 'utf8'));
    if (/\.customer\.(delete|deleteMany)\(|\.customer\.(update|updateMany)\(\{[^;]*status:\s*'DELETED'/.test(text)) direct.push(rel(f));
    if (rel(f) !== 'services/customerActivity.ts' && /'CUSTOMER_DELETED'/.test(text)) deletedEvent.push(rel(f));
  }
  assert.deepEqual(direct.sort(), ['routes/import.ts', 'routes/tenants.ts'], 'مسار حذفٍ جديد للعميل — احذف سجلّه في معاملته (قرار المالك ٢٧ نوفمبر)');
  assert.match(stripComments(fs.readFileSync(path.join(SRC, 'routes', 'import.ts'), 'utf8')),
    /await allowActivityPurge\(tx\);\s*await tx\.customerActivity\.deleteMany\(\{ where: \{ tenantId: tid, customerId: cid \} \}\);\s*await tx\.customer\.deleteMany\(\{ where: \{ id: cid, tenantId: tid \} \}\);/);
  // المحرّك: بعد حلقة الحذف، لكل عميلٍ في الخطة — فيشمل حذف المدير (routes/customers.ts) والمالك (routes/ownerPurge.ts) معاً
  const eng = stripComments(fs.readFileSync(path.join(SRC, 'services', 'ownerPurge.ts'), 'utf8'));
  const body = eng.slice(eng.indexOf('export async function purgeInTx('));
  const loop = body.indexOf('for (const m of deletionOrder(plan))');
  const allow = body.indexOf('await allowActivityPurge(tx);');
  const del = body.indexOf("await tx.customerActivity.deleteMany({ where: { tenantId, customerId: { in: goneCustomers } } });");
  assert.ok(loop > 0 && allow > loop && del > allow, 'الإذن ثم حذف سجلّ العملاء المحذوفين بعد حذف صفوفهم');
  assert.match(body, /const goneCustomers = \(keysOf\.get\('Customer'\) \?\? \[\]\)\.map\(\(k\) => String\(k\.id\)\);/);
  assert.match(stripComments(fs.readFileSync(path.join(SRC, 'routes', 'customers.ts'), 'utf8')), /purgeInTx\(tx, tid, 'Customer', \[customer\.id\]\)/);
  // ولا حدث «حذف العميل» يُكتب بعد اليوم (يُحذف مع سجلّه)
  assert.deepEqual(deletedEvent, [], 'CUSTOMER_DELETED يُكتب في مسارٍ ما');
});
