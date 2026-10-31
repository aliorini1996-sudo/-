/**
 * «لوكيشن» (طلب المالك ٢١ أكتوبر ٢٠٢٦) — ميزةٌ **مطفأة افتراضياً** يفعّلها المالك لكل شركة (Tenant.locationsEnabled).
 *
 * الشركة تعرّف مواقعها (SalesLocation): اسمٌ — فرعٌ أو مستودعٌ أو مدينة — ونقطةٌ على الخريطة. كل مندوبٍ في موقعٍ واحد
 * (SalesRep.locationId)، وكلّ **فاتورةٍ وتحميلٍ** يُختمان بموقع مندوبهما **وقت الإصدار** (Invoice.locationId /
 * VanLoad.locationId). فإن نُقل المندوب لموقعٍ آخر بقيت مستنداته القديمة على موقعها وقت إصدارها (قرار المالك)، والتقارير
 * تُجمَّع بالختم لا بموقع المندوب الحاليّ — فمجموع المواقع (ومعها «بلا موقع») إجمالي الشركة بلا ازدواج.
 *
 * قرارات مسجَّلة هنا لأنها تُقرأ من مساراتٍ كثيرة:
 *  ١. **فقط الفواتير والتحميلات** (قرار المالك): لا سندات قبض ولا زيارات. ومن حركات السيارة نوع LOAD وحده — التنزيل
 *     والتسوية والإزالة حركاتٌ إدارية لا «تحميل».
 *  ٢. **الختم الجديد يتطلّب العَلَم مفعّلاً** (`repStampLocation`): الشركة المطفأة لا يُكتب لها ختمٌ أبداً — صفر تغيير في
 *     سلوكها — والإطفاء بعد التفعيل يوقف الختم ويُبقي المواقع وإسناد المناديب والأختام القديمة لإعادة التفعيل.
 *  ٣. **المرتبط يرث ختم أصله كما هو** (كوسم الفرق): المرتجع من فاتورة بيع (المرحلة الأولى) والإشعار الدائن والمدين
 *     (المرحلة الثانية) يُحسبون لموقع فاتورتهم الأصلية — ولو null لأصلٍ قبل التفعيل — لا لموقع المندوب اليوم، فيبقى صافي
 *     مبيعات كل موقع متّسقاً. والإرث نسخُ حقيقةٍ عن الأصل لا ختمٌ جديد، فلا يشترط العَلَم. المرتجع غير المرتبط ختمٌ جديد.
 *  ٤. **بلا استعلامٍ جديد في مسار الإصدار:** الختم يُقرأ من صفّ المندوب الذي يقرؤه المسار أصلاً (مع عَلَم الشركة في
 *     `include` القائم)، والإرث من صفّ الأصل المقروء أصلاً (قفل الإشعار وتحقّق المرتجع المرتبط). تسلسل استعلامات مسار
 *     المرحلة الأولى محروسٌ حرفياً (invoices-phase2-route.test.ts) فلا يُضاف إليه شيء.
 *  ٥. **الرفع الأوف‑لاين يُختم وقت الرفع** بموقع المندوب حينها لا وقت إنشائه على الجهاز — حالةٌ نادرة (نُقل المندوب بين
 *     الإصدار على الجهاز والمزامنة) مقبولة: الجهاز لا يعرف موقعه الإداري ولا يُرسله.
 *  ٦. **التاريخ** في الملخّص بأيام الشركة (tenantTz + paymentMethodsRange): الفاتورة بتاريخها (invoiceDate)، والتحميل
 *     بلحظة تسجيله (createdAt — لا تاريخ مستندٍ له).
 *  ٧. **التحميل بالكمية لا بالقيمة:** لا كلفةَ مخزّنة لكل تحميل (warehouseCost يبني طبقاتٍ لكل سيارة لا لكل تحميل)،
 *     وسعر البيع ليس كلفة — فالملخّص يعرض العدد والكميات (إجمالاً ولكل صنف) بلا مبلغٍ مُختلَق.
 *
 * دوالٌ صافية بلا قاعدة بيانات (الاستعلام في routes/locations.ts والمسارات المُصدِرة) لتُختبر وحدها.
 */

import { primaryUnitOf, type UnitDef } from './units';

/** أقصى طول لاسم الموقع (كاسم الفريق) */
export const LOCATION_NAME_MAX = 60;

/** اسم موقعٍ صالح: يُشذَّب ويُطوى فراغه، ولا يتجاوز ٦٠ حرفاً */
export const locationName = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, LOCATION_NAME_MAX);

/** صفّ المندوب كما يقرؤه مسار الإصدار: موقعه الحاليّ وعَلَم شركته (`include: { tenant: { select: { locationsEnabled: true } } }`) */
export interface RepLocationRow {
  locationId?: string | null;
  tenant?: { locationsEnabled?: boolean | null } | null;
}

/**
 * ختم الموقع لمستندٍ **جديد** (فاتورة أو تحميل) من صفّ مندوبه: موقعه الحاليّ إن كانت الميزة مفعّلة لشركته، وإلا null.
 * لا رفض هنا أبداً — مستندٌ أوف‑لاين يُعاد رفعه لا يصير «مرفوضاً» لأن مندوبه بلا موقع؛ يُختم «بلا موقع» وحسب.
 */
export function repStampLocation(rep: RepLocationRow | null | undefined): string | null {
  if (!rep || rep.tenant?.locationsEnabled !== true) return null;
  return typeof rep.locationId === 'string' && rep.locationId ? rep.locationId : null;
}

/** ختم المستند المرتبط (مرتجع من فاتورة بيع، إشعار دائن/مدين): ختم أصله كما هو — null لأصلٍ بلا ختم (القرار ٣) */
export function inheritedLocation(original: { locationId?: string | null } | null | undefined): string | null {
  const id = original?.locationId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * فلتر الموقع من `?locationId=` — نصاً وحده (كائن qs مثل locationId[not]=x يُهمل فلا يصير شرط Prisma):
 * غائب/فارغ ⇒ undefined (كل المواقع)، `none` ⇒ null («بلا موقع»)، وإلا معرّف الموقع.
 */
export function locationFilterOf(raw: unknown): string | null | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return raw === 'none' ? null : raw;
}

/**
 * قيد الموقع على مستندٍ مختوم (فاتورة/تحميل): **مفتاحٌ عدديّ واحد** `locationId` — لا AND ولا OR في المستوى الأعلى،
 * فلا يمحو قيد النطاق (مفتاح AND) ولا بحث القائمة (مفتاح OR) عند النشر.
 */
export const locationDocWhere = (loc: string | null | undefined) => (loc === undefined ? {} : { locationId: loc });

/** نقطة الموقع: الزوج معاً أو لا شيء، وضمن مدى الإحداثيات. null = صالحة */
export function locationPointProblem(lat: number | null | undefined, lng: number | null | undefined): string | null {
  const has = (v: unknown) => v !== null && v !== undefined;
  if (has(lat) !== has(lng)) return 'حدد النقطة على الخريطة كاملة (خط العرض والطول معا)';
  if (!has(lat)) return null;
  if (!Number.isFinite(lat) || (lat as number) < -90 || (lat as number) > 90) return 'خط العرض غير صالح';
  if (!Number.isFinite(lng) || (lng as number) < -180 || (lng as number) > 180) return 'خط الطول غير صالح';
  return null;
}

// ─── ملخّص المواقع ───

/** صفّ تجميع الفواتير من القاعدة (groupBy موقع × نوع) — المؤكَّدة وحدها */
export interface InvoiceLocationGroup { locationId: string | null; type: string; amount: number; count: number }
/** تحميلٌ (type LOAD) مع بنوده كما يُقرأ للملخّص */
export interface LoadLocationRow { locationId: string | null; items: { productId: string; qty: number }[] }
export interface LocationInfo { id: string; name: string; isActive: boolean; lat: number | null; lng: number | null }
/**
 * الصنف للملخّص: اسمه ووحدة أساسه، ومعهما (اختيارياً) وحداته و«الوحدة الرئيسية» ليعرض العارض الكمية بالرئيسية
 * («52 كرتون و2 قارورة»، R1). تمرّ إلى السطر حين للصنف رئيسية صالحة فقط (`primaryUnitOf`)، فسطر صنفٍ بلاها يبقى
 * بشكله قبل الميزة حرفاً (I1).
 */
export interface ProductInfo { name: string; unit: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null }

/**
 * سطر صنفٍ محمَّل: الكمية بالأساس، و`units` حاضرة حين للصنف رئيسية صالحة فقط (فلا يُفكَّك بلاها مجموعٌ إلى كراتين)،
 * و`primaryUnitId` حاضرٌ دائماً (D18): معرّف الرئيسية الصالحة أو null
 */
export interface LocationLoadProduct { productId: string; name: string; unit: string | null; qty: number; units?: UnitDef[]; primaryUnitId: string | null }

export interface LocationBucket {
  /** null = «بلا موقع» */
  locationId: string | null;
  name: string | null;
  isActive: boolean;
  lat: number | null;
  lng: number | null;
  /** فواتير البيع (نقدي/آجل، ومعها الإشعار المدين المخزَّن CREDIT) */
  sales: { count: number; amount: number };
  /** المرتجعات (ومعها الإشعار الدائن المخزَّن RETURN) */
  returns: { count: number; amount: number };
  /** صافي المبيعات = البيع − المرتجع */
  net: number;
  loads: { count: number; qty: number; products: LocationLoadProduct[] };
}

export interface LocationsSummary {
  rows: LocationBucket[];
  /** ما خُتم «بلا موقع» (مندوبٌ لم يُسند، أو قبل التفعيل، أو موقعٌ حُذف) — سطرٌ مستقل لا يختفي */
  none: LocationBucket;
  totals: { sales: { count: number; amount: number }; returns: { count: number; amount: number }; net: number; loads: { count: number; qty: number } };
}

/** المبالغ بثلاث منازل (عملات الدينار) كبقيّة التقارير، والكميات بأربع */
const round3 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;
const round4 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 10000) / 10000;

function emptyBucket(loc: LocationInfo | null, locationId: string | null): LocationBucket {
  return {
    locationId,
    name: loc ? loc.name : null,
    isActive: loc ? loc.isActive : true,
    lat: loc?.lat ?? null,
    lng: loc?.lng ?? null,
    sales: { count: 0, amount: 0 },
    returns: { count: 0, amount: 0 },
    net: 0,
    loads: { count: 0, qty: 0, products: [] },
  };
}

/**
 * يبني ملخّص الصفحة من تجميعات القاعدة.
 * - الصفوف: كل موقعٍ فعّال (ولو بلا حركة — «لا شيء هنا» معلومة)، والمؤرشف إن كان له حركةٌ في الفترة، وختمٌ لموقعٍ لم
 *   يعد في القائمة (حُذف بين الاستعلامين) يُضمّ إلى «بلا موقع» لا يضيع.
 * - النوع RETURN مرتجع، وما سواه بيع (الإشعار المدين يُخزَّن CREDIT فيزيد البيع كما يزيد الدَّين).
 * - الصفوف: الفعّال أولاً ثم بالاسم؛ وأصناف التحميل بالكمية تنازلياً.
 */
export function buildLocationsSummary(
  invoiceGroups: InvoiceLocationGroup[],
  loads: LoadLocationRow[],
  locations: LocationInfo[],
  products: Map<string, ProductInfo>,
): LocationsSummary {
  const known = new Map(locations.map((l) => [l.id, l]));
  const buckets = new Map<string, LocationBucket>();
  const none = emptyBucket(null, null);
  const productQty = new Map<LocationBucket, Map<string, number>>();
  const active = new Set<LocationBucket>();
  const bucketOf = (id: string | null): LocationBucket => {
    if (!id || !known.has(id)) return none;
    let b = buckets.get(id);
    if (!b) { b = emptyBucket(known.get(id)!, id); buckets.set(id, b); }
    return b;
  };
  for (const l of locations) if (l.isActive) bucketOf(l.id);

  for (const g of invoiceGroups) {
    const b = bucketOf(g.locationId);
    const amount = Number.isFinite(Number(g.amount)) ? Number(g.amount) : 0;
    const count = Number.isFinite(Number(g.count)) ? Number(g.count) : 0;
    if (!count && !amount) continue;
    const side = g.type === 'RETURN' ? b.returns : b.sales;
    side.count += count;
    side.amount += amount;
    active.add(b);
  }
  for (const l of loads) {
    const b = bucketOf(l.locationId);
    b.loads.count += 1;
    active.add(b);
    let byProduct = productQty.get(b);
    if (!byProduct) { byProduct = new Map(); productQty.set(b, byProduct); }
    for (const it of l.items) {
      const q = Number(it.qty);
      if (!Number.isFinite(q)) continue;
      b.loads.qty += q;
      byProduct.set(it.productId, (byProduct.get(it.productId) ?? 0) + q);
    }
  }

  const finish = (b: LocationBucket) => {
    b.sales.amount = round3(b.sales.amount);
    b.returns.amount = round3(b.returns.amount);
    b.net = round3(b.sales.amount - b.returns.amount);
    b.loads.qty = round4(b.loads.qty);
    b.loads.products = [...(productQty.get(b) ?? new Map<string, number>()).entries()]
      .map(([productId, qty]): LocationLoadProduct => {
        const info = products.get(productId);
        const prim = primaryUnitOf(info);
        return {
          productId, name: info?.name ?? '', unit: info?.unit ?? null, qty: round4(qty),
          ...(prim && info?.primaryUnitId ? { units: [...(info.units ?? [])], primaryUnitId: info.primaryUnitId } : { primaryUnitId: null }),
        };
      })
      .sort((x, y) => y.qty - x.qty || x.name.localeCompare(y.name, 'ar'));
    return b;
  };

  const rows = [...buckets.values()]
    // المؤرشف بلا حركة في الفترة لا يُعرض (الفعّال يُعرض دائماً)
    .filter((b) => b.isActive || active.has(b))
    .map(finish)
    .sort((x, y) => Number(y.isActive) - Number(x.isActive) || (x.name ?? '').localeCompare(y.name ?? '', 'ar'));
  finish(none);

  const totals: LocationsSummary['totals'] = { sales: { count: 0, amount: 0 }, returns: { count: 0, amount: 0 }, net: 0, loads: { count: 0, qty: 0 } };
  for (const b of [...rows, none]) {
    totals.sales.count += b.sales.count; totals.sales.amount += b.sales.amount;
    totals.returns.count += b.returns.count; totals.returns.amount += b.returns.amount;
    totals.loads.count += b.loads.count; totals.loads.qty += b.loads.qty;
  }
  totals.sales.amount = round3(totals.sales.amount);
  totals.returns.amount = round3(totals.returns.amount);
  totals.net = round3(totals.sales.amount - totals.returns.amount);
  totals.loads.qty = round4(totals.loads.qty);
  return { rows, none, totals };
}
