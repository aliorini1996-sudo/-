// «ربط الدفاتر» L4+L5+L8 — المنفّذ A2 (النواة والسياق والحسابات)، العقد §3.1 و§3.3 و§4.5 وD1/D2/D3/D13.
// بلا قاعدة: مخازن مزيّفة بالشكل الذي تلمسه الدوال. الثوابت المحمية:
//  - اليدوية والقديمة وغير المفعّلة: لقطة الإعدادات والسياق ومسودة القيد وإدراج السطور كما كانت حرفاً (مساواة عميقة).
//  - المربوطة وحدها: linkedPosting وخريطة الطرق، وبُعد المستخدم adminUserId على 111004.
//  - الحسابات الثلاثة خارج القالب الافتراضي، وتُنشأ متساوية الأثر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GL_SETTINGS, LEDGER_ERROR_HTTP, LedgerError, MAPPING_KEYS, MOVE_TYPES, PAYMENT_METHOD_MAP_KEYS, SOURCE_TYPES,
  createBuildContext, isLedgerError, isPaymentMethodMapKey,
  type LineDraft, type MoveDraft,
} from '../services/gl/types';
import {
  MOVE_LINE_ENGINE_SELECT, MOVE_RECORD_SELECT, buildContextFromRows, loadBuildContext, manualOwnership, moveDraftFromRecord,
  ownerActionFor, paymentMethodMapsOf, settingsSnapshotFromRow, type GlDb, type LedgerContext,
} from '../services/gl/resolve';
import { reversalDraftFromRecord } from '../services/gl/reverse';
import { collectMoveIssues, validateMove } from '../services/gl/validate';
import { postMove, type GlTx } from '../services/gl/post';
import { SYSTEM_ACTOR } from '../services/gl/audit';
import { SA_6D_ACCOUNTS, SA_6D_ACCOUNT_DESCRIPTIONS, SA_6D_ACCOUNT_GROUPS, SA_6D_MAPPINGS } from '../services/gl/coa/sa';
import { genericTemplate } from '../services/gl/coa/generic';
import {
  CARD_CLEARING_CODE, CUSTOMER_CREDITS_CODE, LINKED_EXTRA_ACCOUNTS, LINKED_EXTRA_ACCOUNT_CODES, USER_CUSTODY_CODE,
  ensureLinkedAccounts, linkedAccountCreateRows, linkedAccountRefs, planLinkedAccounts, type LinkedAccountsDb,
} from '../services/gl/coa/linkedAccounts';
import {
  planEvent, siblingGate, tombstoneOrigin, userSettlementOrderReady, type CutoverContext,
} from '../services/gl/sync/classify';
import { accountIdOf, saContext } from '../services/gl/testing/fixtures';

const M = (units: number): bigint => BigInt(Math.round(units * 1000));

// ═══ §3.1 الأنواع ═══

test('A2 §3.1: المصادر والأنواع تُلحق في الآخر، والقوائم القائمة بترتيبها حرفاً', () => {
  assert.deepEqual(SOURCE_TYPES.slice(0, 10), [
    'INVOICE', 'RECEIPT', 'AR_ENTRY', 'SETTLEMENT', 'PAYLINK_FEE', 'PAYOUT', 'WH_ENTRY', 'VAN_LOAD', 'RESTOCK', 'CUSTOMER_ADJUSTMENT',
  ]);
  assert.deepEqual(SOURCE_TYPES.slice(10), ['USER_SETTLEMENT', 'PAYLINK_REFUND']);
  assert.equal(MOVE_TYPES[MOVE_TYPES.length - 1], 'CUSTOMER_REFUND');
  assert.equal(MOVE_TYPES.indexOf('CONTROL_ADJUSTMENT'), MOVE_TYPES.length - 2);
  assert.equal(new Set(MOVE_TYPES).size, MOVE_TYPES.length);
  assert.deepEqual([...PAYMENT_METHOD_MAP_KEYS], ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'CARD', 'PAYOUT']);
  assert.ok(isPaymentMethodMapKey('CARD'));
  assert.equal(isPaymentMethodMapKey('ONLINE'), false, 'ONLINE غير قابل للربط (D3)');
  assert.equal(isPaymentMethodMapKey('c_stc'), false, 'المخصّص يُتحقَّق منه بـCUSTOM_METHOD_KEY_RE في المسار');
});

test('A2 §3.1: رموز الأخطاء الخمسة الجديدة بحالاتها، وLedgerError يحملها', () => {
  assert.equal(LEDGER_ERROR_HTTP.LEDGER_BOOKS_NOT_LINKED, 409);
  assert.equal(LEDGER_ERROR_HTTP.LEDGER_METHOD_ACCOUNT_INVALID, 422);
  assert.equal(LEDGER_ERROR_HTTP.LEDGER_ADJUSTMENT_ALLOCATION_INVALID, 422);
  assert.equal(LEDGER_ERROR_HTTP.LEDGER_CLEARING_INVALID, 422);
  assert.equal(LEDGER_ERROR_HTTP.LEDGER_ROUTING_CUSTODY_NONCASH, 422);
  const e = new LedgerError('LEDGER_ROUTING_CUSTODY_NONCASH', { methods: ['POS'] });
  assert.equal(e.httpStatus, 422);
  assert.ok(isLedgerError(e, 'LEDGER_ROUTING_CUSTODY_NONCASH'));
  // القائمة لم تتغيّر قيمها
  assert.equal(LEDGER_ERROR_HTTP.LEDGER_PARTNER_REQUIRED, 422);
  assert.equal(LEDGER_ERROR_HTTP.LEDGER_NOT_SETUP, 409);
});

test('A2 D1: DEFAULT_GL_SETTINGS بلا linkedPosting، وcreateBuildContext بلا خريطة = شكل السياق القائم حرفاً', () => {
  assert.equal('linkedPosting' in DEFAULT_GL_SETTINGS, false);
  const plain = createBuildContext({ accounts: [], mappings: {} });
  assert.deepEqual(Object.keys(plain), ['settings', 'accounts', 'taxes', 'journals', 'categoryAccounts', 'repAnalytic']);
  assert.equal('paymentMethodAccount' in plain, false);
  assert.deepStrictEqual(plain.settings, { ...DEFAULT_GL_SETTINGS });
  // linkedPosting يمرّ من الإعدادات كما هو
  assert.equal(createBuildContext({ accounts: [], mappings: {}, settings: { linkedPosting: true } }).settings.linkedPosting, true);
});

test('A2 D3: paymentMethodAccount مع الخريطة وحدها — المفتاح المخصّص والأساس، والمجهول null، ومفاتيح النموذج الأولي لا تُقرأ', () => {
  const ctx = createBuildContext({
    accounts: [], mappings: {},
    paymentMethodMaps: { c_stc: { accountId: 'acc_111102', journalId: null }, BANK_TRANSFER: { accountId: 'acc_111101', journalId: 'jrn_BNK1' } },
  });
  assert.equal(typeof ctx.paymentMethodAccount, 'function');
  assert.deepEqual(ctx.paymentMethodAccount?.('c_stc'), { accountId: 'acc_111102', journalId: null });
  assert.deepEqual(ctx.paymentMethodAccount?.('BANK_TRANSFER'), { accountId: 'acc_111101', journalId: 'jrn_BNK1' });
  assert.equal(ctx.paymentMethodAccount?.('CASH'), null);
  assert.equal(ctx.paymentMethodAccount?.('constructor'), null);
  assert.equal(ctx.paymentMethodAccount?.('__proto__'), null);
  // خريطة فارغة صريحة ⇒ الدالة موجودة وتعيد null (مربوطة بلا صفوف)
  const empty = createBuildContext({ accounts: [], mappings: {}, paymentMethodMaps: {} });
  assert.equal(empty.paymentMethodAccount?.('CASH'), null);
  assert.deepEqual(paymentMethodMapsOf([{ methodKey: 'CARD', accountId: 'a', journalId: null }]), { CARD: { accountId: 'a', journalId: null } });
});

test('A2 D3: journals.byId يحلّ دفتر صف الخريطة (journalId) لما يكرّمه الـbuilder', () => {
  const ctx = saContext();
  assert.equal(ctx.journals.byId?.('jrn_BNK1')?.code, 'BNK1');
  assert.equal(ctx.journals.byId?.('jrn_RCPT')?.systemKey, 'RECEIPTS');
  assert.equal(ctx.journals.byId?.('missing'), null);
});

// ═══ D1: لقطة الإعدادات ═══

const ROW = {
  ...DEFAULT_GL_SETTINGS, cutoverDate: new Date('2026-01-01T00:00:00.000Z'), perpetualFromDate: null,
  salesLockDate: null, purchaseLockDate: null, taxLockDate: new Date('2026-03-31T00:00:00.000Z'),
  hardLockDate: null, paylinkFeeTaxInvoiceFrom: null, receiptRouting: { CASH: 'CUSTODY', ONLINE: 'CUSTODY', POS: 'X' },
};
/** مخرج settingsSnapshotFromRow لـROW قبل «ربط الدفاتر» — ثابت ذهبي */
const GOLDEN_SNAPSHOT = { ...DEFAULT_GL_SETTINGS, cutoverDate: '2026-01-01', taxLockDate: '2026-03-31', receiptRouting: { CASH: 'CUSTODY' } };
const ACTIVATED = new Date('2026-11-01T08:00:00.000Z');

test('A2 D1 ذهبي: اليدوية والقديمة وغير المفعّلة ⇒ اللقطة نفسها حرفاً بلا مفتاح linkedPosting', () => {
  const cases: { setupMethod?: string | null; activatedAt?: Date | null }[] = [
    {}, { setupMethod: null, activatedAt: null }, { setupMethod: 'CLEAN', activatedAt: ACTIVATED },
    { setupMethod: 'CLEAN', activatedAt: null }, { setupMethod: 'LINKED', activatedAt: null },
    { setupMethod: 'OPENING', activatedAt: ACTIVATED }, { setupMethod: 'FULL_HISTORY', activatedAt: ACTIVATED },
    { setupMethod: 'WEIRD', activatedAt: ACTIVATED },
  ];
  for (const c of cases) {
    const snap = settingsSnapshotFromRow({ ...ROW, ...c });
    assert.deepStrictEqual(snap, GOLDEN_SNAPSHOT, JSON.stringify(c));
    assert.equal(Object.prototype.hasOwnProperty.call(snap, 'linkedPosting'), false, JSON.stringify(c));
  }
});

test('A2 D1: المربوطة المفعّلة وحدها ⇒ linkedPosting: true وبقية اللقطة كما هي', () => {
  const snap = settingsSnapshotFromRow({ ...ROW, setupMethod: 'LINKED', activatedAt: ACTIVATED });
  assert.deepStrictEqual(snap, { ...GOLDEN_SNAPSHOT, linkedPosting: true });
  const lc = buildContextFromRows({ settings: { ...ROW, setupMethod: 'LINKED', activatedAt: ACTIVATED }, accounts: [], mappings: [], taxes: [], journals: [] });
  assert.equal(lc.ctx.settings.linkedPosting, true);
  // بلا صفوف خريطة ⇒ لا paymentMethodAccount (buildContextFromRows لا يخترعها)
  assert.equal('paymentMethodAccount' in lc.ctx, false);
});

// ═══ loadBuildContext: الخريطة للمربوطة وحدها، بلا استعلام زائد لغيرها ═══

function fakeContextDb(settings: Record<string, unknown> | null, maps: { methodKey: string; accountId: string; journalId: string | null }[]) {
  const mapCalls: unknown[] = [];
  const db = {
    glSettings: { findUnique: async () => settings },
    glAccount: { findMany: async () => [{ id: 'a1', code: '111102', name: 'بنك ثانٍ', type: 'asset_cash', isActive: true, reconcile: false, controlKind: null }] },
    glAccountMapping: { findMany: async () => [] },
    glTax: { findMany: async () => [] },
    glJournal: { findMany: async () => [] },
    glProductCategoryAccount: { findMany: async () => [] },
    glRepAnalyticDefault: { findMany: async () => [] },
    glPaymentMethodMap: { findMany: async (args: unknown) => { mapCalls.push(args); return maps; } },
  };
  return { db: db as unknown as GlDb, mapCalls };
}

test('A2 D3: loadBuildContext يقرأ GlPaymentMethodMap للمربوطة وحدها (شرط الشركة وحدها)، ولا يلمسه لغيرها', async () => {
  const maps = [{ methodKey: 'c_stc', accountId: 'a1', journalId: null }];
  const notLinked: (Record<string, unknown> | null)[] = [
    null, { ...ROW }, { ...ROW, setupMethod: 'CLEAN', activatedAt: ACTIVATED }, { ...ROW, setupMethod: 'OPENING', activatedAt: ACTIVATED },
    { ...ROW, setupMethod: 'LINKED', activatedAt: null },
  ];
  for (const s of notLinked) {
    const { db, mapCalls } = fakeContextDb(s, maps);
    const lc = await loadBuildContext(db, 't1');
    assert.equal(mapCalls.length, 0, `لا استعلام خريطة: ${JSON.stringify(s?.setupMethod ?? null)}`);
    assert.equal('paymentMethodAccount' in lc.ctx, false);
    assert.equal(lc.ctx.settings.linkedPosting, undefined);
  }
  const { db, mapCalls } = fakeContextDb({ ...ROW, setupMethod: 'LINKED', activatedAt: ACTIVATED }, maps);
  const lc = await loadBuildContext(db, 't1');
  assert.equal(mapCalls.length, 1);
  assert.deepEqual(mapCalls[0], { where: { tenantId: 't1' }, select: { methodKey: true, accountId: true, journalId: true } });
  assert.equal(lc.ctx.settings.linkedPosting, true);
  assert.deepEqual(lc.ctx.paymentMethodAccount?.('c_stc'), { accountId: 'a1', journalId: null });
  assert.equal(lc.ctx.paymentMethodAccount?.('CASH'), null);
  assert.equal(lc.ctx.accounts.byId('a1')?.code, '111102');
});

// ═══ adminUserId: القراءة والمسودة والعكس ═══

const REC_LINE_BASE = {
  vendorId: null, analyticAccountId: null, productId: null, quantity: null, taxId: null, taxRole: null, taxBaseMilli: null,
  vatBox: null, vatAdjustment: false, dueDate: null, customerId: null,
};
function record(lines: Record<string, unknown>[]) {
  return {
    moveType: 'CUSTODY_SETTLEMENT', origin: 'AUTO', date: new Date('2026-11-14T00:00:00.000Z'), originalDate: null, lateArrival: false,
    ref: 'STL-1', narration: 'استلام تحصيل', needsAttention: false, attentionReason: null, customerId: null, vendorId: null, salesRepId: 'r1',
    sourceType: 'SETTLEMENT', sourceId: 's1', currencyCode: 'SAR', currencyDecimals: 2,
    journal: { code: 'CUST', systemKey: 'CUSTODY' },
    lines: lines as never,
  };
}

test('A2 L5: MOVE_RECORD_SELECT يحمل adminUserId، وMOVE_LINE_ENGINE_SELECT كما هو (ردّ GET /moves/:id لا يتغيّر)', () => {
  assert.equal((MOVE_RECORD_SELECT.lines.select as Record<string, unknown>).adminUserId, true);
  assert.equal('adminUserId' in MOVE_LINE_ENGINE_SELECT, false);
  for (const k of Object.keys(MOVE_LINE_ENGINE_SELECT)) assert.equal((MOVE_RECORD_SELECT.lines.select as Record<string, unknown>)[k], true, k);
});

test('A2 L5: moveDraftFromRecord يحمل adminUserId حين يوجد وحده، والعكس يقلب الجانبين ويُبقيه (E5.10)', () => {
  const rec = record([
    { ...REC_LINE_BASE, accountId: 'acc_111004', label: 'عهدة المستخدم', debitMilli: M(800), creditMilli: 0n, salesRepId: null, partnerName: 'سارة', adminUserId: 'u1' },
    { ...REC_LINE_BASE, accountId: 'acc_111003', label: 'عهدة المندوب', debitMilli: 0n, creditMilli: M(800), salesRepId: 'r1', partnerName: 'خالد', adminUserId: null },
  ]);
  const d = moveDraftFromRecord(rec);
  assert.equal(d.lines[0].adminUserId, 'u1');
  assert.equal(Object.prototype.hasOwnProperty.call(d.lines[1], 'adminUserId'), false, 'null لا يُكتب مفتاحاً');
  const r = reversalDraftFromRecord(rec, { date: '2026-11-20', reason: 'حذف الاستلام' });
  assert.equal(r.lines[0].adminUserId, 'u1');
  assert.equal(r.lines[0].creditMilli, M(800));
  assert.equal(r.lines[1].debitMilli, M(800));
  assert.equal(Object.prototype.hasOwnProperty.call(r.lines[1], 'adminUserId'), false);
});

test('A2 ذهبي: مسودة قيد قديم بلا عمود adminUserId = مخرج اليوم بمفاتيح السطر نفسها', () => {
  const rec = record([
    { ...REC_LINE_BASE, accountId: 'acc_111001', label: 'الصندوق', debitMilli: M(500), creditMilli: 0n, salesRepId: null, partnerName: null },
    { ...REC_LINE_BASE, accountId: 'acc_111003', label: 'عهدة المندوب', debitMilli: 0n, creditMilli: M(500), salesRepId: 'r1', partnerName: 'خالد' },
  ]);
  const d = moveDraftFromRecord(rec);
  const KEYS = ['accountId', 'label', 'debitMilli', 'creditMilli', 'customerId', 'vendorId', 'salesRepId', 'partnerName',
    'analyticAccountId', 'productId', 'quantity', 'taxId', 'taxRole', 'taxBaseMilli', 'vatBox', 'vatAdjustment', 'dueDate'];
  for (const l of d.lines) assert.deepEqual(Object.keys(l), KEYS);
});

test('A2 §3.1: ownerActionFor(USER_SETTLEMENT) ومسار الحذف، والمصدران الجديدان مملوكان (I7)', () => {
  assert.equal(ownerActionFor('USER_SETTLEMENT', 'us1'), 'DELETE /api/company-users/:userId/settlements/us1');
  assert.equal(ownerActionFor('USER_SETTLEMENT', null), 'DELETE /api/company-users/:userId/settlements/:id');
  assert.equal(ownerActionFor('PAYLINK_REFUND', 'e1'), null);
  for (const sourceType of ['USER_SETTLEMENT', 'PAYLINK_REFUND']) {
    const o = manualOwnership({ origin: 'AUTO', sourceType, sourceId: 'x1', moveSources: [{ sourceType, sourceId: 'x1' }], lineControlKinds: ['CUSTODY'] });
    assert.ok(o);
    assert.deepEqual(o.reasons, ['AUTO_ORIGIN', 'SOURCE_TYPE', 'MOVE_SOURCE', 'CONTROL_ACCOUNT']);
  }
});

// ═══ D2: validate — العهدة لشريك واحد ═══

const linkedCtx = () => saContext({ extraAccounts: linkedAccountRefs(accountIdOf), settings: { linkedPosting: true } });

function move(lines: LineDraft[], o: Partial<MoveDraft> = {}): MoveDraft {
  return {
    kind: 'MOVE', journalCode: 'CUST', journalSystemKey: 'CUSTODY', moveType: 'CUSTODY_SETTLEMENT', origin: 'AUTO',
    date: '2026-11-14', narration: 'استلام تحصيل', needsAttention: false, currencyCode: 'SAR', currencyDecimals: 2, lines, ...o,
  };
}
const ln = (code: string, debit: number, credit: number, extra: Partial<LineDraft> = {}): LineDraft => ({
  accountCode: code, label: `سطر ${code}`, debitMilli: M(debit), creditMilli: M(credit), ...extra,
});

test('A2 D2: سطر CUSTODY بالمندوب والمستخدم معاً ⇒ LEDGER_PARTNER_REQUIRED بسبب CUSTODY_PARTNER_AMBIGUOUS', () => {
  const ctx = linkedCtx();
  const bad = move([
    ln(USER_CUSTODY_CODE, 800, 0, { adminUserId: 'u1', salesRepId: 'r1', partnerName: 'سارة' }),
    ln('111003', 0, 800, { salesRepId: 'r1', partnerName: 'خالد' }),
  ]);
  assert.throws(() => validateMove(bad, ctx), (e: unknown) => isLedgerError(e, 'LEDGER_PARTNER_REQUIRED')
    && (e as LedgerError).details.reason === 'CUSTODY_PARTNER_AMBIGUOUS' && (e as LedgerError).details.invariant === 'I5'
    && (e as LedgerError).details.lineIndex === 0);
  // وعلى 111003 أيضاً (الحكم بنوع الحساب لا برمزه)
  const bad2 = move([ln('111003', 800, 0, { adminUserId: 'u1', salesRepId: 'r1' }), ln('111001', 0, 800)]);
  assert.deepEqual(collectMoveIssues(bad2, ctx).issues.map((i) => i.reason), ['CUSTODY_PARTNER_AMBIGUOUS']);
  // حساب غير رقابي يقبل البُعدين (لا ثابت عليه)
  const ok = move([ln('111001', 800, 0, { adminUserId: 'u1', salesRepId: 'r1' }), ln('111003', 0, 800, { salesRepId: 'r1' })]);
  assert.equal(collectMoveIssues(ok, ctx).issues.length, 0);
  // نصّ فارغ ليس شريكاً
  const blank = move([ln(USER_CUSTODY_CODE, 800, 0, { adminUserId: 'u1', salesRepId: '  ' }), ln('111003', 0, 800, { salesRepId: 'r1' })]);
  assert.equal(collectMoveIssues(blank, ctx).issues.length, 0);
});

test('A2 أمثلة العقد L5 بالحسابات الجديدة: متّزنة وصالحة، وأرصدة العهدة تُصفَّر بالشريك (E5.6، E5.7، E5.8، E5.10، E5.11، E5.4)', () => {
  const ctx = linkedCtx();
  const R = { salesRepId: 'r1', partnerName: 'خالد' };
  const U = { adminUserId: 'u1', partnerName: 'سارة' };
  const C = { customerId: 'c1', partnerName: 'عميل', salesRepId: 'r1' };
  const rcpt = { journalCode: 'RCPT', journalSystemKey: 'RECEIPTS' as const, moveType: 'CUST_RECEIPT' as const };
  const flows: MoveDraft[] = [
    // E5.6 شيك بمندوب ثم مستخدم ثم بنك
    move([ln('111003', 700, 0, R), ln('113001', 0, 700, C)], rcpt),
    move([ln(USER_CUSTODY_CODE, 700, 0, U), ln('111003', 0, 700, R)]),
    move([ln('112003', 700, 0), ln(USER_CUSTODY_CODE, 0, 700, U)]),
    // E5.10 نقد 800 من R إلى U، وتحويل 800 بمستخدم إلى البنك (لا 111004 لغير النقد — OD5)
    move([ln(USER_CUSTODY_CODE, 800, 0, U), ln('111003', 0, 800, R)]),
    move([ln('111101', 800, 0), ln('111003', 0, 800, R)]),
    // E5.11 توريد U 800 نقداً
    move([ln('111001', 800, 0), ln(USER_CUSTODY_CODE, 0, 800, U)]),
    // سندا المندوب اللذان غذّيا E5.10
    move([ln('111003', 1600, 0, R), ln('113001', 0, 1600, C)], rcpt),
    // E5.7 إلغاء بعد التسليم بـUSER_CUSTODY: السند ثم الاستلام بالمستخدم ثم العكس من عهدته
    move([ln('111003', 500, 0, R), ln('113001', 0, 500, C)], rcpt),
    move([ln(USER_CUSTODY_CODE, 500, 0, U), ln('111003', 0, 500, R)]),
    move([ln('113001', 500, 0, C), ln(USER_CUSTODY_CODE, 0, 500, U)], rcpt),
    // E5.8 استرداد بعد إلغاء يدوي: الرابط ثم الإلغاء إلى 214002 ثم الاسترداد
    move([ln('112005', 1000, 0), ln('113001', 0, 1000, C)], rcpt),
    move([ln('113001', 1000, 0, C), ln(CUSTOMER_CREDITS_CODE, 0, 1000)], rcpt),
    move([ln(CUSTOMER_CREDITS_CODE, 1000, 0), ln('112005', 0, 1000)], { journalCode: 'PLNK', journalSystemKey: 'PAYLINK', moveType: 'CUSTOMER_REFUND' }),
    // E5.4 بطاقة: 112007 لا العهدة، والعكس بالمرآة
    move([ln(CARD_CLEARING_CODE, 230, 0), ln('113001', 0, 230, C)], rcpt),
    move([ln('113001', 230, 0, C), ln(CARD_CLEARING_CODE, 0, 230)], rcpt),
  ];
  const bal = new Map<string, bigint>();
  for (const [i, f] of flows.entries()) {
    const v = validateMove(f, ctx);
    assert.equal(v.totalDebitMilli, v.totalCreditMilli, `القيد ${i}`);
    for (const r of v.lines) {
      const who = r.line.adminUserId ?? r.line.salesRepId ?? r.line.customerId ?? '';
      const k = `${r.account.code}|${r.account.controlKind === 'AR' ? r.line.customerId : who}`;
      bal.set(k, (bal.get(k) ?? 0n) + r.line.debitMilli - r.line.creditMilli);
    }
  }
  assert.equal(bal.get('111003|r1'), 0n, '111003 للمندوب يُصفَّر (E5.6/E5.7: لا −500)');
  assert.equal(bal.get('111004|u1'), 0n, '111004 للمستخدم يُصفَّر بعد التوريد والاسترداد');
  assert.equal(bal.get('214002|'), 0n);
  assert.equal(bal.get('112005|'), 0n);
  assert.equal(bal.get('112007|'), 0n);
  assert.equal(bal.get('112003|'), M(700));
  assert.equal(bal.get('111101|'), M(800));
  assert.equal(bal.get('111001|'), M(800));
  // 113001: سندات 700 + 1600 + 500 + 1000 + 230 − ردّ 500 − إلغاء 1000 − عكس 230 = −2300 (المجموع = Σ المدين الآخر)
  assert.equal(bal.get('113001|c1'), -M(2300));
  let total = 0n;
  for (const v of bal.values()) total += v;
  assert.equal(total, 0n);
});

test('A2 I4 مع الحسابات الجديدة: القيد اليدوي لا يمسّ 111004 (عهدة)، ويمسّ 112007 و214002 (التسوية الموجّهة E5.14)', () => {
  const ctx = linkedCtx();
  const manual = { origin: 'MANUAL' as const, journalCode: 'BNK1', journalSystemKey: 'BANK_MAIN' as const, moveType: 'ENTRY' as const };
  assert.throws(() => validateMove(move([ln('111001', 100, 0), ln(USER_CUSTODY_CODE, 0, 100, { adminUserId: 'u1' })], manual), ctx),
    (e: unknown) => isLedgerError(e, 'LEDGER_CONTROL_ACCOUNT_MANUAL'));
  // E5.14 بطاقة: Dr 111101 1,940.50 / Dr 611008 51.73 / Dr 116001 7.77 [S15_PURCH، SA_7] / Cr 112007 2,000.00
  const card = move([
    ln('111101', 1940.5, 0), ln('611008', 51.73, 0), ln('116001', 7.77, 0, { taxCode: 'S15_PURCH', taxRole: 'TAX', vatBox: 'SA_7', taxBaseMilli: M(51.73) }),
    ln(CARD_CLEARING_CODE, 0, 2000),
  ], manual);
  const v = validateMove(card, ctx);
  assert.equal(v.totalDebitMilli, M(2000));
  assert.equal(v.totalCreditMilli, M(2000));
  validateMove(move([ln(CUSTOMER_CREDITS_CODE, 50, 0), ln('111001', 0, 50)], manual), ctx);
});

// ═══ post.ts: كتابة adminUserId ═══

function fakePostTx(settingsRow: Record<string, unknown>) {
  const created: { data: Record<string, unknown> }[] = [];
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ n: 1 }],
    glSettings: { findUnique: async () => settingsRow },
    glSequence: { upsert: async () => ({}) },
    glMove: { create: async (args: { data: Record<string, unknown> }) => { created.push(args); return { id: `mv_${created.length}` }; } },
    glMoveSource: { create: async () => ({}) },
    glAuditLog: { findFirst: async () => null, create: async () => ({ id: 'aud1' }) },
  };
  return { tx: tx as unknown as GlTx, created };
}

function ledgerContextOf(ctx: ReturnType<typeof linkedCtx>): LedgerContext {
  return {
    ctx, settings: null, accounts: [], taxes: [], journals: [], accountById: new Map(), taxById: new Map(), journalById: new Map(),
  };
}

/** مفاتيح سطر الإدراج قبل «ربط الدفاتر» — ذهبي */
const LINE_CREATE_KEYS = [
  'tenantId', 'seq', 'accountId', 'journalId', 'date', 'posted', 'label', 'debitMilli', 'creditMilli', 'customerId', 'vendorId',
  'salesRepId', 'partnerName', 'analyticAccountId', 'productId', 'quantity', 'taxId', 'taxRole', 'taxBaseMilli', 'vatBox',
  'vatAdjustment', 'dueDate',
];

test('A2 L5 postMove: adminUserId يُكتب على سطر 111004 وحده، وسطور القيد القديم بمفاتيح الإدراج نفسها (ذهبي)', async () => {
  const ctx = linkedCtx();
  const { tx, created } = fakePostTx({ ...ROW, receiptRouting: null, setupMethod: 'LINKED', activatedAt: ACTIVATED });
  const posted = await postMove(tx, move([
    ln(USER_CUSTODY_CODE, 800, 0, { adminUserId: 'u1', partnerName: 'سارة' }),
    ln('111003', 0, 800, { salesRepId: 'r1', partnerName: 'خالد' }),
  ]), { tenantId: 't1', actor: SYSTEM_ACTOR, context: ledgerContextOf(ctx) });
  assert.equal(posted.totalMilli, M(800));
  const lines = (created[0].data.lines as { create: Record<string, unknown>[] }).create;
  assert.equal(lines[0].adminUserId, 'u1');
  assert.equal(lines[0].accountId, accountIdOf(USER_CUSTODY_CODE));
  assert.equal(lines[0].salesRepId, null);
  assert.deepEqual(Object.keys(lines[1]), LINE_CREATE_KEYS, 'سطر بلا مستخدم بلا مفتاح adminUserId');

  // قيد بلا بُعد مستخدم (E5.1) في شركة غير مربوطة ⇒ مفاتيح الإدراج كما كانت حرفاً
  const plain = fakePostTx({ ...ROW, receiptRouting: null });
  await postMove(plain.tx, move([ln('111003', 500, 0, { salesRepId: 'r1', partnerName: 'خالد' }), ln('113001', 0, 500, { customerId: 'c1', partnerName: 'عميل' })],
    { journalCode: 'RCPT', journalSystemKey: 'RECEIPTS', moveType: 'CUST_RECEIPT' }), { tenantId: 't1', actor: SYSTEM_ACTOR, context: ledgerContextOf(saContext()) });
  for (const l of (plain.created[0].data.lines as { create: Record<string, unknown>[] }).create) assert.deepEqual(Object.keys(l), LINE_CREATE_KEYS);
});

// ═══ §3.3 الحسابات الثلاثة ═══

test('A2 §3.3: الحسابات الثلاثة بأنواعها ورقابتها وأسمائها الخمسة كما في العقد', () => {
  assert.deepEqual([...LINKED_EXTRA_ACCOUNT_CODES], ['111004', '112007', '214002']);
  const by = new Map(LINKED_EXTRA_ACCOUNTS.map((a) => [a.code, a]));
  const u = by.get(USER_CUSTODY_CODE)!;
  assert.equal(u.type, 'asset_cash');
  assert.equal(u.controlKind, 'CUSTODY');
  assert.equal(u.reconcile, false);
  assert.deepEqual(u.names, {
    ar: 'عهدة تحصيلات مستخدمي الشركة', en: 'Company Users Collections Custody', fr: 'Encaissements en dépôt des utilisateurs',
    tr: 'Şirket Kullanıcıları Tahsilat Emaneti', zh: '公司用户收款保管',
  });
  const c = by.get(CARD_CLEARING_CODE)!;
  assert.equal(c.type, 'asset_current');
  assert.equal(c.controlKind, null);
  assert.equal(c.reconcile, true);
  assert.deepEqual(c.names, {
    ar: 'تحصيلات البطاقة تحت التسوية', en: 'Card Payments Clearing', fr: 'Paiements par carte en compensation',
    tr: 'Kart Tahsilatları Mutabakat Hesabı', zh: '银行卡收款待清算',
  });
  const r = by.get(CUSTOMER_CREDITS_CODE)!;
  assert.equal(r.type, 'liability_current');
  assert.equal(r.controlKind, null);
  assert.equal(r.reconcile, true);
  assert.deepEqual(r.names, {
    ar: 'مستردات العملاء وأرصدتهم الدائنة', en: 'Customer Refunds and Credit Balances', fr: 'Remboursements et soldes créditeurs clients',
    tr: 'Müşteri İadeleri ve Alacak Bakiyeleri', zh: '客户退款及贷方余额',
  });
  for (const a of LINKED_EXTRA_ACCOUNTS) {
    assert.equal(a.isSystem, true, a.code);
    assert.equal(a.isActive, true, a.code);
    assert.equal(a.templateRef, a.code);
    assert.deepEqual(a.mappingKeys, [], `${a.code}: بلا مفتاح ربط (D2)`);
    assert.equal(a.parentCode, a.code[0]);
    assert.ok(a.description.length > 20 && /[؀-ۿ]/.test(a.description), a.code);
    assert.equal(Object.values(SA_6D_ACCOUNT_DESCRIPTIONS).includes(a.description), false, `${a.code}: وصف مكرر`);
    for (const t of [...Object.values(a.names), a.description]) {
      assert.doesNotMatch(t, /nearpay|نير ?باي/i, `${a.code}: لا اسم مزوّد`);
      assert.doesNotMatch(t, /'/, `${a.code}: لا فاصلة عليا ASCII (§8.7)`);
    }
    // رؤوس المجموعات قائمة (للعرض في الشجرة)
    for (const p of [a.code.slice(0, 1), a.code.slice(0, 2), a.code.slice(0, 3)]) {
      assert.ok(SA_6D_ACCOUNT_GROUPS.some((g) => g.code === p), `${a.code}: المجموعة ${p}`);
    }
  }
  assert.equal(by.get(USER_CUSTODY_CODE)!.cashFlowTag, 'CASH_EQUIVALENT');
  assert.equal(by.get(CARD_CLEARING_CODE)!.cashFlowTag, 'CASH_EQUIVALENT');
  assert.equal(by.get(CUSTOMER_CREDITS_CODE)!.cashFlowTag, null);
});

test('A2 D2: الحسابات خارج القالبين ومفاتيح الربط — شجرة اليدوية الجديدة لا تتغيّر', () => {
  const codes = new Set<string>(LINKED_EXTRA_ACCOUNT_CODES);
  assert.equal(SA_6D_ACCOUNTS.some((a) => codes.has(a.code)), false);
  assert.equal(Object.values(SA_6D_MAPPINGS).some((c) => codes.has(c)), false);
  for (const cc of ['EG', 'KW', 'AE']) assert.equal(genericTemplate(cc).accounts.some((a) => codes.has(a.code)), false, cc);
  assert.equal(MAPPING_KEYS.length, new Set(MAPPING_KEYS).size);
  assert.equal(SA_6D_ACCOUNTS.length, 137);
});

test('A2 planLinkedAccounts: الناقص يُنشأ، والموافق يُتخطّى، والمخالف يُبلَّغ ولا يُعدَّل', () => {
  assert.deepEqual(planLinkedAccounts([]).toCreate.map((a) => a.code), ['111004', '112007', '214002']);
  const okRows = LINKED_EXTRA_ACCOUNTS.map((a) => ({ id: `x_${a.code}`, code: a.code, type: a.type, controlKind: a.controlKind, isActive: true }));
  assert.deepEqual(planLinkedAccounts(okRows), { toCreate: [], conflicts: [] });
  const p = planLinkedAccounts([
    { id: 'm1', code: '111004', type: 'asset_cash', controlKind: null, isActive: true },
    { id: 'm2', code: '112007', type: 'expense', controlKind: null, isActive: true },
    { id: 'm3', code: '214002', type: 'liability_current', controlKind: null, isActive: false },
  ]);
  assert.deepEqual(p.toCreate, []);
  assert.deepEqual(p.conflicts.map((c) => [c.code, c.reason, c.accountId]), [
    ['111004', 'CONTROL_KIND_MISMATCH', 'm1'], ['112007', 'TYPE_MISMATCH', 'm2'], ['214002', 'ARCHIVED', 'm3'],
  ]);
  assert.equal(p.conflicts[0].expectedControlKind, 'CUSTODY');
});

interface AccRow { id: string; tenantId: string; code: string; type: string; controlKind: string | null; isActive: boolean; [k: string]: unknown }

function fakeAccountStore(initial: AccRow[]) {
  const rows = [...initial];
  const calls = { findMany: [] as unknown[], createMany: [] as { data: Record<string, unknown>[]; skipDuplicates?: boolean }[] };
  const db = {
    glAccount: {
      findMany: async (args: { where: { tenantId: string; code: { in: string[] } }; select: Record<string, boolean> }) => {
        calls.findMany.push(args);
        return rows.filter((r) => r.tenantId === args.where.tenantId && args.where.code.in.includes(r.code))
          .map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k]])));
      },
      createMany: async (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
        calls.createMany.push(args);
        let count = 0;
        for (const d of args.data) {
          if (rows.some((r) => r.tenantId === d.tenantId && r.code === d.code)) {
            if (!args.skipDuplicates) throw new Error('P2002');
            continue;
          }
          rows.push({ ...(d as AccRow), id: `id_${String(d.tenantId)}_${String(d.code)}` });
          count++;
        }
        return { count };
      },
    },
  };
  return { db: db as unknown as LinkedAccountsDb, rows, calls };
}

test('A2 ensureLinkedAccounts: متساوي الأثر — الأول ينشئ الثلاثة بصفوف القالب، والثاني استعلام واحد بلا إنشاء', async () => {
  const other: AccRow = { id: 'o1', tenantId: 't2', code: '111004', type: 'asset_cash', controlKind: 'CUSTODY', isActive: true };
  const s = fakeAccountStore([other]);
  const r1 = await ensureLinkedAccounts(s.db, 't1');
  assert.deepEqual(r1, { created: ['111004', '112007', '214002'], conflicts: [] });
  assert.equal(s.calls.createMany.length, 1);
  assert.equal(s.calls.createMany[0].skipDuplicates, true);
  assert.deepEqual(s.calls.findMany[0], {
    where: { tenantId: 't1', code: { in: ['111004', '112007', '214002'] } },
    select: { id: true, code: true, type: true, controlKind: true, isActive: true },
  });
  const mine = s.rows.filter((r) => r.tenantId === 't1');
  assert.equal(mine.length, 3);
  const u = mine.find((r) => r.code === '111004')!;
  assert.deepEqual({ ...u, id: undefined }, {
    id: undefined, tenantId: 't1', code: '111004', name: 'عهدة تحصيلات مستخدمي الشركة', nameEn: 'Company Users Collections Custody',
    nameI18n: LINKED_EXTRA_ACCOUNTS[0].names, description: LINKED_EXTRA_ACCOUNTS[0].description, type: 'asset_cash', reconcile: false,
    isActive: true, isSystem: true, controlKind: 'CUSTODY', cashFlowTag: 'CASH_EQUIVALENT', templateRef: '111004',
  });
  // الثاني: لا إنشاء
  const r2 = await ensureLinkedAccounts(s.db, 't1');
  assert.deepEqual(r2, { created: [], conflicts: [] });
  assert.equal(s.calls.createMany.length, 1);
  assert.equal(s.rows.filter((r) => r.tenantId === 't1').length, 3);
  // شركة أخرى لم تُمسّ
  assert.deepEqual(s.rows.filter((r) => r.tenantId === 't2'), [other]);
});

test('A2 ensureLinkedAccounts: الجزئي ينشئ الناقص وحده، والمخالف يُبلَّغ ولا يُعدَّل، والسباق مع skipDuplicates لا يرمي', async () => {
  const s = fakeAccountStore([{ id: 'b1', tenantId: 't1', code: '112007', type: 'asset_cash', controlKind: null, isActive: true }]);
  const r = await ensureLinkedAccounts(s.db, 't1');
  assert.deepEqual(r.created, ['111004', '214002']);
  assert.deepEqual(r.conflicts.map((c) => [c.code, c.reason]), [['112007', 'TYPE_MISMATCH']]);
  assert.equal(s.rows.find((x) => x.code === '112007')!.type, 'asset_cash', 'الموجود لا يُعدَّل');
  // سباق: صفّ أُدرج بين القراءة والإنشاء
  const race = fakeAccountStore([]);
  const orig = race.db.glAccount.findMany.bind(race.db.glAccount);
  (race.db.glAccount as { findMany: unknown }).findMany = async (args: never) => {
    const out = await orig(args);
    race.rows.push({ id: 'z', tenantId: 't1', code: '214002', type: 'liability_current', controlKind: null, isActive: true });
    return out;
  };
  const rr = await ensureLinkedAccounts(race.db, 't1');
  assert.deepEqual(rr.created, ['111004', '112007', '214002'], 'الناقص عند القراءة — يُعاد تحميل السياق في الحالتين');
  assert.equal(race.rows.filter((x) => x.code === '214002').length, 1);
  await assert.rejects(() => ensureLinkedAccounts(race.db, ''), RangeError);
});

test('A2 §3.3 → السياق: بعد الإنشاء تُحلّ الحسابات بالرمز ويصحّ قيد التوريد E5.11 في سياقٍ من الصفوف', async () => {
  const s = fakeAccountStore([]);
  await ensureLinkedAccounts(s.db, 't1');
  const rows = linkedAccountCreateRows('t1', LINKED_EXTRA_ACCOUNTS);
  assert.equal(rows.length, 3);
  const lc = buildContextFromRows({
    settings: { ...ROW, setupMethod: 'LINKED', activatedAt: ACTIVATED },
    accounts: [
      ...s.rows.map((r) => ({ id: r.id, code: r.code, name: String(r.name), type: r.type, isActive: r.isActive, reconcile: Boolean(r.reconcile), controlKind: r.controlKind })),
      { id: 'cash', code: '111001', name: 'الصندوق', type: 'asset_cash', isActive: true, reconcile: false, controlKind: null },
    ],
    mappings: [], taxes: [], journals: [],
  });
  assert.equal(lc.ctx.accounts.byCode('111004')?.controlKind, 'CUSTODY');
  const v = validateMove(move([ln('111001', 800, 0), ln(USER_CUSTODY_CODE, 0, 800, { adminUserId: 'u1', partnerName: 'سارة' })]), lc.ctx);
  assert.equal(v.lines[1].account.code, '111004');
});

// ═══ §4.5: classify ═══

const T0 = new Date('2026-11-01T09:00:00.000Z');
function cutover(o: Partial<CutoverContext> = {}): CutoverContext {
  return { cutoverDate: '2026-01-01', openingSnapshotAt: T0, timezone: 'Asia/Riyadh', initialWatermarkAt: new Date('2025-12-30T21:00:00.000Z'), ...o };
}
const AR_AFTER = { effectAt: '2026-03-10T09:00:00.000Z', createdAt: '2026-11-05T10:00:00.000Z' };
const AR_BEFORE_CUTOVER = { effectAt: '2025-12-20T09:00:00.000Z', createdAt: '2025-12-20T09:00:00.000Z' };

test('A2 OD12: skipImportedBalances غائب ⇒ سلوك اليوم حرفاً (CLEAN يتخطّى AR_ENTRY دائماً، وغيرها يصنّف)', () => {
  for (const self of [AR_AFTER, AR_BEFORE_CUTOVER]) {
    assert.deepEqual(planEvent({ sourceType: 'AR_ENTRY', event: 'POST', self, cutover: cutover({ cleanStart: true }) }),
      { action: 'SKIP', skipReason: 'OPENING', siblingWrite: null });
  }
  const legacy = planEvent({ sourceType: 'AR_ENTRY', event: 'POST', self: AR_AFTER, cutover: cutover() });
  assert.equal(legacy.action, 'POST');
  // صريح true يتخطّى ولو لم تكن البداية نظيفة
  assert.equal(planEvent({ sourceType: 'AR_ENTRY', event: 'POST', self: AR_AFTER, cutover: cutover({ skipImportedBalances: true }) }).action, 'SKIP');
  // الحدّ لا يمسّ غير AR_ENTRY:POST
  assert.equal(planEvent({ sourceType: 'INVOICE', event: 'POST', self: AR_AFTER, cutover: cutover({ skipImportedBalances: true }) }).action, 'POST');
});

test('A2 OD12 (E4.12): المربوطة skipImportedBalances=false ⇒ ما قبل linkedFrom افتتاح، وما بعده يُرحَّل بتاريخه', () => {
  const c = cutover({ cleanStart: false, skipImportedBalances: false });
  assert.deepEqual(planEvent({ sourceType: 'AR_ENTRY', event: 'POST', self: AR_BEFORE_CUTOVER, cutover: c }),
    { action: 'SKIP', skipReason: 'OPENING', siblingWrite: null });
  const after = planEvent({ sourceType: 'AR_ENTRY', event: 'POST', self: AR_AFTER, cutover: c });
  assert.equal(after.action, 'POST');
  assert.equal(after.action === 'POST' && after.date, '2026-03-10');
  assert.equal(after.action === 'POST' && after.mode, 'BUILD');
  // false يعلو cleanStart: لا تخطٍّ شامل، والتصنيف يقرّر (أُنشئ بعد T0 ⇒ يُرحَّل)
  assert.equal(planEvent({ sourceType: 'AR_ENTRY', event: 'POST', self: AR_AFTER, cutover: cutover({ cleanStart: true, skipImportedBalances: false }) }).action, 'POST');
});

test('A2 C13/C14: tombstoneOrigin(USER_SETTLEMENT) من settledAt/createdAt، والحمولة الناقصة null', () => {
  assert.deepEqual(tombstoneOrigin('USER_SETTLEMENT', { settledAt: '2026-11-10T08:00:00.000Z', createdAt: '2026-11-10T08:00:01.000Z', amount: '800.00' }), {
    originEffectAt: '2026-11-10T08:00:00.000Z', originCreatedAt: '2026-11-10T08:00:01.000Z', sourceExists: false,
  });
  assert.equal(tombstoneOrigin('USER_SETTLEMENT', { settledAt: '2026-11-10T08:00:00.000Z' }), null);
  assert.equal(tombstoneOrigin('USER_SETTLEMENT', null), null);
  assert.equal(tombstoneOrigin('PAYLINK_REFUND', { settledAt: 'x', createdAt: 'y' }), null);
  // SETTLEMENT/AR_ENTRY كما كانا
  assert.deepEqual(tombstoneOrigin('SETTLEMENT', { settledAt: 'a', createdAt: 'b' }), { originEffectAt: 'a', originCreatedAt: 'b', sourceExists: false });
});

test('A2 C13: حذف توريدٍ قبل ترحيله ⇒ الحدثان SKIPPED(NETTED)؛ وبعد التفعيل وما رُحّل يُعكس من الحمولة', () => {
  const c = cutover({ cleanStart: false, skipImportedBalances: false });
  const self = { effectAt: '2026-11-10T08:00:00.000Z', createdAt: '2026-11-10T08:00:01.000Z' };
  // POST بشقيق REVERSE غير نهائي والصف محذوف (P12)
  assert.deepEqual(planEvent({ sourceType: 'USER_SETTLEMENT', event: 'POST', self, sibling: { status: 'PENDING', skipReason: null, moveId: null }, sourceExists: false, cutover: c }),
    { action: 'SKIP', skipReason: 'NETTED', siblingWrite: { op: 'UPDATE', status: 'SKIPPED', skipReason: 'NETTED' } });
  // REVERSE وشقيق POST غير نهائي: الأصل من الحمولة بعد T0 ⇒ NETTED
  const origin = tombstoneOrigin('USER_SETTLEMENT', { settledAt: self.effectAt, createdAt: self.createdAt });
  assert.deepEqual(siblingGate({ sourceType: 'USER_SETTLEMENT', event: 'REVERSE', sibling: { status: 'PENDING', skipReason: null, moveId: null }, origin, cutover: c }),
    { action: 'SKIP', skipReason: 'NETTED', siblingWrite: { op: 'UPDATE', status: 'SKIPPED', skipReason: 'NETTED' } });
  // ما رُحّل (POST DONE) يُعكس قيده الحيّ (E5.12)
  assert.deepEqual(siblingGate({ sourceType: 'USER_SETTLEMENT', event: 'REVERSE', sibling: { status: 'DONE', skipReason: null, moveId: 'm1' }, live: { liveMoveId: 'm1', existingReversalMoveId: null }, cutover: c }),
    { action: 'REVERSE_LIVE', liveMoveId: 'm1' });
});

test('A2 userSettlementOrderReady: مرآة settlementOrderReady بمؤشر REP_SETTLEMENT وأحداث استلام المستخدم', () => {
  const base = { settlementCreatedAt: '2026-11-10T08:00:01.000Z', settledAt: '2026-11-10T08:00:00.000Z' };
  const after = { at: new Date('2026-11-10T08:05:00.000Z'), id: 'x' };
  assert.equal(userSettlementOrderReady({ ...base, repSettlementWatermark: null, feedEvents: [] }), false);
  assert.equal(userSettlementOrderReady({ ...base, repSettlementWatermark: { at: new Date(base.settlementCreatedAt), id: 'zz' }, feedEvents: [] }), false, 'المساواة ليست تجاوزاً');
  assert.equal(userSettlementOrderReady({ ...base, repSettlementWatermark: after, feedEvents: [] }), true);
  const at = (iso: string) => new Date(iso);
  assert.equal(userSettlementOrderReady({ ...base, repSettlementWatermark: after, feedEvents: [{ status: 'PENDING', effectAt: at('2026-11-09T10:00:00.000Z') }] }), false);
  assert.equal(userSettlementOrderReady({ ...base, repSettlementWatermark: after, feedEvents: [{ status: 'BLOCKED', effectAt: at(base.settledAt) }] }), false, 'effectAt = settledAt يحجب');
  assert.equal(userSettlementOrderReady({ ...base, repSettlementWatermark: after, feedEvents: [{ status: 'PENDING', effectAt: at('2026-11-10T09:00:00.000Z') }] }), true, 'استلامٌ بعد التوريد لا يحجبه');
  for (const status of ['DONE', 'SKIPPED', 'ERROR', 'HELD'] as const) {
    assert.equal(userSettlementOrderReady({ ...base, repSettlementWatermark: after, feedEvents: [{ status, effectAt: at('2026-11-09T10:00:00.000Z') }] }), true, status);
  }
});
