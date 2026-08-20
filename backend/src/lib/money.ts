/**
 * التقريب النقدي الموحد للمنصة كلها — نصف-لأعلى دائما (half-up).
 *
 * لماذا لا يكفي Math.round(v*f)/f: التمثيل الثنائي يجعل 1.005×100 تساوي
 * 100.49999999999999 فتقرب لاسفل، بينما 2.005×100 تساوي 200.5 فتقرب لاعلى —
 * اتجاه انصاف الهللات كان تحدده ضوضاء الطفو لا قاعدة معلنة (572 حالة شاذة
 * من كل 10000 قيمة نصفية). العلاج: نقص غبار العائمة اولا باعادة التمثيل
 * العشري عبر toPrecision(12) — تكفي لتغطية مبالغ حتى مئات الملايين بدقة
 * الهللة — ثم نقرب نصف-لأعلى (بعيدا عن الصفر للسوالب) باتساق تام.
 *
 * ⚠️ لهذه الدالة نسخة متطابقة حرفيا في web-admin/src/lib/money.ts —
 * اي تعديل هنا يعدل هناك، والمتجهات الذهبية في money.test.ts تحرس الاثنتين.
 */
export function roundHalfUp(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return value;
  const f = Math.pow(10, decimals);
  const scaled = Number((value * f).toPrecision(12));
  const sign = scaled < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(scaled))) / f;
}

/**
 * توزيع مبلغ مقرب على اوزان بطريقة اكبر الباقي (largest remainder):
 * يضمن ان مجموع الحصص الموزعة = المبلغ المستهدف **بالضبط** بلا فقد ولا زيادة،
 * فلا يختفي خصم بند صغير ولا تنحرف الضريبة المجمعة عن نسبتها المعلنة.
 * الاوزان السالبة او الصفرية تاخذ صفرا، والمبلغ يفترض غير سالب.
 */
export function distributeAmount(target: number, weights: number[], decimals = 2): number[] {
  const f = Math.pow(10, decimals);
  const totalUnits = Math.round(roundHalfUp(Math.max(0, target), decimals) * f);
  const safe = weights.map(w => (Number.isFinite(w) && w > 0 ? w : 0));
  const sumW = safe.reduce((s, w) => s + w, 0);
  if (sumW <= 0 || totalUnits === 0) return weights.map(() => 0);

  const raw = safe.map(w => (w / sumW) * totalUnits);
  const floors = raw.map(Math.floor);
  let remainder = totalUnits - floors.reduce((s, v) => s + v, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    floors[order[k].i] += 1;
  }
  return floors.map(v => v / f);
}

/**
 * يرد سعرا **شاملا الضريبة** الى اساسه **الصافي قبل الضريبة**.
 *
 * لماذا يلزم: تطبيق المندوب يرسل السعر شاملا كما اعلن للعميل، بينما المراجع
 * المخزنة (Product.basePrice و CustomerPrice و PriceTier) كلها صافية — فاي
 * مقارنة صلاحية بينهما بلا هذا الرد ترفض مندوبا لم يمس السعر (1.15 مقابل 1.00).
 *
 * دقة الرد: المرسل مقرب لخانات العملة، فالخطأ الاقصى بعد القسمة اقل من نصف
 * اصغر وحدة عملة — واقل بكثير من هامش المقارنة 0.01 المستعمل في الحارس.
 */
export function netFromInclusive(price: number, taxPct: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(taxPct) || taxPct <= 0) return price;
  return price / (1 + taxPct / 100);
}
