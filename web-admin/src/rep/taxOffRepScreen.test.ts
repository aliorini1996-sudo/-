// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — شاشات تطبيق المندوب: «في حال ازالة الضريبة لا يكون لها ذكر في اي سطر في النظام».
//  • حارس شجرة (TypeScript AST): كل نصٍّ ظاهرٍ في البيع/المرتجع وإضافة العميل وتعديله يذكر الضريبة («ضريب»، «شامل»، VAT، الإشعار الدائن،
//    مبسطة) محروسٌ إما بالوضع (`!taxOff &&` أو فرع `taxOff ? … : هنا`) وإما بالمرحلة الثانية (zatcaPhase2/retPhase2/retManualOk/zatcaCollect،
//    و202 بانتظار اعتماد الهيئة) — والخادم يمنع اجتماع الإزالة مع المرحلة الثانية (409 TAX_MODE_ZATCA_CONFLICT / TAX_OFF_BLOCKS_ZATCA).
//  • رسمٌ حقيقي (react-dom/server) لمقطعي السلّة كما في RepApp.tsx حرفاً — بند المراجعة ولوحة الإجماليات — بالعربية واللغات الأربع:
//    «بلا ضريبة» لا «منها ضريبة» ولا «الضريبة X%» ولا «السعر شامل» ولا ما يقابلها (tax/VAT/TVA/TTC/KDV/税)، والافتراض يرسمها كما كان.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const repApp = read('rep', 'RepApp.tsx');
const sf = ts.createSourceFile('RepApp.tsx', repApp, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** ما يُعدّ ذكراً للضريبة في نصٍّ ظاهر (عربياً) */
const TAX_WORDS = /ضريب|شامل|VAT|ض\.ق\.م|الإشعار الدائن|إشعار دائن|مبسطة/;
/** ما يقابله في ترجمات القاموس */
const TAX_WORDS_I18N: Record<'en' | 'fr' | 'tr' | 'zh', RegExp> = { en: /\btax|\bVAT\b|incl\b/i, fr: /TVA|\btaxe|TTC/i, tr: /KDV|vergi/i, zh: /税/ };
/** أعلامٌ لا تصدق إلا مع المرحلة الثانية (والخادم يمنعها مع الإزالة) */
const PHASE2_FLAGS = new Set(['zatcaPhase2', 'retPhase2', 'retManualOk', 'zatcaCollect']);

function fnNode(name: string): ts.FunctionDeclaration {
  let out: ts.FunctionDeclaration | undefined;
  sf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) out = n; });
  assert.ok(out, `غائب: function ${name}`);
  return out!;
}
const conjuncts = (e: ts.Expression): string[] => e.getText(sf).split('&&').map((s) => s.trim().replace(/^\(|\)$/g, ''));

/** لماذا لا يظهر هذا النصّ لشركةٍ «بلا ضريبة»؟ 'taxOn' = محروسٌ بالوضع، 'phase2' = بالمرحلة الثانية، null = يظهر */
function guardOf(node: ts.Node, fn: ts.Node): 'taxOn' | 'phase2' | null {
  for (let n: ts.Node = node; n.parent && n !== fn; n = n.parent) {
    const p = n.parent;
    if (ts.isConditionalExpression(p)) {
      const c = p.condition.getText(sf);
      if (c === 'taxOff' && n === p.whenFalse) return 'taxOn';
      if (c === '!taxOff' && n === p.whenTrue) return 'taxOn';
      if (PHASE2_FLAGS.has(c) && n === p.whenTrue) return 'phase2';
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && n === p.right) {
      const cs = conjuncts(p.left);
      if (cs.includes('!taxOff')) return 'taxOn';
      if (cs.some((c) => PHASE2_FLAGS.has(c))) return 'phase2';
    }
    if (ts.isIfStatement(p) && n === p.thenStatement) {
      const cs = conjuncts(p.expression);
      if (cs.includes('!taxOff')) return 'taxOn';
      if (cs.some((c) => PHASE2_FLAGS.has(c))) return 'phase2';
      // 202 (ZATCA_CLEARANCE_PENDING): فاتورةٌ قياسية بانتظار اعتماد الهيئة — المرحلة الثانية وحدها
      if (p.expression.getText(sf) === 'res.status !== 201') return 'phase2';
    }
  }
  return null;
}

/** النصوص الظاهرة في الدالّة التي تذكر الضريبة، بحارس كلٍّ منها */
function taxTexts(name: string): Array<{ text: string; line: number; guard: 'taxOn' | 'phase2' | null }> {
  const fn = fnNode(name);
  const out: Array<{ text: string; line: number; guard: 'taxOn' | 'phase2' | null }> = [];
  const visit = (n: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) text = n.text;
    else if (ts.isJsxText(n)) text = n.text;
    if (text && TAX_WORDS.test(text)) out.push({ text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, guard: guardOf(n, fn) });
    n.forEachChild(visit);
  };
  visit(fn);
  return out;
}

test('حارس: لا نصّ يذكر الضريبة في البيع والمرتجع (CreateInvoice) إلا محروساً بالوضع أو بالمرحلة الثانية', () => {
  const found = taxTexts('CreateInvoice');
  const open = found.filter((f) => !f.guard);
  assert.deepEqual(open, [], `نصوصٌ تظهر لشركةٍ بلا ضريبة:\n${open.map((f) => `RepApp.tsx:${f.line} ${f.text}`).join('\n')}`);
  // الحارس ليس فارغاً: أسطر السلّة الثلاثة محروسة بالوضع
  const byText = new Map(found.map((f) => [f.text, f.guard]));
  for (const t of ['منها ضريبة', 'الضريبة', 'السعر شامل', 'عدل الاجمالي وسينعكس على السعر الشامل']) assert.equal(byText.get(t), 'taxOn', t);
  // وما بقي (المرحلة الثانية) معروفٌ بالاسم — نصٌّ جديدٌ يذكر الضريبة يُراجَع هنا
  assert.deepEqual([...new Set(found.filter((f) => f.guard === 'phase2').map((f) => f.text))].sort(), [
    'اكتب سبب الإرجاع كما يظهر في الإشعار الدائن',
    'سبب الإشعار الدائن',
    'صدرت الفاتورة وبانتظار اعتماد الهيئة لا تسلم فاتورة ضريبية الآن',
    'لا يمكن إصدار فاتورة ضريبية أو مرتجع دون اتصال المرحلة الثانية مفعلة',
    'يرسل الإشعار الدائن للهيئة بهذا الرقم — اكتبه كما هو على الفاتورة الأصلية',
  ].sort());
});

test('حارس: «الرقم الضريبي» في إضافة العميل وتعديله مخفيٌّ للشركة «بلا ضريبة» — والتعديل لا يرسله فيبقى المحفوظ', () => {
  for (const name of ['AddCustomer', 'EditCustomer']) {
    const found = taxTexts(name);
    const open = found.filter((f) => !f.guard);
    assert.deepEqual(open, [], `${name}:\n${open.map((f) => `RepApp.tsx:${f.line} ${f.text}`).join('\n')}`);
    assert.ok(found.some((f) => f.text === 'الرقم الضريبي' && f.guard === 'taxOn'), `${name}: الحقل غير محروس بالوضع`);
  }
  const edit = fnNode('EditCustomer').getText(sf);
  assert.match(edit, /if \(zatcaCollect\) Object\.assign\(payload, buyerUpdatePayload\(buyer, customer\)\);\n[^\n]*\n\s+if \(taxOff\) delete payload\.taxNumber;/);
  // الوضع من الشركة المخبّأة نفسها — الشاشتان
  assert.equal((repApp.match(/buyerRelax=\{buyerRelax\} taxOff=\{isTaxOff\(company\)\}/g) ?? []).length, 2);
});

// ═══ رسم السلّة: المقطعان من RepApp.tsx حرفاً، يُترجمان (JSX ⇒ React.createElement) ويُرسمان بخادم React ═══
const between = (s: string, from: string, to: string, keepTo = true) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, `غائب: ${from}`);
  const b = s.indexOf(to, a + from.length);
  assert.ok(b > a, `غائب بعده: ${to}`);
  return s.slice(a, keepTo ? b + to.length : b);
};
// بند المراجعة: خانات الكمية والسعر والخصم ثم سطر «منها ضريبة» والإجمالي
const LINE_JSX = between(repApp, '<div className="grid grid-cols-3 gap-2">\n                  {/* «إزالة الضريبة»: «السعر» وحده', '\n              </div>\n            ))}', false);
// لوحة الإجماليات تحت البنود
const TOTALS_JSX = between(repApp, '<div className="bg-white rounded-xl p-4 mt-2 border border-gray-100 space-y-1.5 text-sm">', '\n            </div>');

type Scope = Record<string, unknown>;
function renderJsx(jsx: string, scope: Scope): string {
  const src = `function view() { return (<>${jsx}</>); }`;
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React, jsxFactory: 'React.createElement', jsxFragmentFactory: 'React.Fragment' },
    fileName: 'view.tsx',
  }).outputText;
  const view = new Function('React', ...Object.keys(scope), `${js}\nreturn view;`)(React, ...Object.values(scope)) as () => React.ReactElement;
  return renderToStaticMarkup(view());
}
const DecimalInput = (p: { value: unknown; title?: string; readOnly?: boolean }) =>
  React.createElement('input', { value: String(p.value), title: p.title, readOnly: p.readOnly, onChange: () => undefined });
const money = (n: number) => Number(n).toFixed(2);

/** سلّةٌ بالمعطيات كما يبنيها CreateInvoice — بندان بنسبة الوضع (صفرٌ عند الإزالة)، والمحرّك صفرٌ للضريبة عند الإزالة */
function scopeOf(taxOff: boolean, tr: (s: string) => string, canChangePrice: boolean): Scope {
  const pct = taxOff ? 0 : 15;
  const lines = [{ qty: 2, unitPrice: taxOff ? 10 : 11.5, discountPct: 0, taxPct: pct }, { qty: 1, unitPrice: taxOff ? 24 : 27.6, discountPct: 0, taxPct: pct }];
  const items = taxOff ? [{ lineTotal: 20, taxAmt: 0 }, { lineTotal: 24, taxAmt: 0 }] : [{ lineTotal: 23, taxAmt: 3 }, { lineTotal: 27.6, taxAmt: 3.6 }];
  return {
    taxOff, tr, formatCurrency: money, perms: { canChangePrice }, maxDisc: 5, l: lines[0], i: 0, DecimalInput, upd: () => undefined,
    repCalc: { items }, lines, subtotal: taxOff ? 44 : 50.6, discount: 0, tax: taxOff ? 0 : 6.6, total: taxOff ? 44 : 50.6,
  };
}
const trAr = (s: string) => s;
const trIn = (lang: 'en' | 'fr' | 'tr' | 'zh') => (s: string) => PHRASES[s]?.[lang] ?? s;
const cart = (taxOff: boolean, tr: (s: string) => string, canChangePrice: boolean) =>
  renderJsx(LINE_JSX, scopeOf(taxOff, tr, canChangePrice)) + renderJsx(TOTALS_JSX, scopeOf(taxOff, tr, canChangePrice));

test('رسم السلّة لشركةٍ «بلا ضريبة»: لا «منها ضريبة» ولا «الضريبة X%» ولا «السعر شامل» — بالعربية واللغات الأربع', () => {
  for (const canChangePrice of [true, false]) {
    const ar = cart(true, trAr, canChangePrice);
    assert.doesNotMatch(ar, TAX_WORDS, ar);
    assert.doesNotMatch(ar, /15%|0%/, 'نسبةٌ مطبوعة');
    assert.match(ar, />السعر</, '«السعر» وحده');
    assert.match(ar, /الإجمالي/);
    assert.match(ar, /44\.00/);
    if (canChangePrice) assert.match(ar, /title="عدل الاجمالي وسينعكس على سعر الوحدة"/);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
      const html = cart(true, trIn(lang), canChangePrice);
      assert.doesNotMatch(html, TAX_WORDS_I18N[lang], `${lang}: ${html}`);
      assert.doesNotMatch(html, /[؀-ۿ]/, `${lang}: نصٌّ عربيٌّ بلا ترجمة في القاموس`);
    }
  }
});

test('رسم السلّة بلا العلم (الافتراض): «منها ضريبة» و«الضريبة 15%» و«السعر شامل» كما كانت — الحارس ليس فارغاً', () => {
  const ar = cart(false, trAr, true);
  assert.match(ar, /منها ضريبة: 3\.00/);
  assert.match(ar, /<span>الضريبة 15%<\/span><span>6\.60<\/span>/);
  assert.match(ar, />السعر شامل</);
  assert.match(ar, /title="عدل الاجمالي وسينعكس على السعر الشامل"/);
  const en = cart(false, trIn('en'), true);
  assert.match(en, /incl tax/);
  // ونسبٌ مختلطة ⇒ «نسب متعددة» كما كانت
  const mixed = renderJsx(TOTALS_JSX, { ...scopeOf(false, trAr, true), lines: [{ taxPct: 15 }, { taxPct: 5 }] });
  assert.match(mixed, /الضريبة نسب متعددة/);
});
