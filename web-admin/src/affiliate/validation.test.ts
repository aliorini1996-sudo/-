import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CITY_MAX, containsContactInfo, normPhoneSA, normCR, normVat, normIbanSA, isIsoDate, normMawthooqNo, mawthooqError,
  EMPTY_REGISTER, registerError, buildRegisterBody, type RegisterForm,
  EMPTY_CLAIM, claimError, buildClaimBody, type ClaimForm,
  buildProfileBody, profileError, type ProfileForm, payoutError,
} from './validation';

const TODAY = '2026-09-13';

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

test('ترخيص موثوق', () => {
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-9-1'), false);
  assert.equal(normMawthooqNo(' 123456 '), '123456');
  assert.equal(normMawthooqNo('١٢٣٤٥٦'), '123456');
  assert.equal(normMawthooqNo('12'), null);
  assert.equal(normMawthooqNo('12 34<script>'), null);

  assert.equal(mawthooqError('123456', '2027-01-01', TODAY), null);
  assert.equal(mawthooqError('123456', TODAY, TODAY), null, 'ينتهي اليوم = ما زال سارياً');
  assert.match(mawthooqError('', '2027-01-01', TODAY)!, /رقم/);
  assert.match(mawthooqError('123456', '', TODAY)!, /تاريخ/);
  assert.match(mawthooqError('123456', '2026-09-12', TODAY)!, /منتهٍ/);
  assert.match(mawthooqError('123456', '2026-13-01', TODAY)!, /غير صالح/);
});

const validRegister = (): RegisterForm => ({
  ...EMPTY_REGISTER,
  fullName: 'سارة أحمد',
  email: 'Sara@Example.com ',
  phone: '0551234567',
  password: 'correct-horse',
  acceptTerms: true,
  declarations: { independent: true, noSpam: true, disclose: true, noSelfReferral: true },
});

test('التسجيل: الحقول الإلزامية والإقرارات الأربعة', () => {
  assert.equal(registerError(validRegister(), TODAY), null);
  assert.ok(registerError({ ...validRegister(), fullName: 'س' }, TODAY));
  assert.ok(registerError({ ...validRegister(), email: 'nope' }, TODAY));
  assert.ok(registerError({ ...validRegister(), phone: '12345' }, TODAY));
  assert.ok(registerError({ ...validRegister(), password: '1234567' }, TODAY), 'كلمة المرور ≥ 8');
  assert.equal(registerError({ ...validRegister(), password: '12345678' }, TODAY), null);
  assert.ok(registerError({ ...validRegister(), vatNumber: '123' }, TODAY));
  assert.ok(registerError({ ...validRegister(), acceptTerms: false }, TODAY));
  for (const k of ['independent', 'noSpam', 'disclose', 'noSelfReferral'] as const) {
    const f = validRegister();
    f.declarations = { ...f.declarations, [k]: false };
    assert.ok(registerError(f, TODAY), `الإقرار ${k} إلزامي`);
  }
});

test('التسجيل: الناشر العلني يلزمه موثوق', () => {
  const f = { ...validRegister(), publicPromoter: true };
  assert.ok(registerError(f, TODAY));
  assert.equal(registerError({ ...f, mawthooqNo: '778899', mawthooqExpiry: '2027-06-30' }, TODAY), null);
});

test('جسم التسجيل بالشكل الدقيق في API.md', () => {
  const body = buildRegisterBody(validRegister(), '2026-09-v1');
  assert.deepEqual(body, {
    fullName: 'سارة أحمد',
    email: 'sara@example.com',
    phone: '966551234567',
    password: 'correct-horse',
    publicPromoter: false,
    marketingConsent: false,
    acceptTerms: true,
    termsVersion: '2026-09-v1',
    declarations: { independent: true, noSpam: true, disclose: true, noSelfReferral: true },
  });
  assert.ok(!('mawthooqNo' in body) && !('city' in body) && !('vatNumber' in body), 'الاختيارية الفارغة لا تُرسل');

  const full = buildRegisterBody({
    ...validRegister(), city: ' الرياض ', vatNumber: '300000000000003', marketingConsent: true,
    publicPromoter: true, mawthooqNo: '778899', mawthooqExpiry: '2027-06-30',
  }, 'v2');
  assert.equal(full.city, 'الرياض');
  assert.equal(full.vatNumber, '300000000000003');
  assert.equal(full.mawthooqNo, '778899');
  assert.equal(full.mawthooqExpiry, '2027-06-30');
  assert.equal(full.marketingConsent, true);

  // بيانات موثوق لا تُرسل إن أُطفئ «سأنشر علناً» بعد كتابتها
  const off = buildRegisterBody({ ...validRegister(), publicPromoter: false, mawthooqNo: '778899', mawthooqExpiry: '2027-06-30' }, 'v2');
  assert.ok(!('mawthooqNo' in off) && !('mawthooqExpiry' in off));
});

const validClaim = (): ClaimForm => ({ ...EMPTY_CLAIM, companyName: 'مؤسسة النخبة للتوزيع', crNumber: '١٠١٠١٢٣٤٥٦', how: 'visit' });

test('الترشيح: سجل 10 أرقام وطريقة تعريف وملاحظة بلا بيانات اتصال', () => {
  assert.equal(claimError(validClaim()), null);
  assert.ok(claimError({ ...validClaim(), companyName: 'م' }));
  assert.ok(claimError({ ...validClaim(), crNumber: '123' }));
  assert.ok(claimError({ ...validClaim(), how: '' }));
  assert.ok(claimError({ ...validClaim(), note: 'x'.repeat(201) }));
  assert.equal(claimError({ ...validClaim(), note: 'x'.repeat(200) }), null);
  assert.ok(claimError({ ...validClaim(), note: 'كلّم أبو فهد 0551234567' }));
  assert.ok(claimError({ ...validClaim(), note: 'fahd@mail.com' }));
  assert.ok(claimError({ ...validClaim(), note: 'جواله 055.123.4567' }));
  assert.equal(claimError({ ...validClaim(), note: 'تعرّفنا في معرض الرياض ٢٠٢٦' }), null);
});

test('الترشيح: بيانات الاتصال مرفوضة في الاسم والملاحظة **والمدينة**', () => {
  assert.match(claimError({ ...validClaim(), companyName: 'مؤسسة النخبة 055/123/4567' })!, /اسم المنشأة/);
  assert.match(claimError({ ...validClaim(), city: 'الرياض 0551234567' })!, /المدينة/);
  assert.match(claimError({ ...validClaim(), city: 'jeddah@mail.com' })!, /المدينة/);
  assert.equal(claimError({ ...validClaim(), city: 'الرياض' }), null);
  assert.equal(claimError({ ...validClaim(), city: 'حي 2026' }), null);
});

test('جسم الترشيح', () => {
  assert.deepEqual(buildClaimBody(validClaim()), { companyName: 'مؤسسة النخبة للتوزيع', crNumber: '1010123456', how: 'visit' });
  assert.deepEqual(
    buildClaimBody({ ...validClaim(), city: ' جدة ', note: ' معرض ' }),
    { companyName: 'مؤسسة النخبة للتوزيع', crNumber: '1010123456', how: 'visit', city: 'جدة', note: 'معرض' },
  );
});

const baseProfile: ProfileForm = { city: 'الرياض', marketingConsent: false, publicPromoter: false, mawthooqNo: '', mawthooqExpiry: '', vatNumber: '' };

test('جسم PUT /me بالحقول المتغيّرة فقط', () => {
  assert.deepEqual(buildProfileBody(baseProfile, baseProfile), {});
  assert.deepEqual(buildProfileBody({ ...baseProfile, city: 'جدة' }, baseProfile), { city: 'جدة' });
  assert.deepEqual(buildProfileBody({ ...baseProfile, marketingConsent: true }, baseProfile), { marketingConsent: true });
  assert.deepEqual(
    buildProfileBody({ ...baseProfile, publicPromoter: true, mawthooqNo: '778899', mawthooqExpiry: '2027-06-30' }, baseProfile),
    { publicPromoter: true, mawthooqNo: '778899', mawthooqExpiry: '2027-06-30' },
  );
  const promoter = { ...baseProfile, publicPromoter: true, mawthooqNo: '778899', mawthooqExpiry: '2027-06-30' };
  assert.deepEqual(buildProfileBody({ ...promoter, publicPromoter: false }, promoter), { publicPromoter: false });
  assert.deepEqual(buildProfileBody({ ...baseProfile, vatNumber: '300000000000003' }, baseProfile), { vatNumber: '300000000000003' });
  assert.deepEqual(buildProfileBody(baseProfile, { ...baseProfile, vatNumber: '300000000000003' }), { vatNumber: '' }, 'المسح صريح');
});

test('تحقق الملف: شرط موثوق فقط حين يحمل الجسم publicPromoter أو mawthooqNo أو mawthooqExpiry', () => {
  assert.equal(profileError(baseProfile, baseProfile, TODAY), null);
  assert.ok(profileError({ ...baseProfile, publicPromoter: true }, baseProfile, TODAY), 'تفعيل النشر العلني بلا ترخيص');
  assert.ok(profileError({ ...baseProfile, vatNumber: '12' }, baseProfile, TODAY));

  // ناشر علنيّ ترخيصه انتهى — لا يُمنع من حفظ ما لا يمسّ موثوق
  const expired: ProfileForm = { ...baseProfile, publicPromoter: true, mawthooqNo: '778899', mawthooqExpiry: '2026-09-01' };
  assert.equal(profileError({ ...expired, city: 'جدة' }, expired, TODAY), null, 'المدينة وحدها');
  assert.equal(profileError({ ...expired, marketingConsent: true }, expired, TODAY), null, 'الموافقة التسويقية وحدها');
  assert.equal(profileError({ ...expired, vatNumber: '300000000000003' }, expired, TODAY), null, 'الرقم الضريبي وحده');
  assert.equal(profileError(expired, expired, TODAY), null, 'بلا تغيير');
  // لكن لمس حقول موثوق يُطلق الشرط على القيم الناتجة
  assert.match(profileError({ ...expired, mawthooqNo: '112233' }, expired, TODAY)!, /منتهٍ/, 'تغيير الرقم مع تاريخ منتهٍ');
  assert.equal(profileError({ ...expired, mawthooqExpiry: '2027-09-01' }, expired, TODAY), null, 'تجديد التاريخ');
  assert.equal(profileError({ ...expired, mawthooqExpiry: TODAY }, expired, TODAY), null, 'سارٍ حتى نهاية يوم الانتهاء');
  assert.match(profileError({ ...expired, mawthooqExpiry: '2026-09-12' }, expired, TODAY)!, /منتهٍ/);
  // إطفاء النشر العلني لا يستلزم ترخيصاً
  assert.equal(profileError({ ...expired, publicPromoter: false }, expired, TODAY), null);
});

test('تحقق الاستلام', () => {
  assert.equal(payoutError('SA0380000000608010167519', 'سارة أحمد', ''), null);
  assert.ok(payoutError('SA0380000000608010167518', 'سارة أحمد', ''));
  assert.ok(payoutError('SA0380000000608010167519', 'س', ''));
});

test('المدينة 60 حرفاً كحدّ أقصى في التسجيل والترشيح والملف — مطابق للخادم', () => {
  assert.equal(CITY_MAX, 60);
  const city60 = 'م'.repeat(60);
  const city61 = 'م'.repeat(61);
  assert.equal(registerError({ ...validRegister(), city: city60 }, TODAY), null);
  assert.match(registerError({ ...validRegister(), city: city61 }, TODAY)!, /المدينة/);
  assert.equal(claimError({ ...validClaim(), city: city60 }), null);
  assert.match(claimError({ ...validClaim(), city: city61 })!, /المدينة/);
  assert.equal(profileError({ ...baseProfile, city: city60 }, baseProfile, TODAY), null);
  assert.match(profileError({ ...baseProfile, city: city61 }, baseProfile, TODAY)!, /المدينة/);
  for (const f of ['screens/AuthScreens.tsx', 'screens/ClaimsScreen.tsx', 'screens/ProfileScreen.tsx']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    const inputs = src.match(/value=\{form\.city\}[^\n]*/g) ?? [];
    assert.ok(inputs.length > 0, `${f}: حقل المدينة غير موجود`);
    for (const i of inputs) assert.match(i, /maxLength=\{CITY_MAX\}/, `${f}: حقل المدينة بلا maxLength={CITY_MAX}`);
  }
});
