/**
 * بوابة «سفير فيلد سيلز» — `/api/affiliate`. الأشكال في docs/affiliate/API.md.
 *
 * العزل (CONTRACT §1.7): سرٌّ مشتقّ وحمولة `kind:'affiliate'`، فلا توكن شركةٍ
 * يصلح هنا ولا العكس. ومعرّف السفير يُقرأ من التوكن وحده — لا من جسمٍ ولا
 * مسار (درس IDOR في منصّة الصيد)؛ وكلّ قراءةٍ مقيّدة بـ`affiliateId` منه.
 *
 * ولا تعداد حسابات: التسجيل والاستعادة وإعادة الإرسال تردّ 202 موحّدة، وخطأ
 * الدخول واحدٌ لا يميّز «بريدٌ غير موجود» من «كلمة مرور خاطئة».
 */
import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import prisma from '../config/database';
import {
  getSettings, getTerms, logEvent, logEventSafe, signSession, verifySession, signPurpose, verifyPurpose,
  hashPassword, verifyPassword, ipHash, encryptIban, referralLink, riyadhDay, isUniqueViolation, DAY_MS,
} from '../services/affiliate/core';
import { generateCode, normEmail, normPhoneSA, normCR, normCompanyName, containsContactInfo, normIbanSA, parseRef } from '../services/affiliate/rules';
import { mailVerify, mailReset, mailOwnerNewApplicant, mailPayoutProfileChanged } from '../services/affiliate/mail';
import { expireStaleClaims } from '../services/affiliate/ledger';

const router = Router();

const limiterBase = { standardHeaders: true, legacyHeaders: false } as const;
const axAuthLimiter = rateLimit({ ...limiterBase, windowMs: 15 * 60_000, limit: 20, message: { success: false, message: 'محاولات كثيرة انتظر ربع ساعة ثم حاول مجددا' } });
const axRegisterLimiter = rateLimit({ ...limiterBase, windowMs: 60 * 60_000, limit: 6, message: { success: false, message: 'طلبات تسجيل كثيرة حاول بعد ساعة' } });
const axClickLimiter = rateLimit({ ...limiterBase, windowMs: 60_000, limit: 30, message: { success: false } });

const ACCEPTED = { success: true, data: { message: 'إن كانت البيانات صحيحة فستصلك رسالة على بريدك' } };

type AffiliateRow = NonNullable<Awaited<ReturnType<typeof prisma.affiliateUser.findUnique>>>;
interface AxRequest extends Request { affiliate?: AffiliateRow }

const aid = (req: AxRequest) => req.affiliate!.id;

function publicUser(u: AffiliateRow) {
  return {
    id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, city: u.city, code: u.code,
    status: u.status, statusReason: u.statusReason, publicPromoter: u.publicPromoter,
    mawthooqNo: u.mawthooqNo, mawthooqExpiry: u.mawthooqExpiry ? riyadhDay(u.mawthooqExpiry) : null,
    vatNumber: u.vatNumber, marketingConsent: u.marketingConsent, termsVersion: u.termsVersion,
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
    if (!u || u.tokenVersion !== s.tv || u.status === 'pending_email') {
      res.status(401).json({ success: false, message: 'انتهت الجلسة سجل الدخول مجددا' }); return;
    }
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
    const msg = st === 'pending_review' ? 'طلبك قيد المراجعة' : st === 'suspended' ? 'الحساب موقوف' : 'الحساب غير مقبول';
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

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'تاريخ غير صحيح');
const riyadhDate = (s: string) => new Date(`${s}T00:00:00+03:00`);
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
  publicPromoter: z.boolean(),
  mawthooqNo: z.string().trim().max(40).optional().nullable(),
  mawthooqExpiry: dateStr.optional().nullable(),
  vatNumber: vat.optional().nullable().or(z.literal('')),
  marketingConsent: z.boolean().optional().default(false),
  acceptTerms: z.literal(true),
  termsVersion: z.string().min(1).max(40),
  declarations: z.object({ independent: z.literal(true), noSpam: z.literal(true), disclose: z.literal(true), noSelfReferral: z.literal(true) }),
});

/** الترخيص ساري **حتى نهاية** يوم انتهائه بتوقيت الرياض — المقارنة بين أيّامٍ لا لحظات */
function mawthooqProblem(publicPromoter: boolean, no?: string | null, expiry?: string | null): string | null {
  if (!publicPromoter) return null;
  if (!no || !expiry) return 'النشر العلني يتطلّب رقم ترخيص موثوق وتاريخ انتهائه';
  if (expiry < riyadhDay()) return 'ترخيص موثوق منتهٍ';
  return null;
}

/** مهلة البريد لكلّ عنوان: التسجيل وإعادة الإرسال والاستعادة لا تُغرق صندوق أحدٍ ولا حصّة الإرسال */
const MAIL_COOLDOWN_MS = 5 * 60_000;

/** يحجز حقّ الإرسال ذرّياً — طلبان متزامنان لا يرسلان رسالتين */
async function claimMailSlot(userId: string): Promise<boolean> {
  const won = await prisma.affiliateUser.updateMany({
    where: { id: userId, OR: [{ lastMailAt: null }, { lastMailAt: { lt: new Date(Date.now() - MAIL_COOLDOWN_MS) } }] },
    data: { lastMailAt: new Date() },
  });
  return won.count === 1;
}

router.post('/register', axRegisterLimiter, async (req, res, next) => {
  try {
    const b = registerSchema.parse(req.body);
    const settings = await getSettings();
    if (!settings.intakeOpen) { res.status(403).json({ success: false, message: 'الانضمام مغلق حالياً' }); return; }
    if (b.termsVersion !== settings.currentTermsVersion) { res.status(409).json({ success: false, message: 'تحدّثت الشروط — أعد تحميل الصفحة واقرأها' }); return; }
    const phone = normPhoneSA(b.phone);
    if (!phone) { res.status(400).json({ success: false, message: 'رقم الجوال السعودي غير صحيح' }); return; }
    const mp = mawthooqProblem(b.publicPromoter, b.mawthooqNo, b.mawthooqExpiry);
    if (mp) { res.status(400).json({ success: false, message: mp }); return; }

    const email = normEmail(b.email);
    // التجزئة قبل البحث: scrypt يستغرق عشرات الملّي ثانية، وتخطّيه للبريد المسجَّل
    // كان سيجعل زمن الردّ نفسه يكشف ما تخفيه الـ202 الموحّدة
    const passwordHash = hashPassword(b.password);
    const profile = {
      passwordHash, fullName: b.fullName, phone, city: b.city || null,
      termsVersion: b.termsVersion, termsAcceptedAt: new Date(), termsIpHash: ipHash(req.ip),
      marketingConsent: b.marketingConsent, publicPromoter: b.publicPromoter,
      mawthooqNo: b.publicPromoter ? b.mawthooqNo : null,
      mawthooqExpiry: b.publicPromoter && b.mawthooqExpiry ? riyadhDate(b.mawthooqExpiry) : null,
      vatNumber: b.vatNumber || null,
    };
    const existing = await prisma.affiliateUser.findUnique({ where: { email } });
    if (existing) {
      if (existing.status === 'pending_email') {
        // حسابٌ لم يؤكَّد يُحدَّث بآخر طلب — والتأكيد نفسه يطلب كلمة المرور (انظر
        // /verify-email)، فمن يكتب فوق طلب غيره لا يستطيع تفعيله دون صندوق البريد،
        // وصاحب البريد لا يُفعِّل كلمة مرورٍ لا يعرفها
        const won = await prisma.affiliateUser.updateMany({ where: { id: existing.id, status: 'pending_email' }, data: { ...profile, failedLogins: 0, lockedUntil: null } });
        if (won.count === 1) {
          logEventSafe({ entity: 'user', entityId: existing.id, action: 're_registered', fromState: 'pending_email', toState: 'pending_email', actorType: 'affiliate', actorId: existing.id });
          if (await claimMailSlot(existing.id)) mailVerify(existing.email, existing.fullName, signPurpose('ax-verify', existing.id, existing.tokenVersion, '2d'));
        }
      } else {
        // كتابةٌ بكلفة الإنشاء تقريباً — زمن الردّ لا يميّز البريد المسجَّل
        await logEvent(prisma, { entity: 'user', entityId: existing.id, action: 'register_attempt_existing', actorType: 'system' });
      }
      res.status(202).json(ACCEPTED); return;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const u = await prisma.$transaction(async tx => {
          const row = await tx.affiliateUser.create({ data: { email, code: generateCode(), lastMailAt: new Date(), ...profile } });
          await logEvent(tx, { entity: 'user', entityId: row.id, action: 'registered', toState: 'pending_email', actorType: 'affiliate', actorId: row.id, meta: { termsVersion: b.termsVersion, declarations: b.declarations } });
          return row;
        });
        mailVerify(u.email, u.fullName, signPurpose('ax-verify', u.id, u.tokenVersion, '2d'));
        break;
      } catch (e) {
        if (isUniqueViolation(e, 'code')) continue;       // تصادم رمزٍ نادر — رمزٌ جديد
        if (isUniqueViolation(e, 'email')) break;         // تسجيلان متزامنان بالبريد نفسه
        throw e;
      }
    }
    res.status(202).json(ACCEPTED);
  } catch (e) { next(e); }
});

const BAD_VERIFY = { success: false, message: 'رابط التأكيد غير صالح أو منتهي الصلاحية' };

/**
 * التأكيد يطلب **كلمة المرور التي سُجّل بها آخر طلب**: البريد يُثبت ملكية الصندوق،
 * وكلمة المرور تُثبت أنّ صاحب الصندوق هو صاحب الطلب. بدونها يستطيع من يعرف بريد
 * غيره أن يسجّل به بكلمة مروره هو، فيؤكّده صاحب البريد بنقرةٍ بريئة.
 */
router.post('/verify-email', axAuthLimiter, async (req, res, next) => {
  try {
    const { token, password } = z.object({ token: z.string().min(1).max(2000), password: z.string().max(128) }).parse(req.body);
    const p = verifyPurpose('ax-verify', token);
    const u = p ? await prisma.affiliateUser.findUnique({ where: { id: p.uid } }) : null;
    const ok = verifyPassword(password, u?.passwordHash);
    if (!p || !u || u.tokenVersion !== p.tv) { res.status(400).json(BAD_VERIFY); return; }
    if (u.status !== 'pending_email') { res.json({ success: true, data: { status: u.status } }); return; }
    if (!ok) {
      res.status(400).json({ success: false, message: 'كلمة المرور لا تطابق آخر طلب انضمامٍ بهذا البريد — إن لم تكن أنت من قدّمه فقدّم طلبك من جديد', code: 'password_mismatch' });
      return;
    }
    const won = await prisma.affiliateUser.updateMany({
      where: { id: u.id, status: 'pending_email', tokenVersion: p.tv, passwordHash: u.passwordHash },
      // محاولات دخولٍ بكلمة مرورٍ صحيحة قبل التأكيد حُجزت ولم تُردّ — تُصفَّر هنا لا تُورَث
      data: { status: 'pending_review', emailVerifiedAt: new Date(), failedLogins: 0, lockedUntil: null },
    });
    if (won.count !== 1) { res.status(409).json({ success: false, message: 'تغيّر الطلب للتوّ — افتح أحدث رسالة تأكيد' }); return; }
    logEventSafe({ entity: 'user', entityId: u.id, action: 'email_verified', fromState: 'pending_email', toState: 'pending_review', actorType: 'affiliate', actorId: u.id });
    mailOwnerNewApplicant(u);
    res.json({ success: true, data: { status: 'pending_review' } });
  } catch (e) { next(e); }
});

router.post('/resend-verification', axAuthLimiter, async (req, res, next) => {
  try {
    const { email } = z.object({ email: z.string().max(160) }).parse(req.body);
    const u = await prisma.affiliateUser.findUnique({ where: { email: normEmail(email) } });
    // الكتابة نفسها في كلّ الفروع — زمن الردّ لا يكشف وجود البريد ولا حالته
    const eligible = u?.status === 'pending_email';
    const slot = await claimMailSlot(eligible ? u!.id : crypto.randomUUID());
    if (eligible && slot) mailVerify(u!.email, u!.fullName, signPurpose('ax-verify', u!.id, u!.tokenVersion, '2d'));
    res.status(202).json(ACCEPTED);
  } catch (e) { next(e); }
});

/**
 * ردٌّ واحد لكلّ فشل: بريدٌ غير مسجّل، كلمة مرورٍ خاطئة، بريدٌ لم يؤكَّد، قفلٌ مؤقّت.
 * التمييز بينها كان قناتين للتعداد: «مقفل» بعد كلمة المرور الصحيحة يخبر المخمِّن
 * أنّه أصاب، و«أكّد بريدك» بعد تسجيلٍ بكلمة مرورٍ يختارها يخبره أنّ البريد جديد.
 */
const LOGIN_FAIL = { success: false, message: 'تعذّر الدخول — تحقّق من البريد وكلمة المرور. إن سجّلت حديثاً فأكّد بريدك أولاً، وبعد محاولات متكرّرة يُقفل الدخول ربع ساعة (واستعادة كلمة المرور تفتحه)' };
const MAX_FAILS = 5;

/**
 * الدخول. **المحاولة تُحجز قبل فحص كلمة المرور** بزيادةٍ ذرّية مشروطة بعدم القفل:
 * قراءة العدّاد ثمّ كتابته كانت تجعل عشرين تخميناً متزامناً تُحسب محاولةً واحدة.
 * وتُنفَّذ الكتابة نفسها لبريدٍ غير موجود (على معرّفٍ لا يطابق شيئاً) فلا يكشف
 * زمنُ الردّ وجود الحساب.
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
    if (u.status === 'pending_email') {
      // كلمة المرور صحيحة لكنّ البريد لم يؤكَّد: المحاولة ليست تخميناً فتُردّ
      await prisma.$executeRaw`UPDATE affiliate_users SET "failedLogins" = GREATEST("failedLogins" - 1, 0) WHERE id = ${u.id}`;
      res.status(401).json(LOGIN_FAIL); return;
    }

    const fresh = await prisma.affiliateUser.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    res.json({ success: true, data: { token: signSession(fresh.id, fresh.tokenVersion), user: publicUser(fresh) } });
  } catch (e) { next(e); }
});

router.post('/forgot', axAuthLimiter, async (req, res, next) => {
  try {
    const { email } = z.object({ email: z.string().max(160) }).parse(req.body);
    const u = await prisma.affiliateUser.findUnique({ where: { email: normEmail(email) } });
    const eligible = !!u && u.status !== 'pending_email';
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
    const fresh = await prisma.affiliateUser.update({ where: { id: p.uid }, data: { lastLoginAt: new Date() } });
    const session = fresh.status === 'pending_email' ? {} : { token: signSession(fresh.id, fresh.tokenVersion), user: publicUser(fresh) };
    res.json({ success: true, data: { ok: true, ...session } });
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

/**
 * بيانات الاستلام تُفتح متى كان للسفير مالٌ مستحقّ أو مصروف: عمولةٌ معتمدة أو مدفوعة،
 * أو **تصحيحٌ موجب غير مسوّى** — نقل إسنادٍ مصروف أو تعويض رفضٍ خاطئ يصلان بقيدٍ لا
 * بعمولة، وبلا آيبان لا يُصرفان أبداً.
 */
async function canSetPayout(affiliateId: string): Promise<boolean> {
  const [commissions, credits] = await Promise.all([
    prisma.affiliateCommission.count({ where: { affiliateId, status: { in: ['approved', 'paid'] } } }),
    prisma.affiliateAdjustment.count({ where: { affiliateId, amountHalalas: { gt: 0 } } }),
  ]);
  return commissions > 0 || credits > 0;
}

router.get('/me', axAuth, async (req: AxRequest, res, next) => {
  try {
    const s = await getSettings();
    res.json({ success: true, data: {
      user: publicUser(req.affiliate!),
      settings: { disclosureText: s.disclosureText, rateBps: s.rateBps, holdDays: s.holdDays, minPayoutHalalas: s.minPayoutHalalas, currentTermsVersion: s.currentTermsVersion },
      link: referralLink(req.affiliate!.code),
      canSetPayout: await canSetPayout(aid(req)),
    } });
  } catch (e) { next(e); }
});

router.put('/me', axAuth, async (req: AxRequest, res, next) => {
  try {
    const b = z.object({
      city: z.string().trim().max(60).nullable().optional(),
      marketingConsent: z.boolean().optional(),
      publicPromoter: z.boolean().optional(),
      mawthooqNo: z.string().trim().max(40).nullable().optional(),
      mawthooqExpiry: dateStr.nullable().optional(),
      vatNumber: vat.nullable().optional().or(z.literal('')),
    }).parse(req.body);
    const u = req.affiliate!;
    // شرط موثوق يُفحص حين يُعدَّل النشر العلني أو الترخيص فقط: ترخيصٌ انتهى لا يجوز
    // أن يمنع سحب الموافقة على الرسائل أو تعديل المدينة
    const touchesPromotion = b.publicPromoter !== undefined || b.mawthooqNo !== undefined || b.mawthooqExpiry !== undefined;
    const publicPromoter = b.publicPromoter ?? u.publicPromoter;
    const mawthooqNo = b.mawthooqNo !== undefined ? b.mawthooqNo : u.mawthooqNo;
    const mawthooqExpiry = b.mawthooqExpiry !== undefined ? b.mawthooqExpiry : (u.mawthooqExpiry ? riyadhDay(u.mawthooqExpiry) : null);
    if (touchesPromotion) {
      const mp = mawthooqProblem(publicPromoter, mawthooqNo, mawthooqExpiry);
      if (mp) { res.status(400).json({ success: false, message: mp }); return; }
    }
    const fresh = await prisma.affiliateUser.update({
      where: { id: u.id },
      data: {
        ...(b.city !== undefined ? { city: b.city || null } : {}),
        ...(b.marketingConsent !== undefined ? { marketingConsent: b.marketingConsent } : {}),
        ...(b.vatNumber !== undefined ? { vatNumber: b.vatNumber || null } : {}),
        ...(touchesPromotion ? {
          publicPromoter,
          mawthooqNo: publicPromoter ? mawthooqNo : null,
          mawthooqExpiry: publicPromoter && mawthooqExpiry ? riyadhDate(mawthooqExpiry) : null,
        } : {}),
      },
    });
    logEventSafe({ entity: 'user', entityId: u.id, action: 'profile_updated', actorType: 'affiliate', actorId: u.id, meta: { fields: Object.keys(b) } });
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

router.get('/dashboard', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const id = aid(req);
    const since = riyadhDay(new Date(Date.now() - 29 * DAY_MS));
    const draftIds = (await prisma.affiliatePayout.findMany({ where: { affiliateId: id, status: 'draft' }, select: { id: true } })).map(p => p.id);
    const [clicks, signups, byStatus, adj] = await Promise.all([
      prisma.affiliateClickDaily.aggregate({ where: { code: req.affiliate!.code, day: { gte: since } }, _sum: { count: true } }),
      prisma.tenantAttribution.count({ where: { affiliateId: id, status: { not: 'void' } } }),
      prisma.affiliateCommission.groupBy({ by: ['status'], where: { affiliateId: id }, _sum: { commissionHalalas: true }, _count: { _all: true } }),
      // غير المسوّاة فقط: الواجهة تقول «تُحتسب في دفعتك القادمة»، وما سُوّي في دفعةٍ مسجَّلة انتهى أثره
      prisma.affiliateAdjustment.aggregate({ where: { affiliateId: id, OR: [{ payoutId: null }, { payoutId: { in: draftIds } }] }, _sum: { amountHalalas: true } }),
    ]);
    const sum = (...st: string[]) => byStatus.filter(r => st.includes(r.status)).reduce((s, r) => s + (r._sum.commissionHalalas ?? 0), 0);
    const count = (...st: string[]) => byStatus.filter(r => st.includes(r.status)).reduce((s, r) => s + r._count._all, 0);
    res.json({ success: true, data: {
      clicks30d: clicks._sum.count ?? 0,
      signups,
      paidCompanies: count('pending', 'on_hold', 'approved', 'paid'),
      pendingHalalas: sum('pending', 'on_hold'),
      approvedHalalas: sum('approved'),
      paidHalalas: sum('paid'),
      adjustmentsHalalas: adj._sum.amountHalalas ?? 0,
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
    res.json({ success: true, data: rows.map(a => ({
      id: a.id,
      tenantName: a.tenantNameSnapshot,
      source: a.source,
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
      city: z.string().trim().max(60).optional().nullable(),
      how: z.enum(CLAIM_HOW),
      note: z.string().trim().max(200).optional().nullable(),
    }).parse(req.body);
    const cr = normCR(b.crNumber);
    if (!cr) { res.status(400).json({ success: false, message: 'السجل التجاري 10 أرقام' }); return; }
    if (containsContactInfo(b.note) || containsContactInfo(b.companyName) || containsContactInfo(b.city)) {
      res.status(400).json({ success: false, message: 'لا تُدخل أرقام جوال أو بريداً — اسم المنشأة وسجلها ومدينتها تكفي' }); return;
    }
    const id = aid(req);
    // ترشيحه السابق بالسجل نفسه يُعاد كما هو — بلا كشفٍ لترشيحات غيره
    const mine = await prisma.affiliateClaim.findFirst({ where: { affiliateId: id, crNumber: cr, status: { in: ['under_review', 'approved', 'converted'] } }, select: { id: true } });
    if (mine) { res.status(201).json({ success: true, data: { id: mine.id, message: 'استلمنا الترشيح وسيُراجع' } }); return; }
    const open = await prisma.affiliateClaim.count({ where: { affiliateId: id, status: 'under_review' } });
    if (open >= MAX_OPEN_CLAIMS) { res.status(429).json({ success: false, message: 'لديك ترشيحات كثيرة قيد المراجعة — انتظر البتّ فيها' }); return; }
    const claim = await prisma.$transaction(async tx => {
      const row = await tx.affiliateClaim.create({
        data: { affiliateId: id, companyName: b.companyName, companyNameNorm: normCompanyName(b.companyName), crNumber: cr, city: b.city || null, how: b.how, note: b.note || null },
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
      id: c.id, companyName: c.companyName, crNumber: c.crNumber, city: c.city, how: c.how, status: c.status,
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

router.get('/payouts', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const rows = await prisma.affiliatePayout.findMany({ where: { affiliateId: aid(req), status: 'recorded' }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ success: true, data: rows.map(p => ({
      id: p.id, netHalalas: p.netHalalas, commissionsHalalas: p.commissionsHalalas, adjustmentsHalalas: p.adjustmentsHalalas,
      status: p.status, transferredAt: p.transferredAt?.toISOString() ?? null, bankReference: p.bankReference,
      ibanLast4: p.ibanLast4, createdAt: p.createdAt.toISOString(),
    })) });
  } catch (e) { next(e); }
});

router.put('/payout-profile', axAuth, requireApproved, async (req: AxRequest, res, next) => {
  try {
    const b = z.object({ iban: z.string().max(60), holderName: z.string().trim().min(2).max(120), bankName: z.string().trim().max(80).optional().nullable() }).parse(req.body);
    if (!(await canSetPayout(aid(req)))) { res.status(403).json({ success: false, message: 'تُفتح بيانات الاستلام بعد اعتماد أوّل عمولة' }); return; }
    const iban = normIbanSA(b.iban);
    if (!iban) { res.status(400).json({ success: false, message: 'الآيبان السعودي غير صحيح' }); return; }
    // مسودّة دفعةٍ قائمة تحمل آخر أربعة للآيبان القديم — تغييره الآن يُربك التحويل
    const draft = await prisma.affiliatePayout.count({ where: { affiliateId: aid(req), status: 'draft' } });
    if (draft) { res.status(409).json({ success: false, message: 'لديك دفعة قيد التحويل — عدّل بيانات الاستلام بعد تسجيلها' }); return; }
    const fresh = await prisma.affiliateUser.update({
      where: { id: aid(req) },
      data: { ibanEnc: encryptIban(iban), ibanLast4: iban.slice(-4), ibanHolderName: b.holderName, bankName: b.bankName || null, payoutUpdatedAt: new Date() },
    });
    logEventSafe({ entity: 'user', entityId: fresh.id, action: 'payout_profile_updated', actorType: 'affiliate', actorId: fresh.id, meta: { ibanLast4: fresh.ibanLast4 } });
    mailPayoutProfileChanged(fresh.email, fresh.fullName, fresh.ibanLast4 ?? '');
    res.json({ success: true, data: { user: publicUser(fresh) } });
  } catch (e) { next(e); }
});

export default router;
