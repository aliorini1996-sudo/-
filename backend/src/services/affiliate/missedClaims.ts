/**
 * «المطالبة بإحالة فائتة» (V2_SPEC §3 و§6.1 و§6.2 و§11): شركةٌ جاءت من السفير لكنها سجّلت دون رابطه
 * أو رمزه. يقدّمها السفير من البوابة (اسم المنشأة وما يعرفه من جوالها أو سجلّها) خلال ٣٠ يوماً من
 * تسجيلها (الشروط v4)، ويراجعها المالك: **قبولٌ** بربط شركةٍ حقيقية ⇒ إسنادٌ يدويّ للسفير
 * (`createOwnerAttribution` في routes/affiliateAdmin.ts) ثمّ `accepted`، أو **رفضٌ** بسبب.
 *
 * - يختلف عن «الترشيح» (Nomination): الترشيح يحجز شركةً **قبل** تسجيلها، والمطالبة لشركةٍ سجّلت فعلاً.
 * - الاسم والملاحظة بلا جوالٍ ولا بريد (`containsContactInfo`) — رقم التواصل في خانته وحدها.
 * - دوالّ البوابة مقيَّدة بمعرّف السفير من التوكن (يمرّره مسار البوابة)، ولا تكشف للسفير شيئاً عن الشركات.
 */
import prisma from '../../config/database';
import { logEvent, PlatformActor, DAY_MS } from './core';
import { LedgerError } from './ledger';
import { containsContactInfo, normContactPhone, normCR, normCompanyName, normPhoneSA } from './rules';

export const MISSED_CLAIM_STATUSES = ['under_review', 'accepted', 'rejected', 'withdrawn'] as const;
export type MissedClaimStatus = typeof MISSED_CLAIM_STATUSES[number];
/** أقصى مطالباتٍ مفتوحة (قيد المراجعة) للسفير الواحد */
export const MISSED_CLAIM_OPEN_LIMIT = 20;
/** المطالبة خلال ٣٠ يوماً من تسجيل الشركة (الشروط v4) */
export const MISSED_CLAIM_WINDOW_DAYS = 30;

export interface MissedClaimInput { companyName: string; contactPhone?: string | null; crNumber?: string | null; note?: string | null }

/** تحقّقٌ صرفٌ بلا قاعدة — يُعيد القيم المطبَّعة أو يرمي LedgerError 400 بالعربية */
export function normalizeMissedClaim(input: MissedClaimInput): { companyName: string; contactPhone: string | null; crNumber: string | null; note: string | null } {
  const companyName = typeof input.companyName === 'string' ? input.companyName.trim().replace(/\s+/g, ' ') : '';
  if (companyName.length < 2 || companyName.length > 120) throw new LedgerError(400, 'اسم المنشأة من ٢ إلى ١٢٠ حرفاً', 'invalid');
  if (containsContactInfo(companyName)) throw new LedgerError(400, 'اسم المنشأة لا يحمل جوالاً ولا بريداً — الرقم في خانته', 'contact_in_text');
  const phoneRaw = typeof input.contactPhone === 'string' ? input.contactPhone.trim() : '';
  const contactPhone = phoneRaw ? normContactPhone(phoneRaw) : null;
  if (phoneRaw && !contactPhone) throw new LedgerError(400, 'رقم التواصل غير صحيح', 'invalid_phone');
  const crRaw = typeof input.crNumber === 'string' ? input.crNumber.trim() : '';
  const crNumber = crRaw ? normCR(crRaw) : null;
  if (crRaw && !crNumber) throw new LedgerError(400, 'السجل التجاري عشرة أرقام', 'invalid_cr');
  const noteRaw = typeof input.note === 'string' ? input.note.trim() : '';
  if (noteRaw.length > 200) throw new LedgerError(400, 'الملاحظة حتى ٢٠٠ حرف', 'invalid');
  if (noteRaw && containsContactInfo(noteRaw)) throw new LedgerError(400, 'الملاحظة لا تحمل جوالاً ولا بريداً', 'contact_in_text');
  return { companyName, contactPhone, crNumber, note: noteRaw || null };
}

// ───────────────────────────── البوابة (يستدعيها routes/affiliate.ts — الوكيل A) ─────────────────────────────

export async function createMissedClaim(
  affiliateId: string,
  input: { companyName: string; contactPhone?: string | null; crNumber?: string | null; note?: string | null },
): Promise<{ id: string }> {
  const v = normalizeMissedClaim(input);
  const aff = await prisma.affiliateUser.findUnique({ where: { id: affiliateId }, select: { status: true } });
  if (!aff) throw new LedgerError(404, 'الحساب غير موجود', 'not_found');
  if (aff.status !== 'approved') throw new LedgerError(403, 'حسابك ليس فعّالاً حالياً', 'not_approved');
  const open = await prisma.affiliateMissedClaim.count({ where: { affiliateId, status: 'under_review' } });
  if (open >= MISSED_CLAIM_OPEN_LIMIT) throw new LedgerError(409, `لديك ${MISSED_CLAIM_OPEN_LIMIT} مطالبةً قيد المراجعة — انتظر البتّ فيها`, 'open_limit');
  const row = await prisma.$transaction(async tx => {
    const c = await tx.affiliateMissedClaim.create({ data: { affiliateId, ...v }, select: { id: true } });
    await logEvent(tx, { entity: 'user', entityId: affiliateId, action: 'missed_claim_submitted', toState: 'under_review', actorType: 'affiliate', actorId: affiliateId, meta: { missedClaimId: c.id, companyName: v.companyName } });
    return c;
  });
  return { id: row.id };
}

export async function listMissedClaims(affiliateId: string): Promise<Array<{
  id: string; companyName: string; contactPhone: string | null; crNumber: string | null; note: string | null;
  status: string; reasonNote: string | null; submittedAt: Date; reviewedAt: Date | null;
}>> {
  return prisma.affiliateMissedClaim.findMany({
    where: { affiliateId }, orderBy: { submittedAt: 'desc' }, take: 200,
    select: { id: true, companyName: true, contactPhone: true, crNumber: true, note: true, status: true, reasonNote: true, submittedAt: true, reviewedAt: true },
  });
}

export async function withdrawMissedClaim(affiliateId: string, id: string): Promise<void> {
  const won = await prisma.affiliateMissedClaim.updateMany({ where: { id, affiliateId, status: 'under_review' }, data: { status: 'withdrawn' } });
  if (won.count !== 1) {
    const c = await prisma.affiliateMissedClaim.findFirst({ where: { id, affiliateId }, select: { status: true } });
    if (!c) throw new LedgerError(404, 'المطالبة غير موجودة', 'not_found');
    throw new LedgerError(409, 'تُسحب المطالبة قيد المراجعة فقط', 'not_under_review');
  }
  await logEvent(prisma, { entity: 'user', entityId: affiliateId, action: 'missed_claim_withdrawn', fromState: 'under_review', toState: 'withdrawn', actorType: 'affiliate', actorId: affiliateId, meta: { missedClaimId: id } });
}

// ───────────────────────────── المالك (routes/affiliateAdmin.ts) ─────────────────────────────

export interface MissedClaimSuggestion {
  tenantId: string; tenantName: string; match: 'cr' | 'phone' | 'name'; createdAt: Date; attributed: boolean;
  /** أيامٌ من تسجيل الشركة حتى تقديم المطالبة — والقبول ضمن ٣٠ يوماً (الشروط v4) */
  daysFromSignup: number; withinWindow: boolean;
}

/** القائمة مع اقتراحات المطابقة بالسجل ثمّ الجوال ثمّ الاسم المُطبَّع */
export async function listMissedClaimsForOwner(status?: string) {
  const claims = await prisma.affiliateMissedClaim.findMany({
    where: status ? { status } : {}, orderBy: { submittedAt: 'desc' }, take: 200,
    include: { affiliate: { select: { id: true, fullName: true, code: true } } },
  });
  const tenantNames = new Map((await prisma.tenant.findMany({
    where: { id: { in: claims.map(c => c.tenantId).filter((v): v is string => !!v) } }, select: { id: true, name: true },
  })).map(t => [t.id, t.name]));

  return Promise.all(claims.map(async c => {
    const suggestions: MissedClaimSuggestion[] = [];
    if (c.status === 'under_review') {
      const found: Array<{ id: string; name: string; createdAt: Date; match: MissedClaimSuggestion['match'] }> = [];
      const push = (t: { id: string; name: string; createdAt: Date }, match: MissedClaimSuggestion['match']) => {
        if (!found.some(f => f.id === t.id)) found.push({ ...t, match });
      };
      if (c.crNumber) {
        const rows = await prisma.companySettings.findMany({ where: { commercialReg: { contains: c.crNumber } }, select: { commercialReg: true, tenant: { select: { id: true, name: true, createdAt: true } } }, take: 10 });
        for (const s of rows) if (normCR(s.commercialReg) === c.crNumber) push(s.tenant, 'cr');
      }
      const mobile = normPhoneSA(c.contactPhone ?? '');
      if (mobile) {
        // الجوالات مخزَّنةٌ كما كُتبت — تُطابَق بآخر تسعة أرقام ثمّ بالمطبِّع
        const rows = await prisma.companySettings.findMany({ where: { phone: { contains: mobile.slice(-9, -4) } }, select: { phone: true, tenant: { select: { id: true, name: true, createdAt: true } } }, take: 30 });
        for (const s of rows) if (normPhoneSA(s.phone ?? '') === mobile) push(s.tenant, 'phone');
      }
      const norm = normCompanyName(c.companyName);
      const token = norm.split(' ').sort((a, b) => b.length - a.length)[0];
      if (token && token.length >= 3) {
        const rows = await prisma.tenant.findMany({ where: { name: { contains: token.slice(0, 4), mode: 'insensitive' } }, select: { id: true, name: true, createdAt: true }, take: 30 });
        for (const t of rows) {
          const n = normCompanyName(t.name);
          if (n.length >= 3 && (n === norm || n.includes(norm) || norm.includes(n))) push(t, 'name');
        }
      }
      const attributed = found.length
        ? new Set((await prisma.tenantAttribution.findMany({ where: { tenantId: { in: found.map(f => f.id) } }, select: { tenantId: true } })).map(a => a.tenantId))
        : new Set<string>();
      for (const f of found.slice(0, 8)) {
        const days = Math.floor((c.submittedAt.getTime() - f.createdAt.getTime()) / DAY_MS);
        suggestions.push({ tenantId: f.id, tenantName: f.name, match: f.match, createdAt: f.createdAt, attributed: attributed.has(f.id), daysFromSignup: days, withinWindow: days <= MISSED_CLAIM_WINDOW_DAYS });
      }
    }
    return {
      id: c.id, affiliate: c.affiliate, companyName: c.companyName, contactPhone: c.contactPhone, crNumber: c.crNumber, note: c.note,
      status: c.status, reasonNote: c.reasonNote, submittedAt: c.submittedAt, reviewedAt: c.reviewedAt, reviewedBy: c.reviewedBy,
      tenantId: c.tenantId, tenantName: c.tenantId ? (tenantNames.get(c.tenantId) ?? null) : null, suggestions,
    };
  }));
}

/**
 * فحوص القبول قبل الإسناد: المطالبة قيد المراجعة، والشركة موجودة، وقُدّمت المطالبة خلال ٣٠ يوماً من
 * تسجيلها (الشروط v4 — وما بعدها يبقى للمالك إسناداً يدوياً صريحاً من تبويب الإسناد). يُعيد السفير
 * وبداية الإسناد = لحظة تسجيل الشركة (كأنّها سجّلت برمزه: دفعتها الأولى بعد التسجيل داخل النافذة).
 */
export async function prepareMissedClaimAccept(id: string, tenantId: string): Promise<{ affiliateId: string; effectiveFrom: Date }> {
  const c = await prisma.affiliateMissedClaim.findUnique({ where: { id }, select: { status: true, affiliateId: true, submittedAt: true } });
  if (!c) throw new LedgerError(404, 'المطالبة غير موجودة');
  if (c.status !== 'under_review') throw new LedgerError(409, 'المطالبة ليست قيد المراجعة', 'not_under_review');
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { createdAt: true } });
  if (!t) throw new LedgerError(404, 'الشركة غير موجودة');
  if (c.submittedAt.getTime() - t.createdAt.getTime() > MISSED_CLAIM_WINDOW_DAYS * DAY_MS) {
    throw new LedgerError(409, `قُدّمت المطالبة بعد ${MISSED_CLAIM_WINDOW_DAYS} يوماً من تسجيل الشركة — إن أردت إسنادها فبإسنادٍ يدويّ من تبويب الإسناد`, 'claim_late');
  }
  const effectiveFrom = new Date(Math.min(t.createdAt.getTime(), Date.now()));
  return { affiliateId: c.affiliateId, effectiveFrom };
}

/**
 * بعد نجاح الإسناد: المطالبة `accepted` بالشركة والسبب. الإسناد تمّ فعلاً، فسحبٌ أو رفضٌ تزامن معه لا
 * يترك المطالبة بحالةٍ تناقضه — الختم يتبع ما حدث.
 */
export async function markMissedClaimAccepted(id: string, tenantId: string, reason: string, by: PlatformActor, attributionId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const c = await tx.affiliateMissedClaim.findUnique({ where: { id }, select: { affiliateId: true, status: true } });
    if (!c) throw new LedgerError(404, 'المطالبة غير موجودة');
    const won = await tx.affiliateMissedClaim.updateMany({
      where: { id, status: { in: ['under_review', 'withdrawn', 'rejected'] } },
      data: { status: 'accepted', tenantId, reasonNote: reason, reviewedAt: new Date(), reviewedBy: by.actorId },
    });
    if (won.count !== 1) throw new LedgerError(409, 'تغيّرت حالة المطالبة — حدّث الصفحة', 'raced');
    await logEvent(tx, { entity: 'user', entityId: c.affiliateId, action: 'missed_claim_accepted', fromState: c.status, toState: 'accepted', actorType: by.actorType, actorId: by.actorId, reason, meta: { missedClaimId: id, tenantId, attributionId } });
  });
}

export async function rejectMissedClaim(id: string, reason: string, by: PlatformActor): Promise<void> {
  await prisma.$transaction(async tx => {
    const c = await tx.affiliateMissedClaim.findUnique({ where: { id }, select: { affiliateId: true } });
    if (!c) throw new LedgerError(404, 'المطالبة غير موجودة');
    const won = await tx.affiliateMissedClaim.updateMany({
      where: { id, status: 'under_review' }, data: { status: 'rejected', reasonNote: reason, reviewedAt: new Date(), reviewedBy: by.actorId },
    });
    if (won.count !== 1) throw new LedgerError(409, 'المطالبة ليست قيد المراجعة', 'not_under_review');
    await logEvent(tx, { entity: 'user', entityId: c.affiliateId, action: 'missed_claim_rejected', fromState: 'under_review', toState: 'rejected', actorType: by.actorType, actorId: by.actorId, reason, meta: { missedClaimId: id } });
  });
}
