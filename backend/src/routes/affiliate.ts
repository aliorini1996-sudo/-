/**
 * بوابة «سفير فيلد سيلز» — `/api/affiliate`. الأشكال في docs/affiliate/API.md.
 *
 * العزل (CONTRACT §1.7): سرٌّ مشتقّ وحمولة `kind:'affiliate'`، فلا توكن شركةٍ
 * يصلح هنا ولا العكس. ومعرّف السفير يُقرأ من التوكن وحده — لا من جسمٍ ولا
 * مسار (درس IDOR في منصّة الصيد)؛ وكلّ قراءةٍ مقيّدة بـ`affiliateId` منه.
 *
 * v2 — الانضمام فوريّ (قرار المالك ١٨ نوفمبر ٢٠٢٦، docs/affiliate/V2_SPEC.md §6.1): التسجيل يُنشئ الحساب approved
 * ويُعيد الجلسة فوراً (201)، والبريد المسجَّل يُردّ 409 «سجّل الدخول» كتسجيل الشركات — بقرار المالك لا سهواً، فلا
 * تأكيد بريدٍ ولا 202 موحّدة فيه بعد اليوم. والاستعادة تبقى 202 موحّدة، وخطأ الدخول واحدٌ لا يميّز «بريدٌ غير موجود»
 * من «كلمة مرور خاطئة».
 */
import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { z, ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import {
  getSettings, getTerms, logEvent, logEventSafe, signSession, verifySession, signPurpose, verifyPurpose,
  hashPassword, verifyPassword, ipHash, encryptIban, referralLink, riyadhDay, isUniqueViolation, DAY_MS,
  promoteLegacyAffiliate, LEGACY_PENDING_STATUSES,
} from '../services/affiliate/core';
import {
  generateCode, normEmail, normAffiliatePhone, normCR, normCompanyName, containsContactInfo, normIbanSA, parseRef, normContactPhone,
  containsLinkLike, isSelfContact, PARTNER_TYPES, normSocialLinks, readSocialLinks, profileMissing, isDocKind, DOC_KINDS,
} from '../services/affiliate/rules';
import { affiliatePricing } from '../services/affiliate/pricing';
import { mailWelcome, mailReset, mailOwnerNewAffiliate, mailPayoutProfileChanged } from '../services/affiliate/mail';
import { expireStaleClaims, LedgerError } from '../services/affiliate/ledger';
import { createPortalTrial, resendPortalActivation, withdrawPortalTrial, portalTrialEnabled } from '../services/affiliate/portalTrial';
import { pendingActivationTenantIds } from '../services/trialCompany';
import { listDocuments, parseDocumentDataUrl, saveDocument, deleteDocument, documentDataUrl, refreshProfileCompletion } from '../services/affiliate/documents';
import { LIVE_COMMISSION_STATUSES, earningsByMonth, monthsWindowStart, conversionRate, earningsTotals } from '../services/affiliate/portalStats';
import { nextSettlementAt } from '../services/affiliate/settlement';
import { createMissedClaim, listMissedClaims, withdrawMissedClaim, normalizeMissedClaim, MISSED_CLAIM_OPEN_LIMIT } from '../services/affiliate/missedClaims';
import { listMaterials, materialFile } from '../services/affiliate/materials';

const router = Router();

const limiterBase = { standardHeaders: true, legacyHeaders: false } as const;
const axAuthLimiter = rateLimit({ ...limiterBase, windowMs: 15 * 60_000, limit: 20, message: { success: false, message: 'محاولات كثيرة انتظر ربع ساعة ثم حاول مجددا' } });
const axRegisterLimiter = rateLimit({ ...limiterBase, windowMs: 60 * 60_000, limit: 6, message: { success: false, message: 'طلبات تسجيل كثيرة حاول بعد ساعة' } });
const axClickLimiter = rateLimit({ ...limiterBase, windowMs: 60_000, limit: 30, message: { success: false } });

const ACCEPTED = { success: true, data: { message: 'إن كانت البيانات صحيحة فستصلك رسالة على بريدك' } };

/** البريد مسجَّلٌ أصلاً — بقرار المالك (v2) كتسجيل الشركات: الرسالة توجّه للدخول */
const EMAIL_TAKEN = { success: false, code: 'email_taken', message: 'يوجد حساب بهذا البريد — سجّل الدخول' };

type AffiliateRow = NonNullable<Awaited<ReturnType<typeof prisma.affiliateUser.findUnique>>>;
interface AxRequest extends Request { affiliate?: AffiliateRow }

const aid = (req: AxRequest) => req.affiliate!.id;

/**
 * «حسابٌ يفتحه السفير» وإعادة إرسال رابطه — **لكلّ سفير** لا لكلّ IP: يُركَّب بعد axAuth فيُفتح بمعرّف
 * السفير من التوكن (سفراء مكتبٍ واحد خلف NAT لا يتقاسمون العدّاد، ومن يبدّل شبكته لا يتجاوزه).
 */
const axTrialLimiter = rateLimit({
  ...limiterBase, windowMs: 60 * 60_000, limit: 20,
  keyGenerator: (req) => `ax-trial:${(req as AxRequest).affiliate?.id ?? 'anon'}`,
  message: { success: false, message: 'طلباتٌ كثيرة من حسابك — حاول بعد ساعة' },
});

/**
 * …و**لكلّ IP في يوم الرياض** فوق حدّ السفير (المراجعة #1): الانضمام فوريّ (v2) فالحساب الجديد يكلّف طلباً واحداً، وحدود
 * السفير وحدها (أعلاه، و١٠/يوم و٢٠ منتظراً في portalTrial.ts) صارت تُضرب في عدد الحسابات الرخيصة — شركاتٌ وبُرُد تفعيلٍ رسمية
 * لعناوين لم تطلبها. اليوم جزءٌ من المفتاح فيبدأ العدّاد من الصفر منتصف الليل بتوقيت الرياض. الفتح وإعادة الإرسال بعدّادين
 * منفصلين (إعادة إرسال رابط شركةٍ حقيقية لا تُحجب لأنّ السفير فتح عشراً اليوم). **لا يشترط ملفاً مكتملاً** — قرار المالك: الملف
 * شرطٌ للصرف وحده، والحساب التجريبي متاحٌ لكلّ سفيرٍ مقبول.
 */
const TRIAL_IP_DAILY_LIMIT = 10;
const trialIpLimiter = (kind: 'new' | 'resend') => rateLimit({
  ...limiterBase, windowMs: DAY_MS, limit: TRIAL_IP_DAILY_LIMIT,
  keyGenerator: (req) => `ax-trial-ip:${kind}:${riyadhDay()}:${req.ip ?? 'unknown'}`,
  message: { success: false, message: 'طلباتٌ كثيرة لفتح الحسابات من هذه الشبكة اليوم — حاول غداً', code: 'trial_ip_daily_cap' },
});
const axTrialIpLimiter = trialIpLimiter('new');
const axTrialResendIpLimiter = trialIpLimiter('resend');

/** أخطاء الخدمة تحمل حالتها ورسالتها ورمزها — والباقي لمعالج الأخطاء العام */
function ledgerFail(res: Response, e: unknown): boolean {
  if (!(e instanceof LedgerError)) return false;
  res.status(e.status).json({ success: false, message: e.message, code: e.code });
  return true;
}

function publicUser(u: AffiliateRow) {
  return {
    id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, city: u.city, code: u.code,
    status: u.status, statusReason: u.statusReason, publicPromoter: u.publicPromoter,
    mawthooqNo: u.mawthooqNo, mawthooqExpiry: u.mawthooqExpiry ? riyadhDay(u.mawthooqExpiry) : null,
    vatNumber: u.vatNumber, marketingConsent: u.marketingConsent, termsVersion: u.termsVersion,
    // v2: نوع السفير واسم شركته وروابط تواصله — والمستندات واكتمال الملف في /me (تحتاج قراءةً إضافية)
    partnerType: u.partnerType, companyName: u.companyName, socialLinks: readSocialLinks(u.socialLinks),
    profileCompletedAt: u.profileCompletedAt?.toISOString() ?? null,
    payout: u.ibanEnc && u.ibanLast4
      ? { holderName: u.ibanHolderName ?? '', bankName: u.bankName, ibanLast4: u.ibanLast4, updatedAt: (u.payoutUpdatedAt ?? u.updatedAt).toISOString() }
      : null,
    createdAt: u.createdAt.toISOString(),
  };
}

async function axAuth(req: AxRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.split(' ')[1];
  const s = token ? verifySession(token) : null;
  if (!s) { res.status(401).json({ success: false, message: 'انتهت الجلسة سجل الدخول مجددا' }); return; }
  try {
    const u = await prisma.affiliateUser.findUnique({ where: { id: s.uid } });
    // تغيير كلمة المرور يرفع tokenVersion فتسقط كلّ الجلسات القديمة
    if (!u || u.tokenVersion !== s.tv) {
      res.status(401).json({ success: false, message: 'انتهت الجلسة سجل الدخول مجددا' }); return;
    }
    // جلسةٌ قائمة لسفيرٍ «قيد المراجعة» من v1 (كان يدخل ويرى حالته): يُرقّى هنا ولو فاتت ترقية الإقلاع
    if ((LEGACY_PENDING_STATUSES as readonly string[]).includes(u.status) && await promoteLegacyAffiliate(u.id, u.status)) u.status = 'approved';
    req.affiliate = u;
    next();
  } catch (e) { next(e); }
}

/**
 * سفيرٌ مقبول **وقابلٌ للشروط الحالية**. بوابة الواجهة وحدها لا تكفي: من يتجاهل
 * إصداراً جديداً كان سيواصل الترشيح والكسب بشروطٍ نُسخت (الشروط §٧).
 * `/me` و`/accept-terms` خارج هذا الحارس ليبقى طريق القبول مفتوحاً.
 */
async function requireApproved(req: AxRequest, res: Response, next: NextFunction): Promise<void> {
  const st = req.affiliate?.status;
  if (st !== 'approved') {
    const msg = st === 'suspended' ? 'الحساب موقوف' : 'الحساب غير مقبول';
    res.status(403).json({ success: false, message: msg }); return;
  }
  try {
    const s = await getSettings();
    if (req.affiliate!.termsVersion !== s.currentTermsVersion) {
      res.status(403).json({ success: false, message: 'نُشرت شروطٌ جديدة — اقرأها واقبلها للمتابعة', code: 'terms_outdated' }); return;
    }
    next();
  } catch (e) { next(e); }
}

const vat = z.string().trim().regex(/^\d{15}$/, 'الرقم الضريبي 15 رقماً');

// ───────────────────────────── عام ─────────────────────────────

router.get('/terms/public', async (_req, res, next) => {
  try {
    const s = await getSettings();
    const terms = await getTerms(s.currentTermsVersion);
    res.json({ success: true, data: {
      version: s.currentTermsVersion, body: terms?.body ?? '', disclosureText: s.disclosureText,
      rateBps: s.rateBps, holdDays: s.holdDays, minPayoutHalalas: s.minPayoutHalalas, refWindowDays: s.refWindowDays, intakeOpen: s.intakeOpen,
    } });
  } catch (e) { next(e); }
});

const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(160),
  phone: z.string().max(30),
  city: z.string().trim().max(60).optional().nullable(),
  password: z.string().min(8, 'كلمة المرور 8 أحرف على الأقل').max(128),
  // v2 (V2_SPEC §3): نوع السفير إلزاميّ عند التسجيل، واسم الشركة إلزاميّ للشركة (ويُقبل لغيرها: وكالة المؤثّر مثلاً)
  partnerType: z.enum(PARTNER_TYPES),
  companyName: z.string().trim().max(120).optional().nullable(),
  socialLinks: z.unknown().optional(),
  // «سأنشر علناً» وترخيص موثوق والإقرارات أُلغيت من الانضمام بقرار المالك («لا نريد تقييد
  // السفير») — تُقبل من نسخةٍ قديمة مخزَّنة في متصفّح ولا تُشترط ولا تُحفظ
  publicPromoter: z.boolean().optional(),
  mawthooqNo: z.string().trim().max(40).optional().nullable(),
  mawthooqExpiry: z.string().max(20).optional().nullable(),
  vatNumber: vat.optional().nullable().or(z.literal('')),
  marketingConsent: z.boolean().optional().default(false),
  acceptTerms: z.literal(true),
  termsVersion: z.string().min(1).max(40),
  declarations: z.record(z.boolean()).optional(),
});

/** اسم الشركة للشركة: ٢..١٢٠ — وإلا رسالة الخطأ (null = صالح) */
function companyNameProblem(partnerType: string | null | undefined, companyName: string | null | undefined): string | null {
  const name = (companyName ?? '').trim();
  if (partnerType === 'company' && name.length < 2) return 'اكتب اسم الشركة';
  if (name && name.length > 120) return 'اسم الشركة طويل';
  return null;
}

/** مهلة البريد لكلّ عنوان: الاستعادة لا تُغرق صندوق أحدٍ ولا حصّة الإرسال */
const MAIL_COOLDOWN_MS = 5 * 60_000;

/** يحجز حقّ الإرسال ذرّياً — طلبان متزامنان لا يرسلان رسالتين */
async function claimMailSlot(userId: string): Promise<boolean> {
  const won = await prisma.affiliateUser.updateMany({
    where: { id: userId, OR: [{ lastMailAt: null }, { lastMailAt: { lt: new Date(Date.now() - MAIL_COOLDOWN_MS) } }] },
    data: { lastMailAt: new Date() },
  });
  return won.count === 1;
}

/**
 * التسجيل **فوريّ** (قرار المالك ١٨ نوفمبر ٢٠٢٦ — V2_SPEC §0 و§6.1): الحساب يُنشأ approved ويُعاد التوكن فيدخل
 * صاحبه البوابة مباشرةً — بلا تأكيد بريدٍ ولا موافقة، كالتسجيل التجريبي للشركات. والبريد المسجَّل 409 «سجّل الدخول»
 * (لا كتابة فوق حسابٍ قائم أبداً — صاحبه يستعيد كلمة مروره من /forgot). بريد ترحيبٍ للسفير برابطه، وبريد «سفير جديد»
 * للمالك. يبقى axRegisterLimiter (6/ساعة/IP).
 */
router.post('/register', axRegisterLimiter, async (req, res, next) => {
  try {
    const b = registerSchema.parse(req.body);
    const settings = await getSettings();
    if (!settings.intakeOpen) { res.status(403).json({ success: false, message: 'الانضمام مغلق حالياً' }); return; }
    if (b.termsVersion !== settings.currentTermsVersion) {
      res.status(409).json({ success: false, message: 'تحدّثت الشروط — أعد تحميل الصفحة واقرأها', code: 'terms_outdated' }); return;
    }
    // جوالٌ من أيّ دولة: السعوديّ بصيغته، وغيره بمفتاح دولته — انظر normAffiliatePhone
    const phone = normAffiliatePhone(b.phone);
    if (!phone) { res.status(400).json({ success: false, message: 'رقم الجوال غير صحيح اختر مفتاح الدولة وأدخل الرقم' }); return; }
    const companyProblem = companyNameProblem(b.partnerType, b.companyName);
    if (companyProblem) { res.status(400).json({ success: false, message: companyProblem }); return; }
    const social = normSocialLinks(b.socialLinks);
    if (!social.ok) { res.status(400).json({ success: false, message: social.reason }); return; }

    const email = normEmail(b.email);
    if (await prisma.affiliateUser.findUnique({ where: { email }, select: { id: true } })) { res.status(409).json(EMAIL_TAKEN); return; }
    const now = new Date();
    const profile = {
      passwordHash: hashPassword(b.password), fullName: b.fullName, phone, city: b.city || null,
      termsVersion: b.termsVersion, termsAcceptedAt: now, termsIpHash: ipHash(req.ip),
      marketingConsent: b.marketingConsent, publicPromoter: false, mawthooqNo: null, mawthooqExpiry: null,
      vatNumber: b.vatNumber || null,
      status: 'approved', emailVerifiedAt: null, lastLoginAt: now,
      partnerType: b.partnerType, companyName: (b.companyName ?? '').trim() || null,
      socialLinks: social.links.length ? social.links as unknown as Prisma.InputJsonValue : Prisma.DbNull,
    };

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const u = await prisma.$transaction(async tx => {
          const row = await tx.affiliateUser.create({ data: { email, code: generateCode(), ...profile } });
          await logEvent(tx, {
            entity: 'user', entityId: row.id, action: 'registered', toState: 'approved', actorType: 'affiliate', actorId: row.id,
            meta: { termsVersion: b.termsVersion, partnerType: b.partnerType, instant: true, declarations: b.declarations },
          });
          return row;
        });
        mailWelcome(u.email, referralLink(u.code));
        mailOwnerNewAffiliate(u);
        res.status(201).json({ success: true, data: { token: signSession(u.id, u.tokenVersion), user: publicUser(u) } });
        return;
      } catch (e) {
        if (isUniqueViolation(e, 'code')) continue;       // تصادم رمزٍ نادر — رمزٌ جديد
        if (isUniqueViolation(e, 'email')) { res.status(409).json(EMAIL_TAKEN); return; } // تسجيلان متزامنان بالبريد نفسه
        throw e;
      }
    }
    throw new Error('affiliate code generation exhausted');
  } catch (e) { next(e); }
});

/**
 * ردٌّ واحد لكلّ فشل: بريدٌ غير مسجّل، كلمة مرورٍ خاطئة، قفلٌ مؤقّت. التمييز بينها كان قناةً للتعداد:
 * «مقفل» بعد كلمة المرور الصحيحة يخبر المخمِّن أنّه أصاب.
 */
const LOGIN_FAIL = { success: false, message: 'تعذّر الدخول — تحقّق من البريد وكلمة المرور. وبعد محاولات متكرّرة يُقفل الدخول ربع ساعة (واستعادة كلمة المرور تفتحه)' };
const MAX_FAILS = 5;

/**
 * الدخول. **المحاولة تُحجز قبل فحص كلمة المرور** بزيادةٍ ذرّية مشروطة بعدم القفل:
 * قراءة العدّاد ثمّ كتابته كانت تجعل عشرين تخميناً متزامناً تُحسب محاولةً واحدة.
 * وتُنفَّذ الكتابة نفسها لبريدٍ غير موجود (على معرّفٍ لا يطابق شيئاً) فلا يكشف
 * زمنُ الردّ وجود الحساب. وكلّ سفيرٍ بكلمة مروره الصحيحة يدخل (الموقوف يرى حالته)، والإرث
 * pending_email/pending_review يُرقّى إلى approved عند نجاحه (v2 — كان pending_email يُردّ 401).
 */
router.post('/login', axAuthLimiter, async (req, res, next) => {
  try {
    const { email, password } = z.object({ email: z.string().max(160), password: z.string().max(128) }).parse(req.body);
    const u = await prisma.affiliateUser.findUnique({ where: { email: normEmail(email) } });
    const probeId = u?.id ?? crypto.randomUUID();
    const reserved = await prisma.$queryRaw<{ failedLogins: number }[]>`
      UPDATE affiliate_users SET "failedLogins" = "failedLogins" + 1
      WHERE id = ${probeId} AND ("lockedUntil" IS NULL OR "lockedUntil" < NOW())
      RETURNING "failedLogins"`;
    const ok = verifyPassword(password, u?.passwordHash);
    if (!u || reserved.length === 0) { res.status(401).json(LOGIN_FAIL); return; }

    const attempt = reserved[0].failedLogins;
    if (attempt > MAX_FAILS || (!ok && attempt >= MAX_FAILS)) {
      await prisma.$executeRaw`UPDATE affiliate_users SET "lockedUntil" = NOW() + INTERVAL '15 minutes', "failedLogins" = 0 WHERE id = ${u.id}`;
      res.status(401).json(LOGIN_FAIL); return;
    }
    if (!ok) { res.status(401).json(LOGIN_FAIL); return; }
    await promoteLegacyAffiliate(u.id, u.status);

    const fresh = await prisma.affiliateUser.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    res.json({ success: true, data: { token: signSession(fresh.id, fresh.tokenVersion), user: publicUser(fresh) } });
  } catch (e) { next(e); }
});

router.post('/forgot', axAuthLimiter, async (req, res, next) => {
  try {
    const { email } = z.object({ email: z.string().max(160) }).parse(req.body);
    const u = await prisma.affiliateUser.findUnique({ where: { email: normEmail(email) } });
    // v2: كلّ حسابٍ يستعيد — والإرث pending_* أيضاً (يُرقّى عند الاستعادة)، فصاحب البريد الذي سجّل به غيرُه يستردّه
    const eligible = !!u;
    const slot = await claimMailSlot(eligible ? u!.id : crypto.randomUUID());
    if (eligible && slot) mailReset(u!.email, u!.fullName, signPurpose('ax-reset', u!.id, u!.tokenVersion, '1h'));
    res.status(202).json(ACCEPTED);
  } catch (e) { next(e); }
});

/**
 * تعيين كلمة مرور جديدة **يُدخل صاحبها مباشرةً**: رابط البريد إثباتٌ أقوى من
 * كلمة المرور، فمن يُقفل حساب غيره بخمس محاولاتٍ خاطئة كلّ ربع ساعة لا يمنعه
 * من الدخول.
 */
router.post('/reset', axAuthLimiter, async (req, res, next) => {
  try {
    const { token, password } = z.object({ token: z.string().min(1).max(2000), password: z.string().min(8, 'كلمة المرور 8 أحرف على الأقل').max(128) }).parse(req.body);
    const p = verifyPurpose('ax-reset', token);
    if (!p) { res.status(400).json({ success: false, message: 'الرابط غير صالح أو منتهي الصلاحية' }); return; }
    // رفع tokenVersion يُبطل الرابط نفسه (استعمالٌ واحد) وكلّ الجلسات القائمة
    const won = await prisma.affiliateUser.updateMany({
      where: { id: p.uid, tokenVersion: p.tv },
      data: { passwordHash: hashPassword(password), tokenVersion: { increment: 1 }, failedLogins: 0, lockedUntil: null },
    });
    if (won.count !== 1) { res.status(400).json({ success: false, message: 'الرابط غير صالح أو استُعمل مسبقاً' }); return; }
    logEventSafe({ entity: 'user', entityId: p.uid, action: 'password_reset', actorType: 'affiliate', actorId: p.uid });
    const before = await prisma.affiliateUser.findUnique({ where: { id: p.uid }, select: { status: true, emailVerifiedAt: true } });
    if (before) await promoteLegacyAffiliate(p.uid, before.status);
    // رابط الاستعادة وصل الصندوق نفسه — إثبات ملكية البريد يُختم هنا (الانضمام الفوريّ بلا تأكيد)
    const fresh = await prisma.affiliateUser.update({
      where: { id: p.uid },
      data: { lastLoginAt: new Date(), ...(before && !before.emailVerifiedAt ? { emailVerifiedAt: new Date() } : {}) },
    });
    res.json({ success: true, data: { ok: true, token: signSession(fresh.id, fresh.tokenVersion), user: publicUser(fresh) } });
  } catch (e) { next(e); }
});

router.post('/click', axClickLimiter, async (req, res) => {
  try {
    const code = parseRef((req.body as { code?: unknown } | undefined)?.code);
    if (code) {
      const u = await prisma.affiliateUser.findUnique({ where: { code }, select: { status: true } });
      if (u?.status === 'approved') {
        const day = riyadhDay();
        await prisma.affiliateClickDaily.upsert({
          where: { code_day: { code, day } }, create: { code, day, count: 1 }, update: { count: { increment: 1 } },
        });
      }
    }
  } catch (e) {
    if (!isUniqueViolation(e)) console.error('[affiliate] click:', (e as Error).message);
  }
  res.status(204).end();
});

// ───────────────────────────── بجلسة ─────────────────────────────

/** دورة التسوية كل ١٠ أيام (V2_SPEC §0 و§5) — تعرضها البوابة مع «التسوية القادمة» */
const SETTLEMENT_EVERY_DAYS = 10;

/**
 * v2: ملف السفير كما تعرضه البوابة — مستنداته السارية بلا بايتات، واكتماله وما ينقصه (شرطٌ لدخول التسوية لا للحساب).
 * `canSetPayout` باقٍ `true` دائماً لنسخ الواجهة القديمة: بيانات الاستلام لم تعد مشروطةً بأوّل عمولة (قرار المالك).
 */
router.get('/me', axAuth, async (req: AxRequest, res, next) => {
  try {
    const u = req.affiliate!;
    const [s, documents] = await Promise.all([getSettings(), listDocuments(u.id)]);
    const missing = profileMissing({ partnerType: u.partnerType, hasIban: !!u.ibanEnc, docKinds: documents.map(d => d.kind) });
    res.json({ success: true, data: {
      user: { ...publicUser(u), documents, profileComplete: missing.length === 0, missing },
      settings: {
        disclosureText: s.disclosureText, rateBps: s.rateBps, holdDays: s.holdDays, minPayoutHalalas: s.minPayoutHalalas, currentTermsVersion: s.currentTermsVersion,
        // تبويب «افتح حساباً لشركة» يظهر بهذا وحده — مفتاح الإطفاء على الخادم لا في الواجهة
        portalTrialEnabled: portalTrialEnabled(),
        nextSettlementAt: nextSettlementAt().toISOString(),
        settlementEveryDays: SETTLEMENT_EVERY_DAYS,
      },
      link: referralLink(u.code),
      canSetPayout: true,
    } });
  } catch (e) { next(e); }
});

// الباقات والأسعار كما يعرضها السفير — من كتالوج الخادم، وبخصم سفير اليمن (مفتاح جواله +967)
router.get('/pricing', axAuth, async (req: AxRequest, res, next) => {
  try {
    res.json({ success: true, data: affiliatePricing(req.affiliate!.phone) });
  } catch (e) { next(e); }
});

router.put('/me', axAuth, async (req: AxRequest, res, next) => {
  try {
    // لا شرط «موثوق» ولا «سأنشر علناً» (قرار المالك): حقولهما القديمة تُقبل وتُهمل
    const b = z.object({
      city: z.string().trim().max(60).nullable().optional(),
      marketingConsent: z.boolean().optional(),
      vatNumber: vat.nullable().optional().or(z.literal('')),
      // v2 (V2_SPEC §6.1): النوع واسم الشركة وروابط التواصل — يكمل بها ملفه
      partnerType: z.enum(PARTNER_TYPES).optional(),
      companyName: z.string().trim().max(120).nullable().optional(),
      socialLinks: z.unknown().optional(),
    }).passthrough().parse(req.body);
    const u = req.affiliate!;
    const companyProblem = companyNameProblem(b.partnerType ?? u.partnerType, b.companyName !== undefined ? b.companyName : u.companyName);
    if (companyProblem) { res.status(400).json({ success: false, message: companyProblem }); return; }
    const social = b.socialLinks !== undefined ? normSocialLinks(b.socialLinks) : null;
    if (social && !social.ok) { res.status(400).json({ success: false, message: social.reason }); return; }
    await prisma.affiliateUser.update({
      where: { id: u.id },
      data: {
        ...(b.city !== undefined ? { city: b.city || null } : {}),
        ...(b.marketingConsent !== undefined ? { marketingConsent: b.marketingConsent } : {}),
        ...(b.vatNumber !== undefined ? { vatNumber: b.vatNumber || null } : {}),
        ...(b.partnerType !== undefined ? { partnerType: b.partnerType } : {}),
        ...(b.companyName !== undefined ? { companyName: (b.companyName ?? '').trim() || null } : {}),
        ...(social?.ok ? { socialLinks: social.links.length ? social.links as unknown as Prisma.InputJsonValue : Prisma.DbNull } : {}),
      },
    });
    // النوع يغيّر شرط السجل التجاري — اكتمال الملف يُعاد حسابه تحت قفل صفّه
    if (b.partnerType !== undefined) await refreshProfileCompletion(u.id);
    const fresh = await prisma.affiliateUser.findUniqueOrThrow({ where: { id: u.id } });
    const fields = Object.keys(b).filter(k => ['city', 'marketingConsent', 'vatNumber', 'partnerType', 'companyName', 'socialLinks'].includes(k));
    logEventSafe({ entity: 'user', entityId: u.id, action: 'profile_updated', actorType: 'affiliate', actorId: u.id, meta: { fields } });
    res.json({ success: true, data: { user: publicUser(fresh) } });
  } catch (e) { next(e); }
});

router.post('/accept-terms', axAuth, async (req: AxRequest, res, next) => {
  try {
    const { termsVersion } = z.object({ termsVersion: z.string().min(1).max(40) }).parse(req.body);
    const s = await getSettings();
    if (termsVersion !== s.currentTermsVersion) { res.status(409).json({ success: false, message: 'تحدّثت الشروط — أعد تحميل الصفحة' }); return; }
    const fresh = await prisma.affiliateUser.update({ where: { id: aid(req) }, data: { termsVersion, termsAcceptedAt: new Date(), termsIpHash: ipHash(req.ip) } });
    logEventSafe({ entity: 'user', entityId: fresh.id, action: 'terms_accepted', actorType: 'affiliate', actorId: fresh.id, meta: { termsVersion } });
    res.json({ success: true, data: { user: publicUser(fresh) } });
  } catch (e) { next(e); }
});

// ───────────────────────────── سفير مقبول ─────────────────────────────

/**
 * الرئيسية. v2 (V2_SPEC §6.1) يضيف: إجمالي الأرباح صافياً، والتسوية المعلّقة، والإحالات النشطة، ومعدّل التحويل
 * (كسرٌ 0..1 أو null)، وأرباح آخر ستة أشهر بتاريخ الدفعة، وموعد التسوية القادمة، وخطوات البداية. الحساب في
 * services/affiliate/portalStats.ts (نقيّ)، والاستعلامات هنا مقيّدة بـaffiliateId من التوكن.
 */
router.get('/dashboard', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const id = aid(req);
    const now = new Date();
    const since = riyadhDay(new Date(now.getTime() - 29 * DAY_MS));
    const draftIds = (await prisma.affiliatePayout.findMany({ where: { affiliateId: id, status: 'draft' }, select: { id: true } })).map(p => p.id);
    const [clicks, signups, activeReferrals, byStatus, adj, allAdj, monthly] = await Promise.all([
      prisma.affiliateClickDaily.aggregate({ where: { code: req.affiliate!.code, day: { gte: since } }, _sum: { count: true } }),
      prisma.tenantAttribution.count({ where: { affiliateId: id, status: { not: 'void' } } }),
      prisma.tenantAttribution.count({ where: { affiliateId: id, status: 'active' } }),
      prisma.affiliateCommission.groupBy({ by: ['status'], where: { affiliateId: id }, _sum: { commissionHalalas: true }, _count: { _all: true } }),
      // غير المسوّاة فقط: الواجهة تقول «تُحتسب في دفعتك القادمة»، وما سُوّي في دفعةٍ مسجَّلة انتهى أثره
      prisma.affiliateAdjustment.aggregate({ where: { affiliateId: id, OR: [{ payoutId: null }, { payoutId: { in: draftIds } }] }, _sum: { amountHalalas: true } }),
      // كلّ القيود — لإجمالي الأرباح صافياً (الاسترداد بعد الصرف يُنقصه)
      prisma.affiliateAdjustment.aggregate({ where: { affiliateId: id }, _sum: { amountHalalas: true } }),
      prisma.affiliateCommission.findMany({
        where: { affiliateId: id, status: { in: [...LIVE_COMMISSION_STATUSES] }, paymentPaidAt: { gte: monthsWindowStart(now) } },
        select: { paymentPaidAt: true, commissionHalalas: true }, take: 5000,
      }),
    ]);
    const sum = (...st: string[]) => byStatus.filter(r => st.includes(r.status)).reduce((s, r) => s + (r._sum.commissionHalalas ?? 0), 0);
    const count = (...st: string[]) => byStatus.filter(r => st.includes(r.status)).reduce((s, r) => s + r._count._all, 0);
    const clicks30d = clicks._sum.count ?? 0;
    const paidCompanies = count(...LIVE_COMMISSION_STATUSES);
    const approvedHalalas = sum('approved');
    const paidHalalas = sum('paid');
    const adjustmentsHalalas = adj._sum.amountHalalas ?? 0;
    res.json({ success: true, data: {
      clicks30d,
      signups,
      paidCompanies,
      pendingHalalas: sum('pending', 'on_hold'),
      approvedHalalas,
      paidHalalas,
      adjustmentsHalalas,
      ...earningsTotals({ approvedHalalas, paidHalalas, allAdjustmentsHalalas: allAdj._sum.amountHalalas ?? 0, openAdjustmentsHalalas: adjustmentsHalalas }),
      activeReferrals,
      conversionRate: conversionRate(paidCompanies, signups),
      earningsByMonth: earningsByMonth(monthly, now),
      nextSettlementAt: nextSettlementAt(now).toISOString(),
      steps: { account: true, shared: clicks30d > 0 || signups > 0, firstPaid: paidCompanies > 0 },
    } });
  } catch (e) { next(e); }
});

router.get('/companies', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const rows = await prisma.tenantAttribution.findMany({
      where: { affiliateId: aid(req) }, orderBy: { createdAt: 'desc' }, take: 500,
      include: { commission: { select: { status: true, commissionHalalas: true, eligibleAt: true, paymentPaidAt: true, affiliateId: true } } },
    });
    const now = Date.now();
    // حسابٌ فتحه السفير: فعّلته شركته أم ما زال ينتظر — بلا معرّف الشركة ولا شيءٍ من بيانات دخولها
    const pendingTenants = await pendingActivationTenantIds(rows.filter(a => a.source === 'portal').map(a => a.tenantId));
    res.json({ success: true, data: rows.map(a => ({
      id: a.id,
      tenantName: a.tenantNameSnapshot,
      source: a.source,
      // عمود «الطريقة» (V2_SPEC §7): رابطه أم رمزه المكتوب — للتسجيل الذاتيّ وحده، وما سواه بلا قناة (المراجعة #18)
      refVia: a.source === 'signup_code' ? a.refVia : null,
      // المسحوب (void) بلا حالة تفعيل: مديره المعطَّل يحمل حارساً فيُقرأ «منتظراً» خطأً
      activation: a.source === 'portal' && a.status !== 'void' ? (pendingTenants.has(a.tenantId) ? 'pending' : 'active') : null,
      status: a.status === 'void' ? 'void'
        : a.status === 'disputed' ? 'disputed'
        : a.commission ? 'paid'
        : a.firstPaymentDeadline.getTime() < now ? 'expired' : 'trial',
      signedUpAt: a.createdAt.toISOString(),
      firstPaymentDeadline: a.firstPaymentDeadline.toISOString(),
      firstPaidAt: a.commission?.paymentPaidAt.toISOString() ?? null,
      // عمولةٌ صُرفت لسفيرٍ سابقٍ ثمّ نُقل الإسناد تبقى له — لا تُعرض لغيره
      commission: a.commission && a.commission.affiliateId === aid(req)
        ? { status: a.commission.status, commissionHalalas: a.commission.commissionHalalas, eligibleAt: a.commission.eligibleAt.toISOString() } : null,
    })) });
  } catch (e) { next(e); }
});

const CLAIM_HOW = ['visit', 'relationship', 'event', 'online', 'other'] as const;
const MAX_OPEN_CLAIMS = 50;

router.post('/claims', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const b = z.object({
      companyName: z.string().trim().min(2).max(120),
      crNumber: z.string().max(30),
      // رقم التواصل مع المنشأة — إلزاميّ بقرار المالك، في خانته لا في الملاحظة
      contactPhone: z.string().max(30),
      city: z.string().trim().max(60).optional().nullable(),
      how: z.enum(CLAIM_HOW),
      note: z.string().trim().max(200).optional().nullable(),
    }).parse(req.body);
    const cr = normCR(b.crNumber);
    if (!cr) { res.status(400).json({ success: false, message: 'السجل التجاري 10 أرقام' }); return; }
    const contactPhone = normContactPhone(b.contactPhone);
    if (!contactPhone) { res.status(400).json({ success: false, message: 'رقم التواصل غير صحيح' }); return; }
    if (containsContactInfo(b.note) || containsContactInfo(b.companyName) || containsContactInfo(b.city)) {
      res.status(400).json({ success: false, message: 'أدخل رقم التواصل في خانته — ولا تكتب أرقاماً أو بريداً في الاسم أو المدينة أو الملاحظة' }); return;
    }
    const id = aid(req);
    // ترشيحه السابق بالسجل نفسه يُعاد كما هو — بلا كشفٍ لترشيحات غيره
    const mine = await prisma.affiliateClaim.findFirst({ where: { affiliateId: id, crNumber: cr, status: { in: ['under_review', 'approved', 'converted'] } }, select: { id: true } });
    if (mine) { res.status(201).json({ success: true, data: { id: mine.id, message: 'استلمنا الترشيح وسيُراجع' } }); return; }
    const open = await prisma.affiliateClaim.count({ where: { affiliateId: id, status: 'under_review' } });
    if (open >= MAX_OPEN_CLAIMS) { res.status(429).json({ success: false, message: 'لديك ترشيحات كثيرة قيد المراجعة — انتظر البتّ فيها', code: 'too_many_open_claims' }); return; }
    const claim = await prisma.$transaction(async tx => {
      const row = await tx.affiliateClaim.create({
        data: { affiliateId: id, companyName: b.companyName, companyNameNorm: normCompanyName(b.companyName), crNumber: cr, contactPhone, city: b.city || null, how: b.how, note: b.note || null },
      });
      await logEvent(tx, { entity: 'claim', entityId: row.id, action: 'submitted', toState: 'under_review', actorType: 'affiliate', actorId: id });
      return row;
    });
    res.status(201).json({ success: true, data: { id: claim.id, message: 'استلمنا الترشيح وسيُراجع' } });
  } catch (e) { next(e); }
});

router.get('/claims', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    await expireStaleClaims(aid(req));
    const rows = await prisma.affiliateClaim.findMany({ where: { affiliateId: aid(req) }, orderBy: { submittedAt: 'desc' }, take: 500 });
    res.json({ success: true, data: rows.map(c => ({
      id: c.id, companyName: c.companyName, crNumber: c.crNumber, contactPhone: c.contactPhone, city: c.city, how: c.how, status: c.status,
      lockedUntil: c.lockedUntil?.toISOString() ?? null, submittedAt: c.submittedAt.toISOString(),
    })) });
  } catch (e) { next(e); }
});

router.post('/claims/:id/withdraw', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const won = await prisma.affiliateClaim.updateMany({ where: { id: String(req.params.id), affiliateId: aid(req), status: 'under_review' }, data: { status: 'withdrawn' } });
    if (won.count !== 1) { res.status(409).json({ success: false, message: 'لا يُسحب إلا ترشيحٌ قيد المراجعة' }); return; }
    logEventSafe({ entity: 'claim', entityId: String(req.params.id), action: 'withdrawn', fromState: 'under_review', toState: 'withdrawn', actorType: 'affiliate', actorId: aid(req) });
    res.json({ success: true, data: { ok: true } });
  } catch (e) { next(e); }
});

// ───────────────────────────── حسابٌ يفتحه السفير ─────────────────────────────

/**
 * ردٌّ واحد مهما كانت النتيجة — فُتح، أو حُجب لأنّ المنشأة عميلٌ قائم، أو فحصٌ جاف. لا 409 ولا رابط
 * ولا معرّف شركة ولا بريد: الردّ لا يصلح أداةً لمعرفة «هل هذه المنشأة عميلٌ لكم؟».
 */
const TRIAL_ACCEPTED = { success: true, data: { message: 'استلمنا الطلب — إن كانت البيانات صحيحة فسيصل مسؤولَ الشركة بريدُ تفعيل الحساب' } };
const TRIAL_DISABLED = { success: false, message: 'فتح الحسابات من البوابة متوقّفٌ حالياً', code: 'portal_trial_disabled' };

const trialSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  adminName: z.string().trim().min(2).max(80),
  adminEmail: z.string().trim().email().max(160),
  adminPhone: z.string().max(30),
  countryCode: z.string().length(2).optional(),
  // اختياريّ (قرار المالك) — إن كُتب فعشرة أرقام، ويُفحص به العميل القائم والترشيحات
  crNumber: z.string().max(30).optional().nullable(),
  // إقرار السفير أنّ المنشأة طلبت الحساب ووافقت على بريد التفعيل — يُحفظ في حدث الإنشاء
  consent: z.literal(true),
  dryRun: z.boolean().optional(),
});

/**
 * السفير يفتح حساباً تجريبياً لمنشأة: الشركة تُنشأ ومديرها **بلا كلمة مرور**، ورابط التفعيل يذهب لبريد
 * المسؤول وحده (services/affiliate/portalTrial.ts). بريد السفير أو جواله مكان المسؤول يُرفض صراحةً —
 * المقارنة ببياناته هو فلا تكشف شيئاً.
 */
router.post('/trials', axAuth, requireApproved, axTrialLimiter, axTrialIpLimiter, async (req: AxRequest, res, next) => {
  try {
    if (!portalTrialEnabled()) { res.status(403).json(TRIAL_DISABLED); return; }
    const b = trialSchema.parse(req.body);
    const adminPhone = normAffiliatePhone(b.adminPhone);
    if (!adminPhone) { res.status(400).json({ success: false, message: 'رقم الجوال غير صحيح اختر مفتاح الدولة وأدخل الرقم' }); return; }
    const cr = b.crNumber ? normCR(b.crNumber) : null;
    if (b.crNumber && !cr) { res.status(400).json({ success: false, message: 'السجل التجاري 10 أرقام' }); return; }
    // الاسمان يصلان صاحب البريد داخل رسالةٍ رسمية — لا رقم ولا بريد ولا رابط فيهما
    if ([b.companyName, b.adminName].some(t => containsContactInfo(t) || containsLinkLike(t))) {
      res.status(400).json({ success: false, message: 'لا تكتب أرقاماً أو بريداً أو روابط في اسم المنشأة أو اسم المسؤول — البريد والجوال في خانتيهما' });
      return;
    }
    const u = req.affiliate!;
    if (isSelfContact({ affiliateEmail: u.email, affiliatePhone: u.phone, adminEmail: b.adminEmail, adminPhone })) {
      res.status(400).json({ success: false, message: 'هذا بريدك أو جوالك — أدخل بريد مسؤول الشركة وجواله. ولمنشأتك أنت سجّل من صفحة التسجيل برمزك', code: 'self_contact' });
      return;
    }
    await createPortalTrial(u, {
      companyName: b.companyName, adminName: b.adminName, adminEmail: normEmail(b.adminEmail), adminPhone,
      countryCode: b.countryCode ? b.countryCode.toUpperCase() : null, cr, dryRun: b.dryRun === true,
    }, { ipHash: ipHash(req.ip) });
    res.status(202).json(b.dryRun ? { ...TRIAL_ACCEPTED, data: { ...TRIAL_ACCEPTED.data, dryRun: true } } : TRIAL_ACCEPTED);
  } catch (e) { if (!ledgerFail(res, e)) next(e); }
});

/** إعادة إرسال رابط التفعيل إلى البريد المسجَّل وحده — بمهلةٍ وسقف، ويُبطل كلّ رابطٍ أقدم */
router.post('/trials/:id/resend', axAuth, requireApproved, axTrialLimiter, axTrialResendIpLimiter, async (req: AxRequest, res, next) => {
  try {
    if (!portalTrialEnabled()) { res.status(403).json(TRIAL_DISABLED); return; }
    await resendPortalActivation(aid(req), String(req.params.id));
    res.json({ success: true, data: { message: 'أُعيد إرسال بريد التفعيل إلى البريد المسجَّل' } });
  } catch (e) { if (!ledgerFail(res, e)) next(e); }
});

/** سحب حسابٍ فُتح بخطأ قبل تفعيله — يحرّر البريد والجوال ليُعاد فتحه صحيحاً. يبقى متاحاً ولو أُطفئ فتح الحسابات */
router.post('/trials/:id/withdraw', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    await withdrawPortalTrial(aid(req), String(req.params.id));
    res.json({ success: true, data: { ok: true } });
  } catch (e) { if (!ledgerFail(res, e)) next(e); }
});

router.get('/commissions', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const rows = await prisma.affiliateCommission.findMany({
      where: { affiliateId: aid(req) }, orderBy: { createdAt: 'desc' }, take: 500,
      include: { payout: { select: { status: true, transferredAt: true } } },
    });
    res.json({ success: true, data: rows.map(c => ({
      id: c.id, tenantName: c.tenantNameSnapshot, paymentAmountHalalas: c.paymentAmountHalalas, refundedHalalas: c.refundedHalalas, commissionHalalas: c.commissionHalalas,
      rateBps: c.rateBps, status: c.status, paymentPaidAt: c.paymentPaidAt.toISOString(), eligibleAt: c.eligibleAt.toISOString(),
      reasonNote: c.reasonNote,
      paidAt: c.status === 'paid' && c.payout?.status === 'recorded' ? (c.payout.transferredAt?.toISOString() ?? null) : null,
    })) });
  } catch (e) { next(e); }
});

router.get('/adjustments', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const rows = await prisma.affiliateAdjustment.findMany({ where: { affiliateId: aid(req) }, orderBy: { createdAt: 'desc' }, take: 500 });
    const payoutIds = [...new Set(rows.map(r => r.payoutId).filter((v): v is string => !!v))];
    const recorded = payoutIds.length
      ? new Set((await prisma.affiliatePayout.findMany({ where: { id: { in: payoutIds }, status: 'recorded' }, select: { id: true } })).map(p => p.id))
      : new Set<string>();
    res.json({ success: true, data: rows.map(a => ({
      id: a.id, kind: a.kind, amountHalalas: a.amountHalalas, note: a.note, createdAt: a.createdAt.toISOString(),
      settled: !!a.payoutId && recorded.has(a.payoutId),
    })) });
  } catch (e) { next(e); }
});

/**
 * التسويات: **كلّ** دفعاته (قيد المعالجة/مدفوعة/فشل التحويل) — والملغاة (void) تُخفى: لم تكن تحويلاً قط. الفترة من دورة
 * التسوية (V2_SPEC §5)، وسبب الفشل ليصحّح بيانات الآيبان.
 */
router.get('/payouts', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const rows = await prisma.affiliatePayout.findMany({ where: { affiliateId: aid(req), status: { not: 'void' } }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ success: true, data: rows.map(p => ({
      id: p.id, status: p.status,
      commissionsHalalas: p.commissionsHalalas, adjustmentsHalalas: p.adjustmentsHalalas, netHalalas: p.netHalalas,
      periodStart: p.periodStart?.toISOString() ?? null, periodEnd: p.periodEnd?.toISOString() ?? null,
      transferredAt: p.transferredAt?.toISOString() ?? null, bankReference: p.bankReference,
      ibanLast4: p.ibanLast4, failedReason: p.failedReason, createdAt: p.createdAt.toISOString(),
    })) });
  } catch (e) { next(e); }
});

/**
 * بيانات الاستلام — v2: **متاحة دائماً** بلا شرط «بعد أوّل عمولة» (قرار المالك ١٨ نوفمبر ٢٠٢٦: الآيبان جزءٌ من
 * «أكمل ملفك» الذي يُدخل التسوية). يبقى الآيبان السعودي بفحص mod-97، و409 مع دفعةٍ قيد المعالجة، والتنبيه بالبريد.
 */
router.put('/payout-profile', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const b = z.object({ iban: z.string().max(60), holderName: z.string().trim().min(2).max(120), bankName: z.string().trim().max(80).optional().nullable() }).parse(req.body);
    const iban = normIbanSA(b.iban);
    if (!iban) { res.status(400).json({ success: false, message: 'الآيبان السعودي غير صحيح' }); return; }
    // مسودّة دفعةٍ قائمة تحمل آخر أربعة للآيبان القديم — تغييره الآن يُربك التحويل
    const draft = await prisma.affiliatePayout.count({ where: { affiliateId: aid(req), status: 'draft' } });
    if (draft) { res.status(409).json({ success: false, message: 'لديك دفعة قيد التحويل — عدّل بيانات الاستلام بعد تسجيلها' }); return; }
    const updated = await prisma.affiliateUser.update({
      where: { id: aid(req) },
      data: { ibanEnc: encryptIban(iban), ibanLast4: iban.slice(-4), ibanHolderName: b.holderName, bankName: b.bankName || null, payoutUpdatedAt: new Date() },
    });
    logEventSafe({ entity: 'user', entityId: updated.id, action: 'payout_profile_updated', actorType: 'affiliate', actorId: updated.id, meta: { ibanLast4: updated.ibanLast4 } });
    mailPayoutProfileChanged(updated.email, updated.fullName, updated.ibanLast4 ?? '');
    await refreshProfileCompletion(updated.id);
    const fresh = await prisma.affiliateUser.findUniqueOrThrow({ where: { id: updated.id } });
    res.json({ success: true, data: { user: publicUser(fresh) } });
  } catch (e) { next(e); }
});

// ───────────────────────────── المستندات (v2) ─────────────────────────────

/** رفع المستندات لكلّ سفير لا لكلّ IP — كلّ رفعٍ يستبدل سابقه، والحدّ يمنع إغراق القاعدة بالكتابة */
const axDocLimiter = rateLimit({
  ...limiterBase, windowMs: 60 * 60_000, limit: 30,
  keyGenerator: (req) => `ax-doc:${(req as AxRequest).affiliate?.id ?? 'anon'}`,
  message: { success: false, message: 'رفعٌ كثير من حسابك — حاول بعد ساعة' },
});

/**
 * تنزيل الملفات — المادّة (≤ ٨ ميغابايت) والمستند (≤ ٥) — يقرأ الملف كاملاً من القاعدة ويبني data URL في الذاكرة (العقد
 * `{dataUrl}` تعتمد عليه البوابة)، أي عشرات الميغابايت لكلّ طلبٍ قائم. والحساب صار فورياً (v2)، فبلا حدٍّ كان طلبٌ صغيرٌ من
 * حسابٍ عمره دقيقة يكفي لإغراق ذاكرة الخادم المشترك بين كلّ الشركات (المراجعة #7). حدّان:
 * - **لكلّ سفير** ٦٠ تنزيلاً في الساعة (بمعرّفه من التوكن، عدّادٌ واحد للمواد والمستندات).
 * - **التنزيلات المتزامنة**: اثنان لكلّ سفير وأربعة للخادم كلّه — الحدّ بالعدد وحده لا يمنع دفعةً متزامنة من عشرين طلباً.
 *   المقعد يُحرَّر حين ينتهي المعالج **و**يُغلق الردّ (اكتمل أو انقطع) معاً، وللإرسال مهلة ٦٠ ثانية.
 */
const axFileLimiter = rateLimit({
  ...limiterBase, windowMs: 60 * 60_000, limit: 60,
  keyGenerator: (req) => `ax-file:${(req as AxRequest).affiliate?.id ?? 'anon'}`,
  message: { success: false, message: 'تنزيلاتٌ كثيرة من حسابك — حاول بعد ساعة' },
});
const FILE_INFLIGHT_MAX = 4;
const FILE_INFLIGHT_PER_AFFILIATE = 2;
const FILE_SEND_DEADLINE_MS = 60_000;
let fileInflight = 0;
const fileInflightBy = new Map<string, number>();
const FILE_BUSY = { success: false, message: 'تنزيلاتٌ كثيرة جارية الآن — حاول بعد لحظات', code: 'file_busy' };

function fileSlot(req: AxRequest, res: Response, next: NextFunction): void {
  const id = aid(req);
  const mine = fileInflightBy.get(id) ?? 0;
  if (fileInflight >= FILE_INFLIGHT_MAX || mine >= FILE_INFLIGHT_PER_AFFILIATE) {
    res.set('Retry-After', '5');
    res.status(429).json(FILE_BUSY);
    return;
  }
  fileInflight++;
  fileInflightBy.set(id, mine + 1);
  // المقعد لا يُحرَّر إلا بشرطين معاً: انتهى المعالج (قرأ البايتات من القاعدة ورمّزها) **و**أُغلق الردّ (اكتمل أو انقطع).
  // فالعميل الذي يقطع الطلب فوراً لا يستعيد مقعده والمعالج ما زال يحمّل ٨ ميغابايت (مراجعة ١٨ نوفمبر)،
  // والقارئ البطيء جداً تقطعه مهلة الإرسال فلا يحتجز مقعداً من مقاعد الخادم الأربعة إلى الأبد.
  let released = false, handlerDone = false, responseClosed = false;
  const tryRelease = () => {
    if (released || !handlerDone || !responseClosed) return;
    released = true;
    fileInflight--;
    const left = (fileInflightBy.get(id) ?? 1) - 1;
    if (left > 0) fileInflightBy.set(id, left); else fileInflightBy.delete(id);
  };
  const onClosed = () => { responseClosed = true; tryRelease(); };
  res.once('finish', onClosed);
  res.once('close', onClosed);
  res.locals.releaseFileSlot = () => { handlerDone = true; tryRelease(); };
  res.setTimeout(FILE_SEND_DEADLINE_MS, () => res.destroy());
  next();
}
/** يُنادى في finally كلّ معالجٍ خلف fileSlot — بعد res.json أو مسار الخطأ */
const releaseFileSlot = (res: Response) => { (res.locals.releaseFileSlot as (() => void) | undefined)?.(); };

const docKindParam = (req: Request) => {
  const k = String(req.params.kind);
  return isDocKind(k) ? k : null;
};
const BAD_KIND = { success: false, message: `نوع المستند غير معروف — ${DOC_KINDS.join(' أو ')}` };

/**
 * صورة الهوية/الإقامة أو السجل التجاري — data URL (base64) يُفحص نوعه من البايتات (JPEG/PNG/WebP/PDF ≤ ٥ ميغابايت)،
 * ويُشفَّر ويستبدل السابق من نوعه، ويُحدَّث اكتمال الملف (services/affiliate/documents.ts).
 */
router.post('/documents', axAuth, requireApproved, axDocLimiter, async (req: AxRequest, res, next) => {
  try {
    const b = z.object({ kind: z.enum(DOC_KINDS), dataUrl: z.string().max(8_000_000) }).parse(req.body);
    const file = parseDocumentDataUrl(b.dataUrl);
    if (!file.ok) { res.status(400).json({ success: false, message: file.reason, code: 'document_invalid' }); return; }
    const doc = await saveDocument(aid(req), b.kind, { mime: file.mime, bytes: file.bytes });
    res.status(201).json({ success: true, data: doc });
  } catch (e) { next(e); }
});

/** معاينة ما رفعه هو — مستنده وحده (المعرّف من التوكن) */
router.get('/documents/:kind', axAuth, requireApproved, axFileLimiter, fileSlot, async (req: AxRequest, res, next) => {
  try {
    const kind = docKindParam(req);
    if (!kind) { res.status(400).json(BAD_KIND); return; }
    const dataUrl = await documentDataUrl(aid(req), kind);
    if (!dataUrl) { res.status(404).json({ success: false, message: 'لا يوجد مستندٌ من هذا النوع' }); return; }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { dataUrl } });
  } catch (e) { next(e); } finally { releaseFileSlot(res); }
});

/** حذفٌ حقيقيّ — والملف يعود ناقصاً إن كان المستند شرطاً */
router.delete('/documents/:kind', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const kind = docKindParam(req);
    if (!kind) { res.status(400).json(BAD_KIND); return; }
    if (!(await deleteDocument(aid(req), kind))) { res.status(404).json({ success: false, message: 'لا يوجد مستندٌ من هذا النوع' }); return; }
    res.json({ success: true, data: { ok: true } });
  } catch (e) { next(e); }
});

// ───────────────────────────── المطالبة بإحالة فائتة (v2) ─────────────────────────────

/** حدّ المطالبات المفتوحة — ردٌّ واحد سواءٌ التقطه عدّ المسار أو فحص الخدمة في سباق إرسالين (409 `open_limit` هناك) */
const TOO_MANY_OPEN_MISSED = { success: false, message: 'لديك مطالباتٌ كثيرة قيد المراجعة — انتظر البتّ فيها', code: 'too_many_open_missed_claims' };

/** 400 من zod **برمز `invalid`** وبشكل errorHandler نفسه (`errors` لكلّ حقل) — فتبقى رسائل الحقول المترجمة في البوابة */
function zodInvalid(res: Response, e: unknown): boolean {
  if (!(e instanceof ZodError)) return false;
  const errors = e.flatten().fieldErrors;
  const fields = Object.keys(errors);
  res.status(400).json({ success: false, message: fields.length ? `بيانات غير صحيحة ${fields.join('، ')}` : 'بيانات غير صحيحة', code: 'invalid', errors });
  return true;
}

/**
 * شركةٌ أحالها ثمّ سجّلت دون رابطه أو رمزه (V2_SPEC §6.1): يرفع مطالبةً خلال ٣٠ يوماً من تسجيلها (الشروط v4 §٣) فيراجعها
 * المالك ويسندها يدوياً أو يرفض. الاسم والملاحظة بلا جوالٍ ولا بريد (الجوال في خانته)، وحتى ٢٠ مطالبة مفتوحة.
 *
 * الرموز كما في API.md (المراجعة #13 و#21): التحقّق من `normalizeMissedClaim` نفسها لا نسخةٍ هنا — كانت النسخة تردّ 400 بلا
 * رمز فلا يصل `contact_in_text`/`invalid_phone`/`invalid_cr` الموثّقة أبداً. و`invalid` لشكل الجسم (zod)، و429
 * `too_many_open_missed_claims` للحدّ.
 */
router.post('/missed-claims', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const b = z.object({
      companyName: z.string().trim().min(2).max(120),
      contactPhone: z.string().max(30).optional().nullable(),
      crNumber: z.string().max(30).optional().nullable(),
      note: z.string().trim().max(200).optional().nullable(),
    }).parse(req.body);
    const v = normalizeMissedClaim(b);
    const id = aid(req);
    const open = await prisma.affiliateMissedClaim.count({ where: { affiliateId: id, status: 'under_review' } });
    if (open >= MISSED_CLAIM_OPEN_LIMIT) { res.status(429).json(TOO_MANY_OPEN_MISSED); return; }
    const row = await createMissedClaim(id, v);
    res.status(201).json({ success: true, data: { id: row.id, message: 'استلمنا المطالبة وستُراجع' } });
  } catch (e) {
    if (zodInvalid(res, e)) return;
    if (e instanceof LedgerError && e.code === 'open_limit') { res.status(429).json(TOO_MANY_OPEN_MISSED); return; }
    if (!ledgerFail(res, e)) next(e);
  }
});

router.get('/missed-claims', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    res.json({ success: true, data: await listMissedClaims(aid(req)) });
  } catch (e) { next(e); }
});

router.post('/missed-claims/:id/withdraw', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    await withdrawMissedClaim(aid(req), String(req.params.id));
    res.json({ success: true, data: { ok: true } });
  } catch (e) { if (!ledgerFail(res, e)) next(e); }
});

// ───────────────────────────── المواد التسويقية (v2) ─────────────────────────────

/** مكتبة المالك للسفراء — عامّة لكلّ سفيرٍ مقبول (لا بيانات سفيرٍ فيها) */
router.get('/materials', axAuth, requireApproved, async (_req: AxRequest, res, next) => {
  try {
    res.json({ success: true, data: await listMaterials() });
  } catch (e) { next(e); }
});

/** الملف `{dataUrl}` — خلف حدّ التنزيل لكلّ سفير وسقف المتزامن (axFileLimiter وfileSlot أعلاه) */
router.get('/materials/:id/file', axAuth, requireApproved, axFileLimiter, fileSlot, async (req: AxRequest, res, next) => {
  try {
    const f = await materialFile(String(req.params.id));
    if (!f) { res.status(404).json({ success: false, message: 'الملف غير موجود' }); return; }
    res.json({ success: true, data: f });
  } catch (e) { next(e); } finally { releaseFileSlot(res); }
});

export default router;
