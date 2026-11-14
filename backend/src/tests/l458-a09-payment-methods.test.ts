// «ربط الدفاتر» L5 — A9: خريطة طرق الدفع (D3، OD14، C2/C10)، وحارس OD4 (D4) في الضبط والمعالج، وتركيب مسارات العهد في «العملاء».
// صرفة بلا قاعدة: العرض (الافتراضي والمربوط والفعلي = linkedMethodAccount نفسه)، ورفض الحساب الرقابي والمعلّق والأمانات، ومفاتيح
// الطرق، وجدول صدق حارس العهدة (422 للمربوطة والقديمة، ولا شيء لليدوية وغير المفعّلة) — وحراس ثابتة على مواضع الاستدعاء.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAP_ONLY_LABELS, assertRoutingCustodyCashOnly, custodyNonCashMethods, methodAccountInvalid, methodAccountProblem, methodKeyOf,
  methodRowsOf, methodViews, routingGuardApplies, wizardLinksBooks, type MapRow,
} from '../routes/ledger/paymentMethodMap';
import { ledgerErrorResponse, LedgerHttpError } from '../routes/ledger/errors';
import { linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { accountIdOf, taxIdOf, templateContextInput } from '../services/gl/testing/fixtures';
import { readPaymentMethodsConfig } from '../services/paymentMethodsCore';
import { createBuildContext, type AccountRef, type BuildContext } from '../services/gl/types';

const RAJHI: AccountRef = { id: accountIdOf('111102'), code: '111102', name: 'بنك الراجحي', type: 'asset_cash', isActive: true, reconcile: true, controlKind: null };

function ctxOf(accounts?: Record<string, Partial<AccountRef> | null>): BuildContext {
  return createBuildContext(templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, {
    settings: { linkedPosting: true },
    extraAccounts: [...linkedAccountRefs(accountIdOf), RAJHI],
    accounts,
  }));
}

const config = readPaymentMethodsConfig({
  version: 1,
  builtins: { POS: { label: 'مدى', active: true }, CHEQUE: { active: false } },
  custom: [
    { key: 'c_stcpay', label: 'STC Pay', base: 'BANK_TRANSFER', icon: 'wallet', active: true },
    { key: 'c_oldbox', label: 'صندوق الفرع', base: 'CASH', icon: 'wallet', active: false },
  ],
});
const row = (methodKey: string, code: string): MapRow => ({ methodKey, accountId: accountIdOf(code), journalId: null });
const codes = (v: { code: string } | null) => v?.code ?? null;
/** آخر عنصر (target المشروع قبل es2022 فلا Array.prototype.at) */
const last = <T>(xs: readonly T[]): T => xs[xs.length - 1];

test('الطرق: الأساسية الست بترتيب الخريطة ثم المخصّصة، والأسماء والأرشفة من إعداد الشركة', () => {
  const rows = methodRowsOf(config);
  assert.deepEqual(rows.map((r) => [r.methodKey, r.base, r.custom, r.archived]), [
    ['CASH', 'CASH', false, false], ['BANK_TRANSFER', 'BANK_TRANSFER', false, false], ['POS', 'POS', false, false],
    ['CHEQUE', 'CHEQUE', false, true], ['CARD', 'CARD', false, false], ['PAYOUT', 'PAYOUT', false, false],
    ['c_stcpay', 'BANK_TRANSFER', true, false], ['c_oldbox', 'CASH', true, true],
  ]);
  assert.equal(rows[2].label, 'مدى');
  assert.equal(rows[0].label, 'نقدي');
  assert.equal(rows[4].label, MAP_ONLY_LABELS.CARD);
  // بلا إعداد: الست وحدها بأسمائها الافتراضية
  assert.deepEqual(methodRowsOf(null).map((r) => r.methodKey), ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'CARD', 'PAYOUT']);
});

test('D3 بلا صفوف: الافتراضي = الفعلي (النقد 111001، التحويل 111101 لا 112001، نقطة البيع 112004، الشيك 112003، البطاقة 112007، التوريد 111101)', () => {
  const v = methodViews(config, [], ctxOf());
  const by = new Map(v.map((m) => [m.methodKey, m]));
  for (const [k, code] of [
    ['CASH', '111001'], ['BANK_TRANSFER', '111101'], ['POS', '112004'], ['CHEQUE', '112003'], ['CARD', '112007'], ['PAYOUT', '111101'],
    ['c_stcpay', '111101'], ['c_oldbox', '111001'],
  ] as const) {
    assert.equal(codes(by.get(k)!.defaultAccount), code, `${k} الافتراضي`);
    assert.equal(codes(by.get(k)!.effective), code, `${k} الفعلي`);
    assert.equal(by.get(k)!.account, null);
    assert.equal(by.get(k)!.accountId, null);
  }
});

test('E5.3: الطريقة المخصّصة c_stcpay مربوطة بـ111102 ⇒ الفعلي 111102 والافتراضي فعلي أساسها؛ وربط الأساس يسري على المخصّصة غير المربوطة', () => {
  const ctx = ctxOf();
  const a = new Map(methodViews(config, [row('c_stcpay', '111102')], ctx).map((m) => [m.methodKey, m]));
  assert.equal(codes(a.get('c_stcpay')!.effective), '111102');
  assert.equal(codes(a.get('c_stcpay')!.account), '111102');
  assert.equal(codes(a.get('c_stcpay')!.defaultAccount), '111101');
  assert.equal(codes(a.get('BANK_TRANSFER')!.effective), '111101', 'صفّ المخصّصة لا يقفز إلى أساسها');
  const b = new Map(methodViews(config, [row('BANK_TRANSFER', '111102')], ctx).map((m) => [m.methodKey, m]));
  assert.equal(codes(b.get('BANK_TRANSFER')!.effective), '111102');
  assert.equal(codes(b.get('BANK_TRANSFER')!.defaultAccount), '111101');
  assert.equal(codes(b.get('c_stcpay')!.effective), '111102', 'المخصّصة بلا صفّ ⇒ صفّ أساسها');
  assert.equal(codes(b.get('c_stcpay')!.defaultAccount), '111102');
});

test('صفّ يشير إلى حساب رقابي أو محذوف يُتخطّى في الفعلي (دفاع الـbuilder)، وصفّ لمفتاح لا يعرفه الإعداد يُلحق مؤرشفاً', () => {
  const v = methodViews(config, [row('CASH', '113001'), row('POS', '999999'), row('c_gone1', '111102')], ctxOf());
  const by = new Map(v.map((m) => [m.methodKey, m]));
  assert.equal(codes(by.get('CASH')!.account), '113001');
  assert.equal(codes(by.get('CASH')!.effective), '111001');
  assert.equal(by.get('POS')!.account, null);
  assert.equal(codes(by.get('POS')!.effective), '112004');
  const orphan = last(v);
  assert.deepEqual([orphan.methodKey, orphan.custom, orphan.archived, orphan.base], ['c_gone1', true, true, '']);
  assert.equal(codes(orphan.account), '111102');
});

test('حساب الطريقة: نشط، نقد أو أصل متداول، غير رقابي، وليس 911001 ولا 112005 — وإلا 422 LEDGER_METHOD_ACCOUNT_INVALID', () => {
  const ctx = ctxOf({ '911001': { controlKind: null }, '112006': null });
  const acc = (code: string) => ctx.accounts.byCode(code)!;
  const forbidden = new Set([ctx.accounts.byKey('POSTING_SUSPENSE')!.id, ctx.accounts.byKey('PAYLINK_CLEARING')!.id]);
  for (const ok of ['111001', '111101', '111102', '112004', '112003', '112007']) assert.equal(methodAccountProblem(acc(ok), forbidden), null, ok);
  // الرقابية: الذمم، عهدة المندوب، عهدة المستخدم، أمانات الدفع الإلكتروني
  for (const c of ['113001', '111003', '111004', '112005']) assert.equal(methodAccountProblem(acc(c), forbidden), 'CONTROL', c);
  assert.equal(methodAccountProblem(acc('911001'), forbidden), 'FORBIDDEN', 'المعلّق ولو أُزيل وسمه الرقابي');
  assert.equal(methodAccountProblem(acc('911001'), new Set()), 'FORBIDDEN', 'بالرمز حين يغيب الربط');
  assert.equal(methodAccountProblem(acc('411001'), forbidden), 'TYPE');
  assert.equal(methodAccountProblem({ ...acc('111101'), isActive: false }, forbidden), 'ARCHIVED');
  const r = ledgerErrorResponse(methodAccountInvalid('CONTROL', { accountCode: '113001' }))!;
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'LEDGER_METHOD_ACCOUNT_INVALID');
  assert.equal(r.body.reason, 'CONTROL');
});

test('مفتاح المسار: الأساسية الست أو c_… بنمط نواة طرق الدفع — ONLINE وغيره 400', () => {
  for (const k of ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'CARD', 'PAYOUT', 'c_stcpay', ' c_abcd ']) assert.equal(methodKeyOf(k), k.trim());
  for (const k of ['ONLINE', 'cash', 'c_AB12', 'c_ab', '', undefined, 'c_' + 'a'.repeat(25)]) {
    assert.throws(() => methodKeyOf(k), (e: unknown) => e instanceof LedgerHttpError && e.status === 400, String(k));
  }
});

// ═══ OD4 ═══

test('OD4: التحويل ونقطة البيع إلى العهدة ⇒ 422 LEDGER_ROUTING_CUSTODY_NONCASH {reason, methods} حين يعمل الحارس، والنقد والشيك مسموحان', () => {
  assert.deepEqual(custodyNonCashMethods({ CASH: 'CUSTODY', BANK_TRANSFER: 'CUSTODY', POS: 'CUSTODY', CHEQUE: 'CUSTODY' }), ['BANK_TRANSFER', 'POS']);
  assert.deepEqual(custodyNonCashMethods({ CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT' }), []);
  assert.deepEqual(custodyNonCashMethods(null), []);
  assert.deepEqual(custodyNonCashMethods(undefined), []);
  assert.deepEqual(custodyNonCashMethods(['CUSTODY']), []);
  assert.throws(() => assertRoutingCustodyCashOnly({ POS: 'CUSTODY' }, true), (e: unknown) => {
    const r = ledgerErrorResponse(e)!;
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'LEDGER_ROUTING_CUSTODY_NONCASH');
    assert.equal(r.body.reason, 'CUSTODY_NONCASH');
    assert.deepEqual(r.body.methods, ['POS']);
    assert.equal(r.body.message, 'لا تُوجَّه التحويلات البنكية ونقاط البيع إلى عهدة المندوب');
    return true;
  });
  assert.doesNotThrow(() => assertRoutingCustodyCashOnly({ POS: 'CUSTODY', BANK_TRANSFER: 'CUSTODY' }, false), 'اليدوية كما كانت');
  assert.doesNotThrow(() => assertRoutingCustodyCashOnly({ CASH: 'CUSTODY', CHEQUE: 'CUSTODY' }, true));
  assert.doesNotThrow(() => assertRoutingCustodyCashOnly(undefined, true), 'حقل غائب من الطلب لا يُفحص');
});

test('OD4: جدول صدق الحارس — المربوطة والقديمة المفعّلتان نعم، واليدوية وغير المفعّلة لا؛ والمعالج يربط حين طريقته LINKED', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  assert.equal(routingGuardApplies({ setupMethod: 'LINKED', activatedAt: at }), true);
  assert.equal(routingGuardApplies({ setupMethod: 'OPENING', activatedAt: at }), true);
  assert.equal(routingGuardApplies({ setupMethod: 'FULL_HISTORY', activatedAt: at }), true);
  assert.equal(routingGuardApplies({ setupMethod: 'CLEAN', activatedAt: at }), false);
  assert.equal(routingGuardApplies({ setupMethod: 'CLEAN', activatedAt: null }), false);
  assert.equal(routingGuardApplies({ setupMethod: 'LINKED', activatedAt: null }), false);
  assert.equal(routingGuardApplies({ setupMethod: null, activatedAt: null }), false);
  assert.equal(routingGuardApplies(null), false);
  assert.equal(wizardLinksBooks('LINKED'), true);
  for (const m of ['CLEAN', 'OPENING', 'FULL_HISTORY', null, undefined]) assert.equal(wizardLinksBooks(m), false, String(m));
});

// ═══ حراس ثابتة ═══

const ROUTES = path.join(process.cwd(), 'src', 'routes', 'ledger');
const read = (f: string) => fs.readFileSync(path.join(ROUTES, f), 'utf8');
const routesOf = (s: string) => [...s.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*(\w+)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);

test('حارس ثابت: config.ts يفحص OD4 بعد قراءة الإعدادات تحت القفل وقبل أي كتابة، بشرط routingGuardApplies(s)', () => {
  const s = read('config.ts');
  const put = s.slice(s.indexOf("router.put('/settings'"), s.indexOf("router.post('/settings/load-template'"));
  const guard = put.indexOf('assertRoutingCustodyCashOnly(body.receiptRouting, routingGuardApplies(s));');
  assert.ok(guard > 0, 'الحارس غائب عن PUT /settings');
  assert.ok(put.indexOf("if (!s) throw new LedgerError('LEDGER_NOT_SETUP'") < guard, 'بعد قراءة الإعدادات');
  assert.ok(guard < put.indexOf('tx.glSettings.update'), 'قبل الكتابة');
  assert.match(s, /import \{ assertRoutingCustodyCashOnly, routingGuardApplies \} from '\.\/paymentMethodMap';/);
});

test('حارس ثابت: setup.ts يفحص OD4 في المسودة والاعتماد بعد effectiveSetup وقبل أي كتابة (للمعالج الذي يربط وحده)', () => {
  const s = read('setup.ts');
  const draft = s.slice(s.indexOf("router.post('/setup/draft'"), s.indexOf("router.post('/setup/preview-opening'"));
  const g1 = draft.indexOf('assertRoutingCustodyCashOnly(merged.step3?.receiptRouting, routingGuardApplies(before) || wizardLinksBooks(eff.method));');
  assert.ok(g1 > draft.indexOf('const eff = effectiveSetup('), 'المسودة');
  assert.ok(g1 < draft.indexOf('tx.glSettings.update'));
  const commit = s.slice(s.indexOf("router.post('/setup/commit'"), s.indexOf("router.post('/setup/backfill'"));
  const g2 = commit.indexOf('assertRoutingCustodyCashOnly(draft.step3?.receiptRouting, routingGuardApplies(before) || wizardLinksBooks(eff.method));');
  assert.ok(g2 > commit.indexOf('const eff = effectiveSetup('), 'الاعتماد');
  assert.ok(g2 < commit.indexOf('tx.glSettings.update'));
});

test('حارس ثابت: خريطة الطرق بـcanConfigureLedger، والكتابة تحت قفل الترحيل بتدقيق MAPPING_CHANGE، وحسابات الربط للمربوطة وحدها', () => {
  const s = read('paymentMethodMap.ts');
  assert.deepEqual(routesOf(s), [
    'get /config/payment-methods CONFIGURE', 'put /config/payment-methods/:methodKey CONFIGURE', 'delete /config/payment-methods/:methodKey CONFIGURE',
  ]);
  assert.match(s, /const CONFIGURE = requireLedgerPermission\('canConfigureLedger'\);/);
  for (const verb of ["router.put('/config/payment-methods/:methodKey'", "router.delete('/config/payment-methods/:methodKey'"]) {
    const body = s.slice(s.indexOf(verb), s.indexOf('}));', s.indexOf(verb)));
    assert.ok(body.indexOf('acquirePostLock(tx, tenantId)') > 0 && body.indexOf('acquirePostLock(tx, tenantId)') < body.indexOf('tx.glPaymentMethodMap.'), verb);
    assert.match(body, /if \(isManualBooks\(s\)\) throw booksNotLinked\(s\);/);
    assert.match(body, /action: 'MAPPING_CHANGE'/);
  }
  // ensureLinkedAccounts لا يُستدعى إلا خلف isLinked (الشجرة اليدوية لا تُمسّ)
  const calls = [...s.matchAll(/ensureLinkedAccounts\(/g)].map((m) => m.index!);
  assert.ok(calls.length >= 2);
  for (const i of calls) assert.match(s.slice(i - 40, i), /if \((linked|isLinked\(s\))\) await $/);
  // الحساب الفعلي من linkedMethodAccount نفسه (مصدر واحد مع الـbuilder)، والمفتاح المخصّص بنمط نواة طرق الدفع المستورد
  assert.match(s, /import \{ LINKED_METHOD_DEFAULTS, linkedMethodAccount \} from '\.\.\/\.\.\/services\/gl\/builders\/receipt';/);
  assert.match(s, /CUSTOM_METHOD_KEY_RE\.test\(k\)/);
  assert.doesNotMatch(s, /\/\^c_\[a-z0-9\]/, 'لا يُعرَّف النمط ثانيةً');
});

test('حارس ثابت: نقطتا «العملاء» الجديدتان قراءة فقط بـcanViewLedger، معزولتان بالشركة، ومضافتان في آخر الملف', () => {
  const s = read('customers.ts');
  const routes = routesOf(s);
  assert.deepEqual(routes.slice(-2), ['get /customers/custody/:salesRepId/explain VIEW', 'get /customers/user-custody VIEW']);
  const tail = s.slice(s.indexOf("router.get('/customers/custody/:salesRepId/explain'"));
  assert.doesNotMatch(tail, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$transaction|appendAudit/);
  for (const q of tail.matchAll(/prisma\.(\w+)\.(findMany|findFirst|findUnique|groupBy|count)\(\{ where: \{ ([^}]*)/g)) {
    assert.match(q[3], /tenantId/, `${q[1]}.${q[2]} بلا عزل الشركة`);
  }
  // أسماء مستعارة للمساعد فلا تتصادم مع استيرادات L0 على الأسطر نفسها
  assert.match(s, /import \{ isLinked as booksLinked, isManualBooks as booksManual \} from '\.\.\/\.\.\/services\/booksMode';/);
});
