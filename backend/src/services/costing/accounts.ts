/**
 * أثر كل لقطة تكلفة على الدفاتر («ربط الدفاتر» — العقد §8). يستعمله الآن المعاينة والمطابقة (R8/R9: المتوقَّع)،
 * وتبني عليه قيود L4 (تكلفة المبيعات) وL6 (حركات المخزون والمشتريات) لاحقاً — فمصدر الحقيقة واحد.
 *
 * بعلامة المدين (+)، ومتوازن دائماً: Σ inventory + cogsMilli + writeOffMilli + counterMilli = 0.
 * المخزون: WH ⇒ 114001 (INVENTORY_WAREHOUSE)، VAN:<rep> ⇒ 114002 (INVENTORY_VAN) بمندوبه. cogs ⇒ 511001 (أو تكلفة الفئة)،
 * writeOff ⇒ 514001، counter بدوره (GRNI ⇒ 211002، VENDOR ⇒ مقابل مرتجع المورّد، ADJUSTMENT ⇒ حساب سبب التسوية — L6).
 *
 * سطر مخزون بقيمة صفرية لا يُدرج (لا سطر صفري في قيد). صرفٌ بلا prisma.
 */
import { repOfLocation, type CounterRole, type GlImpact, type LocationKey, type Milli, type StepOutput } from './types';

export type GlImpactInput = Pick<
  StepOutput,
  'kind' | 'location' | 'toLocation' | 'valueMilli' | 'varianceMilli' | 'memoMilli' | 'reason'
>;

function impact(
  inventory: { location: LocationKey; milli: Milli }[],
  cogsMilli: Milli,
  writeOffMilli: Milli,
  counterMilli: Milli,
  counterRole: CounterRole,
): GlImpact {
  return { inventory: inventory.filter((l) => l.milli !== 0n), cogsMilli, writeOffMilli, counterMilli, counterRole };
}

/**
 * جدول §8 حرفياً (Δ = valueMilli، var = varianceMilli، memo = memoMilli):
 * - الوارد والتسويات ومرتجع المورّد: المخزون Δ، والفرق (سدّ حفرة) تكلفة مبيعات، والمقابل يأخذ −(Δ + var) — أي القيمة
 *   الإجمالية G للوارد (GRNI) وللتسوية (ADJUSTMENT) ولمرتجع المورّد (VENDOR؛ فرقه صفر دائماً لأنه خروج).
 * - التحويل: مدين الهدف بما دخله (−Δ − var)، ودائن المصدر بما خرج منه (Δ)، والفرق تكلفة مبيعات.
 * - البيع وإلغاؤه والمرتجع العائد وإلغاؤه: المخزون Δ مقابل تكلفة المبيعات −Δ (يشمل فرق سدّ الحفرة ضمناً).
 * - الشطب وإلغاؤه: 514001 بالمذكِّرة مقابل 511001 (البضاعة لم تعد مخزوناً: تكلفة بيعها تصير خسارة تلف/عدم إعادة).
 * - التبديل: المخزون Δ، والفرق تكلفة مبيعات، والمذكِّرة على 514001 (إلى «يعود» سالبة = −G، وإلى «لا يعود» = +|Δ|).
 */
export function glImpactOf(o: GlImpactInput): GlImpact {
  const d = o.valueMilli;
  const v = o.varianceMilli;
  const m = o.memoMilli;
  const at = (milli: Milli) => [{ location: o.location, milli }];
  switch (o.kind) {
    case 'RECEIVE':
      return impact(at(d), v, 0n, -(d + v), 'GRNI');
    case 'VENDOR_RETURN':
      return impact(at(d), v, 0n, -(d + v), 'VENDOR');
    case 'WH_ADJUST':
    case 'VAN_ADJUST':
    case 'ZERO_RUN':
      return impact(at(d), v, 0n, -(d + v), 'ADJUSTMENT');
    case 'VAN_LOAD':
    case 'VAN_UNLOAD': {
      if (!o.toLocation) throw new Error(`COSTING_TRANSFER_WITHOUT_TARGET: ${o.kind}`);
      return impact([{ location: o.location, milli: d }, { location: o.toLocation, milli: -d - v }], v, 0n, 0n, 'NONE');
    }
    case 'DAMAGE_OUT':
      return impact([], 0n, 0n, 0n, 'NONE');
    case 'VAN_SALE':
    case 'WAREHOUSE_SALE':
    case 'SALE_CANCEL':
    case 'VAN_RETURN_RESTOCK':
    case 'WAREHOUSE_RETURN_RESTOCK':
      return impact(at(d), -d, 0n, 0n, 'NONE');
    case 'RETURN_WRITE_OFF':
    case 'RETURN_CANCEL':
      // RETURN_WRITE_OFF: Δ = 0 ⇒ cogs −memo؛ RETURN_CANCEL عائداً: memo = 0 ⇒ cogs −Δ، ومشطوباً: Δ = 0 ⇒ cogs −memo
      return impact(at(d), -d - m, m, 0n, 'NONE');
    case 'RESTOCK_TOGGLE':
      return impact(at(d), v, m, 0n, 'NONE');
    default: {
      const never: never = o.kind;
      throw new Error(`COSTING_UNKNOWN_KIND: ${String(never)}`);
    }
  }
}

/** = glImpactOf(o).cogsMilli — متوقَّع 511001 (R9: Σ للّقطات غير المشمولة بالافتتاح) */
export function cogsImpactMilli(o: GlImpactInput): Milli {
  return glImpactOf(o).cogsMilli;
}

/** حساب مخزون الموقع ومندوبه: المستودع 114001، والسيارة 114002 بمندوبها (والسيارة المجهولة بلا مندوب) */
export function inventoryAccountOf(location: LocationKey): {
  accountKey: 'INVENTORY_WAREHOUSE' | 'INVENTORY_VAN';
  salesRepId: string | null;
} {
  if (location === 'WH') return { accountKey: 'INVENTORY_WAREHOUSE', salesRepId: null };
  if (!location.startsWith('VAN:')) throw new RangeError(`موقع غير معروف: ${location}`);
  return { accountKey: 'INVENTORY_VAN', salesRepId: repOfLocation(location) };
}
