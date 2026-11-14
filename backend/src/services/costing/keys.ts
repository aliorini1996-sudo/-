/**
 * مفاتيح لقطات التكلفة sourceKey («ربط الدفاتر» L3 — العقد §3): فريدة لكل شركة (gl_cost_snapshots @@unique).
 *
 * المفتاح بـ**سطر** المستند (بند الوارد/الحمولة/الفاتورة) لا بالصف المصدر: صفٌّ أساسي مكرَّر للفاتورة نفسها
 * (أو تشغيلان متتاليان للّقطات) يُنتج المفتاح نفسه فيمنعه التفرّد مرة ثانية (createMany skipDuplicates).
 * وأرجل الفاتورة الأربع (البيع، إلغاؤه، المرتجع، إلغاؤه) مفاتيح منفصلة لأنها حركات مستقلة على البند نفسه.
 *
 * الشكل: COST:<refType>:<itemId>[:<leg>] ، وسجلّ التبديل COST:RESTOCK_LOG:<logId>:<invoiceItemId>.
 * المعرّفات (cuid/uuid) لا تحوي «:»، فالتحليل بالمقاطع حتمي.
 */
import { COST_REF_TYPES, type CostRefType } from './types';

export const COST_KEY_PREFIX = 'COST';

/** أرجل بند الفاتورة */
export const INVOICE_LEGS = ['OUT', 'CANCEL', 'RET', 'RETCANCEL'] as const;
export type InvoiceLeg = (typeof INVOICE_LEGS)[number];

/** سطر وارد/مرتجع مورّد/تسوية مستودع (WarehouseEntryItem.id) */
export const whItemKey = (itemId: string): string => `COST:WH_ENTRY:${itemId}`;
/** سطر تحميل/تنزيل/تسوية سيارة/إزالة تالف (VanLoadItem.id) */
export const vanItemKey = (itemId: string): string => `COST:VAN_LOAD:${itemId}`;
/** خروج بند البيع (InvoiceItem.id) */
export const saleOutKey = (invoiceItemId: string): string => `COST:INVOICE:${invoiceItemId}:OUT`;
/** إلغاء بند البيع */
export const saleCancelKey = (invoiceItemId: string): string => `COST:INVOICE:${invoiceItemId}:CANCEL`;
/** بند المرتجع — عائداً للمخزون أو مشطوباً */
export const returnKey = (invoiceItemId: string): string => `COST:INVOICE:${invoiceItemId}:RET`;
/** إلغاء بند المرتجع */
export const returnCancelKey = (invoiceItemId: string): string => `COST:INVOICE:${invoiceItemId}:RETCANCEL`;
/** تبديل «الإعادة للمخزون» لبند مرتجع (InvoiceRestockLog.id × InvoiceItem.id) */
export const restockToggleKey = (logId: string, invoiceItemId: string): string =>
  `COST:RESTOCK_LOG:${logId}:${invoiceItemId}`;

export interface ParsedCostKey {
  refType: CostRefType;
  /** سطر المستند: بند الوارد/الحمولة/الفاتورة (لسجلّ التبديل: بند فاتورة المرتجع) */
  itemId: string;
  /** رجل بند الفاتورة (INVOICE وحده)، وإلا null */
  leg: InvoiceLeg | null;
  /** معرّف سجلّ التبديل (RESTOCK_LOG وحده)، وإلا null */
  logId: string | null;
}

const isRefType = (s: string): s is CostRefType => (COST_REF_TYPES as readonly string[]).includes(s);
const isLeg = (s: string): s is InvoiceLeg => (INVOICE_LEGS as readonly string[]).includes(s);

/** تحليل مفتاح لقطة — null لأي شكل غير معروف (لا يرمي: يُستعمل على صفوف مخزَّنة) */
export function parseCostKey(key: string): ParsedCostKey | null {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts[0] !== COST_KEY_PREFIX || parts.length < 3 || !isRefType(parts[1])) return null;
  if (parts.some((p) => p === '')) return null;
  const refType = parts[1];
  switch (refType) {
    case 'WH_ENTRY':
    case 'VAN_LOAD':
      return parts.length === 3 ? { refType, itemId: parts[2], leg: null, logId: null } : null;
    case 'INVOICE':
      return parts.length === 4 && isLeg(parts[3]) ? { refType, itemId: parts[2], leg: parts[3], logId: null } : null;
    case 'RESTOCK_LOG':
      return parts.length === 4 ? { refType, itemId: parts[3], leg: null, logId: parts[2] } : null;
    default:
      return null;
  }
}
