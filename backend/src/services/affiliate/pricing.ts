/**
 * أسعار الباقات كما تُعرض للسفير في بوابته (تبويب «الباقات والأسعار») — منطقٌ خالص.
 *
 * المصدر **كتالوج الخادم المعتمد** (`QUOTE_PACKAGES` في services/quotes.ts) لا نسخةٌ ثانية:
 * سعرٌ يتغيّر هناك يتغيّر هنا — ما لم يحدّد المالك للسفراء سعراً آخر.
 *
 * خصمٌ إقليميّ بقرار المالك (16 سبتمبر 2026): **سفير اليمن** — المُعرَّف بمفتاح جواله
 * ‎+967 المختار عند التسجيل — يرى الأسعار أقلّ بـ٣٣٪، مقرّبةً لأقرب ريال.
 *
 * قرار المالك (19 نوفمبر 2026): المالك يحدّد من «إعدادات السفراء» في لوحته **سعر كل باقة
 * يراه السفراء** (شهرياً وسنوياً، بالريال الصحيح شاملاً الضريبة) ونسبة خصم سفراء اليمن (0–90).
 * السعر الفارغ = سعر الكتالوج الرسمي، والخصم الإقليميّ يُطبَّق فوق السعر المعروض. أمّا
 * `listMonthly/listYearly` فتبقى الكتالوج الرسمي دائماً (مرجع المقارنة).
 */
import { QUOTE_PACKAGES, QuotePackageId } from '../quotes';

export interface RegionalDiscount {
  /** رمز الدولة ISO */
  region: string;
  /** بادئة الجوال الدولية المخزَّنة (أرقام بلا +) */
  dialPrefix: string;
  pct: number;
}

/** النسبة هنا هي الافتراضيّ — المالك يغيّرها من إعداداته (`yemenDiscountPct`) */
export const REGIONAL_DISCOUNTS: readonly RegionalDiscount[] = [
  { region: 'YE', dialPrefix: '967', pct: 33 },
];

// ───────────────────── إعدادات المالك: أسعار السفراء ─────────────────────

export const PACKAGE_IDS = Object.keys(QUOTE_PACKAGES) as QuotePackageId[];
/** حدود سعر السفير بالريال الصحيح شاملاً الضريبة */
export const AMB_PRICE_MIN = 1;
export const AMB_PRICE_MAX = 1_000_000;
/** حدود نسبة خصم سفراء اليمن */
export const YEMEN_PCT_MIN = 0;
export const YEMEN_PCT_MAX = 90;
export const DEFAULT_YEMEN_DISCOUNT_PCT = REGIONAL_DISCOUNTS.find((d) => d.region === 'YE')!.pct;

// نوعٌ مستعار لا interface: يُكتب في عمود Json (InputJsonObject يشترط فهرساً ضمنيّاً)
export type PackagePriceOverride = {
  /** السعر الشهريّ للسفير بالريال — الغائب = الكتالوج */
  monthly?: number;
  /** سعر السنة للسفير بالريال — الغائب = الكتالوج */
  yearly?: number;
};
export type PackagePriceOverrides = Partial<Record<QuotePackageId, PackagePriceOverride>>;

export interface AmbassadorPricingSettings {
  packagePrices: PackagePriceOverrides;
  yemenDiscountPct: number;
}

const isPrice = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= AMB_PRICE_MIN && v <= AMB_PRICE_MAX;
const isPct = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= YEMEN_PCT_MIN && v <= YEMEN_PCT_MAX;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * خريطة أسعار السفراء نظيفةً: معرّفات الكتالوج وحدها، والقيم الصالحة وحدها (null/غائب/تالف =
 * الكتالوج)، ولا باقة بلا سعر. تُستعمل لقراءة العمود ولتطبيع جسم PUT /settings بعد التحقّق.
 */
export function cleanPackagePrices(raw: unknown): PackagePriceOverrides {
  const out: PackagePriceOverrides = {};
  if (!isObj(raw)) return out;
  for (const id of PACKAGE_IDS) {
    if (!own(raw, id) || !isObj(raw[id])) continue;
    const e = raw[id] as Record<string, unknown>;
    const o: PackagePriceOverride = {};
    if (isPrice(e.monthly)) o.monthly = e.monthly;
    if (isPrice(e.yearly)) o.yearly = e.yearly;
    if (o.monthly !== undefined || o.yearly !== undefined) out[id] = o;
  }
  return out;
}

/**
 * عمود `pricingJson` ⇒ الإعدادات. غياب الصفّ أو العمود (null) أو تلفه = الكتالوج والخصم الافتراضيّ —
 * فالبرنامج يعمل من أوّل نشرٍ بلا كتابةٍ يدوية في القاعدة.
 */
export function parseAmbassadorPricing(json: unknown): AmbassadorPricingSettings {
  if (!isObj(json)) return { packagePrices: {}, yemenDiscountPct: DEFAULT_YEMEN_DISCOUNT_PCT };
  return {
    packagePrices: cleanPackagePrices(json.packagePrices),
    yemenDiscountPct: isPct(json.yemenDiscountPct) ? json.yemenDiscountPct : DEFAULT_YEMEN_DISCOUNT_PCT,
  };
}

/** الإعدادات ⇒ قيمة العمود (كائنٌ صريح بالحقلين) */
export function ambassadorPricingJson(p: AmbassadorPricingSettings): { packagePrices: PackagePriceOverrides; yemenDiscountPct: number } {
  return { packagePrices: cleanPackagePrices(p.packagePrices), yemenDiscountPct: p.yemenDiscountPct };
}

/** الكتالوج الرسمي كما تعرضه لوحة المالك بجانب حقول أسعار السفراء (عنصراً نائباً) */
export function packageCatalog(): Array<{ id: QuotePackageId; name: string; monthly: number; yearly: number }> {
  return PACKAGE_IDS.map((id) => ({ id, name: QUOTE_PACKAGES[id].name, monthly: QUOTE_PACKAGES[id].total, yearly: QUOTE_PACKAGES[id].yearly }));
}

// ───────────────────────────── العرض للسفير ─────────────────────────────

/**
 * الخصم الإقليميّ لجوال السفير المخزَّن (`967…` لليمن، `9665…` للسعودية) — أو null.
 * نسبة اليمن من إعدادات المالك إن مُرّرت، وإلا الافتراضيّ؛ ونسبةٌ صفرٌ = لا خصم (null).
 */
export function regionalDiscountFor(
  phone: string | null | undefined,
  pricing?: { yemenDiscountPct?: number } | null,
): RegionalDiscount | null {
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  if (!digits) return null;
  const d = REGIONAL_DISCOUNTS.find((x) => digits.startsWith(x.dialPrefix));
  if (!d) return null;
  const custom = pricing?.yemenDiscountPct;
  const pct = d.region === 'YE' && isPct(custom) ? custom : d.pct;
  return pct > 0 ? { ...d, pct } : null;
}

/** سعرٌ بعد الخصم مقرَّباً لأقرب ريال — بالهللات */
export function discountedHalalas(riyals: number, pct: number): number {
  return Math.round((riyals * (100 - pct)) / 100) * 100;
}

export interface AffiliatePackagePrice {
  id: QuotePackageId;
  /** السعر المعلن في الكتالوج الرسمي — شامل الضريبة، بالهللات (لا يمسّه سعر المالك للسفراء) */
  listMonthlyHalalas: number;
  listYearlyHalalas: number;
  /** سعر السفراء قبل الخصم الإقليميّ: سعر المالك إن حدّده وإلا الكتالوج — شامل الضريبة، بالهللات */
  baseMonthlyHalalas: number;
  baseYearlyHalalas: number;
  /** السعر المعروض لهذا السفير — شامل الضريبة، بالهللات */
  monthlyHalalas: number;
  yearlyHalalas: number;
}

export interface AffiliatePricing {
  region: string | null;
  discountPct: number;
  vatInclusive: true;
  packages: AffiliatePackagePrice[];
}

/**
 * @param pricing إعدادات المالك (`getSettings()` يحملها) — بدونها الكتالوج والخصم الافتراضيّ.
 * الخصم الإقليميّ يُطبَّق **فوق** السعر المعروض (سعر المالك أو الكتالوج) مقرّباً لأقرب ريال.
 */
export function affiliatePricing(
  phone: string | null | undefined,
  pricing?: { packagePrices?: PackagePriceOverrides; yemenDiscountPct?: number } | null,
): AffiliatePricing {
  const d = regionalDiscountFor(phone, pricing);
  const pct = d?.pct ?? 0;
  const overrides = cleanPackagePrices(pricing?.packagePrices);
  const packages = PACKAGE_IDS.map((id) => {
    const p = QUOTE_PACKAGES[id];
    const monthly = overrides[id]?.monthly ?? p.total;
    const yearly = overrides[id]?.yearly ?? p.yearly;
    return {
      id,
      listMonthlyHalalas: p.total * 100,
      listYearlyHalalas: p.yearly * 100,
      baseMonthlyHalalas: monthly * 100,
      baseYearlyHalalas: yearly * 100,
      monthlyHalalas: pct ? discountedHalalas(monthly, pct) : monthly * 100,
      yearlyHalalas: pct ? discountedHalalas(yearly, pct) : yearly * 100,
    };
  });
  return { region: d?.region ?? null, discountPct: pct, vatInclusive: true, packages };
}
