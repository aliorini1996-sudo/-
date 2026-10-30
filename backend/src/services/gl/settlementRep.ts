/**
 * استلامات التحصيل في الدفاتر: استلام مندوبٍ قائم وحده.
 *
 * منذ مراجعة ٣٠ أكتوبر ٢٠٢٦ يبقى استلام المندوب المحذوف بلا مندوب (rep_settlements.salesRepId = null، والمعرّف في
 * deletedSalesRepId) كي لا تفسد عهدة مستخدم الشركة الذي استلمه (services/userCustody.ts). وكان قبلها يُمحى مع المندوب.
 * فالدفاتر تراه كما كانت تراه: غائباً — وسندات ذلك المندوب تفقد مندوبها بالحذف نفسه (receipt.salesRepId = null)، فلا
 * عهدةَ مندوبٍ في الدفاتر يُقابلها استلامٌ منه. ولا يصل هذا شركةً دفاترها مفعّلة بتاريخ: assertRepDeletable يحجب حذفه.
 */
import type { Prisma } from '@prisma/client';

/** مرشّح القاعدة: استلام مندوبٍ قائم */
export const SETTLEMENT_HAS_REP: Prisma.RepSettlementWhereInput = { salesRepId: { not: null } };

/** والحارس نفسه للأنواع — المرشّح لا يضيّق نوع Prisma */
export const settlementHasRep = <T extends { salesRepId: string | null }>(r: T): r is T & { salesRepId: string } => r.salesRepId !== null;
