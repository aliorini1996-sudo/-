/**
 * حساب محرّك التكلفة بالأعداد الصحيحة وحدها («ربط الدفاتر» L3 — العقد scratchpad/l23_contract.md §3، §4.1).
 *
 * لماذا أعداد صحيحة: المحرّك القائم (warehouseCost.ts) يحسب بالطفو ثم يقرّب الرصيد في آخره، فتنجرف القيمة
 * بغبار الكسور وتحتاج عتبات EPS. هنا:
 *  - الكميات «ميكرو وحدة أساس» (×10⁶) أعداداً صحيحة — baseQtyOf يقرّب إلى ستّ منازل فالتحويل دقيق؛
 *  - المبالغ ملّي BigInt مضاعفةً دائماً لأصغر وحدة عملة؛
 *  - كل قسمة نسبية تُقرَّب مرة واحدة نصف-لأعلى بعيداً عن الصفر (كـtoMilli وroundMilli في ../gl/money).
 * فـΣ قيم الحركات = تقييم الموقع حرفياً بلا انجراف (الثابت 1 في §4.7).
 *
 * صرفٌ بلا prisma ولا ساعة ولا عشوائية (costing-static.test.ts).
 */

/** ميكرو وحدة أساس: الكمية × 10⁶ عدداً صحيحاً (ستّ منازل كـunits.roundQty) */
export const QTY_U = 1_000_000;

/** تكلفة الوحدة × 10⁴ (COST_DECIMALS في ../gl/money): |قيمة ملّي| × 10⁷ ÷ ميكرو كمية */
const E4_SCALE = 10_000_000n;

/**
 * كمية الأساس ⇐ ميكرو عدداً صحيحاً.
 * التقريب نصف-لأعلى **متناظر حول الصفر** (لا Math.round الخام الذي يقرّب −2.5 إلى −2): toQtyU(−x) = −toQtyU(x)
 * دائماً، فمرآة البيع |toQtyU(baseQty)| لا تتأثّر بإشارة اللقطة. والصفر السالب يُطبَّع (deepStrictEqual يميّزه).
 */
export function toQtyU(baseQty: number): number {
  if (typeof baseQty !== 'number' || !Number.isFinite(baseQty)) {
    throw new RangeError(`كمية غير منتهية: ${String(baseQty)}`);
  }
  const scaled = baseQty * QTY_U;
  const u = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  if (!Number.isSafeInteger(u)) throw new RangeError(`كمية خارج المدى الآمن: ${baseQty}`);
  return u === 0 ? 0 : u;
}

/** ميكرو ⇐ كمية أساس (القسمة مقرّبة صحيحاً فتطابق الرقم العشري ذا الستّ منازل حرفياً) */
export function fromQtyU(u: number): number {
  return u === 0 ? 0 : u / QTY_U;
}

function assertSafeInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} ليس عدداً صحيحاً آمناً: ${n}`);
}

/**
 * round_half_away_from_zero(value × num ÷ den) إلى أقرب مضاعف لـunit — بقسمة BigInt واحدة:
 * rDiv(value·num, den·unit)·unit. فالنتيجة مضاعف لأصغر وحدة عملة دائماً، والتقريب مرة واحدة لا مرتين.
 * num وden ميكرو كميات (أعداد صحيحة آمنة، den ≠ 0، وأيّ إشارة).
 */
export function mulDivRound(value: bigint, num: number, den: number, unit: bigint): bigint {
  assertSafeInt(num, 'البسط');
  assertSafeInt(den, 'المقام');
  if (den === 0) throw new RangeError('mulDivRound: مقام صفري');
  if (unit <= 0n) throw new RangeError(`mulDivRound: وحدة غير موجبة ${unit}`);
  let n = value * BigInt(num);
  let d = BigInt(den) * unit;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  if ((a % d) * 2n >= d) q += 1n;
  const out = q * unit;
  return neg ? -out : out;
}

/**
 * round_half_up(a × b ÷ c) لميكرو كميات غير سالبة (c > 0). الضرب بـBigInt: a·b يتجاوز 2⁵³ بسهولة
 * (10⁶ حبّة × 10⁶ = 10¹² ميكرو × 10¹² …) فيفقد الطفو آحاده بصمت.
 */
export function qtyMulDiv(a: number, b: number, c: number): number {
  assertSafeInt(a, 'a');
  assertSafeInt(b, 'b');
  assertSafeInt(c, 'c');
  if (a < 0 || b < 0 || c <= 0) throw new RangeError(`qtyMulDiv: مدخلات سالبة أو مقام صفري (${a}, ${b}, ${c})`);
  const p = BigInt(a) * BigInt(b);
  const cc = BigInt(c);
  const out = Number((p * 2n + cc) / (cc * 2n));
  assertSafeInt(out, 'qtyMulDiv');
  return out;
}

/**
 * تكلفة وحدة الأساس × 10⁴ = round_half_up(|G| × 10⁷ ÷ costedQtyU) — للعرض والتدقيق وحدهما (لا تدخل أي حساب).
 * كمية مقيَّمة صفرية ⇒ 0.
 */
export function unitCostE4Of(valueMilli: bigint, costedQtyU: number): bigint {
  assertSafeInt(costedQtyU, 'الكمية المقيَّمة');
  if (costedQtyU <= 0) return 0n;
  const g = valueMilli < 0n ? -valueMilli : valueMilli;
  const c = BigInt(costedQtyU);
  return (g * E4_SCALE * 2n + c) / (c * 2n);
}
