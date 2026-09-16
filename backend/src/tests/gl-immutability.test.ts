// M2 — ثبات المرحَّل (DESIGN.md §2.4، §6.1، §2.1 I7، §9.5 G1/G5، §10.1 صف M2: gl-immutability.test.ts).
// الجزء الأول: خدمات services/gl (هذا الملف). حراس المسارات routes/ledger/** يضيفها وكيل المسارات أدناه بتعديل موضعي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertReversalReason, ownershipOfRecord } from '../services/gl/reverse';
import { manualOwnership, ownerActionFor } from '../services/gl/resolve';
import { isLedgerError, SOURCE_OWNED_CONTROL_KINDS } from '../services/gl/types';

const GL = path.join(__dirname, '../services/gl');
const SERVICE_FILES = ['post.ts', 'reverse.ts', 'draft.ts', 'seed.ts', 'audit.ts', 'resolve.ts'];
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (f: string) => stripComments(fs.readFileSync(path.join(GL, f), 'utf8'));
const allGlFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(GL);
  return out;
};

/** نص كل استدعاء `<re>(` حتى القوس المطابق */
function calls(src: string, re: RegExp): string[] {
  const out: string[] = [];
  const g = new RegExp(re.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = g.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const ch = src[i++];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`export (async )?function ${name}\\b`));
  assert.ok(start >= 0, `الدالة ${name} غير موجودة`);
  const rest = src.slice(start + 10);
  const next = rest.search(/\n(export |async function |function |const [A-Z_]+ = )/);
  return next < 0 ? rest : rest.slice(0, next);
}

function assertOrder(body: string, needles: string[], label: string) {
  let last = -1;
  for (const n of needles) {
    const idx = body.indexOf(n, last + 1);
    assert.ok(idx > last, `${label}: «${n}» مفقود أو خارج الترتيب`);
    last = idx;
  }
}

// ═══ حراس الخدمات ═══

test('الخدمات: لا glMoveLine.update مفرداً ولا upsert، والتحديث الجماعي الوحيد يقلب posted/date/journalId بلا مبالغ', () => {
  for (const f of allGlFiles()) {
    const c = stripComments(fs.readFileSync(f, 'utf8'));
    assert.doesNotMatch(c, /glMoveLine\.(update|upsert)\s*\(/, `${f}: glMoveLine.update ممنوع`);
    const many = calls(c, /glMoveLine\.updateMany\s*\(/);
    if (path.basename(f) !== 'post.ts') assert.equal(many.length, 0, `${f}: glMoveLine.updateMany خارج post.ts`);
    for (const call of many) {
      const data = /data:\s*\{([^}]*)\}/.exec(call)?.[1] ?? '';
      const keys = data.split(',').map((kv) => kv.split(':')[0].trim()).filter(Boolean).sort();
      assert.deepEqual(keys, ['date', 'journalId', 'posted'], `post.ts: حقول قلب السطور ${keys.join(',')}`);
    }
  }
});

test('الخدمات: كل glMove.update/updateMany مشروط بـstate: \'DRAFT\' وnumber: null (لا مساس بمرحَّل)', () => {
  for (const f of allGlFiles()) {
    const c = stripComments(fs.readFileSync(f, 'utf8'));
    assert.doesNotMatch(c, /glMove\.(update|upsert)\s*\(/, `${f}: glMove.update المفرد ممنوع — updateMany بشرط المسودة`);
    for (const call of calls(c, /glMove\.updateMany\s*\(/)) {
      assert.match(call, /state:\s*'DRAFT'/, `${f}: ${call.slice(0, 80)}`);
      assert.match(call, /number:\s*null/, `${f}: ${call.slice(0, 80)}`);
    }
  }
});

test('الخدمات: كل glMove.delete*/glMoveLine.delete* يحمل state: \'DRAFT\' وnumber: null، وحذف المرفقات في حذف المسودة وحده', () => {
  let attachmentDeletes = 0;
  for (const f of allGlFiles()) {
    const c = stripComments(fs.readFileSync(f, 'utf8'));
    for (const call of calls(c, /glMove(Line)?\.(delete|deleteMany)\s*\(/)) {
      assert.match(call, /state:\s*'DRAFT'/, `${f}: ${call}`);
      assert.match(call, /number:\s*null/, `${f}: ${call}`);
    }
    const att = calls(c, /glAttachment(Blob)?\.(delete|deleteMany)\s*\(/);
    if (att.length) {
      assert.equal(path.basename(f), 'reverse.ts', `${f}: حذف مرفق خارج معاملة حذف المسودة`);
      attachmentDeletes += att.length;
    }
    assert.doesNotMatch(c, /glAttachment\.findMany\(\s*\{(?![\s\S]{0,200}select:)/, `${f}: glAttachment.findMany بلا select`);
  }
  assert.equal(attachmentDeletes, 1);
});

test('deleteDraftMove بالترتيب الحرفي (§6.1): القفل ⇒ تدقيق MOVE_DELETE_DRAFT ⇒ glAttachment.deleteMany ⇒ glMove.deleteMany', () => {
  const body = fnBody(code('reverse.ts'), 'deleteDraftMove');
  assertOrder(body, [
    'await acquirePostLock(tx, tenantId)',
    "appendAudit(tx, {",
    "action: 'MOVE_DELETE_DRAFT'",
    "tx.glAttachment.deleteMany({ where: { tenantId, entityType: 'MOVE', entityId: moveId } })",
    "tx.glMove.deleteMany({ where: { id: moveId, tenantId, state: 'DRAFT', number: null } })",
    'deleted.count !== 1',
  ], 'deleteDraftMove');
  assert.match(body, /LEDGER_MOVE_NOT_DRAFT/);
  // اللقطة: الرأس والسطور ونصوص الملاحظات وبيانات المرفقات الوصفية (لا المحتوى)
  assert.match(body, /notes:/);
  assert.match(body, /attachments/);
  assert.doesNotMatch(body, /bytes/);
  // الجماعي كل شيء أو لا شيء: يفحص الكل قبل أي حذف
  assertOrder(fnBody(code('reverse.ts'), 'deleteDraftMoves'), ['deleteDraftRejection(', 'if (rejected.length > 0) return { deleted: [], rejected }', 'deleteDraftMove(tx'], 'deleteDraftMoves');
});

test('reverseMove وresetDraft: السبب أولاً (G5)، وassertManualOwned قبل العكس ونسخة المسودة (I7)', () => {
  const src = code('reverse.ts');
  const rev = fnBody(src, 'reverseMove');
  assertOrder(rev, ['assertReversalReason(opts.reason)', 'acquirePostLock(tx, tenantId)', "mode === 'MANUAL' ? await assertManualOwned(tx, tenantId, moveId)", 'postMove(tx, draft'], 'reverseMove');
  assert.match(rev, /reversedMoveId: rec\.id/);
  assert.match(rev, /reversalReason: reason/);
  const reset = fnBody(src, 'resetDraft');
  assertOrder(reset, ['assertReversalReason(opts.reason)', 'assertManualOwned(tx, tenantId, moveId)', 'reverseMove(tx', 'saveDraftMove(tx'], 'resetDraft');
  assert.match(reset, /origin: 'MANUAL'/);
  assert.match(reset, /draftOfMoveId: rec\.id/);
  assert.match(reset, /auditAction: 'MOVE_RESET_DRAFT'/);
});

test('saveDraftMove: تعديل المسودة مشروط بالمسودة اليدوية، وحذف سطورها بشرط move {state: DRAFT, number: null}', () => {
  const body = fnBody(code('draft.ts'), 'saveDraftMove');
  assertOrder(body, ['acquirePostLock(tx, tenantId)', 'manualOwnership(', 'tx.glMove.updateMany(', 'tx.glMoveLine.deleteMany(', 'tx.glMoveLine.createMany(', "appendAudit(tx"], 'saveDraftMove');
  assert.match(body, /origin: 'MANUAL'/);
});

test('خدمات الكتابة لا تمسّ جداول المصادر القائمة (AccountEntry والفواتير والسندات)', () => {
  for (const f of SERVICE_FILES) {
    assert.doesNotMatch(code(f), /\b(accountEntry|invoice|invoiceItem|receipt|customer|product|companySettings)\.(create|update|upsert|delete)/, f);
  }
});

// ═══ صرفة ═══

test('G5: سبب العكس إلزامي ⇒ LEDGER_REVERSAL_REASON_REQUIRED (422)، ويُشذَّب', () => {
  for (const bad of [undefined, null, '', '   ', 5]) {
    assert.throws(() => assertReversalReason(bad), (e: unknown) => isLedgerError(e, 'LEDGER_REVERSAL_REASON_REQUIRED') && e.httpStatus === 422);
  }
  assert.equal(assertReversalReason('  خطأ في الحساب '), 'خطأ في الحساب');
});

test('I7: القيد مملوك لمصدر بـAUTO أو sourceType أو GlMoveSource أو سطر على حساب رئيسي، ومعه ownerAction', () => {
  const manual = { origin: 'MANUAL', sourceType: null, sourceId: null, moveSources: 0, lineControlKinds: [null, 'VAT_IN', 'SUSPENSE'] };
  assert.equal(manualOwnership(manual), null);
  assert.deepEqual(manualOwnership({ ...manual, origin: 'AUTO', sourceType: 'INVOICE', sourceId: 'i1' }), {
    reasons: ['AUTO_ORIGIN', 'SOURCE_TYPE'], sourceType: 'INVOICE', sourceId: 'i1', ownerAction: 'PATCH /api/invoices/i1/cancel',
  });
  const viaSource = manualOwnership({ ...manual, moveSources: [{ sourceType: 'RECEIPT', sourceId: 'r1' }] });
  assert.deepEqual(viaSource?.reasons, ['MOVE_SOURCE']);
  assert.equal(viaSource?.ownerAction, 'PATCH /api/receipts/r1/cancel');
  for (const kind of SOURCE_OWNED_CONTROL_KINDS) {
    assert.deepEqual(manualOwnership({ ...manual, lineControlKinds: [null, kind] })?.reasons, ['CONTROL_ACCOUNT'], kind);
  }
  assert.equal(ownerActionFor('SETTLEMENT', 's1', 'rep9'), 'DELETE /api/sales-reps/rep9/settlements/s1');
  assert.equal(ownerActionFor('AR_ENTRY', 'e1'), 'POST /api/import/batches/:batchId/revert');
  assert.equal(ownerActionFor(null, null), null);
  const rec = {
    origin: 'MANUAL', sourceType: null, sourceId: null, salesRepId: null, moveType: 'ENTRY',
    sources: [] as { sourceKey: string; sourceType: string; sourceId: string; event: string }[],
    lines: [{ accountId: 'a1' }, { accountId: 'a2' }],
  };
  assert.equal(ownershipOfRecord(rec, () => null), null);
  assert.deepEqual(ownershipOfRecord(rec, (id) => (id === 'a2' ? 'CUSTODY' : null))?.reasons, ['CONTROL_ACCOUNT']);
});

// ═══ حراس المسارات routes/ledger/** (§2.4، §6.1، §9.5 G1) ═══

const ROUTES = path.join(__dirname, '../routes/ledger');
const allRouteFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
    }
  };
  walk(ROUTES);
  return out;
};

/** نص معالج مسار من سطر تسجيله حتى التسجيل أو التعريف التالي */
function routeHandler(src: string, method: string, route: string): string {
  const start = src.indexOf(`router.${method}('${route}'`);
  assert.ok(start >= 0, `${method.toUpperCase()} ${route} غير مسجّل`);
  const next = src.slice(start + 10).search(/\n(router\.(get|post|put|delete|patch)\(|export |async function |function |const )/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 10 + next);
}

test('المسارات: لا glMoveLine.update* ولا upsert إطلاقاً، ولا glMove.update/upsert المفرد', () => {
  const files = allRouteFiles();
  assert.ok(files.some((f) => path.basename(f) === 'moves.ts'), 'routes/ledger/moves.ts موجود');
  for (const f of files) {
    const c = stripComments(fs.readFileSync(f, 'utf8'));
    assert.doesNotMatch(c, /glMoveLine\.(update|updateMany|upsert)\s*\(/, `${f}: glMoveLine.update* ممنوع في المسارات`);
    assert.doesNotMatch(c, /glMove\.(update|upsert)\s*\(/, `${f}: glMove.update المفرد ممنوع في المسارات`);
  }
});

test('المسارات: glMove.updateMany لا يمسّ إلا حقول المراجعة (لا مبالغ ولا حسابات ولا تواريخ على مرحَّل)', () => {
  const allowed = new Set(['reviewState', 'reviewedBy', 'reviewedAt']);
  for (const f of allRouteFiles()) {
    const c = stripComments(fs.readFileSync(f, 'utf8'));
    for (const call of calls(c, /glMove\.updateMany\s*\(/)) {
      const data = /data:\s*\{([^}]*)\}/.exec(call)?.[1];
      assert.ok(data !== undefined, `${f}: data حرفية مطلوبة في ${call.slice(0, 80)}`);
      const keys = data.split(',').map((kv) => kv.split(':')[0].trim()).filter(Boolean);
      for (const k of keys) assert.ok(allowed.has(k), `${f}: glMove.updateMany يكتب ${k}`);
    }
  }
});

test('المسارات: كل glMove.delete*/glMoveLine.delete* يحمل state: \'DRAFT\' وnumber: null، ولا حذف مرفقات خارج معاملة حذف المسودة', () => {
  for (const f of allRouteFiles()) {
    const c = stripComments(fs.readFileSync(f, 'utf8'));
    for (const call of calls(c, /glMove(Line)?\.(delete|deleteMany)\s*\(/)) {
      assert.match(call, /state:\s*'DRAFT'/, `${f}: ${call}`);
      assert.match(call, /number:\s*null/, `${f}: ${call}`);
    }
    assert.doesNotMatch(c, /glAttachment(Blob)?\.(delete|deleteMany)\s*\(/, `${f}: حذف المرفق في deleteDraftMove وحده`);
    assert.doesNotMatch(c, /glAttachment\.findMany\(\s*\{(?![\s\S]{0,200}select:)/, `${f}: glAttachment.findMany بلا select`);
  }
});

test('المسارات: معالجا reverse وreset-draft يستدعيان assertReversalReason ثم assertManualOwned قبل reverseMove/resetDraft (I7، G5)', () => {
  const src = stripComments(fs.readFileSync(path.join(ROUTES, 'moves.ts'), 'utf8'));
  assertOrder(routeHandler(src, 'post', '/moves/:id/reverse'), [
    "requireLedgerPermission('canPostJournals')", 'assertReversalReason(req.body?.reason)', 'assertManualOwned(tx, tenantId, moveId)', 'reverseMove(tx, {',
  ], 'POST /moves/:id/reverse');
  assert.match(routeHandler(src, 'post', '/moves/:id/reverse'), /mode: 'MANUAL'/);
  assertOrder(routeHandler(src, 'post', '/moves/:id/reset-draft'), [
    "requireLedgerPermission('canPostJournals')", 'assertReversalReason(req.body?.reason)', 'assertManualOwned(tx, tenantId, moveId)', 'resetDraft(tx, {',
  ], 'POST /moves/:id/reset-draft');
  // لا مسار آخر يعكس أو يعيد إلى مسودة متجاوزاً الحارس
  for (const f of allRouteFiles()) {
    const c = stripComments(fs.readFileSync(f, 'utf8'));
    const uses = (c.match(/\b(reverseMove|resetDraft)\(tx/g) ?? []).length;
    const guards = (c.match(/assertManualOwned\(tx/g) ?? []).length;
    assert.ok(guards >= uses, `${f}: ${uses} عكس مقابل ${guards} حارس I7`);
  }
});
