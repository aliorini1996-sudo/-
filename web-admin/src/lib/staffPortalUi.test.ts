import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * «موظفو المنصة» — حرّاس الواجهة بعد المراجعة الأمنية (٢٤ أكتوبر ٢٠٢٦):
 *  (أ) توكن «دخول» شركة لا يُتبنّى في /m، و«العودة» تُسقط نسخته، وانتهاء الجلسة يمحو علامة من دخل.
 *  (ب) ٤٠١ IMPERSONATION_ENDED يعود إلى لوحة من دخل (/staff أو /platform) لا إلى /login.
 *  (ج) /staff مسار تطبيق: مبدّل اللغة لا يقذف إلى /en/staff ولا يفرض LocaleSync العربية.
 *  (د) الموظف يعيد كلمة مدير الشركة ببريده بلا حقل ولا كلمة تظهر له؛ والمالك كما كان حرفياً.
 *  (هـ) تنبيهات المنح والنزع في نافذة الموظفين.  (و) رسائل الخادم تُعرض كما هي.  (ز) لا استطلاع لعدّاد الطلبات للموظف.
 */

// ── بيئة متصفّحٍ دنيا قبل التحميل: المخزن يتبنّى جلسة اللوحة لحظة استيراده ──
const NOW_S = Math.floor(Date.now() / 1000);
function tok(payload: Record<string, unknown>, salt = ''): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig${salt}`;
}
const IMP = tok({ id: 'a1', role: 'ADMIN', tenantId: 't1', impersonated: true, by: 's1', byKind: 'STAFF', btv: 0, exp: NOW_S + 7200 });
const ADMIN_USER = JSON.stringify({ id: 'a1', name: 'مدير', role: 'ADMIN' });

const store = new Map<string, string>([
  // «دخول» موظفٍ جارٍ في اللوحة، والتطبيق يُفتح على /m في المتصفّح نفسه
  ['token', IMP], ['user', ADMIN_USER], ['impersonating', 'Co'], ['impersonating_from', '/staff'],
]);
const loc = { pathname: '/m' };
const g = globalThis as unknown as Record<string, unknown>;
for (const [k, v] of Object.entries({
  window: { location: loc },
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => { store.set(key, String(val)); },
    removeItem: (key: string) => { store.delete(key); },
  },
})) Object.defineProperty(g, k, { value: v, configurable: true, writable: true });

const { useAuthStore, expiredDestination } = await import('../store/authStore');
const { isAppRoute } = await import('../i18n/lang');
// تبنّي الإقلاع وقع عند الاستيراد أعلاه — يُقرأ قبل أن يمسّ أيّ اختبارٍ المخزن
const adoptedAtBoot = store.get('m_token') ?? null;

const SRC = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const user = (role: string) => ({ id: 'a1', name: 'a', role }) as never;

// ───────────────────────────── (أ) تبنّي الجلسة ─────────────────────────────

test('(أ) الإقلاع على /m لا يتبنّى توكن «دخول» شركة من مساحة اللوحة', () => {
  assert.equal(adoptedAtBoot, null, 'نُسخ توكن «الدخول» إلى m_token فيبقى بعد «العودة»');
  assert.equal(store.has('m_user'), false);
});

test('(أ) «العودة» تُسقط نسخة /m إن طابقت التوكن المحذوف — ولا تمسّ جلسة تطبيقٍ أخرى', () => {
  // نسخةٌ تبنّاها /m قبل الإصلاح
  store.clear();
  loc.pathname = '/app';
  for (const [k, v] of [['token', IMP], ['user', ADMIN_USER], ['impersonating', 'Co'], ['impersonating_from', '/staff'], ['m_token', IMP], ['m_user', ADMIN_USER]]) store.set(k, v);
  useAuthStore.getState().stopImpersonating();
  for (const k of ['token', 'user', 'impersonating', 'impersonating_from', 'm_token', 'm_user']) assert.equal(store.has(k), false, `بقي ${k}`);

  // جلسة تطبيقٍ مستقلّة (دخولٌ يدويّ على /m بتوكنٍ آخر) لا شأن للعودة بها
  const OWN = tok({ id: 'a2', exp: NOW_S + 3600 }, 'own');
  for (const [k, v] of [['token', IMP], ['user', ADMIN_USER], ['impersonating', 'Co'], ['m_token', OWN], ['m_user', ADMIN_USER]]) store.set(k, v);
  useAuthStore.getState().stopImpersonating();
  assert.equal(store.get('m_token'), OWN, 'العودة أخرجت جلسة التطبيق المستقلّة');
  assert.equal(store.get('m_user'), ADMIN_USER);
  store.clear();
});

test('(أ) الخروج أثناء «دخول» شركة يُسقط نسخته في /m، وخروج المدير العادي يُبقي نسخته كما وُثّق', () => {
  store.clear();
  loc.pathname = '/app';
  for (const [k, v] of [['token', IMP], ['user', ADMIN_USER], ['impersonating', 'Co'], ['impersonating_from', '/platform'], ['m_token', IMP], ['m_user', ADMIN_USER]]) store.set(k, v);
  useAuthStore.setState({ token: IMP, user: user('ADMIN'), impersonating: 'Co' });
  useAuthStore.getState().logout();
  for (const k of ['token', 'user', 'impersonating', 'impersonating_from', 'm_token', 'm_user']) assert.equal(store.has(k), false, `بقي ${k}`);

  const PLAIN = tok({ id: 'a1', exp: NOW_S + 3600 }, 'plain');
  for (const [k, v] of [['token', PLAIN], ['user', ADMIN_USER], ['m_token', PLAIN], ['m_user', ADMIN_USER]]) store.set(k, v);
  useAuthStore.setState({ token: PLAIN, user: user('ADMIN'), impersonating: null });
  useAuthStore.getState().logout();
  assert.equal(store.has('token'), false);
  assert.equal(store.get('m_token'), PLAIN, 'الخروج من اللوحة يجب ألا يخرج من التطبيق (سلوكٌ موثّق)');
  store.clear();
});

test('(أ) انتهاء الجلسة في مساحة اللوحة يمحو علامة من دخل، وفي /m و/staff لا يمسّها', () => {
  store.clear();
  loc.pathname = '/app';
  for (const [k, v] of [['token', IMP], ['user', ADMIN_USER], ['impersonating', 'Co'], ['impersonating_from', '/staff']]) store.set(k, v);
  useAuthStore.setState({ token: IMP, user: user('ADMIN'), impersonating: 'Co' });
  useAuthStore.getState().sessionExpired();
  for (const k of ['token', 'user', 'impersonating', 'impersonating_from']) assert.equal(store.has(k), false, `بقي ${k}`);

  // انتهاء جلسة التطبيق شأنه وحده: «دخولٌ» جارٍ في اللوحة يبقى بعلامته
  loc.pathname = '/m';
  const M = tok({ id: 'a1', exp: NOW_S - 10 }, 'm');
  for (const [k, v] of [['token', IMP], ['impersonating', 'Co'], ['impersonating_from', '/staff'], ['m_token', M], ['m_user', ADMIN_USER]]) store.set(k, v);
  useAuthStore.setState({ token: M, user: user('ADMIN'), impersonating: 'Co' });
  useAuthStore.getState().sessionExpired();
  assert.equal(store.has('m_token'), false);
  assert.equal(store.get('m_rejected'), M);
  assert.equal(store.get('impersonating_from'), '/staff');
  assert.equal(store.get('token'), IMP);

  // وانتهاء جلسة الموظف نفسها على /staff لا يمحو علامة «دخولٍ» قد يبقى حيّاً في لوحة الشركة — فالعودة تبقى إلى /staff
  loc.pathname = '/staff';
  store.set('st_token', 'ST');
  useAuthStore.setState({ token: 'ST', user: user('PLATFORM_STAFF'), impersonating: null });
  useAuthStore.getState().sessionExpired();
  assert.equal(store.has('st_token'), false);
  assert.equal(store.get('impersonating_from'), '/staff');
  store.clear();
});

// ───────────────────────────── (ب) وجهة ٤٠١ ─────────────────────────────

test('(ب) IMPERSONATION_ENDED يعود إلى لوحة من دخل، وغيره إلى دخول المساحة كما كان', () => {
  store.clear();
  store.set('impersonating_from', '/staff');
  assert.equal(expiredDestination('IMPERSONATION_ENDED', '/app'), '/staff');
  assert.equal(expiredDestination('IMPERSONATION_ENDED', '/customers'), '/staff');
  store.set('impersonating_from', '/platform');
  assert.equal(expiredDestination('IMPERSONATION_ENDED', '/app'), '/platform');
  // علامةٌ غائبة (دخولٌ قبل «موظفي المنصة») أو عبثٌ بها ⇒ لوحة المالك كما يفعل شريط «العودة»
  store.delete('impersonating_from');
  assert.equal(expiredDestination('IMPERSONATION_ENDED', '/app'), '/platform');
  store.set('impersonating_from', 'https://evil.example');
  assert.equal(expiredDestination('IMPERSONATION_ENDED', '/app'), '/platform', 'وجهةٌ من التخزين بلا تقييد');

  // ٤٠١ عاديّ: دخول المساحة كما كان
  store.set('impersonating_from', '/staff');
  assert.equal(expiredDestination(undefined, '/app'), '/login');
  assert.equal(expiredDestination('IMPERSONATION_RENEW_REFUSED', '/app'), '/login');
  assert.equal(expiredDestination(undefined, '/staff'), '/staff/login');
  assert.equal(expiredDestination(undefined, '/platform'), '/owner');
  // التطبيق المثبَّت لا يُقذف خارجه ولو حمل الردّ الرمز
  assert.equal(expiredDestination('IMPERSONATION_ENDED', '/m'), '/m');
  assert.equal(expiredDestination('IMPERSONATION_ENDED', '/staff'), '/staff/login');
  store.clear();
});

test('(ب) المعترض: الوجهة تُحسب من رمز الردّ قبل sessionExpired الذي يمحو علامة من دخل', () => {
  const c = read('api', 'client.ts');
  const i = c.indexOf('const dest = expiredDestination(');
  const j = c.indexOf('useAuthStore.getState().sessionExpired()');
  assert.ok(i > 0 && j > 0, 'المعترض لا يحسب الوجهة أو لا ينهي الجلسة');
  assert.ok(i < j, 'الوجهة تُقرأ بعد محو impersonating_from');
  assert.match(c.slice(i, j), /err\.response\?\.data as \{ code\?: unknown \} \| undefined\)\?\.code/);
  assert.match(c, /if \(!samePath\(window\.location\.pathname, dest\)\) window\.location\.href = dest;/);
  // المعترض يعالج ٤٠١ وحده: ٤٠٣ STAFF_SESSION_NO_CREDENTIALS يصل إلى المكوّن برسالته
  assert.doesNotMatch(c, /status === 403/);
});

// ───────────────────────────── (ج) اللغة ─────────────────────────────

test('(ج) /staff ودخوله مسارا تطبيق، و/staffing وأشباهه ليست', () => {
  for (const p of ['/staff', '/staff/', '/staff/login']) assert.equal(isAppRoute(p), true, p);
  for (const p of ['/staffing', '/staff-picks', '/en/staff', '/stafflogin']) assert.equal(isAppRoute(p), false, p);
  // البدائل القديمة بحدودها كما كانت
  for (const p of ['/m', '/m/x', '/ax', '/activate', '/platform', '/owner', '/login', '/app']) assert.equal(isAppRoute(p), true, p);
  for (const p of ['/maghreb', '/axis', '/activated', '/', '/en']) assert.equal(isAppRoute(p), false, p);
});

// ───────────────────────────── (د) إعادة كلمة مدير الشركة ─────────────────────────────

test('(د) لوحة الموظف: نافذة تأكيدٍ بلا كلمة مرور تُرسل إلى بريد المدير — والمالك كما كان حرفياً', () => {
  const page = read('pages', 'PlatformPage.tsx');
  assert.match(page, /resetByEmail: !isOwner,/);
  // فرع المالك بنصّه القديم
  assert.match(page, /\{resetTarget && tenantPerms\.reset && \(!tenantPerms\.resetByEmail \? \(\s*<ResetPasswordModal\s+title=\{tr\('إعادة تعيين كلمة مرور مدير الشركة'\)\}[\s\S]*?onConfirm=\{async \(newPassword\) => \{ await tenantApi\.resetAdmin\(resetTarget\.id, \{ newPassword \}\); \}\}/);
  // وفرع الموظف: لا newPassword في الطلب، والبريد من الردّ
  const staff = page.slice(page.indexOf("title={tr('ارسال كلمة مرور مؤقتة الى بريد مدير الشركة')}"));
  const block = staff.slice(0, staff.indexOf('/>'));
  assert.match(block, /onSendTemporary=\{async \(\) => \(\(await tenantApi\.resetAdmin\(resetTarget\.id, \{\}\)\)\.data\.data\?\.email/);
  assert.doesNotMatch(block, /newPassword|onConfirm/);
  assert.equal((page.match(/<ResetPasswordModal\b/g) || []).length, 2);
  // زرّ الصف يقول ما سيقع
  assert.match(page, /title=\{perms\.resetByEmail \? tr\('ارسال كلمة مرور مؤقتة الى بريد مدير الشركة'\) : tr\('إعادة تعيين كلمة مرور مدير الشركة'\)\}/);

  const modal = read('components', 'ResetPasswordModal.tsx');
  const send = modal.slice(modal.indexOf('function SendTemporaryModal('));
  assert.ok(send.length > 0 && modal.indexOf('function SendTemporaryModal(') > 0, 'نافذة الإرسال مفقودة');
  assert.doesNotMatch(send, /<input\b/, 'حقل كلمة مرور في نافذة الموظف');
  assert.match(send, /\{tr\('ارسلت الى'\)\} \{sentTo \? <span className="font-semibold" dir="ltr">\{sentTo\}<\/span> : tr\('بريد مدير الشركة'\)\}/);
  assert.match(send, /response\?\.data\?\.message \|\| tr\('تعذر الارسال حاول ثانية'\)/, 'رسالة الخادم لا تُعرض');
  // والاختيار بالخاصية: onSendTemporary ⇒ الإرسال، وإلا النافذة القديمة
  assert.match(modal, /if \(props\.onSendTemporary\) return <SendTemporaryModal /);
});

// ───────────────────────────── (هـ) نافذة الموظفين ─────────────────────────────

test('(هـ) تنبيهات منح «الدخول» و«كلمة مرور المدير» ونزع «الدخول»', () => {
  const panel = read('components', 'StaffPanel.tsx');
  assert.match(panel, /\{checked && it\.key === 'tenants\.resetPassword' && \([\s\S]*?tr\('ترسل كلمة مرور مؤقتة الى بريد مدير الشركة ولا يراها الموظف'\)/);
  assert.match(panel, /\{checked && it\.key === 'tenants\.impersonate' && \([\s\S]*?لا ينشئ الموظف حسابات ولا كلمات مرور ولا مفاتيح ربط وكل ما يكتبه يسجل باسمه/);
  // ملاحظة النزع لموظفٍ قائمٍ كان يملكها — لا لموظفٍ جديد ولا لمن لم تُمنح له
  assert.match(panel, /\{!checked && it\.key === 'tenants\.impersonate' && initial\?\.permissions\.includes\('tenants\.impersonate'\) && \([\s\S]*?tr\('نزع الدخول يخرج الموظف من كل جلساته عند الحفظ ومنها دخوله الى الشركات فيدخل من جديد'\)/);
});

// ───────────────────────────── (و) رسائل الخادم ─────────────────────────────

test('(و) ٤٠٣ STAFF_SESSION_NO_CREDENTIALS و٤٠١ دخول الموظف يُعرضان برسالة الخادم', () => {
  const MSG = /response\?\.data\?\.message/;
  // ما يُنشئ حساباً أو كلمة مرور أو مفتاح ربط داخل لوحة الشركة
  const users = read('pages', 'CompanyUsersPage.tsx');
  const save = users.slice(users.indexOf('const saveMutation'), users.indexOf('const deleteMutation'));
  assert.match(save, MSG, 'حفظ مستخدم الشركة يبتلع رسالة الخادم');
  const reps = read('pages', 'SalesRepsPage.tsx');
  const repSave = reps.slice(reps.indexOf('const saveMutation'), reps.indexOf('const deleteMutation'));
  assert.match(repSave, MSG, 'حفظ المندوب يبتلع رسالة الخادم');
  const keys = read('pages', 'ApiKeysPage.tsx');
  assert.match(keys, /const errMsg = [\s\S]*?response\?\.data\?\.message \|\| fallback/);
  assert.match(keys, /onError: \(e\) => toast\.error\(errMsg\(e, tr\('تعذر إصدار المفتاح'\)\)\)/);
  // إعادة كلمة مرور المستخدم والمندوب: النافذة تعرض رسالة الخادم
  const modal = read('components', 'ResetPasswordModal.tsx');
  assert.match(modal.slice(0, modal.indexOf('function SendTemporaryModal(')), /response\?\.data\?\.message \|\| tr\('تعذر إعادة التعيين'\)/);
  // دخول الموظف: ٤٠١ العامة (والقفل) برسالة الخادم، والمعترض يستثني طلب الدخول فلا يمحو شيئاً
  const login = read('pages', 'StaffLoginPage.tsx');
  assert.match(login, /response\?\.data\?\.message \|\| t\('login\.error'\)/);
  assert.match(read('api', 'client.ts'), /const isLogin = [^\n]*\/staff-auth\/login/);
});

// ───────────────────────────── (ز) عدّاد الطلبات ─────────────────────────────

test('(ز) عدّاد الطلبات: لا استطلاع ولا جلب عند التركيز للموظف — والمالك كما كان', () => {
  const live = read('components', 'LiveUsersPanel.tsx');
  const q = live.slice(live.indexOf("queryKey: ['request-stats', reqRange]"));
  const block = q.slice(0, q.indexOf('});'));
  assert.match(block, /refetchInterval: isStaff \? false : 30000,/);
  assert.match(block, /refetchOnWindowFocus: !isStaff,/);
  assert.match(block, /enabled: mode === 'requests' && canRequests,/);
  assert.match(live, /const \{ can, isStaff \} = usePlatformAccess\(\);/);
  // زرّ «تحديث الآن» القائم يجلب الطلبات يدوياً
  assert.match(live, /else \{ reqRefetch\(\); \}/);
});
