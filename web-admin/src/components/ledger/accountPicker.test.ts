import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ACCOUNT_GROUP_ORDER, ACCOUNT_GROUP_TYPES, DEFAULT_PER_GROUP, MAX_INLINE_MATCHES,
  accountGroupOf, accountGroupLabels, accountSearchText, accountTypesOfGroup, countByGroup,
  fillCount, filterAccounts, flatRows, flattenBuckets, normalizeArabic, pickerBuckets, pickerRows,
  type PickerAccount,
} from './accountPicker';
import { accountTypeLabels } from '../../lib/ledger/labels';
import type { AccountType } from '../../api/ledgerConfig';

/**
 * منتقي الحساب في سطر القيد (م‑1 وم‑4، `docs/accounting/expert-review-2026-09-18.md`).
 *
 * الحالة التي كسرت الاستعمال: القالب السعودي ١٣٧ حساباً، وأوائلها بالرمز كلها أصول،
 * فكان العرض الافتراضي (٥٠ حساباً بالرمز) أصولاً خالصة — «كل الموجود هنا أصول فقط».
 * أكثر اختبارات هذا الملف حراسةٌ على ألّا تعود تلك الحالة.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, '../..', rel), 'utf8');

const acc = (code: string, name: string, type: AccountType, extra: Partial<PickerAccount> = {}): PickerAccount =>
  ({ id: `a${code}`, code, name, type, isActive: true, ...extra });

/** قالبٌ مصغَّر على هيئة القالب الحقيقي: أصولٌ كثيرة برموز صغيرة، ومصروفات برموز 6. */
function template(): PickerAccount[] {
  const rows: PickerAccount[] = [];
  for (let i = 1; i <= 46; i++) rows.push(acc(`11${String(1000 + i)}`, `أصل رقم ${i}`, 'asset_current'));
  for (let i = 1; i <= 21; i++) rows.push(acc(`21${String(1000 + i)}`, `التزام رقم ${i}`, 'liability_current'));
  for (let i = 1; i <= 6; i++) rows.push(acc(`31${String(1000 + i)}`, `حق ملكية ${i}`, 'equity'));
  for (let i = 1; i <= 8; i++) rows.push(acc(`41${String(1000 + i)}`, `إيراد ${i}`, 'income'));
  for (let i = 1; i <= 9; i++) rows.push(acc(`51${String(1000 + i)}`, `تكلفة ${i}`, 'expense_direct_cost'));
  for (let i = 1; i <= 35; i++) rows.push(acc(`61${String(1000 + i)}`, `مصروف رقم ${i}`, 'expense'));
  for (let i = 1; i <= 4; i++) rows.push(acc(`71${String(1000 + i)}`, `مصروف آخر ${i}`, 'expense_other'));
  rows.push(acc('991001', 'التزامات محتملة', 'off_balance'));
  return rows;
}

// ═══ التطبيع ═══

test('normalizeArabic: التشكيل والألف والهمزة والتاء المربوطة و«ال» والأرقام الهندية', () => {
  assert.equal(normalizeArabic('الوَقُود'), 'وقود');
  assert.equal(normalizeArabic('وقود'), 'وقود');
  assert.equal(normalizeArabic('إيرادات'), 'ايرادات');
  assert.equal(normalizeArabic('أصول'), 'اصول');
  assert.equal(normalizeArabic('الأصول'), 'اصول');
  assert.equal(normalizeArabic('صيانة'), 'صيانه');
  assert.equal(normalizeArabic('مصطفــى'), 'مصطفي');
  assert.equal(normalizeArabic('٦١١٠٠٣'), '611003');
  assert.equal(normalizeArabic('  كهرباء   ومياه  '), 'كهربا ومياه');
  assert.equal(normalizeArabic('611003 — وقود'), '611003 وقود');
  assert.equal(normalizeArabic(null), '');
  // «ال» لا تُنزع من كلمةٍ قصيرة فيبقى لها معنى
  assert.equal(normalizeArabic('آلة'), 'اله');
});

// ═══ المجموعات ═══

test('الرؤوس الثمانية تغطّي أنواع الحسابات العشرين بلا تكرار ولا نقص', () => {
  const all = Object.keys(accountTypeLabels(s => s)) as AccountType[];
  const mapped = ACCOUNT_GROUP_ORDER.flatMap(g => ACCOUNT_GROUP_TYPES[g]);
  assert.equal(mapped.length, new Set(mapped).size, 'نوع مكرَّر في أكثر من رأس');
  assert.deepEqual([...mapped].sort(), [...all].sort(), 'نوع بلا رأس أو رأسٌ بنوع لا وجود له');
  for (const t of all) assert.ok(ACCOUNT_GROUP_TYPES[accountGroupOf(t)].includes(t), `accountGroupOf(${t}) لا يعيد رأسه`);
});

test('تسميات الرؤوس عربية كاملة، وأنواع الرأس تُرسَل نصاً بفواصل', () => {
  const labels = accountGroupLabels(s => s);
  for (const g of ACCOUNT_GROUP_ORDER) assert.match(labels[g], /[؀-ۿ]/, `الرأس ${g} بلا تسمية عربية`);
  assert.equal(labels.opex, 'المصروفات التشغيلية');
  assert.equal(accountTypesOfGroup('opex'), 'expense,expense_depreciation');
  assert.equal(accountTypesOfGroup('cost'), 'expense_direct_cost');
});

// ═══ العرض بلا بحث: الملاحظة المانعة نفسها ═══

test('بلا كتابة: كل رأسٍ حاضر بأوائله — لا أصولٌ خالصة (م‑1)', () => {
  const rows = template();
  const buckets = pickerBuckets(rows);
  assert.deepEqual(buckets.map(b => b.key), ['asset', 'liability', 'equity', 'income', 'cost', 'opex', 'other', 'system']);
  // العدّ الكلّي لكل رأس لا عدد المعروض منه
  assert.equal(buckets[0].total, 46);
  assert.equal(buckets[0].items.length, DEFAULT_PER_GROUP);
  assert.equal(buckets.find(b => b.key === 'opex')!.total, 35);
  const shown = flattenBuckets(buckets);
  assert.ok(shown.some(a => a.type === 'expense'), 'المصروفات التشغيلية غائبة عن العرض الأول — هذه هي علّة الخبير');
  assert.ok(shown.some(a => a.type === 'income'), 'الإيرادات غائبة عن العرض الأول');
  // الشاهد على العلّة القديمة: أوائل الخمسين بالرمز بلا مصروفٍ ولا إيراد البتّة
  const legacy = [...rows].sort((a, b) => a.code.localeCompare(b.code, 'en')).slice(0, 50);
  assert.ok(legacy.every(a => ['asset', 'liability'].includes(accountGroupOf(a.type))), 'تهيئة الاختبار لا تحاكي القالب');
  assert.equal(legacy.filter(a => accountGroupOf(a.type) === 'asset').length, 46);
});

test('اختيار رأسٍ من الشريط: سلّة واحدة موسَّعة، والرؤوس الفارغة تختفي', () => {
  const rows = template();
  const only = pickerBuckets(rows, { group: 'opex' });
  assert.equal(only.length, 1);
  assert.equal(only[0].key, 'opex');
  assert.equal(only[0].items.length, 35);
  assert.ok(only[0].items.every(a => a.type === 'expense'));
  assert.deepEqual(pickerBuckets(rows.filter(a => a.type === 'expense'), {}).map(b => b.key), ['opex']);
  assert.deepEqual(pickerBuckets(rows, { group: 'equity', groupLimit: 2 })[0].items.length, 2);
  const counts = countByGroup(rows);
  assert.equal(counts.opex, 35);
  assert.equal(counts.system, 1);
  assert.equal(ACCOUNT_GROUP_ORDER.reduce((s, g) => s + counts[g], 0), rows.length);
});

test('صفوف العرض: رأسٌ ثم حساباته، والفهرس يعدّ الحسابات وحدها', () => {
  const buckets = pickerBuckets(template(), { perGroup: 2 });
  const rows = pickerRows(buckets);
  assert.equal(rows[0].kind, 'head');
  const idx = rows.flatMap(r => (r.kind === 'item' ? [r.index] : []));
  assert.deepEqual(idx, idx.map((_, i) => i), 'فهرس التنقّل ليس متتابعاً — السهام ستقفز خطأ');
  assert.equal(idx.length, buckets.reduce((n, b) => n + Math.min(2, b.total), 0));
  // نتائج البحث بلا رؤوس
  const flat = flatRows(template().slice(0, 3));
  assert.ok(flat.every(r => r.kind === 'item'));
  assert.deepEqual(flat.map(r => (r.kind === 'item' ? r.index : -1)), [0, 1, 2]);
});

// ═══ البحث المتساهل ═══

const fuel = acc('611003', 'وقود وزيوت السيارات', 'expense', {
  nameEn: 'Vehicle fuel and oils',
  description: 'بنزين وسولار وزيوت سيارات التوزيع',
});
const rent = acc('621001', 'إيجارات المكاتب والمستودعات', 'expense', { nameEn: 'Rent' });
const sales = acc('411001', 'إيرادات المبيعات', 'income', { nameEn: 'Sales revenue' });

test('البحث يشمل الوصف والاسم الإنجليزي والرمز مع التطبيع', () => {
  const rows = [fuel, rent, sales];
  assert.deepEqual(filterAccounts(rows, 'بنزين').map(a => a.code), ['611003'], 'الوصف لا يدخل البحث');
  assert.deepEqual(filterAccounts(rows, 'الوقود').map(a => a.code), ['611003']);
  assert.deepEqual(filterAccounts(rows, 'وقود سيارات').map(a => a.code), ['611003'], 'كلمتان متباعدتان لا تتطابقان');
  assert.deepEqual(filterAccounts(rows, 'fuel').map(a => a.code), ['611003']);
  assert.deepEqual(filterAccounts(rows, '6110').map(a => a.code), ['611003']);
  assert.deepEqual(filterAccounts(rows, 'ايجارات').map(a => a.code), ['621001']);
  assert.deepEqual(filterAccounts(rows, 'إيرادات').map(a => a.code), ['411001']);
  assert.deepEqual(filterAccounts(rows, 'لا شيء يطابق').map(a => a.code), []);
});

test('المرادفات من القالب تُقبل وسيطاً، والنصّ المبحوث فيه يضمّها', () => {
  const synonyms = { '611003': ['بنزين', 'محروقات', 'سولار'] as const };
  const bare = acc('611003', 'وقود وزيوت السيارات', 'expense');
  assert.deepEqual(filterAccounts([bare, rent], 'محروقات', { synonyms }).map(a => a.code), ['611003']);
  assert.deepEqual(filterAccounts([bare, rent], 'محروقات').map(a => a.code), [], 'بلا تمرير المرادفات لا مطابقة — الوسيط مصدرها الوحيد');
  assert.ok(accountSearchText(bare, synonyms).includes('محروقات'));
  assert.ok(accountSearchText(fuel).includes('بنزين'), 'الوصف غائب عن نصّ البحث');
});

test('الترتيب: الرمز التام ثم بادئته ثم بداية الاسم ثم داخله ثم الوصف وحده', () => {
  const rows = [
    acc('611003', 'وقود وزيوت السيارات', 'expense', { description: 'بنزين وسولار' }),
    acc('611009', 'صيانة المركبات', 'expense', { description: 'قطع غيار ووقود الطوارئ' }),
    acc('621004', 'وقود المولّدات', 'expense'),
    acc('631002', 'إهلاك سيارات الوقود', 'expense_depreciation'),
  ];
  // 611003 و621004 يبدأ اسماهما بـ«وقود» (رتبة واحدة، يفصلها الرمز)، ثم اسمٌ يحويها، ثم وصفٌ وحده
  assert.deepEqual(filterAccounts(rows, 'وقود').map(a => a.code), ['611003', '621004', '631002', '611009']);
  assert.deepEqual(filterAccounts(rows, '611003').map(a => a.code), ['611003']);
  // الاسم بلغة العرض هو المعتبَر في الرتبة، والتصفية تبقى بكل اللغات
  const en = [acc('1', 'مصروف', 'expense', { nameEn: 'Fuel expense' }), acc('2', 'وقود', 'expense', { nameEn: 'Diesel' })];
  assert.deepEqual(filterAccounts(en, 'fuel', { lang: 'en' }).map(a => a.code), ['1']);
});

test('حصر الرأس وسقف النتائج يسريان على البحث', () => {
  const rows = template();
  const inOpex = filterAccounts(rows, 'مصروف', { group: 'opex', limit: Number.MAX_SAFE_INTEGER });
  assert.equal(inOpex.length, 35, 'حصر الرأس يشمل مصروفات أخرى خطأً');
  assert.ok(inOpex.every(a => a.type === 'expense'));
  assert.equal(filterAccounts(rows, '', { limit: MAX_INLINE_MATCHES }).length, MAX_INLINE_MATCHES);
  assert.equal(MAX_INLINE_MATCHES, 50);
  // الاستعلام الفارغ مرتَّب بالرمز
  const empty = filterAccounts(rows, '   ', { limit: 5 }).map(a => a.code);
  assert.deepEqual(empty, [...empty].sort((a, b) => a.localeCompare(b, 'en')));
});

test('fillCount يعوّض كل العناصر ولا يلمس ما سواها', () => {
  assert.equal(fillCount('يُعرض {shown} من {total} حساباً', { shown: 50, total: 137 }), 'يُعرض 50 من 137 حساباً');
  assert.equal(fillCount('{from}–{to} من {total} حساباً', { from: 1, to: 20, total: 137 }), '1–20 من 137 حساباً');
  assert.equal(fillCount('بلا عناصر', { shown: 1 }), 'بلا عناصر');
});

// ═══ حرّاس على الواجهة نفسها ═══

test('منتقي سطر القيد لا يعود إلى «أول ٥٠ بالرمز» ويعرض الوصف والعدّاد', () => {
  const s = src('components/ledger/MoveLinesGrid.tsx');
  // التعليق يذكر النمط القديم شرحاً للعلّة، فيُستثنى من الحارس
  const code = s.split(/\r?\n/).filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.ok(!code.includes('accounts.slice(0, 50)'), 'عاد العرض الافتراضي إلى أوائل الشجرة — علّة م‑1 نفسها');
  assert.ok(s.includes('pickerBuckets('), 'التجميع بالنوع غير مستعمَل');
  assert.ok(s.includes('countByGroup('), 'شريط فلاتر النوع غير مبني على عدّاد الرؤوس');
  assert.ok(s.includes('account.description'), 'وصف الحساب لا يُعرض سطراً ثانياً');
  assert.match(s, /tr\('يُعرض \{shown\} من \{total\} حساباً'\)/, 'عدّاد «يُعرض ن من م» غائب');
  assert.match(s, /tr\('عرض المزيد'\)/, 'زرّ «عرض المزيد» غائب');
  assert.ok(s.includes('AccountPickerDialog'), 'نافذة البحث بالخادم غير موصولة بالمنتقي');
  // المرادفات تصل التصفية المحلية نفسها لا نافذة «عرض المزيد» وحدها (م‑1)
  assert.ok(s.includes("from './accountSynonyms'"), 'مرادفات القالب غير مستورَدة في المنتقي');
  assert.match(s, /filterAccounts\([^)]*synonyms: ACCOUNT_SYNONYMS/, 'filterAccounts تُنادى بلا مرادفات — «بنزين» لن تطابق شيئاً في المنسدلة');
  // التنقّل بالسهام وEsc والمؤرشف المشطوب — ما كان يعمل قبل التغيير
  for (const k of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'line-through']) {
    assert.ok(s.includes(k), `فُقد سلوك ${k} من المنتقي`);
  }
});

test('نافذة اختيار الحساب تبحث بالخادم بفلتر نوع وترقيم صفحات', () => {
  const s = src('components/ledger/AccountPickerDialog.tsx');
  assert.ok(s.includes('ledgerConfigApi.accounts.list'), 'النافذة لا تسأل الخادم');
  assert.ok(s.includes('accountTypesOfGroup('), 'فلتر النوع لا يُرسَل إلى الخادم');
  for (const f of ['search:', 'offset,', 'limit: PAGE']) assert.ok(s.includes(f), `وسيط ${f} غائب عن طلب النافذة`);
  assert.match(s, /tr\('الوصف'\)/, 'عمود الوصف غائب');
  assert.match(s, /tr\('\{from\}–\{to\} من \{total\} حساباً'\)/, 'عدّاد الصفحات غائب');
  // نافذة قراءة لا تحرير: لا كتابة ولا أرشفة من هنا
  for (const w of ['accounts.create', 'accounts.update', 'accounts.archive']) {
    assert.ok(!s.includes(w), `النافذة تكتب (${w}) وهي للاختيار وحده`);
  }
});
