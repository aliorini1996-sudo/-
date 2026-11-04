/**
 * مجاميع المخزون بالوحدة الكبرى لكل صنف — عرضٌ فقط، نقيٌّ بلا قاعدة بيانات.
 *
 * مجموع «8,191 بالوحدات الصغرى» عبر أصنافٍ مختلفة لا يُقرأ (طلب المالك ٤ نوفمبر ٢٠٢٦): حبّات ماءٍ وبيضٍ وقوارير في رقمٍ
 * واحد. فيُجمَع كل صنفٍ بوحدته الكبرى (الرئيسية الصالحة، وإلّا أكبر وحدةٍ نشطة، وإلّا أساسه) ويُضمّ ما تشابه اسمه:
 * «22.75 كرتون · 40 حبة». الحساب كلّه يبقى بالأساس؛ القسمة هنا على رقمٍ محسوبٍ سلفاً للعرض وحده، ولا يعود منها شيء
 * إلى رصيدٍ أو قيمة. وكل رقمٍ بجانب اسم وحدته هو (الفخّ الحاكم في adminUnits: رقم أساسٍ بجانب «كرتون» يُقرأ ٢٤ ضعفاً).
 */
import { roundHalfUp } from '../lib/money';
import { primaryUnitOf, type PrimaryHolder, type UnitDef } from './units';

/** الصنف كما يحتاجه الحلّ: أساسه ووحداته ورئيسيّه — صفّ product بـUNIT_SELECT وprimaryUnitId */
export type MajorUnitProduct = PrimaryHolder & { unit?: string | null };

/** الوحدة الكبرى لصنف: اسمها ومعاملها إلى الأساس (١ حين لا وحدة أكبر) */
export interface MajorUnit { name: string; factor: number }

/** مجموعٌ بوحدةٍ واحدة — `qty` بتلك الوحدة لا بالأساس */
export interface UnitTotal { unit: string; qty: number }

const nameOf = (u: { name?: string | null } | null | undefined): string => String(u?.name ?? '').trim();

/**
 * الوحدة الكبرى: الرئيسية الصالحة (primaryUnitOf — النشطة بمعاملٍ صحيح ≥ ٢)، وإلّا أكبر وحدةٍ نشطة معاملها > ١ (أوّلها عند
 * التساوي، كـbiggestUnit في الواجهة)، وإلّا الأساس بمعامل ١. مرآة primaryOrBiggest في web-admin/src/lib/adminUnits.ts.
 */
export function majorUnitOf(p: MajorUnitProduct | null | undefined): MajorUnit {
  const primary = primaryUnitOf(p);
  if (primary && nameOf(primary)) return { name: nameOf(primary), factor: Number(primary.factor) };
  let big: UnitDef | null = null;
  for (const u of p?.units ?? []) {
    const f = Number(u?.factor);
    if (!u || u.isActive === false || !Number.isFinite(f) || f <= 1 || !nameOf(u)) continue;
    if (!big || f > Number(big.factor)) big = u;
  }
  if (big) return { name: nameOf(big), factor: Number(big.factor) };
  return { name: String(p?.unit ?? '').trim(), factor: 1 };
}

/**
 * كمياتٌ بالأساس لأصنافٍ شتّى ⇒ مجاميع بالوحدة الكبرى مضمومةً باسمها (بعد القصّ). الجمع خامٌ ثم التقريب لأربع خانات في
 * آخره (كمجاميع الأساس حولها)، وما صار صفراً يسقط، والترتيب بالأكبر قيمةً مطلقة ثم بالاسم. صنفٌ بلا بيانات، أو بلا اسم
 * وحدةٍ يُعرف، أو كميةٌ غير رقم ⇒ يُتخطّى بلا خطأ.
 */
export function majorTotals(entries: readonly { product?: MajorUnitProduct | null; baseQty: number }[]): UnitTotal[] {
  const sums = new Map<string, number>();
  for (const e of entries) {
    const q = Number(e?.baseQty);
    if (!e?.product || !Number.isFinite(q)) continue;
    const u = majorUnitOf(e.product);
    if (!u.name || !(u.factor > 0)) continue;
    sums.set(u.name, (sums.get(u.name) ?? 0) + q / u.factor);
  }
  const out: UnitTotal[] = [];
  // roundHalfUp هي roundDecimal نفسها (utils/helpers) — من lib/money مباشرةً كي يبقى الملف بلا قاعدة
  for (const [unit, raw] of sums) {
    const qty = roundHalfUp(raw, 4);
    if (Math.abs(qty) >= 1e-9) out.push({ unit, qty });
  }
  return out.sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty) || (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
}

/** صفّ مخزون سيارة (computeStock) بما يحتاجه ملخّص المناديب — الكميات بالأساس */
export interface StockMajorRow {
  productId: string; unit: string; primaryUnitId?: string | null;
  remaining: number; loaded: number; sold: number; damaged: number;
}

/** مجاميع سيارة مندوب بالوحدة الكبرى (GET /van-stock/summary) */
export interface RepStockMajor { remaining: UnitTotal[]; loaded: UnitTotal[]; sold: UnitTotal[]; damaged: UnitTotal[] }

/**
 * أعمدة ملخّص المناديب الأربعة بالوحدة الكبرى، من الصفوف نفسها التي تصنع totalRemaining/totalLoaded/totalSold/totalDamaged:
 * المتبقّي بإشارته (كمجموعه بالأساس)، والتالف بموجبه وحده (Math.max(0, x.damaged) كـtotalDamaged). `unitsOf`: صنف ← وحداته.
 */
export function repStockMajor(rows: readonly StockMajorRow[], unitsOf: ReadonlyMap<string, UnitDef[]>): RepStockMajor {
  const sum = (pick: (x: StockMajorRow) => number) => majorTotals(rows.map((x) => ({
    product: { unit: x.unit, primaryUnitId: x.primaryUnitId ?? null, units: unitsOf.get(x.productId) ?? [] },
    baseQty: pick(x),
  })));
  return {
    remaining: sum((x) => x.remaining),
    loaded: sum((x) => x.loaded),
    sold: sum((x) => x.sold),
    damaged: sum((x) => Math.max(0, x.damaged)),
  };
}
