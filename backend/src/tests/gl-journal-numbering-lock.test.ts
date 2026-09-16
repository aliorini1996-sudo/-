// M2 — G2: قفل ترقيم الدفتر بعد أول ترحيل (DESIGN.md §9.5 G2، §10.1 صف M2: gl-journal-numbering-lock.test.ts).
// (1) الدالة الصرفة journalNumberingViolation، (2) assertJournalNumberingEditable خلف معاملة مزيّفة،
// (3) حارس ثابت على POST/PUT /journals: acquirePostLock ثم assertJournalNumberingEditable ثم الكتابة — بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { GlTx } from '../services/gl/audit';
import { assertJournalNumberingEditable, journalNumberingViolation } from '../services/gl/post';
import { isLedgerError } from '../services/gl/types';

const ROOT = path.join(__dirname, '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const src = (rel: string) => strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/** نص معالج مسار من سطر تسجيله حتى التسجيل التالي. */
function routeBody(file: string, method: string, route: string): string {
  const s = src(file);
  const start = s.indexOf(`router.${method}('${route}'`);
  assert.ok(start >= 0, `${file}: ${method.toUpperCase()} ${route} غير مسجّل`);
  const next = s.slice(start + 10).search(/\n(router\.(get|post|put|delete|patch)\(|export |async function |function |const |type |interface )/);
  return next < 0 ? s.slice(start) : s.slice(start, start + 10 + next);
}

const JOURNAL = { id: 'j1', code: 'MISC', sequenceReset: 'YEARLY' };

// ═══ (1) صرفة ═══

test('G2 صرفة: تغيير code أو sequenceReset لدفتر له قيد مرحَّل ⇒ LEDGER_JOURNAL_HAS_POSTED_MOVES (409) بالحقل', () => {
  const byCode = journalNumberingViolation(JOURNAL, { code: 'GEN' }, 3);
  assert.ok(byCode && isLedgerError(byCode, 'LEDGER_JOURNAL_HAS_POSTED_MOVES'));
  assert.equal(byCode.httpStatus, 409);
  assert.deepEqual(byCode.details.fields, ['code']);
  assert.equal(byCode.details.journalId, 'j1');
  assert.equal(byCode.details.postedMoves, 3);

  const byReset = journalNumberingViolation(JOURNAL, { sequenceReset: 'MONTHLY' }, 1);
  assert.ok(byReset && isLedgerError(byReset, 'LEDGER_JOURNAL_HAS_POSTED_MOVES'));
  assert.deepEqual(byReset.details.fields, ['sequenceReset']);

  const both = journalNumberingViolation(JOURNAL, { code: 'GEN', sequenceReset: 'MONTHLY' }, 1);
  assert.deepEqual(both?.details.fields, ['code', 'sequenceReset']);
});

test('G2 صرفة: بلا قيد مرحَّل ⇒ null، والاسم والحساب الافتراضي (code وsequenceReset بلا تغيير أو غائبان) ⇒ null', () => {
  assert.equal(journalNumberingViolation(JOURNAL, { code: 'GEN', sequenceReset: 'MONTHLY' }, 0), null);
  assert.equal(journalNumberingViolation(JOURNAL, {}, 9), null);
  assert.equal(journalNumberingViolation(JOURNAL, { code: null, sequenceReset: null }, 9), null);
  assert.equal(journalNumberingViolation(JOURNAL, { code: 'MISC', sequenceReset: 'YEARLY' }, 9), null);
});

// ═══ (2) خلف معاملة مزيّفة ═══

function journalTx(opts: { journals: { id: string; tenantId: string; code: string; sequenceReset: string }[]; posted: Record<string, number> }) {
  const calls: string[] = [];
  const tx = {
    glJournal: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => {
        calls.push('glJournal.findFirst');
        const j = opts.journals.find((x) => x.id === where.id && x.tenantId === where.tenantId);
        return j ? { id: j.id, code: j.code, sequenceReset: j.sequenceReset } : null;
      },
      findMany: async ({ where }: { where: { tenantId: string; id?: { not: string } } }) => {
        calls.push('glJournal.findMany');
        return opts.journals.filter((x) => x.tenantId === where.tenantId && (!where.id || x.id !== where.id.not)).map((x) => ({ code: x.code }));
      },
    },
    glMove: {
      count: async ({ where }: { where: { tenantId: string; journalId: string; state: string } }) => {
        calls.push('glMove.count');
        assert.equal(where.state, 'POSTED');
        return opts.posted[`${where.tenantId}|${where.journalId}`] ?? 0;
      },
    },
  };
  return { tx: tx as unknown as GlTx, calls };
}

const JOURNALS = [
  { id: 'inv', tenantId: 't1', code: 'INV', sequenceReset: 'YEARLY' },
  { id: 'misc', tenantId: 't1', code: 'MISC', sequenceReset: 'YEARLY' },
  { id: 'fresh', tenantId: 't1', code: 'NEW', sequenceReset: 'YEARLY' },
  { id: 'other', tenantId: 't2', code: 'ABC', sequenceReset: 'YEARLY' },
];

test('assertJournalNumberingEditable: رمز يساوي رمز دفتر آخر أو بادئة مرتجعه ⇒ LEDGER_JOURNAL_CODE_CONFLICT (409)', async () => {
  const { tx } = journalTx({ journals: JOURNALS, posted: {} });
  await assert.rejects(assertJournalNumberingEditable(tx, { tenantId: 't1', journalId: 'fresh', code: 'INV' }), (e: unknown) => {
    assert.ok(isLedgerError(e, 'LEDGER_JOURNAL_CODE_CONFLICT'));
    assert.equal(e.httpStatus, 409);
    assert.equal(e.details.code, 'INV');
    assert.equal(e.details.conflictsWith, 'INV');
    return true;
  });
  // بادئة المرتجع RINV تصادم INV
  await assert.rejects(assertJournalNumberingEditable(tx, { tenantId: 't1', journalId: 'fresh', code: 'RINV' }), (e: unknown) => isLedgerError(e, 'LEDGER_JOURNAL_CODE_CONFLICT'));
  // الإنشاء (بلا journalId) يمرّ بالفحص نفسه
  await assert.rejects(assertJournalNumberingEditable(tx, { tenantId: 't1', code: 'MISC' }), (e: unknown) => isLedgerError(e, 'LEDGER_JOURNAL_CODE_CONFLICT'));
  // رمز شركة أخرى لا يتصادم
  await assert.doesNotReject(assertJournalNumberingEditable(tx, { tenantId: 't1', journalId: 'fresh', code: 'ABC' }));
});

test('assertJournalNumberingEditable: دفتر شركة أخرى ⇒ غير موجود (404)', async () => {
  const { tx, calls } = journalTx({ journals: JOURNALS, posted: {} });
  await assert.rejects(assertJournalNumberingEditable(tx, { tenantId: 't1', journalId: 'other', code: 'XYZ' }), (e: Error) => e.name === 'GlNotFoundError');
  assert.ok(!calls.includes('glMove.count'));
});

test('assertJournalNumberingEditable: دفتر له قيد مرحَّل يتغيّر رمزه أو دوريته ⇒ LEDGER_JOURNAL_HAS_POSTED_MOVES؛ والاسم وحده يمرّ', async () => {
  const { tx, calls } = journalTx({ journals: JOURNALS, posted: { 't1|misc': 2 } });
  await assert.rejects(assertJournalNumberingEditable(tx, { tenantId: 't1', journalId: 'misc', code: 'GEN' }), (e: unknown) => {
    assert.ok(isLedgerError(e, 'LEDGER_JOURNAL_HAS_POSTED_MOVES'));
    assert.deepEqual(e.details.fields, ['code']);
    return true;
  });
  await assert.rejects(assertJournalNumberingEditable(tx, { tenantId: 't1', journalId: 'misc', sequenceReset: 'MONTHLY' }), (e: unknown) => isLedgerError(e, 'LEDGER_JOURNAL_HAS_POSTED_MOVES'));
  calls.length = 0;
  // تعديل الاسم أو الحساب الافتراضي يرسل code/sequenceReset null أو بلا تغيير
  await assert.doesNotReject(assertJournalNumberingEditable(tx, { tenantId: 't1', journalId: 'misc', code: null, sequenceReset: null }));
  await assert.doesNotReject(assertJournalNumberingEditable(tx, { tenantId: 't1', journalId: 'misc', code: 'MISC', sequenceReset: 'YEARLY' }));
  assert.ok(!calls.includes('glMove.count'), 'بلا تغيير في الترقيم لا عدّ للمرحَّل');
  // دفتر بلا مرحَّل: تغيير الرمز مسموح
  await assert.doesNotReject(assertJournalNumberingEditable(tx, { tenantId: 't1', journalId: 'fresh', code: 'NEW2', sequenceReset: 'MONTHLY' }));
});

// ═══ (3) حارس ثابت على المسارات ═══

test('حارس ثابت: POST وPUT /journals يأخذان قفل الترحيل ثم يفحصان الترقيم ثم يكتبان', () => {
  const config = 'routes/ledger/config.ts';
  const post = routeBody(config, 'post', '/journals');
  const a = post.indexOf('acquirePostLock(');
  const b = post.indexOf('assertJournalNumberingEditable(');
  const c = post.indexOf('glJournal.create(');
  assert.ok(a >= 0 && b > a && c > b, `POST /journals: الترتيب ${a} < ${b} < ${c}`);

  const put = routeBody(config, 'put', '/journals/:id');
  const pa = put.indexOf('acquirePostLock(');
  const pb = put.indexOf('assertJournalNumberingEditable(');
  const pc = put.indexOf('glJournal.update(');
  assert.ok(pa >= 0 && pb > pa && pc > pb, `PUT /journals/:id: الترتيب ${pa} < ${pb} < ${pc}`);
  const call = put.slice(pb, put.indexOf(');', pb));
  assert.match(call, /journalId: id\b/);
  assert.match(call, /\bcode\b/);
  assert.match(call, /\bsequenceReset\b/);
  // لا مسار آخر يكتب code أو sequenceReset للدفتر
  assert.equal([...src(config).matchAll(/glJournal\.update\(/g)].length, 1, 'glJournal.update في PUT /journals/:id وحده');
});
