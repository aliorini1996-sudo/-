// «بيع نقدي فقط» لقائمة الأسعار (طلب المالك ١٢ نوفمبر ٢٠٢٦: «قائمة السعر لا يتم البيع فيها الا بيع نقدي فقط ولا يمكن بيع بها اجل») —
// شاشة فاتورة المندوب (CreateInvoice في RepApp.tsx).
// المكوّن يعتمد IndexedDB والكاميرا فلا يُرسم كاملاً: مقطع النوع الفعّال وجسم الإصدار وأزرار النوع وتنبيهها تُستخرج من RepApp.tsx حرفاً
// وتُترجم وتُشغَّل على المساعدات الحقيقية — cashOnlyListOf/effectiveSaleType، وأسماء القوائم كما يقرؤها الجهاز من ردّ الخادم ومن كاشه
// دون اتصال (repNamesOf/repCachedNamesOf) — ثم حرّاس مصدرٍ: لا قراءة للنوع المختار خارج المقطع، وفحوص submit بالنوع الفعّال، وحمولةٌ
// واحدة للطلب الحيّ والصندوق، ومسار 409 PRICE_LIST_CASH_ONLY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CASH_ONLY_NOTE, cashOnlyListOf, effectiveSaleType, PRICE_LIST_CASH_ONLY_MSG } from '../lib/priceLists';
import { repCachedNamesOf, repNamesOf } from './repPriceLists';
import { repReturnPolicyFields } from '../lib/returnInvoice';
import { invoiceItemUnit } from './repUnits';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const repApp = read('rep', 'RepApp.tsx');
const sf = ts.createSourceFile('RepApp.tsx', repApp, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const between = (s: string, from: string, to: string, keepTo = true) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, `غائب: ${from}`);
  const b = s.indexOf(to, a + from.length);
  assert.ok(b > a, `غائب بعده: ${to}`);
  return s.slice(a, keepTo ? b + to.length : b);
};
function compile<T>(src: string, name: string, deps: Record<string, unknown>): T {
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(deps), `${js}\nreturn ${name};`)(...Object.values(deps)) as T;
}
function fnNode(name: string): ts.FunctionDeclaration {
  let out: ts.FunctionDeclaration | undefined;
  sf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) out = n; });
  assert.ok(out, `غائب: function ${name}`);
  return out!;
}
const createFn = fnNode('CreateInvoice');
const create = createFn.getText(sf);
const submit = between(create, 'const submit = async () => {', 'const refreshUnits = async');

// ═══ النوع الفعّال: المقطع من RepApp حرفاً ═══
const BLOCK_FROM = 'const cashOnlyList = ';
const BLOCK_TO = "const salePlan: 'IMMEDIATE' | 'INSTALLMENT' = cashOnly ? 'IMMEDIATE' : plan;";
const BLOCK = between(create, BLOCK_FROM, BLOCK_TO);
type SaleType = 'CASH' | 'CREDIT';
type Plan = 'IMMEDIATE' | 'INSTALLMENT';
type Eff = { cashOnlyList: { id: string; name: string } | null; cashOnly: boolean; saleType: SaleType; salePlan: Plan };
const effective = compile<(isReturn: boolean, listInfo: unknown, listId: string | null, type: SaleType, plan: Plan) => Eff>(
  `const effective = (isReturn: boolean, listInfo: any, listId: string | null, type: 'CASH' | 'CREDIT', plan: 'IMMEDIATE' | 'INSTALLMENT') => {\n${BLOCK}\nreturn { cashOnlyList, cashOnly, saleType, salePlan };\n};`,
  'effective', { cashOnlyListOf, effectiveSaleType });

// ردّ GET /price-lists كما يرسله الخادم (cashOnly في LIST_SELECT) — وقائمةٌ من خادمٍ أقدم بلا الحقل
const SERVER = {
  basePriceLabel: null,
  lists: [
    { id: 'l-cash', name: 'دفع كاش', sortOrder: 0, cashOnly: true },
    { id: 'l-whole', name: 'سعر الجملة', sortOrder: 1, cashOnly: false },
    { id: 'l-old', name: 'قائمة قديمة', sortOrder: 2 },
  ],
};
const info = repNamesOf(SERVER);
const CHOICES: Array<[SaleType, Plan]> = [['CREDIT', 'IMMEDIATE'], ['CREDIT', 'INSTALLMENT'], ['CASH', 'IMMEDIATE']];

test('قائمة الفاتورة «بيع نقدي فقط»: النوع الفعّال نقدي فوري أيّاً كان المختار (آجل أو تقسيط) — وباسم القائمة للتنبيه', () => {
  for (const [type, plan] of CHOICES) {
    const e = effective(false, info, 'l-cash', type, plan);
    assert.equal(e.cashOnly, true, `${type}/${plan}`);
    assert.equal(e.saleType, 'CASH', `${type}/${plan}`);
    assert.equal(e.salePlan, 'IMMEDIATE', `${type}/${plan}`);
    assert.equal(e.cashOnlyList?.name, 'دفع كاش');
  }
});

test('قائمةٌ بلا القيد، أو من خادمٍ أقدم، أو السعر الأساسي، أو قائمةٌ مجهولة، أو أسماءٌ لم تصل: المختار كما هو حرفاً', () => {
  for (const listId of ['l-whole', 'l-old', null, 'l-gone']) {
    for (const [type, plan] of CHOICES) {
      assert.deepEqual(effective(false, info, listId, type, plan), { cashOnlyList: null, cashOnly: false, saleType: type, salePlan: plan }, `${listId} ${type}/${plan}`);
    }
  }
  for (const none of [null, undefined, { basePriceLabel: null, lists: [] }]) {
    assert.deepEqual(effective(false, none, 'l-cash', 'CREDIT', 'INSTALLMENT'), { cashOnlyList: null, cashOnly: false, saleType: 'CREDIT', salePlan: 'INSTALLMENT' });
  }
  // true الصريحة وحدها (priceListsOf): قيمةٌ تالفة لا تقيّد
  for (const bad of ['true', 1, 'yes', {}]) {
    const odd = repNamesOf({ lists: [{ id: 'l-x', name: 'س', sortOrder: 0, cashOnly: bad }] });
    assert.equal(effective(false, odd, 'l-x', 'CREDIT', 'IMMEDIATE').saleType, 'CREDIT', String(bad));
  }
});

test('المرتجع لا نوع بيعٍ له: لا قيد ولا تنبيه ولو كانت قائمته نقدية', () => {
  for (const [type, plan] of CHOICES) {
    assert.deepEqual(effective(true, info, 'l-cash', type, plan), { cashOnlyList: null, cashOnly: false, saleType: type, salePlan: plan });
  }
  assert.match(BLOCK, /^const cashOnlyList = isReturn \? null : cashOnlyListOf\(listInfo, listId\);/);
});

test('دون اتصال: القيد من كاش أسماء القوائم في الجهاز (repCachedNamesOf) منذ أن يتجدّد — وكاشٌ من قبل الميزة بلا الحقل لا يقيّد', () => {
  const now = Date.parse('2026-11-12T09:00:00.000Z');
  const cached = repCachedNamesOf({ data: SERVER, updatedAt: now - 60_000 }, now, ['l-cash', null], true);
  assert.ok(cached, 'كاشٌ حديث يكفي بلا طلب');
  assert.equal(effective(false, cached, 'l-cash', 'CREDIT', 'INSTALLMENT').saleType, 'CASH');
  const before = { lists: SERVER.lists.map(({ id, name, sortOrder }) => ({ id, name, sortOrder })) };
  const old = repCachedNamesOf({ data: before, updatedAt: now - 60_000 }, now, ['l-cash'], true);
  assert.equal(effective(false, old, 'l-cash', 'CREDIT', 'IMMEDIATE').saleType, 'CREDIT', 'والخادم يردّه متصلاً، ويقبله من الصندوق (البضاعة سُلّمت)');
  // الشاشة تسعّر وتقيّد بالأسماء نفسها التي قرأها loadPriceLists (الكاش أو الخادم) — listInfo
  assert.match(repApp, /let names = cachedNames \? \{ info: cachedNames, fromServer: false \} : await namesFromNet\(\);/);
  assert.match(create, /setListInfo\(names\.info\); setNamesFromServer\(names\.fromServer\);/);
});

// ═══ جسم الإصدار: من submit حرفاً — الطلب الحيّ والصندوق الأوف‑لاين يحملان الحمولة نفسها ═══
const BODY = `${between(submit, 'const body = {', '\n    attempt.current = attemptClientRef(', false)}`;
const BODY_VARS = ['custRef', 'isReturn', 'saleType', 'salePlan', 'returnReason', 'activeTeam', 'saleRef', 'retPhase2', 'manualRef', 'noteReasonText',
  'canSwitchList', 'listsOn', 'docDefault', 'listId', 'lines', 'deliveryDate', 'signatureOn', 'signatures', 'insCount', 'insFirst', 'insPeriod'];
const buildBody = compile<(ctx: Record<string, unknown>) => Record<string, unknown>>(
  `const buildBody = (ctx: any) => {\n const { ${BODY_VARS.join(', ')} } = ctx;\n${BODY}\nreturn body;\n};`,
  'buildBody', { repReturnPolicyFields, invoiceItemUnit });
const CTX = {
  custRef: { customerId: 'c-1' }, returnReason: 'NORMAL', activeTeam: null, saleRef: null, retPhase2: false, manualRef: null, noteReasonText: '',
  canSwitchList: true, listsOn: true, docDefault: 'l-cash', lines: [{ productId: 'p-1', qty: 2, unitPrice: 11.5, discountPct: 0, taxPct: 15, unit: 'حبة' }],
  deliveryDate: '', signatureOn: false, signatures: {}, insCount: 3, insFirst: '2026-12-12', insPeriod: 'MONTHLY',
};
/** المختار بالأزرار ⇒ الجسم كما يبنيه submit بالنوع الفعّال */
const issue = (type: SaleType, plan: Plan, listId: string | null, isReturn = false) => {
  const e = effective(isReturn, info, listId, type, plan);
  return buildBody({ ...CTX, isReturn, listId, saleType: e.saleType, salePlan: e.salePlan });
};

test('الجسم لقائمةٍ نقدية لا يحمل آجلاً ولا خطة أقساط أبداً — وقائمةٌ بلا القيد ترسل المختار كما كان', () => {
  for (const [type, plan] of CHOICES) {
    const b = issue(type, plan, 'l-cash');
    assert.equal(b.type, 'CASH', `${type}/${plan}`);
    assert.ok(!('paymentPlan' in b) && !('installmentPlan' in b), `${type}/${plan}`);
    assert.equal(b.priceListId, 'l-cash', 'القائمة التي سُعّرت بها الفاتورة');
  }
  const ins = issue('CREDIT', 'INSTALLMENT', 'l-whole');
  assert.equal(ins.type, 'CREDIT');
  assert.equal(ins.paymentPlan, 'INSTALLMENT');
  assert.deepEqual(ins.installmentPlan, { count: 3, firstDueDate: '2026-12-12', period: 'MONTHLY' });
  assert.equal(issue('CREDIT', 'IMMEDIATE', 'l-whole').type, 'CREDIT');
  assert.equal(issue('CREDIT', 'IMMEDIATE', null).type, 'CREDIT', 'السعر الأساسي بلا قيد');
  // المرتجع على قائمةٍ نقدية: RETURN كما كان
  const ret = issue('CREDIT', 'IMMEDIATE', 'l-cash', true);
  assert.equal(ret.type, 'RETURN');
  assert.ok(!('paymentPlan' in ret));
});

test('submit: حمولةٌ واحدة بالنوع الفعّال للطلب الحيّ والصندوق الأوف‑لاين — ولا قراءة للمختار فيها', () => {
  assert.equal((create.match(/const body = \{/g) ?? []).length, 1, 'جسم فاتورةٍ واحد في الشاشة');
  assert.equal((repApp.match(/repApi\.post\('\/invoices'/g) ?? []).length, 1, 'ولا مسار إصدارٍ آخر في التطبيق');
  assert.match(submit, /\.\.\.custRef, type: isReturn \? 'RETURN' : saleType, discountPct: 0,/);
  assert.match(submit, /\.\.\.\(!isReturn && salePlan === 'INSTALLMENT' && \{\n\s+paymentPlan: 'INSTALLMENT' as const,/);
  assert.match(submit, /const payload = \{ \.\.\.body, clientRef, clientCreatedAt \};/);
  assert.match(submit, /await repApi\.post\('\/invoices', payload\);/);
  assert.match(submit, /await outboxAdd\(\{ clientRef, repId: currentRepId\(\), kind: 'invoice', payload, status: 'queued', clientCreatedAt, localNumber \}\);/);
  // الورقة (متصلاً ودون اتصال وبانتظار الهيئة) بالنوع نفسه، ومدفوع الأوف‑لاين منه
  assert.equal((submit.match(/type: saleType, isReturn,/g) ?? []).length, 3);
  assert.match(submit, /const paid = saleType === 'CASH' && !isReturn \? total : 0;/);
  assert.match(submit, /if \(salePlan === 'INSTALLMENT' && \(inv\.installments\?\.length \?\? 0\) !== insCount\) \{/);
  assert.doesNotMatch(submit, /\btype ===|\btype !==|\bplan ===|\bplan !==|, type,|\btype: type\b/);
});

test('submit: الفحوص بالنوع الفعّال قبل بناء الجسم — ومندوبٌ بلا «البيع النقدي» على قائمةٍ نقدية يُمنع برسالةٍ قائمة في القاموس', () => {
  const credit = "if (!isReturn && saleType === 'CREDIT' && !canSellOnCredit) { setMsg(tr('لا تملك صلاحية البيع الآجل')); return; }";
  const cash = "if (!isReturn && saleType === 'CASH' && !canSellInCash) { setMsg(tr('لا تملك صلاحية البيع النقدي')); return; }";
  const ins = "if (!isReturn && salePlan === 'INSTALLMENT') {";
  for (const s of [credit, cash, ins]) {
    assert.ok(submit.includes(s), s);
    assert.ok(submit.indexOf(s) < submit.indexOf("setLoading(true); setMsg('');"), `قبل الإرسال: ${s}`);
    assert.ok(submit.indexOf(s) < submit.indexOf('const body = {'), `قبل الجسم: ${s}`);
  }
  assert.ok('لا تملك صلاحية البيع النقدي' in PHRASES);
  // الخطة الفعّالة في معاينة الأقساط ولوحتها
  assert.match(create, /const insPreview = salePlan === 'INSTALLMENT'\n\s+\? previewInstallments\(/);
  assert.match(create, /\{!isReturn && salePlan === 'INSTALLMENT' && \(\n\s+<div className="bg-white rounded-xl p-3 mt-2 border border-\[#D6CFEA\]">/);
});

const EFFECT_TO = '}, [cashOnly, canSellInCash, type, plan]);';
test('التبديل إلى قائمةٍ نقدية والمختار آجلٌ أو تقسيط: المؤثّر يقلب الاختيار نفسه إلى نقدي فوري — إلا مندوباً بلا «البيع النقدي»', () => {
  const eff = between(create, BLOCK_TO, EFFECT_TO);
  assert.match(eff, /useEffect\(\(\) => \{\n\s+if \(!cashOnly \|\| !canSellInCash\) return;\n\s+if \(type !== 'CASH'\) setType\('CASH'\);\n\s+if \(plan !== 'IMMEDIATE'\) setPlan\('IMMEDIATE'\);\n\s+\}, \[cashOnly, canSellInCash, type, plan\]\);$/);
  // المؤثّر من RepApp حرفاً يُشغَّل مرةً بحالةٍ معطاة: ما يُكتب في الاختيار
  const runEffect = compile<(cashOnly: boolean, canSellInCash: boolean, type: SaleType, plan: Plan) => Array<[string, string]>>(
    'const runEffect = (cashOnly: boolean, canSellInCash: boolean, type: string, plan: string) => {\n const sets: Array<[string, string]> = [];\n'
      + ' const useEffect = (fn: () => void) => fn();\n'
      + " const setType = (v: string) => { sets.push(['type', v]); };\n const setPlan = (v: string) => { sets.push(['plan', v]); };\n"
      + `${eff.slice(eff.indexOf('useEffect('))}\n return sets;\n};`,
    'runEffect', {});
  assert.deepEqual(runEffect(true, true, 'CREDIT', 'INSTALLMENT'), [['type', 'CASH'], ['plan', 'IMMEDIATE']]);
  assert.deepEqual(runEffect(true, true, 'CREDIT', 'IMMEDIATE'), [['type', 'CASH']]);
  assert.deepEqual(runEffect(true, true, 'CASH', 'IMMEDIATE'), []);
  assert.deepEqual(runEffect(false, true, 'CREDIT', 'INSTALLMENT'), [], 'قائمةٌ بلا قيد');
  // بلا «البيع النقدي»: الاختيار يبقى (النوع الفعّال نقديٌّ ممنوع الإصدار)، فإن بدّل إلى قائمةٍ عادية عاد آجله مضاءً كما كان
  assert.deepEqual(runEffect(true, false, 'CREDIT', 'IMMEDIATE'), []);
  assert.deepEqual(runEffect(true, false, 'CREDIT', 'INSTALLMENT'), []);
  const back = screen('l-whole', 'CREDIT', 'IMMEDIATE', { credit: true, cash: false, installment: true });
  assert.deepEqual(btn(back, 'آجل'), { disabled: false, on: true });
  assert.deepEqual(btn(back, 'نقدي'), { disabled: true, on: false });
  // المقطع بعد قائمة الفاتورة (listId) وأسمائها — وقبل أول قراءةٍ للنوع الفعّال
  assert.ok(create.indexOf('const listId = repInvoiceListOf(') < create.indexOf(BLOCK_FROM));
  assert.ok(create.indexOf('const [listInfo, setListInfo]') < create.indexOf(BLOCK_FROM));
  assert.ok(create.indexOf(BLOCK_TO) < create.indexOf('const insPreview = '));
});

test('لا قراءة للنوع المختار (type/plan) في الشاشة خارج مقطع النوع الفعّال ومؤثّره', () => {
  const base = createFn.getStart(sf);
  const allowedFrom = base + create.indexOf(BLOCK_FROM);
  const allowedTo = base + create.indexOf(EFFECT_TO) + EFFECT_TO.length;
  // متغيّرٌ محلّيٌّ آخر اسمه plan (خطة اللوط) داخل lotOfflinePlan
  const lotFn = between(create, 'const lotOfflinePlan = async', '\n  };\n');
  const lotFrom = base + create.indexOf(lotFn);
  const lotTo = lotFrom + lotFn.length;
  const stray: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && (n.text === 'type' || n.text === 'plan')) {
      const p = n.parent;
      const declOrName = (ts.isPropertyAssignment(p) && p.name === n) || (ts.isJsxAttribute(p) && p.name === n)
        || (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isVariableDeclaration(p) && p.name === n)
        || ts.isBindingElement(p) || (ts.isPropertySignature(p) && p.name === n) || ts.isParameter(p);
      const at = n.getStart(sf);
      const inBlock = at >= allowedFrom && at <= allowedTo;
      const inLot = n.text === 'plan' && at >= lotFrom && at <= lotTo;
      if (!declOrName && !inBlock && !inLot) stray.push(`${n.text} @${sf.getLineAndCharacterOfPosition(at).line + 1}: ${p.getText(sf).slice(0, 90)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(createFn);
  assert.deepEqual(stray, []);
});

// ═══ الأزرار والتنبيه: المقطعان من RepApp حرفاً، يُترجمان (JSX ⇒ React.createElement) ويُرسمان بخادم React ═══
const BUTTONS_JSX = between(repApp, '<div className="flex items-center gap-2 mb-2">\n                <span className="text-xs text-gray-600">{tr(\'النوع\')}:</span>', '\n              </div>');
const NOTE_JSX = between(repApp, '{cashOnlyList && (\n              <p ', "{tr('لا تملك صلاحية البيع النقدي أو الآجل')}.</p>}");
function renderJsx(jsx: string, scope: Record<string, unknown>): string {
  const src = `function view() { return (<>${jsx}</>); }`;
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React, jsxFactory: 'React.createElement', jsxFragmentFactory: 'React.Fragment' },
    fileName: 'view.tsx',
  }).outputText;
  const view = new Function('React', ...Object.keys(scope), `${js}\nreturn view;`)(React, ...Object.values(scope)) as () => React.ReactElement;
  return renderToStaticMarkup(view());
}
type Perms = { credit: boolean; cash: boolean; installment: boolean };
const ALL: Perms = { credit: true, cash: true, installment: true };
function screen(listId: string | null, type: SaleType, plan: Plan, perms: Perms = ALL, isReturn = false): string {
  const e = effective(isReturn, info, listId, type, plan);
  const scope = {
    tr: (s: string) => s, isReturn, ...e, CASH_ONLY_NOTE, setType: () => undefined, setPlan: () => undefined,
    canSellOnCredit: perms.credit, canSellInCash: perms.cash, canSellOnInstallment: perms.installment && perms.credit, canSellAnyType: perms.credit || perms.cash,
  };
  return renderJsx(BUTTONS_JSX + NOTE_JSX, scope);
}
/** الزرّ باسمه: هل هو معطّل، وهل هو المضاء */
const btn = (html: string, label: string) => {
  const m = html.match(new RegExp(`<button([^>]*)>${label}</button>`));
  assert.ok(m, `زرّ ${label}: ${html}`);
  return { disabled: /\sdisabled=""/.test(m![1]), on: /bg-(orange|green)-500 text-white|bg-\[#5B4B9C\] text-white/.test(m![1]) };
};

test('الرسم: قائمةٌ نقدية ⇒ «آجل» و«تقسيط» معطّلان و«نقدي» مضاء، وتحتها «<اسم القائمة>» — CASH_ONLY_NOTE', () => {
  for (const [type, plan] of CHOICES) {
    const html = screen('l-cash', type, plan);
    assert.deepEqual(btn(html, 'آجل'), { disabled: true, on: false }, `${type}/${plan}`);
    assert.deepEqual(btn(html, 'تقسيط'), { disabled: true, on: false }, `${type}/${plan}`);
    assert.deepEqual(btn(html, 'نقدي'), { disabled: false, on: true }, `${type}/${plan}`);
    assert.ok(html.includes(`«دفع كاش» — ${CASH_ONLY_NOTE}`), html);
    assert.match(html, /role="status" data-rep-cash-only=""/);
    assert.doesNotMatch(html, /لا تملك صلاحية/);
  }
  assert.equal(CASH_ONLY_NOTE, 'هذه القائمة للبيع النقدي فقط — لا يباع بها آجل ولا تقسيط');
});

test('الرسم: قائمةٌ بلا القيد أو مرتجع ⇒ الأزرار كما كانت حرفاً ولا تنبيه', () => {
  const credit = screen('l-whole', 'CREDIT', 'IMMEDIATE');
  assert.deepEqual(btn(credit, 'آجل'), { disabled: false, on: true });
  assert.deepEqual(btn(credit, 'تقسيط'), { disabled: false, on: false });
  assert.doesNotMatch(credit, /data-rep-cash-only/);
  const ins = screen(null, 'CREDIT', 'INSTALLMENT');
  assert.deepEqual(btn(ins, 'تقسيط'), { disabled: false, on: true });
  assert.deepEqual(btn(ins, 'آجل'), { disabled: false, on: false });
  // صلاحيات المندوب كما كانت: بلا تقسيط معطّل، وبلا آجل معطّل
  assert.equal(btn(screen('l-whole', 'CASH', 'IMMEDIATE', { credit: true, cash: true, installment: false }), 'تقسيط').disabled, true);
  assert.equal(btn(screen('l-whole', 'CASH', 'IMMEDIATE', { credit: false, cash: true, installment: false }), 'آجل').disabled, true);
  assert.doesNotMatch(screen('l-cash', 'CREDIT', 'IMMEDIATE', ALL, true), /data-rep-cash-only|للبيع النقدي فقط/, 'المرتجع');
});

test('الرسم: مندوبٌ بلا «البيع النقدي» وقائمةٌ نقدية ⇒ لا نوع مسموحاً: الأزرار الثلاثة معطّلة، والتنبيه وسببه — وبلا أي نوعٍ السطر العامّ وحده', () => {
  const html = screen('l-cash', 'CREDIT', 'IMMEDIATE', { credit: true, cash: false, installment: true });
  for (const label of ['آجل', 'نقدي', 'تقسيط']) assert.equal(btn(html, label).disabled, true, label);
  assert.ok(html.includes(`«دفع كاش» — ${CASH_ONLY_NOTE}`));
  assert.match(html, />لا تملك صلاحية البيع النقدي\.<\/p>/);
  const none = screen('l-cash', 'CASH', 'IMMEDIATE', { credit: false, cash: false, installment: false });
  assert.doesNotMatch(none, />لا تملك صلاحية البيع النقدي\.<\/p>/);
  assert.match(none, />لا تملك صلاحية البيع النقدي أو الآجل\.<\/p>/);
  // والإصدار ممنوعٌ في submit (لا زرّ معطّل صامت): الزرّ يبقى بشروطه كما كانت فيقول السبب عند الضغط
  assert.match(create, /<button onClick=\{submit\} disabled=\{loading \|\| \(!isReturn && \(perms\.canCreateInvoice === false \|\| !canSellAnyType\)\)\}/);
});

test('التنبيه تحت أزرار النوع وفوق رقاقات قائمة الأسعار — واسم القائمة بيانات الشركة لا يمرّ بـtr', () => {
  const at = repApp.indexOf('data-rep-cash-only=""');
  assert.ok(repApp.indexOf("{tr('تقسيط')}</button>") < at);
  assert.ok(at < repApp.indexOf('data-rep-price-type=""'));
  assert.ok(NOTE_JSX.includes('{`«${cashOnlyList.name}» — ${tr(CASH_ONLY_NOTE)}`}'));
  assert.doesNotMatch(NOTE_JSX, /tr\(cashOnlyList/);
  assert.equal((repApp.match(/tr\(CASH_ONLY_NOTE\)/g) ?? []).length, 1);
});

test('ردّ الخادم 409 PRICE_LIST_CASH_ONLY: رسالته بعبارة القاموس بلغة المندوب، وأسماء القوائم ونوع العميل من الخادم الآن فينقلب النوع إلى نقدي', () => {
  const guard = "if (err?.response?.data?.code === 'PRICE_LIST_CASH_ONLY' && !saleRef) { void loadPriceLists(true); setMsg(tr(PRICE_LIST_CASH_ONLY_MSG)); setLoading(false); return; }";
  const generic = "setMsg(err?.response?.data?.message || tr('تعذر إصدار المستند حاول مجددا')); setLoading(false);";
  assert.ok(submit.includes(guard));
  assert.ok(submit.includes(generic));
  assert.ok(submit.indexOf(guard) < submit.indexOf(generic), 'يخرج قبل الرسالة العامة (نصّ الخادم الخام بلا ترجمة)');
  assert.match(repApp, /import \{[^}]*\bPRICE_LIST_CASH_ONLY_MSG\b[^}]*\} from '\.\.\/lib\/priceLists';/);
  // العبارة حرفُ رسالة الخادم (backend/src/tests/price-list-cash-only.test.ts يطابقهما) وفي القاموس بلغاته
  assert.equal(PRICE_LIST_CASH_ONLY_MSG, 'قائمة الأسعار هذه للبيع النقدي فقط — لا يباع بها آجل ولا تقسيط');
  assert.ok(PRICE_LIST_CASH_ONLY_MSG in PHRASES);
  // والمرتجع وتغيّر الضريبة يخرجان قبل الرسالة العامة كما كانا
  const tail = between(submit, guard, generic);
  assert.match(tail, /if \(isReturn && RETURN_POLICY_CODES\.has\(err\?\.response\?\.data\?\.code\)\)/);
  assert.match(tail, /if \(isTaxModeChanged\(err\)\)/);
  // والجلب القسري يتجاوز كاش الأسماء (repCachedNamesOf) — هو الذي لم يعرف القيد
  assert.match(create, /const cachedNames = force \? null : repCachedNamesOf\(/);
});
