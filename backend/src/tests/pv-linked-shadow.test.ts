// «ربط الدفاتر» PV — ظلّ المعاينة يرحّل بسلوك المربوطة الكامل (L4/L5): الإعدادات الافتراضية تحمل linkedPosting والمُطابِق
// linked، وحسابات المربوطة في السياق، فتظهر الأقساط (سطر 113001 لكل قسط باستحقاقه)، وختم «حصّلها المندوب» (111003 بدل
// الصندوق)، والبطاقة (112007)، واستلام مستخدم الشركة (111004 ببُعده adminUserId) — متوازنة بالملّي، بلا كتابة ولا وصول gl*
// من القاعدة، ونافذة العهدة مطفأة في الظلّ. ثم المعاينة كاملةً: R1/R2/R3/R5 وR8–R11 = OK بفرق صفر على شركة بلا مخزون مسعَّر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { settingsSnapshotFromRow } from '../services/gl/resolve';
import { createPreviewShadow, shadowBalanceView } from '../services/gl/linking/shadowStore';
import { virtualContextInput, virtualSettingsRow } from '../services/gl/linking/virtualContext';
import { accountIdOf } from '../services/gl/testing/fixtures';
import { toJsonMilli } from '../services/gl/reports/incomeStatement';
import { FIX_DB_NOW, FIX_T0, FakeDb, TenantFixture, buildLinkingScenario, previewOptionsFor } from './linking-fake-db';
import { PV_TID, allBalanced, linesOnCode, runPvEngine, unsettled } from './pv-shadow-harness';

const at = (iso: string) => new Date(iso);

/** شركة صغيرة بأرقام محلولة: آجل بقسطين، نقدية مختومة، سند بطاقة، واستلامٌ لمستخدم الشركة */
function linkedScenario() {
  const db = new FakeDb({ now: () => FIX_DB_NOW });
  const f = new TenantFixture(db);
  f.tenant({ accountingSuiteEnabled: true });
  f.company();
  const c1 = f.customer('عميل أول');
  const r1 = f.rep('مندوب أول');
  const p1 = f.product('صنف أ');
  db.seed('admin', [{ id: 'u1', tenantId: PV_TID, name: 'أمين الصندوق', email: 'u1@example.test', passwordHash: 'x' }]);
  // آجل 100 + 15% = 115 بقسطين 57.50
  const credit = f.invoice({ type: 'CREDIT', customerId: c1, repId: r1, lines: [{ productId: p1, qty: 10, unitPrice: 10 }], at: at('2027-02-01T08:00:00Z') });
  db.seed('invoiceInstallment', [
    { id: 'ins1', tenantId: PV_TID, invoiceId: credit.id, seq: 1, dueDate: at('2027-03-01T00:00:00Z'), amount: 57.5 },
    { id: 'ins2', tenantId: PV_TID, invoiceId: credit.id, seq: 2, dueDate: at('2027-04-01T00:00:00Z'), amount: 57.5 },
  ]);
  // نقدية 115 مختومة «حصّلها المندوب» ⇒ عهدته لا الصندوق (cashInvoiceRouting = MAIN_CASH)
  const cash = f.invoice({ type: 'CASH', customerId: c1, repId: r1, lines: [{ productId: p1, qty: 2, unitPrice: 50 }], at: at('2027-02-02T08:00:00Z') });
  db.patch('invoice', cash.id, { cashCollectedByRep: true });
  // سند بطاقة 57.50 (POS بمعرّف عملية البطاقة) ⇒ 112007 خارج العهدة
  const card = f.receipt({ customerId: c1, repId: r1, amount: 57.5, method: 'POS', at: at('2027-02-03T08:00:00Z') });
  db.seed('cardPayment', [{
    id: 'cp1', tenantId: PV_TID, invoiceId: credit.id, customerId: c1, salesRepId: r1, amount: 57.5, amountHalalas: 5750, tid: 'T1',
    reference: credit.id, status: 'approved', receiptId: card.id, approvedAt: at('2027-02-03T08:00:00Z'), createdAt: at('2027-02-03T07:59:00Z'),
  }]);
  // استلام النقد 115 من المندوب بيد مستخدم الشركة u1 ⇒ 111004 بالمستخدم
  const st = f.settlement({ repId: r1, amount: 115, at: at('2027-02-10T08:00:00Z') });
  db.patch('repSettlement', st, { receivedByUserId: 'u1' });
  return { db, c1, r1, credit, cash };
}

const opts = () => previewOptionsFor({ inventoryMode: 'PERPETUAL' });

test('الظلّ مربوط: linkedPosting في اللقطة، وlinked للمُطابِق، وLINKED للمُرحِّل، وحسابات المربوطة في السياق', () => {
  const b = createPreviewShadow(PV_TID, opts(), FIX_DB_NOW);
  assert.equal(b.posterSettings.snapshot.linkedPosting, true);
  assert.equal(b.shadow.context.ctx.settings.linkedPosting, true);
  assert.equal(b.reconcileSettings.linked, true);
  assert.equal(b.posterSettings.setupMethod, 'LINKED');
  for (const code of ['111004', '112007', '214002']) assert.equal(b.shadow.context.ctx.accounts.byCode(code)?.id, accountIdOf(code), code);
  // نافذة العهدة المغلقة لا تُطلب من الظلّ (تقرأ جداول الدفاتر الحقيقية): الصفّ الافتراضي بلا linkSnapshotAt والمخزن يطفئها
  // — ويثبته غياب أي وصول gl* في التشغيل أدناه
});

test('لقطةٌ بلا linkedPosting (غير المربوطة) ⇒ سياق القالب حرفاً بلا حسابات المربوطة', () => {
  const row = virtualSettingsRow(opts(), null, FIX_T0);
  const linked = settingsSnapshotFromRow(row);
  const { linkedPosting: _drop, ...plain } = linked;
  const a = virtualContextInput({ templateKey: 'SA_6D', countryCode: 'SA', settings: plain, categoryIncomeAccounts: [] }).contextInput;
  const b = virtualContextInput({ templateKey: 'SA_6D', countryCode: 'SA', settings: linked, categoryIncomeAccounts: [] }).contextInput;
  const extra = new Set(linkedAccountRefs(accountIdOf).map((x) => x.id));
  assert.equal(a.accounts.some((x) => extra.has(x.id)), false);
  assert.deepEqual(b.accounts.filter((x) => !extra.has(x.id)), a.accounts);
  assert.equal(b.accounts.length, a.accounts.length + 3);
});

test('قيود المربوطة في الظلّ بالأرقام: قسطان، ختم، بطاقة 112007، واستلام 111004 بالمستخدم — متوازنة وبلا كتابة', async () => {
  const s = linkedScenario();
  const { shadow } = await runPvEngine(s.db, opts());
  assert.deepEqual(shadow.glViolations, []);
  assert.equal(s.db.writeCount(), 0);
  assert.deepEqual(unsettled(shadow), []);
  assert.ok(allBalanced(shadow));

  // الأقساط: سطران على 113001 بمبلغ كل قسط واستحقاقه (لا سطر واحد بالإجمالي)
  const inst = linesOnCode(shadow, '113001').filter((l) => l.label.includes('قسط'));
  assert.deepEqual(inst.map((l) => [l.debitMilli, l.dueDate]), [[57_500n, '2027-03-01'], [57_500n, '2027-04-01']]);

  // الختم: النقدية المختومة إلى عهدة المندوب 111003 لا الصندوق 111001؛ والاستلام يصفّيها
  const custody = linesOnCode(shadow, '111003');
  assert.deepEqual(custody.map((l) => [l.debitMilli, l.creditMilli, l.salesRepId]), [[115_000n, 0n, s.r1], [0n, 115_000n, s.r1]]);
  assert.deepEqual(linesOnCode(shadow, '111001'), []);

  // البطاقة: 112007 بالمبلغ (لا POS_CLEARING ولا العهدة)
  assert.deepEqual(linesOnCode(shadow, '112007').map((l) => [l.debitMilli, l.creditMilli]), [[57_500n, 0n]]);

  // الاستلام بيد المستخدم: 111004 ببُعد adminUserId وحده (لا salesRepId — ثابت D2)
  const user = linesOnCode(shadow, '111004');
  assert.deepEqual(user.map((l) => [l.debitMilli, l.adminUserId, l.salesRepId]), [[115_000n, 'u1', null]]);
  // loadMoveLines يحمل البعد كـGlMoveLine (للعكس وإعادة البناء)
  assert.equal(shadow.loadMoveLines(user[0].moveId).find((l) => l.accountId === accountIdOf('111004'))?.adminUserId, 'u1');

  // ذمة العميل: 115 + 115 − 115 (تحصيل النقدية) − 57.50 (بطاقة) = 57.50
  const view = shadowBalanceView(shadow);
  assert.equal(view.balanceByPartner([accountIdOf('113001')], 'customerId').get(s.c1), 57_500n);
  const g = view.grandTotals();
  assert.equal(g.debitMilli, g.creditMilli);
});

test('المعاينة كاملةً على الشركة المربوطة: R1 R2 R3 R5 وR8–R11 = OK بفرق صفر، و111004/112007 في الميزان، وصفر كتابات', async () => {
  const { runPreview, defaultPreviewDeps } = await import('../services/gl/linking/preview');
  const s = linkedScenario();
  const r = await runPreview(s.db.client as never, PV_TID, opts(), {}, defaultPreviewDeps);
  const by = new Map(r.parity.map((p) => [p.code, p]));
  for (const code of ['R1', 'R2', 'R3', 'R5', 'R8', 'R9', 'R10', 'R11'] as const) {
    const p = by.get(code)!;
    assert.equal(p.status, 'OK', `${code}: ${JSON.stringify(toJsonMilli({ s: p.status, e: p.expectedMilli, a: p.actualMilli, r: p.reason, info: p.info }))}`);
    assert.equal(p.diffMilli, 0n, code);
  }
  assert.equal(r.trialBalanceByMonth.totals.debitMilli, r.trialBalanceByMonth.totals.creditMilli);
  const codes = new Set(r.trialBalanceByMonth.rows.map((x) => (x as { accountCode?: string; code?: string }).accountCode ?? (x as { code?: string }).code));
  assert.ok(codes.has('111004') && codes.has('112007'), [...codes].join(','));
  assert.equal(s.db.writeCount(), 0);
});

test('سيناريو السنة بمخزون مسعَّر: قيود L6 في الظلّ ⇒ R8–R11 = OK بفرق صفر؛ وبلا قيودها ⇒ NOT_AVAILABLE بسببها ومتوقَّعها', async () => {
  const { runPreview, defaultPreviewDeps } = await import('../services/gl/linking/preview');
  const s = buildLinkingScenario();
  const r = await runPreview(s.db.client as never, PV_TID, previewOptionsFor({ manualRows: [{ accountCode: '111001', debit: 1000 }] }), {}, defaultPreviewDeps);
  const by = new Map(r.parity.map((p) => [p.code, p]));
  for (const code of ['R1', 'R2', 'R3', 'R5'] as const) assert.equal(by.get(code)!.status, 'OK', code);
  const r8 = by.get('R8')!;
  assert.equal(r8.info!.openingTie, 'OK');
  assert.equal(by.get('R9')!.expectedMilli, r.costing.summary.fyCogsMilli);
  // يناير (50 × 6) + ما قبل الربط (100 × 5) في افتتاح 211002 المشتقّ (L7)
  assert.equal(by.get('R11')!.expectedMilli, -800_000n);
  // لا موردين في السيناريو ⇒ R10 محسوب: صفر = صفر
  assert.equal(by.get('R10')!.status, 'OK');
  if (Number(r8.info!.postedLines) > 0) {
    // ترحيل L6 موصول بالظلّ (لقطات الطيّ): المخزون لكل موقع وتكلفة المبيعات والوارد غير المصنَّف بفرق صفر، بلا محجوز
    for (const code of ['R8', 'R9', 'R11'] as const) {
      const p = by.get(code)!;
      assert.equal(p.status, 'OK', `${code}: ${JSON.stringify(toJsonMilli({ e: p.expectedMilli, a: p.actualMilli, info: p.info }))}`);
      assert.equal(p.scope, 'FULL');
      assert.equal(p.diffMilli, 0n);
    }
    assert.ok(r8.drill.some((d) => d.partnerId === 'WH' && d.diffMilli === 0n));
    assert.deepEqual(r.warnings.filter((w) => w.code === 'POSTER_INCOMPLETE'), []);
    assert.equal(r.heldLines.length, 0);
  } else {
    assert.equal(r8.status, 'NOT_AVAILABLE');
    assert.equal(r8.scope, 'OPENING_ONLY');
    assert.equal(r8.reason, 'قيود حركات المخزون تُضاف في L6');
    assert.equal(by.get('R9')!.status, 'NOT_AVAILABLE');
    assert.equal(by.get('R11')!.status, 'NOT_AVAILABLE');
  }
  assert.equal(r.trialBalanceByMonth.totals.debitMilli, r.trialBalanceByMonth.totals.creditMilli);
  assert.equal(s.db.writeCount(), 0);
});
