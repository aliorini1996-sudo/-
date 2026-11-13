/**
 * أنواعٌ وأدوات مشتركة لمكوّنات الشراء في «مخزون الشركة» («ربط الدفاتر» L1).
 * صفّ السجلّ هنا بنيويّ (structural): WhEntry في الصفحة يطابقه دون أن يُصدَّر منها.
 */
import { useQuery } from '@tanstack/react-query';
import { warehouseApi, type WarehouseEntryPurchaseFields } from '../../api/client';
import { currencyDecimals } from '../../i18n/countries';
import { getActiveCurrency } from '../../utils/format';

/** سطر حركة المستودع كما يردّه GET /warehouse/entries (الحقول التي تحتاجها نوافذ الشراء) */
export interface PurchaseEntryItem {
  id: string;
  productId?: string;
  qty: number;
  unitName?: string | null;
  unitFactor?: number | null;
  baseQty?: number | null;
  /** تكلفة المخزون لوحدة السطر — صافية قبل الضريبة، إلا في «غير مستردة» فتشملها (تُرسمَل في التكلفة) */
  unitCost: number | null;
  /**
   * السعر كما أُدخل (L1) — شاملاً أو صافياً بحسب costsIncludeTax الحركة؛ null لسطرٍ سبق الميزة. به يحسب الخادم فاتورة المورّد
   * ومرتجعها (entryBillTotals)، فالمعاينة تقرؤه لا unitCost
   */
  enteredUnitCost?: number | null;
  /** نسبة ضريبة السطر (L1) — null لسطرٍ سبق الميزة */
  taxPct?: number | null;
  /** المتبقّي للإرجاع بوحدة السطر إن أرسله الخادم */
  remainingQty?: number | null;
  product: { name: string; unit: string };
  lot?: { lotNumber: string; productionDate: string | null; expiryDate: string | null } | null;
}

/** صفّ السجلّ بحقول الشراء */
export interface PurchaseEntry extends WarehouseEntryPurchaseFields {
  id: string;
  type: string;
  supplier: string | null;
  note: string | null;
  createdAt: string;
  zeroRunId?: string | null;
  /** «الأسعار المدخلة شاملة الضريبة» للحركة — يحكم حساب فاتورتها ومرتجعها في الخادم (entryBillTotals) */
  costsIncludeTax?: boolean | null;
  items: PurchaseEntryItem[];
  totalCost: number;
}

/** منازل عملة الشركة النشطة — مصدر formatCurrency نفسه (لا رقمٌ مخترع) */
export function activeDecimals(): number {
  return currencyDecimals(getActiveCurrency());
}

/** يوم المتصفّح 'YYYY-MM-DD' — افتراض تاريخ الفاتورة (يراه المستخدم ويغيّره)؛ والخادم يفترض يوم الشركة حين يغيب */
export function todayDay(): string {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * مرتجعات المورّد السابقة (آخر ١٠٠ حركة RETURN له بفلتر الخادم) — لمعاينة «مرتجع للمورد»: إجماليات المرتجعات السابقة تحدّد المتبقّي
 * من الفاتورة (residual) كما يحسبه الخادم، والسجلّ المعروض قد يخفيها (فلتر «وارد» أو قصّ آخر ١٠٠ حركة). المفتاح تحت
 * 'warehouse-entries' فيُبطَل مع السجلّ بعد كل شراء أو مرتجع (PURCHASE_INVALIDATE_KEYS)
 */
export function useVendorReturns(vendorId: string | null | undefined) {
  return useQuery({
    queryKey: ['warehouse-entries', 'vendor-returns', vendorId ?? ''],
    queryFn: async () => {
      const d = (await warehouseApi.entries({ vendorId: vendorId as string, type: 'RETURN' })).data?.data;
      return (Array.isArray(d) ? d : []) as PurchaseEntry[];
    },
    enabled: !!vendorId,
    staleTime: 30_000,
  });
}

export interface RepLite { id: string; name: string; isActive?: boolean }

/** المناديب لـ«عهدة مندوب» في نوافذ الشراء وسندات الصرف — يُجلب حين يلزم وحده */
export function useRepsLite(enabled: boolean) {
  return useQuery({
    // GET /warehouse/reps بحرّاس المستودع لا /sales-reps (canManageSalesReps): من يسجّل الشراء أو يصرف للمورّد قد لا يدير المناديب.
    // مفتاحٌ خاص لا ['reps-min'] (تملؤه شاشاتٌ أخرى من /sales-reps بشكلٍ أوسع)
    queryKey: ['warehouse-reps'],
    queryFn: async () => (await warehouseApi.reps()).data.data as RepLite[],
    enabled,
    staleTime: 300_000,
  });
}

/**
 * مفاتيح شاشات الموردين التي يغيّرها الشراء المصنَّف ومرتجعه وإلغاؤه: القائمة ونافذة المورّد وكشفه وفواتيره المفتوحة وأعماره
 * وسنداته (pages/suppliers — SUPPLIER_KEYS) وسند الصرف الآلي، وشاشات /m (الكاش مشترك بين اللوحة والجوال)
 */
export const SUPPLIER_CACHE_KEYS = [
  'suppliers', 'supplier', 'supplier-statement', 'supplier-open-bills', 'supplier-aging', 'supplier-payments', 'supplier-payment', 'm-suppliers',
] as const;

/** مفاتيح ما يتغيّر بعد حركة شراء أو مرتجع أو إلغاء: الأرصدة والسجلّ والتشغيلات وأرصدة الموردين وسنداتهم */
export const PURCHASE_INVALIDATE_KEYS = [
  'warehouse-stock', 'warehouse-vans', 'warehouse-entries', 'lot-balances-wh', 'lots-of-product', ...SUPPLIER_CACHE_KEYS,
] as const;
