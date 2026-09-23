// مراجعة الخبير (م‑1، م‑4، م‑5، م‑7) — بحث شجرة الحسابات في `GET /ledger/accounts`:
// التطبيع العربي (ألف/همزة/تاء مربوطة/تشكيل/تطويل/أرقام عربية/«ال» التعريف)، والمرادفات من القالب،
// والبحث في الوصف، والترتيب بالصلة (الرمز ← بداية الاسم ← الاسم ← المرادف ← الوصف)، والترقيم بعد الترتيب.
// دوال صرفة بلا قاعدة، وحراس ثابتة على المسار: الصلاحية VIEW، والأرشفة في `where` فلا يتسرّب مؤرشف،
// و`description` في الردّ، و`pagination.total` = كل المطابقين، وأسماء عقد الشجرة في كل المستويات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACCOUNT_SEARCH_RANK, ACCOUNT_SYNONYMS, accountNameStrings, accountSearchScore, countByType,
  normalizeArabicSearch, pageOfRanked, rankAccounts, searchNeedles, stripDefiniteArticle, synonymCodesFor,
  type SearchableAccount, type SynonymMap,
} from '../services/gl/coa/search';
import { SA_6D_ACCOUNTS, SA_6D_ACCOUNT_GROUPS } from '../services/gl/coa/sa';

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = stripComments(fs.readFileSync(path.join(__dirname, '../routes/ledger/config.ts'), 'utf8'));

const SYNONYMS: SynonymMap = {
  '611003': ['بنزين', 'محروقات', 'سولار'],
  '621005': ['أجرة المكتب'],
};

/**
 * خريطة فارغة صراحةً: `ACCOUNT_SYNONYMS` الافتراضية صارت مرادفات القالب الحيّة (SA_6D_ACCOUNT_SYNONYMS)،
 * فالتحقّق من المطابقة بالاسم أو الوصف وحدها يمرّر هذه كي لا يخلط المرادف بما يُختبَر.
 */
const NO_SYN: SynonymMap = {};

const acc = (c: string, name: string, extra: Partial<SearchableAccount> = {}): SearchableAccount =>
  ({ code: c, name, nameEn: null, description: null, ...extra });

// ═══ التطبيع ═══

test('التطبيع: الألف بأشكالها والهمزات والتاء المربوطة والتشكيل والتطويل والمسافات والأرقام العربية', () => {
  const alef = ['أحمد', 'إحمد', 'آحمد', 'ٱحمد'].map(normalizeArabicSearch);
  assert.deepEqual(new Set(alef).size, 1, 'الألف بأشكالها واحدة');
  assert.equal(normalizeArabicSearch('الإيجار'), normalizeArabicSearch('الايجار'));
  assert.equal(normalizeArabicSearch('صيانة'), normalizeArabicSearch('صيانه'), 'التاء المربوطة = الهاء');
  assert.equal(normalizeArabicSearch('مُصْرُوفَات'), normalizeArabicSearch('مصروفات'), 'التشكيل يُحذف');
  assert.equal(normalizeArabicSearch('مصـــروفات'), 'مصروفات', 'التطويل يُحذف');
  assert.equal(normalizeArabicSearch('  وقود   السيارات  '), 'وقود السيارات', 'المسافات الزائدة');
  assert.equal(normalizeArabicSearch('٦١١٠٠٣'), '611003', 'الأرقام العربية‑الهندية لاتينية');
  assert.equal(normalizeArabicSearch('۶۱۱۰۰۳'), '611003', 'والأرقام الفارسية');
  assert.equal(normalizeArabicSearch('مصطفى'), normalizeArabicSearch('مصطفي'), 'الألف المقصورة = الياء');
  assert.equal(normalizeArabicSearch('Fuel & Oil'), 'fuel oil', 'اللاتيني صغير والرموز فراغ');
  assert.equal(normalizeArabicSearch(null), '');
  assert.equal(normalizeArabicSearch('   '), '');
});

test('«ال» التعريف اختيارية: الكلمة تُجرَّب بها وبدونها', () => {
  assert.equal(stripDefiniteArticle('الايجار'), 'ايجار');
  assert.equal(stripDefiniteArticle('الا'), 'الا', 'ما بقي بعدها حرف واحد لا يُقصّ');
  assert.deepEqual(searchNeedles('الإيجار'), [['الايجار', 'ايجار']]);
  assert.deepEqual(searchNeedles('وقود السيارات'), [['وقود'], ['السيارات', 'سيارات']]);
  assert.deepEqual(searchNeedles('   '), [], 'بحث فارغ = بلا كلمات');

  const rent = acc('621005', 'إيجارات ومرافق');
  for (const q of ['الايجار', 'إيجار', 'الإيجار', 'ايجارات']) {
    assert.ok(accountSearchScore(rent, q) > 0, `«${q}» تطابق «إيجارات ومرافق»`);
  }
});

// ═══ المرادفات والوصف ═══

test('المرادف يترجم كلمة المحاسب إلى رمز الحساب: «بنزين» ⇒ 611003', () => {
  const fuel = acc('611003', 'وقود وزيوت السيارات');
  assert.equal(accountSearchScore(fuel, 'بنزين', { synonyms: NO_SYN }), ACCOUNT_SEARCH_RANK.NONE, 'بلا خريطة مرادفات لا مطابقة');
  assert.equal(accountSearchScore(fuel, 'بنزين', { synonyms: SYNONYMS }), ACCOUNT_SEARCH_RANK.SYNONYM);
  assert.equal(accountSearchScore(fuel, 'بنزين'), ACCOUNT_SEARCH_RANK.SYNONYM, 'ومرادفات القالب الحيّة هي الافتراضية');
  assert.deepEqual([...synonymCodesFor('بنزين', SYNONYMS)], ['611003']);
  assert.deepEqual([...synonymCodesFor('محروقات', SYNONYMS)], ['611003']);
  assert.deepEqual([...synonymCodesFor('البنزين', SYNONYMS)], ['611003'], 'مع «ال» التعريف');
  assert.deepEqual([...synonymCodesFor('أجرة المكتب', SYNONYMS)], ['621005'], 'كلمتان: كلتاهما في المرادف');
  assert.deepEqual([...synonymCodesFor('كهرباء', SYNONYMS)], [], 'ما لا مرادف له');
  assert.deepEqual([...synonymCodesFor('', SYNONYMS)], []);
});

test('البحث في الوصف: الكلمة في شرح الحساب تكفي للعثور عليه', () => {
  const fuel = acc('611003', 'وقود وزيوت السيارات', { description: 'بنزين وسولار وزيوت سيارات التوزيع' });
  assert.equal(accountSearchScore(fuel, 'سولار', { synonyms: NO_SYN }), ACCOUNT_SEARCH_RANK.DESCRIPTION);
  assert.equal(accountSearchScore(fuel, 'سولار'), ACCOUNT_SEARCH_RANK.SYNONYM, 'ومرادف القالب لـ«سولار» يعلو الوصف');
  assert.equal(accountSearchScore(fuel, 'التوزيع'), ACCOUNT_SEARCH_RANK.DESCRIPTION, 'كلمة لا مرادف لها تبقى من الوصف');
  assert.equal(accountSearchScore(acc('611003', 'وقود'), 'سولار', { synonyms: NO_SYN }), ACCOUNT_SEARCH_RANK.NONE, 'بلا وصف لا مطابقة');
});

test('الاسم بكل اللغات يدخل البحث (nameEn وnameI18n)', () => {
  const a = acc('611003', 'وقود وزيوت السيارات', {
    nameEn: 'Vehicle Fuel and Oil',
    nameI18n: { ar: 'وقود وزيوت السيارات', en: 'Vehicle Fuel and Oil', fr: 'Carburant', tr: 'Araç Yakıtı', zh: '车辆燃油' },
  });
  assert.deepEqual(accountNameStrings(acc('1', 'اسم')), ['اسم']);
  assert.ok(accountSearchScore(a, 'fuel') > 0, 'الإنجليزية');
  assert.ok(accountSearchScore(a, 'Carburant') > 0, 'الفرنسية من nameI18n');
  assert.equal(accountSearchScore({ ...a, nameI18n: 'نصّ لا كائن' }, 'Carburant'), ACCOUNT_SEARCH_RANK.NONE);
});

// ═══ الترتيب بالصلة ═══

test('الترتيب بالصلة: الرمز ← بداية الاسم ← الاسم ← المرادف ← الوصف، لا بالرمز أبجدياً', () => {
  const rows = [
    acc('111001', 'الصندوق الرئيسي', { description: 'نقدية الإيجار المدفوعة سلفاً' }), // الوصف
    acc('621005', 'إيجارات ومرافق'),                                                    // بداية الاسم
    acc('621009', 'مصروف إيجار المستودع'),                                              // داخل الاسم
    acc('632001', 'إهلاك المباني', { description: null }),                              // مرادف «ايجار»
  ];
  const syn: SynonymMap = { '632001': ['ايجار منتهٍ بالتمليك'] };
  const ranked = rankAccounts(rows, 'الإيجار', { synonyms: syn });
  assert.deepEqual(ranked.map((r) => r.code), ['621005', '621009', '632001', '111001']);
  // الرمز يعلو كل ما سواه ولو كان رمزه الأكبر
  const byCode = rankAccounts([...rows, acc('999001', 'حساب وسيط')], '621005', { synonyms: syn });
  assert.equal(byCode[0].code, '621005');
  assert.equal(accountSearchScore(rows[1], '621005'), ACCOUNT_SEARCH_RANK.CODE_EXACT);
  assert.equal(accountSearchScore(rows[1], '6210'), ACCOUNT_SEARCH_RANK.CODE_PREFIX);
  assert.equal(accountSearchScore(rows[1], 'إيجارات'), ACCOUNT_SEARCH_RANK.NAME_PREFIX);
  assert.equal(accountSearchScore(rows[2], 'إيجار'), ACCOUNT_SEARCH_RANK.NAME_CONTAINS);
  // ترتيب ثابت: تساوي الدرجة ⇒ الرمز تصاعدياً
  const tie = rankAccounts([acc('621009', 'مصروف إيجار ب'), acc('621002', 'مصروف إيجار أ')], 'إيجار');
  assert.deepEqual(tie.map((r) => r.code), ['621002', '621009']);
});

/** صفوف شجرة الشركة كما يقرؤها المسار من القاعدة: الرمز والأسماء والوصف والنوع. */
const SA_ROWS: SearchableAccount[] = SA_6D_ACCOUNTS.map((a) => ({
  code: a.code, name: a.names.ar, nameEn: a.names.en, nameI18n: { ...a.names },
  description: a.description ?? null, type: a.type,
}));

test('ترتيب الصلة على قالب الشركة: الكلمات الست تُصدِّر حساب المحاسب لا أصغر رمز (م‑4)', () => {
  const head = (q: string, n: number) => rankAccounts(SA_ROWS, q).slice(0, n).map((r) => r.code);
  const all = (q: string) => rankAccounts(SA_ROWS, q).map((r) => r.code);

  // «الايجار»: مصروف الإيجار أولاً لا «115002 إيجار مدفوع مقدماً» بحكم صِغر الرمز (تطابق الاسم كاملاً)
  assert.deepEqual(head('الايجار', 4), ['621004', '115002', '215003', '221002']);
  // و«إيجار» بلا «ال» مثلها: الاسم المعرَّف «الإيجار» لا يُعاقَب في NAME_PREFIX
  assert.deepEqual(head('إيجار', 4), ['621004', '115002', '215003', '221002']);
  assert.equal(accountSearchScore(SA_ROWS.find((r) => r.code === '621004')!, 'إيجار'), ACCOUNT_SEARCH_RANK.NAME_PREFIX);
  // «مرتبات»: مرادف تام لمصروف الرواتب 621001، فالمصروفان يعلوان التزام «رواتب وأجور مستحقة»
  assert.deepEqual(all('مرتبات'), ['621001', '611001', '213001']);
  // «بنزين»: مرادف وحيد لحساب الوقود
  assert.deepEqual(all('بنزين'), ['611003']);
  // «كهربا»: «الكهرباء والمياه» تبدأ بالكلمة بعد نزع «ال»
  assert.equal(head('كهربا', 1)[0], '621006');
  assert.equal(accountSearchScore(SA_ROWS.find((r) => r.code === '621006')!, 'كهربا'), ACCOUNT_SEARCH_RANK.NAME_PREFIX);
  // «ذمم»: لا تطابق تام لأحد، فالترتيب عند التساوي يعود إلى الرمز تصاعدياً — ذمم العملاء أولاً
  assert.deepEqual(head('ذمم', 3), ['113001', '113004', '211001']);
});

test('قاعدة الترجيح عند التساوي: التطابق التام ثم قرب النوع ثم الرمز', () => {
  const syn: SynonymMap = { '621001': ['مرتبات'], '611001': ['مرتبات المناديب'], '213001': ['مرتبات مستحقة'] };
  const rows = [
    acc('115002', 'إيجار مدفوع مقدماً', { type: 'asset_prepayments' }),
    acc('621004', 'الإيجار', { type: 'expense' }),
  ];
  assert.deepEqual(rankAccounts(rows, 'إيجار', { synonyms: NO_SYN }).map((r) => r.code), ['621004', '115002'],
    'الاسم المطابق كاملاً يعلو أصغر رمز');
  // قرب النوع: نوع الحساب الذي طابقته الكلمة تماماً يرجّح أنداده عند تساوي الدرجة
  const pay = [
    acc('213001', 'رواتب وأجور مستحقة', { type: 'liability_current' }),
    acc('611001', 'رواتب وأجور المناديب', { type: 'expense' }),
    acc('621001', 'رواتب وأجور إدارية', { type: 'expense' }),
  ];
  assert.deepEqual(rankAccounts(pay, 'مرتبات', { synonyms: syn }).map((r) => r.code), ['621001', '611001', '213001']);
  // بلا تطابق تام لا ترجيح بالنوع: الرمز تصاعدياً كما كان
  assert.deepEqual(rankAccounts(pay, 'رواتب', { synonyms: NO_SYN }).map((r) => r.code), ['213001', '611001', '621001']);
});

test('كلمات البحث تجتمع بـAND، وغير المطابق يسقط، والبحث الفارغ يبقي الصفوف كما هي', () => {
  const rows = [acc('611003', 'وقود وزيوت السيارات'), acc('611004', 'صيانة سيارات التوزيع')];
  assert.deepEqual(rankAccounts(rows, 'وقود السيارات').map((r) => r.code), ['611003']);
  assert.deepEqual(rankAccounts(rows, 'سيارات').map((r) => r.code), ['611003', '611004']);
  assert.deepEqual(rankAccounts(rows, 'كهرباء'), []);
  assert.deepEqual(rankAccounts(rows, '   ').map((r) => r.code), ['611003', '611004'], 'بلا بحث = بلا ترتيب ولا تصفية');
});

// ═══ الترقيم والتجميع ═══

test('الترقيم بعد الترتيب بالصلة: total كل المطابقين والصفحة شريحة منهم', () => {
  const rows = Array.from({ length: 137 }, (_, i) => acc(String(611001 + i), `مصروف ${i}`));
  const matched = rankAccounts(rows, 'مصروف');
  assert.equal(matched.length, 137, 'total = كل المطابقين لا الصفحة');
  assert.equal(pageOfRanked(matched, 0, 50).length, 50);
  assert.equal(pageOfRanked(matched, 100, 50).length, 37, 'آخر صفحة ناقصة');
  assert.deepEqual(pageOfRanked(matched, 137, 50), [], 'ما بعد النهاية فارغ');
  assert.deepEqual(pageOfRanked(matched, -5, 2).map((r) => r.code), ['611001', '611002'], 'إزاحة سالبة = من البداية');
  assert.deepEqual(pageOfRanked(matched, 0, 0), []);
});

test('تجميع النتائج بالنوع مرتّباً بالنوع', () => {
  const rows = [{ type: 'expense' }, { type: 'asset_current' }, { type: 'expense' }, { type: 'income' }];
  assert.deepEqual(countByType(rows), [
    { type: 'asset_current', count: 1 }, { type: 'expense', count: 2 }, { type: 'income', count: 1 },
  ]);
  assert.deepEqual(countByType([]), []);
});

// ═══ مرادفات القالب (العقد مع وكيل القالب) ═══

test('مرادفات القالب: خريطة رمز ⇒ كلمات عربية، رموزها حسابات موجودة', () => {
  const codes = new Set(SA_6D_ACCOUNTS.map((a) => a.code));
  for (const [c, words] of Object.entries(ACCOUNT_SYNONYMS)) {
    assert.ok(codes.has(c), `المرادفات تشير إلى حساب غير موجود: ${c}`);
    assert.ok(Array.isArray(words) && words.length > 0, `مرادفات ${c} فارغة`);
    for (const w of words) {
      assert.equal(typeof w, 'string');
      assert.ok(normalizeArabicSearch(w).length > 1, `مرادف قصير أو فارغ في ${c}: «${w}»`);
    }
  }
  // العقد: متى وصلت مرادفات القالب، «بنزين» تعطي حساب الوقود 611003
  if (Object.keys(ACCOUNT_SYNONYMS).length) {
    assert.ok(synonymCodesFor('بنزين').has('611003'), '«بنزين» ⇒ 611003 (م‑1)');
  }
});

test('أسماء عقد الشجرة: القالب يسمّي مستويات البادئات لا الجذور وحدها (م‑7)', () => {
  const groups = new Map(SA_6D_ACCOUNT_GROUPS.map((g) => [g.code, g.names]));
  for (const c of ['1', '2', '3', '4', '5', '6', '7', '9']) assert.ok(groups.has(c), `جذر بلا اسم: ${c}`);
  // بادئات موجودة في الحسابات فعلاً (أول رقمين وثلاثة) — تُسمّى في القالب متى وسّعه وكيله
  const prefixes = new Set<string>();
  for (const a of SA_6D_ACCOUNTS) for (const len of [2, 3]) prefixes.add(a.code.slice(0, len));
  const named = [...prefixes].filter((p) => groups.has(p));
  for (const p of named) {
    const n = groups.get(p)!;
    for (const lang of ['ar', 'en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(n[lang] && n[lang].trim().length > 1, `اسم ناقص للبادئة ${p} بلغة ${lang}`);
    }
  }
  // م‑6: المستوى الرابع مسموح حيث يفيد (1110 الصناديق، 1111 البنوك) — وما فوقه لا
  assert.ok([...groups.keys()].every((c) => /^\d{1,4}$/.test(c)), 'رموز المجموعات بادئات من رقم إلى أربعة');
});

// ═══ حراس المسار الثابتة ═══

test('GET /accounts: الصلاحية VIEW، والبحث بالصلة على المرشّحين بفلاترهم، والمؤرشف لا يتسرّب', () => {
  assert.match(code, /router\.get\('\/accounts', VIEW,/);
  const i = code.indexOf("router.get('/accounts', VIEW,");
  const body = code.slice(i, code.indexOf('\n}));', i));
  // الأرشفة تُحسم في `and` قبل بناء `where`، والمسح يستعمل `where` نفسه
  const archived = body.indexOf("if (filters.has('archived'))");
  const activeOnly = body.indexOf('if (!q.includeArchived) and.push({ isActive: true })');
  const whereAnd = body.indexOf('where.AND = and');
  assert.ok(archived >= 0 && activeOnly > archived && whereAnd > activeOnly, 'حارس isActive قبل بناء where');
  assert.match(body, /const scan = await prisma\.glAccount\.findMany\(\{\s*where, select: ACCOUNT_SEARCH_SELECT/, 'المسح بنفس where');
  assert.ok(!/glAccount\.findMany\(\{ where: \{ tenantId \}/.test(body), 'لا مسح بلا فلاتر');
  assert.match(body, /rankAccounts\(scan, q\.search\)/, 'الترتيب بالصلة لا بالرمز');
  assert.match(body, /total = matched\.length/, 'pagination.total = كل المطابقين');
  assert.match(body, /pageOfRanked\(matched, q\.offset, q\.limit\)/, 'الترقيم بعد الترتيب');
  assert.match(body, /where: \{ tenantId, id: \{ in: pageIds \} \}/, 'صفحة النتائج بعزل الشركة');
  assert.match(body, /pagination: \{ total, offset: q\.offset, limit: q\.limit \}/);
  assert.match(body, /countByType\(matched\)/, 'تجميع الأنواع على المطابقين');
  // لا بحث SQL ساذج يعود ليطابق الرمز والاسم وحدهما
  assert.ok(!/code: \{ startsWith: q\.search \}/.test(body), 'البحث لم يعد شرط OR في SQL');
});

test('الردّ يحمل الوصف والرمز والنوع، وحقول البحث تشمل الوصف والأسماء', () => {
  const out = code.slice(code.indexOf('function accountOut('), code.indexOf('const TYPE_FILTERS'));
  assert.match(out, /description: a\.description/, 'م‑5: الوصف في كل صف من الردّ');
  const select = code.slice(code.indexOf('const ACCOUNT_SEARCH_SELECT'), code.indexOf('const accountListQuery'));
  for (const f of ['code', 'name', 'nameEn', 'nameI18n', 'description', 'type', 'id']) {
    assert.match(select, new RegExp(`\\b${f}: true`), `حقل البحث ${f} مفقود من select`);
  }
});

test('GET /accounts/tree: اسم لكل بادئة يسمّيها القالب، ورابعٌ حيث سمّاه (م‑7 وم‑6)', () => {
  const i = code.indexOf("router.get('/accounts/tree', VIEW,");
  assert.ok(i >= 0, 'الشجرة بصلاحية VIEW');
  const body = code.slice(i, code.indexOf('\n}));', i));
  assert.match(body, /groupNames\.has\(prefix\) \? \{ names:/, 'الاسم لكل بادئة مسمّاة');
  assert.ok(!/len === 1 && groupNames/.test(body), 'لم يعد الاسم للمستوى الأول وحده');
  // شكل الردّ كما تقرؤه الواجهة
  assert.match(body, /type Node = \{ prefix: string; count: number; names\?: Record<string, string>; children: Node\[\] \}/);
  // م‑6: ثلاثة مستويات دائماً، ورابعٌ **فقط** حيث سمّاه القالب (1110 الصناديق، 1111 البنوك)
  assert.match(body, /for \(let len = 1; len <= Math\.min\(4, code\.length\); len\+\+\)/);
  assert.match(body, /if \(len === 4 && !groupNames\.has\(prefix\)\) break;/, 'مستوى رابع بلا اسم = عقدة رقمية عارية');
});
