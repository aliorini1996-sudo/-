import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CITY_MAX, CONTACT_PHONE_MAX, containsContactInfo, isValidEmail, normContactPhone, normPhoneSA, normCR, normVat, normIbanSA,
  EMPTY_REGISTER, registerError, buildRegisterBody, type RegisterForm, normAffiliatePhone, composeAffiliatePhone,
  EMPTY_CLAIM, claimError, buildClaimBody, type ClaimForm,
  buildProfileBody, profileError, type ProfileForm, payoutError,
} from './validation';
import { AX_DICT, translate } from './i18n';
import { z } from 'zod';

/** مفتاح رسالة التحقّق أو null — الرسائل مفاتيح قاموس لا نصوص */
const key = (r: { key: string } | null) => r?.key ?? null;

test('كاشف بيانات الاتصال: بريد، أو سلسلة أرقام بفواصل تحوي ثمانية أرقام فأكثر — مرآة الخادم', () => {
  const rejected = [
    'راسل ahmed@example.com',
    'a.b@x.co',
    'جواله 0551234567',
    '0551234567',
    '12345678',
    '٠٥٥١٢٣٤٥٦٧',                // أرقام عربية-هندية
    '۰۵۵۱۲۳۴۵۶۷',                // فارسية
    '١٢٣٤٥٦٧٨',                  // ثمانية أرقام هندية
    '055 123 4567',               // بمسافات
    '+966 55-123-4567',
    '(055) 1234567',
    '055.123.4567',               // بنقاط — كانت تفلت من الكاشف القديم
    '055/123/4567',               // بشرطات مائلة
    '055\\123\\4567',             // بشرطات مائلة عكسية
    '055_123_4567',               // بشرطات سفلية
    'اتصل ٠٥٥.١٢٣.٤٥٦٧ مساءً',
    '1234 5678',                  // ثمانية أرقام بفاصل واحد
    // الكاشف الجديد: أيّ ما ليس حرفاً فاصل، وNFKC قبل الفحص
    '055،123،4567',               // فاصلة عربية
    '055,123,4567',
    '055:123:4567',               // نقطتان ليستا وقتاً
    '٠٥٥٫١٢٣٫٤٥٦٧',              // فاصل عشري عربي
    '055​1234567',           // محرف خفيّ (مسافة صفرية)
    '０５５１２３４５６７',          // أرقام عريضة
    'ali＠gmail.com',              // «＠» عريضة
    '0551-23-4567',               // يشبه التاريخ وليس تاريخاً
  ];
  for (const t of rejected) assert.equal(containsContactInfo(t), true, `يجب رفض: ${t}`);

  const accepted = [
    '',
    'تعرفت عليهم في معرض الرياض 2026',
    'معرض الرياض ٢٠٢٦',
    'فرعين في جدة والدمام',
    'لديهم 7 مناديب و3 سيارات',
    '1234567',                    // سبعة أرقام فقط
    '123.4567',                   // سبعة أرقام بفاصل
    'مؤسسة @ الرياض',              // @ بلا نطاق ليس بريداً
    'فرع 12 وفرع 345 وفرع 678',    // أرقام تفصلها كلمات لا فواصل
    'زرتهم 2026-09-13',            // تاريخ — يُستبدل بكلمة قبل الفحص
    'موعدنا 13/09/2026',
    'موعدنا 13/09/2026 14:00',     // تاريخ ووقت
    'زرناهم 2026/9/1 الساعة 9:30',
  ];
  for (const t of accepted) assert.equal(containsContactInfo(t), false, `يجب قبول: ${t}`);
  assert.equal(containsContactInfo(null), false);
  assert.equal(containsContactInfo(12345678), false);
  // التعبير عامّ (g): الاستدعاءات المتتالية لا تتأثّر بـlastIndex
  assert.equal(containsContactInfo('055.123.4567'), true);
  assert.equal(containsContactInfo('055.123.4567'), true);
});

test('كاشف بيانات الاتصال: مطابقٌ حرفياً لنصّ الخادم', (t) => {
  let server = '';
  try { server = readFileSync(new URL('../../../backend/src/services/affiliate/rules.ts', import.meta.url), 'utf8'); } catch {
    t.skip('مصدر الخادم غير متاح في هذا الفحص');
    return;
  }
  const client = readFileSync(new URL('./validation.ts', import.meta.url), 'utf8');
  const body = (src: string) => {
    const m = src.match(/export function containsContactInfo\(text: unknown\): boolean \{([\s\S]*?)\n\}/);
    assert.ok(m, 'containsContactInfo غير موجودة');
    // التعليقات والمسافات والثابت المسمّى لا تغيّر السلوك
    return m![1].replace(/\/\/[^\n]*/g, '').replace(/CONTACT_MIN_DIGITS/g, '8').replace(/\s+/g, '');
  };
  assert.equal(body(client), body(server), 'نسخة الواجهة تخالف كاشف الخادم');
});

test('الجوال السعودي بصيغة الخادم', () => {
  assert.equal(normPhoneSA('0551234567'), '966551234567');
  assert.equal(normPhoneSA('551234567'), '966551234567');
  assert.equal(normPhoneSA('+966551234567'), '966551234567');
  assert.equal(normPhoneSA('00966551234567'), '966551234567');
  assert.equal(normPhoneSA('٠٥٥١٢٣٤٥٦٧'), '966551234567');
  assert.equal(normPhoneSA('0112345678'), null);   // أرضي
  assert.equal(normPhoneSA('05512345'), null);
  assert.equal(normPhoneSA(''), null);
});

test('السجل التجاري والرقم الضريبي', () => {
  assert.equal(normCR('1010123456'), '1010123456');
  assert.equal(normCR('١٠١٠١٢٣٤٥٦'), '1010123456');
  assert.equal(normCR('1010 123 456'), '1010123456');
  assert.equal(normCR('101012345'), null);
  assert.equal(normCR('10101234567'), null);
  assert.equal(normVat('300000000000003'), '300000000000003');
  assert.equal(normVat('300 0000 0000 0003'), '300000000000003');
  assert.equal(normVat('30000000000000'), null);
});

test('الآيبان السعودي بفحص mod-97', () => {
  // آيبان صالح حسابياً (رقم تجريبي معروف الصيغة)
  assert.equal(normIbanSA('SA03 8000 0000 6080 1016 7519'), 'SA0380000000608010167519');
  assert.equal(normIbanSA('sa0380000000608010167519'), 'SA0380000000608010167519');
  assert.equal(normIbanSA('SA0380000000608010167518'), null, 'خانة تحقق خاطئة');
  assert.equal(normIbanSA('SA038000000060801016751'), null, 'طول ناقص');
  assert.equal(normIbanSA('AE070331234567890123456'), null, 'ليس سعودياً');
});

const validRegister = (): RegisterForm => ({
  ...EMPTY_REGISTER,
  fullName: 'سارة أحمد',
  email: 'Sara@Example.com ',
  phone: '0551234567',
  password: 'correct-horse',
  acceptTerms: true,
});

test('التسجيل: الحقول الإلزامية والموافقة على الشروط — بلا إقرارات ولا «موثوق»', () => {
  assert.equal(registerError(validRegister()), null);
  assert.equal(key(registerError({ ...validRegister(), fullName: 'س' })), 'val.fullName');
  assert.equal(key(registerError({ ...validRegister(), email: 'nope' })), 'val.email');
  assert.equal(key(registerError({ ...validRegister(), phone: '12345' })), 'val.phone');
  assert.equal(key(registerError({ ...validRegister(), password: '1234567' })), 'val.passwordMin', 'كلمة المرور ≥ 8');
  assert.equal(registerError({ ...validRegister(), password: '12345678' }), null);
  assert.equal(key(registerError({ ...validRegister(), password: 'x'.repeat(129) })), 'val.passwordMax');
  assert.equal(key(registerError({ ...validRegister(), vatNumber: '123' })), 'val.vat');
  assert.equal(key(registerError({ ...validRegister(), acceptTerms: false })), 'val.acceptTerms');
  // لا شرط غير هذه: نموذجٌ بالحقول الإلزامية والموافقة وحدها صالح
  assert.deepEqual(Object.keys(EMPTY_REGISTER).sort(), ['acceptTerms', 'city', 'email', 'fullName', 'marketingConsent', 'password', 'phone', 'phoneCountry', 'vatNumber']);
});

test('جسم التسجيل: بلا declarations ولا publicPromoter ولا حقول موثوق', () => {
  const body = buildRegisterBody(validRegister(), '2026-09-v1');
  assert.deepEqual(body, {
    fullName: 'سارة أحمد',
    email: 'sara@example.com',
    phone: '966551234567',
    password: 'correct-horse',
    marketingConsent: false,
    acceptTerms: true,
    termsVersion: '2026-09-v1',
  });
  for (const k of ['declarations', 'publicPromoter', 'mawthooqNo', 'mawthooqExpiry', 'city', 'vatNumber']) {
    assert.ok(!(k in body), `${k} لا يُرسل`);
  }

  const full = buildRegisterBody({ ...validRegister(), city: ' الرياض ', vatNumber: '300000000000003', marketingConsent: true }, 'v2');
  assert.equal(full.city, 'الرياض');
  assert.equal(full.vatNumber, '300000000000003');
  assert.equal(full.marketingConsent, true);
});

const validClaim = (): ClaimForm => ({ ...EMPTY_CLAIM, companyName: 'مؤسسة النخبة للتوزيع', crNumber: '١٠١٠١٢٣٤٥٦', contactPhone: '0551234567', how: 'visit' });

test('رقم التواصل: جوال سعودي بصيغه، أو أيّ رقمٍ من 8 إلى 15 رقماً — مرآة الخادم', () => {
  const ok = [
    '0551234567', '551234567', '+966551234567', '00966551234567', '٠٥٥١٢٣٤٥٦٧',
    '011 234 5678', '(011) 234-5678', '+971 4 123 4567', '0097141234567', '12345678', '123456789012345',
    '055.123.4567',
  ];
  for (const v of ok) assert.ok(normContactPhone(v), `يجب قبول: ${v}`);
  const bad = ['', '   ', '1234567', '1234567890123456', 'abc12345678', '011/234/5678', '12-34', 'x'.repeat(31), '+'];
  for (const v of bad) assert.equal(normContactPhone(v), null, `يجب رفض: ${v}`);
  assert.equal(CONTACT_PHONE_MAX, 30);
  assert.equal(normContactPhone(' ٠٥٥١٢٣٤٥٦٧ '), '0551234567', 'أرقام لاتينية بلا فراغات طرفية');
  assert.equal(normContactPhone('+971 4 123 4567'), '+971 4 123 4567', 'يُرسل كما كُتب');
});

test('رقم التواصل: NFKC قبل كل شيء — الأرقام و«＋» و«（）» العريضة مقبولة كالخادم', () => {
  assert.equal(normContactPhone('０５５１２３４５６７'), '0551234567');
  assert.ok(normContactPhone('＋９７１ ５０ １２３ ４５６７'));
  assert.ok(normContactPhone('（０１１）２３４５６７８'));
});

/** مدخلاتٌ مشتركة تُمرَّر على نسخة الواجهة ونسخة الخادم معاً — القبول والرفض يجب أن يتطابقا */
const CONTACT_PHONE_TABLE = [
  '0551234567', '551234567', '+966551234567', '00966551234567', '٠٥٥١٢٣٤٥٦٧', '۰۵۵۱۲۳۴۵۶۷',
  '０５５１２３４５６７', '＋９７１５０１２３４５６７', '（０１１）２３４５６７８',
  '011 234 5678', '(011) 234-5678', '+971 4 123 4567', '0097141234567', '12345678', '123456789012345',
  '055.123.4567', '920012345',
  '', '   ', '1234567', '1234567890123456', 'abc12345678', '011/234/5678', '12-34', '+', '٠١٢٣',
];

test('رقم التواصل: نسخة الواجهة تطابق الخادم على جدولٍ مشترك (العريضة منها)', async (t) => {
  const url = new URL('../../../backend/src/services/affiliate/rules.ts', import.meta.url);
  let server: { normContactPhone: (v: unknown) => string | null } | null = null;
  try {
    readFileSync(url);
    server = await import(url.href);
  } catch {
    t.skip('مصدر الخادم غير متاح في هذا الفحص');
    return;
  }
  for (const v of CONTACT_PHONE_TABLE) {
    const client = normContactPhone(v) !== null;
    const srv = server!.normContactPhone(v) !== null;
    assert.equal(client, srv, `اختلاف القبول على «${v}»: الواجهة ${client} · الخادم ${srv}`);
  }
  // الجوال بأرقامٍ عريضة يُخزَّن بالصيغة الموحّدة في الخادم
  assert.equal(server!.normContactPhone('０５５１２３４５６７'), '966551234567');
});

test('البريد: قاعدة zod .email() حرفياً — ما يرفضه الخادم يُرفض في المتصفّح', () => {
  const zodEmail = z.string().trim().email();
  const table = [
    'sara@example.com', ' Sara@Example.COM ', 'a.b+tag@sub.domain.sa', "o'neil@mail.co", 'x_y-z@d-1.io',
    'ali@gmail,com.sa', 'ali@gmail.com.', 'ali..h@gmail.com', 'ali.@gmail.com', '.ali@gmail.com',
    'علي@gmail.com', 'ali@جوجل.com', 'ali@gmail.c0m', 'ali@gmail.c', 'ali@-gmail.com', 'ali@gmail', 'ali gmail.com', '',
  ];
  for (const v of table) {
    assert.equal(isValidEmail(v), zodEmail.safeParse(v).success, `اختلاف على «${v}»`);
  }
  for (const bad of ['ali@gmail,com.sa', 'ali@gmail.com.', 'ali..h@gmail.com', 'ali.@gmail.com', 'علي@gmail.com']) {
    assert.equal(isValidEmail(bad), false, `يجب رفض ${bad}`);
  }
  assert.equal(isValidEmail('sara@example.com'), true);
});

test('الترشيح: رقم التواصل إلزاميّ وصالح، والكاشف لا يُطبَّق عليه', () => {
  assert.equal(key(claimError({ ...validClaim(), contactPhone: '' })), 'val.contactPhoneRequired');
  assert.equal(key(claimError({ ...validClaim(), contactPhone: '   ' })), 'val.contactPhoneRequired');
  assert.equal(key(claimError({ ...validClaim(), contactPhone: '12345' })), 'val.contactPhone');
  assert.equal(claimError({ ...validClaim(), contactPhone: '+966 55 123 4567' }), null, 'رقمٌ فيه ثمانية أرقام مقبول في خانته');
  // ترتيب الحقول على الشاشة: السجل ثم المدينة ثم رقم التواصل ثم «كيف عرّفتهم»
  assert.equal(key(claimError({ ...validClaim(), contactPhone: '', how: '' })), 'val.contactPhoneRequired');
  assert.equal(key(claimError({ ...validClaim(), contactPhone: '', crNumber: '1' })), 'val.cr');
});

test('الترشيح: سجل 10 أرقام وطريقة تعريف وملاحظة بلا بيانات اتصال', () => {
  assert.equal(claimError(validClaim()), null);
  assert.equal(key(claimError({ ...validClaim(), companyName: 'م' })), 'val.companyName');
  assert.equal(key(claimError({ ...validClaim(), crNumber: '123' })), 'val.cr');
  assert.equal(key(claimError({ ...validClaim(), how: '' })), 'val.how');
  const long = claimError({ ...validClaim(), note: 'x'.repeat(201) });
  assert.deepEqual(long, { key: 'val.noteTooLong', vars: { max: 200 } });
  assert.equal(claimError({ ...validClaim(), note: 'x'.repeat(200) }), null);
  assert.equal(key(claimError({ ...validClaim(), note: 'كلّم أبو فهد 0551234567' })), 'val.noteContact');
  assert.equal(key(claimError({ ...validClaim(), note: 'fahd@mail.com' })), 'val.noteContact');
  assert.equal(key(claimError({ ...validClaim(), note: 'جواله 055.123.4567' })), 'val.noteContact');
  assert.equal(claimError({ ...validClaim(), note: 'تعرّفنا في معرض الرياض ٢٠٢٦' }), null);
});

test('الترشيح: بيانات الاتصال مرفوضة في الاسم والملاحظة **والمدينة**', () => {
  assert.equal(key(claimError({ ...validClaim(), companyName: 'مؤسسة النخبة 055/123/4567' })), 'val.companyContact');
  assert.equal(key(claimError({ ...validClaim(), city: 'الرياض 0551234567' })), 'val.cityContact');
  assert.equal(key(claimError({ ...validClaim(), city: 'jeddah@mail.com' })), 'val.cityContact');
  assert.equal(claimError({ ...validClaim(), city: 'الرياض' }), null);
  assert.equal(claimError({ ...validClaim(), city: 'حي 2026' }), null);
});

test('جسم الترشيح يحمل contactPhone دائماً', () => {
  assert.deepEqual(buildClaimBody(validClaim()), { companyName: 'مؤسسة النخبة للتوزيع', crNumber: '1010123456', contactPhone: '0551234567', how: 'visit' });
  assert.deepEqual(
    buildClaimBody({ ...validClaim(), city: ' جدة ', note: ' معرض ', contactPhone: ' ٠١١ ٢٣٤ ٥٦٧٨ ' }),
    { companyName: 'مؤسسة النخبة للتوزيع', crNumber: '1010123456', contactPhone: '011 234 5678', how: 'visit', city: 'جدة', note: 'معرض' },
  );
});

const baseProfile: ProfileForm = { city: 'الرياض', marketingConsent: false, vatNumber: '' };

test('جسم PUT /me بالحقول المتغيّرة فقط — بلا حقول «موثوق»', () => {
  assert.deepEqual(buildProfileBody(baseProfile, baseProfile), {});
  assert.deepEqual(buildProfileBody({ ...baseProfile, city: 'جدة' }, baseProfile), { city: 'جدة' });
  assert.deepEqual(buildProfileBody({ ...baseProfile, marketingConsent: true }, baseProfile), { marketingConsent: true });
  assert.deepEqual(buildProfileBody({ ...baseProfile, vatNumber: '300000000000003' }, baseProfile), { vatNumber: '300000000000003' });
  assert.deepEqual(buildProfileBody(baseProfile, { ...baseProfile, vatNumber: '300000000000003' }), { vatNumber: '' }, 'المسح صريح');
  assert.deepEqual(Object.keys(baseProfile).sort(), ['city', 'marketingConsent', 'vatNumber']);
});

test('تحقق الملف: المدينة والرقم الضريبي فقط', () => {
  assert.equal(profileError(baseProfile), null);
  assert.equal(key(profileError({ ...baseProfile, vatNumber: '12' })), 'val.vat');
  assert.equal(profileError({ ...baseProfile, vatNumber: '300000000000003', marketingConsent: true }), null);
});

test('تحقق الاستلام', () => {
  assert.equal(payoutError('SA0380000000608010167519', 'سارة أحمد', ''), null);
  assert.equal(key(payoutError('SA0380000000608010167518', 'سارة أحمد', '')), 'val.iban');
  assert.equal(key(payoutError('SA0380000000608010167519', 'س', '')), 'val.holder');
  assert.equal(key(payoutError('SA0380000000608010167519', 'سارة أحمد', 'x'.repeat(81))), 'val.bank');
});

test('رسائل التحقّق مفاتيح في القاموس — ولا نصّ عربي معروض في وحدة التحقّق', () => {
  const samples = [
    registerError({ ...EMPTY_REGISTER }), claimError({ ...EMPTY_CLAIM }), profileError({ ...baseProfile, city: 'م'.repeat(61) }),
    payoutError('', '', ''),
  ];
  for (const r of samples) {
    assert.ok(r && r.key in AX_DICT, `مفتاح غير موجود في القاموس: ${r?.key}`);
  }
  // الترجمة تملأ المتغيّرات بكل اللغات
  const city = profileError({ ...baseProfile, city: 'م'.repeat(61) })!;
  assert.equal(translate('ar', city.key, city.vars), 'اسم المدينة 60 حرفاً كحدّ أقصى');
  assert.equal(translate('en', city.key, city.vars), 'City name can be at most 60 characters');

  // مصدر الوحدة: لا سلاسل عربية إلا كلمتا الاستبدال الداخليتان في كاشف الاتصال (مرآة الخادم، لا تُعرض)
  const src = readFileSync(new URL('./validation.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const arabicLiterals = [...src.matchAll(/'([^'\n]*[\u0600-\u06FF][^'\n]*)'/g)].map((x) => x[1])
    .filter((x) => !/^[٠-٩۰-۹]+$/.test(x));
  assert.deepEqual(arabicLiterals.sort(), [' تاريخ ', ' وقت '], `نصوص عربية في validation.ts: ${arabicLiterals.join(' | ')}`);
});

test('المدينة 60 حرفاً كحدّ أقصى في التسجيل والترشيح والملف — مطابق للخادم', () => {
  assert.equal(CITY_MAX, 60);
  const city60 = 'م'.repeat(60);
  const city61 = 'م'.repeat(61);
  const tooLong = { key: 'val.cityTooLong', vars: { max: 60 } };
  assert.equal(registerError({ ...validRegister(), city: city60 }), null);
  assert.deepEqual(registerError({ ...validRegister(), city: city61 }), tooLong);
  assert.equal(claimError({ ...validClaim(), city: city60 }), null);
  assert.deepEqual(claimError({ ...validClaim(), city: city61 }), tooLong);
  assert.equal(profileError({ ...baseProfile, city: city60 }), null);
  assert.deepEqual(profileError({ ...baseProfile, city: city61 }), tooLong);
  const claims = readFileSync(new URL('./screens/ClaimsScreen.tsx', import.meta.url), 'utf8');
  const phoneInput = claims.match(/value=\{form\.contactPhone\}[^\n]*/);
  assert.ok(phoneInput, 'خانة رقم التواصل غير موجودة');
  assert.match(claims, /<Field label=\{t\('claims\.contactPhone'\)\} required hint=\{t\('claims\.contactPhoneHint'\)\}>/);
  assert.match(claims, /type="tel" dir="ltr" inputMode="tel"/);
  assert.match(phoneInput![0], /maxLength=\{CONTACT_PHONE_MAX\}/);
  assert.doesNotMatch(claims, /containsContactInfo\(form\.contactPhone\)/, 'الكاشف لا يُطبَّق على خانة رقم التواصل');
  assert.match(claims, /c\.contactPhone && \(/, 'رقم التواصل لا يُعرض في «ترشيحاتي»');
  for (const f of ['screens/AuthScreens.tsx', 'screens/ClaimsScreen.tsx', 'screens/ProfileScreen.tsx']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    const inputs = src.match(/value=\{form\.city\}[^\n]*/g) ?? [];
    assert.ok(inputs.length > 0, `${f}: حقل المدينة غير موجود`);
    for (const i of inputs) assert.match(i, /maxLength=\{CITY_MAX\}/, `${f}: حقل المدينة بلا maxLength={CITY_MAX}`);
  }
});

test('جوال السفير من أيّ دولة: مفتاح الدولة + الرقم، والسعوديّ كما كان', () => {
  const base = validRegister();
  assert.equal(registerError({ ...base, phoneCountry: 'AE', phone: '050 123 4567' }), null, 'الإمارات بصفرٍ محلّي');
  assert.equal(buildRegisterBody({ ...base, phoneCountry: 'AE', phone: '0501234567' }, 'v').phone, '+971501234567');
  assert.equal(buildRegisterBody({ ...base, phoneCountry: 'EG', phone: '1012345678' }, 'v').phone, '+201012345678');
  assert.equal(buildRegisterBody({ ...base, phoneCountry: 'SA', phone: '0551234567' }, 'v').phone, '966551234567', 'السعوديّ بصيغته');
  assert.equal(key(registerError({ ...base, phoneCountry: 'SA', phone: '0112345678' })), 'val.phone', 'ثابتٌ سعوديّ ليس جوالاً');
  assert.equal(key(registerError({ ...base, phoneCountry: 'AE', phone: '12' })), 'val.phone');
  assert.equal(composeAffiliatePhone('ZZ', '551234567'), '+966551234567', 'مفتاحٌ مجهول ⇒ السعودية');
  assert.equal(normAffiliatePhone('971501234567'), null, 'بلا مفتاح دولة لا يُخمَّن');
});

test('جوال السفير: نسخة الواجهة تطابق الخادم على جدولٍ مشترك', async (t) => {
  const url = new URL('../../../backend/src/services/affiliate/rules.ts', import.meta.url);
  let server: { normAffiliatePhone: (v: unknown) => string | null } | null = null;
  try {
    readFileSync(url);
    server = await import(url.href);
  } catch {
    t.skip('مصدر الخادم غير متاح في هذا الفحص');
    return;
  }
  const table = ['0551234567', '+966 55 123 4567', '00966551234567', '٠٥٥١٢٣٤٥٦٧', '+971 50 123 4567', '0020 101 234 5678',
    '+1 (555) 123-4567', '＋９７１５０１２３４５６７', '', '12345', '971501234567', '+966 11 234 5678', '+0971501234567', '+12345',
    '+1234567890123456', 'abc'];
  for (const v of table) assert.equal(normAffiliatePhone(v), server!.normAffiliatePhone(v), v);
});
