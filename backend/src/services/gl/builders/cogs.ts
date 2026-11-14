// «ربط الدفاتر» L6 — قيد تكلفة المبيعات للفاتورة (B5، B8، B9، B12، B13، B14، OD8، OD15) من لقطات GlCostSnapshot.
// دالة صرفة: لقطات ساق الفاتورة + BuildContext ⇒ MoveDraft أو NO_MOVE. دفتر STK، moveType = COGS، والحدث COGS:
//   INVOICE:<id>:COGS     البيع (OUT): مدين 511001 (أو حساب تكلفة الفئة) / دائن 114002 بمندوبه، أو 114001 لفاتورة الإدارة (OD8)
//                          المرتجع (RET): العائد للمخزون مدين المخزون / دائن 511001 بقيمة لقطة البيع؛ والتالف أو المنتهي
//                          (لا يعود) مدين 514001 / دائن 511001 عند الاستلام (OD15)
//   INVOICE:<id>:COGS_REV الإلغاء (CANCEL / RETCANCEL): مرآة الساق بلقطتها
// الفاتورة الصفرية (NO_MOVE لإيرادها) تُصدر تكلفتها هنا بالتكلفة (B13). القيم من اللقطات وحدها: لا يُعاد تقييم شيء.
import { addSnapshotImpact, draftFrom, LineAccumulator, repLabel, type CostSnapshotInput } from './stock';
import type { BuildContext, BuildResult, LocalDate } from '../types';

export type CogsLegInput = 'OUT' | 'CANCEL' | 'RET' | 'RETCANCEL';

/** لاحقة مفتاح لقطة الساق (services/costing/keys.ts) */
export function cogsLegOfSnapshotKey(sourceKey: string): CogsLegInput | null {
  const m = /:(OUT|CANCEL|RET|RETCANCEL)$/.exec(sourceKey);
  return m ? (m[1] as CogsLegInput) : null;
}

export interface CogsMoveInput {
  invoiceId: string;
  number: string | null;
  leg: CogsLegInput;
  sourceKey: string;
  date: LocalDate;
  /** لقطات الفاتورة (يُرشَّح منها ما يخصّ الساق) */
  snapshots: readonly CostSnapshotInput[];
  salesRepId?: string | null;
  repNames?: Readonly<Record<string, string>> | null;
  categories?: Readonly<Record<string, string>> | null;
  needsAttention?: boolean;
  attentionReason?: string | null;
}

function narrationOf(leg: CogsLegInput, number: string | null): string {
  const n = number ? ` ${number}` : '';
  switch (leg) {
    case 'OUT': return `تكلفة مبيعات الفاتورة${n}`;
    case 'CANCEL': return `عكس تكلفة مبيعات الفاتورة الملغاة${n}`;
    case 'RET': return `تكلفة المرتجع${n} (إعادة للمخزون أو شطب)`;
    case 'RETCANCEL': return `إلغاء أثر المرتجع${n} على المخزون`;
  }
}

export function buildCogsMove(input: CogsMoveInput, ctx: BuildContext): BuildResult {
  const acc = new LineAccumulator();
  const snaps = input.snapshots.filter((s) => cogsLegOfSnapshotKey(s.sourceKey) === input.leg);
  for (const s of snaps) {
    addSnapshotImpact(acc, s, {
      ctx, repNames: input.repNames, categories: input.categories,
      counter: (role) => {
        if (role === 'NONE') return null;
        throw new RangeError(`لقطة فاتورة بدور مقابل غير متوقع ${role} (${s.sourceKey})`);
      },
    });
  }
  if (acc.net() !== 0n) throw new RangeError(`أثر لقطات تكلفة ${input.sourceKey} غير متوازن (${acc.net()})`);
  return draftFrom(ctx, {
    journalSystemKey: 'STOCK', moveType: 'COGS', date: input.date, ref: input.number, narration: narrationOf(input.leg, input.number),
    sourceType: 'INVOICE', sourceId: input.invoiceId, sourceKey: input.sourceKey, sourceEvent: 'COGS',
    needsAttention: input.needsAttention === true, attentionReason: input.attentionReason ?? null,
    salesRepId: input.salesRepId ?? null,
  }, acc.lines(), `تكلفة صفرية للفاتورة ${input.number ?? input.invoiceId}`);
}

export { repLabel };
