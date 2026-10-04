// توحيد الخلايا المكرّرة في أوراق التقارير: المندوب مرّةً لكل مندوب، والتاريخ وإجمالي اليوم مرّةً لكل يوم.
// تعمل على الصفوف الجاهزة للتصدير: تُبقي القيمة في أوّل صفّ من كل سلسلةٍ متتالية وتُفرغ ما تحته،
// وتُرجع مدى الدمج (للخلية المدمجة في Excel ولـrowspan في PDF) ومعه القيمة الأصلية.

export interface CellMerge {
  col: string;      // عنوان العمود كما في مفاتيح الصفّ
  from: number;     // أوّل صفّ بيانات (من الصفر، بلا صفّ العناوين)
  to: number;       // آخر صفّ (شاملاً)
  value: unknown;   // القيمة المعروضة في الخلية المدمجة
}

export interface MergeGroup {
  cols: string[];                 // الأعمدة التي تتوحّد معاً
  keyOf: (index: number) => string; // مفتاح السلسلة لكل صفّ (مثلاً: المندوب، أو المندوب+اليوم)
}

export function mergeRuns(
  rows: Record<string, unknown>[],
  groups: MergeGroup[],
): { rows: Record<string, unknown>[]; merges: CellMerge[] } {
  const out = rows.map(r => ({ ...r }));
  const merges: CellMerge[] = [];
  for (const g of groups) {
    let start = 0;
    for (let i = 1; i <= rows.length; i++) {
      if (i < rows.length && g.keyOf(i) === g.keyOf(start)) continue;
      const end = i - 1;
      if (end > start) {
        for (const col of g.cols) {
          merges.push({ col, from: start, to: end, value: rows[start][col] });
          for (let k = start + 1; k <= end; k++) out[k][col] = '';
        }
      }
      start = i;
    }
  }
  return { rows: out, merges };
}
