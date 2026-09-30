/**
 * المندوب الذكي — تصنيف أنواع المنافذ (قائمة ثابتة على مستوى المنصّة، وكل شركة تختار منها).
 *
 * الرمز هو ما يُخزَّن (Customer.outletType، AiOutlet.outletType، AiRepSettings.targetOutletTypes).
 * أنواع Google من Table A في Places API (New) — تحقّقنا من وجودها كلها في includedTypes.
 * الكلمات المفتاحية لمصنِّف أسماء العملاء القائمين: **يقترح** والإدارة **تؤكّد**.
 * search: كلمتا البحث العام في خرائط Google (الأولى للنافذة الواسعة والثانية لنافذة المركز — صياغتان فلا تعود
 * المحلات البارزة نفسها في الطلبين).
 */

export const OUTLET_TYPES = [
  { code: 'GROCERY', ar: 'بقالة / تموينات', search: ['بقالة', 'تموينات'], google: ['grocery_store', 'food_store', 'market'], keywords: ['بقاله', 'بقالة', 'تموينات', 'تموين', 'مواد غذائيه', 'مواد غذائية', 'grocery'] },
  { code: 'MINIMARKET', ar: 'ميني ماركت', search: ['ميني ماركت', 'ماركت'], google: ['convenience_store'], keywords: ['ميني ماركت', 'مينى ماركت', 'مني ماركت', 'mini market', 'minimarket', 'اسواق صغيره'] },
  { code: 'SUPERMARKET', ar: 'سوبرماركت', search: ['سوبرماركت', 'أسواق'], google: ['supermarket', 'discount_store'], keywords: ['سوبرماركت', 'سوبر ماركت', 'سوبر', 'اسواق', 'أسواق', 'supermarket', 'market'] },
  { code: 'HYPERMARKET', ar: 'هايبر ماركت', search: ['هايبر ماركت', 'هايبر'], google: ['hypermarket', 'warehouse_store', 'department_store'], keywords: ['هايبر', 'hyper', 'كارفور', 'لولو', 'بنده', 'الدانوب', 'العثيم'] },
  { code: 'WHOLESALE', ar: 'جملة', search: ['محل مواد غذائية بالجملة', 'جملة مواد غذائية'], google: ['wholesaler'], keywords: ['جمله', 'جملة', 'موزع', 'توزيع', 'wholesale'] },
  { code: 'PHARMACY', ar: 'صيدلية', search: ['صيدلية', 'صيدليات'], google: ['pharmacy', 'drugstore'], keywords: ['صيدليه', 'صيدلية', 'صيدليات', 'pharmacy'] },
  { code: 'CAFE', ar: 'مقهى / كوفي', search: ['كوفي', 'مقهى'], google: ['cafe', 'coffee_shop'], keywords: ['كافيه', 'كوفي', 'قهوه', 'قهوة', 'مقهى', 'cafe', 'coffee'] },
  { code: 'CAFETERIA', ar: 'كافتيريا / بوفيه', search: ['كافتيريا', 'بوفية'], google: ['cafeteria', 'fast_food_restaurant'], keywords: ['كافتيريا', 'كفتيريا', 'بوفيه', 'بوفية', 'cafeteria'] },
  { code: 'RESTAURANT', ar: 'مطعم', search: ['مطعم', 'مطاعم'], google: ['restaurant'], keywords: ['مطعم', 'مطاعم', 'مشويات', 'بروستد', 'restaurant'] },
  { code: 'BAKERY', ar: 'مخبز', search: ['مخبز', 'أفران'], google: ['bakery'], keywords: ['مخبز', 'مخابز', 'فرن', 'افران', 'أفران', 'bakery'] },
  { code: 'FUEL_SHOP', ar: 'متجر محطة وقود', search: ['محطة وقود', 'محطة بنزين'], google: ['gas_station'], keywords: ['محطه', 'محطة', 'بنزين', 'وقود', 'station'] },
] as const;

export type OutletTypeCode = (typeof OUTLET_TYPES)[number]['code'];
export const OUTLET_TYPE_CODES: readonly OutletTypeCode[] = OUTLET_TYPES.map(t => t.code);

export function isOutletType(v: unknown): v is OutletTypeCode {
  return typeof v === 'string' && (OUTLET_TYPE_CODES as readonly string[]).includes(v);
}

export function outletTypeLabel(code: string | null | undefined): string {
  return OUTLET_TYPES.find(t => t.code === code)?.ar ?? 'غير مصنّف';
}

/** كلمات البحث العام لنوع (لا تقطيع لاسمه المعروض: «جملة» وحدها تجلب كل ما هبّ). */
export function searchTermsFor(code: string): readonly string[] {
  return OUTLET_TYPES.find(t => t.code === code)?.search ?? [];
}

/** أنواع Google لقائمة رموز (بلا تكرار) — تُمرَّر إلى includedTypes. */
export function googleTypesFor(codes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const c of codes) for (const g of OUTLET_TYPES.find(t => t.code === c)?.google ?? []) out.add(g);
  return [...out];
}

/**
 * نوع Google للمكان ← رمزنا. الأولوية لـprimaryType، ثم بقية الأنواع بترتيب تصنيفنا،
 * مقيّدةً بالأنواع التي تستهدفها الشركة (فمحطة فيها بقالة تُحسب بقالة إن كانت البقالة هي المستهدفة).
 */
export function outletTypeFromGoogle(primaryType: string | null | undefined, types: readonly string[] | null | undefined, allowed: readonly string[]): OutletTypeCode | null {
  const allowedSet = new Set(allowed);
  const byGoogle = (g: string): OutletTypeCode | null => {
    const hit = OUTLET_TYPES.find(t => allowedSet.has(t.code) && (t.google as readonly string[]).includes(g));
    return hit ? hit.code : null;
  };
  if (primaryType) { const c = byGoogle(primaryType); if (c) return c; }
  for (const g of types ?? []) { const c = byGoogle(g); if (c) return c; }
  return null;
}

/** تطبيع عربي خفيف للمطابقة: التشكيل، والهمزات، والتاء المربوطة، والياء. */
export function normalizeAr(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * اقتراح نوع المنفذ من اسم العميل — **اقتراح** فقط، تؤكّده الإدارة. الأطول تطابقاً يفوز
 * («سوبر ماركت» قبل «ماركت»، و«ميني ماركت» قبل «سوبر»)؛ لا تطابق ⇒ null.
 */
export function suggestOutletType(...names: (string | null | undefined)[]): OutletTypeCode | null {
  const text = normalizeAr(names.filter(Boolean).join(' '));
  if (!text) return null;
  let best: { code: OutletTypeCode; len: number } | null = null;
  for (const t of OUTLET_TYPES) {
    for (const kw of t.keywords) {
      const k = normalizeAr(kw);
      if (k && text.includes(k) && (!best || k.length > best.len)) best = { code: t.code, len: k.length };
    }
  }
  return best?.code ?? null;
}

/**
 * نوع محلٍّ من البحث العام (تصنيفه المعروض نصٌّ مترجَم لا رمز Google، فلا outletTypeFromGoogle): تصنيف Google أولاً ثم
 * الاسم ثم نوع البحث الذي وجده. null = تصنيف Google **والاسم** نوعان لا تستهدفهما الشركة (كسلاسل الهايبر لشركة
 * بقالات) ⇒ يُسقط. الاسم وحده لا يُسقط محلاً — «أسواق…» كثيرٌ منها بقالات؛ ويُبقي ما أسقطه التصنيف: Google تصنّف
 * بقالات كثيرة «سوبرماركت» («بقالة ميد»، «تموينات أسطورة الخليج» في ردٍّ حقيقي)، فلا تغيب عن شركة بقالات.
 */
export function publicOutletType(p: { categories: readonly string[]; name: string }, queryType: string, targets: readonly string[]): string | null {
  const byCategory = suggestOutletType(p.categories.join(' '));
  if (byCategory && targets.includes(byCategory)) return byCategory;
  const byName = suggestOutletType(p.name);
  if (byName && targets.includes(byName)) return byName;
  return byCategory ? null : queryType;
}
