// M3 — «قيد تصحيح حساب رئيسي» CONTROL_ADJUSTMENT (DESIGN.md §5.9، §10.1 صف M3: gl-control-adjust.test.ts).
// يُنشأ من مسار checks وحده بـcanConfigureLedger وسبب؛ سطوره على الحساب المنحرف وشريكه مقابل 911001 فقط، والمبلغ لا يتجاوز
// الانحراف؛ إعفاء I4 بالنوع وحده؛ حارس ثابت أن POST /moves ما زال يرد LEDGER_CONTROL_ACCOUNT_MANUAL؛ C5 يعود أخضر بعد
// تصحيح استرداد وصل بعد إلغاء يدوي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { accountIdOf, journalIdOf, saContext } from '../services/gl/testing/fixtures';
import { validateMove, collectMoveIssues } from '../services/gl/validate';
import { buildManualMoveDraft } from '../services/gl/draft';
import { buildReceiptMove, buildReceiptReversalMove } from '../services/gl/builders/receipt';
import { buildPaylinkFeeMove } from '../services/gl/builders/paylink';
import {
  ControlAdjustmentError, buildControlAdjustmentDraft, controlAdjustmentAmount,
} from '../services/gl/checks/controlAdjustment';
import { c5Gap, evaluateC5 } from '../services/gl/checks/rules';
import { isNoMove, isLedgerError, type BuildResult, type Milli, type MoveDraft } from '../services/gl/types';

const ROUTES = path.join(__dirname, '..', 'routes', 'ledger');
const GL = path.join(__dirname, '..', 'services', 'gl');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ctx = () => saContext();
const AR = accountIdOf('113001');
const CUSTODY = accountIdOf('111003');
const PLNK = accountIdOf('112005');
const SUSP = accountIdOf('911001');

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? tsFiles(p) : d.name.endsWith('.ts') ? [p] : [];
  });
}

/** نص معالج المسار كاملاً من موضع التسجيل حتى القوس المطابق */
function routeText(src: string, marker: string): string {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `المسار غير موجود: ${marker}`);
  let depth = 0;
  for (let j = src.indexOf('(', i); j < src.length; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return src.slice(i);
}

// ═══ الحراس الثابتة ═══

test('حارس ثابت: قيد التصحيح يُنشأ من مسار checks وحده بـcanConfigureLedger وسبب إلزامي', () => {
  const src = read(path.join(ROUTES, 'checks.ts'));
  assert.match(src, /const CONFIGURE = requireLedgerPermission\('canConfigureLedger'\)/);
  const route = routeText(src, "router.post('/checks/:key/control-adjustment'");
  assert.match(route, /^router\.post\('\/checks\/:key\/control-adjustment', CONFIGURE,/);
  assert.match(src, /reason: z\.string\(\)\.trim\(\)\.min\(1\)/, 'السبب إلزامي في مخطط الجسم');
  assert.match(route, /isControlAdjustableCheck\(key\)/, 'C3–C5 وحدها');
  // الانحراف تحت قفل gl-post: القفل أول await في المعاملة ثم إعادة الحساب
  const tx = route.slice(route.indexOf('prisma.$transaction(async (tx) => {'));
  const firstAwait = /await\s+([\w.]+)\(/.exec(tx);
  assert.equal(firstAwait?.[1], 'acquirePostLock');
  assert.ok(tx.indexOf('currentControlDeviation(') > tx.indexOf('acquirePostLock('), 'الانحراف يُحسب بعد القفل');
  assert.ok(tx.indexOf('buildControlAdjustmentDraft(') > tx.indexOf('currentControlDeviation('));
  assert.match(tx, /auditAction: 'MOVE_CONTROL_ADJUST'/);
  assert.match(tx, /notification\.create/);
  assert.match(tx, /validationMode: 'MANUAL', lockPolicy: 'REJECT'/, 'لا يُعفى من تواريخ الإقفال');
});

test("حارس ثابت: moveType 'CONTROL_ADJUSTMENT' لا يُكتب إلا في خدمة checks، وإعفاء I4 في validate.ts بالنوع وحده", () => {
  for (const f of tsFiles(ROUTES)) {
    const src = stripComments(read(f));
    if (path.basename(f) === 'checks.ts') continue;
    assert.doesNotMatch(src, /CONTROL_ADJUSTMENT/, `${path.basename(f)} لا يذكر CONTROL_ADJUSTMENT`);
  }
  const writers = tsFiles(GL).filter((f) => /moveType:\s*'CONTROL_ADJUSTMENT'/.test(stripComments(read(f))));
  assert.deepEqual(writers.map((f) => path.relative(GL, f).replace(/\\/g, '/')), ['checks/controlAdjustment.ts']);
  const validate = stripComments(read(path.join(GL, 'validate.ts')));
  assert.match(validate, /const controlExempt = move\.moveType === 'CONTROL_ADJUSTMENT';/);
  assert.match(validate, /SOURCE_OWNED_CONTROL_KINDS\.includes\(kind\) && !controlExempt/);
});

test('حارس ثابت: POST /moves لا يقبل moveType من الجسم ويبني ENTRY دائماً', () => {
  const moves = read(path.join(ROUTES, 'moves.ts'));
  const schema = moves.slice(moves.indexOf('export const manualMoveSchema = z.object({'), moves.indexOf('type ManualMoveBody'));
  assert.doesNotMatch(schema, /moveType/);
  assert.doesNotMatch(schema, /\.passthrough\(\)/);
  const draft = stripComments(read(path.join(GL, 'draft.ts')));
  const fn = draft.slice(draft.indexOf('export function buildManualMoveDraft('), draft.indexOf('export interface StoredTaxLine'));
  assert.match(fn, /moveType: 'ENTRY'/);
});

test('POST /moves ما زال يرد LEDGER_CONTROL_ACCOUNT_MANUAL على الحسابات الرئيسية (ولو حمل الجسم moveType)', () => {
  const c = ctx();
  const journal = c.journals.bySystemKey('MISC')!;
  const body = {
    journal, date: '2027-03-01', narration: 'محاولة', moveType: 'CONTROL_ADJUSTMENT',
    lines: [
      { accountId: AR, debit: 100, customerId: 'c1', partnerName: 'عميل' },
      { accountId: SUSP, credit: 100 },
    ],
  };
  const built = buildManualMoveDraft(body, c);
  assert.equal(built.draft.moveType, 'ENTRY');
  assert.ok(built.issues.some((i) => i.code === 'LEDGER_CONTROL_ACCOUNT_MANUAL'));
  assert.throws(() => validateMove(built.draft, c), (e: unknown) => isLedgerError(e, 'LEDGER_CONTROL_ACCOUNT_MANUAL'));
  assert.equal(journalIdOf('MISC'), journal.id);
});

// ═══ البناء الصرف ═══

test('سطران فقط: الحساب المنحرف وشريكه مقابل 911001، واتجاههما من إشارة الانحراف', () => {
  const c = ctx();
  // C3: الأستاذ أعلى من المتوقَّع بـ40 ⇒ دائن 113001 للعميل / مدين 911001
  const d3 = buildControlAdjustmentDraft({ key: 'C3', gapMilli: 40_000n, customerId: 'c1', partnerName: 'عميل أول', reason: 'خطأ builder', date: '2027-03-01' }, c);
  assert.equal(d3.moveType, 'CONTROL_ADJUSTMENT');
  assert.equal(d3.origin, 'MANUAL');
  assert.equal(d3.needsAttention, true);
  assert.match(d3.narration, /خطأ builder/);
  assert.equal(d3.lines.length, 2);
  const v3 = validateMove(d3, c);
  assert.deepEqual(v3.lines.map((l) => [l.account.id, l.line.debitMilli, l.line.creditMilli, l.line.customerId ?? null]), [
    [AR, 0n, 40_000n, 'c1'],
    [SUSP, 40_000n, 0n, null],
  ]);
  // C4: الأستاذ أدنى بـ25 ⇒ مدين 111003 للمندوب / دائن 911001
  const d4 = buildControlAdjustmentDraft({ key: 'C4', gapMilli: -25_000n, salesRepId: 'rep1', partnerName: 'مندوب', reason: 'تصحيح', date: '2027-03-01' }, c);
  const v4 = validateMove(d4, c);
  assert.deepEqual(v4.lines.map((l) => [l.account.id, l.line.debitMilli, l.line.creditMilli, l.line.salesRepId ?? null]), [
    [CUSTODY, 25_000n, 0n, 'rep1'],
    [SUSP, 0n, 25_000n, null],
  ]);
  // C5 بلا شريك
  const d5 = buildControlAdjustmentDraft({ key: 'C5', gapMilli: 7_500n, reason: 'استرداد', date: '2027-03-01' }, c);
  assert.deepEqual(validateMove(d5, c).lines.map((l) => [l.account.id, l.line.debitMilli, l.line.creditMilli]), [[PLNK, 0n, 7_500n], [SUSP, 7_500n, 0n]]);
});

test('المبلغ لا يتجاوز الانحراف، والسبب والشريك إلزاميان', () => {
  const c = ctx();
  assert.equal(controlAdjustmentAmount(-30_000n), 30_000n);
  assert.equal(controlAdjustmentAmount(30_000n, 10_000n), 10_000n);
  const reason = (fn: () => unknown, r: string) =>
    assert.throws(fn, (e: unknown) => e instanceof ControlAdjustmentError && e.reason === r);
  reason(() => controlAdjustmentAmount(30_000n, 30_010n), 'AMOUNT_EXCEEDS_DEVIATION');
  reason(() => controlAdjustmentAmount(30_000n, 0n), 'AMOUNT_INVALID');
  reason(() => controlAdjustmentAmount(0n), 'NO_DEVIATION');
  reason(() => buildControlAdjustmentDraft({ key: 'C3', gapMilli: 1_000n, customerId: 'c1', reason: '   ', date: '2027-03-01' }, c), 'REASON_REQUIRED');
  reason(() => buildControlAdjustmentDraft({ key: 'C3', gapMilli: 1_000n, reason: 'x', date: '2027-03-01' }, c), 'PARTNER_REQUIRED');
  reason(() => buildControlAdjustmentDraft({ key: 'C4', gapMilli: 1_000n, reason: 'x', date: '2027-03-01' }, c), 'PARTNER_REQUIRED');
  const partial = buildControlAdjustmentDraft({ key: 'C5', gapMilli: -9_000n, amountMilli: 4_000n, reason: 'جزئي', date: '2027-03-01' }, c);
  assert.deepEqual(partial.lines.map((l) => [l.debitMilli, l.creditMilli]), [[4_000n, 0n], [0n, 4_000n]]);
});

test('إعفاء I4 بنوع القيد وحده، ولا إعفاء من I1 وI5', () => {
  const c = ctx();
  const base = buildControlAdjustmentDraft({ key: 'C3', gapMilli: 5_000n, customerId: 'c1', partnerName: 'عميل', reason: 'x', date: '2027-03-01' }, c);
  assert.doesNotThrow(() => validateMove(base, c));
  // النوع نفسه بغير CONTROL_ADJUSTMENT ⇒ I4
  assert.throws(() => validateMove({ ...base, moveType: 'ENTRY' }, c), (e: unknown) => isLedgerError(e, 'LEDGER_CONTROL_ACCOUNT_MANUAL'));
  // I5: سطر الذمة بلا عميل
  const noPartner: MoveDraft = { ...base, lines: base.lines.map((l, i) => (i === 0 ? { ...l, customerId: null } : l)) };
  assert.ok(collectMoveIssues(noPartner, c).issues.some((i) => i.code === 'LEDGER_PARTNER_REQUIRED'));
  // I1: غير متوازن
  const unbalanced: MoveDraft = { ...base, lines: base.lines.map((l, i) => (i === 1 ? { ...l, debitMilli: l.debitMilli + 10n } : l)) };
  assert.throws(() => validateMove(unbalanced, c), (e: unknown) => isLedgerError(e, 'LEDGER_UNBALANCED'));
});

// ═══ C5 يعود أخضر ═══

function post(ledger: Map<string, Milli>, r: BuildResult, c = ctx()): void {
  assert.ok(!isNoMove(r));
  for (const l of validateMove(r, c).lines) ledger.set(l.account.id, (ledger.get(l.account.id) ?? 0n) + l.line.debitMilli - l.line.creditMilli);
}

test('C5 يعود أخضر بعد تصحيح استرداد وصل بعد إلغاء يدوي لسند ONLINE', () => {
  const c = ctx();
  const ledger = new Map<string, Milli>();
  const original = { salesRepId: null, paymentMethod: 'ONLINE', amount: '100.00', customerId: 'c1', paylinkId: 'link1' };
  // سداد إلكتروني: COLLECTED +100 وFEE −2.30 في دفتر الأمانات؛ P5 مدين 112005، وعمولة الدفع دائن 112005
  post(ledger, buildReceiptMove({ receiptId: 'r1', number: 'R-1', date: '2027-03-01', payload: original, customerName: 'عميل' }, c));
  post(ledger, buildPaylinkFeeMove({ entryId: 'fee1', amount: '-2.30', feeNet: '2.00', feeVat: '0.30', createdAt: '2027-03-01T09:00:00.000Z', linkId: 'link1' }, c));
  let settlement = 100_000n - 2_300n;
  assert.equal(c5Gap({ ledgerMilli: ledger.get(PLNK)!, settlementBalanceMilli: settlement }), 0n);

  // إلغاء يدوي دون استرداد (P6): مدين الذمة / دائن 911001 — الأمانات كما هي، وC5 أخضر
  post(ledger, buildReceiptReversalMove({ receiptId: 'r1', number: 'R-1', date: '2027-03-02', original, reverse: { paylinkId: 'link1' }, customerName: 'عميل' }, c));
  const cancelled = evaluateC5({ ledgerMilli: ledger.get(PLNK)!, settlementBalanceMilli: settlement, pending: false, refundedLinksWithoutRefund: [], cancelledOnlineWithoutRefund: [{ receiptId: 'r1', number: 'R-1', amountMilli: 100_000n }] });
  assert.equal(cancelled.status, 'GREEN');
  assert.equal(ledger.get(SUSP), -100_000n, 'المبلغ على 911001 يلتقطه C9');

  // استرداد الوصل لاحقاً: REFUND −100 في دفتر الأمانات بلا حدث يمسّ الأستاذ ⇒ C5 أحمر بانحراف +100
  settlement -= 100_000n;
  const red = evaluateC5({ ledgerMilli: ledger.get(PLNK)!, settlementBalanceMilli: settlement, pending: false, refundedLinksWithoutRefund: [], cancelledOnlineWithoutRefund: [] });
  assert.equal(red.status, 'RED');
  assert.equal(red.fix, 'CONTROL_ADJUSTMENT');
  const gap = c5Gap({ ledgerMilli: ledger.get(PLNK)!, settlementBalanceMilli: settlement });
  assert.equal(gap, 100_000n);

  // قيد التصحيح بالانحراف ⇒ C5 أخضر، و911001 يعود صفراً
  post(ledger, buildControlAdjustmentDraft({ key: 'C5', gapMilli: gap, reason: 'استرداد وصل بعد إلغاء يدوي', date: '2027-03-05' }, c));
  const green = evaluateC5({ ledgerMilli: ledger.get(PLNK)!, settlementBalanceMilli: settlement, pending: false, refundedLinksWithoutRefund: [], cancelledOnlineWithoutRefund: [] });
  assert.equal(green.status, 'GREEN');
  assert.equal(ledger.get(SUSP), 0n);

  // انحراف مؤقت بانتظار الترحيل ⇒ أصفر، ولا قيد تصحيح (adjustable=false)
  const yellow = evaluateC5({ ledgerMilli: 1_000n, settlementBalanceMilli: 0n, pending: true, refundedLinksWithoutRefund: [], cancelledOnlineWithoutRefund: [] });
  assert.equal(yellow.status, 'YELLOW');
  assert.equal(yellow.rows[0].adjustable, false);
});
