import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  PENDING_ACTIVATION_PREFIX, newPendingHash, isPendingActivationHash, activationSecret, activationFingerprint,
  signActivationToken, verifyActivationToken, activationUrl, trialEndAfterActivation, maskPhone,
  PHONE_TAKEN_LIMIT, isLockedActivationHash, TRIAL_PERIOD_DAYS, TRIAL_LIMITS, ACTIVATION_RESEND_COOLDOWN_MS, SIGNUP_MAX_RESENDS,
} from '../services/trialCompany';
import { phoneKey } from '../services/phoneKey';
import { isSelfContact, containsLinkLike, isDisputedByFlags, containsContactInfo, normPhoneSA } from '../services/affiliate/rules';
import {
  PORTAL_TRIAL_DAILY_CAP, PORTAL_TRIAL_PENDING_CAP, MAX_RESENDS, RESEND_COOLDOWN_MS, RESEND_WINDOW_DAYS, portalTrialEnabled,
} from '../services/affiliate/portalTrial';

/**
 * «حسابٌ تجريبي يفتحه السفير» — تُشغَّل القواعد ويُحرس الوصل نصّاً، بلا قاعدة بيانات ولا شركة تجريبية.
 * الوعد الحاكم: لا يدخل حساب الشركة إلا مديرها — السفير لا يرى كلمة مرورٍ ولا رابطاً ولا جلسة.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-portal-trial';
delete process.env.COMPANY_ACTIVATION_SECRET;

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const src = (...p: string[]) => read('src', ...p);
/** من التوقيع إلى أوّل سطرٍ يبدأ بـ«}» — نهاية الدالّة في أسلوب هذا المستودع */
const fnBody = (code: string, sig: string) => {
  const i = code.indexOf(sig);
  assert.ok(i >= 0, `لم يُعثر على ${sig}`);
  const end = code.indexOf('\n}\n', i);
  return code.slice(i, end < 0 ? undefined : end + 2);
};
/** معالج مسار: من `router.x('/p'` إلى `\n});` */
const handler = (code: string, sig: string) => {
  const i = code.indexOf(sig);
  assert.ok(i >= 0, `لم يُعثر على ${sig}`);
  return code.slice(i, code.indexOf('\n});', i));
};
const union = (code: string, re: RegExp) => {
  const m = code.match(re);
  assert.ok(m, `لم يُعثر على ${re}`);
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
};

test('ملف الاختبار مُدرجٌ في npm test — وإلا لم يُشغَّل شيءٌ ممّا فيه', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: { test: string } };
  assert.match(pkg.scripts.test, /src\/tests\/portal-trial\.test\.ts/);
});

// ───────────── الحارس «بانتظار التفعيل» ─────────────

test('الحارس: بادئته، وطوله ليس ٦٠ فلا يطابقه bcrypt، وفريدٌ في كلّ مرّة', async () => {
  const a = newPendingHash();
  const b = newPendingHash();
  assert.ok(a.startsWith(PENDING_ACTIVATION_PREFIX));
  assert.equal(a.length, 68);
  assert.notEqual(a.length, 60, 'طول bcrypt — compare كان سيحاول المطابقة');
  assert.notEqual(a, b);
  assert.equal(isPendingActivationHash(a), true);
  assert.equal(isPendingActivationHash(await bcrypt.hash('Secret#123', 4)), false, 'كلمة مرورٍ حقيقية ليست حارساً');
  assert.equal(isPendingActivationHash('$2a$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWX12'), false);
  assert.equal(isPendingActivationHash(null), false);
  // الدخول وتغيير كلمة المرور يمرّان بـcompare: false بلا رمي — فشلٌ عامّ كأيّ كلمة مرورٍ خاطئة
  assert.equal(await bcrypt.compare('x', a), false);
  assert.equal(await bcrypt.compare(a, a), false, 'ولا الحارس نفسه كلمة مرور');
});

// ───────────── رمز التفعيل ─────────────

test('رمز التفعيل: ذهابٌ وإياب، وسرٌّ مشتقّ لا تفكّه مصادقة اللوحة', () => {
  const h = newPendingHash();
  const t = signActivationToken('admin-1', h);
  assert.deepEqual(verifyActivationToken(t), { aid: 'admin-1', fp: activationFingerprint(h) });
  assert.throws(() => jwt.verify(t, process.env.JWT_SECRET!), 'وسيط authenticate و/renew يفكّان بـJWT_SECRET — لا يقبلانه جلسة');
  const decoded = jwt.decode(t) as Record<string, unknown>;
  for (const k of ['id', 'role', 'tenantId', 'kind', 'uid']) assert.ok(!(k in decoded), `الحمولة تحمل ${k}`);
  assert.equal(decoded.purpose, 'company-activate');
});

test('رمز التفعيل: يُرفض بسرّ الشركة، وبغرضٍ آخر، وبحقول جلسة، ومنتهياً', () => {
  const fp = activationFingerprint(newPendingHash());
  assert.equal(verifyActivationToken(jwt.sign({ aid: 'a', purpose: 'company-activate', fp }, process.env.JWT_SECRET!)), null, 'موقّعٌ بسرّ اللوحة');
  assert.equal(verifyActivationToken(jwt.sign({ aid: 'a', purpose: 'verify-email', fp }, activationSecret())), null, 'غرضٌ آخر');
  for (const extra of [{ role: 'ADMIN' }, { id: 'a' }, { tenantId: 't' }, { kind: 'affiliate' }, { uid: 'u' }]) {
    assert.equal(verifyActivationToken(jwt.sign({ aid: 'a', purpose: 'company-activate', fp, ...extra }, activationSecret())), null, JSON.stringify(extra));
  }
  const expired = jwt.sign({ aid: 'a', purpose: 'company-activate', fp, exp: Math.floor(Date.now() / 1000) - 10 }, activationSecret());
  assert.equal(verifyActivationToken(expired), null, 'منتهٍ');
  assert.equal(verifyActivationToken('garbage'), null);
  assert.equal(verifyActivationToken(jwt.sign({ aid: 1, purpose: 'company-activate', fp }, activationSecret())), null);
});

test('التدوير يُسقط الرابط القديم: البصمة تتغيّر، والسرّ المشتقّ لا يساوي سرّ اللوحة ولو ضُبط مساوياً', () => {
  const h1 = newPendingHash();
  const h2 = newPendingHash();
  assert.notEqual(activationFingerprint(h1), activationFingerprint(h2));
  assert.equal(activationFingerprint(h1), activationFingerprint(h1));
  assert.equal(activationFingerprint(h1).length, 32);
  assert.notEqual(activationSecret(), process.env.JWT_SECRET);
  const saved = process.env.COMPANY_ACTIVATION_SECRET;
  try {
    process.env.COMPANY_ACTIVATION_SECRET = process.env.JWT_SECRET;
    assert.notEqual(activationSecret(), process.env.JWT_SECRET, 'ضبطٌ خاطئ لا يجعل الرمز جلسة');
    process.env.COMPANY_ACTIVATION_SECRET = 'own-activation-secret';
    assert.equal(activationSecret(), 'own-activation-secret');
  } finally {
    if (saved === undefined) delete process.env.COMPANY_ACTIVATION_SECRET; else process.env.COMPANY_ACTIVATION_SECRET = saved;
  }
});

test('رابط التفعيل: الرمز في المقطع (#) لا في الاستعلام', () => {
  const u = activationUrl('a.b-c_d');
  assert.match(u, /\/activate#t=a\.b-c_d$/);
  assert.doesNotMatch(u, /\?/, 'الاستعلام يصل الخادم والسجلّات وReferer');
});

// ───────────── التجربة والجوال ─────────────

test('التجربة تبدأ عند التفعيل ولا تُقصَّر أبداً', () => {
  const now = new Date('2026-10-19T09:00:00Z');
  const day = 86_400_000;
  assert.equal(trialEndAfterActivation(null, now), null, 'غير محدود يبقى غير محدود');
  assert.equal(trialEndAfterActivation(new Date(now.getTime() + 2 * day), now)!.getTime(), now.getTime() + TRIAL_PERIOD_DAYS * day);
  assert.equal(trialEndAfterActivation(new Date(now.getTime() - 5 * day), now)!.getTime(), now.getTime() + TRIAL_PERIOD_DAYS * day, 'انتهت قبل التفعيل');
  const paid = new Date(now.getTime() + 60 * day);
  assert.equal(trialEndAfterActivation(paid, now)!.getTime(), paid.getTime(), 'اشتراكٌ مدفوع لا يُقصَّر');
  assert.equal(TRIAL_PERIOD_DAYS, 10);
  assert.deepEqual({ ...TRIAL_LIMITS }, { maxSalesReps: 5, maxAdminUsers: 1 });
});

test('مفتاح الجوال هو مطبِّع بوابة واتساب نفسه، والقناع يُبقي ٤ أوّلاً و٣ آخراً', () => {
  for (const p of ['0551234567', '551234567', '+966 55 123 4567', '00966551234567', '966551234567']) assert.equal(phoneKey(p), '966551234567', p);
  assert.equal(phoneKey('+971 50 123 4567'), '971501234567');
  assert.equal(phoneKey(null), '');
  assert.equal(maskPhone('+966551234567'), '+9665•••••567');
  assert.equal(maskPhone('0551234567'), '+9665•••••567');
  assert.equal(maskPhone('123'), null);
  assert.equal(maskPhone(null), null);
});

// ───────────── القواعد النقيّة ─────────────

test('بريد السفير أو جواله مكان المسؤول: يُكشف بأيّ صيغة', () => {
  const base = { affiliateEmail: 'marketer@mail.com', affiliatePhone: '966551111111', adminEmail: 'owner@company.sa', adminPhone: '966552222222' };
  assert.equal(isSelfContact(base), false);
  assert.equal(isSelfContact({ ...base, adminEmail: '  MARKETER@Mail.com ' }), true, 'حالة الأحرف والمسافات');
  assert.equal(isSelfContact({ ...base, adminPhone: '0551111111' }), true, '05… مقابل 966…');
  assert.equal(isSelfContact({ ...base, adminPhone: '+966551111111' }), true, '+966…');
  // سفيرٌ من دولةٍ أخرى: جواله مخزَّنٌ أرقاماً دولية بلا +
  assert.equal(isSelfContact({ ...base, affiliatePhone: '971501234567', adminPhone: '+971 50 123 4567' }), true, 'دوليّ مخزَّن');
  assert.equal(isSelfContact({ ...base, affiliatePhone: null, adminPhone: null }), false, 'لا جوال لا تطابق');
  assert.equal(isSelfContact({ ...base, affiliateEmail: '', adminEmail: '' }), false, 'بريدان فارغان ليسا تطابقاً');
});

test('الرابط والنطاق في الاسم يُرفضان، والأسماء العادية تمرّ', () => {
  for (const t of ['fieldsa-pay.com', 'www.x', 'https://', 'http://a', 'ادفع عبر pay-now.net', 'WWW.EXAMPLE', 'ｗｗｗ.x']) {
    assert.equal(containsLinkLike(t), true, `يجب رفض: ${t}`);
  }
  for (const t of ['مؤسسة النور', 'Al-Noor Co.', 'شركة 2026', 'Al Noor Trading Est.', 'مكسرات وشاهي', '', null, 42]) {
    assert.equal(containsLinkLike(t as unknown), false, `يجب قبول: ${String(t)}`);
  }
  assert.equal(containsContactInfo('أبو فهد 0551234567'), true, 'والكاشف القديم يعمل معه في الاسمين');
});

test('ترشيح سفيرٍ آخر يوقف الإسناد، وإشارات المعلومة لا توقفه', () => {
  assert.equal(isDisputedByFlags(['claim_conflict']), true);
  assert.equal(isDisputedByFlags(['returning_company']), true);
  assert.equal(isDisputedByFlags(['self_email', 'ip_match']), false, 'ip_match معلومةٌ للمالك فقط (قرار المالك)');
  assert.equal(isDisputedByFlags(['self_phone']), false);
});

test('سقوف البوابة كما قرّرها المالك، والمفتاح مفعّلٌ افتراضياً', () => {
  assert.equal(PORTAL_TRIAL_DAILY_CAP, 10);
  assert.equal(PORTAL_TRIAL_PENDING_CAP, 20);
  assert.equal(MAX_RESENDS, 5);
  assert.equal(RESEND_COOLDOWN_MS, 10 * 60_000);
  assert.equal(RESEND_WINDOW_DAYS, 30);
  assert.equal(ACTIVATION_RESEND_COOLDOWN_MS, 10 * 60_000);
  assert.ok(SIGNUP_MAX_RESENDS >= 1);
  const saved = process.env.AX_PORTAL_TRIAL_ENABLED;
  try {
    delete process.env.AX_PORTAL_TRIAL_ENABLED;
    assert.equal(portalTrialEnabled(), true, 'مفعّلٌ بلا ضبط');
    process.env.AX_PORTAL_TRIAL_ENABLED = '1';
    assert.equal(portalTrialEnabled(), true);
    process.env.AX_PORTAL_TRIAL_ENABLED = '0';
    assert.equal(portalTrialEnabled(), false, '0 يطفئه');
  } finally {
    if (saved === undefined) delete process.env.AX_PORTAL_TRIAL_ENABLED; else process.env.AX_PORTAL_TRIAL_ENABLED = saved;
  }
});

// ───────────── حرّاس الوصل: البوابة ─────────────

test('مسار البوابة: سفيرٌ مقبول بشروطٍ حالية، وحدٌّ لكلّ سفير، وردٌّ 202 واحد بلا رابطٍ ولا رمز', () => {
  const portal = src('routes', 'affiliate.ts');
  assert.ok(portal.includes("router.post('/trials', axAuth, requireApproved, axTrialLimiter"), 'الإنشاء');
  assert.ok(portal.includes("router.post('/trials/:id/resend', axAuth, requireApproved, axTrialLimiter"), 'إعادة الإرسال');
  assert.ok(portal.includes("router.post('/trials/:id/withdraw', axAuth, requireApproved"), 'السحب');
  const from = portal.indexOf("router.post('/trials'");
  const create = portal.slice(from, portal.indexOf('\nrouter.', from + 10));
  assert.match(create, /status\(202\)\.json\(/);
  assert.doesNotMatch(create, /status\(409\)|signActivationToken|activationUrl|\/activate|token:/, 'لا تعداد ولا رابط ولا رمز في ردّ السفير');
  assert.match(create, /isSelfContact\(\{ affiliateEmail: u\.email, affiliatePhone: u\.phone/, 'المقارنة ببيانات السفير من التوكن');
  assert.match(create, /containsContactInfo\(t\) \|\| containsLinkLike\(t\)/);
  assert.match(create, /code: 'self_contact'/);
  assert.match(create, /portal_trial_disabled|TRIAL_DISABLED/);
  const schema = portal.slice(portal.indexOf('const trialSchema'), portal.indexOf('});', portal.indexOf('const trialSchema')));
  assert.match(schema, /consent: z\.literal\(true\)/, 'إقرار الموافقة إلزاميّ');
  assert.match(schema, /crNumber: z\.string\(\)\.max\(30\)\.optional\(\)\.nullable\(\)/, 'السجل اختياريّ (قرار المالك)');
  assert.doesNotMatch(schema, /password/, 'السفير لا يضع كلمة مرور');
  const limiter = portal.slice(portal.indexOf('const axTrialLimiter'), portal.indexOf('});', portal.indexOf('const axTrialLimiter')));
  assert.match(limiter, /keyGenerator: [^\n]*affiliate\?\.id/, 'لكلّ سفير لا لكلّ IP');
  assert.match(limiter, /limit: 20/);
  assert.doesNotMatch(portal, /signActivationToken|activationUrl|mailCompanyActivation|newPendingHash/, 'البوابة لا تلمس رابط الشركة أبداً');
  assert.match(handler(portal, "router.get('/me'"), /portalTrialEnabled: portalTrialEnabled\(\)/);
  const companies = handler(portal, "router.get('/companies'");
  assert.match(companies, /activation: a\.source === 'portal' && a\.status !== 'void' \? \(pendingTenants\.has\(a\.tenantId\) \? 'pending' : 'active'\) : null/);
  assert.doesNotMatch(companies, /tenantId:/, 'معرّف الشركة لا يصل السفير');
});

test('خدمة البوابة: الشركة والإسناد في معاملةٍ واحدة، والبريد بعدها، ولا واتساب قبل التفعيل', () => {
  const pt = src('services', 'affiliate', 'portalTrial.ts');
  const create = fnBody(pt, 'export async function createPortalTrial');
  assert.match(create, /Promise<\{ outcome: 'created' \| 'blocked' \| 'dry_run' \}>/, 'النتيجة للاختبار والسجلّ لا تحمل شيئاً للسفير');
  const txStart = create.indexOf('prisma.$transaction(');
  const txEnd = create.indexOf('} catch (e) {', txStart);
  assert.ok(txStart > 0 && txEnd > txStart);
  const tx = create.slice(txStart, txEnd);
  assert.match(tx, /createTrialCompanyTx\(tx,/);
  assert.match(tx, /tx\.tenantAttribution\.create\(/);
  assert.match(tx, /logEvent\(tx,/);
  assert.match(tx, /source: 'portal'/);
  assert.match(tx, /codeUsed: null, refVia: null/);
  assert.match(tx, /passwordHash: pendingHash/, 'المدير بلا كلمة مرور — حارسٌ لا يطابقه bcrypt');
  assert.match(tx, /consent: true, ipHash: ctx\.ipHash/);
  assert.match(create, /rulesFor\(aff\.termsVersion\)/, 'لقطة القواعد من الشروط التي قبلها السفير');
  assert.match(create, /isUniqueViolation\(e, 'email'\)/, 'سباق البريد حجبٌ لا خطأ');
  const mailAt = create.indexOf('mailCompanyActivation(');
  assert.ok(mailAt > txEnd, 'بريد التفعيل بعد الالتزام');
  assert.match(create.slice(mailAt), /mailCompanyActivation\(i\.adminEmail, signActivationToken\(created\.adminId, pendingHash\)\)/, 'لبريد المسؤول وحده');
  const dry = create.indexOf("if (i.dryRun) return { outcome: 'dry_run' };");
  assert.ok(dry > 0 && dry < txStart, 'الفحص الجاف قبل أيّ كتابة');
  assert.match(create, /if \(!i\.dryRun\) await logBlocked/, 'ولا حدث في الفحص الجاف');
  assert.doesNotMatch(pt, /sendWaWelcome\(/, 'لا واتساب لرقمٍ كتبه السفير');
  assert.match(create, /affiliateId: \{ not: aff\.id \}/, 'التعارض مع ترشيحات غيره');
  assert.match(create, /\['claim_conflict'\]/);
  const resend = fnBody(pt, 'export async function resendPortalActivation');
  assert.match(resend, /where: \{ id: attributionId, affiliateId, source: 'portal' \}|ownPortalTrial\(affiliateId, attributionId\)/);
  assert.match(resend, /rotatePendingHashTx\(tx, admin\)/, 'التدوير يُسقط الروابط الأقدم');
  assert.match(resend, /mailCompanyActivation\(admin\.email,/, 'للبريد المخزَّن وحده');
  const own = fnBody(pt, 'async function ownPortalTrial');
  assert.match(own, /where: \{ id: attributionId, affiliateId, source: 'portal' \}/, 'حسابات السفير نفسه فقط');
  const withdraw = fnBody(pt, 'export async function withdrawPortalTrial');
  assert.match(withdraw, /paymentLink\.count\(\{ where: \{ tenantId: a\.tenantId, status: 'paid' \} \}\)/);
  assert.match(withdraw, /where: \{ id: admin\.id, passwordHash: admin\.passwordHash \}/, 'شركةٌ فعّلت للتوّ لا تُسحب');
  assert.match(withdraw, /withdrawn\+\$\{admin\.id\}@fieldsa\.invalid/);
  assert.doesNotMatch(withdraw, /\.delete\(|deleteMany/, 'لا حذف');
  // ترشيحات السفير المتحوّلة إلى هذا الحساب تعود داخل معاملة السحب — وإلا حجز «متحوّلٌ» إلى شركةٍ موقوفة
  // السجلَّ بلا أجل. بربطها الفعليّ بالشركة لا بـ a.claimId وحده (المالك قد يربط ترشيحاً آخر)
  const wtx = withdraw.slice(withdraw.indexOf('prisma.$transaction('));
  assert.match(wtx, /tx\.affiliateClaim\.findMany\(\{\s*where: \{ affiliateId, status: 'converted', tenantId: a\.tenantId \}/, 'ترشيحاته هو المربوطة بهذه الشركة');
  assert.doesNotMatch(wtx, /if \(a\.claimId\)/, 'عاد الاكتفاء بـ a.claimId');
  assert.match(wtx, /'approved' : 'expired'/, 'معتمدٌ إن بقي قفله وإلا منتهٍ');
  assert.match(wtx, /data: \{ status: back, tenantId: null, convertedAt: null \}/);
  assert.match(wtx, /action: 'conversion_reverted'/);
});

test('عميلٌ قائم بجوالٍ مخزَّنٍ بأرقامٍ عربية أو «+966 05…»: يُحجب كما يعلّمه التسجيل الذاتيّ returning_company', () => {
  const typed = '+966551234567';
  for (const stored of ['٠٥٥١٢٣٤٥٦٧', '+966 0551234567', '+9660551234567', '00966 0551234567', '۰۵۵۱۲۳۴۵۶۷', '0551234567']) {
    assert.ok(phoneKey(stored) === phoneKey(typed) || normPhoneSA(stored) === normPhoneSA(typed), `${stored} لا يطابق`);
  }
  assert.notEqual(phoneKey('٠٥٥١٢٣٤٥٦٧'), phoneKey(typed), 'مفتاح البوابة وحده يفوّتها — لذلك المطبِّعان معاً');
  const ex = fnBody(src('services', 'affiliate', 'portalTrial.ts'), 'async function existingCustomer');
  assert.match(ex, /const sa = normPhoneSA\(`\+\$\{i\.adminPhone\}`\);/);
  assert.match(ex, /phoneKey\(s\.phone\) === key \|\| \(sa !== null && normPhoneSA\(s\.phone\) === sa\)/);
});

test('الدفتر لا يعرف هذا الطريق، والمالك يرى حالة التفعيل', () => {
  const ledger = src('services', 'affiliate', 'ledger.ts');
  assert.doesNotMatch(ledger, /createTrialCompanyTx|portal/);
  const admin = handler(src('routes', 'affiliateAdmin.ts'), "router.get('/attributions'");
  assert.match(admin, /pendingActivationTenantIds\(/);
  assert.match(admin, /activation: a\.source === 'portal'/);
});

test('بريد التفعيل: نصٌّ ثابت بهوية FieldSales — لا شيء كتبه السفير لعنوانٍ لم تثبت ملكيّته', () => {
  const tc = src('services', 'trialCompany.ts');
  const mail = fnBody(tc, 'export function mailCompanyActivation');
  assert.doesNotMatch(mail, /companyName|adminName|\$\{name\}|سفير فيلد سيلز/);
  assert.match(mail, /escapeHtml\(activationUrl\(token\)\)/);
  assert.match(mail, /صالح ٧ أيام ويعمل مرّةً واحدة/);
  assert.match(mail, /السفير لا يعرفها/);
  assert.match(mail, /فتجاهلوا هذه الرسالة/);
  const styles = [...mail.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(styles.length >= 5 && styles.every((s) => s.includes(':')), 'كلّ style بنقطتيه');
  const owner = fnBody(tc, 'export async function notifyOwnerNewTrial');
  assert.match(owner, /rows\.map\(\(\[k, v\]\) => \[escapeHtml\(k\), escapeHtml\(v\)\]\)/, 'mailLayout لا يهرّب');
});

// ───────────── حرّاس الوصل: الشركة ─────────────

test('التفعيل: استعمالٌ واحد بمقارنةٍ‑وتبديل، والرمز بالسرّ المشتقّ، وواتساب بعد الالتزام فقط', () => {
  const tc = src('services', 'trialCompany.ts');
  const act = fnBody(tc, 'export async function activateCompany');
  assert.match(act, /tx\.admin\.updateMany\(\{\s*where: \{ id: admin\.id, passwordHash: admin\.passwordHash \}/);
  assert.match(act, /won\.count !== 1/);
  assert.match(act, /subscriptionEndsAt: prevEnd \}/, 'تمديد التجربة مشروطٌ بالقيمة المقروءة');
  // الجوال تكتبه الشركة كاملاً — لا «إبقاء» صامت لما كتبه السفير — وبمطبِّع البوابة الصارم (لا «+966966…»)
  assert.match(act, /const norm = normAffiliatePhone\(/);
  assert.match(act, /if \(!norm\) throw new ActivationError\(400, [^)]*'invalid_phone'\)/);
  assert.match(act, /phone: string; ipHash/, 'الجوال مطلوبٌ في النوع أيضاً');
  // فحص التكرار في **كلّ** تفعيل — لا في فرع «تغيّر الرقم» وحده: رقمُ المنتظر قد يأخذه غيره في أثناء الانتظار
  const hitsAt = act.indexOf('const hits = others.filter(o => phoneKey(o.phone) === nextKey);');
  assert.ok(hitsAt > 0);
  assert.doesNotMatch(act.slice(act.indexOf('const nextKey'), hitsAt), /if \(nextKey !== /, 'الفحص صار مشروطاً بتغيّر الرقم من جديد');
  assert.match(act, /const newPhone: string \| null = nextKey !== phoneKey\(admin\.tenant\.settings\?\.phone\) \? cleaned : null;/);
  // المنتظر تفعيله لا يحجب، والرفض يمرّ بالمِسبار المحسوب
  assert.match(act, /const pending = await pendingActivationTenantIds\(hits\.map\(h => h\.tenantId\)\);/);
  assert.match(act, /if \(hit\) await phoneTakenProbe\(admin, hit\.tenantId\);/);
  assert.match(act, /if \(ins\.state === 'locked'\) throw new ActivationError\(409, LINK_LOCKED, 'link_locked'\);/);
  assert.ok(act.indexOf('phoneTakenProbe(') < act.indexOf('prisma.$transaction('), 'الرفض قبل الالتزام');
  const probe = fnBody(tc, 'async function phoneTakenProbe');
  assert.match(probe, /Promise<never>/, 'يرمي دائماً');
  assert.match(probe, /action: 'activation_phone_taken'/, 'كلّ رفضٍ حدثٌ يراه المالك');
  assert.match(probe, /n >= PHONE_TAKEN_LIMIT && await rotatePendingHashTx\(prisma, [^)]*\}, \{ locked: true \}\)/, 'ثمّ يسقط الرابط موسوماً «موقوفاً»');
  // العدّ لهذا الرابط: منذ آخر فتحٍ أو إعادة إرسال — كلّ رابطٍ جديد يبدأ عدّاً جديداً
  assert.match(probe, /action: \{ in: \['created', 'activation_resent'\] \}/);
  assert.match(probe, /createdAt: \{ gte: issued\.createdAt \}/);
  // الموقوف «أُوقف» لا «أُرسل أحدث» — ولا يزال منتظراً
  const inspect = fnBody(tc, 'async function inspectActivation');
  assert.ok(inspect.indexOf("return { state: 'locked' }") < inspect.indexOf('sameFingerprint('), 'الإيقاف قبل مقارنة البصمة');
  assert.match(probe, /'link_locked'/);
  assert.ok(probe.trimEnd().endsWith("'phone_taken');\n}"), 'آخر سطرٍ رميُ phone_taken');
  assert.equal(PHONE_TAKEN_LIMIT, 3);
  assert.match(act, /action: 'company_activated'/);
  const tx = act.indexOf('prisma.$transaction(');
  assert.ok(act.indexOf('sendWaWelcome(') > tx, 'الترحيب بعد أن فعّلت الشركة وأكّدت رقمها');
  assert.ok(act.indexOf('mailTrialActivated(') > tx);
  assert.match(fnBody(tc, 'export function verifyActivationToken'), /jwt\.verify\(token, activationSecret\(\)\)/);
  assert.match(fnBody(tc, 'export function activationSecret'), /`\$\{base\}::company-activate`/);
  const rotate = fnBody(tc, 'export async function rotatePendingHashTx');
  assert.match(rotate, /passwordHash: admin\.passwordHash/);
  assert.match(rotate, /updatedAt: \{ lt: opts\.notUpdatedSince \}/);
});

test('مسارا التفعيل في auth.ts بعد تأكيد البريد، بلا JWT_SECRET، وبجلسةٍ كالدخول', () => {
  const auth = src('routes', 'auth.ts');
  const verify = auth.indexOf("router.post('/verify-email'");
  assert.ok(auth.indexOf("router.post('/activate'") > verify, 'شريحة التسجيل في affiliate.test.ts لا تتغيّر');
  assert.ok(auth.indexOf("router.post('/activation/preview'") > verify);
  for (const sig of ["router.post('/activation/preview'", "router.post('/activate'"]) {
    const h = handler(auth, sig);
    assert.doesNotMatch(h, /process\.env\.JWT_SECRET/, `${sig}: الرمز يُتحقَّق منه في الخدمة بالسرّ المشتقّ`);
    assert.match(h, /authLimiter/, sig);
  }
  const act = handler(auth, "router.post('/activate'");
  assert.match(act, /acceptTerms: z\.literal\(true\)/);
  assert.match(act, /password: z\.string\(\)\.min\(8/);
  assert.match(act, /phone: z\.string\(\)\.trim\(\)\.min\(1, [^)]*\)\.max\(30\),/, 'الجوال مطلوب');
  assert.match(act, /activateCompany\(\{ token: b\.token, password: b\.password, phone: b\.phone, ipHash: ipHash\(req\.ip\) \}\)/);
  assert.match(act, /tenantBlockReason\(admin\.tenant\)/);
  assert.match(act, /emailVerified: true,/);
  assert.match(act, /\.\.\.adminPermissionFields\(admin\)/, 'شكل مستخدم الدخول نفسه');
  assert.match(act, /err instanceof ActivationError/);
});

test('التسجيل الذاتيّ ببريدٍ بانتظار التفعيل: 409 برسالته ويُعاد الرابط بمهلة — والرسالة العادية كما هي (قرار المالك ٧)', () => {
  const auth = src('routes', 'auth.ts');
  const signup = auth.slice(auth.indexOf("router.post('/signup'"), auth.indexOf("router.post('/verify-email'"));
  const resendAt = signup.indexOf('resendActivationForSignup(pending.id)');
  assert.ok(resendAt > 0 && resendAt < signup.indexOf('$transaction'), 'قبل إنشاء أيّ شيء');
  assert.match(signup, /taken\.isActive && isPendingActivationHash\(taken\.passwordHash\)/);
  assert.match(signup, /email: \{ equals: body\.email, mode: 'insensitive' \}, isActive: true, passwordHash: \{ startsWith: PENDING_ACTIVATION_PREFIX \}/, 'البوابة تخزّن البريد صغيراً');
  assert.match(signup, /res\.status\(409\)\.json\(\{ success: false, message: 'هذا البريد له حساب بانتظار التفعيل — أرسلنا لك رابط التفعيل مجدداً، افحص بريدك' \}\);/);
  assert.match(signup, /if \(taken\) \{ res\.status\(409\)\.json\(\{ success: false, message: 'البريد الإلكتروني مستخدم مسبقا - سجل الدخول' \}\); return; \}/, 'رسالة الحساب النشط لم تتغيّر');
  assert.ok(signup.indexOf('resendActivationForSignup(') < signup.indexOf("if (taken) { res.status(409)"), 'المنتظر قبل النشط');
  const tc = src('services', 'trialCompany.ts');
  const resend = fnBody(tc, 'export async function resendActivationForSignup');
  assert.match(resend, /notUpdatedSince: new Date\(Date\.now\(\) - ACTIVATION_RESEND_COOLDOWN_MS\)/, 'مرّةً كلّ عشر دقائق — ذرّياً');
  assert.match(resend, /rotatePendingHashTx\(tx, admin,/, 'الآلية نفسها لإعادة إرسال السفير');
  assert.match(resend, /mailCompanyActivation\(admin\.email,/, 'للبريد المخزَّن');
  assert.match(resend, /SIGNUP_MAX_RESENDS/);
  const tail = resend.slice(resend.lastIndexOf('} catch (e) {'));
  assert.doesNotMatch(tail, /throw/, 'لا يرمي أبداً');
  assert.match(signup, /createTrialCompanyTx\(tx,/, 'التسجيل الذاتيّ يمرّ بالخدمة المشتركة');
  assert.match(signup, /sendWaWelcome\(\{ phone: body\.phone/, 'العميل سجّل بنفسه وأعطانا جواله');
  assert.match(signup, /notifyOwnerNewTrial\(\{/);
});

test('بوابة واتساب: حسابٌ بانتظار التفعيل ليس هوية ولا يُحسب في الغموض، ولا يُبلَّغ بانتهاء تجربة، ويبقى حاجزاً لإنشاءٍ آخر', () => {
  const wa = src('routes', 'waAccount.ts');
  assert.match(wa, /export const normalizePhone = phoneKey;/, 'المطبِّع نفسه — السلوك لم يتغيّر');
  // المنتظر يُستبعد **قبل** فحص الغموض: رقمٌ كتبه السفير لا يعطّل بوابة عميلٍ حقيقيّ سجّل بعده
  const lookup = handler(wa, "router.get('/lookup'");
  assert.match(lookup, /const pending = await pendingActivationTenantIds\(raw\.map\(\(r\) => r\.tenantId\)\);\s*const matches = raw\.filter\(\(r\) => !pending\.has\(r\.tenantId\)\);\s*\n\s*if \(matches\.length !== 1\)/);
  const byPhone = fnBody(wa, 'async function tenantByPhone');
  assert.match(byPhone, /const pending = await pendingActivationTenantIds\(raw\.map\(\(r\) => r\.tenantId\)\);\s*const m = raw\.filter\(\(r\) => !pending\.has\(r\.tenantId\)\);\s*if \(m\.length !== 1\) return null;/);
  assert.doesNotMatch(fnBody(wa, 'async function tenantCountByPhone'), /pendingActivationTenantIds|isPendingActivationTenant/, 'العدّ يشمل المنتظر فلا يُفتح بالرقم حسابٌ آخر');
  assert.match(handler(wa, "router.get('/events'"), /admins: \{ none: \{ passwordHash: \{ startsWith: PENDING_ACTIVATION_PREFIX \} \} \}/);
});

test('الحارس «الموقوف» ما زال منتظراً (الدخول يفشل والإعادة تدوّره) لكنه يُعرف موقوفاً', () => {
  const tc = src('services', 'trialCompany.ts');
  assert.match(tc, /const LOCKED_ACTIVATION_MARK = `\$\{PENDING_ACTIVATION_PREFIX\}locked:`;/, 'البادئة نفسها — يبقى منتظراً لكلّ فحص');
  const locked = `${PENDING_ACTIVATION_PREFIX}locked:${'ab'.repeat(24)}`;
  assert.ok(isPendingActivationHash(locked));
  assert.ok(isLockedActivationHash(locked));
  assert.ok(!isLockedActivationHash(newPendingHash()), 'الحارس العادي ليس موقوفاً');
  assert.notEqual(locked.length, 60, 'لا يطابقه bcrypt');
  assert.match(fnBody(tc, 'export async function rotatePendingHashTx'), /opts\.locked \? LOCKED_ACTIVATION_MARK \+ crypto\.randomBytes\(24\)\.toString\('hex'\) : newPendingHash\(\)/);
});

test('واتساب /signup-link: رقمٌ مسجّلٌ بلا هوية (غموضٌ أو حسابٌ منتظر) لا يُصدر اشتراكاً جديداً — كحاجز /signup-trial', () => {
  const h = handler(src('routes', 'waAccount.ts'), "router.post('/signup-link'");
  const id = h.indexOf('if (await tenantByPhone(phone))');
  const count = h.indexOf('if ((await tenantCountByPhone(phone)) > 0)');
  assert.ok(id > 0 && count > id, 'الحاجز بعد فحص الهوية وقبل إنشاء الرابط');
  assert.ok(count < h.indexOf('createInvoice('), 'قبل إنشاء الفاتورة');
});

test('المسحوب (void) بلا حالة تفعيل — مديره المعطَّل يحمل حارساً فلا يُقرأ «منتظراً»', () => {
  const sites = [src('routes', 'affiliate.ts'), src('routes', 'affiliateAdmin.ts')].join('\n');
  const all = sites.match(/activation: a\.source === 'portal'[^\n]*/g) ?? [];
  assert.equal(all.length, 3);
  for (const l of all) assert.match(l, /a\.source === 'portal' && a\.status !== 'void' \?/);
});

test('مطابقة البريد بلا اعتبار الحالة تُحسم حرفاً بحرف — «_» و«%» ليسا حرفَي بدل', () => {
  const signup = handler(src('routes', 'auth.ts'), "router.post('/signup'");
  assert.match(signup, /\.find\(a => a\.email\.toLowerCase\(\) === body\.email\.toLowerCase\(\)\) \?\? null;/);
  const ex = fnBody(src('services', 'affiliate', 'portalTrial.ts'), 'async function existingCustomer');
  assert.match(ex, /\.find\(a => a\.email\.toLowerCase\(\) === i\.adminEmail\.toLowerCase\(\)\);/);
  assert.doesNotMatch(ex, /prisma\.admin\.findFirst\(\{ where: \{ email: \{ equals/, 'عاد الحسم بنمط القاعدة');
});

// ───────────── المواصفة ─────────────

test('API.md يطابق الشيفرة: الإشارات، ومصدر «شركاتي» وحالة تفعيلها، والمسارات الجديدة', () => {
  const api = fs.readFileSync(path.join(process.cwd(), '..', 'docs', 'affiliate', 'API.md'), 'utf8');
  assert.deepEqual(union(api, /type Flag = ([^;]+);/), union(src('services', 'affiliate', 'rules.ts'), /export type AttributionFlag = ([^;]+);/));
  const companies = api.split('\n').find((l) => l.includes('GET /companies'));
  assert.ok(companies, 'سطر GET /companies');
  assert.match(companies!, /source: 'signup_code'\|'claim'\|'owner'\|'portal'/);
  assert.match(companies!, /activation: 'pending'\|'active'\|null/);
  for (const s of ['POST /trials', 'POST /trials/:id/resend', 'POST /trials/:id/withdraw', 'portalTrialEnabled', '/api/auth/activation/preview', '/api/auth/activate']) {
    assert.ok(api.includes(s), `API.md بلا ${s}`);
  }
  for (const code of ['self_contact', 'trial_daily_cap', 'trial_pending_cap', 'portal_trial_disabled', 'resend_cooldown', 'resend_limit', 'resend_window', 'not_pending', 'phone_taken', 'link_locked', 'already_active', 'superseded']) {
    assert.ok(api.includes(code), `API.md بلا الرمز ${code}`);
  }
});
