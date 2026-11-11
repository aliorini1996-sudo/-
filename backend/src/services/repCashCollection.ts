import type { Prisma } from '@prisma/client';
import { COLLECTED_CASH_SALE } from './paymentMethodsReport';

/**
 * «البيع النقدي تحصيلٌ لدى المندوب» (طلب المالك ١٠ نوفمبر ٢٠٢٦).
 *
 * فاتورة البيع النقدي لمندوبٍ مفعَّلٍ له `SalesRep.cashSaleCollected` تُختم لحظة صدورها (`Invoice.cashCollectedByRep`) فتُعدّ
 * مبلغاً استلمه المندوب — في رصيد تحصيله والاستلام منه — بلا سند قبض. الختم لا الإعداد الحاليّ: تفعيله لا يُدخل نقديّ ما قبله،
 * وإطفاؤه لا يُخرج ما حُسب ولا يُسقط رصيداً استُلم.
 *
 * الشرط فوق `COLLECTED_CASH_SALE` (صفحة «طرق الدفع») حرفياً: النقدية المؤكَّدة، وما أبطلته الهيئة واحتُفظ بتحصيله — والإلغاء
 * الإداري يُخرجها (المال عاد للعميل). ويُجمع `paidAmt` (= الإجمالي في النقدية). والمرتجع لا يُنقص العهدة: النظام لا يصرف نقداً
 * في المرتجع (يصير رصيداً دائناً للعميل) — كقرار «طرق الدفع» ٢.
 *
 * الحساب في ثلاثة مواضع معاً، وإلا اختلف رقم شاشةٍ عن أخرى: GET /receipts/collection-balance (تطبيق المندوب)، وrepCollection
 * وcustodyTeamsOf في routes/salesReps.ts (الاستلام من المندوب في الويب و/m وفرق العهدة).
 * والدفاتر (services/gl) لا تتغيّر: صيغة C4b فيها مستقلّة (السندات − الاستلامات) والفائض المستلَم يُغطّيه «نقد الفواتير خارج العهدة».
 */
export const REP_COLLECTED_CASH_SALE: Prisma.InvoiceWhereInput = {
  AND: [COLLECTED_CASH_SALE, { cashCollectedByRep: true }],
};

/** ختم الإصدار: فاتورة بيعٍ نقدي لمندوبٍ مفعَّلٍ له الإعداد — وإلا لا يُكتب العمود (يبقى false) */
export function cashCollectedStamp(type: string | null | undefined, rep: { cashSaleCollected?: boolean | null } | null | undefined): { cashCollectedByRep: true } | Record<string, never> {
  return type === 'CASH' && rep?.cashSaleCollected === true ? { cashCollectedByRep: true } : {};
}
