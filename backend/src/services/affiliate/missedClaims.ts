/**
 * «المطالبة بإحالة فائتة» (V2_SPEC §6.1 و§11) — **هذا الملف ملك الوكيل B**.
 *
 * أنشأه الوكيل A بتواقيع §11 الثلاثة التي تستدعيها البوابة (createMissedClaim وlistMissedClaims
 * وwithdrawMissedClaim) بتنفيذٍ مبدئيّ على المخطّط المقفل — وفي الدمج يبقى تنفيذ B الأصلي (مع قبول المالك ورفضه).
 * المدخلات تصل مُطبَّعةً ومفحوصةً من المسار (routes/affiliate.ts): الاسم والملاحظة بلا جوالٍ ولا بريد،
 * والجوال والسجل بصيغتهما.
 */
import prisma from '../../config/database';
import { logEvent } from './core';
import { LedgerError } from './ledger';

export interface MissedClaimInput {
  companyName: string;
  contactPhone?: string | null;
  crNumber?: string | null;
  note?: string | null;
}

export async function createMissedClaim(affiliateId: string, input: MissedClaimInput): Promise<{ id: string }> {
  return prisma.$transaction(async tx => {
    const row = await tx.affiliateMissedClaim.create({
      data: {
        affiliateId, companyName: input.companyName,
        contactPhone: input.contactPhone || null, crNumber: input.crNumber || null, note: input.note || null,
      },
      select: { id: true },
    });
    await logEvent(tx, { entity: 'missed_claim', entityId: row.id, action: 'submitted', toState: 'under_review', actorType: 'affiliate', actorId: affiliateId });
    return row;
  });
}

export async function listMissedClaims(affiliateId: string): Promise<Array<{
  id: string; companyName: string; contactPhone: string | null; crNumber: string | null; note: string | null;
  status: string; reasonNote: string | null; submittedAt: Date; reviewedAt: Date | null;
}>> {
  return prisma.affiliateMissedClaim.findMany({
    where: { affiliateId }, orderBy: { submittedAt: 'desc' }, take: 500,
    select: { id: true, companyName: true, contactPhone: true, crNumber: true, note: true, status: true, reasonNote: true, submittedAt: true, reviewedAt: true },
  });
}

/** سحب مطالبةٍ قيد المراجعة — مطالبةُ غيره 404 (لا تكشف وجودها)، والمبتوت فيها 409 */
export async function withdrawMissedClaim(affiliateId: string, id: string): Promise<void> {
  const won = await prisma.affiliateMissedClaim.updateMany({ where: { id, affiliateId, status: 'under_review' }, data: { status: 'withdrawn' } });
  if (won.count === 1) {
    await logEvent(prisma, { entity: 'missed_claim', entityId: id, action: 'withdrawn', fromState: 'under_review', toState: 'withdrawn', actorType: 'affiliate', actorId: affiliateId });
    return;
  }
  const mine = await prisma.affiliateMissedClaim.findFirst({ where: { id, affiliateId }, select: { id: true } });
  if (!mine) throw new LedgerError(404, 'المطالبة غير موجودة');
  throw new LedgerError(409, 'لا تُسحب إلا مطالبةٌ قيد المراجعة');
}
