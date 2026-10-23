import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * «موظفو المنصة» (طلب المالك، ٢٣ أكتوبر ٢٠٢٦): لوحة المالك نفسها على /staff بما منحه المالك وحده.
 * الحماية في الخادم (backend/src/services/platformAccess.ts)؛ وهذه حرّاس الواجهة: القرار الصرف، وتطابق المفاتيح مع
 * الخادم، ومساحة الجلسة، وما لا يُمنح أبداً (الإدارة المالية وإدارة الموظفين).
 */

// ── بيئة متصفّحٍ دنيا قبل التحميل: المخزن يقرأ window.location وlocalStorage لحظة استيراده ──
const store = new Map<string, string>();
const loc = { pathname: '/staff/login' };
const g = globalThis as unknown as Record<string, unknown>;
for (const [k, v] of Object.entries({
  window: { location: loc },
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => { store.set(key, String(val)); },
    removeItem: (key: string) => { store.delete(key); },
  },
})) Object.defineProperty(g, k, { value: v, configurable: true, writable: true });

const { accessFor, platformHome } = await import('./platformAccess');
const { sessionSpace, useAuthStore } = await import('../store/authStore');
type U = Parameters<typeof accessFor>[0];

const SRC = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const backendAccess = fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', 'services', 'platformAccess.ts'), 'utf8');

/** كتالوج الخادم من نصّه: {key, group, label} لكل سطر — والعدّ يمنع تخطّي سطرٍ بصيغة أخرى */
const catalogBlock = backendAccess.match(/export const STAFF_PERMISSIONS = \[([\s\S]*?)\] as const;/);
assert.ok(catalogBlock, 'تعذّر العثور على STAFF_PERMISSIONS في الخادم');
const CATALOG = [...catalogBlock[1].matchAll(/\{\s*key:\s*'([^']+)',\s*group:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
  .map(([, key, group, label]) => ({ key, group, label }));
const SERVER_KEYS = CATALOG.map((c) => c.key);

/** كل ملفات الكود في src (لا الاختبارات) */
function sourceFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') ? [full] : [];
  });
}
const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/');

// ───────────────────────────── القرار الصرف ─────────────────────────────

test('accessFor: المالك كل شيء، والموظف ما منحه المالك وحده، وغيرهما لا شيء', () => {
  const owner = accessFor({ role: 'SUPER_ADMIN' });
  assert.deepEqual([owner.isOwner, owner.isStaff], [true, false]);
  for (const k of SERVER_KEYS) assert.equal(owner.can(k as never), true, `المالك بلا ${k}`);

  const staff = accessFor({ role: 'PLATFORM_STAFF', permissions: ['leads.view', 'quotes.view'] });
  assert.deepEqual([staff.isOwner, staff.isStaff], [false, true]);
  assert.equal(staff.can('leads.view'), true);
  assert.equal(staff.can('quotes.view'), true);
  for (const k of SERVER_KEYS.filter((k) => k !== 'leads.view' && k !== 'quotes.view')) {
    assert.equal(staff.can(k as never), false, `الموظف يملك ${k} بلا منح`);
  }

  // أدوار الشركة والمندوب وغياب الجلسة: لا مالك ولا موظف ولا مفتاح
  for (const u of [{ role: 'ADMIN' }, { role: 'MANAGER' }, { role: 'SALES_REP' }, null, undefined] as U[]) {
    const a = accessFor(u);
    assert.deepEqual([a.isOwner, a.isStaff], [false, false], JSON.stringify(u));
    assert.equal(SERVER_KEYS.some((k) => a.can(k as never)), false, `مفتاحٌ لغير المالك والموظف: ${JSON.stringify(u)}`);
  }
  // أدمن شركةٍ يحمل permissions لا يصير موظف منصة بها
  assert.equal(accessFor({ role: 'ADMIN', permissions: ['tenants.view'] } as U).can('tenants.view'), false);
});

test('accessFor: صلاحيات غائبة أو ليست مصفوفة ⇒ لا شيء (لا انهيار ولا منح)', () => {
  for (const permissions of [undefined, null, 'tenants.view', { 'tenants.view': true }, 7]) {
    const a = accessFor({ role: 'PLATFORM_STAFF', permissions } as unknown as U);
    assert.equal(a.isStaff, true);
    assert.equal(SERVER_KEYS.some((k) => a.can(k as never)), false, `منحٌ من ${JSON.stringify(permissions)}`);
  }
});

test('platformHome: الموظف يعود إلى /staff والمالك إلى /platform', () => {
  assert.equal(platformHome({ role: 'PLATFORM_STAFF' }), '/staff');
  assert.equal(platformHome({ role: 'SUPER_ADMIN' }), '/platform');
  assert.equal(platformHome(null), '/platform');
});

// ───────────────────────────── تطابق المفاتيح مع الخادم ─────────────────────────────

test('مفاتيح StaffKey في الواجهة هي مفاتيح كتالوج الخادم نفسها', () => {
  assert.equal(CATALOG.length, (catalogBlock[1].match(/\bkey:/g) || []).length, 'سطرٌ في الكتالوج بصيغة لم تُقرأ');
  assert.ok(CATALOG.length >= 20, `الكتالوج أقصر من المتوقّع (${CATALOG.length})`);
  assert.equal(new Set(SERVER_KEYS).size, SERVER_KEYS.length, 'مفتاحٌ مكرّر في الخادم');

  const typeBlock = read('lib', 'platformAccess.ts').match(/export type StaffKey =([\s\S]*?);/);
  assert.ok(typeBlock, 'تعذّر العثور على StaffKey');
  const uiKeys = [...typeBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(new Set(uiKeys).size, uiKeys.length, 'مفتاحٌ مكرّر في StaffKey');
  assert.deepEqual([...uiKeys].sort(), [...SERVER_KEYS].sort(), 'StaffKey انحرف عن STAFF_PERMISSIONS — حدّثه');
});

test('ما لا يُمنح أبداً: لا مفتاح للإدارة المالية ولا لإدارة الموظفين، ولا قاعدة مسارٍ لهما', () => {
  for (const k of SERVER_KEYS) assert.doesNotMatch(k, /^(finance|staff|platformStaff|paylink)\b/i, `مفتاحٌ يمنح ما للمالك وحده: ${k}`);
  const rules = backendAccess.match(/export const ROUTE_RULES[\s\S]*?\n\];/);
  assert.ok(rules, 'تعذّر العثور على ROUTE_RULES');
  assert.doesNotMatch(rules[0], /\/api\/(finance|platform-staff|paylink\/owner)/, 'قاعدة مسارٍ تفتح للموظف ما للمالك وحده');
});

test('كل can(\'…\') حرفيّ في الواجهة مفتاحٌ في الكتالوج — وكل مفتاحٍ في الكتالوج يُسأل عنه في الواجهة', () => {
  const known = new Set(SERVER_KEYS);
  const used = new Set<string>();
  const unknown: string[] = [];
  for (const f of sourceFiles()) {
    for (const [, , key] of fs.readFileSync(f, 'utf8').matchAll(/\bcan\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
      used.add(key);
      if (!known.has(key)) unknown.push(`${rel(f)}: ${key}`);
    }
  }
  assert.ok(used.size >= 20, `تعذّر العثور على استدعاءات can() (${used.size})`);
  assert.deepEqual(unknown, [], `مفاتيح غير موجودة في كتالوج الخادم (الموظف لا يراها أبداً): ${unknown.join(' | ')}`);
  // مفتاحٌ يمنحه المالك ولا يغيّر شيئاً في اللوحة يوهمه بمنحٍ لا أثر له
  const idle = SERVER_KEYS.filter((k) => !used.has(k));
  assert.deepEqual(idle, [], `مفاتيح لا يسأل عنها أي زرٍّ أو قسم: ${idle.join(', ')}`);
});

test('نصوص كتالوج الخادم مترجمة: نافذة الموظفين تعرضها بـtr(group) وtr(label)', () => {
  const strings = read('i18n', 'strings.ts');
  const missing = [...new Set(CATALOG.flatMap((c) => [c.group, c.label]))].filter((s) => !strings.includes(`'${s}': {`));
  assert.deepEqual(missing, [], `بلا ترجمة في PHRASES: ${missing.join(' | ')}`);
});

// ───────────────────────────── مساحة الجلسة ─────────────────────────────

test('sessionSpace: /staff ودخولها في st_token، ولا تبتلع /staffing، و/platform ما زالت للمالك', () => {
  const staff = { tokenKey: 'st_token', userKey: 'st_user', loginPath: '/staff/login' };
  assert.deepEqual(sessionSpace('/staff'), staff);
  assert.deepEqual(sessionSpace('/staff/'), staff);
  assert.deepEqual(sessionSpace('/staff/login'), staff);
  assert.equal(sessionSpace('/staffing').tokenKey, 'token');
  assert.equal(sessionSpace('/staff-x').tokenKey, 'token');
  assert.deepEqual(sessionSpace('/platform'), { tokenKey: 'sa_token', userKey: 'sa_user', loginPath: '/owner' });
  assert.equal(sessionSpace('/owner').tokenKey, 'sa_token');
  assert.equal(sessionSpace('/app').tokenKey, 'token');
  assert.equal(sessionSpace('/m').tokenKey, 'm_token');
});

test('المخزن: دخول الموظف وخروجه في مساحته وحدها — جلسة المالك في المتصفح نفسه لا تُمسّ', () => {
  store.clear();
  store.set('sa_token', 'OWNER');
  store.set('sa_user', JSON.stringify({ id: 'o', name: 'o', role: 'SUPER_ADMIN' }));
  const staffUser = { id: 's1', name: 'Staff', role: 'PLATFORM_STAFF', permissions: ['leads.view'] } as never;

  loc.pathname = '/staff/login';
  useAuthStore.getState().login('STAFF', staffUser);
  assert.equal(store.get('st_token'), 'STAFF');
  assert.equal(JSON.parse(store.get('st_user')!).role, 'PLATFORM_STAFF');
  assert.equal(store.has('token'), false, 'الموظف دخل مساحة الشركة');

  // تحديث الصلاحيات من /staff-auth/me يُكتب في مساحته
  useAuthStore.getState().patchUser({ permissions: ['leads.view', 'quotes.view'] });
  assert.deepEqual(JSON.parse(store.get('st_user')!).permissions, ['leads.view', 'quotes.view']);

  useAuthStore.getState().logout();
  assert.equal(store.has('st_token'), false);
  assert.equal(store.has('st_user'), false);
  assert.equal(store.get('sa_token'), 'OWNER', 'خروج الموظف أخرج المالك');

  // الموظف يدخل مساحته أينما كان المسار
  loc.pathname = '/';
  useAuthStore.getState().login('STAFF2', staffUser);
  assert.equal(store.get('st_token'), 'STAFF2');
  assert.equal(store.has('token'), false);
  useAuthStore.getState().logout();
  store.clear();
});

test('«دخول» شركة من لوحة الموظف يعود إليها: impersonating_from = /staff، والعودة تمحوه', () => {
  store.clear();
  loc.pathname = '/staff';
  useAuthStore.getState().impersonate('CO', { id: 'a', name: 'a', role: 'ADMIN' } as never, 'Co');
  assert.equal(store.get('impersonating_from'), '/staff');
  useAuthStore.getState().stopImpersonating();
  assert.equal(store.has('impersonating_from'), false);

  loc.pathname = '/platform';
  useAuthStore.getState().impersonate('CO', { id: 'a', name: 'a', role: 'ADMIN' } as never, 'Co');
  assert.equal(store.get('impersonating_from'), '/platform');
  useAuthStore.getState().stopImpersonating();
  store.clear();

  const layout = read('layouts', 'MainLayout.tsx');
  assert.match(layout, /localStorage\.getItem\('impersonating_from'\) === '\/staff' \? '\/staff' : '\/platform'/);
  // تُقرأ قبل أن يمحوها stopImpersonating
  assert.ok(layout.indexOf("getItem('impersonating_from')") < layout.indexOf('stopImpersonating();'), 'العلامة تُقرأ بعد محوها');
});

test('عميل الواجهة: ٤٠١ دخول الموظف (كلمة مرور خاطئة) ليس انتهاء جلسة', () => {
  const client = read('api', 'client.ts');
  const line = client.match(/const isLogin = [^\n]+/);
  assert.ok(line, 'تعذّر العثور على isLogin');
  assert.match(line[0], /\/staff-auth\/login/, '٤٠١ دخول الموظف يُعامَل انتهاء جلسة فيمحو علامة الانتحال');
  assert.match(line[0], /\/auth\/login/);
});

// ───────────────────────────── المسارات واللوحة ─────────────────────────────

test('App.tsx: /staff/login و/staff خلف StaffRoute، و/platform للمالك كما كانت', () => {
  const app = read('App.tsx');
  assert.match(app, /<Route path="\/staff\/login" element=\{<StaffLoginPage \/>\} \/>/);
  assert.match(app, /<Route path="\/staff" element=\{<StaffRoute><PlatformPage \/><\/StaffRoute>\} \/>/);
  assert.match(app, /<Route path="\/platform" element=\{<SuperAdminRoute><PlatformPage \/><\/SuperAdminRoute>\} \/>/);
  assert.match(app, /const StaffLoginPage = lazy\(\(\) => import\('\.\/pages\/StaffLoginPage'\)\);/);

  const guard = app.match(/function StaffRoute\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(guard, 'StaffRoute غير موجود');
  assert.match(guard[1], /if \(!token \|\| user\?\.role !== 'PLATFORM_STAFF'\) return <Navigate to="\/staff\/login" replace \/>;/);
  // كلمة المرور المؤقتة أولاً — قبل أي قسم
  assert.match(guard[1], /if \(user\.mustChangePassword\) return <StaffChangePasswordPage \/>;/);
  assert.ok(guard[1].indexOf('mustChangePassword') < guard[1].indexOf('{children}'));
});

test('PlatformPage: نافذة الموظفين والإدارة المالية خلف isOwner وحده', () => {
  const page = read('pages', 'PlatformPage.tsx');

  // زرّ واحد لكلٍّ منهما في الشريط الجانبي، داخل كتلة isOwner
  assert.equal((page.match(/setShowStaff\(true\)/g) || []).length, 1);
  assert.match(page, /\{isOwner && \(\s*<button onClick=\{\(\) => setShowStaff\(true\)\}/);
  assert.equal((page.match(/setShowFinance\(true\)/g) || []).length, 1);
  const finBtn = page.match(/\{isOwner && \(\s*<button onClick=\{\(\) => setShowFinance\(true\)\}[\s\S]*?<\/button>\s*\)\}/);
  assert.ok(finBtn, 'زرّ الإدارة المالية خارج isOwner');
  assert.match(finBtn[0], /tr\('الإدارة المالية'\)/);
  assert.equal((page.match(/tr\('الإدارة المالية'\)/g) || []).length, 1, 'ذِكرٌ ثانٍ للإدارة المالية خارج الحارس');

  // والتركيب نفسه بشرط isOwner (لا يكفي إخفاء الزرّ)
  assert.match(page, /\{showStaff && isOwner && <Suspense fallback=\{null\}><StaffPanel /);
  assert.equal((page.match(/<StaffPanel\b/g) || []).length, 1);
  assert.match(page, /\{showFinance && isOwner && \(\s*<FinancePanel\b/);
  assert.equal((page.match(/<FinancePanel\b/g) || []).length, 1);
  // نافذة الموظفين كسولة: حزمتها لا تُحمَّل في جلسة موظف
  assert.match(page, /const StaffPanel = lazy\(\(\) => import\('\.\.\/components\/StaffPanel'\)\);/);

  // والنافذة نفسها لا ترسم ولا تطلب شيئاً لغير المالك
  const panel = read('components', 'StaffPanel.tsx');
  assert.match(panel, /const \{ isOwner \} = usePlatformAccess\(\);\s*if \(!isOwner\) return null;\s*return <StaffPanelBody /);
});

test('لا مفتاح توكنٍ ثابت: لوحة العملاء المحتملين تصدّر بتوكن مساحة الجلسة، ولا ملف يقرأ sa_token حرفياً', () => {
  const leads = read('components', 'LeadsPanel.tsx');
  assert.doesNotMatch(leads, /['"`]sa_token['"`]/, 'LeadsPanel يرسل توكن المالك من جلسة الموظف');
  assert.match(leads, /localStorage\.getItem\(sessionSpace\(\)\.tokenKey\)/);

  // rep/printDevice.ts مرآةٌ لـsessionSpace بلا استيراد المتجر (له آثارٌ عند التحميل) تقرأ هوية جهاز الطباعة ولا ترسل توكناً —
  // ويفرض اختباره (printDevice.test.ts) تطابق مساحاتها
  const MIRRORS = new Set(['store/authStore.ts', 'rep/printDevice.ts']);
  const literal = sourceFiles()
    .filter((f) => !MIRRORS.has(rel(f)))
    .filter((f) => /['"`](sa|st)_token['"`]/.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(literal, [], `مفتاح توكن ثابت خارج authStore: ${literal.join(', ')}`);
});
