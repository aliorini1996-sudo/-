// ============================================================================
// «تتبّع اللوط» على الأوراق المطبوعة — منطقٌ صرف تشترك فيه العارضات الأربعة للفاتورة (A4 في RepDocuments.tsx، والشريط
// الكلاسيكي والقالبان الجديدان في thermal.ts) وإشعارا التحميل والمستودع، فلا يكتب أيٌّ منها سطر التشغيلة لنفسه.
//
// - الفاتورة: سطرٌ لكل تشغيلة تحت اسم البند «تشغيلة {رقم} ×{كمية} · ينتهي {يوم}» **بشرط** lotOnInvoice مع الميزة
//   (lotFlagsOf). غيابه أو نسخة شركة قديمة ⇒ لا شيء: الورقة كما كانت حرفاً.
// - الإشعاران: عمود «التشغيلة / الانتهاء» دائماً متى وُجدت تشغيلة في الإشعار (الصفوف لا تصل إلا بـwithLots).
// - الكمية في صفوف اللوط بوحدة الأساس (D22)؛ وتُطبع بوحدة السطر حين تنقسم عليها تماماً (كرتونان لا «٤٨»)، وإلا بالأساس
//   موسومةً — فلا يُقرأ رقمٌ بالحبّة تحت سطرٍ بالكرتون.
// - يوم الانتهاء يومٌ تقويمي: يُكتب من النصّ YYYY-MM-DD مباشرة (new Date يزيحه يوماً غرب غرينتش).
// ============================================================================

import { LOT_EPS, lotDay, lotFlagsOf, roundLot, type DocLotLine } from '../lib/lots';
import { factorOf } from '../lib/units';

type Tr = (ar: string) => string;
const same = (s: string) => s;

/** تشغيلات البند المطبوعة على فاتورة العميل — بشرط «طباعة رقم التشغيلة على الفاتورة» مع الميزة، والصفوف الصالحة وحدها */
export function invoiceLotsOf(
  company: { lotTrackingEnabled?: unknown; lotOnInvoice?: unknown } | null | undefined,
  item: { lots?: DocLotLine[] | null },
): DocLotLine[] {
  if (!lotFlagsOf(company).onInvoice) return [];
  return docLotRows(item.lots);
}

/**
 * خيارات طلب فاتورةٍ يعيد المندوب فتحها (الكشف، والقائمة) — withLots=1 مع الميزة (D11) فتحمل البنود تشغيلاتها وتُطبع بشرط
 * lotOnInvoice كورقة الإصدار؛ ومطفأةً (أو نسخة شركة قديمة بلا العلم) لا خيارات: الطلب كما كان حرفاً (§١٠)
 */
export function repInvoiceGetConfig(
  company: { lotTrackingEnabled?: unknown; lotOnInvoice?: unknown } | null | undefined,
): { params: { withLots: 1 } } | undefined {
  return lotFlagsOf(company).on ? { params: { withLots: 1 } } : undefined;
}

/** صفوف تشغيلاتٍ صالحة للعرض (كمية موجبة) — بلا شرط الطباعة: لشريط الإدارة خارج الورقة وللإشعارات */
export function docLotRows(lots: readonly DocLotLine[] | null | undefined): DocLotLine[] {
  if (!Array.isArray(lots)) return [];
  return lots.filter((l): l is DocLotLine => !!l && typeof l === 'object' && Number.isFinite(l.qty) && l.qty > LOT_EPS);
}

/** كمية التشغيلة (أساسية) بوحدة السطر إن انقسمت على معامله تماماً، وإلا بالأساس ومعها base */
export function lotQtyInLine(baseQty: number, unitFactor?: number | null): { qty: number; base: boolean } {
  const F = factorOf({ unitFactor });
  const q = roundLot(Math.abs(Number(baseQty) || 0));
  if (F === 1) return { qty: q, base: false };
  const n = q / F;
  if (Math.abs(n - Math.round(n)) <= 1e-6) return { qty: Math.round(n), base: false };
  return { qty: q, base: true };
}

/** يوم YYYY-MM-DD (أو لحظة ISO لعمود يوم) ⇒ «dd/mm/yyyy» نصّاً — وإلا '' */
export function lotDayText(v: unknown): string {
  const d = lotDay(v);
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

export interface LotTextOpts {
  tr: Tr;
  /** معامل وحدة السطر (لقطته) — لطباعة الكمية بوحدته */
  unitFactor?: number | null;
  /** أرقام العارض (localizeDigits في الشريط) — رقم التشغيلة معرّفٌ لا يُترجم */
  digits?: (s: string) => string;
}

/** «تشغيلة {رقم} ×{كمية} · ينتهي {يوم}» — نصٌّ واحد للعارضات الأربعة. lotNumber: null = صفٌّ بلا تشغيلة معروفة */
export function lotLineText(l: DocLotLine, o: LotTextOpts): string {
  const d = o.digits ?? same;
  const q = lotQtyInLine(l.qty, o.unitFactor);
  const exp = lotDayText(l.expiryDate);
  const name = l.lotNumber ? `${o.tr('تشغيلة')} ${l.lotNumber}` : o.tr('تشغيلة غير معروفة');
  return `${name} ×${d(String(q.qty))}${q.base ? ` ${o.tr('بوحدة الأساس')}` : ''}${exp ? ` · ${o.tr('ينتهي')} ${d(exp)}` : ''}`;
}

/** خانة «التشغيلة / الانتهاء» في الإشعارين: «{رقم} · ينتهي {يوم}» ومعها الكمية حين يتوزّع السطر على أكثر من تشغيلة */
export function lotCellText(l: DocLotLine, o: LotTextOpts & { withQty: boolean }): string {
  const d = o.digits ?? same;
  const exp = lotDayText(l.expiryDate);
  const q = lotQtyInLine(l.qty, o.unitFactor);
  return [
    l.lotNumber ?? o.tr('غير مسمى'),
    exp ? `${o.tr('ينتهي')} ${d(exp)}` : '',
    o.withQty ? `×${d(String(q.qty))}${q.base ? ` ${o.tr('بوحدة الأساس')}` : ''}` : '',
  ].filter(Boolean).join(' · ');
}

/** هل في الإشعار تشغيلةٌ واحدة على الأقل — شرط عمود «التشغيلة / الانتهاء» */
export function noticeHasLots(items: readonly { lots?: DocLotLine[] | null }[]): boolean {
  return items.some((i) => docLotRows(i.lots).length > 0);
}

/** تشغيلة سطر المستودع (`lot` في سجل /warehouse/entries — سطرٌ = تشغيلةٌ واحدة) ⇒ صفّ ورقة، أو undefined */
export function warehouseLineLots(
  lot: { lotNumber?: unknown; expiryDate?: unknown } | null | undefined,
  baseQty: number,
): DocLotLine[] | undefined {
  if (!lot || typeof lot.lotNumber !== 'string' || !lot.lotNumber) return undefined;
  return [{ lotNumber: lot.lotNumber, qty: roundLot(Math.abs(Number(baseQty) || 0)), expiryDate: lotDay(lot.expiryDate) }];
}
