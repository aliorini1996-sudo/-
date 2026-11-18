/**
 * «المحاسب الذكي AI» — مُجمِّع أدوات القراءة وحده: أدوات التشغيل (opsTools.ts) ثم أدوات الدفاتر (ledgerReadTools.ts).
 * كل مجموعة تقرّر بنفسها ما يُتاح من السياق (المستودع، الدفاتر المفعّلة، صلاحية عرض الدفاتر) — لا منطق هنا.
 */
import type { AcctCtx, Tool } from './context';
import { buildOpsTools } from './opsTools';
import { buildLedgerReadTools } from './ledgerReadTools';

export function buildReadTools(ctx: AcctCtx): Tool[] {
  return [...buildOpsTools(ctx), ...buildLedgerReadTools(ctx)];
}
