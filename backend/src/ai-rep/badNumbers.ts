/**
 * المندوب الذكي — تصنيف مخالفات حارس الأرقام (للتعلّم من النفس): أي نوع من الأرقام اخترعه العقل في أول مسودة؟
 *   ARITH  رقم ناتج جمع/طرح/ضرب/قسمة رقمين مسموحين (حساب من عنده)
 *   MONEY  قيمة مالية · PCT نسبة · DIST_TIME مسافة أو زمن · QTY كمية بوحدة · OTHER غير ذلك
 * المسودة نفسها لا تُخزَّن — يُحفظ نوع المخالفة وحده.
 */
export type BadKind = 'ARITH' | 'MONEY' | 'PCT' | 'DIST_TIME' | 'QTY' | 'OTHER';

const MONEY_RE = /ريال|ر\.س|﷼|SAR|قيمه|قيمة/i;
const PCT_RE = /٪|%|نسبه|نسبة|بالمي/;
const DIST_RE = /(^|[^ء-ي])كم([^ء-ي]|$)|كيلو|متر|دقيقه|دقيقة|دقائق|ساعه|ساعة/;
const QTY_RE = /كرتون|كراتين|حبه|حبة|علبه|علبة|كيس|صندوق|درزن|شد|باكيت|قطعه|قطعة/;

const eqish = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** هل n ناتج عملية حسابية على قيمتين مسموحتين (≥٢) ليس أيّاً منهما؟ (n ≥ ١٠، والقائمة أول ٢٠٠ قيمة) */
function isArith(n: number, allowed: number[]): boolean {
  if (n < 10) return false;
  const vals = allowed.filter(v => v >= 2).slice(0, 200);
  if (vals.some(v => eqish(v, n))) return false;
  for (let i = 0; i < vals.length; i++) {
    for (let j = 0; j < vals.length; j++) {
      if (i === j) continue;
      const a = vals[i], b = vals[j];
      if (eqish(a + b, n) || eqish(Math.abs(a - b), n) || eqish(a * b, n) || (b !== 0 && eqish(Math.round(a / b), n))) return true;
    }
  }
  return false;
}

/**
 * أنواع المخالفات (بلا تكرار) من الأرقام غير المدعومة.
 * `view` = numericView(نص الرد) — يمرّره المستدعي (advisor.ts) تجنّباً لاعتماد دائري.
 */
export function categorizeBadNumbers(view: string, bad: number[], allowed: Set<number>): BadKind[] {
  const allowedList = [...allowed].slice(0, 200);
  const kinds = new Set<BadKind>();
  for (const n of bad) {
    if (isArith(n, allowedList)) { kinds.add('ARITH'); continue; }
    // نافذة ٢٥ محرفاً حول أول ظهور للرقم
    const needle = String(n);
    let at = -1;
    for (const m of view.matchAll(/\d+(?:\.\d+)?/g)) {
      if (Number(m[0]) === n) { at = m.index ?? -1; break; }
    }
    const win = at >= 0 ? view.slice(Math.max(0, at - 25), at + needle.length + 25) : view;
    if (MONEY_RE.test(win)) kinds.add('MONEY');
    else if (PCT_RE.test(win)) kinds.add('PCT');
    else if (DIST_RE.test(win)) kinds.add('DIST_TIME');
    else if (QTY_RE.test(win)) kinds.add('QTY');
    else kinds.add('OTHER');
  }
  return [...kinds];
}
