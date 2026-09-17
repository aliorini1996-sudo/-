// M3 — حارس ترتيب إعادة ضبط الدفاتر (DESIGN.md §5.7، §9.5 G6، §10.1 صف M3: gl-reset-order.test.ts).
// من schema.prisma: كل نموذج Gl* في GL_RESET_ORDER أو GL_RESET_KEEP (= ['GlAuditLog'] حرفياً)، وكل ابن قبل أبيه،
// والقفل أول عبارة في معاملة ledger-reset (يُفعَّل حين يوجد المسار).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  GL_RESET_KEEP, GL_RESET_ORDER, LEDGER_RESET_BLOCK_REASONS, deleteLedgerRows, ledgerResetBlockReasons, resetConfirmNameMatches,
  resetDelegateName, type ResetTx,
} from '../services/gl/reset';

const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8').replace(/\r\n/g, '\n');

interface Rel { field: string; target: string; onDelete: string | null }
interface Model { name: string; relations: Rel[]; fields: string[] }

function parseModels(src: string): Map<string, Model> {
  const out = new Map<string, Model>();
  const re = /^model\s+(\w+)\s*\{[^\n]*\n([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.set(m[1], { name: m[1], relations: [], fields: [] });
  re.lastIndex = 0;
  while ((m = re.exec(src))) {
    const model = out.get(m[1])!;
    for (const raw of m[2].split('\n')) {
      const l = raw.replace(/\/\/.*$/, '').trim();
      const fm = /^(\w+)\s+(\w+)(\[\])?\??\s*(.*)$/.exec(l);
      if (!fm || l.startsWith('@@')) continue;
      model.fields.push(fm[1]);
      if (out.has(fm[2]) && /@relation\([^)]*fields:/.test(fm[4])) {
        const od = /onDelete:\s*(\w+)/.exec(fm[4]);
        model.relations.push({ field: fm[1], target: fm[2], onDelete: od ? od[1] : null });
      }
    }
  }
  return out;
}

const models = parseModels(schema);
const glModels = [...models.values()].filter((x) => /^Gl[A-Z]/.test(x.name));

test('GL_RESET_KEEP = [\'GlAuditLog\'] حرفياً، وعلاقة GlAuditLog بـTenant وحده', () => {
  assert.deepEqual([...GL_RESET_KEEP], ['GlAuditLog']);
  const audit = models.get('GlAuditLog');
  assert.ok(audit, 'GlAuditLog في المخطط');
  assert.deepEqual(audit.relations.map((r) => r.target), ['Tenant']);
  // لا نموذج gl يشير إلى GlAuditLog (فلا يمنع حذفَ غيره ولا يُحذف بتسلسل)
  for (const x of glModels) assert.ok(!x.relations.some((r) => r.target === 'GlAuditLog'), `${x.name} → GlAuditLog`);
});

test('كل نموذج Gl* في GL_RESET_ORDER أو GL_RESET_KEEP، وكل مُدرج موجود بلا تكرار، وكل نموذج يحمل tenantId', () => {
  const order = [...GL_RESET_ORDER] as string[];
  assert.equal(new Set(order).size, order.length, 'تكرار في GL_RESET_ORDER');
  for (const x of glModels) {
    const inOrder = order.includes(x.name);
    const inKeep = (GL_RESET_KEEP as readonly string[]).includes(x.name);
    assert.ok(inOrder !== inKeep, `${x.name}: يجب أن يكون في إحدى القائمتين بالضبط`);
    assert.ok(x.fields.includes('tenantId'), `${x.name}: deleteMany({where:{tenantId}}) يحتاج tenantId`);
  }
  for (const n of order) assert.ok(models.has(n) && /^Gl[A-Z]/.test(n), `${n}: غير موجود في schema.prisma`);
  assert.equal(order[order.length - 1], 'GlSettings', 'GlSettings أخيراً');
});

test('كل ابن قبل أبيه (أي علاقة بين نماذج gl، وخاصة NoAction)، والمرجع الذاتي لـGlMove بعبارة واحدة', () => {
  const idx = new Map((GL_RESET_ORDER as readonly string[]).map((n, i) => [n, i]));
  let checked = 0;
  for (const x of glModels) {
    for (const r of x.relations) {
      if (!/^Gl[A-Z]/.test(r.target) || r.target === x.name) continue;
      if (!idx.has(x.name)) continue;
      assert.ok(idx.has(r.target), `${x.name} → ${r.target}: الأب غير مُدرج`);
      assert.ok(idx.get(x.name)! < idx.get(r.target)!, `${x.name} يجب أن يسبق أباه ${r.target} (${r.onDelete ?? 'بلا onDelete'})`);
      checked++;
    }
  }
  assert.ok(checked > 0);
  // المذكورة صراحةً في §5.7 (ما وُجد منها الآن)
  const pairs: [string, string][] = [
    ['GlMove', 'GlJournal'], ['GlMoveLine', 'GlAccount'], ['GlAccountMapping', 'GlAccount'],
    ['GlVendorBill', 'GlVendor'], ['GlPayment', 'GlVendor'], ['GlMoveSource', 'GlMove'], ['GlMoveNote', 'GlMove'],
    ['GlMoveLine', 'GlMove'], ['GlPartialReconcile', 'GlMove'], ['GlSequence', 'GlJournal'],
  ];
  for (const [child, parent] of pairs) {
    if (!idx.has(child) || !idx.has(parent)) continue;
    assert.ok(idx.get(child)! < idx.get(parent)!, `${child} قبل ${parent}`);
  }
  const self = models.get('GlMove')!.relations.filter((r) => r.target === 'GlMove');
  assert.equal(self.length, 1, 'GlMove.reversedMove');
  assert.equal((GL_RESET_ORDER as readonly string[]).filter((n) => n === 'GlMove').length, 1);
  // الترتيب الهيكلي في §5.7: GlSourceEvent وGlSyncCursor وGlPeriodBalance بعد GlTax وقبل GlSettings
  for (const n of ['GlSourceEvent', 'GlSyncCursor', 'GlPeriodBalance']) {
    assert.ok(idx.get(n)! > idx.get('GlTax')! && idx.get(n)! < idx.get('GlSettings')!, n);
  }
});

test('deleteLedgerRows يحذف بالترتيب بمفوَّضات Prisma ولا يمسّ GlAuditLog', async () => {
  const calls: string[] = [];
  const tx = new Proxy({}, {
    get: (_t, prop: string) => ({
      deleteMany: async (args: { where: { tenantId: string } }) => {
        assert.deepEqual(args, { where: { tenantId: 't1' } });
        calls.push(prop);
        return { count: prop.length };
      },
    }),
  }) as unknown as ResetTx;
  const counts = await deleteLedgerRows(tx, 't1');
  assert.deepEqual(calls, GL_RESET_ORDER.map(resetDelegateName));
  assert.ok(!calls.includes('glAuditLog'));
  assert.equal(counts.GlMove, 'glMove'.length);
  assert.equal(resetDelegateName('GlMoveSource'), 'glMoveSource');
});

test('ledgerResetBlockReasons وتطابق الاسم', () => {
  const none = { postedMoves: 0, filedReturns: 0, securedMoves: 0, hardLockDate: null, customerAdjustmentSources: 0 };
  assert.deepEqual(ledgerResetBlockReasons(none), []);
  assert.deepEqual(ledgerResetBlockReasons({ ...none, postedMoves: 1 }), ['POSTED_MOVES']);
  assert.deepEqual(
    ledgerResetBlockReasons({ postedMoves: 3, filedReturns: 1, securedMoves: 2, hardLockDate: '2026-12-31', customerAdjustmentSources: 1 }),
    [...LEDGER_RESET_BLOCK_REASONS],
  );
  assert.equal(resetConfirmNameMatches('شركة الاختبار', 'شركة الاختبار'), true);
  assert.equal(resetConfirmNameMatches(' شركة الاختبار', 'شركة الاختبار'), false);
  assert.equal(resetConfirmNameMatches(undefined, 'x'), false);
});

test('حارس ثابت: pg_advisory_xact_lock(gl-post) أول عبارة في معاملة ledger-reset', (t) => {
  const file = path.join(__dirname, '../routes/tenants.ts');
  const s = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const start = s.search(/router\.post\(\s*['"`]\/:id\/ledger-reset['"`]/);
  if (start < 0) { t.skip('مسار ledger-reset لم يُكتب بعد (وكيل المالك، M3)'); return; }
  const rest = s.slice(start + 10);
  const next = rest.search(/\nrouter\.(get|post|put|delete|patch)\(/);
  const body = next < 0 ? s.slice(start) : s.slice(start, start + 10 + next);
  const txm = /\$transaction\(\s*async\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{/.exec(body);
  assert.ok(txm, 'ledger-reset داخل $transaction تفاعلية');
  const inner = body.slice(txm.index + txm[0].length);
  const firstAwait = /await\s+([^;]+);/.exec(inner);
  assert.ok(firstAwait, 'عبارة أولى في المعاملة');
  assert.match(firstAwait[1], /acquirePostLock\(\s*\w+|pg_advisory_xact_lock\(hashtext\(/, `أول عبارة ليست القفل: ${firstAwait[1]}`);
  assert.match(body, /GL_RESET_ORDER|deleteLedgerRows/, 'الحذف بالقائمة الصريحة');
});

test('حارس ثابت: ledger-reset — القفل أول عبارة قبل أي قراءة، والحذف بـdeleteLedgerRows(tx) وحده، وGL_RESET_KEEP لا يُمسّ؛ وحذف الشركة بعد الحفظ يحذف gl بالترتيب ثم GlAuditLog', () => {
  const file = path.join(__dirname, '../routes/tenants.ts');
  const s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const slice = (head: string) => {
    const i = s.indexOf(head);
    assert.ok(i >= 0, head);
    const next = s.slice(i + head.length).search(/\nrouter\.(get|post|put|delete|patch)\(/);
    return next < 0 ? s.slice(i) : s.slice(i, i + head.length + next);
  };
  const reset = slice("router.post('/:id/ledger-reset'");
  const tx = reset.indexOf('$transaction(async tx => {');
  assert.ok(tx >= 0);
  const inner = reset.slice(tx);
  const lock = inner.indexOf('await acquirePostLock(tx, tid)');
  assert.ok(lock > 0);
  assert.equal(inner.slice(0, lock).search(/tx\.\w+\.\w+\(/), -1, 'لا قراءة قبل القفل داخل المعاملة');
  assert.match(inner, /deleteLedgerRows\(tx as unknown as ResetTx, tid\)/);
  assert.doesNotMatch(reset, /\.deleteMany\(|glAuditLog\.delete/);
  assert.match(inner, /action: 'LEDGER_RESET'/);

  const del = slice("router.delete('/:id'");
  const order = del.indexOf('[...GL_RESET_ORDER, ...GL_RESET_KEEP].map(');
  // حذف الشركة داخل معاملة تفاعلية أولها قفل gl-post (G6 (د)) ⇒ tx.tenant.delete
  const tenantDelete = del.search(/(prisma|tx)\.tenant\.delete\(/);
  assert.ok(order > 0 && tenantDelete > order, 'gl بالترتيب ثم سجل التدقيق (GL_RESET_KEEP آخراً) ثم الشركة');
  assert.ok(del.search(/(prisma|tx)\.receiptInvoice\.deleteMany\(/) > order, 'جداول gl قبل الجداول التشغيلية');
});
