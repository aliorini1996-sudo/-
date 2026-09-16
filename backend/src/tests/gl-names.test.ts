// M2 — G7: الاسم العربي إلزامي في الحساب والدفتر والضريبة واستيراد الشجرة (DESIGN.md §9.5 G7، §8.7).
// hasArabicLetter وassertArabicName صرفتان، وحارس ثابت على معالجات routes/ledger/config.ts — بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertArabicName, hasArabicLetter } from '../services/gl/names';
import { isLedgerError } from '../services/gl/types';

const ROOT = path.join(__dirname, '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const src = (rel: string) => strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function routeBody(file: string, method: string, route: string): string {
  const s = src(file);
  const start = s.indexOf(`router.${method}('${route}'`);
  assert.ok(start >= 0, `${file}: ${method.toUpperCase()} ${route} غير مسجّل`);
  const next = s.slice(start + 10).search(/\n(router\.(get|post|put|delete|patch)\(|export |async function |function |const |type |interface )/);
  return next < 0 ? s.slice(start) : s.slice(start, start + 10 + next);
}

test('hasArabicLetter: حرف من U+0600–06FF أو U+0750–077F يكفي', () => {
  assert.equal(hasArabicLetter('الصندوق'), true);
  assert.equal(hasArabicLetter('Cash ص'), true);
  assert.equal(hasArabicLetter('ب'), true); // ب
  assert.equal(hasArabicLetter('ݐ'), true); // ݐ (ملحق العربية)
  assert.equal(hasArabicLetter('ݿ'), true);
  assert.equal(hasArabicLetter('Bank 01 ݥ'), true);
});

test('hasArabicLetter: اللاتيني والأرقام والفراغ وغير النصوص مرفوضة', () => {
  for (const v of ['Cash', 'Main Bank', '123456', '', '   ', '\t\n', 'Ünïcödé', '现金', 'Касса']) {
    assert.equal(hasArabicLetter(v), false, JSON.stringify(v));
  }
  for (const v of [null, undefined, 42, ['ب'], { name: 'ب' }]) assert.equal(hasArabicLetter(v), false, String(v));
  // خارج النطاقين: حرف قبل U+0600 وبعد U+077F
  assert.equal(hasArabicLetter('׿'), false);
  assert.equal(hasArabicLetter('ހ'), false);
});

test('assertArabicName: يرمي LEDGER_NAME_ARABIC_REQUIRED (422) بالحقل والكيان، ويمرّ للاسم العربي', () => {
  assert.throws(() => assertArabicName('Cash', { entity: 'ACCOUNT' }), (e: unknown) => {
    assert.ok(isLedgerError(e, 'LEDGER_NAME_ARABIC_REQUIRED'));
    assert.equal(e.httpStatus, 422);
    assert.equal(e.details.field, 'name');
    assert.equal(e.details.entity, 'ACCOUNT');
    return true;
  });
  assert.throws(() => assertArabicName('   '), (e: unknown) => isLedgerError(e, 'LEDGER_NAME_ARABIC_REQUIRED'));
  assert.doesNotThrow(() => assertArabicName('يومية عامة'));
});

test('حارس ثابت: POST/PUT للحساب والدفتر والضريبة والاستيراد تفحص الاسم العربي قبل أي كتابة', () => {
  const config = 'routes/ledger/config.ts';
  const cases: [string, string, string, RegExp][] = [
    ['post', '/accounts', 'ACCOUNT', /tx\.glAccount\.create\(|prisma\.glAccount\.create\(|\.glAccount\.create\(/],
    ['put', '/accounts/:id', 'ACCOUNT', /\.glAccount\.update\(/],
    ['post', '/journals', 'JOURNAL', /\.glJournal\.create\(/],
    ['put', '/journals/:id', 'JOURNAL', /\.glJournal\.update\(/],
    ['post', '/taxes', 'TAX', /\.glTax\.create\(/],
    ['put', '/taxes/:id', 'TAX', /\.glTax\.update\(/],
  ];
  for (const [method, route, entity, write] of cases) {
    const body = routeBody(config, method, route);
    const check = body.search(new RegExp(`assertArabicName\\(body\\.name, \\{ entity: '${entity}' \\}\\)`));
    assert.ok(check >= 0, `${method} ${route}: assertArabicName مفقود`);
    const w = body.search(write);
    assert.ok(w > check, `${method} ${route}: الفحص قبل الكتابة (${check} < ${w})`);
    assert.ok(body.indexOf('prisma.$transaction(') < 0 || body.indexOf('prisma.$transaction(') > check, `${method} ${route}: الفحص قبل المعاملة`);
  }
  const imp = routeBody(config, 'post', '/accounts/import');
  const check = imp.indexOf('hasArabicLetter(');
  const reject = imp.indexOf("'LEDGER_NAME_ARABIC_REQUIRED'");
  const tx = imp.indexOf('prisma.$transaction(');
  assert.ok(check >= 0 && reject > check && tx > reject, 'الاستيراد: hasArabicLetter ثم LEDGER_NAME_ARABIC_REQUIRED ثم المعاملة');
  // مصدر واحد للقاعدة
  assert.match(src(config), /from '\.\.\/\.\.\/services\/gl\/names'/);
  assert.match(src('services/gl/names.ts'), /LEDGER_NAME_ARABIC_REQUIRED/);
});
