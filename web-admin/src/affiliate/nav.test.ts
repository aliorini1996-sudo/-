import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AUTH_VIEWS, TAB_IDS, linkTokenFromSearch, viewFromSearch, tabFromHash, authViewSearch, tabHash,
  authTarget, tabTarget, verifyOutcome, showLinkScreen,
} from './nav';
import { errorCode, errorStatus, isTermsOutdated, verifyErrorKind } from './errors';

/**
 * زرّ الرجوع في أندرويد يمشي في سجلّ المتصفّح — فكل شاشةٍ في البوابة يجب أن
 * تُشتقّ من العنوان، وكل انتقالٍ مدخلٌ في السجل، بلا حلقة عند الشاشة الأولى.
 */

test('الشاشة من العنوان: رمز البريد أولاً، ثم ?view=، وإلا الدخول', () => {
  assert.equal(viewFromSearch(''), 'login');
  assert.equal(viewFromSearch('?view=register'), 'register');
  assert.equal(viewFromSearch('?view=forgot'), 'forgot');
  assert.equal(viewFromSearch('?view=resend'), 'resend');
  assert.equal(viewFromSearch('?view=verify'), 'verify');
  assert.equal(viewFromSearch('?view=reset'), 'reset');
  assert.equal(viewFromSearch('?view=admin'), 'login', 'قيمة مجهولة ⇒ الدخول');
  assert.equal(viewFromSearch('?verify=abc'), 'verify');
  assert.equal(viewFromSearch('?reset=abc&view=register'), 'reset', 'رابط البريد يسبق view');
  for (const v of AUTH_VIEWS) assert.equal(viewFromSearch(authViewSearch(v)), v, `ذهاب وإياب ${v}`);
});

test('رمز رابط البريد يُقرأ من الاستعلام', () => {
  assert.deepEqual(linkTokenFromSearch('?verify=T1'), { kind: 'verify', token: 'T1' });
  assert.deepEqual(linkTokenFromSearch('?reset=T2'), { kind: 'reset', token: 'T2' });
  assert.deepEqual(linkTokenFromSearch('?verify=T1&reset=T2'), { kind: 'verify', token: 'T1' });
  assert.equal(linkTokenFromSearch('?verify='), null);
  assert.equal(linkTokenFromSearch('?view=verify'), null, 'الشاشة وحدها بلا رمز');
  assert.equal(linkTokenFromSearch(''), null);
});

test('التبويب من الوسم — الرئيسية بلا وسم', () => {
  assert.equal(tabFromHash(''), 'home');
  assert.equal(tabFromHash('#'), 'home');
  assert.equal(tabFromHash('#claims'), 'claims');
  assert.equal(tabFromHash('#nope'), 'home');
  assert.equal(tabHash('home'), '');
  for (const t of TAB_IDS) assert.equal(tabFromHash(tabHash(t)), t, `ذهاب وإياب ${t}`);
});

test('الدخول هو /ax بلا معامل — الشاشة الأولى', () => {
  assert.equal(authViewSearch('login'), '');
  assert.equal(authViewSearch('register'), '?view=register');
});

test('الانتقال بين الشاشات مدخلٌ جديد — والنقرة المكرّرة لا تُضيف مدخلاً', () => {
  assert.deepEqual(authTarget('', '', 'register'), { search: '?view=register', hash: '' });
  assert.deepEqual(authTarget('?view=register', '', 'login'), { search: '', hash: '' });
  assert.deepEqual(authTarget('?view=verify', '', 'resend'), { search: '?view=resend', hash: '' });
  assert.equal(authTarget('?view=register', '', 'register'), null);
  assert.equal(authTarget('', '', 'login'), null, 'الدخول من الدخول لا يُضيف مدخلاً');
  assert.deepEqual(authTarget('?verify=T', '', 'verify'), { search: '?view=verify', hash: '' }, 'الرمز لا يبقى في الشريط');

  assert.deepEqual(tabTarget('', '', 'claims'), { search: '', hash: '#claims' });
  assert.deepEqual(tabTarget('', '#claims', 'home'), { search: '', hash: '' });
  assert.equal(tabTarget('', '#claims', 'claims'), null);
  assert.equal(tabTarget('', '', 'home'), null);
  assert.equal(tabTarget('', '#home', 'home'), null);
  assert.deepEqual(tabTarget('?view=register', '', 'home'), { search: '', hash: '' }, 'معامل شاشة قديم يُنظَّف');
});

test('نتيجة رابط التأكيد حسب الحالة الفعلية — بلا وعد مراجعة لمرفوض أو موقوف', () => {
  assert.equal(verifyOutcome('pending_review'), 'review');
  assert.equal(verifyOutcome('approved'), 'approved');
  assert.equal(verifyOutcome('rejected'), 'already');
  assert.equal(verifyOutcome('suspended'), 'already');
  assert.equal(verifyOutcome(undefined), 'already');
  assert.equal(verifyOutcome('weird'), 'already');
});

test('AffiliateApp: الشاشة والتبويب من العنوان، والانتقال دفعٌ لا استبدال', () => {
  const s = readFileSync(new URL('./AffiliateApp.tsx', import.meta.url), 'utf8');
  assert.match(s, /viewFromSearch\(location\.search\)/, 'الشاشة لا تُشتقّ من العنوان');
  assert.match(s, /tabFromHash\(location\.hash\)/, 'التبويب لا يُشتقّ من الوسم');
  assert.doesNotMatch(s, /useState<AuthView>/, 'الشاشة ما زالت حالة React — الرجوع يخرج من البوابة');
  assert.doesNotMatch(s, /useState<Tab>/, 'التبويب ما زال حالة React');
  // الانتقال بين الشاشات والتبويبات يُضيف مدخلاً (بلا replace)
  const goBody = s.match(/const go = useCallback\([\s\S]*?\}, \[/);
  assert.ok(goBody, 'دالّة go غير موجودة');
  assert.doesNotMatch(goBody![0], /replace: true/, 'go تستبدل بدل أن تدفع');
  const tabBody = s.match(/const setTab = useCallback\([\s\S]*?\}, \[/);
  assert.ok(tabBody, 'دالّة setTab غير موجودة');
  assert.doesNotMatch(tabBody![0], /replace: true/, 'setTab تستبدل بدل أن تدفع');
});

test('شاشة الدخول: رسالة الخادم الموحّدة تُعرض كما هي بلا تفريع على نصّها', () => {
  const s = readFileSync(new URL('./screens/AuthScreens.tsx', import.meta.url), 'utf8');
  const login = s.match(/export function LoginScreen[\s\S]*?\n\}\n/);
  assert.ok(login, 'LoginScreen غير موجود');
  assert.doesNotMatch(login![0], /needsVerify/, 'فرع «لم يُؤكَّد بريدك» ما زال — سيظهر مع كل فشل');
  assert.doesNotMatch(login![0], /لم يُؤكَّد بريدك بعد/);
  assert.doesNotMatch(login![0], /أكّد\|أكد\|تأكيد/);
  assert.match(login![0], /لم تصلك رسالة التأكيد؟/, 'رابط إعادة الإرسال يجب أن يبقى ظاهراً دائماً');
  assert.match(login![0], /errMessage\(err/);

  const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /423/, 'لا 423 في العقد الجديد');
});

test('تأكيد البريد: كلمة المرور إلزامية ولا إرسال تلقائي، و password_mismatch يعرض «قدّم طلب انضمام»', () => {
  const s = readFileSync(new URL('./screens/AuthScreens.tsx', import.meta.url), 'utf8');
  const verify = s.match(/export function VerifyScreen[\s\S]*?\n\}\n/);
  assert.ok(verify, 'VerifyScreen غير موجود');
  const v = verify![0];
  assert.match(v, /أدخل كلمة المرور التي اخترتها عند التسجيل لتأكيد بريدك/);
  assert.match(v, /affiliateApi\.verifyEmail\(token, password\)/, 'كلمة المرور لا تُرسل مع الرمز');
  assert.doesNotMatch(v, /useEffect\(/, 'التأكيد يُرسل تلقائياً عند الفتح');
  assert.match(v, /PasswordInput/);
  assert.match(v, /verifyErrorKind\(err\)/);
  assert.match(v, /go\('register'\)[^\n]*قدّم طلب انضمام/, 'لا طريق للتسجيل عند عدم تطابق كلمة المرور');
  assert.match(v, /go\('resend'\)/, 'لا إعادة إرسال للرابط غير الصالح');
  assert.match(v, /verifyOutcome\(status\)/, 'نتيجة التأكيد لا تتبع الحالة الفعلية');
  assert.match(s, /بريدك مؤكَّد وحسابك مقبول/);
  assert.match(s, /بريدك مؤكَّد مسبقاً/);

  const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  assert.match(api, /axApi\.post\('\/verify-email', \{ token, password \}\)/);
});

test('تعيين كلمة المرور: الرمز المُعاد يُحفظ ax_token ويدخل البوابة مباشرة', () => {
  const s = readFileSync(new URL('./screens/AuthScreens.tsx', import.meta.url), 'utf8');
  const reset = s.match(/export function ResetScreen[\s\S]*?\n\}\n/);
  assert.ok(reset, 'ResetScreen غير موجود');
  assert.match(reset![0], /if \(r\?\.token\) \{\s*setToken\(r\.token\);\s*toast\.success\('تم تعيين كلمة المرور'\);\s*onLoggedIn\(\);/);
  assert.match(reset![0], /setDone\(true\)/, 'بلا رمز ⇒ شاشة الدخول كما كانت');
  const app = readFileSync(new URL('./AffiliateApp.tsx', import.meta.url), 'utf8');
  assert.match(app, /<ResetScreen [^>]*onLoggedIn=\{onLoggedIn\}/);
});

test('شاشة رابط البريد مع جلسة قائمة: الرابط الطازج فقط، والعودة من السجل ⇒ البوابة', () => {
  const base = { view: 'verify' as const, token: 'T', hasToken: false, freshLink: null };
  assert.equal(showLinkScreen('verify', base), true, 'بلا جلسة تُعرض');
  assert.equal(showLinkScreen('verify', { ...base, hasToken: true }), false, 'جلسة + من السجل ⇒ البوابة');
  assert.equal(showLinkScreen('verify', { ...base, hasToken: true, freshLink: 'verify' }), true, 'رابطٌ فُتح للتوّ');
  assert.equal(showLinkScreen('verify', { ...base, token: undefined }), false, 'بلا رمز في الذاكرة');
  assert.equal(showLinkScreen('reset', base), false, 'شاشةٌ أخرى');
  assert.equal(showLinkScreen('reset', { ...base, view: 'reset', hasToken: true, freshLink: 'verify' }), false);
});

test('403 terms_outdated: بوابة قبول الشروط لا خطأ ولا خروج', () => {
  assert.equal(isTermsOutdated({ response: { status: 403, data: { code: 'terms_outdated', message: 'نُشرت شروطٌ جديدة' } } }), true);
  assert.equal(isTermsOutdated({ response: { status: 403, data: { message: 'الحساب موقوف' } } }), false, '403 الحالة يبقى كما هو');
  assert.equal(isTermsOutdated({ response: { status: 401, data: { code: 'terms_outdated' } } }), false);
  assert.equal(isTermsOutdated(new Error('x')), false);
  assert.equal(isTermsOutdated(null), false);

  const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  assert.match(api, /if \(isTermsOutdated\(err\)\) \{\s*termsOutdatedListeners\.forEach/, 'المعترض لا يُبلغ عن الشروط الجديدة');
  // لا يمسح التوكن: المسح لـ401 وحده
  const block = api.match(/if \(isTermsOutdated\(err\)\) \{[\s\S]*?\n {4}\}/);
  assert.ok(block);
  assert.doesNotMatch(block![0], /clearToken/);

  const app = readFileSync(new URL('./AffiliateApp.tsx', import.meta.url), 'utf8');
  assert.match(app, /onTermsOutdated\(\(\) => \{\s*setTermsOutdated\(true\);\s*void qc\.invalidateQueries\(\{ queryKey: qk\.me \}\);/);
  assert.match(app, /if \(termsOutdated \|\| data\.user\.termsVersion !== data\.settings\.currentTermsVersion\)/);
  assert.match(app, /onAccepted=\{onTermsAccepted\}/);
});

test('نوع فشل تأكيد البريد', () => {
  const e = (status: number, code?: string) => ({ response: { status, data: { message: 'x', ...(code ? { code } : {}) } } });
  assert.equal(verifyErrorKind(e(400, 'password_mismatch')), 'mismatch');
  assert.equal(verifyErrorKind(e(400)), 'invalid');
  assert.equal(verifyErrorKind(e(409)), 'invalid', 'تغيّر الطلب للتوّ ⇒ رابط أحدث');
  assert.equal(verifyErrorKind(e(429)), 'retry');
  assert.equal(verifyErrorKind(e(500)), 'retry');
  assert.equal(verifyErrorKind(new Error('network')), 'retry');
  assert.equal(errorCode(e(400, 'password_mismatch')), 'password_mismatch');
  assert.equal(errorCode(e(400)), undefined);
  assert.equal(errorStatus(e(403)), 403);
});
