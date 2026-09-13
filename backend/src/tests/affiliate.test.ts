import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commissionHalalas, eligibleAt, paymentWithinAttribution,
  generateCode, parseRef, CODE_ALPHABET, CODE_LENGTH,
  normEmail, normPhoneSA, normCR, normCompanyName, containsContactInfo, normIbanSA,
  attributionFlags, isDisputedByFlags, canTransition, canApproveCommission, payoutTotals,
  commissionAfterRefund, clawbackDelta, normContactPhone,
} from '../services/affiliate/rules';

/**
 * قواعد برنامج «سفير فيلد سيلز» — تُشغَّل لا تُقرأ.
 * القرارات الحاكمة في docs/affiliate/CONTRACT.md §0.
 */

// ───────────── المال ─────────────

test('٣٠٪ من الدفعة الأولى شاملةً الضريبة — بالهللات', () => {
  assert.equal(commissionHalalas(29900, 3000), 8970, '٢٩٩ ⇒ ٨٩٫٧٠');
  assert.equal(commissionHalalas(39900, 3000), 11970);
  assert.equal(commissionHalalas(59900, 3000), 17970);
  // اشتراكٌ سنويّ مقدّم: على كامل الدفعة (قرار المالك)
  assert.equal(commissionHalalas(29900 * 12, 3000), 107640, '٣٥٨٨ ⇒ ١٠٧٦٫٤٠');
});

test('التقريب نصفٌ لأعلى بلا فاصلة عائمة', () => {
  assert.equal(commissionHalalas(39999, 3000), 12000, '١١٩٩٩٫٧ ⇒ ١٢٠٠٠');
  assert.equal(commissionHalalas(5, 3000), 2, '١٫٥ ⇒ ٢');
  assert.equal(commissionHalalas(3, 3000), 1, '٠٫٩ ⇒ ١');
  assert.equal(commissionHalalas(1, 3000), 0, '٠٫٣ ⇒ ٠');
});

test('لا عمولة على الصفر والسالب والتالف', () => {
  assert.equal(commissionHalalas(0, 3000), 0);
  assert.equal(commissionHalalas(-100, 3000), 0);
  assert.equal(commissionHalalas(NaN, 3000), 0);
  assert.equal(commissionHalalas(29900, 0), 0);
});

test('تاريخ الاستحقاق = الدفع + أيّام الحجز', () => {
  const paid = new Date('2026-09-13T10:00:00Z');
  assert.equal(eligibleAt(paid, 30).toISOString(), '2026-10-13T10:00:00.000Z');
  assert.equal(eligibleAt(paid, 0).toISOString(), paid.toISOString());
  assert.equal(eligibleAt(paid, -5).toISOString(), paid.toISOString(), 'السالب لا يُرجع التاريخ للوراء');
});

test('الدفعة داخل نافذة الإسناد فقط', () => {
  const a = { effectiveFrom: new Date('2026-09-01T00:00:00Z'), firstPaymentDeadline: new Date('2027-02-28T00:00:00Z') };
  assert.equal(paymentWithinAttribution(new Date('2026-09-10T00:00:00Z'), a), true);
  assert.equal(paymentWithinAttribution(new Date('2026-08-31T23:59:59Z'), a), false, 'دفعةٌ قبل الإسناد لا تُحتسب');
  assert.equal(paymentWithinAttribution(new Date('2027-03-01T00:00:00Z'), a), false, 'تجربةٌ نامت ثمّ عادت بعد المهلة');
});

// ───────────── الرموز ─────────────

test('الرمز المولَّد بصيغته وبلا أحرفٍ متشابهة', () => {
  for (let i = 0; i < 200; i++) {
    const c = generateCode();
    assert.equal(c.length, CODE_LENGTH);
    for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch), `حرف خارج الأبجدية: ${ch}`);
    assert.doesNotMatch(c, /[01OIL]/, 'حرف متشابه');
  }
});

test('قراءة الرمز متسامحة ولا ترمي أبداً', () => {
  assert.equal(parseRef('ab2c-3d4e'), 'AB2C3D4E');
  assert.equal(parseRef('  AB2C 3D4E  '), 'AB2C3D4E');
  // المُدخلات التي كانت ستُفشل التسجيل كلّه في التصميم الأوّل
  for (const bad of ['', 'none', 'لا يوجد', '0551234567', 'AB0C3D4E', 'ABCDEFG', 'ABCDEFGHJ', null, undefined, 42, {}]) {
    assert.equal(parseRef(bad as unknown), null, `يجب أن يُهمَل: ${String(bad)}`);
  }
  // لا تصحيح تخمينيّ: O مكان 0 قد يمنح عمولةً لمسوّقٍ آخر
  assert.equal(parseRef('AB2C3D4O'), null);
});

// ───────────── التطبيع ─────────────

test('تطبيع البريد والجوال والسجل', () => {
  assert.equal(normEmail('  Ali@Example.COM '), 'ali@example.com');
  for (const p of ['0551234567', '551234567', '+966551234567', '00966551234567', '٠٥٥١٢٣٤٥٦٧', '055 123 4567']) {
    assert.equal(normPhoneSA(p), '966551234567', p);
  }
  assert.equal(normPhoneSA('0112345678'), null, 'هاتفٌ ثابت ليس جوالاً');
  assert.equal(normPhoneSA('12345'), null);
  assert.equal(normCR('1010-123-456'), '1010123456');
  assert.equal(normCR('١٠١٠١٢٣٤٥٦'), '1010123456');
  assert.equal(normCR('101012345'), null);
});

test('اسم المنشأة المُطبَّع يطابق صيغها المختلفة', () => {
  const a = normCompanyName('مؤسسة مكسرات وشاهي للتجارة');
  const b = normCompanyName('مكسرات و شاهي');
  assert.equal(a, normCompanyName('مؤسسه مكسرات وشاهى للتجاره'));
  assert.ok(a.includes('مكسرات'));
  assert.notEqual(a, '');
  assert.ok(b.length > 0);
});

test('الملاحظة الحرّة ترفض بيانات الاتصال', () => {
  assert.equal(containsContactInfo('كلمت أبو فهد 0551234567'), true);
  assert.equal(containsContactInfo('كلمت أبو فهد ٠٥٥١٢٣٤٥٦٧'), true);
  assert.equal(containsContactInfo('راسلته على x@y.com'), true);
  assert.equal(containsContactInfo('زرتهم في معرض الرياض ٢٠٢٦'), false, 'سنة ليست جوالاً');
  assert.equal(containsContactInfo('معرفة قديمة'), false);
  assert.equal(containsContactInfo(''), false);
});

test('الآيبان السعودي: الصيغة وفحص mod-97', () => {
  // آيبان صالح معروف (مثال البنك المركزي في الأدلّة العامة)
  assert.equal(normIbanSA('SA03 8000 0000 6080 1016 7519'), 'SA0380000000608010167519');
  assert.equal(normIbanSA('sa0380000000608010167519'), 'SA0380000000608010167519');
  assert.equal(normIbanSA('SA0380000000608010167518'), null, 'رقم تحقّق خاطئ');
  assert.equal(normIbanSA('AE070331234567890123456'), null, 'ليس سعودياً');
  assert.equal(normIbanSA('SA03800000006080101675'), null, 'قصير');
});

// ───────────── الإشارات ─────────────

test('إشارات الإحالة الذاتية والعميل العائد', () => {
  const base = {
    affiliateEmail: 'marketer@mail.com', affiliatePhone: '0551111111',
    adminEmail: 'owner@company.sa', companyPhone: '0552222222', existingCompanyPhones: [],
  };
  assert.deepEqual(attributionFlags(base), []);
  assert.deepEqual(attributionFlags({ ...base, adminEmail: 'MARKETER@mail.com' }), ['self_email']);
  assert.deepEqual(attributionFlags({ ...base, companyPhone: '+966551111111' }), ['self_phone']);
  assert.deepEqual(attributionFlags({ ...base, existingCompanyPhones: ['966552222222'] }), ['returning_company']);
  assert.equal(isDisputedByFlags(['returning_company']), true, 'العميل العائد ليس عميلاً جديداً');
  assert.equal(isDisputedByFlags(['self_email']), false, 'إحالة المنشأة التي يعمل فيها السفير مسموحة (الشروط v2)');
  assert.equal(isDisputedByFlags(['self_phone']), false);
  assert.equal(isDisputedByFlags(['ip_match']), false, 'تطابق الشبكة وحده لا يوقف الإسناد');
  assert.equal(isDisputedByFlags([]), false);
});

// ───────────── الانتقالات ─────────────

test('انتقالات الحالات المسموحة وحدها', () => {
  assert.equal(canTransition('commission', 'pending', 'approved'), true);
  assert.equal(canTransition('commission', 'paid', 'reversed'), false, 'المدفوع لا يُعكس — يُقيَّد سالباً');
  assert.equal(canTransition('commission', 'declined', 'pending'), false);
  assert.equal(canTransition('attribution', 'void', 'active'), true, 'خطأ المالك قابل للتصحيح');
  assert.equal(canTransition('payout', 'recorded', 'void'), false, 'التحويل المسجَّل لا يُلغى');
  assert.equal(canTransition('user', 'pending_email', 'approved'), false, 'لا قبول بلا بريدٍ مؤكَّد');
  assert.equal(canTransition('nope', 'a', 'b'), false);
});

test('اعتماد العمولة بعد الحجز وبدفعةٍ ما زالت مؤكَّدة', () => {
  const c = { status: 'pending', eligibleAt: new Date('2026-10-13T00:00:00Z') };
  const before = new Date('2026-10-12T00:00:00Z');
  const after = new Date('2026-10-14T00:00:00Z');
  assert.deepEqual(canApproveCommission(c, 'paid', after), { ok: true });
  assert.deepEqual(canApproveCommission(c, 'paid', before), { ok: false, reason: 'hold_not_over' });
  assert.deepEqual(canApproveCommission(c, 'refunded', after), { ok: false, reason: 'payment_not_paid' });
  assert.deepEqual(canApproveCommission({ ...c, status: 'on_hold' }, 'paid', after), { ok: false, reason: 'not_pending' });
});

// ───────────── الصرف ─────────────

test('الصافي لا يكون سالباً ولا دون الحدّ الأدنى', () => {
  assert.deepEqual(payoutTotals([{ commissionHalalas: 8970 }, { commissionHalalas: 11970 }], [], 10000),
    { commissionsHalalas: 20940, adjustmentsHalalas: 0, netHalalas: 20940, eligible: true });
  // عمولةٌ دون الحدّ الأدنى تنتظر
  assert.equal(payoutTotals([{ commissionHalalas: 8970 }], [], 10000).eligible, false);
  // استردادٌ أكبر من العمولات: لا دفعة، والقيد ينتظر
  const r = payoutTotals([{ commissionHalalas: 8970 }], [{ amountHalalas: -17970 }], 0);
  assert.equal(r.netHalalas, -9000);
  assert.equal(r.eligible, false);
  assert.equal(payoutTotals([], [], 0).eligible, false, 'لا دفعة صفريّة');
});

// ───────────── حرّاس الوصل ─────────────

import fs from 'node:fs';
import path from 'node:path';
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('ملف الاختبار مُدرجٌ في npm test — وإلا لم يُشغَّل شيءٌ ممّا أعلاه', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: { test: string } };
  assert.match(pkg.scripts.test, /src\/tests\/affiliate\.test\.ts/);
});

// ───────────── التشفير والمصادقة (بلا قاعدة بيانات) ─────────────

import jwt from 'jsonwebtoken';
import {
  signSession, verifySession, signPurpose, verifyPurpose, hashPassword, verifyPassword,
  encryptIban, decryptIban, riyadhDay, escapeHtml, referralLink,
  DEFAULT_SETTINGS, DEFAULT_TERMS_BODY, DEFAULT_TERMS_VERSION, parseTermsRules, pickRules,
} from '../services/affiliate/core';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-affiliate';
delete process.env.AFFILIATE_JWT_SECRET;
delete process.env.AFFILIATE_IBAN_KEY;

test('توكن الشركة لا يُفتح في البوابة، ورمز الغرض لا يصلح جلسة', () => {
  const s = signSession('u1', 3);
  assert.deepEqual(verifySession(s), { uid: 'u1', kind: 'affiliate', tv: 3 });
  // توكن لوحة الشركة موقَّع بالسرّ الأصلي — ولو حمل حقول السفير نفسها
  const company = jwt.sign({ id: 'u1', role: 'ADMIN', uid: 'u1', kind: 'affiliate', tv: 3 }, process.env.JWT_SECRET!);
  assert.equal(verifySession(company), null, 'السرّ المشتقّ يعزل الفضاءين');
  assert.throws(() => jwt.verify(s, process.env.JWT_SECRET!), 'وتوكن السفير لا يُفتح بسرّ الشركة');
  const reset = signPurpose('ax-reset', 'u1', 3, '1h');
  assert.equal(verifySession(reset), null, 'رابط الاستعادة ليس جلسة');
  assert.equal(verifyPurpose('ax-verify', reset), null, 'رابط الاستعادة لا يؤكّد بريداً');
  assert.deepEqual(verifyPurpose('ax-reset', reset), { uid: 'u1', tv: 3 });
  assert.equal(verifyPurpose('ax-reset', s), null, 'الجلسة لا تصلح رابط استعادة');
});

test('كلمة المرور: scrypt، ولا نجاح بلا حسابٍ مخزَّن', () => {
  const h = hashPassword('Secret#123');
  assert.match(h, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(verifyPassword('Secret#123', h), true);
  assert.equal(verifyPassword('Secret#124', h), false);
  assert.equal(verifyPassword('anything', null), false, 'الحساب غير الموجود يستهلك الزمن ويفشل');
  assert.equal(verifyPassword('anything', 'broken'), false);
});

test('الآيبان مشفَّر ومصادَق: العبث يُرفض', () => {
  const enc = encryptIban('SA0380000000608010167519');
  assert.doesNotMatch(enc, /SA03/);
  assert.equal(decryptIban(enc), 'SA0380000000608010167519');
  assert.notEqual(encryptIban('SA0380000000608010167519'), enc, 'متّجه ابتدائي عشوائي');
  const [iv, tag, c] = enc.split(':');
  const flipped = c.slice(0, -1) + (c.endsWith('0') ? '1' : '0');
  assert.equal(decryptIban(`${iv}:${tag}:${flipped}`), null);
  assert.equal(decryptIban('garbage'), null);
});

test('يوم الرياض والتهريب والرابط', () => {
  assert.equal(riyadhDay(new Date('2026-09-13T21:30:00Z')), '2026-09-14', 'بعد منتصف الليل بالرياض');
  assert.equal(riyadhDay(new Date('2026-09-13T20:59:59Z')), '2026-09-13');
  // تاريخٌ يُخزَّن منتصف ليل الرياض يعود بيومه لا باليوم السابق
  assert.equal(riyadhDay(new Date('2026-12-31T00:00:00+03:00')), '2026-12-31');
  assert.equal(escapeHtml(`<img src=x onerror="a">&'`), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  assert.match(referralLink('AB2C3D4E'), /\/\?ref=AB2C3D4E$/);
});

test('نصّ الشروط المدمج يطابق الإعدادات الافتراضية — تغيير أحدهما بلا الآخر يُفشل', () => {
  const toAr = (n: number) => String(n).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[+d]);
  assert.equal(DEFAULT_SETTINGS.currentTermsVersion, DEFAULT_TERMS_VERSION);
  assert.ok(DEFAULT_TERMS_BODY.includes(DEFAULT_TERMS_VERSION));
  assert.ok(DEFAULT_TERMS_BODY.includes(`${toAr(DEFAULT_SETTINGS.rateBps / 100)}٪ من أوّل دفعة مؤكَّدة`));
  assert.ok(!DEFAULT_TERMS_BODY.includes('**'), 'الشروط نصٌّ عاديّ يُعرض مُهرَّباً — نجمتا Markdown تظهران حرفياً فيما يقبله السفير');
  assert.ok(DEFAULT_TERMS_BODY.includes('شاملاً ضريبة القيمة المضافة'));
  assert.ok(DEFAULT_TERMS_BODY.includes(`خلال ${toAr(DEFAULT_SETTINGS.firstPaymentWithinDays)} يوماً`));
  assert.ok(DEFAULT_TERMS_BODY.includes(`متصفّح الزائر ${toAr(DEFAULT_SETTINGS.refWindowDays)} يوماً`));
  assert.ok(DEFAULT_TERMS_BODY.includes(`لك ${toAr(DEFAULT_SETTINGS.claimLockDays)} يوماً`));
  assert.ok(DEFAULT_TERMS_BODY.includes(`معلّقة ${toAr(DEFAULT_SETTINGS.holdDays)} يوماً`));
  assert.ok(DEFAULT_TERMS_BODY.includes(`${toAr(DEFAULT_SETTINGS.minPayoutHalalas / 100)} ريال`));
  assert.ok(DEFAULT_TERMS_BODY.includes('موثوق') && DEFAULT_TERMS_BODY.includes('«إعلان»'));
});

// ───────────── حرّاس الوصل: مصدر الحقيقة والخطافات والعزل ─────────────

const src = (...p: string[]) => read('src', ...p);

test('الدفتر يقرأ حقيقة الدفع من payment_links وحدها — لا الباقة ولا تاريخ الانتهاء', () => {
  const ledger = src('services', 'affiliate', 'ledger.ts');
  const code = ledger.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const leak = code.match(/\.plan\b|subscriptionEndsAt|isActive|mrr/i);
  assert.equal(leak?.[0] ?? null, null, 'درس MRR 1197: الباقة ليست دفعاً');
  assert.match(ledger, /status !== 'paid'/);
  assert.match(ledger, /paidAt: \{ not: null, lt: paidAt \}/, 'أوّل دفعةٍ للشركة على الإطلاق');
  assert.match(ledger, /commissionAfterRefund\(link\.amountHalalas, link\.refundedHalalas, a\.rateBps\)/, 'على كامل مبلغ الدفعة الشامل ناقصاً المستردّ، وبنسبة لقطة الإسناد');
});

test('خطافات الدفع: العمولة بعد القلب إلى paid والعكس بعد القلب عنه — وكلاهما خارج المعاملة', () => {
  const pay = src('routes', 'payments.ts');
  const settle = pay.slice(pay.indexOf('async function settleFromMoyasar'), pay.indexOf('/** حالات ميسر'));
  assert.match(settle, /return won\.count === 1;\s*\}\);/, 'القلب يُعيد نتيجته من المعاملة');
  assert.match(settle, /if \(flipped\) void accrueForPayment\(link\.id\);/);
  assert.ok(settle.indexOf('accrueForPayment') > settle.indexOf('$transaction'), 'بعد المعاملة لا داخلها');
  const reverse = pay.slice(pay.indexOf('async function reversePayment'), pay.indexOf('// انشاء رابط دفع'));
  assert.match(reverse, /if \(flippedBack\.count === 1\) void reverseForPayment\(link\.id\);/);
  const linkTenant = pay.slice(pay.indexOf("router.post('/:id/link-tenant'"));
  assert.match(linkTenant, /authenticate, requireSuperAdmin/);
  assert.match(linkTenant, /status: 'paid', tenantId: null/, 'يُربط اليتيم المدفوع وحده، لا نقلٌ بين شركات');
});

test('التسجيل: رمز الإحالة متسامح ولا يُفشل تسجيل شركة، والإسناد بعد الالتزام', () => {
  const auth = src('routes', 'auth.ts');
  const schema = auth.slice(auth.indexOf('const signupSchema'), auth.indexOf('const TRIAL_DAYS'));
  assert.match(schema, /ref: z\.unknown\(\)\.optional\(\)/);
  assert.doesNotMatch(schema, /ref: z\.string\(\)/, 'regex أو طولٌ على الرمز كان يُفشل التسجيل');
  const signup = auth.slice(auth.indexOf("router.post('/signup'"), auth.indexOf("router.post('/verify-email'"));
  assert.ok(signup.indexOf('attachSignupAttribution') > signup.indexOf('return { tenant, admin };'), 'بعد المعاملة');
  const txBody = signup.slice(signup.indexOf('$transaction'), signup.indexOf('return { tenant, admin };'));
  assert.doesNotMatch(txBody, /attachSignupAttribution/, 'خطأٌ داخل معاملة Postgres يُسقط التسجيل كلّه');
  const ledger = src('services', 'affiliate', 'ledger.ts');
  const attach = ledger.slice(ledger.indexOf('export async function attachSignupAttribution'), ledger.indexOf('export type AccrueResult'));
  assert.match(attach, /\{\n\s*try \{/);
  const tail = attach.slice(attach.lastIndexOf('} catch (e) {'));
  assert.doesNotMatch(tail, /throw/, 'لا يرمي أبداً');
});

test('التركيب: البوابة بمصادقتها الخاصة، ولوحة المالك خلف SUPER_ADMIN', () => {
  const index = src('index.ts');
  assert.match(index, /app\.use\('\/api\/affiliate', affiliateRouter\)/);
  assert.match(index, /app\.use\('\/api\/affiliate-admin', affiliateAdminRouter\)/);
  assert.ok(index.indexOf("app.use('/api/affiliate'") > index.indexOf("app.use('/api', apiLimiter)"), 'خلف المحدِّد العام');
  const admin = src('routes', 'affiliateAdmin.ts');
  assert.match(admin, /router\.use\(authenticate, requireSuperAdmin\);/);
  assert.ok(admin.indexOf('router.use(authenticate, requireSuperAdmin)') < admin.indexOf("router.get('/overview'"), 'قبل أوّل مسار');
  const portal = src('routes', 'affiliate.ts');
  assert.doesNotMatch(portal, /middleware\/auth/, 'لا مصادقة الشركة في البوابة');
  assert.doesNotMatch(portal, /authLimiter|signupLimiter/, 'محدِّدات مستقلّة لا عدّادات مشتركة مع دخول الشركات');
  assert.doesNotMatch(portal, /req\.(body|params|query)\.affiliateId/, 'معرّف السفير من التوكن وحده');
  let scoped = 0;
  for (const m of portal.matchAll(/prisma\.(affiliateCommission|affiliateClaim|tenantAttribution|affiliatePayout|affiliateAdjustment)\.(findMany|findFirst|updateMany|count|aggregate|groupBy)\(\{\s*(?:by: \[[^\]]*\], )?where: \{([^}]*)/g)) {
    scoped++;
    assert.match(m[3], /affiliateId|id: \{ in: payoutIds/, `استعلامٌ بلا قيد السفير: ${m[0].slice(0, 90)}`);
  }
  assert.ok(scoped >= 10, `الحارس لم يلتقط الاستعلامات (${scoped}) — تغيّر شكل الكود`);
});

test('الردود الموحّدة: لا تعداد حسابات في التسجيل والاستعادة', () => {
  const portal = src('routes', 'affiliate.ts');
  for (const route of ['/register', '/forgot', '/resend-verification']) {
    const from = portal.indexOf(`router.post('${route}'`);
    assert.ok(from > 0, route);
    const handler = portal.slice(from, portal.indexOf('\nrouter.', from + 10));
    assert.match(handler, /status\(202\)\.json\(ACCEPTED\)/, route);
    assert.doesNotMatch(handler, /status\(40[49]\)[^\n]*(موجود|مسجّل|مستخدم)/, `${route} يكشف وجود الحساب`);
  }
});

test('الصرف لا يكون سالباً والمنصّة لا تحرّك مالاً', () => {
  const ledger = src('services', 'affiliate', 'ledger.ts');
  assert.match(ledger, /if \(!t\.eligible\) throw new LedgerError/);
  assert.doesNotMatch(ledger + src('routes', 'affiliateAdmin.ts'), /moyasar|createInvoice/i, 'لا تحويل من المنصّة');
});


// ───────────── إصلاحات المراجعتين العدائيتين ─────────────

test('الاسترداد الجزئي يخفّض العمولة بقدره، والتكرار لا يضاعف', () => {
  // اشتراكٌ سنويّ ٧١٧٦ ر.س استُردّ منه ٦٠٠٠: العمولة على ١١٧٦ لا على ٧١٧٦
  assert.equal(commissionAfterRefund(717600, 600000, 3000), 35280);
  assert.equal(commissionAfterRefund(29900, 0, 3000), 8970);
  assert.equal(commissionAfterRefund(29900, 29900, 3000), 0);
  assert.equal(commissionAfterRefund(29900, 99999, 3000), 0, 'المسترد لا يتجاوز الدفعة');
  assert.equal(commissionAfterRefund(29900, -5, 3000), 8970, 'السالب يُهمل');
});

test('قيد الاسترداد يبلغ هدفه بالفرق ولا يتجاوزه أبداً', () => {
  assert.equal(clawbackDelta(0, -8970), -8970);
  assert.equal(clawbackDelta(-3000, -8970), -5970, 'جزئيّ ثمّ كامل: يُخصم الباقي فقط');
  assert.equal(clawbackDelta(-8970, -8970), 0, 'الإشعار المكرَّر');
  assert.equal(clawbackDelta(-8970, -3000), 0, 'لا يُعاد مالٌ خُصم');
  assert.equal(clawbackDelta(0, 500), 0, 'الهدف الموجب ليس استرداداً');
});

test('كاشف بيانات الاتصال: أيّ فاصلٍ غير الحروف، والتاريخ والوقت ليسا جوالاً', () => {
  const rejected = [
    'جوال المدير 055.123.4567', '055/123/4567', '055\\123\\4567', '055_123_4567', '+966 55 123 4567', 'الرياض 0551234567',
    '055،123،4567', '055,123,4567', '055:123:4567', '٠٥٥٫١٢٣٫٤٥٦٧', '055\u200B1234567', '055\u200F123\u200F4567',
    '０５５１２３４５６７', 'ali＠gmail.com', '0551-23-4567',
  ];
  for (const t of rejected) assert.equal(containsContactInfo(t), true, `يجب رفض: ${JSON.stringify(t)}`);
  const accepted = ['معرض الرياض ٢٠٢٦', 'فرع رقم 12', 'الرياض', 'زرتهم 2026-09-13', 'موعدنا 13/09/2026 14:00', 'فرع 12 وفرع 345 وفرع 678', 'لديهم 7 مناديب و3 سيارات'];
  for (const t of accepted) assert.equal(containsContactInfo(t), false, `يجب قبول: ${t}`);
});

test('قواعد الشروط تُقرأ بتسامح، والقيم الشاذّة تعود للاحتياط', () => {
  const d = pickRules(DEFAULT_SETTINGS);
  assert.deepEqual(parseTermsRules(null, d), d);
  assert.deepEqual(parseTermsRules({ rateBps: 2000, holdDays: 60 }, d), { ...d, rateBps: 2000, holdDays: 60 });
  assert.deepEqual(parseTermsRules({ rateBps: 20000, holdDays: -1, refWindowDays: 1.5, claimLockDays: '90' }, d), d);
});

const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const fnBody = (code: string, sig: string) => {
  const i = code.indexOf(sig);
  assert.ok(i >= 0, `لم يُعثر على ${sig}`);
  const next = code.indexOf('\nexport ', i + sig.length);
  return code.slice(i, next < 0 ? undefined : next);
};
const ledgerCode = () => strip(src('services', 'affiliate', 'ledger.ts'));

test('المصالحة مع الدفعة دالّةٌ واحدة: القفل قبل كلّ قراءة، والقيد على من يتحمّله', () => {
  const ledger = ledgerCode();
  const sync = fnBody(ledger, 'async function syncCommissionTx');
  const lock = sync.indexOf('lockCommission(tx, commissionId)');
  assert.ok(lock > 0 && lock < sync.indexOf('affiliateCommission.findUnique'), 'قرارٌ ماليّ على قراءةٍ سبقت القفل');
  assert.ok(sync.indexOf('paymentLink.findUnique') > lock, 'حالة الرابط تُقرأ داخل القفل');
  assert.match(sync, /isCommitted\(c\)/);
  assert.match(sync, /affiliateId: c\.clawbackAffiliateId \?\? c\.affiliateId/, 'بعد نقل إسنادٍ مصروف يتحمّل الجديد الاسترداد');
  assert.match(sync, /deleteMany\(\{ where: \{ commissionId: c\.id, kind: 'clawback_refund', payoutId: null \} \}\)/, 'الثابت: لا قيد استرداد لعمولةٍ غير ملتزَمٍ بها');
  for (const sig of ['export async function reverseForPayment', 'export async function applyPartialRefund']) {
    assert.match(fnBody(ledger, sig), /syncCommission\(/, `${sig} يمرّ من المصالحة الواحدة`);
  }
  assert.doesNotMatch(ledger, /recomputeDraftPayout/, 'تعديل صافي مسودّةٍ قد حُوِّل مبلغها');
  const record = fnBody(ledger, 'export async function recordPayout');
  assert.doesNotMatch(record, /استُردّت|changed/, 'رفض التسجيل بعد أن غادر المال الحساب');
  assert.match(record, /syncCommission\(r\.id/, 'استردادٌ فات خطافه يُقيَّد سالباً بعد التسجيل');
  const voidP = fnBody(ledger, 'export async function voidPayout');
  assert.match(voidP, /"payoutId" = \$\{id\} FOR UPDATE/, 'قفل بنود المسودّة قبل قراءتها');
  assert.match(voidP, /syncCommissionTx\(tx, c\.id/);
  const create = fnBody(ledger, 'export async function createPayout');
  assert.match(create, /"affiliateId" = \$\{affiliateId\} AND status = 'approved' AND "payoutId" IS NULL FOR UPDATE/);
  assert.match(create, /rulesFor\(u\.termsVersion\)/, 'الحدّ الأدنى من الشروط التي قبلها السفير');
  assert.doesNotMatch(create, /!commissions\.length\) throw/, 'تصحيحٌ موجبٌ وحده يُصرف');
});

test('الاسترداد الجزئي يُحفظ على الرابط أوّلاً، وتلتقطه المصالحة والعمولة الجديدة', () => {
  const pay = src('routes', 'payments.ts');
  const reverse = pay.slice(pay.indexOf('async function reversePayment'), pay.indexOf('// انشاء رابط دفع'));
  const partial = reverse.slice(reverse.indexOf('PARTIAL refund'), reverse.indexOf('return { reversed: false, status: link.status };', reverse.indexOf('PARTIAL refund')));
  assert.match(partial, /await prisma\.paymentLink\.updateMany\(\{ where: \{ id: link\.id, refundedHalalas: \{ lt: refunded \} \}, data: \{ refundedHalalas: refunded \} \}\)/);
  assert.ok(partial.indexOf('updateMany') < partial.indexOf('applyPartialRefund'), 'المصدر قبل الخطاف');
  const ledger = ledgerCode();
  const rec = fnBody(ledger, 'export async function reconcile');
  assert.match(rec, /l\.refundedHalalas > r\.refundedHalalas/, 'استردادٌ جزئيّ فات خطافه');
  assert.match(rec, /id: \{ gt: cursor \}/, 'صفحاتٌ بالمفتاح بلا سقفٍ يُهمل الجديد');
  assert.doesNotMatch(rec, /skip: 1/, 'مؤشّرٌ على صفٍّ خرج من المرشِّح يُسقط التالي');
  assert.doesNotMatch(rec, /firstPaymentDeadline: \{ gte/, 'حدٌّ زمنيّ يُسقط عمولةً فاتت نهائياً');
  const accrue = fnBody(ledger, 'export async function accrueForPayment');
  assert.match(accrue, /lockAttribution\(tx, head\.id\)/, 'نقل الإسناد المتزامن لا يُنشئ عمولةً للسابق');
  assert.match(accrue, /calcEligibleAt\(paidAt, a\.holdDays\)/, 'الحجز من لقطة الإسناد');
  assert.match(accrue, /earlier_payment_linked/, 'دفعةٌ أقدم رُبطت بعد نشوء العمولة');
});

test('قرارات المالك: عمولة المسودّة محميّة، والإيقاف اليدويّ يبقى، والنقل لا يُضيّع الأحقّ', () => {
  const ledger = ledgerCode();
  for (const sig of ['export async function holdCommission', 'export async function voidAttribution', 'export async function reassignAttribution', 'export async function linkClaimToTenant']) {
    assert.match(fnBody(ledger, sig), /DRAFT_LOCKED|assertNotInDraft/, `${sig}: عمولة المسودّة`);
  }
  assert.match(fnBody(ledger, 'export async function voidAttribution'), /SYSTEM_HOLDS\.has\(c\.reasonNote\)/, 'إيقاف المالك اليدويّ لا يُكتب فوقه');
  const reassign = fnBody(ledger, 'export async function reassignAttribution');
  assert.ok(reassign.indexOf('lockAttribution(tx, id)') < reassign.indexOf('tenantAttribution.findUnique'), 'قراءة الإسناد داخل القفل');
  assert.match(reassign, /\['pending', 'on_hold', 'approved', 'declined'\]\.includes\(c\.status\)/, 'رفضٌ قُصد به السابق لا يحرم الأحقّ');
  assert.match(reassign, /keepManualHold/, 'النقل لا يرفع إيقاف المالك');
  assert.match(reassign, /sourceRef: `reassign:\$\{n\}:from`[\s\S]*sourceRef: `reassign:\$\{n\}:to`/, 'المصروفة: سالبٌ على السابق وموجبٌ للجديد');
  assert.match(reassign, /clawbackAffiliateId: aff\.id/);
  const link = fnBody(ledger, 'export async function linkClaimToTenant');
  assert.match(link, /effectiveFrom: claim\.submittedAt/, 'بداية الإسناد لحظة تقديم الترشيح');
  assert.match(link, /claim\.status === 'expired' && signedUpInLock/, 'ترشيحٌ انتهى قفله وسجّلت شركته داخله');
  assert.match(link, /conflict: \{ attributionStatus/, 'رسالة التعارض تصف ما حدث فعلاً');
  const attach = fnBody(ledger, 'export async function attachSignupAttribution');
  assert.match(attach, /rules\.refWindowDays \* DAY_MS/, 'صلاحية الرابط من شروط السفير');
  assert.match(attach, /filter\(p => normPhoneSA\(p\) === comp\)/, 'الجوالات تُطبَّع قبل المقارنة');
  assert.match(attach, /flags\.push\('terms_outdated'\)/, 'من لم يقبل الشروط الحالية لا يكسب بالقديمة');
});

test('الإعدادات لا تغيّر قيم الشروط، والنشر يطبّقها مع النصّ', () => {
  const admin = strip(src('routes', 'affiliateAdmin.ts'));
  const put = admin.slice(admin.indexOf("router.put('/settings'"), admin.indexOf("router.get('/terms'"));
  assert.match(put, /terms_bound/);
  assert.doesNotMatch(put, /update: \{ \.\.\.b,/, 'كتابة الجسم كاملاً تمرّر النسبة');
  const post = admin.slice(admin.indexOf("router.post('/terms'"), admin.indexOf('// ─', admin.indexOf("router.post('/terms'")));
  assert.match(post, /rulesJson: rules/);
  assert.match(post, /update: \{ \.\.\.rules, currentTermsVersion: b\.version/);
  for (const path of ["'/attributions/:id/reassign'", "'/attributions/:id/window'"]) assert.ok(admin.includes(path), path);
  const approve = admin.slice(admin.indexOf("router.post('/claims/:id/approve'"), admin.indexOf("router.post('/claims/:id/reject'"));
  assert.match(approve, /rules\.claimLockDays/, 'مدّة القفل من شروط صاحب الترشيح');
});

test('البوابة: الدخول بعدّادٍ ذرّي، والتأكيد بكلمة المرور، ومهلة البريد، والشروط على الخادم', () => {
  const portal = strip(src('routes', 'affiliate.ts'));
  const login = portal.slice(portal.indexOf("router.post('/login'"), portal.indexOf("router.post('/forgot'"));
  assert.doesNotMatch(login, /status\(423\)/);
  assert.equal((login.match(/status\(401\)\.json\(([^)]*)\)/g) ?? []).every(x => x.includes('LOGIN_FAIL')), true, 'رسالةٌ مختلفة = قناة تعداد');
  assert.match(login, /"failedLogins" = "failedLogins" \+ 1[\s\S]*RETURNING "failedLogins"/, 'قراءةٌ ثمّ كتابة تجعل التخمين المتزامن محاولةً واحدة');
  assert.ok(login.indexOf('RETURNING "failedLogins"') < login.indexOf('verifyPassword('), 'المحاولة تُحجز قبل فحص كلمة المرور');
  assert.match(login, /u\?\.id \?\? crypto\.randomUUID\(\)/, 'الكتابة نفسها لبريدٍ غير موجود');
  const verify = portal.slice(portal.indexOf("router.post('/verify-email'"), portal.indexOf("router.post('/resend-verification'"));
  assert.match(verify, /password: z\.string\(\)/);
  assert.match(verify, /password_mismatch/, 'من سجّل ببريد غيره لا يُفعَّل بنقرة صاحب البريد');
  assert.match(verify, /tokenVersion: p\.tv, passwordHash: u\.passwordHash/);
  const reg = portal.slice(portal.indexOf("router.post('/register'"), portal.indexOf('const BAD_VERIFY'));
  assert.match(reg, /where: \{ id: existing\.id, status: 'pending_email' \}/, 'لا كتابة فوق حسابٍ تأكّد للتوّ');
  for (const route of ["router.post('/register'", "router.post('/resend-verification'", "router.post('/forgot'"]) {
    const body = portal.slice(portal.indexOf(route), portal.indexOf('\nrouter.', portal.indexOf(route) + 10));
    assert.match(body, /claimMailSlot\(/, `${route}: مهلة البريد لكلّ عنوان`);
  }
  const reset = portal.slice(portal.indexOf("router.post('/reset'"), portal.indexOf("router.post('/click'"));
  assert.match(reset, /token: signSession\(fresh\.id, fresh\.tokenVersion\)/, 'الاستعادة تُدخل صاحبها رغم القفل');
  assert.match(portal, /code: 'terms_outdated'/, 'قبول الشروط على الخادم لا في الواجهة وحدها');
  const me = portal.slice(portal.indexOf("router.put('/me'"), portal.indexOf("router.post('/accept-terms'"));
  assert.doesNotMatch(me, /mawthooq|publicPromoter:/, 'لا شرط موثوق في الملف (قرار المالك)');
  assert.match(portal, /containsContactInfo\(b\.city\)/);
  assert.doesNotMatch(portal, /mawthooqProblem/, 'لا يُرفض انضمامٌ أو حفظٌ بسبب ترخيص موثوق');
  assert.match(portal, /a\.commission && a\.commission\.affiliateId === aid\(req\)/, 'عمولة سفيرٍ سابق لا تُعرض لغيره');
  const mail = strip(src('services', 'affiliate', 'mail.ts'));
  for (const sig of ['export function mailVerify', 'export function mailReset']) {
    assert.doesNotMatch(fnBody(mail, sig), /escapeHtml\(name\)|\$\{name\}/, `${sig}: نصّ الطالب في بريدٍ رسميٍّ لعنوانٍ لم تثبت ملكيّته`);
  }
});

test('المخطّط: أعمدة المصدر والتحمّل والمهلة', () => {
  const schema = read('prisma', 'schema.prisma');
  const link = schema.slice(schema.indexOf('model PaymentLink {'), schema.indexOf('}', schema.indexOf('model PaymentLink {')));
  assert.match(link, /refundedHalalas\s+Int\s+@default\(0\)/, 'عمودٌ إضافيّ بقيمةٍ افتراضية — db push بلا فقد بيانات');
  assert.match(schema, /clawbackAffiliateId\s+String\?/);
  assert.match(schema, /lastMailAt\s+DateTime\?/);
  assert.match(schema, /holdDays\s+Int\s+@default\(30\)/);
});


// ───────────── المراجعة الثالثة ─────────────

test('الدفعة الأولى فقط: المصالحة تُوقف عمولةً سبقتها دفعةٌ، والاعتماد يرفضها', () => {
  const ledger = ledgerCode();
  const sync = fnBody(ledger, 'async function syncCommissionTx');
  assert.match(sync, /paidAt: \{ not: null, lt: c\.paymentPaidAt \}/, 'فحص الدفعة الأقدم في نقطة كلّ قرارٍ ماليّ');
  assert.match(sync, /return 'held_earlier'/);
  const approve = fnBody(ledger, 'export async function approveCommission');
  assert.match(approve, /'earlier_payment'/, 'لا اعتماد لعمولةٍ ليست على الدفعة الأولى');
  assert.match(approve, /'sync_failed'/, 'فشل المطابقة لا يمرّر الاعتماد');
  const accrue = fnBody(ledger, 'export async function accrueForPayment');
  for (const r of ['earlier_payment_committed', 'earlier_payment_no_commission', 'earlier_payment_linked']) {
    assert.match(accrue, new RegExp(`'${r}'`), `السبب يصف ما حدث فعلاً: ${r}`);
  }
  const voidA = fnBody(ledger, 'export async function voidAttribution');
  assert.ok(voidA.indexOf('lockCommission(tx, a.commission.id)') < voidA.indexOf('affiliateCommission.findUnique'), 'قراءة العمولة بعد قفلها');
  assert.match(voidA, /where: \{ id: c\.id, status: c\.status, payoutId: null \}/);
  const attach = fnBody(ledger, 'export async function attachSignupAttribution');
  assert.match(attach, /flags\.push\('link_expired'\)/, 'رابطٌ تجاوز مدّته يُحسم لا يُهمل بصمت');
  assert.doesNotMatch(attach.slice(0, attach.indexOf('existingCompanyPhones')), /refWindowDays \* DAY_MS\) \{\s*return;/);
});

test('البوابة: محاولات كلمة المرور الصحيحة قبل التأكيد تُردّ، والاستعادة لا تكشف بزمنها، والآيبان يُفتح للمستحقّ', () => {
  const portal = strip(src('routes', 'affiliate.ts'));
  const login = portal.slice(portal.indexOf("router.post('/login'"), portal.indexOf("router.post('/forgot'"));
  assert.match(login, /GREATEST\("failedLogins" - 1, 0\)/);
  const verify = portal.slice(portal.indexOf("router.post('/verify-email'"), portal.indexOf("router.post('/resend-verification'"));
  assert.match(verify, /failedLogins: 0, lockedUntil: null/);
  for (const route of ["router.post('/forgot'", "router.post('/resend-verification'"]) {
    const body = portal.slice(portal.indexOf(route), portal.indexOf('\nrouter.', portal.indexOf(route) + 10));
    assert.match(body, /claimMailSlot\(eligible \? u!\.id : crypto\.randomUUID\(\)\)/, `${route}: الكتابة نفسها في كلّ الفروع`);
  }
  const csp = portal.slice(portal.indexOf('async function canSetPayout'), portal.indexOf('\n}\n', portal.indexOf('async function canSetPayout')));
  assert.match(csp, /amountHalalas: \{ gt: 0 \}/, 'تصحيحٌ موجبٌ وحده يفتح بيانات الاستلام');
  assert.match(portal, /refundedHalalas: c\.refundedHalalas/, 'المسترد ظاهرٌ للسفير');
  assert.match(strip(src('routes', 'affiliateAdmin.ts')), /refundedHalalas: c\.refundedHalalas/, 'والمالك');
});


test('الشروط v2: إحالة المنشأة التي يعمل فيها السفير مسموحة، ونصّ v1 محفوظٌ لمن قبله', async () => {
  const core = await import('../services/affiliate/core');
  assert.equal(core.DEFAULT_TERMS_VERSION, '2026-09-v3');
  assert.deepEqual([...core.BUILTIN_TERMS_VERSIONS], ['2026-09-v1', '2026-09-v2', '2026-09-v3']);
  for (const v of ['2026-09-v2', '2026-09-v3']) {
    const body = core.builtinTermsBody(v) ?? '';
    assert.ok(body.includes(`الإصدار ${v}`), `ترويسة ${v}`);
    assert.ok(body.includes('يجوز لك إحالة المنشأة التي تعمل فيها أو تملكها أو تديرها'), v);
    assert.ok(!body.includes('إحالةٌ ذاتية لا تستحقّ عمولة'), v);
    assert.ok(body.includes('لا عمولة على شركةٍ كانت عميلاً لفيلد سيلز قبل إحالتك'), `قاعدة العميل الجديد باقية: ${v}`);
  }
  assert.equal(core.builtinTermsBody('2026-09-v3'), core.DEFAULT_TERMS_BODY);
  assert.ok(core.DEFAULT_TERMS_BODY.includes('ورقم التواصل معها'), 'v3: الترشيح يحمل رقم التواصل');
  assert.ok(!core.DEFAULT_TERMS_BODY.includes('لا تُرسل لنا بيانات أشخاص'), 'v3 لا يناقض الخانة الإلزامية');
  assert.ok((core.builtinTermsBody('2026-09-v2') ?? '').includes('لا تُرسل لنا بيانات أشخاص'), 'نصّ v2 كما قُبل');
  const v1 = core.builtinTermsBody('2026-09-v1') ?? '';
  assert.ok(v1.includes('الإصدار 2026-09-v1') && v1.includes('إحالةٌ ذاتية لا تستحقّ عمولة'), 'النصّ الذي قُبل لا يُعاد كتابته');
  const portal = strip(src('routes', 'affiliate.ts'));
  assert.doesNotMatch(portal, /noSelfReferral: z\.literal/, 'الإقرار الرابع لا يُشترط');
});


test('بلا قيود على السفير: لا إقرارات مشروطة ولا ترخيص موثوق عند الانضمام', () => {
  const portal = strip(src('routes', 'affiliate.ts'));
  const schema = portal.slice(portal.indexOf('const registerSchema'), portal.indexOf('});', portal.indexOf('const registerSchema')));
  assert.match(schema, /declarations: z\.record\(z\.boolean\(\)\)\.optional\(\)/, 'الإقرارات لا تُشترط');
  assert.match(schema, /publicPromoter: z\.boolean\(\)\.optional\(\)/);
  assert.doesNotMatch(schema, /z\.literal\(true\)\s*,\s*noSpam|independent: z\.literal/, 'لا إقرار إلزامي');
  assert.match(schema, /acceptTerms: z\.literal\(true\)/, 'قبول الشروط وحده باقٍ');
  const reg = portal.slice(portal.indexOf("router.post('/register'"), portal.indexOf('const BAD_VERIFY'));
  assert.match(reg, /publicPromoter: false, mawthooqNo: null, mawthooqExpiry: null/);
});


test('رقم التواصل في الترشيح: إلزاميّ، جوالٌ سعوديّ مُطبَّع أو رقمٌ من ٨–١٥ خانة', () => {
  for (const p of ['0551234567', '+966 55 123 4567', '٠٥٥١٢٣٤٥٦٧', '(055) 123-4567']) assert.equal(normContactPhone(p), '966551234567', p);
  assert.equal(normContactPhone('011 234 5678'), '0112345678', 'هاتف ثابت');
  assert.equal(normContactPhone('920012345'), '920012345', 'الرقم الموحّد');
  assert.equal(normContactPhone('+971 50 123 4567'), '971501234567', 'دوليّ');
  assert.equal(normContactPhone('０５５１２３４５６７'), '966551234567', 'أرقامٌ عريضة تُطبَّع قبل فحص الجوال');
  for (const bad of ['', '1234567', 'abc', '05512', '1234567890123456', null, 42]) assert.equal(normContactPhone(bad as unknown), null, String(bad));
  const portal = strip(src('routes', 'affiliate.ts'));
  const create = portal.slice(portal.indexOf("router.post('/claims'"), portal.indexOf("router.get('/claims'"));
  assert.match(create, /contactPhone: z\.string\(\)\.max\(30\)/, 'إلزاميّ في الجسم');
  assert.match(create, /normContactPhone\(b\.contactPhone\)/);
  assert.doesNotMatch(create, /containsContactInfo\(b\.contactPhone\)/, 'الكاشف لا يرفض الخانة المخصّصة للرقم');
  assert.match(create, /crNumber: cr, contactPhone,/, 'يُحفظ');
  assert.match(strip(src('routes', 'affiliateAdmin.ts')), /contactPhone: c\.contactPhone/, 'يراه المالك');
  const schema = read('prisma', 'schema.prisma');
  assert.match(schema, /contactPhone\s+String\?/, 'عمودٌ اختياريّ في القاعدة — db push لا يفشل على صفوفٍ قائمة');
});
