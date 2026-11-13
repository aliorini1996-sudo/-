// كشف حساب مشرف الفرق معنونٌ «لفريقك» في مواضعه الثلاثة (تدقيق دقّة التقارير، طلب المالك ١٣ نوفمبر ٢٠٢٦ — البند ١٢).
//
// المشرف يرى للعميل نفسه رصيدين: رصيد فريقه في الكشف والرصيد الكامل في قائمة العملاء. القرار: لا يتغيّر ما يراه، ويُعنوَن
// الكشف بأنه لفريقه مع تنبيهٍ صريح بأن الرقمين قد يختلفان. والمواضع: نافذة اللوحة (ومعها ملف Excel)، وشاشة الجوال،
// والمستند المطبوع. الصفحات تعتمد على المتصفّح فلا تُرسَم هنا؛ الحارس يثبت أن العنوان والتنبيه خلف teamScoped وحده،
// وأن عناوين غير المشرف كما كانت حرفاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const NOTE = 'هذا الكشف يشمل مستندات فريقك وحده — قد يختلف عن رصيد العميل الكامل في قائمة العملاء';
const OLD_NOTE = 'كشف فريقك فقط لا يشمل فواتير الفرق الأخرى وسنداتها ولا التسويات اليدوية';

test('نافذة اللوحة: التنبيه وأسماء الفرق خلف teamScoped، والعناوين الثلاثة لفريقك، وملف Excel يحمل التنبيه', () => {
  const s = read('components/forms/CustomerStatementModal.tsx');
  assert.ok(s.includes(`const teamNote = tr('${NOTE}');`));
  assert.ok(!s.includes(OLD_NOTE));
  assert.match(s, /\{teamScoped && \(\n\s*<p [^>]*>\n\s*\{teamNote\}\n\s*\{teamNames && <span[^>]*> \(\{tr\('الفريق'\)\}: \{teamNames\}\)<\/span>\}/);
  for (const [team, plain] of [['مبيعات فريقك', 'إجمالي المبيعات'], ['تحصيل فريقك', 'إجمالي التحصيل'], ['رصيد فريقك', 'الرصيد الحالي']]) {
    // مرّتان: الملخّص على الشاشة وورقة Excel — وغير المشرف بعنوانه القديم
    assert.equal(s.split(`teamScoped ? tr('${team}') : tr('${plain}')`).length - 1, 2, team);
  }
  assert.ok(s.includes("...(teamScoped ? [{ [tr('البند')]: tr('ملاحظة'), [tr('القيمة')]: teamNames ? `${teamNote} (${tr('الفريق')}: ${teamNames})` : teamNote }] : []),"),
    'الملف يُتداول بعيداً عن الشاشة: التنبيه سطرٌ في ورقة الملخّص للمشرف وحده');
  assert.ok(s.includes('teamScoped?: boolean; teamNames?: string[] }'));
});

test('شاشة الجوال: التنبيه وأسماء الفرق خلف teamScoped، والرصيد الختامي «رصيد فريقك» للمشرف وحده', () => {
  const s = read('m/MCustomerStatement.tsx');
  assert.ok(s.includes(`{tr('${NOTE}')}`));
  assert.ok(!s.includes(OLD_NOTE));
  assert.ok(s.includes('const teamScoped = q.data?.teamScoped === true;'));
  assert.match(s, /\{teamScoped && \(\n\s*<p [^>]*>\n\s*\{tr\('هذا الكشف/);
  assert.ok(s.includes("? (rangeOn ? tr('رصيد فريقك نهاية الفترة') : tr('رصيد فريقك'))"));
  assert.ok(s.includes(": (rangeOn ? tr('رصيد نهاية الفترة') : tr('الرصيد الحالي'))}"), 'غير المشرف كما كان حرفاً');
  // المستند المطبوع من الجوال يأخذ العَلَم نفسه وأسماء الفرق
  assert.ok(s.includes('teamScoped: q.data.teamScoped === true,'));
  assert.ok(s.includes('teamNames: q.data.teamNames,'));
  assert.ok(read('m/MStatementDoc.tsx').includes('teamScoped?: boolean; teamNames?: string[] };'));
});

test('المستند المطبوع: التنبيه الجديد تحت الرصيد، وعناوين المبيعات والتحصيل والرصيد لفريقك', () => {
  const s = read('rep/RepDocuments.tsx');
  assert.ok(s.includes(`{tr('${NOTE}')}`));
  assert.ok(!s.includes(OLD_NOTE));
  assert.match(s, /\{doc\.teamScoped && \(\n\s*<div [^>]*>\n\s*\{tr\('هذا الكشف/);
  assert.ok(s.includes("doc.teamScoped ? tr('مبيعات فريقك') : tr('إجمالي المبيعات')"));
  assert.ok(s.includes("doc.teamScoped ? tr('تحصيل فريقك') : tr('إجمالي التحصيل')"));
  assert.ok(s.includes("doc.teamScoped ? tr('رصيد فريقك') : tr('الرصيد المستحق على العميل')"));
  // والورقة تسمّي الفرق كالشاشات — والكشف المطبوع من اللوحة (صفحة العملاء) يمرّرها
  assert.ok(s.includes("{doc.teamNames?.length ? <span style={{ color: '#6E6557' }}> ({tr('الفريق')}: {doc.teamNames.join('، ')})</span> : null}"));
  assert.ok(read('pages/CustomersPage.tsx').includes('{ teamScoped: teamScoped === true, teamNames }'));
});

test('statementDocFromData: أسماء الفرق مع كشف المشرف وحده، والمفتاح غائبٌ بلا أسماء أو بلا teamScoped', async () => {
  const { statementDocFromData } = await import('../rep/RepDocuments');
  const c = { name: 'بقالة' } as never;
  assert.deepEqual(statementDocFromData(c, [], 'أحمد', null, { teamScoped: true, teamNames: ['الشمال', ''] }).teamNames, ['الشمال']);
  for (const range of [{ teamScoped: true, teamNames: [] }, { teamScoped: true }, { teamScoped: false, teamNames: ['الشمال'] }, undefined]) {
    assert.equal('teamNames' in statementDocFromData(c, [], 'أحمد', null, range), false, JSON.stringify(range));
  }
});
