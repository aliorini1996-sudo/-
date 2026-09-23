// ============================================================================
// ZATCA المرحلة الثانية (Z5.2) — محوّل Prisma لسلسلة الإصدار والترقيم داخل المعاملة (يُفحص نوعياً ولا يُنفَّذ في الاختبارات)
// ----------------------------------------------------------------------------
// • lockChainHead(tx, unitId): جملتان على مقبض المعاملة نفسه —
//     1) SELECT … FROM zatca_egs_units WHERE id = $1 FOR UPDATE   (أول قفل في معاملة الإصدار؛ §0.4)
//     2) الذيل: zatca_documents حيث (egsUnitId, icv = lastIcv) عبر القيد الفريد — جملة مستقلة بعد القفل عمداً: في READ COMMITTED
//        تحصل على لقطة جديدة فترى مستند الحامل السابق الذي التُزم أثناء انتظارنا (JOIN في جملة القفل يعيد تقييم صفّ الوحدة
//        وحده ويرى الجدول الآخر بلقطة ما قبل الانتظار).
// • nextNumberInTx(tx, tenantId, prefix): آخر رقم بالبادئة بمقبض المعاملة (لا prisma العامّ ⇒ لا اتصال ثانٍ من المجمّع؛ نقد 8)،
//   والرقم التالي بخوارزمية utils/helpers.ts نفسها. القيد الفريد (tenantId, number) يبقى الحكم: تصادم ⇒ P2002 ⇒ runIssuance يعيد.
// • لا يكتب شيئاً (التقدّم والإدراج في documentStore.prisma.ts)؛ لا مرشّح not على عمود قابل للإفراغ. الاستيراد نوعي فقط.
// ============================================================================

import type { Prisma } from '@prisma/client';
import type { LockedUnitRow } from './documentStore';
import { nextNumberAfter } from './issue';
import type { ChainHead, IssuanceChainStore } from './issueChain';

export type IssuanceTx = Pick<Prisma.TransactionClient, '$queryRaw' | 'zatcaDocument' | 'invoice'>;

export interface PrismaIssuanceStore extends IssuanceChainStore<IssuanceTx> {
  nextNumberInTx(tx: IssuanceTx, tenantId: string, prefix: string): Promise<string>;
}

export function prismaIssuanceStore(): PrismaIssuanceStore {
  return {
    async lockChainHead(tx, unitId): Promise<ChainHead | null> {
      const rows = await tx.$queryRaw<LockedUnitRow[]>`
        SELECT id, "tenantId", status, environment, "keyVersion", "vatNumber", "lastIcv", "lastInvoiceHash"
        FROM zatca_egs_units WHERE id = ${unitId} FOR UPDATE`;
      const unit = rows[0];
      if (!unit) return null;
      if (!(unit.lastIcv > 0)) return { unit, tail: null };
      const tail = await tx.zatcaDocument.findUnique({
        where: { egsUnitId_icv: { egsUnitId: unitId, icv: unit.lastIcv } },
        select: { icv: true, invoiceHash: true, issueDate: true, issueTime: true },
      });
      return { unit, tail };
    },

    async nextNumberInTx(tx, tenantId, prefix) {
      const last = await tx.invoice.findFirst({
        where: { tenantId, number: { startsWith: prefix } },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      return nextNumberAfter(prefix, last?.number);
    },
  };
}
