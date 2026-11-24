import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOGIN_ACTIONS, latinDigits, loginErrorOf, looksLikeEmail, looksLikePhone, readResetToken } from './loginErrors';
import { SUPPORT_WHATSAPP } from './supportContact';
import { PHRASES } from '../i18n/strings';

// استعادة الحساب بالبريد ورسائل رفض الدخول الدقيقة (طلب المالك ٢١ نوفمبر ٢٠٢٦)

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('رموز رفض الدخول ⇒ الفعل: كلمة مرور خاطئة تفتح «نسيت»، وحساب المندوب/الإدارة يرشد لبابه، والتفعيل «افحص بريدك»', () => {
  const e = (status: number, code?: string, message?: string) => loginErrorOf({ response: { status, data: { success: false, code, message } } });
  assert.equal(e(401, 'WRONG_PASSWORD', 'كلمة المرور غير صحيحة').action, 'forgot');
  assert.equal(e(401, 'INVALID_CREDENTIALS', 'البريد أو كلمة المرور غير صحيحة').action, 'forgot');
  assert.equal(e(401, 'REP_ACCOUNT', 'هذا حساب مندوب — ادخل من تطبيق المندوب').action, 'repApp');
  assert.equal(e(401, 'ADMIN_ACCOUNT', 'هذا حساب إدارة — ادخل من صفحة الشركة').action, 'adminLogin');
  assert.equal(e(403, 'PENDING_ACTIVATION').action, 'checkEmail');
  assert.equal(e(403, 'ACCOUNT_DISABLED').action, null);
  assert.equal(e(403, 'TENANT_BLOCKED').action, null);
  assert.equal(e(429, undefined, 'محاولات دخول كثيرة انتظر 15 دقيقة ثم حاول مجددا').action, null);
  // الرسالة كما أرسلها الخادم، والانقطاع بلا ردّ
  assert.equal(e(401, 'WRONG_PASSWORD', 'كلمة المرور غير صحيحة').message, 'كلمة المرور غير صحيحة');
  assert.deepEqual(loginErrorOf(new Error('Network Error')), { code: null, message: null, action: null, offline: true });
  assert.deepEqual(Object.keys(LOGIN_ACTIONS).sort(), ['ADMIN_ACCOUNT', 'INVALID_CREDENTIALS', 'PENDING_ACTIVATION', 'REP_ACCOUNT', 'WRONG_PASSWORD']);
});

test('كل رسالة رفضٍ واستعادة يرسلها الخادم مترجمةٌ حرفاً بحرف — وإلا ظهرت عربيةً لغير العربي', () => {
  const server = [
    'البريد أو كلمة المرور غير صحيحة', 'كلمة المرور غير صحيحة', 'حسابك موقوف — تواصل مع مدير شركتك',
    'حسابك لم يُفعَّل بعد — افتح رابط التفعيل الذي وصل إلى بريدك', 'هذا حساب مندوب — ادخل من تطبيق المندوب',
    'اسم المستخدم أو كلمة المرور غير صحيحة', 'كلمة المرور غير صحيحة — اطلب من مدير شركتك إعادة تعيينها',
    'هذا حساب إدارة — ادخل من صفحة الشركة', 'اشتراك الشركة موقوف - تواصل مع مزود الخدمة', 'انتهى اشتراك الشركة - تواصل مع مزود الخدمة',
    'إن كان البريد مسجلاً لدينا فسيصلك رابط إعادة تعيين كلمة المرور خلال دقائق — افحص صندوق الوارد والرسائل غير المرغوبة',
    'اكتب بريداً إلكترونياً صحيحاً', 'طلبات كثيرة حاول بعد قليل', 'أرسلنا رابط الاستعادة إلى بريد مدير الشركة',
    'إن كان الرقم مسجلاً لشركة فسيصل رابط الاستعادة إلى بريد مديرها — وإن لم يصلك شيء فتواصل مع الدعم',
    'اكتب رقم جوال الشركة', 'رابط إعادة التعيين غير صالح أو منتهي الصلاحية', 'كلمة المرور 8 أحرف على الأقل',
    'محاولات دخول كثيرة انتظر 15 دقيقة ثم حاول مجددا',
  ];
  const missing = server.filter((m) => !PHRASES[m]?.en || !PHRASES[m]?.zh);
  assert.deepEqual(missing, []);
});

test('رابط إعادة التعيين: الرمز من الوسم #t= وحده لا الاستعلام، ويُمحى من الشريط قبل أي طلب', () => {
  assert.equal(readResetToken('#t=abc.def'), 'abc.def');
  assert.equal(readResetToken(''), '');
  assert.equal(readResetToken('#x=1'), '');
  const page = read('../pages/ResetPasswordPage.tsx');
  assert.match(page, /readResetToken\(window\.location\.hash\)/);
  assert.doesNotMatch(page, /location\.search/, 'الرمز لا يُقرأ من الاستعلام');
  assert.doesNotMatch(page, /localStorage|sessionStorage/, 'الرمز في الذاكرة وحدها');
  const replace = page.indexOf("window.history.replaceState(window.history.state, '', RESET_PATH)");
  const preview = page.indexOf('authApi.resetPreview(token)');
  assert.ok(replace > 0 && preview > replace, 'يُمحى الرمز من الشريط قبل طلب المعاينة');
  assert.match(page, /const RESET_PATH = '\/reset-password';/);
});

test('المسار مسجَّل كسولاً، ومستثنى كـ/activate: لا زيارة ولا زرّ واتساب ولا فهرسة، ومبدّل اللغة لا ينقل', () => {
  const app = read('../App.tsx');
  assert.match(app, /const ResetPasswordPage = lazy\(\(\) => import\('\.\/pages\/ResetPasswordPage'\)\);/);
  assert.match(app, /<Route path="\/reset-password" element=\{<ResetPasswordPage \/>\} \/>/);
  assert.match(app, /\|activate\|reset-password\|rep\|/, 'VisitTracker يسجّل زيارةً على صفحة الرمز');
  assert.match(read('../components/WhatsAppFab.tsx'), /\|activate\|reset-password\|rep\|/);
  assert.match(read('../i18n/lang.ts'), /activate\|reset-password\|staff/);
  assert.match(read('../../public/robots.txt'), /^Disallow: \/reset-password$/m);
  assert.match(read('../../scripts/gen-robots.mjs'), /'Disallow: \/reset-password'/);
  assert.match(read('../i18n/i18nRoutes.mjs'), /'reset-password'/);
});

test('نافذة الاستعادة: البريد ⇒ forgot-password، ورقم جوال الشركة ⇒ recover-email، والمندوب عبر مديره', () => {
  const dlg = read('../components/ForgotPasswordDialog.tsx');
  assert.match(dlg, /authApi\.forgotPassword\(email\.trim\(\)\)/);
  assert.match(dlg, /authApi\.recoverEmail\(phone\.trim\(\)\)/);
  assert.match(dlg, /isRep \? \(\s*<RepHelp/);
  const client = read('../api/client.ts');
  assert.match(client, /forgotPassword: \(email: string\) => api\.post\('\/auth\/forgot-password', \{ email \}\)/);
  assert.match(client, /recoverEmail: \(phone: string\) => api\.post\('\/auth\/recover-email', \{ phone \}\)/);
  assert.match(client, /resetPreview: \(token: string\) => api\.post\('\/auth\/reset-password\/preview', \{ token \}\)/);
  assert.match(client, /resetPassword: \(data: \{ token: string; password: string \}\) => api\.post\('\/auth\/reset-password', data\)/);
  // ٤٠١ من مسارات الاستعادة العامة ليس انتهاء جلسة
  assert.match(client, /const PUBLIC_AUTH_PATHS = \['\/auth\/forgot-password', '\/auth\/recover-email', '\/auth\/reset-password'\];/);
  assert.match(client, /const isLogin = [^\n]*PUBLIC_AUTH_PATHS\.some/);
});

test('شاشات الدخول الثلاث تعرض مربّع الرفض بفعله — لا «بيانات غير صحيحة» ثابتة', () => {
  for (const f of ['../pages/LoginPage.tsx', '../m/MobileLogin.tsx', '../rep/RepApp.tsx']) {
    const s = read(f);
    assert.match(s, /setError\(loginErrorOf\(err\)\)/, f);
    assert.match(s, /<LoginErrorBox error=\{error\} fallback=\{t\('(login\.error|rep\.badCreds)'\)\} onForgot=\{\(\) => setShowForgot\(true\)\} \/>/, f);
  }
  const box = read('../components/LoginErrorBox.tsx');
  assert.match(box, /error\.action === 'repApp'[\s\S]*href="\/rep"/);
  assert.match(box, /error\.action === 'adminLogin'[\s\S]*href="\/login"/);
});

test('أدوات الإدخال: الأرقام العربية تُعدّ في الجوال، وفحص البريد الأوّلي، ورقم الدعم نفسه في البوابة', () => {
  assert.equal(latinDigits('٠٥٠١٢٣٤٥٦٧'), '0501234567');
  assert.equal(latinDigits('۰۵۰'), '050');
  assert.ok(looksLikePhone('٠٥٠١٢٣٤٥٦٧'));
  assert.ok(looksLikePhone('+966 50 123 4567'));
  assert.ok(!looksLikePhone('12345'));
  assert.ok(looksLikeEmail(' a@b.co '));
  assert.ok(!looksLikeEmail('a@b'));
  assert.match(read('../affiliate/format.ts'), new RegExp(`SUPPORT_WHATSAPP = '${SUPPORT_WHATSAPP}'`));
});
