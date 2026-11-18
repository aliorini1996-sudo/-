import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AUTH_VIEWS, TAB_IDS, BOTTOM_TABS, MORE_TABS, linkTokenFromSearch, viewFromSearch, tabFromHash, authViewSearch, tabHash,
  authTarget, tabTarget, showLinkScreen, isLegacyAuthLink, isMoreTab, visibleTabs,
} from './nav';
import { errorCode, errorStatus, errorText, fieldErrorMsg, isEmailTaken, isTermsOutdated, localizedServerText } from './errors';
import { AX_DICT } from './i18n';

/**
 * زرّ الرجوع في أندرويد يمشي في سجلّ المتصفّح — فكل شاشةٍ في البوابة يجب أن
 * تُشتقّ من العنوان، وكل انتقالٍ مدخلٌ في السجل، بلا حلقة عند الشاشة الأولى.
 */

test('الشاشة من العنوان: رمز الاستعادة أولاً، ثم ?view=، وإلا الدخول', () => {
  assert.equal(viewFromSearch(''), 'login');
  assert.equal(viewFromSearch('?view=register'), 'register');
  assert.equal(viewFromSearch('?view=forgot'), 'forgot');
  assert.equal(viewFromSearch('?view=reset'), 'reset');
  assert.equal(viewFromSearch('?view=admin'), 'login', 'قيمة مجهولة ⇒ الدخول');
  assert.equal(viewFromSearch('?reset=abc&view=register'), 'reset', 'رابط البريد يسبق view');
  // v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦ — الانضمام فوريّ): لا شاشة تأكيد بريد ولا إعادة إرسال —
  // روابط v1 القديمة تذهب للدخول بدل شاشةٍ لم تعد موجودة
  assert.deepEqual([...AUTH_VIEWS], ['login', 'register', 'forgot', 'reset']);
  assert.equal(viewFromSearch('?view=resend'), 'login');
  assert.equal(viewFromSearch('?view=verify'), 'login');
  assert.equal(viewFromSearch('?verify=abc'), 'login');
  for (const v of AUTH_VIEWS) assert.equal(viewFromSearch(authViewSearch(v)), v, `ذهاب وإياب ${v}`);
});

test('رمز رابط الاستعادة يُقرأ من الاستعلام — ورابط التأكيد القديم ليس رمزاً', () => {
  assert.deepEqual(linkTokenFromSearch('?reset=T2'), { kind: 'reset', token: 'T2' });
  assert.deepEqual(linkTokenFromSearch('?verify=T1&reset=T2'), { kind: 'reset', token: 'T2' });
  assert.equal(linkTokenFromSearch('?verify=T1'), null, 'v2: لا تأكيد بريد');
  assert.equal(linkTokenFromSearch('?reset='), null);
  assert.equal(linkTokenFromSearch('?view=reset'), null, 'الشاشة وحدها بلا رمز');
  assert.equal(linkTokenFromSearch(''), null);
});

test('روابط بريد v1 (تأكيد/إعادة إرسال) تُكتشف لتُستبدل بالدخول', () => {
  for (const q of ['?verify=T1', '?verify=', '?view=verify', '?view=resend', '?view=verify&x=1']) {
    assert.equal(isLegacyAuthLink(q), true, q);
  }
  for (const q of ['', '?view=register', '?view=forgot', '?reset=T', '?reset=T&verify=x', '?view=reset']) {
    assert.equal(isLegacyAuthLink(q), false, q);
  }
  const app = readFileSync(new URL('./AffiliateApp.tsx', import.meta.url), 'utf8');
  assert.match(app, /const legacyLink = isLegacyAuthLink\(location\.search\);/);
  assert.match(app, /if \(legacyLink \|\| orphanToken\) navigate\(\{ pathname: location\.pathname, search: '', hash: '' \}, \{ replace: true \}\);/,
    'رابط التأكيد القديم لا يُستبدل بالدخول');
  assert.doesNotMatch(app, /VerifyScreen|ResendScreen/);
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
  assert.deepEqual(authTarget('?view=forgot', '', 'register'), { search: '?view=register', hash: '' });
  assert.equal(authTarget('?view=register', '', 'register'), null);
  assert.equal(authTarget('', '', 'login'), null, 'الدخول من الدخول لا يُضيف مدخلاً');
  assert.deepEqual(authTarget('?reset=T', '', 'reset'), { search: '?view=reset', hash: '' }, 'الرمز لا يبقى في الشريط');
  assert.deepEqual(authTarget('?view=verify', '', 'login'), { search: '', hash: '' }, 'رابط v1 القديم ليس «الدخول نفسه»');

  assert.deepEqual(tabTarget('', '', 'claims'), { search: '', hash: '#claims' });
  assert.deepEqual(tabTarget('', '#claims', 'home'), { search: '', hash: '' });
  assert.equal(tabTarget('', '#claims', 'claims'), null);
  assert.equal(tabTarget('', '', 'home'), null);
  assert.equal(tabTarget('', '#home', 'home'), null);
  assert.deepEqual(tabTarget('?view=register', '', 'home'), { search: '', hash: '' }, 'معامل شاشة قديم يُنظَّف');
});

test('الشريط السفليّ (الرئيسية · شركاتي · أرباحي) و«المزيد» بالباقي — كل تبويبٍ في مكانٍ واحد', () => {
  // v2 (V2_SPEC §7): على الجوال ثلاثة تبويبات و«المزيد»، وعلى الحاسوب الشريط الجانبيّ بالكل
  assert.deepEqual([...BOTTOM_TABS], ['home', 'companies', 'earnings']);
  assert.deepEqual([...MORE_TABS], ['link', 'claims', 'trial', 'missed', 'pricing', 'materials', 'faq', 'support', 'profile', 'terms']);
  assert.deepEqual([...BOTTOM_TABS, ...MORE_TABS].sort(), [...TAB_IDS].sort(), 'تبويبٌ بلا مكان أو في مكانين');
  for (const t of ['missed', 'materials', 'faq', 'support'] as const) assert.ok(TAB_IDS.includes(t), t);
  for (const t of BOTTOM_TABS) assert.equal(isMoreTab(t), false, t);
  for (const t of MORE_TABS) assert.equal(isMoreTab(t), true, t);
  assert.deepEqual(visibleTabs(MORE_TABS, false).includes('trial'), false, 'التجريبيّ المطفأ لا يظهر في «المزيد»');
  assert.deepEqual(visibleTabs(TAB_IDS, true), [...TAB_IDS]);
  assert.equal(tabFromHash('#missed'), 'missed');
  assert.equal(tabFromHash('#materials'), 'materials');
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
  // v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦): لا تأكيد بريد — فلا رابط «لم تصلك رسالة التأكيد؟» ولا نصّ
  // يطلب تأكيد البريد قبل الدخول (حسابات v1 المعلّقة تُرقّى عند أوّل دخولٍ ناجح)
  assert.doesNotMatch(login![0], /go\('resend'\)|noVerifyMail/, 'رابط إعادة إرسال التأكيد ما زال في الدخول');
  assert.ok(!('login.noVerifyMail' in AX_DICT));
  for (const l of ['ar', 'en'] as const) assert.doesNotMatch(AX_DICT['login.invalid'][l], /أكّد بريدك|confirm your email/i);
  assert.match(login![0], /t\('login\.apply'\)/, 'لا طريق للتسجيل من الدخول');
  assert.match(login![0], /errorText\(failure, lang, 'login\.failed', httpStatus\(failure\) === 401 \? 'login\.invalid' : undefined\)/);

  const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /423/, 'لا 423 في العقد الجديد');
});

test('التسجيل الفوريّ: 201 {token, user} يُخزَّن ويدخل الرئيسية — بلا شاشة تأكيد ولا مراجعة', () => {
  // v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦ — V2_SPEC §6.1): الحارس البديل لحارس «تأكيد البريد بكلمة المرور»
  const s = readFileSync(new URL('./screens/AuthScreens.tsx', import.meta.url), 'utf8');
  const reg = s.match(/export function RegisterScreen[\s\S]*?\n\}\n/);
  assert.ok(reg, 'RegisterScreen غير موجود');
  assert.match(reg![0], /onSuccess: \(r\) => \{\s*clearRegisterDraft\(\);\s*setEmail\(form\.email\.trim\(\)\);\s*setToken\(r\.token\);[\s\S]*?onLoggedIn\(\);/,
    'التوكن لا يُخزَّن أو لا يدخل الرئيسية بعد التسجيل');
  assert.doesNotMatch(reg![0], /doneMessage|reg\.doneTitle|go\('resend'\)/, 'شاشة «تم استلام طلبك» ما زالت');
  // 409 email_taken ⇒ «سجّل الدخول»، و409 غيره ⇒ شروطٌ أحدث
  assert.match(reg![0], /if \(isEmailTaken\(err\)\) \{ setTaken\(err\); return; \}/);
  assert.match(reg![0], /<PartnerTypePicker value=\{form\.partnerType\}/, 'نوع السفير غير موجود في التسجيل');
  assert.match(reg![0], /form\.partnerType === 'company' && \(/, 'اسم الشركة لا يظهر للشركة');
  assert.doesNotMatch(s, /export function (VerifyScreen|ResendScreen)/, 'شاشة تأكيد/إعادة إرسال ما زالت');
  const app = readFileSync(new URL('./AffiliateApp.tsx', import.meta.url), 'utf8');
  assert.match(app, /case 'register': return <RegisterScreen \{\.\.\.nav\} onLoggedIn=\{onLoggedIn\} \/>;/);
  const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /verify-email|resend-verification/, 'مسارا التأكيد حُذفا من الخادم');
  assert.match(api, /unwrap<\{ token: string; user: AffiliateMe \}>\(await axApi\.post\('\/register', body\)\)/);
  for (const k of Object.keys(AX_DICT)) assert.doesNotMatch(k, /^(verify|resend)\./, `${k} نصٌّ لشاشةٍ حُذفت`);
});

test('تعيين كلمة المرور: الرمز المُعاد يُحفظ ax_token ويدخل البوابة مباشرة', () => {
  const s = readFileSync(new URL('./screens/AuthScreens.tsx', import.meta.url), 'utf8');
  const reset = s.match(/export function ResetScreen[\s\S]*?\n\}\n/);
  assert.ok(reset, 'ResetScreen غير موجود');
  assert.match(reset![0], /if \(r\?\.token\) \{\s*setToken\(r\.token\);\s*toast\.success\(t\('reset\.success'\)\);\s*onLoggedIn\(\);/);
  assert.equal(AX_DICT['reset.success'].ar, 'تم تعيين كلمة المرور');
  assert.match(reset![0], /setDone\(true\)/, 'بلا رمز ⇒ شاشة الدخول كما كانت');
  const app = readFileSync(new URL('./AffiliateApp.tsx', import.meta.url), 'utf8');
  assert.match(app, /<ResetScreen [^>]*onLoggedIn=\{onLoggedIn\}/);
});

test('شاشة رابط الاستعادة مع جلسة قائمة: الرابط الطازج فقط، والعودة من السجل ⇒ البوابة', () => {
  const base = { view: 'reset' as const, token: 'T', hasToken: false, freshLink: null };
  assert.equal(showLinkScreen('reset', base), true, 'بلا جلسة تُعرض');
  assert.equal(showLinkScreen('reset', { ...base, hasToken: true }), false, 'جلسة + من السجل ⇒ البوابة');
  assert.equal(showLinkScreen('reset', { ...base, hasToken: true, freshLink: 'reset' }), true, 'رابطٌ فُتح للتوّ');
  assert.equal(showLinkScreen('reset', { ...base, token: undefined }), false, 'بلا رمز في الذاكرة');
  assert.equal(showLinkScreen('reset', { ...base, view: 'login' }), false, 'شاشةٌ أخرى');
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

test('409 email_taken (التسجيل الفوريّ) غير 409 الشروط القديمة', () => {
  // v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦): بديل «نوع فشل تأكيد البريد» — التأكيد حُذف
  const e = (status: number, code?: string) => ({ response: { status, data: { message: 'x', ...(code ? { code } : {}) } } });
  assert.equal(isEmailTaken(e(409, 'email_taken')), true);
  assert.equal(isEmailTaken(e(409, 'terms_outdated')), false, 'شروطٌ أحدث تُعيد تحميل الشروط لا «سجّل الدخول»');
  assert.equal(isEmailTaken(e(409)), false);
  assert.equal(isEmailTaken(e(400, 'email_taken')), false);
  assert.equal(isEmailTaken(null), false);
  assert.equal(errorCode(e(409, 'email_taken')), 'email_taken');
  assert.equal(errorCode(e(400)), undefined);
  assert.equal(errorStatus(e(403)), 403);
  assert.equal(AX_DICT['reg.emailTaken'].ar, 'يوجد حساب بهذا البريد — سجّل الدخول', 'نصّ الخادم نفسه (V2_SPEC §6.1)');
});

test('نصوص الأخطاء: العربية تعرض رسالة الخادم كما هي، وغيرها يترجم الحالات المعروفة', () => {
  const e = (status: number, message?: string, code?: string) => ({
    isAxiosError: true, response: { status, data: { ...(message ? { message } : {}), ...(code ? { code } : {}) } },
  });
  const serverAr = 'تعذّر الدخول — تحقّق من البريد وكلمة المرور';
  // العربية: رسالة الخادم كما كانت
  assert.equal(errorText(e(401, serverAr), 'ar', 'login.failed', 'login.invalid'), serverAr);
  // بلا رسالة: البديل العربي
  assert.equal(errorText(e(500), 'ar', 'err.loadData'), 'تعذّر تحميل البيانات');
  // الإنجليزية: الحالة المعروفة مترجمة لا عربية
  assert.equal(errorText(e(401, serverAr), 'en', 'login.failed', 'login.invalid'), AX_DICT['login.invalid'].en);
  assert.equal(errorText(e(429, 'محاولات كثيرة'), 'fr', 'err.generic'), AX_DICT['err.tooMany'].fr);
  assert.equal(errorText({ isAxiosError: true }, 'tr', 'err.generic'), AX_DICT['err.network'].tr);
  assert.equal(errorText(e(409, 'يوجد حساب بهذا البريد — سجّل الدخول', 'email_taken'), 'zh', 'reg.failed'), AX_DICT['reg.emailTaken'].zh);
  assert.equal(errorText(e(429, 'مطالبات كثيرة', 'too_many_missed_claims'), 'fr', 'missed.failed'), AX_DICT['err.tooManyMissedClaims'].fr);
  assert.equal(errorText(e(403, 'نُشرت شروطٌ جديدة', 'terms_outdated'), 'en', 'err.generic'), AX_DICT['err.termsOutdated'].en);
  // رسالة خادمٍ غير معروفة: تُعرض كما هي (عربية) — وبلا رسالة البديل المترجم
  assert.equal(errorText(e(409, 'تغيّرت الحالة'), 'en', 'err.generic'), 'تغيّرت الحالة');
  assert.equal(errorText(e(500), 'en', 'err.generic'), AX_DICT['err.generic'].en);

  // نصوص النجاح من الخادم (202 · 201)
  assert.equal(localizedServerText('ar', 'إن كان البريد مسجّلاً فستصلك رسالة', 'accepted.forgot'), 'إن كان البريد مسجّلاً فستصلك رسالة');
  assert.equal(localizedServerText('ar', null, 'accepted.forgot'), AX_DICT['accepted.forgot'].ar);
  assert.equal(localizedServerText('en', 'استلمنا الترشيح وسيُراجع', 'claims.received'), AX_DICT['claims.received'].en);
});

test('429 برمز too_many_open_claims: سببه الحقيقي لا «محاولات كثيرة»', () => {
  const tooMany = { isAxiosError: true, response: { status: 429, data: { message: 'لديك ترشيحات كثيرة قيد المراجعة — انتظر البتّ فيها', code: 'too_many_open_claims' } } };
  for (const l of ['en', 'fr', 'tr', 'zh'] as const) {
    assert.equal(errorText(tooMany, l, 'claims.submitFailed'), AX_DICT['err.tooManyOpenClaims'][l], l);
  }
  assert.equal(errorText(tooMany, 'ar', 'claims.submitFailed'), 'لديك ترشيحات كثيرة قيد المراجعة — انتظر البتّ فيها');
  assert.equal(AX_DICT['err.tooManyOpenClaims'].ar, 'لديك ترشيحات كثيرة قيد المراجعة — انتظر البتّ فيها');
  // 429 المحدِّد بلا رمز يبقى «محاولات كثيرة»
  const limiter = { isAxiosError: true, response: { status: 429, data: { message: 'محاولات كثيرة' } } };
  assert.equal(errorText(limiter, 'en', 'claims.submitFailed'), AX_DICT['err.tooMany'].en);
});

test('400 من zod بحقلٍ مرفوض ⇒ رسالة التحقّق المطابقة بكل اللغات لا «بيانات غير صحيحة email»', () => {
  const zod400 = (errors: Record<string, string[]>) => ({
    isAxiosError: true,
    response: { status: 400, data: { success: false, message: `بيانات غير صحيحة ${Object.keys(errors).join(' ')}`, errors } },
  });
  assert.equal(errorText(zod400({ email: ['Invalid email'] }), 'en', 'reg.failed'), AX_DICT['val.email'].en);
  assert.equal(errorText(zod400({ email: ['Invalid email'] }), 'ar', 'reg.failed'), AX_DICT['val.email'].ar);
  assert.equal(errorText(zod400({ phone: ['x'] }), 'fr', 'reg.failed'), AX_DICT['val.phone'].fr);
  assert.equal(errorText(zod400({ contactPhone: ['x'] }), 'zh', 'claims.submitFailed'), AX_DICT['val.contactPhone'].zh);
  assert.equal(errorText(zod400({ crNumber: ['x'] }), 'tr', 'claims.submitFailed'), AX_DICT['val.cr'].tr);
  assert.equal(errorText(zod400({ city: ['x'] }), 'en', 'reg.failed'), 'City name can be at most 60 characters');
  assert.equal(errorText(zod400({ note: ['x'] }), 'en', 'claims.submitFailed'), 'Note can be at most 200 characters');
  // بترتيب الحقول على الشاشة
  assert.equal(errorText(zod400({ password: ['x'], email: ['x'] }), 'en', 'reg.failed'), AX_DICT['val.email'].en);
  const map: Record<string, string> = {
    fullName: 'val.fullName', email: 'val.email', phone: 'val.phone', password: 'val.passwordMin', city: 'val.cityTooLong',
    vatNumber: 'val.vat', companyName: 'val.companyName', crNumber: 'val.cr', contactPhone: 'val.contactPhone', note: 'val.noteTooLong',
    partnerType: 'val.partnerType', socialLinks: 'val.socialUrl', dataUrl: 'val.docType',
  };
  for (const [field, key] of Object.entries(map)) {
    assert.equal(fieldErrorMsg(zod400({ [field]: ['x'] }))?.key, key, field);
  }
  // حقلٌ غير معروف: رسالة الخادم كما هي، وليس 400 ⇒ لا تحويل
  assert.equal(errorText(zod400({ weird: ['x'] }), 'en', 'reg.failed'), 'بيانات غير صحيحة weird');
  assert.equal(fieldErrorMsg({ response: { status: 409, data: { errors: { email: ['x'] } } } }), null);
});
