// M3 — حراس خطافات الحذف وعزل المسارات التشغيلية (DESIGN.md §5.1، §5.3، §10.1 صف M3: gl-hooks-static.test.ts، GL‑13).
// نصية على المصدر (لا قاعدة بيانات) + سلوك صرف للمساعدات بعميل مزيّف.
// بنود tenants.ts (حارس الحفظ، ledger-reset، ledgerStatus، tenantApi.remove) يضيفها وكيل المالك بتعديل موضعي أدناه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REP_HISTORY_LOCKED_MESSAGE, arEntryTombstoneEvents, assertRepDeletable, ledgerTombstoneSettings, ledgerTombstones,
  settlementTombstoneEvents, settlementTombstones, type RepDeletableDb,
} from '../services/gl/sync/tombstone';
import { LedgerError, isLedgerError } from '../services/gl/types';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

/** جسم معالج من سطر تعريفه حتى `\n});` التالي */
function handler(src: string, head: string): string {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `المعالج مفقود: ${head}`);
  const end = src.indexOf('\n});', i);
  assert.ok(end > i, `نهاية المعالج مفقودة: ${head}`);
  return src.slice(i, end);
}

/** جسم معاملة تفاعلية تبدأ عند `prisma.$transaction(async tx =>` حتى إغلاقها `}, {` أو `});` */
function interactiveTx(body: string, from = 0): { text: string; start: number } {
  const start = body.indexOf('prisma.$transaction(async tx => {', from);
  assert.ok(start >= 0, 'لا معاملة تفاعلية');
  const closers = [body.indexOf('\n    }, {', start), body.indexOf('\n    });', start), body.indexOf('\n      }, {', start)]
    .filter((x) => x > start);
  const end = Math.min(...closers);
  assert.ok(Number.isFinite(end), 'نهاية المعاملة مفقودة');
  return { text: body.slice(start, end), start };
}

function ordered(text: string, needles: readonly (string | RegExp)[], msg: string): void {
  let pos = -1;
  for (const n of needles) {
    const idx = typeof n === 'string' ? text.indexOf(n, pos + 1) : (() => { const r = new RegExp(n.source, 'g'); r.lastIndex = pos + 1; const m = r.exec(text); return m ? m.index : -1; })();
    assert.ok(idx > pos, `${msg}: «${String(n)}» مفقود أو خارج الترتيب`);
    pos = idx;
  }
}

// ═══ المسارات التشغيلية لا تعرف الدفاتر (§5.1: لا خطّاف داخل المعاملات) ═══

const UNTOUCHED = [
  'routes/invoices.ts', 'routes/receipts.ts', 'services/paylink.ts', 'services/accounting.ts', 'services/settlement.ts',
];

function findOfflineSync(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') findOfflineSync(p, out); }
    else if (/offlineSync/i.test(e.name) || /[\\/]rep[\\/]offlineSync/i.test(p)) out.push(path.relative(SRC, p));
  }
  return out;
}

test('accounting.ts وinvoices.ts وreceipts.ts وpaylink.ts وsettlement.ts (وoffline sync) لا تستورد services/gl ولا تكتب أحداثه', () => {
  const files = [...UNTOUCHED, ...findOfflineSync(SRC)];
  for (const f of files) {
    const s = read(f);
    assert.doesNotMatch(s, /from\s+['"][^'"]*services\/gl[^'"]*['"]/, `${f} يستورد services/gl`);
    assert.doesNotMatch(s, /from\s+['"]\.\.?\/gl[/'"]/, `${f} يستورد gl نسبياً`);
    assert.doesNotMatch(s, /require\(\s*['"][^'"]*\/gl[/'"]/, `${f} يطلب gl`);
    assert.doesNotMatch(s, /glSourceEvent|glMove|glSyncCursor/, `${f} يلمس جداول الدفاتر`);
  }
});

// ═══ تراجع الاستيراد (import.ts) ═══

test('تراجع الأرصدة/الأستاذ: findMany ثم glSourceEvent.createMany ثم deleteMany داخل $transaction تفاعلية واحدة', () => {
  const body = handler(read('routes/import.ts'), "router.post('/batches/:id/revert'");
  const branchStart = body.indexOf("batch.kind === 'balances' || batch.kind === 'ledger'");
  assert.ok(branchStart > 0, 'فرع الأرصدة/الأستاذ مفقود');
  const branchEnd = body.indexOf("batch.kind === 'prices'", branchStart);
  const branch = body.slice(branchStart, branchEnd);
  const { text: tx, start } = interactiveTx(branch);
  ordered(tx, ['tx.accountEntry.findMany(', 'ledgerTombstones(tx', 'tx.glSourceEvent.createMany(', 'skipDuplicates: true', 'tx.accountEntry.deleteMany('],
    'ترتيب خطاف تراجع الأرصدة');
  // لا حذف مستقل خارج المعاملة قبلها
  assert.doesNotMatch(branch.slice(0, start), /accountEntry\.deleteMany/, 'deleteMany خارج المعاملة');
  assert.doesNotMatch(branch.slice(0, start), /accountEntry\.findMany/, 'القراءة خارج المعاملة');
  // الحمولة تحتاج كل حقول الصف
  for (const f of ['id', 'customerId', 'debit', 'credit', 'entryDate', 'description', 'createdAt']) {
    assert.match(tx, new RegExp(`${f}: true`), `select يُغفل ${f}`);
  }
  // إعادة كتابة الأرصدة صفاً صفاً خارجها
  assert.doesNotMatch(tx, /accountEntry\.update\(/, 'إعادة كتابة الأرصدة يجب أن تبقى خارج المعاملة');
});

test('تراجع العميل: glSourceEvent.createMany أول عنصر في مصفوفة $transaction والقراءة قبل المصفوفة', () => {
  const body = handler(read('routes/import.ts'), "router.post('/batches/:id/revert'");
  const branchStart = body.indexOf("batch.kind === 'customers'");
  const branchEnd = body.indexOf("batch.kind === 'products'", branchStart);
  const branch = body.slice(branchStart, branchEnd);
  const arr = branch.indexOf('prisma.$transaction([');
  assert.ok(arr > 0, 'مصفوفة معاملة العميل مفقودة');
  const afterBracket = branch.slice(arr + 'prisma.$transaction(['.length);
  const firstElement = afterBracket.slice(0, afterBracket.indexOf('\n', afterBracket.search(/\S/)));
  assert.match(firstElement, /glSourceEvent\.createMany\(/, 'createMany ليس أول عنصر في المصفوفة');
  assert.match(firstElement, /skipDuplicates: true/);
  ordered(branch, ['ledgerTombstoneSettings(', 'accountEntry.findMany(', 'prisma.$transaction([', 'glSourceEvent.createMany(', 'prisma.accountEntry.deleteMany('],
    'ترتيب خطاف تراجع العميل');
  // الإعدادات تُقرأ مرة واحدة قبل الحلقة، وقراءة الصفوف مشروطة بها
  assert.ok(branch.indexOf('ledgerTombstoneSettings(') < branch.indexOf('for (const cid of ids)'), 'قراءة التفعيل داخل الحلقة');
  assert.match(branch, /glSettings\s*\n?\s*\?\s*arEntryTombstoneRows\(/, 'قراءة صفوف العميل غير مشروطة بالتفعيل');
});

test('products revert بلا خطاف دفاتر في M3 (حارس M9 لاحقاً)', () => {
  const body = handler(read('routes/import.ts'), "router.post('/batches/:id/revert'");
  const s = body.indexOf("batch.kind === 'products'");
  const branch = body.slice(s, body.indexOf("batch.kind === 'balances'", s));
  assert.doesNotMatch(branch, /glSourceEvent/);
});

// ═══ salesReps.ts ═══

test('حذف المندوب: assertRepDeletable أول ما في معاملة تفاعلية وقبل repSettlement.deleteMany، ولا SETTLEMENT:*:REVERSE', () => {
  const body = handler(read('routes/salesReps.ts'), "router.delete('/:id',");
  const { text: tx } = interactiveTx(body);
  const firstAwait = tx.indexOf('await ');
  assert.ok(firstAwait > 0);
  assert.match(tx.slice(firstAwait), /^await assertRepDeletable\(tx, tid, req\.params\.id\)/, 'أول await في المعاملة ليس assertRepDeletable');
  ordered(tx, ['assertRepDeletable(tx', 'tx.invoice.updateMany(', 'tx.repSettlement.deleteMany(', 'tx.salesRep.delete('], 'ترتيب حذف المندوب');
  // الاستدعاءات القائمة بترتيبها نفسه
  ordered(tx, [
    'tx.invoice.updateMany(', 'tx.receipt.updateMany(', 'tx.dailyReport.updateMany(', 'tx.dailyReportOwnerRep.deleteMany(',
    'tx.notification.deleteMany(', 'tx.vanLoadItem.deleteMany(', 'tx.vanLoad.deleteMany(', 'tx.repLocation.deleteMany(',
    'tx.repVisit.deleteMany(', 'tx.repSettlement.deleteMany(', 'tx.customerAssignment.deleteMany(', 'tx.salesRep.delete(',
  ], 'ترتيب الاستدعاءات القائمة');
  // لا حذف قبل المعاملة
  assert.doesNotMatch(body.slice(0, body.indexOf('prisma.$transaction(')), /\b(?:prisma|tx)\.\w+\.(?:deleteMany|delete|updateMany)\(/);
  // لا أحداث عكس للاستلامات
  assert.doesNotMatch(body, /SETTLEMENT:|settlementKey|settlementTombstones|glSourceEvent/, 'حذف المندوب يكتب أحداث دفاتر');
  assert.doesNotMatch(body, /inventoryMode/, 'الحارس مشروط بطريقة الجرد');
  assert.match(body, /LEDGER_HISTORY_LOCKED/);
  assert.match(body, /status\(409\)/);
});

test('assertRepDeletable مشروط بـactivatedAt لا بـinventoryMode، ويفحص الأثر المالي الخمسة', () => {
  const s = read('services/gl/sync/tombstone.ts');
  const i = s.indexOf('export async function assertRepDeletable(');
  const fn = s.slice(i, s.indexOf('\n}', i));
  assert.match(fn, /activatedAt/);
  assert.doesNotMatch(fn, /inventoryMode/);
  assert.ok(fn.indexOf('activatedAt') < fn.indexOf('.count('), 'activatedAt يُقرأ بعد العدّ');
  for (const d of ['repSettlement', 'invoice', 'receipt', 'vanLoad', 'glMoveLine']) assert.match(fn, new RegExp(`db\\.${d}\\.count\\(`), `لا يفحص ${d}`);
  assert.doesNotMatch(s, /status:\s*'SKIPPED'/, 'الـtombstone يضبط SKIPPED');
});

test('حذف الاستلام الواحد ما زال يكتب SETTLEMENT:<id>:REVERSE داخل معاملته وقبل الحذف', () => {
  const body = handler(read('routes/salesReps.ts'), "router.delete('/:id/settlements/:settlementId'");
  const { text: tx } = interactiveTx(body);
  ordered(tx, ['settlementTombstones(tx, tid, row', 'tx.glSourceEvent.createMany(', 'skipDuplicates: true', 'tx.repSettlement.delete('], 'ترتيب خطاف حذف الاستلام');
  const s = read('services/gl/sync/tombstone.ts');
  const i = s.indexOf('export function settlementTombstoneEvents(');
  const fn = s.slice(i, s.indexOf('\n}', i));
  assert.match(fn, /settlementKey\(row\.id, 'POST'\)/);
  assert.match(fn, /settlementKey\(row\.id, 'REVERSE'\)/);
});

// ═══ سلوك المساعدات بعميل مزيّف ═══

function fakeSettingsDb(activatedAt: Date | null, currencyDecimals = 2) {
  const calls: string[] = [];
  return {
    calls,
    glSettings: {
      async findUnique() { calls.push('glSettings.findUnique'); return activatedAt === undefined ? null : { activatedAt, currencyDecimals }; },
    },
    customer: {
      async findMany(args: { where: { id: { in: string[] } } }) {
        calls.push('customer.findMany');
        return args.where.id.in.map((id) => ({ id, name: `اسم ${id}` }));
      },
    },
  };
}

const entry = (id: string, customerId = 'c1') => ({
  id, customerId, debit: 100.1, credit: 0, description: 'رصيد افتتاحي',
  entryDate: new Date('2026-01-05T09:00:00Z'), createdAt: new Date('2026-02-01T10:00:00Z'),
});

test('activatedAt فارغ ⇒ قراءة gl_settings وحدها ولا صفوف', async () => {
  const db = fakeSettingsDb(null);
  assert.deepEqual(await ledgerTombstones(db, 't1', [entry('e1')]), []);
  assert.equal(await ledgerTombstoneSettings(db, 't1'), null);
  const row = { id: 's1', salesRepId: 'r1', amount: 50, method: 'CASH', note: null, settledAt: new Date(), createdAt: new Date() };
  assert.deepEqual(await settlementTombstones(db, 't1', row), []);
  assert.deepEqual(db.calls, ['glSettings.findUnique', 'glSettings.findUnique', 'glSettings.findUnique']);
});

test('مُفعَّل ⇒ AR_ENTRY POST وREVERSE معاً PENDING بلقطة كاملة واسم العميل ومبالغ نصية', async () => {
  const db = fakeSettingsDb(new Date('2026-01-01T00:00:00Z'));
  const deletedAt = new Date('2026-03-01T12:00:00Z');
  const rows = await ledgerTombstones(db, 't1', [entry('e1'), entry('e2', 'c2')], { deletedAt, batchId: 'b1' });
  assert.deepEqual(rows.map((r) => r.sourceKey), ['AR_ENTRY:e1:POST', 'AR_ENTRY:e1:REVERSE', 'AR_ENTRY:e2:POST', 'AR_ENTRY:e2:REVERSE']);
  for (const r of rows) {
    assert.equal(r.status, 'PENDING');
    assert.equal(r.tenantId, 't1');
    assert.equal(r.sourceType, 'AR_ENTRY');
  }
  assert.equal(rows[0].effectAt.toISOString(), '2026-01-05T09:00:00.000Z');
  assert.equal(rows[1].effectAt.toISOString(), deletedAt.toISOString());
  const p = rows[0].payload as Record<string, unknown>;
  assert.deepEqual(p, {
    entryId: 'e1', customerId: 'c1', customerName: 'اسم c1', debit: '100.10', credit: '0.00', description: 'رصيد افتتاحي',
    entryDate: '2026-01-05T09:00:00.000Z', createdAt: '2026-02-01T10:00:00.000Z', origin: 'IMPORT', batchId: 'b1',
    sourceCreatedAt: '2026-02-01T10:00:00.000Z',
  });
  assert.deepEqual(rows[1].payload, rows[0].payload, 'الحمولة نفسها في المفتاحين');
});

test('لقطة الاسم الممررة مع الصف تُغني عن قراءة العملاء', async () => {
  const db = fakeSettingsDb(new Date());
  const e = arEntryTombstoneEvents([{ ...entry('e9'), customer: { name: 'مؤسسة' } }], 2);
  assert.equal((e[0].payload as { customerName: string }).customerName, 'مؤسسة');
  await ledgerTombstones(db, 't1', [{ ...entry('e9'), customer: { name: 'مؤسسة' } }]);
  assert.ok(!db.calls.includes('customer.findMany'));
});

test('حذف استلام مُفعَّل ⇒ SETTLEMENT POST (settledAt) وREVERSE (لحظة الحذف) بحمولة {amount, method, salesRepId, settledAt, createdAt}', async () => {
  const db = fakeSettingsDb(new Date(), 3);
  const row = { id: 's1', salesRepId: 'r1', amount: 1234.5, method: 'BANK_TRANSFER', note: 'دفعة', settledAt: new Date('2026-02-10T08:00:00Z'), createdAt: new Date('2026-02-10T08:00:01Z') };
  const deletedAt = new Date('2026-02-11T08:00:00Z');
  const rows = await settlementTombstones(db, 't1', row, { salesRepName: 'أحمد', deletedAt });
  assert.deepEqual(rows.map((r) => [r.sourceKey, r.event, r.status, r.effectAt.toISOString()]), [
    ['SETTLEMENT:s1:POST', 'POST', 'PENDING', '2026-02-10T08:00:00.000Z'],
    ['SETTLEMENT:s1:REVERSE', 'REVERSE', 'PENDING', deletedAt.toISOString()],
  ]);
  const p = rows[1].payload as Record<string, unknown>;
  assert.equal(p.amount, '1234.500');
  assert.equal(p.method, 'BANK_TRANSFER');
  assert.equal(p.salesRepId, 'r1');
  assert.equal(p.settledAt, '2026-02-10T08:00:00.000Z');
  assert.equal(p.createdAt, '2026-02-10T08:00:01.000Z');
  assert.equal(p.salesRepName, 'أحمد');
  assert.equal(settlementTombstoneEvents(row, 2).length, 2);
});

function repDb(activatedAt: Date | null, counts: Partial<Record<'repSettlement' | 'invoice' | 'receipt' | 'vanLoad' | 'glMoveLine', number>>) {
  const calls: string[] = [];
  const counter = (name: keyof typeof counts) => ({
    async count(args: { where: { tenantId: string; salesRepId: string } }) {
      calls.push(`${name}:${args.where.tenantId}:${args.where.salesRepId}`);
      return counts[name] ?? 0;
    },
  });
  const db: RepDeletableDb = {
    glSettings: { async findUnique() { calls.push('glSettings'); return { activatedAt }; } },
    repSettlement: counter('repSettlement'), invoice: counter('invoice'), receipt: counter('receipt'),
    vanLoad: counter('vanLoad'), glMoveLine: counter('glMoveLine'),
  };
  return { db, calls };
}

test('assertRepDeletable: activatedAt فارغ ⇒ يخرج مبكراً دون أي عدّ ولو للمندوب أثر', async () => {
  const { db, calls } = repDb(null, { invoice: 5, repSettlement: 3 });
  await assertRepDeletable(db, 't1', 'r1');
  assert.deepEqual(calls, ['glSettings']);
});

test('assertRepDeletable: مُفعَّل ومندوب بلا أثر ⇒ يمر بلا حدث', async () => {
  const { db, calls } = repDb(new Date(), {});
  await assertRepDeletable(db, 't1', 'r1');
  assert.equal(calls.length, 6);
});

for (const k of ['repSettlement', 'invoice', 'receipt', 'vanLoad', 'glMoveLine'] as const) {
  test(`assertRepDeletable: مُفعَّل و${k} > 0 ⇒ LEDGER_HISTORY_LOCKED (409) بالرسالة`, async () => {
    const { db } = repDb(new Date(), { [k]: 1 });
    await assert.rejects(assertRepDeletable(db, 't1', 'r1'), (e: unknown) => {
      assert.ok(e instanceof LedgerError);
      assert.ok(isLedgerError(e, 'LEDGER_HISTORY_LOCKED'));
      assert.equal(e.httpStatus, 409);
      assert.equal(e.message, REP_HISTORY_LOCKED_MESSAGE);
      assert.equal(e.details.salesRepId, 'r1');
      return true;
    });
  });
}

// ═══ بنود tenants.ts — شاشة المالك (M3، §3.9، §5.7، §8.1؛ وكيل المالك) ═══

const tenantsRoutes = (): string =>
  read('routes/tenants.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('tenants.ts DELETE /:id: confirmLedgerDestroy من req.query وحده وبعد حارس الحفظ', () => {
  const body = handler(tenantsRoutes(), "router.delete('/:id',");
  const reads = body.match(/confirmLedgerDestroy/g) ?? [];
  assert.ok(reads.length >= 1, 'المسار يقرأ confirmLedgerDestroy');
  for (const m of body.matchAll(/([\w.?[\]'"]+)confirmLedgerDestroy/g)) {
    assert.match(m[1], /^req\.query\.$/, `قراءة confirmLedgerDestroy من غير req.query: ${m[0]}`);
  }
  assert.doesNotMatch(body, /req\.body/, 'لا جسم في DELETE');
  ordered(body, ['tenantDeleteRetentionGuard(', "'LEDGER_RETENTION_ACTIVE'", 'req.query.confirmLedgerDestroy', "'LEDGER_HAS_POSTED_MOVES'", '$transaction('], 'ترتيب حارس الحذف');
});

test('tenants.ts ledger-reset: confirmName يُتحقق منه في الخادم مقابل tenant.name قبل أي كتابة', () => {
  const body = handler(tenantsRoutes(), "router.post('/:id/ledger-reset',");
  ordered(body, [
    'tenant.findUnique(', /resetConfirmNameMatches\(\s*req\.body\?\.confirmName\s*,\s*tenant\.name\s*\)/, "'LEDGER_RESET_CONFIRM_MISMATCH'",
    '$transaction(', 'acquirePostLock(', 'ledgerResetBlockReasons(', 'deleteLedgerRows(',
  ], 'ترتيب إعادة الضبط');
});

test('tenants.ts GET /: ledgerStatus من groupBy واحد خارج أي حلقة، بلا استعلام لكل شركة', () => {
  const body = handler(tenantsRoutes(), "router.get('/',");
  assert.equal((body.match(/glSourceEvent\.groupBy\(/g) ?? []).length, 1, 'groupBy واحد');
  assert.equal((body.match(/prisma\.\w+\.\w+\(/g) ?? []).length, 2, 'tenant.findMany + glSourceEvent.groupBy فقط');
  const map = body.indexOf('tenants.map(');
  assert.ok(map > body.indexOf('glSourceEvent.groupBy('), 'الاستعلام قبل الدمج');
  assert.doesNotMatch(body.slice(map), /await|prisma\./, 'لا استعلام داخل الدمج');
  assert.match(body, /by: \['tenantId'\]/);
  assert.match(body, /detectedAt: \{ lt: ledgerStuckCutoff\(/);
  assert.match(body.slice(map), /ledgerStatus: ledgerStatusOf\(/);
  assert.match(body.slice(map), /ledgerActivatedAt:/);
});

test('web tenantApi.remove يرسل confirmLedgerDestroy معامل استعلام لا جسماً (حين يُكتب)', (t) => {
  const file = path.join(SRC, '../../web-admin/src/api/client.ts');
  if (!fs.existsSync(file)) { t.skip('web-admin غير موجود'); return; }
  const s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const line = s.split('\n').find((l) => /^\s*remove:\s*\(id: string/.test(l) && l.includes('/tenants/'));
  if (!line || !line.includes('confirmLedgerDestroy')) { t.skip('tenantApi.remove بلا confirmLedgerDestroy بعد (وكيل الويب)'); return; }
  assert.match(line, /params:\s*\{[^}]*confirmLedgerDestroy|\?confirmLedgerDestroy=1/);
  assert.doesNotMatch(line, /data:\s*\{[^}]*confirmLedgerDestroy/);
});
