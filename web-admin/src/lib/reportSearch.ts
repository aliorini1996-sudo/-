/**
 * تصفية تقارير الإدارة بالاسم — منطقٌ صرف، معزولٌ عن React ليُختبر وحده.
 *
 * ثلاث قواعد تحكم هذا الملف، وكلٌّ منها تمنع كذبةً مختلفة على المشرف:
 *
 * ١) **التصدير يتبع الشاشة.** مَن يبحث عن مندوبٍ ثم يضغط «تصدير» يتوقّع ملفَ
 *    بحثه؛ فإخراجُ الجميع فخٌّ صامت لأن الملف يبدو صحيحاً. لذلك تستهلك دوالُّ
 *    بناء الأوراق القوائمَ المُصفّاة نفسها لا الأصلية.
 *
 * ٢) **التقطيع يستلزم إعادة الحساب.** حين نُخفي بعض عملاء المندوب، لا يجوز أن
 *    يبقى إجماليّ مديونيته كما كان — وإلا قرأ المشرف إجماليَّ أربعين عميلاً
 *    فوق جدولٍ يعرض عميلاً واحداً، وهو رقمٌ صحيحٌ في غير موضعه = رقم كاذب.
 *
 * ٣) **ما لا يُعاد حسابه لا يُقطَّع.** مقاييس اليوم في تقرير الساعات (إجمالي
 *    وقت العمل = أول أثر ← آخر أثر) تصف اليوم لا الزيارات المعروضة، ولا يمكن
 *    اشتقاقها من مجموعةٍ جزئية. فالبحث هناك **يجد** المندوب ولا يقصّ يومه.
 */

/** تطبيع للمقارنة: تجاهل حالة الأحرف والفراغات الزائدة والتشكيل العربي */
export function norm(v: string | null | undefined): string {
  return (v || '')
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, '')      // التشكيل
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

/** هل يطابق أحدُ الحقول نصَّ البحث؟ (بحثٌ فارغ ⇒ يطابق الكلّ) */
export function matches(query: string, ...vals: (string | null | undefined)[]): boolean {
  const q = norm(query);
  if (!q) return true;
  return vals.some((v) => norm(v).includes(q));
}

export interface NamedRow { name: string }

/** صفوف مسطّحة: يكفي أن يطابق أحدُ حقولها */
export function filterFlat<T>(rows: T[], query: string, fields: (r: T) => (string | null | undefined)[]): T[] {
  if (!norm(query)) return rows;
  return rows.filter((r) => matches(query, ...fields(r)));
}

/** نوع الابن مُشتقّاً من الأب — كي يُستنتج من الوسيط الأول لا من دوالّ لاحقة */
type ChildOf<P> = P extends { customers: (infer C)[] } ? C : never;

/**
 * صفوف معشَّشة (مندوب ← عملاؤه): مطابقةُ اسم المندوب تُبقي عملاءه كلّهم،
 * ومطابقةُ عميلٍ تُبقي المطابقين وحدهم — ثم **يُعاد حساب** مجاميع الأب.
 */
export function filterNested<P extends { name: string; customers: unknown[] }>(
  parents: P[],
  query: string,
  childFields: (c: ChildOf<P>) => (string | null | undefined)[],
  recount: (parent: P, kept: ChildOf<P>[]) => P,
): P[] {
  if (!norm(query)) return parents;
  const out: P[] = [];
  for (const p of parents) {
    if (matches(query, p.name)) { out.push(p); continue; }
    const kept = (p.customers as ChildOf<P>[]).filter((c) => matches(query, ...childFields(c)));
    if (kept.length) out.push(recount(p, kept));
  }
  return out;
}
