import prisma from '../config/database';
import { roundHalfUp } from '../lib/money';
import { computePaylinkFee } from './paylinkFee';

/**
 * دفتر أمانات الشركات — نحن نجمع عبر ميسر ثم نورّد أسبوعياً (الخميس).
 *
 * نفس فلسفة AccountEntry في المحاسبة: **قيود موقَّعة لا رصيد مخزَّن** — الرصيد
 * مجموع القيود دائماً، فلا يوجد رقم ثانٍ يمكن أن ينحرف عن مصدره ويكذب.
 *
 * دورة الحياة على كل سداد:
 *   COLLECTED (+كامل ما دفعه العميل) ثم FEE (−عمولتنا شاملة الضريبة)
 * وعند التوريد الأسبوعي: PAYOUT (−ما حُوّل للشركة)
 * وعند استرداد: REFUND (−ما رُدّ للعميل من حسابنا)
 *
 * الرصيد الموجب = ندين به للشركة. السالب = الشركة مدينة لنا (استردادٌ وقع
 * بعد توريد) — يُعرض صراحةً ولا يُخفى.
 */

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** قيدا التحصيل والعمولة عند تأكيد سداد رابط — داخل معاملة السند نفسها */
export async function postCollectionEntries(
  tx: Tx,
  params: {
    tenantId: string;
    linkId: string;
    collected: number;
    feePct: number;
    feeFlat: number;
    invoiceNumber: string;
  },
): Promise<ReturnType<typeof computePaylinkFee>> {
  const fee = computePaylinkFee(params.collected, params.feePct, params.feeFlat);
  await tx.settlementEntry.createMany({
    data: [
      {
        tenantId: params.tenantId,
        kind: 'COLLECTED',
        amount: fee.collected,
        linkId: params.linkId,
        note: `تحصيل إلكتروني — فاتورة ${params.invoiceNumber}`,
      },
      {
        tenantId: params.tenantId,
        kind: 'FEE',
        amount: -fee.feeGross,
        feeNet: fee.feeNet,
        feeVat: fee.feeVat,
        linkId: params.linkId,
        note: `عمولة المنصة ${params.feePct}% + ${params.feeFlat} (شاملة الضريبة)`,
      },
    ],
  });
  return fee;
}

/**
 * عكس استرداد: يُخصم من أمانات الشركة ما رُدّ لعميلها من حسابنا.
 * العمولة لا تُردّ (قرار افتراضي — الخدمة قُدّمت)؛ تغييره لاحقاً قيدٌ إضافي لا هدم.
 */
export async function postRefundEntry(
  tx: Tx,
  params: { tenantId: string; linkId: string; refunded: number; invoiceNumber: string },
): Promise<void> {
  await tx.settlementEntry.create({
    data: {
      tenantId: params.tenantId,
      kind: 'REFUND',
      amount: -roundHalfUp(params.refunded, 2),
      linkId: params.linkId,
      note: `استرداد للعميل — فاتورة ${params.invoiceNumber}`,
    },
  });
}

/** رصيد أمانات شركة = مجموع قيودها — لا مصدر آخر */
export async function settlementBalance(tenantId: string): Promise<number> {
  const agg = await prisma.settlementEntry.aggregate({
    where: { tenantId },
    _sum: { amount: true },
  });
  return roundHalfUp(Number(agg._sum.amount ?? 0), 2);
}

/**
 * تسجيل توريد لشركة: سجل Payout + قيد PAYOUT سالب يصفّر (أو ينقص) الرصيد.
 * التحويل البنكي نفسه يقع خارج النظام (مؤتمت مع البنك بترتيب المالك) —
 * نحن نوثّق لا ننفّذ.
 */
export async function recordPayout(params: {
  tenantId: string;
  amount: number;
  bankReference?: string;
  note?: string;
}): Promise<{ ok: boolean; message?: string; payoutId?: string }> {
  const amount = roundHalfUp(params.amount, 2);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: 'مبلغ توريد غير صالح' };

  // لا نورّد أكثر من الرصيد — توريدٌ زائد يقلب الأمانات ديناً على الشركة بلا سبب
  const balance = await settlementBalance(params.tenantId);
  if (amount > balance + 0.0005) {
    return { ok: false, message: `المبلغ أكبر من رصيد الأمانات (${balance})` };
  }

  const payout = await prisma.$transaction(async tx => {
    const p = await tx.payout.create({
      data: {
        tenantId: params.tenantId,
        amount,
        bankReference: params.bankReference,
        note: params.note,
      },
    });
    await tx.settlementEntry.create({
      data: {
        tenantId: params.tenantId,
        kind: 'PAYOUT',
        amount: -amount,
        payoutId: p.id,
        note: params.note ?? 'توريد أسبوعي',
      },
    });
    return p;
  });
  return { ok: true, payoutId: payout.id };
}
