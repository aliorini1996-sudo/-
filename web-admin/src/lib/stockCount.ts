/**
 * «كشف جرد» سيارة المندوب (طلب المالك ٢٣ نوفمبر ٢٠٢٦): ورقة PDF للمطابقة الفعلية — لكل صنفٍ في السيارة رصيده في النظام،
 * وخاناتٌ فارغة يكتب فيها الجارد الكمية الفعلية والفرق والملاحظة، وأسطرٌ فارغة لأصنافٍ وُجدت في السيارة وليست في النظام.
 * ورقةٌ لا حركة: لا تغيّر رصيداً ولا يُحفظ لها سجلّ في الخادم (كطلب المخزون). المصدر GET /van-stock/current للمندوب.
 * لا React هنا — يُختبر وحده (stockCount.test.ts)، والورقة PrintableStockCount في rep/RepDocuments.tsx.
 */
import type { UnitDef } from './units';

/** صفّ «المخزون الحالي» كما يعيده /van-stock/current (الحقول التي يحتاجها الكشف) */
export interface VanStockSource {
  productId: string; name: string; code?: string | null; unit?: string | null;
  remaining: number;
  /** «المرتجع التالف» و«منتهي الصلاحية» في السيارة: بضاعةٌ موجودة لا تُباع ولا تدخل المتبقّي — تُجرد أيضاً */
  damaged?: number | null; expired?: number | null;
  units?: UnitDef[] | null; primaryUnitId?: string | null;
  archived?: boolean; status?: string | null;
}

export interface StockCountLine {
  productId: string; name: string; code: string; unit: string;
  /** المتبقّي في النظام بالأساس (سالبٌ = عجزٌ من بيعٍ بلا رصيد) */
  onHand: number;
  /** تالفٌ ومنتهي الصلاحية في السيارة بالأساس — يُعدّ مع الجرد الفعلي */
  unsellable: number;
  units?: UnitDef[] | null; baseUnit: string; primaryUnitId?: string | null;
}

const EPS = 1e-9;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** أصناف الكشف: كلّ صنفٍ له رصيدٌ في السيارة (موجبٌ أو عجز) أو بضاعةٌ تالفة/منتهية فيها — مرتّبةً بالاسم */
export function stockCountLines(rows: readonly VanStockSource[]): StockCountLine[] {
  return rows
    .map((r) => ({
      productId: r.productId,
      name: r.name,
      code: r.code && r.code !== r.name ? r.code : '',
      unit: r.unit || '',
      onHand: num(r.remaining),
      unsellable: num(r.damaged) + num(r.expired),
      units: r.units ?? null,
      baseUnit: r.unit || '',
      primaryUnitId: r.primaryUnitId ?? null,
    }))
    .filter((l) => Math.abs(l.onHand) > EPS || l.unsellable > EPS)
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

/** رقم الكشف `SC-YYMMDD-HHMM` من لحظة الإصدار على الجهاز — لا سجلّ له في الخادم */
export function stockCountRef(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `SC-${String(at.getFullYear()).slice(2)}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
}

/** عدد الأسطر الفارغة في آخر الكشف لأصنافٍ وُجدت في السيارة وليست في النظام */
export const STOCK_COUNT_BLANK_ROWS = 4;
