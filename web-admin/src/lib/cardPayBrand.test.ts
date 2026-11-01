import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * «التحصيل بالبطاقة» بلا اسم مزوّد البنية (طلب المالك ١ نوفمبر ٢٠٢٦): لا يرى مستخدم الشركة ولا المندوب اسم NearPay
 * بأيّ كتابة في أيّ نصّ معروض — شاشات المندوب ورسائله، صفحات الإدارة، /m، والترجمات الخمس.
 *  (أ) كل نصٍّ حرفيّ في src (سلاسل وقوالب ونصوص JSX) خارج لوحة المالك وبوابة الموظفين والاختبارات خالٍ من الاسم —
 *      والتعليقات والمعرّفات (nearpayTid، cardPayApi…) ليست نصاً معروضاً فلا تُفحص.
 *  (ب) مدخلات القاموس (PHRASES وDICT) التي تذكر الاسم في مفتاحها أو أيّ ترجمة لها مفاتيحُ للوحة المالك وحدها.
 *  (ج) وضع الاختبار ظاهرٌ للمندوب ولمدير الشركة بلا ذكر المزوّد (cardPayTest من GET /api/company).
 */

const SRC = path.resolve(process.cwd(), 'src');
const BRAND = /near[\s\-_]*pay|نير\s*باي/i;
// مسارٌ أو مفتاحٌ برمجيّ صغير الحروف بلا مسافات ('nearpay-merchants'، 'io.nearpay:…') — ليس نصاً يُعرض
const CODE_LIKE = /^[a-z0-9_\-./:?=&@#%+]*$/;
// لوحة المالك وبوابة موظفي المنصة — داخلية، ويبقى فيها الاسم
const OWNER_FILES = new Set(['pages/PlatformPage.tsx', 'pages/StaffLoginPage.tsx', 'pages/StaffChangePasswordPage.tsx']);
const STRINGS = 'i18n/strings.ts';

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const f = path.join(d, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(f);
  return /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts') ? [f] : [];
});
const FILES = walk(SRC).map(rel);

interface Lit { text: string; line: number }
const cache = new Map<string, { sf: ts.SourceFile; lits: Lit[] }>();
/** كل نصٍّ حرفيّ في الملف: سلاسل، وقوالب بأجزائها، ونصوص JSX — بلا مسارات الاستيراد */
function literals(file: string) {
  const hit = cache.get(file);
  if (hit) return hit;
  const s = fs.readFileSync(path.join(SRC, file), 'utf8');
  const sf = ts.createSourceFile(file, s, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lits: Lit[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)
      || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) {
      lits.push({ text: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const out = { sf, lits };
  cache.set(file, out);
  return out;
}
const branded = (t: string) => BRAND.test(t) && !CODE_LIKE.test(t);

test('(أ) لا نصّ معروض يذكر NearPay خارج لوحة المالك — المندوب والإدارة و/m والصفحات العامة', () => {
  const bad: string[] = [];
  for (const f of FILES) {
    if (OWNER_FILES.has(f) || f === STRINGS) continue;
    for (const l of literals(f).lits) if (branded(l.text)) bad.push(`${f}:${l.line}: ${l.text.trim().slice(0, 120)}`);
  }
  assert.deepEqual(bad, [], `نصوصٌ تذكر المزوّد:\n${bad.join('\n')}`);
});

test('(ب) القاموس: كل مدخلٍ يذكر NearPay (مفتاحاً أو ترجمة) مفتاحٌ للوحة المالك وحدها — لا يُستعمل خارجها', () => {
  const { sf } = literals(STRINGS);
  // كل نصٍّ حرفيّ خارج لوحة المالك (tr('…') وقوائم التسميات التي تُترجم لاحقاً) — ومقابله في لوحة المالك
  const outside = new Set<string>();
  const owner = new Set<string>();
  for (const f of FILES) {
    if (f === STRINGS) continue;
    for (const l of literals(f).lits) (OWNER_FILES.has(f) ? owner : outside).add(l.text);
  }
  const bad: string[] = [];
  let entries = 0;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ['PHRASES', 'DICT'].includes(n.name.text)
      && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      for (const p of n.initializer.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        entries++;
        const key = ts.isStringLiteral(p.name) || ts.isIdentifier(p.name) ? p.name.text : p.name.getText(sf);
        const texts: string[] = [key];
        const grab = (x: ts.Node) => { if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) texts.push(x.text); ts.forEachChild(x, grab); };
        grab(p.initializer);
        if (!texts.some(branded)) continue;
        const line = sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1;
        if (outside.has(key)) bad.push(`${STRINGS}:${line}: «${key.slice(0, 80)}» مستعملٌ خارج لوحة المالك`);
        else if (!owner.has(key)) bad.push(`${STRINGS}:${line}: «${key.slice(0, 80)}» لا يستعمله أحد — احذفه`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(entries > 1000, `قُرئ القاموس (${entries} مدخلاً)`);
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('(ب) والمفاتيح التي تبقى فيها NearPay تُستعمل في لوحة المالك فعلاً — والحارس يلتقط الاسم بكل كتاباته', () => {
  const p = literals('pages/PlatformPage.tsx').lits.map((l) => l.text);
  assert.ok(p.includes('تفعيل التحصيل بالبطاقة (NearPay) لهذه الشركة'), 'اسم المزوّد يبقى للمالك');
  for (const t of ['NearPay', 'Nearpay', 'NEARPAY', 'near pay', 'نيرباي', 'نير باي', 'عبر Near-Pay']) assert.ok(branded(t), t);
  for (const t of ['nearpay-merchants', '/card-payments/owner/nearpay', 'io.nearpay:terminalsdk-release']) assert.ok(!branded(t), t);
});

const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

test('(ج) وضع الاختبار: المندوب يرى «وضع تجريبي» على الزرّ وفي الورقة والنتيجة، ومدير الشركة في نافذة نقاط البيع', () => {
  const TEST = "tr('وضع تجريبي — لا يخصم مال من البطاقة')";
  assert.match(read('types/index.ts'), /cardPayTest\?: boolean;/);
  const pay = read('rep/CardPay.tsx');
  assert.match(pay, /export function CardPaySheet\(\{ customer, test = false, onClose \}/);
  assert.match(pay, /export function CardPayResult\(\{ pending, unsupported, test = false, onClose, onDone \}/);
  assert.equal(pay.split(TEST).length - 1, 1, 'اللافتة نصٌّ واحد (TestModeNote)');
  assert.ok(pay.includes('{test && <TestModeNote className="mb-3" />}'), 'في الورقة');
  assert.ok(pay.includes('{test && !unsupported && <TestModeNote className="mt-4" />}'), 'وفي النتيجة');
  assert.ok(pay.includes('<CardPayResult pending={viewing} test={test} '), 'ونتيجة العملية السابقة من الورقة');
  const app = read('rep/RepApp.tsx');
  assert.ok(app.includes('<CardPaySheet customer={customer} test={cardPayTest} onClose={() => setCardPayOpen(false)} />'));
  assert.ok(app.includes("{cardPayTest && <span className=\"text-[10px] font-bold bg-amber-400 text-[#1F1A13] rounded px-1.5 py-0.5\">{tr('تجريبي')}</span>}"));
  assert.ok(app.includes('const cardPayTest = company?.cardPayTest === true;'));
  assert.ok(app.includes('test={company?.cardPayTest === true}'), 'النتيجة بعد الرجوع من وحدة الدفع');
  const modal = read('components/CardTerminalsModal.tsx');
  assert.match(modal, /export default function CardTerminalsModal\(\{ test = false, onClose \}/);
  assert.ok(modal.includes("{test && ("));
  assert.ok(read('pages/SalesRepsPage.tsx').includes('<CardTerminalsModal test={companyCfg?.cardPayTest === true} onClose={() => setCardTerminalsOpen(false)} />'));
});
