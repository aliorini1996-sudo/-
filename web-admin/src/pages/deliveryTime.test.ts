import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * «وقت التسليم» في قوائم الفواتير الثلاث.
 *
 * ما تحرسه: أن يظهر الموعد في **الثلاث** لا في واحدة. الفاتورة الواحدة يراها
 * المندوب في تطبيقه، والمشرف في تطبيق الإدارة، والمحاسب على الويب — وموعدٌ
 * يظهر لواحدٍ منهم فقط يجعل الثلاثة يتناقشون في شيء لا يراه بعضهم.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('الخادم يُرجع الحقل: قائمة الفواتير بـinclude لا select ضيّق', () => {
  const s = read('..', 'backend', 'src', 'routes', 'invoices.ts');
  const i = s.indexOf("router.get('/', async");
  assert.ok(i > 0, 'مسار قائمة الفواتير غير موجود');
  const j = s.indexOf("router.get('/:id'", i);
  const block = s.slice(i, j > i ? j : i + 4000);

  const fm = block.indexOf('prisma.invoice.findMany');
  assert.ok(fm > 0, 'استعلام القائمة غير موجود');
  const query = block.slice(fm);
  const inc = query.indexOf('include:');

  // include يُرجع كل أعمدة الفاتورة ومنها deliveryDate. والانتقال يوماً إلى
  // select صريح لتقليل الحمل يُسقط الحقل بصمت من القوائم الثلاث معاً — وهو
  // ما يحرسه هذا السطر: لا select قبل include على مستوى الفاتورة نفسها.
  assert.ok(inc > 0, 'قائمة الفواتير يجب أن تستعمل include');
  assert.doesNotMatch(query.slice(0, inc), /select:/, 'select على مستوى الفاتورة يُسقط الحقل');
});

test('الويب: عمودٌ للموعد وشرطةٌ حين لا يُحدَّد', () => {
  const s = read('src', 'pages', 'InvoicesPage.tsx');
  assert.ok(s.includes("{tr('وقت التسليم')}</th>"), 'العمود مفقود من الترويسة');
  // الخانة الفارغة تُقرأ «لم يُحمَّل» لا «لا موعد له»
  const i = s.indexOf('inv.deliveryDate');
  assert.ok(i > 0, 'الصفّ لا يقرأ الحقل');
  assert.ok(s.slice(i, i + 220).includes('—'), 'الشرطة مفقودة عند غياب الموعد');
});

test('الويب: colSpan يتبع عدد الأعمدة', () => {
  const s = read('src', 'pages', 'InvoicesPage.tsx');
  const heads = (s.match(/<th>/g) || []).length;
  assert.ok(heads >= 12, `عدد الأعمدة ${heads} — يجب ألّا يقلّ عن 12 بعد إضافة الموعد`);
  assert.doesNotMatch(s, /colSpan=\{11\}/, 'colSpan لم يتبع العمود الجديد فينكمش صفّ الفراغ');
});

test('تطبيق المندوب: السطر يظهر للفواتير ذات الموعد وحدها', () => {
  const s = read('src', 'rep', 'RepApp.tsx');
  assert.ok(s.includes("kind === 'invoice' && it.deliveryDate &&"), 'الشرط مفقود — سطرٌ فارغ في كل صفّ');
  assert.ok(s.includes("tr('وقت التسليم')"), 'التسمية مفقودة');
});

test('تطبيق الإدارة: سطرٌ ثالث لا إلحاقٌ بالثاني', () => {
  const s = read('src', 'm', 'MDocList.tsx');
  assert.ok(s.includes('note={d.deliveryDate ?'), 'الموعد يجب أن يمرّ عبر note');
  const ui = read('src', 'm', 'mobileUi.tsx');
  assert.ok(ui.includes('note?: ReactNode;'), 'MRow لا يقبل سطراً ثالثاً');
});

test('التسمية مترجَمة بأربع لغات', () => {
  const s = read('src', 'i18n', 'strings.ts');
  assert.match(s, /'وقت التسليم': \{ en: '[^']+', fr: '[^']+', tr: '[^']+', zh: '[^']+' \}/,
    'التسمية غير مترجَمة بالكامل');
});
