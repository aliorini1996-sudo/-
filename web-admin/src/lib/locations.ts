/**
 * «لوكيشن» (طلب المالك ٢١ أكتوبر ٢٠٢٦) — منطقٌ صرف معزولٌ عن React ليُختبر وحده: أنواع ردود الخادم، وخيارات فلتر
 * «الموقع» وإسناد المندوب، وقراءة نقطةٍ ملصوقة (إحداثيات أو رابط خرائط Google)، ورسائل رفض الخادم، وأوراق التصدير.
 *
 * الميزة مطفأة افتراضياً يفعّلها المالك لكل شركة (Tenant.locationsEnabled). الحساب كلّه في الخادم
 * (backend/src/services/locations.ts): كلّ فاتورةٍ وتحميلٍ يُختمان بموقع مندوبهما **وقت الإصدار**، فنقل المندوب لا يحرّك
 * مستنداته القديمة، والملخّص يُجمَّع بالختم لا بموقع المندوب اليوم — فمجموع المواقع ومعها «بلا موقع» إجمالي الشركة.
 * لذا لا تصفية نطاقٍ ولا حساب مبالغ هنا: الواجهة تعرض ما يردّه الخادم وتصدّره كما هو.
 */
import { num, type ExcelSheet } from '../utils/excel';
import { uniqueSheetNames } from './paymentMethods';
import { baseQtyOf } from './units';

type Tr = (ar: string) => string;

/** أقصى طول لاسم الموقع — LOCATION_NAME_MAX في الخادم */
export const LOCATION_NAME_MAX = 60;

/** موقعٌ كما يردّه GET /locations (repsCount = مناديبه **في نطاق المستخدم**) */
export interface SalesLocation {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
  repsCount?: number;
}

/** مندوبٌ في شاشة الإسناد (GET /locations/reps) — نطاق المستخدم من الخادم */
export interface LocationRep { id: string; name: string; isActive: boolean; locationId: string | null }

export interface CountAmount { count: number; amount: number }
export interface LocBucket {
  /** null = «بلا موقع» (مندوبٌ لم يُسند، أو مستندٌ قبل التفعيل، أو موقعٌ حُذف) */
  locationId: string | null;
  name: string | null;
  isActive: boolean;
  lat: number | null;
  lng: number | null;
  sales: CountAmount;
  returns: CountAmount;
  net: number;
  loads: { count: number; qty: number; products: { productId: string; name: string; unit: string | null; qty: number }[] };
}
export interface LocationsSummaryData {
  range: { from: string; to: string; timezone: string };
  rows: LocBucket[];
  none: LocBucket;
  totals: { sales: CountAmount; returns: CountAmount; net: number; loads: { count: number; qty: number } };
}

// ─── الصلاحيات ───

type PermUser = { canViewReports?: boolean; canManageSalesReps?: boolean; canManageCompanySettings?: boolean; scopeEnabled?: boolean } | null | undefined;

/**
 * أقسام الصفحة بصلاحيات نظائرها على الخادم (routes/locations.ts) — دلالة `!== false` كبقيّة اللوحة (الغائب مسموح):
 * - **الملخّص** بصلاحية التقارير (أرقامٌ مالية بنطاق المستندات).
 * - **الإسناد** بصلاحية المناديب (والخادم يقصره على مناديب النطاق).
 * - **تعريف المواقع** بصلاحية إعدادات الشركة ومن غير مقيَّد النطاق — بياناتٌ عامّة يراها غيره (كإدارة الفرق)؛ وجلسة
 *   المالك (الانتحال) تمرّ كما تمرّ على الخادم.
 * والقائمة نفسها لكل مستخدم شركة (فلتر «الموقع» في الفواتير والتحميلات يحتاجها) — للاطّلاع لمن لا يملك التعريف.
 */
export function locationsAccess(user: PermUser, impersonating = false): { summary: boolean; assign: boolean; manage: boolean } {
  if (!user) return { summary: false, assign: false, manage: false };
  return {
    summary: user.canViewReports !== false,
    assign: user.canManageSalesReps !== false,
    manage: user.canManageCompanySettings !== false && (user.scopeEnabled !== true || impersonating),
  };
}

/** بند القائمة الجانبية والصفحة: قسمٌ واحد مسموحٌ على الأقل — وإلا لا يبقى إلا قائمةٌ للاطّلاع لا عمل فيها */
export function locationsPageAllowed(user: PermUser, impersonating = false): boolean {
  const a = locationsAccess(user, impersonating);
  return a.summary || a.assign || a.manage;
}

/** اسم الموقع للعرض: المؤرشف موسومٌ (ختمه باقٍ في التقارير)، والغائب شرطة */
export function locationLabel(l: Pick<SalesLocation, 'name' | 'isActive'>, tr: Tr): string {
  const name = l.name || '—';
  return l.isActive ? name : `${name} (${tr('مؤرشف')})`;
}

/** اسم صفّ الملخّص: «بلا موقع» لسطر الختم الفارغ */
export function bucketLabel(b: Pick<LocBucket, 'locationId' | 'name' | 'isActive'>, tr: Tr): string {
  if (!b.locationId) return tr('بلا موقع');
  return locationLabel({ name: b.name ?? '', isActive: b.isActive }, tr);
}

export interface Opt { value: string; label: string }

/**
 * خيارات فلتر «الموقع» في الفواتير وسجلّ التحميلات: الكلّ ('') ثم كل المواقع (المؤرشف أيضاً — مستنداته القديمة باقيةٌ
 * بختمه) ثم «بلا موقع» ('none' — ما يفهمه الخادم في locationFilterOf).
 */
export function locationFilterOptions(list: SalesLocation[], tr: Tr): Opt[] {
  return [
    { value: '', label: tr('كل المواقع') },
    ...list.map((l) => ({ value: l.id, label: locationLabel(l, tr) })),
    { value: 'none', label: tr('بلا موقع') },
  ];
}

/**
 * خيارات إسناد مندوب: «بلا موقع» ('' ⇒ null للخادم) ثم المواقع الفعّالة وحدها — المؤرشف لا يُسند إليه (409
 * LOCATION_ARCHIVED) — إلا موقعه الحاليّ إن صار مؤرشفاً، يظهر كي لا تكذب الخانة عن حاله.
 */
export function assignOptions(list: SalesLocation[], currentId: string | null, tr: Tr): (Opt & { disabled?: boolean })[] {
  return [
    { value: '', label: tr('بلا موقع') },
    ...list.filter((l) => l.isActive || l.id === currentId).map((l) => ({ value: l.id, label: locationLabel(l, tr), disabled: !l.isActive })),
  ];
}

// ─── النقطة على الخريطة ───

export interface LatLng { lat: number; lng: number }

/** الأرقام الهندية (العربية والفارسية) إلى لاتينية — لوحة مفاتيح الجوال العربية تكتبها هكذا */
const toLatinDigits = (s: string) => s
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  .replace(/٫/g, '.');

/** نقطةٌ صالحة: الزوج معاً وفي مداه — locationPointProblem في الخادم نفسها. الردّ مفتاحٌ عربيّ يُمرَّر لـtr أو null */
export function pointProblem(lat: number | null | undefined, lng: number | null | undefined): string | null {
  const has = (v: unknown) => v !== null && v !== undefined;
  if (has(lat) !== has(lng)) return 'حدد النقطة على الخريطة كاملة (خط العرض والطول معا)';
  if (!has(lat)) return null;
  if (!Number.isFinite(lat) || (lat as number) < -90 || (lat as number) > 90) return 'خط العرض غير صالح';
  if (!Number.isFinite(lng) || (lng as number) < -180 || (lng as number) > 180) return 'خط الطول غير صالح';
  return null;
}

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
/**
 * نقطةٌ من نصٍّ ملصوق — كما ينسخها الناس فعلاً: «24.71, 46.67» (والفاصلة العربية والأرقام الهندية)، أو رابط خرائط
 * Google فيه الإحداثيات (`!3d…!4d…` دبّوس المكان أدقّها فيُقدَّم، ثم `?q=`/`query=`/`ll=`، ثم `@lat,lng` مركز العرض).
 * الرابط المختصر (maps.app.goo.gl) لا إحداثيات فيه ولا يُفتح من المتصفّح ⇒ null، والواجهة تطلب الإحداثيات أو النقر.
 */
export function parseLatLng(raw: string): LatLng | null {
  let s = toLatinDigits(String(raw ?? '').trim());
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { /* نصٌّ فيه % ليس ترميزاً — يُقرأ كما هو */ }
  const patterns = [
    new RegExp(`!3d${NUM}!4d${NUM}`),
    new RegExp(`[?&](?:q|query|ll|destination|center)=(?:loc:)?${NUM}\\s*,\\s*\\+?${NUM}`),
    new RegExp(`@${NUM},${NUM}`),
    new RegExp(`^${NUM}\\s*(?:[,،]\\s*|\\s+)${NUM}$`),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const lat = Number(m[1]), lng = Number(m[2]);
    if (pointProblem(lat, lng) === null) return { lat, lng };
  }
  return null;
}

/** الإحداثيات للعرض (٦ منازل ≈ ١٠ سم — أدقّ مما يُنقر) */
export const fmtCoord = (v: number) => (Number.isFinite(v) ? v.toFixed(6) : '—');

/** رابط النقطة على خرائط Google — كرابط العميل في نافذته */
export const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

// ─── رسائل الرفض ───

/** رموز رفض /api/locations ⇒ نصٌّ عربيّ مترجَم (رسالة الخادم عربيةٌ وحدها) */
export const LOCATION_ERRORS: Record<string, string> = {
  LOCATION_NAME_TAKEN: 'يوجد موقع بهذا الاسم',
  LOCATION_HAS_REPS: 'في الموقع مناديب — انقلهم لموقع آخر أولا',
  LOCATION_HAS_DOCUMENTS: 'على الموقع فواتير أو تحميلات — أرشفه بدل الحذف ليبقى في التقارير',
  LOCATION_ARCHIVED: 'الموقع مؤرشف — استعده أولا أو اختر موقعا آخر',
  LOCATIONS_NOT_ALLOWED: 'صفحة لوكيشن غير مفعلة لشركتك',
};

/** رمز رفض الخادم (٤٠٣/٤٠٩) — كاشُ إعدادات الشركة قد يتأخّر عن إطفاء المالك للميزة */
export const errorCode = (e: unknown) => (e as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;

/** رسالة الرفض للمستخدم: الرمز المعروف مترجَماً (ومعه عدد المناديب حين يُرسل)، وإلا رسالة الخادم، وإلا البديل */
export function locationErrorMessage(err: unknown, tr: Tr, fallback: string): string {
  const d = (err as { response?: { data?: { code?: string; message?: string; repsCount?: number } } } | null)?.response?.data;
  const ar = d?.code ? LOCATION_ERRORS[d.code] : undefined;
  if (ar) return d?.code === 'LOCATION_HAS_REPS' && typeof d.repsCount === 'number' ? `${tr(ar)} (${d.repsCount})` : tr(ar);
  return d?.message || fallback;
}

// ─── الملخّص ───

/** صفوف الملخّص بترتيب العرض: المواقع كما رتّبها الخادم (الفعّال أولاً ثم بالاسم) ثم «بلا موقع» دائماً — سطرٌ لا يختفي */
export const summaryBuckets = (data: LocationsSummaryData): LocBucket[] => [...data.rows, data.none];

/** هل للسطر حركةٌ في الفترة؟ (يُبهَت الصفر ولا يُخفى) */
export const hasActivity = (b: LocBucket) => b.sales.count > 0 || b.returns.count > 0 || b.loads.count > 0 || b.sales.amount !== 0 || b.returns.amount !== 0;

/** الكميات بمنزلتين كبقيّة مخزون السيارات (fmtQty) — رقمٌ لا نصّ في Excel */
const qtyNum = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;

/**
 * أوراق التصدير: ورقة المواقع (سطرٌ لكلّ موقع ثم «بلا موقع» ثم الإجمالي — أرقام الخادم كما هي)، وورقة أصناف التحميل
 * (لكل موقعٍ أصنافه بكمياتها). التحميل بالكمية وحدها: لا كلفةَ مخزّنة لكل تحميل (القرار ٧ في services/locations.ts).
 */
export function summarySheets(data: LocationsSummaryData, tr: Tr): ExcelSheet[] {
  const cLoc = tr('الموقع');
  const cSalesN = tr('عدد فواتير البيع'), cSales = tr('مبلغ المبيعات');
  const cRetN = tr('عدد المرتجعات'), cRet = tr('مبلغ المرتجعات');
  const cNet = tr('صافي المبيعات');
  const cLoadsN = tr('عدد التحميلات'), cLoadsQ = tr('كمية التحميل');
  const line = (name: string, b: Pick<LocBucket, 'sales' | 'returns' | 'net'> & { loads: { count: number; qty: number } }): Record<string, unknown> => ({
    [cLoc]: name,
    [cSalesN]: b.sales.count,
    [cSales]: num(b.sales.amount),
    [cRetN]: b.returns.count,
    [cRet]: num(b.returns.amount),
    [cNet]: num(b.net),
    [cLoadsN]: b.loads.count,
    [cLoadsQ]: qtyNum(b.loads.qty),
  });
  const rows = summaryBuckets(data).map((b) => line(bucketLabel(b, tr), b));
  rows.push(line(tr('الإجمالي'), data.totals));

  const cProduct = tr('الصنف'), cUnit = tr('الوحدة'), cQty = tr('الكمية');
  const products: Record<string, unknown>[] = [];
  for (const b of summaryBuckets(data)) {
    for (const p of b.loads.products) {
      products.push({ [cLoc]: bucketLabel(b, tr), [cProduct]: p.name || '—', [cUnit]: p.unit ?? '', [cQty]: qtyNum(p.qty) });
    }
  }
  const names = uniqueSheetNames([tr('المواقع'), tr('أصناف التحميل')]);
  return [
    { name: names[0], rows, colWidths: [24, 14, 16, 14, 16, 16, 14, 14] },
    { name: names[1], rows: products, colWidths: [24, 28, 10, 14] },
  ];
}

// ─── سجلّ التحميلات (مخزون السيارات) ───

/** حركة سيارة كما يردّها GET /van-stock/loads — ومعها ختم موقعها («لوكيشن»؛ null لما بلا ختم) */
export interface VanLoadRow {
  id: string;
  type: string;
  note: string | null;
  createdBy: 'REP' | 'ADMIN' | null;
  createdAt: string;
  salesRep: { id: string | null; name: string } | null;
  location?: { id: string; name: string } | null;
  items: {
    id?: string; productId?: string; qty: number | string;
    /** لقطة وحدة البند (الوحدات المتعددة): null ⇒ وحدة الأساس */
    unitName?: string | null; unitFactor?: number | null; baseQty?: number | null;
    product: { id?: string; name: string; unit: string | null } | null;
  }[];
}

/**
 * مجموع كميات التحميل (بمنزلتين) **بوحدة الأساس** — كما يجمعها ملخّص المواقع في الخادم (routes/locations.ts).
 * والجمع الخام كان يعدّ كرتوناً وحبّةً حبّتين.
 */
export function loadQty(l: Pick<VanLoadRow, 'items'>): number {
  return qtyNum(l.items.reduce((s, it) => s + baseQtyOf(it), 0));
}

/** من سجّل الحركة: المندوب من تطبيقه أو الإدارة (الحركات القديمة بلا وسم ⇒ شرطة) */
export function loadByLabel(by: VanLoadRow['createdBy'], tr: Tr): string {
  return by === 'REP' ? tr('المندوب') : by === 'ADMIN' ? tr('الإدارة') : '—';
}

/**
 * صفوف تصدير السجلّ: **سطرٌ لكل صنف** (جدولٌ مسطّح يُلخَّص في Excel بلا تفكيك خلايا)، والتحميل متعدّد الأصناف يكرّر
 * تاريخه ومندوبه وموقعه. `when` يُمرَّر من الصفحة (تنسيق التاريخ بلغة الواجهة) فيبقى هذا المنطق بلا متصفّح.
 */
export function loadsLogRows(loads: VanLoadRow[], tr: Tr, when: (iso: string) => string, withLocation: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of loads) {
    for (const it of l.items) {
      out.push({
        [tr('التاريخ')]: when(l.createdAt),
        [tr('المندوب')]: l.salesRep?.name ?? '—',
        ...(withLocation && { [tr('الموقع')]: l.location?.name ?? tr('بلا موقع') }),
        [tr('الصنف')]: it.product?.name ?? '—',
        // لقطة وحدة البند لا وحدة الصنف الحالية: بعد التحويل صارت وحدة الصنف «حبة» والبند كرتون
        [tr('الوحدة')]: it.unitName ?? it.product?.unit ?? '',
        [tr('الكمية')]: qtyNum(Number(it.qty)),
        [tr('بواسطة')]: loadByLabel(l.createdBy, tr),
        [tr('ملاحظة')]: l.note ?? '',
      });
    }
  }
  return out;
}
