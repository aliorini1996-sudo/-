// «الوحدة الرئيسية» — حرّاسٌ نصّية (primary_unit_spec §8، الثابتان I2 وI10):
//   • I2 الحساب لا يقرأ الرئيسية: `primaryUnitId` (ولا `primaryUnitOf`) غائبٌ عن ملفات الحساب والضريبة وERP وLOT، وعن أجسام
//     دوال الحساب بالوحدة (toBase وbaseQtyOf وunitFields وunitPriceOf وrefundAmount وpickLineUnit وresolveLineUnit).
//   • I10 انتظارٌ محدود: كل `FOR KEY SHARE` على `products` في مسارات الإصدار والإشعارات وحارس الأساس تسبقه
//     `set_config('lock_timeout'` في الدالة نفسها، وكل `$transaction(async` فيها `lockBases(` تمرّر خيارات فيها `timeout`.
// نصٌّ ثابت بلا قاعدة ولا تشغيل — يعضّ حين يُضاف قارئٌ للرئيسية في الحساب أو قفلٌ بلا مهلة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

/** النص بلا تعليقات (// و/* *\/) — ليُفحص الكود وحده لا شرحه */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

/**
 * موضع القوس المُغلِق المطابق للقوس المفتوح عند `open` — يتخطّى النصوص (ومنها قوالب SQL) والتعليقات. يكفي لكود هذا المستودع
 * (لا تعبيرات نمطية بأقواس غير متوازنة داخل المعاملات المفحوصة)، ويرمي إن لم يجد مطابقاً بدل أن يمرّ صامتاً.
 */
function matchClose(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) throw new Error(`أقواس غير متوازنة عند ${i}`);
      if (!stack.length) return i;
    }
  }
  throw new Error(`لا قوس مُغلِق للموضع ${open}`);
}

/** جسم الدالة المسمّاة (من `function NAME(` إلى نهاية كتلتها) — يرمي إن غابت فلا يمرّ الفحص فارغاً */
function functionBody(src: string, name: string): string {
  const at = src.search(new RegExp(`function ${name}\\s*[(<]`));
  assert.ok(at >= 0, `الدالة ${name} غائبة`);
  const params = src.indexOf('(', at);
  const brace = src.indexOf('{', matchClose(src, params));
  return src.slice(at, matchClose(src, brace) + 1);
}

// ═══ I2 ═══

const I2_FILES = [
  'lib/invoiceCalc.ts',
  'services/erpPayload.ts',
  'services/returnLinks.ts',
  'services/warehouseCost.ts',
  'services/lotsDb.ts',
  'services/lotsVan.ts',
  'services/lotsInvoice.ts',
  'compliance/zatca/ubl.ts',
  'compliance/zatca/xml.ts',
];

test('I2: الرئيسية لا تظهر في ملفات الحساب والضريبة وERP وLOT', () => {
  for (const rel of I2_FILES) {
    const src = read(rel);
    assert.doesNotMatch(src, /primaryUnitId/, `${rel} يقرأ primaryUnitId`);
    assert.doesNotMatch(src, /primaryUnitOf|primaryPriceOf|primaryChoice/, `${rel} يستعمل مساعد الرئيسية`);
  }
});

test('I2: أجسام دوال الحساب بالوحدة لا تقرأ الرئيسية', () => {
  const bodies: Array<[string, string]> = [
    ['services/units.ts', 'toBase'],
    ['services/units.ts', 'baseQtyOf'],
    ['services/units.ts', 'unitFields'],
    ['services/units.ts', 'unitPriceOf'],
    ['services/units.ts', 'refundAmount'],
    ['services/warehouseStock.ts', 'pickLineUnit'],
    ['routes/invoices.ts', 'resolveLineUnit'],
  ];
  for (const [rel, fn] of bodies) {
    const body = functionBody(read(rel), fn);
    assert.ok(body.length > 40, `${rel} ${fn}: جسمٌ فارغ`);
    assert.doesNotMatch(body, /primaryUnitId|primaryUnitOf|primaryPriceOf|isPrimary/, `${rel} ${fn} يقرأ الرئيسية`);
  }
});

test('حارس الحارس: الفحص يعضّ جسماً يقرأ الرئيسية، ويرمي لدالةٍ غائبة', () => {
  const bad = 'export function toBase(qty: number, row?: { primaryUnitId?: string }): number {\n  return row?.primaryUnitId ? 0 : qty;\n}\n';
  assert.match(functionBody(bad, 'toBase'), /primaryUnitId/);
  assert.throws(() => functionBody(bad, 'baseQtyOf'));
  assert.equal(stripComments('a // primaryUnitId\nb /* primaryUnitId */ c'), 'a \nb  c');
});

// ═══ I10 ═══

// ومسارات LOT (convert-base-2): lockLotProducts وassertReturnStillUntracked — المهلة قبل FOR KEY SHARE على الأصناف لا أقفال اللوط وحدها
const I10_LOCK_FILES = ['routes/invoices.ts', 'routes/invoicesZatca.ts', 'routes/invoicesNotes.ts', 'services/baseGuard.ts', 'services/lotsDb.ts', 'services/lotsInvoice.ts'];

/** بداية الدالة/المسار العلوي المحيط بالموضع: آخر سطرٍ في العمود صفر يبدأ دالةً أو مساراً أو ثابتاً قبله */
function enclosingTopLevel(src: string, at: number): number {
  const re = /^(?:export\s+)?(?:async\s+)?function\s|^(?:export\s+)?const\s|^router\.|^[a-zA-Z]+\.(?:get|post|put|patch|delete)\(/gm;
  let start = 0;
  for (let m = re.exec(src); m && m.index < at; m = re.exec(src)) start = m.index;
  return start;
}

/** مواضع `FOR KEY SHARE` في كود قفلٍ على `products` (لا في التعليقات) */
function keyShareOnProducts(code: string): number[] {
  const out: number[] = [];
  for (let i = code.indexOf('FOR KEY SHARE'); i >= 0; i = code.indexOf('FOR KEY SHARE', i + 1)) {
    const stmt = code.slice(code.lastIndexOf('`', i - 1), i);
    if (/\bproducts\b/.test(stmt)) out.push(i);
  }
  return out;
}

test('I10: كل FOR KEY SHARE على products في الإصدار والإشعارات وحارس الأساس تسبقه مهلة قفلٍ في الدالة نفسها', () => {
  let seen = 0;
  for (const rel of I10_LOCK_FILES) {
    const code = stripComments(read(rel));
    for (const at of keyShareOnProducts(code)) {
      seen++;
      const fn = code.slice(enclosingTopLevel(code, at), at);
      assert.match(fn, /set_config\('lock_timeout'/, `${rel}: FOR KEY SHARE بلا lock_timeout قبله في الدالة نفسها (…${code.slice(at - 120, at + 13)})`);
    }
  }
  assert.ok(seen >= 3, `قلّ عدد أقفال الأصناف المفحوصة (${seen}) — الفحص لا يرى ما يحرسه`);
});

/** كل `$transaction(async` في المصدر: جسم الاستدعاء كاملاً (من القوس إلى مُغلِقه) */
function transactions(code: string): string[] {
  const out: string[] = [];
  const re = /\$transaction\(\s*async\b/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const open = code.indexOf('(', m.index);
    out.push(code.slice(open, matchClose(code, open) + 1));
  }
  return out;
}

/** خيارات المعاملة: ما بعد الدالة الممرَّرة أولاً (`async (tx) => { … }`) داخل الاستدعاء */
function txOptions(call: string): string {
  const arrow = call.indexOf('=>');
  const body = call.indexOf('{', arrow);
  return call.slice(matchClose(call, body) + 1, -1);
}

/**
 * الخيارات بمهلةٍ صريحة: `BASE_GUARD_TX`، أو كائنٌ فيه `timeout:`، أو ثابتٌ محليّ (`const X = { … timeout: … }` في الملف نفسه)
 */
function hasTimeout(opts: string, code: string): boolean {
  if (/BASE_GUARD_TX|\btimeout\s*:/.test(opts)) return true;
  const id = opts.replace(/^[\s,]+|[\s,]+$/g, '');
  if (!/^[A-Za-z_$][\w$]*$/.test(id)) return false;
  const m = new RegExp(`\\bconst\\s+${id}\\s*=\\s*\\{`).exec(code);
  if (!m) return false;
  const brace = code.indexOf('{', m.index);
  return /\btimeout\s*:/.test(code.slice(brace, matchClose(code, brace) + 1));
}

test('I10: كل معاملةٍ فيها lockBases تمرّر مهلةً صريحة (BASE_GUARD_TX أو timeout)', () => {
  const files = fs.readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.ts')).map((f) => `routes/${f}`)
    .concat(fs.readdirSync(path.join(SRC, 'services')).filter((f) => f.endsWith('.ts')).map((f) => `services/${f}`));
  let seen = 0;
  for (const rel of files) {
    const code = stripComments(read(rel));
    if (!code.includes('lockBases(')) continue;
    for (const call of transactions(code)) {
      if (!call.includes('lockBases(')) continue;
      seen++;
      assert.ok(hasTimeout(txOptions(call), code), `${rel}: معاملةٌ فيها lockBases بلا مهلة (${call.slice(0, 160)}…)`);
    }
  }
  assert.ok(seen >= 1, 'لا معاملة فيها lockBases — الفحص لا يرى ما يحرسه');
});

test('حارس الحارس: خيارات المعاملة تُقرأ بعد جسم الدالة لا من داخله', () => {
  const ok = 'await prisma.$transaction(async (tx) => { await lockBases(tx, t, e); f({ timeout: 1 }); }, BASE_GUARD_TX);';
  const bad = 'await prisma.$transaction(async (tx) => { await lockBases(tx, t, e); f({ timeout: 1 }); });';
  assert.match(txOptions(transactions(ok)[0]), /BASE_GUARD_TX/);
  assert.equal(hasTimeout(txOptions(transactions(bad)[0]), bad), false);
  const local = 'const MY_TX = { maxWait: 1, timeout: 2 } as const;\nawait prisma.$transaction(async (tx) => { await lockBases(tx, t, e); }, MY_TX);';
  assert.equal(hasTimeout(txOptions(transactions(local)[0]), local), true, 'ثابتٌ محليّ بمهلة');
  const noTo = 'const MY_TX = { maxWait: 1 } as const;\nawait prisma.$transaction(async (tx) => { await lockBases(tx, t, e); }, MY_TX);';
  assert.equal(hasTimeout(txOptions(transactions(noTo)[0]), noTo), false, 'ثابتٌ بلا timeout');
  const lockNoTimeout = 'async function f(tx) {\n  await tx.$queryRaw`SELECT id FROM products WHERE id = 1 FOR KEY SHARE`;\n}\n';
  const code = stripComments(lockNoTimeout);
  const at = keyShareOnProducts(code)[0];
  assert.doesNotMatch(code.slice(enclosingTopLevel(code, at), at), /set_config\('lock_timeout'/);
});
