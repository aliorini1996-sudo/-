// M2 — خدمة الترحيل (DESIGN.md §5.4 postMove، §9.3، §9.5 G2/G5، §10.1 صف M2: gl-post-service.test.ts).
// الجزء الخاص بالخدمة: حراس مصدر ثابتة (القفل الاستشاري داخل المعاملة، الترقيم عبر gl_sequences، الأرصدة الشهرية،
// التدقيق في المعاملة نفسها، ولا activatedAt في post.ts) ودوال صرفة بلا قاعدة.
// جزء tenants.ts (تدقيق FLAG_TOGGLE) يضيفه وكيل المسارات إلى هذا الملف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  POST_LOCK_PREFIX, journalNumberingViolation, periodBalanceDeltas, periodKeyForBalance,
} from '../services/gl/post';
import {
  AUDIT_LOCK_PREFIX, canonicalAuditEntry, canonicalJson, computeAuditHash, isAuditAction, ledgerActor, SYSTEM_ACTOR,
  toAuditJson, verifyAuditChain, type AuditChainRow,
} from '../services/gl/audit';
import {
  baseFromGross, buildManualMoveDraft, draftRowsFromMoveDraft, parseManualAmount, taxOnBase, type ManualLineInput,
} from '../services/gl/draft';
import { buildContextFromRows, moveDraftFromRecord, settingsSnapshotFromRow } from '../services/gl/resolve';
import { reversalDraftFromRecord } from '../services/gl/reverse';
import { accountIdOf, saContext, taxIdOf } from '../services/gl/testing/fixtures';
import { DEFAULT_GL_SETTINGS, isLedgerError, type BuildContext } from '../services/gl/types';

const GL = path.join(__dirname, '../services/gl');
const read = (f: string) => fs.readFileSync(path.join(GL, f), 'utf8');
/** الكود بلا تعليقات */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** جسم دالة مصدَّرة حتى الدالة المصدَّرة التالية */
function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`export (async )?function ${name}\\b`));
  assert.ok(start >= 0, `الدالة ${name} غير موجودة`);
  const rest = src.slice(start + 10);
  const next = rest.search(/\n(export |async function |function )/);
  return next < 0 ? rest : rest.slice(0, next);
}
function internalFnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`\\n(async )?function ${name}\\b`));
  assert.ok(start >= 0, `الدالة ${name} غير موجودة`);
  const rest = src.slice(start + 10);
  const next = rest.search(/\n(export |async function |function |interface |const )/);
  return next < 0 ? rest : rest.slice(0, next);
}
function assertOrder(body: string, needles: (string | RegExp)[], label: string) {
  let last = -1;
  for (const n of needles) {
    const idx = typeof n === 'string' ? body.indexOf(n, last + 1) : (() => { const m = n.exec(body.slice(last + 1)); return m ? last + 1 + m.index : -1; })();
    assert.ok(idx > last, `${label}: «${String(n)}» مفقود أو خارج الترتيب`);
    last = idx;
  }
}

// ═══ حراس المصدر ═══

test('post.ts: القفل الاستشاري pg_advisory_xact_lock(hashtext(\'gl-post:\'||tid)) داخل المعاملة، ولا أقفال جلسة', () => {
  const src = code('post.ts');
  assert.equal(POST_LOCK_PREFIX, 'gl-post:');
  assert.match(src, /pg_advisory_xact_lock\(hashtext\(\$\{POST_LOCK_PREFIX \+ tenantId\}::text\)\)/);
  for (const f of fs.readdirSync(GL).filter((x) => x.endsWith('.ts'))) {
    const c = code(f);
    assert.doesNotMatch(c, /pg_advisory_lock\s*\(|pg_advisory_unlock|pg_try_advisory_lock\s*\(/, `${f}: قفل جلسة ممنوع`);
  }
  // الخدمات تعمل داخل معاملة المُستدعي: لا تفتح معاملة بنفسها
  for (const f of ['post.ts', 'reverse.ts', 'draft.ts', 'seed.ts', 'audit.ts', 'resolve.ts']) {
    assert.doesNotMatch(code(f), /\$transaction\s*\(/, `${f}: لا $transaction داخل الخدمة`);
    assert.doesNotMatch(code(f), /from ['"][^'"]*config\/database['"]/, `${f}: لا prisma عام — tx يُمرَّر`);
  }
});

test('postMove: القفل ⇒ الإعدادات بعد القفل ⇒ validateMove ⇒ الإقفال ⇒ الترقيم ⇒ القيد ⇒ الأرصدة ⇒ التدقيق', () => {
  const src = code('post.ts');
  assertOrder(fnBody(src, 'postMove'), [
    'await acquirePostLock(tx, tenantId)', 'preparePost(tx', 'tx.glMove.create(', 'applyPeriodBalances(tx', 'appendAudit(tx,',
  ], 'postMove');
  assertOrder(internalFnBody(src, 'preparePost'), [
    'tx.glSettings.findUnique(', 'validateMove(', /applyAutoLockShift\(|assertManualDateOpen\(/, 'nextSequenceNumber(tx', 'formatMoveNumber(',
  ], 'preparePost');
  assertOrder(fnBody(src, 'postDraftMove'), [
    'await acquirePostLock(tx, tenantId)', 'requireMoveRecord(tx', 'preparePost(tx', 'tx.glMove.updateMany(',
    'tx.glMoveLine.updateMany(', 'applyPeriodBalances(tx', 'appendAudit(tx,',
  ], 'postDraftMove');
});

test('الترقيم عبر gl_sequences داخل المعاملة: UPDATE … "nextNumber" + 1 … RETURNING مع upsert أولي', () => {
  const body = fnBody(code('post.ts'), 'nextSequenceNumber');
  assertOrder(body, ['tx.glSequence.upsert(', 'UPDATE "gl_sequences" SET "nextNumber" = "nextNumber" + 1', 'RETURNING'], 'nextSequenceNumber');
  assert.match(body, /journalId_prefix_periodKey/);
});

test('الأرصدة الشهرية تزايدياً: INSERT … ON CONFLICT ("tenantId","accountId","periodKey") DO UPDATE بالجمع', () => {
  const body = fnBody(code('post.ts'), 'applyPeriodBalances');
  assert.match(body, /INSERT INTO "gl_period_balances"/);
  assert.match(body, /ON CONFLICT \("tenantId", "accountId", "periodKey"\) DO UPDATE SET/);
  assert.match(body, /"debitMilli" = "gl_period_balances"\."debitMilli" \+ EXCLUDED\."debitMilli"/);
  assert.match(body, /"creditMilli" = "gl_period_balances"\."creditMilli" \+ EXCLUDED\."creditMilli"/);
  for (const f of fs.readdirSync(GL).filter((x) => x.endsWith('.ts'))) {
    assert.doesNotMatch(code(f), /glPeriodBalance\.(update|updateMany|upsert|delete|deleteMany|create|createMany)\s*\(/, f);
  }
});

test('لا فحص activatedAt في post.ts (§6.1: الفحص في المسارات والمجدول)', () => {
  assert.doesNotMatch(code('post.ts'), /activatedAt/);
  assert.doesNotMatch(code('post.ts'), /LEDGER_NOT_SETUP['"][^\n]*activat/);
});

test('audit.ts: قفل gl-audit للمعاملة، والسابق بأعلى seq، وseq + 1، وsha256، وإلحاق فقط', () => {
  const src = code('audit.ts');
  assert.equal(AUDIT_LOCK_PREFIX, 'gl-audit:');
  assertOrder(fnBody(src, 'appendAudit'), [
    'pg_advisory_xact_lock(hashtext(${AUDIT_LOCK_PREFIX + input.tenantId}::text))',
    "orderBy: { seq: 'desc' }", '(prev?.seq ?? 0) + 1', 'computeAuditHash(prevHash', 'tx.glAuditLog.create(',
  ], 'appendAudit');
  assert.match(src, /createHash\('sha256'\)/);
  for (const f of fs.readdirSync(GL).filter((x) => x.endsWith('.ts'))) {
    assert.doesNotMatch(code(f), /glAuditLog\.(update|updateMany|upsert|delete|deleteMany)\s*\(/, `${f}: GlAuditLog إلحاقي`);
  }
  // كل كتابة في الخدمات تدقّق بالمعاملة نفسها
  for (const f of ['post.ts', 'reverse.ts', 'draft.ts']) {
    const calls = code(f).match(/appendAudit\(\s*\w+/g) ?? [];
    assert.ok(calls.length > 0, f);
    for (const c of calls) assert.match(c, /appendAudit\(\s*tx$/, `${f}: ${c}`);
  }
});

// ═══ الأرصدة الشهرية (صرفة) ═══

test('periodBalanceDeltas: تجميع بالحساب والشهر، والعلامات والسطور الصفرية مستبعدة، وYYYY-CL لإقفال السنة', () => {
  const lines = [
    { accountId: 'b', debitMilli: 100_000n, creditMilli: 0n },
    { accountId: 'a', debitMilli: 0n, creditMilli: 115_000n },
    { accountId: 'b', debitMilli: 15_000n, creditMilli: 0n, taxRole: 'TAX' },
    { accountId: 'm', debitMilli: 0n, creditMilli: 0n, taxRole: 'MARKER' },
    { accountId: 'z', debitMilli: 0n, creditMilli: 0n },
  ];
  assert.deepEqual(periodBalanceDeltas(lines, '2026-09-16', 'ENTRY'), [
    { accountId: 'a', periodKey: '2026-09', debitMilli: 0n, creditMilli: 115_000n },
    { accountId: 'b', periodKey: '2026-09', debitMilli: 115_000n, creditMilli: 0n },
  ]);
  assert.equal(periodKeyForBalance('2026-12-31', 'FY_CLOSING'), '2026-CL');
  assert.equal(periodKeyForBalance('2026-01-01', 'OUT_INVOICE'), '2026-01');
  assert.equal(periodBalanceDeltas(lines, '2026-12-31', 'FY_CLOSING')[0].periodKey, '2026-CL');
});

// ═══ سلسلة التدقيق (صرفة) ═══

function chain(n: number): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    const base = {
      tenantId: 't1', seq: i, at: new Date(Date.UTC(2026, 8, 16, 9, 0, i)), actorType: 'ADMIN', actorId: 'u1', actorName: null,
      impersonated: i === 2, action: 'MOVE_POST', entityType: 'MOVE', entityId: `m${i}`, summary: `ترحيل القيد ${i}`,
      beforeJson: null, afterJson: { number: `MISC/2026/09/000${i}`, totalMilli: '115000', nested: { b: 1, a: [1, 2] } },
      requestIp: null,
    };
    const hash = computeAuditHash(prev, canonicalAuditEntry(base));
    rows.push({ ...base, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

test('سلسلة seq وhash تُتحقق بالترتيب، والحذف أو التعديل يكسرها (G5)', () => {
  const rows = chain(4);
  const ok = verifyAuditChain([...rows].reverse());
  assert.equal(ok.ok, true);
  assert.deepEqual(verifyAuditChain(rows.filter((r) => r.seq !== 2)), { ok: false, seq: 3, reason: 'SEQ_GAP' });
  const tampered = rows.map((r) => (r.seq === 3 ? { ...r, summary: 'معدَّل' } : r));
  assert.deepEqual(verifyAuditChain(tampered), { ok: false, seq: 3, reason: 'HASH' });
  const relinked = rows.map((r) => (r.seq === 3 ? { ...r, prevHash: rows[0].hash } : r));
  assert.equal(verifyAuditChain(relinked).ok, false);
  // jsonb يعيد ترتيب المفاتيح: التحقق لا يتأثر
  const reordered = rows.map((r) => ({ ...r, afterJson: { nested: { a: [1, 2], b: 1 }, totalMilli: '115000', number: (r.afterJson as { number: string }).number } }));
  assert.equal(verifyAuditChain(reordered).ok, true);
});

test('JSON التدقيق: BigInt نصاً، والتواريخ ISO، والمفاتيح مرتبة؛ والمنفّذ يوسم الانتحال', () => {
  assert.equal(canonicalJson({ b: 2n, a: new Date('2026-09-16T00:00:00.000Z'), c: undefined }), '{"a":"2026-09-16T00:00:00.000Z","b":"2"}');
  assert.deepEqual(toAuditJson({ x: [1n, null, undefined] }), { x: ['1', null, null] });
  assert.deepEqual(ledgerActor({ actorId: 'u1', impersonated: true }), { actorType: 'IMPERSONATION', actorId: 'u1', actorName: null, impersonated: true, requestIp: null });
  assert.equal(ledgerActor({ actorId: 'u2', impersonated: false }).actorType, 'ADMIN');
  assert.equal(SYSTEM_ACTOR.actorType, 'SYSTEM');
  for (const a of ['MOVE_POST', 'MOVE_DELETE_DRAFT', 'FLAG_TOGGLE', 'JOURNAL_UPDATE', 'LOCK_DATE_CHANGE', 'AUTO_POST']) assert.ok(isAuditAction(a), a);
  assert.ok(!isAuditAction('move_post') && !isAuditAction('DROP_TABLE'));
});

// ═══ G2: ترقيم الدفتر ═══

test('G2: تغيير code أو sequenceReset لدفتر له قيد مرحَّل ⇒ LEDGER_JOURNAL_HAS_POSTED_MOVES، والاسم وحده مسموح', () => {
  const j = { id: 'j1', code: 'MISC', sequenceReset: 'MONTHLY' };
  const e = journalNumberingViolation(j, { code: 'GEN' }, 3);
  assert.ok(isLedgerError(e, 'LEDGER_JOURNAL_HAS_POSTED_MOVES'));
  assert.equal(e.httpStatus, 409);
  assert.deepEqual(e.details.fields, ['code']);
  assert.deepEqual(journalNumberingViolation(j, { sequenceReset: 'YEARLY', code: 'MISC' }, 1)!.details.fields, ['sequenceReset']);
  assert.equal(journalNumberingViolation(j, { code: 'GEN', sequenceReset: 'YEARLY' }, 0), null);
  assert.equal(journalNumberingViolation(j, { code: 'MISC', sequenceReset: 'MONTHLY' }, 9), null);
  assert.equal(journalNumberingViolation(j, {}, 9), null);
  assert.match(fnBody(code('post.ts'), 'assertJournalNumberingEditable'), /journalCodeConflict\(/);
});

// ═══ مسودة القيد اليدوي وتوليد الضريبة (§6.1) ═══

function misc(ctx: BuildContext) {
  return ctx.journals.byCode('MISC')!;
}
function manual(ctx: BuildContext, lines: ManualLineInput[], date = '2026-09-16') {
  return buildManualMoveDraft({ journal: misc(ctx), date, narration: 'قيد اختبار', lines }, ctx);
}

test('ضريبة مشتريات على سطر مصروف ⇒ سطر TAX مدين على 116001 بوعائه ومربعه، والقيد صالح', () => {
  const ctx = saContext();
  const b = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '100', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('111001'), label: 'الصندوق', credit: 115 },
  ]);
  assert.deepEqual(b.issues, []);
  assert.deepEqual(b.generatedLineIndexes, [2]);
  const [base, , tax] = b.draft.lines;
  assert.equal(base.taxRole, 'BASE');
  assert.equal(base.taxId, taxIdOf('S15_PURCH'));
  assert.equal(tax.accountId, accountIdOf('116001'));
  assert.equal(tax.debitMilli, 15_000n);
  assert.equal(tax.creditMilli, 0n);
  assert.equal(tax.taxRole, 'TAX');
  assert.equal(tax.taxBaseMilli, 100_000n);
  assert.equal(tax.vatBox, 'SA_7');
  assert.equal(b.totalDebitMilli, b.totalCreditMilli);
  assert.equal(b.draft.moveType, 'ENTRY');
  assert.equal(b.draft.origin, 'MANUAL');
  assert.equal(b.lock.locked, false);
});

test('ضريبة مبيعات دائنة ⇒ TAX دائن على 212001 (SA_1)؛ وفي الجانب المعاكس وعاء سالب مع vatAdjustment', () => {
  const ctx = saContext();
  const sale = manual(ctx, [
    { accountId: accountIdOf('421001'), label: 'إيراد آخر', credit: '200', taxId: taxIdOf('S15_SALE') },
    { accountId: accountIdOf('111001'), label: 'الصندوق', debit: '230' },
  ]);
  assert.deepEqual(sale.issues, []);
  const t = sale.draft.lines[2];
  assert.equal(t.accountId, accountIdOf('212001'));
  assert.equal(t.creditMilli, 30_000n);
  assert.equal(t.taxBaseMilli, 200_000n);
  assert.equal(t.vatBox, 'SA_1');
  assert.ok(!t.vatAdjustment);

  const ret = manual(ctx, [
    { accountId: accountIdOf('421001'), label: 'ردّ', debit: '200', taxId: taxIdOf('S15_SALE') },
    { accountId: accountIdOf('111001'), label: 'الصندوق', credit: '230' },
  ]);
  const r = ret.draft.lines[2];
  assert.equal(r.debitMilli, 30_000n);
  assert.equal(r.taxBaseMilli, -200_000n);
  assert.equal(r.vatAdjustment, true);
});

test('السعر الشامل يُستخرج منه الوعاء، والنسبة الصفرية علامة 0/0، وخارج النطاق بلا سطر', () => {
  const incl = saContext({ taxes: { S15_PURCH: { priceInclude: true } } });
  const b = manual(incl, [
    { accountId: accountIdOf('621004'), label: 'إيجار شامل', debit: '115', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('111001'), label: 'الصندوق', credit: '115' },
  ]);
  assert.deepEqual(b.issues, []);
  assert.equal(b.draft.lines[0].debitMilli, 100_000n);
  assert.equal(b.draft.lines[2].debitMilli, 15_000n);
  assert.equal(baseFromGross(115_000n, 15, 2), 100_000n);
  assert.equal(taxOnBase(100_000n, 15, 2), 15_000n);
  assert.equal(taxOnBase(10_000n, 7.5, 2), 750n);
  // §2.3: تقريب واحد من الكسر الدقيق إلى منازل العملة (لا إلى الملّي أولاً)
  assert.equal(taxOnBase(230n, 15, 2), 30n); // 0.0345 ⇒ 0.03
  assert.equal(taxOnBase(30n, 15, 2), 0n); // 0.0045 ⇒ 0.00
  assert.equal(taxOnBase(-230n, 15, 2), -30n);
  assert.equal(taxOnBase(50n, 15, 2), 10n); // 0.0075 ⇒ 0.01 (نصف فأعلى)
  assert.equal(baseFromGross(40n, 15, 2), 30n); // 0.04 ÷ 1.15 = 0.034782… ⇒ 0.03
  assert.equal(baseFromGross(-40n, 15, 2), -30n);
  assert.equal(taxOnBase(230n, 15, 3), 35n); // بثلاث منازل: 0.0345 ⇒ 0.035

  const ctx = saContext();
  const z = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'صفرية', debit: '50', taxId: taxIdOf('Z_PURCH') },
    { accountId: accountIdOf('621009'), label: 'خارج النطاق', debit: '20', taxId: taxIdOf('O_PURCH') },
    { accountId: accountIdOf('111001'), label: 'الصندوق', credit: '70' },
  ]);
  assert.deepEqual(z.issues, []);
  assert.equal(z.draft.lines.length, 4);
  const m = z.draft.lines[3];
  assert.equal(m.taxRole, 'MARKER');
  assert.equal(m.debitMilli + m.creditMilli, 0n);
  assert.equal(m.taxBaseMilli, 50_000n);
  assert.equal(m.vatBox, 'SA_10');
  assert.equal(m.accountId, accountIdOf('116001'));
});

test('طريقة التقريب: PER_TAX يقرّب مجموع الوعاء مرة، وPER_LINE يجمع تقريب كل سطر', () => {
  const lines = (): ManualLineInput[] => [
    { accountId: accountIdOf('621009'), label: 'أ', debit: '0.10', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('621009'), label: 'ب', debit: '0.10', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('621009'), label: 'ج', debit: '0.10', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('111001'), label: 'الصندوق', credit: '0.35' },
  ];
  const perTax = manual(saContext(), lines());
  assert.equal(perTax.draft.lines[4].debitMilli, 50n); // round(0.30 × 15٪ = 0.045) = 0.05
  assert.deepEqual(perTax.issues, []);
  const perLine = manual(saContext({ settings: { taxRoundingMethod: 'PER_LINE' } }), lines());
  assert.equal(perLine.draft.lines[4].debitMilli, 60n); // 3 × round(0.015) = 0.06
});

test('الاحتساب العكسي سطرا مدخلات ومخرجات، وغير القابلة للخصم على حساب المصروف بلا مربع', () => {
  const ctx = saContext();
  const rc = manual(ctx, [
    { accountId: accountIdOf('621014'), label: 'استشارة خارجية', debit: '1000', taxId: taxIdOf('RC15') },
    { accountId: accountIdOf('111101'), label: 'البنك', credit: '1000' },
  ]);
  assert.deepEqual(rc.issues, []);
  assert.equal(rc.draft.lines[2].accountId, accountIdOf('116001'));
  assert.equal(rc.draft.lines[2].debitMilli, 150_000n);
  assert.equal(rc.draft.lines[3].accountId, accountIdOf('212003'));
  assert.equal(rc.draft.lines[3].creditMilli, 150_000n);

  const nd = manual(ctx, [
    { accountId: accountIdOf('621012'), label: 'ضيافة', debit: '100', taxId: taxIdOf('NONDED15') },
    { accountId: accountIdOf('111001'), label: 'الصندوق', credit: '115' },
  ]);
  assert.deepEqual(nd.issues, []);
  assert.equal(nd.draft.lines[2].accountId, accountIdOf('621012'));
  assert.equal(nd.draft.lines[2].debitMilli, 15_000n);
  assert.equal(nd.draft.lines[2].vatBox, null);
});

test('سطور TAX المولَّدة سابقاً (generated=true) تُهمل وتُعاد، والحسابات الرئيسية تظهر مخالفة، والإقفال يُنبَّه', () => {
  const ctx = saContext({ settings: { hardLockDate: '2026-06-30' } });
  const b = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '100', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('116001'), label: 'قديم', debit: '15', taxId: taxIdOf('S15_PURCH'), taxRole: 'TAX', vatBox: 'SA_7', generated: true },
    { accountId: accountIdOf('113001'), label: 'ذمة', credit: '115', customerId: 'c1', partnerName: 'عميل' },
  ], '2026-06-15');
  assert.equal(b.draft.lines.length, 3);
  assert.equal(b.draft.lines.filter((l) => l.taxRole === 'TAX').length, 1);
  assert.ok(b.issues.some((i) => i.code === 'LEDGER_CONTROL_ACCOUNT_MANUAL'));
  assert.equal(b.lock.locked, true);
  assert.equal(b.lock.lockDate, '2026-06-30');
});

test('مبالغ النموذج: نص غير رقمي ⇒ INVALID_AMOUNT، ومنازل زائدة ⇒ AMOUNT_PRECISION (422)', () => {
  assert.equal(parseManualAmount('', 2, { lineIndex: 0, field: 'debit' }), 0n);
  assert.equal(parseManualAmount('12.50', 2, { lineIndex: 0, field: 'debit' }), 12_500n);
  assert.equal(parseManualAmount('12.500', 2, { lineIndex: 0, field: 'debit' }), 12_500n);
  assert.throws(() => parseManualAmount('12.505', 2, { lineIndex: 1, field: 'credit' }), (e: unknown) =>
    isLedgerError(e, 'LEDGER_UNBALANCED') && e.details.reason === 'AMOUNT_PRECISION' && e.httpStatus === 422);
  assert.throws(() => parseManualAmount(1.005, 2, { lineIndex: 1, field: 'credit' }), (e: unknown) =>
    isLedgerError(e, 'LEDGER_UNBALANCED') && e.details.reason === 'AMOUNT_PRECISION');
  assert.throws(() => parseManualAmount('abc', 2, { lineIndex: 2, field: 'debit' }), (e: unknown) =>
    isLedgerError(e, 'LEDGER_UNBALANCED') && e.details.reason === 'INVALID_AMOUNT' && e.details.lineIndex === 2);
  const ctx = saContext();
  assert.throws(() => manual(ctx, [{ accountId: accountIdOf('621004'), label: 'x', debit: '1', taxId: 'tax_missing' }]),
    (e: unknown) => isLedgerError(e, 'LEDGER_ACCOUNT_NOT_FOUND') && e.details.reason === 'TAX_NOT_FOUND');
  const archived = saContext({ taxes: { S15_PURCH: { isActive: false } } });
  assert.throws(() => manual(archived, [{ accountId: accountIdOf('621004'), label: 'x', debit: '1', taxId: taxIdOf('S15_PURCH') }]),
    (e: unknown) => isLedgerError(e, 'LEDGER_ACCOUNT_ARCHIVED'));
});

test('صفوف المسودة: DRAFT بلا رقم، والسطور غير مرحّلة، والحساب يُحلّ، وغير المحلول ⇒ LEDGER_ACCOUNT_NOT_FOUND', () => {
  const ctx = saContext();
  const b = manual(ctx, [
    { accountId: accountIdOf('621004'), label: 'إيجار', debit: '100', taxId: taxIdOf('S15_PURCH') },
    { accountId: accountIdOf('111001'), label: 'الصندوق', credit: '115' },
  ]);
  const actor = ledgerActor({ actorId: 'u1', impersonated: true });
  const rows = draftRowsFromMoveDraft(b.draft, ctx, { tenantId: 't1', journalId: misc(ctx).id, actor, autoPostOn: '2026-09-30' });
  assert.equal(rows.move.state, 'DRAFT');
  assert.equal(rows.move.number, null);
  assert.equal(rows.move.totalMilli, 115_000n);
  assert.equal(rows.move.createdByImpersonated, true);
  assert.deepEqual(rows.move.autoPostOn, new Date('2026-09-30T00:00:00.000Z'));
  assert.equal(rows.lines.length, 3);
  assert.ok(rows.lines.every((l) => l.posted === false && l.tenantId === 't1'));
  assert.deepEqual(rows.lines.map((l) => l.seq), [0, 1, 2]);
  const bad = { ...b.draft, lines: [{ ...b.draft.lines[0], accountId: 'acc_missing' }] };
  assert.throws(() => draftRowsFromMoveDraft(bad, ctx, { tenantId: 't1', journalId: 'j', actor }), (e: unknown) => isLedgerError(e, 'LEDGER_ACCOUNT_NOT_FOUND'));
});

// ═══ الصفوف ⇐ المحرك، والقيد العكسي ═══

test('settingsSnapshotFromRow وbuildContextFromRows: @db.Date ⇒ تاريخ محلي، ومفاتيح الربط المجهولة تُتجاهل', () => {
  const row = {
    ...DEFAULT_GL_SETTINGS, cutoverDate: new Date('2026-01-01T00:00:00.000Z'), perpetualFromDate: null,
    salesLockDate: null, purchaseLockDate: null, taxLockDate: new Date('2026-03-31T00:00:00.000Z'),
    hardLockDate: null, paylinkFeeTaxInvoiceFrom: null, receiptRouting: { CASH: 'CUSTODY', ONLINE: 'CUSTODY', POS: 'X' },
  };
  const snap = settingsSnapshotFromRow(row);
  assert.equal(snap.cutoverDate, '2026-01-01');
  assert.equal(snap.taxLockDate, '2026-03-31');
  assert.deepEqual(snap.receiptRouting, { CASH: 'CUSTODY' });
  const lc = buildContextFromRows({
    settings: row,
    accounts: [{ id: 'a1', code: '111001', name: 'الصندوق', type: 'asset_cash', isActive: true, reconcile: false, controlKind: null }],
    mappings: [{ key: 'MAIN_CASH', accountId: 'a1' }, { key: 'NOT_A_KEY', accountId: 'a1' }],
    taxes: [],
    journals: [{ id: 'j1', code: 'MISC', name: 'متنوعة', type: 'GENERAL', systemKey: 'MISC', defaultAccountId: null, suspenseAccountId: null, useOutstandingAccounts: false, sequenceReset: 'MONTHLY', isActive: true }],
  });
  assert.equal(lc.ctx.accounts.byKey('MAIN_CASH')?.id, 'a1');
  assert.equal(lc.ctx.settings.taxLockDate, '2026-03-31');
  assert.equal(lc.journalById.get('j1')?.sequenceReset, 'MONTHLY');
  assert.equal(buildContextFromRows({ settings: null, accounts: [], mappings: [], taxes: [], journals: [] }).ctx.settings.currency, 'SAR');
});

test('القيد العكسي من القيد الحيّ: قلب الجانبين، والوعاء سالباً، وorigin وsourceType وsourceId منسوخة، والمرتجع بـR', () => {
  const rec = {
    moveType: 'OUT_REFUND', origin: 'AUTO', date: new Date('2026-09-01T00:00:00.000Z'), originalDate: null, lateArrival: false,
    ref: 'R-1', narration: 'مرتجع', needsAttention: true, attentionReason: 'x', customerId: 'c1', vendorId: null, salesRepId: 'r1',
    sourceType: 'INVOICE', sourceId: 'inv1', currencyCode: 'SAR', currencyDecimals: 2,
    journal: { code: 'INV', systemKey: 'SALES' },
    lines: [
      { accountId: 'acc_412001', label: 'مردودات', debitMilli: 100_000n, creditMilli: 0n, customerId: null, vendorId: null, salesRepId: null, partnerName: null, analyticAccountId: null, productId: null, quantity: null, taxId: null, taxRole: null, taxBaseMilli: null, vatBox: null, vatAdjustment: false, dueDate: null },
      { accountId: 'acc_212001', label: 'ضريبة', debitMilli: 15_000n, creditMilli: 0n, customerId: null, vendorId: null, salesRepId: null, partnerName: null, analyticAccountId: null, productId: null, quantity: null, taxId: 'tax_S15_SALE', taxRole: 'TAX', taxBaseMilli: -100_000n, vatBox: 'SA_1', vatAdjustment: true, dueDate: null },
      { accountId: 'acc_113001', label: 'ذمة', debitMilli: 0n, creditMilli: 115_000n, customerId: 'c1', vendorId: null, salesRepId: 'r1', partnerName: 'عميل', analyticAccountId: null, productId: null, quantity: null, taxId: null, taxRole: null, taxBaseMilli: null, vatBox: null, vatAdjustment: false, dueDate: new Date('2026-10-01T00:00:00.000Z') },
    ],
  };
  const d = moveDraftFromRecord(rec);
  assert.equal(d.date, '2026-09-01');
  assert.equal(d.lines[2].dueDate, '2026-10-01');
  const r = reversalDraftFromRecord(rec, { date: '2026-09-16', reason: 'إلغاء المرتجع', originalNumber: 'RINV/2026/09/0001', sourceKey: 'INVOICE:inv1:REVERSE', sourceEvent: 'REVERSE' });
  assert.equal(r.origin, 'AUTO');
  assert.equal(r.sourceType, 'INVOICE');
  assert.equal(r.sourceId, 'inv1');
  assert.equal(r.sequencePrefix, 'RINV');
  assert.equal(r.date, '2026-09-16');
  assert.match(r.narration, /إلغاء المرتجع/);
  assert.deepEqual(r.lines.map((l) => [l.debitMilli, l.creditMilli]), [[0n, 100_000n], [0n, 15_000n], [115_000n, 0n]]);
  assert.equal(r.lines[1].taxBaseMilli, 100_000n);
  assert.equal(r.lines[0].taxBaseMilli, null);
  assert.equal(r.needsAttention, false);
});

// ═══ tenants.ts: تدقيق تبديل العَلَم FLAG_TOGGLE (§5.6 الخطوة 1، §9.3، §10.1 صف M2) ═══

test('tenants.ts PUT /:id: FLAG_TOGGLE داخل $transaction مع tenant.update، مشروطاً بتغير القيمة فعلاً، بمنفّذ OWNER', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../routes/tenants.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(src, /import \{ appendAudit \} from '\.\.\/services\/gl\/audit'/, 'appendAudit غير مستورد من audit.ts');
  const start = src.indexOf("router.put('/:id'");
  assert.ok(start >= 0, 'PUT /:id مفقود');
  const body = src.slice(start, src.indexOf('\n});', start));

  const txStart = body.indexOf('prisma.$transaction(async tx =>');
  assert.ok(txStart >= 0, 'التحديث ليس داخل $transaction تفاعلية');
  const tx = body.slice(txStart);
  const update = tx.indexOf('tx.tenant.update(');
  const audit = tx.indexOf('appendAudit(tx,');
  assert.ok(update > 0, 'tenant.update ليس على tx داخل المعاملة');
  assert.ok(audit > update, 'التدقيق يجب أن يكون في معاملة tenant.update نفسها وبعده');
  assert.doesNotMatch(body.slice(0, txStart), /prisma\.tenant\.update\(|appendAudit\(/, 'لا تحديث ولا تدقيق خارج المعاملة');

  // القيمة السابقة تُقرأ داخل المعاملة، والتدقيق مشروط بتغيرها فعلاً
  assert.ok(tx.indexOf('tx.tenant.findUnique(') >= 0 && tx.indexOf('tx.tenant.findUnique(') < update, 'القيمة السابقة لا تُقرأ داخل المعاملة قبل التحديث');
  const guard = tx.slice(update, audit);
  assert.match(guard, /if \(before && before\.accountingSuiteEnabled !== updated\.accountingSuiteEnabled\)/, 'التدقيق غير مشروط بتغير القيمة');

  const call = tx.slice(audit, tx.indexOf('});', audit));
  assert.match(call, /action: 'FLAG_TOGGLE'/);
  assert.match(call, /actorType: 'OWNER'/);
  assert.match(call, /actorId: req\.user!\.id/);
  assert.match(call, /impersonated: false/);
  assert.match(call, /entityType: 'TENANT'/);
  assert.match(call, /before: \{ accountingSuiteEnabled: before\.accountingSuiteEnabled \}/);
  assert.match(call, /after: \{ accountingSuiteEnabled: updated\.accountingSuiteEnabled \}/);
  // بلا اشتراط GlSettings ولا زرع في مسار المالك
  assert.doesNotMatch(body, /glSettings|seedTemplate/, 'لا GlSettings ولا زرع في PUT /:id');
  // لا كتابة مباشرة على glAuditLog — عبر appendAudit وحده (السلسلة والقفل)
  assert.doesNotMatch(src, /glAuditLog\./, 'tenants.ts يكتب التدقيق عبر appendAudit لا glAuditLog مباشرة');
  // حارس قائمة التجربة يبقى قبل المعاملة
  assert.ok(body.indexOf('LEDGER_PILOT_ONLY') < txStart, 'LEDGER_PILOT_ONLY يجب أن يسبق المعاملة');
  assert.ok(isAuditAction('FLAG_TOGGLE'));
});

test('tenants.ts GET /: glSettings {activatedAt, backfillState} في include قائمة الشركات (§8.1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/tenants.ts'), 'utf8');
  const start = src.indexOf("router.get('/',");
  const body = src.slice(start, src.indexOf('\n});', start));
  const include = body.slice(body.indexOf('include: {'));
  assert.match(include, /glSettings: \{ select: \{ activatedAt: true, backfillState: true \} \}/);
});
