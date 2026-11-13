/**
 * «الدفع من عهدة مندوب» في سندات صرف الموردين («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦): المال الذي خرج من عهدة المندوب إلى
 * المورّدين، ونطاق المستخدم المقيَّد على مناديب هذه السندات.
 *
 * ═══ العهدة ═══
 *   الشراء النقدي «من عهدة مندوب» وسند الصرف بطريقة REP_CUSTODY يكتبان سند صرفٍ بمندوبه (SupplierPayment.salesRepId) — والمال خرج من
 *   يد المندوب فعلاً. وكانت العهدة التشغيلية (السندات + النقدي المحسوب − الاستلامات) لا تقرأ سندات الصرف: يسلّم المندوب الباقي فيبقى
 *   عليه ثمن الشراء «عجزاً» دائماً، ولا طريق صحيح لتسويته (استلامٌ وهمي يرفع عهدة من سجّله). فصافي ما صُرف من عهدته يُطرح منها:
 *     Σ سندات الصرف السارية (POSTED) بطريقة REP_CUSTODY لمندوبه − Σ ما ردّه المورّدون نقداً إلى عهدته (REFUND_IN على مرتجعٍ مستلمُه
 *     عهدته: إلغاء شراءٍ دُفع منها بعد مرتجعٍ سابق، أو وارد سالب نقدي إليها).
 *   الإلغاء (CANCELLED) يُعيد المبلغ إلى العهدة تلقائياً. والسند بلا فريق (لا teamId في سندات الصرف): يدخل عرض العهدة الإجمالي ودلو
 *   «بلا فريق» ورصيد تطبيق المندوب، لا عرضَ مشرف الفريق ولا رصيدَ فريقٍ بعينه (custodyIncludesTeamless).
 *   المواضع: routes/salesReps.ts (repCollection — الاستلام من المندوب في الويب و/m) وroutes/receipts.ts (رصيد التحصيل في تطبيق المندوب).
 *   والدفاتر (services/gl) لا تتغيّر هنا: صيغة C4b فيها مستقلّة.
 *
 * ═══ النطاق ═══
 *   المستخدم المقيَّد (قوائم أو مشرف فرق) لا يرى مناديب خارج نطاقه في سندات الصرف ولا في «مصدر الدفع» لحركات المستودع: معرّف المندوب
 *   واسمه يُحجبان (hiddenRepIds) — كقائمة /api/warehouse/reps المقيَّدة بنطاقه.
 *
 * لا شيء في gl_* ولا استيراد من services/gl (receipts.ts يستورد هذا الملف وهو ممنوع من الدفاتر — gl-hooks-static).
 */
import type { Prisma } from '@prisma/client';
import type { AuthRequest } from '../../types';
import prisma from '../../config/database';
import { adminRepFilter } from '../adminScope';
import { formatPaidAccountRef, milliToNumber, parsePaidAccountRef } from './core';

// ═══ العهدة ═══

/** أدنى شكل للعميل: PrismaClient أو عميل معاملة (والمزيّف في الاختبار) */
export type RepCustodyDb = Pick<Prisma.TransactionClient, 'supplierPayment' | 'supplierLedgerEntry'>;

/** شرط سندات الصرف من عهدة المندوب السارية */
export const repCustodyPaymentsWhere = (tid: string, repId: string): Prisma.SupplierPaymentWhereInput =>
  ({ tenantId: tid, salesRepId: repId, method: 'REP_CUSTODY', status: 'POSTED' });

/** شرط ما ردّه المورّدون نقداً إلى عهدة المندوب: REFUND_IN على حركة مرتجعٍ مستلمُ مالها عهدته (paidAccountRef) */
export const repCustodyRefundsWhere = (tid: string, repId: string): Prisma.SupplierLedgerEntryWhereInput =>
  ({ tenantId: tid, kind: 'REFUND_IN', warehouseEntry: { is: { tenantId: tid, paidAccountRef: formatPaidAccountRef({ kind: 'REP_CUSTODY', salesRepId: repId }) } } });

/** صافي ما صُرف من عهدة المندوب إلى المورّدين بالملّي (قد يكون سالباً لو ردّ مورّدٌ إلى عهدته أكثر مما صُرف منها) */
export async function repCustodySupplierNetMilli(db: RepCustodyDb, tid: string, repId: string): Promise<bigint> {
  const [paid, refunded] = await Promise.all([
    db.supplierPayment.aggregate({ where: repCustodyPaymentsWhere(tid, repId), _sum: { amountMilli: true } }),
    db.supplierLedgerEntry.aggregate({ where: repCustodyRefundsWhere(tid, repId), _sum: { amountMilli: true } }),
  ]);
  const r = refunded._sum.amountMilli ?? 0n;
  return (paid._sum.amountMilli ?? 0n) - (r < 0n ? -r : r);
}

/** الصافي نفسه بوحدة العملة — كمبالغ العهدة (Float) في الشاشات */
export async function repCustodySupplierNet(db: RepCustodyDb, tid: string, repId: string): Promise<number> {
  return milliToNumber(await repCustodySupplierNetMilli(db, tid, repId));
}

/**
 * هل يشمل عرضُ العهدة بقيد الفريق هذا (composeTeamCustodyWhere) ما لا فريق له؟ نعم للعرض الإجمالي ({}) ولدلو «بلا فريق»
 * ({teamId: null})، ولا لفريقٍ بعينه ({teamId: X}) ولا لمشرف الفرق ({team: …}) — وسندات الصرف بلا فريق.
 */
export function custodyIncludesTeamless(teamWhere: Record<string, unknown>): boolean {
  if ('team' in teamWhere) return false;
  return !('teamId' in teamWhere) || teamWhere.teamId === null;
}

// ═══ النطاق ═══

/**
 * المناديب المحجوبون عن المستخدم من بين معرّفاتٍ معطاة: خارج نطاقه (adminRepFilter)، أو غير موجودين في الشركة (مندوبٌ محذوف لا
 * يُعرف نطاقه). غير المقيَّد ⇒ لا أحد (بلا استعلامٍ زائد)، ولا معرّفات ⇒ لا استعلام أصلاً.
 */
export async function hiddenRepIds(req: AuthRequest, tid: string, repIds: readonly (string | null | undefined)[]): Promise<Set<string>> {
  const ids = [...new Set(repIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Set();
  const scope = await adminRepFilter(req);
  if (!Object.keys(scope).length) return new Set();
  const seen = await prisma.salesRep.findMany({ where: { tenantId: tid, id: { in: ids }, AND: [scope] }, select: { id: true } });
  const ok = new Set(seen.map((r) => r.id));
  return new Set(ids.filter((id) => !ok.has(id)));
}

/** معرّف مندوب العهدة في «مصدر الدفع» (REP_CUSTODY:<id>) — null لغيره */
export function custodyRepOf(ref: string | null | undefined): string | null {
  const p = parsePaidAccountRef(ref ?? null);
  return p?.kind === 'REP_CUSTODY' ? p.salesRepId : null;
}

/** «مصدر الدفع» بمندوبٍ محجوب ⇒ REP_CUSTODY بلا معرّفه (يبقى أن الدفع من عهدة مندوب) — وغيره كما هو */
export function maskPaidAccountRef(ref: string | null | undefined, hidden: ReadonlySet<string>): string | null {
  const rep = custodyRepOf(ref);
  return rep && hidden.has(rep) ? 'REP_CUSTODY' : ref ?? null;
}
