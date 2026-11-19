/**
 * «المحاسب الذكي AI» — مُجمِّع أدوات القراءة وحده: أدوات التشغيل (opsTools.ts) ثم أدوات الدفاتر (ledgerReadTools.ts) ثم
 * document_facts حين في الدورة مستندات مرفقة (documents/tools.ts — قراءة فقط، والترحيل من بطاقة المستند وحدها).
 * كل مجموعة تقرّر بنفسها ما يُتاح من السياق (المستودع، الدفاتر المفعّلة، صلاحية عرض الدفاتر، المستندات) — لا منطق هنا.
 */
import type { AcctCtx, Tool } from './context';
import { buildOpsTools } from './opsTools';
import { buildLedgerReadTools } from './ledgerReadTools';
import { buildDocumentTools } from './documents/tools';

export function buildReadTools(ctx: AcctCtx): Tool[] {
  return [...buildOpsTools(ctx), ...buildLedgerReadTools(ctx), ...buildDocumentTools(ctx)];
}
