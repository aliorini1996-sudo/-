import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';

// استعادة كلمة المرور بالبريد وبرقم جوال الشركة، ورسائل رفض الدخول (طلب المالك ٢١ نوفمبر ٢٠٢٦)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-reset';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const R = require('../services/passwordReset') as typeof import('../services/passwordReset');
const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');

test('الرمز: يحمل بصمة كلمة المرور الحالية ويسقط متى تغيّرت — ولا يُقرأ رمزَ جلسة ولا رمز غرضٍ آخر', () => {
  const t = R.signResetToken('a1', 'hash-v1', 'Ali@x.com');
  const v = R.verifyResetToken(t);
  assert.deepEqual(v, { aid: 'a1', fp: R.resetFingerprint('hash-v1', 'ali@x.com') });
  assert.notEqual(v!.fp, R.resetFingerprint('hash-v2', 'ali@x.com'), 'تغيّر كلمة المرور يُسقط الرابط');
  assert.notEqual(v!.fp, R.resetFingerprint('hash-v1', 'new@x.com'), 'تغيّر البريد يُسقط رابطاً أُرسل للعنوان القديم');
  // رمز جلسةٍ بسرّ JWT العام لا يصلح رابط استعادة، ولا رمزٌ بغرضٍ آخر
  assert.equal(R.verifyResetToken(jwt.sign({ id: 'a1', role: 'ADMIN', aid: 'a1', purpose: 'password-reset', fp: v!.fp }, process.env.JWT_SECRET!)), null);
  assert.equal(R.verifyResetToken('garbage'), null);
  const decoded = jwt.decode(t) as { exp: number; iat: number };
  assert.equal(decoded.exp - decoded.iat, 3600, 'صالح ساعة واحدة');
});

test('الرابط في المقطع (#t=) لا الاستعلام — لا يصل سجلّات الخادم', () => {
  const u = R.resetUrl('abc.def');
  assert.match(u, /\/reset-password#t=abc\.def$/);
  assert.doesNotMatch(u, /\?/);
});

test('البريد المقنّع يكفي صاحبه ولا يكشفه', () => {
  assert.equal(R.maskEmail('ahmed.ali@gmail.com'), 'a•••@g•••.com');
  assert.equal(R.maskEmail('x@company.com.sa'), 'x•••@c•••.sa');
});

test('رقم جوال الشركة: الأرقام العربية، والصيغة المحلية والدولية، والمسافات — رقمٌ واحد', () => {
  assert.ok(R.samePhone('٠٥٠١٢٣٤٥٦٧', '+966 50 123 4567'));
  assert.ok(R.samePhone('0501234567', '966501234567'));
  assert.ok(R.samePhone('501234567', '00966501234567'));
  assert.ok(R.samePhone('0501234567', '+966 50 123 45 67'), 'المحفوظ بمسافاتٍ داخل آخر الأرقام');
  assert.ok(R.samePhone('0501234567', '٠٥٠١٢٣٤٥٦٧'), 'المحفوظ بأرقامٍ عربية');
  assert.ok(R.samePhone('0501234567', '971501234567'), 'رقمٌ محلي بلا رمز دولة يطابق شركةً إماراتية بذيله');
  assert.ok(!R.samePhone('+971501234567', '0501234567'), 'رقمٌ برمز دولة لا يطابق شركةً في دولةٍ أخرى بذيله');
  assert.ok(!R.samePhone('0501234567', '0501234568'));
  assert.ok(!R.samePhone('123', '123'), 'رقمٌ قصير لا يطابق شيئاً');
});

test('بريد الاستعادة: نصٌّ ثابت بالبريد مُهرَّباً والرابط وحده — لا حقن HTML', () => {
  const html = R.passwordResetHtml('a"<b>@x.com', 'tok', 'email');
  assert.doesNotMatch(html, /<b>@x\.com/);
  assert.match(html, /reset-password#t=tok/);
  assert.match(R.passwordResetHtml('a@x.com', 'tok', 'phone'), /برقم جوالها/);
});

test('المسارات: الردّ على «نسيت كلمة المرور» واحدٌ وُجد البريد أم لا، وحدّ البريد على الطلبين، ولا «لا يوجد حساب»', () => {
  const s = read('..', 'routes', 'auth.ts');
  const forgot = s.slice(s.indexOf("router.post('/forgot-password'"), s.indexOf("router.post('/recover-email'"));
  assert.match(forgot, /router\.post\('\/forgot-password', mailLimiter,/);
  assert.match(forgot, /await requestPasswordReset\(email\);\n\s+res\.json\(\{ success: true, message: FORGOT_SENT \}\);/, 'ردٌّ واحد بلا تفرّع على وجود الحساب');
  assert.match(s, /router\.post\('\/recover-email', mailLimiter,/);
  assert.match(s, /router\.post\('\/reset-password\/preview', resetLimiter,/);
  assert.doesNotMatch(s, /['"`]لا يوجد حساب/, 'لا نصّ ردٍّ يقول «لا يوجد حساب»');
  const svc = read('..', 'services', 'passwordReset.ts');
  assert.match(svc, /where: \{ id: admin\.id, passwordHash: admin\.passwordHash, email: admin\.email, isActive: true \}/, 'التعيين مشروطٌ بالبصمة فيعمل الرابط مرّةً واحدة');
  assert.match(s, /router\.post\('\/reset-password', resetLimiter,/);
  // تغيير بريد مدير الشركة يُحرس كتغيير كلمة مروره — وإلا نقله مشرفٌ إلى بريده ثم استعاد كلمة المرور
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { changesAdminAccount } = require('../routes/companyUsers') as typeof import('../routes/companyUsers');
  assert.equal(changesAdminAccount({ targetRole: 'ADMIN', email: true }), true);
  assert.equal(changesAdminAccount({ targetRole: 'MANAGER', email: true }), false);
  assert.match(read('..', 'routes', 'companyUsers.ts'), /password: !!password, email: emailChanges \}/);
  assert.match(svc, /if \(isPendingActivationHash\(admin\.passwordHash\)\) \{ await resendActivationForSignup\(admin\.id\); return true; \}/);
});

test('رسائل رفض الدخول تبيّن الخطأ — والبريد غير المسجّل يأخذ الرسالة العامة', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LOGIN_REFUSALS } = require('../routes/auth') as typeof import('../routes/auth');
  assert.equal(LOGIN_REFUSALS.admin.WRONG_PASSWORD, 'كلمة المرور غير صحيحة');
  assert.equal(LOGIN_REFUSALS.admin.INVALID_CREDENTIALS, 'البريد أو كلمة المرور غير صحيحة');
  assert.equal(LOGIN_REFUSALS.rep.INVALID_CREDENTIALS, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  const s = read('..', 'routes', 'auth.ts');
  const login = s.slice(s.indexOf("router.post('/login', authLimiter"), s.indexOf('* تجديد التوكن'));
  // الترتيب: لا حساب ⇒ موقوف ⇒ بانتظار التفعيل ⇒ كلمة المرور — فلا يُقال «كلمة المرور خطأ» لحسابٍ موقوف
  const order = ["loginRefused(res, 401, isRep ? 'REP_ACCOUNT' : 'INVALID_CREDENTIALS')", "loginRefused(res, 403, 'ACCOUNT_DISABLED')",
    "loginRefused(res, 403, 'PENDING_ACTIVATION')", "loginRefused(res, 401, 'WRONG_PASSWORD')"].map((x) => login.indexOf(x));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), JSON.stringify(order));
  assert.equal((login.match(/code: 'TENANT_BLOCKED'/g) ?? []).length, 2);
});
