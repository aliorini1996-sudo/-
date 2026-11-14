/**
 * الافتتاح المشتقّ للدفاتر المربوطة («ربط الدفاتر» L2، القاعدة 7 في الخطة؛ العقد scratchpad/l23_contract.md §11).
 *
 * قراءة فقط على عميل تشغيلي (المعاينة تمرّر العميل الحارس داخل معاملة REPEATABLE READ READ ONLY، والاعتماد L7 معاملته):
 *   loadOpeningSources(بلا مخزون) ⇒ computeDerivedOpening ⇒ { derived: {opening, inventory, salesRepNames}, settlementSplits }.
 * - الذمم والعهدة والأمانات بالمسند نفسه الذي يصنّف به المُرحِّل (includedInOpening): لا صف يسقط من الافتتاح والترحيل معاً.
 * - المخزون **لا يُقرأ هنا**: قيمته من محرّك التكلفة (CostingSummary.openingByLocation) يمرّرها المُستدعي، فلا يتكرّر
 *   حساب valueStock القديم (composeWarehouse) ولا يختلف الافتتاح عمّا ستقيّده حركات المخزون (L6).
 * - أسماء مناديب سطور 114002: ما قرأه loadOpeningSources، والباقي باستعلام واحد مقسَّم (لا N+1) لمناديب مواقع المخزون
 *   وحدهم. المندوب المحذوف (VAN:<deletedSalesRepId>) لا صفّ له ⇒ اسم بديل في buildOpeningMove.
 * - لا يمسّ أي جدول gl* (العميل الحارس في المعاينة يرمي SHADOW_GL_ACCESS لو فعل)، ولا يكتب شيئاً.
 */
import type { Prisma } from '@prisma/client';
import { computeDerivedOpening, loadOpeningSources, type OpeningCutoff, type OpeningRouting } from '../opening';
import { repOfLocation, type LocationTotals } from '../../costing/types';
import type { LinkedOpeningResult } from './types';

/** حجم دفعة `id IN (...)` — كمقسِّم loadOpeningSources، تحت حدّ معاملات PostgreSQL بهامش واسع */
export const LINKED_OPENING_ID_CHUNK = 5000;

export interface LoadLinkedOpeningInput {
  cut: OpeningCutoff;
  decimals: number;
  routing: OpeningRouting;
  /** CostingSummary.openingByLocation (PERPETUAL)، أو null ⇒ بلا سطور مخزون (PERIODIC، OD7) */
  inventory: readonly LocationTotals[] | null;
}

/** مناديب مواقع المخزون بقيمة ≠ 0 (السيارة المجهولة VAN:_ بلا مندوب) — مرتّبة لحتمية الاستعلام */
export function inventoryRepIds(inventory: readonly LocationTotals[] | null): string[] {
  if (!inventory) return [];
  const ids = new Set<string>();
  for (const t of inventory) {
    if (t.valueMilli === 0n) continue;
    const rep = repOfLocation(t.location);
    if (rep) ids.add(rep);
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function loadLinkedOpening(db: Prisma.TransactionClient, tenantId: string, input: LoadLinkedOpeningInput): Promise<LinkedOpeningResult> {
  if (!tenantId) throw new RangeError('loadLinkedOpening: tenantId مطلوب');
  // القاعدة 7: الربط بأثر رجعي (FY_RESTATED) يبني عكس ما قبل السنة من المصدر — البداية النظيفة تُسقط الافتتاح المشتقّ كله
  if (input.cut.cleanStart === true) throw new RangeError('loadLinkedOpening: البداية النظيفة (cleanStart) لا تصلح للدفاتر المربوطة');

  const src = await loadOpeningSources(db, tenantId, input.cut, { includeInventory: false });
  const opening = computeDerivedOpening(src, input.cut, { decimals: input.decimals, routing: input.routing });

  const salesRepNames: Record<string, string> = { ...(src.salesRepNames ?? {}) };
  const missing = inventoryRepIds(input.inventory).filter((id) => !Object.prototype.hasOwnProperty.call(salesRepNames, id));
  for (let i = 0; i < missing.length; i += LINKED_OPENING_ID_CHUNK) {
    const rows = await db.salesRep.findMany({
      where: { tenantId, id: { in: missing.slice(i, i + LINKED_OPENING_ID_CHUNK) } },
      select: { id: true, name: true },
    });
    for (const r of rows) salesRepNames[r.id] = r.name;
  }

  return {
    derived: { opening, inventory: input.inventory ? [...input.inventory] : null, salesRepNames },
    settlementSplits: opening.settlementSplits,
  };
}
