// M3 — الضمانات النظامية (DESIGN.md §9.5، §3.9، §5.3، §10.1 بند M3). حراس نصية وصرفة بلا قاعدة:
//  - DELETE /api/tenants/:id: الحارس قبل confirmLedgerDestroy، ومعاد داخل معاملة تفاعلية أولها قفل gl-post قبل أي حذف (G6 (د)).
//  - لا tenant.delete خارج ذلك المسار؛ POSTED_MOVES أول فحوص ledger-reset؛ GL_RESET_KEEP = ['GlAuditLog'] وحده.
//  - لا glAttachment.delete* في routes/ledger/** (حذف المرفقات داخل معاملة حذف المسودة في services/gl/reverse.ts وحدها).
//  - routes/ledger-retention/** (إن وُجد) قراءة فقط وبلا requireAccountingSuite.
//  - حذف المندوب: قفل صف المندوب FOR UPDATE قبل العدّ حين تُفعَّل الدفاتر، ولا شيء قبل التفعيل.
//    ⚠️ التزامن الحقيقي (جلستان: حذف مندوب + إدراج سند له) خطوة يدوية على قاعدة حقيقية لا تُشغَّل في CI.
//  - قائمة العملاء بفلتر حالة الترحيل تعلن القص (postingFilterCapped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GL_RESET_KEEP, ledgerResetBlockReasons } from '../services/gl/reset';
import { RetentionChangedError, tenantDeleteRetentionGuard } from '../services/gl/retention';
import { assertRepDeletable, type RepDeletableDb } from '../services/gl/sync/tombstone';
import { POSTING_FILTER_CAP, sourceIdsWithPostStatus } from '../routes/ledger/customers';

const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'tests' || d.name === 'node_modules' ? [] : walk(p);
    return d.name.endsWith('.ts') ? [p] : [];
  });
}

function routeBody(s: string, method: string, route: string): string {
  const i = s.indexOf(`router.${method}('${route}'`);
  assert.ok(i >= 0, `${method} ${route}`);
  return s.slice(i, s.indexOf('\n});', i));
}

test('DELETE /api/tenants/:id: الحارس قبل confirmLedgerDestroy، ومعاد تحت قفل gl-post داخل المعاملة قبل كل حذف', () => {
  const body = strip(routeBody(read('routes', 'tenants.ts'), 'delete', '/:id'));
  const guard = body.indexOf('tenantDeleteRetentionGuard(');
  assert.ok(guard > 0 && guard < body.indexOf('confirmLedgerDestroy'), 'confirmLedgerDestroy لا يُقرأ قبل الحارس');
  const tx = body.indexOf('$transaction(async (tx)');
  assert.ok(tx > guard, 'معاملة تفاعلية');
  const inner = body.slice(tx);
  const lock = inner.indexOf('acquirePostLock(tx, tid)');
  const agg = inner.indexOf('tx.glMove.aggregate(');
  const again = inner.indexOf('tenantDeleteRetentionGuard(');
  assert.ok(lock > 0 && lock < agg && agg < again, 'القفل أولاً ثم العدّ ثم الحارس');
  assert.ok(lock < inner.indexOf('tx.glSettings.findUnique('));
  const deletes = [...inner.matchAll(/\.delete(Many)?\(/g)].map((m) => m.index!);
  assert.ok(deletes.length >= 15);
  for (const d of deletes) assert.ok(d > again, 'كل حذف بعد الحارس المعاد');
  assert.match(inner, /throw new RetentionChangedError\(again\)/);
  assert.match(inner, /tx\.tenant\.delete\(/);
  assert.doesNotMatch(body, /prisma\.\$transaction\(\[/, 'لا معاملة دفعية بلا قفل');
  assert.ok(new RetentionChangedError(tenantDeleteRetentionGuard({ postedMoves: 0, lastPostedDate: null, fiscalYearEndMonth: 12, fiscalYearEndDay: 31, now: new Date() })) instanceof Error);
});

test('G6: لا tenant.delete في backend/src خارج DELETE /api/tenants/:id', () => {
  const tenants = path.join(SRC, 'routes', 'tenants.ts');
  const hits: string[] = [];
  for (const f of walk(SRC)) {
    const s = strip(fs.readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/\.tenant\.delete(Many)?\(/g)) {
      if (path.resolve(f) === path.resolve(tenants)) {
        const body = routeBody(s, 'delete', '/:id');
        const start = s.indexOf(body);
        if (m.index! >= start && m.index! < start + body.length) continue;
      }
      hits.push(path.relative(SRC, f));
    }
  }
  assert.deepEqual(hits, []);
});

test('ledger-reset: POSTED_MOVES أول الفحوص، وGL_RESET_KEEP = [GlAuditLog] وحده', () => {
  assert.deepEqual([...GL_RESET_KEEP], ['GlAuditLog']);
  const reasons = ledgerResetBlockReasons({ postedMoves: 1, filedReturns: 1, securedMoves: 1, hardLockDate: '2027-01-01', customerAdjustmentSources: 1 } as Parameters<typeof ledgerResetBlockReasons>[0]);
  assert.equal(reasons[0], 'POSTED_MOVES');
  const fn = read('services', 'gl', 'reset.ts');
  const body = fn.slice(fn.indexOf('export function ledgerResetBlockReasons('));
  assert.ok(body.indexOf("'POSTED_MOVES'") < body.indexOf("'FILED_RETURN'"));
});

test('لا glAttachment.delete* في routes/ledger/** — حذف المرفقات داخل معاملة حذف المسودة وحدها', () => {
  for (const f of walk(path.join(SRC, 'routes', 'ledger'))) {
    assert.doesNotMatch(strip(fs.readFileSync(f, 'utf8')), /glAttachment\.delete/, path.relative(SRC, f));
  }
  const rev = strip(read('services', 'gl', 'reverse.ts'));
  assert.match(rev, /glAttachment\.deleteMany\(/);
});

test('routes/ledger-retention/** (إن وُجد): بلا requireAccountingSuite ولا put/patch/delete', (t) => {
  const dir = path.join(SRC, 'routes', 'ledger-retention');
  const files = walk(dir);
  if (files.length === 0) { t.skip('routes/ledger-retention لم يُنشأ بعد'); return; }
  for (const f of files) {
    const s = strip(fs.readFileSync(f, 'utf8'));
    assert.doesNotMatch(s, /requireAccountingSuite/, f);
    assert.doesNotMatch(s, /router\.(put|patch|delete)\(/, f);
  }
});

function repDb(activatedAt: Date | null, log: string[]): RepDeletableDb {
  const counter = (name: string) => ({ count: async () => { log.push(`count:${name}`); return 0; } });
  return {
    glSettings: { findUnique: async () => { log.push('settings'); return { activatedAt }; } },
    repSettlement: counter('repSettlement'), invoice: counter('invoice'), receipt: counter('receipt'),
    vanLoad: counter('vanLoad'), glMoveLine: counter('glMoveLine'),
    $queryRaw: async (q: TemplateStringsArray, ...v: unknown[]) => { log.push(`lock:${q.join('?')}|${v.join(',')}`); return []; },
  };
}

test('حذف المندوب: قفل صف المندوب FOR UPDATE قبل أول عدّ حين تُفعَّل الدفاتر، ولا قفل ولا عدّ قبل التفعيل', async () => {
  const on: string[] = [];
  await assertRepDeletable(repDb(new Date(), on), 't1', 'rep1');
  assert.equal(on[0], 'settings');
  assert.match(on[1], /^lock:SELECT id FROM sales_reps WHERE id = \? AND "tenantId" = \? FOR UPDATE\|rep1,t1$/);
  assert.ok(on.slice(2).every((x) => x.startsWith('count:')) && on.length === 7);
  const off: string[] = [];
  await assertRepDeletable(repDb(null, off), 't1', 'rep1');
  assert.deepEqual(off, ['settings']);
  const route = read('routes', 'salesReps.ts');
  assert.match(route, /FOR UPDATE/, 'تعليق المسار يصف القفل');
});

test('فلتر حالة الترحيل: يعلن القص عند تجاوز السقف ويضيّق بنطاق التاريخ', async () => {
  let args: { where?: Record<string, unknown>; take?: number } = {};
  const db = (n: number) => ({
    glSourceEvent: { findMany: async (a: unknown) => { args = a as typeof args; return Array.from({ length: n }, (_x, i) => ({ sourceId: `s${i}` })); } },
  });
  const capped = await sourceIdsWithPostStatus('t1', 'INVOICE', ['DONE'], { gte: new Date('2027-01-01') }, db(POSTING_FILTER_CAP + 1) as never);
  assert.equal(capped.capped, true);
  assert.equal(capped.ids.length, POSTING_FILTER_CAP);
  assert.equal(args.take, POSTING_FILTER_CAP + 1);
  assert.ok(args.where?.effectAt, 'نطاق التاريخ على effectAt');
  const small = await sourceIdsWithPostStatus('t1', 'RECEIPT', ['ERROR'], null, db(3) as never);
  assert.deepEqual(small, { ids: ['s0', 's1', 's2'], capped: false });
  const route = read('routes', 'ledger', 'customers.ts');
  assert.equal((route.match(/postingFilterCapped,/g) ?? []).length, 2, 'الحقل في استجابتي الفواتير والسندات');
});
