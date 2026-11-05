/**
 * تكرار اسم الصنف (مراجعة مخزون الشركة S4، قرار المالك D4): تحذيرٌ لا رفض — الكود وحده فريدٌ في القاعدة، والاسم المكرَّر قد
 * يكون مقصوداً. يُبحث في أصناف الشركة كلها: القائمة والموقوفة والمؤرشفة (المحذوفة بأثر)، فتُرى «كرتون بيض M» القديمة قبل
 * إنشاء صنفٍ ثانٍ بالاسم نفسه بدل إضافة وحدةٍ أصغر للأوّل.
 *
 * التطبيع: قصّ الأطراف ودمج المسافات وحالة الأحرف اللاتينية — بلا تطبيع للعربية (الهمزات والتاء المربوطة): التحذير يشهد
 * لاسمٍ مطابقٍ لا لاسمٍ يشبهه.
 */
import type { Prisma } from '@prisma/client';

/** مفتاح المقارنة: قصٌّ ودمجُ المسافات وأحرفٌ لاتينية صغيرة */
export function productNameKey(s: string | null | undefined): string {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** صنفٌ يطابق الاسم كما يعود في التحذير — archived: محذوفٌ مؤرشف بأثره */
export interface NameMatch { id: string | null; code: string; name: string; status: string; archived: boolean; row?: number }

/** تحذير الاسم المكرَّر بجوار data في ردّ الإنشاء والتعديل والاستيراد — لا يمنع شيئاً */
export interface DuplicateNameWarning { code: 'DUPLICATE_NAME'; matches: NameMatch[]; row?: number; name?: string }

/** سقف المطابقات في الردّ — الاسم المكرَّر عشرات المرّات لا يُحمَّل كله */
export const NAME_MATCHES_MAX = 20;

interface ProductNameRow { id: string; code: string; name: string; status?: string | null; deletedAt?: Date | null }

const matchOf = (p: ProductNameRow): NameMatch => ({
  id: p.id, code: p.code, name: p.name, status: String(p.status ?? 'ACTIVE'), archived: p.deletedAt != null,
});

/** أطول كلمةٍ في الاسم — مرشّحٌ رخيص في القاعدة (contains بلا حالة أحرف) قبل المقارنة الدقيقة هنا */
function longestToken(key: string): string {
  return key.split(' ').reduce((a, b) => (b.length > a.length ? b : a), '');
}

/**
 * أصناف الشركة التي يطابق اسمها `name` بعد التطبيع — ومنها الموقوفة والمؤرشفة، بلا الصنف `excludeId` نفسه (التعديل). اسمٌ فارغ ⇒ [].
 */
export async function duplicateNameMatches(
  db: Pick<Prisma.TransactionClient, 'product'>, tenantId: string, name: string | null | undefined, excludeId?: string | null,
): Promise<NameMatch[]> {
  const key = productNameKey(name);
  if (!key) return [];
  const rows = await db.product.findMany({
    where: { tenantId, name: { contains: longestToken(key), mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, code: true, name: true, status: true, deletedAt: true },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  return (rows ?? []).filter((p) => productNameKey(p.name) === key).slice(0, NAME_MATCHES_MAX).map(matchOf);
}

/** التحذيرات من المطابقات: [] بلا مطابقة — فالردّ بلا مفتاح warnings كما كان */
export function duplicateNameWarnings(matches: readonly NameMatch[]): DuplicateNameWarning[] {
  return matches.length ? [{ code: 'DUPLICATE_NAME', matches: [...matches] }] : [];
}

/**
 * تحذيرات الاستيراد (نقيّة): لكل صفٍّ سيُنشأ اسمُه يطابق صنفاً قائماً للشركة (قائماً أو موقوفاً أو مؤرشفاً) أو صفّاً قبله في الملف
 * بكودٍ آخر — والثاني مطابقته id = null ورقم صفّه. السقف `max` صفّاً.
 */
export function importDuplicateNameWarnings(
  creates: ReadonlyArray<{ row: number; r: { code: string; name: string } }>, existing: readonly ProductNameRow[], max = 200,
): DuplicateNameWarning[] {
  const byKey = new Map<string, NameMatch[]>();
  const add = (key: string, m: NameMatch) => {
    if (!key) return;
    const list = byKey.get(key) ?? [];
    if (list.length < NAME_MATCHES_MAX) list.push(m);
    byKey.set(key, list);
  };
  for (const p of existing) add(productNameKey(p.name), matchOf(p));
  const out: DuplicateNameWarning[] = [];
  for (const c of creates) {
    const key = productNameKey(c.r.name);
    const prior = (byKey.get(key) ?? []).filter((m) => m.code !== c.r.code);
    if (prior.length && out.length < max) out.push({ code: 'DUPLICATE_NAME', row: c.row, name: c.r.name, matches: prior });
    add(key, { id: null, code: c.r.code, name: c.r.name, status: 'ACTIVE', archived: false, row: c.row });
  }
  return out;
}
