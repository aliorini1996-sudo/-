/**
 * «حسابٌ تجريبي يفتحه السفير» من البوابة — `POST /api/affiliate/trials` وأخواتها.
 *
 * الوعد للشركة قبل كلّ شيء: **لا يدخل حسابها إلا مديرها.** فالسفير يكتب اسم المنشأة ومسؤولها وبريده
 * وجواله، والشركة تُنشأ كالتسجيل الذاتيّ تماماً (services/trialCompany.ts) لكنّ مديرها **بلا كلمة مرور**:
 * رابط تفعيلٍ يصل بريده وحده فيختارها بنفسه. السفير لا يرى كلمة مرورٍ ولا رابطاً ولا جلسة، ولا يُراسَل
 * الجوال قبل أن تؤكّده الشركة.
 *
 * والسفير لا يصير أداة تعداد: كلّ ردٍّ 202 موحّد — عميلٌ قائم (بريد أو جوال أو سجلّ) يُحجب بصمتٍ ويُسجَّل
 * حدثاً يراه المالك، والمحاولات المحجوبة تُحسب في سقف اليوم فيغلو التخمين.
 *
 * كلّ قراءةٍ عابرةٍ للسفراء أو للشركات هنا لا في routes/affiliate.ts — حارس «كلّ استعلامٍ مقيّدٌ
 * بالسفير» يمسح ملفّ المسار نصّاً.
 */
import prisma from '../../config/database';
import { getSettings, rulesFor, logEvent, isUniqueViolation, DAY_MS } from './core';
import { normCompanyName, normCR, normPhoneSA, isDisputedByFlags, AttributionFlag } from './rules';
import { LedgerError } from './ledger';
import {
  createTrialCompanyTx, newPendingHash, isPendingActivationHash, signActivationToken, mailCompanyActivation,
  notifyOwnerNewTrial, pendingActivationTenantIds, rotatePendingHashTx, ACTIVATION_RESEND_COOLDOWN_MS,
} from '../trialCompany';
import { phoneKey } from '../phoneKey';

/** محاولاتٌ في ٢٤ ساعة متحرّكة: ما أُنشئ + ما حُجب (عميلٌ قائم) — قرار المالك: سخيٌّ لا يقيّد السفير */
export const PORTAL_TRIAL_DAILY_CAP = 10;
/** حساباتٌ فتحها السفير ولم تفعّلها شركاتها بعد */
export const PORTAL_TRIAL_PENDING_CAP = 20;
export const RESEND_COOLDOWN_MS = ACTIVATION_RESEND_COOLDOWN_MS;
export const MAX_RESENDS = 5;
export const RESEND_WINDOW_DAYS = 30;

/** مفتاح الإطفاء — مفعّلٌ افتراضياً (قرار المالك)؛ `AX_PORTAL_TRIAL_ENABLED=0` يوقفه والبوابة تخفي التبويب */
export function portalTrialEnabled(): boolean {
  return process.env.AX_PORTAL_TRIAL_ENABLED !== '0';
}

export interface TrialInput {
  companyName: string;
  adminName: string;
  /** normEmail — صغيرٌ مقصوص، وهو اسم الدخول كما يُعرض في صفحة التفعيل */
  adminEmail: string;
  /** normAffiliatePhone — أرقامٌ دولية بلا `+` */
  adminPhone: string;
  countryCode: string | null;
  cr: string | null;
  dryRun: boolean;
}

export interface PortalAffiliate { id: string; email: string; phone: string | null; code: string; fullName: string; termsVersion: string }

type BlockReason = 'email_exists' | 'phone_exists' | 'cr_customer' | 'email_race';

/** حسابات السفير من البوابة التي لم تُبطل وما زال مديرها بانتظار التفعيل */
async function pendingPortalTrials(affiliateId: string): Promise<number> {
  const rows = await prisma.tenantAttribution.findMany({
    where: { affiliateId, source: 'portal', status: { not: 'void' } }, select: { tenantId: true },
  });
  return (await pendingActivationTenantIds(rows.map(r => r.tenantId))).size;
}

/**
 * إشارات «عميلٌ قائم» — **تحجب** الإنشاء لا تعلّمه فقط: شركةٌ ثانية بجوال الأولى تجعل بوابة واتساب
 * غامضةً فتتوقّف للعميل الحقيقي، والشروط §٢ لا عمولة على عميلٍ قائم أصلاً. ولا تُكشف للسفير أبداً.
 */
async function existingCustomer(i: TrialInput): Promise<{ reason: BlockReason; matchedTenantId: string } | null> {
  // المطابقة الأخيرة حرفاً بحرف في الذاكرة: «_» و«%» لا يصيران حرفَي بدلٍ فيُحجب بريدٌ جديد يشبه بريد عميل
  const byEmail = (await prisma.admin.findMany({ where: { email: { equals: i.adminEmail, mode: 'insensitive' } }, select: { tenantId: true, email: true }, take: 50 }))
    .find(a => a.email.toLowerCase() === i.adminEmail.toLowerCase());
  if (byEmail) return { reason: 'email_exists', matchedTenantId: byEmail.tenantId };
  // الجوالات مخزَّنةٌ كما كُتبت — تُطبَّع بمفتاح بوابة واتساب نفسه (ما تراه البوابة رقماً واحداً)، **وبمطبِّع
  // returning_company في التسجيل الذاتيّ** (أرقامٌ عربية و«+966 05…»): وإلا صار هذا الطريق أضعف من الذي شدّده
  const key = phoneKey(`+${i.adminPhone}`);
  const sa = normPhoneSA(`+${i.adminPhone}`);
  const phones = await prisma.companySettings.findMany({ where: { phone: { not: null } }, select: { tenantId: true, phone: true } });
  const byPhone = phones.find(s => phoneKey(s.phone) === key || (sa !== null && normPhoneSA(s.phone) === sa));
  if (byPhone) return { reason: 'phone_exists', matchedTenantId: byPhone.tenantId };
  if (i.cr) {
    const cr = i.cr;
    const regs = await prisma.companySettings.findMany({ where: { commercialReg: { not: null } }, select: { tenantId: true, commercialReg: true } });
    const byCr = regs.find(s => normCR(s.commercialReg) === cr || (s.commercialReg ?? '').replace(/\D/g, '').includes(cr));
    if (byCr) return { reason: 'cr_customer', matchedTenantId: byCr.tenantId };
  }
  return null;
}

function logBlocked(aff: PortalAffiliate, reason: BlockReason, matchedTenantId: string | null): Promise<void> {
  return logEvent(prisma, {
    entity: 'user', entityId: aff.id, action: 'portal_trial_blocked', actorType: 'affiliate', actorId: aff.id,
    meta: { reason, matchedTenantId },
  });
}

/**
 * يفتح الحساب أو يحجبه أو يفحص فقط (`dryRun`: كلّ البوابات بلا كتابةٍ ولا حدث). المسار يردّ 202
 * واحدة في الحالات الثلاث — النتيجة للاختبار والسجلّ لا للسفير.
 */
export async function createPortalTrial(aff: PortalAffiliate, i: TrialInput, ctx: { ipHash: string | null }): Promise<{ outcome: 'created' | 'blocked' | 'dry_run' }> {
  const now = new Date();

  // ١) السقوف — المحاولات المحجوبة تُحسب: تخمين «هل هذا البريد عميل؟» يستهلك سقف اليوم
  const since = new Date(now.getTime() - DAY_MS);
  const [createdToday, blockedToday, pending] = await Promise.all([
    prisma.tenantAttribution.count({ where: { affiliateId: aff.id, source: 'portal', createdAt: { gte: since } } }),
    prisma.affiliateEvent.count({ where: { entity: 'user', entityId: aff.id, action: 'portal_trial_blocked', createdAt: { gte: since } } }),
    pendingPortalTrials(aff.id),
  ]);
  if (createdToday + blockedToday >= PORTAL_TRIAL_DAILY_CAP) {
    throw new LedgerError(429, 'بلغت حدّ الحسابات التي تُفتح في اليوم — حاول بعد ٢٤ ساعة', 'trial_daily_cap');
  }
  if (pending >= PORTAL_TRIAL_PENDING_CAP) {
    throw new LedgerError(429, 'لديك حساباتٌ كثيرة لم تفعّلها شركاتها بعد — ذكّرهم بتفعيلها أو اسحب الخاطئ منها', 'trial_pending_cap');
  }

  // ٢) عميلٌ قائم ⇒ حجبٌ صامت يراه المالك
  const existing = await existingCustomer(i);
  if (existing) {
    if (!i.dryRun) await logBlocked(aff, existing.reason, existing.matchedTenantId);
    return { outcome: 'blocked' };
  }

  // ٣) الترشيحات: ترشيحٌ معتمد ساري القفل (أو متحوّل) لسفيرٍ آخر بالسجل أو بالاسم المُطبَّع لا يحجب —
  // يجعل الإسناد متنازعاً عليه يحسمه المالك («الأسبق يفوز» بلا كشفٍ للسفير). وترشيح السفير نفسه يتحوّل.
  const nameNorm = normCompanyName(i.companyName);
  const keys = [...(i.cr ? [{ crNumber: i.cr }] : []), ...(nameNorm ? [{ companyNameNorm: nameNorm }] : [])];
  const conflict = keys.length
    ? await prisma.affiliateClaim.findFirst({
        where: {
          affiliateId: { not: aff.id },
          AND: [{ OR: [{ status: 'approved', lockedUntil: { gt: now } }, { status: 'converted' }] }, { OR: keys }],
        },
        orderBy: { submittedAt: 'asc' }, select: { id: true },
      })
    : null;
  const ownClaim = i.cr
    ? await prisma.affiliateClaim.findFirst({
        where: { affiliateId: aff.id, crNumber: i.cr, status: 'approved', lockedUntil: { gt: now } }, select: { id: true },
      })
    : null;

  // ٤) الفحص الجاف يقف هنا — بعد كلّ البوابات وقبل أيّ كتابة
  if (i.dryRun) return { outcome: 'dry_run' };

  // ٥) الإشارات والحالة — لقطة القواعد من الشروط التي قبلها السفير
  const settings = await getSettings();
  const flags: AttributionFlag[] = conflict ? ['claim_conflict'] : [];
  // دفاعيّ: requireApproved يمنعه قبل الوصول هنا
  const outdated = aff.termsVersion !== settings.currentTermsVersion;
  if (outdated) flags.push('terms_outdated');
  const status = outdated || isDisputedByFlags(flags) ? 'disputed' : 'active';
  const rules = await rulesFor(aff.termsVersion);

  // ٦) الشركة والإسناد في معاملةٍ واحدة — في هذا الطريق وحده: الإسناد هو الغاية، فلا يُفقد بصمت
  const pendingHash = newPendingHash();
  const phone = `+${i.adminPhone}`;
  let created: { adminId: string; trialEndsAt: Date; ct: Awaited<ReturnType<typeof createTrialCompanyTx>>['ct'] };
  try {
    created = await prisma.$transaction(async tx => {
      const { tenant, admin, trialEndsAt, ct } = await createTrialCompanyTx(tx, {
        companyName: i.companyName, adminName: i.adminName, email: i.adminEmail, phone,
        countryCode: i.countryCode, passwordHash: pendingHash, now,
      });
      const a = await tx.tenantAttribution.create({
        data: {
          tenantId: tenant.id, tenantNameSnapshot: i.companyName, affiliateId: aff.id, source: 'portal',
          claimId: ownClaim?.id ?? null, codeUsed: null, refVia: null, status, flags,
          reasonNote: conflict ? `ترشيحٌ معتمد لسفيرٍ آخر (${conflict.id})` : null,
          effectiveFrom: now, rateBps: rules.rateBps, holdDays: rules.holdDays,
          firstPaymentDeadline: new Date(now.getTime() + rules.firstPaymentWithinDays * DAY_MS),
          termsVersion: aff.termsVersion,
        },
      });
      await logEvent(tx, {
        entity: 'attribution', entityId: a.id, action: 'created', toState: status, actorType: 'affiliate', actorId: aff.id,
        meta: { source: 'portal', flags, cr: i.cr, consent: true, ipHash: ctx.ipHash, claimId: ownClaim?.id ?? null },
      });
      if (ownClaim) {
        const cv = await tx.affiliateClaim.updateMany({
          where: { id: ownClaim.id, affiliateId: aff.id, status: 'approved' },
          data: { status: 'converted', tenantId: tenant.id, convertedAt: now },
        });
        if (cv.count === 1) {
          await logEvent(tx, {
            entity: 'claim', entityId: ownClaim.id, action: 'converted', fromState: 'approved', toState: 'converted',
            actorType: 'affiliate', actorId: aff.id, meta: { tenantId: tenant.id, via: 'portal' },
          });
        }
      }
      return { adminId: admin.id, trialEndsAt, ct };
    });
  } catch (e) {
    // سباقٌ على البريد نفسه (طلبان متزامنان، أو تسجيلٌ ذاتيّ في اللحظة نفسها) — حجبٌ كالقائم
    if (isUniqueViolation(e, 'email')) {
      await logBlocked(aff, 'email_race', null);
      return { outcome: 'blocked' };
    }
    throw e;
  }

  // ٧) بعد الالتزام: رابط التفعيل لبريد المسؤول **وحده**، وإشعار المالك. ولا واتساب قبل التفعيل.
  mailCompanyActivation(i.adminEmail, signActivationToken(created.adminId, pendingHash));
  void notifyOwnerNewTrial({
    companyName: i.companyName, adminName: i.adminName, email: i.adminEmail, phone,
    ct: created.ct, trialEndsAt: created.trialEndsAt,
    title: '🎉 عميل تجريبي جديد — فتحه سفير',
    extraRows: [
      ['السفير', `${aff.fullName} · ${aff.code}`],
      ['الإسناد', flags.length ? `${status} · ${flags.join('، ')}` : status],
      ['الحالة', 'بانتظار تفعيل الشركة بريدياً — التجربة تُحتسب من التفعيل'],
      ...(i.cr ? [['السجل التجاري (كتبه السفير)', i.cr] as [string, string]] : []),
    ],
    note: conflict
      ? `فتح سفيرٌ حساباً لمنشأةٍ يحجزها ترشيحٌ معتمد لسفيرٍ آخر (${conflict.id}) — الإسناد قيد المراجعة. لا يدخل أحدٌ الحساب حتى يختار مسؤوله كلمة مروره من رابط بريده.`
      : 'فتح سفيرٌ حساباً تجريبياً لمنشأة — لا يدخله أحدٌ حتى يختار مسؤوله كلمة مروره من رابط بريده. ينصح بالتواصل معه بعد التفعيل.',
  }).catch(e => console.error('[affiliate] portal trial owner mail:', (e as Error).message));
  return { outcome: 'created' };
}

/** حساب البوابة للسفير نفسه ومديره الأقدم — كلّ قراءةٍ مقيّدة بالسفير ومصدر البوابة */
async function ownPortalTrial(affiliateId: string, attributionId: string) {
  const a = await prisma.tenantAttribution.findFirst({
    where: { id: attributionId, affiliateId, source: 'portal' }, select: { id: true, tenantId: true, status: true, createdAt: true },
  });
  if (!a || a.status === 'void') throw new LedgerError(404, 'الحساب غير موجود', 'not_found');
  const admin = await prisma.admin.findFirst({
    where: { tenantId: a.tenantId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, passwordHash: true, isActive: true },
  });
  return { a, admin };
}

/**
 * إعادة إرسال رابط التفعيل — للبريد **المخزَّن** وحده (الجسم بلا بريدٍ ولا جوال فلا يُعدَّلان من هنا)،
 * بتدوير الحارس فيسقط كلّ رابطٍ أقدم. بمهلةٍ وسقفٍ ونافذة.
 */
export async function resendPortalActivation(affiliateId: string, attributionId: string): Promise<void> {
  const now = Date.now();
  const { a, admin } = await ownPortalTrial(affiliateId, attributionId);
  if (!admin || !admin.isActive || !isPendingActivationHash(admin.passwordHash)) {
    throw new LedgerError(409, 'فعّلت الشركة حسابها — لا حاجة لإعادة الإرسال', 'not_pending');
  }
  if (now - a.createdAt.getTime() > RESEND_WINDOW_DAYS * DAY_MS) {
    throw new LedgerError(409, 'مضى على فتح الحساب أكثر من ٣٠ يوماً — تواصل معنا لإعادة التفعيل', 'resend_window');
  }
  const sent = await prisma.affiliateEvent.count({ where: { entity: 'attribution', entityId: a.id, action: 'activation_resent', actorType: 'affiliate' } });
  if (sent >= MAX_RESENDS) throw new LedgerError(429, 'بلغت حدّ إعادة الإرسال لهذا الحساب — تواصل معنا', 'resend_limit');
  const last = await prisma.affiliateEvent.findFirst({
    where: { entity: 'attribution', entityId: a.id, action: { in: ['created', 'activation_resent'] } },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  if (last && now - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new LedgerError(429, 'أُرسل بريد التفعيل قبل قليل — انتظر عشر دقائق ثم أعد المحاولة', 'resend_cooldown');
  }
  const fresh = await prisma.$transaction(async tx => {
    const h = await rotatePendingHashTx(tx, admin);
    if (!h) throw new LedgerError(409, 'تغيّر الحساب للتوّ — حدّث الصفحة', 'not_pending');
    await logEvent(tx, { entity: 'attribution', entityId: a.id, action: 'activation_resent', actorType: 'affiliate', actorId: affiliateId });
    return h;
  });
  mailCompanyActivation(admin.email, signActivationToken(admin.id, fresh));
}

/**
 * سحب حسابٍ فتحه السفير بخطأ (بريدٌ أو جوالٌ مكتوبٌ غلطاً) قبل أن تفعّله الشركة — يحرّر البريد والجوال
 * ليعيد فتحه صحيحاً. لا حذف: الشركة تُوقف، والمدير يُعطَّل ويُغيَّر بريده ويُدوَّر حارسه (يسقط كلّ رابط)،
 * والإسناد يُبطل. ولا يُسحب حسابٌ فعّلته شركته أو دفعت عنه.
 */
export async function withdrawPortalTrial(affiliateId: string, attributionId: string): Promise<void> {
  const { a, admin } = await ownPortalTrial(affiliateId, attributionId);
  if (!admin || !isPendingActivationHash(admin.passwordHash)) {
    throw new LedgerError(409, 'لا يُسحب حسابٌ فعّلته الشركة', 'not_pending');
  }
  const paid = await prisma.paymentLink.count({ where: { tenantId: a.tenantId, status: 'paid' } });
  if (paid > 0) throw new LedgerError(409, 'لا يُسحب حسابٌ دفعت عنه الشركة', 'has_payment');
  const reason = 'سحبه السفير قبل تفعيل الشركة';
  await prisma.$transaction(async tx => {
    const won = await tx.tenantAttribution.updateMany({
      where: { id: a.id, affiliateId, source: 'portal', status: a.status },
      data: { status: 'void', reasonNote: reason },
    });
    if (won.count !== 1) throw new LedgerError(409, 'تغيّر الحساب للتوّ — حدّث الصفحة', 'not_found');
    // الشرط على الحارس المقروء: شركةٌ فعّلت في اللحظة نفسها لا تُسحب
    const adm = await tx.admin.updateMany({
      where: { id: admin.id, passwordHash: admin.passwordHash },
      data: { isActive: false, email: `withdrawn+${admin.id}@fieldsa.invalid`, passwordHash: newPendingHash() },
    });
    if (adm.count !== 1) throw new LedgerError(409, 'لا يُسحب حسابٌ فعّلته الشركة', 'not_pending');
    await tx.tenant.update({ where: { id: a.tenantId }, data: { isActive: false } });
    await tx.companySettings.updateMany({ where: { tenantId: a.tenantId }, data: { phone: null } });
    await logEvent(tx, {
      entity: 'attribution', entityId: a.id, action: 'voided', fromState: a.status, toState: 'void',
      actorType: 'affiliate', actorId: affiliateId, reason,
    });
    // ترشيحات السفير المتحوّلة إلى هذا الحساب تعود كما كانت: «متحوّلٌ» إلى شركةٍ موقوفة لا ينتهي أبداً
    // (converted بلا انتقالٍ ولا انتهاء) فيحجز السجلّ عن كلّ سفيرٍ آخر بلا أجل. بربطها الفعليّ بالشركة لا
    // بـ a.claimId وحده: المالك قد يربط ترشيحاً آخر للسفير بها من «الترشيحات». يعود معتمداً إن بقي قفله —
    // فيلتقطه إعادة الفتح الصحيح — وإلا منتهياً كما لو لم يُفتح الحساب. ترشيح غيره لا يُمسّ.
    const converted = await tx.affiliateClaim.findMany({
      where: { affiliateId, status: 'converted', tenantId: a.tenantId }, select: { id: true, lockedUntil: true },
    });
    for (const cl of converted) {
      const back = cl.lockedUntil && cl.lockedUntil.getTime() > Date.now() ? 'approved' : 'expired';
      const rv = await tx.affiliateClaim.updateMany({
        where: { id: cl.id, affiliateId, status: 'converted', tenantId: a.tenantId },
        data: { status: back, tenantId: null, convertedAt: null },
      });
      if (rv.count === 1) {
        await logEvent(tx, {
          entity: 'claim', entityId: cl.id, action: 'conversion_reverted', fromState: 'converted', toState: back,
          actorType: 'affiliate', actorId: affiliateId, reason, meta: { tenantId: a.tenantId, attributionId: a.id, via: 'portal_withdraw' },
        });
      }
    }
  });
}
