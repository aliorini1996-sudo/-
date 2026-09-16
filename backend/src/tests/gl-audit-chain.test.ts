// M2 — سلسلة التدقيق وسبب العكس (DESIGN.md §9.3، §9.5 G5، §10.1 صف M2: gl-audit-chain.test.ts).
// seq/hash بالترتيب وكسرها بالحذف أو التعديل، وسبب العكس إلزامي في reverse/reset-draft، والعكس الآلي (SYSTEM)
// يملأ reversalReason على القيد العكسي — سلوكاً عبر معاملة مزيّفة تلتقط glMove.create، بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalAuditEntry, computeAuditHash, verifyAuditChain, type AuditChainRow, type GlTx, SYSTEM_ACTOR,
} from '../services/gl/audit';
import { resetDraft, reverseMove } from '../services/gl/reverse';
import { DEFAULT_GL_SETTINGS, isLedgerError } from '../services/gl/types';

const ROOT = path.join(__dirname, '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const src = (rel: string) => strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function routeBody(file: string, method: string, route: string): string {
  const s = src(file);
  const start = s.indexOf(`router.${method}('${route}'`);
  assert.ok(start >= 0, `${file}: ${method.toUpperCase()} ${route} غير مسجّل`);
  const next = s.slice(start + 10).search(/\n(router\.(get|post|put|delete|patch)\(|export |async function |function |const |type |interface )/);
  return next < 0 ? s.slice(start) : s.slice(start, start + 10 + next);
}

// ═══ السلسلة ═══

function chain(n: number, tenantId = 't1'): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    const base = {
      tenantId, seq: i, at: new Date(Date.UTC(2026, 8, 16, 9, 0, i)), actorType: i % 2 ? 'ADMIN' : 'SYSTEM', actorId: i % 2 ? 'u1' : null,
      actorName: null, impersonated: false, action: i === 1 ? 'MOVE_CREATE' : 'MOVE_POST', entityType: 'MOVE', entityId: `m${i}`,
      summary: `حدث ${i}`, beforeJson: i > 1 ? { state: 'DRAFT' } : null, afterJson: { n: i, total: `${i}000` }, requestIp: null,
    };
    const hash = computeAuditHash(prev, canonicalAuditEntry(base));
    rows.push({ ...base, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

test('السلسلة السليمة تُتحقق بترتيب seq لا بترتيب الإدخال', () => {
  const rows = chain(5);
  const shuffled = [rows[3], rows[0], rows[4], rows[2], rows[1]];
  const v = verifyAuditChain(shuffled);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.count, 5);
    assert.equal(v.lastSeq, 5);
    assert.equal(v.lastHash, rows[4].hash);
  }
  assert.deepEqual(verifyAuditChain([]), { ok: true, count: 0, lastSeq: 0, lastHash: null });
  // كل hash يعتمد على السابق: السطر الأول بلا prevHash
  assert.equal(rows[0].prevHash, null);
  assert.equal(rows[1].prevHash, rows[0].hash);
});

test('حذف صف يكسر السلسلة: الأول ⇒ SEQ_GAP عند 2، والأوسط ⇒ SEQ_GAP، والأخير لا يُكشف إلا بمقارنة lastSeq', () => {
  const rows = chain(5);
  assert.deepEqual(verifyAuditChain(rows.slice(1)), { ok: false, seq: 2, reason: 'SEQ_GAP' });
  assert.deepEqual(verifyAuditChain(rows.filter((r) => r.seq !== 3)), { ok: false, seq: 4, reason: 'SEQ_GAP' });
  const tail = verifyAuditChain(rows.slice(0, 4));
  assert.equal(tail.ok, true);
  if (tail.ok) assert.notEqual(tail.lastHash, rows[4].hash);
});

test('تعديل أي حقل مُجزَّأ ⇒ HASH، وإعادة ترقيم أو ربط prevHash ⇒ فشل', () => {
  const rows = chain(4);
  const fields: [keyof AuditChainRow, unknown][] = [
    ['summary', 'معدَّل'], ['action', 'MOVE_DELETE_DRAFT'], ['entityId', 'mX'], ['afterJson', { n: 99 }], ['beforeJson', null],
    ['actorId', 'intruder'], ['impersonated', true], ['at', new Date(Date.UTC(2027, 0, 1))], ['tenantId', 't2'],
  ];
  for (const [f, v] of fields) {
    const tampered = rows.map((r) => (r.seq === 3 ? { ...r, [f]: v } : r));
    const res = verifyAuditChain(tampered);
    assert.equal(res.ok, false, String(f));
    if (!res.ok) {
      assert.equal(res.seq, 3, String(f));
      assert.equal(res.reason, 'HASH', String(f));
    }
  }
  // تعديل صف ثم إعادة حساب hashه وحده يكسر الصف التالي
  const t = rows.map((r) => ({ ...r }));
  t[1] = { ...t[1], summary: 'تزوير' };
  t[1].hash = computeAuditHash(t[1].prevHash, canonicalAuditEntry(t[1]));
  assert.deepEqual(verifyAuditChain(t), { ok: false, seq: 3, reason: 'PREV_HASH' });
  // صفوف شركة أخرى بسلسلتها لا تُخلط
  assert.equal(verifyAuditChain([...rows, ...chain(2, 't2')]).ok, false);
});

// ═══ سبب العكس (G5) ═══

/** معاملة مزيّفة تسجّل كل وصول: سبب فارغ يجب ألا يلمس المعاملة أصلاً. */
function trapTx() {
  const touched: string[] = [];
  const tx = new Proxy({}, {
    get: (_t, prop) => {
      touched.push(String(prop));
      throw new Error(`لمس المعاملة قبل فحص السبب: ${String(prop)}`);
    },
  });
  return { tx: tx as GlTx, touched };
}

test('reverseMove وresetDraft: سبب فارغ ⇒ LEDGER_REVERSAL_REASON_REQUIRED (422) قبل أي وصول للمعاملة، بوضعيه', async () => {
  for (const reason of ['', '   ', undefined as unknown as string]) {
    for (const mode of ['MANUAL', 'SYSTEM'] as const) {
      const { tx, touched } = trapTx();
      await assert.rejects(reverseMove(tx, { tenantId: 't1', moveId: 'm1', actor: SYSTEM_ACTOR, reason, mode }), (e: unknown) => isLedgerError(e, 'LEDGER_REVERSAL_REASON_REQUIRED') && e.httpStatus === 422);
      assert.deepEqual(touched, [], mode);
    }
    const { tx, touched } = trapTx();
    await assert.rejects(resetDraft(tx, { tenantId: 't1', moveId: 'm1', actor: SYSTEM_ACTOR, reason }), (e: unknown) => isLedgerError(e, 'LEDGER_REVERSAL_REASON_REQUIRED'));
    assert.deepEqual(touched, []);
  }
});

test('حارس ثابت: معالجا reverse وreset-draft يفحصان السبب أولاً', () => {
  const moves = 'routes/ledger/moves.ts';
  for (const r of ['/moves/:id/reverse', '/moves/:id/reset-draft']) {
    const body = routeBody(moves, 'post', r);
    const reason = body.indexOf('assertReversalReason(req.body?.reason)');
    assert.ok(reason >= 0, r);
    assert.ok(body.indexOf('prisma.$transaction(') > reason, r);
  }
});

class Captured extends Error {
  constructor(readonly data: Record<string, unknown>) { super('captured'); }
}

test('العكس الآلي (SYSTEM) يملأ reversalReason وreversedMoveId على القيد العكسي، والبيان يحمل السبب', async () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const settingsRow = {
    ...DEFAULT_GL_SETTINGS, cutoverDate: null, perpetualFromDate: null, salesLockDate: null, purchaseLockDate: null,
    taxLockDate: null, hardLockDate: null, paylinkFeeTaxInvoiceFrom: null, receiptRouting: null,
  };
  const accounts = [
    { id: 'cash', code: '111001', name: 'الصندوق', type: 'asset_cash', isActive: true, reconcile: false, controlKind: null },
    { id: 'rent', code: '621004', name: 'الإيجار', type: 'expense', isActive: true, reconcile: false, controlKind: null },
  ];
  const journals = [{ id: 'jm', code: 'MISC', name: 'متنوعة', type: 'GENERAL', systemKey: 'MISC', defaultAccountId: null, suspenseAccountId: null, useOutstandingAccounts: false, sequenceReset: 'YEARLY', isActive: true }];
  const line = (seq: number, accountId: string, debitMilli: bigint, creditMilli: bigint) => ({
    id: `l${seq}`, seq, accountId, label: 'بند', debitMilli, creditMilli, customerId: null, vendorId: null, salesRepId: null,
    partnerName: null, analyticAccountId: null, productId: null, quantity: null, taxId: null, taxRole: null, taxBaseMilli: null,
    vatBox: null, vatAdjustment: false, dueDate: null, currencyCode: null, amountCurrencyMilli: null, posted: true,
  });
  const record = {
    id: 'orig', tenantId: 't1', journalId: 'jm', number: 'MISC/2026/00001', state: 'POSTED', moveType: 'ENTRY', origin: 'AUTO',
    date: d('2026-09-10'), originalDate: null, lateArrival: false, ref: null, narration: 'إيجار', currencyCode: 'SAR', currencyDecimals: 2,
    totalMilli: 100_000n, customerId: null, vendorId: null, salesRepId: null, sourceType: 'EXPENSE', sourceId: 'e1',
    reversedMoveId: null, reversalReason: null, draftOfMoveId: null, autoPostOn: null, reviewState: 'NONE', needsAttention: false,
    attentionReason: null, createdBy: 'u1', createdByImpersonated: false, postedAt: d('2026-09-10'), postedBy: 'u1',
    postedByImpersonated: false, secureSeq: null, secureHash: null,
    journal: { id: 'jm', code: 'MISC', systemKey: 'MISC', type: 'GENERAL', sequenceReset: 'YEARLY' },
    lines: [line(0, 'rent', 100_000n, 0n), line(1, 'cash', 0n, 100_000n)],
    sources: [], reversal: null,
  };
  const empty = async () => [];
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ n: 1 }],
    glSettings: { findUnique: async () => settingsRow },
    glAccount: { findMany: async () => accounts },
    glAccountMapping: { findMany: empty },
    glTax: { findMany: empty },
    glJournal: { findMany: async () => journals },
    glProductCategoryAccount: { findMany: empty },
    glRepAnalyticDefault: { findMany: empty },
    glSequence: { upsert: async () => ({}) },
    glMove: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => (where.id === 'orig' && where.tenantId === 't1' ? record : null),
      create: async ({ data }: { data: Record<string, unknown> }) => { throw new Captured(data); },
    },
  } as unknown as GlTx;

  const reason = 'إلغاء المصروف e1 من مستنده';
  await assert.rejects(
    reverseMove(tx, { tenantId: 't1', moveId: 'orig', actor: SYSTEM_ACTOR, reason: `  ${reason}  `, mode: 'SYSTEM', now: new Date('2026-09-16T08:00:00Z') }),
    (e: unknown) => {
      assert.ok(e instanceof Captured, String(e));
      assert.equal(e.data.reversalReason, reason, 'السبب مشذَّباً على القيد العكسي');
      assert.equal(e.data.reversedMoveId, 'orig');
      assert.equal(e.data.state, 'POSTED');
      assert.match(String(e.data.narration), new RegExp(reason));
      const lines = (e.data.lines as { create: { accountId: string; debitMilli: bigint; creditMilli: bigint }[] }).create;
      assert.deepEqual(lines.map((l) => [l.accountId, l.debitMilli, l.creditMilli]), [['rent', 0n, 100_000n], ['cash', 100_000n, 0n]]);
      return true;
    },
  );
});
