/**
 * طرق سندات القبض المستعملة منذ تاريخ، بأسمائها — للتشخيص وحده (فحص «ربط الدفاتر» P8، العقد l23 §12).
 *
 * الدفاتر تعمل على الأساس المكتوب في السند (Receipt.paymentMethod) ولا تعرف المفتاح المخصّص ولا إعداد طرق الدفع
 * (حارس payment-methods-config.test.ts على services/gl). فاسم الطريقة المخصّصة يُحلّ هنا في نطاق «طرق الدفع»
 * (paymentMethodsCore) ويصل الفحص وصفاً للعرض: الأساس الذي تُرحَّل عليه، واسم المخصّصة إن سُجّل السند بها.
 * لا توجيه بهذا الوصف أبداً — الطرق المخصّصة تُعامَل كأساسها حتى خرائط طرق الدفع (L5).
 *
 * قراءتان: GROUP BY على السندات (الأساس × المفتاح) وصفّ إعدادات الشركة — لا صفوف ولا N+1.
 */
import type { Prisma } from '@prisma/client';
import { DEFAULT_METHOD_LABELS, findCustomMethod, isBuiltinMethod, readPaymentMethodsConfig } from './paymentMethodsCore';

export interface ReceiptMethodUsage {
  /** الأساس المكتوب في السند — عليه وحده تعمل الدفاتر */
  base: string;
  /** اسم الأساس الافتراضي بالعربية، والرمز نفسه لقيمةٍ قديمة غير معروفة */
  baseLabel: string;
  /** الطريقة المخصّصة التي سُجّل بها السند (معرّفها واسمها للعرض) — null للأساس نفسه */
  custom: { id: string; label: string } | null;
  receipts: number;
}

export type ReceiptMethodUsageDb = Pick<Prisma.TransactionClient, 'receipt' | 'companySettings'>;

/** اسم الأساس الافتراضي (نقدي، شبكة…)، أو الرمز نفسه لقيمةٍ غير معروفة */
export function baseMethodLabel(method: string): string {
  return isBuiltinMethod(method) ? DEFAULT_METHOD_LABELS[method] : method;
}

const byStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * سندات الشركة منذ `since` (receiptDate ≥ since) مجمّعةً بالأساس والطريقة المخصّصة، مرتّبةً بالأساس ثم معرّف المخصّصة.
 * مفتاحٌ لم يعد في الإعداد (تالف أو محذوف) يبقى معرّفاً للعرض باسمه الخام — لا يسقط سندٌ من العدّ.
 */
export async function loadReceiptMethodUsage(db: ReceiptMethodUsageDb, tenantId: string, since: Date): Promise<ReceiptMethodUsage[]> {
  const groups = await db.receipt.groupBy({
    by: ['paymentMethod', 'paymentMethodKey'], where: { tenantId, receiptDate: { gte: since } }, _count: { _all: true },
  });
  const hasCustom = groups.some((g) => !!g.paymentMethodKey);
  const cs = hasCustom ? await db.companySettings.findUnique({ where: { tenantId }, select: { paymentMethodsConfig: true } }) : null;
  const config = hasCustom ? readPaymentMethodsConfig(cs?.paymentMethodsConfig ?? null) : null;
  return groups
    .map((g): ReceiptMethodUsage => {
      const key = g.paymentMethodKey ?? null;
      return {
        base: g.paymentMethod,
        baseLabel: baseMethodLabel(g.paymentMethod),
        custom: key ? { id: key, label: findCustomMethod(config, key)?.label ?? key } : null,
        receipts: g._count._all,
      };
    })
    .sort((a, b) => byStr(a.base, b.base) || byStr(a.custom?.id ?? '', b.custom?.id ?? ''));
}
