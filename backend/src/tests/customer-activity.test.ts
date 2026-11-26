// «سجلّ العميل» الثابت (طلب المالك ٢٦ نوفمبر ٢٠٢٦): العقد المشترك (services/customerActivity.ts)، وحارس الثبات في القاعدة
// (services/customerActivityGuard.ts)، وقراءة السجلّ بتاريخه المشتقّ (routes/customerActivity.ts)، وحارس التغطية الثابت:
// كل ملفٍّ يكتب جداول العميل يُلحق سطراً بسجلّه — أو يُذكر في قائمة استثناءٍ مسبَّبة.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import {
  ACTION_CATEGORY, ACTIVITY_CATEGORIES, ACTIVITY_DATA_MAX_BYTES, ACTIVITY_STRING_MAX, CREATION_ACTIONS, CUSTOMER_ACTIONS, SYSTEM_ACTOR,
  activityRow, actorFromReq, categoryOfAction, customerDiff, invoiceIssueAction, recordCustomerActivity, sanitizeActivityData,
  sourceFromReq, type ActivityInput,
} from '../services/customerActivity';
import {
  ACTIVITY_GUARD_CHECK_SQL, ACTIVITY_GUARD_FUNCTION_SQL, ACTIVITY_GUARD_TRIGGERS_SQL, allowActivityPurge, ensureCustomerActivityGuard,
} from '../services/customerActivityGuard';
import {
  ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT, HIST_SOURCES, LOG_RANK, decodeActivityCursor, encodeActivityCursor, loadCustomerActivity,
  parseActivityQuery, timeWhere, type ActivityDeps, type ActivityOut,
} from '../routes/customerActivity';
import { inboundOf, targetableModels } from '../services/ownerPurge';
import type { AuthRequest } from '../types';

const SRC = path.join(__dirname, '..');
const ROOT = path.join(SRC, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const D = (s: string) => new Date(s);

// ═══════════════════ ١) العقد: التنظيف والفاعل والفرق ═══════════════════

test('التفاصيل تُنظَّف: undefined والدوالّ تسقط، والنصوص تُقصّ، والصور والأسرار لا تُحفظ، والتاريخ والعشري يُحوَّلان', () => {
  const out = sanitizeActivityData({
    a: undefined, f: () => 1, s: 'x'.repeat(2000), img: 'data:image/jpeg;base64,/9j/AAAA', password: 'p', token: 't', apiKey: 'k',
    nested: { refreshToken: 'r', ok: 1, when: D('2026-11-26T10:00:00Z') }, dec: new Prisma.Decimal('12.50'), n: Number.NaN, b: true,
    list: [1, undefined, 'y'],
  })!;
  assert.equal('a' in out, false);
  assert.equal('f' in out, false);
  assert.equal((out.s as string).length, ACTIVITY_STRING_MAX + 1, 'مقصوص بعلامة');
  assert.equal(out.img, '[omitted]');
  for (const k of ['password', 'token', 'apiKey']) assert.equal(k in out, false, k);
  assert.deepEqual(out.nested, { ok: 1, when: '2026-11-26T10:00:00.000Z' });
  assert.equal(out.dec, 12.5);
  assert.equal(out.n, null);
  assert.equal(out.b, true);
  assert.deepEqual(out.list, [1, null, 'y']);
  // غير الكائن والفارغ ⇒ null
  assert.equal(sanitizeActivityData(null), null);
  assert.equal(sanitizeActivityData('x'), null);
  assert.equal(sanitizeActivityData([1, 2]), null);
  assert.equal(sanitizeActivityData({ u: undefined }), null);
});

test('التفاصيل لا تتجاوز ٨ ك.ب مهما كبرت — تُقصّ تدريجياً ثم تبقى أسماء المفاتيح وحدها', () => {
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 90; i++) big[`k${i}`] = 'ع'.repeat(400);
  const out = sanitizeActivityData(big)!;
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= ACTIVITY_DATA_MAX_BYTES, `${Buffer.byteLength(JSON.stringify(out))}`);
  const huge = { changes: Array.from({ length: 500 }, (_, i) => ({ field: `f${i}`, from: 'x'.repeat(300), to: 'y'.repeat(300) })) };
  const o2 = sanitizeActivityData(huge)!;
  assert.ok(Buffer.byteLength(JSON.stringify(o2)) <= ACTIVITY_DATA_MAX_BYTES);
});

test('صفّ الإدراج: الناقص يسقط، والإجراء المجهول «أخرى» باسمه، والفاعل المجهول «النظام»، والمبلغ عشريّ صالح أو لا شيء', () => {
  const base = { tenantId: 't1', customerId: 'c1', action: 'INVOICE_ISSUED', actor: { kind: 'REP', id: 'r1', name: 'أحمد' } } as ActivityInput;
  assert.equal(activityRow({ ...base, tenantId: '' }), null);
  assert.equal(activityRow({ ...base, customerId: undefined as unknown as string }), null);
  const unknown = activityRow({ ...base, action: 'SOMETHING_NEW' as never, actor: { kind: 'HACKER' as never, id: null, name: null } })!;
  assert.equal(unknown.action, 'OTHER');
  assert.deepEqual(unknown.data, { action: 'SOMETHING_NEW' });
  assert.equal(unknown.actorKind, 'SYSTEM');
  const r = activityRow({ ...base, amount: '12.345', refType: 'INVOICE', refId: 'i1', refNo: 'INV-1', source: 'rep', at: D('2026-11-26T09:00:00Z') })!;
  assert.ok(r.amount instanceof Prisma.Decimal);
  assert.equal(String(r.amount), '12.345');
  assert.deepEqual([r.refType, r.refId, r.refNo, r.source, r.actorName], ['INVOICE', 'i1', 'INV-1', 'rep', 'أحمد']);
  assert.equal((r.at as Date).toISOString(), '2026-11-26T09:00:00.000Z');
  const noAmt = activityRow({ ...base, amount: Number.NaN, refType: 'NOPE' as never, at: D('bad') })!;
  assert.equal('amount' in noAmt, false);
  assert.equal(noAmt.refType, null);
  assert.equal('at' in noAmt, false, 'اللحظة الافتراضية من القاعدة');
  assert.equal('data' in noAmt, false, 'لا Json null');
});

test('recordCustomerActivity: دفعة واحدة createMany، والفارغ والناقص بلا كتابة، ولا يرمي لشكل المُدخل — وخطأ القاعدة يصعد', async () => {
  const calls: unknown[][] = [];
  const db = { customerActivity: { createMany: async (a: { data: unknown[] }) => { calls.push(a.data); return { count: a.data.length }; } } };
  const ok = { tenantId: 't1', customerId: 'c1', action: 'RECEIPT_ISSUED', actor: SYSTEM_ACTOR } as ActivityInput;
  await recordCustomerActivity(db, [ok, { ...ok, customerId: '' }, null as never, { ...ok, action: 'VISIT_RECORDED' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
  await recordCustomerActivity(db, []);
  await recordCustomerActivity(db, { ...ok, tenantId: '' });
  await recordCustomerActivity(db, undefined as never);
  assert.equal(calls.length, 1, 'لا كتابة للفارغ');
  const failing = { customerActivity: { createMany: async () => { throw new Error('db down'); } } };
  await assert.rejects(recordCustomerActivity(failing, ok), /db down/);
});

test('actorFromReq: المندوب والمستخدم وجلسة المالك (بلا اسم المدير) وموظف المنصة والمفتاح البرمجي — ولا يرمي', () => {
  const rq = (user: Record<string, unknown> | undefined) => ({ user } as unknown as AuthRequest);
  assert.deepEqual(actorFromReq(rq({ id: 'r1', role: 'SALES_REP', name: 'أحمد', tenantId: 't1' })), { kind: 'REP', id: 'r1', name: 'أحمد' });
  assert.deepEqual(actorFromReq(rq({ id: 'a1', role: 'MANAGER', name: 'سارة', tenantId: 't1' })), { kind: 'ADMIN', id: 'a1', name: 'سارة' });
  assert.deepEqual(
    actorFromReq(rq({ id: 'a1', role: 'ADMIN', name: 'مدير الشركة', tenantId: 't1', impersonated: true, by: 'o1', byKind: 'OWNER' })),
    { kind: 'OWNER', id: 'o1', name: null }, 'جلسة المالك لا تُنسب لمدير الشركة',
  );
  assert.deepEqual(
    actorFromReq(rq({ id: 'a1', role: 'ADMIN', name: 'مدير الشركة', tenantId: 't1', impersonated: true, by: 's1', byKind: 'STAFF', byName: 'موظف' })),
    { kind: 'STAFF', id: 's1', name: 'موظف' },
  );
  assert.deepEqual(actorFromReq(rq({ id: 'a1', role: 'ADMIN', name: 'صاحب المفتاح', tenantId: 't1', apiKeyId: 'k1' })), { kind: 'API', id: 'k1', name: null });
  assert.deepEqual(actorFromReq(rq({ id: 'a1', role: 'ADMIN', name: 'x', apiKeyId: 'k1', apiKeyName: 'ERP' })).name, 'ERP');
  assert.deepEqual(actorFromReq(rq(undefined)), SYSTEM_ACTOR);
  assert.deepEqual(actorFromReq(null), SYSTEM_ACTOR);
  const evil = { get user() { throw new Error('boom'); } } as unknown as AuthRequest;
  assert.deepEqual(actorFromReq(evil), SYSTEM_ACTOR);
});

test('sourceFromReq: المفتاح api، والمندوب rep، وتطبيق الجوال m بالترويسة أو المُحيل، وما سواه web', () => {
  const rq = (user: Record<string, unknown> | undefined, headers: Record<string, unknown> = {}) => ({ user, headers } as unknown as AuthRequest);
  assert.equal(sourceFromReq(rq({ role: 'ADMIN', apiKeyId: 'k' })), 'api');
  assert.equal(sourceFromReq(rq({ role: 'SALES_REP' })), 'rep');
  assert.equal(sourceFromReq(rq({ role: 'ADMIN' }, { referer: 'https://fieldsa.net/m/customers' })), 'm');
  assert.equal(sourceFromReq(rq({ role: 'ADMIN' }, { referer: 'https://fieldsa.net/m' })), 'm');
  assert.equal(sourceFromReq(rq({ role: 'ADMIN' }, { 'x-fs-client': 'm' })), 'm');
  assert.equal(sourceFromReq(rq({ role: 'ADMIN' }, { referer: 'https://fieldsa.net/app/customers' })), 'web');
  assert.equal(sourceFromReq(rq({ role: 'ADMIN' }, { referer: 'https://fieldsa.net/marketing' })), 'web');
  assert.equal(sourceFromReq(null), 'web');
});

test('customerDiff: الحقول المتتبَّعة وحدها — لا الرصيد ولا العدّادات ولا الطوابع، والفارغ كـnull، والموقع حقلٌ واحد', () => {
  const before = { name: 'محل', phone: '', creditLimit: 100, balance: 5, totalSales: 9, updatedAt: D('2026-01-01'), lat: 24.1, lng: 46.2, city: 'الرياض' };
  const after = { name: 'محل النور', phone: null, creditLimit: '100', balance: 999, totalSales: 1, updatedAt: D('2026-11-26'), lat: 24.5 };
  const d = customerDiff(before, after);
  assert.deepEqual(d, [
    { field: 'name', from: 'محل', to: 'محل النور' },
    { field: 'location', from: { lat: 24.1, lng: 46.2 }, to: { lat: 24.5, lng: 46.2 } },
  ]);
  assert.deepEqual(customerDiff(before, { balance: 0, totalCollected: 3, createdAt: D('2020-01-01') }), [], 'الرصيد والعدّادات لا تُسجَّل');
  assert.deepEqual(customerDiff(before, {}), [], 'تعديلٌ جزئيّ بلا حقول');
  assert.deepEqual(customerDiff(before, { city: 'جدة', status: 'INACTIVE' }).map((x) => x.field), ['city', 'status']);
  assert.deepEqual(customerDiff({ lat: null, lng: null }, { lat: 1, lng: 2 }), [{ field: 'location', from: null, to: { lat: 1, lng: 2 } }]);
});

test('الإجراءات: لكل إجراءٍ قسم، وإجراءات الميلاد منها، ونوع الإصدار من نوع المستند', () => {
  assert.deepEqual(Object.keys(ACTION_CATEGORY).sort(), [...CUSTOMER_ACTIONS].sort());
  for (const a of CUSTOMER_ACTIONS) assert.ok((ACTIVITY_CATEGORIES as readonly string[]).includes(categoryOfAction(a)), a);
  for (const a of CREATION_ACTIONS) assert.ok((CUSTOMER_ACTIONS as readonly string[]).includes(a), a);
  assert.equal(categoryOfAction('NOPE'), 'other');
  assert.equal(invoiceIssueAction({ type: 'CREDIT', documentKind: null }), 'INVOICE_ISSUED');
  assert.equal(invoiceIssueAction({ type: 'RETURN', documentKind: null }), 'RETURN_ISSUED');
  assert.equal(invoiceIssueAction({ type: 'RETURN', documentKind: 'CREDIT_NOTE' }), 'CREDIT_NOTE_ISSUED');
  assert.equal(invoiceIssueAction({ type: 'CREDIT', documentKind: 'DEBIT_NOTE' }), 'DEBIT_NOTE_ISSUED');
  assert.equal(categoryOfAction('RETURN_ISSUED'), 'returns');
  assert.equal(categoryOfAction('CREDIT_NOTE_ISSUED'), 'returns');
});

test('الواجهة مرآة الخادم: قائمة الإجراءات والأقسام نفسها في web-admin/src/lib/customerActivity.ts', () => {
  const p = path.join(ROOT, 'web-admin', 'src', 'lib', 'customerActivity.ts');
  if (!fs.existsSync(p)) return; // تُكتب الواجهة في وحدةٍ أخرى — المرآة تُفحص متى وُجدت
  const web = fs.readFileSync(p, 'utf8');
  const list = (name: string) => {
    const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(web);
    assert.ok(m, name);
    return [...m![1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual(list('CUSTOMER_ACTIONS'), [...CUSTOMER_ACTIONS]);
  assert.deepEqual(list('ACTIVITY_CATEGORIES'), [...ACTIVITY_CATEGORIES]);
});

// ═══════════════════ ٢) الثبات في القاعدة ═══════════════════

test('المُطلِق: التعديل مرفوضٌ دائماً، والحذف بإذن المعاملة وحده، والتفريغ مرفوض — والتثبيت آمنٌ للتكرار بلا لحظة غياب', () => {
  const fn = ACTIVITY_GUARD_FUNCTION_SQL;
  assert.match(fn, /CREATE OR REPLACE FUNCTION fs_customer_activity_immutable\(\) RETURNS trigger/);
  assert.match(fn, /IF TG_OP = 'DELETE' AND coalesce\(current_setting\('fs\.activity_purge', true\), ''\) = 'on' THEN\s+RETURN OLD;/);
  assert.match(fn, /RAISE EXCEPTION 'customer_activities is append-only/);
  assert.doesNotMatch(fn, /TG_OP = 'UPDATE'[\s\S]*RETURN NEW/, 'لا إذن بالتعديل أبداً');
  const trg = ACTIVITY_GUARD_TRIGGERS_SQL;
  assert.match(trg, /BEFORE UPDATE OR DELETE ON customer_activities FOR EACH ROW EXECUTE FUNCTION fs_customer_activity_immutable\(\)/);
  assert.match(trg, /BEFORE TRUNCATE ON customer_activities FOR EACH STATEMENT EXECUTE FUNCTION fs_customer_activity_immutable\(\)/);
  assert.match(trg, /to_regclass\('customer_activities'\)/, 'الجدول الغائب لا يُفشل الإقلاع');
  assert.match(trg, /st NOT IN \('O', 'A'\)/, 'المعطَّل يُعاد');
  assert.doesNotMatch(trg, /DROP TRIGGER IF EXISTS/, 'لا حذف لمُطلِقٍ نافذ قبل إعادته');
  assert.match(ACTIVITY_GUARD_CHECK_SQL, /tgenabled IN \('O', 'A'\)/);
});

test('ensureCustomerActivityGuard: الدالّة ثم المُطلِقان ثم الفحص — true بمُطلِقين نافذين، وfalse بلا رمي عند الفشل', async () => {
  const sqls: string[] = [];
  const db = (n: number, fail = false) => ({
    $executeRawUnsafe: async (sql: string) => { sqls.push(sql); if (fail) throw new Error('permission denied'); return 0; },
    $queryRawUnsafe: async <T>(sql: string) => { sqls.push(sql); return [{ n }] as T; },
  });
  assert.equal(await ensureCustomerActivityGuard(db(2)), true);
  assert.deepEqual(sqls, [ACTIVITY_GUARD_FUNCTION_SQL, ACTIVITY_GUARD_TRIGGERS_SQL, ACTIVITY_GUARD_CHECK_SQL]);
  assert.equal(await ensureCustomerActivityGuard(db(1)), false);
  const errLog = console.error;
  console.error = () => {};
  try {
    assert.equal(await ensureCustomerActivityGuard(db(2, true)), false);
  } finally { console.error = errLog; }
});

/**
 * حذف أسطر السجلّ (إذن المعاملة allowActivityPurge، وcustomerActivity.deleteMany) مسموحٌ في هذه الملفّات وحدها، كلٌّ بسببه:
 * مسارات حذف العميل (قرار المالك ٢٧ نوفمبر ٢٠٢٦: «بعد حذف العميل يحذف سجله معه») وحذف الشركة كلها
 */
const ACTIVITY_PURGE_FILES: Record<string, string> = {
  'routes/import.ts': 'owner decision 27 Nov: customer deletion deletes its log',
  'services/ownerPurge.ts': 'owner decision 27 Nov: customer deletion deletes its log',
  'routes/tenants.ts': 'حذف الشركة كلها (تعاقب صفّ الشركة يحذف السجلّ بإذن المعاملة)',
};

test('allowActivityPurge: إذنٌ محليٌّ للمعاملة (set_config … true) — ويُمنح في حذف الشركة (قبل حذف صفّها داخل معاملته) وحذف العميل وحدهما', async () => {
  const seen: string[] = [];
  await allowActivityPurge({ $queryRaw: async (s: TemplateStringsArray) => { seen.push(s.join('?')); return []; } });
  assert.deepEqual(seen, ["SELECT set_config('fs.activity_purge', 'on', true)"]);

  const tenants = read('routes', 'tenants.ts');
  const del = tenants.slice(tenants.indexOf("router.delete('/:id'"));
  const tx = del.indexOf('await prisma.$transaction(async (tx) => {');
  const allow = del.indexOf('await allowActivityPurge(tx);');
  const drop = del.indexOf('await tx.tenant.delete({ where: { id: tid } });');
  assert.ok(tx > 0 && allow > tx && drop > allow, 'الإذن داخل معاملة الحذف وقبل حذف صفّ الشركة');
  // لا موضع آخر يأذن بحذف السجلّ
  const grants = sourceFiles().filter((f) => /allowActivityPurge\(/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map(rel).filter((f) => !['services/customerActivityGuard.ts'].includes(f));
  assert.deepEqual(grants.sort(), Object.keys(ACTIVITY_PURGE_FILES).sort());
});

test('التثبيت في النشر (بعد db push) وعند الإقلاع (بلا انتظار)، والمخطّط: جدولٌ جديد بلا علاقة بالعميل ولا قيد فريد', () => {
  const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  const pre = /preDeployCommand: (.+)/.exec(render)![1];
  assert.ok(pre.indexOf('npx prisma db push') === 0 && pre.indexOf('node dist/scripts/ensureCustomerActivityGuard.js') > 0, pre);
  assert.ok(fs.existsSync(path.join(SRC, 'scripts', 'ensureCustomerActivityGuard.ts')));
  const idx = read('index.ts');
  assert.match(idx, /void ensureCustomerActivityGuard\(prisma\);/);
  assert.ok(idx.indexOf('void ensureCustomerActivityGuard(prisma);') > idx.indexOf('server.listen(PORT'));
  const mountA = idx.indexOf("app.use('/api/customers', customerActivityRouter);");
  const mountC = idx.indexOf("app.use('/api/customers', customersRouter);");
  assert.ok(mountA > 0 && mountC > mountA, 'السجلّ قبل موجّه العملاء');

  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  const start = schema.indexOf('model CustomerActivity {');
  const body = schema.slice(start, schema.indexOf('\n}', start));
  assert.match(body, /tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/);
  assert.doesNotMatch(body, /Customer\s+@relation/, 'لا علاقة بالعميل: سجلّه يُحذف صراحةً في معاملة حذفه (قرار المالك ٢٧ نوفمبر)');
  assert.doesNotMatch(body, /@@unique|@unique/);
  assert.match(body, /amount\s+Decimal\? @db\.Decimal\(18, 4\)/);
  assert.match(body, /@@index\(\[tenantId, customerId, at\]\)/);
  assert.match(body, /@@index\(\[tenantId, refType, refId\]\)/);
  assert.match(body, /@@map\("customer_activities"\)/);
  assert.match(schema, /customerActivities\s+CustomerActivity\[\]/);
  // «الحذف النهائي» لا يستهدفه — ولا علاقة واردة إليه فلا يمسّه حذفُ غيره (والعميل المُولَّد يعرفه بعد prisma generate)
  assert.match(read('services', 'ownerPurge.ts'), /'CustomerActivity',\n\]\);/);
  if (Prisma.dmmf.datamodel.models.some((m) => m.name === 'CustomerActivity')) {
    assert.ok(!targetableModels().includes('CustomerActivity'));
    assert.deepEqual(inboundOf('CustomerActivity'), []);
  }
});

// ═══════════════════ ٣) القراءة بقاعدةٍ في الذاكرة ═══════════════════

type Row = Record<string, any>;
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
const val = (v: unknown) => (v instanceof Date ? v.getTime() : v);
const eq = (a: unknown, b: unknown) => val(a) === val(b) || (a == null && b == null);
const lt = (a: unknown, b: unknown) => a != null && b != null && (val(a) as number) < (val(b) as number);

function matchOps(v: unknown, ops: Record<string, unknown>): boolean {
  for (const [op, x] of Object.entries(ops)) {
    if (op === 'in') { if (!(x as unknown[]).some((y) => eq(v, y))) return false; }
    else if (op === 'not') { if (x === null ? v == null : (v == null || eq(v, x))) return false; }
    else if (op === 'lt') { if (!lt(v, x)) return false; }
    else if (op === 'lte') { if (!(lt(v, x) || eq(v, x))) return false; }
    else if (op === 'gt') { if (!lt(x, v)) return false; }
    else if (op === 'some') { if (!((v as Row[] | undefined) ?? []).some((r) => matchWhere(r, x as Row))) return false; }
    else throw new Error(`op ${op}`);
  }
  return true;
}
function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, w] of Object.entries(where)) {
    if (k === 'AND') { if (!(w as Row[]).every((x) => matchWhere(row, x))) return false; continue; }
    if (k === 'OR') { if (!(w as Row[]).some((x) => matchWhere(row, x))) return false; continue; }
    if (isPlain(w)) { if (!matchOps(row[k], w)) return false; continue; }
    if (!eq(row[k], w)) return false;
  }
  return true;
}
function sortRows(rows: Row[], orderBy: Row[] | Row | undefined): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => Object.entries(o)[0] as [string, string]);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = val(a[k]) as number | string; const y = val(b[k]) as number | string;
      if (x === y) continue;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
function memDb(tables: Record<string, Row[]>) {
  const queries: { model: string; args: Row }[] = [];
  const db = new Proxy({}, {
    get(_t, model: string) {
      const rows = () => tables[model] ?? [];
      return {
        findMany: async (args: Row = {}) => {
          queries.push({ model, args });
          const hit = sortRows(rows().filter((r) => matchWhere(r, args.where)), args.orderBy);
          return args.take ? hit.slice(0, args.take) : hit;
        },
        findFirst: async (args: Row = {}) => { queries.push({ model, args }); return rows().find((r) => matchWhere(r, args.where)) ?? null; },
      };
    },
  });
  return { db: db as ActivityDeps['db'], queries };
}

const T = 't1';
const rep = (id = 'r1', name = 'أحمد') => ({ user: { id, role: 'SALES_REP', name, tenantId: T } } as unknown as AuthRequest);
const admin = (extra: Record<string, unknown> = {}) => ({ user: { id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T, ...extra } } as unknown as AuthRequest);
const noScope: ActivityDeps['customerScope'] = async () => ({});

const customer = { id: 'c1', tenantId: T, name: 'محل النور', phone: '0501234567', number: 7, createdAt: D('2026-01-01T08:00:00Z'), assignments: [{ salesRepId: 'r1' }] };
const inv = (id: string, at: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', number: `INV-${id}`, type: 'CREDIT', status: 'CONFIRMED', documentKind: null, invoiceDate: D(at),
  total: 100, taxAmt: 15, paidAmt: 0, remainingAmt: 100, salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { items: 2 }, ...extra,
});
const log = (id: string, at: string, action: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', at: D(at), action, actorKind: 'ADMIN', actorId: 'a1', actorName: 'سارة', refType: null, refId: null,
  refNo: null, amount: null, data: null, ...extra,
});

async function page(deps: ActivityDeps, req: AuthRequest, q: Record<string, unknown> = {}, id = 'c1') {
  return loadCustomerActivity(deps, req, T, id, parseActivityQuery(q));
}
/** كل الصفحات حتى النهاية — بلا تكرار ولا ضياع */
async function allPages(deps: ActivityDeps, req: AuthRequest, limit: number, category?: string): Promise<ActivityOut[]> {
  const out: ActivityOut[] = [];
  let before: string | undefined;
  for (let i = 0; i < 200; i++) {
    const p = (await page(deps, req, { limit, before, category }))!;
    out.push(...p.items);
    if (!p.nextBefore) return out;
    assert.notEqual(p.nextBefore, before, 'المؤشّر يتقدّم');
    before = p.nextBefore;
  }
  throw new Error('لا نهاية للصفحات');
}

test('المعاملات: limit بين ١ و٣٠٠ (الافتراضي ٢٠٠)، والقسم المجهول «الكل»، والمؤشّر مركّبٌ أو لحظة', () => {
  assert.equal(parseActivityQuery({}).limit, ACTIVITY_DEFAULT_LIMIT);
  assert.equal(parseActivityQuery({ limit: '9999' }).limit, ACTIVITY_MAX_LIMIT);
  assert.equal(parseActivityQuery({ limit: '0' }).limit, ACTIVITY_DEFAULT_LIMIT);
  assert.equal(parseActivityQuery({ category: 'money' }).category, 'money');
  assert.equal(parseActivityQuery({ category: 'drop table' }).category, 'all');
  const c = { at: D('2026-11-26T10:00:00.123Z'), rank: 55, id: 'abc-1' };
  assert.deepEqual(decodeActivityCursor(encodeActivityCursor(c)), c);
  assert.deepEqual(decodeActivityCursor('2026-11-26T10:00:00Z'), { at: D('2026-11-26T10:00:00Z'), rank: Number.NEGATIVE_INFINITY, id: '' });
  assert.equal(decodeActivityCursor('nonsense'), null);
  assert.equal(decodeActivityCursor(undefined), null);
  // اللحظة وحدها: ما قبلها تماماً لكل مصدر
  assert.deepEqual(timeWhere('at', decodeActivityCursor('2026-11-26T10:00:00Z'), LOG_RANK), { at: { lt: D('2026-11-26T10:00:00Z') } });
  assert.deepEqual(timeWhere('x', c, 55), { OR: [{ x: { lt: c.at } }, { x: c.at, id: { lt: 'abc-1' } }] });
  assert.deepEqual(timeWhere('x', c, 60), { x: { lt: c.at } });
  assert.deepEqual(timeWhere('x', c, 50), { x: { lte: c.at } });
  // رتب المصادر فريدةٌ وتحت رتبة السجلّ
  const ranks = HIST_SOURCES.map((s) => s.rank);
  assert.equal(new Set(ranks).size, ranks.length);
  assert.ok(ranks.every((r) => r < LOG_RANK));
});

test('عزل الشركة والنطاق: عميل شركةٍ أخرى أو خارج نطاق المندوب ⇒ null (٤٠٤)، وكل استعلامٍ بشركة الطالب', async () => {
  const { db, queries } = memDb({
    customer: [customer, { ...customer, id: 'c2', tenantId: 't2' }],
    customerActivity: [log('L1', '2026-11-26T10:00:00Z', 'CUSTOMER_UPDATED'), { ...log('L2', '2026-11-26T11:00:00Z', 'CUSTOMER_UPDATED'), tenantId: 't2' }],
  });
  assert.equal(await page({ db, customerScope: noScope }, admin(), {}, 'c2'), null, 'عميل شركةٍ أخرى');
  // المندوب بعزل العملاء: قيد الإسناد من customerScope
  const scoped: ActivityDeps['customerScope'] = async (req) => ({ assignments: { some: { salesRepId: req.user!.id } } });
  assert.equal(await page({ db, customerScope: scoped }, rep('r2')), null, 'عميلٌ غير مُسنَد للمندوب');
  const p = (await page({ db, customerScope: scoped }, rep('r1')))!;
  assert.ok(p.items.some((x) => x.id === 'L1'));
  assert.ok(!p.items.some((x) => x.id === 'L2'), 'سطر شركةٍ أخرى');
  for (const q of queries) {
    if (q.model === 'customerPrice') { assert.equal(q.args.where.customerId, 'c1'); continue; }
    assert.equal(q.args.where?.tenantId, T, `${q.model} بلا شركة الطالب`);
  }
});

test('التاريخ المشتقّ: الفاتورة التي لها سطر إصدار لا تتكرّر، والقديمة التي أُلغيت بعد بدء السجلّ يبقى إصدارها — والترتيب الأحدث أولاً', async () => {
  const { db } = memDb({
    customer: [customer],
    invoice: [
      inv('i-old', '2026-03-01T09:00:00Z', { status: 'CANCELLED' }),
      inv('i-new', '2026-11-20T09:00:00Z'),
      inv('i-ret', '2026-05-01T09:00:00Z', { type: 'RETURN', total: 30 }),
    ],
    customerActivity: [
      log('L-new', '2026-11-20T09:00:00Z', 'INVOICE_ISSUED', { refType: 'INVOICE', refId: 'i-new', refNo: 'INV-i-new', amount: new Prisma.Decimal(100), actorKind: 'REP', actorId: 'r1', actorName: 'أحمد' }),
      log('L-cancel', '2026-11-25T09:00:00Z', 'INVOICE_CANCELLED', { refType: 'INVOICE', refId: 'i-old', data: { reason: 'خطأ' } }),
    ],
    receipt: [{ id: 'rc1', tenantId: T, customerId: 'c1', number: 'RC-1', amount: 50, paymentMethod: 'CASH', status: 'ACTIVE', receiptDate: D('2026-04-01T10:00:00Z'), salesRepId: null, salesRep: null, _count: { photos: 1 }, invoiceItems: [] }],
  });
  const p = (await page({ db, customerScope: noScope }, admin()))!;
  assert.equal(p.nextBefore, null);
  assert.deepEqual(p.items.map((x) => `${x.action}:${x.refId}:${x.historical}`), [
    'INVOICE_CANCELLED:i-old:false',
    'INVOICE_ISSUED:i-new:false',
    'RETURN_ISSUED:i-ret:true',
    'RECEIPT_ISSUED:rc1:true',
    'INVOICE_ISSUED:i-old:true',
    'CUSTOMER_CREATED:c1:true',
  ]);
  const old = p.items.find((x) => x.refId === 'i-old' && x.historical)!;
  assert.equal(old.data!.cancelled, true);
  assert.equal(old.amount, 100);
  assert.equal(old.refNo, 'INV-i-old');
  // معرّف المنفّذ للمندوب والإداري (ترشيح «من نفّذ» في الأرشيف)، ولا معرّف لمن لم يُعرف
  assert.deepEqual(old.actor, { kind: 'REP', name: 'أحمد', id: 'r1' });
  const fresh = p.items.find((x) => x.id === 'L-new')!;
  assert.equal(fresh.amount, 100);
  assert.equal(fresh.category, 'sales');
  assert.equal(p.items.find((x) => x.refId === 'i-ret')!.category, 'returns');
  const rc = p.items.find((x) => x.refId === 'rc1')!;
  assert.deepEqual(rc.actor, { kind: 'ADMIN', name: null });
  assert.equal(rc.data!.photosCount, 1);
  // القسم: المرتجعات وحدها
  const ret = (await page({ db, customerScope: noScope }, admin(), { category: 'returns' }))!;
  assert.deepEqual(ret.items.map((x) => x.refId), ['i-ret']);
  const money = (await page({ db, customerScope: noScope }, admin(), { category: 'money' }))!;
  assert.deepEqual(money.items.map((x) => x.refId), ['rc1']);
});

test('الترقيم: صفحاتٌ صغيرة تجمع القائمة كاملةً بترتيبها — بلا تكرار ولا ضياع، ومع أسطر تتشارك اللحظة نفسها', async () => {
  const same = '2026-11-26T10:00:00.000Z';
  const invoices = Array.from({ length: 7 }, (_, i) => inv(`i${i}`, i < 3 ? same : `2026-0${i}-15T09:00:00Z`));
  const logs = [
    ...Array.from({ length: 5 }, (_, i) => log(`L${i}`, same, 'CUSTOMER_UPDATED', { refType: 'CUSTOMER', refId: 'c1' })),
    log('L9', '2026-06-01T00:00:00Z', 'CALL_LOGGED'),
  ];
  const docs = Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, tenantId: T, customerId: 'c1', kind: 'CR', sizeBytes: 10, uploadedByKind: 'REP', uploadedById: 'r1', uploadedByName: 'أحمد', createdAt: D(same) }));
  const { db } = memDb({ customer: [customer], invoice: invoices, customerActivity: logs, customerDocument: docs });
  const deps = { db, customerScope: noScope };
  const full = (await page(deps, admin(), { limit: 300 }))!;
  assert.equal(full.nextBefore, null);
  assert.equal(full.items.length, 7 + 6 + 4 + 1);
  for (const limit of [1, 2, 3, 5]) {
    const got = await allPages(deps, admin(), limit);
    assert.deepEqual(got.map((x) => x.id), full.items.map((x) => x.id), `limit ${limit}`);
  }
  // في اللحظة نفسها: أسطر السجلّ أولاً ثم الفواتير ثم الوثائق
  const atSame = full.items.filter((x) => x.at === same).map((x) => x.id[0] === 'L' ? 'L' : x.id.split(':')[1]);
  assert.deepEqual(atSame, ['L', 'L', 'L', 'L', 'L', 'invoice', 'invoice', 'invoice', 'doc', 'doc', 'doc', 'doc']);
});

test('مطابقةٌ تُسقط كل المشتقّ في نافذة: الجولات تتقدّم بالأفق فلا يضيع الأقدم ولا يتكرّر شيء', async () => {
  // عشر فواتير بتاريخٍ قديم (رُفعت دون اتصال) سُجّل إصدارها في نوفمبر — وسند قبضٍ أقدم منها كلها
  const invoices = Array.from({ length: 10 }, (_, i) => inv(`i${i}`, `2025-0${(i % 9) + 1}-10T09:00:00Z`));
  const logs = invoices.map((x, i) => log(`L${i}`, `2026-11-${10 + i}T09:00:00Z`, 'INVOICE_ISSUED', { refType: 'INVOICE', refId: x.id }));
  const receipt = { id: 'rc0', tenantId: T, customerId: 'c1', number: 'RC-0', amount: 5, paymentMethod: 'CASH', status: 'ACTIVE', receiptDate: D('2024-01-01T00:00:00Z'), salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { photos: 0 }, invoiceItems: [] };
  const { db } = memDb({ customer: [{ ...customer, createdAt: D('2023-01-01T00:00:00Z') }], invoice: invoices, customerActivity: logs, receipt: [receipt] });
  const deps = { db, customerScope: noScope };
  for (const limit of [2, 3, 300]) {
    const got = await allPages(deps, admin(), limit);
    assert.equal(got.filter((x) => x.historical && x.refType === 'INVOICE').length, 0, 'لا فاتورة مشتقّة مكرّرة');
    assert.equal(got.filter((x) => x.id.startsWith('L')).length, 10);
    assert.deepEqual(got.slice(-2).map((x) => x.action), ['RECEIPT_ISSUED', 'CUSTOMER_CREATED']);
    assert.equal(new Set(got.map((x) => x.id)).size, got.length);
  }
});

test('ما تُعاد كتابته بلا إجراء (محطّات خطّ السير، طابع السعر الخاص) لا يُشتقّ بعد بدء سجلّ العميل — ولا تتكرّر دفعة الأسعار', async () => {
  const stop = (id: string, at: string) => ({ id, tenantId: T, customerId: 'c1', routeId: `rt-${id}`, seq: 1, createdAt: D(at), route: { name: 'خط الأحد', isActive: true, isPermanent: true, routeDate: null, salesRep: { name: 'أحمد' } } });
  const price = (id: string, at: string) => ({ id, customerId: 'c1', productId: `p-${id}`, price: 3, updatedAt: D(at), product: { name: 'ماء' } });
  const { db } = memDb({
    customer: [customer],
    // بدء السجلّ: أقدم سطرٍ للعميل — ودفعة أسعارٍ متعدّدة الأصناف بلا مرجع صنف
    customerActivity: [
      log('L1', '2026-11-01T09:00:00Z', 'CUSTOMER_UPDATED'),
      log('L2', '2026-11-12T09:00:00Z', 'CUSTOMER_PRICE_SET', { refType: 'PRICE', data: { count: 2, items: [] } }),
    ],
    repRouteStop: [stop('s-old', '2026-10-01T09:00:00Z'), stop('s-resaved', '2026-11-10T09:00:00Z')],
    customerPrice: [price('old', '2026-10-05T09:00:00Z'), price('batch', '2026-11-12T09:00:00Z')],
  });
  const p = (await page({ db, customerScope: noScope }, admin()))!;
  assert.deepEqual(p.items.filter((x) => x.historical && x.refType === 'ROUTE').map((x) => x.refId), ['rt-s-old']);
  assert.deepEqual(p.items.filter((x) => x.historical && x.refType === 'PRICE').map((x) => x.refId), ['p-old']);
  // عميلٌ بلا سطرٍ في السجلّ بعد: تاريخه كله مشتقّ
  const fresh = memDb({ customer: [customer], repRouteStop: [stop('s-resaved', '2026-11-10T09:00:00Z')] });
  const q = (await page({ db: fresh.db, customerScope: noScope }, admin()))!;
  assert.deepEqual(q.items.filter((x) => x.refType === 'ROUTE').map((x) => x.refId), ['rt-s-resaved']);
});

test('البند التاريخي بأسماء حقول السجلّ الحيّ: paymentType للفاتورة وallocations[].invoiceNo للسند', async () => {
  const rc = { id: 'rc1', tenantId: T, customerId: 'c1', number: 'RC-1', amount: 50, paymentMethod: 'CASH', status: 'ACTIVE', receiptDate: D('2026-03-01T00:00:00Z'), salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { photos: 0 }, invoiceItems: [{ amount: 50, invoice: { number: 'INV-i1' } }] };
  const { db } = memDb({ customer: [customer], invoice: [inv('i1', '2026-02-01T00:00:00Z')], receipt: [rc] });
  const p = (await page({ db, customerScope: noScope }, admin()))!;
  const i = p.items.find((x) => x.refId === 'i1')!;
  assert.equal(i.data!.paymentType, 'CREDIT');
  assert.equal('type' in i.data!, false);
  assert.deepEqual(p.items.find((x) => x.refId === 'rc1')!.data!.allocations, [{ invoiceNo: 'INV-i1', amount: 50 }]);
});

test('الزيارة وقفةٌ واحدة: المؤقّت وملاحظته وصورها بندٌ واحد، والسجلّ له سطر ميلاد لا يُشتقّ', async () => {
  const visit = (id: string, extra: Row) => ({ id, tenantId: T, customerId: 'c1', salesRepId: 'r1', salesRep: { name: 'أحمد' }, note: null, durationSec: null, startedAt: null, endedAt: null, lat: null, lng: null, photos: [], ...extra });
  const { db } = memDb({
    customer: [customer],
    repVisit: [
      visit('v-timer', { createdAt: D('2026-10-01T10:30:00Z'), startedAt: D('2026-10-01T10:00:00Z'), endedAt: D('2026-10-01T10:30:00Z'), durationSec: 1800, lat: 24.7, lng: 46.7 }),
      visit('v-note', { createdAt: D('2026-10-01T10:29:00Z'), note: 'الرف ممتلئ', photos: [{ id: 'p1' }, { id: 'p2' }] }),
      visit('v-logged', { createdAt: D('2026-11-01T10:00:00Z'), note: 'مسجّلة' }),
    ],
    customerActivity: [log('LV', '2026-11-01T10:00:00Z', 'VISIT_RECORDED', { refType: 'VISIT', refId: 'v-logged', actorKind: 'REP' })],
  });
  const p = (await page({ db, customerScope: noScope }, rep()))!;
  const visits = p.items.filter((x) => x.category === 'visits');
  assert.deepEqual(visits.map((x) => `${x.id}`), ['LV', 'h:visit:v-timer']);
  const stop = visits[1];
  assert.equal(stop.data!.durationSec, 1800);
  assert.equal(stop.data!.note, 'الرف ممتلئ');
  assert.equal(stop.data!.photosCount, 2);
  assert.deepEqual(stop.data!.photoIds, ['p1', 'p2']);
  assert.equal(stop.historical, true);
});

test('الفاعل: الأسماء الناقصة تُحلّ بشركة الطالب (المستخدم والمندوب ووسم المفتاح)، واسم المالك والموظف للمنصة وحدها', async () => {
  const { db, queries } = memDb({
    customer: [customer],
    customerActivity: [
      log('L1', '2026-11-26T10:00:00Z', 'CUSTOMER_UPDATED', { actorKind: 'API', actorId: 'k1', actorName: null }),
      log('L2', '2026-11-26T09:00:00Z', 'CUSTOMER_UPDATED', { actorKind: 'STAFF', actorId: 's1', actorName: 'موظف الدعم' }),
      log('L3', '2026-11-26T08:00:00Z', 'CUSTOMER_UPDATED', { actorKind: 'ADMIN', actorId: 'a9', actorName: null }),
    ],
    customerPaymentLink: [{ id: 'pl1', tenantId: T, customerId: 'c1', amount: 40, status: 'paid', createdAt: D('2026-02-01T00:00:00Z'), paidAt: D('2026-02-02T00:00:00Z'), expiresAt: D('2026-03-01T00:00:00Z'), salesRepId: null, createdById: 'a9', salesRep: null, invoice: { number: 'INV-9' } }],
    apiKey: [{ id: 'k1', tenantId: T, name: 'ERP' }, { id: 'k1x', tenantId: 't2', name: 'غريب' }],
    admin: [{ id: 'a9', tenantId: T, name: 'خالد' }],
  });
  const p = (await page({ db, customerScope: noScope }, admin()))!;
  const by = (id: string) => p.items.find((x) => x.id === id)!;
  assert.deepEqual(by('L1').actor, { kind: 'API', name: 'ERP' });
  assert.deepEqual(by('L2').actor, { kind: 'STAFF', name: null }, 'اسم الموظف لا يصل الشركة');
  assert.deepEqual(by('L3').actor, { kind: 'ADMIN', name: 'خالد', id: 'a9' });
  assert.deepEqual(p.items.filter((x) => x.refId === 'pl1').map((x) => `${x.action}:${x.actor.kind}:${x.actor.name}`), [
    'PAYLINK_PAID:CUSTOMER:محل النور', 'PAYLINK_CREATED:ADMIN:خالد',
  ]);
  for (const q of queries.filter((x) => ['apiKey', 'admin', 'salesRep'].includes(x.model))) assert.equal(q.args.where.tenantId, T);
  const owner = (await page({ db, customerScope: noScope }, admin({ impersonated: true, by: 'o1', byKind: 'OWNER' })))!;
  assert.deepEqual(owner.items.find((x) => x.id === 'L2')!.actor, { kind: 'STAFF', name: 'موظف الدعم' });
});

test('مسار القراءة: GET وحده بمصادقةٍ وصلاحية العملاء على المسار نفسه — ولا مسار كتابة للسجلّ في أي ملف', () => {
  const route = read('routes', 'customerActivity.ts');
  const handlers = [...route.matchAll(/\br\.(get|post|put|patch|delete|all)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(handlers, ['get /:id/activity']);
  assert.match(route, /r\.get\('\/:id\/activity', authenticate, requireAdminPermission\('canManageCustomers'\), /);
  assert.doesNotMatch(route, /router\.use\(authenticate\)|r\.use\(authenticate\)/, 'لا مصادقة مزدوجة لطلبات العملاء الأخرى');
  assert.match(route, /where: \{ id: customerId, tenantId: tid, \.\.\.scope \}/);

  const offenders: string[] = [];
  for (const f of sourceFiles()) {
    const text = stripComments(fs.readFileSync(f, 'utf8'));
    if (/\bcustomerActivity\.(update|updateMany|upsert|delete)\b/.test(text)) offenders.push(rel(f));
    // حذف أسطر السجلّ في ملفّات حذف العميل وحدها (ACTIVITY_PURGE_FILES — قرار المالك ٢٧ نوفمبر ٢٠٢٦)
    if (/\bcustomerActivity\.deleteMany\b/.test(text) && !ACTIVITY_PURGE_FILES[rel(f)]) offenders.push(`${rel(f)} (deleteMany)`);
    if (/\b(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+"?customer_activities"?/i.test(text)) offenders.push(`${rel(f)} (SQL)`);
  }
  assert.deepEqual(offenders, [], 'السجلّ إلحاقيٌّ فقط');
  // وفي ملفّات حذف العميل: الحذف بعد إذن المعاملة مباشرةً، ومقصورٌ على العميل المحذوف في شركته (لا حذفاً عامّاً)
  for (const f of Object.keys(ACTIVITY_PURGE_FILES).filter((x) => ACTIVITY_PURGE_FILES[x] === 'owner decision 27 Nov: customer deletion deletes its log')) {
    const text = stripComments(read(...f.split('/')));
    const dels = [...text.matchAll(/customerActivity\.deleteMany\(([^\n]*)/g)];
    assert.ok(dels.length > 0, `${f}: لا حذف لسجلّ العميل المحذوف`);
    for (const m of dels) {
      assert.match(m[1], /^\{ where: \{ tenantId[^}]*customerId: /, `${f}: الحذف مقصورٌ على العميل المحذوف في شركته`);
      assert.match(text.slice(Math.max(0, m.index! - 120), m.index!), /await allowActivityPurge\(tx\);\s*await tx\.$/, `${f}: إذن المعاملة قبل الحذف مباشرةً`);
    }
  }
});

// ═══════════════════ ٤) حارس التغطية الثابت ═══════════════════

/** ملفّات المصدر (بلا الاختبارات والسكربتات) */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['tests', 'scripts', 'node_modules'].includes(e.name)) out.push(...sourceFiles(p)); continue; }
    if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
/** بلا التعليقات (والروابط في النصوص لا تُعدّ تعليقاً) */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

// ومعها كشف حساب العميل (accountEntry) وقيود الدفاتر وسطورها (glMove/glMoveLine — السطر يحمل customerId): قيدٌ يدويّ على عميلٍ يُرحَّل
// أو يُعكس إجراءٌ على ذمّته
const TABLES = 'invoice|receipt|repVisit|customer|customerDocument|customerPaymentLink|cardPayment|customerAssignment|customerPrice|customerAdjustment|callLog|repRouteStop|catalogOrder|accountEntry|glMove|glMoveLine';
const WRITE_RE = new RegExp(`\\b(${TABLES})\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(`);

/**
 * دوالّ التسجيل: recordCustomerActivity نفسها، وكل دالّةٍ مُصدَّرة اسمها record… في ملفٍّ يستدعيها (أغلفة المواضع المشتركة:
 * recordActivityInTx/recordActivityAfter/recordDocActivity…) — تُستخرج من المصدر فلا تتقادم قائمتها
 */
function recorderNames(): Set<string> {
  const names = new Set(['recordCustomerActivity']);
  const texts = sourceFiles().filter((f) => rel(f) !== 'services/customerActivity.ts').map((f) => stripComments(fs.readFileSync(f, 'utf8')));
  // حتى الثبات: غلافُ غلافٍ دالّةُ تسجيلٍ أيضاً
  for (let grew = true; grew;) {
    grew = false;
    for (const text of texts) {
      if (!callsRecorder(text, names)) continue;
      for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+(record\w*)\s*[(<]|export\s+const\s+(record\w*)\s*=\s*(?:async\s*)?\(/g)) {
        const n = m[1] ?? m[2];
        if (!names.has(n)) { names.add(n); grew = true; }
      }
    }
  }
  return names;
}
function callsRecorder(text: string, names: Set<string>): boolean {
  for (const n of names) if (new RegExp(`\\b${n}\\(`).test(text)) return true;
  return false;
}

/**
 * ملفّاتٌ تكتب جداول العميل بلا سطرٍ في سجلّه — كلٌّ بسببه. القائمة صغيرة عمداً: ما ليس إجراءً على العميل (حالة تقنية، تفريغ
 * وسمٍ عند حذف وسمه، إعادة حساب رصيدٍ مخزَّن، حذف الشركة كلها) أو مساعدٌ يُسجّل مستدعيه (ويفرض ذلك اختبار المستدعين أدناه).
 */
const ALLOWLIST: Record<string, string> = {
  'compliance/zatca/documentStore.prisma.ts': 'مرآة حالة ZATCA على الفاتورة (einvoiceStatus/QR) بعد الإبلاغ — حالة تقنية لا إجراء على العميل',
  'routes/tenants.ts': 'حذف الشركة كلها (والسجلّ معها بإذن المعاملة allowActivityPurge)',
  'services/accounting.ts': 'قيود كشف الحساب لمستندٍ وإعادة حساب الرصيد والعدّادات المخزَّنة داخل معاملة المستند نفسه — والمستند يُسجّله مساره',
  'services/docCancel.ts': 'مساعدا الإلغاء (حجز إلغاء السند وردّ المبالغ) — مستدعوهما يُسجّلون الإلغاء (يفرضه الاختبار أدناه)',
  'services/invoiceExpiry.ts': 'ختم صلاحية بنود المستند بعد إصداره يلمس طابع الفاتورة (updatedAt) لتراه المزامنة — وسمٌ معلوماتي لا إجراء، والإصدار يُسجّله مساره',
  'services/receiptCancelSource.ts': 'مصدر ردّ المال يُكتب في معاملة إلغاء السند نفسها — routes/receipts.ts يُسجّل الإلغاء',
  'services/ownerPurge.ts': 'تصحيح الرصيد المخزَّن بعد الحذف النهائي — والحذف يُسجّله مستدعوه حاملو الفاعل (يفرضه الاختبار أدناه)',
  'services/gl/post.ts': 'محرّك الترحيل (القيد وسطوره) لمستدعيه — القيد اليدوي على عميل يُسجّله مساره routes/ledger/moves.ts ومجدول autoPost، والآلي أثرُ مستنده (فاتورة/سند/تسوية) المسجَّل في مساره',
  'services/gl/reverse.ts': 'محرّكا العكس و«إعادة إلى مسودة» لمستدعيهما — routes/ledger/moves.ts يُسجّل أثرهما على العميل، والعكس الآلي أثرُ إلغاء مستنده المسجَّل',
  'services/gl/draft.ts': 'حفظ مسودة القيد وحذفها — المسودة لا أثر لها على ذمّة العميل حتى تُرحَّل (والترحيل يُسجَّل)',
};

/** مساعداتٌ تكتب جداول العميل بالنيابة: كل مستدعٍ لها يُسجّل في سجلّ العميل (عدا ما في استثنائه) */
const HELPER_CALLS: { re: RegExp; except: string[] }[] = [
  { re: /\bcreateNumberedCustomers?\(/, except: ['services/customerNumber.ts'] },
  { re: /\bclaimReceiptCancel\(/, except: ['services/docCancel.ts'] },
  { re: /\brestoreReturnRemaining\(/, except: ['services/docCancel.ts'] },
  { re: /\b(executePurge|purgeInTx)\(/, except: ['services/ownerPurge.ts'] },
];

test('حارس التغطية: كل ملفٍّ يكتب جداول العميل يُلحق سطراً بسجلّه — أو هو في قائمة الاستثناء بسببه', () => {
  const missing: string[] = [];
  const writers = new Set<string>();
  const recorders = recorderNames();
  for (const f of sourceFiles()) {
    const text = stripComments(fs.readFileSync(f, 'utf8'));
    if (!WRITE_RE.test(text)) continue;
    const r = rel(f);
    writers.add(r);
    if (ALLOWLIST[r]) continue;
    if (!callsRecorder(text, recorders)) missing.push(r);
  }
  assert.deepEqual(missing, [], 'ملفّاتٌ تكتب جداول العميل بلا سطرٍ في سجلّه — سجّل الإجراء (recordCustomerActivity) أو أضفها إلى ALLOWLIST بسببها');
  // الاستثناء لا يتقادم ولا يزيد: كل ملفٍّ فيه ما زال يكتب جداول العميل، ولا يُسجّل في السجلّ (وإلا فاستثناؤه زائد)
  const stale = Object.keys(ALLOWLIST).filter((f) => !writers.has(f));
  assert.deepEqual(stale, [], 'استثناءٌ لملفٍّ لم يعد يكتب جداول العميل — احذفه من ALLOWLIST');
  const redundant = Object.keys(ALLOWLIST).filter((f) => callsRecorder(stripComments(read(...f.split('/'))), recorders));
  assert.deepEqual(redundant, [], 'ملفٌّ مستثنى صار يُسجّل في السجلّ — احذفه من ALLOWLIST');
});

test('حارس التغطية: مستدعو مساعدات الكتابة (إنشاء العميل، إلغاء السند، ردّ المرتجع، الحذف النهائي) يُسجّلون في سجلّ العميل', () => {
  const missing: string[] = [];
  const recorders = recorderNames();
  for (const f of sourceFiles()) {
    const text = stripComments(fs.readFileSync(f, 'utf8'));
    const r = rel(f);
    for (const h of HELPER_CALLS) {
      if (h.except.includes(r) || !h.re.test(text)) continue;
      if (!callsRecorder(text, recorders)) missing.push(`${r} (${h.re.source})`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
