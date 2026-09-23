import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCOUNT_SYNONYMS } from './accountSynonyms';
import { accountSearchText, filterAccounts, type PickerAccount } from './accountPicker';
import type { AccountType } from '../../api/ledgerConfig';

/**
 * مرادفات الحسابات في الواجهة (م‑1، `docs/accounting/expert-review-2026-09-18.md`).
 *
 * الحالة التي كسرت الاستعمال: كلمات المحاسب اليومية («بنزين»، «سولار»، «مرتبات»، «كهربا»)
 * لا تطابق أسماء القالب، وكانت المرادفات في الخادم وحده، فلا تعمل إلا في نافذة «عرض المزيد»
 * بينما تعود القائمة المنسدلة في سطر القيد بـ«لا نتائج». ملف `accountSynonyms.ts` نسخة مرآة،
 * وهذا الملف حارسها: تطابقٌ حرفيّ مع القالب، ثم سلوكٌ حقيقيّ على شجرة الحسابات كاملةً.
 */

const SA_URL = new URL('../../../../backend/src/services/gl/coa/sa.ts', import.meta.url);

/** نصّ قالب الخلفية، أو null إن لم يكن متاحاً في هذا الفحص (بناء الواجهة وحدها). */
function backendSource(): string | null {
  try { return readFileSync(SA_URL, 'utf8'); } catch { return null; }
}

/** يستخرج `SA_6D_ACCOUNT_SYNONYMS` من نصّ القالب بلا استيراده (الخلفية لا تُبنى هنا). */
function parseSynonyms(src: string): Record<string, string[]> {
  const block = src.match(/export const SA_6D_ACCOUNT_SYNONYMS[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, 'SA_6D_ACCOUNT_SYNONYMS غير موجودة في قالب الخلفية');
  const out: Record<string, string[]> = {};
  for (const e of block![1].matchAll(/'([^']+)'\s*:\s*\[([^\]]*)\]/g)) {
    out[e[1]] = [...e[2].matchAll(/'([^']*)'/g)].map(x => x[1]);
  }
  return out;
}

/** أوصاف القالب (م‑5) — جزءٌ من نصّ البحث في الشاشة الحيّة، فتدخل تهيئة الاختبار. */
function parseDescriptions(src: string): Record<string, string> {
  const block = src.match(/export const SA_6D_ACCOUNT_DESCRIPTIONS[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, 'SA_6D_ACCOUNT_DESCRIPTIONS غير موجودة في قالب الخلفية');
  return Object.fromEntries([...block![1].matchAll(/'([^']+)'\s*:\s*'([^']*)'/g)].map(m => [m[1], m[2]]));
}

/** شجرة الحسابات كما تصل الواجهة: رمز واسمان ووصف ونوع. */
function parseAccounts(src: string): PickerAccount[] {
  const block = src.match(/export const SA_6D_ACCOUNTS[^=]*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(block, 'SA_6D_ACCOUNTS غير موجودة في قالب الخلفية');
  const descriptions = parseDescriptions(src);
  return [...block![1].matchAll(/acc\('(\d+)',\s*'([a-z_]+)',\s*n\('([^']*)',\s*'([^']*)'/g)].map(m => ({
    id: m[1], code: m[1], name: m[3], nameEn: m[4],
    description: descriptions[m[1]] ?? '', type: m[2] as AccountType, isActive: true,
  }));
}

// ═══ التطابق مع القالب ═══

test('نسخة الواجهة مطابقة لمرادفات القالب حرفاً بحرف', (t) => {
  const src = backendSource();
  if (!src) { t.skip('مصدر الخلفية غير متاح في هذا الفحص'); return; }
  const server = parseSynonyms(src);
  assert.ok(Object.keys(server).length >= 100, 'تحليل القالب ناقص — الحارس لا يقارن شيئاً');
  assert.ok(Object.values(server).flat().length >= 300, 'تحليل كلمات القالب ناقص');
  // ترتيب المفاتيح غير مهم (deepEqual لا يعبأ به)، وترتيب الكلمات داخل الحساب مهمّ
  assert.deepEqual(ACCOUNT_SYNONYMS, server, 'نسخة الواجهة تخالف القالب — أعِد نسخ SA_6D_ACCOUNT_SYNONYMS من backend/src/services/gl/coa/sa.ts');
});

test('كل مرادف نصّ عربي غير فارغ، ولا يتكرّر على حسابين', () => {
  const owner = new Map<string, string>();
  for (const [code, words] of Object.entries(ACCOUNT_SYNONYMS)) {
    assert.match(code, /^\d{6}$/, `رمز حساب غير سداسي: ${code}`);
    assert.ok(words.length > 0, `الحساب ${code} بلا مرادفات`);
    for (const w of words) {
      assert.ok(w.trim().length > 0, `مرادف فارغ في ${code}`);
      assert.match(w, /[؀-ۿ]/, `مرادف غير عربي في ${code}: ${w}`);
      assert.equal(owner.get(w), undefined, `المرادف «${w}» على حسابين: ${owner.get(w)} و${code}`);
      owner.set(w, code);
    }
  }
});

// ═══ السلوك على الشجرة الحقيقية ═══

test('كلمات المحاسب تطابق حسابها وحده في القائمة المنسدلة', (t) => {
  const src = backendSource();
  if (!src) { t.skip('مصدر الخلفية غير متاح في هذا الفحص'); return; }
  const accounts = parseAccounts(src);
  assert.ok(accounts.length >= 130, `تحليل الشجرة ناقص (${accounts.length} حساباً)`);
  const codes = (q: string, synonyms?: typeof ACCOUNT_SYNONYMS) =>
    filterAccounts(accounts, q, { synonyms, limit: Number.MAX_SAFE_INTEGER }).map(a => a.code);

  // شكوى الخبير نفسها: «بنزين» ⇐ وقود وزيوت السيارات، ولا حساب سواه من ١٣٧
  const fuel = accounts.find(a => a.code === '611003');
  assert.equal(fuel?.name, 'وقود وزيوت السيارات', 'اسم حساب الوقود تغيّر في القالب');
  assert.deepEqual(codes('بنزين', ACCOUNT_SYNONYMS), ['611003']);
  assert.deepEqual(codes('ديزل', ACCOUNT_SYNONYMS), ['611003']);
  assert.deepEqual(codes('ديزل'), [], 'بلا تمرير المرادفات لا مطابقة — هذا ما كانت عليه المنسدلة');

  // «مرتبات» ⇐ حسابات الرواتب الثلاثة وحدها (الموظفين · المناديب · المستحقة)، لا حساب غريب.
  // والترتيب يطابق ترجيح الخادم (backend/src/services/gl/coa/search.ts): نوع أفضل تطابق تامّ يرجّح أنداده،
  // فيتقدّم حسابا المصروف على التزام «رواتب مستحقة» — وإلا اختلفت الشاشتان على الكلمة نفسها.
  const salaries = codes('مرتبات', ACCOUNT_SYNONYMS);
  assert.deepEqual(salaries, ['621001', '611001', '213001']);
  assert.ok(salaries.every(c => accounts.find(a => a.code === c)!.name.includes('رواتب')), 'حسابٌ لا علاقة له بالرواتب');
  assert.deepEqual(codes('مرتبات'), [], 'بلا مرادفات «مرتبات» بلا نتائج — علّة م‑1');

  // التطبيع العربي يسري على المرادف كما على الاسم: «كهربا» و«الكهرباء» و«كَهْرَبَاء» سواء
  for (const q of ['كهربا', 'الكهرباء', 'كَهْرَبَاء']) {
    assert.ok(codes(q, ACCOUNT_SYNONYMS).includes('621006'), `«${q}» لا تصل حساب الكهرباء والمياه`);
  }
  // «كفرات» مرادفٌ لصيانة السيارات وحدها، و«جوسي» للتأمينات — كلماتٌ لا وجود لها في الأسماء
  assert.deepEqual(codes('كفرات', ACCOUNT_SYNONYMS), ['611004']);
  assert.deepEqual(codes('جوسي', ACCOUNT_SYNONYMS), ['621002']);

  // المرادفات تدخل نصّ البحث فعلاً لا الترتيب وحده
  assert.ok(accountSearchText(fuel!, ACCOUNT_SYNONYMS).includes('بنزين'));
  // كل رمز في الخريطة له حسابٌ في الشجرة (مرادفٌ ليتيم لا يظهر أبداً)
  const tree = new Set(accounts.map(a => a.code));
  for (const code of Object.keys(ACCOUNT_SYNONYMS)) assert.ok(tree.has(code), `مرادفات لرمز لا وجود له: ${code}`);
});
